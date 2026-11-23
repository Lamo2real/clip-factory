"""Starts, cancels and stops work on **Lamo Stories' own** AgentCore runtime (docs/CONTRACTS.md §45.5, §45.11.1).

Only ``cf_prod_story_agent`` is ever called: its ARN comes from ``STORIES_AGENT_RUNTIME_ARN`` (never Clip Factory's
``AGENT_RUNTIME_ARN``), and this module does not import Clip Factory's ``agent_client`` (which stays byte-identical),
so a change on either side never reaches the other. Every run gets its own runtime session
``"cfstory-" + id + "-" + 8 random chars`` (at least 33 characters); a call is tried twice on a retryable error, with
a 20 s read timeout, and never a second time after a slow first try (it would outlive the request). The runtime
answers ``{"accepted": true, "id"}`` at once and does the work in the background.

Best-effort calls (a stop after the fence, a cancel's ``cancel`` and stop) are made once, and only while
``time_for_call`` says one more call still ends inside the request's 29 s: the item's new ``sessionId`` already fences
the old run out, so a skipped or failed one changes nothing the owner sees.

Actions (§45.11.1): ``process_story``, ``process_portrait``, ``process_reference``, ``run_task``, ``check_models``,
``chat_turn``, ``provider_check`` (§45.35 D2: "Try it", one test call of a maker), ``cancel { id }``.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from typing import Any, Final

from ..ids import random_suffix
from ..log import log

ENV_ARN: Final = "STORIES_AGENT_RUNTIME_ARN"
SESSION_PREFIX: Final = "cfstory-"
MIN_SESSION_LENGTH: Final = 33  # AgentCore refuses shorter runtime session ids
ATTEMPTS: Final = 2
CONNECT_TIMEOUT: Final = 3
READ_TIMEOUT: Final = 20
RETRY_WITHIN_SECONDS: Final = 6.0  # the API request has 29 s; one 20 s read plus a second try would not fit
CALL_SECONDS: Final = CONNECT_TIMEOUT + READ_TIMEOUT  # one call at worst (botocore makes no retries of its own)
REQUEST_SECONDS: Final = 29.0  # API Gateway's integration timeout, and cf-prod-stories-api's own
AFTER_CALL_SECONDS: Final = 2.0  # what a request still does after its last best-effort call (re-reads, the answer)
RETRYABLE_CODES: Final = frozenset(
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
_RETRYABLE_TYPES: Final = frozenset(
    {"ConnectionError", "TimeoutError", "EndpointConnectionError", "ConnectTimeoutError", "ReadTimeoutError"}
)


class StoriesAgentError(Exception):
    """The runtime refused or failed the call. ``retryable`` marks throttling, 5xx and connection problems."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


def _error_code(e: BaseException) -> str | None:
    """A ClientError's code; None for others (botocore's connection errors carry ``response = None``)."""
    response = getattr(e, "response", None)
    code = response.get("Error", {}).get("Code") if isinstance(response, dict) else None
    return str(code) if code else None


def is_retryable(e: BaseException) -> bool:
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        status = response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0
        return code in RETRYABLE_CODES or int(status) >= 500 or int(status) == 429
    return bool({c.__name__ for c in type(e).__mro__} & _RETRYABLE_TYPES)


def time_for_call(started: float | None, *, after: float = AFTER_CALL_SECONDS) -> bool:
    """Whether one more call (``CALL_SECONDS`` at worst, one attempt) still ends inside the request's 29 s with
    ``after`` seconds to spare. ``started`` is the request's ``time.monotonic()`` on arrival; None: no request."""
    if started is None:
        return True
    return time.monotonic() - started + CALL_SECONDS + after <= REQUEST_SECONDS


def new_session_id(item_id: str) -> str:
    """``cfstory-{id}-{8 random}``: a job id, task id or message id (26 characters) gives 43."""
    session = f"{SESSION_PREFIX}{item_id}-{random_suffix(8)}"
    if len(session) < MIN_SESSION_LENGTH:
        raise ValueError("session id too short")
    return session


