"""The public money shapes (docs/CONTRACTS.md §25.5): ``MoneyView``, the money days, and the per-clip and per-week
money of the clip page and This week.

Every money figure carries ``platform``, ``source``, ``currency`` and the platform's estimate tag. No token, raw
platform body, paging URL or scope URL is ever in here. Amounts are never converted: ``thisMonth`` has one line per
currency.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta
from typing import Any

from .. import db, posts
from . import MONEY_ORDER, PREFS_SK, label, revenue_prefix, rules, sources, state_sk

Item = dict[str, Any]
PILL = {
    "earning": "Earning",
    "in_program": "In the program",
    "goal_reached": "Goal reached",
    "not_yet": "Not yet",
    "counting": "Counting",
    "unknown": "Can't tell",
    "needs_permission": "Needs your OK",
    "not_available": "Not shared",
    "not_connected": "Not connected",
    "error": "Couldn't check",
}
LAG = {"youtube": "2–3 days behind", "facebook": "Can take 2 days"}
MONEY_PLATFORMS = frozenset({"youtube", "facebook"})
LAST_DAYS = 30
MONTHS = 12
MAX_DAYS_RANGE = 400


def tag(platform: str) -> str:
    return "Meta's estimate" if platform in {"facebook", "instagram"} else f"{label(platform)}'s estimate"


def money_shown(cfg: rules.Monetization, platform: str) -> bool:
    """Whether this platform's money may be shown at all: YouTube, and Facebook only after its live check."""
    if platform == "facebook":
        return cfg.platform("facebook").money_verified
    return platform == "youtube"


def _needs_permission(platform: str, account: Mapping[str, Any]) -> Item | None:
    scopes = {str(s) for s in account.get("scopes") or []}
    if platform == "youtube" and sources.MONETARY_SCOPE not in scopes:
        return {
            "what": "money",
            "button": "Allow money reading",
            "steps": [
                "Ask a grown-up. Use the same Google Cloud project. Don't make new keys.",
                "In Google Cloud › Data access, add the money permission below.",
                "In Google Cloud › Audience, Publishing status must say In production.",
                'Press Allow money reading. Google\'s "unverified app" screen is normal: press Advanced, then Continue.',
            ],
            "copy": [{"label": "Money permission", "value": sources.MONETARY_SCOPE}],
            "open": {"label": "Open Data access", "url": "https://console.cloud.google.com/auth/scopes"},
        }
    if platform == "tiktok" and sources.TIKTOK_STATS_SCOPE not in scopes:
        return {
            "what": "followers",
            "button": "Allow follower reading",
            "steps": [
                "Ask a grown-up. In TikTok for Developers, add the permission below and send the app for review.",
                "Wait until TikTok approves it.",
                "Press Allow follower reading. Until TikTok approves, nothing changes and posting keeps working.",
            ],
            "copy": [{"label": "Permission", "value": sources.TIKTOK_STATS_SCOPE}],
            "open": {"label": "Open TikTok for Developers", "url": "https://developers.tiktok.com/apps/"},
        }
    return None


def _days(rows: Iterable[Mapping[str, Any]], currency: str) -> dict[str, int]:
    return {
        str(r["date"]): int(r["amountMicros"])
        for r in rows
        if r.get("currency") == currency and isinstance(r.get("amountMicros"), int) and isinstance(r.get("date"), str)
    }


def revenue_block(platform: str, rows: list[Item], now: datetime, cfg: rules.Monetization) -> Item | None:
    """This month, the last 30 days and the last 12 months of one platform's reported money, in its own currency."""
    if not rows:
        return None
    newest = max(rows, key=lambda r: str(r.get("date")))
    currency = str(newest.get("currency") or "")
    if not currency:
        return None
    by_day = _days(rows, currency)
    today = now.date()
    month = today.strftime("%Y-%m")
    last30 = []
    for i in range(LAST_DAYS, 0, -1):
        day = (today - timedelta(days=i)).isoformat()
        if day in by_day:
            last30.append({"date": day, "amountMicros": by_day[day]})
    months: dict[str, int] = {}
    for day, amount in by_day.items():
        months[day[:7]] = months.get(day[:7], 0) + amount
    keep = sorted(months)[-MONTHS:]
    p = cfg.platform(platform)
    return {
        "platform": platform,
        "currency": currency,
        "unit": str(newest.get("unit") or currency),
        "source": str(newest.get("source") or ""),
        "tag": tag(platform),
        "note": p.money_note or "",
        "month": month,
        "thisMonthMicros": months.get(month, 0),
        "last30": last30,
        "months": [{"month": m, "amountMicros": months[m]} for m in keep],
        "revised": any(r.get("revisedAt") for r in rows if str(r.get("date", "")).startswith(month)),
    }


