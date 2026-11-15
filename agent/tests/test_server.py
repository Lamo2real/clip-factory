from __future__ import annotations

import asyncio

from starlette.testclient import TestClient

from clipfactory_agent.jobs import JobRunner
from clipfactory_agent.server import SESSION_HEADER, create_app


class FakeRunner:
    def __init__(self) -> None:
        self.busy = False
        self.submitted: list[tuple[str, str, str | None]] = []
        self.canceled: list[tuple[str, str | None]] = []

    def submit(self, job_id: str, user_id: str, session_id: str | None = None) -> bool:
        self.submitted.append((job_id, user_id, session_id))
        self.busy = True
        return True

    def cancel(self, job_id: str, session_id: str | None = None) -> bool:
        self.canceled.append((job_id, session_id))
        self.busy = False
        return True


def test_ping_reports_busy() -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner))
    assert client.get("/ping").json()["status"] == "Healthy"
    runner.busy = True
    assert client.get("/ping").json()["status"] == "HealthyBusy"


def test_process_job_is_accepted_at_once() -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner))
    r = client.post("/invocations", json={"action": "process_job", "jobId": "01JOB", "userId": "user-1"})
    assert r.status_code == 200
    assert r.json() == {"accepted": True, "jobId": "01JOB"}
    assert runner.submitted == [("01JOB", "user-1", None)]


def test_cancel_and_health() -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner))
    assert client.post("/invocations", json={"action": "health"}).json() == {"ok": True}
    r = client.post("/invocations", json={"action": "cancel", "jobId": "01JOB"})
    assert r.json() == {"canceled": True, "jobId": "01JOB"}


def test_bad_invocations() -> None:
    client = TestClient(create_app(FakeRunner()))
    for body in (
        {"action": "process_job", "jobId": "01JOB"},
        {"action": "process_job", "jobId": "../x", "userId": "u"},
        {"action": "explode", "jobId": "01JOB"},
        ["not", "an", "object"],
    ):
        r = client.post("/invocations", json=body)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "bad_request"
    assert client.post("/invocations", content=b"{not json").status_code == 400
    assert client.post("/invocations", content=b"x" * 70_000).status_code == 400
    assert client.get("/nope").status_code == 404


async def test_job_runner_tracks_background_tasks() -> None:
    gate = asyncio.Event()
    ran: list[str] = []

    async def run(job_id: str, user_id: str, session_id: str | None) -> None:
        ran.append(job_id)
        await gate.wait()

    runner = JobRunner(run)
    assert runner.submit("J", "U") is True
    assert runner.submit("J", "U") is False  # already running here
    await asyncio.sleep(0)
    assert runner.busy and ran == ["J"]
    gate.set()
    await asyncio.sleep(0.01)
    assert not runner.busy and "J" not in runner.tasks


async def test_job_runner_cancel_stops_the_task() -> None:
    async def run(job_id: str, user_id: str, session_id: str | None) -> None:
        await asyncio.sleep(60)

    runner = JobRunner(run)
    runner.submit("J", "U")
    await asyncio.sleep(0)
    assert runner.cancel("J") is True
    await asyncio.sleep(0.01)
    assert not runner.busy
    assert runner.cancel("J") is False


SESSION = "cfjob-01JOB-abcdefgh"


def test_session_comes_from_the_agentcore_header_or_the_payload() -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner))
    body = {"action": "process_job", "jobId": "01JOB", "userId": "user-1"}
    client.post("/invocations", json=body, headers={SESSION_HEADER: SESSION})
    client.post("/invocations", json={**body, "sessionId": "cfjob-01JOB-zzzzzzzz"}, headers={SESSION_HEADER: SESSION})
    client.post("/invocations", json={"action": "cancel", "jobId": "01JOB"}, headers={SESSION_HEADER: SESSION})
    assert runner.submitted == [("01JOB", "user-1", SESSION), ("01JOB", "user-1", "cfjob-01JOB-zzzzzzzz")]
    assert runner.canceled == [("01JOB", SESSION)]
    r = client.post("/invocations", json={**body, "sessionId": "../evil"})
    assert r.status_code == 400
    assert client.post("/invocations", json={**body, "sessionId": 7}).status_code == 400


async def test_job_runner_passes_the_session_and_ignores_another_runs_cancel() -> None:
    seen: list[str | None] = []

    async def run(job_id: str, user_id: str, session_id: str | None) -> None:
        seen.append(session_id)
        await asyncio.sleep(60)

    runner = JobRunner(run)
    assert runner.submit("J", "U", SESSION) is True
    await asyncio.sleep(0)
    assert seen == [SESSION]
    assert runner.submit("J", "U", "cfjob-J-other000000000000000000000") is False
    assert runner.cancel("J", "cfjob-J-other000000000000000000000") is False  # meant for another run
    assert runner.busy
    assert runner.cancel("J", SESSION) is True
    await asyncio.sleep(0.01)
    assert not runner.busy and "J" not in runner.sessions
