"""One production job of Lamo Stories, step by step (docs/CONTRACTS.md §45.9, §45.11, §45.25; ADR-71, ADR-74, ADR-75,
ADR-77).

A job runs exactly the steps in its ``configuration.run``, in step order: ``storyboard`` (the storyboard agent writes
the script, then the six post captions), ``safety`` (the quality agent's fact check), ``scenes`` (middle-frame
stills), ``animation`` (every scene's MP4), ``sound``, ``captions``, ``assemble`` and ``preview`` (the quality
agent's last look at the finished video). Every model call goes through ``models.complete`` with the owner's model
and effort for that task (the job's override, the story's own setting, the task's, the agent's, the workspace
default), never another model; each one is recorded in ``meta.models``. Only what changed is made again: a scene is
drawn and animated again only when its own content (its beats, its cast's looks, its seed, the engine version)
differs from the files already made for it, or when the job names it (``sceneIds``). Every finished step's files
stay, so "Try again" after a stop picks up at the first unfinished step.

Writes follow §45.9.1's agent column: the job's steps, progress, heartbeat, status, error and meta; the story's
``scriptVersion``, ``scriptKey``, ``postCaptions``, ``scenes``, ``stillKeys``, ``safety``, ``videoKey``, ``coverKey``,
``actualDurationSec``, its ``stale`` (each finished step taken out; a failed step and the later ones of the run put
in), ``safetyTopicId`` (only when the writer flagged a story of another kind as teaching driving safety), and at the
end its ``status`` (``review``, ``needs_check`` or ``failed``) with ``currentJobId`` removed. Everything is fenced on
the job's session (data.py)."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import functools
import hashlib
import json
import shutil
import time
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from . import ass, images, keys, media, safety, writer
from .data import AssetPut, JobFence, StoryData
from .engine import Engine, find_engine_dir, frame_count, write_json
from .guidance import Guidance, Topic, load
from .models import (
    AgentOff,
    AnswerInvalid,
    CallContext,
    EffortUnavailable,
    ModelClient,
    ModelRefused,
    ModelUnavailable,
    Reply,
)
from .providers import (
    REGISTRY,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    chosen,
    has_actors,
    provider_item,
    render_still,
)
from .util import JobSuperseded, UserFacingError, log, now_iso, ulid

HEARTBEAT_SECONDS = 30.0  # the contract asks for at most 60
FLUSH_SECONDS = 5.0
SCENES_AT_ONCE = 2
CALLS = {"writer": 3, "captions": 2, "checker": 2, "review": 1}  # the runaway guard (§45.11.3), per job
MAX_FINAL_SECONDS = 89.5
REVIEW_FRAMES = 8
HELD_TOPIC = (
    "This story gives driving advice. Pick a checked topic for it, or take the advice out, then tap Check again."
)
QUALITY_OFF = "Quality check is off"
STORY_KINDS = ("storyboard", "scene_still", "scene_clip", "audio", "captions", "final_video", "cover")
MODEL_POOL = ThreadPoolExecutor(8, thread_name_prefix="ls-model")  # model calls never wait behind the heartbeat


class StoryFailed(UserFacingError):
    """A step failed with a sentence for the owner."""


@dataclass
class Done:
    """A step's end: its short note for the step track, and whether it had nothing to do (``skipped``)."""

    message: str | None = None
    skipped: bool = False


@dataclass
class Services:
    """What every job uses; built once per container (services.build), fakes in tests."""

    data: StoryData
    work_root: Path
    models: ModelClient
    engine_dir: Path | None = None
    config_dir: Path | None = None
    image_model_id: str = ""
    image_client: Callable[[], Any] | None = None
    video_bucket: str = ""
    video_model_id: str = ""
    reel_client: Callable[[], Any] | None = None
    us_s3: Callable[[], Any] | None = None
    registry: dict[str, dict[str, type[Any]]] = field(default_factory=lambda: REGISTRY)
    heartbeat_seconds: float = HEARTBEAT_SECONDS
    flush_seconds: float = FLUSH_SECONDS
    scenes_at_once: int = SCENES_AT_ONCE
    model_pool: ThreadPoolExecutor = MODEL_POOL
    reel_sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    _guidance: Guidance | None = field(default=None, init=False, repr=False)

    @property
    def guidance(self) -> Guidance:
        if self._guidance is None:
            from . import config

            self._guidance = load(self.config_dir or config.config_dir())
        return self._guidance

    def engine(self, work: Path) -> Engine:
        return Engine(find_engine_dir(self.engine_dir), work / ".deno")


@dataclass
class Budget:
    left: dict[str, int] = field(default_factory=lambda: dict(CALLS))

    def take(self, kind: str) -> bool:
        if self.left.get(kind, 0) <= 0:
            log("warn", "stories.budget_used", kind=kind)
            return False
        self.left[kind] -= 1
        return True

    def has(self, kind: str) -> bool:
        return self.left.get(kind, 0) > 0


def scene_hash(script: dict[str, Any], scene: dict[str, Any]) -> str:
    """What a scene's pictures depend on: the scene itself, its cast's looks and styles, the engine and the frame."""
    names = {a.get("castId") for a in scene.get("actors") or []} | {b.get("who") for b in scene.get("beats") or []}
    cast = {k: v for k, v in (script.get("cast") or {}).items() if k in names}
    body = {
        "engine": script.get("engine"),
        "size": [script.get("width"), script.get("height"), script.get("fps")],
        "seed": scene.get("seed", script.get("seed")),
        "scene": scene,
        "cast": cast,
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:24]


def ordered(steps: Sequence[str]) -> list[str]:
    return [s for s in keys.STEP_ORDER if s in set(steps)]


def topic_sentence(guidance: Guidance) -> str:
    titles = guidance.titles()
    return keys.NO_TOPIC + (" Checked topics: " + "; ".join(titles) + "." if titles else "")


def owner_refs(story: dict[str, Any]) -> set[str]:
    """The texts the owner edited himself (the API's ``ownerEdits``), as the checker's refs: they are never
    rewritten (§45.11.5)."""
    raw = story.get("ownerEdits")
    edits: dict[str, Any] = raw if isinstance(raw, dict) else {}
    out = {f"caption:{c}" for c in edits.get("captions") or []}
    out |= {f"scene:{s}" for s in edits.get("sceneCaptions") or []}
    out |= {f"post:{f}" for f in edits.get("postCaptions") or []}
    return out


def _int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


