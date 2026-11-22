"""The picture, video and sound makers and their models (docs/CONTRACTS.md §45.37 G1–G5, G7; the owner's second
request §5: "Image-generation models. Video-generation models. Audio-generation models … allow me to select these
providers and models independently", and §3: "support adding new models and providers without rebuilding").

The bundled models come from ``stories/config/models.json`` (an older file's single entries read as one-item lists),
``StoriesConfig.providers`` picks a maker and a model of it (``PATCH`` checks both), the owner adds his own maker
models (``MAKERDEF#``, ``PUT`` / ``DELETE …/makers/models/{key}``), Check models gives them an access check
(``input.makers``, ``MAKERSTATUS#``), and a sound maker is real but never speaks words unless the owner picks Amazon
Polly."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import config, makers, providers
from clipfactory_api.workspaces import types as ws
from conftest import OTHER, USER
from fakes import FakeSecretsManager, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    seed,
    ws_call,
)

PICTURE: dict[str, Any] = {
    "kind": "image",
    "label": "My Stability picture",
    "provider": "Stability AI",
    "host": "bedrock",
    "modelId": "stability.stable-image-core-v1:1",
    "region": "us-west-2",
    "price": {"perUnit": 0.04, "unit": "image", "currency": "USD"},
    "note": "My own copy.",
}
SOUND: dict[str, Any] = {
    "kind": "audio",
    "label": "ElevenLabs v2 effects",
    "provider": "ElevenLabs",
    "host": "elevenlabs",
    "modelId": "eleven_text_to_sound_v2",
    "price": None,
}
VIDEO: dict[str, Any] = {
    "kind": "video",
    "label": "Ray2 (my copy)",
    "provider": "Luma AI",
    "host": "bedrock",
    "modelId": "luma.ray-v2:0",
    "region": "us-west-2",
}


@pytest.fixture
def runtime() -> FakeRuntime:
    return FakeRuntime()


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime, secrets_client: FakeSecretsManager) -> WsCall:
    install(app, runtime, secrets_client)
    return ws_call(app)


def _workspace(wcall: WsCall) -> dict[str, Any]:
    status, body = wcall("GET", BASE)
    assert status == 200
    return dict(body["workspace"])


def _pick(wcall: WsCall, chosen: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    version = _workspace(wcall)["version"]
    return wcall("PATCH", BASE, {"version": version, "configuration": {"providers": chosen}})


def _rows(wcall: WsCall) -> dict[str, dict[str, Any]]:
    status, body = wcall("GET", f"{BASE}/providers")
    assert status == 200
    return {p["id"]: p for p in body["providers"]}


# --- G1, G7: the bundled models -------------------------------------------------------------------------------


def test_the_bundled_makers_models_are_the_settled_ones() -> None:
    found = {m["key"]: m for m in makers.bundled()}
    assert {k: (m["maker"], m["kind"], m["modelId"], m["region"]) for k, m in found.items()} == {
        "nova-canvas": ("nova-canvas", "image", "amazon.nova-canvas-v1:0", "eu-west-1"),
        "stable-image-core": ("stability", "image", "stability.stable-image-core-v1:1", "us-west-2"),
        "stable-image-ultra": ("stability", "image", "stability.stable-image-ultra-v1:1", "us-west-2"),
        "sd3-5-large": ("stability", "image", "stability.sd3-5-large-v1:0", "us-west-2"),
        "nova-reel": ("nova-reel", "video", "amazon.nova-reel-v1:1", "us-east-1"),
        "luma-ray2": ("luma-ray", "video", "luma.ray-v2:0", "us-west-2"),
        "polly-neural": ("polly", "audio", "neural", "eu-west-1"),
        "elevenlabs-effects": ("elevenlabs", "audio", "eleven_text_to_sound_v2", None),
        "elevenlabs-music": ("elevenlabs", "audio", "music_v1", None),
    }
    assert {k for k, m in found.items() if m["ended"]} == {"nova-canvas", "nova-reel"}
    assert all(found[k]["ended"] == "2026-09-30" for k in ("nova-canvas", "nova-reel"))
    assert all(m["price"] is None for m in found.values())  # no price is invented
    # the old single entries stay as mirrors until every reader uses the lists (Terraform reads them today)
    raw = config.load("models.json")
    assert raw["imageModel"]["modelId"] == "amazon.nova-canvas-v1:0"
    assert raw["videoModel"]["modelId"] == "amazon.nova-reel-v1:1"
    # one file for the API and the agent: the agent's own fields (``role``, ``voice``, ``shotSec``) are read there
    sounds = {m["key"]: m for m in raw["audioModels"]}
    assert {k: m.get("role") for k, m in sounds.items()} == {
        "polly-neural": "voice",
        "elevenlabs-effects": "effects",
        "elevenlabs-music": "music",  # ElevenLabs makes an instrumental music bed only (force_instrumental)
    }
    assert sounds["polly-neural"]["label"] == "A spoken voice (Amazon Polly)"
    assert found["polly-neural"]["hostId"] == "polly"  # Amazon Polly runs it, never Amazon Bedrock


def test_an_older_file_with_single_entries_reads_as_one_item_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    older = {
        "models": [],
        "imageModel": {"label": "Amazon Nova Canvas", "modelId": "amazon.nova-canvas-v1:0", "region": "eu-west-1"},
        "videoModel": {"label": "Amazon Nova Reel 1.1", "modelId": "amazon.nova-reel-v1:1", "region": "us-east-1"},
    }
    monkeypatch.setattr(makers.config, "load", lambda name: older)
    found = makers.bundled()
    assert [(m["key"], m["maker"], m["kind"]) for m in found] == [
        ("nova-canvas", "nova-canvas", "image"),
        ("nova-reel", "nova-reel", "video"),
    ]
    assert makers.bundled("audio") == []


def test_the_defaults_pick_the_built_in_makers_and_no_model() -> None:
    chosen = config.workspace_defaults()["providers"]
    assert chosen == {
        "images": "builtin-rig",
        "video": "builtin-2d",
        "audio": "builtin-synth",
        "imageModel": None,
        "videoModel": None,
        "audioModel": None,
    }
    # never a voice by default (the owner's first request: "without traditional voice-over narration")
    assert chosen["audio"] != "polly"


# --- G1, G3, G7: the picks --------------------------------------------------------------------------------------


def test_a_maker_and_its_model_are_picked_and_checked(wcall: WsCall) -> None:
    status, body = _pick(wcall, {"images": "stability", "imageModel": "sd3-5-large"})
    assert status == 200, body
    assert body["workspace"]["configuration"]["providers"]["imageModel"] == "sd3-5-large"
    # a model of another maker, or a model for a built-in maker, is refused with a sentence
    status, body = _pick(wcall, {"imageModel": "luma-ray2"})
    assert (status, body["error"]["field"]) == (400, "configuration.providers.imageModel")
    status, body = _pick(wcall, {"videoModel": "luma-ray2"})  # the video maker is still the built-in one
    assert status == 400
    assert "has no models to pick" in body["error"]["message"]
    assert _pick(wcall, {"images": "dall-e"})[0] == 400
    assert _pick(wcall, {"images": "stability", "imageModel": 3})[0] == 400
    assert _pick(wcall, {"imageModel": "stable-image-ultra", "extra": 1})[0] == 400
    # changing the maker without a model resets the model: null is that maker's first that has not ended
    status, body = _pick(wcall, {"images": "builtin-rig"})
    assert status == 200
    assert body["workspace"]["configuration"]["providers"]["imageModel"] is None
    status, body = _pick(wcall, {"images": "stability"})
    rows = _rows(wcall)
    assert (rows["stability"]["picked"], rows["stability"]["model"]) == (True, "stable-image-core")


def test_the_sound_pick_is_saved_and_never_a_voice_unless_picked(wcall: WsCall) -> None:
    """G3: the Sound maker saves (its pick reached the agent through the workspace), ElevenLabs' models make effects
    and an instrumental music bed only, and Amazon Polly (the one maker that speaks words) is the owner's opt-in."""
    status, body = _pick(wcall, {"audio": "elevenlabs", "audioModel": "elevenlabs-music"})
    assert status == 200, body
    chosen = body["workspace"]["configuration"]["providers"]
    assert (chosen["audio"], chosen["audioModel"]) == ("elevenlabs", "elevenlabs-music")
    rows = _rows(wcall)
    assert [m["key"] for m in rows["elevenlabs"]["models"]] == ["elevenlabs-effects", "elevenlabs-music"]
    notes = {m["key"]: m["note"] for m in rows["elevenlabs"]["models"]}
    assert "wordless" in notes["elevenlabs-effects"]
    assert "Never a voice" in notes["elevenlabs-music"]
    assert all("speak" not in note and "narrat" not in note for note in notes.values())
    assert rows["elevenlabs"]["state"] == "needs_setup"  # it needs the owner's key first
    assert rows["elevenlabs"]["key"] == {"saved": False, "hint": None, "savedAt": None}
    assert rows["polly"]["state"] == "off"
    assert rows["polly"]["line"].endswith("Your videos are made without a voice unless you pick this.")
    status, body = _pick(wcall, {"audio": "polly"})
    assert status == 200
    assert body["workspace"]["configuration"]["providers"]["audioModel"] is None
    assert _rows(wcall)["polly"]["model"] == "polly-neural"


