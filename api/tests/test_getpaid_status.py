"""Get paid: the status per place, honest and saying how it is known (docs/CONTRACTS.md §40.2, tests §40.8 "api (K)").

``getpaid_status_cases.json`` (written by ``getpaid_cases.py``) holds one place's stored facts and the card the
server makes of them. The hand-written asserts below pin the rules of §40.2 word for word.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api.getpaid import CR, status
from getpaid_cases import STATUS_FILE, STEPS_FILE, build_status, build_steps, run

GOLDEN = json.loads(STATUS_FILE.read_text())
CARDS = GOLDEN["cards"]
BY_NAME = {c["name"]: c for c in CARDS}
NEVER = ("Live", "Active", "Verified ✓", "Connected", "Not connected", "disconnected", "KYC", "EFT", "OAuth", "token")


def card(name: str) -> dict[str, Any]:
    return BY_NAME[name]["expect"]  # type: ignore[no-any-return]


def test_the_golden_files_are_current() -> None:
    assert build_status() == GOLDEN, "run: uv run python tests/getpaid_cases.py"
    assert build_steps() == json.loads(STEPS_FILE.read_text())


@pytest.mark.parametrize("c", CARDS, ids=[c["name"] for c in CARDS])
def test_each_case(c: dict[str, Any]) -> None:
    assert run(c) == c["expect"]


@pytest.mark.parametrize("c", CARDS, ids=[c["name"] for c in CARDS])
def test_every_card_is_honest(c: dict[str, Any]) -> None:
    out = c["expect"]
    words = " ".join([out["pill"], out["line"], out["known"], *out["seen"], *out["missing"]])
    for word in NEVER:
        assert word not in words, (word, words)
    assert out["status"] in status.STATUSES
    assert out["tone"] in {"success", "neutral", "warn", "error"}
    if out["tone"] == "success":
        assert out["status"] in {"can_get_paid", "you_said_done"}
    if out["status"] == "you_said_done":
        assert "✓" not in out["pill"]
    if out["status"] == "not_set_up" and out["knownBy"] == "you":
        assert (out["pill"], out["tone"]) == ("Not set up yet", "warn")  # never red without a signal
    if out["status"] == "not_set_up" and out["knownBy"] in {"youtube", "whop"}:
        assert out["tone"] == "error"
    numbered = {s.id for s in status.numbered(c["place"], c["inputs"].get("finance"))}
    assert out["ring"]["done"] == sum(1 for s in out["steps"] if s["done"] and s["id"] in numbered)
    assert "yt-reading" not in numbered
    nxt = out["next"]
    if nxt and nxt["stepId"]:
        assert nxt["text"].startswith("Next: step ")
        assert nxt["stepId"] != "yt-reading"
    if nxt and nxt["stepId"] == "x-premium":
        assert nxt["vermilion"] is False  # X Premium costs money: never the vermilion
    assert len(out["seen"]) <= status.MAX_SEEN
    assert "UETR" not in json.dumps(out)
    assert "pub-1234567890123456" not in json.dumps(out)
    if c["place"] == "x":
        assert out["warning"].startswith("X doesn't pay for posts an app made or posted")


def test_the_order_a_fresh_hold_beats_all() -> None:
    held = card("youtube: a fresh hold beats everything, next the first payout step not done")
    assert (held["status"], held["pill"], held["tone"]) == ("on_hold", "Payment on hold (YouTube says)", "error")
    assert held["line"] == "Google is holding your money. Tap Open AdSense for YouTube to see why."
    assert held["holds"] == ["Your payments are on hold."]
    assert held["next"]["stepId"] == "yt-bank"  # HOLD_FIX: the first payout step not done
    open_it = card("youtube: a fresh hold with no payout step left opens AdSense for YouTube")["next"]
    assert open_it == {
        "stepId": None,
        "label": "Open AdSense for YouTube",
        "href": "https://adsense.google.com/",
        "external": True,
        "hint": "Look for the red message on **Payments**. Do what it says.",
        "vermilion": True,
    }


def test_youtube_not_yet_beats_his_ticks() -> None:
    out = card("youtube: not in the Partner Program (YouTube says) beats his ticks, a goal not reached")
    assert (out["status"], out["pill"], out["knownBy"]) == ("not_allowed", "Not allowed yet (YouTube says)", "youtube")
    assert out["line"] == (
        "YouTube needs 1,000 subscribers. YouTube says you have 812. Clip Factory tells you when you get there."
    )
    assert out["next"] is None
    reached = card("youtube: every goal reached says apply in YouTube Studio, next yt-join")
    assert reached["line"] == "You reached YouTube's goals. Apply in YouTube Studio. YouTube checks it."
    assert reached["next"]["stepId"] == "yt-join"


def test_tiktok_in_sweden_is_not_started_never_not_allowed() -> None:
    out = card("tiktok: Sweden is not started with the Creator Rewards line, never not allowed")
    assert (out["status"], out["knownBy"], out["known"]) == ("not_started", "rules", "TikTok's rules for Sweden")
    assert out["line"] == "Creator Rewards isn't open in Sweden. Gifts might be. Next: step 1, Turn on Gifts."


def test_instagram_and_x_rules() -> None:
    ig = card("instagram: 312 followers is not allowed yet (Instagram's rules)")
    assert (ig["status"], ig["knownBy"], ig["known"]) == ("not_allowed", "rules", "Instagram's rules")
    assert "Instagram says you have 312." in ig["line"]
    assert ig["next"] is None
    x = card("x: 120 verified followers is not allowed yet (X's rules)")
    assert (x["pill"], x["knownBy"]) == ("Not allowed yet (X's rules)", "rules")
    assert "X says you have 120." in x["line"]
    ticked = card("instagram: a ticked Gifts step beats the follower rule")
    assert ticked["status"] == "not_set_up"


def test_x_premium_never_says_no() -> None:
    out = card("x: Premium never says no; x-premium as next is never the vermilion")
    assert out["next"]["stepId"] == "x-premium"
    assert out["next"]["vermilion"] is False
    assert "Premium" not in " ".join(out["seen"])  # missing is "X didn't share this", never "no Premium"
    auto = card("x: X says you have Premium ticks x-premium; apply is next")
    assert next(s for s in auto["steps"] if s["id"] == "x-premium") == {
        "id": "x-premium",
        "done": True,
        "by": "auto",
        "auto": "X says you have Premium",
    }
    assert auto["next"]["stepId"] == "x-apply"


def test_one_meta_payout_tick_is_never_you_said_done() -> None:
    for place, earn in (("instagram", "Turn on Gifts"), ("facebook", "Join a Facebook money tool")):
        out = card(f"{place}: one meta-payout tick alone is not started, never you said it's done")
        assert out["status"] == "not_started"
        assert out["line"] == f"You said Meta knows where to pay you. Next: step 1, {earn}."
    both = card("instagram: Gifts and the Meta payout ticked is you said it's done")
    assert (both["status"], both["pill"]) == ("you_said_done", "Can get paid (you said it's done)")
    assert both["line"] == "You said every step is done. Instagram doesn't tell Clip Factory, so it can't check."


def test_nothing_at_all_is_not_connected_or_not_started() -> None:
    out = card("tiktok: not connected and nothing ticked: Clip Factory can't check")
    assert (out["status"], out["pill"]) == ("not_connected", "Clip Factory can't check")
    assert out["line"] == "Clip Factory can't check anything for TikTok. You can still do the steps."
    started = card("youtube: connected, nothing ticked is not started")
    assert (started["status"], started["pill"]) == ("not_started", "Not started")


def test_youtube_in_the_program_without_payout_ticks_is_never_red() -> None:
    out = card("youtube: in the program, no payout tick and no payment reading is Not set up yet, never red")
    assert (out["status"], out["pill"], out["tone"]) == ("not_set_up", "Not set up yet", "warn")
    assert out["line"] == (
        "You can earn here. Do the payout steps so money can reach you. Next: step 2, Add your US tax info."
    )
    assert out["readingChip"] == "Clip Factory can see payments: off"
    assert out["ring"] == {"done": 1, "total": 6}  # never yt-reading


def test_needs_attention_and_closed_are_red_with_their_fix() -> None:
    needs = card("youtube: NEEDS_ATTENTION is red Not set up (YouTube says)")
    assert (needs["pill"], needs["tone"]) == ("Not set up (YouTube says)", "error")
    assert needs["line"] == "YouTube says your AdSense for YouTube needs you. Open it and do what it asks."
    closed = card("youtube: CLOSED is red Not set up (YouTube says), make a new one from Earn")
    assert closed["next"]["hint"] == "Make a new AdSense for YouTube from **Earn**."
    assert closed["next"]["href"] == "https://studio.youtube.com/"


def test_freshness() -> None:
    just = card("youtube: just allowed payment reading with every step ticked is checking, never no hold")
    assert (just["status"], just["pill"]) == ("checking", "Checking…")
    assert just["line"] == "Checking YouTube payments… This can take until tomorrow."
    assert "YouTube says there's no hold on your money." not in just["seen"]
    late = card("youtube: checking ends after 26 hours: the status comes from his ticks")
    assert late["status"] == "you_said_done"
    assert "Clip Factory couldn't check YouTube payments yet. It tries again tomorrow." in late["seen"]
    error = card("youtube: checking ends on a lastError")
    assert error["status"] == "not_set_up"
    for name in (
        "youtube: after Stop payment reading the sent payments still tick the payout steps",
        "youtube: needs a reconnect: no hold from the state, the reconnect is next",
        "youtube: a read over 48 hours old is never used",
    ):
        out = card(name)
        assert out["status"] != "on_hold", name
        assert out["holds"] == [], name
        assert "YouTube says there's no hold on your money." not in out["seen"], name
    stopped = card("youtube: after Stop payment reading the sent payments still tick the payout steps")
    assert stopped["pill"] == "Can get paid (Google sent money on 23 Oct)"
    assert stopped["line"] == "Google sent you money on 23 Oct. Clip Factory last checked YouTube payments on 21 Nov."
    reconnect = card("youtube: needs a reconnect: no hold from the state, the reconnect is next")
    assert reconnect["next"] == {
        "stepId": None,
        "label": "Allow payment reading",
        "href": "/settings/posting/getpaid/youtube#yt-reading",
        "external": False,
        "vermilion": True,
    }
    old = card("youtube: a read over 48 hours old is never used")
    assert "Clip Factory last checked YouTube payments on 18 Nov." in old["seen"]


def test_youtube_can_get_paid_only_from_a_fresh_read_and_a_sent_payment() -> None:
    out = card("youtube: fresh, ready, no hold and a sent payment is can get paid (YouTube says)")
    assert (out["status"], out["pill"], out["knownBy"]) == ("can_get_paid", "Can get paid ✓ (YouTube says)", "youtube")
    assert out["line"] == "YouTube says there's no hold. Google sent you money on 23 Oct."
    assert out["unpaid"] == {
        "text": "SEK 512.30",
        "note": "Google pays between the 21st and 26th when you have kr 700 or more.",
    }
    autos = {s["id"]: s for s in out["steps"]}
    for step_id in ("yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin"):
        assert autos[step_id]["auto"] == "Google sent you money on 23 Oct, so this is done"
    no_payment = card("youtube: fresh with no payment yet and every step ticked: YouTube says there's no hold")
    assert no_payment["line"] == (
        "You said every step is done. YouTube says there's no hold. Clip Factory knows for sure after Google's first "
        "payment."
    )


def test_content_rewards_with_whop() -> None:
    none = card("contentrewards: a fresh Whop with no saved method beats his ticks")
    assert (none["status"], none["pill"], none["tone"]) == ("not_set_up", "Not set up (Whop says)", "error")
    assert none["line"] == "Whop says it has nowhere to send your money. Next: step 2, Add your bank on Whop."
    assert none["next"]["stepId"] == "bank-setup"
    kyc = card("contentrewards: Whop says the ID check isn't started")
    assert kyc["line"] == "Whop says your ID check isn't started. Next: step 1, Set up payouts."
    pending = card("contentrewards: Whop is checking his ID")
    assert (pending["status"], pending["pill"], pending["knownBy"]) == ("checking", "Checking… (Whop says)", "whop")
    ok = card("contentrewards: Whop can get paid needs a ready method and Content Rewards linked to Whop")
    assert (ok["status"], ok["pill"]) == ("can_get_paid", "Can get paid ✓ (Whop says)")
    assert ok["line"] == "Whop says your ID check is done and a bank is saved."
    unlinked = card("contentrewards: Whop ready but not linked is Not set up yet, next Link your Whop account")
    assert (unlinked["status"], unlinked["pill"]) == ("not_set_up", "Not set up yet")
    assert unlinked["next"]["text"] == "Next: step 1, Link your Whop account."
    checked = card("contentrewards: a method still being checked is not ready")
    assert checked["status"] == "you_said_done"
    assert card("contentrewards: Whop switched off: no Whop signal at all")["status"] == "you_said_done"
    assert card("contentrewards: Connect Whop just done is checking")["line"] == (
        "Checking your Whop payouts… This can take until tomorrow."
    )


def test_content_rewards_holds_and_their_fix() -> None:
    rejected = card("contentrewards: Whop's ID check didn't pass is on hold")
    assert (rejected["pill"], rejected["line"]) == (
        "Payment on hold (Whop says)",
        "Whop says your ID check didn't pass.",
    )
    assert rejected["next"]["hint"] == "Tap **Balances**. Do the ID check again."
    broken = card("contentrewards: every saved method broken is on hold")
    assert broken["line"] == "Whop says your bank details don't work."
    assert (broken["next"]["label"], broken["next"]["hint"]) == ("Open Whop", "Check your bank on **Payout methods**.")
    failed = card("contentrewards: the last payout didn't go through is on hold")
    assert failed["line"] == "Whop says your last payout didn't go through."
    assert card("contentrewards: a canceled payout is never a hold")["status"] == "can_get_paid"
    assert card("contentrewards: an old failed payout is no hold")["status"] == "can_get_paid"


def test_content_rewards_from_ticks() -> None:
    money = card("contentrewards: money with no bank step is Not set up yet")
    assert (money["status"], money["pill"], money["tone"]) == ("not_set_up", "Not set up yet", "warn")
    question = card("contentrewards: money and no Finance answer is Not set up yet, next the Finance question")
    assert question["next"]["label"] == "Answer: do you see Finance?"
    assert question["next"]["vermilion"] is False
    # The page's own id for the question (web GetPaidPage's ``#cr-finance``), so the link brings it into view.
    assert question["next"]["href"] == "/settings/posting/getpaid/contentrewards#cr-finance"
    linked = card("contentrewards: a move to Whop ticks Link your Whop account by itself")
    assert next(s for s in linked["steps"] if s["id"] == "move-whop")["by"] == "auto"
    assert card("contentrewards: you said every step is done")["line"] == (
        "You said every step is done. Content Rewards doesn't tell Clip Factory, so it can't check."
    )


def test_every_place_and_status_is_covered() -> None:
    seen = {(c["place"], c["expect"]["status"]) for c in CARDS}
    for place in status.PLACES:
        assert (place, "not_started") in seen or place == CR, place
        assert (place, "you_said_done") in seen, place
    for st in status.STATUSES:
        assert any(s == st for _, s in seen), st
    kinds = {(c["expect"]["status"], c["expect"]["knownBy"]) for c in CARDS}
    assert ("not_set_up", "you") in kinds
    assert ("not_set_up", "youtube") in kinds
    assert ("not_set_up", "whop") in kinds


def test_the_summary() -> None:
    by = {s["name"]: s["expect"] for s in GOLDEN["summaries"]}
    assert by["the contract's example"] == "YouTube says it can pay you. You said TikTok is done. Instagram needs you."
    assert by["Whop says Content Rewards can pay you, and two places need him"] == (
        "Whop says Content Rewards can pay you. You said Instagram and Facebook are done. YouTube and X need you."
    )
    assert by["Google paid you before"] == "Google paid you before."
    assert by["nothing set up yet"] == "Nothing is set up yet. Start with YouTube."  # he can do its steps already
    assert by["nothing to do here yet"] == "Nothing to do here yet. Clip Factory tells you when a place opens."
    for s in GOLDEN["summaries"]:
        assert status.summary(s["cards"]) == s["expect"]
        assert len(s["expect"].split()) <= 30


def test_the_steps_the_server_knows() -> None:
    steps = json.loads(STEPS_FILE.read_text())
    assert list(steps) == ["youtube", "tiktok", "instagram", "facebook", "x"]
    assert [s["id"] for s in steps["youtube"]] == [
        "yt-join",
        "yt-reading",
        "yt-tax",
        "yt-bank",
        "yt-test",
        "yt-id",
        "yt-pin",
    ]
    assert {s["id"]: s["role"] for s in steps["tiktok"]} == {
        "tt-gifts": "earn",
        "tt-payout": "payout",
        "tt-withdraw": "each_time",
    }
    assert [s["id"] for s in steps["instagram"]] == ["ig-gifts", "meta-payout"]
    assert [s["id"] for s in steps["facebook"]] == ["fb-join", "meta-payout"]
    assert [(s["id"], s["role"]) for s in steps["x"]] == [
        ("x-premium", "earn"),
        ("x-apply", "earn"),
        ("x-stripe", "payout"),
    ]
    assert {s.id for s in status.STEPS[CR]} == {
        "move-whop",
        "bank-setup",
        "fin-setup",
        "move-withdraw",
        "bank-cashout",
        "fin-bank",
    }
    assert status.platform_step("yt-reading") is not None
    assert status.platform_step("yt-reading").manual is False  # type: ignore[union-attr]


def test_an_old_read_never_speaks_for_a_new_connection() -> None:
    """§40.2 freshness: after Stop and a new Allow (maybe another Google or Whop account), the old PAYSTATE# gives no
    hold, no "last checked" and no "nothing sent yet": it is checking, then "couldn't check yet"."""
    again = card("youtube: allowed again after Stop: an old read is checking, never last checked")
    assert (again["status"], again["sent"]["state"]) == ("checking", "checking")
    assert again["holds"] == []
    assert "checkedAt" not in again
    assert not any("last checked" in line for line in again["seen"])
    late = card("youtube: allowed again after Stop, 26 hours and no new read: couldn't check yet")
    assert "Clip Factory couldn't check YouTube payments yet. It tries again tomorrow." in late["seen"]
    assert late["sent"]["state"] == "error"
    paid = card("youtube: allowed again with a sent payment: Google sent money, no old last checked")
    assert paid["line"] == "Google sent you money on 23 Oct. Clip Factory can't see YouTube payments now."
    whop = card("contentrewards: Whop connected again: an old read with a hold is checking, never on hold")
    assert (whop["status"], whop["holds"]) == ("checking", [])
    failing = card("youtube: reads failing for 10 days: last checked, never no hold")
    assert "Clip Factory last checked YouTube payments on 11 Nov." in failing["seen"]
    assert failing["sent"]["state"] == "error"
    assert not any("no hold" in line for line in [failing["line"], *failing["seen"]])


def test_tiktok_in_sweden_says_the_creator_rewards_line_even_when_not_connected() -> None:
    """The TikTok row of §40.2: a not_open country gives not_started with the Creator Rewards line. It comes from
    TikTok's rules for his country, not from the connection."""
    out = card("tiktok: not connected in Sweden: the Creator Rewards line, from TikTok's rules")
    assert (out["status"], out["knownBy"], out["known"]) == ("not_started", "rules", "TikTok's rules for Sweden")
    assert out["line"] == "Creator Rewards isn't open in Sweden. Gifts might be. Next: step 1, Turn on Gifts."
    assert card("tiktok: not connected and nothing ticked: Clip Factory can't check")["status"] == "not_connected"
