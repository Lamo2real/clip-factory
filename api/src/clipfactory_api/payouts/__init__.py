"""Get paid: what ``cf-prod-money`` reads about payouts (docs/CONTRACTS.md §40.4, §40.6, §40.7; ADR-64).

Two optional, read-only connections, each its own source, each read on its own (one failing never stops the other or
the money run):

* ``adsense``: "Allow payment reading" (``PAYCONN#adsense``, token ``cf-prod/platforms/adsense/token``). AdSense
  Management API v2: the account state, holds (alerts of type ``payment-hold``) and every payment Google sent.
* ``whop``: "Connect Whop" (``PAYCONN#whop``, token ``cf-prod/platforms/whop/token``, rotating, under a lease). Whop's
  API: the ID check, saved payout methods and the payouts Whop sent (all his Whop money, Content Rewards too).

The grants (``PAYCONN#`` connected, the token secrets) are made by the API and the callback (``getpaid/grants.py``);
this package only reads, refreshes, and writes what it read:

* ``PAYSTATE#youtube`` / ``PAYSTATE#contentrewards``: the read state (one UpdateItem a run, two for a new grant's
  first read; ``lastError`` on a failed read keeps everything else, so nothing on screen goes away because a platform
  was slow).
* ``PAYOUT#youtube#{yyyy-mm-dd}#{last 4 of the publisher id}`` (each payment Google sent) and
  ``PAYOUT#contentrewards#{yyyy-mm-dd}#{payoutId}`` (each Whop payout, in any state): a conditional PutItem when new,
  an UpdateItem only when it changed.

Nothing here deletes an item (the money role has no DeleteItem), converts or adds up money, or logs a token. Amounts
are kept as the platform wrote them (Google's own text; Whop's decimals as micros). Before the API builder's part has
merged there is no ``PAYCONN#`` item, and the collector does nothing.
"""

from __future__ import annotations

import html
import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .. import db
from ..clock import Clock, iso, utcnow
from ..log import log
from ..oauth.secrets import Secrets
from ..platforms.base import HttpClient

ADSENSE = "adsense"
WHOP = "whop"
YOUTUBE = "youtube"
CONTENT_REWARDS = "contentrewards"
# Which place each source's state and rows belong to.
PLACE = {ADSENSE: YOUTUBE, WHOP: CONTENT_REWARDS}

# §40.7: skipped when less than 20 s of the money run's time budget is left (a rotating refresh needs that much).
MIN_SECONDS_LEFT = 20.0
TEXT_MAX = 300
MAX_OTHER_ALERTS = 10

# Plain sentences for ``lastError`` (shown by the API as "Clip Factory couldn't check …", never a number).
GOOGLE_DOWN = "Google didn't answer. Clip Factory tries again tomorrow."
GOOGLE_API_OFF = "AdSense reading is off in Google Cloud. Tap Turn on AdSense reading, then Enable."
GOOGLE_NO_ACCOUNT = "Google shows no AdSense for YouTube for that Google account. Tap Allow payment reading again."
GOOGLE_REFUSED = "Google didn't let Clip Factory read payments. Tap Allow payment reading again."
GOOGLE_TOO_MANY = "You have more than 2 AdSense accounts open. Clip Factory can read only 2."
WHOP_DOWN = "Whop didn't answer. Clip Factory tries again tomorrow."
WHOP_REFUSED = "Whop didn't let Clip Factory read your payouts. Clip Factory tries again tomorrow."
CHECK_FAILED = "Clip Factory couldn't check this time. It tries again tomorrow."
OUT_OF_TIME = "Clip Factory ran out of time for this check. It tries again tomorrow."

