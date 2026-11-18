"""The owner's Settings (docs/CONTRACTS.md §5): defaults, validation and storage."""

from __future__ import annotations

import math
import re
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
    "youtubePrivacy": "public",  # §17.6: who can see the YouTube uploads (YouTube policy wants the owner's choice)
    # §21 Earnings: the owner's own USD per 1,000 views and "Do I get paid here?" per platform. A platform that is
    # absent uses the default from config/earnings.json (typicalUsdPer1000 / paysPerView), which the web reads.
    "earningsRates": {},
    "earningsPaid": {},
    # §17.13: platforms the owner chose to skip (and confirmed) on the floating setup to-do list. Skipping only
    # takes the row off that list; posting is still decided by `platforms` and the connected accounts alone, so a
    # skipped platform that is not connected is never tried (its post waits as `pending_integration`, §17.6).
    "setupSkipped": [],
    # §22: what sits behind the glass. The picture itself never leaves the device; only the choices are stored.
    "backgroundColours": ["#9caf88", "#f7f5ef", "#e8412c"],  # the Clip Factory colours: sage, cream, tomato
    "glassStrength": "clear",
    # ADR-42: the AI model that makes the clips, a key of clipModels in config/models.json. The default is agentModel,
    # so nothing changes until the owner picks one. A stored key no longer in the list falls back to the default.
    "clipModel": "fable-5-1",
}
# Mirrors config/earnings.json `maxUsdPer1000` (a test keeps them equal).
MAX_USD_PER_1000 = 100
# Mirrors config/models.json `clipModels` and `agentModel` (a test keeps them equal; the API Lambdas do not ship it).
CLIP_MODELS: tuple[str, ...] = ("fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5")
YOUTUBE_PRIVACY = ("public", "unlisted", "private")
BACKGROUND_MODES = ("see-through", "picture", "colours")
GLASS_STRENGTHS = ("clear", "frosted")
MAX_COLOURS = 3
HEX_COLOUR = re.compile(r"^#[0-9a-fA-F]{6}$")
# Editable fields with no server default: absent until the owner saves one. backgroundMode (§22.1) is the device's
# call until then, so an owner who already had a picture on a device keeps seeing it after the upgrade.
OPTIONAL = frozenset({"backgroundMode"})
EDITABLE = frozenset(DEFAULTS) | OPTIONAL
READ_ONLY = frozenset({"hasYoutubeCookies"})


def with_defaults(stored: Mapping[str, Any] | None) -> dict[str, Any]:
    """Stored values over defaults; anything unknown or malformed in storage falls back to the default."""
    out: dict[str, Any] = {
        k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()
    }
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
        case "youtubePrivacy":
            if value not in YOUTUBE_PRIVACY:
                raise bad_request(
                    "Pick who can see your YouTube clips: everyone, only people with the link, or only you."
                )
            return value
        case "earningsRates":
            return _earnings_map(value, _usd_per_1000)
        case "earningsPaid":
            return _earnings_map(value, _paid)
        case "setupSkipped":
            if not isinstance(value, list) or not all(isinstance(p, str) for p in value):
                raise bad_request("setupSkipped must be a list of platform names.")
            unknown = [p for p in value if p not in PLATFORMS]
            if unknown:
                raise bad_request(f"Unknown platform: {unknown[0]}.")
            return [p for p in PLATFORMS if p in value]
        case "backgroundMode":
            if value not in BACKGROUND_MODES:
                raise bad_request("Pick what goes behind the glass: See-through, Picture or Colours.")
            return value
        case "glassStrength":
            if value not in GLASS_STRENGTHS:
                raise bad_request("Pick Clear or Frosted glass.")
            return value
        case "backgroundColours":
            return _colours(value)
        case "clipModel":
            if not isinstance(value, str) or value not in CLIP_MODELS:
                raise bad_request("Pick one of the AI models in the list.")
            return value
        case "platforms":
            if not isinstance(value, list) or not all(isinstance(p, str) for p in value):
                raise bad_request("platforms must be a list of platform names.")
            unknown = [p for p in value if p not in PLATFORMS]
            if unknown:
                raise bad_request(f"Unknown platform: {unknown[0]}.")
            # Keep the canonical order and drop repeats so the UI shows a stable list.
            return [p for p in PLATFORMS if p in value]
    raise bad_request(f"Unknown setting: {field}.")


def _colours(value: Any) -> list[str]:
    """1 to 3 distinct ``#rrggbb`` colours, stored lower case."""
    if not isinstance(value, list) or not all(isinstance(c, str) and HEX_COLOUR.match(c) for c in value):
        raise bad_request("Colours must be like #9caf88.")
    out: list[str] = []
    for c in value:
        if c.lower() not in out:
            out.append(c.lower())
    if not 1 <= len(out) <= MAX_COLOURS:
        raise bad_request(f"Pick 1 to {MAX_COLOURS} colours.")
    return out


def _sound_number(value: Any, label: str) -> int:
    number = validate.whole_number(value)
    if number is None:
        raise bad_request(f"Pick a {label} by its number, from 1 to {SOUND_COUNT}.")
    if not 1 <= number <= SOUND_COUNT:
        raise bad_request(f"There is no {label} number {number}. Pick one from 1 to {SOUND_COUNT}.")
    return number


def _earnings_map(value: Any, check: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise bad_request("Money settings must list each app by name.")
    unknown = [p for p in value if p not in PLATFORMS]
    if unknown:
        raise bad_request(f"Unknown platform: {unknown[0]}.")
    return {p: check(value[p], p) for p in PLATFORMS if p in value}


def _usd_per_1000(value: Any, platform: str) -> float | int:
    """A non-negative amount of US dollars for 1,000 views, at most ``MAX_USD_PER_1000``, with at most 2 decimals."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise bad_request(f"Type the {platform} amount as a number, like 0.05.")
    if value < 0:
        raise bad_request(f"The {platform} amount cannot be less than 0.")
    if value > MAX_USD_PER_1000:
        raise bad_request(f"The {platform} amount can be at most {MAX_USD_PER_1000} dollars for 1,000 views.")
    cents = round(value * 100)
    if abs(value * 100 - cents) > 1e-6:
        raise bad_request(f"Use at most 2 numbers after the dot for {platform}, like 0.05.")
    return cents // 100 if cents % 100 == 0 else cents / 100


def _paid(value: Any, platform: str) -> bool:
    if not isinstance(value, bool):
        raise bad_request(f"Say yes or no for {platform}: true or false.")
    return value


def merge_update(current: Mapping[str, Any], patch: Mapping[str, Any]) -> dict[str, Any]:
    """Validates a ``Partial<Settings>`` and returns the full new settings (without ``hasYoutubeCookies``)."""
    patch = validate.obj(patch, "Settings")
    validate.only_keys(patch, EDITABLE | READ_ONLY)
    out = {k: current[k] for k in EDITABLE if k in current}
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
    item.update({k: values[k] for k in EDITABLE if k in values})
    store.put(item)
