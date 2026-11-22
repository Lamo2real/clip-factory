"""One auto-posting run (docs/CONTRACTS.md §46.5 to §46.7, §46.11; tests §46.15 ``test_autopost_run.py``).

Which clips and in what order, why a clip waits, the places (TikTok never) and My settings' options, the notes, off
and not due, and never twice: the same event twice, two overlapping invocations, a crash after the claim and its
retry. Offline: in-memory items and the fake Lambda client only.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from autopost_support import (
    PK,
    SLOT,
    clip_of,
    deps,
    flow_starts,
    post_count,
    posts_of,
    ready,
    review_clip,
    run_item,
    state,
    turn_on,
)
from clipfactory_api import db, post_preset, posts, release, settings, uploads
from clipfactory_api.app import App
from clipfactory_api.autopost import handler, pick, run, schedule
from clipfactory_api.clock import iso
from conftest import NOW, OTHER, USER, Call, Clock, seed_clip, seed_job
from fakes import FakeLambda, FakeS3, FakeTable
from test_campaign_posting import CAMPAIGN, CAMPAIGN_OPTIONS, FITS, campaign_clip, put_campaign, put_crconn

RUN_ID = f"{iso(SLOT)}#scheduled"


@pytest.fixture
def at_slot(clock: Clock) -> Clock:
    clock.now = SLOT + timedelta(seconds=5)
    return clock


@pytest.fixture
def cr_on(app: App, secrets_client: Any, clock: Clock) -> Any:
    """Content Rewards switched on (its deps exist); its fake fails any call: the fit reads stored items only."""
    from cr_support import FakeCR, make_deps

    found = make_deps(app.store, secrets_client, FakeCR(), clock)
    app.contentrewards = found
    return found


def tick(app: App, slot: Any = SLOT, user: str = USER, **kw: Any) -> run.Outcome:
    return run.run_once(deps(app, **kw), user, "scheduled", slot)


def outcomes(store: db.Store, run_id: str = RUN_ID) -> list[tuple[str, str, str | None]]:
    item = run_item(store, run_id)
    assert item is not None
    return [(c["clipId"], c.get("outcome", ""), c.get("reason")) for c in item["clips"]]


# --- which clips, in what order ------------------------------------------------------------------------------------


def test_oldest_first_by_job_then_rank_then_clip(app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock) -> None:
    ready(store, "youtube")
    turn_on(store, per_run=5)
    old_job = seed_job(store, status="ready", createdAt="2026-11-15T08:00:00.000Z")
    second = review_clip(store, s3_client, job=old_job, rank=2)
    best = review_clip(store, s3_client, job=old_job, rank=1)
    newer = review_clip(store, s3_client, made="2026-11-15T10:00:00.000Z", rank=1)
    # Its job is gone: the clip's own createdAt counts.
    orphan = seed_clip(store, s3_client, createdAt="2026-11-15T07:00:00.000Z")
    assert tick(app).result == "ran"
    assert [c for c, *_ in outcomes(store)] == [orphan["clipId"], best["clipId"], second["clipId"], newer["clipId"]]
    assert {o for _, o, _ in outcomes(store)} == {"sent"}


def test_per_run_sends_that_many_and_the_rest_go_next_run(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    turn_on(store, per_run=2, every=3)
    clips = [review_clip(store, s3_client, made=f"2026-11-15T0{n}:00:00.000Z") for n in range(1, 4)]
    tick(app)
    assert [clip_of(store, c["clipId"])["status"] for c in clips] == ["confirmed", "confirmed", "review"]
    assert state(store)["lastRunAt"] == iso(SLOT)
    assert tick(app, SLOT + timedelta(hours=1)).result == "not_due"
    at_slot.now = SLOT + timedelta(hours=3, seconds=5)
    assert tick(app, SLOT + timedelta(hours=3)).result == "ran"
    assert clip_of(store, clips[2]["clipId"])["status"] == "confirmed"
    assert len(flow_starts(lambda_client)) == 3


@pytest.mark.parametrize(
    ("job", "fields", "reason"),
    [
        ({"status": "running"}, {}, "It is still being made."),
        ({"status": "ready"}, {"videoKey": None}, "Its video is missing."),
        (
            {"status": "ready"},
            {"checklist": {"items": [{"key": "payoff", "label": "The payoff lands", "pass": False}], "fixes": []}},
            "A check didn't pass: The payoff lands.",
        ),
        (
            {"status": "ready"},
            {"checklist": {"items": [{"key": "campaign_rules", "label": "Campaign rules", "pass": False}]}},
            "A check didn't pass: Campaign rules.",
        ),
    ],
)
def test_each_waiting_rule_and_its_sentence(
    app: App, store: db.Store, at_slot: Clock, job: dict[str, Any], fields: dict[str, Any], reason: str
) -> None:
    ready(store, "youtube")
    turn_on(store)
    made = seed_job(store, **job)
    clip = seed_clip(store, job_id=made["jobId"], **{k: v for k, v in fields.items() if v is not None})
    if fields.get("videoKey", "") is None:
        store.update(PK, db.clip_sk(clip["clipId"]), {"hook": clip["hook"]}, remove=["videoKey"])
    found = pick.pick(app, USER, at_slot())
    assert [(w.clip["clipId"], w.reason) for w in found.waiting] == [(clip["clipId"], reason)]
    assert found.taken == []
    assert tick(app).result == "ran"
    item = run_item(store, RUN_ID)
    assert item is not None
    assert (item["note"], item["clips"]) == ("Every clip in Review is waiting for you.", [])
    assert clip_of(store, clip["clipId"])["status"] == "review"
    assert state(store)["lastRunAt"] == iso(SLOT)


def test_a_check_that_is_not_important_never_holds_a_clip(app: App, store: db.Store, at_slot: Clock) -> None:
    ready(store, "youtube")
    clip = review_clip(store, checklist={"items": [{"key": "length", "label": "Length", "pass": False}]})
    assert [t.clip["clipId"] for t in pick.pick(app, USER, at_slot()).taken] == [clip["clipId"]]


# --- campaign clips (§46.5 rule 4) ----------------------------------------------------------------------------------


def test_a_campaign_clip_waits_while_content_rewards_is_off(app: App, store: db.Store, at_slot: Clock) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store)
    put_crconn(store)
    clip = campaign_clip(store, checklist=FITS)
    found = pick.pick(app, USER, at_slot())
    assert [w.reason for w in found.waiting] == [
        "It's for a campaign, and Content Rewards can't take clips from Clip Factory by itself yet."
    ]
    assert found.waiting[0].clip["clipId"] == clip["clipId"]


@pytest.mark.parametrize(
    ("crconn", "campaign", "clip", "reason"),
    [
        (
            {"status": "read_only"},
            {},
            {},
            "It's for a campaign, and Content Rewards can't take clips from Clip Factory by itself yet.",
        ),
        (None, {}, {}, "It's for a campaign, and Content Rewards can't take clips from Clip Factory by itself yet."),
        ({}, {"membership": "manual"}, {}, "It's for a campaign you send by hand."),
        ({}, {"state": "paused"}, {}, "The brand paused this campaign. I'll tell you when it opens again."),
        ({}, {"membership": "waiting"}, {}, "The brand hasn't let you in yet. I'll tell you when you're in."),
        (
            {},
            {},
            {"durationSec": 75.0},
            "This clip can't earn on FaZe Clips: This clip is 75 seconds. FaZe Clips takes 15 to 60 seconds.",
        ),
    ],
)
def test_a_campaign_clip_waits_with_its_reason(
    app: App,
    store: db.Store,
    at_slot: Clock,
    cr_on: Any,
    crconn: dict[str, Any] | None,
    campaign: dict[str, Any],
    clip: dict[str, Any],
    reason: str,
) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store, **campaign)
    if crconn is not None:
        put_crconn(store, **crconn)
    made = campaign_clip(store, checklist=FITS, **clip)
    found = pick.pick(app, USER, at_slot())
    assert [(w.clip["clipId"], w.reason) for w in found.waiting] == [(made["clipId"], reason)]


def test_a_campaign_clip_with_none_of_its_places_set_up_waits_with_the_refusal(
    app: App, store: db.Store, at_slot: Clock, cr_on: Any
) -> None:
    ready(store, "facebook")
    put_campaign(store)
    put_crconn(store)
    campaign_clip(store, checklist=FITS)
    found = pick.pick(app, USER, at_slot())
    assert [w.reason for w in found.waiting] == [
        "This campaign doesn't pay for Facebook. Turn it off, then tap Upload."
    ]


def test_a_campaign_clip_goes_the_campaign_way_once_content_rewards_can_take_it(
    app: App, store: db.Store, table: FakeTable, at_slot: Clock, cr_on: Any, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube", "instagram", "facebook")
    put_campaign(store)
    put_crconn(store)
    turn_on(store, youtubePrivacy="private")
    clip = campaign_clip(store, checklist=FITS)
    assert tick(app).result == "ran"
    assert outcomes(store) == [(clip["clipId"], "sent", None)]
    found = posts_of(table, clip["clipId"])
    assert set(found) == {"youtube", "instagram"}  # the places the campaign pays for, minus none refused
    assert {p["campaignId"] for p in found.values()} == {CAMPAIGN}
    assert found["youtube"]["postOptions"]["campaign"] == CAMPAIGN_OPTIONS
    # Campaign clips are public and never made for kids, whatever My settings say (§38.14).
    assert (found["youtube"]["postOptions"]["privacy"], found["youtube"]["postOptions"]["madeForKids"]) == (
        "public",
        False,
    )
    assert clip_of(store, clip["clipId"])["uploadTo"] == ["youtube", "instagram"]
    assert flow_starts(lambda_client) == [f"clip-{clip['clipId']}-1"]


# --- places and options (§46.6) -------------------------------------------------------------------------------------


def test_tiktok_is_never_a_place_even_when_ready(
    app: App, store: db.Store, table: FakeTable, at_slot: Clock, s3_client: FakeS3
) -> None:
    ready(store, "youtube", "tiktok", "instagram", "facebook", "x", audit="ok")
    turn_on(store)
    clip = review_clip(store, s3_client)
    found = pick.pick(app, USER, at_slot())
    assert found.places == ["youtube", "instagram", "facebook", "x"]
    assert pick.left_out(found.places) == [{"platform": "tiktok", "reason": "tiktok_yourself"}]
    tick(app)
    assert set(posts_of(table, clip["clipId"])) == {"youtube", "instagram", "facebook", "x"}
    assert clip_of(store, clip["clipId"])["uploadTo"] == ["youtube", "instagram", "facebook", "x"]


def test_x_only_when_it_is_set_up(app: App, store: db.Store, table: FakeTable, at_slot: Clock) -> None:
    ready(store, "youtube", "facebook")
    turn_on(store)
    clip = review_clip(store)
    assert pick.pick(app, USER, at_slot()).places == ["youtube", "facebook"]
    assert pick.left_out(["youtube", "facebook"]) == [
        {"platform": "tiktok", "reason": "tiktok_yourself"},
        {"platform": "instagram", "reason": "not_set_up"},
        {"platform": "x", "reason": "not_set_up"},
    ]
    tick(app)
    assert set(posts_of(table, clip["clipId"])) == {"youtube", "facebook"}


def test_nothing_set_up_posts_nothing_but_the_run_counts(
    app: App, store: db.Store, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    turn_on(store)
    clip = review_clip(store)
    assert tick(app).result == "ran"
    item = run_item(store, RUN_ID)
    assert item is not None
    assert (item["state"], item["note"], item["clips"]) == ("done", "Nothing is set up to post to.", [])
    assert clip_of(store, clip["clipId"])["status"] == "review"
    assert state(store)["lastRunAt"] == iso(SLOT)
    assert flow_starts(lambda_client) == []


def test_my_settings_options_go_with_each_place_and_never_made_for_kids(
    app: App, store: db.Store, table: FakeTable, at_slot: Clock
) -> None:
    ready(store, "youtube", "instagram", "facebook", "x")
    preset = {
        "youtube": {"category": "24", "notifySubscribers": False, "embeddable": False},
        "instagram": {"shareToFeed": False},
        "x": {"replies": "following"},
    }
    turn_on(store, youtubePrivacy="unlisted", postPreset=post_preset.check(preset))
    clip = review_clip(store)
    tick(app)
    found = posts_of(table, clip["clipId"])
    assert found["youtube"]["postOptions"] == {
        "privacy": "unlisted",
        "category": "24",
        "madeForKids": False,
        "notifySubscribers": False,
        "embeddable": False,
    }
    assert found["instagram"]["postOptions"] == {"shareToFeed": False}
    assert found["x"]["postOptions"] == {"replies": "following"}
    assert "postOptions" not in found["facebook"]  # Facebook has nothing to pick
    # The captions are the clip's stored ones.
    assert clip_of(store, clip["clipId"])["captions"] == {k: str(v) for k, v in clip["captions"].items()}


def test_upload_options_are_only_for_the_places_going() -> None:
    settings = {"youtubePrivacy": "public", "postPreset": post_preset.defaults()}
    assert post_preset.upload_options(settings, ["facebook"]) == {}
    assert post_preset.upload_options(settings, ["tiktok"]) == {}
    out = post_preset.upload_options(settings, ["youtube", "x"])
    assert out == {
        "youtube": {
            "privacy": "public",
            "category": "20",
            "madeForKids": False,
            "notifySubscribers": True,
            "embeddable": True,
        },
        "x": {"replies": "everyone"},
    }
    # A bad stored preset reads the defaults; made for kids is never true.
    bad = {"youtubePrivacy": "everyone", "postPreset": {"youtube": {"madeForKids": True}}}
    assert post_preset.upload_options(bad, ["youtube"])["youtube"]["madeForKids"] is False
    assert post_preset.upload_options(bad, ["youtube"])["youtube"]["privacy"] == "public"


# --- notes, off and not due -----------------------------------------------------------------------------------------


def test_nothing_in_review_does_nothing_but_moves_last_run(
    app: App, store: db.Store, table: FakeTable, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    turn_on(store)
    seed_clip(store, status="posted")
    before = {k: v for k, v in table.items.items() if not k[1].startswith(("AUTORUN#", "AUTOPOST"))}
    assert tick(app).result == "ran"
    after = {k: v for k, v in table.items.items() if not k[1].startswith(("AUTORUN#", "AUTOPOST"))}
    assert after == before
    item = run_item(store, RUN_ID)
    assert item is not None
    assert (item["note"], item["mode"], item["kind"], item["at"]) == (
        "Nothing in Review, so nothing posted.",
        "live",
        "scheduled",
        iso(SLOT),
    )
    assert item["ttl"] == int((at_slot() + timedelta(days=180)).timestamp())
    assert state(store) == {
        "pk": PK,
        "sk": "AUTOPOST",
        "type": "autopost",
        "lastRunAt": iso(SLOT),
        "lastRunId": RUN_ID,
    }
    assert lambda_client.calls == []


def test_off_does_nothing(app: App, store: db.Store, table: FakeTable, at_slot: Clock) -> None:
    ready(store, "youtube")
    turn_on(store, on=False)
    review_clip(store)
    before = table.all()
    assert tick(app).result == "off"
    assert table.all() == before


def test_not_due_does_nothing_but_mark_the_tick(app: App, store: db.Store, table: FakeTable, clock: Clock) -> None:
    ready(store, "youtube")
    turn_on(store)  # on at 12:00: the 12:00 tick is not due, 13:00 is
    review_clip(store)
    before = table.all()
    assert tick(app, NOW).result == "not_due"
    # Only the tick's own mark (§46.4): this slot was looked at, so the page stops showing it as the next run.
    assert [i for i in table.all() if i not in before] == [
        {"pk": PK, "sk": "AUTOPOST", "type": "autopost", "lastTickAt": iso(NOW)}
    ]
    assert all(i in table.all() for i in before)
    assert run_item(store, f"{iso(NOW)}#scheduled") is None
    # A later not-due tick moves the mark and keeps the rest of the item.
    store.update(PK, "AUTOPOST", {"lastNowAt": iso(NOW)})
    assert tick(app, NOW).result == "not_due"
    assert state(store) == {
        "pk": PK,
        "sk": "AUTOPOST",
        "type": "autopost",
        "lastTickAt": iso(NOW),
        "lastNowAt": iso(NOW),
    }


# --- never twice ----------------------------------------------------------------------------------------------------


def two_clips(store: db.Store, s3_client: FakeS3) -> list[dict[str, Any]]:
    ready(store, "youtube", "instagram", "facebook")
    turn_on(store, per_run=2)
    return [review_clip(store, s3_client, made=f"2026-11-15T0{n}:00:00.000Z") for n in (1, 2)]


def assert_once(table: FakeTable, lambda_client: FakeLambda, clips: list[dict[str, Any]]) -> None:
    for clip in clips:
        assert post_count(table, clip["clipId"]) == 3
    assert sorted(flow_starts(lambda_client)) == sorted(f"clip-{c['clipId']}-1" for c in clips)


def test_the_same_event_twice_sends_once(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    clips = two_clips(store, s3_client)
    event = {"source": "aws.events", "time": "2026-11-15T13:00:02Z"}
    first = handler.handle(event, deps(app))
    second = handler.handle(event, deps(app))
    assert (first["results"], second["results"]) == ({USER: "ran"}, {USER: "done"})
    assert_once(table, lambda_client, clips)
    assert {o for _, o, _ in outcomes(store)} == {"sent"}


def test_two_overlapping_invocations_send_once(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clips = two_clips(store, s3_client)
    real = uploads.upload_review_clip
    inner: list[run.Outcome] = []
    started: list[bool] = []

    def overlap(*args: Any, **kwargs: Any) -> Any:
        if not started:
            started.append(True)
            # A second delivery runs the whole tick while this one is about to send its first clip.
            inner.append(tick(app))
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "upload_review_clip", overlap)
    outer = tick(app)
    assert (outer.result, inner[0].result) == ("ran", "ran")
    assert_once(table, lambda_client, clips)
    assert {o for _, o, _ in outcomes(store)} == {"sent"}
    assert [clip_of(store, c["clipId"])["autoRun"] for c in clips] == [RUN_ID, RUN_ID]


def test_a_crash_after_the_claim_and_its_retry_send_once(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clips = two_clips(store, s3_client)
    real = uploads.upload_review_clip
    calls: list[str] = []

    def crash_once(*args: Any, **kwargs: Any) -> Any:
        calls.append("x")
        if len(calls) == 1:
            raise RuntimeError("the Lambda stopped")
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "upload_review_clip", crash_once)
    with pytest.raises(RuntimeError):
        tick(app)
    planned = run_item(store, RUN_ID)
    assert planned is not None
    assert planned["state"] == "planned"
    assert [c["clipId"] for c in planned["clips"]] == [c["clipId"] for c in clips]
    assert state(store)["lastRunAt"] == iso(SLOT)
    # A clip that would go first now arrives before the retry: the retry keeps its own plan, never a new pick.
    first_now = review_clip(store, s3_client, made="2026-11-15T00:00:00.000Z")
    assert tick(app).result == "ran"
    assert_once(table, lambda_client, clips)
    assert clip_of(store, first_now["clipId"])["status"] == "review"


def test_a_crash_before_the_flow_started_is_finished_by_the_retry(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clips = two_clips(store, s3_client)
    real = release.start_flow
    calls: list[str] = []

    def crash_once(*args: Any, **kwargs: Any) -> Any:
        calls.append("x")
        if len(calls) == 1:
            raise RuntimeError("the Lambda stopped")
        return real(*args, **kwargs)

    monkeypatch.setattr(release, "start_flow", crash_once)
    with pytest.raises(RuntimeError):
        tick(app)
    first = clip_of(store, clips[0]["clipId"])
    assert (first["status"], first["publishState"]) == ("confirmed", "pending")
    assert tick(app).result == "ran"
    assert clip_of(store, clips[0]["clipId"])["publishState"] == "started"
    assert_once(table, lambda_client, clips)


def test_a_done_run_is_never_sent_again(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    clips = two_clips(store, s3_client)
    tick(app)
    before = table.all()
    again = tick(app)
    assert again.result == "done"
    assert again.run is not None
    assert again.run["state"] == "done"
    assert table.all() == before
    assert_once(table, lambda_client, clips)


def claim_patched(store: db.Store, monkeypatch: pytest.MonkeyPatch, before_claim: Any) -> list[str]:
    """Calls ``before_claim(real_transact, kwargs)`` instead of each claim (the transaction that puts the run item);
    every other transaction (Upload's) goes through as usual. Returns one entry per claim tried."""
    real = store.transact
    claims: list[str] = []

    def transact(**kwargs: Any) -> None:
        if any(p.get("type") == "autorun" for p in kwargs.get("puts") or []):
            claims.append("claim")
            return before_claim(real, kwargs)
        return real(**kwargs)

    monkeypatch.setattr(store, "transact", transact)
    return claims


def test_two_deliveries_that_both_planned_send_once(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clips = two_clips(store, s3_client)
    inner: list[run.Outcome] = []

    def second_delivery_first(real: Any, kwargs: dict[str, Any]) -> None:
        if len(claims) == 1:
            # Both deliveries planned; the second claims and sends before this one's claim commits.
            inner.append(tick(app))
        real(**kwargs)

    claims = claim_patched(store, monkeypatch, second_delivery_first)
    outer = tick(app)
    assert (inner[0].result, outer.result) == ("ran", "done")  # the first resumed the second's finished run
    assert claims == ["claim", "claim"]
    assert_once(table, lambda_client, clips)
    assert {o for _, o, _ in outcomes(store)} == {"sent"}
    assert state(store)["lastRunAt"] == iso(SLOT)


def test_a_later_slot_that_moved_the_schedule_first_is_not_due(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    later = iso(SLOT + timedelta(hours=5))

    def later_run_first(real: Any, kwargs: dict[str, Any]) -> None:
        store.put({"pk": PK, "sk": "AUTOPOST", "type": "autopost", "lastRunAt": later, "lastRunId": "x"})
        real(**kwargs)

    claim_patched(store, monkeypatch, later_run_first)
    assert tick(app).result == "not_due"
    assert run_item(store, RUN_ID) is None
    assert state(store)["lastRunAt"] == later
    assert clip_of(store, clip["clipId"])["status"] == "review"


def test_a_claim_cancelled_by_a_conflict_is_claimed_again(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)

    def cancelled_once(real: Any, kwargs: dict[str, Any]) -> None:
        if len(claims) == 1:  # a test run's write to AUTOPOST at that moment, or throttling: nothing was claimed
            raise db.ConditionFailed("TransactionConflict")
        real(**kwargs)

    claims = claim_patched(store, monkeypatch, cancelled_once)
    assert tick(app).result == "ran"
    assert claims == ["claim", "claim"]
    assert outcomes(store) == [(clip["clipId"], "sent", None)]
    assert state(store)["lastRunAt"] == iso(SLOT)


def test_a_claim_cancelled_every_time_fails_so_the_retry_claims_the_same_slot(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    event = {"source": "aws.events", "time": "2026-11-15T13:00:02Z"}

    def always_cancelled(_real: Any, _kwargs: dict[str, Any]) -> None:
        raise db.ConditionFailed("ThrottlingError")

    with monkeypatch.context() as m:
        claims = claim_patched(store, m, always_cancelled)
        with pytest.raises(handler.OwnersFailed):  # the invocation fails: Lambda retries the same event
            handler.handle(event, deps(app))
        assert claims == ["claim", "claim"]
    assert run_item(store, RUN_ID) is None
    assert "lastRunAt" not in state(store)
    assert clip_of(store, clip["clipId"])["status"] == "review"
    # The retry is the same slot, so the run is never an hour late and the gaps stay even.
    assert handler.handle(event, deps(app))["results"] == {USER: "ran"}
    assert state(store)["lastRunAt"] == iso(SLOT)
    assert outcomes(store) == [(clip["clipId"], "sent", None)]
    auto = settings.load(store, USER)["autoPost"]
    assert schedule.next_run_at(auto, state(store), at_slot()) == SLOT + timedelta(hours=5)


def test_a_clip_still_in_review_after_its_upload_was_cancelled_is_tried_again(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube", "facebook")
    turn_on(store)
    clip = review_clip(store, s3_client)
    real = posts.create_for_clip
    calls: list[str] = []

    def cancelled_once(*args: Any, **kwargs: Any) -> Any:
        calls.append("x")
        if len(calls) == 1:  # a caption PATCH on the clip at that moment: the clip is still in Review
            raise db.ConditionFailed("TransactionConflict")
        return real(*args, **kwargs)

    monkeypatch.setattr(posts, "create_for_clip", cancelled_once)
    tick(app)
    assert outcomes(store) == [(clip["clipId"], "sent", None)]
    assert clip_of(store, clip["clipId"])["autoRun"] == RUN_ID
    assert post_count(table, clip["clipId"]) == 2
    assert list(lambda_client.started) == [f"clip-{clip['clipId']}-1"]


def test_a_clip_whose_upload_is_cancelled_every_time_goes_next_run(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    real = posts.create_for_clip

    def always_cancelled(*_args: Any, **_kwargs: Any) -> Any:
        raise db.ConditionFailed("TransactionConflict")

    with monkeypatch.context() as m:
        m.setattr(posts, "create_for_clip", always_cancelled)
        tick(app)
    # Nothing took it, so it never says the owner uploaded it: it is still in Review and goes next run.
    assert outcomes(store) == [(clip["clipId"], "skipped", "It changed while it was being sent. It goes next run.")]
    assert clip_of(store, clip["clipId"])["status"] == "review"
    assert post_count(table, clip["clipId"]) == 0
    assert posts.create_for_clip is real
    later = SLOT + timedelta(hours=5)
    at_slot.now = later + timedelta(seconds=5)
    assert tick(app, later).result == "ran"
    assert outcomes(store, f"{iso(later)}#scheduled") == [(clip["clipId"], "sent", None)]


def test_a_flow_that_did_not_start_keeps_the_run_planned_until_the_retry_starts_it(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clips = two_clips(store, s3_client)
    event = {"source": "aws.events", "time": "2026-11-15T13:00:02Z"}
    lambda_client.fail = True  # the clip flow does not answer
    with pytest.raises(handler.OwnersFailed):  # both clips tried, then the invocation fails: Lambda retries it
        handler.handle(event, deps(app))
    planned = run_item(store, RUN_ID)
    assert planned is not None
    assert planned["state"] == "planned"
    for clip in clips:
        stored = clip_of(store, clip["clipId"])
        assert (stored["status"], stored["publishState"], stored["autoRun"]) == ("confirmed", "pending", RUN_ID)
    lambda_client.fail = False
    assert handler.handle(event, deps(app))["results"] == {USER: "ran"}
    assert {o for _, o, _ in outcomes(store)} == {"sent"}
    assert [clip_of(store, c["clipId"])["publishState"] for c in clips] == ["started", "started"]
    assert sorted(lambda_client.started) == sorted(f"clip-{c['clipId']}-1" for c in clips)
    for clip in clips:
        assert post_count(table, clip["clipId"]) == 3


# --- the owner moves first ------------------------------------------------------------------------------------------


def crashed_run(app: App, monkeypatch: pytest.MonkeyPatch) -> None:
    """A run that planned and claimed, then stopped before sending anything."""

    def crash(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("the Lambda stopped")

    with monkeypatch.context() as m:
        m.setattr(uploads, "upload_review_clip", crash)
        with pytest.raises(RuntimeError):
            tick(app)


def test_a_clip_thrown_away_after_planning_is_skipped(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    crashed_run(app, monkeypatch)
    assert call("POST", f"/v1/clips/{clip['clipId']}/decline")[0] == 200
    tick(app)
    assert outcomes(store) == [(clip["clipId"], "skipped", "You threw it away first.")]
    assert clip_of(store, clip["clipId"])["status"] == "declined"


def test_a_clip_uploaded_by_hand_after_planning_is_skipped(
    app: App,
    call: Call,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube", "facebook")
    turn_on(store)
    clip = review_clip(store, s3_client)
    crashed_run(app, monkeypatch)
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube"]})[0] == 200
    tick(app)
    assert outcomes(store) == [(clip["clipId"], "skipped", "You uploaded it yourself.")]
    assert set(posts_of(table, clip["clipId"])) == {"youtube"}
    assert "autoRun" not in clip_of(store, clip["clipId"])


def test_a_clip_another_run_sent_first_says_so(
    app: App,
    call: Call,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    crashed_run(app, monkeypatch)
    # Its retry comes late: a Private test run took the clip meanwhile.
    at_slot.now = SLOT + timedelta(minutes=20)
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert (status, body["run"]["clips"][0]["clipId"], body["run"]["clips"][0]["outcome"]) == (
        200,
        clip["clipId"],
        "sent",
    )
    tick(app)
    assert outcomes(store) == [(clip["clipId"], "skipped", "Another auto-posting run sent it first.")]
    assert post_count(table, clip["clipId"]) == 1
    assert clip_of(store, clip["clipId"])["autoTest"] == "private"


def test_a_throw_away_at_the_same_instant_wins_the_race(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    clip = review_clip(store, s3_client)
    real = posts.create_for_clip

    def thrown_first(*args: Any, **kwargs: Any) -> Any:
        store.update(PK, db.clip_sk(clip["clipId"]), {"status": "declined"}, expect_in={"status": ["review"]})
        return real(*args, **kwargs)

    monkeypatch.setattr(posts, "create_for_clip", thrown_first)
    tick(app)
    assert outcomes(store) == [(clip["clipId"], "skipped", "You threw it away first.")]


def test_out_of_time_leaves_the_rest_for_the_next_run(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock
) -> None:
    clips = two_clips(store, s3_client)
    readings = iter([0.0, 25.0])
    tick(app, deadline=50.0, clip_seconds=30.0, monotonic=lambda: next(readings))
    assert outcomes(store) == [
        (clips[0]["clipId"], "sent", None),
        (clips[1]["clipId"], "skipped", "Out of time. It goes next run."),
    ]
    assert clip_of(store, clips[1]["clipId"])["status"] == "review"


def test_practice_writes_nothing_but_the_run(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube", "instagram")
    turn_on(store, practice=True)
    clip = review_clip(store, s3_client)
    before = {k: v for k, v in table.items.items() if not k[1].startswith(("AUTORUN#", "AUTOPOST"))}
    assert tick(app).result == "ran"
    after = {k: v for k, v in table.items.items() if not k[1].startswith(("AUTORUN#", "AUTOPOST"))}
    assert after == before
    item = run_item(store, RUN_ID)
    assert item is not None
    assert item["mode"] == "practice"
    assert item["clips"] == [
        {"clipId": clip["clipId"], "hook": "He lost it", "places": ["youtube", "instagram"], "outcome": "would_send"}
    ]
    assert lambda_client.calls == []
    assert state(store)["lastRunAt"] == iso(SLOT)  # practice keeps the same times


# --- a late run, and starts that never went through (§46.5 rule 5, §46.7 step 3) -----------------------------------


def test_a_late_run_protects_its_clips_for_15_minutes_from_when_it_planned(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready(store, "youtube")
    turn_on(store)
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    second = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    clock.now = SLOT + timedelta(minutes=16)  # the 13:00 tick arrives late in its hour
    crashed_run(app, monkeypatch)  # it planned the first clip at 13:16, then stopped
    planned = run_item(store, RUN_ID)
    assert planned is not None
    assert (planned["at"], planned["plannedAt"], planned["state"]) == (
        iso(SLOT),
        iso(SLOT + timedelta(minutes=16)),
        "planned",
    )
    # At 13:20 (20 minutes after its slot, 4 after it planned) a Private test run leaves that clip to it.
    clock.now = SLOT + timedelta(minutes=20)
    assert pick.busy(store, USER, clock()) == {first["clipId"]}
    status, body = call("POST", "/v1/autopost/run", {"kind": "private"})
    assert (status, [c["clipId"] for c in body["run"]["clips"]]) == (200, [second["clipId"]])
    assert clip_of(store, first["clipId"])["status"] == "review"
    clock.now = SLOT + timedelta(minutes=31, seconds=1)
    assert pick.busy(store, USER, clock()) == set()


def test_a_planned_run_stored_before_planned_at_counts_from_its_slot(store: db.Store) -> None:
    store.put(
        {
            "pk": PK,
            "sk": f"AUTORUN#{RUN_ID}",
            "type": "autorun",
            "runId": RUN_ID,
            "at": iso(SLOT),
            "state": "planned",
            "clips": [{"clipId": "c1", "hook": "h", "places": ["youtube"]}],
        }
    )
    assert pick.busy(store, USER, SLOT + timedelta(minutes=15)) == {"c1"}
    assert pick.busy(store, USER, SLOT + timedelta(minutes=15, seconds=1)) == set()


def every_retry_fails(app: App, lambda_client: FakeLambda) -> None:
    """The 13:00 run sends its clip but its clip flow never starts, through the event and both of Lambda's retries."""
    event = {"source": "aws.events", "time": "2026-11-15T13:00:02Z"}
    lambda_client.fail = True
    for _ in range(3):
        with pytest.raises(handler.OwnersFailed):
            handler.handle(event, deps(app))
    lambda_client.fail = False


def finished_starts(capsys: pytest.CaptureFixture[str], event: str = "autopost.finished_start") -> list[dict[str, Any]]:
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    return [line for line in lines if line.get("event") == event]


def test_the_next_run_finishes_a_start_that_never_went_through(
    app: App,
    store: db.Store,
    table: FakeTable,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    capsys: pytest.CaptureFixture[str],
) -> None:
    ready(store, "youtube", "facebook")
    turn_on(store)
    stuck = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    every_retry_fails(app, lambda_client)
    left = clip_of(store, stuck["clipId"])
    assert (left["status"], left["publishState"], left["autoRun"]) == ("confirmed", "pending", RUN_ID)
    later = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    next_slot = SLOT + timedelta(hours=5)
    at_slot.now = next_slot + timedelta(seconds=5)
    capsys.readouterr()
    assert tick(app, next_slot).result == "ran"
    assert clip_of(store, stuck["clipId"])["publishState"] == "started"
    assert sorted(lambda_client.started) == sorted(f"clip-{c['clipId']}-1" for c in (stuck, later))
    # The earlier clip first, then this run's own.
    assert flow_starts(lambda_client)[-2:] == [f"clip-{stuck['clipId']}-1", f"clip-{later['clipId']}-1"]
    assert post_count(table, stuck["clipId"]) == 2  # never a second set of posts
    next_run = f"{iso(next_slot)}#scheduled"
    assert outcomes(store, next_run) == [(later["clipId"], "sent", None)]
    assert [(line["runId"], line["clipId"]) for line in finished_starts(capsys)] == [(next_run, stuck["clipId"])]
    # Once started it is left alone.
    third = SLOT + timedelta(hours=10)
    at_slot.now = third + timedelta(seconds=5)
    calls = len(lambda_client.calls)
    tick(app, third)
    assert len(lambda_client.calls) == calls


def test_a_start_that_fails_again_is_logged_and_the_run_still_sends_its_own(
    app: App,
    store: db.Store,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube")
    turn_on(store)
    stuck = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z")
    every_retry_fails(app, lambda_client)
    later = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    real = release.start_flow

    def broken_for_the_stuck_one(store_: Any, flows: Any, clip: Any) -> Any:
        if clip["clipId"] == stuck["clipId"]:
            raise RuntimeError("its item is broken")
        return real(store_, flows, clip)

    monkeypatch.setattr(release, "start_flow", broken_for_the_stuck_one)
    next_slot = SLOT + timedelta(hours=5)
    at_slot.now = next_slot + timedelta(seconds=5)
    capsys.readouterr()
    assert tick(app, next_slot).result == "ran"
    assert outcomes(store, f"{iso(next_slot)}#scheduled") == [(later["clipId"], "sent", None)]
    assert clip_of(store, later["clipId"])["publishState"] == "started"
    assert clip_of(store, stuck["clipId"])["publishState"] == "pending"
    failed = finished_starts(capsys, "autopost.finish_start_failed")
    assert [(line["clipId"], line["error"]) for line in failed] == [(stuck["clipId"], "RuntimeError")]


def test_earlier_starts_leave_time_for_this_runs_own_clips(
    app: App,
    store: db.Store,
    s3_client: FakeS3,
    at_slot: Clock,
    lambda_client: FakeLambda,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ready(store, "youtube")
    turn_on(store, per_run=5)
    stuck = [review_clip(store, s3_client, made=f"2026-11-15T0{n}:00:00.000Z") for n in range(1, 6)]
    every_retry_fails(app, lambda_client)  # the 13:00 run confirmed five clips whose flows never started
    assert {clip_of(store, c["clipId"])["publishState"] for c in stuck} == {"pending"}
    turn_on(store, per_run=3)
    own = [review_clip(store, s3_client, made=f"2026-11-15T0{n}:00:00.000Z") for n in range(6, 9)]
    # Every flow start takes 30 s (one clip's time); the run has 210 s.
    now = [0.0]
    real = release.start_flow

    def slow(store_: Any, flows: Any, clip: Any) -> Any:
        now[0] += 30.0
        return real(store_, flows, clip)

    monkeypatch.setattr(release, "start_flow", slow)
    next_slot = SLOT + timedelta(hours=5)
    at_slot.now = next_slot + timedelta(seconds=5)
    capsys.readouterr()
    assert tick(app, next_slot, deadline=210.0, clip_seconds=30.0, monotonic=lambda: now[0]).result == "ran"
    # Its own three clips all go: earlier ones only start while time is left for them as well.
    assert outcomes(store, f"{iso(next_slot)}#scheduled") == [(c["clipId"], "sent", None) for c in own]
    left = [c["clipId"] for c in stuck if clip_of(store, c["clipId"])["publishState"] == "pending"]
    assert len(left) == 1
    assert len(finished_starts(capsys)) == 4
    # The next run finishes the last one.
    third = SLOT + timedelta(hours=10)
    at_slot.now = third + timedelta(seconds=5)
    now[0] = 0.0
    assert tick(app, third, deadline=210.0, clip_seconds=30.0, monotonic=lambda: now[0]).result == "ran"
    assert clip_of(store, left[0])["publishState"] == "started"


def test_practice_leaves_an_earlier_start_alone(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    turn_on(store)
    stuck = review_clip(store, s3_client)
    every_retry_fails(app, lambda_client)
    turn_on(store, practice=True)
    next_slot = SLOT + timedelta(hours=5)
    at_slot.now = next_slot + timedelta(seconds=5)
    calls = len(lambda_client.calls)
    assert tick(app, next_slot).result == "ran"
    # "Nothing gets sent" while practising: the next live run finishes it.
    assert len(lambda_client.calls) == calls
    assert clip_of(store, stuck["clipId"])["publishState"] == "pending"
    turn_on(store)
    later = SLOT + timedelta(hours=10)
    at_slot.now = later + timedelta(seconds=5)
    assert tick(app, later).result == "ran"
    assert clip_of(store, stuck["clipId"])["publishState"] == "started"


# --- the Lambda (§46.11) --------------------------------------------------------------------------------------------


def test_the_tick_finds_owners_with_one_query_and_uses_the_event_time(
    app: App, store: db.Store, table: FakeTable, s3_client: FakeS3, at_slot: Clock
) -> None:
    ready(store, "youtube")
    turn_on(store)
    review_clip(store, s3_client)
    out = handler.handle({"source": "aws.events", "time": "2026-11-15T13:00:43Z"}, deps(app))
    assert out == {"action": "tick", "slot": iso(SLOT), "owners": 1, "results": {USER: "ran"}}
    owner_queries = [
        kw
        for name, kw in table.calls
        if name == "query" and kw["ExpressionAttributeValues"].get(":pk") == "AUTOPOSTOWNERS"
    ]
    assert len(owner_queries) == 1
    assert not any(name == "scan" for name, _ in table.calls)
    assert run_item(store, RUN_ID) is not None


@pytest.mark.parametrize("event", [{}, {"source": "aws.s3"}, {"source": "aws.events", "time": "soon"}, "x"])
def test_anything_else_is_a_bad_event(app: App, event: Any) -> None:
    assert handler.handle(event, deps(app)) == {"action": "bad_event"}


def test_one_owner_failing_does_not_stop_another(
    app: App, store: db.Store, s3_client: FakeS3, at_slot: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    for user in (USER, OTHER):
        ready(store, "youtube", user=user)
        turn_on(store, user=user)
    theirs = review_clip(store, s3_client, user=OTHER)
    real = run.run_once

    def broken_for_one(d: Any, user_id: str, kind: str, slot: Any) -> run.Outcome:
        if user_id == USER:
            raise RuntimeError("one owner's data is broken")
        return real(d, user_id, kind, slot)

    monkeypatch.setattr(handler, "run_once", broken_for_one)
    with pytest.raises(handler.OwnersFailed):
        handler.handle({"source": "aws.events", "time": "2026-11-15T13:00:00Z"}, deps(app))
    assert clip_of(store, theirs["clipId"], OTHER)["status"] == "confirmed"


def test_the_handler_ships_in_the_zip() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "build_lambda", Path(__file__).resolve().parents[1] / "scripts" / "build_lambda.py"
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert "clipfactory_api/autopost/handler.py" in module.HANDLERS
