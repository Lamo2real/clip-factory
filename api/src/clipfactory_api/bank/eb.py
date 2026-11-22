"""Enable Banking's setup and connect calls (docs/CONTRACTS.md §40.5.4, §40.5.5; builder BA).

* **The JWT** (shared with BR's ``bankread/client.py``): header ``{"typ": "JWT", "alg": "RS256", "kid": appId}``, body
  ``{"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now + 3600}``, base64url without
  padding, signed RSASSA-PKCS1-v1_5 with SHA-256. A new token for each call, never kept, never logged, never sent
  anywhere but ``https://api.enablebanking.com``.
* **Deadlines.** Each request has a monotonic deadline under its Lambda's limit (25 s); each call gets
  ``min(cap, remaining - 3 s)``, and a call is skipped when that is under 1 s, so nothing ever hangs.
* **Secrets are read fresh** (``Secrets.read(name, fresh=True)``): a new key, a reconnect or a Stop is seen at once.
* **Errors stay typed.** ``EbError`` carries Enable Banking's ``error`` code and the HTTP status, never the answer's
  body, so ``http.internal``'s ``detail=str(e)`` can never hold an IBAN, a name or a text.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .. import db
from ..clock import Clock, iso, utcnow
from ..log import log
from ..oauth import OAuthEnv
from ..oauth.secrets import Secrets
from ..platforms.base import HttpRequest, HttpResponse, NetworkError
from . import CHECK_TEXT, CONN_SK, EB_AUDIENCE, EB_HOST, EB_ISSUER, PLATFORM, app_secret

Item = dict[str, Any]
Transport = Callable[[HttpRequest, float], HttpResponse]
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
CALL_SECONDS = 10.0
SESSION_SECONDS = 15.0  # the callback's POST /sessions
MARGIN_SECONDS = 3.0
MIN_SECONDS = 1.0
TOKEN_SECONDS = 3600
_ERROR = re.compile(r"^[A-Z][A-Z0-9_]{1,59}$")
KEY_ERRORS = frozenset({"UNAUTHORIZED_ACCESS", "AUTHORIZATION_NOT_PROVIDED"})


class EbError(Exception):
    """Enable Banking said no, or never answered. Only its ``error`` code and the HTTP status are kept."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(f"Enable Banking answered {status} {code}")
        self.status = status
        self.code = code


class Skipped(EbError):
    """Less than a second was left for the call, so it was never made."""

    def __init__(self) -> None:
        super().__init__(0, "DEADLINE")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Enable Banking never redirects an API call. Following one would carry ``Authorization: Bearer`` (the JWT) to
    another host, even over plain http, so a 3xx comes back as itself: the check's ``down``, Connect's 503 and the
    callback's ``bank_error``."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _fetch(req: urllib.request.Request, timeout: float) -> HttpResponse:
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return HttpResponse(resp.status, _lower(resp.headers.items()), resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as e:  # 4xx, 5xx and every 3xx (never followed)
        return HttpResponse(e.code, _lower(e.headers.items() if e.headers else []), e.read(MAX_RESPONSE_BYTES))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise NetworkError(type(e).__name__) from e


def urllib_transport(request: HttpRequest, timeout: float) -> HttpResponse:
    """The production transport: Enable Banking's host only, over https, redirects never followed, and the whole call
    (connect, headers and body) inside ``timeout``. urllib's own timeout is per socket step, so an answer that
    drips in slowly could pass the route's deadline; the call runs on a worker thread that is given up on at
    ``timeout`` (it ends by itself at its next socket timeout, and its answer is never used)."""
    if not request.url.startswith(EB_HOST + "/"):
        raise NetworkError("only Enable Banking's API is called")
    req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)  # noqa: S310
    box: list[HttpResponse | BaseException] = []

    def run() -> None:
        try:
            box.append(_fetch(req, timeout))
        except BaseException as e:  # handed to the caller below
            box.append(e)

    worker = threading.Thread(target=run, name="bank-call", daemon=True)
    worker.start()
    worker.join(timeout)
    if not box:
        raise NetworkError("TimeoutError")
    found = box[0]
    if isinstance(found, BaseException):
        raise found
    return found


def _lower(items: Any) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in items}


class Deadline:
    """A monotonic deadline: ``share(cap)`` is what one call may spend (``min(cap, remaining - 3 s)``)."""

    def __init__(
        self, seconds: float, monotonic: Callable[[], float] = time.monotonic, *, margin: float = MARGIN_SECONDS
    ) -> None:
        self._now = monotonic
        self._end = monotonic() + seconds
        self._margin = margin

    def remaining(self) -> float:
        return self._end - self._now()

    def share(self, cap: float = CALL_SECONDS) -> float:
        return min(cap, self.remaining() - self._margin)

    def sub(self, seconds: float) -> Deadline:
        """A budget inside this one (closing old sessions spends at most 5 s, and never this one's margin)."""
        inner = Deadline(0, self._now, margin=0)
        inner._end = min(self._end - self._margin, self._now() + seconds)
        return inner


