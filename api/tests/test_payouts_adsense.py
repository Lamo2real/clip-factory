"""Get paid: reading AdSense for YouTube (docs/CONTRACTS.md §40.4, §40.6, §40.7; builder L).

Every Google answer is a fake (``Google`` below); nothing reaches a network or AWS. The rules under test: the items of
§40.7 with the publisher suffix, Google's amounts kept as Google wrote them, a changed amount sets ``revisedAt``, a
vanished payment is kept as ``gone``, a failed read only sets ``lastError``, a dead or changed key needs a reconnect,
nothing is ever deleted, at most 5 AdSense calls a run, and the first read after a grant is quiet.
"""

from __future__ import annotations

import copy
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, payouts
from clipfactory_api.clock import iso
from clipfactory_api.oauth.providers import GOOGLE_TOKEN
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.payouts import PayoutDeps, adsense
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError
from fakes import FakeSecretsManager, FakeTable

USER = "11111111-2222-3333-4444-555555555555"
PK = db.user_pk(USER)
NOW = datetime(2026, 11, 21, 6, 0, 0, tzinfo=UTC)
PREFIX = "cf-prod/platforms/"
TOKEN_NAME = f"{PREFIX}adsense/token"
APP_NAME = f"{PREFIX}youtube/app"
CLIENT = "123-abc.apps.googleusercontent.com"
SCOPE = "https://www.googleapis.com/auth/adsense.readonly"
A1 = "accounts/pub-1111222233334444"
A2 = "accounts/pub-5555666677778888"
A3 = "accounts/pub-9999000011112222"
API = adsense.API
GOLDEN = Path(__file__).parent / "fixtures" / "getpaid_items.json"


class Clock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


class StreamTable(FakeTable):
    """A ``FakeTable`` that keeps a DynamoDB stream (eventName, old image, new image) and refuses every delete."""

    def __init__(self) -> None:
        super().__init__()
        self.stream: list[tuple[str, dict[str, Any] | None, dict[str, Any]]] = []

    def _keep(self, key: tuple[str, str], old: dict[str, Any] | None) -> None:
        new = self.items.get(key)
        if new is not None and new != old:
            self.stream.append(("INSERT" if old is None else "MODIFY", old, copy.deepcopy(new)))

    def put_item(self, **kw: Any) -> dict[str, Any]:
        key = (kw["Item"]["pk"], kw["Item"]["sk"])
        old = copy.deepcopy(self.items.get(key))
        out = super().put_item(**kw)
        self._keep(key, old)
        return out

    def update_item(self, **kw: Any) -> dict[str, Any]:
        key = (kw["Key"]["pk"], kw["Key"]["sk"])
        old = copy.deepcopy(self.items.get(key))
        out = super().update_item(**kw)
        self._keep(key, old)
        return out

    def delete_item(self, **kw: Any) -> dict[str, Any]:
        raise AssertionError(f"nothing in Get paid deletes an item: {kw['Key']}")


def response(status: int, body: Any, headers: dict[str, str] | None = None) -> HttpResponse:
    return HttpResponse(status, {k.lower(): v for k, v in (headers or {}).items()}, json.dumps(body).encode())


