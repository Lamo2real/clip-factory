"""The one model client, ``BedrockModels.complete`` (docs/CONTRACTS.md §45.25, §45.26, §45.33, ADR-77), against a fake
Bedrock runtime that records every request body: the effort is in the body exactly when the model offers efforts,
thinking is never sent, tool choice is never forced, the owner's levels pick the model, a refused model is never
swapped for another, refusals are plain, every call writes MODELSTATUS# and USAGE#, and each agent gets exactly its
enabled, assigned Lamo Stories skills and the workspace memory as its first system blocks."""

from __future__ import annotations

import json
from typing import Any

import pytest

from lamostories_agent import config, keys, models
from lamostories_agent.models import (
    ANSWER_TOOL,
    AgentOff,
    AnswerInvalid,
    BedrockModels,
    CallContext,
    EffortUnavailable,
    ModelRefused,
    ModelUnavailable,
)
from ls_fakes import PK, USER, WS, FakeRuntime, FakeStore, FakeTable, client_error, converse_reply

CTX = CallContext(user_id=USER, workspace_id=WS, agent_id="creative_director", session_id="S1", task_id="T1")
HELLO = [{"role": "user", "content": [{"text": "Hello"}]}]
OPUS = "global.anthropic.claude-opus-5-5"


def item(sk: str, **fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": sk, "userId": USER, "workspaceId": WS, **fields}


def client(replies: list[Any], *seed: dict[str, Any]) -> tuple[BedrockModels, FakeRuntime, FakeTable, FakeStore]:
    table = FakeTable()
    for it in seed:
        table.seed(it)
    store = FakeStore(table)
    runtime = FakeRuntime(replies)
    return BedrockModels(table=table, get_bytes=store.get_bytes_sync, client=runtime, sleep=lambda _: None), runtime, \
        table, store  # fmt: skip


def body_text(body: dict[str, Any]) -> str:
    return json.dumps(body, default=str)


def system_texts(body: dict[str, Any]) -> list[str]:
    return [b["text"] for b in body["system"] if "text" in b]


# --- the request body ----------------------------------------------------------------------------------------------


def test_the_effort_is_sent_exactly_when_the_model_offers_efforts_and_thinking_never(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    m, runtime, _table, _ = client([converse_reply("Hi")])
    reply = m.complete(CTX, task="chat", messages=HELLO)
    (body,) = runtime.requests
    assert body["modelId"] == OPUS
    assert body["additionalModelRequestFields"] == {"output_config": {"effort": "high"}}
    assert "thinking" not in body_text(body) and "budget" not in body_text(body)
    assert "toolConfig" not in body
    assert (reply.model, reply.effort, reply.effort_applied, reply.text) == ("opus-5-5", "high", True, "Hi")

    # a model with no effort setting: nothing is sent and nothing is pretended
    plain = {"key": "plain-1", "label": "Plain 1", "provider": "Amazon Bedrock", "modelId": "anthropic.plain-1",
             "profile": "eu.anthropic.plain-1", "regions": ["eu-north-1"], "efforts": [], "defaultEffort": None,
             "vision": False, "pricing": None}  # fmt: skip
    listed = {**config.models(), "models": [*config.models()["models"], plain]}
    monkeypatch.setattr(config, "models", lambda: listed)
    m2, runtime2, _, _ = client([converse_reply("Hi")], item(keys.AICONFIG_SK, defaultModel="plain-1"))
    reply2 = m2.complete(CTX, task="chat", messages=HELLO)
    (body2,) = runtime2.requests
    assert body2["modelId"] == "eu.anthropic.plain-1" and "additionalModelRequestFields" not in body2
    assert reply2.effort is None and reply2.effort_applied is False


@pytest.mark.parametrize(
    ("seed", "ctx", "override", "model", "effort"),
    [
        ([item(keys.AICONFIG_SK, defaultModel="sonnet-5-5", defaultEffort="low")], CTX, None, "sonnet-5-5", "low"),
        ([item(keys.AICONFIG_SK, tasks={"chat": {"model": "fable-5-2"}})], CTX, None, "fable-5-2", "high"),
        ([item(keys.agent_sk("creative_director"), model="haiku-5-5", effort="medium")], CTX, None, "haiku-5-5",
         "medium"),
        ([item(keys.agent_sk("creative_director"), model="haiku-5-5")], CTX, {"model": "fable-5-1", "effort": "max"},
         "fable-5-1", "max"),
        ([item(keys.task_sk("T1"), override={"model": "fable-5-2", "effort": None})], CTX, None, "fable-5-2", "high"),
        # a job's own override and its story's setting (§45.25 levels 1 and 2)
        ([item(keys.job_sk("J1"), contentType="animation", contentId="ST1", configuration={"override": {"effort": "low"}}),
          item(keys.story_sk("ST1"), ai={"model": "sonnet-5-5", "effort": "xhigh"})],
         CallContext(USER, WS, "storyboard", "S1", job_id="J1"), None, "sonnet-5-5", "low"),
        # a chat turn: the message's own request beats the conversation's setting
        ([item(keys.conv_sk("C1"), model="fable-5-1", effort="medium"),
          item(keys.msg_sk("C1", "M1"), requested={"effort": "max"})],
         CallContext(USER, WS, "creative_director", "S1", conv_id="C1", msg_id="M1"), None, "fable-5-1", "max"),
    ],
)  # fmt: skip
def test_the_owner_s_levels_pick_the_model_and_the_effort_that_are_sent(
    seed: list[dict[str, Any]], ctx: CallContext, override: dict[str, Any] | None, model: str, effort: str
) -> None:
    m, runtime, _, _ = client([converse_reply("ok")], *seed)
    task = "storyboard" if ctx.agent_id == "storyboard" else "chat"
    reply = m.complete(ctx, task=task, messages=HELLO, override=override)
    (body,) = runtime.requests
    assert body["modelId"] == config.model(model)["profile"]  # type: ignore[index]
    assert body["additionalModelRequestFields"] == {"output_config": {"effort": effort}}
    assert (reply.model, reply.effort) == (model, effort)


def test_an_effort_the_model_does_not_offer_is_refused_never_swapped(monkeypatch: pytest.MonkeyPatch) -> None:
    original = config.models()
    lowish = [{**m, "efforts": ["low", "medium"]} if m["key"] == "haiku-5-5" else m for m in original["models"]]
    monkeypatch.setattr(config, "models", lambda: {**original, "models": lowish})
    m, runtime, _, _ = client([converse_reply("ok")], item(keys.AICONFIG_SK, defaultModel="haiku-5-5",
                                                           defaultEffort="max"))  # fmt: skip
    with pytest.raises(EffortUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert str(e.value) == "Claude Haiku 5.5 does not offer Maximum. Pick another level."
    assert runtime.requests == []


# --- no silent substitution, refusals, model status -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "status", "reason", "line"),
    [
        (client_error("AccessDeniedException", "You don't have access to the model with the specified model ID."),
         "denied", "Bedrock says this AWS account may not use it", "Bedrock says this AWS account may not use it."),
        (client_error("ResourceNotFoundException", "Model not found"), "not_found",
         "Bedrock cannot find it from this Region", "Bedrock cannot find it from this Region."),
        (client_error("ValidationException", "The provided model identifier is invalid."), "not_found",
         "Bedrock does not accept this model id here", "Bedrock does not accept this model id here."),
        (client_error("ValidationException", "Invocation of model ID anthropic.claude-fable-5-2 with on-demand "
                      "throughput isn't supported. Retry your request with the ID or ARN of an inference profile."),
         "not_found", "Bedrock does not accept this model id here", "Bedrock does not accept this model id here."),
        (client_error("ThrottlingException", "Too many requests"), "error", "its Bedrock limit is used up for now",
         "Its Bedrock limit is used up for now."),
    ],
)  # fmt: skip
def test_a_refused_model_stops_with_the_owner_s_sentence_and_no_other_model_is_called(
    error: Exception, status: str, reason: str, line: str
) -> None:
    m, runtime, table, _ = client([error], item(keys.AICONFIG_SK, defaultModel="fable-5-2"))
    with pytest.raises(ModelUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert str(e.value) == (
        f"Claude Fable 5.2 isn't available right now: {reason}. Pick another model in Funded Clips › Settings › AI, "
        "or try again."
    )
    assert runtime.requests and {r["modelId"] for r in runtime.requests} == {"global.anthropic.claude-fable-5-2"}
    st = table.item(keys.modelstatus_sk("fable-5-2"))
    assert st is not None and st["status"] == status and st["checkedAt"] and st["type"] == "ws_modelstatus"
    assert st["line"] == line  # one sentence beside the model in the pickers (§45.25)
    assert table.prefix("USAGE#") == []  # no answer, nothing used


@pytest.mark.parametrize(
    "message",
    [
        "The model returned the following errors: messages: roles must alternate between user and assistant",
        "Malformed input request: #/messages/0/content: expected type: JSONArray, found: String",
    ],
)
def test_a_request_shape_error_is_a_plain_failure_never_an_unavailable_model(message: str) -> None:
    """Bedrock wraps the model's own request errors as a ValidationException that mentions "model": only the model
    id's own refusals mean the model is unavailable (§45.25); anything else is the call failing."""
    from botocore.exceptions import ClientError

    m, runtime, table, _ = client([client_error("ValidationException", message)])
    with pytest.raises(ClientError):
        m.complete(CTX, task="chat", messages=HELLO)
    assert len(runtime.requests) == 1
    st = table.item(keys.modelstatus_sk("opus-5-5"))
    assert st is not None and st["status"] == "error" and st["line"] == "The last call failed."
    assert models.unavailable(client_error("ValidationException", message)) is None


@pytest.mark.parametrize(
    "message",
    [
        "The model returned the following errors: output_config.effort: Input should be 'low', 'medium' or 'high'",
        "The model returned the following errors: output_config: Extra inputs are not permitted",
    ],
)
def test_an_effort_bedrock_refuses_is_said_as_the_effort_and_never_sent_without_it(message: str) -> None:
    """§45.34: a ValidationException about the effort field is the effort's problem, in the owner's words; the call
    is not sent again without the effort (that would pretend it was applied), and MODELSTATUS# says so. (This message
    was a plain failure before round 3.)"""
    m, runtime, table, _ = client([client_error("ValidationException", message)])
    with pytest.raises(EffortUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    sentence = (
        "Claude Opus 5.5 does not accept High effort here (Amazon Bedrock refused it). Pick another level in "
        "Funded Clips › Settings › AI."
    )
    assert str(e.value) == sentence
    assert (e.value.model, e.value.effort, e.value.sent) == ("opus-5-5", "high", True)
    assert len(runtime.requests) == 1  # never retried, and never without the effort
    assert runtime.requests[0]["additionalModelRequestFields"] == {"output_config": {"effort": "high"}}
    st = table.item(keys.modelstatus_sk("opus-5-5"))
    assert st is not None and st["status"] == "error" and st["line"] == sentence
    assert models.unavailable(client_error("ValidationException", message)) is None


def test_a_refused_model_carries_the_model_and_effort_it_was_sent_with() -> None:
    m, _runtime, _table, _ = client([client_error("AccessDeniedException", "no access")])
    with pytest.raises(ModelUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO, override={"model": "sonnet-5-5", "effort": "low"})
    assert (e.value.model, e.value.effort, e.value.status) == ("sonnet-5-5", "low", "denied")


def test_a_refusal_is_a_plain_sentence_and_never_retried_elsewhere() -> None:
    m, runtime, table, _ = client([converse_reply("", stop="refusal")])
    with pytest.raises(ModelRefused) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert "Claude Opus 5.5 said no to this request" in str(e.value) and "Settings › AI" in str(e.value)
    assert len(runtime.requests) == 1
    assert table.item(keys.modelstatus_sk("opus-5-5"))["status"] == "ok"  # type: ignore[index]  # it answered
    assert len(table.prefix("USAGE#")) == 1


def test_every_call_writes_its_usage_and_cost_and_its_model_status() -> None:
    usage = {"inputTokens": 1000, "outputTokens": 200, "cacheReadInputTokens": 500, "cacheWriteInputTokens": 0}
    m, _, table, _ = client([converse_reply("ok", usage=usage)])
    m.complete(CTX, task="brainstorm", messages=HELLO)
    (u,) = table.prefix("USAGE#")
    assert u["sk"].startswith(f"USAGE#{u['day']}#") and u["type"] == "ws_usage" and u["kind"] == "model"
    assert (u["userId"], u["workspaceId"], u["model"], u["task"], u["agentId"]) == (
        USER, WS, "opus-5-5", "brainstorm", "creative_director"
    )  # fmt: skip
    assert (u["input"], u["output"], u["cacheRead"], u["cacheWrite"]) == (1000, 200, 500, 0)
    assert (u["effort"], u["effortApplied"], u["taskId"]) == ("high", True, "T1")
    # Opus 5.5's list price: $4 in, $20 out, $0.20 cache reads per million
    assert u["cost"] == pytest.approx((1000 * 4 + 200 * 20 + 500 * 0.2) / 1e6) and u["currency"] == "USD"
    assert u["priceSource"] == "anthropic_list" and u["ttl"] > 0
    st = table.item(keys.modelstatus_sk("opus-5-5"))
    assert st is not None and st["status"] == "ok" and st["line"] == "It answered."

    # the owner's own price wins; a model with no price shows tokens only
    owner = {"inputPer1M": 1.0, "outputPer1M": 2.0, "currency": "EUR"}
    m2, _, table2, _ = client([converse_reply("ok", usage=usage)], item(keys.AICONFIG_SK, prices={"opus-5-5": owner}))
    m2.complete(CTX, task="chat", messages=HELLO)
    (u2,) = table2.prefix("USAGE#")
    assert u2["cost"] == pytest.approx((1000 * 1 + 200 * 2 + 500 * 1) / 1e6) and u2["currency"] == "EUR"
    assert u2["priceSource"] == "owner"
    assert models.cost_of({"input": 5}, None) is None


# --- structured answers and tools -----------------------------------------------------------------------------------

SCHEMA = {"type": "object", "additionalProperties": False, "required": ["title"],
          "properties": {"title": {"type": "string", "maxLength": 10}}}  # fmt: skip


def test_a_schema_answer_comes_through_a_tool_with_automatic_choice_and_is_asked_once_more() -> None:
    m, runtime, table, _ = client(
        [converse_reply(tool=(ANSWER_TOOL, {"title": "far too long a title"})), converse_reply(tool=(ANSWER_TOOL, {"title": "Ice"}))]
    )  # fmt: skip
    reply = m.complete(CTX, task="brainstorm", messages=HELLO, schema=SCHEMA)
    assert reply.data == {"title": "Ice"}
    first, second = runtime.requests
    assert first["toolConfig"]["toolChoice"] == {"auto": {}}  # forced tool choice is refused by these models
    (spec,) = first["toolConfig"]["tools"]
    assert spec["toolSpec"]["name"] == ANSWER_TOOL and spec["toolSpec"]["inputSchema"] == {"json": SCHEMA}
    assert first["messages"][-1]["content"][-1]["text"].startswith(f"Answer only by calling the {ANSWER_TOOL}")
    result = second["messages"][-1]["content"][0]["toolResult"]
    assert result["status"] == "error" and "longer than 10" in result["content"][0]["text"]
    assert len(table.prefix("USAGE#")) == 2  # both calls are counted


def test_a_schema_answer_wrong_twice_fails_after_exactly_two_calls() -> None:
    m, runtime, _, _ = client([converse_reply("I'd rather chat")])
    with pytest.raises(AnswerInvalid):
        m.complete(CTX, task="brainstorm", messages=HELLO, schema=SCHEMA)
    assert len(runtime.requests) == 2


def test_a_schema_with_tools_hands_the_caller_s_tool_calls_back_and_answers_every_tool_use() -> None:
    """With a schema and the caller's tools together: an answer that calls only a caller tool comes back as it is
    (the caller's tool loop runs it); a wrong answer that called tools gets a toolResult for every toolUse."""
    tool = {"name": "list_ideas", "description": "List the saved ideas.", "input_schema": {"type": "object"}}
    m, runtime, _, _ = client([converse_reply("Let me look.", tool=("list_ideas", {}))])
    reply = m.complete(CTX, task="brainstorm", messages=HELLO, schema=SCHEMA, tools=[tool])
    assert len(runtime.requests) == 1 and reply.data is None
    assert reply.tool_calls == [{"id": "tu1", "name": "list_ideas", "input": {}}] and reply.stop_reason == "tool_use"

    both = converse_reply("Here.")
    both["output"]["message"]["content"] += [
        {"toolUse": {"toolUseId": "tA", "name": ANSWER_TOOL, "input": {"title": "far too long a title"}}},
        {"toolUse": {"toolUseId": "tB", "name": "list_ideas", "input": {}}},
    ]
    both["stopReason"] = "tool_use"
    m2, runtime2, _, _ = client([both, converse_reply(tool=(ANSWER_TOOL, {"title": "Ice"}))])
    assert m2.complete(CTX, task="brainstorm", messages=HELLO, schema=SCHEMA, tools=[tool]).data == {"title": "Ice"}
    results = [b["toolResult"] for b in runtime2.requests[1]["messages"][-1]["content"] if "toolResult" in b]
    assert [r["toolUseId"] for r in results] == ["tA", "tB"] and all(r["status"] == "error" for r in results)
    assert "longer than 10" in results[0]["content"][0]["text"] and "Not run" in results[1]["content"][0]["text"]


def test_tools_are_passed_with_automatic_choice_and_the_calls_come_back_with_the_raw_content() -> None:
    tool = {"name": "list_ideas", "description": "List the saved ideas.", "input_schema": {"type": "object"}}
    m, runtime, _, _ = client([converse_reply("Let me look.", tool=("list_ideas", {}))])
    reply = m.complete(CTX, task="chat", messages=HELLO, tools=[tool])
    (body,) = runtime.requests
    assert body["toolConfig"]["toolChoice"] == {"auto": {}}
    assert body["toolConfig"]["tools"][0]["toolSpec"]["name"] == "list_ideas"
    assert reply.tool_calls == [{"id": "tu1", "name": "list_ideas", "input": {}}]
    assert reply.stop_reason == "tool_use" and reply.content[1]["toolUse"]["name"] == "list_ideas"


def test_streaming_hands_the_text_so_far_to_on_text() -> None:
    events = {
        "stream": [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "Lamo "}}},
            {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "slips."}}},
            {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "t9", "name": "remember"}}}},
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"text": "lik'}}}},
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": 'es ice"}'}}}},
            {"messageStop": {"stopReason": "tool_use"}},
            {"metadata": {"usage": {"inputTokens": 7, "outputTokens": 3}}},
        ]
    }  # fmt: skip
    m, runtime, table, _ = client([events])
    seen: list[str] = []
    reply = m.complete(CTX, task="chat", messages=HELLO, on_text=seen.append)
    assert seen == ["Lamo ", "Lamo slips."] and reply.text == "Lamo slips."
    assert reply.tool_calls == [{"id": "t9", "name": "remember", "input": {"text": "likes ice"}}]
    assert reply.usage == {"input": 7, "output": 3, "cacheRead": 0, "cacheWrite": 0}
    assert runtime.requests[0]["additionalModelRequestFields"] == {"output_config": {"effort": "high"}}
    assert table.prefix("USAGE#")[0]["input"] == 7


