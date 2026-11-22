"""Model and effort resolution and the one model client (docs/CONTRACTS.md §45.25, §45.33, ADR-77).

The contract every Lamo Stories AI call goes through. ``BedrockModels`` implements ``ModelClient`` (Bedrock Converse
and ConverseStream with ``additionalModelRequestFields={"output_config": {"effort": ...}}`` exactly when the model
offers efforts and takes that field, ``toolConfig`` and cache points only for a model that takes them, §45.35 D1;
adaptive thinking left to the model, refusals, MODELSTATUS# and USAGE#); the pipeline, the chat, the tasks and the
reference analysis call it. Precedence, strongest first, model and effort merged separately: the
per-request override, the conversation's or the project's setting, the task's, the agent's, the workspace default.
There is never an automatic fallback to another model, and an effort the model does not offer is refused, never
swapped. ``stories/config/resolve-cases.json`` holds the shared cases (the API's resolver passes the same ones).
"""

from __future__ import annotations

import contextlib
import functools
import json
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Protocol

from . import config, keys
from .agents import Workspace
from .jsonschema import check
from .retry import retry_sync
from .util import log, now_iso, ulid

LEVELS = ("request", "conversation", "project", "task", "agent")
EFFORT_WORDS = {"low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Maximum"}


class ModelUnavailable(Exception):
    """The effective model cannot be used. The message is the owner's sentence; nothing runs on another model.
    ``model`` and ``effort`` are what the call was sent with (None when it was never resolved), so a failed answer or
    job step still shows what was asked (§45.34); ``status`` is what Bedrock's refusal proved, when it was sent."""

    def __init__(
        self, message: str = "", *, model: str | None = None, effort: str | None = None, status: str | None = None
    ) -> None:
        super().__init__(message)
        self.model = model
        self.effort = effort
        self.status = status


class EffortUnavailable(Exception):
    """The effective effort is not one the model offers. The message is the owner's sentence; it is never swapped.
    ``sent`` is True when Amazon Bedrock itself refused the effort field (the request reached the model, §45.34),
    False when the settings named an effort the model's list does not offer (nothing was sent)."""

    def __init__(
        self,
        message: str = "",
        *,
        model: str | None = None,
        effort: str | None = None,
        sent: bool = False,
        status: str | None = None,
    ) -> None:
        super().__init__(message)
        self.model = model
        self.effort = effort
        self.sent = sent
        self.status = status


@dataclass(frozen=True)
class Choice:
    model: str  # a key of stories/config/models.json
    effort: str | None  # None when the model has no effort setting (then effort_applied is False)
    effort_applied: bool
    source: str  # where the model came from: one of LEVELS or "default"


def resolve(
    *,
    task: str,
    agent: dict[str, Any] | None = None,
    ai: dict[str, Any] | None = None,
    override: dict[str, Any] | None = None,
    conversation: dict[str, Any] | None = None,
    project: dict[str, Any] | None = None,
    catalog: dict[str, Any] | None = None,
) -> Choice:
    """The effective model and effort for one call (§45.25). ``conversation`` applies to chat turns, ``project`` to a
    story's or a reference's jobs; pass at most one of them. ``catalog`` is the workspace's model list (the bundled
    one with the owner's own models merged in, ``Workspace.models()``); the bundled list when not given."""
    ai = ai or {}
    listed = catalog if catalog is not None else config.models()
    task_cfg = (ai.get("tasks") or {}).get(task) or {}
    levels: list[tuple[str, dict[str, Any]]] = [
        ("request", override or {}),
        ("conversation", conversation or {}),
        ("project", project or {}),
        ("task", task_cfg),
        ("agent", agent or {}),
    ]
    model_key, source = None, "default"
    for name, cfg in levels:
        if cfg.get("model"):
            model_key, source = str(cfg["model"]), name
            break
    if model_key is None:
        model_key = str(ai.get("defaultModel") or listed["defaultModel"])
    info = config.model(model_key, listed)
    effort = next((str(cfg["effort"]) for _, cfg in levels if cfg.get("effort")), None)
    if effort is None:
        effort = str(ai.get("defaultEffort") or listed["defaultEffort"])
    if info is None:
        raise ModelUnavailable(
            f"The model '{model_key}' is not in Lamo Stories' list. Pick another in Settings › AI.",
            model=model_key,
            effort=effort,
        )
    offered = config.offered_efforts(info)  # none for a model that takes no effort field (§45.35 D1)
    if not offered:
        return Choice(model_key, None, False, source)
    if effort not in offered:
        raise EffortUnavailable(
            f"{info['label']} does not offer {EFFORT_WORDS.get(effort, effort)}. Pick another level.",
            model=model_key,
            effort=effort,
        )
    return Choice(model_key, effort, True, source)


