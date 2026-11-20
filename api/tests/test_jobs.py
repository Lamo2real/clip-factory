from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db, jobs
from clipfactory_api.errors import ApiError
from clipfactory_api.flow_client import FlowClient
from clipfactory_api.jobs import START_FAILED, STEPS, link_platform
from conftest import JOB_FLOW_ARN, OTHER, USER, Call, seed_clip, seed_job
from fakes import FakeAgentCore, FakeLambda, FakeS3, FakeTable

NEWER_SESSION = "cfjob-01JNEWERRUNSESSIONXXXXXXXX-abcdefgh"


@pytest.mark.parametrize(
    ("url", "platform"),
    [
        ("https://www.youtube.com/watch?v=abc", "youtube"),
        ("https://youtube.com/live/abc", "youtube"),
        ("https://m.youtube.com/watch?v=abc", "youtube"),
        ("https://youtu.be/abc", "youtube"),
        ("youtu.be/abc", "youtube"),
        ("https://www.twitch.tv/videos/123", "twitch"),
        ("https://twitch.tv/somechannel", "twitch"),
        ("https://kick.com/someone/videos/abc", "kick"),
        ("HTTP://KICK.COM/someone", "kick"),
        ("https://clips.twitch.tv/FunnySlugHere", "twitch"),
        ("https://m.twitch.tv/somechannel/clip/FunnySlugHere", "twitch"),
        ("https://m.twitch.tv/videos/123", "twitch"),
        ("https://m.kick.com/someone/clips/abc", "kick"),
        ("https://www.kick.com/video/abc", "kick"),
        ("https://music.youtube.com/watch?v=abc", "youtube"),
        ("https://www.youtube-nocookie.com/embed/abc", "youtube"),
    ],
)
def test_link_platform_accepts(url: str, platform: str) -> None:
    detected, normalised = link_platform(url)
    assert detected == platform
    assert normalised.startswith("https://")


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.com/watch?v=abc",
        "https://youtube.com.evil.com/watch",
        "https://notyoutube.com/watch",
        "https://evil.clips.twitch.tv.example.com/abc",
        "https://m.evil.com/watch?v=abc",
        "ftp://youtube.com/watch?v=abc",
        "https://user:pw@youtube.com/watch?v=abc",
        "https://youtube.com:8443/watch?v=abc",
        "https://youtube.com/",
        "javascript:alert(1)",
        "https://" + "a" * 3000,
    ],
)
def test_link_platform_rejects(url: str) -> None:
    with pytest.raises(ApiError) as e:
        link_platform(url)
    assert e.value.code == "bad_request"


def test_create_link_job(call: Call, table: FakeTable, agentcore: FakeAgentCore, lambda_client: FakeLambda) -> None:
    status, body = call(
        "POST",
        "/v1/jobs",
        {"source": {"type": "link", "url": "https://youtu.be/abc"}, "clipTarget": {"min": 3, "max": 6}, "notes": "#ad"},
    )
    assert status == 201
    job = body["job"]
    assert job["status"] == "queued"
    assert job["source"] == {"type": "link", "platform": "youtube", "url": "https://youtu.be/abc"}
    assert job["clipTarget"] == {"min": 3, "max": 6}
    assert job["notes"] == "#ad"
    assert [s["key"] for s in job["steps"]] == [k for k, _ in STEPS]
    assert all(s["status"] == "pending" for s in job["steps"])
    assert job["progress"] == 0
    assert job["clipCount"] == 0
    assert "sessionId" not in job
    assert "heartbeatAt" not in job
    assert "pk" not in job
    stored = table.raw(db.user_pk(USER), db.job_sk(job["jobId"]))
    assert stored is not None
    assert stored["type"] == "job"
    assert stored["userId"] == USER
    assert stored["flowRun"] == 1
    assert stored["sessionId"].startswith(f"cfjob-{job['jobId']}-")
    assert len(stored["sessionId"]) >= 33
    assert stored["flowExecutionArn"].startswith("arn:aws:lambda:")
    assert "flowRun" not in job
    assert "flowExecutionArn" not in job
    # The API starts the durable job-flow on its alias; it never invokes the agent with process_job itself.
    assert agentcore.calls == []
    (start,) = lambda_client.calls
    assert start["FunctionName"] == JOB_FLOW_ARN
    assert start["InvocationType"] == "Event"
    assert start["DurableExecutionName"] == f"job-{job['jobId']}-1"
    expected = {"jobId": job["jobId"], "run": 1, "sessionId": stored["sessionId"], "userId": USER}
    assert start["Payload"] == json.dumps(expected, sort_keys=True)


