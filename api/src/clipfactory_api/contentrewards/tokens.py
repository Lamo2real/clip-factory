"""``CrTokens``: the CR access token, refreshed under the lease on ``CRCONN`` (docs/CONTRACTS.md §38.9 "Tokens").

The token secret ``cf-prod/platforms/contentrewards/token`` is single-sourced by ``CRCONN``: every reader does a
consistent ``GetItem CRCONN`` and then reads the secret **by** ``CRCONN.tokenVersionId``, never a cached or "current"
copy. CR's refresh token is single use and rotates, so exactly one process ever uses it:

1. only with at least 20 s of the Lambda left; take the lease (losers sleep 1 s up to 5 times and re-read);
2. under the lease, re-read ``CRCONN`` and the secret by version; still due → refresh (8 s);
3. a network error or 5xx after sending → the same refresh token once more at once; 429 → wait ``Retry-After``
   (≤ 10 s) and try once;
4. re-check ``CRCONN`` (status and creator) under the lease; a Disconnect or another account meanwhile → the result is
   thrown away (its refresh token revoked); else the secret is written **put-only** and ``tokenVersionId``,
   ``tokenIssuedAt`` and ``lastRefreshAt`` are set with the lease cleared in one UpdateItem; only then is the access
   token used.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .. import db
from ..clock import Clock, iso, parse
from ..log import log
from ..oauth.secrets import SecretMissing, Secrets
from ..oauth.tokens import clear_lease, take_lease
from . import config, connection, oauth
from .net import Net

Item = dict[str, Any]
MAX_RATE_WAIT = 10.0


class TokenError(Exception):
    """``kind``: ``not_connected``, ``dead`` (sign in again), ``busy`` (lease not won), ``down`` (CR or time)."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


@dataclass(frozen=True)
class Access:
    token: str
    conn: Item
    secret: Item = field(repr=False)


def token_name(secrets: Secrets) -> str:
    return secrets.name(config.SECRET_KEY, "token")


def app_name(secrets: Secrets) -> str:
    return secrets.name(config.SECRET_KEY, "app")