def test_a_refused_cache_point_is_switched_off_and_the_same_model_asked_again() -> None:
    m, runtime, _, _ = client(
        [client_error("ValidationException", "cachePoint is not supported"), converse_reply("ok")]
    )
    assert m.complete(CTX, task="chat", messages=HELLO).text == "ok"
    first, second = runtime.requests
    assert {"cachePoint": {"type": "default"}} in first["system"] and all(
        "cachePoint" not in b for b in second["system"]
    )
    assert first["modelId"] == second["modelId"]


# --- agents, skills and memory: the first system blocks -------------------------------------------------------------


def test_each_agent_gets_its_instructions_then_exactly_its_enabled_assigned_skills_then_the_memory() -> None:
    owner_key = f"ws/{USER}/{WS}/skills/K1/R1/SKILL.md"
    seed = [
        # the storyboard agent: its skills reordered, one owner skill added, one built-in switched off
        item(
            keys.agent_sk("storyboard"),
            instructions="Write it short.",
            skillIds=["K1", "vertical-short-hooks", "driving-safety-teaching", "K2", "K3"],
        ),
        item(keys.skill_sk("driving-safety-teaching"), builtin=True, enabled=False),
        item(
            keys.skill_sk("K1"),
            title="Slapstick",
            description="Funny falls.",
            source="upload",
            format="md",
            enabled=True,
            key=owner_key,
        ),
        item(keys.skill_sk("K2"), title="Off", enabled=False, key=f"ws/{USER}/{WS}/skills/K2/R1/SKILL.md"),
        item(
            keys.skill_sk("K3"), title="Elsewhere", enabled=True, key="skills/someone/SKILL.md"
        ),  # not ws/: never read
        item(keys.skill_sk("K4"), title="Not assigned", enabled=True, key=f"ws/{USER}/{WS}/skills/K4/R1/SKILL.md"),
        item("MEM#M1", text="Lamo likes slapstick endings", createdAt="2026-11-21T10:00:00.000Z"),
        item("MEM#M2", text="No rain scenes", createdAt="2026-11-21T12:00:00.000Z"),
    ]
    m, runtime, _, store = client([converse_reply("ok")], *seed)
    store.objects[owner_key] = (b"---\nname: slapstick\n---\nEvery fall ends with a laugh.", "text/markdown")
    store.objects[f"ws/{USER}/{WS}/skills/K4/R1/SKILL.md"] = (b"Not mine.", "text/markdown")
    store.objects["skills/someone/SKILL.md"] = (b"Clip Factory's.", "text/markdown")
    m.complete(CallContext(USER, WS, "storyboard", "S1", job_id="J1"), task="storyboard", messages=HELLO)
    texts = system_texts(runtime.requests[0])
    assert texts[0] == "Write it short."
    skills = texts[1]
    assert skills.index("Slapstick") < skills.index("vertical-short-hooks")
    assert "Every fall ends with a laugh." in skills
    assert "driving-safety-teaching" not in skills and "Not assigned" not in skills and "Clip Factory's" not in skills
    assert "Off" not in skills and "Elsewhere" not in skills
    assert texts[2].splitlines()[1:] == ["- No rain scenes", "- Lamo likes slapstick endings"]  # newest first
    assert store.reads == [owner_key]  # only this workspace's own skill file was read

    # another agent gets its own skills from the defaults (stories/config/agents.json), not the storyboard's
    m2, runtime2, _, _ = client([converse_reply("ok")])
    m2.complete(CallContext(USER, WS, "quality_assurance", "S1", job_id="J1"), task="fact_check", messages=HELLO)
    texts2 = system_texts(runtime2.requests[0])
    defaults = {a["agentId"]: a for a in config.agents()["agents"]}
    assert texts2[0] == defaults["quality_assurance"]["instructions"]
    assert "driving-safety-teaching" in texts2[1] and "nonverbal-storytelling" not in texts2[1]


