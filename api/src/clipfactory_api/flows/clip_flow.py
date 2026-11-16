"""``cf-prod-clip-flow``: publish a kept clip, wait 48 hours, learn from it (docs/CONTRACTS.md §14.5).

Started by Confirm (``clip-{clipId}-{flowRun}`` on the alias ``live``) with ``{"clipId", "userId", "run"}``:

1. ``ensure-posts``: the clip's posts exist (``posts.create_for_clip``, the same function Confirm uses); the clip is
   ``publishing`` while any post is ``queued``.
2. Per ``queued`` post, one platform after another (§17.6): ``publish-{platform}`` (start) → while processing:
   ``wait-{platform}-{n}`` + ``check-{platform}-{n}`` → ``finish-{platform}`` → done (``posts.mark_posted``).
   3 attempts on ``RetryablePublishError``/``TransientError``. A failure → ``post-failed-{platform}`` with a plain
   sentence. A public TikTok post without its id yet → ``wait-tiktok-id-{n}`` + ``tiktok-id-{n}``.
3. ``settle-clip``: the clip becomes ``posted`` (≥ 1 post posted), ``failed`` (every queued post failed) or stays
   ``confirmed`` (nothing was queued). Nothing posted → ``upsert-vector`` (``confirmed``), outcome ``not_posted``.
4. ``wait-48h``: a durable wait, no compute and no schedule.
5. ``metrics`` (``stats.refresh.refresh_posts``, the poller's code path and rate budget; a blocked or failing
   platform keeps the numbers the poller stored) → 6. ``distil`` (one Learning; the owner's skills block goes
   first in its system prompt, §18.6) → 7. ``upsert-vector``
   (``performed`` + the summed performance).

Steps are at-least-once: a publish step reads the post first and never sends a post that is no longer ``queued``,
and every write is conditional, so a replayed step changes nothing twice.
"""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from aws_durable_execution_sdk_python import DurableContext, StepError, durable_execution
from aws_durable_execution_sdk_python.config import Duration, StepSemantics

from .. import db, learn, posts, s3, settings
from ..clock import Clock, iso, utcnow
from ..log import log
from ..platforms import (
    NotConnectedError,
    PlatformAdapter,
    PublishError,
    RetryablePublishError,
    adapter_for,
    label,
)
from ..platforms import errors as platform_errors
from ..platforms.base import HttpClient, Progress, PublishJob, ReconnectNeededError, urllib_client
from ..platforms.publishers import AdapterPublisher
from ..skills import BuiltinSkill, load_builtins
from ..stats import budget, config
from ..stats.refresh import StatsDeps, refresh_posts
from ..vectors import Vectors
from . import TransientError, error_message, retrying, transient

WAIT = Duration.from_hours(48)
COMMON_METRICS = ("views", "likes", "comments", "shares")
DECIDED = ("confirmed", "publishing", "posted", "failed")

Item = dict[str, Any]


@dataclass
class ClipFlowDeps:
    store: db.Store
    bedrock: Any
    model_id: str
    vectors: Vectors | None
    media: s3.Media  # the owner's skills for the distil call (§18.6)
    adapters: Callable[[str], PlatformAdapter] = field(default=adapter_for)
    clock: Clock = field(default=utcnow)
    sleep: Callable[[float], None] = field(default=time.sleep)
    http: HttpClient = field(default=urllib_client)
    accounts: Callable[[db.Store, str, str], Item | None] = field(default=posts.connected_account)
    builtins: Callable[[], Sequence[BuiltinSkill]] = field(default=load_builtins)
    # §17.6: real publishers and tokens in production; None → each adapter's one-call ``publish`` (tests, local runs)
    publishers: Callable[[str], Any] | None = None
    tokens: Any = None  # oauth.tokens.SecretsTokenProvider
    video: Callable[[Item], Any] | None = None  # clip → VideoSource
    graph_api_version: str = "v27.0"
    cfg: config.PlatformsConfig | None = None

    def publisher(self, platform: str) -> Any:
        if self.publishers is None:
            return AdapterPublisher(self.adapters(platform))
        return self.publishers(platform)

    @property
    def config(self) -> config.PlatformsConfig:
        if self.cfg is None:
            self.cfg = config.load()
        return self.cfg


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
        publish_chain(ctx, deps, target, str(post["platform"]), str(post["postId"]))
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


# --- publishing (§17.6) -----------------------------------------------------------------------------------------

AT_MOST = {"at_most_once": StepSemantics.AT_MOST_ONCE_PER_RETRY}
ACTIVE = ("processing", "ready_to_finish")
POSTED_ANYWAY = frozenset({"youtube", "tiktok"})  # the platform finishes processing on its own


