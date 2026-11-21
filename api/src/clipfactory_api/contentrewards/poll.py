"""Checking, folded into ``cf-prod-stats`` (docs/CONTRACTS.md §38.12 "Checking").

``run_tick`` runs after the platform poll on the existing 15-minute rule; ``run_owner`` serves the
``{"action": "contentrewards", "userId", "what"}`` event too. For each ``CROWNERS`` owner, in this order: (1) time
only, (2) the sign-in's keep-alive and the 90 days, (3) membership, (4) money, (5) submissions. At most 25 CR calls
per owner per tick; ``rate_limited`` ends that owner's tick; nothing here raises, and one owner's failure never stops
another.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from . import campaigns, config, connection, links
from . import money as money_mod
from .deps import CrDeps
from .mcp import CrError
from .submissions import key as sub_key
from .util import obj

Item = dict[str, Any]
SUB_DUE_STATES = ("sent", "sent_by_hand", "send_by_hand", "missed", "approved", "rejected")


class OutOfCalls(Exception):
    """This owner used the tick's 25 calls (or CR asked to slow down)."""


def owners(store: db.Store) -> list[str]:
    rows = store.query_all(db.CROWNERS_PK, "USER#")
    return [str(r["sk"]).removeprefix("USER#") for r in rows if r.get("type") == "crowner"]


def run_tick(deps: CrDeps, now: datetime, budget: float) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.0, budget)
    done: dict[str, Any] = {}
    for user_id in owners(deps.store):
        if time.monotonic() >= deadline:
            done[user_id] = "no_time"
            continue
        done[user_id] = run_owner(deps, user_id, now, deadline=deadline)
    log("info", "cr.tick", owners=len(done))
    return {"owners": len(done)}


