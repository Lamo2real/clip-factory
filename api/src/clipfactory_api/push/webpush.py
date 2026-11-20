"""One Web Push message: VAPID (RFC 8292) and aes128gcm encryption (RFC 8291, RFC 8188), docs/CONTRACTS.md §32.4.

The VAPID private key lives only in Secrets Manager (``cf-prod/notify/vapid``, written by Terraform from an ephemeral
key, so it is never in a plan, the state or a log). The public key the browser needs is worked out from it here.
Nothing in this module logs; callers log only status codes and ids.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .transport import Poster, b64u, unb64u, urllib_post

RECORD_SIZE = 4096
# The plain text must fit one record with its delimiter (1 byte) and the AES-GCM tag (16 bytes).
MAX_PAYLOAD = RECORD_SIZE - 17
JWT_HOURS = 12  # push services refuse a VAPID token that lives longer than 24 h
SEND_TIMEOUT = 10.0

__all__ = ["Poster", "b64u", "unb64u", "urllib_post"]


def load_private_key(pem: str) -> ec.EllipticCurvePrivateKey:
    """The VAPID key from its PEM (SEC 1 or PKCS #8). Anything but a P-256 key is refused."""
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("the VAPID key must be an EC P-256 private key")
    return key


def raw_public(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def public_key_b64(key: ec.EllipticCurvePrivateKey) -> str:
    """The application server key the browser passes to ``pushManager.subscribe`` (65 bytes, base64url)."""
    return b64u(raw_public(key.public_key()))


def vapid_authorization(key: ec.EllipticCurvePrivateKey, endpoint: str, subject: str, now: float) -> str:
    """``vapid t=<ES256 JWT>, k=<public key>`` for one push service (its origin is the audience)."""
    parts = urlsplit(endpoint)
    header = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = {"aud": f"{parts.scheme}://{parts.netloc}", "exp": int(now) + JWT_HOURS * 3600, "sub": subject}
    body = b64u(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode("ascii")
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return f"vapid t={header}.{body}.{b64u(signature)}, k={public_key_b64(key)}"


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def encrypt(
    payload: bytes,
    p256dh: str,
    auth: str,
    *,
    salt: bytes | None = None,
    sender_key: ec.EllipticCurvePrivateKey | None = None,
) -> bytes:
    """The aes128gcm body for one subscription: a fresh sender key and salt per message (tests may fix both)."""
    if len(payload) > MAX_PAYLOAD:
        raise ValueError("the notification is too large")
    ua_public = unb64u(p256dh)
    auth_secret = unb64u(auth)
    if len(ua_public) != 65 or ua_public[0] != 4 or len(auth_secret) != 16:
        raise ValueError("the subscription keys are not valid")
    salt = salt if salt is not None else os.urandom(16)
    sender_key = sender_key or ec.generate_private_key(ec.SECP256R1())
    as_public = raw_public(sender_key.public_key())
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    shared = sender_key.exchange(ec.ECDH(), ua_key)
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)  # 0x02: the last (and only) record
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


@dataclass(frozen=True)
class Subscription:
    endpoint: str
    p256dh: str
    auth: str


@dataclass(frozen=True)
class Message:
    """What the service worker shows (``web/sw/sw.js``): never a link outside the app, never a secret."""

    title: str
    body: str
    tag: str
    url: str
    ttl: int = 3600
    urgency: str = "normal"  # "very-low" | "low" | "normal" | "high"
    topic: str | None = None  # a later message with the same topic replaces one not delivered yet
    quiet: bool = False  # a progress card: replaces the last one without a sound or buzz (where the device allows)
    badge: int | None = None  # how many jobs are working: the number on the app icon

    def payload(self) -> bytes:
        data: dict[str, object] = {"title": self.title, "body": self.body, "tag": self.tag, "url": self.url}
        if self.quiet:
            data["quiet"] = True
        if self.badge is not None:
            data["badge"] = self.badge
        return json.dumps(data, ensure_ascii=False).encode()


def send(
    sub: Subscription,
    message: Message,
    key: ec.EllipticCurvePrivateKey,
    subject: str,
    *,
    post: Poster = urllib_post,
    now: Callable[[], float] = time.time,
) -> int:
    """Encrypts and posts one message; returns the push service's status (201 is delivered to the service)."""
    headers = {
        "Authorization": vapid_authorization(key, sub.endpoint, subject, now()),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(message.ttl),
        "Urgency": message.urgency,
    }
    if message.topic:
        headers["Topic"] = message.topic
    return post(sub.endpoint, headers, encrypt(message.payload(), sub.p256dh, sub.auth), SEND_TIMEOUT)
