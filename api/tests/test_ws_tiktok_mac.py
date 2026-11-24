"""My Mac posts TikTok for Clips Funded (docs/CONTRACTS.md §47.10, ADR-89): publish and retry write a Mac job, the
helper's queue, claim, steps, stop and done, the owner's Try again and It's on TikTok, the switch and the dashboard.
Fakes only: nothing calls TikTok, and Clip Factory's ``USER#{u}`` items are never written."""

from __future__ import annotations

import json
import re
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db, tiktok_mac, tiktok_self
from clipfactory_api.app import App
from clipfactory_api.workspaces import mac, publish
from clipfactory_api.workspaces import types as ws
from conftest import NOW, USER, Call, Clock
from fakes import FakeSecretsManager, FakeTable

WSP = "/v1/workspaces/stories"
PUBLISH = f"{WSP}/stories/{sup.STORY_ID}/publish"
STATUS = f"{WSP}/tiktok/mac"
PING = f"{WSP}/tiktok/mac/ping"
LOGIN = f"{WSP}/tiktok/mac/login"
REQUEST = f"{WSP}/tiktok/mac/request"
JOB_ID = "01JZ0000000000000000000PJ1"
JOB_SK = f"PUBJOB#{JOB_ID}"
STORY_SK = f"STORY#{sup.STORY_ID}"
REG = (f"USER#{USER}#WSREG", "WS#stories")
DEVICE = "mac-1"
LINK = "https://www.tiktok.com/@lamostories/video/7300000000000000001"
TIKTOK_TARGET = {
    "platform": "tiktok",
    "socialAccountId": "stories.tiktok",
    "options": {  # the sheet's full My settings options (public)
        "privacyLevel": "PUBLIC_TO_EVERYONE",
        "disableComment": False,
        "disableDuet": False,
        "disableStitch": False,
        "brandContent": False,
        "brandOrganic": False,
    },
}
YOUTUBE_TARGET = {"platform": "youtube", "socialAccountId": "stories.youtube"}
SRC = Path(__file__).resolve().parents[1] / "src" / "clipfactory_api"


def job_path(action: str, job_id: str = JOB_ID) -> str:
    return f"{WSP}/publishing/{job_id}/mac/{action}"


def switch(store: db.Store, on: bool) -> None:
    item = store.get(*REG)
    assert item is not None
    store.update(*REG, {"configuration": {**item["configuration"], "tiktokMac": {"on": on}}})


def mac_job(store: db.Store, job_id: str = JOB_ID, **fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "publishingStatus": "mac",
        "handle": "@lamostories",
        "postOptions": dict(publish.MAC_OPTIONS),
        "aiLabel": True,
        "macState": "waiting",
        "macSince": "2026-11-15T11:59:00.000Z",
        "macSource": "upload",
        "macAttempt": 0,
    }
    return sup.pubjob(store, "tiktok", job_id, **{**base, **fields})


def stored(table: FakeTable, sk: str = JOB_SK) -> dict[str, Any]:
    found = table.raw(sup.PK, sk)
    assert found is not None
    return found


def snapshot(table: FakeTable) -> str:
    return json.dumps(table.all(), sort_keys=True, default=str)


def clips_untouched(table: FakeTable) -> None:
    """Nothing here ever writes Clip Factory's partition (its helper item above all)."""
    assert table.raw(f"USER#{USER}", "MACHELPER") is None
    writes = [kw for name, kw in table.calls if name in {"put_item", "update_item", "delete_item"}]
    for name, kw in table.calls:
        if name == "transact_write_items":
            writes += [request for action in kw["TransactItems"] for request in action.values()]
    assert writes
    for kw in writes:
        key = kw.get("Key") or kw.get("Item") or {}
        assert str(key.get("pk")).startswith(f"USER#{USER}#WS"), key


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


@pytest.fixture
def starter(app: App, store: db.Store, secrets_client: FakeSecretsManager) -> sup.FakeStarter:
    found = sup.FakeStarter()
    sup.install(app, secrets_client, found)
    sup.ready(store, secrets_client, "youtube", "tiktok")
    switch(store, True)
    return found


def claim(call: Call, job_id: str = JOB_ID, *, device: str = DEVICE, version: str = "1.2.0") -> tuple[int, Any]:
    return call("POST", job_path("claim", job_id), {"device": device, "version": version})


# --- the shared constants ---------------------------------------------------------------------------------------


def test_the_version_gate_and_the_timings_are_pinned() -> None:
    text = (SRC / "workspaces" / "mac.py").read_text()
    found = re.findall(r'^MAC_WS_FROM = "(\d+\.\d+\.\d+)"$', text, re.MULTILINE)
    assert found == ["1.2.0"] == [mac.MAC_WS_FROM]
    assert mac.STALE_CLAIM == tiktok_mac.STALE_CLAIM
    assert (mac.MAC_BEAT_STALE, mac.MAC_CLAIM_MAX, mac.MAC_FIND_WINDOW) == (
        tiktok_self.MAC_BEAT_STALE,
        tiktok_self.MAC_CLAIM_MAX,
        tiktok_self.MAC_FIND_WINDOW,
    )
    assert all(mac.new_enough(v) for v in ("1.2.0", "1.10.0", "2.0.0"))
    assert not any(mac.new_enough(v) for v in ("1.1.0", "1.1.9", "", None, "dev", "1.2.x"))
    assert publish.MAC_OPTIONS == {
        "privacyLevel": "PUBLIC_TO_EVERYONE",
        "disableComment": False,
        "disableDuet": False,
        "disableStitch": False,
        "brandContent": False,
        "brandOrganic": False,
    }
    assert "mac" in publish.STATUSES
    assert "mac" not in (*publish.IN_FLIGHT, *publish.RETRYABLE)
    assert "campaign" in publish.NEVER


def test_the_mac_modules_never_import_clip_factorys_mac_module_or_routes() -> None:
    for name in ("mac.py", "routes/mac.py", "story_posted.py"):
        text = (SRC / "workspaces" / name).read_text()
        assert "tiktok_mac" not in re.sub(r"#.*|\"\"\"[\s\S]*?\"\"\"", "", text), name
        assert not re.search(r"^from \.\.\.?routes|^import clipfactory_api\.routes", text, re.MULTILINE), name


def test_the_helper_item_key_is_a_workspace_key() -> None:
    assert ws.MACHELPER_SK == "MACHELPER"
    assert ws.MACHELPER_SK in ws.ITEM_PREFIXES
    assert ws.TYPE_MACHELPER == "ws_machelper"


# --- the switch -------------------------------------------------------------------------------------------------


