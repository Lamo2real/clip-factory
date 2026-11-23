"""Check models (one tiny real call per model, MODELSTATUS# written) and Write them again (post captions)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from botocore.exceptions import ClientError

from lamostories_agent import config, models
from lamostories_agent.tasks import captions
from lamostories_agent.tasks.check import OK_LINE, classify
from lamostories_agent.tasks.work import run_task
from test_tasks_support import PK, USER, WS, FakeModel, reply, services, task_item

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}


def run(svc) -> str:
    return asyncio.run(run_task(svc, PAYLOAD))


def _denied() -> Exception:
    e = models.ModelUnavailable(
        "Claude Fable 5.2 isn't available right now: Bedrock says this account has no access. Pick another model in Clips Funded › Settings › AI, or try again."
    )
    e.__cause__ = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no access"}}, "Converse")
    return e


def test_check_models_calls_each_model_by_name_and_writes_its_status(tmp_path: Path) -> None:
    missing = ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "model not found"}}, "Converse")
    model = FakeModel(
        _denied(),
        reply("ok", model="fable-5-1", effort="low"),
        reply("ok", model="opus-5-5", effort="low"),
        missing,
        ClientError({"Error": {"Code": "ServiceUnavailableException", "Message": "busy"}}, "Converse"),
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "check_models"))
    assert run(svc) == "done"
    keys = [m["key"] for m in config.models()["models"]]
    assert [c["override"]["model"] for c in model.calls] == keys  # every model, by name: never another one
    assert all(c["override"]["effort"] == "low" and c["max_tokens"] <= 512 for c in model.calls)
    statuses = {k: db.get(PK, f"MODELSTATUS#{k}") for k in keys}
    assert [statuses[k]["status"] for k in keys] == ["denied", "ok", "ok", "not_found", "error"]
    assert statuses["fable-5-2"]["line"].startswith("Claude Fable 5.2 isn't available right now")
    assert statuses["fable-5-1"]["line"] == OK_LINE
    assert all(
        s["type"] == "ws_modelstatus" and s["userId"] == USER and s["workspaceId"] == WS and s["checkedAt"]
        for s in statuses.values()
    )
    result = db.get(PK, "TASK#T1")["result"]["models"]
    assert [r["status"] for r in result] == ["denied", "ok", "ok", "not_found", "error"]
    assert db.get(PK, "TASK#T1")["model"] is None
    assert all(c["extra"] == {"allow_inactive": True} for c in model.calls)  # whichever agents are switched on


class AgentOff(Exception):
    """Like builder E's ``models.AgentOff``: raised before anything is sent."""


class ModelRefused(Exception):
    """Like builder E's ``models.ModelRefused``."""


def test_a_failure_that_sent_nothing_fails_the_check_and_leaves_every_status(tmp_path: Path) -> None:
    off = AgentOff("Creative director is switched off. Switch it on in Clips Funded › Settings › Agents.")
    svc, db, _ = services(tmp_path, FakeModel(off))
    db.seed(task_item("T1", "check_models"))
    db.seed({"pk": PK, "sk": "MODELSTATUS#fable-5-2", "type": "ws_modelstatus", "status": "ok", "line": "old"})
    assert run(svc) == "failed"
    task = db.get(PK, "TASK#T1")
    assert task["error"] == str(off)
    assert db.get(PK, "MODELSTATUS#fable-5-2")["line"] == "old"
    assert [sk for _, _, sk in db.writes if sk.startswith("MODELSTATUS#")] == []

    svc, db, _ = services(tmp_path, FakeModel(RuntimeError("a bug, not a call")))
    db.seed(task_item("T1", "check_models"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Checking the models did not finish. Tap Try again."
    assert [sk for _, _, sk in db.writes if sk.startswith("MODELSTATUS#")] == []


def test_a_refusal_is_an_answer_and_a_client_without_allow_inactive_is_called_plainly(tmp_path: Path) -> None:
    class Plain(FakeModel):
        def complete(self, ctx, *, task, messages, override=None, schema=None, tools=None, max_tokens=16000,
                     on_text=None):  # fmt: skip
            return super().complete(ctx, task=task, messages=messages, override=override, max_tokens=max_tokens)

    model = Plain(ModelRefused("Claude Haiku 5.5 said no to this request."))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "check_models", input={"models": ["haiku-5-5"]}))
    assert run(svc) == "done"
    assert db.get(PK, "MODELSTATUS#haiku-5-5")["status"] == "ok"
    assert model.calls[0]["extra"] == {}


