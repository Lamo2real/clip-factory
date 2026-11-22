"""The keyed hosts of the models the owner adds (docs/CONTRACTS.md §45.37 G4), all with fakes (no network, no AWS):
the Anthropic API through Anthropic's own SDK on a fake transport, an OpenAI-compatible chat-completions API on a fake
HTTP function, ElevenLabs' effect and music endpoints, the provider keys read per call from the workspace's own
secret, and the model client's dispatch to them with the same contract as Bedrock's (the effort only in the host's own
field and only when offered, the owner's sentences naming the host, MODELSTATUS# and USAGE# written, never another
model). Addresses that are not on the public internet are never called."""

from __future__ import annotations

import json
from typing import Any

import anthropic
import httpx2
import pytest

from lamostories_agent import config, hosts, keys, models, providers
from lamostories_agent.hosts import Answer, HostCall, HostError
from lamostories_agent.models import BedrockModels, CallContext, EffortUnavailable, ModelUnavailable, ToolsUnavailable
from ls_fakes import PK, USER, WS, FakeRuntime, FakeStore, FakeTable

HELLO = [{"role": "user", "content": [{"text": "Hello"}]}]
CTX = CallContext(user_id=USER, workspace_id=WS, agent_id="creative_director", session_id="S1", task_id="T1")
OTHER_WS = "01JD0000000000000000000099"


# --- fakes ---------------------------------------------------------------------------------------------------------


def sse(events: list[dict[str, Any]]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def anthropic_stream(text: str = "Hello", *, tool: tuple[str, dict[str, Any]] | None = None, stop: str = "end_turn",
                     usage: tuple[int, int, int, int] = (12, 7, 3, 2)) -> bytes:  # fmt: skip
    inp, out, read, write = usage
    events: list[dict[str, Any]] = [
        {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant",
                                              "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                                              "stop_sequence": None,
                                              "usage": {"input_tokens": inp, "output_tokens": 1,
                                                        "cache_read_input_tokens": read,
                                                        "cache_creation_input_tokens": write}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[:3]}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[3:]}},
        {"type": "content_block_stop", "index": 0},
    ]  # fmt: skip
    if tool is not None:
        events += [
            {"type": "content_block_start", "index": 1,
             "content_block": {"type": "tool_use", "id": "tu_1", "name": tool[0], "input": {}}},
            {"type": "content_block_delta", "index": 1,
             "delta": {"type": "input_json_delta", "partial_json": json.dumps(tool[1])}},
            {"type": "content_block_stop", "index": 1},
        ]  # fmt: skip
    events += [
        {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else stop, "stop_sequence": None},
         "usage": {"output_tokens": out}},
        {"type": "message_stop"},
    ]  # fmt: skip
    return sse(events)


class FakeAnthropic:
    """Anthropic's real SDK client on a fake transport: records each request (its body and headers) and answers with
    the next scripted SSE stream or HTTP error."""

    def __init__(self, *answers: bytes | tuple[int, dict[str, Any]]) -> None:
        self.answers = list(answers)
        self.requests: list[dict[str, Any]] = []

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append({"url": str(request.url), "body": json.loads(request.content),
                              "headers": dict(request.headers)})  # fmt: skip
        got = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(got, tuple):
            return httpx2.Response(got[0], json=got[1])
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=got)

    @property
    def keys(self) -> list[str]:
        """The keys each request carried (the SDK sends the owner's key in its own auth header)."""
        out = []
        for r in self.requests:
            h = r["headers"]
            out.append(h.get("x-api-key") or h.get("authorization", "").removeprefix("Bearer ").strip())
        return out

    def http(self) -> Any:
        return anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(self.handler))


