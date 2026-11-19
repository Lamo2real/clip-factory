"""The money dashboard's numbers (docs/CONTRACTS.md §27.2, §27.3, §27.5, ADR-50): ``GET /v1/money/summary``.

"MRR" for a creator paid per view is the money the platforms reported over a recent stretch of days. Every period
is a sum of stored ``REVENUE#{platform}#{day}`` rows and ends on ``through``: the earliest newest reported day across
the counted apps, so each app covers the same days (YouTube is 2-3 days behind; ending on today would make every
period look short).

* Monthly: the 30 days ending on ``through``, compared with the 30 before. Weekly: 7 days, compared with the 7 before.
* Daily: the 30-day sum divided by the days of it that stored history covers (``coveredDays``, 30 once history
  reaches back that far), in whole micros, half away from zero. Latest day: the amount on ``through``.
* Yearly: the "at this pace" figure, monthly times 12 once 30 days are covered (the 30-day sum times 360 divided by
  the covered days before that, so a new channel's pace is not cut short). It is worked out here so the web never
  multiplies money, and it is never added to anything. "Last 365 days" is a real sum, only once stored history covers
  all of it.
* An app whose newest day is more than 6 days old while another counted app is up to date is left out (``behind``),
  so it cannot pull every period back; when every counted app is that old the periods end on it and ``stale`` is on.
* A missing day inside an app's history counts as 0; a day before its first stored row is not covered. A comparison
  shows only when every counted app covers the whole previous period.
* Currencies are never converted or added together: one ``currencies`` entry per currency.

``summarize`` is pure (it is checked against ``api/tests/fixtures/money_summary_cases.json``, which the web mock's
copy, ``web/src/api/mock/moneySummary.ts``, reads too). ``money_summary`` loads one owner's items and calls it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta
from typing import Any

from .. import db, posts
from ..clock import iso
from . import MONEY_ORDER, label, revenue_prefix, rules, sources, state_sk
from .view import money_shown, tag

Item = dict[str, Any]

CHARTS = (7, 30, 90, 365)
MONEY_PLATFORMS = frozenset({"youtube", "facebook"})
STALE_DAYS = 6
LAG_NOTES = {"youtube": "YouTube is 2–3 days behind", "facebook": "Facebook can take 2 days"}
MIXED_TAG = "Apps' estimates"


# --- small integer helpers (the web mock does the same, step by step) -------------------------------------------


def div_round(num: int, den: int) -> int:
    """``num / den`` rounded half away from zero, in whole numbers only (no floats, so both copies agree)."""
    if den == 0:
        raise ZeroDivisionError
    if den < 0:
        num, den = -num, -den
    q, r = divmod(abs(num), den)
    if 2 * r >= den:
        q += 1
    return q if num >= 0 else -q


def change(current: int, previous: int | None) -> Item:
    """The comparison chip's data: ``direction`` says it in words (up, down, same, new, none)."""
    if previous is None:
        return {"previousPeriodMicros": None, "changePct": None, "direction": "none"}
    if previous == 0:
        return {"previousPeriodMicros": 0, "changePct": None, "direction": "new" if current > 0 else "none"}
    pct = div_round((current - previous) * 100, abs(previous))  # a negative period (a correction) still reads right
    direction = "up" if pct > 0 else "down" if pct < 0 else "same"
    return {"previousPeriodMicros": previous, "changePct": pct, "direction": direction}


def _d(day: str) -> date:
    return date.fromisoformat(day)


def _s(day: date) -> str:
    return day.isoformat()


# --- the pure summary ------------------------------------------------------------------------------------------------


def order(platforms: Iterable[str]) -> list[str]:
    wanted = set(platforms)
    return [p for p in MONEY_ORDER if p in wanted]


