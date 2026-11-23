"""A reference video's analysis job (docs/CONTRACTS.md §45.28, §45.33): the runner and the fencing are here, the
analysis itself is the ``reference`` package's (builder E2).

The job is a ``PJOB#`` of type ``reference_analysis`` (``contentType = "reference"``, ``contentId = refId``) with its
own step track ("Look at it", "Listen", "Write it up"; the API's step keys are used as they are). This module downloads
the uploaded file (only from the reference's own folder under ``ws/``), checks it with ffprobe (≤ 10 minutes), then
awaits ``reference.analyze(run)`` with a ``ReferenceRun``: the file, its length, the steps (``run.step(key)``), the
progress (``run.report``) and the model call (``run.ask``: the ``video_analysis`` agent's ``reference_analysis`` task on
the owner's model and effort, recorded in ``meta.models``). ``analyze`` returns the ``ReferenceAnalysis``; this module
writes ``analysis.json`` and, in one fenced transaction, the reference (``status = analyzed``, ``analysisKey``,
``analyzedWith``, ``durationSec``, ``currentJobId`` removed, as on a story) and the job (``ready``)."""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar

from . import images, keys, media, retention
from .models import Reply
from .pipeline import Job, StoryFailed
from .util import JobSuperseded, UserFacingError, log, now_iso

REF_STEPS: tuple[str, ...] = ("look", "listen", "write")
REF_LABELS = {"look": "Look at it", "listen": "Listen", "write": "Write it up"}
MAX_SECONDS = 600.0
TOO_LONG = "This video is longer than 10 minutes. Upload a shorter one."
NOT_BUILT = "Studying reference videos is not in this version of Funded Clips yet. Tap Try again later."
FAILED = "Studying the video did not finish. Tap Try again."
GONE = "This reference video no longer exists."
UNREADABLE = "This file can't be played as a video. Upload an MP4 or MOV file."
REMOVED = "The video was removed to save space. Its study stays. Upload it again to study it again."
REMOVED_NO_STUDY = "The video was removed to save space. Upload it again to study it."  # never studied (§45.35 D9)


@dataclass
class ReferenceRun:
    """What ``reference.analyze`` gets."""

    job: ReferenceJob
    ref: dict[str, Any]
    source: Path
    duration_sec: float
    work: Path

    @property
    def user_id(self) -> str:
        return self.job.fence.user_id

    @property
    def workspace_id(self) -> str:
        return self.job.fence.workspace_id

    @property
    def ref_id(self) -> str:
        return self.job.content_id

    @contextlib.asynccontextmanager
    async def step(self, key: str, message: str | None = None) -> AsyncIterator[None]:
        """Marks one step running, then done (a failure inside ends the job with its sentence)."""
        await self.job.begin(key)
        yield
        await self.job.end_step(key, message)

    def report(self, i: int, n: int) -> None:
        self.job.report(i, n)

    async def ask(
        self,
        *,
        messages: list[dict[str, Any]],
        schema: dict[str, Any] | None = None,
        max_tokens: int = 16000,
        task: str = "reference_analysis",
    ) -> Reply:
        return await self.job.ask(
            step=self.job.current or "write",
            agent_id="video_analysis",
            task=task,
            messages=messages,
            schema=schema,
            max_tokens=max_tokens,
        )

    to_model_image = staticmethod(images.to_model_image)
    image_block = staticmethod(images.image_block)


Analyze = Callable[[ReferenceRun], Awaitable[dict[str, Any]]]


def find_analyze() -> Analyze | None:
    from . import reference

    fn = getattr(reference, "analyze", None)
    return fn if callable(fn) else None


