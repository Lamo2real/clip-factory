"""Twitch EventSub and Kick webhooks for Follow creators (docs/CONTRACTS.md §24.4), run by ``cf-prod-hooks``.

Every delivery is checked before anything is written: a missing secret, a bad signature or an old timestamp is a 401
and nothing is stored. A good delivery is stored once as ``HOOK#{platform}`` / ``HOOK#{message id}`` (written only if
absent, 14-day ``ttl``) with ``done: false``, the live state changes at once (``model.apply_live``), and only then is
the marker rewritten with ``done: true``. A repeated delivery of a done message does nothing more; a retry of one
that failed half way (a throttle, a timeout) is handled again, so a lost "offline" never loses the stream-ended
notice. Every write after the marker is conditional or idempotent. The 5-minute tick stays the source of truth.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from .. import db
from ..clock import iso
from ..log import log
from ..platforms.base import HttpClient
from . import CREATOR_PK, HOOK_TTL, KICK_SLUG, TWITCH_LOGIN, plain, round_viewers, ttl
from . import platforms as pf
from .model import apply_live
from .signatures import PublicKeyError, kick_valid, load_public_key, parse_time, twitch_valid

KEY_REFETCH_SECONDS = 600
TWITCH_HEADERS = (
    "twitch-eventsub-message-id",
    "twitch-eventsub-message-type",
    "twitch-eventsub-message-timestamp",
    "twitch-eventsub-subscription-type",
)
KICK_HEADERS = ("kick-event-message-id", "kick-event-type", "kick-event-message-timestamp", "kick-event-version")


@dataclass
class Outcome:
    """What the hooks Lambda answers: ``text`` (the Twitch challenge) or a small JSON body."""

    status: int
    text: str | None = None
    body: dict[str, Any] | None = None
    note: str = ""


@dataclass
class KickKeys:
    """Kick's public key, cached per warm Lambda. A failed check refetches it at most once every 10 minutes, so bad
    signatures can never make us call Kick over and over."""

    http: HttpClient
    now: Callable[[], float] = time.monotonic
    _key: tuple[int, int] | None = None
    _fetched: float = field(default=-1e18)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def get(self, *, refetch: bool = False) -> tuple[int, int] | None:
        with self._lock:
            stale = self._key is None or refetch
            if stale and self.now() - self._fetched < KEY_REFETCH_SECONDS:
                return self._key
            if not stale:
                return self._key
            self._fetched = self.now()
        try:
            key = load_public_key(pf.kick_public_key(self.http))
        except (pf.PlatformDownError, PublicKeyError) as e:
            log("warning", "hooks.kick_key_failed", error=type(e).__name__)
            return self._key
        with self._lock:
            self._key = key
        return key


def _dedupe(
    store: db.Store,
    platform: Literal["twitch", "kick"],
    *,
    message_id: str,
    headers: Mapping[str, str],
    kept: tuple[str, ...],
    body: str,
    now: datetime,
) -> dict[str, Any] | None:
    """The new marker the first time this message id is seen, or again while an earlier try never finished; None
    for a message that was already handled. Pass the marker to ``_done`` once the change is applied."""
    marker: dict[str, Any] = {
        "pk": f"HOOK#{platform}",
        "sk": f"HOOK#{message_id[:128]}",
        "type": "hook",
        "platform": platform,
        "receivedAt": iso(now),
        "headers": {k: headers[k] for k in kept if k in headers},
        "body": body,
        "bodyEncoding": "text",
        "signature": "valid",
        "done": False,
        "ttl": ttl(now, HOOK_TTL),
    }
    try:
        store.put_when(marker, "attribute_not_exists(pk) OR #d = :no", names={"#d": "done"}, values={":no": False})
    except db.ConditionFailed:
        return None
    return marker


def _done(store: db.Store, marker: dict[str, Any], outcome: Outcome) -> Outcome:
    """Marks a delivery handled (PutItem only: the hooks role may not update or delete HOOK# items)."""
    store.put({**marker, "done": True})
    return outcome


def _obj(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _json(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body or b"{}")
    except (ValueError, UnicodeDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


# --- Twitch ----------------------------------------------------------------------------------------------------------------


def twitch(store: db.Store, env: pf.FollowEnv, headers: Mapping[str, str], body: bytes, now: datetime) -> Outcome:
    secret = env.eventsub_secret()
    message_id = headers.get("twitch-eventsub-message-id", "")
    timestamp = headers.get("twitch-eventsub-message-timestamp", "")
    signature = headers.get("twitch-eventsub-message-signature", "")
    if not secret or not twitch_valid(secret, message_id, timestamp, body, signature=signature, now=now):
        return Outcome(
            401,
            body={"error": {"code": "unauthorized", "message": "The signature does not match."}},
            note="bad_signature",
        )
    data = _json(body)
    kind = headers.get("twitch-eventsub-message-type", "")
    first = _dedupe(
        store,
        "twitch",
        message_id=message_id,
        headers=headers,
        kept=TWITCH_HEADERS,
        body=body.decode("utf-8", "replace"),
        now=now,
    )
    if kind == "webhook_callback_verification":
        challenge = data.get("challenge")
        if not isinstance(challenge, str) or not 0 < len(challenge) <= 512:
            return Outcome(400, body={"error": {"code": "bad_request", "message": "No challenge."}})
        return Outcome(200, text=challenge, note="verified")
    if first is None:
        return Outcome(200, body={"ok": True}, note="duplicate")
    return _done(store, first, _twitch_event(store, headers, data, kind, now))


def _twitch_event(
    store: db.Store, headers: Mapping[str, str], data: dict[str, Any], kind: str, now: datetime
) -> Outcome:
    sub = _obj(data.get("subscription"))
    if kind == "revocation":
        _mark_revoked(
            store,
            "twitch",
            str(_obj(sub.get("condition")).get("broadcaster_user_id") or ""),
            str(sub.get("status") or "revoked"),
            now,
        )
        return Outcome(200, body={"ok": True}, note="revoked")
    if kind != "notification":
        return Outcome(200, body={"ok": True}, note="ignored")
    event = _obj(data.get("event"))
    login = str(event.get("broadcaster_user_login") or "").lower()
    broadcaster = str(event.get("broadcaster_user_id") or "")
    if not TWITCH_LOGIN.match(login):
        return Outcome(200, body={"ok": True}, note="ignored")
    sub_type = str(sub.get("type") or headers.get("twitch-eventsub-subscription-type") or "")
    if sub_type == "stream.online":
        if event.get("type") != "live":
            return Outcome(200, body={"ok": True}, note="not_live")
        creator = store.get(CREATOR_PK, f"twitch#{login}") or {}
        started = parse_time(str(event.get("started_at") or ""))
        last_off = parse_time(str(creator.get("lastOfflineAt") or ""))
        if started and last_off and started < last_off:
            return Outcome(
                200, body={"ok": True}, note="late_online"
            )  # a late "online" for a stream that already ended
        live = {
            "isLive": True,
            "startedAt": str(event.get("started_at") or "") or None,
            "streamId": str(event.get("id") or "") or None,
            "checkedAt": iso(now),
        }
        apply_live(store, "twitch", login, live, now, source="webhook", broadcaster_id=broadcaster)
        return Outcome(200, body={"ok": True}, note="online")
    if sub_type == "stream.offline":
        apply_live(
            store,
            "twitch",
            login,
            {"isLive": False, "checkedAt": iso(now)},
            now,
            source="webhook",
            broadcaster_id=broadcaster,
        )
        return Outcome(200, body={"ok": True}, note="offline")
    return Outcome(200, body={"ok": True}, note="ignored")


# --- Kick ------------------------------------------------------------------------------------------------------------------


def kick(store: db.Store, kick_keys: KickKeys, headers: Mapping[str, str], body: bytes, now: datetime) -> Outcome:
    message_id = headers.get("kick-event-message-id", "")
    timestamp = headers.get("kick-event-message-timestamp", "")
    signature = headers.get("kick-event-signature", "")
    key = kick_keys.get()
    ok = key is not None and kick_valid(key, message_id, timestamp, body, signature=signature, now=now)
    if not ok and message_id and signature:
        fresh_key = kick_keys.get(refetch=True)  # Kick may have rotated its key (at most once per 10 minutes)
        ok = (
            fresh_key is not None
            and fresh_key != key
            and kick_valid(fresh_key, message_id, timestamp, body, signature=signature, now=now)
        )
    if not ok:
        return Outcome(
            401,
            body={"error": {"code": "unauthorized", "message": "The signature does not match."}},
            note="bad_signature",
        )
    marker = _dedupe(
        store,
        "kick",
        message_id=message_id,
        headers=headers,
        kept=KICK_HEADERS,
        body=body.decode("utf-8", "replace"),
        now=now,
    )
    if marker is None:
        return Outcome(200, body={"ok": True}, note="duplicate")
    return _done(store, marker, _kick_event(store, headers, body, now))


def _kick_event(store: db.Store, headers: Mapping[str, str], body: bytes, now: datetime) -> Outcome:
    if headers.get("kick-event-type") != "livestream.status.updated":
        return Outcome(200, body={"ok": True}, note="ignored")
    data = _json(body)
    broadcaster = _obj(data.get("broadcaster"))
    slug = str(broadcaster.get("channel_slug") or "").lower()
    if not KICK_SLUG.match(slug):
        return Outcome(200, body={"ok": True}, note="ignored")
    if data.get("is_live") is True:
        live = {
            "isLive": True,
            "title": plain(data.get("title")),
            "startedAt": str(data.get("started_at") or "") or None,
            "viewers": round_viewers(data.get("viewer_count")),
            "checkedAt": iso(now),
        }
    else:
        live = {"isLive": False, "checkedAt": iso(now)}
    apply_live(store, "kick", slug, live, now, source="webhook", broadcaster_id=str(broadcaster.get("user_id") or ""))
    return Outcome(200, body={"ok": True}, note="online" if live["isLive"] else "offline")


def _mark_revoked(store: db.Store, platform: str, broadcaster_id: str, status: str, now: datetime) -> None:
    """The tick re-subscribes revoked creators on its next run."""
    if not broadcaster_id:
        return
    for creator in store.query_all(CREATOR_PK, f"{platform}#"):
        if str(creator.get("broadcasterId") or "") == broadcaster_id:
            store.update(
                CREATOR_PK,
                str(creator["sk"]),
                {"subsStatus": "revoked", "subsNote": status[:40], "subsCheckedAt": iso(now)},
            )