def run_owner(
    deps: CrDeps,
    user_id: str,
    now: datetime,
    *,
    what: str = "tick",
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """One owner's checks. ``what``: ``tick`` (only what is due), ``campaigns``, ``money`` or ``all`` (forced)."""
    report: dict[str, Any] = {}
    client = deps.mcp(user_id)
    start = client.calls

    def budget_left() -> bool:
        return (deadline is None or clock() < deadline) and client.calls - start < config.CALLS_PER_OWNER_TICK

    steps: list[tuple[str, Callable[[], Any]]] = [
        ("time", lambda: time_only(deps, user_id, now)),
        ("signin", lambda: sign_in(deps, user_id, now)),
        ("membership", lambda: membership(deps, user_id, now, force=what in ("campaigns", "all"))),
        (
            "money",
            lambda: money_step(
                deps,
                user_id,
                now,
                force=what in ("money", "all"),
                calls_left=config.CALLS_PER_OWNER_TICK - (client.calls - start),
            ),
        ),
        ("submissions", lambda: submissions(deps, user_id, now, budget_left)),
    ]
    for name, step in steps:
        if name != "time" and not budget_left():
            report[name] = "skipped"
            continue
        try:
            report[name] = step()
        except CrError as e:
            report[name] = f"cr:{e.code}"
            if e.code == "rate_limited":
                break
        except Exception as e:  # one step's bug never stops the others or another owner
            log("error", "cr.poll_failed", step=name, error=type(e).__name__)
            report[name] = "error"
    return report


# --- 1. time only ------------------------------------------------------------------------------------------------


def time_only(deps: CrDeps, user_id: str, now: datetime) -> dict[str, int]:
    pk = db.user_pk(user_id)
    counts = {"missed": 0, "hand": 0, "proofs": 0, "failedReads": 0, "pilot": 0}
    by_campaign = {c["campaignId"]: c for c in campaigns.all_for(deps.store, user_id)}
    for sub in deps.store.query_all(pk, db.CRSUB_PREFIX):
        if sub.get("type") != "crsub":
            continue
        state = sub.get("state")
        send_by = parse(sub.get("sendBy"))
        if state == "send_by_hand" and send_by is not None and now >= send_by:
            deps.store.update(sub["pk"], sub["sk"], {"state": "missed", "updatedAt": iso(now)})
            counts["missed"] += 1
        elif state == "sending":
            deadline, last = parse(sub.get("deadline")), parse(sub.get("lastTryAt"))
            if deadline is not None and now >= deadline and (last is None or now - last > config.STUCK_SENDING):
                if send_by is not None and now < send_by:
                    from .submissions import reason_text

                    reason = {"code": "window_over", "text": reason_text("window_over", str(sub.get("platform")))}
                    deps.store.update(
                        sub["pk"], sub["sk"], {"state": "send_by_hand", "reason": reason, "updatedAt": iso(now)}
                    )
                    counts["hand"] += 1
                else:
                    deps.store.update(sub["pk"], sub["sk"], {"state": "missed", "updatedAt": iso(now)})
                    counts["missed"] += 1
        if state in ("sent", "approved", "sent_by_hand") and _proof_due(
            deps, sub, by_campaign.get(str(sub.get("campaignId"))), now
        ):
            counts["proofs"] += 1
    for item in by_campaign.values():
        started = parse(item.get("readStartedAt"))
        if item.get("rulesState") == "reading" and started is not None and now - started > config.READ_STALE:
            deps.store.update(item["pk"], item["sk"], {"rulesState": "failed"})
            counts["failedReads"] += 1
    conn = connection.load(deps.store, user_id)
    sent_at = parse(conn.get("pilotSentAt"))
    reminders = int(conn.get("pilotReminders") or 0)
    if sent_at is not None and not conn.get("canSubmit") and reminders < config.PILOT_MAX:
        due = parse(conn.get("pilotRemindAt")) or sent_at + config.PILOT_EVERY
        if now >= due:
            connection.update(
                deps.store,
                user_id,
                now,
                {"pilotReminders": reminders + 1, "pilotRemindAt": iso(now + config.PILOT_EVERY)},
            )
            counts["pilot"] += 1
    return counts


def _proof_due(deps: CrDeps, sub: Mapping[str, Any], campaign: Mapping[str, Any] | None, now: datetime) -> bool:
    proof = sub.get("proof") if isinstance(sub.get("proof"), Mapping) else None
    if proof is not None and proof.get("notifiedAt"):
        return False
    rules_now = obj((campaign or {}).get("rules"))
    rule = next(
        (
            r
            for r in rules_now.get("postSubmissionRules") or []
            if isinstance(r, Mapping) and (r.get("afterHours") or r.get("atViews"))
        ),
        None,
    )
    if rule is None:
        return False
    posted = parse(sub.get("postedAt"))
    due_at = posted + timedelta(hours=int(rule["afterHours"])) if rule.get("afterHours") and posted else None
    due = due_at is not None and now >= due_at
    if not due and rule.get("atViews"):
        post = deps.store.get(db.user_pk(str(sub.get("userId") or "")), db.post_sk(str(sub.get("postId")))) or {}
        views = (post.get("metrics") or {}).get("views") if isinstance(post.get("metrics"), Mapping) else None
        due = isinstance(views, int) and views >= int(rule["atViews"])
    if not due:
        return False
    deps.store.update(
        sub["pk"],
        sub["sk"],
        {
            "proof": {
                "text": "To do: send the brand a screen recording of this clip's views.",
                "where": rule.get("where"),
                "dueAt": iso(due_at or now),
                "notifiedAt": iso(now),
            },
            "updatedAt": iso(now),
        },
    )
    return True


# --- 2. the sign-in ----------------------------------------------------------------------------------------------


def sign_in(deps: CrDeps, user_id: str, now: datetime) -> str:
    conn = connection.load(deps.store, user_id)
    if not connection.signed_in(conn):
        return "not_connected"
    status, reason = connection.effective(conn, now)
    if status == "needs_reconnect":
        connection.update(deps.store, user_id, now, {"status": "needs_reconnect", "reason": "signed_out_90_days"})
        return "signed_out"
    if reason == "expires_soon" and conn.get("reason") != "expires_soon":
        connection.update(deps.store, user_id, now, {"reason": "expires_soon", "warnedAt": iso(now)})
    return deps.tokens().keep_alive(user_id, now)


# --- 3. membership -------------------------------------------------------------------------------------------------


def membership(deps: CrDeps, user_id: str, now: datetime, *, force: bool = False) -> dict[str, int]:
    conn = connection.load(deps.store, user_id)
    items = campaigns.all_for(deps.store, user_id)
    _clear_holds(deps, user_id, items, now)
    if not connection.signed_in(conn) or conn.get("blocked"):
        return {"due": 0}
    due = [
        c
        for c in items
        if force or (parse(c.get("nextCheckAt")) is not None and parse(c.get("nextCheckAt")) <= now)  # type: ignore[operator]
    ]
    if not due:
        return {"due": 0}
    listed, complete = campaigns.list_campaigns(deps, user_id, fresh=True)
    changed = 0
    for item in due:
        before = (item.get("membership"), item.get("state"), item.get("briefHash"))
        campaigns.settle_membership(item, conn, listed, complete, now)
        campaigns.verify_typeid(deps, user_id, conn, item, now)
        if campaigns.needs_read(item):
            campaigns.start_read(deps, user_id, item, now)
        campaigns.save(deps, user_id, item)
        if before != (item.get("membership"), item.get("state"), item.get("briefHash")):
            changed += 1
    return {"due": len(due), "changed": changed}


def _clear_holds(deps: CrDeps, user_id: str, items: list[Item], now: datetime) -> None:
    subs = None
    for item in items:
        held = item.get("held")
        if not isinstance(held, Mapping):
            continue
        at = parse(held.get("at"))
        if subs is None:
            subs = deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX)
        pending = sum(
            1 for s in subs if s.get("campaignId") == item.get("campaignId") and s.get("crStatus") == "pending"
        )
        if (at is not None and now - at >= config.HELD_FOR) or pending < int(held.get("pending") or 0):
            deps.store.update(item["pk"], item["sk"], {"heldClearedAt": iso(now)}, remove=["held"])


