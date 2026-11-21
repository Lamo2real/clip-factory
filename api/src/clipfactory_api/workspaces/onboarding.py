"""Lamo Stories' first-time setup (docs/CONTRACTS.md §45.3 ``ONBOARD``, §45.5, §45.6 ``Onboarding``, §45.29,
§45.33).

Eleven steps; any can be skipped and done later, and making videos never waits for them. Where a step's done state
exists for real, it comes from there and cannot be ticked by hand: a saved AI configuration (steps 1–3), each
platform's own Lamo Stories connection (6–10). Step 4 is done when the owner picks how videos are made (a provider
other than the built-in default, or his tap on "Use the built-in animator", which is the same pick); 5 and 11 are
ticked by hand. The ``ONBOARD`` item keeps only the hand ticks, the skips and ``finishedAt``.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict
from . import ai_config as cfg
from . import guard
from . import types as ws

STEPS: Final = (
    ("ai", "Set up the AI"),
    ("model", "Pick your default model"),
    ("effort", "Pick your default effort"),
    ("video", "Pick how videos are made"),
    ("agents", "Meet your agents and skills"),
    ("instagram", "Connect Instagram"),
    ("tiktok", "Connect TikTok"),
    ("youtube", "Connect YouTube"),
    ("facebook", "Connect Facebook"),
    ("x", "Connect X"),
    ("done", "Done"),
)
STEP_KEYS: Final = tuple(k for k, _ in STEPS)
BY_HAND: Final = ("video", "agents", "done")
FROM_AI: Final = ("ai", "model", "effort")
PLATFORM_STEPS: Final = ("instagram", "tiktok", "youtube", "facebook", "x")
CONNECTED: Final = ("connected", "same_as_clips")
PLATFORM_LABEL: Final = {
    "instagram": "Instagram",
    "tiktok": "TikTok",
    "youtube": "YouTube",
    "facebook": "Facebook",
    "x": "X",
}
TICKS_ITSELF: Final = {
    **dict.fromkeys(FROM_AI, "This step ticks itself when you save your AI settings."),
    **{p: f"This step ticks itself when {PLATFORM_LABEL[p]} is connected." for p in PLATFORM_STEPS},
}


def _item(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any] | None:
    return cfg.get_owned(store, user_id, workspace_id, ws.ONBOARD_SK)


def _video_picked(workspace: Mapping[str, Any]) -> bool:
    config = workspace.get("configuration") if isinstance(workspace.get("configuration"), Mapping) else {}
    chosen = (config or {}).get("providers") if isinstance((config or {}).get("providers"), Mapping) else {}
    defaults = guard.default_stories_config().get("providers") or {}
    return any((chosen or {}).get(k) not in (None, defaults.get(k)) for k in ("video", "images"))


def state(store: db.Store, user_id: str, workspace_id: str, workspace: Mapping[str, Any]) -> dict[str, Any]:
    """``Onboarding`` (§45.6) from the real state and the stored ticks and skips."""
    item = _item(store, user_id, workspace_id) or {}
    hand = {str(s) for s in item.get("stepsDone") or []}
    skipped = {str(s) for s in item.get("skipped") or []}
    ai_saved = cfg.read(store, user_id, workspace_id) is not None
    social = {
        str(i.get("platform") or str(i["sk"])[len(ws.SOCIAL_SK) :]): i
        for i in cfg.query_owned(store, user_id, workspace_id, ws.SOCIAL_SK)
    }
    done: dict[str, bool] = {}
    for key in STEP_KEYS:
        if key in FROM_AI:
            done[key] = ai_saved
        elif key in PLATFORM_STEPS:
            done[key] = (social.get(key) or {}).get("connectionStatus") in CONNECTED
        elif key == "video":
            done[key] = key in hand or _video_picked(workspace)
        elif key == "done":
            done[key] = key in hand or bool(item.get("finishedAt"))
        else:
            done[key] = key in hand
    steps = [
        {"step": key, "label": label, "state": "done" if done[key] else ("skipped" if key in skipped else "todo")}
        for key, label in STEPS
    ]
    return {
        "steps": steps,
        "done": sum(1 for s in steps if s["state"] == "done"),
        "total": len(STEPS),
        "finishedAt": item.get("finishedAt") or None,
    }


def patch(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    workspace: Mapping[str, Any],
    body: Mapping[str, Any],
    *,
    now: datetime,
) -> dict[str, Any]:
    """``{step, done?, skipped?}`` or ``{finish: true}``."""
    at = iso(now)
    item = _item(store, user_id, workspace_id)
    hand = [str(s) for s in (item or {}).get("stepsDone") or []]
    skipped = [str(s) for s in (item or {}).get("skipped") or []]
    finished = (item or {}).get("finishedAt")
    if "finish" in body:
        validate.only_keys(body, ("finish",))
        if body.get("finish") is not True:
            raise bad_request("finish must be true.", "finish")
        hand = _with(hand, "done", True)
        finished = finished or at
    else:
        validate.only_keys(body, ("step", "done", "skipped"))
        step = body.get("step")
        if step not in STEP_KEYS:
            raise bad_request("That is not a setup step.", "step")
        if "done" not in body and "skipped" not in body:
            raise bad_request("Say whether the step is done or skipped.")
        if "done" in body:
            value = validate.boolean(body.get("done"), "done")
            if step not in BY_HAND:
                raise conflict(TICKS_ITSELF[str(step)])
            hand = _with(hand, str(step), value)
            if step == "done":
                finished = (finished or at) if value else None
        if "skipped" in body:
            skipped = _with(skipped, str(step), validate.boolean(body.get("skipped"), "skipped"))
    fresh = {
        **cfg.base_item(user_id, workspace_id, ws.ONBOARD_SK, ws.TYPE_ONBOARD),
        "stepsDone": hand,
        "skipped": skipped,
        "finishedAt": finished,
        "createdAt": (item or {}).get("createdAt") or at,
        "updatedAt": at,
    }
    store.put(fresh)  # the whole small item: the owner's own ticks, nothing another writer keeps here
    return state(store, user_id, workspace_id, workspace)


def _with(values: list[str], value: str, present: bool) -> list[str]:
    out = [v for v in values if v != value]
    return [*out, value] if present else out
