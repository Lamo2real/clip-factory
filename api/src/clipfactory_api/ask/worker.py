"""``cf-prod-ask``: answers one Ask question and streams it over the WebSocket (docs/CONTRACTS.md §28.5).

Started by ``POST /v1/help/asks`` with an async Invoke (retries 0, so an answer never runs twice). Order of work:
``ask.started`` → the owner's skills (no skills, no model call) → the knowledge pack → the web key state → the files
(read, checked, turned into content blocks) → APP STATE → up to 8 streamed model iterations with read-only tools →
``ask.done``. Text deltas are batched (≥ 80 ms or 400 characters) and pass a 64-character secrets hold-back first. The
answer stops on the owner's Stop (checked at most every 1.5 s, and before every round of tools), on a closed socket
(``GoneException`` ends the model stream at once), or at the hard budget. A status heartbeat goes out when nothing
else was sent for 10 s, so the panel knows the answer is still alive. The question's files are deleted as soon as
they are read into memory, and again in ``finally`` whatever happened.

One ``help.ask`` log line per question with ids, counts, timings, token usage and the outcome; never the question,
history, answer, file names or contents, URLs, search queries or the search key.
"""

from __future__ import annotations

import contextlib
import os
import re
import struct
import threading
import time
import zlib
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor, wait
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
from .tools import Toolbox, guide_urls, typed_urls

SOFT_S = 95.0
HARD_S = 110.0
MAX_ITERATIONS = 8
MAX_TOKENS = 64_000  # per iteration (streaming); thinking counts too
OUTPUT_BUDGET = 64_000  # per answer: past 80 % the next round is the last one, with no tools
FINAL_ROUND_AT = 0.8
MIN_ROUND_TOKENS = 4_000
HEARTBEAT_S = 10.0
TOOL_WORKERS = 6
INPUT_BUDGET = 400_000
STOP_CHECK_S = 1.5
DELTA_MS = 80
DELTA_CHARS = 400
STOP_SK = "ASK#STOP#"
REFUSED_TEXT = "I can't help with that one."
BUDGET_TEXT = "\n\nI ran out of time. Ask me to go on."
LENGTH_TEXT = "\n\nThat was a long answer, so I stopped there. Ask me to go on."
CUT_TEXT = "\n\nThe answer was cut short. Ask me to go on."
REDACTED_NOTE = "\n\nI hid things that looked like keys."
STATUS_FOR_TOOL = {
    "web_search": ("searching", "Searching the web…"),
    "web_fetch": ("reading", "Reading a page…"),
    "read_app_doc": ("checking_app", "Reading the Clip Factory guide…"),
    "read_my_clip_factory": ("checking_app", "Checking your setup…"),
    "read_setup_guide": ("checking_app", "Reading the setup guide…"),
}
# Model errors before any words that the fallback model may fix (access not enabled for one model, a throttle, a
# server error, a timeout): the answer is tried once more on ASK_FALLBACK_MODEL_ID. Refusals have their own middleware.
RETRY_STATUSES = frozenset({403, 404, 408, 409, 429, 500, 502, 503, 504, 529})
# What the owner reads when the model could not answer (the panel shows it with Try again, never a canned answer).
MODEL_MESSAGES = {
    "access": (
        "Ask's AI model is not switched on yet. In Amazon Bedrock (Stockholm), open Model catalog, pick Claude "
        "Opus 5.5, fill in the form if it asks, and send it one message. Then try again."
    ),
    "busy": "Ask is very busy right now. Try again in a minute.",
    "timeout": "That took too long. Try again.",
    "other": "I couldn't think it through this time. Try again.",
}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# A setup question: a platform name together with a setup word, or plainly stuck. Plain chat stays at ASK_EFFORT.
SETUP_PLATFORM_WORDS = re.compile(r"\b(instagram|facebook|meta|tiktok|youtube|twitter|x\.com)\b", re.IGNORECASE)
SETUP_VERBS = re.compile(
    r"\b(set ?up|setup|connect\w*|link\w*|stuck|token|redirect|permission\w*|portfolio|developer|app review|"
    r"what do i do|what now)\b",
    re.IGNORECASE,
)
SMOKE_QUESTION = "What one color fills this whole picture? Answer with just the color."


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
    fetcher: Callable[..., Page] | None = None  # (url, allow=None): allow checks every redirect hop
    knowledge: Callable[[], Knowledge] | None = None
    builtins: Callable[[], Any] | None = None
    route_ok: Callable[[str], bool] | None = None  # None: the knowledge pack's routes (router.ts)
    clock: Clock = utcnow
    monotonic: Callable[[], float] = time.monotonic
    soft_s: float = SOFT_S
    hard_s: float = HARD_S
    heartbeat_s: float = HEARTBEAT_S


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
    gone: bool = False
    last_sent: float = field(default_factory=time.monotonic)
    _buffer: str = ""
    _last_flush: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def send(self, event: dict[str, Any]) -> None:
        if self.gone:
            raise AskGone
        message = {**event, "askId": self.ask_id}
        with self._lock:
            try:
                self.management.post_to_connection(ConnectionId=self.connection_id, Data=encode(message))
                self.last_sent = time.monotonic()
            except Exception as e:
                if is_gone(e):
                    self.gone = True
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


