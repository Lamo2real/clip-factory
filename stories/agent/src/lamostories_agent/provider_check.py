"""**Try it** for a video maker that is only shown ``on`` after a real call (docs/CONTRACTS.md §45.31, §45.34,
§45.35 D2): a ``provider_check`` job with one step, ``check`` ("Try it").

Only Amazon Nova Reel has one. With the US bucket switched on (``CF_VIDEO_BUCKET``) the job makes one 6-second test
shot there (Amazon bills it like any shot), under ``ws/{userId}/{workspaceId}/checks/nova-reel/{jobId}/``. A shot that
came back proves the maker: ``PROVIDER#animation#nova-reel`` is written ``on``, and the usage is recorded. Only a
shot that came back does that: a refusal, or a shot Bedrock took but could not make (``Failed``, or written somewhere
else), records ``needs_setup`` and the plain sentence, with Bedrock's own words when it gave some, so Settings never
shows Nova Reel ready after a Try it that failed. A timeout or a throttle proved nothing and leaves the record as it
was. Every failure tells the owner to tap Try it again (the button the Settings row has). The test shot's files are
deleted whatever happened. With the bucket off nothing is called and the job ends with the API's own
not-ready sentence. The fencing, heartbeat and last write are a story job's (``pipeline.Job``)."""

from __future__ import annotations

import asyncio
from typing import Any, ClassVar

from . import keys
from .pipeline import Job, StoryFailed
from .providers import (
    REEL_NO_BUCKET,
    REEL_SETUP,
    REEL_SHOT,
    NovaReel,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    provider_item,
)
from .util import JobSuperseded, log, now_iso

PROVIDERS = ("nova-reel",)  # the makers Try it can check
UNKNOWN = "Lamo Stories can only try Amazon Nova Reel here."
TRIED = "It made a 6-second test shot. Amazon Nova Reel is ready."
FAILED = "Trying Amazon Nova Reel did not finish. Tap Try it again."
SHOT_FAILED = (  # Bedrock took the test shot but could not make it: a setup problem every scene would hit
    "Amazon Nova Reel could not make its test shot. Tap Try it again in Settings › Video, or pick the Built-in "
    "animator there."
)
PROMPT = "Slow cinematic shot of a quiet country road on a sunny day, at eye level, no people, no text, no logos, calm camera, natural light"
DIMENSION = "1280x720"  # what Nova Reel 1.1 makes
SEED = 7


def said(sentence: str, detail: str | None) -> str:
    """The plain sentence, then Bedrock's own words when it gave some (what Try it records, §45.35 D2)."""
    return f"{sentence} Bedrock said: “{detail.strip()}”" if detail and detail.strip() else sentence


