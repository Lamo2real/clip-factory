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
    leaked,
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
    # as a real ``same_as_clips`` is stored: with its identity, which is Lamo Clips' own TikTok (§45.35 D11 reads it)
    store.update(pk(), f"{ws.SOCIAL_SK}tiktok", {"externalAccountId": "tt-owner"})
    store.put({"pk": f"USER#{USER}", "sk": "ACCOUNT#tiktok", "platform": "tiktok", "status": "connected",
               "accountId": "tt-owner"})  # fmt: skip
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
        "This is Clip Factory's own account. Funded Clips needs its own separate account: sign in with a different one."
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
    # Check models marks what it writes (``by: "check"``, §45.35 D7)
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, model="opus-5-5", status="ok", checkedAt=AT, by="check")
    states = _states(wcall)
    assert (states["ai"], states["model"], states["effort"]) == ("done", "todo", "todo")


def test_a_model_status_from_a_chat_or_a_job_leaves_step_one_open(wcall: WsCall, store: db.Store) -> None:
    """§45.35 D7: the agent writes ``MODELSTATUS#`` after every model call (chat, ideas, storyboard). Only one Check
    models wrote, or "These look right" (``pickedAt.environment``), ticks "Set up the AI"."""
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, model="opus-5-5", status="ok", checkedAt=AT)
    seed(store, "MODELSTATUS#haiku-5-5", ws.TYPE_MODELSTATUS, model="haiku-5-5", status="ok", checkedAt=AT,
         by="chat")  # fmt: skip
    assert _states(wcall)["ai"] == "todo"
    # another owner's check in the same partition never ticks it
    store.put({"pk": pk(), "sk": "MODELSTATUS#sonnet-5-5", "type": ws.TYPE_MODELSTATUS, "userId": "someone-else",
               "workspaceId": WS, "model": "sonnet-5-5", "status": "ok", "checkedAt": AT, "by": "check"})  # fmt: skip
    assert _states(wcall)["ai"] == "todo"
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0, "picked": ["environment"]}
    assert wcall("PUT", f"{BASE}/ai", body)[0] == 200
    assert _states(wcall)["ai"] == "done"