def test_an_ended_maker_or_model_is_never_newly_picked(wcall: WsCall) -> None:
    for chosen, word in (({"images": "nova-canvas"}, "picture"), ({"video": "nova-reel"}, "video")):
        status, body = _pick(wcall, chosen)
        assert status == 400
        assert body["error"]["message"].endswith(f"Pick another {word} maker in Lamo Stories › Settings › Video.")
        assert "was ended by Amazon on 30 Sep 2026" in body["error"]["message"]
    rows = _rows(wcall)
    assert (rows["nova-canvas"]["state"], rows["nova-canvas"]["replacement"]) == ("ended", "stability")
    assert (rows["nova-reel"]["state"], rows["nova-reel"]["replacement"]) == ("ended", "luma-ray")
    assert rows["nova-canvas"]["model"] is None


# --- G2: the owner's own maker models ---------------------------------------------------------------------------


def test_an_added_picture_model_is_listed_under_its_own_maker_and_not_checked_yet(
    wcall: WsCall, table: FakeTable
) -> None:
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-pictures", PICTURE)
    assert status == 200, body
    model = body["model"]
    assert model == {
        "key": "custom-pictures",
        "label": "My Stability picture",
        "provider": "Stability AI",
        "maker": "own-images",
        "host": "Amazon Bedrock",
        "hostId": "bedrock",
        "modelId": "stability.stable-image-core-v1:1",
        "region": "us-west-2",
        "regionLine": "Runs in the US (Oregon)",
        "kind": "image",
        "price": {"perUnit": 0.04, "unit": "image", "currency": "USD"},
        "note": "My own copy.",
        "custom": True,
        "ended": None,
        "endedLine": None,
        "status": "not_checked",  # adding a model never makes it look available
        "statusLine": "Not checked yet. Tap Check models to see if it works.",
        "checkedAt": None,
    }
    item = table.raw(pk(), "MAKERDEF#custom-pictures")
    assert item is not None
    assert (item["type"], item["userId"], item["workspaceId"], item["kind"]) == (
        "ws_makerdef",
        USER,
        "stories",
        "image",
    )
    rows = _rows(wcall)
    assert [m["key"] for m in rows["own-images"]["models"]] == ["custom-pictures"]
    assert rows["own-images"]["state"] == "off"  # not picked
    assert _pick(wcall, {"images": "own-images", "imageModel": "custom-pictures"})[0] == 200
    assert _rows(wcall)["own-images"]["state"] == "needs_setup"
    assert leaked([body, rows]) == []


