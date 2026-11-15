"""Retrying transient failures (throttling, timeouts, 5xx) with jittered exponential backoff."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable

from .util import TransientError, log

_TRANSIENT_CODES = {
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
    "RequestTimeout",
    "RequestTimeoutException",
    "SlowDown",
    "BadGateway",
}
_TRANSIENT_NAMES = {
    "EndpointConnectionError",
    "ConnectionClosedError",
    "ReadTimeoutError",
    "ConnectTimeoutError",
    "ConnectionError",
    "TimeoutError",
}


def is_transient(e: BaseException) -> bool:
    if isinstance(e, TransientError):
        return True
    response = getattr(e, "response", None)
    if isinstance(response, dict):
        code = str((response.get("Error") or {}).get("Code") or "")
        status = int((response.get("ResponseMetadata") or {}).get("HTTPStatusCode") or 0)
        return code in _TRANSIENT_CODES or status >= 500 or status == 429
    return type(e).__name__ in _TRANSIENT_NAMES


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
            delay = min(cap, base * 2 ** (attempt - 1)) * (0.5 + random.random() / 2)  # noqa: S311
            log("warn", "retry", what=what, attempt=attempt, error=type(e).__name__, detail=str(e)[:300])
            await asyncio.sleep(delay)
    raise AssertionError("unreachable")
