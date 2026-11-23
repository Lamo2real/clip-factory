"""``cf-prod-story-flow``: the PublishJob of §45.14, the steps, the shared limits, the numbers and the sentences
(docs/CONTRACTS.md §45.14, §45.9.1, ADR-73). Real publishers, recorded platform answers, fakes only."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.clock import iso, parse
from clipfactory_api.flows import TransientError, story_flow
from clipfactory_api.flows.story_flow import numbers_cost, parse_event, run_story_flow
from clipfactory_api.platforms import ADAPTER_CLASSES
from clipfactory_api.stats import config, refresh
from clipfactory_api.workspaces import publish, sentences
from clipfactory_api.workspaces.sentences import story_sentence
from conftest import NOW, USER, Clock
from fakes import FakeDurableContext, FakeHttp, FakeSecretsManager, FakeTable

SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc"
YOUTUBE_OK = [
    (200, b"", {"Location": SESSION}),
    (201, "publish/youtube_video"),
    (200, "publish/youtube_uploaded"),
    (200, "publish/youtube_processed"),
]
YOUTUBE_NUMBERS = [
    (200, {"items": [{"id": "vid123", "statistics": {"viewCount": "100", "likeCount": "9", "commentCount": "2"}}]}),
    (403, {"error": {"code": 403}}),  # the analytics report is a bonus
]
STORY_SK = f"STORY#{sup.STORY_ID}"
JOB_SK = "PUBJOB#01JZ0000000000000000000PJ1"


def youtube_answers_with_numbers() -> list[Any]:
    return [*YOUTUBE_OK, *(YOUTUBE_NUMBERS * 4)]


@pytest.fixture
def world(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    sup.ready(store, secrets_client, "youtube", "x", "tiktok", "instagram", "facebook")


def test_youtube_posts_with_the_workspace_token_and_lamo_stories_settings_only(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "youtube")
    store.put({"pk": db.user_pk(USER), "sk": "SETTINGS", "type": "settings", "youtubePrivacy": "private"})
    http = FakeHttp(*youtube_answers_with_numbers())
    ctx = FakeDurableContext()
    out = run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out == {"storyId": sup.STORY_ID, "outcome": "done"}
    assert ctx.steps[:7] == [
        "load-jobs",
        "validate-youtube",
        "room-youtube-1",  # Clip Factory's shared app: its posts go first (§45.37 G6); there is room
        "publish-youtube",
        "check-youtube-1",
        "check-youtube-2",
        "posted-youtube",
    ]
    assert ctx.steps[7:] == ["numbers-1", "numbers-2", "numbers-3", "numbers-4"]
    numbers_waits = [w for w in ctx.waits if str(w[0]).startswith("wait-numbers")]
    assert numbers_waits == [
        ("wait-numbers-1", 3600),
        ("wait-numbers-2", 86400),
        ("wait-numbers-3", 259200),
        ("wait-numbers-4", 604800),
    ]
    init = http.calls[0]
    assert init.headers["Authorization"] == "Bearer ya29.WS-ACCESS"
    meta = json.loads(init.body)
    assert meta["snippet"]["title"] == "How to stop a skid on ice"
    assert meta["snippet"]["categoryId"] == "27"
    assert meta["status"] == {
        "privacyStatus": "public",
        "selfDeclaredMadeForKids": False,
        "containsSyntheticMedia": False,
    }
    assert all(
        c.headers.get("Authorization", "").endswith("WS-ACCESS") for c in http.calls if "Authorization" in c.headers
    )
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["url"], job["statsId"]) == (
        "posted",
        "https://www.youtube.com/shorts/vid123",
        "vid123",
    )
    assert publish.public_job(job)["metrics"] == {
        "views": 100,
        "likes": 9,
        "comments": 2,
        "shares": None,  # YouTube's shares come from the analytics report, which said no here
        "checkedAt": "2026-11-15T12:00:00.000Z",
    }
    assert not {"statsId", "numbersAt", "publishHandle", "flowRun", "appChoice", "aiLabel"} & set(
        publish.public_job(job)
    )
    assert len(job["numbersAt"]) == 4
    story = table.raw(sup.PK, STORY_SK)
    assert story is not None
    assert story["status"] == "published"
    assert story["posted"] == [{"platform": "youtube", "url": "https://www.youtube.com/shorts/vid123"}]
    assert story["publishedAt"] == "2026-11-15T12:00:00.000Z"
    assert story["version"] == 4
    acts = [i for i in table.all() if str(i["sk"]).startswith("ACT#")]
    assert [(a["kind"], a["platform"], a["title"]) for a in acts] == [("posted", "youtube", "Ice is slippery")]
    assert acts[0]["ttl"] == int((NOW + timedelta(days=90)).timestamp())
    # §45.37 G6: Clip Factory's counters are never written; Lamo Stories counts its upload, its two processing checks
    # and its four numbers reads (one Data API unit each) in its own item of its own partition
    assert store.get("RATE#youtube", "BUDGET") is None
    own = table.raw("RATE#WS#~shared#youtube", "SHAREUSE#youtube#2026-11-15")
    assert own is not None
    assert (own["type"], own["posts"], own["units"], own["byWorkspace"]) == (
        "ws_shareuse",
        1,
        6,
        {f"{USER}#stories": {"posts": 1, "units": 6}},
    )
    for _, name in secrets_client.calls:
        assert name.startswith("cf-prod/workspaces/stories/") or name.endswith("/app"), name


def test_a_replayed_publish_and_posted_step_change_nothing_twice(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "youtube")
    http = FakeHttp(*youtube_answers_with_numbers())
    ctx = FakeDurableContext(replay={"publish-youtube", "posted-youtube"})
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert [c.method for c in http.calls].count("POST") == 1
    story = table.raw(sup.PK, STORY_SK)
    assert story is not None
    assert len(story["posted"]) == 1
    assert len([i for i in table.all() if str(i["sk"]).startswith("ACT#")]) == 1


def test_a_mac_job_is_never_loaded_and_the_others_still_go(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    """§47.10: a TikTok job the owner's Mac posts (``publishingStatus: "mac"``) is skipped by ``load-jobs``, even when
    a flow names it; the other platforms of the run still go."""
    sup.pubjob(store, "youtube")
    mac_sk = "PUBJOB#01JZ0000000000000000000PJ2"
    sup.pubjob(store, "tiktok", "01JZ0000000000000000000PJ2", publishingStatus="mac", macState="waiting")
    target = parse_event(sup.flow_event("01JZ0000000000000000000PJ1", "01JZ0000000000000000000PJ2"))
    assert target is not None
    deps = sup.flow_deps(store, secrets_client, FakeHttp(), clock)
    assert story_flow.load_jobs(deps, target) == [
        {"publishingJobId": "01JZ0000000000000000000PJ1", "platform": "youtube"}
    ]
    http = FakeHttp(*youtube_answers_with_numbers())
    event = sup.flow_event("01JZ0000000000000000000PJ2", "01JZ0000000000000000000PJ1")
    run_story_flow(FakeDurableContext(), event, sup.flow_deps(store, secrets_client, http, clock))
    assert not [c for c in http.calls if "tiktok" in c.url]
    mac_job = table.raw(sup.PK, mac_sk)
    assert mac_job is not None
    assert (mac_job["publishingStatus"], mac_job["macState"]) == ("mac", "waiting")
    youtube = table.raw(sup.PK, JOB_SK)
    assert youtube is not None
    assert youtube["publishingStatus"] == "posted"


def test_the_story_write_is_shared_and_adds_a_post_once() -> None:
    """``workspaces.story_posted`` (the flow's posted step and the owner's Mac): one post once, ``publishedAt`` once,
    ``published`` only from ``approved`` or ``published``, compare-and-swap on ``version``."""
    from clipfactory_api.workspaces import story_posted

    story = {"status": "approved", "posted": [], "version": 3}
    write = story_posted.story_write(story, "tiktok", "https://t/1", "2026-11-15T12:00:00.000Z", NOW)
    assert write is not None
    assert write.condition == "attribute_exists(pk) AND #v = :ver"
    sets = {write.names[k]: write.values[k.replace("#", ":")] for k in write.names if k.startswith("#f")}
    assert sets == {
        "posted": [{"platform": "tiktok", "url": "https://t/1"}],
        "updatedAt": "2026-11-15T12:00:00.000Z",
        "publishedAt": "2026-11-15T12:00:00.000Z",
        "status": "published",
    }
    done = {**story, "status": "published", "posted": sets["posted"], "publishedAt": "2026-11-15T12:00:00.000Z"}
    assert story_posted.story_write(done, "tiktok", "https://t/1", "2026-11-15T13:00:00.000Z", NOW) is None
    review = story_posted.story_write({"status": "review"}, "x", "u", "t", NOW)
    assert review is not None
    assert "status" not in review.names.values()
    assert review.condition == "attribute_exists(pk) AND attribute_not_exists(#v)"
    request = write.request("PK", "SK")
    assert request["Key"] == {"pk": "PK", "sk": "SK"}
    assert request["ConditionExpression"] == write.condition


def test_x_waits_for_the_next_month_when_clip_factory_used_its_credits_and_then_posts_by_itself(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    """§45.37 G6 (c, f): no room on Clip Factory's shared X app this month → the post waits (never fails, never
    takes Clip Factory's share), then goes out after the month resets; Clip Factory's RATE#x is never written."""
    token = {**sup.TOKENS["x"], "expiresAt": "2027-06-01T00:00:00.000Z"}  # still fresh after the month's wait
    sup.social(store, secrets_client, "x", token=token)
    sup.pubjob(store, "x")
    cf_budget = {"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 9.99, "version": 1}
    store.put(cf_budget)
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
        *([(200, "x_tweets_lookup")] * 4),
    )
    seen: dict[str, Any] = {}

    class Watching(TimedContext):
        def wait(self, duration: Any, name: str | None = None) -> None:
            if name == "wait-room-x-1":  # what the owner sees while it waits
                found = table.raw(sup.PK, JOB_SK) or {}
                seen.update(job=dict(found), calls=len(http.calls), shown=publish.public_job(found))
            super().wait(duration, name=name)

    ctx = Watching(clock)
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    waiting = seen["job"]
    assert waiting["publishingStatus"] == "queued"
    assert waiting["waitUntil"] == "2026-12-01T00:00:30.000Z"
    assert seen["shown"]["waiting"] == "Waiting: Clip Factory's posts go first. Posts at 1 Dec 00:00 UTC."
    assert seen["shown"]["waitingUntil"] == "2026-12-01T00:00:30.000Z"
    assert "error" not in waiting
    assert seen["calls"] == 0  # nothing went to X while it waited
    assert ctx.steps[1:4] == ["validate-x", "room-x-1", "room-x-2"]
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "posted"
    assert "waitUntil" not in job
    assert "waiting" not in job
    assert store.get("RATE#x", "BUDGET") == {**cf_budget}  # Clip Factory's budget: byte for byte as it was
    own = table.raw("RATE#WS#~shared#x", "SHAREUSE#x#2026-12")
    assert own is not None
    assert own["usd"] >= 0.015
    assert store.get(db.user_pk(USER), "SETUP#x") is None  # Clip Factory's setup gates are never written


