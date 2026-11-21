"""Production jobs: the stale-heartbeat fence, progress and the story agent client (CONTRACTS §45.5, §45.9.1)."""

from __future__ import annotations

import io
import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import agent as story_agent
from clipfactory_api.workspaces import jobs, shapes
from clipfactory_api.workspaces.agent import StoriesAgentError as AgentError
from conftest import NOW, Call, Clock
from fakes import FakeAgentCore, FakeS3, FakeTable, client_error
from ws_support import (
    ARN,
    BASE,
    Monotonic,
    SlowAgentCore,
    caller,
    install,
    pk,
    seed_character,
    seed_job,
    seed_story,
)


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


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
        story_agent.StoryAgent(twice, ARN).cancel("j", "x")
    assert len(twice.calls) == 2


def test_stop_session_treats_a_gone_session_as_done() -> None:
    core = FakeAgentCore()
    core.live_sessions = set()
    story_agent.StoryAgent(core, ARN).stop_session("cfstory-gone")
    core.fail = True
    with pytest.raises(AgentError):
        story_agent.StoryAgent(core, ARN).stop_session("cfstory-x")
    with pytest.raises(AgentError, match="STORIES_AGENT_RUNTIME_ARN"):
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
    agent.cancel("j", "s")
    agent.cancel("j", "s")
    assert made == [1]
    assert len(core.calls) == 2
    assert core.calls[0]["payload"] == {"action": "cancel", "id": "j"}
    monkeypatch.delenv("STORIES_AGENT_RUNTIME_ARN", raising=False)
    # Clip Factory's runtime ARN is never used: Lamo Stories stays off without its own.
    monkeypatch.setenv("AGENT_RUNTIME_ARN", "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent")
    assert story_agent.from_env() is None
    monkeypatch.setenv("STORIES_AGENT_RUNTIME_ARN", ARN)
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
        story_agent.StoryAgent(slow, ARN).cancel("j", "x")
    assert len(slow.calls) == 1


def test_every_action_names_its_item_on_lamo_stories_own_runtime() -> None:
    core = FakeAgentCore()
    agent = story_agent.StoryAgent(core, ARN)
    agent.start_story(user_id="u", workspace_id="w", story_id="s", job_id="j", session_id="x1")
    agent.start_portrait(user_id="u", workspace_id="w", character_id="c", job_id="j", session_id="x2")
    agent.start_reference(user_id="u", workspace_id="w", ref_id="r", job_id="j", session_id="x3")
    agent.start_task(user_id="u", workspace_id="w", task_id="t", kind="brainstorm", session_id="x4")
    agent.start_task(user_id="u", workspace_id="w", task_id="t", kind="check_models", session_id="x5")
    agent.start_chat_turn(user_id="u", workspace_id="w", conv_id="c", msg_id="m", session_id="x6")
    agent.cancel("j", "x1")
    base = {"userId": "u", "workspaceId": "w"}
    assert [c["payload"] for c in core.calls] == [
        {"action": "process_story", **base, "storyId": "s", "jobId": "j"},
        {"action": "process_portrait", **base, "characterId": "c", "jobId": "j"},
        {"action": "process_reference", **base, "refId": "r", "jobId": "j"},
        {"action": "run_task", **base, "taskId": "t"},
        {"action": "check_models", **base, "taskId": "t"},
        {"action": "chat_turn", **base, "convId": "c", "msgId": "m"},
        {"action": "cancel", "id": "j"},
    ]
    assert {c["agentRuntimeArn"] for c in core.calls} == {ARN}
    assert [c["runtimeSessionId"] for c in core.calls] == ["x1", "x2", "x3", "x4", "x5", "x6", "x1"]
    core.reply = {"accepted": False}
    with pytest.raises(AgentError):
        agent.start_task(user_id="u", workspace_id="w", task_id="t", kind="captions", session_id="x7")


