"""A campaign copy of a clip (docs/CONTRACTS.md §39.3, ADR-63): the one moment a copy job makes again.

The API makes the copy as a one-clip campaign job with an internal ``remake`` (``{clipId, jobId, sourceStart,
sourceEnd, layout, momentType, hook, pickedFor, sourceKey}``, the clip it copies). The agent finds no moments for it:
it cuts that clip's moment again (from the original's kept video when ``sourceKey`` names it, else from the link),
with the campaign's band, logo and disclosure, and writes one Clip that says which clip it copies (``remakeOf``). The
original clip and its job are only ever read. A job without ``remake`` never builds one of these."""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from .moments import MOMENT_TYPES, Moment
from .store import kept_video_keys
from .util import UserFacingError, log

CANT_COPY = "Clip Factory couldn't make this copy. Make new clips for this campaign."
VIDEO_GONE = "This video is gone from Clip Factory. Make new clips for this campaign."  # the API's own words (§39.3)
NEW_CLIPS = "Make new clips for this campaign."
FAILED_CHECKS = "This copy didn't pass its checks. " + NEW_CLIPS
MAX_REASON = 120
SAME_SPAN = 0.05  # seconds: a saved moment is the clip's own when both of its ends are this close
_ID = re.compile(r"[0-9A-Za-z]{1,64}")  # a ULID (or a test's short id): it becomes part of an S3 key
MAX_TEXT = 300


def _id(value: Any) -> str | None:
    return value if isinstance(value, str) and _ID.fullmatch(value) else None


def _seconds(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    v = float(value)
    return v if math.isfinite(v) and v >= 0 else None


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    out = " ".join(value.split())[:MAX_TEXT]
    return out or None


def _kind(value: Any) -> str | None:
    return value if isinstance(value, str) and value in MOMENT_TYPES else None


@dataclass(frozen=True)
class Remake:
    """``job.remake``, checked: the clip it copies (``clip_id`` of ``job_id``), that clip's moment in the video and,
    when it is still kept, the whole video the moment is cut from (``source_key``, one of ``kept_video_keys``).
    ``layout`` is the original clip's layout name: only logged against the copy's (a name can't rebuild where the
    facecam was; the framing comes from the original's ``done.json``)."""

    clip_id: str
    job_id: str
    start: float
    end: float
    moment_type: str | None = None
    hook: str | None = None
    picked_for: str | None = None
    layout: str | None = None
    source_key: str | None = None

    @classmethod
    def from_job(cls, job: Mapping[str, Any], user_id: str) -> Remake | None:
        """None for every job without ``remake``. A ``remake`` that can't be read fails the job with plain words: a
        copy job never goes on to find moments of its own."""
        raw = job.get("remake")
        if raw is None:
            return None
        if not isinstance(raw, Mapping):
            raise UserFacingError(CANT_COPY)
        clip_id, job_id = _id(raw.get("clipId")), _id(raw.get("jobId"))
        start, end = _seconds(raw.get("sourceStart")), _seconds(raw.get("sourceEnd"))
        if clip_id is None or job_id is None or start is None or end is None or end <= start:
            log("error", "remake.unreadable", job=str(job.get("jobId") or ""))
            raise UserFacingError(CANT_COPY)
        key = raw.get("sourceKey")
        source_key = key if isinstance(key, str) and key in kept_video_keys(user_id, job_id) else None
        if key is not None and source_key is None:
            log("warn", "remake.source_key_refused", job=str(job.get("jobId") or ""))
        layout = raw.get("layout")
        return cls(
            clip_id=clip_id,
            job_id=job_id,
            start=start,
            end=end,
            moment_type=_kind(raw.get("momentType")),
            hook=_text(raw.get("hook")),
            picked_for=_text(raw.get("pickedFor")),
            layout=layout if isinstance(layout, str) and layout else None,
            source_key=source_key,
        )

    @property
    def remake_of(self) -> dict[str, str]:
        """The copy's public ``remakeOf`` (on its Clip item): the clip it copies and that clip's job."""
        return {"clipId": self.clip_id, "jobId": self.job_id}

    def same_span(self, m: Moment) -> bool:
        return abs(m.start - self.start) <= SAME_SPAN and abs(m.end - self.end) <= SAME_SPAN

    def moment(self, saved: Moment | None, clip: Mapping[str, Any] | None) -> Moment:
        """The one moment the copy cuts. ``saved`` is the moment the original job kept for this clip (its
        ``clips.json``, while it is kept: the tease, the payoff and the peak come with it); ``clip`` is the original
        Clip item. The span, the kind of moment, the hook and why it was picked are always the clip's own (from
        ``remake``). With neither, nothing true could be said about the clip (its score, what happens): no copy."""
        c = clip or {}
        if saved is not None and self.same_span(saved):
            return replace(
                saved,
                start=self.start,
                end=self.end,
                moment_type=self.moment_type or saved.moment_type,
                hook=self.hook or saved.hook,
                picked_for=self.picked_for or saved.picked_for,
            )
        score = c.get("score")
        if not clip or isinstance(score, bool) or not isinstance(score, int | float):
            raise UserFacingError(CANT_COPY)
        return Moment(
            start=self.start,
            end=self.end,
            moment_type=self.moment_type or _kind(c.get("momentType")) or "no_way",
            hook=self.hook or _text(c.get("hook")) or "",
            first_words="",
            payoff_at=self.end,  # a clip ends right on its payoff (moments.MOMENT_SCHEMA)
            peak_at=round((self.start + self.end) / 2, 2),
            why="",
            score=float(score),
            summary=_text(c.get("summary")) or "",
            picked_for=self.picked_for or _text(c.get("pickedFor")),
        )


def cant_earn(campaign: str, note: str) -> str:
    """Why a copy's one clip failed its checks, in plain words (a copy has no other moment to swap in, and no notes
    to add): "This copy can't earn on FaZe Clips: Shows gambling at 0:12. Make new clips for this campaign." With no
    note to say: ``FAILED_CHECKS``."""
    why = " ".join(note.split())
    if len(why) > MAX_REASON:
        why = why[:MAX_REASON].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    if not why:
        return FAILED_CHECKS
    if why[-1] not in ".!?…":
        why += "."
    name = " ".join(campaign.split())
    return f"This copy can't earn{f' on {name}' if name else ''}: {why} {NEW_CLIPS}"


def saved_moment(clips_json: Any, clip_id: str) -> Moment | None:
    """The moment a job's ``clips.json`` (written by its captions step, §30.6) keeps for ``clip_id``, or None."""
    if not isinstance(clips_json, Mapping):
        return None
    for row in clips_json.get("clips") or []:
        if isinstance(row, Mapping) and row.get("id") == clip_id and isinstance(row.get("moment"), Mapping):
            try:
                return Moment.from_dict(dict(row["moment"]))
            except (KeyError, TypeError, ValueError):
                return None
    return None


def saved_index(clips_json: Any, clip_id: str) -> int | None:
    """Where ``clip_id`` sat in its job (its ``render/NN`` folder), from the same ``clips.json``."""
    if not isinstance(clips_json, Mapping):
        return None
    for row in clips_json.get("clips") or []:
        if isinstance(row, Mapping) and row.get("id") == clip_id:
            i = row.get("index")
            return i if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < 100 else None
    return None
