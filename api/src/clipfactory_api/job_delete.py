"""Deleting a job (docs/CONTRACTS.md §34, ADR-58).

A delete is final on the server: the web holds it back for the 8-second Undo first (§34.5), as it does for Stop job
and Throw away. One job is deleted in this order, so a delete that breaks halfway is finished by the next one:

1. **Fence.** The job gets a fresh ``sessionId`` (a working one also becomes ``canceled``). The agent and the job flow
   condition every write on their own ``sessionId``, so from here on the old run cannot write to the job or add a
   clip (§13, §14.4, §30.6).
2. **Stop the run.** A job that was working has its runtime session stopped outright (as Try again does): no wind-down
   that would write again.
3. **Clips.** Thrown-away clips always go (they are listed nowhere but the job page). Clips waiting in Review go only
   when the owner ticked "Also delete its N clips in Review", and only while they still wait (one kept on another
   device a moment ago is kept). Kept, posting, posted and post-failed clips are never deleted: their posts, numbers
   and Library entries stay, and their files stay.
4. **Files.** Everything under ``jobs/{jobId}/`` goes except the folders of the clips it keeps; an uploaded video
   goes too unless another job uses it.
5. **Items.** The live status line, the notification step and, last, the job itself.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from . import clips, db, jobs, s3
from .agent_client import new_session_id
from .app import App
from .clock import iso
from .log import log

Item = dict[str, Any]

CLIP_CHOICES = ("keep", "delete")
REVIEW = "review"
ALWAYS_GONE = frozenset({"declined"})  # thrown away: no file, no post, shown only on the job page
MAX_BATCH = 25
BATCH_WORKERS = 5


@dataclass(frozen=True)
class Outcome:
    job_id: str
    deleted: bool  # False: there was no such job of this owner (already deleted, or never theirs)
    clips_deleted: int = 0
    clips_kept: int = 0
    files_deleted: int = 0

    def public(self) -> Item:
        return {
            "jobId": self.job_id,
            "deleted": self.deleted,
            "clipsDeleted": self.clips_deleted,
            "clipsKept": self.clips_kept,
        }


def _gone(clip: Item, review_clips: bool) -> bool:
    status = clip.get("status")
    return status in ALWAYS_GONE or (review_clips and status == REVIEW)


def _stop_run(app: App, job_id: str, session_id: str) -> None:
    try:
        app.agent.stop_session(session_id)
    except Exception as e:  # best effort: the new sessionId is what keeps the old run out
        log("warning", "job.delete_stop_failed", jobId=job_id, error=type(e).__name__)


def _delete_vector(app: App, user_id: str, clip_id: str) -> None:
    if app.vectors is None:
        return
    try:
        app.vectors.delete_clip(user_id, clip_id)
    except Exception as e:  # never shown: similar clips only lists measured clips that still exist
        log("warning", "job.delete_vector_failed", clipId=clip_id, error=type(e).__name__)


def _upload_in_use(app: App, user_id: str, job_id: str, key: str) -> bool:
    for other in app.store.query_all(db.user_pk(user_id), "JOB#"):
        source = other.get("source") or {}
        if other.get("jobId") != job_id and isinstance(source, dict) and source.get("key") == key:
            return True
    return False


def _delete_files(app: App, user_id: str, job: Item, kept: list[Item]) -> int:
    job_id = str(job["jobId"])
    keep: list[str] = []
    for clip in kept:
        keep.append(s3.clip_prefix(job_id, str(clip["clipId"])))
        keep += [str(clip[k]) for k in ("videoKey", "coverKey") if clip.get(k)]
    count = app.media.delete_prefix_except(f"jobs/{job_id}/", tuple(keep))
    source = job.get("source") or {}
    key = source.get("key") if isinstance(source, dict) and source.get("type") == "upload" else None
    if (
        isinstance(key, str)
        and key.startswith(s3.upload_prefix(user_id))
        and s3.is_safe_key(key)
        and not _upload_in_use(app, user_id, job_id, key)
    ):
        app.media.delete(key)
        count += 1
    return count


def delete_job(app: App, user_id: str, job_id: str, *, review_clips: bool) -> Outcome:
    """Deletes one of this owner's jobs (the order is in the module docstring). Idempotent: a job that is not there
    (deleted already, or another owner's: the key is the caller's own) is ``deleted=False`` and nothing changes."""
    pk, sk = db.user_pk(user_id), db.job_sk(job_id)
    job = app.store.get(pk, sk)
    if job is None:
        return Outcome(job_id, False)
    now = iso(app.clock())
    old_session = job.get("sessionId")
    working = job.get("status") in jobs.ACTIVE
    fence: Item = {"sessionId": new_session_id(job_id), "deletingAt": now, "updatedAt": now}
    if working:
        fence["status"] = "canceled"
    try:
        app.store.update(pk, sk, fence)
    except db.ConditionFailed:
        return Outcome(job_id, False)  # deleted by another request a moment ago

    with ThreadPoolExecutor(max_workers=1) as pool:
        stopping = pool.submit(_stop_run, app, job_id, old_session) if working and old_session else None
        items = clips.clips_for_job(app.store, user_id, job_id)
        deleted = 0
        kept: list[Item] = []
        for clip in items:
            if _gone(clip, review_clips):
                statuses = [REVIEW] if clip.get("status") == REVIEW else sorted(ALWAYS_GONE)
                if app.store.delete_if(clip["pk"], clip["sk"], {"status": statuses}):
                    deleted += 1
                    if clip.get("status") == REVIEW:
                        _delete_vector(app, user_id, str(clip["clipId"]))
                    continue
                fresh = app.store.get(clip["pk"], clip["sk"])  # it changed meanwhile: keep it as it is now
                if fresh is not None:
                    kept.append(fresh)
                continue
            kept.append(clip)
        if stopping is not None:
            stopping.result()  # the run is stopped before its files go, so it cannot write new ones after
    files = _delete_files(app, user_id, job, kept)
    app.store.delete(pk, jobs.live_sk(job_id))
    app.store.delete(pk, f"NOTIFYSTEP#{job_id}")
    app.store.delete(pk, sk)
    log(
        "info",
        "job.deleted",
        jobId=job_id,
        working=working,
        clipsDeleted=deleted,
        clipsKept=len(kept),
        files=files,
    )
    return Outcome(job_id, True, deleted, len(kept), files)


def delete_jobs(app: App, user_id: str, job_ids: list[str], *, review_clips: bool) -> list[Outcome]:
    """Several jobs side by side (at most ``MAX_BATCH``), so a batch stays well inside the API's 29 seconds."""
    with ThreadPoolExecutor(max_workers=BATCH_WORKERS) as pool:
        return list(pool.map(lambda j: delete_job(app, user_id, j, review_clips=review_clips), job_ids))
