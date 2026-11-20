"""Getting a stream's chat replay (docs/CONTRACTS.md §37.3, docs/DECISIONS.md ADR-61), best effort and read only.

- YouTube: yt-dlp's ``live_chat`` track (``--write-subs --sub-langs live_chat``), with the info from resolve, the PO
  token, the owner's already saved cookies and the optional proxy, exactly like the sound download.
- Twitch: the web player's public comments query on gql.twitch.tv, paged by time offset only, at most IN_FLIGHT
  requests at once and PER_SECOND a second. An integrity check or any challenge stops it for good on this job: we
  never make or replay integrity tokens. Off with ``CF_CHAT_TWITCH=off``.
- Kick: one probe of the public messages endpoint. An HTML page, a 403 or a challenge means "no chat"; it is never
  retried or worked around. Off with ``CF_CHAT_KICK=off``.

``CF_CHAT=off`` turns all of them off (and the chat box reader, chatscreen). Nothing here ever fails a job: every
fetcher returns None or what it got so far. No message text, name, cookie or token is ever logged."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import proc, sources
from .chat import RawChat
from .util import JobCanceled, log

TWITCH_GQL = "https://gql.twitch.tv/gql"
TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"  # the public Client-ID of Twitch's own web player
TWITCH_QUERY = "VideoCommentsByOffsetOrCursor"
TWITCH_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a"
KICK_MESSAGES = "https://kick.com/api/v2/channels/{channel}/messages?start_time={start}"
MAX_REQUESTS = 3600  # 12 minutes at PER_SECOND
SEGMENTS = 8  # a long video is walked in this many evenly spaced stretches at once, so a cap leaves even gaps
IN_FLIGHT = 4
PER_SECOND = 5.0
REQUEST_TIMEOUT = 20.0
BACKOFF_TRIES = 4
BACKOFF_CAP = 30.0
YOUTUBE_TIME_LIMIT = 12 * 60
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
YOUTUBE_MAX_MESSAGES = 400_000  # a longer replay is read up to here, so memory and disk stay small
YOUTUBE_MIN_FREE = 1_500_000_000  # bytes of free disk the replay file may need; with less, no replay is fetched
THROTTLE_STOP = 8  # this many 429s / 5xx answers on one job stop the whole walk
COUNT_EVERY = 500  # the live line's count is updated about this often


def enabled(platform: str) -> bool:
    """The kill switches: ``CF_CHAT=off`` for every chat source, ``CF_CHAT_<PLATFORM>=off`` for one."""
    if os.environ.get("CF_CHAT", "on").strip().lower() == "off":
        return False
    return os.environ.get(f"CF_CHAT_{platform.upper()}", "on").strip().lower() != "off"


def source_meta(info: dict[str, Any], platform: str) -> dict[str, Any] | None:
    """Where this video's chat replay could come from (``meta.chatSource``), or None when it has none we can read."""
    try:
        if platform == "youtube":
            return {"platform": "youtube"} if "live_chat" in (info.get("subtitles") or {}) else None
        if platform == "twitch":
            vid = str(info.get("id") or "")
            if re.fullmatch(r"v\d+", vid):
                return {"platform": "twitch", "videoId": vid[1:]}
            return None
        if platform == "kick":
            channel, start = info.get("channel_id"), info.get("timestamp")
            if channel and start:
                return {"platform": "kick", "channelId": str(channel), "start": float(start)}
    except (TypeError, ValueError):
        return None
    return None


# --- HTTP, swappable in tests --------------------------------------------------------------------------------------


@dataclass
class Response:
    status: int
    body: bytes
    content_type: str = ""

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


Transport = Callable[[str, str, dict[str, str], bytes | None, float], Response]


def urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
    """One plain HTTPS request with no cookies (the default opener keeps none)."""
    if not url.startswith("https://"):
        raise ValueError("chat requests go to https hosts only")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)  # noqa: S310 (https only)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (fixed https hosts only)
            return Response(r.status, r.read(), r.headers.get("Content-Type", ""))
    except urllib.error.HTTPError as e:
        return Response(e.code, e.read() or b"", e.headers.get("Content-Type", "") if e.headers else "")


