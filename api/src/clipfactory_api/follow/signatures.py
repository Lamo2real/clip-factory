"""Webhook signatures for Twitch EventSub and Kick (docs/CONTRACTS.md §24.4). Standard library only.

* Twitch: ``Twitch-Eventsub-Message-Signature`` is ``sha256=`` + hex HMAC-SHA256 of message id + timestamp + raw body,
  keyed with the EventSub secret Clip Factory made when the Twitch keys were saved. Compared in constant time.
* Kick: ``Kick-Event-Signature`` is base64 RSASSA-PKCS1-v1_5 with SHA-256 over ``{message id}.{timestamp}.{raw body}``,
  checked against Kick's public key (``GET https://api.kick.com/public/v1/public-key``).

Both reject a delivery whose timestamp is more than 10 minutes away from now (replays).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
from datetime import datetime, timedelta

MAX_AGE = timedelta(minutes=10)
# DigestInfo for SHA-256 (RFC 8017 §9.2, note 1).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_RSA_OID = bytes.fromhex("2a864886f70d010101")
_FRACTION = re.compile(r"(\.\d{6})\d+")


def parse_time(value: str | None) -> datetime | None:
    """An RFC 3339 time (Twitch sends nanoseconds; Python reads at most microseconds)."""
    if not value or len(value) > 64:
        return None
    text = _FRACTION.sub(r"\1", value.strip()).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def fresh(timestamp: str | None, now: datetime) -> bool:
    sent = parse_time(timestamp)
    return sent is not None and abs(now - sent) <= MAX_AGE


# --- Twitch ----------------------------------------------------------------------------------------------------------


def twitch_signature(secret: str, message_id: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), message_id.encode() + timestamp.encode() + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def twitch_valid(secret: str, message_id: str, timestamp: str, body: bytes, *, signature: str, now: datetime) -> bool:
    if not (secret and message_id and timestamp and signature) or not fresh(timestamp, now):
        return False
    expected = twitch_signature(secret, message_id, timestamp, body)
    return hmac.compare_digest(expected.encode(), signature.strip().encode())


# --- Kick (RSA) ------------------------------------------------------------------------------------------------------


class PublicKeyError(ValueError):
    """The public key could not be read."""


def _der(data: bytes, pos: int) -> tuple[int, int, int]:
    """(tag, start of value, end of value) of the DER element at ``pos``."""
    if pos + 2 > len(data):
        raise PublicKeyError("short")
    tag = data[pos]
    length = data[pos + 1]
    pos += 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or count > 4 or pos + count > len(data):
            raise PublicKeyError("bad length")
        length = int.from_bytes(data[pos : pos + count], "big")
        pos += count
    if pos + length > len(data):
        raise PublicKeyError("truncated")
    return tag, pos, pos + length


def _rsa_numbers(seq: bytes) -> tuple[int, int]:
    """``RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }``."""
    tag, start, end = _der(seq, 0)
    if tag != 0x30:
        raise PublicKeyError("not a sequence")
    tag, n_start, n_end = _der(seq, start)
    if tag != 0x02:
        raise PublicKeyError("no modulus")
    tag, e_start, e_end = _der(seq, n_end)
    if tag != 0x02 or e_end > end:
        raise PublicKeyError("no exponent")
    return int.from_bytes(seq[n_start:n_end], "big"), int.from_bytes(seq[e_start:e_end], "big")


def load_public_key(pem: str) -> tuple[int, int]:
    """(n, e) from a PEM ``PUBLIC KEY`` (SubjectPublicKeyInfo) or ``RSA PUBLIC KEY`` (PKCS #1)."""
    lines = [line.strip() for line in pem.strip().splitlines() if line.strip()]
    if len(lines) < 3 or not lines[0].startswith("-----BEGIN") or not lines[-1].startswith("-----END"):
        raise PublicKeyError("not PEM")
    try:
        der = base64.b64decode("".join(lines[1:-1]), validate=True)
    except (ValueError, binascii.Error) as e:
        raise PublicKeyError("not base64") from e
    if "RSA PUBLIC KEY" in lines[0]:
        n, exp = _rsa_numbers(der)
    else:
        tag, start, _end = _der(der, 0)
        if tag != 0x30:
            raise PublicKeyError("not a sequence")
        tag, alg_start, alg_end = _der(der, start)
        if tag != 0x30:
            raise PublicKeyError("no algorithm")
        tag, oid_start, oid_end = _der(der, alg_start)
        if tag != 0x06 or der[oid_start:oid_end] != _RSA_OID:
            raise PublicKeyError("not RSA")
        tag, bits_start, bits_end = _der(der, alg_end)
        if tag != 0x03 or der[bits_start] != 0:
            raise PublicKeyError("no key bits")
        n, exp = _rsa_numbers(der[bits_start + 1 : bits_end])
    if n.bit_length() < 1024 or exp < 3:
        raise PublicKeyError("weak key")
    return n, exp


def rsa_sha256_valid(key: tuple[int, int], message: bytes, signature: bytes) -> bool:
    """RSASSA-PKCS1-v1_5 verification with SHA-256 (RFC 8017 §8.2.2)."""
    n, e = key
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = _SHA256_PREFIX + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def kick_valid(
    key: tuple[int, int], message_id: str, timestamp: str, body: bytes, *, signature: str, now: datetime
) -> bool:
    if not (message_id and timestamp and signature) or not fresh(timestamp, now):
        return False
    try:
        raw = base64.b64decode(signature.strip(), validate=True)
    except (ValueError, binascii.Error):
        return False
    return rsa_sha256_valid(key, f"{message_id}.{timestamp}.".encode() + body, raw)
