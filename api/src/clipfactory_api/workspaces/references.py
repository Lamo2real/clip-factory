"""Reference videos for the video analysis agent to study: an upload or a link (docs/CONTRACTS.md §45.3 ``REFVID#``,
§45.4 ``references/``, §45.5, §45.6 ``ReferenceVideo``, ``ReferenceAnalysis``, §45.28, §45.33, §45.40, ADR-78, ADR-88).

An MP4 or MOV (≤ 2 GB) goes straight to ``ws/{userId}/{workspaceId}/references/{refId}/source.{mp4|mov}`` in a
presigned multipart upload (100 MB parts). A pasted link (§45.40: one video on YouTube, TikTok, Instagram, Facebook,
X, Google Drive or Dropbox, checked by ``reflinks``) makes a ``fetching`` reference and a ``reference_fetch`` job (one
step, "Get the video") on Clips Funded's own runtime (``fetch_reference``), which writes the reference's own
``source.mp4`` and sets it ``ready``, or ``fetch_failed`` with its own sentence ("Try again" asks again; the owner can
always upload the file instead). **Analyze** starts a ``reference_analysis`` production job (``PJOB#``, its own step
track: Look at it, Listen, Write it up) on the same runtime (``process_reference``), which writes ``analysis.json``
next to the video. The reference keeps its own model and effort (``ai``, §45.25 level 2) and an Analyze may carry a
one-off override (``configuration.override`` on the job, never saved).
"""

from __future__ import annotations

import contextlib
import json
import math
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db, validate
from ..clock import iso, parse
from ..errors import bad_request, conflict, not_found, too_large
from ..ids import is_ulid, ulid
from ..log import log
from . import agents as agents_mod
from . import ai_config as cfg
from . import ai_resolve as res
from . import reflinks, retention, shapes
from . import types as ws

MAX_BYTES: Final = 2 * 1024 * 1024 * 1024
PART_SIZE: Final = 100 * 1024 * 1024
PART_URL_SECONDS: Final = 6 * 3600
GET_SECONDS: Final = 3600
ANALYSIS_MAX: Final = 2 * 1024 * 1024
MAX_REFERENCES: Final = 100
TITLE_MAX: Final = 80
TYPES: Final = {"video/mp4": "mp4", "video/quicktime": "mov"}
STATUSES: Final = ("uploading", "fetching", "fetch_failed", "ready", "analyzing", "analyzed", "failed")
FILE_STATUSES: Final = ("ready", "analyzing", "analyzed", "failed")  # the file is here: only these carry ``url``
CAN_ANALYZE: Final = ("ready", "analyzed", "failed")
AGENT: Final = "video_analysis"
TASK: Final = "reference_analysis"
# The job's own step track (§45.28): keys for the agent, labels for the owner.
STEPS: Final = (("look", "Look at it"), ("listen", "Listen"), ("write", "Write it up"))
QUEUED_STALE: Final = timedelta(minutes=3)
RUNNING_STALE: Final = timedelta(minutes=6)
# Getting a video from its link (§45.40): its own job type and step.
FETCH: Final = "reference_fetch"
FETCH_STEPS: Final = (("get", "Get the video"),)
JOB_TYPES: Final = (TASK, FETCH)
MAX_FETCHING: Final = 3

NOT_FOUND: Final = "We could not find that reference video."
WRONG_TYPE: Final = "Pick an MP4 or MOV video file."
TOO_BIG: Final = "Reference videos can be at most 2 GB. Pick a shorter one."
NOT_FINISHED: Final = "The upload did not finish. Upload the video again."
BUSY: Final = "This video is being studied already. Wait until it is done."
NOT_READY: Final = "Wait until the video has finished uploading."
DID_NOT_START: Final = "Studying the video did not start. Tap Try again."
STOPPED: Final = "Studying the video stopped. Tap Try again."
FILE_REMOVED: Final = "The video was removed to save space. Its study stays."
FULL: Final = f"You have {MAX_REFERENCES} reference videos already. Delete one first."
ALREADY: Final = "That video is in your list already."
DID_NOT_ARRIVE: Final = "That one didn't arrive. Tap it in your list, then Try again."
THREE: Final = "Three videos are on their way already. Wait for one to arrive."
FETCHING_NOW: Final = "It is getting the video now."
HERE_ALREADY: Final = "This video is here already."
NOT_HERE: Final = "Wait until the video is here."
GET_FIRST: Final = "Get the video first. Tap Try again."
FETCH_DID_NOT_START: Final = "Getting the video did not start. Tap Try again."
FETCH_STOPPED: Final = "Getting the video stopped. Tap Try again."


