"""Your bank: one owner's read (docs/CONTRACTS.md §40.5.6, §40.5.7, §40.5.11, §40.5.13 "collect").

Offline: a fake table, a fake Secrets Manager and a fake Enable Banking. The rules under test: which strategy and days
each read uses; pages with the same parameters; the time budget's ``resume``; every end; writes conditional on the
link being connected with the ``connectedAt`` the read began with (a warm cache across a reconnect can never end the
new link); one read at a time (the lease), and Forget my bank winning over a read; only §40.5.7's attributes stored and
nothing the bank sent in any log line; nothing ever deleted; the 7-day notice; quiet first reads; and the money
Lambda calling the reader only from its daily run and its ``bank`` action.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from bankread_cases import (
    PK,
    SECRET_WORDS,
    USER,
    World,
    debit,
    salary,
    seed_link,
    txn,
    whop_payout,
    youtube_payout,
)
from clipfactory_api import bankread, money
from clipfactory_api.bankread import collect
from clipfactory_api.clock import iso
from clipfactory_api.money import collect as money_collect
from clipfactory_api.money import handler
from clipfactory_api.money.collect import MoneyDeps
from clipfactory_api.oauth.secrets import Secrets

NOW = datetime(2026, 11, 23, 6, 0, 0, tzinfo=UTC)
TODAY = NOW.date()
LINK = "a1b2c3d4e5f6"
FRESH_LINK = {"connected_at": iso(NOW - timedelta(minutes=10))}


def days_ago(n: int, today: date = TODAY) -> str:
    return (today - timedelta(days=n)).isoformat()


@pytest.fixture
def world() -> World:
    return World(NOW)


def calls(world: World) -> list[dict[str, str]]:
    return world.eb.transaction_calls


# --- which strategy and days ------------------------------------------------------------------------------------


def test_his_first_read_is_longest_from_400_days(world: World) -> None:
    world.ready(**FRESH_LINK)
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2025-12-01", payer="GOOGLE")]]
    assert world.run(psu={"ip": "203.0.113.9"}, mine=True)["result"] == "read"
    assert calls(world) == [
        {"uid": "uid-acc-1", "transaction_status": "BOOK", "date_from": days_ago(400), "strategy": "longest"}
    ]
    link = world.link()
    assert link["firstReadDone"] is True
    assert link["readThrough"] == TODAY.isoformat()
    assert link["historyFrom"] == "2025-12-01"
    assert "historyWanted" not in link
    # An unattended longest pass counts twice (the bank has no PSU headers).
    assert link["reads"]["unattendedAt"] == [iso(NOW), iso(NOW)]


def test_a_first_read_that_isnt_his_is_default_from_89_days(world: World) -> None:
    world.ready(**FRESH_LINK)
    world.run()  # the daily run
    assert calls(world) == [
        {
            "uid": "uid-acc-1",
            "transaction_status": "BOOK",
            "date_from": days_ago(89),
            "strategy": "default",
            "date_to": TODAY.isoformat(),
        }
    ]
    link = world.link()
    assert link["historyFrom"] == days_ago(89)  # nothing came back: date_from
    assert link["historyWanted"] is True  # still inside the hour: his own read could still use it


def test_afterwards_default_with_the_10_day_overlap(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20", historyWanted=None)
    world.run()
    assert calls(world)[0]["date_from"] == "2026-11-10"
    assert calls(world)[0]["strategy"] == "default"
    world2 = World(NOW)
    world2.ready(firstReadDone=True, readThrough="2026-05-01")
    world2.run()
    assert calls(world2)[0]["date_from"] == days_ago(89)  # never more than 89 days without him


def test_a_reconnect_after_a_gap_uses_longest_within_the_hour_on_his_read(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-07-01", historyWanted=True, **FRESH_LINK)
    world.run(psu={"ip": "203.0.113.9"}, mine=True)
    assert calls(world)[0]["strategy"] == "longest"
    assert calls(world)[0]["date_from"] == "2026-06-21"
    assert "historyWanted" not in world.link()
    late = World(NOW)
    late.ready(firstReadDone=True, readThrough="2026-07-01", historyWanted=True)  # connected 20 hours ago
    late.run(psu={"ip": "203.0.113.9"}, mine=True)
    assert calls(late)[0]["strategy"] == "default"
    assert calls(late)[0]["date_from"] == days_ago(89)
    assert "historyWanted" not in late.link()


def test_continuation_pages_use_the_same_parameters_and_an_empty_page_goes_on(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [
        [txn("85.00", "2026-11-11", payer="GOOGLE")],
        [],
        [txn("90.00", "2026-11-12", payer="TIKTOK")],
    ]
    world.run()
    pages = calls(world)
    assert [p.get("continuation_key") for p in pages] == [None, "k1", "k2"]
    assert {(p["date_from"], p["strategy"], p["date_to"]) for p in pages} == {("2026-11-10", "default", "2026-11-23")}
    assert len(world.deposits()) == 2


def test_the_time_budget_keeps_resume_and_the_next_run_goes_on(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20", accounts=("uid-acc-1", "uid-acc-2"))
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-11", payer="GOOGLE")], [txn("1.50", "2026-11-12")]]
    world.eb.pages["uid-acc-2"] = [[txn("90.00", "2026-11-12", payer="TIKTOK")]]
    world.ticker.after_pages = 1
    world.run()
    link = world.link()
    assert link["resume"] == {
        "account": 0,
        "strategy": "default",
        "dateFrom": "2026-11-10",
        "dateTo": "2026-11-23",
        "continuationKey": "k1",
    }
    assert link["readThrough"] == "2026-11-20"  # not finished: the overlap stays where it was
    assert len(world.deposits()) == 1  # the whole page read so far is kept
    world.ticker.after_pages = None
    world.eb.calls.clear()
    world.now = NOW + timedelta(hours=8)
    world.run()
    assert [(c["uid"], c.get("continuation_key")) for c in calls(world)] == [("uid-acc-1", "k1"), ("uid-acc-2", None)]
    assert "resume" not in world.link()
    assert world.link()["readThrough"] == "2026-11-23"
    assert len(world.deposits()) == 2


def test_a_wrong_continuation_key_on_a_resume_restarts_that_account(world: World) -> None:
    resume = {"account": 0, "strategy": "longest", "dateFrom": days_ago(400), "continuationKey": "k9"}
    world.ready(resume=resume, **FRESH_LINK)
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2025-12-01", payer="GOOGLE")]]
    world.run(psu={"ip": "203.0.113.9"}, mine=True)
    tries = calls(world)
    assert tries[0]["continuation_key"] == "k9"
    assert tries[0]["strategy"] == "longest"
    assert "continuation_key" not in tries[1]
    assert (tries[1]["strategy"], tries[1]["date_from"]) == (
        "default",
        days_ago(89),
    )
    # "Counted from" says so: never earlier than the restart's first day.
    assert world.link()["historyFrom"] == days_ago(89)
    assert world.link()["firstReadDone"] is True


def test_a_longest_resume_without_him_is_never_longest(world: World) -> None:
    resume = {"account": 0, "strategy": "longest", "dateFrom": days_ago(400), "continuationKey": "k1"}
    world.ready(resume=resume)
    world.run()
    assert calls(world)[0]["strategy"] == "default"
    assert "continuation_key" not in calls(world)[0]


# --- ends ---------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "consent", "expected"),
    [
        ("EXPIRED", "2026-11-23T10:00:00.000000+00:00", ("ended", "consent_over")),
        ("EXPIRED", "2027-05-20T10:00:00.000000+00:00", ("ended", "ended_early")),
        ("REVOKED", "2027-05-20T10:00:00.000000+00:00", ("stopped_at_bank", None)),
        ("CLOSED", "2027-05-20T10:00:00.000000+00:00", ("ended", "ended_early")),
        ("CANCELLED", "2027-05-20T10:00:00.000000+00:00", ("ended", "ended_early")),
        ("INVALID", "2027-05-20T10:00:00.000000+00:00", ("ended", "ended_early")),
    ],
)
def test_every_end_of_a_session(world: World, status: str, consent: str, expected: tuple[str, str | None]) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20", consent_until=consent)
    world.eb.sessions["sess-123"]["status"] = status
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-10-21#3456", "2026-10-21", "SEK 1,234.56"))
    world.store.put({"pk": PK, "sk": "DEPOSIT#2026-10-24#d1", "type": "deposit", "state": "matched", "depositId": "d1"})
    world.run()
    link = world.link()
    assert (link["status"], link.get("reason")) == expected
    assert link["endedAt"] == iso(NOW)
    assert calls(world) == []  # nothing is read from an ended session
    assert world.store.get(PK, "DEPOSIT#2026-10-24#d1") is not None  # an end never deletes a deposit
    notice = world.conn()["lastNotice"]
    assert notice["ended"] == [{"linkId": LINK, "bank": "Swedbank", "endedAt": iso(NOW)}]


@pytest.mark.parametrize("code", ["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION", "SESSION_DOES_NOT_EXIST"])
def test_session_error_codes_end_the_link_too(world: World, code: str) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.fail["uid-acc-1"] = [(401, code)]
    world.run()
    assert world.link()["status"] == ("stopped_at_bank" if code == "REVOKED_SESSION" else "ended")


def test_writes_are_conditional_on_connected_so_a_stop_during_a_read_wins(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]

    def stop(_uid: str) -> None:
        world.store.update(PK, f"BANKLINK#{LINK}", {"status": "stopped", "stoppedAt": iso(NOW)})

    world.eb.hook = stop
    world.run()
    link = world.link()
    assert link["status"] == "stopped"
    assert "lastReadAt" not in link
    assert link["readThrough"] == "2026-11-20"


def test_a_reconnect_during_a_read_wins(world: World) -> None:
    """The old session says EXPIRED, but the callback wrote a new ``connectedAt`` while that answer was on its way:
    the end is conditional on the ``connectedAt`` the read began with, so the new link stays connected."""
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.sessions["sess-123"]["status"] = "EXPIRED"
    fake = world.eb

    def http(request: Any) -> Any:
        if "/sessions/" in request.url:
            world.store.update(PK, f"BANKLINK#{LINK}", {"connectedAt": iso(NOW), "consentUntil": "2027-05-23"})
        return fake(request)

    world.deps.http = http
    world.run()
    assert world.link()["status"] == "connected"
    assert world.link()["connectedAt"] == iso(NOW)


def test_a_warm_secrets_cache_across_a_reconnect_never_ends_the_new_link(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    name = f"cf-prod/platforms/bank/token_{LINK}"
    world.secrets.read(name)  # warm: the old session in this container's cache
    world.eb.sessions["sess-123"]["status"] = "EXPIRED"  # the old session at Enable Banking
    new_at = iso(NOW - timedelta(minutes=5))
    world.store.update(PK, f"BANKLINK#{LINK}", {"connectedAt": new_at})
    secret = json.loads(world.sm.values[name])
    world.sm.values[name] = json.dumps({**secret, "sessionId": "sess-new", "connectedAt": new_at})
    world.eb.session("sess-new", ["uid-acc-1"])
    world.run()
    assert world.link()["status"] == "connected"
    assert world.link()["lastReadAt"] == iso(NOW)
    assert any("/sessions/sess-new" in c.url for c in world.eb.calls)
    assert not any("/sessions/sess-123" in c.url for c in world.eb.calls)


def test_a_secret_from_another_connect_is_skipped_and_changes_nothing(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20", secret_connected_at=iso(NOW))
    before = world.link()
    world.run()
    assert world.eb.calls == []
    assert world.link() == before
    assert "bank.stale_secret" in capsys.readouterr().out


# --- one read at a time, and Forget -----------------------------------------------------------------------------


def test_a_second_run_skips_while_the_lease_is_held(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.store.update(PK, "BANKCONN", {"readLease": {"until": iso(NOW + timedelta(seconds=200))}})
    assert world.run()["result"] == "busy"
    assert world.eb.calls == []
    world.store.update(PK, "BANKCONN", {"readLease": {"until": iso(NOW - timedelta(seconds=1))}})
    assert world.run()["result"] == "read"  # an expired lease is taken over
    assert "readLease" not in world.conn()  # and released at the end


def test_the_lease_is_held_during_the_read(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    seen: list[Any] = []
    world.eb.hook = lambda _uid: seen.append(world.conn().get("readLease"))
    world.run()
    assert seen == [{"until": iso(NOW + timedelta(seconds=300))}]


def test_forget_during_a_read_stops_its_writes(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]
    world.eb.hook = lambda _uid: world.store.update(PK, "BANKCONN", {"forgottenAt": iso(NOW + timedelta(seconds=1))})
    assert world.run()["result"] == "forgotten"
    assert world.deposits() == []
    link = world.link()
    assert "lastReadAt" not in link
    assert "lastNotice" not in world.conn()
    assert "lastRunAt" not in world.conn()


# --- what is stored ----------------------------------------------------------------------------------------------


def test_new_rows_their_attributes_and_ttl(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [
        [
            txn("1234.56", "2026-11-13", payer="GOOGLE IRELAND LTD", ref="E1"),
            txn("85.00", "2026-11-21", payer="Google Payment", ref="E2"),
            txn("85.00", "2026-11-22", payer="Erik Eriksson", text="youtube"),
        ]
    ]
    world.run()
    rows = {r["state"] + (r.get("hintFrom") or ""): r for r in world.deposits()}
    matched = rows["matched"]
    assert set(matched) - {"pk", "sk"} <= bankread.DEPOSIT_MATCHED_ATTRS
    assert (matched["place"], matched["how"], matched["payoutRef"], matched["payoutDate"]) == (
        "youtube",
        "payout",
        "PAYOUT#youtube#2026-11-11#3456",
        "2026-11-11",
    )
    assert (matched["amountMinor"], matched["exponent"], matched["currency"]) == (123456, 2, "SEK")
    assert matched["source"] == "enable_banking"
    assert matched["linkId"] == LINK
    assert "payerKey" not in matched
    assert matched["sk"] == f"DEPOSIT#2026-11-13#{matched['depositId']}"
    assert "ttl" not in matched
    asked = rows["needs_youpayer"]
    assert set(asked) - {"pk", "sk"} <= bankread.DEPOSIT_NEEDS_YOU_ATTRS
    assert (asked["kind"], asked["suggested"], asked["hint"], asked["shared"]) == ("place", "youtube", "youtube", False)
    assert asked["ttl"] == int(datetime(2027, 5, 22, tzinfo=UTC).timestamp())  # fetch day + 180
    assert len(asked["payerKey"]) == 32
    stranger = rows["needs_youtext"]
    assert stranger["hintFrom"] == "text"


def test_ttl_from_the_later_of_the_booking_and_fetch_days(world: World) -> None:
    assert collect._ttl("2025-11-01", NOW) == int(datetime(2027, 5, 22, tzinfo=UTC).timestamp())
    assert collect._ttl("2026-11-24", NOW) == int(datetime(2027, 5, 23, tzinfo=UTC).timestamp())


def test_a_kept_row_is_never_written_again_and_nothing_is_deleted(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]
    world.run()
    first = world.deposits()
    world.now = NOW + timedelta(days=1)
    world.run()  # the 10-day overlap reads the same row again
    assert world.deposits() == first
    assert not [c for c in world.table.calls if c[0] == "delete_item"]


def test_his_answer_during_a_run_wins(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    row = {
        "pk": PK,
        "sk": "DEPOSIT#2026-11-03#d1",
        "type": "deposit",
        "state": "needs_you",
        "depositId": "d1",
        "date": "2026-11-03",
        "amountMinor": 123456,
        "exponent": 2,
        "currency": "SEK",
        "hint": "youtube",
        "hintFrom": "payer",
        "shared": False,
        "kind": "place",
        "suggested": "youtube",
        "linkId": LINK,
        "source": "enable_banking",
        "ttl": 1_900_000_000,
    }
    world.store.put(row)
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-02#3456", "2026-11-02", "SEK 1,234.56"))
    world.eb.hook = lambda _uid: world.store.update(
        PK, "DEPOSIT#2026-11-03#d1", {"state": "matched", "place": "tiktok", "how": "you"}, remove=["ttl"]
    )
    world.run()
    stored = world.store.get(PK, "DEPOSIT#2026-11-03#d1") or {}
    assert (stored["state"], stored["place"], stored["how"]) == ("matched", "tiktok", "you")


def test_a_stored_question_matches_once_its_payout_appears(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.store.put(
        {
            "pk": PK,
            "sk": "DEPOSIT#2026-11-03#d1",
            "type": "deposit",
            "state": "needs_you",
            "depositId": "d1",
            "date": "2026-11-03",
            "amountMinor": 123456,
            "exponent": 2,
            "currency": "SEK",
            "hint": "youtube",
            "hintFrom": "payer",
            "shared": False,
            "payerKey": "f" * 32,
            "kind": "place",
            "suggested": "youtube",
            "notSure": True,
            "linkId": LINK,
            "source": "enable_banking",
            "fetchedAt": iso(NOW - timedelta(days=20)),
            "ttl": 1_900_000_000,
        }
    )
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-02#3456", "2026-11-02", "SEK 1,234.56"))
    world.run()
    stored = world.store.get(PK, "DEPOSIT#2026-11-03#d1") or {}
    assert stored["state"] == "matched"
    assert stored["payoutRef"] == "PAYOUT#youtube#2026-11-02#3456"
    assert set(stored) - {"pk", "sk"} <= bankread.DEPOSIT_MATCHED_ATTRS
    assert not {"ttl", "suggested", "kind", "hint", "notSure", "payerKey"} & set(stored)
    assert world.conn()["lastNotice"]["reached"] == [
        {"depositId": "d1", "place": "youtube", "amountMinor": 123456, "exponent": 2, "currency": "SEK"}
    ]


def test_whop_trace_code_and_a_learned_payer(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.put_payout(
        whop_payout("PAYOUT#contentrewards#2026-11-12#po_1", "2026-11-12", 40_000_000, "USD", "4F7Q-92KX-11ZP")
    )
    from bankread_cases import payer_key

    world.store.put(
        {"pk": PK, "sk": "BANKPAYERS", "type": "bankpayers", "rules": {payer_key("META PLATFORMS"): {"place": "meta"}}}
    )
    world.eb.pages["uid-acc-1"] = [
        [
            txn("411.95", "2026-11-14", payer="Bankgirot", text="TRC 4F7Q-92KX-11ZP"),
            txn("912.40", "2026-11-15", payer="META PLATFORMS"),
        ]
    ]
    world.run()
    places = sorted((d["place"], d["how"]) for d in world.deposits())
    assert places == [("contentrewards", "payout"), ("meta", "payer")]


# --- notices --------------------------------------------------------------------------------------------------


def test_the_first_read_is_quiet(world: World) -> None:
    world.ready()
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [
        [txn("1234.56", "2026-11-13", payer="GOOGLE"), txn("85.00", "2026-11-14", payer="TIKTOK")]
    ]
    world.run()
    assert all(d["quiet"] is True for d in world.deposits())
    assert len(world.deposits()) == 2
    assert "lastNotice" not in world.conn()
    assert world.conn()["lastRunAt"] == iso(NOW)


def test_last_notice_from_rows_that_arent_quiet(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    for n, day in enumerate(("2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"), 1):
        world.put_payout(youtube_payout(f"PAYOUT#youtube#{day}#000{n}", day, f"SEK {n}00.00"))
    world.eb.pages["uid-acc-1"] = [
        [
            txn("100.00", "2026-11-12", payer="GOOGLE"),
            txn("200.00", "2026-11-13", payer="GOOGLE"),
            txn("300.00", "2026-11-14", payer="GOOGLE"),
            txn("400.00", "2026-11-15", payer="GOOGLE"),
            txn("85.00", "2026-11-16", payer="TIKTOK"),
            txn("86.00", "2026-11-17", payer="X CORP"),
        ]
    ]
    world.run()
    notice = world.conn()["lastNotice"]
    assert notice["key"] == iso(NOW)
    assert [r["amountMinor"] for r in notice["reached"]] == [10000, 20000, 30000]
    assert notice["reachedMore"] == 1
    assert notice["asks"] == 2
    assert set(notice["reached"][0]) == {"depositId", "place", "amountMinor", "exponent", "currency"}


def test_nothing_to_tell_keeps_the_old_notice(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.store.update(PK, "BANKCONN", {"lastNotice": {"key": "old"}})
    world.run()
    assert world.conn()["lastNotice"] == {"key": "old"}


def test_the_7_day_notice_once_per_consent(world: World) -> None:
    until = "2026-11-29T10:00:00.000000+00:00"
    world.ready(firstReadDone=True, readThrough="2026-11-20", consent_until=until)
    world.run()
    assert world.conn()["lastNotice"]["expiring"] == [
        {"linkId": LINK, "bank": "Swedbank", "days": 7, "consentUntil": until}
    ]
    assert world.link()["warnedFor"] == until
    world.now = NOW + timedelta(days=1)
    world.run()
    assert world.conn()["lastNotice"]["key"] == iso(NOW)  # nothing new to tell
    later = World(NOW)
    later.ready(firstReadDone=True, readThrough="2026-11-20", consent_until="2026-12-10T10:00:00.000000+00:00")
    later.run()
    assert "lastNotice" not in later.conn()


# --- least data ---------------------------------------------------------------------------------------------------


def test_a_page_full_of_other_peoples_money_leaves_only_the_allowed_attributes(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20", accounts=("uid-acc-1", "uid-acc-2"))
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    noisy = [
        salary("2026-11-12"),
        debit("2026-11-12"),
        txn("1234.56", "2026-11-13", payer="GOOGLE IRELAND LTD", text="Anna Andersson SE4550000000058398257466"),
        txn("321.70", "2026-11-14", payer="STRIPE Anna Andersson", text="Storgatan 1"),
        txn("500.00", "2026-11-15", payer="Erik Eriksson", text="Swish 8123-4 Hyra december"),
        txn("85.00", "2026-11-16", payer="Anna Andersson", text="youtube SWEDSESS"),
    ]
    world.eb.pages["uid-acc-1"] = [noisy[:3], noisy[3:]]
    world.eb.pages["uid-acc-2"] = [[salary("2026-11-20")]]
    capsys.readouterr()
    world.run()
    logs = capsys.readouterr().out
    allowed = {
        "BANKCONN": bankread.BANKCONN_ATTRS,
        "BANKLINK#": bankread.BANKLINK_ATTRS,
        "DEPOSIT#": bankread.DEPOSIT_MATCHED_ATTRS | bankread.DEPOSIT_NEEDS_YOU_ATTRS,
    }
    items = [i for i in world.table.all() if i["pk"] == PK and not str(i["sk"]).startswith("PAYOUT#")]
    assert len([i for i in items if str(i["sk"]).startswith("DEPOSIT#")]) == 3
    for item in items:
        kind = next(p for p in allowed if str(item["sk"]).startswith(p))
        assert set(item) - {"pk", "sk"} <= allowed[kind], item["sk"]
        if kind == "DEPOSIT#":
            if item["state"] == "matched":
                assert set(item) - {"pk", "sk"} <= bankread.DEPOSIT_MATCHED_ATTRS
            else:
                assert set(item) - {"pk", "sk"} <= bankread.DEPOSIT_NEEDS_YOU_ATTRS
    dumped = json.dumps(items, default=str) + logs
    for word in (*SECRET_WORDS, "32100", "12000", "Anna", "Eriksson", "Storgatan", "Bearer"):
        assert word not in dumped, word
    assert world.sm.writes == []  # the reader never writes a secret
    for line in logs.splitlines():
        assert "amount" not in json.loads(line), line


def test_no_link_means_no_call_at_all(world: World) -> None:
    from bankread_cases import seed_app, seed_conn

    seed_app(world.sm)
    seed_conn(world.store)
    before = len(world.table.calls)
    assert world.run()["result"] == "no_link"
    assert world.eb.calls == []
    assert world.sm.calls == []
    assert all(c[0] == "query" for c in world.table.calls[before:])


def test_bank_reading_off_reads_nothing(world: World) -> None:
    world.ready()
    world.deps.on = False
    assert world.run()["result"] == "off"
    assert world.eb.calls == []
    assert world.table.calls == [c for c in world.table.calls if c[0] == "put_item"]


def test_two_links_and_a_paypal_move(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    seed_link(
        world.store,
        world.sm,
        world.eb,
        "f0f0f0f0f0f0",
        bank="PayPal",
        accounts=("uid-pp-1",),
        session_id="sess-pp",
        firstReadDone=True,
        readThrough="2026-11-20",
    )
    world.eb.pages["uid-acc-1"] = [[txn("1000.00", "2026-11-21", payer="PAYPAL EUROPE")]]
    world.eb.pages["uid-pp-1"] = [[txn("1000.00", "2026-11-19", currency="USD", payer="TIKTOK PTE")]]
    world.run()
    kinds = sorted((d["linkId"], d["kind"]) for d in world.deposits())
    assert kinds == [(LINK, "own_move"), ("f0f0f0f0f0f0", "place")]


# --- the money Lambda --------------------------------------------------------------------------------------------


class Env:
    def __init__(self, secrets: Secrets) -> None:
        self.secrets = secrets


class Tokens:
    def __init__(self, secrets: Secrets) -> None:
        self.env = Env(secrets)

    def credentials(self, platform: str, account: dict[str, Any]) -> Any:
        raise AssertionError("no platform is connected here")


def money_deps(world: World, **extra: Any) -> MoneyDeps:
    return MoneyDeps(
        store=world.store,
        tokens=Tokens(world.secrets),
        http=world.eb,
        clock=lambda: world.now,
        bank_reading=True,
        app_url="https://app.example.test",
        **extra,
    )


def test_the_daily_loop_reads_the_bank_and_refresh_never_does(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    money.register_owner(world.store, USER, NOW)
    deps = money_deps(world)
    seen: list[dict[str, Any]] = []
    real = collect.run

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(collect, "run", spy)
    assert handler.handle({"action": "refresh", "userId": USER}, deps)["action"] == "refresh"
    assert seen == []
    assert calls(world) == []
    assert handler.handle({"source": "aws.events"}, deps) == {"action": "daily", "owners": 1}
    assert len(seen) == 1
    assert seen[0]["psu"] is None
    assert seen[0]["mine"] is False
    assert len(calls(world)) == 1


def test_the_bank_action_reads_only_the_bank_attended_while_fresh(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    deps = money_deps(world)
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(collect, "run", lambda *a, **k: seen.append(k) or {"result": "read"})
    monkeypatch.setattr(
        money_collect, "run_platform", lambda *a, **k: pytest.fail("the bank action reads only the bank")
    )
    psu = {"ip": "203.0.113.9", "ua": "Safari", "lang": "sv-SE"}
    fresh = {"action": "bank", "userId": USER, "first": True, "psu": psu, "at": iso(NOW - timedelta(seconds=30))}
    assert handler.handle(fresh, deps) == {"action": "bank", "result": "read"}
    assert seen[-1]["psu"] == psu
    assert seen[-1]["mine"] is True
    old = {**fresh, "at": iso(NOW - timedelta(seconds=121))}
    handler.handle(old, deps)
    assert seen[-1]["psu"] is None
    assert seen[-1]["mine"] is False
    handler.handle({**fresh, "at": None}, deps)
    assert seen[-1]["mine"] is False
    assert handler.handle({"action": "bank"}, deps) == {"action": "bad_event"}


def test_an_old_check_now_on_a_first_read_is_default_from_89_days(world: World) -> None:
    world.ready(**FRESH_LINK)
    deps = money_deps(world)
    event = {
        "action": "bank",
        "userId": USER,
        "first": True,
        "psu": {"ip": "1.2.3.4"},
        "at": iso(NOW - timedelta(minutes=5)),
    }
    handler.handle(event, deps)
    assert calls(world)[0]["strategy"] == "default"
    assert calls(world)[0]["date_from"] == days_ago(89)


def test_the_bank_reader_raising_never_stops_run_user(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("bank bug")

    monkeypatch.setattr(collect, "run", boom)
    out = money_collect.run_user(money_deps(world), USER, platforms=("youtube",), bank=True)
    assert [(o.platform, o.state) for o in out] == [("youtube", "not_connected")]


def test_the_bank_waits_when_the_time_budget_is_nearly_gone(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(collect, "run", lambda *a, **k: pytest.fail("no bank read with less than 20 s left"))
    ticks = iter([0.0, 0.0, 230.0, 230.0, 230.0, 230.0])
    deps = money_deps(world, monotonic=lambda: next(ticks, 230.0))
    money_collect.run_user(deps, USER, platforms=(), bank=True)


def test_from_money_needs_secrets_and_the_switch(world: World) -> None:
    deps = money_deps(world)
    found = bankread.from_money(deps)
    assert found is not None
    assert found.on
    assert found.app_url == "https://app.example.test"
    assert bankread.from_money(MoneyDeps(store=world.store, tokens=None, http=world.eb)) is None
    off = bankread.from_money(MoneyDeps(store=world.store, tokens=Tokens(world.secrets), http=world.eb))
    assert off is not None
    assert off.on is False
    assert collect.run(MoneyDeps(store=world.store, tokens=Tokens(world.secrets), http=world.eb), USER, NOW) == {
        "result": "off"
    }


def test_the_handler_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TABLE_NAME", "cf-test-data")
    monkeypatch.setenv("BANK_READING", "on")
    monkeypatch.setenv("APP_URL", "https://app.example.test")
    monkeypatch.setenv("CONTENT_REWARDS", "on")
    monkeypatch.delenv("SECRET_PREFIX", raising=False)
    import clipfactory_api.app as app_module
    from fakes import FakeTable

    monkeypatch.setattr(app_module, "table", lambda _name: FakeTable())  # never a real table
    deps = handler._from_env()
    assert (deps.bank_reading, deps.app_url, deps.content_rewards) == (True, "https://app.example.test", True)
    monkeypatch.setenv("BANK_READING", "off")
    assert handler._from_env().bank_reading is False


# --- the API builder's golden items ---------------------------------------------------------------------------

GOLDEN_ITEMS = Path(__file__).parent / "fixtures" / "bank_items.json"
CONTRACT_ATTRS = {
    "BANKCONN": bankread.BANKCONN_ATTRS,
    "BANKLINK#": bankread.BANKLINK_ATTRS,
    "DEPOSIT#": bankread.DEPOSIT_MATCHED_ATTRS | bankread.DEPOSIT_NEEDS_YOU_ATTRS | bankread.DEPOSIT_NOT_INCOME_ATTRS,
    "BANKPAYERS": bankread.BANKPAYERS_ATTRS,
}
# A DEPOSIT# entry with a ``state`` is held to that state's attributes (the API's file has one entry per state).
DEPOSIT_BY_STATE = {
    "matched": bankread.DEPOSIT_MATCHED_ATTRS,
    "needs_you": bankread.DEPOSIT_NEEDS_YOU_ATTRS,
    "not_income": bankread.DEPOSIT_NOT_INCOME_ATTRS,
}
ITEM_KEYS = {"pk", "sk", "userId"}


def reader_writes(prefix: str, state: Any) -> frozenset[str]:
    """What the reader itself writes on that item, which the API's file must know (none on a ``not_income`` row)."""
    if prefix == "BANKCONN":
        return bankread.BANKCONN_READER_WRITES
    if prefix == "BANKLINK#":
        return bankread.BANKLINK_READER_WRITES
    if prefix == "DEPOSIT#":
        return bankread.DEPOSIT_READER_WRITES.get(state, frozenset()) if isinstance(state, str) else frozenset()
    return frozenset()


