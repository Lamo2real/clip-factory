"""Lamo Stories' own configuration files (``stories/config``, copied to ``/app/stories/config`` in the image).

SCAFFOLD (Phase 1): the loaders every builder uses; builders E and E2 extend them additively.

The bundled model list (``models.json``) is read once per process. The models an owner added in Lamo Stories ›
Settings › AI (``MODELDEF#{key}`` items of the workspace, docs/CONTRACTS.md §45.34 "Adding models without a release")
are merged over it per call (``merged_models``), never cached across workspaces.

The makers' models (docs/CONTRACTS.md §45.37 G1, G2, G7): ``imageModels``, ``videoModels`` and ``audioModels`` of
``models.json`` (a file with only the old single ``imageModel`` / ``videoModel`` reads as a one-item list, so nothing
breaks) and the workspace's own ``MAKERDEF#{key}`` items, merged per job (``merged_makers``), never cached across
workspaces. A model the owner adds, reasoning or maker, names its host (§45.37 G4): ``bedrock`` (the app's own AWS
access), ``anthropic`` (the Anthropic API), ``openai_compatible`` (any https base URL that speaks the OpenAI
chat-completions API) or, for sound only, ``elevenlabs``; the keyed hosts use the owner's own key, read per call.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
from collections.abc import Iterable, Mapping, Sequence
from functools import cache
from pathlib import Path
from typing import Any

EFFORTS = ("low", "medium", "high", "xhigh", "max")
CUSTOM_KEY = re.compile(r"^custom-[a-z0-9-]{1,40}$")
MAX_CUSTOM = 20
MODELDEF_PREFIX = "MODELDEF#"
# How a model takes its effort (§45.35 D1, §45.37 G4): the Anthropic field (Bedrock and the Anthropic API), the
# OpenAI chat-completions field (an openai_compatible host only), or none.
EFFORT_FIELDS = ("output_config", "reasoning_effort", "none")
REASONING_EFFORT = "reasoning_effort"
HOST = "Amazon Bedrock"  # who runs the bundled reasoning models (§45.35 D8); ``provider`` is the maker
# Where a model the owner adds runs (§45.37 G4); the keyed ones use the owner's own key.
HOSTS = ("bedrock", "anthropic", "openai_compatible")
KEYED_HOSTS = ("anthropic", "openai_compatible", "elevenlabs")
HOST_LABELS = {
    "bedrock": HOST,
    "anthropic": "the Anthropic API",
    "openai_compatible": "the OpenAI-compatible API",
    "elevenlabs": "ElevenLabs",
    "polly": "Amazon Polly",
}
HOST_NAMES = {  # the host as a screen names it ("{provider} on {host}", §45.35 D8)
    "bedrock": HOST,
    "anthropic": "Anthropic API",
    "openai_compatible": "OpenAI-compatible API",
    "elevenlabs": "ElevenLabs",
    "polly": "Amazon Polly",
}

# The makers (§45.37 G1, G7): picture, video and sound models, listed per kind.
MAKER_KINDS = ("image", "video", "audio")
MAKER_LISTS = {"image": "imageModels", "video": "videoModels", "audio": "audioModels"}
LEGACY_MAKERS = {"image": ("imageModel", "nova-canvas"), "video": ("videoModel", "nova-reel")}  # the old one-item shape
MAKERDEF_PREFIX = "MAKERDEF#"
OWN_MAKERS = {"image": "own-images", "video": "own-video", "audio": "own-sound"}  # the owner's own models' makers
# The hosts a maker model the owner adds may use, per kind. Video makers are Bedrock only; a Bedrock sound model is
# allowed so one Amazon adds later works without a release (Bedrock lists none today).
MAKER_HOSTS = {"image": ("bedrock", "openai_compatible"), "video": ("bedrock",), "audio": ("elevenlabs", "bedrock")}
# What a Bedrock maker model the owner adds may be: Lamo Stories knows how to ask these for pictures and video.
BEDROCK_PICTURES = ("stability.", "amazon.titan-image", "amazon.nova-canvas")
BEDROCK_VIDEO = ("luma.", "amazon.nova-reel")
ROLES = ("effects", "music", "voice")  # which part of the sound a sound model makes
MAKER_KIND_OF = {"images": "image", "animation": "video", "audio": "audio"}  # registry kind -> model kind
MAKER_REGION = "us-west-2"  # a Bedrock maker model's Region when its entry names none (Stability AI, Luma AI Ray2)
PICK_FIELDS = {"image": "imageModel", "video": "videoModel", "audio": "audioModel"}  # StoriesConfig.providers' picks
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def config_dir() -> Path:
    """``CF_STORIES_CONFIG_DIR`` in the image; the repository's ``stories/config`` in tests."""
    found = os.environ.get("CF_STORIES_CONFIG_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[3] / "config"


def skills_dir() -> Path:
    found = os.environ.get("CF_STORIES_SKILLS_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[3] / "skills"


def engine_dir() -> Path:
    """The engine folder (``web/src/stories/engine`` in the repository, ``/app/stories-engine`` in the image)."""
    found = os.environ.get("CF_STORIES_ENGINE_DIR")
    if found:
        return Path(found)
    return Path(__file__).resolve().parents[4] / "web" / "src" / "stories" / "engine"


@cache
def models() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "models.json").read_text()))