def test_the_switch_is_off_by_default_and_saved_with_the_workspace(call: Call, store: db.Store) -> None:
    status, body = call("GET", WSP)
    assert status == 200
    assert body["workspace"]["configuration"]["tiktokMac"] == {"on": False}
    version = body["workspace"]["version"]
    status, body = call("PATCH", WSP, {"version": version, "configuration": {"tiktokMac": {"on": True}}})
    assert status == 200, body
    assert body["workspace"]["configuration"]["tiktokMac"] == {"on": True}
    stored_item = store.get(*REG)
    assert stored_item is not None
    assert stored_item["configuration"]["tiktokMac"] == {"on": True}
    version = body["workspace"]["version"]
    status, body = call("PATCH", WSP, {"version": version, "configuration": {"tiktokMac": {"on": True, "x": 1}}})
    assert status == 400
    assert body["error"]["message"] == "tiktokMac has a setting Clips Funded does not know."
    assert call("PATCH", WSP, {"version": version, "configuration": {"tiktokMac": {"on": "yes"}}})[0] == 400
    assert call("PATCH", WSP, {"version": version, "configuration": {"tiktokMac": {}}})[0] == 200  # keeps it on


def test_a_stored_config_without_the_switch_reads_off(call: Call, store: db.Store) -> None:
    call("GET", WSP)
    item = store.get(*REG)
    assert item is not None
    config = {k: v for k, v in item["configuration"].items() if k != "tiktokMac"}
    store.update(*REG, {"configuration": config})
    assert call("GET", WSP)[1]["workspace"]["configuration"]["tiktokMac"] == {"on": False}


# --- publish and the API retry ------------------------------------------------------------------------------------


def test_publish_with_the_switch_on_writes_a_mac_job_and_starts_no_flow(
    call: Call, table: FakeTable, starter: sup.FakeStarter
) -> None:
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 202, body
    (job,) = body["publishingJobs"]
    assert job["publishingStatus"] == "mac"
    assert job["mac"] == {"state": "waiting", "since": "2026-11-15T12:00:00.000Z"}
    assert (job["handle"], job["externalAccountId"]) == ("@lamostories", sup.IDENTITY["tiktok"])
    assert not {"postOptions", "aiLabel", "macDevice", "macAttempt", "macSource", "flowRun"} & set(job)
    item = stored(table, f"PUBJOB#{job['publishingJobId']}")
    assert item["postOptions"] == publish.MAC_OPTIONS
    assert (item["aiLabel"], item["macState"], item["macSource"], item["macAttempt"]) == (True, "waiting", "upload", 0)
    assert starter.started == []  # the Mac posts it, never the story flow
    assert call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})[1]["error"]["message"] == (
        "This story is already being posted to TikTok."
    )


def test_publish_forces_the_public_options_whatever_the_sheet_sent(
    call: Call, table: FakeTable, starter: sup.FakeStarter
) -> None:
    private = {
        **TIKTOK_TARGET,
        "options": {**TIKTOK_TARGET["options"], "privacyLevel": "SELF_ONLY", "disableDuet": True},
    }
    status, body = call("POST", PUBLISH, {"targets": [private]})
    assert status == 202, body
    assert stored(table, f"PUBJOB#{body['publishingJobs'][0]['publishingJobId']}")["postOptions"] == publish.MAC_OPTIONS
    # the sheet's options are still checked: every pick is needed, campaign is refused
    assert call("POST", PUBLISH, {"targets": [{**TIKTOK_TARGET, "options": {"privacyLevel": "X"}}]})[0] == 400


def test_mixed_targets_start_the_flow_with_the_others_only(
    call: Call, table: FakeTable, starter: sup.FakeStarter
) -> None:
    status, body = call("POST", PUBLISH, {"targets": [YOUTUBE_TARGET, TIKTOK_TARGET]})
    assert status == 202, body
    youtube, tiktok = body["publishingJobs"]
    assert (youtube["publishingStatus"], tiktok["publishingStatus"]) == ("queued", "mac")
    assert [s["publishingJobIds"] for s in starter.started] == [[youtube["publishingJobId"]]]


def test_a_mac_only_publish_needs_no_story_flow(app: App, call: Call, store: db.Store, secrets_client: Any) -> None:
    sup.install(app, secrets_client, None)
    sup.ready(store, secrets_client, "youtube", "tiktok")
    switch(store, True)
    assert call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})[0] == 202
    assert call("POST", PUBLISH, {"targets": [YOUTUBE_TARGET]})[0] == 503


@pytest.mark.parametrize("handle", [None, "Lamo Stories", "@x"])
def test_no_handle_means_no_mac_job(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, handle: str | None
) -> None:
    store.update(
        sup.PK,
        "SOCIAL#tiktok",
        {"handle": handle} if handle else {"updatedAt": "x"},
        remove=[] if handle else ["handle"],
    )
    before = snapshot(table)
    status, body = call("POST", PUBLISH, {"targets": [YOUTUBE_TARGET, TIKTOK_TARGET]})
    assert status == 409
    assert body["error"]["message"] == "Connect TikTok again in Social accounts, so your Mac knows the account."
    assert snapshot(table) == before
    assert starter.started == []


def test_a_tiktok_post_made_only_me_is_handed_over_in_place(
    call: Call, table: FakeTable, store: db.Store, starter: sup.FakeStarter
) -> None:
    private = sup.pubjob(
        store,
        "tiktok",
        publishingStatus="posted",
        postOptions={**TIKTOK_TARGET["options"], "privacyLevel": "SELF_ONLY"},
        url="https://www.tiktok.com/@lamostories",
        privacy="private",
        postedAt="2026-11-15T11:00:00.000Z",
    )
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 202, body
    (job,) = body["publishingJobs"]
    assert job["publishingJobId"] == private["publishingJobId"]  # one TikTok row per story
    assert job["publishingStatus"] == "mac"
    assert "url" not in job
    item = stored(table)
    assert item["beforeMac"]["publishingStatus"] == "posted"
    assert item["beforeMac"]["url"] == "https://www.tiktok.com/@lamostories"
    assert (item["postOptions"], item["aiLabel"], item["handle"]) == (publish.MAC_OPTIONS, True, "@lamostories")
    assert not {"url", "postedAt", "privacy"} & set(item)
    assert len([i for i in table.all() if str(i["sk"]).startswith("PUBJOB#")]) == 1
    assert starter.started == []


def test_only_me_is_shown_only_on_a_tiktok_post_the_api_made_only_me() -> None:
    """``PublishingJob.onlyMe``: the row's Post with my Mac (§47.10.6 row 13) is offered only where the hand-over is."""
    only_me = {"platform": "tiktok", "publishingStatus": "posted", "postOptions": {"privacyLevel": "SELF_ONLY"}}
    assert publish.public_job(only_me)["onlyMe"] is True
    assert "onlyMe" not in publish.public_job({**only_me, "postOptions": dict(publish.MAC_OPTIONS)})
    assert "onlyMe" not in publish.public_job({**only_me, "publishingStatus": "mac"})
    assert "onlyMe" not in publish.public_job({**only_me, "platform": "youtube"})


