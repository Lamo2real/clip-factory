"""Checking in ``cf-prod-stats``: membership, submissions, proof, pilot reminders and money (§38.7, §38.12)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import config, money, poll
from clipfactory_api.stats import handler as stats_handler
from conftest import NOW, USER, Clock
from cr_support import (
    CMP,
    UUID,
    FakeCR,
    FakeInvoker,
    listed_campaign,
    make_deps,
    page,
    seed_campaign,
    seed_connection,
    tool_error,
)
from fakes import FakeSecretsManager, FakeTable

POST = "01J0000000000000000000000P"
CLIP = "01J0000000000000000000000C"
URL = "https://www.youtube.com/shorts/abcDEF12345"


def usd(v: int) -> dict[str, Any]:
    return {"currency": "usd", "value": v}


@pytest.fixture
def world() -> Any:
    clock = Clock(NOW)
    fake = FakeCR()
    deps = make_deps(db.Store(FakeTable()), FakeSecretsManager(), fake, clock, invoker=FakeInvoker())
    seed_connection(deps, USER, clock.now)
    return deps, fake, clock


def seed_sub(deps: Any, **fields: Any) -> dict[str, Any]:
    item = {
        "pk": db.user_pk(USER),
        "sk": db.crsub_sk(POST),
        "type": "crsub",
        "userId": USER,
        "postId": POST,
        "clipId": CLIP,
        "campaignId": UUID,
        "crId": CMP,
        "url": URL,
        "gen": 0,
        "key": POST,
        "platform": "youtube",
        "state": "sent",
        "postedAt": iso(NOW - timedelta(minutes=40)),
        "deadline": iso(NOW - timedelta(minutes=15)),
        "sendBy": iso(NOW - timedelta(minutes=10)),
        "sentAt": iso(NOW - timedelta(minutes=39)),
        "submissionId": "sub_1",
        "crStatus": "pending",
        **fields,
    }
    deps.store.put(item)
    return item


def sub(deps: Any) -> dict[str, Any]:
    return deps.store.get(db.user_pk(USER), db.crsub_sk(POST)) or {}


def no_money(fake: FakeCR) -> None:
    fake.answer("get_my_balance", {"available": usd(0), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    fake.answer("list_my_payouts", page([]))


# --- time only ----------------------------------------------------------------------------------------------------


def test_time_only_step(world: Any) -> None:
    deps, _fake, _clock = world
    seed_sub(deps, state="send_by_hand", submissionId=None)
    assert poll.time_only(deps, USER, NOW)["missed"] == 1
    assert sub(deps)["state"] == "missed"
    seed_sub(
        deps,
        state="sending",
        submissionId=None,
        deadline=iso(NOW - timedelta(minutes=1)),
        sendBy=iso(NOW + timedelta(minutes=4)),
        lastTryAt=iso(NOW - timedelta(minutes=4)),
    )
    poll.time_only(deps, USER, NOW)
    assert (sub(deps)["state"], sub(deps)["reason"]["code"]) == ("send_by_hand", "window_over")
    seed_sub(
        deps,
        state="sending",
        submissionId=None,
        deadline=iso(NOW - timedelta(minutes=1)),
        sendBy=iso(NOW + timedelta(minutes=4)),
        lastTryAt=iso(NOW - timedelta(minutes=1)),
    )
    poll.time_only(deps, USER, NOW)
    assert sub(deps)["state"] == "sending"  # a flow is still trying it
    seed_campaign(deps.store, USER, NOW, rulesState="reading", readStartedAt=iso(NOW - timedelta(minutes=4)))
    poll.time_only(deps, USER, NOW)
    assert (deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {})["rulesState"] == "failed"


def test_proof_due_sets_notified_once(world: Any) -> None:
    deps, _fake, _clock = world
    from clipfactory_api.contentrewards import rules

    seed_campaign(
        deps.store,
        USER,
        NOW,
        rules={
            **rules.empty(),
            "postSubmissionRules": [
                {"text": "Send proof", "afterHours": 1, "atViews": None, "where": "the brand's form"}
            ],
        },
    )
    seed_sub(deps, postedAt=iso(NOW - timedelta(minutes=30)))
    assert poll.time_only(deps, USER, NOW)["proofs"] == 0
    assert poll.time_only(deps, USER, NOW + timedelta(hours=1))["proofs"] == 1
    proof = sub(deps)["proof"]
    assert proof["notifiedAt"] == iso(NOW + timedelta(hours=1))
    assert proof["where"] == "the brand's form"
    assert poll.time_only(deps, USER, NOW + timedelta(hours=2))["proofs"] == 0


def test_pilot_reminders_every_3_days_at_most_5(world: Any) -> None:
    deps, _fake, _clock = world
    deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"pilotSentAt": iso(NOW), "canSubmit": False})
    sent = 0
    for day in range(0, 40):
        sent += poll.time_only(deps, USER, NOW + timedelta(days=day, hours=1))["pilot"]
    assert sent == 5
    conn = deps.store.get(db.user_pk(USER), db.CRCONN_SK) or {}
    assert conn["pilotReminders"] == 5


# --- membership ---------------------------------------------------------------------------------------------------


def test_membership_due_only_and_transitions(world: Any) -> None:
    deps, fake, _clock = world
    seed_campaign(
        deps.store,
        USER,
        NOW,
        membership="not_joined",
        access="open",
        lastListedAt=None,
        listed=False,
        nextCheckAt=iso(NOW - timedelta(minutes=1)),
        waitingSince=iso(NOW - timedelta(hours=1)),
    )
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    assert poll.membership(deps, USER, NOW) == {"due": 1, "changed": 1}
    item = deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert (item["membership"], item["celebrate"]) == ("in", "in")
    assert item["brief"].startswith("Clip the draft")
    assert item["rulesState"] == "reading"  # the listed brief starts a rules read
    assert deps.invoker.calls == [("read_campaign", (USER, UUID))]
    assert poll.membership(deps, USER, NOW) == {"due": 0}  # next check in 6 hours


def test_tick_order_calls_cap_and_one_owner_failing(world: Any) -> None:
    deps, fake, _clock = world
    deps.store.put({"pk": db.CROWNERS_PK, "sk": "USER#broken-owner", "type": "crowner"})
    seed_campaign(deps.store, USER, NOW, nextCheckAt=iso(NOW - timedelta(minutes=1)))
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    no_money(fake)
    seed_sub(deps)
    fake.answer(
        "list_my_submissions",
        page([{"id": "sub_1", "status": "approved", "post": {"views": 1234, "status": "active"}}]),
    )
    out = poll.run_tick(deps, NOW, 30.0)
    assert out == {"owners": 2}
    order = [t for t in fake.tool_order() if t != "send_feedback"]
    assert order.index("list_my_campaigns") < order.index("get_my_balance") < order.index("list_my_submissions")
    assert sub(deps)["state"] == "approved"
    assert sub(deps)["views"] == 1234


def test_rate_limited_ends_the_owners_tick(world: Any) -> None:
    deps, fake, _clock = world
    seed_campaign(deps.store, USER, NOW, nextCheckAt=iso(NOW - timedelta(minutes=1)))
    fake.answer("list_my_campaigns", tool_error("rate_limited", "Try again in 5 seconds."))
    report = poll.run_owner(deps, USER, NOW)
    assert report["membership"] == "cr:rate_limited"
    assert "money" not in report


# --- submissions --------------------------------------------------------------------------------------------------


def test_submission_updates(world: Any) -> None:
    deps, fake, _clock = world
    seed_sub(deps)
    fake.answer(
        "list_my_submissions",
        page(
            [
                {
                    "id": "sub_1",
                    "status": "rejected",
                    "flagged": True,
                    "deleted": False,
                    "review_comment": "Logo missing in the first seconds.",
                    "reviewed_at": iso(NOW),
                    "post": {"views": 50, "status": "deleted"},
                }
            ]
        ),
    )
    poll.submissions(deps, USER, NOW, lambda: True)
    item = sub(deps)
    assert (item["state"], item["flagged"], item["postGone"]) == ("rejected", True, True)
    assert item["reason"]["brandSaid"] == "Logo missing in the first seconds."
    deps.store.update(item["pk"], item["sk"], {"appealedAt": iso(NOW), "nextCheckAt": iso(NOW)})
    fake.answer("list_my_submissions", page([{"id": "sub_1", "status": "pending", "post": {"views": 60}}]))
    poll.submissions(deps, USER, NOW + timedelta(days=1), lambda: True)
    assert sub(deps)["state"] == "sent"  # back to pending after the appeal
    deps.store.update(item["pk"], item["sk"], {"nextCheckAt": iso(NOW)})
    fake.answer("list_my_submissions", page([]))
    fake.answer("get_my_submission", {"id": "sub_1", "status": "approved", "deleted": True, "post": {"views": 70}})
    poll.submissions(deps, USER, NOW + timedelta(days=2), lambda: True)
    assert (sub(deps)["state"], sub(deps)["removed"]) == ("approved", True)


def test_a_hand_sent_post_is_adopted_by_its_link(world: Any) -> None:
    deps, fake, _clock = world
    seed_sub(deps, state="sent_by_hand", submissionId=None, crStatus=None)
    fake.answer(
        "list_my_submissions",
        page([{"id": "sub_77", "status": "pending", "post": {"url": "https://youtu.be/abcDEF12345", "views": 9}}]),
    )
    poll.submissions(deps, USER, NOW, lambda: True)
    item = sub(deps)
    assert (item["state"], item["submissionId"], item["crStatus"]) == ("sent", "sub_77", "pending")


# --- money --------------------------------------------------------------------------------------------------------


def payout(pid: str, cents: int, status: str = "paid", sub_id: str | None = "sub_1") -> dict[str, Any]:
    return {
        "id": pid,
        "amount": usd(cents),
        "campaign": CMP,
        "status": status,
        "submission": sub_id,
        "paid_at": iso(NOW) if status == "paid" else None,
        "created_at": iso(NOW),
    }


def test_first_read_across_ticks_then_watermark(world: Any) -> None:
    deps, fake, _clock = world
    seed_sub(deps)
    seed_campaign(deps.store, USER, NOW)
    fake.answer("get_my_balance", {"available": usd(1825), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    pages = [page([payout(f"pay_{i}", 100)], more=True, cursor=f"c{i}") for i in range(8)]
    fake.answer("list_my_payouts", *pages)
    money.read(deps, USER, NOW)
    shown = money.public(deps, USER, NOW)
    assert (shown["state"], shown["paidSoFarCents"]) == ("checking", None)  # "Checking…" until the end
    fake.answer(
        "list_my_payouts",
        page([payout("pay_8", 100), payout("pay_x", 999, "reversed")]),
        page([payout("pay_p", 420, "pending")]),
    )
    money.read(deps, USER, NOW + timedelta(minutes=15))
    item = money.load(deps.store, USER)
    assert item["firstReadDone"] is True
    assert item["paidTotalCents"] == 900
    assert money.public(deps, USER, NOW)["celebrations"] == []  # old money: no celebration
    assert item["stillEarningCents"] == 420
    assert sub(deps)["earned"] == {"paidCents": 900, "pendingCents": 420}
    # the watermark: only the new paid row counts, and it celebrates once
    fake.answer("list_my_payouts", page([payout("pay_new", 421), payout("pay_0", 100)]), page([]))
    money.read(deps, USER, NOW + timedelta(hours=1))
    item = money.load(deps.store, USER)
    assert item["paidTotalCents"] == 1321
    kinds = [c["kind"] for c in item["celebrations"]]
    assert kinds == ["money_arrived"]
    assert item["celebrations"][0]["text"] == "Money from Content Rewards! $4.21 is in your balance."
    shown = money.public(deps, USER, NOW)
    assert shown["campaigns"] == [{"name": "FaZe Clips", "paidCents": 1321, "pendingCents": 0, "campaignId": UUID}]
    assert money.seen(deps, USER, item["celebrations"][0]["key"]) is True
    assert money.seen(deps, USER, "nope") is False


def test_first_money_only_from_zero(world: Any) -> None:
    deps, fake, _clock = world
    fake.answer("get_my_balance", {"available": usd(0), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    fake.answer("list_my_payouts", page([]))
    money.read(deps, USER, NOW)
    assert money.public(deps, USER, NOW)["state"] == "none_yet"
    fake.answer("list_my_payouts", page([payout("pay_1", 500)]), page([]))
    money.read(deps, USER, NOW + timedelta(hours=1))
    assert [c["kind"] for c in money.load(deps.store, USER)["celebrations"]] == ["first_money"]


def test_can_move_and_money_moved(world: Any) -> None:
    deps, fake, _clock = world
    fake.answer("list_my_payouts", page([]))
    fake.answer("get_my_balance", {"available": usd(50), "withdrawal_pending": usd(300), "as_of": iso(NOW)})
    money.read(deps, USER, NOW)
    assert money.public(deps, USER, NOW)["movedAt"] is None  # still on its way: nothing moved yet
    fake.answer("get_my_balance", {"available": usd(1825), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    money.read(deps, USER, NOW + timedelta(hours=1))
    item = money.load(deps.store, USER)
    assert item["movedAt"] == iso(NOW + timedelta(hours=1))
    assert [c["text"] for c in item["celebrations"]] == ["You can move $18.25 to Whop now."]
    # Every device sees "Money moved to Whop" from the answer, not only the one that saw it happen.
    assert money.public(deps, USER, NOW + timedelta(hours=2))["movedAt"] == iso(NOW + timedelta(hours=1))
    fake.answer("get_my_balance", {"available": usd(1825), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    money.read(deps, USER, NOW + timedelta(hours=3))
    assert money.public(deps, USER, NOW)["movedAt"] == iso(NOW + timedelta(hours=1))  # kept until the next move


def test_money_states(world: Any) -> None:
    deps, _fake, _clock = world
    deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"status": "not_connected"})
    shown = money.public(deps, USER, NOW)
    assert (shown["state"], shown["tag"]) == ("not_connected", "Content Rewards' numbers")
    deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"status": "needs_reconnect"})
    assert money.public(deps, USER, NOW)["state"] == "needs_reconnect"


# --- the stats action -----------------------------------------------------------------------------------------------


def test_the_contentrewards_stats_action(world: Any) -> None:
    deps, fake, _clock = world
    no_money(fake)
    event = {"action": "contentrewards", "userId": USER, "what": "money"}
    out = stats_handler.handle(event, _stats_deps(), cr=lambda: deps)
    assert out["action"] == "contentrewards"
    assert out["report"]["money"] == "read"
    off = stats_handler.handle(event, _stats_deps(), cr=lambda: None)
    assert off == {"action": "contentrewards", "outcome": "off"}
    bad = stats_handler.handle(
        {"action": "contentrewards", "userId": USER, "what": "everything"}, _stats_deps(), cr=lambda: deps
    )
    assert bad == {"action": "bad_event"}


def test_the_tick_runs_cr_after_the_platform_poll(world: Any) -> None:
    deps, fake, _clock = world
    no_money(fake)
    seen: list[float] = []

    def cr() -> Any:
        seen.append(1.0)
        return deps

    out = stats_handler.handle({"source": "aws.events"}, _stats_deps(), cr=cr)
    assert out["action"] == "tick"
    assert seen == [1.0]
    assert money.load(deps.store, USER).get("asOf")


def _stats_deps() -> Any:
    from clipfactory_api.platforms import make_adapters
    from clipfactory_api.stats.refresh import StatsDeps

    adapters = make_adapters()
    return StatsDeps(
        store=db.Store(FakeTable()), adapters=lambda p: adapters[p], clock=Clock(NOW), time_budget_seconds=240.0
    )


def test_typeid_is_verified_once(world: Any) -> None:
    deps, fake, _clock = world
    seed_campaign(deps.store, USER, NOW, membership="not_joined", nextCheckAt=iso(NOW - timedelta(minutes=1)))
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    poll.membership(deps, USER, NOW)
    assert (deps.store.get(db.user_pk(USER), db.CRCONN_SK) or {})["typeidVerified"] is True


# --- the review's fixes ---------------------------------------------------------------------------------------------


def test_checks_keep_working_after_the_stats_action_in_a_warm_container(world: Any) -> None:
    """Connect finish's stats action makes the cached McpClient; the ticks after it (in the same container, with
    the access token due again) still refresh: the time left is each invocation's own."""
    deps, fake, clock = world
    no_money(fake)
    event = {"action": "contentrewards", "userId": USER, "what": "money"}
    assert stats_handler.handle(event, _stats_deps(), cr=lambda: deps)["report"]["money"] == "read"
    clock.now += timedelta(minutes=15)  # the 75 s of that invocation are long over; the token is due
    deps.store.update(db.user_pk(USER), db.CRMONEY_SK, {"nextCheckAt": iso(clock.now - timedelta(minutes=1))})
    forms = len(fake.token_forms())
    started = iso(clock.now)
    tick_deps = _stats_deps()
    tick_deps.clock = clock
    stats_handler.handle({"source": "aws.events"}, tick_deps, cr=lambda: deps)
    assert len(fake.token_forms()) == forms + 1  # refreshed, not "platform_down"
    assert money.load(deps.store, USER)["updatedAt"] >= started  # the money was read again


