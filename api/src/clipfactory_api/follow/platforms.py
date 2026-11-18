"""The YouTube, Twitch and Kick calls of Follow creators (docs/CONTRACTS.md §24.3). Fixed hosts only.

Every request is built here from a fixed https host and an id that already matched its pattern (``parse.py``),
URL-encoded. Nothing pasted by the owner is ever fetched.

* Twitch: an app token (client credentials) from the owner's Twitch app keys; Helix ``users``, ``streams`` and
  EventSub ``stream.online``/``stream.offline`` webhook subscriptions.
* Kick: an app token from the owner's Kick app keys; ``channels``, ``users``, ``livestream.status.updated``
  subscriptions and Kick's public key for webhook signatures.
* YouTube: the public ``videos.xml`` feed (no quota, no keys), oEmbed for a video's channel, and with the optional
  "YouTube read key" (a separate Google Cloud project, never the upload app) ``channels`` and ``videos``.

App tokens live only in memory (per warm Lambda); the keys live only in Secrets Manager.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlencode

from ..clock import Clock, utcnow
from ..log import log
from ..oauth.secrets import Secrets
from ..platforms.base import HttpClient, HttpRequest, HttpResponse, NetworkError, urllib_client

Item = dict[str, Any]

TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"  # noqa: S105 - an address, not a password
TWITCH_API = "https://api.twitch.tv/helix"
KICK_TOKEN_URL = "https://id.kick.com/oauth/token"  # noqa: S105 - an address, not a password
KICK_API = "https://api.kick.com/public/v1"
YOUTUBE_API = "https://www.googleapis.com/youtube/v3"
YOUTUBE_SITE = "https://www.youtube.com"
TWITCH_BATCH = 100
KICK_BATCH = 50
YOUTUBE_BATCH = 50
TOKEN_MARGIN_SECONDS = 120
JSON_HEADERS = {"accept": "application/json"}
# The EU consent page would answer instead of the channel page without it [U: checked in the release gate].
YOUTUBE_PAGE_HEADERS = {"accept-language": "en", "cookie": "SOCS=CAI; CONSENT=YES+1"}

_CHANNEL_IN_PAGE = (
    re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"'),
    re.compile(r'"externalId":"(UC[\w-]{22})"'),
    re.compile(r'<meta itemprop="identifier" content="(UC[\w-]{22})"'),
)
_ENTRY = re.compile(r"<entry>(.*?)</entry>", re.S)
_FEED_AUTHOR = re.compile(r"<author>\s*<name>(.*?)</name>", re.S)


class KeysNeededError(Exception):
    """The owner has not pasted this platform's app keys yet."""


class KeysRejectedError(Exception):
    """The platform refused the app keys (wrong or deleted)."""


class PlatformDownError(Exception):
    """The platform did not answer usefully (network, 5xx, rate limit)."""


class NotFoundError(Exception):
    """No such creator."""


def secret_name(secrets: Secrets, platform: str) -> str:
    """``cf-prod/platforms/twitch/app``, ``…/kick/app``, ``…/youtube/readkey``, ``…/twitch/eventsub``."""
    return {
        "twitch": f"{secrets.prefix}twitch/app",
        "kick": f"{secrets.prefix}kick/app",
        "youtube-read": f"{secrets.prefix}youtube/readkey",
        "twitch-eventsub": f"{secrets.prefix}twitch/eventsub",
    }[platform]


