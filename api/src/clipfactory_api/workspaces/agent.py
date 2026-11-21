"""Starts, cancels and stops Lamo Stories jobs on the AgentCore runtime (docs/CONTRACTS.md §45.5, §45.11.1).

Uses only the public helpers of ``agent_client.py`` (which stays byte-identical): its client factory, ``AgentError``,
``is_retryable`` and the minimum session length. Every story or portrait run gets its own runtime session
``"cfstory-" + jobId + "-" + 8 random chars`` (at least 33 characters); a call is tried twice on a retryable error.
The agent answers ``{"accepted": true, "jobId"}`` at once and runs the job in the background.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from typing import Any

from ..agent_client import MIN_SESSION_LENGTH, AgentError, is_retryable, make_client
from ..ids import random_suffix
from ..log import log

SESSION_PREFIX = "cfstory-"
ATTEMPTS = 2
READ_TIMEOUT = 20
RETRY_WITHIN_SECONDS = 6.0  # the API request has 29 s; one 20 s read plus a second try would not fit


def new_session_id(job_id: str) -> str:
    session = f"{SESSION_PREFIX}{job_id}-{random_suffix(8)}"
    if len(session) < MIN_SESSION_LENGTH:
        raise ValueError("session id too short")
    return session


class StoryAgent:
    """``client`` is a boto3 ``bedrock-agentcore`` client, or a factory that makes one on first use."""

    def __init__(self, client: Any, runtime_arn: str) -> None:
        self._client = client
        self._factory: Callable[[], Any] | None = client if callable(client) and not _is_client(client) else None
        self.runtime_arn = runtime_arn

    @property
    def ready(self) -> bool:
        return bool(self.runtime_arn)

    def _boto(self) -> Any:
        if self._factory is not None:
            self._client = self._factory()
            self._factory = None
        return self._client

    def start_story(self, *, user_id: str, workspace_id: str, story_id: str, job_id: str, session_id: str) -> None:
        payload = {
            "action": "process_story",
            "userId": user_id,
            "workspaceId": workspace_id,
            "storyId": story_id,
            "jobId": job_id,
        }
        self._start(session_id, payload)

    def start_portrait(
        self, *, user_id: str, workspace_id: str, character_id: str, job_id: str, session_id: str
    ) -> None:
        payload = {
            "action": "process_portrait",
            "userId": user_id,
            "workspaceId": workspace_id,
            "characterId": character_id,
            "jobId": job_id,
        }
        self._start(session_id, payload)

    def cancel_story(self, job_id: str, session_id: str) -> None:
        self._invoke(session_id, {"action": "cancel_story", "jobId": job_id})

    def stop_session(self, session_id: str) -> None:
        """Ends a runtime session outright; a session that is already gone is not an error."""
        if not self.runtime_arn:
            raise AgentError("AGENT_RUNTIME_ARN is not set")
        last: Exception | None = None
        for _ in range(ATTEMPTS):
            try:
                self._boto().stop_runtime_session(agentRuntimeArn=self.runtime_arn, runtimeSessionId=session_id)
                return
            except Exception as e:
                code = getattr(e, "response", {}).get("Error", {}).get("Code")
                if code == "ResourceNotFoundException":
                    return
                last = e
                if not is_retryable(e):
                    break
        raise AgentError(f"stop failed: {type(last).__name__}", retryable=bool(last and is_retryable(last)))

    def _start(self, session_id: str, payload: dict[str, Any]) -> None:
        reply = self._invoke(session_id, payload)
        if reply.get("accepted") is not True:
            raise AgentError("the agent did not accept the story job")

    def _invoke(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.runtime_arn:
            raise AgentError("AGENT_RUNTIME_ARN is not set")
        attempt = 1
        while True:
            started = time.monotonic()
            try:
                return self._invoke_once(session_id, payload)
            except AgentError as e:
                slow = time.monotonic() - started > RETRY_WITHIN_SECONDS
                log("warning", "stories.agent_call_failed", action=payload.get("action"), attempt=attempt, slow=slow)
                # A second try only after a quick refusal: after a slow one it would outlive the 29 s request.
                if not e.retryable or slow or attempt >= ATTEMPTS:
                    raise
            attempt += 1

    def _invoke_once(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            out = self._boto().invoke_agent_runtime(
                agentRuntimeArn=self.runtime_arn,
                runtimeSessionId=session_id,
                contentType="application/json",
                accept="application/json",
                payload=json.dumps(payload).encode(),
            )
        except Exception as e:
            raise AgentError(f"invoke failed: {type(e).__name__}", retryable=is_retryable(e)) from e
        status = out.get("statusCode") or out.get("ResponseMetadata", {}).get("HTTPStatusCode") or 200
        if status >= 400:
            raise AgentError(f"runtime answered {status}", retryable=status >= 500 or status == 429)
        body = _read(out.get("response"))
        try:
            parsed = json.loads(body) if body else {}
        except ValueError:
            parsed = {}
        return parsed if isinstance(parsed, dict) else {}


def _is_client(value: Any) -> bool:
    """A boto3 client (or a test fake) has the runtime calls; a factory is a plain function."""
    return hasattr(value, "invoke_agent_runtime")


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


def from_env() -> StoryAgent | None:
    """None (making videos is not switched on) until ``AGENT_RUNTIME_ARN`` is set; the client is made on first use."""
    arn = os.environ.get("AGENT_RUNTIME_ARN", "")
    if not arn:
        return None
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-north-1"
    return StoryAgent(lambda: make_client(region, read_timeout=READ_TIMEOUT), arn)