class Google:
    """AdSense Management API v2 and Google's token endpoint, answering by URL (recorded shapes)."""

    def __init__(self) -> None:
        self.accounts: list[dict[str, Any]] = [
            {"name": A1, "displayName": "Main AdSense", "state": "READY", "pendingTasks": []},
            {"name": A2, "displayName": "Old AdSense", "state": "READY"},
        ]
        self.alerts: dict[str, list[dict[str, Any]]] = {
            A1: [
                {
                    "name": f"{A1}/alerts/1",
                    "type": "payment-hold",
                    "severity": "SEVERE",
                    "message": "<p>Your payments are <b>on hold</b> &amp; can't be sent.<br>See <a href='/x'>Payments</a>.</p>",
                },
                {
                    "name": f"{A1}/alerts/2",
                    "type": "ads-txt-unauthorized",
                    "severity": "WARNING",
                    "message": "Fix <i>ads.txt</i>",
                },
            ],
            A2: [],
        }
        self.payments: dict[str, list[dict[str, Any]]] = {
            A1: [
                {"name": f"{A1}/payments/youtube-unpaid", "amount": "SEK 512.30"},
                {
                    "name": f"{A1}/payments/youtube-2026-10-23",
                    "amount": "kr\u00a01\u00a0234,56 SEK",
                    "date": {"year": 2026, "month": 10, "day": 23},
                },
                {"name": f"{A1}/payments/youtube-2026-09-22", "amount": "kr 980,00 SEK"},
                {"name": f"{A1}/payments/unpaid", "amount": "$3.00"},
                {"name": f"{A1}/payments/2026-09-21", "amount": "$5.00"},
            ],
            A2: [{"name": f"{A2}/payments/youtube-2026-10-23", "amount": "€87.65"}],
        }
        self.fail: dict[str, HttpResponse | BaseException] = {}  # a URL part → its answer
        self.tokens: list[HttpResponse | BaseException] = []
        self.calls: list[HttpRequest] = []

    def token_ok(self, access: str = "at_1") -> HttpResponse:
        return response(200, {"access_token": access, "expires_in": 3599, "scope": SCOPE, "token_type": "Bearer"})

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.calls.append(request)
        if request.url == GOOGLE_TOKEN:
            answer = self.tokens.pop(0) if self.tokens else self.token_ok()
            if isinstance(answer, BaseException):
                raise answer
            return answer
        assert request.url.startswith(API + "/"), request.url
        assert request.headers["Authorization"].startswith("Bearer ")
        for part, found in self.fail.items():
            if part in request.url:
                if isinstance(found, BaseException):
                    raise found
                return found
        path = urlsplit(request.url).path.removeprefix("/v2/")
        if path == "accounts":
            return response(200, {"accounts": self.accounts})
        account, kind = path.rsplit("/", 1)
        if kind == "alerts":
            assert parse_qs(urlsplit(request.url).query) == {"languageCode": ["en"]}
            return response(200, {"alerts": self.alerts.get(account, [])})
        return response(200, {"payments": self.payments.get(account, [])})

    @property
    def api_calls(self) -> list[str]:
        return [c.url for c in self.calls if c.url != GOOGLE_TOKEN]

    @property
    def token_forms(self) -> list[dict[str, list[str]]]:
        return [parse_qs((c.body or b"").decode()) for c in self.calls if c.url == GOOGLE_TOKEN]


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
def google() -> Google:
    return Google()


@pytest.fixture
def deps(table: StreamTable, client: FakeSecretsManager, google: Google, clock: Clock) -> PayoutDeps:
    return PayoutDeps(store=db.Store(table), secrets=Secrets(client, PREFIX), http=google, clock=clock)


def seed(
    deps: PayoutDeps,
    *,
    expires_in: timedelta = timedelta(minutes=50),
    client_id: str = CLIENT,
    status: str = "connected",
    updated: datetime = NOW - timedelta(days=2),
) -> None:
    """A connected "Allow payment reading": the YouTube app keys, the AdSense token and ``PAYCONN#adsense``."""
    deps.secrets.write(APP_NAME, {"clientId": CLIENT, "clientSecret": "GOCSPX-secret"}, platform="youtube")
    secret = {
        "accessToken": "at_0",
        "expiresAt": iso(NOW + expires_in),
        "refreshToken": "rt_0",
        "scope": SCOPE,
        "clientId": client_id,
        "accounts": [A1],
    }
    deps.secrets.write(TOKEN_NAME, secret, platform="adsense")
    deps.store.put(
        {
            "pk": PK,
            "sk": "PAYCONN#adsense",
            "type": "payconn",
            "source": "adsense",
            "status": status,
            "accounts": [{"name": A1, "displayName": "Main AdSense"}],
            "connectedAt": iso(NOW - timedelta(days=30)),
            "scopes": [SCOPE],
            "lastResult": "payments_allowed",
            "updatedAt": iso(updated),
        }
    )


def state(deps: PayoutDeps) -> dict[str, Any]:
    return deps.store.get(PK, "PAYSTATE#youtube") or {}


def rows(deps: PayoutDeps) -> dict[str, dict[str, Any]]:
    return {r["sk"]: r for r in deps.store.query_all(PK, "PAYOUT#youtube#")}


def conn(deps: PayoutDeps) -> dict[str, Any]:
    return deps.store.get(PK, "PAYCONN#adsense") or {}


# --- the items ------------------------------------------------------------------------------------------------


