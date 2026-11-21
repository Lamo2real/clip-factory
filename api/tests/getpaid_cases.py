"""The shared golden cases of Get paid (docs/CONTRACTS.md §40.2, §40.4, §40.7, §40.8 "Tests").

* ``fixtures/getpaid_status_cases.json``: one place's stored facts (``inputs``) and the ``GetPaidCard`` the server
  makes of them (``getpaid.status.card``): every place and every status, both kinds of "not set up", the order, every
  ``HOLD_FIX`` row, freshness, the autos and the summary sentences.
* ``fixtures/getpaid_sent_cases.json``: Google's formatted amounts and what ``parse_amount`` reads; each place's
  "Sent to your bank" line (``sent_line``), the "Sent to your bank, so far" block (``sent_totals``) and the place
  page's payout rows.
* ``fixtures/getpaid_steps.json``: the step ids and roles of the five platform guides, in the guide's order (the
  web's guides, ``web/src/getpaid/*.ts``, are checked against it when it is there).
* ``fixtures/getpaid_items.json``: the items of §40.7 (sort key, who writes them, their attributes and one example);
  ``cf-prod-money``'s writers are checked against it when it is there.

Run ``uv run python tests/getpaid_cases.py`` (from ``api/``) to write the files again after a deliberate change: the
expected answers come from the code, and every case is read by hand in review (the key ones also have their own
hand-written asserts in ``test_getpaid_status.py`` and ``test_getpaid_sent.py``).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from clipfactory_api.clock import parse
from clipfactory_api.getpaid import CR, sent, status
from clipfactory_api.getpaid.view import _goals
from clipfactory_api.money import rules

FIXTURES = Path(__file__).parent / "fixtures"
STATUS_FILE = FIXTURES / "getpaid_status_cases.json"
SENT_FILE = FIXTURES / "getpaid_sent_cases.json"
STEPS_FILE = FIXTURES / "getpaid_steps.json"
ITEMS_FILE = FIXTURES / "getpaid_items.json"

NOW = "2026-11-21T12:00:00.000Z"
CHECKED = "2026-11-21T06:00:00.000Z"
PUB = "accounts/pub-1234567890123456"

# --- stored items, as §40.7 shapes them ---------------------------------------------------------------------------

ADSENSE = {
    "type": "payconn",
    "source": "adsense",
    "status": "connected",
    "connectedAt": "2026-11-01T09:00:00.000Z",
    "accounts": [{"name": PUB, "displayName": "Main"}],
    "scopes": ["https://www.googleapis.com/auth/adsense.readonly"],
    "lastResult": "payments_allowed",
}
WHOP_CONN = {
    "type": "payconn",
    "source": "whop",
    "status": "connected",
    "connectedAt": "2026-11-01T09:00:00.000Z",
    "accountId": "user_abc123",
    "accountName": "@owner",
    "keyHint": "app_Ab…wxyz",
    "tokenVersionId": "v3",
}


def account(state: str = "READY", **fields: Any) -> dict[str, Any]:
    return {"name": PUB, "displayName": "Main", "state": state, "pendingTasks": [], **fields}


def yt_state(**fields: Any) -> dict[str, Any]:
    return {
        "type": "paystate",
        "place": "youtube",
        "source": "adsense",
        "accounts": [account()],
        "holds": [],
        "alerts": [],
        "unpaid": {"text": "SEK 512.30"},
        "firstReadDone": True,
        "lastCheckedAt": CHECKED,
        **fields,
    }


def whop_state(**fields: Any) -> dict[str, Any]:
    return {
        "type": "paystate",
        "place": "contentrewards",
        "source": "whop",
        "kyc": "approved",
        "methods": {"created": 1, "active": 0, "broken": 0, "ready": 1, "currencies": ["SEK"]},
        "businesses": False,
        "firstReadDone": True,
        "lastCheckedAt": CHECKED,
        **fields,
    }


def google(day: str, text: str, last4: str = "3456", **fields: Any) -> dict[str, Any]:
    return {
        "sk": f"PAYOUT#youtube#{day}#{last4}",
        "type": "payout",
        "place": "youtube",
        "by": "google",
        "source": "adsense.payments",
        "account": last4,
        "date": day,
        "amountText": text,
        "state": "sent",
        "fetchedAt": CHECKED,
        **fields,
    }


def whop(day: str, payout_id: str, whop_status: str, micros: int, currency: str = "USD", **fields: Any) -> dict:
    return {
        "sk": f"PAYOUT#contentrewards#{day}#{payout_id}",
        "type": "payout",
        "place": "contentrewards",
        "by": "whop",
        "source": "whop.payouts",
        "payoutId": payout_id,
        "status": whop_status,
        "state": sent.WHOP_STATES.get(whop_status, "on_its_way"),
        "date": day,
        "amountMicros": micros,
        "currency": currency,
        "traceCode": "UETR-secret-trace",
        "fetchedAt": CHECKED,
        **fields,
    }


YT_PAYOUT_STEPS = ["yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin"]
YT_ALL = ["yt-join", *YT_PAYOUT_STEPS]
CFG = rules.load()


def money_state(platform: str, state: str, **numbers: Any) -> dict[str, Any]:
    return {"state": state, "numbers": numbers}


def goals(platform: str, state: dict[str, Any], country: str | None = "SE") -> list[dict[str, Any]]:
    now = parse(NOW)
    assert now is not None
    return _goals(CFG, platform, state, now, country)


def inputs(place: str, **kw: Any) -> dict[str, Any]:
    """One place's inputs, as ``getpaid.view.inputs`` makes them from stored items."""
    state = kw.pop("moneyState", {})
    out: dict[str, Any] = {
        "connected": kw.pop("connected", True),
        "ticks": kw.pop("ticks", []),
        "moneyState": state,
        "country": kw.get("country", "SE"),
        "countryName": kw.pop("countryName", "Sweden"),
    }
    out["country"] = kw.pop("country", "SE")
    if place in {"youtube", "instagram", "x"}:
        out["goals"] = goals(place, state, out["country"])
    if place == "tiktok":
        out["notOpen"] = kw.pop("notOpen", False)
    if place == "youtube":
        out["payconn"] = kw.pop("payconn", {})
        out["paystate"] = kw.pop("paystate", {})
        out["payouts"] = kw.pop("payouts", [])
    if place == CR:
        out.pop("countryName")
        out.update(
            finance=kw.pop("finance", False),
            crMoney=kw.pop("crMoney", {}),
            whopOn=kw.pop("whopOn", True),
            payconn=kw.pop("payconn", {}),
            paystate=kw.pop("paystate", {}),
            payouts=kw.pop("payouts", []),
        )
        out.pop("moneyState")
    assert not kw, kw
    return out