def test_an_agent_switched_off_stops_its_tasks_unless_the_safety_check_must_run() -> None:
    off = item(keys.agent_sk("quality_assurance"), active=False)
    m, runtime, _, _ = client([converse_reply("ok")], off)
    ctx = CallContext(USER, WS, "quality_assurance", "S1", job_id="J1")
    with pytest.raises(AgentOff) as e:
        m.complete(ctx, task="final_review", messages=HELLO)
    assert str(e.value) == "Quality check is switched off. Switch it on in Funded Clips › Settings › Agents."
    assert runtime.requests == []
    m.complete(ctx, task="fact_check", messages=HELLO, allow_inactive=True)  # a driving-safety story's check
    assert len(runtime.requests) == 1


def test_an_unknown_model_is_refused_before_any_call() -> None:
    m, runtime, _, _ = client([converse_reply("ok")], item(keys.agent_sk("creative_director"), model="gpt-9"))
    with pytest.raises(ModelUnavailable):
        m.complete(CTX, task="chat", messages=HELLO)
    assert runtime.requests == []


# --- round 3 (§45.34) ---------------------------------------------------------------------------------------------


def modeldef(key: str, **over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "type": "ws_modeldef",
        "key": key,
        "label": "Llama Custom",
        "provider": "Meta",
        "modelId": "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123",
        "region": "us-west-2",
        "efforts": ["low", "medium"],
        "defaultEffort": "medium",
        "vision": False,
        "maxOutputTokens": 4096,
        "price": {"inputPer1M": 1.0, "outputPer1M": 2.0, "cacheReadPer1M": None, "cacheWritePer1M": None,
                  "longContext": None, "currency": "USD", "source": "owner"},
        # How the owner said it is called (§45.35 D1; the API stores all three): this one takes the effort field,
        # tools and cache points.
        "effortField": "output_config",
        "tools": True,
        "cache": True,
    }  # fmt: skip
    return item(f"MODELDEF#{key}", **{**fields, **over})


