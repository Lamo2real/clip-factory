"""Round 5 of Lamo Stories' agent (the final check's decisions, §45.36): the idea, expand and chat briefs follow the
video's shape (E5); Check models sends a tool-using model one tiny tool, and Bedrock's tool-use refusal has its own
sentence in the check, the chat and the tasks (E6); ``meta.providers.writer`` names the model that really wrote
(E7); the agent calls the other app Clip Factory (E13). Fakes only: no AWS, no network."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any, ClassVar

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import config, keys, models, providers
from lamostories_agent.data import JobFence
from lamostories_agent.models import BedrockModels, CallContext
from lamostories_agent.pipeline import Services, StoryJob
from lamostories_agent.tasks import check, ideas
from lamostories_agent.tasks.work import run_task
from ls_fakes import PK, USER, WS, FakeModels, FakeRuntime, FakeStore, FakeTable, converse_reply, needs_deno
from test_tasks_support import PK as TPK
from test_tasks_support import USER as TUSER
from test_tasks_support import WS as TWS
from test_tasks_support import FakeModel, idea_item, reply, services, task_item

REPO = Path(__file__).resolve().parents[3]
TASK = {"userId": TUSER, "workspaceId": TWS, "taskId": "T1"}
CTX = CallContext(user_id=USER, workspace_id=WS, agent_id="creative_director", session_id="S1", task_id="T1")
HELLO = [{"role": "user", "content": [{"text": "Hello"}]}]
TOOL = {"name": "list_ideas", "description": "The owner's ideas.", "input_schema": {"type": "object"}}
STREAM_NO_TOOLS = "This model doesn't support tool use in streaming mode."


def run(svc: Any, payload: dict[str, Any] = TASK) -> str:
    return asyncio.run(run_task(svc, payload))


def registry(db: Any, configuration: dict[str, Any]) -> None:
    db.seed({"pk": f"USER#{TUSER}#WSREG", "sk": f"WS#{TWS}", "configuration": configuration})


def drafts(n: int = 1) -> dict[str, Any]:
    one = {"title": "Pie day", "logline": "A pie rolls away.", "category": "comedy", "topicId": "", "characters": []}
    return {"ideas": [dict(one, title=f"Pie day {i}") for i in range(n)]}


def data_of(text: str) -> dict[str, Any]:
    found: dict[str, Any] = json.loads(text.split("DATA as JSON:\n", 1)[1].split("\n", 1)[0])
    return found


# --- E5: the briefs follow the video's shape -----------------------------------------------------------------------


def test_the_house_brief_says_the_shape_and_is_never_a_fixed_vertical_frame() -> None:
    assert ideas.house_brief("16:9").splitlines()[1].startswith("1. A wide 16:9 cartoon")
    assert ideas.house_brief("1:1").splitlines()[1].startswith("1. A square 1:1 cartoon")
    assert ideas.house_brief("9:16").splitlines()[1].startswith("1. A vertical 9:16 cartoon")
    assert ideas.house_brief("4:3") == ideas.house_brief("9:16")  # an unknown shape is the default one
    assert not hasattr(ideas, "HOUSE_BRIEF")  # no fixed brief left to send by mistake
    # instructions the owner edited from an earlier vertical-only default (or a skill, or a memory) may still say
    # "vertical 9:16": the picked shape wins over them
    first_rule = ideas.house_brief("1:1").splitlines()[1]
    assert first_rule.endswith("This shape wins over any other shape named in your instructions, skills or notes.")
    source = (REPO / "stories/agent/src/lamostories_agent/tasks/ideas.py").read_text()
    assert "1. A vertical 9:16" not in source and "A vertical 9:16 cartoon" not in source


@pytest.mark.parametrize(
    ("configuration", "words", "aspect"),
    [
        ({"video": {"aspect": "16:9", "resolution": "1920x1080"}}, "A wide 16:9 cartoon", "16:9"),
        ({"video": {"aspect": "1:1", "resolution": "1080x1080"}}, "A square 1:1 cartoon", "1:1"),
        ({"video": {"resolution": "1280x720"}}, "A wide 16:9 cartoon", "16:9"),  # an older config: its size says it
        ({}, "A vertical 9:16 cartoon", "9:16"),
    ],
)
def test_ai_ideas_follow_the_workspace_s_default_shape(
    tmp_path: Path, configuration: dict[str, Any], words: str, aspect: str
) -> None:
    model = FakeModel(reply(data=drafts(1)))
    svc, db, _ = services(tmp_path, model)
    registry(db, configuration)
    db.seed(task_item("T1", "brainstorm", input={"topic": "picnics", "count": 1}))
    assert run(svc) == "done"
    text = model.texts(0)
    assert words in text and (aspect == "9:16" or "vertical 9:16" not in text)
    assert data_of(text)["format"] == {"aspect": aspect, "shape": {"9:16": "vertical", "1:1": "square",
                                                                   "16:9": "wide"}[aspect]}  # fmt: skip


def test_expand_and_variations_of_a_square_workspace_are_written_for_a_square_frame(tmp_path: Path) -> None:
    concept = {"premise": "Bo chases a pie.", "beats": ["a", "b", "c"], "lesson": "", "ending": "e", "tone": "funny",
               "onScreenText": []}  # fmt: skip
    model = FakeModel(reply(data=concept))
    svc, db, _ = services(tmp_path, model)
    registry(db, {"video": {"aspect": "1:1", "resolution": "1080x1080"}, "defaultDurationSec": 40})
    db.seed(idea_item("I1"))
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1"}))
    assert run(svc) == "done"
    text = model.texts(0)
    assert "A square 1:1 cartoon" in text and "vertical 9:16" not in text and "40 seconds" in text
    assert data_of(text)["format"] == {"aspect": "1:1", "shape": "square"}

    model = FakeModel(reply(data=drafts(1)))
    svc, db, _ = services(tmp_path / "v", model)
    registry(db, {"video": {"aspect": "1:1", "resolution": "1080x1080"}})
    db.seed(idea_item("I1"))
    db.seed(task_item("T1", "variations", input={"ideaId": "I1", "count": 1}))
    assert run(svc) == "done"
    assert "A square 1:1 cartoon" in model.texts(0) and data_of(model.texts(0))["format"]["aspect"] == "1:1"


def test_the_chat_plans_for_the_workspace_s_shape_or_the_story_s_own(tmp_path: Path) -> None:
    from test_chat_turn import conv, seed
    from test_chat_turn import run as run_chat

    wide = {"video": {"aspect": "16:9", "resolution": "1920x1080"}}
    model = FakeModel(reply("Here is one."))
    svc, db, _ = services(tmp_path, model)
    registry(db, wide)
    seed(db)
    assert run_chat(svc) == "done"
    assert "A wide 16:9 cartoon" in model.texts(0) and "vertical 9:16" not in model.texts(0)

    # a conversation about a square story plans for that story's own frame, whatever the workspace's default
    model = FakeModel(reply("Here is one."))
    svc, db, _ = services(tmp_path / "s", model)
    registry(db, wide)
    db.seed({"pk": TPK, "sk": "STORY#ST1", "userId": TUSER, "workspaceId": TWS, "storyId": "ST1", "title": "Pie",
             "status": "draft", "format": {"aspect": "1:1", "width": 1080, "height": 1080}})  # fmt: skip
    seed(db, conversation=conv(projectRef={"kind": "story", "id": "ST1"}))
    assert run_chat(svc) == "done"
    text = model.texts(0)
    assert "A square 1:1 cartoon" in text and "A wide 16:9 cartoon" not in text and "about this story" in text

    # a story made before stories had a format is 9:16 (as the API shows it), never the workspace's wide default
    model = FakeModel(reply("Here is one."))
    svc, db, _ = services(tmp_path / "o", model)
    registry(db, wide)
    db.seed({"pk": TPK, "sk": "STORY#ST2", "userId": TUSER, "workspaceId": TWS, "storyId": "ST2", "title": "Old pie",
             "status": "review"})  # fmt: skip
    seed(db, conversation=conv(projectRef={"kind": "story", "id": "ST2"}))
    assert run_chat(svc) == "done"
    text = model.texts(0)
    assert "A vertical 9:16 cartoon" in text and "A wide 16:9 cartoon" not in text and "about this story" in text


def test_the_creative_director_s_own_instructions_are_not_only_for_vertical_videos() -> None:
    director = next(a for a in config.agents()["agents"] if a["agentId"] == "creative_director")
    words = director["instructions"]
    assert "short vertical cartoons (9:16" not in words
    assert "square 1:1" in words and "wide 16:9" in words and "usually vertical 9:16" in words


def test_an_agent_still_holding_an_earlier_default_gets_today_s_and_edited_words_stay() -> None:
    from lamostories_agent import agents

    base = agents.default_agents()
    director = base["creative_director"]
    old, *_ = director["formerInstructions"]  # the first; the next is the one from before the rename
    assert "short vertical cartoons (9:16" in old  # what the API copied into AGENT# before round 5
    stored = item(keys.agent_sk("creative_director"), agentId="creative_director", instructions=old, active=True,
                  skillIds=[], version=1)  # fmt: skip
    m, runtime, _ = bedrock([converse_reply("Hi")], stored)
    m.complete(CTX, task="chat", messages=HELLO)
    system = " ".join(str(b.get("text") or "") for b in runtime.requests[0]["system"])
    assert "short vertical cartoons (9:16" not in system and director["instructions"] in system
    assert (
        agents.profile_from("creative_director", {"instructions": f"  {old.replace(' ', '  ')}\n"}).instructions
        == (director["instructions"])
    )  # the same words with other spacing are still untouched
    mine = old + " Always add a dog."
    assert agents.profile_from("creative_director", {"instructions": mine}).instructions == mine  # the owner's own
    storyboard = base["storyboard"]  # its first default (before the cast rule of §45.35 D15) gets today's too
    assert (
        agents.profile_from("storyboard", {"instructions": storyboard["formerInstructions"][0]}).instructions
        == (storyboard["instructions"])
    )
    for a in base.values():
        assert a["instructions"] not in a.get("formerInstructions", [])


def test_the_hooks_skill_and_the_reference_study_are_for_every_shape() -> None:
    from lamostories_agent.reference import study

    skill = (REPO / "stories" / "skills" / "vertical-short-hooks" / "SKILL.md").read_text("utf-8")
    assert "square 1:1" in skill and "wide 16:9" in skill and "**Every shape works.**" in skill
    assert "**Keep the subject in the middle third**" not in skill  # the vertical-only rule is one shape's now
    assert "vertical cartoons" not in study.MERGE_BRIEF and "short cartoons (vertical, square or wide)" in (
        study.MERGE_BRIEF
    )


# --- E6: tools in Check models, and Bedrock's tool-use refusal in its own words -------------------------------------


def item(sk: str, **fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": sk, "userId": USER, "workspaceId": WS, **fields}


def added(key: str, provider: str, model_id: str, **over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {"type": "ws_modeldef", "key": key, "label": f"{provider} model", "provider": provider,
                              "modelId": model_id, "region": "us-west-2", "efforts": [], "defaultEffort": None,
                              "vision": False, "maxOutputTokens": 4096, "price": None}  # fmt: skip
    return item(f"MODELDEF#{key}", **{**fields, **over})


class Runtime(FakeRuntime):
    """Also says which operation each request went to (Converse or ConverseStream)."""

    def __init__(self, replies: list[Any]) -> None:
        super().__init__(replies)
        self.ops: list[str] = []

    def converse(self, **body: Any) -> dict[str, Any]:
        self.ops.append("converse")
        return super().converse(**body)

    def converse_stream(self, **body: Any) -> dict[str, Any]:
        self.ops.append("converse_stream")
        return super().converse_stream(**body)


def bedrock(replies: list[Any], *seed: dict[str, Any]) -> tuple[BedrockModels, Runtime, FakeTable]:
    table = FakeTable()
    for it in seed:
        table.seed(it)
    store = FakeStore(table)
    runtime = Runtime(replies)
    m = BedrockModels(table=table, get_bytes=store.get_bytes_sync, client=runtime, region="eu-north-1",
                      sleep=lambda _: None)  # fmt: skip
    return m, runtime, table


def refusal(message: str = STREAM_NO_TOOLS, code: str = "ValidationException") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, "ConverseStream")  # type: ignore[arg-type]


def test_a_tool_use_refusal_is_its_own_sentence_naming_the_switch_and_the_model_status_says_it() -> None:
    llama = added("custom-llama", "Meta", "meta.llama4-maverick-17b-instruct-v1:0", tools=True,
                  label="Meta Llama 4 Maverick")  # fmt: skip
    m, runtime, table = bedrock([refusal()], llama)
    with pytest.raises(models.ModelUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO, override={"model": "custom-llama"}, tools=[TOOL],
                   on_text=lambda _: None)  # fmt: skip
    sentence = models.TOOLS_REFUSED.format(label="Meta Llama 4 Maverick")
    assert isinstance(e.value, models.ToolsUnavailable) and str(e.value) == sentence
    assert sentence.startswith("Meta Llama 4 Maverick does not accept tool use here")
    assert sentence.endswith(
        'Tap Edit on its row in Clips Funded › Settings › AI and turn off "It can use tools", then tap Check models.'
    )  # saving the switch keeps the old status (D6), so the sentence names the step that clears it
    assert (e.value.status, e.value.model, getattr(e.value, "sent", None)) == ("error", "custom-llama", True)
    assert getattr(e.value, "model_id", None) == "meta.llama4-maverick-17b-instruct-v1:0"  # what was asked (D5)
    assert runtime.ops == ["converse_stream"] and "toolConfig" in runtime.requests[0]
    status = table.item(keys.modelstatus_sk("custom-llama"))
    assert status is not None and (status["status"], status["line"]) == ("error", sentence)

    # a bundled model has no Tools switch: another model is the fix
    m2, _, _ = bedrock([refusal("This model doesn't support tool use.")])
    with pytest.raises(models.ToolsUnavailable) as e2:
        m2.complete(CTX, task="chat", messages=HELLO, tools=[TOOL])
    assert str(e2.value) == models.TOOLS_REFUSED_BUNDLED.format(label="Claude Opus 5.5")


def test_only_a_refusal_of_the_tools_themselves_gets_the_tools_sentence() -> None:
    # a malformed tool schema is the app's own problem: a plain failure, never "does not accept tool use"
    bad = refusal("toolConfig.tools.0.toolSpec.inputSchema.json: failed to satisfy constraint")
    m, _, table = bedrock([bad])
    with pytest.raises(ClientError):
        m.complete(CTX, task="chat", messages=HELLO, tools=[TOOL])
    assert table.item(keys.modelstatus_sk("opus-5-5"))["line"] == models.STATUS_LINES["error"]  # type: ignore[index]
    # no tools were sent: a tool phrase in another error is not about them
    m2, _, _ = bedrock([refusal()])
    with pytest.raises(ClientError):
        m2.complete(CTX, task="brainstorm", messages=HELLO)
    for said, refused in [
        ("This model doesn't support tool use.", True),
        ("This model doesn't support tool use in streaming mode.", True),
        ("The model returned the following errors: tool calling is not supported for this model", True),
        ("The provided model doesn't support tool use.", True),
        ("The provided model identifier is invalid.", False),
        ("Malformed input request: toolConfig.tools.0 is invalid", False),
    ]:
        assert models.tools_refused(refusal(said)) is refused, said
    assert models.tools_refused(refusal(STREAM_NO_TOOLS, code="AccessDeniedException")) is False


def test_check_models_sends_a_tool_using_model_one_tiny_tool_streamed_and_a_model_without_tools_none(
    tmp_path: Path,
) -> None:
    llama = {"pk": TPK, "sk": "MODELDEF#custom-llama", "userId": TUSER, "workspaceId": TWS, "key": "custom-llama",
             "label": "Llama", "provider": "Meta", "modelId": "meta.llama-v1", "region": "us-west-2"}  # fmt: skip
    model = FakeModel(reply("ok"), reply("ok", model="custom-llama", effort=None, applied=False))
    svc, db, _ = services(tmp_path, model)
    db.seed(llama)
    db.seed(task_item("T1", "check_models", input={"models": ["opus-5-5", "custom-llama"]}))
    streamed: list[bool] = []
    original = model.complete

    def complete(ctx: Any, **kw: Any) -> models.Reply:
        streamed.append(kw.get("on_text") is not None)
        return original(ctx, **kw)

    model.complete = complete  # type: ignore[method-assign]
    assert run(svc) == "done"
    claude, own = model.calls
    assert claude["tools"] == [check.CHECK_TOOL] and own["tools"] is None
    assert streamed == [True, False]  # streamed as the chat calls it, only where tools are sent
    assert all(c["max_tokens"] <= 512 for c in model.calls)


def test_check_models_shows_the_tools_sentence_for_a_model_that_refuses_tools(tmp_path: Path) -> None:
    sentence = models.TOOLS_REFUSED.format(label="Llama")
    refused = models.ToolsUnavailable(sentence, model="custom-llama", effort=None, status="error")
    refused.__cause__ = refusal()
    llama = {"pk": TPK, "sk": "MODELDEF#custom-llama", "userId": TUSER, "workspaceId": TWS, "key": "custom-llama",
             "label": "Llama", "provider": "Meta", "modelId": "meta.llama-v1", "region": "us-west-2",
             "tools": True}  # fmt: skip
    model = FakeModel(refused)
    svc, db, _ = services(tmp_path, model)
    db.seed(llama)
    db.seed(task_item("T1", "check_models", input={"models": ["custom-llama"]}))
    assert run(svc) == "done"
    assert model.calls[0]["tools"] == [check.CHECK_TOOL]  # its saved Tools switch is on: the check sends one
    status = db.get(TPK, "MODELSTATUS#custom-llama")
    assert (status["status"], status["line"], status["by"]) == ("error", sentence, "check")
    assert db.get(TPK, "TASK#T1")["result"]["models"][0]["line"] == sentence


def test_a_tool_using_check_goes_out_with_the_tool_and_automatic_choice() -> None:
    m, runtime, _ = bedrock([{"stream": [{"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "ok"}}},
                                         {"messageStop": {"stopReason": "end_turn"}}]}])  # fmt: skip
    got = m.complete(CTX, task=models.CHECK_TASK, messages=HELLO, override={"model": "opus-5-5", "effort": "low"},
                     max_tokens=512, tools=[check.CHECK_TOOL], on_text=lambda _: None)  # fmt: skip
    (body,) = runtime.requests
    assert runtime.ops == ["converse_stream"] and got.text == "ok"
    assert body["toolConfig"] == {"tools": [models.tool_spec(check.CHECK_TOOL)], "toolChoice": {"auto": {}}}
    assert body["system"] == []  # still the bare check: no instructions, skills or memory


def test_a_chat_that_hits_the_tools_refusal_says_that_sentence_never_the_answer_stopped(tmp_path: Path) -> None:
    from lamostories_agent.chat import turn
    from test_chat_turn import MSG_SK, seed
    from test_chat_turn import run as run_chat

    sentence = models.TOOLS_REFUSED.format(label="Llama")
    svc, db, _ = services(tmp_path, FakeModel(models.ToolsUnavailable(sentence, model="custom-llama", status="error")))
    seed(db)
    assert run_chat(svc) == "failed"
    answer = db.get(TPK, MSG_SK)
    assert answer["error"] == sentence and answer["error"] != turn.FAILED
    assert turn.PICK_MODEL in answer["actions"]  # Settings › AI, where its Tools switch is

    svc, db, _ = services(tmp_path / "t", FakeModel(models.ToolsUnavailable(sentence, model="custom-llama")))
    db.seed(task_item("T1", "brainstorm", input={"topic": "pie", "count": 1}))
    assert run(svc) == "failed"
    assert db.get(TPK, "TASK#T1")["error"] == sentence


# --- E7: the writer the video names is the one that wrote --------------------------------------------------------


def test_the_writer_is_claude_only_for_an_anthropic_model() -> None:
    assert providers.writer_id("opus-5-5") == "bedrock-claude"  # a bundled Claude model
    assert providers.writer_id("custom-claude", "anthropic") == "bedrock-claude"  # an added Claude model
    assert providers.writer_id("custom-llama", "meta") == "bedrock-model:custom-llama"
    assert providers.writer_id("custom-nova", "amazon") == "bedrock-model:custom-nova"
    assert providers.writer_id("custom-gone") == "bedrock-model:custom-gone"  # unknown here: never called Claude


def test_planned_says_which_model_would_answer_and_who_makes_it_without_a_call() -> None:
    llama = added("custom-llama", "Meta", "meta.llama-v1")
    agent = item(keys.agent_sk("storyboard"), agentId="storyboard", model="custom-llama", effort=None, active=True)
    m, runtime, _ = bedrock([converse_reply("never")], llama, agent)
    ctx = CallContext(user_id=USER, workspace_id=WS, agent_id="storyboard", session_id="S1")
    assert m.planned(ctx, task="storyboard") == ("custom-llama", "meta")
    assert runtime.requests == []  # nothing was sent
    reply_ = bedrock([converse_reply("Hi")], llama)[0].complete(CTX, task="chat", messages=HELLO,
                                                                override={"model": "custom-llama"})  # fmt: skip
    assert reply_.maker == "meta"


class Llama(FakeModels):
    """The storyboard is written by an added Meta model; its replies say who makes it, as the Bedrock client's do."""

    def __init__(self, answers: dict[str, Any], *, planned: tuple[str, str] | None = None) -> None:
        super().__init__(answers, model="custom-llama", effort=None)
        self.plan = planned

    def complete(self, ctx: CallContext, *, task: str, messages: list[dict[str, Any]], **kw: Any) -> models.Reply:
        got = super().complete(ctx, task=task, messages=messages, **kw)
        return models.Reply(**{**got.__dict__, "maker": "meta"})

    def planned(self, ctx: CallContext, *, task: str) -> tuple[str, str]:
        if self.plan is None:
            raise models.ModelUnavailable("not in the list")
        return self.plan


