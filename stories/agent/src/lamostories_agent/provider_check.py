"""**Try it** for a video maker that is only shown ``on`` after a real call (docs/CONTRACTS.md §45.31, §45.34,
§45.35 D2, §45.37 G7): a ``provider_check`` job with one step, ``check`` ("Try it").

Luma AI Ray2 has one (it moved from Amazon Nova Reel, which Amazon ended on 30 September 2026: a Try it of Nova
Reel ends with the ended line and calls nothing), and so has the owner's own video model (``own-video``: one test shot
of the picked own model, or its first, into the shots' bucket of that model's Region, proving
``PROVIDER#animation#own-video``). Every record names the ``model`` key it was made with (§45.37: the API counts a
proof only for the model in use). With the us-west-2 bucket switched on (``CF_VIDEO_WEST_BUCKET``) the
job makes one 5-second test shot there (Amazon bills it like any shot) with the workspace's Luma model, under
``ws/{userId}/{workspaceId}/checks/luma-ray/{jobId}/``. A shot that came back proves the maker:
``PROVIDER#animation#luma-ray`` is written ``on``, and the usage is recorded. Only a shot that came back does that: a
refusal, or a shot Bedrock took but could not make (``Failed``, or written somewhere else), records ``needs_setup``
and the plain sentence, with Bedrock's own words when it gave some, so Settings never shows Luma AI Ray2 ready after a
Try it that failed. A timeout or a throttle proved nothing and leaves the record as it was. Every failure tells the
owner to tap Try it again (the button the Settings row has). The test shot's files are deleted whatever happened.
With the bucket off nothing is called and the job ends with the API's own not-ready sentence. The fencing, heartbeat
and last write are a story job's (``pipeline.Job``)."""

from __future__ import annotations

import asyncio
from typing import Any, ClassVar

from . import config, keys
from .pipeline import Job, StoryFailed
from .providers import (
    LUMA_NOT_READY,
    LUMA_SETUP,
    NO_OWN_MODEL,
    NOT_ITS_MODEL,
    AiVideo,
    LumaRay,
    NovaReel,
    OwnVideo,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    bundled_label,
    ended_line,
    provider_item,
)
from .util import JobSuperseded, log, now_iso

PROVIDERS = ("luma-ray", "own-video")  # the makers Try it can check (a start without providerId tries the first)
MAKERS: dict[str, type[AiVideo]] = {"luma-ray": LumaRay, "own-video": OwnVideo}
UNKNOWN = "Clips Funded can only try Luma AI Ray2 and your own video model here."
TRIED = "It made a 5-second test shot. Luma AI Ray2 is ready."
TRIED_OWN = "It made a {seconds}-second test shot. {label} is ready."
FAILED = "Trying Luma AI Ray2 did not finish. Tap Try it again."
FAILED_OWN = "Trying {label} did not finish. Tap Try it again."
SHOT_FAILED = (  # Bedrock took the test shot but could not make it: a setup problem every scene would hit
    "Luma AI Ray2 could not make its test shot. Tap Try it again in Settings › Video, or pick the Built-in "
    "animator there."
)
SHOT_FAILED_OWN = (
    "{label} could not make its test shot. Tap Try it again in Settings › Video, or pick the Built-in animator there."
)
PROMPT = (
    "Slow cinematic shot of a quiet country road on a sunny day, at eye level, no people, no text, no logos, calm "
    "camera, natural light"
)
SIZE = (1280, 720)  # a wide test shot (16:9)
SEED = 7


def said(sentence: str, detail: str | None) -> str:
    """The plain sentence, then Bedrock's own words when it gave some (what Try it records, §45.35 D2)."""
    return f"{sentence} Bedrock said: “{detail.strip()}”" if detail and detail.strip() else sentence