def test_the_stories_agent_client_never_reaches_clip_factorys_runtime() -> None:
    """``workspaces/agent.py`` reads only ``STORIES_AGENT_RUNTIME_ARN`` and imports nothing of Clip Factory's agent
    client (CONTRACTS §45.5, ADR-76)."""
    import ast
    from pathlib import Path

    source = Path(story_agent.__file__).read_text()
    tree = ast.parse(source)
    imported = {n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)} | {
        a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names
    }
    assert not [m for m in imported if "agent_client" in m]
    strings = {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    assert "AGENT_RUNTIME_ARN" not in strings
    assert "STORIES_AGENT_RUNTIME_ARN" in strings
    assert "cf_prod_clip_agent" not in source
    assert story_agent.SESSION_PREFIX == "cfstory-"


def test_a_stale_chat_answer_is_failed_and_its_session_stopped(store: db.Store, clock: Clock) -> None:
    """``jobs.settle_message`` (for builder A2's chat routes): pending or streaming for 3 minutes without a heartbeat."""
    core = FakeAgentCore()
    agent = story_agent.StoryAgent(core, ARN)

    def message(msg_id: str, status: str, beat: str) -> dict[str, Any]:
        item = {
            "pk": pk(),
            "sk": f"MSG#01J0000000000000000000000C#{msg_id}",
            "type": "ws_msg",
            "userId": "u",
            "workspaceId": "stories",
            "convId": "01J0000000000000000000000C",
            "msgId": msg_id,
            "role": "assistant",
            "status": status,
            "sessionId": f"cfstory-{msg_id}-abcdefgh",
            "heartbeatAt": beat,
            "createdAt": beat,
        }
        store.put(item)
        return item

    old = message("01J0000000000000000000000D", "streaming", "2026-11-15T11:56:30.000Z")
    fresh = message("01J0000000000000000000000E", "pending", "2026-11-15T11:58:30.000Z")
    done = message("01J0000000000000000000000F", "done", "2026-11-15T11:00:00.000Z")
    settled = jobs.settle_message(store, old, NOW, stop=agent.stop_session)
    assert settled is not None
    assert settled["status"] == "failed"
    assert settled["error"] == "The answer stopped. Tap Try again."
    assert settled["sessionId"] != old["sessionId"]
    assert core.stopped == [old["sessionId"]]
    assert jobs.settle_message(store, fresh, NOW) == fresh
    assert jobs.settle_message(store, done, NOW) == done
    assert jobs.settle_message(store, None, NOW) is None
    # The agent wrote meanwhile: the fence is refused and what is stored is returned.
    store.update(fresh["pk"], fresh["sk"], {"heartbeatAt": "2026-11-15T11:59:59.000Z"})
    assert jobs.settle_message(store, fresh, NOW + timedelta(minutes=10))["status"] == "pending"


# --- best-effort calls stay inside the request's 29 s (§45.5, §45.9.1) ------------------------------------------


class QuickFlakyStop(FakeAgentCore):
    """StopRuntimeSession throttled (quickly) ``failures`` times, then fine."""

    def __init__(self, failures: int) -> None:
        super().__init__()
        self.failures = failures
        self.stop_calls = 0

    def stop_runtime_session(self, **kw: Any) -> dict[str, Any]:
        self.stop_calls += 1
        if self.failures:
            self.failures -= 1
            raise client_error("ThrottlingException", 429)
        return super().stop_runtime_session(**kw)


def test_a_slow_stop_is_never_tried_again(monkeypatch: pytest.MonkeyPatch) -> None:
    slow = SlowAgentCore(Monotonic(monkeypatch))
    with pytest.raises(AgentError) as e:
        story_agent.StoryAgent(slow, ARN).stop_session("cfstory-x")
    assert e.value.retryable
    assert len(slow.stop_calls) == 1  # 20 s spent: a second 23 s try would outlive the request
    quick = QuickFlakyStop(1)
    story_agent.StoryAgent(quick, ARN).stop_session("cfstory-y")
    assert quick.stop_calls == 2  # a quick throttle is tried once more
    once = QuickFlakyStop(1)
    with pytest.raises(AgentError):
        story_agent.StoryAgent(once, ARN).stop_session("cfstory-z", attempts=1)
    assert once.stop_calls == 1


def test_time_for_call_keeps_one_call_inside_the_29_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Monotonic(monkeypatch)
    import time

    started = time.monotonic()
    assert story_agent.time_for_call(started)
    assert story_agent.time_for_call(None)
    clock.spent = story_agent.REQUEST_SECONDS - story_agent.CALL_SECONDS - story_agent.AFTER_CALL_SECONDS + 0.5
    assert not story_agent.time_for_call(started)
    assert story_agent.time_for_call(started, after=0.0)


def test_a_hanging_stop_never_outlives_a_read_that_settles_many_jobs(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    slow = SlowAgentCore(Monotonic(monkeypatch))
    install(app, slow, s3_client)
    stale = [_running(store, s3_client, minutes=9)[1] for _ in range(3)]
    status, _ = call("GET", f"{BASE}/dashboard")
    assert status == 200
    # Every stale job is fenced; only the first stop is tried (once): after its 20 s none fits any more.
    assert all(store.get(j["pk"], j["sk"])["status"] == "failed" for j in stale)  # type: ignore[index]
    assert len(slow.stop_calls) == 1
    assert slow.stop_calls[0] in {j["sessionId"] for j in stale}


def test_a_late_read_leaves_the_stop_to_the_fence(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Monotonic(monkeypatch)
    slow = SlowAgentCore(clock, slow_stop=False)
    install(app, slow, s3_client)
    story, job = _running(store, s3_client, minutes=9)
    clock.spent = 10.0  # 10 s + one 23 s call would pass the 29 s
    body = call("GET", f"{BASE}/stories/{story['storyId']}")[1]
    assert body["job"]["status"] == "failed"
    assert slow.stop_calls == []
    assert store.get(job["pk"], job["sk"])["sessionId"] != job["sessionId"]  # type: ignore[index]


def test_a_cancel_whose_cancel_call_hangs_skips_the_stop_and_still_answers(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Monotonic(monkeypatch)
    slow = SlowAgentCore(clock, slow_stop=False, slow_cancel=True)
    install(app, slow, s3_client)
    story, _ = _running(store, s3_client, minutes=1)
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/cancel")
    assert status == 200
    assert body["job"]["status"] == "canceled"
    assert slow.order == ["cancel"]  # tried once; its 20 s leave no room for the stop: the new sessionId fences it
    clock.spent = 0.0  # a new request
    quick = SlowAgentCore(clock, slow_stop=False)
    install(app, quick, s3_client)
    other, other_job = _running(store, s3_client, minutes=1)
    assert call("POST", f"{BASE}/stories/{other['storyId']}/cancel")[0] == 200
    assert quick.order == ["cancel", "stop"]
    assert quick.stop_calls == [other_job["sessionId"]]


def test_delete_stops_the_session_outright_before_the_files_go(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Monotonic(monkeypatch)
    quick = SlowAgentCore(clock, slow_stop=False)
    install(app, quick, s3_client)
    story, job = _running(store, s3_client, minutes=1)
    deleted_before_stop: list[bool] = []
    real_stop = quick.stop_runtime_session

    def stop(**kw: Any) -> dict[str, Any]:
        deleted_before_stop.append(store.get(story["pk"], story["sk"]) is None)
        return real_stop(**kw)

    monkeypatch.setattr(quick, "stop_runtime_session", stop)
    assert call("DELETE", f"{BASE}/stories/{story['storyId']}")[0] == 204
    assert quick.order == ["stop"]  # no cancel whose wind-down would write again
    assert quick.stop_calls == [job["sessionId"]]
    assert deleted_before_stop == [False]
    assert store.get(story["pk"], story["sk"]) is None
    # A late delete leaves the stop to the fence and still deletes everything inside the 29 s.
    late = SlowAgentCore(clock, slow_stop=False)
    install(app, late, s3_client)
    other, other_job = _running(store, s3_client, minutes=1)
    clock.spent = 3.0  # 3 s + one 23 s call + the deletes' 4 s would pass the 29 s
    assert call("DELETE", f"{BASE}/stories/{other['storyId']}")[0] == 204
    assert late.order == []
    assert store.get(other["pk"], other["sk"]) is None
    assert store.get(other_job["pk"], other_job["sk"]) is None


def test_a_start_after_the_fence_goes_first_and_the_stop_waits_for_it(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch
) -> None:
    slow = SlowAgentCore(Monotonic(monkeypatch))
    install(app, slow, s3_client)
    story, job = _running(store, s3_client, minutes=9, made=True)
    status, body = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {"from": "storyboard"})
    assert status == 202
    assert body["job"]["status"] == "queued"  # the start had the whole request
    assert slow.order == ["process_story", "stop"]
    assert slow.stop_calls == [job["sessionId"]]
