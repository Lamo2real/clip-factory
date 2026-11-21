"""Get paid: reading Whop (docs/CONTRACTS.md §40.2, §40.4, §40.6, §40.7; builder L).

Every Whop answer is a fake (``Whop`` below), and it refuses any call without ``Api-Version-Date: 2026-11-20``. The
rules under test: ``users/me``, saved methods with ``bank_verification_state``, payouts paging from the watermark, Whop's
statuses → row states, ``destination_amount`` over ``net_amount`` as micros, a ``completed`` → ``reversed`` change, a
canceled payout is never a hold, the rotating refresh under the lease (two runs at once refresh once), ``invalid_grant``,
and nothing deleted.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, payouts
from clipfactory_api.clock import iso
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.payouts import PayoutDeps, whop
from clipfactory_api.payouts.whoptokens import API_VERSION_DATE, TOKEN_URL, TokenError, WhopTokens
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError
from fakes import FakeSecretsManager
from test_payouts_adsense import StreamTable

USER = "11111111-2222-3333-4444-555555555555"
PK = db.user_pk(USER)
NOW = datetime(2026, 11, 21, 6, 0, 0, tzinfo=UTC)
PREFIX = "cf-prod/platforms/"
TOKEN_NAME = f"{PREFIX}whop/token"
APP_NAME = f"{PREFIX}whop/app"
CLIENT = "app_ClipFactory123"
WHOP_USER = "user_Abc123"
SCOPES = "openid user:balance:read payout:withdrawal:read payout:destination:read identity:read"


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class Sleeper:
    def __init__(self) -> None:
        self.slept: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.slept.append(seconds)


def response(status: int, body: Any, headers: dict[str, str] | None = None) -> HttpResponse:
    return HttpResponse(status, {k.lower(): v for k, v in (headers or {}).items()}, json.dumps(body).encode())


def day(n: int) -> str:
    """``n`` days before NOW, as Whop writes ``created_at``."""
    return (NOW - timedelta(days=n)).isoformat().replace("+00:00", "Z")


class Whop:
    """Whop's API v1 and token endpoint. Refresh tokens rotate: only the newest one works; a reused one is
    ``invalid_grant``. Every call without ``Api-Version-Date: 2026-11-20`` is refused."""

    def __init__(self) -> None:
        self.me: dict[str, Any] = {
            "id": WHOP_USER,
            "username": "lamo",
            "verification": {"individual": {"status": "approved"}, "business": {"status": "not_started"}},
        }
        self.methods: list[dict[str, Any]] = [
            {
                "id": "pom_1",
                "status": "active",
                "bank_verification_state": "verified",
                "is_default": True,
                "destination_currency": "sek",
                "last_paid_out_at": "2026-11-05T09:00:00Z",
            }
        ]
        self.payouts: list[dict[str, Any]] = [
            {
                "id": "po_1",
                "status": "completed",
                "created_at": day(50),
                "net_amount": 100.0,
                "currency": "usd",
                "destination_amount": "950.50",
                "destination_currency": "sek",
                "estimated_arrival": day(45),
                "trace_code": "TRACE-1",
            },
            {"id": "po_2", "status": "canceled", "created_at": day(10), "net_amount": 20, "currency": "usd"},
            {"id": "po_3", "status": "processing", "created_at": day(2), "net_amount": 40, "currency": "usd"},
            {"id": "po_4", "status": "completed", "created_at": day(16), "net_amount": "40.00", "currency": "usd"},
        ]
        self.page_size = 50
        self.valid_refresh = "rt_0"
        self.rotations = 0
        self.tokens: list[HttpResponse | BaseException] = []
        self.fail: dict[str, HttpResponse | BaseException] = {}
        self.calls: list[HttpRequest] = []

    def _refresh(self, request: HttpRequest) -> HttpResponse:
        form = parse_qs((request.body or b"").decode())
        assert request.headers["Content-Type"] == "application/x-www-form-urlencoded"
        assert "client_secret" not in form  # a public client: no secret, ever
        if self.tokens:
            answer = self.tokens.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            return answer
        if form.get("refresh_token") != [self.valid_refresh] or form.get("client_id") != [CLIENT]:
            return response(400, {"error": "invalid_grant"})
        self.rotations += 1
        self.valid_refresh = f"rt_{self.rotations}"
        return response(
            200,
            {
                "access_token": f"at_{self.rotations}",
                "refresh_token": self.valid_refresh,
                "expires_in": 3600,
                "token_type": "Bearer",
                "scope": SCOPES,
            },
        )

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.calls.append(request)
        if request.headers.get("Api-Version-Date") != API_VERSION_DATE:
            return response(400, {"error": {"type": "invalid_request", "message": "Api-Version-Date is required."}})
        if request.url == TOKEN_URL:
            return self._refresh(request)
        url = urlsplit(request.url)
        assert (url.scheme, url.netloc) == ("https", "api.whop.com"), request.url
        for part, found in self.fail.items():
            if part in request.url:
                if isinstance(found, BaseException):
                    raise found
                return found
        if request.headers.get("Authorization") != f"Bearer at_{self.rotations}":
            return response(401, {"error": {"type": "unauthorized"}})
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        path = url.path.removeprefix("/api/v1")
        if path == "/users/me":
            return response(200, self.me)
        assert query.get("user_id") == self.me.get("id", WHOP_USER)  # only his own Whop money
        if path == "/payouts/methods":
            return response(200, {"data": self.methods, "page_info": {"has_next_page": False}})
        assert path == "/payouts"
        found = sorted(self.payouts, key=lambda p: p["created_at"], reverse=True)
        if "created_after" in query:
            found = [p for p in found if p["created_at"] > query["created_after"]]
        start = int(query.get("after") or 0)
        page = found[start : start + self.page_size]
        more = start + self.page_size < len(found)
        return response(
            200, {"data": page, "page_info": {"has_next_page": more, "end_cursor": str(start + self.page_size)}}
        )

    @property
    def refreshes(self) -> list[dict[str, list[str]]]:
        return [parse_qs((c.body or b"").decode()) for c in self.calls if c.url == TOKEN_URL]

    @property
    def reads(self) -> list[str]:
        return [c.url for c in self.calls if c.url != TOKEN_URL]


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def table() -> StreamTable:
    return StreamTable()


@pytest.fixture
def client() -> FakeSecretsManager:
    return FakeSecretsManager()


@pytest.fixture
def fake() -> Whop:
    return Whop()


@pytest.fixture
def sleeper() -> Sleeper:
    return Sleeper()


@pytest.fixture
def deps(table: StreamTable, client: FakeSecretsManager, fake: Whop, clock: Clock, sleeper: Sleeper) -> PayoutDeps:
    return PayoutDeps(store=db.Store(table), secrets=Secrets(client, PREFIX), http=fake, clock=clock, sleep=sleeper)


def seed(deps: PayoutDeps, *, expires_in: timedelta = timedelta(seconds=30), status: str = "connected") -> str:
    """A connected "Connect Whop": the app key, the token (its version on PAYCONN#whop) and PAYCONN#whop."""
    deps.secrets.write(APP_NAME, {"clientId": CLIENT, "userId": USER, "savedAt": iso(NOW)}, platform="whop")
    secret = {
        "accessToken": "at_0",
        "expiresAt": iso(NOW + expires_in),
        "refreshToken": "rt_0",
        "scope": SCOPES,
        "whopUserId": WHOP_USER,
    }
    version = deps.secrets.write(TOKEN_NAME, secret, platform="whop")
    deps.store.put(
        {
            "pk": PK,
            "sk": "PAYCONN#whop",
            "type": "payconn",
            "source": "whop",
            "status": status,
            "accountId": WHOP_USER,
            "accountName": "@lamo",
            "connectedAt": iso(NOW - timedelta(days=3)),
            "scopes": SCOPES.split(),
            "tokenVersionId": version,
            "keyHint": "app_Cl…e123",
            "lastResult": "whop_connected",
            "updatedAt": iso(NOW - timedelta(days=3)),
        }
    )
    return version


def state(deps: PayoutDeps) -> dict[str, Any]:
    return deps.store.get(PK, "PAYSTATE#contentrewards") or {}


def rows(deps: PayoutDeps) -> dict[str, dict[str, Any]]:
    return {r["payoutId"]: r for r in deps.store.query_all(PK, "PAYOUT#contentrewards#")}


def conn(deps: PayoutDeps) -> dict[str, Any]:
    return deps.store.get(PK, "PAYCONN#whop") or {}


# --- the items ------------------------------------------------------------------------------------------------


def test_the_first_read_writes_the_items(deps: PayoutDeps, fake: Whop) -> None:
    seed(deps)
    assert whop.run(deps, USER, NOW) == "read"
    assert all(c.headers["Api-Version-Date"] == "2026-11-20" for c in fake.calls)
    assert fake.reads == [
        "https://api.whop.com/api/v1/users/me",
        f"https://api.whop.com/api/v1/payouts/methods?user_id={WHOP_USER}",
        f"https://api.whop.com/api/v1/payouts?user_id={WHOP_USER}&first=50",  # no watermark yet: everything
    ]
    found = rows(deps)
    assert {k: (r["status"], r["state"]) for k, r in found.items()} == {
        "po_1": ("completed", "sent"),
        "po_2": ("canceled", "didnt_go_through"),
        "po_3": ("processing", "on_its_way"),
        "po_4": ("completed", "sent"),
    }
    first = found["po_1"]
    assert first["sk"] == f"PAYOUT#contentrewards#{day(50)[:10]}#po_1"
    assert {k: v for k, v in first.items() if k not in {"pk", "sk"}} == {
        "type": "payout",
        "place": "contentrewards",
        "by": "whop",
        "source": "whop.payouts",
        "payoutId": "po_1",
        "status": "completed",
        "state": "sent",
        "date": day(50)[:10],
        # What Whop sent to the bank (after Whop's fees and any conversion Whop made), not the net in dollars.
        "amountMicros": 950_500_000,
        "currency": "SEK",
        "estimatedArrival": iso(NOW - timedelta(days=45)),
        "traceCode": "TRACE-1",  # kept for §40.5, never shown
        "fetchedAt": iso(NOW),
        "updatedAt": iso(NOW),
    }
    assert (found["po_4"]["amountMicros"], found["po_4"]["currency"]) == (40_000_000, "USD")
    got = state(deps)
    assert {k: v for k, v in got.items() if k not in {"pk", "sk", "grantMark"}} == {
        "type": "paystate",
        "place": "contentrewards",
        "source": "whop",
        "kyc": "approved",
        "methods": {"created": 0, "active": 1, "broken": 0, "ready": 1, "currencies": ["SEK"]},
        "lastPaidOutAt": "2026-11-05T09:00:00.000Z",
        "businesses": False,
        "lastSent": {
            "sk": f"PAYOUT#contentrewards#{day(16)[:10]}#po_4",
            "date": day(16)[:10],
            "amountMicros": 40_000_000,
            "currency": "USD",
        },
        "payoutsMark": iso(NOW - timedelta(days=2)),
        "lastCheckedAt": iso(NOW),
        "firstReadDone": True,
    }  # no hold: a canceled payout is never one


def test_the_watermark_reads_from_30_days_before_and_sees_a_reversal(
    deps: PayoutDeps, fake: Whop, clock: Clock
) -> None:
    seed(deps)
    whop.run(deps, USER, NOW)
    fake.payouts[3]["status"] = "reversed"  # po_4 came back from the bank
    later = NOW + timedelta(days=1)
    clock.now = later
    whop.run(deps, USER, later)
    after = iso(NOW - timedelta(days=2) - timedelta(days=30))
    assert fake.reads[-1] == (
        f"https://api.whop.com/api/v1/payouts?user_id={WHOP_USER}&first=50&created_after={after.replace(':', '%3A')}"
    )
    found = rows(deps)
    assert (found["po_4"]["status"], found["po_4"]["state"]) == ("reversed", "came_back")
    assert found["po_4"]["updatedAt"] == iso(later)
    assert found["po_4"]["fetchedAt"] == iso(NOW)
    assert found["po_1"]["state"] == "sent"  # older than the window: kept as it was
    got = state(deps)
    assert got["lastSent"]["sk"].endswith("#po_1")  # a reversed payout stops counting
    assert got["hold"] == {"kind": "payout_failed", "since": iso(later)}  # came back, no newer completed one


def test_a_newer_completed_payout_ends_a_failed_one(deps: PayoutDeps, fake: Whop) -> None:
    fake.payouts.append({"id": "po_5", "status": "failed", "created_at": day(5), "net_amount": 9, "currency": "usd"})
    seed(deps)
    whop.run(deps, USER, NOW)
    assert state(deps)["hold"]["kind"] == "payout_failed"
    fake.payouts.append({"id": "po_6", "status": "completed", "created_at": day(1), "net_amount": 9, "currency": "usd"})
    whop.run(deps, USER, NOW + timedelta(hours=1))
    assert "hold" not in state(deps)


@pytest.mark.parametrize("status", ["denied", "failed"])
def test_a_payout_that_didnt_go_through_is_a_hold(deps: PayoutDeps, fake: Whop, status: str) -> None:
    fake.payouts.append({"id": "po_9", "status": status, "created_at": day(1), "net_amount": 9, "currency": "usd"})
    seed(deps)
    whop.run(deps, USER, NOW)
    assert state(deps)["hold"] == {"kind": "payout_failed", "since": iso(NOW)}
    assert rows(deps)["po_9"]["state"] == "didnt_go_through"


def test_an_old_failed_payout_and_a_canceled_one_are_never_a_hold(deps: PayoutDeps, fake: Whop) -> None:
    fake.payouts.append({"id": "po_8", "status": "failed", "created_at": day(31), "net_amount": 9, "currency": "usd"})
    fake.payouts.append({"id": "po_9", "status": "canceled", "created_at": day(0), "net_amount": 9, "currency": "usd"})
    seed(deps)
    whop.run(deps, USER, NOW)
    assert "hold" not in state(deps)


def test_the_id_check_and_broken_methods_are_holds(deps: PayoutDeps, fake: Whop) -> None:
    seed(deps)
    fake.me["verification"]["individual"] = {"status": "rejected"}
    whop.run(deps, USER, NOW)
    assert state(deps)["kyc"] == "rejected"
    assert state(deps)["hold"] == {"kind": "id_rejected", "since": iso(NOW)}
    fake.me["verification"]["individual"] = {"status": "approved"}
    fake.methods = [{"id": "pom_1", "status": "broken"}, {"id": "pom_2", "status": "broken"}]
    whop.run(deps, USER, NOW + timedelta(hours=1))
    got = state(deps)
    assert got["hold"] == {"kind": "bank_broken", "since": iso(NOW + timedelta(hours=1))}
    assert got["methods"] == {"created": 0, "active": 0, "broken": 2, "ready": 0, "currencies": []}


def test_methods_waiting_for_the_bank_check_are_not_ready(deps: PayoutDeps, fake: Whop) -> None:
    fake.methods = [
        {"id": "pom_1", "status": "created", "bank_verification_state": "pending", "destination_currency": "SEK"},
        {"id": "pom_2", "status": "active", "bank_verification_state": "failed"},
        {"id": "pom_3", "status": "created"},
        {"id": "pom_4", "status": "broken"},
    ]
    fake.me["verification"] = {"individual": "pending"}
    seed(deps)
    whop.run(deps, USER, NOW)
    got = state(deps)
    assert got["methods"] == {"created": 2, "active": 1, "broken": 1, "ready": 1, "currencies": ["SEK"]}
    assert got["kyc"] == "pending"
    assert got["businesses"] is False
    assert "hold" not in got
    assert "lastPaidOutAt" not in got


@pytest.mark.parametrize(
    ("me", "owns"),
    [
        # Whop's own shape: the balances of the biz_ accounts he owns sit under balance.
        ({"balance": {"total_usd": 0, "businesses": [{"id": "biz_1"}], "businesses_total_usd": 5}}, True),
        ({"balance": {"total_usd": 3, "businesses": [], "businesses_total_usd": "12.50"}}, True),
        ({"balance": {"total_usd": 3, "businesses": [], "businesses_total_usd": 0}}, False),
        ({"balance": {"total_usd": 3}}, False),
        ({"balance": None}, False),
        ({"owned_businesses": [{"id": "biz_1"}]}, True),  # a top-level list, just in case
    ],
)
def test_owned_businesses_are_noted(deps: PayoutDeps, fake: Whop, me: dict[str, Any], owns: bool) -> None:
    fake.me.update(me)
    seed(deps)
    whop.run(deps, USER, NOW)
    assert state(deps)["businesses"] is owns


def test_an_unknown_id_check_is_unknown_never_a_guess(deps: PayoutDeps, fake: Whop) -> None:
    fake.me["verification"] = {"individual": {"status": "action_required"}}
    seed(deps)
    whop.run(deps, USER, NOW)
    assert state(deps)["kyc"] == "unknown"


def test_at_most_five_pages_a_run(deps: PayoutDeps, fake: Whop) -> None:
    fake.page_size = 2
    fake.payouts = [
        {"id": f"po_{n}", "status": "completed", "created_at": day(n), "net_amount": 1, "currency": "usd"}
        for n in range(1, 13)
    ]
    seed(deps)
    whop.run(deps, USER, NOW)
    assert sum("/payouts?" in u for u in fake.reads) == 5
    assert "&after=2" in fake.reads[3]
    assert len(rows(deps)) == 10


def test_unreadable_amounts_are_kept_without_a_number(deps: PayoutDeps, fake: Whop) -> None:
    fake.payouts = [
        {"id": "po_1", "status": "completed", "created_at": day(1), "net_amount": "abc", "currency": "usd"},
        {"id": "po_2", "status": "completed", "created_at": day(1), "net_amount": 5, "currency": "dollars"},
        {"id": "bad id!", "status": "completed", "created_at": day(1), "net_amount": 5, "currency": "usd"},
        {"id": "po_3", "status": "who_knows", "created_at": day(1), "net_amount": 5, "currency": "usd"},
    ]
    seed(deps)
    whop.run(deps, USER, NOW)
    found = rows(deps)
    assert sorted(found) == ["po_1", "po_2"]
    assert all("amountMicros" not in r and "currency" not in r for r in found.values())  # never a $0


def test_micros_are_a_unit_change_only() -> None:
    assert whop.micros("40.00") == 40_000_000
    assert whop.micros(0.1) == 100_000
    assert whop.micros("1234.567891") == 1_234_567_891
    assert [whop.micros(v) for v in (None, True, "-1", "NaN", "Infinity", "x")] == [None] * 6


# --- failures keep everything -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "text"),
    [
        (response(429, {"error": {"type": "rate_limited"}}, {"Retry-After": "30"}), payouts.WHOP_DOWN),
        (response(502, {}), payouts.WHOP_DOWN),
        (NetworkError("timeout"), payouts.WHOP_DOWN),
        (response(403, {"error": {"type": "forbidden"}}), payouts.WHOP_REFUSED),
    ],
)
def test_a_failed_read_only_sets_last_error(deps: PayoutDeps, fake: Whop, answer: Any, text: str) -> None:
    seed(deps)
    whop.run(deps, USER, NOW)
    kept_rows, kept = rows(deps), state(deps)
    fake.fail["/payouts?"] = answer
    assert whop.run(deps, USER, NOW + timedelta(hours=1)) == "error"
    got = state(deps)
    assert got["lastError"] == text
    assert {k: v for k, v in got.items() if k != "lastError"} == kept
    assert rows(deps) == kept_rows