@dataclass(frozen=True)
class CallContext:
    """Who a call works for and its fence (§45.33)."""

    user_id: str
    workspace_id: str
    agent_id: str
    session_id: str
    job_id: str | None = None
    task_id: str | None = None
    conv_id: str | None = None
    msg_id: str | None = None


@dataclass(frozen=True)
class Reply:
    text: str
    data: dict[str, Any] | None  # the parsed JSON when a schema was asked for
    tool_calls: list[dict[str, Any]]
    content: list[dict[str, Any]]  # the raw assistant blocks, for tool loops
    stop_reason: str
    model: str
    effort: str | None
    effort_applied: bool
    usage: dict[str, int] = field(default_factory=dict)
    model_id: str | None = None  # the Bedrock model id or inference profile really called (§45.35 D5)
    region: str | None = None  # the Region it was called in
    tools_off: bool = False  # the caller gave tools, but this model takes none: they were not sent (§45.35 D1)
    task: str | None = None  # the task the call was for (§45.35 D5)


class ModelClient(Protocol):
    """The one model client (§45.33, §45.34). The creative packages reach it through
    ``lamostories_agent.services.get().models``."""

    def complete(
        self,
        ctx: CallContext,
        *,
        task: str,
        messages: list[dict[str, Any]],
        override: dict[str, Any] | None = None,
        schema: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 16000,
        on_text: Callable[[str], None] | None = None,
        allow_inactive: bool = False,
    ) -> Reply:
        """Resolves the model and effort itself, builds the system blocks (the agent's instructions, its enabled skills,
        the workspace memory), sends the request, writes MODELSTATUS# and USAGE#. Called from a worker thread.

        ``on_text`` receives the current call's whole text so far each time it grows (after a retried stream it
        starts again from the beginning), never only the newest piece. ``allow_inactive`` lets a task run while its
        agent is switched off (the quality agent's checks of driving content, Check models). ``task="check_models"``
        is the tiny check of §45.25: no agent instructions, skills or memory, and the check writes MODELSTATUS#.

        A model that takes no tools (``tools`` false, §45.35 D1) is sent none: a ``schema`` answer is asked for as
        JSON in its text (checked the same way, asked once more), and the caller's ``tools`` are left out
        (``Reply.tools_off``). The reply (and any error) says the ``model_id``, ``region`` and ``task`` (D5)."""
        ...


# --- the Bedrock client (builder E) ------------------------------------------------------------------------------

ANSWER_TOOL = "submit_answer"
ANSWER_NUDGE = f"Answer only by calling the {ANSWER_TOOL} tool once, with every required field."
# A model that takes no tools (§45.35 D1) is asked for its structured answer as JSON in its text, and told it has
# no tools when a caller (the chat) offered some.
JSON_NUDGE = (
    "Answer with only one JSON object, with no other words and no code fences. It must fit this JSON schema:\n{schema}"
)
JSON_AGAIN = "Answer again with only the whole JSON object, fixed."
NO_TOOLS_NUDGE = "You have no tools in this conversation: answer in words only and never pretend to use a tool."
NO_EFFORT_LINE = "This model has no effort setting; it runs at its own level."
UNAVAILABLE = (
    "{label} isn't available right now: {reason}. Pick another model in Lamo Stories › Settings › AI, or try again."
)
REFUSED = (
    "{label} said no to this request. Change the wording a little and try again, or pick another model in "
    "Lamo Stories › Settings › AI."
)
AGENT_OFF = "{name} is switched off. Switch it on in Lamo Stories › Settings › Agents."
EFFORT_REFUSED = (
    "{label} does not accept {effort} effort here (Amazon Bedrock refused it). Pick another level in Lamo Stories › "
    "Settings › AI."
)
CHECK_TASK = "check_models"  # Check models: one bare request per model (§45.25, §45.34)
STATUS_LINES = {
    "ok": "It answered.",
    "denied": "Bedrock says this AWS account may not use it.",
    "not_found": "Bedrock cannot find it from here.",
    "error": "The last call failed.",
}
# What Bedrock says when it refuses the model id itself (a ValidationException); anything else about the request is a
# plain failure, never "the model is unavailable".
_MODEL_ID_PHRASES = (
    "model identifier",
    "provided model",
    "model id",
    "on-demand throughput",
    "inference profile",
    "end of its life",
)
_MODEL_SAID = "model returned the following errors"  # Bedrock's wrapper of the model's own request errors
NOT_RUN = f"Not run. {ANSWER_NUDGE}"
CALL_ATTEMPTS = 3
READ_TIMEOUT = 15 * 60  # a long structured answer with adaptive thinking can take minutes


class AgentOff(Exception):
    """The agent of this task is switched off (§45.26); the message is the owner's sentence."""