def _goals(out: Item, platform: str, picked: rules.Rule | str | None, numbers: Item, *, in_program: bool) -> list[Item]:
    goals: list[Item] = []
    if isinstance(picked, rules.Rule):
        goals, more = rules.progress(picked, numbers)
        out["goals"], out["more"] = goals, more
        if picked.upcoming and not in_program:
            out["extras"].append(picked.upcoming)
    elif picked == "no_country":
        out["extras"].append("Pick your country at the top to see this program's goals.")
    elif picked == "not_open":
        out["extras"].append(
            f"{out['programme']} is not open in your country. Check its rules in the {label(platform)} app."
        )
    return goals


def _shown(platform: str, state: Mapping[str, Any], goals: list[Item], *, needs: bool) -> str:
    """The card's state: the stored one, with "Goal reached" and "Counting" worked out from the goals."""
    if not state:  # never checked yet
        if needs:
            return "needs_permission"
        return {"facebook": "unknown", "youtube": "counting"}.get(platform, "not_available")
    shown = str(state.get("state") or "") or ("needs_permission" if needs else "not_available")
    if shown in {"not_yet", "not_available", "unknown"} and goals and rules.all_reached(goals):
        return "goal_reached"
    if shown == "not_available" and any(g.get("countingDaysLeft") for g in goals):
        return "counting"
    return shown


def _extras(out: Item, platform: str, state: Mapping[str, Any], p: rules.PlatformRules) -> None:
    if platform == "youtube" and state.get("adsOn"):
        out["extras"].append("Ads are on.")
    if platform == "tiktok":
        if isinstance(state.get("longVideos"), int):
            out["extras"].append(f"Videos 1 min or longer: {state['longVideos']} of your last 20.")
        out["extras"].append("Deleted or private videos aren't counted.")
        if p.warning:
            out["extras"].append(p.warning)
    if platform == "instagram":
        out["extras"].append("If your Reels also go to a Facebook Page, look at the Facebook card too.")
    if platform == "facebook":
        out["goals"] = facebook_facts(state)
        if p.invites:
            out["extras"].append(p.invites)


def _money(
    out: Item, platform: str, state: Mapping[str, Any], rows: list[Item], *, cfg: rules.Monetization, now: datetime
) -> None:
    month = now.strftime("%Y-%m")
    if money_shown(cfg, platform):
        stored = str(state.get("state") or "")
        block = revenue_block(platform, rows, now, cfg) if stored in {"in_program", "earning"} else None
        if block is not None:
            out["revenue"] = block
        approx = state.get("approxMonth")
        if platform == "facebook" and isinstance(approx, dict) and approx.get("month") == month:
            out["approxMonth"] = {**approx, "tag": "Meta's estimate", "note": "Doesn't include bonuses"}
        split = state.get("split")
        if platform == "youtube" and isinstance(split, dict) and split.get("month") == month:
            out["split"] = dict(split)
    elif platform == "facebook":
        out["comingSoon"] = "Facebook money: coming soon. A grown-up checks it once against Meta Business Suite first."
    else:
        out["notShared"] = f"{label(platform)} doesn't share earnings with apps."


