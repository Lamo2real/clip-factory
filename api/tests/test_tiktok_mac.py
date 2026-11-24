"""Your Mac posts it on TikTok (docs/CONTRACTS.md §47; tests §47.5): the Mac post, the helper's routes and the owner's.

Every rule is its own test: a Mac post is never ``queued`` (so it is never released, tried again, posted now or
published by the clip flow), the clip settles as usual, Upload's API TikTok rule is unchanged with the switch off,
campaign clips never get one (D1), the queue and its off switches, the claim races (a crashed helper, never twice after
Post was pressed), the stuck rule (beats, the 50-minute cap, the find window), done through ``tiktok_self.mark_posted``
(repeat-safe, one TikTok post per clip), It's on TikTok vs the Mac, Take it back, Send these to my Mac, Try again, the
ping's plan keys and the owner's requests. Offline: in-memory items and fakes only.
"""

from __future__ import annotations

import json
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from clipfactory_api import db, posts, release, tiktok_find, tiktok_mac, tiktok_self, uploads
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.flows.clip_flow import run_clip_flow
from clipfactory_api.ids import ulid
from conftest import CLIP_FLOW_ARN, NOW, USER, Call, Clock, seed_clip
from fakes import FakeDurableContext, FakeLambda, FakeTable
from test_campaign_posting import CAMPAIGN, campaign_clip, put_campaign
from test_campaign_posting import ready as ready_with_audit
from test_flows import FakeAdapter, _clip_deps

PK = db.user_pk(USER)
TIKTOK = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": False,
    "disableDuet": True,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}
MINE = {**TIKTOK, "disableDuet": False}  # My settings: Everyone, Comment, Duet and Stitch on
VIDEO_ID = "7710644811602169121"
LINK = f"https://www.tiktok.com/@lamo.clips/video/{VIDEO_ID}"
DEVICE = "mac-studio-1"


# --- helpers -----------------------------------------------------------------------------------------------------


def _connect(store: db.Store, *platforms: str, handle: str = "@lamo.clips") -> None:
    for platform in platforms:
        store.put(
            {
                "pk": PK,
                "sk": f"ACCOUNT#{platform}",
                "type": "account",
                "userId": USER,
                "platform": platform,
                "status": "connected",
                **({"handle": handle} if platform == "tiktok" else {}),
            }
        )


def _audited(store: db.Store) -> None:
    store.put(
        {
            "pk": PK,
            "sk": "SETUP#tiktok",
            "type": "setup",
            "platform": "tiktok",
            "gates": {"app_review": {"value": "live"}, "posting_audit": {"state": "ok"}},
        }
    )


def _mac_on(call: Call, on: bool = True) -> None:
    assert call("PUT", "/v1/settings", {"tiktokMac": {"on": on}})[0] == 200


def _upload(call: Call, clip_id: str, platforms: list[str], tiktok: dict[str, Any] | None = TIKTOK) -> Any:
    body: dict[str, Any] = {"platforms": platforms}
    if tiktok is not None:
        body["tiktok"] = tiktok
    status, out = call("POST", f"/v1/clips/{clip_id}/confirm", body)
    assert status == 200, out
    return out


def _raw_tiktok(table: FakeTable, clip_id: str) -> dict[str, Any] | None:
    found = [
        i for i in table.all() if i.get("type") == "post" and i.get("clipId") == clip_id and i["platform"] == "tiktok"
    ]
    assert len(found) <= 1, "never two TikTok posts for one clip"
    return found[0] if found else None


def _tiktok(body: Any) -> dict[str, Any]:
    return next(p for p in body["posts"] if p["platform"] == "tiktok")


def _starts(lambda_client: FakeLambda) -> list[str]:
    return [c["DurableExecutionName"] for c in lambda_client.calls if c["FunctionName"] == CLIP_FLOW_ARN]


def _mac_clip(store: db.Store, *, status: str = "confirmed", source: str = "upload", **mac: Any) -> dict[str, Any]:
    """An uploaded clip whose one TikTok post is a Mac post (``madeForMac``), plus anything in ``mac``."""
    clip = seed_clip(store, status=status, postsCreated=True, publishState="started", flowRun=1, postIds=[])
    fields = {**posts.new_mac_fields(source, "2026-11-15T11:00:00.000Z"), "madeForMac": True, "postOptions": TIKTOK}
    _post(store, clip, "tiktok", **{**fields, **mac})
    return store.get(clip["pk"], clip["sk"]) or clip


def _post(store: db.Store, clip: dict[str, Any], platform: str, **fields: Any) -> dict[str, Any]:
    post_id = ulid()
    item = {
        "pk": PK,
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": USER,
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        "createdAt": "2026-11-15T11:00:00.000Z",
        "flowRun": 1,
        **fields,
    }
    store.put(item)
    stored = store.get(clip["pk"], clip["sk"]) or clip
    store.update(clip["pk"], clip["sk"], {"postIds": [*(stored.get("postIds") or []), post_id]})
    return item


def _raw_post(store: db.Store, clip_id: str) -> dict[str, Any]:
    """The clip's TikTok post as stored (internal fields included)."""
    found = [p for p in posts.posts_for_clip(store, USER, clip_id, consistent=True) if p.get("platform") == "tiktok"]
    assert len(found) == 1
    return found[0]


def _claim(call: Call, clip_id: str, device: str = DEVICE) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/tiktok/mac/claim", {"device": device})


def _step(call: Call, clip_id: str, step: str, device: str = DEVICE) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/tiktok/mac/step", {"device": device, "step": step})


def _message(body: Any) -> str:
    return str(body["error"]["message"])


# --- the setting --------------------------------------------------------------------------------------------------


def test_the_switch_is_off_by_default_merged_on_put_and_strict(call: Call) -> None:
    assert call("GET", "/v1/settings")[1]["settings"]["tiktokMac"] == {"on": False}
    status, body = call("PUT", "/v1/settings", {"tiktokMac": {"on": True}})
    assert (status, body["settings"]["tiktokMac"]) == (200, {"on": True})
    assert call("PUT", "/v1/settings", {"tiktokMac": {}})[1]["settings"]["tiktokMac"] == {"on": True}  # merged
    status, body = call("PUT", "/v1/settings", {"tiktokMac": {"on": True, "every": 3}})
    assert (status, _message(body)) == (400, "tiktokMac has a setting Clip Factory does not know.")
    assert call("PUT", "/v1/settings", {"tiktokMac": {"on": "yes"}})[0] == 400
    assert call("PUT", "/v1/settings", {"tiktokMac": True})[0] == 400


# --- Upload (§47.2 rule 1) ------------------------------------------------------------------------------------------


def test_upload_with_the_switch_on_writes_tiktok_as_a_mac_post_in_the_same_transaction(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "youtube", "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    before = len(table.calls)
    body = _upload(call, clip["clipId"], ["youtube", "tiktok"])
    tiktok = _tiktok(body)
    assert tiktok["status"] == "mac"
    assert tiktok["mac"] == {"state": "waiting", "since": iso(NOW), "source": "upload"}
    assert next(p for p in body["posts"] if p["platform"] == "youtube")["status"] == "queued"
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    # Every Mac post asks the Mac for My settings' choices, whatever the sheet said (§47.1).
    assert (raw["madeForMac"], raw["macAttempt"], raw["postOptions"]) == (True, 0, MINE)
    assert body["clip"]["uploadTo"] == ["youtube", "tiktok"]  # he chose TikTok; his Mac posts it
    writes = [c for c in table.calls[before:] if c[0] == "transact_write_items"]
    assert len(writes) == 1  # the clip and both posts, in one transaction
    assert len([a for a in writes[0][1]["TransactItems"] if "Put" in a]) == 2
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-1"]
    # The public shape never shows the internal fields.
    for key in ("madeForMac", "macAttempt", "macState", "postOptions", "beforeMac"):
        assert key not in tiktok


def test_upload_with_the_switch_off_keeps_tiktoks_api_rule(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube", "tiktok")
    clip = seed_clip(store)
    tiktok = _tiktok(_upload(call, clip["clipId"], ["youtube", "tiktok"]))
    assert tiktok["status"] == "queued"
    assert "mac" not in tiktok
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert not any(k.startswith("mac") for k in raw)


def test_upload_once_tiktok_approved_the_app_keeps_tiktoks_api_rule(call: Call, store: db.Store) -> None:
    _connect(store, "tiktok")
    _audited(store)
    _mac_on(call)
    clip = seed_clip(store)
    assert _tiktok(_upload(call, clip["clipId"], ["tiktok"]))["status"] == "queued"


def test_upload_still_needs_the_tiktok_choices(call: Call, store: db.Store) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["tiktok"]})
    assert (status, _message(body)) == (400, "Pick who can see it on TikTok.")


def test_upload_without_tiktok_makes_no_mac_post(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube", "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    _upload(call, clip["clipId"], ["youtube"], tiktok=None)
    assert _raw_tiktok(table, clip["clipId"]) is None


def test_a_campaign_clip_never_goes_to_the_mac(call: Call, store: db.Store, table: FakeTable) -> None:
    # D1: the Mac can't mark a post as Branded content yet, and Content Rewards never receives what it posts. Posting
    # audit ok but the app review not live is not TikTok's approval: Upload with TikTok is refused, nothing written.
    ready_with_audit(store, "tiktok", audit="ok")
    put_campaign(store, platformsPaid=["tiktok"])
    _mac_on(call)
    clip = campaign_clip(store)
    status, body = call(
        "POST",
        f"/v1/clips/{clip['clipId']}/confirm",
        {"platforms": ["tiktok"], "tiktok": {**TIKTOK, "brandContent": True}},
    )
    assert (status, _message(body)) == (
        400,
        f"{tiktok_mac.CAMPAIGN_SKIPS} Turn TikTok off, then tap Upload.",
    )
    assert _raw_tiktok(table, clip["clipId"]) is None
    assert call("GET", "/v1/tiktok/mac")[1]["queue"] == []


def test_once_tiktok_approved_the_app_a_campaign_clip_goes_through_its_api(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    # With TikTok's approval its own API posts it, with the sheet's Branded content: still never a Mac post.
    ready_with_audit(store, "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["tiktok"])
    _mac_on(call)
    clip = campaign_clip(store)
    status, body = call(
        "POST",
        f"/v1/clips/{clip['clipId']}/confirm",
        {"platforms": ["tiktok"], "tiktok": {**TIKTOK, "brandContent": True}},
    )
    assert status == 200, body
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["status"], raw["campaignId"], raw["postOptions"]["brandContent"]) == ("queued", CAMPAIGN, True)
    assert not [k for k in raw if k.startswith("mac") or k == "madeForMac"]
    assert call("GET", "/v1/tiktok/mac")[1]["queue"] == []


def test_an_auto_posting_run_never_gives_a_campaign_clip_a_mac_post(
    app: App, store: db.Store, table: FakeTable
) -> None:
    ready_with_audit(store, "youtube")
    put_campaign(store, platformsPaid=["youtube"])
    store.put({"pk": PK, "sk": "SETTINGS", "type": "settings", "userId": USER, "tiktokMac": {"on": True}})
    clip = campaign_clip(store)
    uploads.upload_review_clip(
        app, USER, clip, platforms=["youtube"], auto={"runId": "r#scheduled", "at": iso(NOW)}, tiktok_mac=True
    )
    assert _raw_tiktok(table, clip["clipId"]) is None
    assert {p["platform"] for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)} == {"youtube"}


def test_a_private_test_never_gets_a_mac_post(app: App, store: db.Store, table: FakeTable) -> None:
    _connect(store, "youtube")
    store.put({"pk": PK, "sk": "SETTINGS", "type": "settings", "userId": USER, "tiktokMac": {"on": True}})
    clip = seed_clip(store)
    uploads.upload_review_clip(
        app,
        USER,
        clip,
        platforms=["youtube"],
        auto={"runId": "r#private_now", "at": iso(NOW), "test": "private"},
        tiktok_mac=True,
    )
    assert _raw_tiktok(table, clip["clipId"]) is None


# --- never TikTok's API (§47.1) --------------------------------------------------------------------------------------


def test_the_clip_flow_never_publishes_a_mac_post_and_the_clip_settles_as_usual(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _connect(store, "youtube", "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    _upload(call, clip["clipId"], ["youtube", "tiktok"])
    youtube, tiktok = FakeAdapter("youtube"), FakeAdapter("tiktok")
    ctx = FakeDurableContext()
    out = run_clip_flow(
        ctx,
        {"clipId": clip["clipId"], "userId": USER, "run": 1},
        _clip_deps(store, {"youtube": youtube, "tiktok": tiktok}),
    )
    assert tiktok.published == []  # TikTok's API never sees it
    assert not any("tiktok" in step for step in ctx.steps)
    assert ctx.steps[0] == "ensure-posts"
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["status"], raw["macState"]) == ("mac", "waiting")
    # The other place posted: the clip settles as posted, the Mac post still waits.
    assert (table.raw(clip["pk"], clip["sk"]) or {})["status"] == "posted"
    assert out["outcome"] == "done"


def test_a_tiktok_only_upload_stays_confirmed_until_the_mac_is_done(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    _upload(call, clip["clipId"], ["tiktok"])
    tiktok = FakeAdapter("tiktok")
    ctx = FakeDurableContext()
    out = run_clip_flow(
        ctx, {"clipId": clip["clipId"], "userId": USER, "run": 1}, _clip_deps(store, {"tiktok": tiktok})
    )
    assert out["outcome"] == "not_posted"
    assert ctx.steps == ["ensure-posts", "settle-clip", "upsert-vector"]
    assert tiktok.published == []
    assert (table.raw(clip["pk"], clip["sk"]) or {})["status"] == "confirmed"  # nothing queued, nothing posted
    assert _claim(call, clip["clipId"])[0] == 200
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    assert body["clip"]["status"] == "posted"


def test_ensure_posts_on_a_mac_post_never_marks_the_clip_publishing(store: db.Store) -> None:
    clip = _mac_clip(store)
    run_clip_flow(FakeDurableContext(), {"clipId": clip["clipId"], "userId": USER, "run": 1}, _clip_deps(store, {}))
    assert (store.get(clip["pk"], clip["sk"]) or {})["status"] == "confirmed"


def test_release_waiting_never_releases_a_mac_post(app: App, store: db.Store, lambda_client: FakeLambda) -> None:
    _connect(store, "tiktok")
    clip = _mac_clip(store, status="posted")
    assert release.release_waiting(store, app.flows, USER, "tiktok") == 0
    raw = tiktok_self.tiktok_row(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True))
    assert raw is not None
    assert (raw["status"], raw["flowRun"]) == ("mac", 1)
    assert _starts(lambda_client) == []


def test_try_again_and_post_now_never_send_a_mac_post(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "tiktok")
    clip = _mac_clip(store, status="posted")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["tiktok"], "tiktok": TIKTOK})
    assert status == 200
    assert _tiktok(body)["status"] == "mac"
    assert _starts(lambda_client) == []
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["status"], raw["flowRun"], raw["postOptions"]) == ("mac", 1, TIKTOK)