@pytest.mark.parametrize(
    ("change", "sentence"),
    [
        ({"kind": "voice"}, "Say what the model makes"),
        ({"host": "anthropic"}, "A picture model runs on Amazon Bedrock (bedrock) or an OpenAI-compatible API"),
        ({"host": "elevenlabs"}, "A picture model runs on"),
        ({"modelId": "amazon.nova-pro-v1:0"}, "Lamo Stories can make pictures on Amazon Bedrock with Stability AI"),
        ({"modelId": "not a model"}, "That is not a Bedrock model id."),
        ({"region": "mars-1"}, "Type the AWS Region code"),
        ({"region": "eu-west-1", "modelId": "us.stability.stable-image-core-v1:1"}, "This inference profile id"),
        ({"label": " "}, "Give the model a name people can read."),
        ({"provider": None}, "Say who makes the model"),
        ({"price": {"perUnit": -1, "unit": "image"}}, "Type the price of one picture"),
        ({"price": {"perUnit": 1, "unit": "token"}}, "Type the price of one picture"),
        ({"baseUrl": "https://api.example.org/v1"}, "Only a model on an OpenAI-compatible API has an address"),
        ({"temperature": 1}, "Unknown field: temperature."),
        ({"host": "openai_compatible", "region": None}, "Paste the address of the OpenAI-compatible API"),
        ({"host": "openai_compatible", "region": None, "baseUrl": "https://10.0.0.1/v1"}, "That address is not on"),
        (
            {"host": "openai_compatible", "region": None, "baseUrl": "http://api.example.org/v1"},
            "The address must start",
        ),
        ({"host": "openai_compatible", "baseUrl": "https://api.example.org/v1"}, "Only a model on Amazon Bedrock has"),
    ],
)
def test_a_maker_model_is_checked_with_the_owners_sentence(
    wcall: WsCall, table: FakeTable, change: dict[str, Any], sentence: str
) -> None:
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-x", {**PICTURE, **change})
    assert status == 400, body
    assert body["error"]["message"].startswith(sentence), body["error"]["message"]
    assert not [k for k in table.items if k[1].startswith("MAKERDEF#")]


