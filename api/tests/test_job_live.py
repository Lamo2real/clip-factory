"""The live status line (docs/CONTRACTS.md §31): JOBLIVE# items become ``jobLive`` live events with the allowed fields
only, and GET /v1/jobs and /v1/jobs/{id} carry the line of a job that is still working."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api import db, jobs
from clipfactory_api.realtime import broadcast
from conftest import USER, Call, seed_job
from fakes import FakeManagement
from test_realtime import _record


@pytest.fixture
def sent(store: db.Store) -> tuple[broadcast.BroadcastDeps, FakeManagement]:
    store.put({"pk": db.user_pk(USER), "sk": "CONN#c1", "type": "conn", "userId": USER, "connectionId": "c1"})
    store.put({"pk": db.user_pk(USER), "sk": "CONN#c2", "type": "conn", "userId": USER, "connectionId": "c2"})
    management = FakeManagement()
    return broadcast.BroadcastDeps(
        store=store, management=management, deserialize=broadcast._deserializer()
    ), management


LIVE_ONLY = {"jobId", "step", "text", "detail", "tech", "since", "i", "n", "pct", "at", "lastChange", "run"}


def _live(job: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {
        "pk": job["pk"],
        "sk": f"JOBLIVE#{job['jobId']}",
        "type": "jobLive",
        "userId": USER,
        "jobId": job["jobId"],
        "sessionId": job["sessionId"],
        "step": "render",
        "text": "Cutting clip 3 of 10",
        "detail": "0:41 of 0:58",
        "tech": "ffmpeg · 1080x1920 · 30 fps",
        "i": 3,
        "n": 10,
        "at": "2026-11-15T11:59:30.000Z",
        "lastChange": "2026-11-15T11:58:00.000Z",
        "ttl": 1_800_000_000,
        **fields,
    }


def test_public_live_keeps_only_the_allowed_fields_and_hides_the_session() -> None:
    job = {"pk": "USER#u", "jobId": "J1", "sessionId": "cfjob-J1-secret"}
    out = jobs.public_live(_live(job, internal="x", cookies="nope"))
    assert set(out) <= LIVE_ONLY
    for hidden in ("sessionId", "ttl", "pk", "internal", "cookies"):
        assert hidden not in out
    assert out["run"] == jobs.run_tag("cfjob-J1-secret")
    assert len(out["run"]) == 10
    assert "secret" not in str(out)
    assert out["lastChange"] == "2026-11-15T11:58:00.000Z"  # when the words last really changed


def test_broadcast_sends_joblive_as_its_own_type(sent: tuple[broadcast.BroadcastDeps, FakeManagement]) -> None:
    bc_deps, management = sent
    job = {"pk": f"USER#{USER}", "jobId": "J1", "sessionId": "cfjob-J1-s"}
    broadcast.process({"Records": [_record(_live(job), event="INSERT")]}, bc_deps)
    message = management.sent[0][1]
    assert (message["type"], message["op"], message["id"]) == ("jobLive", "upsert", "J1")
    assert set(message["item"]) <= LIVE_ONLY
    assert message["item"]["text"] == "Cutting clip 3 of 10"


def test_broadcast_coalesces_live_lines_to_the_last_one(sent: tuple[broadcast.BroadcastDeps, FakeManagement]) -> None:
    bc_deps, management = sent
    job = {"pk": f"USER#{USER}", "jobId": "J1", "sessionId": "cfjob-J1-s"}
    records = [_record(_live(job, detail=f"0:{40 + k} of 0:58"), seq=str(k)) for k in range(5)]
    broadcast.process({"Records": records}, bc_deps)
    lines = [m for _, m in management.sent if m["type"] == "jobLive"]
    assert len(lines) == 2  # one per connection, the last record only
    assert lines[0]["item"]["detail"] == "0:44 of 0:58"


def test_a_job_record_is_never_read_as_a_live_line() -> None:
    assert broadcast._kind("JOB#J1") == ("job", "J1")
    assert broadcast._kind("JOBLIVE#J1") == ("jobLive", "J1")


def test_get_job_carries_the_live_line_while_it_works(call: Call, store: db.Store) -> None:
    job = seed_job(store)
    store.put(_live(job))
    status, body = call("GET", f"/v1/jobs/{job['jobId']}")
    assert status == 200
    assert body["job"]["live"]["text"] == "Cutting clip 3 of 10"
    assert body["job"]["live"]["run"] == body["job"]["run"]
    assert set(body["job"]["live"]) <= LIVE_ONLY


def test_get_job_drops_a_line_of_another_run_or_an_ended_job(call: Call, store: db.Store) -> None:
    job = seed_job(store)
    store.put(_live(job, sessionId="cfjob-older-run"))
    _, body = call("GET", f"/v1/jobs/{job['jobId']}")
    assert "live" not in body["job"]
    done = seed_job(store, status="ready")
    store.put(_live(done))
    _, body = call("GET", f"/v1/jobs/{done['jobId']}")
    assert "live" not in body["job"]


def test_list_jobs_attaches_lines_only_to_working_jobs(call: Call, store: db.Store) -> None:
    working = seed_job(store, createdAt="2026-11-15T11:00:00.000Z")
    ready = seed_job(store, status="ready", createdAt="2026-11-15T10:00:00.000Z")
    store.put(_live(working))
    store.put(_live(ready))
    status, body = call("GET", "/v1/jobs")
    assert status == 200
    by_id = {j["jobId"]: j for j in body["jobs"]}
    assert by_id[working["jobId"]]["live"]["detail"] == "0:41 of 0:58"
    assert "live" not in by_id[ready["jobId"]]
    assert all("sessionId" not in j for j in body["jobs"])


def test_list_jobs_reads_no_lines_when_nothing_works(call: Call, store: db.Store) -> None:
    seed_job(store, status="ready")
    _, body = call("GET", "/v1/jobs")
    assert all("live" not in j for j in body["jobs"])