def card_case(name: str, place: str, now: str = NOW, **kw: Any) -> dict[str, Any]:
    return {"name": name, "place": place, "now": now, "inputs": inputs(place, **kw)}


def run(c: dict[str, Any]) -> dict[str, Any]:
    moment = parse(c["now"])
    assert moment is not None
    return status.card(c["place"], c["inputs"], moment)


IN = money_state("youtube", "in_program", subscribers=1450)
NOT_YET = money_state("youtube", "not_yet", subscribers=812, watchHours365=100, shortsViews90=2_000_000)
NOT_YET_REACHED = money_state("youtube", "not_yet", subscribers=1200, watchHours365=100, shortsViews90=11_000_000)
MONEY = {"paidTotalCents": 6240, "readyToMoveCents": 1825, "stillEarningCents": 420, "onItsWayCents": 0}


def _youtube_cases() -> list[dict[str, Any]]:
    sent_rows = [google("2026-10-23", "kr 1 234,56 SEK"), google("2026-09-22", "kr 1 233,44 SEK")]
    return [
        card_case("youtube: nothing at all is Clip Factory can't check", "youtube", connected=False),
        card_case("youtube: connected, nothing ticked is not started", "youtube"),
        card_case(
            "youtube: only payout steps ticked: you said YouTube knows where to pay you",
            "youtube",
            ticks=["yt-tax", "yt-bank"],
        ),
        card_case(
            "youtube: not in the Partner Program (YouTube says) beats his ticks, a goal not reached",
            "youtube",
            moneyState=NOT_YET,
            ticks=YT_ALL,
        ),
        card_case(
            "youtube: every goal reached says apply in YouTube Studio, next yt-join",
            "youtube",
            moneyState=NOT_YET_REACHED,
        ),
        card_case(
            "youtube: in the program, no payout tick and no payment reading is Not set up yet, never red",
            "youtube",
            moneyState=IN,
        ),
        card_case(
            "youtube: in the program with every payout step ticked is you said it's done",
            "youtube",
            moneyState=IN,
            ticks=YT_PAYOUT_STEPS,
        ),
        card_case(
            "youtube: just allowed payment reading with every step ticked is checking, never no hold",
            "youtube",
            moneyState=IN,
            ticks=YT_ALL,
            payconn={**ADSENSE, "connectedAt": "2026-11-21T09:00:00.000Z"},
        ),
        card_case(
            "youtube: checking ends after 26 hours: the status comes from his ticks",
            "youtube",
            moneyState=IN,
            ticks=YT_ALL,
            payconn={**ADSENSE, "connectedAt": "2026-11-19T09:00:00.000Z"},
        ),
        card_case(
            "youtube: checking ends on a lastError",
            "youtube",
            moneyState=IN,
            ticks=["yt-tax"],
            payconn={**ADSENSE, "connectedAt": "2026-11-21T09:00:00.000Z"},
            paystate={"type": "paystate", "lastError": "AdSense for YouTube didn't answer."},
        ),
        card_case(
            "youtube: a fresh hold beats everything, next the first payout step not done",
            "youtube",
            moneyState=IN,
            ticks=["yt-tax"],
            payconn=ADSENSE,
            paystate=yt_state(
                holds=[{"type": "payment-hold", "severity": "SEVERE", "text": "Your payments are on hold."}]
            ),
        ),
        card_case(
            "youtube: a fresh hold with no payout step left opens AdSense for YouTube",
            "youtube",
            moneyState=IN,
            ticks=YT_ALL,
            payconn=ADSENSE,
            paystate=yt_state(holds=[{"type": "payment-hold", "severity": "SEVERE", "text": ""}]),
        ),
        card_case(
            "youtube: NEEDS_ATTENTION is red Not set up (YouTube says)",
            "youtube",
            moneyState=IN,
            ticks=YT_ALL,
            payconn=ADSENSE,
            paystate=yt_state(accounts=[account("NEEDS_ATTENTION", pendingTasks=["PAYMENT_INFO"])]),
        ),
        card_case(
            "youtube: CLOSED is red Not set up (YouTube says), make a new one from Earn",
            "youtube",
            moneyState=IN,
            ticks=YT_ALL,
            payconn=ADSENSE,
            paystate=yt_state(accounts=[account("CLOSED")]),
        ),
        card_case(
            "youtube: fresh, ready, no hold and a sent payment is can get paid (YouTube says)",
            "youtube",
            moneyState=money_state("youtube", "earning"),
            payconn=ADSENSE,
            paystate=yt_state(),
            payouts=sent_rows,
        ),
        card_case(
            "youtube: a sent payment proves the Partner Program without money reading",
            "youtube",
            payconn=ADSENSE,
            paystate=yt_state(),
            payouts=sent_rows,
        ),
        card_case(
            "youtube: fresh with no payment yet and every step ticked: YouTube says there's no hold",
            "youtube",
            moneyState=IN,
            ticks=YT_PAYOUT_STEPS,
            payconn=ADSENSE,
            paystate=yt_state(unpaid={"text": "$45.10"}),
        ),
        card_case(
            "youtube: after Stop payment reading the sent payments still tick the payout steps",
            "youtube",
            moneyState=IN,
            payconn={"type": "payconn", "status": "not_connected", "stoppedAt": "2026-11-20T10:00:00.000Z"},
            paystate=yt_state(holds=[{"type": "payment-hold", "text": "Old hold"}]),
            payouts=sent_rows,
        ),
        card_case(
            "youtube: needs a reconnect: no hold from the state, the reconnect is next",
            "youtube",
            moneyState=IN,
            payconn={**ADSENSE, "status": "needs_reconnect", "reason": "token_dead"},
            paystate=yt_state(holds=[{"type": "payment-hold", "text": "Old hold"}]),
            payouts=sent_rows,
        ),
        card_case(
            "youtube: a read over 48 hours old is never used",
            "youtube",
            moneyState=IN,
            ticks=["yt-tax"],
            payconn=ADSENSE,
            paystate=yt_state(
                lastCheckedAt="2026-11-18T06:00:00.000Z",
                holds=[{"type": "payment-hold", "text": "Old hold"}],
            ),
        ),
        card_case(
            "youtube: the payment reading tick is never counted in the ring",
            "youtube",
            moneyState=IN,
            ticks=["yt-tax"],
            payconn=ADSENSE,
            paystate=yt_state(unpaid={"text": "kr 12,00"}),
        ),
    ]


