"""CR active: a logo and text on a clip in Review (docs/CONTRACTS.md §53 C1, C5, C6): the switch, the edit and its
Reset, the 5-minute timeout, the refusals while the edit is being made, and auto-posting skipping such a clip.
In-memory items, the fake bucket and the fake agent runtime only."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from autopost_support import SLOT, clip_of, deps, ready, review_clip, run_item, turn_on
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.autopost import pick, run
from clipfactory_api.clock import iso
from clipfactory_api.ids import ulid
from conftest import NOW, OTHER, USER, Call, Clock, seed_clip
from fakes import FakeAgentCore, FakeLambda, FakeS3, FakeTable

CAMPAIGN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
STILL_MAKING = "The edit is still being made."
LOGO = {"logoId": "L0001", "x": 0.85, "y": 0.1, "size": 0.22}
TEXT = {"text": "Join #ad now", "x": 0.5, "y": 0.9, "size": "m"}
INTERNAL = ("origVideoKey", "editKey", "videoKey", "startedAt")


def seed_logo(store: db.Store, logo_id: str = "L0001", user: str = USER, status: str = "ready") -> str:
    key = f"logos/{user}/{logo_id}.png"
    store.put(
        {
            "pk": db.user_pk(user),
            "sk": db.logo_sk(logo_id),
            "type": "logo",
            "userId": user,
            "logoId": logo_id,
            "name": "Brand",
            "key": key,
            "status": status,
            "width": 200,
            "height": 100,
            "createdAt": "2026-11-15T11:00:00.000Z",
        }
    )
    return key


def seed_campaign(store: db.Store, uuid: str = CAMPAIGN, user: str = USER) -> None:
    store.put(
        {"pk": db.user_pk(user), "sk": db.campaign_sk(uuid), "type": "campaign", "userId": user, "campaignId": uuid}
    )


def active_clip(store: db.Store, s3_client: FakeS3, **fields: Any) -> dict[str, Any]:
    return seed_clip(store, s3_client, cr={"active": True}, **fields)


def edited_clip(store: db.Store, s3_client: FakeS3, **fields: Any) -> dict[str, Any]:
    """A clip whose edit is done: ``videoKey`` is the edited file, the original is kept."""
    clip_id, job_id = ulid(), ulid()
    original = f"jobs/{job_id}/clips/{clip_id}/clip.mp4"
    edit = f"jobs/{job_id}/clips/{clip_id}/edit-1.mp4"
    s3_client.objects[edit] = b"edited"
    clip = seed_clip(
        store,
        s3_client,
        clipId=clip_id,
        job_id=job_id,
        cr={"active": True, "campaignId": CAMPAIGN},
        overlay={"rev": 1, "status": "ready", "startedAt": iso(NOW), "logo": {**LOGO, "key": "logos/x/L0001.png"}},
        origVideoKey=original,
        editKey=edit,
        videoKey=edit,
        **fields,
    )
    s3_client.objects[original] = b"original"
    return clip


def put_overlay(call: Call, clip_id: str, body: Any = None, **kw: Any) -> tuple[int, Any]:
    return call("PUT", f"/v1/clips/{clip_id}/overlay", {"logo": LOGO} if body is None else body, **kw)


def raw(table: FakeTable, clip_id: str) -> dict[str, Any]:
    found = table.raw(db.user_pk(USER), db.clip_sk(clip_id))
    assert found is not None
    return found


# --- the switch (C1) ---------------------------------------------------------------------------------------------


def test_a_clip_is_inactive_until_switched_on_and_the_switch_stores_nothing_else(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = seed_clip(store, s3_client)
    assert "cr" not in call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]
    status, body = call("PUT", f"/v1/clips/{clip['clipId']}/cr", {"active": True})
    assert (status, body["clip"]["cr"]) == (200, {"active": True})
    assert "overlay" not in body["clip"]
    before = raw(table, clip["clipId"])
    assert (before["videoKey"], before["status"]) == (clip["videoKey"], "review")
    assert call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]["cr"] == {"active": True}
    assert call("GET", "/v1/clips")[1]["clips"][0]["cr"] == {"active": True}


def test_a_campaign_must_be_one_of_the_owners(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(store, s3_client)
    path = f"/v1/clips/{clip['clipId']}/cr"
    seed_campaign(store)
    seed_campaign(store, "11111111-2222-4333-8444-555555555555", OTHER)
    assert call("PUT", path, {"active": True, "campaignId": CAMPAIGN.upper()})[1]["clip"]["cr"] == {
        "active": True,
        "campaignId": CAMPAIGN,
    }
    assert call("PUT", path, {"active": True, "campaignId": "11111111-2222-4333-8444-555555555555"})[0] == 404
    assert call("PUT", path, {"active": True, "campaignId": "0b1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"})[0] == 404
    assert call("PUT", path, {"active": True, "campaignId": "nope"})[0] == 404
    assert call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]["cr"]["campaignId"] == CAMPAIGN  # unchanged by a 404


def test_the_switch_checks_its_body_the_clip_and_its_state(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(store, s3_client)
    path = f"/v1/clips/{clip['clipId']}/cr"
    assert call("PUT", path, {})[0] == 400
    assert call("PUT", path, {"active": "yes"})[0] == 400
    assert call("PUT", path, {"active": True, "x": 1})[0] == 400
    assert call("PUT", f"/v1/clips/{'0' * 26}/cr", {"active": True})[0] == 404
    assert call("PUT", path, {"active": True}, sub=OTHER)[0] == 404
    for state in ("confirmed", "posted", "declined"):
        done = seed_clip(store, s3_client, status=state)
        status, body = call("PUT", f"/v1/clips/{done['clipId']}/cr", {"active": True})
        assert (status, body["error"]["message"]) == (409, "This clip has already been uploaded or thrown away.")


def test_switching_off_puts_the_original_back(call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3) -> None:
    clip = edited_clip(store, s3_client)
    status, body = call("PUT", f"/v1/clips/{clip['clipId']}/cr", {"active": False})
    assert status == 200
    assert body["clip"]["cr"] == {"active": False}
    assert "overlay" not in body["clip"]
    stored = raw(table, clip["clipId"])
    assert stored["videoKey"] == clip["origVideoKey"]
    assert not {"overlay", "editKey", "origVideoKey"} & set(stored)
    assert clip["editKey"] not in s3_client.objects
    assert clip["origVideoKey"] in s3_client.objects
    assert body["clip"]["videoUrl"].endswith(f"{clip['origVideoKey']}?op=get_object&X-Amz-Signature=fake")
    # Switching off again, or on a clip that was never edited, changes nothing else.
    assert call("PUT", f"/v1/clips/{clip['clipId']}/cr", {"active": False})[0] == 200


# --- the edit (C5) -----------------------------------------------------------------------------------------------


def test_make_it_writes_working_and_asks_the_agent_once(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    body = {"logo": LOGO, "text": TEXT, "timing": {"startSec": 2, "endSec": 12.5}}
    status, out = put_overlay(call, clip["clipId"], body)
    assert status == 200
    shown = out["clip"]
    assert shown["overlay"] == {
        "rev": 1,
        "status": "working",
        "logos": [{"layerId": "l1", **LOGO, "timing": {"startSec": 2.0, "endSec": 12.5}}],  # §54: one layer
        "text": TEXT,
        "timing": {"startSec": 2.0, "endSec": 12.5},
    }
    assert shown["cr"] == {"active": True}
    assert shown["videoUrl"].endswith(f"{clip['videoKey']}?op=get_object&X-Amz-Signature=fake")  # still the original
    for hidden in INTERNAL:
        assert hidden not in shown
    assert "key" not in shown["overlay"]["logos"][0]
    (call_made,) = agentcore.calls
    assert call_made["payload"] == {
        "action": "overlay",
        "userId": USER,
        "clipId": clip["clipId"],
        "jobId": clip["jobId"],
        "rev": 1,
    }
    assert call_made["runtimeSessionId"].startswith("cfjob-")
    assert len(call_made["runtimeSessionId"]) >= 33
    stored = raw(table, clip["clipId"])["overlay"]
    assert stored["startedAt"] == iso(NOW)
    assert stored["logos"][0]["key"] == f"logos/{USER}/L0001.png"  # internal, for the agent
    assert "logo" not in stored  # new edits write logos only
    assert stored["status"] == "working"
    assert raw(table, clip["clipId"])["videoKey"] == clip["videoKey"]  # the agent sets the edited file, not the API


def test_each_make_it_is_the_next_rev_and_a_new_session(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    assert put_overlay(call, clip["clipId"])[1]["clip"]["overlay"]["rev"] == 1
    second = put_overlay(call, clip["clipId"], {"text": TEXT})[1]["clip"]["overlay"]
    assert second == {"rev": 2, "status": "working", "text": TEXT}  # the new edit replaces the old one
    assert [c["payload"]["rev"] for c in agentcore.calls] == [1, 2]
    assert len({c["runtimeSessionId"] for c in agentcore.calls}) == 2


def test_make_it_after_a_finished_edit_keeps_showing_the_edited_video(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    seed_logo(store)
    clip = edited_clip(store, s3_client)
    out = put_overlay(call, clip["clipId"])[1]["clip"]
    assert out["overlay"]["rev"] == 2
    stored = raw(table, clip["clipId"])
    assert (stored["videoKey"], stored["editKey"], stored["origVideoKey"]) == (
        clip["editKey"],
        clip["editKey"],
        clip["origVideoKey"],
    )


def test_make_it_needs_cr_active_and_a_clip_in_review(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_logo(store)
    plain = seed_clip(store, s3_client)
    status, body = put_overlay(call, plain["clipId"])
    assert (status, body["error"]["message"]) == (409, "Turn on CR active first.")
    off = seed_clip(store, s3_client, cr={"active": False})
    assert put_overlay(call, off["clipId"])[0] == 409
    for state in ("confirmed", "posted", "declined"):
        done = seed_clip(store, s3_client, status=state, cr={"active": True})
        status, body = put_overlay(call, done["clipId"])
        assert (status, body["error"]["message"]) == (409, "This clip has already been uploaded or thrown away.")
    assert put_overlay(call, "0" * 26)[0] == 404
    assert put_overlay(call, plain["clipId"], sub=OTHER)[0] == 404


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"timing": {"startSec": 0, "endSec": 5}},  # a time alone is not an edit
        {"logo": None, "text": None},
        {"logo": {**LOGO, "x": 1.2}},
        {"logo": {**LOGO, "y": -0.1}},
        {"logo": {**LOGO, "size": 0.05}},
        {"logo": {**LOGO, "size": 0.6}},
        {"logo": {**LOGO, "size": "big"}},
        {"logo": {**LOGO, "x": True}},
        {"logo": {"logoId": "L0001", "x": 0.5, "y": 0.5}},
        {"logo": {**LOGO, "extra": 1}},
        {"logo": "L0001"},
        {"text": {**TEXT, "text": ""}},
        {"text": {**TEXT, "text": "   \n "}},
        {"text": {**TEXT, "text": "x" * 81}},
        {"text": {**TEXT, "size": "xl"}},
        {"text": {**TEXT, "x": "left"}},
        {"text": {"text": "hi", "x": 0.5, "y": 0.5}},
        {"logo": LOGO, "timing": {"startSec": 5, "endSec": 5}},
        {"logo": LOGO, "timing": {"startSec": -1, "endSec": 5}},
        {"logo": LOGO, "timing": {"startSec": 0, "endSec": 40}},  # the clip is 31.5 s long
        {"logo": LOGO, "timing": {"startSec": 9, "endSec": 3}},
        {"logo": LOGO, "timing": {"startSec": 1}},
        {"logo": LOGO, "unknown": 1},
    ],
)
def test_a_bad_edit_is_a_400_and_writes_nothing(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore, body: dict[str, Any]
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    status, out = put_overlay(call, clip["clipId"], body)
    assert (status, out["error"]["code"]) == (400, "bad_request")
    assert "overlay" not in raw(table, clip["clipId"])
    assert agentcore.calls == []


def test_the_text_is_one_clean_line_and_the_whole_clip_is_the_default(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    clip = active_clip(store, s3_client)
    messy = {"text": "  Win\n$50  with\t#brand  ", "x": 0.5, "y": 0.5, "size": "l"}
    shown = put_overlay(call, clip["clipId"], {"text": messy})[1]["clip"]["overlay"]
    assert shown["text"]["text"] == "Win $50 with #brand"
    assert "timing" not in shown
    assert "logo" not in shown
    assert "logos" not in shown
    exact = {"text": {**messy, "text": "x" * 80}}
    assert put_overlay(call, clip["clipId"], exact)[0] == 200


def test_the_logo_must_be_a_ready_logo_of_the_owner(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = active_clip(store, s3_client)
    seed_logo(store, "LTHEIRS", user=OTHER)
    seed_logo(store, "LWAIT", status="uploading")
    for logo_id in ("LTHEIRS", "LWAIT", "LNONE", "bad id"):
        status, body = put_overlay(call, clip["clipId"], {"logo": {**LOGO, "logoId": logo_id}})
        assert (status, body["error"]["message"]) == (404, "We could not find that logo.")


def test_an_agent_that_cannot_be_reached_leaves_a_failed_edit_with_one_sentence(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    agentcore.fail = True
    status, body = put_overlay(call, clip["clipId"])
    assert status == 200
    assert body["clip"]["overlay"]["status"] == "failed"
    assert body["clip"]["overlay"]["error"] == "Clip Factory couldn't start the edit. Tap Make it to try again."
    assert body["clip"]["overlay"]["rev"] == 1
    assert raw(table, clip["clipId"])["overlay"]["status"] == "failed"
    # It is not "working": the owner can Upload, and Make it again works.
    agentcore.fail = False
    again = put_overlay(call, clip["clipId"])[1]["clip"]["overlay"]
    assert (again["rev"], again["status"], "error" not in again) == (2, "working", True)


def test_an_agent_that_says_no_is_a_failed_edit_too(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    agentcore.reply = {"accepted": False}
    assert put_overlay(call, clip["clipId"])[1]["clip"]["overlay"]["status"] == "failed"


# --- the timeout (C5) --------------------------------------------------------------------------------------------


def test_an_edit_that_never_answers_reads_as_failed_after_five_minutes(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    put_overlay(call, clip["clipId"])
    path = f"/v1/clips/{clip['clipId']}"
    clock.now = NOW + timedelta(minutes=4, seconds=59)
    assert call("GET", path)[1]["clip"]["overlay"]["status"] == "working"
    clock.now = NOW + timedelta(minutes=5, seconds=1)
    shown = call("GET", path)[1]["clip"]["overlay"]
    assert shown["status"] == "failed"
    assert shown["error"] == "The edit took too long. Tap Make it to try again."
    assert "startedAt" not in shown
    assert call("GET", "/v1/clips")[1]["clips"][0]["overlay"]["status"] == "failed"
    assert raw(table, clip["clipId"])["overlay"]["status"] == "working"  # reported, not rewritten
    # Make it again is allowed, and starts the next rev.
    again = put_overlay(call, clip["clipId"])[1]["clip"]["overlay"]
    assert (again["rev"], again["status"]) == (2, "working")


# --- Reset (C5) --------------------------------------------------------------------------------------------------


def test_reset_puts_the_original_back_and_keeps_the_switch(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = edited_clip(store, s3_client)
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")
    assert status == 200
    assert body["clip"]["cr"] == {"active": True, "campaignId": CAMPAIGN}
    assert "overlay" not in body["clip"]
    stored = raw(table, clip["clipId"])
    assert stored["videoKey"] == clip["origVideoKey"]
    assert not {"overlay", "editKey", "origVideoKey"} & set(stored)
    assert clip["editKey"] not in s3_client.objects
    assert s3_client.objects[clip["origVideoKey"]] == b"original"
    assert body["clip"]["videoUrl"].endswith(f"{clip['origVideoKey']}?op=get_object&X-Amz-Signature=fake")
    again = call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")  # idempotent
    assert (again[0], again[1]["clip"]["clipId"]) == (200, clip["clipId"])
    assert raw(table, clip["clipId"])["videoKey"] == clip["origVideoKey"]


def test_reset_of_a_clip_that_was_never_edited_changes_nothing(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = seed_clip(store, s3_client)
    before = raw(table, clip["clipId"])
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")[0] == 200
    assert raw(table, clip["clipId"]) == before
    posted = seed_clip(store, s3_client, status="posted")  # nothing to put back: not an error
    assert call("DELETE", f"/v1/clips/{posted['clipId']}/overlay")[0] == 200
    assert call("DELETE", f"/v1/clips/{'0' * 26}/overlay")[0] == 404
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay", sub=OTHER)[0] == 404


def test_reset_of_an_edited_clip_that_was_uploaded_is_refused(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = edited_clip(store, s3_client, status="confirmed")
    status, body = call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")
    assert (status, body["error"]["message"]) == (409, "This clip has already been uploaded or thrown away.")
    assert raw(table, clip["clipId"])["videoKey"] == clip["editKey"]


def test_reset_while_the_first_edit_is_still_being_made_stops_it(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    put_overlay(call, clip["clipId"])
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")[0] == 200
    stored = raw(table, clip["clipId"])
    assert "overlay" not in stored
    assert stored["videoKey"] == clip["videoKey"]


def test_an_edit_after_a_reset_never_reuses_a_rev_a_stale_render_could_still_hold(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    """Make it (rev 1), Reset, Make it: the new edit is rev 2, so the first render, still running, can never write."""
    seed_logo(store)
    clip = active_clip(store, s3_client)
    assert put_overlay(call, clip["clipId"])[1]["clip"]["overlay"]["rev"] == 1
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")[0] == 200
    again = put_overlay(call, clip["clipId"])
    assert again[1]["clip"]["overlay"]["rev"] == 2
    assert "overlayRev" not in again[1]["clip"]  # internal
    assert [c["payload"]["rev"] for c in agentcore.calls] == [1, 2]
    assert raw(table, clip["clipId"])["overlayRev"] == 2


def test_a_render_that_finishes_while_the_owner_resets_never_leaves_a_dangling_video(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, monkeypatch: pytest.MonkeyPatch, app: App
) -> None:
    """The agent's conditional write lands between Reset's read and its write: the write fails (the overlay is no longer
    the one read), Reset reads again and puts the original back from the edited state."""
    seed_logo(store)
    clip = active_clip(store, s3_client)
    put_overlay(call, clip["clipId"])
    key = clip["videoKey"].replace("clip.mp4", "edit-1.mp4")
    s3_client.objects[key] = b"edited"
    real = app.store.update
    landed: list[bool] = []

    def agent_finishes_first(*args: Any, **kwargs: Any) -> Any:
        if not landed:
            landed.append(True)
            current = raw(table, clip["clipId"])
            table.items[(current["pk"], current["sk"])] = {
                **current,
                "origVideoKey": clip["videoKey"],
                "editKey": key,
                "videoKey": key,
                "overlay": {**current["overlay"], "status": "ready"},
            }
        return real(*args, **kwargs)

    monkeypatch.setattr(app.store, "update", agent_finishes_first)
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")[0] == 200
    stored = raw(table, clip["clipId"])
    assert stored["videoKey"] == clip["videoKey"]
    assert not {"overlay", "editKey", "origVideoKey"} & set(stored)
    assert key not in s3_client.objects
    assert landed == [True]


# --- Upload and Throw away (C5) ----------------------------------------------------------------------------------


def test_upload_waits_while_the_edit_is_being_made(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    seed_logo(store)
    clip = active_clip(store, s3_client)
    put_overlay(call, clip["clipId"])
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube"]})
    assert (status, body["error"]["message"]) == (409, STILL_MAKING)
    assert (clip_of(store, clip["clipId"])["status"], lambda_client.calls) == ("review", [])
    # Ready (the agent's write): Upload goes, and it posts the edited file.
    edited = s3_client.objects.setdefault("jobs/edited.mp4", b"e")
    assert edited
    table.items[(db.user_pk(USER), db.clip_sk(clip["clipId"]))]["overlay"]["status"] = "ready"
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube"]})
    assert (status, body["clip"]["status"]) == (200, "confirmed")
    assert body["clip"]["overlay"]["status"] == "ready"


def test_upload_goes_once_the_edit_has_timed_out_or_failed(
    call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    seed_logo(store)
    clip = active_clip(store, s3_client)
    put_overlay(call, clip["clipId"])
    clock.now = NOW + timedelta(minutes=6)
    status, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["youtube"]})
    assert (status, body["clip"]["status"]) == (200, "confirmed")


def test_throwing_away_deletes_the_edited_and_the_original_file(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    clip = edited_clip(store, s3_client)
    assert call("POST", f"/v1/clips/{clip['clipId']}/decline")[0] == 200
    assert clip["editKey"] not in s3_client.objects
    assert clip["origVideoKey"] not in s3_client.objects
    stored = raw(table, clip["clipId"])
    assert not {"videoKey", "editKey", "origVideoKey"} & set(stored)


def test_the_keys_never_leave_the_api(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = edited_clip(store, s3_client)
    for shown in (
        call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"],
        call("GET", "/v1/clips")[1]["clips"][0],
        call("PATCH", f"/v1/clips/{clip['clipId']}", {"captions": {"x": "hi"}})[1]["clip"],
    ):
        for hidden in INTERNAL:
            assert hidden not in shown
        assert shown["overlay"]["status"] == "ready"
        assert shown["videoUrl"].endswith("edit-1.mp4?op=get_object&X-Amz-Signature=fake")
        assert "key" not in shown["overlay"]["logo"]


# --- more than one picture (§54 L3, L4) ---------------------------------------------------------------------------


def layer(layer_id: str, logo_id: str = "L0001", **fields: Any) -> dict[str, Any]:
    return {"layerId": layer_id, "logoId": logo_id, "x": 0.2, "y": 0.3, "size": 0.2, **fields}


def test_several_pictures_are_stored_as_layers_with_their_keys_and_shown_without(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    seed_logo(store)
    seed_logo(store, "L0002")
    clip = active_clip(store, s3_client, durationSec=30)
    layers = [
        layer("a"),
        layer("b", "L0002", timing={"startSec": 1, "endSec": 5}),
        layer("c"),  # the same picture again is another layer
    ]
    body = {"logos": layers, "text": TEXT, "timing": {"startSec": 0, "endSec": 3}}
    status, out = put_overlay(call, clip["clipId"], body)
    assert status == 200
    shown = out["clip"]["overlay"]
    assert [x["layerId"] for x in shown["logos"]] == ["a", "b", "c"]
    assert shown["logos"][1]["timing"] == {"startSec": 1.0, "endSec": 5.0}
    assert "timing" not in shown["logos"][0]
    assert all("key" not in x for x in shown["logos"])
    assert shown["timing"] == {"startSec": 0.0, "endSec": 3.0}  # the text's time
    assert "logo" not in shown
    stored = raw(table, clip["clipId"])["overlay"]
    assert [x["key"] for x in stored["logos"]] == [f"logos/{USER}/{n}.png" for n in ("L0001", "L0002", "L0001")]
    assert "logo" not in stored
    assert len(agentcore.calls) == 1
    again = call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]["overlay"]
    assert all("key" not in x for x in again["logos"])


def test_pictures_alone_are_enough_and_an_empty_list_is_nothing(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    assert put_overlay(call, clip["clipId"], {"logos": [layer("a")]})[0] == 200
    status, body = put_overlay(call, clip["clipId"], {"logos": []})
    assert (status, body["error"]["message"]) == (400, "Add a logo or some words first.")
    assert put_overlay(call, clip["clipId"], {"logos": [], "text": TEXT})[0] == 200


def test_four_pictures_are_the_most(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    four = [layer(n) for n in "abcd"]
    assert put_overlay(call, clip["clipId"], {"logos": four})[0] == 200
    status, body = put_overlay(call, clip["clipId"], {"logos": [*four, layer("e")]})
    assert (status, body["error"]["message"]) == (400, "Up to 4 pictures.")


@pytest.mark.parametrize(
    "logos",
    [
        "L0001",
        [layer("a"), layer("a")],
        [layer("")],
        [layer("x" * 25)],
        [layer("a b")],
        [layer(1)],
        [{k: v for k, v in layer("a").items() if k != "layerId"}],
        ["L0001"],
        [layer("a", size=0.07)],
        [layer("a", size=0.51)],
        [layer("a", x=1.2)],
        [layer("a", y=-0.1)],
        [layer("a", timing={"startSec": 5, "endSec": 5})],
        [layer("a", timing={"startSec": 1})],
        [layer("a", timing={"startSec": 0, "endSec": 99})],
        [layer("a", extra=1)],
    ],
)
def test_a_bad_layer_is_a_400_and_writes_nothing(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, agentcore: FakeAgentCore, logos: Any
) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client, durationSec=30)
    status, out = put_overlay(call, clip["clipId"], {"logos": logos})
    assert (status, out["error"]["code"]) == (400, "bad_request")
    assert "overlay" not in raw(table, clip["clipId"])
    assert agentcore.calls == []


def test_logo_and_logos_together_are_refused(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_logo(store)
    clip = active_clip(store, s3_client)
    assert put_overlay(call, clip["clipId"], {"logo": LOGO, "logos": [layer("a")]})[0] == 400


def test_every_layer_must_be_a_ready_logo_of_the_owner(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    seed_logo(store)
    seed_logo(store, "LTHEIRS", user=OTHER)
    seed_logo(store, "LWAIT", status="uploading")
    clip = active_clip(store, s3_client)
    for logo_id in ("LTHEIRS", "LWAIT", "LNONE"):
        status, body = put_overlay(call, clip["clipId"], {"logos": [layer("a"), layer("b", logo_id)]})
        assert (status, body["error"]["message"]) == (404, "We could not find that logo.")
    assert "overlay" not in raw(table, clip["clipId"])


def test_layers_need_cr_active_and_a_clip_in_review(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_logo(store)
    plain = seed_clip(store, s3_client)
    assert put_overlay(call, plain["clipId"], {"logos": [layer("a")]})[0] == 409
    posted = active_clip(store, s3_client, status="posted")
    assert put_overlay(call, posted["clipId"], {"logos": [layer("a")]})[0] == 409


def test_a_clip_edited_with_one_logo_keeps_working_and_a_new_edit_moves_to_layers(
    call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3
) -> None:
    seed_logo(store)
    clip = edited_clip(store, s3_client)
    shown = call("GET", f"/v1/clips/{clip['clipId']}")[1]["clip"]["overlay"]
    assert shown["logo"] == LOGO  # §53 shape, still readable
    assert "logos" not in shown
    status, _out = put_overlay(call, clip["clipId"], {"logos": [layer("a"), layer("b")]})
    assert status == 200
    stored = raw(table, clip["clipId"])
    assert "logo" not in stored["overlay"]
    assert len(stored["overlay"]["logos"]) == 2
    assert stored["videoKey"] == clip["videoKey"]  # still the edited file until the agent answers
    assert call("DELETE", f"/v1/clips/{clip['clipId']}/overlay")[0] == 200


# --- auto-posting (C5) -------------------------------------------------------------------------------------------


def test_auto_posting_skips_a_clip_whose_edit_is_being_made_and_takes_the_next(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock
) -> None:
    ready(store, "youtube")
    seed_logo(store)
    first = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z", cr={"active": True})
    second = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    put_overlay(call, first["clipId"])
    found = pick.pick(app, USER, clock())
    assert [t.clip["clipId"] for t in found.taken] == [second["clipId"]]
    assert [(w.clip["clipId"], w.reason) for w in found.waiting] == [(first["clipId"], STILL_MAKING)]
    assert found.candidates == 2  # counted like any clip in Review: the run's count and order are untouched
    # Once it is ready (or the 5 minutes ran out) it is first in line again.
    clock.now = NOW + timedelta(minutes=5, seconds=1)
    assert [t.clip["clipId"] for t in pick.pick(app, USER, clock()).taken] == [first["clipId"], second["clipId"]]


def test_a_run_does_not_send_a_clip_that_is_being_edited(
    app: App, call: Call, store: db.Store, table: FakeTable, s3_client: FakeS3, clock: Clock, lambda_client: FakeLambda
) -> None:
    ready(store, "youtube")
    turn_on(store, per_run=2)
    seed_logo(store)
    editing = review_clip(store, s3_client, made="2026-11-15T08:00:00.000Z", cr={"active": True})
    other = review_clip(store, s3_client, made="2026-11-15T09:00:00.000Z")
    clock.now = SLOT - timedelta(minutes=1)  # the edit was asked a minute before the run
    put_overlay(call, editing["clipId"])
    clock.now = SLOT + timedelta(seconds=5)
    outcome = run.run_once(deps(app), USER, "scheduled", SLOT)
    assert outcome.result == "ran"
    item = run_item(store, f"{iso(SLOT)}#scheduled")
    assert item is not None
    assert [c["clipId"] for c in item["clips"]] == [other["clipId"]]
    assert clip_of(store, editing["clipId"])["status"] == "review"
    assert clip_of(store, other["clipId"])["status"] == "confirmed"


def test_a_clip_that_turns_to_working_after_the_run_planned_is_skipped_with_the_sentence(
    app: App, call: Call, store: db.Store, s3_client: FakeS3, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clipfactory_api import uploads

    ready(store, "youtube")
    turn_on(store)
    seed_logo(store)
    clip = review_clip(store, s3_client, cr={"active": True})
    clock.now = SLOT + timedelta(seconds=5)
    real = uploads.upload_review_clip
    tapped: list[bool] = []

    def make_it_first(*args: Any, **kwargs: Any) -> Any:
        if not tapped:
            tapped.append(True)
            assert put_overlay(call, clip["clipId"])[0] == 200  # between the plan and the send
            args = (args[0], args[1], clip_of(store, clip["clipId"]), *args[3:])
        return real(*args, **kwargs)

    monkeypatch.setattr(uploads, "upload_review_clip", make_it_first)
    assert run.run_once(deps(app), USER, "scheduled", SLOT).result == "ran"
    item = run_item(store, f"{iso(SLOT)}#scheduled")
    assert item is not None
    assert [(c["outcome"], c["reason"]) for c in item["clips"]] == [("skipped", STILL_MAKING)]
    assert clip_of(store, clip["clipId"])["status"] == "review"
