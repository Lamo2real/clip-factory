"""Get paid notifications from ``cf-prod-notify`` (docs/CONTRACTS.md §40.7 "Notifications"; builder L).

``PAYSTATE#`` MODIFY records only. The rules under test: each event once (a conditional put on
``NOTIFIED#getpaid#{key}``), none for the first read after a grant (the old image has no ``firstReadDone``), none with
``notify.getPaid`` off, the message words, the title "Clip Factory", and no link, secret or account number.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.payouts import PayoutDeps, adsense
from clipfactory_api.push import devices, notify
from clipfactory_api.realtime.broadcast import _deserializer
from conftest import USER, Call, Clock
from fakes import FakeSecretsManager
from test_payouts_adsense import A1, Google, StreamTable
from test_payouts_adsense import seed as seed_adsense
from test_push import APPLE, GOOGLE, SECRET, SUBJECT, VAPID_PEM, Browser, PushService, _record

PK = db.user_pk(USER)
YT = "PAYSTATE#youtube"
CR = "PAYSTATE#contentrewards"
SK_OCT = "PAYOUT#youtube#2026-10-23#4444"
SK_NOV = "PAYOUT#youtube#2026-11-21#4444"


@pytest.fixture
def table() -> StreamTable:
    return StreamTable()


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


def item(sk: str, **fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": sk, "type": "paystate", **fields}


def yt(**fields: Any) -> dict[str, Any]:
    return item(YT, **{"place": "youtube", "source": "adsense", "firstReadDone": True, "holds": [], **fields})


def cr(**fields: Any) -> dict[str, Any]:
    return item(CR, **{"place": "contentrewards", "source": "whop", "firstReadDone": True, **fields})


HOLD = {"type": "payment-hold", "severity": "SEVERE", "text": "On hold", "since": "2026-11-20T06:00:00.000Z"}
YT_SENT = {"sk": SK_NOV, "date": "2026-11-21", "text": "kr 1 234,56 SEK"}
YT_OLD = {"sk": SK_OCT, "date": "2026-10-23", "text": "kr 980,00 SEK"}


def shown(service: PushService) -> list[tuple[str, str, str, str]]:
    return [(m["title"], m["body"], m["tag"], m["url"]) for m in service.shown]


def test_each_event_once(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    whop_sent = {"sk": "PAYOUT#contentrewards#2026-11-20#po_7", "date": "2026-11-20", "amountMicros": 40_000_000}
    records = [
        _record(yt(lastSent=YT_OLD), yt(holds=[HOLD], holdSince=HOLD["since"], lastSent=YT_SENT)),
        _record(cr(), cr(hold={"kind": "bank_broken", "since": "2026-11-20T06:00:00.000Z"})),
        _record(cr(), cr(lastSent={**whop_sent, "currency": "USD"})),
    ]
    notify.process({"Records": records}, deps)
    notify.process({"Records": records}, deps)  # a stream retry: nothing twice
    assert shown(service) == [
        (
            "Clip Factory",
            "Your YouTube money is on hold. Tap to see why.",
            "getpaid-hold-youtube",
            "/settings/posting/getpaid/youtube",
        ),
        (
            "Clip Factory",
            "Money sent to your bank: Google sent kr 1 234,56 SEK. It arrives in up to 7 workdays.",
            "getpaid-sent-youtube",
            "/money",
        ),
        (
            "Clip Factory",
            "Whop can't send your money. Tap to see why.",
            "getpaid-hold-whop",
            "/settings/posting/getpaid/contentrewards",
        ),
        ("Clip Factory", "Money sent to your bank: Whop sent $40.00.", "getpaid-sent-contentrewards", "/money"),
    ]
    keys = sorted(i["sk"] for i in deps.store.query_all(PK, "NOTIFIED#getpaid#"))
    assert keys == [
        "NOTIFIED#getpaid#hold:whop:bank_broken:2026-11-20T06:00:00.000Z",
        "NOTIFIED#getpaid#hold:youtube:2026-11-20T06:00:00.000Z",
        "NOTIFIED#getpaid#sent:contentrewards:PAYOUT#contentrewards#2026-11-20#po_7",
        f"NOTIFIED#getpaid#sent:youtube:{SK_NOV}",
    ]
    dedupe = deps.store.get(PK, keys[0]) or {}
    assert dedupe["ttl"] == int((deps.clock() + timedelta(days=30)).timestamp())


def test_whop_amounts_in_their_own_money(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    def sent(n: int, **money: Any) -> dict[str, Any]:
        return cr(lastSent={"sk": f"PAYOUT#contentrewards#2026-11-2{n}#po_{n}", "date": f"2026-11-2{n}", **money})

    records = [
        _record(sent(0, amountMicros=1, currency="USD"), sent(1, amountMicros=412_000_000, currency="SEK")),
        _record(sent(1, amountMicros=1, currency="SEK"), sent(2, amountMicros=1_234_567_891, currency="USD")),
        _record(sent(2), sent(3)),  # Whop's amount couldn't be read: no number is made up
    ]
    notify.process({"Records": records}, deps)
    assert [m["body"] for m in service.shown] == [
        "Money sent to your bank: Whop sent 412.00 SEK.",
        "Money sent to your bank: Whop sent $1,234.57.",
        "Money sent to your bank: Whop sent you money.",
    ]


def test_none_on_the_first_read(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    def before(image: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in image.items() if k != "firstReadDone"}  # the first read hasn't ended yet

    records = [
        _record(before(yt()), yt(holds=[HOLD], holdSince=HOLD["since"], lastSent=YT_SENT)),
        _record(before(cr()), cr(hold={"kind": "id_rejected", "since": "x"}, lastSent=YT_SENT)),
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
    notify.process({"Records": [_record(yt(), yt(holds=[HOLD], holdSince=HOLD["since"]))]}, deps)
    assert service.shown == []


def test_get_paid_is_on_by_default(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    notify.process({"Records": [_record(yt(), yt(holds=[HOLD], holdSince=HOLD["since"]))]}, deps)
    assert len(service.shown) == 1


def test_nothing_new_is_nothing_sent(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    records = [
        _record(yt(holds=[HOLD], lastSent=YT_SENT), yt(holds=[HOLD, HOLD], lastSent=YT_SENT)),  # still on hold
        _record(yt(lastSent=YT_SENT), yt(lastSent=YT_OLD)),  # the newest one went away: older is not news
        _record(cr(hold={"kind": "bank_broken", "since": "a"}), cr(hold={"kind": "id_rejected", "since": "b"})),
        _record(yt(lastSent=YT_SENT), yt()),
        _record(yt(), yt(holds=[HOLD]), event="INSERT"),
        _record(item("PAYSTATE#tiktok", firstReadDone=True), item("PAYSTATE#tiktok", firstReadDone=True, holds=[HOLD])),
        _record(item("PAYCONN#adsense", status="connected"), item("PAYCONN#adsense", status="needs_reconnect")),
    ]
    notify.process({"Records": records}, deps)
    assert service.shown == []


def test_no_device_no_notification_and_no_dedupe(deps: notify.NotifyDeps, service: PushService) -> None:
    notify.process({"Records": [_record(yt(), yt(holds=[HOLD], holdSince=HOLD["since"]))]}, deps)
    assert service.shown == []
    assert deps.store.query_all(PK, "NOTIFIED#getpaid#") == []


def test_a_new_grant_is_quiet_then_new_money_is_news(
    deps: notify.NotifyDeps, phone: None, service: PushService, store: db.Store, table: StreamTable, clock: Clock
) -> None:
    """The collector and the stream together: old money from a new grant's first read is quiet, later money isn't."""
    google = Google()
    reader = PayoutDeps(
        store=store, secrets=Secrets(FakeSecretsManager(), "cf-prod/platforms/"), http=google, clock=clock
    )
    seed_adsense(reader)
    google.alerts[A1] = []

    def stream() -> list[dict[str, Any]]:
        out = [
            _record(old, new)
            for kind, old, new in table.stream
            if kind == "MODIFY" and new["sk"].startswith("PAYSTATE#")
        ]
        table.stream.clear()
        return out

    adsense.run(reader, USER, clock.now)  # the first read: an INSERT, and quiet anyway
    adsense.run(reader, USER, clock.now + timedelta(hours=1))
    notify.process({"Records": stream()}, deps)
    # Stop and allow again (a new grant) while Google sent money: the grant's first read fills it in quietly.
    store.update(PK, "PAYCONN#adsense", {"updatedAt": iso(clock.now + timedelta(days=3))})
    google.payments[A1].append({"name": f"{A1}/payments/youtube-2026-11-21", "amount": "kr 700,00 SEK"})
    adsense.run(reader, USER, clock.now + timedelta(days=3))
    notify.process({"Records": stream()}, deps)
    assert service.shown == []
    # Then Google sends money again, and a hold appears: both are news.
    google.payments[A1].append({"name": f"{A1}/payments/youtube-2026-12-22", "amount": "kr 900,00 SEK"})
    google.alerts[A1] = [{"type": "payment-hold", "severity": "SEVERE", "message": "<b>Hold</b>"}]
    adsense.run(reader, USER, clock.now + timedelta(days=31))
    notify.process({"Records": stream()}, deps)
    assert [m["body"] for m in service.shown] == [
        "Your YouTube money is on hold. Tap to see why.",
        "Money sent to your bank: Google sent kr 900,00 SEK. It arrives in up to 7 workdays.",
    ]
    assert all("pub-" not in m["body"] and "http" not in m["body"] for m in service.shown)