@dataclass
class FollowEnv:
    """What the API routes, the hooks and the tick share. ``secrets`` None: no keys can be read (all "not set up")."""

    secrets: Secrets | None
    http: HttpClient = urllib_client
    hooks_url: str = ""
    clock: Clock = field(default=utcnow)
    now: Callable[[], float] = time.monotonic
    _tokens: dict[str, tuple[str, float]] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def keys(self, platform: str, *, fresh: bool = False) -> Item | None:
        """The saved keys of ``twitch``, ``kick`` or ``youtube-read``; None when not saved (or removed)."""
        if self.secrets is None:
            return None
        found = self.secrets.read(secret_name(self.secrets, platform), fresh=fresh)
        if not found or found.get("removed"):
            return None
        return found

    def eventsub_secret(self) -> str:
        if self.secrets is None:
            return ""
        found = self.secrets.read(secret_name(self.secrets, "twitch-eventsub")) or {}
        return str(found.get("secret") or "") if not found.get("removed") else ""

    def callback(self, platform: str) -> str:
        return f"{self.hooks_url.rstrip('/')}/hooks/{platform}" if self.hooks_url else ""

    def forget_token(self, platform: str) -> None:
        with self._lock:
            self._tokens.pop(platform, None)

    # --- HTTP ---------------------------------------------------------------------------------------------------------

    def call(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
    ) -> HttpResponse:
        try:
            return self.http(HttpRequest(method, url, dict(headers or {}), body))
        except NetworkError as e:
            raise PlatformDownError(str(e)) from e

    # --- app tokens (client credentials) ------------------------------------------------------------------------------

    def token(self, platform: str) -> tuple[str, str]:
        """(client id, app token) for ``twitch`` or ``kick``; cached until shortly before it expires."""
        keys = self.keys(platform)
        if keys is None:
            raise KeysNeededError(platform)
        client_id = str(keys.get("clientId") or "")
        with self._lock:
            hit = self._tokens.get(platform)
            if hit and hit[1] > self.now():
                return client_id, hit[0]
        url = TWITCH_TOKEN_URL if platform == "twitch" else KICK_TOKEN_URL
        form = urlencode(
            {
                "client_id": client_id,
                "client_secret": str(keys.get("clientSecret") or ""),
                "grant_type": "client_credentials",
            }
        ).encode()
        resp = self.call(
            "POST", url, headers={"content-type": "application/x-www-form-urlencoded", **JSON_HEADERS}, body=form
        )
        if resp.status in {400, 401, 403}:
            raise KeysRejectedError(platform)
        data = resp.json()
        if resp.status != 200 or not isinstance(data, dict) or not data.get("access_token"):
            raise PlatformDownError(f"{platform} token {resp.status}")
        lifetime = data.get("expires_in")
        seconds = float(lifetime) if isinstance(lifetime, int | float) and not isinstance(lifetime, bool) else 3600.0
        with self._lock:
            self._tokens[platform] = (str(data["access_token"]), self.now() + max(60.0, seconds - TOKEN_MARGIN_SECONDS))
        return client_id, str(data["access_token"])

    def api(self, platform: str, method: str, url: str, payload: Any = None) -> HttpResponse:
        """A Twitch Helix or Kick public API call with the app token; one retry with a new token after a 401."""
        for attempt in (1, 2):
            client_id, token = self.token(platform)
            headers = {"authorization": f"Bearer {token}", **JSON_HEADERS}
            if platform == "twitch":
                headers["client-id"] = client_id
            body = None
            if payload is not None:
                headers["content-type"] = "application/json"
                body = json.dumps(payload, separators=(",", ":")).encode()
            resp = self.call(method, url, headers=headers, body=body)
            if resp.status == 401 and attempt == 1:
                self.forget_token(platform)
                continue
            if resp.status == 401:
                raise KeysRejectedError(platform)
            if resp.status == 429 or resp.status >= 500:
                raise PlatformDownError(f"{platform} {resp.status}")
            return resp
        raise PlatformDownError(platform)  # unreachable


def _chunks(values: Iterable[str], size: int) -> list[list[str]]:
    items = list(dict.fromkeys(values))
    return [items[i : i + size] for i in range(0, len(items), size)]


def _data(resp: HttpResponse) -> list[Item]:
    body = resp.json()
    rows = body.get("data") if isinstance(body, dict) else None
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


# --- Twitch -----------------------------------------------------------------------------------------------------------


def twitch_users(env: FollowEnv, logins: Iterable[str]) -> dict[str, Item]:
    """login → ``{id, login, display_name, profile_image_url}``."""
    out: dict[str, Item] = {}
    for chunk in _chunks(logins, TWITCH_BATCH):
        resp = env.api("twitch", "GET", f"{TWITCH_API}/users?{urlencode([('login', x) for x in chunk])}")
        if resp.status != 200:
            raise PlatformDownError(f"twitch users {resp.status}")
        for row in _data(resp):
            out[str(row.get("login") or "").lower()] = row
    return out


def twitch_streams(env: FollowEnv, logins: Iterable[str]) -> dict[str, Item]:
    """login → the live stream (``id``, ``title``, ``viewer_count``, ``started_at``, ``type``); offline ones are absent."""
    out: dict[str, Item] = {}
    for chunk in _chunks(logins, TWITCH_BATCH):
        query = urlencode([("user_login", x) for x in chunk] + [("first", str(TWITCH_BATCH))])
        resp = env.api("twitch", "GET", f"{TWITCH_API}/streams?{query}")
        if resp.status != 200:
            raise PlatformDownError(f"twitch streams {resp.status}")
        for row in _data(resp):
            if row.get("type") == "live":
                out[str(row.get("user_login") or "").lower()] = row
    return out


