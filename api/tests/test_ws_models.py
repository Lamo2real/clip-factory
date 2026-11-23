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
    # an Amazon model takes no effort unless the owner says how (§45.35 D1); these tests list efforts
    "effortField": "output_config",
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
        "host": "Amazon Bedrock",  # who runs it; ``provider`` is who makes it (§45.35 D8)
        "hostId": "bedrock",  # §45.37 G4: left out, an added model runs on Amazon Bedrock as before
        "region": "us-east-1",
        "maxOutputTokens": 8192,
        # how it is called (§45.35 D1): a Meta model takes no effort, no tool use and no prompt cache by default
        "effortField": "none",
        "tools": False,
        "cache": False,
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
        # how it is called (§45.35 D1): a Meta model takes no effort, so it lists none
        ("custom-x", {"efforts": ["low"]}, "This model has no effort setting (effortField none)"),
        ("custom-x", {"efforts": ["low"], "effortField": "none"}, "This model has no effort setting"),
        ("custom-x", {"effortField": "speed"}, "Say how the model takes an effort"),
        # §45.37 G4: reasoning_effort is an OpenAI-compatible API's own field
        ("custom-x", {"effortField": "reasoning_effort"}, "Only a model on an OpenAI-compatible API takes"),
        ("custom-x", {"host": "elevenlabs"}, "ElevenLabs makes sounds only."),
        ("custom-x", {"host": "azure"}, "Pick where the model runs"),
        ("custom-x", {"baseUrl": "https://api.example.org/v1"}, "Only a model on an OpenAI-compatible API has"),
        ("custom-x", {"host": "anthropic", "modelId": "claude-opus-5-5"}, "Only a model on Amazon Bedrock has a"),
        ("custom-x", {"host": "anthropic", "region": None, "modelId": "bad id!"}, "Type the model's name exactly"),
        ("custom-x", {"host": "openai_compatible", "region": None}, "Paste the address of the OpenAI-compatible"),
        ("custom-x", {"tools": "yes"}, "Say whether the model takes tool use"),
        ("custom-x", {"cache": 1}, "Say whether the model takes Bedrock's prompt cache"),
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
    # an ARN carries its Region, and the model's Region must be that one (round 5 E4)
    region = model_defs.arn_region(model_id) or LLAMA["region"]
    added = _add(wcall, "custom-x", {**LLAMA, "modelId": model_id, "region": region})
    assert (added["modelId"], added["region"]) == (model_id, region)


@pytest.mark.parametrize(
    ("model_id", "region", "sentence"),
    [
        (
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5",
            "eu-north-1",
            "This ARN is in us-east-1, but the Region says eu-north-1. Type us-east-1 as the Region.",
        ),
        (
            "arn:aws:bedrock:eu-north-1:123456789012:application-inference-profile/a1b2c3d4e5",
            "us-east-1",
            "This ARN is in eu-north-1, but the Region says us-east-1. Type eu-north-1 as the Region.",
        ),
        (
            "eu.anthropic.claude-opus-5-5",
            "us-east-1",
            "This inference profile id starts with eu., so it runs in a Europe Region (like eu-north-1), not in "
            "us-east-1. Type a Europe Region as the Region, or paste the us. profile id instead.",
        ),
        (
            "us.meta.llama4-maverick-17b-instruct-v1:0",
            "eu-north-1",
            "This inference profile id starts with us., so it runs in a US Region (like us-east-1), not in "
            "eu-north-1. Type a US Region as the Region, or paste the eu. profile id instead.",
        ),
        (
            "apac.anthropic.claude-opus-5-5",
            "eu-west-1",
            "This inference profile id starts with apac., so it runs in an Asia Pacific Region (like "
            "ap-southeast-2), not in eu-west-1. Type an Asia Pacific Region as the Region, or paste the eu. profile "
            "id instead.",
        ),
        (
            "us.meta.llama4-maverick-17b-instruct-v1:0",
            "us-gov-west-1",
            "This inference profile id starts with us., so it runs in a US Region (like us-east-1), not in "
            "us-gov-west-1. Type a US Region as the Region, or paste the us-gov. profile id instead.",
        ),
        (
            "arn:aws:bedrock:eu-north-1:123456789012:inference-profile/us.amazon.nova-premier-v1:0",
            "eu-north-1",
            "This ARN's inference profile starts with us., so it runs in a US Region (like us-east-1), not in "
            "eu-north-1. Paste the ARN of the eu. profile instead.",
        ),
    ],
)
def test_an_added_models_region_must_be_the_one_its_id_runs_in(
    wcall: WsCall, table: FakeTable, model_id: str, region: str, sentence: str
) -> None:
    """Round 5 E4: every call to an added model goes to its own Region, so an ARN from another Region, or a
    cross-Region profile of another area, would fail on every call. It is refused when saved, naming both."""
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-x", {**LLAMA, "modelId": model_id, "region": region})
    assert status == 400, body
    assert (body["error"]["message"], body["error"].get("field")) == (sentence, "region")
    assert not [k for k in table.items if k[1].startswith("MODELDEF#")]


