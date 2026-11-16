"""The durable flows (docs/CONTRACTS.md §14.4, §14.5, §14.12), driven by ``FakeDurableContext``."""

from __future__ import annotations

import json
from typing import Any

import pytest
from aws_durable_execution_sdk_python import CallbackExternalError, CallbackTimeoutError
from aws_durable_execution_sdk_python.config import StepSemantics

from clipfactory_api import db, posts, s3
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.flows import TransientError, error_type
from clipfactory_api.flows.clip_flow import ClipFlowDeps, run_clip_flow, summed_performance
from clipfactory_api.flows.job_flow import STOPPED_MESSAGE, JobFlowDeps, clip_count_from, run_job_flow
from clipfactory_api.jobs import START_FAILED
from clipfactory_api.platforms import (
    Metrics,
    NotConnectedError,
    Published,
    PublishError,
    ResponseMeta,
    RetryablePublishError,
    StatsBatch,
)
from clipfactory_api.vectors import Vectors
from conftest import USER, Clock, seed_clip, seed_job
from fakes import FakeAgentCore, FakeBedrock, FakeCallback, FakeDurableContext, FakeS3, FakeS3Vectors, FakeTable

RUNTIME = "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent"
NEWER_SESSION = "cfjob-01JNEWERRUNSESSIONXXXXXXXX-abcdefgh"


# --- job-flow ------------------------------------------------------------------------------------------------------


def _job_deps(store: db.Store, agentcore: FakeAgentCore) -> JobFlowDeps:
    return JobFlowDeps(store=store, agent=AgentClient(agentcore, RUNTIME), clock=Clock())


def _job_event(job: dict[str, Any]) -> dict[str, Any]:
    return {"jobId": job["jobId"], "userId": USER, "sessionId": job["sessionId"], "run": 1}


def _external(error_type: str, message: str) -> CallbackExternalError:
    return CallbackExternalError(message=message, error_type=error_type)


def test_job_flow_success_finishes(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")
    ctx = FakeDurableContext(FakeCallback(result=json.dumps({"jobId": job["jobId"], "clipCount": 7})))
    out = run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    assert out == {"jobId": job["jobId"], "outcome": "ready"}
    assert ctx.steps == ["start-agent", "finish"]
    ((name, config),) = ctx.callbacks
    assert name == "agent-done"
    assert config.timeout_seconds == 8 * 3600
    assert config.heartbeat_timeout_seconds == 15 * 60
    (invocation,) = agentcore.calls
    assert invocation["runtimeSessionId"] == job["sessionId"]
    assert invocation["payload"] == {
        "action": "process_job",
        "jobId": job["jobId"],
        "userId": USER,
        "callbackId": "cb-123",
    }
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert (stored["status"], stored["clipCount"]) == ("ready", 7)


def test_job_flow_finish_leaves_a_ready_job_alone(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")

    def agent_finishes(**kw: Any) -> dict[str, Any]:
        table.items[(job["pk"], job["sk"])].update({"status": "ready", "clipCount": 5})
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = agent_finishes  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(result=json.dumps({"jobId": job["jobId"], "clipCount": 9})))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "ready"
    assert table.raw(job["pk"], job["sk"])["clipCount"] == 5  # type: ignore[index]
    assert not [c for c in table.calls if c[0] == "update_item"]


@pytest.mark.parametrize(
    "error",
    [
        CallbackTimeoutError(message="Callback timed out"),
        CallbackTimeoutError(message="heartbeat timed out"),
    ],
)
def test_job_flow_timeout_or_missed_heartbeat_fails_the_job(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable, error: Exception
) -> None:
    job = seed_job(store, status="queued")
    ctx = FakeDurableContext(FakeCallback(error=error))
    out = run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    assert out == {"jobId": job["jobId"], "outcome": "failed"}
    assert ctx.steps == ["start-agent", "fail", "stop-session"]
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["status"] == "failed"
    assert stored["error"] == STOPPED_MESSAGE == "The agent stopped responding. Press Retry."
    assert agentcore.stopped == [job["sessionId"]]


def test_job_flow_marks_running_steps_failed(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")

    def agent_starts(**kw: Any) -> dict[str, Any]:
        table.items[(job["pk"], job["sk"])]["status"] = "running"
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = agent_starts  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(error=CallbackTimeoutError(message="timed out")))
    run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["steps"][0]["status"] == "failed"
    assert stored["steps"][0]["message"] == STOPPED_MESSAGE
    assert stored["updatedAt"] == "2026-11-15T12:00:00.000Z"


def test_job_flow_job_failed_keeps_the_agents_message(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="queued")
    ctx = FakeDurableContext(FakeCallback(error=_external("JobFailed", "This video is private. Try another link.")))
    out = run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    assert out["outcome"] == "failed"
    assert table.raw(job["pk"], job["sk"])["error"] == "This video is private. Try another link."  # type: ignore[index]


def test_job_flow_job_failed_already_written_by_the_agent(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="queued")

    def agent_fails(**kw: Any) -> dict[str, Any]:
        table.items[(job["pk"], job["sk"])].update({"status": "failed", "error": "Agent's words."})
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = agent_fails  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(error=_external("JobFailed", "Agent's words.")))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "failed"
    assert table.raw(job["pk"], job["sk"])["error"] == "Agent's words."  # type: ignore[index]
    assert not [c for c in table.calls if c[0] == "update_item"]