class ProviderCheckJob(Job):
    """One Try it run (``jobType`` ``provider_check``); ``content_id`` is the provider's id (``nova-reel``)."""

    step_keys: ClassVar[tuple[str, ...]] = (keys.CHECK_STEP,)
    labels: ClassVar[dict[str, str]] = {keys.CHECK_STEP: keys.CHECK_LABEL}
    content_types: ClassVar[tuple[str, ...]] = ("provider",)

    def owns(self, job: dict[str, Any]) -> bool:
        """A ``provider_check`` job of this workspace (its ``contentId`` is the provider's id when the API set one)."""
        content = job.get("contentId")
        return job.get("jobType") == keys.CHECK_JOB_TYPE and content in (None, "", self.content_id)

    async def _after(self) -> None:
        """Nothing to keep or clear after a check."""

    async def _fail(self, sentence: str, error: BaseException | None = None) -> str:
        if error is not None:
            log("warn", "stories.provider_check_failed", job=self.fence.job_id, provider=self.content_id,
                error=type(error).__name__, detail=str(error)[:600])  # fmt: skip
        self._step(keys.CHECK_STEP).update({"status": "failed", "message": sentence, "finishedAt": now_iso()})
        await self._last_write(
            job_fields={"status": "failed", "error": sentence, "steps": self.steps, "progress": self._progress(),
                        "meta": self.meta, "heartbeatAt": now_iso()}
        )  # fmt: skip
        return "failed"

    async def _run(self) -> str:
        await self._start_running()
        step = keys.CHECK_STEP
        if step not in self.todo:
            return "ignored"
        self._start(step)
        self.meta.setdefault("providers", {"animation": self.content_id})  # as the API wrote it, by kind
        await self._flush(force=True)
        try:
            await self._try()
        except JobSuperseded:
            raise
        except ProviderFailed as e:
            return await self._fail(said(self._sentence(e), e.detail), e)
        except (ProviderUnavailable, StoryFailed) as e:
            return await self._fail(str(e), e)
        except Exception as e:
            return await self._fail(FAILED, e)
        self._step(step).update({"status": "done", "message": TRIED, "finishedAt": now_iso()})
        async with self._job_lock:
            self._closed = True
            await self.data.update_job(
                self.fence,
                {"status": "ready", "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": now_iso()},
            )
        log("info", "stories.provider_check_done", job=self.fence.job_id, provider=self.content_id)
        return "ready"

    @staticmethod
    def _sentence(e: ProviderFailed) -> str:
        """The job's own sentence: a refusal says what to set up (the API's own not-ready line); anything else says
        to tap Try it again, never a story's "Tap Try again" (there is no such button on the Settings row)."""
        if e.state == "needs_setup":
            return e.sentence
        return SHOT_FAILED if e.state == "on" else FAILED

    def _record(self, state: str, last_error: str | None) -> dict[str, Any]:
        return provider_item(self.fence.pk, self.fence.user_id, self.fence.workspace_id, "animation", self.content_id,
                             state, now_iso(), last_error)  # fmt: skip

    async def _try(self) -> None:
        if self.content_id not in PROVIDERS:
            raise StoryFailed(UNKNOWN)
        if not self.svc.video_bucket:  # nothing is called: the API's own sentence (§45.34), no record written
            raise ProviderUnavailable(REEL_NO_BUCKET)
        prefix = keys.check_prefix(self.fence.user_id, self.fence.workspace_id, self.content_id, self.fence.job_id)
        ctx = ProviderContext(
            engine=self.engine,
            workdir=self.work,
            video_bucket=self.svc.video_bucket,
            video_model_id=self.svc.video_model_id,
            reel_client=self.svc.reel_client,
            us_s3=self.svc.us_s3,
            reel_prefix=lambda _: prefix,
            sleep=self.svc.reel_sleep,
        )
        try:
            await NovaReel(ctx).shot(PROMPT, SEED, DIMENSION, prefix)
        except ProviderFailed as e:
            # A refusal, or a shot Bedrock took but could not make, proved Nova Reel is not ready: ``needs_setup``
            # with the plain sentence and Bedrock's own words. ``on`` is written only after a shot that came back
            # (a story's scene keeps its own handling). A timeout or a throttle proved nothing and is only this
            # job's failure: the record is left as it was.
            if e.state == "needs_setup":
                last = said(e.last_error or REEL_SETUP, e.detail)
            elif e.state == "on":
                last = said(SHOT_FAILED, e.detail)
            else:
                raise
            await self.data.write(self.fence, puts=[self._record("needs_setup", last)])
            raise
        finally:
            await self._clean(prefix)
        self.report(1, 1)
        await self.data.write(self.fence, puts=[self._record("on", None)])
        await self.provider_usage(self.content_id, self.svc.video_model_id, provider=self.content_id,
                                  units=REEL_SHOT, unit="second", videoSec=REEL_SHOT, shots=1)  # fmt: skip

    async def _clean(self, prefix: str) -> None:
        """Deletes every file of the test shot (the shot, its manifest and status files); a failure is logged and
        left to the bucket's 14-day expiry."""
        if self.svc.us_s3 is None:
            return
        try:
            s3 = self.svc.us_s3()
            bucket = self.svc.video_bucket
            listed = await asyncio.to_thread(s3.list_objects_v2, Bucket=bucket, Prefix=prefix)
            found = [
                {"Key": str(o["Key"])} for o in listed.get("Contents") or [] if str(o.get("Key", "")).startswith(prefix)
            ]
            if found:
                await asyncio.to_thread(s3.delete_objects, Bucket=bucket, Delete={"Objects": found, "Quiet": True})
            log("info", "stories.provider_check_cleaned", job=self.fence.job_id, files=len(found))
        except Exception as e:
            log("warn", "stories.provider_check_clean_failed", job=self.fence.job_id, error=type(e).__name__)
