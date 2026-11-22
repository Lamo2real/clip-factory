"""The bank list, Connect and the BankID callback (docs/CONTRACTS.md §40.5.5, tests §40.5.13 "api (BA)": grants,
banks).

Owner rules: Clip Factory never asks for a bank login (BankID happens on Enable Banking's and the bank's own pages);
only his own personal accounts are read (business ``ORGA`` accounts are dropped before anything is kept); the session
lives only in Secrets Manager; names, IBANs and addresses from Enable Banking's answer appear in no item, secret, log
line or redirect.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from bank_cases import (
    APP_ID,
    APPLICATION,
    ASPSPS,
    AUTH,
    LEAKS,
    LINK_A,
    SESSION,
    FakeBank,
    come_back,
    eb_error,
    forget_caches,
    hooks_deps,
    link,
    setup_bank,
    use_quick_keys,
)
from clipfactory_api import db, hooks
from clipfactory_api.app import App
from clipfactory_api.bank import CHECK_TEXT
from clipfactory_api.platforms.base import NetworkError
from conftest import APP_URL, NOW, USER, Call, Clock
from fakes import FakeSecretsManager, FakeTable

PK = db.user_pk(USER)
TOKEN = "cf-prod/platforms/bank/token_"


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    use_quick_keys(monkeypatch)
    forget_caches()


@pytest.fixture
def bank(app: App) -> FakeBank:
    return setup_bank(app)


def ready(call: Call, app: App, bank: FakeBank, *, country: str | None = "SE", application: Any = None) -> None:
    bank.on("GET", "/application", (200, application or APPLICATION))
    bank.on("GET", "/aspsps", (200, ASPSPS))
    bank.on("POST", "/auth", (200, AUTH))
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    assert call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})[0] == 200
    if country:
        app.store.update_expr(PK, "MONEYPREFS", "SET #c = :c", names={"#c": "country"}, values={":c": country})


def start(call: Call, bank: FakeBank, payload: dict[str, Any] | None = None) -> str:
    """Taps a bank in Pick your bank; returns the state Enable Banking would send back."""
    status, body = call("POST", "/v1/getpaid/bank/connect", payload or {"bank": "Swedbank"})
    assert status == 200, body
    assert body["authorizeUrl"] == AUTH["url"]
    return str(bank.calls[-1]["body"]["state"])


def secret_of(secrets_client: FakeSecretsManager, link_id: str = LINK_A) -> Any:
    return secrets_client.json(TOKEN + link_id)


def the_link(app: App) -> dict[str, Any]:
    found = app.store.query_all(PK, "BANKLINK#")
    assert len(found) == 1
    return found[0]


# --- Connect --------------------------------------------------------------------------------------------------------


def test_connect_sends_a_personal_auth_with_a_capped_link(
    call: Call, app: App, bank: FakeBank, table: FakeTable
) -> None:
    ready(call, app, bank)
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert status == 200
    assert body == {"authorizeUrl": AUTH["url"], "expiresAt": "2026-11-15T12:10:00.000Z"}
    auth = bank.calls[-1]
    assert (auth["method"], auth["path"]) == ("POST", "/auth")
    sent = auth["body"]
    assert set(sent) == {"access", "aspsp", "state", "redirect_url", "psu_type"}  # no credentials, no auth_method
    assert sent["psu_type"] == "personal"
    assert sent["aspsp"] == {"name": "Swedbank", "country": "SE"}
    assert sent["redirect_url"] == f"{app.oauth.hooks_url}/oauth/bank/callback"  # type: ignore[union-attr]
    assert sent["access"] == {
        "valid_until": "2027-05-14T11:50:00+00:00",  # 180 days - 10 minutes, RFC 3339 with an offset
        "balances": False,
        "transactions_extended_history": True,  # a new link
    }
    states = [i for i in table.all() if i["pk"].startswith("OAUTH#")]
    assert len(states) == 1
    saved = states[0]
    assert saved["platform"] == "bank"
    assert saved["userId"] == USER
    assert saved["reconnect"] is False
    assert saved["bank"] == "Swedbank"
    assert saved["country"] == "SE"
    assert saved["maxDays"] == 180
    assert saved["psuHeaders"] == ["psu-ip-address", "psu-user-agent"]
    assert saved["history"] is True
    assert len(saved["linkId"]) == 12
    assert saved["ttl"] == int(NOW.timestamp()) + 600 + 300


@pytest.mark.parametrize(("bank_name", "until"), [("PayPal", "2027-02-13T11:50:00+00:00")])
def test_a_shorter_bank_gets_its_own_length(call: Call, app: App, bank: FakeBank, bank_name: str, until: str) -> None:
    ready(call, app, bank)
    start(call, bank, {"bank": bank_name})
    assert bank.calls[-1]["body"]["access"]["valid_until"] == until  # 90 days - 10 minutes


def test_a_longer_bank_is_capped_at_180_days(call: Call, app: App, bank: FakeBank) -> None:
    long = {"aspsps": [{**ASPSPS["aspsps"][0], "maximum_consent_validity": 730 * 86400}]}
    ready(call, app, bank)
    bank.on("GET", "/aspsps", (200, long))
    start(call, bank)
    assert bank.calls[-1]["body"]["access"]["valid_until"] == "2027-05-14T11:50:00+00:00"


def test_connect_refusals(call: Call, app: App, bank: FakeBank) -> None:
    bank.on("GET", "/application", (200, APPLICATION))
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert (status, body["error"]["message"]) == (409, "Do the steps above first.")
    ready(call, app, bank)
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Nordea Fake"})
    assert (status, body["error"]["message"]) == (400, "Pick a bank from the list.")
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Företagsbanken"})  # business only
    assert (status, body["error"]["message"]) == (400, "Pick a bank from the list.")
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank", "linkId": LINK_A})
    assert status == 400
    for i in range(4):
        app.store.put({"pk": PK, "sk": f"BANKLINK#{i:012d}", **link(f"{i:012d}")})
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert (status, body["error"]["message"]) == (409, "You can add up to 4 banks.")
    start(call, bank, {"linkId": f"{0:012d}"})  # a reconnect is no fifth bank


def test_connect_runs_the_check_again_when_it_isnt_ok(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank, application={**APPLICATION, "active": False})
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert (status, body["error"]["message"]) == (409, CHECK_TEXT["not_active"])
    bank.on("GET", "/application", (200, APPLICATION))
    start(call, bank)
    assert app.store.get(PK, "BANKCONN")["app"]["check"]["code"] == "ok"  # type: ignore[index]
    paths = bank.paths()
    assert paths[-3:] == ["/application", "/aspsps?country=SE&psu_type=personal&service=AIS", "/auth"]


@pytest.mark.parametrize(
    ("answer", "status", "message"),
    [
        (eb_error("REDIRECT_URI_NOT_ALLOWED"), 409, CHECK_TEXT["redirect_missing"]),
        (eb_error("WRONG_ASPSP_PROVIDED"), 400, "Pick a bank from the list."),
        (eb_error("UNAUTHORIZED_ACCESS", 401), 409, CHECK_TEXT["key_wrong"]),
        (eb_error("ASPSP_ERROR", 500), 503, CHECK_TEXT["down"]),
        (NetworkError("timeout"), 503, CHECK_TEXT["down"]),
        ((200, {"url": "http://not-https.example"}), 503, CHECK_TEXT["down"]),
    ],
)
def test_auth_errors(call: Call, app: App, bank: FakeBank, answer: Any, status: int, message: str) -> None:
    ready(call, app, bank)
    bank.on("POST", "/auth", answer)
    found, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert (found, body["error"]["message"]) == (status, message)
    check = app.store.get(PK, "BANKCONN")["app"]["check"]["code"]  # type: ignore[index]
    assert check == ("redirect_missing" if "redirect" in message.lower() else "ok")


# --- the bank list --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("mine", "countries", "expect"),
    [
        ("SE", ["SE", "FI"], (200, "SE")),
        ("SE", [], (200, "SE")),
        (None, ["FI"], (200, "FI")),
        ("SE", ["FI", "NO"], (409, "Enable Banking's app has no account from Sweden yet. Link one in step 6 first.")),
        (None, ["FI", "NO"], (409, "Pick your country in Money settings first.")),
    ],
    ids=["his country is in the app's", "the app has none", "exactly one", "not linked", "none"],
)
def test_the_five_country_cases(
    call: Call, app: App, bank: FakeBank, mine: str | None, countries: list[str], expect: tuple[int, str]
) -> None:
    ready(call, app, bank, country=mine, application={**APPLICATION, "countries": countries})
    status, body = call("GET", "/v1/getpaid/bank/banks")
    assert status == expect[0]
    if status == 200:
        assert body["country"] == expect[1]
        assert body["banks"] == [
            {"name": "Avanza Bank", "maxDays": 90, "beta": True},
            {"name": "PayPal", "maxDays": 90, "beta": False},
            {"name": "Swedbank", "maxDays": 180, "beta": False},
        ]  # personal only, A to Z; never the PSU headers
        assert bank.calls[-1]["path"] == f"/aspsps?country={expect[1]}&psu_type=personal&service=AIS"
    else:
        assert body["error"]["message"] == expect[1]
        assert body["error"]["code"] == ("country_not_linked" if mine else "no_country")


def test_the_list_is_kept_for_an_hour(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank)
    assert call("GET", "/v1/getpaid/bank/banks")[0] == 200
    lists = len(bank.paths("GET"))
    assert call("GET", "/v1/getpaid/bank/banks")[0] == 200
    start(call, bank)  # Connect uses the same list
    assert len(bank.paths("GET")) == lists
    bank.mono.t += 3601
    assert call("GET", "/v1/getpaid/bank/banks")[0] == 200
    assert bank.paths("GET")[-1].startswith("/aspsps")


def test_a_name_missing_from_a_cached_list_reads_it_again(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank)
    assert call("GET", "/v1/getpaid/bank/banks")[0] == 200
    newer = {"aspsps": [*ASPSPS["aspsps"], {"name": "ICA Banken", "psu_types": ["personal"]}]}
    bank.on("GET", "/aspsps", (200, newer))
    start(call, bank, {"bank": "ICA Banken"})
    assert bank.calls[-1]["body"]["access"]["valid_until"] == "2027-02-13T11:50:00+00:00"  # no length said: 90 days


def test_a_reconnect_whose_bank_left_the_list(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank)
    app.store.put({"pk": PK, "sk": f"BANKLINK#{LINK_A}", **link(bank="Gamla Banken")})
    status, body = call("POST", "/v1/getpaid/bank/connect", {"linkId": LINK_A})
    assert (status, body["error"]["message"]) == (
        409,
        "Gamla Banken isn't in Enable Banking's list now. Tap Connect your bank and pick it again.",
    )


# --- the callback ---------------------------------------------------------------------------------------------------


def test_connected(
    call: Call,
    app: App,
    bank: FakeBank,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    capsys: pytest.CaptureFixture[str],
) -> None:
    ready(call, app, bank)
    signed = start(call, bank)
    bank.on("POST", "/sessions", (200, SESSION))
    capsys.readouterr()
    deps = hooks_deps(app, bank)
    assert come_back(deps, {"code": "AUTH-CODE-1", "state": signed}) == "bank_connected"
    logs = capsys.readouterr().out
    found = the_link(app)
    link_id = found["linkId"]
    secret = secret_of(secrets_client, link_id)
    assert secret == {
        "sessionId": "sess-new-1",
        "accounts": [{"uid": "uid-priv-1", "idHash": "idhash-priv-1"}],  # the ORGA account was dropped
        "validUntil": "2027-05-21T11:50:00.000Z",
        "bank": "Swedbank",
        "country": "SE",
        "connectedAt": "2026-11-15T12:00:00.000Z",
        "closeLater": [],
    }
    assert secrets_client.tags[TOKEN + link_id] == [
        {"Key": "app", "Value": "cf-prod"},
        {"Key": "platform", "Value": "bank"},
    ]
    assert {k: v for k, v in found.items() if k not in {"pk", "sk"}} == {
        "type": "banklink",
        "linkId": link_id,
        "bank": "Swedbank",
        "country": "SE",
        "status": "connected",
        "consentUntil": "2027-05-21T11:50:00.000Z",
        "connectedAt": secret["connectedAt"],  # one `at` for the secret and the link
        "firstConnectedAt": "2026-11-15T12:00:00.000Z",
        "accountCount": 1,
        "psuHeaders": ["psu-ip-address", "psu-user-agent"],
        "historyWanted": True,
        "firstReadDone": False,
        "updatedAt": "2026-11-15T12:00:00.000Z",
    }
    assert bank.calls[-1]["body"] == {"code": "AUTH-CODE-1"}
    assert app.store.get(PK, "BANKCONN")["lastConnect"] == {  # type: ignore[index]
        "result": "bank_connected",
        "linkId": link_id,
        "bank": "Swedbank",
        "reconnect": False,
        "at": "2026-11-15T12:00:00.000Z",
    }
    assert not [i for i in table.all() if i["pk"].startswith("OAUTH#")]  # the state is used once
    everything = json.dumps(table.all(), default=str) + json.dumps(secrets_client.values) + logs
    for leak in LEAKS:
        assert leak not in everything, leak
    for private in ("AUTH-CODE-1", signed, "sess-new-1", "uid-priv-1", "idhash-priv-1"):
        assert private not in logs, private
    status, body = call("GET", "/v1/getpaid/bank")
    assert status == 200
    assert body["status"] == "checking"
    assert body["lastConnect"]["text"] == ("Clip Factory can see money coming into Swedbank now. It looks once a day.")
    for private in ("sess-new-1", "uid-priv-1", "idhash-priv-1", "psuHeaders"):
        assert private not in json.dumps(body)


def test_a_reused_or_bad_state_writes_nothing(
    call: Call, app: App, bank: FakeBank, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    ready(call, app, bank)
    signed = start(call, bank)
    bank.on("POST", "/sessions", (200, SESSION))
    deps = hooks_deps(app, bank)
    assert come_back(deps, {"code": "C", "state": signed}) == "bank_connected"
    before = (json.dumps(table.all(), default=str, sort_keys=True), dict(secrets_client.values))
    calls = len(bank.calls)
    assert come_back(deps, {"code": "C", "state": signed}) == "bank_expired"
    assert come_back(deps, {"code": "C", "state": "v1.forged.123.abc"}) == "bank_expired"
    assert come_back(deps, {"code": "C"}) == "bank_expired"
    assert (json.dumps(table.all(), default=str, sort_keys=True), dict(secrets_client.values)) == before
    assert len(bank.calls) == calls
    later = start(call, bank)
    clock.now += timedelta(minutes=11)
    assert come_back(deps, {"code": "C", "state": later}) == "bank_expired"


@pytest.mark.parametrize(
    ("query", "session", "result"),
    [
        ({"error": "access_denied", "error_description": "cancelled"}, None, "bank_denied"),
        ({"error": "server_error"}, None, "bank_error"),
        ({"code": "C"}, eb_error("NO_ACCOUNTS_ADDED", 422), "bank_no_accounts"),
        ({"code": "C"}, (200, {**SESSION, "accounts": []}), "bank_no_accounts"),
        ({"code": "C"}, (200, {**SESSION, "accounts": [SESSION["accounts"][1]]}), "bank_business_only"),
        ({"code": "C"}, eb_error("EXPIRED_AUTHORIZATION_CODE"), "bank_expired"),
        ({"code": "C"}, eb_error("WRONG_AUTHORIZATION_CODE"), "bank_expired"),
        ({"code": "C"}, eb_error("ALREADY_AUTHORIZED"), "bank_expired"),
        ({"code": "C"}, (401, {"error": "UNAUTHORIZED"}), "bank_key_wrong"),
        ({"code": "C"}, eb_error("UNAUTHORIZED_ACCESS"), "bank_key_wrong"),
        ({"code": "C"}, eb_error("ASPSP_ERROR", 500), "bank_error"),
        ({"code": "C"}, eb_error("SOMETHING_NEW"), "bank_error"),
        ({"code": "C"}, NetworkError("reset"), "bank_error"),
        ({"code": "C"}, (200, b"not json"), "bank_error"),
        ({}, None, "bank_error"),
    ],
)
def test_every_result_writes_last_connect_and_lands_on_bank_done(
    call: Call,
    app: App,
    bank: FakeBank,
    secrets_client: FakeSecretsManager,
    query: dict[str, str],
    session: Any,
    result: str,
) -> None:
    ready(call, app, bank)
    signed = start(call, bank)
    if session is not None:
        bank.on("POST", "/sessions", session)
    bank.on("DELETE", "/sessions/", (200, {"message": "OK"}))
    assert come_back(hooks_deps(app, bank), {**query, "state": signed}) == result
    last = app.store.get(PK, "BANKCONN")["lastConnect"]  # type: ignore[index]
    assert last["result"] == result
    assert last["bank"] == "Swedbank"
    assert last["reconnect"] is False
    assert app.store.query_all(PK, "BANKLINK#") == []
    assert not [n for n in secrets_client.values if n.startswith(TOKEN)]
    if result in {"bank_no_accounts", "bank_business_only"} and session[0] == 200:
        assert bank.paths("DELETE") == ["/sessions/sess-new-1"]  # the empty session is closed at once


def test_the_result_sentences_with_reconnect(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank)
    app.store.put({"pk": PK, "sk": f"BANKLINK#{LINK_A}", **link()})
    signed = start(call, bank, {"linkId": LINK_A})
    assert come_back(hooks_deps(app, bank), {"error": "access_denied", "state": signed}) == "bank_denied"
    _, body = call("GET", "/v1/getpaid/bank")
    assert body["lastConnect"] == {
        "result": "bank_denied",
        "text": "You stopped at the bank. Tap Reconnect Swedbank to try again.",
        "at": "2026-11-15T12:00:00.000Z",
    }


def test_a_reconnect_keeps_the_old_session_for_later_and_never_closes_it_itself(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager
) -> None:
    ready(call, app, bank)
    app.store.put(
        {
            "pk": PK,
            "sk": f"BANKLINK#{LINK_A}",
            **link(readThrough="2026-11-10", failingSince="2026-11-12T06:00:00.000Z"),
        }
    )
    secrets_client.values[TOKEN + LINK_A] = json.dumps(
        {"sessionId": "sess-old-2", "closeLater": ["sess-old-0", "sess-old-1"], "connectedAt": "x"}
    )
    signed = start(call, bank, {"linkId": LINK_A})
    assert bank.calls[-1]["body"]["access"]["transactions_extended_history"] is False  # read 5 days ago
    bank.on("POST", "/sessions", (200, SESSION))
    assert come_back(hooks_deps(app, bank), {"code": "C", "state": signed}) == "bank_connected"
    assert bank.paths("DELETE") == []  # the callback never closes the old one
    secret = secret_of(secrets_client)
    assert secret["closeLater"] == ["sess-old-0", "sess-old-1", "sess-old-2"]  # at most 3 ids
    found = the_link(app)
    assert found["closePending"] is True
    assert found["firstConnectedAt"] == "2026-11-01T09:00:00.000Z"
    assert found["firstReadDone"] is True
    assert "failingSince" not in found
    assert found["historyWanted"] is False
    assert app.store.get(PK, "BANKCONN")["lastConnect"]["reconnect"] is True  # type: ignore[index]


def test_slow_sessions_and_closes_still_give_a_302_inside_25_seconds(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, app, bank)
    signed = start(call, bank)
    bank.on("POST", "/sessions", (200, {**SESSION, "accounts": [SESSION["accounts"][1]]}, 14))
    bank.on("DELETE", "/sessions/", (200, {}, 60))
    begin = bank.mono.t
    assert come_back(hooks_deps(app, bank), {"code": "C", "state": signed}) == "bank_business_only"
    assert bank.mono.t - begin <= 25
    assert [c["timeout"] for c in bank.calls[-2:]] == [15, 8]  # min(15 s, ...), then min(10 s, remaining - 3 s)
    signed = start(call, bank)
    bank.on("POST", "/sessions", (200, SESSION, 60))
    begin = bank.mono.t
    assert come_back(hooks_deps(app, bank), {"code": "C", "state": signed}) == "bank_error"
    assert bank.mono.t - begin <= 25


def test_the_callback_without_secrets_still_lands_on_bank_done(app: App, bank: FakeBank) -> None:
    deps = hooks_deps(app, bank)
    deps.oauth = None
    assert come_back(deps, {"code": "C", "state": "S"}) == "bank_error"


def test_hooks_bank_is_404(app: App, bank: FakeBank, table: FakeTable) -> None:
    deps = hooks_deps(app, bank)
    for method in ("GET", "POST"):
        event = {
            "httpMethod": method,
            "resource": "/hooks/{platform}",
            "path": "/hooks/bank",
            "pathParameters": {"platform": "bank"},
            "headers": {},
            "body": "{}",
            "requestContext": {"requestId": "r", "stage": "v1"},
        }
        assert hooks.handle(event, deps)["statusCode"] == 404
    assert not [i for i in table.all() if i["pk"].startswith("HOOK#")]


def test_bank_done_is_a_fixed_page() -> None:
    from clipfactory_api.oauth import callback

    assert callback.location(APP_URL, "bank", "bank_connected") == f"{APP_URL}/bank-done?result=bank_connected"
    assert callback.location(APP_URL, "bank", "error") == f"{APP_URL}/bank-done?result=bank_error"
    assert callback.location(APP_URL + "/", "bank", "https://evil.example") == f"{APP_URL}/bank-done?result=bank_error"
    assert parse_qs(urlsplit(callback.location(APP_URL, "bank", "bank_denied")).query) == {"result": ["bank_denied"]}