def test_a_refused_token_is_refreshed_once(deps: PayoutDeps, fake: Whop) -> None:
    seed(deps, expires_in=timedelta(minutes=40))
    fake.rotations = 7  # Whop no longer takes at_0 though it isn't due
    fake.valid_refresh = "rt_0"
    assert whop.run(deps, USER, NOW) == "read"
    assert len(fake.refreshes) == 1


# --- the rotating token ---------------------------------------------------------------------------------------


def test_a_due_token_is_refreshed_under_the_lease_and_written_put_only(
    deps: PayoutDeps, fake: Whop, client: FakeSecretsManager
) -> None:
    old_version = seed(deps)
    assert whop.run(deps, USER, NOW) == "read"
    assert fake.refreshes == [{"grant_type": ["refresh_token"], "refresh_token": ["rt_0"], "client_id": [CLIENT]}]
    got = conn(deps)
    assert got["tokenVersionId"] != old_version
    assert "refreshLeaseUntil" not in got
    assert got["updatedAt"] == iso(NOW - timedelta(days=3))  # the grant's mark is never moved by a refresh
    secret = json.loads(client.versions[TOKEN_NAME][got["tokenVersionId"]])
    assert secret == {
        "accessToken": "at_1",
        "expiresAt": iso(NOW + timedelta(hours=1)),
        "refreshToken": "rt_1",
        "scope": SCOPES,
        "whopUserId": WHOP_USER,
    }
    assert client.writes[-1] == ("put", TOKEN_NAME)


