"""Matching and ranking (docs/CONTRACTS.md §41.3). One pure function, no I/O.

``find(cards, want, places=…, own=…, hidden=…, now=…)``: ``cards`` are the cached ``ok`` ``FinderCard``s that count
(each may carry its cache item's ``readAt``, the "as of" of Content Rewards' numbers), ``want`` the owner's
``FinderWant`` (the defaults fill what is missing), ``places`` the **resolved** places (``gates.upload_places``),
``own`` his ``CAMPAIGN#`` uuids, ``hidden`` his "Not for me" uuids, ``tiktok_waits`` whether TikTok's posting audit
has not passed. A card is refused only by a fact on the public page; the first refusal is its ``skipped`` code.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from ...clock import iso, parse
from ...stats import STATS_ORDER
from . import config, normalize, words

Item = dict[str, Any]

# The checks' order (§41.3 table): the first refusal is the card's code; ties in "Why not more?" keep this order.
CODES = (
    "own",
    "hidden",
    "not_listed",
    "cant_make",
    "budget_gone",
    "not_your_places",
    "other_pay",
    "apply",
    "low_pay",
    "budget_low",
    "topic",
    "language",
)
KIND_RANK = {"cpm": 0, "per_post": 1, "pool": 2, "retainer": 3, "other": 4}
BUDGET_GONE_BPS = 9500


def with_defaults(want: Mapping[str, Any] | None) -> Item:
    """The nine keys, each the owner's value when it has the right type, else the default (§41.3)."""
    given = dict(want or {})
    out: Item = {}
    for key, default in config.DEFAULTS.items():
        value = given.get(key, default)
        if isinstance(default, bool):
            ok = isinstance(value, bool)
        elif isinstance(default, int):
            ok = isinstance(value, int) and not isinstance(value, bool)
        elif isinstance(default, list):
            ok = isinstance(value, list) and all(isinstance(v, str) for v in value)
        elif key == "places":
            ok = value is None or (isinstance(value, list) and all(isinstance(v, str) for v in value))
        else:
            ok = isinstance(value, str)
        out[key] = copy.deepcopy(value if ok else default)
    return out


