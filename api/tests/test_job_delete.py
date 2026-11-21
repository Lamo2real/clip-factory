"""Deleting jobs (docs/CONTRACTS.md §34): one or several, the clips kept or deleted by choice, the run stopped and
fenced, the files cleaned up, and never another owner's job or a posted clip."""

from __future__ import annotations

import json
from typing import Any

import pytest
from aws_durable_execution_sdk_python import CallbackTimeoutError

from clipfactory_api import db, job_delete
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.flows.job_flow import JobFlowDeps, run_job_flow
from clipfactory_api.vectors import Vectors
from conftest import OTHER, USER, Call, Clock, seed_clip, seed_job
from fakes import FakeAgentCore, FakeCallback, FakeDurableContext, FakeS3, FakeS3Vectors, FakeTable
from test_flows import RUNTIME


def source_files(s3_client: FakeS3, job_id: str) -> list[str]:
    keys = [
        f"jobs/{job_id}/source/audio.m4a",
        f"jobs/{job_id}/source/transcript.json",
        f"jobs/{job_id}/source/moments.json",
        f"jobs/{job_id}/source/render/01/clip.mp4",
        f"jobs/{job_id}/source/picture/part-0001.mp4",
    ]
    for k in keys:
        s3_client.objects[k] = b"x"
    return keys


def under(s3_client: FakeS3, prefix: str) -> list[str]:
    return sorted(k for k in s3_client.objects if k.startswith(prefix))


def test_delete_a_failed_job_removes_it_and_its_files(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store, status="failed", error="We could not find that video.")
    source_files(s3_client, job["jobId"])
    store.put({"pk": db.user_pk(USER), "sk": f"JOBLIVE#{job['jobId']}", "type": "jobLive", "jobId": job["jobId"]})
    store.put({"pk": db.user_pk(USER), "sk": f"NOTIFYSTEP#{job['jobId']}", "jobId": job["jobId"]})
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body == {"jobId": job["jobId"], "deleted": True, "clipsDeleted": 0, "clipsKept": 0}
    assert store.get(job["pk"], job["sk"]) is None
    assert store.get(db.user_pk(USER), f"JOBLIVE#{job['jobId']}") is None
    assert store.get(db.user_pk(USER), f"NOTIFYSTEP#{job['jobId']}") is None
    assert under(s3_client, f"jobs/{job['jobId']}/") == []
    assert call("GET", f"/v1/jobs/{job['jobId']}")[0] == 404
    assert call("GET", "/v1/jobs")[1]["jobs"] == []


def test_delete_is_idempotent(call: Call, store: db.Store) -> None:
    job = seed_job(store, status="ready")
    assert call("DELETE", f"/v1/jobs/{job['jobId']}")[1]["deleted"] is True
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body == {"jobId": job["jobId"], "deleted": False, "clipsDeleted": 0, "clipsKept": 0}


def test_cannot_delete_another_owners_job(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore
) -> None:
    theirs = seed_job(store, user=OTHER, status="running")
    files = source_files(s3_client, theirs["jobId"])
    clip = seed_clip(store, s3_client, user=OTHER, job_id=theirs["jobId"])
    status, body = call("DELETE", f"/v1/jobs/{theirs['jobId']}", query={"clips": "delete"})
    assert status == 200
    assert body["deleted"] is False
    status, body = call("POST", "/v1/jobs/delete", {"jobIds": [theirs["jobId"]], "clips": "delete"})
    assert status == 200
    assert body["results"][0]["deleted"] is False
    assert store.get(theirs["pk"], theirs["sk"]) == theirs  # untouched: not even fenced
    assert store.get(clip["pk"], clip["sk"]) is not None
    assert all(k in s3_client.objects for k in files)
    assert agentcore.stopped == []


