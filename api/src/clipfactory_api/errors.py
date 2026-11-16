"""The API's one error type. Its message is shown to the owner, so it is always a plain sentence."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field = field  # the form field the message belongs under, when there is one (§18.2)


def bad_request(message: str, field: str | None = None) -> ApiError:
    return ApiError(400, "bad_request", message, field)


def not_found(message: str = "We could not find that.") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(message: str, field: str | None = None) -> ApiError:
    return ApiError(409, "conflict", message, field)


def too_large(message: str) -> ApiError:
    return ApiError(413, "too_large", message)
