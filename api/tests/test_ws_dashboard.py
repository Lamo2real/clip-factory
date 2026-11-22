"""GET /v1/workspaces/{ws}/dashboard (docs/CONTRACTS.md §45.16.3): every tile from this workspace's own items."""

from __future__ import annotations

import json
import time
from datetime import timedelta
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import apps, sentences, social
from clipfactory_api.workspaces import secrets as ws_secrets
from conftest import OTHER, USER, Call, Clock
from fakes import FakeS3, FakeSecretsManager
from test_oauth_state_formats import GOOD
from ws_support import BASE, caller, install, pk, seed_character, seed_item, seed_job, seed_story


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, s3_client: FakeS3) -> None:
    install(app, None, s3_client)


def test_an_empty_dashboard(call: Call) -> None:
    status, body = call("GET", f"{BASE}/dashboard")
    assert status == 200
    d = body["dashboard"]
    assert d["counts"] == {"made": 0, "review": 0, "published": 0, "producing": 0, "needsCheck": 0, "needsYou": 0}
    assert d["needsYou"] == []
    assert d["producing"] == []
    assert d["activity"] == []
    assert [a["platform"] for a in d["accounts"]] == ["youtube", "tiktok", "instagram", "facebook", "x"]
    assert {a["status"] for a in d["accounts"]} == {"not_connected"}
    assert d["performance"] == {
        "views": 0,
        "likes": 0,
        "comments": 0,
        "shares": 0,
        "posts": 0,
        "checkedAt": None,
        "lastAt": None,
    }