def _job(svc: Services, job_id: str, session: str) -> StoryJob:
    return StoryJob(svc, JobFence(USER, WS, job_id, session), "ST1")


@needs_deno
def test_a_storyboard_written_by_a_meta_model_is_never_called_claude_in_this_job_or_the_next(tmp_path: Path) -> None:
    from ls_fakes import ENGINE_DIR, data
    from test_stories_pipeline import answers, character, job_item, story_item, workspace

    table = FakeTable()
    table.seed(workspace())
    table.seed(character())
    table.seed(story_item())
    table.seed(job_item("J1", "S1", run=["storyboard"]))
    d, _ = data(table)
    fake = Llama(answers(), planned=("custom-llama", "meta"))
    svc = Services(data=d, work_root=tmp_path / "work", models=fake, engine_dir=ENGINE_DIR,
                   config_dir=REPO / "stories" / "config", heartbeat_seconds=0.2, flush_seconds=0.05)  # fmt: skip
    job = _job(svc, "J1", "S1")
    seen: list[dict[str, str]] = []
    writer_answer = fake.answers["storyboard"]

    def write(call: dict[str, Any]) -> Any:  # what the job says while its writer is writing
        seen.append(dict(job.meta.get("providers") or {}))
        return writer_answer

    fake.answers["storyboard"] = write
    assert asyncio.run(job.run()) == "ready"
    assert seen == [{"writer": "bedrock-model:custom-llama", "images": "builtin-rig", "animation": "builtin-2d",
                     "audio": "builtin-synth"}]  # fmt: skip
    meta = table.item("PJOB#J1")["meta"]  # type: ignore[index]
    assert meta["providers"]["writer"] == "bedrock-model:custom-llama" and meta["writerModel"] == "custom-llama"
    script = next(a for a in table.prefix("ASSET#") if a["kind"] == "storyboard")
    assert script["meta"] == {"current": 1, "by": "writer", "writer": "bedrock-model:custom-llama"}

    # a later job that does not write names the writer of the storyboard it is made from, never Claude
    j2 = _job(svc, "J2", "S2")
    j2.todo, j2.steps, j2.assets = ["safety"], [{"key": "safety", "status": "pending"}], [script]
    assert j2._made_with()["writer"] == "bedrock-model:custom-llama"
    # a job about to write again before anyone said who will write: no writer rather than a wrong one
    j2.todo, j2.steps = ["storyboard"], [{"key": "storyboard", "status": "pending"}]
    assert "writer" not in j2._made_with()


