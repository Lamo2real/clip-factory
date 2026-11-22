"""Round 4 of Lamo Stories' agent (docs/CONTRACTS.md §45.35, the agent's items): each added model's request is built
from how it is called (D1), Nova Reel can be tried (D2), model records are exact (D5), Check models marks its status
(D7), models name their maker and host (D8), a failed re-analysis keeps its study (D9), the IAM grant's ARNs are in
infra's own test (D12), post captions follow the video's shape (D13), the ASS writer uses the engine's safe boxes
(D14) and the writer's characters act like themselves (D15). Fakes only: no AWS, no network."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import ass, config, keys, models, writer
from lamostories_agent.data import JobFence
from lamostories_agent.models import ANSWER_TOOL, AnswerInvalid, BedrockModels, CallContext
from lamostories_agent.pipeline import Services, StoryJob
from ls_fakes import PK, USER, WS, FakeModels, FakeRuntime, FakeStore, FakeTable, converse_reply, data, needs_deno

CTX = CallContext(user_id=USER, workspace_id=WS, agent_id="creative_director", session_id="S1", task_id="T1")
HELLO = [{"role": "user", "content": [{"text": "Hello"}]}]
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["title"],
          "properties": {"title": {"type": "string", "maxLength": 10}}}  # fmt: skip
TOOL = {"name": "list_ideas", "description": "The owner's ideas.", "input_schema": {"type": "object"}}
REPO = Path(__file__).resolve().parents[3]


def item(sk: str, **fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": sk, "userId": USER, "workspaceId": WS, **fields}


def added(key: str, provider: str, model_id: str, **over: Any) -> dict[str, Any]:
    """A ``MODELDEF#`` as the API saves it in round 4 (with or without the three call fields)."""
    fields: dict[str, Any] = {"type": "ws_modeldef", "key": key, "label": f"{provider} model", "provider": provider,
                              "modelId": model_id, "region": "us-west-2", "efforts": [], "defaultEffort": None,
                              "vision": False, "maxOutputTokens": 4096, "price": None}  # fmt: skip
    return item(f"MODELDEF#{key}", **{**fields, **over})


def client(
    replies: list[Any], *seed: dict[str, Any], region: str | None = "eu-north-1"
) -> tuple[BedrockModels, FakeRuntime, FakeTable]:
    table = FakeTable()
    for it in seed:
        table.seed(it)
    store = FakeStore(table)
    runtime = FakeRuntime(replies)
    m = BedrockModels(table=table, get_bytes=store.get_bytes_sync, client=runtime, region=region, sleep=lambda _: None)
    return m, runtime, table


def last_user_texts(body: dict[str, Any]) -> list[str]:
    last = next(m for m in reversed(body["messages"]) if m["role"] == "user")
    return [b["text"] for b in last["content"] if "text" in b]


# --- D1: the request is built from how each model is called --------------------------------------------------------


def test_an_added_anthropic_model_gets_the_effort_field_tools_and_a_cache_point() -> None:
    """Provider Anthropic with no call fields: output_config.effort, toolConfig (automatic) and a cache point."""
    claude = added("custom-claude", "Anthropic", "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/cl1",
                   efforts=["low", "high"], defaultEffort="high")  # fmt: skip
    m, runtime, _ = client(
        [converse_reply("Hi")], claude, item(keys.agent_sk("creative_director"), instructions="Be kind.")
    )
    reply = m.complete(CTX, task="chat", messages=HELLO, override={"model": "custom-claude", "effort": "low"},
                       tools=[TOOL], max_tokens=16000)  # fmt: skip
    (body,) = runtime.requests
    assert body == {
        "modelId": "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/cl1",
        "system": [*body["system"][:-1], {"cachePoint": {"type": "default"}}],
        "messages": HELLO,
        "inferenceConfig": {"maxTokens": 4096},
        "additionalModelRequestFields": {"output_config": {"effort": "low"}},
        "toolConfig": {"tools": [models.tool_spec(TOOL)], "toolChoice": {"auto": {}}},
    }
    assert body["system"][0] == {"text": "Be kind."}
    assert (reply.effort, reply.effort_applied, reply.tools_off) == ("low", True, False)


def test_an_added_amazon_model_gets_a_cache_point_only_and_answers_a_schema_as_json_in_its_text() -> None:
    """Provider Amazon: no effort field, no toolConfig, a cache point; the structured answer is asked for as JSON."""
    nova = added("custom-nova", "Amazon", "amazon.nova-pro-v1:0", region=None)
    m, runtime, _ = client([converse_reply('Here it is: {"title": "Picnic"}')], nova,
                           item(keys.agent_sk("creative_director"), instructions="Be kind."))  # fmt: skip
    reply = m.complete(CTX, task="brainstorm", messages=HELLO, override={"model": "custom-nova"}, schema=SCHEMA)
    (body,) = runtime.requests
    assert set(body) == {"modelId", "system", "messages", "inferenceConfig"}  # no effort field, no toolConfig
    assert body["modelId"] == "amazon.nova-pro-v1:0"
    assert body["system"][0] == {"text": "Be kind."} and body["system"][-1] == {"cachePoint": {"type": "default"}}
    assert all("text" in b for b in body["system"][:-1])  # the instructions and skills, then the one cache point
    nudge = last_user_texts(body)[-1]
    assert nudge.startswith("Answer with only one JSON object") and json.dumps(SCHEMA, separators=(",", ":")) in nudge
    assert ANSWER_TOOL not in json.dumps(body)
    assert reply.data == {"title": "Picnic"} and reply.effort is None and reply.effort_applied is False


