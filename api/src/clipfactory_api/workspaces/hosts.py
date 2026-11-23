"""Who runs a model the owner adds (docs/CONTRACTS.md §45.37 G4; the owner's second request §3: "support adding new
models and providers without rebuilding the application").

A model the owner adds, a reasoning model (``MODELDEF#``, Settings › AI › Add a model) or a picture, video or sound
model (``MAKERDEF#``, Settings › Video), names its **host**:

* ``bedrock``: Amazon Bedrock on Lamo Stories' own AWS access (no key; a model id, inference profile id or ARN and its
  Region), as every added model was before hosts;
* ``anthropic``: the Anthropic API (reasoning models only), with the owner's Anthropic key;
* ``openai_compatible``: any public ``https`` address that speaks the OpenAI chat-completions API (``baseUrl``), with
  the owner's key for it (a picture model there is called at ``{baseUrl}/images/generations``);
* ``elevenlabs``: ElevenLabs (sound models only: sound effects and an instrumental music bed, never its
  text-to-speech), with the owner's ElevenLabs key.

The key of a keyed host is saved through Provider keys (``provider_keys``: ``PUT …/providers/{host}/key``, the secret
``cf-prod/workspaces/{ws}/providers/{host}`` as JSON ``{"key"}``, never returned, only a hint) and read by Lamo
Stories' agent on every call. A ``baseUrl`` is checked here without a network call: ``https`` only, no user name or
password, no query or fragment, never a private, loopback, link-local, metadata or other non-public address or an
internal name. A name that **resolves** to such an address can only be caught where the call is made: the agent checks
the address it connects to.
"""

from __future__ import annotations

import ipaddress
import re
from typing import Any, Final
from urllib.parse import urlsplit

from ..errors import bad_request

BEDROCK: Final = "bedrock"
ANTHROPIC: Final = "anthropic"
OPENAI_COMPATIBLE: Final = "openai_compatible"
ELEVENLABS: Final = "elevenlabs"
# Amazon Polly runs only the bundled spoken-voice maker (opt-in, G7): a display host id, never one an added model
# may name, and keyless (the agent's own AWS access).
POLLY: Final = "polly"
HOSTS: Final = (BEDROCK, ANTHROPIC, OPENAI_COMPATIBLE, ELEVENLABS)
REASONING_HOSTS: Final = (BEDROCK, ANTHROPIC, OPENAI_COMPATIBLE)  # where an added reasoning model may run
KEYED: Final = (ANTHROPIC, OPENAI_COMPATIBLE, ELEVENLABS)  # the hosts that take the owner's key (Provider keys)
LABEL: Final = {
    BEDROCK: "Amazon Bedrock",
    ANTHROPIC: "Anthropic API",
    OPENAI_COMPATIBLE: "OpenAI-compatible API",
    ELEVENLABS: "ElevenLabs",
}
BASE_URL_MAX: Final = 300
# The model names a keyed host takes: Anthropic's (``claude-opus-5-5``), ElevenLabs' (``eleven_text_to_sound_v2``)
# and the OpenAI-compatible ones, which may carry a maker and a slash (``meta-llama/Llama-4``) or a tag (``x:70b``).
KEYED_MODEL_ID: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$")
# Names that never reach the public internet (RFC 6761, RFC 8375 and the usual internal suffixes).
LOCAL_NAMES: Final = ("localhost", "instance-data", "metadata", "metadata.google.internal")
LOCAL_SUFFIXES: Final = (
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".intranet",
    ".lan",
    ".home",
    ".home.arpa",
    ".corp",
    ".private",
    ".test",
    ".invalid",
    ".example",
    ".onion",
    ".arpa",
)
_DNS_LABEL: Final = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_NUMERIC_LABEL: Final = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)$")
# IPv6 ranges that carry an IPv4 address inside (NAT64, 6to4, Teredo): refused, whatever the address inside is.
_V6_WRAPPERS: Final = (
    ipaddress.ip_network("64:ff9b::/96"),
    ipaddress.ip_network("64:ff9b:1::/48"),
    ipaddress.ip_network("2002::/16"),
    ipaddress.ip_network("2001::/32"),
)

BAD_HOST: Final = (
    "Pick where the model runs: bedrock (Amazon Bedrock), anthropic (the Anthropic API) or openai_compatible (an "
    "address that speaks the OpenAI chat-completions API)."
)
SOUND_ONLY: Final = "ElevenLabs makes sounds only. Add it as a sound model in Settings › Video."
NEED_BASE_URL: Final = (
    "Paste the address of the OpenAI-compatible API, like https://api.example.com/v1 (the part before "
    "/chat/completions)."
)
BAD_BASE_URL: Final = "That is not a web address. Paste one like https://api.example.com/v1."
NOT_HTTPS: Final = "The address must start with https:// so the key travels safely."
NO_LOGIN_IN_URL: Final = "Leave the name and password out of the address. Save the key in Provider keys instead."
NO_QUERY: Final = "Leave out anything after ? or # in the address."
NOT_PUBLIC: Final = (
    "That address is not on the public internet (a private, local or internal address). Funded Clips can only "
    "call a public https address."
)
BASE_URL_ONLY_OPENAI: Final = "Only a model on an OpenAI-compatible API has an address (baseUrl). Leave it out."
REGION_ONLY_BEDROCK: Final = "Only a model on Amazon Bedrock has a Region. Leave the Region out."
ONE_SERVICE: Final = (
    "Funded Clips keeps one key for one OpenAI-compatible service. Your other OpenAI-compatible models use "
    "{host}: use that address too, or remove those models first."
)
KEY_FOR_OTHER: Final = (
    "Your OpenAI-compatible key is for {saved}. To use {host}, remove that key in Funded Clips › Settings › AI "
    "› Provider keys first, then paste the key for {host}."
)
BAD_KEYED_MODEL_ID: Final = (
    "Type the model's name exactly as its API spells it, like claude-opus-5-5 or meta-llama/Llama-4-Maverick."
)


