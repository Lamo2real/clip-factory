"""Real tokens for the adapters and publishers (docs/CONTRACTS.md §17.6 "Token helper").

``SecretsTokenProvider(store, env)`` is the §16.5 ``TokenProvider`` (``__call__(platform, account) -> str``) and
also gives full ``Credentials`` (the app keys and the token secret) to the publishers.

* Refresh when ``expiresAt ≤ now + 5 min``: YouTube keeps its refresh token; TikTok and X **rotate** theirs, so a
  refresh takes a lease first (``refreshLeaseUntil`` on the Account, 30 s); a loser waits 1 s up to 5 times and
  re-reads the secret. The new secret is written **before** the access token is used.
* Instagram and Facebook use a Page token (from a long-lived user token, so it does not expire) and never refresh.
* A refused refresh token → Account ``needs_reconnect`` (``reason: token_dead``) and ``ReconnectNeededError``.
* TikTok's refresh token living < 7 days → ``reason: expires_soon`` with ``reconnectBy``.

Token secrets are read uncached: a reconnect elsewhere must never leave an old token in a warm container.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from ..platforms.base import NotConnectedError, ReconnectNeededError, RetryablePublishError
from . import META, OAuthEnv, label, providers, setup
from .providers import AppKeys

REFRESH_MARGIN = timedelta(minutes=5)
LEASE = timedelta(seconds=30)
LEASE_TRIES = 5
ROTATING = frozenset({"tiktok", "x"})
REFRESHING = frozenset({"youtube", "tiktok", "x"})

__all__ = ["AppKeys", "Credentials", "ReconnectNeededError", "SecretsTokenProvider", "clear_lease", "take_lease"]


@dataclass(frozen=True)
class Credentials:
    platform: str
    access_token: str
    app: AppKeys
    data: dict[str, Any]


def reconnect_sentence(platform: str) -> str:
    return f"Connect {label(platform)} again in Settings › Posting › Set up posting, then press Try again."


def _user_id(account: dict[str, Any]) -> str:
    found = account.get("userId")
    if isinstance(found, str) and found:
        return found
    pk = str(account.get("pk") or "")
    return pk.removeprefix("USER#")


def take_lease(store: db.Store, pk: str, sk: str, now: datetime, lease: timedelta = LEASE) -> bool:
    """Takes the refresh lease (``refreshLeaseUntil = now + 30 s``) on an existing item when it is free or past.
    Shared by the platform tokens and the Content Rewards tokens (§38.9)."""
    try:
        store.update_expr(
            pk,
            sk,
            "SET #l = :until",
            condition="attribute_exists(pk) AND (attribute_not_exists(#l) OR #l < :now)",
            names={"#l": "refreshLeaseUntil"},
            values={":until": iso(now + lease), ":now": iso(now)},
        )
    except db.ConditionFailed:
        return False
    return True


def clear_lease(store: db.Store, pk: str, sk: str) -> None:
    try:
        store.update_expr(pk, sk, "REMOVE #l", condition="attribute_exists(pk)", names={"#l": "refreshLeaseUntil"})
    except db.ConditionFailed:
        return


class SecretsTokenProvider:
    def __init__(self, store: db.Store, env: OAuthEnv, *, sleep: Callable[[float], None] = time.sleep) -> None:
        self.store = store
        self.env = env
        self.sleep = sleep

    def __call__(self, platform: str, account: dict[str, Any]) -> str:
        return self.credentials(platform, account).access_token

    def credentials(self, platform: str, account: dict[str, Any]) -> Credentials:
        secrets = self.env.secrets
        keys = AppKeys.from_secret(secrets.read(secrets.name(platform, "app"), fresh=True))
        token = secrets.read(secrets.name(platform, "token"), fresh=True)
        if keys is None or token is None:
            raise NotConnectedError(f"Connect {label(platform)} in Settings › Posting › Set up posting.")
        if platform in REFRESHING and self._expiring(token):
            token = self._refresh(platform, account, keys, token)
        access = token.get("pageAccessToken") if platform in META else token.get("accessToken")
        if not isinstance(access, str) or not access:
            raise NotConnectedError(f"Connect {label(platform)} in Settings › Posting › Set up posting.")
        return Credentials(platform, access, keys, token)

    def mark_dead(self, platform: str, account: dict[str, Any]) -> ReconnectNeededError:
        setup.mark_account(
            self.store, _user_id(account), platform, self.env.clock(), status="needs_reconnect", reason="token_dead"
        )
        log("warning", "oauth.token_dead", platform=platform)
        return ReconnectNeededError(reconnect_sentence(platform))

    # --- refresh -----------------------------------------------------------------------------------------------

    def _expiring(self, token: dict[str, Any]) -> bool:
        expires = parse(token.get("expiresAt"))
        return expires is not None and expires <= self.env.clock() + REFRESH_MARGIN

    def _refresh(self, platform: str, account: dict[str, Any], keys: AppKeys, token: dict[str, Any]) -> dict[str, Any]:
        if platform not in ROTATING:
            return self._do_refresh(platform, account, keys, token)
        pk = str(account.get("pk") or db.user_pk(_user_id(account)))
        sk = str(account.get("sk") or setup.account_sk(platform))
        for attempt in range(LEASE_TRIES + 1):
            if self._take_lease(pk, sk):
                try:
                    # Someone may have rotated it just before we got the lease: use theirs.
                    latest = self.env.secrets.read(self.env.secrets.name(platform, "token"), fresh=True) or token
                    if not self._expiring(latest):
                        return latest
                    return self._do_refresh(platform, account, keys, latest)
                finally:
                    self._clear_lease(pk, sk)
            if attempt == LEASE_TRIES:
                break
            self.sleep(1.0)
            waited = self.env.secrets.read(self.env.secrets.name(platform, "token"), fresh=True)
            if waited is not None and not self._expiring(waited):
                return waited
        raise RetryablePublishError(f"{label(platform)} is busy. Clip Factory tries again later.")

    def _take_lease(self, pk: str, sk: str) -> bool:
        return take_lease(self.store, pk, sk, self.env.clock())

    def _clear_lease(self, pk: str, sk: str) -> None:
        clear_lease(self.store, pk, sk)

    def _do_refresh(
        self, platform: str, account: dict[str, Any], keys: AppKeys, token: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            fresh = providers.refresh(self.env, platform, keys, token)
        except providers.Dead as e:
            raise self.mark_dead(platform, account) from e
        except providers.Fail as e:
            raise RetryablePublishError(f"{label(platform)} did not answer.") from e
        # Written before the access token is used: a rotated refresh token must never be lost.
        self.env.secrets.write(self.env.secrets.name(platform, "token"), fresh, platform=platform)
        log("info", "oauth.refreshed", platform=platform)
        if platform == "tiktok":
            self._watch_tiktok(account, fresh)
        return fresh

    def _watch_tiktok(self, account: dict[str, Any], token: dict[str, Any]) -> None:
        until = parse(token.get("refreshExpiresAt"))
        if until is None:
            return
        now = self.env.clock()
        fields: dict[str, Any] = {"reconnectBy": iso(until - providers.REFRESH_WARN)}
        if until - now < providers.REFRESH_WARN:
            fields["reason"] = "expires_soon"
        setup.mark_account(self.store, _user_id(account), "tiktok", now, **fields)


def token_provider_from_env(store: db.Store) -> SecretsTokenProvider | None:
    """The provider for ``cf-prod-stats`` and ``cf-prod-clip-flow`` (env ``SECRET_PREFIX``); None when unset."""
    import os

    prefix = os.environ.get("SECRET_PREFIX")
    if not prefix:
        return None
    import boto3
    from botocore.config import Config

    from ..app import region
    from ..stats import config
    from .secrets import Secrets

    client = boto3.client(
        "secretsmanager",
        region_name=region(),
        config=Config(retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=5),
    )

    def no_state_key() -> bytes:
        raise RuntimeError("the state key is only read by the API and the callback")

    env = OAuthEnv(
        secrets=Secrets(client, prefix),
        app_url="",
        hooks_url="",
        state_key=no_state_key,
        graph_version=config.load().graph_api_version,
    )
    return SecretsTokenProvider(store, env)
