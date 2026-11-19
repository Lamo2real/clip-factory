"""The agent's side of the job flow's durable callback (docs/CONTRACTS.md §14.4)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from botocore.exceptions import ClientError

from clipfactory_agent import callback as cbmod
from clipfactory_agent.callback import DurableCallback, is_closed, report
from clipfactory_agent.heartbeat import Liveness
from clipfactory_agent.jobs import Tracker, run_job

CB = "cb-0123456789abcdef"


def client_error(code: str, message: str = "", status: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": message}, "ResponseMetadata": {"HTTPStatusCode": status}}, "Op"
    )


class FakeLambda:
    """Records the three callback calls; ``fail`` holds errors to raise, in order, before succeeding."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: list[Exception] = []

    def _record(self, name: str, kw: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, kw))
        if self.fail:
            raise self.fail.pop(0)
        return {}

    def send_durable_execution_callback_heartbeat(self, **kw: Any) -> dict[str, Any]:
        return self._record("heartbeat", kw)

    def send_durable_execution_callback_success(self, **kw: Any) -> dict[str, Any]:
        return self._record("success", kw)

    def send_durable_execution_callback_failure(self, **kw: Any) -> dict[str, Any]:
        return self._record("failure", kw)

    def names(self) -> list[str]:
        return [n for n, _ in self.calls]


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def make(client: FakeLambda, clock: Clock | None = None) -> DurableCallback:
    return DurableCallback(CB, client, clock=clock or Clock(), retry_base=0.001)


async def settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0.001)


# --- messages -----------------------------------------------------------------------------------------------------


async def test_success_sends_job_id_and_clip_count() -> None:
    client = FakeLambda()
    cb = make(client)
    assert await cb.succeed("J1", 7) is True
    name, kw = client.calls[0]
    assert name == "success"
    assert kw["CallbackId"] == CB
    assert json.loads(kw["Result"]) == {"jobId": "J1", "clipCount": 7}
    assert isinstance(kw["Result"], bytes)


@pytest.mark.parametrize(
    ("status", "error_type", "message"),
    [
        ("failed", "JobFailed", "The video is too short to clip (under 10 seconds of audio)."),
        ("canceled", "Canceled", cbmod.CANCELED_MESSAGE),
        ("superseded", "Superseded", cbmod.SUPERSEDED_MESSAGE),
    ],
)
async def test_failure_types(status: str, error_type: str, message: str) -> None:
    client = FakeLambda()
    await report(
        make(client),
        status,
        job_id="J1",
        clip_count=0,
        error="The video is too short to clip (under 10 seconds of audio).",
    )
    assert client.calls == [
        ("failure", {"CallbackId": CB, "Error": {"ErrorType": error_type, "ErrorMessage": message}})
    ]


async def test_ready_reports_success_and_a_failed_job_without_a_message_gets_a_plain_one() -> None:
    client = FakeLambda()
    await report(make(client), "ready", job_id="J", clip_count=3, error=None)
    assert client.names() == ["success"]
    client2 = FakeLambda()
    await report(make(client2), "failed", job_id="J", clip_count=0, error=None)
    assert client2.calls[0][1]["Error"] == {"ErrorType": "JobFailed", "ErrorMessage": cbmod.GENERIC_FAILURE}


async def test_failure_message_is_cut_to_256_characters() -> None:
    client = FakeLambda()
    await make(client).fail("JobFailed", "x" * 600)
    assert len(client.calls[0][1]["Error"]["ErrorMessage"]) == 256


async def test_no_callback_means_nothing_is_sent() -> None:
    await report(None, "ready", job_id="J", clip_count=1, error=None)  # no client to call, no error


async def test_only_one_outcome_is_ever_sent() -> None:
    client = FakeLambda()
    cb = make(client)
    await cb.succeed("J", 1)
    assert await cb.fail("JobFailed", "late") is False
    assert cb.send_heartbeat() is False
    assert client.names() == ["success"]


# --- errors -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "error",
    [
        client_error("ResourceNotFoundException", "Callback not found", 404),
        client_error("CallbackTimeoutException", "The callback timed out"),
        client_error("InvalidParameterValueException", "Callback is already completed"),
    ],
)
async def test_closed_callback_errors_are_ignored(error: ClientError) -> None:
    assert is_closed(error)
    client = FakeLambda()
    client.fail = [error]
    cb = make(client)
    assert await cb.succeed("J", 1) is False  # no exception
    assert client.names() == ["success"]  # not retried
    assert cb.closed


