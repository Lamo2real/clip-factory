"""The bank key, the app ID and the owner (docs/CONTRACTS.md §40.5.1, §40.5.4, tests §40.5.13 "api (BA)": keys).

Owner rules: the private key and ``hashKey`` live only in Secrets Manager (never DynamoDB, a log line, a response or
the browser); Enable Banking's free use is for one private person, so anyone but ``BANKOWNER`` gets 403; a new key or
app ID never breaks a bank link that still has a session.
"""

from __future__ import annotations

import base64
import json
from datetime import timedelta

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from bank_cases import APP_ID, APPLICATION, LINK_A, FakeBank, forget_caches, link, setup_bank, use_quick_keys
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.bank import keys
from conftest import NOW, OTHER, USER, Call
from fakes import FakeSecretsManager, FakeTable

SECRET = "cf-prod/platforms/bank/app"
PK = db.user_pk(USER)


@pytest.fixture
def bank(app: App) -> FakeBank:
    forget_caches()
    return setup_bank(app).on("GET", "/application", (200, APPLICATION))


@pytest.fixture
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    use_quick_keys(monkeypatch)


def pem_of(key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def test_make_my_bank_key_makes_an_rsa_4096_pair_and_a_ten_year_certificate(
    call: Call,
    app: App,
    bank: FakeBank,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status, body = call("POST", "/v1/getpaid/bank/key", {})
    assert status == 200
    saved = secrets_client.json(SECRET)
    assert set(saved) == {"privateKeyPem", "publicKeyPem", "certificatePem", "hashKey", "appId", "source", "keyMadeAt"}
    assert saved["privateKeyPem"].startswith("-----BEGIN PRIVATE KEY-----")  # PKCS#8
    assert saved["publicKeyPem"].startswith("-----BEGIN PUBLIC KEY-----")  # SPKI
    assert saved["appId"] is None
    assert saved["source"] == "clipfactory"
    assert len(base64.b64decode(saved["hashKey"])) == 32
    private = serialization.load_pem_private_key(saved["privateKeyPem"].encode(), password=None)
    assert isinstance(private, rsa.RSAPrivateKey)
    assert private.key_size == 4096
    assert private.public_key().public_numbers().e == 65537
    cert = x509.load_pem_x509_certificate(saved["certificatePem"].encode())
    assert cert.subject.rfc4514_string() == "CN=Clip Factory"
    assert cert.issuer == cert.subject
    assert isinstance(cert.signature_hash_algorithm, hashes.SHA256)
    life = cert.not_valid_after_utc - cert.not_valid_before_utc
    assert timedelta(days=3650) <= life <= timedelta(days=3653)  # 10 years
    assert cert.public_key().public_numbers() == private.public_key().public_numbers()
    assert secrets_client.tags[SECRET] == [{"Key": "app", "Value": "cf-prod"}, {"Key": "platform", "Value": "bank"}]
    conn = app.store.get(PK, "BANKCONN")
    assert conn is not None
    assert conn["app"] == {"status": "key_made", "source": "clipfactory", "keyMadeAt": "2026-11-15T12:00:00.000Z"}
    assert app.store.get("BANKOWNER", "BANKOWNER") == {
        "pk": "BANKOWNER",
        "sk": "BANKOWNER",
        "type": "bankowner",
        "userId": USER,
        "claimedAt": "2026-11-15T12:00:00.000Z",
    }
    # Only the public half ever leaves Secrets Manager.
    assert body["key"]["publicKeyPem"] == saved["publicKeyPem"]
    assert body["key"]["certificatePem"] == saved["certificatePem"]
    text = json.dumps(body) + json.dumps(table.all(), default=str) + capsys.readouterr().out
    assert "PRIVATE KEY" not in text
    assert saved["hashKey"] not in text


def test_a_second_tap_changes_nothing_and_again_keeps_hash_key(
    call: Call,
    app: App,
    bank: FakeBank,
    secrets_client: FakeSecretsManager,
    quick: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    first = secrets_client.json(SECRET)
    assert call("POST", "/v1/getpaid/bank/key", {})[0] == 200
    assert secrets_client.json(SECRET) == first
    assert call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})[0] == 200
    assert app.store.get(PK, "BANKCONN")["app"]["check"]["code"] == "ok"  # type: ignore[index]
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(keys, "_generate", lambda: other)
    for step in ("bank-account", "bank-app", "bank-details"):
        assert call("PATCH", "/v1/getpaid/bank/steps", {"step": step, "done": True})[0] == 200
    status, body = call("POST", "/v1/getpaid/bank/key", {"again": True})
    assert status == 200
    again = secrets_client.json(SECRET)
    assert again["hashKey"] == first["hashKey"]  # so depositIds never change
    assert again["privateKeyPem"] != first["privateKeyPem"]
    assert again["appId"] is None
    app_state = app.store.get(PK, "BANKCONN")["app"]  # type: ignore[index]
    assert app_state["status"] == "key_made"
    assert "check" not in app_state
    assert "appIdHint" not in app_state
    assert app.store.get(PK, "BANKCONN")["stepsDone"] == ["bank-account"]  # type: ignore[index]
    assert body["next"]["stepId"] == "bank-app"  # a new app with the new public key
    assert {s["id"]: s["done"] for s in body["steps"]}["bank-appid"] is False


@pytest.mark.parametrize(
    "stored",
    [
        link(),
        link(status="ended"),
        link(status="stopped", stoppedAt=NOW.isoformat(), closePending=True),
    ],
    ids=["connected", "ended", "stopped but its session isn't closed yet"],
)
def test_again_a_new_app_id_or_a_pem_wait_while_a_link_has_a_session(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager, quick: None, stored: dict[str, object]
) -> None:
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    assert call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})[0] == 200
    app.store.put({"pk": PK, "sk": f"BANKLINK#{LINK_A}", **stored})
    before = secrets_client.json(SECRET)
    status, body = call("POST", "/v1/getpaid/bank/key", {"again": True})
    assert (status, body["error"]["message"]) == (409, "Stop reading every bank first.")
    status, body = call("PUT", "/v1/getpaid/bank/app", {"appId": "11111111-2222-4333-8444-555555555555"})
    assert (status, body["error"]["message"]) == (409, "Stop reading every bank first.")
    pem = pem_of(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    status, body = call("PUT", "/v1/getpaid/bank/app", {"pem": pem, "appId": APP_ID})
    assert (status, body["error"]["message"]) == (409, "Stop reading every bank first.")
    assert secrets_client.json(SECRET) == before
    calls = len(bank.calls)
    status, body = call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID.upper()})  # the same app ID: the check only
    assert status == 200
    assert body["check"]["code"] == "ok"
    assert len(bank.calls) == calls + 1
    assert bank.calls[-1]["path"] == "/application"
    assert secrets_client.json(SECRET) == before


