"""The ten pipeline steps (docs/CONTRACTS.md §8) wired to S3, DynamoDB, Transcribe, Bedrock, yt-dlp and ffmpeg.

Every step is safe to run again: inputs already in S3 from an earlier run of the same job (audio, words, loudness,
the picture parts, what the watchers saw) are reused, which is what makes Retry cheap.

The deep analysis (docs/DECISIONS.md ADR-40) is the picture half: ``download`` starts preparing the picture in the
background, ``watch`` lets two models watch all of it, ``select`` reads the merged signals and takes a second look
at each picked moment. Every part of it is optional at run time: whatever fails is logged and the job picks from the
signals it has, down to exactly what it did before the picture was watched."""

from __future__ import annotations

import asyncio
import contextlib
import functools
import os
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import captions as captions_mod
from . import learnings, loudness, nova, proc, sources, verify, watch
from . import picture as picture_mod
from . import signals as signals_mod
from . import vectors as vectors_mod
from .agent import Brief, find_moments
from .bedrock import Bedrock, FrameLayout, ModelError
from .checklist import (
    REVIEW_SCHEMA,
    Candidate,
    Item,
    Outcome,
    check_all,
    critical_failure,
    judged_items,
    measure,
    measured_items,
    plan_fix,
    review_prompt,
)
from .config import Config
from .creators import creator_keys, creator_name
from .guard import Deadline, fable_budget, nova_budget
from .jobs import StepDone, StepFn, Tracker
from .moments import Moment, length_target
from .render import render_clip
from .skills import SkillsBlock, SkillSet, prepare_skills, skills_block
from .store import Fence, Store, clip_prefix, cookies_key, source_prefix
from .transcribe import PART_SECONDS, Transcriber, job_name, language_of, parse_items, parse_speakers
from .util import JobCanceled, JobSuperseded, TransientError, UserFacingError, gather_all, hms, log, now_iso, ulid

RENDER_CONCURRENCY = 2
SPOKEN_CHARS = 1000  # the start of what a clip says, for the daily second look (§16.12)
FEW_WORDS = 20
NOT_WATCHED = "Could not watch the video this time. Picking from the words and the sound."
MOTION_ONLY = "Saw where the picture moves fast. Picking with that, the words and the sound."
ALMOST_NO_SPEECH = (
    "Almost no speech was found in this video, so there is nothing to pick moments from. "
    "Clip Factory needs talking or commentary."
)


def count(n: int, word: str) -> str:
    """``1 clip``, ``2 clips``, ``4,812 words``: step messages are read by the owner, so no "clip(s)"."""
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def prep_deadline(seconds: float) -> float:
    """How long the watch step waits for the picture, counted from when its preparation started: the same limit the
    decode itself has (picture.time_limit), so neither cuts the other short."""
    return picture_mod.time_limit(seconds)


def watch_deadline(seconds: float) -> float:
    """How long the two watchers get. It grows with the source: a long video is never sampled, it gets more time."""
    return max(25 * 60.0, 0.2 * seconds)


@dataclass
class JobState:
    job_id: str
    user_id: str
    workdir: Path
    session_id: str | None = None  # the run's runtime session; job and clip writes are fenced on it
    job: dict[str, Any] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)
    source: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    cookies: Path | None = None
    words: list[list[Any]] = field(default_factory=list)
    loud: list[float] = field(default_factory=list)
    skills: SkillSet = field(default_factory=lambda: SkillSet([]))
    skills_block: SkillsBlock | None = None  # built once in analyze; every model call gets it (§18.6)
    prior: list[str] = field(default_factory=list)  # "Prior learnings": active creator lessons (§16.12)
    week_learnings: list[str] = field(default_factory=list)
    similar: list[vectors_mod.Hit] = field(default_factory=list)
    chosen: list[Moment] = field(default_factory=list)
    spares: list[Moment] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    captions: dict[str, dict[str, str]] = field(default_factory=dict)
    clip_ids: dict[int, str] = field(default_factory=dict)
    # The deep analysis (ADR-40); every one of these may stay empty and the job still makes its clips.
    picture_task: asyncio.Task[None] | None = None  # the background picture preparation started by download
    picture_started: float = 0.0  # loop time the preparation started (the watch step's wait counts from here)
    picture: picture_mod.Picture | None = None
    frames: picture_mod.Frames | None = None
    signals: signals_mod.Signals | None = None
    speakers: list[list[Any]] | None = None
    second_look: list[dict[str, Any]] = field(default_factory=list)

    @property
    def notes(self) -> str:
        return str(self.job.get("notes") or "")

    @property
    def length(self) -> tuple[float, float]:
        return length_target(self.notes)

    @property
    def clip_target(self) -> tuple[int, int]:
        t = self.job.get("clipTarget") or {}
        lo = int(t.get("min") or self.settings.get("clipMin") or 5)
        hi = int(t.get("max") or self.settings.get("clipMax") or 10)
        lo = max(1, min(10, lo))
        return lo, max(lo, min(10, hi))

    @property
    def duration(self) -> float:
        return float(self.meta.get("audioSeconds") or self.source.get("durationSec") or 0)

    def key(self, name: str) -> str:
        return source_prefix(self.job_id) + name

    @property
    def block(self) -> SkillsBlock:
        """The skills block for a model call. ``analyze`` always runs first, so a job never calls a model without
        the owner's skills."""
        if self.skills_block is None:
            raise RuntimeError("the skills block is built in analyze, before any model call")
        return self.skills_block

    @property
    def fence(self) -> Fence | None:
        return Fence(self.user_id, self.job_id, self.session_id) if self.session_id else None


