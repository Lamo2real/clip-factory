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
shown ``on`` only after a real call (its ``PROVIDER#`` item) or the model's own check, never because a key was saved:
a keyed host's row reads the newest check, made since the key was saved, of the models the owner added there
(``MODELSTATUS#`` of ``MODELDEF#``, ``MAKERSTATUS#`` of ``MAKERDEF#``).

**One OpenAI-compatible service per workspace, and its key only ever goes there** (§45.37 G4): the
``openai_compatible`` key is for one origin (``https://{host}[:port]``), stored as ``forOrigin`` on ``PROVCRED#`` and as
``origin`` in the secret (``{"key", "origin"}``, so the agent never sends it anywhere else). The origin is the
``baseUrl`` sent with the key, else the one the workspace's OpenAI-compatible models already use; with neither, the
key waits for the model ("Add the model first"). Every OpenAI-compatible model of a workspace uses that one origin
(``check_openai_origin``, on every ``PUT`` of a model): another address is refused while other models use the first
one, and while the saved key is for another origin (remove the key, then paste the one for the new address).
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
from . import deps, hosts
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


def model_checks(store: db.Store, user_id: str, workspace_id: str, host: str) -> list[dict[str, Any]]:
    """The checks of every model the owner added on ``host`` (``MODELSTATUS#`` of his reasoning models,
    ``MAKERSTATUS#`` of his picture, video and sound models), oldest first."""
    from . import makers, model_defs

    keys = {str(i.get("key")) for i in model_defs.items(store, user_id, workspace_id) if i.get("host") == host}
    found = [m for k, m in cfg.model_status_items(store, user_id, workspace_id).items() if k in keys]
    own = {str(i.get("key")) for i in makers.items(store, user_id, workspace_id) if i.get("host") == host}
    found += [m for k, m in makers.status_items(store, user_id, workspace_id).items() if k in own]
    return sorted(found, key=lambda m: str(m.get("checkedAt") or ""))


def status(store: db.Store, user_id: str, workspace_id: str, p: KeyedProvider) -> dict[str, Any]:
    """``ProviderStatus`` of a keyed provider: ``on`` only after a real call (its ``PROVIDER#`` item) or a check of a
    model the owner added there said it works (made since the key was saved), with ``key`` (§45.34: only a provider
    that takes a key has it)."""
    cred = cfg.get_owned(store, user_id, workspace_id, provcred_sk(p.id))
    record = cfg.get_owned(store, user_id, workspace_id, f"{ws.PROVIDER_SK}{p.kind}#{p.id}") or {}
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label, "key": key_state(cred)}
    if cred is None:
        return {**out, "state": "needs_setup", "line": f"Paste your {p.label} key to use it."}
    hint = str(cred.get("hint") or "")
    saved = f"Key saved · ends {hint}." if hint else "Key saved."
    origin = str(cred.get("forOrigin") or "")
    if origin:
        saved = f"Key saved for {hosts.origin_host(origin)}" + (f" · ends {hint}." if hint else ".")
    saved_at = str(cred.get("savedAt") or "")
    checks = [m for m in model_checks(store, user_id, workspace_id, p.id) if str(m.get("checkedAt") or "") >= saved_at]
    newest = checks[-1] if checks else None
    record_at = str(record.get("checkedAt") or "")
    if newest is not None and str(newest.get("checkedAt") or "") > record_at:
        at = str(newest["checkedAt"])
        if newest.get("status") == "ok":
            return {**out, "state": "on", "line": saved, "checkedAt": at}
        if newest.get("status") in ("denied", "not_found", "error", "failed"):
            line = str(newest.get("line") or "") or cfg.STATUS_LINE.get(str(newest.get("status")), "")
            return {**out, "state": "needs_setup", "line": line or saved, "lastError": line or saved, "checkedAt": at}
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


NEED_MODEL_FIRST: Final = (
    "Add the model on your OpenAI-compatible API first (Lamo Stories › Settings › AI › Add a model), then paste its "
    "key, so Lamo Stories knows the one address it is for."
)
BASE_URL_ONLY_FOR_OPENAI: Final = "Only an OpenAI-compatible key is for an address (baseUrl). Leave it out."


def openai_origins(store: db.Store, user_id: str, workspace_id: str, *, skip: str | None = None) -> set[str]:
    """The origins every OpenAI-compatible model of this workspace uses (reasoning and picture models), but ``skip``."""
    from . import makers, model_defs

    found = [*model_defs.items(store, user_id, workspace_id), *makers.items(store, user_id, workspace_id)]
    return {
        hosts.origin(i.get("baseUrl"))
        for i in found
        if i.get("host") == hosts.OPENAI_COMPATIBLE and i.get("key") != skip and hosts.origin(i.get("baseUrl"))
    }


def check_openai_origin(store: db.Store, user_id: str, workspace_id: str, key: str, base_url: str) -> None:
    """Every OpenAI-compatible model of a workspace uses one origin, the one its saved key is for (409 otherwise):
    the key is never sent to another address."""
    origin = hosts.origin(base_url)
    others = openai_origins(store, user_id, workspace_id, skip=key)
    if others and origin not in others:
        raise conflict(hosts.ONE_SERVICE.format(host=hosts.origin_host(sorted(others)[0])))
    cred = cfg.get_owned(store, user_id, workspace_id, provcred_sk(hosts.OPENAI_COMPATIBLE))
    saved = str((cred or {}).get("forOrigin") or "")
    if cred is not None and saved and saved != origin:
        raise conflict(
            hosts.KEY_FOR_OTHER.format(saved=hosts.origin_host(saved), host=hosts.origin_host(origin)), "baseUrl"
        )


def _key_origin(app: Any, user_id: str, workspace_id: str, provider_id: str, body: Mapping[str, Any]) -> str:
    """The origin a key is for: only an OpenAI-compatible key has one (its ``baseUrl``, else its models')."""
    if provider_id != hosts.OPENAI_COMPATIBLE:
        if not hosts.empty(body.get("baseUrl")):
            raise bad_request(BASE_URL_ONLY_FOR_OPENAI, "baseUrl")
        return ""
    used = openai_origins(app.store, user_id, workspace_id)
    if not hosts.empty(body.get("baseUrl")):
        origin = hosts.origin(hosts.clean_base_url(body.get("baseUrl")))
        if used and origin not in used:
            raise conflict(hosts.ONE_SERVICE.format(host=hosts.origin_host(sorted(used)[0])), "baseUrl")
        return origin
    if len(used) != 1:
        raise conflict(NEED_MODEL_FIRST)
    return next(iter(used))


def put_key(
    app: Any, user_id: str, workspace_id: str, provider_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("key", "baseUrl"))
    raw = body.get("key")
    if not isinstance(raw, str) or not raw.strip():
        raise bad_request("Paste the key.", "key")
    key = raw.strip()
    if len(key.encode()) > KEY_MAX:
        raise bad_request("That key is too long (at most 4 KB).", "key")
    p = _provider(provider_id)
    origin = _key_origin(app, user_id, workspace_id, p.id, body)
    name = secret_name(app, workspace_id, p.id)
    text = json.dumps({"key": key, **({"origin": origin} if origin else {})}, separators=(",", ":"))
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
            **({"forOrigin": origin} if origin else {}),
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