def _platform_cases() -> list[dict[str, Any]]:
    ig_few = money_state("instagram", "not_available", followers=312)
    ig_many = money_state("instagram", "not_available", followers=640)
    x_few = money_state("x", "not_available", verifiedFollowers=120, impressions90=40_000)
    x_many = money_state("x", "not_available", verifiedFollowers=600)
    return [
        card_case(
            "tiktok: Sweden is not started with the Creator Rewards line, never not allowed",
            "tiktok",
            notOpen=True,
            moneyState=money_state("tiktok", "not_available", followers=2310),
        ),
        card_case(
            "tiktok: not open somewhere else says your country",
            "tiktok",
            notOpen=True,
            country="other",
            countryName="Somewhere else",
        ),
        card_case("tiktok: not connected and nothing ticked: Clip Factory can't check", "tiktok", connected=False),
        card_case("tiktok: Gifts on, payout not ticked is Not set up yet", "tiktok", ticks=["tt-gifts"]),
        card_case(
            "tiktok: Gifts on and payout ticked is you said it's done", "tiktok", ticks=["tt-gifts", "tt-payout"]
        ),
        card_case("instagram: 312 followers is not allowed yet (Instagram's rules)", "instagram", moneyState=ig_few),
        card_case(
            "instagram: a ticked Gifts step beats the follower rule",
            "instagram",
            moneyState=ig_few,
            ticks=["ig-gifts"],
        ),
        card_case(
            "instagram: one meta-payout tick alone is not started, never you said it's done",
            "instagram",
            moneyState=ig_many,
            ticks=["meta-payout"],
        ),
        card_case(
            "instagram: Gifts and the Meta payout ticked is you said it's done",
            "instagram",
            moneyState=ig_many,
            ticks=["ig-gifts", "meta-payout"],
        ),
        card_case(
            "facebook: one meta-payout tick alone is not started, never you said it's done",
            "facebook",
            moneyState=money_state("facebook", "unknown", followers=1040),
            ticks=["meta-payout"],
        ),
        card_case(
            "facebook: joined and the Meta payout ticked is you said it's done",
            "facebook",
            ticks=["fb-join", "meta-payout"],
        ),
        card_case("facebook: not connected, nothing ticked: Clip Factory can't check", "facebook", connected=False),
        card_case("x: 120 verified followers is not allowed yet (X's rules)", "x", moneyState=x_few),
        card_case(
            "x: Premium never says no; x-premium as next is never the vermilion",
            "x",
            moneyState={"state": "not_available", "numbers": {"verifiedFollowers": 600}},
        ),
        card_case(
            "x: X says you have Premium ticks x-premium; apply is next",
            "x",
            moneyState={"state": "not_available", "numbers": {"premium": True, "verifiedFollowers": 600}},
        ),
        card_case(
            "x: every step done is you said it's done",
            "x",
            moneyState=x_many,
            ticks=["x-premium", "x-apply", "x-stripe"],
        ),
        card_case(
            "x: earn steps done, Stripe not ticked is Not set up yet",
            "x",
            moneyState=x_many,
            ticks=["x-premium", "x-apply"],
        ),
    ]


