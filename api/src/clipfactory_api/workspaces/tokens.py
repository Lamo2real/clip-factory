"""``WorkspaceTokenProvider``: a Lamo Stories workspace's tokens for the publishers and stats adapters
(docs/CONTRACTS.md §45.14, ADR-73).

Its own class, bound to one user and one workspace (the secret names are built from those checked ids only):

* the app keys of the developer app the owner chose (``workspaces.apps.app_keys``, §45.30): Lamo Stories' own
  (``cf-prod/workspaces/{workspaceId}/{platform}/app``) or, for YouTube, TikTok and X, Clip Factory's (read only);
  none chosen, or its keys missing, is "not connected";
* the token from ``cf-prod/workspaces/{workspaceId}/{platform}/token`` only (``workspaces.secrets``);
* refresh and rotation with ``providers.refresh``: TikTok and X rotate their refresh tokens, so a refresh takes the
  lease on ``SOCIAL#{platform}`` first (``take_lease``/``clear_lease``, 30 s); a loser waits 1 s up to 5 times and
  re-reads the secret. The new token is written put-only (a missing secret is "not connected", never re-created)
  before the access token is used;
* a refused refresh token sets ``SOCIAL#{platform}`` ``needs_reconnect`` (``reason: token_dead``); TikTok's refresh
  token living < 7 days sets ``reason: expires_soon`` and ``reconnectBy`` on ``SOCIAL#tiktok``.

It writes only under ``USER#{userId}#WS#{workspaceId}`` and ``cf-prod/workspaces/{workspaceId}/``: never ``ACCOUNT#``
or ``SETUP#``, never a ``cf-prod/platforms/*`` secret. Sentences are Lamo Stories' own (``workspaces.sentences``).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..log import log
from ..oauth import META, OAuthEnv, providers
from ..oauth.providers import AppKeys
from ..oauth.tokens import Credentials, clear_lease, take_lease
from ..platforms.base import NotConnectedError, ReconnectNeededError, RetryablePublishError
from . import apps, social
from . import types as ws
from .secrets import SecretMissing, WorkspaceSecrets
from .sentences import story_sentence

REFRESH_MARGIN = timedelta(minutes=5)
LEASE_TRIES = 5
ROTATING = frozenset({"tiktok", "x"})
REFRESHING = frozenset({"youtube", "tiktok", "x"})

__all__ = ["Credentials", "WorkspaceTokenProvider"]


class WorkspaceTokenProvider:
    def __init__(
        self,
        store: db.Store,
        env: OAuthEnv,
        secrets: WorkspaceSecrets,
        user_id: str,
        workspace_id: str,
        *,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if workspace_id == ws.CLIPS or not ws.WORKSPACE_ID.match(workspace_id):
            raise ValueError("not a Lamo Stories workspace id")
        self.store = store
        self.env = env
        self.secrets = secrets
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.sleep = sleep

    # The §16.5 TokenProvider shape, for the stats adapters: the account argument never picks the secret.
    def __call__(self, platform: str, account: dict[str, Any] | None = None) -> str:
        return self.credentials(platform).access_token

    @property
    def pk(self) -> str:
        return ws.workspace_pk(self.user_id, self.workspace_id)

    def _account_name(self, platform: str) -> str | None:
        item = social.account_item(self.store, self.user_id, self.workspace_id, platform)
        return str(item.get("accountName")) if item and item.get("accountName") else None

    def app_keys(self, platform: str) -> AppKeys | None:
        """The chosen developer app's keys (never the other app's), or None."""
        chosen = apps.app_keys(self.store, self.secrets, self.user_id, self.workspace_id, platform)
        return chosen.keys if chosen is not None else None

    def credentials(self, platform: str, account: dict[str, Any] | None = None) -> Credentials:
        if platform not in ws.PLATFORMS:
            raise NotConnectedError(story_sentence(platform, "not_connected"))
        keys = self.app_keys(platform)
        token = self.secrets.read(self.workspace_id, platform, "token")
        if keys is None or token is None:
            raise NotConnectedError(story_sentence(platform, "not_connected", self._account_name(platform)))
        if platform in REFRESHING and self._expiring(token):
            token = self._refresh(platform, keys, token)
        access = token.get("pageAccessToken") if platform in META else token.get("accessToken")
        if not isinstance(access, str) or not access:
            raise NotConnectedError(story_sentence(platform, "not_connected", self._account_name(platform)))
        return Credentials(platform, access, keys, token)

    def mark_dead(self, platform: str, account: dict[str, Any] | None = None) -> ReconnectNeededError:
        """``SOCIAL#{platform}`` → ``needs_reconnect`` (``reason: token_dead``); the error to raise."""
        social.mark_account(
            self.store,
            self.user_id,
            self.workspace_id,
            platform,
            self.env.clock(),
            connectionStatus="needs_reconnect",
            reason="token_dead",
        )
        log("warning", "ws_tokens.token_dead", platform=platform, workspaceId=self.workspace_id)
        return ReconnectNeededError(story_sentence(platform, "token_dead", self._account_name(platform)))

    # --- refresh -----------------------------------------------------------------------------------------------

    def _expiring(self, token: dict[str, Any]) -> bool:
        expires = parse(token.get("expiresAt"))
        return expires is not None and expires <= self.env.clock() + REFRESH_MARGIN

    def _refresh(self, platform: str, keys: AppKeys, token: dict[str, Any]) -> dict[str, Any]:
        if platform not in ROTATING:
            return self._do_refresh(platform, keys, token)
        sk = social.social_sk(platform)
        for attempt in range(LEASE_TRIES + 1):
            if take_lease(self.store, self.pk, sk, self.env.clock()):
                try:
                    # Someone may have rotated it just before we got the lease: use theirs.
                    latest = self.secrets.read(self.workspace_id, platform, "token") or token
                    if not self._expiring(latest):
                        return latest
                    return self._do_refresh(platform, keys, latest)
                finally:
                    clear_lease(self.store, self.pk, sk)
            if attempt == LEASE_TRIES:
                break
            self.sleep(1.0)
            waited = self.secrets.read(self.workspace_id, platform, "token")
            if waited is not None and not self._expiring(waited):
                return waited
        raise RetryablePublishError(story_sentence(platform, "rate"))

    def _do_refresh(self, platform: str, keys: AppKeys, token: dict[str, Any]) -> dict[str, Any]:
        try:
            fresh = providers.refresh(self.env, platform, keys, token)
        except providers.Dead as e:
            raise self.mark_dead(platform) from e
        except providers.Fail as e:
            raise RetryablePublishError(story_sentence(platform, "down")) from e
        # Written before the access token is used: a rotated refresh token must never be lost. Put-only: a
        # Disconnect a moment ago means "not connected", never a new secret.
        try:
            self.secrets.write(self.workspace_id, platform, "token", fresh, create=False)
        except SecretMissing as e:
            raise NotConnectedError(story_sentence(platform, "not_connected", self._account_name(platform))) from e
        log("info", "ws_tokens.refreshed", platform=platform, workspaceId=self.workspace_id)
        if platform == "tiktok":
            self._watch_tiktok(fresh)
        return fresh

    def _watch_tiktok(self, token: dict[str, Any]) -> None:
        until = parse(token.get("refreshExpiresAt"))
        if until is None:
            return
        now = self.env.clock()
        fields: dict[str, Any] = {"reconnectBy": iso(until - providers.REFRESH_WARN)}
        if until - now < providers.REFRESH_WARN:
            fields["reason"] = "expires_soon"
        social.mark_account(self.store, self.user_id, self.workspace_id, "tiktok", now, **fields)