def test_a_model_the_owner_added_runs_with_its_own_id_region_and_efforts_with_no_release() -> None:
    """Request 2 §3 "adding new models … without rebuilding": a MODELDEF# of the workspace is merged over the bundled
    list for each call. It is called by its own model id in its own Region, the effort is sent only from its own
    list, its output limit holds, and its own price is used for the usage item."""
    regions: list[str] = []
    runtime = FakeRuntime([converse_reply("Hi")])

    def factory(region: str) -> FakeRuntime:
        regions.append(region)
        return runtime

    table = FakeTable()
    table.seed(modeldef("custom-llama"))
    table.seed(item(keys.AICONFIG_SK, defaultModel="custom-llama", defaultEffort="high"))
    store = FakeStore(table)
    m = BedrockModels(table=table, get_bytes=store.get_bytes_sync, region="eu-north-1", client=FakeRuntime([]),
                      client_factory=factory, sleep=lambda _: None)  # fmt: skip
    with pytest.raises(EffortUnavailable):  # High is not in its own list: refused, never swapped
        m.complete(CTX, task="chat", messages=HELLO)
    reply = m.complete(CTX, task="chat", messages=HELLO, override={"effort": "low"}, max_tokens=16000)
    (body,) = runtime.requests
    assert regions == ["us-west-2"]
    assert body["modelId"] == "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123"
    assert body["additionalModelRequestFields"] == {"output_config": {"effort": "low"}}
    assert body["inferenceConfig"]["maxTokens"] == 4096
    assert (reply.model, reply.effort, reply.effort_applied) == ("custom-llama", "low", True)
    (usage,) = table.prefix("USAGE#")
    assert usage["model"] == "custom-llama" and usage["cost"] == pytest.approx((100 * 1.0 + 20 * 2.0) / 1e6)
    assert usage["priceSource"] == "owner"