def twitch_subscribe(env: FollowEnv, broadcaster_id: str, kind: str) -> str:
    """Creates a ``stream.online`` or ``stream.offline`` webhook subscription; its id ("" when it already existed)."""
    secret = env.eventsub_secret()
    callback = env.callback("twitch")
    if not secret or not callback:
        raise KeysNeededError("twitch")
    payload = {
        "type": kind,
        "version": "1",
        "condition": {"broadcaster_user_id": broadcaster_id},
        "transport": {"method": "webhook", "callback": callback, "secret": secret},
    }
    resp = env.api("twitch", "POST", f"{TWITCH_API}/eventsub/subscriptions", payload)
    if resp.status == 409:  # it already exists (an earlier run made it): find its id, so it is never leaked
        return twitch_existing(env, broadcaster_id, kind)
    rows = _data(resp)
    if resp.status not in {200, 202} or not rows:
        raise PlatformDownError(f"twitch subscribe {resp.status}")
    return str(rows[0].get("id") or "")


def twitch_existing(env: FollowEnv, broadcaster_id: str, kind: str) -> str:
    """The id of the app's existing ``kind`` subscription for one broadcaster ("" when Twitch lists none)."""
    query = urlencode([("type", kind), ("user_id", broadcaster_id)])
    resp = env.api("twitch", "GET", f"{TWITCH_API}/eventsub/subscriptions?{query}")
    if resp.status != 200:
        raise PlatformDownError(f"twitch subscriptions {resp.status}")
    for row in _data(resp):
        if row.get("type") == kind and twitch_broadcaster(row) == broadcaster_id:
            return str(row.get("id") or "")
    return ""


def twitch_broadcaster(subscription: Item) -> str:
    condition = subscription.get("condition")
    return str(condition.get("broadcaster_user_id") or "") if isinstance(condition, dict) else ""


def twitch_stream_subscriptions(env: FollowEnv) -> list[Item]:
    """The app's ``stream.online``/``stream.offline`` subscriptions to this app's callback (any status)."""
    callback = env.callback("twitch")
    out = []
    for row in twitch_subscriptions(env):
        raw = row.get("transport")
        transport: Item = raw if isinstance(raw, dict) else {}
        if row.get("type") in {"stream.online", "stream.offline"} and (
            not callback or transport.get("callback") in {None, callback}
        ):
            out.append(row)
    return out


def twitch_unsubscribe(env: FollowEnv, subscription_id: str) -> None:
    resp = env.api("twitch", "DELETE", f"{TWITCH_API}/eventsub/subscriptions?id={quote(subscription_id, safe='')}")
    if resp.status not in {204, 404}:
        raise PlatformDownError(f"twitch unsubscribe {resp.status}")


def twitch_subscriptions(env: FollowEnv) -> list[Item]:
    """The app's EventSub subscriptions (first 100 pages' worth is plenty for one owner)."""
    out: list[Item] = []
    cursor = ""
    for _ in range(10):
        url = f"{TWITCH_API}/eventsub/subscriptions" + (f"?after={quote(cursor, safe='')}" if cursor else "")
        resp = env.api("twitch", "GET", url)
        if resp.status != 200:
            raise PlatformDownError(f"twitch subscriptions {resp.status}")
        out.extend(_data(resp))
        body = resp.json()
        page = body.get("pagination") if isinstance(body, dict) else None
        cursor = str(page.get("cursor") or "") if isinstance(page, dict) else ""
        if not cursor:
            break
    return out


# --- Kick ---------------------------------------------------------------------------------------------------------------


def kick_channels(env: FollowEnv, slugs: Iterable[str]) -> dict[str, Item]:
    """slug → ``{broadcaster_user_id, slug, stream_title, stream: {is_live, viewer_count, start_time}}``."""
    out: dict[str, Item] = {}
    for chunk in _chunks(slugs, KICK_BATCH):
        resp = env.api("kick", "GET", f"{KICK_API}/channels?{urlencode([('slug', x) for x in chunk])}")
        if resp.status == 404:
            continue
        if resp.status != 200:
            raise PlatformDownError(f"kick channels {resp.status}")
        for row in _data(resp):
            out[str(row.get("slug") or "").lower()] = row
    return out


def kick_users(env: FollowEnv, ids: Iterable[str]) -> dict[str, Item]:
    """broadcaster id → ``{user_id, name, profile_picture}``."""
    out: dict[str, Item] = {}
    for chunk in _chunks(ids, KICK_BATCH):
        resp = env.api("kick", "GET", f"{KICK_API}/users?{urlencode([('id', x) for x in chunk])}")
        if resp.status != 200:
            continue  # names are nice to have: the slug is shown instead
        for row in _data(resp):
            out[str(row.get("user_id") or "")] = row
    return out


