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
import hashlib
import json
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from . import captions as captions_mod
from . import chat as chat_mod
from . import chatfetch, chatscreen, learnings, livestatus, loudness, nova, pot, proc, sources, verify, watch
from . import picture as picture_mod
from . import signals as signals_mod
from . import vectors as vectors_mod
from .agent import Brief, find_moments
from .bedrock import Bedrock, Facecam, FrameLayout, ModelError, model_unavailable
from .campaign import LOGO_MISSING, Campaign
from .checklist import (
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
    review_schema,
)
from .config import Config
from .creators import creator_keys, creator_name
from .guard import Deadline, fable_budget, nova_budget
from .heartbeat import free_memory
from .jobs import StepDone, StepFn, Tracker, creep
from .moments import Moment, length_target
from .render import Marks, RenderResult, prepare_logo, render_clip
from .skills import SkillsBlock, SkillSet, prepare_skills, skills_block
from .store import Fence, Store, clip_prefix, cookies_key, source_prefix
from .transcribe import PART_SECONDS, Transcriber, job_name, language_of, parse_items, parse_speakers
from .util import (
    JobCanceled,
    JobSuperseded,
    NeedsMac,
    TransientError,
    UserFacingError,
    gather_all,
    hms,
    log,
    now_iso,
    ulid,
)
from .watch import TrackResult

RENDER_CONCURRENCY = 2  # the ceiling: a second clip is cut alongside only when memory allows (RenderGate)
PARALLEL_FREE = 3 * 1024**3  # free memory a second render needs (a 1080p clip's two ffmpeg runs, with room to spare)
PARALLEL_MAX_HEIGHT = 1080
UPLOAD_DISK_SPARE = 3 * 1024**3  # the local copy of an upload leaves this much disk free (picture.DISK_RESERVE)
# Filesystems kept in memory: there the local copy of an upload is made only when it takes this share of free memory
# at most (else the Cut step reads the file from S3).
RAM_FILESYSTEMS = frozenset({"tmpfs", "ramfs"})
RAM_COPY_SHARE = 0.25
MOUNTS = Path("/proc/mounts")
MOMENTS_VERSION = 1
# A clip that was being cut when this many earlier runs died is not tried again: the rest of the job finishes without
# it (§30.4). A clip in flight during one death is cut last, alone.
MAX_CLIP_DEATHS = 2
# Check each clip (owner report 2026-11-20: ten clips took 30 minutes, one after the other, with no sign of life).
# Three clips are checked at once (three review calls in flight; their re-cuts share the RenderGate). The time limits
# are far above a slow but healthy check: a review answer takes about a minute (at most a few), one clip's whole
# check (review, measuring, one re-cut) 1-4 minutes. A clip whose check can't finish is swapped for a spare like any
# clip that can't be checked; the job always goes on to Write the captions and Finish up.
CHECK_CONCURRENCY = 3
# A clip's check is timed in two parts: the review and measuring (``CHECK_CLIP_SECONDS``), and each cut, which starts
# only once a cutting slot is taken and may wait out the whole-video download (``CUT_SECONDS``, above its 90 min).
CHECK_CLIP_SECONDS = 35 * 60
CUT_SECONDS = 100 * 60
REVIEW_SECONDS = 24 * 60  # two Converse tries (bedrock.CALL_SECONDS), well below the clip limit
CHECK_EXPECTED = 120.0  # how long one clip's check usually takes: moves the bar between finished checks
CAPTIONS_SECONDS = 15 * 60
UNCHECKED = "This clip could not be checked; look at it yourself before posting."
SPOKEN_CHARS = 1000  # the start of what a clip says, for the daily second look (§16.12)
FEW_WORDS = 20
NOT_WATCHED = "Could not watch the video this time. Picking from the words and the sound."
MOTION_ONLY = "Saw where the picture moves fast. Picking with that, the words and the sound."
ALMOST_NO_SPEECH = (
    "Almost no speech was found in this video, so there is nothing to pick moments from. "
    "Clip Factory needs talking or commentary."
)


def mount_type(path: Path, mounts: Path | None = None) -> str:
    """The filesystem type ``path`` lives on, from ``/proc/mounts`` (the longest mount point that holds it), or
    "unknown" (not Linux)."""
    try:
        text = (mounts or MOUNTS).read_text()
    except OSError:
        return "unknown"
    target = os.path.abspath(path)
    best, kind = "", "unknown"
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        point = parts[1].replace("\\040", " ")
        inside = target == point or target.startswith(point.rstrip("/") + "/")
        if inside and len(point) >= len(best):
            best, kind = point, parts[2]
    return kind


def read_secret(name: str, region: str) -> str | None:
    """A Secrets Manager secret's string, or None when it does not exist (§29.8). Other errors raise."""
    import boto3

    client = boto3.client("secretsmanager", region_name=region)
    try:
        r = client.get_secret_value(SecretId=name)
    except client.exceptions.ResourceNotFoundException:
        return None
    return str(r.get("SecretString") or "") or None


def cut_failure(reasons: list[str]) -> str:
    """What the Cut step says when no clip could be cut (§29.5): YouTube's block, then ran-out cookies, then a video
    too long for the disk, then the first other plain reason, else the generic words. Never yt-dlp's text: every
    reason here is already one of the owner sentences ``sources.explain`` or the fallback wrote."""
    blocked = {sources.CUT_BLOCKED, sources.BLOCKED_NO_COOKIES, sources.BLOCKED_WITH_COOKIES}
    if any(r in blocked for r in reasons):
        return sources.CUT_BLOCKED
    for preferred in (sources.COOKIES_EXPIRED, sources.CUT_TOO_BIG):
        if preferred in reasons:
            return preferred
    return reasons[0] if reasons else sources.CUT_FAILED


def needs_mac(st: JobState, why: str, full_error: BaseException | None) -> bool:
    """When no clip of a YouTube link could be cut because YouTube refused the cloud (blocked, cookies ran out) or the
    one full download of §29.4 step 4 failed too, the owner's Mac gets the video instead (§35.1)."""
    source = st.source
    if not st.mac_ok or source.get("type") == "upload" or source.get("platform") != "youtube":
        return False
    return why in (sources.CUT_BLOCKED, sources.COOKIES_EXPIRED) or full_error is not None


# The full-download fallback (§29.4) keeps this much video around the clips' range, in seconds: the cut takes a
# couple of seconds before each moment and its tease.
FULL_PAD = 60.0


class RenderGate:
    """How many clips are cut at once: up to ``ceiling``, but a second one only starts while ``may_add()`` says
    memory allows (§30.4). ``serial`` forces one at a time for the rest of the step (after an out-of-memory kill)."""

    def __init__(self, ceiling: int, may_add: Callable[[], bool]) -> None:
        self.ceiling = max(1, ceiling)
        self.may_add = may_add
        self.serial = False
        self.running = 0
        self.peak = 0
        self._cond = asyncio.Condition()

    def _room(self) -> bool:
        if self.running == 0:
            return True
        return not self.serial and self.running < self.ceiling and self.may_add()

    async def __aenter__(self) -> RenderGate:
        async with self._cond:
            while not self._room():
                # Checked again when a clip finishes, or every few seconds while memory is short.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._cond.wait(), 5.0)
            self.running += 1
            self.peak = max(self.peak, self.running)
        return self

    async def __aexit__(self, *_: object) -> None:
        async with self._cond:
            self.running -= 1
            self._cond.notify_all()


def clip_span(st: JobState) -> tuple[float, float] | None:
    """The part of the video every chosen clip and spare sits in (with any tease), or None when there are none."""
    starts: list[float] = []
    ends: list[float] = []
    for m in (*st.chosen, *st.spares):
        tease = getattr(m, "tease", None)
        starts.append(min(m.start, tease[0]) if tease else m.start)
        ends.append(max(m.end, tease[1]) if tease else m.end)
    if not starts:
        return None
    return min(starts), max(ends)


def full_plan(
    info: dict[str, Any], seconds: float, span: tuple[float, float] | None, free: int
) -> tuple[dict[str, Any], tuple[float, float] | None] | None:
    """What the one full download fetches (§29.4): the whole video with yt-dlp's own downloader (the sturdiest way)
    when the clips spread over at least half of it and it fits the disk and the time limit; else only the clips'
    range plus ``FULL_PAD`` (a capped multi-hour stream whose clips all sit in its first hours). None when neither
    fits. Returns the format and the range (None for the whole video)."""
    section: tuple[float, float] | None = None
    if span is not None and seconds > 0:
        a, b = max(0.0, span[0] - FULL_PAD), min(seconds, span[1] + FULL_PAD)
        if b > a and b - a < seconds:
            section = (a, b)
    if section is None or section[1] - section[0] >= seconds / 2:
        whole = sources.full_format(info, seconds, free)
        if whole is not None:
            return whole, None
    if section is not None:
        part = sources.full_format(info, section[1] - section[0], free)
        if part is not None:
            return part, section
    return None


def count(n: int, word: str) -> str:
    """``1 clip``, ``2 clips``, ``4,812 words``: step messages are read by the owner, so no "clip(s)"."""
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def prep_deadline(seconds: float) -> float:
    """How long the watch step waits for the picture, counted from when its preparation started: the same limit the
    decode itself has (picture.time_limit), so neither cuts the other short."""
    return picture_mod.time_limit(seconds)