def _excluded(platform: str, status: Mapping[str, Any], *, verified: bool, has_rows: bool, where: Item) -> Item | None:
    name = label(platform)
    if platform not in MONEY_PLATFORMS:
        return {
            "platform": platform,
            "reason": "not_shared",
            "text": f"{name} doesn't share money with apps.",
            "where": where,
        }
    if platform == "facebook" and not verified:
        return {"platform": platform, "reason": "coming_soon", "text": "Facebook money: coming soon."}
    if not status.get("connected"):
        return {
            "platform": platform,
            "reason": "not_connected",
            "text": f"Connect {name} in Settings › Posting › Set up posting.",
        }
    if platform == "youtube" and not status.get("moneyScope"):
        return {"platform": platform, "reason": "needs_permission", "text": f"{name} needs your OK first."}
    if not has_rows and status.get("lastError"):
        # A broken check with nothing stored is not "you earned nothing".
        return {"platform": platform, "reason": "error", "text": f"Couldn't check {name} today."}
    if not has_rows:
        return {"platform": platform, "reason": "no_money_yet", "text": f"No money from {name} yet."}
    return None


def _total(by_day: Mapping[str, Mapping[str, int]], start: date, end: date) -> int:
    n = 0
    cursor = start
    while cursor <= end:
        n += sum(by_day.get(_s(cursor), {}).values())
        cursor += timedelta(days=1)
    return n


def _chart(
    period: int,
    through: date,
    *,
    by_day: Mapping[str, Mapping[str, int]],
    plats: list[str],
    history: Mapping[str, date],
) -> Item:
    """Day bars (7, 30, 90) or week bars ending on ``through`` (365, the oldest week marked ``partial``). Days
    before the first stored row are not drawn."""
    start_of_history = min(history[p] for p in plats)

    def point(start: date, end: date) -> Item:
        amount = 0
        by: dict[str, int] = {}
        cursor = start
        while cursor <= end:
            found = by_day.get(_s(cursor), {})
            for p in plats:
                if history[p] <= cursor:
                    by[p] = by.get(p, 0) + int(found.get(p, 0))
                    amount += int(found.get(p, 0))
            cursor += timedelta(days=1)
        return {"start": _s(start), "end": _s(end), "amountMicros": amount, "byPlatform": by}

    points: list[Item] = []
    if period == 365:
        oldest = through - timedelta(days=364)
        for k in range(52, -1, -1):
            end = through - timedelta(days=7 * k)
            if end < start_of_history or end < oldest:
                continue
            start = max(end - timedelta(days=6), oldest, start_of_history)
            found = point(start, end)
            if (end - start).days < 6:
                found["partial"] = True
            points.append(found)
    else:
        for k in range(period - 1, -1, -1):
            day = through - timedelta(days=k)
            if day >= start_of_history:
                points.append(point(day, day))
    return {
        "period": period,
        "bucket": "week" if period == 365 else "day",
        "from": points[0]["start"] if points else _s(through),
        "to": _s(through),
        "points": points,
    }


def _entry(
    currency: str,
    by_day: Mapping[str, Mapping[str, int]],
    *,
    through: date,
    plats: list[str],
    history: Mapping[str, date],
    chart: int,
) -> Item:
    """One currency's cards and chart (§27.2)."""
    t = through

    def back(n: int) -> date:
        return t - timedelta(days=n)

    def covered(start: date) -> bool:
        return all(history[p] <= start for p in plats)

    # The days of the last 30 that stored history covers: a new channel's 10 days are 10 days, not 30.
    first = min(history[p] for p in plats)
    days = max(1, min(30, (t - first).days + 1))
    monthly = _total(by_day, back(29), t)
    prev_month = _total(by_day, back(59), back(30)) if covered(back(59)) else None
    weekly = _total(by_day, back(6), t)
    prev_week = _total(by_day, back(13), back(7)) if covered(back(13)) else None
    daily_change = change(monthly, prev_month)
    if prev_month is not None:
        daily_change["previousPeriodMicros"] = div_round(prev_month, 30)
    return {
        "currency": currency,
        "tag": tag(plats[0]) if len(plats) == 1 else MIXED_TAG,
        "platforms": plats,
        "coveredDays": days,
        "monthly": {"amountMicros": monthly, "from": _s(back(29)), "to": _s(t), **change(monthly, prev_month)},
        "weekly": {"amountMicros": weekly, "from": _s(back(6)), "to": _s(t), **change(weekly, prev_week)},
        "daily": {
            "averageMicros": div_round(monthly, days),
            "from": _s(back(29)),
            "to": _s(t),
            "latest": {"date": _s(t), "amountMicros": sum(by_day.get(_s(t), {}).values())},
            **daily_change,
        },
        "yearly": {
            "paceMicros": div_round(monthly * 360, days),  # monthly x 12 once 30 days are covered
            "last365Micros": _total(by_day, back(364), t) if covered(back(364)) else None,
        },
        "chart": _chart(chart, t, by_day=by_day, plats=plats, history=history),
    }


