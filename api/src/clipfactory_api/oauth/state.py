"""The OAuth ``state``: signed, bound to one platform, expiring, single use (docs/CONTRACTS.md §17.4).

``state = "v1." + nonce + "." + exp + "." + b64url(HMAC_SHA256(key, "v1|" + platform + "|" + nonce + "|" + exp))``.
The nonce is 16 random bytes (b64url, 22 characters); ``exp`` is epoch seconds. Single use is enforced by the
callback, which deletes the ``OAUTH#{nonce}`` item with a condition. The PKCE verifier is derived from the nonce
with the same key, so it is never stored: ``verifier = b64url(HMAC_SHA256(key, "pkce|" + nonce))`` (43 characters)
and ``code_challenge = b64url(SHA256(verifier))`` (method S256).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

VERSION = "v1"
_NONCE = re.compile(r"^[A-Za-z0-9_-]{22}$")
_SIG = re.compile(r"^[A-Za-z0-9_-]{43}$")
_EXP = re.compile(r"^[0-9]{9,11}$")
MAX_STATE_CHARS = 200


class StateError(Exception):
    """The state is malformed, forged, for another platform or expired."""


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def new_nonce() -> str:
    return b64url(secrets.token_bytes(16))


def _mac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode(), hashlib.sha256).digest()


def sign(key: bytes, platform: str, nonce: str, exp: int) -> str:
    if not key:
        raise ValueError("the state key is empty")
    signature = b64url(_mac(key, f"{VERSION}|{platform}|{nonce}|{exp}"))
    return f"{VERSION}.{nonce}.{exp}.{signature}"


def verify(key: bytes, platform: str, state: str, now: int) -> str:
    """The nonce of a valid state; ``StateError`` otherwise. The signature is compared in constant time."""
    if not key or not isinstance(state, str) or len(state) > MAX_STATE_CHARS:
        raise StateError("bad state")
    parts = state.split(".")
    if len(parts) != 4 or parts[0] != VERSION:
        raise StateError("bad state")
    _, nonce, exp_text, signature = parts
    if not (_NONCE.match(nonce) and _EXP.match(exp_text) and _SIG.match(signature)):
        raise StateError("bad state")
    expected = b64url(_mac(key, f"{VERSION}|{platform}|{nonce}|{exp_text}"))
    if not hmac.compare_digest(expected.encode(), signature.encode()):
        raise StateError("bad signature")
    if int(exp_text) <= now:
        raise StateError("expired")
    return nonce


def pkce(key: bytes, nonce: str) -> tuple[str, str]:
    """``(verifier, challenge)`` for S256."""
    verifier = b64url(_mac(key, f"pkce|{nonce}"))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge
