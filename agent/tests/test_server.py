from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from starlette.testclient import TestClient

from clipfactory_agent.callback import DurableCallback
from clipfactory_agent.jobs import JobRunner, StepDone
from clipfactory_agent.server import SESSION_HEADER, create_app, make_run, settled
from clipfactory_agent.util import UserFacingError

from .test_callback import FakeLambda


class FakeRunner:
    def __init__(self) -> None:
        self.busy = False
        self.submitted: list[tuple[str, str, str | None, str | None]] = []
        self.canceled: list[tuple[str, str | None]] = []

    def submit(self, job_id: str, user_id: str, session_id: str | None = None, callback_id: str | None = None) -> bool:
        self.submitted.append((job_id, user_id, session_id, callback_id))
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
    assert runner.submitted == [("01JOB", "user-1", None, None)]


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

    async def run(job_id: str, user_id: str, session_id: str | None, callback_id: str | None) -> None:
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
    async def run(job_id: str, user_id: str, session_id: str | None, callback_id: str | None) -> None:
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
    assert runner.submitted == [
        ("01JOB", "user-1", SESSION, None),
        ("01JOB", "user-1", "cfjob-01JOB-zzzzzzzz", None),
    ]
    assert runner.canceled == [("01JOB", SESSION)]
    r = client.post("/invocations", json={**body, "sessionId": "../evil"})
    assert r.status_code == 400
    assert client.post("/invocations", json={**body, "sessionId": 7}).status_code == 400


async def test_job_runner_passes_the_session_and_ignores_another_runs_cancel() -> None:
    seen: list[str | None] = []

    async def run(job_id: str, user_id: str, session_id: str | None, callback_id: str | None) -> None:
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


# --- the durable callback (docs/CONTRACTS.md §14.4) ----------------------------------------------------------------


def test_callback_id_is_passed_to_the_runner_and_validated() -> None:
    runner = FakeRunner()
    client = TestClient(create_app(runner))
    body = {"action": "process_job", "jobId": "01JOB", "userId": "user-1", "callbackId": "Y2FsbGJhY2s="}
    assert client.post("/invocations", json=body, headers={SESSION_HEADER: SESSION}).status_code == 200
    assert runner.submitted == [("01JOB", "user-1", SESSION, "Y2FsbGJhY2s=")]
    for bad in ("", "has space", 7, "x" * 3000):
        assert client.post("/invocations", json={**body, "callbackId": bad}).status_code == 400


class JobStore:
    def __init__(self, job: dict[str, Any] | None) -> None:
        self.job = job
        self.writes: list[dict[str, Any]] = []

    async def get_job(self, user_id: str, job_id: str) -> dict[str, Any] | None:
        return self.job

    async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
        self.writes.append(fields)
        if self.job is not None:
            self.job.update(fields)
        return True


class Steps:
    def __init__(self, fn: Any = None) -> None:
        self.fn = fn
        self.ran = 0

    def steps(self, st: Any, tr: Any) -> list[tuple[str, Any]]:
        async def one() -> StepDone:
            self.ran += 1
            if self.fn:
                await self.fn(st)
            st.candidates = [object(), object(), object()]
            return StepDone("ok")

        return [("resolve", one)]


def queued(**kw: Any) -> dict[str, Any]:
    return {"jobId": "J", "status": "queued", "sessionId": SESSION, **kw}


def wiring(store: JobStore, steps: Steps, tmp_path: Path) -> tuple[Any, FakeLambda, list[str]]:
    client = FakeLambda()
    made: list[str] = []

    def new_callback(callback_id: str) -> DurableCallback:
        made.append(callback_id)
        return DurableCallback(callback_id, client, retry_base=0.001)

    return make_run(store, steps, tmp_path, new_callback), client, made  # type: ignore[arg-type]


async def test_success_is_sent_after_the_job_is_ready(tmp_path: Path) -> None:
    store, steps = JobStore(queued()), Steps()
    run, client, made = wiring(store, steps, tmp_path)
    assert await run("J", "U", SESSION, "CB1") == "ready"
    assert made == ["CB1"]
    assert store.job is not None and store.job["status"] == "ready"
    assert client.names()[-1] == "success" and "failure" not in client.names()
    assert client.calls[-1][1]["Result"] == b'{"jobId": "J", "clipCount": 3}'