def test_a_public_tiktok_post_is_never_handed_over(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    sup.pubjob(store, "tiktok", publishingStatus="posted", postOptions=TIKTOK_TARGET["options"])
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 409
    assert body["error"]["message"] == "This story is already on TikTok."


def test_the_api_retry_makes_a_failed_tiktok_job_a_mac_job_in_place(
    call: Call, table: FakeTable, store: db.Store, starter: sup.FakeStarter
) -> None:
    sup.pubjob(store, "tiktok", publishingStatus="failed", error="TikTok did not answer.",
               postOptions={**TIKTOK_TARGET["options"], "privacyLevel": "SELF_ONLY"}, handle="@lamostories")  # fmt: skip
    status, body = call("POST", f"{WSP}/publishing/{JOB_ID}/retry", {})
    assert status == 202, body
    assert body["publishingJob"]["publishingStatus"] == "mac"
    item = stored(table)
    assert (item["macState"], item["postOptions"], item["aiLabel"], item["flowRun"]) == (
        "waiting",
        publish.MAC_OPTIONS,
        True,
        1,
    )
    assert "error" not in item
    assert starter.started == []
    status, body = call("POST", f"{WSP}/publishing/{JOB_ID}/retry", {})
    assert status == 409
    assert body["error"]["message"] == "Your Mac posts this one. Tap Try again on its row."


def test_a_mac_job_counts_as_being_posted_for_the_api_too(
    call: Call, store: db.Store, starter: sup.FakeStarter
) -> None:
    mac_job(store, "01JZ0000000000000000000PJ2")
    sup.pubjob(store, "tiktok", publishingStatus="failed", error="x", postOptions=TIKTOK_TARGET["options"])
    switch(store, False)
    status, body = call("POST", f"{WSP}/publishing/{JOB_ID}/retry", {})
    assert status == 409
    assert body["error"]["message"] == "This story is already being posted to TikTok."
    assert call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})[0] == 409
    assert starter.started == []