def test_a_failed_clips_try_again_and_release_restart_leave_the_mac_post_alone(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "youtube")
    clip = _mac_clip(store, status="failed", publishState="pending")
    youtube = _post(store, clip, "youtube", status="failed", error="Posting to YouTube did not work. Press Try again.")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {})
    assert status == 200
    assert body["clip"]["status"] == "confirmed"
    found = {p["platform"]: p for p in body["posts"]}
    assert found["youtube"]["status"] == "queued"
    assert found["tiktok"]["status"] == "mac"
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert raw["flowRun"] == 1  # never carried to the new run (only queued posts are)
    assert (table.raw(PK, db.post_sk(youtube["postId"])) or {})["flowRun"] == 2
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2"]


def test_release_restart_never_carries_a_mac_post(app: App, store: db.Store) -> None:
    clip = _mac_clip(store, publishState="pending")
    youtube = _post(store, clip, "youtube", status="failed")
    rows = posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)
    release.restart(store, app.flows, clip, [p for p in rows if p["postId"] == youtube["postId"]], clip_posts=rows)
    mac = tiktok_self.tiktok_row(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True))
    assert mac is not None
    assert (mac["status"], mac["flowRun"]) == ("mac", 1)


@pytest.mark.parametrize(
    ("status", "others", "now_posted", "expected"),
    [
        ("confirmed", [], False, {}),  # a Mac post alone: nothing queued or posted, the clip stays confirmed
        ("posted", [{"status": "posted"}], False, {}),
        ("failed", [{"status": "failed"}], False, {}),
        ("confirmed", [], True, {"status": "posted"}),  # the Mac (or he) posted it
        ("posted", [], False, {"status": "confirmed"}),
    ],
)
def test_the_clip_status_rule_never_counts_a_mac_post_as_queued(
    status: str, others: list[dict[str, Any]], now_posted: bool, expected: dict[str, Any]
) -> None:
    mac = {"status": "mac", "macState": "working"}
    assert tiktok_self._clip_status(status, [*others, mac], now_posted=now_posted) == expected


# --- the helper's queue, ping and claim (§47.3) ------------------------------------------------------------------------


def test_the_queue_is_empty_while_the_switch_is_off(call: Call, store: db.Store) -> None:
    _mac_clip(store)
    assert call("GET", "/v1/tiktok/mac")[1] == {"on": False, "helper": None, "queue": []}


def test_the_queue_order_and_its_jobs(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    old_auto = _mac_clip(store, source="auto", macSince="2026-11-15T08:00:00.000Z")
    sent = _mac_clip(store, source="sent", macSince="2026-11-15T09:00:00.000Z")
    upload = _mac_clip(store, source="upload", macSince="2026-11-15T10:00:00.000Z")
    store.update(PK, db.clip_sk(upload["clipId"]), {"hook": "Lost it 💀 è", "captions": {"tiktok": "café √©"}})
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [j["clipId"] for j in queue] == [upload["clipId"], old_auto["clipId"], sent["clipId"]]
    first = queue[0]
    assert first == {
        "clipId": upload["clipId"],
        "postId": first["postId"],
        "hook": "Lost it 💀 è",
        "caption": "café é",  # stored caption, repaired (§5) and NFC
        "fileName": "clip-factory-Lost-it-e.mp4",
        "privacy": "PUBLIC_TO_EVERYONE",
        "comment": True,
        "duet": False,
        "stitch": True,
        "source": "upload",
        "since": "2026-11-15T10:00:00.000Z",
        "state": "waiting",
        "attempt": 0,
    }


def test_auto_posted_mac_posts_wait_while_auto_posting_is_off(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    auto = _mac_clip(store, source="auto")
    upload = _mac_clip(store, source="upload")
    working = _mac_clip(store, source="auto", macState="working", macDevice=DEVICE, macBeatAt=iso(NOW))
    pressed = _mac_clip(
        store, source="auto", macState="working", macDevice=DEVICE, macBeatAt=iso(NOW), macPressedAt=iso(NOW)
    )
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    # "While it is off, nothing posts": an auto post waits, also one a Mac claimed but never pressed Post for. One
    # whose Post was pressed stays, so its Mac can still find the link.
    assert {j["clipId"] for j in queue} == {upload["clipId"], pressed["clipId"]}
    status, body = _claim(call, auto["clipId"])
    assert (status, _message(body)) == (409, "Auto-posting is off, so this one waits.")
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    assert {auto["clipId"], working["clipId"]} <= {j["clipId"] for j in call("GET", "/v1/tiktok/mac")[1]["queue"]}


def test_turning_auto_posting_off_stops_an_auto_post_the_mac_already_claimed(
    call: Call, store: db.Store, clock: Clock
) -> None:
    """The auto-posting review's case: claimed, then auto-posting goes off (the Mac slept, or he turned it off), then
    the Mac wakes and carries on. Nothing more happens before Post: the step is refused and the post waits again."""
    _mac_on(call)
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    auto = _mac_clip(store, source="auto")
    assert _claim(call, auto["clipId"])[0] == 200
    assert _step(call, auto["clipId"], "uploading")[0] == 200
    call("PUT", "/v1/settings", {"autoPost": {"on": False}})
    status, body = _step(call, auto["clipId"], "pressing")
    assert (status, _message(body)) == (409, "Auto-posting is off, so this one waits.")
    raw = _raw_post(store, auto["clipId"])
    assert raw["macState"] == "waiting"
    assert not {"macPressedAt", "macDevice", "macClaimedAt", "macStep", "macBeatAt"} & set(raw)
    status, body = _claim(call, auto["clipId"])
    assert (status, _message(body)) == (409, "Auto-posting is off, so this one waits.")
    assert auto["clipId"] not in {j["clipId"] for j in call("GET", "/v1/tiktok/mac")[1]["queue"]}
    # On again: it is claimed and posted as usual.
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    assert _claim(call, auto["clipId"])[0] == 200
    assert _step(call, auto["clipId"], "pressing")[0] == 200


def test_after_post_was_pressed_turning_auto_posting_off_still_lets_the_mac_find_the_link(
    call: Call, store: db.Store, clock: Clock
) -> None:
    _mac_on(call)
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    auto = _mac_clip(store, source="auto")
    assert _claim(call, auto["clipId"])[0] == 200
    assert _step(call, auto["clipId"], "pressing")[0] == 200
    call("PUT", "/v1/settings", {"autoPost": {"on": False}})
    assert _step(call, auto["clipId"], "finding")[0] == 200
    assert auto["clipId"] in {j["clipId"] for j in call("GET", "/v1/tiktok/mac")[1]["queue"]}


def test_an_upload_mac_post_is_not_held_by_the_auto_posting_switch(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    upload = _mac_clip(store, source="upload")
    assert _claim(call, upload["clipId"])[0] == 200
    assert _step(call, upload["clipId"], "pressing")[0] == 200


def test_the_queue_holds_at_most_fifty(call: Call, store: db.Store) -> None:
    _mac_on(call)
    for _ in range(52):
        _mac_clip(store)
    assert len(call("GET", "/v1/tiktok/mac")[1]["queue"]) == tiktok_mac.QUEUE_MAX


def test_the_tiktok_login_on_the_mac_change_and_forget(call: Call, table: FakeTable, clock: Clock) -> None:
    """§47.6: the helper says whether a TikTok login is kept in the Mac's Keychain; the owner's Change or Forget waits
    on the helper item until the helper says it handled that request. The login itself never reaches the server."""
    status, body = call("POST", "/v1/tiktok/mac/login", {"action": "forget"})
    assert (status, _message(body)) == (409, "Set up your Mac first. Then it can keep your TikTok login.")
    ping = {"state": "ok", "device": DEVICE, "login": "saved"}
    assert call("POST", "/v1/tiktok/mac/ping", ping)[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["login"] == "saved"
    status, body = call("POST", "/v1/tiktok/mac/login", {"action": "change"})
    assert status == 200
    request = body["helper"]["loginRequest"]
    assert request == {"action": "change", "at": iso(NOW)}
    # Check-ins keep it until the helper did it.
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE})[0] == 200
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["loginRequest"] == request
    assert helper["login"] == "saved"  # a ping without login keeps what the Mac said before
    # A newer request is not cleared by an older one's done.
    assert call("POST", "/v1/tiktok/mac/ping", {**ping, "loginDone": "2026-11-15T09:00:00.000Z"})[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["loginRequest"] == request
    assert call("POST", "/v1/tiktok/mac/ping", {**ping, "login": "none", "loginDone": request["at"]})[0] == 200
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert "loginRequest" not in helper
    assert helper["login"] == "none"
    raw = table.raw(PK, "MACHELPER")
    assert raw is not None
    assert not {"password", "username"} & set(raw)


def test_the_login_routes_refuse_what_they_do_not_know(call: Call) -> None:
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE})[0] == 200
    assert call("POST", "/v1/tiktok/mac/login", {"action": "show"})[0] == 400
    assert call("POST", "/v1/tiktok/mac/login", {"action": "forget", "password": "x"})[0] == 400
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, "login": "maybe"})[0] == 400
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, "password": "x"})[0] == 400


def test_a_ping_without_a_reason_clears_the_old_one(call: Call) -> None:
    call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "reason": "Paused on your Mac.", "device": DEVICE})
    call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE})
    assert "reason" not in call("GET", "/v1/tiktok/mac")[1]["helper"]


def test_ping_writes_the_helper_item_and_answers_on(call: Call, table: FakeTable, clock: Clock) -> None:
    status, body = call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, "version": "1.0.0"})
    assert (status, body) == (200, {"on": False})
    _mac_on(call)
    long = "TikTok wants you to log in again. " * 10
    status, body = call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "reason": long, "device": DEVICE})
    assert body == {"on": True}
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["state"] == "paused"
    assert helper["seenAt"] == iso(NOW)
    assert len(helper["reason"]) <= 200
    assert "device" not in helper
    raw = table.raw(PK, "MACHELPER")
    assert raw is not None
    assert raw["device"] == DEVICE


@pytest.mark.parametrize(
    "body",
    [{"state": "busy", "device": DEVICE}, {"state": "ok"}, {"state": "ok", "device": DEVICE, "extra": 1}],
)
def test_a_bad_ping_is_refused(call: Call, body: dict[str, Any]) -> None:
    assert call("POST", "/v1/tiktok/mac/ping", body)[0] == 400


def test_a_claim_is_one_conditional_write(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    status, body = _claim(call, clip["clipId"])
    assert status == 200
    job = body["job"]
    assert (job["state"], job["step"], job["claimedAt"]) == ("working", "video", iso(NOW))
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["macDevice"], raw["macBeatAt"], raw["macAttempt"]) == (DEVICE, iso(NOW), 1)
    for device in (DEVICE, "another-mac"):
        status, body = _claim(call, clip["clipId"], device)
        assert (status, _message(body)) == (409, "Another try already has this clip.")


def test_a_claim_on_a_clip_without_a_mac_post(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = seed_clip(store, status="posted", postsCreated=True, postIds=[])
    _post(store, clip, "tiktok", status="failed")
    status, body = _claim(call, clip["clipId"])
    assert (status, _message(body)) == (409, "Your Mac isn't posting this clip.")


def test_no_claim_while_the_switch_is_off(call: Call, store: db.Store) -> None:
    clip = _mac_clip(store)
    status, body = _claim(call, clip["clipId"])
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)


def test_a_crashed_helpers_claim_can_be_taken_again(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"], "old-mac")[0] == 200
    clock.now = NOW + timedelta(minutes=14)
    assert _claim(call, clip["clipId"])[0] == 409  # still fresh
    clock.now = NOW + timedelta(minutes=16)
    assert _claim(call, clip["clipId"])[0] == 200
    raw = tiktok_self.tiktok_row(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True))
    assert raw is not None
    assert (raw["macDevice"], raw["macAttempt"]) == (DEVICE, 2)


