"""Small checks for request bodies. Each failure is a ``bad_request`` with a sentence the owner can act on."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .errors import bad_request


def obj(value: Any, what: str = "The request") -> dict[str, Any]:
    if not isinstance(value, dict):
        raise bad_request(f"{what} must be a JSON object.")
    return value


def only_keys(body: Mapping[str, Any], allowed: Iterable[str]) -> None:
    unknown = sorted(set(body) - set(allowed))
    if unknown:
        raise bad_request(f"Unknown field: {unknown[0]}.")


def string(
    body: Mapping[str, Any], field: str, *, required: bool = True, max_len: int = 1000, min_len: int = 1
) -> str | None:
    value = body.get(field)
    if value is None:
        if required:
            raise bad_request(f"{field} is required.")
        return None
    if not isinstance(value, str):
        raise bad_request(f"{field} must be text.")
    value = value.strip()
    if len(value) < min_len:
        if required:
            raise bad_request(f"{field} is required.")
        return None
    if len(value) > max_len:
        raise bad_request(f"{field} is too long (at most {max_len} characters).")
    return value


def required_string(body: Mapping[str, Any], field: str, *, max_len: int = 1000) -> str:
    value = string(body, field, required=True, max_len=max_len)
    if value is None:  # unreachable: required=True raises instead; narrows the type
        raise bad_request(f"{field} is required.")
    return value


def integer(value: Any, field: str, *, lo: int, hi: int) -> int:
    # bool is an int in Python; "true" is never a valid count.
    if isinstance(value, bool) or not isinstance(value, int | float) or int(value) != value:
        raise bad_request(f"{field} must be a whole number.")
    number = int(value)
    if not lo <= number <= hi:
        raise bad_request(f"{field} must be between {lo} and {hi}.")
    return number


def boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise bad_request(f"{field} must be true or false.")
    return value


def query_int(params: Mapping[str, str], field: str, *, default: int, lo: int, hi: int) -> int:
    raw = params.get(field)
    if raw is None or raw == "":
        return default
    try:
        number = int(raw)
    except ValueError as e:
        raise bad_request(f"{field} must be a whole number.") from e
    if not lo <= number <= hi:
        raise bad_request(f"{field} must be between {lo} and {hi}.")
    return number
