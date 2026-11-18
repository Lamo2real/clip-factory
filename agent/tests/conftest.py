from __future__ import annotations

from typing import Any

import pytest

from clipfactory_agent import watch
from clipfactory_agent.moments import Moment


@pytest.fixture(autouse=True)
def _no_track_pauses(monkeypatch: pytest.MonkeyPatch) -> None:
    """The watchers' growing pauses before trying a busy unit again (5 s, 10 s, ...) are zero in tests; the test
    of the pauses themselves sets them back."""
    monkeypatch.setattr(watch, "RETRY_BASE", 0.0)


def make_moment(**kw: Any) -> Moment:
    base: dict[str, Any] = {
        "start": 100.0,
        "end": 130.0,
        "moment_type": "rage",
        "hook": "he thought he got away with it",
        "first_words": "No way!",
        "payoff_at": 128.0,
        "peak_at": 120.0,
        "why": "Big reaction",
        "score": 7.0,
        "summary": "He loses it",
    }
    base.update(kw)
    return Moment(**base)


def raw_moment(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "start": 100,
        "end": 130,
        "moment_type": "chaos",
        "hook": "the plan was simple until this happened",
        "first_words": "Okay watch this",
        "tease_start": None,
        "tease_end": None,
        "payoff_at": 128,
        "peak_at": 125,
        "why": "Plan goes wrong",
        "needs_context": False,
        "score": 7,
        "people": ["Sam"],
        "summary": "A heist falls apart",
    }
    base.update(kw)
    return base


@pytest.fixture
def moment() -> Moment:
    return make_moment()