def test_a_post_whose_helper_pressed_post_is_never_claimed_again(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"], "old-mac")[0] == 200
    assert _step(call, clip["clipId"], "pressing", "old-mac")[0] == 200
    clock.now = NOW + timedelta(days=2)
    status, body = _claim(call, clip["clipId"])
    assert (status, _message(body)) == (409, "Another try already has this clip.")
    # Stopped (the helper could not confirm it): still never claimed until the owner says it is not on TikTok.
    assert (
        call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": "old-mac", "reason": "?"})[0] == 200
    )
    assert _claim(call, clip["clipId"])[0] == 409


# --- steps and stops ------------------------------------------------------------------------------------------------


def test_steps_come_only_from_the_mac_that_claimed_it(
    call: Call, store: db.Store, table: FakeTable, clock: Clock
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _step(call, clip["clipId"], "uploading")[0] == 409  # not claimed yet
    assert _claim(call, clip["clipId"])[0] == 200
    clock.now = NOW + timedelta(minutes=3)
    status, body = _step(call, clip["clipId"], "uploading")
    assert (status, body["job"]["step"]) == (200, "uploading")
    assert "pressedAt" not in body["job"]
    status, body = _step(call, clip["clipId"], "settings", "another-mac")
    assert (status, _message(body)) == (409, "Another try already has this clip.")
    clock.now = NOW + timedelta(minutes=5)
    assert _step(call, clip["clipId"], "pressing")[1]["job"]["pressedAt"] == iso(clock.now)
    clock.now = NOW + timedelta(minutes=6)
    job = _step(call, clip["clipId"], "finding")[1]["job"]
    assert (job["step"], job["pressedAt"]) == ("finding", iso(NOW + timedelta(minutes=5)))  # kept: the first press
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert raw["macBeatAt"] == iso(clock.now)
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/step", {"device": DEVICE, "step": "dance"})[0] == 400


def test_each_step_reaches_the_web_live(call: Call, store: db.Store, table: FakeTable) -> None:
    # Post item changes stream as post events (§14.2: the broadcast filter has POST#), with the public mac object.
    from clipfactory_api.realtime import broadcast

    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "uploading")
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    event = broadcast._public("post", raw)
    assert event["mac"]["step"] == "uploading"
    assert "macDevice" not in event


def test_turning_the_switch_off_stops_the_mac_before_post(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _mac_on(call, False)
    status, body = _step(call, clip["clipId"], "pressing")
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)
    _mac_on(call)
    _step(call, clip["clipId"], "pressing")
    _mac_on(call, False)
    assert _step(call, clip["clipId"], "finding")[0] == 200  # after Post it may still look for the link


def test_a_stop_says_why_and_can_ask_for_the_owner(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    reason = "  TikTok wants   you to log in again.  " + "x" * 300
    status, body = call(
        "POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": reason, "needsYou": True}
    )
    assert status == 200
    assert body["job"]["state"] == "stopped"
    mac = _tiktok({"posts": call("GET", "/v1/posts", query={"clipId": clip["clipId"]})[1]["posts"]})["mac"]
    assert mac["state"] == "stopped"
    assert mac["reason"].startswith("TikTok wants you to log in again. xxx")
    assert len(mac["reason"]) <= 200
    assert mac["stoppedAt"] == iso(NOW)
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert (helper["state"], helper["reason"]) == ("needs_you", mac["reason"])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": "other", "reason": "x"})
    assert status == 409


def test_a_stop_after_post_was_pressed_always_says_check_your_tiktok(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "pressing")
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "Timed out."})
    mac = _tiktok({"posts": call("GET", "/v1/posts", query={"clipId": clip["clipId"]})[1]["posts"]})["mac"]
    assert mac["reason"] == (
        "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok."
    )


# --- done (through tiktok_self.mark_posted) ------------------------------------------------------------------------------


def test_done_with_a_link_makes_it_his_public_post_via_the_mac(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "pressing")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    tiktok = _tiktok(body)
    assert (tiktok["status"], tiktok["by"], tiktok["privacy"], tiktok["via"]) == ("posted", "you", "public", "mac")
    assert tiktok["url"] == LINK
    assert "mac" not in tiktok
    assert body["clip"]["status"] == "posted"
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert raw["statsId"] == VIDEO_ID  # joins the poller like any public post
    assert not [k for k in raw if k.startswith("mac") or k in ("beforeMac", "madeForMac", "beforeYou")]
    assert call("GET", "/v1/tiktok/mac")[1]["queue"] == []


def test_done_without_a_link_asks_the_finder_from_a_minute_before_the_claim(
    call: Call, store: db.Store, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    asked: list[Any] = []

    def find(*_args: Any, since: Any, caption: str) -> None:
        asked.append((since, caption))

    monkeypatch.setattr(tiktok_find, "find_recent", find)
    clock.now = NOW + timedelta(minutes=8)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE})
    assert status == 200
    assert asked == [(NOW - timedelta(minutes=1), "wait for it")]
    assert body["note"] == "Saved. Clip Factory could not find it on your TikTok yet. Tap Find it for me in a minute."
    assert _tiktok(body)["via"] == "mac"


def test_a_repeated_done_is_answered_as_the_first_and_adds_the_link(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    first = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE})
    assert first[0] == 200
    posted_at = _tiktok(first[1])["postedAt"]
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    tiktok = _tiktok(body)
    assert (tiktok["url"], tiktok["postedAt"], tiktok["via"]) == (LINK, posted_at, "mac")
    assert _raw_tiktok(table, clip["clipId"]) is not None  # still one TikTok post


def test_done_comes_only_from_the_mac_that_claimed_it(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE})
    assert (status, _message(body)) == (409, "Another try already has this clip.")  # waiting: nobody claimed it
    _claim(call, clip["clipId"])
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": "other"})[0] == 409
    plain = seed_clip(store, status="posted", postsCreated=True, postIds=[])
    status, body = call("POST", f"/v1/clips/{plain['clipId']}/tiktok/mac/done", {"device": DEVICE})
    assert (status, _message(body)) == (409, "Your Mac isn't posting this clip.")


def test_a_stopped_post_the_mac_found_after_all_can_still_be_done(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "pressing")
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "Timed out."})
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    assert _tiktok(body)["via"] == "mac"


def test_undo_never_takes_back_what_the_mac_posted(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert (status, _message(body)) == (409, "Your Mac posted this one. To take it down, delete it in TikTok.")


def test_the_mac_and_i_posted_it_never_make_two_posts(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE})
    # He taps I posted it with a link afterwards: the same one post only gets the link.
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})
    assert status == 200
    assert _tiktok(body)["url"] == LINK
    assert _raw_tiktok(table, clip["clipId"]) is not None


# --- I posted it on a Mac post (§42 + §47.3) ---------------------------------------------------------------------------


def test_i_posted_it_while_the_mac_works_on_it_is_refused(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert (status, _message(body)) == (409, "Your Mac is posting it right now. Wait a minute.")


@pytest.mark.parametrize("state", ["waiting", "stopped"])
def test_i_posted_it_on_a_waiting_or_stopped_mac_post_makes_it_his_and_undo_puts_it_back(
    call: Call, store: db.Store, table: FakeTable, state: str
) -> None:
    _mac_on(call)
    extra = {"macState": "stopped", "macReason": "Timed out.", "macDevice": DEVICE} if state == "stopped" else {}
    clip = _mac_clip(store, **extra)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200
    tiktok = _tiktok(body)
    assert (tiktok["status"], tiktok["by"]) == ("posted", "you")
    assert "via" not in tiktok
    assert "mac" not in tiktok
    assert body["clip"]["status"] == "posted"
    assert call("GET", "/v1/tiktok/mac")[1]["queue"] == []
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/posted")
    assert status == 200
    back = _tiktok(body)
    assert (back["status"], back["mac"]["state"]) == ("mac", state)
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert raw["madeForMac"] is True
    assert body["clip"]["status"] == "confirmed"


# --- Try again (the owner's) ---------------------------------------------------------------------------------------------


def test_try_again_puts_a_stopped_post_back_in_line(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    call(
        "POST",
        f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped",
        {"device": DEVICE, "reason": "Login.", "needsYou": True},
    )
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["needsYouClipId"] == clip["clipId"]
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})
    assert status == 200
    mac = _tiktok(body)["mac"]
    # Keeps its place (since); a stopped one keeps its last beat, which only counts while it works.
    assert mac == {"state": "waiting", "since": "2026-11-15T11:00:00.000Z", "source": "upload", "beatAt": iso(NOW)}
    assert _raw_post(store, clip["clipId"])["macAgainAt"] == iso(NOW)
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["state"] == "ok"
    assert "needsYouClipId" not in helper
    assert _claim(call, clip["clipId"])[0] == 200
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})[0] == 409  # working now


def test_try_again_after_post_was_pressed_needs_not_on_tiktok_and_the_end_of_the_find_window(
    call: Call, store: db.Store, clock: Clock
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    clock.now = NOW + timedelta(minutes=2)
    _step(call, clip["clipId"], "pressing")
    pressed_at = iso(clock.now)
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "?"})
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})
    assert (status, _message(body)) == (409, "Your Mac may have posted it already. Check your TikTok first.")
    # The Mac may still be looking for the link: Try again waits for the end of the 30-minute find window.
    for minutes in (3, 31):
        clock.now = NOW + timedelta(minutes=minutes)
        status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {"notOnTikTok": True})
        assert (status, _message(body)) == (409, tiktok_mac.MAC_STILL_LOOKING)
        assert _raw_post(store, clip["clipId"])["macState"] == "stopped"
    clock.now = NOW + timedelta(minutes=32)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {"notOnTikTok": True})
    assert status == 200, body
    assert "pressedAt" not in _tiktok(body)["mac"]
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macPressedBefore"], raw["macAgainAt"]) == (pressed_at, iso(clock.now))
    assert "macPressedAt" not in raw
    status, body = _claim(call, clip["clipId"])
    assert status == 200
    # The helper's never-twice guard reads both: a re-wait after the window, not a press it lost.
    job = body["job"]
    assert (job["pressedBefore"], job["againAt"], job["beatAt"]) == (pressed_at, iso(clock.now), iso(clock.now))
    assert "pressedAt" not in job


def test_tiktok_self_window_and_beat_edges() -> None:
    claimed = NOW
    row = {"status": "mac", "macState": "working", "macClaimedAt": iso(claimed), "macBeatAt": iso(claimed)}
    assert timedelta(minutes=5) == tiktok_self.MAC_BEAT_STALE
    assert timedelta(minutes=50) == tiktok_self.MAC_CLAIM_MAX
    assert timedelta(minutes=30) == tiktok_self.MAC_FIND_WINDOW
    # The beat: 4:59 fresh, 5:00 stuck (no macBeatAt: the claim is the beat).
    for beat in (row, {k: v for k, v in row.items() if k != "macBeatAt"}):
        assert not tiktok_self.mac_stuck(beat, claimed + timedelta(minutes=4, seconds=59))
        assert tiktok_self.beat_fresh(beat, claimed + timedelta(minutes=4, seconds=59))
        assert tiktok_self.mac_stuck(beat, claimed + timedelta(minutes=5))
        assert not tiktok_self.beat_fresh(beat, claimed + timedelta(minutes=5))
    # The cap: beats a minute ago, claimed 49:59 ago → not stuck; 50:00 → stuck.
    at = claimed + timedelta(minutes=49, seconds=59)
    beating = {**row, "macBeatAt": iso(at - timedelta(minutes=1))}
    assert not tiktok_self.mac_stuck(beating, at)
    assert tiktok_self.mac_stuck(
        {**beating, "macBeatAt": iso(claimed + timedelta(minutes=49))}, claimed + timedelta(minutes=50)
    )
    # Only a working Mac post is ever stuck.
    for other in ({**row, "macState": "stopped"}, {**row, "macState": "waiting"}, {**row, "status": "posted"}):
        assert not tiktok_self.mac_stuck(other, claimed + timedelta(days=1))
    # The window: no press → over; pressed 29:59 ago → not over; 30:00 → over.
    assert tiktok_self.window_over(row, claimed)
    pressed = {**row, "macPressedAt": iso(claimed)}
    assert not tiktok_self.window_over(pressed, claimed + timedelta(minutes=29, seconds=59))
    assert tiktok_self.window_over(pressed, claimed + timedelta(minutes=30))


def test_the_constants_stay_one_line_each_for_the_web_and_helper_pins() -> None:
    import re
    from pathlib import Path

    text = Path(tiktok_self.__file__).read_text(encoding="utf-8")
    found = dict(
        re.findall(r"^(MAC_BEAT_STALE|MAC_CLAIM_MAX|MAC_FIND_WINDOW) = timedelta\(minutes=(\d+)\)$", text, re.M)
    )
    assert found == {"MAC_BEAT_STALE": "5", "MAC_CLAIM_MAX": "50", "MAC_FIND_WINDOW": "30"}
    assert "MAC_STUCK" not in text


def _stop_needing_you(call: Call, clip_id: str, *, pressed: bool = False) -> None:
    """The Mac claims the post (and presses Post), then stops and asks for the owner."""
    assert _claim(call, clip_id)[0] == 200
    if pressed:
        assert _step(call, clip_id, "pressing")[0] == 200
    body = {"device": DEVICE, "reason": "TikTok logged the helper out.", "needsYou": True}
    assert call("POST", f"/v1/clips/{clip_id}/tiktok/mac/stopped", body)[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["state"] == "needs_you"


@pytest.mark.parametrize("pressed", [False, True])
def test_its_on_tiktok_on_the_stopped_post_lets_the_mac_go_on(call: Call, store: db.Store, pressed: bool) -> None:
    # The owner's It's on TikTok answers the stopped post just as Try again does: the helper item goes back to ok
    # (the helper echoes needs_you for as long as the server says it, so nothing else would let the Mac go on).
    _mac_on(call)
    clip = _mac_clip(store)
    _stop_needing_you(call, clip["clipId"], pressed=pressed)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})
    assert status == 200, body
    assert (_tiktok(body)["status"], _tiktok(body)["by"]) == ("posted", "you")
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["state"] == "ok"
    assert "reason" not in helper


