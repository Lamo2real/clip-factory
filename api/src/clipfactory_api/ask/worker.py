"""``cf-prod-ask``: answers one Ask question and streams it over the WebSocket (docs/CONTRACTS.md §27.5).

Started by ``POST /v1/help/asks`` with an async Invoke (retries 0, so an answer never runs twice). Order of work:
``ask.started`` → the owner's skills (no skills, no model call) → the knowledge pack → the web key state → the files
(read, checked, turned into content blocks) → APP STATE → up to 8 streamed model iterations with read-only tools →
``ask.done``. Text deltas are batched (≥ 80 ms or 400 characters) and pass a 64-character secrets hold-back first. The
answer stops on the owner's Stop (checked at most every 1.5 s), on a closed socket (``GoneException`` ends the model
stream at once), or at the hard budget. The question's files are deleted in ``finally`` whatever happened.

One ``help.ask`` log line per question with ids, counts, timings, token usage and the outcome; never the question,
history, answer, file names or contents, URLs, search queries or the search key.
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .. import db, s3
from ..clock import Clock, utcnow
from ..log import LogValue, log
from ..realtime import encode, is_gone
from . import files as askfiles
from . import prompt
from .fetch import Page
from .knowledge import Knowledge
from .redact import Holdback
from .search import KeyReader, SearchError, SearchProvider
from .state import Reader
from .tools import Toolbox, typed_urls

SOFT_S = 95.0
HARD_S = 110.0
MAX_ITERATIONS = 8
MAX_TOKENS = 16_000
OUTPUT_BUDGET = 24_000
INPUT_BUDGET = 400_000
STOP_CHECK_S = 1.5
DELTA_MS = 80
DELTA_CHARS = 400
STOP_SK = "ASK#STOP#"
REFUSED_TEXT = "I can't help with that one."
BUDGET_TEXT = "\n\nI ran out of time. Ask me to go on."
CUT_TEXT = "\n\nThe answer was cut short. Ask me to go on."
REDACTED_NOTE = "\n\nI hid things that looked like keys."
STATUS_FOR_TOOL = {
    "web_search": ("searching", "Searching the web…"),
    "web_fetch": ("reading", "Reading a page…"),
    "read_app_doc": ("checking_app", "Reading the Clip Factory guide…"),
    "read_my_clip_factory": ("checking_app", "Checking your setup…"),
}


class AskGone(Exception):
    """The owner's socket closed: stop spending tokens."""


class _Abort(Exception):
    def __init__(self, stop: str) -> None:
        super().__init__(stop)
        self.stop = stop


def stop_sk(ask_id: str) -> str:
    return STOP_SK + ask_id


@dataclass
class WorkerDeps:
    store: db.Store
    media: s3.Media
    management: Any
    mantle: Callable[[], Any]
    model_id: str
    fallback_model_id: str = ""
    effort: str = "medium"
    eager: bool = True
    tool_docs: bool = True
    key_reader: KeyReader | None = None
    provider: SearchProvider | None = None
    fetcher: Callable[[str], Page] | None = None
    knowledge: Callable[[], Knowledge] | None = None
    builtins: Callable[[], Any] | None = None
    route_ok: Callable[[str], bool] = lambda _to: True
    clock: Clock = utcnow
    monotonic: Callable[[], float] = time.monotonic
    soft_s: float = SOFT_S
    hard_s: float = HARD_S


@dataclass
class Sender:
    """Posts events to one connection. Deltas pass the hold-back and are batched."""

    management: Any
    connection_id: str
    ask_id: str
    monotonic: Callable[[], float]
    seq: int = 0
    sent_text: bool = False
    first_text_at: float | None = None
    holdback: Holdback = field(default_factory=Holdback)
    _buffer: str = ""
    _last_flush: float = 0.0

    def send(self, event: dict[str, Any]) -> None:
        message = {**event, "askId": self.ask_id}
        try:
            self.management.post_to_connection(ConnectionId=self.connection_id, Data=encode(message))
        except Exception as e:
            if is_gone(e):
                raise AskGone from None
            log("warning", "ask.post_failed", error=type(e).__name__)

    def text(self, chunk: str) -> None:
        self._buffer += self.holdback.push(chunk)
        now = self.monotonic()
        if self._buffer and (len(self._buffer) >= DELTA_CHARS or (now - self._last_flush) * 1000 >= DELTA_MS):
            self._flush(now)

    def _flush(self, now: float) -> None:
        if not self._buffer:
            return
        self.seq += 1
        if self.first_text_at is None:
            self.first_text_at = now
        text, self._buffer = self._buffer, ""
        self._last_flush = now
        self.sent_text = True
        self.send({"type": "ask.delta", "seq": self.seq, "text": text})

    def finish_text(self) -> None:
        self._buffer += self.holdback.flush()
        self._flush(self.monotonic())