def test_an_added_meta_model_gets_no_effort_tools_or_cache_point_even_with_an_old_effort_list() -> None:
    """Provider Meta (an item saved before round 4 still listing efforts): nothing Anthropic-only is ever sent, the
    effort is not applied (never pretended), and the chat's tools are left out with the model told so."""
    llama = added("custom-llama", "Meta", "meta.llama4-maverick-17b-instruct-v1:0", efforts=["low", "medium"],
                  defaultEffort="medium")  # fmt: skip
    m, runtime, _ = client([converse_reply("Hi there")], llama, item(keys.agent_sk("creative_director"),
                                                                       instructions="Be kind."))  # fmt: skip
    reply = m.complete(CTX, task="chat", messages=HELLO, override={"model": "custom-llama", "effort": "low"},
                       tools=[TOOL])  # fmt: skip
    (body,) = runtime.requests
    assert body == {
        "modelId": "meta.llama4-maverick-17b-instruct-v1:0",
        "system": body["system"],
        "messages": [{"role": "user", "content": [{"text": "Hello"}, {"text": models.NO_TOOLS_NUDGE}]}],
        "inferenceConfig": {"maxTokens": 4096},
    }
    assert body["system"][0] == {"text": "Be kind."} and all(set(b) == {"text"} for b in body["system"])  # no cache
    assert (reply.effort, reply.effort_applied, reply.tools_off) == (None, False, True)
    assert config.model("custom-llama", config.merged_models([llama]))["efforts"] == []  # type: ignore[index]


def test_a_model_without_tools_is_asked_for_its_json_once_more_then_fails() -> None:
    mistral = added("custom-mistral", "Mistral", "mistral.mistral-large-2407-v1:0")
    m, runtime, _ = client([converse_reply("A picnic idea!"), converse_reply('{"title": "Pie day"}')], mistral)
    reply = m.complete(CTX, task="brainstorm", messages=HELLO, override={"model": "custom-mistral"}, schema=SCHEMA)
    _first, again = runtime.requests
    assert reply.data == {"title": "Pie day"} and "toolConfig" not in again
    retry = again["messages"][-1]
    assert retry["role"] == "user" and "toolResult" not in json.dumps(retry)
    assert "You did not answer with one JSON object." in retry["content"][0]["text"]
    assert retry["content"][0]["text"].endswith(models.JSON_AGAIN)
    assert again["messages"][-2] == {"role": "assistant", "content": [{"text": "A picnic idea!"}]}

    m2, runtime2, _ = client([converse_reply('{"title": "Far too long a title"}'), converse_reply("no")], mistral)
    with pytest.raises(AnswerInvalid):
        m2.complete(CTX, task="brainstorm", messages=HELLO, override={"model": "custom-mistral"}, schema=SCHEMA)
    assert len(runtime2.requests) == 2  # one retry, never more


def test_the_owner_s_own_call_fields_win_over_the_maker_s_defaults() -> None:
    own = added("custom-x", "Meta", "meta.x", efforts=["low"], effortField="output_config", tools=True, cache=False)
    entry = config.model("custom-x", config.merged_models([own]))
    assert entry is not None and config.call_shape(entry) == ("output_config", True, False)
    assert entry["efforts"] == ["low"] and entry["host"] == "Amazon Bedrock" and entry["provider"] == "Meta"
    none = config.model("custom-y", config.merged_models([added("custom-y", "Anthropic", "a.b", efforts=["low"],
                                                                effortField="none")]))  # fmt: skip
    assert none is not None and none["efforts"] == [] and config.call_shape(none)[0] == "none"
    for bundled in config.models()["models"]:  # the bundled Claude models: Anthropic's, on Amazon Bedrock
        assert config.call_shape(bundled) == ("output_config", True, True)
        # an older file that named the host as the provider still calls them as Anthropic's (the API's rule)
        assert config.call_shape({**bundled, "provider": "Amazon Bedrock"}) == ("output_config", True, True)
    assert config.call_shape({"provider": "Amazon Bedrock", "modelId": "anthropic.x", "custom": True})[0] == "none"


@pytest.mark.parametrize(
    ("provider", "effort_sent"),
    [("Anthropic", True), ("Amazon", False), ("Meta", False)],
)
def test_check_models_sends_the_same_shape_as_every_other_call(provider: str, effort_sent: bool) -> None:
    efforts = ["low"] if provider == "Anthropic" else []
    model = added("custom-m", provider, f"{provider.lower()}.model-v1", efforts=efforts)
    m, runtime, _ = client([converse_reply("ok")], model)
    override: dict[str, Any] = {"model": "custom-m", **({"effort": "low"} if efforts else {})}
    m.complete(CTX, task=models.CHECK_TASK, messages=HELLO, override=override, max_tokens=512)
    (body,) = runtime.requests
    assert body["system"] == [] and "toolConfig" not in body
    assert ("additionalModelRequestFields" in body) is effort_sent
    assert m.request(models.Choice("custom-m", "low" if efforts else None, bool(efforts), "request"),
                     config.model("custom-m", config.merged_models([model])) or {}, [], HELLO, [], 512) == body  # fmt: skip


# --- D5: what really ran is kept -----------------------------------------------------------------------------------


