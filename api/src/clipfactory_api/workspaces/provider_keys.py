"""API keys for generation providers that need one (docs/CONTRACTS.md §45.3 ``PROVCRED#``, §45.5, §45.29 AI, §45.31,
ADR-80).

The key itself lives only in Secrets Manager, ``cf-prod/workspaces/{workspaceId}/providers/{providerId}``, created
with the tags ``app=cf-prod``, ``workspace`` and ``provider``; the workspace partition keeps only ``PROVCRED#``
(``savedAt`` and a ``hint``, the last 4 characters of a long key). The key is never returned, logged or stored
anywhere else.

**The keyed hosts** (§45.37 G4, G7): ``anthropic`` (the Anthropic API), ``openai_compatible`` (an OpenAI-compatible
API the owner names in Add a model) and ``elevenlabs`` (sound effects and music only) take the owner's key, stored as
JSON ``{"key"}`` and read by Lamo Stories' agent on every call (its runtime role reads only
``cf-prod/workspaces/*/providers/*``). Everything else Lamo Stories calls uses the app's own AWS access (Amazon
Bedrock, Amazon Polly; the built-in animator, rig and synth need nothing), so a key is never asked for. A provider is
shown ``on`` only after a real call (its ``PROVIDER#`` item) or the model's own check, never because a key was saved.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import ApiError, bad_request, conflict, not_found
from ..log import log
from . import ai_config as cfg
from . import deps
from . import types as ws

KEY_MAX: Final = 4096
HINT_FROM: Final = 12  # shorter keys get no hint: four characters would be too much of them


@dataclass(frozen=True)
class KeyedProvider:
    kind: str  # "writer" | "images" | "animation" | "audio"
    id: str
    label: str


# The keyed hosts (§45.37 G4): the owner's key for models he adds there, and for the ElevenLabs sound maker.
KEYED: Final[dict[str, KeyedProvider]] = {
    "anthropic": KeyedProvider("writer", "anthropic", "Anthropic API"),
    "openai_compatible": KeyedProvider("writer", "openai_compatible", "OpenAI-compatible API"),
    "elevenlabs": KeyedProvider("audio", "elevenlabs", "ElevenLabs"),
}
# ElevenLabs' key shows on its sound maker's row of GET …/providers; every other keyed host has its own row.
ON_MAKER_ROW: Final = ("elevenlabs",)
# Providers that use the app's own AWS access (IAM), so a key is never asked for.
NO_KEY: Final = {
    "bedrock-claude": "Claude on Amazon Bedrock",
    "bedrock": "Amazon Bedrock",
    "nova-canvas": "Amazon Nova Canvas",
    "nova-reel": "Amazon Nova Reel",
    "stability": "Stability AI on Amazon Bedrock",
    "luma-ray": "Luma AI Ray2 on Amazon Bedrock",
    "polly": "Amazon Polly",
    "builtin-rig": "The built-in characters",
    "builtin-2d": "The built-in animation",
    "builtin-synth": "The built-in sounds and music",
}


def provcred_sk(provider_id: str) -> str:
    return f"{ws.PROVCRED_SK}{provider_id}"


def _code(e: Exception) -> str:
    response = getattr(e, "response", None) or {}
    return str(response.get("Error", {}).get("Code") or "")


def install(app: Any, client: Any) -> None:
    """For tests: the Secrets Manager client provider keys are written with."""
    app._cf_ws_provider_secrets = client


def _client(app: Any) -> Any:
    found = getattr(app, "_cf_ws_provider_secrets", None)
    if found is not None:
        return found
    import boto3
    from botocore.config import Config

    from ..app import region

    config = Config(retries={"mode": "standard", "max_attempts": 2}, connect_timeout=3, read_timeout=5)
    client = boto3.client("secretsmanager", region_name=region(), config=config)
    app._cf_ws_provider_secrets = client
    return client


def _provider(provider_id: str) -> KeyedProvider:
    if not ws.PROVIDER_ID.match(provider_id):
        raise not_found("We could not find that provider.")
    if provider_id in NO_KEY:
        raise bad_request(f"{NO_KEY[provider_id]} uses Lamo Stories' own AWS access, so it needs no key.")
    found = KEYED.get(provider_id)
    if found is None:
        raise not_found(f"Lamo Stories has no provider called '{provider_id}' that uses a key yet.")
    return found


def secret_name(app: Any, workspace_id: str, provider_id: str) -> str:
    return ws.provider_secret_name(deps.of(app).ws_secret_prefix, workspace_id, provider_id)


def key_state(cred: Mapping[str, Any] | None) -> dict[str, Any]:
    """``ProviderStatus.key`` (§45.34): whether a key is saved, its hint and when; never the key."""
    if cred is None:
        return {"saved": False, "hint": None, "savedAt": None}
    hint = str(cred.get("hint") or "")
    saved_at = cred.get("savedAt")
    return {"saved": True, "hint": hint or None, "savedAt": str(saved_at) if isinstance(saved_at, str) else None}


def status(store: db.Store, user_id: str, workspace_id: str, p: KeyedProvider) -> dict[str, Any]:
    """``ProviderStatus`` of a keyed provider: ``on`` only after a real call (its ``PROVIDER#`` item), with ``key``
    (§45.34: only a provider that takes a key has it)."""
    cred = cfg.get_owned(store, user_id, workspace_id, provcred_sk(p.id))
    record = cfg.get_owned(store, user_id, workspace_id, f"{ws.PROVIDER_SK}{p.kind}#{p.id}") or {}
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label, "key": key_state(cred)}
    if cred is None:
        return {**out, "state": "needs_setup", "line": f"Paste your {p.label} key to use it."}
    hint = str(cred.get("hint") or "")
    saved = f"Key saved · ends {hint}." if hint else "Key saved."
    if record.get("state") == "on" and record.get("checkedAt"):
        return {**out, "state": "on", "line": saved, "checkedAt": str(record["checkedAt"])}
    out.update(state="needs_setup", line=f"{saved} It is checked on its first real call.")
    if record.get("checkedAt"):
        out["checkedAt"] = str(record["checkedAt"])
    if record.get("lastError"):
        out["lastError"] = str(record["lastError"])
        out["line"] = str(record["lastError"])
    return out


def statuses(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    """The keyed hosts' own rows of ``GET …/providers`` (the Anthropic API, an OpenAI-compatible API), each with its
    ``key`` and never the key itself."""
    return [status(store, user_id, workspace_id, p) for h, p in KEYED.items() if h not in ON_MAKER_ROW]


def saved_hosts(store: db.Store, user_id: str, workspace_id: str) -> frozenset[str]:
    """The keyed hosts whose key the owner saved (their ``PROVCRED#`` items; the key itself only in Secrets
    Manager)."""
    found = cfg.query_owned(store, user_id, workspace_id, ws.PROVCRED_SK)
    return frozenset(
        str(i["sk"])[len(ws.PROVCRED_SK) :]
        for i in found
        if i.get("type") == ws.TYPE_PROVCRED and str(i.get("sk") or "")[len(ws.PROVCRED_SK) :] in KEYED
    )


def key_of(store: db.Store, user_id: str, workspace_id: str, host: str) -> dict[str, Any]:
    """``ProviderStatus.key`` of one keyed host."""
    return key_state(cfg.get_owned(store, user_id, workspace_id, provcred_sk(host)))


def put_key(
    app: Any, user_id: str, workspace_id: str, provider_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("key",))
    raw = body.get("key")
    if not isinstance(raw, str) or not raw.strip():
        raise bad_request("Paste the key.", "key")
    key = raw.strip()
    if len(key.encode()) > KEY_MAX:
        raise bad_request("That key is too long (at most 4 KB).", "key")
    p = _provider(provider_id)
    name = secret_name(app, workspace_id, p.id)
    text = json.dumps({"key": key}, separators=(",", ":"))
    client = _client(app)
    try:
        try:
            client.put_secret_value(SecretId=name, SecretString=text)
        except Exception as e:
            if _code(e) != "ResourceNotFoundException":
                raise
            tags = [
                {"Key": "app", "Value": "cf-prod"},
                {"Key": "workspace", "Value": workspace_id},
                {"Key": "provider", "Value": p.id},
            ]
            try:
                client.create_secret(Name=name, SecretString=text, Tags=tags)
            except Exception as created:
                if _code(created) != "ResourceExistsException":
                    raise
                client.put_secret_value(SecretId=name, SecretString=text)  # made a moment ago
    except Exception as e:
        if _code(e) == "InvalidRequestException":  # deleted a moment ago; Secrets Manager needs a few seconds
            raise conflict("That key was removed a moment ago. Try again in a minute.") from e
        log("error", "ws.provider_key_not_saved", provider=p.id, error=type(e).__name__)
        raise ApiError(503, "platform_down", "We could not save the key right now. Try again in a minute.") from e
    at = iso(now)
    app.store.put(
        {
            **cfg.base_item(user_id, workspace_id, provcred_sk(p.id), ws.TYPE_PROVCRED),
            "providerId": p.id,
            "savedAt": at,
            "hint": key[-4:] if len(key) >= HINT_FROM else "",
            "updatedAt": at,
        }
    )
    log("info", "ws.provider_key_saved", provider=p.id)
    return status(app.store, user_id, workspace_id, p)


def delete_key(app: Any, user_id: str, workspace_id: str, provider_id: str) -> None:
    p = _provider(provider_id)
    try:
        _client(app).delete_secret(SecretId=secret_name(app, workspace_id, p.id), ForceDeleteWithoutRecovery=True)
    except Exception as e:
        if _code(e) != "ResourceNotFoundException":
            log("error", "ws.provider_key_not_deleted", provider=p.id, error=type(e).__name__)
            raise ApiError(503, "platform_down", "We could not remove the key right now. Try again in a minute.") from e
    app.store.delete_if(
        cfg.pk(user_id, workspace_id), provcred_sk(p.id), {"userId": [user_id], "workspaceId": [workspace_id]}
    )
    log("info", "ws.provider_key_deleted", provider=p.id)
