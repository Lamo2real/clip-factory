"""/v1/jobs: create, list, read, cancel, retry and delete (§34)."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .. import clips, db, job_delete, jobs, macfetch, s3, settings, validate
from ..agent_client import AgentError, new_session_id
from ..app import App
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, ok
from ..ids import is_ulid, ulid
from ..log import log

MAX_NOTES = 2000
MAX_FILENAME = 255


def _source(app: App, user_id: str, value: Any) -> dict[str, Any]:
    source = validate.obj(value, "source")
    kind = source.get("type")
    if kind == "link":
        validate.only_keys(source, {"type", "url"})
        platform, url = jobs.link_platform(validate.required_string(source, "url", max_len=jobs.MAX_URL))
        return {"type": "link", "platform": platform, "url": url}
    if kind == "upload":
        validate.only_keys(source, {"type", "key", "filename"})
        key = validate.required_string(source, "key", max_len=1024)
        if not key.startswith(s3.upload_prefix(user_id)) or not s3.is_safe_key(key):
            raise bad_request("That upload does not belong to you.")
        filename = validate.string(source, "filename", required=False, max_len=MAX_FILENAME) or key.rsplit("/", 1)[-1]
        if app.media.head(key) is None:
            raise bad_request("We could not find your upload. Upload the video again.")
        return {"type": "upload", "platform": "upload", "key": key, "filename": filename}
    raise bad_request('source.type must be "link" or "upload".')


def _clip_target(value: Any, user_settings: dict[str, Any]) -> dict[str, int]:
    if value is None:
        return {"min": user_settings["clipMin"], "max": user_settings["clipMax"]}
    target = validate.obj(value, "clipTarget")
    validate.only_keys(target, {"min", "max"})
    low = validate.integer(target.get("min"), "clipTarget.min", lo=1, hi=10)
    high = validate.integer(target.get("max"), "clipTarget.max", lo=1, hi=10)
    if high < low:
        raise bad_request("clipTarget.max must be at least clipTarget.min.")
    return {"min": low, "max": high}


def _job_or_404(app: App, req: Request) -> dict[str, Any]:
    job_id = req.params["jobId"]
    item = app.store.get(db.user_pk(req.user_id), db.job_sk(job_id)) if is_ulid(job_id) else None
    if item is None:
        raise not_found("We could not find that job.")
    return item


def create(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"source", "clipTarget", "notes", "macFetch"})
    # Started from the desktop app (§35.1): a YouTube link is fetched by the owner's Mac from the start.
    mac_up = validate.boolean(body["macFetch"], "macFetch") if "macFetch" in body else False
    user_settings = settings.load(app.store, req.user_id)
    source = _source(app, req.user_id, body.get("source"))
    target = _clip_target(body.get("clipTarget"), user_settings)
    notes = validate.string(body, "notes", required=False, max_len=MAX_NOTES)
    now = iso(app.clock())
    job_id = ulid()
    item: dict[str, Any] = {
        "pk": db.user_pk(req.user_id),
        "sk": db.job_sk(job_id),
        "type": "job",
        "userId": req.user_id,
        "jobId": job_id,
        "status": "queued",
        "source": source,
        "clipTarget": target,
        "steps": jobs.new_steps(),
        "progress": 0,
        "clipCount": 0,
        "createdAt": now,
        "updatedAt": now,
        "sessionId": new_session_id(job_id),
        "heartbeatAt": now,
        "flowRun": 1,
    }
    if notes:
        item["notes"] = notes
    if source["type"] == "link" and source["platform"] == "youtube":
        # Blocked by YouTube, the job waits for the owner's Mac instead of failing (§35); the agent checks for this map.
        item["macFetch"] = macfetch.new_map(up=mac_up)
    app.store.put(item, if_absent=True)
    log("info", "job.created", jobId=job_id, platform=source["platform"])
    job = jobs.start(app.store, app.flows, item, now)
    return ok({"job": jobs.public_job(job)}, 201)


def list_jobs(app: App, req: Request) -> Response:
    limit = validate.query_int(req.query, "limit", default=20, lo=1, hi=50)
    pk = db.user_pk(req.user_id)
    start = db.decode_cursor(req.query.get("cursor"), pk, "JOB#")
    page = app.store.query_page(pk, "JOB#", newest_first=True, limit=limit, start_key=start)
    lines = jobs.live_lines(app.store, req.user_id, page.items)
    return ok(
        {
            "jobs": [jobs.public_job(i, lines.get(str(i.get("jobId")))) for i in page.items],
            "nextCursor": db.encode_cursor(page.last_key),
        },
    )


def get_job(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    items = clips.clips_for_job(app.store, req.user_id, job["jobId"])
    items.sort(key=lambda c: (c.get("rank", 0), c.get("clipId", "")))
    live = (
        app.store.get(db.user_pk(req.user_id), jobs.live_sk(job["jobId"])) if job.get("status") in jobs.ACTIVE else None
    )
    return ok({"job": jobs.public_job(job, live), "clips": [clips.public_clip(c, app.media) for c in items]})


def cancel(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    _refuse_if_deleting(job)
    now = iso(app.clock())
    try:
        expect: dict[str, Any] = {"status": jobs.ACTIVE}
        if job.get("sessionId"):
            expect["sessionId"] = [job["sessionId"]]  # the run we signal below is the run we canceled
        updated = app.store.update(job["pk"], job["sk"], {"status": "canceled", "updatedAt": now}, expect_in=expect)
    except db.ConditionFailed as e:
        raise conflict("Only a queued or running job can be stopped.") from e
    _end_mac_wait(app, job)
    if job.get("sessionId"):
        try:
            app.agent.cancel_job(job["jobId"], job["sessionId"])
        except AgentError as e:
            # The job is already canceled in the table; the agent checks that and stops on its own.
            log("warning", "job.cancel_signal_failed", jobId=job["jobId"], error=str(e))
    log("info", "job.canceled", jobId=job["jobId"])
    return ok({"job": jobs.public_job(updated)})


def _end_mac_wait(app: App, job: dict[str, Any]) -> None:
    """A job waiting for the owner's Mac (§35) is stopped: the job flow's wait ends now (not after 24 h) and a half-sent
    video is dropped. Best effort: the job is already canceled in the table, and the bucket's lifecycle rule removes a
    forgotten upload."""
    callback_id = job.get("macCallbackId")
    if isinstance(callback_id, str) and callback_id:
        try:
            app.flows.mac_stopped(callback_id, "Canceled", "The job was canceled.")
        except Exception as e:
            log("warning", "job.mac_cancel_signal_failed", jobId=job["jobId"], error=type(e).__name__)
    mac = job.get("macFetch")
    if isinstance(mac, dict) and mac.get("uploadId") and mac.get("key"):
        try:
            app.media.abort_multipart(str(mac["key"]), str(mac["uploadId"]))
        except Exception as e:
            log("warning", "job.mac_abort_failed", jobId=job["jobId"], error=type(e).__name__)


def _refuse_if_deleting(job: dict[str, Any]) -> None:
    if job.get("deletingAt"):
        raise conflict("This job is being deleted.")


def retry(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    _refuse_if_deleting(job)
    now = iso(app.clock())
    expect: dict[str, Any] = {"status": jobs.RESTARTABLE}
    if job.get("sessionId"):
        # The run read above must still be current, so two retries never start the same flow name.
        expect["sessionId"] = [job["sessionId"]]
    pick_up = jobs.picks_up(job)  # it stopped partway, or after its clips were cut: pick up (§30.6)
    fields = jobs.restart_fields(
        job["jobId"],
        now,
        int(job.get("flowRun") or 1),
        pick_up=pick_up,
        steps=job.get("steps"),
        progress=job.get("progress"),
    )
    # The last run's wait for a Mac (§35) ends with it: its claim, upload, notification and callback must not make
    # this run look like it still waits (the Mac would download the video while the cloud runs too).
    fresh_mac = macfetch.restarted(job.get("macFetch"))
    if fresh_mac is not None:
        fields["macFetch"] = fresh_mac
    try:
        updated = app.store.update(
            job["pk"],
            job["sk"],
            fields,
            remove=["error", "flowExecutionArn", "macCallbackId"] + ([] if pick_up else ["pickUp", "note"]),
            expect_in=expect,
        )
    except db.ConditionFailed as e:
        raise conflict("Only a failed or stopped job can be retried.") from e
    log("info", "job.retried", jobId=job["jobId"])
    old_session = job.get("sessionId")
    if not old_session or old_session == updated.get("sessionId"):
        return ok({"job": jobs.public_job(jobs.start(app.store, app.flows, updated, now))})
    # The old run may still be alive: a heartbeat timeout, a lost Stop signal. The new sessionId written above
    # fences its table writes (the agent and the old job-flow condition every write on their own sessionId); as a
    # backstop, the old runtime session is stopped outright (not sent a cancel, whose wind-down would still write to
    # the job). The two calls run side by side so the request stays well under the 29 s API limit.
    with ThreadPoolExecutor(max_workers=1) as pool:
        stopping = pool.submit(_stop_old_session, app, job["jobId"], old_session)
        started = jobs.start(app.store, app.flows, updated, now)
        stopping.result()
    return ok({"job": jobs.public_job(started)})


def _stop_old_session(app: App, job_id: str, session_id: str) -> None:
    try:
        app.agent.stop_session(session_id)
    except Exception as e:  # best effort: the sessionId fence is what keeps the old run out
        log("warning", "job.retry_stop_old_failed", jobId=job_id, error=str(e))


def _clip_choice(value: Any, field: str) -> bool:
    """``"delete"``: the job's clips still waiting in Review go too; ``"keep"`` (the default): they stay."""
    if value is None:
        return False
    if value not in job_delete.CLIP_CHOICES:
        raise bad_request(f'{field} must be "keep" or "delete".')
    return bool(value == "delete")