@pytest.mark.parametrize(("kind", "outcome"), [("Canceled", "canceled"), ("Superseded", "superseded")])
def test_job_flow_canceled_or_superseded_writes_nothing(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable, kind: str, outcome: str
) -> None:
    job = seed_job(store, status="queued")
    ctx = FakeDurableContext(FakeCallback(error=_external(kind, "stopped")))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == outcome
    assert ctx.steps == ["start-agent", "fail"]
    assert not [c for c in table.calls if c[0] == "update_item"]
    assert agentcore.stopped == []


def test_job_flow_skips_start_when_the_job_is_no_longer_queued(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="canceled")
    ctx = FakeDurableContext()
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore)) == {
        "jobId": job["jobId"],
        "outcome": "superseded",
    }
    assert ctx.steps == ["start-agent"]
    assert ctx.callback.waited == 0  # no waiting for a callback that never comes
    assert agentcore.calls == []


def test_job_flow_skips_start_for_an_old_session(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")
    table.items[(job["pk"], job["sk"])]["sessionId"] = NEWER_SESSION
    ctx = FakeDurableContext()
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "superseded"
    assert agentcore.calls == []


def test_job_flow_read_timeout_after_the_agent_began_still_waits_for_the_callback(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    from botocore.exceptions import ReadTimeoutError

    job = seed_job(store, status="queued")

    def began_then_timed_out(**kw: Any) -> dict[str, Any]:
        agentcore.calls.append({**kw, "payload": json.loads(kw["payload"])})
        table.items[(job["pk"], job["sk"])]["status"] = "running"  # Tracker.begin() on the agent
        raise ReadTimeoutError(endpoint_url="https://bedrock-agentcore.eu-north-1.amazonaws.com")

    agentcore.invoke_agent_runtime = began_then_timed_out  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(error=CallbackTimeoutError(message="heartbeat timed out")))
    out = run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    assert ctx.attempts["start-agent"] == 2
    assert len(agentcore.calls) == 1  # the retry sees this run's 'running' and does not re-invoke
    assert ctx.callback.waited == 1  # the heartbeat timeout still watches the run
    assert out == {"jobId": job["jobId"], "outcome": "failed"}
    assert ctx.steps == ["start-agent", "fail", "stop-session"]
    assert table.raw(job["pk"], job["sk"])["status"] == "failed"  # type: ignore[index]


def test_job_flow_replayed_start_after_the_agent_began_waits_for_the_callback(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="queued")

    def agent_begins(**kw: Any) -> dict[str, Any]:
        agentcore.calls.append(kw)
        table.items[(job["pk"], job["sk"])]["status"] = "running"
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = agent_begins  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(result=json.dumps({"clipCount": 2})), replay={"start-agent"})
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "ready"
    assert len(agentcore.calls) == 1
    assert ctx.results["start-agent"] == {"skipped": False}
    assert ctx.callback.waited == 1


