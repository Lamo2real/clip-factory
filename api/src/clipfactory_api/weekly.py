"""Lambda ``cf-prod-learn``: learn from the owner's "Best this week" picks (docs/CONTRACTS.md §16.6).

Input ``{"userId", "week", "revision"}`` from ``PUT /v1/weeks/{week}/best``. Every write is tied to that revision,
so when the owner changes the picks again while this runs, the older run stops and writes nothing.

1. A newer save exists → ``superseded``.
2. The picked clips' vectors get ``best = true``, the unpicked ones ``best = false`` (so "What worked before" puts
   the owner's picks first). Vector errors are logged, never fatal.
3. No picks → the week's learning is deleted, ``learnState "skipped"``.
4. Claude Fable 5.1 compares the picks with the rest of the week and answers with one short learning, saved as the
   week's ``Learning`` (``kind: "week"``, its id reused on a re-save). Any stop reason other than a finished answer
   (``max_tokens``, ``refusal``, ``content_filtered``, empty) writes no learning and marks the week ``failed``.
   The owner's skills block goes first in that call's system prompt (§18.6); when the skills cannot be read the
   week is marked ``failed`` instead of asking without them.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from . import db, learn, s3, skill_prompt, weeks
from .clock import Clock, iso, parse, utcnow
from .ids import ulid
from .log import log
from .skills import BuiltinSkill, load_builtins
from .vectors import Vectors

BEDROCK_DELAYS = (2.0, 8.0)  # two retries
Item = dict[str, Any]


@dataclass
class WeeklyDeps:
    store: db.Store
    bedrock: Any
    model_id: str
    vectors: Vectors | None
    media: s3.Media  # the owner's skills (§18.6)
    clock: Clock = field(default=utcnow)
    sleep: Callable[[float], None] = field(default=time.sleep)
    builtins: Callable[[], Sequence[BuiltinSkill]] = field(default=load_builtins)


def _done(week: str, outcome: str) -> dict[str, str]:
    log("info", "weekly.done", week=week, outcome=outcome)
    return {"week": week, "outcome": outcome}


def learn_week(deps: WeeklyDeps, user_id: str, week: str, revision: int) -> dict[str, str]:
    pk = db.user_pk(user_id)
    item = deps.store.get(pk, db.week_sk(week))
    if item is None or int(item.get("revision") or 0) != revision:
        return _done(week, "superseded")
    picks = [str(c) for c in item.get("clipIds") or []]
    unpicked = [str(c) for c in item.get("unpickedClipIds") or [] if c not in picks]
    _mark_vectors(deps, user_id, picks, unpicked)
    if not picks:
        return _skip(deps, user_id, week, revision, item)
    start, end = parse(item.get("from")), parse(item.get("to"))
    if start is None or end is None:
        return _fail(deps, user_id, week, revision)
    entries = weeks.week_entries(deps.store, user_id, start, end)
    rows = learn.week_rows([(clip, clip_posts, str(clip["clipId"]) in picks) for clip, clip_posts, _ in entries])
    try:
        block = skill_prompt.load_block(
            deps.store, deps.media, user_id, where="api.week", builtins=deps.builtins, sleep=deps.sleep
        )
    except Exception as e:  # never ask without the owner's skills
        log("error", "weekly.skills_failed", week=week, error=type(e).__name__)
        return _fail(deps, user_id, week, revision)
    stop_reason, text = _ask(deps, rows, block)
    if stop_reason != "end_turn" or not text:
        log("warning", "weekly.model_stopped", week=week, stopReason=stop_reason or "error")
        _fail(deps, user_id, week, revision)
        return _done(week, "failed" if stop_reason in {"", "end_turn", "error"} else stop_reason)
    current = deps.store.get(pk, db.week_sk(week))
    if current is None or int(current.get("revision") or 0) != revision:
        return _done(week, "superseded")
    learning_id = str(current.get("learningId") or ulid())
    now = iso(deps.clock())
    picked_posts = [
        pid
        for clip, clip_posts, _ in entries
        if str(clip["clipId"]) in picks
        for pid in weeks.posted_post_ids(clip_posts)
    ]
    deps.store.put(
        {
            "pk": pk,
            "sk": db.learning_sk(learning_id),
            "type": "learning",
            "userId": user_id,
            "learningId": learning_id,
            "kind": "week",
            "week": week,
            "title": f"Best of week {week}",
            "text": text,
            "clipIds": picks,
            "postIds": picked_posts,
            "createdAt": now,
        }
    )
    try:
        deps.store.update(
            pk,
            db.week_sk(week),
            {"learnState": "done", "learningId": learning_id, "learnedAt": now},
            expect_in={"revision": [revision]},
        )
    except db.ConditionFailed:
        return _done(week, "superseded")  # a newer save will rewrite this learning (same id)
    return _done(week, "learning")


def _ask(deps: WeeklyDeps, rows: list[Item], block: skill_prompt.SkillsBlock) -> tuple[str, str]:
    for attempt in range(len(BEDROCK_DELAYS) + 1):
        try:
            return learn.ask_week(deps.bedrock, deps.model_id, rows, skills=block)
        except Exception as e:
            log("warning", "weekly.bedrock_failed", attempt=attempt + 1, error=type(e).__name__)
            if attempt < len(BEDROCK_DELAYS):
                deps.sleep(BEDROCK_DELAYS[attempt])
    return "", ""


def _mark_vectors(deps: WeeklyDeps, user_id: str, picks: list[str], unpicked: list[str]) -> None:
    if deps.vectors is None or not deps.vectors.configured or not (picks or unpicked):
        return
    pk = db.user_pk(user_id)
    found = {c.get("clipId"): c for c in deps.store.batch_get((pk, db.clip_sk(c)) for c in [*picks, *unpicked])}
    for clip_id, best in [*((c, True) for c in picks), *((c, False) for c in unpicked)]:
        clip = found.get(clip_id)
        if clip is None or clip.get("userId") != user_id:
            continue
        try:
            deps.vectors.set_best(clip, best)
        except Exception as e:  # advice for later jobs; never fails the learning
            log("error", "weekly.vector_failed", clipId=clip_id, error=type(e).__name__)


def _skip(deps: WeeklyDeps, user_id: str, week: str, revision: int, item: Item) -> dict[str, str]:
    pk = db.user_pk(user_id)
    try:
        deps.store.update(
            pk,
            db.week_sk(week),
            {"learnState": "skipped"},
            remove=["learningId", "learnedAt"],
            expect_in={"revision": [revision]},
        )
    except db.ConditionFailed:
        return _done(week, "superseded")
    if item.get("learningId"):
        deps.store.delete(pk, db.learning_sk(str(item["learningId"])))
    return _done(week, "skipped")


def _fail(deps: WeeklyDeps, user_id: str, week: str, revision: int) -> dict[str, str]:
    try:
        deps.store.update(
            db.user_pk(user_id), db.week_sk(week), {"learnState": "failed"}, expect_in={"revision": [revision]}
        )
    except db.ConditionFailed:
        return _done(week, "superseded")
    return _done(week, "failed")


def handle(event: Any, deps: WeeklyDeps) -> dict[str, str]:
    if not isinstance(event, dict):
        log("error", "weekly.bad_event")
        return {"week": "", "outcome": "bad_event"}
    user_id, week, revision = event.get("userId"), event.get("week"), event.get("revision")
    if (
        not (isinstance(user_id, str) and user_id and isinstance(week, str))
        or weeks.iso_monday(week) is None
        or isinstance(revision, bool)
        or not isinstance(revision, int)
    ):
        log("error", "weekly.bad_event")
        return {"week": str(week or ""), "outcome": "bad_event"}
    return learn_week(deps, user_id, week, revision)


_deps: WeeklyDeps | None = None


def _from_env() -> WeeklyDeps:
    import boto3
    from botocore.config import Config

    from . import vectors
    from .app import region, table

    env = os.environ
    reg = region()
    bedrock = boto3.client(
        "bedrock-runtime",
        region_name=reg,
        config=Config(read_timeout=120, retries={"mode": "adaptive", "max_attempts": 3}),
    )
    vector_store = None
    if env.get("VECTOR_BUCKET") and env.get("VECTOR_INDEX"):
        s3v, _ = vectors.make_clients(reg)
        vector_store = Vectors(
            s3v,
            bedrock,
            env["VECTOR_BUCKET"],
            env["VECTOR_INDEX"],
            env.get("EMBED_MODEL_ID", vectors.DEFAULT_EMBED_MODEL),
        )
    return WeeklyDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        bedrock=bedrock,
        model_id=env["MODEL_ID"],
        vectors=vector_store,
        media=s3.Media(s3.make_client(reg), env["MEDIA_BUCKET"]),
    )


def get_deps(factory: Callable[[], WeeklyDeps] = _from_env) -> WeeklyDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, str]:
    return handle(event, get_deps())
