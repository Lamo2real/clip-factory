"""``cf-prod-clip-flow``: publish a kept clip, wait 48 hours, learn from it (docs/CONTRACTS.md §14.5).

Started by Confirm (``clip-{clipId}-{flowRun}`` on the alias ``live``) with ``{"clipId", "userId", "run"}``:

1. ``ensure-posts``: the clip's posts exist (``posts.create_for_clip``, the same function Confirm uses); the clip is
   ``publishing`` while any post is ``queued``.
2. ``publish-{platform}`` for each ``queued`` post (``pending_integration`` posts get no step); 3 attempts on
   ``RetryablePublishError``. Exhausted retries → ``post-failed-{platform}`` marks that post ``failed``.
3. ``settle-clip``: the clip becomes ``posted`` (≥ 1 post posted), ``failed`` (every queued post failed) or stays
   ``confirmed`` (nothing was queued). Nothing posted → ``upsert-vector`` (``confirmed``), outcome ``not_posted``.
4. ``wait-48h``: a durable wait, no compute and no schedule.
5. ``metrics`` → 6. ``distil`` (one Learning) → 7. ``upsert-vector`` (``performed`` + the summed performance).

Steps are at-least-once: a publish step reads the post first and never sends a post that is no longer ``queued``,
and every write is conditional, so a replayed step changes nothing twice.
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from aws_durable_execution_sdk_python import DurableContext, StepError, durable_execution
from aws_durable_execution_sdk_python.config import Duration, StepSemantics

from .. import db, learn, posts, settings
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from ..platforms import (
    NotConnectedError,
    PlatformAdapter,
    PublishError,
    RetryablePublishError,
    adapter_for,
    label,
)
from ..vectors import Vectors
from . import TransientError, error_message, retrying, transient

PERF_CHECK_DELAY = timedelta(hours=48)
WAIT = Duration.from_hours(48)
METRIC_ATTEMPTS = 3
DECIDED = ("confirmed", "publishing", "posted", "failed")

Item = dict[str, Any]


@dataclass
class ClipFlowDeps:
    store: db.Store
    bedrock: Any
    model_id: str
    vectors: Vectors | None
    adapters: Callable[[str], PlatformAdapter] = field(default=adapter_for)
    clock: Clock = field(default=utcnow)
    sleep: Callable[[float], None] = field(default=time.sleep)


@dataclass(frozen=True)
class Target:
    clip_id: str
    user_id: str

    @property
    def pk(self) -> str:
        return db.user_pk(self.user_id)

    @property
    def sk(self) -> str:
        return db.clip_sk(self.clip_id)


def parse_event(event: Any) -> Target | None:
    if not isinstance(event, dict):
        return None
    clip_id, user_id = event.get("clipId"), event.get("userId")
    if not (isinstance(clip_id, str) and clip_id and isinstance(user_id, str) and user_id):
        return None
    return Target(clip_id, user_id)


def run_clip_flow(ctx: Any, event: Any, deps: ClipFlowDeps) -> dict[str, Any]:
    target = parse_event(event)
    if target is None:
        log("error", "clip_flow.bad_event")
        return {"clipId": event.get("clipId") if isinstance(event, dict) else None, "outcome": "bad_event"}
    found = ctx.step(lambda _sc: ensure_posts(deps, target), name="ensure-posts", config=retrying())
    for post in found:
        if post.get("status") != "queued":
            continue  # pending_integration: no account yet, so no step
        platform = str(post["platform"])
        post_id = str(post["postId"])
        idempotent = bool(getattr(deps.adapters(platform), "idempotent", False))
        semantics = StepSemantics.AT_LEAST_ONCE_PER_RETRY if idempotent else StepSemantics.AT_MOST_ONCE_PER_RETRY
        try:
            ctx.step(
                lambda _sc, post_id=post_id: publish_post(deps, target, post_id),
                name=f"publish-{platform}",
                config=retrying(RetryablePublishError, TransientError, semantics=semantics),
            )
        except StepError as e:
            log("warning", "clip_flow.publish_failed", clipId=target.clip_id, platform=platform, error=error_message(e))
            ctx.step(
                lambda _sc, post_id=post_id, platform=platform: post_failed(deps, target, post_id, platform),
                name=f"post-failed-{platform}",
                config=retrying(),
            )
    settled = ctx.step(lambda _sc: settle_clip(deps, target), name="settle-clip", config=retrying())
    if settled["status"] in {"missing", "skipped"}:
        return _done(target, settled["status"])
    if not settled["posted"]:
        _vector_step(ctx, deps, target, status="confirmed", platforms=None, performance=None)
        return _done(target, "not_posted")
    ctx.wait(WAIT, name="wait-48h")
    measured = ctx.step(lambda _sc: read_metrics(deps, target), name="metrics", config=retrying())
    learning_id: str | None = None
    try:
        distilled = ctx.step(lambda _sc: distil(deps, target), name="distil", config=retrying())
        learning_id = distilled.get("learningId")
    except StepError as e:  # a Learning is a bonus; the clip is posted and measured either way
        log("error", "clip_flow.distil_failed", clipId=target.clip_id, error=error_message(e))
    performance = summed_performance(measured)
    if performance is None:
        _vector_step(
            ctx, deps, target, status="confirmed", platforms=settled["posted"], performance=None
        )  # nothing could be measured
    else:
        _vector_step(ctx, deps, target, status="performed", platforms=settled["posted"], performance=performance)
    out = _done(target, "done")
    if learning_id:
        out["learningId"] = learning_id
    return out


def _done(target: Target, outcome: str) -> dict[str, Any]:
    log("info", "clip_flow.done", clipId=target.clip_id, outcome=outcome)
    return {"clipId": target.clip_id, "outcome": outcome}


def _vector_step(
    ctx: Any,
    deps: ClipFlowDeps,
    target: Target,
    *,
    status: str,
    platforms: list[str] | None,
    performance: dict[str, Any] | None,
) -> None:
    try:
        ctx.step(
            lambda _sc: upsert_vector(deps, target, status=status, platforms=platforms, performance=performance),
            name="upsert-vector",
            config=retrying(),
        )
    except StepError as e:  # the vector is advice for later jobs; it never fails the clip's flow
        log("error", "clip_flow.vector_failed", clipId=target.clip_id, error=error_message(e))


def summed_performance(measured: dict[str, Any]) -> dict[str, Any] | None:
    rows = [m["metrics"] for m in measured.get("measured", []) if isinstance(m.get("metrics"), dict)]
    if not rows:
        return None
    total: dict[str, Any] = {
        k: sum(int(r.get(k, 0) or 0) for r in rows) for k in ("views", "likes", "comments", "shares")
    }
    total["posts"] = len(rows)
    total["checkedAt"] = max(str(r.get("checkedAt") or "") for r in rows)
    return total


# --- steps ----------------------------------------------------------------------------------------------------------


def _guard(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except db.ConditionFailed:
        raise
    except (PublishError, NotConnectedError):
        raise
    except Exception as e:
        raise transient(e) from e


def _clip(deps: ClipFlowDeps, target: Target) -> Item | None:
    item: Item | None = _guard(lambda: deps.store.get(target.pk, target.sk))
    return item


def _post_rows(deps: ClipFlowDeps, target: Target) -> list[Item]:
    rows: list[Item] = _guard(lambda: posts.posts_for_clip(deps.store, target.user_id, target.clip_id, consistent=True))
    return rows


def ensure_posts(deps: ClipFlowDeps, target: Target) -> list[dict[str, Any]]:
    clip = _clip(deps, target)
    if clip is None or clip.get("status") not in DECIDED:
        log("warning", "clip_flow.not_kept", clipId=target.clip_id, status=(clip or {}).get("status"))
        return []
    try:
        found = _guard(
            lambda: posts.create_for_clip(
                deps.store,
                target.user_id,
                clip,
                settings.load(deps.store, target.user_id),
                iso(deps.clock()),
                expect_status=DECIDED,
            )
        )
    except db.ConditionFailed:  # created meanwhile (or the clip changed): read what is there
        found = [posts.public_post(p) for p in _post_rows(deps, target)]
    if clip.get("status") == "confirmed" and any(p.get("status") == "queued" for p in found):
        with contextlib.suppress(db.ConditionFailed):
            _guard(
                lambda: deps.store.update(
                    target.pk, target.sk, {"status": "publishing"}, expect_in={"status": ["confirmed"]}
                )
            )
    return [{"postId": p["postId"], "platform": p["platform"], "status": p["status"]} for p in found]


def publish_post(deps: ClipFlowDeps, target: Target, post_id: str) -> dict[str, Any]:
    """Sends one queued post. A post that is no longer ``queued`` (posted by an earlier attempt) is never sent."""
    pk, sk = target.pk, db.post_sk(post_id)
    post = _guard(lambda: deps.store.get(pk, sk))
    if post is None:
        return {"status": "missing"}
    if post.get("status") != "queued":
        return {"status": post.get("status")}
    clip = _clip(deps, target) or {}
    platform = str(post["platform"])
    account = _account(deps, target, platform)
    try:
        result = deps.adapters(platform).publish(clip, account, idempotency_key=post_id)
    except NotConnectedError:
        with contextlib.suppress(db.ConditionFailed):
            _guard(
                lambda: deps.store.update(
                    pk, sk, {"status": "pending_integration"}, remove=["error"], expect_in={"status": ["queued"]}
                )
            )
        return {"status": "pending_integration"}
    posted_at = parse(result.posted_at) or deps.clock()
    fields = {
        "status": "posted",
        "url": result.url,
        "postedAt": iso(posted_at),
        "perfCheckAt": iso(posted_at + PERF_CHECK_DELAY),
    }
    try:
        _guard(lambda: deps.store.update(pk, sk, fields, remove=["error"], expect_in={"status": ["queued"]}))
    except db.ConditionFailed:
        current = _guard(lambda: deps.store.get(pk, sk)) or {}
        return {"status": current.get("status")}
    log("info", "clip_flow.posted", clipId=target.clip_id, postId=post_id, platform=platform)
    return {"status": "posted"}


def post_failed(deps: ClipFlowDeps, target: Target, post_id: str, platform: str) -> dict[str, str]:
    text = f"Posting to {label(platform)} did not work. Press Try again."
    try:
        _guard(
            lambda: deps.store.update(
                target.pk, db.post_sk(post_id), {"status": "failed", "error": text}, expect_in={"status": ["queued"]}
            )
        )
    except db.ConditionFailed:
        return {"status": "unchanged"}
    return {"status": "failed"}


def settle_clip(deps: ClipFlowDeps, target: Target) -> dict[str, Any]:
    clip = _clip(deps, target)
    if clip is None:
        return {"status": "missing", "posted": []}
    if clip.get("status") not in DECIDED:
        return {"status": "skipped", "posted": []}
    rows = _post_rows(deps, target)
    posted = [str(p["platform"]) for p in rows if p.get("status") == "posted"]
    statuses = {p.get("status") for p in rows}
    if posted:
        new = "posted"
    elif "failed" in statuses and "queued" not in statuses:
        new = "failed"
    else:
        new = "confirmed"
    if clip.get("status") != new:
        with contextlib.suppress(db.ConditionFailed):
            _guard(
                lambda: deps.store.update(target.pk, target.sk, {"status": new}, expect_in={"status": list(DECIDED)})
            )
    return {"status": new, "posted": posted}


def _account(deps: ClipFlowDeps, target: Target, platform: str) -> Item | None:
    account: Item | None = _guard(lambda: posts.connected_account(deps.store, target.user_id, platform))
    return account


def _save_metrics(deps: ClipFlowDeps, post: Item, metrics: dict[str, Any]) -> None:
    _guard(lambda: deps.store.update(post["pk"], post["sk"], {"metrics": metrics}))


def read_metrics(deps: ClipFlowDeps, target: Target) -> dict[str, Any]:
    """48-hour metrics for every posted post; a platform that still fails after 3 attempts is skipped."""
    measured = []
    for post in _post_rows(deps, target):
        if post.get("status") != "posted":
            continue
        platform = str(post["platform"])
        account = _account(deps, target, platform)
        metrics: dict[str, Any] | None = None
        for attempt in range(METRIC_ATTEMPTS):
            try:
                m = deps.adapters(platform).metrics(post, account)
            except (NotConnectedError, PublishError) as e:
                if isinstance(e, RetryablePublishError) and attempt + 1 < METRIC_ATTEMPTS:
                    deps.sleep(2**attempt)
                    continue
                log("info", "clip_flow.no_metrics", postId=post["postId"], platform=platform, reason=type(e).__name__)
                break
            metrics = {
                "views": m.views,
                "likes": m.likes,
                "comments": m.comments,
                "shares": m.shares,
                "checkedAt": iso(deps.clock()),
            }
            break
        if metrics is None:
            continue
        _save_metrics(deps, post, metrics)
        measured.append({"postId": post["postId"], "platform": platform, "metrics": metrics})
    return {"measured": measured}


def distil(deps: ClipFlowDeps, target: Target) -> dict[str, Any]:
    outcome, learning_id = _guard(
        lambda: learn.distil_learning(deps.store, deps.bedrock, deps.model_id, target.user_id, clock=deps.clock)
    )
    out: dict[str, Any] = {"outcome": outcome}
    if learning_id:
        out["learningId"] = learning_id
    return out


def upsert_vector(
    deps: ClipFlowDeps,
    target: Target,
    *,
    status: str,
    platforms: list[str] | None,
    performance: dict[str, Any] | None,
) -> dict[str, str]:
    if deps.vectors is None or not deps.vectors.configured:
        return {"vector": "skipped"}
    clip = _clip(deps, target)
    if clip is None:
        return {"vector": "skipped"}
    vectors = deps.vectors
    outcome: str = _guard(
        lambda: vectors.upsert_clip(clip, status=status, platforms=platforms, performance=performance)
    )
    return {"vector": outcome}


# --- Lambda entry point ---------------------------------------------------------------------------------------------

_deps: ClipFlowDeps | None = None


def _from_env() -> ClipFlowDeps:
    import boto3
    from botocore.config import Config

    from .. import vectors
    from ..app import region, table

    env = os.environ
    reg = region()
    bedrock = boto3.client(
        "bedrock-runtime",
        region_name=reg,
        config=Config(read_timeout=120, retries={"mode": "adaptive", "max_attempts": 4}),
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
    return ClipFlowDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        bedrock=bedrock,
        model_id=env["MODEL_ID"],
        vectors=vector_store,
    )


def get_deps(factory: Callable[[], ClipFlowDeps] = _from_env) -> ClipFlowDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


@durable_execution
def handler(event: Any, context: DurableContext) -> dict[str, Any]:
    return run_clip_flow(context, event, get_deps())
