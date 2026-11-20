"""Getting chat replays (docs/CONTRACTS.md §37.3) with answers shaped like the real ones; never the network."""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import chatfetch, proc, sources
from clipfactory_agent.chat import RawChat
from clipfactory_agent.chatfetch import Response

FIX = Path(__file__).parent / "fixtures" / "chat"


def fixture(name: str) -> Any:
    return json.loads((FIX / name).read_text("utf-8"))


def ok(body: Any) -> Response:
    return Response(200, json.dumps(body).encode(), "application/json; charset=utf-8")


@pytest.fixture(autouse=True)
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "PER_SECOND", 10_000.0)

    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(chatfetch.asyncio, "sleep", no_sleep)
    for name in ("CF_CHAT", "CF_CHAT_TWITCH", "CF_CHAT_KICK", "CF_CHAT_YOUTUBE"):
        monkeypatch.delenv(name, raising=False)


class Fake:
    """A transport: answers in order (the last one repeats), and every request kept."""

    def __init__(self, *answers: Response) -> None:
        self.answers = list(answers)
        self.requests: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
        self.requests.append((method, url, headers, body))
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]

    def offsets(self) -> list[int]:
        return [json.loads(b or b"[]")[0]["variables"]["contentOffsetSeconds"] for _, _, _, b in self.requests]


def later(seconds: float = 60) -> float:
    return time.monotonic() + seconds


# --- where the chat comes from -----------------------------------------------------------------------------------


def test_source_meta_for_each_platform() -> None:
    assert chatfetch.source_meta(fixture("info_youtube.json"), "youtube") == {"platform": "youtube"}
    assert chatfetch.source_meta({"subtitles": {"en": []}}, "youtube") is None
    assert chatfetch.source_meta(fixture("info_twitch.json"), "twitch") == {
        "platform": "twitch",
        "videoId": "123456789",
    }
    assert chatfetch.source_meta({"id": "clip-slug"}, "twitch") is None  # a clip, not a VOD
    kick = chatfetch.source_meta(fixture("info_kick.json"), "kick")
    assert kick == {"platform": "kick", "channelId": "668", "start": 1793563200.0}
    assert chatfetch.source_meta({"channel_id": "668"}, "kick") is None
    assert chatfetch.source_meta({}, "upload") is None


def test_kill_switches(monkeypatch: pytest.MonkeyPatch) -> None:
    assert chatfetch.enabled("twitch") and chatfetch.enabled("kick")
    monkeypatch.setenv("CF_CHAT_TWITCH", "off")
    assert not chatfetch.enabled("twitch") and chatfetch.enabled("kick")
    monkeypatch.setenv("CF_CHAT", "OFF")
    assert not chatfetch.enabled("kick") and not chatfetch.enabled("screen")


async def test_a_switched_off_source_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CF_CHAT_TWITCH", "off")
    fake = Fake(ok(fixture("twitch_page_1.json")))
    assert await chatfetch.twitch("123", 600, transport=fake, deadline=later()) is None
    monkeypatch.setenv("CF_CHAT_KICK", "off")
    assert await chatfetch.kick("668", 1.0, 600, transport=fake, deadline=later()) is None
    assert fake.requests == []


# --- Twitch ------------------------------------------------------------------------------------------------------


