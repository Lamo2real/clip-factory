"""Lamo Stories' first-time setup (docs/CONTRACTS.md §45.3 ``ONBOARD``, §45.5, §45.6 ``Onboarding``, §45.29,
§45.33, §45.34).

Eleven steps; any can be skipped and done later, and making videos never waits for them. Done states come from the
real state and cannot be ticked by hand (§45.34 "Setup steps 1–3", "Onboarding step 4"):

* step 1 (Set up the AI) when Check models ran (a ``MODELSTATUS#`` the check wrote, ``by: "check"``; one a chat,
  ideas or storyboard call wrote does not count, §45.35 D7) or the owner tapped "These look right"
  (``AICONFIG.pickedAt.environment``); step 2 when the default model was picked (``pickedAt.model``); step 3 when
  the default effort was picked (``pickedAt.effort``). A configuration saved before ``pickedAt`` existed keeps
  ticking all three from ``configSavedAt``, so nothing goes backwards;
* step 4 when ``PATCH …/workspaces/{ws}`` saved ``configuration.providers`` (``providersPickedAt``, even unchanged:
  keeping the built-in animator is a pick too) or a maker other than the built-in default is picked; a picture or
  video maker Amazon ended (Nova Canvas, Nova Reel, §45.37 G7) is never a pick and makes the step one to do again;
* steps 6–10 when that platform's own Lamo Stories account is ``connected`` as the Social accounts page shows it
  (``social.accounts_shown``, settled the same way, round 5 E3): Clip Factory's own account (``same_as_clips``) is
  not, since nothing can be posted there, so the step stays to do with a line saying why; an account whose chosen
  app's keys changed (``needs_reconnect``) is not either. A stored ``connected`` whose account is Clip Factory's own
  destination (Clip Factory connected it later; no account is ever shared, §45.37 G8) counts as ``same_as_clips``
  (§45.35 D11), and a stored ``same_as_clips`` stays so, also once Clip Factory lets go of it (sticky, G8). The app keys are read with the
  workspace secrets only while the request has time for one more slow read, as the dashboard does.

Only 5 and 11 are ticked by hand. The ``ONBOARD`` item keeps only the hand ticks, the skips and ``finishedAt``.

A skipped platform step (``skips``: skipped and not connected; connected wins) keeps its ``skipped`` state in
``steps`` but is not counted: ``total`` is 11 minus those steps, so a platform the owner left out never shows as
something still to do. A skipped step of any other kind still counts ("later").
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict
from . import ai_config as cfg
from . import guard, makers, social
from . import types as ws
from .secrets import WorkspaceSecrets

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
CHECK_MARK: Final = "check"  # MODELSTATUS#.by when Check models wrote it (§45.35 D7)
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
    """Why a platform's step is not done while its account is Clip Factory's own (§45.34, §45.37 G8: never shared)."""
    from .social import SAME_AT_CONNECT

    return SAME_AT_CONNECT


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
        statuses = cfg.query_owned(store, user_id, workspace_id, ws.MODELSTATUS_SK)
        done["ai"] = any(s.get("by") == CHECK_MARK for s in statuses)
    return done


def _item(store: db.Store, user_id: str, workspace_id: str) -> dict[str, Any] | None:
    return cfg.get_owned(store, user_id, workspace_id, ws.ONBOARD_SK)


def _video_picked(workspace: Mapping[str, Any]) -> bool:
    """Step 4: the owner saved the makers. A picture or video maker Amazon ended since (Nova Canvas, Nova Reel, §45.37
    G7) is a step to do again: it stops what it makes until the owner picks another, and it never counts as picked."""
    config = workspace.get("configuration") if isinstance(workspace.get("configuration"), Mapping) else {}
    chosen = (config or {}).get("providers") if isinstance((config or {}).get("providers"), Mapping) else {}
    if any(makers.maker_ended(str((chosen or {}).get(k) or "")) is not None for k in ("video", "images")):
        return False
    picked_at = workspace.get("providersPickedAt")
    if isinstance(picked_at, str) and picked_at:
        return True
    defaults = guard.default_stories_config().get("providers") or {}
    return any((chosen or {}).get(k) not in (None, defaults.get(k)) for k in ("video", "images"))


def platform_statuses(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    *,
    now: datetime,
    secrets: WorkspaceSecrets | None = None,
    started: float | None = None,
) -> dict[str, str]:
    """Each platform's ``connectionStatus`` as the Social accounts page shows it (``social.accounts_shown``: the
    chosen app's current keys, Clip Factory's identity, the 30-minute list; settled the same way). ``secrets`` is
    None while posting is not switched on (the keys are then not checked); ``started`` is the request's
    ``time.monotonic()`` on arrival, so a slow Secrets Manager never holds setup past its 29 s."""
    shown = social.accounts_shown(store, secrets, user_id, workspace_id, now, started=started)
    return {str(a["platform"]): str(a.get("connectionStatus") or "not_connected") for a in shown}


def state(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    workspace: Mapping[str, Any],
    *,
    now: datetime,
    secrets: WorkspaceSecrets | None = None,
    started: float | None = None,
) -> dict[str, Any]:
    """``Onboarding`` (§45.6) from the real state and the stored ticks and skips."""
    item = _item(store, user_id, workspace_id) or {}
    hand = {str(s) for s in item.get("stepsDone") or []}
    skipped = {str(s) for s in item.get("skipped") or []}
    from_ai = ai_steps(store, user_id, workspace_id)
    shown = platform_statuses(store, user_id, workspace_id, now=now, secrets=secrets, started=started)
    platform_status = {p: shown.get(p, "not_connected") for p in PLATFORM_STEPS}
    done: dict[str, bool] = {}
    for key in STEP_KEYS:
        if key in FROM_AI:
            done[key] = from_ai[key]
        elif key in PLATFORM_STEPS:
            done[key] = platform_status[key] in CONNECTED
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
        if step["step"] in PLATFORM_STEPS and platform_status[str(step["step"])] == "same_as_clips":
            step["line"] = same_as_clips_line(str(step["step"]))
    left_out = sum(1 for s in steps if s["step"] in PLATFORM_STEPS and s["state"] == "skipped")
    return {
        "steps": steps,
        "done": sum(1 for s in steps if s["state"] == "done"),
        "total": len(STEPS) - left_out,
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
    secrets: WorkspaceSecrets | None = None,
    started: float | None = None,
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
    return state(store, user_id, workspace_id, workspace, now=now, secrets=secrets, started=started)


def _with(values: list[str], value: str, present: bool) -> list[str]:
    out = [v for v in values if v != value]
    return [*out, value] if present else out