@dataclass
class BankEnv:
    """What the bank routes and the callback share (built from §17.4's ``OAuthEnv``)."""

    secrets: Secrets
    app_url: str
    hooks_url: str
    state_key: Callable[[], bytes]
    clock: Clock = field(default=utcnow)
    http: Transport = urllib_transport
    monotonic: Callable[[], float] = time.monotonic

    @property
    def redirect_uri(self) -> str:
        """``{HOOKS_URL}/oauth/bank/callback``: exact, the same string in the check, ``POST /auth`` and step 4."""
        return f"{self.hooks_url.rstrip('/')}/oauth/{PLATFORM}/callback"

    @property
    def app_base(self) -> str:
        return self.app_url.rstrip("/")

    def app_name(self) -> str:
        return app_secret(self.secrets.prefix)


def from_oauth(env: OAuthEnv, http: Transport | None = None, monotonic: Callable[[], float] | None = None) -> BankEnv:
    return BankEnv(
        secrets=env.secrets,
        app_url=env.app_url,
        hooks_url=env.hooks_url,
        state_key=env.state_key,
        clock=env.clock,
        http=http or urllib_transport,
        monotonic=monotonic or time.monotonic,
    )


# --- the JWT ------------------------------------------------------------------------------------------------------


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode()


def jwt(private_pem: str, app_id: str, now: datetime) -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = serialization.load_pem_private_key(private_pem.encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise EbError(0, "KEY_NOT_RSA")
    iat = int(now.timestamp())
    header = {"typ": "JWT", "alg": "RS256", "kid": app_id}
    body = {"iss": EB_ISSUER, "aud": EB_AUDIENCE, "iat": iat, "exp": iat + TOKEN_SECONDS}
    signing_input = f"{b64url(_json(header))}.{b64url(_json(body))}"
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{b64url(signature)}"


# --- the app secret -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AppKey:
    """The parts of ``cf-prod/platforms/bank/app`` a call needs. Never logged, never returned."""

    private_pem: str
    app_id: str | None


def read_app(env: BankEnv) -> Item | None:
    return env.secrets.read(env.app_name(), fresh=True)


def app_key(secret: Mapping[str, Any] | None) -> AppKey | None:
    if not secret or not isinstance(secret.get("privateKeyPem"), str) or not secret["privateKeyPem"]:
        return None
    app_id = secret.get("appId")
    return AppKey(str(secret["privateKeyPem"]), str(app_id) if isinstance(app_id, str) and app_id else None)


# --- calls --------------------------------------------------------------------------------------------------------


def error_code(resp: HttpResponse) -> str:
    """Enable Banking's ``error`` code (``"EXPIRED_AUTHORIZATION_CODE"``), or ``""``. Nothing else is read."""
    found = resp.json()
    code = found.get("error") if isinstance(found, dict) else None
    return code if isinstance(code, str) and _ERROR.match(code) else ""


def call(
    env: BankEnv,
    key: AppKey,
    method: str,
    path: str,
    deadline: Deadline,
    *,
    cap: float = CALL_SECONDS,
    body: Mapping[str, Any] | None = None,
) -> HttpResponse:
    """One call with its share of the deadline. Raises ``Skipped`` (no time left) or ``EbError`` (network)."""
    if not key.app_id:
        raise EbError(0, "NO_APP_ID")
    timeout = deadline.share(cap)
    if timeout < MIN_SECONDS:
        raise Skipped
    headers = {"Authorization": f"Bearer {jwt(key.private_pem, key.app_id, env.clock())}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = _json(body)
    try:
        return env.http(HttpRequest(method, f"{EB_HOST}{path}", headers, data), timeout)
    except NetworkError as e:
        raise EbError(0, "NETWORK") from e


def ok_json(resp: HttpResponse) -> Item:
    """The answer of a 2xx call as an object; ``EbError`` with the answer's code otherwise."""
    if not 200 <= resp.status < 300:
        raise EbError(resp.status, error_code(resp) or "HTTP")
    found = resp.json()
    if not isinstance(found, dict):
        raise EbError(resp.status, "UNREADABLE")
    return found


def delete_session(env: BankEnv, key: AppKey, session_id: str, deadline: Deadline) -> bool:
    """Best effort: True when Enable Banking closed it (or it was gone already). A failure is the count
    ``bank.close_failed``; it never raises."""
    try:
        resp = call(env, key, "DELETE", f"/sessions/{session_id}", deadline)
    except EbError as e:
        log("warning", "bank.close_failed", code=e.code, status=e.status)
        return False
    if 200 <= resp.status < 300:
        return True
    code = error_code(resp)
    if resp.status == 404 or code in {"SESSION_DOES_NOT_EXIST", "CLOSED_SESSION", "EXPIRED_SESSION", "REVOKED_SESSION"}:
        return True
    log("warning", "bank.close_failed", code=code or "HTTP", status=resp.status)
    return False


# --- the check (GET /application) ---------------------------------------------------------------------------------

_APPS: dict[str, tuple[float, tuple[str, ...]]] = {}  # appId → (when, the app's countries), one hour
_APPS_LOCK = threading.Lock()
APP_CACHE_SECONDS = 3600


@dataclass(frozen=True)
class Check:
    code: str
    at: str
    active: bool | None = None
    environment: str | None = None
    countries: tuple[str, ...] = ()

    def public(self) -> Item:
        return {"code": self.code, "text": CHECK_TEXT[self.code], "at": self.at}


def check_code(status: int, code: str, answer: Mapping[str, Any] | None, redirect_uri: str) -> str:
    """The check's code for one ``GET /application`` answer (§40.5.4's table)."""
    if code in KEY_ERRORS or status == 401:
        return "key_wrong"
    if status in {403, 404} or "APPLICATION" in code:
        return "not_found"
    if status >= 500 or status in {0, 429} or answer is None or not 200 <= status < 300:
        return "down"
    environment = str(answer.get("environment") or "").upper()
    if environment == "SANDBOX":
        return "sandbox"
    if environment != "PRODUCTION":
        return "down"  # an answer that can't be read
    urls = answer.get("redirect_urls")
    if not isinstance(urls, list) or redirect_uri not in [u for u in urls if isinstance(u, str)]:
        return "redirect_missing"
    return "ok" if answer.get("active") is True else "not_active"


def run_check(env: BankEnv, key: AppKey, deadline: Deadline) -> Check:
    """Signs a JWT and calls ``GET /application``. Never raises: a passing outage is the code ``down``."""
    at = iso(env.clock())
    try:
        resp = call(env, key, "GET", "/application", deadline)
    except EbError as e:
        log("warning", "bank.check_down", code=e.code)
        return Check("down", at)
    code = error_code(resp)
    found = resp.json() if 200 <= resp.status < 300 else None
    answer = found if isinstance(found, dict) else None
    result = check_code(resp.status, code, answer, env.redirect_uri)
    if answer is None:
        log("info", "bank.check", result=result, status=resp.status, code=code or "")
        return Check(result, at)
    raw = answer.get("countries")
    countries = (
        tuple(sorted({c.upper() for c in raw if isinstance(c, str) and len(c) == 2})) if isinstance(raw, list) else ()
    )
    if key.app_id:
        with _APPS_LOCK:
            _APPS[key.app_id] = (env.monotonic(), countries)
    active = answer.get("active") if isinstance(answer.get("active"), bool) else None
    environment = str(answer.get("environment") or "").upper() or None
    log("info", "bank.check", result=result, status=resp.status)
    return Check(result, at, active, environment, countries)


def known_countries(env: BankEnv, app_id: str) -> tuple[str, ...] | None:
    """The app's countries from a check at most an hour old in this container, or None."""
    with _APPS_LOCK:
        hit = _APPS.get(app_id)
    if hit and env.monotonic() - hit[0] < APP_CACHE_SECONDS:
        return hit[1]
    return None


def forget_cache() -> None:
    with _APPS_LOCK:
        _APPS.clear()


def store_check(store: db.Store, user_id: str, found: Check) -> None:
    """``BANKCONN.app.check {code, at}``, ``app.active`` and ``app.environment``. A ``down`` answer never replaces the
    stored check (it sets only ``app.downAt``), so a passing outage never un-ticks a step."""
    names = {"#a": "app", "#u": "updatedAt"}
    values: Item = {":u": found.at}
    if found.code == "down":
        names["#d"] = "downAt"
        values[":d"] = found.at
        expression = "SET #a.#d = :d, #u = :u"
    else:
        names.update({"#c": "check"})
        values[":c"] = {"code": found.code, "at": found.at}
        parts = ["#a.#c = :c", "#u = :u"]
        if found.active is not None:
            names["#ac"] = "active"
            values[":ac"] = found.active
            parts.append("#a.#ac = :ac")
        if found.environment is not None:
            names["#e"] = "environment"
            values[":e"] = found.environment
            parts.append("#a.#e = :e")
        expression = "SET " + ", ".join(parts)
    try:
        store.update_expr(
            db.user_pk(user_id), CONN_SK, expression, condition="attribute_exists(#a)", names=names, values=values
        )
    except db.ConditionFailed:
        log("warning", "bank.check_not_stored")  # no key yet: nothing to tick