def test_delete_checks_its_input(call: Call) -> None:
    assert call("DELETE", "/v1/jobs/not-a-ulid")[0] == 404
    job_id = "01J0000000000000000000000A"
    assert call("DELETE", f"/v1/jobs/{job_id}", query={"clips": "all"})[0] == 400
    assert call("POST", "/v1/jobs/delete", {"jobIds": []})[0] == 400
    assert call("POST", "/v1/jobs/delete", {"jobIds": ["nope"]})[0] == 400
    assert call("POST", "/v1/jobs/delete", {"jobIds": [job_id] * 26})[0] == 400
    assert call("POST", "/v1/jobs/delete", {"jobIds": [job_id], "extra": 1})[0] == 400
    assert call("POST", "/v1/jobs/delete", {"jobIds": [job_id], "clips": "yes"})[0] == 400


@pytest.mark.parametrize("state", ["running", "queued"])
def test_a_working_job_is_stopped_and_fenced_before_it_goes(
    call: Call, store: db.Store, table: FakeTable, agentcore: FakeAgentCore, state: str
) -> None:
    job = seed_job(store, status=state)
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["deleted"] is True
    assert agentcore.stopped == [job["sessionId"]]  # stopped outright, not sent a cancel that would write again
    assert not [c for c in agentcore.calls if c["payload"].get("action") == "cancel"]
    # Before the item went, it was fenced: a new sessionId (and canceled), so the old run's writes failed.
    fences = [kw for name, kw in table.calls if name == "update_item" and kw["Key"]["sk"] == job["sk"]]
    assert fences, "the job is fenced first"
    values = fences[0]["ExpressionAttributeValues"]
    assert "canceled" in values.values()
    assert values[":s0"] != job["sessionId"]  # the new sessionId is set; the old one is only the condition
    assert store.get(job["pk"], job["sk"]) is None


def test_a_deleted_job_is_never_brought_back_by_its_old_run(call: Call, store: db.Store) -> None:
    job = seed_job(store, status="running")
    call("DELETE", f"/v1/jobs/{job['jobId']}")
    # The agent's and the job flow's writes are conditional on the job existing with their sessionId (§13, §14.4).
    with pytest.raises(db.ConditionFailed):
        store.update(job["pk"], job["sk"], {"status": "ready"}, expect_in={"sessionId": [job["sessionId"]]})
    assert store.get(job["pk"], job["sk"]) is None


def test_the_fence_alone_stops_the_old_run(
    app: Any, store: db.Store, agentcore: FakeAgentCore, s3_client: FakeS3
) -> None:
    """A delete that broke after the fence (the files could not be removed) leaves the job canceled with a new
    sessionId: the old run is out, and the next delete finishes the job."""
    job = seed_job(store, status="running")

    def broken(**_: Any) -> dict[str, Any]:
        raise RuntimeError("S3 is down")

    s3_client.list_objects_v2 = broken  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        job_delete.delete_job(app, USER, job["jobId"], review_clips=False)
    left = store.get(job["pk"], job["sk"])
    assert left is not None
    assert left["status"] == "canceled"
    assert left["sessionId"] != job["sessionId"]
    with pytest.raises(db.ConditionFailed):
        store.update(job["pk"], job["sk"], {"status": "ready"}, expect_in={"sessionId": [job["sessionId"]]})
    del s3_client.list_objects_v2
    assert job_delete.delete_job(app, USER, job["jobId"], review_clips=False).deleted is True
    assert store.get(job["pk"], job["sk"]) is None


def test_stop_failing_does_not_block_the_delete(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="running")
    agentcore.fail = True
    assert call("DELETE", f"/v1/jobs/{job['jobId']}")[1]["deleted"] is True
    assert store.get(job["pk"], job["sk"]) is None


def seed_mix(store: db.Store, s3_client: FakeS3, job_id: str) -> dict[str, dict[str, Any]]:
    out = {}
    for rank, state in enumerate(["review", "confirmed", "publishing", "posted", "failed", "declined"], start=1):
        out[state] = seed_clip(store, s3_client, job_id=job_id, rank=rank, status=state)
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.post_sk("P1"),
            "type": "post",
            "postId": "P1",
            "clipId": out["posted"]["clipId"],
            "platform": "youtube",
            "status": "posted",
        }
    )
    return out


