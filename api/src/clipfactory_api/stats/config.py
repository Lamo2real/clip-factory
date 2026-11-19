"""``config/platforms.json``: how often each platform may be read and how much (docs/CONTRACTS.md §16.4).

The build copies the repository file into the zip as ``clipfactory_api/config/platforms.json``; ``load()`` reads
that package copy and, when running from a checkout (tests, local runs), the repository file. The values are
validated on load so a bad edit fails the tests and the build, never a poll.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

from . import STATS_ORDER

_PARENTS = Path(__file__).resolve().parents
# api/src/clipfactory_api/stats/config.py → the repository root (absent when running from the Lambda zip).
REPO_FILE = (_PARENTS[4] if len(_PARENTS) > 4 else Path("/nonexistent")) / "config" / "platforms.json"
BUDGET_KINDS = {
    "youtube": "daily_units",
    "tiktok": "per_minute",
    "instagram": "meta_buc",
    "facebook": "meta_buc",
    "x": "x",
}
BUDGET_FIELDS = {
    "daily_units": ("dailyUnits", "reserveUnits", "unitsPerCall"),
    "per_minute": ("requestsPerMinute", "useAtMost"),
    "meta_buc": ("stopAtPercent", "throttleCodes", "minBlockMinutes"),
    "x": ("appRequestsPer15Min", "userRequestsPer15Min", "useAtMost", "usdPerPostRead", "monthlyUsd"),
}


# §17.7: the publish settings each platform gets in platforms.json. Used when the file has no "publish" block yet;
# a block that is present must hold these keys with values of the same kind.
PUBLISH_DEFAULTS: dict[str, dict[str, Any]] = {
    "youtube": {"checkSeconds": 30, "maxChecks": 60, "chunkMb": 8},
    "tiktok": {"checkSeconds": 15, "maxChecks": 80, "source": "FILE_UPLOAD", "idCheckMinutes": 10, "idMaxChecks": 12},
    "instagram": {"checkSeconds": 60, "maxChecks": 15, "source": "resumable"},
    "facebook": {"checkSeconds": 30, "maxChecks": 40, "source": "binary"},
    "x": {"maxChecks": 20, "chunkMb": 4},
}
PUBLISH_SOURCES = {
    "tiktok": {"FILE_UPLOAD"},
    "instagram": {"resumable", "video_url"},
    "facebook": {"binary", "file_url"},
}


class ConfigError(ValueError):
    """``platforms.json`` is missing a value or holds one that would break the limits."""


@dataclass(frozen=True)
class PlatformConfig:
    name: str
    label: str
    min_interval: int  # minutes
    tier_intervals: tuple[int, ...]  # minutes, one per age tier
    manual_cooldown: int  # minutes
    ids_per_request: int
    budget: dict[str, Any]
    insights_interval: int | None = None  # minutes (YouTube Analytics only)
    non_public_max_age_days: int | None = None  # X only
    scopes: tuple[str, ...] = ()
    # §25.4: asked for only by "Allow money reading" (grant=money), never by a normal Connect.
    money_scopes: tuple[str, ...] = ()
    publish: dict[str, Any] | None = None  # §17.7

    @property
    def publish_settings(self) -> dict[str, Any]:
        return dict(self.publish or PUBLISH_DEFAULTS[self.name])

    @property
    def budget_kind(self) -> str:
        return str(self.budget["kind"])


@dataclass(frozen=True)
class PlatformsConfig:
    graph_api_version: str
    poll_window_days: int
    snapshot_ttl_days: int
    snapshot_every_minutes: int
    age_tier_hours: tuple[int, ...]
    order: tuple[str, ...]
    platforms: dict[str, PlatformConfig]
    raw: dict[str, Any]

    def platform(self, name: str) -> PlatformConfig:
        return self.platforms[name]

    @property
    def tick_minutes(self) -> int:
        """The EventBridge rate Terraform derives: the smallest ``minIntervalMinutes``."""
        return min(p.min_interval for p in self.platforms.values())


def _int(value: Any, where: str, *, lo: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < lo:
        raise ConfigError(f"{where} must be a whole number of at least {lo}")
    return value


def _money_scopes(raw: Any, scopes: list[str], where: str) -> tuple[str, ...]:
    """§25.4: the extra scopes "Allow money reading" asks for; never one Connect already asks for."""
    if not isinstance(raw, list) or not all(isinstance(s, str) and s for s in raw):
        raise ConfigError(f"{where}.moneyScopes must be a list of scope names")
    if set(raw) & set(scopes):
        raise ConfigError(f"{where}.moneyScopes must not repeat a Connect scope")
    return tuple(raw)


def parse(raw: Any) -> PlatformsConfig:
    if not isinstance(raw, dict):
        raise ConfigError("platforms.json must hold one object")
    version = raw.get("graphApiVersion")
    if not isinstance(version, str) or not version.startswith("v"):
        raise ConfigError("graphApiVersion must look like v25.0")
    tiers = raw.get("ageTierHours")
    if not isinstance(tiers, list) or not tiers:
        raise ConfigError("ageTierHours must be a list")
    tier_hours = tuple(_int(t, "ageTierHours") for t in tiers)
    if list(tier_hours) != sorted(tier_hours):
        raise ConfigError("ageTierHours must grow")
    order = raw.get("order")
    if order != list(STATS_ORDER):
        raise ConfigError(f"order must be {list(STATS_ORDER)}")
    entries = raw.get("platforms")
    if not isinstance(entries, dict) or set(entries) != set(STATS_ORDER):
        raise ConfigError("platforms must list youtube, tiktok, instagram, facebook and x")
    platforms: dict[str, PlatformConfig] = {}
    for name in STATS_ORDER:
        entry = entries[name]
        where = f"platforms.{name}"
        if not isinstance(entry, dict):
            raise ConfigError(f"{where} must be an object")
        minimum = _int(entry.get("minIntervalMinutes"), f"{where}.minIntervalMinutes")
        intervals = entry.get("tierIntervalsMinutes")
        if not isinstance(intervals, list) or len(intervals) != len(tier_hours):
            raise ConfigError(f"{where}.tierIntervalsMinutes needs one value per age tier")
        tier_values = tuple(_int(v, f"{where}.tierIntervalsMinutes", lo=minimum) for v in intervals)
        budget = entry.get("budget")
        if not isinstance(budget, dict) or budget.get("kind") != BUDGET_KINDS[name]:
            raise ConfigError(f"{where}.budget.kind must be {BUDGET_KINDS[name]}")
        missing = [f for f in BUDGET_FIELDS[budget["kind"]] if f not in budget]
        if missing:
            raise ConfigError(f"{where}.budget is missing {', '.join(missing)}")
        if budget["kind"] == "daily_units":
            _int(budget["unitsPerCall"], f"{where}.budget.unitsPerCall")
        label = entry.get("label")
        if not isinstance(label, str) or not label:
            raise ConfigError(f"{where}.label must be text")
        insights = entry.get("insightsIntervalMinutes")
        non_public = entry.get("nonPublicMaxAgeDays")
        scopes = entry.get("scopes", [])
        if not isinstance(scopes, list) or not all(isinstance(s, str) and s for s in scopes):
            raise ConfigError(f"{where}.scopes must be a list of scope names")
        if name == "x" and "usdPerPost" in budget:
            usd = budget["usdPerPost"]
            if isinstance(usd, bool) or not isinstance(usd, int | float) or not 0 <= usd <= 1:
                raise ConfigError(f"{where}.budget.usdPerPost must be a small dollar amount")
        platforms[name] = PlatformConfig(
            name=name,
            label=label,
            min_interval=minimum,
            tier_intervals=tier_values,
            manual_cooldown=_int(entry.get("manualCooldownMinutes"), f"{where}.manualCooldownMinutes"),
            ids_per_request=_int(entry.get("idsPerRequest"), f"{where}.idsPerRequest"),
            budget=dict(budget),
            insights_interval=_int(insights, f"{where}.insightsIntervalMinutes") if insights is not None else None,
            non_public_max_age_days=_int(non_public, f"{where}.nonPublicMaxAgeDays")
            if non_public is not None
            else None,
            scopes=tuple(scopes),
            money_scopes=_money_scopes(entry.get("moneyScopes", []), scopes, where),
            publish=_publish(name, entry.get("publish"), where),
        )
    return PlatformsConfig(
        graph_api_version=version,
        poll_window_days=_int(raw.get("pollWindowDays"), "pollWindowDays"),
        snapshot_ttl_days=_int(raw.get("snapshotTtlDays"), "snapshotTtlDays"),
        snapshot_every_minutes=_int(raw.get("snapshotEveryMinutes"), "snapshotEveryMinutes"),
        age_tier_hours=tier_hours,
        order=tuple(order),
        platforms=platforms,
        raw=raw,
    )


def _publish(name: str, raw: Any, where: str) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}.publish must be an object")
    expected = PUBLISH_DEFAULTS[name]
    missing = [k for k in expected if k not in raw]
    if missing:
        raise ConfigError(f"{where}.publish is missing {', '.join(missing)}")
    out: dict[str, Any] = {}
    for key, default in expected.items():
        value = raw[key]
        if isinstance(default, int):
            out[key] = _int(value, f"{where}.publish.{key}")
        elif value not in PUBLISH_SOURCES.get(name, {default}):
            raise ConfigError(f"{where}.publish.{key} must be one of {sorted(PUBLISH_SOURCES.get(name, {default}))}")
        else:
            out[key] = value
    return out


def _read_text() -> str:
    packaged = resources.files("clipfactory_api").joinpath("config", "platforms.json")
    if packaged.is_file():
        return packaged.read_text(encoding="utf-8")
    if REPO_FILE.is_file():
        return REPO_FILE.read_text(encoding="utf-8")
    raise ConfigError("config/platforms.json was not found")


def load(path: Path | None = None) -> PlatformsConfig:
    """The validated platforms config (cached per container when read from the package)."""
    if path is not None:
        return parse(json.loads(path.read_text(encoding="utf-8")))
    return _load_cached()


@cache
def _load_cached() -> PlatformsConfig:
    return parse(json.loads(_read_text()))


def interval_for(cfg: PlatformsConfig, platform: str, posted_at: datetime | None, now: datetime) -> int:
    """Minutes until the next automatic poll of a post: the first age tier the post's age fits in (≤ 48 h, ≤ 7 d,
    ≤ 30 d), the last tier beyond that, never below ``minIntervalMinutes``."""
    p = cfg.platform(platform)
    age_hours = (now - posted_at).total_seconds() / 3600 if posted_at else 0.0
    chosen = p.tier_intervals[-1]
    for limit, minutes in zip(cfg.age_tier_hours, p.tier_intervals, strict=True):
        if age_hours <= limit:
            chosen = minutes
            break
    return max(chosen, p.min_interval)


def is_final_age(cfg: PlatformsConfig, posted_at: datetime | None, now: datetime) -> bool:
    """The first read at or after ``pollWindowDays`` is the post's final automatic snapshot."""
    return posted_at is not None and (now - posted_at).total_seconds() >= cfg.poll_window_days * 86400
