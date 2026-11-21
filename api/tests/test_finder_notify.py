"""The finder's one notification: "3 new campaigns match what you want." (docs/CONTRACTS.md §41.4). The look sets
``CRFIND.notice``; ``cf-prod-notify`` sends it on that ``MODIFY``, once per key, under "Content Rewards news".
Offline: a recording sender stands in for the push services."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db, settings
from clipfactory_api.push import notify, webpush
from clipfactory_api.realtime.broadcast import _deserializer
from conftest import USER, Clock
from fakes import FakeTable

KEY = "2026112112:3"


def _ddb(value: Any) -> dict[str, Any]:
    from boto3.dynamodb.types import TypeSerializer

    return TypeSerializer().serialize(db.to_dynamo(value))  # type: ignore[no-any-return]


def finder(**fields: Any) -> dict[str, Any]:
    return {
        "pk": db.user_pk(USER),
        "sk": "CRFIND",
        "type": "crfind",
        "userId": USER,
        "want": {"on": True, "tellMe": True, "minPer1kCents": 100},
        **fields,
    }


def record(old: dict[str, Any], new: dict[str, Any], event: str = "MODIFY") -> dict[str, Any]:
    return {
        "eventName": event,
        "dynamodb": {
            "Keys": {"pk": {"S": new["pk"]}, "sk": {"S": new["sk"]}},
            "OldImage": {k: _ddb(v) for k, v in old.items()},
            "NewImage": {k: _ddb(v) for k, v in new.items()},
        },
    }


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> tuple[notify.NotifyDeps, list[webpush.Message]]:
    store = db.Store(FakeTable())
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "PUSHSUB#phone-12345678",
            "type": "pushsub",
            "deviceId": "phone-12345678",
            "endpoint": "https://web.push.apple.com/abc",
        }
    )
    sent: list[webpush.Message] = []

    def send(_deps: Any, _user: str, message: webpush.Message, subs: list[Any]) -> int:
        assert [s["deviceId"] for s in subs] == ["phone-12345678"]
        sent.append(message)
        return 1

    monkeypatch.setattr(notify, "send_to_devices", send)
    deps = notify.NotifyDeps(store=store, key=None, deserialize=_deserializer(), clock=Clock())  # type: ignore[arg-type]
    return deps, sent


def test_new_matches_send_one_notification_once_per_key(world: Any) -> None:
    deps, sent = world
    change = record(finder(), finder(notice={"key": KEY, "count": 3, "at": "2026-11-21T12:00:00.000Z"}))
    notify.process({"Records": [change]}, deps)
    notify.process({"Records": [change]}, deps)  # a stream retry: nothing twice
    assert len(sent) == 1
    message = sent[0]
    assert (message.title, message.body, message.tag, message.url) == (
        "Content Rewards",
        "3 new campaigns match what you want.",
        "crfind",  # a new one replaces an older one
        "/campaigns/find",
    )
    assert (message.ttl, message.urgency) == (24 * 3600, "normal")
    assert deps.store.get(db.user_pk(USER), f"NOTIFIED#cr#finder:{KEY}") is not None  # the dedupe key, 2-day TTL


def test_the_singular() -> None:
    assert notify.finder_words(1) == "1 new campaign matches what you want."
    assert notify.finder_words(12) == "12 new campaigns match what you want."


def test_only_a_changed_notice_key_counts(world: Any) -> None:
    deps, sent = world
    notice = {"key": KEY, "count": 3, "at": "2026-11-21T12:00:00.000Z"}
    records = [
        record(finder(notice=notice), finder(notice=notice, seenAt="2026-11-21T13:00:00.000Z")),  # same key
        record(finder(), finder(matches=[{"campaignId": "x"}])),  # matches changed, no notice
        record(finder(), finder(notice={"key": "2026112113:0", "count": 0})),  # nothing new
        record({}, finder(notice=notice), event="INSERT"),  # notify reads MODIFY only
    ]
    notify.process({"Records": records}, deps)
    assert sent == []


@pytest.mark.parametrize("want", [{"on": True, "tellMe": False}, {"on": False, "tellMe": True}])
def test_tell_me_off_or_the_finder_stopped(world: Any, want: dict[str, Any]) -> None:
    deps, sent = world
    change = record(finder(want=want), finder(want=want, notice={"key": KEY, "count": 2}))
    notify.process({"Records": [change]}, deps)
    assert sent == []


def test_content_rewards_news_off(world: Any) -> None:
    deps, sent = world
    settings.save(
        deps.store,
        USER,
        {"notify": {**settings.DEFAULTS["notify"], "contentRewards": False}},
        "2026-11-21T12:00:00.000Z",
    )
    notify.process({"Records": [record(finder(), finder(notice={"key": KEY, "count": 2}))]}, deps)
    assert sent == []


def test_crfind_is_a_content_rewards_prefix() -> None:
    assert "CRFIND" in notify.CR_PREFIXES
    assert not "CRPUBLIC".startswith(notify.CR_PREFIXES)  # the shared cache never notifies anyone
