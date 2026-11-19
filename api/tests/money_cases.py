"""The shared golden cases of the money dashboard (docs/CONTRACTS.md §27.9).

``fixtures/money_summary_cases.json`` holds about 25 owners' stored money days and what ``GET /v1/money/summary``
answers for them. pytest checks the server against it (``test_money_summary.py``) and vitest checks the web mock's
copy (``web/src/api/mock/moneySummary.ts``) against the same file, so the two always agree.

Run ``uv run python tests/money_cases.py`` to write the file again after a deliberate change: the expected answers
come from ``summary.summarize`` and every case is then read by hand in review (the key ones also have their own
hand-written asserts in ``test_money_summary.py``).
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

FILE = Path(__file__).parent / "fixtures" / "money_summary_cases.json"
TODAY = "2026-11-19"
WHERE = {
    "youtube": {"label": "AdSense for YouTube › Payments", "url": "https://adsense.google.com/"},
    "tiktok": {"label": "Profile › Balance"},
    "instagram": {"label": "Professional dashboard › Payouts"},
    "facebook": {"label": "Meta Business Suite › Payouts", "url": "https://business.facebook.com/latest/monetization"},
    "x": {"label": "X › Monetization (paid through Stripe)", "url": "https://x.com/settings/monetization"},
}
OK = {"connected": True, "moneyScope": True, "lastError": None}


def rows_of(case: dict[str, Any]) -> list[dict[str, Any]]:
    """The stored rows a case describes: each series is one amount a day from ``start`` (null: no row that day)."""
    revised = {(r["platform"], r["date"]) for r in case.get("revised", [])}
    out = []
    for s in case["series"]:
        start = date.fromisoformat(s["start"])
        for i, amount in enumerate(s["amounts"]):
            if amount is None:
                continue
            day = (start + timedelta(days=i)).isoformat()
            row = {"platform": s["platform"], "date": day, "amountMicros": amount, "currency": s["currency"]}
            if (s["platform"], day) in revised:
                row["revisedAt"] = "2026-11-18T06:00:00.000Z"
            out.append(row)
    return out


def _wave(days: int, base: int, step: int) -> list[int | None]:
    return [base + (i % 7) * step + i * 300 for i in range(days)]


def _start(days_back: int, end: str = "2026-11-16") -> str:
    return (date.fromisoformat(end) - timedelta(days=days_back - 1)).isoformat()


def _case(name: str, series: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
    return {
        "name": name,
        "today": kw.pop("today", TODAY),
        "platforms": kw.pop("platforms", []),
        "chart": kw.pop("chart", 30),
        "facebookVerified": kw.pop("facebookVerified", True),
        "status": kw.pop("status", {"youtube": OK, "facebook": OK}),
        "series": series,
        **kw,
    }


def _yt(
    days: int, amounts: list[int | None] | None = None, end: str = "2026-11-16", currency: str = "USD"
) -> dict[str, Any]:
    return {
        "platform": "youtube",
        "currency": currency,
        "start": _start(days, end),
        "amounts": amounts if amounts is not None else _wave(days, 400_000, 90_000),
    }


def _fb(days: int, currency: str = "USD", end: str = "2026-11-16") -> dict[str, Any]:
    return {
        "platform": "facebook",
        "currency": currency,
        "start": _start(days, end),
        "amounts": _wave(days, 50_000, 20_000),
    }


def cases() -> list[dict[str, Any]]:
    flat = [1_000_000] * 60
    return [
        _case("youtube 400 days, all apps", [_yt(400)]),
        _case("youtube only filter", [_yt(400)], platforms=["youtube"]),
        _case("youtube 400 days, 365 chart in weeks", [_yt(400)], chart=365),
        _case("youtube 400 days, 7 day chart", [_yt(400)], chart=7),
        _case("youtube 400 days, 90 day chart", [_yt(400)], chart=90),
        _case("youtube 75 days: 90 chart starts at history, no last 365", [_yt(75)], chart=90),
        _case("youtube 75 days, year chart", [_yt(75)], chart=365),
        _case("short history: no comparisons", [_yt(20)]),
        _case("exactly 60 days: monthly compares", [_yt(60, flat)]),
        _case("59 days: monthly does not compare", [_yt(59, flat[:59])]),
        _case(
            "missing days inside history count as 0",
            [_yt(70, [None if i % 3 == 0 and i > 0 else 500_000 for i in range(70)])],
        ),
        _case("previous 0, now money: new", [_yt(60, [0] * 30 + [200_000] * 30)]),
        _case("both 0: no chip", [_yt(60, [0] * 60)]),
        _case("same: under half a percent", [_yt(60, [1_000_000] * 30 + [1_000_001] * 30)]),
        _case("down 50 percent", [_yt(60, [2_000_000] * 30 + [1_000_000] * 30)]),
        _case("up over 999 percent", [_yt(60, [1_000] * 30 + [5_000_000] * 30)]),
        _case(
            "youtube and facebook: periods end on the earlier newest day",
            [_yt(130), _fb(120, end="2026-11-14")],
            platforms=["youtube", "facebook"],
        ),
        _case("two currencies are never added", [_yt(130), _fb(120, currency="EUR")]),
        _case("facebook not verified: coming soon", [_yt(90)], facebookVerified=False),
        _case("only apps that don't share", [_yt(90)], platforms=["tiktok", "x"]),
        _case(
            "youtube needs permission, facebook not connected",
            [],
            status={"youtube": {"connected": True, "moneyScope": False}, "facebook": {"connected": False}},
        ),
        _case("youtube connected, no rows yet", [], status={"youtube": OK, "facebook": {"connected": False}}),
        _case(
            "collector error keeps youtube in, stale after 6 days",
            [_yt(80, end="2026-11-10")],
            status={"youtube": {**OK, "lastError": "YouTube didn't answer."}, "facebook": {"connected": False}},
        ),
        _case(
            "revised days only inside the 60 shown days",
            [_yt(120)],
            revised=[
                {"platform": "youtube", "date": "2026-11-01"},
                {"platform": "youtube", "date": "2026-10-20"},
                {"platform": "youtube", "date": "2026-08-01"},
            ],
        ),
        _case("rows after through are left out", [_yt(90), _fb(90, end="2026-11-12")], chart=7),
        _case("negative day (a platform correction) rounds half away from zero", [_yt(60, [-15] * 30 + [-45] * 30)]),
        _case("10 days so far: daily and pace use the 10 covered days", [_yt(10, [1_000_000] * 10)]),
        _case(
            "facebook behind is left out so youtube stays current",
            [_yt(130), _fb(60, end="2026-10-27")],
            platforms=["youtube", "facebook"],
        ),
        _case(
            "facebook behind with an error, youtube current",
            [_yt(130), _fb(60, end="2026-10-27")],
            status={"youtube": OK, "facebook": {**OK, "lastError": "Meta didn't answer."}},
        ),
        _case(
            "collector error and no rows: an error, not no money yet",
            [],
            status={"youtube": {**OK, "lastError": "YouTube didn't answer."}, "facebook": {"connected": False}},
        ),
    ]


def build() -> dict[str, Any]:
    from clipfactory_api.money import summary

    out = []
    for case in cases():
        expected = summary.summarize(
            today=date.fromisoformat(case["today"]),
            platforms=case["platforms"],
            chart=case["chart"],
            rows=rows_of(case),
            status=case["status"],
            facebook_verified=case["facebookVerified"],
            where=WHERE,
        )
        out.append({**case, "expected": expected})
    return {"where": WHERE, "cases": out}


if __name__ == "__main__":
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    FILE.write_text(json.dumps(build(), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {FILE}")