def test_x_credits_run_out_without_touching_lamo_clips_gates(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "x")
    http = FakeHttp((402, {"title": "CreditsDepleted"}))
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "needs_attention"
    assert job["error"] == "X has no credits left. Buy more in console.x.com › Billing › Credits, then tap Try again."
    assert store.get("RATE#x", "BUDGET") is None  # §45.37 G6: Clip Factory's X budget is never written
    own = table.raw("RATE#WS#~shared#x", "SHAREUSE#x#2026-11")
    assert own is not None
    assert float(own["usd"]) == 0.015  # Lamo Stories' own count of the shared app's credits
    assert store.get(db.user_pk(USER), "SETUP#x") is None


def test_x_full_post(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "x")
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
        *([(200, "x_tweets_lookup")] * 4),
    )
    ctx = FakeDurableContext()
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert ctx.steps[1:7] == ["validate-x", "room-x-1", "publish-x", "check-x-1", "finish-x", "posted-x"]
    tweet = json.loads(http.calls[4].body)
    assert tweet["text"] == "ice tips"
    assert "paid_partnership" not in tweet
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["url"]) == ("posted", "https://x.com/lamostories/status/1880028300000000001")


def test_a_replayed_finish_still_records_the_post_on_the_story(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "x")
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
        *([(200, "x_tweets_lookup")] * 4),
    )
    ctx = FakeDurableContext(replay={"finish-x"})
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert [c.url for c in http.calls].count("https://api.x.com/2/tweets") == 1
    assert "posted-x" in ctx.steps
    story = table.raw(sup.PK, STORY_SK)
    assert story is not None
    assert story["posted"] == [{"platform": "x", "url": "https://x.com/lamostories/status/1880028300000000001"}]
    assert story["status"] == "published"