def card(
    platform: str,
    account: Mapping[str, Any] | None,
    *,
    state: Mapping[str, Any],
    rows: list[Item],
    cfg: rules.Monetization,
    now: datetime,
    country: str | None,
) -> Item:
    p = cfg.platform(platform)
    out: Item = {
        "platform": platform,
        "programme": p.programme,
        "statusWhere": dict(p.status_where),
        "paidWhere": dict(p.paid_where),
        "goals": [],
        "more": [],
        "extras": [],
    }
    if account is None or account.get("status") != "connected":
        out.update(
            state="not_connected",
            pill=PILL["not_connected"],
            line=f"Connect {label(platform)} in Settings › Posting › Set up posting to see this.",
        )
        return out
    in_program = str(state.get("state") or "") in {"in_program", "earning"}
    numbers: Item = {
        **(state.get("numbers") or {}),
        "missing": dict(state.get("missing") or {}),
        "counting": dict(state.get("counting") or {}),
    }
    picked = rules.pick(cfg, platform, today=now.date(), in_program=in_program, country=country)
    goals = _goals(out, platform, picked, numbers, in_program=in_program)
    needs = _needs_permission(platform, account)
    if needs is not None:
        out["needsPermission"] = needs
    shown = _shown(platform, state, goals, needs=needs is not None)
    out["state"] = shown
    out["pill"] = PILL.get(shown, PILL["error"])
    out["line"] = _line(platform, shown, p, goals, state)
    for name in ("lastCheckedAt", "detectedAt", "earningSince", "lastError"):
        if state.get(name):
            out["checkedAt" if name == "lastCheckedAt" else name] = state[name]
    if platform in LAG:
        out["lagNote"] = LAG[platform]
    _extras(out, platform, state, p)
    _money(out, platform, state, rows, cfg=cfg, now=now)
    return out


def facebook_facts(state: Mapping[str, Any]) -> list[Item]:
    """Facebook has no finish line (Meta publishes none), so its card shows numbers without bars."""
    numbers = state.get("numbers") or {}
    missing = state.get("missing") or {}
    facts = []
    for key, text, note in (
        ("followers", "followers", None),
        ("minutes60", "minutes watched in 60 days", "Our count. Meta's may differ."),
        ("qualifiedViews60", "views that can earn in 60 days", None),
    ):
        value = numbers.get(key)
        fact: Item = {
            "key": key,
            "label": text,
            "kind": "number",
            "current": int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None,
            "goal": None,
            "reached": False,
            "approx": key == "minutes60",
            "sourceUrl": "https://www.facebook.com/business/help",
        }
        if note:
            fact["note"] = note
        if fact["current"] is None:
            fact["missing"] = str(missing.get(key) or "Meta didn't share this.")
        facts.append(fact)
    return facts


def _line(platform: str, shown: str, p: rules.PlatformRules, goals: list[Item], state: Mapping[str, Any]) -> str:
    name = label(platform)
    if shown == "earning":
        return f"You're earning on {name}."
    if shown == "in_program":
        return f"You're in {p.programme}. Money shows here when {name} reports some."
    if shown == "not_yet":
        return f"Not in {p.programme} yet. Here's how close you are."
    if shown == "goal_reached":
        return f"Goal reached. {name} also checks things we can't see."
    if shown == "counting":
        if platform == "youtube":
            return "Clip Factory checks once a day. Your numbers show here after the first check."
        left = max((int(g.get("countingDaysLeft") or 0) for g in goals), default=0)
        return f"Counting your views… {left} days to go."
    if shown == "unknown":
        return "Meta doesn't tell apps if you've joined."
    if shown == "needs_permission":
        what = "money" if platform == "youtube" else "followers"
        return f"{name} needs your OK before Clip Factory can read {what}."
    if shown == "not_available":
        return f"{name} doesn't tell apps if you're getting paid. Check {p.status_where['label']}."
    return str(state.get("lastError") or "Couldn't check. Clip Factory tries again tomorrow.")


