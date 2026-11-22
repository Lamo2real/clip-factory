"""Enable Banking, the reading side (docs/CONTRACTS.md §40.5.4 "The JWT", §40.5.6).

* **The JWT** (a shared contract with ``bank/eb.py``): header ``{"typ": "JWT", "alg": "RS256", "kid": appId}``, body
  ``{"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": now + 3600}``, base64url without
  padding, signed RSASSA-PKCS1-v1_5 with SHA-256. A new token for each run, never kept or logged, only ever sent to
  ``https://api.enablebanking.com``.
* **Calls**: ``GET /sessions/{id}`` and ``GET /accounts/{uid}/transactions``, each with ``Authorization: Bearer …``
  and ``Accept: application/json``.
* **Errors stay typed**: ``BankError`` carries Enable Banking's ``error`` code, the HTTP status and ``Retry-After``,
  never the answer's body, so nothing a bank sends (an IBAN, a name, a text) can reach a log line.
* **The PSU headers**: all or none. A read is attended only when ``psu`` is given, the bank's ``psuHeaders`` list isn't
  empty and every header on it can be filled.
* **The rolling 24 hours** of unattended reads (PSD2 RTS Art. 36(5)(b)): at most 3 in any 24 hours, so one of the
  bank's 4 is always left over; an unattended ``strategy=longest`` pass counts twice.
* **Its own HTTP** (``no_redirects``): only ``https://api.enablebanking.com/…``, and a redirect is never followed, so
  the token and the PSU headers can never be sent to another host (urllib's own redirects copy every header).
"""

from __future__ import annotations

import base64
import http.client
import json
import re
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

from ..clock import iso, parse
from ..platforms.base import (
    HTTP_TIMEOUT_SECONDS,
    MAX_RESPONSE_BYTES,
    HttpClient,
    HttpRequest,
    HttpResponse,
    NetworkError,
)

API = "https://api.enablebanking.com"
JWT_SECONDS = 3600
ISSUER = "enablebanking.com"
AUDIENCE = "api.enablebanking.com"

# --- the JWT ----------------------------------------------------------------------------------------------------


def b64url(data: bytes) -> str:
    """base64url without padding (RFC 7515 §2): the padding is only ever at the end, so it is cut there."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _compact(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=False).encode()


def jwt(app_id: str, private_key_pem: str, now: datetime) -> str:
    """The signed token for one run. Raises ``ValueError`` for a key that isn't an RSA private key."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("the bank key is not an RSA key")
    iat = int(now.timestamp())
    header = {"typ": "JWT", "alg": "RS256", "kid": app_id}
    body = {"iss": ISSUER, "aud": AUDIENCE, "iat": iat, "exp": iat + JWT_SECONDS}
    signing_input = f"{b64url(_compact(header))}.{b64url(_compact(body))}"
    signature = key.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{b64url(signature)}"


# --- errors -----------------------------------------------------------------------------------------------------

NETWORK = "NETWORK"  # no HTTP answer at all
UNREADABLE = "UNREADABLE"  # an answer that can't be read
_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")


class BankError(Exception):
    """Enable Banking said no. Only its ``error`` code, the HTTP status and ``Retry-After`` are kept."""

    def __init__(self, code: str, status: int = 0, retry_after: int | None = None) -> None:
        super().__init__(f"{code or 'HTTP'} {status}")
        self.code = code
        self.status = status
        self.retry_after = retry_after


def _error_code(response: HttpResponse) -> str:
    body = response.json()
    code = body.get("error") if isinstance(body, dict) else None
    return code if isinstance(code, str) and _CODE.fullmatch(code) else ""


def _retry_after(response: HttpResponse) -> int | None:
    raw = next((v for k, v in (response.headers or {}).items() if str(k).lower() == "retry-after"), None)
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


# What each answer means for the link (§40.5.6 "Ends and errors"), decided by Enable Banking's error code.
END_EXPIRED = "end_expired"  # status "ended", reason consent_over or ended_early
END_REVOKED = "end_revoked"  # status "stopped_at_bank"
END_CLOSED = "end_closed"  # status "ended", reason ended_early
PSU_ACTION = "psu_action"  # stays connected, reason psu_action
ASPSP_LIMIT = "aspsp_limit"  # limitUntil = now + 6 h
EB_LIMIT = "eb_limit"  # Enable Banking's own 429: limitUntil = now + max(Retry-After, 1 h)
PSU_HEADER = "psu_header"  # one more try unattended
ACCOUNT = "account"  # that account is skipped this run
PERIOD = "period"  # one more try with strategy=default from today - 89 days
KEY = "key"  # BANKCONN.app.check becomes key_wrong
CONTINUATION = "continuation"  # a resume's key: restart that account with default from today - 89 days
DOWN = "down"  # everything else: "{bank} didn't answer."