def test_a_dead_token_on_upload_asks_for_lamo_stories_connections(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "youtube")
    http = FakeHttp((401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}}))
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "needs_attention"
    assert job["error"] == (
        "This YouTube account (Lamo Stories youtube) needs connecting again. Open Clips Funded › Social accounts, "
        "then tap Try again."
    )
    social = table.raw(sup.PK, "SOCIAL#youtube")
    assert social is not None
    assert (social["connectionStatus"], social["reason"]) == ("needs_reconnect", "token_dead")
    assert store.get(db.user_pk(USER), "ACCOUNT#youtube") is None


TIKTOK_OPTIONS = {
    "privacyLevel": "SELF_ONLY",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}


def test_tiktok_posts_with_the_owner_picked_options_and_no_settings(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    options = TIKTOK_OPTIONS
    sup.pubjob(store, "tiktok", postOptions={**options, "madeForKids": True, "campaign": {"paidPartnership": True}})
    http = FakeHttp(
        (200, "publish/tiktok_creator"),
        (200, "publish/tiktok_init"),
        (201, b""),
        (200, "publish/tiktok_status_complete"),
    )
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    init = json.loads(http.calls[1].body)
    assert init["post_info"]["privacy_level"] == "SELF_ONLY"
    assert init["post_info"]["title"] == "ice tips"
    assert init["post_info"]["is_aigc"] is False
    assert init["post_info"]["brand_content_toggle"] is False
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["privacy"]) == ("posted", "private")
    assert http.answers == []  # a private post has no numbers to read


