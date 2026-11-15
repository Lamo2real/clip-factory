"""Publisher, perf check and watchdog."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db, posts
from clipfactory_api.perf_check import PerfCheck, run_event
from clipfactory_api.platforms import Metrics, NotConnectedError, Published, PublishError, adapter_for
from clipfactory_api.publisher import Publisher, process
from clipfactory_api.watchdog import STOPPED_MESSAGE, Watchdog
from conftest import NOW, USER, Clock, seed_clip, seed_job
from fakes import FakeBedrock, FakeScheduler, FakeTable

POSTED_AT = "2026-11-15T12:30:00.000Z"


class FakeAdapter:
    def __init__(self, platform: str, *, error: Exception | None = None, metrics: Metrics | None = None) -> None:
        self.platform = platform
        self.error = error
        self.published: list[str] = []
        self._metrics = metrics

    def publish(self, clip: dict[str, Any], account: dict[str, Any] | None) -> Published:
        if self.error:
            raise self.error
        self.published.append(clip["clipId"])
        return Published(url=f"https://{self.platform}.example/p/1", posted_at=POSTED_AT)

    def metrics(self, post: dict[str, Any], account: dict[str, Any] | None) -> Metrics:
        if self._metrics is None:
            raise NotConnectedError("not connected")
        return self._metrics


def _confirmed_clip_with_posts(store: db.Store, statuses: dict[str, str]) -> dict[str, Any]:
    clip = seed_clip(store, status="confirmed")
    for post in posts.create_posts(store, USER, clip["clipId"], list(statuses)):
        store.update(db.user_pk(USER), db.post_sk(post["postId"]), {"status": statuses[post["platform"]]})
    return clip


def _sqs_event(*bodies: Any) -> dict[str, Any]:
    return {
        "Records": [
            {"messageId": f"m{i}", "body": b if isinstance(b, str) else json.dumps(b)} for i, b in enumerate(bodies)
        ]
    }


def _publisher(store: db.Store, scheduler: FakeScheduler, adapters: dict[str, FakeAdapter]) -> Publisher:
    return Publisher(
        store=store,
        scheduler=scheduler,
        perf_check_arn="arn:aws:lambda:eu-north-1:123:function:cf-prod-perf-check",
        scheduler_role_arn="arn:aws:iam::123:role/cf-prod-scheduler",
        schedule_group="cf-prod",
        clock=Clock(),
        adapters=lambda p: adapters.get(p) or adapter_for(p),
    )


# --- publisher ------------------------------------------------------------------------------------------------


def test_publisher_posts_queued_and_schedules_perf_check(store: db.Store, table: FakeTable) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "queued", "x": "pending_integration"})
    youtube = FakeAdapter("youtube")
    scheduler = FakeScheduler()
    out = process(
        _sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, scheduler, {"youtube": youtube})
    )
    assert out == {"batchItemFailures": []}
    assert youtube.published == [clip["clipId"]]
    by_platform = {p["platform"]: p for p in posts.posts_for_clip(store, USER, clip["clipId"])}
    yt = by_platform["youtube"]
    assert yt["status"] == "posted"
    assert yt["url"] == "https://youtube.example/p/1"
    assert yt["postedAt"] == POSTED_AT
    assert yt["perfCheckAt"] == "2026-11-17T12:30:00.000Z"
    assert by_platform["x"]["status"] == "pending_integration"
    (schedule,) = scheduler.schedules.values()
    assert schedule["Name"] == f"perf-{yt['postId']}"
    assert schedule["GroupName"] == "cf-prod"
    assert schedule["ScheduleExpression"] == "at(2026-11-17T12:30:00)"
    assert schedule["ScheduleExpressionTimezone"] == "UTC"
    assert schedule["ActionAfterCompletion"] == "DELETE"
    assert json.loads(schedule["Target"]["Input"]) == {"userId": USER, "postId": yt["postId"]}
    assert table.raw(clip["pk"], clip["sk"])["status"] == "posted"  # type: ignore[index]


def test_publisher_reads_posts_consistently_not_through_gsi1(store: db.Store, table: FakeTable) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "queued"})
    other = seed_clip(store, status="confirmed")
    posts.create_posts(store, USER, other["clipId"], ["youtube"])  # another clip's post in the same partition
    youtube = FakeAdapter("youtube")
    table.calls.clear()
    process(
        _sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, FakeScheduler(), {"youtube": youtube})
    )
    assert youtube.published == [clip["clipId"]]
    queries = [
        kw for name, kw in table.calls if name == "query" and kw["ExpressionAttributeValues"][":prefix"] == "POST#"
    ]
    assert queries
    assert all(kw.get("ConsistentRead") is True and "IndexName" not in kw for kw in queries)


def test_consistent_query_on_an_index_is_refused(store: db.Store) -> None:
    with pytest.raises(ValueError, match="consistently"):
        store.query_all("CLIP#x", "POST#", index="gsi1", consistent=True)


def test_publisher_is_idempotent_on_redelivery(store: db.Store) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "queued"})
    youtube = FakeAdapter("youtube")
    publisher = _publisher(store, FakeScheduler(), {"youtube": youtube})
    event = _sqs_event({"userId": USER, "clipId": clip["clipId"]})
    process(event, publisher)
    assert process(event, publisher) == {"batchItemFailures": []}
    assert youtube.published == [clip["clipId"]]


def test_publisher_redelivery_creates_a_failed_perf_check_schedule(store: db.Store, table: FakeTable) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "queued"})
    youtube = FakeAdapter("youtube")
    scheduler = FakeScheduler()
    scheduler.fail_next = 1
    publisher = _publisher(store, scheduler, {"youtube": youtube})
    event = _sqs_event({"userId": USER, "clipId": clip["clipId"]})
    assert process(event, publisher) == {"batchItemFailures": [{"itemIdentifier": "m0"}]}
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    assert post["status"] == "posted"  # already on the platform: never sent again
    assert scheduler.schedules == {}
    assert process(event, publisher) == {"batchItemFailures": []}
    assert youtube.published == [clip["clipId"]]
    assert list(scheduler.schedules) == [f"perf-{post['postId']}"]
    assert table.raw(clip["pk"], clip["sk"])["status"] == "posted"  # type: ignore[index]


def test_publisher_does_not_schedule_a_past_perf_check(store: db.Store) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "posted"})
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    store.update(post["pk"], post["sk"], {"perfCheckAt": "2026-11-14T12:00:00.000Z"})
    scheduler = FakeScheduler()
    process(_sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, scheduler, {}))
    assert scheduler.schedules == {}


def test_publisher_stub_adapters_leave_posts_pending(store: db.Store, table: FakeTable) -> None:
    clip = _confirmed_clip_with_posts(store, {"tiktok": "queued"})
    process(_sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, FakeScheduler(), {}))
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    assert post["status"] == "pending_integration"
    assert table.raw(clip["pk"], clip["sk"])["status"] == "confirmed"  # type: ignore[index]


def test_publisher_records_permanent_failure(store: db.Store, table: FakeTable) -> None:
    clip = _confirmed_clip_with_posts(store, {"x": "queued"})
    x = FakeAdapter("x", error=PublishError("The video is too long for X."))
    assert (
        process(_sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, FakeScheduler(), {"x": x}))[
            "batchItemFailures"
        ]
        == []
    )
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    assert post["status"] == "failed"
    assert post["error"] == "The video is too long for X."
    assert table.raw(clip["pk"], clip["sk"])["status"] == "failed"  # type: ignore[index]


def test_publisher_retries_transient_failure(store: db.Store) -> None:
    clip = _confirmed_clip_with_posts(store, {"x": "queued"})
    x = FakeAdapter("x", error=PublishError("busy", retryable=True))
    out = process(_sqs_event({"userId": USER, "clipId": clip["clipId"]}), _publisher(store, FakeScheduler(), {"x": x}))
    assert out == {"batchItemFailures": [{"itemIdentifier": "m0"}]}
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    assert post["status"] == "queued"


def test_publisher_skips_bad_and_unknown_messages(store: db.Store) -> None:
    declined = seed_clip(store, status="declined")
    out = process(
        _sqs_event("not json", {"userId": USER}, {"userId": USER, "clipId": declined["clipId"]}),
        _publisher(store, FakeScheduler(), {}),
    )
    assert out == {"batchItemFailures": []}


def test_publisher_existing_schedule_is_fine(store: db.Store) -> None:
    clip = _confirmed_clip_with_posts(store, {"youtube": "queued"})
    scheduler = FakeScheduler()
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    scheduler.schedules[f"perf-{post['postId']}"] = {}
    out = process(
        _sqs_event({"userId": USER, "clipId": clip["clipId"]}),
        _publisher(store, scheduler, {"youtube": FakeAdapter("youtube")}),
    )
    assert out == {"batchItemFailures": []}


@pytest.mark.parametrize("platform", ["youtube", "instagram", "facebook", "tiktok", "x"])
def test_stub_adapters_report_not_connected(platform: str) -> None:
    adapter = adapter_for(platform)
    with pytest.raises(NotConnectedError):
        adapter.publish({}, None)
    with pytest.raises(NotConnectedError):
        adapter.metrics({}, None)


# --- perf check -----------------------------------------------------------------------------------------------


def _posted(store: db.Store) -> dict[str, Any]:
    clip = _confirmed_clip_with_posts(store, {"youtube": "posted"})
    (post,) = posts.posts_for_clip(store, USER, clip["clipId"])
    return post


def _check(store: db.Store, bedrock: FakeBedrock, adapter: FakeAdapter | None) -> PerfCheck:
    return PerfCheck(
        store=store,
        bedrock=bedrock,
        model_id="global.anthropic.claude-fable-5-1",
        clock=Clock(NOW + timedelta(hours=48)),
        adapters=lambda p: adapter or adapter_for(p),
    )


def test_perf_check_stores_metrics_and_learning(store: db.Store) -> None:
    post = _posted(store)
    bedrock = FakeBedrock()
    adapter = FakeAdapter("youtube", metrics=Metrics(views=1200, likes=90, comments=12, shares=30))
    out = run_event({"userId": USER, "postId": post["postId"]}, _check(store, bedrock, adapter))
    assert out == {"ok": True, "outcome": "learning"}
    stored = store.get(db.user_pk(USER), db.post_sk(post["postId"]))
    assert stored is not None
    assert stored["metrics"] == {
        "views": 1200,
        "likes": 90,
        "comments": 12,
        "shares": 30,
        "checkedAt": "2026-11-17T12:00:00.000Z",
    }
    (learning,) = store.query_all(db.user_pk(USER), "LEARNING#")
    assert learning["text"] == FakeBedrock().text
    assert learning["postIds"] == [post["postId"]]
    (request,) = bedrock.calls
    assert request["modelId"] == "global.anthropic.claude-fable-5-1"
    assert "1200" in request["messages"][0]["content"][0]["text"]
    # Fable 5.1 always thinks and thinking counts against maxTokens: leave room, ask for low effort, and never send
    # sampling settings or a thinking budget (each is a 400 on Fable).
    assert request["inferenceConfig"]["maxTokens"] >= 4000
    assert set(request["inferenceConfig"]) == {"maxTokens"}
    assert request["additionalModelRequestFields"] == {"output_config": {"effort": "low"}}


def test_perf_check_without_metrics_writes_nothing(store: db.Store) -> None:
    post = _posted(store)
    bedrock = FakeBedrock()
    out = run_event({"userId": USER, "postId": post["postId"]}, _check(store, bedrock, None))
    assert out == {"ok": True, "outcome": "no_metrics"}
    assert bedrock.calls == []
    assert store.query_all(db.user_pk(USER), "LEARNING#") == []


def test_perf_check_never_raises(store: db.Store) -> None:
    post = _posted(store)
    bedrock = FakeBedrock()
    bedrock.fail = True
    adapter = FakeAdapter("youtube", metrics=Metrics(1, 0, 0, 0))
    assert run_event({"userId": USER, "postId": post["postId"]}, _check(store, bedrock, adapter)) == {
        "ok": False,
        "outcome": "error",
    }
    assert (
        run_event({"userId": USER, "postId": "missing"}, _check(store, bedrock, adapter))["outcome"] == "post_missing"
    )
    assert run_event({}, _check(store, bedrock, adapter))["outcome"] == "bad_event"


def test_perf_check_empty_model_reply(store: db.Store) -> None:
    post = _posted(store)
    adapter = FakeAdapter("youtube", metrics=Metrics(1, 0, 0, 0))
    out = run_event({"userId": USER, "postId": post["postId"]}, _check(store, FakeBedrock(text="  "), adapter))
    assert out["outcome"] == "no_learning"


@pytest.mark.parametrize(
    ("stop_reason", "text", "outcome"),
    [
        ("max_tokens", "Rage moments with a face-cam hook get the", "max_tokens"),
        ("max_tokens", "", "max_tokens"),
        ("refusal", "I can't help with that.", "refusal"),
        ("content_filtered", "", "content_filtered"),
        ("", "Some text", "no_learning"),
    ],
)
def test_perf_check_only_learns_from_a_finished_answer(
    store: db.Store, stop_reason: str, text: str, outcome: str
) -> None:
    post = _posted(store)
    adapter = FakeAdapter("youtube", metrics=Metrics(1, 0, 0, 0))
    bedrock = FakeBedrock(text=text, stop_reason=stop_reason)
    out = run_event({"userId": USER, "postId": post["postId"]}, _check(store, bedrock, adapter))
    assert out == {"ok": True, "outcome": outcome}
    assert store.query_all(db.user_pk(USER), "LEARNING#") == []


# --- watchdog -------------------------------------------------------------------------------------------------


def test_watchdog_resumes_a_confirm_that_never_queued(store: db.Store, table: FakeTable) -> None:
    stuck = seed_clip(store, status="confirmed", publishState="pending", publishClaimAt="2026-11-15T11:50:00.000Z")
    fresh = seed_clip(store, status="confirmed", publishState="pending", publishClaimAt="2026-11-15T11:59:50.000Z")
    done = seed_clip(store, status="confirmed", publishState="enqueued", publishClaimAt="2026-11-15T10:00:00.000Z")
    sent: list[tuple[str, str]] = []
    result = Watchdog(store, Clock(), enqueue=lambda u, c: sent.append((u, c))).sweep()
    assert result["resumed"] == 1
    assert sent == [(USER, stuck["clipId"])]
    assert len(posts.posts_for_clip(store, USER, stuck["clipId"], consistent=True)) == 5
    assert table.raw(stuck["pk"], stuck["sk"])["publishState"] == "enqueued"  # type: ignore[index]
    assert table.raw(fresh["pk"], fresh["sk"])["publishState"] == "pending"  # type: ignore[index]
    assert posts.posts_for_clip(store, USER, done["clipId"], consistent=True) == []


def test_watchdog_keeps_a_confirm_pending_while_the_queue_fails(store: db.Store, table: FakeTable) -> None:
    stuck = seed_clip(store, status="confirmed", publishState="pending", publishClaimAt="2026-11-15T11:50:00.000Z")

    def broken(_u: str, _c: str) -> None:
        raise RuntimeError("sqs down")

    assert Watchdog(store, Clock(), enqueue=broken).sweep()["resumed"] == 1
    assert table.raw(stuck["pk"], stuck["sk"])["publishState"] == "pending"  # type: ignore[index]
    assert "resumed" not in Watchdog(store, Clock()).sweep()  # no queue configured: jobs only


def test_watchdog_fails_stale_running_job(store: db.Store, table: FakeTable) -> None:
    stale = seed_job(store, status="running", heartbeatAt="2026-11-15T11:40:00.000Z")
    fresh = seed_job(store, status="running", heartbeatAt="2026-11-15T11:50:00.000Z")
    done = seed_job(store, status="ready", heartbeatAt="2026-11-15T01:00:00.000Z")
    result = Watchdog(store, Clock()).sweep()
    assert result == {"checked": 2, "failed": 1}
    failed = table.raw(stale["pk"], stale["sk"])
    assert failed is not None
    assert failed["status"] == "failed"
    assert failed["error"] == STOPPED_MESSAGE
    assert failed["steps"][0]["status"] == "failed"
    assert table.raw(fresh["pk"], fresh["sk"])["status"] == "running"  # type: ignore[index]
    assert table.raw(done["pk"], done["sk"])["status"] == "ready"  # type: ignore[index]


def test_watchdog_fails_queued_job_never_picked_up(store: db.Store, table: FakeTable) -> None:
    old = seed_job(store, status="queued", heartbeatAt="2026-11-15T11:20:00.000Z")
    recent = seed_job(store, status="queued", heartbeatAt="2026-11-15T11:40:00.000Z")
    assert Watchdog(store, Clock()).sweep()["failed"] == 1
    assert table.raw(old["pk"], old["sk"])["status"] == "failed"  # type: ignore[index]
    assert table.raw(recent["pk"], recent["sk"])["status"] == "queued"  # type: ignore[index]


def test_watchdog_leaves_job_whose_heartbeat_moved(store: db.Store, table: FakeTable) -> None:
    job = seed_job(store, status="running", heartbeatAt="2026-11-15T11:00:00.000Z")
    watchdog = Watchdog(store, Clock())
    real_scan = store.scan_jobs

    def scan_then_heartbeat(statuses: Any) -> list[dict[str, Any]]:
        found = real_scan(statuses)
        table.items[(job["pk"], job["sk"])]["heartbeatAt"] = "2026-11-15T11:59:30.000Z"
        return found

    store.scan_jobs = scan_then_heartbeat  # type: ignore[method-assign]
    assert watchdog.sweep()["failed"] == 0
    assert table.raw(job["pk"], job["sk"])["status"] == "running"  # type: ignore[index]
