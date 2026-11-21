"""The campaign copy of a clip (docs/CONTRACTS.md §39.3, ADR-63): ``POST /v1/contentrewards/campaigns/{id}/remake``.

A normal clip that could earn (or a campaign clip missing its logo or its "Paid partnership" words) gets a new
one-clip campaign job of the same moment, re-rendered with the campaign's rules; the clip it came from stays as it
is. The copy is reserved on the original clip first (``remakes.{campaignId} = {jobId, at}``, conditional), so a
double tap makes one copy; a copy whose job failed, was canceled or deleted, or whose clip was thrown away no longer
counts and may be made again. The agent (I) reads ``job.remake`` and cuts the one moment from ``sourceKey``.

Off (503 "Coming soon.") until ``CR_REMAKE=on`` (Terraform ``cr_remake_enabled``), which waits for the agent's part.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import clips, db, s3
from ..clock import iso, parse
from ..log import log
from .util import obj

Item = dict[str, Any]
DEAD_JOBS = ("failed", "canceled")
# A reservation this young names a job its request may still be making (CR's checks take up to 8 s).
IN_FLIGHT = timedelta(minutes=2)
MOMENT = ("sourceStart", "sourceEnd", "layout", "momentType", "hook", "pickedFor")


def enabled(env: Mapping[str, str] | None = None) -> bool:
    """``CR_REMAKE=on`` (an unset value is off)."""
    source = os.environ if env is None else env
    return str(source.get("CR_REMAKE", "")).strip().lower() == "on"


def alive(store: db.Store, user_id: str, entry: Mapping[str, Any], now: datetime) -> bool:
    """The copy a ``remakes`` entry names still counts: its job is there and neither failed, canceled nor being
    deleted, and its clip (when made) wasn't thrown away. A job not written yet is alive while the entry is young."""
    job_id = str(entry.get("jobId") or "")
    if not job_id:
        return False
    job = store.get(db.user_pk(user_id), db.job_sk(job_id))
    if job is None:
        at = parse(entry.get("at"))
        return at is not None and now - at < IN_FLIGHT
    if job.get("status") in DEAD_JOBS or job.get("deletingAt"):
        return False
    made = clips.clips_for_job(store, user_id, job_id)
    return not made or any(c.get("status") != "declined" for c in made)


def source_key(media: s3.Media | None, user_id: str, job: Mapping[str, Any]) -> str | None:
    """The original's kept video, found by a HEAD: ``jobs/{jobId}/source/video.mp4``, else the Mac's upload
    ``uploads/{u}/mac-{jobId}/video.mp4``. None when both are gone (a link job then fetches the link again)."""
    if media is None:
        return None
    job_id = str(job.get("jobId") or "")
    for key in (f"jobs/{job_id}/source/video.mp4", f"uploads/{user_id}/mac-{job_id}/video.mp4"):
        try:
            if media.head(key) is not None:
                return key
        except Exception as e:  # a failed HEAD is a gone file: the link (or the 409) decides
            log("warning", "cr.remake_head_failed", error=type(e).__name__)
    return None


def _key(user_id: str, clip_id: str) -> tuple[str, str]:
    return db.user_pk(user_id), db.clip_sk(clip_id)


def reserve(
    store: db.Store, user_id: str, clip_id: str, campaign_id: str, *, job_id: str, now: datetime, still: Any
) -> str | None:
    """Names ``job_id`` as this clip's copy for the campaign. None when it did; else the job already named (a double
    tap). ``still(entry)`` says whether a stored entry still counts. ``LookupError`` when the clip is gone."""
    pk, sk = _key(user_id, clip_id)
    entry = {"jobId": job_id, "at": iso(now)}
    names = {"#r": "remakes", "#c": campaign_id}
    try:  # the map, made first when the clip has none (a path inside a missing map can't be set)
        store.update_expr(
            pk,
            sk,
            "SET #r = :m",
            condition="attribute_exists(pk) AND attribute_not_exists(#r)",
            names={"#r": "remakes"},
            values={":m": {campaign_id: entry}},
        )
        return None
    except db.ConditionFailed:
        pass
    try:
        store.update_expr(
            pk,
            sk,
            "SET #r.#c = :e",
            condition="attribute_exists(pk) AND attribute_not_exists(#r.#c)",
            names=names,
            values={":e": entry},
        )
        return None
    except db.ConditionFailed:
        pass
    for _ in range(2):
        clip = store.get(pk, sk)
        if clip is None:
            raise LookupError(clip_id)
        old = obj(obj(clip.get("remakes")).get(campaign_id))
        if old and still(old):
            return str(old.get("jobId") or "")
        try:  # the stored copy no longer counts: this one takes its place, unless it changed meanwhile
            store.update_expr(
                pk,
                sk,
                "SET #r.#c = :e",
                condition="#r.#c.#j = :old",
                names={**names, "#j": "jobId"},
                values={":e": entry, ":old": str(old.get("jobId") or "")},
            )
            return None
        except db.ConditionFailed:
            continue
    clip = store.get(pk, sk) or {}
    return str(obj(obj(clip.get("remakes")).get(campaign_id)).get("jobId") or "") or None


def free(store: db.Store, user_id: str, clip_id: str, campaign_id: str, job_id: str) -> None:
    """Making the job failed: the reservation goes (only while it still names that job)."""
    pk, sk = _key(user_id, clip_id)
    try:
        store.update_expr(
            pk,
            sk,
            "REMOVE #r.#c",
            condition="#r.#c.#j = :j",
            names={"#r": "remakes", "#c": campaign_id, "#j": "jobId"},
            values={":j": job_id},
        )
    except db.ConditionFailed:
        return


def fields(clip: Mapping[str, Any], job: Mapping[str, Any], key: str | None) -> Item:
    """The copy job's own fields: the public ``remakeOf``, the internal ``remake`` (the one moment) and the
    original's ``sourceLanguage``."""
    ref = {"clipId": str(clip["clipId"]), "jobId": str(job["jobId"])}
    moment: Item = {**ref, **{k: clip[k] for k in MOMENT if clip.get(k) is not None}}
    if key:
        moment["sourceKey"] = key
    out: Item = {"remakeOf": ref, "remake": moment}
    if isinstance(job.get("sourceLanguage"), str) and job["sourceLanguage"]:
        out["sourceLanguage"] = job["sourceLanguage"]
    return out