def test_a_model_the_owner_added_with_no_efforts_runs_with_none_sent() -> None:
    m, runtime, _, _ = client(
        [converse_reply("Hi")],
        modeldef("custom-plain", efforts=[], defaultEffort=None, region=None),
        item(keys.AICONFIG_SK, defaultModel="custom-plain", defaultEffort="max"),
    )
    reply = m.complete(CTX, task="chat", messages=HELLO)
    (body,) = runtime.requests
    assert "additionalModelRequestFields" not in body and reply.effort is None and reply.effort_applied is False


def test_the_owner_s_models_are_never_shared_with_another_workspace_or_shadow_a_bundled_one() -> None:
    other = CallContext(
        user_id=USER, workspace_id="01JD0000000000000000000000", agent_id="creative_director", session_id="S1"
    )
    m, runtime, table, _ = client([converse_reply("Hi")], modeldef("custom-llama"))
    table.seed({"pk": f"USER#{USER}#WS#01JD0000000000000000000000", "sk": keys.AICONFIG_SK, "userId": USER, "workspaceId": "01JD0000000000000000000000",
                "defaultModel": "custom-llama"})  # fmt: skip
    with pytest.raises(ModelUnavailable) as e:  # the other workspace has no such model
        m.complete(other, task="chat", messages=HELLO)
    assert "is not in Funded Clips' list" in str(e.value) and runtime.requests == []
    shadow = config.merged_models([modeldef("opus-5-5", modelId="x"), modeldef("custom-ok"), modeldef("bad key")])
    assert [x["key"] for x in shadow["models"]][-1] == "custom-ok"
    assert next(x for x in shadow["models"] if x["key"] == "opus-5-5") == config.model("opus-5-5")
    assert config.models() is config.models()  # the bundled file stays cached; the workspace's are read per call


