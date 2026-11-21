"""Get paid: the payout reads inside the money run (docs/CONTRACTS.md §40.7 "Checking"; builder L).

``money.collect.run_user`` calls ``payouts.collect.run`` once, after the five platforms, inside its own try. The rules
under test: a raising collector never stops ``run_user``; one source raising or failing never stops the other; the run
is skipped when less than 20 s of the time budget is left; and with no ``PAYCONN#`` item (before the API builder's
part) nothing is read or written.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from clipfactory_api import db, payouts
from clipfactory_api.money import collect as money_collect
from clipfactory_api.money import handler
from clipfactory_api.money.collect import MoneyDeps
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.payouts import PayoutDeps, collect, whop
from clipfactory_api.platforms.base import HttpRequest, HttpResponse
from fakes import FakeSecretsManager
from test_payouts_adsense import NOW, PK, USER, Google, StreamTable, response
from test_payouts_adsense import seed as seed_adsense
from test_payouts_whop import Whop
from test_payouts_whop import seed as seed_whop


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> Any:
        return self.now


class Both:
    """Google and Whop behind one HTTP client, by host."""

    def __init__(self) -> None:
        self.google = Google()
        self.whop = Whop()
        self.calls: list[HttpRequest] = []

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.calls.append(request)
        return self.whop(request) if "whop.com" in request.url else self.google(request)


@dataclass
class Env:
    secrets: Secrets


class Tokens:
    """What the money run's ``SecretsTokenProvider`` offers the payout reads: its ``env.secrets``."""

    def __init__(self, secrets: Secrets) -> None:
        self.env = Env(secrets)

    def credentials(self, platform: str, account: dict[str, Any]) -> Any:
        raise AssertionError("no platform is connected in these tests")


class Ticker:
    """``monotonic``: each reading moves on by ``step`` seconds."""

    def __init__(self, step: float = 0.001) -> None:
        self.value = 1000.0
        self.step = step

    def __call__(self) -> float:
        self.value += self.step
        return self.value


@pytest.fixture
def http() -> Both:
    return Both()


@pytest.fixture
def table() -> StreamTable:
    return StreamTable()


@pytest.fixture
def secrets() -> Secrets:
    return Secrets(FakeSecretsManager(), "cf-prod/platforms/")


@pytest.fixture
def money_deps(table: StreamTable, secrets: Secrets, http: Both) -> MoneyDeps:
    return MoneyDeps(store=db.Store(table), tokens=Tokens(secrets), http=http, clock=Clock(), monotonic=Ticker())


@pytest.fixture
def deps(money_deps: MoneyDeps) -> PayoutDeps:
    found = collect.from_money(money_deps)
    assert found is not None
    return found


def paystate(store: db.Store, place: str) -> dict[str, Any]:
    return store.get(PK, f"PAYSTATE#{place}") or {}


def test_before_the_api_builder_nothing_is_read_or_written(
    money_deps: MoneyDeps, http: Both, table: StreamTable
) -> None:
    assert money_collect.run_user(money_deps, USER, platforms=()) == []
    assert http.calls == []
    assert [new["sk"] for _, _, new in table.stream] == []


def test_run_user_reads_both_sources_after_the_platforms(money_deps: MoneyDeps, deps: PayoutDeps, http: Both) -> None:
    seed_adsense(deps)
    seed_whop(deps)
    outcomes = money_collect.run_user(money_deps, USER, platforms=("youtube",))
    assert [(o.platform, o.state) for o in outcomes] == [("youtube", "not_connected")]  # unchanged
    assert paystate(deps.store, "youtube")["firstReadDone"] is True
    assert paystate(deps.store, "contentrewards")["firstReadDone"] is True
    hosts = [c.url.split("/")[2] for c in http.calls]
    assert hosts.index("api.whop.com") > max(i for i, h in enumerate(hosts) if "google" in h)  # AdSense first


def test_check_now_reads_payouts_too(money_deps: MoneyDeps, deps: PayoutDeps) -> None:
    seed_adsense(deps)
    assert handler.handle({"action": "refresh", "userId": USER}, money_deps)["action"] == "refresh"
    assert paystate(deps.store, "youtube")["lastCheckedAt"]


