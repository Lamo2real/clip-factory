"""What the CR code needs, built once per warm Lambda (``cf-prod-api``, ``cf-prod-clip-flow``, ``cf-prod-stats``).

``cf-prod-campaigns`` never builds these: it has no secret access (§38.16) and its own small deps (``handler.py``).
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .. import db, s3
from ..clock import Clock, utcnow
from ..oauth.secrets import Secrets
from . import config
from .mcp import McpClient
from .net import Net, urllib_net
from .tokens import CrTokens

ENV_NEEDED = ("OAUTH_STATE_SECRET", "SECRET_PREFIX", "CAMPAIGNS_FUNCTION_ARN", "STATS_FUNCTION_ARN")


@dataclass
class CrDeps:
    store: db.Store
    secrets: Secrets
    net: Net = urllib_net
    clock: Clock = utcnow
    sleep: Callable[[float], None] = time.sleep
    monotonic: Callable[[], float] = time.monotonic
    media: s3.Media | None = None
    invoker: Any = None  # async_invoke.AsyncInvoker: read_campaign, fetch_logo, brand_picture, cr_check
    state_key: Callable[[], bytes] | None = None  # the OAuth state key (cf-prod-api only)
    remaining: Callable[[], float] = lambda: 900.0  # seconds left in this Lambda
    submit_timeout: float = config.SUBMIT_TIMEOUT_FLOW
    _clients: dict[str, McpClient] = field(default_factory=dict, repr=False)
    _lists: dict[str, tuple[float, list[dict[str, Any]], bool]] = field(default_factory=dict, repr=False)

    def tokens(self) -> CrTokens:
        return CrTokens(self.store, self.secrets, self.net, self.clock, self.sleep, self.remaining)

    def mcp(self, user_id: str) -> McpClient:
        """One client per owner per container (``initialize`` once: the server is sessionless)."""
        client = self._clients.get(user_id)
        if client is None:
            client = McpClient(self.net, self.tokens(), user_id, self.clock, sleep=self.sleep, monotonic=self.monotonic)
            self._clients[user_id] = client
        return client


def ready(env: Any = None) -> bool:
    """§38.8: every route answers 503 unless the switch is on and the four names are set."""
    source = os.environ if env is None else env
    return config.enabled(source) and all(source.get(name) for name in ENV_NEEDED)


def from_env(store: db.Store, media: s3.Media | None, invoker: Any, *, read_timeout: float = 5.0) -> CrDeps | None:
    """The CR deps of a Lambda, or None when Content Rewards is switched off or not configured."""
    env = os.environ
    if not config.enabled(env) or not env.get("SECRET_PREFIX"):
        return None
    import boto3
    from botocore.config import Config

    from ..app import region

    client = boto3.client(
        "secretsmanager",
        region_name=region(),
        config=Config(retries={"mode": "standard", "max_attempts": 3}, connect_timeout=3, read_timeout=read_timeout),
    )
    secrets = Secrets(client, env["SECRET_PREFIX"])
    state_name = env.get("OAUTH_STATE_SECRET", "")

    def state_key() -> bytes:
        return secrets.read_text(state_name).encode()

    return CrDeps(
        store=store,
        secrets=secrets,
        media=media,
        invoker=invoker,
        state_key=state_key if state_name else None,
    )