def _semantics(kind: str) -> StepSemantics:
    return AT_MOST.get(kind, StepSemantics.AT_LEAST_ONCE_PER_RETRY)


def publish_chain(ctx: Any, deps: ClipFlowDeps, target: Target, platform: str, post_id: str) -> None:
    """``publish-`` → (``wait-``/``check-``)* → ``finish-`` → (``wait-``/``check-``)* for one post."""
    publisher = deps.publisher(platform)
    max_checks = int(deps.config.platform(platform).publish_settings.get("maxChecks", 20))
    start_semantics = _semantics(publisher.start_semantics)
    finish_semantics = _semantics(publisher.finish_semantics)

    def run(name: str, phase: str, semantics: StepSemantics) -> dict[str, Any] | None:
        try:
            result: dict[str, Any] = ctx.step(
                lambda _sc: publish_step(deps, target, post_id, phase),
                name=name,
                config=retrying(RetryablePublishError, TransientError, semantics=semantics),
            )
        except StepError as e:
            text = failure_text(platform, e, at_most_once=semantics == StepSemantics.AT_MOST_ONCE_PER_RETRY)
            log("warning", "clip_flow.publish_failed", clipId=target.clip_id, platform=platform, step=name)
            ctx.step(
                lambda _sc: post_failed(deps, target, post_id, platform, text),
                name=f"post-failed-{platform}",
                config=retrying(),
            )
            return None
        return result

    progress = run(f"publish-{platform}", "start", start_semantics)
    checks = 0
    finished = False
    while progress is not None and progress.get("state") in ACTIVE:
        if progress["state"] == "ready_to_finish" and not finished:
            finished = True
            progress = run(f"finish-{platform}", "finish", finish_semantics)
            continue
        checks += 1
        if checks > max_checks:
            _over_limit(ctx, deps, target, platform, post_id)
            return
        wait = max(1, int(progress.get("checkAfter") or 30))
        ctx.wait(Duration.from_seconds(wait), name=f"wait-{platform}-{checks}")
        progress = run(f"check-{platform}-{checks}", "check", StepSemantics.AT_LEAST_ONCE_PER_RETRY)
    if progress is not None and progress.get("state") == "done" and progress.get("needsId"):
        _tiktok_id(ctx, deps, target, post_id)


def _over_limit(ctx: Any, deps: ClipFlowDeps, target: Target, platform: str, post_id: str) -> None:
    if platform in POSTED_ANYWAY:
        ctx.step(
            lambda _sc: publish_step(deps, target, post_id, "anyway"), name=f"posted-{platform}", config=retrying()
        )
        return
    text = f"{label(platform)} could not finish this video. Press Try again."
    ctx.step(
        lambda _sc: post_failed(deps, target, post_id, platform, text),
        name=f"post-failed-{platform}",
        config=retrying(),
    )


def _tiktok_id(ctx: Any, deps: ClipFlowDeps, target: Target, post_id: str) -> None:
    settings_ = deps.config.platform("tiktok").publish_settings
    every = int(settings_.get("idCheckMinutes", 10))
    for n in range(1, int(settings_.get("idMaxChecks", 12)) + 1):
        ctx.wait(Duration.from_minutes(every), name=f"wait-tiktok-id-{n}")
        try:
            found = ctx.step(
                lambda _sc: tiktok_id_step(deps, target, post_id), name=f"tiktok-id-{n}", config=retrying()
            )
        except StepError:
            return  # the post is live either way; it just has no numbers
        if found.get("statsId") or found.get("state") != "waiting":
            return


def failure_text(platform: str, err: BaseException, *, at_most_once: bool) -> str:
    kind = str(getattr(err, "error_type", "") or "").rsplit(".", 1)[-1]
    name = label(platform)
    if kind == "StepInterruptedError" and at_most_once:
        return f"We are not sure it posted. Look on {name} before you press Try again."
    if kind in {"ReconnectNeededError", "ReconnectProblem"}:
        return f"Connect {name} again in Settings › Posting › Set up posting, then press Try again."
    if kind in {"PublishError", "PlatformProblem"}:
        message = error_message(err).strip()
        return message or f"Posting to {name} did not work. Press Try again."
    return f"Posting to {name} did not work. Press Try again."


def _save_handle(deps: ClipFlowDeps, target: Target, post_id: str) -> Callable[[dict[str, Any]], None]:
    def save(handle: dict[str, Any]) -> None:
        with contextlib.suppress(db.ConditionFailed):
            _guard(
                lambda: deps.store.update(
                    target.pk, db.post_sk(post_id), {"publishHandle": handle}, expect_in={"status": ["queued"]}
                )
            )

    return save