def test_the_first_read_writes_the_items_with_the_publisher_suffix(deps: PayoutDeps, google: Google) -> None:
    seed(deps)
    assert adsense.run(deps, USER, NOW) == "read"
    found = rows(deps)
    # Only youtube-yyyy-MM-dd payments; two accounts paying on the same day stay two rows.
    assert sorted(found) == [
        "PAYOUT#youtube#2026-09-22#4444",
        "PAYOUT#youtube#2026-10-23#4444",
        "PAYOUT#youtube#2026-10-23#8888",
    ]
    row = found["PAYOUT#youtube#2026-10-23#4444"]
    assert {k: v for k, v in row.items() if k not in {"pk", "sk"}} == {
        "type": "payout",
        "place": "youtube",
        "by": "google",
        "source": "adsense.payments",
        "account": "4444",
        "date": "2026-10-23",
        "amountText": "kr\u00a01\u00a0234,56 SEK",  # as Google wrote it: never parsed, converted or added up here
        "state": "sent",
        "fetchedAt": iso(NOW),
    }
    assert found["PAYOUT#youtube#2026-10-23#8888"]["amountText"] == "€87.65"
    got = state(deps)
    assert got["type"] == "paystate"
    assert got["place"] == "youtube"
    assert got["source"] == "adsense"
    assert got["firstReadDone"] is True
    assert got["lastCheckedAt"] == iso(NOW)
    assert "lastError" not in got
    assert got["accounts"] == [
        {"name": A1, "displayName": "Main AdSense", "state": "READY", "pendingTasks": []},
        {"name": A2, "displayName": "Old AdSense", "state": "READY", "pendingTasks": []},
    ]
    assert got["holds"] == [
        {
            "type": "payment-hold",
            "severity": "SEVERE",
            "text": "Your payments are on hold & can't be sent. See Payments.",
            "since": iso(NOW),
        }
    ]
    assert got["holdSince"] == iso(NOW)
    assert got["alerts"] == [{"type": "ads-txt-unauthorized", "severity": "WARNING", "text": "Fix ads.txt"}]
    assert got["unpaid"] == {"text": "SEK 512.30"}  # "Waiting to be paid", never in a total
    assert got["lastSent"] == {"sk": "PAYOUT#youtube#2026-10-23#8888", "date": "2026-10-23", "text": "€87.65"}
    # No publisher id beyond its last 4 on any row; the full name stays only on the stored account list.
    assert all("pub-" not in json.dumps(r) for r in found.values())


def test_at_most_five_adsense_calls_a_run(deps: PayoutDeps, google: Google) -> None:
    google.accounts.insert(0, {"name": "accounts/pub-0000000000000001", "displayName": "Closed", "state": "CLOSED"})
    seed(deps)
    assert adsense.run(deps, USER, NOW) == "read"
    # The open accounts first; the closed one doesn't fit.
    assert google.api_calls == [
        f"{API}/accounts?pageSize=5",
        f"{API}/{A1}/alerts?languageCode=en",
        f"{API}/{A1}/payments",
        f"{API}/{A2}/alerts?languageCode=en",
        f"{API}/{A2}/payments",
    ]
    assert google.token_forms == []  # the token was fresh: no refresh
    assert [a["state"] for a in state(deps)["accounts"]] == ["CLOSED", "READY", "READY"]


def test_a_closed_account_is_read_when_there_is_room(deps: PayoutDeps, google: Google) -> None:
    google.accounts[1]["state"] = "CLOSED"
    seed(deps)
    assert adsense.run(deps, USER, NOW) == "read"
    assert len(google.api_calls) == 5
    assert "PAYOUT#youtube#2026-10-23#8888" in rows(deps)  # the closed account's old payment still counts


def test_no_hold_is_never_said_for_an_account_that_wasnt_read(deps: PayoutDeps, google: Google) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    kept = state(deps)
    # A third open account: alerts for all three don't fit in 5 calls, so there is no verdict at all.
    google.accounts.append({"name": A3, "displayName": "Third", "state": "READY"})
    google.alerts[A1] = []
    google.calls.clear()
    assert adsense.run(deps, USER, NOW + timedelta(days=1)) == "error"
    assert google.api_calls == [f"{API}/accounts?pageSize=5"]
    got = state(deps)
    assert got["lastError"] == payouts.GOOGLE_TOO_MANY
    assert {k: v for k, v in got.items() if k != "lastError"} == kept  # the old hold stays, not a fresh "no hold"