def test_keep_review_clips_by_default(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store, status="ready")
    files = source_files(s3_client, job["jobId"])
    mix = seed_mix(store, s3_client, job["jobId"])
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["clipsDeleted"] == 1
    assert body["clipsKept"] == 5
    assert store.get(mix["declined"]["pk"], mix["declined"]["sk"]) is None
    for state in ("review", "confirmed", "publishing", "posted", "failed"):
        clip = mix[state]
        assert store.get(clip["pk"], clip["sk"]) is not None, state
        assert clip["videoKey"] in s3_client.objects, state
        assert clip["coverKey"] in s3_client.objects, state
    assert store.get(db.user_pk(USER), db.post_sk("P1")) is not None
    assert not any(k in s3_client.objects for k in files)
    assert not under(s3_client, f"jobs/{job['jobId']}/clips/{mix['declined']['clipId']}/")
    # A kept clip still works without its job, and still names it (the job page then says it is gone).
    status, got = call("GET", f"/v1/clips/{mix['review']['clipId']}")
    assert status == 200
    assert got["clip"]["jobId"] == job["jobId"]
    assert got["clip"]["videoUrl"]


def test_delete_review_clips_when_asked_but_never_posted_ones(
    call: Call, store: db.Store, s3_client: FakeS3, vectors: Vectors, s3v: FakeS3Vectors
) -> None:
    job = seed_job(store, status="ready")
    mix = seed_mix(store, s3_client, job["jobId"])
    deleted_vectors: list[Any] = []
    s3v_delete = s3v.delete_vectors

    def spy(**kw: Any) -> dict[str, Any]:
        deleted_vectors.extend(kw["keys"])
        return s3v_delete(**kw)

    s3v.delete_vectors = spy  # type: ignore[method-assign]
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}", query={"clips": "delete"})
    assert status == 200
    assert body["clipsDeleted"] == 2
    assert body["clipsKept"] == 4
    review = mix["review"]
    assert store.get(review["pk"], review["sk"]) is None
    assert review["videoKey"] not in s3_client.objects
    assert review["coverKey"] not in s3_client.objects
    assert deleted_vectors == [review["clipId"]]
    for state in ("confirmed", "publishing", "posted", "failed"):
        clip = mix[state]
        assert store.get(clip["pk"], clip["sk"]) is not None, state
        assert clip["videoKey"] in s3_client.objects, state
    assert call("GET", "/v1/clips", query={"status": "review"})[1]["clips"] == []


def test_delete_keeps_campaign_posts_and_what_was_sent_to_content_rewards(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    """A campaign job (§38.14): its posted clips, their posts (with ``campaignId``) and the ``CRSUB#`` items stay,
    so a delete never takes a campaign post down or forgets what was sent. Only the job's own files go, the job's copy
    of the campaign logo among them (the campaign keeps its own under ``campaigns/``)."""
    campaign = "0b5c1f3e-1a2b-4c3d-9e8f-123456789abc"
    job = seed_job(store, status="ready", campaignId=campaign, campaign={"campaignId": campaign, "name": "FaZe Clips"})
    logo = f"jobs/{job['jobId']}/source/campaign-logo.png"
    s3_client.objects[logo] = b"png"
    s3_client.objects[f"campaigns/{USER}/{campaign}/logo-1.png"] = b"png"
    clip = seed_clip(store, s3_client, job_id=job["jobId"], status="posted", campaignId=campaign)
    pk = db.user_pk(USER)
    for platform in ("youtube", "instagram"):
        store.put(
            {
                "pk": pk,
                "sk": db.post_sk(f"P{platform}"),
                "type": "post",
                "postId": f"P{platform}",
                "clipId": clip["clipId"],
                "platform": platform,
                "status": "posted",
                "campaignId": campaign,
                "url": f"https://{platform}.com/p",
            }
        )
        store.put(
            {
                "pk": pk,
                "sk": f"CRSUB#P{platform}",
                "type": "crsub",
                "postId": f"P{platform}",
                "clipId": clip["clipId"],
                "campaignId": campaign,
                "state": "sent",
            }
        )
    store.put({"pk": pk, "sk": f"CAMPAIGN#{campaign}", "type": "campaign", "campaignId": campaign})
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}", query={"clips": "delete"})
    assert status == 200
    assert (body["deleted"], body["clipsKept"]) == (True, 1)
    assert store.get(clip["pk"], clip["sk"]) is not None
    for platform in ("youtube", "instagram"):
        post = store.get(pk, db.post_sk(f"P{platform}"))
        assert post is not None
        assert (post["status"], post["campaignId"]) == ("posted", campaign)
        assert store.get(pk, f"CRSUB#P{platform}") is not None
    assert store.get(pk, f"CAMPAIGN#{campaign}") is not None
    assert clip["videoKey"] in s3_client.objects
    assert logo not in s3_client.objects
    assert f"campaigns/{USER}/{campaign}/logo-1.png" in s3_client.objects