def test_a_cleared_hold_stays_cleared(world: Any) -> None:
    deps, fake, _clock = world
    seed_campaign(
        deps.store,
        USER,
        NOW,
        held={"at": iso(NOW - timedelta(days=2)), "pending": 3},
        nextCheckAt=iso(NOW - timedelta(minutes=1)),
    )
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    poll.membership(deps, USER, NOW)
    item = deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert "held" not in item
    assert item["heldClearedAt"] == iso(NOW)


def test_a_stuck_read_is_failed_only_if_it_is_still_that_read(world: Any) -> None:
    deps, _fake, _clock = world
    seed_campaign(deps.store, USER, NOW, rulesState="reading", readStartedAt=iso(NOW - timedelta(minutes=4)))
    stale = poll.campaigns.all_for(deps.store, USER)
    newer = iso(NOW)
    deps.store.update(db.user_pk(USER), db.campaign_sk(UUID), {"readStartedAt": newer})  # a new read started
    original = poll.campaigns.all_for
    poll.campaigns.all_for = lambda *_a, **_k: stale  # type: ignore[assignment]
    try:
        assert poll.time_only(deps, USER, NOW)["failedReads"] == 0
    finally:
        poll.campaigns.all_for = original  # type: ignore[assignment]
    assert (deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {})["rulesState"] == "reading"