def test_a_job_that_does_not_write_and_has_no_recorded_writer_names_none(tmp_path: Path) -> None:
    from test_stories_round4 import story_job

    job = story_job(tmp_path, FakeModels({}))
    job.todo, job.steps = ["assemble"], [{"key": "assemble", "status": "pending"}]
    job.assets = [{"kind": "storyboard", "version": 1, "meta": {"by": "writer"}}]  # written before round 5
    made = job._made_with()
    assert "writer" not in made and made["animation"] == "builtin-2d"
    job.meta["models"] = [{"step": "storyboard", "agentId": "storyboard", "task": "captions", "model": "opus-5-5"},
                          {"step": "storyboard", "agentId": "storyboard", "task": "storyboard",
                           "model": "custom-llama", "failed": True},
                          {"step": "storyboard", "agentId": "storyboard", "task": "storyboard",
                           "model": "opus-5-5"}]  # fmt: skip
    assert "writer" not in job._made_with()  # calls are not the writer: only a saved storyboard names one


def test_a_writer_call_whose_script_was_never_saved_is_never_the_writer(tmp_path: Path) -> None:
    from test_stories_pipeline import answers
    from test_stories_round4 import story_job

    # Claude wrote the storyboard on screen; the safety step's rewrite by the Llama answered but failed its checks
    job = story_job(tmp_path, Llama(answers()))
    job.todo, job.steps = ["safety"], [{"key": "safety", "status": "running"}]
    job.assets = [{"kind": "storyboard", "version": 2, "meta": {"by": "writer", "writer": "bedrock-claude"}},
                  {"kind": "storyboard", "version": 3, "meta": {"by": "owner"}}]  # fmt: skip
    asyncio.run(job.ask(step="storyboard", agent_id="storyboard", task="storyboard", messages=HELLO))
    assert job._last_writer == "bedrock-model:custom-llama"  # it answered...
    assert job._made_with()["writer"] == "bedrock-claude"  # ...but nothing it wrote was kept