def check_items(data: Any) -> int:
    """Both sides write their item shapes from §40.5.11: every attribute an API entry names is in the contract (for a
    DEPOSIT#, its state's), and every attribute the reader writes on that item is one the entry lists. Returns how many
    entries were checked."""
    entries = data.get("items") if isinstance(data, dict) else data
    checked = 0
    for entry in entries or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("sk"), str):
            continue  # the secrets: never an item
        prefix = next((p for p in CONTRACT_ATTRS if entry["sk"].startswith(p)), None)
        if prefix is None:
            continue  # BANKOWNER: the API's alone
        state = entry.get("state")
        allowed = DEPOSIT_BY_STATE.get(state, frozenset()) if prefix == "DEPOSIT#" else CONTRACT_ATTRS[prefix]
        if prefix == "DEPOSIT#" and state is None:
            allowed = CONTRACT_ATTRS[prefix]
        assert allowed, f"{entry['sk']}: a state the contract doesn't know: {state}"
        example = entry.get("example") if isinstance(entry.get("example"), dict) else {}
        listed = {a for a in entry.get("attributes") or [] if isinstance(a, str)}
        theirs = listed | set(example)
        assert not theirs - allowed - ITEM_KEYS, f"{entry['sk']} {state}: {sorted(theirs - allowed - ITEM_KEYS)}"
        if isinstance(example.get("state"), str) and state is not None:
            assert example["state"] == state, entry["sk"]
        if listed:
            missing = reader_writes(prefix, state) - listed
            assert not missing, f"{entry['sk']} {state}: the API doesn't know {sorted(missing)}"
        checked += 1
    return checked


