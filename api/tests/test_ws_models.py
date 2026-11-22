"""Models the owner adds without a release (docs/CONTRACTS.md §45.34 "Adding models without a release"; the owner's
second request §3: "The architecture must support adding new models and providers without rebuilding the
application"): ``PUT``/``DELETE …/ai/models/{key}`` with a checked ``ModelDef``, kept as ``MODELDEF#{key}`` in the
workspace partition only, merged after ``stories/config/models.json`` everywhere models are listed, checked or
resolved (Settings › AI, the tasks, the agents, the chat, overrides, a video's and a reference's own setting), never
shown as available because it was added, and never removed while a saved setting picks it."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ai_config, ai_resolve, config, model_defs, overrides
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    AT,
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    seed,
    seed_workspace,
    ws_call,
)

LLAMA: dict[str, Any] = {
    "label": "Llama 4 Maverick",
    "provider": "Meta",
    "modelId": "us.meta.llama4-maverick-17b-instruct-v1:0",
    "region": "us-east-1",
    "efforts": [],
    "defaultEffort": None,
    "vision": True,
    "maxOutputTokens": 8192,
    "price": None,
}
NOVA: dict[str, Any] = {
    "label": "Amazon Nova Premier",
    "provider": "Amazon",
    "modelId": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-premier-v1:0",
    "region": "us-east-1",
    "efforts": ["high", "low", "medium"],
    "defaultEffort": "medium",
    "vision": False,
    "maxOutputTokens": 10000,
    "price": {"inputPer1M": 2.5, "outputPer1M": 12.5, "currency": "USD"},
}


@pytest.fixture(autouse=True)
def _unbound() -> Iterator[None]:
    """Each test starts and ends with no workspace bound to the resolver (a request binds its own)."""
    ai_resolve.unbind()
    yield
    ai_resolve.unbind()


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def _add(wcall: WsCall, key: str = "custom-llama", body: dict[str, Any] | None = None) -> dict[str, Any]:
    status, got = wcall("PUT", f"{BASE}/ai/models/{key}", LLAMA if body is None else body)
    assert status == 200, got
    return dict(got["model"])


def _ai(wcall: WsCall) -> dict[str, Any]:
    status, got = wcall("GET", f"{BASE}/ai")
    assert status == 200
    return dict(got)


# --- adding, listing, changing ---------------------------------------------------------------------------------


def test_an_added_model_is_listed_after_the_bundled_ones_and_not_checked_yet(wcall: WsCall, table: FakeTable) -> None:
    model = _add(wcall)
    assert model == {
        "key": "custom-llama",
        "label": "Llama 4 Maverick",
        "provider": "Meta",
        "modelId": "us.meta.llama4-maverick-17b-instruct-v1:0",
        "efforts": [],
        "defaultEffort": None,
        "vision": True,
        "status": "not_checked",  # adding a model never makes it look available
        "statusLine": "Not checked yet. Tap Check models to try it.",
        "checkedAt": None,
        "price": None,
        "custom": True,
        "region": "us-east-1",
        "maxOutputTokens": 8192,
    }
    item = table.raw(pk(), "MODELDEF#custom-llama")
    assert item is not None
    assert (item["type"], item["userId"], item["workspaceId"], item["key"]) == (
        "ws_modeldef",
        USER,
        "stories",
        "custom-llama",
    )
    assert (item["modelId"], item["region"], item["efforts"], item["maxOutputTokens"]) == (
        LLAMA["modelId"],
        "us-east-1",
        [],
        8192,
    )
    got = _ai(wcall)
    keys = [m["key"] for m in got["models"]]
    assert keys == ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5", "custom-llama"]
    assert [m["custom"] for m in got["models"]] == [False] * 5 + [True]
    assert leaked([model, got]) == []


def test_an_arn_and_its_efforts_and_price(wcall: WsCall) -> None:
    model = _add(wcall, "custom-nova-premier", NOVA)
    assert model["efforts"] == ["low", "medium", "high"]  # in the usual order
    assert model["defaultEffort"] == "medium"
    assert model["modelId"] == NOVA["modelId"]
    assert model["price"] is not None
    assert (model["price"]["inputPer1M"], model["price"]["source"], model["price"]["perUnit"]) == (2.5, "owner", None)
    # the owner's typed price beats the price saved with the model, like any other model
    status, got = wcall("PUT", f"{BASE}/ai/prices/custom-nova-premier", {"inputPer1M": 3, "outputPer1M": 15,
                                                                        "currency": "EUR"})  # fmt: skip
    assert status == 200
    assert (got["model"]["price"]["inputPer1M"], got["model"]["price"]["currency"]) == (3.0, "EUR")


def test_a_second_put_changes_the_model_and_keeps_when_it_was_added(wcall: WsCall, table: FakeTable, app: App) -> None:
    _add(wcall)
    first = table.raw(pk(), "MODELDEF#custom-llama")
    app.clock = first_time_plus_one  # type: ignore[method-assign]
    changed = _add(wcall, body={**LLAMA, "label": "Llama 4", "vision": False})
    assert (changed["label"], changed["vision"]) == ("Llama 4", False)
    item = table.raw(pk(), "MODELDEF#custom-llama")
    assert item["createdAt"] == first["createdAt"]
    assert item["updatedAt"] != first["updatedAt"]
    assert len([m for m in _ai(wcall)["models"] if m["custom"]]) == 1


def first_time_plus_one() -> Any:
    from datetime import UTC, datetime

    return datetime(2026, 11, 15, 13, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("key", "change", "sentence"),
    [
        ("llama", {}, "A model you add needs a name like custom-my-model"),
        ("custom-", {}, "A model you add needs a name like custom-my-model"),
        ("custom-Llama", {}, "A model you add needs a name like custom-my-model"),
        ("custom-" + "a" * 41, {}, "A model you add needs a name like custom-my-model"),
        ("custom-x", {"modelId": "gpt-9"}, "That is not a Bedrock model id."),
        ("custom-x", {"modelId": "https://example.com/model"}, "That is not a Bedrock model id."),
        ("custom-x", {"modelId": "arn:aws:s3:::bucket/key"}, "That is not a Bedrock model id."),
        ("custom-x", {"modelId": 7}, "That is not a Bedrock model id."),
        ("custom-x", {"region": "Ireland"}, "Type the AWS Region code"),
        ("custom-x", {"region": "us-east"}, "Type the AWS Region code"),
        ("custom-x", {"efforts": ["low", "turbo"]}, "'turbo' is not an effort level."),
        ("custom-x", {"efforts": "low"}, "efforts must be a list"),
        ("custom-x", {"efforts": ["low"], "defaultEffort": "high"}, "Pick the model's own effort"),
        ("custom-x", {"efforts": [], "defaultEffort": "low"}, "Pick the model's own effort"),
        ("custom-x", {"vision": "yes"}, "Say whether the model can look at pictures."),
        ("custom-x", {"maxOutputTokens": 0}, "maxOutputTokens must be between 1 and 500000."),
        ("custom-x", {"maxOutputTokens": "lots"}, "maxOutputTokens must be a whole number."),
        ("custom-x", {"label": "  "}, "Give the model a name people can read."),
        ("custom-x", {"label": "x" * 61}, "That is too long (at most 60 characters)."),
        ("custom-x", {"provider": None}, "Say who makes the model"),
        ("custom-x", {"price": {"inputPer1M": -1, "outputPer1M": 1, "currency": "USD"}}, "inputPer1M must be"),
        ("custom-x", {"temperature": 1}, "Unknown field: temperature."),
    ],
)
def test_a_model_def_is_checked_with_the_owners_sentence(
    wcall: WsCall, table: FakeTable, key: str, change: dict[str, Any], sentence: str
) -> None:
    status, body = wcall("PUT", f"{BASE}/ai/models/{key}", {**LLAMA, **change})
    assert status == 400, body
    assert body["error"]["message"].startswith(sentence)
    assert not [k for k in table.items if k[1].startswith("MODELDEF#")]


@pytest.mark.parametrize(
    "model_id",
    [
        "anthropic.claude-opus-5-5",
        "global.anthropic.claude-opus-5-5",
        "amazon.nova-pro-v1:0",
        "mistral.mistral-large-2407-v1:0",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5",
        "arn:aws:bedrock:eu-north-1:123456789012:application-inference-profile/a1b2c3d4e5",
    ],
)
def test_bedrock_model_ids_profiles_and_arns_are_taken(wcall: WsCall, model_id: str) -> None:
    assert _add(wcall, "custom-x", {**LLAMA, "modelId": model_id})["modelId"] == model_id


def test_an_added_key_never_shadows_a_bundled_model(wcall: WsCall, monkeypatch: pytest.MonkeyPatch) -> None:
    real = config.load

    def load(name: str) -> dict[str, Any]:
        data = real(name)
        if name != "models.json":
            return data
        bundled = {**data["models"][0], "key": "custom-llama", "label": "Bundled"}
        return {**data, "models": [*data["models"], bundled]}

    monkeypatch.setattr(config, "load", load)
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-llama", LLAMA)
    assert (status, body["error"]["message"]) == (400, model_defs.TAKEN)
    assert wcall("DELETE", f"{BASE}/ai/models/custom-llama")[0] == 409  # a bundled model is never removed


def test_at_most_twenty_models(wcall: WsCall) -> None:
    for n in range(model_defs.MAX_MODELS):
        _add(wcall, f"custom-m{n}")
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-m99", LLAMA)
    assert (status, body["error"]["message"]) == (409, "You can add at most 20 models. Remove one first.")
    assert _add(wcall, "custom-m3", {**LLAMA, "label": "Changed"})["label"] == "Changed"  # changing one is fine


# --- used everywhere models are listed, checked or resolved -----------------------------------------------------


def test_an_added_model_can_be_the_default_a_tasks_and_an_agents(wcall: WsCall) -> None:
    _add(wcall, "custom-nova", NOVA)
    _add(wcall)
    body = {"defaultModel": "custom-nova", "defaultEffort": "low", "tasks": {"storyboard": {"model": "custom-llama"}},
            "version": 0}  # fmt: skip
    status, got = wcall("PUT", f"{BASE}/ai", body)
    assert status == 200, got
    tasks = {t["kind"]: t["effective"] for t in _ai(wcall)["tasks"]}
    assert tasks["brainstorm"] == {"model": "custom-nova", "effort": "low", "effortApplied": True, "from": "default"}
    # an effort only inherited onto a model with no effort setting: run with none sent, and said so
    assert tasks["storyboard"] == {"model": "custom-llama", "effort": None, "effortApplied": False, "from": "task"}
    status, got = wcall("GET", f"{BASE}/agents/character")
    status, got = wcall(
        "PATCH", f"{BASE}/agents/character", {"version": got["agent"]["version"], "model": "custom-llama"}
    )
    assert (status, got["agent"]["model"]) == (200, "custom-llama")
    # Check models checks them like any other
    status, got = wcall("POST", f"{BASE}/ai/check-models", {})
    assert status == 202
    status, got = wcall("POST", f"{BASE}/ai/check-models", {"models": ["custom-llama"]})
    assert status == 202


def test_check_models_lists_every_model_with_the_added_ones(wcall: WsCall, table: FakeTable) -> None:
    _add(wcall)
    _, got = wcall("POST", f"{BASE}/ai/check-models", {})
    task = table.raw(pk(), f"TASK#{got['task']['taskId']}")
    assert task["input"]["models"][-1] == "custom-llama"
    assert len(task["input"]["models"]) == 6


def test_an_effort_saved_with_a_model_that_has_none_is_refused(wcall: WsCall) -> None:
    """§45.34 "Model and effort pairs": in the same setting the effort is refused when saved; inherited, it is not."""
    _add(wcall)
    sentence = "Llama 4 Maverick has no effort setting; it runs at its own level."
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0,
            "tasks": {"chat": {"model": "custom-llama", "effort": "low"}}}  # fmt: skip
    status, got = wcall("PUT", f"{BASE}/ai", body)
    assert (status, got["error"]["message"]) == (400, f"Chat: {sentence}")
    _, agent = wcall("GET", f"{BASE}/agents/character")
    status, got = wcall("PATCH", f"{BASE}/agents/character", {"version": agent["agent"]["version"],
                                                               "model": "custom-llama", "effort": "high"})  # fmt: skip
    assert (status, got["error"]["message"]) == (400, sentence)
    status, got = wcall("POST", f"{BASE}/chat", {"model": "custom-llama", "effort": "high"})
    assert (status, got["error"]["message"]) == (400, sentence)
    assert wcall("POST", f"{BASE}/chat", {"model": "custom-llama"})[0] == 201


def test_an_added_model_in_the_chat_a_video_and_a_reference(wcall: WsCall, store: db.Store) -> None:
    _add(wcall, "custom-nova", NOVA)
    status, got = wcall("POST", f"{BASE}/chat", {"model": "custom-nova", "effort": "high"})
    assert status == 201, got
    conv = got["conversation"]
    assert conv["effective"] == {"model": "custom-nova", "effort": "high", "effortApplied": True,
                                 "from": "conversation"}  # fmt: skip
    status, got = wcall("POST", f"{BASE}/chat/{conv['convId']}/messages",
                        {"text": "Hi", "override": {"model": "custom-nova", "effort": "max"}})  # fmt: skip
    assert (status, got["error"]["message"]) == (400, "Amazon Nova Premier does not offer Maximum. Pick another level.")
    ref_id = "01JD00000000000000000000R1"
    seed(store, f"REFVID#{ref_id}", ws.TYPE_REFVID, refId=ref_id, title="Skid", status="analyzed", bytes=1)
    status, got = wcall("PATCH", f"{BASE}/references/{ref_id}", {"ai": {"model": "custom-nova", "effort": "low"}})
    assert (status, got["reference"]["ai"]) == (200, {"model": "custom-nova", "effort": "low"})
    assert overrides.ai_setting({"model": "custom-nova", "effort": "low"}) == {"model": "custom-nova", "effort": "low"}
    assert overrides.model_override({"model": "custom-nova"}) == {"model": "custom-nova"}


def test_a_story_may_pick_an_added_model(app: App, store: db.Store, s3_client: FakeS3) -> None:
    from ws_support import caller, seed_character
    from ws_support import install as install_core

    install_core(app, None, s3_client)
    call = caller(app)
    assert call("PUT", f"{BASE}/ai/models/custom-nova", NOVA)[0] == 200
    hero = seed_character(store, name="Lamo")
    brief = {"title": "Ice", "logline": "A skid.", "category": "comedy"}
    status, body = call(
        "POST",
        f"{BASE}/stories",
        {"brief": brief, "characterIds": [hero["characterId"]], "ai": {"model": "custom-nova", "effort": "low"},
         "override": {"model": "custom-nova", "effort": "high"}},
    )  # fmt: skip
    assert status == 201, body
    assert body["story"]["ai"] == {"model": "custom-nova", "effort": "low"}
    assert body["story"]["effective"] == {"model": "custom-nova", "effort": "low", "effortApplied": True,
                                          "from": "project"}  # fmt: skip
    job = store.get(pk(), f"PJOB#{body['job']['jobId']}")
    assert job is not None
    assert job["configuration"]["override"] == {"model": "custom-nova", "effort": "high"}
    status, body = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]],
                                                     "ai": {"model": "custom-nova", "effort": "max"}})  # fmt: skip
    assert (status, body["error"]["message"]) == (
        400,
        "Amazon Nova Premier does not offer Maximum. Pick another level.",
    )


# --- per workspace, per owner ------------------------------------------------------------------------------------


def test_a_model_added_in_one_workspace_is_never_another_ones(wcall: WsCall, store: db.Store) -> None:
    other = "01JD0000000000000000000WS2"
    seed_workspace(store, workspace_id=other)
    assert wcall("PUT", f"/v1/workspaces/{other}/ai/models/custom-llama", LLAMA)[0] == 200
    assert [m["key"] for m in _ai(wcall)["models"] if m["custom"]] == []
    status, body = wcall("PUT", f"{BASE}/ai", {"defaultModel": "custom-llama", "defaultEffort": "high", "version": 0})
    assert (status, body["error"]["message"]) == (
        400,
        "Lamo Stories has no model called 'custom-llama'. Pick another one in Lamo Stories › Settings › AI.",
    )
    # another owner's item in this very partition is ignored too
    seed(store, "MODELDEF#custom-theirs", ws.TYPE_MODELDEF, user=OTHER, key="custom-theirs", **LLAMA)
    seed(store, "MODELDEF#custom-mine", ws.TYPE_MODELDEF, key="custom-mine", **LLAMA)
    keys = [m["key"] for m in _ai(wcall)["models"] if m["custom"]]
    assert keys == ["custom-mine"]


def test_without_a_workspace_only_the_bundled_models_count(wcall: WsCall, store: db.Store) -> None:
    _add(wcall)
    ai_resolve.unbind()
    assert [m["key"] for m in ai_resolve.models()] == ["fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5"]
    assert ai_resolve.model("custom-llama") is None
    model_defs.bind(store, USER, "stories")
    assert ai_resolve.model("custom-llama") is not None
    model_defs.bind(store, OTHER, "stories")
    assert ai_resolve.model("custom-llama") is None


def test_the_clips_workspace_binds_no_models(wcall: WsCall) -> None:
    _add(wcall)
    assert wcall("GET", "/v1/workspaces/clips/ai")[0] == 409
    assert ai_resolve.bound_to() is None


# --- removing -------------------------------------------------------------------------------------------------


def test_a_model_in_use_is_not_removed_and_the_setting_is_named(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    _add(wcall)

    def refused() -> str:
        status, body = wcall("DELETE", f"{BASE}/ai/models/custom-llama")
        assert status == 409, body
        return str(body["error"]["message"])

    base = {"defaultModel": "custom-llama", "defaultEffort": "high", "version": 0}
    assert wcall("PUT", f"{BASE}/ai", base)[0] == 200
    assert refused() == (
        "Llama 4 Maverick is still picked for the default model in Settings › AI. Pick another model there first, "
        "then remove it."
    )
    task = {**base, "defaultModel": "opus-5-5", "version": 1, "tasks": {"storyboard": {"model": "custom-llama"}}}
    assert wcall("PUT", f"{BASE}/ai", task)[0] == 200
    assert "the task “Write the story” in Settings › AI" in refused()
    assert wcall("PUT", f"{BASE}/ai", {**task, "version": 2, "tasks": {}})[0] == 200
    _, agent = wcall("GET", f"{BASE}/agents/storyboard")
    patched = wcall(
        "PATCH", f"{BASE}/agents/storyboard", {"version": agent["agent"]["version"], "model": "custom-llama"}
    )
    assert patched[0] == 200
    assert "Storyboard in Settings › Agents" in refused()
    version = patched[1]["agent"]["version"]
    assert wcall("PATCH", f"{BASE}/agents/storyboard", {"version": version, "model": None})[0] == 200
    conv = wcall("POST", f"{BASE}/chat", {"title": "Ice talk", "model": "custom-llama"})[1]["conversation"]
    assert "the chat “Ice talk”" in refused()
    wcall("DELETE", f"{BASE}/chat/{conv['convId']}")
    seed(store, "STORY#01JD00000000000000000000S1", ws.TYPE_STORY, storyId="01JD00000000000000000000S1",
         title="Black ice", ai={"model": "custom-llama", "effort": None})  # fmt: skip
    assert "the video “Black ice”" in refused()
    store.delete(pk(), "STORY#01JD00000000000000000000S1")
    seed(store, "REFVID#01JD00000000000000000000R1", ws.TYPE_REFVID, refId="01JD00000000000000000000R1",
         title="A skid", ai={"model": "custom-llama", "effort": None})  # fmt: skip
    assert "the reference video “A skid”" in refused()
    store.delete(pk(), "REFVID#01JD00000000000000000000R1")
    assert table.raw(pk(), "MODELDEF#custom-llama") is not None
    assert wcall("DELETE", f"{BASE}/ai/models/custom-llama")[0] == 204  # nothing picks it any more


def test_removing_a_model_takes_its_price_and_status_too(wcall: WsCall, store: db.Store, table: FakeTable) -> None:
    _add(wcall)
    assert (
        wcall("PUT", f"{BASE}/ai/prices/custom-llama", {"inputPer1M": 1, "outputPer1M": 2, "currency": "USD"})[0] == 200
    )
    seed(store, "MODELSTATUS#custom-llama", ws.TYPE_MODELSTATUS, model="custom-llama", status="ok", checkedAt=AT)
    assert wcall("DELETE", f"{BASE}/ai/models/custom-llama")[0] == 204
    assert table.raw(pk(), "MODELDEF#custom-llama") is None
    assert table.raw(pk(), "MODELSTATUS#custom-llama") is None
    got = _ai(wcall)
    assert "custom-llama" not in got["ai"]["prices"]
    assert [m["key"] for m in got["models"] if m["custom"]] == []
    assert wcall("DELETE", f"{BASE}/ai/models/custom-llama")[0] == 404
    assert wcall("DELETE", f"{BASE}/ai/models/opus-5-5")[0] == 409
    assert wcall("DELETE", f"{BASE}/ai/models/not-custom")[0] == 404


def test_changing_a_model_in_use_keeps_every_task_usable(wcall: WsCall) -> None:
    _add(wcall, "custom-nova", NOVA)
    assert wcall("PUT", f"{BASE}/ai", {"defaultModel": "custom-nova", "defaultEffort": "low", "version": 0})[0] == 200
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-nova", {**NOVA, "efforts": ["high"], "defaultEffort": None})
    assert status == 400
    assert body["error"]["message"].endswith("Amazon Nova Premier does not offer Low. Pick another level.")
    assert next(m for m in _ai(wcall)["models"] if m["key"] == "custom-nova")["efforts"] == ["low", "medium", "high"]


# --- model status read by its ``model`` attribute (§45.34 "Check models is tiny") ------------------------------


def test_model_status_is_read_by_its_model_attribute(wcall: WsCall, store: db.Store) -> None:
    _add(wcall)
    seed(store, "MODELSTATUS#custom-llama", ws.TYPE_MODELSTATUS, model="custom-llama", status="denied",
         line="Bedrock says this account may not use it.", checkedAt=AT)  # fmt: skip
    seed(store, "MODELSTATUS#old", ws.TYPE_MODELSTATUS, modelKey="opus-5-5", status="ok", checkedAt=AT)
    by = {m["key"]: m for m in _ai(wcall)["models"]}
    assert (by["custom-llama"]["status"], by["custom-llama"]["statusLine"]) == (
        "denied",
        "Bedrock says this account may not use it.",
    )
    assert by["opus-5-5"]["status"] == "ok"  # an older item's ``modelKey`` still counts
    statuses = ai_config.model_status_items(store, USER, "stories")
    assert set(statuses) >= {"custom-llama", "opus-5-5"}