def test_a_stopped_link_without_a_session_lets_a_new_key_through(
    call: Call, app: App, bank: FakeBank, quick: None
) -> None:
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    app.store.put(
        {"pk": PK, "sk": f"BANKLINK#{LINK_A}", **link(status="stopped", stoppedAt="2026-11-14T10:00:00.000Z")}
    )
    assert call("POST", "/v1/getpaid/bank/key", {"again": True})[0] == 200


def test_save_the_app_id(call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager, quick: None) -> None:
    status, body = call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID})
    assert (status, body["error"]["message"]) == (409, "Tap Make my bank key first.")
    assert call("POST", "/v1/getpaid/bank/key")[0] == 200
    for bad in ("0f6e1d2c3b4a4c5d8e9fa0b1c2d3e4f5", "not an id", 12, "0f6e1d2c-3b4a-4c5d-8e9f-a0b1c2d3e4fZ"):
        status, body = call("PUT", "/v1/getpaid/bank/app", {"appId": bad})
        assert (status, body["error"]["message"]) == (400, "Your app ID has 36 letters and numbers with dashes.")
    status, body = call("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID.upper()})
    assert status == 200
    assert secrets_client.json(SECRET)["appId"] == APP_ID  # lower-cased
    assert body["check"] == {
        "code": "ok",
        "text": "Enable Banking knows Clip Factory, and your app is active.",
        "at": "2026-11-15T12:00:00.000Z",
    }
    app_state = app.store.get(PK, "BANKCONN")["app"]  # type: ignore[index]
    assert app_state["status"] == "saved"
    assert app_state["appIdHint"] == "0f6e1d2c…"
    assert app_state["savedAt"] == "2026-11-15T12:00:00.000Z"
    assert APP_ID not in json.dumps(body)  # only the hint


def test_the_pem_path(
    call: Call,
    app: App,
    bank: FakeBank,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    capsys: pytest.CaptureFixture[str],
) -> None:
    own = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = pem_of(own)
    app.store.update_expr(
        PK, "BANKCONN", "SET #s = :s", names={"#s": "stepsDone"}, values={":s": {"pem-deleted", "bank-account"}}
    )
    status, body = call("PUT", "/v1/getpaid/bank/app", {"pem": pem, "fileName": "notes.pem"})
    assert (status, body["error"]["message"]) == (400, "Paste the app ID too.")
    status, body = call("PUT", "/v1/getpaid/bank/app", {"pem": pem, "fileName": f"{APP_ID.upper()} (2).pem"})
    assert status == 200
    saved = secrets_client.json(SECRET)
    assert saved["appId"] == APP_ID
    assert saved["source"] == "file"
    assert saved["privateKeyPem"].strip() == pem.strip()
    loaded = serialization.load_pem_private_key(saved["privateKeyPem"].encode(), password=None)
    assert loaded.public_key().public_numbers() == own.public_key().public_numbers()  # type: ignore[union-attr]
    cert = x509.load_pem_x509_certificate(saved["certificatePem"].encode())
    assert cert.public_key().public_numbers() == own.public_key().public_numbers()  # type: ignore[union-attr]
    hash_key = saved["hashKey"]
    conn = app.store.get(PK, "BANKCONN")
    assert conn is not None
    assert conn["app"]["source"] == "file"
    assert conn["app"]["status"] == "saved"
    assert conn["stepsDone"] == ["bank-account"]  # "I deleted it" asks again for the new file
    assert body["view"]["key"]["pemReminder"] is True
    assert body["check"]["code"] == "ok"
    assert app.store.get("BANKOWNER", "BANKOWNER")["userId"] == USER  # type: ignore[index]
    second = pem_of(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    assert call("PUT", "/v1/getpaid/bank/app", {"pem": second, "appId": APP_ID})[0] == 200
    assert secrets_client.json(SECRET)["hashKey"] == hash_key  # kept
    text = json.dumps(body) + json.dumps(table.all(), default=str) + capsys.readouterr().out
    body_lines = pem.strip().splitlines()[1]
    assert "PRIVATE KEY" not in text
    assert body_lines not in text


@pytest.mark.parametrize(
    "pem",
    [
        "",
        "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
        "-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n",
        "-----BEGIN PRIVATE KEY-----\n" + "A" * 9000 + "\n-----END PRIVATE KEY-----\n",
        pem_of(rsa.generate_private_key(public_exponent=65537, key_size=1024)),  # noqa: S505 (the key it refuses)
        pem_of(ec.generate_private_key(ec.SECP256R1())),
    ],
    ids=["empty", "PKCS#1", "garbage", "over 8 KB", "1024-bit", "not RSA"],
)
def test_a_pem_that_is_not_enable_bankings_key_file(
    call: Call, app: App, bank: FakeBank, secrets_client: FakeSecretsManager, pem: str
) -> None:
    status, body = call("PUT", "/v1/getpaid/bank/app", {"pem": pem, "appId": APP_ID})
    assert status == 400
    assert body["error"]["message"] == (
        "That isn't Enable Banking's key file. It ends in .pem and starts with BEGIN PRIVATE KEY."
    )
    assert SECRET not in secrets_client.values


def test_the_file_name_rule() -> None:
    assert keys.FILE_NAME.match(f"{APP_ID}.pem")
    assert keys.FILE_NAME.match(f"{APP_ID} (3).pem")
    assert not keys.FILE_NAME.match(f"{APP_ID}.pem.txt")
    assert not keys.FILE_NAME.match(f"Downloads/{APP_ID}.pem")


def test_only_the_owner(call: Call, app: App, bank: FakeBank, quick: None) -> None:
    assert call("POST", "/v1/getpaid/bank/key", sub=USER)[0] == 200
    message = "Your bank is only for the owner of this Clip Factory."
    for method, path, payload in (
        ("POST", "/v1/getpaid/bank/key", {}),
        ("GET", "/v1/getpaid/bank", None),
        ("PUT", "/v1/getpaid/bank/app", {"appId": APP_ID}),
        ("PUT", "/v1/getpaid/bank/app", {"pem": "x", "appId": APP_ID}),
        ("POST", "/v1/getpaid/bank/app/check", None),
        ("PATCH", "/v1/getpaid/bank/steps", {"step": "bank-ask", "done": True}),
        ("GET", "/v1/getpaid/bank/banks", None),
        ("POST", "/v1/getpaid/bank/connect", {"bank": "Swedbank"}),
        ("POST", "/v1/getpaid/bank/check", {}),
        ("PATCH", f"/v1/getpaid/bank/deposits/{'a' * 32}", {"answer": "not_sure"}),
        ("DELETE", f"/v1/getpaid/bank/links/{LINK_A}", None),
        ("DELETE", "/v1/getpaid/bank", None),
    ):
        status, body = call(method, path, payload, sub=OTHER)
        assert (status, body["error"]["code"], body["error"]["message"]) == (403, "forbidden", message), path
    assert app.store.get(db.user_pk(OTHER), "BANKCONN") is None