@dataclass
class Record:
    outcome: str = "ask_error"
    stop: str = "error"
    iterations: int = 0
    usage_in: int = 0
    usage_out: int = 0
    cache_read: int = 0
    cache_write: int = 0
    model: str = ""
    web: str = "off"
    files: dict[str, int] = field(default_factory=lambda: {"image": 0, "pdf": 0, "text": 0, "office": 0})
    file_kb: int = 0


# --- the body -------------------------------------------------------------------------------------------------


def _turns(history: Any) -> list[dict[str, Any]]:
    """History as plain text turns (never citations in user messages), starting with a user turn."""
    out: list[dict[str, Any]] = []
    for turn in history if isinstance(history, list) else []:
        if not isinstance(turn, dict) or turn.get("role") not in {"user", "assistant"}:
            continue
        text = str(turn.get("text") or "")
        names = [
            f"{f.get('name')} ({f.get('format')})"
            for f in turn.get("files") or []
            if isinstance(f, dict) and isinstance(f.get("name"), str)
        ]
        if names:
            text = (text + "\n" if text else "") + "[Files he attached: " + ", ".join(names) + "]"
        if not text.strip():
            continue
        if not out and turn["role"] == "assistant":
            continue
        out.append({"role": turn["role"], "content": [{"type": "text", "text": text}]})
    return out


def _model_label(model: str) -> str:
    return "opus-4-8" if "opus-4-8" in model else "opus-5-5"


# --- the answer ---------------------------------------------------------------------------------------------


def answer(deps: WorkerDeps, payload: Mapping[str, Any]) -> Record:
    started = deps.monotonic()
    ask_id = str(payload.get("askId") or "")
    sub = str(payload.get("sub") or "")
    connection_id = str(payload.get("connectionId") or "")
    raw_body, raw_flags = payload.get("body"), payload.get("flags")
    body: dict[str, Any] = raw_body if isinstance(raw_body, dict) else {}
    flags: dict[str, Any] = raw_flags if isinstance(raw_flags, dict) else {}
    refs = [f for f in (body.get("files") or []) if isinstance(f, dict)]
    keys = [
        askfiles.file_key(sub, str(f["fileId"]))
        for f in refs
        if isinstance(f.get("fileId"), str) and askfiles.FILE_ID.match(f["fileId"])
    ]
    record = Record()
    sender = Sender(deps.management, connection_id, ask_id, deps.monotonic)
    tools_used: dict[str, int] = {}
    knowledge_version = ""
    try:
        if not (ask_id and sub and connection_id):
            record.outcome = "ask_bad_body"
            return record
        sender.send({"type": "ask.started"})
        sender.send({"type": "ask.status", "kind": "thinking", "label": "Thinking…"})
        knowledge_version = _run(
            deps, sender, record, tools_used, sub=sub, ask_id=ask_id, body=body, flags=flags, refs=refs, started=started
        )
    except AskGone:
        record.outcome, record.stop = "ask_gone", "stopped"
    except Exception as e:
        record.outcome = "ask_error"
        log("error", "ask.worker_failed", error=type(e).__name__)
        try:
            if sender.sent_text:
                sender.text(CUT_TEXT)
                sender.finish_text()
                sender.send({"type": "ask.done", "stop": "error", "links": []})
            else:
                sender.send({"type": "ask.error", "code": "unavailable", "message": "Ask can't answer right now."})
        except AskGone:
            pass
    finally:
        for key in keys:
            try:
                deps.media.delete(key)
            except Exception as e:
                log("warning", "ask.file_delete_failed", error=type(e).__name__)
        first = sender.first_text_at
        fields: dict[str, LogValue] = {
            "requestId": str(payload.get("requestId") or ""),
            "askId": ask_id,
            "outcome": record.outcome,
            "stop": record.stop,
            "ms": round((deps.monotonic() - started) * 1000),
            "firstWordsMs": round((first - started) * 1000) if first is not None else None,
            "iterations": record.iterations,
            "toolsSearch": tools_used.get("web_search", 0),
            "toolsFetch": tools_used.get("web_fetch", 0),
            "toolsDoc": tools_used.get("read_app_doc", 0),
            "toolsMe": tools_used.get("read_my_clip_factory", 0),
            "toolsButtons": tools_used.get("show_app_buttons", 0),
            "files": len(refs),
            "filesImage": record.files["image"],
            "filesPdf": record.files["pdf"],
            "filesPlain": record.files["text"],
            "filesOffice": record.files["office"],
            "fileKb": record.file_kb,
            "usageIn": record.usage_in,
            "usageOut": record.usage_out,
            "cacheRead": record.cache_read,
            "cacheWrite": record.cache_write,
            "model": record.model,
            "web": record.web,
            "knowledgeVersion": knowledge_version,
        }
        log("info", "help.ask", **fields)
    return record


