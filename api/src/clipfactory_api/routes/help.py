"""/v1/help: Ask Clip Factory, the grounded in-app help assistant (docs/CONTRACTS.md §19.6).

Order of work for a question: auth (JWT, as every route) → kill switch → parse → rate limit → load corpus → ``when``
filter → refusal check → rank → compose → model step (if allowed) → one ``help.answer`` log line.

The help package is imported inside the handlers, so the other routes pay nothing for it at cold start. The
question, history, answer and skills are never logged or stored; the handler catches its own exceptions so no log
line ever carries text built from them.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from ..app import App
from ..errors import ApiError
from ..http import Request, Response, ok
from ..log import LogValue, log

if TYPE_CHECKING:
    from ..help.corpus import Corpus
    from ..help.model import Rewrite
    from ..help.retrieve import HelpContext, Ranked

MAX_QUESTION = 300
MAX_TURN = 300
MAX_HISTORY = 4
BUDGET_S = 24.0  # of the API Lambda's 29 s; the model step needs 14 s of it left (§19.5)
DEVICES = frozenset({"phone", "tablet", "desktop"})
OSES = frozenset({"mac", "windows", "linux", "chromeos", "ios", "android", "unknown"})
# Every route name in web/src/lib/router.ts (HelpContext.page is Route["name"], §19.6; tests/test_help_pages.py checks
# it). A skill page ranks like Settings (retrieve.boost_page); the two mock-only pages never reach a real API, the
# client sends them as "not_found", and they are accepted here only so a page name can never be the reason Ask fails.
PAGES = frozenset(
    {
        "home",
        "jobs",
        "job",
        "review",
        "library",
        "clip",
        "settings",
        "skill",
        "mock_oauth",
        "get_app",
        "motion_gallery",
        "not_found",
    }
)

BAD_REQUEST = "Ask a question with up to 300 letters."
OFF = "Ask Clip Factory is turned off right now."
RATE_LIMITED = "Let's take a short break. Ask again in a minute."
UNAVAILABLE = "Ask Clip Factory can't answer right now."


def _bad() -> ApiError:
    return ApiError(400, "bad_request", BAD_REQUEST)


def _off() -> ApiError:
    return ApiError(403, "help_off", OFF)


def _unavailable() -> ApiError:
    return ApiError(503, "unavailable", UNAVAILABLE)


def _corpus(app: App) -> Corpus:
    from ..help import corpus

    return corpus.load(app.help.fetcher, app.help.app_url, app.clock(), bundled_file=app.help.corpus_file)


def _model_ready(app: App) -> bool:
    return bool(app.help.model_id) and app.help.bedrock is not None


# --- GET /v1/help ---------------------------------------------------------------------------------------------


def status(app: App, req: Request) -> Response:
    from ..help import guard

    now = app.clock()
    try:
        switch = guard.check_switch(app.store, now, flag_enabled=app.help.enabled)
    except guard.GuardUnavailable:
        raise _unavailable() from None
    if not switch.enabled:
        return ok({"enabled": False, "mode": "off", "corpusVersion": ""})
    version = _corpus(app).version
    model = switch.model and _model_ready(app) and not guard.cap_full(app.store, now, cap=app.help.monthly_cap)
    return ok({"enabled": True, "mode": "model" if model else "kb", "corpusVersion": version})


# --- POST /v1/help/answers ------------------------------------------------------------------------------------


def _parse(req: Request) -> tuple[str, list[dict[str, str]], HelpContext | None]:
    from ..help.retrieve import HelpContext

    try:
        body = req.json()
    except ApiError:
        raise _bad() from None
    if set(body) - {"question", "history", "context"}:
        raise _bad()
    question = body.get("question")
    if not isinstance(question, str):
        raise _bad()
    question = " ".join(question.split())
    if not 1 <= len(question) <= MAX_QUESTION:
        raise _bad()
    history: list[dict[str, str]] = []
    raw_history = body.get("history")
    if raw_history is not None:
        if not isinstance(raw_history, list) or len(raw_history) > MAX_HISTORY:
            raise _bad()
        for turn in raw_history:
            if not isinstance(turn, dict) or set(turn) != {"role", "text"}:
                raise _bad()
            if turn["role"] not in {"user", "assistant"} or not isinstance(turn["text"], str):
                raise _bad()
            history.append({"role": turn["role"], "text": turn["text"][:MAX_TURN]})
    context = None
    raw_context = body.get("context")
    if raw_context is not None:
        if not isinstance(raw_context, dict) or set(raw_context) - {"device", "os", "installed", "page"}:
            raise _bad()
        device, os_name = raw_context.get("device"), raw_context.get("os")
        installed, page = raw_context.get("installed"), raw_context.get("page")
        if device is not None and device not in DEVICES:
            raise _bad()
        if os_name is not None and os_name not in OSES:
            raise _bad()
        if installed is not None and not isinstance(installed, bool):
            raise _bad()
        if page is not None and page not in PAGES:
            raise _bad()
        context = HelpContext(device=device, os=os_name, installed=installed, page=page)
    return question, history, context


def answer(app: App, req: Request) -> Response:
    started = time.monotonic()
    record: dict[str, LogValue] = {"outcome": "error", "mode": "kb", "candidates": 0}
    try:
        return _answer(app, req, record, lambda: BUDGET_S - (time.monotonic() - started))
    except ApiError:
        raise
    except Exception as e:
        record["outcome"] = "error"
        record["error"] = type(e).__name__
        raise _unavailable() from None
    finally:
        log(
            "info",
            "help.answer",
            requestId=req.request_id,
            ms=round((time.monotonic() - started) * 1000),
            **record,
        )


def _answer(app: App, req: Request, record: dict[str, LogValue], deadline: Callable[[], float]) -> Response:
    from ..help import guard, retrieve
    from ..help.compose import compose

    now = app.clock()
    try:
        switch = guard.check_switch(app.store, now, flag_enabled=app.help.enabled)
    except guard.GuardUnavailable:
        record["outcome"] = "unavailable"
        raise _unavailable() from None
    if not switch.enabled:
        record["outcome"] = "off"
        raise _off()
    try:
        question, history, context = _parse(req)
    except ApiError:
        record["outcome"] = "bad_request"
        raise
    try:
        wait = guard.reserve_rate(
            app.store, req.user_id, now, per_minute=app.help.rate_per_minute, per_hour=app.help.rate_per_hour
        )
    except guard.GuardUnavailable:
        record["outcome"] = "unavailable"
        raise _unavailable() from None
    if wait is not None:
        record["outcome"] = "rate_limited"
        raise ApiError(
            429, "rate_limited", RATE_LIMITED, extra={"retryAfter": wait}, headers={"Retry-After": str(wait)}
        )

    loaded = _corpus(app)
    record["corpus"] = loaded.source
    ranked = retrieve.rank(
        loaded.docs, question, history, context, synonyms=loaded.synonyms, stopwords=loaded.stopwords
    )
    record["candidates"] = len(ranked.candidates)
    final: dict[str, Any] = dict(compose(ranked))
    mode = "kb"
    outcome = {"refused": "refused", "unknown": "unknown"}.get(ranked.status, "kb")
    if ranked.status == "answer" and switch.model and _model_ready(app):
        rewritten = _model_step(app, req.user_id, question, history, ranked, deadline=deadline)
        outcome = rewritten.outcome
        record["usageIn"] = rewritten.input_tokens
        record["usageOut"] = rewritten.output_tokens
        if rewritten.answer is not None:
            final = dict(rewritten.answer)
            mode = "model"
    record["outcome"] = outcome
    record["mode"] = mode
    return ok({"answer": final, "mode": mode, "requestId": req.request_id})


def _model_step(
    app: App,
    user_id: str,
    question: str,
    history: list[dict[str, str]],
    ranked: Ranked,
    *,
    deadline: Callable[[], float],
) -> Rewrite:
    """Deadline, then the owner's skills block (§18.6), then the cap, then one Converse call. The model is never
    asked without the skills: when they cannot be loaded the composed answer stays (``kb_skills``)."""
    from ..help import guard, model
    from ..skill_prompt import load_block

    now = app.clock()
    if deadline() < model.MIN_SECONDS_LEFT:
        return model.Rewrite(None, "kb_deadline")
    try:
        block = load_block(app.store, app.media, user_id, where="api.help", builtins=app.builtin_skills)
    except Exception as e:
        log("warning", "help.skills_failed", error=type(e).__name__)
        return model.Rewrite(None, "kb_skills")
    if not guard.reserve_cap(app.store, now, cap=app.help.monthly_cap):
        return model.Rewrite(None, "kb_cap")
    bedrock = app.help.bedrock() if app.help.bedrock else None
    top = ranked.top
    return model.rewrite(
        bedrock,
        app.help.model_id,
        question,
        history,
        ranked.candidates,
        live=top.get("live") if top else None,
        skills=block,
        deadline=deadline,
    )