def matched_want(want: Mapping[str, Any] | None, places: Iterable[str]) -> str:
    """``CRFIND.matchedWant``: the first 16 hex characters of SHA-256 over the canonical JSON (sorted keys, no spaces,
    UTF-8) of ``{"places": resolvedPlaces, "want": want with the defaults filled in}`` (§41.5)."""
    body = json.dumps(
        {"places": list(places), "want": with_defaults(want)}, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def top(row: Mapping[str, Any]) -> int | None:
    """The largest of a CPM place's ``per1kCents``, ``otherCountriesPer1kCents`` and every country rate."""
    values = [row.get("per1kCents"), row.get("otherCountriesPer1kCents")]
    values += [g.get("per1kCents") for g in row.get("countryRates") or [] if isinstance(g, Mapping)]
    rates = [v for v in values if isinstance(v, int) and not isinstance(v, bool)]
    return max(rates) if rates else None


def geo(row: Mapping[str, Any]) -> bool:
    return bool(row.get("countryRates")) or row.get("otherCountriesPer1kCents") is not None


def _rows(card: Mapping[str, Any]) -> dict[str, Item]:
    return {str(r.get("platform")): dict(r) for r in card.get("pay") or [] if isinstance(r, Mapping)}


def _epoch(value: Any) -> float | None:
    moment = parse(value)
    return moment.timestamp() if moment else None


class _Refused(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _check(card: Mapping[str, Any], want: Item, places: list[str], tiktok_waits: bool) -> Item:  # noqa: PLR0915
    """One card through the table of §41.3; raises ``_Refused(code)``, else the match's parts."""
    toggles = card.get("toggles") or {}
    types = [str(t) for t in card.get("contentTypes") or []]
    kind = str(card.get("kind") or "other")
    notes: list[str] = []
    heads: list[str] = []
    cant: list[str] = []
    # 4: Clip Factory can make it
    if (
        toggles.get("preApproval")
        or toggles.get("sound")
        or card.get("sound") == "needed"
        or card.get("overlay") == "needed"
        or (types and "clipping" not in types)
    ):
        raise _Refused("cant_make")
    if "sound" in types or card.get("sound") == "maybe":
        heads.append(words.HEADS_SOUND)
    if card.get("overlay") == "maybe":
        heads.append(words.HEADS_OVERLAY)
    if toggles.get("faceOnCamera"):
        heads.append(words.HEADS_FACE)
    if card.get("audience"):
        heads.append(words.HEADS_AUDIENCE)
    # 5: money left
    budget = card.get("budget") or {}
    bps = normalize.used_bps(budget)
    if bps is not None and bps >= BUDGET_GONE_BPS:
        raise _Refused("budget_gone")
    # 6: places
    paid = [p for p in STATS_ORDER if p in set(card.get("platformsPaid") or [])]
    mine = [p for p in places if p in paid]
    if not mine:
        raise _Refused("not_your_places")
    also = [p for p in paid if p not in places and p != "tiktok"]
    tiktok_note = "tiktok" in paid and "tiktok" not in places and tiktok_waits
    # 7, 8: how it pays, who can join
    if kind != "cpm" and not want["otherPay"]:
        raise _Refused("other_pay")
    access = "application" if card.get("access") == "application" else "open"
    if access == "application" and want["access"] == "open":
        raise _Refused("apply")
    # 9: pay
    rows = _rows(card)
    tops = {p: top(rows.get(p, {})) for p in mine}
    if kind == "cpm":
        counted = [p for p in mine if (tops[p] or 0) >= want["minPer1kCents"] and tops[p] is not None]
        if not counted:
            raise _Refused("low_pay")
    else:
        counted = list(mine)
    geo_counted = kind == "cpm" and any(geo(rows.get(p, {})) for p in counted)
    # 10: money left, his choice
    if bps is not None and bps > 10000 - 100 * want["minLeftPct"]:
        raise _Refused("budget_low")
    if bps is None:
        cant.append(words.CANT_MONEY)
    # 11: topic
    category = None
    if want["categories"]:
        cats = [c for c in card.get("categories") or [] if isinstance(c, Mapping)]
        if cats:
            picked = [c for c in cats if c.get("id") in want["categories"]]
            if not picked:
                raise _Refused("topic")
            category = str(picked[0].get("name") or "") or None
        else:
            cant.append(words.CANT_TOPIC)
    # 12: language
    if want["languages"]:
        named = [str(n) for n in card.get("namedLanguages") or []]
        page = card.get("pageLanguage")
        if named and not any(n in want["languages"] for n in named):
            raise _Refused("language")
        if not named:
            if isinstance(page, str) and page:
                if page not in want["languages"]:
                    heads.append(words.page_in(page))
            else:
                cant.append(words.CANT_LANGUAGE)
    hidden_rules = card.get("hiddenRules") if access == "open" else None
    if geo_counted:
        notes.append(words.NOTE_GEO)
    if isinstance(hidden_rules, int) and hidden_rules > 0:
        notes.append(words.hidden_rules(hidden_rules))
    if also:
        notes.append(words.also_pays(also))
    if tiktok_note:
        notes.append(words.NOTE_TIKTOK)
    return {
        "kind": kind,
        "access": access,
        "mine": mine,
        "counted": counted,
        "tops": tops,
        "rows": rows,
        "geo": geo_counted,
        "bps": bps,
        "category": category,
        "notes": notes[: config.MAX_LINES],
        "headsUp": heads[: config.MAX_LINES],
        "cantTell": cant[: config.MAX_LINES],
        "hiddenRules": hidden_rules if isinstance(hidden_rules, int) else None,
    }


def _match(card: Mapping[str, Any], parts: Item, now: datetime) -> Item:
    kind, rows, tops = parts["kind"], parts["rows"], parts["tops"]
    pay = []
    for platform in parts["mine"]:
        row = rows.get(platform, {})
        is_geo = kind == "cpm" and geo(row)
        place_top = tops[platform] if kind == "cpm" else None
        pay.append(
            {
                "platform": platform,
                "line": words.pay_line(row, kind, place_top, is_geo),
                "per1kCents": row.get("per1kCents") if isinstance(row.get("per1kCents"), int) else None,
                "topPer1kCents": place_top,
                "perPostCents": row.get("perPostCents") if isinstance(row.get("perPostCents"), int) else None,
                "maxPayoutCents": row.get("maxPayoutCents") if isinstance(row.get("maxPayoutCents"), int) else None,
                "geo": is_geo,
            }
        )
    most = [p["maxPayoutCents"] for p in pay if isinstance(p["maxPayoutCents"], int)]
    budget = card.get("budget") or {}
    bps = parts["bps"]
    left = normalize.left_pct(bps) if bps is not None else None
    counted_tops = [t for p in parts["counted"] if isinstance(t := tops.get(p), int)]
    per_post = [
        r["perPostCents"] for p in parts["counted"] if isinstance((r := rows.get(p, {})).get("perPostCents"), int)
    ]
    uuid = str(card.get("uuid") or "")
    return {
        "campaignId": uuid,
        "url": f"{config.SITE}{config.PAGE_PATH}{uuid}",
        "name": str(card.get("name") or "Campaign")[:200],
        "brand": str(card.get("brand") or "")[:200],
        "access": parts["access"],
        "kind": kind,
        "pay": pay,
        "maxPerClipCents": max(most) if most else None,
        "budget": {
            "totalCents": budget.get("totalCents") if isinstance(budget.get("totalCents"), int) else None,
            "leftCents": budget.get("leftCents") if isinstance(budget.get("leftCents"), int) else None,
            "usedPct": budget.get("usedPct") if isinstance(budget.get("usedPct"), int | float) else None,
            "line": words.money_left(budget.get("leftCents"), budget.get("totalCents")),
            "asOf": str(card.get("readAt") or iso(now)),
            "tag": words.TAG,
        },
        "categories": [dict(c) for c in card.get("categories") or [] if isinstance(c, Mapping)],
        "why": words.why(
            kind=kind,
            tops=counted_tops,
            geo=parts["geo"],
            per_post=per_post,
            counted=parts["counted"],
            category=parts["category"],
            left=left,
            access=parts["access"],
        ),
        "notes": parts["notes"],
        "headsUp": parts["headsUp"],
        "cantTell": parts["cantTell"],
        "hiddenRules": parts["hiddenRules"],
        "launchedAt": card.get("launchedAt") if isinstance(card.get("launchedAt"), str) else None,
        "rank": 0,
        "_top": max(counted_tops) if kind == "cpm" and counted_tops else 0,
    }


def _rank_key(m: Item) -> tuple[Any, ...]:
    left = m["budget"]["leftCents"]
    launched = _epoch(m["launchedAt"])
    return (
        0 if not m["headsUp"] and not m["cantTell"] else 1,
        KIND_RANK.get(m["kind"], 4),
        -m["_top"],
        (0, -left) if isinstance(left, int) else (1, 0),
        (0, -launched) if launched is not None else (1, 0),
        m["campaignId"],
    )


def find(
    cards: Iterable[Mapping[str, Any]],
    want: Mapping[str, Any] | None,
    *,
    places: Iterable[str],
    own: Iterable[str],
    hidden: Iterable[str],
    now: datetime,
    tiktok_waits: bool = False,
) -> Item:
    """``FindResult = {matches (≤ 20, ranked), skipped [{code, count, text}], looked}``. ``looked`` counts every card
    that is not ``not_listed``, so the shown ``skipped`` counts and the matches add up to it."""
    full = with_defaults(want)
    resolved = [p for p in STATS_ORDER if p in set(places)]
    own_set = {str(u).lower() for u in own}
    hidden_set = {str(u).lower() for u in hidden}
    counts = dict.fromkeys(CODES, 0)
    matches: list[Item] = []
    for card in cards:
        uuid = str(card.get("uuid") or "").lower()
        if uuid in own_set:
            counts["own"] += 1
            continue
        if uuid in hidden_set:
            counts["hidden"] += 1
            continue
        if not card.get("onDiscover"):
            counts["not_listed"] += 1
            continue
        try:
            parts = _check(card, full, resolved, tiktok_waits)
        except _Refused as refused:
            counts[refused.code] += 1
            continue
        matches.append(_match(card, parts, now))
    matches.sort(key=_rank_key)
    kept = matches[: config.MAX_MATCHES]
    for rank, m in enumerate(kept, start=1):
        m["rank"] = rank
        m.pop("_top", None)
    shown = [c for c in CODES if c != "not_listed" and counts[c] > 0]
    shown.sort(key=lambda c: (-counts[c], CODES.index(c)))
    return {
        "matches": kept,
        "skipped": [{"code": c, "count": counts[c], "text": words.skipped(c, counts[c], full)} for c in shown],
        "looked": len(matches) + sum(counts[c] for c in shown),
    }