def test_its_on_tiktok_on_a_post_that_waits_leaves_needs_you(call: Call, store: db.Store) -> None:
    # Only the stopped post's answer clears it: marking another clip that only waits says nothing about the Mac.
    _mac_on(call)
    stopped = _mac_clip(store)
    waiting = _mac_clip(store)
    _stop_needing_you(call, stopped["clipId"])
    assert call("POST", f"/v1/clips/{waiting['clipId']}/tiktok/posted", {"link": LINK})[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["state"] == "needs_you"


def test_its_on_tiktok_never_makes_a_helper_item(call: Call, store: db.Store) -> None:
    clip = _mac_clip(store, macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"] is None


# --- the stuck rule: no beat for 5 minutes, or claimed 50 minutes ago (§47.3) ------------------------------------------


def _beat(call: Call, clip_id: str, step: str, clock: Clock, at: timedelta) -> None:
    """The helper re-sends its last step at ``NOW + at``: the job's beat."""
    clock.now = NOW + at
    assert _step(call, clip_id, step)[0] == 200


@pytest.mark.parametrize("pressed", [False, True])
def test_try_again_takes_a_stuck_claim_back(call: Call, store: db.Store, clock: Clock, pressed: bool) -> None:
    # The helper crashed or slept (its beat stops), or lost its ledger: the post stays working. Five minutes after its
    # last beat the web says "Not sure it posted", and Try again puts it back in line for a new claim; after Post was
    # pressed only once the find window is over.
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    if pressed:
        assert _step(call, clip["clipId"], "pressing")[0] == 200
    clock.now = NOW + timedelta(minutes=4, seconds=59)
    status, body = _retry(call, clip["clipId"], {"notOnTikTok": True, "now": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)
    clock.now = NOW + timedelta(minutes=5)
    if pressed:
        status, body = _retry(call, clip["clipId"], {"now": True})
        assert (status, _message(body)) == (409, tiktok_mac.MAY_HAVE_POSTED)
        status, body = _retry(call, clip["clipId"], {"notOnTikTok": True, "now": True})
        assert (status, _message(body)) == (409, tiktok_mac.MAC_STILL_LOOKING)
        clock.now = NOW + timedelta(minutes=30)
    status, body = _retry(call, clip["clipId"], {"notOnTikTok": True, "now": True})
    assert status == 200, body
    assert _tiktok(body)["mac"] == {"state": "waiting", "since": "2026-11-15T11:00:00.000Z", "source": "upload"}
    raw = _raw_post(store, clip["clipId"])
    assert not {"macDevice", "macBeatAt", "macClaimedAt", "macPressedAt"} & set(raw)
    assert raw["macAgainAt"] == iso(clock.now)
    assert ("macPressedBefore" in raw) is pressed
    # The old claim can't write any more; a new claim (any Mac) starts it afresh.
    assert _step(call, clip["clipId"], "settings")[0] == 409
    status, body = _claim(call, clip["clipId"], device="mac-mini-2")
    assert status == 200
    assert body["job"]["attempt"] == 2


def test_a_job_the_mac_beats_is_never_stuck_until_its_claim_is_50_minutes_old(
    call: Call, store: db.Store, clock: Clock
) -> None:
    # A healthy helper: a 12-minute upload wait, then Post, then the find window. Its re-sent steps keep it working.
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    assert _step(call, clip["clipId"], "uploading")[0] == 200
    for minute in range(4, 49, 4):
        _beat(call, clip["clipId"], "uploading", clock, timedelta(minutes=minute))
    assert _raw_post(store, clip["clipId"])["macStep"] == "uploading"  # a beat keeps the step
    clock.now = NOW + timedelta(minutes=49, seconds=59)
    for refused in (
        _retry(call, clip["clipId"], {"notOnTikTok": True, "now": True}),
        call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK}),
    ):
        assert (refused[0], _message(refused[1])) == (409, tiktok_mac.MAC_WORKING)
    clock.now = NOW + timedelta(minutes=50)
    assert tiktok_self.mac_stuck(_raw_post(store, clip["clipId"]), clock.now)
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert status == 200, body
    assert _tiktok(body)["mac"]["state"] == "waiting"


@pytest.mark.parametrize(("version", "beats"), [("1.0.0", False), ("1.1.0", True), ("1.2.3", True), ("2.0", True)])
def test_a_helper_older_than_beats_counts_only_its_claims_age(
    call: Call, store: db.Store, clock: Clock, version: str, beats: bool
) -> None:
    # The helper installed on his Mac before 1.1.0 sends no beat through its 12-minute upload wait or its link checks:
    # for its jobs a stale beat is no sign it stopped, so only the 50-minute claim counts (the web's macHelperBeats).
    _mac_on(call)
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, "version": version})[0] == 200
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    clock.now = NOW + timedelta(minutes=12)
    status, body = _retry(call, clip["clipId"], {"now": True})
    if not beats:
        assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)
        status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})
        assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)
        clock.now = NOW + timedelta(minutes=50)
        status, body = _retry(call, clip["clipId"], {"now": True})
    assert status == 200, body
    assert _tiktok(body)["mac"]["state"] == "waiting"


def test_helper_beats_reads_the_helpers_version() -> None:
    assert tiktok_self.MAC_BEATS_FROM == "1.1.0"
    assert not tiktok_self.helper_beats({"version": "1.0.0"})
    assert not tiktok_self.helper_beats({"version": "0.9"})
    for item in (None, {}, {"version": "1.1.0"}, {"version": "1.10.0"}, {"version": "dev"}):
        assert tiktok_self.helper_beats(item)
    row = {"status": "mac", "macState": "working", "macClaimedAt": iso(NOW), "macBeatAt": iso(NOW)}
    assert tiktok_self.mac_stuck(row, NOW + timedelta(minutes=5))
    assert not tiktok_self.mac_stuck(row, NOW + timedelta(minutes=49), beats=False)
    assert tiktok_self.mac_stuck(row, NOW + timedelta(minutes=50), beats=False)


def test_a_re_sent_step_is_the_beat_and_keeps_every_refusal(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "video", clock, timedelta(minutes=4))
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macStep"], raw["macBeatAt"]) == ("video", iso(NOW + timedelta(minutes=4)))
    clock.now = NOW + timedelta(minutes=8)
    assert not tiktok_self.mac_stuck(_raw_post(store, clip["clipId"]), clock.now)
    # Another device's beat is refused, and so is a beat after the switch went off before Post.
    assert _step(call, clip["clipId"], "video", "another-mac")[0] == 409
    _mac_on(call, False)
    status, body = _step(call, clip["clipId"], "video")
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)
    assert _raw_post(store, clip["clipId"])["macBeatAt"] == iso(NOW + timedelta(minutes=4))


def test_a_re_sent_pressing_step_never_moves_the_press(
    call: Call, store: db.Store, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clipfactory_api.routes import tiktok_mac as routes

    logged: list[str] = []
    monkeypatch.setattr(routes, "log", lambda _level, event, **_k: logged.append(event))
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "pressing", clock, timedelta(minutes=1))
    _beat(call, clip["clipId"], "pressing", clock, timedelta(minutes=2))
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macPressedAt"], raw["macBeatAt"]) == (iso(NOW + timedelta(minutes=1)), iso(clock.now))
    assert logged.count("tiktok_mac.pressing") == 1  # only when Post was newly pressed


def test_try_again_on_a_stuck_claim_loses_to_a_new_claim(
    call: Call, store: db.Store, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    clock.now = NOW + timedelta(minutes=20)
    stale = _raw_post(store, clip["clipId"])
    # Meanwhile the crashed helper's claim is taken again (no step for 15 minutes) by another try.
    assert _claim(call, clip["clipId"], device="mac-mini-2")[0] == 200
    monkeypatch.setattr(tiktok_mac, "mac_row", lambda _store, _clip: (stale, [stale]))
    status, body = _retry(call, clip["clipId"], {"notOnTikTok": True, "now": True})
    assert (status, _message(body)) == (409, tiktok_mac.CHANGED)
    monkeypatch.undo()
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macState"], raw["macDevice"]) == ("working", "mac-mini-2")


def test_try_again_on_a_stuck_claim_loses_to_a_beat(
    call: Call, store: db.Store, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The owner read the post stuck, then the Mac woke and beat it: the write needs the same beat, so it is refused.
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    clock.now = NOW + timedelta(minutes=6)
    stale = _raw_post(store, clip["clipId"])
    assert _step(call, clip["clipId"], "video")[0] == 200
    monkeypatch.setattr(tiktok_mac, "mac_row", lambda _store, _clip: (stale, [stale]))
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert (status, _message(body)) == (409, tiktok_mac.CHANGED)
    monkeypatch.undo()
    assert _raw_post(store, clip["clipId"])["macState"] == "working"


def test_its_on_tiktok_on_a_stuck_claim_loses_to_a_beat(store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    # He read the job stuck; the Mac beat it before his write: the write needs the same beat, so nothing changes.
    clip = _mac_clip(store, macState="working", macDevice=DEVICE, macClaimedAt=iso(NOW), macBeatAt=iso(NOW))
    later = NOW + timedelta(minutes=6)
    stale = _raw_post(store, clip["clipId"])
    store.update(str(stale["pk"]), str(stale["sk"]), {"macBeatAt": iso(later)})
    monkeypatch.setattr(tiktok_self, "posts_for_clip", lambda *_a, **_k: [stale])
    with pytest.raises(db.ConditionFailed):
        tiktok_self.mark_posted(store, clip, None, later, min_interval=60)
    monkeypatch.undo()
    assert _raw_post(store, clip["clipId"])["status"] == "mac"


def test_its_on_tiktok_on_a_stuck_claim(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _stop_needing_you(call, _mac_clip(store)["clipId"])
    assert _claim(call, clip["clipId"])[0] == 200
    assert _step(call, clip["clipId"], "pressing")[0] == 200
    clock.now = NOW + timedelta(minutes=4)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)
    clock.now = NOW + timedelta(minutes=5)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"link": LINK})
    assert status == 200, body
    post = _tiktok(body)
    assert (post["status"], post["by"], post["url"]) == ("posted", "you", LINK)
    assert "mac" not in post
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["state"] == "ok"
    assert "needsYouClipId" not in helper
    # The Mac's late done is refused: the post is his now, and stays one post.
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 409
    assert _raw_post(store, clip["clipId"])["status"] == "posted"


# --- It's on TikTok without a link (D3) ---------------------------------------------------------------------------------


def test_no_link_is_refused_while_the_mac_beats_a_job_it_has_not_pressed_post_for(
    call: Call, store: db.Store, clock: Clock
) -> None:
    # Even stuck by the 50-minute cap: the Mac is still uploading, so the clip may not be on TikTok at all.
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "uploading", clock, timedelta(minutes=49))
    clock.now = NOW + timedelta(minutes=51)
    assert tiktok_self.mac_stuck(_raw_post(store, clip["clipId"]), clock.now)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)
    assert _raw_post(store, clip["clipId"])["status"] == "mac"
    # Its beat goes stale: the Mac stopped before it pressed Post, so the clip isn't on TikTok. Saving it as posted
    # with no link would lose it for good: only Try again helps, and it does.
    clock.now = NOW + timedelta(minutes=54)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert (status, _message(body)) == (409, tiktok_self.MAC_NOT_PRESSED)
    assert _raw_post(store, clip["clipId"])["status"] == "mac"
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert status == 200, body
    assert _tiktok(body)["mac"]["state"] == "waiting"


def test_no_link_is_refused_on_a_job_stuck_before_post_by_its_beat(call: Call, store: db.Store, clock: Clock) -> None:
    # The Mac slept mid-upload: its beat is 5 minutes old, so the job is stuck, but Post was never pressed.
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "uploading", clock, timedelta(minutes=3))
    clock.now = NOW + timedelta(minutes=8)
    assert tiktok_self.mac_stuck(_raw_post(store, clip["clipId"]), clock.now)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert (status, _message(body)) == (409, tiktok_self.MAC_NOT_PRESSED)
    assert (
        tiktok_self.MAC_NOT_PRESSED == "Your Mac stopped before it pressed Post, so it isn't on TikTok. Tap Try again."
    )
    raw = _raw_post(store, clip["clipId"])
    assert (raw["status"], raw["macState"]) == ("mac", "working")


def test_no_link_after_post_was_pressed_on_a_stuck_job(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "pressing", clock, timedelta(minutes=10))
    _beat(call, clip["clipId"], "finding", clock, timedelta(minutes=47))
    clock.now = NOW + timedelta(minutes=50)  # the cap, with a fresh beat: pressed, so it may be on TikTok
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert status == 200, body
    assert _tiktok(body)["by"] == "you"


def test_find_on_a_post_the_mac_works_on_answers_before_the_finder(
    call: Call, store: db.Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200

    def never(*_a: Any, **_k: Any) -> None:
        raise AssertionError("TikTok is never asked while the Mac works on it")

    monkeypatch.setattr(tiktok_find, "find_recent", never)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_WORKING)


def test_try_again_on_a_clip_the_mac_is_not_posting(call: Call, store: db.Store) -> None:
    clip = seed_clip(store, status="posted", postsCreated=True, postIds=[])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})
    assert (status, _message(body)) == (409, "Your Mac isn't posting this clip.")


# --- Take it back (Post it yourself instead) -----------------------------------------------------------------------------


