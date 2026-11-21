"""Posting setup: bring-your-own-keys OAuth for the five platforms (docs/CONTRACTS.md §17.4–§17.6).

* ``state``: the signed, single-use OAuth ``state`` and the PKCE verifier derived from it.
* ``secrets``: the only store for app keys and user tokens (AWS Secrets Manager, ``cf-prod/platforms/*``).
* ``formats``: key format checks and masked hints (same patterns as ``web/src/lib/keyFormats.ts``).
* ``providers``: every platform HTTP call of the setup (authorize URLs, Check it, code exchange, profiles, revoke).
* ``callback``: ``GET /oauth/{platform}/callback`` (run by ``cf-prod-hooks``).
* ``tokens``: ``SecretsTokenProvider``, refreshes and rotations.
* ``setup``: the ``SETUP#``/``ACCOUNT#`` items and the public ``PlatformSetup`` shape.

Nothing here logs a key, token, code or state.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from ..clock import Clock, utcnow
from ..platforms.base import HttpClient, urllib_client
from ..stats import STATS_ORDER
from .secrets import Secrets

SETUP_ORDER: tuple[str, ...] = STATS_ORDER
LABELS = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
META = frozenset({"instagram", "facebook"})
# PKCE where the platform supports it for a confidential web client. If Google ever rejects PKCE for web clients,
# set PKCE["youtube"] = False: the signed single-use state still protects the flow.
PKCE: dict[str, bool] = {"youtube": True, "x": True, "tiktok": False, "instagram": False, "facebook": False}
STATE_SECONDS = 600
APP_NAME = "Clip Factory"
# §17.7: the permissions each platform's app asks for (the platforms.json lists win when present).
DEFAULT_SCOPES: dict[str, tuple[str, ...]] = {
    "youtube": (
        "https://www.googleapis.com/auth/youtube.readonly",
        "https://www.googleapis.com/auth/yt-analytics.readonly",
        "https://www.googleapis.com/auth/youtube.upload",
    ),
    "tiktok": ("user.info.basic", "video.publish", "video.list"),
    "instagram": (
        "instagram_basic",
        "instagram_manage_insights",
        "instagram_content_publish",
        "pages_show_list",
        "pages_read_engagement",
    ),
    "facebook": (
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
        "pages_manage_engagement",
        "read_insights",
        "business_management",
    ),
    "x": ("tweet.read", "users.read", "tweet.write", "media.write", "offline.access"),
}
# §25.4: asked for only by "Allow money reading" (grant=money), on top of the Connect scopes. Connect never asks for
# them, so a normal Connect is exactly what it was. The platforms.json moneyScopes lists win when present.
DEFAULT_MONEY_SCOPES: dict[str, tuple[str, ...]] = {
    "youtube": ("https://www.googleapis.com/auth/yt-analytics-monetary.readonly",),
    "tiktok": ("user.info.stats",),
    "instagram": (),
    "facebook": (),
    "x": (),
}
MONEY_GRANT = "money"
# §40.6: asked for only by "Allow payment reading" (grant=payments), on its own (never with the Connect or money scopes:
# the AdSense Google account can be another one). The platforms.json paymentScopes lists win when present.
DEFAULT_PAYMENT_SCOPES: dict[str, tuple[str, ...]] = {
    "youtube": ("https://www.googleapis.com/auth/adsense.readonly",),
    "tiktok": (),
    "instagram": (),
    "facebook": (),
    "x": (),
}
PAYMENTS_GRANT = "payments"


def label(platform: str) -> str:
    return LABELS.get(platform, platform)


def host(url: str) -> str:
    return urlsplit(url).hostname or ""


@dataclass
class OAuthEnv:
    """What the setup routes, the callback and the token provider share."""

    secrets: Secrets
    app_url: str  # https://dxxxx.cloudfront.net (no trailing slash)
    hooks_url: str  # https://xxxx.execute-api.eu-north-1.amazonaws.com/v1
    state_key: Callable[[], bytes]
    http: HttpClient = urllib_client
    clock: Clock = field(default=utcnow)
    graph_version: str = "v27.0"
    scopes: dict[str, tuple[str, ...]] = field(default_factory=lambda: dict(DEFAULT_SCOPES))
    money_scopes: dict[str, tuple[str, ...]] = field(default_factory=lambda: dict(DEFAULT_MONEY_SCOPES))
    payment_scopes: dict[str, tuple[str, ...]] = field(default_factory=lambda: dict(DEFAULT_PAYMENT_SCOPES))

    def redirect_uri(self, platform: str) -> str:
        """Exact, no trailing slash; the same string goes to the authorize URL and the code exchange."""
        return f"{self.hooks_url.rstrip('/')}/oauth/{platform}/callback"

    @property
    def app_base(self) -> str:
        return self.app_url.rstrip("/")


def scopes_from_config() -> dict[str, tuple[str, ...]]:
    """The platforms.json scope lists (§17.7), falling back to ``DEFAULT_SCOPES`` for a platform without one."""
    from ..stats import config

    try:
        cfg = config.load()
    except Exception:
        return dict(DEFAULT_SCOPES)
    return {p: cfg.platform(p).scopes or DEFAULT_SCOPES[p] for p in SETUP_ORDER}


def money_scopes_from_config() -> dict[str, tuple[str, ...]]:
    """The platforms.json ``moneyScopes`` lists (§25.4), falling back to ``DEFAULT_MONEY_SCOPES``."""
    from ..stats import config

    try:
        cfg = config.load()
    except Exception:
        return dict(DEFAULT_MONEY_SCOPES)
    return {p: cfg.platform(p).money_scopes for p in SETUP_ORDER}


def payment_scopes_from_config() -> dict[str, tuple[str, ...]]:
    """The platforms.json ``paymentScopes`` lists (§40.6), falling back to ``DEFAULT_PAYMENT_SCOPES``."""
    from ..stats import config

    try:
        cfg = config.load()
    except Exception:
        return dict(DEFAULT_PAYMENT_SCOPES)
    return {p: cfg.platform(p).payment_scopes or DEFAULT_PAYMENT_SCOPES[p] for p in SETUP_ORDER}


def money_capable(env: OAuthEnv, platform: str) -> bool:
    """Whether "Allow money reading" means anything for this platform (YouTube and TikTok today)."""
    return bool(env.money_scopes.get(platform))
