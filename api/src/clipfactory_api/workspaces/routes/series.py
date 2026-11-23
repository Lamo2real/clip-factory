"""Series routes (docs/CONTRACTS.md §45.43): folders of story videos and their story so far.

Every route reads the workspace first (``core._ctx``: another owner's workspace is a 404, Lamo Clips a 409), builds
keys from the JWT's ``sub`` and the path's workspace id only, and checks each item again with ``guard.owned``. A series
never deletes a video: deleting one moves its ideas and videos to No series. The story so far is written by the
``series_recap`` task in Lamo Stories' own runtime, started best effort after an approval (``after_approve``); the API
runs no model.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from typing import Any

from ... import db, validate
from ...app import App
from ...errors import ApiError, bad_request, conflict, not_found
from ...http import Request, Response, Route, no_content, ok, route
from ...ids import is_ulid, ulid
from ...log import log
from ...workspaces import characters, jobs, tasks
from ...workspaces import series as rules
from ...workspaces import types as ws
from ...workspaces.expr import Update
from . import core

Item = dict[str, Any]
Ctx = core.Ctx


# --- reads ----------------------------------------------------------------------------------------------------


def _series_id(req: Request) -> str:
    value = req.params["seriesId"]
    if not is_ulid(value):
        raise not_found(rules.NO_SERIES)
    return value


def find(ctx: Ctx, series_id: Any) -> Item | None:
    """This workspace's series, or None (a missing, foreign or malformed id)."""
    if not isinstance(series_id, str) or not is_ulid(series_id):
        return None
    return ctx.owned(ctx.store.get(ctx.pk, rules.series_sk(series_id)), ws.TYPE_SERIES)


def _get_series(ctx: Ctx, series_id: str) -> Item:
    found = find(ctx, series_id)
    if found is None:
        raise not_found(rules.NO_SERIES)
    return found


def all_series(ctx: Ctx) -> list[Item]:
    return core._all(ctx, ws.SERIES_SK, ws.TYPE_SERIES, newest_first=True)


def known_ids(ctx: Ctx) -> set[str]:
    return {str(s["seriesId"]) for s in all_series(ctx)}


def _tasks(ctx: Ctx, items: list[Item]) -> dict[str, Item]:
    ids = [str(i["recapTaskId"]) for i in items if isinstance(i.get("recapTaskId"), str) and is_ulid(i["recapTaskId"])]
    if not ids:
        return {}
    found = ctx.store.batch_get([(ctx.pk, tasks.task_sk(t)) for t in ids])
    return {str(t["taskId"]): t for t in (ctx.owned(f, ws.TYPE_TASK) for f in found) if t is not None}


def _shown(ctx: Ctx, items: list[Item], *, settle: bool = False) -> list[Item]:
    """The public ``Series`` of each item: one STORY#, one IDEA# and one CHAR# query for all of them."""
    if not items:
        return []
    stories = core._all(ctx, ws.STORY_SK, ws.TYPE_STORY)
    ideas = core._all(ctx, ws.IDEA_SK, ws.TYPE_IDEA)
    cast = {str(c["characterId"]): c for c in core._all(ctx, ws.CHAR_SK, ws.TYPE_CHARACTER)}
    found_tasks = _tasks(ctx, items)
    out = []
    for item in items:
        task = found_tasks.get(str(item.get("recapTaskId") or ""))
        if settle and task is not None:
            task = jobs.settle_task(ctx.store, task, ctx.now, stop=ctx.stop()) or task
        out.append(
            rules.public_series(
                item,
                stories=stories,
                ideas=ideas,
                characters=cast,
                recap_task=task,
                presign=ctx.presign,
                user_id=ctx.user_id,
            )
        )
    return out


def _one(ctx: Ctx, item: Item, *, settle: bool = False) -> Item:
    return _shown(ctx, [item], settle=settle)[0]


def _check_cast(ctx: Ctx, ids: list[str]) -> None:
    """Each character is this workspace's (400 otherwise), then the cast rule: one car at most, with someone to drive."""
    try:
        cast = core._check_characters(ctx, ids)
    except ApiError as e:
        raise bad_request(e.message, "castIds") from e
    problem = characters.cast_problem(cast)
    if problem:
        raise bad_request(problem, "castIds")


# --- the recap (best effort after an approval, or the owner's "Write it") ---------------------------------------


