"""Sending a campaign post to CR: one send and the §38.9 error table (docs/CONTRACTS.md §38.12, §38.20)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import connection, submit
from clipfactory_api.contentrewards.net import NetworkError
from conftest import NOW, USER, Clock
from cr_support import (
    CMP,
    UUID,
    FakeCR,
    listed_campaign,
    make_deps,
    page,
    response,
    seed_campaign,
    seed_connection,
    tool_error,
)
from fakes import FakeSecretsManager, FakeTable

POST = "01J0000000000000000000000P"
CLIP = "01J0000000000000000000000C"
URL = "https://www.youtube.com/shorts/abcDEF12345"


@pytest.fixture
def world() -> Any:
    clock = Clock(NOW)
    fake = FakeCR()
    deps = make_deps(db.Store(FakeTable()), FakeSecretsManager(), fake, clock)
    seed_connection(deps, USER, clock.now)
    seed_campaign(deps.store, USER, clock.now)
    fake.answer("list_my_campaigns", page([listed_campaign(access="open")]))
    return deps, fake, clock


def seed_post(deps: Any, **fields: Any) -> dict[str, Any]:
    item = {
        "pk": db.user_pk(USER),
        "sk": db.post_sk(POST),
        "type": "post",
        "postId": POST,
        "clipId": CLIP,
        "platform": "youtube",
        "status": "posted",
        "url": URL,
        "privacy": "public",
        "postedAt": iso(NOW - timedelta(minutes=1)),
        **fields,
    }
    deps.store.put(item)
    return item


def sub(deps: Any) -> dict[str, Any]:
    return deps.store.get(db.user_pk(USER), db.crsub_sk(POST)) or {}


def test_success_sends_once_with_the_frozen_key(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", {"id": "sub_1", "status": "pending"})
    assert submit.send(deps, USER, POST, UUID) == {"outcome": "sent", "pending": []}
    item = sub(deps)
    assert (item["state"], item["submissionId"], item["crStatus"], item["key"]) == ("sent", "sub_1", "pending", POST)
    assert item["deadline"] == iso(NOW - timedelta(minutes=1) + timedelta(minutes=25))
    assert item["sendBy"] == iso(NOW - timedelta(minutes=1) + timedelta(minutes=30))
    args, _headers, timeout = fake.calls("create_my_submission")[0]
    assert args == {"campaign": CMP, "url": URL, "idempotency_key": POST}
    assert timeout == 30.0
    assert connection.load(deps.store, USER)["crLinked"] == {"youtube": True}
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "sent"  # a replay never sends twice
    assert len(fake.calls("create_my_submission")) == 1


def test_a_changed_post_url_still_sends_the_frozen_one(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer(
        "create_my_submission", tool_error("resource_missing", status=404), {"id": "sub_1", "status": "pending"}
    )
    assert submit.send(deps, USER, POST, UUID)["pending"] == [POST]
    deps.store.update(db.user_pk(USER), db.post_sk(POST), {"url": "https://youtu.be/other"})
    submit.send(deps, USER, POST, UUID)
    urls = [a["url"] for a, _h, _t in fake.calls("create_my_submission")]
    assert urls == [URL, URL]
    assert {a["idempotency_key"] for a, _h, _t in fake.calls("create_my_submission")} == {POST}


def test_not_posted_writes_no_crsub(world: Any) -> None:
    deps, _fake, _clock = world
    seed_post(deps, status="failed")
    assert submit.send(deps, USER, POST, UUID) == {"outcome": "not_posted", "pending": []}
    assert sub(deps) == {}


def test_private_post(world: Any) -> None:
    deps, _fake, _clock = world
    seed_post(deps, privacy="private")
    submit.send(deps, USER, POST, UUID)
    assert (sub(deps)["state"], sub(deps)["reason"]["code"]) == ("not_sent", "private")


@pytest.mark.parametrize(
    ("conn", "campaign", "reason"),
    [
        ({"status": "not_connected"}, {}, "no_connection"),
        ({"status": "needs_reconnect"}, {}, "no_connection"),
        ({"status": "read_only", "canSubmit": False}, {}, "read_only"),
        ({"blocked": True}, {}, "read_only"),
        ({}, {"membership": "manual"}, "manual"),
        ({}, {"idMatch": "ambiguous"}, "ambiguous"),
    ],
)
def test_send_by_hand_cases(world: Any, conn: dict[str, Any], campaign: dict[str, Any], reason: str) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    if conn:
        deps.store.update(db.user_pk(USER), db.CRCONN_SK, conn)
    if campaign:
        deps.store.update(db.user_pk(USER), db.campaign_sk(UUID), campaign)
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "send_by_hand"
    assert sub(deps)["reason"]["code"] == reason
    assert fake.calls("create_my_submission") == []


def test_not_listed_and_paused(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("list_my_campaigns", page([]))
    deps._lists.clear()
    submit.send(deps, USER, POST, UUID)
    assert sub(deps)["reason"]["code"] == "not_listed"
    deps.store.delete(db.user_pk(USER), db.crsub_sk(POST))
    fake.answer("list_my_campaigns", page([listed_campaign(access="open", status="paused")]))
    deps._lists.clear()
    submit.send(deps, USER, POST, UUID)
    assert (sub(deps)["state"], sub(deps)["reason"]["code"]) == ("not_sent", "campaign_closed")


@pytest.mark.parametrize(
    ("answer", "state", "reason"),
    [
        (
            tool_error("permission_denied", "This campaign only takes posts from approved accounts."),
            "not_sent",
            "campaign_refused",
        ),
        (tool_error("conflict", "This post was already submitted."), "sent_by_hand", None),
        (tool_error("conflict", "You don't have a linked YouTube account."), "not_sent", "not_linked"),
        (
            tool_error("conflict", "This account isn't on your application for this campaign."),
            "not_sent",
            "not_on_application",
        ),
        (
            tool_error("conflict", "This campaign requires your YouTube account to be connected by signing in."),
            "not_sent",
            "relink",
        ),
        (tool_error("conflict", "This campaign doesn't accept Instagram."), "not_sent", "wrong_place"),
        (tool_error("conflict", "This post is shorter than the minimum of 30 seconds."), "not_sent", "too_short"),
        (tool_error("conflict", "Posts have to be submitted within 30 minutes."), "missed", None),
        (tool_error("conflict", "You have too many submissions not approved yet."), "not_sent", "held"),
        (tool_error("conflict", "This campaign is not active."), "not_sent", "campaign_closed"),
        (tool_error("budget_exhausted"), "not_sent", "campaign_closed"),
        (tool_error("conflict", "Something odd."), "not_sent", "refused"),
        (tool_error("creator_banned"), "not_sent", "banned"),
        (tool_error("creator_cap_reached"), "not_sent", "cap"),
        (tool_error("invalid_request"), "send_by_hand", "not_sent_by_app"),
        (tool_error("idempotency_key_reused"), "send_by_hand", "not_sent_by_app"),
        (tool_error("context_not_allowed"), "send_by_hand", "not_sent_by_app"),
        ({"__rpc_error__": {"code": -32600, "message": "bad"}}, "send_by_hand", "not_sent_by_app"),
    ],
)
def test_the_error_table(world: Any, answer: Any, state: str, reason: str | None) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("send_feedback", {"id": "fbk_1"})
    fake.answer("create_my_submission", answer)
    submit.send(deps, USER, POST, UUID)
    item = sub(deps)
    assert item["state"] == state
    assert (item.get("reason") or {}).get("code") == reason


def test_error_side_effects(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", tool_error("conflict", "You don't have a linked YouTube account."))
    submit.send(deps, USER, POST, UUID)
    assert connection.load(deps.store, USER)["crLinked"] == {"youtube": False}
    deps.store.delete(db.user_pk(USER), db.crsub_sk(POST))
    deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"crLinked": {"youtube": True}})
    fake.answer("create_my_submission", tool_error("conflict", "This account isn't on your application."))
    submit.send(deps, USER, POST, UUID)
    assert connection.load(deps.store, USER)["crLinked"] == {"youtube": True}  # not_on_application leaves it
    deps.store.delete(db.user_pk(USER), db.crsub_sk(POST))
    fake.answer("create_my_submission", tool_error("conflict", "Too many submissions are not approved yet."))
    submit.send(deps, USER, POST, UUID)
    assert "held" in (deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {})
    deps.store.delete(db.user_pk(USER), db.crsub_sk(POST))
    fake.answer("create_my_submission", tool_error("conflict", "This post is shorter than the minimum of 45 seconds."))
    submit.send(deps, USER, POST, UUID)
    campaign = deps.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert campaign["rules"]["lengthMinSec"] == 45
    assert "45 seconds" in sub(deps)["reason"]["text"]


def test_rpc_minus_32602_means_read_only(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", {"__rpc_error__": {"code": -32602, "message": "unknown tool"}})
    submit.send(deps, USER, POST, UUID)
    assert sub(deps)["reason"]["code"] == "read_only"
    conn = connection.load(deps.store, USER)
    assert (conn["status"], conn["canSubmit"]) == ("read_only", False)


def test_resource_missing_retries_until_the_deadline(world: Any) -> None:
    deps, fake, clock = world
    seed_post(deps)
    fake.answer("create_my_submission", tool_error("resource_missing", status=404))
    assert submit.send(deps, USER, POST, UUID) == {"outcome": "retry", "pending": [POST]}
    assert sub(deps)["state"] == "sending"
    clock.now = NOW + timedelta(minutes=25)
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "send_by_hand"
    assert sub(deps)["reason"]["code"] == "not_visible_yet"


def test_past_send_by_is_missed(world: Any) -> None:
    deps, fake, clock = world
    seed_post(deps)
    fake.answer("create_my_submission", tool_error("timeout", status=504))
    deps.remaining = lambda: 0.0  # no time for an in-step retry
    submit.send(deps, USER, POST, UUID)
    clock.now = NOW + timedelta(minutes=31)
    submit.send(deps, USER, POST, UUID)
    assert sub(deps)["state"] == "missed"


def test_service_unavailable_is_retried_in_the_step(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer(
        "create_my_submission", tool_error("service_unavailable", status=503), {"id": "sub_9", "status": "pending"}
    )
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "sent"
    assert len(fake.calls("create_my_submission")) == 2
    assert {a["idempotency_key"] for a, _h, _t in fake.calls("create_my_submission")} == {POST}


def test_network_errors_retry_with_the_same_key(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", NetworkError("reset"), {"id": "sub_2", "status": "pending"})
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "retry"
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "sent"


def test_send_never_raises(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", RuntimeError("client bug"))
    assert submit.send(deps, USER, POST, UUID) == {"outcome": "error", "pending": []}
    assert (sub(deps)["state"], sub(deps)["reason"]["code"]) == ("send_by_hand", "not_sent_by_app")


def test_one_campaign_per_post(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", {"id": "sub_1", "status": "pending"})
    submit.send(deps, USER, POST, UUID)
    other = "a1cefc3b-4533-438f-8e70-a7299550f1cf"
    assert submit.send(deps, USER, POST, other)["outcome"] == "other_campaign"
    assert sub(deps)["campaignId"] == UUID


def test_the_api_send_timeout_is_25s(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.answer("create_my_submission", {"id": "sub_1", "status": "pending"})
    submit.send(deps, USER, POST, UUID, timeout=25.0)
    assert fake.calls("create_my_submission")[0][2] == 25.0


def test_http_403_without_error_object_retries(world: Any) -> None:
    deps, fake, _clock = world
    seed_post(deps)
    fake.mcp_http = [None, response(403, b"")]  # list_my_campaigns goes through, the submit hits the firewall
    fake.answer("create_my_submission", {"id": "sub_1", "status": "pending"})
    assert submit.send(deps, USER, POST, UUID)["outcome"] == "retry"