def test_video_models_run_on_bedrock_only_and_sound_models_never_speak(wcall: WsCall) -> None:
    assert wcall("PUT", f"{BASE}/makers/models/custom-ray", VIDEO)[0] == 200
    for host in ("openai_compatible", "elevenlabs", "anthropic"):
        status, body = wcall("PUT", f"{BASE}/makers/models/custom-ray-2", {**VIDEO, "host": host, "region": None})
        assert status == 400
        assert body["error"]["message"] == "A video model runs on Amazon Bedrock (bedrock)."
    assert wcall("PUT", f"{BASE}/makers/models/custom-sfx", SOUND)[0] == 200
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-tts", {**SOUND, "host": "openai_compatible"})
    assert status == 400
    assert "never a voice" in body["error"]["message"]
    rows = _rows(wcall)
    assert [m["key"] for m in rows["own-video"]["models"]] == ["custom-ray"]
    assert [m["key"] for m in rows["own-sound"]["models"]] == ["custom-sfx"]
    assert rows["own-sound"]["models"][0]["host"] == "ElevenLabs"


def test_an_openai_compatible_picture_model_keeps_its_public_address(wcall: WsCall) -> None:
    body = {**PICTURE, "host": "openai_compatible", "modelId": "gpt-image-2", "region": None}
    status, got = wcall("PUT", f"{BASE}/makers/models/custom-gpt", {**body, "baseUrl": "https://api.example.org/v1/"})
    assert status == 200, got
    assert (got["model"]["host"], got["model"]["baseUrl"]) == ("api.example.org", "https://api.example.org/v1")
    assert got["model"]["region"] is None


def test_a_maker_key_is_custom_never_bundled_never_an_ai_models_and_at_most_twenty_per_kind(
    wcall: WsCall, store: db.Store
) -> None:
    for key in ("pictures", "custom-", "custom-UPPER", "custom-" + "x" * 41):
        assert wcall("PUT", f"{BASE}/makers/models/{key}", PICTURE)[0] == 400
    seed(store, "MODELDEF#custom-taken", ws.TYPE_MODELDEF, key="custom-taken", modelId="x.y", region="us-east-1")
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-taken", PICTURE)
    assert (status, body["error"]["message"]) == (400, makers.REASONING_TAKEN)
    # and the other way round: an AI model's name may not be a maker model's
    assert wcall("PUT", f"{BASE}/makers/models/custom-mine", PICTURE)[0] == 200
    llama = {"label": "L", "provider": "Meta", "modelId": "meta.llama3-8b-instruct-v1:0", "region": "us-east-1",
             "efforts": [], "defaultEffort": None, "vision": False, "maxOutputTokens": 100, "price": None}  # fmt: skip
    assert wcall("PUT", f"{BASE}/ai/models/custom-mine", llama)[0] == 400
    assert wcall("DELETE", f"{BASE}/makers/models/stable-image-core")[0] == 409  # bundled
    for n in range(19):
        assert wcall("PUT", f"{BASE}/makers/models/custom-p{n}", PICTURE)[0] == 200
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-p99", PICTURE)
    assert (status, body["error"]["message"]) == (409, "You can add at most 20 picture models. Remove one first.")
    assert wcall("PUT", f"{BASE}/makers/models/custom-sfx", SOUND)[0] == 200  # the limit is per kind
    assert wcall("PUT", f"{BASE}/makers/models/custom-p3", {**PICTURE, "label": "Renamed"})[0] == 200  # a change
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-p3", SOUND)
    assert (status, body["error"]["message"]) == (400, makers.KIND_FIXED)


def test_a_picked_maker_model_cannot_be_removed(wcall: WsCall, table: FakeTable) -> None:
    assert wcall("PUT", f"{BASE}/makers/models/custom-pictures", PICTURE)[0] == 200
    assert wcall("PUT", f"{BASE}/makers/models/custom-second", PICTURE)[0] == 200
    assert _pick(wcall, {"images": "own-images", "imageModel": "custom-second"})[0] == 200
    status, body = wcall("DELETE", f"{BASE}/makers/models/custom-second")
    assert status == 409
    assert body["error"]["message"] == (
        "My Stability picture is picked as the picture model in Settings › Video. Pick another model there first, "
        "then remove it."
    )
    # null picks the maker's first model: that one is in use too
    assert _pick(wcall, {"imageModel": None})[0] == 200
    assert wcall("DELETE", f"{BASE}/makers/models/custom-pictures")[0] == 409
    assert wcall("DELETE", f"{BASE}/makers/models/custom-second")[0] == 204
    assert table.raw(pk(), "MAKERDEF#custom-second") is None
    assert wcall("DELETE", f"{BASE}/makers/models/custom-second")[0] == 404
    assert _pick(wcall, {"images": "builtin-rig"})[0] == 200
    assert wcall("DELETE", f"{BASE}/makers/models/custom-pictures")[0] == 204