CODES: dict[str, str] = {
    "EXPIRED_SESSION": END_EXPIRED,
    "REVOKED_SESSION": END_REVOKED,
    "CLOSED_SESSION": END_CLOSED,
    "SESSION_DOES_NOT_EXIST": END_CLOSED,
    "ACCESS_DENIED": END_CLOSED,
    "WRONG_SESSION_STATUS": END_CLOSED,
    "ASPSP_PSU_ACTION_REQUIRED": PSU_ACTION,
    "ASPSP_RATE_LIMIT_EXCEEDED": ASPSP_LIMIT,
    "PSU_HEADER_NOT_PROVIDED": PSU_HEADER,
    "PSU_HEADER_INVALID": PSU_HEADER,
    "ACCOUNT_DOES_NOT_EXIST": ACCOUNT,
    "ASPSP_ACCOUNT_NOT_ACCESSIBLE": ACCOUNT,
    "INVALID_ACCOUNT_ID": ACCOUNT,
    "WRONG_TRANSACTIONS_PERIOD": PERIOD,
    "DATE_FROM_IN_FUTURE": PERIOD,
    "WRONG_DATE_INTERVAL": PERIOD,
    "UNAUTHORIZED_ACCESS": KEY,
    "AUTHORIZATION_NOT_PROVIDED": KEY,
    "WRONG_CONTINUATION_KEY": CONTINUATION,
    "ASPSP_ERROR": DOWN,
    "ASPSP_TIMEOUT": DOWN,
    "UNAUTHORIZED_IP": DOWN,
}
# A session's own status, other than AUTHORIZED (any other one ends the link too, as ended_early).
SESSION_STATUSES = {"EXPIRED": END_EXPIRED, "REVOKED": END_REVOKED}
ENDS = frozenset({END_EXPIRED, END_REVOKED, END_CLOSED})


def outcome(error: BankError) -> str:
    """What an error means (§40.5.6): by the code; a 429 is Enable Banking's own (``EB_LIMIT``, at least an hour's
    wait) unless its code is the bank's ``ASPSP_RATE_LIMIT_EXCEEDED`` or ends the session; any other code,
    ``WRONG_REQUEST_PARAMETERS`` included, and an unreadable answer or no answer at all, is ``DOWN``."""
    found = CODES.get(error.code)
    if error.status == 429 and found not in (ASPSP_LIMIT, *ENDS):
        return EB_LIMIT
    return found if found is not None else DOWN


def session_outcome(session: Mapping[str, Any]) -> str | None:
    """None while the session is ``AUTHORIZED``; else how it ends the link. A session without a status can't be read."""
    status = session.get("status")
    if not isinstance(status, str) or not status:
        raise BankError(UNREADABLE, 200)
    if status == "AUTHORIZED":
        return None
    return SESSION_STATUSES.get(status, END_CLOSED)


def session_accounts(session: Mapping[str, Any]) -> list[str]:
    """The account uids the session can read (``accounts``: uids, or objects with ``uid``)."""
    out: list[str] = []
    for entry in session.get("accounts") or []:
        uid = entry.get("uid") if isinstance(entry, Mapping) else entry
        if isinstance(uid, str) and uid and uid not in out:
            out.append(uid)
    return out


# --- the calls ----------------------------------------------------------------------------------------------------


class Client:
    """One run's calls. The token is made once for the run and lives only in this object."""

    def __init__(self, http: HttpClient, token: str) -> None:
        self._http = http
        self._token = token
        self.calls = 0

    def _get(self, path: str, params: Mapping[str, str] | None = None, extra: Mapping[str, str] | None = None) -> Any:
        url = f"{API}{path}"
        if params:
            url += "?" + urlencode(list(params.items()))
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json", **(extra or {})}
        self.calls += 1
        try:
            response = self._http(HttpRequest("GET", url, headers))
        except (NetworkError, http.client.HTTPException, OSError, ValueError):
            # No whole answer (a broken connection, a cut-off body): typed, and never chained, so nothing of a
            # half-read answer can reach a log line.
            raise BankError(NETWORK, 0) from None
        if 300 <= response.status < 400:
            raise BankError(UNREADABLE, response.status)  # a redirect is never followed (``no_redirects``)
        if not 200 <= response.status < 300:
            raise BankError(_error_code(response), response.status, _retry_after(response))
        body = response.json()
        if not isinstance(body, dict):
            raise BankError(UNREADABLE, response.status)
        return body

    def session(self, session_id: str) -> dict[str, Any]:
        found: dict[str, Any] = self._get(f"/sessions/{quote(session_id, safe='')}")
        return found

    def transactions(
        self, uid: str, params: Mapping[str, str], headers: Mapping[str, str] | None = None
    ) -> tuple[list[Any], str | None]:
        """One page: ``(transactions, continuation_key)``. Every page of a read uses the same parameters."""
        body = self._get(f"/accounts/{quote(uid, safe='')}/transactions", params, headers)
        rows = body.get("transactions")
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise BankError(UNREADABLE, 200)
        key = body.get("continuation_key")
        return rows, key if isinstance(key, str) and key else None


