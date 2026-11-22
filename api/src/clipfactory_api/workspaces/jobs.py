"""Production jobs (``PJOB#``), AI tasks (``TASK#``) and chat answers (``MSG#``): creation, the stale-heartbeat fence,
a failed start and cancel (CONTRACTS §45.9.1).

The API writes the job item (every step, ``configuration.run``, ``sessionId``, ``heartbeatAt = createdAt``,
``status = queued``); the agent then writes each step, ``progress``, ``heartbeatAt``, ``status``, ``error`` and
``meta``, every write conditional on the job's ``sessionId``. ``settle`` is called by every read that returns or checks
a job: a job ``queued`` with a heartbeat older than 3 minutes, or ``running`` older than 6, is failed in one
transaction (a new ``sessionId`` fences the old run out; a story's job writes the story's ``failed`` activity with it,
like the agent's own failures, §45.35 D11), then the old session is stopped (best effort). A refused condition means
someone wrote meanwhile: the stored item is read again and returned.

Tasks and chat answers are fenced the same way on their own item (``settle_task``, ``settle_message``): a task
``queued`` for more than 3 minutes or ``running`` for more than 6 without a heartbeat, and an answer ``pending`` or
``streaming`` for more than 3, is failed with a new ``sessionId`` (so the agent's next write is refused), then its
session is stopped (best effort).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db
from ..clock import iso, parse
from ..log import log
from . import activity, shapes
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
REFERENCE_STOPPED = "Looking at the video stopped. Tap Try again."
# "Try it" on Amazon Nova Reel (§45.35 D2): a ``provider_check`` job of content type ``provider``
CHECK_STOPPED = "Trying Amazon Nova Reel stopped. Tap Try it again."
CHECK_NOT_STARTED = "Trying Amazon Nova Reel did not start. Tap Try it again."
CHECK_NOT_SET_UP = "Lamo Stories' helper is not switched on yet, so Amazon Nova Reel could not be tried."
CHECK_KIND: Final = "provider"  # the content type of a "Try it" job (providers.CHECK_CONTENT_TYPE)
CANCELED_STEP = "You stopped it."
STOPPED_BY_KIND: Final = {
    "animation": STOPPED,
    "character": PORTRAIT_STOPPED,
    "reference": REFERENCE_STOPPED,
    CHECK_KIND: CHECK_STOPPED,
}

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
    story_version: int | None = None,
    override: Mapping[str, Any] | None = None,
    reference_ids: list[str] | None = None,
    video_format: Mapping[str, Any] | None = None,
) -> Item:
    """``story_version``: the story's ``version`` once this job is launched. The agent's every story write adds 1, so
    a cancel can tell whether the run already changed the story (``cancel``). ``override``: the owner's model and
    effort for this job only (``configuration.override``, §45.25 level 1, never saved as a setting);
    ``reference_ids``: the reference videos whose analyses the writer reads (§45.28); ``video_format``: the story's
    ``{aspect, width, height}`` for the agent (``configuration.format``, §45.34; internal)."""
    at = iso(now)
    configuration: Item = {"run": list(run)}
    if from_step:
        configuration["from"] = from_step
    if scene_ids:
        configuration["sceneIds"] = list(scene_ids)
    if note:
        configuration["note"] = note
    if override:
        configuration["override"] = dict(override)
    if reference_ids:
        configuration["referenceIds"] = list(reference_ids)
    if video_format:
        configuration["format"] = dict(video_format)
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
    if story_version is not None:
        item["storyVersion"] = int(story_version)
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


def _failed_steps(steps: Iterable[Mapping[str, Any]], message: str, *, pending_too: bool = False) -> list[Item]:
    """The running step fails with the sentence. ``pending_too``: a "Try it" job's one step fails with it even before
    it ran (a failed start, or a try that never began), since the Nova Reel row shows the step's sentence (§45.35
    D2); a story's later steps stay pending, as before."""
    out = []
    for step in steps:
        s = dict(step)
        if s.get("status") == "running" or (pending_too and s.get("status") == "pending"):
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


def valid_stale_scenes(story: Mapping[str, Any]) -> list[str]:
    """The scenes whose animation is out of date. ``staleScenes`` counts only while ``animation`` is stale (the agent
    takes ``animation`` out of ``stale`` when it has animated them); empty means none known, or every scene."""
    if "animation" not in (story.get("stale") or []):
        return []
    scenes = story.get("staleScenes")
    return [str(s) for s in scenes] if isinstance(scenes, list) else []