def test_a_refusal_after_the_list_never_reads_past_five_calls(deps: PayoutDeps, google: Google) -> None:
    seed(deps)
    google.fail[f"{A2}/payments"] = response(401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}})
    assert adsense.run(deps, USER, NOW) == "error"
    assert len(google.api_calls) == 5
    assert google.token_forms == []  # only a refusal of the first call is worth a refresh
    assert state(deps)["lastError"] == payouts.GOOGLE_REFUSED


def test_a_changed_amount_sets_revised_at_and_a_vanished_payment_is_gone(
    deps: PayoutDeps, google: Google, clock: Clock
) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    later = NOW + timedelta(days=1)
    clock.now = later
    google.payments[A1] = [
        {"name": f"{A1}/payments/youtube-2026-10-23", "amount": "kr\u00a01\u00a0230,00 SEK"},
        {"name": f"{A1}/payments/youtube-2026-11-21", "amount": "kr 700,00 SEK"},
    ]
    before = len(deps.store.query_all(PK, ""))
    adsense.run(deps, USER, later)
    found = rows(deps)
    revised = found["PAYOUT#youtube#2026-10-23#4444"]
    assert revised["amountText"] == "kr\u00a01\u00a0230,00 SEK"
    assert revised["revisedAt"] == iso(later)
    gone = found["PAYOUT#youtube#2026-09-22#4444"]
    assert gone["state"] == "gone"
    assert gone["goneAt"] == iso(later)
    assert gone["amountText"] == "kr 980,00 SEK"
    assert found["PAYOUT#youtube#2026-10-23#8888"]["state"] == "sent"  # the other account still lists it
    assert len(deps.store.query_all(PK, "")) == before + 1  # one new row; nothing deleted
    assert state(deps)["lastSent"]["sk"] == "PAYOUT#youtube#2026-11-21#4444"
    # A payment that comes back is sent again.
    google.payments[A1].append({"name": f"{A1}/payments/youtube-2026-09-22", "amount": "kr 980,00 SEK"})
    adsense.run(deps, USER, later)
    back = rows(deps)["PAYOUT#youtube#2026-09-22#4444"]
    assert back["state"] == "sent"
    assert "goneAt" not in back
    assert "revisedAt" not in back


def test_an_unchanged_payment_is_not_written_again(deps: PayoutDeps, table: StreamTable) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    table.stream.clear()
    adsense.run(deps, USER, NOW + timedelta(days=1))
    assert [new["sk"] for _, _, new in table.stream] == ["PAYSTATE#youtube"]


def test_a_hold_keeps_its_first_day_and_ends(deps: PayoutDeps, google: Google) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    adsense.run(deps, USER, NOW + timedelta(days=1))
    got = state(deps)
    assert got["holdSince"] == iso(NOW)
    assert got["holds"][0]["since"] == iso(NOW)
    google.alerts[A1] = []
    adsense.run(deps, USER, NOW + timedelta(days=2))
    got = state(deps)
    assert got["holds"] == []
    assert "holdSince" not in got


# --- failures keep everything -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "text"),
    [
        (response(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}), payouts.GOOGLE_DOWN),
        (response(503, {"error": {"code": 503}}), payouts.GOOGLE_DOWN),
        (NetworkError("timeout"), payouts.GOOGLE_DOWN),
        (
            response(403, {"error": {"code": 403, "errors": [{"reason": "accessNotConfigured"}]}}),
            payouts.GOOGLE_API_OFF,
        ),
        (
            response(403, {"error": {"code": 403, "details": [{"reason": "SERVICE_DISABLED"}]}}),
            payouts.GOOGLE_API_OFF,
        ),
        (response(403, {"error": {"code": 403, "status": "PERMISSION_DENIED"}}), payouts.GOOGLE_REFUSED),
    ],
)
def test_a_failed_read_only_sets_last_error(deps: PayoutDeps, google: Google, answer: Any, text: str) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    kept_rows, kept = rows(deps), state(deps)
    google.fail[f"{A2}/payments"] = answer
    later = NOW + timedelta(days=1)
    assert adsense.run(deps, USER, later) == "error"
    got = state(deps)
    assert got["lastError"] == text
    assert {k: v for k, v in got.items() if k != "lastError"} == kept  # holds, lastCheckedAt, lastSent all kept
    assert rows(deps) == kept_rows
    # The next good read clears it.
    google.fail.clear()
    adsense.run(deps, USER, later)
    assert "lastError" not in state(deps)


