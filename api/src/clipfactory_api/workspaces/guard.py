"""Workspace ownership checks used by every ``/v1/workspaces`` route and by the story flow (CONTRACTS §45.3, §45.14).

Ownership is in the key: every key is built from the JWT's ``sub`` and the path's workspace id, so another user's
workspace id simply finds nothing (404). ``owned`` is the second, independent check on every item read.
SCAFFOLD (Phase 1): builders A and B use these; extend, never weaken.
"""

from __future__ import annotations

import contextlib
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso
from ..errors import ApiError, not_found
from . import types as ws

NOT_FOUND = "We could not find that workspace."
NOT_STORIES = "That is a Lamo Stories page. Switch to Lamo Stories first."


def clips_workspace() -> dict[str, Any]:
    """Lamo Clips as a workspace: built in, never stored, no configuration here (its settings stay in Settings)."""
    return {
        "workspaceId": ws.CLIPS,
        "workspaceName": ws.WORKSPACE_TYPES[ws.CLIPS].label,
        "workspaceType": ws.CLIPS,
        "builtin": True,
        "configuration": {},
        "version": 1,
    }


def find_workspace(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any] | None:
    """The workspace item (or the built-in Lamo Clips one), or None. Never raises for a malformed id."""
    if not isinstance(workspace_id, str) or not ws.WORKSPACE_ID.match(workspace_id):
        return None
    if workspace_id == ws.CLIPS:
        return clips_workspace()
    item = store.get(ws.registry_pk(user_id), ws.workspace_sk(workspace_id))
    if not item or not owned(item, user_id, workspace_id):
        return None
    return item


def default_stories_config() -> dict[str, Any]:
    """StoriesConfig defaults (CONTRACTS §45.6), from the one file ``stories/config/workspace-defaults.json``."""
    from .config import workspace_defaults

    return workspace_defaults()


def ensure_first_stories(store: db.Store, user_id: str, now: datetime) -> dict[str, Any]:
    """Creates the first Lamo Stories workspace (``stories``) once: a conditional put, so two calls at once make one."""
    item = {
        "pk": ws.registry_pk(user_id),
        "sk": ws.workspace_sk(ws.FIRST_STORIES_ID),
        "type": ws.TYPE_WORKSPACE,
        "userId": user_id,
        "workspaceId": ws.FIRST_STORIES_ID,
        "workspaceName": ws.FIRST_STORIES_NAME,
        "workspaceType": ws.STORIES,
        "configuration": default_stories_config(),
        "version": 1,
        "createdAt": iso(now),
        "updatedAt": iso(now),
    }
    with contextlib.suppress(db.ConditionFailed):  # someone else made it a moment ago: use theirs
        store.put(item, if_absent=True)
    found = store.get(ws.registry_pk(user_id), ws.workspace_sk(ws.FIRST_STORIES_ID))
    return found or item


def require_workspace(
    store: db.Store, user_id: str, workspace_id: str, *, stories: bool = True, now: datetime | None = None
) -> dict[str, Any]:
    """The caller's workspace, else 404; with ``stories`` (the routes marked **S**), a Lamo Clips id is a 409.
    The first Lamo Stories workspace (``stories``) is made on first use when ``now`` is given (§45.3).

    It also binds this request's models to this workspace: the models the owner added here (``MODELDEF#``) join the
    resolver's list for this request only, and nothing of another workspace's ever does (§45.34)."""
    from . import ai_resolve, model_defs

    ai_resolve.unbind()
    item = find_workspace(store, user_id, workspace_id)
    if item is None and workspace_id == ws.FIRST_STORIES_ID and now is not None:
        item = ensure_first_stories(store, user_id, now)
    if item is None:
        raise not_found(NOT_FOUND)
    if stories and item.get("workspaceType") != ws.STORIES:
        raise ApiError(409, "conflict", NOT_STORIES)
    if item.get("workspaceType") == ws.STORIES:
        model_defs.bind(store, user_id, str(item["workspaceId"]))
    return item


def owned(item: dict[str, Any] | None, user_id: str, workspace_id: str) -> bool:
    """True only when the item says it belongs to this user and this workspace (both attributes, exactly)."""
    if not item:
        return False
    return item.get("userId") == user_id and item.get("workspaceId") == workspace_id
