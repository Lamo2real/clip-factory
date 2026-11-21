"""Checking in ``cf-prod-stats``: membership, submissions, proof, pilot reminders and money (§38.7, §38.12)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import money, poll
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
    fake.answer("get_my_balance", {"available": usd(1825), "withdrawal_pending": usd(0), "as_of": iso(NOW)})
    money.read(deps, USER, NOW + timedelta(hours=1))
    item = money.load(deps.store, USER)
    assert item["movedAt"] == iso(NOW + timedelta(hours=1))
    assert [c["text"] for c in item["celebrations"]] == ["You can move $18.25 to Whop now."]


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