class Pacer:
    """At most ``in_flight`` requests at once and one start every 1/``per_second`` seconds, under a request cap and a
    deadline."""

    def __init__(self, *, cap: int, deadline: float, in_flight: int = IN_FLIGHT, per_second: float = PER_SECOND):
        self.cap = cap
        self.deadline = deadline  # time.monotonic() value
        self.sent = 0
        self._sem = asyncio.Semaphore(in_flight)
        self._gap = 1.0 / per_second
        self._next = 0.0
        self._lock = asyncio.Lock()

    @property
    def spent(self) -> bool:
        return self.sent >= self.cap or time.monotonic() >= self.deadline

    async def send(
        self, transport: Transport, method: str, url: str, headers: dict[str, str], body: bytes | None
    ) -> Response:
        async with self._sem:
            async with self._lock:
                wait = self._next - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                self._next = time.monotonic() + self._gap
                self.sent += 1
            return await asyncio.to_thread(transport, method, url, headers, body, REQUEST_TIMEOUT)


class Stop(Exception):
    """The source said no for good (integrity check, challenge, replay off): stop every request on this job."""


# --- Twitch --------------------------------------------------------------------------------------------------------


def _twitch_body(video_id: str, offset: float) -> bytes:
    return json.dumps(
        [
            {
                "operationName": TWITCH_QUERY,
                "variables": {"videoID": video_id, "contentOffsetSeconds": int(offset)},
                "extensions": {"persistedQuery": {"version": 1, "sha256Hash": TWITCH_HASH}},
            }
        ]
    ).encode()


def parse_twitch(page: Any) -> tuple[list[tuple[str, float, str, str]], bool]:
    """One answer of the comments query as ``([(id, seconds, login, text)], has_next)``. Raises Stop when Twitch
    asks for an integrity token, shows a challenge, or the video or its chat replay is gone."""
    first = page[0] if isinstance(page, list) and page else page
    if not isinstance(first, dict):
        raise Stop("not an answer")
    errors = first.get("errors") or []
    if errors:
        text = " ".join(str(e.get("message") if isinstance(e, dict) else e) for e in errors).lower()
        raise Stop("integrity" if "integrity" in text else "error")
    video = (first.get("data") or {}).get("video")
    if not isinstance(video, dict):
        raise Stop("no video")
    comments = video.get("comments")
    if not isinstance(comments, dict):
        raise Stop("replay off")
    out: list[tuple[str, float, str, str]] = []
    for edge in comments.get("edges") or []:
        node = (edge or {}).get("node") or {}
        try:
            t = float(node.get("contentOffsetSeconds"))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        frags = ((node.get("message") or {}).get("fragments")) or []
        text = "".join(str(f.get("text") or "") for f in frags if isinstance(f, dict))
        login = str((node.get("commenter") or {}).get("login") or "?")
        out.append((str(node.get("id") or f"{t}:{login}:{len(out)}"), t, login, text))
    has_next = bool((comments.get("pageInfo") or {}).get("hasNextPage"))
    return out, has_next