def _pending(deps: ClipFlowDeps, target: Target, post_id: str) -> dict[str, Any]:
    with contextlib.suppress(db.ConditionFailed):
        _guard(
            lambda: deps.store.update(
                target.pk,
                db.post_sk(post_id),
                {"status": "pending_integration"},
                remove=["error"],
                expect_in={"status": ["queued"]},
            )
        )
    return {"state": "pending_integration"}


def publish_step(deps: ClipFlowDeps, target: Target, post_id: str, phase: str) -> dict[str, Any]:
    """One publishing step. Reads the post first: one that is no longer ``queued`` is never touched again."""
    pk, sk = target.pk, db.post_sk(post_id)
    post = _guard(lambda: deps.store.get(pk, sk))
    if post is None:
        return {"state": "missing"}
    if post.get("status") != "queued":
        return {"state": str(post.get("status"))}
    platform = str(post["platform"])
    clip = _clip(deps, target) or {}
    account = _account(deps, target, platform)
    if account is None:
        return _pending(deps, target, post_id)
    publisher = deps.publisher(platform)
    try:
        creds = None
        if publisher.needs_credentials:
            if deps.tokens is None:
                raise NotConnectedError(f"Connect {label(platform)} in Settings › Posting › Set up posting.")
            creds = deps.tokens.credentials(platform, account)
        job = PublishJob(
            post=post,
            clip=clip,
            account=account,
            creds=creds,
            video=deps.video(clip) if deps.video is not None and publisher.needs_credentials else None,  # type: ignore[arg-type]
            options=dict(post.get("postOptions") or {}),
            settings=settings.load(deps.store, target.user_id),
            http=deps.http,
            config=deps.config.platform(platform).publish_settings,
            save=_save_handle(deps, target, post_id),
            now=deps.clock,
            graph_api_version=deps.graph_api_version,
        )
        progress = _advance(deps, publisher, job, phase)
    except NotConnectedError:
        return _pending(deps, target, post_id)
    except ReconnectNeededError:
        if deps.tokens is not None:
            deps.tokens.mark_dead(platform, account)
        raise
    except platform_errors.PlatformProblem as e:
        if e.problem.kind == "credits":
            _credits(deps, target, "action")
        raise
    if progress.state != "done" or progress.published is None:
        return progress.to_json()
    try:
        _guard(lambda: posts.mark_posted(deps.store, post, progress.published, deps.clock()))
    except db.ConditionFailed:
        current = _guard(lambda: deps.store.get(pk, sk)) or {}
        return {"state": str(current.get("status"))}
    if platform == "x" and publisher.needs_credentials:
        _credits(deps, target, "ok")
    log("info", "clip_flow.posted", clipId=target.clip_id, postId=post_id, platform=platform)
    published = progress.published
    needs_id = (
        platform == "tiktok"
        and publisher.needs_credentials
        and published.privacy == "public"
        and not published.stats_id
    )
    return {"state": "done", "needsId": needs_id}


def _advance(deps: ClipFlowDeps, publisher: Any, job: PublishJob, phase: str) -> Progress:
    handle = job.handle
    first_x = phase == "start" and job.post.get("platform") == "x" and publisher.needs_credentials and not handle
    if first_x and not _guard(lambda: budget.charge_post(deps.store, deps.clock(), cfg=deps.config)):
        raise PublishError(budget.X_POST_CAP_TEXT)
    result: Progress
    if phase == "start":
        result = publisher.start(job)
    elif phase == "finish":
        result = publisher.finish(job, handle)
    elif phase == "anyway":
        result = Progress("done", handle, published=publisher.published(job, handle))
    else:
        result = publisher.check(job, handle)
    return result


def _credits(deps: ClipFlowDeps, target: Target, state: str) -> None:
    from ..oauth import setup

    try:
        current = setup.item(deps.store, target.user_id, "x").get("gates") or {}
        if (current.get("credits") or {}).get("state") == state:
            return
        setup.set_gate(deps.store, target.user_id, "x", "credits", state=state, now=deps.clock())
    except Exception as e:  # the gate is a hint on the setup page; posting goes on either way
        log("warning", "clip_flow.credits_gate_failed", error=type(e).__name__)


