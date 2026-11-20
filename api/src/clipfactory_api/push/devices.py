"""The owner's devices that get notifications (docs/CONTRACTS.md §32.3): ``PUSHSUB#<deviceId>`` items.

A subscription's endpoint and keys are kept only here and are never sent back to the web, logged or broadcast
(``PUSHSUB#`` is not a broadcast prefix, §14.2). Only push services on the allow-list are accepted, so a saved
"subscription" can never make Clip Factory post to any other address.
"""

from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from .. import db, validate
from ..errors import bad_request
from .transport import unb64u

if TYPE_CHECKING:  # cryptography loads only when a key is used, never on other routes' cold starts
    from cryptography.hazmat.primitives.asymmetric import ec

    from . import webpush

Item = dict[str, Any]

PREFIX = "PUSHSUB#"
DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_DEVICES = 20
MAX_ENDPOINT = 1024
# The push services of Safari (iPhone, iPad, Mac), Chrome and Android, Firefox, and Edge on Windows.
EXACT_HOSTS = frozenset({"web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"})
SUFFIX_HOSTS = (".notify.windows.com",)
LABELS = ("iPhone", "iPad", "Mac", "Windows", "Android", "Linux", "Chromebook", "This device")
PUBLIC_FIELDS = ("deviceId", "kind", "deviceLabel", "createdAt", "updatedAt")
GONE_TTL_SECONDS = 24 * 3600  # a subscription the push service says is gone is removed by the table's TTL


def sub_sk(device_id: str) -> str:
    return f"{PREFIX}{device_id}"


def allowed_endpoint(endpoint: str) -> bool:
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or port not in {None, 443}:
        return False
    return host in EXACT_HOSTS or any(host.endswith(s) and len(host) > len(s) for s in SUFFIX_HOSTS)


def check_device_id(device_id: str) -> str:
    if not DEVICE_ID.match(device_id):
        raise bad_request("That device id is not valid.")
    return device_id


def _key(value: Any, name: str, size: int) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", value or ""):
        raise bad_request(f"The {name} key is not valid.")
    try:
        raw = unb64u(value.rstrip("="))
    except ValueError as e:
        raise bad_request(f"The {name} key is not valid.") from e
    if len(raw) != size or (name == "p256dh" and raw[0] != 4):
        raise bad_request(f"The {name} key is not valid.")
    return value.rstrip("=")


def parse(body: Mapping[str, Any]) -> Item:
    """``{endpoint, keys: {p256dh, auth}, deviceLabel?}`` from ``PushSubscription.toJSON()`` plus a label."""
    validate.only_keys(body, {"endpoint", "keys", "deviceLabel", "expirationTime"})
    endpoint = validate.required_string(body, "endpoint", max_len=MAX_ENDPOINT)
    if not allowed_endpoint(endpoint):
        raise bad_request("Notifications only work with Safari, Chrome, Edge or Firefox.")
    keys = body.get("keys")
    if not isinstance(keys, dict):
        raise bad_request("The subscription keys are missing.")
    label = body.get("deviceLabel") or "This device"
    if label not in LABELS:
        raise bad_request("Unknown device name.")
    return {
        "endpoint": endpoint,
        "p256dh": _key(keys.get("p256dh"), "p256dh", 65),
        "auth": _key(keys.get("auth"), "auth", 16),
        "deviceLabel": label,
    }


def public_device(item: Mapping[str, Any]) -> Item:
    return {k: item[k] for k in PUBLIC_FIELDS if k in item}


def active(store: db.Store, user_id: str) -> list[Item]:
    return [
        i
        for i in store.query_all(db.user_pk(user_id), PREFIX)
        if i.get("type") == "pushsub" and not i.get("gone") and i.get("endpoint")
    ]


def save(store: db.Store, user_id: str, device_id: str, sub: Item, now: str) -> Item:
    """Idempotent: the same device saved again keeps its ``createdAt``; a new endpoint replaces the old one."""
    pk = db.user_pk(user_id)
    existing = store.get(pk, sub_sk(device_id))
    if existing is None and len(active(store, user_id)) >= MAX_DEVICES:
        raise bad_request(f"Notifications are on for {MAX_DEVICES} devices already. Turn one off first.")
    item = {
        "pk": pk,
        "sk": sub_sk(device_id),
        "type": "pushsub",
        "userId": user_id,
        "deviceId": device_id,
        "kind": "webpush",
        **sub,
        "createdAt": (existing or {}).get("createdAt") or now,
        "updatedAt": now,
    }
    store.put(item)  # a whole new item: any earlier "gone" mark goes with the old one
    return item


def subscription(item: Mapping[str, Any]) -> webpush.Subscription:
    from . import webpush

    return webpush.Subscription(str(item["endpoint"]), str(item["p256dh"]), str(item["auth"]))


@dataclass
class VapidKey:
    """The VAPID private key, read from Secrets Manager once per warm Lambda. ``ready`` is False until it exists."""

    secrets: Any = None
    secret_name: str = ""
    subject: str = ""
    _key: ec.EllipticCurvePrivateKey | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.secrets is not None and self.secret_name and self.subject)

    def private(self) -> ec.EllipticCurvePrivateKey:
        with self._lock:
            if self._key is None:
                if not self.configured:
                    raise LookupError("notifications are not set up")
                from . import webpush

                pem = self.secrets.get_secret_value(SecretId=self.secret_name)["SecretString"]
                self._key = webpush.load_private_key(pem)
            return self._key

    def public(self) -> str:
        from . import webpush

        return webpush.public_key_b64(self.private())