def test_a_money_read_never_undoes_a_seen_celebration_or_the_refresh_mark(world: Any) -> None:
    deps, fake, _clock = world
    deps.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.CRMONEY_SK,
            "type": "crmoney",
            "userId": USER,
            "firstReadDone": True,
            "paidTotalCents": 500,
            "paidMark": {"id": "pay_1", "createdAt": iso(NOW)},
            "celebrations": [{"key": "money:pay_1", "kind": "first_money", "text": "Your first money!"}],
        }
    )

    def balance(_args: dict[str, Any]) -> dict[str, Any]:  # meanwhile: the owner saw it and tapped Refresh
        assert money.seen(deps, USER, "money:pay_1")
        deps.store.update(db.user_pk(USER), db.CRMONEY_SK, {"lastManualAt": iso(NOW)})
        return {"available": usd(0), "withdrawal_pending": usd(0), "as_of": iso(NOW)}

    fake.answer("get_my_balance", balance)
    fake.answer("list_my_payouts", page([payout("pay_2", 300), payout("pay_1", 500)]), page([]))
    money.read(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert [c["key"] for c in item["celebrations"]] == ["money:pay_2"]  # the new one only
    assert item["lastManualAt"] == iso(NOW)
    assert item["paidTotalCents"] == 800


# --- paid by day (§39.2): what "All your money" adds up for Content Rewards ------------------------------------------


def paid_on(pid: str, cents: int, day: str) -> dict[str, Any]:
    return {
        "id": pid,
        "amount": usd(cents),
        "campaign": CMP,
        "status": "paid",
        "submission": None,
        "paid_at": f"{day}T10:00:00Z",
        "created_at": f"{day}T09:00:00Z",
    }


def payouts(paid_pages: list[dict[str, Any]], pending: list[dict[str, Any]] | None = None) -> Any:
    """``list_my_payouts``: the paid pages in the order they are asked for (the watermark read, then the day scan),
    and the pending list."""
    queue = list(paid_pages)

    def answer(args: dict[str, Any]) -> dict[str, Any]:
        if args.get("status") == ["pending"]:
            return page(pending or [])
        return queue.pop(0)

    return answer


def older_owner(deps: Any, **fields: Any) -> None:
    """An owner whose first read finished before ``paidByDay`` existed."""
    deps.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.CRMONEY_SK,
            "type": "crmoney",
            "userId": USER,
            "firstReadDone": True,
            "paidTotalCents": 600,
            "paidByCampaign": {CMP: 600},
            "payoutsSeen": ["pay_3", "pay_2", "pay_1"],
            "paidMark": {"id": "pay_3", "createdAt": "2026-11-03T09:00:00Z"},
            "nextCheckAt": iso(NOW - timedelta(minutes=1)),
            **fields,
        }
    )