async def twitch(
    video_id: str,
    duration: float,
    *,
    transport: Transport = urllib_transport,
    deadline: float,
    cap: int = MAX_REQUESTS,
    on_count: Callable[[int], None] | None = None,
) -> RawChat | None:
    """The VOD's chat, walked by time offset in SEGMENTS stretches at once until the cap or the deadline."""
    if not enabled("twitch") or not video_id.isdigit() or duration <= 0:
        return None
    raw = RawChat("twitch", [])
    pacer = Pacer(cap=cap, deadline=deadline)
    headers = {"Client-Id": TWITCH_CLIENT_ID, "Content-Type": "application/json", "User-Agent": USER_AGENT}
    stopped: list[str] = []
    bounds = [duration * i / SEGMENTS for i in range(SEGMENTS + 1)]
    last_count = 0

    def counted() -> None:
        nonlocal last_count
        n = raw.count
        if on_count and n - last_count >= COUNT_EVERY:
            last_count = n
            on_count(n)

    slow = {"until": 0.0, "hits": 0}  # one back off for every segment: a 429 slows them all, enough of them stop all

    async def ask(offset: float) -> tuple[list[tuple[str, float, str, str]], bool] | None:
        for _ in range(BACKOFF_TRIES):
            if stopped or pacer.spent:
                return None
            pause = slow["until"] - time.monotonic()
            if pause > 0:
                await asyncio.sleep(min(BACKOFF_CAP, pause))
            try:
                r = await pacer.send(transport, "POST", TWITCH_GQL, headers, _twitch_body(video_id, offset))
            except (OSError, TimeoutError):  # a slow or dropped request: back off, keep what arrived
                r = Response(599, b"")
            if r.status == 429 or r.status >= 500:
                slow["hits"] += 1
                if slow["hits"] >= THROTTLE_STOP:
                    raise Stop("throttled")
                slow["until"] = max(slow["until"], time.monotonic() + min(BACKOFF_CAP, 2.0 ** min(slow["hits"], 5)))
                continue
            if r.status != 200 or "json" not in r.content_type.lower():
                raise Stop(f"status {r.status}")
            try:
                return parse_twitch(r.json())
            except ValueError as e:
                raise Stop("not json") from e
        return None

    async def walk(a: float, b: float) -> None:
        off, reached = a, a
        try:
            while off < b and not stopped:
                got = await ask(off)
                if got is None:
                    break
                page, has_next = got
                before = len(raw.collector.seen_ids)
                for mid, t, login, text in page:
                    raw.collector.add(t, login, text, msg_id=mid)
                fresh = len(raw.collector.seen_ids) - before
                counted()
                top = max((t for _, t, _, _ in page), default=None)
                if top is None or not has_next:
                    reached = b
                    break
                reached = max(reached, min(b, top))
                # Ask again from the page's last second (the rest of that second is on the next page; messages
                # already seen are skipped by id). Only a page that adds nothing new moves on by a second.
                if top > off:
                    off = top
                elif not fresh:
                    off += 1
        except Stop as e:
            stopped.append(str(e))
        except Exception as e:  # one bad segment never costs the others' messages
            log("warn", "chat.twitch_segment_failed", error=type(e).__name__)
        if reached > a:
            raw.covered.append([a, min(b, reached)])

    tasks = [asyncio.ensure_future(walk(bounds[i], bounds[i + 1])) for i in range(SEGMENTS)]
    try:
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:  # a cancel or anything else leaves no walk running after this call
        for t in tasks:
            t.cancel()
    if stopped:
        log("info", "chat.twitch_stopped", reason=stopped[0][:40], requests=pacer.sent, messages=raw.count)
    else:
        log("info", "chat.twitch_done", requests=pacer.sent, messages=raw.count)
    if on_count:
        on_count(raw.count)
    return raw if raw.covered else None


# --- Kick ----------------------------------------------------------------------------------------------------------


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _epoch(text: str) -> float | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_kick(body: Any) -> list[tuple[str, float, str, str, bool]]:
    """Kick's messages page as ``[(id, epoch seconds, username, text, is_system)]``; Stop when it is not one."""
    data = body.get("data") if isinstance(body, dict) else None
    messages = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(messages, list):
        raise Stop("not a messages page")
    out = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        at = _epoch(str(m.get("created_at") or ""))
        if at is None:
            continue
        name = str((m.get("sender") or {}).get("username") or "?")
        out.append(
            (str(m.get("id") or f"{at}:{name}"), at, name, str(m.get("content") or ""), m.get("type") != "message")
        )
    return out


