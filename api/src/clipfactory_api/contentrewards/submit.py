"""Sending one campaign post to CR (docs/CONTRACTS.md §38.9 error table, §38.12 "One send").

CR takes a post only while it is less than 30 minutes live, so the clip flow sends it the moment it is posted, then
every minute until 25 minutes after posting (``deadline``); after that the owner's reminder takes over until
``sendBy`` (30 minutes). ``CRSUB#{postId}`` is always created first as ``sending`` (``attribute_not_exists(pk)``);
``campaignId`` never changes and ``crId``, ``url`` and the ``idempotency_key`` are frozen at that first write, so a
replayed step never sends twice. ``send`` never raises.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from . import campaigns, config, connection, ids
from .deps import CrDeps
from .mcp import BUG_CODES, CrError, read_only_tool
from .submissions import key, reason_text

Item = dict[str, Any]
FINAL = ("sent", "approved", "rejected", "sent_by_hand", "missed", "not_sent")
IN_STEP_TRIES = 2
_SHORT = re.compile(r"minimum of (\d+) seconds", re.IGNORECASE)


def _now(deps: CrDeps) -> datetime:
    return deps.clock()


def _update(
    deps: CrDeps, user_id: str, post_id: str, fields: Mapping[str, Any], remove: list[str] | None = None
) -> Item:
    return deps.store.update(*key(user_id, post_id), {**fields, "updatedAt": iso(_now(deps))}, remove=remove or [])


def _hand(deps: CrDeps, user_id: str, sub: Mapping[str, Any], code: str, *, detail: str = "") -> dict[str, Any]:
    """``send_by_hand`` while there is time before ``sendBy``, else ``missed``."""
    now = _now(deps)
    by = parse(sub.get("sendBy"))
    platform = str(sub.get("platform") or "")
    if by is not None and now >= by:
        _update(deps, user_id, str(sub["postId"]), {"state": "missed", "lastTryAt": iso(now)})
        return {"outcome": "missed", "pending": []}
    reason: Item = {"code": code, "text": reason_text(code, platform, detail=detail)}
    _update(deps, user_id, str(sub["postId"]), {"state": "send_by_hand", "reason": reason, "lastTryAt": iso(now)})
    return {"outcome": "send_by_hand", "pending": []}


def _not_sent(
    deps: CrDeps,
    user_id: str,
    sub: Mapping[str, Any],
    code: str,
    *,
    detail: str = "",
    seconds: int | None = None,
    campaign_text: str = "",
) -> dict[str, Any]:
    platform = str(sub.get("platform") or "")
    reason: Item = {
        "code": code,
        "text": reason_text(code, platform, detail=detail, seconds=seconds, campaign_text=campaign_text),
    }
    if detail:
        reason["brandSaid"] = detail[:300]
    _update(deps, user_id, str(sub["postId"]), {"state": "not_sent", "reason": reason, "lastTryAt": iso(_now(deps))})
    return {"outcome": "not_sent", "pending": []}


def _retry(deps: CrDeps, user_id: str, sub: Mapping[str, Any], code: str) -> dict[str, Any]:
    now = _now(deps)
    deadline = parse(sub.get("deadline"))
    post_id = str(sub["postId"])
    if deadline is not None and now < deadline:
        _update(deps, user_id, post_id, {"attempts": int(sub.get("attempts") or 0) + 1, "lastTryAt": iso(now)})
        return {"outcome": "retry", "pending": [post_id]}
    if code == "resource_missing":
        return _hand(deps, user_id, sub, "not_visible_yet")
    return _hand(deps, user_id, sub, "window_over")


def _create(deps: CrDeps, user_id: str, post: Mapping[str, Any], campaign_id: str, cr_id: str | None) -> Item | None:
    """The first write (``sending``); the existing item when there is one."""
    pk, sk = key(user_id, str(post["postId"]))
    posted = parse(post.get("postedAt")) or _now(deps)
    item: Item = {
        "pk": pk,
        "sk": sk,
        "type": "crsub",
        "userId": user_id,
        "postId": str(post["postId"]),
        "clipId": str(post.get("clipId") or ""),
        "campaignId": campaign_id,
        "url": str(post.get("url") or ""),
        "gen": 0,
        "key": str(post["postId"]),
        "platform": str(post.get("platform") or ""),
        "state": "sending",
        "attempts": 0,
        "postedAt": iso(posted),
        "deadline": iso(posted + config.SEND_DEADLINE),
        "sendBy": iso(posted + config.SEND_BY),
        "updatedAt": iso(_now(deps)),
    }
    if cr_id:
        item["crId"] = cr_id
    try:
        deps.store.put(item, if_absent=True)
    except db.ConditionFailed:
        return deps.store.get(pk, sk)
    return item


def send(deps: CrDeps, user_id: str, post_id: str, campaign_id: str, *, timeout: float | None = None) -> dict[str, Any]:
    """One try for one post. Never raises: any exception makes the post ``send_by_hand`` (``not_sent_by_app``)
    while there is time left, else ``missed``, and returns ``{outcome: "error", pending: []}``."""
    try:
        return _send(deps, user_id, post_id, campaign_id, timeout or deps.submit_timeout)
    except Exception as e:
        log("error", "cr.send_failed", postId=post_id, error=type(e).__name__)
        try:
            sub = deps.store.get(*key(user_id, post_id))
            if sub is not None and sub.get("state") not in FINAL:
                _hand(deps, user_id, sub, "not_sent_by_app")
        except Exception as inner:
            log("error", "cr.send_mark_failed", postId=post_id, error=type(inner).__name__)
        return {"outcome": "error", "pending": []}


def _send(deps: CrDeps, user_id: str, post_id: str, campaign_id: str, timeout: float) -> dict[str, Any]:
    post = deps.store.get(db.user_pk(user_id), db.post_sk(post_id))
    if post is None or post.get("status") != "posted":
        return {"outcome": "not_posted", "pending": []}
    campaign = campaigns.get(deps.store, user_id, campaign_id) or {}
    sub = _create(deps, user_id, post, campaign_id, campaign.get("crId"))
    if sub is None:
        return {"outcome": "missing", "pending": []}
    if sub.get("campaignId") != campaign_id:
        log("warning", "cr.other_campaign", postId=post_id)
        return {"outcome": "other_campaign", "pending": []}
    if sub.get("state") in FINAL:
        return {"outcome": str(sub["state"]), "pending": []}
    now = _now(deps)
    if post.get("privacy") == "private":
        return _not_sent(deps, user_id, sub, "private")
    conn = connection.load(deps.store, user_id)
    status, _reason = connection.effective(conn, now)
    if status not in connection.SIGNED_IN:
        return _hand(deps, user_id, sub, "no_connection")
    if status == "read_only" or not conn.get("canSubmit") or conn.get("blocked"):
        return _hand(deps, user_id, sub, "read_only")
    if campaign.get("membership") == "manual":
        return _hand(deps, user_id, sub, "manual")
    if campaign.get("idMatch") == "ambiguous":
        return _hand(deps, user_id, sub, "ambiguous")
    try:
        listed, _complete = campaigns.list_campaigns(deps, user_id)
    except CrError as e:
        return _answer(deps, user_id, sub, campaign, e)
    row, how = ids.match_campaign(
        listed,
        campaign_id,
        campaign.get("public") if isinstance(campaign.get("public"), Mapping) else None,
        use_typeid=conn.get("typeidVerified") is not False,
        org_matches=conn.get("orgMatched") is not False,
    )
    if how == "ambiguous":
        return _hand(deps, user_id, sub, "ambiguous")
    if row is None:
        return _hand(deps, user_id, sub, "not_listed")
    if row.get("status") == "paused":
        return _not_sent(deps, user_id, sub, "campaign_closed")
    matched = str(row.get("id") or "")
    if sub.get("crId") != matched:
        sub = _refreeze(deps, user_id, sub, matched)
    client = deps.mcp(user_id)
    for attempt in range(IN_STEP_TRIES + 1):
        try:
            result = client.call(
                "create_my_submission",
                {"campaign": sub["crId"], "url": sub["url"], "idempotency_key": sub["key"]},
                timeout=timeout,
            )
        except CrError as e:
            if e.code in {"service_unavailable", "timeout"} and attempt < IN_STEP_TRIES:
                wait = min(e.retry_after if e.retry_after is not None else 5.0, 10.0)
                deadline = parse(sub.get("deadline"))
                if (
                    deadline is not None
                    and (deadline - _now(deps)).total_seconds() > wait + timeout
                    and deps.remaining() > wait + timeout + 5
                ):
                    deps.sleep(wait)
                    continue
            return _answer(deps, user_id, sub, campaign, e)
        return _sent(deps, user_id, sub, result)
    return _retry(deps, user_id, sub, "service_unavailable")


def _refreeze(deps: CrDeps, user_id: str, sub: Mapping[str, Any], cr_id: str) -> Item:
    """The matched id changed (a re-match): a new generation and key, never re-sent with the old key."""
    if not sub.get("crId"):
        return _update(deps, user_id, str(sub["postId"]), {"crId": cr_id})
    gen = int(sub.get("gen") or 0) + 1
    return _update(deps, user_id, str(sub["postId"]), {"crId": cr_id, "gen": gen, "key": f"{sub['postId']}:{gen}"})


def resend_link(deps: CrDeps, user_id: str, sub: Mapping[str, Any], url: str) -> Item:
    """ "Try sending again" after the post's link changed: a new generation with the new link."""
    gen = int(sub.get("gen") or 0) + 1
    return _update(deps, user_id, str(sub["postId"]), {"url": url, "gen": gen, "key": f"{sub['postId']}:{gen}"})


