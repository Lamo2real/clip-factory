"""Your bank: Enable Banking's reading side (docs/CONTRACTS.md §40.5.4 "The JWT", §40.5.6, §40.5.13 "client").

The JWT signs with the app's own key and verifies with its public key; the PSU headers go all or none; at most 3
unattended reads happen in any rolling 24 hours (an unattended ``longest`` counts twice); Enable Banking's error codes,
never the HTTP status alone, decide what happens to a link; and an error never carries the answer's body.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from bankread_cases import APP_ID, APP_URL, FakeEnableBanking, World, network_down, private_key_pem, txn
from clipfactory_api.bankread import DOWN, KEY_WRONG, WAIT
from clipfactory_api.bankread import client as eb
from clipfactory_api.clock import iso
from clipfactory_api.platforms.base import HttpRequest, HttpResponse

NOW = datetime(2026, 11, 23, 6, 0, 0, tzinfo=UTC)


def unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


# --- the JWT ------------------------------------------------------------------------------------------------------


def test_the_jwt_header_body_and_signature() -> None:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    token = eb.jwt(APP_ID, private_key_pem(), NOW)
    head, body, signature = token.split(".")
    assert "=" not in token
    assert "+" not in token
    assert "/" not in token
    assert json.loads(unb64(head)) == {"typ": "JWT", "alg": "RS256", "kid": APP_ID}
    iat = int(NOW.timestamp())
    assert json.loads(unb64(body)) == {
        "iss": "enablebanking.com",
        "aud": "api.enablebanking.com",
        "iat": iat,
        "exp": iat + 3600,
    }
    key = serialization.load_pem_private_key(private_key_pem().encode(), password=None)
    assert isinstance(key, rsa.RSAPrivateKey)
    key.public_key().verify(unb64(signature), f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())


def test_a_key_that_isnt_rsa_is_refused() -> None:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    pem = (
        ec.generate_private_key(ec.SECP256R1())
        .private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        .decode()
    )
    with pytest.raises(ValueError, match="RSA"):
        eb.jwt(APP_ID, pem, NOW)


def test_calls_go_only_to_enable_banking_with_bearer_and_accept() -> None:
    fake = FakeEnableBanking()
    fake.session("sess-123", ["uid-acc-1"])
    fake.pages["uid-acc-1"] = [[txn("1.00", "2026-11-01")], []]
    client = eb.Client(fake, "TOKEN")
    assert client.session("sess-123")["status"] == "AUTHORIZED"
    rows, key = client.transactions("uid-acc-1", {"transaction_status": "BOOK", "date_from": "2026-08-26"})
    assert len(rows) == 1
    assert key == "k1"
    rows, key = client.transactions("uid-acc-1", {"transaction_status": "BOOK", "continuation_key": "k1"})
    assert rows == []
    assert key is None
    assert all(c.url.startswith("https://api.enablebanking.com/") for c in fake.calls)
    assert not any("tilisy" in c.url for c in fake.calls)
    assert all(c.headers["Authorization"] == "Bearer TOKEN" for c in fake.calls)


# --- errors -------------------------------------------------------------------------------------------------------


def answering(status: int, body: Any, headers: dict[str, str] | None = None) -> Any:
    def http(_request: HttpRequest) -> HttpResponse:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        return HttpResponse(status, headers or {}, raw)

    return http


def error_of(status: int, body: Any, headers: dict[str, str] | None = None) -> eb.BankError:
    with pytest.raises(eb.BankError) as found:
        eb.Client(answering(status, body, headers), "T").session("s")
    return found.value


def test_errors_are_typed_and_never_carry_the_body() -> None:
    body = {"error": "ASPSP_ERROR", "message": "Anna Andersson SE4550000000058398257466", "detail": {"iban": "SE45"}}
    e = error_of(502, body)
    assert (e.code, e.status) == ("ASPSP_ERROR", 502)
    assert "Anna" not in str(e)
    assert "SE45" not in str(e)
    assert "SE45" not in repr(e.args)
    assert error_of(500, b"<html>Anna Andersson</html>").code == ""
    assert error_of(400, {"error": "lower case or long" * 10}).code == ""  # only a real code is kept
    assert error_of(429, {}, {"Retry-After": "120"}).retry_after == 120
    with pytest.raises(eb.BankError) as unreadable:
        eb.Client(answering(200, b"[1, 2]"), "T").session("s")
    assert unreadable.value.code == eb.UNREADABLE

    def down(_request: HttpRequest) -> HttpResponse:
        raise network_down()

    with pytest.raises(eb.BankError) as network:
        eb.Client(down, "T").session("s")
    assert network.value.code == eb.NETWORK


@pytest.mark.parametrize(
    ("code", "status", "outcome"),
    [
        ("EXPIRED_SESSION", 401, eb.END_EXPIRED),
        ("REVOKED_SESSION", 401, eb.END_REVOKED),
        ("CLOSED_SESSION", 401, eb.END_CLOSED),
        ("SESSION_DOES_NOT_EXIST", 404, eb.END_CLOSED),
        ("ACCESS_DENIED", 403, eb.END_CLOSED),
        ("WRONG_SESSION_STATUS", 422, eb.END_CLOSED),
        ("ASPSP_PSU_ACTION_REQUIRED", 422, eb.PSU_ACTION),
        ("ASPSP_RATE_LIMIT_EXCEEDED", 429, eb.ASPSP_LIMIT),
        ("PSU_HEADER_NOT_PROVIDED", 422, eb.PSU_HEADER),
        ("PSU_HEADER_INVALID", 422, eb.PSU_HEADER),
        ("ACCOUNT_DOES_NOT_EXIST", 404, eb.ACCOUNT),
        ("ASPSP_ACCOUNT_NOT_ACCESSIBLE", 422, eb.ACCOUNT),
        ("INVALID_ACCOUNT_ID", 422, eb.ACCOUNT),
        ("WRONG_TRANSACTIONS_PERIOD", 422, eb.PERIOD),
        ("DATE_FROM_IN_FUTURE", 422, eb.PERIOD),
        ("WRONG_DATE_INTERVAL", 422, eb.PERIOD),
        ("UNAUTHORIZED_ACCESS", 401, eb.KEY),
        ("AUTHORIZATION_NOT_PROVIDED", 401, eb.KEY),
        ("WRONG_CONTINUATION_KEY", 422, eb.CONTINUATION),
        ("ASPSP_ERROR", 502, eb.DOWN),
        ("ASPSP_TIMEOUT", 504, eb.DOWN),
        ("UNAUTHORIZED_IP", 403, eb.DOWN),
        # the catch-all: any other code, an answer that can't be read, no answer at all
        ("WRONG_REQUEST_PARAMETERS", 422, eb.DOWN),
        ("SOMETHING_NEW", 400, eb.DOWN),
        ("", 401, eb.DOWN),  # decided by the code, never by the HTTP status alone
        ("", 500, eb.DOWN),
        ("", 429, eb.EB_LIMIT),  # Enable Banking's own 429
        (eb.UNREADABLE, 200, eb.DOWN),
        (eb.NETWORK, 0, eb.DOWN),
    ],
)
def test_every_error_row(code: str, status: int, outcome: str) -> None:
    assert eb.outcome(eb.BankError(code, status)) == outcome


def test_session_statuses() -> None:
    assert eb.session_outcome({"status": "AUTHORIZED"}) is None
    assert eb.session_outcome({"status": "EXPIRED"}) == eb.END_EXPIRED
    assert eb.session_outcome({"status": "REVOKED"}) == eb.END_REVOKED
    for status in ("CLOSED", "CANCELLED", "INVALID", "PENDING_AUTHORIZATION"):
        assert eb.session_outcome({"status": status}) == eb.END_CLOSED
    with pytest.raises(eb.BankError):
        eb.session_outcome({})
    assert eb.session_accounts({"accounts": ["u1", {"uid": "u2"}, "u1", 7]}) == ["u1", "u2"]


def test_the_limits() -> None:
    error = eb.BankError("", 429, retry_after=120)
    assert eb.limit_until(eb.ASPSP_LIMIT, eb.BankError("ASPSP_RATE_LIMIT_EXCEEDED", 429), NOW) == iso(
        NOW + timedelta(hours=6)
    )
    assert eb.limit_until(eb.EB_LIMIT, error, NOW) == iso(NOW + timedelta(hours=1))
    assert eb.limit_until(eb.EB_LIMIT, eb.BankError("", 429, retry_after=7200), NOW) == iso(NOW + timedelta(hours=2))
    assert eb.limit_until(eb.DOWN, error, NOW) is None


# --- the PSU headers ------------------------------------------------------------------------------------------

PSU = {"ip": "203.0.113.9", "ua": "Mozilla/5.0 " + "x" * 600, "lang": "sv-SE,sv;q=0.9," + "en;q=0.8," * 20}
REFERER = f"{APP_URL}/settings/posting/getpaid/bank"


def test_psu_headers_all_or_none_matched_without_case() -> None:
    headers = eb.psu_headers(["Psu-Ip-Address", "PSU-USER-AGENT", "psu-referer", "Psu-Accept-Language"], PSU, REFERER)
    assert headers is not None
    assert headers == {
        "Psu-Ip-Address": "203.0.113.9",
        "Psu-User-Agent": PSU["ua"][:512],
        "Psu-Referer": REFERER,
        "Psu-Accept-Language": PSU["lang"][:100],
    }
    assert eb.psu_headers(["psu-ip-address", "psu-geo-location"], PSU, REFERER) is None  # one it can't fill: none
    assert eb.psu_headers(["psu-ip-address"], {"ua": "x"}, REFERER) is None  # no ip given
    assert eb.psu_headers(["psu-referer"], PSU, "") is None  # no app address: the referer can't be filled
    assert eb.psu_headers(["psu-ip-address"], None, REFERER) is None  # not his read
    assert eb.psu_headers([], PSU, REFERER) is None  # a bank with no psuHeaders: unattended


# --- the rolling 24 hours ---------------------------------------------------------------------------------------


def test_two_late_check_nows_and_two_early_ones_make_at_most_three_in_any_24_hours() -> None:
    day1 = datetime(2026, 11, 23, 22, 0, tzinfo=UTC)
    reads: dict[str, Any] = {}
    made = []
    for at in (day1, day1 + timedelta(hours=1), day1 + timedelta(hours=2, minutes=30), day1 + timedelta(hours=3)):
        if eb.may_read_unattended(reads, at):
            reads = eb.record_read(reads, at, attended=False)
            made.append(at)
    assert made == [day1, day1 + timedelta(hours=1), day1 + timedelta(hours=2, minutes=30)]
    # never a calendar day: the 24 hours roll on, so the next read waits until 22:00 the next day
    assert not eb.may_read_unattended(reads, day1 + timedelta(hours=23, minutes=59))
    assert eb.may_read_unattended(reads, day1 + timedelta(hours=24, minutes=1))
    every: list[datetime] = []
    reads = {}
    start = datetime(2026, 11, 20, tzinfo=UTC)
    for minutes in range(0, 3 * 24 * 60, 30):
        at = start + timedelta(minutes=minutes)
        if eb.may_read_unattended(reads, at):
            reads = eb.record_read(reads, at, attended=False)
            every.append(at)
    for at in every:
        assert sum(1 for t in every if at - timedelta(hours=24) < t <= at) <= 3
    assert len(reads["unattendedAt"]) <= 4


def test_an_unattended_longest_counts_twice_and_attended_reads_never_count() -> None:
    reads = eb.record_read({}, NOW, attended=False, cost=2)
    assert reads["unattendedAt"] == [iso(NOW), iso(NOW)]
    assert eb.may_read_unattended(reads, NOW, 1)
    assert not eb.may_read_unattended(reads, NOW, 2)
    attended = eb.record_read(reads, NOW + timedelta(minutes=1), attended=True)
    assert attended["unattendedAt"] == reads["unattendedAt"]
    assert attended["lastAttendedAt"] == iso(NOW + timedelta(minutes=1))


# --- what each error does to the link (the reader applies the table) -------------------------------------------


@pytest.fixture
def world() -> World:
    return World(NOW)


def test_a_bank_down_sets_failing_since_once_and_a_good_read_removes_it(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(502, "ASPSP_ERROR")]
    world.run()
    link = world.link()
    assert link["lastError"] == DOWN.format(bank="Swedbank")
    assert link["failingSince"] == iso(NOW)
    assert link["status"] == "connected"
    world.now = NOW + timedelta(hours=8)
    world.eb.fail["uid-acc-1"] = [network_down()]
    world.run()
    assert world.link()["failingSince"] == iso(NOW)  # the first failed read
    world.now = NOW + timedelta(hours=30)
    world.run()
    link = world.link()
    assert "failingSince" not in link
    assert "lastError" not in link
    assert link["readThrough"] == "2026-11-24"


@pytest.mark.parametrize("code", ["WRONG_REQUEST_PARAMETERS", "UNAUTHORIZED_IP", "ASPSP_TIMEOUT", ""])
def test_the_catch_all(world: World, code: str) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(400 if code else 503, code)]
    world.run()
    assert world.link()["lastError"] == DOWN.format(bank="Swedbank")
    assert world.link()["failingSince"] == iso(NOW)


def test_the_banks_too_many_waits_6_hours(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(429, "ASPSP_RATE_LIMIT_EXCEEDED")]
    world.run()
    link = world.link()
    assert link["limitUntil"] == iso(NOW + timedelta(hours=6))
    assert link["lastError"] == WAIT.format(bank="Swedbank")
    assert "failingSince" not in link
    calls = len(world.eb.calls)
    world.now = NOW + timedelta(hours=5)
    world.run()
    assert len(world.eb.calls) == calls  # no read before then
    world.now = NOW + timedelta(hours=7)
    world.run()
    assert "limitUntil" not in world.link()
    assert "lastError" not in world.link()


def test_enable_bankings_own_429_waits_at_least_an_hour(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(429, "", {"Retry-After": "60"})]
    world.run()
    assert world.link()["limitUntil"] == iso(NOW + timedelta(hours=1))


def test_the_key_error_marks_the_check_and_keeps_the_link(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["session"] = [(401, "UNAUTHORIZED_ACCESS")]
    world.run()
    link = world.link()
    assert link["status"] == "connected"
    assert link["lastError"] == KEY_WRONG
    assert link["failingSince"] == iso(NOW)
    assert world.conn()["app"]["check"] == {"code": "key_wrong", "at": iso(NOW)}
    assert world.conn()["app"]["status"] == "saved"  # nothing else of the app changes


def test_an_account_the_bank_didnt_share_is_skipped(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22", accounts=("uid-acc-1", "uid-acc-2"))
    world.eb.fail["uid-acc-1"] = [(404, "ACCOUNT_DOES_NOT_EXIST")]
    world.eb.pages["uid-acc-2"] = [[txn("85.00", "2026-11-21", payer="GOOGLE")]]
    world.run()
    link = world.link()
    assert link["lastError"] == "Swedbank didn't share one of your accounts today."
    assert link["readThrough"] == "2026-11-23"
    assert "failingSince" not in link
    assert len(world.deposits()) == 1


def test_a_wrong_period_gets_one_more_try_from_89_days(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(422, "WRONG_TRANSACTIONS_PERIOD")]
    world.run()
    calls = world.eb.transaction_calls
    assert [c["date_from"] for c in calls] == ["2026-11-12", "2026-08-26"]
    assert calls[1]["strategy"] == "default"
    assert "lastError" not in world.link()


def test_psu_action_needed_keeps_the_link_connected(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.eb.fail["uid-acc-1"] = [(422, "ASPSP_PSU_ACTION_REQUIRED")]
    world.run()
    link = world.link()
    assert (link["status"], link["reason"]) == ("connected", "psu_action")
    assert "failingSince" not in link


def test_psu_headers_go_only_on_his_fresh_read_and_a_refusal_gets_one_unattended_try(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22", psu_headers=("psu-ip-address", "psu-user-agent"))
    world.run(psu={"ip": "203.0.113.9", "ua": "Safari"}, mine=True)
    sent = [c.headers for c in world.eb.calls if c.url.split("?")[0].endswith("/transactions")]
    assert sent[0]["Psu-Ip-Address"] == "203.0.113.9"
    assert sent[0]["Psu-User-Agent"] == "Safari"
    assert "lastAttendedAt" in world.link()["reads"]
    assert world.link()["reads"]["unattendedAt"] == []
    assert not any("Psu-Ip-Address" in c.headers for c in world.eb.calls if "/sessions/" in c.url)
    # The bank refuses the headers: one more try without them, counted as unattended.
    world.now = NOW + timedelta(hours=1)
    world.eb.calls.clear()
    world.eb.fail["uid-acc-1"] = [(422, "PSU_HEADER_INVALID")]
    world.run(psu={"ip": "203.0.113.9", "ua": "Safari"}, mine=True)
    tries = [c.headers for c in world.eb.calls if c.url.split("?")[0].endswith("/transactions")]
    assert "Psu-Ip-Address" in tries[0]
    assert "Psu-Ip-Address" not in tries[1]
    assert world.link()["reads"]["unattendedAt"] == [iso(world.now)]
    assert "lastError" not in world.link()


def test_psu_refused_with_the_rolling_three_used_is_a_failed_read(world: World) -> None:
    used = [iso(NOW - timedelta(hours=h)) for h in (3, 2, 1)]
    world.ready(
        firstReadDone=True,
        readThrough="2026-11-22",
        psu_headers=("psu-ip-address",),
        reads={"unattendedAt": used},
    )
    world.eb.fail["uid-acc-1"] = [(422, "PSU_HEADER_NOT_PROVIDED")]
    world.run(psu={"ip": "203.0.113.9"}, mine=True)
    link = world.link()
    assert link["lastError"] == DOWN.format(bank="Swedbank")
    assert link["failingSince"] == iso(NOW)
    assert len(world.eb.transaction_calls) == 1


def test_a_bank_with_no_psu_headers_is_unattended_even_on_his_read(world: World) -> None:
    world.ready(firstReadDone=True, readThrough="2026-11-22")
    world.run(psu={"ip": "203.0.113.9", "ua": "Safari"}, mine=True)
    assert not any(k.lower().startswith("psu-") for c in world.eb.calls for k in c.headers)
    assert world.link()["reads"]["unattendedAt"] == [iso(NOW)]


def test_past_the_rolling_three_the_link_is_skipped(world: World) -> None:
    used = [iso(NOW - timedelta(hours=h)) for h in (20, 10, 1)]
    world.ready(firstReadDone=True, readThrough="2026-11-22", reads={"unattendedAt": used})
    world.run()
    assert world.eb.calls == []
    assert world.link()["lastError"] == "Clip Factory looked at Swedbank 3 times in a day. It looks again later."
