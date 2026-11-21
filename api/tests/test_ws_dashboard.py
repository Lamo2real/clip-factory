"""GET /v1/workspaces/{ws}/dashboard (docs/CONTRACTS.md §45.16.3): every tile from this workspace's own items."""

from __future__ import annotations

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from conftest import OTHER, Call
from fakes import FakeS3
from ws_support import BASE, install, pk, seed_item, seed_job, seed_story


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
        == "Lamo Stories' Facebook (Lamo Page) needs connecting again. Open Connections and tap Connect."
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
