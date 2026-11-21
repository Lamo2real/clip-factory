"""Production jobs (``PJOB#``): creation, the stale-heartbeat fence, a failed start and cancel (CONTRACTS §45.9.1).

The API writes the job item (every step, ``configuration.run``, ``sessionId``, ``heartbeatAt = createdAt``,
``status = queued``); the agent then writes each step, ``progress``, ``heartbeatAt``, ``status``, ``error`` and
``meta``, every write conditional on the job's ``sessionId``. ``settle`` is called by every read that returns or checks
a job: a job ``queued`` with a heartbeat older than 3 minutes, or ``running`` older than 6, is failed in one
transaction (a new ``sessionId`` fences the old run out), then the old session is stopped (best effort). A refused
condition means someone wrote meanwhile: the stored item is read again and returned.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from . import shapes
from . import types as ws
from .agent import new_session_id
from .expr import Update

QUEUED_LIMIT = timedelta(minutes=3)
RUNNING_LIMIT = timedelta(minutes=6)
STOPPED = "Making the video stopped. Tap Try again."
NOT_STARTED = "Making the video did not start. Tap Try again."
NOT_SET_UP = "The video maker is not switched on yet, so making the video did not start."
PORTRAIT_STOPPED = "Making the picture stopped. Tap Try again."
PORTRAIT_NOT_STARTED = "Making the picture did not start. Tap Try again."
PORTRAIT_NOT_SET_UP = "The picture maker is not switched on yet, so making the picture did not start."
CANCELED_STEP = "You stopped it."

Item = dict[str, Any]
Stop = Callable[[str], None]


def job_sk(job_id: str) -> str:
    return f"{ws.PJOB_SK}{job_id}"


def story_sk(story_id: str) -> str:
    return f"{ws.STORY_SK}{story_id}"


def story_steps(run: Iterable[str], done: Iterable[str]) -> list[Item]:
    """All eight steps: the ``run`` ones pending, the others done (made before) or skipped (never made)."""
    run_set, done_set = set(run), set(done)
    steps = []
    for key in shapes.STEP_ORDER:
        status = "pending" if key in run_set else ("done" if key in done_set else "skipped")
        steps.append({"key": key, "label": shapes.STEP_LABEL[key], "status": status})
    return steps


def new_job(
    user_id: str,
    workspace_id: str,
    *,
    job_id: str,
    content_type: str,
    content_id: str,
    job_type: str,
    run: list[str],
    steps: list[Item],
    now: datetime,
    from_step: str | None = None,
    scene_ids: list[str] | None = None,
    note: str | None = None,
    meta: Mapping[str, Any] | None = None,
) -> Item:
    at = iso(now)
    configuration: Item = {"run": list(run)}
    if from_step:
        configuration["from"] = from_step
    if scene_ids:
        configuration["sceneIds"] = list(scene_ids)
    if note:
        configuration["note"] = note
    item: Item = {
        "pk": ws.workspace_pk(user_id, workspace_id),
        "sk": job_sk(job_id),
        "type": ws.TYPE_PJOB,
        "userId": user_id,
        "workspaceId": workspace_id,
        "jobId": job_id,
        "contentType": content_type,
        "contentId": content_id,
        "jobType": job_type,
        "status": "queued",
        "steps": steps,
        "progress": shapes.progress(steps),
        "configuration": configuration,
        "meta": {k: v for k, v in (meta or {}).items() if v is not None},
        "sessionId": new_session_id(job_id),
        "heartbeatAt": at,
        "createdAt": at,
        "updatedAt": at,
    }
    return item


def is_stale(job: Mapping[str, Any], now: datetime) -> bool:
    status = job.get("status")
    if status not in shapes.JOB_ACTIVE:
        return False
    beat = parse(job.get("heartbeatAt")) or parse(job.get("createdAt"))
    if beat is None:
        return True
    limit = QUEUED_LIMIT if status == "queued" else RUNNING_LIMIT
    return now - beat > limit


def _failed_steps(steps: Iterable[Mapping[str, Any]], message: str) -> list[Item]:
    out = []
    for step in steps:
        s = dict(step)
        if s.get("status") == "running":
            s["status"] = "failed"
            s["message"] = message
        out.append(s)
    return out


def unfinished(job: Mapping[str, Any]) -> list[str]:
    """The run's steps that did not finish (the failed step and every later one)."""
    config = job.get("configuration") if isinstance(job.get("configuration"), Mapping) else {}
    run = set((config or {}).get("run") or [])
    done = {s.get("key") for s in job.get("steps") or [] if s.get("status") in shapes.STEP_DONE}
    return [k for k in shapes.STEP_ORDER if k in run and k not in done]


