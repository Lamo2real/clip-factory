"""``cf-prod-story-flow`` (durable, alias ``live``): sends one approved Lamo Stories video to the workspace's own
social accounts, checking every destination before every platform call (docs/CONTRACTS.md §45.14, ADR-73).

Started by the publish and retry routes (``story-{storyId}-{run}``) with ``{userId, workspaceId, storyId,
publishingJobIds, run}``:

1. ``load-jobs``: the run's publishing jobs and their platforms (only this workspace's partition is read).
2. Per job, one platform after another: ``validate-{platform}`` (an early stop) → ``publish-{platform}`` (start) →
   while processing ``wait-{platform}-{n}`` + ``check-{platform}-{n}`` → ``finish-{platform}`` → ``posted-{platform}``
   (the story's ``posted``, ``publishedAt`` and ``published`` status, and an ``ACT#`` item). A failure →
   ``failed-{platform}``.
3. Once every platform is posted to, a public TikTok post without its id yet → ``wait-tiktok-id-{n}`` +
   ``tiktok-id-{n}`` (so TikTok's id never holds up the next platform's post).
4. ``wait-numbers-{k}`` + ``numbers-{k}`` at 1 h, 24 h, 72 h and 7 days after **each** post's own ``postedAt``
   (posts due within ``NUMBERS_SLACK`` of each other are read together; another group at the same checkpoint is
   ``numbers-{k}-{i}``): views, likes, comments and shares through the platforms' stats adapters with the
   workspace's credentials, stored on the publishing job, through the same rate budgets as Lamo Clips. Every wait
   is measured from the time the last step reported.

No job is left in flight: a step that runs out of tries ends its job in ``failed-{platform}`` (``stop-jobs`` when
the jobs could not even be loaded), and a job whose flow is gone altogether is failed by the API's next read of the
jobs (``workspaces.publish.settle_stuck``).

**Every step that calls a platform** (publish, check, finish, the TikTok id, numbers) runs
``workspaces.destinations.validate_destination`` inside its own body first: a workspace, story or account that no
longer checks out stops that job (``needs_attention``, a plain sentence) and nothing is sent. The publishers are Lamo
Clips' (``platforms.publishers``, unchanged) with the PublishJob of §45.14: ``settings = {}`` (Lamo Clips' settings
and preset never apply), the allow-listed options only, the credentials from ``WorkspaceTokenProvider``; a story
with realistic AI footage (``nova-reel``) goes through Lamo Stories' own labelling wrappers
(``workspaces.publish.publisher``). Limits follow the developer app (§45.30): with Clip Factory's app the first X
start is charged with ``budget.charge_post`` exactly as the clip flow does on the shared ``RATE#x`` (Lamo Clips'
setup gates are never written); with Lamo Stories' own app the same calls use its own counters
``RATE#WS#{ws}#{platform}`` and its ``xMonthlyLimitUsd``. Every numbers read checks ``blocked_until``,
``reserve``s and ``record``s the same way.

Steps are at-least-once: a step reads its job first and never sends one that is no longer ``queued`` or
``publishing`` or belongs to another run, and every write is conditional, so a replayed step changes nothing twice.
Sentences are Lamo Stories' own (``workspaces.sentences``): nothing stored names Lamo Clips' Settings.
"""

from __future__ import annotations

import contextlib
import math
import os
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from aws_durable_execution_sdk_python import DurableContext, StepError, durable_execution
from aws_durable_execution_sdk_python.config import Duration, StepSemantics

from .. import db
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from ..oauth import META, OAuthEnv
from ..platforms import ADAPTER_CLASSES, NotConnectedError, PublishError, RetryablePublishError
from ..platforms import errors as platform_errors
from ..platforms.base import (
    HttpClient,
    NetworkError,
    Progress,
    PublishJob,
    ReconnectNeededError,
    stats_id,
    urllib_client,
)
from ..platforms.publishers import publisher_for
from ..stats import budget, config
from ..workspaces import apps
from ..workspaces import publish as ws_publish
from ..workspaces import types as ws
from ..workspaces.destinations import Destination, DestinationProblem, story_sk, validate_destination
from ..workspaces.publish import IN_FLIGHT, AiLabelMissing, flow_options, pubjob_sk
from ..workspaces.secrets import WorkspaceSecrets
from ..workspaces.sentences import kind_of_message, needs_you, story_sentence
from ..workspaces.tokens import WorkspaceTokenProvider
from . import TransientError, error_message, retrying, transient

Item = dict[str, Any]
COMMON = ("views", "likes", "comments", "shares")
NUMBERS_AT = (timedelta(hours=1), timedelta(hours=24), timedelta(hours=72), timedelta(days=7))
ACTIVE = ("processing", "ready_to_finish")
POSTED_ANYWAY = frozenset({"youtube", "tiktok"})  # the platform finishes processing on its own
NUMBERS_SLACK = timedelta(minutes=10)
ACT_TTL = timedelta(days=90)
MAX_JOBS = 5


