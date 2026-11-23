"""Which developer app (OAuth client) Lamo Stories uses on each platform (docs/CONTRACTS.md §45.30, ADR-79).

The owner picks, per platform and before the first Connect, and the choice is stored on ``SOCIAL#{platform}`` as
``app.choice``:

* ``own``: Lamo Stories' own developer app, its keys in ``cf-prod/workspaces/{ws}/{platform}/app`` (always for
  Facebook and Instagram: re-authorizing Clip Factory's Meta app would change Clip Factory's grant). Its redirect URI
  is Lamo Stories' own callback, ``{STORIES_OAUTH_CALLBACK}/{platform}/callback``, and its quotas are its own: the
  rate counters ``RATE#WS#{ws}#{platform}`` and the workspace's ``xMonthlyLimitUsd``;
* ``clips`` (YouTube, TikTok and X only): Clip Factory's app, ``cf-prod/platforms/{platform}/app``, read only, with
  its registered redirect URI (Clip Factory's callback forwards the ``w1.`` state, §45.13.3). Its limits are shared,
  protected (§45.37 G6): Clip Factory's posts always go first, and Lamo Stories counts only in its own items and uses
  only what Clip Factory's reserve leaves (``workspaces.shared_room``), never writing ``RATE#{platform}``. Lamo
  Stories still gets its own authorization and tokens, for a different account than Clip Factory's (G8).

``app_keys`` is the one helper that picks the keys: Connect, the callback's exchange, the token refresh, Check,
creator info and ``validate_destination`` all use it. No choice, or a chosen app whose keys are missing, is "not set
up", never a fallback to the other app.
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, cast

from .. import db
from ..oauth import META, OAuthEnv
from ..oauth.providers import AppKeys
from ..stats import config as stats_config
from . import guard
from . import types as ws
from .secrets import WorkspaceSecrets
from .sentences import label

Item = dict[str, Any]

OWN: Final = "own"
CLIPS: Final = "clips"
CALLBACK_ENV: Final = "STORIES_OAUTH_CALLBACK"  # Lamo Stories' callback base: {apiUrl}/v1/stories-oauth


def choices(platform: str) -> tuple[str, ...]:
    """The choices a platform offers: Facebook and Instagram only ever Lamo Stories' own app."""
    return (OWN, CLIPS) if platform in ws.SHARED_APP_PLATFORMS else (OWN,)


def choice_of(platform: str, account: Mapping[str, Any] | None) -> str | None:
    """The stored choice (``own`` | ``clips``), or None when none was made (or the stored one is not allowed)."""
    app = (account or {}).get("app")
    choice = app.get("choice") if isinstance(app, Mapping) else None
    return choice if isinstance(choice, str) and choice in choices(platform) else None


@dataclass(frozen=True)
class ChosenApp:
    platform: str
    choice: str  # "own" | "clips"
    keys: AppKeys

    @property
    def shared(self) -> bool:
        """Clip Factory's app: its quotas, credits and review state are shared with Clip Factory."""
        return self.choice == CLIPS

    @property
    def client_id(self) -> str:
        return self.keys.client_id


class AppNotReady(Exception):
    """No app chosen, or the chosen app's keys are missing: nothing may connect, refresh or post."""

    def __init__(self, platform: str, reason: str) -> None:
        self.platform = platform
        self.reason = reason  # "no_choice" | "own_missing" | "clips_missing"
        self.sentence = not_ready_sentence(platform, reason)
        super().__init__(self.sentence)


def not_ready_sentence(platform: str, reason: str) -> str:
    name = label(platform)
    if reason == "clips_missing":
        return (
            f"Clip Factory has no {name} app keys yet. Set up {name} in Clip Factory first "
            "(Settings › Posting › Set up posting, up to the keys step)."
        )
    if reason == "no_choice" and platform in ws.SHARED_APP_PLATFORMS:
        return f"Pick which app Clip Factory Stories uses for {name} first."
    return f"Paste your Clip Factory Stories {name} app keys first."


def social_item(store: db.Store, user_id: str, workspace_id: str, platform: str) -> Item | None:
    """The workspace's ``SOCIAL#{platform}``, or None (also when its ``userId``/``workspaceId`` disagree)."""
    item = store.get(ws.workspace_pk(user_id, workspace_id), f"{ws.SOCIAL_SK}{platform}")
    if item is None or not guard.owned(item, user_id, workspace_id) or item.get("platform") != platform:
        return None
    return item


class _Unread:
    """The caller did not read ``SOCIAL#`` yet: ``app_keys`` reads it."""


UNREAD: Final = _Unread()


def require_app(
    store: db.Store,
    secrets: WorkspaceSecrets,
    user_id: str,
    workspace_id: str,
    platform: str,
    *,
    account: Mapping[str, Any] | _Unread | None = UNREAD,
) -> ChosenApp:
    """The chosen app and its keys, or ``AppNotReady``. Reads only the chosen app's secret: never the other one."""
    if platform not in ws.PLATFORMS:
        raise ValueError(f"unknown platform: {platform}")
    item = social_item(store, user_id, workspace_id, platform) if isinstance(account, _Unread) else account
    choice = choice_of(platform, item)
    if choice is None:
        raise AppNotReady(platform, "no_choice")
    if choice == OWN:
        keys = secrets.own_app_keys(workspace_id, platform)
        missing = "own_missing"
    else:
        keys = secrets.clips_app_keys(platform)
        missing = "clips_missing"
    if keys is None or (platform in META and not keys.config_id):
        raise AppNotReady(platform, missing)
    return ChosenApp(platform, choice, keys)