def _story_fail(story: Mapping[str, Any], job: Mapping[str, Any], at: str) -> Update:
    stale = shapes.ordered_steps([*(story.get("stale") or []), *unfinished(job)])
    update = Update(str(story["pk"]), str(story["sk"]), sets={"status": "failed", "stale": stale, "updatedAt": at})
    update.removes.append("currentJobId")
    if "animation" in unfinished(job):
        scene_ids = (job.get("configuration") or {}).get("sceneIds")
        if scene_ids:
            update.sets["staleScenes"] = list(scene_ids)  # only these scenes still need animating
        else:
            update.removes.append("staleScenes")  # the whole animation is out of date again
    return update.bump().equals("currentJobId", job["jobId"]).equals("version", story.get("version"))


def _reread(store: db.Store, job: Mapping[str, Any]) -> Item:
    return store.get(str(job["pk"]), str(job["sk"])) or dict(job)


def _stop(stop: Stop | None, session_id: Any) -> None:
    if stop is None or not isinstance(session_id, str) or not session_id:
        return
    try:
        stop(session_id)
    except Exception as e:  # best effort: the new sessionId already fences the old run out
        log("warning", "stories.stop_failed", error=type(e).__name__)


def _fail(
    store: db.Store,
    job: Mapping[str, Any],
    now: datetime,
    message: str,
    *,
    story: Mapping[str, Any] | None,
    expect_status: Iterable[str],
) -> bool:
    """Fails the job (and its story when the story still points at it) in one transaction. False when refused."""
    at = iso(now)
    pjob = Update(
        str(job["pk"]),
        str(job["sk"]),
        sets={
            "status": "failed",
            "steps": _failed_steps(job.get("steps") or [], message),
            "error": message,
            "sessionId": new_session_id(str(job["jobId"])),
            "updatedAt": at,
        },
    )
    pjob.one_of("status", list(expect_status)).equals("sessionId", job.get("sessionId"))
    if job.get("heartbeatAt") is not None:
        pjob.equals("heartbeatAt", job["heartbeatAt"])
    updates = [pjob.request()]
    if story is not None and story.get("currentJobId") == job.get("jobId"):
        updates.append(_story_fail(story, job, at).request())
    try:
        store.transact(updates=updates)
    except db.ConditionFailed:
        return False
    return True


def settle(
    store: db.Store,
    job: Mapping[str, Any] | None,
    now: datetime,
    *,
    stop: Stop | None = None,
    story: Mapping[str, Any] | None = None,
) -> Item | None:
    """The job as it really is: a stale ``queued``/``running`` job becomes ``failed`` (with its story)."""
    if job is None:
        return None
    if not is_stale(job, now):
        return dict(job)
    if story is None and job.get("contentType") == "animation":
        story = store.get(str(job["pk"]), story_sk(str(job.get("contentId"))))
    message = STOPPED if job.get("contentType") == "animation" else PORTRAIT_STOPPED
    if _fail(store, job, now, message, story=story, expect_status=[str(job.get("status"))]):
        log("info", "stories.job_fenced", jobId=job.get("jobId"), was=job.get("status"))
        _stop(stop, job.get("sessionId"))
    return _reread(store, job)


def fail_start(
    store: db.Store, job: Mapping[str, Any], story: Mapping[str, Any] | None, now: datetime, message: str
) -> Item:
    """The agent did not take the job: ``failed`` with a plain sentence, conditional on ``status = queued``."""
    _fail(store, job, now, message, story=story, expect_status=["queued"])
    return _reread(store, job)


def cancel(
    store: db.Store,
    job: Mapping[str, Any],
    story: Mapping[str, Any] | None,
    now: datetime,
) -> bool:
    """Marks a queued or running job ``canceled`` (a new ``sessionId`` fences its writes out) and puts the story back
    to its status before the job, ``stale`` as it was. False when the job changed meanwhile."""
    at = iso(now)
    steps = []
    for step in job.get("steps") or []:
        s = dict(step)
        if s.get("status") == "running":
            s["status"] = "failed"
            s["message"] = CANCELED_STEP
        steps.append(s)
    pjob = Update(
        str(job["pk"]),
        str(job["sk"]),
        sets={"status": "canceled", "steps": steps, "sessionId": new_session_id(str(job["jobId"])), "updatedAt": at},
    )
    pjob.one_of("status", sorted(shapes.JOB_ACTIVE)).equals("sessionId", job.get("sessionId"))
    updates = [pjob.request()]
    if story is not None and story.get("currentJobId") == job.get("jobId"):
        back = story.get("statusBefore") or "draft"
        su = Update(str(story["pk"]), str(story["sk"]), sets={"status": back, "updatedAt": at})
        su.removes.append("currentJobId")
        updates.append(su.bump().equals("currentJobId", job["jobId"]).request())
    try:
        store.transact(updates=updates)
    except db.ConditionFailed:
        return False
    return True


def active(job: Mapping[str, Any] | None) -> bool:
    return bool(job) and (job or {}).get("status") in shapes.JOB_ACTIVE
