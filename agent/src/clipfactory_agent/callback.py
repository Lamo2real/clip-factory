"""The agent's side of the durable callback of ``cf-prod-job-flow`` (docs/CONTRACTS.md §14.4).

The job flow passes a ``callbackId`` in ``process_job`` and waits, with no compute, until the agent sends:

* a heartbeat every 2 minutes while the job runs, from its own thread (heartbeat.py; the flow's heartbeat timeout is
  6 minutes, so a container that died or froze is noticed in minutes and the job resumes, §30);
* success, after finalize wrote the Job ``ready``: ``{"jobId", "clipCount"}``;
* failure: ``MacFetch`` (YouTube blocked the cloud; the job stays running and waits for the owner's Mac, §35),
  ``JobFailed`` (the agent wrote the Job ``failed``), ``Canceled`` (the owner canceled), ``Superseded``
  (a retry gave the job a new session, §13 "One run per job") or ``AgentStopped`` (the container is shutting down,
  SIGTERM: the flow resumes the job at once, §30), with the Job's plain-sentence error.

Every send retries throttling and 5xx errors 3 times. A callback that is already closed, timed out or unknown is
ignored, and no send ever fails the job: a lost message ends the flow through its heartbeat timeout instead."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

from .heartbeat import HEARTBEAT_SECONDS, HeartbeatThread, Liveness
from .retry import is_transient, retry
from .util import log

SEND_ATTEMPTS = 4  # the first try plus 3 retries
MAX_MESSAGE = 256

JOB_FAILED = "JobFailed"
CANCELED = "Canceled"
SUPERSEDED = "Superseded"
AGENT_STOPPED = "AgentStopped"
MAC_FETCH = "MacFetch"

CANCELED_MESSAGE = "The job was canceled."
SUPERSEDED_MESSAGE = "A newer run of this job took over."
STOPPED_MESSAGE = "Picking up where it stopped…"
GENERIC_FAILURE = "Something went wrong while making the clips. Tap Try again."

# Errors that mean the callback can no longer be completed: the flow already ended (success, failure or timeout).
_CLOSED_CODES = {"ResourceNotFoundException", "CallbackTimeoutException"}
_CLOSED_WORDS = ("closed", "completed", "already", "timed out", "timeout", "not found", "expired", "does not exist")


def _code(e: BaseException) -> str:
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        return str((response.get("Error") or {}).get("Code") or "")
    return ""


def is_closed(e: BaseException) -> bool:
    """True when the error says the callback is already closed, timed out or unknown."""
    code = _code(e)
    if code in _CLOSED_CODES:
        return True
    if code == "InvalidParameterValueException":
        text = str(e).lower()
        return any(w in text for w in _CLOSED_WORDS)
    return False


def lambda_client(region: str) -> Any:
    """The boto3 Lambda client for the callback APIs; retries are ours, so botocore makes a single attempt."""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "lambda",
        region_name=region,
        config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 1, "mode": "standard"}),
    )


class DurableCallback:
    """One run's callback. ``start_heartbeat()`` starts the heartbeat thread (heartbeat.py); ``beat()`` is kept as a
    no-op for callers of the old loop heartbeat. Exactly one of ``succeed``/``fail`` is sent per run."""

    def __init__(
        self,
        callback_id: str,
        client: Any,
        *,
        heartbeat_every: float = HEARTBEAT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        retry_base: float = 1.0,
        new_client: Callable[[], Any] | None = None,
    ) -> None:
        self.callback_id = callback_id
        self.client = client
        self.heartbeat_every = heartbeat_every
        self.clock = clock
        self.retry_base = retry_base
        self.new_client = new_client  # the heartbeat thread's own client; None: the shared one
        self.closed = False  # a terminal message was sent, or the flow no longer waits for one
        self._last_beat: float | None = None  # set only after a heartbeat went through
        self._thread: HeartbeatThread | None = None
        self._beat_client: Any = None

    @property
    def ref(self) -> str:
        """A short reference for logs (the full id is never logged)."""
        return self.callback_id[:8]

    async def _send(self, what: str, fn: Callable[..., Any], **kwargs: Any) -> bool:
        """Sends one message; True when the flow received it. Never raises (except a cancel)."""
        try:
            await retry(
                lambda: asyncio.to_thread(fn, CallbackId=self.callback_id, **kwargs),
                what=f"callback.{what}",
                attempts=SEND_ATTEMPTS,
                base=self.retry_base,
                transient=lambda e: is_transient(e) and not is_closed(e),
            )
            return True
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._failed(what, e)
            return False

    def _failed(self, what: str, e: BaseException) -> None:
        if is_closed(e):
            log("info", "callback.closed", what=what, callback=self.ref, error=_code(e) or type(e).__name__)
            self.closed = True
        else:
            log("warn", "callback.send_failed", what=what, callback=self.ref, error=_code(e) or type(e).__name__)

    # --- heartbeat (its own thread) -------------------------------------------------------------------------------

    def send_heartbeat(self) -> bool:
        """One heartbeat, sent from the heartbeat thread (blocking). True when the flow received it; the thread tries
        again after 20 seconds otherwise. ``_last_beat`` is set only on success."""
        if self.closed:
            return False
        if self._beat_client is None:
            self._beat_client = self.new_client() if self.new_client else self.client
        try:
            self._beat_client.send_durable_execution_callback_heartbeat(CallbackId=self.callback_id)
        except Exception as e:
            self._failed("heartbeat", e)
            return False
        self._last_beat = self.clock()
        log("info", "callback.heartbeat", callback=self.ref)
        return True

    def start_heartbeat(self, liveness: Liveness, **kwargs: Any) -> HeartbeatThread:
        """Starts the heartbeat thread (once); it beats while ``liveness`` shows the event loop is alive."""
        if self._thread is None:
            self._thread = HeartbeatThread(
                self.send_heartbeat,
                liveness,
                closed=lambda: self.closed,
                every=self.heartbeat_every,
                clock=self.clock,
                ref=self.ref,
                **kwargs,
            )
            self._thread.start()
        return self._thread

    def beat(self) -> None:
        """Kept for callers of the old loop heartbeat: the thread beats now."""

    async def _stop_beat(self) -> None:
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.stop()
            await asyncio.to_thread(thread.join, 30)

    # --- outcome ------------------------------------------------------------------------------------------------

    async def succeed(self, job_id: str, clip_count: int) -> bool:
        await self._stop_beat()
        if self.closed:
            return False
        self.closed = True
        result = json.dumps({"jobId": job_id, "clipCount": int(clip_count)}).encode()
        ok = await self._send("success", self.client.send_durable_execution_callback_success, Result=result)
        log("info", "callback.success", callback=self.ref, job=job_id, sent=ok)
        return ok

    async def fail(self, error_type: str, message: str) -> bool:
        await self._stop_beat()
        if self.closed:
            return False
        self.closed = True
        error = {"ErrorType": error_type, "ErrorMessage": (message or GENERIC_FAILURE)[:MAX_MESSAGE]}
        ok = await self._send("failure", self.client.send_durable_execution_callback_failure, Error=error)
        log("info", "callback.failure", callback=self.ref, type=error_type, sent=ok)
        return ok

    async def close(self) -> None:
        """Stops a heartbeat still in flight (the run is over)."""
        await self._stop_beat()


async def report(cb: DurableCallback | None, status: str, *, job_id: str, clip_count: int, error: str | None) -> None:
    """Sends the run's final status (``ready``, ``failed``, ``canceled``, ``superseded`` or ``stopped``: the container
    is shutting down) to the job flow."""
    if cb is None:
        return
    if status == "ready":
        await cb.succeed(job_id, clip_count)
    elif status == "canceled":
        await cb.fail(CANCELED, CANCELED_MESSAGE)
    elif status == "superseded":
        await cb.fail(SUPERSEDED, SUPERSEDED_MESSAGE)
    elif status == "stopped":
        await cb.fail(AGENT_STOPPED, STOPPED_MESSAGE)
    elif status == "mac":
        # YouTube blocked the cloud: the job flow waits for the owner's Mac to send the video (§35.1).
        await cb.fail(MAC_FETCH, error or "Waiting for your Mac to get the video")
    else:
        await cb.fail(JOB_FAILED, error or GENERIC_FAILURE)