# The attributes of each item kind, word for word from §40.7 (the tests compare them with the API builder's golden
# items when that file is present). ``grantMark`` is internal, like ``payoutsMark``: which grant the read belongs to.
PAYSTATE_YOUTUBE_ATTRS = frozenset(
    {
        "type",
        "place",
        "source",
        "accounts",
        "holds",
        "alerts",
        "unpaid",
        "lastSent",
        "holdSince",
        "firstReadDone",
        "lastCheckedAt",
        "lastError",
        "grantMark",
    }
)
PAYSTATE_WHOP_ATTRS = frozenset(
    {
        "type",
        "place",
        "source",
        "kyc",
        "methods",
        "lastPaidOutAt",
        "businesses",
        "hold",
        "lastSent",
        "payoutsMark",
        "firstReadDone",
        "lastCheckedAt",
        "lastError",
        "grantMark",
    }
)
PAYOUT_YOUTUBE_ATTRS = frozenset(
    {"type", "place", "by", "source", "account", "date", "amountText", "state", "fetchedAt", "revisedAt", "goneAt"}
)
PAYOUT_WHOP_ATTRS = frozenset(
    {
        "type",
        "place",
        "by",
        "source",
        "payoutId",
        "status",
        "state",
        "date",
        "amountMicros",
        "currency",
        "estimatedArrival",
        "traceCode",
        "fetchedAt",
        "updatedAt",
    }
)
INTERNAL = frozenset({"grantMark", "payoutsMark", "traceCode"})

# Whop's payout status → the row's state (§40.4). Only ``sent`` counts toward "Sent to your bank".
WHOP_STATES = {
    "completed": "sent",
    "requested": "on_its_way",
    "in_review": "on_its_way",
    "processing": "on_its_way",
    "failed": "didnt_go_through",
    "canceled": "didnt_go_through",
    "denied": "didnt_go_through",
    "reversed": "came_back",
}
KYC = frozenset({"not_started", "pending", "approved", "rejected"})
# PAYSTATE#contentrewards.hold.kind: the ID check didn't pass, every saved method is broken, or the last payout didn't
# go through (§40.2 "Hold"). A canceled payout is often his own and is never a hold.
HOLD_KINDS = ("id_rejected", "bank_broken", "payout_failed")


@dataclass
class PayoutDeps:
    """What the two sources need: the table, the platform secrets (``cf-prod/platforms/*``), HTTP, the clock, and
    how many seconds of the money run's time budget are left (a rotating refresh needs at least 20)."""

    store: db.Store
    secrets: Secrets
    http: HttpClient
    clock: Clock = utcnow
    sleep: Callable[[float], None] = time.sleep
    remaining: Callable[[], float] = field(default=lambda: 900.0)


def payconn_sk(source: str) -> str:
    return f"PAYCONN#{source}"


def paystate_sk(place: str) -> str:
    return f"PAYSTATE#{place}"


def payout_prefix(place: str) -> str:
    return f"PAYOUT#{place}#"


def youtube_payout_sk(day: str, account: str) -> str:
    return f"{payout_prefix(YOUTUBE)}{day}#{account}"


def whop_payout_sk(day: str, payout_id: str) -> str:
    return f"{payout_prefix(CONTENT_REWARDS)}{day}#{payout_id}"


def grant_mark(conn: Mapping[str, Any], source: str) -> str:
    """Which grant a read belongs to: a new value means a new grant, whose first read fills the old payments quietly
    (§40.7). The collector's own writes (a refresh, the lease) never change it.

    * ``grantedAt`` when ``PAYCONN#`` has it (written by a successful grant only).
    * Whop: ``connectedAt``. Every "Connect Whop" writes it anew, and a stop or a key change removes it. ``updatedAt``
      also moves when the same key is saved again, so it is not part of the mark.
    * AdSense: ``connectedAt`` (a second Allow keeps the first one) and ``updatedAt`` (only an Allow, a stop and
      ``needs_reconnect`` write ``PAYCONN#adsense``).
    """
    granted = conn.get("grantedAt")
    if isinstance(granted, str) and granted:
        return f"granted|{granted}"
    if source == WHOP:
        return str(conn.get("connectedAt") or "")
    return f"{conn.get('connectedAt') or ''}|{conn.get('updatedAt') or ''}"


