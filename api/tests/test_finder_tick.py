"""The finder's tick check in ``cf-prod-stats`` and its invoke (docs/CONTRACTS.md §41.5 "The job"): a scheduled look
is invoked only when the finder is switched on, ``CRPUBLIC/STATE`` says one is due and none is running."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.async_invoke import AsyncInvoker
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import finderapi
from clipfactory_api.stats import handler as stats_handler
from conftest import NOW, Clock
from cr_support import CAMPAIGNS_ARN, FakeCR, FakeInvoker, make_deps
from fakes import FakeLambda, FakeSecretsManager, FakeTable


class FinderInvoker(FakeInvoker):
    def find(self, user_id: str | None, why: str) -> None:
        self._record("find", user_id, why)


@pytest.fixture
def deps(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("CR_FINDER", "on")
    return make_deps(db.Store(FakeTable()), FakeSecretsManager(), FakeCR(), Clock(NOW), invoker=FinderInvoker())


def state(deps: Any, **fields: Any) -> None:
    deps.store.put({"pk": "CRPUBLIC", "sk": "STATE", "type": "crpublicstate", **fields})


def finds(deps: Any) -> list[tuple[Any, ...]]:
    return [args for name, args in deps.invoker.calls if name == "find"]


def test_a_look_is_invoked_when_due_and_none_runs(deps: Any) -> None:
    assert finderapi.tick(deps, NOW) is True  # no STATE yet: due
    assert finds(deps) == [(None, "schedule")]
    state(deps, nextRunAt=iso(NOW - timedelta(minutes=1)), runningUntil=iso(NOW - timedelta(seconds=1)))
    assert finderapi.tick(deps, NOW) is True
    assert len(finds(deps)) == 2


@pytest.mark.parametrize(
    "fields",
    [
        {"nextRunAt": iso(NOW + timedelta(hours=5))},
        {"nextRunAt": iso(NOW - timedelta(hours=1)), "runningUntil": iso(NOW + timedelta(seconds=90))},
        {"runningUntil": int((NOW + timedelta(seconds=30)).timestamp())},  # epoch seconds read the same
    ],
)
def test_no_look_while_not_due_or_one_runs(deps: Any, fields: dict[str, Any]) -> None:
    state(deps, **fields)
    assert finderapi.tick(deps, NOW) is False
    assert finds(deps) == []


def test_no_look_while_switched_off(deps: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CR_FINDER", "off")
    assert finderapi.tick(deps, NOW) is False
    monkeypatch.delenv("CR_FINDER")
    assert finderapi.tick(deps, NOW) is False
    assert finds(deps) == []


def test_a_failed_invoke_never_fails_the_tick(deps: Any) -> None:
    deps.invoker.fail = True
    assert finderapi.tick(deps, NOW) is False


def test_the_stats_tick_checks_the_finder_after_the_content_rewards_poll(deps: Any) -> None:
    from clipfactory_api.platforms import make_adapters
    from clipfactory_api.stats.refresh import StatsDeps

    adapters = make_adapters()
    stats = StatsDeps(
        store=db.Store(FakeTable()), adapters=lambda p: adapters[p], clock=Clock(NOW), time_budget_seconds=240.0
    )
    out = stats_handler.handle({"source": "aws.events"}, stats, cr=lambda: deps)
    assert out["action"] == "tick"
    assert finds(deps) == [(None, "schedule")]
    state(deps, nextRunAt=iso(NOW + timedelta(hours=6)))
    stats_handler.handle({"source": "aws.events"}, stats, cr=lambda: deps)
    assert finds(deps) == [(None, "schedule")]  # not due again for 6 hours


def test_the_find_invoke_payloads() -> None:
    client = FakeLambda()
    invoker = AsyncInvoker(client, "", "", "", CAMPAIGNS_ARN)
    invoker.find(None, "schedule")
    invoker.find("u-1", "check_now")
    assert [(c["FunctionName"], c["InvocationType"], c["payload"]) for c in client.calls] == [
        (CAMPAIGNS_ARN, "Event", {"action": "find", "why": "schedule"}),
        (CAMPAIGNS_ARN, "Event", {"action": "find", "userId": "u-1", "why": "check_now"}),
    ]
