"""/v1/getpaid/bank (docs/CONTRACTS.md §40.5.10, tests §40.5.13 "api (BA)": routes).

The switch (``BANK_READING`` off: ``{"on": false}`` and 503 "Coming soon."), the owner, Check now (409 with no
connected bank, once every 15 minutes, 12 a day, the first read once per link) and its ``bank_check`` payload (his IP
address, User-Agent and language go to Enable Banking for that one read: never stored, never logged), Stop with
Enable Banking up and down, closing old sessions on the next GET, Forget (his records gone, the app key kept, a 409
while a read holds the lease) and no secret, session id, uid, hash, ``payerKey`` or IP address in any answer.

Owner rule: additive only. Stop keeps every payment it found; only "Forget my bank" (his own tap) removes them.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from bank_cases import (
    APP_ID,
    APPLICATION,
    LINK_A,
    LINK_B,
    FakeBank,
    dep,
    forget_caches,
    link,
    setup_bank,
    use_quick_keys,
)
from clipfactory_api import db, money
from clipfactory_api.app import App
from clipfactory_api.http import dispatch
from clipfactory_api.platforms.base import NetworkError
from clipfactory_api.routes import ROUTES
from conftest import OTHER, USER, Call, Clock, make_event
from fakes import FakeLambda, FakeSecretsManager, FakeTable

PK = db.user_pk(USER)
TOKEN = "cf-prod/platforms/bank/token_"
APP_SECRET = "cf-prod/platforms/bank/app"
IP = "203.0.113.77"
UA = "Mozilla/5.0 (Macintosh; FakeBrowser) " + "x" * 600
LANG = "sv-SE,sv;q=0.9,en;q=0.8"


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    use_quick_keys(monkeypatch)
    forget_caches()


@pytest.fixture
def bank(app: App) -> FakeBank:
    return setup_bank(app).on("GET", "/application", (200, APPLICATION))


def ready(call: Call) -> None:
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    assert call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})[0] == 200


def seed_link(
    app: App,
    secrets_client: FakeSecretsManager,
    link_id: str = LINK_A,
    *,
    close_later: tuple[str, ...] = (),
    **extra: Any,
) -> dict[str, Any]:
    item = link(link_id, **extra)
    app.store.put({"pk": PK, "sk": f"BANKLINK#{link_id}", **item})
    secrets_client.values[TOKEN + link_id] = json.dumps(
        {
            "sessionId": f"sess-{link_id}",
            "accounts": [{"uid": "uid-1", "idHash": "idhash-1"}],
            "validUntil": item["consentUntil"],
            "bank": item["bank"],
            "country": "SE",
            "connectedAt": item["connectedAt"],
            "closeLater": list(close_later),
        }
    )
    return item


def check(app: App, body: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    event = make_event("POST", "/v1/getpaid/bank/check", body or {})
    event["headers"].update(headers or {"user-agent": UA, "accept-language": LANG})
    event["requestContext"]["http"]["sourceIp"] = IP
    out = dispatch(event, app, ROUTES)
    return out["statusCode"], json.loads(out["body"]) if out["body"] else None


# --- the switch, the env, the owner ---------------------------------------------------------------------------------

EVERY_OTHER = [
    ("DELETE", "/v1/getpaid/bank", None),
    ("POST", "/v1/getpaid/bank/key", {}),
    ("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID}),
    ("POST", "/v1/getpaid/bank/app/check", None),
    ("PATCH", "/v1/getpaid/bank/steps", {"step": "bank-ask", "done": True}),
    ("GET", "/v1/getpaid/bank/banks", None),
    ("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"}),
    ("POST", "/v1/getpaid/bank/check", {}),
    ("PATCH", f"/v1/getpaid/bank/deposits/{'a' * 32}", {"answer": "yes"}),
    ("DELETE", f"/v1/getpaid/bank/links/{LINK_A}", None),
]


def test_while_the_switch_is_off(call: Call, app: App, table: FakeTable) -> None:
    assert app.bank_reading is False  # the default
    assert call("GET", "/v1/getpaid/bank") == (200, {"on": False})
    for method, path, payload in EVERY_OTHER:
        status, body = call(method, path, payload)
        assert (status, body["error"]["code"], body["error"]["message"]) == (503, "unavailable", "Coming soon."), path
    assert table.all() == []
    assert call("GET", "/v1/getpaid/youtube")[0] == 200  # "bank" never reads as a place, and places still work


def test_without_the_oauth_env(call: Call, app: App, bank: FakeBank) -> None:
    app.oauth = None
    for method, path, payload in [("GET", "/v1/getpaid/bank", None), *EVERY_OTHER]:
        status, body = call(method, path, payload)
        assert (status, body["error"]["message"]) == (503, "Posting setup is not switched on for this app yet."), path


def test_get_registers_the_owner_for_the_daily_run(call: Call, app: App, bank: FakeBank) -> None:
    status, body = call("GET", "/v1/getpaid/bank")
    assert status == 200
    assert body["on"] is True
    assert body["status"] == "not_started"
    assert app.store.get(money.OWNERS_PK, money.owner_sk(USER)) is not None
    assert bank.calls == []  # stored items only


def test_another_user_gets_403(call: Call, app: App, bank: FakeBank) -> None:
    ready(call)
    status, body = call("GET", "/v1/getpaid/bank", sub=OTHER)
    assert (status, body["error"]["message"]) == (403, "Your bank is only for the owner of this Clip Factory.")


def test_his_green_answers(call: Call, app: App, bank: FakeBank) -> None:
    for step in ("bank-ask", "bank-account", "bank-app", "bank-details", "pem-deleted"):
        assert call("PATCH", "/v1/getpaid/bank/steps", {"step": step, "done": True})[0] == 200
    status, body = call("PATCH", "/v1/getpaid/bank/steps", {"step": "bank-app", "done": False})
    assert status == 200
    assert {s["id"]: s["by"] for s in body["steps"]}["bank-app"] is None
    assert app.store.get(PK, "BANKCONN")["stepsDone"] == [  # type: ignore[index]
        "bank-account",
        "bank-ask",
        "bank-details",
        "pem-deleted",
    ]
    for step in ("bank-key", "bank-appid", "bank-link", "bank-connect"):
        status, body = call("PATCH", "/v1/getpaid/bank/steps", {"step": step, "done": True})
        assert (status, body["error"]["message"]) == (400, "Clip Factory ticks that one itself."), step
    status, body = call("PATCH", "/v1/getpaid/bank/steps", {"step": "yt-tax", "done": True})
    assert (status, body["error"]["message"]) == (400, "That step is not known.")


# --- Check now ------------------------------------------------------------------------------------------------------


def test_check_now_needs_a_connected_bank(
    app: App, bank: FakeBank, secrets_client: FakeSecretsManager, call: Call
) -> None:
    status, body = check(app)
    assert (status, body["error"]["message"]) == (409, "Connect your bank first.")
    seed_link(app, secrets_client, status="stopped", stoppedAt="2026-11-14T00:00:00.000Z")
    assert check(app)[0] == 409


def test_check_now_sends_psu_for_that_one_read_and_never_keeps_it(
    app: App,
    bank: FakeBank,
    lambda_client: FakeLambda,
    secrets_client: FakeSecretsManager,
    table: FakeTable,
    capsys: pytest.CaptureFixture[str],
) -> None:
    seed_link(app, secrets_client)
    capsys.readouterr()
    status, body = check(app)
    assert status == 202
    assert body["on"] is True
    (invoke,) = lambda_client.calls
    assert invoke["FunctionName"].endswith(":function:cf-prod-money")
    assert invoke["InvocationType"] == "Event"
    assert invoke["payload"] == {
        "action": "bank",
        "userId": USER,
        "first": False,
        "psu": {"ip": IP, "ua": UA[:512], "lang": LANG},
        "at": "2026-11-15T12:00:00.000Z",
    }
    logs = capsys.readouterr().out
    stored = json.dumps(table.all(), default=str)
    for private in (IP, UA[:40], LANG):
        assert private not in logs
        assert private not in stored
        assert private not in json.dumps(body)
    conn = app.store.get(PK, "BANKCONN")
    assert conn is not None
    assert conn["lastManualAt"] == "2026-11-15T12:00:00.000Z"
    assert conn["manual"] == {"day": "2026-11-15", "n": 1}
    assert body["nextCheckAllowedAt"] == "2026-11-15T12:15:00.000Z"


def test_check_now_once_every_15_minutes_and_12_a_day(
    app: App, bank: FakeBank, clock: Clock, lambda_client: FakeLambda, secrets_client: FakeSecretsManager
) -> None:
    seed_link(app, secrets_client)
    assert check(app)[0] == 202
    clock.now += timedelta(minutes=14)
    status, body = check(app)
    assert (status, body["error"]["code"], body["error"]["message"]) == (
        429,
        "rate_limited",
        "Clip Factory checked a moment ago.",
    )
    assert body["error"]["retryAt"] == "2026-11-15T12:15:00.000Z"
    for _ in range(11):
        clock.now += timedelta(minutes=15)
        assert check(app)[0] == 202
    clock.now += timedelta(minutes=15)
    status, body = check(app)
    assert status == 429
    assert body["error"]["retryAt"] == "2026-11-16T00:00:00.000Z"
    assert len(lambda_client.calls) == 12
    clock.now = clock.now.replace(day=16, hour=0, minute=1)
    assert check(app)[0] == 202  # a new UTC day


def test_the_first_read_passes_once_per_link(
    app: App, bank: FakeBank, clock: Clock, lambda_client: FakeLambda, secrets_client: FakeSecretsManager
) -> None:
    seed_link(app, secrets_client)
    seed_link(app, secrets_client, LINK_B, bank="PayPal", first_read=False, connected="2026-11-15T11:58:00.000Z")
    assert check(app)[0] == 202  # his own Check now
    status, _ = check(app, {"first": True})  # passes the 15 minutes anyway
    assert status == 202
    assert lambda_client.calls[-1]["payload"]["first"] is True
    assert app.store.get(PK, f"BANKLINK#{LINK_B}")["firstReadStartedAt"] == "2026-11-15T12:00:00.000Z"  # type: ignore[index]
    status, _ = check(app, {"first": True})
    assert status == 202
    assert len(lambda_client.calls) == 2


def test_a_failed_invoke_gives_the_claim_back(
    app: App, bank: FakeBank, lambda_client: FakeLambda, secrets_client: FakeSecretsManager
) -> None:
    seed_link(app, secrets_client)
    lambda_client.fail = True
    status, body = check(app)
    assert (status, body["error"]["message"]) == (503, "Could not start the check. Try again in a minute.")
    conn = app.store.get(PK, "BANKCONN") or {}
    assert "lastManualAt" not in conn
    assert "manual" not in conn
    lambda_client.fail = False
    assert check(app)[0] == 202


# --- Stop, closing, Forget ------------------------------------------------------------------------------------------


def test_stop_with_enable_banking_up(call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager) -> None:
    ready(call)
    seed_link(app, secrets_client, close_later=("sess-old-1",))
    app.store.put({"pk": PK, **dep("matched", "2026-10-28", 123456, place="youtube", how="you")})
    bank.on("DELETE", "/sessions/", (200, {"message": "OK"}))
    assert call("DELETE", f"/v1/getpaid/bank/links/{LINK_A}") == (204, None)
    assert sorted(bank.paths("DELETE")) == ["/sessions/sess-a1b2c3d4e5f6", "/sessions/sess-old-1"]
    assert TOKEN + LINK_A not in secrets_client.values
    found = app.store.get(PK, f"BANKLINK#{LINK_A}")
    assert found is not None
    assert found["status"] == "stopped"
    assert found["stoppedAt"] == "2026-11-15T12:00:00.000Z"
    assert "closePending" not in found
    assert len(app.store.query_all(PK, "DEPOSIT#")) == 1  # every payment it found stays
    _, body = call("GET", "/v1/getpaid/bank")
    assert body["links"][0]["line"] == "You stopped reading Swedbank on 15 Nov. The money it found stays here."
    assert call("DELETE", "/v1/getpaid/bank/links/0f0f0f0f0f0f")[0] == 404
    assert call("DELETE", "/v1/getpaid/bank/links/not-a-link")[0] == 404


def test_stop_with_enable_banking_down_is_closed_by_the_next_get(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager
) -> None:
    ready(call)
    seed_link(app, secrets_client)
    bank.on("DELETE", "/sessions/", (503, {"error": "ASPSP_ERROR"}))
    assert call("DELETE", f"/v1/getpaid/bank/links/{LINK_A}")[0] == 204
    found = app.store.get(PK, f"BANKLINK#{LINK_A}")
    assert found is not None
    assert found["status"] == "stopped"
    assert found["closePending"] is True
    assert TOKEN + LINK_A in secrets_client.values  # kept until Enable Banking closes it
    bank.on("DELETE", "/sessions/", (404, {"error": "SESSION_DOES_NOT_EXIST"}))  # gone already counts as closed
    status, body = call("GET", "/v1/getpaid/bank")
    assert status == 200
    assert TOKEN + LINK_A not in secrets_client.values
    assert "closePending" not in (app.store.get(PK, f"BANKLINK#{LINK_A}") or {})
    assert body["status"] == "stopped"


def test_get_closes_old_sessions_of_a_reconnected_link_in_at_most_5_seconds(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager
) -> None:
    ready(call)
    seed_link(app, secrets_client, closePending=True, close_later=("sess-old-1", "sess-old-2"))
    bank.on("DELETE", "/sessions/sess-old-1", (200, {}, 1))
    bank.on("DELETE", "/sessions/sess-old-2", (200, {}, 30))
    start = bank.mono.t
    assert call("GET", "/v1/getpaid/bank")[0] == 200
    assert bank.mono.t - start <= 5
    assert [c["timeout"] for c in bank.calls[-2:]] == [5, pytest.approx(4)]  # what was left of the 5 s
    assert (app.store.get(PK, f"BANKLINK#{LINK_A}") or {})["closePending"] is True  # one failed: nothing changes
    bank.on("DELETE", "/sessions/sess-old-2", (200, {}))
    assert call("GET", "/v1/getpaid/bank")[0] == 200
    secret = secrets_client.json(TOKEN + LINK_A)
    assert secret["closeLater"] == []
    assert secret["sessionId"] == f"sess-{LINK_A}"
    assert "closePending" not in (app.store.get(PK, f"BANKLINK#{LINK_A}") or {})


def test_forget_my_bank(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager, table: FakeTable
) -> None:
    ready(call)
    seed_link(app, secrets_client)
    seed_link(app, secrets_client, LINK_B, bank="PayPal")
    app.store.put({"pk": PK, **dep("matched", "2026-10-28", 123456, place="youtube", how="you")})
    app.store.put({"pk": PK, **dep("needs_you", "2026-11-12", 9000, suggested="x", hint="stripe")})
    app.store.put({"pk": PK, "sk": "BANKPAYERS", "type": "bankpayers", "rules": {"k" * 32: {"place": "x"}}})
    app.store.put({"pk": PK, "sk": "CLIP#keep", "type": "clip"})  # nothing else of his is touched
    key_before = secrets_client.json(APP_SECRET)
    bank.on("DELETE", f"/sessions/sess-{LINK_A}", (200, {}))
    bank.on("DELETE", f"/sessions/sess-{LINK_B}", NetworkError("down"))
    assert call("DELETE", "/v1/getpaid/bank") == (204, None)
    assert app.store.query_all(PK, "DEPOSIT#") == []
    assert app.store.get(PK, "BANKPAYERS") is None
    assert app.store.get(PK, f"BANKLINK#{LINK_A}") is None
    assert TOKEN + LINK_A not in secrets_client.values
    bare = app.store.get(PK, f"BANKLINK#{LINK_B}")
    assert bare is not None
    assert set(bare) == {"pk", "sk", "type", "linkId", "bank", "status", "stoppedAt", "closePending"}
    assert TOKEN + LINK_B in secrets_client.values  # until its close works
    assert secrets_client.json(APP_SECRET) == key_before  # the app key and the app ID stay
    conn = app.store.get(PK, "BANKCONN") or {}
    assert conn["app"]["status"] == "saved"
    assert conn["forgottenAt"] == "2026-11-15T12:00:00.000Z"
    assert "readLease" not in conn
    assert "lastConnect" not in conn
    assert app.store.get(PK, "CLIP#keep") is not None
    _, body = call("GET", "/v1/getpaid/bank")  # Enable Banking answers now: the bare link goes too
    assert app.store.get(PK, f"BANKLINK#{LINK_B}") is not None  # still down
    bank.on("DELETE", f"/sessions/sess-{LINK_B}", (200, {}))
    _, body = call("GET", "/v1/getpaid/bank")
    assert app.store.get(PK, f"BANKLINK#{LINK_B}") is None
    assert TOKEN + LINK_B not in secrets_client.values
    assert body["links"] == []
    assert body["next"]["stepId"] == "bank-connect"


def test_forget_waits_while_a_read_holds_the_lease(
    call: Call, app: App, bank: FakeBank, clock: Clock, secrets_client: FakeSecretsManager
) -> None:
    ready(call)
    seed_link(app, secrets_client)
    until = (clock.now + timedelta(seconds=200)).isoformat().replace("+00:00", "Z")
    app.store.update_expr(PK, "BANKCONN", "SET #l = :l", names={"#l": "readLease"}, values={":l": {"until": until}})
    status, body = call("DELETE", "/v1/getpaid/bank")
    assert (status, body["error"]["message"]) == (409, "Clip Factory is reading your bank. Try again in a minute.")
    assert app.store.get(PK, f"BANKLINK#{LINK_A}")["status"] == "connected"  # type: ignore[index]
    clock.now += timedelta(seconds=301)  # an expired lease is free
    bank.on("DELETE", "/sessions/", (200, {}))
    assert call("DELETE", "/v1/getpaid/bank")[0] == 204


def test_no_answer_carries_a_secret(call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager) -> None:
    ready(call)
    seed_link(app, secrets_client)
    app.store.put(
        {
            "pk": PK,
            **dep("needs_you", "2026-11-12", 9000, suggested="x", hint="stripe", payerKey="p" * 32, hintFrom="payer"),
        }
    )
    app.store.put({"pk": PK, **dep("matched", "2026-11-02", 9000, place="x", how="you", payerKey="q" * 32)})
    secret = secrets_client.json(APP_SECRET)
    answers = [call("GET", "/v1/getpaid/bank")[1], call("POST", "/v1/getpaid/bank/app/check")[1]]
    text = json.dumps(answers)
    for private in (
        secret["privateKeyPem"].splitlines()[1],
        secret["hashKey"],
        APP_ID,
        f"sess-{LINK_A}",
        "uid-1",
        "idhash-1",
        "p" * 32,
        "q" * 32,
        "psu-ip-address",
        "Bearer",
    ):
        assert private not in text, private