class FakeHttp:
    """``hosts.Http``: records each request and answers from ``answers`` (an ``Answer`` or a function of the call)."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, method: str, url: str, *, headers: dict[str, str], body: bytes | None, timeout: float) -> Answer:
        call = {"method": method, "url": url, "headers": headers, "body": json.loads(body) if body else None}
        self.calls.append(call)
        got = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        return got(call) if callable(got) else got


class FakeKeys:
    """The workspaces' provider keys: ``{(workspaceId, host): key}``; every read is recorded."""

    def __init__(self, found: dict[tuple[str, str], str]) -> None:
        self.found = found
        self.reads: list[tuple[str, str]] = []
        self.urls: list[str | None] = []  # the address each read was for (an OpenAI-compatible key's, §45.37 G4)

    def key(self, workspace_id: str, host: str, url: str | None = None) -> str | None:
        self.reads.append((workspace_id, host))
        self.urls.append(url)
        return self.found.get((workspace_id, host))


def chat_answer(text: str = "Hi", *, tool: tuple[str, dict[str, Any]] | None = None, finish: str = "stop",
                usage: dict[str, Any] | None = None) -> Answer:  # fmt: skip
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if tool:
        message["tool_calls"] = [{"id": "call_1", "type": "function",
                                  "function": {"name": tool[0], "arguments": json.dumps(tool[1])}}]  # fmt: skip
        finish = "tool_calls"
    body = {"choices": [{"message": message, "finish_reason": finish}],
            "usage": usage or {"prompt_tokens": 20, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 4}}}  # fmt: skip
    return Answer(200, json.dumps(body).encode())


def defs(*entries: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"pk": PK, "sk": f"MODELDEF#{e['key']}", "userId": USER, "workspaceId": WS, "type": "ws_modeldef", **e}
            for e in entries]  # fmt: skip


CLAUDE_API = {"key": "custom-claude-api", "label": "Claude Opus 5.5 (my key)", "provider": "Anthropic",
              "host": "anthropic", "modelId": "claude-opus-5-5", "efforts": ["low", "medium", "high", "xhigh", "max"],
              "defaultEffort": "medium", "vision": True, "maxOutputTokens": 64000}  # fmt: skip
GROQ = {"key": "custom-llama-oc", "label": "Llama on my host", "provider": "Meta", "host": "openai_compatible",
        "baseUrl": "https://api.example-llm.com/openai/v1/", "modelId": "llama-4-maverick", "efforts": ["low", "high"],
        "effortField": "reasoning_effort", "tools": True}  # fmt: skip


def client_with(*items: dict[str, Any], anth: FakeAnthropic | None = None, http: FakeHttp | None = None,
                found: dict[tuple[str, str], str] | None = None) -> tuple[BedrockModels, FakeTable, FakeKeys, FakeRuntime]:  # fmt: skip
    table = FakeTable()
    for it in items:
        table.seed(it)
    store = FakeStore(table)
    runtime = FakeRuntime([])
    keys_ = FakeKeys(
        found if found is not None else {(WS, "anthropic"): "sk-ant-owner-1", (WS, "openai_compatible"): "oc-owner-1"}
    )
    hosts_ = {
        "anthropic": hosts.AnthropicHost(anth.http() if anth else None),
        "openai_compatible": hosts.OpenAICompatibleHost(http),
    }
    m = BedrockModels(table=table, get_bytes=store.get_bytes_sync, client=runtime, sleep=lambda _: None, keys=keys_,
                      hosts=hosts_)  # fmt: skip
    return m, table, keys_, runtime


def setting(model: str, effort: str | None = None) -> dict[str, Any]:
    return {"pk": PK, "sk": keys.AICONFIG_SK, "userId": USER, "workspaceId": WS, "defaultModel": model,
            **({"defaultEffort": effort} if effort else {})}  # fmt: skip


# --- the added models' hosts ----------------------------------------------------------------------------------------