def test_no_account_is_an_error_not_an_empty_state(deps: PayoutDeps, google: Google) -> None:
    google.accounts = []
    seed(deps)
    assert adsense.run(deps, USER, NOW) == "error"
    got = state(deps)
    assert got["lastError"] == payouts.GOOGLE_NO_ACCOUNT
    assert "accounts" not in got
    assert "firstReadDone" not in got


# --- the token ------------------------------------------------------------------------------------------------


def test_a_due_token_is_refreshed_with_the_youtube_keys_and_written_put_only(
    deps: PayoutDeps, google: Google, client: FakeSecretsManager
) -> None:
    seed(deps, expires_in=timedelta(minutes=2))
    assert adsense.run(deps, USER, NOW) == "read"
    assert google.token_forms == [
        {
            "grant_type": ["refresh_token"],
            "client_id": [CLIENT],
            "client_secret": ["GOCSPX-secret"],
            "refresh_token": ["rt_0"],
        }
    ]
    assert all(c.headers["Authorization"] == "Bearer at_1" for c in google.calls if c.url != GOOGLE_TOKEN)
    secret = client.json(TOKEN_NAME)
    assert secret["accessToken"] == "at_1"
    assert secret["refreshToken"] == "rt_0"
    assert secret["clientId"] == CLIENT
    assert secret["accounts"] == [A1]
    assert ("create", TOKEN_NAME) not in client.writes[2:]
    assert client.writes[-1] == ("put", TOKEN_NAME)


def _refuse_the_first_list(deps: PayoutDeps, google: Google) -> None:
    first = {"done": False}
    original = google.__call__

    def refuse_once(request: HttpRequest) -> HttpResponse:
        if not first["done"] and request.url.endswith("/accounts?pageSize=5"):
            first["done"] = True
            google.calls.append(request)
            return response(401, {"error": {"code": 401, "status": "UNAUTHENTICATED"}})
        return original(request)

    deps.http = refuse_once


def test_a_refused_token_is_refreshed_once_then_read_again(deps: PayoutDeps, google: Google) -> None:
    google.accounts = google.accounts[:1]
    seed(deps)
    _refuse_the_first_list(deps, google)
    assert adsense.run(deps, USER, NOW) == "read"
    assert len(google.token_forms) == 1
    assert len(google.api_calls) == 4  # the refused list counts: 1 + 1 + 2


def test_after_a_refresh_two_open_accounts_wait_for_the_next_run(deps: PayoutDeps, google: Google) -> None:
    seed(deps)
    _refuse_the_first_list(deps, google)
    assert adsense.run(deps, USER, NOW) == "error"  # 2 + 2 + 2 would be 6 calls
    assert len(google.api_calls) == 2
    assert state(deps)["lastError"] == payouts.CHECK_FAILED
    assert rows(deps) == {}
    google.calls.clear()
    deps.http = google
    assert adsense.run(deps, USER, NOW + timedelta(days=1)) == "read"  # the refreshed token: room for both
    assert len(google.api_calls) == 5