def balance(fake: FakeCR) -> None:
    fake.answer("get_my_balance", {"available": usd(0), "withdrawal_pending": usd(0), "as_of": iso(NOW)})


def test_the_first_read_keeps_paid_money_by_day(world: Any) -> None:
    deps, fake, _clock = world
    balance(fake)
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page(
                    [paid_on("pay_3", 300, "2026-11-12"), paid_on("pay_2", 200, "2026-11-12")], more=True, cursor="c1"
                ),
                page(
                    [paid_on("pay_1", 100, "2026-11-01"), {**paid_on("pay_x", 999, "2026-11-01"), "status": "reversed"}]
                ),
            ]
        ),
    )
    money.read(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-12": 500, "2026-11-01": 100}
    assert (item["paidByDayDone"], item["paidTotalCents"]) == (True, 600)
    assert "dayScan" not in item


def test_an_older_owner_gets_one_day_scan_and_its_watermark_read_counts_once(world: Any) -> None:
    """The scan starts before that tick's watermark read: the new row goes to paidByDay through the watermark read,
    the scan adds only the rows at or older than the mark, and the paid total is never touched by the scan."""
    deps, fake, _clock = world
    older_owner(deps)
    balance(fake)
    new = paid_on("pay_new", 421, "2026-11-14")
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page([new, paid_on("pay_3", 300, "2026-11-03")], more=True, cursor="w1"),  # the watermark read
                page([new, paid_on("pay_3", 300, "2026-11-03")], more=True, cursor="s1"),  # the scan
                page([paid_on("pay_2", 200, "2026-11-02"), paid_on("pay_1", 100, "2026-10-20")]),
            ]
        ),
    )
    poll.money_step(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-14": 421, "2026-11-03": 300, "2026-11-02": 200, "2026-10-20": 100}
    assert item["paidByDayDone"] is True
    assert "dayScan" not in item
    assert item["paidTotalCents"] == 1021  # 600 + the new row, once
    assert item["paidByCampaign"] == {CMP: 1021}


def test_a_day_scan_across_two_ticks_with_a_watermark_read_between(world: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_api.contentrewards import config

    deps, fake, _clock = world
    monkeypatch.setattr(config, "PAID_PAGES_PER_TICK", 1)
    older_owner(deps)
    balance(fake)
    mark = paid_on("pay_3", 300, "2026-11-03")
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page([mark], more=True, cursor="w1"),  # tick 1: the watermark read finds nothing new
                page([mark, paid_on("pay_2", 200, "2026-11-02")], more=True, cursor="s1"),  # tick 1: the scan
            ]
        ),
    )
    poll.money_step(deps, USER, NOW)
    item = money.load(deps.store, USER)
    scan = item["dayScan"]
    assert (scan["cursor"], scan["days"], scan["passed"]) == ("s1", {"2026-11-03": 300, "2026-11-02": 200}, True)
    assert item["nextCheckAt"] == iso(NOW + timedelta(minutes=15))  # the scan goes on at the next tick
    assert "paidByDayDone" not in item
    later = NOW + timedelta(minutes=15)
    new = paid_on("pay_new", 421, "2026-11-14")
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page([new, mark], more=True, cursor="w2"),  # tick 2: the watermark read adds the new row by day
                page([paid_on("pay_1", 100, "2026-10-20")]),  # tick 2: the scan's last page
            ]
        ),
    )
    poll.money_step(deps, USER, later)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-14": 421, "2026-11-03": 300, "2026-11-02": 200, "2026-10-20": 100}
    assert item["paidByDayDone"] is True
    assert "dayScan" not in item
    assert item["paidTotalCents"] == 1021
    assert fake.calls("list_my_payouts")[-2][0] == {"status": ["paid"], "limit": 25, "cursor": "s1"}