def test_a_job_of_another_run_is_never_sent(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "youtube", flowRun=2)
    http = FakeHttp()
    out = run_story_flow(FakeDurableContext(), sup.flow_event(run=1), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "not_posted"
    assert http.calls == []
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "queued"


def test_bad_events_send_nothing(store: db.Store, secrets_client: FakeSecretsManager, clock: Clock) -> None:
    for event in (
        None,
        {},
        {**sup.flow_event(), "workspaceId": "clips"},
        {**sup.flow_event(), "publishingJobIds": []},
        {**sup.flow_event(), "publishingJobIds": ["a"] * 6},
        {**sup.flow_event(), "run": True},
        {**sup.flow_event(), "userId": ""},
    ):
        assert parse_event(event) is None
        out = run_story_flow(FakeDurableContext(), event, sup.flow_deps(store, secrets_client, FakeHttp(), clock))
        assert out["outcome"] == "bad_event"


def test_a_numbers_read_waits_while_the_budget_is_blocked(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(
        store,
        "youtube",
        publishingStatus="posted",
        statsId="vid123",
        postedAt="2026-11-15T11:00:00.000Z",
        url="https://www.youtube.com/shorts/vid123",
    )
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "blockedUntil": "2026-11-15T13:00:00.000Z"})
    http = FakeHttp()
    deps = sup.flow_deps(store, secrets_client, http, clock)
    assert story_flow.numbers_step(
        deps, story_flow.parse_event(sup.flow_event()), ["01JZ0000000000000000000PJ1"], 1
    ) == {  # type: ignore[arg-type]
        "at": "2026-11-15T12:00:00.000Z",
        "read": 0,
    }
    assert http.calls == []


def test_numbers_are_never_read_with_another_account(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "youtube", publishingStatus="posted", statsId="vid123", postedAt="2026-11-15T11:00:00.000Z")
    store.update(sup.PK, "SOCIAL#youtube", {"externalAccountId": "UC-ANOTHER"})
    http = FakeHttp()
    deps = sup.flow_deps(store, secrets_client, http, clock)
    target = story_flow.parse_event(sup.flow_event())
    assert target is not None
    assert story_flow.numbers_step(deps, target, ["01JZ0000000000000000000PJ1"], 2)["read"] == 0
    assert http.calls == []