class CrTokens:
    def __init__(  # noqa: PLR0917 (the deps, in the order §38.9 names them)
        self,
        store: db.Store,
        secrets: Secrets,
        net: Net,
        clock: Clock,
        sleep: Callable[[float], None] = time.sleep,
        remaining: Callable[[], float] = lambda: 900.0,
    ) -> None:
        self.store = store
        self.secrets = secrets
        self.net = net
        self.clock = clock
        self.sleep = sleep
        self.remaining = remaining

    # --- reading -----------------------------------------------------------------------------------------------

    def read(self, user_id: str) -> tuple[Item, Item | None]:
        """``(CRCONN, the secret of CRCONN.tokenVersionId)``; the secret is None when it is gone."""
        conn = connection.load(self.store, user_id)
        version = conn.get("tokenVersionId")
        if not isinstance(version, str) or not version:
            return conn, None
        return conn, self.secrets.read(token_name(self.secrets), version_id=version)

    def client_id(self) -> str:
        app = self.secrets.read(app_name(self.secrets), fresh=True) or {}
        return str(app.get("clientId") or "")

    def _due(self, secret: Mapping[str, Any]) -> bool:
        expires = parse(secret.get("expiresAt"))
        return expires is None or expires <= self.clock() + config.REFRESH_MARGIN

    @staticmethod
    def _stale(conn: Mapping[str, Any], secret: Mapping[str, Any]) -> bool:
        """A secret older than the one ``CRCONN`` points at is never used or refreshed."""
        mine, wanted = parse(secret.get("issuedAt")), parse(conn.get("tokenIssuedAt"))
        return mine is not None and wanted is not None and mine < wanted

    def access(self, user_id: str, *, stale: str | None = None) -> Access:
        """A usable access token. ``stale``: the token CR just refused (401), refreshed even if not yet due."""
        conn, secret = self.read(user_id)
        if not connection.signed_in(conn):
            raise TokenError("dead" if conn.get("status") == "needs_reconnect" else "not_connected")
        if secret is None or not secret.get("refreshToken"):
            raise TokenError("not_connected")
        if self._stale(conn, secret):
            raise TokenError("busy")
        due = self._due(secret) or (stale is not None and secret.get("accessToken") == stale)
        if not due:
            return Access(str(secret["accessToken"]), conn, secret)
        return self._refresh(user_id, stale)

    # --- refreshing --------------------------------------------------------------------------------------------

    def _refresh(self, user_id: str, stale: str | None) -> Access:
        if self.remaining() < config.MIN_LAMBDA_SECONDS_TO_REFRESH:
            raise TokenError("down")
        pk, sk = connection.key(user_id)
        for attempt in range(config.LEASE_TRIES + 1):
            if take_lease(self.store, pk, sk, self.clock(), config.LEASE):
                try:
                    return self._refresh_under_lease(user_id, stale)
                finally:
                    clear_lease(self.store, pk, sk)
            if attempt == config.LEASE_TRIES:
                break
            self.sleep(1.0)
            conn, secret = self.read(user_id)
            fresh_enough = secret is not None and not self._stale(conn, secret) and not self._due(secret)
            if secret is not None and fresh_enough and (stale is None or secret.get("accessToken") != stale):
                return Access(str(secret["accessToken"]), conn, secret)
        raise TokenError("busy")

    def _refresh_under_lease(self, user_id: str, stale: str | None) -> Access:
        conn, secret = self.read(user_id)
        if not connection.signed_in(conn) or secret is None:
            raise TokenError("not_connected")
        if self._stale(conn, secret):
            raise TokenError("busy")
        if not self._due(secret) and (stale is None or secret.get("accessToken") != stale):
            return Access(str(secret["accessToken"]), conn, secret)  # someone refreshed it just before us
        client_id = self.client_id()
        if not client_id:
            raise TokenError("not_connected")
        answer = self._call_refresh(user_id, client_id, str(secret["refreshToken"]))
        now = self.clock()
        fresh = oauth.secret_from(answer, now, requested=config.SCOPES, old=secret)
        latest = connection.load(self.store, user_id)
        if not connection.signed_in(latest) or latest.get("creatorId") != conn.get("creatorId"):
            # A Disconnect or another account since step 2: throw the result away.
            oauth.revoke(self.net, client_id, fresh["refreshToken"])
            log("warning", "cr.refresh_discarded")
            raise TokenError("not_connected")
        try:
            version = self.secrets.write(token_name(self.secrets), fresh, platform=config.SECRET_KEY, create=False)
        except SecretMissing as e:
            oauth.revoke(self.net, client_id, fresh["refreshToken"])
            log("warning", "cr.refresh_secret_gone")
            raise TokenError("not_connected") from e
        pk, sk = connection.key(user_id)
        fields: Item = {"tokenIssuedAt": fresh["issuedAt"], "lastRefreshAt": iso(now), "updatedAt": iso(now)}
        if version:
            fields["tokenVersionId"] = version
        updated = self.store.update(pk, sk, fields, remove=["refreshLeaseUntil"])
        log("info", "cr.refreshed")
        return Access(fresh["accessToken"], updated, fresh)

    def _call_refresh(self, user_id: str, client_id: str, refresh_token: str) -> dict[str, Any]:
        try:
            return oauth.refresh(self.net, client_id, refresh_token)
        except oauth.OAuthFail as first:
            if first.kind == "dead":
                self._dead(user_id)
                raise TokenError("dead") from first
            if first.kind == "down" and first.sent:
                pass  # the answer was lost: CR treats a reuse within seconds as the same call
            elif (
                first.kind == "rate"
                and first.retry_after is not None
                and first.retry_after <= MAX_RATE_WAIT
                and self.remaining() - first.retry_after >= config.MIN_LAMBDA_SECONDS_TO_REFRESH
            ):
                self.sleep(first.retry_after)  # 429: nothing was used, so the 20 s rule holds after the wait too
            else:
                raise TokenError("down") from first
        try:
            return oauth.refresh(self.net, client_id, refresh_token)
        except oauth.OAuthFail as second:
            if second.kind == "dead":
                self._dead(user_id)
                raise TokenError("dead") from second
            raise TokenError("down") from second

    def _dead(self, user_id: str) -> None:
        now = self.clock()
        connection.update(
            self.store,
            user_id,
            now,
            {"status": "needs_reconnect", "reason": "token_dead", "check": connection.check("token_dead", now)},
        )
        log("warning", "cr.token_dead")

    # --- keep alive and the 90 days ------------------------------------------------------------------------------

    def keep_alive(self, user_id: str, now: datetime) -> str:
        """Once a day the tick refreshes (30 days unused would end the sign-in). Returns what it did."""
        conn = connection.load(self.store, user_id)
        if not connection.signed_in(conn):
            return "not_connected"
        last = parse(conn.get("lastRefreshAt")) or parse(conn.get("connectedAt"))
        if last is not None and now - last < config.KEEP_ALIVE:
            return "fresh"
        try:
            _conn, secret = self.read(user_id)
            if secret is None:
                return "not_connected"
            self._refresh(user_id, str(secret.get("accessToken") or ""))
        except TokenError as e:
            return e.kind
        return "refreshed"