def _sent(deps: CrDeps, user_id: str, sub: Mapping[str, Any], result: Mapping[str, Any]) -> dict[str, Any]:
    now = _now(deps)
    status = str(result.get("status") or "pending")
    state = {"approved": "approved", "rejected": "rejected"}.get(status, "sent")
    fields: Item = {
        "state": state,
        "crStatus": status,
        "sentAt": iso(now),
        "lastTryAt": iso(now),
        "nextCheckAt": iso(now + config.TICK),
    }
    if result.get("id"):
        fields["submissionId"] = str(result["id"])
    _update(deps, user_id, str(sub["postId"]), fields, remove=["reason"])
    _linked(deps, user_id, str(sub.get("platform") or ""), True)
    log("info", "cr.sent", postId=sub["postId"], platform=sub.get("platform"))
    return {"outcome": "sent", "pending": []}


def _linked(deps: CrDeps, user_id: str, platform: str, value: bool) -> None:
    if not platform:
        return
    conn = connection.load(deps.store, user_id)
    linked = connection.crlinked(conn)
    if linked.get(platform) is value:
        return
    linked[platform] = value
    try:
        connection.update(deps.store, user_id, _now(deps), {"crLinked": linked})
    except db.ConditionFailed:
        return


def _campaign_set(deps: CrDeps, user_id: str, campaign: Mapping[str, Any], fields: Mapping[str, Any]) -> None:
    if not campaign.get("campaignId"):
        return
    try:
        deps.store.update(*campaigns.key(user_id, str(campaign["campaignId"])), dict(fields))
    except db.ConditionFailed:
        return