@pytest.mark.parametrize("platform", ["youtube", "x", "instagram", "facebook", "tiktok"])
def test_the_numbers_cost_is_the_poller_cost(platform: str) -> None:
    cfg = config.load()
    deps = refresh.StatsDeps(store=db.Store(FakeTable()), cfg=cfg)
    for chunk in (
        [{"postId": "a", "statsId": "s1", "postedAt": "2026-11-15T11:00:00.000Z"}],
        [{"postId": "a", "postedAt": "2026-10-01T11:00:00.000Z"}],
        [{"postId": "a", "statsId": "s1", "postedAt": "2026-10-01T11:00:00.000Z"}],
    ):
        assert numbers_cost(platform, chunk, cfg, NOW) == refresh._cost(platform, chunk, deps, NOW)


def test_the_stats_adapters_get_the_workspace_tokens(
    world: None, store: db.Store, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    deps = sup.flow_deps(store, secrets_client, FakeHttp(), clock)
    target = story_flow.parse_event(sup.flow_event())
    assert target is not None
    tokens = deps.tokens(target)
    adapter = deps.adapters("instagram", tokens, deps.graph_api_version)
    assert isinstance(adapter, ADAPTER_CLASSES["instagram"])
    assert adapter.token({"accountId": "whatever"}) == "EAAG-WS-PAGE"


# --- sentences ---------------------------------------------------------------------------------------------


def test_every_kind_has_a_lamo_stories_sentence() -> None:
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        for kind in sentences.KINDS:
            text = story_sentence(platform, kind, "Lamo Stories Channel")
            assert text, (platform, kind)
            assert "Settings" not in text, (platform, kind)
            assert text.endswith("."), (platform, kind)
    assert story_sentence("youtube", "reconnect", "Lamo Stories Channel") == (
        "This YouTube account (Lamo Stories Channel) needs connecting again. Open Clips Funded › Social accounts, "
        "then tap Try again."
    )
    assert story_sentence("tiktok", "private") == (
        "Make the Clips Funded TikTok account private until TikTok approves the app, then tap Try again."
    )


def test_no_lamo_clips_sentence_is_ever_stored_by_the_flow() -> None:
    from clipfactory_api.platforms import errors

    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        for status, body in ((401, {}), (429, {}), (500, {}), (400, {"error": {"code": "spam_risk"}})):
            problem = errors.classify(platform, status, body)
            assert "Settings" not in story_sentence(platform, problem.kind)
    assert sentences.kind_of_message("This clip is longer than TikTok allows for your account.") == "too_long"
    assert sentences.kind_of_message("Pick who can see it on TikTok again, then press Try again.") == "privacy"
    assert sentences.kind_of_message("Connect Instagram in Settings › Posting › Set up posting.") == "other"


# --- no job is ever left in flight by a step that runs out of tries -------------------------------------------


def _always_down(*_: Any, **__: Any) -> Any:
    raise TransientError("ProvisionedThroughputExceededException: slow down")


def test_a_check_that_cannot_run_ends_the_job_retryable_and_sends_nothing(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    monkeypatch.setattr(story_flow, "validate_step", _always_down)
    http = FakeHttp()
    ctx = FakeDurableContext()
    out = run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "not_posted"
    assert ctx.steps == ["load-jobs", "validate-youtube", "failed-youtube"]
    assert ctx.attempts["validate-youtube"] == 3
    assert http.calls == []
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["error"]) == ("failed", "Posting did not start. Tap Try again.")
    assert job["publishingStatus"] in publish.RETRYABLE


def test_jobs_that_cannot_be_loaded_are_ended(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    sup.pubjob(store, "x", "01JZ0000000000000000000PJ2")
    sup.pubjob(store, "tiktok", "01JZ0000000000000000000PJ3", flowRun=2)  # another run's: never touched
    monkeypatch.setattr(story_flow, "load_jobs", _always_down)
    ctx = FakeDurableContext()
    event = sup.flow_event("01JZ0000000000000000000PJ1", "01JZ0000000000000000000PJ2", "01JZ0000000000000000000PJ3")
    out = run_story_flow(ctx, event, sup.flow_deps(store, secrets_client, FakeHttp(), clock))
    assert out["outcome"] == "not_posted"
    assert ctx.steps == ["load-jobs", "stop-jobs"]
    statuses = {str(i["platform"]): i["publishingStatus"] for i in table.all() if str(i["sk"]).startswith("PUBJOB#")}
    assert statuses == {"youtube": "failed", "x": "failed", "tiktok": "queued"}


def test_a_posted_step_that_runs_out_of_tries_never_reads_as_still_posting(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    monkeypatch.setattr(story_flow, "publish_step", lambda *_a, **_k: {"state": "done"})  # finishing on its own
    monkeypatch.setattr(story_flow, "posted_step", _always_down)
    ctx = FakeDurableContext()
    run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, FakeHttp(), clock))
    assert ctx.steps[-2:] == ["posted-youtube", "failed-youtube"]
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["error"]) == (
        "failed",
        "We are not sure it posted. Look on YouTube before you tap Try again.",
    )