_TAG = re.compile(r"<[^>]*>")
_BREAK = re.compile(r"<\s*(br|/p|/div|/li)\b[^>]*>", re.IGNORECASE)


def plain_text(raw: Any, limit: int = TEXT_MAX) -> str:
    """A platform message (localised, may hold HTML) as plain text of at most ``limit`` characters."""
    text = _BREAK.sub(" ", str(raw or ""))
    text = html.unescape(_TAG.sub("", text))
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --- the items -------------------------------------------------------------------------------------------------


def load(store: db.Store, user_id: str, sk: str) -> dict[str, Any]:
    return store.get(db.user_pk(user_id), sk) or {}


def write_state(
    store: db.Store, user_id: str, place: str, fields: Mapping[str, Any], remove: Iterable[str] = ()
) -> dict[str, Any]:
    """One UpdateItem on ``PAYSTATE#{place}`` (made when missing): ``fields`` set, ``remove`` removed. A ``None``
    value is removed too (DynamoDB keeps no nulls)."""
    sets = {k: v for k, v in fields.items() if v is not None}
    gone = [*dict.fromkeys([*remove, *(k for k, v in fields.items() if v is None)])]
    names = {f"#s{i}": k for i, k in enumerate(sets)} | {f"#r{i}": k for i, k in enumerate(gone)}
    values = {f":s{i}": v for i, v in enumerate(sets.values())}
    update = "SET " + ", ".join(f"#s{i} = :s{i}" for i in range(len(sets)))
    if gone:
        update += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(gone)))
    return store.update_expr(db.user_pk(user_id), paystate_sk(place), update, names=names, values=values)


def set_error(store: db.Store, user_id: str, source: str, text: str) -> None:
    """A failed read: only ``lastError`` changes (with the item's own type), everything read before stays."""
    write_state(
        store, user_id, PLACE[source], {"type": "paystate", "place": PLACE[source], "source": source, "lastError": text}
    )


def start_read(store: db.Store, user_id: str, source: str, state: Mapping[str, Any], mark: str) -> dict[str, Any]:
    """Before a read: when the connection is a new grant (another ``grantMark``), ``firstReadDone`` is removed first,
    so this grant's first read is quiet (no notification for old money) and nothing counts as fresh until it ends.
    For Whop ``payoutsMark`` goes too: the new grant may be another Whop account, so its first read pages from the
    start, never from the old account's newest payout."""
    if not state or state.get("grantMark") == mark:
        return dict(state)
    remove = ["firstReadDone", "payoutsMark"] if source == WHOP else ["firstReadDone"]
    return write_state(store, user_id, PLACE[source], {"grantMark": mark}, remove=remove)


def mark_reconnect(store: db.Store, user_id: str, source: str, reason: str, now: datetime) -> bool:
    """``PAYCONN#{source}`` → ``needs_reconnect`` with ``reason`` (``token_dead`` or ``keys_changed``), only while it is
    still ``connected`` (a stop meanwhile wins). Nothing is deleted: not the token, not a row."""
    try:
        store.update(
            db.user_pk(user_id),
            payconn_sk(source),
            {"status": "needs_reconnect", "reason": reason, "updatedAt": iso(now)},
            expect_in={"status": ["connected"]},
        )
    except db.ConditionFailed:
        return False
    log("warning", "payouts.needs_reconnect", source=source, reason=reason)
    return True


def newest_sent(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The newest row whose state is ``sent`` (by date, then sort key), or None."""
    sent: list[Mapping[str, Any]] = [r for r in rows if r.get("state") == "sent" and isinstance(r.get("sk"), str)]
    if not sent:
        return None
    newest: Mapping[str, Any] = max(sent, key=lambda r: (str(r.get("date") or ""), str(r["sk"])))
    return dict(newest)