def _start_recap(ctx: Ctx, series: Mapping[str, Any], story_id: str) -> Item:
    """Writes a ``series_recap`` task, keeps its id on the series (no version bump: the task writes under the version
    it reads) and asks the runtime to do it. A refused start is a failed task, which the series page shows."""
    task = tasks.new_task(
        ctx.user_id,
        ctx.ws_id,
        kind="series_recap",
        task_input={"seriesId": str(series["seriesId"]), "storyId": story_id},
        override=None,
        now=ctx.now,
    )
    mark = Update(ctx.pk, str(series["sk"]), sets={"recapTaskId": task["taskId"]})
    mark.equals("userId", ctx.user_id).equals("workspaceId", ctx.ws_id).run(ctx.store)
    return tasks.start(ctx.store, ctx.deps.agent, task, ctx.now, started=ctx.req.started, stop=ctx.stop())


def after_approve(ctx: Ctx, story: Mapping[str, Any]) -> None:
    """After an approval of a story filed in a series: its recap starts, but only while the series exists. Never
    raises (an approval never fails because of it)."""
    try:
        series = find(ctx, story.get("seriesId"))
        if series is not None:
            _start_recap(ctx, series, str(story["storyId"]))
    except Exception as e:
        log("warning", "stories.series_recap_not_started", storyId=story.get("storyId"), error=type(e).__name__)


def forget_story(ctx: Ctx, series_id: Any, story_id: str) -> None:
    """Drops a story's summary from a series (a story moved out or deleted). Best effort, never raises."""
    try:
        series = find(ctx, series_id)
        if series is None:
            return
        kept = rules.without_summary(series, story_id)
        if kept is None:
            return
        update = Update(ctx.pk, str(series["sk"]), sets={"summaries": kept, "updatedAt": ctx.at()})
        update.bump().equals("version", series.get("version")).equals("userId", ctx.user_id).run(ctx.store)
    except Exception as e:
        log("warning", "stories.series_forget_failed", storyId=story_id, error=type(e).__name__)


# --- routes ---------------------------------------------------------------------------------------------------


