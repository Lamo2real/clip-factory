"""The API's one error type. Its message is shown to the owner, so it is always a plain sentence."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class ApiError(Exception):
    """``field`` names the form field the message belongs under (§18.2); ``extra`` adds fields to the error
    object (``retryAfter``, §19.6); ``headers`` adds response headers."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field: str | None = None,
        *,
        extra: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field  # the form field the message belongs under, when there is one (§18.2)
        self.extra = dict(extra or {})
        self.headers = dict(headers or {})


def bad_request(message: str, field: str | None = None) -> ApiError:
    return ApiError(400, "bad_request", message, field)


def not_found(message: str = "We could not find that.") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(message: str, field: str | None = None) -> ApiError:
    return ApiError(409, "conflict", message, field)


def too_large(message: str) -> ApiError:
    return ApiError(413, "too_large", message)
