"""AWS Secrets Manager: the only place for platform app keys and user tokens (docs/CONTRACTS.md §17.4).

Names: ``{prefix}{platform}/app``, ``{prefix}{platform}/token``, ``{prefix}{platform}/pending`` (prefix
``cf-prod/platforms/``). Values are JSON objects. Secrets are created at runtime (``CreateSecret`` with tags
``app=cf-prod`` and ``platform``), updated with ``PutSecretValue`` and deleted with ``ForceDeleteWithoutRecovery``.
Reads are cached per container for 5 minutes; ``fresh=True`` skips the cache (token rotation). Logs name the
secret, never the value.

Additive for Content Rewards (§38.9): ``read(..., version_id=...)`` reads one exact version (never cached), and
``write`` returns the new ``VersionId``; ``write(..., create=False)`` is put-only and raises ``SecretMissing`` on a
missing secret instead of creating it (a refresh must never re-create a disconnected secret).
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from typing import Any

from ..log import log

CACHE_SECONDS = 300
PREFIX = "cf-prod/platforms/"
KINDS = ("app", "token", "pending")


def _code(e: Exception) -> str:
    response = getattr(e, "response", None) or {}
    return str(response.get("Error", {}).get("Code") or "")


class SecretMissing(Exception):
    """A put-only write found no secret (it was deleted: a Disconnect)."""


class Secrets:
    def __init__(self, client: Any, prefix: str = PREFIX, *, now: Callable[[], float] = time.monotonic) -> None:
        self._client = client
        self.prefix = prefix if prefix.endswith("/") else prefix + "/"
        self._now = now
        self._cache: dict[str, tuple[dict[str, Any] | None, float]] = {}
        self._text_cache: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def name(self, platform: str, kind: str) -> str:
        if kind not in KINDS:
            raise ValueError(f"unknown secret kind: {kind}")
        return f"{self.prefix}{platform}/{kind}"

    # JSON secrets ---------------------------------------------------------------------------------------------

    def read(self, name: str, *, fresh: bool = False, version_id: str | None = None) -> dict[str, Any] | None:
        """The secret's JSON object, or None when it does not exist. ``version_id`` reads that one version."""
        if version_id is not None:
            return self._read_version(name, version_id)
        if not fresh:
            with self._lock:
                hit = self._cache.get(name)
                if hit and self._now() - hit[1] < CACHE_SECONDS:
                    return dict(hit[0]) if hit[0] is not None else None
        try:
            out = self._client.get_secret_value(SecretId=name)
        except Exception as e:
            if _code(e) == "ResourceNotFoundException":
                self._remember(name, None)
                return None
            raise
        try:
            value = json.loads(out.get("SecretString") or "null")
        except ValueError:
            log("error", "secrets.not_json", name=name)
            value = None
        found = value if isinstance(value, dict) else None
        self._remember(name, found)
        return dict(found) if found is not None else None

    def _read_version(self, name: str, version_id: str) -> dict[str, Any] | None:
        try:
            out = self._client.get_secret_value(SecretId=name, VersionId=version_id)
        except Exception as e:
            if _code(e) == "ResourceNotFoundException":
                return None
            raise
        try:
            value = json.loads(out.get("SecretString") or "null")
        except ValueError:
            log("error", "secrets.not_json", name=name)
            return None
        return dict(value) if isinstance(value, dict) else None

    def write(self, name: str, value: dict[str, Any], *, platform: str = "", create: bool = True) -> str:
        """Create-or-put; returns the new ``VersionId`` ("" when the client gave none). Raises nothing for "already
        exists": that is the put path. ``create=False``: put only, ``SecretMissing`` when the secret is gone."""
        text = json.dumps(value, separators=(",", ":"), sort_keys=True)
        try:
            out = self._client.put_secret_value(SecretId=name, SecretString=text)
        except Exception as e:
            if _code(e) != "ResourceNotFoundException":
                raise
            if not create:
                raise SecretMissing(name) from e
            tags = [{"Key": "app", "Value": "cf-prod"}]
            if platform:
                tags.append({"Key": "platform", "Value": platform})
            try:
                out = self._client.create_secret(Name=name, SecretString=text, Tags=tags)
            except Exception as created:
                if _code(created) != "ResourceExistsException":
                    raise
                out = self._client.put_secret_value(SecretId=name, SecretString=text)  # created meanwhile
        self._remember(name, dict(value))
        log("info", "secrets.written", name=name)
        return str((out or {}).get("VersionId") or "") if isinstance(out, dict) else ""

    def delete(self, name: str) -> None:
        try:
            self._client.delete_secret(SecretId=name, ForceDeleteWithoutRecovery=True)
        except Exception as e:
            if _code(e) != "ResourceNotFoundException":
                raise
        self._remember(name, None)
        log("info", "secrets.deleted", name=name)

    # plain-text secrets (the OAuth state key) -----------------------------------------------------------------

    def read_text(self, name: str) -> str:
        with self._lock:
            hit = self._text_cache.get(name)
            if hit and self._now() - hit[1] < CACHE_SECONDS:
                return hit[0]
        value = str(self._client.get_secret_value(SecretId=name).get("SecretString") or "")
        with self._lock:
            self._text_cache[name] = (value, self._now())
        return value

    def _remember(self, name: str, value: dict[str, Any] | None) -> None:
        with self._lock:
            self._cache[name] = (dict(value) if value is not None else None, self._now())