def removed_sentence(item: Mapping[str, Any]) -> str:
    """What a cleared reference says: its study stays only when it had one (§45.35 D9)."""
    return FILE_REMOVED if retention.study_kept(item) else retention.REMOVED_NO_STUDY


def ref_sk(ref_id: str) -> str:
    return f"{ws.REFVID_SK}{ref_id}"


def ref_prefix(user_id: str, workspace_id: str, ref_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}references/{ref_id}/"


def _ai(item: Mapping[str, Any]) -> dict[str, Any]:
    ai = item.get("ai") if isinstance(item.get("ai"), Mapping) else {}
    return {"model": (ai or {}).get("model") or None, "effort": (ai or {}).get("effort") or None}


def public(app: Any, item: Mapping[str, Any]) -> dict[str, Any]:
    """``ReferenceVideo`` (§45.6); the S3 keys and the upload id stay inside."""
    status = str(item.get("status") or "uploading")
    created = str(item.get("createdAt") or "")
    with_ = item.get("analyzedWith") if isinstance(item.get("analyzedWith"), Mapping) else None
    duration = item.get("durationSec")
    removed = retention.file_removed(item)
    out: dict[str, Any] = {
        "refId": str(item.get("refId")),
        "title": str(item.get("title") or ""),
        "status": status if status in STATUSES else "failed",
        "durationSec": float(duration)
        if isinstance(duration, int | float) and not isinstance(duration, bool)
        else None,
        "bytes": 0 if removed else int(item.get("bytes") or 0),
        # §45.34, §45.35 D9: "The video was removed to save space." and, only when its study was kept, "Its study
        # stays."
        "fileRemoved": removed,
        "studyKept": retention.study_kept(item),
        "currentJobId": item.get("currentJobId") or None,
        # §45.40: the cleaned https link it came from (null for an upload); ``titleFromLink`` stays inside
        "link": str(item["link"]) if isinstance(item.get("link"), str) and item.get("link") else None,
        "ai": _ai(item),
        "analyzedWith": (
            {"model": str(with_.get("model") or ""), "effort": with_.get("effort") or None} if with_ else None
        ),
        "createdAt": created,
        "updatedAt": str(item.get("updatedAt") or created),
    }
    key = str(item.get("key") or "")
    prefix = ws.s3_prefix(str(item.get("userId")), str(item.get("workspaceId")))
    if status in FILE_STATUSES and key.startswith(prefix) and not removed:  # never while uploading or fetching
        out["url"] = app.media.presign_get(key, GET_SECONDS)
    return out


def public_job(item: Mapping[str, Any]) -> dict[str, Any]:
    """``ProductionJob`` (§45.6) of a reference: its analysis or (§45.40) the fetch of its link, its own ``jobType``;
    ``sessionId``, ``heartbeatAt`` and the override stay inside."""
    conf = item.get("configuration") if isinstance(item.get("configuration"), Mapping) else {}
    meta = item.get("meta") if isinstance(item.get("meta"), Mapping) else {}
    out: dict[str, Any] = {
        "jobId": item.get("jobId"),
        "workspaceId": item.get("workspaceId"),
        "contentType": "reference",
        "contentId": item.get("contentId"),
        "jobType": item.get("jobType") if item.get("jobType") in JOB_TYPES else TASK,
        "status": item.get("status") or "queued",
        "steps": [dict(s) for s in item.get("steps") or [] if isinstance(s, Mapping)],
        "progress": float(item.get("progress") or 0),
        "configuration": {
            "run": list((conf or {}).get("run") or []),
            "from": (conf or {}).get("from"),
            "sceneIds": (conf or {}).get("sceneIds"),
            "note": (conf or {}).get("note"),
        },
        "meta": {
            "writerModel": (meta or {}).get("writerModel"),
            "engineVersion": (meta or {}).get("engineVersion"),
            "seed": (meta or {}).get("seed"),
            "scriptVersion": (meta or {}).get("scriptVersion"),
            "targetSec": (meta or {}).get("targetSec"),
            "actualSec": (meta or {}).get("actualSec"),
            "safetyTopicId": (meta or {}).get("safetyTopicId"),
            "providers": dict((meta or {}).get("providers") or {}),
            "models": shapes.model_records((meta or {}).get("models")),  # the same records as a story job's (D5)
        },
        "createdAt": item.get("createdAt"),
        "updatedAt": item.get("updatedAt"),
    }
    if item.get("error"):
        out["error"] = str(item["error"])
    return out