@pytest.mark.parametrize(
    ("model_id", "region"),
    [
        ("global.anthropic.claude-opus-5-5", "eu-north-1"),  # a global profile runs from any Region
        ("global.anthropic.claude-opus-5-5", "us-west-2"),
        ("eu.anthropic.claude-opus-5-5", "eu-west-3"),
        ("us.meta.llama4-maverick-17b-instruct-v1:0", "us-west-2"),
        ("us-gov.anthropic.claude-opus-5-5", "us-gov-west-1"),
        ("apac.anthropic.claude-opus-5-5", "ap-northeast-1"),
        ("jp.anthropic.claude-opus-5-5", "ap-northeast-3"),
        ("au.anthropic.claude-opus-5-5", "ap-southeast-4"),
        ("anthropic.claude-opus-5-5", "eu-north-1"),  # a plain model id runs where it is called
        ("amazon.nova-pro-v1:0", "sa-east-1"),
        ("us.amazon.nova-premier-v1:0", "ca-central-1"),  # a Region outside the known areas is never refused
        ("arn:aws:bedrock:eu-north-1:123456789012:inference-profile/eu.amazon.nova-pro-v1:0", "eu-north-1"),
    ],
)
def test_a_region_that_fits_its_id_is_taken(wcall: WsCall, model_id: str, region: str) -> None:
    added = _add(wcall, "custom-x", {**LLAMA, "modelId": model_id, "region": region})
    assert (added["modelId"], added["region"]) == (model_id, region)


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
    model_defs.bind(
        store, USER, "stories"
    )  # outside a request: the workspace is bound by hand (a request binds its own)
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
        "Clip Stories has no model called 'custom-llama'. Pick another one in Clip Stories › Settings › AI.",
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


def test_a_request_never_carries_its_scope_into_the_next_one(app: App, wcall: WsCall, store: db.Store) -> None:
    """A warm Lambda serves one call after another on the same thread: every Lamo Stories route (the OAuth callback
    too) starts and ends with no workspace's added models bound, so a route that names no workspace (the workspace
    list, the callback) only ever sees the bundled models, never the last caller's."""
    from clipfactory_api.http import Request, Response, dispatch, ok, route
    from clipfactory_api.workspaces.routes import ROUTES
    from clipfactory_api.workspaces.routes.scope import scoped
    from clipfactory_api.workspaces.routes.social import CALLBACK_ROUTES
    from conftest import make_event

    _add(wcall)
    assert ai_resolve.bound_to() is None  # the call that bound the owner's workspace cleared it when it ended
    assert all(r.handler.__qualname__ == "scoped.<locals>.run" for r in [*ROUTES, *CALLBACK_ROUTES])
    model_defs.bind(store, USER, "stories")  # as if caller A's scope were still bound
    seen: list[Any] = []

    def peek(_app: App, _req: Request) -> Response:
        seen.append((ai_resolve.bound_to(), ai_resolve.custom_models()))
        return ok({})

    out = dispatch(make_event("GET", "/v1/workspaces", sub=OTHER), app, [scoped(route("GET", "/v1/workspaces", peek))])
    assert out["statusCode"] == 200
    assert seen == [(None, [])]
    assert ai_resolve.bound_to() is None
    # the real workspace list, as another caller, after the owner's call
    _ai(wcall)
    assert wcall("GET", "/v1/workspaces", sub=OTHER)[0] == 200
    assert ai_resolve.bound_to() is None


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