async def test_no_callback_without_callback_id(tmp_path: Path) -> None:
    store, steps = JobStore(queued()), Steps()
    run, client, made = wiring(store, steps, tmp_path)
    assert await run("J", "U", SESSION, None) == "ready"
    assert made == [] and client.calls == []


async def test_a_failed_job_sends_job_failed_with_its_error(tmp_path: Path) -> None:
    async def boom(st: Any) -> None:
        raise UserFacingError("This stream is still live or has not started. Try again once it has ended.")

    store = JobStore(queued())
    run, client, _ = wiring(store, Steps(boom), tmp_path)
    assert await run("J", "U", SESSION, "CB1") == "failed"
    assert client.calls[-1] == (
        "failure",
        {
            "CallbackId": "CB1",
            "Error": {
                "ErrorType": "JobFailed",
                "ErrorMessage": "This stream is still live or has not started. Try again once it has ended.",
            },
        },
    )


async def test_a_cancel_sends_canceled(tmp_path: Path) -> None:
    async def wait(st: Any) -> None:
        await asyncio.sleep(60)

    store = JobStore(queued())
    run, client, _ = wiring(store, Steps(wait), tmp_path)
    task = asyncio.create_task(run("J", "U", SESSION, "CB1"))
    await asyncio.sleep(0.02)
    task.cancel()
    assert await task == "canceled"
    assert client.calls[-1][1]["Error"]["ErrorType"] == "Canceled"


async def test_a_superseded_run_sends_superseded_and_does_not_run(tmp_path: Path) -> None:
    store, steps = JobStore(queued(sessionId="cfjob-J-newer000")), Steps()
    run, client, _ = wiring(store, steps, tmp_path)
    assert await run("J", "U", SESSION, "CB1") == "superseded"
    assert steps.ran == 0 and store.writes == []
    assert client.calls == [
        (
            "failure",
            {
                "CallbackId": "CB1",
                "Error": {"ErrorType": "Superseded", "ErrorMessage": "A newer run of this job took over."},
            },
        )
    ]


async def test_a_duplicate_process_job_after_the_run_finished_is_ignored(tmp_path: Path) -> None:
    """The flow's start-agent step is at-least-once: a second process_job for a finished job never runs it again;
    it only repeats the outcome (the flow ignores it when the callback is already closed)."""
    store, steps = JobStore(queued(status="ready", clipCount=4)), Steps()
    run, client, _ = wiring(store, steps, tmp_path)
    assert await run("J", "U", SESSION, "CB1") == "ready"
    assert steps.ran == 0 and store.writes == []
    assert client.names() == ["success"]
    assert client.calls[0][1]["Result"] == b'{"jobId": "J", "clipCount": 4}'


async def test_a_duplicate_process_job_while_running_here_is_ignored() -> None:
    gate = asyncio.Event()
    runs: list[str | None] = []

    async def run(job_id: str, user_id: str, session_id: str | None, callback_id: str | None) -> None:
        runs.append(callback_id)
        await gate.wait()

    runner = JobRunner(run)
    client = TestClient(create_app(runner))
    body = {"action": "process_job", "jobId": "J", "userId": "U", "callbackId": "CB1"}
    assert runner.submit("J", "U", SESSION, "CB1") is True
    r = client.post("/invocations", json=body, headers={SESSION_HEADER: SESSION})
    assert r.json() == {"accepted": True, "jobId": "J"}
    await asyncio.sleep(0)
    assert runs == ["CB1"]
    gate.set()
    await asyncio.sleep(0.01)


def test_settled_states() -> None:
    assert settled(queued(), SESSION) is None
    assert settled(queued(status="running"), SESSION) is None
    assert settled(None, SESSION) is not None and settled(None, SESSION).status == "failed"  # type: ignore[union-attr]
    assert settled(queued(status="canceled"), SESSION).status == "canceled"  # type: ignore[union-attr]
    failed = settled(queued(status="failed", error="Nope."), SESSION)
    assert failed is not None and (failed.status, failed.error) == ("failed", "Nope.")
    assert settled(queued(), "other").status == "superseded"  # type: ignore[union-attr]
    assert settled(queued(), None) is None  # a local run without a session header