def test_take_it_back_deletes_a_post_made_for_the_mac(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = _mac_clip(store)
    post_id = (_raw_tiktok(table, clip["clipId"]) or {})["postId"]
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    assert status == 200
    assert body["posts"] == []
    assert table.raw(PK, db.post_sk(post_id)) is None
    assert post_id not in (table.raw(clip["pk"], clip["sk"]) or {})["postIds"]
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    assert (status, _message(body)) == (409, "Your Mac isn't posting this clip.")
    # Then his It's on TikTok, no link, makes his own post as before.
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})[0] == 200


def test_take_it_back_while_the_mac_works_on_it_is_refused(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    assert (status, _message(body)) == (409, "Your Mac is posting it right now. Wait a minute.")


# --- Send these to my Mac --------------------------------------------------------------------------------------------------


def _uploaded(store: db.Store, **fields: Any) -> dict[str, Any]:
    fields.setdefault("status", "posted")
    fields.setdefault("decidedAt", "2026-11-15T10:00:00.000Z")
    return seed_clip(store, postsCreated=True, postIds=[], **fields)


def test_send_needs_the_switch(call: Call, store: db.Store) -> None:
    clip = _uploaded(store)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)


@pytest.mark.parametrize("ids", [[], [ulid() for _ in range(26)], "x", [1]])
def test_send_takes_1_to_25_ids(call: Call, ids: Any) -> None:
    _mac_on(call)
    assert call("POST", "/v1/tiktok/mac/send", {"clipIds": ids})[0] == 400


def test_send_makes_a_new_mac_post_once(call: Call, store: db.Store, table: FakeTable, clock: Clock) -> None:
    _mac_on(call)
    clip = _uploaded(store)
    _post(store, clip, "youtube", status="posted", privacy="public", url="https://youtu.be/x")
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"], clip["clipId"]]})
    assert (status, body) == (200, {"results": [{"clipId": clip["clipId"], "sent": True}]})
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["status"], raw["macSource"], raw["madeForMac"], raw["postOptions"]) == ("mac", "sent", True, MINE)
    stored = table.raw(clip["pk"], clip["sk"]) or {}
    assert stored["tiktokForMac"] == raw["postId"]
    assert raw["postId"] in stored["postIds"]
    assert "tiktokForMac" not in call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})
    assert body["results"] == [{"clipId": clip["clipId"], "sent": False, "reason": "Your Mac already has this clip."}]
    assert _raw_tiktok(table, clip["clipId"]) is not None  # still one


def test_a_send_and_i_posted_it_at_the_same_moment_never_make_two_posts(app: App, store: db.Store) -> None:
    # I posted it read no TikTok post, then a send made one (its mark is on the clip): its write fails.
    clip = _uploaded(store, tiktokForMac=ulid())
    with pytest.raises(db.ConditionFailed):
        tiktok_self.mark_posted(store, clip, None, NOW, min_interval=60)
    # And the other way round: a send after I posted it's mark finds the clip changed.
    other = _uploaded(store, tiktokByYou=ulid())
    assert tiktok_mac.send(store, USER, other, {"tiktokMac": {"on": True}}, NOW, is_campaign=False) == (
        "This clip just changed. Try again."
    )


@pytest.mark.parametrize(
    ("fields", "clip_status"),
    [
        (
            {
                # A row stored before round 3 keeps its old words; the web reads both (§47.7).
                "status": "failed",
                "error": "TikTok only takes Clip Factory's uploads on a private account until it approves the app. Tap Post it yourself to post it for everyone.",
            },
            "failed",
        ),
        ({"status": "pending_integration"}, "confirmed"),
        (
            {
                "status": "posted",
                "privacy": "private",
                "url": "https://www.tiktok.com/@lamo.clips",
                "statsId": "1",
                "gsi2pk": "STATS",
                "gsi2sk": "x",
            },
            "posted",
        ),
    ],
)
def test_send_hands_over_clip_factorys_own_post_in_place_and_take_it_back_restores_it(
    call: Call, store: db.Store, table: FakeTable, fields: dict[str, Any], clip_status: str
) -> None:
    _mac_on(call)
    clip = _uploaded(store, status=clip_status)
    old = _post(store, clip, "tiktok", postOptions=TIKTOK, **fields)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})
    assert body["results"] == [{"clipId": clip["clipId"], "sent": True}]
    raw = table.raw(PK, db.post_sk(old["postId"]))
    assert raw is not None
    assert (raw["status"], raw["macSource"], raw["postOptions"]) == ("mac", "sent", MINE)
    assert raw["beforeMac"]["status"] == fields["status"]
    assert "madeForMac" not in raw
    assert not [k for k in ("error", "url", "statsId", "gsi2pk", "privacy") if k in raw]  # off the poller too
    if clip_status == "failed":
        assert (table.raw(clip["pk"], clip["sk"]) or {})["status"] == "confirmed"  # nothing failed any more
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    assert status == 200
    back = table.raw(PK, db.post_sk(old["postId"]))
    assert back is not None
    assert {k: back.get(k) for k in fields} == fields
    assert back["postOptions"] == TIKTOK
    assert not [k for k in back if k.startswith("mac") or k == "beforeMac"]
    assert body["clip"]["status"] == clip_status


def test_send_refuses_with_plain_sentences(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    review = seed_clip(store)
    starting = seed_clip(store, status="confirmed")
    test_clip = _uploaded(store, autoRun="r#private_now", autoTest="private")
    queued = _uploaded(store)
    _post(store, queued, "tiktok", status="queued")
    yours = _uploaded(store)
    _post(store, yours, "tiktok", status="posted", by="you", privacy="public")
    public = _uploaded(store)
    _post(store, public, "tiktok", status="posted", privacy="public")
    missing = ulid()
    ids = [review, starting, test_clip, queued, yours, public]
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [c["clipId"] for c in ids] + [missing, "nope"]})
    assert status == 200
    assert [(r["sent"], r.get("reason")) for r in body["results"]] == [
        (False, "Upload this clip first."),
        (False, "This clip is still starting to upload. Try again in a minute."),
        (False, "This was a Private test, so it stays off TikTok."),
        (False, "This clip is still uploading to TikTok. Wait until it is done, then try again."),
        (False, "You already posted this one on TikTok."),
        (False, "This clip is already on TikTok for everyone."),
        (False, "We could not find that clip."),
        (False, "We could not find that clip."),
    ]
    assert not [i for i in table.all() if i.get("status") == "mac"]


@pytest.mark.parametrize("now", [False, True])
def test_send_refuses_a_campaign_clip(call: Call, store: db.Store, table: FakeTable, now: bool) -> None:
    # D1: Send these to my Mac and a row's Post with my Mac never take a campaign clip; nothing is written.
    _mac_on(call)
    put_campaign(store, platformsPaid=["tiktok"])
    paid = campaign_clip(store, status="posted", postsCreated=True, postIds=[])
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [paid["clipId"]], "now": now})
    assert (status, body) == (
        200,
        {"results": [{"clipId": paid["clipId"], "sent": False, "reason": tiktok_mac.SEND_CAMPAIGN}]},
    )
    assert tiktok_mac.SEND_CAMPAIGN == (
        "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet."
    )
    assert _raw_tiktok(table, paid["clipId"]) is None
    assert "tiktokForMac" not in (table.raw(paid["pk"], paid["sk"]) or {})
    assert call("GET", "/v1/tiktok/mac")[1]["queue"] == []


def test_send_refuses_a_campaign_clip_whose_campaign_lives_on_its_posts(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    # A clip that outlived its job: its failed TikTok post still says which campaign it is for.
    _mac_on(call)
    put_campaign(store, platformsPaid=["youtube", "tiktok"])
    clip = _uploaded(store, status="failed")
    old = _post(store, clip, "tiktok", status="failed", error="x", campaignId=CAMPAIGN, postOptions=TIKTOK)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, body["results"]) == (
        200,
        [{"clipId": clip["clipId"], "sent": False, "reason": tiktok_mac.SEND_CAMPAIGN}],
    )
    assert (table.raw(PK, db.post_sk(old["postId"])) or {})["status"] == "failed"


def test_sent_clips_go_after_uploads_oldest_clip_first(call: Call, store: db.Store) -> None:
    _mac_on(call)
    newer = _uploaded(store, decidedAt="2026-11-15T10:00:00.000Z")
    older = _uploaded(store, decidedAt="2026-11-14T10:00:00.000Z")
    upload = _mac_clip(store, macSince=iso(NOW + timedelta(hours=1)))
    call("POST", "/v1/tiktok/mac/send", {"clipIds": [newer["clipId"], older["clipId"]]})
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [j["clipId"] for j in queue] == [upload["clipId"], older["clipId"], newer["clipId"]]
    assert {j["source"] for j in queue[1:]} == {"sent"}


# --- now: a row's Post with my Mac and Try again go at once, as an Upload tap (§47.2) ------------------------------


def _retry(call: Call, clip_id: str, body: dict[str, Any]) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/tiktok/mac/retry", body)


def test_send_with_now_makes_an_upload_mac_post_that_goes_first(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    backlog = _uploaded(store, decidedAt="2026-11-14T10:00:00.000Z")
    tapped = _uploaded(store, decidedAt="2026-11-15T10:00:00.000Z")
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [backlog["clipId"]], "now": False})
    assert (status, body) == (200, {"results": [{"clipId": backlog["clipId"], "sent": True}]})
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [tapped["clipId"]], "now": True})
    assert (status, body) == (200, {"results": [{"clipId": tapped["clipId"], "sent": True}]})
    assert (_raw_tiktok(table, backlog["clipId"]) or {})["macSource"] == "sent"  # without now: as before
    raw = _raw_tiktok(table, tapped["clipId"]) or {}
    assert (raw["status"], raw["macState"], raw["macSource"], raw["madeForMac"], raw["postOptions"]) == (
        "mac",
        "waiting",
        "upload",
        True,
        MINE,
    )
    # The helper posts upload first and at once (mac/tiktok-helper/src/plan.js), so the queue puts it first.
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [(j["clipId"], j["source"]) for j in queue] == [(tapped["clipId"], "upload"), (backlog["clipId"], "sent")]


def test_send_with_now_hands_over_clip_factorys_own_post_as_an_upload(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    clip = _uploaded(store, status="failed")
    old = _post(store, clip, "tiktok", status="failed", error="TikTok said no.", postOptions=TIKTOK)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, body["results"]) == (200, [{"clipId": clip["clipId"], "sent": True}])
    raw = table.raw(PK, db.post_sk(old["postId"])) or {}
    assert (raw["status"], raw["macSource"], raw["beforeMac"]["status"]) == ("mac", "upload", "failed")


def test_send_with_now_keeps_every_refusal_and_the_switch(call: Call, store: db.Store, table: FakeTable) -> None:
    clip = _uploaded(store)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)
    _mac_on(call)
    yours = _uploaded(store)
    _post(store, yours, "tiktok", status="posted", by="you", privacy="public")
    test_clip = _uploaded(store, autoRun="r#private_now", autoTest="private")
    ids = [yours["clipId"], test_clip["clipId"]]
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": ids, "now": True})
    assert status == 200
    assert [(r["sent"], r.get("reason")) for r in body["results"]] == [
        (False, tiktok_mac.SEND_YOURS),
        (False, tiktok_mac.SEND_TEST),
    ]
    assert not [i for i in table.all() if i.get("status") == "mac"]


@pytest.mark.parametrize("now", ["yes", 1, 0, None, [], {}])
def test_now_must_be_true_or_false(call: Call, store: db.Store, now: Any) -> None:
    _mac_on(call)
    clip = _mac_clip(store, macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    other = _uploaded(store)
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [other["clipId"]], "now": now})
    assert (status, _message(body)) == (400, "now must be true or false.")
    status, body = _retry(call, clip["clipId"], {"now": now})
    assert (status, _message(body)) == (400, "now must be true or false.")
    assert _raw_post(store, clip["clipId"])["macState"] == "stopped"
    assert posts.posts_for_clip(store, USER, other["clipId"], consistent=True) == []


def test_unknown_keys_are_still_refused_next_to_now(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store, macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True, "later": True})
    assert (status, _message(body)) == (400, "Unknown field: later.")
    status, body = _retry(call, clip["clipId"], {"now": True, "soon": True})
    assert (status, _message(body)) == (400, "Unknown field: soon.")