def test_a_review_clip_kept_meanwhile_is_kept(app: Any, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store, status="ready")
    clip = seed_clip(store, s3_client, job_id=job["jobId"])
    real_delete_if = store.delete_if

    def kept_just_now(pk: str, sk: str, expect_in: Any) -> bool:
        store.update(pk, sk, {"status": "confirmed"})  # Keep on the phone, a moment before
        return real_delete_if(pk, sk, expect_in)

    store.delete_if = kept_just_now  # type: ignore[method-assign]
    out = job_delete.delete_job(app, USER, job["jobId"], review_clips=True)
    assert out.clips_deleted == 0
    assert out.clips_kept == 1
    assert (store.get(clip["pk"], clip["sk"]) or {})["status"] == "confirmed"
    assert clip["videoKey"] in s3_client.objects


def test_an_uploaded_video_goes_with_its_job_unless_another_job_uses_it(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    key = f"uploads/{USER}/01J0000000000000000000000U/stream.mp4"
    s3_client.objects[key] = b"video"
    upload = {"type": "upload", "platform": "upload", "key": key, "filename": "stream.mp4"}
    first = seed_job(store, status="failed", source=upload)
    second = seed_job(store, status="ready", source=upload)
    call("DELETE", f"/v1/jobs/{first['jobId']}")
    assert key in s3_client.objects  # the other job still uses it
    call("DELETE", f"/v1/jobs/{second['jobId']}")
    assert key not in s3_client.objects


def test_files_of_other_jobs_and_other_owners_stay(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store, status="failed")
    other = seed_job(store, status="ready")
    source_files(s3_client, job["jobId"])
    kept = source_files(s3_client, other["jobId"])
    s3_client.objects[f"uploads/{OTHER}/x/video.mp4"] = b"v"
    call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert all(k in s3_client.objects for k in kept)
    assert f"uploads/{OTHER}/x/video.mp4" in s3_client.objects


def test_delete_several_at_once(call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore) -> None:
    failed = [seed_job(store, status="failed") for _ in range(3)]
    working = seed_job(store, status="running")
    keep = seed_job(store, status="ready")
    clip = seed_clip(store, s3_client, job_id=failed[0]["jobId"])
    ids = [j["jobId"] for j in [*failed, working]]
    status, body = call("POST", "/v1/jobs/delete", {"jobIds": [*ids, ids[0]], "clips": "delete"})
    assert status == 200
    assert [r["jobId"] for r in body["results"]] == ids  # each once, in order
    assert all(r["deleted"] for r in body["results"])
    assert sum(r["clipsDeleted"] for r in body["results"]) == 1
    assert store.get(clip["pk"], clip["sk"]) is None
    assert working["sessionId"] in agentcore.stopped  # every job's session is stopped, working or not
    listed = call("GET", "/v1/jobs")[1]["jobs"]
    assert [j["jobId"] for j in listed] == [keep["jobId"]]
    assert call("GET", "/v1/me")[1]["counts"]["running"] == 0


@pytest.mark.parametrize(
    "callback",
    [
        FakeCallback(result=json.dumps({"clipCount": 3})),  # the old run says it finished
        FakeCallback(error=CallbackTimeoutError(message="heartbeat timed out")),  # it went quiet: a resume
    ],
)
def test_the_job_flow_never_brings_a_deleted_job_back(
    app: Any, store: db.Store, agentcore: FakeAgentCore, table: FakeTable, callback: FakeCallback
) -> None:
    job = seed_job(store, status="queued")

    def deleted_while_starting(**kw: Any) -> dict[str, Any]:
        agentcore.calls.append(kw)
        job_delete.delete_job(app, USER, job["jobId"], review_clips=False)
        return {"statusCode": 200, "response": json.dumps({"accepted": True}).encode()}

    agentcore.invoke_agent_runtime = deleted_while_starting  # type: ignore[method-assign]
    deps = JobFlowDeps(store=store, agent=AgentClient(agentcore, RUNTIME), clock=Clock())
    event = {"jobId": job["jobId"], "userId": USER, "sessionId": job["sessionId"], "run": 1}
    out = run_job_flow(FakeDurableContext(callback), event, deps)
    assert out["outcome"] == "missing"  # the flow ends on its own, writing nothing
    assert table.raw(job["pk"], job["sk"]) is None
    assert not [k for k in table.items if k[1].endswith(job["jobId"])]


def test_try_again_and_stop_are_refused_while_the_job_is_being_deleted(call: Call, store: db.Store) -> None:
    job = seed_job(store, status="failed", error="x")
    store.update(job["pk"], job["sk"], {"deletingAt": "2026-01-01T00:00:00Z"})
    assert call("POST", f"/v1/jobs/{job['jobId']}/retry")[0] == 409
    running = seed_job(store, status="running")
    store.update(running["pk"], running["sk"], {"deletingAt": "2026-01-01T00:00:00Z"})
    assert call("POST", f"/v1/jobs/{running['jobId']}/cancel")[0] == 409
    left = store.get(job["pk"], job["sk"])
    assert left is not None
    assert left["status"] == "failed"


def test_a_failed_jobs_old_session_is_stopped_too(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    job = seed_job(store, status="failed", error="x")
    assert call("DELETE", f"/v1/jobs/{job['jobId']}")[0] == 200
    assert agentcore.stopped == [job["sessionId"]]


def test_the_session_that_replaced_ours_meanwhile_is_the_one_stopped(
    app: Any, store: db.Store, agentcore: FakeAgentCore
) -> None:
    job = seed_job(store, status="failed", error="x")
    real_get = store.get
    swapped: list[str] = []

    def racing_get(pk: str, sk: str) -> Any:
        item = real_get(pk, sk)
        if sk == job["sk"] and not swapped and item is not None:
            swapped.append("B")  # a Try again lands right after the delete read the job
            store.update(pk, sk, {"sessionId": "session-B"})
        return item

    store.get = racing_get  # type: ignore[method-assign]
    assert job_delete.delete_job(app, USER, job["jobId"], review_clips=False).deleted is True
    assert "session-B" in agentcore.stopped
    assert real_get(job["pk"], job["sk"]) is None


def test_a_clip_missing_from_the_index_keeps_its_video(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    job = seed_job(store, status="ready")
    clip = seed_clip(store, s3_client, job_id=job["jobId"], status="review")
    unindexed = {k: v for k, v in clip.items() if k not in ("gsi1pk", "gsi1sk")}
    store.put(unindexed)  # the index has not caught up with this clip yet
    status, body = call("DELETE", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["clipsKept"] == 0
    assert store.get(clip["pk"], clip["sk"]) is not None
    assert clip["videoKey"] in s3_client.objects
    assert clip["coverKey"] in s3_client.objects


def test_a_job_waiting_for_the_owners_mac_has_its_wait_ended(
    app: Any, store: db.Store, monkeypatch: pytest.MonkeyPatch
) -> None:
    job = seed_job(
        store, status="running", macCallbackId="cb-mac", macFetch={"state": "waiting", "since": "2026-11-15T11:59:00Z"}
    )
    ended: list[str] = []
    monkeypatch.setattr(app.flows, "mac_stopped", lambda cb, kind, msg: ended.append(cb))
    assert job_delete.delete_job(app, USER, job["jobId"], review_clips=False).deleted is True
    assert ended == ["cb-mac"]
    assert store.get(job["pk"], job["sk"]) is None
