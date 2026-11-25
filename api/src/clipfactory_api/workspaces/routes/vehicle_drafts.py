"""Vehicle draft routes: a vehicle being designed with AI keeps running when the owner leaves the screen.

A draft owns one ``character_design`` task and mirrors it. Every read settles a ``designing`` draft from its task, so
the state is right even when no screen is open. Only one design runs per draft: starting is a conditional write that
claims the task id before the task is made, so a second tap or a lost race is a 409 and never a second task. Nothing is
charged or posted, and a finished vehicle is saved only by the owner (``POST /characters``), after which the web
deletes the draft. Same guards as every route: ``core._ctx`` (another owner's workspace is a 404) and ``ctx.owned``.
"""

from __future__ import annotations

import dataclasses
from typing import Any

from ... import db, validate
from ...app import App
from ...errors import bad_request, conflict, not_found
from ...http import Request, Response, Route, no_content, ok, route
from ...ids import is_ulid, ulid
from ...workspaces import design, jobs, overrides, shapes, tasks
from ...workspaces import types as ws
from ...workspaces import vehicle_drafts as rules
from ...workspaces.expr import Update
from . import core

Item = dict[str, Any]
Ctx = core.Ctx


def _draft_id(req: Request) -> str:
    value = req.params["draftId"]
    if not is_ulid(value):
        raise not_found(rules.NO_DRAFT)
    return value


def find(ctx: Ctx, draft_id: str) -> Item | None:
    return ctx.owned(ctx.store.get(ctx.pk, rules.draft_sk(draft_id)), ws.TYPE_VEHICLE_DRAFT)


def _get_draft(ctx: Ctx, draft_id: str) -> Item:
    found = find(ctx, draft_id)
    if found is None:
        raise not_found(rules.NO_DRAFT)
    return found


def settle(ctx: Ctx, draft: Item) -> Item | None:
    """The draft as it really is: a ``designing`` one follows its task. Idempotent: the write is conditional on the
    draft still designing that same task, so concurrent readers agree and the loser just reads the winner's result.
    None when the draft was deleted meanwhile."""
    if draft.get("status") != "designing":
        return draft
    task = None
    if draft.get("taskId"):
        task = ctx.owned(ctx.store.get(ctx.pk, tasks.task_sk(str(draft["taskId"]))), ws.TYPE_TASK)
    settled = jobs.settle_task(ctx.store, task, ctx.now, stop=ctx.stop()) if task is not None else None
    sets = rules.settle_sets(draft, settled, ctx.now)
    if sets is None:
        return draft
    update = Update(ctx.pk, str(draft["sk"]), sets=sets).bump()
    update.equals("status", "designing").equals("taskId", draft.get("taskId")).equals("userId", ctx.user_id)
    try:
        return update.run(ctx.store)
    except db.ConditionFailed:
        return find(ctx, str(draft["draftId"]))


def all_drafts(ctx: Ctx) -> list[Item]:
    """This workspace's vehicle drafts, newest first, each settled."""
    # a strongly consistent read: the 3-designing and 20-draft caps count what this returns
    found = ctx.store.query_all(ctx.pk, ws.VEHICLE_DRAFT_SK, consistent=True)
    items = [i for i in (ctx.owned(x, ws.TYPE_VEHICLE_DRAFT) for x in found) if i is not None]
    items.sort(key=lambda d: (str(d.get("createdAt") or ""), str(d.get("draftId"))), reverse=True)
    return [d for d in (settle(ctx, i) for i in items) if d is not None]


def _public(ctx: Ctx, draft: Item) -> dict[str, Any]:
    return shapes.public_vehicle_draft(draft, ctx.presign, ctx.user_id)


def _check_start(ctx: Ctx, drafts: list[Item], override: Any) -> None:
    """The agent is on and the model usable (as ``core._task_reply`` checks), and fewer than 3 are designing."""
    tasks.refuse_if_off(ctx.store, ctx.user_id, ctx.ws_id, "character_design")
    core._refuse_unusable(ctx, project=None, request=override, field="override", kinds=("character_design",))
    if sum(1 for d in drafts if d.get("status") == "designing") >= rules.MAX_DESIGNING:
        raise conflict(rules.TOO_MANY_DESIGNING)


def _run(ctx: Ctx, draft: Item, ask: design.DesignAsk, assets: list[Item]) -> Item:
    """Makes and starts the task the draft already claimed, then settles (a refused start is a failed task)."""
    task_input = design.task_input(ask, assets, None)
    task = tasks.new_task(
        ctx.user_id,
        ctx.ws_id,
        kind="character_design",
        task_input=task_input,
        override=ask.override,
        now=ctx.now,
        task_id=str(draft["taskId"]),
    )
    tasks.start(ctx.store, ctx.deps.agent, task, ctx.now, started=ctx.req.started, stop=ctx.stop())
    settled = settle(ctx, draft)
    if settled is None:
        raise not_found(rules.NO_DRAFT)
    return settled