def test_two_runs_at_once_refresh_once(deps: PayoutDeps, fake: Whop, clock: Clock) -> None:
    seed(deps)
    deps.store.update(PK, "PAYCONN#whop", {"refreshLeaseUntil": iso(NOW + timedelta(seconds=30))})  # another run
    other = PayoutDeps(store=deps.store, secrets=deps.secrets, http=fake, clock=clock)

    def the_other_run_refreshes(_seconds: float) -> None:
        if not fake.refreshes:
            deps.store.update(PK, "PAYCONN#whop", {}, remove=["refreshLeaseUntil"])
            WhopTokens(other).access(USER)
            deps.store.update(PK, "PAYCONN#whop", {"refreshLeaseUntil": iso(NOW + timedelta(seconds=30))})

    deps.sleep = the_other_run_refreshes
    assert WhopTokens(deps).access(USER).token == "at_1"
    assert len(fake.refreshes) == 1  # the rotating refresh token was used once


def test_the_lease_never_won_is_busy(deps: PayoutDeps, fake: Whop, sleeper: Sleeper) -> None:
    seed(deps)
    deps.store.update(PK, "PAYCONN#whop", {"refreshLeaseUntil": iso(NOW + timedelta(seconds=30))})
    with pytest.raises(TokenError) as caught:
        WhopTokens(deps).access(USER)
    assert caught.value.kind == "busy"
    assert sleeper.slept == [1.0] * 5
    assert fake.refreshes == []
    assert whop.run(deps, USER, NOW) == "error"
    assert state(deps)["lastError"] == payouts.WHOP_DOWN