def kick_subscribe(env: FollowEnv, broadcaster_id: str) -> str:
    """Subscribes ``livestream.status.updated`` for one channel; the subscription id ("" when it already existed)."""
    payload = {
        "broadcaster_user_id": int(broadcaster_id),
        "events": [{"name": "livestream.status.updated", "version": 1}],
        "method": "webhook",
    }
    resp = env.api("kick", "POST", f"{KICK_API}/events/subscriptions", payload)
    if resp.status == 409:  # it already exists: find its id, so it is never leaked
        for row in kick_status_subscriptions(env):
            if str(row.get("broadcaster_user_id") or "") == str(broadcaster_id):
                return kick_subscription_id(row)
        return ""
    rows = _data(resp)
    if resp.status not in {200, 201} or not rows:
        raise PlatformDownError(f"kick subscribe {resp.status}")
    if rows[0].get("error"):
        raise PlatformDownError("kick subscribe refused")
    return str(rows[0].get("subscription_id") or "")


def kick_unsubscribe(env: FollowEnv, subscription_id: str) -> None:
    resp = env.api("kick", "DELETE", f"{KICK_API}/events/subscriptions?id={quote(subscription_id, safe='')}")
    if resp.status not in {200, 204, 404}:
        raise PlatformDownError(f"kick unsubscribe {resp.status}")


def kick_subscriptions(env: FollowEnv) -> list[Item]:
    resp = env.api("kick", "GET", f"{KICK_API}/events/subscriptions")
    if resp.status != 200:
        raise PlatformDownError(f"kick subscriptions {resp.status}")
    return _data(resp)


def kick_public_key(http: HttpClient) -> str:
    """Kick's webhook public key (PEM). No app token needed."""
    try:
        resp = http(HttpRequest("GET", f"{KICK_API}/public-key", dict(JSON_HEADERS)))
    except NetworkError as e:
        raise PlatformDownError(str(e)) from e
    body = resp.json()
    data = body.get("data") if isinstance(body, dict) else None
    key = data.get("public_key") if isinstance(data, dict) else None
    if resp.status != 200 or not isinstance(key, str):
        raise PlatformDownError(f"kick public key {resp.status}")
    return key


# --- YouTube ------------------------------------------------------------------------------------------------------------


def _unescape(text: str) -> str:
    return (
        text.replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
    )


def _tag(block: str, name: str) -> str:
    found = re.search(rf"<{name}>(.*?)</{name}>", block, re.S)
    return _unescape(found.group(1).strip()) if found else ""


def youtube_feed(env: FollowEnv, channel_id: str) -> tuple[str, list[Item]]:
    """(channel name, newest entries ``{videoId, title, published}``) from the public feed. No quota, no keys.

    Read with fixed regular expressions, not an XML parser: the feed is small and simple, and no entity expansion can
    run on it."""
    resp = env.call("GET", f"{YOUTUBE_SITE}/feeds/videos.xml?channel_id={quote(channel_id, safe='')}")
    if resp.status == 404:
        raise NotFoundError(channel_id)
    if resp.status != 200:
        raise PlatformDownError(f"youtube feed {resp.status}")
    text = resp.body.decode("utf-8", "replace")
    author = _FEED_AUTHOR.search(text)
    entries = []
    for block in _ENTRY.findall(text):
        video = _tag(block, "yt:videoId")
        if re.fullmatch(r"[\w-]{11}", video):
            entries.append({"videoId": video, "title": _tag(block, "title"), "published": _tag(block, "published")})
    return (_unescape(author.group(1).strip()) if author else ""), entries


def youtube_channel_of_video(env: FollowEnv, video_id: str) -> str:
    """The ``@handle`` or channel id of a video's channel, from oEmbed (no keys)."""
    watch = f"{YOUTUBE_SITE}/watch?v={video_id}"
    resp = env.call("GET", f"{YOUTUBE_SITE}/oembed?{urlencode({'format': 'json', 'url': watch})}", headers=JSON_HEADERS)
    if resp.status in {400, 401, 403, 404}:
        raise NotFoundError(video_id)
    data = resp.json()
    author = data.get("author_url") if resp.status == 200 and isinstance(data, dict) else None
    if not isinstance(author, str):
        raise PlatformDownError(f"youtube oembed {resp.status}")
    found = re.fullmatch(r"https://www\.youtube\.com/(?:(@[\w.\-]{3,30})|channel/(UC[\w-]{22}))/?", author)
    if not found:
        raise NotFoundError(video_id)
    return found.group(1) or found.group(2)