def test_every_tile(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    review = seed_story(store, s3_client, title="In review")
    check = seed_story(store, s3_client, status="needs_check", title="Facts")
    published = seed_story(store, s3_client, status="published", title="Out")
    seed_story(store, s3_client, status="failed", made=False)
    making = seed_story(store, s3_client, status="producing", made=False, title="Making")
    steps = [
        {"key": k, "label": k, "status": s}
        for k, s in [
            ("storyboard", "done"),
            ("safety", "done"),
            ("scenes", "running"),
            ("animation", "pending"),
            ("sound", "pending"),
            ("captions", "pending"),
            ("assemble", "pending"),
            ("preview", "pending"),
        ]
    ]
    steps[2]["i"], steps[2]["n"] = 1, 2
    job = seed_job(store, making, steps=steps)
    store.update(making["pk"], making["sk"], {"currentJobId": job["jobId"]})
    # Publishing jobs (story flow, read only): one failed then posted again (not shown), one needing the owner.
    seed_item(
        store,
        "PUBJOB#01J0000000000000000000PJ1",
        "ws_pubjob",
        publishingJobId="01J0000000000000000000PJ1",
        contentId=published["storyId"],
        platform="youtube",
        publishingStatus="failed",
        error="x",
        createdAt="2026-11-15T10:00:00.000Z",
    )
    seed_item(
        store,
        "PUBJOB#01J0000000000000000000PJ2",
        "ws_pubjob",
        publishingJobId="01J0000000000000000000PJ2",
        contentId=published["storyId"],
        platform="youtube",
        publishingStatus="posted",
        postedAt="2026-11-15T10:30:00.000Z",
        createdAt="2026-11-15T10:10:00.000Z",
        metrics={"views": 100, "likes": 10, "comments": None, "shares": 2, "checkedAt": "2026-11-15T11:30:00.000Z"},
    )
    seed_item(
        store,
        "PUBJOB#01J0000000000000000000PJ3",
        "ws_pubjob",
        publishingJobId="01J0000000000000000000PJ3",
        contentId=published["storyId"],
        platform="tiktok",
        publishingStatus="needs_attention",
        error="Make the Lamo Stories TikTok account private until TikTok approves the app, then tap Try again.",
        createdAt="2026-11-15T10:20:00.000Z",
    )
    seed_item(
        store,
        "SOCIAL#youtube",
        "ws_social",
        platform="youtube",
        connectionStatus="connected",
        accountName="Lamo Stories Channel",
    )
    seed_item(
        store,
        "SOCIAL#facebook",
        "ws_social",
        platform="facebook",
        connectionStatus="needs_reconnect",
        accountName="Lamo Page",
    )
    seed_item(
        store,
        "SOCIAL#instagram",
        "ws_social",
        platform="instagram",
        connectionStatus="connected",
        accountName="lamostories",
        warning="Lamo Clips may have lost Instagram. Connect it again in Lamo Clips, keeping its Page ticked.",
    )
    for n in range(12):
        seed_item(
            store,
            f"ACT#2026-11-15T09:{n:02d}:00.000Z#{n}",
            "ws_activity",
            at=f"2026-11-15T09:{n:02d}:00.000Z",
            kind="made",
            storyId=review["storyId"],
            title="In review",
        )
    # Another owner's and Lamo Clips' items never count.
    seed_item(
        store,
        "PUBJOB#01J0000000000000000000PJ9",
        "ws_pubjob",
        user=OTHER,
        contentId="x",
        platform="x",
        publishingStatus="failed",
    )
    store.put(
        {
            "pk": pk(),
            "sk": "SOCIAL#x",
            "type": "ws_social",
            "userId": OTHER,
            "workspaceId": "stories",
            "platform": "x",
            "connectionStatus": "needs_reconnect",
        }
    )
    d = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
    assert d["counts"] == {"made": 3, "review": 1, "published": 1, "producing": 1, "needsCheck": 1, "needsYou": 4}
    you = d["needsYou"]
    assert [(n["platform"], n["href"]) for n in you] == [
        ("tiktok", f"/stories/review/{published['storyId']}"),
        ("instagram", "/stories/connections"),
        ("facebook", "/stories/connections"),
        (None, f"/stories/review/{check['storyId']}"),
    ]
    assert you[0]["sentence"].startswith("Make the Lamo Stories TikTok account private")
    assert you[0]["publishingJobId"] == "01J0000000000000000000PJ3"
    assert you[0]["title"] == "Out"
    assert (
        you[2]["sentence"]
        == "This Facebook account (Lamo Page) needs connecting again. Open Social accounts and tap Connect."
    )
    assert d["producing"] == [{"storyId": making["storyId"], "title": "Making", "step": "scenes", "progress": 0.3125}]
    accounts = {a["platform"]: a for a in d["accounts"]}
    assert accounts["youtube"] == {"platform": "youtube", "status": "connected", "accountName": "Lamo Stories Channel"}
    assert accounts["x"]["status"] == "not_connected"
    assert d["performance"] == {
        "views": 100,
        "likes": 10,
        "comments": 0,
        "shares": 2,
        "posts": 1,
        "checkedAt": "2026-11-15T11:30:00.000Z",
        "lastAt": "2026-11-22T10:30:00.000Z",
    }
    assert len(d["activity"]) == 10
    assert d["activity"][0] == {
        "at": "2026-11-15T09:11:00.000Z",
        "kind": "made",
        "storyId": review["storyId"],
        "title": "In review",
    }


def test_the_dashboard_is_a_lamo_stories_page(call: Call) -> None:
    status, body = call("GET", "/v1/workspaces/clips/dashboard")
    assert status == 409
    assert body["error"]["message"] == "That is a Lamo Stories page. Switch to Lamo Stories first."


# --- §45.35 D11: the accounts as Social accounts shows them, Fix it for an account problem --------------------


def test_the_dashboards_accounts_are_the_ones_social_accounts_shows(
    app: App, call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    """Lamo Clips connected the same YouTube channel later (nobody shared it) and TikTok's app keys changed: the
    stored ``SOCIAL#`` items still say ``connected``. The dashboard works both out like the Social accounts page
    (``social.public_of``) and stores them, so every screen says the same."""
    sup.install(app, secrets_client)
    sup.social(store, secrets_client, "youtube", identity="UC-same")
    sup.social(store, secrets_client, "tiktok")
    sup.social(store, secrets_client, "x")
    sup.clips_account(store, None, "youtube", accountId="UC-same")
    new = {**GOOD["tiktok"], "clientId": "awproductionkeys12345"}
    secrets_client.values["cf-prod/platforms/tiktok/app"] = json.dumps(new)
    d = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
    accounts = {a["platform"]: a for a in d["accounts"]}
    assert accounts["youtube"] == {
        "platform": "youtube",
        "status": "same_as_clips",
        "accountName": "Lamo Stories youtube",
    }
    assert accounts["tiktok"]["status"] == "needs_reconnect"
    assert accounts["x"]["status"] == "connected"
    # settled: the stored items now say what the page shows
    assert store.get(pk(), "SOCIAL#youtube")["connectionStatus"] == "same_as_clips"
    assert (store.get(pk(), "SOCIAL#tiktok")["connectionStatus"], store.get(pk(), "SOCIAL#tiktok")["reason"]) == (
        "needs_reconnect",
        "keys_changed",
    )
    you = [n for n in d["needsYou"] if n["platform"] == "tiktok"]
    assert [(n["href"], n["sentence"]) for n in you] == [
        ("/stories/connections", "This TikTok account (Lamo Stories tiktok) needs connecting again. Open Social "
                                 "accounts and tap Connect."),
    ]  # fmt: skip
    # the same as the Social accounts page itself
    page = {a["platform"]: a["connectionStatus"] for a in sup.ws_call(app)("GET", f"{BASE}/social")[1]["accounts"]}
    assert {p: a["status"] for p, a in accounts.items()} == page


def test_a_secret_that_cannot_be_read_never_breaks_the_dashboard(
    app: App, call: Call, store: db.Store, secrets_client: FakeSecretsManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    sup.install(app, secrets_client)
    sup.social(store, secrets_client, "youtube")

    def down(*_a: object, **_k: object) -> None:
        raise RuntimeError("Secrets Manager is down")

    monkeypatch.setattr(apps, "app_keys", down)
    status, body = call("GET", f"{BASE}/dashboard")
    assert status == 200
    assert {a["platform"]: a["status"] for a in body["dashboard"]["accounts"]}["youtube"] == "connected"


class _SlowClock:
    """``time.monotonic`` for ``workspaces.social``: every secret read moves it on by ``step`` seconds."""

    def __init__(self) -> None:
        self.start = time.monotonic()
        self.waited = 0.0

    def monotonic(self) -> float:
        return self.start + self.waited


@pytest.mark.parametrize("answers", [False, True])
def test_a_slow_secrets_manager_never_holds_the_dashboard_past_its_29_seconds(
    app: App,
    call: Call,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    monkeypatch: pytest.MonkeyPatch,
    answers: bool,
) -> None:
    """Every platform connected and each key read slow: failing ones after the worst wait (both attempts time out),
    or answering ones after 6 s each. The dashboard stops waiting on Secrets Manager after the first failure, and
    before one more slow read could pass the request's 29 s; every account is still shown."""
    sup.install(app, secrets_client)
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        sup.social(store, secrets_client, platform)
    clock = _SlowClock()
    monkeypatch.setattr(social, "time", clock)
    real = apps.app_keys
    reads: list[str] = []

    def slow(*a: Any, **k: Any) -> Any:
        reads.append(str(a[4]))
        if not answers:
            clock.waited += ws_secrets.WORST_READ_SECONDS
            raise TimeoutError("Secrets Manager did not answer")
        clock.waited += 6.0
        return real(*a, **k)

    monkeypatch.setattr(apps, "app_keys", slow)
    status, body = call("GET", f"{BASE}/dashboard")
    assert status == 200, body
    assert {a["status"] for a in body["dashboard"]["accounts"]} == {"connected"}
    assert len(reads) == (1 if not answers else 2)  # never one read per platform
    assert clock.waited + social.DASHBOARD_SPARE_SECONDS <= social.DASHBOARD_REQUEST_SECONDS


def test_without_posting_switched_on_the_dashboard_still_compares_with_lamo_clips(call: Call, store: db.Store) -> None:
    """No secrets wrapper (``WS_SECRET_PREFIX`` unset): the app keys are not checked, Lamo Clips' identity is."""
    seed_item(store, "SOCIAL#youtube", "ws_social", platform="youtube", connectionStatus="connected",
              externalAccountId="UC-same", accountName="Lamo Stories Channel", updatedAt="2026-11-15T10:00:00.000Z")  # fmt: skip
    store.put({"pk": f"USER#{USER}", "sk": "ACCOUNT#youtube", "platform": "youtube", "status": "connected",
               "accountId": "UC-same"})  # fmt: skip
    d = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
    assert {a["platform"]: a["status"] for a in d["accounts"]}["youtube"] == "same_as_clips"


@pytest.mark.parametrize(
    ("kind", "href"),
    [
        ("reconnect", "/stories/connections"),
        ("token_dead", "/stories/connections"),
        ("not_connected", "/stories/connections"),
        ("keys_changed", "/stories/connections"),
        ("same_as_clips", "/stories/connections"),
        ("private", "review"),
        ("daily", "review"),
        ("clips_unknown", "review"),  # Try again on the video checks the account first
        ("down", "review"),
    ],
)
def test_fix_it_opens_social_accounts_for_an_account_problem(
    call: Call, store: db.Store, s3_client: FakeS3, kind: str, href: str
) -> None:
    story = seed_story(store, s3_client, status="approved", title="Out")
    sentence = sentences.story_sentence("tiktok", kind, "Lamo Stories")
    seed_item(store, "PUBJOB#01J0000000000000000000PJ1", "ws_pubjob", publishingJobId="01J0000000000000000000PJ1",
              contentId=story["storyId"], platform="tiktok", publishingStatus="needs_attention", error=sentence,
              createdAt="2026-11-15T10:20:00.000Z")  # fmt: skip
    (shown,) = call("GET", f"{BASE}/dashboard")[1]["dashboard"]["needsYou"]
    assert shown["sentence"] == sentence
    assert shown["href"] == (f"/stories/review/{story['storyId']}" if href == "review" else href)


def test_a_job_the_api_fails_itself_shows_in_recent_activity(
    call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    """§45.35 D11: the stale-heartbeat fence and a start that did not happen fail the video like the agent does,
    and like the agent they write a ``failed`` activity in the same transaction."""
    making = seed_story(store, s3_client, status="producing", made=False, title="Ice")
    job = seed_job(store, making, status="running", heartbeatAt="2026-11-15T11:00:00.000Z")
    store.update(making["pk"], making["sk"], {"currentJobId": job["jobId"]})
    d = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
    assert d["counts"]["producing"] == 0
    assert d["activity"][0] == {"at": "2026-11-15T12:00:00.000Z", "kind": "failed", "storyId": making["storyId"],
                                "title": "Ice"}  # fmt: skip
    # read again: the fenced job is not failed (or written) twice
    again = call("GET", f"{BASE}/dashboard")[1]["dashboard"]
    assert [a["kind"] for a in again["activity"]].count("failed") == 1
    # a start that did not happen (the video maker not switched on) is written too
    hero = seed_character(store, name="Lamo")
    brief = {"title": "Snow", "logline": "Snow on the road.", "category": "comedy"}
    clock.now += timedelta(minutes=1)
    status, body = call("POST", f"{BASE}/stories", {"brief": brief, "characterIds": [hero["characterId"]]})
    assert (status, body["job"]["status"]) == (201, "failed")
    latest = call("GET", f"{BASE}/dashboard")[1]["dashboard"]["activity"][0]
    assert (latest["kind"], latest["storyId"], latest["title"]) == ("failed", body["story"]["storyId"], "Snow")
    assert [i for i in store.query_all(pk(), "ACT#") if i.get("kind") == "failed"] == [
        i for i in store.query_all(pk(), "ACT#") if i.get("userId") == USER and i.get("kind") == "failed"
    ]
