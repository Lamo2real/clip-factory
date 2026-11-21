"""/v1/help: Ask Clip Factory, the grounded in-app help assistant (docs/CONTRACTS.md §19.6).

Order of work for a question: auth (JWT, as every route) → kill switch → parse → rate limit (and the daily picture
limit) → load corpus → skills → look step for pictures (§26) → ``when`` filter → refusal check → rank → compose →
model step (if allowed) → one ``help.answer`` log line.

The help package is imported inside the handlers, so the other routes pay nothing for it at cold start. The
question, history, answer, skills and pictures (with what was read from them) are never logged or stored; the handler catches its own exceptions so no log
line ever carries text built from them.
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, NamedTuple

from ..app import App
from ..errors import ApiError
from ..http import Request, Response, ok
from ..log import LogValue, log

if TYPE_CHECKING:
    from datetime import datetime

    from ..help.corpus import Corpus
    from ..help.guard import Reserved, Switch
    from ..help.look import Look
    from ..help.model import Rewrite
    from ..help.pictures import Picture
    from ..help.retrieve import HelpContext, Ranked
    from ..skill_prompt import SkillsBlock

MAX_QUESTION = 300
MAX_TURN = 300
MAX_HISTORY = 4
MAX_SEEN = 200
# Four pictures of at most 600 KB as base64 JSON, plus the question (§26). Far below the Lambda's 6 MB.
HELP_MAX_BODY = 3_400_000
BUDGET_S = 24.0  # of the API Lambda's 29 s; the model step needs 14 s of it left (§19.5)
DEVICES = frozenset({"phone", "tablet", "desktop"})
OSES = frozenset({"mac", "windows", "linux", "chromeos", "ios", "android", "unknown"})
# Every route name in web/src/lib/router.ts (HelpContext.page is Route["name"], §19.6; tests/test_help_pages.py checks
# it). A skill page ranks like Settings (retrieve.boost_page); the mock-only pages (mock_oauth, motion_gallery,
# mock_cr_consent) never reach a real API, the client sends them as "not_found", and they are accepted here only so a
# page name can never be the reason Ask fails. The Content Rewards pages (cr_setup, campaigns, campaign) are §38.
PAGES = frozenset(
    {
        "home",
        "jobs",
        "job",
        "review",
        "library",
        "clip",
        "money",
        "settings",
        "skill",
        "mock_oauth",
        "get_app",
        "motion_gallery",
        "not_found",
        "cr_setup",
        "campaigns",
        "campaign",
        "mock_cr_consent",
    }
)

BAD_REQUEST = "Ask a question with up to 300 letters."
OFF = "Ask Clip Factory is turned off right now."
RATE_LIMITED = "Let's take a short break. Ask again in a minute."
UNAVAILABLE = "Ask Clip Factory can't answer right now."
PICTURE_UNKNOWN = "I looked at your picture, but I don't know that one yet. Tell me in words what you want to do."
PICTURE_UNREAD = "I couldn't look at your picture this time. Tell me in words what you want to do."
PICTURE_OFF = "Pictures are off right now. Tell me in words what you want to do."
PICTURE_LIMIT = "You sent lots of pictures today. Tell me in words what you want to do."
# The reply to a picture with no words that was not read, by why it was not read.
PICTURE_UNREAD_BY = {"off": PICTURE_OFF, "limit": PICTURE_LIMIT, "trouble": PICTURE_UNREAD}


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


def _look_ready(app: App) -> bool:
    return _model_ready(app) or (bool(app.help.look_model_id) and app.help.bedrock_look is not None)


# --- GET /v1/help ---------------------------------------------------------------------------------------------


def status(app: App, req: Request) -> Response:
    from ..help import guard

    now = app.clock()
    try:
        switch = guard.check_switch(app.store, now, flag_enabled=app.help.enabled)
    except guard.GuardUnavailable:
        raise _unavailable() from None
    from .ask import assistant_status

    if not switch.enabled:
        return ok(
            {
                "enabled": False,
                "mode": "off",
                "corpusVersion": "",
                "pictures": False,
                "assistant": assistant_status(app, switch),
            }
        )
    version = _corpus(app).version
    model = switch.model and _model_ready(app) and not guard.cap_full(app.store, now, cap=app.help.monthly_cap)
    pictures = bool(model and switch.pictures and _look_ready(app))
    return ok(
        {
            "enabled": True,
            "mode": "model" if model else "kb",
            "corpusVersion": version,
            "pictures": pictures,
            "assistant": assistant_status(app, switch),
        }
    )


# --- POST /v1/help/answers ------------------------------------------------------------------------------------


class Parsed(NamedTuple):
    question: str
    history: list[dict[str, str]]
    context: HelpContext | None
    pictures: list[Picture]


def _picture_bad(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def _parse(req: Request) -> Parsed:
    from ..help import pictures as pics

    try:
        body = req.json(max_bytes=HELP_MAX_BODY)
    except ApiError as e:
        if e.status == 413:
            raise _picture_bad(pics.TOO_BIG) from None
        raise _bad() from None
    if set(body) - {"question", "history", "context", "pictures"}:
        raise _bad()
    question = body.get("question")
    if not isinstance(question, str):
        raise _bad()
    question = " ".join(question.split())
    try:
        pictures = pics.parse(body.get("pictures"))
    except pics.PictureError as e:
        raise _picture_bad(e.message) from None
    if not (0 if pictures else 1) <= len(question) <= MAX_QUESTION:
        raise _bad()
    return Parsed(question, _parse_history(body.get("history")), _parse_context(body.get("context")), pictures)


def _parse_history(raw_history: Any) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    if raw_history is not None:
        if not isinstance(raw_history, list) or len(raw_history) > MAX_HISTORY:
            raise _bad()
        for turn in raw_history:
            if not isinstance(turn, dict) or not {"role", "text"} <= set(turn) <= {"role", "text", "seen"}:
                raise _bad()
            if turn["role"] not in {"user", "assistant"} or not isinstance(turn["text"], str):
                raise _bad()
            seen = turn.get("seen")
            if seen is not None and (turn["role"] != "user" or not isinstance(seen, str)):
                raise _bad()
            kept = {"role": turn["role"], "text": turn["text"][:MAX_TURN]}
            if seen:
                kept["seen"] = seen[:MAX_SEEN]
            history.append(kept)
    return history


def _parse_context(raw_context: Any) -> HelpContext | None:
    from ..help.retrieve import HelpContext

    context = None
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
    return context


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
    from ..help.compose import compose, unknown_answer

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
        question, history, context, pictures = _parse(req)
    except ApiError:
        record["outcome"] = "bad_request"
        raise
    pictures, looks = _lookable(app, switch, question, pictures, record)
    reserved = _reserve(app, req, now, pictures, record, looks=looks)

    loaded = _corpus(app)
    record["corpus"] = loaded.source
    model_on = switch.model and _model_ready(app)
    sight = _see(
        app,
        req.user_id,
        switch=switch,
        reserved=reserved,
        pictures=pictures,
        question=question,
        context=context,
        record=record,
        deadline=deadline,
    )
    block, skills_failed, seen, context = sight.block, sight.skills_failed, sight.look, sight.context
    ranked = retrieve.rank(
        loaded.docs,
        question,
        history,
        context,
        synonyms=loaded.synonyms,
        stopwords=loaded.stopwords,
        picture_words=seen.words if seen is not None and seen.read else (),
    )
    record["candidates"] = len(ranked.candidates)
    final: dict[str, Any] = dict(compose(ranked))
    if pictures and not question and ranked.status != "answer":
        final = dict(unknown_answer())
        why = sight.picture.get("why", "trouble") if sight.picture else "trouble"
        final["text"] = (
            PICTURE_UNKNOWN if seen is not None and seen.read else PICTURE_UNREAD_BY.get(why, PICTURE_UNREAD)
        )
    mode = "kb"
    outcome = {"refused": "refused", "unknown": "unknown"}.get(ranked.status, "kb")
    if ranked.status == "answer" and model_on:
        from ..help.model import MIN_SECONDS_LEFT

        if block is None and not skills_failed and deadline() >= MIN_SECONDS_LEFT:
            block, skills_failed = _skills(app, req.user_id)
        rewritten = _model_step(
            app,
            block,
            question,
            history,
            ranked,
            deadline=deadline,
            picture=(
                {"seen": seen.seen, "page": seen.page, "words": list(seen.words)}
                if seen is not None and seen.read
                else None
            ),
        )
        outcome = rewritten.outcome
        record["usageIn"] = rewritten.input_tokens
        record["usageOut"] = rewritten.output_tokens
        if rewritten.answer is not None:
            final = dict(rewritten.answer)
            mode = "model"
    record["outcome"] = outcome
    record["mode"] = mode
    body: dict[str, Any] = {"answer": final, "mode": mode, "requestId": req.request_id}
    if sight.picture is not None:
        body["picture"] = sight.picture
    return ok(body)


def _lookable(
    app: App, switch: Switch, question: str, pictures: list[Picture], record: dict[str, LogValue]
) -> tuple[list[Picture], bool]:
    """(the pictures to keep, whether they will be looked at). A question that is refused (keys, passwords, other
    people's accounts) never sends its pictures anywhere: its screenshot may show the very secret. It takes no look
    call, no cap unit and none of the day's picture questions."""
    from ..help import retrieve

    if pictures and question and retrieve.refused(question):
        record["look"] = "refused"
        return [], False
    return pictures, bool(pictures) and switch.model and switch.pictures and _look_ready(app)


def _reserve(
    app: App, req: Request, now: datetime, pictures: list[Picture], record: dict[str, LogValue], *, looks: bool
) -> Reserved:
    """The rate limit, and for a question whose pictures will be looked at the daily picture limit in the same write
    (§26). Pictures that cannot be looked at (off, model off) take none of the day's picture questions."""
    from ..help import guard
    from ..help.pictures import total_kb

    if pictures:
        record["pictures"] = len(pictures)
        record["picKB"] = total_kb(pictures)
    try:
        reserved = guard.reserve_question(
            app.store,
            req.user_id,
            now,
            per_minute=app.help.rate_per_minute,
            per_hour=app.help.rate_per_hour,
            pictures_per_day=app.help.picture_questions_per_day if looks else None,
        )
    except guard.GuardUnavailable:
        record["outcome"] = "unavailable"
        raise _unavailable() from None
    if reserved.wait is not None:
        wait = reserved.wait
        record["outcome"] = "rate_limited"
        raise ApiError(
            429, "rate_limited", RATE_LIMITED, extra={"retryAfter": wait}, headers={"Retry-After": str(wait)}
        )
    return reserved


class Sight(NamedTuple):
    block: SkillsBlock | None
    skills_failed: bool
    look: Look | None  # None unless the look call ran
    context: HelpContext | None  # with the page the pictures show, when the look read one
    picture: dict[str, Any] | None  # the response's ``picture`` (only when pictures were sent)


def _see(
    app: App,
    user_id: str,
    *,
    switch: Switch,
    reserved: Reserved,
    pictures: list[Picture],
    question: str,
    context: HelpContext | None,
    record: dict[str, LogValue],
    deadline: Callable[[], float],
) -> Sight:
    """The look step for a question with pictures (§26): off, over the daily limit, or one look call."""
    from ..help.retrieve import HelpContext

    if not pictures:
        return Sight(None, False, None, context, None)
    if not switch.model or not switch.pictures or not _look_ready(app):
        record["look"] = "off"
        return Sight(None, False, None, context, {"read": False, "why": "off"})
    if not reserved.picture:
        record["look"] = "limit"
        return Sight(None, False, None, context, {"read": False, "why": "limit"})
    block, failed = _skills(app, user_id)
    seen = _look(app, block, pictures, question, deadline=deadline) if block is not None else None
    record["look"] = seen.outcome if seen is not None else "error"
    if seen is None or not seen.read:
        return Sight(block, failed, seen, context, {"read": False, "why": "trouble"})
    if seen.page:
        context = dataclasses.replace(context, page=seen.page) if context else HelpContext(page=seen.page)
    return Sight(block, failed, seen, context, {"read": True, "seen": seen.seen})


def _skills(app: App, user_id: str) -> tuple[SkillsBlock | None, bool]:
    """The owner's skills block (§18.6), loaded once per question for both model calls. (block, failed)."""
    from ..skill_prompt import load_block

    try:
        return load_block(app.store, app.media, user_id, where="api.help", builtins=app.builtin_skills), False
    except Exception as e:
        log("warning", "help.skills_failed", error=type(e).__name__)
        return None, True


def _look(
    app: App, block: SkillsBlock, pictures: list[Picture], question: str, *, deadline: Callable[[], float]
) -> Look:
    """Deadline, then one unit of the cap, then the look call (§26). Each Converse call takes one cap unit, so a
    picture question that is also reworded uses two."""
    from ..help import guard, look

    if deadline() < look.LOOK_MIN_SECONDS_LEFT:
        return look.Look("deadline")
    if not guard.reserve_cap(app.store, app.clock(), cap=app.help.monthly_cap):
        return look.Look("cap")
    if app.help.bedrock_look is not None:
        client = app.help.bedrock_look()
    else:
        client = app.help.bedrock() if app.help.bedrock else None
    return look.look(
        client,
        app.help.look_model_id or app.help.model_id,
        [p.jpeg for p in pictures],
        question,
        sorted(PAGES),
        skills=block,
        deadline=deadline,
    )


def _model_step(
    app: App,
    block: SkillsBlock | None,
    question: str,
    history: list[dict[str, str]],
    ranked: Ranked,
    *,
    deadline: Callable[[], float],
    picture: dict[str, Any] | None = None,
) -> Rewrite:
    """Deadline, then the owner's skills block (§18.6), then the cap, then one Converse call. The model is never
    asked without the skills: when they cannot be loaded the composed answer stays (``kb_skills``)."""
    from ..help import guard, model

    now = app.clock()
    if deadline() < model.MIN_SECONDS_LEFT:
        return model.Rewrite(None, "kb_deadline")
    if block is None:
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
        picture=picture,
    )