# --- 4. money ----------------------------------------------------------------------------------------------------


def money_step(deps: CrDeps, user_id: str, now: datetime, *, force: bool = False, calls_left: int = 25) -> str:
    conn = connection.load(deps.store, user_id)
    if not connection.signed_in(conn):
        return "not_connected"
    item = money_mod.load(deps.store, user_id)
    due_at = parse(item.get("nextCheckAt"))
    if not force and item.get("firstReadDone") and due_at is not None and due_at > now:
        return "not_due"
    money_mod.read(deps, user_id, now, calls_left=max(1, calls_left))
    return "read"


# --- 5. submissions ------------------------------------------------------------------------------------------------


def _sub_due(sub: Mapping[str, Any], now: datetime) -> bool:
    state = sub.get("state")
    sent = parse(sub.get("sentAt")) or parse(sub.get("postedAt"))
    next_at = parse(sub.get("nextCheckAt"))
    if next_at is not None and next_at > now:
        return False
    if state in ("send_by_hand", "missed"):
        posted = parse(sub.get("postedAt"))
        return posted is not None and now - posted < timedelta(days=2)
    if state in ("sent", "sent_by_hand"):
        return True
    if state == "approved":
        return sent is not None and now - sent < config.STOP_AFTER
    if state == "rejected":
        reviewed = parse(sub.get("reviewedAt")) or sent
        return reviewed is not None and now - reviewed < timedelta(days=10)
    return False


def _cadence(sub: Mapping[str, Any], now: datetime) -> timedelta:
    state = sub.get("state")
    sent = parse(sub.get("sentAt")) or now
    if state in ("sent", "sent_by_hand"):
        return config.TICK if now - sent < timedelta(hours=48) else timedelta(hours=1)
    if state == "approved":
        return config.SLOW_EVERY
    if state == "rejected":
        return timedelta(days=1)
    return config.TICK