def test_a_posted_job_stays_posted_when_its_story_update_runs_out_of_tries(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    monkeypatch.setattr(story_flow, "posted_step", _always_down)
    run_story_flow(
        FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, FakeHttp(*YOUTUBE_OK), clock)
    )
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "posted"


def test_when_even_ending_a_job_fails_the_next_platform_still_goes(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    sup.pubjob(store, "x", "01JZ0000000000000000000PJ2")
    real = story_flow.validate_step

    def youtube_down(deps: Any, target: Any, job_id: str) -> Any:
        if job_id == "01JZ0000000000000000000PJ1":
            raise TransientError("ServiceUnavailable")
        return real(deps, target, job_id)

    monkeypatch.setattr(story_flow, "validate_step", youtube_down)
    monkeypatch.setattr(story_flow, "end_job", _always_down)
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
        *([(200, "x_tweets_lookup")] * 4),
    )
    ctx = FakeDurableContext()
    event = sup.flow_event("01JZ0000000000000000000PJ1", "01JZ0000000000000000000PJ2")
    out = run_story_flow(ctx, event, sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "done"
    assert "posted-x" in ctx.steps
    youtube = table.raw(sup.PK, JOB_SK)
    assert youtube is not None
    assert youtube["publishingStatus"] == "queued"  # the API's settle_stuck fails it later
    later = youtube["updatedAt"].replace("T11:", "T05:")
    assert publish.stuck({**youtube, "updatedAt": later}, NOW)


def test_a_try_again_between_the_read_and_the_send_stops_the_old_run(
    world: None,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sup.pubjob(store, "youtube")
    real = store.update

    def retried_meanwhile(pk: str, sk: str, set_fields: Any, **kw: Any) -> Any:
        if set_fields.get("publishingStatus") == "publishing":
            real(pk, sk, {"flowRun": 2})  # the owner's Try again raised the run a moment ago
        return real(pk, sk, set_fields, **kw)

    monkeypatch.setattr(store, "update", retried_meanwhile)
    http = FakeHttp()
    out = run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "not_posted"
    assert http.calls == []
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["flowRun"]) == ("queued", 2)


# --- numbers at 1 h, 24 h, 72 h and 7 days after each post's own postedAt -----------------------------------


class TimedContext(FakeDurableContext):
    """Each wait moves the clock on, as the real waits do."""

    def __init__(self, clock: Clock) -> None:
        super().__init__()
        self.clock = clock

    def wait(self, duration: Any, name: str | None = None) -> None:
        super().wait(duration, name=name)
        self.clock.now += timedelta(seconds=duration.to_seconds())


def test_numbers_are_planned_from_each_posts_own_posted_at() -> None:
    posted = [
        {"publishingJobId": "A", "postedAt": "2026-11-15T12:00:00.000Z", "at": "2026-11-15T12:00:01.000Z"},
        {"publishingJobId": "B", "postedAt": "2026-11-15T12:05:00.000Z", "at": "2026-11-15T12:05:01.000Z"},
        {"publishingJobId": "C", "postedAt": "2026-11-15T13:30:00.000Z", "at": "2026-11-15T13:30:01.000Z"},
    ]
    plan = [(name, k, iso(due), ids) for name, k, due, ids in story_flow.numbers_plan(posted)]
    assert plan[:4] == [
        ("numbers-1", 1, "2026-11-15T13:05:00.000Z", ["A", "B"]),  # A is read 5 minutes late, never early
        ("numbers-1-2", 1, "2026-11-15T14:30:00.000Z", ["C"]),
        ("numbers-2", 2, "2026-11-16T12:05:00.000Z", ["A", "B"]),
        ("numbers-2-2", 2, "2026-11-16T13:30:00.000Z", ["C"]),
    ]
    assert [row[0] for row in plan[4:]] == ["numbers-3", "numbers-3-2", "numbers-4", "numbers-4-2"]
    assert plan[-1][2] == "2026-11-22T13:30:00.000Z"
    alone = story_flow.numbers_plan(posted[:1])
    assert [name for name, *_ in alone] == ["numbers-1", "numbers-2", "numbers-3", "numbers-4"]


def test_tiktok_s_id_waits_after_every_post_and_the_numbers_wait_counts_its_time(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    public = {**TIKTOK_OPTIONS, "privacyLevel": "PUBLIC_TO_EVERYONE"}
    sup.social(store, secrets_client, "tiktok", choice="own")  # its own app's counters block the numbers reads
    sup.pubjob(store, "tiktok", postOptions=public)
    store.put({"pk": "RATE#WS#stories#tiktok", "sk": "BUDGET", "blockedUntil": "2027-01-01T00:00:00.000Z"})
    no_id = {"data": {"status": "PUBLISH_COMPLETE", "uploaded_bytes": 3145728}, "error": {"code": "ok"}}
    http = FakeHttp(
        (200, "publish/tiktok_creator"),
        (200, "publish/tiktok_init"),
        (201, b""),
        (200, no_id),  # check-tiktok-1: posted, no public id yet
        (200, no_id),  # tiktok-id-1
        (200, "publish/tiktok_status_complete"),  # tiktok-id-2
    )
    ctx = TimedContext(clock)
    out = run_story_flow(ctx, sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "done"
    assert http.answers == []
    assert ctx.steps[:7] == [
        "load-jobs",
        "validate-tiktok",
        "publish-tiktok",
        "check-tiktok-1",
        "posted-tiktok",
        "tiktok-id-1",
        "tiktok-id-2",
    ]
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["statsId"] == "7311234567890123456"
    posted_at = parse(job["postedAt"])
    assert posted_at is not None
    found_at = parse(ctx.results["tiktok-id-2"]["at"])
    assert found_at is not None
    waits = dict(ctx.waits)
    assert waits["wait-numbers-1"] == int((posted_at + timedelta(hours=1) - found_at).total_seconds())
    assert waits["wait-numbers-1"] < 3600  # the id loop's 20 minutes are counted, not added
    assert waits["wait-numbers-2"] == 23 * 3600
    assert ctx.steps[-4:] == ["numbers-1", "numbers-2", "numbers-3", "numbers-4"]


def test_tiktok_s_id_loop_never_holds_up_the_next_platform(
    world: None, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.pubjob(store, "tiktok", postOptions={**TIKTOK_OPTIONS, "privacyLevel": "PUBLIC_TO_EVERYONE"})
    sup.pubjob(store, "x", "01JZ0000000000000000000PJ2")
    for platform in ("tiktok", "x"):  # their own apps' counters block the numbers reads
        sup.social(store, secrets_client, platform, choice="own")
        store.put({"pk": f"RATE#WS#stories#{platform}", "sk": "BUDGET", "blockedUntil": "2027-01-01T00:00:00Z"})
    no_id = {"data": {"status": "PUBLISH_COMPLETE", "uploaded_bytes": 3145728}, "error": {"code": "ok"}}
    http = FakeHttp(
        (200, "publish/tiktok_creator"),
        (200, "publish/tiktok_init"),
        (201, b""),
        (200, no_id),
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
        (200, "publish/tiktok_status_complete"),  # tiktok-id-1, after X is posted
    )
    ctx = TimedContext(clock)
    event = sup.flow_event("01JZ0000000000000000000PJ1", "01JZ0000000000000000000PJ2")
    run_story_flow(ctx, event, sup.flow_deps(store, secrets_client, http, clock))
    assert http.answers == []
    assert ctx.steps.index("posted-x") < ctx.steps.index("tiktok-id-1")