def test_changing_an_added_models_efforts_names_every_saved_setting_that_still_has_one(
    wcall: WsCall, store: db.Store
) -> None:
    """A model that takes no efforts any more never leaves a saved {model, effort} behind that would block the next
    save of Settings › AI or the next run of a video, a reference or a chat."""
    _add(wcall, "custom-nova", NOVA)
    no_efforts = {**NOVA, "efforts": [], "defaultEffort": None}
    sentence = "Amazon Nova Premier has no effort setting; it runs at its own level."

    def refused() -> str:
        status, body = wcall("PUT", f"{BASE}/ai/models/custom-nova", no_efforts)
        assert status == 400, body
        return str(body["error"]["message"])

    saved = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0,
             "tasks": {"storyboard": {"model": "custom-nova", "effort": "high"}}}  # fmt: skip
    assert wcall("PUT", f"{BASE}/ai", saved)[0] == 200
    assert refused() == f"The task “Write the story” in Settings › AI: {sentence}"
    assert (
        wcall("PUT", f"{BASE}/ai", {**saved, "version": 1, "tasks": {"storyboard": {"model": "custom-nova"}}})[0] == 200
    )
    _, agent = wcall("GET", f"{BASE}/agents/storyboard")
    patched = wcall("PATCH", f"{BASE}/agents/storyboard", {"version": agent["agent"]["version"],
                                                           "model": "custom-nova", "effort": "low"})  # fmt: skip
    assert patched[0] == 200, patched[1]
    assert refused() == f"Storyboard in Settings › Agents: {sentence}"
    version = patched[1]["agent"]["version"]
    assert wcall("PATCH", f"{BASE}/agents/storyboard", {"version": version, "model": None, "effort": None})[0] == 200
    conv = wcall("POST", f"{BASE}/chat", {"title": "Ice talk", "model": "custom-nova", "effort": "low"})[1]
    assert refused() == f"The chat “Ice talk”: {sentence}"
    wcall("DELETE", f"{BASE}/chat/{conv['conversation']['convId']}")
    seed(store, "STORY#01JD00000000000000000000S1", ws.TYPE_STORY, storyId="01JD00000000000000000000S1",
         title="Black ice", ai={"model": "custom-nova", "effort": "medium"})  # fmt: skip
    assert refused() == f"The video “Black ice”: {sentence}"
    store.delete(pk(), "STORY#01JD00000000000000000000S1")
    seed(store, "REFVID#01JD00000000000000000000R1", ws.TYPE_REFVID, refId="01JD00000000000000000000R1",
         title="A skid", ai={"model": "custom-nova", "effort": "high"})  # fmt: skip
    assert refused() == f"The reference video “A skid”: {sentence}"
    store.delete(pk(), "REFVID#01JD00000000000000000000R1")
    # nothing saves an effort with it any more: the change is taken, and Settings › AI saves as it was read
    assert wcall("PUT", f"{BASE}/ai/models/custom-nova", no_efforts)[0] == 200
    got = _ai(wcall)["ai"]
    assert wcall("PUT", f"{BASE}/ai", {k: got[k] for k in ("defaultModel", "defaultEffort", "tasks", "prices",
                                                           "version")})[0] == 200  # fmt: skip


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


# --- how an added model is called (§45.35 D1), who runs it (D8), and a re-pointed model (D6) --------------------

