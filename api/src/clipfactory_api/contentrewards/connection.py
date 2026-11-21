"""The ``CRCONN`` item and its public shape ``CrConnection`` (docs/CONTRACTS.md §38.3, §38.8, §38.11)."""

from __future__ import annotations

import re
import urllib.parse
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso, parse
from . import config

Item = dict[str, Any]
STATUSES = ("not_connected", "connected", "read_only", "needs_reconnect")
SIGNED_IN = ("connected", "read_only")
STEP_ID = re.compile(r"^[a-z0-9-]{1,40}$")
INTERNAL = (
    "refreshLeaseUntil",
    "tokenVersionId",
    "tokenIssuedAt",
    "lastRefreshAt",
    "creatorId",
    "scopes",
    "typeidVerified",
    "orgMatched",
    "pilotReminders",
    "pilotRemindAt",
    "warnedAt",
    "lastCheckAt",
)

PILOT_TO = "support@contentrewards.com"
PILOT_SUBJECT = "Please let my account connect apps (MCP sign-in pilot)"
PILOT_BODY = (
    "Hi! Please let my Content Rewards account connect apps, so Clip Factory can send my own clips for me. My login "
    "is this email address. Thank you! (For your team: MCP sign-in pilot, scope my_submissions:write.)"
)

CHECK_TEXT = {
    "ok": "Content Rewards answers. You're signed in.",
    "read_only": "You're signed in. Content Rewards hasn't let Clip Factory send clips yet.",
    "not_connected": "Content Rewards isn't connected yet. Tap Connect Content Rewards.",
    "token_dead": "Content Rewards signed you out. Tap Connect again.",
    "missing_permissions": "A permission was not allowed. Tap Connect again and allow every box.",
    "blocked": "Content Rewards stopped Clip Factory for now. You send clips yourself until it's fixed.",
    "cr_down": "Content Rewards didn't answer. Try again in a few minutes.",
}


def pilot_email() -> Item:
    query = urllib.parse.urlencode({"subject": PILOT_SUBJECT, "body": PILOT_BODY}, quote_via=urllib.parse.quote)
    return {"to": PILOT_TO, "subject": PILOT_SUBJECT, "body": PILOT_BODY, "mailto": f"mailto:{PILOT_TO}?{query}"}


def key(user_id: str) -> tuple[str, str]:
    return db.user_pk(user_id), db.CRCONN_SK


def load(store: db.Store, user_id: str) -> Item:
    """The stored ``CRCONN`` (consistent), or an empty not-connected one."""
    found = store.get(*key(user_id))
    return found or {"pk": db.user_pk(user_id), "sk": db.CRCONN_SK, "type": "crconn", "status": "not_connected"}


def ensure(store: db.Store, user_id: str, now: datetime) -> Item:
    """The item exists (so the refresh lease and conditional writes have something to hold)."""
    item = {
        "pk": db.user_pk(user_id),
        "sk": db.CRCONN_SK,
        "type": "crconn",
        "userId": user_id,
        "status": "not_connected",
        "canSubmit": False,
        "updatedAt": iso(now),
    }
    try:
        store.put(item, if_absent=True)
    except db.ConditionFailed:
        return load(store, user_id)
    return item


def update(
    store: db.Store, user_id: str, now: datetime, fields: Mapping[str, Any], remove: list[str] | None = None
) -> Item:
    pk, sk = key(user_id)
    return store.update(pk, sk, {**fields, "updatedAt": iso(now)}, remove=remove or [])


def signed_in(item: Mapping[str, Any]) -> bool:
    return item.get("status") in SIGNED_IN


def effective(item: Mapping[str, Any], now: datetime) -> tuple[str, str | None]:
    """``(status, reason)`` as shown now: past ``signInBy`` is ``needs_reconnect`` (``signed_out_90_days``), the
    last week is ``expires_soon``."""
    status = str(item.get("status") or "not_connected")
    reason = item.get("reason") if isinstance(item.get("reason"), str) else None
    if status in SIGNED_IN:
        by = parse(item.get("signInBy"))
        if by is not None and now >= by:
            return "needs_reconnect", "signed_out_90_days"
        if by is not None and now >= by - config.WARN_BEFORE and reason not in {"missing_permissions"}:
            return status, "expires_soon"
    return status, reason


def can_submit(item: Mapping[str, Any], now: datetime) -> bool:
    status, _ = effective(item, now)
    return status == "connected" and bool(item.get("canSubmit")) and not item.get("blocked")


def refused(item: Mapping[str, Any]) -> bool:
    """CR hasn't let Clip Factory look: not connected after a "can't connect apps", or the connection is blocked."""
    if item.get("blocked"):
        return True
    return not signed_in(item) and (item.get("lastResult") == "not_allowed" or bool(item.get("pilotSentAt")))


def crlinked(item: Mapping[str, Any]) -> dict[str, bool]:
    raw = item.get("crLinked")
    if not isinstance(raw, Mapping):
        return {}
    return {str(k): bool(v) for k, v in raw.items() if isinstance(v, bool)}


def public(item: Mapping[str, Any], now: datetime) -> Item:
    status, reason = effective(item, now)
    out: Item = {
        "status": status,
        "canSubmit": bool(item.get("canSubmit")) and status == "connected",
        "crLinked": crlinked(item),
        "stepsDone": sorted(str(s) for s in item.get("stepsDone") or [] if isinstance(s, str)),
        "pilotEmail": pilot_email(),
    }
    signed = item.get("connectedAt") and status in (*SIGNED_IN, "needs_reconnect")
    if signed:
        out["connectedAt"] = item["connectedAt"]
    by = parse(item.get("signInBy"))
    if by is not None and signed:
        out["signInBy"] = iso(by)
        out["warnFrom"] = iso(by - config.WARN_BEFORE)
    missing = item.get("missing")
    if isinstance(missing, list) and missing:
        out["missing"] = [str(m) for m in missing]
    if reason:
        out["reason"] = reason
    if item.get("blocked"):
        out["blocked"] = True
    if isinstance(item.get("finance"), bool):
        out["finance"] = item["finance"]
    for name in ("pilotSentAt", "lastResult"):
        if item.get(name):
            out[name] = item[name]
    if isinstance(item.get("check"), Mapping):
        out["check"] = dict(item["check"])
    return out


def check(code: str, now: datetime) -> Item:
    return {"at": iso(now), "ok": code in {"ok", "read_only"}, "code": code, "message": CHECK_TEXT[code]}