def _owned(store: db.Store, user_id: str, workspace_id: str, ref_id: str) -> dict[str, Any]:
    if not is_ulid(ref_id):
        raise not_found(NOT_FOUND)
    item = cfg.get_owned(store, user_id, workspace_id, ref_sk(ref_id))
    if item is None:
        raise not_found(NOT_FOUND)
    return item


def _title(value: Any) -> str:
    if not isinstance(value, str) or not " ".join(value.split()):
        raise bad_request("Give the video a name.", "title")
    title = " ".join(value.split())
    if len(title) > TITLE_MAX:
        raise bad_request(f"The name is too long (at most {TITLE_MAX} characters).", "title")
    return title


# --- list, create, complete -----------------------------------------------------------------------------------


def list_refs(app: Any, user_id: str, workspace_id: str, now: datetime) -> list[dict[str, Any]]:
    items = cfg.query_owned(app.store, user_id, workspace_id, ws.REFVID_SK)
    items = [settle(app, i, now) for i in items]
    items.sort(key=lambda i: str(i.get("createdAt") or ""), reverse=True)
    return [public(app, i) for i in items]


def create(app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime) -> dict[str, Any]:
    validate.only_keys(body, ("filename", "contentType", "size", "title"))
    validate.required_string(body, "filename", max_len=200)
    content_type = body.get("contentType")
    if content_type not in TYPES:
        raise bad_request(WRONG_TYPE, "contentType")
    size = validate.whole_number(body.get("size"))
    if size is None or size < 1:
        raise bad_request("size must be the video's size in bytes.", "size")
    if size > MAX_BYTES:
        raise too_large(TOO_BIG)
    title = _title(body.get("title"))
    store = app.store
    if len(cfg.query_owned(store, user_id, workspace_id, ws.REFVID_SK)) >= MAX_REFERENCES:
        raise conflict(FULL)
    ref_id = ulid()
    key = f"{ref_prefix(user_id, workspace_id, ref_id)}source.{TYPES[str(content_type)]}"
    upload_id = app.media.create_multipart(key, str(content_type))
    count = max(1, math.ceil(size / PART_SIZE))
    at = iso(now)
    item = {
        **cfg.base_item(user_id, workspace_id, ref_sk(ref_id), ws.TYPE_REFVID),
        "refId": ref_id,
        "title": title,
        "status": "uploading",
        "bytes": size,
        "contentType": str(content_type),
        "ai": {"model": None, "effort": None},
        "key": key,
        "uploadId": upload_id,
        "partCount": count,
        "createdAt": at,
        "updatedAt": at,
    }
    try:
        store.put(item, if_absent=True)
    except Exception:
        app.media.abort_multipart(key, upload_id)
        raise
    parts = [
        {"partNumber": n, "url": app.media.presign_part(key, upload_id, n, PART_URL_SECONDS)}
        for n in range(1, count + 1)
    ]
    return {"reference": public(app, item), "upload": {"uploadId": upload_id, "parts": parts}}


def complete(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("parts",))
    store = app.store
    item = _owned(store, user_id, workspace_id, ref_id)
    if item.get("status") != "uploading":
        return public(app, item)  # done already (a second tap): nothing to finish
    count = int(item.get("partCount") or 0)
    raw = body.get("parts")
    if not isinstance(raw, list) or len(raw) != count:
        raise bad_request(f"Send all {count} parts of the video.", "parts")
    parts: list[dict[str, Any]] = []
    for entry in raw:
        part = validate.obj(entry, "parts")
        validate.only_keys(part, ("partNumber", "etag"))
        number = validate.integer(part.get("partNumber"), "partNumber", lo=1, hi=count)
        etag = part.get("etag")
        if not isinstance(etag, str) or not etag or len(etag) > 200:
            raise bad_request("Each part needs the etag S3 gave for it.", "parts")
        parts.append({"n": number, "etag": etag})
    parts.sort(key=lambda p: int(p["n"]))
    if [p["n"] for p in parts] != list(range(1, count + 1)):
        raise bad_request(f"Send all {count} parts of the video, each once.", "parts")
    key, upload_id = str(item["key"]), str(item.get("uploadId") or "")
    try:
        app.media.complete_multipart(key, upload_id, parts)
    except Exception as e:
        log("warning", "ws.reference_upload_failed", error=type(e).__name__, refId=ref_id)
        raise bad_request(NOT_FINISHED, "parts") from e
    head = app.media.head(key)
    size = int((head or {}).get("ContentLength") or 0)
    if head is None or size < 1:
        raise bad_request(NOT_FINISHED, "parts")
    if size > MAX_BYTES:
        with contextlib.suppress(Exception):
            app.media.delete(key)
        raise too_large(TOO_BIG)
    try:
        updated = store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"status": "ready", "bytes": size, "updatedAt": iso(now)},
            remove=["uploadId"],
            expect_in={"status": ["uploading"], "userId": [user_id], "workspaceId": [workspace_id]},
        )
    except db.ConditionFailed:
        updated = _owned(store, user_id, workspace_id, ref_id)
    return public(app, updated)


