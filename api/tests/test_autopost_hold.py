"""Throw away holds the clip at the tap (docs/CONTRACTS.md §46.2, §46.5, §46.7, §46.9, §46.13; tests §46.15).

The Review card's Throw away only sends its decline when Undo's 8 s toast ends; ``POST /v1/clips/{clipId}/hold`` puts a
60 s hold on the clip the moment it is tapped, so no auto-posting run sends it in that gap, and ``DELETE`` (Undo)
lifts it. Upload by hand ignores the hold. Offline: in-memory items and the fake Lambda client only.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from autopost_support import PK, SLOT, clip_of, deps, post_count, ready, review_clip, run_item, turn_on
from clipfactory_api import db, posts, uploads
from clipfactory_api.app import App
from clipfactory_api.autopost import pick, run
from clipfactory_api.clock import iso
from conftest import NOW, OTHER, USER, Call, Clock, seed_clip
from fakes import FakeLambda, FakeS3, FakeTable

RUN_ID = f"{iso(SLOT)}#scheduled"
ALREADY_DECIDED = "This clip has already been uploaded or thrown away."
AUTO_SENT = "Auto-posting already sent this clip."
THROWN_AWAY = "You threw it away first."


def hold(call: Call, clip_id: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/hold", body, **kw)


def undo(call: Call, clip_id: str, **kw: Any) -> tuple[int, Any]:
    return call("DELETE", f"/v1/clips/{clip_id}/hold", **kw)


def tick(app: App, slot: Any = SLOT) -> run.Outcome:
    return run.run_once(deps(app), USER, "scheduled", slot)


def outcomes(store: db.Store, run_id: str = RUN_ID) -> list[tuple[str, str, str | None]]:
    item = run_item(store, run_id)
    assert item is not None
    return [(c["clipId"], c.get("outcome", ""), c.get("reason")) for c in item["clips"]]


def held_until(table: FakeTable, clip_id: str) -> Any:
    raw = table.raw(PK, db.clip_sk(clip_id))
    assert raw is not None
    return raw.get("holdUntil")


# --- the routes (§46.9) ---------------------------------------------------------------------------------------------


def test_hold_puts_a_60_second_hold_and_undo_lifts_it(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = review_clip(store, s3_client)
    status, body = hold(call, clip["clipId"])  # no body at all
    assert status == 200
    assert body["clip"]["clipId"] == clip["clipId"]
    assert body["clip"]["status"] == "review"
    assert "holdUntil" not in body["clip"]
    assert held_until(table, clip["clipId"]) == iso(NOW + timedelta(seconds=60))
    assert hold(call, clip["clipId"], {})[0] == 200  # an empty body is fine too
    assert "holdUntil" not in call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]
    assert all("holdUntil" not in c for c in call("GET", "/v1/clips")[1]["clips"])
    assert undo(call, clip["clipId"]) == (204, None)
    assert held_until(table, clip["clipId"]) is None
    assert undo(call, clip["clipId"]) == (204, None)  # safe to repeat
    assert clip_of(store, clip["clipId"])["status"] == "review"


def test_hold_refuses_unknown_keys_and_other_owners_clips(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = review_clip(store)
    status, body = hold(call, clip["clipId"], {"seconds": 600})
    assert (status, body["error"]["message"]) == (400, "Unknown field: seconds.")
    assert held_until(table, clip["clipId"]) is None
    assert hold(call, clip["clipId"], sub=OTHER)[0] == 404
    assert undo(call, clip["clipId"], sub=OTHER)[0] == 404
    assert hold(call, "01JZZZZZZZZZZZZZZZZZZZZZZZ")[0] == 404
    assert undo(call, "not-a-clip")[0] == 404
    assert held_until(table, clip["clipId"]) is None


def test_hold_on_a_clip_no_longer_in_review_says_why(
    app: App, call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    declined = seed_clip(store, status="declined")
    by_hand = review_clip(store, s3_client, made="2026-11-15T10:00:00.000Z")
    assert call("POST", f"/v1/clips/{by_hand['clipId']}/confirm", {"platforms": ["youtube"]})[0] == 200
    auto = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    clock.now = SLOT + timedelta(seconds=5)
    assert tick(app).result == "ran"
    assert clip_of(store, auto["clipId"])["autoRun"] == RUN_ID
    for clip, message in ((declined, ALREADY_DECIDED), (by_hand, ALREADY_DECIDED), (auto, AUTO_SENT)):
        status, body = hold(call, clip["clipId"])
        assert (status, body["error"]["message"]) == (409, message)
        assert held_until(table, clip["clipId"]) is None
        # Undo never fails because the clip moved on.
        assert undo(call, clip["clipId"]) == (204, None)


# --- the pick (§46.5) -----------------------------------------------------------------------------------------------


def test_a_held_clip_is_skipped_and_the_next_one_takes_its_turn(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    second = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    assert hold(call, first["clipId"])[0] == 200
    found = pick.pick(app, USER, clock())
    assert ([t.clip["clipId"] for t in found.taken], found.waiting) == ([second["clipId"]], [])
    body = call("GET", "/v1/autopost")[1]
    assert ([u["clipId"] for u in body["nextUp"]], body["waiting"]) == ([second["clipId"]], [])
    # Undo lifts the hold: it is first in line again.
    assert undo(call, first["clipId"])[0] == 204
    assert [t.clip["clipId"] for t in pick.pick(app, USER, clock()).taken] == [first["clipId"], second["clipId"]]
    # A hold whose decline never came (the page closed) ends by itself after 60 s.
    assert hold(call, first["clipId"])[0] == 200
    clock.now = NOW + timedelta(seconds=59)
    assert [t.clip["clipId"] for t in pick.pick(app, USER, clock()).taken] == [second["clipId"]]
    clock.now = NOW + timedelta(seconds=60, milliseconds=1)
    assert [t.clip["clipId"] for t in pick.pick(app, USER, clock()).taken] == [first["clipId"], second["clipId"]]


def test_a_run_during_the_undo_toast_sends_the_next_clip(
    app: App, call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    turn_on(store)
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    second = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    clock.now = SLOT  # Throw away tapped at 13:00:00; the tick comes 2 s later, inside the 8 s toast
    assert hold(call, first["clipId"])[0] == 200
    clock.now = SLOT + timedelta(seconds=2)
    assert tick(app).result == "ran"
    assert outcomes(store) == [(second["clipId"], "sent", None)]
    assert (clip_of(store, first["clipId"])["status"], post_count(table, first["clipId"])) == ("review", 0)
    # The toast ends: the decline goes.
    clock.now = SLOT + timedelta(seconds=8)
    assert call("POST", f"/v1/clips/{first['clipId']}/decline")[0] == 200
    assert clip_of(store, first["clipId"])["status"] == "declined"
    assert list(lambda_client.started) == [f"clip-{second['clipId']}-1"]


def test_a_private_test_run_never_takes_a_held_clip(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ready(store, "youtube")
    clip = review_clip(store, s3_client)
    assert hold(call, clip["clipId"])[0] == 200
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert (status, body["run"]["note"], body["run"]["clips"]) == (200, "Nothing in Review to test with.", [])
    assert clip_of(store, clip["clipId"])["status"] == "review"


# --- the run's write (§46.7) ----------------------------------------------------------------------------------------


def crashed_run(app: App, monkeypatch: pytest.MonkeyPatch) -> None:
    """A run that planned and claimed, then stopped before sending anything."""

    def crash(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("the Lambda stopped")

    with monkeypatch.context() as m:
        m.setattr(uploads, "upload_review_clip", crash)
        with pytest.raises(RuntimeError):
            tick(app)


def test_a_hold_after_the_run_planned_skips_the_clip(
    app: App,
    call: Call,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    clock: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    clock.now = SLOT + timedelta(seconds=5)
    crashed_run(app, monkeypatch)
    assert hold(call, clip["clipId"])[0] == 200  # Throw away between the plan and the send
    clock.now = SLOT + timedelta(seconds=7)
    real = posts.create_for_clip
    writes: list[str] = []

    def counted(*args: Any, **kwargs: Any) -> Any:
        writes.append("x")
        return real(*args, **kwargs)

    monkeypatch.setattr(posts, "create_for_clip", counted)
    assert tick(app).result == "ran"  # the retry resumes the plan
    assert writes == []  # it sees the hold and never even tries
    assert outcomes(store) == [(clip["clipId"], "skipped", THROWN_AWAY)]
    assert (clip_of(store, clip["clipId"])["status"], post_count(table, clip["clipId"])) == ("review", 0)
    assert "autoRun" not in clip_of(store, clip["clipId"])
    assert lambda_client.calls == []


def test_a_hold_at_the_same_instant_as_the_runs_write_wins(
    app: App,
    call: Call,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    clock: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube", "facebook")
    turn_on(store)
    clip = review_clip(store, s3_client)
    clock.now = SLOT + timedelta(seconds=5)
    real = posts.create_for_clip
    tapped: list[bool] = []

    def held_first(*args: Any, **kwargs: Any) -> Any:
        if not tapped:
            tapped.append(True)
            assert hold(call, clip["clipId"])[0] == 200  # lands after the run read the clip, before its write
        return real(*args, **kwargs)

    monkeypatch.setattr(posts, "create_for_clip", held_first)
    assert tick(app).result == "ran"
    assert outcomes(store) == [(clip["clipId"], "skipped", THROWN_AWAY)]
    assert (clip_of(store, clip["clipId"])["status"], post_count(table, clip["clipId"])) == ("review", 0)
    assert lambda_client.calls == []


def test_a_hold_that_ended_no_longer_stops_the_run(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    clock.now = SLOT - timedelta(seconds=61)
    assert hold(call, clip["clipId"])[0] == 200
    clock.now = SLOT + timedelta(seconds=5)
    assert tick(app).result == "ran"
    assert outcomes(store) == [(clip["clipId"], "sent", None)]


def test_upload_by_hand_ignores_the_hold(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ready(store, "youtube")
    clip = review_clip(store, s3_client)
    assert hold(call, clip["clipId"])[0] == 200
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube"]})
    assert (status, body["clip"]["status"]) == (200, "confirmed")
    assert "autoRun" not in clip_of(store, clip["clipId"])


def test_the_extra_condition_never_reuses_the_updates_own_placeholders() -> None:
    request = db.update_request(
        PK, "CLIP#x", {"a": 1}, also=db.Condition("attribute_not_exists(#h) OR #h < :n", {"#h": "h"}, {":n": "t"})
    )
    assert request["ConditionExpression"] == "attribute_exists(pk) AND (attribute_not_exists(#h) OR #h < :n)"
    assert (request["ExpressionAttributeNames"]["#h"], request["ExpressionAttributeValues"][":n"]) == ("h", "t")
    with pytest.raises(ValueError, match="clash"):
        db.update_request(PK, "CLIP#x", {"a": 1}, also=db.Condition("#s0 = :s0", {"#s0": "b"}, {":s0": 2}))
