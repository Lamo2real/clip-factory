"""Check models for the makers' models (docs/CONTRACTS.md §45.37 G2): an access check that costs nothing, written to
``MAKERSTATUS#{key}``, with the provider's own answer in a plain sentence (Works / No access / Not found); and the
creative chat's short text edits on the task ``text_edit`` (§45.37 G5). Fakes only: no AWS, no network."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import agents, config, maker_check
from lamostories_agent.chat import edits
from lamostories_agent.chat.turn import run_turn
from lamostories_agent.hosts import Answer
from lamostories_agent.maker_check import MakerChecker
from lamostories_agent.tasks.work import run_task
from test_chat_turn import ANSWER, CONV, conv, msg, pending
from test_hosts import FakeHttp, FakeKeys
from test_tasks_support import PK, USER, WS, FakeMakerChecker, FakeModel, reply, services, task_item

LUMA = config.pick_model("video", "luma-ray", None)
CORE = config.pick_model("image", "stability", None)
POLLY = config.pick_model("audio", "polly", None)
EFFECTS = config.pick_model("audio", "elevenlabs", "elevenlabs-effects")


class FakeBedrock:
    """Bedrock's control plane in a Region: ``get_foundation_model_availability`` answers what it is told."""

    def __init__(self, answer: dict[str, Any] | None = None, error: tuple[str, str] | None = None) -> None:
        self.answer, self.error = answer, error
        self.asked: list[tuple[str, str]] = []
        self.region = ""

    def __call__(self, region: str) -> FakeBedrock:
        self.region = region
        return self

    def get_foundation_model_availability(self, *, modelId: str) -> dict[str, Any]:
        self.asked.append((self.region, modelId))
        if self.error:
            raise ClientError(
                {"Error": {"Code": self.error[0], "Message": self.error[1]}}, "GetFoundationModelAvailability"
            )
        return self.answer or {}

    def invoke_model(self, **kw: Any) -> Any:  # never: a check generates nothing
        raise AssertionError("a maker check must never make anything")

    start_async_invoke = invoke_model


AVAILABLE = {"agreementAvailability": {"status": "AVAILABLE"}, "authorizationStatus": "AUTHORIZED",
             "entitlementAvailability": "AVAILABLE", "regionAvailability": "AVAILABLE"}  # fmt: skip


@pytest.mark.parametrize(
    ("answer", "error", "status", "line"),
    [
        (AVAILABLE, None, "ok", "Amazon Bedrock says this account can use Luma AI Ray2 in US West (Oregon)."),
        (
            {**AVAILABLE, "authorizationStatus": "NOT_AUTHORIZED"},
            None,
            "denied",
            "Amazon Bedrock says this account may not use Luma AI Ray2 in US West (Oregon).",
        ),
        (
            {**AVAILABLE, "agreementAvailability": {"status": "PENDING"}},
            None,
            "denied",
            "Amazon Bedrock is still turning on Luma AI Ray2 for this account in US West (Oregon).",
        ),
        (
            {
                **AVAILABLE,
                "agreementAvailability": {"status": "NOT_AVAILABLE", "errorMessage": "Accept the offer first"},
            },
            None,
            "denied",
            "Luma AI Ray2 is not turned on for this account in US West (Oregon). Bedrock said: Accept the offer first.",
        ),
        (
            {**AVAILABLE, "entitlementAvailability": "NOT_AVAILABLE"},
            None,
            "denied",
            "Luma AI Ray2 is not turned on for this account in US West (Oregon). Turn it on in the Bedrock console.",
        ),
        (
            {**AVAILABLE, "regionAvailability": "NOT_AVAILABLE"},
            None,
            "not_found",
            "Amazon Bedrock does not offer Luma AI Ray2 in US West (Oregon).",
        ),
        (
            None,
            ("ResourceNotFoundException", "Model not found"),
            "not_found",
            "Amazon Bedrock cannot find Luma AI Ray2 in US West (Oregon): Model not found.",
        ),
        (
            None,
            ("ThrottlingException", "slow"),
            "error",
            "Amazon Bedrock did not answer the check for Luma AI Ray2. Try again later.",
        ),
    ],
)
def test_a_bedrock_maker_is_checked_in_its_own_region_for_free(
    answer: dict[str, Any] | None, error: tuple[str, str] | None, status: str, line: str
) -> None:
    bedrock = FakeBedrock(answer, error)
    assert MakerChecker(bedrock=bedrock).check(WS, LUMA) == (status, line)  # type: ignore[arg-type]
    assert bedrock.asked == [("us-west-2", "luma.ray-v2:0")]


