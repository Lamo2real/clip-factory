"""The owner's Settings (docs/CONTRACTS.md §5): defaults, validation and storage."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import db, validate
from .errors import bad_request

PLATFORMS: tuple[str, ...] = ("youtube", "instagram", "facebook", "tiktok", "x")

# The sound picker (docs/CONTRACTS.md §15.3) offers 30 numbered click sounds and 30 numbered error sounds.
SOUND_COUNT = 30
SOUND_LABELS: dict[str, str] = {"clickSound": "click sound", "errorSound": "error sound"}

DEFAULTS: dict[str, Any] = {
    "clipMin": 5,
    "clipMax": 10,
    "maxSourceHours": 6,
    "soundEnabled": True,
    "reduceMotion": False,
    "clickSound": 6,  # the owner's pick: "Water drop"
    "errorSound": 5,  # the owner's pick: "Nope nope nope"
    "platforms": list(PLATFORMS),
}
EDITABLE = frozenset(DEFAULTS)
READ_ONLY = frozenset({"hasYoutubeCookies"})


def with_defaults(stored: Mapping[str, Any] | None) -> dict[str, Any]:
    """Stored values over defaults; anything unknown or malformed in storage falls back to the default."""
    out = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULTS.items()}
    for field in EDITABLE:
        if stored and field in stored:
            try:
                out[field] = _check_field(field, stored[field])
            except Exception:  # noqa: S112 - a bad stored value must never break the app
                continue
    out["clipMax"] = max(out["clipMax"], out["clipMin"])
    return out


def _check_field(field: str, value: Any) -> Any:
    match field:
        case "clipMin" | "clipMax":
            return validate.integer(value, field, lo=1, hi=10)
        case "maxSourceHours":
            return validate.integer(value, field, lo=1, hi=12)
        case "soundEnabled" | "reduceMotion":
            return validate.boolean(value, field)
        case "clickSound" | "errorSound":
            return _sound_number(value, SOUND_LABELS[field])
        case "platforms":
            if not isinstance(value, list) or not all(isinstance(p, str) for p in value):
                raise bad_request("platforms must be a list of platform names.")
            unknown = [p for p in value if p not in PLATFORMS]
            if unknown:
                raise bad_request(f"Unknown platform: {unknown[0]}.")
            # Keep the canonical order and drop repeats so the UI shows a stable list.
            return [p for p in PLATFORMS if p in value]
    raise bad_request(f"Unknown setting: {field}.")


def _sound_number(value: Any, label: str) -> int:
    number = validate.whole_number(value)
    if number is None:
        raise bad_request(f"Pick a {label} by its number, from 1 to {SOUND_COUNT}.")
    if not 1 <= number <= SOUND_COUNT:
        raise bad_request(f"There is no {label} number {number}. Pick one from 1 to {SOUND_COUNT}.")
    return number


def merge_update(current: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """Validates a ``Partial<Settings>`` and returns the full new settings (without ``hasYoutubeCookies``)."""
    patch = validate.obj(patch, "Settings")
    validate.only_keys(patch, EDITABLE | READ_ONLY)
    out = {k: current[k] for k in EDITABLE}
    for field, value in patch.items():
        if field in READ_ONLY:
            continue  # clients may echo the whole object back; read-only fields are ignored, not rejected
        out[field] = _check_field(field, value)
    if out["clipMax"] < out["clipMin"]:
        raise bad_request("The most clips must be at least the fewest clips.")
    return out


def load(store: db.Store, user_id: str) -> dict[str, Any]:
    return with_defaults(store.get(db.user_pk(user_id), db.SETTINGS_SK))


def save(store: db.Store, user_id: str, values: Mapping[str, Any], now: str) -> None:
    item = {"pk": db.user_pk(user_id), "sk": db.SETTINGS_SK, "type": "settings", "userId": user_id, "updatedAt": now}
    item.update({k: values[k] for k in EDITABLE})
    store.put(item)
