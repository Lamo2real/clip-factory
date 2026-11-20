"""Mac fetches it (docs/CONTRACTS.md §35.3): the owner's Mac or Windows app reports progress, gets signed part
addresses for the video and finishes the upload. Only a job waiting for a Mac accepts these, and only from the one
computer that claimed it (``deviceId``, made once per app and kept in the page's storage).

| Route | Body | What it does |
|---|---|---|
| ``POST /v1/jobs/{id}/mac-progress`` | ``deviceId``, ``phase`` (getting, sending, failed), ``pct``, ``error``, ``needGb`` | claims the job, updates ``macFetch`` and the live line; ``failed`` ends the job flow's wait with the owner's words |
| ``POST /v1/jobs/{id}/source-upload`` | ``deviceId``, ``size`` | starts (or resumes) a multipart upload and returns one signed address per 64 MB part |
| ``POST /v1/jobs/{id}/source-upload/complete`` | ``deviceId``, ``parts`` [{n, etag}], ``title``, ``creator``, ``durationSec`` | finishes the upload, checks its size, and tells the job flow, which turns the job into an upload job |
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from .. import db, jobs, macfetch, validate
from ..app import App
from ..clock import iso
from ..errors import ApiError, bad_request, conflict
from ..flow_client import FlowStartError
from ..http import Request, Response, ok
from ..log import log
from .jobs import _job_or_404

NOT_WAITING = "This job is not waiting for your Mac."
OTHER_MAC = "Another computer is already getting this video."
CLOSED = "This job stopped waiting for your Mac."
NOT_READY = "The job is getting ready for your Mac. Try again in a few seconds."
PHASES = ("getting", "sending", "failed")
MAX_ETAG = 200


def _device(body: dict[str, Any]) -> str:
    device = validate.required_string(body, "deviceId", max_len=64)
    if not macfetch.DEVICE_ID.match(device):
        raise bad_request("deviceId must be 8 to 64 letters, digits, - or _.", "deviceId")
    return device


def _age(at: Any, now: datetime) -> float:
    try:
        then = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return (now - then).total_seconds()


def _claimed(app: App, req: Request, body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str]:
    """The job, its ``macFetch`` map and the device, once this device may work on it: the job waits for a Mac and
    no other computer has spoken for it in the last 2 minutes (a Mac that went quiet gives it up)."""
    job = _job_or_404(app, req)
    device = _device(body)
    if not macfetch.waiting(job):
        raise conflict(NOT_WAITING)
    mac = dict(job["macFetch"])
    holder = mac.get("deviceId")
    if holder and holder != device and _age(mac.get("at"), app.clock()) < macfetch.CLAIM_STALE_SECONDS:
        raise conflict(OTHER_MAC)
    return job, mac, device


def _write(app: App, job: dict[str, Any], mac: dict[str, Any], now: str) -> dict[str, Any]:
    try:
        return app.store.update(
            job["pk"],
            job["sk"],
            {"macFetch": mac, "updatedAt": now},
            expect_in={"status": list(jobs.ACTIVE), "sessionId": [job.get("sessionId")]},
        )
    except db.ConditionFailed as e:
        raise conflict(NOT_WAITING) from e


def progress(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"deviceId", "phase", "pct", "error", "needGb"})
    job, mac, device = _claimed(app, req, body)
    phase = validate.required_string(body, "phase", max_len=16)
    if phase not in PHASES:
        raise bad_request("phase must be getting, sending or failed.", "phase")
    now_dt = app.clock()
    now = iso(now_dt)
    if phase == "failed":
        code = validate.required_string(body, "error", max_len=16)
        gb = validate.integer(body.get("needGb", 1), "needGb", lo=1, hi=9999) if code == macfetch.FULL_CODE else None
        words = macfetch.failure_words(code, gb)
        if words is None:
            raise bad_request("error is not one the app reports.", "error")
        return ok({"job": jobs.public_job(_stop(app, job, mac, words, now))})
    pct = validate.integer(body.get("pct", 0), "pct", lo=0, hi=100)
    same = mac.get("deviceId") == device and mac.get("state") == phase
    if same and _age(mac.get("at"), now_dt) < macfetch.PROGRESS_GAP_SECONDS:
        raise ApiError(429, "rate_limited", "Wait a few seconds, then try again.", headers={"Retry-After": "3"})
    mac.update(state=phase, pct=pct, at=now, deviceId=device)
    updated = _write(app, job, mac, now)
    ttl = int((now_dt + timedelta(days=7)).timestamp())
    try:
        app.store.put(macfetch.live_item(req.user_id, updated, phase, pct, now=now, ttl=ttl))
    except Exception as e:  # the line is a nicety; macFetch.pct says the same
        log("warning", "mac.live_failed", jobId=job["jobId"], error=type(e).__name__)
    return ok({"job": jobs.public_job(updated)})


def _stop(app: App, job: dict[str, Any], mac: dict[str, Any], words: str, now: str) -> dict[str, Any]:
    """The Mac stopped: the job flow's wait ends with the owner's words (it fails the job), a half-sent video goes."""
    if mac.get("uploadId") and mac.get("key"):
        try:
            app.media.abort_multipart(str(mac["key"]), str(mac["uploadId"]))
        except Exception as e:
            log("warning", "mac.abort_failed", jobId=job["jobId"], error=type(e).__name__)
    callback = job.get("macCallbackId")
    if not callback:
        # The job flow has not written its wait yet (a Mac that answers within seconds): the app asks again.
        raise ApiError(503, "unavailable", NOT_READY)
    try:
        sent = app.flows.mac_stopped(str(callback), "MacFailed", words)
    except FlowStartError as e:
        log("error", "mac.stop_signal_failed", jobId=job["jobId"], error=str(e))
        raise ApiError(503, "unavailable", "Could not reach the job. Try again.") from e
    log("info", "mac.failed", jobId=job["jobId"], sent=sent)
    mac.update(state="failed", at=now)
    mac.pop("uploadId", None)
    try:
        return _write(app, job, mac, now)
    except ApiError:
        return app.store.get(job["pk"], job["sk"]) or job


def source_upload(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"deviceId", "size"})
    job, mac, device = _claimed(app, req, body)
    size = validate.integer(body.get("size"), "size", lo=1, hi=macfetch.MAX_SIZE)
    key = macfetch.upload_key(req.user_id, job["jobId"])
    upload_id = mac.get("uploadId")
    if not upload_id or mac.get("size") != size or mac.get("key") != key:
        if upload_id and mac.get("key"):
            try:
                app.media.abort_multipart(str(mac["key"]), str(upload_id))
            except Exception as e:
                log("warning", "mac.abort_failed", jobId=job["jobId"], error=type(e).__name__)
        upload_id = app.media.create_multipart(key, "video/mp4")
    now = iso(app.clock())
    mac.update(state="sending", at=now, deviceId=device, uploadId=upload_id, key=key, size=size)
    mac.setdefault("pct", 0)
    _write(app, job, mac, now)
    parts = [
        {"n": n, "url": app.media.presign_part(key, str(upload_id), n, macfetch.PART_URL_SECONDS)}
        for n in range(1, macfetch.part_count(size) + 1)
    ]
    log("info", "mac.upload_started", jobId=job["jobId"], size=size, parts=len(parts))
    return ok({"partSize": macfetch.PART_SIZE, "parts": parts})


def _parts(value: Any, want: int) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != want:
        raise bad_request("parts must list every part of the video.", "parts")
    out = []
    for i, p in enumerate(value, start=1):
        if not isinstance(p, dict) or p.get("n") != i:
            raise bad_request("parts must be in order, from 1.", "parts")
        etag = p.get("etag")
        if not isinstance(etag, str) or not 0 < len(etag) <= MAX_ETAG or not etag.isprintable():
            raise bad_request("Each part needs its ETag.", "parts")
        out.append({"n": i, "etag": etag})
    return out


def complete(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"deviceId", "parts", "title", "creator", "durationSec"})
    job, mac, device = _claimed(app, req, body)
    key, upload_id, size = mac.get("key"), mac.get("uploadId"), mac.get("size")
    if not (key and upload_id and isinstance(size, int)) or mac.get("deviceId") != device:
        raise conflict("Start the upload first.")
    parts = _parts(body.get("parts"), macfetch.part_count(size))
    head = app.media.head(str(key))
    if head is None:
        try:
            app.media.complete_multipart(str(key), str(upload_id), parts)
        except Exception as e:
            log("warning", "mac.complete_failed", jobId=job["jobId"], error=type(e).__name__)
            raise conflict("The video did not arrive whole. Send it again.") from e
        head = app.media.head(str(key))
    if head is None or int(head.get("ContentLength") or 0) != size:
        raise conflict("The video did not arrive whole. Send it again.")
    callback = job.get("macCallbackId")
    if not callback:
        raise ApiError(503, "unavailable", NOT_READY)
    result: dict[str, Any] = {"key": key, "size": size}
    for name, limit in (("title", 200), ("creator", 120)):
        text = macfetch.clean_text(body.get(name), limit)
        if text:
            result[name] = text
    duration = body.get("durationSec")
    if isinstance(duration, int | float) and not isinstance(duration, bool) and 0 < duration < 7 * 86400:
        result["durationSec"] = round(float(duration), 2)
    try:
        sent = app.flows.mac_done(str(callback), result)
    except FlowStartError as e:
        log("error", "mac.done_signal_failed", jobId=job["jobId"], error=str(e))
        raise ApiError(503, "unavailable", "Could not reach the job. Try again.") from e
    if not sent:
        raise conflict(CLOSED)
    log("info", "mac.video_sent", jobId=job["jobId"], size=size)
    now = iso(app.clock())
    mac.update(state="sending", pct=100, at=now)
    try:
        updated = _write(app, job, mac, now)
    except ApiError:  # the flow already moved the job on (a new session): that is the success
        updated = app.store.get(job["pk"], job["sk"]) or job
    return ok({"job": jobs.public_job(updated)})