def chat_deadline(seconds: float) -> float:
    """How long the chat replay may take (§37): 3 minutes plus 2 per hour of video, at most 12."""
    return min(12 * 60.0, 3 * 60.0 + 2 * 60.0 * max(0.0, seconds) / 3600)


CHAT_GRACE = 30.0  # the analyze step waits this much past the fetcher's own deadline before giving up on it
SCREEN_CHAT_BELOW = 0.5  # the chat box in the picture is read when the replay covers less than this share
SCREEN_CHAT_WAIT = 10 * 60.0  # after the watchers finish, the chat box speed gets at most this much longer


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
    # YouTube from the cloud (docs/CONTRACTS.md §29): the optional proxy, the Cut step's one saved ``-J`` and, only
    # when section downloads keep failing, the whole video downloaded once and cut locally.
    proxy: str | None = None
    info_json: Path | None = None
    info_refreshed: bool = False
    full_source: Path | None = None
    full_offset: float = 0.0  # where full_source starts in the video (a range download starts after 0)
    full_error: UserFacingError | None = None
    mac_ok: bool = False  # blocked by YouTube, wait for the owner's Mac instead of failing (§35.1)
    full_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # An upload is copied to the disk once for the Cut step and cut locally (§30.4); None: cut from S3.
    upload_source: Path | None = None
    upload_checked: bool = False
    upload_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Picking up a job that stopped partway (§30): the moments and the clips already cut are reused.
    pick_up: bool = False
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
    ids_saved: bool = False  # clips.json holds this run's clip ids: a newer run picking up reuses them (§30.6)
    moments_reused: bool = False  # select reused the stopped run's moments.json (§30.6)
    checked: bool = False  # render reloaded the stopped run's checked clips: the checklist does not run again
    # The deep analysis (ADR-40); every one of these may stay empty and the job still makes its clips.
    picture_task: asyncio.Task[None] | None = None  # the background picture preparation started by download
    picture_started: float = 0.0  # loop time the preparation started (the watch step's wait counts from here)
    picture: picture_mod.Picture | None = None
    frames: picture_mod.Frames | None = None
    signals: signals_mod.Signals | None = None
    speakers: list[list[Any]] | None = None
    second_look: list[dict[str, Any]] = field(default_factory=list)
    # Chat hype (§37): the replay fetched in the background from download on, and the signal from it (or from the
    # chat box in the picture). Both may stay empty; the job never waits on them for long or fails over them.
    chat_task: asyncio.Task[chat_mod.RawChat | None] | None = None
    chat_started: float = 0.0
    chat_count: int = 0
    chat: chat_mod.ChatSignal | None = None
    # The model that makes this job's clips (docs/DECISIONS.md ADR-42), picked in resolve from the owner's
    # ``clipModel`` setting: its key in config/models.json, the id it is called with and its client. ``model_wanted``
    # is the owner's pick when it could not be used and the default model took over.
    model_key: str | None = None
    model_id: str = ""
    model_wanted: str | None = None
    bedrock: Bedrock | None = None
    # A Content Rewards campaign job (docs/CONTRACTS.md §38.13), read in resolve from ``job.campaign``: the rules
    # travel with the job, the logo is prepared once (``logo.png`` in the work folder) and the channel check may leave
    # a note. None for every other job, which then runs exactly as before.
    campaign: Campaign | None = None
    logo: Path | None = None
    campaign_note: str | None = None

    @property
    def notes(self) -> str:
        return str(self.job.get("notes") or "")

    @property
    def length(self) -> tuple[float, float]:
        return length_target(self.notes, self.campaign)

    @property
    def campaign_id(self) -> str | None:
        """The campaign the job's clips are for: the rules' own id, else the job's public ``campaignId``."""
        if self.campaign is not None:
            return self.campaign.campaign_id
        cid = self.job.get("campaignId")
        return cid if isinstance(cid, str) and cid else None

    @property
    def marks(self) -> Marks | None:
        """What a campaign clip shows in its mark row: the logo (when there is one) and the on-screen disclosure."""
        if self.campaign is None:
            return None
        return Marks(logo=self.logo, disclosure=self.campaign.on_screen)

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
        new_bedrock: Callable[[str], Bedrock] | None = None,
    ) -> None:
        self.cfg = cfg
        self.store = store
        self.bedrock = bedrock  # the default model (agentModel); every job uses it unless the owner picked another
        # One client per model id, kept for the container's life, so what a client learns about its model (no forced
        # tool choice, no cache points, the image limit, that it answers) is learned once.
        self._clients: dict[str, Bedrock] = {}
        self._new_bedrock = new_bedrock or (lambda model_id: Bedrock(model_id, self.cfg.region))
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

    # --- the model for this job (docs/DECISIONS.md ADR-42) ----------------------------------------------------

    def claude(self, st: JobState) -> Bedrock:
        """The client for this job's model: the owner's pick, or the default before resolve has picked one."""
        return st.bedrock or self.bedrock

    def _client(self, model_id: str) -> Bedrock:
        client = self._clients.get(model_id)
        if client is None:
            client = self._clients[model_id] = self._new_bedrock(model_id)
        return client

    def pick_model(self, st: JobState) -> None:
        """The model the owner picked in Settings (``clipModel``), when it is one of clipModels; else the default."""
        default_key = self.cfg.default_model_key
        wanted = st.settings.get("clipModel")
        key = wanted if isinstance(wanted, str) and wanted in self.cfg.clip_models else default_key
        if wanted and key != wanted:
            log("warn", "model.unknown", job=st.job_id, wanted=str(wanted)[:64], using=default_key)
        model_id = self.cfg.clip_models[key] if key and key != default_key else self.cfg.model_id
        st.model_key, st.model_id, st.model_wanted = key, model_id, None
        st.bedrock = self.bedrock if model_id == self.cfg.model_id else self._client(model_id)
        log("info", "model.chosen", job=st.job_id, model=st.model_key, modelId=st.model_id)

    async def check_model(self, st: JobState) -> None:
        """A picked model Bedrock refuses as unavailable on its first call (a small one, once the skills block is
        built) gives way to the default model for the rest of the job, and the job record says so."""
        if st.bedrock is None or st.bedrock is self.bedrock:
            return
        refused = await st.bedrock.probe(skills=st.block)
        if refused is None:
            return
        log(
            "warn",
            "model.fallback",
            job=st.job_id,
            wanted=st.model_key,
            wantedModelId=st.model_id,
            using=self.cfg.default_model_key,
            modelId=self.cfg.model_id,
            error=type(refused).__name__,
            detail=str(refused)[:300],
        )
        st.model_wanted, st.model_key = st.model_key, self.cfg.default_model_key
        st.model_id, st.bedrock = self.cfg.model_id, self.bedrock
        fields, drop = self._model_fields(st)
        await self.store.update_job(
            st.user_id, st.job_id, fields, unless_canceled=True, session_id=st.session_id, remove=drop
        )

    def _model_fields(self, st: JobState) -> tuple[dict[str, Any], tuple[str, ...]]:
        """The job record's ``model`` (the key actually used) and ``modelWanted`` (only when the pick fell back)."""
        fields: dict[str, Any] = {"model": st.model_key} if st.model_key else {}
        if st.model_wanted:
            fields["modelWanted"] = st.model_wanted
            return fields, ()
        return fields, ("modelWanted",)

    # --- resolve ---------------------------------------------------------------------------------------------

    async def resolve(self, st: JobState, tr: Tracker) -> str:
        job = await self.store.get_job(st.user_id, st.job_id)
        if not job:
            raise UserFacingError("This job no longer exists.")
        st.job = job
        st.pick_up = bool(job.get("pickUp"))  # a run that stopped partway: its moments and clips are reused (§30)
        # The API gives every YouTube link job made since §35 a ``macFetch`` map: blocked, it waits for the owner's Mac.
        st.mac_ok = isinstance(job.get("macFetch"), dict)
        st.settings = await self.store.get_settings(st.user_id)
        self.pick_model(st)
        st.source = dict(job.get("source") or {})
        st.campaign = Campaign.from_job(job)
        if st.campaign is not None and not st.campaign.rules:
            # The API always copies the rules (§38.8): the clips still get #Ad and "Paid partnership".
            log("error", "campaign.no_rules", job=st.job_id)
        st.workdir.mkdir(parents=True, exist_ok=True)
        await self._clear_previous_clips(st)
        if st.campaign is not None:
            await self._campaign_logo(st)
        if await self.store.exists(st.key("meta.json")):
            st.meta = await self.store.get_json(st.key("meta.json"))
        if st.source.get("type") == "upload":
            await self._resolve_upload(st)
        else:
            await self._resolve_link(st, tr)
        await self.store.put_json(st.key("meta.json"), st.meta)
        model, drop = self._model_fields(st)
        fields = {"source": st.source, **creator_fields(st.source), **model}
        if st.campaign is not None and st.campaign_note:
            # The note the API may have left ("Couldn't check the campaign just now.") stays; the channel note joins it.
            prior = st.job.get("campaignNote")
            prior = prior.strip() if isinstance(prior, str) else ""
            if st.campaign_note not in prior:
                fields["campaignNote"] = f"{prior} {st.campaign_note}".strip()
        await self.store.update_job(
            st.user_id,
            st.job_id,
            fields,
            unless_canceled=True,
            session_id=st.session_id,
            remove=drop,
        )
        title = st.source.get("title") or "the video"
        length = f" ({hms(st.source['durationSec'])})" if st.source.get("durationSec") else ""
        return f"Found {title}{length}."

    async def _campaign_logo(self, st: JobState) -> None:
        """The campaign's logo, from the job's own copy (``jobs/{jobId}/source/campaign-logo.{ext}``, §38.11), prepared
        as ``logo.png`` in the work folder (PNG, transparent edges trimmed). A required logo that is missing or can't be
        read fails the job at once; any other logo that can't be read is left out."""
        assert st.campaign is not None
        ext = st.campaign.logo_ext(st.job_id)
        st.logo = None
        if st.campaign.logo_key and ext is None:
            log("warn", "campaign.logo_key_refused", job=st.job_id)
        key = str(st.campaign.logo_key)
        if ext is not None and await self.store.exists(key):
            raw = st.workdir / f"campaign-logo.{ext}"
            await self.store.download(key, raw)  # a storage failure is the step's to retry, not a missing logo
            try:
                st.logo = await prepare_logo(raw, st.workdir / "logo.png")
            except (proc.CommandError, OSError, ValueError) as e:
                log("warn", "campaign.logo_unreadable", job=st.job_id, error=type(e).__name__, detail=str(e)[:200])
                st.logo = None
        elif ext is not None:
            log("warn", "campaign.logo_gone", job=st.job_id)
        if st.logo is None and st.campaign.logo_required:
            raise UserFacingError(LOGO_MISSING)
        log("info", "campaign.ready", job=st.job_id, logo=st.logo is not None, rulesVersion=st.campaign.rules_version)

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
        if platform == "youtube":
            if await self.store.exists(cookies_key(st.user_id)):
                st.cookies = st.workdir / "cookies.txt"
                await self.store.download(cookies_key(st.user_id), st.cookies)
                os.chmod(st.cookies, 0o600)
            st.proxy = await self._youtube_proxy(st)
            await pot.ready()
        try:
            info = await sources.video_info(url, st.cookies, proxy=st.proxy)
        except proc.CommandError as e:
            raise sources.explain_or_mac(e, platform, st.cookies is not None, mac_ok=st.mac_ok) from e
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            raise UserFacingError("This stream is still live or has not started. Try again once it has ended.")
        st.source.update(sources.source_fields(info, platform))
        if st.campaign is not None and not sources.from_allowed_channel(info, st.campaign.channels):
            # The job goes on: the owner reads the note on the job and decides before uploading (§38.13).
            st.campaign_note = st.campaign.channel_note()
            log("info", "campaign.channel_mismatch", job=st.job_id)
        st.meta["heatmap"] = sources.heatmap(info)
        self._chat_source(st, info, platform)
        st.meta["webpageUrl"] = info.get("webpage_url") or url
        st.meta["picture"] = self._pick_picture(st, info)

    def _chat_source(self, st: JobState, info: dict[str, Any], platform: str) -> None:
        """Where the chat replay can come from (``meta.chatSource``); YouTube's info is kept for yt-dlp to reuse."""
        try:
            st.meta["chatSource"] = chatfetch.source_meta(info, platform)
            if (st.meta["chatSource"] or {}).get("platform") == "youtube":
                (st.workdir / "chat-info.json").write_text(json.dumps(info), encoding="utf-8")
        except Exception as e:
            log("warn", "chat.source_failed", job=st.job_id, error=type(e).__name__)
            st.meta["chatSource"] = None

    async def _youtube_proxy(self, st: JobState) -> str | None:
        """The optional YouTube proxy from Secrets Manager (§29.8). No secret, no access or an odd value: no proxy, and
        the job goes on. The value is never logged."""
        name = getattr(self.cfg, "youtube_proxy_secret", None)
        if not name:
            return None
        try:
            value = await asyncio.to_thread(read_secret, name, self.cfg.region)
        except Exception as e:
            log("debug", "youtube.proxy_none", job=st.job_id, error=type(e).__name__)
            return None
        value = (value or "").strip()
        if not value:
            log("debug", "youtube.proxy_none", job=st.job_id)
            return None
        if not value.startswith(("http://", "https://", "socks5://", "socks5h://")):
            log("warn", "youtube.proxy_ignored", job=st.job_id, reason="not a proxy URL")
            return None
        log("info", "youtube.proxy_on", job=st.job_id)
        return value

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
        st.meta["sourceHeight"] = info.height  # the Cut step's "two at once" check reads it (§30.4)
        st.meta["picture"] = {"upload": True, "height": info.height, "fps": info.fps} if self.cfg.deep_enabled else None

    # --- download --------------------------------------------------------------------------------------------

    def _cap(self, st: JobState) -> float:
        return float(st.settings.get("maxSourceHours") or 6) * 3600

    async def download(self, st: JobState, tr: Tracker) -> StepDone:
        """The sound first, exactly as before the picture was watched, and it must succeed. Only then does the
        picture start preparing in the background (``_picture_prep``), so it overlaps the transcription."""
        done = await self._download_audio(st, tr)
        await self._start_picture(st)
        await self._start_chat(st)
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
                    proxy=st.proxy,
                    on_progress=lambda f: tr.report(0.9 * f),
                )
            except proc.CommandError as e:
                raise sources.explain_or_mac(e, platform, st.cookies is not None, mac_ok=st.mac_ok) from e
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
                proxy=st.proxy,
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
        """The run is over, however it ended: the background picture preparation and the chat replay stop (their
        yt-dlp or ffmpeg is killed by ``proc.run``). Called by the server in its ``finally``."""
        for task in (st.picture_task, st.chat_task):
            if task is not None and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._drop_full(st)

    # --- the chat replay, fetched in the background (§37) ----------------------------------------------------

    async def _start_chat(self, st: JobState) -> None:
        """Starts the chat replay fetch when this video has one we can read and no earlier run saved it. Never
        raises."""
        try:
            if st.chat_task is not None or st.source.get("type") == "upload":
                return
            meta = st.meta.get("chatSource")
            if not meta or not chatfetch.enabled(str(meta.get("platform") or "")):
                return
            if await self.store.exists(st.key("chat.json")):
                return
            st.chat_started = asyncio.get_running_loop().time()

            def counted(n: int) -> None:
                st.chat_count = n

            st.chat_task = asyncio.create_task(
                chatfetch.fetch(
                    meta,
                    url=str(st.meta.get("webpageUrl") or st.source.get("url") or ""),
                    duration=st.duration,
                    workdir=st.workdir,
                    cookies=st.cookies,
                    proxy=st.proxy,
                    time_limit=chat_deadline(st.duration),
                    on_count=counted,
                ),
                name=f"chat-{st.job_id}",
            )
        except Exception as e:
            log("warn", "chat.start_failed", job=st.job_id, error=type(e).__name__)

    async def _read_chat(self, st: JobState, tr: Tracker) -> None:
        """``st.chat``: from an earlier run's ``chat.json``, else from the replay (waited for up to its deadline, with
        the live line counting the messages). Never raises but for a cancel; no chat is never a problem."""
        try:
            saved = chat_mod.ChatSignal.from_json(await self._saved_json(st.key("chat.json")))
            if saved is not None:
                st.chat = saved
                return
            await self._start_chat(st)  # a picked-up job whose download step was already done
            task = st.chat_task
            if task is None:
                return
            source = str((st.meta.get("chatSource") or {}).get("platform") or "")
            limit = chat_deadline(st.duration) + CHAT_GRACE
            loop = asyncio.get_running_loop()
            livestatus.emit("chat", n=st.chat_count, source=source)
            while not task.done():
                await tr.check_cancel()
                if loop.time() - st.chat_started > limit:
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
                    log("warn", "chat.deadline", job=st.job_id)
                    return
                await asyncio.wait({task}, timeout=2.0)
                livestatus.emit("chat", n=st.chat_count, source=source)
            raw = task.result()
            if raw is None:
                return
            livestatus.emit("chat", n=raw.count, source=source)
            loud = [float(x.t) for x in loudness.spikes(st.loud, limit=10_000)]
            st.chat = await asyncio.to_thread(chat_mod.analyze, raw, st.duration, loud)
            await self._save_chat(st)
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "chat.read_failed", job=st.job_id, error=type(e).__name__)
            st.chat = None

    async def _save_chat(self, st: JobState) -> None:
        if st.chat is None:
            return
        try:
            await self.store.put_json(st.key("chat.json"), st.chat.to_json())
        except Exception as e:
            log("warn", "chat.save_failed", job=st.job_id, error=type(e).__name__)
        log(
            "info",
            "chat.ready",
            job=st.job_id,
            source=st.chat.source,
            messages=st.chat.messages,
            coverage=st.chat.coverage,
            spikes=len(st.chat.spikes),
            lag=st.chat.lag,
        )

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
            if len(done) > 1:  # "3 of 8 parts done" on the live line (§31): the parts run at the same time
                livestatus.emit("transcribe_part", i=sum(1 for d in done if d >= 0.95), n=len(done))

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
        tr.report(0.5)
        await self._read_chat(st, tr)
        tr.report(0.6)
        # A failure to read the skill rows fails the step (and its normal retry runs): never a job without them.
        st.skills = await prepare_skills(
            st.workdir, self.cfg.skills_dir, await self.store.skill_rows(st.user_id), self.store.get_bytes
        )
        st.skills_block = skills_block(st.skills.docs, where="agent.job")
        await self.check_model(st)
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
        wild = chat_mod.summary(st.chat)
        crowd = f" Chat went wild {count(wild, 'time')}." if wild else ""
        return f"Found {count(spikes, 'loud moment')}.{crowd}{note}"

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
                chat=st.chat,
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
        found = await self._chat_box(st, pic, frames)
        speed_task = (
            asyncio.create_task(self._chat_speed(st, pic, frames, found), name=f"chat-screen-{st.job_id}")
            if found is not None
            else None
        )
        try:
            fable, second = await self._watchers(st, tr, pic, frames, found)
        except BaseException:
            if speed_task is not None:
                speed_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await speed_task
            raise
        if speed_task is not None and found is not None:
            await self._screen_chat(st, found, speed_task, fable.ok)
        return await self._watched(st, pic, fable, second)

    def _wants_screen_chat(self, st: JobState) -> bool:
        return chatfetch.enabled("screen") and (st.chat is None or st.chat.coverage < SCREEN_CHAT_BELOW)

    async def _part_files(
        self, pic: picture_mod.Picture, frames: picture_mod.Frames, *, sample: bool = False
    ) -> list[tuple[float, Path]]:
        parts = chatscreen.sample_parts(pic.parts) if sample else pic.parts  # finding the box reads only a few
        return [(p.start, await frames.file(p)) for p in parts]

    async def _chat_box(
        self, st: JobState, pic: picture_mod.Picture, frames: picture_mod.Frames
    ) -> chatscreen.Found | None:
        """A chat box shown in the picture, when the replay is missing or thin. Never raises but for a cancel."""
        if not self._wants_screen_chat(st):
            return None
        try:
            return await chatscreen.find(await self._part_files(pic, frames, sample=True))
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "chatscreen.failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:200])
            return None

    async def _chat_speed(
        self, st: JobState, pic: picture_mod.Picture, frames: picture_mod.Frames, found: chatscreen.Found
    ) -> list[float | None]:
        return await chatscreen.speed(await self._part_files(pic, frames), found, pic.seconds, pic.scene or None)

    async def _screen_chat(
        self,
        st: JobState,
        found: chatscreen.Found,
        task: asyncio.Task[list[float | None]],
        chunks: list[dict[str, Any]],
    ) -> None:
        """``st.chat`` from the chat box's speed and the words the watcher read in it. Never raises but for a
        cancel; a failure keeps whatever chat the job had."""
        try:
            lines = await asyncio.wait_for(task, SCREEN_CHAT_WAIT)  # cancels the reader when it is too slow
            loud = [float(x.t) for x in loudness.spikes(st.loud, limit=10_000)]
            words = [(float(w[0]), str(w[1])) for c in chunks for w in c.get("chatWords") or []]
            sig = chat_mod.from_screen(lines, box=found.box.picture_box(), loud_times=loud, words=words)
            if sig is not None and (st.chat is None or st.chat.coverage < SCREEN_CHAT_BELOW):
                st.chat = sig
                await self._save_chat(st)
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "chatscreen.failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:200])

    async def _watchers(
        self,
        st: JobState,
        tr: Tracker,
        pic: picture_mod.Picture,
        frames: picture_mod.Frames,
        found: chatscreen.Found | None,
    ) -> tuple[TrackResult, TrackResult]:
        units = watch.plan(pic.seconds)
        deadline = Deadline(watch_deadline(st.duration))
        share = {"fable": 0.0, "nova": 0.0}

        def progress(who: str, f: float) -> None:
            share[who] = f
            tr.report(0.2 + 0.75 * (0.8 * share["fable"] + 0.2 * share["nova"]))
            if who == "fable" and len(units) > 1:  # "2 of 5 parts done" on the live line (§31)
                livestatus.emit("watch_part", i=min(len(units), round(f * len(units))), n=len(units))

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
                bedrock=self.claude(st),
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
                chat_box=found.box.picture_box() if found is not None else None,
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
        return fable, second

    async def _watched(
        self, st: JobState, pic: picture_mod.Picture, fable: TrackResult, second: TrackResult
    ) -> StepDone:
        units = watch.plan(pic.seconds)
        log_key = st.key("visual_log.json")
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
            chat=st.chat,
            campaign=st.campaign,
        )

    def _moments_hash(self, st: JobState) -> str:
        """What the picks depend on besides the video: when it changes, saved picks are not reused."""
        basis: dict[str, Any] = {
            "notes": st.notes,
            "target": list(st.clip_target),
            "model": st.model_id or self.cfg.model_id,
        }
        if st.campaign is not None:
            basis["campaign"] = [st.campaign.campaign_id, st.campaign.rules_version]
        return hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()[:16]

    async def _saved_moments(self, st: JobState) -> tuple[list[Moment], list[Moment]] | None:
        """The moments a run that stopped partway already picked (``moments.json``, §30.6), or None."""
        if not st.pick_up:
            return None
        try:
            saved = await self._saved_json(st.key("moments.json"))
            if (
                not isinstance(saved, dict)
                or saved.get("version") != MOMENTS_VERSION
                or saved.get("settings") != self._moments_hash(st)
            ):
                return None
            chosen = [Moment.from_dict(d) for d in saved.get("chosen") or []]
            spares = [Moment.from_dict(d) for d in saved.get("spares") or []]
        except (KeyError, TypeError, ValueError) as e:
            log("warn", "moments.reuse_failed", job=st.job_id, error=type(e).__name__)
            return None
        if not chosen:
            return None
        st.second_look = list(saved.get("secondLook") or [])
        return chosen, spares

    async def select(self, st: JobState, tr: Tracker) -> str:
        saved = await self._saved_moments(st)
        if saved is not None:
            st.chosen, st.spares = saved
            st.moments_reused = True
            log("info", "select.reused", job=st.job_id, chosen=len(st.chosen), spares=len(st.spares))
            return f"Used the {count(len(st.chosen), 'moment')} picked last time."
        # The check that used to end the transcribe step: almost no words is only the end when the picture has
        # nothing strong to offer either.
        strong = st.signals is not None and any(e.intensity >= signals_mod.STRONG for e in st.signals.events)
        if (st.meta.get("fewWords") or len(st.words) < FEW_WORDS) and not strong:
            raise UserFacingError(ALMOST_NO_SPEECH)
        looking = st.frames is not None
        st.chosen, st.spares = await find_moments(
            self._brief(st),
            bedrock=self.claude(st),
            model_id=st.model_id or self.cfg.model_id,
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
                bedrock=self.claude(st),
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
                banned=st.campaign.banned if st.campaign is not None else (),
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
                chat=st.chat,
            )
        except Exception as e:
            log("warn", "signals.picked_for_failed", job=st.job_id, error=type(e).__name__)
            return None

    async def _after_select(self, st: JobState) -> None:
        """``moments.json`` (the checkpoint a resumed run picks up from, §30.6, and for debugging a job afterwards) and
        the disk back for render. Neither can fail the job."""
        try:
            await self.store.put_json(
                st.key("moments.json"),
                {
                    "version": MOMENTS_VERSION,
                    "settings": self._moments_hash(st),
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

    @staticmethod
    async def _ffmpeg_cut(src: str, start: float, end: float, dest: Path) -> Path:
        """One clip's piece of a video file (an upload, on disk or in S3, or the full YouTube download on disk).

        Bounded memory (§30.4): at most 1920 wide and 30 fps (what the clip is made at anyway: a 4K or 60 fps source
        no longer doubles every later frame buffer) and two encoder threads. A read from S3 that stalls for a minute
        fails instead of hanging."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        remote = ["-rw_timeout", "60000000"] if src.startswith(("http://", "https://")) else []
        await proc.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                *remote,
                "-ss",
                f"{start:.2f}",
                "-to",
                f"{end:.2f}",
                "-i",
                src,
                "-vf",
                "scale='min(1920,iw)':-2:flags=bicubic,fps=30",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-threads",
                "2",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(dest),
            ],
            time_limit=20 * 60,
        )
        return dest

    async def _upload_file(self, st: JobState) -> str:
        """Where the Cut step reads an upload: the copy on disk, downloaded once per run when it fits next to
        ``UPLOAD_DISK_SPARE``; else (or when the download fails) the file in S3."""
        async with st.upload_lock:
            if st.upload_source is not None and st.upload_source.is_file():
                return str(st.upload_source)
            if not st.upload_checked:
                st.upload_checked = True
                key = st.key("video.mp4")
                dest = st.workdir / "source" / "upload.mp4"
                try:
                    size = int((await self.store.head(key)).get("ContentLength") or 0)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    free = shutil.disk_usage(dest.parent).free
                    fs = mount_type(dest.parent)
                    room = size + UPLOAD_DISK_SPARE <= free
                    if room and fs in RAM_FILESYSTEMS:
                        # A disk in memory: the copy would use the very memory the cut needs. Only a small file.
                        mem = free_memory()
                        room = mem is not None and size <= mem * RAM_COPY_SHARE
                    log("info", "cut.work_disk", job=st.job_id, fs=fs, free=free, bytes=size)
                    if size and room:
                        await self.store.download(key, dest)
                        st.upload_source = dest
                        log("info", "cut.upload_local", job=st.job_id, bytes=size)
                        return str(dest)
                    log("info", "cut.upload_remote", job=st.job_id, bytes=size, free=free)
                except (JobCanceled, asyncio.CancelledError):
                    raise
                except Exception as e:
                    dest.unlink(missing_ok=True)
                    log("warn", "cut.upload_download_failed", job=st.job_id, error=type(e).__name__)
        return self.store.presign(st.key("video.mp4"))

    @staticmethod
    def _not_for_uploads(st: JobState, what: str) -> None:
        """The YouTube machinery never runs for an uploaded video (§30.5)."""
        if st.source.get("type") == "upload":
            raise RuntimeError(f"{what} is for YouTube links, not uploads")

    async def _fetch_section(self, st: JobState, start: float, end: float, dest: Path) -> Path:
        if st.source.get("type") == "upload":
            return await self._ffmpeg_cut(await self._upload_file(st), start, end, dest)
        platform = str(st.source.get("platform"))
        if platform == "youtube":
            return await self._fetch_youtube(st, start, end, dest)
        url = str(st.meta.get("webpageUrl") or st.source["url"])
        try:
            return await sources.download_section(url, start, end, dest, st.cookies)
        except proc.CommandError as e:
            raise sources.explain(e, platform, st.cookies is not None, section=True) from e

    async def _youtube_section(self, st: JobState, start: float, end: float, dest: Path) -> Path:
        url = str(st.meta.get("webpageUrl") or st.source["url"])
        try:
            return await sources.download_section(
                url, start, end, dest, st.cookies, proxy=st.proxy, info_json=st.info_json
            )
        except proc.CommandError as e:
            raise sources.explain(e, "youtube", st.cookies is not None, section=True) from e

    async def _fetch_youtube(self, st: JobState, start: float, end: float, dest: Path) -> Path:
        """One YouTube clip's piece, in the order of docs/CONTRACTS.md §29.4: the local full video when there is one;
        else a section download from the saved ``-J``; a 403, fragment or merge failure refreshes that ``-J`` once for
        the job and tries again; still failing, or YouTube's bot check, downloads the whole video once and cuts this
        clip (and every later one) from it."""
        if st.full_source is not None:
            return await self._cut_full(st, st.full_source, start, end, dest)
        try:
            return await self._youtube_section(st, start, end, dest)
        except (UserFacingError, TransientError) as e:
            kind = sources.kind_of(e)
            if kind not in ("retry", "blocked"):
                raise
            first = e
        if sources.kind_of(first) == "retry" and await self._refresh_info(st):
            try:
                return await self._youtube_section(st, start, end, dest)
            except (UserFacingError, TransientError) as e:
                if sources.kind_of(e) not in ("retry", "blocked"):
                    raise
        full = await self._ensure_full(st)
        return await self._cut_full(st, full, start, end, dest)

    async def _cut_full(self, st: JobState, full: Path, start: float, end: float, dest: Path) -> Path:
        """One clip's piece of the local full download, which starts at ``st.full_offset`` in the video."""
        self._not_for_uploads(st, "_cut_full")
        off = st.full_offset
        return await self._ffmpeg_cut(str(full), max(0.0, start - off), max(0.0, end - off), dest)

    async def _refresh_info(self, st: JobState) -> bool:
        """A new ``-J`` (fresh signed URLs), once per job. True when this call or an earlier one has refreshed it and
        the section is worth one more try."""
        async with st.full_lock:
            if st.full_source is not None:
                return False
            if st.info_refreshed:
                return True
            st.info_refreshed = True
            if await self._save_info(st):
                log("info", "cut.info_refreshed", job=st.job_id)
                return True
            return False

    async def _save_info(self, st: JobState) -> bool:
        """YouTube's ``-J`` for the Cut step, saved once to the job's scratch folder (§29.4). A bot check or ran-out
        cookies raise: nothing later in the step can help. Any other failure leaves the sections to ask YouTube
        themselves."""
        self._not_for_uploads(st, "_save_info")
        url = str(st.meta.get("webpageUrl") or st.source["url"])
        path = st.workdir / "source" / "cut-info.json"
        await pot.ready()
        try:
            await sources.video_info(url, st.cookies, proxy=st.proxy, info_json=path)
        except proc.CommandError as e:
            err = sources.explain(e, "youtube", st.cookies is not None)
            if sources.kind_of(err) == "blocked":
                raise UserFacingError(sources.CUT_BLOCKED) from e
            if sources.kind_of(err) == "cookies":
                raise err from e
            log("warn", "cut.info_failed", job=st.job_id, error=type(err).__name__, detail=str(e)[:300])
            return False
        st.info_json = path if path.is_file() else None
        return st.info_json is not None

    async def _ensure_full(self, st: JobState) -> Path:
        """The whole video, downloaded once per job (behind ``full_lock``), at the tallest height of the ladder that
        fits the disk. A failure is remembered, so the other clips do not try again."""
        self._not_for_uploads(st, "full_lock")
        async with st.full_lock:
            if st.full_source is not None:
                return st.full_source
            if st.full_error is not None:
                raise st.full_error
            try:
                if st.info_json is None or not st.info_json.is_file():
                    # The first -J failed for a reason other than the bot check (a timeout): one more try.
                    await self._save_info(st)
                st.full_source = await self._download_full(st)
            except UserFacingError as e:
                st.full_error = e
                raise
            return st.full_source

    async def _download_full(self, st: JobState) -> Path:
        info_json = st.info_json
        if info_json is None or not info_json.is_file():
            # No bot check was seen (that raises in _save_info), so these are the plain "try again" words.
            raise UserFacingError(sources.CUT_FAILED)
        try:
            info = json.loads(info_json.read_bytes())
        except ValueError as e:
            raise UserFacingError(sources.CUT_FAILED) from e
        seconds = float(info.get("duration") or st.source.get("durationSec") or 0)
        free = shutil.disk_usage(st.workdir).free
        plan = full_plan(info, seconds, clip_span(st), free)
        if plan is None:
            log("warn", "cut.full_too_big", job=st.job_id, seconds=seconds, free=free)
            raise UserFacingError(sources.CUT_TOO_BIG)
        fmt, section = plan
        log(
            "info",
            "cut.full_fallback",
            job=st.job_id,
            height=fmt["height"],
            estBytes=fmt["estBytes"],
            seconds=seconds,
            section=list(section) if section else None,
        )
        url = str(st.meta.get("webpageUrl") or st.source["url"])
        try:
            path = await sources.download_full(
                url,
                fmt["format"],
                st.workdir / "source" / "full.mp4",
                est_bytes=int(fmt["estBytes"]),
                cookies=st.cookies,
                proxy=st.proxy,
                info_json=info_json,
                section=section,
            )
            st.full_offset = section[0] if section else 0.0
            return path
        except proc.CommandError as e:
            err = sources.explain(e, "youtube", st.cookies is not None)
            if sources.kind_of(err) == "cookies":
                raise err from e
            log("warn", "cut.full_failed", job=st.job_id, kind=sources.kind_of(err), detail=str(e)[:300])
            raise UserFacingError(
                sources.CUT_BLOCKED if sources.kind_of(err) == "blocked" else sources.CUT_FAILED
            ) from e
        except TransientError as e:
            log("warn", "cut.full_failed", job=st.job_id, kind="retry", detail=str(e)[:300])
            raise UserFacingError(sources.CUT_FAILED) from e

    @staticmethod
    def _drop_full(st: JobState) -> None:
        """The full video and the saved ``-J`` are only for this run's cuts: gone once the clips are made."""
        for f in (st.workdir / "source").glob("full.*"):
            f.unlink(missing_ok=True)
        (st.workdir / "source" / "cut-info.json").unlink(missing_ok=True)
        st.full_source = None
        st.full_offset = 0.0
        st.info_json = None

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
            detect_layout=functools.partial(self.claude(st).detect_layout, skills=st.block),
            known_layout=layout,
            live_index=index + 1,
            marks=st.marks,
        )
        return Candidate(m, r, index=index)

    def _render_key(self, st: JobState, index: int, name: str, folder: str = "render") -> str:
        return st.key(f"{folder}/{index:02d}/{name}")

    async def _save_clip(self, st: JobState, c: Candidate, folder: str = "render") -> None:
        """The finished clip, its cover and what it is (``render/NN/``, §30.6), right after it is cut: a run that
        stops later picks it up instead of cutting it again. The checklist keeps the clips it re-cut or brought in
        as spares in ``checked/NN/``. Never fails the clip."""
        r = c.render
        try:
            fl = r.frame_layout
            done = {
                "version": MOMENTS_VERSION,
                "moment": c.moment.to_dict(),
                "duration": r.duration,
                "segments": [list(x) for x in r.segments],
                "captions": r.captions,
                "layout": r.layout,
                "tease": r.tease,
                "frameLayout": {"scene": fl.scene, "facecam": vars(fl.facecam) if fl.facecam else None} if fl else None,
                "extra": r.extra,
                **({"logo": True} if r.logo else {}),
                **({"disclosure": True} if r.disclosure else {}),
            }
            await self.store.upload(r.video, self._render_key(st, c.index, "clip.mp4", folder), "video/mp4")
            await self.store.upload(r.cover, self._render_key(st, c.index, "cover.jpg", folder), "image/jpeg")
            await self.store.put_json(self._render_key(st, c.index, "done.json", folder), done)  # last: marks it whole
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "render.save_failed", job=st.job_id, index=c.index, error=type(e).__name__)

    async def _saved_clip(self, st: JobState, m: Moment, index: int, folder: str = "render") -> Candidate | None:
        """The clip a run that stopped partway already cut for this moment, downloaded back, or None."""
        if not st.pick_up:
            return None
        try:
            done = await self._saved_json(self._render_key(st, index, "done.json", folder))
            if not isinstance(done, dict) or done.get("version") != MOMENTS_VERSION:
                return None
            if Moment.from_dict(done["moment"]).to_dict() != m.to_dict():
                return None  # another moment was cut at this index
            workdir = st.workdir / "clips" / f"{index:02d}"
            workdir.mkdir(parents=True, exist_ok=True)
            video, cover = workdir / "clip.mp4", workdir / "cover.jpg"
            await self.store.download(self._render_key(st, index, "clip.mp4", folder), video)
            await self.store.download(self._render_key(st, index, "cover.jpg", folder), cover)
            fl = done.get("frameLayout")
            layout = (
                FrameLayout(Facecam(**fl["facecam"]) if fl.get("facecam") else None, str(fl.get("scene") or "other"))
                if isinstance(fl, dict)
                else None
            )
            r = RenderResult(
                video=video,
                cover=cover,
                duration=float(done["duration"]),
                segments=[(float(a), float(b)) for a, b in done.get("segments") or []],
                captions=list(done.get("captions") or []),
                layout=str(done.get("layout") or "blur_fill"),
                tease=bool(done.get("tease")),
                frame_layout=layout,
                extra=dict(done.get("extra") or {}),
                logo=bool(done.get("logo")),
                disclosure=bool(done.get("disclosure")),
            )
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "render.reuse_failed", job=st.job_id, index=index, error=type(e).__name__)
            return None
        return Candidate(m, r, index=index)

    def _can_parallel(self, st: JobState) -> bool:
        """A second clip is cut alongside only for a source up to 1080p and with 3 GiB of memory to spare. A link's
        sections are 1080p at most (sources.VIDEO_FORMAT); an upload's height is the file's own (``sourceHeight``)."""
        height = int(st.meta.get("sourceHeight") or (st.meta.get("picture") or {}).get("height") or 0)
        if height > PARALLEL_MAX_HEIGHT:
            return False
        free = free_memory()
        return free is None or free > PARALLEL_FREE

    async def _deaths(self, st: JobState, index: int) -> int:
        """How many earlier runs stopped while this clip was being cut (``render/NN/started.json`` left by another
        session, with no ``done.json``). 0 unless picking up."""
        if not st.pick_up:
            return 0
        mark = await self._saved_json(self._render_key(st, index, "started.json"))
        if not isinstance(mark, dict) or mark.get("session") == st.session_id:
            return 0
        try:
            return max(0, int(mark.get("runs") or 0))
        except (TypeError, ValueError):
            return 0

    async def _mark_started(self, st: JobState, index: int, runs: int) -> None:
        """``render/NN/started.json``: this clip is being cut now (``runs``: the runs that were cutting it when they
        stopped, this one included). An ordinary failure writes 0: only a death counts."""
        try:
            await self.store.put_json(
                self._render_key(st, index, "started.json"), {"session": st.session_id, "runs": runs, "at": now_iso()}
            )
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "render.mark_failed", job=st.job_id, index=index, error=type(e).__name__)

    async def render(self, st: JobState, tr: Tracker) -> str:
        if await self._reload_checked(st, tr):
            return f"Used the {count(len(st.candidates), 'clip')} cut and checked last time."
        if st.source.get("type") != "upload" and st.source.get("platform") == "youtube":
            # One extraction for every clip (§29.4): the sections read the formats from this file. Blocked here, the
            # owner's Mac gets the video instead (§35.1).
            try:
                await self._save_info(st)
            except UserFacingError as e:
                if needs_mac(st, str(e), None):
                    log("info", "render.needs_mac", job=st.job_id, why=str(e)[:80])
                    raise NeedsMac("cut") from e
                raise
        gate = RenderGate(RENDER_CONCURRENCY, lambda: self._can_parallel(st))
        if st.pick_up:
            gate.serial = True  # the run before stopped partway: one clip at a time, the safest way (§30.4)
        done = 0
        reused = 0
        given_up = 0
        results: list[Candidate | None] = [None] * len(st.chosen)
        reasons: list[str] = []

        def tick() -> None:
            nonlocal done
            done += 1
            tr.report(done / len(st.chosen))

        async def cut(i: int, m: Moment, deaths: int) -> None:
            for attempt in (1, 2):
                async with gate:
                    await tr.check_cancel()
                    await self._mark_started(st, i, deaths + 1)
                    livestatus.emit("cut", i=i + 1, n=len(st.chosen))  # "Cutting clip 3 of 10" (§31)
                    try:
                        results[i] = await self._cut(st, m, i)
                        break
                    except JobCanceled:
                        raise
                    except Exception as e:
                        if attempt == 1 and proc.was_killed(e):
                            # The kernel killed ffmpeg for memory: once more, with nothing cut alongside.
                            gate.serial = True
                            log("warn", "render.clip_killed", job=st.job_id, index=i)
                            continue
                        # One clip that can't be cut (a 403 on one section, a failed ffmpeg fragment) is
                        # skipped; only "none of them" fails the step.
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
                        break
                    finally:
                        livestatus.emit("cut_done", i=i + 1)
            if results[i] is not None:
                await self._save_clip(st, results[i])  # type: ignore[arg-type]
            else:
                await self._mark_started(st, i, 0)  # an ordinary failure, not a death
            tick()

        # Clips a run that stopped already cut come back from S3; a clip that was being cut when an earlier run died
        # is cut last, alone, and one that was in flight during MAX_CLIP_DEATHS deaths is left out (§30.4).
        plain: list[tuple[int, Moment]] = []
        suspects: list[tuple[int, Moment, int]] = []
        for i, m in enumerate(st.chosen):
            await tr.check_cancel()
            saved = await self._saved_clip(st, m, i)
            if saved is not None:
                results[i] = saved
                reused += 1
                tick()
                continue
            deaths = await self._deaths(st, i)
            if deaths >= MAX_CLIP_DEATHS:
                given_up += 1
                log("warn", "render.clip_given_up", job=st.job_id, index=i, deaths=deaths)
                tick()
            elif deaths:
                suspects.append((i, m, deaths))
            else:
                plain.append((i, m))
        # A cancel stops every cut still running before the job's workdir is removed. The upload's local copy stays
        # for the checklist's spares; the job's workdir goes when the run ends.
        if plain:
            await gather_all(*(cut(i, m, 0) for i, m in plain))
        for i, m, deaths in suspects:
            log("warn", "render.clip_retried_alone", job=st.job_id, index=i, deaths=deaths)
            gate.serial = True
            await cut(i, m, deaths)
        st.candidates = [c for c in results if c]
        if reused or given_up:
            log("info", "render.reused", job=st.job_id, clips=reused, given_up=given_up)
        if not st.candidates:
            self._drop_full(st)
            why = cut_failure(reasons)
            if needs_mac(st, why, st.full_error):
                log("info", "render.needs_mac", job=st.job_id, why=why[:80])
                raise NeedsMac("cut")
            raise UserFacingError(why)
        failed = len(st.chosen) - len(st.candidates)
        return f"Cut {count(len(st.candidates), 'clip')}" + (f"; {failed} could not be cut." if failed else ".")

    # --- checklist -------------------------------------------------------------------------------------------

    async def _review(self, st: JobState, c: Candidate) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(
                self.claude(st).structured(
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
                                campaign=st.campaign,
                            )
                        }
                    ],
                    tool="submit_review",
                    description="Submit the checklist review of this clip.",
                    schema=review_schema(st.campaign),
                    max_tokens=8000,
                ),
                REVIEW_SECONDS,
            )
        except Exception as e:
            if model_unavailable(e) or not isinstance(e, ModelError | TimeoutError | TransientError | ClientError):
                raise  # the model is not turned on: the job ends with the plain way to turn it on (jobs.py)
            # No judgement available (a bad answer, no answer in time, the service busy): the measured checks
            # decide, and the owner reviews every clip anyway.
            log(
                "warn",
                "checklist.review_failed",
                job=st.job_id,
                index=c.index,
                error=type(e).__name__,
                detail=str(e)[:200],
            )
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
                # Nobody looked at the campaign's rules: a warning on Review, never a silent pass.
                **({"follows_rules": None, "follows_rules_note": ""} if st.campaign is not None else {}),
            }

    async def _check_one(self, st: JobState, c: Candidate, index: int, gate: RenderGate | None = None) -> Outcome:
        async def first() -> tuple[dict[str, Any], list[Item]]:
            review = await self._review(st, c)
            items = measured_items(
                c.moment,
                c.render,
                await measure(c.render.video),
                st.length,
                has_speech=self._has_speech(st, c.moment),
                campaign=st.campaign,
            ) + judged_items(review, st.campaign)
            return review, items

        review, items = await asyncio.wait_for(first(), CHECK_CLIP_SECONDS)
        if review.get("verdict") == "drop":
            return Outcome(False, Candidate(c.moment, c.render, items, index=index), "Claude judged it unfixable.")
        fixes: list[str] = []
        if any(not i.passed for i in items):
            fixed, fixes = plan_fix(
                c.moment,
                items,
                review,
                length=st.length,
                first_loud=lambda t: loudness.first_loud_second(st.loud, t),
                strict=st.campaign is not None and st.campaign.sets_length,
                duration=c.render.duration,
            )
            if fixes:
                async with gate or contextlib.nullcontext():
                    # The timer starts once the slot is taken: waiting for one is not the cut's time.
                    async def recut() -> tuple[Candidate, list[Item]]:
                        cut = await self._cut(st, fixed, index, layout=c.render.frame_layout)
                        return cut, measured_items(
                            cut.moment,
                            cut.render,
                            await measure(cut.render.video),
                            st.length,
                            has_speech=self._has_speech(st, cut.moment),
                            campaign=st.campaign,
                        )

                    c, measured = await asyncio.wait_for(recut(), CUT_SECONDS)
                # Claude's judgement stands, except for what the fix addressed.
                judged = judged_items(
                    {
                        **review,
                        "pays_off": review.get("pays_off") or any("payoff" in f for f in fixes),
                        "hook_ok": review.get("hook_ok") or any(f.startswith("New hook") for f in fixes),
                    },
                    st.campaign,
                )
                items = measured + judged
        bad = critical_failure(items)
        cand = Candidate(c.moment, c.render, items, fixes, index=index)
        return Outcome(bad is None, cand, f"{bad.label} {bad.note}" if bad else "")

    async def checklist(self, st: JobState, tr: Tracker) -> str:
        if st.checked:
            # Cut the clips brought back the clips the stopped run had already checked (§30.6).
            return f"Used the checks from last time for {count(len(st.candidates), 'clip')}."
        loop = asyncio.get_running_loop()
        next_index = len(st.chosen)
        originals = list(st.candidates)
        gate = RenderGate(RENDER_CONCURRENCY, lambda: self._can_parallel(st))
        if st.pick_up:
            gate.serial = True
        running: dict[int, float] = {}  # clip index -> loop time its check began
        state = {"done": 0, "total": len(originals), "swaps": 0}

        def say() -> None:
            done, total = state["done"], state["total"]
            if state["swaps"] and running:
                n = state["swaps"]
                tr.say(f"Swapping {n} {'clip' if n == 1 else 'clips'} for better moments. Checked {done} of {total}.")
            elif done < total:
                tr.say(f"Checking clip {min(total, done + 1)} of {total}…")

        def bar(*, alive: bool) -> None:
            # Finished checks, plus each running one's likely share so far (never a whole clip until it is done).
            now = loop.time()
            partial = sum(min(0.9, (now - t0) / CHECK_EXPECTED) for t0 in running.values())
            tr.report((state["done"] + partial) / max(1, state["total"]), alive=alive)

        async def ticking() -> None:
            while True:
                await asyncio.sleep(5)
                bar(alive=False)

        async def check(c: Candidate) -> Outcome:
            await tr.check_cancel()
            running[c.index] = t0 = loop.time()
            say()
            try:
                out = await self._check_one(st, c, c.index, gate)
            except TimeoutError:
                log("warn", "checklist.clip_timed_out", job=st.job_id, index=c.index, seconds=round(loop.time() - t0))
                out = Outcome(False, c, "The clip could not be checked in time.")
            except (UserFacingError, TransientError, ModelError, proc.CommandError, OSError, ValueError) as e:
                # One clip that can't be checked or re-cut is replaced by a spare; it never fails the job.
                log(
                    "warn",
                    "checklist.clip_failed",
                    job=st.job_id,
                    index=c.index,
                    error=type(e).__name__,
                    detail=str(e)[:400],
                )
                out = Outcome(False, c, "The clip could not be checked.")
            finally:
                running.pop(c.index, None)
            state["done"] += 1
            log(
                "info",
                "checklist.clip_checked",
                job=st.job_id,
                index=c.index,
                outcome="passed" if out.ok else "failed",
                seconds=round(loop.time() - t0, 1),
                fixes=len(out.candidate.fixes),
                detail=out.reason[:200],
            )
            bar(alive=True)
            say()
            return out

        async def cut(m: Moment) -> Candidate | None:
            nonlocal next_index
            next_index += 1
            try:
                async with gate:
                    c = await asyncio.wait_for(self._cut(st, m, next_index - 1), CUT_SECONDS)
                log("info", "checklist.spare_cut", job=st.job_id, index=c.index)
                return c
            except JobCanceled:
                raise
            except Exception as e:
                log("warn", "checklist.spare_failed", job=st.job_id, error=type(e).__name__, detail=str(e)[:300])
                return None

        def swapped(n: int) -> None:
            state["swaps"] = n
            say()

        def progress(done: int, total: int) -> None:
            state["total"] = total

        tr.say(f"Checking {count(len(originals), 'clip')}…")
        ticker = asyncio.create_task(ticking())
        try:
            passed, failed = await check_all(
                originals,
                st.spares,
                check=check,
                cut=cut,
                want=len(st.chosen),
                on_progress=progress,
                on_swap=swapped,
                limit=CHECK_CONCURRENCY,
            )
        finally:
            ticker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticker
        if not passed:
            unchecked = [o.candidate for o in failed if o.reason.startswith("The clip could not be checked")]
            if not unchecked:
                reasons = "; ".join(sorted({o.reason for o in failed if o.reason}))[:200]
                raise UserFacingError(f"No clip passed the checklist ({reasons}). Try another video or add notes.")
            # Nothing passed only because nothing could be checked (not because the clips are bad): the clips go
            # on to the owner as they are, each saying so, rather than the job failing with nothing.
            log("warn", "checklist.kept_unchecked", job=st.job_id, clips=len(unchecked))
            unchecked = sorted(unchecked, key=lambda c: c.index)[: len(st.chosen)]  # the clips first, then spares
            passed = [
                Candidate(c.moment, c.render, [Item("checked", "Checked", False, UNCHECKED)], [], index=c.index)
                for c in unchecked
            ]
            st.candidates = passed
            await self._save_checked(st)
            return f"{count(len(passed), 'clip')} could not be checked; look at each one before posting."
        st.candidates = passed
        await self._save_checked(st)
        replaced = sum(1 for c in passed if c.index >= len(st.chosen))
        msg = f"{count(len(passed), 'clip')} passed"
        return msg + (f"; {replaced} swapped for other moments." if replaced else ".")

    async def _save_checked(self, st: JobState) -> None:
        """``checked.json`` and ``checked/NN/`` (§30.6): the checked clips, so a run picking up after the checklist
        reuses them (and their checks) instead of cutting and checking again. Clips the checklist re-cut or brought
        in as spares are saved; the others are already in ``render/NN/``. Never fails the step."""
        chosen = [m.to_dict() for m in st.chosen]
        try:
            fresh = [c for c in st.candidates if c.index >= len(chosen) or c.moment.to_dict() != chosen[c.index]]
            await gather_all(*(self._save_clip(st, c, "checked") for c in fresh))
            await self.store.put_json(
                st.key("checked.json"),
                {
                    "version": MOMENTS_VERSION,
                    "chosen": chosen,
                    "clips": [
                        {
                            "index": c.index,
                            "moment": c.moment.to_dict(),
                            "items": [i.public() for i in c.items],
                            "fixes": c.fixes,
                        }
                        for c in st.candidates
                    ],
                },
            )
            log("info", "checklist.saved", job=st.job_id, clips=len(st.candidates), recut=len(fresh))
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "checklist.save_failed", job=st.job_id, error=type(e).__name__)

    async def _reload_checked(self, st: JobState, tr: Tracker) -> bool:
        """Picking up after the checklist had finished (§30.6): the checked clips come back from S3, so neither
        Cut the clips nor Check each clip runs again. From ``checked.json``; for a run from before that file
        existed, from ``clips.json`` (written by the captions step, so every clip in it had passed), with the
        measured checks taken again from the file (seconds, no model). A clip whose file is gone (a re-cut that was
        never saved) is cut once more from its saved moment. Only with the moments the stopped run picked."""
        if not (st.pick_up and st.moments_reused):
            return False
        saved = await self._saved_json(st.key("checked.json"))
        with_items = (
            isinstance(saved, dict)
            and saved.get("version") == MOMENTS_VERSION
            and saved.get("chosen") == [m.to_dict() for m in st.chosen]
        )
        if with_items:
            rows = [r for r in saved.get("clips") or [] if isinstance(r, dict)]
        else:
            ids = await self._saved_clip_ids(st)
            rows = [ids[k] for k in sorted(ids)]
        try:
            clips = [(int(r["index"]), Moment.from_dict(r["moment"]), r) for r in rows]
        except (KeyError, TypeError, ValueError) as e:
            log("warn", "checklist.reuse_failed", job=st.job_id, error=type(e).__name__)
            return False
        if not clips:
            return False
        n = len(clips)
        tr.say(f"Getting the {count(n, 'checked clip')} from last time…")
        out: list[Candidate] = []
        recut = 0
        for k, (i, m, row) in enumerate(clips):
            await tr.check_cancel()
            c = await self._saved_clip(st, m, i, "checked") or await self._saved_clip(st, m, i)
            if c is None:
                tr.say(f"Cutting clip {k + 1} of {n} again; the rest come from last time…")
                try:
                    if st.source.get("type") != "upload" and st.source.get("platform") == "youtube":
                        await self._save_info(st)
                    c = await self._cut(st, m, i)
                except JobCanceled:
                    raise
                except Exception as e:
                    log(
                        "warn",
                        "checklist.recut_failed",
                        job=st.job_id,
                        index=i,
                        error=type(e).__name__,
                        detail=str(e)[:300],
                    )
                    continue
                await self._save_clip(st, c, "checked")
                recut += 1
            if with_items:
                c.items = [
                    Item(str(x["key"]), str(x["label"]), bool(x["pass"]), str(x.get("note") or ""))
                    for x in row.get("items") or []
                    if isinstance(x, dict) and "key" in x
                ]
                c.fixes = [str(f) for f in row.get("fixes") or []]
            else:
                c.items = await self._items_again(st, c)
            out.append(c)
            tr.report((k + 1) / n)
        if not out:
            return False
        st.candidates, st.checked = out, True
        log("info", "checklist.reused", job=st.job_id, clips=len(out), recut=recut, items=with_items)
        return True

    async def _items_again(self, st: JobState, c: Candidate) -> list[Item]:
        """The checks of a clip that passed in an earlier run whose results were not saved: the measured ones again,
        and Claude's review as passed (it did, or the clip would not be in ``clips.json``)."""
        passed = Item("review", "Claude's review", True, "Kept by the check on the run before.")
        try:
            got = await measure(c.render.video)
        except (proc.CommandError, OSError, ValueError) as e:
            log("warn", "checklist.measure_failed", job=st.job_id, index=c.index, error=type(e).__name__)
            return [passed]
        measured = measured_items(
            c.moment, c.render, got, st.length, has_speech=self._has_speech(st, c.moment), campaign=st.campaign
        )
        return [*measured, passed]

    # --- captions --------------------------------------------------------------------------------------------

    async def _saved_clip_ids(self, st: JobState) -> dict[int, dict[str, Any]]:
        """``clips.json`` of a run that stopped partway (§30.6): per clip index, the clip id it gave the clip, the moment
        and its captions. Empty unless picking up."""
        if not st.pick_up:
            return {}
        saved = await self._saved_json(st.key("clips.json"))
        if not isinstance(saved, dict) or saved.get("version") != MOMENTS_VERSION:
            return {}
        out: dict[int, dict[str, Any]] = {}
        for row in saved.get("clips") or []:
            if isinstance(row, dict) and isinstance(row.get("index"), int) and isinstance(row.get("id"), str):
                out[row["index"]] = row
        return out

    async def write_captions(self, st: JobState, tr: Tracker) -> str:
        # A run picking up gives each clip the id the stopped run gave it (by clip index), so a clip that run already
        # wrote is never written twice; its captions are reused when the clip is the same moment.
        saved = await self._saved_clip_ids(st)
        for c in st.candidates:
            old = saved.get(c.index)
            st.clip_ids[id(c)] = str(old["id"]) if old else ulid()
        same = bool(st.candidates) and all(
            (old := saved.get(c.index)) is not None
            and old.get("moment") == c.moment.to_dict()
            and isinstance(old.get("captions"), dict)
            for c in st.candidates
        )
        if same:
            st.captions = {st.clip_ids[id(c)]: dict(saved[c.index]["captions"]) for c in st.candidates}
            log("info", "captions.reused", job=st.job_id, clips=len(st.candidates))
        else:
            tr.say(f"Writing captions for {count(len(st.candidates), 'clip')}…")
            texts = [
                captions_mod.ClipText(st.clip_ids[id(c)], c.moment, " ".join(x["text"] for x in c.render.captions))
                for c in st.candidates
            ]
            async with creep(tr.report, 0.05, 0.9, expected=60.0):
                st.captions = await captions_mod.write_captions(
                    self.claude(st),
                    texts,
                    notes=st.notes,
                    skills=st.block,
                    skills_text=st.skills.full_text,
                    system=learnings.with_prior(st.prior, "You write social captions for short clips."),
                    answer_seconds=CAPTIONS_SECONDS,
                    campaign=st.campaign,
                )
        rows = [
            {
                "index": c.index,
                "id": st.clip_ids[id(c)],
                "moment": c.moment.to_dict(),
                "captions": st.captions.get(st.clip_ids[id(c)]),
            }
            for c in st.candidates
        ]
        try:
            await self.store.put_json(st.key("clips.json"), {"version": MOMENTS_VERSION, "clips": rows})
            st.ids_saved = True
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:
            log("warn", "captions.save_failed", job=st.job_id, error=type(e).__name__)
        required = captions_mod.required_tags(st.notes, st.skills.full_text, st.campaign)
        for c in st.candidates:
            title = st.captions[st.clip_ids[id(c)]]["youtubeTitle"]
            c.items = [i for i in c.items if i.key not in ("tags", "title", "campaign_tags")]
            c.items.append(
                Item(
                    "tags",
                    "Required tags and hashtags",
                    True,
                    f"In every caption: {' '.join(required)}" if required else "None required.",
                )
            )
            c.items.append(Item("title", "Title under 60 characters", len(title) < 60, f"{len(title)} characters."))
            if st.campaign is not None:
                c.items.append(self._campaign_tags_item(st.campaign, st.captions[st.clip_ids[id(c)]]))
        return f"Wrote captions for {count(len(st.candidates), 'clip')}."

    @staticmethod
    def _campaign_tags_item(campaign: Campaign, captions: dict[str, str]) -> Item:
        """``campaign_tags`` (§38.13): the disclosure first and every campaign item in every caption but the title."""
        disclosure = campaign.disclosure_caption
        items = captions_mod.campaign_items(campaign)
        ok = captions_mod.qualifies(captions, items)
        note = f"First in every caption: {disclosure}." + (
            f" Also in every caption: {' '.join(items)}" if items else ""
        )
        return Item(
            "campaign_tags",
            f"{disclosure} and the campaign's tags in every caption",
            ok,
            note if ok else f"A caption is missing {disclosure} or a campaign tag. I put them back when it uploads.",
        )

    # --- finalize --------------------------------------------------------------------------------------------

    async def finalize(self, st: JobState, tr: Tracker) -> str:
        platform = str(st.source.get("platform") or "upload")
        url = str(st.meta.get("webpageUrl") or st.source.get("url") or "")
        items = [
            clip_item(st, c, st.clip_ids[id(c)], rank, clip_prefix(st.job_id, st.clip_ids[id(c)]), platform, url)
            for rank, c in enumerate(st.candidates, start=1)
        ]
        pairs = list(zip(st.candidates, items, strict=True))
        if st.pick_up:
            # The run that stopped may have written some of these clips already (same ids, write_captions); a clip the
            # owner already kept or declined is left exactly as it is, never written twice (§30.6).
            there = await self.store.clip_statuses(st.user_id, [i["clipId"] for i in items])
            if there:
                log("info", "finalize.already_written", job=st.job_id, clips=len(there))
            pairs = [(c, i) for c, i in pairs if i["clipId"] not in there]
        # The vectors go first: once a Clip item is visible the owner can Keep or Decline it, and clip-flow then
        # rewrites (Keep) or the API deletes (Decline) its vector. A later put here would undo that.
        await tr.check_cancel()
        await self._put_vectors(st, [i for _, i in pairs])
        for k, (c, item) in enumerate(pairs, start=1):
            await tr.check_cancel()
            tr.say(f"Saving clip {k} of {len(pairs)}…")
            await self.store.upload(c.render.video, item["videoKey"], "video/mp4")
            await self.store.upload(c.render.cover, item["coverKey"], "image/jpeg")
            try:
                await self.store.put_clip(item, fence=st.fence)
            except JobSuperseded:
                # A newer run owns the job: this clip's files go too, unless clips.json holds its id; then the newer
                # run picking up uses the same id and the same files, and they stay.
                if not st.ids_saved:
                    try:
                        await self.store.delete_keys([item["videoKey"], item["coverKey"]])
                    except Exception as e:
                        log("warn", "finalize.cleanup_failed", job=st.job_id, error=type(e).__name__)
                raise
            log("info", "finalize.clip_saved", job=st.job_id, index=c.index)
            tr.report(k / len(pairs))
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
    if st.campaign_id:
        item["campaignId"] = st.campaign_id  # public: the review card and Confirm read the campaign from it (§38.8)
    if url and platform in ("youtube", "twitch", "kick"):
        at = sources.url_at(url, platform, m.start)
        if at:
            item["sourceUrlAt"] = at
    return item
