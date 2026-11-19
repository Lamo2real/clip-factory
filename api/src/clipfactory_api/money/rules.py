"""``config/monetization.json``: each platform's paid-programme goals, with the official page every number comes from
(docs/CONTRACTS.md §25.2).

Validated on load, so a bad edit fails the tests and the build, never a run: every goal needs an official ``source``
(a platform's own help host) and ``verifiedHow`` (``official-page`` or ``official-snippet``); third-party numbers
are not allowed. Rules are picked by date (``effectiveFrom``), by whether the channel is already in the programme
(``for``) and by the owner's country (``countries``: ``"*"`` or a list of codes).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import MONEY_ORDER

_PARENTS = Path(__file__).resolve().parents
REPO_FILE = (_PARENTS[4] if len(_PARENTS) > 4 else Path("/nonexistent")) / "config" / "monetization.json"
# The platforms' own help and creator sites. Anything else (a blog, a news site) is refused.
OFFICIAL_HOSTS = frozenset(
    {
        "support.google.com",
        "support.tiktok.com",
        "www.tiktok.com",
        "creators.instagram.com",
        "help.instagram.com",
        "www.facebook.com",
        "help.x.com",
    }
)
VERIFIED_HOW = frozenset({"official-page", "official-snippet"})
GOAL_KINDS = frozenset({"bar", "tick", "number"})
METRICS = frozenset(
    {
        "subscribers",
        "watchHours365",
        "shortsViews90",
        "uploads90",
        "followers",
        "views30",
        "premium",
        "verifiedFollowers",
        "impressions90",
    }
)


class RulesError(ValueError):
    """``monetization.json`` is missing a value or holds one without an official source."""


@dataclass(frozen=True)
class Rule:
    id: str
    for_: str  # "not_in_program" | "in_program"
    effective_from: date
    countries: tuple[str, ...] | None  # None: every country
    goals: tuple[dict[str, Any], ...]
    more: tuple[dict[str, Any], ...]
    upcoming: str | None


@dataclass(frozen=True)
class PlatformRules:
    name: str
    programme: str
    status_where: dict[str, str]
    paid_where: dict[str, str]
    money_label: str | None
    money_note: str | None
    money_verified: bool
    warning: str | None
    invites: str | None
    rules: tuple[Rule, ...]


@dataclass(frozen=True)
class Monetization:
    as_of: date
    countries: tuple[dict[str, str], ...]
    platforms: dict[str, PlatformRules]

    def platform(self, name: str) -> PlatformRules:
        return self.platforms[name]

    def country_codes(self) -> set[str]:
        return {c["code"] for c in self.countries}


def _where(raw: Any, path: str) -> dict[str, str]:
    if not isinstance(raw, dict) or not isinstance(raw.get("label"), str) or not raw["label"]:
        raise RulesError(f"{path} needs a label")
    out = {"label": str(raw["label"])}
    url = raw.get("url")
    if url is not None:
        if not isinstance(url, str) or not url.startswith("https://"):
            raise RulesError(f"{path}.url must be an https link")
        out["url"] = url
    return out


def _goal(raw: Any, path: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise RulesError(f"{path} must be an object")
    for name in ("key", "metric", "label", "source", "verifiedHow"):
        if not isinstance(raw.get(name), str) or not raw[name]:
            raise RulesError(f"{path}.{name} is missing")
    if raw["metric"] not in METRICS:
        raise RulesError(f"{path}.metric {raw['metric']} is not one Clip Factory reads")
    source = urlsplit(raw["source"])
    if source.scheme != "https" or source.hostname not in OFFICIAL_HOSTS:
        raise RulesError(f"{path}.source must be the platform's own page (https on {sorted(OFFICIAL_HOSTS)})")
    if raw["verifiedHow"] not in VERIFIED_HOW:
        raise RulesError(f"{path}.verifiedHow must be official-page or official-snippet")
    kind = raw.get("kind", "bar")
    if kind not in GOAL_KINDS:
        raise RulesError(f"{path}.kind must be bar, tick or number")
    goal = raw.get("goal")
    if kind != "number" and (isinstance(goal, bool) or not isinstance(goal, int) or goal < 1):
        raise RulesError(f"{path}.goal must be a whole number of at least 1")
    return {**raw, "kind": kind}


def _rule(raw: Any, path: str) -> Rule:
    if not isinstance(raw, dict):
        raise RulesError(f"{path} must be an object")
    if raw.get("for") not in {"not_in_program", "in_program"}:
        raise RulesError(f"{path}.for must be not_in_program or in_program")
    try:
        start = date.fromisoformat(str(raw.get("effectiveFrom")))
    except ValueError as e:
        raise RulesError(f"{path}.effectiveFrom must be a date") from e
    countries = raw.get("countries")
    if countries == "*":
        codes = None
    elif isinstance(countries, list) and countries and all(isinstance(c, str) and c for c in countries):
        codes = tuple(countries)
    else:
        raise RulesError(f'{path}.countries must be "*" or a list of country codes')
    goals = raw.get("goals")
    if not isinstance(goals, list) or not goals:
        raise RulesError(f"{path}.goals must list at least one goal")
    keys = [g.get("key") for g in goals if isinstance(g, dict)]
    more = raw.get("more", [])
    if not isinstance(more, list):
        raise RulesError(f"{path}.more must be a list")
    parsed = tuple(_goal(g, f"{path}.goals[{i}]") for i, g in enumerate(goals))
    parsed_more = tuple(_goal(g, f"{path}.more[{i}]") for i, g in enumerate(more))
    all_keys = keys + [g["key"] for g in parsed_more]
    if len(set(all_keys)) != len(all_keys):
        raise RulesError(f"{path}: every goal key must be different")
    for g in (*parsed, *parsed_more):
        if g.get("or") and g["or"] not in all_keys:
            raise RulesError(f"{path}: {g['key']}.or names an unknown goal")
    upcoming = raw.get("upcoming")
    return Rule(
        id=str(raw.get("id") or ""),
        for_=str(raw["for"]),
        effective_from=start,
        countries=codes,
        goals=parsed,
        more=parsed_more,
        upcoming=upcoming if isinstance(upcoming, str) and upcoming else None,
    )


def parse(raw: Any) -> Monetization:
    if not isinstance(raw, dict):
        raise RulesError("monetization.json must hold one object")
    try:
        as_of = date.fromisoformat(str(raw.get("asOf")))
    except ValueError as e:
        raise RulesError("asOf must be a date") from e
    countries = raw.get("countries")
    if not isinstance(countries, list) or not countries:
        raise RulesError("countries must be a list")
    parsed_countries = []
    for i, c in enumerate(countries):
        if not isinstance(c, dict) or not isinstance(c.get("code"), str) or not isinstance(c.get("name"), str):
            raise RulesError(f"countries[{i}] needs a code and a name")
        parsed_countries.append({"code": c["code"], "name": c["name"]})
    entries = raw.get("platforms")
    if not isinstance(entries, dict) or set(entries) != set(MONEY_ORDER):
        raise RulesError(f"platforms must list exactly {list(MONEY_ORDER)}")
    platforms: dict[str, PlatformRules] = {}
    for name in MONEY_ORDER:
        entry = entries[name]
        path = f"platforms.{name}"
        if not isinstance(entry, dict) or not isinstance(entry.get("programme"), str):
            raise RulesError(f"{path} needs a programme name")
        rules = entry.get("rules")
        if not isinstance(rules, list):
            raise RulesError(f"{path}.rules must be a list")
        platforms[name] = PlatformRules(
            name=name,
            programme=entry["programme"],
            status_where=_where(entry.get("statusWhere"), f"{path}.statusWhere"),
            paid_where=_where(entry.get("paidWhere"), f"{path}.paidWhere"),
            money_label=entry.get("moneyLabel") if isinstance(entry.get("moneyLabel"), str) else None,
            money_note=entry.get("moneyNote") if isinstance(entry.get("moneyNote"), str) else None,
            money_verified=entry.get("moneyVerified") is True,
            warning=entry.get("warning") if isinstance(entry.get("warning"), str) else None,
            invites=entry.get("invites") if isinstance(entry.get("invites"), str) else None,
            rules=tuple(_rule(r, f"{path}.rules[{i}]") for i, r in enumerate(rules)),
        )
    return Monetization(as_of=as_of, countries=tuple(parsed_countries), platforms=platforms)


def _read_text() -> str:
    packaged = resources.files("clipfactory_api").joinpath("config", "monetization.json")
    if packaged.is_file():
        return packaged.read_text(encoding="utf-8")
    if REPO_FILE.is_file():
        return REPO_FILE.read_text(encoding="utf-8")
    raise RulesError("config/monetization.json was not found")


def load(path: Path | None = None) -> Monetization:
    if path is not None:
        return parse(json.loads(path.read_text(encoding="utf-8")))
    return _load_cached()


@cache
def _load_cached() -> Monetization:
    return parse(json.loads(_read_text()))


# --- picking a rule and measuring progress ------------------------------------------------------------------------


def pick(cfg: Monetization, platform: str, *, today: date, in_program: bool, country: str | None) -> Rule | str | None:
    """The rule in force, ``None`` when the platform has none for this case, or ``"no_country"`` /
    ``"not_open"`` when the answer depends on the owner's country."""
    wanted = "in_program" if in_program else "not_in_program"
    found = [r for r in cfg.platform(platform).rules if r.for_ == wanted and r.effective_from <= today]
    if not found:
        return None
    if all(r.countries is not None for r in found):
        if not country:
            return "no_country"
        found = [r for r in found if r.countries is not None and country in r.countries]
        if not found:
            return "not_open"
    else:
        found = [r for r in found if r.countries is None or (country and country in r.countries)]
    return max(found, key=lambda r: r.effective_from)


