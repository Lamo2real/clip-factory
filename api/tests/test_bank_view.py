"""Your bank's numbers and words (docs/CONTRACTS.md §40.5.9, tests §40.5.13 "api (BA)", ``bank_view_cases.json``).

The golden file holds one owner's stored items and the ``BankView`` the server makes of them; the hand-written asserts
below pin §40.5.9 word for word. The owner's rule: money only as reported ("Your bank says"), per currency, never
added across currencies, converted, estimated or shown as 0, and he never types an amount.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from bank_cases import STEPS_FILE, VIEW_FILE, build_steps, build_view, run
from clipfactory_api.bank import CHECK_TEXT, NUMBERED, RESULT_TEXT, view

GOLDEN = json.loads(VIEW_FILE.read_text())
CASES = [c for group in GOLDEN.values() for c in group]
BY_NAME = {c["name"]: c["expect"] for c in CASES}
NEVER = ("consent", "session", "ASPSP", "PSD2", "AISP", "token", "IBAN", "Connected", "Not connected", "disconnected")


def out(name: str) -> dict[str, Any]:
    return BY_NAME[name]  # type: ignore[no-any-return]


def test_the_golden_files_are_current() -> None:
    assert build_view() == GOLDEN, "run: uv run python tests/bank_cases.py"
    assert build_steps() == json.loads(STEPS_FILE.read_text())


@pytest.mark.parametrize("c", CASES, ids=[c["name"] for c in CASES])
def test_each_case(c: dict[str, Any]) -> None:
    assert run(c) == c["expect"]


@pytest.mark.parametrize("c", CASES, ids=[c["name"] for c in CASES])
def test_every_view_is_honest(c: dict[str, Any]) -> None:
    found = c["expect"]
    words = " ".join([found["pill"], found["line"], *(link["line"] for link in found["links"])])
    for word in NEVER:
        assert word not in words, (word, words)
    assert found["ring"]["total"] == 7
    assert found["ring"]["done"] == sum(1 for s in found["steps"] if s["done"] and s["id"] != "bank-ask")
    assert ("fold" in found) == (found["ring"]["done"] == 7)
    nxt = found["next"]
    if nxt and nxt["stepId"]:
        assert nxt["text"].startswith("Next: step ")
        assert nxt["vermilion"] is (nxt["stepId"] != "bank-details")
        assert nxt["stepId"] != "bank-ask"  # the optional email is never next
    if nxt and nxt["stepId"] is None:
        assert nxt["label"].startswith("Reconnect ")
        assert nxt["vermilion"] is True
    text = json.dumps(found, ensure_ascii=False)
    for secret in ("privateKeyPem", "hashKey", "sessionId", "payerKey", "idHash", "uid-", "psuHeaders", 'hint"'):
        assert secret not in text, secret
    reached = found["reached"]
    for place in reached["places"]:
        assert place["amounts"], place  # a place with nothing is never shown as 0
        assert all(a["amountMicros"] > 0 for a in place["amounts"])
    currencies = [a["currency"] for a in reached["totals"]]
    assert currencies == sorted(set(currencies))  # one total per currency, never one across currencies


def test_not_started_and_the_optional_email() -> None:
    first = out("not started: nothing at all")
    assert (first["status"], first["pill"], first["tone"]) == ("not_started", "Not started", "neutral")
    assert first["line"] == "See which app money reached your bank. Set it up once with BankID."
    assert first["key"] == {"made": False}
    asked = out("not started: the optional email alone never counts")
    assert asked["status"] == "not_started"
    assert asked["steps"][0] == {"id": "bank-ask", "done": True, "by": "you"}
    assert asked["ring"] == {"done": 0, "total": 7}


def test_next_for_every_step() -> None:
    assert out("step 1 next after the key: Open Enable Banking")["next"] == {
        "stepId": "bank-account",
        "label": "Open Enable Banking",
        "text": "Next: step 1, Make an Enable Banking account.",
        "vermilion": True,
    }
    four = out("step 4 next: no Open, so no vermilion")["next"]
    assert four["stepId"] == "bank-details"
    assert four["vermilion"] is False
    assert four["text"] == "Next: step 4, Fill in the app's details."
    five = out("step 5 next while no app ID is saved: Save")["next"]
    assert (five["stepId"], five["label"]) == ("bank-appid", "Save")
    again = out("step 5 after a save: Check again, and the check's sentence is the line")
    assert (again["next"]["stepId"], again["next"]["label"]) == ("bank-appid", "Check again")
    assert again["line"] == CHECK_TEXT["key_wrong"]
    assert again["key"]["check"]["text"] == CHECK_TEXT["key_wrong"]
    six = out("not_active: steps 1, 3 and 4 tick themselves, step 6 next")
    assert (six["next"]["stepId"], six["next"]["label"]) == ("bank-link", "Open your Enable Banking apps")
    assert six["line"] == "Next: step 6, Link your bank accounts."
    seven = out("ok: step 7 next, Connect your bank")["next"]
    assert (seven["stepId"], seven["label"]) == ("bank-connect", "Connect your bank")
    labels = {s.id: s.label for s in NUMBERED}
    assert labels["bank-key"] == "Make my bank key"
    assert labels["bank-app"] == "Open your Enable Banking apps"


def test_the_autos_and_the_green_answers() -> None:
    steps = {s["id"]: s for s in out("not_active: steps 1, 3 and 4 tick themselves, step 6 next")["steps"]}
    for step_id in ("bank-account", "bank-app", "bank-details", "bank-appid"):
        assert steps[step_id] == {
            "id": step_id,
            "done": True,
            "by": "auto",
            "auto": "Enable Banking knows your app",
        }
    assert steps["bank-key"]["auto"] == "Clip Factory made your bank key"
    assert steps["bank-link"]["done"] is False  # only a check that says active, or a connected bank
    ticked = {s["id"]: s for s in out("step 5 next while no app ID is saved: Save")["steps"]}
    for step_id in ("bank-account", "bank-app", "bank-details"):
        assert ticked[step_id] == {"id": step_id, "done": True, "by": "you"}  # his green answer is the normal way
    connected = {s["id"]: s for s in out("can see: one bank, 143 days left")["steps"]}
    assert connected["bank-connect"]["auto"] == "Clip Factory can see Swedbank"
    assert connected["bank-link"]["auto"] == "Enable Banking says your app is active"


def test_fold_only_with_all_seven_and_gone_again_on_key_wrong() -> None:
    assert out("can see: one bank, 143 days left")["fold"] == "Set up ✓ (Enable Banking knows your app)"
    broken = out("key_wrong after connecting unfolds the steps again")
    assert "fold" not in broken
    assert broken["status"] == "setting_up"
    assert broken["line"] == CHECK_TEXT["key_wrong"]
    assert len(broken["links"]) == 1  # his bank stays on the page


def test_the_key_box() -> None:
    key = out("step 1 next after the key: Open Enable Banking")["key"]
    assert key["made"] is True
    assert key["source"] == "clipfactory"
    assert key["publicKeyPem"].startswith("-----BEGIN PUBLIC KEY-----")
    assert key["pemReminder"] is False
    assert out("a .pem was saved: the reminder stays until I deleted it")["key"]["pemReminder"] is True
    assert out("a .pem was saved and deleted")["key"]["pemReminder"] is False
    assert out("ok: step 7 next, Connect your bank")["key"]["appIdHint"] == "0f6e1d2c…"


def test_every_status_pill_and_line() -> None:
    expect = {
        "checking: the first read is running": (
            "checking",
            "Checking…",
            "neutral",
            "Clip Factory is reading Swedbank for the first time. This can take a few minutes.",
        ),
        "checking after 26 hours with no first read (no reader yet)": (
            "checking",
            "Checking…",
            "neutral",
            "Clip Factory couldn't read Swedbank yet. It tries again tomorrow.",
        ),
        "can see: one bank, 143 days left": (
            "can_see",
            "Clip Factory can see it (Your bank says)",
            "success",
            "Clip Factory looks at Swedbank once a day. The link ends in 143 days.",
        ),
        "can see: two banks, the first link ends in 98 days": (
            "can_see",
            "Clip Factory can see it (Your bank says)",
            "success",
            "Clip Factory looks at Swedbank and PayPal once a day. The first link ends in 98 days.",
        ),
        "ending soon at 14 days": (
            "ending_soon",
            "Link ends in 14 days",
            "warn",
            "Your Swedbank link ends on Sun 6 Dec. Tap Reconnect Swedbank and use BankID.",
        ),
        "ends in 1 day": (
            "ending_soon",
            "Link ends in 1 day",
            "warn",
            "Your Swedbank link ends on Sun 22 Nov. Tap Reconnect Swedbank and use BankID.",
        ),
        "can't read at 26 hours, no reconnect yet": (
            "cant_read",
            "Can't read Swedbank",
            "warn",
            "Clip Factory couldn't read Swedbank since 21 Nov. Tap Check now. If it stays, tap Reconnect Swedbank.",
        ),
        "look in your bank's app": (
            "look_in_bank",
            "Look in your Swedbank app",
            "warn",
            "Swedbank wants you to do something in its app or website first. Then tap Check now.",
        ),
        "ended: the link was over": (
            "ended",
            "Link ended",
            "error",
            "Your Swedbank link ended on 28 Oct. Clip Factory can't see new money until you reconnect.",
        ),
        "ended early": (
            "ended",
            "Link ended",
            "error",
            "Swedbank ended the link early. Banks sometimes do. Tap Reconnect Swedbank and use BankID.",
        ),
        "stopped outside Clip Factory": (
            "stopped_at_bank",
            "Stopped outside Clip Factory",
            "error",
            "The Swedbank link was stopped at Enable Banking or at your bank. Tap Reconnect Swedbank to start it again.",
        ),
        "every link stopped": (
            "stopped",
            "Stopped",
            "neutral",
            "You stopped reading Swedbank on 3 Dec. The money it found stays here.",
        ),
    }
    for name, (status, pill, tone, line) in expect.items():
        found = out(name)
        assert (found["status"], found["pill"], found["tone"], found["line"]) == (status, pill, tone, line), name
    setting = out("step 4 next: no Open, so no vermilion")
    assert (setting["pill"], setting["tone"]) == ("Not set up yet", "warn")


def test_cant_read_at_26_hours_and_reconnect_at_3_days() -> None:
    assert out("failing for 25 hours still says can see")["status"] == "can_see"
    young = out("can't read at 26 hours, no reconnect yet")
    assert young["links"][0]["reconnect"] is False
    assert young["next"] is None
    assert young["links"][0]["lastError"] == "Swedbank didn't answer. Clip Factory tries again tomorrow."
    old = out("can't read for 3 days: reconnect")
    assert old["links"][0]["reconnect"] is True
    assert old["next"] == {"stepId": None, "label": "Reconnect Swedbank", "linkId": "a1b2c3d4e5f6", "vermilion": True}


def test_rings_days_left_and_total_days() -> None:
    one = out("can see: one bank, 143 days left")["links"][0]
    assert (one["daysLeft"], one["totalDays"]) == (143, 180)
    short = out("a 90-day bank: the ring is out of 90")["links"][0]
    assert short["totalDays"] == 90
    soon = out("ending soon at 14 days")
    assert soon["links"][0]["daysLeft"] == 14
    assert soon["links"][0]["reconnect"] is True
    assert soon["next"]["label"] == "Reconnect Swedbank"
    later = out("15 days left is still can see")
    assert later["links"][0]["reconnect"] is False
    assert later["next"] is None
    ended = out("ended: the link was over")["links"][0]
    assert ended["daysLeft"] == 0
    assert ended["tone"] == "error"


def test_the_worst_link_wins() -> None:
    mixed = out("worst link wins: ended beats can see; the stopped one stays a quiet row")
    assert mixed["status"] == "ended"
    assert mixed["next"]["label"] == "Reconnect PayPal"
    stopped = next(link for link in mixed["links"] if link["status"] == "stopped")
    assert stopped["canStop"] is False
    assert "daysLeft" not in stopped
    assert stopped["reconnect"] is False
    outside = out(
        "worst link wins: stopped outside beats look in your bank; reconnect picks stopped outside before ending"
    )
    assert outside["status"] == "stopped_at_bank"
    assert outside["next"]["linkId"] == "0a1b2c3d4e5f"  # stopped outside comes before an end in 14 days
    assert view.WORST == ("ended", "stopped_at_bank", "look_in_bank", "cant_read", "ending_soon", "checking", "can_see")


def test_a_bare_link_is_internal() -> None:
    bare = out("a link Forget kept bare is never shown")
    assert bare["links"] == []
    assert "moneyLine" not in bare
    assert bare["next"]["stepId"] == "bank-connect"


def test_totals_per_place_per_currency_never_across() -> None:
    found = out("totals per place per currency, never across; meta on its own and in Instagram's and Facebook's lines")
    reached = found["reached"]
    assert [p["place"] for p in reached["places"]] == ["youtube", "meta", "x"]
    assert reached["totals"] == [
        {"currency": "SEK", "amountMicros": 2_146_960_000},  # kr 1 234,56 + kr 912,40
        {"currency": "USD", "amountMicros": 40_000_000},
    ]
    assert reached["twoMonies"] == "Different money, like dollars and kronor, is never added together."
    meta = next(p for p in reached["places"] if p["place"] == "meta")
    assert meta["name"] == "Instagram and Facebook (Meta pays them together)"
    assert meta["note"] == "Meta pays Instagram and Facebook in one payment, so Clip Factory can't split it."
    assert reached["notYet"] == "No money from TikTok reached your bank yet."  # Instagram and Facebook are in via meta
    assert reached["since"] == "Counted from 3 Aug 2026, as far back as your bank shows."
    assert reached["needYou"] == "1 bank payment needs you."  # the "Not sure" one isn't counted
    assert reached["tag"] == "Your bank says. Clip Factory matched each one to an app."
    places = found["places"]
    assert places["instagram"]["metaAmounts"] == [{"currency": "SEK", "amountMicros": 912_400_000}]
    assert places["facebook"]["metaAmounts"] == places["instagram"]["metaAmounts"]
    assert places["youtube"] == {
        "headline": "Reached your bank",
        "amounts": [{"currency": "SEK", "amountMicros": 1_234_560_000}],
        "note": "Your bank says. Last on 28 Oct.",
    }
    assert places["tiktok"]["headline"] == "Nothing from TikTok reached your bank yet."
    assert places["tiktok"]["note"] == "Your bank says. Clip Factory looked on 22 Nov."
    assert found["pairs"] == [
        {
            "place": "youtube",
            "payoutDate": "2026-10-21",
            "amountMicros": 1_234_560_000,
            "currency": "SEK",
            "reachedOn": "2026-10-28",
        }
    ]
    hows = {r["place"]: r["howText"] for r in found["rows"]}
    assert hows == {
        "youtube": "matches Google's payment of 21 Oct",
        "meta": "from a payer you said is Instagram and Facebook",
        "x": "you said it's from X",
    }
    assert all(r["bank"] == "Swedbank" for r in found["rows"])


def test_needs_you_not_sure_and_not_income_are_never_counted() -> None:
    found = out(
        "questions: suggested, Stripe, PayPal, own move, meta, not sure last, past its ttl hidden, back after Not from"
    )
    assert found["reached"]["totals"] == []
    assert found["reached"]["empty"] == "Nothing from an app reached your bank yet."
    assert "notYet" not in found["reached"]
    asks = found["asks"]
    assert [a["date"] for a in asks] == [
        "2026-11-21",
        "2026-11-20",
        "2026-11-19",
        "2026-11-18",
        "2026-11-17",
        "2026-10-02",
        "2026-11-16",  # "Not sure" comes last
    ]
    assert "2026-05-01" not in [a["date"] for a in asks]  # past its ttl: hidden though DynamoDB still has it
    by_date = {a["date"]: a for a in asks}
    assert (by_date["2026-11-18"]["title"], by_date["2026-11-18"]["line"], by_date["2026-11-18"]["yesLabel"]) == (
        "Is this money from YouTube?",
        "Your bank's text looks like Google.",
        "Yes, it's YouTube",
    )
    assert (by_date["2026-11-19"]["title"], by_date["2026-11-19"]["line"], by_date["2026-11-19"]["yesLabel"]) == (
        "Is this money from X?",
        "Your bank's text says Stripe. X pays through Stripe, but others can too.",
        "Yes, it's X",
    )
    assert (by_date["2026-11-20"]["title"], by_date["2026-11-20"]["line"]) == (
        "Where is this money from?",
        "Your bank's text mentions PayPal.",
    )
    assert "yesLabel" not in by_date["2026-11-20"]
    assert by_date["2026-11-20"]["suggested"] is None
    move = by_date["2026-11-21"]
    assert (move["kind"], move["title"], move["yesLabel"]) == (
        "own_move",
        "Did you move this from your PayPal?",
        "Yes, I moved it",
    )
    assert move["line"] == "Clip Factory reads your PayPal too, so this money may already be counted there."
    meta = by_date["2026-11-17"]
    assert (meta["title"], meta["line"], meta["yesLabel"]) == (
        "Is this money from Instagram and Facebook?",
        "Your bank's text looks like Meta.",
        "Yes, Instagram and Facebook",
    )
    assert by_date["2026-11-16"]["notSure"] is True
    assert found["reached"]["needYou"] == "6 bank payments need you."


def test_at_most_20_questions() -> None:
    found = out("more than 20 questions")
    assert len(found["asks"]) == 20
    assert found["asksMore"] == 3


def test_content_rewards_while_on_and_off() -> None:
    on = out("Content Rewards on: its place, its note and the pair with Whop's payout")
    cr = next(p for p in on["reached"]["places"] if p["place"] == "contentrewards")
    assert cr["name"] == "Content Rewards (Whop)"
    assert cr["note"] == "Whop sends all your Whop money, Content Rewards too."
    assert on["places"]["contentrewards"]["headline"] == "Reached your bank"
    assert {p["place"] for p in on["pairs"]} == {"youtube", "contentrewards"}
    whop_row = next(r for r in on["rows"] if r["place"] == "contentrewards")
    assert whop_row["howText"] == "matches Whop's payout of 10 Nov"
    assert on["reached"]["notYet"] == "No money from TikTok, Instagram, Facebook or X reached your bank yet."
    assert on["asks"][0]["yesLabel"] == "Yes, it's Content Rewards"
    off = out("Content Rewards off: a Whop question has no suggestion")
    assert "contentrewards" not in off["places"]
    assert (off["asks"][0]["suggested"], off["asks"][0]["line"]) == (None, "Your bank's text mentions Whop.")


def test_places_in_all_three_states() -> None:
    none = out("no link: every place says it can't see the bank yet")["places"]
    assert set(none) == {"youtube", "tiktok", "instagram", "facebook", "x"}
    assert none["youtube"] == {
        "headline": "Clip Factory can't see your bank yet.",
        "amounts": [],
        "button": {"label": "Set up Your bank", "href": "/settings/posting/getpaid/bank"},
    }
    assert out("no link: every place says it can't see the bank yet")["reached"]["state"] == "no_link"
    assert out("checking: nothing matched yet, no number")["reached"]["state"] == "checking"
    assert out("none yet: read, nothing from an app")["reached"]["state"] == "none_yet"
    assert out("none yet: read, nothing from an app")["places"]["x"] == {
        "headline": "Nothing from X reached your bank yet.",
        "amounts": [],
        "note": "Your bank says. Clip Factory looked on 22 Nov.",
    }


def test_money_line_only_once_a_bank_was_connected() -> None:
    assert "moneyLine" not in out("no link: every place says it can't see the bank yet")
    assert out("none yet: read, nothing from an app")["moneyLine"] == "What reached your bank is below."


def test_last_connect() -> None:
    found = out("lastConnect within a day, a reconnect")["lastConnect"]
    assert found == {
        "result": "bank_denied",
        "text": "You stopped at the bank. Tap Reconnect Swedbank to try again.",
        "at": "2026-11-22T11:00:00.000Z",
    }
    assert "lastConnect" not in out("lastConnect more than a day old is gone")


def test_check_now_times() -> None:
    found = out("Check now: 15 minutes, then 12 a day")
    assert found["nextCheckAllowedAt"] == "2026-11-23T00:00:00.000Z"
    assert found["country"] == "SE"


def test_values_and_the_email() -> None:
    values = out("not started: nothing at all")["values"]
    assert values["appName"] == "Clip Factory"
    assert values["description"] == "Shows me which of my app payouts reached my own bank account."
    assert values["redirectUri"].endswith("/oauth/bank/callback")
    assert values["privacyUrl"].endswith("/legal/privacy.html")
    assert values["termsUrl"].endswith("/legal/terms.html")
    ask = values["ask"]
    assert ask["to"] == "support.api@enablebanking.com"
    assert ask["subject"] == "Personal use: my own creator income on my own account"
    assert ask["body"].startswith("Hello,\n\nI'm a private person in Sweden.")
    assert ask["body"].endswith("Thank you!")
    assert "@" not in ask["body"]  # no name or detail of his: he signs it himself


def test_result_sentences_word_for_word() -> None:
    from clipfactory_api.bank import result_text

    assert result_text("bank_connected", "Swedbank", False) == (
        "Clip Factory can see money coming into Swedbank now. It looks once a day."
    )
    assert result_text("bank_expired", "Swedbank", True) == "That took too long. Tap Reconnect Swedbank again."
    assert (
        result_text("bank_error", None, False) == "Something went wrong. Tap Connect your bank again in a few minutes."
    )
    assert result_text("bank_no_accounts", None, True) == (
        "Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap Connect your bank "
        "again."
    )
    assert set(RESULT_TEXT) == {
        "bank_connected",
        "bank_denied",
        "bank_no_accounts",
        "bank_business_only",
        "bank_expired",
        "bank_key_wrong",
        "bank_error",
    }


def test_amounts_are_a_change_of_unit_never_a_conversion() -> None:
    assert view.micros({"amountMinor": 123456, "exponent": 2}) == 1_234_560_000
    assert view.micros({"amountMinor": 1234, "exponent": 3}) == 1_234_000
    assert view.micros({"amountMinor": 500, "exponent": 0}) == 500_000_000
    assert view.micros({"amountMinor": 0, "exponent": 2}) is None
    assert view.micros({"amountMinor": 1.5, "exponent": 2}) is None
    rows = [
        {"amountMinor": 100, "exponent": 2, "currency": "SEK"},
        {"amountMinor": 100, "exponent": 2, "currency": "USD"},
    ]
    assert view.amounts(rows) == [
        {"currency": "SEK", "amountMicros": 1_000_000},
        {"currency": "USD", "amountMicros": 1_000_000},
    ]