@cache
def agents() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "agents.json").read_text()))


@cache
def guidance() -> dict[str, Any]:
    return dict(json.loads((config_dir() / "guidance.json").read_text()))


def model(key: str, catalog: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """One model of ``catalog`` (a ``merged_models`` answer), or of the bundled list when none is given."""
    for m in (catalog if catalog is not None else models())["models"]:
        if m["key"] == key:
            return dict(m)
    return None


def _flag(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


PROFILE_PREFIXES = ("global", "us", "eu", "apac", "jp", "au", "ca", "us-gov")  # an inference profile's geography


def maker(info: Mapping[str, Any]) -> str:
    """Who makes a model, lower case: its ``provider``. A bundled entry whose provider is empty or names the host
    (the first ``models.json`` said "Amazon Bedrock") is named from its Bedrock model id (``anthropic.…``), as the
    API names it (§45.35 D8); an added model's is what the owner typed, as the API's ``calling`` reads it."""
    provider = " ".join(str(info.get("provider") or "").split()).lower()
    if info.get("custom") or provider not in ("", HOST.lower()):
        return provider
    parts = str(info.get("modelId") or "").rsplit("/", 1)[-1].split(".")
    if len(parts) > 2 and parts[0] in PROFILE_PREFIXES:
        parts = parts[1:]
    return parts[0].lower() if len(parts) > 1 else provider


def host_of(info: Mapping[str, Any]) -> str:
    """Where a model runs (§45.37 G4): ``bedrock`` for the bundled models and an added model saved before hosts
    existed, else the added model's own host (``anthropic`` | ``openai_compatible``; ``elevenlabs`` or ``polly`` for
    a sound model)."""
    raw = str(info.get("hostId") or "").strip().lower()
    if raw in (*HOSTS, *KEYED_HOSTS, "polly"):
        return raw
    shown = str(info.get("host") or "").strip().lower()
    if shown in (*HOSTS, *KEYED_HOSTS):
        return shown
    return "polly" if shown == "amazon polly" else "bedrock"


def call_shape(info: Mapping[str, Any]) -> tuple[str, bool, bool]:
    """How a model is called (§45.35 D1, §45.37 G4): ``(effortField, tools, cache)``. A model's own fields win;
    without them the maker decides: Anthropic's models take ``output_config.effort``, tools and cache points; Amazon's
    take cache points only; any other maker's none of the three. The bundled Claude models are Anthropic's. A model on
    an OpenAI-compatible host takes only ``reasoning_effort`` (never ``output_config``) and no cache points; one on the
    Anthropic API never takes ``reasoning_effort``. The API's ``model_defs.calling`` reads an added model the same way."""
    provider = maker(info)
    host = host_of(info)
    anthropic, amazon = provider == "anthropic" or host == "anthropic", provider == "amazon"
    field = info.get("effortField")
    if host == "openai_compatible":
        effort_field = REASONING_EFFORT if field == REASONING_EFFORT else "none"
        return effort_field, _flag(info.get("tools"), anthropic), False
    if field == REASONING_EFFORT:  # the OpenAI field means nothing to Bedrock or the Anthropic API
        field = "none"
    effort_field = str(field) if field in EFFORT_FIELDS else ("output_config" if anthropic else "none")
    if host == "anthropic":
        return effort_field, _flag(info.get("tools"), True), _flag(info.get("cache"), True)
    return effort_field, _flag(info.get("tools"), anthropic), _flag(info.get("cache"), anthropic or amazon)


def offered_efforts(info: Mapping[str, Any]) -> list[str]:
    """The efforts a model really takes: its list when it takes ``output_config.effort``, else none (§45.35 D1)."""
    if call_shape(info)[0] == "none":
        return []
    return [str(e) for e in info.get("efforts") or [] if e in EFFORTS]


def model_from_def(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A ``MODELDEF#{key}`` item (the owner's ``ModelDef``: label, provider, modelId, region, efforts, defaultEffort,
    vision, maxOutputTokens, price, effortField, tools, cache, host, baseUrl) as an entry of the model list, or None
    when it cannot be used: a key that is not ``custom-…`` or that shadows a bundled model, no model id, an unknown
    host, or an OpenAI-compatible host without a safe https base URL (§45.37 G4). It is called by its own model id (on
    Bedrock a model id, an inference profile id or an ARN, in its own Region; on a keyed host the host's own model
    name) and offers exactly the efforts the owner listed, and only when it takes an effort field (``effortField``; a
    model whose field is ``none``, the default for any maker but Anthropic, offers none, §45.35 D1)."""
    nested = item.get("model")
    body: Mapping[str, Any] = nested if isinstance(nested, Mapping) else item
    key = str(item.get("key") or body.get("key") or str(item.get("sk") or "").removeprefix(MODELDEF_PREFIX))
    if not CUSTOM_KEY.match(key) or key in bundled_keys():
        return None
    model_id = str(body.get("modelId") or "").strip()
    if not model_id:
        return None
    host = str(body.get("host") or "bedrock").strip().lower()
    if host in ("amazon bedrock", ""):
        host = "bedrock"
    if host not in HOSTS:
        return None
    base_url = safe_base_url(body.get("baseUrl")) if host == "openai_compatible" else None
    if host == "openai_compatible" and base_url is None:
        return None
    provider = str(body.get("provider") or "").strip()
    effort_field, tools, cache_points = call_shape({**body, "provider": provider, "custom": True, "hostId": host})
    efforts = [str(e) for e in body.get("efforts") or [] if e in EFFORTS] if effort_field != "none" else []
    default = body.get("defaultEffort")
    region = (str(body.get("region") or "").strip() or None) if host == "bedrock" else None
    price = body.get("price")
    try:
        out_tokens = int(body.get("maxOutputTokens") or 0) or None
    except (TypeError, ValueError):
        out_tokens = None
    entry: dict[str, Any] = {
        "key": key,
        "label": str(body.get("label") or key).strip() or key,
        "provider": provider or ("Anthropic" if host == "anthropic" else HOST_NAMES[host]),
        "host": HOST_NAMES[host],
        "hostId": host,
        "modelId": model_id,
        "profile": model_id,
        "region": region,
        "regions": [region] if region else [],
        "efforts": list(dict.fromkeys(efforts)),
        "defaultEffort": default if default in efforts else None,
        "vision": body.get("vision") is True,
        "maxOutputTokens": out_tokens,
        "pricing": dict(price) if isinstance(price, Mapping) else None,
        "effortField": effort_field,
        "tools": tools,
        "cache": cache_points,
        "custom": True,
    }
    if base_url:
        entry["baseUrl"] = base_url
    return entry


def merged_models(defs: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """The bundled list with the workspace's own models after it (at most ``MAX_CUSTOM``, in key order); a bundled
    model is never replaced."""
    base = models()
    seen = {str(m["key"]) for m in base["models"]}
    extra: list[dict[str, Any]] = []
    for item in sorted(defs, key=lambda d: str(d.get("sk") or d.get("key") or "")):
        entry = model_from_def(item)
        if entry is None or entry["key"] in seen or len(extra) >= MAX_CUSTOM:
            continue
        seen.add(entry["key"])
        extra.append(entry)
    return {**base, "models": [*base["models"], *extra]}


# --- the hosts' addresses (§45.37 G4) --------------------------------------------------------------------------------

_BLOCKED_NAMES = ("localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default")
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet")


def public_ip(address: str) -> bool:
    """True for an address on the public internet: never loopback, private, link-local (the instance metadata
    service lives there: 169.254.169.254, fd00:ec2::254), multicast, reserved or unspecified."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address) and ip in ipaddress.ip_network("fd00:ec2::/32"):
        return False
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip.is_loopback)


def safe_host(host: str) -> bool:
    """A host name an added model may call: a real public DNS name, or a public IP address. Names that only mean
    something inside a network (localhost, ``*.internal``, the metadata names) are refused here; the address it
    resolves to is checked again on every call (``hosts.https``)."""
    name = host.strip().lower().rstrip(".")
    if not name or len(name) > 253:
        return False
    literal = name.strip("[]")
    try:
        ipaddress.ip_address(literal.split("%", 1)[0])
    except ValueError:
        pass
    else:
        return public_ip(literal)
    if name in _BLOCKED_NAMES or name.endswith(_BLOCKED_SUFFIXES) or "." not in name:
        return False
    return all(re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", part) for part in name.split("."))


def safe_base_url(value: Any) -> str | None:
    """An added model's ``baseUrl`` without a trailing slash, or None: https only, a public host name or address, no
    user name or password, no query or fragment (§45.37 G4: no private, link-local or metadata addresses)."""
    from urllib.parse import urlsplit

    raw = str(value or "").strip().rstrip("/")
    if not raw or len(raw) > 500 or any(c.isspace() or ord(c) < 32 for c in raw):
        return None
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or parts.username or parts.password or parts.query or parts.fragment:
        return None
    if port is not None and not 1 <= port <= 65535:
        return None
    return raw if parts.hostname and safe_host(parts.hostname) else None


# --- the makers' models (§45.37 G1, G2, G7) --------------------------------------------------------------------------


def _maker_entry(raw: Mapping[str, Any], kind: str, *, key: str, maker_id: str) -> dict[str, Any]:
    host = host_of(raw)
    price = raw.get("price", raw.get("pricing"))
    out: dict[str, Any] = {
        "key": key,
        "label": str(raw.get("label") or key),
        "provider": str(raw.get("provider") or ""),
        "maker": maker_id,
        "host": HOST_NAMES.get(host, HOST),
        "hostId": host,
        "modelId": str(raw.get("modelId") or ""),
        "region": (str(raw.get("region") or "") or None) if host in ("bedrock", "polly") else None,
        "kind": kind,
        "price": dict(price) if isinstance(price, Mapping) else None,
        "note": str(raw.get("note") or ""),
        "ended": str(raw.get("ended") or "") or None,
        "custom": False,
    }
    for extra in ("role", "voice", "shotSec"):
        if raw.get(extra) is not None:
            out[extra] = raw[extra]
    if kind == "audio" and out.get("role") not in ROLES:
        out["role"] = role_of(out)
    return out


def role_of(entry: Mapping[str, Any]) -> str:
    """Which part of the sound a sound model makes: its own ``role``, else ``music`` for a music model id
    (``music_…``), ``voice`` on Amazon Polly, else ``effects``."""
    role = entry.get("role")
    if role in ROLES:
        return str(role)
    if host_of(entry) == "polly":
        return "voice"
    return "music" if str(entry.get("modelId") or "").lower().startswith("music") else "effects"


def bundled_makers(kind: str, listed: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """The bundled models of one maker kind (``image`` | ``video`` | ``audio``), in file order. A file with only the
    old single ``imageModel`` / ``videoModel`` reads as a one-item list (Nova Canvas, Nova Reel), so nothing breaks."""
    src = listed if listed is not None else models()
    found = src.get(MAKER_LISTS[kind])
    if isinstance(found, list):
        return [
            _maker_entry(m, kind, key=str(m["key"]), maker_id=str(m.get("maker") or m["key"]))
            for m in found
            if isinstance(m, Mapping) and m.get("key") and m.get("modelId")
        ]
    legacy = LEGACY_MAKERS.get(kind)
    one = src.get(legacy[0]) if legacy else None
    if legacy and isinstance(one, Mapping) and one.get("modelId"):
        return [_maker_entry({**one, "ended": one.get("ended")}, kind, key=legacy[1], maker_id=legacy[1])]
    return []


def bundled_keys() -> set[str]:
    """Every bundled key, reasoning and maker: a model the owner adds never shadows one."""
    found = {str(m["key"]) for m in models()["models"]}
    return found | {m["key"] for kind in MAKER_KINDS for m in bundled_makers(kind)}


def maker_from_def(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A ``MAKERDEF#{key}`` item (the owner's own picture, video or sound model: label, provider, kind, host, modelId,
    region, baseUrl, price, note, and for sound an optional ``role``) as a maker entry of the kind's own maker
    (``own-images`` | ``own-video`` | ``own-sound``), or None when it cannot be used: a key that is not ``custom-…``
    or shadows a bundled key, an unknown kind, a host that kind cannot use (pictures: Amazon Bedrock or an
    OpenAI-compatible API; video: Amazon Bedrock; sound: ElevenLabs or Amazon Bedrock), a Bedrock picture or video
    model Lamo Stories cannot ask (pictures: ``stability.*``, ``amazon.titan-image*``, ``amazon.nova-canvas*``; video:
    ``luma.*``, ``amazon.nova-reel*``), no model id, or an OpenAI-compatible model without a safe https base URL."""
    nested = item.get("model")
    body: Mapping[str, Any] = nested if isinstance(nested, Mapping) else item
    key = str(item.get("key") or body.get("key") or str(item.get("sk") or "").removeprefix(MAKERDEF_PREFIX))
    kind = str(body.get("kind") or item.get("kind") or "")
    if not CUSTOM_KEY.match(key) or kind not in MAKER_KINDS or key in bundled_keys():
        return None
    host = str(body.get("host") or "bedrock").strip().lower()
    if host == "amazon bedrock":
        host = "bedrock"
    model_id = str(body.get("modelId") or "").strip()
    if host not in MAKER_HOSTS[kind] or not model_id:
        return None
    if host == "bedrock" and kind == "image" and not model_id.startswith(BEDROCK_PICTURES):
        return None
    if host == "bedrock" and kind == "video" and not model_id.startswith(BEDROCK_VIDEO):
        return None
    base_url = safe_base_url(body.get("baseUrl")) if host == "openai_compatible" else None
    if host == "openai_compatible" and base_url is None:
        return None
    price = body.get("price")
    out: dict[str, Any] = {
        "key": key,
        "label": str(body.get("label") or key).strip() or key,
        "provider": str(body.get("provider") or "").strip() or HOST_NAMES[host],
        "maker": OWN_MAKERS[kind],
        "host": HOST_NAMES[host],
        "hostId": host,
        "modelId": model_id,
        "region": (str(body.get("region") or "").strip() or None) if host == "bedrock" else None,
        "kind": kind,
        "price": dict(price) if isinstance(price, Mapping) else None,
        "note": str(body.get("note") or ""),
        "ended": None,
        "custom": True,
    }
    if base_url:
        out["baseUrl"] = base_url
    if kind == "audio":
        out["role"] = role_of({**out, "role": body.get("role")})
        if out["role"] == "voice":  # a spoken voice is Amazon Polly's alone, and only when the owner picks it
            return None
    return out


def merged_makers(defs: Iterable[Mapping[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Per kind, the bundled models and then the workspace's own (``MAKERDEF#``, at most ``MAX_CUSTOM`` per kind, in
    key order); a bundled model is never replaced. Read per job, never cached across workspaces."""
    out = {kind: bundled_makers(kind) for kind in MAKER_KINDS}
    seen = {m["key"] for kind in MAKER_KINDS for m in out[kind]}
    for item in sorted(defs, key=lambda d: str(d.get("sk") or d.get("key") or "")):
        entry = maker_from_def(item)
        if entry is None or entry["key"] in seen:
            continue
        if sum(1 for m in out[entry["kind"]] if m["custom"]) >= MAX_CUSTOM:
            continue
        seen.add(entry["key"])
        out[entry["kind"]].append(entry)
    return out


def models_of(
    maker_id: str, kind: str, makers: Mapping[str, Sequence[Mapping[str, Any]]] | None = None
) -> list[dict[str, Any]]:
    """The models of one maker, in order (the bundled list when ``makers`` is not given)."""
    listed = (makers if makers is not None else {kind: bundled_makers(kind)}).get(kind) or []
    return [dict(m) for m in listed if m.get("maker") == maker_id]


def maker_entry(key: str, makers: Mapping[str, Sequence[Mapping[str, Any]]] | None = None) -> dict[str, Any] | None:
    """One maker model by its key, of any kind (the bundled lists when ``makers`` is not given)."""
    found = makers if makers is not None else {k: bundled_makers(k) for k in MAKER_KINDS}
    for kind in MAKER_KINDS:
        for m in found.get(kind) or []:
            if m.get("key") == key:
                return dict(m)
    return None


def pick_model(
    kind: str, maker_id: str, picked: Any, makers: Mapping[str, Sequence[Mapping[str, Any]]] | None = None
) -> dict[str, Any] | None:
    """The model a maker makes with (§45.37 G1): the picked key when it is one of that maker's models, else, with no
    pick, the maker's first model that has not ended. None when the pick is not one of its models (never another model
    in its place) or the maker has no model that has not ended (an ended pick is returned, so the caller can refuse it
    with its own sentence)."""
    listed = models_of(maker_id, kind, makers)
    if isinstance(picked, str) and picked:
        return next((m for m in listed if m["key"] == picked), None)
    return next((m for m in listed if not m.get("ended")), None)


def ended(entry: Mapping[str, Any] | None) -> bool:
    return bool((entry or {}).get("ended"))


def ended_words(day: str) -> str:
    """``2026-09-30`` as "30 Sep 2026"."""
    try:
        y, m, d = (int(x) for x in str(day)[:10].split("-"))
        return f"{d} {MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return str(day)