def test_a_refresh_needs_20_seconds(deps: PayoutDeps, fake: Whop) -> None:
    seed(deps)
    deps.remaining = lambda: 19.0
    with pytest.raises(TokenError) as caught:
        WhopTokens(deps).access(USER)
    assert caught.value.kind == "down"
    assert fake.calls == []


def test_a_lost_answer_retries_the_same_refresh_token_once(deps: PayoutDeps, fake: Whop) -> None:
    seed(deps)
    fake.tokens = [NetworkError("timeout")]
    assert whop.run(deps, USER, NOW) == "read"
    assert [f["refresh_token"] for f in fake.refreshes] == [["rt_0"], ["rt_0"]]


def test_429_waits_then_tries_once(deps: PayoutDeps, fake: Whop, sleeper: Sleeper) -> None:
    seed(deps)
    fake.tokens = [response(429, {"error": "slow_down"}, {"Retry-After": "4"})]
    assert whop.run(deps, USER, NOW) == "read"
    assert sleeper.slept == [4.0]
    assert len(fake.refreshes) == 2


def test_invalid_grant_needs_a_reconnect_and_deletes_nothing(
    deps: PayoutDeps, fake: Whop, client: FakeSecretsManager
) -> None:
    seed(deps)
    fake.valid_refresh = "rt_someone_else"
    assert whop.run(deps, USER, NOW) == "token_dead"
    got = conn(deps)
    assert (got["status"], got["reason"]) == ("needs_reconnect", "token_dead")
    assert TOKEN_NAME in client.values
    assert APP_NAME in client.values
    assert fake.reads == []
    assert state(deps) == {}
    assert whop.run(deps, USER, NOW) == "not_connected"