def test_the_story_flow_never_sends_a_mac_job(
    store: db.Store, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    from clipfactory_api.flows.story_flow import run_story_flow
    from fakes import FakeDurableContext, FakeHttp

    sup.ready(store, secrets_client, "tiktok")
    mac_job(store)
    http = FakeHttp()
    out = run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "not_posted"
    assert http.calls == []
    item = store.get(sup.PK, JOB_SK)
    assert item is not None
    assert (item["publishingStatus"], item["macState"]) == ("mac", "waiting")


# --- the queue and the helper item ------------------------------------------------------------------------------


def test_the_queue_is_empty_while_off_and_for_an_old_helper(
    call: Call, store: db.Store, starter: sup.FakeStarter
) -> None:
    mac_job(store)
    mac_job(store, "01JZ0000000000000000000PJ0", macSince="2026-11-15T11:00:00.000Z")
    status, body = call("GET", STATUS, query={"version": "1.2.0"})
    assert status == 200
    assert [j["publishingJobId"] for j in body["queue"]] == ["01JZ0000000000000000000PJ0", JOB_ID]
    first = body["queue"][1]
    assert first == {
        "workspaceId": "stories",
        "publishingJobId": JOB_ID,
        "storyId": sup.STORY_ID,
        "hook": "Ice is slippery",
        "caption": "ice tips",
        "fileName": "clips-funded-ice-is-slippery.mp4",
        "account": {"handle": "@lamostories", "openId": sup.IDENTITY["tiktok"]},
        "aiLabel": True,
        "privacy": "PUBLIC_TO_EVERYONE",
        "comment": True,
        "duet": True,
        "stitch": True,
        "source": "upload",
        "since": "2026-11-15T11:59:00.000Z",
        "state": "waiting",
        "attempt": 0,
    }
    assert body["on"] is True
    assert body["helper"] is None
    assert body["account"] == {"handle": "@lamostories", "accountName": "Lamo Stories tiktok", "status": "connected"}
    assert call("GET", STATUS, query={"version": "1.1.0"})[1]["queue"] == []
    assert call("GET", STATUS, query={"version": "dev"})[1]["queue"] == []
    assert len(call("GET", STATUS)[1]["queue"]) == 2  # the web asks without a version
    switch(store, False)
    status, body = call("GET", STATUS, query={"version": "1.2.0"})
    assert (body["on"], body["queue"]) == (False, [])


def test_the_caption_falls_back_to_the_title(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    store.update(sup.PK, STORY_SK, {"postCaptions": {"tiktok": ""}})
    mac_job(store)
    assert call("GET", STATUS)[1]["queue"][0]["caption"] == "Ice is slippery"


def test_ping_validates_and_stores_the_workspace_helper_item(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    good = {"state": "ok", "version": "1.2.0", "device": DEVICE, "setUp": True, "handle": "@lamostories"}
    status, body = call("POST", PING, good)
    assert (status, body) == (200, {"on": True})
    item = stored(table, "MACHELPER")
    assert (item["type"], item["userId"], item["workspaceId"]) == ("ws_machelper", USER, "stories")
    assert (item["state"], item["version"], item["setUp"], item["handle"]) == ("ok", "1.2.0", True, "@lamostories")
    helper = call("GET", STATUS)[1]["helper"]
    assert helper == {
        "seenAt": "2026-11-15T12:00:00.000Z",
        "state": "ok",
        "setUp": True,
        "version": "1.2.0",
        "handle": "@lamostories",
    }
    assert "device" not in helper
    for bad in (
        {**good, "state": "sleeping"},
        {**good, "setUp": "yes"},
        {k: v for k, v in good.items() if k != "setUp"},
        {k: v for k, v in good.items() if k != "device"},
        {k: v for k, v in good.items() if k != "version"},
        {**good, "version": "1" * 21},
        {**good, "handle": "lamostories"},
        {**good, "handle": "@bad name"},
        {**good, "loginDone": "x" * 41},
        {**good, "reason": 3},
        {**good, "login": "saved"},  # Clip Factory's key: not this route's
    ):
        assert call("POST", PING, bad)[0] == 400, bad
    clock.now = NOW + timedelta(minutes=1)
    call("POST", PING, {"state": "paused", "version": "1.2.0", "device": DEVICE, "setUp": False})
    item = stored(table, "MACHELPER")
    assert (item["state"], item["setUp"], item["seenAt"]) == ("paused", False, "2026-11-15T12:01:00.000Z")
    assert "handle" not in item
    clips_untouched(table)


def test_log_in_on_my_mac_needs_a_new_helper_and_its_ping_clears_it(
    call: Call, table: FakeTable, starter: sup.FakeStarter
) -> None:
    status, body = call("POST", LOGIN, {"action": "sign_in"})
    assert status == 409
    assert body["error"]["message"] == "Update the helper on your Mac first."
    ping = {"state": "ok", "version": "1.1.9", "device": DEVICE, "setUp": False}
    call("POST", PING, ping)
    assert call("POST", LOGIN, {"action": "sign_in"})[0] == 409
    call("POST", PING, {**ping, "version": "1.2.0"})
    assert call("POST", LOGIN, {"action": "change"})[0] == 400
    assert call("POST", LOGIN, {"action": "sign_in", "x": 1})[0] == 400
    status, body = call("POST", LOGIN, {"action": "sign_in"})
    assert status == 200, body
    assert body["helper"]["loginRequest"] == {"at": "2026-11-15T12:00:00.000Z"}
    call("POST", PING, {**ping, "version": "1.2.0", "loginDone": "2026-11-15T11:00:00.000Z"})  # an older one
    assert "loginRequestAt" in stored(table, "MACHELPER")
    call("POST", PING, {**ping, "version": "1.2.0", "loginDone": "2026-11-15T12:00:00.000Z", "setUp": True,
                        "handle": "@lamostories"})  # fmt: skip
    item = stored(table, "MACHELPER")
    assert "loginRequestAt" not in item
    assert item["setUp"] is True
    clips_untouched(table)


def test_start_my_mac_again_needs_a_paused_new_helper_and_its_ping_clears_it(
    call: Call, table: FakeTable, starter: sup.FakeStarter
) -> None:
    """§47.10.4: Start my Mac again in Clips Funded (a paused Mac): the helper ends this Mac's pause on its next tick,
    and its ping's ``resumeDone`` clears the request (an older one never does)."""
    status, body = call("POST", REQUEST, {"action": "resume"})  # no Mac ever checked in
    assert (status, body["error"]["message"]) == (409, "Update the helper on your Mac first.")
    ping = {"state": "ok", "version": "1.1.9", "device": DEVICE, "setUp": True}
    call("POST", PING, {**ping, "state": "paused", "reason": "Paused on your Mac."})
    status, body = call("POST", REQUEST, {"action": "resume"})
    assert (status, body["error"]["message"]) == (409, "Update the helper on your Mac first.")
    call("POST", PING, {**ping, "version": "1.2.0"})
    status, body = call("POST", REQUEST, {"action": "resume"})
    assert (status, body["error"]["message"]) == (409, "Your Mac isn't paused.")
    assert "resumeRequestAt" not in stored(table, "MACHELPER")
    call("POST", PING, {**ping, "version": "1.2.0", "state": "paused", "reason": "Paused on your Mac."})
    assert call("POST", REQUEST, {"action": "let_go"})[0] == 400
    assert call("POST", REQUEST, {"action": "resume", "x": 1})[0] == 400
    status, body = call("POST", REQUEST, {"action": "resume"})
    assert status == 200, body
    assert body["helper"]["resumeRequest"] == {"at": "2026-11-15T12:00:00.000Z"}
    assert call("GET", STATUS, query={"version": "1.2.0"})[1]["helper"]["resumeRequest"] == {
        "at": "2026-11-15T12:00:00.000Z"
    }
    call("POST", PING, {**ping, "version": "1.2.0", "resumeDone": "2026-11-15T11:00:00.000Z"})  # an older one
    assert "resumeRequestAt" in stored(table, "MACHELPER")
    assert call("POST", PING, {**ping, "version": "1.2.0", "resumeDone": "x" * 41})[0] == 400
    call("POST", PING, {**ping, "version": "1.2.0", "resumeDone": "2026-11-15T12:00:00.000Z"})
    item = stored(table, "MACHELPER")
    assert "resumeRequestAt" not in item
    assert item["state"] == "ok"
    clips_untouched(table)


# --- the claim ---------------------------------------------------------------------------------------------------


def test_claim_takes_a_waiting_job_once(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    mac_job(store)
    status, body = claim(call)
    assert status == 200, body
    job = body["job"]
    assert (job["state"], job["step"], job["attempt"], job["claimedAt"]) == (
        "working",
        "video",
        1,
        "2026-11-15T12:00:00.000Z",
    )
    item = stored(table)
    assert (item["macDevice"], item["macBeatAt"]) == (DEVICE, "2026-11-15T12:00:00.000Z")
    status, body = claim(call, device="mac-2")
    assert status == 409
    assert body["error"]["message"] == "Another try already has this post."
    clips_untouched(table)


def test_claim_refuses_an_old_helper_and_a_switch_that_is_off(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    mac_job(store)
    before = snapshot(table)
    status, body = claim(call, version="1.1.0")
    assert (status, body["error"]["code"], body["error"]["message"]) == (
        409,
        "mac_old",
        "Update the helper on your Mac.",
    )
    switch(store, False)
    before = snapshot(table)
    status, body = claim(call)
    assert status == 409
    assert body["error"]["message"] == "My Mac posts TikTok is off in Clips Funded."
    assert snapshot(table) == before
    sup.pubjob(store, "youtube", "01JZ0000000000000000000PJ9", publishingStatus="failed")
    switch(store, True)
    status, body = claim(call, "01JZ0000000000000000000PJ9")
    assert (status, body["error"]["message"]) == (409, "Your Mac isn't posting this one.")
    assert claim(call, "01JZ000000000000000000NONE")[0] == 404


def _changed(store: db.Store, secrets: FakeSecretsManager) -> None:
    sup.social(store, secrets, "tiktok", identity="open-new")


def _handle_changed(store: db.Store, _secrets: FakeSecretsManager) -> None:
    store.update(sup.PK, "SOCIAL#tiktok", {"handle": "@someone.else"})


def _no_video(store: db.Store, _secrets: FakeSecretsManager) -> None:
    store.update(sup.PK, STORY_SK, {"updatedAt": "x"}, remove=["videoKey"])


def _no_token(_store: db.Store, secrets: FakeSecretsManager) -> None:
    del secrets.values["cf-prod/workspaces/stories/tiktok/token"]


def _clips_account(store: db.Store, _secrets: FakeSecretsManager) -> None:
    sup.clips_account(store, None, "tiktok", accountId=sup.IDENTITY["tiktok"])  # G8: it is Clip Factory's own


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (_changed, "Clips Funded's TikTok is a different account now. Tap Try again."),
        (_handle_changed, "Clips Funded's TikTok is a different account now. Tap Try again."),
        (_no_video, "The video is gone. Make it again, then tap Try again."),
        (_no_token, "Connect TikTok again in Social accounts. Then tap Try again."),
        (_clips_account, "is Clip Factory's own account"),
    ],
)
def test_claim_stops_a_job_that_may_not_go_to_its_account(
    call: Call,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    starter: sup.FakeStarter,
    change: Any,
    reason: str,
) -> None:
    mac_job(store)
    change(store, secrets_client)
    status, body = claim(call)
    assert status == 409
    assert reason in body["error"]["message"]
    item = stored(table)
    assert item["macState"] == "stopped"
    assert reason in item["macReason"]
    assert "macDevice" not in item
    assert claim(call)[0] == 409  # stopped: only the owner's Try again goes on


def test_claim_never_takes_a_pressed_job_and_takes_a_crashed_claim(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    mac_job(store, macPressedBefore="x", macPressedAt="2026-11-15T11:00:00.000Z")
    assert claim(call)[0] == 409  # waiting but pressed: never claimed again by itself
    long_ago = "2026-11-15T11:44:00.000Z"  # 16 minutes before the clock
    mac_job(store, macState="working", macDevice="mac-old", macBeatAt=long_ago, macClaimedAt=long_ago, macAttempt=1)
    status, body = claim(call)
    assert status == 200, body
    assert body["job"]["attempt"] == 2
    assert stored(table)["macDevice"] == DEVICE
    fresh = "2026-11-15T11:50:00.000Z"
    mac_job(store, macState="working", macDevice="mac-old", macBeatAt=fresh, macClaimedAt=fresh, macAttempt=1)
    assert claim(call)[0] == 409  # its helper still beats it


# --- steps, beats and stops ---------------------------------------------------------------------------------------


def _claimed(call: Call, store: db.Store) -> None:
    mac_job(store)
    assert claim(call)[0] == 200


def test_steps_beat_the_job_and_the_first_press_is_kept(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _claimed(call, store)
    clock.now = NOW + timedelta(minutes=1)
    status, body = call("POST", job_path("step"), {"device": DEVICE, "step": "uploading", "attempt": 1})
    assert status == 200, body
    assert (body["job"]["step"], body["job"]["beatAt"]) == ("uploading", "2026-11-15T12:01:00.000Z")
    clock.now = NOW + timedelta(minutes=2)
    call("POST", job_path("step"), {"device": DEVICE, "step": "uploading"})  # the same step again: a beat
    assert stored(table)["macBeatAt"] == "2026-11-15T12:02:00.000Z"
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    clock.now = NOW + timedelta(minutes=3)
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    assert stored(table)["macPressedAt"] == "2026-11-15T12:02:00.000Z"
    assert call("POST", job_path("step"), {"device": "mac-2", "step": "finding"})[0] == 409
    assert call("POST", job_path("step"), {"device": DEVICE, "step": "finding", "attempt": 2})[0] == 409
    assert call("POST", job_path("step"), {"device": DEVICE, "step": "dancing"})[0] == 400
    switch(store, False)
    assert call("POST", job_path("step"), {"device": DEVICE, "step": "finding"})[0] == 200  # after the press
    clips_untouched(table)


def test_turning_the_switch_off_stops_the_mac_before_post(
    call: Call, store: db.Store, starter: sup.FakeStarter
) -> None:
    _claimed(call, store)
    switch(store, False)
    status, body = call("POST", job_path("step"), {"device": DEVICE, "step": "uploading"})
    assert (status, body["error"]["message"]) == (409, "My Mac posts TikTok is off in Clips Funded.")


def test_a_stop_that_needs_the_owner_writes_only_the_workspace_helper_item(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _claimed(call, store)
    reason = "Your Mac is logged in to TikTok as @lamo.clips, not @lamostories. Nothing was posted."
    status, body = call("POST", job_path("stopped"), {"device": DEVICE, "reason": reason, "needsYou": True})
    assert status == 200, body
    assert body["job"]["state"] == "stopped"
    item = stored(table)
    assert (item["macState"], item["macReason"]) == ("stopped", reason)
    helper = stored(table, "MACHELPER")
    assert (helper["state"], helper["reason"], helper["needsYouJobId"], helper["needsYouStoryId"]) == (
        "needs_you",
        reason,
        JOB_ID,
        sup.STORY_ID,
    )
    assert (helper["type"], helper["userId"], helper["workspaceId"]) == ("ws_machelper", USER, "stories")
    clips_untouched(table)
    dashboard = call("GET", f"{WSP}/dashboard")[1]["dashboard"]
    (shown,) = [n for n in dashboard["needsYou"] if n["publishingJobId"] == JOB_ID]
    assert (shown["sentence"], shown["publishingStatus"], shown["href"]) == (
        reason,
        "mac",
        f"/stories/review/{sup.STORY_ID}",
    )
    assert shown["mac"]["state"] == "stopped"
    # a ping in another state lets go of the job it needed him for
    call("POST", PING, {"state": "ok", "version": "1.2.0", "device": DEVICE, "setUp": True})
    assert "needsYouJobId" not in stored(table, "MACHELPER")


def test_after_a_press_the_stop_reason_is_always_pressed(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _claimed(call, store)
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "TikTok was slow."})
    assert stored(table)["macReason"] == mac.PRESSED
    assert "MACHELPER" not in {str(i["sk"]) for i in table.all()}


# --- done -------------------------------------------------------------------------------------------------------


def test_done_with_a_link_on_another_account_writes_nothing(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _claimed(call, store)
    before = snapshot(table)
    other = "https://www.tiktok.com/@lamo.clips/video/7300000000000000001"
    status, body = call("POST", job_path("done"), {"device": DEVICE, "link": other})
    assert (status, body["error"]["code"], body["error"]["message"]) == (
        409,
        "wrong_account",
        "That post is on another TikTok account.",
    )
    assert snapshot(table) == before
    assert call("POST", job_path("done"), {"device": DEVICE, "link": "https://vm.tiktok.com/ZM123/"})[0] == 400
    assert call("POST", job_path("done"), {"device": DEVICE})[0] == 400
    assert snapshot(table) == before


def test_done_posts_it_on_the_story_once(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _claimed(call, store)
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    link = "https://tiktok.com/@LamoStories/video/7300000000000000001?is_from_webapp=1"
    status, body = call("POST", job_path("done"), {"device": DEVICE, "link": link, "attempt": 1})
    assert status == 200, body
    job = body["job"]
    assert (job["publishingStatus"], job["via"], job["url"]) == (
        "posted",
        "mac",
        "https://www.tiktok.com/@LamoStories/video/7300000000000000001",
    )
    assert "mac" not in job
    item = stored(table)
    assert not [k for k in item if k.startswith("mac")]
    assert (item["privacy"], item["postedAt"]) == ("public", "2026-11-15T12:00:00.000Z")
    story = stored(table, STORY_SK)
    assert story["status"] == "published"
    assert story["posted"] == [{"platform": "tiktok", "url": job["url"]}]
    assert story["publishedAt"] == "2026-11-15T12:00:00.000Z"
    assert story["version"] == 4
    acts = [i for i in table.all() if str(i["sk"]).startswith("ACT#")]
    assert [(a["kind"], a["platform"], a["title"]) for a in acts] == [("posted", "tiktok", "Ice is slippery")]
    # a repeat is answered as the first, and writes nothing
    before = snapshot(table)
    status, again = call("POST", job_path("done"), {"device": DEVICE, "link": link, "attempt": 1})
    assert (status, again["job"]["url"]) == (200, job["url"])
    assert snapshot(table) == before
    assert call("POST", job_path("done"), {"device": "mac-2", "link": link})[0] == 200  # it is posted: nothing left
    clips_untouched(table)


def test_a_post_handed_over_from_only_me_takes_the_place_of_its_private_link_on_the_story(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    private = "https://www.tiktok.com/@lamostories/video/7300000000000000009"
    youtube = {"platform": "youtube", "url": "https://youtu.be/abc"}
    store.update(sup.PK, STORY_SK, {"posted": [{"platform": "tiktok", "url": private}, youtube]})
    mac_job(store, beforeMac={"publishingStatus": "posted", "url": private, "privacy": "private"})
    assert claim(call)[0] == 200
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    status, body = call("POST", job_path("done"), {"device": DEVICE, "link": LINK, "attempt": 1})
    assert status == 200, body
    # One TikTok link on the story, the public one, in the private one's place; the others stay.
    assert stored(table, STORY_SK)["posted"] == [{"platform": "tiktok", "url": LINK}, youtube]
    clips_untouched(table)


def test_the_story_keeps_one_link_per_post() -> None:
    from clipfactory_api.workspaces import story_posted

    a, b = "https://www.tiktok.com/@x/video/7300000000000000001", "https://www.tiktok.com/@x/video/7300000000000000002"
    story = {"status": "published", "publishedAt": "2026-11-15T11:00:00.000Z", "version": 3}
    same = {**story, "posted": [{"platform": "tiktok", "url": a}]}
    assert story_posted.story_write(same, "tiktok", a, "t", NOW) is None  # a replay adds nothing
    assert story_posted.story_write(same, "tiktok", a, "t", NOW, replace=a) is None
    write = story_posted.story_write(same, "tiktok", b, "t", NOW, replace=a)
    assert write is not None
    assert write.values[":f0"] == [{"platform": "tiktok", "url": b}]
    both = {**story, "posted": [{"platform": "tiktok", "url": a}, {"platform": "tiktok", "url": b}]}
    write = story_posted.story_write(both, "tiktok", b, "t", NOW, replace=a)
    assert write is not None
    assert write.values[":f0"] == [{"platform": "tiktok", "url": b}]
    # Without replace an earlier link stays (the story flow's own posts, as before).
    write = story_posted.story_write(same, "tiktok", b, "t", NOW)
    assert write is not None
    assert write.values[":f0"] == [{"platform": "tiktok", "url": a}, {"platform": "tiktok", "url": b}]


def test_done_only_from_the_claim_that_has_the_job(call: Call, store: db.Store, starter: sup.FakeStarter) -> None:
    mac_job(store)
    assert call("POST", job_path("done"), {"device": DEVICE, "link": LINK})[0] == 409  # never claimed
    assert claim(call)[0] == 200
    assert call("POST", job_path("done"), {"device": "mac-2", "link": LINK})[0] == 409
    assert call("POST", job_path("done"), {"device": DEVICE, "link": LINK, "attempt": 9})[0] == 409
    assert call("POST", job_path("done"), {"device": DEVICE, "link": LINK, "attempt": 1})[0] == 200


# --- the owner's Try again ----------------------------------------------------------------------------------------


def test_try_again_on_a_stopped_job_waits_again_and_lets_the_mac_go_on(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _claimed(call, store)
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "Logged out.", "needsYou": True})
    clock.now = NOW + timedelta(minutes=1)
    status, body = call("POST", job_path("retry"), {})
    assert status == 200, body
    assert body["job"]["publishingStatus"] == "mac"
    assert body["job"]["mac"] == {
        "state": "waiting",
        "since": "2026-11-15T11:59:00.000Z",  # it keeps its place
        "beatAt": "2026-11-15T12:00:00.000Z",  # the last beat of the try that stopped, as in Clip Factory's
        "againAt": "2026-11-15T12:01:00.000Z",
    }
    helper = stored(table, "MACHELPER")
    assert helper["state"] == "ok"
    assert "needsYouJobId" not in helper
    assert claim(call)[1]["job"]["attempt"] == 2
    clips_untouched(table)


def test_try_again_waits_while_the_mac_works_and_after_a_press(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _claimed(call, store)
    assert call("POST", job_path("retry"), {})[1]["error"]["message"] == mac.MAC_WORKING
    call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "Lost it."})
    assert call("POST", job_path("retry"), {})[1]["error"]["message"] == mac.MAY_HAVE_POSTED
    assert call("POST", job_path("retry"), {"notOnTikTok": True})[1]["error"]["message"] == mac.MAC_STILL_LOOKING
    clock.now = NOW + timedelta(minutes=30)
    status, body = call("POST", job_path("retry"), {"notOnTikTok": True})
    assert status == 200, body
    item = stored(table)
    assert (item["macState"], item["macPressedBefore"], item["macAgainAt"]) == (
        "waiting",
        "2026-11-15T12:00:00.000Z",
        "2026-11-15T12:30:00.000Z",
    )
    assert "macPressedAt" not in item
    job = claim(call)[1]["job"]
    assert (job["pressedBefore"], job["againAt"]) == ("2026-11-15T12:00:00.000Z", "2026-11-15T12:30:00.000Z")


def test_try_again_takes_a_stuck_job_from_its_claim(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _claimed(call, store)
    clock.now = NOW + timedelta(minutes=5)  # no beat for 5 minutes
    status, body = call("POST", job_path("retry"), {})
    assert status == 200, body
    item = stored(table)
    assert item["macState"] == "waiting"
    assert not {"macDevice", "macBeatAt", "macClaimedAt"} & set(item)


def test_try_again_asks_before_a_new_account(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, starter: sup.FakeStarter
) -> None:
    mac_job(store, macState="stopped", macReason="x", macStoppedAt="2026-11-15T11:59:30.000Z")
    sup.social(store, secrets_client, "tiktok", identity="open-new", handle="@newname", accountName="New")
    status, body = call("POST", job_path("retry"), {})
    assert status == 409
    assert body["error"]["account"] == {"externalAccountId": "open-new", "accountName": "New", "handle": "@newname"}
    assert call("POST", job_path("retry"), {"confirmAccount": "open-other"})[0] == 409
    assert stored(table)["macState"] == "stopped"
    status, body = call("POST", job_path("retry"), {"confirmAccount": "open-new"})
    assert status == 200, body
    item = stored(table)
    assert (item["externalAccountId"], item["handle"], item["macState"]) == ("open-new", "@newname", "waiting")
    assert claim(call)[1]["job"]["account"] == {"handle": "@newname", "openId": "open-new"}


# --- It's on TikTok -----------------------------------------------------------------------------------------------


def test_its_on_tiktok_with_a_link_and_without_one(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _claimed(call, store)
    assert call("POST", job_path("posted"), {"link": LINK})[1]["error"]["message"] == mac.MAC_WORKING
    clock.now = NOW + timedelta(minutes=6)  # stuck, never pressed
    status, body = call("POST", job_path("posted"), {"noLink": True})
    assert (status, body["error"]["message"]) == (409, mac.MAC_NOT_PRESSED)
    other = "https://www.tiktok.com/@lamo.clips/video/7300000000000000001"
    assert call("POST", job_path("posted"), {"link": other})[1]["error"]["code"] == "wrong_account"
    assert call("POST", job_path("posted"), {})[0] == 400
    assert call("POST", job_path("posted"), {"link": LINK, "noLink": True})[0] == 400
    status, body = call("POST", job_path("posted"), {"link": LINK})
    assert status == 200, body
    assert (body["job"]["publishingStatus"], body["job"]["by"], body["job"]["url"]) == ("posted", "you", LINK)
    assert stored(table, STORY_SK)["posted"] == [{"platform": "tiktok", "url": LINK}]


def test_its_on_tiktok_without_a_link_on_a_waiting_job(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    mac_job(store)
    status, body = call("POST", job_path("posted"), {"noLink": True})
    assert status == 200, body
    assert (body["job"]["publishingStatus"], body["job"]["by"]) == ("posted", "you")
    assert "url" not in body["job"]
    assert call("POST", job_path("posted"), {"link": LINK})[1]["job"]["url"] == LINK  # the link comes later
    assert claim(call)[0] == 409


# --- every route ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (PING, {"state": "ok", "version": "1.2.0", "device": DEVICE, "setUp": True, "x": 1}),
        (LOGIN, {"action": "sign_in", "x": 1}),
        (job_path("claim"), {"device": DEVICE, "version": "1.2.0", "x": 1}),
        (job_path("step"), {"device": DEVICE, "step": "video", "x": 1}),
        (job_path("done"), {"device": DEVICE, "link": LINK, "x": 1}),
        (job_path("stopped"), {"device": DEVICE, "reason": "r", "x": 1}),
        (job_path("retry"), {"now": True}),
        (job_path("posted"), {"link": LINK, "x": 1}),
    ],
)
def test_unknown_keys_are_refused(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, path: str, body: Any
) -> None:
    mac_job(store)
    before = snapshot(table)
    status, got = call("POST", path, body)
    assert status == 400, got
    assert snapshot(table) == before


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (job_path("claim"), {"device": DEVICE, "version": "1.2.0"}),
        (job_path("step"), {"device": DEVICE, "step": "video"}),
        (job_path("done"), {"device": DEVICE, "link": LINK}),
        (job_path("stopped"), {"device": DEVICE, "reason": "r"}),
        (job_path("retry"), {}),
        (job_path("posted"), {"noLink": True}),
    ],
)
def test_another_owners_job_is_not_found(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, path: str, body: Any
) -> None:
    mac_job(store)
    status, got = call("POST", path, body, sub="99999999-2222-3333-4444-555555555555")
    assert status == 404, got
    assert got["error"]["message"] == "We could not find that post."
    item = stored(table)
    assert (item["macState"], item.get("macDevice")) == ("waiting", None)


def test_clip_factorys_workspace_has_no_mac_routes(call: Call, starter: sup.FakeStarter) -> None:
    assert call("GET", "/v1/workspaces/clips/tiktok/mac")[0] == 409
    assert call("POST", "/v1/workspaces/clips/tiktok/mac/ping", {})[0] == 409


# --- §47.11: a TikTok login hold ends by itself once the lane's Chrome is logged in again ---------------------------


def _login_stop(call: Call, store: db.Store, *, code: str | None = "login", pressed: bool = False) -> None:
    _claimed(call, store)
    if pressed:
        assert call("POST", job_path("step"), {"device": DEVICE, "step": "pressing"})[0] == 200
    body: dict[str, Any] = {
        "device": DEVICE,
        "reason": "TikTok logged your Mac out. Tap Log in on my Mac.",
        "needsYou": True,
    }
    if code is not None:
        body["code"] = code
    assert call("POST", job_path("stopped"), body)[0] == 200


def test_a_login_stop_stores_its_code_on_the_workspace_helper_item_only(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _login_stop(call, store)
    helper = stored(table, "MACHELPER")
    assert (helper["state"], helper["needsYouJobId"], helper["needsYouCode"]) == ("needs_you", JOB_ID, "login")
    assert call("GET", STATUS)[1]["helper"]["needsYouCode"] == "login"
    clips_untouched(table)
    body = {"device": DEVICE, "reason": "x", "needsYou": True, "code": "captcha"}
    assert call("POST", job_path("stopped"), body)[1]["error"]["message"] == "code must be login."
    # A later needs-you stop without a code removes it; a needs_you ping keeps it, any other ping removes it.
    assert call("POST", job_path("stopped"), {"device": DEVICE, "reason": "A puzzle.", "needsYou": True})[0] == 200
    assert "needsYouCode" not in stored(table, "MACHELPER")
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "Out.", "needsYou": True, "code": "login"})
    ping = {"version": "1.2.2", "device": DEVICE, "setUp": False}
    call("POST", PING, {**ping, "state": "needs_you", "reason": "Out."})
    assert stored(table, "MACHELPER")["needsYouCode"] == "login"
    call("POST", PING, {**ping, "state": "ok"})
    assert not {"needsYouCode", "needsYouJobId"} & set(stored(table, "MACHELPER"))
    assert "needsYouCode" not in (mac.public_helper({**helper, "state": "ok"}) or {})


@pytest.mark.parametrize("answer", ["retry", "posted"])
def test_the_owners_answer_removes_the_login_code(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, answer: str
) -> None:
    _login_stop(call, store)
    body = {} if answer == "retry" else {"link": LINK}
    status, out = call("POST", job_path(answer), body)
    assert status == 200, out
    helper = stored(table, "MACHELPER")
    assert helper["state"] == "ok"
    assert not {"needsYouCode", "needsYouJobId", "needsYouStoryId"} & set(helper)


def test_logged_in_puts_the_stopped_job_back_in_line_and_ends_the_hold(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, clock: Clock
) -> None:
    _login_stop(call, store)
    clock.now = NOW + timedelta(minutes=7)
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert status == 200, body
    assert body["outcome"] == "resumed"
    assert body["helper"]["state"] == "ok"
    assert not {"reason", "needsYouJobId", "needsYouStoryId", "needsYouCode"} & set(body["helper"])
    item = stored(table)
    assert (item["macState"], item["macSince"], item["macAttempt"], item["macDevice"], item["updatedAt"]) == (
        "waiting",
        "2026-11-15T11:59:00.000Z",
        1,
        DEVICE,
        "2026-11-15T12:07:00.000Z",
    )
    assert not {"macStep", "macClaimedAt", "macStoppedAt", "macReason", "macAgainAt", "macPressedAt"} & set(item)
    clips_untouched(table)
    assert claim(call)[1]["job"]["attempt"] == 2  # the claim checks the account again, as for any post
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["error"]["message"]) == (409, mac.NOT_LOGIN_HOLD)


def test_logged_in_after_a_press_and_on_a_job_that_is_gone(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    _login_stop(call, store, pressed=True)
    job_before = stored(table)
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["outcome"], body["helper"]["state"]) == (200, "pressed", "ok")
    assert stored(table) == job_before  # never twice: the owner's question stays
    assert claim(call)[0] == 409
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "Out.", "needsYou": True, "code": "login"})
    store.delete(sup.PK, JOB_SK)
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["outcome"]) == (200, "cleared")
    assert stored(table, "MACHELPER")["state"] == "ok"
    clips_untouched(table)