@pytest.mark.parametrize("source", ["sent", "auto", "upload"])
def test_try_again_with_now_makes_it_an_upload_tap(call: Call, store: db.Store, source: str) -> None:
    # Auto-posting stays off: the owner tapped it himself, so an auto-posting run's post goes at once too.
    _mac_on(call)
    earlier = _mac_clip(store, source="sent", macSince="2026-11-15T08:00:00.000Z")
    clip = _mac_clip(store, source=source, macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert status == 200
    # Keeps its place (since), and goes first: an Upload tap's.
    assert _tiktok(body)["mac"] == {"state": "waiting", "since": "2026-11-15T11:00:00.000Z", "source": "upload"}
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [j["clipId"] for j in queue] == [clip["clipId"], earlier["clipId"]]
    assert _claim(call, clip["clipId"])[0] == 200


def test_try_again_without_now_keeps_its_source(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store, source="auto", macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    status, body = _retry(call, clip["clipId"], {"now": False})
    assert (status, _tiktok(body)["mac"]["source"]) == (200, "auto")
    status, body = _claim(call, clip["clipId"])
    assert (status, _message(body)) == (409, tiktok_mac.AUTO_OFF)  # auto-posting is off, so it waits


def test_try_again_without_now_leaves_a_waiting_post_as_it_is(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store, source="sent")
    for body_in in ({}, {"now": False}):
        status, body = _retry(call, clip["clipId"], body_in)
        assert (status, _tiktok(body)["mac"]["source"]) == (200, "sent")
    assert _raw_post(store, clip["clipId"])["macSource"] == "sent"


# --- now on a post that already waits: the "auto-posting is off" row's Post with my Mac goes next -------------------


@pytest.mark.parametrize("source", ["sent", "auto"])
@pytest.mark.parametrize("how", ["send", "retry"])
def test_now_on_a_waiting_mac_post_makes_it_an_upload_tap_that_goes_next(
    call: Call, store: db.Store, source: str, how: str
) -> None:
    # Auto-posting stays off, so without the tap a sent or auto post waits for the next run (or for ever).
    _mac_on(call)
    earlier = _mac_clip(store, source="sent", macSince="2026-11-15T08:00:00.000Z")
    clip = _mac_clip(store, source=source)
    before = _raw_post(store, clip["clipId"])
    if how == "send":
        status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
        assert (status, body) == (200, {"results": [{"clipId": clip["clipId"], "sent": True}]})
    else:
        status, body = _retry(call, clip["clipId"], {"now": True})
        assert status == 200
        assert _tiktok(body)["mac"] == {"state": "waiting", "since": "2026-11-15T11:00:00.000Z", "source": "upload"}
    raw = _raw_post(store, clip["clipId"])  # still one TikTok post, the same one
    assert raw["postId"] == before["postId"]
    # Only its source changed: it keeps its place (since), its options and its made-for-the-Mac mark.
    assert {k: v for k, v in raw.items() if k != "macSource"} == {k: v for k, v in before.items() if k != "macSource"}
    assert raw["macSource"] == "upload"
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [(j["clipId"], j["source"]) for j in queue] == [(clip["clipId"], "upload"), (earlier["clipId"], "sent")]
    assert _claim(call, clip["clipId"])[0] == 200  # also an auto one while auto-posting is off: he tapped it


def test_now_on_a_handed_over_waiting_post_keeps_what_take_it_back_restores(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    clip = _uploaded(store, status="failed")
    old = _post(store, clip, "tiktok", status="failed", error="TikTok said no.", postOptions=TIKTOK)
    assert call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})[1]["results"][0]["sent"] is True
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, body["results"]) == (200, [{"clipId": clip["clipId"], "sent": True}])
    raw = table.raw(PK, db.post_sk(old["postId"])) or {}
    assert (raw["macSource"], raw["beforeMac"]["status"]) == ("upload", "failed")
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")[0] == 200
    back = table.raw(PK, db.post_sk(old["postId"])) or {}
    assert (back["status"], back["error"]) == ("failed", "TikTok said no.")
    assert not [k for k in back if k.startswith("mac") or k == "beforeMac"]


def test_now_on_a_waiting_upload_post_writes_nothing(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store, source="upload")
    before = _raw_post(store, clip["clipId"])
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, body["results"]) == (200, [{"clipId": clip["clipId"], "sent": True}])
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert (status, _tiktok(body)["mac"]["source"]) == (200, "upload")
    assert _raw_post(store, clip["clipId"]) == before


def test_send_without_now_still_refuses_a_waiting_mac_post(call: Call, store: db.Store) -> None:
    # Settings' bulk Send these to my Mac is unchanged: a clip the Mac already has stays as it is.
    _mac_on(call)
    clip = _mac_clip(store, source="sent")
    for body_in in ({"clipIds": [clip["clipId"]]}, {"clipIds": [clip["clipId"]], "now": False}):
        status, body = call("POST", "/v1/tiktok/mac/send", body_in)
        assert (status, body["results"]) == (
            200,
            [{"clipId": clip["clipId"], "sent": False, "reason": tiktok_mac.SEND_HAS_IT}],
        )
    assert _raw_post(store, clip["clipId"])["macSource"] == "sent"


def test_send_with_now_still_refuses_a_mac_post_that_does_not_wait(call: Call, store: db.Store) -> None:
    # Working: the Mac is on it. Stopped: Try again is its way (it knows about a pressed Post). Neither changes.
    _mac_on(call)
    working = _mac_clip(store, source="sent")
    assert _claim(call, working["clipId"])[0] == 200
    stopped = _mac_clip(store, source="sent", macState="stopped", macStoppedAt=iso(NOW), macReason="Timed out.")
    pressed = _mac_clip(
        store,
        source="sent",
        macState="stopped",
        macStoppedAt=iso(NOW),
        macPressedAt=iso(NOW),
        macReason=tiktok_mac.PRESSED,
    )
    ids = [working["clipId"], stopped["clipId"], pressed["clipId"]]
    before = {i: _raw_post(store, i) for i in ids}
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": ids, "now": True})
    assert status == 200
    assert [(r["sent"], r.get("reason")) for r in body["results"]] == [(False, tiktok_mac.SEND_HAS_IT)] * 3
    assert {i: _raw_post(store, i) for i in ids} == before


def test_now_on_a_waiting_mac_post_needs_the_switch_for_send(call: Call, store: db.Store) -> None:
    clip = _mac_clip(store, source="sent")
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]], "now": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_OFF)
    assert _raw_post(store, clip["clipId"])["macSource"] == "sent"