def _ask(design_body: Any) -> design.DesignAsk:
    body = validate.obj(design_body, "design")
    if body.get("kind") not in (None, "car"):
        raise bad_request(rules.NOT_CAR, "design.kind")
    if body.get("characterId") is not None:
        raise bad_request(rules.NO_CHARACTER, "design.characterId")
    return dataclasses.replace(design.parse(body), kind="car")


def list_drafts(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    return ok({"items": [_public(ctx, d) for d in all_drafts(ctx)]})


def create_draft(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    body = req.json()
    validate.only_keys(body, {"design", "name"})
    ask = _ask(body.get("design"))
    name = validate.string(body, "name", required=False, max_len=rules.NAME_MAX) or ""
    assets = [core._design_picture(ctx, a) for a in ask.asset_ids]
    design.task_input(ask, assets, None)  # a photo or words are needed; nothing is written yet
    drafts = all_drafts(ctx)
    if len(drafts) >= rules.MAX_DRAFTS:
        raise conflict(rules.TOO_MANY)
    _check_start(ctx, drafts, ask.override)
    item = rules.new_item(ctx, draft_id=ulid(), task_id=ulid(), name=name, ask=ask, assets=assets)
    ctx.store.put(item, if_absent=True)
    return ok(_public(ctx, _run(ctx, item, ask, assets)), 201)


def get_draft(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    settled = settle(ctx, _get_draft(ctx, _draft_id(req)))
    if settled is None:
        raise not_found(rules.NO_DRAFT)
    return ok(_public(ctx, settled))


def redesign_draft(app: App, req: Request) -> Response:
    """Try again, Design it again, or Make more: runs the stored design once more. 409 while it is still designing."""
    ctx = core._ctx(app, req)
    draft_id = _draft_id(req)
    body = req.json()
    validate.only_keys(body, {"more", "override"})
    more = validate.boolean(body["more"], "more") if body.get("more") is not None else False
    override = overrides.model_override(body.get("override"))
    draft = settle(ctx, _get_draft(ctx, draft_id))
    if draft is None:
        raise not_found(rules.NO_DRAFT)
    if draft.get("status") == "designing":
        raise conflict(rules.STILL_DESIGNING)
    stored = dict(draft.get("design") or {})
    if override:
        stored["override"] = override
    ask = _ask(stored)
    options = [o for o in draft.get("options") or [] if isinstance(o, dict)]
    if more:
        if len(options) >= rules.MAX_OPTIONS:
            raise conflict(rules.FULL)
        ask = dataclasses.replace(ask, count=rules.more_count(options), avoid=rules.avoid_of(options))
    assets = [core._design_picture(ctx, a) for a in ask.asset_ids]
    design.task_input(ask, assets, None)
    _check_start(ctx, all_drafts(ctx), ask.override)
    task_id = ulid()
    sets = rules.claim_sets(task_id=task_id, at=ctx.at(), more=more, design=stored)
    update = Update(ctx.pk, str(draft["sk"]), sets=sets, removes=["message", "finishedAt", "model", "effort"]).bump()
    update.one_of("status", ["ready", "failed"]).equals("version", int(draft.get("version") or 1))
    update.equals("userId", ctx.user_id)
    try:
        claimed = update.run(ctx.store)
    except db.ConditionFailed as e:
        if find(ctx, draft_id) is None:
            raise not_found(rules.NO_DRAFT) from e
        raise conflict(rules.STILL_DESIGNING) from e
    return ok(_public(ctx, _run(ctx, claimed, ask, assets)), 202)


def delete_draft(app: App, req: Request) -> Response:
    """204 whether or not it was still there. Its task is left alone."""
    ctx = core._ctx(app, req)
    found = find(ctx, _draft_id(req))
    if found is not None:
        ctx.store.delete(ctx.pk, str(found["sk"]))
    return no_content()


W = core.W

ROUTES: list[Route] = [
    route("GET", W + "/vehicle-drafts", list_drafts),
    route("POST", W + "/vehicle-drafts", create_draft),
    route("GET", W + "/vehicle-drafts/{draftId}", get_draft),
    route("POST", W + "/vehicle-drafts/{draftId}/design", redesign_draft),
    route("DELETE", W + "/vehicle-drafts/{draftId}", delete_draft),
]
