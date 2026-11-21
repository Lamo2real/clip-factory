"""Production jobs: the stale-heartbeat fence, progress and the story agent client (CONTRACTS §45.5, §45.9.1)."""

from __future__ import annotations

import io
import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.agent_client import AgentError
from clipfactory_api.app import App
from clipfactory_api.workspaces import agent as story_agent
from clipfactory_api.workspaces import jobs, shapes
from conftest import NOW, Call, Clock
from fakes import FakeAgentCore, FakeS3, FakeTable, client_error
from ws_support import ARN, BASE, install, pk, seed_character, seed_job, seed_story

STOPPED = "Making the video stopped. Tap Try again."


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


def _running(
    store: db.Store, s3_client: FakeS3, *, minutes: float, status: str = "running", **story: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    item = seed_story(store, s3_client, status="producing", stale=["sound"], **story)
    steps = [
        {"key": k, "label": k, "status": s}
        for k, s in zip(
            shapes.STEP_ORDER,
            ["done", "done", "done", "running", "pending", "pending", "pending", "pending"],
            strict=True,
        )
    ]
    if status == "queued":
        steps = [{**s, "status": "pending"} for s in steps]
    beat = (NOW - timedelta(minutes=minutes)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    job = seed_job(store, item, status=status, steps=steps, heartbeatAt=beat)
    store.update(item["pk"], item["sk"], {"currentJobId": job["jobId"], "lastJobId": job["jobId"]})
    return item, job


def test_a_running_job_without_a_heartbeat_for_6_minutes_is_failed_on_read(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    story, job = _running(store, s3_client, minutes=6.5)
    status, body = call("GET", f"{BASE}/stories/{story['storyId']}")
    assert status == 200
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == STOPPED
    assert [s["status"] for s in body["job"]["steps"]][3] == "failed"
    assert body["job"]["steps"][3]["message"] == STOPPED
    assert body["story"]["status"] == "failed"
    # The failed step and every later one, added to what was stale.
    assert body["story"]["stale"] == ["animation", "sound", "captions", "assemble", "preview"]
    assert body["story"]["currentJobId"] is None
    stored = store.get(job["pk"], job["sk"])
    assert stored is not None
    assert stored["sessionId"] != job["sessionId"]
    assert agentcore.stopped == [job["sessionId"]]
    assert body["story"]["version"] == story["version"] + 1


def test_a_queued_job_is_failed_after_3_minutes_a_fresh_one_is_not(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    old, _ = _running(store, s3_client, minutes=3.5, status="queued")
    fresh, fresh_job = _running(store, s3_client, minutes=5)
    assert call("GET", f"{BASE}/stories/{old['storyId']}")[1]["job"]["status"] == "failed"
    body = call("GET", f"{BASE}/stories/{fresh['storyId']}")[1]
    assert body["job"]["status"] == "running"
    assert body["story"]["status"] == "producing"
    assert store.get(fresh_job["pk"], fresh_job["sk"])["sessionId"] == fresh_job["sessionId"]  # type: ignore[index]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "/stories", None),
        ("GET", "/dashboard", None),
        ("POST", "/stories/{sid}/produce", {"from": "storyboard"}),
        ("POST", "/stories/{sid}/cancel", None),
        ("GET", "/stories/{sid}/jobs", None),
    ],
)
def test_every_read_that_checks_a_job_runs_the_fence(
    call: Call, store: db.Store, s3_client: FakeS3, method: str, path: str, body: Any
) -> None:
    story, job = _running(store, s3_client, minutes=7)
    status, _ = call(method, BASE + path.format(sid=story["storyId"]), body)
    assert status in {200, 202}
    assert store.get(job["pk"], job["sk"])["status"] == "failed"  # type: ignore[index]


def test_character_delete_runs_the_fence_too(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    hero = seed_character(store)
    _, job = _running(store, s3_client, minutes=7, characterIds=[hero["characterId"]])
    assert call("DELETE", f"{BASE}/characters/{hero['characterId']}")[0] == 204
    assert store.get(job["pk"], job["sk"])["status"] == "failed"  # type: ignore[index]


def test_a_refused_fence_returns_what_is_stored(store: db.Store, s3_client: FakeS3, clock: Clock) -> None:
    story, job = _running(store, s3_client, minutes=7)
    store.update(job["pk"], job["sk"], {"heartbeatAt": "2026-11-15T11:59:30.000Z", "status": "running"})  # it woke up
    out = jobs.settle(store, job, clock(), story=story)
    assert out is not None
    assert out["status"] == "running"
    assert out["heartbeatAt"] == "2026-11-15T11:59:30.000Z"
    assert store.get(story["pk"], story["sk"])["status"] == "producing"  # type: ignore[index]


def test_a_job_whose_story_moved_on_is_failed_alone(store: db.Store, s3_client: FakeS3, clock: Clock) -> None:
    story, job = _running(store, s3_client, minutes=7)
    store.update(story["pk"], story["sk"], {"status": "review"}, remove=["currentJobId"])
    out = jobs.settle(store, job, clock())
    assert out is not None
    assert out["status"] == "failed"
    assert store.get(story["pk"], story["sk"])["status"] == "review"  # type: ignore[index]


def test_a_portrait_job_is_fenced_with_its_own_sentence(store: db.Store, clock: Clock) -> None:
    job = seed_job(
        store,
        None,
        contentType="character",
        jobType="portrait",
        heartbeatAt="2026-11-15T11:50:00.000Z",
        steps=[{"key": "portrait", "label": "Draw the picture", "status": "running"}],
    )
    out = jobs.settle(store, job, clock())
    assert out is not None
    assert out["error"] == "Making the picture stopped. Tap Try again."


def test_progress_counts_done_skipped_and_the_running_share() -> None:
    steps = [
        {"status": "done"},
        {"status": "skipped"},
        {"status": "running", "i": 1, "n": 4},
        {"status": "pending"},
    ]
    assert shapes.progress(steps) == pytest.approx((2 + 0.25) / 4)
    assert shapes.progress([]) == 0.0
    assert shapes.progress([{"status": "done"}]) == 1.0


def test_new_jobs_hold_every_step_and_the_run() -> None:
    steps = jobs.story_steps(["captions", "assemble", "preview"], shapes.STEP_ORDER)
    assert [s["status"] for s in steps] == ["done"] * 5 + ["pending"] * 3
    assert jobs.story_steps(["storyboard"], [])[1]["status"] == "skipped"
    job = jobs.new_job(
        "u",
        "stories",
        job_id="01J0000000000000000000000J",
        content_type="animation",
        content_id="s",
        job_type="produce",
        run=["captions"],
        steps=steps,
        now=NOW,
    )
    assert job["sk"] == "PJOB#01J0000000000000000000000J"
    assert job["heartbeatAt"] == job["createdAt"] == "2026-11-15T12:00:00.000Z"
    assert job["status"] == "queued"
    assert job["configuration"] == {"run": ["captions"]}
    assert job["progress"] == pytest.approx(5 / 8)


# --- the agent client -------------------------------------------------------------------------------------------


def test_session_ids_are_long_enough_and_random() -> None:
    first = story_agent.new_session_id("01J0000000000000000000000J")
    second = story_agent.new_session_id("01J0000000000000000000000J")
    assert first.startswith("cfstory-01J0000000000000000000000J-")
    assert len(first) == 43
    assert len(first) >= story_agent.MIN_SESSION_LENGTH == 33
    assert first != second
    with pytest.raises(ValueError, match="too short"):
        story_agent.new_session_id("x")


class FlakyAgentCore(FakeAgentCore):
    def __init__(self, errors: list[Exception]) -> None:
        super().__init__()
        self.errors = errors

    def invoke_agent_runtime(self, **kw: Any) -> dict[str, Any]:
        if self.errors:
            self.calls.append({**kw, "payload": json.loads(kw["payload"])})
            raise self.errors.pop(0)
        return super().invoke_agent_runtime(**kw)


def test_two_attempts_on_a_retryable_error_one_on_others() -> None:
    flaky = FlakyAgentCore([client_error("ThrottlingException", 429)])
    agent = story_agent.StoryAgent(flaky, ARN)
    agent.start_story(user_id="u", workspace_id="stories", story_id="s", job_id="j", session_id="cfstory-j-x")
    assert len(flaky.calls) == 2
    hard = FlakyAgentCore([client_error("ValidationException", 400)])
    with pytest.raises(AgentError):
        story_agent.StoryAgent(hard, ARN).start_story(
            user_id="u", workspace_id="stories", story_id="s", job_id="j", session_id="x"
        )
    assert len(hard.calls) == 1
    twice = FlakyAgentCore([client_error("ThrottlingException", 429)] * 3)
    with pytest.raises(AgentError):
        story_agent.StoryAgent(twice, ARN).cancel_story("j", "x")
    assert len(twice.calls) == 2


def test_stop_session_treats_a_gone_session_as_done() -> None:
    core = FakeAgentCore()
    core.live_sessions = set()
    story_agent.StoryAgent(core, ARN).stop_session("cfstory-gone")
    core.fail = True
    with pytest.raises(AgentError):
        story_agent.StoryAgent(core, ARN).stop_session("cfstory-x")
    with pytest.raises(AgentError, match="AGENT_RUNTIME_ARN"):
        story_agent.StoryAgent(FakeAgentCore(), "").start_story(
            user_id="u", workspace_id="w", story_id="s", job_id="j", session_id="x"
        )


def test_the_client_is_made_on_first_use(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[int] = []
    core = FakeAgentCore()

    def factory() -> FakeAgentCore:
        made.append(1)
        return core

    agent = story_agent.StoryAgent(factory, ARN)
    assert made == []
    agent.cancel_story("j", "s")
    agent.cancel_story("j", "s")
    assert made == [1]
    assert len(core.calls) == 2
    monkeypatch.delenv("AGENT_RUNTIME_ARN", raising=False)
    assert story_agent.from_env() is None
    monkeypatch.setenv("AGENT_RUNTIME_ARN", ARN)
    found = story_agent.from_env()
    assert found is not None
    assert found.runtime_arn == ARN


def test_a_5xx_answer_body_is_retryable() -> None:
    class Busy(FakeAgentCore):
        def invoke_agent_runtime(self, **kw: Any) -> dict[str, Any]:
            self.calls.append(kw)
            return {"statusCode": 503, "response": io.BytesIO(b"{}")}

    busy = Busy()
    with pytest.raises(AgentError):
        story_agent.StoryAgent(busy, ARN).start_portrait(
            user_id="u", workspace_id="w", character_id="c", job_id="j", session_id="x"
        )
    assert len(busy.calls) == 2


def test_fenced_writes_only_touch_the_workspace_partition(
    call: Call, store: db.Store, s3_client: FakeS3, table: FakeTable
) -> None:
    story, _ = _running(store, s3_client, minutes=9)
    table.calls.clear()
    call("GET", f"{BASE}/stories/{story['storyId']}")
    written = [
        a.get("Update", a.get("Put", {}))
        for op, kw in table.calls
        if op == "transact_write_items"
        for a in kw["TransactItems"]
    ]
    assert written
    assert all(w["Key"]["pk"] == pk() for w in written)


def test_no_second_try_after_a_slow_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    ticks = iter([0.0, 21.0, 30.0, 31.0])
    monkeypatch.setattr(story_agent.time, "monotonic", lambda: next(ticks))
    slow = FlakyAgentCore([client_error("RequestTimeout", 408), client_error("RequestTimeout", 408)])
    with pytest.raises(AgentError):
        story_agent.StoryAgent(slow, ARN).cancel_story("j", "x")
    assert len(slow.calls) == 1
