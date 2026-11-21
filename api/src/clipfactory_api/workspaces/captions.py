"""A story's six post captions (``Captions``, docs/CONTRACTS.md §45.6): the same shape and limits as Lamo Clips'
(§5, §17.6) so the shared platform publishers take them as they are, kept here so Lamo Stories never depends on
Clip Factory's clip code.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from ..errors import bad_request

LIMITS: Final[dict[str, int]] = {
    "youtubeTitle": 100,
    "youtubeDescription": 5000,
    "instagram": 2200,
    "facebook": 5000,
    "tiktok": 2200,
    "x": 280,
}


def empty() -> dict[str, str]:
    return dict.fromkeys(LIMITS, "")


def merged(current: Mapping[str, Any] | None, patch: Mapping[str, str]) -> dict[str, str]:
    base = {k: str((current or {}).get(k, "")) for k in LIMITS}
    base.update(patch)
    return base


def patch(value: Any) -> dict[str, str]:
    """``Partial<Captions>``, checked. Empty text is allowed: the owner may clear a caption."""
    if not isinstance(value, dict):
        raise bad_request("postCaptions must be an object.")
    out: dict[str, str] = {}
    for field, text in value.items():
        limit = LIMITS.get(field)
        if limit is None:
            raise bad_request(f"Unknown caption: {field}.")
        if not isinstance(text, str):
            raise bad_request(f"The {field} caption must be text.")
        if len(text) > limit:
            raise bad_request(f"The {field} caption is too long (at most {limit} characters).")
        out[field] = text
    return out