def test_an_added_model_names_its_host_and_an_openai_compatible_one_needs_a_public_https_address() -> None:
    claude = config.model_from_def(defs(CLAUDE_API)[0])
    assert claude is not None and (claude["hostId"], claude["host"], claude["region"]) == (
        "anthropic",
        "Anthropic API",
        None,
    )
    assert config.call_shape(claude) == ("output_config", True, True)
    llama = config.model_from_def(defs(GROQ)[0])
    assert llama is not None and llama["baseUrl"] == "https://api.example-llm.com/openai/v1"
    assert config.call_shape(llama) == ("reasoning_effort", True, False) and config.offered_efforts(llama) == [
        "low",
        "high",
    ]
    # an OpenAI field on Bedrock or the Anthropic API means nothing there: no effort is offered through it
    assert config.offered_efforts({**claude, "effortField": "reasoning_effort"}) == []
    old = config.model_from_def(defs({"key": "custom-old", "modelId": "meta.llama-x", "region": "us-east-1"})[0])
    assert old is not None and old["hostId"] == "bedrock" and old["region"] == "us-east-1"  # saved before hosts
    for base in ("http://api.example.com/v1", "https://localhost/v1", "https://127.0.0.1/v1", "https://10.1.2.3/v1",
                 "https://169.254.169.254/latest", "https://[fd00:ec2::254]/", "https://metadata.google.internal/",
                 "https://user:pw@api.example.com/v1", "https://api.internal/v1", "https://intranet/v1", "",
                 "https://api.example.com/v1?x=1"):  # fmt: skip
        assert config.safe_base_url(base) is None, base
        assert config.model_from_def(defs({**GROQ, "baseUrl": base})[0]) is None, base
    assert config.safe_base_url("https://api.openai.com/v1/") == "https://api.openai.com/v1"
    assert config.model_from_def(defs({**GROQ, "host": "smoke-signals"})[0]) is None


def test_https_never_reaches_an_address_that_is_not_public() -> None:
    def resolver(answer: list[str]) -> Any:
        return lambda host, port: answer

    for answer in (["127.0.0.1"], ["10.0.0.5"], ["169.254.169.254"], ["fd00:ec2::254"], ["93.184.216.34", "192.168.1.2"],
                   ["::ffff:10.0.0.1"], []):  # fmt: skip
        with pytest.raises(HostError) as e:
            hosts.https("GET", "https://api.example.com/v1/models", headers={}, body=None, timeout=1,
                        resolve=resolver(answer))  # fmt: skip
        assert e.value.response["Error"]["Code"] == "AddressNotAllowed" and e.value.sent is False, answer
    for url in ("http://api.example.com/x", "https://localhost/x", "https://u:p@api.example.com/x"):
        with pytest.raises(HostError) as e:
            hosts.https("GET", url, headers={}, body=None, timeout=1, resolve=resolver(["93.184.216.34"]))
        assert e.value.sent is False


# --- the owner's keys ---------------------------------------------------------------------------------------------


class FakeSecrets:
    def __init__(self, found: dict[str, str], error: str | None = None) -> None:
        self.found, self.error = found, error
        self.asked: list[str] = []

    def get_secret_value(self, SecretId: str) -> dict[str, Any]:
        from botocore.exceptions import ClientError

        self.asked.append(SecretId)
        if self.error:
            raise ClientError({"Error": {"Code": self.error, "Message": "x"}}, "GetSecretValue")
        if SecretId not in self.found:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "no"}}, "GetSecretValue")
        return {"SecretString": self.found[SecretId]}


def test_a_key_is_read_from_its_own_workspace_s_secret_each_time() -> None:
    secrets = FakeSecrets({"cf-prod/workspaces/stories/providers/anthropic": json.dumps({"key": "sk-ant-1"})})
    reader = hosts.ProviderKeys("cf-prod/workspaces/", lambda: secrets)
    assert reader.key("stories", "anthropic") == "sk-ant-1"
    assert reader.key("stories", "anthropic") == "sk-ant-1" and len(secrets.asked) == 2  # never kept between calls
    assert reader.key("stories", "elevenlabs") is None and reader.key(OTHER_WS, "anthropic") is None
    assert secrets.asked[-1] == f"cf-prod/workspaces/{OTHER_WS}/providers/anthropic"
    for bad_ws, host in (("clips", "anthropic"), ("../x", "anthropic"), ("stories", "youtube")):
        with pytest.raises(ValueError):
            reader.key(bad_ws, host)
    with pytest.raises(HostError) as e:
        hosts.ProviderKeys("cf-prod/workspaces/", lambda: FakeSecrets({}, "AccessDeniedException")).key(
            "stories", "anthropic"
        )
    assert e.value.kind == "key" and e.value.sent is False


