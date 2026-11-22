"""Lamo Stories' first-time setup (docs/CONTRACTS.md §45.3 ``ONBOARD``, §45.5, §45.6 ``Onboarding``, §45.29,
§45.33, §45.34).

Eleven steps; any can be skipped and done later, and making videos never waits for them. Done states come from the
real state and cannot be ticked by hand (§45.34 "Setup steps 1–3", "Onboarding step 4"):

* step 1 (Set up the AI) when Check models ran (any ``MODELSTATUS#``) or the owner tapped "These look right"
  (``AICONFIG.pickedAt.environment``); step 2 when the default model was picked (``pickedAt.model``); step 3 when
  the default effort was picked (``pickedAt.effort``). A configuration saved before ``pickedAt`` existed keeps
  ticking all three from ``configSavedAt``, so nothing goes backwards;
* step 4 when ``PATCH …/workspaces/{ws}`` saved ``configuration.providers`` (``providersPickedAt``, even unchanged:
  keeping the built-in animator is a pick too) or a maker other than the built-in default is picked;
* steps 6–10 when that platform's own Lamo Stories account is ``connected`` (Lamo Clips' own account,
  ``same_as_clips``, is not: nothing can be posted there, so the step stays to do with a line saying why).

Only 5 and 11 are ticked by hand. The ``ONBOARD`` item keeps only the hand ticks, the skips and ``finishedAt``.
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
BY_HAND: Final = ("agents", "done")
FROM_AI: Final = ("ai", "model", "effort")
PLATFORM_STEPS: Final = ("instagram", "tiktok", "youtube", "facebook", "x")
CONNECTED: Final = ("connected",)
PLATFORM_LABEL: Final = {
    "instagram": "Instagram",
    "tiktok": "TikTok",
    "youtube": "YouTube",
    "facebook": "Facebook",
    "x": "X",
}
TICKS_ITSELF: Final = {
    "ai": "This step ticks itself when you run Check models or tap These look right.",
    "model": "This step ticks itself when you pick your default model.",
    "effort": "This step ticks itself when you pick your default effort.",
    "video": "This step ticks itself when you pick how videos are made.",
    **{p: f"This step ticks itself when {PLATFORM_LABEL[p]} is connected." for p in PLATFORM_STEPS},
}


def same_as_clips_line(platform: str) -> str:
    """Why a platform's step is not done while its account is Lamo Clips' own (§45.34)."""
    return (
        f"This is Lamo Clips' {PLATFORM_LABEL.get(platform, platform)} account. Pick another in Social accounts, "
        "or tap Use it for both."
    )


def ai_steps(store: db.Store, user_id: str, workspace_id: str) -> dict[str, bool]:
    """Steps 1–3 from the real state (§45.34)."""
    item = cfg.read(store, user_id, workspace_id)
    picked = cfg.picked_at(item)
    if picked is None:  # saved before the picks were recorded (or never saved): as it was then
        legacy = bool((item or {}).get("configSavedAt"))
        done = dict.fromkeys(FROM_AI, legacy)
    else:
        done = {
            "ai": bool(picked.get("environment")),
            "model": bool(picked.get("model")),
            "effort": bool(picked.get("effort")),
        }
    if not done["ai"]:
        done["ai"] = bool(cfg.query_owned(store, user_id, workspace_id, ws.MODELSTATUS_SK))
    return done


def _item(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any] | None:
    return cfg.get_owned(store, user_id, workspace_id, ws.ONBOARD_SK)


def _video_picked(workspace: Mapping[str, Any]) -> bool:
    picked_at = workspace.get("providersPickedAt")
    if isinstance(picked_at, str) and picked_at:
        return True
    config = workspace.get("configuration") if isinstance(workspace.get("configuration"), Mapping) else {}
    chosen = (config or {}).get("providers") if isinstance((config or {}).get("providers"), Mapping) else {}
    defaults = guard.default_stories_config().get("providers") or {}
    return any((chosen or {}).get(k) not in (None, defaults.get(k)) for k in ("video", "images"))


def state(store: db.Store, user_id: str, workspace_id: str, workspace: Mapping[str, Any]) -> dict[str, Any]:
    """``Onboarding`` (§45.6) from the real state and the stored ticks and skips."""
    item = _item(store, user_id, workspace_id) or {}
    hand = {str(s) for s in item.get("stepsDone") or []}
    skipped = {str(s) for s in item.get("skipped") or []}
    from_ai = ai_steps(store, user_id, workspace_id)
    social = {
        str(i.get("platform") or str(i["sk"])[len(ws.SOCIAL_SK) :]): i
        for i in cfg.query_owned(store, user_id, workspace_id, ws.SOCIAL_SK)
    }
    done: dict[str, bool] = {}
    for key in STEP_KEYS:
        if key in FROM_AI:
            done[key] = from_ai[key]
        elif key in PLATFORM_STEPS:
            done[key] = (social.get(key) or {}).get("connectionStatus") in CONNECTED
        elif key == "video":
            done[key] = _video_picked(workspace)
        elif key == "done":
            done[key] = key in hand or bool(item.get("finishedAt"))
        else:
            done[key] = key in hand
    steps: list[dict[str, Any]] = [
        {"step": key, "label": label, "state": "done" if done[key] else ("skipped" if key in skipped else "todo")}
        for key, label in STEPS
    ]
    for step in steps:
        if (
            step["step"] in PLATFORM_STEPS
            and (social.get(step["step"]) or {}).get("connectionStatus") == "same_as_clips"
        ):
            step["line"] = same_as_clips_line(str(step["step"]))
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