def test_an_ended_model_reads_ended_and_is_never_asked_about() -> None:
    bedrock = FakeBedrock(AVAILABLE)
    for key in ("nova-canvas", "nova-reel"):
        entry = config.maker_entry(key)
        assert MakerChecker(bedrock=bedrock).check(WS, entry) == ("not_found", "Ended by Amazon on 30 Sep 2026.")  # type: ignore[arg-type]
    assert bedrock.asked == []


def test_elevenlabs_polly_and_an_openai_compatible_picture_model_are_checked_for_free() -> None:
    http = FakeHttp(Answer(200, b'[{"model_id": "eleven_multilingual_v2"}]'))
    keys_ = FakeKeys({(WS, "elevenlabs"): "el-owner", (WS, "openai_compatible"): "oc-owner"})
    checker = MakerChecker(keys=keys_, http=http)
    assert checker.check(WS, EFFECTS) == ("ok", "ElevenLabs accepted your key.")  # type: ignore[arg-type]
    assert http.calls[0]["method"] == "GET" and http.calls[0]["headers"]["xi-api-key"] == "el-owner"
    assert MakerChecker(keys=FakeKeys({}), http=http).check(WS, EFFECTS) == (  # type: ignore[arg-type]
        "denied",
        "There is no key for ElevenLabs saved yet (paste one in Lamo Stories › Settings › AI › Provider keys).",
    )
    refused = MakerChecker(keys=keys_, http=FakeHttp(Answer(401, b'{"detail": {"message": "invalid"}}')))
    assert refused.check(WS, EFFECTS)[0] == "denied"  # type: ignore[arg-type]

    class Polly:
        region = ""

        def __call__(self, region: str) -> Any:
            self.region = region
            return self

        def describe_voices(self, **kw: Any) -> dict[str, Any]:
            assert kw == {"Engine": "neural"}
            return {"Voices": [{"Id": "Joanna"}, {"Id": "Matthew"}]}

        def synthesize_speech(self, **kw: Any) -> Any:
            raise AssertionError("the check never speaks")

    polly = Polly()
    assert MakerChecker(polly=polly).check(WS, POLLY) == (
        "ok",
        "Amazon Polly can speak with the Joanna voice in Europe (Ireland).",
    )  # type: ignore[arg-type]
    assert polly.region == "eu-west-1"
    assert MakerChecker(polly=polly).check(WS, {**POLLY, "voice": "Nobody"})[0] == "not_found"  # type: ignore[dict-item]

    pic = {"key": "custom-oc", "label": "GPT image", "maker": "own-images", "hostId": "openai_compatible", "kind": "image",
           "modelId": "gpt-image-1", "baseUrl": "https://api.example-images.com/v1"}  # fmt: skip
    listing = FakeHttp(Answer(200, b'{"data": [{"id": "gpt-image-1"}, {"id": "other"}]}'))
    assert MakerChecker(keys=keys_, http=listing).check(WS, pic) == (
        "ok",
        "The address accepted your key and lists gpt-image-1.",
    )
    assert listing.calls[0]["url"] == "https://api.example-images.com/v1/models"
    missing = FakeHttp(Answer(200, b'{"data": [{"id": "other"}]}'))
    assert MakerChecker(keys=keys_, http=missing).check(WS, pic)[0] == "not_found"


def test_the_status_item_is_the_workspace_s_own() -> None:
    item = maker_check.status_item(USER, WS, CORE, "ok", "Works.", "2026-11-22T10:00:00.000Z")  # type: ignore[arg-type]
    assert item == {"pk": PK, "sk": "MAKERSTATUS#stable-image-core", "type": "ws_makerstatus", "userId": USER,
                    "workspaceId": WS, "model": "stable-image-core", "kind": "image", "status": "ok",
                    "line": "Works.", "checkedAt": "2026-11-22T10:00:00.000Z", "by": "check"}  # fmt: skip


# --- Check models with makers ------------------------------------------------------------------------------------


PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}


def test_check_models_checks_the_named_makers_and_calls_no_reasoning_model(tmp_path: Path) -> None:
    model = FakeModel()
    checker = FakeMakerChecker({"luma-ray2": ("denied", "Luma AI Ray2 is not turned on for this account.")})
    svc, db, _ = services(tmp_path, model, maker_checker=checker)
    db.seed(task_item("T1", "check_models", input={"makers": ["luma-ray2", "stable-image-core", "nope"]}))
    assert asyncio.run(run_task(svc, PAYLOAD)) == "done"
    assert model.calls == []  # no model call: an access check costs nothing
    assert checker.checked == [(WS, "luma-ray2"), (WS, "stable-image-core")]
    luma = db.get(PK, "MAKERSTATUS#luma-ray2")
    assert luma is not None and (luma["status"], luma["kind"], luma["by"], luma["model"]) == (
        "denied",
        "video",
        "check",
        "luma-ray2",
    )
    assert luma["line"] == "Luma AI Ray2 is not turned on for this account." and luma["checkedAt"]
    result = db.get(PK, "TASK#T1")["result"]
    assert result["models"] == [] and [m["key"] for m in result["makers"]] == ["luma-ray2", "stable-image-core"]
    assert db.get(PK, "MODELSTATUS#opus-5-5") is None