def _cr_cases() -> list[dict[str, Any]]:
    fresh = whop_state()
    return [
        card_case(
            "contentrewards: not connected, nothing ticked: Clip Factory can't check",
            CR,
            connected=False,
            finance=None,
        ),
        card_case(
            "contentrewards: connected with no money and no Finance answer is not started",
            CR,
            finance=None,
        ),
        card_case(
            "contentrewards: money and no Finance answer is Not set up yet, next the Finance question",
            CR,
            finance=None,
            crMoney=MONEY,
        ),
        card_case("contentrewards: money with no bank step is Not set up yet", CR, crMoney=MONEY, ticks=["move-whop"]),
        card_case(
            "contentrewards: a move to Whop ticks Link your Whop account by itself",
            CR,
            crMoney={**MONEY, "onItsWayCents": 500},
        ),
        card_case(
            "contentrewards: you said every step is done",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
        ),
        card_case(
            "contentrewards: Finance yes and Set up payouts ticked is you said it's done",
            CR,
            finance=True,
            crMoney=MONEY,
            ticks=["fin-setup"],
        ),
        card_case(
            "contentrewards: a fresh Whop with no saved method beats his ticks",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=whop_state(methods={"created": 0, "active": 0, "broken": 0, "ready": 0, "currencies": []}),
        ),
        card_case(
            "contentrewards: Whop says the ID check isn't started",
            CR,
            finance=True,
            crMoney=MONEY,
            ticks=["fin-setup"],
            payconn=WHOP_CONN,
            paystate=whop_state(kyc="not_started"),
        ),
        card_case(
            "contentrewards: Whop is checking his ID",
            CR,
            crMoney=MONEY,
            ticks=["move-whop"],
            payconn=WHOP_CONN,
            paystate=whop_state(kyc="pending"),
        ),
        card_case(
            "contentrewards: Whop can get paid needs a ready method and Content Rewards linked to Whop",
            CR,
            crMoney=MONEY,
            ticks=["move-whop"],
            payconn=WHOP_CONN,
            paystate=fresh,
        ),
        card_case(
            "contentrewards: Whop ready but not linked is Not set up yet, next Link your Whop account",
            CR,
            crMoney=MONEY,
            payconn=WHOP_CONN,
            paystate=fresh,
        ),
        card_case(
            "contentrewards: a method still being checked is not ready",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=whop_state(methods={"created": 1, "active": 0, "broken": 0, "ready": 0, "currencies": ["SEK"]}),
        ),
        card_case(
            "contentrewards: Whop's ID check didn't pass is on hold",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=whop_state(kyc="rejected"),
        ),
        card_case(
            "contentrewards: every saved method broken is on hold",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=whop_state(methods={"created": 0, "active": 0, "broken": 2, "ready": 0, "currencies": ["SEK"]}),
        ),
        card_case(
            "contentrewards: the last payout didn't go through is on hold",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=fresh,
            payouts=[
                whop("2026-11-18", "po_2", "failed", 40_000_000),
                whop("2026-11-01", "po_1", "completed", 12_000_000),
            ],
        ),
        card_case(
            "contentrewards: a canceled payout is never a hold",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=fresh,
            payouts=[
                whop("2026-11-18", "po_2", "canceled", 40_000_000),
                whop("2026-11-01", "po_1", "completed", 12_000_000),
            ],
        ),
        card_case(
            "contentrewards: an old failed payout is no hold",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn=WHOP_CONN,
            paystate=fresh,
            payouts=[whop("2026-09-01", "po_0", "failed", 40_000_000)],
        ),
        card_case(
            "contentrewards: Whop switched off: no Whop signal at all",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            whopOn=False,
            payconn=WHOP_CONN,
            paystate=whop_state(kyc="rejected"),
        ),
        card_case(
            "contentrewards: Connect Whop just done is checking",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn={**WHOP_CONN, "connectedAt": "2026-11-21T11:00:00.000Z"},
        ),
        card_case(
            "contentrewards: Whop needs a reconnect is next when nothing else is",
            CR,
            crMoney=MONEY,
            ticks=["move-whop", "bank-setup"],
            payconn={**WHOP_CONN, "status": "needs_reconnect", "reason": "token_dead"},
            paystate=whop_state(kyc="rejected"),
        ),
        card_case(
            "contentrewards: an owned business is noted",
            CR,
            crMoney=MONEY,
            ticks=["move-whop"],
            payconn=WHOP_CONN,
            paystate=whop_state(businesses=True),
        ),
    ]