class XCapReached(PublishError):
    """The monthly X limit (shared with Lamo Clips on its app, Lamo Stories' own on its own) is used up: nothing
    goes to X."""


def default_adapter(platform: str, tokens: Any, graph_api_version: str) -> Any:
    return ADAPTER_CLASSES[platform](tokens=tokens, graph_api_version=graph_api_version)


@dataclass
class StoryFlowDeps:
    store: db.Store
    oauth: OAuthEnv  # http and clock for token refreshes; app keys come only through workspaces.apps
    secrets: WorkspaceSecrets
    publishers: Callable[[str], Any] = field(default=publisher_for)
    video: Callable[[Item], Any] | None = None  # story → VideoSource on its final/v{n}.mp4
    adapters: Callable[[str, Any, str], Any] = field(default=default_adapter)
    clock: Clock = field(default=utcnow)
    sleep: Callable[[float], None] = field(default=time.sleep)
    http: HttpClient = field(default=urllib_client)
    graph_api_version: str = "v27.0"
    cfg: config.PlatformsConfig | None = None

    @property
    def config(self) -> config.PlatformsConfig:
        if self.cfg is None:
            self.cfg = config.load()
        return self.cfg

    def tokens(self, target: Target) -> WorkspaceTokenProvider:
        return WorkspaceTokenProvider(
            self.store, self.oauth, self.secrets, target.user_id, target.workspace_id, sleep=self.sleep
        )


@dataclass(frozen=True)
class Target:
    user_id: str
    workspace_id: str
    story_id: str
    job_ids: tuple[str, ...]
    run: int

    @property
    def pk(self) -> str:
        return ws.workspace_pk(self.user_id, self.workspace_id)


def parse_event(event: Any) -> Target | None:
    if not isinstance(event, dict):
        return None
    user_id, workspace_id, story_id = event.get("userId"), event.get("workspaceId"), event.get("storyId")
    ids, run = event.get("publishingJobIds"), event.get("run")
    if not (isinstance(user_id, str) and user_id and isinstance(story_id, str) and story_id):
        return None
    if not isinstance(workspace_id, str) or workspace_id == ws.CLIPS or not ws.WORKSPACE_ID.match(workspace_id):
        return None
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_JOBS or not all(isinstance(i, str) and i for i in ids):
        return None
    if not isinstance(run, int) or isinstance(run, bool) or run < 1:
        return None
    return Target(user_id, workspace_id, story_id, tuple(dict.fromkeys(ids)), run)


def run_story_flow(ctx: Any, event: Any, deps: StoryFlowDeps) -> dict[str, Any]:
    target = parse_event(event)
    if target is None:
        log("error", "story_flow.bad_event")
        return {"storyId": event.get("storyId") if isinstance(event, dict) else None, "outcome": "bad_event"}
    try:
        jobs = ctx.step(lambda _sc: load_jobs(deps, target), name="load-jobs", config=retrying())
    except StepError as e:
        log("error", "story_flow.load_failed", storyId=target.story_id, error=error_message(e))
        _safely(ctx, lambda _sc: stop_jobs(deps, target, "not_started"), "stop-jobs")
        return _done(target, "not_posted")
    posted: list[dict[str, Any]] = []
    for row in jobs:
        platform = str(row["platform"])
        try:
            done = publish_chain(ctx, deps, target, str(row["publishingJobId"]), platform)
        except StepError as e:  # the next platforms still go; settle_stuck fails a job left in flight
            log("error", "story_flow.chain_failed", platform=platform, error=error_message(e))
            continue
        if done is not None:
            posted.append(done)
    if not posted:
        return _done(target, "not_posted")
    last = _latest(p.get("at") for p in posted)
    for done in posted:
        if done.get("needsId"):
            last = _tiktok_id(ctx, deps, target, str(done["publishingJobId"]), last)
    if last is not None:
        _numbers(ctx, deps, target, posted, last)
    return _done(target, "done")


def _latest(stamps: Any) -> datetime | None:
    found = [t for t in (parse(s) for s in stamps) if t is not None]
    return max(found) if found else None


def _safely(ctx: Any, fn: Callable[[Any], Any], name: str) -> None:
    """A step that ends jobs; when even it runs out of tries the API's ``settle_stuck`` fails them later."""
    try:
        ctx.step(fn, name=name, config=retrying())
    except StepError as e:
        log("error", "story_flow.stop_failed", step=name, error=error_message(e))


def _done(target: Target, outcome: str) -> dict[str, Any]:
    log("info", "story_flow.done", storyId=target.story_id, run=target.run, outcome=outcome)
    return {"storyId": target.story_id, "outcome": outcome}


# --- small helpers ----------------------------------------------------------------------------------------------


