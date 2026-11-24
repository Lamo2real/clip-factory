"""Video draft routes (docs/CONTRACTS.md §45.47): the owner's saved "Make a new video" forms.

Every route reads the workspace first (``core._ctx``: another owner's workspace is a 404, Lamo Clips a 409), builds
keys from the JWT's ``sub`` and the path's workspace id only, and checks each item again with ``guard.owned``. A
draft makes nothing and starts nothing: ``POST /stories`` with its ``draftId`` makes the video and deletes the draft
in the same write.
"""

from __future__ import annotations

from typing import Any

from ... import db, validate
from ...app import App
from ...errors import conflict, not_found
from ...http import Request, Response, Route, no_content, ok, route
from ...ids import is_ulid, ulid
from ...workspaces import shapes
from ...workspaces import types as ws
from ...workspaces import video_drafts as rules
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
    return ctx.owned(ctx.store.get(ctx.pk, rules.draft_sk(draft_id)), ws.TYPE_VIDEO_DRAFT)


def _get_draft(ctx: Ctx, draft_id: str) -> Item:
    found = find(ctx, draft_id)
    if found is None:
        raise not_found(rules.NO_DRAFT)
    return found


def all_drafts(ctx: Ctx) -> list[Item]:
    """This workspace's drafts, most recently changed first."""
    items = core._all(ctx, ws.VIDEO_DRAFT_SK, ws.TYPE_VIDEO_DRAFT)
    return sorted(items, key=lambda d: (str(d.get("updatedAt") or ""), str(d.get("draftId"))), reverse=True)


def _name(ctx: Ctx, form: Item) -> str:
    """The title, else this workspace's idea's title (a gone idea gives none), else "Untitled video"."""
    idea_title = None
    if not str(form.get("title") or "").strip() and form.get("ideaId"):
        idea = ctx.owned(ctx.store.get(ctx.pk, f"{ws.IDEA_SK}{form['ideaId']}"), ws.TYPE_IDEA)
        idea_title = str((idea or {}).get("title") or "") or None
    return rules.name_of(form, idea_title)


def list_drafts(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    return ok({"items": [shapes.public_video_draft(d) for d in all_drafts(ctx)]})


def create_draft(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    body = req.json()
    validate.only_keys(body, {"form"})
    form = rules.draft_input(body.get("form"))
    if len(core._all(ctx, ws.VIDEO_DRAFT_SK, ws.TYPE_VIDEO_DRAFT)) >= rules.MAX_DRAFTS:
        raise conflict(rules.TOO_MANY)
    item = rules.new_item(ctx, form, draft_id=ulid(), name=_name(ctx, form))
    ctx.store.put(item, if_absent=True)
    return ok(shapes.public_video_draft(item), 201)


def get_draft(app: App, req: Request) -> Response:
    ctx = core._ctx(app, req)
    return ok(shapes.public_video_draft(_get_draft(ctx, _draft_id(req))))


def save_draft(app: App, req: Request) -> Response:
    """``PUT { form, version }``: the whole form again (autosave). 409 when it changed meanwhile, 413 over 32 KB."""
    ctx = core._ctx(app, req)
    current = _get_draft(ctx, _draft_id(req))
    body = req.json()
    validate.only_keys(body, {"form", "version"})
    version = validate.integer(body.get("version"), "version", lo=1, hi=10**9)
    form = rules.draft_input(body.get("form"))
    if int(current.get("version") or 1) != version:
        raise conflict(rules.CHANGED)
    sets = {"form": rules.stored_form(form), "name": _name(ctx, form), "updatedAt": ctx.at()}
    update = Update(ctx.pk, str(current["sk"]), sets=sets).bump()
    try:
        item = update.equals("version", version).equals("userId", ctx.user_id).run(ctx.store)
    except db.ConditionFailed as e:
        if find(ctx, str(current["draftId"])) is None:
            raise not_found(rules.NO_DRAFT) from e
        raise conflict(rules.CHANGED) from e
    return ok(shapes.public_video_draft(item))


def delete_draft(app: App, req: Request) -> Response:
    """204 whether or not it was still there (a second tap, or a video made from it meanwhile)."""
    ctx = core._ctx(app, req)
    found = find(ctx, _draft_id(req))
    if found is not None:
        ctx.store.delete(ctx.pk, str(found["sk"]))
    return no_content()


W = core.W

ROUTES: list[Route] = [
    route("GET", W + "/video-drafts", list_drafts),
    route("POST", W + "/video-drafts", create_draft),
    route("GET", W + "/video-drafts/{draftId}", get_draft),
    route("PUT", W + "/video-drafts/{draftId}", save_draft),
    route("DELETE", W + "/video-drafts/{draftId}", delete_draft),
]