def test_changing_where_a_maker_model_runs_clears_its_check(wcall: WsCall, store: db.Store, table: FakeTable) -> None:
    assert wcall("PUT", f"{BASE}/makers/models/custom-pictures", PICTURE)[0] == 200
    seed(store, "MAKERSTATUS#custom-pictures", ws.TYPE_MAKERSTATUS, model="custom-pictures", kind="image",
         status="ok", line="Works.", checkedAt="2026-11-15T11:00:00.000Z", by="check")  # fmt: skip
    assert wcall("PUT", f"{BASE}/makers/models/custom-pictures", {**PICTURE, "label": "Renamed"})[0] == 200
    assert table.raw(pk(), "MAKERSTATUS#custom-pictures") is not None  # a new name is the same model
    status, body = wcall(
        "PUT", f"{BASE}/makers/models/custom-pictures", {**PICTURE, "modelId": "stability.sd3-5-large-v1:0"}
    )
    assert status == 200
    assert body["model"]["status"] == "not_checked"
    assert table.raw(pk(), "MAKERSTATUS#custom-pictures") is None


def test_another_owners_maker_models_and_checks_are_never_seen(wcall: WsCall, store: db.Store) -> None:
    seed(store, "MAKERDEF#custom-theirs", ws.TYPE_MAKERDEF, user=OTHER, key="custom-theirs", kind="image",
         label="Theirs", provider="x", host="bedrock", modelId="stability.sd3-5-large-v1:0",
         region="us-west-2")  # fmt: skip
    seed(store, "MAKERSTATUS#stable-image-core", ws.TYPE_MAKERSTATUS, user=OTHER, model="stable-image-core",
         status="ok", checkedAt="2026-11-15T11:00:00.000Z")  # fmt: skip
    rows = _rows(wcall)
    assert rows["own-images"]["models"] == []
    assert rows["stability"]["models"][0]["status"] == "not_checked"
    assert wcall("DELETE", f"{BASE}/makers/models/custom-theirs")[0] == 404


# --- G2: Check models gives maker models an access check that costs nothing --------------------------------------


def test_check_models_takes_the_maker_models_and_shows_their_checks(
    wcall: WsCall, store: db.Store, table: FakeTable, runtime: FakeRuntime
) -> None:
    assert wcall("PUT", f"{BASE}/makers/models/custom-pictures", PICTURE)[0] == 200
    status, body = wcall("POST", f"{BASE}/ai/check-models", {"makers": ["stable-image-ultra", "custom-pictures"]})
    assert status == 202, body
    task = table.raw(pk(), f"TASK#{body['task']['taskId']}")
    assert task is not None
    assert task["input"] == {"models": [], "makers": ["stable-image-ultra", "custom-pictures"]}
    assert runtime.calls[-1]["action"] == "check_models"
    assert "input" not in body["task"]
    # both kinds at once, each once
    status, body = wcall("POST", f"{BASE}/ai/check-models", {"models": ["opus-5-5"], "makers": ["luma-ray2"] * 2})
    assert status == 202
    assert table.raw(pk(), f"TASK#{body['task']['taskId']}")["input"] == {  # type: ignore[index]
        "models": ["opus-5-5"],
        "makers": ["luma-ray2"],
    }
    # no maker models, unknown ones and ended ones are refused: an ended model is never called
    assert wcall("POST", f"{BASE}/ai/check-models", {"makers": []})[0] == 400
    assert wcall("POST", f"{BASE}/ai/check-models", {"makers": ["dall-e"]})[0] == 400
    status, body = wcall("POST", f"{BASE}/ai/check-models", {"makers": ["nova-canvas"]})
    assert status == 400
    assert "was ended by Amazon on 30 Sep 2026" in body["error"]["message"]
    # the agent's answers: Works, No access (with the provider's own sentence), Not found
    denied = "Bedrock says this account has no access to Stable Image Ultra in US West (Oregon)."
    for key, status_, line in (
        ("stable-image-core", "ok", "Works."),
        ("stable-image-ultra", "denied", denied),
        ("custom-pictures", "not_found", "Bedrock could not find that model in us-west-2."),
    ):
        seed(store, f"MAKERSTATUS#{key}", ws.TYPE_MAKERSTATUS, model=key, kind="image", status=status_, line=line,
             checkedAt="2026-11-15T12:00:00.000Z", by="check")  # fmt: skip
    rows = _rows(wcall)
    shown = {
        m["key"]: (m["status"], m["statusLine"]) for m in [*rows["stability"]["models"], *rows["own-images"]["models"]]
    }
    assert shown == {
        "stable-image-core": ("ok", "Works."),
        "stable-image-ultra": ("denied", denied),
        "sd3-5-large": ("not_checked", "Not checked yet. Tap Check models to see if it works."),
        "custom-pictures": ("not_found", "Bedrock could not find that model in us-west-2."),
    }
    assert "by" not in json.dumps(rows["stability"]["models"])  # who wrote it stays inside