@pytest.mark.skipif(not GOLDEN_ITEMS.exists(), reason="bank_items.json arrives with the API builder's part (§40.5.12)")
def test_the_items_match_the_api_builders_golden_file() -> None:
    assert check_items(json.loads(GOLDEN_ITEMS.read_text())) >= 4


# The API builder's file as it is shaped: a top-level list, one DEPOSIT# entry per state, secrets without an sk.
API_SHAPED_ITEMS: list[dict[str, Any]] = [
    {"sk": "BANKOWNER", "skPattern": "^BANKOWNER$", "attributes": ["type", "userId", "claimedAt"], "example": {}},
    {
        "sk": "BANKCONN",
        "skPattern": "^BANKCONN$",
        "attributes": sorted(bankread.BANKCONN_ATTRS),
        "example": {"type": "bankconn", "app": {"status": "saved"}, "updatedAt": "2026-11-01T09:00:00.000Z"},
    },
    {
        "sk": "BANKLINK#{linkId}",
        "skPattern": "^BANKLINK#[0-9a-f]{12}$",
        "attributes": sorted(bankread.BANKLINK_ATTRS),
        "example": {"type": "banklink", "linkId": LINK, "status": "connected"},
    },
    {
        "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
        "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
        "state": "matched",
        "attributes": sorted(bankread.DEPOSIT_MATCHED_ATTRS),
        "example": {"sk": "DEPOSIT#2026-11-04#" + "a" * 32, "state": "matched", "place": "youtube", "how": "payout"},
    },
    {
        "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
        "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
        "state": "needs_you",
        "attributes": sorted(bankread.DEPOSIT_NEEDS_YOU_ATTRS),
        "example": {"sk": "DEPOSIT#2026-11-05#" + "b" * 32, "state": "needs_you", "kind": "place", "ttl": 1},
    },
    {
        "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
        "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
        "state": "not_income",
        "attributes": ["type", "state", "depositId", "date", "linkId", "why", "ttl"],
        "example": {"state": "not_income", "why": "you"},
    },
    {"sk": "BANKPAYERS", "skPattern": "^BANKPAYERS$", "attributes": sorted(bankread.BANKPAYERS_ATTRS), "example": {}},
    {"secret": "cf-prod/platforms/bank/app", "attributes": ["appId", "privateKeyPem", "hashKey"], "example": {}},
]


