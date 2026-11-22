"""Enable Banking's setup calls (docs/CONTRACTS.md §40.5.4, tests §40.5.13 "api (BA)": eb).

The JWT, the one host, every check code, a ``down`` that never replaces the stored check, fresh secret reads, the
deadline shares (a slow Enable Banking never pushes a route past 25 s) and typed errors: an answer full of IBANs and
names leaves nothing in any log line, ``http.internal`` included. Offline: a fake Enable Banking, no network.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from bank_cases import (
    APP_ID,
    APPLICATION,
    ASPSPS,
    LEAKS,
    LEAKY_ERROR,
    REDIRECT,
    FakeBank,
    eb_error,
    forget_caches,
    quick_key,
    setup_bank,
    use_quick_keys,
)
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.bank import CHECK_TEXT, eb, grants, keys
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError
from conftest import USER, Call
from fakes import FakeSecretsManager

PK = db.user_pk(USER)
SECRET = "cf-prod/platforms/bank/app"


@pytest.fixture(autouse=True)
def _quick(monkeypatch: pytest.MonkeyPatch) -> None:
    use_quick_keys(monkeypatch)
    forget_caches()


@pytest.fixture
def bank(app: App) -> FakeBank:
    return setup_bank(app)


def ready(call: Call, bank: FakeBank, application: Any = None) -> None:
    bank.on("GET", "/application", (200, application or APPLICATION))
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    assert call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})[0] == 200


def unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def test_the_jwt() -> None:
    material = keys.material(quick_key(), datetime(2026, 11, 15, 12, tzinfo=UTC))
    now = datetime(2026, 11, 22, 12, 0, 7, tzinfo=UTC)
    token = eb.jwt(material["privateKeyPem"], APP_ID, now)
    header, body, signature = token.split(".")
    assert "=" not in token  # base64url without padding
    assert json.loads(unb64(header)) == {"typ": "JWT", "alg": "RS256", "kid": APP_ID}
    iat = int(now.timestamp())
    assert json.loads(unb64(body)) == {
        "iss": "enablebanking.com",
        "aud": "api.enablebanking.com",
        "iat": iat,
        "exp": iat + 3600,
    }
    quick_key().public_key().verify(
        unb64(signature), f"{header}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256()
    )  # raises when it doesn't verify


def test_every_call_goes_to_api_enablebanking_com_only(call: Call, bank: FakeBank) -> None:
    ready(call, bank)
    for c in bank.calls:
        assert c["headers"]["Accept"] == "application/json"
        assert c["headers"]["Authorization"].startswith("Bearer ey")
    with pytest.raises(NetworkError):
        eb.urllib_transport(HttpRequest("GET", "https://api.tilisy.com/application"), 5)
    with pytest.raises(NetworkError):
        eb.urllib_transport(HttpRequest("GET", "http://api.enablebanking.com/application"), 5)
    assert eb.EB_HOST == "https://api.enablebanking.com"


@pytest.mark.parametrize(
    ("answer", "code"),
    [
        ((200, APPLICATION), "ok"),
        ((200, {**APPLICATION, "active": False}), "not_active"),
        ((200, {**APPLICATION, "redirect_urls": [REDIRECT + "/"]}), "redirect_missing"),
        ((200, {**APPLICATION, "redirect_urls": []}), "redirect_missing"),
        ((200, {**APPLICATION, "environment": "SANDBOX"}), "sandbox"),
        ((401, {"error": "UNAUTHORIZED_ACCESS"}), "key_wrong"),
        (eb_error("UNAUTHORIZED_ACCESS", 400), "key_wrong"),
        ((403, {"error": "ACCESS_DENIED"}), "not_found"),
        ((404, {"error": "NOT_FOUND"}), "not_found"),
        (eb_error("APPLICATION_NOT_FOUND", 400), "not_found"),
        ((500, {"error": "INTERNAL"}), "down"),
        ((429, {"error": "RATE_LIMIT"}), "down"),
        (NetworkError("timeout"), "down"),
        ((200, b"<html>"), "down"),
    ],
)
def test_every_check_code(call: Call, app: App, bank: FakeBank, answer: Any, code: str) -> None:
    ready(call, bank)
    bank.on("GET", "/application", answer)
    status, body = call("POST", "/v1/getpaid/bank/app/check")
    assert status == 200
    assert body["check"] == {"code": code, "text": CHECK_TEXT[code], "at": "2026-11-15T12:00:00.000Z"}
    stored = app.store.get(PK, "BANKCONN")["app"]  # type: ignore[index]
    if code == "down":  # a passing outage never un-ticks a step
        assert stored["check"]["code"] == "ok"
        assert stored["downAt"] == "2026-11-15T12:00:00.000Z"
        assert {s["id"]: s["done"] for s in body["view"]["steps"]}["bank-appid"] is True
    else:
        assert stored["check"] == {"code": code, "at": "2026-11-15T12:00:00.000Z"}


def test_the_check_sentences_word_for_word() -> None:
    assert CHECK_TEXT == {
        "ok": "Enable Banking knows Clip Factory, and your app is active.",
        "not_active": "Saved. Next: link your bank accounts (step 6).",
        "redirect_missing": (
            "Paste the return address in **Allowed redirect URLs (one per line)**. On your app tap ⋮, then **Edit**, "
            "then **Save**."
        ),
        "sandbox": (
            "That's a Sandbox app. Do steps 3 and 4 again, and tap **Production** first. Then paste the new app ID "
            "here."
        ),
        "key_wrong": (
            "Enable Banking doesn't know this key. Do steps 3 and 4 again to make a new app. Then paste its app ID "
            "here."
        ),
        "not_found": "Enable Banking doesn't know that app ID. Copy it again.",
        "down": "Enable Banking didn't answer. Try again in a few minutes.",
    }


def test_the_app_secret_is_read_fresh_every_time(
    call: Call, bank: FakeBank, secrets_client: FakeSecretsManager
) -> None:
    ready(call, bank)
    before = sum(1 for op, name in secrets_client.calls if op == "get" and name == SECRET)
    for _ in range(3):
        assert call("POST", "/v1/getpaid/bank/app/check")[0] == 200
    after = sum(1 for op, name in secrets_client.calls if op == "get" and name == SECRET)
    assert after - before >= 3  # never the 5-minute cache


def test_the_deadline_shares() -> None:
    from bank_cases import Mono

    mono = Mono()
    deadline = eb.Deadline(25, mono)
    assert deadline.share() == 10
    assert deadline.share(15) == 15
    mono.t += 14
    assert deadline.share(15) == pytest.approx(8)
    mono.t += 8
    assert deadline.share() == pytest.approx(0)
    inner = eb.Deadline(25, mono).sub(5)
    assert inner.share() == pytest.approx(5)  # at most 5 s, and never past the outer margin
    assert eb.Deadline(6, mono).sub(5).share() == pytest.approx(3)


def test_a_slow_enable_banking_never_pushes_a_route_past_25_seconds(call: Call, app: App, bank: FakeBank) -> None:
    ready(call, bank)
    app.store.update_expr(PK, "MONEYPREFS", "SET #c = :c", names={"#c": "country"}, values={":c": "SE"})
    app.store.update_expr(  # the stored check isn't ok: Connect runs it again first
        PK, "BANKCONN", "SET #a.#c = :c", names={"#a": "app", "#c": "check"}, values={":c": {"code": "down"}}
    )
    forget_caches()
    bank.on("GET", "/application", (200, APPLICATION, 9))
    bank.on("GET", "/aspsps", (200, ASPSPS, 9))
    bank.on("POST", "/auth", (200, {"url": "https://x"}, 60))
    start = bank.mono.t
    status, body = call("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"})
    assert bank.mono.t - start <= 25
    assert (status, body["error"]["message"]) == (503, "Enable Banking didn't answer. Try again in a few minutes.")
    assert [c["timeout"] for c in bank.calls[-3:]] == [10, 10, pytest.approx(4)]  # min(10 s, remaining - 3 s)


def test_a_call_with_less_than_a_second_left_is_never_made() -> None:
    from bank_cases import Mono

    mono = Mono()
    fake = FakeBank(mono)
    env = eb.BankEnv(secrets=None, app_url="", hooks_url="", state_key=lambda: b"", http=fake, monotonic=mono)  # type: ignore[arg-type]
    key = eb.AppKey(keys.material(quick_key(), datetime(2026, 1, 1, tzinfo=UTC))["privateKeyPem"], APP_ID)
    deadline = eb.Deadline(3.5, mono)
    with pytest.raises(eb.Skipped):
        eb.call(env, key, "GET", "/application", deadline)
    assert fake.calls == []
    assert eb.delete_session(env, key, "sess-1", deadline) is False  # best effort: skipped, never raised


def test_bank_errors_are_typed_and_carry_no_answer_body(
    call: Call, app: App, bank: FakeBank, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = json.dumps(LEAKY_ERROR).encode()
    with pytest.raises(eb.EbError) as caught:
        eb.ok_json(HttpResponse(422, {}, raw))
    assert str(caught.value) == "Enable Banking answered 422 WRONG_REQUEST_PARAMETERS"
    assert (caught.value.status, caught.value.code) == (422, "WRONG_REQUEST_PARAMETERS")
    ready(call, bank)
    app.store.update_expr(PK, "MONEYPREFS", "SET #c = :c", names={"#c": "country"}, values={":c": "SE"})
    bank.on("GET", "/aspsps", (422, LEAKY_ERROR))
    capsys.readouterr()
    status, _ = call("GET", "/v1/getpaid/bank/banks")
    assert status == 503
    bank.on("GET", "/application", (422, LEAKY_ERROR))
    assert call("POST", "/v1/getpaid/bank/app/check")[0] == 200

    def boom(*_args: object, **_kwargs: object) -> None:
        eb.ok_json(HttpResponse(422, {}, raw))  # an error nobody caught: http.internal logs str(e)

    monkeypatch.setattr(grants, "banks", boom)
    status, _ = call("GET", "/v1/getpaid/bank/banks")
    assert status == 500
    logs = capsys.readouterr().out
    assert "http.internal" in logs
    assert "WRONG_REQUEST_PARAMETERS" in logs
    for leak in LEAKS:
        assert leak not in logs, leak