def test_logged_in_is_refused_unless_this_mac_holds_this_job_for_a_login(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    mac_job(store)
    assert call("POST", job_path("logged-in"), {"device": DEVICE})[0] == 409  # no helper item
    _login_stop(call, store, code=None)
    assert call("POST", job_path("logged-in"), {"device": DEVICE})[0] == 409  # no code
    call("POST", job_path("stopped"), {"device": DEVICE, "reason": "Out.", "needsYou": True, "code": "login"})
    assert call("POST", job_path("logged-in", "01JZ0000000000000000000PJ2"), {"device": DEVICE})[0] == 409
    assert call("POST", job_path("logged-in"), {"device": "mac-2"})[0] == 409
    store.update(sup.PK, JOB_SK, {"macDevice": "mac-2"})
    before = snapshot(table)
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["error"]["message"]) == (409, mac.NOT_LOGIN_HOLD)
    assert snapshot(table) == before
    for bad in ({"device": DEVICE, "x": 1}, {}):
        assert call("POST", job_path("logged-in"), bad)[0] == 400
    assert snapshot(table) == before


def test_logged_in_loses_to_a_change(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, monkeypatch: pytest.MonkeyPatch
) -> None:
    _login_stop(call, store)
    stale = stored(table)
    store.update(sup.PK, JOB_SK, {"macState": "working"})  # claimed again meanwhile
    monkeypatch.setattr(publish, "job_item", lambda *_a: stale)
    before = snapshot(table)
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["error"]["message"]) == (409, mac.CHANGED)
    assert snapshot(table) == before


