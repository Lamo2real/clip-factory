"""The money dashboard's numbers (docs/CONTRACTS.md §27.2, §27.3, §27.5, ADR-50): GET /v1/money/summary.

The shared golden cases (``fixtures/money_summary_cases.json``, also read by the web mock's tests) pin every answer;
the tests below say the rules in words with hand-worked numbers.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from clipfactory_api import db, money
from clipfactory_api.money import summary
from clipfactory_api.oauth import setup
from conftest import USER, Call
from money_cases import FILE, OK, WHERE, build, rows_of

TODAY = date(2026, 11, 19)
NOW = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)
MONETARY = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
CASES = json.loads(FILE.read_text())


def run(rows: list[dict[str, Any]], **kw: Any) -> dict[str, Any]:
    return summary.summarize(
        today=kw.pop("today", TODAY),
        platforms=kw.pop("platforms", []),
        chart=kw.pop("chart", 30),
        rows=rows,
        status=kw.pop("status", {"youtube": OK, "facebook": OK}),
        facebook_verified=kw.pop("verified", True),
        where=WHERE,
    )


def days(platform: str, end: str, amounts: list[int], currency: str = "USD", **extra: Any) -> list[dict[str, Any]]:
    last = date.fromisoformat(end)
    start = last - timedelta(days=len(amounts) - 1)
    return [
        {
            "platform": platform,
            "date": (start + timedelta(days=i)).isoformat(),
            "amountMicros": a,
            "currency": currency,
            **extra,
        }
        for i, a in enumerate(amounts)
    ]


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_golden_cases(case: dict[str, Any]) -> None:
    got = summary.summarize(
        today=date.fromisoformat(case["today"]),
        platforms=case["platforms"],
        chart=case["chart"],
        rows=rows_of(case),
        status=case["status"],
        facebook_verified=case["facebookVerified"],
        where=CASES["where"],
    )
    assert got == case["expected"]


def test_the_golden_file_is_up_to_date() -> None:
    assert build() == CASES, "run: uv run python tests/money_cases.py"


def test_periods_end_on_the_earliest_newest_day_and_later_days_wait() -> None:
    rows = days("youtube", "2026-11-16", [1_000_000] * 60) + days("facebook", "2026-11-14", [100_000] * 60)
    out = run(rows, platforms=["youtube", "facebook"])
    assert out["throughBy"] == {"youtube": "2026-11-16", "facebook": "2026-11-14"}
    assert out["through"] == "2026-11-14"
    usd = out["currencies"][0]
    assert usd["monthly"]["from"] == "2026-10-16"
    assert usd["monthly"]["to"] == "2026-11-14"
    # YouTube's 15th and 16th are left out: 30 days of each app, not 32 of one.
    assert usd["monthly"]["amountMicros"] == 30 * 1_000_000 + 30 * 100_000
    assert usd["tag"] == "Apps' estimates"
    assert usd["daily"]["latest"] == {"date": "2026-11-14", "amountMicros": 1_100_000}
    assert out["lagNote"] == "YouTube is 2–3 days behind"


def test_a_missing_day_inside_history_is_zero_and_before_history_is_not_covered() -> None:
    rows = days("youtube", "2026-11-16", [1_000_000] * 45)
    rows = [r for r in rows if r["date"] != "2026-11-10"]  # YouTube sent no row that day
    usd = run(rows)["currencies"][0]
    assert usd["monthly"]["amountMicros"] == 29 * 1_000_000
    assert usd["weekly"]["amountMicros"] == 6 * 1_000_000
    # 45 days of history: the 30 before the month are not all covered, so no comparison.
    assert usd["monthly"]["direction"] == "none"
    assert usd["monthly"]["changePct"] is None
    # The 14 days of the weeks are covered: 6 days of money against 7.
    assert usd["weekly"]["direction"] == "down"
    assert usd["weekly"]["changePct"] == -14  # (6 - 7) / 7 = -14.3 %


@pytest.mark.parametrize(
    ("current", "previous", "pct", "direction"),
    [
        (112, 100, 12, "up"),
        (92, 100, -8, "down"),
        (1000, 1000, 0, "same"),
        (1005, 1000, 1, "up"),  # 0.5 % rounds away from zero
        (995, 1000, -1, "down"),
        (1004, 1000, 0, "same"),
        (5000, 1, 499900, "up"),  # the web shows "Up 999%+"
        (300, 0, None, "new"),
        (0, 0, None, "none"),
    ],
)
def test_change_rounds_to_whole_percent(current: int, previous: int, pct: int | None, direction: str) -> None:
    out = summary.change(current, previous)
    assert out["changePct"] == pct
    assert out["direction"] == direction


def test_change_without_a_covered_previous_period_says_nothing() -> None:
    assert summary.change(100, None) == {"previousPeriodMicros": None, "changePct": None, "direction": "none"}


def test_daily_is_monthly_over_30_and_yearly_is_monthly_times_12() -> None:
    rows = days("youtube", "2026-11-16", [333_334] * 30)
    usd = run(rows)["currencies"][0]
    assert usd["monthly"]["amountMicros"] == 10_000_020
    assert usd["daily"]["averageMicros"] == 333_334
    assert usd["yearly"]["paceMicros"] == 120_000_240
    assert usd["yearly"]["last365Micros"] is None  # only 30 days stored


def test_last_365_days_is_a_real_sum_once_covered() -> None:
    rows = days("youtube", "2026-11-16", [10_000] * 365)
    assert run(rows)["currencies"][0]["yearly"]["last365Micros"] == 3_650_000
    assert run(rows[1:])["currencies"][0]["yearly"]["last365Micros"] is None


def test_currencies_are_never_added_together() -> None:
    rows = days("youtube", "2026-11-16", [1_000_000] * 30) + days("facebook", "2026-11-16", [3_000_000] * 30, "EUR")
    out = run(rows)
    assert [(c["currency"], c["monthly"]["amountMicros"], c["platforms"]) for c in out["currencies"]] == [
        ("EUR", 90_000_000, ["facebook"]),
        ("USD", 30_000_000, ["youtube"]),
    ]
    assert out["currencies"][0]["tag"] == "Meta's estimate"
    assert out["currencies"][1]["tag"] == "YouTube's estimate"


def test_revised_counts_only_inside_the_two_periods_shown() -> None:
    rows = days("youtube", "2026-11-16", [1_000] * 120)
    for r in rows:
        if r["date"] in {"2026-11-01", "2026-09-18", "2026-08-01"}:
            r["revisedAt"] = "2026-11-18T06:00:00.000Z"
    assert run(rows)["revised"] == {"days": 2, "platforms": ["youtube"]}


@pytest.mark.parametrize(
    ("platforms", "status", "verified", "reasons"),
    [
        (["tiktok", "instagram", "x"], {}, True, ["not_shared", "not_shared", "not_shared"]),
        (["facebook"], {"facebook": OK}, False, ["coming_soon"]),
        (
            ["youtube", "facebook"],
            {"youtube": {"connected": False}, "facebook": {"connected": False}},
            True,
            ["not_connected", "not_connected"],
        ),
        (["youtube"], {"youtube": {"connected": True, "moneyScope": False}}, True, ["needs_permission"]),
        (["youtube"], {"youtube": OK}, True, ["no_money_yet"]),
    ],
)
def test_excluded_apps_say_why_and_nothing_is_counted(
    platforms: list[str], status: dict[str, Any], verified: bool, reasons: list[str]
) -> None:
    out = run([], platforms=platforms, status=status, verified=verified)
    assert [e["reason"] for e in out["excluded"]] == reasons
    assert out["included"] == []
    assert out["currencies"] == []
    assert out["through"] is None
    texts = {e["platform"]: e["text"] for e in out["excluded"]}
    if "tiktok" in texts:
        assert texts["tiktok"] == "TikTok doesn't share money with apps."
        assert next(e for e in out["excluded"] if e["platform"] == "tiktok")["where"] == {"label": "Profile › Balance"}
    if "needs_permission" in reasons:
        assert texts["youtube"] == "YouTube needs your OK first."


def test_an_app_with_an_error_stays_in_and_old_days_are_stale() -> None:
    rows = days("youtube", "2026-11-12", [1_000] * 40)
    out = run(rows, status={"youtube": {**OK, "lastError": "boom", "checkedAt": "2026-11-19T06:00:00.000Z"}})
    assert out["included"] == ["youtube"]
    assert out["errors"] == [
        {"platform": "youtube", "text": "Couldn't check YouTube today.", "checkedAt": "2026-11-19T06:00:00.000Z"}
    ]
    assert out["stale"] is True  # 12 Nov is more than 6 days before 19 Nov
    assert run(days("youtube", "2026-11-13", [1_000] * 40))["stale"] is False


def test_year_chart_is_weeks_ending_on_through_with_the_oldest_partial() -> None:
    rows = days("youtube", "2026-11-16", [1_000] * 400)
    chart = run(rows, chart=365)["currencies"][0]["chart"]
    assert chart["bucket"] == "week"
    assert len(chart["points"]) == 53
    assert chart["points"][-1] == {
        "start": "2026-11-10",
        "end": "2026-11-16",
        "amountMicros": 7_000,
        "byPlatform": {"youtube": 7_000},
    }
    assert chart["points"][0]["partial"] is True
    assert chart["points"][0]["start"] == chart["points"][0]["end"] == "2025-11-17"
    assert chart["from"] == "2025-11-17"
    assert sum(p["amountMicros"] for p in chart["points"]) == 365_000


def test_day_charts_skip_days_before_history() -> None:
    rows = days("youtube", "2026-11-16", [5] * 20)
    chart = run(rows, chart=90)["currencies"][0]["chart"]
    assert chart["bucket"] == "day"
    assert len(chart["points"]) == 20
    assert chart["from"] == "2026-10-28"


def test_route_checks_its_parameters(call: Call) -> None:
    assert call("GET", "/v1/money/summary", query={"platforms": "youtube,myspace"})[1]["error"]["message"] == (
        "Pick apps from the list."
    )
    assert call("GET", "/v1/money/summary", query={"chart": "14"})[0] == 400
    status, body = call("GET", "/v1/money/summary", query={"platforms": "x,youtube,youtube", "chart": "365"})
    assert status == 200
    assert body["platforms"] == ["youtube", "x"]  # duplicates folded, STATS_ORDER
    assert body["currencies"] == []


def test_an_empty_owner_gets_no_numbers_and_is_registered(call: Call, store: db.Store) -> None:
    status, body = call("GET", "/v1/money/summary")
    assert status == 200
    assert body["platforms"] == ["youtube", "tiktok", "instagram", "facebook", "x"]
    assert body["currencies"] == []
    assert body["asOf"]
    assert store.get(money.OWNERS_PK, money.owner_sk(USER)) is not None


def test_route_reads_stored_rows_and_never_leaks_internal_fields(call: Call, store: db.Store, clock: Any) -> None:
    clock.now = NOW
    setup.put_account(store, USER, "youtube", "connected", now=NOW, fields={"accountId": "UC1", "scopes": [MONETARY]})
    pk = db.user_pk(USER)
    for r in days("youtube", "2026-11-16", [1_250_000] * 70):
        store.put(
            {
                "pk": pk,
                "sk": money.revenue_sk("youtube", r["date"]),
                "type": "revenue",
                "platform": "youtube",
                "date": r["date"],
                "amountMicros": r["amountMicros"],
                "currency": "USD",
                "unit": "USD",
                "source": "youtube.estimatedRevenue",
                "breakdown": {"adsMicros": 1},
                "previousMicros": 1,
                "estimate": True,
            }
        )
    store.put({"pk": pk, "sk": money.state_sk("youtube"), "state": "earning", "access_token": "nope"})
    status, body = call("GET", "/v1/money/summary", query={"platforms": "youtube", "chart": "7"})
    assert status == 200
    usd = body["currencies"][0]
    assert usd["monthly"]["amountMicros"] == 37_500_000
    assert usd["monthly"]["direction"] == "same"
    assert usd["yearly"]["paceMicros"] == 450_000_000
    assert len(usd["chart"]["points"]) == 7
    text = json.dumps(body)
    for key in ("breakdown", "previousMicros", "access_token", "paging", "TOKEN"):
        assert key not in text


def test_facebook_money_never_counts_before_its_live_check(call: Call, store: db.Store, clock: Any) -> None:
    clock.now = NOW
    setup.put_account(store, USER, "facebook", "connected", now=NOW, fields={"accountId": "P1", "scopes": []})
    pk = db.user_pk(USER)
    store.put(
        {
            "pk": pk,
            "sk": money.revenue_sk("facebook", "2026-11-16"),
            "platform": "facebook",
            "date": "2026-11-16",
            "amountMicros": 9,
            "currency": "EUR",
        }
    )
    body = call("GET", "/v1/money/summary", query={"platforms": "facebook"})[1]
    assert body["currencies"] == []
    assert body["excluded"][0]["reason"] == "coming_soon"


# --- review fixes -----------------------------------------------------------------------------------------------


def test_daily_and_pace_use_the_days_history_covers() -> None:
    """10 days of $1.00: a normal day is $1.00 (not $0.33) and the pace is $360 a year (not $120)."""
    usd = run(days("youtube", "2026-11-16", [1_000_000] * 10), platforms=["youtube"])["currencies"][0]
    assert usd["coveredDays"] == 10
    assert usd["monthly"]["amountMicros"] == 10_000_000
    assert usd["daily"]["averageMicros"] == 1_000_000
    assert usd["yearly"]["paceMicros"] == 360_000_000
    full = run(days("youtube", "2026-11-16", [1_000_000] * 45), platforms=["youtube"])["currencies"][0]
    assert full["coveredDays"] == 30
    assert full["daily"]["averageMicros"] == 1_000_000
    assert full["yearly"]["paceMicros"] == 30_000_000 * 12  # monthly x 12 once 30 days are covered


def test_an_app_that_falls_behind_is_left_out_and_named() -> None:
    """Facebook stuck on 27 Oct (no error) must not pull YouTube's days back, nor make the banner blame YouTube."""
    rows = days("youtube", "2026-11-16", [1_000_000] * 60) + days("facebook", "2026-10-27", [100_000] * 60)
    out = run(rows, platforms=["youtube", "facebook"])
    assert out["through"] == "2026-11-16"
    assert out["included"] == ["youtube"]
    assert out["behind"] == ["facebook"]
    assert out["stale"] is False
    assert out["errors"] == []
    assert out["excluded"] == [
        {
            "platform": "facebook",
            "reason": "behind",
            "text": "Facebook hasn't sent money since Tue 27 Oct. Not counted for now.",
        }
    ]
    assert out["currencies"][0]["monthly"]["amountMicros"] == 30_000_000