def test_an_empty_paid_mark_needs_no_scan(world: Any) -> None:
    deps, fake, _clock = world
    older_owner(deps, paidMark={}, paidTotalCents=0, paidByCampaign={}, payoutsSeen=[])
    balance(fake)
    fake.answer("list_my_payouts", payouts([page([])]))
    poll.money_step(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert (item["paidByDay"], item["paidByDayDone"]) == ({}, True)
    assert [a for a, _h, _t in fake.calls("list_my_payouts") if a.get("status") == ["paid"]] == [
        {"status": ["paid"], "limit": 25}
    ]  # only the watermark read


def test_the_first_reads_stale_scan_restart_resets_the_days(world: Any) -> None:
    deps, fake, _clock = world
    deps.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.CRMONEY_SK,
            "type": "crmoney",
            "userId": USER,
            "scan": {"status": "running", "cursor": "old", "at": iso(NOW - timedelta(days=8))},
            "paidTotalCents": 500,
            "paidByDay": {"2026-11-01": 500},
            "payoutsSeen": ["pay_9"],
        }
    )
    balance(fake)
    fake.answer("list_my_payouts", payouts([page([paid_on("pay_1", 100, "2026-11-05")])]))
    money.read(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-05": 100}
    assert (item["paidTotalCents"], item["paidByDayDone"]) == (100, True)
    assert fake.calls("list_my_payouts")[0][0] == {"status": ["paid"], "limit": 25}  # from the top again


def test_a_newer_row_with_the_marks_own_time_is_counted_once(world: Any) -> None:
    """CR pays in rounds: a row newer than the mark (listed before it) can share its ``created_at``. The watermark
    read keeps it by day; the scan must not add it again."""
    deps, fake, _clock = world
    older_owner(deps)
    balance(fake)
    same_round = {**paid_on("pay_new", 500, "2026-11-14"), "created_at": "2026-11-03T09:00:00Z"}
    mark = paid_on("pay_3", 300, "2026-11-03")
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page([same_round, mark], more=True, cursor="w1"),  # the watermark read
                page([same_round, mark], more=True, cursor="s1"),  # the scan
                page([paid_on("pay_2", 200, "2026-11-02"), paid_on("pay_1", 100, "2026-10-20")]),
            ]
        ),
    )
    poll.money_step(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-14": 500, "2026-11-03": 300, "2026-11-02": 200, "2026-10-20": 100}
    assert (item["paidTotalCents"], item["paidByDayDone"]) == (1100, True)


def test_a_first_read_under_way_before_paid_by_day_gets_the_day_scan(world: Any) -> None:
    """Its earlier pages were added to the total but never by day: the days it keeps are dropped and the day scan
    reads every row up to the mark, so the 30 days are never short."""
    deps, fake, _clock = world
    deps.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.CRMONEY_SK,
            "type": "crmoney",
            "userId": USER,
            "scan": {
                "status": "running",
                "cursor": "c1",
                "at": iso(NOW - timedelta(hours=1)),
                "mark": {"id": "pay_3", "createdAt": "2026-11-12T09:00:00Z"},
            },
            "paidTotalCents": 300,
            "paidByCampaign": {CMP: 300},
            "payoutsSeen": ["pay_3"],
        }
    )
    balance(fake)
    fake.answer(
        "list_my_payouts",
        payouts(
            [
                page([paid_on("pay_2", 200, "2026-11-12"), paid_on("pay_1", 100, "2026-11-01")]),  # the first read
                page(  # the day scan, from the top
                    [
                        paid_on("pay_3", 300, "2026-11-12"),
                        paid_on("pay_2", 200, "2026-11-12"),
                        paid_on("pay_1", 100, "2026-11-01"),
                    ]
                ),
            ]
        ),
    )
    money.read(deps, USER, NOW)
    item = money.load(deps.store, USER)
    assert item["paidByDay"] == {"2026-11-12": 500, "2026-11-01": 100}  # pay_3 too, once
    assert (item["paidTotalCents"], item["firstReadDone"], item["paidByDayDone"]) == (600, True, True)
    assert "dayScan" not in item
    assert "scan" not in item
    paid_calls = [a for a, _h, _t in fake.calls("list_my_payouts") if a.get("status") == ["paid"]]
    assert paid_calls == [{"status": ["paid"], "limit": 25, "cursor": "c1"}, {"status": ["paid"], "limit": 25}]


