"""All your money in one place (docs/CONTRACTS.md §39.2, tests §39.5 "api (G)").

``money_everywhere_cases.json`` (written by ``cr_fit_cases.py``): each state per place, the where lines word for
word, the period equal to the Monthly card's, totals per currency, Content Rewards' ``usd`` → ``USD`` and its cents
→ micros, and never a $0 for a place that reports no money. Then ``GET /v1/money/everywhere`` over stored items only.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db, money
from clipfactory_api.app import App
from clipfactory_api.money import everywhere, summary
from clipfactory_api.money import rules as money_rules
from conftest import NOW, USER, Call, Clock
from cr_fit_cases import MONEY_FILE, YT, build, days, monetization, money_run
from cr_support import FakeCR, make_deps
from fakes import FakeSecretsManager

CASES = json.loads(MONEY_FILE.read_text())
BY_NAME = {c["name"]: c for c in CASES}
PK = db.user_pk(USER)


def place(found: dict[str, Any], name: str) -> dict[str, Any]:
    return next(p for p in found["places"] if p["place"] == name)


def expect(name: str) -> dict[str, Any]:
    return BY_NAME[name]["expect"]  # type: ignore[no-any-return]


def test_the_golden_file_is_current() -> None:
    assert build()["money"] == CASES, "run: uv run python tests/cr_fit_cases.py"


@pytest.mark.parametrize("c", CASES, ids=[c["name"] for c in CASES])
def test_each_money_case(c: dict[str, Any]) -> None:
    assert money_run(c) == c["expect"]


@pytest.mark.parametrize("c", CASES, ids=[c["name"] for c in CASES])
def test_never_a_number_for_a_place_without_one(c: dict[str, Any]) -> None:
    for p in c["expect"]["places"]:
        if p["state"] != "number":
            assert p["amounts"] == [], p
        if p["place"] in ("tiktok", "instagram", "x"):
            assert p["state"] == "not_available"
            assert p["headline"] == f"Not available from {p['name']}"
    counted = {pl for t in c["expect"]["totals"] for pl in t["places"]}
    assert all(place(c["expect"], pl)["state"] == "number" for pl in counted)


def test_the_where_lines_word_for_word() -> None:
    found = expect("YouTube and Content Rewards give one USD total")
    assert place(found, "instagram")["where"] == {"text": "Look in Instagram: Professional dashboard, then Payouts."}
    assert place(found, "tiktok")["where"] == {"text": "Look in TikTok: Profile, then Balance."}
    assert place(found, "x")["where"] == {  # §40.3: X's programme is Original Content Rewards, in Creator Studio
        "text": "Look in X, then Creator Studio (paid through Stripe).",
        "button": {"label": "Open X", "url": "https://x.com/i/jf/creators/studio"},
    }
    assert place(found, "facebook")["where"] == {
        "text": "Look in Meta Business Suite, then Payouts.",
        "button": {"label": "Open Meta Business Suite", "url": "https://business.facebook.com/latest/monetization"},
    }
    assert place(found, "facebook")["state"] == "coming_soon"
    assert place(found, "tiktok")["why"] == "TikTok doesn't tell apps what you earn."


def test_youtube_and_content_rewards_give_one_usd_total() -> None:
    found = expect("YouTube and Content Rewards give one USD total")
    assert (found["from"], found["to"], found["periodText"]) == ("2026-10-18", "2026-11-16", "30 days up to Mon 16 Nov")
    assert found["lagNote"] == "YouTube is 2–3 days behind"
    assert [p["place"] for p in found["places"]] == [
        "youtube",
        "tiktok",
        "instagram",
        "facebook",
        "x",
        "contentrewards",
    ]
    cr = place(found, "contentrewards")
    # 12 Nov $5.00 and 1 Nov $3.00 are in the 30 days, 1 Oct is not; cents become micros, "usd" is written USD
    assert cr["amounts"] == [{"currency": "USD", "amountMicros": 8_000_000}]
    assert (cr["headline"], cr["tag"]) == (
        "Content Rewards says",
        "reached your balance in these 30 days · Content Rewards' numbers",
    )
    assert cr["cr"] == {
        "stillEarningCents": 420,
        "onItsWayCents": 0,
        "readyToMoveCents": 1825,
        "paidSoFarCents": 6240,
        "lastPaidAt": "2026-11-12T09:00:00.000Z",
        "asOf": "2026-11-19T14:10:00.000Z",
        "movedOut": "not_available",
    }
    assert found["totals"] == [
        {
            "currency": "USD",
            "amountMicros": 20_000_000,
            "places": ["youtube", "contentrewards"],
            "tag": "YouTube's estimate + Content Rewards' numbers",
        }
    ]
    assert found["notCountedText"] == (
        "Not in the total: TikTok, Instagram and X (not available) · Facebook (coming soon)."
    )


def test_the_period_is_the_monthly_cards() -> None:
    """The YouTube row equals the Monthly number when YouTube is the only money place (§27.2's ``through``)."""
    for name in ("YouTube and Content Rewards give one USD total", "YouTube couldn't be checked today, money stored"):
        c = BY_NAME[name]
        status = {
            "youtube": {"connected": True, "moneyScope": True, "lastError": c["states"]["youtube"].get("lastError")}
        }
        monthly = summary.summarize(
            today=NOW.date().replace(day=19),
            platforms=["youtube"],
            chart=30,
            rows=c["rows"],
            status=status,
            facebook_verified=False,
            where={},
        )
        found = c["expect"]
        assert found["to"] == monthly["through"]
        assert (
            place(found, "youtube")["amounts"][0]["amountMicros"] == monthly["currencies"][0]["monthly"]["amountMicros"]
        )


def test_two_currencies_are_never_added_together() -> None:
    found = expect("two currencies are never added together")
    assert [(t["currency"], t["places"]) for t in found["totals"]] == [
        ("EUR", ["facebook"]),
        ("USD", ["youtube", "contentrewards"]),
    ]
    assert place(found, "facebook")["headline"] == "Meta says"


def test_nothing_to_add_up() -> None:
    found = expect("nothing stored: the last 30 days, nothing to add up")
    assert (found["periodText"], found["totals"], found["to"]) == ("the last 30 days", [], "2026-11-19")
    assert "lagNote" not in found


def test_each_content_rewards_state() -> None:
    states = {
        "Content Rewards not set up": ("not_set_up", "Connect Content Rewards to see its money."),
        "Content Rewards: sign in again": ("sign_in", "Sign in to Content Rewards again to see your money."),
        "Content Rewards past its 90 days: sign in again": (
            "sign_in",
            "Sign in to Content Rewards again to see your money.",
        ),
        "Content Rewards didn't answer": ("error", "Content Rewards didn't answer. Try again in a few minutes."),
        "Content Rewards: the first read is still going": ("waiting", "Checking Content Rewards…"),
        "Content Rewards: no campaign money yet": (
            "waiting",
            "No campaign money yet. It shows here when the brand approves your clips.",
        ),
        "Content Rewards: paid by day not read yet": ("waiting", "Checking Content Rewards…"),
    }
    for name, (state, why) in states.items():
        cr = place(expect(name), "contentrewards")
        assert (cr["state"], cr["why"]) == (state, why), name
    not_set_up = place(expect("Content Rewards not set up"), "contentrewards")
    assert not_set_up["button"] == {
        "label": "Set up Content Rewards",
        "href": "/settings/posting/setup/contentrewards?back=/money",
        "external": False,
    }
    assert "cr" not in not_set_up
    assert (
        place(expect("Content Rewards: the first read is still going"), "contentrewards")["cr"]["paidSoFarCents"]
        is None
    )
    late = place(expect("Content Rewards couldn't be checked today"), "contentrewards")
    assert (late["state"], late["note"]) == ("number", "Couldn't check today. Showing money up to Thu 19 Nov.")
    assert "contentrewards" not in [p["place"] for p in expect("Content Rewards switched off: no row")["places"]]


def test_each_youtube_state() -> None:
    assert (
        place(expect("YouTube not set up"), "youtube")["button"]["href"]
        == "/settings/posting/setup/youtube?back=/money"
    )
    ok = place(expect("YouTube needs your OK"), "youtube")
    assert (ok["state"], ok["button"]["href"]) == ("needs_ok", "/settings/posting/money#money-youtube")
    not_yet = place(expect("YouTube not in the Partner Program yet"), "youtube")
    assert (not_yet["why"], not_yet["button"]["label"]) == (
        "YouTube says you're not in its Partner Program yet.",
        "How close am I?",
    )
    assert place(expect("YouTube in the program, nothing reported yet"), "youtube")["why"] == (
        "YouTube shows money 2–3 days after it's made."
    )
    assert place(expect("YouTube couldn't be checked and nothing is stored"), "youtube")["state"] == "error"
    late = place(expect("YouTube couldn't be checked today, money stored"), "youtube")
    assert (late["state"], late["note"]) == ("number", "Couldn't check today. Showing money up to Sat 14 Nov.")
    zero = place(expect("a reported $0 day is a number"), "youtube")
    assert (zero["state"], zero["amounts"]) == ("number", [{"currency": "USD", "amountMicros": 0}])
    behind = place(expect("Facebook verified, behind while YouTube is up to date"), "facebook")
    assert (behind["state"], behind["why"]) == ("waiting", "Facebook hasn't sent money since Tue 27 Oct.")


def test_where_line_rule() -> None:
    assert everywhere.where_line("TikTok", {"label": "Profile › Balance"}) == {
        "text": "Look in TikTok: Profile, then Balance."
    }
    cfg = money_rules.load()
    assert all(isinstance(cfg.platform(p).paid_where.get("label"), str) for p in money.MONEY_ORDER)  # config unchanged
    assert monetization(False) is cfg


# --- the route ---------------------------------------------------------------------------------------------------


def _youtube(store: db.Store) -> None:
    store.put({"pk": PK, "sk": "ACCOUNT#youtube", "type": "account", "userId": USER, "platform": "youtube", **YT})
    store.put({"pk": PK, "sk": money.state_sk("youtube"), "type": "moneystate", "state": "earning"})
    for row in days("youtube", "2026-11-13", [500_000] * 30):
        store.put(
            {
                "pk": PK,
                "sk": money.revenue_sk("youtube", row["date"]),
                "type": "revenue",
                "date": row["date"],
                "amountMicros": row["amountMicros"],
                "currency": "USD",
            }
        )


def test_get_money_everywhere(call: Call, app: App, secrets_client: FakeSecretsManager, clock: Clock) -> None:
    _youtube(app.store)
    status, body = call("GET", "/v1/money/everywhere")
    assert status == 200
    assert [p["place"] for p in body["places"]] == ["youtube", "tiktok", "instagram", "facebook", "x"]  # CR off
    assert body["totals"][0]["amountMicros"] == 15_000_000
    assert app.store.get(money.OWNERS_PK, money.owner_sk(USER)) is not None  # registered like GET /v1/money
    fake = FakeCR()
    app.contentrewards = make_deps(app.store, secrets_client, fake, clock)
    app.store.put({"pk": PK, "sk": db.CRCONN_SK, "type": "crconn", "status": "connected"})
    app.store.put(
        {
            "pk": PK,
            "sk": db.CRMONEY_SK,
            "type": "crmoney",
            "firstReadDone": True,
            "paidByDayDone": True,
            "paidTotalCents": 900,
            "paidByDay": {"2026-11-10": 900},
            "asOf": "2026-11-15T10:00:00.000Z",
        }
    )
    status, body = call("GET", "/v1/money/everywhere")
    assert status == 200
    cr = place(body, "contentrewards")
    assert (cr["state"], cr["amounts"]) == ("number", [{"currency": "USD", "amountMicros": 9_000_000}])
    assert body["totals"][0]["amountMicros"] == 24_000_000
    assert fake.requests == []  # never calls Content Rewards
    assert "dayScan" not in json.dumps(body)  # nothing internal
    assert "paidByDay" not in json.dumps(body)


# --- §40.4: "Sent to your bank", per place and in total ----------------------------------------------------------


def test_sent_lines_per_place_word_for_word() -> None:
    found = expect("sent to your bank: Google in kronor and Whop in dollars, never added together")
    yt, cr = place(found, "youtube")["sent"], place(found, "contentrewards")["sent"]
    assert (yt["state"], yt["headline"], yt["tag"]) == ("number", "Sent to your bank by Google", "YouTube says")
    assert yt["amounts"] == [{"currency": "SEK", "amountMicros": 2_468_000_000}]  # Google's own two amounts
    assert yt["arrive"] == "Your bank gets it up to 7 workdays after Google sends it."
    assert (cr["headline"], cr["tag"]) == ("Sent to your bank by Whop", "Whop says")
    assert cr["amounts"] == [{"currency": "USD", "amountMicros": 40_000_000}]  # on its way and came back don't count
    assert cr["note"] == "Whop counts all your Whop money, not only Content Rewards."
    assert cr["arrive"] == "Whop says it should arrive by Sat 14 Nov."
    for p in ("tiktok", "instagram", "facebook", "x"):
        line = place(found, p)["sent"]
        assert (line["state"], line["amounts"]) == ("not_available", [])  # never $0
    assert place(found, "x")["sent"]["where"] == {
        "text": "Look in Stripe: Payouts.",
        "button": {"label": "Open Stripe", "url": "https://connect.stripe.com/express_login"},
    }
    assert place(found, "tiktok")["sent"]["headline"] == "Not available from TikTok"
    assert place(found, "facebook")["sent"]["headline"] == "Not available from Meta"
    block = found["sent"]
    assert [(t["currency"], t["names"]) for t in block["totals"]] == [
        ("SEK", "YouTube"),
        ("USD", "Whop (all your Whop money, Content Rewards too)"),
    ]  # in the places' order, never ranked across money types
    assert block["tag"] == "Google and Whop say they sent it."
    assert block["notCountedText"] == "Not in this: TikTok, Instagram, Facebook and X (not available)."
    assert block["bankText"] == "Clip Factory can't see your bank. Look in your bank's app to see what arrived."
    assert "empty" not in block
    assert found["totals"] == expect("YouTube and Content Rewards give one USD total")["totals"]  # never in the 30 days
    assert "traceCode" not in json.dumps(found)
    assert "UETR" not in json.dumps(found)


def test_sent_in_one_money_type_is_one_line_and_unread_amounts_are_never_added() -> None:
    one = expect("sent to your bank: Google and Whop in dollars make one line")["sent"]["totals"]
    assert one == [
        {
            "currency": "USD",
            "amountMicros": 210_000_000,
            "places": ["youtube", "contentrewards"],
            "names": "YouTube and Whop (all your Whop money, Content Rewards too)",
        }
    ]
    unread = expect("sent to your bank: Google's money type can't be read, so nothing is added up")
    line = place(unread, "youtube")["sent"]
    assert (line["state"], line["amounts"]) == ("number", [])  # still "number", never "Nothing sent yet"
    assert (
        line["notAdded"]
        == "Google sent 2 payments. Clip Factory couldn't tell their money type, so they aren't added up."
    )
    assert line["button"] == {"label": "See them", "href": "/settings/posting/getpaid/youtube", "external": False}
    assert line["last"]["text"] == "$1,234.57"  # Google's own words
    assert "empty" not in unread["sent"]
    assert unread["sent"]["totals"] == []
    some = place(expect("sent to your bank: one of Google's payments can't be read"), "youtube")["sent"]
    assert some["notAdded"] == "1 payment isn't added up: Clip Factory couldn't tell its money type."
    two = place(expect("sent to your bank: two AdSense accounts paid on the same day stay two payments"), "youtube")
    assert two["sent"]["amounts"] == [{"currency": "EUR", "amountMicros": 100_000_000}]
    gone = place(expect("sent to your bank: a payment Google no longer lists stops counting"), "youtube")
    assert gone["sent"]["amounts"] == [{"currency": "SEK", "amountMicros": 1_234_560_000}]


def test_sent_states_without_a_payment() -> None:
    def yt(name: str) -> dict[str, Any]:
        return place(expect(name), "youtube")["sent"]  # type: ignore[no-any-return]

    assert (
        yt("YouTube and Content Rewards give one USD total")["headline"]
        == "Clip Factory can't see YouTube payments yet"
    )
    assert yt("sent to your bank: payment reading on, nothing sent yet")["state"] == "none_yet"
    assert yt("sent to your bank: payment reading just allowed, checking")["state"] == "checking"
    assert yt("sent to your bank: the first read is late")["state"] == "error"
    assert yt("sent to your bank: payment reading needs a reconnect")["headline"] == (
        "Clip Factory can't see YouTube payments anymore"
    )
    assert yt("sent to your bank: payment reading stopped, Google's payments stay")["note"] == (
        "Clip Factory stopped reading on 3 Nov."
    )
    assert expect("YouTube and Content Rewards give one USD total")["sent"]["empty"] == "Nothing sent to your bank yet."
    off = place(expect("sent to your bank: Connect Whop switched off says not available"), "contentrewards")["sent"]
    assert off == {
        "state": "not_available",
        "headline": "Sent to your bank: not available from Content Rewards",
        "amounts": [],
        "where": {"text": "Look on Whop: **Balances**."},
    }  # no Connect Whop while it is switched off
    on = place(expect("sent to your bank: Connect Whop is on but not connected"), "contentrewards")["sent"]
    assert on["button"] == {
        "label": "Connect Whop",
        "href": "/settings/posting/getpaid/contentrewards#whop",
        "external": False,
    }


def test_get_money_everywhere_reads_the_stored_payouts(call: Call, app: App) -> None:
    from cr_fit_cases import ADSENSE_ON, READ, google

    _youtube(app.store)
    app.store.put({"pk": PK, "sk": "PAYCONN#adsense", **ADSENSE_ON})
    app.store.put({"pk": PK, "sk": "PAYSTATE#youtube", **READ})
    row = google("2026-10-23", "kr 1 234,56 SEK")
    app.store.put({"pk": PK, **row})
    status, body = call("GET", "/v1/money/everywhere")
    assert status == 200
    sent = place(body, "youtube")["sent"]
    assert (sent["state"], sent["amounts"]) == ("number", [{"currency": "SEK", "amountMicros": 1_234_560_000}])
    assert body["sent"]["totals"][0]["names"] == "YouTube"
    assert body["totals"][0]["amountMicros"] == 15_000_000  # the 30-day total is unchanged
    assert "pub-1234567890123456" not in json.dumps(body)
