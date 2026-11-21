"""robots.txt, RFC 9309 (docs/CONTRACTS.md §41.2 "robots.txt"). Pure.

The group whose ``User-agent`` is ``clipfactory`` (case-insensitive; every such group together), else every ``*``
group; ``Allow`` and ``Disallow`` with ``*`` and ``$``; the longest matching rule wins, ``Allow`` on a tie; an empty
``Disallow`` allows all; percent-encoding is compared decoded. ``/robots.txt`` itself is always allowed.
"""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass, field

from . import config


@dataclass(frozen=True)
class Rule:
    allow: bool
    pattern: str  # decoded
    raw: str  # as written (kept by ``compact``)


@dataclass(frozen=True)
class Robots:
    rules: tuple[Rule, ...] = field(default_factory=tuple)

    def allowed(self, path: str) -> bool:
        """``path`` is the URL's path and query (``/home?x``)."""
        target = _decode(path or "/")
        if target == "/robots.txt":
            return True
        best: Rule | None = None
        for rule in self.rules:
            if not _matches(rule.pattern, target):
                continue
            longer = best is None or len(rule.pattern) > len(best.pattern)
            if longer or (best is not None and len(rule.pattern) == len(best.pattern) and rule.allow):
                best = rule
        return best is None or best.allow


def _decode(text: str) -> str:
    return urllib.parse.unquote(text, errors="replace")


def _matches(pattern: str, path: str) -> bool:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    regex = ".*".join(re.escape(part) for part in body.split("*"))
    return re.match(regex + ("$" if anchored else ""), path, re.DOTALL) is not None


def _lines(text: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        out.append((name.strip().lower(), value.strip()))
    return out


def _agent_matches(value: str, agent: str) -> bool:
    token = value.split("/", 1)[0].strip().lower()
    return token == agent


def _groups(text: str) -> list[tuple[list[str], list[Rule]]]:
    groups: list[tuple[list[str], list[Rule]]] = []
    agents: list[str] = []
    rules: list[Rule] = []
    in_rules = False
    for name, value in _lines(text):
        if name in {"user-agent", "useragent"}:
            if in_rules:
                groups.append((agents, rules))
                agents, rules, in_rules = [], [], False
            agents.append(value)
        elif name in {"allow", "disallow"}:
            if not agents:
                continue  # a rule before any user-agent belongs to no group
            in_rules = True
            if value:
                rules.append(Rule(name == "allow", _decode(value), value))
            # an empty Disallow allows all: no rule
    if agents:
        groups.append((agents, rules))
    return groups


def parse(text: str, agent: str = config.ROBOTS_AGENT) -> Robots:
    groups = _groups(text)
    mine = [rules for agents, rules in groups if any(_agent_matches(a, agent) for a in agents)]
    if not mine:
        mine = [rules for agents, rules in groups if any(a.strip() == "*" for a in agents)]
    return Robots(tuple(rule for rules in mine for rule in rules))


def compact(text: str, agent: str = config.ROBOTS_AGENT) -> str:
    """The lines that apply to Clip Factory (its own groups, else ``*``), to keep (≤ 8 KB) instead of the whole file;
    ``parse(compact(text))`` decides exactly as ``parse(text)``."""
    robots = parse(text, agent)
    lines = ["User-agent: *"]
    lines += [f"{'Allow' if r.allow else 'Disallow'}: {r.raw}" for r in robots.rules]
    return "\n".join(lines) + "\n"


def needed(robots: Robots) -> bool:
    """The sitemap and the campaign pages are allowed (else the finder reads nothing: ``not_allowed``)."""
    return robots.allowed("/sitemap.xml") and robots.allowed(f"{config.PAGE_PATH}00000000-0000-0000-0000-000000000000")
