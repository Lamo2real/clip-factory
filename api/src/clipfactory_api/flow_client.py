"""Starts the durable Lambda functions ``cf-prod-job-flow`` and ``cf-prod-clip-flow`` (docs/CONTRACTS.md §14.4, §14.5).

A durable execution starts with a normal asynchronous Invoke on the function's **alias** ARN (``...:live``; an
unqualified name or ``$LATEST`` is never used) with a ``DurableExecutionName``. The name and the payload are fully
determined by the job or clip and its run number (no timestamps), so repeating a start is safe: Lambda answers a
running or finished execution with the same name and payload with that execution, and
``DurableExecutionAlreadyStartedException`` (same name, other payload) is treated as "already started".

This module only uses the plain boto3 Lambda client: the API Lambda never imports the durable execution SDK.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

ALREADY_STARTED = "DurableExecutionAlreadyStartedException"
_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ALIAS_ARN = re.compile(r"^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$")


class FlowStartError(Exception):
    """The flow could not be started (Lambda refused or failed the Invoke)."""


@dataclass(frozen=True)
class Started:
    name: str
    execution_arn: str | None  # None when the execution already existed


def job_flow_name(job_id: str, run: int) -> str:
    return _checked_name(f"job-{job_id}-{run}")


def clip_flow_name(clip_id: str, run: int) -> str:
    return _checked_name(f"clip-{clip_id}-{run}")


def _checked_name(name: str) -> str:
    if not _NAME.match(name):
        raise ValueError(f"not a valid durable execution name: {name!r}")
    return name


def make_client(region: str) -> Any:
    import boto3
    from botocore.config import Config

    # An asynchronous Invoke returns in milliseconds. Short timeouts keep a slow endpoint inside the 29 s API limit.
    config = Config(retries={"mode": "standard", "total_max_attempts": 2}, connect_timeout=2, read_timeout=6)
    return boto3.client("lambda", region_name=region, config=config)


class FlowClient:
    def __init__(self, client: Any, job_flow_arn: str, clip_flow_arn: str) -> None:
        self._client = client
        self.job_flow_arn = job_flow_arn
        self.clip_flow_arn = clip_flow_arn

    def start_job_flow(self, job_id: str, user_id: str, session_id: str, run: int) -> Started:
        payload = {"jobId": job_id, "userId": user_id, "sessionId": session_id, "run": run}
        return self._start(self.job_flow_arn, job_flow_name(job_id, run), payload)

    def start_clip_flow(self, clip_id: str, user_id: str, run: int) -> Started:
        payload = {"clipId": clip_id, "userId": user_id, "run": run}
        return self._start(self.clip_flow_arn, clip_flow_name(clip_id, run), payload)

    # --- the job flow's mac-done callback (docs/CONTRACTS.md §35) -----------------------------------------------------

    def mac_done(self, callback_id: str, result: dict[str, Any]) -> bool:
        """Tells the job flow the Mac's video is in S3. False when the callback is already closed (timed out, or
        completed by an earlier try of the same request)."""
        return self._callback(
            lambda: self._client.send_durable_execution_callback_success(
                CallbackId=callback_id, Result=json.dumps(result, sort_keys=True).encode()
            )
        )

    def mac_stopped(self, callback_id: str, error_type: str, message: str) -> bool:
        """Ends the job flow's wait: ``MacFailed`` (the Mac stopped; ``message`` is the owner's words) or
        ``Canceled`` (the owner stopped the job)."""
        return self._callback(
            lambda: self._client.send_durable_execution_callback_failure(
                CallbackId=callback_id, Error={"ErrorType": error_type, "ErrorMessage": message[:256]}
            )
        )

    @staticmethod
    def _callback(send: Callable[[], Any]) -> bool:
        try:
            send()
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            text = str(e).lower()
            if code in {"ResourceNotFoundException", "CallbackTimeoutException"} or any(
                w in text for w in ("closed", "completed", "already", "timed out", "not found", "expired")
            ):
                return False
            raise FlowStartError(f"callback failed: {code or type(e).__name__}") from e
        return True

    def _start(self, arn: str, name: str, payload: dict[str, Any]) -> Started:
        if not _ALIAS_ARN.match(arn or ""):
            raise FlowStartError("the flow ARN is missing or is not an alias ARN")
        try:
            out = self._client.invoke(
                FunctionName=arn,
                InvocationType="Event",
                DurableExecutionName=name,
                Payload=json.dumps(payload, sort_keys=True).encode(),
            )
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code == ALREADY_STARTED:
                return Started(name, None)
            raise FlowStartError(f"invoke failed: {code or type(e).__name__}") from e
        status = int(out.get("StatusCode") or 0)
        if status and status >= 300:
            raise FlowStartError(f"invoke answered {status}")
        arn_out = out.get("DurableExecutionArn")
        return Started(name, str(arn_out) if arn_out else None)