def test_check_models_with_nothing_named_checks_every_model_and_every_maker_that_has_not_ended(tmp_path: Path) -> None:
    keys_ = [m["key"] for m in config.models()["models"]]
    model = FakeModel(*[reply("ok") for _ in keys_])
    checker = FakeMakerChecker()
    svc, db, _ = services(tmp_path, model, maker_checker=checker)
    db.seed(task_item("T1", "check_models"))
    db.seed({"pk": PK, "sk": "MAKERDEF#custom-sdxl", "userId": USER, "workspaceId": WS, "key": "custom-sdxl",
             "kind": "image", "host": "bedrock", "modelId": "stability.sd3-5-large-v1:0", "region": "us-west-2"})  # fmt: skip
    assert asyncio.run(run_task(svc, PAYLOAD)) == "done"
    assert [c["override"]["model"] for c in model.calls] == keys_
    checked = [k for _, k in checker.checked]
    assert "nova-canvas" not in checked and "nova-reel" not in checked
    assert {"stable-image-core", "luma-ray2", "polly-neural", "elevenlabs-effects", "custom-sdxl"} <= set(checked)
    assert db.get(PK, "MAKERSTATUS#custom-sdxl")["status"] == "ok"  # type: ignore[index]
    # only the reasoning models: no maker is checked
    model2 = FakeModel(reply("ok"))
    checker2 = FakeMakerChecker()
    svc2, db2, _ = services(tmp_path / "b", model2, maker_checker=checker2)
    db2.seed(task_item("T1", "check_models", input={"models": ["haiku-5-5"]}))
    assert asyncio.run(run_task(svc2, PAYLOAD)) == "done" and checker2.checked == []


# --- short text edits in the chat (§45.37 G5) ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "task"),
    [
        ("Rename Lamo to Bobo", "text_edit"),
        ("fix the typo in the title", "text_edit"),
        ("Shorten the caption of scene 2", "text_edit"),
        ('Call it "Icy Ride"', "text_edit"),
        ("change the title to Slippery Sunday", "text_edit"),
        ("replace slid with skidded", "text_edit"),
        ("Give me 5 new ideas about ice", "chat"),
        ("Make the video", "chat"),
        ("make a new video where the caption is shorter", "chat"),
        ("What do you think of the ending?", "chat"),
        ("remake scene 2 and fix the caption", "chat"),
        ("Rename it " + "x" * 300, "chat"),  # not short
    ],
)
def test_which_messages_are_short_text_edits(text: str, task: str) -> None:
    assert edits.chat_task(text) == task
    assert edits.chat_task("Rename Lamo to Bobo", pictures=1) == "chat"  # a picture is never a text edit


def test_the_new_tasks_belong_to_their_agents() -> None:
    assert agents.agent_for_task("text_edit") == "creative_director"
    assert agents.agent_for_task("animation_plan") == "storyboard"


def _turn(tmp_path: Path, text: str) -> tuple[FakeModel, Any]:
    model = FakeModel(reply("Done: it is called Bobo now."))
    svc, db, _ = services(tmp_path, model)
    db.seed(conv())
    db.seed(msg("01JD0000000000000000000002", "user", text))
    db.seed(pending())
    payload = {"userId": USER, "workspaceId": WS, "convId": CONV, "msgId": ANSWER}
    assert asyncio.run(run_turn(svc, payload)) == "done"
    return model, db


def test_a_short_edit_in_the_chat_runs_as_text_edit_with_the_same_agent_and_tools(tmp_path: Path) -> None:
    model, db = _turn(tmp_path, "Rename Lamo to Bobo")
    (call,) = model.calls
    assert call["task"] == "text_edit" and call["ctx"].agent_id == "creative_director" and call["tools"]
    answer = db.get(PK, f"MSG#{CONV}#{ANSWER}")
    assert answer["status"] == "done"
    model2, _ = _turn(tmp_path / "b", "Give me an idea about picnics")
    assert model2.calls[0]["task"] == "chat"