def _run(
    deps: WorkerDeps,
    sender: Sender,
    record: Record,
    tools_used: dict[str, int],
    *,
    sub: str,
    ask_id: str,
    body: Mapping[str, Any],
    flags: Mapping[str, Any],
    refs: list[dict[str, Any]],
    started: float,
) -> str:
    """Prepares the question (skills, knowledge, web, files, APP STATE), runs the model loop and sends ask.done.
    Returns the knowledge version for the log line."""
    from ..skill_prompt import load_block
    from ..skills import load_builtins
    from . import knowledge as knowledge_mod

    try:
        skills = load_block(deps.store, deps.media, sub, where="api.ask", builtins=deps.builtins or load_builtins)
    except Exception as e:
        log("warning", "help.skills_failed", error=type(e).__name__)
        record.outcome, record.stop = "ask_skills", "error"
        sender.send({"type": "ask.error", "code": "model", "message": "Ask can't think it through right now."})
        return ""
    knowledge = (deps.knowledge or knowledge_mod.load)()
    key = _web_key(deps, record, flags)
    files_on = flags.get("files", True) is not False
    file_blocks: list[dict[str, Any]] = []
    file_notes: list[str] = []
    redacted = False
    if refs:
        sender.send({"type": "ask.status", "kind": "reading_files", "label": "Reading your files…"})
        file_blocks, file_notes, results, redacted = _read_files(deps, record, sub, refs, enabled=files_on)
        sender.send({"type": "ask.files", "files": results})
        if redacted:
            file_notes.append("Some parts that looked like keys were hidden before you saw the files.")

    question = str(body.get("question") or "")
    raw_history = body.get("history")
    history: list[Any] = raw_history if isinstance(raw_history, list) else []
    user_texts = [
        question,
        *(str(t.get("text") or "") for t in history if isinstance(t, dict) and t.get("role") == "user"),
    ]
    sender.send({"type": "ask.status", "kind": "checking_app", "label": "Checking your setup…"})
    reader = Reader(deps.store, deps.media, sub, deps.clock())
    raw_context = body.get("context")
    context: dict[str, Any] = raw_context if isinstance(raw_context, dict) else {}
    state = reader.app_state(
        context=context, ask={"web": record.web, "files": files_on, "knowledgeVersion": knowledge.version}
    )
    loop = _Loop(
        deps=deps,
        sender=sender,
        record=record,
        tools_used=tools_used,
        sub=sub,
        ask_id=ask_id,
        started=started,
        messages=_messages(question, history, refs, file_blocks, file_notes, state),
        toolbox=Toolbox(
            knowledge=knowledge,
            reader=reader,
            search_key=key,
            provider=deps.provider if record.web == "on" else None,
            fetcher=deps.fetcher or _default_fetch,
            allowed_urls=typed_urls(user_texts),
            on_actions=lambda actions: sender.send({"type": "ask.actions", "actions": actions}),
            route_ok=deps.route_ok,
            soft_deadline=lambda: deps.monotonic() - started >= deps.soft_s,
            tool_docs=deps.tool_docs,
        ),
    )
    for name in (str(r.get("name") or "") for r in refs):
        loop.toolbox.titles[name[: askfiles.NAME_MAX]] = "file"
    stop = loop.run(skills, knowledge)
    if stop is None:  # the model failed; the loop already told the owner
        return knowledge.version
    if stop == "refused" and not sender.sent_text:
        sender.text(REFUSED_TEXT)
    if stop == "budget":
        sender.text(BUDGET_TEXT)
    sender.finish_text()
    if redacted or sender.holdback.hit:
        sender.text(REDACTED_NOTE)
        sender.finish_text()
    done: dict[str, Any] = {"type": "ask.done", "stop": stop, "links": sorted(loop.toolbox.links)}
    if record.web == "no_key":
        done["webMissing"] = True
    sender.send(done)
    record.stop = stop
    record.outcome = {"end": "ask_ok", "budget": "ask_budget", "stopped": "ask_stopped", "refused": "ask_refused"}[stop]
    return knowledge.version