def test_now_on_a_waiting_post_the_mac_just_claimed_is_refused_and_changes_nothing(
    store: db.Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The race: the tap read the post waiting, then the Mac claimed it. The write is conditional on waiting, so the
    claimed post keeps its source and its claim."""
    settings = {"tiktokMac": {"on": True}}
    clip = _mac_clip(store, source="sent")
    seen = _raw_post(store, clip["clipId"])
    tiktok_mac.claim(store, clip, DEVICE, NOW, settings)
    monkeypatch.setattr(tiktok_mac, "mac_row", lambda _store, _clip: (dict(seen), [dict(seen)]))
    with pytest.raises(tiktok_self.Refused) as refused:
        tiktok_mac.retry(store, clip, not_on_tiktok=False, now=True, at=NOW)
    assert refused.value.message == tiktok_mac.CHANGED
    monkeypatch.setattr(tiktok_mac, "posts_for_clip", lambda *_a, **_k: [dict(seen)])
    assert tiktok_mac.send(store, USER, clip, settings, NOW, is_campaign=False, source="upload") == tiktok_mac.CHANGED
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macState"], raw["macSource"], raw["macDevice"]) == ("working", "sent", DEVICE)


def test_try_again_with_now_keeps_the_working_and_pressed_refusals(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store, source="sent")
    _claim(call, clip["clipId"])
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert (status, _message(body)) == (409, tiktok_self.MAC_WORKING)
    _step(call, clip["clipId"], "pressing")
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "?"})
    status, body = _retry(call, clip["clipId"], {"now": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAY_HAVE_POSTED)
    status, body = _retry(call, clip["clipId"], {"now": True, "notOnTikTok": True})
    assert (status, _message(body)) == (409, tiktok_mac.MAC_STILL_LOOKING)
    assert _raw_post(store, clip["clipId"])["macSource"] == "sent"
    clock.now = NOW + timedelta(minutes=30)
    status, body = _retry(call, clip["clipId"], {"now": True, "notOnTikTok": True})
    assert status == 200
    assert _tiktok(body)["mac"] == {
        "state": "waiting",
        "since": "2026-11-15T11:00:00.000Z",
        "source": "upload",
        "beatAt": iso(NOW),
    }


# --- the clip page (§16.2) ---------------------------------------------------------------------------------------------------


def test_the_clip_page_shows_the_mac_state_and_who_posted_it(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    row = next(
        p for p in call("GET", f"/v1/clips/{clip['clipId']}/performance")[1]["posts"] if p["platform"] == "tiktok"
    )
    assert (row["status"], row["mac"]["state"]) == ("mac", "waiting")
    _claim(call, clip["clipId"])
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    row = next(
        p for p in call("GET", f"/v1/clips/{clip['clipId']}/performance")[1]["posts"] if p["platform"] == "tiktok"
    )
    assert (row["status"], row["by"], row["via"]) == ("posted", "you", "mac")
    assert "mac" not in row


def test_another_owner_never_sees_or_claims_the_mac_post(call: Call, store: db.Store) -> None:
    from conftest import OTHER

    _mac_on(call)
    clip = _mac_clip(store)
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/claim", {"device": DEVICE}, sub=OTHER)[0] == 404
    assert call("GET", "/v1/tiktok/mac", sub=OTHER)[1]["queue"] == []


# --- review fixes: Everyone for real, Take it back after Post, the switch off, one write, the attempt ----------------


def test_an_upload_that_picked_only_me_still_asks_the_mac_for_everyone_and_done_marks_it_public(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    # Before TikTok approves the app the sheet only offers Only me, so Upload sends SELF_ONLY: the Mac never posts that.
    _connect(store, "tiktok")
    _mac_on(call)
    clip = seed_clip(store)
    _upload(call, clip["clipId"], ["tiktok"], tiktok={**TIKTOK, "privacyLevel": "SELF_ONLY"})
    job = call("GET", "/v1/tiktok/mac")[1]["queue"][0]
    assert (job["privacy"], job["comment"], job["duet"], job["stitch"]) == ("PUBLIC_TO_EVERYONE", True, True, True)
    _claim(call, clip["clipId"])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    assert (_tiktok(body)["privacy"], _tiktok(body)["via"]) == ("public", "mac")
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert raw["statsId"] == VIDEO_ID


def test_done_writes_the_privacy_the_mac_set(call: Call, store: db.Store, table: FakeTable) -> None:
    # Belt and braces: a Mac post that ever held another choice is never called public.
    _connect(store, "tiktok")
    _mac_on(call)
    clip = _mac_clip(store, postOptions={**TIKTOK, "privacyLevel": "SELF_ONLY"})
    _claim(call, clip["clipId"])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/done", {"device": DEVICE, "link": LINK})
    assert status == 200
    assert _tiktok(body)["privacy"] == "private"
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert "statsId" not in raw  # a private post never joins the poller
    assert "gsi2pk" not in raw


@pytest.mark.parametrize("made", [True, False])
def test_take_it_back_after_the_mac_pressed_post_is_refused(
    call: Call, store: db.Store, table: FakeTable, app: App, made: bool
) -> None:
    _connect(store, "tiktok")
    _mac_on(call)
    if made:
        clip = _mac_clip(store)
    else:
        clip = seed_clip(store, status="failed", postsCreated=True, postIds=[])
        _post(store, clip, "tiktok", status="failed", error="x", postOptions=TIKTOK)
        assert call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})[1]["results"][0]["sent"] is True
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "pressing")
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "Timed out."})
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    assert (status, _message(body)) == (409, "Your Mac may have posted it already. Check your TikTok first.")
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    assert (raw["status"], raw["macState"]) == ("mac", "stopped")
    # Nothing can send it through TikTok's API meanwhile: the release and Try again leave it alone.
    assert release.release_waiting(store, app.flows, USER, "tiktok") == 0
    assert (_raw_tiktok(table, clip["clipId"]) or {})["status"] == "mac"
    # His ways out: It's on TikTok (it is there, with or without its link), or Try again after the find window.
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
    assert (status, _message(body)) == (409, "Not found yet. Try again in a minute, or paste the link.")
    assert (_raw_tiktok(table, clip["clipId"]) or {})["status"] == "mac"  # Find it for me saved nothing
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {"noLink": True})
    assert (status, _tiktok(body)["by"]) == (200, "you")


def test_while_the_switch_is_off_auto_posting_offers_post_it_yourself_instead(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    waiting = _mac_clip(store, source="auto", status="posted")
    stopped = _mac_clip(store, source="auto", status="posted", macState="stopped", macDevice=DEVICE)
    pressed = _mac_clip(
        store, source="auto", status="posted", macState="stopped", macDevice=DEVICE, macPressedAt=iso(NOW)
    )
    working = _mac_clip(store, source="auto", status="posted", macState="working", macDevice=DEVICE)
    for c in (waiting, stopped, pressed, working):
        store.update(PK, db.clip_sk(c["clipId"]), {"autoRun": "r#scheduled", "autoAt": iso(NOW)})
    listed = {t["clipId"]: t for t in call("GET", "/v1/autopost")[1]["tiktokYourself"]}
    assert set(listed) == {waiting["clipId"], stopped["clipId"]}  # never one the Mac is posting or pressed Post on
    assert all(t["mac"] is True for t in listed.values())
    _mac_on(call)
    assert call("GET", "/v1/autopost")[1]["tiktokYourself"] == []  # on: the Mac has them


def test_take_it_back_is_one_write_with_its_clip(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    clip = seed_clip(store, status="posted", postsCreated=True, postIds=[])
    call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})
    raw = _raw_tiktok(table, clip["clipId"])
    assert raw is not None
    before = len(table.calls)
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")[0] == 200
    writes = [c for c in table.calls[before:] if c[0] == "transact_write_items"]
    assert len(writes) == 1  # the fake records the transaction's own update and delete after it
    actions = writes[0][1]["TransactItems"]
    assert {next(iter(a)) for a in actions} == {"Update", "Delete"}
    stored = table.raw(clip["pk"], clip["sk"]) or {}
    assert "tiktokForMac" not in stored
    assert raw["postId"] not in stored["postIds"]
    # A clip write that fails rolls the delete back too: the post is never lost while the clip still names it.
    call("POST", "/v1/tiktok/mac/send", {"clipIds": [clip["clipId"]]})
    again = _raw_tiktok(table, clip["clipId"])
    assert again is not None
    table.meta.client.fail_transact = True
    status, _ = call("DELETE", f"/v1/clips/{clip['clipId']}/tiktok/mac")
    table.meta.client.fail_transact = False
    assert status >= 500
    assert _raw_tiktok(table, clip["clipId"]) is not None
    assert (table.raw(clip["pk"], clip["sk"]) or {})["tiktokForMac"] == again["postId"]


def test_take_it_back_reads_a_clip_that_just_settled_again(store: db.Store, table: FakeTable) -> None:
    clip = _mac_clip(store, status="confirmed")
    store.update(PK, db.clip_sk(clip["clipId"]), {"status": "posted"})  # a flow settled it after it was read
    tiktok_mac.take_back(store, clip)
    assert _raw_tiktok(table, clip["clipId"]) is None


def test_the_job_carries_its_attempt_and_an_older_attempt_is_refused(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    job = _claim(call, clip["clipId"])[1]["job"]
    assert job["attempt"] == 1
    clock.now = NOW + timedelta(minutes=16)  # the same Mac crashed, came back and took its own stale claim again
    assert _claim(call, clip["clipId"])[1]["job"]["attempt"] == 2
    path = f"/v1/clips/{clip['clipId']}/tiktok/mac"
    status, body = call("POST", f"{path}/step", {"device": DEVICE, "step": "pressing", "attempt": 1})
    assert (status, _message(body)) == (409, "Another try already has this clip.")
    assert call("POST", f"{path}/stopped", {"device": DEVICE, "reason": "x", "attempt": 1})[0] == 409
    assert call("POST", f"{path}/done", {"device": DEVICE, "attempt": 1})[0] == 409
    assert call("POST", f"{path}/step", {"device": DEVICE, "step": "pressing", "attempt": 2})[0] == 200
    assert call("POST", f"{path}/step", {"device": DEVICE, "step": "finding"})[0] == 200  # still optional
    assert call("POST", f"{path}/step", {"device": DEVICE, "step": "finding", "attempt": "two"})[0] == 400
    status, body = call("POST", f"{path}/done", {"device": DEVICE, "attempt": 2, "link": LINK})
    assert (status, _tiktok(body)["via"]) == (200, "mac")


# --- round 3: the claim's pressed guard, the ping's plan keys, the owner's requests, needsYouClipId ----------------------


def test_a_waiting_post_that_still_has_its_press_is_never_claimed(call: Call, store: db.Store, clock: Clock) -> None:
    # Never twice: only Try again after the find window moves the press away (to macPressedBefore).
    _mac_on(call)
    clip = _mac_clip(store, macPressedAt=iso(NOW))
    status, body = _claim(call, clip["clipId"])
    assert (status, _message(body)) == (409, "Another try already has this clip.")
    raw = _raw_post(store, clip["clipId"])
    assert (raw["macState"], raw["macAttempt"]) == ("waiting", 0)
    # A re-waited one (its press moved to macPressedBefore) is claimed, and keeps both fields for the helper's guard.
    again = _mac_clip(store, macPressedBefore=iso(NOW), macAgainAt=iso(NOW + timedelta(minutes=31)))
    status, body = _claim(call, again["clipId"])
    assert status == 200
    assert (body["job"]["pressedBefore"], body["job"]["againAt"]) == (iso(NOW), iso(NOW + timedelta(minutes=31)))
    assert (_raw_post(store, again["clipId"])["macPressedBefore"]) == iso(NOW)


def test_post_mac_carries_its_beat(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    _beat(call, clip["clipId"], "video", clock, timedelta(minutes=2))
    found = call("GET", "/v1/posts", query={"clipId": clip["clipId"]})[1]["posts"]
    assert _tiktok({"posts": found})["mac"]["beatAt"] == iso(clock.now)
    job = call("GET", "/v1/tiktok/mac")[1]["queue"][0]
    assert job["beatAt"] == iso(clock.now)
    assert not {"pressedBefore", "againAt"} & set(job)


def _ping(call: Call, **extra: Any) -> tuple[int, Any]:
    return call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, **extra})


def test_the_ping_stores_the_helpers_plan_and_a_ping_without_it_removes_it(call: Call, table: FakeTable) -> None:
    plan = {"backlogAt": "2026-11-15T12:30:00.000Z", "holdBefore": "2026-11-15T02:55:00Z", "backfill": True}
    assert _ping(call, **plan)[0] == 200
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert {k: helper.get(k) for k in plan} == plan
    assert _ping(call, backfill=False)[0] == 200
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert not {"backlogAt", "holdBefore", "backfill"} & set(helper)
    assert not {"backlogAt", "holdBefore", "backfill"} & set(table.raw(PK, "MACHELPER") or {})


@pytest.mark.parametrize(
    ("extra", "sentence"),
    [
        ({"backlogAt": "soon"}, "backlogAt must be a time."),
        ({"backlogAt": 1}, "backlogAt must be a time."),
        ({"backlogAt": "2026-11-15T12:30:00.000Z" + " " * 20}, "backlogAt must be a time."),
        ({"holdBefore": "yesterday"}, "holdBefore must be a time."),
        ({"backfill": "yes"}, "backfill must be true or false."),
        ({"resumeDone": "x" * 41}, "resumeDone is too long (at most 40 characters)."),
        ({"letGoDone": 5}, "letGoDone must be text."),
        ({"burst": True}, "Unknown field: burst."),
    ],
)
def test_a_ping_with_a_bad_plan_key_is_refused(
    call: Call, table: FakeTable, extra: dict[str, Any], sentence: str
) -> None:
    status, body = _ping(call, **extra)
    assert (status, _message(body)) == (400, sentence)
    assert table.raw(PK, "MACHELPER") is None


def test_a_needs_you_stop_names_its_clip_until_an_ok_ping(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _stop_needing_you(call, clip["clipId"])
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["needsYouClipId"] == clip["clipId"]
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "needs_you", "reason": "x", "device": DEVICE})[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["needsYouClipId"] == clip["clipId"]  # still needs him
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE})[0] == 200
    assert "needsYouClipId" not in call("GET", "/v1/tiktok/mac")[1]["helper"]


def _request(call: Call, action: Any) -> tuple[int, Any]:
    return call("POST", "/v1/tiktok/mac/request", {"action": action})


def test_start_my_mac_again_waits_for_the_helper_to_say_it_did_that_one(
    call: Call, table: FakeTable, clock: Clock
) -> None:
    status, body = _request(call, "resume")
    assert (status, _message(body)) == (409, "Your Mac hasn't checked in yet. Set it up on your Mac.")
    assert _ping(call)[0] == 200
    status, body = _request(call, "resume")
    assert (status, _message(body)) == (409, "Your Mac isn't paused.")
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "reason": "Paused.", "device": DEVICE})[0] == 200
    status, body = _request(call, "resume")
    assert status == 200
    assert body["helper"]["resumeRequest"] == {"at": iso(NOW)}
    assert (table.raw(PK, "MACHELPER") or {})["resumeRequestAt"] == iso(NOW)
    # A ping that did an older request leaves the newer one; the one it did removes it.
    paused = {"state": "paused", "reason": "Paused.", "device": DEVICE}
    assert call("POST", "/v1/tiktok/mac/ping", {**paused, "resumeDone": "2026-11-15T09:00:00.000Z"})[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["resumeRequest"] == {"at": iso(NOW)}
    assert _ping(call, resumeDone=iso(NOW))[0] == 200
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert "resumeRequest" not in helper
    assert helper["state"] == "ok"


def test_let_them_go_needs_a_hold_and_only_its_own_done_removes_it(call: Call, table: FakeTable, clock: Clock) -> None:
    assert _ping(call)[0] == 200
    status, body = _request(call, "let_go")
    assert (status, _message(body)) == (409, "Your Mac isn't holding any clips.")
    hold = {"holdBefore": "2026-11-23T02:55:00.000Z"}
    assert _ping(call, **hold)[0] == 200
    status, body = _request(call, "let_go")
    assert status == 200
    assert (body["helper"]["letGoRequest"], body["helper"]["holdBefore"]) == ({"at": iso(NOW)}, hold["holdBefore"])
    assert "resumeRequest" not in body["helper"]
    # resumeDone never removes a let-go request, and an older letGoDone neither.
    assert _ping(call, **hold, resumeDone=iso(NOW), letGoDone="2026-11-15T09:00:00.000Z")[0] == 200
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["letGoRequest"] == {"at": iso(NOW)}
    assert _ping(call, letGoDone=iso(NOW))[0] == 200  # the helper cleared its hold: no holdBefore any more
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert not {"letGoRequest", "holdBefore"} & set(helper)


@pytest.mark.parametrize("body", [{"action": "pause"}, {"action": None}, {}, {"action": "resume", "at": "now"}])
def test_the_request_route_refuses_what_it_does_not_know(call: Call, body: dict[str, Any]) -> None:
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "device": DEVICE})[0] == 200
    status, answer = call("POST", "/v1/tiktok/mac/request", body)
    assert status == 400
    if "at" not in body:
        assert _message(answer) == "Pick resume or let_go."
    assert "resumeRequest" not in call("GET", "/v1/tiktok/mac")[1]["helper"]


# --- the words (D1, D6) ---------------------------------------------------------------------------------------------------


def test_the_campaign_words_have_one_source() -> None:
    from clipfactory_api.contentrewards import campaigns, fit
    from clipfactory_api.routes import clips as clip_routes

    skips = tiktok_mac.CAMPAIGN_SKIPS
    assert skips == "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet."
    assert skips == fit.TIKTOK_WAITS
    assert skips == tiktok_mac.SEND_CAMPAIGN
    assert not hasattr(tiktok_mac, "options_for")
    assert not hasattr(clip_routes, "TIKTOK_PRIVATE")
    assert not hasattr(tiktok_self, "MAC_STUCK")
    view = SimpleNamespace(
        conn={}, setups=[{"platform": "tiktok", "gates": [{"key": "posting_audit", "state": "waiting"}]}]
    )
    assert campaigns._places_note(view, {"platformsPaid": ["youtube", "tiktok"]}, ["youtube"]) == skips  # type: ignore[arg-type]
    campaign = clip_routes.CampaignClip(CAMPAIGN, {}, ("tiktok",), {})
    setups = [{"platform": "tiktok", "ready": True, "gates": [{"key": "posting_audit", "state": "ok"}]}]
    upload = clip_routes._place_refusal("tiktok", campaign, setups, {})
    again = clip_routes._place_refusal("tiktok", campaign, setups, {}, try_again=True)
    assert upload == f"{skips} Turn TikTok off, then tap Upload."
    assert again == f"{skips} Tap Try again on another place."
    audited = [{**setups[0], "gates": [{"key": "app_review", "state": "ok"}, {"key": "posting_audit", "state": "ok"}]}]
    assert clip_routes._place_refusal("tiktok", campaign, audited, {}) is None


def test_the_server_words_name_only_buttons_the_owner_has() -> None:
    import ast
    from pathlib import Path

    from clipfactory_api.platforms import errors
    from clipfactory_api.routes import tiktok_mac as routes

    assert tiktok_mac.PRESSED == (
        "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok."
    )
    assert tiktok_mac.MAC_STILL_LOOKING == (
        "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later."
    )
    assert tiktok_self.NOT_UPLOADED == "Upload this clip first. Then your Mac can post it on TikTok."
    assert errors.TIKTOK_PRIVATE_ONLY == (
        "TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone."
    )
    for module in (tiktok_self, tiktok_mac, routes, errors):
        tree = ast.parse(Path(str(module.__file__)).read_text(encoding="utf-8"))
        docs = {
            id(n.body[0].value)
            for n in ast.walk(tree)
            if isinstance(n, ast.Module | ast.FunctionDef | ast.ClassDef)
            and n.body
            and isinstance(n.body[0], ast.Expr)
            and isinstance(n.body[0].value, ast.Constant)
        }
        said = [
            n.value
            for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs
        ]
        for text in said:
            assert "post it yourself" not in text.lower(), (module.__name__, text)
            assert "i posted it" not in text.lower(), (module.__name__, text)


# --- §47.11: a TikTok login hold ends by itself once the Mac is logged in again ----------------------------------


def _login_stop(call: Call, clip_id: str, *, code: str | None = "login", pressed: bool = False) -> None:
    """The Mac claims the clip (and presses Post), then stops for a TikTok login (``code``) and asks for the owner."""
    assert _claim(call, clip_id)[0] == 200
    if pressed:
        assert _step(call, clip_id, "pressing")[0] == 200
    body: dict[str, Any] = {"device": DEVICE, "reason": "TikTok logged your Mac out.", "needsYou": True}
    if code is not None:
        body["code"] = code
    assert call("POST", f"/v1/clips/{clip_id}/tiktok/mac/stopped", body)[0] == 200


def _logged_in(call: Call, clip_id: str, device: str = DEVICE, **extra: Any) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/tiktok/mac/logged-in", {"device": device, **extra})


def _helper_raw(table: FakeTable) -> dict[str, Any]:
    found = table.raw(PK, "MACHELPER")
    assert found is not None
    return found


def test_a_login_stop_stores_its_code_only_with_needs_you(call: Call, store: db.Store, table: FakeTable) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert (helper["state"], helper["needsYouClipId"], helper["needsYouCode"]) == ("needs_you", clip["clipId"], "login")
    # A later needs-you stop without a code (a puzzle) never inherits "login".
    other = _mac_clip(store)
    assert _claim(call, other["clipId"])[0] == 200
    body = {"device": DEVICE, "reason": "TikTok wants a check.", "needsYou": True}
    assert call("POST", f"/v1/clips/{other['clipId']}/tiktok/mac/stopped", body)[0] == 200
    assert "needsYouCode" not in _helper_raw(table)
    assert "needsYouCode" not in call("GET", "/v1/tiktok/mac")[1]["helper"]
    # A code without needsYou holds nothing, so it isn't stored.
    third = _mac_clip(store)
    assert _claim(call, third["clipId"])[0] == 200
    body = {"device": DEVICE, "reason": "Slow.", "code": "login"}
    assert call("POST", f"/v1/clips/{third['clipId']}/tiktok/mac/stopped", body)[0] == 200
    assert "needsYouCode" not in _helper_raw(table)


@pytest.mark.parametrize("code", ["captcha", "", 1, True])
def test_a_stop_with_another_code_is_refused(call: Call, store: db.Store, code: Any) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    assert _claim(call, clip["clipId"])[0] == 200
    body = {"device": DEVICE, "reason": "x", "needsYou": True, "code": code}
    status, out = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", body)
    assert (status, _message(out)) == (400, "code must be login.")
    assert _raw_post(store, clip["clipId"])["macState"] == "working"


def test_the_login_code_goes_with_an_ok_ping_try_again_and_its_on_tiktok(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "needs_you", "reason": "x", "device": DEVICE})[0] == 200
    assert _helper_raw(table)["needsYouCode"] == "login"  # a needs_you ping keeps it
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "reason": "x", "device": DEVICE})[0] == 200
    assert "needsYouCode" not in _helper_raw(table)
    # The owner's Try again, and his It's on TikTok, remove it with the hold.
    again = _mac_clip(store)
    _login_stop(call, again["clipId"])
    assert call("POST", f"/v1/clips/{again['clipId']}/tiktok/mac/retry", {})[0] == 200
    assert not {"needsYouCode", "needsYouClipId"} & set(_helper_raw(table))
    marked = _mac_clip(store)
    _login_stop(call, marked["clipId"])
    assert call("POST", f"/v1/clips/{marked['clipId']}/tiktok/posted", {"link": LINK})[0] == 200
    assert not {"needsYouCode", "needsYouClipId"} & set(_helper_raw(table))
    assert _helper_raw(table)["state"] == "ok"


def test_the_helper_shows_its_code_only_while_it_needs_the_owner() -> None:
    held = {"seenAt": iso(NOW), "state": "needs_you", "needsYouCode": "login", "needsYouClipId": "c1"}
    assert (tiktok_mac.public_helper(held) or {})["needsYouCode"] == "login"
    for item in ({**held, "state": "ok"}, {**held, "needsYouCode": "captcha"}, {**held, "needsYouCode": None}):
        assert "needsYouCode" not in (tiktok_mac.public_helper(item) or {})


def test_logged_in_puts_the_stopped_clip_back_in_line_and_ends_the_hold(
    call: Call, store: db.Store, table: FakeTable, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clipfactory_api.routes import tiktok_mac as routes

    logged: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(routes, "log", lambda _level, event, **k: logged.append((event, k)))
    _mac_on(call)
    # A backlog clip ("sent") re-waited after an earlier press: its never-twice fields must stay as they are.
    before = {"macPressedBefore": "2026-11-15T10:00:00.000Z", "macAgainAt": "2026-11-15T10:40:00.000Z"}
    clip = _mac_clip(store, source="sent", **before)
    _login_stop(call, clip["clipId"])
    clock.now = NOW + timedelta(minutes=9)
    status, body = _logged_in(call, clip["clipId"])
    assert status == 200, body
    assert body["outcome"] == "resumed"
    assert body["helper"]["state"] == "ok"
    assert not {"reason", "needsYouClipId", "needsYouCode"} & set(body["helper"])
    raw = _raw_post(store, clip["clipId"])
    assert raw["macState"] == "waiting"
    assert (raw["macSince"], raw["macSource"], raw["macAttempt"], raw["macDevice"]) == (
        "2026-11-15T11:00:00.000Z",
        "sent",  # never an Upload tap's: the owner's pacing stays
        1,
        DEVICE,
    )
    assert {k: raw[k] for k in before} == before  # never moved
    assert not {"macStep", "macClaimedAt", "macStoppedAt", "macReason", "macPressedAt"} & set(raw)
    assert not {"reason", "needsYouClipId", "needsYouCode"} & set(_helper_raw(table))
    assert ("tiktok_mac.logged_in", {"clipId": clip["clipId"], "outcome": "resumed"}) in logged
    # The Mac claims it afresh, as after Try again.
    status, body = _claim(call, clip["clipId"])
    assert status == 200, body
    assert (body["job"]["attempt"], body["job"]["pressedBefore"], body["job"]["againAt"]) == (
        2,
        before["macPressedBefore"],
        before["macAgainAt"],
    )
    # A second call finds no hold any more.
    status, body = _logged_in(call, clip["clipId"])
    assert (status, _message(body)) == (409, tiktok_mac.NOT_LOGIN_HOLD)


def test_logged_in_after_post_was_pressed_ends_the_hold_and_leaves_the_clip_for_the_owner(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"], pressed=True)
    post_before = _raw_post(store, clip["clipId"])
    status, body = _logged_in(call, clip["clipId"])
    assert (status, body["outcome"], body["helper"]["state"]) == (200, "pressed", "ok")
    assert _raw_post(store, clip["clipId"]) == post_before  # untouched: never twice
    assert post_before["macReason"] == tiktok_mac.PRESSED
    assert _claim(call, clip["clipId"])[0] == 409  # still never claimed again by itself


def test_logged_in_on_a_clip_that_is_gone_or_no_longer_a_mac_post_only_ends_the_hold(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    gone = _mac_clip(store)
    _login_stop(call, gone["clipId"])
    post = _raw_post(store, gone["clipId"])
    store.delete(str(post["pk"]), str(post["sk"]))
    store.delete(gone["pk"], gone["sk"])
    status, body = _logged_in(call, gone["clipId"])
    assert (status, body["outcome"], body["helper"]["state"]) == (200, "cleared", "ok")
    elsewhere = _mac_clip(store)
    _login_stop(call, elsewhere["clipId"])
    post = _raw_post(store, elsewhere["clipId"])
    store.update(str(post["pk"]), str(post["sk"]), {"status": "posted"})
    status, body = _logged_in(call, elsewhere["clipId"])
    assert (status, body["outcome"]) == (200, "cleared")
    assert _raw_post(store, elsewhere["clipId"])["status"] == "posted"
    assert _helper_raw(table)["state"] == "ok"


def test_logged_in_is_refused_unless_this_mac_holds_this_clip_for_a_login(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    status, body = _logged_in(call, clip["clipId"])  # no helper item at all
    assert (status, _message(body)) == (409, tiktok_mac.NOT_LOGIN_HOLD)
    _login_stop(call, clip["clipId"], code=None)  # a hold without the code (a puzzle, or an older helper)
    assert _logged_in(call, clip["clipId"])[0] == 409
    other = _mac_clip(store)
    _login_stop(call, other["clipId"])
    assert _logged_in(call, clip["clipId"])[0] == 409  # the hold is on another clip
    assert _logged_in(call, other["clipId"], device="mac-mini-2")[0] == 409  # another Mac
    post = _raw_post(store, other["clipId"])
    store.update(str(post["pk"]), str(post["sk"]), {"macDevice": "mac-mini-2"})
    before = json.dumps(table.all(), sort_keys=True, default=str)
    status, body = _logged_in(call, other["clipId"])  # the post is another Mac's
    assert (status, _message(body)) == (409, tiktok_mac.NOT_LOGIN_HOLD)
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    assert _helper_raw(table)["state"] == "needs_you"


@pytest.mark.parametrize("body", [{"device": DEVICE, "now": True}, {}, {"device": 5}, {"device": "x" * 101}])
def test_logged_in_takes_only_a_device(call: Call, store: db.Store, table: FakeTable, body: dict[str, Any]) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])
    status, _out = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/logged-in", body)
    assert status == 400
    assert _helper_raw(table)["state"] == "needs_you"


def test_logged_in_loses_to_a_change_of_the_hold_or_the_post(
    call: Call, store: db.Store, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])
    stale_helper = _helper_raw(table)
    # The owner answered meanwhile (his Try again cleared the hold): the write needs the hold as read.
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})[0] == 200
    monkeypatch.setattr(tiktok_mac, "helper_item", lambda *_a: stale_helper)
    before = json.dumps(table.all(), sort_keys=True, default=str)
    status, body = _logged_in(call, clip["clipId"])
    assert (status, _message(body)) == (409, tiktok_mac.CHANGED)
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    monkeypatch.undo()
    # The post moved meanwhile (claimed again by another try): nothing is written, the hold stays.
    again = _mac_clip(store)
    _login_stop(call, again["clipId"])
    stale_post = _raw_post(store, again["clipId"])
    store.update(str(stale_post["pk"]), str(stale_post["sk"]), {"macState": "working"})
    monkeypatch.setattr(tiktok_mac, "posts_for_clip", lambda *_a, **_k: [stale_post])
    status, body = _logged_in(call, again["clipId"])
    assert (status, _message(body)) == (409, tiktok_mac.CHANGED)
    monkeypatch.undo()
    assert _helper_raw(table)["state"] == "needs_you"
    assert _raw_post(store, again["clipId"])["macState"] == "working"


def test_a_second_macs_needs_you_ping_never_takes_the_hold_from_the_mac_that_stopped(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    """Review, 24 Nov: every ping rewrites ``device``, and a second Mac pings needs_you every minute, so the hold must
    name the Mac that stopped in its own field (``needsYouDevice``, never public) or that Mac's logged-in is refused."""
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])  # Mac A (DEVICE) stops for a login
    assert _helper_raw(table)["needsYouDevice"] == DEVICE
    # Mac B's tick reads the needs_you and checks in, as run.js does every minute.
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "needs_you", "reason": "x", "device": "mac-mini-2"})[0] == 200
    held = _helper_raw(table)
    assert (held["device"], held["needsYouDevice"], held["needsYouCode"]) == ("mac-mini-2", DEVICE, "login")
    assert "needsYouDevice" not in (call("GET", "/v1/tiktok/mac")[1]["helper"] or {})
    # Mac B (its Chrome logged in too) is refused: it didn't stop this clip.
    assert _logged_in(call, clip["clipId"], device="mac-mini-2")[0] == 409
    assert _helper_raw(table)["state"] == "needs_you"
    # Mac A, whose stop it is, ends the hold.
    status, body = _logged_in(call, clip["clipId"])
    assert (status, body["outcome"]) == (200, "resumed"), body
    assert not {"needsYouClipId", "needsYouCode", "needsYouDevice"} & set(_helper_raw(table))
    # Any other ping removes it with the hold, and so does the owner's answer.
    again = _mac_clip(store)
    _login_stop(call, again["clipId"])
    assert call("POST", "/v1/tiktok/mac/ping", {"state": "paused", "reason": "x", "device": DEVICE})[0] == 200
    assert "needsYouDevice" not in _helper_raw(table)
    third = _mac_clip(store)
    _login_stop(call, third["clipId"])
    assert call("POST", f"/v1/clips/{third['clipId']}/tiktok/mac/retry", {})[0] == 200
    assert "needsYouDevice" not in _helper_raw(table)