def _split(
    asked: list[str],
    by_platform: Mapping[str, list[Mapping[str, Any]]],
    status: Mapping[str, Mapping[str, Any]],
    *,
    facebook_verified: bool,
    where: Mapping[str, Item],
) -> tuple[list[str], list[Item]]:
    included: list[str] = []
    excluded: list[Item] = []
    for p in asked:
        out = _excluded(
            p,
            status.get(p, {}),
            verified=facebook_verified,
            has_rows=bool(by_platform.get(p)),
            where=dict(where.get(p, {"label": label(p)})),
        )
        if out is None:
            included.append(p)
        else:
            excluded.append(out)
    return included, excluded


def _revised(included: list[str], by_platform: Mapping[str, list[Mapping[str, Any]]], through: date) -> Item:
    """Days YouTube (or Meta) changed after a re-read, inside the 60 days the cards compare."""
    start, end = _s(through - timedelta(days=59)), _s(through)
    days = 0
    platforms = []
    for p in included:
        n = sum(1 for r in by_platform[p] if r.get("revisedAt") and start <= str(r["date"]) <= end)
        if n:
            days += n
            platforms.append(p)
    return {"days": days, "platforms": platforms}


def _errors(platforms: list[str], status: Mapping[str, Mapping[str, Any]]) -> list[Item]:
    errors = []
    for p in platforms:
        if status.get(p, {}).get("lastError"):
            item: Item = {"platform": p, "text": f"Couldn't check {label(p)} today."}
            checked = status.get(p, {}).get("checkedAt")
            if checked:
                item["checkedAt"] = checked
            errors.append(item)
    return errors