def test_the_api_builders_file_shape_is_checked_state_by_state() -> None:
    assert check_items(API_SHAPED_ITEMS) == 6
    # A needs_you entry listing a matched-only attribute, or a not_income one keeping the amount, is refused.
    for state, extra in (("needs_you", "payoutRef"), ("needs_you", "confirmedAt"), ("not_income", "amountMinor")):
        broken = [dict(e) for e in API_SHAPED_ITEMS]
        entry = next(e for e in broken if e.get("state") == state)
        entry["attributes"] = [*entry["attributes"], extra]
        with pytest.raises(AssertionError, match=extra):
            check_items(broken)
    # An API entry that doesn't know an attribute the reader writes is refused too.
    broken = [dict(e) for e in API_SHAPED_ITEMS]
    entry = next(e for e in broken if e.get("state") == "needs_you")
    entry["attributes"] = [a for a in entry["attributes"] if a != "quiet"]
    with pytest.raises(AssertionError, match="quiet"):
        check_items(broken)


def test_every_deposit_the_reader_writes_is_in_its_states_reader_set(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-01")
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [
        [
            txn("1234.56", "2026-11-13", payer="GOOGLE IRELAND LTD"),
            txn("85.00", "2026-11-14", payer="Erik Eriksson", text="youtube"),
            txn("321.70", "2026-11-15", payer="STRIPE PAYMENTS"),
        ]
    ]
    world.run()
    found = world.deposits()
    assert {d["state"] for d in found} == {"matched", "needs_you"}
    for item in found:
        assert set(item) - {"pk", "sk"} <= bankread.DEPOSIT_READER_WRITES[item["state"]], item["state"]
        assert set(item) - {"pk", "sk"} <= DEPOSIT_BY_STATE[item["state"]]


def test_a_session_that_shares_none_of_the_links_accounts_reads_nothing(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.sessions["sess-123"]["accounts"] = ["uid-other"]
    world.run()
    link = world.link()
    assert calls(world) == []
    assert link["lastError"] == "Swedbank didn't share one of your accounts today."
    assert link["readThrough"] == "2026-11-20"
    assert link["failingSince"] == iso(NOW)


def test_only_stopped_links_read_no_secret(world: World) -> None:
    world.ready(status="stopped", stoppedAt=iso(NOW))
    world.sm.calls.clear()
    assert world.run()["result"] == "nothing_read"
    assert world.sm.calls == []
    assert world.eb.calls == []


# --- a run that dies mid-read, and Clip Factory's own failures ----------------------------------------------------


def test_the_read_is_counted_before_the_first_transactions_call(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    seen: list[Any] = []
    world.eb.hook = lambda _uid: seen.append(world.link().get("reads"))
    world.run()
    assert seen == [{"unattendedAt": [iso(NOW)]}]


def test_a_cut_off_answer_five_runs_in_a_row_never_passes_the_rolling_three(world: World) -> None:
    """A bank without PSU headers, and every transactions answer cut off mid-body (``IncompleteRead``, which urllib
    doesn't wrap): each run has used its read, and the link says it is failing."""
    from http.client import IncompleteRead

    world.ready(firstReadDone=True, readThrough="2026-11-20")
    made = 0
    for n in range(5):
        world.now = NOW + timedelta(hours=n)
        world.eb.fail["uid-acc-1"] = [IncompleteRead(b"Anna Andersson SE4550000000058398257466")]
        before = len(calls(world))
        world.run()
        made += len(calls(world)) - before
    link = world.link()
    assert made == 3  # never more than 3 reads without him in any 24 hours
    assert len(link["reads"]["unattendedAt"]) == 3
    assert link["lastError"] == "Clip Factory looked at Swedbank 3 times in a day. It looks again later."
    assert link["failingSince"] == iso(NOW)
    assert link["readThrough"] == "2026-11-20"


def test_a_crash_of_its_own_mid_read_says_so_and_keeps_the_read_counted(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]

    def broken(self: Any, row: Any) -> Any:
        raise KeyError("Anna Andersson")

    monkeypatch.setattr(collect.Filter, "add", broken)
    capsys.readouterr()
    assert world.run()["result"] == "read"
    link = world.link()
    assert link["lastError"] == bankread.READ_FAILED.format(bank="Swedbank")
    assert link["failingSince"] == iso(NOW)
    assert link["reads"]["unattendedAt"] == [iso(NOW)]
    assert link["readThrough"] == "2026-11-20"  # nothing moves on
    assert "readLease" not in world.conn()
    logs = capsys.readouterr().out
    assert '"bank.read_failed"' in logs
    assert "Anna" not in logs


def test_a_table_error_while_writing_moves_nothing_on(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]

    def throttled(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("ProvisionedThroughputExceededException")

    monkeypatch.setattr(world.store, "put_when", throttled)
    world.run()
    link = world.link()
    assert link["lastError"] == bankread.READ_FAILED.format(bank="Swedbank")
    assert link["failingSince"] == iso(NOW)
    assert link["readThrough"] == "2026-11-20"
    assert link["reads"]["unattendedAt"] == [iso(NOW)]
    assert world.deposits() == []


def test_a_link_stopped_before_its_first_transactions_call_is_never_read(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    fake = world.eb

    def http(request: Any) -> Any:
        if "/sessions/" in request.url:
            world.store.update(PK, f"BANKLINK#{LINK}", {"status": "stopped", "stoppedAt": iso(NOW)})
        return fake(request)

    world.deps.http = http
    assert world.run()["result"] == "nothing_read"
    assert calls(world) == []
    assert "reads" not in world.link()


def test_the_money_bank_action_logs_a_failure_instead_of_raising(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("bank bug")

    monkeypatch.setattr(collect, "run", boom)
    event = {"action": "bank", "userId": USER, "at": iso(NOW)}
    assert handler.handle(event, money_deps(world)) == {"action": "bank", "result": "failed"}
    assert '"money.bank_failed"' in capsys.readouterr().out


# --- Forget my bank and the notice ------------------------------------------------------------------------------


def test_no_notice_is_written_once_forget_happened_after_the_run_began(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [[txn("1234.56", "2026-11-13", payer="GOOGLE")]]
    real = collect.Reader.expiry

    def then_forget(self: Any, links: Any) -> None:
        real(self, links)  # the deposits are written; Forget lands after the last forgottenAt check
        world.store.update(PK, "BANKCONN", {"forgottenAt": iso(NOW + timedelta(seconds=5))})

    monkeypatch.setattr(collect.Reader, "expiry", then_forget)
    world.run()
    conn = world.conn()
    assert "lastNotice" not in conn
    assert "lastRunAt" not in conn
    assert "readLease" not in conn  # its own lease is still given back


def test_no_notice_is_written_while_someone_else_holds_the_lease(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    """Our lease ran out and Forget my bank holds a new one, still under way (``forgottenAt`` not yet set)."""
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [[txn("1234.56", "2026-11-13", payer="GOOGLE")]]
    real = collect.Reader.expiry
    theirs = {"until": iso(NOW + timedelta(seconds=600))}

    def forget_starts(self: Any, links: Any) -> None:
        real(self, links)
        world.store.update(PK, "BANKCONN", {"readLease": theirs})

    monkeypatch.setattr(collect.Reader, "expiry", forget_starts)
    world.run()
    conn = world.conn()
    assert "lastNotice" not in conn
    assert conn["readLease"] == theirs  # never taken from its holder


def test_an_expired_lease_gone_meanwhile_still_gets_the_notice(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [[txn("1234.56", "2026-11-13", payer="GOOGLE")]]
    real = collect.Reader.expiry

    def another_read_came_and_went(self: Any, links: Any) -> None:
        real(self, links)
        world.store.update_expr(PK, "BANKCONN", "REMOVE readLease")

    monkeypatch.setattr(collect.Reader, "expiry", another_read_came_and_went)
    world.run()
    assert world.conn()["lastNotice"]["reached"][0]["place"] == "youtube"


# --- matching across banks --------------------------------------------------------------------------------------


def test_a_payout_picks_the_fitting_deposit_across_banks(world: World) -> None:
    """Rule 2 over every link of the run: a stranger's transfer of the exact amount, without a hint, on the link read
    first never takes YouTube's payout from the GOOGLE deposit on the other bank."""
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    seed_link(
        world.store,
        world.sm,
        world.eb,
        "f0f0f0f0f0f0",
        bank="Handelsbanken",
        accounts=("uid-hb-1",),
        session_id="sess-hb",
        firstReadDone=True,
        readThrough="2026-11-20",
    )
    world.put_payout(youtube_payout("PAYOUT#youtube#2026-11-11#3456", "2026-11-11", "SEK 1,234.56"))
    world.eb.pages["uid-acc-1"] = [[txn("1234.56", "2026-11-12", payer="Erik Eriksson")]]  # read first
    world.eb.pages["uid-hb-1"] = [[txn("1234.56", "2026-11-13", payer="GOOGLE IRELAND LTD")]]
    world.run()
    found = world.deposits()
    assert [(d["linkId"], d["state"], d.get("place"), d.get("how")) for d in found] == [
        ("f0f0f0f0f0f0", "matched", "youtube", "payout")
    ]
    assert [c["uid"] for c in calls(world)] == ["uid-acc-1", "uid-hb-1"]
    assert world.link()["readThrough"] == TODAY.isoformat()
    assert world.link("f0f0f0f0f0f0")["readThrough"] == TODAY.isoformat()


def test_a_first_read_on_one_bank_is_quiet_and_the_other_isnt(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-20")
    seed_link(
        world.store,
        world.sm,
        world.eb,
        "f0f0f0f0f0f0",
        bank="Handelsbanken",
        accounts=("uid-hb-1",),
        session_id="sess-hb",
    )
    world.eb.pages["uid-acc-1"] = [[txn("85.00", "2026-11-21", payer="TIKTOK")]]
    world.eb.pages["uid-hb-1"] = [[txn("86.00", "2026-11-21", payer="X CORP")]]
    world.run()
    quiet = {d["linkId"]: d.get("quiet", False) for d in world.deposits()}
    assert quiet == {LINK: False, "f0f0f0f0f0f0": True}
    assert world.conn()["lastNotice"]["asks"] == 1


# --- a restarted first read ---------------------------------------------------------------------------------------


def test_a_first_read_restarted_for_its_period_counts_from_the_restart(world: World) -> None:
    world.ready(**FRESH_LINK)
    world.eb.fail["uid-acc-1"] = [(422, "WRONG_TRANSACTIONS_PERIOD")]
    world.run(psu={"ip": "203.0.113.9"}, mine=True)
    tries = calls(world)
    assert [(t["strategy"], t["date_from"]) for t in tries] == [("longest", days_ago(400)), ("default", days_ago(89))]
    # Nothing came back: "Counted from" is the restart's first day, never 400 days ago.
    assert world.link()["historyFrom"] == days_ago(89)