class Heartbeat:
    """Sends a status event when nothing else went out for ``every`` seconds (a long think, a big PDF, slow tools),
    so the panel's 45 s silence timer never fires on an answer that is still alive."""

    def __init__(self, sender: Sender, every: float) -> None:
        self._sender = sender
        self._every = every
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="ask-heartbeat", daemon=True)

    def __enter__(self) -> Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=1)

    def _run(self) -> None:
        tick = min(1.0, self._every / 4)
        while not self._stop.wait(tick):
            if time.monotonic() - self._sender.last_sent < self._every:
                continue
            try:
                self._sender.send({"type": "ask.status", "kind": "thinking", "label": "Still working…"})
            except AskGone:
                return  # the main loop sees ``sender.gone`` at its next check


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
    model_error: str = ""  # access, busy, timeout or other: why the model gave no answer (logged, never the text)
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
        sources = [
            f"[{i}] {str(src.get('title') or '')[:200]} {src['url']}"
            for i, src in enumerate(turn.get("sources") or [], 1)
            if turn["role"] == "assistant" and isinstance(src, dict) and isinstance(src.get("url"), str)
        ]
        if sources:
            text += "\n\nSources of that answer:\n" + "\n".join(sources)
        if not text.strip():
            continue
        if not out and turn["role"] == "assistant":
            continue
        out.append({"role": turn["role"], "content": [{"type": "text", "text": text}]})
    return out


def _model_label(model: str) -> str:
    return "opus-4-8" if "opus-4-8" in model else "opus-5-5"


