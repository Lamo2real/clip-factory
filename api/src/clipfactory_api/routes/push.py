"""Notifications (docs/CONTRACTS.md §32.3): the public key, the owner's devices, and "Send a test"."""

from __future__ import annotations

from datetime import timedelta

from .. import db
from ..app import App
from ..clock import iso
from ..errors import ApiError, not_found
from ..http import Request, Response, no_content, ok
from ..log import log
from ..push import devices

TEST_GAP_SECONDS = 10
NOT_READY = "Notifications are not set up yet. Try again after the next update."


def _unavailable() -> ApiError:
    return ApiError(503, "unavailable", NOT_READY)


def _key_or_503(app: App) -> str:
    if not app.push.configured:
        raise _unavailable()
    try:
        return app.push.public()
    except Exception as e:
        log("warning", "push.key_failed", error=type(e).__name__)
        raise _unavailable() from None


def get_key(app: App, req: Request) -> Response:
    return ok({"publicKey": _key_or_503(app)})


def list_devices(app: App, req: Request) -> Response:
    return ok({"devices": [devices.public_device(i) for i in devices.active(app.store, req.user_id)]})


def put_device(app: App, req: Request) -> Response:
    device_id = devices.check_device_id(req.params["deviceId"])
    sub = devices.parse(req.json())
    item = devices.save(app.store, req.user_id, device_id, sub, iso(app.clock()))
    log("info", "push.device_saved", deviceId=device_id, label=sub["deviceLabel"])
    return ok({"device": devices.public_device(item)})


def delete_device(app: App, req: Request) -> Response:
    device_id = devices.check_device_id(req.params["deviceId"])
    app.store.delete(db.user_pk(req.user_id), devices.sub_sk(device_id))
    log("info", "push.device_removed", deviceId=device_id)
    return no_content()


def send_test(app: App, req: Request) -> Response:
    """Sends "Notifications are on 🎉" to one device (``deviceId``) or every device; at most once every 10 s."""
    body = req.json()
    device_id = body.get("deviceId")
    _key_or_503(app)
    subs = devices.active(app.store, req.user_id)
    if device_id is not None:
        subs = [s for s in subs if s.get("deviceId") == devices.check_device_id(str(device_id))]
    if not subs:
        raise not_found("Turn on notifications on this device first.")
    now = app.clock()
    try:
        app.store.update_expr(
            db.user_pk(req.user_id),
            "PUSHTEST",
            "SET #at = :now, #type = :type, #ttl = :ttl",
            condition="attribute_not_exists(pk) OR #at <= :cutoff",
            names={"#at": "at", "#type": "type", "#ttl": "ttl"},
            values={
                ":now": iso(now),
                ":cutoff": iso(now - timedelta(seconds=TEST_GAP_SECONDS)),
                ":type": "pushtest",
                ":ttl": int((now + timedelta(days=1)).timestamp()),
            },
        )
    except db.ConditionFailed:
        raise ApiError(
            429, "rate_limited", "Wait a few seconds, then try again.", headers={"Retry-After": "10"}
        ) from None
    from ..push.notify import TEST_BODY, TEST_TITLE, NotifyDeps, send_to_devices
    from ..push.webpush import Message

    deps = NotifyDeps(store=app.store, key=app.push, deserialize=dict, post=app.push_post, clock=app.clock)
    message = Message(TEST_TITLE, TEST_BODY, "test", "/settings/app/notifications", ttl=600, urgency="high")
    delivered = send_to_devices(deps, req.user_id, message, subs)
    return ok({"sent": delivered, "devices": len(subs)})
