"""/v1/lessons: Settings › Clip making › What it learned (docs/CONTRACTS.md §16.12).

* GET: every creator lesson the daily run wrote (deleted ones left out), and per creator how many posted clips were
  measured and how many more are needed.
* PATCH ``{"status": "off" | "on"}``: turn a lesson off (the clip picker stops getting it) or back on. A lesson that
  is too old is returned unchanged; 409 when the daily run kept changing it at the same moment.
* DELETE: removes the lesson; a small tombstone keeps the same lesson from being written again.
"""

from __future__ import annotations

from .. import db, lessons
from ..app import App
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..validate import obj, only_keys

NOT_FOUND = "We could not find that lesson. Reload the page."
BUSY = "That lesson just changed. Try again."
MAX_CLIPS = 100


def _lesson_id(req: Request) -> str:
    value = req.params["lessonId"]
    if not lessons.is_lesson_id(value):
        raise not_found(NOT_FOUND)
    return value


def list_lessons(app: App, req: Request) -> Response:
    now = app.clock()
    pk = db.user_pk(req.user_id)
    items = [i for i in lessons.all_lessons(app.store, req.user_id) if i.get("status") != "deleted"]
    items.sort(key=lambda i: (str(i.get("creatorKey")), str(i.get("platform")), str(i.get("createdAt"))))
    cited = list(dict.fromkeys(str(c) for i in items for c in i.get("clipIds") or []))[:MAX_CLIPS]
    found = {c.get("clipId"): c for c in app.store.batch_get((pk, db.clip_sk(c)) for c in cited)}
    out = []
    for item in items:
        public = lessons.public_lesson(item, now)
        public["clips"] = [
            {"clipId": c, "hook": str(found[c].get("hook") or "")}
            for c in item.get("clipIds") or []
            if c in found and found[c].get("status") != "declined"
        ]
        out.append(public)
    state = app.store.get(pk, db.LEARN_STATE_SK) or {}
    body = {"lessons": out, "creators": list(state.get("creators") or [])}
    if state.get("checkedAt"):
        body["checkedAt"] = state["checkedAt"]
    return ok(body)


def patch_lesson(app: App, req: Request) -> Response:
    lesson = _lesson_id(req)
    body = obj(req.json())
    only_keys(body, ("status",))
    to = body.get("status")
    if to not in lessons.OWNER_STATUSES:
        raise bad_request('status must be "off" or "on".', "status")
    try:
        item = lessons.turn(app.store, req.user_id, lesson, str(to), app.clock())
    except db.ConditionFailed:
        raise conflict(BUSY) from None  # the daily run kept changing it: nothing was written
    if item is None:
        raise not_found(NOT_FOUND)
    return ok({"lesson": lessons.public_lesson(item, app.clock())})


def delete_lesson(app: App, req: Request) -> Response:
    if not lessons.delete(app.store, req.user_id, _lesson_id(req), app.clock()):
        raise not_found(NOT_FOUND)
    return no_content()
