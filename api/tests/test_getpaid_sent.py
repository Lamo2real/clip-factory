"""Get paid: money sent toward his bank, per place and in total (docs/CONTRACTS.md §40.4, tests §40.8 "api (K)").

``getpaid_sent_cases.json`` (written by ``getpaid_cases.py``): the amount parser's golden texts, each place's line,
the block and the payout rows. Nothing is ever converted, guessed or added across money types, and a place with no
report is never $0.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api.clock import parse
from clipfactory_api.getpaid import sent
from getpaid_cases import SENT_FILE, build_sent, google, line_run, whop

GOLDEN = json.loads(SENT_FILE.read_text())
LINES = {c["name"]: c for c in GOLDEN["lines"]}
TOTALS = {c["name"]: c["expect"] for c in GOLDEN["totals"]}
NOW = parse("2026-11-21T12:00:00.000Z")


def test_the_golden_file_is_current() -> None:
    assert build_sent() == GOLDEN, "run: uv run python tests/getpaid_cases.py"


@pytest.mark.parametrize("c", GOLDEN["amounts"], ids=[c["text"] or "empty" for c in GOLDEN["amounts"]])
def test_each_amount(c: dict[str, Any]) -> None:
    assert sent.parse_amount(c["text"]) == (c["micros"], c["currency"])


@pytest.mark.parametrize(
    ("text", "micros", "currency"),
    [
        ("kr 1 234,56 SEK", 1_234_560_000, "SEK"),
        ("SEK 1,234.56", 1_234_560_000, "SEK"),
        ("1 234,56 kr", 1_234_560_000, None),  # "kr" alone could be SEK, NOK or DKK: never guessed
        ("$1,234.57", 1_234_570_000, None),  # "$" alone could be USD, CAD or AUD
        ("€87.65", 87_650_000, "EUR"),
        ("£87.65", 87_650_000, "GBP"),
        ("¥1,235 JPY", 1_235_000_000, "JPY"),  # one kind of mark with 3 digits after it groups thousands
        ("1.234,56 €", 1_234_560_000, "EUR"),  # both marks: the last one is the decimal mark
        ("1,5 EUR", 1_500_000, "EUR"),
        ("1.234.56 EUR", None, "EUR"),  # can't tell
        ("€5 USD", 5_000_000, None),  # a symbol and a code that disagree
        (None, None, None),
    ],
)
def test_the_contracts_golden_texts(text: Any, micros: int | None, currency: str | None) -> None:
    assert sent.parse_amount(text) == (micros, currency)


@pytest.mark.parametrize("c", GOLDEN["lines"], ids=[c["name"] for c in GOLDEN["lines"]])
def test_each_line(c: dict[str, Any]) -> None:
    assert line_run(c) == c["expect"]


@pytest.mark.parametrize("c", GOLDEN["lines"], ids=[c["name"] for c in GOLDEN["lines"]])
def test_never_zero_never_reached(c: dict[str, Any]) -> None:
    line = c["expect"]
    if line["state"] != "number":
        assert line["amounts"] == []
    for a in line["amounts"]:
        assert isinstance(a["amountMicros"], int)
        assert len(a["currency"]) == 3
    words = json.dumps(line)
    for word in ("Reached your bank", "received", "in your bank", "traceCode", "UETR", "pub-"):
        assert word not in words


def test_unread_amounts_are_never_summed() -> None:
    only = LINES["youtube: only unread amounts: a number line with nothing added up"]["expect"]
    assert (only["state"], only["amounts"]) == ("number", [])
    assert only["notAdded"] == (
        "Google sent 3 payments. Clip Factory couldn't tell their money type, so they aren't added up."
    )
    assert only["button"] == {"label": "See them", "href": "/settings/posting/getpaid/youtube", "external": False}
    block = TOTALS["only unread amounts: not added, never Nothing sent yet"]
    assert block["totals"] == []
    assert "empty" not in block
    assert block["notAdded"] == only["notAdded"]
    some = LINES["youtube: one unread amount is never summed"]["expect"]
    assert some["amounts"] == [{"currency": "SEK", "amountMicros": 1_234_560_000}]
    assert some["notAdded"] == "1 payment isn't added up: Clip Factory couldn't tell its money type."


def test_totals_per_money_type_in_the_places_order() -> None:
    block = TOTALS["kronor and dollars are never added together, in the places' order"]
    assert [(t["currency"], t["places"], t["names"]) for t in block["totals"]] == [
        ("SEK", ["youtube", "contentrewards"], "YouTube and Whop (all your Whop money, Content Rewards too)"),
        ("USD", ["contentrewards"], "Whop (all your Whop money, Content Rewards too)"),
    ]
    assert block["totals"][0]["amountMicros"] == 2_468_000_000 + 412_000_000
    assert block["tag"] == "Google and Whop say they sent it."
    assert block["bankText"] == "Clip Factory can't see your bank. Look in your bank's app to see what arrived."
    nothing = TOTALS["nothing sent at all"]
    assert (nothing["totals"], nothing["empty"]) == ([], "Nothing sent to your bank yet.")


def test_whops_statuses_and_amounts() -> None:
    line = LINES["contentrewards: Whop's statuses: completed counts, on its way and came back don't"]["expect"]
    assert line["amounts"] == [
        {"currency": "SEK", "amountMicros": 412_000_000},
        {"currency": "USD", "amountMicros": 40_000_000},
    ]
    assert line["note"] == "Whop counts all your Whop money, not only Content Rewards."
    assert sent.whop_state({"status": "reversed"}) == "came_back"  # it stops counting
    assert sent.whop_state({"status": "canceled"}) == "didnt_go_through"
    assert sent.whop_state({"status": "in_review"}) == "on_its_way"
    by = {c["name"]: (c["micros"], c["currency"]) for c in GOLDEN["whopAmounts"]}
    assert by["what reached the bank wins"] == (412_500_000, "SEK")  # destination_amount over net_amount
    assert by["no destination: the net amount"] == (39_700_000, "USD")
    assert by["nothing to read"] == (None, None)


def test_gone_rows_and_two_accounts_on_one_day() -> None:
    gone = LINES["youtube: Google's payments in kronor, a gone one stops counting"]["expect"]
    assert gone["amounts"] == [{"currency": "SEK", "amountMicros": 2_468_000_000}]
    two = LINES["youtube: two AdSense accounts paid on the same day stay two payments"]["expect"]
    assert two["amounts"] == [{"currency": "EUR", "amountMicros": 100_000_000}]
    rows = sent.payout_rows(
        "youtube", LINES["youtube: two AdSense accounts paid on the same day stay two payments"]["rows"]
    )
    assert len(rows) == 2


def test_the_not_available_lines_word_for_word() -> None:
    def line(place: str) -> dict[str, Any]:
        return LINES[f"{place}: not available, never $0"]["expect"]  # type: ignore[no-any-return]

    assert line("tiktok")["where"]["text"] == (
        "Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal."
    )
    assert line("instagram")["where"]["text"] == (
        "Look in Instagram: Professional dashboard, then Payouts. Meta also emails you each month."
    )
    assert line("facebook")["headline"] == "Not available from Meta"
    assert line("x")["where"]["button"] == {"label": "Open Stripe", "url": "https://connect.stripe.com/express_login"}
    off = LINES["contentrewards: Connect Whop off"]["expect"]
    assert off["headline"] == "Sent to your bank: not available from Content Rewards"
    assert off["where"] == {"text": "Look on Whop: **Balances**."}
    assert "button" not in off
    on = LINES["contentrewards: Connect Whop on, not connected"]["expect"]
    assert on["button"]["href"] == "/settings/posting/getpaid/contentrewards#whop"


def test_payout_rows_never_carry_a_trace_code_and_stop_at_36() -> None:
    rows = [whop(f"2026-{m:02d}-{d:02d}", f"po_{m}_{d}", "completed", 1_000_000) for m in (1, 2) for d in range(1, 26)]
    out = sent.payout_rows("contentrewards", rows)
    assert len(out) == 36
    assert out[0]["date"] == "2026-02-25"  # newest first
    assert "traceCode" not in json.dumps(out)
    assert "UETR" not in json.dumps(out)
    yt = sent.payout_rows("youtube", [google("2026-10-23", "$5.00")])
    assert yt == [
        {"date": "2026-10-23", "by": "Google", "state": "sent", "amountMicros": None, "currency": None, "text": "$5.00"}
    ]


def test_the_arrive_lines() -> None:
    line = sent.sent_line(
        "contentrewards",
        [whop("2026-11-10", "po_1", "completed", 40_000_000, estimatedArrival="2026-11-14T00:00:00.000Z")],
        {"status": "connected"},
        {"firstReadDone": True},
        whop_on=True,
        now=NOW,
    )
    assert line["arrive"] == "Whop says it should arrive by Sat 14 Nov."
    yt = sent.sent_line("youtube", [google("2026-10-23", "€1.00")], {"status": "connected"}, {}, now=NOW)
    assert yt["arrive"] == "Your bank gets it up to 7 workdays after Google sends it."


def test_nothing_sent_yet_only_from_a_fresh_read_of_this_connection() -> None:
    """§40.2: "Nothing sent to your bank yet · YouTube says" only from a fresh PAYSTATE# read since this connection."""
    allowed_again = LINES["youtube: allowed again after Stop: the old read is not this connection's, so it is checking"]
    assert allowed_again["expect"]["state"] == "checking"
    failing = LINES["youtube: reads failing for 10 days never say nothing sent yet"]["expect"]
    assert failing == {
        "state": "error",
        "headline": "Clip Factory couldn't check YouTube payments lately",
        "amounts": [],
        "why": "Clip Factory last checked YouTube payments on 11 Nov.",
    }
    whop_again = LINES["contentrewards: Whop connected again: the old read is not this connection's, so it is checking"]
    assert whop_again["expect"]["state"] == "checking"
    whop_failing = LINES["contentrewards: Whop reads failing for 10 days never say nothing sent yet"]["expect"]
    assert (whop_failing["state"], whop_failing["why"]) == ("error", "Clip Factory last checked Whop on 11 Nov.")
    for c in GOLDEN["lines"]:
        if c["expect"]["state"] == "none_yet":
            assert sent.fresh(c["conn"], c["state"], parse(c["now"])), c["name"]


