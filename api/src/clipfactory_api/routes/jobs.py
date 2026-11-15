"""/v1/jobs: create, list, read, cancel and retry."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .. import clips, db, jobs, s3, settings, validate
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
    validate.only_keys(body, {"source", "clipTarget", "notes"})
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
    app.store.put(item, if_absent=True)
    log("info", "job.created", jobId=job_id, platform=source["platform"])
    job = jobs.start(app.store, app.flows, item, now)
    return ok({"job": jobs.public_job(job)}, 201)


def list_jobs(app: App, req: Request) -> Response:
    limit = validate.query_int(req.query, "limit", default=20, lo=1, hi=50)
    pk = db.user_pk(req.user_id)
    start = db.decode_cursor(req.query.get("cursor"), pk, "JOB#")
    page = app.store.query_page(pk, "JOB#", newest_first=True, limit=limit, start_key=start)
    return ok(
        {"jobs": [jobs.public_job(i) for i in page.items], "nextCursor": db.encode_cursor(page.last_key)},
    )


def get_job(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    items = clips.clips_for_job(app.store, req.user_id, job["jobId"])
    items.sort(key=lambda c: (c.get("rank", 0), c.get("clipId", "")))
    return ok({"job": jobs.public_job(job), "clips": [clips.public_clip(c, app.media) for c in items]})


def cancel(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    now = iso(app.clock())
    try:
        expect: dict[str, Any] = {"status": jobs.ACTIVE}
        if job.get("sessionId"):
            expect["sessionId"] = [job["sessionId"]]  # the run we signal below is the run we canceled
        updated = app.store.update(job["pk"], job["sk"], {"status": "canceled", "updatedAt": now}, expect_in=expect)
    except db.ConditionFailed as e:
        raise conflict("Only a queued or running job can be stopped.") from e
    if job.get("sessionId"):
        try:
            app.agent.cancel_job(job["jobId"], job["sessionId"])
        except AgentError as e:
            # The job is already canceled in the table; the agent checks that and stops on its own.
            log("warning", "job.cancel_signal_failed", jobId=job["jobId"], error=str(e))
    log("info", "job.canceled", jobId=job["jobId"])
    return ok({"job": jobs.public_job(updated)})


def retry(app: App, req: Request) -> Response:
    job = _job_or_404(app, req)
    now = iso(app.clock())
    expect: dict[str, Any] = {"status": jobs.RESTARTABLE}
    if job.get("sessionId"):
        # The run read above must still be current, so two retries never start the same flow name.
        expect["sessionId"] = [job["sessionId"]]
    try:
        updated = app.store.update(
            job["pk"],
            job["sk"],
            jobs.restart_fields(job["jobId"], now, int(job.get("flowRun") or 1)),
            remove=["error", "flowExecutionArn"],
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