def test_create_job_defaults_target_from_settings(call: Call) -> None:
    call("PUT", "/v1/settings", {"clipMin": 2, "clipMax": 4})
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": "https://kick.com/a/videos/b"}})
    assert status == 201
    assert body["job"]["clipTarget"] == {"min": 2, "max": 4}
    assert body["job"]["source"]["platform"] == "kick"


def test_create_upload_job(call: Call, s3_client: FakeS3) -> None:
    key = f"uploads/{USER}/01JABCDEFGHJKMNPQRSTVWXYZ0/stream.mp4"
    s3_client.objects[key] = b"video"
    status, body = call("POST", "/v1/jobs", {"source": {"type": "upload", "key": key, "filename": "stream.mp4"}})
    assert status == 201
    assert body["job"]["source"] == {"type": "upload", "platform": "upload", "key": key, "filename": "stream.mp4"}


def test_upload_job_must_belong_to_caller(call: Call, s3_client: FakeS3) -> None:
    key = f"uploads/{OTHER}/01JABCDEFGHJKMNPQRSTVWXYZ0/stream.mp4"
    s3_client.objects[key] = b"video"
    status, body = call("POST", "/v1/jobs", {"source": {"type": "upload", "key": key, "filename": "x.mp4"}})
    assert status == 400
    assert body["error"]["message"] == "That upload does not belong to you."
    traversal = f"uploads/{USER}/../{OTHER}/x/stream.mp4"
    status, _ = call("POST", "/v1/jobs", {"source": {"type": "upload", "key": traversal}})
    assert status == 400


def test_upload_job_needs_the_object(call: Call) -> None:
    key = f"uploads/{USER}/01JABCDEFGHJKMNPQRSTVWXYZ0/missing.mp4"
    status, body = call("POST", "/v1/jobs", {"source": {"type": "upload", "key": key}})
    assert status == 400
    assert "Upload the video again" in body["error"]["message"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"source": {"type": "link"}},
        {"source": {"type": "dvd"}},
        {"source": {"type": "link", "url": "https://vimeo.com/1"}},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "clipTarget": {"min": 6, "max": 3}},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "clipTarget": {"min": 0, "max": 3}},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "clipTarget": {"min": 1, "max": 11}},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "clipTarget": {"min": True, "max": 3}},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "notes": "x" * 2001},
        {"source": {"type": "link", "url": "https://youtu.be/a"}, "extra": 1},
    ],
)
def test_create_job_validation(call: Call, body: dict[str, object], lambda_client: FakeLambda) -> None:
    status, out = call("POST", "/v1/jobs", body)
    assert status == 400
    assert out["error"]["code"] == "bad_request"
    assert lambda_client.calls == []


def test_flow_start_failure_marks_job_failed(call: Call, lambda_client: FakeLambda) -> None:
    lambda_client.fail = True
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": "https://youtu.be/abc"}})
    assert status == 201
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == START_FAILED == "Could not start. Press Try again."


def test_already_started_job_flow_is_a_no_op(store: db.Store, lambda_client: FakeLambda, table: FakeTable) -> None:
    job = seed_job(store, status="queued", flowRun=3)
    lambda_client.started[f"job-{job['jobId']}-3"] = "{}"  # running with another payload: 409 from Lambda
    out = jobs.start(store, FlowClient(lambda_client, JOB_FLOW_ARN, ""), job, "now")
    assert out["status"] == "queued"
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["status"] == "queued"
    assert "flowExecutionArn" not in stored