class ModelRefused(Exception):
    """The model declined the request (``stopReason`` refusal); no other model is tried (§45.25)."""

    def __init__(self, message: str = "", *, model: str | None = None, effort: str | None = None) -> None:
        super().__init__(message)
        self.model = model
        self.effort = effort


class AnswerInvalid(Exception):
    """The answer did not fit the schema, also after being asked once more."""

    def __init__(self, problems: list[str], *, model: str | None = None, effort: str | None = None) -> None:
        super().__init__("The answer did not fit: " + "; ".join(problems[:5]))
        self.problems = problems
        self.model = model
        self.effort = effort


def _asked(
    e: BaseException,
    choice: Choice,
    model_id: str | None = None,
    region: str | None = None,
    task: str | None = None,
) -> None:
    """Puts the model and effort a call was sent with on an error that does not carry them (§45.34), and the model id
    and Region it was sent to and its task (§45.35 D5)."""
    pairs = (("model", choice.model), ("effort", choice.effort), ("model_id", model_id), ("region", region),
             ("task", task))  # fmt: skip
    for name, value in pairs:
        if getattr(e, name, None) is None:
            with contextlib.suppress(AttributeError, TypeError):
                setattr(e, name, value)


def _code(e: BaseException) -> str:
    response = getattr(e, "response", None)
    return str(((response or {}).get("Error") or {}).get("Code") or "") if isinstance(response, dict) else ""


def _message(e: BaseException) -> str:
    response = getattr(e, "response", None)
    msg = ((response or {}).get("Error") or {}).get("Message") if isinstance(response, dict) else None
    return str(msg or e)


def effort_refused(e: BaseException) -> bool:
    """Bedrock refused the request because of its effort field (``output_config.effort``), §45.34."""
    if _code(e) != "ValidationException":
        return False
    msg = _message(e).lower()
    return "effort" in msg or "output_config" in msg


def unavailable(e: BaseException) -> tuple[str, str] | None:
    """``(status, reason)`` when Bedrock refused the model itself (access, Region, model id or quota), else None."""
    code, msg = _code(e), _message(e).lower()
    if code == "AccessDeniedException":
        if "retention" in msg:
            return "denied", "Bedrock needs this AWS account's data-retention opt-in for it first"
        return "denied", "Bedrock says this AWS account may not use it"
    if code == "ResourceNotFoundException":
        return "not_found", "Bedrock cannot find it from this Region"
    if code == "ValidationException" and _MODEL_SAID not in msg:
        if "retention" in msg and "model" in msg:
            return "denied", "Bedrock needs this AWS account's data-retention opt-in for it first"
        if any(p in msg for p in _MODEL_ID_PHRASES):
            return "not_found", "Bedrock does not accept this model id here"
    if code in ("ThrottlingException", "ServiceQuotaExceededException", "TooManyRequestsException"):
        return "error", "its Bedrock limit is used up for now"
    return None


def status_line(found: tuple[str, str] | None) -> str:
    """The one sentence MODELSTATUS# shows beside the model after a failed call: the reason, or "The last call
    failed." when Bedrock said nothing about the model itself."""
    if not found:
        return STATUS_LINES["error"]
    reason = found[1]
    return reason[:1].upper() + reason[1:] + "."