def _guard(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except (db.ConditionFailed, PublishError, NotConnectedError, DestinationProblem):
        raise
    except Exception as e:
        raise transient(e) from e


def _job(deps: StoryFlowDeps, target: Target, job_id: str) -> Item | None:
    item: Item | None = _guard(lambda: deps.store.get(target.pk, pubjob_sk(job_id)))
    if item is None or item.get("userId") != target.user_id or item.get("workspaceId") != target.workspace_id:
        return None
    if item.get("publishingJobId") != job_id or item.get("contentId") != target.story_id:
        return None
    return item


def _story(deps: StoryFlowDeps, target: Target) -> Item | None:
    item: Item | None = _guard(lambda: deps.store.get(target.pk, story_sk(target.story_id)))
    if item is None or item.get("userId") != target.user_id or item.get("workspaceId") != target.workspace_id:
        return None
    return item


def _mine(job: Mapping[str, Any], target: Target) -> bool:
    run = job.get("flowRun")
    return isinstance(run, int) and not isinstance(run, bool) and run == target.run


def load_jobs(deps: StoryFlowDeps, target: Target) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for job_id in target.job_ids:
        job = _job(deps, target, job_id)
        if job is None or job.get("platform") not in ws.PLATFORMS:
            log("warning", "story_flow.job_missing", publishingJobId=job_id)
            continue
        if any(o["platform"] == job["platform"] for o in out):
            continue  # each platform once per run (the publish route says so too)
        out.append({"publishingJobId": job_id, "platform": str(job["platform"])})
    return out


def _activity(target: Target, job: Mapping[str, Any], kind: str, *, at: str, title: str, now: datetime) -> Item:
    return {
        "pk": target.pk,
        "sk": f"{ws.ACT_SK}{at}#{job['publishingJobId']}",
        "type": ws.TYPE_ACTIVITY,
        "userId": target.user_id,
        "workspaceId": target.workspace_id,
        "at": at,
        "kind": kind,
        "storyId": target.story_id,
        "title": title,
        "platform": str(job.get("platform") or ""),
        "ttl": int((now + ACT_TTL).timestamp()),
    }


def end_job(deps: StoryFlowDeps, target: Target, job_id: str, kind: str) -> dict[str, str]:
    """Stops one job with Lamo Stories' sentence: ``needs_attention`` when the owner has to fix something, else
    ``failed``; with its ``ACT#`` item in the same transaction (a replay writes neither twice)."""
    job = _job(deps, target, job_id)
    if job is None or job.get("publishingStatus") not in IN_FLIGHT or not _mine(job, target):
        return {"status": "unchanged"}
    platform = str(job.get("platform") or "")
    status = "needs_attention" if needs_you(kind) else "failed"
    now = deps.clock()
    sentence = story_sentence(platform, kind, job.get("accountName"), shared=job.get("appChoice") != apps.OWN)
    update = db.update_request(
        target.pk,
        pubjob_sk(job_id),
        {"publishingStatus": status, "error": sentence, "updatedAt": iso(now)},
        expect_in={"publishingStatus": list(IN_FLIGHT), "flowRun": [target.run]},
    )
    title = str((_story(deps, target) or {}).get("title") or "")
    try:
        _guard(
            lambda: deps.store.transact(
                updates=[update], puts=[_activity(target, job, "failed", at=iso(now), title=title, now=now)]
            )
        )
    except db.ConditionFailed:
        return {"status": "unchanged"}
    log("warning", "story_flow.job_stopped", platform=platform, kind=kind, status=status)
    return {"status": status}


def stop_jobs(deps: StoryFlowDeps, target: Target, kind: str) -> dict[str, Any]:
    """Every job of the run still in flight and this run's ends with ``kind`` (the jobs could not be loaded)."""
    return {"stopped": [end_job(deps, target, job_id, kind)["status"] for job_id in target.job_ids]}


def failure_kind(err: BaseException, *, at_most_once: bool) -> str:
    """The kind of a step that ran out of tries (only passing problems get there: the step ends every other one
    itself, with the exception's own kind)."""
    kind = str(getattr(err, "error_type", "") or "").rsplit(".", 1)[-1]
    if kind == "StepInterruptedError" and at_most_once:
        return "unsure"
    message = error_message(err).lower()
    if "slow down" in message or "busy" in message:
        return "rate"
    return "down"


# --- publishing -------------------------------------------------------------------------------------------------

AT_MOST = {"at_most_once": StepSemantics.AT_MOST_ONCE_PER_RETRY}


def _semantics(kind: str) -> StepSemantics:
    return AT_MOST.get(kind, StepSemantics.AT_LEAST_ONCE_PER_RETRY)


def publish_chain(ctx: Any, deps: StoryFlowDeps, target: Target, job_id: str, platform: str) -> dict[str, Any] | None:
    def stop(kind: str) -> None:
        _safely(ctx, lambda _sc: end_job(deps, target, job_id, kind), f"failed-{platform}")

    try:
        checked = ctx.step(
            lambda _sc: validate_step(deps, target, job_id), name=f"validate-{platform}", config=retrying()
        )
    except StepError as e:  # nothing was sent: the check itself could not run
        log("warning", "story_flow.validate_failed", platform=platform, error=error_message(e))
        stop("not_started")
        return None
    if checked.get("state") != "ok":
        return None
    publisher = deps.publishers(platform)
    max_checks = int(deps.config.platform(platform).publish_settings.get("maxChecks", 20))
    start_semantics = _semantics(publisher.start_semantics)
    finish_semantics = _semantics(publisher.finish_semantics)
    failed = False

    def run(name: str, phase: str, semantics: StepSemantics) -> dict[str, Any] | None:
        nonlocal failed
        try:
            result: dict[str, Any] = ctx.step(
                lambda _sc: publish_step(deps, target, job_id, phase),
                name=name,
                config=retrying(RetryablePublishError, TransientError, semantics=semantics),
            )
        except StepError as e:
            kind = failure_kind(e, at_most_once=semantics == StepSemantics.AT_MOST_ONCE_PER_RETRY)
            log("warning", "story_flow.publish_failed", platform=platform, step=name)
            failed = True
            stop(kind)
            return None
        return result

    progress = run(f"publish-{platform}", "start", start_semantics)
    checks = 0
    finished = False
    anyway = False
    while progress is not None and progress.get("state") in ACTIVE:
        if progress["state"] == "ready_to_finish" and not finished:
            finished = True
            progress = run(f"finish-{platform}", "finish", finish_semantics)
            continue
        checks += 1
        if checks > max_checks:
            if platform in POSTED_ANYWAY:
                anyway = True
                break
            stop("too_slow")
            return None
        wait = max(1, int(progress.get("checkAfter") or 30))
        ctx.wait(Duration.from_seconds(wait), name=f"wait-{platform}-{checks}")
        progress = run(f"check-{platform}-{checks}", "check", StepSemantics.AT_LEAST_ONCE_PER_RETRY)
    # "posted": a replayed step found its own earlier work done (the posted write landed, its checkpoint did not).
    if failed or progress is None or (progress.get("state") not in ("done", "posted") and not anyway):
        return None
    try:
        done: dict[str, Any] = ctx.step(
            lambda _sc: posted_step(deps, target, job_id, anyway=anyway), name=f"posted-{platform}", config=retrying()
        )
    except StepError as e:  # the platform has the video (or is finishing it): never a silent Try again
        log("error", "story_flow.posted_failed", platform=platform, error=error_message(e))
        stop("unsure")
        return None
    if done.get("state") != "posted":
        return None
    return done


def validate_step(deps: StoryFlowDeps, target: Target, job_id: str) -> dict[str, str]:
    """The early stop: the same check every platform step runs again inside its own body."""
    job = _job(deps, target, job_id)
    if job is None:
        return {"state": "missing"}
    if job.get("publishingStatus") not in IN_FLIGHT:
        return {"state": str(job.get("publishingStatus"))}
    if not _mine(job, target):
        return {"state": "other_run"}
    try:
        _guard(lambda: _check(deps, target, job))
    except DestinationProblem as e:
        end_job(deps, target, job_id, e.kind)
        return {"state": "stopped"}
    return {"state": "ok"}


def _check(deps: StoryFlowDeps, target: Target, job: Mapping[str, Any]) -> Any:
    return validate_destination(deps.store, deps.secrets, target.user_id, target.workspace_id, job, now=deps.clock())


def clip_of(story: Mapping[str, Any]) -> Item:
    """What the publishers read as the "clip" (§45.14): the post captions, the real length, the title."""
    captions = story.get("postCaptions")
    return {
        "captions": dict(captions) if isinstance(captions, Mapping) else {},
        "durationSec": story.get("actualDurationSec"),
        "hook": str(story.get("title") or ""),
    }


def _save_handle(deps: StoryFlowDeps, target: Target, job_id: str) -> Callable[[dict[str, Any]], None]:
    def save(handle: dict[str, Any]) -> None:
        with contextlib.suppress(db.ConditionFailed):
            _guard(
                lambda: deps.store.update(
                    target.pk,
                    pubjob_sk(job_id),
                    {"publishHandle": handle},
                    expect_in={"publishingStatus": list(IN_FLIGHT), "flowRun": [target.run]},
                )
            )

    return save


def publish_step(deps: StoryFlowDeps, target: Target, job_id: str, phase: str) -> dict[str, Any]:
    """One publishing step. Reads the job first, checks the destination inside this very step, then calls the
    platform once. A job that is no longer this run's, queued or publishing is never touched again."""
    job = _job(deps, target, job_id)
    if job is None:
        return {"state": "missing"}
    if job.get("publishingStatus") not in IN_FLIGHT:
        return {"state": str(job.get("publishingStatus"))}
    if not _mine(job, target):
        return {"state": "other_run"}
    platform = str(job["platform"])
    tokens = deps.tokens(target)
    try:
        destination = _guard(lambda: _check(deps, target, job))
        if job.get("publishingStatus") == "queued":
            try:
                _guard(
                    lambda: deps.store.update(
                        target.pk,
                        pubjob_sk(job_id),
                        {"publishingStatus": "publishing", "updatedAt": iso(deps.clock())},
                        expect_in={"publishingStatus": ["queued"], "flowRun": [target.run]},
                    )
                )
            except db.ConditionFailed:  # changed since it was read: send only if it is still this run's
                current = _job(deps, target, job_id) or {}
                if current.get("publishingStatus") not in IN_FLIGHT or not _mine(current, target):
                    return {"state": str(current.get("publishingStatus") or "missing")}
        ai_label = job.get("aiLabel") is True or _guard(
            lambda: ws_publish.realistic_video(deps.store, target.user_id, target.workspace_id, target.story_id)
        )
        publisher = ws_publish.publisher(platform, ai_label=ai_label, default=deps.publishers)
        creds = None
        if publisher.needs_credentials:
            creds = _guard(lambda: tokens.credentials(platform))
            if str(creds.data.get(ws.SECRET_IDENTITY[platform]) or "") != destination.external_account_id:
                raise DestinationProblem(4, "changed", story_sentence(platform, "changed", destination.account_name))
        video = deps.video(destination.story) if deps.video is not None and publisher.needs_credentials else None
        publish_job = PublishJob(
            post=job,
            clip=clip_of(destination.story),
            account={"accountId": destination.external_account_id},
            creds=creds,
            video=video,  # type: ignore[arg-type]
            options=flow_options(platform, job.get("postOptions")),
            settings={},  # Lamo Clips' settings and preset never apply to Lamo Stories posts
            http=deps.http,
            config=deps.config.platform(platform).publish_settings,
            save=_save_handle(deps, target, job_id),
            now=deps.clock,
            graph_api_version=deps.graph_api_version,
        )
        progress = _advance(deps, publisher, publish_job, phase, destination)
    except DestinationProblem as e:
        end_job(deps, target, job_id, e.kind)
        return {"state": "stopped"}
    except NotConnectedError:
        end_job(deps, target, job_id, "not_connected")
        return {"state": "stopped"}
    except XCapReached:
        end_job(deps, target, job_id, "x_cap")
        return {"state": "stopped"}
    except AiLabelMissing:
        end_job(deps, target, job_id, "ai_label")
        return {"state": "stopped"}
    except ReconnectNeededError:
        tokens.mark_dead(platform)
        end_job(deps, target, job_id, "reconnect")
        return {"state": "stopped"}
    except RetryablePublishError:
        raise  # the step's retry strategy tries again; out of tries → failed-{platform}
    except platform_errors.PlatformProblem as e:
        end_job(deps, target, job_id, e.problem.kind)
        return {"state": "failed"}
    except PublishError as e:
        end_job(deps, target, job_id, kind_of_message(str(e)))
        return {"state": "failed"}
    if progress.state != "done" or progress.published is None:
        return progress.to_json()
    return _mark_posted(deps, target, job, progress)


def rates(deps: StoryFlowDeps, destination: Destination) -> tuple[db.Store, config.PlatformsConfig]:
    """The rate counters and budget configuration of the destination's developer app: Clip Factory's shared ones
    with its app (on purpose, the owner's choice), Lamo Stories' own with its own app (§45.30)."""
    choice = destination.app.choice
    workspace_id = str(destination.workspace.get("workspaceId") or "")
    store = apps.rate_store(deps.store, choice, workspace_id, destination.platform)
    return store, apps.rates_config(deps.config, choice, destination.workspace)


def _advance(deps: StoryFlowDeps, publisher: Any, job: PublishJob, phase: str, destination: Destination) -> Progress:
    handle = job.handle
    first_x = phase == "start" and job.post.get("platform") == "x" and publisher.needs_credentials and not handle
    if first_x:
        store, cfg = rates(deps, destination)
        if not _guard(lambda: budget.charge_post(store, deps.clock(), cfg=cfg)):
            raise XCapReached(story_sentence("x", "x_cap", shared=destination.app.shared))
    result: Progress
    if phase == "start":
        result = publisher.start(job)
    elif phase == "finish":
        result = publisher.finish(job, handle)
    else:
        result = publisher.check(job, handle)
    return result


def _mark_posted(deps: StoryFlowDeps, target: Target, job: Item, progress: Progress) -> dict[str, Any]:
    published = progress.published
    if published is None:
        return progress.to_json()
    fields: Item = {
        "publishingStatus": "posted",
        "url": published.url,
        "postedAt": published.posted_at or iso(deps.clock()),
        "privacy": published.privacy,
        "updatedAt": iso(deps.clock()),
    }
    if published.platform_post_id:
        fields["platformPostId"] = str(published.platform_post_id)
    if published.stats_id:
        fields["statsId"] = str(published.stats_id)
    try:
        _guard(
            lambda: deps.store.update(
                target.pk,
                pubjob_sk(str(job["publishingJobId"])),
                fields,
                remove=["error"],
                expect_in={"publishingStatus": list(IN_FLIGHT), "flowRun": [target.run]},
            )
        )
    except db.ConditionFailed:
        current = _job(deps, target, str(job["publishingJobId"])) or {}
        return {"state": str(current.get("publishingStatus"))}
    log("info", "story_flow.posted", platform=job.get("platform"), storyId=target.story_id)
    return {"state": "done"}


def posted_step(deps: StoryFlowDeps, target: Target, job_id: str, *, anyway: bool) -> dict[str, Any]:
    """The job is ``posted``: the story gets it (``posted`` append, ``publishedAt`` if absent, ``status`` →
    ``published`` only from ``approved`` or ``published``) and an ``ACT#`` "posted" item. ``anyway``: YouTube or
    TikTok took longer than our checks; they finish on their own, so the post counts as posted."""
    job = _job(deps, target, job_id)
    if job is None:
        return {"state": "missing"}
    platform = str(job.get("platform") or "")
    if anyway and job.get("publishingStatus") in IN_FLIGHT and _mine(job, target):
        publisher = deps.publishers(platform)
        handle = dict(job.get("publishHandle") or {})
        minimal = PublishJob(
            post=job,
            clip={},
            account={},
            creds=None,
            video=None,  # type: ignore[arg-type]
            options={},
            settings={},
            http=deps.http,
            now=deps.clock,
        )
        progress = Progress("done", handle, published=publisher.published(minimal, handle))
        _mark_posted(deps, target, job, progress)
        job = _job(deps, target, job_id) or job
    if job.get("publishingStatus") != "posted":
        return {"state": str(job.get("publishingStatus"))}
    now = deps.clock()
    url = str(job.get("url") or "")
    posted_at = str(job.get("postedAt") or iso(now))
    title = _story_posted(deps, target, platform, url, posted_at)
    _guard(lambda: deps.store.put(_activity(target, job, "posted", at=posted_at, title=title, now=now)))
    needs_id = platform == "tiktok" and job.get("privacy") != "private" and not job.get("statsId")
    return {
        "state": "posted",
        "publishingJobId": job_id,
        "platform": platform,
        "postedAt": posted_at,
        "at": iso(now),
        "needsId": needs_id,
    }


def _story_posted(deps: StoryFlowDeps, target: Target, platform: str, url: str, posted_at: str) -> str:
    """One conditional UpdateItem on the story (only its own attributes, ``version`` + 1, ``updatedAt``),
    compare-and-swap on ``version``; a replay finds the post there already and adds nothing. The story's title."""
    for _ in range(5):
        story = _story(deps, target)
        if story is None:
            return ""
        title = str(story.get("title") or "")
        current = [dict(p) for p in story.get("posted") or [] if isinstance(p, Mapping)]
        entry = {"platform": platform, "url": url}
        status = story.get("status")
        promote = status in ("approved", "published") and status != "published"
        if entry in current and story.get("publishedAt") and not promote:
            return title
        sets: Item = {"posted": current if entry in current else [*current, entry], "updatedAt": iso(deps.clock())}
        if not story.get("publishedAt"):
            sets["publishedAt"] = posted_at
        if status in ("approved", "published"):
            sets["status"] = "published"
        names = {f"#f{i}": k for i, k in enumerate(sets)}
        values: Item = {f":f{i}": v for i, v in enumerate(sets.values())}
        names["#v"] = "version"
        values[":one"] = 1
        values[":zero"] = 0
        expression = "SET " + ", ".join(f"#f{i} = :f{i}" for i in range(len(sets)))
        expression += ", #v = if_not_exists(#v, :zero) + :one"
        version = story.get("version")
        if isinstance(version, int) and not isinstance(version, bool):
            condition = "attribute_exists(pk) AND #v = :ver"
            values[":ver"] = version
        else:
            condition = "attribute_exists(pk) AND attribute_not_exists(#v)"
        try:
            _update_story(deps, target, expression, condition=condition, names=names, values=values)
        except db.ConditionFailed:
            continue  # someone else wrote the story a moment ago: read it again
        return title
    log("warning", "story_flow.story_contended", storyId=target.story_id)
    return ""


def _update_story(
    deps: StoryFlowDeps, target: Target, expression: str, *, condition: str, names: dict[str, str], values: Item
) -> None:
    _guard(
        lambda: deps.store.update_expr(
            target.pk, story_sk(target.story_id), expression, condition=condition, names=names, values=values
        )
    )


def _tiktok_id(ctx: Any, deps: StoryFlowDeps, target: Target, job_id: str, last: datetime | None) -> datetime | None:
    """The public TikTok post's id (for its numbers), every ``idCheckMinutes`` up to ``idMaxChecks`` times. The
    time the last of its steps reported (or ``last`` plus the waits), for the numbers' waits."""
    settings_ = deps.config.platform("tiktok").publish_settings
    every = int(settings_.get("idCheckMinutes", 10))
    for n in range(1, int(settings_.get("idMaxChecks", 12)) + 1):
        ctx.wait(Duration.from_minutes(every), name=f"wait-tiktok-id-{n}")
        waited = last + timedelta(minutes=every) if last is not None else None
        try:
            found = ctx.step(lambda _sc: tiktok_id_step(deps, target, job_id), name=f"tiktok-id-{n}", config=retrying())
        except StepError:
            return waited  # the post is live either way; it just has no numbers
        last = parse(found.get("at")) or waited
        if found.get("statsId") or found.get("state") != "waiting":
            break
    return last


def tiktok_id_step(deps: StoryFlowDeps, target: Target, job_id: str) -> dict[str, Any]:
    at = iso(deps.clock())
    job = _job(deps, target, job_id)
    if job is None or job.get("publishingStatus") != "posted":
        return {"state": "gone", "at": at}
    if job.get("statsId"):
        return {"state": "done", "statsId": job["statsId"], "at": at}
    try:
        destination = _guard(lambda: _check(deps, target, job))
        creds = _guard(lambda: deps.tokens(target).credentials("tiktok"))
    except (DestinationProblem, NotConnectedError, PublishError):
        return {"state": "gone", "at": at}
    publish_job = PublishJob(
        post=job,
        clip={},
        account={"accountId": destination.external_account_id},
        creds=creds,
        video=None,  # type: ignore[arg-type]
        options={},
        settings={},
        http=deps.http,
        now=deps.clock,
    )
    found = deps.publishers("tiktok").public_id(publish_job, publish_job.handle)
    if not found:
        return {"state": "waiting", "at": at}
    username = str(publish_job.handle.get("username") or "")
    fields: Item = {"statsId": str(found), "updatedAt": iso(deps.clock())}
    if username:
        fields["url"] = f"https://www.tiktok.com/@{username}/video/{found}"
    with contextlib.suppress(db.ConditionFailed):
        _guard(
            lambda: deps.store.update(
                target.pk,
                pubjob_sk(job_id),
                fields,
                expect_in={"publishingStatus": ["posted"]},
                expect_absent=["statsId"],
            )
        )
    return {"state": "done", "statsId": str(found), "at": at}


# --- numbers at 1 h, 24 h, 72 h and 7 days (§45.14) ---------------------------------------------------------------


def numbers_plan(posted: Sequence[Mapping[str, Any]]) -> list[tuple[str, int, datetime, list[str]]]:
    """``(step name, k, due, job ids)`` in time order: each post's k-th read is due ``NUMBERS_AT[k-1]`` after its
    own ``postedAt``; posts due within ``NUMBERS_SLACK`` of the first in a group are read together, when the last of
    them is due (so none is read early). The first group of checkpoint k is ``numbers-{k}``, the next
    ``numbers-{k}-2`` and so on."""
    bases: list[tuple[datetime, str]] = []
    for p in posted:
        base = parse(p.get("postedAt")) or parse(p.get("at"))
        if base is not None:
            bases.append((base, str(p["publishingJobId"])))
    plan: list[tuple[str, int, datetime, list[str]]] = []
    for k, offset in enumerate(NUMBERS_AT, start=1):
        groups: list[tuple[datetime, datetime, list[str]]] = []  # (first due, last due, ids)
        for due, job_id in sorted((base + offset, job_id) for base, job_id in bases):
            if groups and due - groups[-1][0] <= NUMBERS_SLACK:
                first, _, ids = groups[-1]
                groups[-1] = (first, due, [*ids, job_id])
            else:
                groups.append((due, due, [job_id]))
        for i, (_, due, ids) in enumerate(groups, start=1):
            plan.append((f"numbers-{k}" if i == 1 else f"numbers-{k}-{i}", k, due, ids))
    return sorted(plan, key=lambda row: row[2])


def _numbers(ctx: Any, deps: StoryFlowDeps, target: Target, posted: list[dict[str, Any]], last: datetime) -> None:
    for name, k, due, ids in numbers_plan(posted):
        delay = max(1, int((due - last).total_seconds()))
        ctx.wait(Duration.from_seconds(delay), name=f"wait-{name}")
        try:
            result = ctx.step(
                lambda _sc, k=k, ids=ids: numbers_step(deps, target, ids, k), name=name, config=retrying()
            )
            last = parse(result.get("at")) or due
        except StepError as e:  # numbers are a bonus: the posts are live either way
            log("error", "story_flow.numbers_failed", storyId=target.story_id, k=k, error=error_message(e))
            last = max(last, due)


def numbers_cost(platform: str, chunk: list[Item], cfg: config.PlatformsConfig, now: datetime) -> int:
    """The budget cost of one stats request, as ``stats.refresh`` computes it (X: one request per age group;
    YouTube: ``unitsPerCall`` per ``idsPerRequest`` ids; the others one request)."""
    if platform == "x":
        limit = cfg.platform("x").non_public_max_age_days or 30
        ages = {(now - (parse(p.get("postedAt")) or now)) >= timedelta(days=limit) for p in chunk}
        return len(ages)
    p = cfg.platform(platform)
    if p.budget_kind == "daily_units":
        ids = sum(1 for post in chunk if stats_id(post))
        return int(p.budget["unitsPerCall"]) * math.ceil(ids / p.ids_per_request)
    return 1


def numbers_step(deps: StoryFlowDeps, target: Target, job_ids: list[str], k: int) -> dict[str, Any]:
    now = deps.clock()
    read = 0
    for job_id in job_ids:
        job = _job(deps, target, job_id)
        if job is None or job.get("publishingStatus") != "posted" or job.get("privacy") == "private":
            continue
        if not job.get("statsId"):
            continue
        platform = str(job.get("platform") or "")
        try:
            destination = _validate(deps, target, job)
        except DestinationProblem as e:
            log("warning", "story_flow.numbers_skipped", platform=platform, kind=e.kind)
            continue  # never read with another account's token; the post keeps its last numbers
        store, _cfg = rates(deps, destination)
        if budget.blocked_until(_budget(store, platform), now) is not None:
            log("info", "story_flow.numbers_blocked", platform=platform, k=k)
            continue  # a blocked read waits for the next checkpoint
        if _read_numbers(deps, target, job, destination, now=now):
            read += 1
    return {"at": iso(now), "read": read}


def _budget(store: db.Store, platform: str) -> Item:
    found: Item = _guard(lambda: budget.get_budget(store, platform))
    return found


def _validate(deps: StoryFlowDeps, target: Target, job: Mapping[str, Any]) -> Any:
    return _guard(lambda: _check(deps, target, job))


def _read_numbers(deps: StoryFlowDeps, target: Target, job: Item, destination: Destination, *, now: datetime) -> bool:
    job_id = str(job["publishingJobId"])
    platform = str(job["platform"])
    identity = destination.external_account_id
    store, cfg = rates(deps, destination)
    row: Item = {
        "postId": job_id,
        "platform": platform,
        "statsId": job.get("statsId"),
        "platformPostId": job.get("platformPostId"),
        "postedAt": job.get("postedAt"),
    }
    tokens = deps.tokens(target)
    adapter = deps.adapters(platform, tokens, deps.graph_api_version)
    cost = numbers_cost(platform, [row], cfg, now)
    reservation = _guard(lambda: budget.reserve(store, platform, cost, now, ids=[str(job["statsId"])], cfg=cfg))
    if isinstance(reservation, budget.Blocked):
        return False
    account = {"accountId": identity, "platformUserId": identity}
    try:
        batch = adapter.fetch_stats([row], account, now=now, want_insights=True, http=deps.http)
    except (NotConnectedError, PublishError, NetworkError) as e:
        log("warning", "story_flow.numbers_unread", platform=platform, error=type(e).__name__)
        return False
    if platform in META and batch.meta.error_code == "190":
        tokens.mark_dead(platform)  # a dead Meta token: Lamo Stories' Connections shows Connect again
        return False
    _guard(lambda: budget.record(store, platform, batch.meta, now, cfg=cfg))
    fast, slow = batch.results.get(job_id), batch.insights.get(job_id)
    if fast is None and slow is None:
        return False
    old = job.get("metrics") if isinstance(job.get("metrics"), Mapping) else {}
    metrics: Item = {key: (old or {}).get(key) for key in COMMON}
    for part in (fast, slow):
        for key in COMMON:
            if part is not None and key in part:
                metrics[key] = part[key]
    metrics["checkedAt"] = iso(now)
    at = [str(a) for a in job.get("numbersAt") or [] if a]
    with contextlib.suppress(db.ConditionFailed):
        _guard(
            lambda: deps.store.update(
                target.pk,
                pubjob_sk(job_id),
                {"metrics": metrics, "numbersAt": [*at, iso(now)], "updatedAt": iso(now)},
                expect_in={"publishingStatus": ["posted"]},
            )
        )
    return True


# --- Lambda entry point ---------------------------------------------------------------------------------------------

_deps: StoryFlowDeps | None = None


def _from_env() -> StoryFlowDeps:
    import boto3
    from botocore.config import Config

    from .. import s3
    from ..app import region, table
    from ..oauth.secrets import PREFIX, Secrets
    from ..platforms.video import S3Video

    env = os.environ
    reg = region()
    store = db.Store(table(env["TABLE_NAME"]))
    cfg = config.load()
    client = boto3.client(
        "secretsmanager",
        region_name=reg,
        config=Config(retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=5),
    )
    app_prefix = env.get("SECRET_PREFIX") or PREFIX  # for Lamo Clips' app keys only (read)
    secrets = WorkspaceSecrets(client, env.get("WS_SECRET_PREFIX") or ws.WS_SECRET_PREFIX, app_prefix=app_prefix)

    def no_state_key() -> bytes:
        raise RuntimeError("the state key is only read by the API and the callback")

    oauth = OAuthEnv(
        secrets=Secrets(client, app_prefix),
        app_url="",
        hooks_url="",
        state_key=no_state_key,
        graph_version=cfg.graph_api_version,
    )
    media_client = s3.make_client(reg)
    bucket = env["MEDIA_BUCKET"]

    def video(story: Item) -> S3Video:
        return S3Video(media_client, bucket, str(story["videoKey"]))

    return StoryFlowDeps(
        store=store,
        oauth=oauth,
        secrets=secrets,
        publishers=publisher_for,
        video=video,
        graph_api_version=cfg.graph_api_version,
        cfg=cfg,
    )


def get_deps(factory: Callable[[], StoryFlowDeps] = _from_env) -> StoryFlowDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


@durable_execution
def handler(event: Any, context: DurableContext) -> dict[str, Any]:
    return run_story_flow(context, event, get_deps())
