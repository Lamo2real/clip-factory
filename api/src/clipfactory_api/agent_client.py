"""Starts and cancels jobs on the AgentCore runtime (docs/CONTRACTS.md §8).

Each job run gets its own runtime session ``cfjob-<jobId>-<8 random chars>``: a retry starts a fresh session (a
fresh container), while a cancel reuses the running job's session so it reaches the container doing the work.
"""

from __future__ import annotations

import json
from typing import Any

from .ids import random_suffix

SESSION_PREFIX = "cfjob-"
MIN_SESSION_LENGTH = 33  # AgentCore rejects shorter runtime session ids


class AgentError(Exception):
    """The runtime refused or failed the call."""


def new_session_id(job_id: str) -> str:
    session = f"{SESSION_PREFIX}{job_id}-{random_suffix(8)}"
    if len(session) < MIN_SESSION_LENGTH:
        raise ValueError("session id too short")
    return session


def make_client(region: str) -> Any:
    import boto3
    from botocore.config import Config

    # Invocations return at once ({"accepted": true}); the job runs in the background. The API Lambda (and its
    # HTTP API integration) stop at 29 s, so the worst case here (connect + read, no retries) must stay well under
    # that: a slow or hung start then raises AgentError in time for jobs.start to mark the job failed ("Press
    # Retry") instead of the Lambda being killed and the job sitting queued until the watchdog.
    config = Config(retries={"mode": "standard", "total_max_attempts": 1}, connect_timeout=3, read_timeout=20)
    return boto3.client("bedrock-agentcore", region_name=region, config=config)


class AgentClient:
    def __init__(self, client: Any, runtime_arn: str) -> None:
        self._client = client
        self._arn = runtime_arn

    def start_job(self, job_id: str, user_id: str, session_id: str) -> None:
        reply = self._invoke(session_id, {"action": "process_job", "jobId": job_id, "userId": user_id})
        if reply.get("accepted") is not True:
            raise AgentError("the agent did not accept the job")

    def cancel_job(self, job_id: str, session_id: str) -> None:
        self._invoke(session_id, {"action": "cancel", "jobId": job_id})

    def stop_session(self, session_id: str) -> None:
        """Ends a runtime session outright (StopRuntimeSession): its container stops, nothing new is started.
        A session that is already gone is not an error."""
        if not self._arn:
            raise AgentError("AGENT_RUNTIME_ARN is not set")
        try:
            self._client.stop_runtime_session(agentRuntimeArn=self._arn, runtimeSessionId=session_id)
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code == "ResourceNotFoundException":
                return
            raise AgentError(f"stop failed: {type(e).__name__}") from e

    def _invoke(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._arn:
            raise AgentError("AGENT_RUNTIME_ARN is not set")
        try:
            out = self._client.invoke_agent_runtime(
                agentRuntimeArn=self._arn,
                runtimeSessionId=session_id,
                contentType="application/json",
                accept="application/json",
                payload=json.dumps(payload).encode(),
            )
        except Exception as e:
            raise AgentError(f"invoke failed: {type(e).__name__}") from e
        status = out.get("statusCode") or out.get("ResponseMetadata", {}).get("HTTPStatusCode") or 200
        body = _read(out.get("response"))
        if status >= 400:
            raise AgentError(f"runtime answered {status}")
        try:
            parsed = json.loads(body) if body else {}
        except ValueError:
            parsed = {}
        return parsed if isinstance(parsed, dict) else {}


def _read(stream: Any) -> bytes:
    if stream is None:
        return b""
    if isinstance(stream, bytes | bytearray):
        return bytes(stream)
    try:
        data: bytes = stream.read()
    finally:
        close = getattr(stream, "close", None)
        if close:
            close()
    return data