async def test_twitch_walks_by_offset_and_drops_repeats(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    fake = Fake(ok(fixture("twitch_page_1.json")), ok(fixture("twitch_page_2.json")))
    counts: list[int] = []
    raw = await chatfetch.twitch("123456789", 600, transport=fake, deadline=later(), on_count=counts.append)
    assert raw is not None and raw.source == "twitch"
    assert fake.offsets() == [0, 7]  # the next page starts at the last second seen (its rest may follow)
    # page 1: 5 (one !command dropped) + page 2: the repeated message once, nightbot dropped
    assert raw.count == 5 and raw.covered == [[0.0, 600.0]]
    assert counts[-1] == 5
    method, url, headers, body = fake.requests[0]
    assert (method, url) == ("POST", chatfetch.TWITCH_GQL)
    assert headers["Client-Id"] == chatfetch.TWITCH_CLIENT_ID and "Cookie" not in headers
    assert "Authorization" not in headers and "Client-Integrity" not in headers
    assert json.loads(body or b"")[0]["operationName"] == "VideoCommentsByOffsetOrCursor"


async def test_twitch_walks_evenly_spaced_stretches_at_once() -> None:
    fake = Fake(ok(fixture("twitch_page_2.json")))  # every stretch: one page, no next page
    raw = await chatfetch.twitch("1", 800, transport=fake, deadline=later())
    assert raw is not None and sorted(fake.offsets()) == [0, 100, 200, 300, 400, 500, 600, 700]
    assert sorted(raw.covered) == [[i * 100.0, (i + 1) * 100.0] for i in range(8)]


async def test_the_request_cap_leaves_partial_coverage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    fake = Fake(ok(fixture("twitch_page_1.json")))  # always more pages
    raw = await chatfetch.twitch("1", 3600, transport=fake, deadline=later(), cap=3)
    assert raw is not None and len(fake.requests) == 3
    assert raw.covered == [[0.0, 7.0]]


async def test_the_deadline_stops_the_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    fake = Fake(ok(fixture("twitch_page_1.json")))
    assert await chatfetch.twitch("1", 3600, transport=fake, deadline=time.monotonic() - 1) is None
    assert fake.requests == []


async def test_429_backs_off_and_tries_again(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    busy = Response(429, b"", "application/json")
    fake = Fake(busy, busy, ok(fixture("twitch_page_2.json")))
    raw = await chatfetch.twitch("1", 600, transport=fake, deadline=later())
    assert raw is not None and len(fake.requests) == 3 and raw.count == 2


async def test_an_integrity_check_stops_every_request_for_good() -> None:
    fake = Fake(ok(fixture("twitch_integrity_error.json")))
    assert await chatfetch.twitch("1", 800, transport=fake, deadline=later()) is None
    assert len(fake.requests) <= chatfetch.IN_FLIGHT  # the ones already in flight, then nothing more


async def test_replay_off_or_an_html_page_is_no_chat() -> None:
    assert (
        await chatfetch.twitch("1", 600, transport=Fake(ok(fixture("twitch_replay_off.json"))), deadline=later())
        is None
    )
    html = Response(200, (FIX / "kick_cloudflare.html").read_bytes(), "text/html")
    assert await chatfetch.twitch("1", 600, transport=Fake(html), deadline=later()) is None


# --- Kick --------------------------------------------------------------------------------------------------------


async def test_kick_cloudflare_or_403_is_no_chat_after_one_request() -> None:
    html = Response(200, (FIX / "kick_cloudflare.html").read_bytes(), "text/html")
    for answer in (html, Response(403, b"Forbidden", "text/plain")):
        fake = Fake(answer)
        assert await chatfetch.kick("668", 1793563200.0, 600, transport=fake, deadline=later()) is None
        assert len(fake.requests) == 1


async def test_kick_messages_page() -> None:
    fake = Fake(ok(fixture("kick_messages.json")), ok({"data": {"messages": []}}))
    raw = await chatfetch.kick("668", 1793563200.0, 600, transport=fake, deadline=later())
    assert raw is not None and raw.source == "kick"
    assert raw.count == 2 and raw.collector.notices == [7.0]  # the celebration is a notice
    assert sorted(m.t for m in raw.collector.messages) == [5.0, 6.0]
    assert "start_time=2026-11-01T20%3A00%3A00.000Z" in fake.requests[0][1]
    assert raw.covered == [[0.0, 600]]


# --- YouTube -----------------------------------------------------------------------------------------------------


def test_youtube_lines_parse() -> None:
    raw = RawChat("youtube", [])
    last = chatfetch.read_youtube(FIX / "youtube_live_chat.jsonl", raw)
    assert last == 5.0
    texts = sorted(m.text for m in raw.collector.messages)
    assert texts == ["clip it", "first", "lmao", "💀"]  # "!discord" dropped, the membership is a notice
    assert raw.collector.notices == [4.1]


def test_a_stopped_download_keeps_what_it_wrote() -> None:
    raw = RawChat("youtube", [])
    assert chatfetch.read_youtube(FIX / "youtube_live_chat.part", raw) == 3.4
    assert raw.count == 3  # the half-written last line is skipped


def test_the_youtube_command_reuses_the_info_and_the_po_token(tmp_path: Path) -> None:
    info = tmp_path / "chat-info.json"
    info.write_text("{}")
    cmd = chatfetch.youtube_cmd("https://youtu.be/x", tmp_path, cookies=None, proxy=None, info_json=info)
    assert cmd[0] == "yt-dlp" and "--load-info-json" in cmd and "https://youtu.be/x" not in cmd
    assert cmd[cmd.index("--sub-langs") : cmd.index("--sub-langs") + 2] == ["--sub-langs", "live_chat"]
    assert "--skip-download" in cmd and "--write-subs" in cmd
    assert sources.YOUTUBE_CLIENTS in cmd and "--cookies" not in cmd
    saved = tmp_path / "cookies.txt"
    with_cookies = chatfetch.youtube_cmd("u", tmp_path, cookies=saved, proxy="http://p:1", info_json=None)
    assert with_cookies[-1] == "u" and with_cookies[with_cookies.index("--cookies") + 1] == str(saved)


async def test_youtube_timeout_parses_the_part_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    async def run(cmd: list[str], cookies: Any, **kw: Any) -> Any:
        seen.append(cmd)
        out = Path(cmd[cmd.index("-o") + 1]).parent
        shutil.copy(FIX / "youtube_live_chat.part", out / "chat.live_chat.json.part")
        assert kw["time_limit"] == 5
        raise TimeoutError

    monkeypatch.setattr(sources, "_run", run)
    raw = await chatfetch.youtube("u", tmp_path, 600, cookies=None, proxy=None, info_json=None, time_limit=5)
    assert raw is not None and raw.count == 3 and raw.covered == [[0.0, 3.4]]
    assert not list((tmp_path / "chat").glob("chat.*"))  # nothing is left on the disk


async def test_youtube_finished_covers_the_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def run(cmd: list[str], cookies: Any, **kw: Any) -> Any:
        out = Path(cmd[cmd.index("-o") + 1]).parent
        shutil.copy(FIX / "youtube_live_chat.jsonl", out / "chat.live_chat.json")
        return proc.Result(b"", "")

    monkeypatch.setattr(sources, "_run", run)
    raw = await chatfetch.youtube("u", tmp_path, 600, cookies=None, proxy=None, info_json=None)
    assert raw is not None and raw.count == 4 and raw.covered == [[0.0, 600]]


async def test_youtube_without_a_chat_track_is_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def run(cmd: list[str], cookies: Any, **kw: Any) -> Any:
        raise proc.CommandError("yt-dlp", 1, "There are no subtitles for the requested languages")

    monkeypatch.setattr(sources, "_run", run)
    assert await chatfetch.youtube("u", tmp_path, 600, cookies=None, proxy=None, info_json=None) is None


# --- the one call the pipeline makes ------------------------------------------------------------------------------


async def test_fetch_never_raises(tmp_path: Path) -> None:
    def broken(*a: Any) -> Response:
        raise OSError("network down")

    meta = {"platform": "twitch", "videoId": "1"}
    assert await chatfetch.fetch(meta, url="u", duration=600, workdir=tmp_path, time_limit=5, transport=broken) is None
    assert await chatfetch.fetch(None, url="u", duration=600, workdir=tmp_path, time_limit=5) is None


async def test_fetch_passes_a_cancel_on(tmp_path: Path) -> None:
    def slow(*a: Any) -> Response:
        time.sleep(0.2)
        return ok(fixture("twitch_page_1.json"))

    task = asyncio.create_task(
        chatfetch.fetch(
            {"platform": "twitch", "videoId": "1"},
            url="u",
            duration=600,
            workdir=tmp_path,
            time_limit=60,
            transport=slow,
        )
    )
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_no_message_text_or_name_is_ever_logged(capsys: pytest.CaptureFixture[str]) -> None:
    fake = Fake(ok(fixture("twitch_page_1.json")), ok(fixture("twitch_page_2.json")))
    await chatfetch.twitch("123456789", 600, transport=fake, deadline=later())
    await chatfetch.twitch("1", 600, transport=Fake(ok(fixture("twitch_integrity_error.json"))), deadline=later())
    out = capsys.readouterr().out
    assert out  # it did log
    for secret in ("KEKW", "OMEGALUL", "viewer", "hi chat", "LUL", chatfetch.TWITCH_CLIENT_ID):
        assert secret not in out


# --- review fixes: errors, paging, one back off, disk and size caps -----------------------------------------------


def page(*items: tuple[str, int], has_next: bool = True) -> Response:
    edges = [
        {
            "node": {
                "id": mid,
                "contentOffsetSeconds": t,
                "commenter": {"login": f"u{mid}"},
                "message": {"fragments": [{"text": f"hello {mid}"}]},
            }
        }
        for mid, t in items
    ]
    body = [{"data": {"video": {"comments": {"edges": edges, "pageInfo": {"hasNextPage": has_next}}}}}]
    return ok(body)


async def test_a_network_error_keeps_what_arrived_and_stops_the_rest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 2)
    calls: list[int] = []

    def flaky(method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
        offset = json.loads(body or b"[]")[0]["variables"]["contentOffsetSeconds"]
        calls.append(offset)
        if offset >= 300:
            raise OSError("timed out")
        return page((f"a{offset}", offset + 1), (f"b{offset}", offset + 2), has_next=False)

    raw = await chatfetch.twitch("1", 600, transport=flaky, deadline=later())
    assert raw is not None and raw.count == 2  # the first stretch's chat survives the second one's errors
    assert len(calls) <= 2 + chatfetch.BACKOFF_TRIES * 2


async def test_a_cancel_leaves_no_walk_running(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 4)
    calls: list[float] = []

    def slow(*a: Any) -> Response:
        calls.append(time.monotonic())
        time.sleep(0.05)
        return page(("m", 1))

    task = asyncio.create_task(chatfetch.twitch("1", 4000, transport=slow, deadline=later(), cap=10_000))
    await asyncio.sleep(0.2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    seen = len(calls)
    await asyncio.sleep(0.3)
    assert len(calls) <= seen + chatfetch.IN_FLIGHT  # only requests already out; no walk goes on asking


async def test_a_busy_second_is_asked_again_from_that_second(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    fake = Fake(
        page(("a", 5), ("b", 5), ("c", 5)),  # a full page ending inside second 5
        page(("b", 5), ("c", 5), ("d", 5), ("e", 6)),  # the rest of second 5 comes next
        page(("e", 6), has_next=False),
    )
    raw = await chatfetch.twitch("1", 600, transport=fake, deadline=later())
    assert raw is not None and raw.count == 5  # a to e, none twice
    assert fake.offsets()[:3] == [0, 5, 6]


async def test_a_page_that_adds_nothing_still_moves_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 1)
    same = page(("a", 0), ("b", 0))
    fake = Fake(same, same, same, page(("z", 3), has_next=False))
    raw = await chatfetch.twitch("1", 600, transport=fake, deadline=later(), cap=20)
    assert raw is not None and len(fake.requests) <= 6 and raw.count == 3


async def test_one_429_slows_every_walk_and_many_stop_them(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chatfetch, "SEGMENTS", 4)
    busy = Response(429, b"", "application/json")
    fake = Fake(busy)
    assert await chatfetch.twitch("1", 4000, transport=fake, deadline=later(), cap=10_000) is None
    assert len(fake.requests) <= chatfetch.THROTTLE_STOP + chatfetch.IN_FLIGHT  # not 4 segments x 4 tries x more


async def test_youtube_skips_when_the_disk_is_nearly_full(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ran: list[Any] = []

    async def run(*a: Any, **k: Any) -> None:
        ran.append(1)

    monkeypatch.setattr(sources, "_run", run)
    got = await chatfetch.youtube("u", tmp_path, 600, cookies=None, proxy=None, info_json=None, min_free=10**18)
    assert got is None and ran == []


async def test_youtube_reads_only_up_to_the_message_cap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def run(cmd: list[str], *a: Any, **k: Any) -> None:
        out = tmp_path / "chat"
        shutil.copy(FIX / "youtube_live_chat.jsonl", out / "chat.live_chat.json")

    monkeypatch.setattr(sources, "_run", run)
    raw = await chatfetch.youtube("u", tmp_path, 600, cookies=None, proxy=None, info_json=None, max_messages=3)
    assert raw is not None and 3 <= raw.count < 10
    assert raw.covered[0][1] < 600  # a capped read covers only up to where it stopped