def test_paid_day_is_the_utc_date() -> None:
    assert money.paid_day({"paid_at": "2026-11-12T23:30:00-05:00"}) == "2026-11-13"
    assert money.paid_day({"created_at": "2026-11-12T10:00:00Z"}) == "2026-11-12"
    assert money.paid_day({}) is None


# --- §41.5: the campaign finder's adopt hook in step 3 ------------------------------------------------------------------


def _finder_candidate(deps: Any, *, opened_ago: timedelta = timedelta(minutes=5)) -> None:
    """He opened UUID from the finder (``CRFIND.opened``) and the look kept its public copy (``CRPUBLIC/PUB#``)."""
    from clipfactory_api.contentrewards import public
    from cr_support import public_campaign

    deps.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "CRFIND",
            "type": "crfind",
            "userId": USER,
            "want": {"on": True},
            "opened": {UUID: iso(NOW - opened_ago)},
        }
    )
    deps.store.put(
        {
            "pk": "CRPUBLIC",
            "sk": f"PUB#{UUID}",
            "type": "crpubliccopy",
            "uuid": UUID,
            "public": public.strip(public_campaign(UUID, application=False)),
            "readAt": iso(NOW - timedelta(hours=2)),
        }
    )


def test_the_finder_hook_adopts_a_joined_campaign_with_one_list_call(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    deps, fake, _clock = world
    monkeypatch.setenv("CR_FINDER", "on")
    _finder_candidate(deps)
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))  # CMP is UUID's TypeID
    assert poll.membership(deps, USER, NOW) == {"due": 0, "changed": 0, "adopted": 1}  # no campaign was due
    assert len(fake.calls("list_my_campaigns")) == 1  # one more call, inside the 25
    item = deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert (item["membership"], item["celebrate"], item["addedBy"]) == ("in", "in", "finder")
    finder = deps.store.get(db.user_pk(USER), "CRFIND") or {}
    assert finder["added"] == {UUID: iso(NOW)}
    assert poll.membership(deps, USER, NOW) == {"due": 0}  # added: no candidate any more, no call
    assert len(fake.calls("list_my_campaigns")) == 1