def _world(tmp_path: Path, fake: Any) -> tuple[Services, FakeTable, Any]:
    from ls_fakes import ENGINE_DIR, data
    from test_stories_pipeline import character, job_item, story_item, workspace

    table = FakeTable()
    table.seed(workspace())
    table.seed(character())
    table.seed(story_item())
    table.seed(job_item("J1", "S1", run=["storyboard"]))
    d, store = data(table)
    svc = Services(data=d, work_root=tmp_path / "work", models=fake, engine_dir=ENGINE_DIR,
                   config_dir=REPO / "stories" / "config", heartbeat_seconds=0.2, flush_seconds=0.05)  # fmt: skip
    return svc, table, store


@needs_deno
def test_a_writer_that_refuses_tools_is_never_named_by_the_failed_job(tmp_path: Path) -> None:
    from test_stories_pipeline import answers
    from test_stories_rerenders import again

    sentence = models.TOOLS_REFUSED.format(label="Meta Llama 4 Maverick")
    refused = models.ToolsUnavailable(sentence, model="custom-llama", status="error")

    # a first story with no storyboard yet: the Llama is about to write it, then refuses the tools
    svc, table, _ = _world(tmp_path, Llama(answers(storyboard=refused), planned=("custom-llama", "meta")))
    job = table.items[(PK, "PJOB#J1")]
    table.seed({**job, "meta": {"providers": {"writer": "bedrock-claude", "images": "builtin-rig"}}})  # the API's
    assert asyncio.run(_job(svc, "J1", "S1").run()) == "failed"
    failed = table.item("PJOB#J1")
    assert failed is not None and failed["error"] == sentence
    assert "writer" not in failed["meta"]["providers"]  # neither the API's guess nor the model that refused
    assert failed["meta"]["models"][-1]["model"] == "custom-llama" and failed["meta"]["models"][-1]["failed"]

    # Claude wrote v1; a remake with the Llama that refuses tools still names Claude, whose storyboard is on screen
    svc, table, _ = _world(tmp_path / "two", FakeModels(answers()))
    assert asyncio.run(_job(svc, "J1", "S1").run()) == "ready"
    again(table, "J2", "S2", ["storyboard"])
    svc.models = Llama(answers(storyboard=refused), planned=("custom-llama", "meta"))
    assert asyncio.run(_job(svc, "J2", "S2").run()) == "failed"
    failed = table.item("PJOB#J2")
    assert failed is not None and failed["meta"]["providers"]["writer"] == "bedrock-claude"