def host_id(value: Any, *, bundled: bool = False) -> str:
    """The host id of a stored item or a ``models.json`` entry: one of ``HOSTS``. A file entry's ``host`` may be the
    display name ("Amazon Bedrock"); anything not keyed is Amazon Bedrock, as every model was before hosts. Only a
    bundled entry (``bundled``) may be Amazon Polly's (``POLLY``)."""
    text = " ".join(str(value or "").split()).lower()
    if text in HOSTS:
        return text
    if bundled and text in (POLLY, POLLY_LABEL.lower()):
        return POLLY
    for host, label in LABEL.items():
        if text == label.lower():
            return host
    return BEDROCK


POLLY_LABEL: Final = "Amazon Polly"


def host_label(host: str, base_url: Any = None) -> str:
    """Who runs the model, in words (``ModelInfo.host``, §45.35 D8: screens say "{provider} on {host}"): Amazon
    Bedrock, the Anthropic API, ElevenLabs, or an OpenAI-compatible API's own name (its address's host name)."""
    if host == OPENAI_COMPATIBLE and isinstance(base_url, str) and base_url:
        found = urlsplit(base_url).hostname
        if found:
            return found
    return LABEL.get(host, LABEL[BEDROCK])


def clean_host(value: Any, *, allowed: tuple[str, ...] = HOSTS, refused: str | None = None) -> str:
    """``host``: left out (or null) is Amazon Bedrock, as every added model was before hosts."""
    if value is None:
        return BEDROCK
    if not isinstance(value, str) or value not in HOSTS:
        raise bad_request(BAD_HOST, "host")
    if value not in allowed:
        raise bad_request(refused or BAD_HOST, "host")
    return value


def clean_keyed_model_id(value: Any) -> str:
    if not isinstance(value, str) or not KEYED_MODEL_ID.match(value.strip()) or ".." in value:
        raise bad_request(BAD_KEYED_MODEL_ID, "modelId")
    return value.strip()


def empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _numeric_host(host: str) -> bool:
    """Odd spellings of an IPv4 address (``127.1``, ``2130706433``, ``0x7f.0.0.1``) that some resolvers accept."""
    return all(_NUMERIC_LABEL.match(label) for label in host.split(".") if label)


def private_host(host: str) -> bool:
    """True for anything that is not a public internet name or address."""
    name = host.lower().strip("[]").rstrip(".")
    if not name:
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        ip = None
    if ip is not None:
        if isinstance(ip, ipaddress.IPv6Address):
            if ip.ipv4_mapped is not None:
                ip = ip.ipv4_mapped
            elif any(ip in net for net in _V6_WRAPPERS):
                return True
        return not ip.is_global or ip.is_multicast or ip.is_reserved
    if name in LOCAL_NAMES or name.endswith(LOCAL_SUFFIXES):
        return True
    labels = name.split(".")
    if len(labels) < 2 or not all(_DNS_LABEL.match(label) for label in labels):
        return True  # a single-label name resolves inside a network, never on the internet
    return _numeric_host(name) or labels[-1].isdigit()


def clean_base_url(value: Any) -> str:
    """``baseUrl`` of an OpenAI-compatible API: ``https://{public host}[:port][/path]``, without a trailing slash."""
    if empty(value):
        raise bad_request(NEED_BASE_URL, "baseUrl")
    if not isinstance(value, str):
        raise bad_request(BAD_BASE_URL, "baseUrl")
    text = value.strip()
    if len(text) > BASE_URL_MAX or any(ord(c) <= 32 or ord(c) >= 127 or c == "\\" for c in text):
        raise bad_request(BAD_BASE_URL, "baseUrl")
    parts = urlsplit(text)
    if parts.scheme.lower() != "https":
        raise bad_request(NOT_HTTPS, "baseUrl")
    if "@" in parts.netloc:
        raise bad_request(NO_LOGIN_IN_URL, "baseUrl")
    if parts.query or parts.fragment or "?" in text or "#" in text:
        raise bad_request(NO_QUERY, "baseUrl")
    try:
        port = parts.port
    except ValueError as e:
        raise bad_request(BAD_BASE_URL, "baseUrl") from e
    host = (parts.hostname or "").lower().rstrip(".")
    if not host:
        raise bad_request(BAD_BASE_URL, "baseUrl")
    if private_host(host):
        raise bad_request(NOT_PUBLIC, "baseUrl")
    path = parts.path.rstrip("/")
    if any(segment in (".", "..") for segment in path.split("/")) or "%" in path:
        raise bad_request(BAD_BASE_URL, "baseUrl")
    shown = f"[{host}]" if ":" in host else host
    if port is not None and port != 443:
        shown = f"{shown}:{port}"
    return f"https://{shown}{path}"


def origin(base_url: Any) -> str:
    """``https://{host}[:port]`` of a cleaned ``baseUrl`` ("" when there is none): who gets the key."""
    if not isinstance(base_url, str) or not base_url:
        return ""
    parts = urlsplit(base_url)
    return f"{parts.scheme.lower()}://{parts.netloc.lower()}" if parts.scheme and parts.netloc else ""


def origin_host(found: str) -> str:
    """The host name of an origin, for a sentence ("api.groq.com")."""
    return urlsplit(found).hostname or found
