"""/v1/weeks/{week} and /v1/weeks/{week}/best: Library › This week and the owner's weekly picks (§16.2).

Saving picks is one transaction (the WEEK item with ``revision + 1`` plus the ``best``/``bestWeek`` flag on each
clip that changed), then an async Invoke of ``cf-prod-learn``, which compares the picks with the rest of the week
and writes one "Best of week" learning for the clip-picking agent.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .. import db, weeks
from ..app import App
from ..async_invoke import InvokeError
from ..clock import iso
from ..errors import bad_request, conflict
from ..http import Request, Response, ok
from ..log import log

PICK_ERROR = "Pick clips from this week only."


def _bounds(req: Request, from_: Any, to: Any) -> tuple[str, datetime, datetime]:
    week = req.params["week"]
    if not isinstance(from_, str) or not isinstance(to, str):
        raise bad_request(weeks.BAD_WEEK)
    parsed = weeks.week_bounds_ok(week, from_, to)
    if parsed is None:
        raise bad_request(weeks.BAD_WEEK)
    return week, parsed[0], parsed[1]


def get_week(app: App, req: Request) -> Response:
    from_, to = req.query.get("from"), req.query.get("to")
    week, start, end = _bounds(req, from_, to)
    view = weeks.week_view(
        app.store, req.user_id, week, start=start, end=end, from_=str(from_), to=str(to), media=app.media
    )
    return ok({"week": view})


def put_best(app: App, req: Request) -> Response:
    body = req.json()
    extra = set(body) - {"from", "to", "clipIds"}
    if extra:
        raise bad_request(f"Unknown field: {sorted(extra)[0]}.")
    week, start, end = _bounds(req, body.get("from"), body.get("to"))
    from_, to = str(body["from"]), str(body["to"])
    raw = body.get("clipIds")
    if not isinstance(raw, list) or not all(isinstance(c, str) for c in raw):
        raise bad_request("clipIds must be a list of clip ids.")
    if len(set(raw)) != len(raw):
        raise bad_request("Each clip can only be picked once.")
    entries = {str(c["clipId"]): c for c, _, _ in weeks.week_entries(app.store, req.user_id, start, end)}
    item = weeks.get_week(app.store, req.user_id, week)
    old = [str(c) for c in (item or {}).get("clipIds") or []]
    # A stored pick whose clip left this week (kept on Sunday, posted on Monday: its anchor moved on) or was
    # removed. The owner cannot see it here any more, so it is quietly unpicked instead of blocking every save.
    stale = [c for c in old if c not in entries]
    raw = [c for c in raw if c not in stale]
    if len(raw) > weeks.MAX_PICKS:
        raise bad_request(f"Pick at most {weeks.MAX_PICKS} clips for one week.")
    if any(c not in entries for c in raw):
        raise bad_request(PICK_ERROR)
    if set(old) == set(raw):
        view = weeks.week_view(
            app.store, req.user_id, week, start=start, end=end, from_=from_, to=to, media=app.media, item=item
        )
        return ok({"week": view})
    revision = int((item or {}).get("revision") or 0) + 1
    now = iso(app.clock())
    pk = db.user_pk(req.user_id)
    updates, unpicked = _flag_updates(app, pk, week, picks=raw, old=old, stale=stale)
    new_item = _week_item(
        user_id=req.user_id,
        week=week,
        from_=from_,
        to=to,
        picks=raw,
        unpicked=unpicked,
        revision=revision,
        now=now,
        current=item,
    )
    if item is None:
        put = app.store.put_if(new_item, "attribute_not_exists(pk)")
    else:  # optimistic: the picks the owner saw are still the stored ones
        put = app.store.put_if(new_item, "#rev = :rev", names={"#rev": "revision"}, values={":rev": revision - 1})
    try:
        app.store.transact(raw_puts=[put], updates=updates)
    except db.ConditionFailed as e:
        raise conflict("Your picks changed in another window. Reload This week and try again.") from e
    try:
        if app.invoker is None:
            raise InvokeError("the learn function is not configured")
        app.invoker.learn_week(req.user_id, week, revision)
    except InvokeError as e:
        log("error", "weeks.learn_invoke_failed", week=week, error=str(e))
        try:
            new_item = app.store.update(
                pk, db.week_sk(week), {"learnState": "failed"}, expect_in={"revision": [revision]}
            )
        except db.ConditionFailed:
            new_item = weeks.get_week(app.store, req.user_id, week) or new_item
    log("info", "weeks.best_saved", week=week, picks=len(raw), revision=revision)
    view = weeks.week_view(
        app.store, req.user_id, week, start=start, end=end, from_=from_, to=to, media=app.media, item=new_item
    )
    return ok({"week": view}, status=202)


def _flag_updates(
    app: App, pk: str, week: str, *, picks: list[str], old: list[str], stale: list[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    """The Clip ``best``/``bestWeek`` updates of one save and the clip ids it unpicks. Only a stale pick that still
    says it is this week's best is cleared; one the owner starred again in its new week (``bestWeek`` moved on) or
    a removed clip is left alone."""
    newly = [c for c in picks if c not in old]
    unpicked = [c for c in old if c not in picks and c not in stale]
    stale_cleared = [c for c in stale if (app.store.get(pk, db.clip_sk(c)) or {}).get("bestWeek") == week]
    updates = [db.update_request(pk, db.clip_sk(c), {"best": True, "bestWeek": week}) for c in newly]
    updates += [db.update_request(pk, db.clip_sk(c), {"best": False}, remove=["bestWeek"]) for c in unpicked]
    updates += [
        db.update_request(pk, db.clip_sk(c), {"best": False}, remove=["bestWeek"], expect_in={"bestWeek": [week]})
        for c in stale_cleared
    ]
    return updates, [*unpicked, *stale_cleared]


def _week_item(
    *,
    user_id: str,
    week: str,
    from_: str,
    to: str,
    picks: list[str],
    unpicked: list[str],
    revision: int,
    now: str,
    current: dict[str, Any] | None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "pk": db.user_pk(user_id),
        "sk": db.week_sk(week),
        "type": "week",
        "userId": user_id,
        "week": week,
        "from": from_,
        "to": to,
        "clipIds": picks,
        "unpickedClipIds": unpicked,
        "savedAt": now,
        "learnState": "learning" if picks else "skipped",
        "revision": revision,
    }
    for keep in ("learningId", "learnedAt"):  # the learner reuses the learning id on a re-save
        if current and current.get(keep):
            item[keep] = current[keep]
    return item