class Pipeline:
    def __init__(
        self,
        cfg: Config,
        store: Store,
        bedrock: Bedrock,
        transcriber: Transcriber,
        *,
        vectors: vectors_mod.Vectors | None = None,
        watch_bedrock: Bedrock | None = None,
    ) -> None:
        self.cfg = cfg
        self.store = store
        self.bedrock = bedrock
        self.transcriber = transcriber
        self.vectors = vectors  # None: no clip vectors and no "what worked before"
        self.watch_bedrock = watch_bedrock  # the second watcher (Nova); None: that track is skipped

    def steps(self, st: JobState, tr: Tracker) -> list[tuple[str, StepFn]]:
        def bind(fn: Any) -> StepFn:
            return lambda: fn(st, tr)

        return [
            ("resolve", bind(self.resolve)),
            ("download", bind(self.download)),
            ("transcribe", bind(self.transcribe)),
            ("analyze", bind(self.analyze)),
            ("watch", bind(self.watch)),
            ("select", bind(self.select)),
            ("render", bind(self.render)),
            ("checklist", bind(self.checklist)),
            ("captions", bind(self.write_captions)),
            ("finalize", bind(self.finalize)),
        ]

    # --- resolve ---------------------------------------------------------------------------------------------

    async def resolve(self, st: JobState, tr: Tracker) -> str:
        job = await self.store.get_job(st.user_id, st.job_id)
        if not job:
            raise UserFacingError("This job no longer exists.")
        st.job = job
        st.settings = await self.store.get_settings(st.user_id)
        st.source = dict(job.get("source") or {})
        st.workdir.mkdir(parents=True, exist_ok=True)
        await self._clear_previous_clips(st)
        if await self.store.exists(st.key("meta.json")):
            st.meta = await self.store.get_json(st.key("meta.json"))
        if st.source.get("type") == "upload":
            await self._resolve_upload(st)
        else:
            await self._resolve_link(st, tr)
        await self.store.put_json(st.key("meta.json"), st.meta)
        await self.store.update_job(
            st.user_id,
            st.job_id,
            {"source": st.source, **creator_fields(st.source)},
            unless_canceled=True,
            session_id=st.session_id,
        )
        title = st.source.get("title") or "the video"
        length = f" ({hms(st.source['durationSec'])})" if st.source.get("durationSec") else ""
        return f"Found {title}{length}."

    async def _clear_previous_clips(self, st: JobState) -> None:
        """A retried job starts over: clips of an earlier run still waiting for review are removed.

        Each removal is fenced on this run's session, so a stale run never removes a newer run's clips; the files
        go only after their item is gone (a clip item never points at deleted files)."""
        for c in await self.store.job_clips(st.job_id):
            if c.get("status") == "review" and c.get("userId") == st.user_id:
                await self.store.delete_item(c["pk"], c["sk"], fence=st.fence)
                await self.store.delete_keys([k for k in (c.get("videoKey"), c.get("coverKey")) if k])

    async def _resolve_link(self, st: JobState, tr: Tracker) -> None:
        url = str(st.source.get("url") or "")
        platform = sources.check_link(url)
        if platform == "youtube" and await self.store.exists(cookies_key(st.user_id)):
            st.cookies = st.workdir / "cookies.txt"
            await self.store.download(cookies_key(st.user_id), st.cookies)
            os.chmod(st.cookies, 0o600)
        try:
            info = await sources.video_info(url, st.cookies)
        except proc.CommandError as e:
            raise sources.explain(e, platform, st.cookies is not None) from e
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            raise UserFacingError("This stream is still live or has not started. Try again once it has ended.")
        st.source.update(sources.source_fields(info, platform))
        st.meta["heatmap"] = sources.heatmap(info)
        st.meta["webpageUrl"] = info.get("webpage_url") or url
        st.meta["picture"] = self._pick_picture(st, info)

    def _pick_picture(self, st: JobState, info: dict[str, Any]) -> dict[str, Any] | None:
        """Which small rendition the deep analysis will watch (``meta.picture``); None when none fits the disk."""
        if not self.cfg.deep_enabled:
            return None
        try:
            total = float(st.source.get("durationSec") or 0)
            seconds = min(total, self._cap(st)) if total else self._cap(st)
            return sources.picture_format(info, seconds, shutil.disk_usage(st.workdir).free)
        except Exception as e:
            log("warn", "picture.format_failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:300])
            return None

    async def _resolve_upload(self, st: JobState) -> None:
        key = str(st.source.get("key") or "")
        if not key.startswith(f"uploads/{st.user_id}/"):
            raise UserFacingError("The uploaded file could not be found. Upload it again.")
        video_key = st.key("video.mp4")
        if not await self.store.exists(video_key):
            if not await self.store.exists(key):
                raise UserFacingError("The uploaded file has expired or was removed. Upload it again.")
            await self.store.copy(key, video_key)
        info = await proc.probe(self.store.presign(video_key))
        if not info.has_video:
            raise UserFacingError("The uploaded file has no video in it.")
        st.source.update(platform="upload", durationSec=round(info.duration, 2))
        st.source.setdefault("title", str(st.source.get("filename") or "Uploaded video"))
        st.meta["hasAudio"] = info.has_audio
        st.meta["picture"] = {"upload": True, "height": info.height, "fps": info.fps} if self.cfg.deep_enabled else None

    # --- download --------------------------------------------------------------------------------------------

    def _cap(self, st: JobState) -> float:
        return float(st.settings.get("maxSourceHours") or 6) * 3600

    async def download(self, st: JobState, tr: Tracker) -> StepDone:
        """The sound first, exactly as before the picture was watched, and it must succeed. Only then does the
        picture start preparing in the background (``_picture_prep``), so it overlaps the transcription."""
        done = await self._download_audio(st, tr)
        await self._start_picture(st)
        return done

    async def _download_audio(self, st: JobState, tr: Tracker) -> StepDone:
        cap = self._cap(st)
        total = float(st.source.get("durationSec") or 0)
        need = min(total, cap) if total else cap
        audio_key = st.key("audio.m4a")
        if await self.store.exists(audio_key) and float(st.meta.get("audioSeconds") or 0) >= need - 60:
            return StepDone("Used the sound from last time.")
        local = st.workdir / "source" / "audio.m4a"
        local.parent.mkdir(parents=True, exist_ok=True)
        capped = bool(total and total > cap)
        if st.source.get("type") == "upload":
            if st.meta.get("hasAudio") is False:
                raise UserFacingError("The uploaded video has no sound, so there is nothing to transcribe.")
            await proc.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    self.store.presign(st.key("video.mp4"), 6 * 3600),
                    "-vn",
                    "-t",
                    str(int(cap)),
                    "-ac",
                    "1",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "96k",
                    str(local),
                ],
                time_limit=6 * 3600,
            )
        else:
            platform = str(st.source.get("platform"))
            try:
                await sources.download_audio(
                    str(st.source["url"]),
                    local.parent,
                    max_seconds=cap if capped or not total else None,
                    cookies=st.cookies,
                    on_progress=lambda f: tr.report(0.9 * f),
                )
            except proc.CommandError as e:
                raise sources.explain(e, platform, st.cookies is not None) from e
        info = await proc.probe(str(local))
        if info.duration < 10:
            raise UserFacingError("The video is too short to clip (under 10 seconds of audio).")
        await self.store.upload(local, audio_key, "audio/mp4")
        st.meta["audioSeconds"] = round(info.duration, 2)
        await self.store.put_json(st.key("meta.json"), st.meta)
        note = f" (the first {hms(cap)} of {hms(total)})" if capped else ""
        return StepDone(f"Got {hms(info.duration)} of sound{note}.")

    # --- the picture, prepared in the background -------------------------------------------------------------

    def _deep(self, st: JobState, part: str, status: str, reason: str | None = None) -> None:
        """``meta.deep``: how each optional part of the deep analysis went (ok, partial or skipped, and why)."""
        st.meta.setdefault("deep", {})[part] = {"status": status, **({"reason": reason} if reason else {})}

    async def _saved_json(self, key: str) -> Any:
        """A JSON file of an earlier run, or None; a failure to read it is the same as not having it."""
        try:
            return await self.store.get_json(key) if await self.store.exists(key) else None
        except Exception as e:
            log("warn", "deep.read_failed", key=key, error=type(e).__name__)
            return None

    async def _start_picture(self, st: JobState) -> None:
        if st.picture_task is not None and not st.picture_task.done():
            return
        if not self.cfg.deep_enabled:
            self._deep(st, "prep", "skipped", "off")
            return
        if not st.meta.get("picture"):
            self._deep(st, "prep", "skipped", "no picture that fits")
            return
        if signals_mod.log_covers(await self._saved_json(st.key("visual_log.json")), st.duration):
            return  # an earlier run watched it all: the watch step reuses that
        st.picture_started = asyncio.get_running_loop().time()
        st.picture_task = asyncio.create_task(self._picture_prep(st), name=f"picture-{st.job_id}")

    async def _picture_prep(self, st: JobState) -> None:
        """Never raises (but for a cancel): a picture that cannot be prepared only skips the watching."""
        try:
            st.picture = await self._prepare_picture(st)
            self._deep(st, "prep", "ok")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log("warn", "picture.prep_failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:500])
            self._deep(st, "prep", "skipped", type(e).__name__)

    async def _prepare_picture(self, st: JobState) -> picture_mod.Picture:
        seconds = st.duration
        saved = await self._saved_json(st.key("picture.json"))
        if saved:
            pic = picture_mod.Picture.from_json(saved)
            if pic.parts and pic.seconds >= seconds - 60:
                return pic  # a retried job: the parts are in S3 already
        try:
            return await self._make_picture(st, seconds)
        except BaseException:
            # Failed, timed out or canceled: nothing it left behind may sit beside render's downloads.
            self._drop_picture_files(st)
            raise
        finally:
            for f in (st.workdir / "source").glob("picture.*"):
                f.unlink(missing_ok=True)  # the downloaded source (and yt-dlp's .part files): the parts are enough

    def _drop_picture_files(self, st: JobState) -> None:
        shutil.rmtree(st.workdir / "picture", ignore_errors=True)
        for f in (st.workdir / "source").glob("picture.*"):
            f.unlink(missing_ok=True)

    async def _make_picture(self, st: JobState, seconds: float) -> picture_mod.Picture:
        chosen = dict(st.meta.get("picture") or {})
        cap = self._cap(st)
        total = float(st.source.get("durationSec") or 0)
        capped = bool(total and total > cap)
        local = st.workdir / "picture"
        if chosen.get("upload"):
            src = self.store.presign(st.key("video.mp4"), 6 * 3600)
            keyframes = False
            if picture_mod.keyframes_only(int(chosen.get("height") or 0), seconds):
                # A tall, long upload: every frame only when two CPUs can decode it in time (measured, not guessed).
                speed = await picture_mod.decode_speed(src)
                keyframes = not picture_mod.full_decode_fits(seconds, speed)
                log("info", "picture.decode_speed", job=st.job_id, speed=round(speed, 2), keyframes=keyframes)
        else:
            est = int(chosen.get("estBytes") or 0)
            free = shutil.disk_usage(st.workdir).free
            if est > free - picture_mod.DISK_RESERVE:
                raise OSError(f"not enough disk for the picture ({est} bytes wanted, {free} free)")
            downloaded = await sources.download_picture(
                str(st.meta.get("webpageUrl") or st.source["url"]),
                str(chosen["formatId"]),
                st.workdir / "source" / "picture.mp4",
                est_bytes=est,
                max_seconds=cap if capped or not total else None,
                cookies=st.cookies,
            )
            src, keyframes = str(downloaded), False
        files, motion, scene = await picture_mod.prepare(
            src, local, seconds=seconds, keyframes=keyframes, limit_seconds=cap if capped else None
        )
        for f in (st.workdir / "source").glob("picture.*"):
            f.unlink(missing_ok=True)  # the parts are all the analysis needs
        if not files:
            raise ValueError("the picture had no frames")
        parts: list[picture_mod.Part] = []
        for i, f in enumerate(files):
            if f.stat().st_size > picture_mod.PART_MAX_BYTES:
                await picture_mod.shrink(f)
            key = st.key(f"picture/part-{i:04d}.mp4")
            await self.store.upload(f, key, "video/mp4")
            start = float(i * picture_mod.PART_SECONDS)
            parts.append(picture_mod.Part(i, start, start + picture_mod.PART_SECONDS, key, f.stat().st_size))
        last = (await proc.probe(str(files[-1]))).duration
        parts[-1].end = round(parts[-1].start + (last or picture_mod.PART_SECONDS), 2)
        pic = picture_mod.Picture(
            seconds=parts[-1].end, parts=parts, motion=motion, scene=scene, decode="keyframes" if keyframes else "all"
        )
        st.meta.setdefault("deep", {})["decode"] = {"status": "ok", "mode": pic.decode}  # every frame, or keyframes
        await self.store.put_json(st.key("picture.json"), pic.to_json())
        log("info", "picture.ready", job=st.job_id, parts=len(parts), seconds=pic.seconds, decode=pic.decode)
        return pic

    async def close(self, st: JobState) -> None:
        """The run is over, however it ended: the background picture preparation stops (its yt-dlp or ffmpeg is
        killed by ``proc.run``). Called by the server in its ``finally``."""
        task = st.picture_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _local_audio(self, st: JobState) -> Path:
        local = st.workdir / "source" / "audio.m4a"
        if not local.is_file():
            await self.store.download(st.key("audio.m4a"), local)
        return local

    # --- transcribe ------------------------------------------------------------------------------------------

    async def transcribe(self, st: JobState, tr: Tracker) -> StepDone:
        if await self.store.exists(st.key("words.json")):
            st.words = await self.store.get_json(st.key("words.json"))
            st.meta["fewWords"] = len(st.words) < FEW_WORDS
            return StepDone("Used the words from last time.")
        audio = await self._local_audio(st)
        parts: list[tuple[str, float, float]] = []  # (s3 key, offset, seconds)
        if st.duration > PART_SECONDS:
            pattern = st.workdir / "source" / "part%03d.m4a"
            await proc.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-i",
                    str(audio),
                    "-f",
                    "segment",
                    "-segment_time",
                    str(PART_SECONDS),
                    "-c",
                    "copy",
                    "-reset_timestamps",
                    "1",
                    str(pattern),
                ],
                time_limit=3600,
            )
            offset = 0.0
            for i, f in enumerate(sorted(pattern.parent.glob("part*.m4a"))):
                seconds = (await proc.probe(str(f))).duration
                await self.store.upload(f, st.key(f"audio.part{i}.m4a"), "audio/mp4")
                parts.append((st.key(f"audio.part{i}.m4a"), offset, seconds))
                offset += seconds
        else:
            parts.append((st.key("audio.m4a"), 0.0, st.duration))
        attempt = ulid()[-6:].lower()
        done = [0.0] * len(parts)

        def progress(i: int, f: float) -> None:
            done[i] = f
            tr.report(sum(done) / len(done))

        async def one(
            i: int, key: str, offset: float, seconds: float
        ) -> tuple[list[tuple[float, float, str]], dict[str, Any], list[tuple[float, float, str]]]:
            # Part outputs carry the attempt, so a job left over from an earlier attempt never writes the key
            # this attempt reads.
            out_key = st.key("transcript.json" if len(parts) == 1 else f"transcript.part{i}.{attempt}.json")
            name = job_name(st.job_id, i, attempt)
            try:
                job = await self.transcriber.run(
                    name,
                    key,
                    out_key,
                    expected_seconds=seconds,
                    check_cancel=tr.check_cancel,
                    on_progress=lambda f: progress(i, f),
                    speakers=self.cfg.deep_enabled,  # CF_DEEP=off: the request exactly as before ADR-40
                )
            except BaseException:
                await self.transcriber.stop(name)
                raise
            await self.store.tag_temporary(out_key)  # Transcribe cannot tag its own output (docs/CONTRACTS.md §7)
            doc = await self.store.get_json(out_key)
            return parse_items(doc, offset), job, parse_speakers(doc, offset)

        # One failed part cancels (and stops) the others before the step is retried or fails.
        results = await gather_all(*(one(i, *p) for i, p in enumerate(parts)))
        st.words = [list(w) for words, _, _ in results for w in words]
        st.meta["language"] = language_of([j for _, j, _ in results])
        # Almost no words is no longer the end here: the picture may still carry clips (select decides).
        st.meta["fewWords"] = len(st.words) < FEW_WORDS
        turns = [list(t) for _, _, who in results for t in who] if self.cfg.deep_enabled else []
        if turns:
            st.speakers = turns
            await self.store.put_json(st.key("speakers.json"), turns)
        self._deep(st, "speakers", "ok" if turns else "skipped", None if turns else "no speaker labels")
        await self.store.put_json(st.key("words.json"), st.words)
        await self.store.put_json(st.key("meta.json"), st.meta)
        return StepDone(f"Wrote down {count(len(st.words), 'word')}.")

    # --- analyze ---------------------------------------------------------------------------------------------

    async def analyze(self, st: JobState, tr: Tracker) -> str:
        if await self.store.exists(st.key("loudness.json")):
            st.loud = await self.store.get_json(st.key("loudness.json"))
        else:
            st.loud = await loudness.measure(await self._local_audio(st), st.workdir)
            await self.store.put_json(st.key("loudness.json"), st.loud)
        if st.speakers is None and self.cfg.deep_enabled:
            st.speakers = await self._saved_json(st.key("speakers.json")) or None
        tr.report(0.6)
        # A failure to read the skill rows fails the step (and its normal retry runs): never a job without them.
        st.skills = await prepare_skills(
            st.workdir, self.cfg.skills_dir, await self.store.skill_rows(st.user_id), self.store.get_bytes
        )
        st.skills_block = skills_block(st.skills.docs, where="agent.job")
        taught = await learnings.load(self.store, st.user_id, creator_keys(st.source), datetime.now(UTC))
        st.week_learnings, st.prior = taught.week, taught.prior
        st.similar = await self._similar(st)
        spikes = len(loudness.spikes(st.loud, limit=10_000))
        log(
            "info",
            "analyze.used",
            job=st.job_id,
            skills=len(st.skills.docs),
            skipped=len(st.skills.skipped),
            learnings=len(taught),
            similar=len(st.similar),
        )
        unread = len(st.skills.skipped)
        note = f" {count(unread, 'skill')} could not be read." if unread else ""
        return f"Found {count(spikes, 'loud moment')}.{note}"

    async def _similar(self, st: JobState) -> list[vectors_mod.Hit]:
        """The owner's past clips most like this video, for "What worked before" (never fails the job)."""
        if self.vectors is None:
            return []
        text = vectors_mod.query_text(
            str(st.source.get("title") or st.source.get("filename") or ""),
            str(st.source.get("channel") or ""),
            st.notes,
            vectors_mod.transcript_text(st.words),
        )
        hits = await vectors_mod.what_worked_before(self.vectors, st.user_id, text)
        if not hits:
            return []
        # Only clips that still exist and were not declined: finalize writes vectors before the Clip items, so a
        # canceled or superseded run can leave a vector without a clip, and a decline racing finalize can leave one.
        try:
            statuses = await self.store.clip_statuses(st.user_id, [h.clip_id for h in hits])
        except Exception as e:
            log("warn", "vectors.clip_check_failed", error=type(e).__name__, detail=str(e)[:300])
            return []
        return [h for h in hits if statuses.get(h.clip_id, "declined") != "declined"]

    # --- watch -----------------------------------------------------------------------------------------------

    async def watch(self, st: JobState, tr: Tracker) -> StepDone:
        """Two models watch the whole picture. Never raises but for a cancel (or a newer run taking over): whatever
        goes wrong, the job goes on with the signals it has, so the job's three step attempts never repeat work."""
        try:
            return await self._watch(st, tr)
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("error", "watch.failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:800])
            return StepDone(NOT_WATCHED, skipped=True)

    def _build_signals(self, st: JobState, visual_log: dict[str, Any] | None) -> dict[str, Any] | None:
        """``st.signals`` from everything known; on any failure the finder simply gets what it got before."""
        try:
            st.signals = signals_mod.build(
                duration=st.duration,
                words=st.words,
                loud=st.loud,
                heatmap=list(st.meta.get("heatmap") or []),
                speakers=st.speakers,
                visual_log=visual_log,
                motion=st.picture.motion if st.picture else None,
            )
            return st.signals.to_json() if st.signals else None
        except Exception as e:
            log("error", "signals.build_failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:500])
            st.signals = None
            return None

    async def _await_picture(self, st: JobState, tr: Tracker) -> picture_mod.Picture | None:
        """Waits for the background preparation, up to its deadline (counted from when it started)."""
        task = st.picture_task
        if task is None:
            return st.picture
        limit = prep_deadline(st.duration)
        loop = asyncio.get_running_loop()
        while not task.done():
            await tr.check_cancel()
            waited = loop.time() - st.picture_started
            if waited > limit:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
                log("warn", "picture.prep_failed", job=st.job_id, error="deadline", detail=f"over {limit:.0f} s")
                self._deep(st, "prep", "skipped", "deadline")
                return None
            tr.report(0.2 * min(1.0, waited / limit))
            await asyncio.wait({task}, timeout=min(2.0, max(0.05, limit - waited)))
        return st.picture

    async def _watch(self, st: JobState, tr: Tracker) -> StepDone:
        if not self.cfg.deep_enabled:
            return StepDone(NOT_WATCHED, skipped=True)
        log_key = st.key("visual_log.json")
        earlier = await self._saved_json(log_key)
        if signals_mod.log_covers(earlier, st.duration):
            saved = await self._saved_json(st.key("picture.json"))
            st.picture = st.picture or (picture_mod.Picture.from_json(saved) if saved else None)
            self._use_frames(st)
            await self._save_signals(st, earlier)
            return StepDone("Used what it saw last time.")

        pic = await self._await_picture(st, tr)
        if pic is None or not pic.parts:
            await self.store.put_json(st.key("meta.json"), st.meta)
            return StepDone(NOT_WATCHED, skipped=True)
        tr.report(0.2)
        frames = self._use_frames(st)
        assert frames is not None
        units = watch.plan(pic.seconds)
        deadline = Deadline(watch_deadline(st.duration))
        share = {"fable": 0.0, "nova": 0.0}

        def progress(who: str, f: float) -> None:
            share[who] = f
            tr.report(0.2 + 0.75 * (0.8 * share["fable"] + 0.2 * share["nova"]))

        def loader(prefix: str) -> Any:
            async def load(u: watch.Unit) -> dict[str, Any] | None:
                saved = await self._saved_json(st.key(f"watch/{prefix}-{u.i:04d}.json"))
                return saved if isinstance(saved, dict) else None

            return load

        def saver(prefix: str) -> Any:
            async def save(u: watch.Unit, body: dict[str, Any]) -> None:
                await self.store.put_json(st.key(f"watch/{prefix}-{u.i:04d}.json"), body)

            return save

        async def read_part(part: picture_mod.Part) -> bytes:
            local = frames.local(part)
            return local.read_bytes() if local.is_file() else await self.store.get_bytes(part.key)

        fable, second = await gather_all(
            watch.watch_chunks(
                units,
                bedrock=self.bedrock,
                skills=st.block,
                frames=frames,
                words=st.words,
                speakers=st.speakers,
                loud=st.loud,
                motion=pic.motion,
                budget=fable_budget(len(units)),
                deadline=deadline,
                check_cancel=tr.check_cancel,
                load=loader("chunk"),
                save=saver("chunk"),
                on_progress=lambda f: progress("fable", f),
            ),
            nova.watch_parts(
                pic.parts,
                bedrock=self.watch_bedrock,
                skills=st.block,
                read=read_part,
                budget=nova_budget(len(pic.parts)),
                deadline=deadline,
                check_cancel=tr.check_cancel,
                load=loader("nova"),
                save=saver("nova"),
                on_progress=lambda f: progress("nova", f),
            ),
        )
        self._deep(st, "fable", **_status(fable))
        self._deep(st, "nova", **_status(second))
        visual_log = signals_mod.make_visual_log(fable.ok, second.ok, fable.failures() + second.failures())
        # The signals first: a failed write of the reuse file loses only the reuse, never what was seen.
        await self._save_signals(st, visual_log)
        try:
            await self.store.put_json(log_key, visual_log)
        except Exception as e:
            log("warn", "watch.log_save_failed", job=st.job_id, error=type(e).__name__)
        log(
            "info",
            "watch.done",
            job=st.job_id,
            chunks=len(units),
            fable=len(fable.done),
            nova=len(second.done),
            novaParts=len(second.units),
            reused=fable.reused + second.reused,
            events=len(visual_log["events"]),
        )
        seen = sum(1 for u in units if signals_mod.covered_span(visual_log["coverage"], u.start, u.end))
        if seen == len(units):
            big = sum(1 for e in visual_log["events"] if int(e.get("intensity") or 0) >= signals_mod.STRONG)
            return StepDone(f"Watched all {hms(pic.seconds)}. Saw {big} big thing{'' if big == 1 else 's'}.")
        if seen:
            how = "most" if seen * 2 >= len(units) else "part"
            return StepDone(f"Watched {how} of the video ({seen} of {len(units)} parts).")
        if st.signals is not None and any(st.signals.motion):
            return StepDone(MOTION_ONLY)
        return StepDone(NOT_WATCHED, skipped=True)

    def _use_frames(self, st: JobState) -> picture_mod.Frames | None:
        """Frames by time for the watchers and the second look: from the local parts, else from S3."""
        if st.frames is None and st.picture is not None and st.picture.parts:
            st.frames = picture_mod.Frames(st.picture, st.workdir / "picture", self.store.download)
        return st.frames

    async def _save_signals(self, st: JobState, visual_log: dict[str, Any] | None) -> None:
        body = self._build_signals(st, visual_log)
        try:
            if body is not None:
                await self.store.put_json(st.key("signals.json"), body)
            await self.store.put_json(st.key("meta.json"), st.meta)
        except Exception as e:
            log("warn", "signals.save_failed", job=st.job_id, error=type(e).__name__)

    # --- select ----------------------------------------------------------------------------------------------

    def _brief(self, st: JobState) -> Brief:
        lo, hi = st.clip_target
        return Brief(
            title=str(st.source.get("title") or st.source.get("filename") or "Untitled"),
            channel=str(st.source.get("channel") or ""),
            platform=str(st.source.get("platform") or "upload"),
            duration=max(st.duration, float(st.words[-1][1]) if st.words else 0),
            notes=st.notes,
            clip_min=lo,
            clip_max=hi,
            length=st.length,
            words=st.words,
            loud=st.loud,
            heatmap=list(st.meta.get("heatmap") or []),
            prior=st.prior,
            week_learnings=st.week_learnings,
            language=st.meta.get("language"),
            similar=st.similar,
            signals=st.signals,
            speakers=st.speakers,
        )

    async def select(self, st: JobState, tr: Tracker) -> str:
        # The check that used to end the transcribe step: almost no words is only the end when the picture has
        # nothing strong to offer either.
        strong = st.signals is not None and any(e.intensity >= signals_mod.STRONG for e in st.signals.events)
        if (st.meta.get("fewWords") or len(st.words) < FEW_WORDS) and not strong:
            raise UserFacingError(ALMOST_NO_SPEECH)
        looking = st.frames is not None
        st.chosen, st.spares = await find_moments(
            self._brief(st),
            bedrock=self.bedrock,
            model_id=self.cfg.model_id,
            region=self.cfg.region,
            workdir=st.workdir,
            skill_names=[s.name for s in st.skills.docs],
            skills=st.block,
            on_progress=(lambda f: tr.report(0.8 * f)) if looking else tr.report,
        )
        await self._second_look(st, tr)
        for m in (*st.chosen, *st.spares):
            m.picked_for = self._picked_for(st, m)
        await self._after_select(st)
        log("info", "select.picked", job=st.job_id, chosen=len(st.chosen), spares=len(st.spares))
        return f"Picked {count(len(st.chosen), 'moment')}."

    async def _second_look(self, st: JobState, tr: Tracker) -> None:
        """Each picked moment and spare is checked against the picture (verify.py). Any failure keeps the picks."""
        if st.frames is None:
            self._deep(st, "secondLook", "skipped", "no picture")
            return
        try:
            st.chosen, st.spares, st.second_look = await verify.second_look(
                st.chosen,
                st.spares,
                bedrock=self.bedrock,
                skills=st.block,
                frames=st.frames,
                words=st.words,
                speakers=st.speakers,
                duration=max(st.duration, float(st.words[-1][1]) if st.words else 0),
                length=st.length,
                clip_min=st.clip_target[0],
                check_cancel=tr.check_cancel,
                on_progress=lambda f: tr.report(0.8 + 0.2 * f),
                prior=st.prior,
            )
            checked = sum(1 for r in st.second_look if "keep" in r)
            total = len(st.second_look)
            self._deep(st, "secondLook", "ok" if checked == total else "partial" if checked else "skipped")
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "verify.failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:500])
            self._deep(st, "secondLook", "skipped", type(e).__name__)

    def _picked_for(self, st: JobState, m: Moment) -> str | None:
        try:
            return signals_mod.picked_for(
                m,
                signals=st.signals,
                loud=st.loud,
                heatmap=list(st.meta.get("heatmap") or []),
                speakers=st.speakers,
            )
        except Exception as e:
            log("warn", "signals.picked_for_failed", job=st.job_id, error=type(e).__name__)
            return None

    async def _after_select(self, st: JobState) -> None:
        """``moments.json`` (for debugging a job afterwards) and the disk back for render. Neither can fail the job."""
        try:
            await self.store.put_json(
                st.key("moments.json"),
                {
                    "chosen": [m.to_dict() for m in st.chosen],
                    "spares": [m.to_dict() for m in st.spares],
                    "secondLook": st.second_look,
                },
            )
            await self.store.put_json(st.key("meta.json"), st.meta)
        except Exception as e:
            log("warn", "moments.save_failed", job=st.job_id, error=type(e).__name__)
        if st.frames is not None:
            st.frames.forget_local()

    def _has_speech(self, st: JobState, m: Moment) -> bool:
        return any(m.start <= float(w[0]) < m.end for w in st.words)

    # --- render ----------------------------------------------------------------------------------------------

    async def _fetch_section(self, st: JobState, start: float, end: float, dest: Path) -> Path:
        if st.source.get("type") == "upload":
            await proc.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    f"{start:.2f}",
                    "-to",
                    f"{end:.2f}",
                    "-i",
                    self.store.presign(st.key("video.mp4")),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "16",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    str(dest),
                ],
                time_limit=20 * 60,
            )
            return dest
        platform = str(st.source.get("platform"))
        url = str(st.meta.get("webpageUrl") or st.source["url"])
        try:
            return await sources.download_section(url, start, end, dest, st.cookies)
        except proc.CommandError as e:
            raise sources.explain(e, platform, st.cookies is not None, section=True) from e

    async def _cut(self, st: JobState, m: Moment, index: int, layout: FrameLayout | None = None) -> Candidate:
        workdir = st.workdir / "clips" / f"{index:02d}"

        async def fetch(a: float, b: float, dest: Path) -> Path:
            from .retry import retry

            return await retry(lambda: self._fetch_section(st, a, b, dest), what="section", attempts=3)

        r = await render_clip(
            m,
            words=st.words,
            workdir=workdir,
            fetch_section=fetch,
            detect_layout=functools.partial(self.bedrock.detect_layout, skills=st.block),
            known_layout=layout,
        )
        return Candidate(m, r, index=index)

    async def render(self, st: JobState, tr: Tracker) -> str:
        sem = asyncio.Semaphore(RENDER_CONCURRENCY)
        done = 0
        results: list[Candidate | None] = [None] * len(st.chosen)
        reasons: list[str] = []

        async def one(i: int, m: Moment) -> None:
            nonlocal done
            async with sem:
                await tr.check_cancel()
                try:
                    results[i] = await self._cut(st, m, i)
                except JobCanceled:
                    raise
                except Exception as e:
                    # One clip that can't be cut (a 403 on one section, a failed ffmpeg fragment) is skipped;
                    # only "none of them" fails the step.
                    if isinstance(e, UserFacingError):
                        reasons.append(str(e))
                    log(
                        "warn",
                        "render.clip_failed",
                        job=st.job_id,
                        index=i,
                        error=type(e).__name__,
                        detail=str(e)[:600],
                    )
            done += 1
            tr.report(done / len(st.chosen))

        # A cancel stops every cut still running before the job's workdir is removed.
        await gather_all(*(one(i, m) for i, m in enumerate(st.chosen)))
        st.candidates = [c for c in results if c]
        if not st.candidates:
            if reasons:
                raise UserFacingError(reasons[0])
            raise UserFacingError(
                "None of the clips could be cut. Tap Try again; if it happens again, try another video."
            )
        failed = len(st.chosen) - len(st.candidates)
        return f"Cut {count(len(st.candidates), 'clip')}" + (f"; {failed} could not be cut." if failed else ".")

    # --- checklist -------------------------------------------------------------------------------------------

    async def _review(self, st: JobState, c: Candidate) -> dict[str, Any]:
        try:
            return await self.bedrock.structured(
                # The review can write a new hook, so it gets "Prior learnings" too (§16.12).
                system=learnings.with_prior(
                    st.prior, "You review short vertical clips before they are posted, strictly but fairly."
                ),
                skills=st.block,
                content=[
                    {
                        "text": review_prompt(
                            c.moment,
                            c.render,
                            st.notes,
                            seen=signals_mod.seen_block(st.signals, c.moment.start, c.moment.end),
                        )
                    }
                ],
                tool="submit_review",
                description="Submit the checklist review of this clip.",
                schema=REVIEW_SCHEMA,
                max_tokens=8000,
            )
        except ModelError as e:
            # No judgement available: the measured checks decide, and the owner reviews every clip anyway.
            log("warn", "checklist.review_failed", error=str(e)[:200])
            note = "Claude could not review this clip; check it yourself."
            return {
                "zero_context": True,
                "zero_context_note": note,
                "pays_off": True,
                "pays_off_note": note,
                "hook_ok": True,
                "hook_note": note,
                "new_hook": None,
                "move_start_by": 0,
                "move_end_by": 0,
                "verdict": "keep",
            }

    async def _check_one(self, st: JobState, c: Candidate, index: int) -> Outcome:
        review = await self._review(st, c)
        items = measured_items(
            c.moment, c.render, await measure(c.render.video), st.length, has_speech=self._has_speech(st, c.moment)
        ) + judged_items(review)
        if review.get("verdict") == "drop":
            return Outcome(False, Candidate(c.moment, c.render, items, index=index), "Claude judged it unfixable.")
        fixes: list[str] = []
        if any(not i.passed for i in items):
            fixed, fixes = plan_fix(
                c.moment, items, review, length=st.length, first_loud=lambda t: loudness.first_loud_second(st.loud, t)
            )
            if fixes:
                c = await self._cut(st, fixed, index, layout=c.render.frame_layout)
                measured = measured_items(
                    c.moment,
                    c.render,
                    await measure(c.render.video),
                    st.length,
                    has_speech=self._has_speech(st, c.moment),
                )
                # Claude's judgement stands, except for what the fix addressed.
                judged = judged_items(
                    {
                        **review,
                        "pays_off": review.get("pays_off") or any("payoff" in f for f in fixes),
                        "hook_ok": review.get("hook_ok") or any(f.startswith("New hook") for f in fixes),
                    }
                )
                items = measured + judged
        bad = critical_failure(items)
        cand = Candidate(c.moment, c.render, items, fixes, index=index)
        return Outcome(bad is None, cand, f"{bad.label} {bad.note}" if bad else "")

    async def checklist(self, st: JobState, tr: Tracker) -> str:
        next_index = len(st.chosen)

        async def check(c: Candidate) -> Outcome:
            await tr.check_cancel()
            try:
                return await self._check_one(st, c, c.index)
            except (UserFacingError, TransientError, ModelError, proc.CommandError, OSError, ValueError) as e:
                # One clip that can't be checked or re-cut is replaced by a spare; it never fails the job.
                log("warn", "checklist.clip_failed", index=c.index, error=type(e).__name__, detail=str(e)[:400])
                return Outcome(False, c, "The clip could not be checked.")

        async def cut(m: Moment) -> Candidate | None:
            nonlocal next_index
            next_index += 1
            try:
                return await self._cut(st, m, next_index - 1)
            except Exception as e:
                log("warn", "checklist.spare_failed", error=type(e).__name__, detail=str(e)[:300])
                return None

        passed, failed = await check_all(
            st.candidates,
            st.spares,
            check=check,
            cut=cut,
            want=len(st.chosen),
            on_progress=lambda d, n: tr.report(d / max(1, n)),
        )
        if not passed:
            reasons = "; ".join(sorted({o.reason for o in failed if o.reason}))[:200]
            raise UserFacingError(f"No clip passed the checklist ({reasons}). Try another video or add notes.")
        st.candidates = passed
        replaced = sum(1 for c in passed if c.index >= len(st.chosen))
        msg = f"{count(len(passed), 'clip')} passed"
        return msg + (f"; {replaced} swapped for other moments." if replaced else ".")

    # --- captions --------------------------------------------------------------------------------------------

    async def write_captions(self, st: JobState, tr: Tracker) -> str:
        for c in st.candidates:
            st.clip_ids[id(c)] = ulid()
        texts = [
            captions_mod.ClipText(st.clip_ids[id(c)], c.moment, " ".join(x["text"] for x in c.render.captions))
            for c in st.candidates
        ]
        st.captions = await captions_mod.write_captions(
            self.bedrock,
            texts,
            notes=st.notes,
            skills=st.block,
            skills_text=st.skills.full_text,
            system=learnings.with_prior(st.prior, "You write social captions for short clips."),
        )
        required = captions_mod.required_tags(st.notes, st.skills.full_text)
        for c in st.candidates:
            title = st.captions[st.clip_ids[id(c)]]["youtubeTitle"]
            c.items = [i for i in c.items if i.key not in ("tags", "title")]
            c.items.append(
                Item(
                    "tags",
                    "Required tags and hashtags",
                    True,
                    f"In every caption: {' '.join(required)}" if required else "None required.",
                )
            )
            c.items.append(Item("title", "Title under 60 characters", len(title) < 60, f"{len(title)} characters."))
        return f"Wrote captions for {count(len(st.candidates), 'clip')}."

    # --- finalize --------------------------------------------------------------------------------------------

    async def finalize(self, st: JobState, tr: Tracker) -> str:
        platform = str(st.source.get("platform") or "upload")
        url = str(st.meta.get("webpageUrl") or st.source.get("url") or "")
        items = [
            clip_item(st, c, st.clip_ids[id(c)], rank, clip_prefix(st.job_id, st.clip_ids[id(c)]), platform, url)
            for rank, c in enumerate(st.candidates, start=1)
        ]
        # The vectors go first: once a Clip item is visible the owner can Keep or Decline it, and clip-flow then
        # rewrites (Keep) or the API deletes (Decline) its vector. A later put here would undo that.
        await tr.check_cancel()
        await self._put_vectors(st, items)
        for c, item in zip(st.candidates, items, strict=True):
            await tr.check_cancel()
            await self.store.upload(c.render.video, item["videoKey"], "video/mp4")
            await self.store.upload(c.render.cover, item["coverKey"], "image/jpeg")
            try:
                await self.store.put_clip(item, fence=st.fence)
            except JobSuperseded:
                # A newer run owns the job: this clip's files (a fresh clip id, so no other run uses them) go too.
                try:
                    await self.store.delete_keys([item["videoKey"], item["coverKey"]])
                except Exception as e:
                    log("warn", "finalize.cleanup_failed", job=st.job_id, error=type(e).__name__)
                raise
            tr.report(item["rank"] / len(items))
        return f"{count(len(st.candidates), 'clip')} ready for review."

    async def _put_vectors(self, st: JobState, items: list[dict[str, Any]]) -> None:
        """One PutVectors for the new clips (status ``review``), before any of their Clip items exists. A failure is
        logged, never fatal: the clip flow embeds a clip whose vector is missing when it is kept (docs/CONTRACTS.md
        §14.6). A vector whose Clip item is never written (cancel, supersede) is dropped by ``_similar``."""
        if self.vectors is None or not items:
            return
        platforms = [str(p) for p in st.settings.get("platforms") or []]
        try:
            n = await self.vectors.put_clips(items, platforms)
            log("info", "vectors.put", job=st.job_id, count=n)
        except Exception as e:
            log("warn", "vectors.put_failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:300])


def _status(r: watch.TrackResult) -> dict[str, Any]:
    """A track's outcome as the keyword arguments of ``Pipeline._deep``."""
    s = r.status
    return {"status": str(s["status"]), "reason": s.get("reason")}


def creator_fields(source: dict[str, Any]) -> dict[str, Any]:
    """Who the clip is from (§16.12): the creator key, every key it answers to, and the name to show. Empty for an
    upload or a link without a channel (learned from only owner-wide)."""
    keys = creator_keys(source)
    if not keys:
        return {}
    return {"creatorKey": keys[0], "creatorKeys": keys, "creatorName": creator_name(source)}


def spoken_fields(captions: list[dict[str, Any]]) -> dict[str, Any]:
    """Pacing facts from the clip's own captions (§16.12): how many words, when the first word starts and the start of
    what is said. Left out when nothing is said, so a missing fact stays missing."""
    spoken = [c for c in captions if str(c.get("text") or "").strip()]
    if not spoken:
        return {}
    text = " ".join(" ".join(str(c["text"]).split()) for c in spoken)
    return {
        "wordCount": len(text.split()),
        "firstWordSec": round(max(0.0, float(spoken[0].get("t0") or 0)), 2),
        "spokenText": text[:SPOKEN_CHARS],
    }


def clip_item(
    st: JobState, c: Candidate, clip_id: str, rank: int, prefix: str, platform: str, url: str
) -> dict[str, Any]:
    m, r = c.moment, c.render
    item: dict[str, Any] = {
        "pk": f"USER#{st.user_id}",
        "sk": f"CLIP#{clip_id}",
        "gsi1pk": f"JOB#{st.job_id}",
        "gsi1sk": f"CLIP#{rank:03d}",
        "type": "clip",
        "userId": st.user_id,
        "clipId": clip_id,
        "jobId": st.job_id,
        "rank": rank,
        "status": "review",
        "momentType": m.moment_type,
        "hook": m.hook,
        "summary": m.summary,
        "durationSec": r.duration,
        "sourceStart": m.start,
        "sourceEnd": m.end,
        "layout": r.layout,
        "captions": st.captions[clip_id],
        "checklist": {"items": [i.public() for i in c.items], "fixes": c.fixes},
        "score": round(m.score),
        "createdAt": now_iso(),
        "videoKey": prefix + "clip.mp4",
        "coverKey": prefix + "cover.jpg",
        **creator_fields(st.source),
        **spoken_fields(r.captions),
    }
    if m.picked_for:
        item["pickedFor"] = m.picked_for[: signals_mod.MAX_PICKED_FOR]
    if url and platform in ("youtube", "twitch", "kick"):
        at = sources.url_at(url, platform, m.start)
        if at:
            item["sourceUrlAt"] = at
    return item
