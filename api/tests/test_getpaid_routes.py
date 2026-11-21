"""/v1/getpaid (docs/CONTRACTS.md §40.7, tests §40.8 "api (K)"): stored items only, his ticks on their own item, the
Whop routes switched off by default, and no secret, trace code or publisher id in any answer.

Owner rules: Get paid never joins Set up posting (the five setup cards, "n of 5 ready" and the floating to-do list
stay as they are), and Clip Factory never asks for or stores a bank, card or tax number.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest

from clipfactory_api import db, money
from clipfactory_api.app import App
from clipfactory_api.getpaid import grants
from conftest import USER, Call, Clock
from cr_support import FakeCR, make_deps
from fakes import FakeHttp, FakeSecretsManager, FakeTable
from getpaid_cases import ADSENSE, WHOP_CONN, google, whop, whop_state, yt_state

PK = db.user_pk(USER)
PLATFORMS = ["youtube", "tiktok", "instagram", "facebook", "x"]


@pytest.fixture(autouse=True)
def _no_cached_metadata() -> Iterator[None]:
    grants.forget_metadata()
    yield
    grants.forget_metadata()


@pytest.fixture
def cr_app(app: App, secrets_client: FakeSecretsManager, clock: Clock) -> App:
    app.contentrewards = make_deps(app.store, secrets_client, FakeCR(), clock)
    return app


def card(body: dict[str, Any], place: str) -> dict[str, Any]:
    return next(c for c in body["places"] if c["place"] == place)


def seed_everything(store: db.Store) -> None:
    """Stored Get paid items with internal fields that must never leave the server."""
    store.put({"pk": PK, "sk": "PAYCONN#adsense", **ADSENSE, "refreshLeaseUntil": "2026-11-15T12:01:00.000Z"})
    store.put({"pk": PK, "sk": "PAYSTATE#youtube", **yt_state(lastCheckedAt="2026-11-15T06:00:00.000Z")})
    store.put({"pk": PK, **google("2026-10-23", "kr 1 234,56 SEK")})
    store.put({"pk": PK, "sk": "PAYCONN#whop", **WHOP_CONN, "refreshLeaseUntil": "2026-11-15T12:01:00.000Z"})
    store.put({"pk": PK, "sk": "PAYSTATE#contentrewards", **whop_state(lastCheckedAt="2026-11-15T06:00:00.000Z")})
    store.put({"pk": PK, **whop("2026-11-10", "po_1", "completed", 40_000_000)})


def no_internals(body: Any) -> None:
    text = json.dumps(body)
    for value in ("UETR", "traceCode", "tokenVersionId", "refreshLeaseUntil", "pub-1234567890123456", "v3"):
        assert value not in text, value


# --- GET -----------------------------------------------------------------------------------------------------------


def test_get_paid_lists_the_five_platforms_and_registers_the_owner(call: Call, app: App) -> None:
    status, body = call("GET", "/v1/getpaid")
    assert status == 200
    assert [c["place"] for c in body["places"]] == PLATFORMS  # Content Rewards is off
    assert body["connections"] == {"adsense": {"source": "adsense", "status": "not_connected"}, "whop": None}
    assert body["stepsDone"] == []
    assert body["country"] is None
    assert body["summary"] == "Nothing is set up yet. Start with YouTube."
    assert body["asOf"] == "2026-11-15T12:00:00.000Z"
    assert app.store.get(money.OWNERS_PK, money.owner_sk(USER)) is not None  # like GET /v1/money
    for c in body["places"]:
        assert c["status"] == "not_connected"
        assert "Live" not in c["pill"]


def test_content_rewards_joins_while_it_is_on_and_whop_stays_coming_soon(call: Call, cr_app: App) -> None:
    seed_everything(cr_app.store)
    _status, body = call("GET", "/v1/getpaid")
    assert [c["place"] for c in body["places"]] == [*PLATFORMS, "contentrewards"]
    assert body["connections"]["whop"] is None  # WHOP_CONNECT is off
    cr = card(body, "contentrewards")
    assert "readingChip" not in cr
    assert cr["status"] != "can_get_paid"  # no Whop signal while Connect Whop is off
    assert "Whop says" not in " ".join(cr["seen"])
    # Payouts Whop already reported stay records of real money; there is no Connect Whop button while it is off.
    assert cr["sent"]["state"] == "number"
    assert "button" not in cr["sent"]
    no_internals(body)


def test_with_connect_whop_on(call: Call, cr_app: App) -> None:
    cr_app.whop_connect = True
    seed_everything(cr_app.store)
    status, body = call("GET", "/v1/getpaid")
    assert status == 200
    whop_conn = body["connections"]["whop"]
    assert whop_conn["redirectUri"] == "https://abc123.execute-api.eu-north-1.amazonaws.com/v1/oauth/whop/callback"
    assert (whop_conn["status"], whop_conn["accountName"], whop_conn["keyHint"]) == (
        "connected",
        "@owner",
        "app_Ab…wxyz",
    )
    cr = card(body, "contentrewards")
    assert cr["readingChip"] == "Clip Factory can see Whop payouts: on"
    assert cr["sent"]["amounts"] == [{"currency": "USD", "amountMicros": 40_000_000}]
    yt = card(body, "youtube")
    assert yt["readingChip"] == "Clip Factory can see payments: on"
    assert yt["sent"]["amounts"] == [{"currency": "SEK", "amountMicros": 1_234_560_000}]
    no_internals(body)


def test_one_place(call: Call, app: App) -> None:
    seed_everything(app.store)
    status, body = call("GET", "/v1/getpaid/youtube")
    assert status == 200
    assert body["card"]["place"] == "youtube"
    assert body["payouts"] == [
        {"date": "2026-10-23", "by": "Google", "state": "sent", "amountMicros": 1_234_560_000, "currency": "SEK"}
    ]
    no_internals(body)
    assert call("GET", "/v1/getpaid/myspace")[0] == 404
    assert call("GET", "/v1/getpaid/contentrewards")[0] == 404  # Content Rewards is off


def test_one_place_content_rewards(call: Call, cr_app: App) -> None:
    cr_app.whop_connect = True
    seed_everything(cr_app.store)
    status, body = call("GET", "/v1/getpaid/contentrewards")
    assert status == 200
    assert body["payouts"] == [
        {"date": "2026-11-10", "by": "Whop", "state": "sent", "amountMicros": 40_000_000, "currency": "USD"}
    ]
    no_internals(body)


def test_reading_never_calls_a_platform(call: Call, cr_app: App, http: FakeHttp) -> None:
    cr_app.whop_connect = True
    seed_everything(cr_app.store)
    for path in ("/v1/getpaid", "/v1/getpaid/youtube", "/v1/getpaid/contentrewards", "/v1/money/everywhere"):
        assert call("GET", path)[0] == 200
    assert http.calls == []


# --- his ticks -----------------------------------------------------------------------------------------------------


def test_ticks_live_on_their_own_item_never_on_the_setup_list(call: Call, store: db.Store, table: FakeTable) -> None:
    _, setup_before = call("GET", "/v1/setup")
    status, body = call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": True})
    assert status == 200
    assert body["stepsDone"] == ["yt-tax"]
    item = store.get(PK, "GETPAID")
    assert item is not None
    assert item["type"] == "getpaid"
    assert set(item["stepsDone"]) == {"yt-tax"}
    assert not any(str(i["sk"]).startswith("SETUP#") for i in table.all())  # never a Get paid tick on SETUP#
    _, setup_after = call("GET", "/v1/setup")
    assert setup_after["ready"] == setup_before["ready"] == 0
    assert len(setup_after["platforms"]) == 5  # the five setup cards and "n of 5" stay as they are
    yt = card(body, "youtube")
    assert next(s for s in yt["steps"] if s["id"] == "yt-tax") == {"id": "yt-tax", "done": True, "by": "you"}
    assert yt["ring"] == {"done": 1, "total": 6}
    status, body = call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": False})
    assert body["stepsDone"] == []


def test_one_meta_payout_tick_for_both_meta_places(call: Call) -> None:
    _, body = call("PATCH", "/v1/getpaid/steps", {"step": "meta-payout", "done": True})
    for place in ("instagram", "facebook"):
        c = card(body, place)
        assert next(s for s in c["steps"] if s["id"] == "meta-payout")["done"] is True
        assert c["status"] == "not_started"  # never "you said it's done" on the shared tick alone
        assert c["line"].startswith("You said Meta knows where to pay you.")


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"step": "nope", "done": True}, "That step is not known."),
        ({"step": "NOT VALID", "done": True}, "That step is not known."),
        ({"step": "yt-reading", "done": True}, "Tap Allow payment reading instead."),
        ({"step": "move-whop", "done": True}, "Tick Content Rewards steps on its own card."),
        ({"step": "bank-setup", "done": True}, "Tick Content Rewards steps on its own card."),
        ({"step": "ready-account", "done": True}, "That step is not known."),
    ],
)
def test_ticks_that_are_refused(call: Call, body: dict[str, Any], message: str) -> None:
    status, out = call("PATCH", "/v1/getpaid/steps", body)
    assert (status, out["error"]["message"]) == (400, message)


def test_a_bad_tick_body(call: Call) -> None:
    assert call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": "yes"})[0] == 400
    assert call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": True, "amount": 5})[0] == 400


def test_at_most_80_ticks(call: Call, store: db.Store) -> None:
    store.put({"pk": PK, "sk": "GETPAID", "type": "getpaid", "stepsDone": {f"old-{i}" for i in range(80)}})
    status, body = call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": True})
    assert (status, body["error"]["message"]) == (400, "Too many steps are ticked.")
    assert call("PATCH", "/v1/getpaid/steps", {"step": "yt-tax", "done": False})[0] == 200  # unticking still works


# --- Connect Whop: off by default -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "/v1/getpaid/whop/key", {"clientId": "app_AbCdEfGh1234"}),
        ("POST", "/v1/getpaid/whop/connect", None),
        ("DELETE", "/v1/getpaid/connections/whop", None),
    ],
)
def test_the_whop_routes_are_coming_soon_while_off(
    call: Call, cr_app: App, method: str, path: str, body: Any, secrets_client: FakeSecretsManager
) -> None:
    status, out = call(method, path, body)
    assert (status, out["error"]["code"], out["error"]["message"]) == (503, "unavailable", "Coming soon.")
    assert not any("whop" in name for name in secrets_client.values)


def test_the_whop_key(call: Call, cr_app: App, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    cr_app.whop_connect = True
    for bad in ("", "client_123", "app_x", "app_" + "a" * 70, "app_has space"):
        status, out = call("PUT", "/v1/getpaid/whop/key", {"clientId": bad})
        assert (status, out["error"]["message"]) == (400, "Your Whop key starts with app_."), bad
    status, out = call("PUT", "/v1/getpaid/whop/key", {"clientId": "app_AbCdEfGh1234wxyz"})
    assert status == 200
    saved = secrets_client.json("cf-prod/platforms/whop/app")
    assert saved == {"clientId": "app_AbCdEfGh1234wxyz", "userId": USER, "savedAt": "2026-11-15T12:00:00.000Z"}
    assert out["connections"]["whop"]["status"] == "keys_saved"
    assert out["connections"]["whop"]["keyHint"] == "app_Ab…wxyz"
    assert "app_AbCdEfGh1234wxyz" not in json.dumps(out)
    conn = store.get(PK, "PAYCONN#whop") or {}
    assert (conn["type"], conn["source"], conn["status"]) == ("payconn", "whop", "keys_saved")


def test_connect_whop_needs_a_key(call: Call, cr_app: App) -> None:
    cr_app.whop_connect = True
    status, out = call("POST", "/v1/getpaid/whop/connect")
    assert (status, out["error"]["message"]) == (409, "Save your Whop key first.")


def test_connect_whop_when_whop_does_not_answer(call: Call, cr_app: App, http: FakeHttp) -> None:
    cr_app.whop_connect = True
    assert call("PUT", "/v1/getpaid/whop/key", {"clientId": "app_AbCdEfGh1234"})[0] == 200
    http.answers.append((500, {}))
    status, out = call("POST", "/v1/getpaid/whop/connect")
    assert (status, out["error"]["code"]) == (503, "platform_down")
    http.answers.append((200, {"authorization_endpoint": "https://evil.example.com/a", "token_endpoint": "https://x"}))
    assert call("POST", "/v1/getpaid/whop/connect")[0] == 503  # endpoints off Whop's own hosts are refused


# --- Stop payment reading ----------------------------------------------------------------------------------------


def test_stop_payment_reading_without_a_connection_is_fine(
    call: Call, store: db.Store, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    status, _ = call("DELETE", "/v1/getpaid/connections/adsense")
    assert status == 204
    assert store.get(PK, "PAYCONN#adsense") is None
    assert http.calls == []
    assert ("delete", "cf-prod/platforms/adsense/token") in secrets_client.calls


def test_the_routes_need_posting_setup(call: Call, app: App) -> None:
    app.oauth = None
    assert call("GET", "/v1/getpaid")[0] == 200  # reading works without it
    assert call("DELETE", "/v1/getpaid/connections/adsense")[0] == 503


def test_all_your_money_offers_connect_whop_only_while_it_is_on(call: Call, cr_app: App) -> None:
    def cr_sent() -> dict[str, Any]:
        _, body = call("GET", "/v1/money/everywhere")
        return card(body, "contentrewards")["sent"]  # type: ignore[no-any-return]

    cr_app.store.put({"pk": PK, "sk": db.CRCONN_SK, "type": "crconn", "status": "connected"})
    assert "button" not in cr_sent()
    cr_app.whop_connect = True
    assert cr_sent()["button"] == {
        "label": "Connect Whop",
        "href": "/settings/posting/getpaid/contentrewards#whop",
        "external": False,
    }