def history_urls(history: list[Any]) -> list[str]:
    """Source URLs of earlier answers (sent back by the panel), so "open that page you found" can be fetched."""
    out = []
    for turn in history:
        if isinstance(turn, dict) and turn.get("role") == "assistant":
            for src in turn.get("sources") or []:
                if isinstance(src, dict) and isinstance(src.get("url"), str):
                    out.append(src["url"])
    return out


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
        with Heartbeat(sender, deps.heartbeat_s):
            knowledge_version = _run(
                deps,
                sender,
                record,
                tools_used,
                sub=sub,
                ask_id=ask_id,
                body=body,
                flags=flags,
                refs=refs,
                keys=keys,
                started=started,
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
        _delete(deps, keys)  # again: every exit path (end, stop, gone, error), whatever was deleted before
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
            "toolsGuide": tools_used.get("read_setup_guide", 0),
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
            "modelError": record.model_error or None,
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
    keys: list[str],
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
    sender.holdback.secret(key)  # his stored search key is never shown, whatever the model writes
    files_on = flags.get("files", True) is not False
    file_blocks: list[dict[str, Any]] = []
    file_notes: list[str] = []
    redacted = False
    if refs:
        sender.send({"type": "ask.status", "kind": "reading_files", "label": "Reading your files…"})
        file_blocks, file_notes, results, redacted = _read_files(deps, record, sub, refs, enabled=files_on)
        _delete(deps, keys)  # the bytes are in memory now: nothing waits in S3 while the model thinks
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
    reader = Reader(deps.store, deps.media, sub, deps.clock(), steps=knowledge.setup_steps)
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
            fetcher=deps.fetcher or _budget_fetch(lambda: deps.hard_s - (deps.monotonic() - started)),
            allowed_urls=typed_urls([*user_texts, " ".join(history_urls(history))]),
            # Pages the setup guides open may be read with no search (§28.3); official doc hosts are allowed too.
            doc_urls=guide_urls(knowledge),
            web_off=record.web == "off",
            on_actions=lambda actions: sender.send({"type": "ask.actions", "actions": actions}),
            route_ok=deps.route_ok or knowledge.route_ok,
            soft_deadline=lambda: deps.monotonic() - started >= deps.soft_s,
            tool_docs=deps.tool_docs,
        ),
    )
    for name in (str(r.get("name") or "") for r in refs):
        loop.toolbox.titles[name[: askfiles.NAME_MAX]] = "file"
    loop.effort = answer_effort(deps.effort, pictures=record.files["image"] > 0, question=question)
    stop = loop.run(skills, knowledge)
    if stop is not None:  # None: the model failed and the loop already told the owner
        _finish(sender, record, loop.toolbox, stop, redacted=redacted)
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
    effort: str = ""
    model: str = ""
    _last_check: float = 0.0

    def elapsed(self) -> float:
        return self.deps.monotonic() - self.started

    def check(self, now_s: float, *, force: bool = False) -> None:
        """A closed socket, the hard budget, then the owner's Stop item (read at most every 1.5 s)."""
        if self.sender.gone:
            raise AskGone
        if now_s - self.started >= self.deps.hard_s:
            raise _Abort("budget")
        if force or now_s - self._last_check >= STOP_CHECK_S:
            self._last_check = now_s
            if self.deps.store.get(db.user_pk(self.sub), stop_sk(self.ask_id)):
                raise _Abort("stopped")

    def run(self, skills: Any, knowledge: Knowledge) -> str | None:
        """The stop reason ("end", "budget", "length", "stopped", "refused"), or None when the model failed."""
        from .. import learn

        deps, record = self.deps, self.record
        tool_list = prompt.tools(web_search=record.web == "on", eager=deps.eager)
        system = prompt.system_blocks(knowledge, deps.model_id)
        client = deps.mantle()
        docs_retry = False
        self.model = self.model or deps.model_id
        self.effort = self.effort or deps.effort
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
                        or record.usage_out >= OUTPUT_BUDGET * FINAL_ROUND_AT
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
                            model=self.model,
                            effort=self.effort,
                            max_tokens=max(MIN_ROUND_TOKENS, min(MAX_TOKENS, OUTPUT_BUDGET - record.usage_out)),
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
                        if self._switch_model(e):
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
                    if reason == "max_tokens":
                        return "length"  # cut at the output limit: say so, never run a half-written tool call
                    uses = [b for b in content if getattr(b, "type", "") == "tool_use"]
                    if not uses or reason != "tool_use":
                        return "end"
                    if final_round:  # tools were off this round; a tool call here can't be answered
                        return "budget" if self.elapsed() >= deps.soft_s else "length"
                    self.check(deps.monotonic(), force=True)  # Stop and the hard budget before the tools run
                    self.messages.append({"role": "assistant", "content": content})
                    self.messages.append(
                        {
                            "role": "user",
                            "content": _run_tools(
                                uses,
                                self.toolbox,
                                self.sender,
                                self.tools_used,
                                time_left=lambda: deps.hard_s - self.elapsed(),
                            ),
                        }
                    )
        except _Abort as a:
            return a.stop

    def _switch_model(self, e: Exception) -> bool:
        """Once per answer, before any words: an error the fallback model may not have (no access to one model, a
        throttle, a 5xx, a timeout) moves this answer to ASK_FALLBACK_MODEL_ID. Logged with the reason."""
        fallback = self.deps.fallback_model_id
        if not fallback or self.model == fallback or self.sender.sent_text or not retryable(e):
            return False
        log("warning", "ask.model_switched", reason=model_error_reason(e), status=getattr(e, "status_code", None))
        self.model = fallback
        return True


def retryable(e: Exception) -> bool:
    status = getattr(e, "status_code", None)
    if isinstance(status, int):
        return status in RETRY_STATUSES
    name = type(e).__name__
    return "Timeout" in name or "Connection" in name


def model_error_reason(e: Exception) -> str:
    """access, busy, timeout or other (the log field and the owner's message)."""
    status = getattr(e, "status_code", None)
    name = type(e).__name__
    if status in {401, 403, 404} or "PermissionDenied" in name or "NotFound" in name or "AccessDenied" in str(e)[:300]:
        return "access"
    if status in {429, 529} or "RateLimit" in name or "Overloaded" in name:
        return "busy"
    if status == 408 or "Timeout" in name:
        return "timeout"
    return "other"