def submissions(
    deps: CrDeps, user_id: str, now: datetime, budget_left: Callable[[], bool], only: set[str] | None = None
) -> dict[str, int]:
    """Updates every due submission from ``list_my_submissions`` (newest first, ≤ 4 pages) and then
    ``get_my_submission`` (≤ 6). Hand-sent, send-by-hand and missed posts are matched by their link."""
    conn = connection.load(deps.store, user_id)
    if not connection.signed_in(conn):
        return {"due": 0}
    rows = [s for s in deps.store.query_all(db.user_pk(user_id), db.CRSUB_PREFIX) if s.get("type") == "crsub"]
    due = [
        s
        for s in rows
        if s.get("state") in SUB_DUE_STATES
        and ((only is not None and s.get("postId") in only) or (only is None and _sub_due(s, now)))
    ]
    if not due:
        return {"due": 0}
    by_id = {str(s["submissionId"]): s for s in due if s.get("submissionId")}
    by_link = {links.normalize_post_url(s.get("url")): s for s in due if not s.get("submissionId") and s.get("url")}
    seen: set[str] = set()
    client = deps.mcp(user_id)
    cursor: str | None = None
    for _ in range(config.SUBMISSION_PAGES):
        if not budget_left() or (not set(by_id) - seen and not by_link):
            break
        args: Item = {"limit": config.PAGE_LIMIT}
        if cursor:
            args["cursor"] = cursor
        page = client.call("list_my_submissions", args)
        for row in page.get("data") or []:
            if not isinstance(row, Mapping):
                continue
            sub_id = str(row.get("id") or "")
            if sub_id in by_id:
                _apply(deps, by_id[sub_id], row, now)
                seen.add(sub_id)
                continue
            post = obj(row.get("post"))
            found = by_link.pop(links.normalize_post_url(post.get("url")), None)
            if found is not None:
                _apply(deps, found, row, now, adopted=True)
        cursor = page.get("next_cursor") if isinstance(page.get("next_cursor"), str) else None
        if not page.get("has_more") or not cursor:
            break
    gets = 0
    for sub_id, sub in by_id.items():
        if sub_id in seen or gets >= config.SUBMISSION_GETS or not budget_left():
            continue
        gets += 1
        try:
            row = client.call("get_my_submission", {"id": sub_id})
        except CrError as e:
            if e.code == "resource_missing":
                deps.store.update(sub["pk"], sub["sk"], {"removed": True, "updatedAt": iso(now)})
                continue
            raise
        _apply(deps, sub, row, now)
        seen.add(sub_id)
    for sub in due:
        if str(sub.get("submissionId") or "") not in seen:
            deps.store.update(sub["pk"], sub["sk"], {"nextCheckAt": iso(now + _cadence(sub, now))})
    return {"due": len(due), "seen": len(seen)}


def _apply(
    deps: CrDeps, sub: Mapping[str, Any], row: Mapping[str, Any], now: datetime, *, adopted: bool = False
) -> None:
    status = str(row.get("status") or "pending")
    post = obj(row.get("post"))
    fields: Item = {"crStatus": status, "updatedAt": iso(now)}
    if row.get("id"):
        fields["submissionId"] = str(row["id"])
    fields["flagged"] = bool(row.get("flagged"))
    fields["removed"] = bool(row.get("deleted"))
    fields["postGone"] = post.get("status") == "deleted"
    if isinstance(post.get("views"), int):
        fields["views"] = post["views"]
        fields["viewsAt"] = iso(now)
    if row.get("reviewed_at"):
        fields["reviewedAt"] = str(row["reviewed_at"])
    state = {"approved": "approved", "rejected": "rejected"}.get(status, "sent")
    if sub.get("state") == "sent_by_hand" and state == "sent" and not adopted and not sub.get("submissionId"):
        state = "sent_by_hand"
    fields["state"] = state
    if not sub.get("sentAt"):
        fields["sentAt"] = iso(now)
    reason = dict(sub.get("reason") or {}) if isinstance(sub.get("reason"), Mapping) else {}
    comment = row.get("review_comment")
    if state == "rejected":
        reason = {
            "code": "refused",
            "text": "The brand said no.",
            **({"brandSaid": str(comment)[:300]} if comment else {}),
        }
        fields["reason"] = reason
    remove = [] if state == "rejected" else ["reason"]
    updated = {**sub, **fields}
    fields["nextCheckAt"] = iso(now + _cadence(updated, now))
    deps.store.update(sub["pk"], sub["sk"], fields, remove=remove)


def check_clip(deps: CrDeps, user_id: str, post_ids: list[str], now: datetime) -> dict[str, int]:
    """The clip page's Check now: step 5 for this clip's posts, now."""
    return submissions(deps, user_id, now, lambda: True, only=set(post_ids))


def mark_proof_done(deps: CrDeps, user_id: str, post_id: str, now: datetime) -> Item:
    sub = deps.store.get(*sub_key(user_id, post_id)) or {}
    proof = dict(sub.get("proof") or {})
    proof["doneAt"] = iso(now)
    return deps.store.update(*sub_key(user_id, post_id), {"proof": proof, "updatedAt": iso(now)})