def test_job_flow_resends_start_while_still_queued(store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="queued")
    ctx = FakeDurableContext(FakeCallback(result=json.dumps({"clipCount": 1})), replay={"start-agent"})
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "ready"
    assert len(agentcore.calls) == 2  # the agent ignores the duplicate process_job
    assert {c["runtimeSessionId"] for c in agentcore.calls} == {job["sessionId"]}


@pytest.mark.parametrize("status", ["ready", "failed", "canceled"])
def test_job_flow_skips_start_for_an_ended_job(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable, status: str
) -> None:
    job = seed_job(store, status=status)
    ctx = FakeDurableContext()
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "superseded"
    assert ctx.callback.waited == 0
    assert agentcore.calls == []


def test_job_flow_session_fence_on_fail(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")

    def retried_meanwhile(**kw: Any) -> dict[str, Any]:
        table.items[(job["pk"], job["sk"])].update({"sessionId": NEWER_SESSION, "status": "queued"})
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = retried_meanwhile  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(error=CallbackTimeoutError(message="timed out")))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "superseded"
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["status"] == "queued"
    assert stored["sessionId"] == NEWER_SESSION
    assert agentcore.stopped == []


def test_job_flow_session_fence_on_finish(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")

    def retried_meanwhile(**kw: Any) -> dict[str, Any]:
        table.items[(job["pk"], job["sk"])].update({"sessionId": NEWER_SESSION, "status": "running"})
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = retried_meanwhile  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(result=json.dumps({"clipCount": 3})))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "superseded"
    assert table.raw(job["pk"], job["sk"])["status"] == "running"  # type: ignore[index]


def test_job_flow_write_conditions_carry_the_session(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="queued")
    run_job_flow(
        FakeDurableContext(FakeCallback(error=CallbackTimeoutError(message="t"))),
        _job_event(job),
        _job_deps(store, agentcore),
    )
    run_job_flow(FakeDurableContext(), _job_event(seed_job(store, status="queued")), _job_deps(store, agentcore))
    updates = [kw for op, kw in table.calls if op == "update_item"]
    assert len(updates) == 2
    for kw in updates:
        assert "sessionId" in kw["ExpressionAttributeNames"].values()


def test_job_flow_start_retries_transient_errors(store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="queued")
    agentcore.fail = True  # 503
    ctx = FakeDurableContext()
    out = run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))
    assert out["outcome"] == "failed"
    assert ctx.attempts["start-agent"] == 3
    assert ctx.steps == ["start-agent", "fail"]
    assert store.get(job["pk"], job["sk"])["error"] == START_FAILED  # type: ignore[index]


def test_job_flow_start_refused_is_not_retried(store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="queued")
    agentcore.reply = {"accepted": False}
    ctx = FakeDurableContext()
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "failed"
    assert ctx.attempts["start-agent"] == 1


def test_job_flow_stop_session_errors_are_ignored(store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="queued")

    def broken(**_: Any) -> dict[str, Any]:
        raise RuntimeError("boom")

    agentcore.stop_runtime_session = broken  # type: ignore[method-assign]
    ctx = FakeDurableContext(FakeCallback(error=CallbackTimeoutError(message="t")))
    assert run_job_flow(ctx, _job_event(job), _job_deps(store, agentcore))["outcome"] == "failed"
    assert ctx.results["stop-session"] == {"stopped": False}


def test_job_flow_bad_event(store: db.Store, agentcore: FakeAgentCore) -> None:
    ctx = FakeDurableContext()
    assert run_job_flow(ctx, {"jobId": "J"}, _job_deps(store, agentcore)) == {"jobId": "J", "outcome": "bad_event"}
    assert ctx.steps == []


def test_clip_count_from_result() -> None:
    assert clip_count_from('{"jobId": "J", "clipCount": 4}') == 4
    assert clip_count_from(b'{"clipCount": 0}') == 0
    assert clip_count_from("not json") is None
    assert clip_count_from('{"clipCount": -1}') is None
    assert clip_count_from(None) is None