def delete(app: App, req: Request) -> Response:
    """DELETE /v1/jobs/{jobId}?clips=keep|delete (§34). Idempotent: a job that is not there answers ``deleted:
    false``. Only the caller's own jobs can be reached (the key is theirs)."""
    job_id = req.params["jobId"]
    if not is_ulid(job_id):
        raise not_found("We could not find that job.")
    review_clips = _clip_choice(req.query.get("clips"), "clips")
    return ok(job_delete.delete_job(app, req.user_id, job_id, review_clips=review_clips).public())


def delete_many(app: App, req: Request) -> Response:
    """POST /v1/jobs/delete ``{"jobIds": [...], "clips"?: "keep" | "delete"}``: up to 25 jobs at once (§34)."""
    body = req.json()
    validate.only_keys(body, {"jobIds", "clips"})
    ids = body.get("jobIds")
    if not isinstance(ids, list) or not ids or len(ids) > job_delete.MAX_BATCH:
        raise bad_request(f"jobIds must list 1 to {job_delete.MAX_BATCH} jobs.", "jobIds")
    if not all(isinstance(i, str) and is_ulid(i) for i in ids):
        raise bad_request("jobIds must hold job ids.", "jobIds")
    review_clips = _clip_choice(body.get("clips"), "clips")
    outcomes = job_delete.delete_jobs(app, req.user_id, list(dict.fromkeys(ids)), review_clips=review_clips)
    return ok({"results": [o.public() for o in outcomes]})