# --- from a link (§45.40) --------------------------------------------------------------------------------------


def _link(value: Any) -> tuple[str, str]:
    """``(the cleaned https link, its site)`` of what was pasted (share text too); a 400 on ``url`` with the card's
    sentence otherwise."""
    if not isinstance(value, str):
        raise bad_request(reflinks.SENTENCES["empty"], "url")
    try:
        return reflinks.clean_link(value)
    except reflinks.LinkRefused as e:
        raise bad_request(e.sentence, "url") from e


def _fetch_job(user_id: str, workspace_id: str, ref_id: str, job_id: str, at: str) -> dict[str, Any]:
    return {
        **cfg.base_item(user_id, workspace_id, _job_sk(job_id), ws.TYPE_PJOB),
        "jobId": job_id,
        "contentType": "reference",
        "contentId": ref_id,
        "jobType": FETCH,
        "status": "queued",
        "steps": [{"key": k, "label": label, "status": "pending"} for k, label in FETCH_STEPS],
        "progress": 0,
        "configuration": {"run": [k for k, _ in FETCH_STEPS], "from": None, "sceneIds": None, "note": None,
                          "override": None},
        "meta": {"providers": {}, "models": []},
        "createdAt": at,
        "updatedAt": at,
        "sessionId": cfg.new_session(job_id),
        "heartbeatAt": at,
    }  # fmt: skip


def _settled(app: Any, user_id: str, workspace_id: str, now: datetime) -> list[dict[str, Any]]:
    return [settle(app, i, now) for i in cfg.query_owned(app.store, user_id, workspace_id, ws.REFVID_SK)]


def _on_their_way(items: list[dict[str, Any]]) -> int:
    return sum(1 for i in items if i.get("status") == "fetching")