CLAUDE: dict[str, Any] = {
    **LLAMA,
    "label": "Claude Opus 5.5 in Ireland",
    "provider": "Anthropic",
    "modelId": "eu.anthropic.claude-opus-5-5",
    "region": "eu-west-1",
    "efforts": ["low", "high"],
    "defaultEffort": "high",
}


# an Amazon model with no word on how it is called: no effort, no tool use, the prompt cache on
NOVA_PLAIN: dict[str, Any] = {**{k: v for k, v in NOVA.items() if k != "effortField"}, "efforts": [],
                              "defaultEffort": None}  # fmt: skip


@pytest.mark.parametrize(
    ("body", "how"),
    [
        (CLAUDE, {"effortField": "output_config", "tools": True, "cache": True}),
        (NOVA_PLAIN, {"effortField": "none", "tools": False, "cache": True}),
        (LLAMA, {"effortField": "none", "tools": False, "cache": False}),
        ({**LLAMA, "provider": " anthropic "}, {"effortField": "output_config", "tools": True, "cache": True}),
        ({**CLAUDE, "tools": False, "cache": False}, {"effortField": "output_config", "tools": False, "cache": False}),
        ({**LLAMA, "tools": True, "cache": True}, {"effortField": "none", "tools": True, "cache": True}),
        (NOVA, {"effortField": "output_config", "tools": False, "cache": True}),
    ],
)
def test_how_an_added_model_is_called_comes_from_its_maker_unless_said(
    wcall: WsCall, store: db.Store, table: FakeTable, body: dict[str, Any], how: dict[str, Any]
) -> None:
    """``effortField`` (default output_config for Anthropic, else none), ``tools`` (default on for Anthropic) and
    ``cache`` (default on for Anthropic and Amazon): kept on the item for the agent, shown in Settings › AI."""
    model = _add(wcall, "custom-x", body)
    assert {k: model[k] for k in how} == how
    assert model["host"] == "Amazon Bedrock"
    item = table.raw(pk(), "MODELDEF#custom-x")
    assert {k: item[k] for k in how} == how
    entry = next(m for m in model_defs.load(store, USER, "stories") if m["key"] == "custom-x")
    assert {k: entry[k] for k in how} == how  # what the resolver (and the agent) merges
    assert entry["host"] == "Amazon Bedrock"


def test_a_model_saved_before_the_calling_fields_reads_with_its_makers_defaults(wcall: WsCall, store: db.Store) -> None:
    """An item from before §45.35 has no ``effortField``, ``tools`` or ``cache``: they read as the maker's defaults,
    and a non-Anthropic model that listed efforts lists none (no effort would be sent to it)."""
    base = {k: v for k, v in LLAMA.items() if k not in ("efforts", "defaultEffort")}
    seed(store, "MODELDEF#custom-old", ws.TYPE_MODELDEF, key="custom-old", **base, efforts=["low", "high"],
         defaultEffort="high", createdAt=AT, updatedAt=AT)  # fmt: skip
    seed(store, "MODELDEF#custom-claude", ws.TYPE_MODELDEF, key="custom-claude", **CLAUDE, createdAt=AT,
         updatedAt=AT)  # fmt: skip
    by = {m["key"]: m for m in _ai(wcall)["models"]}
    old, claude = by["custom-old"], by["custom-claude"]
    assert (old["effortField"], old["tools"], old["cache"], old["efforts"], old["defaultEffort"]) == (
        "none", False, False, [], None
    )  # fmt: skip
    assert (claude["effortField"], claude["tools"], claude["cache"], claude["efforts"]) == (
        "output_config", True, True, ["low", "high"]
    )  # fmt: skip
    assert {m["host"] for m in by.values()} == {"Amazon Bedrock"}
    assert (old["provider"], claude["provider"]) == ("Meta", "Anthropic")
    # an effort picked with the old one is refused with its sentence, never sent
    body = {"defaultModel": "opus-5-5", "defaultEffort": "high", "version": 0,
            "tasks": {"chat": {"model": "custom-old", "effort": "high"}}}  # fmt: skip
    status, got = wcall("PUT", f"{BASE}/ai", body)
    assert (status, got["error"]["message"]) == (400, "Chat: Llama 4 Maverick has no effort setting; it runs at its "
                                                      "own level.")  # fmt: skip