def test_an_openai_compatible_key_is_given_only_for_the_address_it_was_saved_for() -> None:
    """The API saves an OpenAI-compatible key as ``{"key", "origin"}`` (§45.37 G4): it goes only to that origin."""
    name = "cf-prod/workspaces/stories/providers/openai_compatible"
    secrets = FakeSecrets({name: json.dumps({"key": "oc-1", "origin": "https://api.example-llm.com"})})
    reader = hosts.ProviderKeys("cf-prod/workspaces/", lambda: secrets)
    assert reader.key("stories", "openai_compatible", "https://api.example-llm.com/openai/v1") == "oc-1"
    assert reader.key("stories", "openai_compatible", "https://API.example-llm.com:443/v2") == "oc-1"
    for other in ("https://api.other-llm.com/v1", "https://api.example-llm.com:8443/v1", "https://evil.com/?x=api",
                  "http://api.example-llm.com/v1", "", None):  # fmt: skip
        with pytest.raises(HostError) as e:
            reader.key("stories", "openai_compatible", other)
        assert e.value.response["Error"]["Code"] == "KeyForOtherAddress" and e.value.sent is False, other
        assert e.value.kind == "key" and e.value.found and e.value.found[0] == "denied"
        assert "oc-1" not in str(e.value) and "api.example-llm.com" in e.value.found[1]
    # a key saved without its address is never sent anywhere
    unbound = FakeSecrets({name: json.dumps({"key": "oc-2"})})
    with pytest.raises(HostError) as e:
        hosts.ProviderKeys("cf-prod/workspaces/", lambda: unbound).key(
            "stories", "openai_compatible", "https://api.example-llm.com/v1"
        )
    assert e.value.response["Error"]["Code"] == "KeyForOtherAddress"
    # the other keyed hosts have one fixed address each: no origin is asked of them
    anth = FakeSecrets({"cf-prod/workspaces/stories/providers/anthropic": json.dumps({"key": "sk-ant-1"})})
    assert hosts.ProviderKeys("cf-prod/workspaces/", lambda: anth).key("stories", "anthropic") == "sk-ant-1"


