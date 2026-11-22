"""First-time setup (docs/CONTRACTS.md §45.5 ``…/onboarding``, §45.6 ``Onboarding``, §45.29, §45.33): eleven steps,
every one skippable and resumable, done states from the real state (a saved AI configuration for 1–3, which a price
alone is not; a provider picked for 4; each platform's own Lamo Stories connection for 6–10), only 5 and 11 by hand,
and the "4 of 11 done" count."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import types as ws
from conftest import USER
from fakes import FakeTable
from test_ws_ai_support import (
    BASE,
    WS,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    pk,
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
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    seed_social(store, "youtube", "connected")
    seed_social(store, "tiktok", "same_as_clips")
    seed_social(store, "instagram", "choose_account")
    states = _states(wcall)
    assert [states[s] for s in ("ai", "model", "effort")] == ["done"] * 3
    assert (states["youtube"], states["tiktok"], states["instagram"], states["x"]) == ("done", "done", "todo", "todo")
    _, got = wcall("GET", f"{BASE}/onboarding")
    assert got["onboarding"]["done"] == 5
    # a step that ticks itself cannot be ticked by hand
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "x", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when X is connected.")
    status, err = wcall("PATCH", f"{BASE}/onboarding", {"step": "model", "done": True})
    assert (status, err["error"]["message"]) == (409, "This step ticks itself when you save your AI settings.")


def test_a_price_alone_is_not_a_saved_ai_configuration(wcall: WsCall, table: FakeTable) -> None:
    status, _ = wcall("PUT", f"{BASE}/ai/prices/haiku-5-5", {"inputPer1M": 1, "outputPer1M": 5, "currency": "USD"})
    assert status == 200
    assert table.raw(pk(), "AICONFIG") is not None  # the price is kept on the configuration item
    states = _states(wcall)
    assert [states[s] for s in ("ai", "model", "effort")] == ["todo"] * 3
    _, got = wcall("GET", f"{BASE}/ai")
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": got["ai"]["version"]}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    states = _states(wcall)
    assert [states[s] for s in ("ai", "model", "effort")] == ["done"] * 3


def test_picking_a_provider_ticks_step_four(wcall: WsCall, store: db.Store) -> None:
    seed_workspace(store, providers={"images": "nova-canvas", "video": "builtin-2d", "audio": "builtin-synth"})
    assert _states(wcall)["video"] == "done"


def test_keeping_the_built_in_animator_ticks_step_four_once_the_pick_is_recorded(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    assert _states(wcall)["video"] == "todo"  # the defaults alone are not a pick
    # "Use the built-in animator": the workspace's PATCH records the pick even when it keeps the default
    table.items[(ws.registry_pk(USER), ws.workspace_sk(WS))]["providersPickedAt"] = "2026-11-15T11:30:00.000Z"
    assert _states(wcall)["video"] == "done"


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