def _summary_cases() -> list[dict[str, Any]]:
    def c(place: str, state: str, known_by: str = "you") -> dict[str, Any]:
        return {"place": place, "name": status.name(place), "status": state, "knownBy": known_by}

    cases = [
        (
            "the contract's example",
            [
                c("youtube", "can_get_paid", "youtube"),
                c("tiktok", "you_said_done"),
                c("instagram", "not_set_up"),
                c("facebook", "not_started"),
                c("x", "not_allowed", "rules"),
            ],
        ),
        (
            "Whop says Content Rewards can pay you, and two places need him",
            [
                c("youtube", "on_hold", "youtube"),
                c("tiktok", "not_connected", "clipfactory"),
                c("instagram", "you_said_done"),
                c("facebook", "you_said_done"),
                c("x", "not_set_up"),
                c(CR, "can_get_paid", "whop"),
            ],
        ),
        (
            "Google paid you before",
            [
                c("youtube", "you_said_done", "youtube"),
                c("tiktok", "not_started"),
                c("instagram", "not_started"),
            ],
        ),
        ("nothing set up yet", [c("youtube", "not_connected", "clipfactory"), c("tiktok", "not_started")]),
        (
            "nothing to do here yet",
            [c("youtube", "checking", "clipfactory"), c("instagram", "not_allowed", "rules")],
        ),
    ]
    return [{"name": n, "cards": cards, "expect": status.summary(cards)} for n, cards in cases]


def build_status() -> dict[str, Any]:
    cards = [*_youtube_cases(), *_platform_cases(), *_cr_cases()]
    for c in cards:
        c["expect"] = run(c)
    return {"cards": cards, "summaries": _summary_cases()}


# --- sent ---------------------------------------------------------------------------------------------------------

AMOUNTS = [
    "kr 1 234,56 SEK",
    "SEK 1,234.56",
    "1 234,56 kr",
    "$1,234.57",
    "€87.65",
    "£87.65",
    "¥1,235 JPY",
    "1.234,56 €",
    "kr\u00a01\u202f234,56\u00a0SEK",  # no-break spaces
    "CHF 1'234.50",
    "₹1,00,000.50",
    "-$5.00 USD",
    "1.234.56 EUR",
    "12 SEK 34",
    "€5 USD",
    "",
]