def test_a_stop_during_the_refresh_throws_the_result_away(
    deps: PayoutDeps, fake: Whop, client: FakeSecretsManager
) -> None:
    seed(deps)

    def stop_meanwhile(request: HttpRequest) -> HttpResponse:
        answer = fake(request)
        if request.url == TOKEN_URL:
            client.delete_secret(SecretId=TOKEN_NAME, ForceDeleteWithoutRecovery=True)
            deps.store.update(PK, "PAYCONN#whop", {"status": "keys_saved"}, remove=["tokenVersionId"])
        return answer

    deps.http = stop_meanwhile
    assert whop.run(deps, USER, NOW) == "not_connected"
    assert TOKEN_NAME not in client.values  # never re-created
    assert state(deps) == {}


def test_another_sign_in_during_the_refresh_wins(deps: PayoutDeps, fake: Whop, client: FakeSecretsManager) -> None:
    seed(deps)

    def reconnect_meanwhile(request: HttpRequest) -> HttpResponse:
        answer = fake(request)
        if request.url == TOKEN_URL:
            version = deps.secrets.write(TOKEN_NAME, {"accessToken": "at_new", "refreshToken": "rt_new"})
            deps.store.update(PK, "PAYCONN#whop", {"tokenVersionId": version})
        return answer

    deps.http = reconnect_meanwhile
    assert whop.run(deps, USER, NOW) == "not_connected"
    newest = json.loads(client.versions[TOKEN_NAME][conn(deps)["tokenVersionId"]])
    assert newest["refreshToken"] == "rt_new"


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (response(401, {"error": "invalid_client"}), "keys_changed"),  # the app key itself: signing in again can't help
        (response(400, {"error": "unauthorized_client"}), "keys_changed"),
        (response(401, {"error": "invalid_token"}), "token_dead"),
    ],
)
def test_whop_refusing_the_key_is_keys_changed(deps: PayoutDeps, fake: Whop, answer: HttpResponse, reason: str) -> None:
    seed(deps)
    fake.tokens = [answer]
    assert whop.run(deps, USER, NOW) == "token_dead"
    assert (conn(deps)["status"], conn(deps)["reason"]) == ("needs_reconnect", reason)
    assert len(fake.refreshes) == 1