def test_a_connected_account_that_lamo_clips_has_too_is_not_a_done_step(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    """§45.35 D11: Lamo Clips connected the same YouTube channel after Lamo Stories did, and nobody shared it. The
    stored status still says ``connected`` (nothing read it through Social accounts yet), but setup shows the step
    to do with the same-as-Lamo-Clips line, as the Social accounts page would."""
    seed(store, f"{ws.SOCIAL_SK}youtube", ws.TYPE_SOCIAL, platform="youtube", connectionStatus="connected",
         externalAccountId="UC-owner", socialAccountId=ws.social_account_id(WS, "youtube"))  # fmt: skip
    seed(store, f"{ws.SOCIAL_SK}x", ws.TYPE_SOCIAL, platform="x", connectionStatus="connected",
         externalAccountId="x-own", socialAccountId=ws.social_account_id(WS, "x"))  # fmt: skip
    assert (_states(wcall)["youtube"], _states(wcall)["x"]) == ("done", "done")
    clips = {"pk": f"USER#{USER}", "sk": "ACCOUNT#youtube", "platform": "youtube", "status": "connected",
             "accountId": "UC-owner"}  # fmt: skip
    store.put(clips)
    store.put({**clips, "sk": "ACCOUNT#x", "platform": "x", "accountId": "x-clips"})
    _, got = wcall("GET", f"{BASE}/onboarding")
    steps = {s["step"]: s for s in got["onboarding"]["steps"]}
    assert steps["youtube"]["state"] == "todo"
    assert steps["youtube"]["line"] == (
        "This is Clip Factory's own account. Funded Clips needs its own separate account: sign in with a different one."
    )
    assert (steps["x"]["state"], "line" in steps["x"]) == ("done", False)  # another X account: Lamo Stories' own
    # an old "Use it for both" for this very channel no longer counts (§45.37 G8): the step stays to do
    store.update(pk(), f"{ws.SOCIAL_SK}youtube", {"sharedWithClips": True, "sharedExternalAccountId": "UC-owner"})
    assert _states(wcall)["youtube"] == "todo"
    # setup only reads: nothing of Lamo Clips' changed
    assert table.raw(f"USER#{USER}", "ACCOUNT#youtube") == clips


def test_an_account_clip_factory_let_go_of_stays_a_step_to_do(wcall: WsCall, store: db.Store) -> None:
    """§45.37 G8 (the owner's hard rule): Social accounts stored ``same_as_clips`` while Clip Factory had this channel;
    Clip Factory then disconnected it (or moved to another one). It stays Clip Factory's for Lamo Stories (sticky), so
    setup keeps the step to do, with its line, and never ticks it."""
    for platform, identity in (("youtube", "UC-owner"), ("tiktok", "tt-owner")):
        seed(store, f"{ws.SOCIAL_SK}{platform}", ws.TYPE_SOCIAL, platform=platform, connectionStatus="same_as_clips",
             externalAccountId=identity, socialAccountId=ws.social_account_id(WS, platform))  # fmt: skip
    clips = {"pk": f"USER#{USER}", "sk": "ACCOUNT#youtube", "platform": "youtube", "status": "not_connected",
             "accountId": "UC-owner"}  # fmt: skip
    store.put(clips)
    store.put({**clips, "sk": "ACCOUNT#tiktok", "platform": "tiktok", "status": "connected", "accountId": "tt-other"})
    _, got = wcall("GET", f"{BASE}/onboarding")
    steps = {s["step"]: s for s in got["onboarding"]["steps"]}
    for platform in ("youtube", "tiktok"):  # Clip Factory disconnected it; moved to another
        assert steps[platform]["state"] == "todo"
        assert steps[platform]["line"].startswith("This is Clip Factory's own account.")
    # Clip Factory still on this very account: the same
    store.put({**clips, "status": "connected"})
    _, got = wcall("GET", f"{BASE}/onboarding")
    steps = {s["step"]: s for s in got["onboarding"]["steps"]}
    assert steps["youtube"]["state"] == "todo"
    assert steps["youtube"]["line"].startswith("This is Clip Factory's own account.")


def test_a_model_status_never_returns_who_wrote_it(wcall: WsCall, store: db.Store) -> None:
    """``MODELSTATUS#.by`` is internal (§45.35 D7): it ticks step 1 and is never in ``GET …/ai``, Setup or a task."""
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, model="opus-5-5", status="ok", checkedAt=AT, by="check",
         line="Works.")  # fmt: skip
    seed(store, "MODELSTATUS#haiku-5-5", ws.TYPE_MODELSTATUS, model="haiku-5-5", status="failed", checkedAt=AT,
         by="chat")  # fmt: skip
    shown = [wcall("GET", f"{BASE}/ai"), wcall("GET", f"{BASE}/onboarding")]
    assert all(status == 200 for status, _ in shown)
    models = shown[0][1]["models"]
    assert {m["key"] for m in models} >= {"opus-5-5", "haiku-5-5"}
    assert leaked([body for _, body in shown]) == []
    assert all("by" not in m for m in models)
    assert _states(wcall)["ai"] == "done"


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
    seed_workspace(store, providers={"images": "stability", "video": "builtin-2d", "audio": "builtin-synth"})
    assert _states(wcall)["video"] == "done"


@pytest.mark.parametrize(
    "providers",
    [
        {"images": "nova-canvas", "video": "builtin-2d", "audio": "builtin-synth"},
        {"images": "builtin-rig", "video": "nova-reel", "audio": "builtin-synth"},
    ],
)
def test_a_maker_amazon_ended_is_never_a_pick_for_step_four(
    wcall: WsCall, store: db.Store, table: FakeTable, providers: dict[str, str]
) -> None:
    """§45.37 G7: a stored Nova Canvas or Nova Reel pick stops what it makes, so step 4 is to do again, even when the
    makers were saved on purpose before Amazon ended them."""
    seed_workspace(store, providers=providers)
    assert _states(wcall)["video"] == "todo"
    table.items[(ws.registry_pk(USER), ws.workspace_sk(WS))]["providersPickedAt"] = "2026-09-01T10:00:00.000Z"
    assert _states(wcall)["video"] == "todo"


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
