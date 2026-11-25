"""Vehicles being designed with AI (``VDESIGN#{draftId}``): the stored draft that owns a ``character_design`` task.

"Design with AI" already runs as a server-side task. What was missing was something stored that remembers it, so
leaving the screen kept nothing. A vehicle draft is that memory: it claims a task id, the task is made and started, and
every read settles the draft from its task (``designing`` -> ``ready`` or ``failed``) even when no screen is open.
Nothing is charged or posted here, and a finished design is never saved as a character by itself: the owner checks it
and saves it (``POST /characters``), and the web then deletes the draft.

Pure: the routes are in ``routes/vehicle_drafts.py``.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Final, Protocol

from ..clock import iso, parse
from ..errors import ApiError
from . import characters
from . import types as ws
from .design import MAX_AVOID, MAX_COUNT, DesignAsk
from .types import VEHICLE_DRAFT_SK

Item = dict[str, Any]

MAX_DRAFTS: Final = 20
MAX_DESIGNING: Final = 3
NAME_MAX: Final = 60
MAX_OPTIONS: Final = MAX_COUNT  # 4
MORE_COUNT: Final = 3
TOO_LONG: Final = timedelta(minutes=15)
START_GRACE: Final = timedelta(seconds=60)  # a draft claims its task id a moment before the task is written

TOO_MANY: Final = "You have 20 vehicle drafts. Delete one first."
TOO_MANY_DESIGNING: Final = "3 vehicles are being designed. Wait for one to finish."
STILL_DESIGNING: Final = "It is still designing. Wait for it."
NO_DRAFT: Final = "That vehicle draft is gone."
FULL: Final = "You have 4 designs already. Pick one."
NOT_CAR: Final = "A vehicle draft is for a vehicle only."
NO_CHARACTER: Final = "A vehicle draft makes a new vehicle, not a redesign."
STOPPED: Final = "The helper stopped. Tap Try again."
TOOK_TOO_LONG: Final = "It took too long. Tap Try again."
EMPTY: Final = "The helper made no vehicle. Tap Try again."


class DraftCtx(Protocol):
    @property
    def user_id(self) -> str: ...

    @property
    def ws_id(self) -> str: ...

    @property
    def pk(self) -> str: ...

    def at(self) -> str: ...


def draft_sk(draft_id: str) -> str:
    return f"{VEHICLE_DRAFT_SK}{draft_id}"


def stored_design(ask: DesignAsk) -> Item:
    """The checked request, as much as is needed to run it again (no characterId; never a null: the store drops them)."""
    out: Item = {"referenceAssetIds": list(ask.asset_ids)}
    if ask.description:
        out["description"] = ask.description
    if ask.sides is not None:
        out["referenceSides"] = list(ask.sides)
    if ask.vehicle:
        out["vehicle"] = ask.vehicle
    if ask.count is not None:
        out["count"] = ask.count
    if ask.override:
        out["override"] = dict(ask.override)
    return out


def photos_of(ask: DesignAsk, assets: list[Item]) -> list[Item]:
    """What the draft shows of its photos: ``{assetId, side, key}`` (the key never leaves the API)."""
    sides = ask.sides or ["outside"] * len(assets)
    return [
        {"assetId": str(a["assetId"]), "side": side, "key": str(a["key"])}
        for a, side in zip(assets, sides, strict=True)
    ]


def new_item(
    ctx: DraftCtx,
    *,
    draft_id: str,
    task_id: str,
    name: str,
    ask: DesignAsk,
    assets: list[Item],
    model: str | None = None,
) -> Item:
    at = ctx.at()
    return {
        "pk": ctx.pk,
        "sk": draft_sk(draft_id),
        "type": ws.TYPE_VEHICLE_DRAFT,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "draftId": draft_id,
        "name": name,
        "vehicle": ask.vehicle or "car",
        "design": stored_design(ask),
        "photos": photos_of(ask, assets),
        "status": "designing",
        "taskId": task_id,
        "more": False,
        "options": [],
        "startedAt": at,
        "version": 1,
        "createdAt": at,
        "updatedAt": at,
    }


def claim_sets(*, task_id: str, at: str, more: bool, design: Mapping[str, Any]) -> Item:
    """What a redesign writes (conditional on ``status`` being ready or failed and the version read)."""
    return {
        "status": "designing",
        "taskId": task_id,
        "more": more,
        "startedAt": at,
        "updatedAt": at,
        "design": dict(design),
    }


def cars_of(result: Any) -> list[Item]:
    """The cars of a finished design task: ``result.characters``, else ``result.character``, only kind car (the same
    pick the web's ``designsOf`` makes)."""
    if not isinstance(result, Mapping):
        return []
    many = result.get("characters")
    raw = many if isinstance(many, list) and many else [result.get("character")]
    return [dict(c) for c in raw if isinstance(c, Mapping) and c.get("kind") == "car"]


def avoid_of(options: list[Any]) -> list[Item]:
    """The last 8 options' looks, for "Make more" to avoid; a look that does not check is left out."""
    out: list[Item] = []
    for option in options[-MAX_AVOID:]:
        with contextlib.suppress(ApiError):  # a loose answer from the agent is simply not avoided
            out.append(characters.car_look(option.get("car")))
    return out


def more_count(options: list[Any]) -> int:
    return min(MORE_COUNT, MAX_OPTIONS - len(options))


def settle_sets(draft: Mapping[str, Any], task: Mapping[str, Any] | None, now: datetime) -> Item | None:
    """What a ``designing`` draft becomes given its (already settled) task: None while it is still going."""
    at = iso(now)
    started = parse(draft.get("startedAt"))
    if task is None:
        if started is not None and now - started <= START_GRACE:
            return None
        return _failed(at, STOPPED)
    status = task.get("status")
    if status == "failed":
        return _failed(at, str(task.get("error") or STOPPED), task)
    if status == "done":
        cars = cars_of(task.get("result"))
        if not cars:
            return _failed(at, EMPTY, task)
        previous = [o for o in draft.get("options") or [] if isinstance(o, Mapping)]
        options = ([dict(o) for o in previous] + cars)[:MAX_OPTIONS] if draft.get("more") else cars[:MAX_OPTIONS]
        sets: Item = {
            "status": "ready",
            "options": options,
            "finishedAt": at,
            "updatedAt": at,
            **_used(task),
        }
        if not str(draft.get("name") or "").strip():
            first = " ".join(str(options[0].get("name") or "").split())[:NAME_MAX].rstrip()
            if first:
                sets["name"] = first
        return sets
    if started is not None and now - started > TOO_LONG:
        return _failed(at, TOOK_TOO_LONG)
    return None


def _used(task: Mapping[str, Any]) -> Item:
    out: Item = {}
    for key in ("model", "effort"):
        if isinstance(task.get(key), str) and task[key]:
            out[key] = task[key]
    return out


def _failed(at: str, message: str, task: Mapping[str, Any] | None = None) -> Item:
    return {"status": "failed", "message": message, "finishedAt": at, "updatedAt": at, **(_used(task) if task else {})}
