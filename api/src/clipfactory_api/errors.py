"""The API's one error type. Its message is shown to the owner, so it is always a plain sentence."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad_request(message: str) -> ApiError:
    return ApiError(400, "bad_request", message)


def not_found(message: str = "We could not find that.") -> ApiError:
    return ApiError(404, "not_found", message)


def conflict(message: str) -> ApiError:
    return ApiError(409, "conflict", message)


def too_large(message: str) -> ApiError:
    return ApiError(413, "too_large", message)
