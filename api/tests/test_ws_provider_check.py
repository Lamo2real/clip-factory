"""Luma AI Ray2's "Try it" (docs/CONTRACTS.md §45.35 D2, moved from Amazon Nova Reel by §45.37 G7; the owner's second request §6E "Video-generation
providers" and §8 step 4 "Configure the video-generation provider"): ``POST …/providers/luma-ray/check`` →
``202 { job }``, a one-step ``provider_check`` job on Lamo Stories' own runtime (never behind the not-ready guard,
one at a time, fenced like every job), and ``GET …/providers`` shows its newest job on the Luma AI Ray2 row."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import jobs, providers
from clipfactory_api.workspaces import types as ws
from conftest import NOW, OTHER, Call, Clock
from fakes import FakeAgentCore, FakeS3, FakeTable
from test_ws_ai_support import dynamodb_rules  # noqa: F401 (the claim's condition expressions, after each test)
from ws_support import ARN, BASE, USER, WS, caller, install, leaked, pk, seed_item, seed_workspace

CHECK = f"{BASE}/providers/luma-ray/check"


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


def _configure(call: Call, **configuration: Any) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    status, body = call("PATCH", BASE, {"version": version, "configuration": configuration})
    assert status == 200, body


def _reel(call: Call) -> dict[str, Any]:
    status, body = call("GET", f"{BASE}/providers")
    assert status == 200
    return next(p for p in body["providers"] if p["id"] == "luma-ray")


def test_try_it_starts_one_check_on_lamo_stories_own_runtime(
    call: Call, store: db.Store, agentcore: FakeAgentCore
) -> None:
    status, body = call("POST", CHECK)
    assert status == 202, body
    job = body["job"]
    assert (job["jobType"], job["contentType"], job["contentId"], job["status"]) == (
        "provider_check",
        "provider",
        "luma-ray",
        "queued",
    )
    assert job["steps"] == [{"key": "check", "label": "Try it", "status": "pending"}]
    assert job["configuration"] == {"run": ["check"], "from": None, "sceneIds": None, "note": None}
    assert job["meta"]["providers"] == {"animation": "luma-ray"}
    assert job["progress"] == 0.0
    # the agent's own action, on Lamo Stories' runtime, in its own session
    [sent] = agentcore.calls
    assert sent["agentRuntimeArn"] == ARN
    assert sent["runtimeSessionId"].startswith(f"cfstory-{job['jobId']}-")
    assert sent["payload"] == {
        "action": "provider_check",
        "userId": USER,
        "workspaceId": WS,
        "providerId": "luma-ray",
        "jobId": job["jobId"],
    }
    stored = store.get(pk(), f"PJOB#{job['jobId']}")
    assert stored is not None
    assert (stored["type"], stored["userId"], stored["workspaceId"]) == (ws.TYPE_PJOB, USER, WS)
    assert stored["sessionId"] == sent["runtimeSessionId"]
    assert leaked([body]) == []


def test_try_it_is_never_behind_the_not_ready_guard(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    """Picked and not ready yet, Luma AI Ray2 stops videos (§45.34) but can always be tried: that is how it gets ready."""
    _configure(call, providers={"video": "luma-ray"})
    assert _reel(call)["state"] == "needs_setup"
    status, body = call("POST", CHECK, {})
    assert status == 202, body
    assert body["job"]["status"] == "queued"
    # not picked at all, it can be tried too (before the owner switches to it)
    _configure(call, providers={"video": "builtin-2d"})
    store.update(pk(), f"PJOB#{body['job']['jobId']}", {"status": "failed"})
    assert call("POST", CHECK)[0] == 202
    assert len(agentcore.calls) == 2


def test_one_try_at_a_time_and_a_stopped_one_is_fenced(
    call: Call, store: db.Store, agentcore: FakeAgentCore, clock: Clock
) -> None:
    first = call("POST", CHECK)[1]["job"]
    status, body = call("POST", CHECK)
    assert (status, body["error"]["message"]) == (409, providers.CHECK_BUSY)
    assert len(agentcore.calls) == 1  # nothing more was billed
    # its heartbeat stopped: the fence fails it with a plain sentence and a new try starts
    clock.now = NOW + timedelta(minutes=4)
    shown = _reel(call)["check"]
    assert (shown["jobId"], shown["status"], shown["error"]) == (first["jobId"], "failed", jobs.CHECK_STOPPED)
    # its one step says so too: the Luma AI Ray2 row shows the step's sentence (it never ran, so it was pending)
    assert shown["steps"] == [{"key": "check", "label": "Try it", "status": "failed", "message": jobs.CHECK_STOPPED}]
    stored = store.get(pk(), f"PJOB#{first['jobId']}")
    assert stored is not None
    assert stored["sessionId"] != agentcore.calls[0]["runtimeSessionId"]  # fenced
    assert agentcore.stopped == [agentcore.calls[0]["runtimeSessionId"]]
    second = call("POST", CHECK)
    assert second[0] == 202
    assert second[1]["job"]["jobId"] != first["jobId"]


def test_two_taps_at_the_same_moment_start_one_billed_shot(
    call: Call, store: db.Store, table: FakeTable, agentcore: FakeAgentCore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two tabs, or the phone and the Mac, tap Try it together: both read before either wrote. The try is claimed on
    one ``CHECKLOCK#`` item in the same transaction as its job, so the second tap gets 409 and nothing is billed."""
    status, body = call("POST", CHECK)
    assert status == 202, body
    first = body["job"]
    lock = table.raw(pk(), "CHECKLOCK#luma-ray")
    assert lock is not None
    assert (lock["type"], lock["userId"], lock["workspaceId"], lock["checkJobId"]) == (
        ws.TYPE_CHECKLOCK,
        USER,
        WS,
        first["jobId"],
    )
    real_get, real_query = table.get_item, table.query

    def no_jobs_yet(**kw: Any) -> dict[str, Any]:
        if kw["ExpressionAttributeValues"].get(":prefix") == ws.PJOB_SK:
            return {"Items": []}
        return real_query(**kw)

    def no_lock_yet(**kw: Any) -> dict[str, Any]:
        return {} if kw["Key"]["sk"].startswith(ws.CHECKLOCK_SK) else real_get(**kw)

    # the list of jobs does not show the first try yet: the lock names it, so it is still found and counted
    monkeypatch.setattr(table, "query", no_jobs_yet)
    status, body = call("POST", CHECK)
    assert (status, body["error"]["message"]) == (409, providers.CHECK_BUSY)
    # neither the list nor the lock showed it when this tap read: the claim's condition refuses the second try
    monkeypatch.setattr(table, "get_item", no_lock_yet)
    status, body = call("POST", CHECK)
    assert (status, body["error"]["message"]) == (409, providers.CHECK_BUSY)
    monkeypatch.undo()
    assert len(agentcore.calls) == 1  # one 5-second shot
    checks = [i for i in table.all() if i["sk"].startswith(ws.PJOB_SK) and i.get("jobType") == "provider_check"]
    assert [c["jobId"] for c in checks] == [first["jobId"]]
    assert table.raw(pk(), "CHECKLOCK#luma-ray") == lock
    # once that try ended, the next one claims the lock from it
    store.update(pk(), f"PJOB#{first['jobId']}", {"status": "ready"})
    status, body = call("POST", CHECK)
    assert status == 202, body
    assert table.raw(pk(), "CHECKLOCK#luma-ray")["checkJobId"] == body["job"]["jobId"]  # type: ignore[index]
    assert leaked([body, _reel(call)]) == []
    assert "checkJobId" not in json.dumps(_reel(call))