def test_a_raising_collector_never_stops_run_user(money_deps: MoneyDeps, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("bug")

    monkeypatch.setattr(collect, "run", boom)
    assert money_collect.run_user(money_deps, USER, platforms=("youtube",))[0].state == "not_connected"


def test_one_source_raising_never_stops_the_other(
    deps: PayoutDeps, http: Both, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_adsense(deps)
    seed_whop(deps)

    def boom(*_args: Any) -> str:
        raise RuntimeError("bug")

    monkeypatch.setattr(collect, "SOURCES", ((payouts.ADSENSE, boom), (payouts.WHOP, whop.run)))
    assert collect.run(deps, USER, NOW) == {"adsense": "error", "whop": "read"}


def test_one_source_failing_never_stops_the_other(deps: PayoutDeps, http: Both) -> None:
    seed_adsense(deps)
    seed_whop(deps)
    http.google.fail["/accounts"] = response(503, {})
    assert collect.run(deps, USER, NOW) == {"adsense": "error", "whop": "read"}
    assert paystate(deps.store, "youtube")["lastError"] == payouts.GOOGLE_DOWN
    assert "lastError" not in paystate(deps.store, "contentrewards")


def test_a_bug_inside_a_source_says_so_on_its_state(deps: PayoutDeps, monkeypatch: pytest.MonkeyPatch) -> None:
    seed_adsense(deps)

    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyError("bug")

    monkeypatch.setattr(payouts.adsense, "_write", boom)
    assert collect.run(deps, USER, NOW)["adsense"] == "error"
    assert paystate(deps.store, "youtube")["lastError"] == payouts.CHECK_FAILED


def test_skipped_with_less_than_20_seconds_left(money_deps: MoneyDeps, deps: PayoutDeps, http: Both) -> None:
    seed_adsense(deps)
    seed_whop(deps)
    money_deps.time_budget_seconds = 240.0
    money_deps.monotonic = Ticker(step=225.0)  # one reading per platform step: the budget is nearly gone
    money_collect.run_user(money_deps, USER, platforms=())
    assert http.calls == []
    assert paystate(deps.store, "youtube") == {}
    assert paystate(deps.store, "contentrewards") == {}


def test_the_whop_source_is_skipped_when_adsense_used_up_the_time(
    deps: PayoutDeps, http: Both, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_adsense(deps)
    seed_whop(deps)
    budget = {"left": 60.0}
    deps.remaining = lambda: budget["left"]

    def slow_adsense(*args: Any) -> str:
        outcome = payouts.adsense.run(*args)
        budget["left"] = 19.0
        return outcome

    monkeypatch.setattr(collect, "SOURCES", ((payouts.ADSENSE, slow_adsense), (payouts.WHOP, whop.run)))
    assert collect.run(deps, USER, NOW) == {"adsense": "read", "whop": "skipped"}
    assert not any("whop.com" in c.url for c in http.calls)


def test_no_call_starts_once_the_time_is_used_up(deps: PayoutDeps, http: Both) -> None:
    seed_adsense(deps)
    calls = {"n": 0}

    def remaining() -> float:
        calls["n"] += 1
        return 30.0 if calls["n"] <= 3 else 0.0  # the run's check, then two AdSense calls, then nothing left

    deps.remaining = remaining
    assert collect.run(deps, USER, NOW)["adsense"] == "error"
    assert len(http.calls) == 2
    assert paystate(deps.store, "youtube")["lastError"] == payouts.OUT_OF_TIME


def test_without_secrets_nothing_is_read(table: StreamTable, http: Both) -> None:
    class NoSecrets:
        pass

    deps = MoneyDeps(store=db.Store(table), tokens=NoSecrets(), http=http)
    assert collect.run(deps, USER, NOW) == {}
    assert http.calls == []


def test_the_daily_run_reads_each_owner(money_deps: MoneyDeps, deps: PayoutDeps) -> None:
    from clipfactory_api import money

    seed_adsense(deps)
    money.register_owner(deps.store, USER, NOW)
    assert handler.handle({"source": "aws.events"}, money_deps)["owners"] == 1
    assert paystate(deps.store, "youtube")["firstReadDone"] is True
