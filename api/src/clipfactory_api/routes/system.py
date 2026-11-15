"""Health, the signed-in owner, uploads, settings, accounts, posts and insights."""

from __future__ import annotations

import re
from typing import Any

from .. import db, posts, s3, settings, validate
from ..app import App
from ..clock import iso
from ..errors import ApiError, bad_request
from ..http import Request, Response, no_content, ok
from ..ids import ulid
from ..log import log

MAX_UPLOAD_BYTES = 5 * 1024**3  # a single presigned PUT tops out at 5 GB
VIDEO_TYPE = re.compile(r"^video/[a-z0-9][a-z0-9.+-]{0,63}$")
MAX_LEARNINGS = 50


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
    validate.only_keys(body, {"filename", "contentType", "size"})
    filename = validate.required_string(body, "filename", max_len=255)
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


def get_settings(app: App, req: Request) -> Response:
    return ok({"settings": _settings_view(app, req.user_id)})


def put_settings(app: App, req: Request) -> Response:
    current = settings.load(app.store, req.user_id)
    updated = settings.merge_update(current, req.json())
    settings.save(app.store, req.user_id, updated, iso(app.clock()))
    return ok({"settings": {**updated, "hasYoutubeCookies": _has_cookies(app, req.user_id)}})


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


def list_accounts(app: App, req: Request) -> Response:
    return ok({"accounts": posts.accounts(app.store, req.user_id)})


def connect_account(app: App, req: Request) -> Response:
    if req.params["platform"] not in settings.PLATFORMS:
        raise ApiError(404, "not_found", "We do not support that platform.")
    raise ApiError(501, "not_implemented", "Connecting accounts arrives in the next phase.")


def list_posts(app: App, req: Request) -> Response:
    clip_id = req.query.get("clipId")
    items = (
        posts.posts_for_clip(app.store, req.user_id, clip_id) if clip_id else posts.all_posts(app.store, req.user_id)
    )
    return ok({"posts": [posts.public_post(p) for p in items]})


def insights(app: App, req: Request) -> Response:
    pk = db.user_pk(req.user_id)
    page = app.store.query_page(pk, "LEARNING#", newest_first=True, limit=MAX_LEARNINGS)
    learnings = [{k: i[k] for k in ("learningId", "text", "createdAt", "postIds") if k in i} for i in page.items]
    measured = [posts.public_post(p) for p in posts.all_posts(app.store, req.user_id) if p.get("metrics")]
    return ok({"learnings": learnings, "posts": measured})