def test_a_second_macs_needs_you_ping_never_takes_the_workspace_hold_from_the_mac_that_stopped(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter
) -> None:
    """Review, 24 Nov: another Mac's needs_you ping rewrites ``device`` every minute; the hold keeps the Mac that
    stopped (``needsYouDevice``, never public), so that Mac's logged-in still ends it and the other Mac's never does."""
    _login_stop(call, store)
    ping = {"version": "1.2.2", "device": "mac-2", "setUp": True, "state": "needs_you", "reason": "Out."}
    assert call("POST", PING, ping)[0] == 200
    held = stored(table, "MACHELPER")
    assert (held["device"], held["needsYouDevice"], held["needsYouCode"]) == ("mac-2", DEVICE, "login")
    assert "needsYouDevice" not in call("GET", STATUS)[1]["helper"]
    assert call("POST", job_path("logged-in"), {"device": "mac-2"})[0] == 409
    status, body = call("POST", job_path("logged-in"), {"device": DEVICE})
    assert (status, body["outcome"]) == (200, "resumed"), body
    assert not {"needsYouJobId", "needsYouCode", "needsYouDevice"} & set(stored(table, "MACHELPER"))
    clips_untouched(table)


def test_a_needs_you_ping_never_starts_a_workspace_hold(
    call: Call, store: db.Store, table: FakeTable, starter: sup.FakeStarter, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review, 24 Nov: the owner's Try again lands while the Mac's Log in on my Mac window is open, and the tick's ping
    then repeats the needs_you it read before: only a stop starts a hold, so that ping checks in as ok."""
    _login_stop(call, store)
    assert call("POST", job_path("retry"), {})[0] == 200
    stale = {"version": "1.2.2", "device": DEVICE, "setUp": False, "state": "needs_you", "reason": "Out."}
    assert call("POST", PING, stale)[0] == 200
    helper = stored(table, "MACHELPER")
    assert (helper["state"], helper["setUp"]) == ("ok", False)
    assert not {"reason", "needsYouJobId", "needsYouStoryId", "needsYouCode", "needsYouDevice"} & set(helper)
    assert stored(table)["macState"] == "waiting"
    # The hold ends between the ping's read and its write: the conditional write loses and checks in as ok.
    assert claim(call)[0] == 200
    stop = {"device": DEVICE, "reason": "Out.", "needsYou": True, "code": "login"}
    assert call("POST", job_path("stopped"), stop)[0] == 200
    read = stored(table, "MACHELPER")
    assert call("POST", job_path("retry"), {})[0] == 200
    real_get = store.get
    monkeypatch.setattr(store, "get", lambda pk, sk: dict(read) if sk == ws.MACHELPER_SK else real_get(pk, sk))
    assert call("POST", PING, stale)[0] == 200
    monkeypatch.undo()
    helper = stored(table, "MACHELPER")
    assert helper["state"] == "ok"
    assert not {"reason", "needsYouJobId", "needsYouCode", "needsYouDevice"} & set(helper)
    # A hold a stop started stays with a needs_you ping.
    assert claim(call)[0] == 200
    assert call("POST", job_path("stopped"), stop)[0] == 200
    assert call("POST", PING, stale)[0] == 200
    helper = stored(table, "MACHELPER")
    assert (helper["state"], helper["needsYouJobId"], helper["needsYouCode"], helper["needsYouDevice"]) == (
        "needs_you",
        JOB_ID,
        "login",
        DEVICE,
    )
    clips_untouched(table)


def test_the_workspace_hold_codes_are_clip_factorys() -> None:
    text = (SRC / "workspaces" / "mac.py").read_text()
    assert re.findall(r"^HOLD_CODES: Final = \(([^)]*)\)$", text, re.MULTILINE) == ['"login",']
    assert mac.HOLD_CODES == tiktok_mac.HOLD_CODES
    assert mac.NOT_LOGIN_HOLD == tiktok_mac.NOT_LOGIN_HOLD
