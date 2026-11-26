"""Health, the signed-in owner, uploads, settings, posts and insights (accounts: ``routes/setup.py``, §17.4)."""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from .. import attachments, db, learn, posts, s3, settings, validate
from ..app import App
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict
from ..http import Request, Response, no_content, ok
from ..ids import ulid
from ..log import log

MAX_UPLOAD_BYTES = 5 * 1024**3  # a single presigned PUT tops out at 5 GB
VIDEO_TYPE = re.compile(r"^video/[a-z0-9][a-z0-9.+-]{0,63}$")
MAX_LEARNINGS = 50
SAVE_TRIES = 3
SETTINGS_CHANGED = "Your settings just changed. Try again."


def health(app: App, req: Request) -> Response:
    return ok({"ok": True, "version": app.version})


def _has_cookies(app: App, user_id: str) -> bool:
    try:
        return app.media.head(s3.cookies_key(user_id)) is not None
    except Exception as e:
        log("warning", "settings.cookies_check_failed", error=type(e).__name__)
        return False


def _settings_view(app: App, user_id: str) -> dict[str, Any]:
    return {**settings.load(app.store, user_id), "hasYoutubeCookies": _has_cookies(app, user_id)}


def me(app: App, req: Request) -> Response:
    email = req.claims.get("email") or app.email_lookup(req.user_id, req.token) or ""
    pk = db.user_pk(req.user_id)
    job_items = app.store.query_all(pk, "JOB#")
    clip_items = app.store.query_all(pk, "CLIP#")
    counts = {
        "review": sum(1 for c in clip_items if c.get("status") == "review"),
        "running": sum(1 for j in job_items if j.get("status") in {"queued", "running"}),
        "posted": sum(1 for c in clip_items if c.get("status") == "posted"),
    }
    return ok(
        {
            "user": {"id": req.user_id, "email": str(email)},
            "settings": _settings_view(app, req.user_id),
            "counts": counts,
        }
    )


def create_upload(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"filename", "contentType", "size", "purpose"})
    filename = validate.required_string(body, "filename", max_len=255)
    if "purpose" in body:
        if body["purpose"] != attachments.PURPOSE:
            raise bad_request('purpose must be "attachment".')
        return _attachment_upload(app, req, filename, body)
    content_type = validate.required_string(body, "contentType", max_len=80).lower()
    if not VIDEO_TYPE.match(content_type):
        raise bad_request("Only video files can be uploaded.")
    size = body.get("size")
    if isinstance(size, int) and not isinstance(size, bool) and size > MAX_UPLOAD_BYTES:
        raise ApiError(413, "too_large", "The video is larger than 5 GB.")
    validate.integer(size, "size", lo=1, hi=MAX_UPLOAD_BYTES)
    upload_id = ulid()
    key = s3.upload_key(req.user_id, upload_id, filename)
    return ok(
        {
            "uploadId": upload_id,
            "key": key,
            "uploadUrl": app.media.presign_put(key, content_type),
            "headers": {"Content-Type": content_type},
        }
    )


def _attachment_upload(app: App, req: Request, filename: str, body: dict[str, Any]) -> Response:
    """A file for the job's notes (§52): an allowed type, at most 20 MB, the length signed into the URL so S3 takes
    nothing bigger. Same ``uploads/`` key as a video, so the 14-day lifecycle cleans it up."""
    content_type = validate.required_string(body, "contentType", max_len=120).lower()
    size = attachments.check_upload(content_type, body.get("size"))
    upload_id = ulid()
    key = s3.upload_key(req.user_id, upload_id, filename)
    return ok(
        {
            "uploadId": upload_id,
            "key": key,
            "uploadUrl": app.media.presign_put_sized(key, content_type, size),
            "headers": {"Content-Type": content_type},
        }
    )


def get_settings(app: App, req: Request) -> Response:
    return ok({"settings": _settings_view(app, req.user_id)})


def _stamp(before: dict[str, Any] | None, now: str) -> str:
    """The saved item's ``updatedAt``: now, but always later than the one it replaces (two saves in one millisecond
    still differ, so the next save's condition tells them apart)."""
    old = parse((before or {}).get("updatedAt"))
    moment = parse(now)
    if old is not None and moment is not None and moment <= old:
        return iso(old + timedelta(milliseconds=1))
    return now


def put_settings(app: App, req: Request) -> Response:
    """Merges the patch over the stored settings and saves them only if nobody saved in between (the stored
    ``updatedAt`` is the one read); otherwise reads them again and merges the same patch, at most 3 times (409)."""
    patch = req.json()
    pk = db.user_pk(req.user_id)
    for _ in range(SAVE_TRIES):
        before = app.store.get(pk, db.SETTINGS_SK)
        now = iso(app.clock())
        updated = settings.merge_update(settings.with_defaults(before), patch, now=now)
        settings.register_autopost(app.store, req.user_id, patch, now)  # §46.3: before the save the tick reads
        try:
            settings.save_if_unchanged(app.store, req.user_id, updated, _stamp(before, now), before)
        except db.ConditionFailed:
            log("info", "settings.save_raced")
            continue
        return ok({"settings": {**updated, "hasYoutubeCookies": _has_cookies(app, req.user_id)}})
    raise conflict(SETTINGS_CHANGED)


def create_cookies_upload(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"filename"})
    filename = validate.required_string(body, "filename", max_len=255)
    if not filename.lower().endswith(".txt"):
        raise bad_request("Upload the cookies as a .txt file.")
    key = s3.cookies_key(req.user_id)
    # The key stays server side: the cookies file is only ever read by the agent.
    return ok({"uploadUrl": app.media.presign_put(key, "text/plain"), "headers": {"Content-Type": "text/plain"}})


def delete_cookies(app: App, req: Request) -> Response:
    app.media.delete(s3.cookies_key(req.user_id))
    return no_content()


def list_posts(app: App, req: Request) -> Response:
    clip_id = req.query.get("clipId")
    items = (
        posts.posts_for_clip(app.store, req.user_id, clip_id) if clip_id else posts.all_posts(app.store, req.user_id)
    )
    return ok({"posts": [posts.public_post(p) for p in items]})


def insights(app: App, req: Request) -> Response:
    pk = db.user_pk(req.user_id)
    page = app.store.query_page(pk, "LEARNING#", newest_first=True, limit=MAX_LEARNINGS)
    learnings = [learn.public_learning(i) for i in page.items]
    measured = [posts.public_post(p) for p in posts.all_posts(app.store, req.user_id) if p.get("metrics")]
    return ok({"learnings": learnings, "posts": measured})