def test_a_maker_works_once_the_model_it_uses_answered_its_check(wcall: WsCall, store: db.Store) -> None:
    """A picture or sound maker is ``on`` once the access check of the model it uses says Works (or a real call
    did); Luma AI Ray2 also needs its bucket, so only its own Try it shot makes it on."""
    assert _pick(wcall, {"images": "stability", "imageModel": "stable-image-ultra", "video": "luma-ray"})[0] == 200
    for key in ("stable-image-ultra", "luma-ray2"):
        seed(store, f"MAKERSTATUS#{key}", ws.TYPE_MAKERSTATUS, model=key, status="ok", line="Works.",
             checkedAt="2026-11-15T12:00:00.000Z", by="check")  # fmt: skip
    rows = _rows(wcall)
    assert (rows["stability"]["state"], rows["stability"]["checkedAt"]) == ("on", "2026-11-15T12:00:00.000Z")
    assert rows["luma-ray"]["state"] == "needs_setup"
    seed(store, "MAKERSTATUS#stable-image-ultra", ws.TYPE_MAKERSTATUS, model="stable-image-ultra", status="denied",
         line="Bedrock says no.", checkedAt="2026-11-15T12:10:00.000Z", by="check")  # fmt: skip
    rows = _rows(wcall)
    assert (rows["stability"]["state"], rows["stability"]["line"]) == ("needs_setup", "Bedrock says no.")


@pytest.mark.parametrize(
    ("body", "sentence"),
    [
        ({**VIDEO, "modelId": "anthropic.claude-opus-5-5", "region": "eu-west-1"}, makers.BAD_VIDEO_MODEL),
        ({**VIDEO, "modelId": "amazon.nova-reel-v1:1", "region": "us-east-1"}, makers.ENDED_MODEL),
        ({**PICTURE, "modelId": "amazon.nova-canvas-v1:0", "region": "eu-west-1"}, makers.ENDED_MODEL),
        ({**PICTURE, "modelId": "us.amazon.nova-canvas-v1:0", "region": "us-east-1"}, makers.ENDED_MODEL),
        ({**SOUND, "host": "bedrock", "modelId": "amazon.titan-text-express-v1", "region": "us-east-1"},
         makers.NO_BEDROCK_SOUND),
        ({**SOUND, "modelId": "eleven_multilingual_v2"}, makers.ELEVENLABS_ONLY_SOUND),
        ({**SOUND, "modelId": "eleven_v3"}, makers.ELEVENLABS_ONLY_SOUND),
        ({**SOUND, "modelId": "eleven_flash_v2_5"}, makers.ELEVENLABS_ONLY_SOUND),
    ],
    ids=["video-not-luma", "nova-reel", "nova-canvas", "nova-canvas-profile", "bedrock-sound", "tts-v2", "tts-v3",
         "tts-flash"],
)  # fmt: skip
def test_only_models_the_agent_can_call_are_added(
    wcall: WsCall, table: FakeTable, body: dict[str, Any], sentence: str
) -> None:
    """The reviewer's G2 majors: an added model the agent would drop (or that Amazon ended, or ElevenLabs'
    text-to-speech) is refused with a sentence, so it can never read "Works" and turn its maker on."""
    status, got = wcall("PUT", f"{BASE}/makers/models/custom-x", body)
    assert (status, got["error"]["message"]) == (400, sentence)
    assert not [k for k in table.items if k[1].startswith("MAKERDEF#")]