def test_error_type_reads_the_callback_checkpoint() -> None:
    class Checkpoint:
        class error:
            type = "Canceled"

    class State:
        def get_checkpoint_result(self, operation_id: str) -> Any:
            assert operation_id == "op-9"
            return Checkpoint()

    class Callback:
        state = State()
        operation_id = "op-9"

    sdk_error = CallbackExternalError(message="stopped")
    assert error_type(sdk_error, Callback()) == "Canceled"
    assert error_type(sdk_error) is None  # the SDK's own class name is not the external type
    assert error_type(_external("JobFailed", "x")) == "JobFailed"


def test_handlers_are_durable_and_build_deps_once() -> None:
    from clipfactory_api.flows import clip_flow, job_flow

    calls = []

    def factory() -> Any:
        calls.append(1)
        return object()

    job_flow._deps = None
    assert job_flow.get_deps(factory) is job_flow.get_deps(factory)
    assert len(calls) == 1
    job_flow._deps = None
    assert callable(job_flow.handler)
    assert callable(clip_flow.handler)
    assert job_flow.handler.__wrapped__ is not None  # type: ignore[attr-defined]


# --- clip-flow -----------------------------------------------------------------------------------------------------


class FakeAdapter:
    def __init__(self, platform: str, *, fail: list[Exception] | None = None, idempotent: bool = True) -> None:
        self.platform = platform
        self.idempotent = idempotent
        self.fail = list(fail or [])
        self.published: list[str] = []
        self.metric_failures: list[Exception] = []
        self.stats_calls = 0

    def publish(self, clip: dict[str, Any], account: dict[str, Any] | None, *, idempotency_key: str) -> Published:
        if self.fail:
            raise self.fail.pop(0)
        self.published.append(idempotency_key)
        return Published(
            url=f"https://{self.platform}.example/{idempotency_key}",
            posted_at="2026-11-15T12:00:00.000Z",
            platform_post_id=f"{self.platform}-{idempotency_key}",
            stats_id=f"{self.platform}-{idempotency_key}",
        )

    def metrics(self, post: dict[str, Any], account: dict[str, Any] | None) -> Metrics:
        return Metrics(views=1000, likes=50, comments=5, shares=7)

    def fetch_stats(
        self, posts: list[dict[str, Any]], account: dict[str, Any] | None, *, now: Any, want_insights: bool, http: Any
    ) -> StatsBatch:
        """Like a real adapter: a platform 5xx comes back as the batch's status (refresh tries twice more)."""
        self.stats_calls += 1
        if self.metric_failures:
            failure = self.metric_failures.pop(0)
            if isinstance(failure, NotConnectedError):
                raise failure
            return StatsBatch(
                errors={p["postId"]: str(failure) for p in posts}, meta=ResponseMeta(status=503), requests=1
            )
        results = {p["postId"]: {"views": 1000, "likes": 50, "comments": 5, "shares": 7, "extra": {}} for p in posts}
        return StatsBatch(results=results, requests=1)


class PendingAdapter(FakeAdapter):
    def publish(self, clip: dict[str, Any], account: dict[str, Any] | None, *, idempotency_key: str) -> Published:
        raise NotConnectedError("not yet")


def _connect(store: db.Store, *platforms: str) -> None:
    for platform in platforms:
        store.put(
            {
                "pk": db.user_pk(USER),
                "sk": f"ACCOUNT#{platform}#1",
                "type": "account",
                "userId": USER,
                "platform": platform,
                "status": "connected",
            }
        )


def _kept_clip(store: db.Store, **fields: Any) -> dict[str, Any]:
    return seed_clip(
        store,
        **{
            "status": "confirmed",
            "publishState": "started",
            "flowRun": 1,
            "decidedAt": "2026-11-15T11:59:00.000Z",
            **fields,
        },
    )


def _clip_deps(
    store: db.Store,
    adapters: dict[str, FakeAdapter],
    bedrock: FakeBedrock | None = None,
    vectors: Vectors | None = None,
) -> ClipFlowDeps:
    sleeps: list[float] = []
    return ClipFlowDeps(
        store=store,
        bedrock=bedrock or FakeBedrock(),
        model_id="global.anthropic.claude-fable-5-1",
        vectors=vectors,
        media=s3.Media(FakeS3(), "cf-prod-media-123"),
        builtins=list,
        adapters=lambda p: adapters.get(p) or PendingAdapter(p),
        clock=Clock(),
        sleep=sleeps.append,
    )


