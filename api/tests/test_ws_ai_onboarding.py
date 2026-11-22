"""First-time setup (docs/CONTRACTS.md §45.5 ``…/onboarding``, §45.6 ``Onboarding``, §45.29, §45.33, §45.34): eleven
steps, every one skippable and resumable, done states from the real state (step 1 after Check models or "These look
right", 2 and 3 when the default model and effort were picked, which a price alone is not; a provider picked for 4;
each platform's own Lamo Stories connection for 6–10, never Lamo Clips' own account), only 5 and 11 by hand, and the
"4 of 11 done" count."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import types as ws
from conftest import USER
from fakes import FakeTable
from test_ws_ai_support import (
    AT,
    BASE,
    WS,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    pk,
    seed,
    seed_social,
    seed_workspace,
    ws_call,
)

STEPS = ["ai", "model", "effort", "video", "agents", "instagram", "tiktok", "youtube", "facebook", "x", "done"]


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def _states(wcall: WsCall) -> dict[str, str]:
    status, body = wcall("GET", f"{BASE}/onboarding")
    assert status == 200
    return {s["step"]: s["state"] for s in body["onboarding"]["steps"]}


def test_eleven_steps_all_to_do_at_first(wcall: WsCall) -> None:
    status, body = wcall("GET", f"{BASE}/onboarding")
    assert status == 200
    onboarding = body["onboarding"]
    assert [s["step"] for s in onboarding["steps"]] == STEPS
    assert [s["label"] for s in onboarding["steps"]][:5] == [
        "Set up the AI",
        "Pick your default model",
        "Pick your default effort",
        "Pick how videos are made",
        "Meet your agents and skills",
    ]
    assert onboarding["steps"][5]["label"] == "Connect Instagram"
    assert (onboarding["done"], onboarding["total"], onboarding["finishedAt"]) == (0, 11, None)
    assert set(_states(wcall).values()) == {"todo"}


def test_done_states_come_from_the_real_state(wcall: WsCall, store: db.Store) -> None:
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0, "picked": ["environment", "model"]}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    seed_social(store, "youtube", "connected")
    seed_social(store, "tiktok", "same_as_clips")
    seed_social(store, "instagram", "choose_account")
    states = _states(wcall)
    # the model was picked, the effort not yet: step 3 stays to do (§45.34)
    assert [states[s] for s in ("ai", "model", "effort")] == ["done", "done", "todo"]
    # Lamo Clips' own TikTok is not a Lamo Stories connection: nothing can be posted there, so its step stays to do
    assert (states["youtube"], states["tiktok"], states["instagram"], states["x"]) == ("done", "todo", "todo", "todo")
    _, got = wcall("GET", f"{BASE}/onboarding")
    assert got["onboarding"]["done"] == 3
    tiktok = next(s for s in got["onboarding"]["steps"] if s["step"] == "tiktok")
    assert tiktok["line"] == (
        "This is Lamo Clips' TikTok account. Pick another in Social accounts, or tap Use it for both."
    )
    assert "line" not in next(s for s in got["onboarding"]["steps"] if s["step"] == "youtube")
    # a step that ticks itself cannot be ticked by hand
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "x", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when X is connected.")
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "model", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when you pick your default model.")
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "effort", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when you pick your default effort.")
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "ai", "done": True})
    assert (status, err["error"]["message"]) == (
        409,
        "This step ticks itself when you run Check models or tap These look right.",
    )


def test_a_price_alone_is_not_a_saved_ai_configuration(wcall: WsCall, table: FakeTable) -> None:
    status, _ = wcall("PUT", f"{BASE}/ai/prices/haiku-5-5", {"inputPer1M": 1, "outputPer1M": 5, "currency": "USD"})
    assert status == 200
    assert table.raw(pk(), "AICONFIG") is not None  # the price is kept on the configuration item
    states = _states(wcall)
    assert [states[s] for s in ("ai", "model", "effort")] == ["todo"] * 3
    _, got = wcall("GET", f"{BASE}/ai")
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": got["ai"]["version"]}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    # a save that picks nothing (a task's setting, say) ticks nothing
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["todo"] * 3
    body = {**body, "version": body["version"] + 1, "picked": ["environment", "model", "effort"]}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    states = _states(wcall)
    assert [states[s] for s in ("ai", "model", "effort")] == ["done"] * 3


def test_each_of_the_first_three_steps_ticks_on_its_own_pick(wcall: WsCall, table: FakeTable) -> None:
    base = {"defaultModel": "opus-5-5", "defaultEffort": "high"}
    assert wcall("PUT", f"{BASE}/ai", {**base, "version": 0, "picked": ["model"]})[0] == 200
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["todo", "done", "todo"]
    first = table.raw(pk(), "AICONFIG")["pickedAt"]
    assert set(first) == {"model"}
    assert wcall("PUT", f"{BASE}/ai", {**base, "version": 1, "picked": ["effort"]})[0] == 200
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["todo", "done", "done"]
    assert table.raw(pk(), "AICONFIG")["pickedAt"]["model"] == first["model"]  # an earlier pick is kept
    assert wcall("PUT", f"{BASE}/ai", {**base, "version": 2, "picked": ["environment"]})[0] == 200
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["done"] * 3
    for bad in (["colour"], "model", [1]):
        status, err = wcall("PUT", f"{BASE}/ai", {**base, "version": 3, "picked": bad})
        assert (status, err["error"]["message"]) == (400, "picked must list environment, model or effort.")
    _, got = wcall("GET", f"{BASE}/ai")
    assert "pickedAt" not in got["ai"]
    assert "configSavedAt" not in got["ai"]


def test_check_models_ticks_step_one(wcall: WsCall, store: db.Store) -> None:
    assert _states(wcall)["ai"] == "todo"
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, model="opus-5-5", status="ok", checkedAt=AT)
    states = _states(wcall)
    assert (states["ai"], states["model"], states["effort"]) == ("done", "todo", "todo")


def test_a_configuration_saved_before_the_picks_keeps_its_ticks(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    """An ``AICONFIG`` saved before ``pickedAt`` existed ticks steps 1–3 from ``configSavedAt``, also after its next
    save: nothing goes backwards (§45.34)."""
    seed(store, "AICONFIG", ws.TYPE_AICONFIG, defaultModel="opus-5-5", defaultEffort="high", tasks={}, prices={},
         version=2, configSavedAt=AT)  # fmt: skip
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["done"] * 3
    body = {"defaultModel": "fable-5-2", "defaultEffort": "high", "version": 2}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    assert [_states(wcall)[s] for s in ("ai", "model", "effort")] == ["done"] * 3
    assert table.raw(pk(), "AICONFIG")["pickedAt"] == {"environment": AT, "model": AT, "effort": AT}


def test_picking_a_provider_ticks_step_four(wcall: WsCall, store: db.Store) -> None:
    seed_workspace(store, providers={"images": "nova-canvas", "video": "builtin-2d", "audio": "builtin-synth"})
    assert _states(wcall)["video"] == "done"


def test_keeping_the_built_in_animator_ticks_step_four_once_the_pick_is_recorded(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    assert _states(wcall)["video"] == "todo"  # the defaults alone are not a pick
    # "Use the built-in animator": the workspace's PATCH records the pick even when it keeps the default (§45.34)
    _, got = wcall("GET", BASE)
    workspace = got["workspace"]
    unchanged = {"providers": workspace["configuration"]["providers"]}
    status, body = wcall("PATCH", BASE, {"version": workspace["version"], "configuration": unchanged})
    assert status == 200
    assert "providersPickedAt" not in body["workspace"]  # it stays inside
    stored = table.items[(ws.registry_pk(USER), ws.workspace_sk(WS))]
    assert stored["providersPickedAt"] == "2026-11-15T12:00:00.000Z"
    assert _states(wcall)["video"] == "done"


def test_a_patch_without_providers_records_no_pick(wcall: WsCall, table: FakeTable) -> None:
    _, got = wcall("GET", BASE)
    body = {"version": got["workspace"]["version"], "configuration": {"defaultDurationSec": 30}}
    assert wcall("PATCH", BASE, body)[0] == 200
    assert "providersPickedAt" not in table.items[(ws.registry_pk(USER), ws.workspace_sk(WS))]
    assert _states(wcall)["video"] == "todo"


def test_step_four_cannot_be_ticked_by_hand(wcall: WsCall, table: FakeTable) -> None:
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "video", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when you pick how videos are made.")
    assert _states(wcall)["video"] == "todo"
    assert table.raw(pk(), "ONBOARD") is None
    assert wcall("PATCH", f"{BASE}/onboarding", {"step": "video", "skipped": True})[0] == 200  # it can be skipped
    assert _states(wcall)["video"] == "skipped"


def test_skip_resume_and_finish(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall("PATCH", f"{BASE}/onboarding", {"step": "instagram", "skipped": True})
    assert status == 200
    assert {s["step"]: s["state"] for s in body["onboarding"]["steps"]}["instagram"] == "skipped"
    assert wcall("PATCH", f"{BASE}/onboarding", {"step": "agents", "done": True})[0] == 200
    states = _states(wcall)
    assert (states["agents"], states["video"], states["instagram"]) == ("done", "todo", "skipped")
    assert wcall("PATCH", f"{BASE}/onboarding", {"step": "instagram", "skipped": False})[0] == 200
    assert _states(wcall)["instagram"] == "todo"
    status, body = wcall("PATCH", f"{BASE}/onboarding", {"finish": True})
    assert status == 200
    assert body["onboarding"]["finishedAt"] == "2026-11-15T12:00:00.000Z"
    assert body["onboarding"]["steps"][-1]["state"] == "done"
    assert body["onboarding"]["done"] == 2
    item = table.raw(pk(), "ONBOARD")
    assert item is not None
    assert (item["type"], sorted(item["stepsDone"])) == ("ws_onboard", ["agents", "done"])


@pytest.mark.parametrize(
    "body",
    [{}, {"step": "dance", "done": True}, {"step": "agents"}, {"step": "agents", "done": "yes"}, {"finish": False}],
)
def test_patch_validation(wcall: WsCall, body: dict[str, object]) -> None:
    assert wcall("PATCH", f"{BASE}/onboarding", body)[0] == 400