# --- its own HTTP: Enable Banking only, never a redirect ----------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 3xx comes back as itself (an ``HTTPError``) instead of being followed with the same headers."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def opener(*handlers: Any) -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect, *handlers)


_OPENER = opener()


def no_redirects(request: HttpRequest, *, via: urllib.request.OpenerDirector | None = None) -> HttpResponse:
    """The reader's production ``HttpClient``: ``https://api.enablebanking.com/…`` only, never a redirect."""
    if not request.url.startswith(f"{API}/"):
        raise NetworkError("only Enable Banking")
    req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)  # noqa: S310
    try:
        with (via or _OPENER).open(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
            return HttpResponse(resp.status, _lower(resp.headers.items()), resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as e:
        try:
            body = e.read(MAX_RESPONSE_BYTES)
        except (http.client.HTTPException, OSError):
            body = b""
        return HttpResponse(e.code, _lower(e.headers.items() if e.headers else []), body)
    except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
        raise NetworkError(type(e).__name__) from None


def _lower(items: Any) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in items}


# --- the PSU headers (§40.5.6) ----------------------------------------------------------------------------------

UA_MAX = 512
LANG_MAX = 100
IP_MAX = 64
HEADER_NAMES = {
    "psu-ip-address": "Psu-Ip-Address",
    "psu-user-agent": "Psu-User-Agent",
    "psu-referer": "Psu-Referer",
    "psu-accept-language": "Psu-Accept-Language",
}


def _clean(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit]


def psu_headers(required: Iterable[Any], psu: Mapping[str, Any] | None, referer: str) -> dict[str, str] | None:
    """The headers of an attended read, or None (the read is unattended). All of them or none: a bank that needs a
    header Clip Factory can't fill gets none, because a partial set gets 422 ``PSU_HEADER_NOT_PROVIDED``."""
    if not isinstance(psu, Mapping):
        return None
    names = [str(n).strip().lower() for n in required or [] if isinstance(n, str) and n.strip()]
    if not names:
        return None
    values = {
        "psu-ip-address": _clean(psu.get("ip"), IP_MAX),
        "psu-user-agent": _clean(psu.get("ua"), UA_MAX),
        "psu-referer": referer if referer.startswith("https://") else "",
        "psu-accept-language": _clean(psu.get("lang"), LANG_MAX),
    }
    out: dict[str, str] = {}
    for name in dict.fromkeys(names):
        value = values.get(name)
        if not value:
            return None
        out[HEADER_NAMES[name]] = value
    return out


# --- the rolling 24 hours (§40.5.6) -----------------------------------------------------------------------------

UNATTENDED_MAX = 3
UNATTENDED_KEEP = 4
WINDOW = timedelta(hours=24)


def unattended_times(reads: Any) -> list[str]:
    raw = reads.get("unattendedAt") if isinstance(reads, Mapping) else None
    return [t for t in raw or [] if isinstance(t, str) and parse(t) is not None]


def unattended_count(reads: Any, now: datetime) -> int:
    """How many unattended reads fall in the 24 hours before ``now`` (never a calendar day)."""
    since = now - WINDOW
    return sum(1 for t in unattended_times(reads) if (found := parse(t)) is not None and since < found <= now)


def may_read_unattended(reads: Any, now: datetime, cost: int = 1) -> bool:
    """True while this read keeps the past 24 hours at 3 unattended reads or fewer (one of the bank's 4 is spare)."""
    return unattended_count(reads, now) + cost <= UNATTENDED_MAX


def record_read(reads: Any, now: datetime, *, attended: bool, cost: int = 1) -> dict[str, Any]:
    """The link's new ``reads``: an attended read sets ``lastAttendedAt``; an unattended one adds ``cost`` times to
    ``unattendedAt`` (newest last, at most 4 kept)."""
    out: dict[str, Any] = {}
    last = reads.get("lastAttendedAt") if isinstance(reads, Mapping) else None
    times = unattended_times(reads)
    if attended:
        last = iso(now)
    else:
        times = times + [iso(now)] * max(1, cost)
    out["unattendedAt"] = times[-UNATTENDED_KEEP:]
    if isinstance(last, str) and last:
        out["lastAttendedAt"] = last
    return out


def limit_until(error_outcome: str, error: BankError, now: datetime) -> str | None:
    """``ASPSP_RATE_LIMIT_EXCEEDED``: 6 hours (Enable Banking's own advice). Enable Banking's own 429: its Retry-After,
    at least 1 hour."""
    if error_outcome == ASPSP_LIMIT:
        return iso(now + timedelta(hours=6))
    if error_outcome == EB_LIMIT:
        return iso(now + timedelta(seconds=max(error.retry_after or 0, 3600)))
    return None