def test_the_model_client_never_sends_an_openai_compatible_key_to_another_address() -> None:
    secrets = FakeSecrets({f"cf-prod/workspaces/{WS}/providers/openai_compatible":
                           json.dumps({"key": "oc-owner-1", "origin": "https://api.other-llm.com"})})  # fmt: skip
    http = FakeHttp(chat_answer("Sure"))
    m, table, _keys, runtime = client_with(*defs(GROQ), setting("custom-llama-oc"), http=http)
    m._keys = hosts.ProviderKeys("cf-prod/workspaces/", lambda: secrets)
    with pytest.raises(ModelUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert "your OpenAI-compatible key is for api.other-llm.com, not api.example-llm.com" in str(e.value)
    assert http.calls == [] and runtime.requests == []  # nothing was sent, not even without the key
    status = table.item("MODELSTATUS#custom-llama-oc")
    assert status is not None and status["status"] == "denied"
    # the key's own address works
    ok = FakeSecrets({f"cf-prod/workspaces/{WS}/providers/openai_compatible":
                      json.dumps({"key": "oc-owner-1", "origin": "https://api.example-llm.com"})})  # fmt: skip
    m._keys = hosts.ProviderKeys("cf-prod/workspaces/", lambda: ok)
    assert m.complete(CTX, task="chat", messages=HELLO).text == "Sure"
    assert http.calls[0]["headers"]["Authorization"] == "Bearer oc-owner-1"


# --- the Anthropic API ---------------------------------------------------------------------------------------------


def test_the_anthropic_api_is_called_through_its_sdk_with_the_effort_in_output_config_and_never_a_fallback() -> None:
    fake = FakeAnthropic(anthropic_stream("Hello"))
    host = hosts.AnthropicHost(fake.http())
    seen: list[str] = []
    call = HostCall("claude-opus-5-5", ["You are the creative director.", "Memory"], HELLO,
                    [{"toolSpec": {"name": "list_ideas", "description": "List", "inputSchema": {"json": {"type": "object"}}}}],
                    4000, effort="high", cache=True)  # fmt: skip
    got = host.send("sk-ant-owner-1", call, seen.append)
    (req,) = fake.requests
    body = req["body"]
    assert req["url"].startswith("https://api.anthropic.com/v1/messages")
    assert fake.keys == ["sk-ant-owner-1"]
    assert body["model"] == "claude-opus-5-5" and body["max_tokens"] == 4000 and body["stream"] is True
    assert body["output_config"] == {"effort": "high"}
    assert body["system"][-1] == {"type": "text", "text": "Memory", "cache_control": {"type": "ephemeral"}}
    assert body["tools"] == [{"name": "list_ideas", "description": "List", "input_schema": {"type": "object"}}]
    assert body["tool_choice"] == {"type": "auto"}
    assert "thinking" not in body and "fallbacks" not in body and "reasoning_effort" not in body
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}]
    assert got.content == [{"text": "Hello"}] and got.stop_reason == "end_turn"
    assert got.usage == {"input": 12, "output": 7, "cacheRead": 3, "cacheWrite": 2}
    assert seen == ["Hel", "Hello"]  # the whole text so far, each time it grows
    no_effort = hosts.AnthropicHost.request(HostCall("claude-x", [], HELLO, [], 10))
    assert "output_config" not in no_effort and "system" not in no_effort and "tools" not in no_effort


