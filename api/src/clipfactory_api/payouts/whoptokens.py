"""``WhopTokens``: the Whop access token, refreshed under the lease on ``PAYCONN#whop`` (docs/CONTRACTS.md §40.6).

Whop's access tokens last 1 hour and its refresh token rotates on every use, so this keeps §38.9's ``CrTokens`` rules:

1. Every reader does a consistent ``GetItem PAYCONN#whop`` and reads ``cf-prod/platforms/whop/token`` **by**
   ``tokenVersionId`` (never a cached copy).
2. A refresh needs at least 20 s of the time budget and the lease (``refreshLeaseUntil``, 30 s); a loser sleeps 1 s up
   to 5 times and re-reads. Under the lease ``PAYCONN#whop`` and the secret are read again; still due → refresh.
3. A network error or 5xx → the same refresh token once more; 429 → wait ``Retry-After`` (≤ 10 s) and try once.
4. Before the new token is used: ``PAYCONN#whop`` is read again (a stop, or another sign-in, meanwhile throws the
   result away), the secret is written **put-only** and ``tokenVersionId`` is moved to the new version in one
   UpdateItem that still expects the old one (and clears the lease).

``invalid_grant`` → ``needs_reconnect`` ``token_dead`` ("Sign in to Whop again to see your payouts."); Whop refusing the
app key itself → ``keys_changed``. Never a delete. Every call sends ``Api-Version-Date``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any
from urllib.parse import urlencode

from .. import db
from ..clock import iso, parse
from ..log import log
from ..oauth.secrets import SecretMissing
from ..oauth.tokens import clear_lease, take_lease
from ..platforms.base import HttpRequest, HttpResponse, NetworkError
from . import MIN_SECONDS_LEFT, WHOP, PayoutDeps, load, mark_reconnect, payconn_sk

# Whop's token endpoint (the ``token_endpoint`` of https://api.whop.com/.well-known/openid-configuration).
TOKEN_URL = "https://api.whop.com/oauth/token"  # noqa: S105 - an endpoint, not a secret
API_VERSION_DATE = "2026-11-20"  # Whop's payout statuses in_review and denied need 2026-08-21 or later
REFRESH_MARGIN = timedelta(minutes=5)
LEASE = timedelta(seconds=30)
LEASE_TRIES = 5
MAX_RATE_WAIT = 10.0
FORM = "application/x-www-form-urlencoded"


class TokenError(Exception):
    """``kind``: ``not_connected`` (stopped, or another sign-in meanwhile), ``dead`` (sign in again: already marked),
    ``busy`` (the lease wasn't won), ``down`` (Whop didn't answer, or too little time left)."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


class _Fail(Exception):
    def __init__(self, kind: str, retry_after: float | None = None) -> None:
        super().__init__(kind)
        self.kind = kind  # dead | keys | rate | down | error
        self.retry_after = retry_after


@dataclass(frozen=True)
class Access:
    token: str
    conn: dict[str, Any]
    secret: dict[str, Any] = field(repr=False)


def headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"Accept": "application/json", "Api-Version-Date": API_VERSION_DATE, **(extra or {})}


def retry_after(resp: HttpResponse) -> float | None:
    raw = resp.headers.get("retry-after")
    try:
        return max(0.0, float(raw)) if raw is not None else None
    except ValueError:
        return None


def _seconds(value: Any) -> int:
    try:
        return max(30, int(value))
    except (TypeError, ValueError):
        return 3600