def test_changing_an_added_models_id_or_region_clears_its_status(
    wcall: WsCall, store: db.Store, table: FakeTable
) -> None:
    """§45.35 D6: another model id or Region is another model, so its old "Works" goes and it reads "Not checked
    yet"; a new name, price or pictures setting keeps the status."""
    _add(wcall)
    checked = {"model": "custom-llama", "status": "ok", "checkedAt": AT, "by": "check"}
    seed(store, "MODELSTATUS#custom-llama", ws.TYPE_MODELSTATUS, **checked)
    assert _add(wcall, body={**LLAMA, "label": "Llama 4", "vision": False})["status"] == "ok"
    assert table.raw(pk(), "MODELSTATUS#custom-llama") is not None
    changed = _add(wcall, body={**LLAMA, "modelId": "us.meta.llama4-scout-17b-instruct-v1:0"})
    assert (changed["status"], changed["statusLine"], changed["checkedAt"]) == (
        "not_checked", "Not checked yet. Tap Check models to try it.", None
    )  # fmt: skip
    assert table.raw(pk(), "MODELSTATUS#custom-llama") is None
    assert next(m for m in _ai(wcall)["models"] if m["key"] == "custom-llama")["status"] == "not_checked"
    # a status kept under an older sort key (read by its ``model`` attribute) goes too, and so does a Region change
    seed(store, "MODELSTATUS#legacy-llama", ws.TYPE_MODELSTATUS, **checked)
    seed(store, "MODELSTATUS#opus-5-5", ws.TYPE_MODELSTATUS, model="opus-5-5", status="ok", checkedAt=AT)
    assert _add(wcall, body={**LLAMA, "modelId": changed["modelId"], "region": "us-west-2"})["status"] == "not_checked"
    assert table.raw(pk(), "MODELSTATUS#legacy-llama") is None
    assert table.raw(pk(), "MODELSTATUS#opus-5-5") is not None  # another model's status is never touched
    # another owner's status item at the same key is never deleted
    store.put({"pk": pk(), "sk": "MODELSTATUS#custom-llama", "type": ws.TYPE_MODELSTATUS, "userId": OTHER,
               "workspaceId": "stories", "model": "custom-llama", "status": "ok", "checkedAt": AT})  # fmt: skip
    _add(wcall, body={**LLAMA, "region": "us-east-2"})
    assert table.raw(pk(), "MODELSTATUS#custom-llama") is not None


# --- §45.37 G4: where an added model runs (Amazon Bedrock, the Anthropic API, an OpenAI-compatible API) ---------

ANTHROPIC_API: dict[str, Any] = {
    "label": "Claude Opus 5.5 (my Anthropic key)",
    "provider": "Anthropic",
    "host": "anthropic",
    "modelId": "claude-opus-5-5",
    "efforts": ["low", "medium", "high", "xhigh", "max"],
    "defaultEffort": "medium",
    "vision": True,
    "maxOutputTokens": 64000,
    "price": None,
}
OPENAI_API: dict[str, Any] = {
    "label": "Llama on my host",
    "provider": "Meta",
    "host": "openai_compatible",
    "baseUrl": "https://api.example.org/v1/",
    "modelId": "meta-llama/Llama-4-Maverick",
    "efforts": ["low", "medium", "high"],
    "defaultEffort": None,
    "vision": False,
    "maxOutputTokens": 8192,
    "price": None,
    "effortField": "reasoning_effort",
}