async def kick(
    channel_id: str,
    start: float,
    duration: float,
    *,
    transport: Transport = urllib_transport,
    deadline: float,
    cap: int = MAX_REQUESTS,
    on_count: Callable[[int], None] | None = None,
) -> RawChat | None:
    """One probe; only when it answers with a real messages page does the walk go on (one request at a time)."""
    if not enabled("kick") or not channel_id.isdigit() or duration <= 0:
        return None
    raw = RawChat("kick", [])
    pacer = Pacer(cap=cap, deadline=deadline, in_flight=1)
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    at, reached = start, 0.0
    try:
        while at < start + duration and not pacer.spent:
            url = KICK_MESSAGES.format(channel=channel_id, start=urllib.parse.quote(_iso(at)))
            r = await pacer.send(transport, "GET", url, headers, None)
            if r.status != 200 or "json" not in r.content_type.lower():
                raise Stop(f"status {r.status}")
            try:
                page = parse_kick(r.json())
            except ValueError as e:
                raise Stop("not json") from e
            if not page:
                reached = duration
                break
            for mid, when, name, text, system in page:
                raw.collector.add(when - start, name, text, system=system, msg_id=mid)
            top = max(when for _, when, _, _, _ in page)
            reached = max(reached, min(duration, top - start))
            at = top + 1 if top >= at else at + 1
            if on_count:
                on_count(raw.count)
    except Stop as e:
        log("info", "chat.kick_stopped", reason=str(e)[:40], requests=pacer.sent, messages=raw.count)
    if reached > 0:
        raw.covered.append([0.0, reached])
    return raw if raw.covered and raw.count else None


# --- YouTube -------------------------------------------------------------------------------------------------------

_YT_NOTICES = (
    "liveChatMembershipItemRenderer",
    "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer",
    "liveChatSponsorshipsGiftRedemptionAnnouncementRenderer",
)


def _runs_text(runs: Any) -> str:
    out = []
    for r in runs or []:
        if not isinstance(r, dict):
            continue
        if "text" in r:
            out.append(str(r["text"]))
        elif isinstance(r.get("emoji"), dict):
            e = r["emoji"]
            shortcuts = e.get("shortcuts") or []
            eid = str(e.get("emojiId") or "")
            out.append(eid if eid and len(eid) <= 4 else str(shortcuts[0]) if shortcuts else "")
    return "".join(out)


def parse_youtube_line(line: str) -> list[tuple[str, float, str, str, bool]]:
    """One line of yt-dlp's ``live_chat.json`` as ``[(id, seconds, author, text, is_system)]``; a broken line (the
    last one of a stopped download) gives []."""
    try:
        obj = json.loads(line)
    except ValueError:
        return []
    replay = obj.get("replayChatItemAction") if isinstance(obj, dict) else None
    if not isinstance(replay, dict):
        return []
    try:
        t = int(replay.get("videoOffsetTimeMsec")) / 1000  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return []
    out = []
    for action in replay.get("actions") or []:
        item = ((action or {}).get("addChatItemAction") or {}).get("item") or {}
        text_r = item.get("liveChatTextMessageRenderer")
        if isinstance(text_r, dict):
            name = str(
                (text_r.get("authorName") or {}).get("simpleText") or text_r.get("authorExternalChannelId") or "?"
            )
            text = _runs_text((text_r.get("message") or {}).get("runs"))
            out.append((str(text_r.get("id") or f"{t}:{name}"), t, name, text, False))
            continue
        for kind in _YT_NOTICES:
            r = item.get(kind)
            if isinstance(r, dict):
                out.append((str(r.get("id") or f"{t}:{kind}"), t, "", "", True))
    return out


def read_youtube(path: Path, raw: RawChat, *, max_messages: int = YOUTUBE_MAX_MESSAGES) -> float:
    """Adds the messages in yt-dlp's file (finished or ``.part``) to ``raw``, up to ``max_messages`` in all; returns
    the last second seen."""
    last = 0.0
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if raw.count >= max_messages:
                break
            for mid, t, name, text, system in parse_youtube_line(line):
                raw.collector.add(t, name, text, system=system, msg_id=mid)
                last = max(last, t)
    return last


