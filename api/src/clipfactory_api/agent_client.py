"""Starts and cancels jobs on the AgentCore runtime (docs/CONTRACTS.md §8, §14.4).

Each job run gets its own runtime session ``cfjob-<jobId>-<8 random chars>``: a retry starts a fresh session (a
fresh container), while a cancel reuses the running job's session so it reaches the container doing the work.
``process_job`` is sent by the durable ``cf-prod-job-flow`` (with the callback id the agent ends with); the API
only sends ``cancel`` and stops sessions.
"""

from __future__ import annotations

import json
from typing import Any

from .ids import random_suffix

SESSION_PREFIX = "cfjob-"
MIN_SESSION_LENGTH = 33  # AgentCore rejects shorter runtime session ids


RETRYABLE_CODES = frozenset(
    {
        "ThrottlingException",
        "TooManyRequestsException",
        "ServiceQuotaExceededException",
        "ServiceUnavailableException",
        "InternalServerException",
        "RequestTimeout",
        "RequestTimeoutException",
    }
)


class AgentError(Exception):
    """The runtime refused or failed the call. ``retryable`` marks throttling, 5xx and connection problems."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


def is_retryable(e: BaseException) -> bool:
    """Throttling, a 5xx answer or a connection/timeout problem: worth another try."""
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0
        return code in RETRYABLE_CODES or int(status) >= 500 or int(status) == 429
    names = {c.__name__ for c in type(e).__mro__}
    return bool(
        names
        & {"ConnectionError", "TimeoutError", "EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError"}
    )


def new_session_id(job_id: str) -> str:
    session = f"{SESSION_PREFIX}{job_id}-{random_suffix(8)}"
    if len(session) < MIN_SESSION_LENGTH:
        raise ValueError("session id too short")
    return session


def make_client(region: str, *, read_timeout: int = 20) -> Any:
    import boto3
    from botocore.config import Config

    # Invocations return at once ({"accepted": true}); the job runs in the background. In the API Lambda (29 s
    # limit) the worst case (connect + read, no retries) must stay well under that, so a hung cancel never outlives
    # the request. The job-flow step has its own durable retries, so botocore never retries here either.
    config = Config(retries={"mode": "standard", "total_max_attempts": 1}, connect_timeout=3, read_timeout=read_timeout)
    return boto3.client("bedrock-agentcore", region_name=region, config=config)


class AgentClient:
    def __init__(self, client: Any, runtime_arn: str) -> None:
        self._client = client
        self._arn = runtime_arn

    def start_job(self, job_id: str, user_id: str, session_id: str, callback_id: str) -> None:
        payload = {"action": "process_job", "jobId": job_id, "userId": user_id, "callbackId": callback_id}
        reply = self._invoke(session_id, payload)
        if reply.get("accepted") is not True:
            raise AgentError("the agent did not accept the job")

    def overlay(self, user_id: str, clip_id: str, job_id: str, rev: int) -> None:
        """Asks the runtime to draw the clip's logo and text (docs/CONTRACTS.md §53 C5). Each ask gets its own fresh
        session (``cfjob-<clipId>-<8 random chars>``, 41 characters). The agent answers at once and works in the
        background; what it writes (or why it failed) is on the clip. A refusal raises ``AgentError``."""
        payload = {"action": "overlay", "userId": user_id, "clipId": clip_id, "jobId": job_id, "rev": rev}
        reply = self._invoke(new_session_id(clip_id), payload)
        if reply.get("accepted") is False or reply.get("error"):
            raise AgentError("the agent did not accept the edit")

    def reference(self, user_id: str, ref_id: str, rev: int) -> None:
        """Asks the runtime to look at a reference video and write its edit style (docs/CONTRACTS.md §57). Each ask
        gets its own fresh session (``cfjob-<refId>-<8 random chars>``, 41 characters). The agent answers at once and
        works in the background; what it writes (or why it failed) is on the item. A refusal raises ``AgentError``."""
        payload = {"action": "reference", "userId": user_id, "refId": ref_id, "rev": rev}
        reply = self._invoke(new_session_id(ref_id), payload)
        if reply.get("accepted") is False or reply.get("error"):
            raise AgentError("the agent did not accept the reference video")

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
            raise AgentError(f"stop failed: {type(e).__name__}", retryable=is_retryable(e)) from e

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
            raise AgentError(f"invoke failed: {type(e).__name__}", retryable=is_retryable(e)) from e
        status = out.get("statusCode") or out.get("ResponseMetadata", {}).get("HTTPStatusCode") or 200
        body = _read(out.get("response"))
        if status >= 400:
            raise AgentError(f"runtime answered {status}", retryable=status >= 500 or status == 429)
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
