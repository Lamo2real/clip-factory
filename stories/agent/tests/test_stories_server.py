"""The Lamo Stories runtime's server and action table (docs/CONTRACTS.md §45.11.1, §45.33): process_story,
process_portrait, process_reference and cancel answer at once and run in the background as the session AgentCore
invoked them in; /ping is HealthyBusy while anything runs; the shutdown cancels running work; building the app calls
nothing."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from starlette.testclient import TestClient

from lamostories_agent import services
from lamostories_agent.runner import JobRunner, register
from lamostories_agent.server import SESSION_HEADER, Actions, build_app, create_app


class Recorder:
    """Stands in for the job classes: records what would run, and blocks until released."""

    def __init__(self) -> None:
        self.runs: list[tuple[str, str, str, str]] = []
        self.release = asyncio.Event()


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, Recorder, JobRunner]:
    rec = Recorder()

    class FakeJob:
        def __init__(self, svc: Any, fence: Any, content_id: str) -> None:
            self.fence, self.content_id = fence, content_id

        async def run(self) -> str:
            rec.runs.append((type(self).__name__, self.fence.job_id, self.fence.session_id, self.content_id))
            await rec.release.wait()
            return "ready"

    class Svc:
        work_root = __import__("pathlib").Path("/tmp/ls-test-work")

    from lamostories_agent import pipeline, portrait, refjob

    monkeypatch.setattr(pipeline, "StoryJob", type("StoryJob", (FakeJob,), {}))
    monkeypatch.setattr(portrait, "PortraitJob", type("PortraitJob", (FakeJob,), {}))
    monkeypatch.setattr(refjob, "ReferenceJob", type("ReferenceJob", (FakeJob,), {}))
    actions = Actions()
    runner = JobRunner()
    register(actions, runner, Svc)
    return TestClient(create_app(actions)), rec, runner


BODY = {"userId": "u1", "workspaceId": "stories", "jobId": "J1"}


def test_the_action_table() -> None:
    actions = Actions()
    register(actions, JobRunner(), lambda: None)
    assert {"process_story", "process_portrait", "process_reference", "cancel"} <= set(actions.table)
    assert actions.busy_checks
    with pytest.raises(ValueError):
        register(actions, JobRunner(), lambda: None)  # each action once


def test_build_app_registers_every_action_without_calling_anything(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_: Any, **__: Any) -> Any:
        raise AssertionError("building the app called AWS")

    import boto3

    monkeypatch.setattr(boto3, "client", boom)
    monkeypatch.setattr(boto3, "resource", boom)
    monkeypatch.setattr(services, "build", boom)
    client = TestClient(build_app())
    assert client.get("/ping").json() == {"status": "Healthy"}
    assert client.post("/invocations", json={"action": "health"}).json() == {"ok": True}
    assert client.post("/invocations", json={"action": "process_clip_job"}).status_code == 400  # Clip Factory's


@pytest.mark.parametrize(
    ("action", "content", "kind"),
    [
        ("process_story", "storyId", "StoryJob"),
        ("process_portrait", "characterId", "PortraitJob"),
        ("process_reference", "refId", "ReferenceJob"),
    ],
)
def test_each_start_is_accepted_at_once_in_the_header_s_session(
    app: tuple[TestClient, Recorder, JobRunner], action: str, content: str, kind: str
) -> None:
    client, rec, _runner = app
    with client:
        body = {"action": action, **BODY, content: "X1"}
        r = client.post("/invocations", json=body, headers={SESSION_HEADER: "cfstory-J1-abcdefgh" + "x" * 16})
        assert r.json() == {"accepted": True, "id": "J1"}
        client.portal.call(asyncio.sleep, 0.05)  # type: ignore[union-attr]
        assert rec.runs == [(kind, "J1", "cfstory-J1-abcdefgh" + "x" * 16, "X1")]
        assert client.get("/ping").json() == {"status": "HealthyBusy"}
        again = client.post("/invocations", json=body, headers={SESSION_HEADER: "cfstory-J1-abcdefgh" + "x" * 16})
        assert again.json() == {"accepted": True, "id": "J1", "running": True}  # a duplicate start is ignored
        assert client.post("/invocations", json={"action": "cancel", "id": "J1"}).json() == {
            "accepted": True,
            "id": "J1",
            "stopped": True,
        }
        client.portal.call(asyncio.sleep, 0.05)  # type: ignore[union-attr]
        assert client.get("/ping").json() == {"status": "Healthy"}


@pytest.mark.parametrize(
    "body",
    [
        {"action": "process_story", "userId": "u1", "workspaceId": "clips", "storyId": "S", "jobId": "J"},
        {"action": "process_story", "userId": "u1", "workspaceId": "stories", "storyId": "../S", "jobId": "J"},
        {"action": "process_story", "userId": "u1", "workspaceId": "stories", "jobId": "J"},
        {"action": "process_portrait", "userId": "u1", "workspaceId": "stories", "characterId": "C", "jobId": ""},
        {"action": "cancel"},
    ],
)
def test_bad_starts_are_refused_and_run_nothing(
    app: tuple[TestClient, Recorder, JobRunner], body: dict[str, Any]
) -> None:
    client, rec, _ = app
    with client:
        r = client.post("/invocations", json=body, headers={SESSION_HEADER: "S1"})
        assert r.json()["accepted"] is False
        assert rec.runs == []


def test_a_start_without_a_session_is_refused(app: tuple[TestClient, Recorder, JobRunner]) -> None:
    client, rec, _ = app
    with client:
        r = client.post("/invocations", json={"action": "process_story", **BODY, "storyId": "S"})
        assert r.json() == {"accepted": False, "error": "The request has no session."}
        assert rec.runs == []


def test_a_runtime_without_its_settings_refuses_to_start(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CF_STORIES_TABLE", raising=False)
    services.install(None)
    actions = Actions()
    register(actions, JobRunner(), services.get)
    client = TestClient(create_app(actions))
    with client:
        r = client.post("/invocations", json={"action": "process_story", **BODY, "storyId": "S"},
                        headers={SESSION_HEADER: "S1"})  # fmt: skip
        assert r.json() == {"accepted": False, "error": services.NOT_CONFIGURED}


async def test_the_runner_and_its_shutdown() -> None:
    runner = JobRunner()
    gate = asyncio.Event()
    done: list[str] = []

    async def work(name: str) -> None:
        try:
            await gate.wait()
        finally:
            done.append(name)

    assert runner.spawn("a", "s", work("a"))
    assert not runner.spawn("a", "s", work("a2"))  # the second coroutine is closed, never run
    assert runner.spawn("b", "s", work("b"))
    await asyncio.sleep(0)
    assert runner.busy()
    assert not runner.cancel("nope")
    await runner.shutdown(within=2)
    assert sorted(done) == ["a", "b"] and not runner.busy()


def test_the_lifespan_shutdown_cancels_running_work(monkeypatch: pytest.MonkeyPatch) -> None:
    app = build_app()
    stopped: list[bool] = []
    from lamostories_agent import runner as runner_mod

    original = runner_mod.JobRunner.shutdown

    async def spy(self: JobRunner, within: float = 20.0) -> None:
        stopped.append(True)
        await original(self, within)

    monkeypatch.setattr(runner_mod.JobRunner, "shutdown", spy)
    with TestClient(app) as client:
        assert client.get("/ping").status_code == 200
    assert stopped == [True]