def app_keys(
    store: db.Store,
    secrets: WorkspaceSecrets,
    user_id: str,
    workspace_id: str,
    platform: str,
    *,
    account: Mapping[str, Any] | _Unread | None = UNREAD,
) -> ChosenApp | None:
    """The chosen app and its keys, or None ("not set up"): the one place the keys are picked (§45.30)."""
    try:
        return require_app(store, secrets, user_id, workspace_id, platform, account=account)
    except AppNotReady:
        return None


# --- redirect URIs ----------------------------------------------------------------------------------------------


def callback_base() -> str:
    """Lamo Stories' own callback base (``STORIES_OAUTH_CALLBACK``, https only), or "" when it is not configured."""
    value = os.environ.get(CALLBACK_ENV, "").strip().rstrip("/")
    return value if value.startswith("https://") else ""


@dataclass
class StoriesRedirectEnv(OAuthEnv):
    """``OAuthEnv`` whose redirect URI is Lamo Stories' own callback (an own developer app registers that one), so
    ``oauth.providers`` (unchanged) builds the authorize URL, Check it and the exchange with it."""

    stories_callback: str = ""

    def redirect_uri(self, platform: str) -> str:
        return f"{self.stories_callback.rstrip('/')}/{platform}/callback"


class CallbackOff(Exception):
    """An own app needs Lamo Stories' callback base, and it is not configured."""


def oauth_env_for(env: OAuthEnv, choice: str, base: str | None = None) -> OAuthEnv:
    """The OAuth environment of a choice: Clip Factory's app keeps its registered ``{hooks}/oauth/{p}/callback``;
    Lamo Stories' own app uses ``{storiesCallbackBase}/{p}/callback``."""
    if choice == CLIPS:
        return env
    found = callback_base() if base is None else base
    if not found:
        raise CallbackOff("STORIES_OAUTH_CALLBACK is not set")
    return StoriesRedirectEnv(  # every OAuthEnv field, as it is (tests/test_ws_apps.py checks none is missing)
        secrets=env.secrets,
        app_url=env.app_url,
        hooks_url=env.hooks_url,
        state_key=env.state_key,
        http=env.http,
        clock=env.clock,
        graph_version=env.graph_version,
        scopes=env.scopes,
        money_scopes=env.money_scopes,
        payment_scopes=env.payment_scopes,
        stories_callback=found,
    )


def redirect_uri(env: OAuthEnv, choice: str, platform: str, base: str | None = None) -> str:
    return oauth_env_for(env, choice, base).redirect_uri(platform)


# --- limits: shared with Clip Factory only on its app (§45.14, §45.30) -------------------------------------------


class OwnRates:
    """What ``stats.budget`` reads and writes, moved to Lamo Stories' own counters: ``RATE#{platform}`` becomes
    ``RATE#WS#{ws}#{platform}``. Only ``get`` and ``update_expr`` of that one item exist here (all ``budget`` uses);
    any other key is refused, so a mistake never touches Clip Factory's shared counters."""

    def __init__(self, store: db.Store, workspace_id: str, platform: str) -> None:
        self._store = store
        self._shared = db.rate_pk(platform)
        self.pk = ws.rate_pk(workspace_id, platform)

    def _key(self, pk: str, sk: str) -> str:
        if pk != self._shared or sk != db.RATE_SK:
            raise ValueError("only this platform's rate counters")
        return self.pk

    def get(self, pk: str, sk: str) -> Item | None:
        return self._store.get(self._key(pk, sk), sk)

    def update_expr(
        self,
        pk: str,
        sk: str,
        update: str,
        *,
        condition: str | None = None,
        names: Mapping[str, str] | None = None,
        values: Mapping[str, Any] | None = None,
    ) -> Item:
        return self._store.update_expr(self._key(pk, sk), sk, update, condition=condition, names=names, values=values)


def rate_store(store: db.Store, choice: str, workspace_id: str, platform: str) -> db.Store:
    """The store ``stats.budget`` gets with Lamo Stories' own app: its own counters. For Clip Factory's app this
    returns the plain store, but the story flow never asks (its ``rates`` refuses the shared choice):
    ``workspaces.shared_room`` counts in Lamo Stories' own items and never writes Clip Factory's (§45.37 G6)."""
    if choice == CLIPS:
        return store
    return cast(db.Store, OwnRates(store, workspace_id, platform))


def rates_config(
    cfg: stats_config.PlatformsConfig, choice: str, workspace: Mapping[str, Any] | None
) -> stats_config.PlatformsConfig:
    """The budget configuration of a choice. With Lamo Stories' own X app the monthly X limit is the workspace's
    ``xMonthlyLimitUsd`` (when not set: the same default as Clip Factory's, ``platforms.json``)."""
    if choice == CLIPS:
        return cfg
    configuration = (workspace or {}).get("configuration")
    limit = configuration.get("xMonthlyLimitUsd") if isinstance(configuration, Mapping) else None
    if isinstance(limit, bool) or not isinstance(limit, int | float) or limit < 0:
        return cfg
    x = cfg.platform("x")
    budget = {**x.budget, "monthlyUsd": float(limit)}
    return dataclasses.replace(cfg, platforms={**cfg.platforms, "x": dataclasses.replace(x, budget=budget)})