def _unfinished_into(update: Update, story: Mapping[str, Any], job: Mapping[str, Any]) -> None:
    """The run's unfinished steps go back into ``stale`` (a later step never ran on what an earlier one made), and
    the scenes still to animate into ``staleScenes`` (removed: every scene)."""
    left = unfinished(job)
    update.sets["stale"] = shapes.ordered_steps([*(story.get("stale") or []), *left])
    if "animation" not in left:
        return
    config = job.get("configuration") if isinstance(job.get("configuration"), Mapping) else {}
    from_step = (config or {}).get("from")
    ids = [str(s) for s in (config or {}).get("sceneIds") or []]
    known = valid_stale_scenes(story)  # still valid: the animation step did not finish
    named = job.get("jobType") != "changes" and from_step in ("scenes", "animation") and bool(ids)
    if named and not ("animation" in (story.get("stale") or []) and not known):
        update.sets["staleScenes"] = sorted({*ids, *known})  # only these scenes still need animating
    elif job.get("jobType") != "changes" and from_step is None and known:
        update.sets["staleScenes"] = known  # a run by content: the same scenes are still out of date
    else:
        update.removes.append("staleScenes")  # the whole animation is out of date


def _story_fail(story: Mapping[str, Any], job: Mapping[str, Any], at: str) -> Update:
    update = Update(str(story["pk"]), str(story["sk"]), sets={"status": "failed", "updatedAt": at})
    _unfinished_into(update, story, job)
    update.removes.append("currentJobId")
    return update.bump().equals("currentJobId", job["jobId"]).equals("version", story.get("version"))


def _reread(store: db.Store, job: Mapping[str, Any]) -> Item:
    return store.get(str(job["pk"]), str(job["sk"])) or dict(job)


def stop_quietly(stop: Stop | None, session_id: Any) -> None:
    """Ends a runtime session, best effort: the job's new ``sessionId`` already fences the old run out."""
    if stop is None or not isinstance(session_id, str) or not session_id:
        return
    try:
        stop(session_id)
    except Exception as e:
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
    """Fails the job (and its story when the story still points at it) in one transaction, with the story's
    ``failed`` activity (``ACT#``, as the agent writes for its own failures, §45.35 D11). False when refused."""
    at = iso(now)
    pjob = Update(
        str(job["pk"]),
        str(job["sk"]),
        sets={
            "status": "failed",
            "steps": _failed_steps(job.get("steps") or [], message, pending_too=job.get("contentType") == CHECK_KIND),
            "error": message,
            "sessionId": new_session_id(str(job["jobId"])),
            "updatedAt": at,
        },
    )
    pjob.one_of("status", list(expect_status)).equals("sessionId", job.get("sessionId"))
    if job.get("heartbeatAt") is not None:
        pjob.equals("heartbeatAt", job["heartbeatAt"])
    updates = [pjob.request()]
    puts: list[Item] = []
    if story is not None and story.get("currentJobId") == job.get("jobId"):
        updates.append(_story_fail(story, job, at).request())
        puts.append(activity.item(str(job["userId"]), str(job["workspaceId"]), "failed", story, now=now))
    try:
        store.transact(updates=updates, puts=puts)
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
    message = STOPPED_BY_KIND.get(str(job.get("contentType")), STOPPED)
    if _fail(store, job, now, message, story=story, expect_status=[str(job.get("status"))]):
        log("info", "stories.job_fenced", jobId=job.get("jobId"), was=job.get("status"))
        stop_quietly(stop, job.get("sessionId"))
    return _reread(store, job)


def fail_start(
    store: db.Store, job: Mapping[str, Any], story: Mapping[str, Any] | None, now: datetime, message: str
) -> Item:
    """The agent did not take the job: ``failed`` with a plain sentence, conditional on ``status = queued``."""
    _fail(store, job, now, message, story=story, expect_status=["queued"])
    return _reread(store, job)


def run_changed_story(story: Mapping[str, Any], job: Mapping[str, Any]) -> bool:
    """Whether the run already wrote a step's result to the story (each agent write adds 1 to ``version``)."""
    start = job.get("storyVersion")
    if isinstance(start, int) and not isinstance(start, bool):
        return int(story.get("version") or 0) != start
    config = job.get("configuration") if isinstance(job.get("configuration"), Mapping) else {}
    run = set((config or {}).get("run") or [])
    finished = any(s.get("key") in run and s.get("status") in shapes.STEP_DONE for s in job.get("steps") or [])
    return job.get("status") != "queued" or finished  # not recorded: assume it did, unless it never started


