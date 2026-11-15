"""/v1/clips: review, caption edits, confirm and decline. Nothing is published without Confirm."""

from __future__ import annotations

from typing import Any

from .. import clips, db, s3, validate
from ..app import App
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, ok
from ..ids import is_ulid
from ..log import log

ALREADY_DECIDED = "This clip has already been confirmed or declined."


def _clip_or_404(app: App, req: Request) -> dict[str, Any]:
    clip_id = req.params["clipId"]
    item = app.store.get(db.user_pk(req.user_id), db.clip_sk(clip_id)) if is_ulid(clip_id) else None
    if item is None:
        raise not_found("We could not find that clip.")
    return item


def _require_review(item: dict[str, Any]) -> None:
    if item.get("status") != "review":
        raise conflict(ALREADY_DECIDED)


def list_clips(app: App, req: Request) -> Response:
    status = req.query.get("status") or "review"
    if status not in clips.STATUS_GROUPS:
        raise bad_request("status must be review, confirmed, posted, declined or all.")
    wanted = clips.STATUS_GROUPS[status]
    job_id = req.query.get("jobId")
    if job_id:
        if not is_ulid(job_id):
            raise bad_request("jobId is not valid.")
        items = clips.clips_for_job(app.store, req.user_id, job_id)
        items.sort(key=lambda c: (c.get("rank", 0), c.get("clipId", "")))
    else:
        items = clips.all_clips(app.store, req.user_id)
    if wanted is not None:
        items = [c for c in items if c.get("status") in wanted]
    return ok({"clips": [clips.public_clip(c, app.media) for c in items]})


def get_clip(app: App, req: Request) -> Response:
    return ok({"clip": clips.public_clip(_clip_or_404(app, req), app.media)})


def patch_clip(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"captions"})
    if "captions" not in body:
        raise bad_request("captions is required.")
    patch = clips.caption_patch(body["captions"])
    item = _clip_or_404(app, req)
    _require_review(item)
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"captions": clips.merged_captions(item.get("captions"), patch)},
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    return ok({"clip": clips.public_clip(updated, app.media)})


def confirm(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"captions"})
    patch = clips.caption_patch(body["captions"]) if body.get("captions") is not None else {}
    item = _clip_or_404(app, req)
    resumed = clips.claim_resume(app.store, item, app.clock())
    if resumed is not None:
        # An earlier Confirm stopped before the clip was queued (a timeout or an error): finish that work.
        created = clips.publish(app.store, app.enqueue_publish, req.user_id, resumed)
        log("info", "clip.confirm_resumed", clipId=resumed["clipId"], posts=len(created))
        return ok({"clip": clips.public_clip(resumed, app.media), "posts": created})
    _require_review(item)
    now = iso(app.clock())
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {
                "status": "confirmed",
                "decidedAt": now,
                "captions": clips.merged_captions(item.get("captions"), patch),
                "publishState": clips.PUBLISH_PENDING,
                "publishClaimAt": now,
            },
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    # The confirm itself is not undone if anything below fails: the clip stays publishState pending and is resumed.
    created = clips.publish(app.store, app.enqueue_publish, req.user_id, updated)
    log("info", "clip.confirmed", clipId=updated["clipId"], posts=len(created))
    return ok({"clip": clips.public_clip(updated, app.media), "posts": created})


def decline(app: App, req: Request) -> Response:
    item = _clip_or_404(app, req)
    _require_review(item)
    now = iso(app.clock())
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"status": "declined", "decidedAt": now},
            remove=["videoKey", "coverKey"],
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    _delete_files(app, item)
    log("info", "clip.declined", clipId=item["clipId"])
    return ok({"clip": clips.public_clip(updated, app.media)})


def _delete_files(app: App, item: dict[str, Any]) -> None:
    try:
        app.media.delete_prefix(s3.clip_prefix(item["jobId"], item["clipId"]))
        # Keys normally live under the clip's prefix; delete them by name too in case the agent stored them elsewhere.
        for field in ("videoKey", "coverKey"):
            key = item.get(field)
            if isinstance(key, str) and s3.is_safe_key(key) and key.startswith(f"jobs/{item['jobId']}/"):
                app.media.delete(key)
    except Exception as e:
        # The clip is declined either way; its files stay unreachable (the API never links a declined clip).
        log("error", "clip.delete_files_failed", clipId=item["clipId"], error=type(e).__name__)
