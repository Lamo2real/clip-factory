"""``cf-prod-ws-authorizer``: the WebSocket ``$connect`` REQUEST authorizer (docs/CONTRACTS.md §3, §14.2).

The web connects with the owner's Cognito **access** token in the query string (``?token=``). This checks it with
the standard library only: RS256 against the user pool's JWKS (fetched over HTTPS, cached for an hour; an unknown
``kid`` triggers one refetch), then ``iss``, ``token_use == "access"``, ``client_id``, ``exp`` (no leeway) and
``sub``. Valid tokens are cached per container until they expire, keyed by their SHA-256.

The token and the raw query string are never logged. A missing or invalid token raises ``Exception("Unauthorized")``,
which API Gateway answers with 401.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..log import log

JWKS_TTL_SECONDS = 3600
MAX_TOKEN_CHARS = 8192
MAX_CACHED_TOKENS = 256
# DER prefix of DigestInfo for SHA-256 (RFC 8017, section 9.2, note 1).
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class Unauthorized(Exception):
    """The token is missing or not valid."""


@dataclass(frozen=True)
class RsaKey:
    n: int
    e: int


def b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _b64_int(value: str) -> int:
    return int.from_bytes(b64url_decode(value), "big")


def parse_jwks(document: Mapping[str, Any]) -> dict[str, RsaKey]:
    keys: dict[str, RsaKey] = {}
    for jwk in document.get("keys", []):
        if not isinstance(jwk, Mapping) or jwk.get("kty") != "RSA" or not isinstance(jwk.get("kid"), str):
            continue
        if jwk.get("use", "sig") != "sig":
            continue
        try:
            keys[jwk["kid"]] = RsaKey(_b64_int(str(jwk["n"])), _b64_int(str(jwk["e"])))
        except (KeyError, ValueError, binascii.Error):
            continue
    return keys


def rs256_valid(key: RsaKey, signing_input: bytes, signature: bytes) -> bool:
    """RSASSA-PKCS1-v1_5 with SHA-256: ``sig^e mod n`` must equal ``00 01 FF..FF 00 || DigestInfo || hash``."""
    k = (key.n.bit_length() + 7) // 8
    if len(signature) != k or k < 256:  # Cognito keys are 2048-bit; anything smaller is refused
        return False
    s = int.from_bytes(signature, "big")
    if s >= key.n:
        return False
    em = pow(s, key.e, key.n).to_bytes(k, "big")
    t = SHA256_DIGEST_INFO + hashlib.sha256(signing_input).digest()
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def _fetch_json(url: str) -> dict[str, Any]:
    if not url.startswith("https://"):
        raise ValueError("JWKS must be fetched over HTTPS")
    with urllib.request.urlopen(url, timeout=3) as response:  # noqa: S310 - fixed https Cognito URL
        data: dict[str, Any] = json.loads(response.read(512 * 1024))
    return data


@dataclass
class Verifier:
    region: str
    user_pool_id: str
    client_id: str
    fetch: Callable[[str], dict[str, Any]] = field(default=_fetch_json)
    now: Callable[[], float] = field(default=time.time)
    _keys: dict[str, RsaKey] = field(default_factory=dict, repr=False)
    _keys_at: float = field(default=-1.0, repr=False)
    _valid: dict[str, tuple[str, float]] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def issuer(self) -> str:
        return f"https://cognito-idp.{self.region}.amazonaws.com/{self.user_pool_id}"

    @property
    def jwks_url(self) -> str:
        return f"{self.issuer}/.well-known/jwks.json"

    def _key(self, kid: str) -> RsaKey | None:
        with self._lock:
            fresh = self._keys_at >= 0 and self.now() - self._keys_at < JWKS_TTL_SECONDS
            if fresh and kid in self._keys:
                return self._keys[kid]
            # Expired cache, or a kid we do not know (Cognito rotated its keys): fetch once.
            self._keys = parse_jwks(self.fetch(self.jwks_url))
            self._keys_at = self.now()
            return self._keys.get(kid)

    def verify(self, token: str) -> str:
        """Returns the token's ``sub`` or raises ``Unauthorized``."""
        if not token or len(token) > MAX_TOKEN_CHARS:
            raise Unauthorized("missing token")
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = self.now()
        with self._lock:
            cached = self._valid.get(digest)
        if cached and cached[1] > now:
            return cached[0]
        try:
            header_b64, payload_b64, signature_b64 = token.split(".")
            header = json.loads(b64url_decode(header_b64))
            claims = json.loads(b64url_decode(payload_b64))
            signature = b64url_decode(signature_b64)
        except (ValueError, binascii.Error, UnicodeDecodeError) as e:
            raise Unauthorized("malformed token") from e
        if not isinstance(header, dict) or not isinstance(claims, dict):
            raise Unauthorized("malformed token")
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise Unauthorized("unsupported token")
        key = self._key(header["kid"])
        if key is None:
            raise Unauthorized("unknown key")
        if not rs256_valid(key, f"{header_b64}.{payload_b64}".encode("ascii"), signature):
            raise Unauthorized("bad signature")
        exp = claims.get("exp")
        sub = claims.get("sub")
        if claims.get("iss") != self.issuer:
            raise Unauthorized("wrong issuer")
        if claims.get("token_use") != "access":
            raise Unauthorized("not an access token")
        if claims.get("client_id") != self.client_id:
            raise Unauthorized("wrong client")
        if not isinstance(exp, int | float) or isinstance(exp, bool) or exp <= now:
            raise Unauthorized("expired")
        if not isinstance(sub, str) or not sub:
            raise Unauthorized("no subject")
        with self._lock:
            if len(self._valid) >= MAX_CACHED_TOKENS:
                self._valid = {k: v for k, v in self._valid.items() if v[1] > now}
                if len(self._valid) >= MAX_CACHED_TOKENS:
                    self._valid.clear()
            self._valid[digest] = (sub, float(exp))
        return sub


def policy(sub: str, method_arn: str) -> dict[str, Any]:
    return {
        "principalId": sub,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [{"Action": "execute-api:Invoke", "Effect": "Allow", "Resource": method_arn}],
        },
        "context": {"sub": sub},
    }


def authorize(event: Mapping[str, Any], verifier: Verifier) -> dict[str, Any]:
    query = event.get("queryStringParameters") or {}
    token = query.get("token") if isinstance(query, Mapping) else None
    method_arn = str(event.get("methodArn") or "")
    request_id = str((event.get("requestContext") or {}).get("requestId") or "")
    if not isinstance(token, str) or not method_arn:
        log("info", "ws_auth.denied", reason="missing", requestId=request_id)
        raise Exception("Unauthorized")
    try:
        sub = verifier.verify(token)
    except Unauthorized as e:
        log("info", "ws_auth.denied", reason=str(e), requestId=request_id)
        raise Exception("Unauthorized") from None
    except Exception as e:  # JWKS unreachable and the like: deny, never let a token through
        log("error", "ws_auth.error", error=type(e).__name__, requestId=request_id)
        raise Exception("Unauthorized") from None
    log("info", "ws_auth.allowed", requestId=request_id)
    return policy(sub, method_arn)


_verifier: Verifier | None = None


def _get_verifier() -> Verifier:
    global _verifier
    if _verifier is None:
        env = os.environ
        region = env.get("AWS_REGION") or env.get("AWS_DEFAULT_REGION") or "eu-north-1"
        _verifier = Verifier(region, env["USER_POOL_ID"], env["USER_POOL_CLIENT_ID"])
    return _verifier


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    return authorize(event, _get_verifier())