def _event(clip: dict[str, Any], run: int = 1) -> dict[str, Any]:
    return {"clipId": clip["clipId"], "userId": USER, "run": run}


def test_clip_flow_pending_only_posts_end_not_posted_without_waiting(
    store: db.Store, vectors: Vectors, s3v: FakeS3Vectors, table: FakeTable
) -> None:
    clip = _kept_clip(store)
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {}, vectors=vectors))
    assert out == {"clipId": clip["clipId"], "outcome": "not_posted"}
    assert ctx.steps == ["ensure-posts", "settle-clip", "upsert-vector"]
    assert ctx.waits == []
    found = posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)
    assert {p["status"] for p in found} == {"pending_integration"}
    assert len(found) == 5
    stored = table.raw(clip["pk"], clip["sk"])
    assert stored is not None
    assert stored["status"] == "confirmed"
    assert stored["postsCreated"] is True
    vector = s3v.vectors[clip["clipId"]]
    assert vector["metadata"]["status"] == "confirmed"
    assert vector["metadata"]["userId"] == USER


def test_clip_flow_ensure_posts_is_a_no_op_after_confirm(store: db.Store) -> None:
    clip = _kept_clip(store)
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {}))
    first = sorted(p["postId"] for p in ctx.results["ensure-posts"])
    ctx2 = FakeDurableContext()
    run_clip_flow(ctx2, _event(clip), _clip_deps(store, {}))
    assert sorted(p["postId"] for p in ctx2.results["ensure-posts"]) == first
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 5


def test_clip_flow_publishes_waits_measures_distils_and_updates_the_vector(
    store: db.Store, vectors: Vectors, s3v: FakeS3Vectors, table: FakeTable
) -> None:
    _connect(store, "youtube", "tiktok")
    clip = _kept_clip(store)
    adapters = {"youtube": FakeAdapter("youtube"), "tiktok": FakeAdapter("tiktok")}
    bedrock = FakeBedrock()
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, adapters, bedrock, vectors))
    assert out["outcome"] == "done"
    assert out["learningId"]
    assert ctx.steps == [
        "ensure-posts",
        "publish-youtube",
        "publish-tiktok",
        "settle-clip",
        "metrics",
        "distil",
        "upsert-vector",
    ]
    assert ctx.waits == [("wait-48h", 48 * 3600)]
    assert ctx.configs["publish-youtube"].step_semantics == StepSemantics.AT_LEAST_ONCE_PER_RETRY
    by_platform = {p["platform"]: p for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)}
    youtube = by_platform["youtube"]
    assert youtube["status"] == "posted"
    assert youtube["url"].startswith("https://youtube.example/")
    assert youtube["perfCheckAt"] == "2026-11-17T12:00:00.000Z"
    assert youtube["metrics"]["views"] == 1000
    assert by_platform["x"]["status"] == "pending_integration"
    assert adapters["youtube"].published == [youtube["postId"]]  # the post id is the idempotency key
    assert table.raw(clip["pk"], clip["sk"])["status"] == "posted"  # type: ignore[index]
    learning = store.get(db.user_pk(USER), db.learning_sk(out["learningId"]))
    assert learning is not None
    vector = s3v.vectors[clip["clipId"]]
    assert vector["metadata"]["status"] == "performed"
    assert sorted(vector["metadata"]["platforms"]) == ["tiktok", "youtube"]
    performance = json.loads(vector["metadata"]["performance"])
    assert performance == {
        "views": 2000,
        "likes": 100,
        "comments": 10,
        "shares": 14,
        "posts": 2,
        "checkedAt": "2026-11-15T12:00:00.000Z",
    }
    (converse,) = bedrock.calls
    assert converse["modelId"] == "global.anthropic.claude-fable-5-1"
    assert converse["inferenceConfig"] == {"maxTokens": 4000}
    assert converse["additionalModelRequestFields"] == {"output_config": {"effort": "low"}}
    for banned in ("temperature", "topP", "topK"):
        assert banned not in converse["inferenceConfig"]


