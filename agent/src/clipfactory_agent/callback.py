"""The agent's side of the durable callback of ``cf-prod-job-flow`` (docs/CONTRACTS.md §14.4).

The job flow passes a ``callbackId`` in ``process_job`` and waits, with no compute, until the agent sends:

* a heartbeat at most once every 5 minutes while the job runs (the flow's heartbeat timeout is 15 minutes, so a
  container that died is noticed without any scan);
* success, after finalize wrote the Job ``ready``: ``{"jobId", "clipCount"}``;
* failure: ``JobFailed`` (the agent wrote the Job ``failed``), ``Canceled`` (the owner canceled) or ``Superseded``
  (a retry gave the job a new session, §13 "One run per job"), with the Job's plain-sentence error.

Every send retries throttling and 5xx errors 3 times. A callback that is already closed, timed out or unknown is
ignored, and no send ever fails the job: a lost message ends the flow through its heartbeat timeout instead."""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import Callable
from typing import Any

from .retry import is_transient, retry
from .util import log

HEARTBEAT_SECONDS = 300.0  # at most once per 5 minutes; the flow's heartbeat timeout is 15
SEND_ATTEMPTS = 4  # the first try plus 3 retries
MAX_MESSAGE = 256

JOB_FAILED = "JobFailed"
CANCELED = "Canceled"
SUPERSEDED = "Superseded"

CANCELED_MESSAGE = "The job was canceled."
SUPERSEDED_MESSAGE = "A newer run of this job took over."
GENERIC_FAILURE = "Something went wrong while making the clips. Press Retry."

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
    """One run's callback. ``beat()`` is cheap and safe to call often (from the job heartbeat loop): it sends at most
    once per ``heartbeat_every`` seconds, in the background. Exactly one of ``succeed``/``fail`` is sent per run."""

    def __init__(
        self,
        callback_id: str,
        client: Any,
        *,
        heartbeat_every: float = HEARTBEAT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        retry_base: float = 1.0,
    ) -> None:
        self.callback_id = callback_id
        self.client = client
        self.heartbeat_every = heartbeat_every
        self.clock = clock
        self.retry_base = retry_base
        self.closed = False  # a terminal message was sent, or the flow no longer waits for one
        self._last_beat: float | None = None
        self._beat_task: asyncio.Task[bool] | None = None

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
            if is_closed(e):
                log("info", "callback.closed", what=what, callback=self.ref, error=_code(e) or type(e).__name__)
                self.closed = True
            else:
                log("warn", "callback.send_failed", what=what, callback=self.ref, error=_code(e) or type(e).__name__)
            return False

    # --- heartbeat ------------------------------------------------------------------------------------------------

    def due(self) -> bool:
        return not self.closed and (self._last_beat is None or self.clock() - self._last_beat >= self.heartbeat_every)

    def beat(self) -> None:
        """Starts a heartbeat in the background when one is due and none is in flight."""
        if not self.due() or (self._beat_task is not None and not self._beat_task.done()):
            return
        self._last_beat = self.clock()
        self._beat_task = asyncio.get_running_loop().create_task(self.heartbeat(), name="callback-heartbeat")

    async def heartbeat(self) -> bool:
        if self.closed:
            return False
        ok = await self._send("heartbeat", self.client.send_durable_execution_callback_heartbeat)
        if ok:
            log("info", "callback.heartbeat", callback=self.ref)
        return ok

    async def _stop_beat(self) -> None:
        task, self._beat_task = self._beat_task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

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
    """Sends the run's final status (``ready``, ``failed``, ``canceled`` or ``superseded``) to the job flow."""
    if cb is None:
        return
    if status == "ready":
        await cb.succeed(job_id, clip_count)
    elif status == "canceled":
        await cb.fail(CANCELED, CANCELED_MESSAGE)
    elif status == "superseded":
        await cb.fail(SUPERSEDED, SUPERSEDED_MESSAGE)
    else:
        await cb.fail(JOB_FAILED, error or GENERIC_FAILURE)