# --- a new grant ----------------------------------------------------------------------------------------------


def _payouts_reads(fake: Whop) -> list[dict[str, str]]:
    return [{k: v[0] for k, v in parse_qs(urlsplit(u).query).items()} for u in fake.reads if "/payouts?" in u]


def test_another_whop_account_is_read_from_the_start(deps: PayoutDeps, fake: Whop, table: StreamTable) -> None:
    seed(deps, expires_in=timedelta(hours=1))
    whop.run(deps, USER, NOW)
    assert state(deps)["payoutsMark"] == iso(NOW - timedelta(days=2))
    # Stop reading Whop, then Connect Whop with another Whop account: K writes connectedAt anew.
    later = NOW + timedelta(days=3)
    deps.store.update(PK, "PAYCONN#whop", {"accountId": "user_Other9", "connectedAt": iso(later)})
    fake.me["id"] = "user_Other9"
    fake.calls.clear()
    table.stream.clear()
    whop.run(deps, USER, later)
    first = _payouts_reads(fake)[0]
    assert "created_after" not in first  # never from the old account's newest payout
    paystate = [(old or {}, new) for _, old, new in table.stream if new["sk"] == "PAYSTATE#contentrewards"]
    assert "payoutsMark" in paystate[0][0]
    assert "payoutsMark" not in paystate[0][1]
    assert [bool(new.get("firstReadDone")) for _, new in paystate] == [False, True]  # quiet, then done