def test_every_app_behind_keeps_them_and_is_stale() -> None:
    rows = days("youtube", "2026-11-10", [1_000_000] * 60) + days("facebook", "2026-11-09", [100_000] * 60)
    out = run(rows, platforms=["youtube", "facebook"])
    assert out["included"] == ["youtube", "facebook"]
    assert out["behind"] == ["youtube", "facebook"]
    assert out["through"] == "2026-11-09"
    assert out["stale"] is True


def test_a_failed_check_with_no_rows_is_an_error_not_no_money() -> None:
    out = run([], platforms=["youtube"], status={"youtube": {**OK, "lastError": "YouTube didn't answer."}})
    assert out["excluded"] == [{"platform": "youtube", "reason": "error", "text": "Couldn't check YouTube today."}]
    assert out["errors"] == [{"platform": "youtube", "text": "Couldn't check YouTube today."}]


def test_a_negative_previous_period_still_reads_up() -> None:
    prev = [0] * 29 + [-10]
    cur = [0] * 29 + [5]
    usd = run(days("youtube", "2026-11-16", prev + cur), platforms=["youtube"])["currencies"][0]
    assert (usd["monthly"]["changePct"], usd["monthly"]["direction"]) == (150, "up")


def test_the_year_charts_first_week_can_be_a_single_day() -> None:
    usd = run(days("youtube", "2026-11-16", [1_000] * 400), platforms=["youtube"], chart=365)["currencies"][0]
    first = usd["chart"]["points"][0]
    assert first["start"] == first["end"] == "2025-11-17"
    assert first["partial"] is True
    assert first["amountMicros"] == 1_000


def test_latest_day_with_no_row_in_that_currency_is_zero() -> None:
    rows = days("youtube", "2026-11-16", [1_000_000] * 40) + days("facebook", "2026-11-15", [200_000] * 40, "EUR")
    rows = [r for r in rows if not (r["platform"] == "facebook" and r["date"] == "2026-11-15")]
    rows += [{"platform": "facebook", "date": "2026-11-16", "amountMicros": 0, "currency": "USD"}]
    out = run(rows, platforms=["youtube", "facebook"])
    eur = next(c for c in out["currencies"] if c["currency"] == "EUR")
    assert eur["daily"]["latest"] == {"date": "2026-11-16", "amountMicros": 0}
