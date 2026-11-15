"""Durable Lambda functions (docs/CONTRACTS.md §14.4, §14.5), built on ``aws-durable-execution-sdk-python``.

``job_flow`` (``cf-prod-job-flow``) starts the agent for one job run and waits for its callback; ``clip_flow``
(``cf-prod-clip-flow``) publishes a kept clip, waits 48 hours, reads the metrics, distils a Learning and updates
the clip's vector. Each module's ``handler`` is a thin ``@durable_execution`` wrapper around a plain
``run_*(ctx, event, deps)`` function, so the tests drive the flow with a fake context.

Steps are at-least-once, so the work inside every step is idempotent (conditional writes, read-before-act).
Only the durable handlers import this package: the HTTP, realtime and hooks Lambdas never load the SDK.
"""

from __future__ import annotations

from typing import Any

from aws_durable_execution_sdk_python.config import Duration, StepConfig, StepSemantics
from aws_durable_execution_sdk_python.retries import RetryStrategyConfig, create_retry_strategy

from ..agent_client import is_retryable

SDK_ERROR_PREFIX = "aws_durable_execution_sdk_python."


class TransientError(Exception):
    """A passing AWS problem (throttling, 5xx, connection): the step's retry strategy tries again."""


def transient(e: BaseException) -> BaseException:
    """``e`` as a ``TransientError`` when it is worth another try, else unchanged (re-raise the result)."""
    return TransientError(f"{type(e).__name__}: {e}") if is_retryable(e) else e


def retrying(
    *errors: type[Exception], attempts: int = 3, semantics: StepSemantics = StepSemantics.AT_LEAST_ONCE_PER_RETRY
) -> StepConfig:
    """``attempts`` tries with exponential backoff (2 s, 4 s, ...), only for the given error types."""
    strategy = create_retry_strategy(
        RetryStrategyConfig(
            max_attempts=attempts,
            initial_delay=Duration.from_seconds(2),
            max_delay=Duration.from_minutes(1),
            backoff_rate=2.0,
            retryable_error_types=list(errors) or [TransientError],
        )
    )
    return StepConfig(retry_strategy=strategy, step_semantics=semantics)


def error_type(err: BaseException, callback: Any = None) -> str | None:
    """The ``ErrorType`` the external system sent with a callback failure (``JobFailed``, ``Canceled``, ...).

    The SDK raises ``CallbackExternalError`` with its own class as ``error_type`` and keeps the external type on the
    callback operation, so it is read from the checkpoint first. A test double may set it on the error instead.
    """
    try:
        checkpoint = callback.state.get_checkpoint_result(callback.operation_id)
        value = checkpoint.error.type if checkpoint.error else None
        if isinstance(value, str) and value:
            return value
    except Exception:  # noqa: S110 - best effort; the error itself is the fallback
        pass
    value = getattr(err, "error_type", None)
    if isinstance(value, str) and value and not value.startswith(SDK_ERROR_PREFIX):
        return value
    return None


def error_message(err: BaseException) -> str:
    value = getattr(err, "message", None)
    return value if isinstance(value, str) else str(err)