def price_of(model_key: str, ai: dict[str, Any], catalog: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The owner's price for the model (Settings › AI) or else the list price in ``stories/config/models.json`` (or
    the price the owner gave his own model)."""
    owner = (ai.get("prices") or {}).get(model_key)
    if isinstance(owner, dict) and owner.get("inputPer1M") is not None:
        return {**owner, "source": owner.get("source") or "owner"}
    info = config.model(model_key, catalog) or {}
    pricing = info.get("pricing")
    return dict(pricing) if isinstance(pricing, dict) else None


def cost_of(usage: dict[str, int], price: dict[str, Any] | None) -> float | None:
    """An estimate in the price's currency, or None when no price is known. Cache reads and writes use their own
    prices when known, else the input price."""
    if not price:
        return None
    inp, out = float(price.get("inputPer1M") or 0), float(price.get("outputPer1M") or 0)
    total_in = usage.get("input", 0) + usage.get("cacheRead", 0) + usage.get("cacheWrite", 0)
    long = price.get("longContext")
    if isinstance(long, dict) and total_in > int(long.get("aboveInputTokens") or 0):
        inp, out = float(long.get("inputPer1M") or inp), float(long.get("outputPer1M") or out)
    read = price.get("cacheReadPer1M")
    write = price.get("cacheWritePer1M")
    cost = (
        usage.get("input", 0) * inp
        + usage.get("output", 0) * out
        + usage.get("cacheRead", 0) * (float(read) if read is not None else inp)
        + usage.get("cacheWrite", 0) * (float(write) if write is not None else inp)
    ) / 1_000_000
    return round(cost, 6)


def tool_spec(tool: dict[str, Any]) -> dict[str, Any]:
    """A tool as Converse takes it: ``{"toolSpec": ...}`` as is, or ``{name, description, input_schema | schema}``."""
    if "toolSpec" in tool:
        return tool
    schema = tool.get("input_schema") or tool.get("inputSchema") or tool.get("schema") or {"type": "object"}
    if isinstance(schema, dict) and "json" in schema and len(schema) == 1:
        schema = schema["json"]
    return {
        "toolSpec": {"name": str(tool["name"]), "description": str(tool.get("description") or tool["name"]),
                     "inputSchema": {"json": schema}}
    }  # fmt: skip


def _usage(raw: dict[str, Any] | None) -> dict[str, int]:
    raw = raw or {}
    return {
        "input": int(raw.get("inputTokens") or 0),
        "output": int(raw.get("outputTokens") or 0),
        "cacheRead": int(raw.get("cacheReadInputTokens") or 0),
        "cacheWrite": int(raw.get("cacheWriteInputTokens") or 0),
    }


def _add(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: a.get(k, 0) + b.get(k, 0) for k in {*a, *b}}


@dataclass
class _Answer:
    content: list[dict[str, Any]]
    stop_reason: str
    usage: dict[str, int]


class BedrockModels:
    """``ModelClient`` on Amazon Bedrock Converse (§45.25, §45.33).

    ``client`` is a ``bedrock-runtime`` client (made on first use in ``CF_REGION`` when not given); ``table`` is the
    workspace table (a boto3 ``Table`` or a factory of one per thread); ``get_bytes`` reads an owner skill's file under
    ``ws/``. The request never carries ``thinking`` (the models think adaptively and refuse a budget), never a forced
    ``toolChoice`` (refused by these models) and never another model than the one resolved."""

    def __init__(
        self,
        *,
        table: Any,
        get_bytes: Callable[[str], bytes],
        client: Any = None,
        region: str | None = None,
        sleep: Callable[[float], None] | None = None,
        client_factory: Callable[[str], Any] | None = None,
    ) -> None:
        self._table = table
        self._get_bytes = get_bytes
        self._client = client
        self._injected = client is not None  # a test's client; the one made in ``client`` is this Region's only
        self._region = region
        self._sleep = sleep
        self._factory = client_factory
        self._clients: dict[str, Any] = {}
        self._local = threading.local()
        self._lock = threading.Lock()
        # The model ids (with their Region) Bedrock refused a cache point for. Kept per model: one owner's model that
        # cannot cache never switches caching off for the bundled models or another workspace (§45.34).
        self._no_cache: set[tuple[str, str]] = set()

    # --- plumbing ------------------------------------------------------------------------------------------------

    @property
    def client(self) -> Any:
        with self._lock:
            if self._client is None:
                import boto3
                from botocore.config import Config

                cfg = Config(read_timeout=READ_TIMEOUT, connect_timeout=10, retries={"max_attempts": 1})
                self._client = boto3.client("bedrock-runtime", region_name=self._region, config=cfg)
            return self._client

    def client_for(self, region: str | None) -> Any:
        """The client of the Region a model is called in: this runtime's own for the bundled models, the model's own
        for one the owner added with another Region (§45.34). A client given to the constructor (a test's) answers
        for every Region unless a ``client_factory`` is given too."""
        if not region or region == self._region or (self._injected and self._factory is None):
            return self.client
        with self._lock:
            found = self._clients.get(region)
            if found is None:
                if self._factory is not None:
                    found = self._factory(region)
                else:
                    import boto3
                    from botocore.config import Config

                    cfg = Config(read_timeout=READ_TIMEOUT, connect_timeout=10, retries={"max_attempts": 1})
                    found = boto3.client("bedrock-runtime", region_name=region, config=cfg)
                self._clients[region] = found
            return found

    def table(self) -> Any:
        if not callable(self._table) or hasattr(self._table, "get_item"):
            return self._table
        t = getattr(self._local, "table", None)
        if t is None:
            t = self._local.table = self._table()
        return t

    def workspace(self, ctx: CallContext) -> Workspace:
        return Workspace(self.table(), self._get_bytes, ctx.user_id, ctx.workspace_id)

    # --- the call ------------------------------------------------------------------------------------------------

    def complete(
        self,
        ctx: CallContext,
        *,
        task: str,
        messages: list[dict[str, Any]],
        override: dict[str, Any] | None = None,
        schema: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int = 16000,
        on_text: Callable[[str], None] | None = None,
        allow_inactive: bool = False,
    ) -> Reply:
        """One model call for ``ctx``'s agent (see ``ModelClient``). ``on_text`` gets the answer's text so far while
        it streams (ConverseStream); without it the call is a plain Converse. ``allow_inactive`` lets the quality
        agent's fact check of a driving-safety story run while the agent is off (§45.26). With a ``schema`` and
        ``tools`` together, an answer that calls only the caller's tools comes back as it is (``data`` None, the
        calls in ``tool_calls``): the caller runs them and calls again with their results.

        ``task="check_models"`` (Check models) is one bare request: no agent instructions, skills or memory, no
        agent switch, and no MODELSTATUS# of its own (the check writes the one item per model)."""
        ws = self.workspace(ctx)
        bare = task == CHECK_TASK
        catalog = ws.models()
        profile = ws.agent(ctx.agent_id)
        if not bare and task not in profile.tasks:
            log("warn", "stories.task_agent_mismatch", task=task, agent=ctx.agent_id)
        if not bare and not profile.active and not allow_inactive:
            raise AgentOff(AGENT_OFF.format(name=profile.name))
        stored, conversation, project = ws.levels(
            job_id=ctx.job_id, task_id=ctx.task_id, conv_id=ctx.conv_id, msg_id=ctx.msg_id
        )
        ai = ws.ai()
        choice = resolve(
            task=task,
            agent={} if bare else {"model": profile.model, "effort": profile.effort},
            ai=ai,
            override=override if override is not None else stored,
            conversation=conversation,
            project=project,
            catalog=catalog,
        )
        info = config.model(choice.model, catalog) or {}
        system = [] if bare else ws.system_blocks(profile)
        limit = info.get("maxOutputTokens")
        if isinstance(limit, int) and limit > 0:
            max_tokens = min(int(max_tokens), limit)
        model_id, region = self.called_as(info)
        _, takes_tools, _ = config.call_shape(info)
        msgs = [dict(m) for m in messages]
        tool_list = [tool_spec(t) for t in tools or []] if takes_tools else []
        tools_off = bool(tools) and not takes_tools
        if tools_off:  # the chat runs without its tool actions on this model and says so (§45.35 D1)
            msgs = _nudge(msgs, NO_TOOLS_NUDGE)
        if schema is not None and takes_tools:
            tool_list.append(
                {"toolSpec": {"name": ANSWER_TOOL, "description": "Give your answer.", "inputSchema": {"json": schema}}}
            )
            msgs = _nudge(msgs)
        elif schema is not None:  # no tools: the answer is asked for as JSON in the text, checked the same way
            msgs = _nudge(msgs, JSON_NUDGE.format(schema=json.dumps(schema, ensure_ascii=False, separators=(",", ":"))))
        try:
            return self._answer(
                ctx, task, choice, info, system, msgs, tool_list, schema, max_tokens, on_text, ai, catalog,
                record=not bare, takes_tools=takes_tools, tools_off=tools_off,
            )  # fmt: skip
        except Exception as e:  # every failure also says the model id and Region it was sent to (§45.35 D5)
            _asked(e, choice, model_id, region, task)
            raise

    def _answer(
        self,
        ctx: CallContext,
        task: str,
        choice: Choice,
        info: dict[str, Any],
        system: list[str],
        msgs: list[dict[str, Any]],
        tool_list: list[dict[str, Any]],
        schema: dict[str, Any] | None,
        max_tokens: int,
        on_text: Callable[[str], None] | None,
        ai: dict[str, Any],
        catalog: dict[str, Any],
        *,
        record: bool,
        takes_tools: bool,
        tools_off: bool,
    ) -> Reply:
        """The call and, for a schema, its check and one more ask (§45.7)."""
        model_id, region = self.called_as(info)
        total: dict[str, int] = {}
        for attempt in (1, 2):
            answer = self._send(ctx, task, choice, info, system, msgs, tool_list, max_tokens, on_text, ai, catalog,
                                record=record)  # fmt: skip
            total = _add(total, answer.usage)
            text = "".join(str(b.get("text") or "") for b in answer.content if "text" in b)
            calls = [
                {"id": b["toolUse"].get("toolUseId"), "name": b["toolUse"].get("name"), "input": _json(b["toolUse"])}
                for b in answer.content
                if "toolUse" in b
            ]
            if answer.stop_reason == "refusal":
                raise ModelRefused(
                    REFUSED.format(label=info.get("label") or choice.model), model=choice.model, effort=choice.effort
                )
            data: dict[str, Any] | None = None
            use = next((c for c in calls if c["name"] == ANSWER_TOOL), None)
            wants_tools = use is None and any(c["name"] != ANSWER_TOOL for c in calls)
            if schema is not None and not wants_tools:  # a caller's tool first: its tool loop runs it, then asks again
                value = use["input"] if use else (_json_text(text) if takes_tools else _json_in(text))
                missing = (
                    f"You did not call {ANSWER_TOOL}." if takes_tools else "You did not answer with one JSON object."
                )
                problems = check(schema, value) if isinstance(value, dict) else [missing]
                if problems:
                    if attempt == 2 or answer.stop_reason == "max_tokens":
                        raise AnswerInvalid(problems, model=choice.model, effort=choice.effort)
                    msgs = _ask_again(msgs, answer.content, problems, json_text=not takes_tools)
                    continue
                assert isinstance(value, dict)
                data = value
            return Reply(
                text=text,
                data=data,
                tool_calls=calls,
                content=answer.content,
                stop_reason=answer.stop_reason,
                model=choice.model,
                effort=choice.effort,
                effort_applied=choice.effort_applied,
                usage=total,
                model_id=model_id,
                region=region,
                tools_off=tools_off,
                task=task,
            )
        raise AssertionError("unreachable")

    def called_as(self, info: dict[str, Any]) -> tuple[str, str | None]:
        """The Bedrock model id or inference profile a call to this model is sent to, and the Region (the model's own
        for one the owner added in another Region, else this runtime's), as each record keeps them (§45.35 D5)."""
        model_id = str(info.get("profile") or info.get("modelId") or "")
        own = str(info.get("region") or "") if info.get("custom") else ""
        return model_id, own or self._region

    def request(
        self,
        choice: Choice,
        info: dict[str, Any],
        system: list[str],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
    ) -> dict[str, Any]:
        """The Converse request body (a test records it), built from how the model is called (``config.call_shape``,
        §45.35 D1): the model's profile, the system blocks, a cache point only for a model that takes one, the effort
        as ``output_config.effort`` only for a model whose ``effortField`` is ``output_config`` (and only when it offers
        efforts), never ``thinking``, and tools with automatic choice only for a model that takes tools."""
        effort_field, takes_tools, _ = config.call_shape(info)
        blocks: list[dict[str, Any]] = [{"text": b} for b in system if b.strip()]
        model_id = str(info.get("profile") or info.get("modelId"))
        if blocks and self.caches(info):
            blocks.append({"cachePoint": {"type": "default"}})
        body: dict[str, Any] = {
            "modelId": model_id,
            "system": blocks,
            "messages": messages,
            "inferenceConfig": {"maxTokens": int(max_tokens)},
        }
        if choice.effort_applied and choice.effort and effort_field == "output_config":
            body["additionalModelRequestFields"] = {"output_config": {"effort": choice.effort}}
        if tools and takes_tools:
            body["toolConfig"] = {"tools": tools, "toolChoice": {"auto": {}}}
        return body

    @staticmethod
    def _cache_key(info: dict[str, Any]) -> tuple[str, str]:
        region = str(info.get("region") or "") if info.get("custom") else ""
        return region, str(info.get("profile") or info.get("modelId"))

    def caches(self, info: dict[str, Any]) -> bool:
        """Whether a call to this model carries a cache point: a model that takes one (``cache``, §45.35 D1), until
        Bedrock refused one for it."""
        return config.call_shape(info)[2] and self._cache_key(info) not in self._no_cache

    def _send(
        self,
        ctx: CallContext,
        task: str,
        choice: Choice,
        info: dict[str, Any],
        system: list[str],
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
        on_text: Callable[[str], None] | None,
        ai: dict[str, Any],
        catalog: dict[str, Any] | None = None,
        *,
        record: bool = True,
    ) -> _Answer:
        label = str(info.get("label") or choice.model)
        client = self.client_for(info.get("region") if info.get("custom") else None)
        while True:
            body = self.request(choice, info, system, messages, tools, max_tokens)
            try:
                send = (
                    functools.partial(self._stream, body, on_text, client)
                    if on_text
                    else functools.partial(self._converse, body, client)
                )
                answer = retry_sync(
                    send,
                    what="bedrock.converse",
                    attempts=CALL_ATTEMPTS,
                    sleep=self._sleep or time.sleep,
                )
            except Exception as e:
                msg = _message(e).lower()
                cached = any("cachePoint" in b for b in body.get("system") or [])
                if cached and _code(e) == "ValidationException" and "cache" in msg:
                    log("info", "stories.cache_points_off", model=choice.model)
                    with self._lock:
                        self._no_cache.add(self._cache_key(info))
                    continue
                log("warn", "stories.model_failed", model=choice.model, task=task, code=_code(e), detail=msg[:300])
                if choice.effort_applied and choice.effort and effort_refused(e):
                    # Bedrock refused the effort field itself: the owner is told it is the effort, and the call is
                    # never sent again without it (that would pretend the setting was applied, §45.34).
                    line = EFFORT_REFUSED.format(label=label, effort=EFFORT_WORDS.get(choice.effort, choice.effort))
                    if record:
                        self._model_status(ctx, choice.model, "error", line)
                    raise EffortUnavailable(
                        line, model=choice.model, effort=choice.effort, sent=True, status="error"
                    ) from e
                found = unavailable(e)
                status = found[0] if found else "error"
                if record:
                    self._model_status(ctx, choice.model, status, status_line(found))
                if found:
                    raise ModelUnavailable(
                        UNAVAILABLE.format(label=label, reason=found[1]),
                        model=choice.model,
                        effort=choice.effort,
                        status=found[0],
                    ) from e
                # Any other failure (a timeout, a model error, throttling after the retries) keeps its own type and
                # also says what was asked, so a failed job step or task still shows its model and effort (§45.34).
                _asked(e, choice)
                raise
            if record:
                self._model_status(ctx, choice.model, "ok", STATUS_LINES["ok"])
            self._usage(ctx, task, choice, answer.usage, ai, info, catalog)
            return answer

    def _converse(self, body: dict[str, Any], client: Any = None) -> _Answer:
        r = (client or self.client).converse(**body)
        content = list(((r.get("output") or {}).get("message") or {}).get("content") or [])
        return _Answer(content, str(r.get("stopReason") or ""), _usage(r.get("usage")))

    def _stream(self, body: dict[str, Any], on_text: Callable[[str], None], client: Any = None) -> _Answer:
        r = (client or self.client).converse_stream(**body)
        blocks: dict[int, dict[str, Any]] = {}
        tool_json: dict[int, str] = {}
        text = ""
        stop = ""
        usage: dict[str, int] = {}
        for event in r.get("stream") or []:
            if "contentBlockStart" in event:
                start = event["contentBlockStart"]
                i = int(start.get("contentBlockIndex") or 0)
                use = (start.get("start") or {}).get("toolUse")
                if use:
                    blocks[i] = {"toolUse": {"toolUseId": use.get("toolUseId"), "name": use.get("name"), "input": {}}}
                    tool_json[i] = ""
            elif "contentBlockDelta" in event:
                d = event["contentBlockDelta"]
                i = int(d.get("contentBlockIndex") or 0)
                delta = d.get("delta") or {}
                if "text" in delta:
                    blocks.setdefault(i, {"text": ""})
                    blocks[i]["text"] = str(blocks[i].get("text") or "") + str(delta["text"])
                    text += str(delta["text"])
                    with contextlib.suppress(Exception):  # a writer's fault never stops the answer
                        on_text(text)
                elif "toolUse" in delta:
                    tool_json[i] = tool_json.get(i, "") + str((delta["toolUse"] or {}).get("input") or "")
                elif "reasoningContent" in delta:
                    rc = blocks.setdefault(i, {"reasoningContent": {"reasoningText": {"text": ""}}})
                    part = delta["reasoningContent"]
                    rt = rc["reasoningContent"].setdefault("reasoningText", {"text": ""})
                    if "text" in part:
                        rt["text"] = str(rt.get("text") or "") + str(part["text"])
                    if "signature" in part:
                        rt["signature"] = part["signature"]
                    if "redactedContent" in part:
                        rc["reasoningContent"] = {"redactedContent": part["redactedContent"]}
            elif "messageStop" in event:
                stop = str(event["messageStop"].get("stopReason") or "")
            elif "metadata" in event:
                usage = _usage(event["metadata"].get("usage"))
        for i, raw in tool_json.items():
            blocks[i]["toolUse"]["input"] = _json_text(raw) or {}
        return _Answer([blocks[i] for i in sorted(blocks)], stop, usage)

    # --- what every call writes ----------------------------------------------------------------------------------

    def _put(self, item: dict[str, Any]) -> None:
        try:
            self.table().put_item(Item=_to_ddb(item))
        except Exception as e:  # a bookkeeping write never fails the call it records
            log("warn", "stories.bookkeeping_failed", sk=item.get("sk"), error=type(e).__name__)

    def _model_status(self, ctx: CallContext, model_key: str, status: str, line: str) -> None:
        """``MODELSTATUS#{model}`` after a real call: an update of its fields, so the mark of a Check models run
        (``by: "check"``, what ticks setup step 1, §45.35 D7) stays when a later chat or job call writes the status."""
        fields = {
            "type": keys.TYPE_MODELSTATUS,
            "userId": ctx.user_id,
            "workspaceId": ctx.workspace_id,
            "model": model_key,
            "status": status,
            "line": line,
            "checkedAt": now_iso(),
        }
        names = {f"#f{i}": k for i, k in enumerate(fields)}
        values = {f":v{i}": _to_ddb(v) for i, v in enumerate(fields.values())}
        sk = keys.modelstatus_sk(model_key)
        try:
            self.table().update_item(
                Key={"pk": keys.ws_pk(ctx.user_id, ctx.workspace_id), "sk": sk},
                UpdateExpression="SET " + ", ".join(f"{n} = :v{i}" for i, n in enumerate(names)),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=values,
            )
        except Exception as e:  # a bookkeeping write never fails the call it records
            log("warn", "stories.bookkeeping_failed", sk=sk, error=type(e).__name__)

    def _usage(
        self,
        ctx: CallContext,
        task: str,
        choice: Choice,
        usage: dict[str, int],
        ai: dict[str, Any],
        info: dict[str, Any] | None = None,
        catalog: dict[str, Any] | None = None,
    ) -> None:
        price = price_of(choice.model, ai, catalog)
        at, item_id = now_iso(), ulid()
        item: dict[str, Any] = {
            "pk": keys.ws_pk(ctx.user_id, ctx.workspace_id),
            "sk": keys.usage_sk(at[:10], item_id),
            "type": keys.TYPE_USAGE,
            "userId": ctx.user_id,
            "workspaceId": ctx.workspace_id,
            "kind": "model",
            "usageId": item_id,
            "day": at[:10],
            "at": at,
            "model": choice.model,
            "modelId": str((info or config.model(choice.model, catalog) or {}).get("profile") or ""),
            "task": task,
            "agentId": ctx.agent_id,
            "input": usage.get("input", 0),
            "output": usage.get("output", 0),
            "cacheRead": usage.get("cacheRead", 0),
            "cacheWrite": usage.get("cacheWrite", 0),
            "effort": choice.effort,
            "effortApplied": choice.effort_applied,
            "cost": cost_of(usage, price),
            "currency": (price or {}).get("currency"),
            "priceSource": (price or {}).get("source"),
            "ttl": int(time.time()) + keys.USAGE_DAYS * 86400,
        }
        for name, value in (("jobId", ctx.job_id), ("taskId", ctx.task_id), ("convId", ctx.conv_id),
                            ("msgId", ctx.msg_id)):  # fmt: skip
            if value:
                item[name] = value
        self._put(item)


