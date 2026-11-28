"""/v1/refvideos: the owner's reference videos, "Edit like these" (docs/CONTRACTS.md §57).

Files live at ``refs/{userId}/{refId}.ext`` (the agent adds ``{refId}-thumb.jpg``). Complete starts the agent's
``reference`` action; the agent writes the result (``ready`` with the style, or ``failed`` with one sentence).
"""

from __future__ import annotations

import contextlib
from typing import Any

from .. import db, refvideos, validate
from ..app import App
from ..clock import iso
from ..errors import ApiError, bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..ids import ulid
from ..log import log


def _room(app: App, req: Request) -> None:
    """409 once 10 videos are kept. Uploads that were never finished do not count, and are cleared away here."""
    now = app.clock()
    kept = 0
    for item in refvideos.all_items(app.store, req.user_id):
        if refvideos.stale(item, now):
            _forget(app, item)
        else:
            kept += 1
    if kept >= refvideos.MAX_REFS:
        raise conflict(refvideos.FULL)


def _forget(app: App, item: dict[str, Any]) -> None:
    """The item, then its files (a file left behind is harmless; an item without a file never is)."""
    app.store.delete(str(item["pk"]), str(item["sk"]))
    keys = {item.get("key"), item.get("thumbKey"), refvideos.thumb_key(str(item["userId"]), str(item["refId"]))}
    for key in sorted(str(k) for k in keys if refvideos.own_key(item, k)):
        try:
            app.media.delete(key)
        except Exception as e:
            log("warning", "refvideo.file_delete_failed", error=type(e).__name__)


def list_refvideos(app: App, req: Request) -> Response:
    """``{"refvideos": [...]}`` newest first; uploads not finished yet are left out."""
    shown = [i for i in refvideos.all_items(app.store, req.user_id) if i.get("status") != "uploading"]
    shown.sort(key=lambda i: (str(i.get("createdAt") or ""), str(i["refId"])), reverse=True)
    return ok({"refvideos": [refvideos.public(i, app.media) for i in shown]})


def create(app: App, req: Request) -> Response:
    """``{filename, contentType, size}`` → 201 ``{refId, uploadUrl, headers}``: a PUT signed for that type and size."""
    body = req.json()
    validate.only_keys(body, {"filename", "contentType", "size"})
    filename = validate.required_string(body, "filename", max_len=255)
    content_type = body.get("contentType")
    ext = refvideos.TYPES.get(content_type) if isinstance(content_type, str) else None
    size = validate.whole_number(body.get("size"))
    if ext is None or size is None or not 0 < size <= refvideos.MAX_BYTES:
        raise bad_request(refvideos.WRONG_FILE)
    _room(app, req)
    ref_id = ulid()
    key = refvideos.object_key(req.user_id, ref_id, ext)
    item = refvideos.new_item(
        req.user_id,
        ref_id,
        key,
        name=refvideos.display_name(filename),
        content_type=str(content_type),
        size=size,
        now=app.clock(),
    )
    app.store.put(item, if_absent=True)
    url = app.media.presign_put_sized(key, str(content_type), size, refvideos.PRESIGN_PUT_SECONDS)
    # The type and length are signed into the URL, so the browser must send the same type.
    return ok({"refId": ref_id, "uploadUrl": url, "headers": {"Content-Type": content_type}}, 201)


def _item_or_404(app: App, req: Request) -> dict[str, Any]:
    item = refvideos.get_item(app.store, req.user_id, req.params["refId"])
    if item is None:
        raise not_found(refvideos.NOT_FOUND)
    return item


def complete(app: App, req: Request) -> Response:
    """Starts (or, for a failed video or one stuck analyzing for 20 minutes, starts again) the agent's look at the
    video → 202 ``{refvideo}`` with ``status: "analyzing"``. A ready video, or one still being looked at, is returned
    as it is (safe to repeat). If the agent cannot be reached: ``failed`` with one sentence, and 503."""
    validate.only_keys(req.json(), ())
    item = _item_or_404(app, req)
    now = app.clock()
    if not refvideos.can_start(item, now):
        status = 200 if item.get("status") == "ready" else 202
        return ok({"refvideo": refvideos.public(item, app.media)}, status)
    key = str(item["key"])
    if item.get("status") == "uploading":
        head = app.media.head(key)
        if head is None:
            raise bad_request(refvideos.WRONG_FILE)  # not uploaded (yet): the owner can upload again
        if int(head.get("ContentLength") or 0) != int(item.get("size") or 0):
            _forget(app, item)
            raise bad_request(refvideos.WRONG_FILE)
    old_rev = int(item.get("analyzeRev") or 0)
    rev = old_rev + 1
    try:
        started = app.store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"status": "analyzing", "analyzeRev": rev, "analyzeStartedAt": iso(now)},
            remove=("error",),
            expect_in={"status": [str(item.get("status"))], "analyzeRev": [old_rev]},
        )
    except db.ConditionFailed:
        # Deleted, or another tap started it meanwhile: answer with what is there now.
        fresh = _item_or_404(app, req)
        return ok({"refvideo": refvideos.public(fresh, app.media)}, 202)
    try:
        app.agent.reference(req.user_id, str(started["refId"]), rev)
    except Exception as e:  # the agent could not be reached or refused: the video says so, the owner taps Try again
        log("error", "refvideo.start_failed", refId=started["refId"], error=type(e).__name__)
        with contextlib.suppress(db.ConditionFailed):  # deleted or started again meanwhile
            app.store.update(
                str(started["pk"]),
                str(started["sk"]),
                {"status": "failed", "error": refvideos.COULD_NOT_START},
                expect_in={"status": ["analyzing"], "analyzeRev": [rev]},
            )
        raise ApiError(503, "unavailable", refvideos.COULD_NOT_START) from None
    log("info", "refvideo.analyze_started", refId=started["refId"], rev=rev)
    return ok({"refvideo": refvideos.public(started, app.media)}, 202)


def delete(app: App, req: Request) -> Response:
    """The item, then the video and its thumbnail → 204. A video that is not there: 404."""
    item = _item_or_404(app, req)
    _forget(app, item)
    log("info", "refvideo.deleted", refId=item["refId"])
    return no_content()