def tiktok_id_step(deps: ClipFlowDeps, target: Target, post_id: str) -> dict[str, Any]:
    post = _guard(lambda: deps.store.get(target.pk, db.post_sk(post_id)))
    if post is None or post.get("status") != "posted":
        return {"state": "gone"}
    if post.get("statsId"):
        return {"state": "done", "statsId": post["statsId"]}
    account = _account(deps, target, "tiktok")
    if account is None or deps.tokens is None:
        return {"state": "gone"}
    publisher = deps.publisher("tiktok")
    creds = deps.tokens.credentials("tiktok", account)
    job = PublishJob(
        post=post,
        clip={},
        account=account,
        creds=creds,
        video=None,  # type: ignore[arg-type]
        options={},
        settings={},
        http=deps.http,
        now=deps.clock,
    )
    found = publisher.public_id(job, job.handle)
    if not found:
        return {"state": "waiting"}
    try:
        _guard(lambda: posts.set_stats_id(deps.store, post, found, deps.clock()))
    except db.ConditionFailed:
        return {"state": "done"}
    username = str(job.handle.get("username") or "")
    if username:
        with contextlib.suppress(db.ConditionFailed):
            url = f"https://www.tiktok.com/@{username}/video/{found}"
            _guard(lambda: deps.store.update(target.pk, db.post_sk(post_id), {"url": url}))
    return {"state": "done", "statsId": found}


def post_failed(
    deps: ClipFlowDeps, target: Target, post_id: str, platform: str, text: str | None = None
) -> dict[str, str]:
    text = text or f"Posting to {label(platform)} did not work. Press Try again."
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


def _stats_deps(deps: ClipFlowDeps) -> StatsDeps:
    return StatsDeps(
        store=deps.store,
        http=deps.http,
        adapters=deps.adapters,
        clock=deps.clock,
        sleep=deps.sleep,
        accounts=deps.accounts,
    )


def read_metrics(deps: ClipFlowDeps, target: Target) -> dict[str, Any]:
    """The 48-hour numbers of every posted post through the shared stats refresh. A platform that is blocked,
    not connected or still failing keeps the metrics the poller stored; a post with none at all is skipped."""
    rows = [p for p in _post_rows(deps, target) if p.get("status") == "posted"]
    report = _guard(lambda: refresh_posts(_stats_deps(deps), rows, reason="flow", now=deps.clock()))
    measured = []
    for post in rows:
        post_id = str(post["postId"])
        metrics = report.updated.get(post_id)
        if metrics is None and isinstance(post.get("metrics"), dict):
            metrics = post["metrics"]
        if metrics is None:
            log(
                "info",
                "clip_flow.no_metrics",
                postId=post_id,
                platform=post.get("platform"),
                reason=report.outcomes.get(post_id),
            )
            continue
        row = {k: metrics.get(k) for k in COMMON_METRICS}
        row["checkedAt"] = str(metrics.get("metricsUpdatedAt") or metrics.get("checkedAt") or iso(deps.clock()))
        measured.append({"postId": post_id, "platform": str(post["platform"]), "metrics": row})
    return {"measured": measured}


def distil(deps: ClipFlowDeps, target: Target) -> dict[str, Any]:
    outcome, learning_id = _guard(
        lambda: learn.distil_learning(
            deps.store,
            deps.bedrock,
            deps.model_id,
            target.user_id,
            media=deps.media,
            clock=deps.clock,
            builtins=deps.builtins,
            sleep=deps.sleep,
        )
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
    from .. import s3
    from ..oauth.tokens import token_provider_from_env
    from ..platforms import make_adapters
    from ..platforms.publishers import publisher_for
    from ..platforms.video import S3Video
    from ..stats import config

    store = db.Store(table(env["TABLE_NAME"]))
    cfg = config.load()
    tokens = token_provider_from_env(store)
    media_client = s3.make_client(reg)
    bucket = env.get("MEDIA_BUCKET", "")
    media = s3.Media(media_client, env["MEDIA_BUCKET"])

    def video(clip: Item) -> S3Video:
        key = str(clip.get("videoKey") or s3.clip_prefix(str(clip.get("jobId")), str(clip.get("clipId"))) + "clip.mp4")
        return S3Video(media_client, bucket, key)

    if tokens is None:
        return ClipFlowDeps(
            store=store, bedrock=bedrock, model_id=env["MODEL_ID"], vectors=vector_store, media=media, cfg=cfg
        )
    adapters = make_adapters(tokens=tokens, graph_api_version=cfg.graph_api_version)
    return ClipFlowDeps(
        store=store,
        bedrock=bedrock,
        model_id=env["MODEL_ID"],
        vectors=vector_store,
        media=media,
        adapters=lambda platform: adapters[platform],
        publishers=publisher_for,
        tokens=tokens,
        video=video,
        graph_api_version=cfg.graph_api_version,
        cfg=cfg,
    )


def get_deps(factory: Callable[[], ClipFlowDeps] = _from_env) -> ClipFlowDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


@durable_execution
def handler(event: Any, context: DurableContext) -> dict[str, Any]:
    return run_clip_flow(context, event, get_deps())