def test_profile_ids_and_arns_of_a_picture_model_and_the_sound_families_are_added(wcall: WsCall) -> None:
    arn = "arn:aws:bedrock:us-west-2::foundation-model/stability.sd3-5-large-v1:0"
    for key, body in (
        ("custom-a", {**PICTURE, "modelId": "us.stability.sd3-5-large-v1:0"}),
        ("custom-b", {**PICTURE, "modelId": arn}),
        ("custom-c", {**SOUND, "modelId": "eleven_text_to_sound_v2"}),
        ("custom-d", {**SOUND, "label": "Music", "modelId": "music_v1"}),
        ("custom-e", VIDEO),
    ):
        status, got = wcall("PUT", f"{BASE}/makers/models/{key}", body)
        assert status == 200, (key, got)


def test_the_bundled_voice_runs_on_amazon_polly_and_an_ended_model_says_so(wcall: WsCall) -> None:
    rows = _rows(wcall)
    polly = rows["polly"]["models"][0]
    assert (polly["hostId"], polly["host"]) == ("polly", "Amazon Polly")
    canvas = rows["nova-canvas"]["models"][0]
    assert (canvas["status"], canvas["statusLine"]) == ("not_found", "Ended by Amazon on 30 Sep 2026.")
    assert "Check models" not in canvas["statusLine"]
    from clipfactory_api.workspaces import hosts

    assert hosts.host_id("Amazon Polly") == "bedrock"  # an added model can never name Amazon Polly
    assert hosts.host_id("Amazon Polly", bundled=True) == "polly"


def test_your_own_video_model_is_on_only_after_its_try_it(wcall: WsCall, store: db.Store, runtime: FakeRuntime) -> None:
    """The reviewer's G7 major: the free access check says nothing of the switched-off bucket your own video model
    writes to, so only its own Try it shot (``PROVIDER#animation#own-video``) makes it ``on`` and lets videos through."""
    hero = _hero(wcall)
    story = {"characterIds": [hero], "brief": {"title": "Ice", "logline": "A skid.", "category": "comedy"}}
    assert _pick(wcall, {"video": "own-video"})[0] == 200
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert (status, body["error"]["message"]) == (409, "Add a video model first: tap Add a model in Lamo Stories › "
                                                       "Settings › Video.")  # fmt: skip
    assert wcall("POST", f"{BASE}/providers/own-video/check")[1]["error"]["message"].startswith("Add a video model")
    assert wcall("PUT", f"{BASE}/makers/models/custom-ray", VIDEO)[0] == 200
    seed(store, "MAKERSTATUS#custom-ray", ws.TYPE_MAKERSTATUS, model="custom-ray", status="ok", line="Works.",
         checkedAt="2026-11-15T12:00:00.000Z", by="check")  # fmt: skip
    assert _rows(wcall)["own-video"]["state"] == "needs_setup"
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert (status, body["error"]["message"]) == (409, providers.NOT_READY["own-video"])
    assert "storage bucket in the United States (Oregon)" in providers.NOT_READY["own-video"]
    status, body = wcall("POST", f"{BASE}/providers/own-video/check")
    assert status == 202, body
    assert body["job"]["meta"]["providers"] == {"animation": "own-video"}
    seed(store, "PROVIDER#animation#own-video", ws.TYPE_PROVIDER, kind="animation", providerId="own-video",
         state="on", checkedAt="2099-01-01T00:00:00.000Z")  # fmt: skip
    assert _rows(wcall)["own-video"]["state"] == "on"
    # a proof of another model proves nothing
    seed(store, "PROVIDER#animation#own-video", ws.TYPE_PROVIDER, kind="animation", providerId="own-video",
         state="on", checkedAt="2099-01-01T00:00:00.000Z", model="custom-other")  # fmt: skip
    assert _rows(wcall)["own-video"]["state"] == "needs_setup"


def test_a_newer_failed_check_of_the_model_in_use_wins_over_an_older_proof(wcall: WsCall, store: db.Store) -> None:
    assert _pick(wcall, {"images": "stability", "imageModel": "stable-image-ultra"})[0] == 200
    seed(store, "PROVIDER#images#stability", ws.TYPE_PROVIDER, kind="images", providerId="stability", state="on",
         checkedAt="2026-11-13T12:00:00.000Z")  # fmt: skip
    assert _rows(wcall)["stability"]["state"] == "on"
    seed(store, "MAKERSTATUS#stable-image-ultra", ws.TYPE_MAKERSTATUS, model="stable-image-ultra", status="denied",
         line="Bedrock says no.", checkedAt="2026-11-15T12:00:00.000Z", by="check")  # fmt: skip
    row = _rows(wcall)["stability"]
    assert (row["state"], row["line"]) == ("needs_setup", "Bedrock says no.")
    assert providers.portrait_problem({"providers": {"images": "stability"}}) is None  # portraits gate on the maker