def test_a_reply_and_a_failed_call_say_the_model_id_region_and_task() -> None:
    m, _, _ = client([converse_reply("Hi")])
    reply = m.complete(CTX, task="chat", messages=HELLO)
    assert (reply.model, reply.model_id, reply.region, reply.task) == ("opus-5-5", "global.anthropic.claude-opus-5-5",
                                                                       "eu-north-1", "chat")  # fmt: skip
    llama = added("custom-llama", "Meta", "meta.llama-v1", region="us-west-2")
    m2, _, _ = client([ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "Converse")], llama)
    with pytest.raises(models.ModelUnavailable) as e:
        m2.complete(CTX, task="brainstorm", messages=HELLO, override={"model": "custom-llama"})
    assert (getattr(e.value, "model_id", None), getattr(e.value, "region", None), getattr(e.value, "task", None)) == (
        "meta.llama-v1", "us-west-2", "brainstorm"
    )  # fmt: skip


class IdModels(FakeModels):
    """A ``ModelClient`` whose answers say what was really called, as the Bedrock client's do."""

    def complete(self, ctx: CallContext, *, task: str, messages: list[dict[str, Any]], **kw: Any) -> models.Reply:
        got = super().complete(ctx, task=task, messages=messages, **kw)
        return models.Reply(**{**got.__dict__, "model_id": "global.anthropic.claude-opus-5-5", "region": "eu-north-1",
                               "task": task})  # fmt: skip


def story_job(tmp_path: Path, fake: FakeModels) -> StoryJob:
    from test_stories_pipeline import job_item, story_item, workspace

    table = FakeTable()
    table.seed(workspace())
    table.seed(story_item())
    table.seed(job_item("J1", "S1"))
    d, _ = data(table)
    from ls_fakes import ENGINE_DIR

    svc = Services(data=d, work_root=tmp_path / "work", models=fake, engine_dir=ENGINE_DIR, heartbeat_seconds=0.2,
                   flush_seconds=0.05)  # fmt: skip
    return StoryJob(svc, JobFence(USER, WS, "J1", "S1"), "ST1")


def test_meta_models_keep_the_model_id_and_region_of_each_call_and_of_a_failed_one(tmp_path: Path) -> None:
    job = story_job(tmp_path, IdModels({"captions": {"ok": True}}))
    asyncio.run(job.ask(step="storyboard", agent_id="storyboard", task="captions", messages=HELLO))
    failed = models.ModelUnavailable("No.", model="custom-llama", effort=None, status="denied")
    failed.model_id, failed.region = "meta.llama-v1", "us-west-2"  # type: ignore[attr-defined]
    job.svc.models = FakeModels({"fact_check": failed})
    with pytest.raises(models.ModelUnavailable):
        asyncio.run(job.ask(step="safety", agent_id="quality_assurance", task="fact_check", messages=HELLO))
    assert job.meta["models"] == [
        {"step": "storyboard", "agentId": "storyboard", "task": "captions", "model": "opus-5-5",
         "modelId": "global.anthropic.claude-opus-5-5", "region": "eu-north-1", "effort": "high",
         "effortApplied": True},
        {"step": "safety", "agentId": "quality_assurance", "task": "fact_check", "model": "custom-llama",
         "modelId": "meta.llama-v1", "region": "us-west-2", "effort": None, "effortApplied": False, "failed": True},
    ]  # fmt: skip


def test_a_task_and_a_chat_answer_keep_what_really_ran(tmp_path: Path) -> None:
    from lamostories_agent.tasks.work import run_task
    from test_chat_turn import MSG_SK, PAYLOAD, seed
    from test_chat_turn import run as run_chat
    from test_tasks_support import PK as TPK
    from test_tasks_support import USER as TUSER
    from test_tasks_support import WS as TWS
    from test_tasks_support import FakeModel, reply, services, task_item

    def with_ids(r: models.Reply, task: str) -> models.Reply:
        return models.Reply(**{**r.__dict__, "model_id": "global.anthropic.claude-opus-5-5", "region": "eu-north-1",
                               "task": task})  # fmt: skip

    idea = {"ideas": [{"title": "Pie day", "logline": "A pie rolls away.", "category": "comedy", "tone": "silly",
                       "characterIds": []}]}  # fmt: skip
    payload = {"userId": TUSER, "workspaceId": TWS, "taskId": "T1"}
    svc, db, _ = services(tmp_path, FakeModel(with_ids(reply(json.dumps(idea), data=idea), "brainstorm")))
    db.seed(task_item("T1", "brainstorm", input={"topic": "pie", "count": 1}))
    asyncio.run(run_task(svc, payload))
    task = db.get(TPK, "TASK#T1")
    assert task is not None and task["status"] == "done", task
    assert (task["modelId"], task["region"], task["task"]) == ("global.anthropic.claude-opus-5-5", "eu-north-1",
                                                                "brainstorm")  # fmt: skip

    refused = models.ModelUnavailable("No access.", model="fable-5-2", effort="max", status="denied")
    refused.model_id, refused.region, refused.task = "global.anthropic.claude-fable-5-2", "eu-north-1", "brainstorm"  # type: ignore[attr-defined]
    svc, db, _ = services(tmp_path / "b", FakeModel(refused))
    db.seed(task_item("T1", "brainstorm", input={"topic": "pie"}))
    asyncio.run(run_task(svc, payload))
    task = db.get(TPK, "TASK#T1")
    assert task is not None and task["status"] == "failed" and task["failed"] is True
    assert (task["model"], task["modelId"], task["region"], task["task"]) == (
        "fable-5-2", "global.anthropic.claude-fable-5-2", "eu-north-1", "brainstorm"
    )  # fmt: skip

    svc, db, _ = services(tmp_path / "c", FakeModel(with_ids(reply("Here is one."), "chat")))
    seed(db)
    assert run_chat(svc) == "done"
    answer = db.get(TPK, MSG_SK)
    assert answer is not None and PAYLOAD["msgId"] in MSG_SK
    assert (answer["modelId"], answer["region"], answer["task"]) == ("global.anthropic.claude-opus-5-5", "eu-north-1",
                                                                      "chat")  # fmt: skip
    assert "failed" not in answer and "toolsNotice" not in answer