def test_check_models_can_check_just_some(tmp_path: Path) -> None:
    model = FakeModel(reply("ok"))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "check_models", input={"models": ["haiku-5-5", "not-a-model"]}))
    assert run(svc) == "done"
    assert [c["override"] for c in model.calls] == [{"model": "haiku-5-5", "effort": "low"}]
    assert db.get(PK, "MODELSTATUS#haiku-5-5")["status"] == "ok"


def test_classify_reads_bedrock_codes_and_words() -> None:
    assert classify(ClientError({"Error": {"Code": "AccessDeniedException"}}, "x")) == "denied"
    assert (
        classify(
            ClientError(
                {"Error": {"Code": "ValidationException", "Message": "The provided model identifier is invalid."}}, "x"
            )
        )
        == "not_found"
    )
    assert classify(RuntimeError("timeout")) == "error"

    class Own(Exception):
        status = "not_found"

    assert classify(Own("x")) == "not_found"


SCRIPT_KEY = f"ws/{USER}/{WS}/stories/S1/script/v2.json"


def _story(**extra) -> dict:
    return {
        "pk": PK,
        "sk": "STORY#S1",
        "userId": USER,
        "workspaceId": WS,
        "storyId": "S1",
        "title": "Pip on ice",
        "category": "driving_safety",
        "safetyTopicId": "skid-recovery",
        "scriptKey": SCRIPT_KEY,
        "postCaptions": {"youtubeTitle": "old"},
        **extra,
    }


def _script() -> dict:
    return {
        "title": "Pip on ice",
        "durationSec": 40,
        "cast": {"c1": {"name": "Pip"}},
        "scenes": [{"title": "Slide", "caption": "Ease off", "beats": [{"who": "c1", "do": "gasp", "face": "scared"}]}],
        "captions": [{"text": "Stay calm"}],
    }


def test_write_them_again_drafts_six_captions_with_the_sources(tmp_path: Path) -> None:
    answer = {
        "youtubeTitle": "Pip <slides> on ice " + "x" * 120,
        "youtubeDescription": "Pip learns to stay calm.",
        "instagram": "Stay calm on ice #driving",
        "facebook": "Pip on ice",
        "tiktok": "Pip on ice #fyp",
        "x": "Pip on ice",
    }
    model = FakeModel(
        reply(data=answer, model="haiku-5-5", effort="low"), reply(data=answer, model="haiku-5-5", effort="low")
    )
    svc, db, s3 = services(tmp_path, model)
    s3.objects[SCRIPT_KEY] = json.dumps(_script()).encode()
    db.seed(_story())
    db.seed(task_item("T1", "captions", input={"storyId": "S1"}))
    assert run(svc) == "done"
    out = db.get(PK, "TASK#T1")["result"]["postCaptions"]
    assert set(out) == set(captions.FIELDS)
    assert len(out["youtubeTitle"]) <= 100 and "<" not in out["youtubeTitle"]
    assert out["youtubeDescription"].endswith("Check your local road rules.") and "#shorts" in out["youtubeDescription"]
    assert "Based on advice from" in out["instagram"] and "Based on advice from" not in out["x"]
    assert model.calls[0]["ctx"].agent_id == "storyboard" and model.calls[0]["task"] == "captions"
    assert "Stay calm" in model.texts(0) and "Pip" in model.texts(0)
    assert "youtubeTitle is at most 100 characters" in model.texts(1)  # asked once more, then cut to fit
    assert db.get(PK, "STORY#S1")["postCaptions"] == {"youtubeTitle": "old"}  # a draft: the owner saves it
    assert db.get(PK, "TASK#T1")["result"]["storyId"] == "S1"


def test_what_code_adds_to_the_captions_always_stays_inside_the_limits() -> None:
    long = "y" * 2190
    answer = {f: "x" for f in captions.FIELDS} | {"instagram": long, "youtubeDescription": "z" * 4995}
    out, problems = captions.check_captions(answer, sources=["NHTSA"])
    assert out is not None
    line = "Based on advice from NHTSA. Check your local road rules."
    for f in ("instagram", "youtubeDescription"):
        assert out[f].endswith(line) and len(out[f]) <= captions.LIMITS[f]
    assert "#shorts" in out["youtubeDescription"]
    assert any(p.startswith("instagram is at most") for p in problems)  # the model is asked to make room
    assert out["tiktok"].endswith(line) and out["x"] == "x"