def test_flow_start_refuses_an_unqualified_arn(store: db.Store, lambda_client: FakeLambda) -> None:
    job = seed_job(store, status="queued")
    unqualified = JOB_FLOW_ARN.rsplit(":", 1)[0]
    out = jobs.start(store, FlowClient(lambda_client, unqualified, ""), job, "now")
    assert out["status"] == "failed"
    assert lambda_client.calls == []


def test_list_jobs_newest_first_with_cursor(call: Call, store: db.Store) -> None:
    ids = [seed_job(store)["jobId"] for _ in range(5)]
    seed_job(store, user=OTHER)
    status, body = call("GET", "/v1/jobs", query={"limit": "2"})
    assert status == 200
    assert [j["jobId"] for j in body["jobs"]] == ids[::-1][:2]
    assert body["nextCursor"]
    _, page2 = call("GET", "/v1/jobs", query={"limit": "2", "cursor": body["nextCursor"]})
    assert [j["jobId"] for j in page2["jobs"]] == ids[::-1][2:4]
    _, page3 = call("GET", "/v1/jobs", query={"limit": "2", "cursor": page2["nextCursor"]})
    assert [j["jobId"] for j in page3["jobs"]] == ids[:1]
    assert page3["nextCursor"] is None


def test_list_jobs_rejects_bad_limit_and_foreign_cursor(call: Call) -> None:
    assert call("GET", "/v1/jobs", query={"limit": "51"})[0] == 400
    assert call("GET", "/v1/jobs", query={"limit": "x"})[0] == 400
    assert call("GET", "/v1/jobs", query={"cursor": "!!!"})[0] == 400
    from clipfactory_api.db import encode_cursor

    foreign = encode_cursor({"pk": f"USER#{OTHER}", "sk": "JOB#01"})
    assert call("GET", "/v1/jobs", query={"cursor": foreign})[0] == 400
    # Tampered cursors DynamoDB would reject (outside the range, extra attributes) are a 400, not a 500.
    for key in ({"pk": f"USER#{USER}", "sk": "SKILL#x"}, {"pk": f"USER#{USER}", "sk": "JOB#01", "foo": "bar"}):
        status, body = call("GET", "/v1/jobs", query={"cursor": encode_cursor(key)})
        assert status == 400
        assert body["error"]["code"] == "bad_request"


