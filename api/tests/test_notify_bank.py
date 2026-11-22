"""Your bank's notifications from ``cf-prod-notify`` (docs/CONTRACTS.md §40.5.11 "Notifications", §40.5.13 "notify").

``BANKCONN`` MODIFY records only. The reader sets ``lastNotice`` at the end of a run that found something to tell,
from rows that aren't ``quiet``; each event of a new notice goes out once (a conditional put on
``NOTIFIED#getpaid#bank:{key}``, 30-day ``ttl``), under ``notify.getPaid``, with the exact words, the title "Clip
Factory", amounts written by ``money_words`` and never a link, a secret, an account number or the bank's text.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.push import devices, notify
from clipfactory_api.realtime.broadcast import _deserializer
from conftest import USER, Call, Clock
from fakes import FakeSecretsManager
from test_push import APPLE, GOOGLE, SECRET, SUBJECT, VAPID_PEM, Browser, PushService, _record

PK = db.user_pk(USER)
KEY = "2026-11-23T06:00:00.000Z"
BANK_URL = "/settings/posting/getpaid/bank"


@pytest.fixture
def iphone() -> Browser:
    return Browser(APPLE)


@pytest.fixture
def service(iphone: Browser) -> PushService:
    return PushService([iphone, Browser(GOOGLE)])


@pytest.fixture
def push_app(app: App, service: PushService) -> App:
    app.push = devices.VapidKey(FakeSecretsManager({SECRET: VAPID_PEM}), SECRET, SUBJECT)
    app.push_post = service
    return app


@pytest.fixture
def deps(push_app: App, service: PushService, clock: Clock) -> notify.NotifyDeps:
    return notify.NotifyDeps(
        store=push_app.store, key=push_app.push, deserialize=_deserializer(), post=service, clock=clock
    )


@pytest.fixture
def phone(call: Call, iphone: Browser, push_app: App) -> None:
    assert call("PUT", "/v1/push/devices/phone-12345678", iphone.json())[0] in (200, 201)


def conn(**fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": "BANKCONN", "type": "bankconn", **fields}


def notice(key: str = KEY, **fields: Any) -> dict[str, Any]:
    return {"key": key, "reached": [], "reachedMore": 0, "asks": 0, "expiring": [], "ended": [], **fields}


def row(deposit_id: str, place: str, minor: int, currency: str = "SEK", exponent: int = 2) -> dict[str, Any]:
    return {"depositId": deposit_id, "place": place, "amountMinor": minor, "exponent": exponent, "currency": currency}


def shown(service: PushService) -> list[tuple[str, str, str, str]]:
    return [(m["title"], m["body"], m["tag"], m["url"]) for m in service.shown]


def test_each_event_once_with_the_exact_words(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    new = notice(
        reached=[row("d1", "youtube", 123456)],
        asks=2,
        expiring=[{"linkId": "a1b2c3d4e5f6", "bank": "Swedbank", "days": 7, "consentUntil": "2026-11-30T10:00:00Z"}],
        ended=[{"linkId": "f0f0f0f0f0f0", "bank": "PayPal", "endedAt": KEY}],
    )
    record = _record(conn(lastNotice=notice(key="2026-11-22T06:00:00.000Z")), conn(lastNotice=new))
    notify.process({"Records": [record]}, deps)
    notify.process({"Records": [record]}, deps)  # a stream retry: nothing twice
    assert shown(service) == [
        ("Clip Factory", "Money reached your bank from YouTube: 1,234.56 SEK.", "getpaid-bank-reached", "/money"),
        (
            "Clip Factory",
            "Your bank got money that may be from an app. Tap to say where it's from.",
            "getpaid-bank-ask",
            BANK_URL,
        ),
        (
            "Clip Factory",
            "Your bank link ends in 7 days. Tap here to reconnect it with BankID.",
            "getpaid-bank-link-a1b2c3d4e5f6",
            BANK_URL,
        ),
        (
            "Clip Factory",
            "Your bank link ended. Tap here to reconnect with BankID.",
            "getpaid-bank-link-f0f0f0f0f0f0",
            BANK_URL,
        ),
    ]
    keys = sorted(i["sk"] for i in deps.store.query_all(PK, "NOTIFIED#getpaid#bank:"))
    assert keys == [
        "NOTIFIED#getpaid#bank:ask:2026-11-23",
        "NOTIFIED#getpaid#bank:ended:f0f0f0f0f0f0:2026-11-23T06:00:00.000Z",
        "NOTIFIED#getpaid#bank:expiring:a1b2c3d4e5f6:2026-11-30T10:00:00Z",
        "NOTIFIED#getpaid#bank:reached:d1",
    ]
    dedupe = deps.store.get(PK, keys[0]) or {}
    assert dedupe["ttl"] == int((deps.clock() + timedelta(days=30)).timestamp())


def test_the_same_event_in_a_later_notice_is_not_sent_again(
    deps: notify.NotifyDeps, phone: None, service: PushService
) -> None:
    first = notice(asks=1)
    later = notice(key="2026-11-23T14:00:00.000Z", asks=3)  # the same day: "ask" at most once a day
    notify.process({"Records": [_record(conn(), conn(lastNotice=first))]}, deps)
    notify.process({"Records": [_record(conn(lastNotice=first), conn(lastNotice=later))]}, deps)
    assert [m["tag"] for m in service.shown] == ["getpaid-bank-ask"]  # once


@pytest.mark.parametrize(
    ("reached", "more", "body"),
    [
        ([row("d1", "meta", 91240)], 0, "Money reached your bank from Meta (Instagram and Facebook): 912.40 SEK."),
        ([row("d1", "contentrewards", 41230)], 0, "Money reached your bank from Content Rewards (Whop): 412.30 SEK."),
        ([row("d1", "x", 1235, "JPY", 0)], 0, "Money reached your bank from X: 1,235 JPY."),
        (
            [row("d1", "youtube", 123456), row("d2", "x", 32170)],
            0,
            "Money reached your bank from YouTube and X. Tap to see how much.",
        ),
        (
            [row("d1", "youtube", 1), row("d2", "youtube", 2), row("d3", "tiktok", 3)],
            4,
            "Money reached your bank from YouTube and TikTok. Tap to see how much.",
        ),
        ([row("d1", "youtube", 123456)], 1, "Money reached your bank from YouTube. Tap to see how much."),
    ],
)
def test_reached_bodies(
    deps: notify.NotifyDeps, phone: None, service: PushService, reached: list[Any], more: int, body: str
) -> None:
    notify.process({"Records": [_record(conn(), conn(lastNotice=notice(reached=reached, reachedMore=more)))]}, deps)
    assert service.shown[0]["body"] == body
    assert service.shown[0]["url"] == "/money"
    keys = [i["sk"] for i in deps.store.query_all(PK, "NOTIFIED#getpaid#bank:")]
    assert keys == ["NOTIFIED#getpaid#bank:reached:d1"]


def test_one_day_left_says_1_day(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    link = {"linkId": "a1b2c3d4e5f6", "bank": "Swedbank", "days": 1, "consentUntil": "2026-11-24T10:00:00Z"}
    notify.process({"Records": [_record(conn(), conn(lastNotice=notice(expiring=[link])))]}, deps)
    assert service.shown[0]["body"] == "Your bank link ends in 1 day. Tap here to reconnect it with BankID."


def test_nothing_without_a_new_notice(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    same = notice(asks=1, reached=[row("d1", "youtube", 100)])
    records = [
        _record(conn(lastNotice=same), conn(lastNotice=same, readLease={"until": KEY})),  # the lease, not a notice
        _record(conn(), conn(stepsDone=["bank-account"])),
        _record(conn(), conn(lastNotice=notice())),  # a quiet first read: nothing in it
        _record(conn(), conn(lastNotice=same), event="INSERT"),
    ]
    notify.process({"Records": records}, deps)
    assert service.shown == []


def test_none_with_get_paid_off(deps: notify.NotifyDeps, phone: None, service: PushService, store: db.Store) -> None:
    store.put(
        {
            "pk": PK,
            "sk": db.SETTINGS_SK,
            "type": "settings",
            "userId": USER,
            "notify": {
                "ready": True,
                "stopped": True,
                "resumed": False,
                "steps": False,
                "contentRewards": True,
                "getPaid": False,
            },
        }
    )
    notify.process({"Records": [_record(conn(), conn(lastNotice=notice(asks=1)))]}, deps)
    assert service.shown == []


def test_messages_never_carry_a_link_a_secret_or_the_banks_text(
    deps: notify.NotifyDeps, phone: None, service: PushService
) -> None:
    new = notice(
        reached=[row("d1", "youtube", 123456)],
        asks=1,
        ended=[{"linkId": "a1b2c3d4e5f6", "bank": "Swedbank", "endedAt": KEY}],
    )
    notify.process({"Records": [_record(conn(), conn(lastNotice=new))]}, deps)
    for message in service.shown:
        text = message["title"] + message["body"]
        assert "http" not in text
        assert "Swedbank" not in text
        assert "d1" not in text
        assert message["url"] in {"/money", BANK_URL}


def test_bank_amount_is_a_unit_change() -> None:
    assert notify.bank_amount(row("d", "youtube", 123456)) == "1,234.56 SEK"
    assert notify.bank_amount(row("d", "youtube", 1234, "KWD", 3)) == "1.234 KWD"
    assert notify.bank_amount({"amountMinor": True, "exponent": 2, "currency": "SEK"}) is None
    assert notify.bank_amount({"amountMinor": 1, "exponent": 9, "currency": "SEK"}) is None