@dataclass
class _Loop:
    """The model loop of one answer: up to 8 streamed iterations, tools between them, budgets and Stop."""

    deps: WorkerDeps
    sender: Sender
    record: Record
    tools_used: dict[str, int]
    sub: str
    ask_id: str
    started: float
    messages: list[Any]
    toolbox: Toolbox
    _last_check: float = 0.0

    def elapsed(self) -> float:
        return self.deps.monotonic() - self.started

    def check(self, now_s: float, *, force: bool = False) -> None:
        """The hard budget, then the owner's Stop item (read at most every 1.5 s)."""
        if now_s - self.started >= self.deps.hard_s:
            raise _Abort("budget")
        if force or now_s - self._last_check >= STOP_CHECK_S:
            self._last_check = now_s
            if self.deps.store.get(db.user_pk(self.sub), stop_sk(self.ask_id)):
                raise _Abort("stopped")

    def run(self, skills: Any, knowledge: Knowledge) -> str | None:
        """The stop reason ("end", "budget", "stopped", "refused"), or None when the model failed."""
        from .. import learn

        deps, record = self.deps, self.record
        tool_list = prompt.tools(web_search=record.web == "on", eager=deps.eager)
        system = prompt.system_blocks(knowledge)
        client = deps.mantle()
        docs_retry = False
        try:
            from anthropic import BetaFallbackState

            pin: Any = BetaFallbackState()  # one per answer: a fallback sticks for this answer's later iterations
        except ImportError:
            pin = contextlib.nullcontext()
        try:
            with pin:
                while True:
                    self.check(deps.monotonic(), force=True)
                    record.iterations += 1
                    final_round = (
                        record.iterations >= MAX_ITERATIONS
                        or self.elapsed() >= deps.soft_s
                        or record.usage_in + record.cache_write > INPUT_BUDGET
                    )
                    try:
                        final = _stream_once(
                            learn,
                            client,
                            deps,
                            sender=self.sender,
                            toolbox=self.toolbox,
                            check=self.check,
                            skills=skills,
                            system=system,
                            messages=self.messages,
                            tools=tool_list,
                            tool_choice={"type": "none"} if final_round else None,
                            timeout=max(5.0, deps.hard_s - self.elapsed()),
                        )
                    except (AskGone, _Abort):
                        raise
                    except Exception as e:
                        if not docs_retry and getattr(e, "status_code", None) == 400 and _drop_tool_docs(self.messages):
                            docs_retry = True
                            self.toolbox.tool_docs = False
                            record.iterations -= 1
                            continue
                        _model_failed(e, record, self.sender, self.toolbox)
                        return None
                    _count_usage(record, final, deps.model_id)
                    reason = str(getattr(final, "stop_reason", "") or "")
                    content = list(final.content)
                    if reason == "refusal":
                        return "refused"
                    if reason == "pause_turn":
                        self.messages.append({"role": "assistant", "content": content})
                        continue
                    if record.usage_out >= OUTPUT_BUDGET:
                        return "budget"
                    uses = [b for b in content if getattr(b, "type", "") == "tool_use"]
                    if not uses or reason != "tool_use":
                        return "end"
                    self.messages.append({"role": "assistant", "content": content})
                    self.messages.append(
                        {"role": "user", "content": _run_tools(uses, self.toolbox, self.sender, self.tools_used)}
                    )
        except _Abort as a:
            return a.stop


def _web_key(deps: WorkerDeps, record: Record, flags: Mapping[str, Any]) -> str | None:
    """The search key, and ``record.web``: on (a key), no_key, or off (the kill switch's ``web`` flag)."""
    if flags.get("web", True) is False:
        record.web = "off"
        return None
    try:
        key = deps.key_reader.get() if deps.key_reader is not None else None
    except SearchError:
        key = None
    record.web = "on" if key and deps.provider is not None else "no_key"
    return key