def test_get_job_with_clips_in_rank_order(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store)
    seed_clip(store, s3_client, job_id=job["jobId"], rank=2)
    seed_clip(store, s3_client, job_id=job["jobId"], rank=1)
    seed_clip(store, s3_client, user=OTHER, job_id=job["jobId"], rank=3)  # gsi1 is shared: must be filtered
    status, body = call("GET", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["job"]["jobId"] == job["jobId"]
    assert [c["rank"] for c in body["clips"]] == [1, 2]
    assert body["clips"][0]["videoUrl"].startswith("https://cf-prod-media-123.s3.eu-north-1.amazonaws.com/jobs/")
    assert "videoKey" not in body["clips"][0]


def test_get_job_not_found_and_other_owner(call: Call, store: db.Store) -> None:
    job = seed_job(store, user=OTHER)
    assert call("GET", f"/v1/jobs/{job['jobId']}")[0] == 404
    assert call("GET", "/v1/jobs/not-a-ulid")[0] == 404


def test_cancel_running_job(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="running")
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/cancel")
    assert status == 200
    assert body["job"]["status"] == "canceled"
    assert agentcore.calls[-1]["payload"] == {"action": "cancel", "jobId": job["jobId"]}
    assert agentcore.calls[-1]["runtimeSessionId"] == job["sessionId"]


def test_cancel_survives_agent_failure(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="queued")
    agentcore.fail = True
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/cancel")
    assert status == 200
    assert body["job"]["status"] == "canceled"


@pytest.mark.parametrize("state", ["ready", "failed", "canceled"])
def test_cancel_conflict(call: Call, store: db.Store, state: str) -> None:
    job = seed_job(store, status=state)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/cancel")
    assert status == 409
    assert body["error"]["code"] == "conflict"


def test_retry_failed_job(
    call: Call, store: db.Store, agentcore: FakeAgentCore, lambda_client: FakeLambda, table: FakeTable
) -> None:
    job = seed_job(store, status="failed", error="Boom", progress=0.6, clipCount=2, flowRun=1)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    out = body["job"]
    assert out["status"] == "queued"
    assert "error" not in out
    assert out["progress"] == 0
    assert out["clipCount"] == 0
    assert all(s["status"] == "pending" for s in out["steps"])
    assert len(out["steps"]) == len(STEPS)
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["sessionId"] != job["sessionId"]  # a fresh AgentCore session
    assert stored["flowRun"] == 2
    (start,) = lambda_client.calls
    assert start["DurableExecutionName"] == f"job-{job['jobId']}-2"
    assert json.loads(start["Payload"]) == {
        "jobId": job["jobId"],
        "run": 2,
        "sessionId": stored["sessionId"],
        "userId": USER,
    }
    assert agentcore.calls == []
    # The old run may still be alive (heartbeat timeout, lost Stop signal): its session is stopped outright.
    assert agentcore.stopped == [job["sessionId"]]


def test_try_again_after_a_stop_picks_up_where_it_left_off(call: Call, store: db.Store, table: FakeTable) -> None:
    """docs/CONTRACTS.md §30.6: the same job id (so the same saved moments and clips), pickUp kept, and the note."""
    job = seed_job(
        store,
        status="failed",
        error="Making the clips stopped. Tap Try again to pick up where it left off.",
        pickUp=True,
        resumes=2,
        flowRun=1,
    )
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    out = body["job"]
    assert out["jobId"] == job["jobId"]
    assert out["note"] == "Picking up where it stopped…"
    assert "pickUp" not in out
    assert "resumes" not in out
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert stored["pickUp"] is True
    assert stored["resumes"] == 0
    assert stored["status"] == "queued"
    assert "error" not in stored


def test_try_again_after_a_stop_keeps_the_done_steps_and_the_progress(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    """The owner sees what is true: the steps done before the stop stay done, the stopped step waits again."""
    from clipfactory_api.jobs import new_steps

    steps = new_steps()
    for s in steps[:6]:
        s.update(status="done", message="ok", startedAt="2026-11-19T16:08:00.000Z", finishedAt="2026-11-19T16:20:00Z")
    steps[6].update(status="failed", message="Making the clips stopped.", startedAt="2026-11-19T16:21:00.000Z")
    job = seed_job(store, status="failed", pickUp=True, steps=steps, progress=0.79, flowRun=1)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert [s["status"] for s in stored["steps"]] == ["done"] * 6 + ["pending"] * 4
    assert stored["steps"][0]["message"] == "ok"
    assert "message" not in stored["steps"][6]
    assert "startedAt" not in stored["steps"][6]
    assert float(stored["progress"]) == 0.79
    assert stored["runStartedAt"] == stored["updatedAt"]  # the 8 h budget starts now, not at the old steps
    assert "runStartedAt" not in body["job"]


def test_try_again_after_a_real_failure_starts_over(call: Call, store: db.Store, table: FakeTable) -> None:
    job = seed_job(store, status="failed", error="No clip passed the checklist.", note="old", flowRun=1)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert "note" not in body["job"]
    stored = table.raw(job["pk"], job["sk"])
    assert stored is not None
    assert "pickUp" not in stored
    assert "note" not in stored
    assert stored["progress"] == 0
    assert {s["status"] for s in stored["steps"]} == {"pending"}


def test_retry_starts_even_if_old_session_cannot_be_stopped(
    call: Call, store: db.Store, agentcore: FakeAgentCore, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = seed_job(store, status="canceled")
    agentcore.live_sessions = set()  # the old session is already gone
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert body["job"]["status"] == "queued"

    def broken(**_kw: Any) -> dict[str, Any]:
        raise RuntimeError("boom")

    store.update(job["pk"], job["sk"], {"status": "failed"})
    monkeypatch.setattr(agentcore, "stop_runtime_session", broken)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert body["job"]["status"] == "queued"


def test_start_failure_does_not_touch_a_newer_run(store: db.Store, lambda_client: FakeLambda, table: FakeTable) -> None:
    job = seed_job(store, status="queued")
    table.items[(job["pk"], job["sk"])]["sessionId"] = NEWER_SESSION  # a later retry already took over
    lambda_client.fail = True
    jobs.start(store, FlowClient(lambda_client, JOB_FLOW_ARN, ""), job, "now")
    assert table.raw(job["pk"], job["sk"])["status"] == "queued"  # type: ignore[index]


def test_cancel_conflicts_if_a_retry_replaced_the_run(
    call: Call, store: db.Store, table: FakeTable, agentcore: FakeAgentCore, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = seed_job(store, status="running")
    real_get = db.Store.get

    def get_then_retry(self: db.Store, pk: str, sk: str) -> dict[str, Any] | None:
        item = real_get(self, pk, sk)
        if sk == job["sk"]:
            table.items[(pk, sk)]["sessionId"] = NEWER_SESSION  # a retry lands right after the read
        return item

    monkeypatch.setattr(db.Store, "get", get_then_retry)
    assert call("POST", f"/v1/jobs/{job['jobId']}/cancel")[0] == 409
    assert table.raw(job["pk"], job["sk"])["status"] == "running"  # type: ignore[index]
    assert agentcore.calls == []


@pytest.mark.parametrize("state", ["queued", "running", "ready"])
def test_retry_conflict(call: Call, store: db.Store, state: str) -> None:
    job = seed_job(store, status=state)
    assert call("POST", f"/v1/jobs/{job['jobId']}/retry")[0] == 409


def test_retry_with_lambda_down_fails_again(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    job = seed_job(store, status="canceled")
    lambda_client.fail = True
    _, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == START_FAILED


# --- the ten steps (docs/DECISIONS.md ADR-40) ---------------------------------------------------------------------

TEN_STEPS = [
    ("resolve", "Find the video"),
    ("download", "Get the video"),
    ("transcribe", "Write down the words"),
    ("analyze", "Listen for big moments"),
    ("watch", "Watch the video"),
    ("select", "Pick the best moments"),
    ("render", "Cut the clips"),
    ("checklist", "Check each clip"),
    ("captions", "Write the captions"),
    ("finalize", "Finish up"),
]


def test_a_new_job_has_the_ten_steps_with_their_plain_labels(call: Call) -> None:
    assert list(STEPS) == TEN_STEPS
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": "https://youtu.be/abc"}})
    assert status == 201
    assert [(s["key"], s["label"]) for s in body["job"]["steps"]] == TEN_STEPS
    assert jobs.new_steps()[4] == {"key": "watch", "label": "Watch the video", "status": "pending"}


def test_a_job_saved_with_the_old_nine_steps_still_serialises(call: Call, store: db.Store) -> None:
    old = [
        {"key": k, "label": label, "status": "done", "message": f"{k} done"}
        for k, label in (
            ("resolve", "Check the source"),
            ("download", "Download the source"),
            ("transcribe", "Transcribe the speech"),
            ("analyze", "Scan for big moments"),
            ("select", "Pick the best moments"),
            ("render", "Cut the clips"),
            ("checklist", "Check each clip"),
            ("captions", "Write the captions"),
            ("finalize", "Finish up"),
        )
    ]
    job = seed_job(store, status="ready", steps=old, progress=1, clipCount=6)
    status, body = call("GET", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["job"]["steps"] == old
    assert len(body["job"]["steps"]) == 9
    status, body = call("GET", "/v1/jobs")
    assert status == 200
    assert next(j for j in body["jobs"] if j["jobId"] == job["jobId"])["steps"] == old


def test_retrying_an_old_nine_step_job_gives_it_the_ten_steps(call: Call, store: db.Store) -> None:
    old = [{"key": "resolve", "label": "Check the source", "status": "failed"}]
    job = seed_job(store, status="failed", steps=old, error="Boom", flowRun=1)
    status, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert status == 200
    assert [(s["key"], s["label"]) for s in body["job"]["steps"]] == TEN_STEPS
