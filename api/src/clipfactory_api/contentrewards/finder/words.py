"""The finder's server words (docs/CONTRACTS.md §41.3 "The words"). Formatting only: integer cents in, text out.

Rates always with cents ("$1.50"), other amounts with ``gates.money``; every line ≤ 26 words, kid-proof, free of the
§41.1 banned words. Only Content Rewards' own numbers are ever written, never a guess of what a clip would earn.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..gates import LABELS, money
from . import config

HEADS_SOUND = "It may need its own sound. Clip Factory can't add one."
HEADS_OVERLAY = "It may want its own picture on top of the video. Clip Factory can't add one."
HEADS_FACE = "This brand wants your face on camera."
HEADS_AUDIENCE = "This brand only counts viewers from some countries. Check where yours are first."
NOTE_GEO = "Pays less in some countries."
NOTE_TIKTOK = "Also pays on TikTok, once TikTok checks Clip Factory."
CANT_MONEY = "I can't tell how much money is left."
CANT_TOPIC = "I can't tell what it's about."
CANT_LANGUAGE = "I can't tell the language."
TAG = "Content Rewards' numbers"
BANNED = ("cpm", "budget", "api", "mcp", "scrape", "sitemap", "robots")


def rate(cents: int) -> str:
    """``150`` → ``"$1.50"``, ``1200`` → ``"$12.00"`` (a rate always shows its cents)."""
    dollars, rest = divmod(int(cents), 100)
    return f"${dollars:,}.{rest:02d}"


def join(items: list[str]) -> str:
    if not items:
        return ""
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def place_names(platforms: list[str]) -> str:
    return join([LABELS.get(p, p) for p in platforms])


def pay_line(row: Mapping[str, Any], kind: str, top: int | None, geo: bool) -> str:
    """``FinderPay.line`` for one place."""
    if kind == "cpm":
        per1k = row.get("per1kCents")
        if top is None:
            return "Pays in its own way. See its page."
        text = (
            f"Up to {rate(top)} per 1,000 views"
            if geo
            else f"{rate(per1k if isinstance(per1k, int) else top)} per 1,000 views"
        )
        most = row.get("maxPayoutCents")
        return text + (f" · up to {money(most)} a clip" if isinstance(most, int) and most > 0 else "")
    if kind == "per_post":
        each = row.get("perPostCents")
        if not isinstance(each, int):
            return "Pays in its own way. See its page."
        views = row.get("minViews")
        return f"{rate(each)} for each approved post" + (
            f" · needs {views:,} views" if isinstance(views, int) and views > 0 else ""
        )
    if kind == "pool":
        return "Shares the prize money"
    if kind == "retainer":
        return "Pays picked creators each month"
    return "Pays in its own way. See its page."


def why(
    *,
    kind: str,
    tops: list[int],
    geo: bool,
    per_post: list[int],
    counted: list[str],
    category: str | None,
    left: int | None,
    access: str,
) -> str:
    """``"{pay} on {counted places}."`` + the category he picked + the money left + who can join."""
    if kind == "cpm" and tops:
        best = max(tops)
        pay = (
            f"Pays {rate(best)} per 1,000 views"
            if not geo and len(set(tops)) == 1
            else f"Pays up to {rate(best)} per 1,000 views"
        )
    elif kind == "per_post" and per_post:
        pay = f"Pays {rate(max(per_post))} for each approved post"
    elif kind == "pool":
        pay = "Shares the prize money"
    elif kind == "retainer":
        pay = "Pays picked creators each month"
    else:
        pay = "Pays in its own way"
    text = f"{pay} on {place_names(counted)}." if counted else f"{pay}."
    if category:
        text += f" {category}."
    if left is not None:
        text += f" {left}% of the money left."
    return text + (" You apply first." if access == "application" else " Open to join.")


def money_left(left: int | None, total: int | None) -> str | None:
    if not isinstance(left, int) or not isinstance(total, int):
        return None
    return f"{money(left)} left of {money(total)}"


def also_pays(platforms: list[str]) -> str:
    return f"Also pays on {place_names(platforms)}."


def hidden_rules(n: int) -> str:
    return f"It has {n} rule{'' if n == 1 else 's'} you see once you join."


def page_in(code: str) -> str:
    return f"Its page is in {config.LANGUAGE_NAMES.get(code, code)}."


_LEFT = {25: "a quarter of the money", 50: "half the money", 75: "three quarters of the money"}


def skipped(code: str, n: int, want: Mapping[str, Any]) -> str:
    """One "Why not more?" line; ``1 campaign …`` in the singular."""
    one = n == 1
    lead = "1 campaign" if one else str(n)
    if code == "low_pay":
        verb = "pays" if one else "pay"
        return f"{lead} {verb} less than {rate(int(want['minPer1kCents']))} per 1,000 views."
    if code == "budget_low":
        part = _LEFT.get(int(want.get("minLeftPct") or 0), "a quarter of the money")
        return f"{lead} {'has' if one else 'have'} less than {part} left."
    texts = {
        "budget_gone": ("has almost no money left.", "have almost no money left."),
        "not_your_places": ("doesn't pay for the places you post.", "don't pay for the places you post."),
        "apply": ("wants you to apply first.", "want you to apply first."),
        "other_pay": ("pays per post or shares a prize.", "pay per post or share a prize."),
        "cant_make": ("needs something Clip Factory can't make.", "need something Clip Factory can't make."),
        "topic": ("is about other things.", "are about other things."),
        "language": ("wants another language.", "want another language."),
        "hidden": ("you said Not for me.", "you said Not for me."),
        "own": ("is in your campaigns already.", "are in your campaigns already."),
    }
    singular, plural = texts[code]
    return f"{lead} {singular if one else plural}"
