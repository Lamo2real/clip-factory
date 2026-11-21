"""Stops, the places a campaign clip may go and the one next step (docs/CONTRACTS.md §38.4, §38.8).

Pure code, ported from the local app's ``ruleCheck.js`` with its two numbers (``MIN_RATE_CENTS``,
``MAX_SPENT_FRACTION``). Made from the stored campaign, ``CRCONN``, the setups and the time, every time a campaign is
served. B (Confirm) and D (the card) carry the same ``uploadPlaces`` rule and test the same cases (§38.20).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any

from ..stats import STATS_ORDER
from . import config, connection
from .util import obj

Item = dict[str, Any]
LABELS = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
MEMBERSHIP_STOPS = {
    "unknown": "not_checked",
    "not_joined": "not_joined",
    "apply_first": "apply_first",
    "waiting": "waiting",
    "left": "left",
    "not_accepted": "not_accepted",
}
CAN_MAKE = ("in", "manual")
SOFT = frozenset({"not_connected", "budget_half", "low_rate", "face_needed", "spoken_needed", "audience"})
ELSEWHERE = frozenset(
    {"ended", "deadline", "budget_gone", "tiktok_only", "drafts_first", "sound_needed", "cap_reached", "not_accepted"}
)
STUDIO = "https://studio.youtube.com/"
OPEN_CAMPAIGN = "Open campaign"
FIND_ANOTHER = "Find another campaign"
MAKE_CLIPS = "Make clips for this campaign"
SUBMIT_CLIP = "It says Submit clip"


def money(cents: int) -> str:
    """``388000`` → ``"$3,880"``, ``50`` → ``"$0.50"`` (CR's own numbers, only formatted)."""
    dollars, rest = divmod(abs(int(cents)), 100)
    sign = "-" if cents < 0 else ""
    return f"{sign}${dollars:,}" if rest == 0 and dollars >= 10 else f"{sign}${dollars:,}.{rest:02d}"


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


# --- places ------------------------------------------------------------------------------------------------------


def upload_places(
    platforms_paid: Iterable[str], setups: Iterable[Mapping[str, Any]], crlinked: Mapping[str, Any]
) -> list[str]:
    """``platformsPaid`` ∩ places ``ready`` in ``GET /v1/setup`` ∩ not ``crLinked: false``, with TikTok only while its
    ``posting_audit`` gate is ``ok``, in STATS_ORDER."""
    paid = set(platforms_paid)
    by_platform = {str(s.get("platform")): s for s in setups}
    out = []
    for platform in STATS_ORDER:
        setup = by_platform.get(platform) or {}
        if platform not in paid or not setup.get("ready") or crlinked.get(platform) is False:
            continue
        if platform == "tiktok":
            gates = {g.get("key"): g.get("state") for g in setup.get("gates") or [] if isinstance(g, Mapping)}
            if gates.get("posting_audit") != "ok":
                continue
        out.append(platform)
    return out


def tiktok_waits(platforms_paid: Iterable[str], setups: Iterable[Mapping[str, Any]]) -> bool:
    """The campaign pays for TikTok but TikTok's posting audit has not passed (posts would be private)."""
    if "tiktok" not in set(platforms_paid):
        return False
    tiktok = next((s for s in setups if s.get("platform") == "tiktok"), {})
    gates = {g.get("key"): g.get("state") for g in tiktok.get("gates") or [] if isinstance(g, Mapping)}
    return gates.get("posting_audit") != "ok"


# --- stops -------------------------------------------------------------------------------------------------------


def _stop(code: str, text: str, fix: str | None = None, accepted: Iterable[str] = ()) -> Item:
    out: Item = {"code": code, "hard": code not in SOFT, "text": text}
    if fix:
        out["fixHref"] = fix
    if code in SOFT and code != "not_connected" and code in set(accepted):
        out["anyway"] = True
    return out


def stops(  # noqa: PLR0915 (every stop of §38.4, in the table's order)
    item: Mapping[str, Any], conn: Mapping[str, Any], places: list[str], now: datetime
) -> list[Item]:
    rules = obj(item.get("rules"))
    membership = str(item.get("membership") or "unknown")
    accepted = [str(c) for c in item.get("anyway") or []]
    paid = [str(p) for p in item.get("platformsPaid") or []]
    out: list[Item] = []
    if membership in MEMBERSHIP_STOPS:
        out.append(_stop(MEMBERSHIP_STOPS[membership], membership_text(item, conn)))
    if membership == "manual" and not connection.signed_in(conn):
        out.append(
            _stop(
                "not_connected",
                "Clip Factory isn't connected to Content Rewards, so you send each clip yourself. Tap Connect Content "
                "Rewards to make it automatic.",
                config.SETUP_HREF,
            )
        )
    state = item.get("rulesState")
    if state == "reading":
        out.append(_stop("rules_reading", "Reading the rules… (about 30 seconds)"))
    elif state == "failed":
        out.append(_stop("rules_failed", "I couldn't read the rules. Tap Check now, or paste them below."))
    if item.get("state") == "paused":
        out.append(_stop("paused", "The brand paused this campaign. I'll tell you when it opens again."))
    if item.get("state") == "ended":
        out.append(_stop("ended", "This campaign has ended. Pick another one."))
    until = rules.get("clipUntil")
    if isinstance(until, str):
        try:
            last = date.fromisoformat(until)
        except ValueError:
            last = None
        if last is not None and last < now.date():
            out.append(
                _stop(
                    "deadline",
                    f"This campaign stopped taking clips on {last.day} {last.strftime('%b')}. Pick another one.",
                )
            )
    budget = obj(item.get("budget"))
    used = budget.get("usedPct")
    if (isinstance(used, int | float) and used >= config.BUDGET_GONE_FRACTION * 100) or item.get("budgetGone"):
        out.append(_stop("budget_gone", "The money is almost gone, so new clips won't get paid. Pick another one."))
    elif isinstance(used, int | float) and used > config.MAX_SPENT_FRACTION * 100:
        left = budget.get("leftCents")
        left_text = f" {money(int(left))} is left." if isinstance(left, int) else ""
        out.append(
            _stop(
                "budget_half", f"Half the money is used.{left_text} Post soon, before it runs out.", accepted=accepted
            )
        )
    rates: list[int] = [
        int(p["per1kCents"])
        for p in item.get("pay") or []
        if isinstance(p, Mapping) and isinstance(p.get("per1kCents"), int) and p.get("platform") in paid
    ]
    if item.get("campaignType") == "cpm" and rates and max(rates) < config.MIN_RATE_CENTS:
        out.append(
            _stop(
                "low_rate",
                f"It pays only {money(max(rates))} per 1,000 views. Most campaigns pay $1 or more. You can still make "
                "clips, or pick another one.",
                accepted=accepted,
            )
        )
    logo = obj(item.get("logo"))
    if logo_needed(item) and logo.get("state") != "ready":
        out.append(_stop("logo_missing", "This campaign needs its logo on every clip. Add it below."))
    if paid and set(paid) == {"tiktok"}:
        out.append(
            _stop(
                "tiktok_only",
                "This campaign only pays for TikTok. TikTok keeps Clip Factory's posts private until it checks the "
                "app, and private posts can't earn. Pick a campaign that pays for YouTube, Instagram, X or Facebook.",
            )
        )
    elif paid and not places:
        first = next((p for p in STATS_ORDER if p in paid and p != "tiktok"), paid[0])
        names = [LABELS.get(p, p) for p in STATS_ORDER if p in paid]
        out.append(
            _stop(
                "no_place",
                f"Set up {LABELS.get(first, first)} first. This campaign pays for {_join(names)}.",
                f"/settings/posting/setup/{first}",
            )
        )
    if isinstance(item.get("held"), Mapping):
        out.append(
            _stop(
                "held",
                "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
            )
        )
    if item.get("capReached"):
        out.append(_stop("cap_reached", "You reached the most you can earn on this campaign. Pick another one."))
    if rules.get("draftsFirst"):
        out.append(
            _stop(
                "drafts_first",
                "This campaign wants to see each clip before you post it. Clip Factory can't do that yet. Pick another "
                "campaign.",
            )
        )
    if rules.get("soundRequired"):
        out.append(
            _stop(
                "sound_needed",
                "This campaign needs one of its own sounds. Clip Factory can't add it yet. Pick another campaign.",
            )
        )
    if rules.get("faceOnCamera"):
        out.append(
            _stop(
                "face_needed",
                "This brand wants your face on camera. Clips of other videos may be turned down.",
                accepted=accepted,
            )
        )
    if (rules.get("disclosure") or {}).get("spoken"):
        out.append(
            _stop(
                "spoken_needed",
                "This brand wants you to say “paid partnership” out loud. Clip Factory can't, so clips may be turned "
                "down.",
                accepted=accepted,
            )
        )
    if isinstance(rules.get("audience"), str) and rules.get("audience"):
        out.append(
            _stop(
                "audience",
                f"This brand wants this audience: “{rules['audience']}”. In YouTube Studio tap **Analytics**, then "
                "**Audience**, then look at **Top geographies**.",
                STUDIO,
                accepted=accepted,
            )
        )
    return out


def logo_needed(item: Mapping[str, Any]) -> bool:
    rules = obj(item.get("rules"))
    if (rules.get("logo") or {}).get("required"):
        return True
    public = obj(item.get("public"))
    from .rules import toggles

    return bool(toggles(public).get("logoRequired"))


# --- membership words --------------------------------------------------------------------------------------------


def membership_text(item: Mapping[str, Any], conn: Mapping[str, Any]) -> str:
    membership = item.get("membership")
    if membership == "unknown":
        if connection.refused(conn):
            return (
                "Content Rewards hasn't let Clip Factory look yet. Open the campaign. Does it say **Submit clip**? Then "
                "you're in."
            )
        return "Connect Content Rewards so I can see if you're in."
    return {
        "not_joined": "Not joined yet: tap **Join Campaign** on Content Rewards. I'll see it by myself.",
        "apply_first": "Did you tap **Submit application** on Content Rewards? Then tap Yes, I applied.",
        "waiting": "Nothing to do. I'll tell you when you're in.",
        "left": (
            "Content Rewards doesn't show this campaign for you any more. Open it to check: you may have left, or the "
            "brand removed you."
        ),
        "not_accepted": "The brand said no to this one. That's OK! Pick another campaign.",
    }.get(str(membership), "")


def chip(item: Mapping[str, Any], conn: Mapping[str, Any]) -> str:
    membership = item.get("membership")
    if membership == "unknown":
        return "Check it yourself" if connection.refused(conn) else "Connect first"
    if membership == "in" and item.get("state") == "paused":
        return "Paused"
    return {
        "not_joined": "Not joined yet",
        "apply_first": "Applied?",
        "waiting": "Waiting for the brand",
        "in": "You're in",
        "manual": "You're in",
        "left": "Not in your list",
        "not_accepted": "Not accepted",
    }.get(str(membership), "Connect first")


def _open(url: str) -> Item:
    return {"label": OPEN_CAMPAIGN, "href": url, "external": True}


def _another() -> Item:
    return {"label": FIND_ANOTHER, "href": config.DISCOVER_URL, "external": True}


def next_step(item: Mapping[str, Any], conn: Mapping[str, Any], stop_list: list[Item], now: datetime) -> Item:
    """The one thing to do (``NextStep``), in priority order: a hard stop that sends him elsewhere · membership ·
    the rules being read (or failed) · ``rules_paste`` · ``logo`` · soft stops not accepted · ``pick_video`` ·
    ``make_clips``. ``button`` is the screen's single vermilion one."""
    url = str(item.get("url") or "")
    membership = str(item.get("membership") or "unknown")
    chip_text = chip(item, conn)
    codes = {s["code"]: s for s in stop_list}
    member_codes = set(MEMBERSHIP_STOPS.values())
    later = {*member_codes, "logo_missing", "rules_reading", "rules_failed"}
    for stop in stop_list:
        code = stop["code"]
        if not stop["hard"] or code in later:
            continue
        step: Item = {"kind": "stop", "chip": _stop_chip(code, chip_text), "text": stop["text"]}
        if code in ELSEWHERE:
            step["kind"] = "pick_another"
            step["button"] = _another()
        elif code == "paused":
            step["glass"] = [_another()]
        elif code == "no_place" and stop.get("fixHref"):
            label = stop["text"].split(" first.", 1)[0]
            step["button"] = {"label": label, "href": stop["fixHref"], "external": False}
        return step
    if membership in MEMBERSHIP_STOPS:
        return _membership_step(item, conn, chip_text, url, now)
    for code in ("rules_reading", "rules_failed"):  # only once he can make clips do the rules hold him up
        if code in codes:
            return {"kind": "stop", "chip": _stop_chip(code, chip_text), "text": codes[code]["text"]}
    if membership == "manual" and _needs_paste(item):
        return {
            "kind": "rules_paste",
            "chip": chip_text,
            "text": (
                "Open the campaign. Copy everything under **Brief** and **Content requirements**. Paste it below, then "
                "tap Read these rules."
            ),
            "button": _open(url),
            "asks": [],
        }
    if "logo_missing" in codes:
        return {
            "kind": "logo",
            "chip": chip_text,
            "text": codes["logo_missing"]["text"],
            "button": {"label": "Add the logo", "external": False, "action": "logo_picker"},
        }
    open_soft = [s for s in stop_list if not s["hard"] and s["code"] != "not_connected" and not s.get("anyway")]
    if open_soft:
        return {
            "kind": "anyway",
            "chip": chip_text,
            "text": " ".join(s["text"] for s in open_soft),
            "button": {"label": "Make clips anyway", "external": False, "action": "anyway"},
        }
    rules = obj(item.get("rules"))
    if (rules.get("allowedSources") or {}).get("campaignProvidedOnly") and item.get("sourceVideos"):
        return {"kind": "pick_video", "chip": chip_text, "text": "Pick a video below."}
    if membership == "in":
        text = (
            "You're in! Make clips for this campaign."
            if item.get("celebrate") == "in"
            else "Make clips for this campaign."
        )
    else:
        text = "You're in. After each post, I'll remind you to send it to Content Rewards yourself."
    if item.get("idMatch") == "ambiguous" and membership == "in":
        text = "You're in. After each post, I'll remind you to send it to Content Rewards yourself."
    step = {
        "kind": "make_clips",
        "chip": chip_text,
        "text": text,
        "button": {"label": MAKE_CLIPS, "href": f"/?campaign={item.get('campaignId')}", "external": False},
    }
    if item.get("autoSince"):
        step["sub"] = "Clip Factory can send these clips by itself now."
    return step


def _needs_paste(item: Mapping[str, Any]) -> bool:
    state = item.get("rulesState")
    if state == "waiting_for_join":
        return True
    if state != "ready":
        return False
    rules = item.get("rules") if isinstance(item.get("rules"), Mapping) else None
    return not rules or not _has_rule(rules)


def _has_rule(rules: Mapping[str, Any]) -> bool:
    return any(
        (
            rules.get("lengthMinSec"),
            rules.get("lengthMaxSec"),
            rules.get("requiredHashtags"),
            rules.get("requiredTags"),
            rules.get("requiredCaptionText"),
            rules.get("bannedContent"),
            (rules.get("logo") or {}).get("required"),
            rules.get("otherRules"),
            rules.get("sourceVideos"),
            (rules.get("allowedSources") or {}).get("channels"),
        )
    )


def _stop_chip(code: str, fallback: str) -> str:
    return {
        "ended": "Ended",
        "deadline": "Ended",
        "budget_gone": "Money gone",
        "paused": "Paused",
        "held": "On hold",
        "rules_reading": "Reading the rules",
        "rules_failed": "Rules missing",
        "tiktok_only": "TikTok only",
        "no_place": "Set up first",
        "cap_reached": "Most reached",
        "drafts_first": "Can't do this one",
        "sound_needed": "Can't do this one",
    }.get(code, fallback)


def _membership_step(item: Mapping[str, Any], conn: Mapping[str, Any], chip_text: str, url: str, now: datetime) -> Item:
    from ..clock import parse

    membership = str(item.get("membership"))
    text = membership_text(item, conn)
    submit_ask = {"label": SUBMIT_CLIP, "said": "joined_by_hand"}
    not_eligible = {
        "label": "It says Not eligible",
        "said": "not_eligible",
        "text": "If Content Rewards shows **Not eligible**, tap It says Not eligible.",
    }
    if membership == "unknown":
        if connection.refused(conn):
            return {
                "kind": "check_yourself",
                "chip": chip_text,
                "text": text + " Copy everything under **Brief** and **Content requirements**. Paste it here.",
                "sub": "It says **Pending review**? Wait for the brand, then look again.",
                "button": _open(url),
                "asks": [submit_ask],
            }
        return {
            "kind": "connect",
            "chip": chip_text,
            "text": text,
            "button": {"label": "Connect Content Rewards", "href": config.SETUP_HREF, "external": False},
            "asks": [{**submit_ask, "text": "Open the campaign. Does it say **Submit clip**? Then you're in."}],
            "glass": [_open(url)],
        }
    if membership == "not_joined":
        asks = []
        say_by = parse(item.get("canSayInBy"))
        if say_by is not None and now >= say_by:
            asks.append({"label": "I joined, but it still says not joined", "said": "joined_by_hand"})
        return {"kind": "join", "chip": chip_text, "text": text, "button": _open(url), "asks": asks}
    if membership == "apply_first":
        return {
            "kind": "applied",
            "chip": chip_text,
            "text": text,
            "sub": "Not yet? Tap Open campaign. Tap **Apply**, answer the questions, then tap **Submit application**.",
            "button": {"label": "Yes, I applied", "external": False, "action": "said_applied"},
            "asks": [not_eligible, submit_ask],
            "glass": [_open(url)],
        }
    if membership == "waiting":
        return {
            "kind": "wait",
            "chip": chip_text,
            "text": text,
            "sub": "Content Rewards shows **Pending review** while the brand decides.",
            "asks": [not_eligible, submit_ask],
            "glass": [_open(url)],
        }
    if membership == "left":
        return {"kind": "join", "chip": chip_text, "text": text, "button": _open(url), "asks": [submit_ask]}
    return {"kind": "pick_another", "chip": chip_text, "text": text, "button": _another()}