def test_the_chat_says_once_per_conversation_that_a_model_without_tools_only_talks(tmp_path: Path) -> None:
    from lamostories_agent.chat import turn
    from test_chat_turn import ANSWER, ASK, MSG_SK, conv, msg, pending, seed
    from test_chat_turn import run as run_chat
    from test_tasks_support import PK as TPK
    from test_tasks_support import FakeModel, reply, services

    def talk(text: str) -> models.Reply:
        return models.Reply(**{**reply(text).__dict__, "tools_off": True})

    svc, db, _ = services(tmp_path, FakeModel(talk("Pies are fun.")))
    seed(db)
    assert run_chat(svc) == "done"
    answer = db.get(TPK, MSG_SK)
    assert (
        answer is not None and answer["text"] == f"Pies are fun.\n\n{turn.NO_TOOLS}" and answer["toolsNotice"] is True
    )

    svc, db, _ = services(tmp_path / "b", FakeModel(talk("More pies.")))
    db.seed(conv())
    db.seed(msg("01JD0000000000000000000000", "user", "Hi"))
    db.seed(msg("01JD0000000000000000000001", "assistant", f"Hello.\n\n{turn.NO_TOOLS}", toolsNotice=True))
    db.seed(msg(ASK, "user", "And now?"))
    db.seed(pending())
    assert run_chat(svc) == "done"
    again = db.get(TPK, f"MSG#C1#{ANSWER}")
    assert again is not None and again["text"] == "More pies." and "toolsNotice" not in again  # said once


# --- D7: Check models marks its status ------------------------------------------------------------------------------


def test_check_models_marks_its_status_and_a_later_call_keeps_the_mark(tmp_path: Path) -> None:
    from lamostories_agent.tasks.work import run_task
    from test_tasks_support import PK as TPK
    from test_tasks_support import USER as TUSER
    from test_tasks_support import WS as TWS
    from test_tasks_support import FakeModel, reply, services, task_item

    svc, db, _ = services(tmp_path, FakeModel(reply("ok", model="haiku-5-5", effort="low")))
    db.seed(task_item("T1", "check_models", input={"models": ["haiku-5-5"]}))
    assert asyncio.run(run_task(svc, {"userId": TUSER, "workspaceId": TWS, "taskId": "T1"})) == "done"
    status = db.get(TPK, "MODELSTATUS#haiku-5-5")
    assert status is not None and status["by"] == "check" and status["status"] == "ok"

    m, _, table = client([converse_reply("Hi")], item(keys.modelstatus_sk("opus-5-5"), type="ws_modelstatus",
                                                       model="opus-5-5", status="ok", line="old", by="check"))  # fmt: skip
    m.complete(CTX, task="chat", messages=HELLO)
    kept = table.item(keys.modelstatus_sk("opus-5-5"))
    assert kept is not None and kept["by"] == "check" and kept["line"] == "It answered."  # the mark stays

    m2, _, table2 = client([converse_reply("Hi")])
    m2.complete(CTX, task="chat", messages=HELLO)
    own = table2.item(keys.modelstatus_sk("opus-5-5"))
    assert own is not None and own["status"] == "ok" and "by" not in own  # a chat call never ticks setup step 1


# --- D8: maker and host ---------------------------------------------------------------------------------------------


def test_the_bundled_models_name_their_maker_and_their_host_and_keep_every_other_field() -> None:
    raw = json.loads((REPO / "stories" / "config" / "models.json").read_text("utf-8"))
    wanted = {"key", "label", "provider", "host", "modelId", "profile", "regions", "efforts", "defaultEffort",
              "vision", "pricing", "line"}  # fmt: skip
    for m in raw["models"]:
        assert set(m) == wanted, m["key"]
        assert (m["provider"], m["host"]) == ("Anthropic", "Amazon Bedrock")
        assert m["modelId"].startswith("anthropic.") and m["efforts"]
    for name in ("imageModel", "videoModel"):
        assert (raw[name]["provider"], raw[name]["host"]) == ("Amazon", "Amazon Bedrock")
        assert {"label", "modelId", "region", "pricing"} <= set(raw[name])
    assert raw["defaultModel"] == "opus-5-5" and raw["defaultEffort"] == "high"


# --- D2: Try it for Nova Reel -------------------------------------------------------------------------------------


