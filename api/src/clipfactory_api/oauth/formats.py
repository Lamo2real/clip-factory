"""Key formats and masked hints (docs/CONTRACTS.md §17.4 "Key formats").

The same patterns live in ``web/src/lib/keyFormats.ts``. Values are trimmed and stripped of quotes and zero-width
characters first (copying from a web page often brings them along). TikTok and X are lenient on purpose: **Check
it** is the real test. A Meta Login URL pasted in the Configuration ID box gives its ``config_id``.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

from ..errors import bad_request

KEY_NAMES = ("clientId", "clientSecret", "configId")
_INVISIBLE = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff\u00ad\"'`\u201c\u201d\u2018\u2019]")

YOUTUBE_ID = re.compile(r"^[0-9]{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$")
YOUTUBE_SECRET = re.compile(r"^GOCSPX-[A-Za-z0-9_-]{20,40}$")
TIKTOK_ID = re.compile(r"^[A-Za-z0-9]{10,64}$")
TIKTOK_SECRET = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
META_ID = re.compile(r"^[0-9]{10,20}$")
META_SECRET = re.compile(r"^[a-f0-9]{32}$")
X_ID = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
X_SECRET = re.compile(r"^[A-Za-z0-9_-]{40,80}$")

# (pattern, what the owner sees when the value does not fit)
FORMATS: dict[str, dict[str, tuple[re.Pattern[str], str]]] = {
    "youtube": {
        "clientId": (YOUTUBE_ID, "The Client ID ends with .apps.googleusercontent.com. Copy it again."),
        "clientSecret": (YOUTUBE_SECRET, "The Client secret starts with GOCSPX-. Copy it again."),
    },
    "tiktok": {
        "clientId": (TIKTOK_ID, "The Client key is letters and numbers only. Copy it again."),
        "clientSecret": (TIKTOK_SECRET, "The Client secret is a long line of letters and numbers. Copy it again."),
    },
    "instagram": {
        "clientId": (META_ID, "The App ID is only numbers. Copy it again."),
        "clientSecret": (META_SECRET, "The App secret is 32 letters and numbers. Press Show, then copy it again."),
        "configId": (META_ID, "The Configuration ID is only numbers. Copy it again."),
    },
    "facebook": {
        "clientId": (META_ID, "The App ID is only numbers. Copy it again."),
        "clientSecret": (META_SECRET, "The App secret is 32 letters and numbers. Press Show, then copy it again."),
        "configId": (META_ID, "The Configuration ID is only numbers. Copy it again."),
    },
    "x": {
        "clientId": (X_ID, "The Client ID is a long line of letters and numbers. Copy it again."),
        "clientSecret": (X_SECRET, "The Client Secret is a long line of letters and numbers. Copy it again."),
    },
}


def clean(value: str) -> str:
    return _INVISIBLE.sub("", value).strip()


def config_id_from(value: str) -> str:
    """A Meta Login URL (``...?config_id=123...``) gives its ``config_id``; anything else is returned cleaned."""
    text = clean(value)
    if text.lower().startswith(("https://", "http://")):
        found = parse_qs(urlsplit(text).query).get("config_id")
        if found and found[0]:
            return clean(found[0])
    return text


def needs(platform: str) -> tuple[str, ...]:
    return tuple(FORMATS[platform])


def check(platform: str, name: str, value: object) -> str:
    """The cleaned value, or a ``bad_request`` with the friendly sentence."""
    pattern, message = FORMATS[platform][name]
    if not isinstance(value, str):
        raise bad_request(message)
    text = config_id_from(value) if name == "configId" else clean(value)
    if not text or len(text) > 400 or not pattern.match(text):
        raise bad_request(message)
    return text


def matches(platform: str, name: str, value: str) -> bool:
    pattern, _ = FORMATS[platform][name]
    return bool(pattern.match(value))


def hint(name: str, value: str) -> str:
    """``clientId``: first 6 + "…" + last 4; secrets: "••••" + last 4; ``configId``: last 4."""
    if name == "clientId":
        return f"{value[:6]}…{value[-4:]}" if len(value) > 10 else f"{value[:2]}…"
    if name == "configId":
        return value[-4:]
    return f"••••{value[-4:]}"