def test_a_model_on_the_anthropic_api_takes_its_effort_in_output_config(wcall: WsCall, table: FakeTable) -> None:
    model = _add(wcall, "custom-opus-api", ANTHROPIC_API)
    assert (model["host"], model["hostId"], model["region"]) == ("Anthropic API", "anthropic", "")
    assert (model["effortField"], model["tools"], model["cache"]) == ("output_config", True, True)
    assert model["efforts"] == ["low", "medium", "high", "xhigh", "max"]
    assert "baseUrl" not in model
    item = table.raw(pk(), "MODELDEF#custom-opus-api")
    assert item is not None
    assert (item["host"], item["modelId"]) == ("anthropic", "claude-opus-5-5")
    listed = {m["key"]: m for m in _ai(wcall)["models"]}
    assert listed["custom-opus-api"]["hostId"] == "anthropic"
    # the resolver treats it like any other model: the effort is checked against its own list
    assert (
        wcall("PUT", f"{BASE}/ai", {"version": 0, "defaultModel": "custom-opus-api", "defaultEffort": "max"})[0] == 200
    )


def test_a_model_on_an_openai_compatible_api_keeps_its_address_and_reasoning_effort(
    wcall: WsCall, table: FakeTable, store: db.Store
) -> None:
    model = _add(wcall, "custom-llama-api", OPENAI_API)
    assert (model["host"], model["hostId"]) == ("api.example.org", "openai_compatible")
    assert model["baseUrl"] == "https://api.example.org/v1"  # no trailing slash
    assert (model["effortField"], model["tools"], model["cache"]) == ("reasoning_effort", False, False)
    item = table.raw(pk(), "MODELDEF#custom-llama-api")
    assert item is not None
    assert (item["host"], item["baseUrl"]) == ("openai_compatible", "https://api.example.org/v1")
    # moving it to another address is another model: its old check no longer counts (D6)
    seed(store, "MODELSTATUS#custom-llama-api", "ws_modelstatus", model="custom-llama-api", status="ok")
    _add(wcall, "custom-llama-api", {**OPENAI_API, "baseUrl": "https://other.example.net/v1"})
    assert table.raw(pk(), "MODELSTATUS#custom-llama-api") is None


@pytest.mark.parametrize(
    "base_url",
    [
        "http://api.example.org/v1",
        "https://localhost/v1",
        "https://127.0.0.1/v1",
        "https://10.0.0.8/v1",
        "https://192.168.1.4/v1",
        "https://169.254.169.254/latest",
        "https://[::1]/v1",
        "https://[fd00::1]/v1",
        "https://[::ffff:127.0.0.1]/v1",
        "https://metadata.google.internal/v1",
        "https://my-server/v1",
        "https://service.internal/v1",
        "https://printer.local/v1",
        "https://2130706433/v1",
        "https://0x7f.0.0.1/v1",
        "https://user:pass@api.example.org/v1",
        "https://api.example.org/v1?key=1",
        "https://api.example.org/v1#x",
        "https://api.example.org/../v1",
        "ftp://api.example.org/v1",
        "",
    ],
)
def test_an_openai_compatible_address_must_be_public_https(wcall: WsCall, table: FakeTable, base_url: str) -> None:
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-llama-api", {**OPENAI_API, "baseUrl": base_url})
    assert status == 400, body
    assert body["error"].get("field") in (None, "baseUrl")
    assert not [k for k in table.items if k[1].startswith("MODELDEF#")]


def test_an_openai_compatible_model_never_takes_max_as_its_reasoning_effort(wcall: WsCall, table: FakeTable) -> None:
    """The reviewer's G4 minor: OpenAI-style APIs take ``reasoning_effort`` low to xhigh; "max" would be sent as it
    is and refused, so it is refused here (the web's REASONING_EFFORTS are the same four)."""
    from clipfactory_api.workspaces import model_defs

    assert model_defs.REASONING_EFFORTS == ("low", "medium", "high", "xhigh")
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-llama-max", {**OPENAI_API, "efforts": ["high", "max"]})
    assert (status, body["error"]["message"]) == (400, model_defs.BAD_REASONING_EFFORT)
    assert table.raw(pk(), "MODELDEF#custom-llama-max") is None
    assert wcall("PUT", f"{BASE}/ai/models/custom-llama-max", {**OPENAI_API, "efforts": ["high", "xhigh"]})[0] == 200