def test_the_finder_hook_needs_a_candidate_the_sign_in_and_the_switch(
    world: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clipfactory_api.contentrewards import connection

    deps, fake, _clock = world
    monkeypatch.setenv("CR_FINDER", "on")
    assert poll.membership(deps, USER, NOW) == {"due": 0}  # no candidate: no call
    _finder_candidate(deps, opened_ago=timedelta(hours=49))
    assert poll.membership(deps, USER, NOW) == {"due": 0}  # opened more than 48 hours ago
    _finder_candidate(deps)
    monkeypatch.setenv("CR_FINDER", "off")
    assert poll.membership(deps, USER, NOW) == {"due": 0}
    monkeypatch.setenv("CR_FINDER", "on")
    connection.update(deps.store, USER, NOW, {"status": "not_connected"})
    assert poll.membership(deps, USER, NOW) == {"due": 0}
    assert fake.calls() == []
    assert deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) is None


def test_the_finder_hook_is_inside_the_owners_tick_budget(world: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    deps, fake, _clock = world
    monkeypatch.setenv("CR_FINDER", "on")
    _finder_candidate(deps)
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    report = poll.run_owner(deps, USER, NOW, deadline=0.0, clock=lambda: 1.0)  # no time (or calls) left
    assert report["membership"] == "skipped"
    assert deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) is None
    no_money(fake)
    report = poll.run_owner(deps, USER, NOW)
    assert report["membership"]["adopted"] == 1
    assert deps.mcp(USER).calls <= config.CALLS_PER_OWNER_TICK


def test_the_finder_hook_never_adds_an_ambiguous_campaign(world: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_api.contentrewards import connection, ids

    deps, fake, _clock = world
    monkeypatch.setenv("CR_FINDER", "on")
    connection.update(deps.store, USER, NOW, {"typeidVerified": False})
    _finder_candidate(deps)
    twins = [
        listed_campaign(ids.typeid("cmp", f"00000000-0000-4000-8000-00000000000{n}"), access="open", platforms=None)
        for n in (1, 2)
    ]
    fake.answer("list_my_campaigns", page(twins))
    assert poll.membership(deps, USER, NOW) == {"due": 0, "changed": 0, "adopted": 0}
    assert deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) is None
