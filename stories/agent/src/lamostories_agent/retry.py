"""Retrying transient AWS failures (throttling, timeouts, 5xx) with jittered exponential backoff, on the event loop
(``retry``) or in a worker thread (``retry_sync``, for the model client, which runs off the loop, §45.33)."""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable

from .util import TransientError, log

_TRANSIENT_CODES = frozenset(
    {
        "ThrottlingException",
        "Throttling",
        "TooManyRequestsException",
        "ProvisionedThroughputExceededException",
        "RequestLimitExceeded",
        "LimitExceededException",
        "ServiceUnavailable",
        "ServiceUnavailableException",
        "InternalServerError",
        "InternalServerException",
        "InternalFailure",
        "ModelNotReadyException",
        "ModelErrorException",
        "ModelTimeoutException",
        "RequestTimeout",
        "RequestTimeoutException",
        "SlowDown",
        "BadGateway",
    }
)
_TRANSIENT_NAMES = frozenset(
    {
        "EndpointConnectionError",
        "ConnectionClosedError",
        "ReadTimeoutError",
        "ConnectTimeoutError",
        "ConnectionError",
        "TimeoutError",
    }
)


def error_code(e: BaseException) -> str:
    response = getattr(e, "response", None)
    if not isinstance(response, dict):
        return ""
    return str((response.get("Error") or {}).get("Code") or "")


def is_transient(e: BaseException) -> bool:
    if isinstance(e, TransientError):
        return True
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        status = int((response.get("ResponseMetadata") or {}).get("HTTPStatusCode") or 0)
        return error_code(e) in _TRANSIENT_CODES or status >= 500 or status == 429
    return type(e).__name__ in _TRANSIENT_NAMES


def _delay(attempt: int, base: float, cap: float) -> float:
    return min(cap, base * 2 ** (attempt - 1)) * (0.5 + random.random() / 2)  # noqa: S311


async def retry[T](
    fn: Callable[[], Awaitable[T]],
    *,
    what: str,
    attempts: int = 4,
    base: float = 2.0,
    cap: float = 60.0,
    transient: Callable[[BaseException], bool] = is_transient,
) -> T:
    for attempt in range(1, attempts + 1):
        try:
            return await fn()
        except Exception as e:
            if attempt == attempts or not transient(e):
                raise
            log("warn", "retry", what=what, attempt=attempt, error=type(e).__name__, detail=str(e)[:300])
            await asyncio.sleep(_delay(attempt, base, cap))
    raise AssertionError("unreachable")


def retry_sync[T](
    fn: Callable[[], T],
    *,
    what: str,
    attempts: int = 3,
    base: float = 2.0,
    cap: float = 30.0,
    sleep: Callable[[float], None] = time.sleep,
    transient: Callable[[BaseException], bool] = is_transient,
) -> T:
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == attempts or not transient(e):
                raise
            log("warn", "retry", what=what, attempt=attempt, error=type(e).__name__, detail=str(e)[:300])
            sleep(_delay(attempt, base, cap))
    raise AssertionError("unreachable")