def _answer(
    deps: CrDeps, user_id: str, sub: Mapping[str, Any], campaign: Mapping[str, Any], e: CrError
) -> dict[str, Any]:
    """The §38.9 error table for ``create_my_submission``."""
    detail = e.detail or ""
    folded = detail.lower()
    platform = str(sub.get("platform") or "")
    log("info", "cr.send_refused", code=e.code, requestId=e.request_id or None)
    if e.code in {"not_connected", "token_dead", "invalid_token"}:
        return _hand(deps, user_id, sub, "no_connection")
    if e.code == "insufficient_scope":
        return _hand(deps, user_id, sub, "read_only")
    if e.code == "permission_denied" and not e.tool_result:
        return _hand(deps, user_id, sub, "read_only")  # the connection itself is refused (CRCONN.blocked)
    if e.code == "permission_denied":
        _campaign_set(deps, user_id, campaign, {"nextCheckAt": iso(_now(deps))})
        return _not_sent(deps, user_id, sub, "campaign_refused", detail=detail)
    if e.code == "jsonrpc":
        if e.jsonrpc == -32602:
            read_only_tool(deps.mcp(user_id))
            return _hand(deps, user_id, sub, "read_only")
        if e.jsonrpc == -32603 and int(sub.get("attempts") or 0) < 1:
            return _retry(deps, user_id, sub, "internal_error")
        log("error", "cr.send_bug", jsonrpc=e.jsonrpc)
        deps.mcp(user_id).feedback(f"jsonrpc{e.jsonrpc}", "create_my_submission")
        return _hand(deps, user_id, sub, "not_sent_by_app")
    if e.code in BUG_CODES:
        log("error", "cr.send_bug", code=e.code)
        deps.mcp(user_id).feedback(e.code, "create_my_submission", e.request_id)
        return _hand(deps, user_id, sub, "not_sent_by_app")
    if e.code == "internal_error":
        if int(sub.get("attempts") or 0) < 1:
            return _retry(deps, user_id, sub, "internal_error")
        deps.mcp(user_id).feedback(e.code, "create_my_submission", e.request_id)
        return _hand(deps, user_id, sub, "not_sent_by_app")
    if e.code == "creator_banned":
        return _not_sent(deps, user_id, sub, "banned")
    if e.code == "creator_cap_reached":
        _campaign_set(deps, user_id, campaign, {"capReached": True})
        return _not_sent(deps, user_id, sub, "cap")
    if e.code in {"budget_exhausted", "submissions_on_hold"}:
        _campaign_set(deps, user_id, campaign, {"nextCheckAt": iso(_now(deps))})
        return _not_sent(deps, user_id, sub, "campaign_closed")
    if e.code == "resource_missing":
        return _retry(deps, user_id, sub, "resource_missing")
    if e.code == "conflict":
        return _conflict(deps, user_id, sub, campaign, folded, detail, platform)
    if e.retryable:
        return _retry(deps, user_id, sub, e.code)
    deps.mcp(user_id).feedback(e.code or "unknown", "create_my_submission", e.request_id)
    return _hand(deps, user_id, sub, "not_sent_by_app")