def test_a_lock_without_a_job_never_blocks_trying(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    store.put({"pk": pk(), "sk": "CHECKLOCK#luma-ray", "type": ws.TYPE_CHECKLOCK, "userId": USER,
               "workspaceId": WS, "providerId": "luma-ray"})  # fmt: skip
    assert call("POST", CHECK)[0] == 202
    store.update(pk(), "CHECKLOCK#luma-ray", {"checkJobId": "01J99999999999999999999999"})  # a job that is gone
    for j in store.query_all(pk(), ws.PJOB_SK):
        store.update(pk(), str(j["sk"]), {"status": "failed"})
    assert call("POST", CHECK)[0] == 202
    assert len(agentcore.calls) == 2


def test_the_providers_page_shows_the_newest_try_and_the_proof(
    call: Call, store: db.Store, agentcore: FakeAgentCore
) -> None:
    _, body = call("GET", f"{BASE}/providers")
    rows = {p["id"]: p for p in body["providers"]}
    assert rows["luma-ray"]["check"] is None  # never tried
    assert all("check" not in p for i, p in rows.items() if i not in providers.CHECKABLE)  # Luma, own video
    job = call("POST", CHECK)[1]["job"]
    reel = _reel(call)
    assert (reel["check"]["jobId"], reel["check"]["status"], reel["state"]) == (job["jobId"], "queued", "needs_setup")
    # the agent's shot worked: it proved the maker and ended its job
    seed_item(store, "PROVIDER#animation#luma-ray", ws.TYPE_PROVIDER, state="on",
              checkedAt="2026-11-15T12:01:00.000Z")  # fmt: skip
    done = [{"key": "check", "label": "Try it", "status": "done", "finishedAt": "2026-11-15T12:01:00.000Z"}]
    store.update(pk(), f"PJOB#{job['jobId']}", {"status": "ready", "steps": done, "progress": 1.0})
    reel = _reel(call)
    assert (reel["state"], reel["checkedAt"], reel["check"]["status"]) == ("on", "2026-11-15T12:01:00.000Z", "ready")
    assert reel["check"]["progress"] == 1.0
    # now a video may use it
    _configure(call, providers={"video": "luma-ray"})
    assert _reel(call)["state"] == "on"
    # Bedrock's own sentence when a later try failed
    job2 = call("POST", CHECK)[1]["job"]
    refused = "Bedrock says Luma AI Ray2 is not enabled for this account in US West (Oregon)."
    seed_item(store, "PROVIDER#animation#luma-ray", ws.TYPE_PROVIDER, state="needs_setup", lastError=refused,
              checkedAt="2026-11-15T12:05:00.000Z")  # fmt: skip
    store.update(pk(), f"PJOB#{job2['jobId']}", {"status": "failed", "error": refused})
    reel = _reel(call)
    assert (reel["state"], reel["line"], reel["check"]["error"]) == ("needs_setup", refused, refused)
    assert leaked([reel]) == []


def test_another_owners_check_job_is_never_shown_or_counted(call: Call, store: db.Store) -> None:
    store.put({"pk": pk(), "sk": "PJOB#01J00000000000000000000000", "type": ws.TYPE_PJOB, "userId": OTHER,
               "workspaceId": WS, "jobId": "01J00000000000000000000000", "contentType": "provider",
               "contentId": "luma-ray", "jobType": "provider_check", "status": "queued",
               "heartbeatAt": NOW.isoformat(), "createdAt": NOW.isoformat()})  # fmt: skip
    assert _reel(call)["check"] is None
    assert call("POST", CHECK)[0] == 202


def test_a_runtime_that_is_off_or_refuses_fails_the_try_with_a_plain_sentence(
    app: App, call: Call, agentcore: FakeAgentCore, s3_client: FakeS3
) -> None:
    agentcore.fail = True
    status, body = call("POST", CHECK)
    assert status == 202
    assert (body["job"]["status"], body["job"]["error"]) == ("failed", jobs.CHECK_NOT_STARTED)
    # the sentence is on the job's one step as well, which is what the Luma AI Ray2 row reads (§45.35 D2)
    failed = {"key": "check", "label": "Try it", "status": "failed", "message": jobs.CHECK_NOT_STARTED}
    assert body["job"]["steps"] == [failed]
    assert _reel(call)["check"]["steps"] == [failed]
    install(app, None, s3_client)  # Lamo Stories' runtime not switched on
    status, body = call("POST", CHECK)
    assert status == 202
    assert (body["job"]["status"], body["job"]["error"]) == ("failed", jobs.CHECK_NOT_SET_UP)
    assert body["job"]["steps"] == [{**failed, "message": jobs.CHECK_NOT_SET_UP}]
    assert _reel(call)["check"]["steps"][0]["message"] == jobs.CHECK_NOT_SET_UP  # this try's sentence, not an older one
    # a failed start never blocks the next try
    install(app, agentcore, s3_client)
    agentcore.fail = False
    assert call("POST", CHECK)[1]["job"]["status"] == "queued"


def test_try_it_belongs_to_a_lamo_stories_workspace(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    assert call("POST", "/v1/workspaces/clips/providers/luma-ray/check")[0] == 409
    mine = seed_workspace(store)
    assert call("POST", f"/v1/workspaces/{mine}/providers/luma-ray/check", sub=OTHER)[0] == 404
    assert call("POST", f"{BASE}/providers/stability/check")[0] == 404  # only Luma AI Ray2 has Try it
    # §45.37 G7: Amazon Nova Reel's old Try it (and Nova Canvas) answers with its ended sentence, and calls nothing
    for ended, word in (("nova-reel", "video"), ("nova-canvas", "picture")):
        status, body = call("POST", f"{BASE}/providers/{ended}/check")
        assert status == 409
        assert body["error"]["message"].endswith(f"Pick another {word} maker in Lamo Stories › Settings › Video.")
        assert "was ended by Amazon on 30 Sep 2026" in body["error"]["message"]
    assert call("POST", CHECK, {"everything": True})[0] == 400
    assert agentcore.calls == []