def test_write_them_again_needs_a_storyboard_in_the_workspace(tmp_path: Path) -> None:
    svc, db, s3 = services(tmp_path, FakeModel())
    s3.objects["jobs/x/script.json"] = b"{}"
    db.seed(_story(scriptKey="jobs/x/script.json"))
    db.seed(task_item("T1", "captions", input={"storyId": "S1"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == captions.NO_SCRIPT
    assert s3.reads == []


def test_write_them_again_uses_the_videos_own_setting_under_the_request(tmp_path: Path) -> None:
    answer = {f: "x" for f in captions.FIELDS}
    model = FakeModel(reply(data=answer))
    svc, db, s3 = services(tmp_path, model)
    s3.objects[SCRIPT_KEY] = json.dumps(_script()).encode()
    db.seed(_story(category="comedy", safetyTopicId=None, ai={"model": "fable-5-1", "effort": "low"}))
    db.seed(task_item("T1", "captions", input={"storyId": "S1"}, override={"effort": "high"}))
    assert run(svc) == "done"
    assert model.calls[0]["override"] == {"model": "fable-5-1", "effort": "high"}
    assert "Based on advice" not in db.get(PK, "TASK#T1")["result"]["postCaptions"]["instagram"]


MODELDEF = {
    "pk": PK,
    "sk": "MODELDEF#custom-mistral-large",
    "type": "ws_modeldef",
    "userId": USER,
    "workspaceId": WS,
    "key": "custom-mistral-large",
    "label": "Mistral Large (mine)",
    "provider": "Mistral",
    "modelId": "mistral.mistral-large-2407-v1:0",
    "region": "us-west-2",
    "efforts": [],
    "defaultEffort": None,
    "vision": False,
    "maxOutputTokens": 8192,
    "price": None,
}


def test_one_status_item_per_model_with_the_model_attribute_and_the_owner_s_models_checked_too(
    tmp_path: Path,
) -> None:
    """§45.34: MODELSTATUS# is written once per model by the check, keyed by ``model`` (never ``modelKey``); a model
    the owner added (MODELDEF#) is checked like any other, with no effort when it lists none."""
    bundled = [m["key"] for m in config.models()["models"]]
    model = FakeModel(*[reply("ok", model=k, effort="low") for k in bundled], reply("ok", effort=None, applied=False))
    svc, db, _ = services(tmp_path, model)
    db.seed(MODELDEF)
    db.seed(task_item("T1", "check_models"))
    assert run(svc) == "done"
    asked = [c["override"] for c in model.calls]
    assert [o["model"] for o in asked] == [*bundled, "custom-mistral-large"]
    assert asked[-1] == {"model": "custom-mistral-large"}  # its efforts list is empty: no effort is sent
    assert all(c["task"] == models.CHECK_TASK for c in model.calls)
    for key in [*bundled, "custom-mistral-large"]:
        st = db.get(PK, f"MODELSTATUS#{key}")
        assert st["model"] == key and "modelKey" not in st and st["status"] == "ok"
    writes = [sk for _, _, sk in db.writes if sk.startswith("MODELSTATUS#")]
    assert len(writes) == len(set(writes)) == len(bundled) + 1  # one item per model
    result = db.get(PK, "TASK#T1")["result"]["models"]
    assert result[-1]["label"] == "Mistral Large (mine)"


def test_an_effort_bedrock_refused_is_a_real_answer_of_the_check(tmp_path: Path) -> None:
    refused = models.EffortUnavailable(
        "Claude Fable 5.2 does not accept Low effort here (Amazon Bedrock refused it). Pick another level in "
        "Clips Funded › Settings › AI.",
        model="fable-5-2",
        effort="low",
        sent=True,
        status="error",
    )
    model = FakeModel(refused)
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "check_models", input={"models": ["fable-5-2"]}))
    assert run(svc) == "done"
    st = db.get(PK, "MODELSTATUS#fable-5-2")
    assert st["status"] == "error" and st["line"] == str(refused) and st["model"] == "fable-5-2"


def test_a_task_that_failed_on_its_model_keeps_the_model_and_effort_it_was_sent_with(tmp_path: Path) -> None:
    """§45.34: TASK# records what was asked even when no answer came (effortApplied false)."""
    sentence = "Claude Fable 5.2 isn't available right now: no access. Pick another model in Clips Funded › Settings › AI, or try again."
    model = FakeModel(models.ModelUnavailable(sentence, model="fable-5-2", effort="max", status="denied"))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", input={"topic": "ice"}, override={"model": "fable-5-2", "effort": "max"}))
    assert run(svc) == "failed"
    task = db.get(PK, "TASK#T1")
    assert task["error"] == sentence
    assert (task["model"], task["effort"], task["effortApplied"]) == ("fable-5-2", "max", False)