def money_view(store: db.Store, user_id: str, now: datetime, cfg: rules.Monetization | None = None) -> Item:
    cfg = cfg or rules.load()
    pk = db.user_pk(user_id)
    states = {str(i["sk"]).removeprefix("MONEYSTATE#"): i for i in store.query_all(pk, "MONEYSTATE#")}
    accounts = {str(a.get("platform")): a for a in posts.account_items(store, user_id)}
    prefs = store.get(pk, PREFS_SK) or {}
    country = prefs.get("country") if isinstance(prefs.get("country"), str) else None
    cards = []
    for platform in MONEY_ORDER:
        acct = posts.connected_account(store, user_id, platform) or accounts.get(platform)
        rows = store.query_all(pk, revenue_prefix(platform)) if money_shown(cfg, platform) else []
        cards.append(card(platform, acct, state=states.get(platform, {}), rows=rows, cfg=cfg, now=now, country=country))
    totals: dict[str, Item] = {}
    for c in cards:
        block = c.get("revenue")
        if c["state"] != "earning" or not block:
            continue
        line = totals.setdefault(block["currency"], {"currency": block["currency"], "amountMicros": 0, "platforms": []})
        line["amountMicros"] += block["thisMonthMicros"]
        line["platforms"].append(c["platform"])
    celebrations = [
        {k: c.get(k) for k in ("key", "platform", "kind", "text")}
        for platform in MONEY_ORDER
        for c in (states.get(platform, {}).get("pendingCelebrations") or [])
        if isinstance(c, dict) and c.get("key") and c["key"] not in (states.get(platform, {}).get("celebrated") or {})
    ]
    view: Item = {
        "platforms": cards,
        "country": country,
        "countries": [dict(c) for c in cfg.countries],
        "thisMonth": list(totals.values()),
        "celebrations": celebrations,
        "asOf": cfg.as_of.isoformat(),
    }
    last = prefs.get("lastManualAt")
    if isinstance(last, str):
        from ..clock import iso, parse

        moment = parse(last)
        if moment is not None and moment + timedelta(hours=1) > now:
            view["nextCheckAllowedAt"] = iso(moment + timedelta(hours=1))
    return view


def day_rows(store: db.Store, user_id: str, platform: str, start: date, end: date) -> list[Item]:
    rows = store.query_all(db.user_pk(user_id), revenue_prefix(platform))
    out = []
    for r in rows:
        day = str(r.get("date") or "")
        if start.isoformat() <= day <= end.isoformat():
            item = {k: r.get(k) for k in ("date", "amountMicros", "currency", "unit", "source")}
            if r.get("revisedAt"):
                item["revisedAt"] = r["revisedAt"]
            item["platform"] = platform
            item["tag"] = tag(platform)
            out.append(item)
    return sorted(out, key=lambda i: str(i["date"]))


def clip_revenue(post: Mapping[str, Any], cfg: rules.Monetization | None = None) -> Item | None:
    """A Post's reported money for the clip page, only when its platform reported one and may be shown."""
    platform = str(post.get("platform") or "")
    found = post.get("revenue")
    if not isinstance(found, Mapping) or not isinstance(found.get("amountMicros"), int):
        return None
    if not money_shown(cfg or rules.load(), platform):
        return None
    return {
        "platform": platform,
        "amountMicros": int(found["amountMicros"]),
        "currency": str(found.get("currency") or ""),
        "source": str(found.get("source") or ""),
        "through": found.get("through"),
        "tag": tag(platform),
    }


def week_revenue(store: db.Store, user_id: str, first_day: date, cfg: rules.Monetization | None = None) -> Item:
    """``revenueByPlatform`` of This week: each platform's reported days from the week's Monday to Sunday (the days as
    the platform counts them), one currency each; a platform with two currencies that week is left out."""
    cfg = cfg or rules.load()
    out: Item = {}
    pk = db.user_pk(user_id)
    start, end = first_day.isoformat(), (first_day + timedelta(days=7)).isoformat()
    for platform in MONEY_ORDER:
        if not money_shown(cfg, platform):
            continue
        rows = [r for r in store.query_all(pk, revenue_prefix(platform)) if start <= str(r.get("date") or "") < end]
        if not rows:
            continue
        currencies = {str(r.get("currency")) for r in rows}
        if len(currencies) != 1:
            continue
        currency = currencies.pop()
        out[platform] = {
            "platform": platform,
            "currency": currency,
            "amountMicros": sum(int(r.get("amountMicros") or 0) for r in rows),
            "source": str(rows[0].get("source") or ""),
            "tag": tag(platform),
        }
    return out


__all__ = ["card", "clip_revenue", "day_rows", "money_view", "state_sk", "week_revenue"]