class WhopTokens:
    def __init__(self, deps: PayoutDeps) -> None:
        self.deps = deps

    @property
    def name(self) -> str:
        return self.deps.secrets.name(WHOP, "token")

    # --- reading -----------------------------------------------------------------------------------------------

    def read(self, user_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """``(PAYCONN#whop, the token secret of its tokenVersionId)``; the secret is None when it is gone."""
        conn = load(self.deps.store, user_id, payconn_sk(WHOP))
        version = conn.get("tokenVersionId")
        if isinstance(version, str) and version:
            return conn, self.deps.secrets.read(self.name, version_id=version)
        return conn, self.deps.secrets.read(self.name, fresh=True)

    def _due(self, secret: dict[str, Any]) -> bool:
        expires = parse(secret.get("expiresAt"))
        return expires is None or expires <= self.deps.clock() + REFRESH_MARGIN

    def access(self, user_id: str, *, stale: str | None = None) -> Access:
        """A usable access token. ``stale``: the token Whop just refused (401), refreshed even if not yet due."""
        conn, secret = self.read(user_id)
        if conn.get("status") != "connected":
            raise TokenError("dead" if conn.get("status") == "needs_reconnect" else "not_connected")
        if secret is None or not secret.get("refreshToken") or not secret.get("accessToken"):
            raise TokenError("not_connected")
        if not self._due(secret) and (stale is None or secret.get("accessToken") != stale):
            return Access(str(secret["accessToken"]), conn, secret)
        return self._refresh(user_id, stale)

    # --- refreshing --------------------------------------------------------------------------------------------

    def _usable(self, secret: dict[str, Any] | None, stale: str | None) -> bool:
        return secret is not None and not self._due(secret) and (stale is None or secret.get("accessToken") != stale)

    def _refresh(self, user_id: str, stale: str | None) -> Access:
        if self.deps.remaining() < MIN_SECONDS_LEFT:
            raise TokenError("down")
        pk, sk = db.user_pk(user_id), payconn_sk(WHOP)
        for attempt in range(LEASE_TRIES + 1):
            if take_lease(self.deps.store, pk, sk, self.deps.clock(), LEASE):
                try:
                    return self._refresh_under_lease(user_id, stale)
                finally:
                    clear_lease(self.deps.store, pk, sk)
            if attempt == LEASE_TRIES:
                break
            self.deps.sleep(1.0)
            conn, secret = self.read(user_id)
            if conn.get("status") == "connected" and secret is not None and self._usable(secret, stale):
                return Access(str(secret["accessToken"]), conn, secret)  # the lease holder refreshed it
        raise TokenError("busy")

    def _refresh_under_lease(self, user_id: str, stale: str | None) -> Access:
        conn, secret = self.read(user_id)
        if conn.get("status") != "connected" or secret is None or not secret.get("refreshToken"):
            raise TokenError("not_connected")
        if self._usable(secret, stale):
            return Access(str(secret["accessToken"]), conn, secret)  # refreshed just before we got the lease
        app = self.deps.secrets.read(self.deps.secrets.name(WHOP, "app"), fresh=True) or {}
        client_id = str(app.get("clientId") or "")
        if not client_id:
            raise TokenError("not_connected")
        answer = self._call_refresh(user_id, client_id, str(secret["refreshToken"]))
        now = self.deps.clock()
        fresh = {
            "accessToken": str(answer["access_token"]),
            "expiresAt": iso(now + timedelta(seconds=_seconds(answer.get("expires_in")))),
            "refreshToken": str(answer.get("refresh_token") or secret["refreshToken"]),
            "scope": " ".join(str(answer.get("scope") or secret.get("scope") or "").split()),
            "whopUserId": str(secret.get("whopUserId") or ""),
        }
        latest = load(self.deps.store, user_id, payconn_sk(WHOP))
        old_version = conn.get("tokenVersionId")
        if (
            latest.get("status") != "connected"
            or latest.get("tokenVersionId") != old_version
            or latest.get("accountId") != conn.get("accountId")
        ):
            log("warning", "payouts.whop_refresh_discarded")  # a stop or another sign-in since step 2
            raise TokenError("not_connected")
        try:
            version = self.deps.secrets.write(self.name, fresh, platform=WHOP, create=False)
        except SecretMissing as e:
            log("warning", "payouts.whop_secret_gone")
            raise TokenError("not_connected") from e
        self._point_at(user_id, old_version, version)
        log("info", "payouts.whop_refreshed")
        return Access(fresh["accessToken"], {**latest, "tokenVersionId": version}, fresh)

    def _point_at(self, user_id: str, old: Any, version: str) -> None:
        """``tokenVersionId`` → the new version and the lease cleared, in one UpdateItem that still expects the old
        version (the put-only write's check). Neither ``updatedAt`` nor ``connectedAt`` moves (``connectedAt`` marks
        the grant)."""
        names = {"#v": "tokenVersionId", "#l": "refreshLeaseUntil", "#s": "status"}
        values: dict[str, Any] = {":c": "connected"}
        if version:
            update = "SET #v = :v REMOVE #l"
            values[":v"] = version
        else:  # no version from Secrets Manager: readers then read the current secret
            update = "REMOVE #l, #v"
        if isinstance(old, str) and old:
            condition = "#s = :c AND #v = :old"
            values[":old"] = old
        else:
            condition = "#s = :c AND attribute_not_exists(#v)"
        try:
            self.deps.store.update_expr(
                db.user_pk(user_id), payconn_sk(WHOP), update, condition=condition, names=names, values=values
            )
        except db.ConditionFailed as e:
            log("warning", "payouts.whop_version_moved")
            raise TokenError("not_connected") from e

    def _post(self, client_id: str, refresh_token: str) -> dict[str, Any]:
        body = urlencode({"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id})
        request = HttpRequest("POST", TOKEN_URL, headers({"Content-Type": FORM}), body.encode())
        try:
            resp = self.deps.http(request)
        except NetworkError as e:
            raise _Fail("down") from e
        found = resp.json()
        data: dict[str, Any] = found if isinstance(found, dict) else {}
        code = str(data.get("error") or "")
        if resp.status == 429:
            raise _Fail("rate", retry_after(resp))
        if resp.status >= 500:
            raise _Fail("down")
        # The app key first: signing in again with a key Whop refuses can never work.
        if code == "invalid_grant":
            raise _Fail("dead")
        if code in {"invalid_client", "unauthorized_client"}:
            raise _Fail("keys")
        if resp.status == 401:
            raise _Fail("dead")
        if resp.status != 200 or not data.get("access_token"):
            raise _Fail("error")
        return data

    def _call_refresh(self, user_id: str, client_id: str, refresh_token: str) -> dict[str, Any]:
        try:
            return self._post(client_id, refresh_token)
        except _Fail as first:
            self._give_up_if_dead(user_id, first)
            wait = first.retry_after
            if first.kind == "down":
                pass  # the answer may be lost: the same refresh token once more, at once
            elif (
                first.kind == "rate"
                and wait is not None
                and wait <= MAX_RATE_WAIT
                and self.deps.remaining() - wait >= MIN_SECONDS_LEFT
            ):
                self.deps.sleep(wait)
            else:
                raise TokenError("down") from first
        try:
            return self._post(client_id, refresh_token)
        except _Fail as second:
            self._give_up_if_dead(user_id, second)
            raise TokenError("down") from second

    def _give_up_if_dead(self, user_id: str, fail: _Fail) -> None:
        if fail.kind in {"dead", "keys"}:
            reason = "token_dead" if fail.kind == "dead" else "keys_changed"
            mark_reconnect(self.deps.store, user_id, WHOP, reason, self.deps.clock())
            raise TokenError("dead") from fail
