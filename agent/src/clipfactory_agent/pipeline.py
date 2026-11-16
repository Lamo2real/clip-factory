"""The nine pipeline steps (docs/CONTRACTS.md §8) wired to S3, DynamoDB, Transcribe, Bedrock, yt-dlp and ffmpeg.

Every step is safe to run again: inputs already in S3 from an earlier run of the same job (audio, words, loudness)
are reused, which is what makes Retry cheap."""

from __future__ import annotations

import asyncio
import functools
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import captions as captions_mod
from . import learnings, loudness, proc, sources
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
from .jobs import StepDone, StepFn, Tracker
from .moments import Moment, length_target
from .render import render_clip
from .skills import SkillsBlock, SkillSet, prepare_skills, skills_block
from .store import Fence, Store, clip_prefix, cookies_key, source_prefix
from .transcribe import PART_SECONDS, Transcriber, job_name, language_of, parse_items
from .util import JobCanceled, JobSuperseded, TransientError, UserFacingError, gather_all, hms, log, now_iso, ulid

RENDER_CONCURRENCY = 2


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
    learnings: list[str] = field(default_factory=list)
    week_learnings: list[str] = field(default_factory=list)
    similar: list[vectors_mod.Hit] = field(default_factory=list)
    chosen: list[Moment] = field(default_factory=list)
    spares: list[Moment] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    captions: dict[str, dict[str, str]] = field(default_factory=dict)
    clip_ids: dict[int, str] = field(default_factory=dict)

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
    ) -> None:
        self.cfg = cfg
        self.store = store
        self.bedrock = bedrock
        self.transcriber = transcriber
        self.vectors = vectors  # None: no clip vectors and no "what worked before"

    def steps(self, st: JobState, tr: Tracker) -> list[tuple[str, StepFn]]:
        def bind(fn: Any) -> StepFn:
            return lambda: fn(st, tr)

        return [
            ("resolve", bind(self.resolve)),
            ("download", bind(self.download)),
            ("transcribe", bind(self.transcribe)),
            ("analyze", bind(self.analyze)),
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
            st.user_id, st.job_id, {"source": st.source}, unless_canceled=True, session_id=st.session_id
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

    # --- download --------------------------------------------------------------------------------------------

    def _cap(self, st: JobState) -> float:
        return float(st.settings.get("maxSourceHours") or 6) * 3600

    async def download(self, st: JobState, tr: Tracker) -> StepDone:
        cap = self._cap(st)
        total = float(st.source.get("durationSec") or 0)
        need = min(total, cap) if total else cap
        audio_key = st.key("audio.m4a")
        if await self.store.exists(audio_key) and float(st.meta.get("audioSeconds") or 0) >= need - 60:
            return StepDone("Reused the audio downloaded earlier.")
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
        return StepDone(f"Downloaded {hms(info.duration)} of audio{note}.")

    async def _local_audio(self, st: JobState) -> Path:
        local = st.workdir / "source" / "audio.m4a"
        if not local.is_file():
            await self.store.download(st.key("audio.m4a"), local)
        return local

    # --- transcribe ------------------------------------------------------------------------------------------

    async def transcribe(self, st: JobState, tr: Tracker) -> StepDone:
        if await self.store.exists(st.key("words.json")):
            st.words = await self.store.get_json(st.key("words.json"))
            return StepDone(f"Reused the transcript from earlier ({len(st.words):,} words).")
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
        ) -> tuple[list[tuple[float, float, str]], dict[str, Any]]:
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
                )
            except BaseException:
                await self.transcriber.stop(name)
                raise
            await self.store.tag_temporary(out_key)  # Transcribe cannot tag its own output (docs/CONTRACTS.md §7)
            return parse_items(await self.store.get_json(out_key), offset), job

        # One failed part cancels (and stops) the others before the step is retried or fails.
        results = await gather_all(*(one(i, *p) for i, p in enumerate(parts)))
        st.words = [list(w) for words, _ in results for w in words]
        st.meta["language"] = language_of([j for _, j in results])
        await self.store.put_json(st.key("words.json"), st.words)
        await self.store.put_json(st.key("meta.json"), st.meta)
        if len(st.words) < 20:
            raise UserFacingError(
                "Almost no speech was found in this video, so there is nothing to pick moments from. "
                "Clip Factory needs talking or commentary."
            )
        lang = f" ({st.meta['language']})" if st.meta.get("language") else ""
        return StepDone(f"Transcribed {len(st.words):,} words{lang}.")

    # --- analyze ---------------------------------------------------------------------------------------------

    async def analyze(self, st: JobState, tr: Tracker) -> str:
        if await self.store.exists(st.key("loudness.json")):
            st.loud = await self.store.get_json(st.key("loudness.json"))
        else:
            st.loud = await loudness.measure(await self._local_audio(st), st.workdir)
            await self.store.put_json(st.key("loudness.json"), st.loud)
        tr.report(0.6)
        # A failure to read the skill rows fails the step (and its normal retry runs): never a job without them.
        st.skills = await prepare_skills(
            st.workdir, self.cfg.skills_dir, await self.store.skill_rows(st.user_id), self.store.get_bytes
        )
        st.skills_block = skills_block(st.skills.docs, where="agent.job")
        taught = await learnings.load(self.store, st.user_id)
        st.week_learnings, st.learnings = taught.week, taught.other
        st.similar = await self._similar(st)
        spikes = len(loudness.spikes(st.loud, limit=10_000))
        similar = f" and {len(st.similar)} similar past clip(s)" if st.similar else ""
        used = f"using {len(st.skills.docs)} skill(s)"
        if st.skills.skipped:
            used += f"; {len(st.skills.skipped)} could not be read"
        return f"Found {spikes} loud moments; {used}, {len(taught)} learning(s){similar}."

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
            learnings=st.learnings,
            week_learnings=st.week_learnings,
            language=st.meta.get("language"),
            similar=st.similar,
        )

    async def select(self, st: JobState, tr: Tracker) -> str:
        st.chosen, st.spares = await find_moments(
            self._brief(st),
            bedrock=self.bedrock,
            model_id=self.cfg.model_id,
            region=self.cfg.region,
            workdir=st.workdir,
            skill_names=[s.name for s in st.skills.docs],
            skills=st.block,
            on_progress=tr.report,
        )
        kinds = ", ".join(sorted({m.moment_type.replace("_", " ") for m in st.chosen}))
        return f"Picked {len(st.chosen)} moments ({kinds}) and {len(st.spares)} spare(s)."

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
                "None of the clips could be cut. Press Retry; if it happens again, try another video."
            )
        failed = len(st.chosen) - len(st.candidates)
        return f"Cut {len(st.candidates)} clip(s)" + (f"; {failed} could not be cut." if failed else ".")

    # --- checklist -------------------------------------------------------------------------------------------

    async def _review(self, st: JobState, c: Candidate) -> dict[str, Any]:
        try:
            return await self.bedrock.structured(
                system="You review short vertical clips before they are posted, strictly but fairly.",
                skills=st.block,
                content=[{"text": review_prompt(c.moment, c.render, st.notes)}],
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
        items = measured_items(c.moment, c.render, await measure(c.render.video), st.length) + judged_items(review)
        if review.get("verdict") == "drop":
            return Outcome(False, Candidate(c.moment, c.render, items, index=index), "Claude judged it unfixable.")
        fixes: list[str] = []
        if any(not i.passed for i in items):
            fixed, fixes = plan_fix(
                c.moment, items, review, length=st.length, first_loud=lambda t: loudness.first_loud_second(st.loud, t)
            )
            if fixes:
                c = await self._cut(st, fixed, index, layout=c.render.frame_layout)
                measured = measured_items(c.moment, c.render, await measure(c.render.video), st.length)
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
        msg = f"{len(passed)} clip(s) passed"
        return msg + (f", {replaced} replaced by spare moments." if replaced else ".")

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
            system="You write social captions for short clips.",
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
        return f"Captions written for {len(st.candidates)} clip(s)."

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
        return f"{len(st.candidates)} clip(s) ready for review."

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
    }
    if url and platform in ("youtube", "twitch", "kick"):
        at = sources.url_at(url, platform, m.start)
        if at:
            item["sourceUrlAt"] = at
    return item
