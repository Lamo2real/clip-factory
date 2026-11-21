"""``sitemap.xml`` (docs/CONTRACTS.md §41.2 row 2). Pure.

Only ``<url>`` entries whose ``<loc>`` is exactly ``https://contentrewards.com/c/campaigns/{uuid}`` are kept (the uuid
in any case, kept lower-case; no query, no fragment, nothing after the uuid), with their ``<lastmod>`` as epoch
seconds (``None`` when missing or unreadable), at most 5,000. A ``<sitemapindex>`` names child sitemaps; only those on
``contentrewards.com`` are kept (at most 5). Read with plain patterns, never an XML parser that could resolve entities.
``entries_gz`` / ``entries_from_gz`` are ``CRPUBLIC/STATE.entriesGz``: the gzip of ``"{uuid as 32 hex},{lastmod}\\n"``
lines (an unknown lastmod is written empty).
"""

from __future__ import annotations

import gzip
import html
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from . import config

Entry = tuple[str, int | None]  # (uuid, lastmod as epoch seconds)

_CAMPAIGN = re.compile(
    r"^https://contentrewards\.com/c/campaigns/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)
_CHILD = re.compile(r"^https://contentrewards\.com/[A-Za-z0-9._/-]{1,200}$")
_URL = re.compile(r"<(?:\w+:)?url>(.*?)</(?:\w+:)?url>", re.DOTALL | re.IGNORECASE)
_SITEMAP = re.compile(r"<(?:\w+:)?sitemap>(.*?)</(?:\w+:)?sitemap>", re.DOTALL | re.IGNORECASE)
_LOC = re.compile(r"<(?:\w+:)?loc>\s*(.*?)\s*</(?:\w+:)?loc>", re.DOTALL | re.IGNORECASE)
_LASTMOD = re.compile(r"<(?:\w+:)?lastmod>\s*(.*?)\s*</(?:\w+:)?lastmod>", re.DOTALL | re.IGNORECASE)
_INDEX = re.compile(r"<(?:\w+:)?sitemapindex[\s>]", re.IGNORECASE)
_URLSET = re.compile(r"<(?:\w+:)?urlset[\s>]", re.IGNORECASE)


class SitemapError(Exception):
    """Neither a ``<urlset>`` nor a ``<sitemapindex>``."""


@dataclass(frozen=True)
class Sitemap:
    kind: str  # "urlset" | "index"
    entries: list[Entry]
    children: list[str]


def _text(raw: str) -> str:
    text = raw.strip()
    if text.startswith("<![CDATA[") and text.endswith("]]>"):
        text = text[9:-3]
    return html.unescape(text).strip()


def lastmod_seconds(text: str) -> int | None:
    """W3C datetime (``2026-11-14T17:23:44.000Z``, ``2026-11-14``, with an offset) → epoch seconds."""
    value = text.strip()
    if not value:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        value += "T00:00:00+00:00"
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp())


def campaign_uuid(loc: str) -> str | None:
    found = _CAMPAIGN.match(loc)
    return found.group(1).lower() if found else None


def parse(body: bytes) -> Sitemap:
    text = body.decode("utf-8", errors="replace")
    if _INDEX.search(text):
        children: list[str] = []
        for block in _SITEMAP.findall(text):
            loc = _LOC.search(block)
            url = _text(loc.group(1)) if loc else ""
            if _CHILD.match(url) and url not in children:
                children.append(url)
            if len(children) >= config.SITEMAP_CHILDREN:
                break
        return Sitemap("index", [], children)
    if not _URLSET.search(text):
        raise SitemapError("not a sitemap")
    entries: list[Entry] = []
    seen: set[str] = set()
    for block in _URL.findall(text):
        loc = _LOC.search(block)
        uuid = campaign_uuid(_text(loc.group(1))) if loc else None
        if uuid is None or uuid in seen:
            continue
        seen.add(uuid)
        mod = _LASTMOD.search(block)
        entries.append((uuid, lastmod_seconds(_text(mod.group(1))) if mod else None))
        if len(entries) >= config.MAX_ENTRIES:
            break
    return Sitemap("urlset", entries, [])


def merge(parts: list[list[Entry]]) -> list[Entry]:
    """Child sitemaps in order, without repeats, at most 5,000."""
    out: list[Entry] = []
    seen: set[str] = set()
    for part in parts:
        for uuid, lastmod in part:
            if uuid in seen:
                continue
            seen.add(uuid)
            out.append((uuid, lastmod))
            if len(out) >= config.MAX_ENTRIES:
                return out
    return out


def entries_gz(entries: list[Entry]) -> bytes:
    lines = "".join(
        f"{uuid.replace('-', '')},{'' if lastmod is None else lastmod}\n"
        for uuid, lastmod in entries[: config.MAX_ENTRIES]
    )
    return gzip.compress(lines.encode("ascii"), mtime=0)


def entries_from_gz(blob: object) -> list[Entry]:
    """The stored value: ``bytes`` (the test table) or boto3's ``Binary`` (``.value``). Anything unreadable → []."""
    raw = getattr(blob, "value", blob)
    if not isinstance(raw, bytes | bytearray):
        return []
    try:
        text = gzip.decompress(bytes(raw)).decode("ascii")
    except (OSError, EOFError, UnicodeDecodeError):
        return []
    out: list[Entry] = []
    for line in text.splitlines():
        hexed, _, mod = line.partition(",")
        if not re.fullmatch(r"[0-9a-f]{32}", hexed):
            continue
        uuid = f"{hexed[:8]}-{hexed[8:12]}-{hexed[12:16]}-{hexed[16:20]}-{hexed[20:]}"
        out.append((uuid, int(mod) if mod.isdigit() else None))
    return out[: config.MAX_ENTRIES]