def youtube_channel_of_handle(env: FollowEnv, handle: str) -> Item:
    """``{id, title, avatar}`` for an ``@handle``: with the read key from the Data API (1 unit), else from the channel
    page on www.youtube.com (a fixed host and a handle that matched its pattern)."""
    key = env.keys("youtube-read")
    if key:
        found = _youtube_channels(env, str(key.get("apiKey") or ""), {"forHandle": handle})
        if not found:
            raise NotFoundError(handle)
        return found[0]
    resp = env.call("GET", f"{YOUTUBE_SITE}/{quote(handle, safe='@')}", headers=YOUTUBE_PAGE_HEADERS)
    if resp.status == 404:
        raise NotFoundError(handle)
    if resp.status != 200:
        raise PlatformDownError(f"youtube page {resp.status}")
    text = resp.body.decode("utf-8", "replace")
    for pattern in _CHANNEL_IN_PAGE:
        found_id = pattern.search(text)
        if found_id:
            return {"id": found_id.group(1), "title": "", "avatar": ""}
    raise NotFoundError(handle)


def youtube_channel(env: FollowEnv, channel_id: str) -> Item | None:
    """``{id, title, handle, avatar}`` with the read key, else None (the feed gives the name)."""
    key = env.keys("youtube-read")
    if not key:
        return None
    found = _youtube_channels(env, str(key.get("apiKey") or ""), {"id": channel_id})
    return found[0] if found else None


def _youtube_channels(env: FollowEnv, api_key: str, query: Mapping[str, str]) -> list[Item]:
    params = {"part": "snippet", **query, "key": api_key}
    resp = env.call("GET", f"{YOUTUBE_API}/channels?{urlencode(params)}", headers=JSON_HEADERS)
    if resp.status in {400, 403}:
        raise KeysRejectedError("youtube-read")
    if resp.status != 200:
        raise PlatformDownError(f"youtube channels {resp.status}")
    body = resp.json()
    items = body.get("items") if isinstance(body, dict) else None
    out = []
    for row in items if isinstance(items, list) else []:
        snippet = row.get("snippet") if isinstance(row, dict) else None
        if not isinstance(snippet, dict):
            continue
        found_thumbs = snippet.get("thumbnails")
        thumbs: Item = found_thumbs if isinstance(found_thumbs, dict) else {}
        avatar = ""
        for size in ("medium", "default", "high"):
            pic = thumbs.get(size)
            if isinstance(pic, dict) and isinstance(pic.get("url"), str):
                avatar = pic["url"]
                break
        out.append(
            {
                "id": str(row.get("id") or ""),
                "title": str(snippet.get("title") or ""),
                "handle": str(snippet.get("customUrl") or ""),
                "avatar": avatar,
            }
        )
    return out


def youtube_videos(env: FollowEnv, ids: Iterable[str]) -> tuple[dict[str, Item], int]:
    """(video id → ``{snippet, liveStreamingDetails, contentDetails}``, quota units used) with the read key."""
    key = env.keys("youtube-read")
    if not key:
        return {}, 0
    out: dict[str, Item] = {}
    units = 0
    for chunk in _chunks(ids, YOUTUBE_BATCH):
        params = {
            "part": "snippet,liveStreamingDetails,contentDetails",
            "id": ",".join(chunk),
            "key": str(key.get("apiKey") or ""),
        }
        resp = env.call("GET", f"{YOUTUBE_API}/videos?{urlencode(params)}", headers=JSON_HEADERS)
        units += 1
        if resp.status in {400, 403}:
            raise KeysRejectedError("youtube-read")
        if resp.status != 200:
            raise PlatformDownError(f"youtube videos {resp.status}")
        body = resp.json()
        rows = body.get("items") if isinstance(body, dict) else None
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("id"):
                out[str(row["id"])] = row
    return out, units


def iso_duration_seconds(value: Any) -> int | None:
    """``PT1H2M3S`` → 3723."""
    if not isinstance(value, str):
        return None
    found = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value)
    if not found or value in {"P", "PT"}:
        return None
    d, h, m, s = (int(g) if g else 0 for g in found.groups())
    return ((d * 24 + h) * 60 + m) * 60 + s


def log_platform_error(where: str, platform: str, error: Exception) -> None:
    log("warning", where, platform=platform, error=type(error).__name__)


def kick_subscription_id(subscription: Item) -> str:
    return str(subscription.get("id") or subscription.get("subscription_id") or "")


def kick_status_subscriptions(env: FollowEnv) -> list[Item]:
    """The app's ``livestream.status.updated`` subscriptions."""
    return [
        row
        for row in kick_subscriptions(env)
        if str(row.get("event") or row.get("name") or "livestream.status.updated") == "livestream.status.updated"
    ]