def test_a_needs_you_ping_never_starts_a_hold(
    call: Call, store: db.Store, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review, 24 Nov: the helper read needs_you, the owner's Try again ended it, and the tick's ping then said
    needs_you: that wrote back a hold with no clip and no code, which nothing ended. Only a stop starts a hold."""
    _mac_on(call)
    clip = _mac_clip(store)
    _login_stop(call, clip["clipId"])
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})[0] == 200  # his Try again
    stale = {"state": "needs_you", "reason": "TikTok logged your Mac out.", "device": DEVICE, "version": "1.2.2"}
    assert call("POST", "/v1/tiktok/mac/ping", stale)[0] == 200  # the tick's ping from its first read
    helper = _helper_raw(table)
    assert (helper["state"], helper["seenAt"], helper["version"]) == ("ok", iso(NOW), "1.2.2")
    assert not {"reason", "needsYouClipId", "needsYouCode", "needsYouDevice"} & set(helper)
    assert _raw_post(store, clip["clipId"])["macState"] == "waiting"
    # No helper item at all: a needs_you ping writes ok too.
    store.delete(PK, "MACHELPER")
    assert call("POST", "/v1/tiktok/mac/ping", stale)[0] == 200
    assert (_helper_raw(table)["state"], _helper_raw(table).get("reason")) == ("ok", None)
    # The hold ends between the ping's read and its write: the conditional write loses and checks in as ok.
    other = _mac_clip(store)
    _login_stop(call, other["clipId"])
    read = _helper_raw(table)
    assert call("POST", f"/v1/clips/{other['clipId']}/tiktok/mac/retry", {})[0] == 200
    monkeypatch.setattr(tiktok_mac, "helper_item", lambda *_a: dict(read))
    assert call("POST", "/v1/tiktok/mac/ping", stale)[0] == 200
    monkeypatch.undo()
    helper = _helper_raw(table)
    assert helper["state"] == "ok"
    assert not {"reason", "needsYouClipId", "needsYouCode", "needsYouDevice"} & set(helper)
    # A hold a stop started stays with a needs_you ping (it keeps the clip, the code and the stopping Mac).
    third = _mac_clip(store)
    _login_stop(call, third["clipId"])
    assert call("POST", "/v1/tiktok/mac/ping", stale)[0] == 200
    helper = _helper_raw(table)
    assert (helper["state"], helper["needsYouClipId"], helper["needsYouCode"], helper["needsYouDevice"]) == (
        "needs_you",
        third["clipId"],
        "login",
        DEVICE,
    )


def test_the_hold_codes_stay_one_line_for_the_helper_pin() -> None:
    import re
    from pathlib import Path

    text = Path(tiktok_mac.__file__).read_text(encoding="utf-8")
    assert re.findall(r"^HOLD_CODES = \(([^)]*)\)$", text, re.M) == ['"login",']
    assert tiktok_mac.HOLD_CODES == ("login",)