def line_case(name: str, place: str, **kw: Any) -> dict[str, Any]:
    return {
        "name": name,
        "place": place,
        "now": kw.pop("now", NOW),
        "rows": kw.pop("rows", []),
        "conn": kw.pop("conn", {}),
        "state": kw.pop("state", {}),
        "whopOn": kw.pop("whopOn", False),
    }


def _line_cases() -> list[dict[str, Any]]:
    read = {"firstReadDone": True, "lastCheckedAt": CHECKED}
    return [
        *[line_case(f"{p}: not available, never $0", p) for p in ("tiktok", "instagram", "facebook", "x")],
        line_case("youtube: no payment reading", "youtube"),
        line_case(
            "youtube: Google's payments in kronor, a gone one stops counting",
            "youtube",
            rows=[
                google("2026-10-23", "kr 1 234,56 SEK"),
                google("2026-09-22", "kr 1 233,44 SEK"),
                google("2026-08-21", "kr 500,00 SEK", state="gone", goneAt="2026-11-01T06:00:00.000Z"),
            ],
            conn=ADSENSE,
            state=read,
        ),
        line_case(
            "youtube: two AdSense accounts paid on the same day stay two payments",
            "youtube",
            rows=[google("2026-10-23", "€87.65", "1111"), google("2026-10-23", "€12.35", "2222")],
            conn=ADSENSE,
            state=read,
        ),
        line_case(
            "youtube: only unread amounts: a number line with nothing added up",
            "youtube",
            rows=[google("2026-10-23", "$1,234.57"), google("2026-09-22", "1 234,56 kr"), google("2026-08-21", "$5")],
            conn=ADSENSE,
            state=read,
        ),
        line_case(
            "youtube: one unread amount is never summed",
            "youtube",
            rows=[google("2026-10-23", "kr 1 234,56 SEK"), google("2026-09-22", "$1,234.57")],
            conn=ADSENSE,
            state=read,
        ),
        line_case("youtube: reading on, nothing sent yet", "youtube", conn=ADSENSE, state=read),
        line_case(
            "youtube: reading just allowed is checking",
            "youtube",
            conn={**ADSENSE, "connectedAt": "2026-11-21T09:00:00.000Z"},
        ),
        line_case("youtube: the first read is late", "youtube", conn=ADSENSE),
        line_case(
            "youtube: reading needs a reconnect",
            "youtube",
            conn={**ADSENSE, "status": "needs_reconnect", "reason": "keys_changed"},
            state=read,
        ),
        line_case(
            "youtube: reading stopped, the payments stay",
            "youtube",
            rows=[google("2026-10-23", "kr 1 234,56 SEK")],
            conn={"status": "not_connected", "stoppedAt": "2026-11-20T10:00:00.000Z"},
            state=read,
        ),
        line_case("contentrewards: Connect Whop off", CR, conn=WHOP_CONN, state=read),
        line_case("contentrewards: Connect Whop on, not connected", CR, whopOn=True),
        line_case(
            "contentrewards: Whop's statuses: completed counts, on its way and came back don't",
            CR,
            rows=[
                whop("2026-11-18", "po_4", "processing", 12_000_000),
                whop("2026-11-10", "po_3", "completed", 40_000_000),
                whop("2026-11-02", "po_2", "completed", 412_000_000, "SEK", estimatedArrival="2026-11-06"),
                whop("2026-10-02", "po_1", "reversed", 9_000_000),
                whop("2026-09-02", "po_0", "denied", 7_000_000),
            ],
            conn=WHOP_CONN,
            state=read,
            whopOn=True,
        ),
        line_case("contentrewards: Whop connected, nothing sent yet", CR, conn=WHOP_CONN, state=read, whopOn=True),
        line_case(
            "contentrewards: Whop needs a reconnect",
            CR,
            conn={**WHOP_CONN, "status": "needs_reconnect"},
            state=read,
            whopOn=True,
        ),
    ]


def line_run(c: dict[str, Any]) -> dict[str, Any]:
    return sent.sent_line(c["place"], c["rows"], c["conn"], c["state"], whop_on=c["whopOn"], now=parse(c["now"]))