def create_from_link(
    app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """``POST …/references/link``: a ``fetching`` reference and its ``reference_fetch`` job in one transaction, then
    Clips Funded's own runtime is asked to get the video (``fetch_reference``). The stop of a stale run it fences
    waits until the start is done."""
    with cfg.stops_last(app):
        return _create_from_link(app, user_id, workspace_id, body, now=now)


def _create_from_link(
    app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("url", "title"))
    url, site = _link(body.get("url"))
    named = body.get("title") is not None
    title = _title(body.get("title")) if named else f"{reflinks.SITE_NAMES[site]} video"
    items = _settled(app, user_id, workspace_id, now)
    if len(items) >= MAX_REFERENCES:
        raise conflict(FULL)
    same = [i for i in items if i.get("link") == url]
    if same:
        # One that never arrived is no video in the list: say where its Try again is (never "already").
        raise conflict(DID_NOT_ARRIVE if all(i.get("status") == "fetch_failed" for i in same) else ALREADY)
    if _on_their_way(items) >= MAX_FETCHING:
        raise conflict(THREE)
    ref_id, job_id = ulid(), ulid()
    at = iso(now)
    job = _fetch_job(user_id, workspace_id, ref_id, job_id, at)
    item = {
        **cfg.base_item(user_id, workspace_id, ref_sk(ref_id), ws.TYPE_REFVID),
        "refId": ref_id,
        "title": title,
        "status": "fetching",
        "link": url,
        **({} if named else {"titleFromLink": True}),
        "bytes": 0,
        "contentType": "video/mp4",
        "key": f"{ref_prefix(user_id, workspace_id, ref_id)}source.mp4",
        "ai": {"model": None, "effort": None},
        "currentJobId": job_id,
        "createdAt": at,
        "updatedAt": at,
    }
    app.store.transact(puts=[job, item])
    return _start_fetch(app, job, item, now)


def fetch_again(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """``POST …/references/{refId}/fetch`` ("Try again", §45.40): only from ``fetch_failed``, a new job and the
    reference back to ``fetching`` in one transaction, then the runtime is asked again."""
    with cfg.stops_last(app):
        return _fetch_again(app, user_id, workspace_id, ref_id, body, now=now)


def _fetch_again(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ())
    store = app.store
    item = settle(app, _owned(store, user_id, workspace_id, ref_id), now)
    if item.get("status") == "fetching":
        raise conflict(FETCHING_NOW)
    if item.get("status") != "fetch_failed":
        raise conflict(HERE_ALREADY)
    _link(item.get("link"))  # still a link we get (the allowlist may have changed since)
    if _on_their_way(_settled(app, user_id, workspace_id, now)) >= MAX_FETCHING:
        raise conflict(THREE)
    job_id = ulid()
    at = iso(now)
    job = _fetch_job(user_id, workspace_id, ref_id, job_id, at)
    ref_update = db.update_request(
        str(item["pk"]),
        str(item["sk"]),
        {"status": "fetching", "currentJobId": job_id, "updatedAt": at},
        # Two taps at once: the first moves the status on, so the second's condition fails (a 409, nothing started).
        expect_in={"status": ["fetch_failed"], "userId": [user_id], "workspaceId": [workspace_id]},
        expect_absent=["currentJobId"],
    )
    try:
        store.transact(puts=[job], updates=[ref_update])
    except db.ConditionFailed as e:
        raise conflict(FETCHING_NOW) from e
    return _start_fetch(app, job, item, now)


def _start_fetch(app: Any, job: dict[str, Any], item: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """Asks the runtime to get the video; a start that fails (or no runtime) fails the job at once, and the
    reference is ``fetch_failed`` ("Getting the video did not start. Tap Try again.")."""
    runtime = cfg.runtime(app)
    problem = cfg.NOT_ON if runtime is None else None
    user_id, workspace_id = str(job["userId"]), str(job["workspaceId"])
    ref_id, job_id = str(job["contentId"]), str(job["jobId"])
    if runtime is not None:
        try:
            runtime.start_reference_fetch(
                user_id=user_id, workspace_id=workspace_id, ref_id=ref_id, job_id=job_id, session_id=job["sessionId"]
            )
        except Exception as e:
            log("warning", "ws.reference_fetch_not_started", error=type(e).__name__, jobId=job_id)
            problem = FETCH_DID_NOT_START
    if problem is not None:
        failed, ref = _fail(app, job, problem, now, queued_only=True)
        return {"reference": public(app, ref), "job": public_job(failed)}
    started = app.store.get(str(item["pk"]), str(item["sk"])) or item
    return {"reference": public(app, started), "job": public_job(job)}


# --- analyze --------------------------------------------------------------------------------------------------


def _job_sk(job_id: str) -> str:
    return f"{ws.PJOB_SK}{job_id}"


def analyze(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """Starts a ``reference_analysis`` job: the job and the reference change in one transaction (only from
    ``ready``, ``analyzed`` or ``failed`` with no job running), then Lamo Stories' runtime is asked to run it. The
    stop of a stale run it fences waits until the start is done."""
    with cfg.stops_last(app):
        return _analyze(app, user_id, workspace_id, ref_id, body, now=now)


def _analyze(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("override",))
    override = cfg.clean_override(body.get("override"))
    store = app.store
    item = settle(app, _owned(store, user_id, workspace_id, ref_id), now)
    if item.get("status") == "fetching":
        raise conflict(NOT_HERE)
    if item.get("status") == "fetch_failed":
        raise conflict(GET_FIRST)
    if item.get("status") == "analyzing":
        raise conflict(BUSY)
    if item.get("status") not in CAN_ANALYZE:
        raise conflict(NOT_READY)
    if retention.file_removed(item):  # a keep setting cleared the file (§45.34): there is nothing left to study
        raise conflict(removed_sentence(item))
    agent = agents_mod.read(store, user_id, workspace_id, AGENT)
    off = agents_mod.switched_off(agent)
    if off:
        raise conflict(off)
    ai = cfg.current(store, user_id, workspace_id)
    try:
        eff = res.resolve(task=TASK, agent=agent, ai=ai, request=override, project=_ai(item))
    except res.ResolveError as e:
        raise bad_request(e.message, "override" if override else None) from e
    info = res.model(eff["model"]) or {}
    if not info.get("vision"):
        raise bad_request(f"{info.get('label') or eff['model']} can't look at video frames. Pick another model.")
    job_id = ulid()
    at = iso(now)
    session_id = cfg.new_session(job_id)
    job = {
        **cfg.base_item(user_id, workspace_id, _job_sk(job_id), ws.TYPE_PJOB),
        "jobId": job_id,
        "contentType": "reference",
        "contentId": ref_id,
        "jobType": "reference_analysis",
        "status": "queued",
        "steps": [{"key": k, "label": label, "status": "pending"} for k, label in STEPS],
        "progress": 0,
        "configuration": {
            "run": [k for k, _ in STEPS],
            "from": None,
            "sceneIds": None,
            "note": None,
            "override": override,
        },
        "meta": {"providers": {}, "models": []},
        "createdAt": at,
        "updatedAt": at,
        "sessionId": session_id,
        "heartbeatAt": at,
    }
    before = str(item.get("status"))
    ref_update = db.update_request(
        str(item["pk"]),
        str(item["sk"]),
        {"status": "analyzing", "currentJobId": job_id, "updatedAt": at},
        # Two taps at once: the first moves the status on, so the second's condition fails (a 409, nothing started).
        # A cleanup that marked the file as cleared meanwhile wins too: nothing is studied from a file that is gone.
        expect_in={"status": [before], "userId": [user_id], "workspaceId": [workspace_id]},
        expect_absent=retention.REMOVED_MARKS,
    )
    try:
        store.transact(puts=[job], updates=[ref_update])
    except db.ConditionFailed as e:
        now_item = cfg.get_owned(store, user_id, workspace_id, ref_sk(ref_id))
        raise conflict(removed_sentence(now_item) if now_item and retention.file_removed(now_item) else BUSY) from e
    runtime = cfg.runtime(app)
    problem = cfg.NOT_ON if runtime is None else None
    if runtime is not None:
        try:
            runtime.start_reference(
                user_id=user_id, workspace_id=workspace_id, ref_id=ref_id, job_id=job_id, session_id=session_id
            )
        except Exception as e:
            log("warning", "ws.reference_not_started", error=type(e).__name__, jobId=job_id)
            problem = DID_NOT_START
    if problem is not None:
        job, ref = _fail(app, job, problem, now, queued_only=True)
        return {"reference": public(app, ref), "job": public_job(job)}
    ref = store.get(str(item["pk"]), str(item["sk"])) or item
    return {"reference": public(app, ref), "job": public_job(job)}


def _fail(
    app: Any, job: Mapping[str, Any], message: str, now: datetime, *, queued_only: bool = False
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Fails the job (a new ``sessionId``, the running or first pending step failed) and puts the reference back to
    ``analyzed`` when an earlier analysis is kept (``analysisKey``), else to ``failed`` (the agent's own rule), or to
    ``fetch_failed`` when the job was getting the video from its link (§45.40), in one transaction conditional on what
    was read; a refused condition re-reads both."""
    store = app.store
    at = iso(now)
    steps = [dict(s) for s in job.get("steps") or [] if isinstance(s, Mapping)]
    target = next((s for s in steps if s.get("status") == "running"), None) or next(
        (s for s in steps if s.get("status") == "pending"), None
    )
    if target is not None:
        target.update(status="failed", message=message, finishedAt=at)
    job_update = db.update_request(
        str(job["pk"]),
        str(job["sk"]),
        {
            "status": "failed",
            "error": message,
            "steps": steps,
            "sessionId": cfg.new_session(str(job["jobId"])),
            "updatedAt": at,
        },
        expect_in={
            "status": ["queued"] if queued_only else [str(job.get("status"))],
            "sessionId": [job.get("sessionId")],
            **({} if queued_only else {"heartbeatAt": [job.get("heartbeatAt")]}),
        },
    )
    ref_pk, ref_key = str(job["pk"]), ref_sk(str(job["contentId"]))
    ref_update = db.update_request(
        ref_pk,
        ref_key,
        {"status": after_failure(store.get(ref_pk, ref_key), job), "updatedAt": at},
        remove=["currentJobId"],
        expect_in={"currentJobId": [job["jobId"]]},
    )
    try:
        store.transact(updates=[job_update, ref_update])
    except db.ConditionFailed:
        pass
    else:
        cfg.stop_quietly(app, job.get("sessionId"))
    return (store.get(str(job["pk"]), str(job["sk"])) or dict(job), store.get(ref_pk, ref_key) or {})


def after_failure(ref: Mapping[str, Any] | None, job: Mapping[str, Any] | None = None) -> str:
    """A failed or stopped fetch of a link (§45.40) leaves ``fetch_failed``. A failed or stopped analysis keeps an
    earlier one: ``analyzed`` while ``analysisKey`` is there, else ``failed`` (the same rule as the agent's
    ``reference/study.py``, so the stories keep using the old analysis)."""
    if (job or {}).get("jobType") == FETCH:
        return "fetch_failed"
    return "analyzed" if (ref or {}).get("analysisKey") else "failed"


def _stale(job: Mapping[str, Any], now: datetime) -> bool:
    beat = parse(job.get("heartbeatAt")) or parse(job.get("createdAt"))
    if job.get("status") == "queued":
        return beat is None or now - beat > QUEUED_STALE
    if job.get("status") == "running":
        return beat is None or now - beat > RUNNING_STALE
    return False


def settle(app: Any, item: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The stale-heartbeat fence of §45.9.1 for a reference's analysis job, and (§45.40) for the fetch of its link: a
    job ``queued`` more than 3 minutes or ``running`` more than 6 without a heartbeat fails ("Studying the video
    stopped. Tap Try again." or "Getting the video stopped. Tap Try again.")."""
    job_id = item.get("currentJobId")
    if item.get("status") not in ("analyzing", "fetching") or not isinstance(job_id, str):
        return item
    job = cfg.get_owned(app.store, str(item["userId"]), str(item["workspaceId"]), _job_sk(job_id))
    if job is None:
        _, ref = _orphan(app, item, now)
        return ref or item
    if not _stale(job, now):
        return item
    _, ref = _fail(app, job, FETCH_STOPPED if job.get("jobType") == FETCH else STOPPED, now)
    return ref or item


def _orphan(app: Any, item: Mapping[str, Any], now: datetime) -> tuple[None, dict[str, Any] | None]:
    """A reference that says it is being studied by a job that no longer exists goes back to ``analyzed`` (an earlier
    analysis is kept) or ``failed``; one that says its video is on its way (§45.40) to ``fetch_failed``."""
    status = "fetch_failed" if item.get("status") == "fetching" else after_failure(item)
    with contextlib.suppress(db.ConditionFailed):
        return None, app.store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"status": status, "updatedAt": iso(now)},
            remove=["currentJobId"],
            expect_in={"currentJobId": [item.get("currentJobId")]},
        )
    return None, app.store.get(str(item["pk"]), str(item["sk"]))


# --- get, rename, delete --------------------------------------------------------------------------------------


def analysis(app: Any, item: Mapping[str, Any]) -> dict[str, Any] | None:
    """The stored ``ReferenceAnalysis`` (``analysis.json``), or None."""
    key = str(item.get("analysisKey") or "")
    if not key.startswith(ref_prefix(str(item["userId"]), str(item["workspaceId"]), str(item["refId"]))):
        return None
    try:
        data = json.loads(app.media.read(key, ANALYSIS_MAX))
    except Exception as e:
        log("warning", "ws.reference_analysis_unreadable", error=type(e).__name__, refId=str(item["refId"]))
        return None
    return _public_analysis(data) if isinstance(data, dict) else None


def _texts(value: Any) -> list[str]:
    return [str(v) for v in value if isinstance(v, str | int | float)] if isinstance(value, list) else []


def _num(value: Any) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def _public_analysis(data: Mapping[str, Any]) -> dict[str, Any]:
    hook = data.get("hook") if isinstance(data.get("hook"), Mapping) else {}
    pacing = data.get("pacing") if isinstance(data.get("pacing"), Mapping) else {}
    return {
        "summary": str(data.get("summary") or ""),
        "hook": {"atSec": _num((hook or {}).get("atSec")), "what": str((hook or {}).get("what") or "")},
        "pacing": {
            "cutsPer10s": _num((pacing or {}).get("cutsPer10s")),
            "notes": str((pacing or {}).get("notes") or ""),
        },
        "shots": [
            {
                "start": _num(s.get("start")),
                "end": _num(s.get("end")),
                "what": str(s.get("what") or ""),
                "acting": str(s.get("acting") or ""),
                "sound": str(s.get("sound") or ""),
            }
            for s in data.get("shots") or []
            if isinstance(s, Mapping)
        ],
        "gags": _texts(data.get("gags")),
        "sound": str(data.get("sound") or ""),
        "captions": str(data.get("captions") or ""),
        "borrow": _texts(data.get("borrow")),
        "avoid": _texts(data.get("avoid")),
    }


def _is_kind(job: Mapping[str, Any], kind: str) -> bool:
    """An analysis job is ``reference_analysis`` (or has no ``jobType``: an item from before §45.40); a fetch job is
    ``reference_fetch``."""
    return job.get("jobType") == kind or (kind == TASK and job.get("jobType") is None)


def _job_of(app: Any, item: Mapping[str, Any], kind: str) -> dict[str, Any] | None:
    """The reference's job of one kind: the one of ``currentJobId``, else its newest one; None when it never had one."""
    user_id, workspace_id, ref_id = str(item["userId"]), str(item["workspaceId"]), str(item["refId"])
    current = item.get("currentJobId")
    if isinstance(current, str) and current:
        job = cfg.get_owned(app.store, user_id, workspace_id, _job_sk(current))
        if (
            job is not None
            and job.get("contentType") == "reference"
            and job.get("contentId") == ref_id
            and _is_kind(job, kind)
        ):
            return job
    found = [
        j
        for j in cfg.query_owned(app.store, user_id, workspace_id, ws.PJOB_SK)
        if j.get("contentType") == "reference" and j.get("contentId") == ref_id and _is_kind(j, kind)
    ]
    return max(found, key=lambda j: (str(j.get("createdAt") or ""), str(j.get("jobId") or "")), default=None)


def analysis_job(app: Any, item: Mapping[str, Any]) -> dict[str, Any] | None:
    """The reference's analysis job (§45.34): the one of ``currentJobId``, else its newest one; None when it never
    had one. The page shows each step and the failure's own sentence from it. A fetch job is never this one."""
    return _job_of(app, item, TASK)


def fetch_job(app: Any, item: Mapping[str, Any]) -> dict[str, Any] | None:
    """The newest job that got (or is getting) a link reference's video (§45.40); None for an upload."""
    return _job_of(app, item, FETCH)


def get(app: Any, user_id: str, workspace_id: str, ref_id: str, now: datetime) -> dict[str, Any]:
    item = settle(app, _owned(app.store, user_id, workspace_id, ref_id), now)
    job = analysis_job(app, item)
    fetched = fetch_job(app, item)
    return {
        "reference": public(app, item),
        "analysis": analysis(app, item),
        "job": public_job(job) if job is not None else None,
        "fetchJob": public_job(fetched) if fetched is not None else None,
    }


def patch(
    app: Any, user_id: str, workspace_id: str, ref_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """Renames the video and/or sets its own model and effort (``ai``: null for each is the default). A rename takes
    ``titleFromLink`` away, so the fetch of a link never writes over the owner's own name (§45.40)."""
    validate.only_keys(body, ("title", "ai"))
    if not body:
        raise bad_request("Change at least one thing.")
    store = app.store
    item = _owned(store, user_id, workspace_id, ref_id)
    sets: dict[str, Any] = {"updatedAt": iso(now)}
    if "title" in body:
        sets["title"] = _title(body.get("title"))
    if "ai" in body:
        sets["ai"] = cfg.clean_setting(body.get("ai"))
    try:
        updated = store.update(
            str(item["pk"]),
            str(item["sk"]),
            sets,
            remove=["titleFromLink"] if "title" in body else (),
            expect_in={"userId": [user_id], "workspaceId": [workspace_id]},
        )
    except db.ConditionFailed as e:
        raise not_found(NOT_FOUND) from e
    return public(app, updated)


def delete(app: Any, user_id: str, workspace_id: str, ref_id: str, now: datetime) -> None:
    """Stops a running analysis, deletes the reference's jobs, the item and every file under its prefix."""
    store = app.store
    item = _owned(store, user_id, workspace_id, ref_id)
    job_id = item.get("currentJobId")
    if isinstance(job_id, str):
        job = cfg.get_owned(store, user_id, workspace_id, _job_sk(job_id))
        if job is not None and job.get("status") in ("queued", "running"):
            with contextlib.suppress(db.ConditionFailed):
                store.update(
                    str(job["pk"]),
                    str(job["sk"]),
                    {"status": "canceled", "sessionId": cfg.new_session(job_id), "updatedAt": iso(now)},
                    expect_in={"sessionId": [job.get("sessionId")]},
                )
            cfg.stop_quietly(app, job.get("sessionId"))
    if item.get("status") == "uploading" and item.get("uploadId"):
        with contextlib.suppress(Exception):
            app.media.abort_multipart(str(item["key"]), str(item["uploadId"]))
    if not store.delete_if(str(item["pk"]), str(item["sk"]), {"userId": [user_id], "workspaceId": [workspace_id]}):
        raise not_found(NOT_FOUND)
    for job in cfg.query_owned(store, user_id, workspace_id, ws.PJOB_SK):
        if job.get("contentType") == "reference" and job.get("contentId") == ref_id:
            store.delete(str(job["pk"]), str(job["sk"]))
    try:
        app.media.delete_prefix(ref_prefix(user_id, workspace_id, ref_id))
    except Exception as e:
        log("warning", "ws.reference_files_left", error=type(e).__name__, refId=ref_id)