def cancel(
    store: db.Store,
    job: Mapping[str, Any],
    story: Mapping[str, Any] | None,
    now: datetime,
) -> bool:
    """Marks a queued or running job ``canceled`` (a new ``sessionId`` fences its writes out) and puts the story back
    to its status before the job. ``stale`` stays as it was when the run changed nothing; once it wrote a step's result
    (a new storyboard, say), its unfinished steps join ``stale`` as on a failure, so "Try again" makes the rest and an
    older video is never approved with a newer script. False when the job or the story changed meanwhile."""
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
        if run_changed_story(story, job):
            _unfinished_into(su, story, job)
        su.removes.append("currentJobId")
        su.bump().equals("currentJobId", job["jobId"]).equals("version", story.get("version"))
        updates.append(su.request())
    try:
        store.transact(updates=updates)
    except db.ConditionFailed:
        return False
    return True


def active(job: Mapping[str, Any] | None) -> bool:
    return bool(job) and (job or {}).get("status") in shapes.JOB_ACTIVE


# --- AI tasks (TASK#) and chat answers (MSG#) -------------------------------------------------------------------

TASK_ACTIVE: Final = frozenset({"queued", "running"})
MESSAGE_ACTIVE: Final = frozenset({"pending", "streaming"})
MESSAGE_LIMIT = timedelta(minutes=3)
TASK_STOPPED = "The helper stopped. Tap Try again."
TASK_NOT_STARTED = "The helper did not start. Tap Try again."
TASK_NOT_SET_UP = "The AI helper is not switched on yet, so it could not start."
MESSAGE_STOPPED = "The answer stopped. Tap Try again."


def _beat(item: Mapping[str, Any]) -> datetime | None:
    return parse(item.get("heartbeatAt")) or parse(item.get("createdAt"))


def task_is_stale(task: Mapping[str, Any], now: datetime) -> bool:
    status = task.get("status")
    if status not in TASK_ACTIVE:
        return False
    beat = _beat(task)
    limit = QUEUED_LIMIT if status == "queued" else RUNNING_LIMIT
    return beat is None or now - beat > limit


def message_is_stale(message: Mapping[str, Any], now: datetime) -> bool:
    if message.get("status") not in MESSAGE_ACTIVE:
        return False
    beat = _beat(message)
    return beat is None or now - beat > MESSAGE_LIMIT


def _fence(
    store: db.Store, item: Mapping[str, Any], now: datetime, message: str, *, expect: Iterable[str], item_id: str
) -> bool:
    """``failed`` with the sentence and a new ``sessionId``, conditional on what was read. False when refused."""
    update = Update(
        str(item["pk"]),
        str(item["sk"]),
        sets={"status": "failed", "error": message, "sessionId": new_session_id(item_id), "updatedAt": iso(now)},
    )
    update.one_of("status", list(expect)).equals("sessionId", item.get("sessionId"))
    if item.get("heartbeatAt") is not None:
        update.equals("heartbeatAt", item["heartbeatAt"])
    try:
        update.run(store)
    except db.ConditionFailed:
        return False
    return True


def settle_task(
    store: db.Store, task: Mapping[str, Any] | None, now: datetime, *, stop: Stop | None = None
) -> Item | None:
    """The task as it really is: a stale ``queued``/``running`` task becomes ``failed`` ("The helper stopped.")."""
    if task is None:
        return None
    if not task_is_stale(task, now):
        return dict(task)
    status = str(task.get("status"))
    if _fence(store, task, now, TASK_STOPPED, expect=[status], item_id=str(task.get("taskId"))):
        log("info", "stories.task_fenced", taskId=task.get("taskId"), was=status)
        stop_quietly(stop, task.get("sessionId"))
    return _reread(store, task)


def fail_task_start(store: db.Store, task: Mapping[str, Any], now: datetime, message: str) -> Item:
    """The agent did not take the task: ``failed`` with a plain sentence, conditional on ``status = queued``."""
    _fence(store, task, now, message, expect=["queued"], item_id=str(task.get("taskId")))
    return _reread(store, task)


def settle_message(
    store: db.Store, message: Mapping[str, Any] | None, now: datetime, *, stop: Stop | None = None
) -> Item | None:
    """The chat answer as it really is: ``pending`` or ``streaming`` with no heartbeat for 3 minutes becomes
    ``failed`` ("The answer stopped. Tap Try again."). Builder A2's chat routes call it on every read."""
    if message is None:
        return None
    if not message_is_stale(message, now):
        return dict(message)
    status = str(message.get("status"))
    if _fence(store, message, now, MESSAGE_STOPPED, expect=[status], item_id=str(message.get("msgId"))):
        log("info", "stories.message_fenced", msgId=message.get("msgId"), was=status)
        stop_quietly(stop, message.get("sessionId"))
    return _reread(store, message)