def _conflict(  # noqa: PLR0917 (one call site)
    deps: CrDeps,
    user_id: str,
    sub: Mapping[str, Any],
    campaign: Mapping[str, Any],
    folded: str,
    detail: str,
    platform: str,
) -> dict[str, Any]:
    now = _now(deps)
    if "already" in folded and "submit" in folded:
        _update(deps, user_id, str(sub["postId"]), {"state": "sent_by_hand", "lastTryAt": iso(now)}, remove=["reason"])
        return {"outcome": "sent_by_hand", "pending": []}
    if "linked" in folded and ("don't have" in folded or "do not have" in folded or "couldn't match" in folded):
        _linked(deps, user_id, platform, False)
        return _not_sent(deps, user_id, sub, "not_linked")
    if "on your application" in folded:
        return _not_sent(deps, user_id, sub, "not_on_application")
    if "connected by signing in" in folded or "analytics access" in folded:
        return _not_sent(deps, user_id, sub, "relink")
    if "doesn't accept" in folded or "does not accept" in folded:
        return _not_sent(deps, user_id, sub, "wrong_place")
    short = _SHORT.search(detail)
    if "shorter than" in folded and short:
        seconds = int(short.group(1))
        rules_now = dict(campaign.get("rules") or {}) if isinstance(campaign.get("rules"), Mapping) else None
        if rules_now is not None:
            rules_now["lengthMinSec"] = max(int(rules_now.get("lengthMinSec") or 0), seconds)
            _campaign_set(deps, user_id, campaign, {"rules": rules_now})
        return _not_sent(deps, user_id, sub, "too_short", seconds=seconds)
    if "30 minutes" in folded or "past that window" in folded or ("window" in folded and "past" in folded):
        _update(deps, user_id, str(sub["postId"]), {"state": "missed", "lastTryAt": iso(now)})
        return {"outcome": "missed", "pending": []}
    if "not approved" in folded or "too many" in folded:
        pending = sum(
            1
            for s in deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX)
            if s.get("campaignId") == campaign.get("campaignId") and s.get("crStatus") == "pending"
        )
        _campaign_set(deps, user_id, campaign, {"held": {"at": iso(now), "pending": pending}})
        return _not_sent(deps, user_id, sub, "held")
    if "social account" in folded or "won't take" in folded or "will not take" in folded:
        return _not_sent(deps, user_id, sub, "account_refused")
    if "sound" in folded:
        _flag_rule(deps, user_id, campaign, "soundRequired")
        return _not_sent(deps, user_id, sub, "sound_needed")
    if "draft" in folded:
        _flag_rule(deps, user_id, campaign, "draftsFirst")
        return _not_sent(deps, user_id, sub, "drafts_first")
    if any(w in folded for w in ("not active", "no longer accepting", "out of budget", "budget")):
        _campaign_set(deps, user_id, campaign, {"nextCheckAt": iso(now)})
        return _not_sent(deps, user_id, sub, "campaign_closed")
    if any(
        w in folded for w in ("couldn't confirm", "couldn't read that post", "took too long", "connection was lost")
    ):
        return _retry(deps, user_id, sub, "conflict")
    return _not_sent(deps, user_id, sub, "refused", detail=detail)


def _flag_rule(deps: CrDeps, user_id: str, campaign: Mapping[str, Any], name: str) -> None:
    rules_now = dict(campaign.get("rules") or {}) if isinstance(campaign.get("rules"), Mapping) else None
    if rules_now is None:
        return
    rules_now[name] = True
    _campaign_set(deps, user_id, campaign, {"rules": rules_now})


def send_many(
    deps: CrDeps, user_id: str, posts: list[tuple[str, str]], *, timeout: float | None = None
) -> dict[str, Any]:
    """The catch-up and retry steps: every pending ``(postId, campaignId)`` once; the ones still pending."""
    pending: list[str] = []
    outcomes: dict[str, str] = {}
    for post_id, campaign_id in posts:
        result = send(deps, user_id, post_id, campaign_id, timeout=timeout)
        outcomes[post_id] = str(result["outcome"])
        pending.extend(result.get("pending") or [])
    return {"outcomes": outcomes, "pending": pending}