def test_an_own_model_on_a_keyed_host_needs_its_key_first(wcall: WsCall, runtime: FakeRuntime) -> None:
    hero = _hero(wcall)
    story = {"characterIds": [hero], "brief": {"title": "Ice", "logline": "A skid.", "category": "comedy"}}
    assert wcall("PUT", f"{BASE}/makers/models/custom-sfx", SOUND)[0] == 200
    assert _pick(wcall, {"audio": "own-sound"})[0] == 200
    row = _rows(wcall)["own-sound"]
    assert (row["state"], row["line"]) == ("needs_setup", providers.needs_key("elevenlabs"))
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert (status, body["error"]["message"]) == (409, providers.needs_key("elevenlabs"))
    gpt = {**PICTURE, "host": "openai_compatible", "modelId": "gpt-image-2", "region": None,
           "baseUrl": "https://api.example.org/v1"}  # fmt: skip
    assert wcall("PUT", f"{BASE}/makers/models/custom-gpt", gpt)[0] == 200
    assert _pick(wcall, {"images": "own-images"})[0] == 200
    row = _rows(wcall)["own-images"]
    assert (row["state"], row["line"]) == ("needs_setup", providers.needs_key("openai_compatible"))
    assert "Provider keys" in row["line"]


# --- G3: what a sound maker needs before a video is made --------------------------------------------------------


def _hero(wcall: WsCall) -> str:
    from ws_support import character_body

    status, body = wcall("POST", f"{BASE}/characters", character_body("Bo"))
    assert status == 201, body
    return str(body["character"]["characterId"])


def test_a_sound_maker_without_its_key_or_model_stops_a_video_with_its_sentence(
    wcall: WsCall, store: db.Store, runtime: FakeRuntime
) -> None:
    hero = _hero(wcall)
    story = {"characterIds": [hero], "brief": {"title": "Ice", "logline": "A skid.", "category": "comedy"}}
    assert _pick(wcall, {"audio": "elevenlabs"})[0] == 200
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert (status, body["error"]["message"]) == (409, providers.NOT_READY["elevenlabs"])
    assert _pick(wcall, {"audio": "own-sound"})[0] == 200
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert (status, body["error"]["message"]) == (409, providers.NOT_READY["own-sound"])
    assert [c for c in runtime.calls if c["action"] == "process_story"] == []
    # with the owner's ElevenLabs key saved, the video is made (the agent proves the maker on its first real call)
    assert _pick(wcall, {"audio": "elevenlabs", "audioModel": "elevenlabs-effects"})[0] == 200
    assert wcall("PUT", f"{BASE}/providers/elevenlabs/key", {"key": "sk_0123456789abcdef"})[0] == 200
    status, body = wcall("POST", f"{BASE}/stories", story)
    assert status == 201, body
    assert body["job"]["meta"]["providers"]["audio"] == "elevenlabs"
    assert body["job"]["meta"]["providers"]["audioModel"] == "elevenlabs-effects"
    # Amazon Polly needs nothing from the owner, so it never stops a video
    assert _pick(wcall, {"audio": "polly"})[0] == 200
    assert providers.not_ready({"providers": {"audio": "polly"}}, []) is None


# --- G5: the owner's two suggested efforts ----------------------------------------------------------------------


def test_small_text_edits_and_animation_planning_are_tasks_with_their_suggested_efforts(wcall: WsCall) -> None:
    assert res.TASK_KINDS[-2:] == ("text_edit", "animation_plan")
    assert (res.SUGGESTED_EFFORT["text_edit"], res.SUGGESTED_EFFORT["animation_plan"]) == ("low", "high")
    assert (res.agent_for_task("text_edit"), res.agent_for_task("animation_plan")) == (
        "creative_director",
        "storyboard",
    )
    status, body = wcall("GET", f"{BASE}/ai")
    assert status == 200
    tasks = {t["kind"]: t for t in body["tasks"]}
    assert (tasks["text_edit"]["label"], tasks["text_edit"]["agentId"], tasks["text_edit"]["suggestedEffort"]) == (
        "Small text edits",
        "creative_director",
        "low",
    )
    assert tasks["animation_plan"]["agentId"] == "storyboard"
    body_ai = {"version": 0, "defaultModel": "opus-5-5", "defaultEffort": "high",
               "tasks": {"text_edit": {"model": "haiku-5-5", "effort": "low"}, "animation_plan": {"effort": "max"}}}  # fmt: skip
    status, got = wcall("PUT", f"{BASE}/ai", body_ai)
    assert status == 200, got
    assert got["ai"]["tasks"] == {
        "text_edit": {"model": "haiku-5-5", "effort": "low"},
        "animation_plan": {"effort": "max"},
    }