def summarize(
    *,
    today: date,
    platforms: list[str],
    chart: int,
    rows: Iterable[Mapping[str, Any]],
    status: Mapping[str, Mapping[str, Any]],
    facebook_verified: bool,
    where: Mapping[str, Item],
) -> Item:
    """The MoneySummary of §27.5 without ``asOf``. ``rows``: stored REVENUE# rows (``platform``, ``date``,
    ``amountMicros``, ``currency``, optional ``revisedAt``). ``status[p]``: ``connected``, ``moneyScope``,
    ``lastError``, ``checkedAt``. ``where[p]``: the app's ``paidWhere``."""
    asked = order(platforms) or list(MONEY_ORDER)
    by_platform: dict[str, list[Mapping[str, Any]]] = {}
    for r in rows:
        if isinstance(r.get("amountMicros"), int) and isinstance(r.get("date"), str) and r.get("currency"):
            by_platform.setdefault(str(r.get("platform")), []).append(r)
    included, excluded = _split(asked, by_platform, status, facebook_verified=facebook_verified, where=where)
    summary: Item = {
        "platforms": asked,
        "included": included,
        "excluded": excluded,
        "through": None,
        "throughBy": {},
        "historyFrom": {},
        "currencies": [],
        "revised": {"days": 0, "platforms": []},
        "errors": [],
        "behind": [],
        "stale": False,
    }
    errored = [e["platform"] for e in excluded if e["reason"] == "error"]
    if not included:
        summary["errors"] = _errors(errored, status)
        return summary
    newest = {p: max(str(r["date"]) for r in by_platform[p]) for p in included}
    oldest_ok = today - timedelta(days=STALE_DAYS)
    behind = [p for p in included if _d(newest[p]) < oldest_ok]
    if behind and len(behind) < len(included):
        # One app falling behind would pull every app's days back: count the up-to-date ones, say which is behind.
        for p in behind:
            d = _d(newest[p])
            excluded.append(
                {
                    "platform": p,
                    "reason": "behind",
                    "text": f"{label(p)} hasn't sent money since {d:%a} {d.day} {d:%b}. Not counted for now.",
                }
            )
        included = [p for p in included if p not in behind]
        excluded.sort(key=lambda e: MONEY_ORDER.index(e["platform"]))
        summary["included"] = included
    summary["behind"] = behind
    through_by = {p: newest[p] for p in included}
    history_from = {p: min(str(r["date"]) for r in by_platform[p]) for p in included}
    through = _d(min(through_by.values()))
    history = {p: _d(d) for p, d in history_from.items()}
    summary.update(through=_s(through), throughBy=through_by, historyFrom=history_from)
    lag = next((LAG_NOTES[p] for p in ("youtube", "facebook") if p in included), None)
    if lag:
        summary["lagNote"] = lag
    summary["stale"] = through < today - timedelta(days=STALE_DAYS)

    # currency → day → platform → micros, only days up to `through`.
    days: dict[str, dict[str, dict[str, int]]] = {}
    for p in included:
        for r in by_platform[p]:
            if str(r["date"]) <= _s(through):
                cur = days.setdefault(str(r["currency"]), {}).setdefault(str(r["date"]), {})
                cur[p] = cur.get(p, 0) + int(r["amountMicros"])
    entries = []
    for currency, by_day in days.items():
        plats = [p for p in included if any(p in v for v in by_day.values())]
        entries.append(_entry(currency, by_day, through=through, plats=plats, history=history, chart=chart))
    entries.sort(key=lambda e: (-int(e["monthly"]["amountMicros"]), str(e["currency"])))
    summary["currencies"] = entries
    summary["revised"] = _revised(included, by_platform, through)
    summary["errors"] = _errors(order([*included, *errored, *behind]), status)
    return summary


# --- loading one owner -------------------------------------------------------------------------------------------


def parse_platforms(raw: str | None) -> list[str] | None:
    """``youtube,facebook`` → the apps in STATS_ORDER (duplicates folded); None for an unknown name."""
    if not raw:
        return list(MONEY_ORDER)
    names = [n.strip() for n in raw.split(",") if n.strip()]
    if any(n not in MONEY_ORDER for n in names):
        return None
    return order(names) or list(MONEY_ORDER)


def money_summary(
    store: db.Store,
    user_id: str,
    now: datetime,
    *,
    platforms: list[str],
    chart: int,
    cfg: rules.Monetization | None = None,
) -> Item:
    cfg = cfg or rules.load()
    pk = db.user_pk(user_id)
    status: dict[str, Item] = {}
    rows: list[Item] = []
    for p in order(platforms):
        if p not in MONEY_PLATFORMS or not money_shown(cfg, p):
            continue
        account = posts.connected_account(store, user_id, p)
        state = store.get(pk, state_sk(p)) or {}
        status[p] = {
            "connected": account is not None,
            "moneyScope": account is not None
            and (p != "youtube" or sources.MONETARY_SCOPE in {str(s) for s in account.get("scopes") or []}),
            "lastError": state.get("lastError"),
            "checkedAt": state.get("lastCheckedAt"),
        }
        if account is not None:
            for r in store.query_all(pk, revenue_prefix(p)):
                rows.append(
                    {
                        "platform": p,
                        "date": r.get("date"),
                        "amountMicros": r.get("amountMicros"),
                        "currency": r.get("currency"),
                        "revisedAt": r.get("revisedAt"),
                    }
                )
    where = {p: dict(cfg.platform(p).paid_where) for p in MONEY_ORDER}
    out = summarize(
        today=now.date(),
        platforms=platforms,
        chart=chart,
        rows=rows,
        status=status,
        facebook_verified=cfg.platform("facebook").money_verified,
        where=where,
    )
    out["asOf"] = iso(now)
    return out


__all__ = ["CHARTS", "change", "div_round", "money_summary", "parse_platforms", "summarize"]