def build_sent() -> dict[str, Any]:
    amounts = []
    for text in AMOUNTS:
        micros, currency = sent.parse_amount(text)
        amounts.append({"text": text, "micros": micros, "currency": currency})
    lines = _line_cases()
    for c in lines:
        c["expect"] = line_run(c)
    by = {c["name"]: c["expect"] for c in lines}
    na = {p: by[f"{p}: not available, never $0"] for p in ("tiktok", "instagram", "facebook", "x")}
    totals_cases = [
        (
            "kronor and dollars are never added together, in the places' order",
            {
                "youtube": by["youtube: Google's payments in kronor, a gone one stops counting"],
                **na,
                CR: by["contentrewards: Whop's statuses: completed counts, on its way and came back don't"],
            },
        ),
        (
            "only unread amounts: not added, never Nothing sent yet",
            {"youtube": by["youtube: only unread amounts: a number line with nothing added up"], **na},
        ),
        (
            "some unread amounts",
            {
                "youtube": by["youtube: one unread amount is never summed"],
                **na,
                CR: by["contentrewards: Connect Whop off"],
            },
        ),
        ("nothing sent at all", {"youtube": by["youtube: no payment reading"], **na}),
    ]
    totals = [{"name": n, "lines": ls, "expect": sent.sent_totals(ls)} for n, ls in totals_cases]
    rows = [
        {"name": n, "place": c["place"], "rows": c["rows"], "expect": sent.payout_rows(c["place"], c["rows"])}
        for n, c in (
            ("Google's payments, newest first", next(x for x in lines if x["name"].startswith("youtube: Google's"))),
            ("Google's own words when the money type is unread", next(x for x in lines if "one unread" in x["name"])),
            ("Whop's payouts with their states", next(x for x in lines if "Whop's statuses" in x["name"])),
        )
    ]
    whop_amounts = []
    for name, payout in (
        (
            "what reached the bank wins",
            {"destination_amount": 412.5, "destination_currency": "sek", "net_amount": 40.0, "currency": "usd"},
        ),
        ("no destination: the net amount", {"destination_amount": None, "net_amount": "39.70", "currency": "usd"}),
        (
            "a destination amount without its money type is not used",
            {"destination_amount": 412.5, "net_amount": 40, "currency": "usd"},
        ),
        ("nothing to read", {"amount": 41.0}),
        ("not a number", {"net_amount": "lots", "currency": "usd"}),
    ):
        micros, currency = sent.whop_amount(payout)
        whop_amounts.append({"name": name, "payout": payout, "micros": micros, "currency": currency})
    return {"amounts": amounts, "whopAmounts": whop_amounts, "lines": lines, "totals": totals, "payoutRows": rows}


# --- steps and items --------------------------------------------------------------------------------------------


def build_steps() -> dict[str, list[dict[str, str]]]:
    return {p: [{"id": s.id, "role": s.role} for s in status.STEPS[p]] for p in status.PLACES if p != CR}