def test_the_anthropic_api_round_trips_tool_use_results_and_thinking() -> None:
    msgs = [
        {"role": "user", "content": [{"text": "Hi"}, {"image": {"format": "jpg", "source": {"bytes": b"\xff\xd8"}}}]},
        {"role": "assistant", "content": [{"reasoningContent": {"reasoningText": {"text": "", "signature": "sig"}}},
                                          {"toolUse": {"toolUseId": "tu1", "name": "list_ideas", "input": {"n": 1}}}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "tu1", "content": [{"json": {"ideas": []}}],
                                                     "status": "success"}}]},
    ]  # fmt: skip
    out = hosts.to_anthropic(msgs)
    assert out[0]["content"][1] == {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                                 "data": "/9g="}}  # fmt: skip
    assert out[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig"}
    assert out[1]["content"][1] == {"type": "tool_use", "id": "tu1", "name": "list_ideas", "input": {"n": 1}}
    assert out[2]["content"][0] == {"type": "tool_result", "tool_use_id": "tu1", "content": '{"ideas": []}',
                                    "is_error": False}  # fmt: skip
    back = hosts.from_anthropic([{"type": "tool_use", "id": "x", "name": "y", "input": {}},
                                 {"type": "thinking", "thinking": "t", "signature": "s"}])  # fmt: skip
    assert back == [{"toolUse": {"toolUseId": "x", "name": "y", "input": {}}},
                    {"reasoningContent": {"reasoningText": {"text": "t", "signature": "s"}}}]  # fmt: skip


@pytest.mark.parametrize(
    ("status", "kind", "found", "transient"),
    [
        (401, "key", "denied", False),
        (403, "model", "denied", False),
        (404, "model", "not_found", False),
        (429, "limit", "error", True),
        (529, "other", None, True),
        (400, "effort", None, False),
    ],
)
def test_the_anthropic_api_s_refusals_become_host_errors(
    status: int, kind: str, found: str | None, transient: bool
) -> None:
    from lamostories_agent.retry import is_transient

    message = "output_config.effort: unsupported value" if kind == "effort" else "nope"
    fake = FakeAnthropic((status, {"type": "error", "error": {"type": "x", "message": message}}))
    with pytest.raises(HostError) as e:
        hosts.AnthropicHost(fake.http()).send("sk-ant-1", HostCall("claude-x", [], HELLO, [], 10), None)
    assert e.value.kind == kind and (e.value.found or (None,))[0] == found and is_transient(e.value) is transient
    assert "sk-ant-1" not in str(e.value)


# --- an OpenAI-compatible API --------------------------------------------------------------------------------------


def test_an_openai_compatible_call_sends_reasoning_effort_only_when_set_and_reads_tool_calls() -> None:
    http = FakeHttp(chat_answer("", tool=("submit_answer", {"a": 1})))
    host = hosts.OpenAICompatibleHost(http)
    call = HostCall("llama-4", ["Be brief."], HELLO, [{"toolSpec": {"name": "submit_answer", "description": "Answer",
                                                                    "inputSchema": {"json": {"type": "object"}}}}],
                    2000, effort="low", base_url="https://api.example-llm.com/openai/v1")  # fmt: skip
    got = host.send("oc-key", call, None)
    (sent,) = http.calls
    assert sent["url"] == "https://api.example-llm.com/openai/v1/chat/completions"
    assert sent["headers"]["Authorization"] == "Bearer oc-key"
    body = sent["body"]
    assert body["reasoning_effort"] == "low" and body["max_completion_tokens"] == 2000 and "max_tokens" not in body
    assert body["messages"][0] == {"role": "system", "content": "Be brief."}
    assert body["tools"][0]["function"]["name"] == "submit_answer" and body["tool_choice"] == "auto"
    assert "output_config" not in body
    assert got.content == [{"toolUse": {"toolUseId": "call_1", "name": "submit_answer", "input": {"a": 1}}}]
    assert got.stop_reason == "tool_use" and got.usage == {"input": 16, "output": 5, "cacheRead": 4, "cacheWrite": 0}
    plain = hosts.OpenAICompatibleHost.request(HostCall("m", [], HELLO, [], 50))
    assert plain["max_tokens"] == 50 and "reasoning_effort" not in plain and "tools" not in plain
    refused = hosts.OpenAICompatibleHost(FakeHttp(chat_answer("", finish="content_filter"))).send("k", call, None)
    assert refused.stop_reason == "refusal"
    with pytest.raises(HostError) as e:
        hosts.OpenAICompatibleHost(FakeHttp(Answer(401, b'{"error": {"message": "bad key oc-key"}}'))).send(
            "oc-key", call, None
        )
    assert e.value.kind == "key" and "oc-key" not in str(e.value)


# --- the model client on a keyed host -------------------------------------------------------------------------------


def test_the_model_client_calls_an_added_claude_model_on_the_anthropic_api_with_the_workspace_s_own_key() -> None:
    fake = FakeAnthropic(anthropic_stream("Hi there"))
    m, table, keys_, runtime = client_with(*defs(CLAUDE_API), setting("custom-claude-api", "low"), anth=fake)
    reply = m.complete(CTX, task="chat", messages=HELLO)
    assert runtime.requests == []  # never Bedrock for this model
    assert fake.keys == ["sk-ant-owner-1"] and keys_.reads == [(WS, "anthropic")]
    body = fake.requests[0]["body"]
    assert body["model"] == "claude-opus-5-5" and body["output_config"] == {"effort": "low"}
    assert (reply.model, reply.effort, reply.effort_applied, reply.host) == (
        "custom-claude-api",
        "low",
        True,
        "anthropic",
    )
    assert (reply.model_id, reply.region, reply.text) == ("claude-opus-5-5", None, "Hi there")
    status = table.item("MODELSTATUS#custom-claude-api")
    assert status is not None and status["status"] == "ok"
    (usage,) = table.prefix("USAGE#")
    assert usage["model"] == "custom-claude-api" and usage["host"] == "anthropic" and usage["effort"] == "low"
    assert (usage["input"], usage["output"], usage["cacheRead"]) == (12, 7, 3)
    # the key is read again on the next call, for the workspace that call works for
    m.complete(CTX, task="chat", messages=HELLO)
    assert keys_.reads == [(WS, "anthropic"), (WS, "anthropic")]
    assert providers.writer_id(reply.model, reply.maker, reply.host) == "bedrock-model:custom-claude-api"


def test_a_schema_answer_on_the_anthropic_api_comes_through_submit_answer() -> None:
    schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    fake = FakeAnthropic(anthropic_stream("", tool=(models.ANSWER_TOOL, {"title": "Icy Ride"})))
    m, _table, _keys, _ = client_with(*defs(CLAUDE_API), setting("custom-claude-api"), anth=fake)
    reply = m.complete(CTX, task="brainstorm", messages=HELLO, schema=schema)
    assert reply.data == {"title": "Icy Ride"}
    assert [t["name"] for t in fake.requests[0]["body"]["tools"]] == [models.ANSWER_TOOL]


def test_no_saved_key_stops_the_call_with_a_sentence_and_nothing_is_tried_elsewhere() -> None:
    fake = FakeAnthropic(anthropic_stream())
    m, table, _keys, runtime = client_with(*defs(CLAUDE_API), setting("custom-claude-api"), anth=fake, found={})
    with pytest.raises(ModelUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert str(e.value) == (
        "Claude Opus 5.5 (my key) isn't available right now: there is no key for the Anthropic API saved yet (paste "
        "one in Lamo Stories › Settings › AI › Provider keys). Pick another model in Lamo Stories › Settings › AI, or "
        "try again."
    )
    assert fake.requests == [] and runtime.requests == []
    status = table.item("MODELSTATUS#custom-claude-api")
    assert status is not None and status["status"] == "denied" and "no key for the Anthropic API" in status["line"]


def test_another_workspace_s_key_is_never_used() -> None:
    other_ctx = CallContext(
        user_id=USER, workspace_id=OTHER_WS, agent_id="creative_director", session_id="S1", task_id="T1"
    )
    other_pk = keys.ws_pk(USER, OTHER_WS)
    seed = [{**d, "pk": other_pk, "workspaceId": OTHER_WS} for d in defs(CLAUDE_API)]
    seed.append({**setting("custom-claude-api"), "pk": other_pk, "workspaceId": OTHER_WS})
    fake = FakeAnthropic(anthropic_stream())
    m, _table, keys_, _ = client_with(*seed, anth=fake, found={(WS, "anthropic"): "sk-ant-stories"})
    with pytest.raises(ModelUnavailable):
        m.complete(other_ctx, task="chat", messages=HELLO)
    assert keys_.reads == [(OTHER_WS, "anthropic")] and fake.keys == []


def test_an_effort_or_tools_the_host_refuses_are_said_plainly_and_never_retried_without_them() -> None:
    fake = FakeAnthropic((400, {"type": "error", "error": {"type": "invalid_request_error",
                                                            "message": "output_config.effort: xhigh is not supported"}}))  # fmt: skip
    m, table, _keys, _ = client_with(*defs(CLAUDE_API), setting("custom-claude-api", "xhigh"), anth=fake)
    with pytest.raises(EffortUnavailable) as e:
        m.complete(CTX, task="chat", messages=HELLO)
    assert str(e.value) == (
        "Claude Opus 5.5 (my key) does not accept Extra high effort here (the Anthropic API refused it). Pick another "
        "level in Lamo Stories › Settings › AI."
    )
    assert e.value.sent is True and len(fake.requests) == 1  # never sent again without the effort
    assert table.item("MODELSTATUS#custom-claude-api")["status"] == "error"  # type: ignore[index]

    http = FakeHttp(Answer(400, b'{"error": {"message": "tools are not supported for this model"}}'))
    m2, _t, _k, _ = client_with(*defs(GROQ), setting("custom-llama-oc", "low"), http=http)
    tool = {"name": "list_ideas", "description": "List", "input_schema": {"type": "object"}}
    with pytest.raises(ToolsUnavailable) as t:
        m2.complete(CTX, task="chat", messages=HELLO, tools=[tool])
    assert "(the OpenAI-compatible API refused it)" in str(t.value) and len(http.calls) == 1


def test_a_throttled_keyed_call_is_retried_then_answers() -> None:
    fake = FakeAnthropic(
        (429, {"type": "error", "error": {"type": "rate_limit_error", "message": "slow"}}), anthropic_stream("ok")
    )
    m, _table, _keys, _ = client_with(*defs(CLAUDE_API), setting("custom-claude-api"), anth=fake)
    assert m.complete(CTX, task="chat", messages=HELLO).text == "ok" and len(fake.requests) == 2


def test_an_openai_compatible_model_gets_reasoning_effort_and_never_output_config() -> None:
    http = FakeHttp(chat_answer("Sure"))
    m, _table, keys_, runtime = client_with(*defs(GROQ), setting("custom-llama-oc", "high"), http=http)
    reply = m.complete(CTX, task="chat", messages=HELLO)
    body = http.calls[0]["body"]
    assert body["reasoning_effort"] == "high" and "output_config" not in body and runtime.requests == []
    assert http.calls[0]["url"] == "https://api.example-llm.com/openai/v1/chat/completions"
    assert keys_.reads == [(WS, "openai_compatible")] and reply.host == "openai_compatible" and reply.text == "Sure"
    # the same model saved without an effort field takes no effort at all, and says so
    http2 = FakeHttp(chat_answer("Sure"))
    no_field = {**GROQ, "effortField": "none", "efforts": []}
    m2, _t, _k, _ = client_with(*defs(no_field), setting("custom-llama-oc", "high"), http=http2)
    reply2 = m2.complete(CTX, task="chat", messages=HELLO)
    assert "reasoning_effort" not in http2.calls[0]["body"] and reply2.effort_applied is False


# --- ElevenLabs: effects and an instrumental music bed, never a voice ---------------------------------------------


def test_elevenlabs_makes_effects_and_instrumental_music_and_checks_the_key_for_free() -> None:
    http = FakeHttp(Answer(200, b"ID3-fx"), Answer(200, b"ID3-music"), Answer(200, b'[{"model_id": "eleven_v3"}]'))
    el = hosts.ElevenLabs("el-key", http)
    assert el.effect("a pop", 0.1, loop=False, model_id="eleven_text_to_sound_v2") == b"ID3-fx"
    assert el.music("calm music", 45, model_id="music_v1") == b"ID3-music"
    assert el.check() == ["eleven_v3"]
    fx, tune, check = http.calls
    assert fx["url"] == "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128"
    assert fx["headers"]["xi-api-key"] == "el-key"
    assert fx["body"] == {"text": "a pop", "duration_seconds": 0.5, "loop": False, "prompt_influence": 0.5,
                          "model_id": "eleven_text_to_sound_v2"}  # fmt: skip
    assert tune["url"].startswith("https://api.elevenlabs.io/v1/music?")
    assert tune["body"] == {"prompt": "calm music", "music_length_ms": 45000, "model_id": "music_v1",
                            "force_instrumental": True}  # fmt: skip
    assert (check["method"], check["url"]) == ("GET", "https://api.elevenlabs.io/v1/models")
    assert not any("text-to-speech" in c["url"] for c in http.calls)
    with pytest.raises(HostError) as e:
        hosts.ElevenLabs("el-key", FakeHttp(Answer(401, b'{"detail": {"message": "invalid api key"}}'))).check()
    assert e.value.kind == "key"


def test_the_bundled_makers_never_list_a_keyed_host_for_reasoning() -> None:
    assert all(config.host_of(m) == "bedrock" for m in config.models()["models"])
    assert hosts.host_words("anthropic") == "the Anthropic API"
