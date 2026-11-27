"""The owner's Settings (docs/CONTRACTS.md §5): defaults, validation and storage."""

from __future__ import annotations

import copy
import math
import re
from collections.abc import Mapping
from typing import Any

from . import autopost, db, mojibake, post_preset, validate
from .clock import iso, utcnow
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
    # §21 Earnings, retired by §25 (ADR-47): the owner's old USD per 1,000 views and "Do I get paid here?". Kept,
    # validated and stored exactly as before so no saved value is lost, but nothing reads them any more.
    "earningsRates": {},
    "earningsPaid": {},
    # §17.13: platforms the owner chose to skip (and confirmed) on the floating setup to-do list. Skipping only
    # takes the row off that list; posting is still decided by `platforms` and the connected accounts alone, so a
    # skipped platform that is not connected is never tried (its post waits as `pending_integration`, §17.6).
    "setupSkipped": [],
    # §22: what sits behind the glass. The picture itself never leaves the device; only the choices are stored.
    "backgroundColours": ["#0f372b", "#efe7da", "#e8392b"],  # the Clip Factory colours: bottle green, bone, vermilion
    "glassStrength": "clear",
    # ADR-42: the AI model that makes the clips, a key of clipModels in config/models.json. The default is agentModel,
    # so nothing changes until the owner picks one. A stored key no longer in the list falls back to the default.
    "clipModel": "fable-5-1",
    # §24 Follow creators. Making clips by itself arrives with the next part of the feature; these are stored now so
    # the owner's choices are already in place. followDailyMax 0 means "no limit" (the owner's default, 2026-11-18);
    # the UI never shows 0: it is the "Limit how many a day" switch turned off.
    "followPaused": False,
    "followDailyMax": 0,
    "followMinMinutes": 30,
    # §32: which notifications the owner's devices get. Step updates are off by default: on an iPhone every push must
    # show, so only the owner can ask for one each step. "Picked up again" is off too: the job flow resumes a stalled job by
    # itself (up to 6 times a run) and the owner has nothing to do.
    # §38.11: "Content Rewards news" (you're in, send-now reminders, approvals, proof and money) is on by default.
    # §40.7: "Money on hold or sent to your bank" (getPaid) is on by default too.
    "notify": {
        "ready": True,
        "stopped": True,
        "resumed": False,
        "steps": False,
        "contentRewards": True,
        "getPaid": True,
    },
    # §36 My settings: the owner's own post choices per platform (Everyone, comments, duets and stitches on, Reels in
    # the feed, everyone can reply; never made for kids). Additive: an owner who never saved one reads these defaults.
    "postPreset": post_preset.defaults(),
    # §46.3 Auto-posting: off for every owner until he turns it on (then the oldest clips in Review go up by
    # themselves every everyHours, perRun at a time). ``onAt`` (read-only) is written by the server when it goes on.
    "autoPost": autopost.defaults(),
    # §47 Your Mac posts it on TikTok: off for every owner until he turns it on (then Upload and auto-posting hand
    # TikTok to his Mac instead of TikTok's API, which keeps unaudited apps' posts private).
    "tiktokMac": {"on": False},
    # Your take (owner request, 2026-11-27): every clip gets one short comment that is the channel's own, drawn on
    # the clip (takeOn) and read out by a voice (takeVoice). takeStyle is the owner's few words on how they talk; the
    # agent hands it to the model. Additive: an owner who never saved one reads these defaults.
    "takeOn": True,
    "takeVoice": True,
    "takeStyle": "",
}
TAKE_STYLE_MAX = 120
TIKTOK_MAC_UNKNOWN = "tiktokMac has a setting Clip Factory does not know."
NOTIFY_KEYS = ("ready", "stopped", "resumed", "steps", "contentRewards", "getPaid")
# The Clip Factory colours before the bottle-green look (ADR-43). An owner who never changed them has exactly this
# trio stored; it reads back as today's default so the backdrop follows the new look. Read time only: no migration
# job; the mapped value is written only when the owner next saves settings, as every default is. Any other choice (a
# reordering or a subset too) is kept as it is.
OLD_DEFAULT_COLOURS = ("#9caf88", "#f7f5ef", "#e8412c")
# The retired §21 limit for `earningsRates` (still validated on write; config/earnings.json is gone, §25).
MAX_USD_PER_1000 = 100
# Mirrors config/models.json `clipModels` and `agentModel` (a test keeps them equal; the API Lambdas do not ship it).
CLIP_MODELS: tuple[str, ...] = ("fable-5-2", "fable-5-1", "opus-5-5", "sonnet-5-5", "haiku-5-5")
YOUTUBE_PRIVACY = ("public", "unlisted", "private")
# §24: "Limit how many a day" offers 1 to 20 (0, stored, is "no limit"); the shortest video is 10 to 240 minutes.
FOLLOW_DAILY_MAX = 20
FOLLOW_MIN_MINUTES = (10, 240)
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
    out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in DEFAULTS.items()}
    for field in EDITABLE:
        if stored and field in stored:
            try:
                out[field] = _check_field(field, stored[field])
            except Exception:  # noqa: S112 - a bad stored value must never break the app
                continue
    if tuple(out["backgroundColours"]) == OLD_DEFAULT_COLOURS:
        out["backgroundColours"] = list(DEFAULTS["backgroundColours"])
    out["clipMax"] = max(out["clipMax"], out["clipMin"])
    return out