class Job:
    """What story, portrait and reference jobs share: the fence, the steps, the heartbeat, the model calls and the
    last write. Subclasses give ``step_keys``, ``labels`` and ``_run``."""

    step_keys: ClassVar[tuple[str, ...]] = keys.STEP_ORDER
    labels: ClassVar[dict[str, str]] = keys.STEP_LABELS
    content_types: ClassVar[tuple[str, ...]] = ("animation",)

    def __init__(self, svc: Services, fence: JobFence, content_id: str) -> None:
        self.svc = svc
        self.data = svc.data
        self.fence = fence
        self.content_id = content_id
        self.work = svc.work_root / fence.job_id
        self.engine = svc.engine(self.work)
        self.budget = Budget()
        self.job: dict[str, Any] = {}
        self.workspace: dict[str, Any] = {}
        self.config: dict[str, Any] = {}
        self.steps: list[dict[str, Any]] = []
        self.meta: dict[str, Any] = {}
        self.run_steps: list[str] = []
        self.todo: list[str] = []
        self._last_flush = 0.0
        self._dirty = False
        self._fraction: tuple[int, int] | None = None
        self.current: str | None = None
        self._fenced = False
        self._job_lock = asyncio.Lock()
        self._closed = False
        self._proven: set[tuple[str, str]] = set()

    # --- the run ------------------------------------------------------------------------------------------------

    async def run(self) -> str:
        """Runs the job to its end; returns the status it ended with, or ``superseded`` / ``ignored``."""
        job = await self.data.job(self.fence.user_id, self.fence.workspace_id, self.fence.job_id)
        if not job:
            log("warn", "stories.job_missing", job=self.fence.job_id)
            return "ignored"
        if job.get("sessionId") != self.fence.session_id:
            log("info", "stories.superseded", job=self.fence.job_id, session=self.fence.session_id)
            return "superseded"
        if job.get("status") not in ("queued", "running") or job.get("contentId") != self.content_id:
            log("info", "stories.job_settled", job=self.fence.job_id, status=job.get("status"))
            return "ignored"
        self.job = job
        self.steps = [dict(s) for s in job.get("steps") or [] if isinstance(s, dict)]
        conf = job.get("configuration") or {}
        wanted = set(conf.get("run") or [s.get("key") for s in self.steps if s.get("status") == "pending"])
        order = self.order(job)
        self.run_steps = [k for k in order if k in wanted]
        for key in self.run_steps:
            if not any(s.get("key") == key for s in self.steps):
                self.steps.append({"key": key, "label": self.labels.get(key, key), "status": "pending"})
        self.steps.sort(key=lambda s: order.index(s["key"]) if s.get("key") in order else len(order))
        self.meta = dict(job.get("meta") or {})
        self.meta.setdefault("models", [])
        if job.get("status") == "running":  # the same run again after a restart: finished steps stay finished
            finished = {s.get("key") for s in self.steps if s.get("status") in ("done", "skipped")}
            self.todo = [k for k in self.run_steps if k not in finished]
        else:
            self.todo = list(self.run_steps)
        main = asyncio.current_task()
        ticker = asyncio.create_task(self._heartbeat(main), name=f"story-beat-{self.fence.job_id}")
        try:
            return await self._run()
        except JobSuperseded:
            log("info", "stories.run_fenced", job=self.fence.job_id)
            return "superseded"
        except asyncio.CancelledError:
            if not self._fenced:
                raise  # a cancel, or the container stopping
            if main is not None:
                main.uncancel()
            log("info", "stories.run_fenced", job=self.fence.job_id)
            return "superseded"
        finally:
            ticker.cancel()
            with contextlib.suppress(BaseException):
                await ticker

    def order(self, job: dict[str, Any]) -> tuple[str, ...]:
        """The job's step keys in order (a story's eight, a portrait's one; a reference job takes the API's)."""
        return self.step_keys

    async def _run(self) -> str:
        raise NotImplementedError

    async def _start_running(self) -> None:
        await self.data.update_job(
            self.fence,
            {"status": "running", "heartbeatAt": now_iso(), "steps": self.steps, "progress": self._progress()},
        )

    def sentence(self, key: str, e: BaseException) -> str:
        """What the owner reads when a step fails: the step in plain words and the button, never a tool's output."""
        if isinstance(e, ModelUnavailable | EffortUnavailable | AgentOff | ModelRefused):
            return str(e)
        if isinstance(e, ProviderUnavailable):
            return str(e)
        if isinstance(e, ProviderFailed):
            return e.sentence
        if isinstance(e, UserFacingError):
            return str(e)
        if isinstance(e, AnswerInvalid) and key == "storyboard":
            return keys.WRITER_FAILED
        return keys.FAILED.get(key, "This step did not finish. Tap Try again.")

    # --- steps and progress -------------------------------------------------------------------------------------

    def _step(self, key: str) -> dict[str, Any]:
        return next(s for s in self.steps if s.get("key") == key)

    def _start(self, key: str) -> None:
        self.current = key
        self._fraction = None
        step = self._step(key)
        step.update({"status": "running", "startedAt": now_iso()})
        for k in ("message", "finishedAt", "i", "n"):
            step.pop(k, None)

    def _progress(self) -> float:
        if not self.steps:
            return 0.0
        done = sum(1 for s in self.steps if s.get("status") in ("done", "skipped"))
        part = 0.0
        if self._fraction and self._fraction[1] > 0:
            part = min(1.0, self._fraction[0] / self._fraction[1])
        return round(min(0.99, (done + part) / len(self.steps)), 4)

    def report(self, i: int, n: int) -> None:
        """A running step's own progress (``i`` of ``n``); written at most every FLUSH_SECONDS."""
        self._fraction = (i, n)
        if self.current:
            self._step(self.current).update({"i": i, "n": n})
        self._dirty = True

    async def _flush(self, *, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and (not self._dirty or now - self._last_flush < self.svc.flush_seconds):
            return False
        self._dirty = False
        self._last_flush = now
        fields = {"steps": self.steps, "progress": self._progress(), "meta": self.meta, "heartbeatAt": now_iso()}
        return await self._job_write(fields)

    async def _job_write(self, fields: dict[str, Any]) -> bool:
        async with self._job_lock:
            if self._closed:
                return False
            await self.data.update_job(self.fence, fields)
            return True

    async def _heartbeat(self, main: asyncio.Task[Any] | None) -> None:
        """``heartbeatAt`` every HEARTBEAT_SECONDS (and the step's progress), from the event loop; the heavy work runs
        in processes and threads, so this stays honest. A refused write stops the run."""
        beat_at = time.monotonic()
        while True:
            await asyncio.sleep(min(self.svc.flush_seconds, self.svc.heartbeat_seconds))
            try:
                if self._dirty and await self._flush():
                    beat_at = time.monotonic()
                elif time.monotonic() - beat_at >= self.svc.heartbeat_seconds:
                    await self._job_write({"heartbeatAt": now_iso()})
                    beat_at = time.monotonic()
            except JobSuperseded:
                log("info", "stories.beat_fenced", job=self.fence.job_id)
                self._fenced = True
                if main is not None:
                    main.cancel()
                return
            except Exception as e:
                log("warn", "stories.beat_failed", job=self.fence.job_id, error=type(e).__name__)

    async def _finish_step(self, key: str, message: str | None, *, skipped: bool = False) -> None:
        step = self._step(key)
        step.update({"status": "skipped" if skipped else "done", "finishedAt": now_iso()})
        if message:
            step["message"] = message
        self._fraction = None
        self.current = None
        await self._flush(force=True)

    async def _last_write(self, **kwargs: Any) -> None:
        """The run's last job write (with the content's end, in one transaction); no heartbeat comes after it."""
        async with self._job_lock:
            self._closed = True
            await self.data.write(self.fence, **kwargs)

    # --- model calls ----------------------------------------------------------------------------------------------

    def call_context(self, agent_id: str) -> CallContext:
        return CallContext(
            user_id=self.fence.user_id,
            workspace_id=self.fence.workspace_id,
            agent_id=agent_id,
            session_id=self.fence.session_id,
            job_id=self.fence.job_id,
        )

    async def ask(
        self,
        *,
        step: str,
        agent_id: str,
        task: str,
        messages: list[dict[str, Any]],
        schema: dict[str, Any] | None = None,
        max_tokens: int = 16000,
        allow_inactive: bool = False,
    ) -> Reply:
        """One model call for this job (§45.25): resolved, sent and recorded by ``models.complete`` in a worker
        thread; the effective model and effort go into ``meta.models``."""
        call = functools.partial(
            self.svc.models.complete,
            self.call_context(agent_id),
            task=task,
            messages=messages,
            schema=schema,
            max_tokens=max_tokens,
        )
        if allow_inactive:
            call = functools.partial(call, allow_inactive=True)
        loop = asyncio.get_running_loop()
        reply: Reply = await loop.run_in_executor(self.svc.model_pool, call)
        entry = {
            "step": step,
            "agentId": agent_id,
            "task": task,
            "model": reply.model,
            "effort": reply.effort,
            "effortApplied": reply.effort_applied,
        }
        used = self.meta.setdefault("models", [])
        if entry not in used:
            used.append(entry)
            self._dirty = True
        return reply

    async def prove(self, kind: str, provider_id: str, state: str = "on", last_error: str | None = None) -> None:
        """``PROVIDER#{kind}#{id}`` after a real call (§45.11.6): once per job and provider."""
        if (kind, provider_id) in self._proven and state == "on":
            return
        item = provider_item(
            self.fence.pk, self.fence.user_id, self.fence.workspace_id, kind, provider_id, state, now_iso(), last_error
        )
        await self.data.write(self.fence, puts=[item])
        if state == "on":
            self._proven.add((kind, provider_id))

    async def provider_usage(self, provider_id: str, model_id: str, **amounts: float | int) -> None:
        """A ``USAGE#`` item of kind ``provider`` (render seconds, Nova Reel seconds, Nova Canvas pictures, §45.33);
        priced only when a price is known (none is, today)."""
        at = now_iso()
        item: dict[str, Any] = {
            "pk": self.fence.pk,
            "sk": keys.usage_sk(at[:10], ulid()),
            "type": keys.TYPE_USAGE,
            "userId": self.fence.user_id,
            "workspaceId": self.fence.workspace_id,
            "kind": "provider",
            "day": at[:10],
            "at": at,
            "providerId": provider_id,
            "modelId": model_id,
            "jobId": self.fence.job_id,
            "cost": None,
            "currency": None,
            "ttl": int(time.time()) + keys.USAGE_DAYS * 86400,
            **{k: round(float(v), 3) for k, v in amounts.items()},
        }
        try:
            await self.data.write(self.fence, puts=[item])
        except JobSuperseded:
            raise
        except Exception as e:
            log("warn", "stories.usage_failed", job=self.fence.job_id, error=type(e).__name__)


class StoryJob(Job):
    """One run of one story job, in the session ``fence.session_id``."""

    def __init__(self, svc: Services, fence: JobFence, story_id: str) -> None:
        super().__init__(svc, fence, story_id)
        self.story_id = story_id
        self.story: dict[str, Any] = {}
        self.assets: list[dict[str, Any]] = []
        self.script: dict[str, Any] | None = None
        self.post: dict[str, str] | None = None
        self.writer_texts: dict[str, str] | None = None
        self.stale: list[str] = []
        self.held_for_topic = False
        self.characters: dict[str, dict[str, Any]] = {}

    async def _run(self) -> str:
        story = await self.data.story(self.fence.user_id, self.fence.workspace_id, self.story_id)
        ws = await self.data.workspace(self.fence.user_id, self.fence.workspace_id)
        if story and story.get("currentJobId") not in (None, self.fence.job_id):
            log("warn", "stories.not_current_job", job=self.fence.job_id, current=story.get("currentJobId"))
            return "superseded"
        await self._start_running()
        if not story or not ws or ws.get("workspaceType") != "stories":
            return await self._fail(self.todo[0] if self.todo else "storyboard", "This story no longer exists.")
        self.story, self.workspace = story, ws
        self.config = dict(ws.get("configuration") or {})
        self.stale = [s for s in story.get("stale") or [] if s in keys.STEP_ORDER]
        self.assets = await self.data.assets(self.fence.user_id, self.fence.workspace_id, story_id=self.story_id)
        self.meta.update(
            {
                "providers": chosen(self.config),
                "targetSec": float(story.get("durationSec") or 45),
                "safetyTopicId": story.get("safetyTopicId"),
            }
        )
        handlers: dict[str, Callable[[], Awaitable[Done | str | None]]] = {
            "storyboard": self.storyboard,
            "safety": self.check_facts,
            "scenes": self.draw_scenes,
            "animation": self.animate,
            "sound": self.sound,
            "captions": self.captions,
            "assemble": self.assemble,
            "preview": self.preview,
        }
        for key in self.todo:
            self._start(key)
            await self._flush(force=True)
            try:
                result = await handlers[key]()
            except JobSuperseded:
                raise
            except Exception as e:
                return await self._fail(key, self.sentence(key, e), e)
            if key == "preview":
                if isinstance(result, Done) and result.message:
                    self._step("preview")["message"] = result.message
                break
            done = result if isinstance(result, Done) else Done(result)
            await self._finish_step(key, done.message, skipped=done.skipped)
        return await self._end()

    # --- settings -------------------------------------------------------------------------------------------------

    @property
    def crf(self) -> int:
        return media.crf_for((self.config.get("video") or {}).get("quality"))

    @property
    def scenes_at_once(self) -> int:
        raw = (self.config.get("production") or {}).get("scenesAtOnce")
        return _int(raw, self.svc.scenes_at_once, 1, 3)

    @property
    def burn_captions(self) -> bool:
        return (self.config.get("production") or {}).get("burnCaptions") is not False

    @property
    def keep_versions(self) -> int | None:
        raw = (self.config.get("production") or {}).get("keepVersions")
        if raw in (None, "all"):
            return None
        return _int(raw, 10, 1, 10)

    @property
    def driving(self) -> bool:
        return self.story.get("category") == "driving_safety"

    # --- the end --------------------------------------------------------------------------------------------------

    def _without(self, *steps: str) -> list[str]:
        self.stale = [s for s in self.stale if s not in steps]
        return list(self.stale)

    async def _fail(self, key: str, sentence: str, error: BaseException | None = None) -> str:
        if error is not None:
            log("warn", "stories.step_failed", job=self.fence.job_id, step=key, error=type(error).__name__,
                detail=str(error)[:600])  # fmt: skip
        if any(s.get("key") == key for s in self.steps):
            self._step(key).update({"status": "failed", "message": sentence, "finishedAt": now_iso()})
        at_or_after = self.step_keys.index(key) if key in self.step_keys else 0
        later = [s for s in self.run_steps if self.step_keys.index(s) >= at_or_after]
        stale = ordered([*self.stale, *later])
        at = now_iso()
        await self._last_write(
            story_id=self.story_id if self.story else None,
            story_set={"status": "failed", "stale": stale} if self.story else None,
            story_remove=["currentJobId"] if self.story else (),
            puts=[self._activity("failed", at)] if self.story else [],
            job_fields={"status": "failed", "error": sentence, "steps": self.steps, "progress": self._progress(),
                        "meta": self.meta, "heartbeatAt": at},
        )  # fmt: skip
        log("info", "stories.job_failed", job=self.fence.job_id, step=key)
        return "failed"

    async def _end(self) -> str:
        problems = bool(self.held_for_topic or (self.story.get("safety") or {}).get("status") == "problems")
        status = "needs_check" if problems else "ready"
        if "preview" in self.run_steps and any(s.get("key") == "preview" for s in self.steps):
            self._step("preview").update({"status": "done", "finishedAt": now_iso()})
        at = now_iso()
        await self._last_write(
            story_id=self.story_id,
            story_set={"status": "needs_check" if problems else "review", "stale": self._without(*self.run_steps)},
            story_remove=["currentJobId"],
            puts=[self._activity("made", at)],
            job_fields={"status": status, "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": at},
        )
        log("info", "stories.job_done", job=self.fence.job_id, status=status)
        return status

    def _activity(self, kind: str, at: str) -> dict[str, Any]:
        return {
            "pk": self.fence.pk,
            "sk": keys.activity_sk(at, ulid()),
            "type": keys.TYPE_ACTIVITY,
            "userId": self.fence.user_id,
            "workspaceId": self.fence.workspace_id,
            "at": at,
            "kind": kind,
            "storyId": self.story_id,
            "title": str(self.story.get("title") or ""),
            "ttl": int(time.time()) + keys.ACTIVITY_DAYS * 86400,
        }

    # --- shared pieces ------------------------------------------------------------------------------------------

    @property
    def version(self) -> int:
        return int(self.story.get("scriptVersion") or 0)

    def _key(self, fn: Callable[..., str], *args: Any) -> str:
        return fn(self.fence.user_id, self.fence.workspace_id, self.story_id, *args)

    def _ctx(self) -> ProviderContext:
        return ProviderContext(
            engine=self.engine,
            workdir=self.work,
            ask=functools.partial(self.ask, step="storyboard", agent_id="storyboard"),
            on_progress=self.report,
            seed=int((self.script or {}).get("seed") or 0),
            crf=self.crf,
            image_model_id=self.svc.image_model_id,
            image_client=self.svc.image_client,
            video_bucket=self.svc.video_bucket,
            video_model_id=self.svc.video_model_id,
            reel_client=self.svc.reel_client,
            us_s3=self.svc.us_s3,
            reel_prefix=lambda sid: self._key(keys.reel_prefix, sid, self.version),
            sleep=self.svc.reel_sleep,
        )

    def _provider(self, kind: str, ctx: ProviderContext, pid: str | None = None) -> Any:
        return self.svc.registry[kind][pid or chosen(self.config)[kind]](ctx)

    async def _load_script(self) -> dict[str, Any]:
        if self.script is not None:
            return self.script
        n = self.version
        key = self._key(keys.script_key, n) if n > 0 else str(self.story.get("scriptKey") or "")
        if not key:
            raise StoryFailed(keys.NO_SCRIPT)
        try:
            script = await self.data.get_json(self.fence, key)
        except Exception as e:
            raise StoryFailed(keys.NO_SCRIPT) from e
        if not isinstance(script, dict):
            raise StoryFailed(keys.NO_SCRIPT)
        self.script = script
        return script

    def _post(self) -> dict[str, str]:
        if self.post is None:
            raw = self.story.get("postCaptions") or {}
            self.post = {f: str(raw.get(f) or "") for f in writer.POST_FIELDS}
        return self.post

    def _topic(self) -> Topic | None:
        return self.svc.guidance.topic(self.story.get("safetyTopicId"))

    def _require_topic(self) -> Topic | None:
        topic = self._topic()
        if self.driving and topic is None:
            raise StoryFailed(topic_sentence(self.svc.guidance))
        return topic

    def _current(self, kind: str, scene_id: str | None = None) -> dict[str, Any] | None:
        rows = [
            a
            for a in self.assets
            if a.get("kind") == kind
            and int((a.get("meta") or {}).get("current", 1) or 0) == 1
            and (scene_id is None or (a.get("meta") or {}).get("sceneId") == scene_id)
        ]
        return max(rows, key=lambda a: str(a.get("createdAt") or ""), default=None)

    def _retire(self, kind: str, scene_id: str | None = None) -> list[str]:
        ids = []
        for a in self.assets:
            m = a.get("meta") or {}
            if (
                a.get("kind") == kind
                and int(m.get("current", 1) or 0) == 1
                and (scene_id is None or m.get("sceneId") == scene_id)
            ):
                ids.append(str(a["assetId"]))
        return ids

    def _remember(self, put: AssetPut, retired: Sequence[str]) -> None:
        for a in self.assets:
            if a.get("assetId") in retired:
                a["meta"] = {**(a.get("meta") or {}), "current": 0}
        self.assets.append(
            {
                "assetId": put.asset_id,
                "kind": put.kind,
                "key": put.key,
                "storyId": put.story_id,
                "version": put.version,
                "meta": {"current": 1, **(put.meta or {})},
                "createdAt": now_iso(),
            }
        )

    async def _save(
        self,
        path: Path,
        key: str,
        kind: str,
        content_type: str,
        *,
        scene_id: str | None = None,
        meta: dict[str, str | int | float] | None = None,
        story_set: dict[str, Any] | None = None,
    ) -> AssetPut:
        size = await self.data.upload(self.fence, path, key, content_type)
        put = AssetPut(
            kind=kind,
            key=key,
            content_type=content_type,
            bytes=size,
            version=self.version or None,
            story_id=self.story_id,
            meta={**({"sceneId": scene_id} if scene_id else {}), **(meta or {})},
        )
        retired = self._retire(kind, scene_id)
        await self.data.write(
            self.fence, story_id=self.story_id if story_set else None, story_set=story_set, assets=[put], retire=retired
        )
        self._remember(put, retired)
        return put

    async def _prepare(self, script: dict[str, Any], *, fit_to: float | None) -> tuple[dict[str, Any], list[str]]:
        """validate → normalize → fit (when asked) → validate: the engine's checks. Returns the script and the
        engine's problems (empty when it is good)."""
        path = write_json(self.work / "check" / f"{ulid()}.json", script)
        errors = await self.engine.validate(path)
        if errors:
            return script, errors
        script = await self.engine.normalize(path)
        if fit_to is not None:
            path = write_json(path, script)
            script = await self.engine.fit(path, fit_to)
        path = write_json(path, script)
        errors = await self.engine.validate(path)
        return script, errors

    # --- storyboard ---------------------------------------------------------------------------------------------

    def _cast_now(self) -> dict[str, dict[str, Any]]:
        cast: dict[str, dict[str, Any]] = {}
        for i, cid in enumerate(self.story.get("characterIds") or []):
            ch = self.characters.get(str(cid))
            if not ch:
                continue
            cast[f"c{i + 1}"] = {
                "characterId": str(cid),
                "name": str(ch.get("name") or f"Character {i + 1}"),
                "look": ch.get("look") or {},
                "movementStyle": ch.get("movementStyle") or "calm",
                "voice": ch.get("voice") or {"style": "none", "pitch": 1, "noises": [], "sfx": []},
            }
        return cast

    async def _load_characters(self) -> None:
        for cid in self.story.get("characterIds") or []:
            ch = await self.data.character(self.fence.user_id, self.fence.workspace_id, str(cid))
            if ch:
                self.characters[str(cid)] = ch

    async def _concept(self) -> dict[str, Any]:
        story = self.story
        out: dict[str, Any] = {"title": story.get("title"), "category": story.get("category")}
        brief = story.get("brief")
        if isinstance(brief, dict):
            out.update({k: brief.get(k) for k in ("title", "logline", "category", "concept") if brief.get(k)})
        if story.get("ideaId"):
            idea = await self.data.idea(self.fence.user_id, self.fence.workspace_id, str(story["ideaId"]))
            if idea:
                out.update({k: idea.get(k) for k in ("logline", "concept") if idea.get(k)})
                out.setdefault("title", idea.get("title"))
        return {k: v for k, v in out.items() if v is not None}

    async def _references(self) -> list[dict[str, Any]]:
        """The analyses of the story's reference videos (§45.28), for the writer; one that is not ready is left out."""
        out: list[dict[str, Any]] = []
        for ref_id in (self.story.get("referenceIds") or [])[:3]:
            ref = await self.data.reference(self.fence.user_id, self.fence.workspace_id, str(ref_id))
            if not ref or ref.get("status") != "analyzed" or not ref.get("analysisKey"):
                continue
            try:
                got = await self.data.get_json(self.fence, str(ref["analysisKey"]))
            except Exception as e:
                log("warn", "stories.reference_unreadable", ref=ref_id, error=type(e).__name__)
                continue
            if isinstance(got, dict):
                keep = ("summary", "hook", "pacing", "gags", "sound", "captions", "borrow", "avoid")
                analysis = {k: got.get(k) for k in keep if got.get(k) is not None}
                analysis["shots"] = (got.get("shots") or [])[:20]
                out.append({"title": ref.get("title"), "analysis": analysis})
        return out

    def _music(self, answer: dict[str, Any]) -> dict[str, Any] | None:
        if self.config.get("musicOn") is False:
            return None
        mood = self.story.get("musicMood")
        volume = 0.4
        raw = answer.get("music")
        if isinstance(raw, dict):
            volume = float(raw.get("volume") or volume)
            mood = mood or raw.get("mood")
        if not mood or mood == "none":
            return None
        return {"mood": str(mood), "volume": round(min(1.0, max(0.0, volume)), 2)}

    async def _write(
        self, mode: str, request: dict[str, Any], *, note: str | None, scene_ids: Sequence[str] | None
    ) -> dict[str, Any]:
        if not self.budget.take("writer"):
            raise StoryFailed(keys.WRITER_FAILED)
        catalog = (await self.engine.catalog()).get("catalog") or {}
        provider = self._provider("writer", self._ctx())
        brief = {
            "mode": mode,
            "catalog": catalog,
            "castIds": [str(c["castId"]) for c in request.get("cast") or []],
            "topicIds": list(self.svc.guidance.topics),
            "request": request,
            "note": note,
            "sceneIds": list(scene_ids or []),
        }
        answer: dict[str, Any] = await provider.write(brief)
        await self.prove("writer", "bedrock-claude")
        return answer

    async def storyboard(self) -> str | None:
        topic = self._require_topic()
        await self._load_characters()
        conf = self.job.get("configuration") or {}
        note = (conf.get("note") or "").strip() or None
        scene_ids = [str(s) for s in conf.get("sceneIds") or []] if self.job.get("jobType") == "changes" else []
        old: dict[str, Any] | None = None
        if self.version > 0 or self.story.get("scriptKey"):
            with contextlib.suppress(StoryFailed):
                old = await self._load_script()
        if old is not None:
            scene_ids = [s for s in scene_ids if any(sc.get("sceneId") == s for sc in old.get("scenes") or [])]
        mode = "scenes" if scene_ids and old is not None else "full"
        keep_cast = self.job.get("jobType") == "changes" and old is not None
        cast = dict(old.get("cast") or {}) if keep_cast and old else self._cast_now()
        if not cast:
            raise StoryFailed("This story's characters are gone. Pick a character, then tap Try again.")
        catalog = (await self.engine.catalog()).get("catalog") or {}
        target = float(self.story.get("durationSec") or 45)
        request: dict[str, Any] = {
            "story": await self._concept(),
            "cast": writer.cast_brief(cast, self.characters),
            "catalog": {k: [{"id": e.get("id"), "label": e.get("label")} for e in v] for k, v in catalog.items()
                        if isinstance(v, list)},
            "targetSec": target,
            "captionsOn": bool(self.story.get("captionsOn", self.config.get("captionsOn", True))),
            "musicMood": self.story.get("musicMood"),
            "guidance": topic.brief() if topic else None,
        }  # fmt: skip
        references = await self._references()
        if references:
            request["referenceVideos"] = references
        if topic is None:
            request["safetyTopics"] = [{"id": t.id, "title": t.title} for t in self.svc.guidance.topics.values()]
        if old is not None and self.job.get("jobType") == "changes":
            request["current"] = writer.without_looks(old)
            if note:
                request["note"] = note
            if scene_ids:
                request["sceneIds"] = scene_ids
        seed = keys.seed_for(self.fence.job_id, "script")
        if keep_cast and old and old.get("seed") is not None:
            seed = int(old["seed"])
        engine_version = await self.engine.version()
        self.meta.update({"engineVersion": engine_version, "seed": seed})
        args: dict[str, Any] = {"old": old, "cast": cast, "seed": seed, "engine": engine_version, "topic": topic,
                "scene_ids": scene_ids, "new_take": mode == "scenes" and not note}  # fmt: skip
        answer = await self._write(mode, request, note=note, scene_ids=scene_ids)
        script, teaches = self._script_from(mode, answer, **args)
        fit = None if mode == "scenes" and self._fits(script, target) else target
        script, errors = await self._prepare(script, fit_to=fit)
        if errors:
            log("info", "stories.writer_retry", job=self.fence.job_id, errors=errors[:5])
            request["problems"] = errors[:20]
            answer = await self._write(mode, request, note=note, scene_ids=scene_ids)
            script, teaches = self._script_from(mode, answer, **args)
            script, errors = await self._prepare(script, fit_to=fit)
            if errors:
                log("warn", "stories.writer_invalid", job=self.fence.job_id, errors=errors[:5])
                raise StoryFailed(keys.WRITER_FAILED)
        self.meta["writerModel"] = next(
            (m["model"] for m in reversed(self.meta.get("models") or []) if m.get("step") == "storyboard"), None
        )
        story_set: dict[str, Any] = {}
        if teaches and not self.driving and not self.story.get("safetyTopicId"):
            self.held_for_topic = True
            picked = answer.get("safetyTopicId")
            if isinstance(picked, str) and self.svc.guidance.topic(picked):
                story_set["safetyTopicId"] = picked
                self.meta["safetyTopicId"] = picked
        post = await self._post_captions(script, self.svc.guidance.topic(story_set.get("safetyTopicId")) or topic)
        await self._save_script(script, post, story_set=story_set, by="writer")
        self.writer_texts = writer.texts(script, post)
        return f"{len(script.get('scenes') or [])} scenes, {round(frame_count(script) / 30)} s"

    async def _post_captions(self, script: dict[str, Any], topic: Topic | None) -> dict[str, str]:
        """The six post captions from the final script (``task="captions"``, the storyboard agent, §45.11.2); the
        owner's own captions are kept as he wrote them."""
        current = self._post()
        mine = {f for f in (self.story.get("ownerEdits") or {}).get("postCaptions") or [] if f in writer.POST_FIELDS}
        keep = {f: current[f] for f in mine if current.get(f)}
        if not self.budget.take("captions"):
            raise StoryFailed(keys.WRITER_FAILED)
        reply = await self.ask(
            step="storyboard",
            agent_id="storyboard",
            task="captions",
            messages=writer.captions_request(script, topic, keep=keep, concept=await self._concept()),
            schema=writer.POST_SCHEMA,
            max_tokens=8000,
        )
        post = writer.post_captions(reply.data, topic)
        post.update(keep)
        return post

    def _fits(self, script: dict[str, Any], target: float) -> bool:
        total = sum(float(s.get("durationSec") or 0) for s in script.get("scenes") or [])
        return 0.9 * target <= total <= min(1.1 * target, MAX_FINAL_SECONDS)

    def _script_from(
        self,
        mode: str,
        answer: dict[str, Any],
        *,
        old: dict[str, Any] | None,
        cast: dict[str, dict[str, Any]],
        seed: int,
        engine: int,
        topic: Topic | None,
        scene_ids: Sequence[str],
        new_take: bool,
    ) -> tuple[dict[str, Any], bool]:
        captions_on = bool(self.story.get("captionsOn", self.config.get("captionsOn", True)))
        if mode == "scenes" and old is not None:
            seeds = {sid: keys.seed_for(self.fence.job_id, "scene", sid) for sid in scene_ids}
            script, missing = writer.merge_scenes(old, answer, scene_ids, new_take=new_take, seeds=seeds)
            if missing:
                log("warn", "stories.writer_missed_scenes", job=self.fence.job_id, missing=missing)
            script["engine"] = engine
            return script, False
        script = writer.script_from(
            answer,
            title=str(self.story.get("title") or answer.get("title") or "Lamo Stories"),
            engine_version=engine,
            seed=seed,
            cast=cast,
            captions_on=captions_on,
            music=self._music(answer),
            topic=topic,
        )
        if old is not None:  # the same scene ids keep their seeds, so an unchanged scene is not drawn again
            seeds_old = {str(s.get("sceneId")): s.get("seed") for s in old.get("scenes") or []}
            for s in script["scenes"]:
                if seeds_old.get(s["sceneId"]) is not None and s.get("seed") is None:
                    s["seed"] = seeds_old[s["sceneId"]]
        return script, bool(answer.get("teachesSafety"))

    async def _save_script(
        self, script: dict[str, Any], post: dict[str, str], *, story_set: dict[str, Any] | None = None, by: str
    ) -> None:
        n = self.version + 1
        key = self._key(keys.script_key, n)
        data = json.dumps(script, separators=(",", ":")).encode()
        size = await self.data.put_bytes(self.fence, key, data, "application/json")
        snapshot = {"by": by, "jobId": self.fence.job_id, "texts": writer.texts(script, post), "postCaptions": post}
        sidecar = key.removesuffix(".json") + ".writer.json"
        await self.data.put_bytes(self.fence, sidecar, json.dumps(snapshot).encode(), "application/json")
        put = AssetPut(kind="storyboard", key=key, content_type="application/json", bytes=size, version=n,
                       story_id=self.story_id, meta={"by": by})  # fmt: skip
        retired = self._retire("storyboard")
        fields = {
            "scriptVersion": n,
            "scriptKey": key,
            "postCaptions": post,
            "scenes": [
                {"sceneId": s["sceneId"], "title": s.get("title") or s["sceneId"], "durationSec": s.get("durationSec")}
                for s in script.get("scenes") or []
            ],
            "stale": self._without("storyboard"),
            **(story_set or {}),
        }
        await self.data.write(self.fence, story_id=self.story_id, story_set=fields, assets=[put], retire=retired)
        self._remember(put, retired)
        self.story.update(dict(fields))
        self.script, self.post = script, post
        self.meta["scriptVersion"] = n

    # --- safety -------------------------------------------------------------------------------------------------

    async def _writer_snapshot(self) -> dict[str, str] | None:
        """The texts as the writer last wrote them (this job's, else the newest writer version's sidecar)."""
        if self.writer_texts is not None:
            return self.writer_texts
        rows = [a for a in self.assets if a.get("kind") == "storyboard" and (a.get("meta") or {}).get("by") == "writer"]
        newest = max(rows, key=lambda a: int(a.get("version") or 0), default=None)
        if newest is None:
            return None
        try:
            snap = await self.data.get_json(self.fence, str(newest["key"]).removesuffix(".json") + ".writer.json")
        except Exception:
            return None
        got = snap.get("texts") if isinstance(snap, dict) else None
        return {str(k): str(v) for k, v in got.items()} if isinstance(got, dict) else None

    async def _check(self, script: dict[str, Any], post: dict[str, str], topic: Topic | None) -> safety.Check:
        found = safety.code_problems(script, topic)
        if not self.budget.take("checker"):
            return safety.Check(found or [{"ref": "", "problem": "The facts could not be checked again this time."}])
        body = safety.request(script, post, topic)
        reply = await self.ask(
            step="safety",
            agent_id="quality_assurance",
            task="fact_check",
            messages=[{"role": "user", "content": [
                {"text": safety.CHECK_SYSTEM},
                {"text": "The video to check, as JSON:\n" + json.dumps(body, ensure_ascii=False)},
            ]}],
            schema=safety.CHECK_SCHEMA,
            max_tokens=8000,
            allow_inactive=self.driving,  # a driving-safety story is always checked (§45.26)
        )  # fmt: skip
        refs = [it["ref"] for it in safety.items(script, post)]
        got = safety.parse(reply.data or {}, refs)
        seen = {(p["ref"], p["problem"]) for p in found}
        return safety.Check([*found, *[p for p in got.problems if (p["ref"], p["problem"]) not in seen]])

    async def check_facts(self) -> str | Done | None:
        topic = self._require_topic()
        script = await self._load_script()
        post = self._post()
        refs_names = {it["ref"]: it["where"] for it in safety.items(script, post)}
        try:
            first = await self._check(script, post, topic)
        except AgentOff:
            if self.driving:
                raise
            skipped: dict[str, Any] = {"topicId": None, "status": "skipped", "problems": [],
                                       "checkedScriptVersion": self.version, "citations": []}  # fmt: skip
            await self.data.write(
                self.fence, story_id=self.story_id, story_set={"safety": skipped, "stale": self._without("safety")}
            )
            self.story["safety"] = skipped
            return Done(QUALITY_OFF, skipped=True)
        result = first
        rewritten = False
        if not first.ok:
            snapshot = await self._writer_snapshot()
            current = writer.texts(script, post)
            if snapshot is not None:  # the writer's own words are known: anything else is the owner's
                owner = {r for r, t in current.items() if snapshot.get(r) != t} | owner_refs(self.story)
            elif isinstance(self.story.get("ownerEdits"), dict):  # the API's record of the owner's edits
                owner = owner_refs(self.story)
            else:  # neither: every text may be the owner's, so none is rewritten
                owner = set(current)
            kinds = safety.allowed_refs(self.run_steps)
            fixable = [
                p for p in first.problems if p["ref"] and p["ref"] not in owner and p["ref"].split(":")[0] in kinds
            ]
            if fixable and self.budget.has("writer"):
                fixed = await self._rewrite(script, post, topic, first.problems, owner, kinds)
                if fixed is not None:
                    script, post = fixed
                    rewritten = True
                    refs_names = {it["ref"]: it["where"] for it in safety.items(script, post)}
                    result = await self._check(script, post, topic)
        problems = result.sentences(refs_names)
        if self.held_for_topic:
            problems = [*problems, HELD_TOPIC]
        status = "problems" if problems else "ok"
        record = {
            "topicId": topic.id if topic else None,
            "status": status,
            "problems": problems,
            "checkedScriptVersion": self.version,
            "citations": topic.citations if topic else [],
        }
        await self.data.write(
            self.fence, story_id=self.story_id, story_set={"safety": record, "stale": self._without("safety")}
        )
        self.story["safety"] = record
        if status == "ok":
            return "Rewritten, then checked" if rewritten else "Checked"
        return f"{len(problems)} thing{'s' if len(problems) != 1 else ''} to check"

    async def _rewrite(
        self,
        script: dict[str, Any],
        post: dict[str, str],
        topic: Topic | None,
        problems: list[dict[str, str]],
        owner: set[str],
        kinds: set[str],
    ) -> tuple[dict[str, Any], dict[str, str]] | None:
        """One rewrite of the writer's own texts; the owner's texts and anything this job does not remake stay."""
        await self._load_characters()
        catalog = (await self.engine.catalog()).get("catalog") or {}
        cast = dict(script.get("cast") or {})
        request = {
            "story": await self._concept(),
            "cast": writer.cast_brief(cast, self.characters),
            "catalog": {k: [{"id": e.get("id"), "label": e.get("label")} for e in v] for k, v in catalog.items()
                        if isinstance(v, list)},
            "targetSec": float(script.get("durationSec") or 45),
            "captionsOn": bool(script.get("captionsOn")),
            "guidance": topic.brief() if topic else None,
            "current": writer.without_looks(script),
            "currentPostCaptions": post,
            "problems": problems,
            "keep": sorted(owner),
            "mayChange": sorted(kinds),
        }  # fmt: skip
        try:
            answer = await self._write("fix", request, note=None, scene_ids=None)
        except (StoryFailed, AnswerInvalid):
            return None
        new = writer.script_from(
            answer,
            title=str(script.get("title") or ""),
            engine_version=int(script.get("engine") or 0),
            seed=int(script.get("seed") or 0),
            cast=cast,
            captions_on=bool(script.get("captionsOn")),
            music=script.get("music"),
            topic=topic,
        )
        old_scenes = {str(s.get("sceneId")): s for s in script.get("scenes") or []}
        new_ids = [str(s.get("sceneId")) for s in new.get("scenes") or []]
        if "scene" not in kinds or new_ids != list(old_scenes):
            new["scenes"] = [dict(s) for s in script.get("scenes") or []]
        else:
            for s in new["scenes"]:
                o = old_scenes[s["sceneId"]]
                s["durationSec"] = o.get("durationSec")
                if o.get("seed") is not None:
                    s["seed"] = o["seed"]
        if "caption" not in kinds:
            new["captions"] = [dict(c) for c in script.get("captions") or []]
        new_post = dict(post)
        if "post" in kinds and any(p["ref"].startswith("post:") for p in problems):
            try:
                new_post = await self._post_captions(new, topic)
            except (StoryFailed, AnswerInvalid):
                new_post = dict(post)
        writer.restore(new, new_post, script, post, owner)
        new["durationSec"] = script.get("durationSec")
        new, errors = await self._prepare(new, fit_to=None)
        if errors:
            log("warn", "stories.rewrite_invalid", job=self.fence.job_id, errors=errors[:5])
            return None
        await self._save_script(new, new_post, by="writer")
        self.writer_texts = writer.texts(new, new_post)
        return new, new_post

    # --- scenes and animation -----------------------------------------------------------------------------------

    def _targets(self, kind: str, script: dict[str, Any]) -> list[dict[str, Any]]:
        """The scenes to (re)make: the job's ``sceneIds`` when it names them, else every scene whose file is
        missing or was made from different content."""
        conf = self.job.get("configuration") or {}
        named = [str(s) for s in conf.get("sceneIds") or []] if conf.get("from") in ("scenes", "animation") else []
        forced = {str(s) for s in self.story.get("staleScenes") or []} if kind == "scene_clip" else set()
        out = []
        for s in script.get("scenes") or []:
            sid = str(s.get("sceneId"))
            have = self._current(kind, sid)
            stale = have is None or (have.get("meta") or {}).get("hash") != scene_hash(script, s)
            if sid in named or (not named and (stale or sid in forced)):
                out.append(s)
        return out

    async def draw_scenes(self) -> str | None:
        script = await self._load_script()
        targets = self._targets("scene_still", script)
        path = write_json(self.work / "stills" / "script.json", script)
        ranges = {str(r["sceneId"]): r for r in await self.engine.scenes(path)}
        ids = {str(s.get("sceneId")) for s in script.get("scenes") or []}
        stills = {k: v for k, v in (self.story.get("stillKeys") or {}).items() if k in ids}
        lock = asyncio.Semaphore(self.scenes_at_once)
        done = 0

        async def one(scene: dict[str, Any]) -> None:
            nonlocal done
            sid = str(scene["sceneId"])
            async with lock:
                jpg = self.work / "stills" / f"{sid}.jpg"
                await render_still(self.engine, path, int(ranges[sid]["mid"]), jpg, self.work / "stills")
                key = self._key(keys.scene_still_key, sid, self.version)
                await self._save(jpg, key, "scene_still", "image/jpeg", scene_id=sid,
                                 meta={"hash": scene_hash(script, scene)})  # fmt: skip
                stills[sid] = key
                done += 1
                self.report(done, len(targets))

        await asyncio.gather(*(one(s) for s in targets))
        await self.data.write(
            self.fence, story_id=self.story_id, story_set={"stillKeys": stills, "stale": self._without("scenes")}
        )
        self.story["stillKeys"] = stills
        if targets:
            await self.prove("images", "builtin-rig")  # the characters were drawn by the engine's rigs
        return f"{len(targets)} drawn" if targets else "Nothing changed"

    def _scene_provider(self, scene: dict[str, Any]) -> str:
        """The animation provider of one scene: the workspace's, except that Nova Reel never draws a scene with a
        character in it (the built-in animator keeps characters the same, §45.8)."""
        picked = chosen(self.config)["animation"]
        if picked == "nova-reel" and has_actors(scene):
            return "builtin-2d"
        return picked

    async def _render(self, script: dict[str, Any], scenes: list[dict[str, Any]]) -> None:
        total = max(1, sum(round(float(s.get("durationSec") or 0) * 30) for s in scenes))
        progress: dict[str, int] = {}
        lock = asyncio.Semaphore(self.scenes_at_once)
        ctx = self._ctx()
        used: dict[str, float] = {}
        started = time.monotonic()

        async def one(scene: dict[str, Any]) -> None:
            sid = str(scene["sceneId"])

            def frames(i: int, n: int) -> None:
                progress[sid] = round(i * float(scene.get("durationSec") or 0) * 30 / max(1, n))
                self.report(sum(progress.values()), total)

            async with lock:
                pid = self._scene_provider(scene)
                provider = self._provider("animation", dataclasses.replace(ctx, on_progress=frames), pid)
                out = self.work / "clips" / f"{sid}.mp4"
                try:
                    clip = await provider.render_scene(script, sid, {}, out)
                except ProviderFailed as e:
                    if e.state:
                        await self.prove("animation", pid, e.state, e.last_error)
                    raise
                used[pid] = used.get(pid, 0.0) + clip.duration_sec
                key = self._key(keys.scene_clip_key, sid, self.version)
                meta = {"hash": scene_hash(script, scene), "frames": round(clip.duration_sec * 30), "provider": pid}
                await self._save(clip.path, key, "scene_clip", "video/mp4", scene_id=sid, meta=meta)

        await asyncio.gather(*(one(s) for s in scenes))
        for pid, seconds in used.items():
            await self.prove("animation", pid)
            if pid == "builtin-2d":
                await self.provider_usage(pid, "", videoSec=seconds, renderSec=time.monotonic() - started)
            else:
                await self.provider_usage(pid, self.svc.video_model_id, videoSec=seconds)
        if "nova-reel" in used:
            self.meta["providers"] = {**(self.meta.get("providers") or {}), "animation": "nova-reel"}

    async def animate(self) -> str | None:
        script = await self._load_script()
        targets = self._targets("scene_clip", script)
        await self._render(script, targets)
        await self.data.write(self.fence, story_id=self.story_id, story_set={"stale": self._without("animation")})
        return f"{len(targets)} animated" if targets else "Nothing changed"

    # --- sound, captions, assembly ------------------------------------------------------------------------------

    async def _make_sound(self, script: dict[str, Any]) -> Path:
        provider = self._provider("audio", self._ctx())
        out = self.work / "sound" / "mix.m4a"
        path: Path = await provider.mix(script, out)
        await self._save(path, self._key(keys.audio_key, self.version), "audio", "audio/mp4")
        await self.prove("audio", chosen(self.config)["audio"])
        return path

    async def sound(self) -> str | None:
        script = await self._load_script()
        await self._make_sound(script)
        await self.data.write(self.fence, story_id=self.story_id, story_set={"stale": self._without("sound")})
        return None

    async def captions(self) -> Done | str | None:
        script = await self._load_script()
        path = write_json(self.work / "captions" / "script.json", script)
        events = await self.engine.text(path)
        captions_on = bool(script.get("captionsOn"))
        if not ass.needs_file(events, captions_on):  # nothing to show: no file, and no older one burned in
            retired = self._retire("captions")
            await self.data.write(
                self.fence, story_id=self.story_id, story_set={"stale": self._without("captions")}, retire=retired
            )
            for a in self.assets:
                if a.get("assetId") in retired:
                    a["meta"] = {**(a.get("meta") or {}), "current": 0}
            return Done("No captions", skipped=True)
        text = ass.build(events, captions_on=captions_on)
        out = self.work / "captions" / "captions.ass"
        out.write_text(text, "utf-8")
        meta: dict[str, str | int | float] = {"burned": 1 if self.burn_captions else 0}
        await self._save(out, self._key(keys.captions_key, self.version), "captions", "text/x-ssa", meta=meta)
        await self.data.write(self.fence, story_id=self.story_id, story_set={"stale": self._without("captions")})
        lines = sum(1 for line in text.splitlines() if line.startswith("Dialogue:"))
        return f"{lines} on screen" if self.burn_captions else f"{lines} kept as a separate file"

    async def assemble(self) -> str | None:
        script = await self._load_script()
        seconds = frame_count(script) / 30.0
        if seconds > MAX_FINAL_SECONDS + 0.05:
            raise StoryFailed("This story is longer than 90 seconds. Make it shorter, then tap Try again.")
        work = self.work / "final"
        work.mkdir(parents=True, exist_ok=True)
        missing = []
        for s in script.get("scenes") or []:
            have = self._current("scene_clip", str(s["sceneId"]))
            frames = round(float(s.get("durationSec") or 0) * 30)
            if have is None or int((have.get("meta") or {}).get("frames") or -1) != frames:
                missing.append(s)
        if missing:  # a scene with no clip of the right length (a stop, a length edit) is animated here
            log("info", "stories.assemble_renders", job=self.fence.job_id, scenes=[s["sceneId"] for s in missing])
            await self._render(script, missing)
        clips = []
        for s in script.get("scenes") or []:
            have = self._current("scene_clip", str(s["sceneId"]))
            assert have is not None
            clips.append(await self.data.download(self.fence, str(have["key"]), work / f"{s['sceneId']}.mp4"))
        sound = self._current("audio")
        audio_path = (
            await self.data.download(self.fence, str(sound["key"]), work / "sound.m4a")
            if sound
            else await self._make_sound(script)
        )
        cap = self._current("captions") if self.burn_captions else None
        caption_path = await self.data.download(self.fence, str(cap["key"]), work / "captions.ass") if cap else None
        final = work / "final.mp4"
        await media.assemble(clips, audio_path, caption_path, final, seconds, work, crf=self.crf)
        info = await media.probe(final)
        actual = round(min(info.duration, MAX_FINAL_SECONDS), 2)
        cover = work / "cover.jpg"
        await media.cover(final, min(1.5, actual / 2), cover)
        video_key = self._key(keys.final_key, self.version)
        cover_key = self._key(keys.cover_key, self.version)
        await self._save(final, video_key, "final_video", "video/mp4", meta={"durationSec": actual})
        await self._save(cover, cover_key, "cover", "image/jpeg")
        self.meta["actualSec"] = actual
        await self.data.write(
            self.fence,
            story_id=self.story_id,
            story_set={"videoKey": video_key, "coverKey": cover_key, "actualDurationSec": actual,
                       "stale": self._without("assemble")},
        )  # fmt: skip
        self.story.update({"videoKey": video_key, "actualDurationSec": actual})
        return f"{actual:g} s"

    # --- preview ------------------------------------------------------------------------------------------------

    async def preview(self) -> Done:
        """The quality agent's last look at the finished video (``task="final_review"``: the script and 8 frames,
        §45.11.3), then old versions beyond ``production.keepVersions`` are deleted."""
        message = await self._final_review()
        await self._prune_versions()
        return Done(message)

    async def _final_review(self) -> str | None:
        script = await self._load_script()
        final = self._current("final_video")
        if final is None or not self.budget.take("review"):
            return None
        work = self.work / "review"
        video = await self.data.download(self.fence, str(final["key"]), work / "final.mp4")
        length = float(self.story.get("actualDurationSec") or frame_count(script) / 30.0)
        times = [length * (i + 0.5) / REVIEW_FRAMES for i in range(REVIEW_FRAMES)]
        frames = await media.frame_jpegs(video, times, work / "frames")
        pictures = await asyncio.gather(*(asyncio.to_thread(images.to_model_image, f) for f in frames))
        topic = self._topic()
        body = safety.review_request(script, topic, times[: len(pictures)])
        content: list[dict[str, Any]] = [
            {"text": safety.REVIEW_PROMPT},
            {"text": "The video, as JSON:\n" + json.dumps(body, ensure_ascii=False)},
        ]
        for i, jpeg in enumerate(pictures):
            content += [{"text": f"Frame {i + 1} at {times[i]:.1f} s:"}, images.image_block(jpeg)]
        try:
            reply = await self.ask(
                step="preview",
                agent_id="quality_assurance",
                task="final_review",
                messages=[{"role": "user", "content": content}],
                schema=safety.CHECK_SCHEMA,
                max_tokens=8000,
            )
        except AgentOff:
            return QUALITY_OFF
        found = safety.parse_review(reply.data or {})
        if not found:
            return "Looked at the finished video"
        record: dict[str, Any] = dict(self.story.get("safety") or {})
        record.setdefault("topicId", topic.id if topic else None)
        record.setdefault("citations", topic.citations if topic else [])
        record.setdefault("checkedScriptVersion", None)
        record["problems"] = [*(record.get("problems") or []), *[f"Last look: {p}" for p in found]]
        record["status"] = "problems"
        await self.data.write(self.fence, story_id=self.story_id, story_set={"safety": record})
        self.story["safety"] = record
        return f"{len(found)} thing{'s' if len(found) != 1 else ''} to check"

    async def _prune_versions(self) -> None:
        """Deletes the story's files of versions older than the last ``keepVersions`` (§45.29); the current files
        are always kept."""
        keep = self.keep_versions
        if keep is None or self.version <= keep:
            return
        floor = self.version - keep + 1
        old = [
            a
            for a in self.assets
            if a.get("kind") in STORY_KINDS
            and int((a.get("meta") or {}).get("current", 1) or 0) == 0
            and a.get("version") is not None
            and int(a["version"]) < floor
            and str(a.get("key") or "").startswith(keys.story_prefix(self.fence.user_id, self.fence.workspace_id,
                                                                     self.story_id))
        ]  # fmt: skip
        if not old:
            return
        files = [str(a["key"]) for a in old]
        files += [k.removesuffix(".json") + ".writer.json" for k in files if k.endswith(".json")]
        for i in range(0, len(old), 90):
            await self.data.write(self.fence, delete_assets=[str(a["assetId"]) for a in old[i : i + 90]])
        await self.data.delete_files(self.fence, files)
        gone = {a["assetId"] for a in old}
        self.assets = [a for a in self.assets if a.get("assetId") not in gone]
        log("info", "stories.pruned", job=self.fence.job_id, files=len(files), keep=keep)


def clean_work(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