def test_check_models_is_one_bare_request_with_no_instructions_skills_or_memory(
    caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    """§45.34: Check models sends a tiny request (no agent instructions, skills or memory), logs no task-agent
    mismatch, runs while the agent is off, and leaves MODELSTATUS# to the check (one item per model)."""
    m, runtime, table, _ = client(
        [converse_reply("ok")],
        item(keys.agent_sk("creative_director"), active=False),
        item("MEM#M1", text="Lamo likes slapstick endings", createdAt="2026-11-21T10:00:00.000Z"),
    )
    reply = m.complete(CTX, task=models.CHECK_TASK, messages=HELLO, override={"model": "haiku-5-5", "effort": "low"},
                       max_tokens=512)  # fmt: skip
    (body,) = runtime.requests
    assert body["system"] == [] and "slapstick" not in body_text(body)
    assert body["modelId"] == config.model("haiku-5-5")["profile"]  # type: ignore[index]
    assert reply.model == "haiku-5-5" and reply.effort == "low"
    assert "task_agent_mismatch" not in capsys.readouterr().out + caplog.text
    assert table.item(keys.modelstatus_sk("haiku-5-5")) is None  # the check writes it, once
    assert len(table.prefix("USAGE#")) == 1  # its tokens are still counted


def test_the_protocol_lists_allow_inactive_and_on_text_s_meaning() -> None:
    import inspect

    params = inspect.signature(models.ModelClient.complete).parameters
    assert "allow_inactive" in params and params["allow_inactive"].default is False
    assert "whole text so far" in (models.ModelClient.complete.__doc__ or "")


# --- round 3 review: Regions, cache points and what a failed call was sent with -----------------------------------


def test_a_model_the_owner_added_in_another_region_is_called_there_even_after_a_bundled_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """As in production (``services.py``: a Region and no client given), a bundled call first makes this Region's
    client; the owner's model in us-west-2 still gets a us-west-2 client, never the runtime's own (§45.34)."""
    import boto3

    made: dict[str, FakeRuntime] = {}

    def fake_client(service: str, region_name: str | None = None, config: Any = None) -> FakeRuntime:
        assert service == "bedrock-runtime" and region_name not in made
        made[str(region_name)] = FakeRuntime([converse_reply("Hi")])
        return made[str(region_name)]

    monkeypatch.setattr(boto3, "client", fake_client)
    table = FakeTable()
    table.seed(modeldef("custom-llama"))
    store = FakeStore(table)
    m = BedrockModels(table=table, get_bytes=store.get_bytes_sync, region="eu-north-1", sleep=lambda _: None)
    assert m.complete(CTX, task="chat", messages=HELLO).model == "opus-5-5"  # a bundled model, this Region
    reply = m.complete(CTX, task="chat", messages=HELLO, override={"model": "custom-llama", "effort": "low"})
    assert reply.model == "custom-llama" and list(made) == ["eu-north-1", "us-west-2"]
    assert [b["modelId"] for b in made["eu-north-1"].requests] == [OPUS]
    assert [b["modelId"] for b in made["us-west-2"].requests] == [modeldef("x")["modelId"]]
    m.complete(CTX, task="chat", messages=HELLO, override={"model": "custom-llama", "effort": "low"})
    assert len(made["us-west-2"].requests) == 2 and list(made) == ["eu-north-1", "us-west-2"]  # made once


def test_a_custom_model_that_refuses_a_cache_point_leaves_caching_on_for_the_bundled_models() -> None:
    refused = client_error("ValidationException", "cachePoint is not supported for this model")
    m, runtime, _, _ = client(
        [refused, converse_reply("ok"), converse_reply("ok"), converse_reply("ok")], modeldef("custom-llama")
    )
    custom = {"model": "custom-llama", "effort": "low"}
    assert m.complete(CTX, task="chat", messages=HELLO, override=custom).text == "ok"
    m.complete(CTX, task="chat", messages=HELLO, override=custom)
    m.complete(CTX, task="chat", messages=HELLO)  # a bundled model: still cached

    def cached(body: dict[str, Any]) -> bool:
        return {"cachePoint": {"type": "default"}} in body["system"]

    first, again, later, bundled = runtime.requests
    assert cached(first) and not cached(again) and not cached(later)  # this model only, for good
    assert bundled["modelId"] == OPUS and cached(bundled)


def test_any_other_bedrock_error_keeps_its_type_and_says_the_model_and_effort_it_was_sent_with() -> None:
    from botocore.exceptions import ClientError

    from lamostories_agent.tasks.work import asked_of

    m, runtime, table, _ = client([client_error("ModelErrorException", "The model had an internal error")])
    with pytest.raises(ClientError) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert len(runtime.requests) == models.CALL_ATTEMPTS  # retried as before, never another model
    assert {b["modelId"] for b in runtime.requests} == {OPUS}
    assert (getattr(e.value, "model", None), getattr(e.value, "effort", None)) == ("opus-5-5", "high")
    assert asked_of(e.value) == ("opus-5-5", "high")
    status = table.item(keys.modelstatus_sk("opus-5-5"))
    assert status is not None and status["status"] == "error"