def _measure(goal: dict[str, Any], numbers: dict[str, Any]) -> dict[str, Any]:
    metric = goal["metric"]
    kind = goal["kind"]
    raw = numbers.get(metric)
    current: Any = None
    if kind == "tick":
        current = 1 if raw is True else 0 if raw is False else None
    elif isinstance(raw, int | float) and not isinstance(raw, bool):
        current = int(raw)
    out: dict[str, Any] = {
        "key": goal["key"],
        "label": goal["label"],
        "kind": kind,
        "current": current,
        "goal": goal.get("goal") if kind != "number" else None,
        "approx": bool(goal.get("approx")),
        "sourceUrl": goal["source"],
    }
    for name in ("windowDays", "note", "help", "or"):
        if goal.get(name) is not None:
            out[name] = goal[name]
    out["reached"] = bool(kind != "number" and current is not None and current >= int(goal["goal"]))
    missing = (numbers.get("missing") or {}).get(metric)
    if isinstance(missing, str) and missing:
        out["missing"] = missing
        out["current"] = None
        out["reached"] = False
    counting = (numbers.get("counting") or {}).get(metric)
    if isinstance(counting, int) and counting > 0:
        out["countingDaysLeft"] = counting
        out["current"] = None
        out["reached"] = False
    return out


def progress(rule: Rule, numbers: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """``(goals, more)``: each goal measured against ``numbers`` (what was last read about the account)."""
    return [_measure(g, numbers) for g in rule.goals], [_measure(g, numbers) for g in rule.more]


def all_reached(goals: list[dict[str, Any]]) -> bool:
    """Every goal is reached, where goals joined by ``or`` need only one of them. A number (no bar) never counts."""
    by_key = {g["key"]: g for g in goals}
    measured = [g for g in goals if g["kind"] != "number"]
    if not measured:
        return False
    for g in measured:
        if g["reached"]:
            continue
        partner = by_key.get(str(g.get("or") or ""))
        if partner is not None and partner["reached"]:
            continue
        return False
    return True


def today_of(now: datetime) -> date:
    return now.date()
