"""Lamo Stories' secrets (docs/CONTRACTS.md §45.13.1, §45.30, ADR-72, ADR-73, ADR-79).

Two things, and only these two:

* the workspace's own secrets, ``cf-prod/workspaces/{workspaceId}/{platform}/{app|token|pending}``: Lamo Stories' own
  developer app keys (``app``, §45.30), its tokens (``token``) and Meta's list of Pages (``pending``): read, written
  and deleted here. The name is always built by ``workspaces.types.secret_name`` from ids the caller already checked
  against the workspace partition, never from an item or a request. New secrets are created with the tags
  ``app=cf-prod``, ``workspace={workspaceId}`` and ``platform``; every other read and put goes through
  ``oauth.secrets.Secrets`` with the workspace prefix;
* Clip Factory's app keys, ``cf-prod/platforms/{youtube|tiktok|x}/app``, **read only**, and only for the platforms
  whose shared-app choice exists (§45.30: Facebook and Instagram always use Lamo Stories' own Meta app). Nothing here
  can name, read or write a ``cf-prod/platforms/*/token`` or ``pending`` secret, or Clip Factory's Meta app keys.

Reads are never cached: a reconnect or a new key must never leave an old value in a warm container. A secret that
is gone (or still being deleted) reads as None, and so does a Clip Factory app key that IAM does not let us read
(Secrets Manager answers AccessDenied for a name that does not exist when the policy needs its random suffix): both
mean "not set up", never a fallback. Logs name the secret, never the value.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ..log import log
from ..oauth.providers import AppKeys
from ..oauth.secrets import PREFIX as APP_PREFIX
from ..oauth.secrets import SecretMissing, Secrets
from . import types as ws

__all__ = ["SecretMissing", "WorkspaceSecrets", "from_env"]

_GONE = ("ResourceNotFoundException", "InvalidRequestException")  # missing, or marked for deletion a moment ago


def _code(e: Exception) -> str:
    response = getattr(e, "response", None) or {}
    return str(response.get("Error", {}).get("Code") or "")


class WorkspaceSecrets:
    def __init__(self, client: Any, prefix: str = ws.WS_SECRET_PREFIX, *, app_prefix: str = APP_PREFIX) -> None:
        base = prefix if prefix.endswith("/") else prefix + "/"
        if "/platforms/" in base or base == (app_prefix if app_prefix.endswith("/") else app_prefix + "/"):
            raise ValueError("workspace secrets never live under cf-prod/platforms/")
        self._client = client
        self.prefix = base
        self._tokens = Secrets(client, base)
        self._app = Secrets(client, app_prefix)

    # --- the workspace's own secrets --------------------------------------------------------------------------

    def name(self, workspace_id: str, platform: str, kind: str) -> str:
        return ws.secret_name(self.prefix, workspace_id, platform, kind)

    def read(self, workspace_id: str, platform: str, kind: str = "token") -> dict[str, Any] | None:
        """The secret's JSON object, or None when it does not exist (or is being deleted). Always a fresh read."""
        name = self.name(workspace_id, platform, kind)
        try:
            return self._tokens.read(name, fresh=True)
        except Exception as e:
            if _code(e) in _GONE:
                return None
            raise

    def write(self, workspace_id: str, platform: str, kind: str, value: dict[str, Any], *, create: bool = True) -> None:
        """Put; with ``create`` a missing secret is created with its three tags. ``create=False`` is put-only and
        raises ``SecretMissing`` when the secret is gone (a refresh never re-creates a disconnected secret)."""
        name = self.name(workspace_id, platform, kind)
        try:
            self._tokens.write(name, value, platform=platform, create=False)
            return
        except SecretMissing:
            if not create:
                raise
        text = json.dumps(value, separators=(",", ":"), sort_keys=True)
        tags = [
            {"Key": "app", "Value": "cf-prod"},
            {"Key": "workspace", "Value": workspace_id},
            {"Key": "platform", "Value": platform},
        ]
        try:
            self._client.create_secret(Name=name, SecretString=text, Tags=tags)
        except Exception as e:
            if _code(e) != "ResourceExistsException":
                raise
            self._tokens.write(name, value, platform=platform, create=False)  # created a moment ago: put
            return
        log("info", "secrets.written", name=name)

    def delete(self, workspace_id: str, platform: str, kind: str) -> None:
        try:
            self._tokens.delete(self.name(workspace_id, platform, kind))
        except Exception as e:
            if _code(e) not in _GONE:  # already being deleted is deleted
                raise

    def own_app_keys(self, workspace_id: str, platform: str) -> AppKeys | None:
        """Lamo Stories' own developer app keys (``cf-prod/workspaces/{ws}/{platform}/app``, §45.30)."""
        return AppKeys.from_secret(self.read(workspace_id, platform, "app"))

    # --- Clip Factory's app keys, read only (YouTube, TikTok and X) -------------------------------------------

    def clips_app_keys(self, platform: str) -> AppKeys | None:
        """Clip Factory's developer app keys (``cf-prod/platforms/{platform}/app``), read only, for the shared-app
        choice. Facebook and Instagram never: their app is always Lamo Stories' own (§45.30)."""
        if platform not in ws.SHARED_APP_PLATFORMS:
            raise ValueError(f"{platform} never uses Clip Factory's app")
        name = self._app.name(platform, "app")
        try:
            return AppKeys.from_secret(self._app.read(name, fresh=True))
        except Exception as e:
            code = _code(e)
            if code in _GONE:
                return None
            if code == "AccessDeniedException":  # a name that does not exist reads as denied under a suffix glob
                log("warning", "secrets.app_unreadable", name=name)
                return None
            raise


def from_env() -> WorkspaceSecrets | None:
    """The workspace secrets of a Lambda: only when ``WS_SECRET_PREFIX`` is set (the deploy sets it; tests never)."""
    prefix = os.environ.get("WS_SECRET_PREFIX", "")
    if not prefix:
        return None
    import boto3
    from botocore.config import Config

    from ..app import region

    client = boto3.client(
        "secretsmanager",
        region_name=region(),
        config=Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=3, read_timeout=5),
    )
    return WorkspaceSecrets(client, prefix, app_prefix=os.environ.get("SECRET_PREFIX") or APP_PREFIX)