def _check_field(field: str, value: Any) -> Any:
    match field:
        case "clipMin" | "clipMax":
            return validate.integer(value, field, lo=1, hi=10)
        case "maxSourceHours":
            return validate.integer(value, field, lo=1, hi=12)
        case "followDailyMax":
            return _follow_number(value, lo=0, hi=FOLLOW_DAILY_MAX, what="How many a day", unit="")
        case "followMinMinutes":
            return _follow_number(
                value, lo=FOLLOW_MIN_MINUTES[0], hi=FOLLOW_MIN_MINUTES[1], what="The shortest video", unit=" minutes"
            )
        case "soundEnabled" | "reduceMotion" | "followPaused" | "takeOn" | "takeVoice":
            return validate.boolean(value, field)
        case "takeStyle":
            return _take_style(value)
        case "postPreset":
            return post_preset.check(value)
        case "autoPost":
            return autopost.stored(value)
        case "tiktokMac":
            return _tiktok_mac(None, value)
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
        case "notify":
            return _notify(value)
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


def _take_style(value: Any) -> str:
    """``takeStyle``: one line of at most ``TAKE_STYLE_MAX`` characters. A line saved garbled from a Mac clipboard is
    put right (mojibake.py), characters that cannot be seen are dropped and every run of spaces becomes one."""
    if not isinstance(value, str):
        raise bad_request("How you talk must be a few words.")
    text = "".join(ch if ch.isprintable() or ch.isspace() else " " for ch in mojibake.repair(value))
    text = " ".join(text.split())
    if len(text) > TAKE_STYLE_MAX:
        raise bad_request(f"How you talk is too long. Use at most {TAKE_STYLE_MAX} letters.")
    return text


def _tiktok_mac(current: Any, value: Any) -> dict[str, bool]:
    """``tiktokMac`` (§47): ``{on}`` merged over the stored value; any other key → 400."""
    if not isinstance(value, dict) or set(value) - {"on"}:
        raise bad_request(TIKTOK_MAC_UNKNOWN)
    out = {"on": bool(isinstance(current, Mapping) and current.get("on") is True)}
    if "on" in value:
        out["on"] = validate.boolean(value["on"], "on")
    return out


def _follow_number(value: Any, *, lo: int, hi: int, what: str, unit: str) -> int:
    number = validate.whole_number(value)
    if number is None or not lo <= number <= hi:
        raise bad_request(f"{what} must be a number from {max(lo, 1)} to {hi}{unit}.")
    return number