async def test_throttling_and_5xx_are_retried_three_times() -> None:
    client = FakeLambda()
    client.fail = [
        client_error("TooManyRequestsException", "slow down", 429),
        client_error("ServiceException", "boom", 500),
        client_error("ServiceException", "boom", 500),
    ]
    assert await make(client).fail("JobFailed", "Oops.") is True
    assert client.names() == ["failure"] * 4


async def test_a_send_that_keeps_failing_never_raises() -> None:
    client = FakeLambda()
    client.fail = [client_error("ServiceException", "boom", 500)] * 4
    assert await make(client).succeed("J", 1) is False
    assert len(client.calls) == 4
    client2 = FakeLambda()
    client2.fail = [client_error("AccessDeniedException", "no", 403)]
    assert make(client2).send_heartbeat() is False
    assert len(client2.calls) == 1  # the heartbeat thread tries again itself, 20 s later


def test_other_invalid_parameter_errors_are_not_closed() -> None:
    assert not is_closed(client_error("InvalidParameterValueException", "Result is too large"))
    assert not is_closed(ValueError("x"))


# --- heartbeat (its own thread, docs/CONTRACTS.md §30.3) -----------------------------------------------------------


def test_send_heartbeat_sets_the_last_beat_only_on_success() -> None:
    client, clock = FakeLambda(), Clock()
    client.fail = [client_error("ServiceException", "boom", 500)]
    cb = make(client, clock)
    assert cb.send_heartbeat() is False
    assert cb._last_beat is None  # the old code set it before the send, so a failure waited a whole period
    clock.t += 20
    assert cb.send_heartbeat() is True
    assert cb._last_beat == clock.t
    assert all(kw == {"CallbackId": CB} for _, kw in client.calls)
    assert cbmod.HEARTBEAT_SECONDS == 120 and cbmod.HEARTBEAT_SECONDS * 3 == 6 * 60


def test_heartbeat_stops_once_the_callback_is_closed() -> None:
    client = FakeLambda()
    client.fail = [client_error("CallbackTimeoutException", "timed out")]
    cb = make(client)
    assert cb.send_heartbeat() is False
    assert cb.closed
    assert cb.send_heartbeat() is False
    assert client.names() == ["heartbeat"]


def test_heartbeat_thread_uses_its_own_client() -> None:
    shared, own = FakeLambda(), FakeLambda()
    cb = DurableCallback(CB, shared, new_client=lambda: own)
    assert cb.send_heartbeat() is True
    assert own.names() == ["heartbeat"] and shared.names() == []


async def test_tracker_ticks_liveness_and_the_thread_beats() -> None:
    """The job's loop ticks the liveness; the thread beats from the start and the outcome follows the job."""

    class Store:
        async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
            return True

    client = FakeLambda()
    cb = DurableCallback(CB, client, retry_base=0.001, heartbeat_every=0.02)
    live = Liveness()
    before = live.last
    tracker = Tracker(Store(), "U", "J", session_id="S", heartbeat=0.01, flush=0.005, on_beat=live.tick)
    cb.start_heartbeat(live)

    async def slow() -> str:
        await asyncio.sleep(0.15)
        return "done"

    status = await run_job(tracker, [("resolve", slow)], clip_count=lambda: 2)
    assert status == "ready"
    assert live.last > before
    await report(cb, status, job_id="J", clip_count=2, error=tracker.error)
    names = client.names()
    assert names[-1] == "success" and names.count("heartbeat") >= 2
    assert cb._thread is None  # stopped with the outcome


async def test_close_stops_the_heartbeat_thread() -> None:
    cb = DurableCallback(CB, FakeLambda(), heartbeat_every=60)
    thread = cb.start_heartbeat(Liveness())
    assert thread.is_alive()
    await cb.close()
    assert not thread.is_alive() and cb._thread is None


async def test_stopped_sends_agent_stopped() -> None:
    client = FakeLambda()
    await report(make(client), "stopped", job_id="J", clip_count=0, error=None)
    ((name, kw),) = client.calls
    assert name == "failure"
    assert kw["Error"] == {"ErrorType": "AgentStopped", "ErrorMessage": "Picking up where it stopped…"}