def _messages(  # noqa: PLR0917 (one call site, all required)
    question: str,
    history: list[Any],
    refs: list[dict[str, Any]],
    file_blocks: list[dict[str, Any]],
    file_notes: list[str],
    state: str,
) -> list[Any]:
    """History (plain text), this question with its files first, then APP STATE as a mid-conversation system
    message after the final user message (it changes every question, so it sits after every cached part)."""
    names = [f"{r.get('name')} ({r.get('format')})" for r in refs if isinstance(r.get("name"), str)]
    text = question or "Look at the files I added and tell me what you see."
    if names:
        text += "\n\n[Files attached to this question: " + ", ".join(names) + "]"
    if file_notes:
        text += "\n[" + " ".join(file_notes) + "]"
    messages: list[Any] = _turns(history)
    messages.append({"role": "user", "content": [*file_blocks, {"type": "text", "text": text}]})
    messages.append({"role": "system", "content": state})
    return messages


def _model_failed(e: Exception, record: Record, sender: Sender, toolbox: Toolbox) -> None:
    record.outcome = "ask_model_timeout" if "Timeout" in type(e).__name__ else "ask_model_error"
    record.stop = "error"
    log("warning", "ask.model_failed", error=type(e).__name__, status=getattr(e, "status_code", None))
    if sender.sent_text:
        sender.text(CUT_TEXT)
        sender.finish_text()
        sender.send({"type": "ask.done", "stop": "error", "links": sorted(toolbox.links)})
    else:
        sender.send({"type": "ask.error", "code": "model", "message": "I couldn't think it through this time."})


def _count_usage(record: Record, final: Any, model_id: str) -> None:
    usage = final.usage
    record.usage_in += int(getattr(usage, "input_tokens", 0) or 0)
    record.usage_out += int(getattr(usage, "output_tokens", 0) or 0)
    record.cache_read += int(getattr(usage, "cache_read_input_tokens", 0) or 0)
    record.cache_write += int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
    record.model = _model_label(str(getattr(final, "model", "") or model_id))


def _run_tools(uses: list[Any], toolbox: Toolbox, sender: Sender, tools_used: dict[str, int]) -> list[dict[str, Any]]:
    """Every tool_use of one turn answered in one user message (parallel calls stay parallel)."""
    results = []
    for block in uses:
        name = str(getattr(block, "name", ""))
        tools_used[name] = tools_used.get(name, 0) + 1
        outcome = toolbox.run(name, getattr(block, "input", None))
        if outcome.status is not None:
            sender.send({"type": "ask.status", "kind": outcome.status[0], "label": outcome.status[1]})
        result: dict[str, Any] = {
            "type": "tool_result",
            "tool_use_id": getattr(block, "id", ""),
            "content": outcome.content,
        }
        if outcome.is_error:
            result["is_error"] = True
        results.append(result)
    return results


def _stream_once(
    learn: Any,
    client: Any,
    deps: WorkerDeps,
    *,
    sender: Sender,
    toolbox: Toolbox,
    check: Callable[..., None],
    skills: Any,
    system: list[dict[str, Any]],
    messages: list[Any],
    tools: list[dict[str, Any]],
    tool_choice: dict[str, Any] | None,
    timeout: float,
) -> Any:
    citations: dict[int, list[Any]] = {}
    kinds: dict[int, str] = {}
    with learn.stream_messages(
        client,
        model=deps.model_id,
        skills=skills,
        system=system,
        messages=messages,
        tools=tools,
        max_tokens=MAX_TOKENS,
        effort=deps.effort,
        tool_choice=tool_choice,
        timeout=timeout,
    ) as stream:
        for event in stream:
            etype = getattr(event, "type", "")
            if etype == "content_block_start":
                block = event.content_block
                kinds[event.index] = str(getattr(block, "type", ""))
                if kinds[event.index] == "tool_use":
                    kind, label = STATUS_FOR_TOOL.get(str(getattr(block, "name", "")), ("thinking", "Thinking…"))
                    sender.send({"type": "ask.status", "kind": kind, "label": label})
            elif etype == "content_block_delta":
                delta = event.delta
                dtype = getattr(delta, "type", "")
                if dtype == "text_delta":
                    sender.text(str(delta.text))
                elif dtype == "citations_delta":
                    citations.setdefault(event.index, []).append(delta.citation)
            elif etype == "content_block_stop" and citations.get(event.index):
                numbers = sorted({n for c in citations.pop(event.index) if (n := toolbox.source_for(c)) is not None})
                if numbers:
                    sender.text("".join(f"[{n}]" for n in numbers))
                    sender.send({"type": "ask.sources", "sources": list(toolbox.sources)})
            check(deps.monotonic())
        return stream.get_final_message()