def answer_effort(base: str, *, pictures: bool, question: str) -> str:
    """At least ``high`` for a picture or a setup question (finding where he is stuck needs the deeper look);
    the deployed effort (ASK_EFFORT, medium) for plain chat."""
    base = base if base in EFFORTS else "medium"
    q = question or ""
    if pictures or (SETUP_PLATFORM_WORDS.search(q) and SETUP_VERBS.search(q)) or re.search(r"\bstuck\b", q, re.I):
        return base if EFFORTS.index(base) >= EFFORTS.index("high") else "high"
    return base


def _finish(sender: Sender, record: Record, toolbox: Toolbox, stop: str, *, redacted: bool) -> None:
    """The closing words for the stop reason, the hidden-keys note, and ``ask.done``."""
    if stop == "refused" and not sender.sent_text:
        sender.text(REFUSED_TEXT)
    if stop == "budget":
        sender.text(BUDGET_TEXT)
    if stop == "length":
        sender.text(LENGTH_TEXT)
        stop = "budget"
    sender.finish_text()
    if redacted or sender.holdback.hit:
        sender.text(REDACTED_NOTE)
        sender.finish_text()
    done: dict[str, Any] = {"type": "ask.done", "stop": stop, "links": sorted(toolbox.links)}
    if record.web == "no_key":
        done["webMissing"] = True
    sender.send(done)
    record.stop = stop
    record.outcome = {"end": "ask_ok", "budget": "ask_budget", "stopped": "ask_stopped", "refused": "ask_refused"}[stop]


def _web_key(deps: WorkerDeps, record: Record, flags: Mapping[str, Any]) -> str | None:
    """The search key, and ``record.web``: on (a key), no_key, or off (the kill switch's ``web`` flag)."""
    if flags.get("web", True) is False:
        record.web = "off"
        return None
    try:
        key = deps.key_reader.get() if deps.key_reader is not None else None
    except SearchError:
        record.web = "error"  # a key may be saved but could not be read: never tell him to set it up again
        return None
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
    reason = model_error_reason(e)
    record.model_error = reason
    log("warning", "ask.model_failed", error=type(e).__name__, status=getattr(e, "status_code", None), reason=reason)
    if sender.sent_text:
        sender.text(CUT_TEXT)
        sender.finish_text()
        sender.send({"type": "ask.done", "stop": "error", "links": sorted(toolbox.links)})
    else:
        sender.send({"type": "ask.error", "code": "model", "reason": reason, "message": MODEL_MESSAGES[reason]})


def _count_usage(record: Record, final: Any, model_id: str) -> None:
    usage = final.usage
    record.usage_in += int(getattr(usage, "input_tokens", 0) or 0)
    record.usage_out += int(getattr(usage, "output_tokens", 0) or 0)
    record.cache_read += int(getattr(usage, "cache_read_input_tokens", 0) or 0)
    record.cache_write += int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
    record.model = _model_label(str(getattr(final, "model", "") or model_id))


