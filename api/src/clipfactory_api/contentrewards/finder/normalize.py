"""A campaign page's two queries → one ``FinderCard`` (docs/CONTRACTS.md §41.2 "Normalizing", §41.3). Pure.

Pay, places and budget come from the detail through A's ``campaigns`` helpers (the same §38.10 object they read as
JSON); the toggles through ``rules.toggles``; categories from the Discover card first. The overlay, sound and
audience signals and the page language are read from the brand's text here, and that text is **not stored**.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime
from typing import Any

from .. import campaigns, links, rules
from ..util import obj
from . import config

Item = dict[str, Any]

NEGATIONS = ("no", "not", "don't", "dont", "without", "never")
MUSTS = ("must", "required", "require", "requires", "need", "needs", "include", "includes", "use", "add", "put")
_CATEGORY_ID = re.compile(r"^[a-z0-9-]{1,40}$")
_TAG = re.compile(r"<[^>]{0,500}>")
_WORD = re.compile(r"[^\W_]+(?:'[^\W_]+)?")


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text.replace("\u2019", "'"))]


def _has(words: list[str], wanted: Iterable[str]) -> bool:
    found = set(words)
    return any(w in found for w in wanted)


def sentences(text: str) -> list[str]:
    """Every "U.S." is first written "US"; then the text is split at ``.``, ``!``, ``?`` and line breaks."""
    plain = _TAG.sub("\n", text or "").replace("U.S.", "US")
    return [part.strip() for part in re.split(r"[.!?\r\n]+", plain) if part.strip()]


def _signal(text: str, nouns: tuple[str, ...]) -> str | None:
    found: str | None = None
    for sentence in sentences(text):
        words = _words(sentence)
        if not _has(words, nouns) or _has(words, NEGATIONS):
            continue
        if _has(words, MUSTS):
            return "needed"
        found = "maybe"
    return found


def overlay(text: str) -> str | None:
    """``needed`` / ``maybe`` / ``None``: a sentence about an overlay (never one with a negation word)."""
    return _signal(text, ("overlay", "overlays"))


def sound(text: str) -> str | None:
    """The same rule over the whole words ``sound`` and ``sounds`` only (never audio, music or track)."""
    return _signal(text, ("sound", "sounds"))


_PLACE_UPPER = re.compile(r"(?<![A-Za-z0-9])(?:US|USA|UK)(?![A-Za-z0-9])")
_PLACE_ANY = re.compile(r"(?<![A-Za-z0-9])(?:united states|canada|tier[ -]1|tier one)(?![A-Za-z0-9])", re.IGNORECASE)


def audience(text: str) -> bool:
    """A sentence naming US, USA or UK (upper case only), United States, Canada or tier 1, and views or viewers,
    audience or based."""
    for sentence in sentences(text):
        if not (_PLACE_UPPER.search(sentence) or _PLACE_ANY.search(sentence)):
            continue
        if _has(_words(sentence), ("views", "viewers", "audience", "based")):
            return True
    return False


def page_language(description: str) -> str | None:
    """A stop-word count over the description (≥ 25 words): the winner needs ≥ 6 hits and 1.5 times the runner-up."""
    words = _words(_TAG.sub(" ", description or ""))
    if len(words) < config.LANGUAGE_MIN_WORDS:
        return None
    counts = sorted(
        ((sum(1 for w in words if w in set(stops)), code) for code, stops in config.STOP_WORDS.items()),
        reverse=True,
    )
    (best, code), (second, _) = counts[0], counts[1]
    if best >= config.LANGUAGE_MIN_HITS and best >= config.LANGUAGE_LEAD * second:
        return code
    return None


def languages(name: str, description: str) -> tuple[list[str], str | None]:
    """``namedLanguages`` from the name only (§39.3's table, A's ``languages_in``), ``pageLanguage`` from the
    description only; both only for en, es, pt, fr, de, it."""
    named = [code for code, _ in campaigns.languages_in(name or "") if code in config.STOP_WORDS]
    return named, page_language(description)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def signal_text(detail: Mapping[str, Any]) -> str:
    """The name, the description and, for application campaigns, the guidelines, the creator requirements and the
    reviewer-only lines (read here, never stored)."""
    parts = [_text(detail.get("name")), _text(detail.get("description"))]
    if detail.get("requiresApplication") is True:
        cfg = obj(detail.get("configuration"))
        parts.append(_text(obj(cfg.get("content")).get("guidelines")))
        parts.append(_text(obj(cfg.get("creator")).get("description")))
        reviewer = obj(cfg.get("rules")).get("reviewerOnly")
        if isinstance(reviewer, list):
            parts += [r for r in reviewer if isinstance(r, str)]
    return "\n".join(p for p in parts if p)


def _categories(detail: Mapping[str, Any], card: Mapping[str, Any] | None) -> list[Item]:
    rows: list[Any] = list((card or {}).get("categories") or [])
    rows += list(obj(obj(detail.get("configuration")).get("content")).get("contentCategories") or [])
    out: list[Item] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        cid, name = row.get("id"), row.get("name")
        if not isinstance(cid, str) or not _CATEGORY_ID.match(cid) or cid in seen or not isinstance(name, str):
            continue
        seen.add(cid)
        out.append({"id": cid, "name": name.strip()[:40]})
        if len(out) >= config.MAX_CATEGORIES:
            break
    return out


def _iso(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    moment = moment if moment.tzinfo else moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def on_discover(detail: Mapping[str, Any]) -> bool:
    return (
        detail.get("status") == "active"
        and detail.get("showOnDiscover") is not False
        and detail.get("private") is not True
        and detail.get("organizationPrivate") is not True
    )


def _fits(card: Item) -> bool:
    return len(json.dumps(card, ensure_ascii=False).encode()) <= config.CARD_MAX_BYTES


def _top_tiers(row: Item, n: int) -> None:
    """Only the ``n`` best-paying country rates, in their order (the row's top rate and its country note stay)."""
    tiers = [g for g in row.get("countryRates") or [] if isinstance(g, dict)]
    if len(tiers) <= n:
        return

    def rate(g: Item) -> int:
        value = g.get("per1kCents")
        return value if isinstance(value, int) and not isinstance(value, bool) else -1

    best = sorted(range(len(tiers)), key=lambda i: (-rate(tiers[i]), i))[:n]
    row["countryRates"] = [tiers[i] for i in sorted(best)]


def _fit(card: Item) -> Item:
    """≤ 6 KB, always: long country lists go first, then the shortest that still says what pays, then only the best
    country rates, then shorter words, then one country rate and one row a place."""
    if _fits(card):
        return card
    for row in card["pay"]:
        for group in row.get("countryRates") or []:
            group["countries"] = group.get("countries", [])[:5]
    if _fits(card):
        return card
    for row in card["pay"]:
        for group in row.get("countryRates") or []:
            group["countries"] = []
    card["groupIds"] = card["groupIds"][:5]
    card["name"] = card["name"][:120]
    card["brand"] = card["brand"][:120]
    if _fits(card):
        return card
    for row in card["pay"]:
        _top_tiers(row, 3)
    if _fits(card):
        return card
    card["name"], card["brand"] = card["name"][:80], card["brand"][:80]
    if isinstance(card.get("groupName"), str):
        card["groupName"] = card["groupName"][:80]
    card["categories"] = card["categories"][:3]
    card["contentTypes"] = [t[:40] for t in card["contentTypes"][:3]]
    if isinstance(card.get("orgId"), str) and len(card["orgId"]) > 64:
        card["orgId"] = None
    if _fits(card):
        return card
    rows: dict[str, Item] = {}
    for row in card["pay"]:
        _top_tiers(row, 1)
        rows.setdefault(str(row.get("platform")), row)
    card["pay"] = list(rows.values())
    return card


def card(
    detail: Mapping[str, Any], discover_card: Mapping[str, Any] | None, lastmod: int | None, now: datetime
) -> Item:
    """The ``FinderCard`` (``CRPUBLIC/CAMP#{uuid}.card``, ≤ 6 KB)."""
    uuid = str(detail.get("id") or "").lower()
    pay, paid = campaigns.pay_from_public(detail)
    budget = campaigns.budget_from_public(detail, "")
    budget.pop("asOf", None)
    flags = rules.toggles(detail)
    text = signal_text(detail)
    named, page_lang = languages(_text(detail.get("name")), _text(detail.get("description")))
    access = "application" if detail.get("requiresApplication") is True else "open"
    cfg = obj(detail.get("configuration"))
    types = [
        str(t["id"])
        for t in obj(cfg.get("content")).get("contentTypes") or []
        if isinstance(t, Mapping) and isinstance(t.get("id"), str)
    ][: config.MAX_CONTENT_TYPES]
    counts = obj(detail.get("briefCounts"))
    hidden = counts.get("contentRules") if isinstance(counts.get("contentRules"), int) else None
    group = obj((discover_card or {}).get("group"))
    group_ids = list(  # only real uuids: the plan reads each as its own /c/campaigns/{uuid} page
        dict.fromkeys(
            g.lower()
            for g in group.get("campaignIds") or []
            if isinstance(g, str) and links.UUID.match(g) and g.lower() != uuid
        )
    )[: config.MAX_GROUP]
    listed = _iso((discover_card or {}).get("listedAt"))
    if listed is None and lastmod is not None:
        listed = _iso(datetime.fromtimestamp(lastmod, UTC).isoformat())
    org = obj(detail.get("organization"))
    brand = org.get("name") if isinstance(org.get("name"), str) else (discover_card or {}).get("organizationName")
    return _fit(
        {
            "uuid": uuid,
            "name": (_text(detail.get("name")).strip() or "Campaign")[:200],
            "brand": (brand.strip() if isinstance(brand, str) else "")[:200],
            "orgId": detail.get("organizationId") if isinstance(detail.get("organizationId"), str) else None,
            "status": str(detail.get("status") or "unknown")[:40],
            "onDiscover": on_discover(detail),
            "access": access,
            "kind": campaigns.campaign_type(detail.get("type")),
            "pay": pay,
            "platformsPaid": paid,
            "budget": budget,
            "categories": _categories(detail, discover_card),
            "contentTypes": types,
            "toggles": flags,
            "overlay": overlay(text),
            "sound": sound(text),
            "audience": audience(text),
            "namedLanguages": named,
            "pageLanguage": page_lang,
            "hiddenRules": hidden if access == "open" else None,
            "launchedAt": _iso(detail.get("launchDate")),
            "listedAt": listed,
            "groupName": str(group["name"]).strip()[:200] if isinstance(group.get("name"), str) else None,
            "groupIds": group_ids,
        }
    )


def used_bps(budget: Mapping[str, Any]) -> int | None:
    """``round(10000 * spent / total)``, CR's numbers; ``None`` when either is unknown or the total is 0."""
    total, spent = budget.get("totalCents"), budget.get("spentCents")
    if not isinstance(total, int) or not isinstance(spent, int) or total <= 0 or spent < 0:
        return None
    return (20000 * spent + total) // (2 * total)  # exact, halves round up


def left_pct(bps: int) -> int:
    """``100 - ceil(used_bps / 100)``."""
    return max(0, 100 - -(-bps // 100))