def test_invalid_grant_needs_a_reconnect_and_deletes_nothing(
    deps: PayoutDeps, google: Google, client: FakeSecretsManager
) -> None:
    seed(deps, expires_in=timedelta(seconds=10))
    google.tokens = [
        response(400, {"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
    ]
    assert adsense.run(deps, USER, NOW) == "token_dead"
    got = conn(deps)
    assert (got["status"], got["reason"]) == ("needs_reconnect", "token_dead")
    assert TOKEN_NAME in client.values  # nothing deleted
    assert google.api_calls == []
    # Not connected any more: the next run reads nothing.
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert len(google.calls) == 1


def test_a_changed_youtube_key_needs_a_reconnect_without_asking_google(deps: PayoutDeps, google: Google) -> None:
    seed(deps, expires_in=timedelta(seconds=10), client_id="old-app.apps.googleusercontent.com")
    assert adsense.run(deps, USER, NOW) == "keys_changed"
    assert (conn(deps)["status"], conn(deps)["reason"]) == ("needs_reconnect", "keys_changed")
    assert google.calls == []


@pytest.mark.parametrize(
    "answer",
    [response(401, {"error": "invalid_client"}), response(400, {"error": "unauthorized_client"})],
)
def test_google_refusing_the_key_needs_a_reconnect(deps: PayoutDeps, google: Google, answer: HttpResponse) -> None:
    seed(deps, expires_in=timedelta(seconds=10))
    google.tokens = [answer]
    assert adsense.run(deps, USER, NOW) == "keys_changed"
    assert (conn(deps)["status"], conn(deps)["reason"]) == ("needs_reconnect", "keys_changed")


def test_google_down_on_refresh_waits_for_the_next_run(deps: PayoutDeps, google: Google) -> None:
    seed(deps, expires_in=timedelta(seconds=10))
    google.tokens = [response(503, {"error": "backendError"})]
    assert adsense.run(deps, USER, NOW) == "error"
    assert conn(deps)["status"] == "connected"
    assert state(deps)["lastError"] == payouts.GOOGLE_DOWN


def test_a_stop_during_the_refresh_is_never_undone(
    deps: PayoutDeps, google: Google, client: FakeSecretsManager, table: StreamTable
) -> None:
    seed(deps, expires_in=timedelta(seconds=10))

    def stop_meanwhile(request: HttpRequest) -> HttpResponse:
        if request.url == GOOGLE_TOKEN:
            client.delete_secret(SecretId=TOKEN_NAME, ForceDeleteWithoutRecovery=True)
        return google(request)

    deps.http = stop_meanwhile
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert TOKEN_NAME not in client.values  # never re-created
    assert table.raw(PK, "PAYSTATE#youtube") is None


def test_another_allow_during_the_refresh_keeps_the_new_grant(
    deps: PayoutDeps, google: Google, client: FakeSecretsManager
) -> None:
    seed(deps, expires_in=timedelta(seconds=10))
    new = {
        "accessToken": "at_new",
        "expiresAt": iso(NOW + timedelta(hours=1)),
        "refreshToken": "rt_new",
        "scope": SCOPE,
        "clientId": CLIENT,
        "accounts": [A3],
    }

    def allow_again_meanwhile(request: HttpRequest) -> HttpResponse:
        if request.url == GOOGLE_TOKEN:
            # Stop, then Allow payment reading with another Google account, while the old refresh is in flight.
            deps.secrets.write(TOKEN_NAME, new, platform="adsense")
            deps.store.update(PK, "PAYCONN#adsense", {"updatedAt": iso(NOW + timedelta(seconds=1))})
        return google(request)

    deps.http = allow_again_meanwhile
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert client.json(TOKEN_NAME) == new  # never the old grant's token over the new one
    assert google.api_calls == []  # and nothing read with the old grant


def test_a_new_secret_alone_also_wins(deps: PayoutDeps, google: Google, client: FakeSecretsManager) -> None:
    seed(deps, expires_in=timedelta(seconds=10))

    def secret_first(request: HttpRequest) -> HttpResponse:
        if request.url == GOOGLE_TOKEN:  # the new grant wrote its secret, its PAYCONN# write is still to come
            deps.secrets.write(TOKEN_NAME, {**client.json(TOKEN_NAME), "refreshToken": "rt_new"}, platform="adsense")
        return google(request)

    deps.http = secret_first
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert client.json(TOKEN_NAME)["refreshToken"] == "rt_new"
    assert client.json(TOKEN_NAME)["accessToken"] == "at_0"


@pytest.mark.parametrize("status", ["not_connected", "needs_reconnect", "keys_saved"])
def test_nothing_is_read_unless_connected(deps: PayoutDeps, google: Google, status: str) -> None:
    seed(deps, status=status)
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert google.calls == []


def test_without_payment_reading_nothing_happens(deps: PayoutDeps, google: Google, table: StreamTable) -> None:
    assert adsense.run(deps, USER, NOW) == "not_connected"
    assert google.calls == []
    assert table.stream == []


# --- quiet first reads ----------------------------------------------------------------------------------------


def test_a_new_grant_starts_quiet(deps: PayoutDeps, google: Google, table: StreamTable, clock: Clock) -> None:
    seed(deps)
    adsense.run(deps, USER, NOW)
    assert state(deps)["grantMark"] == payouts.grant_mark(conn(deps), "adsense")
    # Stop, then allow again: a new grant. Its first read removes firstReadDone first, then sets it at its end.
    later = NOW + timedelta(days=9)
    deps.store.update(PK, "PAYCONN#adsense", {"status": "connected", "updatedAt": iso(later)})
    google.payments[A1].append({"name": f"{A1}/payments/youtube-2026-11-21", "amount": "kr 700,00 SEK"})
    table.stream.clear()
    adsense.run(deps, USER, later)
    paystate = [(old, new) for _, old, new in table.stream if new["sk"] == "PAYSTATE#youtube"]
    assert [bool((old or {}).get("firstReadDone")) for old, _ in paystate] == [True, False]
    assert [bool(new.get("firstReadDone")) for _, new in paystate] == [False, True]


# --- the API builder's golden items -------------------------------------------------------------------------------


def _golden_entries() -> list[dict[str, Any]]:
    """The API builder's ``getpaid_items.json``: one entry per item kind (``sk``, ``skPattern``, ``attributes``,
    ``example`` and the shared values). Only the entries themselves are read, never the example's values (its
    ``lastSent`` has an ``sk`` too)."""
    data = json.loads(GOLDEN.read_text())
    entries = data.get("items") if isinstance(data, dict) else data
    assert isinstance(entries, list)
    return [e for e in entries if isinstance(e, dict) and isinstance(e.get("sk"), str)]


ITEM_ATTRS = {
    "PAYSTATE#youtube": payouts.PAYSTATE_YOUTUBE_ATTRS,
    "PAYSTATE#contentrewards": payouts.PAYSTATE_WHOP_ATTRS,
    "PAYOUT#youtube#": payouts.PAYOUT_YOUTUBE_ATTRS,
    "PAYOUT#contentrewards#": payouts.PAYOUT_WHOP_ATTRS,
}
KEYS = {"pk", "sk", "userId", "ttl"}
# What the collector reads on PAYCONN# (the API builder writes it): each must be one of its attributes.
PAYCONN_READS = {
    "PAYCONN#adsense": {"status", "connectedAt", "updatedAt"},
    "PAYCONN#whop": {"status", "connectedAt", "accountId", "tokenVersionId", "refreshLeaseUntil"},
}


@pytest.mark.skipif(not GOLDEN.exists(), reason="getpaid_items.json arrives with the API builder's part (§40.8)")
def test_the_items_match_the_api_builders_golden_file() -> None:
    entries = {e["sk"]: e for e in _golden_entries()}
    checked: set[str] = set()
    for sk, entry in entries.items():
        for prefix, allowed in ITEM_ATTRS.items():
            if sk == prefix or (prefix.endswith("#") and sk.startswith(prefix)):
                example = entry.get("example") if isinstance(entry.get("example"), dict) else {}
                read = set(entry.get("attributes") or []) | set(example)
                extra = read - allowed - KEYS
                assert not extra, f"{sk}: the API reads attributes the collector never writes: {extra}"
                checked.add(prefix)
    assert checked == set(ITEM_ATTRS)

    def entry(prefix: str) -> dict[str, Any]:
        return next(e for sk, e in entries.items() if sk.startswith(prefix))

    # The sort keys the collector writes match the API builder's patterns.
    assert re.match(entry("PAYOUT#youtube#")["skPattern"], payouts.youtube_payout_sk("2026-10-23", "3456"))
    assert re.match(entry("PAYOUT#youtube#")["skPattern"], payouts.youtube_payout_sk("2026-10-23", adsense.last4(A1)))
    assert re.match(entry("PAYOUT#contentrewards#")["skPattern"], payouts.whop_payout_sk("2026-11-10", "po_3"))
    assert re.match(entry("PAYSTATE#youtube")["skPattern"], payouts.paystate_sk("youtube"))
    assert re.match(entry("PAYSTATE#contentrewards")["skPattern"], payouts.paystate_sk("contentrewards"))
    # The shared values, word for word.
    whop_state = entry("PAYSTATE#contentrewards")
    assert set(whop_state["holdKinds"]) == set(payouts.HOLD_KINDS)
    assert set(whop_state["kyc"]) == payouts.KYC | {"unknown"}
    assert entry("PAYOUT#contentrewards#")["statusToState"] == payouts.WHOP_STATES
    assert {"sent", "gone"} <= set(entry("PAYOUT#youtube#")["states"])
    for sk, reads in PAYCONN_READS.items():
        if sk in entries:
            assert reads <= set(entries[sk].get("attributes") or []) | KEYS, sk
            assert {"connected", "needs_reconnect"} <= set(entries[sk].get("statuses") or [])
            assert {"token_dead", "keys_changed"} <= set(entries[sk].get("reasons") or [])