def _run_tools(
    uses: list[Any],
    toolbox: Toolbox,
    sender: Sender,
    tools_used: dict[str, int],
    *,
    time_left: Callable[[], float] = lambda: HARD_S,
) -> list[dict[str, Any]]:
    """Every tool_use of one turn answered in one user message. The calls run at the same time (each with its own
    deadline inside the answer's budget); ``show_app_buttons`` runs on this thread, in order, as it sends events.
    A call still running when the budget ends is answered "took too long"."""
    from .tools import Outcome

    outcomes: dict[int, Outcome] = {}
    parallel: dict[int, Any] = {}
    pool = ThreadPoolExecutor(max_workers=TOOL_WORKERS, thread_name_prefix="ask-tool")
    try:
        for i, block in enumerate(uses):
            name = str(getattr(block, "name", ""))
            tools_used[name] = tools_used.get(name, 0) + 1
            if name == "show_app_buttons":
                outcomes[i] = toolbox.run(name, getattr(block, "input", None))
            else:
                parallel[i] = pool.submit(toolbox.run, name, getattr(block, "input", None))
        wait(parallel.values(), timeout=max(0.0, time_left()))
        for i, future in parallel.items():
            if future.done():
                outcomes[i] = future.result()  # Toolbox.run never raises
            else:
                outcomes[i] = Outcome("that took too long, answer with what you have", True)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    results = []
    for i, block in enumerate(uses):
        outcome = outcomes[i]
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
    max_tokens: int = MAX_TOKENS,
    model: str = "",
    effort: str = "",
) -> Any:
    citations: dict[int, list[Any]] = {}
    kinds: dict[int, str] = {}
    with learn.stream_messages(
        client,
        model=model or deps.model_id,
        skills=skills,
        system=system,
        messages=messages,
        tools=tools,
        max_tokens=max_tokens,
        effort=effort or deps.effort,
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


def _budget_fetch(time_left: Callable[[], float]) -> Callable[[str], Page]:
    """``web_fetch`` with one deadline that never runs past the answer's hard budget."""

    def run(url: str, allow: Callable[[str], bool] | None = None) -> Page:
        from .fetch import FetchError, fetch

        left = time_left() - 2.0  # keep time to finish the answer
        if left <= 0.5:
            raise FetchError("time is up, answer with what you have")
        return fetch(url, budget=left, allow=allow)

    return run


def _delete(deps: WorkerDeps, keys: list[str]) -> None:
    for key in keys:
        try:
            deps.media.delete(key)
        except Exception as e:
            log("warning", "ask.file_delete_failed", error=type(e).__name__)


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


# --- the post-deploy smoke check ------------------------------------------------------------------------------


def smoke_png(rgb: tuple[int, int, int] = (220, 20, 20), size: int = 16) -> bytes:
    """A tiny solid-colour PNG, made here so the smoke check needs no file and no upload."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    row = b"\x00" + bytes(rgb) * size
    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(row * size)) + chunk(b"IEND", b"")
    )


def smoke(deps: WorkerDeps) -> dict[str, Any]:
    """deploy.yml's Ask check: the deployed model looks at a tiny red picture and must say "red". It proves Bedrock
    model access, the IAM grant and that pictures reach the model as image blocks. No socket, no owner data, no
    files; one ``ask.smoke`` log line. The fallback model is not tried: a deploy where only it works must fail."""
    import base64

    started = deps.monotonic()
    image = base64.b64encode(smoke_png()).decode()
    out: dict[str, Any] = {"outcome": "smoke_failed", "model": _model_label(deps.model_id)}
    try:
        from .. import learn
        from ..skill_prompt import load_block
        from ..skills import load_builtins

        skills = load_block(
            deps.store, deps.media, "ask-smoke", where="api.ask.smoke", builtins=deps.builtins or load_builtins
        )
        with learn.stream_messages(
            deps.mantle(),
            model=deps.model_id,
            skills=skills,
            system=[],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image}},
                        {"type": "text", "text": SMOKE_QUESTION},
                    ],
                }
            ],
            max_tokens=4_000,
            effort="low",
            timeout=60.0,
        ) as stream:
            final = stream.get_final_message()
        text = " ".join(
            str(getattr(b, "text", "")) for b in getattr(final, "content", []) if getattr(b, "type", "") == "text"
        )
        out["stop"] = str(getattr(final, "stop_reason", "") or "")
        out["answer"] = text.strip()[:40]
        out["model"] = _model_label(str(getattr(final, "model", "") or deps.model_id))
        if re.search(r"\bred\b", text, re.IGNORECASE) and len(text.strip()) <= 20:
            out["outcome"] = "smoke_ok"
        else:
            out["reason"] = "the model did not see the picture"
    except Exception as e:
        out["reason"] = model_error_reason(e)
        if getattr(e, "status_code", None) == 404 or "NotFound" in type(e).__name__:
            out["reason"] = "not_found"  # a wrong model id or inference profile, not a missing access step
        out["error"] = type(e).__name__
        out["status"] = getattr(e, "status_code", None)
    log(
        "info" if out["outcome"] == "smoke_ok" else "error",
        "ask.smoke",
        outcome=str(out["outcome"]),
        reason=str(out.get("reason") or ""),
        ms=round((deps.monotonic() - started) * 1000),
    )
    return out


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    if isinstance(event, dict) and event.get("smoke") == "ask":
        return smoke(get_deps())
    record = answer(get_deps(), event)
    return {"outcome": record.outcome}