class Maker(FakeModels):
    """Knows who makes each model as the workspace's own list says (the Bedrock client's ``maker_of``)."""

    makers: ClassVar[dict[str, str]] = {"custom-claude": "anthropic", "custom-llama": "meta"}

    def maker_of(self, ctx: CallContext, model_key: str) -> str:
        return self.makers.get(model_key, "")


@pytest.mark.parametrize(
    ("calls", "named"),
    [
        ([{"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "custom-claude"},
          {"step": "storyboard", "agentId": "storyboard", "task": "captions", "model": "custom-llama"}],
         "bedrock-claude"),  # an added Claude model (its maker from the workspace's list); the captions call is not it
        ([{"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "custom-claude"},
          {"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "custom-llama"}],
         "bedrock-model:custom-llama"),  # the job's last writer call wrote it
        ([{"step": "storyboard", "agentId": "storyboard", "task": "storyboard", "model": "custom-llama",
           "failed": True}], None),  # a failed call never wrote it
    ],
)  # fmt: skip
def test_a_storyboard_saved_before_round_5_is_named_by_the_job_that_wrote_it(
    tmp_path: Path, calls: list[dict[str, Any]], named: str | None
) -> None:
    from test_stories_pipeline import PREFIX, job_item
    from test_stories_round4 import story_job

    job = story_job(tmp_path, Maker({}))
    table, store = job.data.store.table, job.data.store  # type: ignore[attr-defined]
    table.seed({**job_item("J0", "S0"), "status": "ready", "meta": {"writerModel": None, "models": calls}})
    asyncio.run(store.put_bytes(PREFIX + "script/v1.writer.json", json.dumps({"by": "writer", "jobId": "J0"}).encode(),
                                "application/json"))  # fmt: skip
    job.assets = [{"kind": "storyboard", "version": 1, "key": PREFIX + "script/v1.json", "meta": {"by": "writer"}}]
    job.todo, job.steps = ["assemble"], [{"key": "assemble", "status": "pending"}]
    asyncio.run(job._read_older_writer())
    assert job._made_with().get("writer") == named


def test_the_bedrock_client_says_who_makes_a_model_from_the_workspace_s_own_list() -> None:
    m, runtime, _ = bedrock([converse_reply("never")], added("custom-claude", "Anthropic", "anthropic.claude-x-v1"),
                            added("custom-llama", "Meta", "meta.llama-v1"))  # fmt: skip
    assert m.maker_of(CTX, "custom-claude") == "anthropic" and m.maker_of(CTX, "custom-llama") == "meta"
    assert m.maker_of(CTX, "opus-5-5") == "anthropic" and m.maker_of(CTX, "custom-gone") == ""
    assert runtime.requests == []


# --- E13: one name for the other app --------------------------------------------------------------------------------


def test_the_agent_calls_the_other_app_clip_factory_everywhere() -> None:
    roots = [REPO / "stories" / "agent" / "src", REPO / "stories" / "config", REPO / "stories" / "skills"]
    found = [
        f"{p.relative_to(REPO)}:{n}"
        for root in roots
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.suffix in (".py", ".json", ".md")
        for n, line in enumerate(p.read_text("utf-8").splitlines(), start=1)
        if re.search(r"Lamo\s+Clips", line)
    ]
    assert found == []
