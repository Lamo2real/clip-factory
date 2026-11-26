"""/v1/logos: the owner's logo library (docs/CONTRACTS.md §53 C4). Files live at ``logos/{userId}/{logoId}.ext``."""

from __future__ import annotations

import contextlib
from typing import Any

from .. import db, logos, validate
from ..app import App
from ..contentrewards import links
from ..contentrewards import logo as campaign_logo
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..ids import ulid
from ..log import log

NO_LOGO = "We could not find that logo."
NO_CAMPAIGN = "We could not find that campaign."


def _room(app: App, req: Request) -> None:
    """409 once the library is full. Uploads that were never finished do not count, and are cleared away here."""
    now = app.clock()
    kept = 0
    for item in logos.all_items(app.store, req.user_id):
        if logos.stale(item, now):
            _forget(app, item)
        else:
            kept += 1
    if kept >= logos.MAX_LOGOS:
        raise conflict(logos.FULL)


def _forget(app: App, item: dict[str, Any]) -> None:
    """The item, then its file (a file left behind is harmless; an item without a file never is)."""
    app.store.delete(str(item["pk"]), str(item["sk"]))
    key = item.get("key")
    if isinstance(key, str) and key.startswith(f"logos/{item.get('userId')}/") and key.count("/") == 2:
        try:
            app.media.delete(key)
        except Exception as e:
            log("warning", "logo.file_delete_failed", error=type(e).__name__)


def list_logos(app: App, req: Request) -> Response:
    ready = [i for i in logos.all_items(app.store, req.user_id) if i.get("status") == "ready"]
    ready.sort(key=lambda i: (str(i.get("createdAt") or ""), str(i["logoId"])), reverse=True)
    return ok({"logos": [logos.public(i, app.media) for i in ready]})


def create(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"filename", "contentType", "size"})
    filename = validate.required_string(body, "filename", max_len=255)
    content_type = body.get("contentType")
    ext = logos.TYPES.get(content_type) if isinstance(content_type, str) else None
    size = validate.whole_number(body.get("size"))
    if ext is None or size is None or not 0 < size <= logos.MAX_BYTES:
        raise bad_request(logos.WRONG_FILE)
    _room(app, req)
    logo_id = ulid()
    key = logos.object_key(req.user_id, logo_id, ext)
    item = logos.new_item(
        req.user_id,
        logo_id,
        key,
        name=logos.display_name(filename),
        content_type=str(content_type),
        size=size,
        now=app.clock(),
    )
    app.store.put(item, if_absent=True)
    url = app.media.presign_put_sized(key, str(content_type), size, logos.PRESIGN_PUT_SECONDS)
    # ``headers`` is additive: the type is signed into the URL, so the browser must send the same one.
    return ok({"logoId": logo_id, "uploadUrl": url, "headers": {"Content-Type": content_type}}, 201)


def _item_or_404(app: App, req: Request) -> dict[str, Any]:
    item = logos.get_item(app.store, req.user_id, req.params["logoId"])
    if item is None:
        raise not_found(NO_LOGO)
    return item


def complete(app: App, req: Request) -> Response:
    """Reads the uploaded file's first bytes and size, then its width and height. Anything but a PNG, JPEG or WebP
    that matches the type it was announced as (and is under 10 MB) is deleted: 400 with one sentence."""
    validate.only_keys(req.json(), ())
    item = _item_or_404(app, req)
    if item.get("status") == "ready":
        return ok({"logo": logos.public(item, app.media)})  # safe to repeat
    key = str(item["key"])
    head = app.media.head(key)
    if head is None:
        raise bad_request(logos.WRONG_FILE)
    if int(head.get("ContentLength") or 0) > logos.MAX_BYTES:
        _forget(app, item)
        raise bad_request(logos.WRONG_FILE)
    try:
        data = app.media.read(key, logos.MAX_BYTES)
    except ValueError:
        _forget(app, item)
        raise bad_request(logos.WRONG_FILE) from None
    found = logos.check_picture(data)
    if found is None or found[0] != key.rsplit(".", 1)[-1]:
        _forget(app, item)
        raise bad_request(logos.WRONG_FILE)
    _kind, width, height = found
    try:
        saved = app.store.update(
            str(item["pk"]),
            str(item["sk"]),
            {"status": "ready", "width": width, "height": height, "size": len(data)},
            expect_in={"status": ["uploading", "ready"]},
        )
    except db.ConditionFailed:
        raise not_found(NO_LOGO) from None  # deleted meanwhile
    return ok({"logo": logos.public(saved, app.media)})


def from_campaign(app: App, req: Request) -> Response:
    """C6: copies the campaign's ready logo into the library, once (asked again, it returns the same logo)."""
    body = req.json()
    validate.only_keys(body, {"campaignId"})
    uuid = validate.required_string(body, "campaignId", max_len=64).lower()
    if not links.UUID.match(uuid):
        raise not_found(NO_CAMPAIGN)
    campaign = app.store.get(db.user_pk(req.user_id), db.campaign_sk(uuid))
    if campaign is None or campaign.get("type") != "campaign":
        raise not_found(NO_CAMPAIGN)
    logo_id = logos.campaign_logo_id(uuid)
    existing = logos.get_item(app.store, req.user_id, logo_id)
    if existing is not None and existing.get("status") == "ready":
        return ok({"logo": logos.public(existing, app.media)})
    source = campaign.get("logoKey")
    state = (campaign.get("logo") or {}).get("state") if isinstance(campaign.get("logo"), dict) else None
    prefix = campaign_logo.campaign_prefix(req.user_id, uuid)
    if state != "ready" or not isinstance(source, str) or not source.startswith(prefix):
        raise not_found(logos.NO_CAMPAIGN_LOGO)
    _room(app, req)
    try:
        data = app.media.read(source, logos.MAX_BYTES)
    except Exception as e:  # the file is gone or too big: nothing to copy
        log("warning", "logo.campaign_copy_failed", error=type(e).__name__)
        raise not_found(logos.NO_CAMPAIGN_LOGO) from None
    found = logos.check_picture(data)
    if found is None:
        raise not_found(logos.NO_CAMPAIGN_LOGO)
    kind, width, height = found
    key = logos.object_key(req.user_id, logo_id, kind)
    content_type = campaign_logo.CONTENT_TYPES[kind]
    app.media.put(key, data, content_type)
    item = logos.new_item(
        req.user_id,
        logo_id,
        key,
        name=str(campaign.get("name") or "Campaign")[: logos.NAME_MAX],
        content_type=content_type,
        size=len(data),
        now=app.clock(),
    )
    item.update(
        {
            "status": "ready",
            "width": width,
            "height": height,
            "campaignId": uuid,
            "campaignRev": campaign.get("logoRev"),
        }
    )
    if item["campaignRev"] is None:
        del item["campaignRev"]
    with contextlib.suppress(db.ConditionFailed):  # a second call at the same moment: the first one's item stands
        app.store.put(item, if_absent=True)
    saved = logos.get_item(app.store, req.user_id, logo_id) or item
    return ok({"logo": logos.public(saved, app.media)})


def delete(app: App, req: Request) -> Response:
    """The item and its file. Safe to repeat. A clip edited with it keeps its edit (the render copied the picture)."""
    item = logos.get_item(app.store, req.user_id, req.params["logoId"])
    if item is not None:
        _forget(app, item)
        log("info", "logo.deleted", logoId=item["logoId"])
    return no_content()