class ProviderCheckJob(Job):
    """One Try it run (``jobType`` ``provider_check``); ``content_id`` is the provider's id (``luma-ray`` or
    ``own-video``)."""

    _entry: dict[str, Any] | None = None  # the model this Try it shoots with, once it is known

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
            return await self._fail(self._words(FAILED, FAILED_OWN), e)
        self._step(step).update({"status": "done", "message": self._tried(), "finishedAt": now_iso()})
        async with self._job_lock:
            self._closed = True
            await self.data.update_job(
                self.fence,
                {"status": "ready", "steps": self.steps, "progress": 1.0, "meta": self.meta, "heartbeatAt": now_iso()},
            )
        log("info", "stories.provider_check_done", job=self.fence.job_id, provider=self.content_id)
        return "ready"

    @property
    def _own(self) -> bool:
        return self.content_id == "own-video"

    def _label(self) -> str:
        return str((self._entry or {}).get("label") or MAKERS.get(self.content_id, LumaRay).label)

    def _words(self, luma: str, own: str) -> str:
        """Luma AI Ray2's own sentence, or the own video model's with its label."""
        return own.format(label=self._label()) if self._own else luma

    def _tried(self) -> str:
        if not self._own:
            return TRIED
        seconds = OwnVideo(ProviderContext(engine=self.engine, workdir=self.work)).shot_seconds(self._entry)
        return TRIED_OWN.format(seconds=seconds, label=self._label())

    def _sentence(self, e: ProviderFailed) -> str:
        """The job's own sentence: a refusal says what to set up (the API's own not-ready line); anything else says
        to tap Try it again, never a story's "Tap Try again" (there is no such button on the Settings row)."""
        if e.state == "needs_setup":
            return e.sentence
        if e.state == "on":
            return self._words(SHOT_FAILED, SHOT_FAILED_OWN)
        return self._words(FAILED, FAILED_OWN)

    def _record(self, state: str, last_error: str | None) -> dict[str, Any]:
        model = str((self._entry or {}).get("key") or "") or None
        return provider_item(self.fence.pk, self.fence.user_id, self.fence.workspace_id, "animation", self.content_id,
                             state, now_iso(), last_error, model)  # fmt: skip

    async def _model(self) -> dict[str, Any]:
        """The model Try it uses (read for this job, §45.37 G1): the workspace's pick when its video maker is this
        maker, else the maker's first model that has not ended. A pick that is no longer one of the maker's models
        stops with the story job's own sentence before any call: Try it never tests another model in its place (it
        would show ready while every story stops on that pick)."""
        maker = MAKERS[self.content_id]
        ws = await self.data.workspace(self.fence.user_id, self.fence.workspace_id)
        providers = ((ws or {}).get("configuration") or {}).get("providers") or {}
        picked = (
            providers.get("videoModel")
            if isinstance(providers, dict) and providers.get("video") == self.content_id
            else None
        )
        makers = await self.makers()
        entry = config.pick_model("video", self.content_id, picked or None, makers)
        if entry is None and picked:
            raise ProviderUnavailable(NOT_ITS_MODEL.format(what="video", label=maker.label))
        if entry is None:
            raise ProviderUnavailable(NO_OWN_MODEL.format(what="video") if self._own else LUMA_SETUP)
        if config.ended(entry):
            raise ProviderUnavailable(ended_line("animation", entry, str(entry.get("label") or maker.label)))
        return entry

    async def _try(self) -> None:
        if self.content_id == "nova-reel":  # ended by Amazon: nothing is called (§45.37 G7)
            raise ProviderUnavailable(
                ended_line("animation", None, bundled_label(NovaReel.id, "animation", NovaReel.label))
            )
        if self.content_id not in PROVIDERS:
            raise StoryFailed(UNKNOWN)
        if not self._own and not self.svc.video_west_bucket:  # nothing is called: the API's own sentence, no record
            raise ProviderUnavailable(LUMA_NOT_READY)
        entry = await self._model()
        self._entry = entry
        self.meta["videoModel"] = entry["key"]
        prefix = keys.check_prefix(self.fence.user_id, self.fence.workspace_id, self.content_id, self.fence.job_id)
        ctx = ProviderContext(
            engine=self.engine,
            workdir=self.work,
            video_model=entry,
            bedrock=self.svc.bedrock_runtime,
            s3_in=self.svc.s3_in,
            video_bucket=self.svc.video_bucket,
            video_west_bucket=self.svc.video_west_bucket,
            reel_prefix=lambda _: prefix,
            sleep=self.svc.reel_sleep,
        )
        maker = MAKERS[self.content_id](ctx)
        if not maker.bucket(entry):  # an own model in a Region whose shots bucket is off: nothing is called
            raise ProviderUnavailable(maker.not_ready)
        try:
            await maker.shot(PROMPT, SEED, SIZE[0], SIZE[1], prefix)
        except ProviderFailed as e:
            # A refusal, or a shot Bedrock took but could not make, proved the maker is not ready: ``needs_setup``
            # with the plain sentence and Bedrock's own words. ``on`` is written only after a shot that came back (a
            # story's scene keeps its own handling). A timeout or a throttle proved nothing and is only this job's
            # failure: the record is left as it was.
            if e.state == "needs_setup":
                last = said(e.last_error or maker.setup_line(), e.detail)
            elif e.state == "on":
                last = said(self._words(SHOT_FAILED, SHOT_FAILED_OWN), e.detail)
            else:
                raise
            await self.data.write(self.fence, puts=[self._record("needs_setup", last)])
            raise
        finally:
            await self._clean(maker, entry, prefix)
        self.report(1, 1)
        await self.data.write(self.fence, puts=[self._record("on", None)])
        seconds = maker.shot_seconds(entry)
        await self.provider_usage(self.content_id, str(entry.get("modelId") or ""), provider=self.content_id,
                                  units=seconds, unit="second", videoSec=seconds, shots=1)  # fmt: skip

    async def _clean(self, maker: AiVideo, entry: dict[str, Any], prefix: str) -> None:
        """Deletes every file of the test shot (the shot and anything Bedrock wrote next to it) in the bucket of the
        model's Region; a failure is logged and left to the bucket's 14-day expiry."""
        if self.svc.s3_in is None:
            return
        try:
            s3 = self.svc.s3_in(maker._region(entry))
            bucket = maker.bucket(entry)
            listed = await asyncio.to_thread(s3.list_objects_v2, Bucket=bucket, Prefix=prefix)
            found = [
                {"Key": str(o["Key"])} for o in listed.get("Contents") or [] if str(o.get("Key", "")).startswith(prefix)
            ]
            if found:
                await asyncio.to_thread(s3.delete_objects, Bucket=bucket, Delete={"Objects": found, "Quiet": True})
            log("info", "stories.provider_check_cleaned", job=self.fence.job_id, files=len(found))
        except Exception as e:
            log("warn", "stories.provider_check_clean_failed", job=self.fence.job_id, error=type(e).__name__)
