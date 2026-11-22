"""Your bank: matching a read's candidates to the apps (docs/CONTRACTS.md §40.5.8, §40.5.13 "bank_match_cases.json").

The golden file is written by ``bankread_cases.py`` from the code; every case is read by hand in review, and the key
ones are asserted by hand below as well. The rule under test everywhere: an amount is only ever compared with the same
currency's (a payout record, or Clip Factory's own test ceiling), never converted, added or estimated, and he is only
ever asked with a tap.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from bankread_cases import CASES, MATCH_FILE, YT, build_cases, run_case
from clipfactory_api.bankread import match as m

GOLDEN = json.loads(MATCH_FILE.read_text())
BY_NAME = {c["name"]: c for c in CASES}


def decisions(name: str) -> dict[str, dict[str, Any]]:
    return {d["label"]: d for d in run_case(BY_NAME[name])["decisions"]}


def test_the_golden_file_is_up_to_date() -> None:
    assert build_cases() == GOLDEN, "run: uv run python tests/bankread_cases.py"


@pytest.mark.parametrize("case", GOLDEN, ids=[c["name"] for c in GOLDEN])
def test_each_golden_case(case: dict[str, Any]) -> None:
    assert run_case(case) == case["expected"]


def test_a_youtube_payout_matches_within_10_workdays_only() -> None:
    hit = decisions("youtube_payout_within_10_workdays")["google"]
    assert hit == {
        "label": "google",
        "state": "matched",
        "rule": "payout",
        "place": "youtube",
        "how": "payout",
        "payoutRef": YT,
        "payoutDate": "2026-10-21",
    }
    late = decisions("youtube_payout_on_workday_11_is_asked")["google"]
    assert (late["state"], late["suggested"], late["kind"]) == ("needs_you", "youtube", "place")


def test_workdays_skip_weekends() -> None:
    assert m.add_workdays("2026-10-21", 10) == "2026-11-04"  # a Wednesday, two weekends later
    assert m.add_workdays("2026-10-24", 1) == "2026-10-26"  # Saturday → Monday
    assert m.within("2026-10-21", "2026-10-21", 10)
    assert not m.within("2026-10-20", "2026-10-21", 10)  # never before the payout


def test_googles_tiny_test_payment_is_dropped_and_a_real_one_asked() -> None:
    assert decisions("google_test_deposit_dropped")["test"]["rule"] == "test_deposit"
    assert decisions("google_85_without_a_record_is_asked")["google85"]["state"] == "needs_you"
    assert m.TEST_CEILINGS["SEK"] == 20_000_000
    assert m.TEST_CEILINGS["DKK"] == 15_000_000
    assert m.TEST_CEILINGS["EUR"] == m.TEST_CEILINGS["USD"] == m.TEST_CEILINGS["GBP"] == m.TEST_CEILINGS["CHF"]
    assert "JPY" not in m.TEST_CEILINGS  # other currencies have none, so they are asked about


def test_whop_money_the_bank_converted_is_asked_never_converted() -> None:
    on = decisions("whop_converted_by_the_bank_is_asked")["whop"]
    off = decisions("whop_converted_with_content_rewards_off_suggests_nothing")["whop"]
    assert (on["state"], on["suggested"]) == ("needs_you", "contentrewards")
    assert off["state"] == "needs_you"
    assert "suggested" not in off


def test_whops_trace_code_matches_at_any_amount_but_never_inside_a_longer_number() -> None:
    hit = decisions("whop_trace_code_matched_at_any_amount")["trace"]
    assert (hit["state"], hit["rule"], hit["place"], hit["how"]) == ("matched", "trace", "contentrewards", "payout")
    misses = decisions("short_code_inside_a_longer_number_not_matched")
    assert misses["short"]["state"] == misses["inside"]["state"] == "dropped"
    assert m.trace_code("AB12CD") is None
    assert m.trace_code("4F7Q-92KX-11ZP") == "4F7Q 92KX 11ZP"


def test_a_learned_payer_matches_but_shared_and_text_only_hints_are_asked_every_time() -> None:
    meta = decisions("learned_meta_payer_matched")["meta"]
    assert (meta["state"], meta["place"], meta["how"]) == ("matched", "meta", "payer")
    stripe = decisions("stripe_asked_every_time_suggesting_x")["stripe"]
    assert (stripe["state"], stripe["suggested"]) == ("needs_you", "x")
    stranger = decisions("youtube_only_in_a_strangers_message")["stranger"]
    assert (stranger["state"], stranger["suggested"]) == ("needs_you", "youtube")


def test_paypal_money_with_a_paypal_link_is_asked_as_a_move() -> None:
    moved = decisions("paypal_with_a_paypal_link_is_an_own_move")["paypal"]
    assert (moved["state"], moved["kind"]) == ("needs_you", "own_move")
    asked = decisions("paypal_without_a_paypal_link_is_asked")["paypal"]
    assert (asked["kind"], asked.get("suggested")) == ("place", None)


def test_debits_pending_negative_and_salary_never_go_on() -> None:
    out = run_case(BY_NAME["debit_pending_negative_and_salary_dropped"])
    assert set(out["filteredOut"]) == {"rent", "pending", "negative", "after_tomorrow"}
    assert out["decisions"] == [{"label": "salary", "state": "dropped", "rule": "no_hint"}]


def test_one_payout_pairs_with_one_deposit() -> None:
    hint = decisions("one_payout_two_candidates_the_hint_wins")
    assert hint["google"]["state"] == "matched"
    assert hint["stranger"]["state"] == "dropped"
    by_date = decisions("one_payout_two_candidates_then_the_first_by_date")
    assert by_date["earlier"]["state"] == "matched"
    assert by_date["later"]["state"] == "dropped"


def test_not_payout_and_not_income_and_the_payout_rules_first() -> None:
    assert run_case(BY_NAME["not_payout_respected"])["rematches"] == []
    assert decisions("not_income_payer_dropped")["refund"]["rule"] == "not_income"
    google = decisions("not_income_google_payer_with_a_matching_payout_matched")["google"]
    assert (google["state"], google["place"]) == ("matched", "youtube")


def test_fund_codes_and_too_many_decimals_are_dropped() -> None:
    assert set(run_case(BY_NAME["fund_code_and_too_many_decimals_dropped"])["filteredOut"]) == {"xxx", "decimals"}


def test_a_stored_question_matches_once_its_payout_or_payer_is_known() -> None:
    payout = run_case(BY_NAME["stored_question_matched_once_its_payout_appears"])["rematches"]
    assert payout == [
        {
            "label": "earlier",
            "place": "youtube",
            "how": "payout",
            "payoutRef": "PAYOUT#youtube#2026-11-02#3456",
            "payoutDate": "2026-11-02",
        }
    ]
    payer = run_case(BY_NAME["stored_question_matched_by_a_payer_he_confirmed"])["rematches"]
    assert payer == [{"label": "meta", "place": "meta", "how": "payer"}]


def test_kept_rows_are_nothing_new_and_the_same_row_in_two_accounts_counts_once() -> None:
    assert decisions("kept_already_is_nothing")["google"]["state"] == "kept"
    twice = run_case(BY_NAME["the_same_row_in_two_accounts_counts_once"])["decisions"]
    assert [d["label"] for d in twice] == ["a1"]


def test_every_hint_suggests_its_place() -> None:
    assert m.SUGGEST == {
        "youtube": "youtube",
        "instagram": "instagram",
        "facebook": "facebook",
        "meta": "meta",
        "tiktok": "tiktok",
        "x": "x",
        "stripe": "x",
        "whop": "contentrewards",
        "paypal": None,
        "payoneer": None,
    }


def test_an_unread_payout_never_matches_by_amount() -> None:
    from clipfactory_api.bankread.filter import Candidate

    c = Candidate("d1", "2026-10-22", 123456, 2, "SEK", "youtube", "payer", False, "pk", "", "link1")
    unread = m.Payout(YT, "youtube", "2026-10-21", None, None)
    other_money = m.Payout(YT, "youtube", "2026-10-21", 1_234_560_000, "EUR")
    for payout in (unread, other_money):
        out, _ = m.match([c], m.Context(payouts=[payout]))
        assert out[0].state == "needs_you"
