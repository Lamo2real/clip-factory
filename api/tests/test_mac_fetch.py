"""Mac fetches it (docs/CONTRACTS.md §35): the job flow waits for the owner's Mac when YouTube blocks the cloud (or
from the start, for a job made in the desktop app), the routes the Mac reports and uploads through, the cancel, the
notification and what the web may see."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from aws_durable_execution_sdk_python import CallbackExternalError, CallbackTimeoutError

from clipfactory_api import db, jobs, macfetch
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.flows.job_flow import JobFlowDeps, run_job_flow
from clipfactory_api.push import notify
from conftest import NOW, USER, Call, Clock, seed_job
from fakes import FakeAgentCore, FakeCallback, FakeDurableContext, FakeLambda, FakeS3, FakeTable

RUNTIME = "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent"
YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
DEVICE = "mac-device-0001"
OTHER_DEVICE = "mac-device-0002"
STEPS_AT_CUT = [
    {"key": k, "label": label, "status": "done" if k in ("resolve", "download", "select") else "pending"}
    for k, label in jobs.STEPS
]
STEPS_AT_CUT[6] = {**STEPS_AT_CUT[6], "status": "running", "message": "Cutting clip 1 of 3…"}


def _deps(store: db.Store, agentcore: FakeAgentCore) -> JobFlowDeps:
    return JobFlowDeps(store=store, agent=AgentClient(agentcore, RUNTIME), clock=Clock())


def _event(job: dict[str, Any]) -> dict[str, Any]:
    return {"jobId": job["jobId"], "userId": USER, "sessionId": job["sessionId"], "run": 1}


def _ready(job: dict[str, Any]) -> FakeCallback:
    return FakeCallback(result=json.dumps({"jobId": job["jobId"], "clipCount": 4}))


def _mac_done(job: dict[str, Any], **extra: Any) -> FakeCallback:
    cb = FakeCallback(result=json.dumps({"key": macfetch.upload_key(USER, job["jobId"]), "size": 1234, **extra}))
    cb.callback_id = "cb-mac"
    return cb


def _blocked() -> FakeCallback:
    return FakeCallback(error=CallbackExternalError(message=macfetch.WAITING, error_type="MacFetch"))


# --- the job flow -----------------------------------------------------------------------------------------------


def test_blocked_by_youtube_waits_for_the_mac_then_runs_on_its_video(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="queued", steps=STEPS_AT_CUT, macFetch={"state": "cloud"})
    seen: dict[str, Any] = {}

    class Ctx(FakeDurableContext):
        def wait(self, duration: Any, name: str | None = None) -> None:
            super().wait(duration, name)
            seen["waiting"] = table.raw(job["pk"], job["sk"])  # what the job looks like while it waits

    ctx = Ctx(_blocked(), then=[_mac_done(job, title="Me at the zoo", creator="jawed"), _ready(job)])
    out = run_job_flow(ctx, _event(job), _deps(store, agentcore))
    assert out == {"jobId": job["jobId"], "outcome": "ready"}
    assert ctx.steps == [
        "start-agent",
        "mac-wait",
        "mac-stop-old",
        "mac-nudge",
        "mac-source",
        "start-agent-1",
        "finish",
    ]
    names = [n for n, _ in ctx.callbacks]
    assert names == ["agent-done", "mac-done", "agent-done-1"]
    assert ctx.callbacks[1][1].timeout_seconds == 24 * 3600
    assert ctx.waits == [("mac-nudge-after", 120)]
    waiting = seen["waiting"]
    assert waiting["status"] == "running"
    assert waiting["macFetch"]["state"] == "waiting"
    assert waiting["macCallbackId"] == "cb-mac"
    render = next(s for s in waiting["steps"] if s["key"] == "render")
    assert (render["status"], render["message"]) == ("running", macfetch.WAITING)
    # The live line says the same, for the old run (the web shows it until the new run writes its own).
    live = table.raw(job["pk"], f"JOBLIVE#{job['jobId']}")
    assert live is not None
    # The Mac's video: a new session, an upload source that keeps the link, the done steps and a fresh 8 h.
    new_session = agentcore.calls[-1]["runtimeSessionId"]
    assert new_session != job["sessionId"]
    assert agentcore.stopped == [job["sessionId"]]
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["source"]["type"] == "upload"
    assert stored["source"]["fetchedBy"] == "mac"
    assert stored["source"]["key"] == macfetch.upload_key(USER, job["jobId"])
    assert stored["source"]["url"] == job["source"]["url"]
    assert stored["source"]["linkPlatform"] == "youtube"
    assert stored["source"]["title"] == "Me at the zoo"
    assert stored["source"]["channel"] == "jawed"
    assert stored["macFetch"]["state"] == "done"
    assert "macCallbackId" not in stored
    steps = {s["key"]: s["status"] for s in stored["steps"]}
    assert steps["select"] == "done"
    assert steps["render"] == "pending"
    assert (stored["status"], stored["clipCount"]) == ("ready", 4)


def test_a_job_made_in_the_desktop_app_goes_to_the_mac_first(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    steps = [{"key": k, "label": label, "status": "pending"} for k, label in jobs.STEPS]
    job = seed_job(store, status="queued", steps=steps, macFetch={"state": "waiting", "up": True})
    unused = FakeCallback()
    ctx = FakeDurableContext(unused, then=[_mac_done(job), _ready(job)])
    out = run_job_flow(ctx, _event(job), _deps(store, agentcore))
    assert out["outcome"] == "ready"
    # The cloud never asked YouTube: the agent ran once, on the Mac's video.
    assert len(agentcore.calls) == 1
    assert agentcore.calls[0]["runtimeSessionId"] != job["sessionId"]
    assert "mac-stop-old" not in ctx.steps
    assert unused.waited == 0


def test_no_mac_in_24_hours_fails_with_use_a_video_file(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="running", macFetch={"state": "cloud"})
    timeout = FakeCallback(error=CallbackTimeoutError(message="timed out"))
    ctx = FakeDurableContext(_blocked(), then=[timeout])
    out = run_job_flow(ctx, _event(job), _deps(store, agentcore))
    assert out["outcome"] == "failed"
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["error"] == macfetch.TIMED_OUT == "Your Mac didn't get the video. Use a video file instead."
    assert stored["source"]["type"] == "link", "the link stays, so Use a video file and Try again both work"


def test_the_mac_stopping_fails_with_its_words_and_a_cancel_is_quiet(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="running", macFetch={"state": "cloud"})
    full = macfetch.full_words(6)
    stopped = FakeCallback(error=CallbackExternalError(message=full, error_type="MacFailed"))
    out = run_job_flow(FakeDurableContext(_blocked(), then=[stopped]), _event(job), _deps(store, agentcore))
    assert out["outcome"] == "failed"
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["error"] == "Your Mac is full. Free up 6 GB."

    job2 = seed_job(store, status="running", macFetch={"state": "cloud"})

    class OwnerStops(FakeDurableContext):
        def wait(self, duration: Any, name: str | None = None) -> None:
            super().wait(duration, name)
            table.items[(job2["pk"], job2["sk"])]["status"] = "canceled"  # the cancel route, while it waits

    canceled = FakeCallback(error=CallbackExternalError(message="The job was canceled.", error_type="Canceled"))
    out2 = run_job_flow(OwnerStops(_blocked(), then=[canceled]), _event(job2), _deps(store, agentcore))
    assert out2["outcome"] == "canceled"


def test_the_nudge_waits_two_minutes_and_skips_a_mac_already_on_it(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="running", macFetch={"state": "cloud"})
    ctx = FakeDurableContext(_blocked(), then=[_mac_done(job), _ready(job)])
    run_job_flow(ctx, _event(job), _deps(store, agentcore))
    assert ctx.results["mac-nudge"] == {"nudged": True}

    job2 = seed_job(store, status="running", macFetch={"state": "cloud"})

    class Claimed(FakeDurableContext):
        def wait(self, duration: Any, name: str | None = None) -> None:
            super().wait(duration, name)
            item = table.items[(job2["pk"], job2["sk"])]
            item["macFetch"] = {**item["macFetch"], "state": "getting"}

    ctx2 = Claimed(_blocked(), then=[_mac_done(job2), _ready(job2)])
    run_job_flow(ctx2, _event(job2), _deps(store, agentcore))
    assert ctx2.results["mac-nudge"] == {"nudged": False}


def test_a_job_from_before_mac_fetch_fails_as_before(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="running")
    failed = FakeCallback(error=CallbackExternalError(message="YouTube stopped the cloud…", error_type="JobFailed"))
    ctx = FakeDurableContext(failed)
    out = run_job_flow(ctx, _event(job), _deps(store, agentcore))
    assert out["outcome"] == "failed"
    assert not any(s.startswith("mac-") for s in ctx.steps)


def test_a_wrong_result_never_becomes_the_jobs_video(
    store: db.Store, agentcore: FakeAgentCore, table: FakeTable
) -> None:
    job = seed_job(store, status="running", macFetch={"state": "cloud"})
    evil = FakeCallback(result=json.dumps({"key": f"uploads/{USER}/someone-else/video.mp4", "size": 10}))
    out = run_job_flow(FakeDurableContext(_blocked(), then=[evil]), _event(job), _deps(store, agentcore))
    assert out["outcome"] == "failed"
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["source"]["type"] == "link"


# --- creating a job -------------------------------------------------------------------------------------------


def test_youtube_link_jobs_carry_the_mac_map(call: Call, table: FakeTable) -> None:
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": YT}})
    assert status == 201
    assert body["job"]["macFetch"] == {"state": "cloud"}
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": YT}, "macFetch": True})
    assert body["job"]["macFetch"] == {"state": "waiting", "up": True}
    status, body = call(
        "POST", "/v1/jobs", {"source": {"type": "link", "url": "https://www.twitch.tv/videos/1"}, "macFetch": True}
    )
    assert status == 201
    assert "macFetch" not in body["job"]
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": YT}, "macFetch": "yes"})
    assert status == 400


def test_the_web_never_sees_the_device_upload_or_callback(store: db.Store, call: Call) -> None:
    job = seed_job(
        store,
        macCallbackId="cb-secret",
        macFetch={"state": "sending", "pct": 40, "deviceId": DEVICE, "uploadId": "up-1", "key": "k", "size": 9},
    )
    status, body = call("GET", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["job"]["macFetch"] == {"state": "sending", "pct": 40}
    assert "macCallbackId" not in body["job"]
    assert "cb-secret" not in json.dumps(body)
    assert "up-1" not in json.dumps(body)


# --- the Mac's routes -----------------------------------------------------------------------------------------


def _waiting_job(store: db.Store, **mac: Any) -> dict[str, Any]:
    return seed_job(
        store, macCallbackId="cb-mac", macFetch={"state": "waiting", "since": "2026-11-15T11:59:00.000Z", **mac}
    )


def test_progress_claims_the_job_and_moves_the_live_line(
    store: db.Store, call: Call, table: FakeTable, clock: Clock
) -> None:
    job = _waiting_job(store)
    path = f"/v1/jobs/{job['jobId']}/mac-progress"
    status, body = call("POST", path, {"deviceId": DEVICE, "phase": "getting", "pct": 42})
    assert status == 200
    assert body["job"]["macFetch"]["state"] == "getting"
    assert body["job"]["macFetch"]["pct"] == 42
    live = table.raw(job["pk"], f"JOBLIVE#{job['jobId']}")
    assert live is not None
    assert (live["text"], live["detail"]) == ("Your Mac is getting the video", "42%")
    assert live["sessionId"] == job["sessionId"]
    # Another computer cannot take it while this one reports.
    status, body = call("POST", path, {"deviceId": OTHER_DEVICE, "phase": "getting", "pct": 1})
    assert status == 409
    # Too often: one write every 3 seconds.
    status, _ = call("POST", path, {"deviceId": DEVICE, "phase": "getting", "pct": 43})
    assert status == 429
    clock.now = NOW + timedelta(seconds=5)
    status, _ = call("POST", path, {"deviceId": DEVICE, "phase": "getting", "pct": 50})
    assert status == 200
    # A Mac that went quiet for 2 minutes gives it up.
    clock.now = NOW + timedelta(minutes=3)
    status, _ = call("POST", path, {"deviceId": OTHER_DEVICE, "phase": "getting", "pct": 2})
    assert status == 200


def test_a_mac_faster_than_the_flow_is_asked_to_try_again(store: db.Store, call: Call) -> None:
    job = seed_job(store, status="queued", macFetch={"state": "waiting", "up": True})
    path = f"/v1/jobs/{job['jobId']}/mac-progress"
    status, _ = call("POST", path, {"deviceId": DEVICE, "phase": "getting", "pct": 3})
    assert status == 200
    status, body = call("POST", path, {"deviceId": DEVICE, "phase": "failed", "error": "live"})
    assert status == 503
    assert body["error"]["message"].startswith("The job is getting ready for your Mac.")


def test_progress_checks_what_it_is_told(store: db.Store, call: Call) -> None:
    job = _waiting_job(store)
    path = f"/v1/jobs/{job['jobId']}/mac-progress"
    for bad in (
        {"deviceId": "x", "phase": "getting"},
        {"deviceId": DEVICE, "phase": "dancing"},
        {"deviceId": DEVICE, "phase": "getting", "pct": 101},
        {"deviceId": DEVICE, "phase": "failed", "error": "something yt-dlp said"},
        {"deviceId": DEVICE, "phase": "getting", "extra": 1},
    ):
        status, _ = call("POST", path, bad)
        assert status == 400, bad
    done = seed_job(store, status="ready", macFetch={"state": "done"})
    status, _ = call("POST", f"/v1/jobs/{done['jobId']}/mac-progress", {"deviceId": DEVICE, "phase": "getting"})
    assert status == 409


def test_the_mac_stopping_tells_the_flow_in_plain_words(
    store: db.Store, call: Call, lambda_client: FakeLambda, s3_client: FakeS3
) -> None:
    job = _waiting_job(store)
    status, body = call(
        "POST",
        f"/v1/jobs/{job['jobId']}/mac-progress",
        {"deviceId": DEVICE, "phase": "failed", "error": "full", "needGb": 6},
    )
    assert status == 200
    ((kind, kw),) = lambda_client.callbacks
    assert kind == "failure"
    assert kw["CallbackId"] == "cb-mac"
    assert kw["Error"] == {"ErrorType": "MacFailed", "ErrorMessage": "Your Mac is full. Free up 6 GB."}
    assert body["job"]["macFetch"]["state"] == "failed"


def test_the_video_goes_up_in_parts_and_the_flow_is_told(
    store: db.Store, call: Call, lambda_client: FakeLambda, s3_client: FakeS3, table: FakeTable
) -> None:
    job = _waiting_job(store)
    size = macfetch.PART_SIZE + 10
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/source-upload", {"deviceId": DEVICE, "size": size})
    assert status == 200
    assert body["partSize"] == macfetch.PART_SIZE
    assert [p["n"] for p in body["parts"]] == [1, 2]
    key = macfetch.upload_key(USER, job["jobId"])
    assert all(key in p["url"] and "op=upload_part" in p["url"] for p in body["parts"])
    (op, params, seconds) = s3_client.presigned[-1]
    assert (op, params["PartNumber"], params["UploadId"], seconds) == ("upload_part", 2, "up-1", 6 * 3600)
    # Asked again for the same size (the Mac restarted): the same upload, so sent parts are kept.
    call("POST", f"/v1/jobs/{job['jobId']}/source-upload", {"deviceId": DEVICE, "size": size})
    assert len(s3_client.multipart) == 1
    tags = [
        {"n": 1, "etag": s3_client.send_part("up-1", 1, b"a" * macfetch.PART_SIZE)},
        {"n": 2, "etag": s3_client.send_part("up-1", 2, b"b" * 10)},
    ]
    done = {"deviceId": DEVICE, "parts": tags, "title": "Me at the zoo\n", "creator": "jawed", "durationSec": 19}
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/source-upload/complete", done)
    assert status == 200, body
    ((kind, kw),) = lambda_client.callbacks
    assert kind == "success"
    assert kw["CallbackId"] == "cb-mac"
    assert json.loads(kw["Result"]) == {
        "key": key,
        "size": size,
        "title": "Me at the zoo",
        "creator": "jawed",
        "durationSec": 19.0,
    }
    assert len(s3_client.objects[key]) == size


def test_complete_refuses_a_partial_video_and_a_closed_wait(
    store: db.Store, call: Call, lambda_client: FakeLambda, s3_client: FakeS3
) -> None:
    job = _waiting_job(store)
    call("POST", f"/v1/jobs/{job['jobId']}/source-upload", {"deviceId": DEVICE, "size": 20})
    tag = s3_client.send_part("up-1", 1, b"short")
    path = f"/v1/jobs/{job['jobId']}/source-upload/complete"
    status, _ = call("POST", path, {"deviceId": DEVICE, "parts": [{"n": 1, "etag": tag}]})
    assert status == 409
    assert lambda_client.callbacks == []
    status, _ = call("POST", path, {"deviceId": DEVICE, "parts": []})
    assert status == 400
    job2 = _waiting_job(store)
    call("POST", f"/v1/jobs/{job2['jobId']}/source-upload", {"deviceId": DEVICE, "size": 5})
    tag2 = s3_client.send_part("up-2", 1, b"12345")
    lambda_client.closed_callbacks.add("cb-mac")
    status, body = call(
        "POST",
        f"/v1/jobs/{job2['jobId']}/source-upload/complete",
        {"deviceId": DEVICE, "parts": [{"n": 1, "etag": tag2}]},
    )
    assert status == 409
    assert body["error"]["message"] == "This job stopped waiting for your Mac."


def test_stopping_a_waiting_job_ends_the_wait_and_drops_the_half_sent_video(
    store: db.Store, call: Call, lambda_client: FakeLambda, s3_client: FakeS3
) -> None:
    job = _waiting_job(store)
    call("POST", f"/v1/jobs/{job['jobId']}/source-upload", {"deviceId": DEVICE, "size": 5})
    status, _ = call("POST", f"/v1/jobs/{job['jobId']}/cancel")
    assert status == 200
    assert (
        "failure",
        {"CallbackId": "cb-mac", "Error": {"ErrorType": "Canceled", "ErrorMessage": "The job was canceled."}},
    ) in lambda_client.callbacks
    assert s3_client.multipart["up-1"]["aborted"] is True


def test_try_again_forgets_the_last_wait_for_a_mac(store: db.Store, call: Call) -> None:
    job = seed_job(
        store,
        status="failed",
        error="Your Mac didn't get the video. Use a video file instead.",
        macCallbackId="cb-old",
        macFetch={
            "state": "waiting",
            "since": "2026-11-14T11:59:00.000Z",
            "nudgedAt": "2026-11-14T12:01:00.000Z",
            "deviceId": DEVICE,
            "uploadId": "up-old",
            "key": "uploads/old",
            "size": 9,
            "pct": 40,
        },
    )
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert body["job"]["macFetch"] == {"state": "cloud"}  # the cloud goes first again; nothing waits for a Mac
    saved = store.get(job["pk"], job["sk"]) or {}
    assert saved["macFetch"] == {"state": "cloud"}
    assert "macCallbackId" not in saved
    assert not macfetch.waiting(saved)


def test_try_again_on_a_desktop_job_goes_to_the_mac_again_with_a_clean_slate(store: db.Store, call: Call) -> None:
    job = seed_job(
        store,
        status="failed",
        macCallbackId="cb-old",
        macFetch={"state": "failed", "up": True, "nudgedAt": "2026-11-14T12:01:00.000Z", "uploadId": "up-old"},
    )
    status, _ = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    saved = store.get(job["pk"], job["sk"]) or {}
    assert saved["macFetch"] == {"state": "waiting", "up": True}
    assert "macCallbackId" not in saved


def test_try_again_keeps_a_video_the_mac_already_sent(store: db.Store, call: Call) -> None:
    job = seed_job(store, status="failed", macFetch={"state": "done", "at": "2026-11-14T12:01:00.000Z"})
    status, _ = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert (store.get(job["pk"], job["sk"]) or {})["macFetch"]["state"] == "done"


# --- the notification -----------------------------------------------------------------------------------------


def test_no_mac_after_two_minutes_sends_open_the_app() -> None:
    old = {"jobId": "J", "userId": USER, "status": "running", "macFetch": {"state": "waiting"}}
    new = {**old, "macFetch": {"state": "waiting", "nudgedAt": "2026-11-15T12:02:00.000Z"}}
    assert notify.event_for(old, new) == "mac"
    assert notify.event_for(new, new) != "mac"
    msg = notify.message_for("mac", {**new, "source": {"title": "A video"}})
    assert msg.body == "Open Clip Factory on your Mac to continue."
    assert notify.wanted({"stopped": True}, "mac")
    assert not notify.wanted({"stopped": False}, "mac")