def _colours(value: Any) -> list[str]:
    """1 to 3 distinct ``#rrggbb`` colours, stored lower case."""
    if not isinstance(value, list) or not all(isinstance(c, str) and HEX_COLOUR.match(c) for c in value):
        raise bad_request("Colours must be like #0f372b.")
    out: list[str] = []
    for c in value:
        if c.lower() not in out:
            out.append(c.lower())
    if not 1 <= len(out) <= MAX_COLOURS:
        raise bad_request(f"Pick 1 to {MAX_COLOURS} colours.")
    return out


def _notify(value: Any) -> dict[str, bool]:
    """``{ready, stopped, steps}`` booleans; a missing one keeps its default."""
    if not isinstance(value, dict) or any(k not in NOTIFY_KEYS for k in value):
        raise bad_request(
            "Notifications must say on or off for: clips ready, stopped, picked up, every step, Content Rewards news, "
            "money on hold or sent."
        )
    return {k: validate.boolean(value.get(k, DEFAULTS["notify"][k]), k) for k in NOTIFY_KEYS}


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


def merge_update(current: Mapping[str, Any], patch: Mapping[str, Any], *, now: str | None = None) -> dict[str, Any]:
    """Validates a ``Partial<Settings>`` and returns the full new settings (without ``hasYoutubeCookies``).
    ``autoPost`` is merged over the stored value; ``now`` is its ``onAt`` when it goes from off to on (§46.3)."""
    patch = validate.obj(patch, "Settings")
    validate.only_keys(patch, EDITABLE | READ_ONLY)
    out = {k: current[k] for k in EDITABLE if k in current}
    for field, value in patch.items():
        if field in READ_ONLY:
            continue  # clients may echo the whole object back; read-only fields are ignored, not rejected
        if field == "autoPost":
            out[field] = autopost.merge(current.get("autoPost"), value, now or iso(utcnow()))
            continue
        if field == "tiktokMac":
            out[field] = _tiktok_mac(current.get("tiktokMac"), value)  # merged like autoPost (§47)
            continue
        out[field] = _check_field(field, value)
    if out["clipMax"] < out["clipMin"]:
        raise bad_request("The most clips must be at least the fewest clips.")
    return out


def load(store: db.Store, user_id: str) -> dict[str, Any]:
    return with_defaults(store.get(db.user_pk(user_id), db.SETTINGS_SK))


def register_autopost(store: db.Store, user_id: str, patch: Mapping[str, Any], now: str) -> None:
    """§46.3: a ``PUT`` that carries ``autoPost`` also puts the owner on the hourly tick's list (``AUTOPOSTOWNERS``)."""
    if isinstance(patch, Mapping) and "autoPost" in patch:
        autopost.register_owner(store, user_id, now)


def _item(user_id: str, values: Mapping[str, Any], now: str) -> dict[str, Any]:
    item = {"pk": db.user_pk(user_id), "sk": db.SETTINGS_SK, "type": "settings", "userId": user_id, "updatedAt": now}
    item.update({k: values[k] for k in EDITABLE if k in values})
    return item


def save(store: db.Store, user_id: str, values: Mapping[str, Any], now: str) -> None:
    store.put(_item(user_id, values, now))


def save_if_unchanged(
    store: db.Store, user_id: str, values: Mapping[str, Any], now: str, before: Mapping[str, Any] | None
) -> None:
    """Saves ``values`` only while the stored item is still ``before`` (the raw item they were merged from): its
    ``updatedAt`` is unchanged, or it had none and still has none. Raises ``db.ConditionFailed`` when another save
    landed in between, so a save that began before the owner turned auto-posting off can never turn it back on."""
    old = (before or {}).get("updatedAt")
    if isinstance(old, str) and old:
        condition, values_ = "attribute_not_exists(pk) OR #u = :old", {":old": old}
    else:
        condition, values_ = "attribute_not_exists(#u)", None
    store.put_when(_item(user_id, values, now), condition, names={"#u": "updatedAt"}, values=values_)