def _nudge(messages: list[dict[str, Any]], nudge: str = ANSWER_NUDGE) -> list[dict[str, Any]]:
    """The last user message ends with the instruction to answer through ``submit_answer`` (tool choice stays
    automatic: these models refuse a forced one), or with another instruction (``nudge``)."""
    out = [dict(m) for m in messages]
    for m in reversed(out):
        if m.get("role") == "user":
            m["content"] = [*list(m.get("content") or []), {"text": nudge}]
            return out
    return [*out, {"role": "user", "content": [{"text": nudge}]}]


def _ask_again(
    messages: list[dict[str, Any]], content: list[dict[str, Any]], problems: list[str], *, json_text: bool = False
) -> list[dict[str, Any]]:
    """The model's own answer back, with exactly what is wrong (asked once more, §45.7). Every ``toolUse`` in the
    answer gets its ``toolResult`` (Converse refuses a turn that leaves one out): ``submit_answer``'s says what is
    wrong, any other tool's says it was not run. A model without tools (``json_text``) is asked for the JSON again."""
    feedback = "Problems: " + "; ".join(problems[:20]) + " " + (JSON_AGAIN if json_text else ANSWER_NUDGE)
    out = [*messages, {"role": "assistant", "content": content or [{"text": "(no answer)"}]}]
    results: list[dict[str, Any]] = []
    answered = False
    for block in content:
        use = block.get("toolUse") if isinstance(block, dict) else None
        if not isinstance(use, dict) or not use.get("toolUseId"):
            continue
        mine = use.get("name") == ANSWER_TOOL
        answered = answered or mine
        results.append(
            {"toolResult": {"toolUseId": use["toolUseId"], "content": [{"text": feedback if mine else NOT_RUN}],
                            "status": "error"}}
        )  # fmt: skip
    if not answered:
        results.append({"text": feedback})
    return [*out, {"role": "user", "content": results}]


def _json(use: dict[str, Any]) -> Any:
    value = use.get("input")
    return _json_text(value) if isinstance(value, str) else value


def _json_text(text: str) -> Any:
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").removeprefix("json").strip()
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None


def _json_in(text: str) -> Any:
    """The JSON object a model without tools answered in its text (§45.35 D1): the whole text, or its first complete
    object when the model put words or a code fence around it."""
    found = _json_text(text)
    if isinstance(found, dict):
        return found
    decoder = json.JSONDecoder()
    raw = text or ""
    start = raw.find("{")
    while start != -1:
        try:
            value, _ = decoder.raw_decode(raw, start)
        except ValueError:
            start = raw.find("{", start + 1)
            continue
        if isinstance(value, dict):
            return value
        start = raw.find("{", start + 1)
    return found


def _to_ddb(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float):
        return Decimal(str(round(value, 6))) if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_to_ddb(v) for v in value]
    return value