class FakeUS:
    """Nova Reel in us-east-1 (start/get async invoke) and the US bucket (list and delete)."""

    def __init__(self, *, error: tuple[str, str] | None = None, fail: bool = False) -> None:
        self.error, self.fail = error, fail
        self.starts: list[dict[str, Any]] = []
        self.objects: dict[str, bytes] = {}
        self.deleted: list[str] = []

    def start_async_invoke(self, **kw: Any) -> dict[str, Any]:
        self.starts.append(kw)
        if self.error:
            raise ClientError({"Error": {"Code": self.error[0], "Message": self.error[1]}}, "StartAsyncInvoke")
        uri = kw["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"]
        folder = uri.removeprefix("s3://").split("/", 1)[1] + "inv1"
        self.objects[f"{folder}/output.mp4"] = b"mp4"
        self.objects[f"{folder}/manifest.json"] = b"{}"
        return {"invocationArn": "arn:aws:bedrock:us-east-1:1:async-invoke/inv1"}

    def get_async_invoke(self, **kw: Any) -> dict[str, Any]:
        if self.fail:
            return {"status": "Failed", "failureMessage": "The prompt was blocked."}
        uri = self.starts[0]["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] + "inv1"
        return {"status": "Completed", "outputDataConfig": {"s3OutputDataConfig": {"s3Uri": uri}}}

    def list_objects_v2(self, *, Bucket: str, Prefix: str) -> dict[str, Any]:
        return {"Contents": [{"Key": k} for k in sorted(self.objects) if k.startswith(Prefix)]}

    def delete_objects(self, *, Bucket: str, Delete: dict[str, Any]) -> dict[str, Any]:
        for o in Delete["Objects"]:
            self.deleted.append(o["Key"])
            self.objects.pop(o["Key"], None)
        return {}


BUCKET = "cf-prod-stories-video-123456789012-us"
CHECK_PREFIX = f"ws/{USER}/{WS}/checks/nova-reel/J9/"


def check_world(
    tmp_path: Path, fake: FakeUS | None, *, bucket: str = BUCKET, job_type: str = "provider_check"
) -> tuple[Services, FakeTable]:
    from ls_fakes import ENGINE_DIR

    table = FakeTable()
    table.seed(item("PJOB#J9", type="ws_pjob", jobId="J9", jobType=job_type, contentType="provider",
                    contentId="nova-reel", status="queued",
                    steps=[{"key": "check", "label": "Try it", "status": "pending"}], progress=0, configuration={},
                    meta={}, sessionId="S9"))  # fmt: skip
    d, _ = data(table)

    async def no_wait(_: float) -> None:
        return None

    svc = Services(data=d, work_root=tmp_path / "work", models=FakeModels({}), engine_dir=ENGINE_DIR,
                   video_bucket=bucket, video_model_id="amazon.nova-reel-v1:1",
                   reel_client=(lambda: fake) if fake else None, us_s3=(lambda: fake) if fake else None,
                   reel_sleep=no_wait, heartbeat_seconds=0.2, flush_seconds=0.05)  # fmt: skip
    return svc, table


def run_check(svc: Services) -> str:
    from lamostories_agent.provider_check import ProviderCheckJob

    return asyncio.run(ProviderCheckJob(svc, JobFence(USER, WS, "J9", "S9"), "nova-reel").run())


def test_try_it_makes_one_6_second_test_shot_proves_nova_reel_and_deletes_the_file(tmp_path: Path) -> None:
    from lamostories_agent.provider_check import TRIED

    fake = FakeUS()
    svc, table = check_world(tmp_path, fake)
    assert run_check(svc) == "ready"
    (start,) = fake.starts
    assert start["modelId"] == "amazon.nova-reel-v1:1"
    assert start["modelInput"]["videoGenerationConfig"]["durationSeconds"] == 6
    assert start["modelInput"]["videoGenerationConfig"]["dimension"] == "1280x720"
    assert start["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] == f"s3://{BUCKET}/{CHECK_PREFIX}"
    assert fake.objects == {} and sorted(fake.deleted) == [f"{CHECK_PREFIX}inv1/manifest.json",
                                                            f"{CHECK_PREFIX}inv1/output.mp4"]  # fmt: skip
    record = table.item(keys.provider_sk("animation", "nova-reel"))
    assert record is not None and record["state"] == "on" and "lastError" not in record and record["checkedAt"]
    job = table.item("PJOB#J9")
    assert job is not None and job["status"] == "ready" and job["steps"][0]["message"] == TRIED
    assert job["meta"]["providers"] == {"animation": "nova-reel"} and job["progress"] == 1.0
    (usage,) = table.prefix("USAGE#")
    assert (usage["provider"], usage["units"], usage["unit"], usage["kind"]) == ("nova-reel", 6, "second", "provider")


def test_try_it_records_bedrock_s_refusal_and_still_deletes_the_test_shot(tmp_path: Path) -> None:
    from lamostories_agent.providers import REEL_NOT_ENABLED, REEL_SETUP

    fake = FakeUS(error=("AccessDeniedException", "You don't have access to the model with the specified model ID."))
    svc, table = check_world(tmp_path, fake)
    assert run_check(svc) == "failed"
    record = table.item(keys.provider_sk("animation", "nova-reel"))
    assert record is not None and record["state"] == "needs_setup"
    assert (
        record["lastError"]
        == f"{REEL_NOT_ENABLED} Bedrock said: “You don't have access to the model with the specified model ID.”"
    )
    job = table.item("PJOB#J9")
    assert job is not None and job["status"] == "failed" and job["error"].startswith(REEL_SETUP)
    assert "Bedrock said" in job["error"] and job["steps"][0]["status"] == "failed"

    blocked = FakeUS(fail=True)
    svc, table = check_world(tmp_path / "b", blocked)
    assert run_check(svc) == "failed"
    assert blocked.objects == {}  # the failed shot's files are gone too
    record = table.item(keys.provider_sk("animation", "nova-reel"))
    assert record is not None and "The prompt was blocked." in record["lastError"]


def test_try_it_without_the_us_bucket_calls_nothing_and_says_the_not_ready_sentence(tmp_path: Path) -> None:
    from lamostories_agent.providers import REEL_NO_BUCKET

    fake = FakeUS()
    svc, table = check_world(tmp_path, fake, bucket="")
    assert run_check(svc) == "failed"
    assert fake.starts == [] and table.item(keys.provider_sk("animation", "nova-reel")) is None
    job = table.item("PJOB#J9")
    assert job is not None and job["error"] == REEL_NO_BUCKET


def test_try_it_only_runs_a_provider_check_job(tmp_path: Path) -> None:
    fake = FakeUS()
    svc, table = check_world(tmp_path, fake, job_type="produce")
    assert run_check(svc) == "ignored" and fake.starts == []
    assert table.item("PJOB#J9")["status"] == "queued"  # type: ignore[index]


def test_the_provider_check_action_is_registered_and_answers_at_once() -> None:
    from starlette.testclient import TestClient

    from lamostories_agent import provider_check
    from lamostories_agent.runner import JobRunner, register
    from lamostories_agent.server import SESSION_HEADER, Actions, create_app

    ran: list[str] = []

    class FakeJob:
        def __init__(self, svc: Any, fence: Any, content_id: str) -> None:
            self.fence, self.content_id = fence, content_id

        async def run(self) -> str:
            ran.append(f"{self.fence.job_id}:{self.content_id}")
            return "ready"

    class Svc:
        work_root = Path("/tmp/ls-test-work")

    saved = provider_check.ProviderCheckJob
    provider_check.ProviderCheckJob = FakeJob  # type: ignore[misc,assignment]
    try:
        actions = Actions()
        register(actions, JobRunner(), Svc)
    finally:
        provider_check.ProviderCheckJob = saved  # type: ignore[misc]
    assert "provider_check" in actions.table
    client = TestClient(create_app(actions))
    with client:
        body = {"action": "provider_check", "userId": "u1", "workspaceId": "stories", "jobId": "J9"}
        r = client.post("/invocations", json=body, headers={SESSION_HEADER: "cfstory-J9-abcdefgh" + "x" * 16})
        assert r.json() == {"accepted": True, "id": "J9"}
        client.portal.call(asyncio.sleep, 0.05)  # type: ignore[union-attr]
        bad = client.post("/invocations", json={**body, "providerId": "../x"}, headers={SESSION_HEADER: "S1"})
        assert bad.json()["accepted"] is False
    assert ran == ["J9:nova-reel"]


# --- D9: a failed re-analysis keeps its study -------------------------------------------------------------------------


def test_a_failed_re_analysis_keeps_the_study_and_one_with_no_study_fails(tmp_path: Path) -> None:
    from lamostories_agent.refjob import ReferenceJob

    folder = f"ws/{USER}/{WS}/references/R1/"

    def ref_job(study: bool) -> tuple[ReferenceJob, FakeTable]:
        table = FakeTable()
        steps = [{"key": "look", "label": "Look at it", "status": "pending"}]
        table.seed(item("PJOB#J1", type="ws_pjob", jobId="J1", contentType="reference", contentId="R1",
                        jobType="reference_analysis", status="queued", steps=steps, progress=0,
                        configuration={"run": ["look"]}, meta={}, sessionId="S1"))  # fmt: skip
        table.seed(item("REFVID#R1", type="ws_refvid", refId="R1", title="Cat", status="analyzing",
                        key=folder + "source.mp4", currentJobId="J1",
                        **({"analysisKey": folder + "analysis.json"} if study else {})))  # fmt: skip
        d, store = data(table)
        store.objects[folder + "source.mp4"] = (b"not a video at all", "video/mp4")  # still there: never cleared
        svc = Services(data=d, work_root=tmp_path / f"w{study}", models=FakeModels({}), heartbeat_seconds=0.2,
                       flush_seconds=0.05)  # fmt: skip
        return ReferenceJob(svc, JobFence(USER, WS, "J1", "S1"), "R1"), table

    job, table = ref_job(True)
    assert asyncio.run(job.run()) == "failed"
    ref = table.item("REFVID#R1")
    assert ref is not None and ref["status"] == "analyzed" and "currentJobId" not in ref  # the earlier study stays
    job, table = ref_job(False)
    assert asyncio.run(job.run()) == "failed"
    assert table.item("REFVID#R1")["status"] == "failed"  # type: ignore[index]


def test_a_cleared_video_that_was_never_studied_does_not_claim_a_study(tmp_path: Path) -> None:
    from lamostories_agent.refjob import REMOVED, REMOVED_NO_STUDY, ReferenceJob
    from lamostories_agent.util import UserFacingError

    job = ReferenceJob.__new__(ReferenceJob)
    with pytest.raises(UserFacingError) as e:
        asyncio.run(job._source({"fileRemovedAt": "2026-11-22T00:00:00.000Z"}))
    assert str(e.value) == REMOVED_NO_STUDY and "study stays" not in str(e.value)
    with pytest.raises(UserFacingError) as e:
        asyncio.run(job._source({"sourceRemovedAt": "2026-11-22T00:00:00.000Z", "analysisKey": "k"}))  # the old name
    assert str(e.value) == REMOVED


def test_the_writer_and_the_chat_take_a_reference_whose_study_exists_whatever_its_status(tmp_path: Path) -> None:
    from lamostories_agent.chat import tools
    from lamostories_agent.tasks.fence import MSG_LIVE, Fence
    from test_tasks_support import PK as TPK
    from test_tasks_support import USER as TUSER
    from test_tasks_support import WS as TWS
    from test_tasks_support import FakeModel, character_item, idea_item, services

    job = story_job(tmp_path, FakeModels({}))
    folder = f"ws/{USER}/{WS}/references/"
    table: FakeTable = job.data.store.table  # type: ignore[attr-defined]
    for ref_id, status, key in (("R1", "analyzing", f"{folder}R1/analysis.json"),
                                ("R2", "failed", f"{folder}R2/analysis.json"),
                                ("R3", "analyzed", f"{folder}R1/analysis.json"),  # another reference's file
                                ("R4", "ready", None)):  # fmt: skip
        table.seed(item(f"REFVID#{ref_id}", refId=ref_id, title=ref_id, status=status,
                        **({"analysisKey": key} if key else {})))  # fmt: skip
    for ref_id in ("R1", "R2"):
        job.data.store.objects[f"{folder}{ref_id}/analysis.json"] = (  # type: ignore[attr-defined]
            json.dumps({"summary": f"Study of {ref_id}"}).encode(), "application/json")  # fmt: skip
    job.story = {"referenceIds": ["R1", "R2", "R3"]}
    got = asyncio.run(job._references())
    assert [r["title"] for r in got] == ["R1", "R2"] and got[0]["analysis"]["summary"] == "Study of R1"

    svc, db, _ = services(tmp_path / "chat", FakeModel())
    db.seed(
        {"pk": TPK, "sk": "MSG#C1#M2", "userId": TUSER, "workspaceId": TWS, "status": "streaming", "sessionId": "s1"}
    )
    box = tools.Toolbox(
        svc, TUSER, TWS, TPK, Fence(svc.store, TPK, "MSG#C1#M2", "s1", live=MSG_LIVE), catalog=svc.catalog
    )
    db.seed(character_item("C1", "Bo"))
    db.seed(idea_item("I1"))
    tfolder = f"ws/{TUSER}/{TWS}/references/"
    db.seed({"pk": TPK, "sk": "REFVID#R1", "userId": TUSER, "workspaceId": TWS, "refId": "R1", "status": "failed",
             "analysisKey": f"{tfolder}R1/analysis.json"})  # fmt: skip
    db.seed({"pk": TPK, "sk": "REFVID#R2", "userId": TUSER, "workspaceId": TWS, "refId": "R2", "status": "analyzed",
             "analysisKey": f"{tfolder}R9/analysis.json"})  # fmt: skip
    result, ok = box.run("offer_make_video", {"ideaId": "I1", "characterIds": ["C1"], "referenceIds": ["R1"]})
    assert ok, result
    result, ok = box.run("offer_make_video", {"ideaId": "I1", "characterIds": ["C1"], "referenceIds": ["R2"]})
    assert not ok and "not been analyzed" in str(result["error"])
    listed = {r["refId"]: r["studied"] for r in box.run("list_references", {})[0]["references"]}
    assert listed == {"R1": True, "R2": False}


# --- D13: post captions follow the video's shape -----------------------------------------------------------------


def test_post_captions_say_the_video_s_shape_and_only_a_vertical_video_gets_shorts() -> None:
    raw = {f: "A fun ride. #shorts #cars" if f == "youtubeDescription" else "Hi" for f in writer.POST_FIELDS}
    assert writer.post_captions(raw, None, "16:9")["youtubeDescription"] == "A fun ride. #cars"
    assert writer.post_captions(raw, None, "1:1")["youtubeDescription"] == "A fun ride. #cars"
    assert writer.post_captions({**raw, "youtubeDescription": "A fun ride."}, None, "9:16")["youtubeDescription"] == (
        "A fun ride. #shorts"
    )  # fmt: skip
    wide = {"title": "T", "width": 1920, "height": 1080, "cast": {}, "scenes": []}
    message = writer.captions_request(wide, None, keep={})[0]["content"]
    assert "a short wide animated" in message[0]["text"] and "No #shorts" in message[0]["text"]
    assert "#shorts." not in message[0]["text"]
    assert json.loads(message[1]["text"].split("\n", 1)[1])["format"] == {"aspect": "16:9", "shape": "wide"}
    tall = writer.captions_request({**wide, "width": 1080, "height": 1920}, None, keep={})[0]["content"][0]["text"]
    assert "a short vertical animated" in tall and "ending with #shorts." in tall and tall == writer.CAPTIONS_PROMPT


def test_write_them_again_for_a_wide_story_says_wide_and_adds_no_shorts(tmp_path: Path) -> None:
    from lamostories_agent.tasks import captions
    from lamostories_agent.tasks.work import run_task
    from test_tasks_support import PK as TPK
    from test_tasks_support import USER as TUSER
    from test_tasks_support import WS as TWS
    from test_tasks_support import FakeModel, reply, services, task_item

    answer = {"youtubeTitle": "Ice!", "youtubeDescription": "Slippery day.", "instagram": "Ice #fun",
              "facebook": "Ice", "tiktok": "Ice #fun", "x": "Ice"}  # fmt: skip
    model = FakeModel(reply(json.dumps(answer), data=answer))
    svc, db, s3 = services(tmp_path, model)
    key = f"ws/{TUSER}/{TWS}/stories/S1/script/v1.json"
    s3.objects[key] = json.dumps({"title": "Ice", "width": 1920, "height": 1080, "cast": {}, "scenes": []}).encode()
    db.seed({"pk": TPK, "sk": "STORY#S1", "userId": TUSER, "workspaceId": TWS, "storyId": "S1", "title": "Ice",
             "scriptKey": key, "scriptVersion": 1, "format": {"aspect": "16:9", "width": 1920, "height": 1080}})  # fmt: skip
    db.seed(task_item("T1", "captions", input={"storyId": "S1"}))
    assert asyncio.run(run_task(svc, {"userId": TUSER, "workspaceId": TWS, "taskId": "T1"})) == "done"
    text = model.texts(0)
    assert "a short wide cartoon" in text and "with no #shorts" in text and '"shape": "wide"' in text
    result = db.get(TPK, "TASK#T1")["result"]["postCaptions"]  # type: ignore[index]
    assert result["youtubeDescription"] == "Slippery day." and "#shorts" not in result["youtubeDescription"]
    assert captions.brief("9:16") == captions.BRIEF and "a short vertical cartoon" in captions.BRIEF


# --- D14: the ASS writer uses the engine's safe boxes ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("width", "height", "x", "y"),
    [(1080, 1080, 540, 925), (720, 720, 360, 617), (1920, 1080, 960, 925), (1280, 720, 640, 617)],
)
def test_an_engine_caption_at_its_square_or_wide_place_is_not_moved(width: int, height: int, x: int, y: int) -> None:
    k = min(width, height) / 1080
    for text in ("Ease off", "Ease off the accelerator and look where you want to go"):
        lines = text if len(text) < 20 else "Ease off the accelerator\nand look where you want to go"
        caption = {"kind": "caption", "start": 0, "end": 2, "text": lines, "x": x, "y": y, "size": round(64 * k)}
        out = ass.build([caption], width=width, height=height)
        assert f"\\pos({x},{y})" in out, out.splitlines()[-1]
    f = ass.frame(width, height)
    box = {name: round(v * k) for name, v in ass.ENGINE_SAFE["1:1" if width == height else "16:9"].items()}
    assert (f.left, f.top, f.right, f.bottom) == (box["left"], box["top"], box["right"], box["bottom"])


def test_the_catalog_s_safe_box_wins_and_a_bad_one_is_ignored() -> None:
    formats = [{"aspect": "1:1", "width": 1080, "height": 1080, "safe": {"left": 60, "top": 70, "right": 1000,
                "bottom": 990}}]  # fmt: skip
    safe = ass.safe_box(formats, 1080, 1080)
    assert safe == {"left": 60, "top": 70, "right": 1000, "bottom": 990} and ass.safe_box(formats, 720, 720) is None
    f = ass.frame(1080, 1080, safe)
    assert (f.left, f.top, f.right, f.bottom) == (60, 70, 1000, 990)
    assert (
        ass.frame(1080, 1080, {"left": 900, "top": 0, "right": 100, "bottom": 10}).bottom == 1026
    )  # nonsense: kept out
    tall = ass.frame(1080, 1920)
    assert (tall.left, tall.right, tall.top, tall.bottom) == (
        ass.SAFE_LEFT,
        ass.SAFE_RIGHT,
        ass.SAFE_TOP,
        ass.SAFE_BOTTOM,
    )


@needs_deno
def test_the_writer_s_copy_of_the_safe_boxes_is_the_engine_s_for_all_six_sizes(tmp_path: Path) -> None:
    from lamostories_agent.engine import Engine
    from ls_fakes import ENGINE_DIR

    got = asyncio.run(Engine(ENGINE_DIR, tmp_path / ".deno").catalog())
    sizes = [(f["width"], f["height"]) for f in got["formats"]]
    assert len(sizes) == 6
    for w, h in sizes:
        f = ass.frame(w, h)
        assert ass.safe_box(got["formats"], w, h) == {"left": f.left, "top": f.top, "right": f.right,
                                                        "bottom": f.bottom}, (w, h)  # fmt: skip


# --- D15: each cast member acts like itself -----------------------------------------------------------------------


def test_the_writer_is_told_each_cast_member_acts_like_itself_and_uses_its_favourite_effects() -> None:
    rule = "Each cast member acts like its personality and traits, and its own sound moments use its favouriteEffects"
    assert rule in " ".join(writer.SYSTEM.split())
    storyboard = next(a for a in config.agents()["agents"] if a["agentId"] == "storyboard")
    assert rule in storyboard["instructions"]
    cast = {"c1": {"characterId": "ch1", "name": "Bo", "movementStyle": "bouncy",
                   "voice": {"noises": ["giggle"], "sfx": ["boing", "pop"]}}}  # fmt: skip
    chars = {"ch1": {"personality": "Cheeky and brave.", "traits": ["cheeky"], "expressions": ["neutral", "happy"]}}
    (brief,) = writer.cast_brief(cast, chars)
    assert brief["favouriteEffects"] == ["boing", "pop"] and brief["personality"] == "Cheeky and brave."
    assert brief["traits"] == ["cheeky"]