class ReferenceJob(Job):
    step_keys: ClassVar[tuple[str, ...]] = REF_STEPS
    labels: ClassVar[dict[str, str]] = REF_LABELS
    content_types: ClassVar[tuple[str, ...]] = ("reference",)
    analyze: Analyze | None = None  # tests put a fake here; else reference.analyze

    def order(self, job: dict[str, Any]) -> tuple[str, ...]:
        own = tuple(str(s.get("key")) for s in job.get("steps") or [] if isinstance(s, dict) and s.get("key"))
        return own or self.step_keys

    async def begin(self, key: str) -> None:
        if not any(s.get("key") == key for s in self.steps):
            self.steps.append({"key": key, "label": REF_LABELS.get(key, key), "status": "pending"})
        self._start(key)
        await self._flush(force=True)

    async def end_step(self, key: str, message: str | None) -> None:
        await self._finish_step(key, message)

    async def _run(self) -> str:
        ref = await self.data.reference(self.fence.user_id, self.fence.workspace_id, self.content_id)
        if ref and ref.get("currentJobId") not in (None, self.fence.job_id):
            log("warn", "stories.not_current_job", job=self.fence.job_id, current=ref.get("currentJobId"))
            return "superseded"
        await self._start_running()
        first = self.todo[0] if self.todo else (self.run_steps[0] if self.run_steps else "look")
        if not ref:
            return await self._fail(first, GONE)
        try:
            source, seconds = await self._source(ref)
            analyze = self.analyze or find_analyze()
            if analyze is None:
                raise StoryFailed(NOT_BUILT)
            run = ReferenceRun(self, ref, source, seconds, self.work)
            analysis = await analyze(run)
            if not isinstance(analysis, dict) or not analysis:
                raise StoryFailed(FAILED)
        except JobSuperseded:
            raise
        except Exception as e:
            key = self.current or first
            return await self._fail(key, self.sentence(key, e) if not isinstance(e, StoryFailed) else str(e), e)
        return await self._done(ref, analysis, seconds)

    def sentence(self, key: str, e: BaseException) -> str:
        if isinstance(e, UserFacingError):
            return str(e)
        got = super().sentence(key, e)
        return got if got != keys.FAILED.get(key, "This step did not finish. Tap Try again.") else FAILED

    async def _source(self, ref: dict[str, Any]) -> tuple[Path, float]:
        if retention.file_removed(ref):  # cleared by keepReferences, the agent's or the API's (§45.34)
            raise StoryFailed(REMOVED if ref.get("analysisKey") else REMOVED_NO_STUDY)
        key = str(ref.get("key") or "")
        folder = keys.reference_prefix(self.fence.user_id, self.fence.workspace_id, self.content_id)
        if not key.startswith(folder):
            raise StoryFailed(GONE)
        path = await self.data.download(self.fence, key, self.work / "source" / key.rsplit("/", 1)[-1])
        try:
            info = await media.probe(path)
        except Exception as e:
            raise StoryFailed(UNREADABLE) from e
        if not info.has_video or info.duration <= 0:
            raise StoryFailed(UNREADABLE)
        if info.duration > MAX_SECONDS + 0.5:
            raise StoryFailed(TOO_LONG)
        return path, round(info.duration, 2)

    async def _done(self, ref: dict[str, Any], analysis: dict[str, Any], seconds: float) -> str:
        for s in self.steps:
            if s.get("status") in ("pending", "running"):
                s.update({"status": "skipped" if s.get("status") == "pending" else "done", "finishedAt": now_iso()})
        key = keys.reference_prefix(self.fence.user_id, self.fence.workspace_id, self.content_id) + "analysis.json"
        await self.data.put_bytes(
            self.fence, key, json.dumps(analysis, ensure_ascii=False).encode(), "application/json"
        )
        used = next((m for m in reversed(self.meta.get("models") or []) if m.get("agentId") == "video_analysis"), None)
        with_ = {"model": used["model"], "effort": used.get("effort")} if used else None
        at = now_iso()
        await self._last_write(
            other_set=(
                keys.refvid_sk(self.content_id),
                {"status": "analyzed", "analysisKey": key, "analyzedWith": with_, "durationSec": seconds},
                {"currentJobId": self.fence.job_id},
            ),
            other_remove=["currentJobId"],
            job_fields={"status": "ready", "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": at},
        )  # fmt: skip
        log("info", "stories.reference_done", job=self.fence.job_id)
        return "ready"

    async def _fail(self, key: str, sentence: str, error: BaseException | None = None) -> str:
        if error is not None:
            log("warn", "stories.reference_failed", job=self.fence.job_id, step=key, error=type(error).__name__,
                detail=str(error)[:600])  # fmt: skip
        if not any(s.get("key") == key for s in self.steps):
            self.steps.append({"key": key, "label": REF_LABELS.get(key, key), "status": "pending"})
        self._step(key).update({"status": "failed", "message": sentence, "finishedAt": now_iso()})
        at = now_iso()
        ref = await self.data.reference(self.fence.user_id, self.fence.workspace_id, self.content_id)
        other = None
        if ref is not None and ref.get("currentJobId") == self.fence.job_id:
            # A failed or stopped analysis keeps an earlier one, the API's rule (§45.35 D9): back to analyzed while
            # its study (analysisKey) is there, whether or not the video was cleared; failed only when there is none.
            status = "analyzed" if ref.get("analysisKey") else "failed"
            other = (keys.refvid_sk(self.content_id), {"status": status}, {"currentJobId": self.fence.job_id})
        await self._last_write(
            other_set=other,
            other_remove=["currentJobId"] if other else (),
            job_fields={"status": "failed", "error": sentence, "steps": self.steps, "progress": self._progress(),
                        "meta": self.meta, "heartbeatAt": at},
        )  # fmt: skip
        return "failed"