def list_series(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    return ok({"series": _shown(ctx, all_series(ctx))})


def create_series(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    fields = rules.series_input(req.json())
    existing = all_series(ctx)
    if len(existing) >= rules.MAX_SERIES:
        raise conflict(rules.TOO_MANY)
    taken = rules.name_taken(existing, fields["name"])
    if taken:
        raise conflict(rules.taken_sentence(taken), "name")
    _check_cast(ctx, fields["castIds"])
    item = rules.new_item(ctx.user_id, ctx.ws_id, ulid(), fields, ctx.at())
    ctx.store.put(item, if_absent=True)
    return ok({"series": _one(ctx, item)}, 201)


def get_series(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    return ok({"series": _one(ctx, _get_series(ctx, _series_id(req)), settle=True)})


def patch_series(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    current = _get_series(ctx, _series_id(req))
    version, changes = rules.patch_input(req.json())
    if int(current.get("version") or 1) != version:
        raise conflict(rules.CHANGED)
    if "name" in changes:
        taken = rules.name_taken(all_series(ctx), changes["name"], except_id=str(current["seriesId"]))
        if taken:
            raise conflict(rules.taken_sentence(taken), "name")
    if "castIds" in changes:
        _check_cast(ctx, changes["castIds"])
    chosen = changes.get("cover")
    if chosen and "storyId" in chosen:
        story = ctx.owned(ctx.store.get(ctx.pk, f"{ws.STORY_SK}{chosen['storyId']}"), ws.TYPE_STORY)
        if story is None or story.get("seriesId") != current["seriesId"]:
            raise bad_request("Pick a cover from this series' videos.", "cover")
    elif chosen and "characterId" in chosen:
        core._check_characters(ctx, [chosen["characterId"]])
    sets: Item = {**changes, "updatedAt": ctx.at()}
    if "storySoFar" in changes:
        sets.update({"storySoFarBy": "owner" if changes["storySoFar"] else None, "storySoFarAt": ctx.at()})
    update = Update(ctx.pk, str(current["sk"]), sets=sets).bump()
    try:
        item = update.equals("version", version).equals("userId", ctx.user_id).run(ctx.store)
    except db.ConditionFailed as e:
        if find(ctx, current["seriesId"]) is None:
            raise not_found(rules.NO_SERIES) from e
        raise conflict(rules.CHANGED) from e
    return ok({"series": _one(ctx, item)})


def _unfile(ctx: Ctx, item: Mapping[str, Any], series_id: str, *, story: bool) -> None:
    update = Update(ctx.pk, str(item["sk"]), sets={"updatedAt": ctx.at()}, removes=["seriesId"])
    if story:
        update.bump()  # every STORY# write adds 1 to its version (§45.3)
    with contextlib.suppress(db.ConditionFailed):  # moved or deleted meanwhile
        update.equals("seriesId", series_id).equals("userId", ctx.user_id).run(ctx.store)


def delete_series(app: App, req: Request) -> Response:
    """Deletes the folder only: its ideas and videos stay, under No series (each one best effort)."""
    ctx = core._ctx(app, req)
    series = _get_series(ctx, _series_id(req))
    series_id = str(series["seriesId"])
    ctx.store.delete(ctx.pk, str(series["sk"]))
    for prefix, kind in ((ws.IDEA_SK, ws.TYPE_IDEA), (ws.STORY_SK, ws.TYPE_STORY)):
        for item in core._all(ctx, prefix, kind):
            if item.get("seriesId") != series_id:
                continue
            try:
                _unfile(ctx, item, series_id, story=kind == ws.TYPE_STORY)
            except Exception as e:
                log("warning", "stories.series_unfile_failed", seriesId=series_id, error=type(e).__name__)
    return no_content()


def recap_episode(app: App, req: Request) -> Response:
    """The owner's "Write it" (or "Write it again"): the recap task for one episode: ``202 { task }``."""
    ctx = core._ctx(app, req)
    series = _get_series(ctx, _series_id(req))
    body = req.json()
    validate.only_keys(body, {"storyId"})
    story_id = body.get("storyId")
    if not isinstance(story_id, str) or not is_ulid(story_id):
        raise not_found(core.NO_STORY)
    story = core._get(ctx, ws.STORY_SK, story_id, ws.TYPE_STORY, core.NO_STORY)
    if story.get("seriesId") != series["seriesId"] or story.get("status") not in rules.EPISODE_STATUSES:
        raise conflict(rules.NOT_AN_EPISODE, "storyId")
    tasks.refuse_if_off(ctx.store, ctx.user_id, ctx.ws_id, "series_recap")
    try:
        started = _start_recap(ctx, series, story_id)
    except db.ConditionFailed as e:  # deleted meanwhile
        raise not_found(rules.NO_SERIES) from e
    return ok({"task": tasks.public_task(started)}, 202)


def move_story(app: App, req: Request) -> Response:
    """``PUT …/stories/{storyId}/series { seriesId | null }`` in any status: only ``seriesId`` changes (and the
    version, as on every STORY# write). Moved in once approved, it gets a recap there; moved out, its summary goes."""
    ctx = core._ctx(app, req)
    story = core._story(ctx)
    body = req.json()
    validate.only_keys(body, {"seriesId"})
    if "seriesId" not in body:
        raise bad_request("seriesId is required (null for No series).", "seriesId")
    target_id = body["seriesId"]
    target = None
    if target_id is not None:
        if not isinstance(target_id, str):
            raise bad_request("seriesId is not valid.", "seriesId")
        target = _get_series(ctx, target_id) if is_ulid(target_id) else None
        if target is None:
            raise not_found(rules.NO_SERIES)
    before = story.get("seriesId")
    if before == target_id:
        return ok({"story": core._public_story(ctx, story)})
    update = Update(ctx.pk, str(story["sk"]), sets={"updatedAt": ctx.at()}).bump()
    if target_id is None:
        update.removes.append("seriesId")
    else:
        update.sets["seriesId"] = target_id
    try:
        item = update.equals("userId", ctx.user_id).equals("workspaceId", ctx.ws_id).run(ctx.store)
    except db.ConditionFailed as e:
        raise not_found(core.NO_STORY) from e
    if before:
        forget_story(ctx, before, str(story["storyId"]))
    if target is not None and item.get("status") in rules.EPISODE_STATUSES:
        after_approve(ctx, item)
    return ok({"story": core._public_story(ctx, item)})


W = core.W

ROUTES: list[Route] = [
    route("GET", W + "/series", list_series),
    route("POST", W + "/series", create_series),
    route("GET", W + "/series/{seriesId}", get_series),
    route("PATCH", W + "/series/{seriesId}", patch_series),
    route("DELETE", W + "/series/{seriesId}", delete_series),
    route("POST", W + "/series/{seriesId}/recap", recap_episode),
    route("PUT", W + "/stories/{storyId}/series", move_story),
]