def _drop_tool_docs(messages: list[Any]) -> bool:
    """Replaces document blocks inside the last tool results with a plain error (Bedrock refused them)."""
    if not messages or not isinstance(messages[-1], dict) or messages[-1].get("role") != "user":
        return False
    changed = False
    for result in messages[-1].get("content") or []:
        if (
            isinstance(result, dict)
            and result.get("type") == "tool_result"
            and isinstance(result.get("content"), list)
            and any(isinstance(b, dict) and b.get("type") == "document" for b in result["content"])
        ):
            result["content"] = "I can't read PDFs from the web yet"
            result["is_error"] = True
            changed = True
    return changed


def _read_files(
    deps: WorkerDeps, record: Record, sub: str, refs: list[dict[str, Any]], *, enabled: bool
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]], bool]:
    blocks: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    chars_left = askfiles.TEXT_CHARS_PER_QUESTION
    b64_left = askfiles.MODEL_BINARY_B64
    images = 0
    redacted = False
    total = 0
    for ref in refs[: askfiles.FILES_PER_QUESTION]:
        file_id = str(ref.get("fileId") or "")
        kind = ref.get("kind")
        name = str(ref.get("name") or "file")[: askfiles.NAME_MAX]
        if not enabled:
            results.append({"fileId": file_id, "read": False, "why": "off"})
            continue
        if kind not in {"image", "pdf", "text", "office"} or not askfiles.FILE_ID.match(file_id):
            results.append({"fileId": file_id, "read": False, "why": "unsupported"})
            continue
        if kind == "image" and images >= askfiles.IMAGES_PER_QUESTION:
            results.append({"fileId": file_id, "read": False, "why": "too_long"})
            continue
        try:
            data = deps.media.read(askfiles.file_key(sub, file_id), askfiles.BYTES_PER_FILE)
        except Exception as e:
            log("warning", "ask.file_read_failed", error=type(e).__name__)
            results.append({"fileId": file_id, "read": False, "why": "damaged"})
            continue
        total += len(data)
        if total > askfiles.BYTES_PER_QUESTION:
            results.append({"fileId": file_id, "read": False, "why": "too_long"})
            continue
        read = askfiles.read(name, kind, data, chars_left=chars_left, b64_left=b64_left)
        if read.block is None:
            results.append({"fileId": file_id, "read": False, "why": read.why or "damaged"})
            continue
        record.files[str(kind)] += 1
        record.file_kb += round(len(data) / 1024)
        chars_left -= read.chars
        b64_left -= read.b64
        images += kind == "image"
        redacted = redacted or read.redacted
        blocks.append(read.block)
        results.append({"fileId": file_id, "read": True})
    notes = []
    if any(not r["read"] for r in results):
        notes.append("Some files could not be read; say so briefly if it matters.")
    return blocks, notes, results, redacted


def _default_fetch(url: str) -> Page:
    from .fetch import fetch

    return fetch(url)


# --- the Lambda --------------------------------------------------------------------------------------------------

_deps: WorkerDeps | None = None


def _from_env() -> WorkerDeps:
    import boto3
    from botocore.config import Config

    from ..app import table
    from ..realtime import management_client
    from .search import BraveSearch

    env = os.environ
    region = env.get("ASK_REGION") or "eu-north-1"
    model_id = env["ASK_MODEL_ID"]
    fallback = env.get("ASK_FALLBACK_MODEL_ID", "")

    def mantle() -> Any:
        from anthropic import AnthropicBedrockMantle, BetaRefusalFallbackMiddleware

        middleware = [BetaRefusalFallbackMiddleware([{"model": fallback}])] if fallback else []
        return AnthropicBedrockMantle(aws_region=region, max_retries=1, middleware=middleware)

    short = Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=3, read_timeout=5)
    secrets = boto3.client("secretsmanager", region_name=env.get("AWS_REGION") or region, config=short)
    secret_name = env.get("ASK_SEARCH_SECRET", "")
    return WorkerDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        media=s3.Media(s3.make_client(env.get("AWS_REGION") or region), env["MEDIA_BUCKET"]),
        management=management_client(env["WS_ENDPOINT"]),
        mantle=mantle,
        model_id=model_id,
        fallback_model_id=fallback,
        effort=env.get("ASK_EFFORT") or "medium",
        eager=(env.get("ASK_EAGER_TOOLS", "true").strip().lower() != "false"),
        tool_docs=(env.get("ASK_TOOL_DOCS", "true").strip().lower() != "false"),
        key_reader=KeyReader(secrets, secret_name) if secret_name else None,
        provider=BraveSearch(),
    )


def get_deps(factory: Callable[[], WorkerDeps] = _from_env) -> WorkerDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    record = answer(get_deps(), event)
    return {"outcome": record.outcome}