def youtube_cmd(
    url: str, out_dir: Path, *, cookies: Path | None, proxy: str | None, info_json: Path | None
) -> list[str]:
    cmd = [
        "yt-dlp",
        *sources._args("youtube", cookies, proxy),
        "--skip-download",
        "--write-subs",
        "--sub-langs",
        "live_chat",
        "-o",
        str(out_dir / "chat.%(ext)s"),
    ]
    if info_json is not None and info_json.is_file():
        return [*cmd, "--load-info-json", str(info_json)]
    return [*cmd, url]


async def youtube(
    url: str,
    workdir: Path,
    duration: float,
    *,
    cookies: Path | None,
    proxy: str | None,
    info_json: Path | None,
    time_limit: float = YOUTUBE_TIME_LIMIT,
    on_count: Callable[[int], None] | None = None,
    min_free: int = YOUTUBE_MIN_FREE,
    max_messages: int = YOUTUBE_MAX_MESSAGES,
) -> RawChat | None:
    """yt-dlp's live chat replay track. When it runs out of time, what it wrote so far (the ``.part`` file) still
    counts, up to the last second in it."""
    if not enabled("youtube") or duration <= 0:
        return None
    out_dir = workdir / "chat"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        if shutil.disk_usage(out_dir).free < min_free:  # the replay file can be hundreds of MB: never risk the disk
            log("info", "chat.youtube_skipped", reason="low disk")
            return None
    except OSError:
        pass
    finished = False
    try:
        await sources._run(
            youtube_cmd(url, out_dir, cookies=cookies, proxy=proxy, info_json=info_json),
            cookies,
            time_limit=time_limit,
        )
        finished = True
    except (TimeoutError, proc.CommandError) as e:
        log("info", "chat.youtube_partial", error=type(e).__name__)
    try:
        files = sorted(out_dir.glob("chat.live_chat.json*"))
        if not files:
            return None
        raw = RawChat("youtube", [])
        last = 0.0
        for f in files:
            last = max(last, read_youtube(f, raw, max_messages=max_messages))
        if not raw.count:
            return None
        whole = finished and raw.count < max_messages  # a capped read only covers up to where it stopped
        raw.covered.append([0.0, duration if whole else min(duration, last)])
        if on_count:
            on_count(raw.count)
        log("info", "chat.youtube_done", finished=finished, messages=raw.count)
        return raw
    finally:
        with contextlib.suppress(OSError):
            for f in out_dir.glob("chat.*"):
                f.unlink()


# --- one call for the pipeline -------------------------------------------------------------------------------------


async def fetch(
    meta: dict[str, Any] | None,
    *,
    url: str,
    duration: float,
    workdir: Path,
    cookies: Path | None = None,
    proxy: str | None = None,
    time_limit: float,
    on_count: Callable[[int], None] | None = None,
    transport: Transport = urllib_transport,
) -> RawChat | None:
    """The chat replay for ``meta`` (``source_meta``), or None. Never raises but for a cancel."""
    if not meta:
        return None
    platform = str(meta.get("platform") or "")
    deadline = time.monotonic() + time_limit
    try:
        if platform == "youtube":
            info = workdir / "chat-info.json"
            return await youtube(
                url,
                workdir,
                duration,
                cookies=cookies,
                proxy=proxy,
                info_json=info if info.is_file() else None,
                time_limit=time_limit,
                on_count=on_count,
            )
        if platform == "twitch":
            return await twitch(
                str(meta.get("videoId") or ""), duration, transport=transport, deadline=deadline, on_count=on_count
            )
        if platform == "kick":
            return await kick(
                str(meta.get("channelId") or ""),
                float(meta.get("start") or 0),
                duration,
                transport=transport,
                deadline=deadline,
                on_count=on_count,
            )
    except (JobCanceled, asyncio.CancelledError):
        raise
    except Exception as e:
        log("warn", "chat.fetch_failed", platform=platform, error=type(e).__name__)
    return None