def test_read_since_connect() -> None:
    conn = {"status": "connected", "connectedAt": "2026-11-21T11:00:00.000Z"}
    assert not sent.read_since_connect(conn, {"firstReadDone": True, "lastCheckedAt": "2026-11-21T10:59:59.000Z"})
    assert sent.read_since_connect(conn, {"firstReadDone": True, "lastCheckedAt": "2026-11-21T11:00:00.000Z"})
    assert not sent.read_since_connect(conn, {"lastCheckedAt": "2026-11-21T11:30:00.000Z"})  # the first read isn't done
    assert not sent.read_since_connect(conn, {"firstReadDone": True})
    stopped = {"status": "not_connected", "stoppedAt": "2026-11-21T11:00:00.000Z"}  # Stop removed connectedAt
    assert sent.read_since_connect(stopped, {"firstReadDone": True, "lastCheckedAt": "2026-11-20T06:00:00.000Z"})
    assert not sent.fresh(stopped, {"firstReadDone": True, "lastCheckedAt": "2026-11-21T06:00:00.000Z"}, NOW)
    assert not sent.fresh(conn, {"firstReadDone": True, "lastCheckedAt": "2026-11-21T11:30:00.000Z"}, None)


def test_the_block_tag_names_only_who_sent_something() -> None:
    assert TOTALS["nothing sent at all"]["tag"] == ""
    assert TOTALS["nothing sent, Whop on: the tag names no one"]["tag"] == ""
    assert TOTALS["only unread amounts: not added, never Nothing sent yet"]["tag"] == "Google says it sent it."
    assert TOTALS["kronor and dollars are never added together, in the places' order"]["tag"] == (
        "Google and Whop say they sent it."
    )


def test_the_not_added_count_never_comes_from_the_words() -> None:
    """The block reads ``_unread``, so a copy change to the line's sentence can't change its count; ``public`` takes
    ``_unread`` off before a line leaves."""
    line = sent.sent_line("youtube", [google("2026-10-23", "$1,234.57"), google("2026-09-22", "$5")], {}, {})
    assert line["_unread"] == 2
    reworded = {**line, "notAdded": "Some payments have no money type."}
    assert sent.sent_totals({"youtube": reworded})["notAdded"] == (
        "Google sent 2 payments. Clip Factory couldn't tell their money type, so they aren't added up."
    )
    assert "_unread" not in sent.public(line)
    assert all(not k.startswith("_") for c in GOLDEN["lines"] for k in c["expect"])