def make_client(region: str) -> Any:
    import boto3
    from botocore.config import Config

    # Invocations answer at once; in the 29 s API Lambda the worst case (connect + read, no botocore retries) must
    # stay well under that, so a hung call never outlives the request.
    config = Config(
        retries={"mode": "standard", "total_max_attempts": 1},
        connect_timeout=CONNECT_TIMEOUT,
        read_timeout=READ_TIMEOUT,
    )
    return boto3.client("bedrock-agentcore", region_name=region, config=config)


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

    # --- the actions ------------------------------------------------------------------------------------------

    def start_story(self, *, user_id: str, workspace_id: str, story_id: str, job_id: str, session_id: str) -> None:
        self._start(
            session_id,
            {
                "action": "process_story",
                "userId": user_id,
                "workspaceId": workspace_id,
                "storyId": story_id,
                "jobId": job_id,
            },
        )

    def start_portrait(
        self, *, user_id: str, workspace_id: str, character_id: str, job_id: str, session_id: str
    ) -> None:
        self._start(
            session_id,
            {
                "action": "process_portrait",
                "userId": user_id,
                "workspaceId": workspace_id,
                "characterId": character_id,
                "jobId": job_id,
            },
        )

    def start_provider_check(
        self, *, user_id: str, workspace_id: str, provider_id: str, job_id: str, session_id: str
    ) -> None:
        """``provider_check`` (§45.35 D2): the job's one step ``check`` tries the maker once (Luma AI Ray2: one 5-second
        test shot into the United States bucket, deleted after), then proves ``PROVIDER#{kind}#{id}`` or records the
        maker's own sentence."""
        self._start(
            session_id,
            {
                "action": "provider_check",
                "userId": user_id,
                "workspaceId": workspace_id,
                "providerId": provider_id,
                "jobId": job_id,
            },
        )

    def start_reference(self, *, user_id: str, workspace_id: str, ref_id: str, job_id: str, session_id: str) -> None:
        self._start(
            session_id,
            {
                "action": "process_reference",
                "userId": user_id,
                "workspaceId": workspace_id,
                "refId": ref_id,
                "jobId": job_id,
            },
        )

    def start_task(self, *, user_id: str, workspace_id: str, task_id: str, kind: str, session_id: str) -> None:
        """``run_task`` (ideas, expand, variations, character design, captions), or ``check_models``."""
        action = "check_models" if kind == "check_models" else "run_task"
        self._start(session_id, {"action": action, "userId": user_id, "workspaceId": workspace_id, "taskId": task_id})

    def start_chat_turn(self, *, user_id: str, workspace_id: str, conv_id: str, msg_id: str, session_id: str) -> None:
        self._start(
            session_id,
            {
                "action": "chat_turn",
                "userId": user_id,
                "workspaceId": workspace_id,
                "convId": conv_id,
                "msgId": msg_id,
            },
        )

    def cancel(self, item_id: str, session_id: str, *, attempts: int = ATTEMPTS) -> None:
        """Asks the session doing the work to stop it (best effort: the item's new ``sessionId`` already fences it)."""
        self._invoke(session_id, {"action": "cancel", "id": item_id}, attempts=attempts)

    def stop_session(self, session_id: str, *, attempts: int = ATTEMPTS) -> None:
        """Ends a runtime session outright; a session that is already gone is not an error. Like every call, a second
        try only after a quick refusal (``attempts=1``: never)."""
        if not self.runtime_arn:
            raise StoriesAgentError(f"{ENV_ARN} is not set")
        attempt = 1
        while True:
            started = time.monotonic()
            try:
                self._boto().stop_runtime_session(agentRuntimeArn=self.runtime_arn, runtimeSessionId=session_id)
                return
            except Exception as e:
                if _error_code(e) == "ResourceNotFoundException":
                    return
                retryable = is_retryable(e)
                slow = time.monotonic() - started > RETRY_WITHIN_SECONDS
                log("warning", "stories.agent_call_failed", action="stop", attempt=attempt, slow=slow)
                if not retryable or slow or attempt >= attempts:
                    raise StoriesAgentError(f"stop failed: {type(e).__name__}", retryable=retryable) from e
            attempt += 1

    # --- the calls --------------------------------------------------------------------------------------------

    def _start(self, session_id: str, payload: dict[str, Any]) -> None:
        reply = self._invoke(session_id, payload)
        if reply.get("accepted") is not True:
            raise StoriesAgentError("Funded Clips' agent did not accept the work")

    def _invoke(self, session_id: str, payload: dict[str, Any], *, attempts: int = ATTEMPTS) -> dict[str, Any]:
        if not self.runtime_arn:
            raise StoriesAgentError(f"{ENV_ARN} is not set")
        attempt = 1
        while True:
            started = time.monotonic()
            try:
                return self._invoke_once(session_id, payload)
            except StoriesAgentError as e:
                slow = time.monotonic() - started > RETRY_WITHIN_SECONDS
                log("warning", "stories.agent_call_failed", action=payload.get("action"), attempt=attempt, slow=slow)
                # A second try only after a quick refusal: after a slow one it would outlive the 29 s request.
                if not e.retryable or slow or attempt >= attempts:
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
            raise StoriesAgentError(f"invoke failed: {type(e).__name__}", retryable=is_retryable(e)) from e
        status = out.get("statusCode") or out.get("ResponseMetadata", {}).get("HTTPStatusCode") or 200
        if status >= 400:
            raise StoriesAgentError(f"runtime answered {status}", retryable=status >= 500 or status == 429)
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
    """None (Lamo Stories' agent is not switched on) until ``STORIES_AGENT_RUNTIME_ARN`` is set; the client is made
    on first use."""
    arn = os.environ.get(ENV_ARN, "")
    if not arn:
        return None
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-north-1"
    return StoryAgent(lambda: make_client(region), arn)
