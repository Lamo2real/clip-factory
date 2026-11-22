"""Your Mac posts it on TikTok (docs/CONTRACTS.md §47; tests §47.5): the Mac post, the helper's routes and the owner's.

Every rule is its own test: a Mac post is never ``queued`` (so it is never released, tried again, posted now or
published by the clip flow), the clip settles as usual, Upload's API TikTok rule is unchanged with the switch off,
campaign clips never get one, the queue and its off switches, the claim races (a crashed helper, never twice after
Post was pressed), done through ``tiktok_self.mark_posted`` (repeat-safe, one TikTok post per clip), I posted it vs the
Mac, Take it back, Send these to my Mac and Try again. Offline: in-memory items and fakes only.
"""

from __future__ import annotations

from datetime import timedelta
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
    assert (raw["madeForMac"], raw["macAttempt"], raw["postOptions"]) == (True, 0, TIKTOK)
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


def test_a_campaign_clip_keeps_todays_path(call: Call, store: db.Store, table: FakeTable) -> None:
    # Posting audit ok but the app review not live: not audited, so a normal clip would go to the Mac.
    ready_with_audit(store, "tiktok", audit="ok")
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
    assert (raw["status"], raw["campaignId"]) == ("queued", CAMPAIGN)
    assert "macState" not in raw


def test_an_auto_posting_run_never_hands_a_campaign_clip_to_the_mac(
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
    }


def test_auto_posted_mac_posts_wait_while_auto_posting_is_off(call: Call, store: db.Store, clock: Clock) -> None:
    _mac_on(call)
    auto = _mac_clip(store, source="auto")
    upload = _mac_clip(store, source="upload")
    working = _mac_clip(store, source="auto", macState="working", macDevice=DEVICE, macBeatAt=iso(NOW))
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert {j["clipId"] for j in queue} == {upload["clipId"], working["clipId"]}  # a working one stays (its helper's)
    status, body = _claim(call, auto["clipId"])
    assert (status, _message(body)) == (409, "Auto-posting is off, so this one waits.")
    call("PUT", "/v1/settings", {"autoPost": {"on": True}})
    assert auto["clipId"] in {j["clipId"] for j in call("GET", "/v1/tiktok/mac")[1]["queue"]}


def test_the_queue_holds_at_most_fifty(call: Call, store: db.Store) -> None:
    _mac_on(call)
    for _ in range(52):
        _mac_clip(store)
    assert len(call("GET", "/v1/tiktok/mac")[1]["queue"]) == tiktok_mac.QUEUE_MAX


def test_ping_writes_the_helper_item_and_answers_on(call: Call, table: FakeTable, clock: Clock) -> None:
    status, body = call("POST", "/v1/tiktok/mac/ping", {"state": "ok", "device": DEVICE, "version": "1.0.0"})
    assert (status, body) == (200, {"on": False})
    _mac_on(call)
    long = "TikTok wants you to log in again. " * 10
    status, body = call("POST", "/v1/tiktok/mac/ping", {"state": "needs_you", "reason": long, "device": DEVICE})
    assert body == {"on": True}
    helper = call("GET", "/v1/tiktok/mac")[1]["helper"]
    assert helper["state"] == "needs_you"
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
        "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it."
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
    assert body["note"] == "Saved. Clip Factory could not find it on your TikTok yet. Tap Add link in a minute."
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
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})
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
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})
    assert status == 200
    mac = _tiktok(body)["mac"]
    assert mac == {"state": "waiting", "since": "2026-11-15T11:00:00.000Z", "source": "upload"}  # keeps its place
    assert call("GET", "/v1/tiktok/mac")[1]["helper"]["state"] == "ok"
    assert _claim(call, clip["clipId"])[0] == 200
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})[0] == 409  # working now


def test_try_again_after_post_was_pressed_needs_not_on_tiktok(call: Call, store: db.Store) -> None:
    _mac_on(call)
    clip = _mac_clip(store)
    _claim(call, clip["clipId"])
    _step(call, clip["clipId"], "pressing")
    call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/stopped", {"device": DEVICE, "reason": "?"})
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {})
    assert (status, _message(body)) == (409, "Your Mac may have posted it already. Check your TikTok first.")
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/tiktok/mac/retry", {"notOnTikTok": True})
    assert status == 200
    assert "pressedAt" not in _tiktok(body)["mac"]
    assert _claim(call, clip["clipId"])[0] == 200


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
    # Then Post it yourself: I posted it makes his own post as before.
    assert call("POST", f"/v1/clips/{clip['clipId']}/tiktok/posted", {})[0] == 200


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
    put_campaign(store, platformsPaid=["tiktok"])
    paid = campaign_clip(store, status="posted", postsCreated=True, postIds=[])
    missing = ulid()
    ids = [review, starting, test_clip, queued, yours, public, paid]
    status, body = call("POST", "/v1/tiktok/mac/send", {"clipIds": [c["clipId"] for c in ids] + [missing, "nope"]})
    assert status == 200
    assert [(r["sent"], r.get("reason")) for r in body["results"]] == [
        (False, "Upload this clip first."),
        (False, "This clip is still starting to upload. Try again in a minute."),
        (False, "This was a Private test, so it stays off TikTok."),
        (False, "This clip is still uploading to TikTok. Wait until it is done, then try again."),
        (False, "You already posted this one on TikTok."),
        (False, "This clip is already on TikTok for everyone."),
        (False, "Campaign clips go on TikTok by hand. Tap Post it yourself."),
        (False, "We could not find that clip."),
        (False, "We could not find that clip."),
    ]
    assert not [i for i in table.all() if i.get("status") == "mac"]


def test_sent_clips_go_after_uploads_oldest_clip_first(call: Call, store: db.Store) -> None:
    _mac_on(call)
    newer = _uploaded(store, decidedAt="2026-11-15T10:00:00.000Z")
    older = _uploaded(store, decidedAt="2026-11-14T10:00:00.000Z")
    upload = _mac_clip(store, macSince=iso(NOW + timedelta(hours=1)))
    call("POST", "/v1/tiktok/mac/send", {"clipIds": [newer["clipId"], older["clipId"]]})
    queue = call("GET", "/v1/tiktok/mac")[1]["queue"]
    assert [j["clipId"] for j in queue] == [upload["clipId"], older["clipId"], newer["clipId"]]
    assert {j["source"] for j in queue[1:]} == {"sent"}


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