def test_clip_flow_sets_publishing_while_posts_are_queued(store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    seen: list[str] = []

    class Watching(FakeAdapter):
        def publish(self, clip: dict[str, Any], account: dict[str, Any] | None, *, idempotency_key: str) -> Published:
            seen.append(table.items[(db.user_pk(USER), db.clip_sk(clip["clipId"]))]["status"])
            return super().publish(clip, account, idempotency_key=idempotency_key)

    run_clip_flow(FakeDurableContext(), _event(clip), _clip_deps(store, {"youtube": Watching("youtube")}))
    assert seen == ["publishing"]


def test_clip_flow_queued_post_published_once_when_the_step_is_replayed(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    adapter = FakeAdapter("youtube")
    ctx = FakeDurableContext(replay={"publish-youtube", "ensure-posts", "settle-clip", "metrics", "upsert-vector"})
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": adapter}))
    assert len(adapter.published) == 1
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 5


def test_clip_flow_retries_a_retryable_publish_error(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    adapter = FakeAdapter("youtube", fail=[RetryablePublishError("rate limited")])
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": adapter}))
    assert ctx.attempts["publish-youtube"] == 2
    assert out["outcome"] == "done"
    assert len(adapter.published) == 1


def test_clip_flow_exhausted_retries_fail_the_post(store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    adapter = FakeAdapter("youtube", fail=[RetryablePublishError("down")] * 3)
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": adapter}))
    assert ctx.attempts["publish-youtube"] == 3
    assert "post-failed-youtube" in ctx.steps
    youtube = next(
        p for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) if p["platform"] == "youtube"
    )
    assert youtube["status"] == "failed"
    assert youtube["error"] == "Posting to YouTube did not work. Press Try again."
    # Every queued post failed: the clip shows "Try again"; nothing was posted, so no 48-hour wait.
    assert table.raw(clip["pk"], clip["sk"])["status"] == "failed"  # type: ignore[index]
    assert out["outcome"] == "not_posted"
    assert ctx.waits == []


def test_clip_flow_permanent_error_is_not_retried(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    adapter = FakeAdapter("youtube", fail=[PublishError("video rejected")])
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": adapter}))
    assert ctx.attempts["publish-youtube"] == 1
    assert "post-failed-youtube" in ctx.steps


def test_clip_flow_non_idempotent_adapter_runs_at_most_once_per_retry(store: db.Store) -> None:
    _connect(store, "x")
    clip = _kept_clip(store)
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {"x": FakeAdapter("x", idempotent=False)}))
    assert ctx.configs["publish-x"].step_semantics == StepSemantics.AT_MOST_ONCE_PER_RETRY


def test_clip_flow_disconnected_account_goes_back_to_pending(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": PendingAdapter("youtube")}))
    assert out["outcome"] == "not_posted"
    statuses = {p["platform"]: p["status"] for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)}
    assert statuses["youtube"] == "pending_integration"


def test_clip_flow_metrics_skip_a_failing_platform(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    _connect(store, "youtube", "tiktok")
    clip = _kept_clip(store)
    youtube, tiktok = FakeAdapter("youtube"), FakeAdapter("tiktok")
    youtube.metric_failures = [RetryablePublishError("busy")] * 3
    tiktok.metric_failures = [RetryablePublishError("busy")]
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": youtube, "tiktok": tiktok}, vectors=vectors))
    measured = ctx.results["metrics"]["measured"]
    assert [m["platform"] for m in measured] == ["tiktok"]
    assert json.loads(s3v.vectors[clip["clipId"]]["metadata"]["performance"])["posts"] == 1


def test_clip_flow_nothing_measured_keeps_the_vector_confirmed(
    store: db.Store, vectors: Vectors, s3v: FakeS3Vectors
) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    youtube = FakeAdapter("youtube")
    youtube.metric_failures = [NotConnectedError("gone")]
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": youtube}, vectors=vectors))
    assert out["outcome"] == "done"
    assert ctx.results["distil"] == {"outcome": "no_metrics"}
    assert s3v.vectors[clip["clipId"]]["metadata"]["status"] == "confirmed"
    assert "performance" not in s3v.vectors[clip["clipId"]]["metadata"]


@pytest.mark.parametrize("stop", ["max_tokens", "refusal", "content_filtered"])
def test_clip_flow_distil_outcomes_write_no_learning(store: db.Store, stop: str) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    ctx = FakeDurableContext()
    out = run_clip_flow(
        ctx, _event(clip), _clip_deps(store, {"youtube": FakeAdapter("youtube")}, FakeBedrock(stop_reason=stop))
    )
    assert ctx.results["distil"] == {"outcome": stop}
    assert "learningId" not in out
    assert store.query_all(db.user_pk(USER), "LEARNING#") == []


def test_clip_flow_distil_failure_does_not_fail_the_flow(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    bedrock = FakeBedrock()
    bedrock.fail = True  # throttled every time
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, _event(clip), _clip_deps(store, {"youtube": FakeAdapter("youtube")}, bedrock))
    assert out["outcome"] == "done"
    assert ctx.attempts["distil"] == 3
    assert "upsert-vector" in ctx.steps


def test_clip_flow_vector_failure_does_not_fail_the_flow(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    clip = _kept_clip(store)
    s3v.fail = True
    ctx = FakeDurableContext()
    assert run_clip_flow(ctx, _event(clip), _clip_deps(store, {}, vectors=vectors))["outcome"] == "not_posted"
    assert ctx.attempts["upsert-vector"] == 3


def test_clip_flow_creates_a_missing_vector_from_the_clip(
    store: db.Store, vectors: Vectors, s3v: FakeS3Vectors
) -> None:
    clip = _kept_clip(store, score=6)
    run_clip_flow(FakeDurableContext(), _event(clip), _clip_deps(store, {}, vectors=vectors))
    metadata = s3v.vectors[clip["clipId"]]["metadata"]
    assert metadata["scoreBucket"] == "mid"
    assert metadata["title"] == clip["captions"]["youtubeTitle"]


def test_clip_flow_ignores_missing_or_unkept_clips(store: db.Store) -> None:
    review = seed_clip(store)
    ctx = FakeDurableContext()
    assert run_clip_flow(ctx, _event(review), _clip_deps(store, {}))["outcome"] == "skipped"
    assert posts.posts_for_clip(store, USER, review["clipId"], consistent=True) == []
    ctx = FakeDurableContext()
    gone = {"clipId": "01JGONEGONEGONEGONEGONEGON", "userId": USER, "run": 1}
    assert run_clip_flow(ctx, gone, _clip_deps(store, {}))["outcome"] == "missing"
    assert run_clip_flow(FakeDurableContext(), {}, _clip_deps(store, {}))["outcome"] == "bad_event"


def test_clip_flow_try_again_run_publishes_the_reset_posts(store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    failing = FakeAdapter("youtube", fail=[PublishError("no")])
    run_clip_flow(FakeDurableContext(), _event(clip), _clip_deps(store, {"youtube": failing}))
    assert table.raw(clip["pk"], clip["sk"])["status"] == "failed"  # type: ignore[index]
    youtube = next(
        p for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) if p["platform"] == "youtube"
    )
    # What "Try again" does in the API: the failed post goes back to queued and the clip to confirmed.
    store.update(youtube["pk"], youtube["sk"], {"status": "queued"}, remove=["error"])
    store.update(clip["pk"], clip["sk"], {"status": "confirmed", "flowRun": 2})
    ok = FakeAdapter("youtube")
    out = run_clip_flow(FakeDurableContext(), _event(clip, 2), _clip_deps(store, {"youtube": ok}))
    assert out["outcome"] == "done"
    assert ok.published == [youtube["postId"]]
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 5


def test_summed_performance() -> None:
    assert summed_performance({"measured": []}) is None
    rows = {
        "measured": [
            {"metrics": {"views": 1, "likes": 2, "comments": 3, "shares": 4, "checkedAt": "2026-11-17T12:00:00.000Z"}},
            {
                "metrics": {
                    "views": 10,
                    "likes": 20,
                    "comments": 30,
                    "shares": 40,
                    "checkedAt": "2026-11-17T12:01:00.000Z",
                }
            },
        ]
    }
    assert summed_performance(rows) == {
        "views": 11,
        "likes": 22,
        "comments": 33,
        "shares": 44,
        "posts": 2,
        "checkedAt": "2026-11-17T12:01:00.000Z",
    }


def test_transient_dynamodb_errors_are_retried(
    store: db.Store, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fakes import client_error

    clip = _kept_clip(store)
    real_get = table.get_item
    failures = [client_error("InternalServerError", 500)]

    def flaky(**kw: Any) -> dict[str, Any]:
        if failures:
            raise failures.pop()
        return real_get(**kw)

    monkeypatch.setattr(table, "get_item", flaky)
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, {}))
    assert ctx.attempts["ensure-posts"] == 2
    assert isinstance(TransientError("x"), Exception)


# --- clip-flow and the stats fields (§16.3, §16.5) ------------------------------------------------------------------


class PrivateTikTok(FakeAdapter):
    def publish(self, clip: dict[str, Any], account: dict[str, Any] | None, *, idempotency_key: str) -> Published:
        self.published.append(idempotency_key)
        return Published(
            url="https://www.tiktok.com/@owner",
            posted_at="2026-11-15T12:00:00.000Z",
            platform_post_id="v_pub_123",
            stats_id=None,
            privacy="private",
        )


def test_clip_flow_publish_writes_the_stats_fields(store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube", "tiktok")
    clip = _kept_clip(store)
    adapters = {"youtube": FakeAdapter("youtube"), "tiktok": PrivateTikTok("tiktok")}
    ctx = FakeDurableContext()
    run_clip_flow(ctx, _event(clip), _clip_deps(store, adapters))
    by = {p["platform"]: p for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)}
    youtube = by["youtube"]
    assert youtube["platformPostId"] == f"youtube-{youtube['postId']}"
    assert youtube["statsId"] == f"youtube-{youtube['postId']}"
    assert youtube["privacy"] == "public"
    assert youtube["statsDueAt"] == "2026-11-15T12:15:00.000Z"  # postedAt + minIntervalMinutes
    assert youtube["gsi2pk"] == "STATS"
    assert youtube["gsi2sk"].startswith("2026-11-15T12:")
    assert youtube["gsi2sk"].endswith(f"#{youtube['postId']}")
    tiktok = by["tiktok"]
    assert tiktok["status"] == "posted"
    assert tiktok["privacy"] == "private"
    assert tiktok["platformPostId"] == "v_pub_123"
    for absent in ("statsId", "statsDueAt", "gsi2pk", "gsi2sk"):
        assert absent not in tiktok  # never polled
    # The metrics step read youtube through the shared refresh: metrics, schedule and a first snapshot.
    assert youtube["metrics"]["views"] == 1000
    assert youtube["lastSnapshotAt"]
    assert store.query_all(db.user_pk(USER), f"STAT#{youtube['postId']}#")
    measured = ctx.results["metrics"]["measured"]
    assert [m["platform"] for m in measured] == ["youtube"]  # private TikTok: no numbers
    assert adapters["tiktok"].stats_calls == 0


def test_clip_flow_metrics_fall_back_to_stored_metrics_when_blocked(store: db.Store) -> None:
    _connect(store, "youtube")
    clip = _kept_clip(store)
    adapter = FakeAdapter("youtube")
    store.put({"pk": "RATE#youtube", "sk": "BUDGET", "type": "rate", "blockedUntil": "2026-11-20T08:00:00.000Z"})
    ctx = FakeDurableContext()
    deps = _clip_deps(store, {"youtube": adapter})
    # The poller stored numbers earlier; the flow's own read is blocked.
    original = deps.store.update

    def update(pk: str, sk: str, fields: dict[str, Any], **kw: Any) -> dict[str, Any]:
        if fields.get("status") == "posted":
            fields = {
                **fields,
                "metrics": {
                    "views": 77,
                    "likes": 7,
                    "comments": 1,
                    "shares": None,
                    "checkedAt": "2026-11-16T00:00:00.000Z",
                },
            }
        return original(pk, sk, fields, **kw)

    deps.store.update = update  # type: ignore[method-assign]
    out = run_clip_flow(ctx, _event(clip), deps)
    assert out["outcome"] == "done"
    (row,) = ctx.results["metrics"]["measured"]
    assert row["metrics"] == {
        "views": 77,
        "likes": 7,
        "comments": 1,
        "shares": None,
        "checkedAt": "2026-11-16T00:00:00.000Z",
    }
    assert adapter.stats_calls == 0
