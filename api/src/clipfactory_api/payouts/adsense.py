"""AdSense for YouTube: "Allow payment reading" (docs/CONTRACTS.md §40.4, §40.6, §40.7).

A run, only while ``PAYCONN#adsense`` is ``connected``:

1. The token ``cf-prod/platforms/adsense/token`` (read fresh). When it is due, it is refreshed with the YouTube app keys
   (Google's refresh token doesn't rotate, so there is no lease) and written back put-only. Before refreshing, the
   secret's ``clientId`` must be the one in ``cf-prod/platforms/youtube/app``: another one, or Google's
   ``invalid_client`` / ``unauthorized_client``, → ``needs_reconnect`` ``keys_changed``; ``invalid_grant`` (revoked, or
   unused for 6 months) → ``token_dead``. Nothing is deleted.
2. ``accounts.list`` (1), then per account (at most 2) ``alerts.list?languageCode=en`` (1) and ``payments.list`` (1): at
   most 5 calls a run. One failed call fails the read: ``lastError`` is set and everything read before stays.
3. ``PAYSTATE#youtube`` (accounts and their state, holds, other alerts as plain text, the unpaid balance, the last sent
   payment, ``firstReadDone`` at the end of the first read) and one ``PAYOUT#youtube#{date}#{last 4}`` per
   ``youtube-yyyy-MM-dd`` payment, its amount as Google wrote it. A changed amount sets ``revisedAt``; a payment Google
   no longer lists is kept with ``state "gone"`` and ``goneAt``. ``unpaid`` and plain ``yyyy-MM-dd`` payments are
   AdSense website money and are ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from .. import db
from ..clock import iso, parse
from ..log import log
from ..oauth.providers import FORM, GOOGLE_TOKEN
from ..oauth.secrets import SecretMissing
from ..platforms.base import HttpRequest, HttpResponse, NetworkError
from . import (
    ADSENSE,
    CHECK_FAILED,
    GOOGLE_API_OFF,
    GOOGLE_DOWN,
    GOOGLE_NO_ACCOUNT,
    GOOGLE_REFUSED,
    MAX_OTHER_ALERTS,
    OUT_OF_TIME,
    YOUTUBE,
    PayoutDeps,
    grant_mark,
    load,
    mark_reconnect,
    newest_sent,
    payconn_sk,
    payout_prefix,
    paystate_sk,
    plain_text,
    set_error,
    start_read,
    write_state,
    youtube_payout_sk,
)

API = "https://adsense.googleapis.com/v2"
REFRESH_MARGIN = timedelta(minutes=5)
READ_ACCOUNTS = 2
KEEP_ACCOUNTS = 5
HOLD_TYPE = "payment-hold"
UNPAID = "youtube-unpaid"
SENT = re.compile(r"^youtube-(\d{4}-\d{2}-\d{2})$")
API_OFF = frozenset({"accessNotConfigured", "SERVICE_DISABLED"})
BUSY = frozenset({"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED"})
AMOUNT_MAX = 64


class Reconnect(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class Failed(Exception):
    def __init__(self, text: str) -> None:
        super().__init__(text)
        self.text = text


class Gone(Exception):
    """The token secret is gone: "Stop payment reading" happened meanwhile."""


class Unauthorized(Exception):
    pass


@dataclass
class Read:
    accounts: list[dict[str, Any]] = field(default_factory=list)  # every account listed (at most 5)
    read: set[str] = field(default_factory=set)  # the last 4 of each account whose payments were read
    sent: list[tuple[str, str, str]] = field(default_factory=list)  # (yyyy-mm-dd, last 4, Google's amount text)
    unpaid: str | None = None
    holds: list[dict[str, Any]] = field(default_factory=list)  # {type, severity, text}
    others: list[dict[str, Any]] = field(default_factory=list)


def last4(name: str) -> str:
    """``accounts/pub-1234567890123456`` → ``3456``: all an item or a screen ever keeps of a publisher id."""
    return re.sub(r"[^0-9A-Za-z]", "", name.rsplit("/", 1)[-1])[-4:]


# --- the token ------------------------------------------------------------------------------------------------


def _seconds(value: Any) -> int:
    try:
        return max(30, int(value))
    except (TypeError, ValueError):
        return 3600


def _refresh(deps: PayoutDeps, name: str, secret: dict[str, Any], now: datetime) -> str:
    app = deps.secrets.read(deps.secrets.name(YOUTUBE, "app"), fresh=True) or {}
    client_id, client_secret = str(app.get("clientId") or ""), str(app.get("clientSecret") or "")
    if not client_id or not client_secret or client_id != str(secret.get("clientId") or ""):
        raise Reconnect("keys_changed")
    refresh_token = str(secret.get("refreshToken") or "")
    if not refresh_token:
        raise Reconnect("token_dead")
    form = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    }
    try:
        resp = deps.http(HttpRequest("POST", GOOGLE_TOKEN, dict(FORM), urlencode(form).encode()))
    except NetworkError as e:
        raise Failed(GOOGLE_DOWN) from e
    found = resp.json()
    data: dict[str, Any] = found if isinstance(found, dict) else {}
    error = str(data.get("error") or "").lower()
    if resp.status in (408, 429) or resp.status >= 500:
        raise Failed(GOOGLE_DOWN)
    if error == "invalid_grant":
        raise Reconnect("token_dead")
    if error in {"invalid_client", "unauthorized_client"} or resp.status == 401:
        raise Reconnect("keys_changed")
    access = data.get("access_token")
    if resp.status != 200 or not isinstance(access, str) or not access:
        raise Failed(GOOGLE_REFUSED)
    fresh = {
        **secret,
        "accessToken": access,
        "expiresAt": iso(now + timedelta(seconds=_seconds(data.get("expires_in")))),
    }
    if isinstance(data.get("scope"), str) and data["scope"].strip():
        fresh["scope"] = data["scope"]
    try:
        deps.secrets.write(name, fresh, platform=ADSENSE, create=False)  # put-only: a stop is never undone
    except SecretMissing as e:
        raise Gone from e
    log("info", "payouts.adsense_refreshed")
    return access


def access_token(deps: PayoutDeps, now: datetime, *, force: bool = False) -> tuple[str, bool]:
    """``(access token, refreshed now)``."""
    name = deps.secrets.name(ADSENSE, "token")
    secret = deps.secrets.read(name, fresh=True)
    token = (secret or {}).get("accessToken")
    if secret is None or not isinstance(token, str) or not token:
        raise Gone
    expires = parse(secret.get("expiresAt"))
    if not force and expires is not None and expires > now + REFRESH_MARGIN:
        return token, False
    return _refresh(deps, name, secret, now), True


# --- reading --------------------------------------------------------------------------------------------------


def _reasons(resp: HttpResponse) -> set[str]:
    found = resp.json()
    error = found.get("error") if isinstance(found, dict) else None
    if not isinstance(error, dict):
        return set()
    out = {str(error.get("status") or "")}
    for part in [*(error.get("errors") or []), *(error.get("details") or [])]:
        if isinstance(part, dict) and part.get("reason"):
            out.add(str(part["reason"]))
    return out


def _get(deps: PayoutDeps, url: str, token: str) -> dict[str, Any]:
    if deps.remaining() <= 0:
        raise Failed(OUT_OF_TIME)  # the money run's time budget is used up: never start another call
    try:
        resp = deps.http(HttpRequest("GET", url, {"Authorization": f"Bearer {token}", "Accept": "application/json"}))
    except NetworkError as e:
        raise Failed(GOOGLE_DOWN) from e
    if resp.status == 200:
        found = resp.json()
        return found if isinstance(found, dict) else {}
    if resp.status == 401:
        raise Unauthorized
    reasons = _reasons(resp)
    if resp.status == 403 and reasons & API_OFF:
        raise Failed(GOOGLE_API_OFF)
    if resp.status in (408, 429) or resp.status >= 500 or reasons & BUSY:
        raise Failed(GOOGLE_DOWN)
    if resp.status == 403:
        raise Failed(GOOGLE_REFUSED)
    raise Failed(GOOGLE_DOWN)


def _account(raw: dict[str, Any]) -> dict[str, Any]:
    pending = [plain_text(t, 100) for t in raw.get("pendingTasks") or [] if isinstance(t, str)][:10]
    return {
        "name": str(raw.get("name") or ""),
        "displayName": plain_text(raw.get("displayName"), 100),
        "state": str(raw.get("state") or "STATE_UNSPECIFIED"),
        "pendingTasks": pending,
    }


def _alerts(read: Read, data: dict[str, Any]) -> None:
    for alert in data.get("alerts") or []:
        if not isinstance(alert, dict):
            continue
        kind = str(alert.get("type") or "")
        entry = {"type": kind, "severity": str(alert.get("severity") or ""), "text": plain_text(alert.get("message"))}
        if kind.lower().replace("_", "-") == HOLD_TYPE:
            read.holds.append({**entry, "type": HOLD_TYPE})
        elif len(read.others) < MAX_OTHER_ALERTS:
            read.others.append(entry)


def _payments(read: Read, account: str, data: dict[str, Any]) -> None:
    for payment in data.get("payments") or []:
        if not isinstance(payment, dict):
            continue
        pid = str(payment.get("name") or "").rsplit("/", 1)[-1]
        text = str(payment.get("amount") or "").strip()[:AMOUNT_MAX]
        if pid == UNPAID:
            if read.unpaid is None and text:
                read.unpaid = text
            continue
        found = SENT.match(pid)
        if not found:
            continue  # "unpaid" and "yyyy-MM-dd": AdSense website money, never YouTube's
        try:
            day = date.fromisoformat(found.group(1)).isoformat()
        except ValueError:
            continue
        read.sent.append((day, account, text))


def _read(deps: PayoutDeps, token: str) -> Read:
    listed = list(_get(deps, f"{API}/accounts?pageSize={KEEP_ACCOUNTS}", token).get("accounts") or [])
    accounts = [_account(a) for a in listed if isinstance(a, dict) and a.get("name")][:KEEP_ACCOUNTS]
    if not accounts:
        raise Failed(GOOGLE_NO_ACCOUNT)
    read = Read(accounts=accounts)
    # The open accounts first: at most 2 are read (5 calls a run, well inside 100 a minute and 10,000 a day).
    for account in sorted(accounts, key=lambda a: (a["state"] == "CLOSED", a["name"]))[:READ_ACCOUNTS]:
        _alerts(read, _get(deps, f"{API}/{account['name']}/alerts?languageCode=en", token))
        _payments(read, last4(account["name"]), _get(deps, f"{API}/{account['name']}/payments", token))
        read.read.add(last4(account["name"]))
    return read


def _read_all(deps: PayoutDeps, now: datetime) -> Read:
    token, refreshed = access_token(deps, now)
    try:
        return _read(deps, token)
    except Unauthorized as e:
        if refreshed:
            raise Failed(GOOGLE_REFUSED) from e
    # A token Google refused before it was due (revoked, or another app key): refresh once, then read again.
    token, _ = access_token(deps, now, force=True)
    try:
        return _read(deps, token)
    except Unauthorized as e:
        raise Failed(GOOGLE_REFUSED) from e


# --- writing --------------------------------------------------------------------------------------------------


def _row(
    store: db.Store, pk: str, sent: tuple[str, str, str], old: dict[str, Any] | None, now: datetime
) -> dict[str, Any]:
    day, account, text = sent
    sk = youtube_payout_sk(day, account)
    if old is None:
        item = {
            "pk": pk,
            "sk": sk,
            "type": "payout",
            "place": YOUTUBE,
            "by": "google",
            "source": "adsense.payments",
            "account": account,
            "date": day,
            "amountText": text,
            "state": "sent",
            "fetchedAt": iso(now),
        }
        try:
            store.put(item, if_absent=True)
            return item
        except db.ConditionFailed:
            old = store.get(pk, sk) or item  # another run wrote it a moment ago
    changes: dict[str, Any] = {}
    remove: list[str] = []
    if old.get("amountText") != text:
        changes |= {"amountText": text, "revisedAt": iso(now)}  # the new amount counts
    if old.get("state") != "sent":
        changes["state"] = "sent"
        remove.append("goneAt")
    if not changes:
        return old
    changes["fetchedAt"] = iso(now)
    return store.update(pk, sk, changes, remove=remove)


def _hold_fields(holds: list[dict[str, Any]], state: dict[str, Any], now: datetime) -> tuple[list[Any], str | None]:
    before = [h for h in state.get("holds") or [] if isinstance(h, dict)]
    since: dict[str, str] = {}
    for h in before:
        kind, at = str(h.get("type")), str(h.get("since") or "")
        if at and (kind not in since or at < since[kind]):
            since[kind] = at
    out = [{**h, "since": since.get(h["type"], iso(now))} for h in holds]
    if not out:
        return [], None
    held = state.get("holdSince") if before else None
    return out, str(held) if held else min(h["since"] for h in out)


def _write(deps: PayoutDeps, user_id: str, *, now: datetime, state: dict[str, Any], read: Read, mark: str) -> None:
    pk = db.user_pk(user_id)
    rows = {str(r["sk"]): r for r in deps.store.query_all(pk, payout_prefix(YOUTUBE))}
    seen: set[str] = set()
    for sent in read.sent:
        sk = youtube_payout_sk(sent[0], sent[1])
        if sk not in seen:
            seen.add(sk)
            rows[sk] = _row(deps.store, pk, sent, rows.get(sk), now)
    for sk, row in list(rows.items()):
        if sk not in seen and row.get("state") == "sent" and row.get("account") in read.read:
            rows[sk] = deps.store.update(pk, sk, {"state": "gone", "goneAt": iso(now)})
    last = newest_sent(rows.values())
    holds, hold_since = _hold_fields(read.holds, state, now)
    fields: dict[str, Any] = {
        "type": "paystate",
        "place": YOUTUBE,
        "source": ADSENSE,
        "accounts": read.accounts,
        "holds": holds,
        "alerts": read.others,
        "unpaid": {"text": read.unpaid} if read.unpaid else None,
        "lastSent": {"sk": last["sk"], "date": last.get("date"), "text": last.get("amountText") or ""}
        if last
        else None,
        "holdSince": hold_since,
        "grantMark": mark,
        "lastCheckedAt": iso(now),
        "firstReadDone": True,  # last: the first read after a grant ends here, quietly
    }
    write_state(deps.store, user_id, YOUTUBE, fields, remove=["lastError"])
    log("info", "payouts.adsense_read", accounts=len(read.accounts), sent=len(read.sent), holds=len(holds))


def run(deps: PayoutDeps, user_id: str, now: datetime) -> str:
    """Reads AdSense for YouTube once; returns what happened (``not_connected``, ``read``, ``error``,
    ``token_dead``, ``keys_changed``)."""
    conn = load(deps.store, user_id, payconn_sk(ADSENSE))
    if conn.get("status") != "connected":
        return "not_connected"
    mark = grant_mark(conn)
    try:
        state = start_read(deps.store, user_id, ADSENSE, load(deps.store, user_id, paystate_sk(YOUTUBE)), mark)
        read = _read_all(deps, now)
        _write(deps, user_id, now=now, state=state, read=read, mark=mark)
    except Reconnect as e:
        mark_reconnect(deps.store, user_id, ADSENSE, e.reason, now)
        return e.reason
    except Gone:
        log("info", "payouts.adsense_stopped")
        return "not_connected"
    except Failed as e:
        log("warning", "payouts.adsense_failed", error=e.text)
        set_error(deps.store, user_id, ADSENSE, e.text)
        return "error"
    except Exception as e:  # a bug: say so on the state, and let the run go on
        log("error", "payouts.adsense_crashed", error=type(e).__name__)
        set_error(deps.store, user_id, ADSENSE, CHECK_FAILED)
        return "error"
    return "read"
