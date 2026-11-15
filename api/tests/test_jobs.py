from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db, jobs
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.errors import ApiError
from clipfactory_api.jobs import START_FAILED, STEPS, link_platform
from conftest import OTHER, USER, Call, seed_clip, seed_job
from fakes import FakeAgentCore, FakeS3, FakeTable

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


def test_create_link_job(call: Call, table: FakeTable, agentcore: FakeAgentCore) -> None:
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
    (invocation,) = agentcore.calls
    assert invocation["payload"] == {"action": "process_job", "jobId": job["jobId"], "userId": USER}
    assert invocation["runtimeSessionId"] == stored["sessionId"]
    assert invocation["runtimeSessionId"].startswith(f"cfjob-{job['jobId']}-")
    assert len(invocation["runtimeSessionId"]) >= 33


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
def test_create_job_validation(call: Call, body: dict[str, object], agentcore: FakeAgentCore) -> None:
    status, out = call("POST", "/v1/jobs", body)
    assert status == 400
    assert out["error"]["code"] == "bad_request"
    assert agentcore.calls == []


def test_agent_failure_marks_job_failed(call: Call, agentcore: FakeAgentCore) -> None:
    agentcore.fail = True
    status, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": "https://youtu.be/abc"}})
    assert status == 201
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == START_FAILED


def test_agent_not_accepting_marks_job_failed(call: Call, agentcore: FakeAgentCore) -> None:
    agentcore.reply = {"accepted": False}
    _, body = call("POST", "/v1/jobs", {"source": {"type": "link", "url": "https://youtu.be/abc"}})
    assert body["job"]["status"] == "failed"


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


def test_retry_failed_job(call: Call, store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="failed", error="Boom", progress=0.6, clipCount=2)
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
    assert agentcore.calls[-1]["runtimeSessionId"] == stored["sessionId"]
    assert agentcore.calls[-1]["payload"]["action"] == "process_job"
    # The old run may still be alive (watchdog timeout, lost Stop signal): its session is stopped outright.
    assert agentcore.stopped == [job["sessionId"]]


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


def test_start_failure_does_not_touch_a_newer_run(store: db.Store, agentcore: FakeAgentCore, table: FakeTable) -> None:
    job = seed_job(store, status="queued")
    table.items[(job["pk"], job["sk"])]["sessionId"] = NEWER_SESSION  # a later retry already took over
    agentcore.fail = True
    jobs.start(store, AgentClient(agentcore, "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/x"), job, "now")
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


def test_retry_with_agent_down_fails_again(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="canceled")
    agentcore.fail = True
    _, body = call("POST", f"/v1/jobs/{job['jobId']}/retry")
    assert body["job"]["status"] == "failed"
    assert body["job"]["error"] == START_FAILED