def build_items() -> list[dict[str, Any]]:
    return [
        {
            "sk": "GETPAID",
            "skPattern": "^GETPAID$",
            "writtenBy": ["cf-prod-api"],
            "attributes": ["type", "userId", "stepsDone", "updatedAt"],
            "example": {"type": "getpaid", "userId": "u1", "stepsDone": ["yt-tax", "meta-payout"], "updatedAt": NOW},
        },
        {
            "sk": "PAYCONN#adsense",
            "skPattern": "^PAYCONN#adsense$",
            "writtenBy": ["cf-prod-hooks", "cf-prod-api", "cf-prod-money"],
            "attributes": [
                "type",
                "userId",
                "source",
                "status",
                "accounts",
                "connectedAt",
                "scopes",
                "lastResult",
                "reason",
                "stoppedAt",
                "refreshLeaseUntil",
                "updatedAt",
            ],
            "statuses": ["not_connected", "connected", "needs_reconnect"],
            "reasons": ["token_dead", "keys_changed"],
            "example": {**ADSENSE, "userId": "u1", "updatedAt": NOW},
        },
        {
            "sk": "PAYCONN#whop",
            "skPattern": "^PAYCONN#whop$",
            "writtenBy": ["cf-prod-hooks", "cf-prod-api", "cf-prod-money"],
            "attributes": [
                "type",
                "userId",
                "source",
                "status",
                "accountId",
                "accountName",
                "connectedAt",
                "scopes",
                "lastResult",
                "reason",
                "keyHint",
                "stoppedAt",
                "tokenVersionId",
                "refreshLeaseUntil",
                "updatedAt",
            ],
            "statuses": ["not_connected", "keys_saved", "connected", "needs_reconnect"],
            "reasons": ["token_dead", "keys_changed"],
            "example": {**WHOP_CONN, "userId": "u1", "updatedAt": NOW},
        },
        {
            "sk": "PAYSTATE#youtube",
            "skPattern": "^PAYSTATE#youtube$",
            "writtenBy": ["cf-prod-money"],
            "attributes": [
                "type",
                "place",
                "source",
                "accounts",
                "holds",
                "alerts",
                "unpaid",
                "lastSent",
                "holdSince",
                "firstReadDone",
                "lastCheckedAt",
                "lastError",
            ],
            "accountStates": ["READY", "NEEDS_ATTENTION", "CLOSED"],
            "example": {
                **yt_state(
                    holds=[{"type": "payment-hold", "severity": "SEVERE", "text": "Your payments are on hold."}]
                ),
                "lastSent": {"sk": "PAYOUT#youtube#2026-10-23#3456", "date": "2026-10-23", "text": "kr 1 234,56 SEK"},
                "holdSince": "2026-11-20T06:00:00.000Z",
            },
        },
        {
            "sk": "PAYSTATE#contentrewards",
            "skPattern": "^PAYSTATE#contentrewards$",
            "writtenBy": ["cf-prod-money"],
            "attributes": [
                "type",
                "place",
                "source",
                "kyc",
                "methods",
                "lastPaidOutAt",
                "businesses",
                "hold",
                "lastSent",
                "payoutsMark",
                "firstReadDone",
                "lastCheckedAt",
                "lastError",
            ],
            "kyc": ["not_started", "pending", "approved", "rejected", "unknown"],
            "holdKinds": ["id_rejected", "bank_broken", "payout_failed"],
            "example": {
                **whop_state(),
                "hold": {"kind": "payout_failed", "since": "2026-11-18T06:00:00.000Z"},
                "lastSent": {
                    "sk": "PAYOUT#contentrewards#2026-11-10#po_3",
                    "date": "2026-11-10",
                    "amountMicros": 40_000_000,
                    "currency": "USD",
                },
                "lastPaidOutAt": "2026-11-10T08:00:00.000Z",
                "payoutsMark": "2026-11-10T08:00:00.000Z",
            },
        },
        {
            "sk": "PAYOUT#youtube#{yyyy-mm-dd}#{last 4 of the publisher id}",
            "skPattern": "^PAYOUT#youtube#[0-9]{4}-[0-9]{2}-[0-9]{2}#[A-Za-z0-9]{4}$",
            "writtenBy": ["cf-prod-money"],
            "attributes": [
                "type",
                "place",
                "by",
                "source",
                "account",
                "date",
                "amountText",
                "state",
                "fetchedAt",
                "revisedAt",
                "goneAt",
            ],
            "states": ["sent", "gone"],
            "example": google("2026-10-23", "kr 1 234,56 SEK"),
        },
        {
            "sk": "PAYOUT#contentrewards#{created yyyy-mm-dd}#{payoutId}",
            "skPattern": "^PAYOUT#contentrewards#[0-9]{4}-[0-9]{2}-[0-9]{2}#[A-Za-z0-9_]+$",
            "writtenBy": ["cf-prod-money"],
            "attributes": [
                "type",
                "place",
                "by",
                "source",
                "payoutId",
                "status",
                "state",
                "date",
                "amountMicros",
                "currency",
                "estimatedArrival",
                "traceCode",
                "fetchedAt",
                "updatedAt",
            ],
            "internal": ["traceCode"],
            "statusToState": dict(sent.WHOP_STATES),
            "example": whop("2026-11-10", "po_3", "completed", 40_000_000, estimatedArrival="2026-11-14"),
        },
    ]


# --- writing ------------------------------------------------------------------------------------------------------


def _line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def dump_cases(cases: list[dict[str, Any]]) -> str:
    """One line per part of a case, so a change reads as a small diff."""
    out = []
    for c in cases:
        parts = [f"  {_line(k)}: {_line(v)}" for k, v in c.items()]
        out.append(" {\n" + ",\n".join(parts) + "\n }")
    return "[\n" + ",\n".join(out) + "\n]"


def dump_groups(groups: dict[str, list[dict[str, Any]]]) -> str:
    body = ",\n".join(f"{_line(k)}: {dump_cases(v)}" for k, v in groups.items())
    return "{\n" + body + "\n}\n"


def build() -> dict[str, Any]:
    return {"status": build_status(), "sent": build_sent(), "steps": build_steps(), "items": build_items()}


def write() -> None:
    found = build()
    STATUS_FILE.write_text(dump_groups(found["status"]))
    SENT_FILE.write_text(dump_groups(found["sent"]))
    STEPS_FILE.write_text(json.dumps(found["steps"], ensure_ascii=False, indent=1) + "\n")
    ITEMS_FILE.write_text(dump_cases(found["items"]) + "\n")
    print(f"wrote {STATUS_FILE.name}, {SENT_FILE.name}, {STEPS_FILE.name}, {ITEMS_FILE.name}")


if __name__ == "__main__":
    write()