def test_saving_the_same_key_again_is_not_a_new_grant(deps: PayoutDeps, fake: Whop, table: StreamTable) -> None:
    seed(deps, expires_in=timedelta(hours=1))
    whop.run(deps, USER, NOW)
    # PUT /v1/getpaid/whop/key with the key he already has: only keyHint and updatedAt move.
    deps.store.update(PK, "PAYCONN#whop", {"keyHint": "app_Cl…e123", "updatedAt": iso(NOW + timedelta(hours=1))})
    fake.calls.clear()
    table.stream.clear()
    whop.run(deps, USER, NOW + timedelta(days=1))
    assert _payouts_reads(fake)[0]["created_after"] == iso(NOW - timedelta(days=32))
    paystate = [new for _, _, new in table.stream if new["sk"] == "PAYSTATE#contentrewards"]
    assert len(paystate) == 1  # one write: never quiet again
    assert paystate[0]["firstReadDone"] is True


def test_a_grant_mark_from_the_api_wins(deps: PayoutDeps) -> None:
    base = {"connectedAt": "2026-11-01T09:00:00.000Z", "updatedAt": "2026-11-21T12:00:00.000Z"}
    assert payouts.grant_mark(base, "whop") == "2026-11-01T09:00:00.000Z"
    assert payouts.grant_mark(base, "adsense") == "2026-11-01T09:00:00.000Z|2026-11-21T12:00:00.000Z"
    granted = {**base, "grantedAt": "2026-11-20T08:00:00.000Z"}
    assert (
        payouts.grant_mark(granted, "whop")
        == payouts.grant_mark(granted, "adsense")
        == "granted|2026-11-20T08:00:00.000Z"
    )


@pytest.mark.parametrize("status", ["not_connected", "keys_saved", "needs_reconnect"])
def test_nothing_is_read_unless_connected(deps: PayoutDeps, fake: Whop, status: str) -> None:
    seed(deps, status=status)
    assert whop.run(deps, USER, NOW) == "not_connected"
    assert fake.calls == []
