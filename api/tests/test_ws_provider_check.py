"""Amazon Nova Reel's "Try it" (docs/CONTRACTS.md §45.35 D2; the owner's second request §6E "Video-generation
providers" and §8 step 4 "Configure the video-generation provider"): ``POST …/providers/nova-reel/check`` →
``202 { job }``, a one-step ``provider_check`` job on Lamo Stories' own runtime (never behind the not-ready guard,
one at a time, fenced like every job), and ``GET …/providers`` shows its newest job on the Nova Reel row."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import jobs, providers
from clipfactory_api.workspaces import types as ws
from conftest import NOW, OTHER, Call, Clock
from fakes import FakeAgentCore, FakeS3
from ws_support import ARN, BASE, USER, WS, caller, install, leaked, pk, seed_item, seed_workspace

CHECK = f"{BASE}/providers/nova-reel/check"


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
    return next(p for p in body["providers"] if p["id"] == "nova-reel")


def test_try_it_starts_one_check_on_lamo_stories_own_runtime(
    call: Call, store: db.Store, agentcore: FakeAgentCore
) -> None:
    status, body = call("POST", CHECK)
    assert status == 202, body
    job = body["job"]
    assert (job["jobType"], job["contentType"], job["contentId"], job["status"]) == (
        "provider_check",
        "provider",
        "nova-reel",
        "queued",
    )
    assert job["steps"] == [{"key": "check", "label": "Try it", "status": "pending"}]
    assert job["configuration"] == {"run": ["check"], "from": None, "sceneIds": None, "note": None}
    assert job["meta"]["providers"] == {"animation": "nova-reel"}
    assert job["progress"] == 0.0
    # the agent's own action, on Lamo Stories' runtime, in its own session
    [sent] = agentcore.calls
    assert sent["agentRuntimeArn"] == ARN
    assert sent["runtimeSessionId"].startswith(f"cfstory-{job['jobId']}-")
    assert sent["payload"] == {
        "action": "provider_check",
        "userId": USER,
        "workspaceId": WS,
        "providerId": "nova-reel",
        "jobId": job["jobId"],
    }
    stored = store.get(pk(), f"PJOB#{job['jobId']}")
    assert stored is not None
    assert (stored["type"], stored["userId"], stored["workspaceId"]) == (ws.TYPE_PJOB, USER, WS)
    assert stored["sessionId"] == sent["runtimeSessionId"]
    assert leaked([body]) == []


def test_try_it_is_never_behind_the_not_ready_guard(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    """Picked and not ready yet, Nova Reel stops videos (§45.34) but can always be tried: that is how it gets ready."""
    _configure(call, providers={"video": "nova-reel"})
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
    assert shown["steps"][0]["status"] == "pending"
    stored = store.get(pk(), f"PJOB#{first['jobId']}")
    assert stored is not None
    assert stored["sessionId"] != agentcore.calls[0]["runtimeSessionId"]  # fenced
    assert agentcore.stopped == [agentcore.calls[0]["runtimeSessionId"]]
    second = call("POST", CHECK)
    assert second[0] == 202
    assert second[1]["job"]["jobId"] != first["jobId"]


def test_the_providers_page_shows_the_newest_try_and_the_proof(
    call: Call, store: db.Store, agentcore: FakeAgentCore
) -> None:
    _, body = call("GET", f"{BASE}/providers")
    rows = {p["id"]: p for p in body["providers"]}
    assert rows["nova-reel"]["check"] is None  # never tried
    assert all("check" not in p for i, p in rows.items() if i != "nova-reel")
    job = call("POST", CHECK)[1]["job"]
    reel = _reel(call)
    assert (reel["check"]["jobId"], reel["check"]["status"], reel["state"]) == (job["jobId"], "queued", "needs_setup")
    # the agent's shot worked: it proved the maker and ended its job
    seed_item(store, "PROVIDER#animation#nova-reel", ws.TYPE_PROVIDER, state="on",
              checkedAt="2026-11-15T12:01:00.000Z")  # fmt: skip
    done = [{"key": "check", "label": "Try it", "status": "done", "finishedAt": "2026-11-15T12:01:00.000Z"}]
    store.update(pk(), f"PJOB#{job['jobId']}", {"status": "ready", "steps": done, "progress": 1.0})
    reel = _reel(call)
    assert (reel["state"], reel["checkedAt"], reel["check"]["status"]) == ("on", "2026-11-15T12:01:00.000Z", "ready")
    assert reel["check"]["progress"] == 1.0
    # now a video may use it
    _configure(call, providers={"video": "nova-reel"})
    assert _reel(call)["state"] == "on"
    # Bedrock's own sentence when a later try failed
    job2 = call("POST", CHECK)[1]["job"]
    refused = "Bedrock says Nova Reel is not enabled for this account in US East (N. Virginia)."
    seed_item(store, "PROVIDER#animation#nova-reel", ws.TYPE_PROVIDER, state="needs_setup", lastError=refused,
              checkedAt="2026-11-15T12:05:00.000Z")  # fmt: skip
    store.update(pk(), f"PJOB#{job2['jobId']}", {"status": "failed", "error": refused})
    reel = _reel(call)
    assert (reel["state"], reel["line"], reel["check"]["error"]) == ("needs_setup", refused, refused)
    assert leaked([reel]) == []


def test_another_owners_check_job_is_never_shown_or_counted(call: Call, store: db.Store) -> None:
    store.put({"pk": pk(), "sk": "PJOB#01J00000000000000000000000", "type": ws.TYPE_PJOB, "userId": OTHER,
               "workspaceId": WS, "jobId": "01J00000000000000000000000", "contentType": "provider",
               "contentId": "nova-reel", "jobType": "provider_check", "status": "queued",
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
    install(app, None, s3_client)  # Lamo Stories' runtime not switched on
    status, body = call("POST", CHECK)
    assert status == 202
    assert (body["job"]["status"], body["job"]["error"]) == ("failed", jobs.CHECK_NOT_SET_UP)
    # a failed start never blocks the next try
    install(app, agentcore, s3_client)
    agentcore.fail = False
    assert call("POST", CHECK)[1]["job"]["status"] == "queued"


def test_try_it_belongs_to_a_lamo_stories_workspace(call: Call, store: db.Store, agentcore: FakeAgentCore) -> None:
    assert call("POST", "/v1/workspaces/clips/providers/nova-reel/check")[0] == 409
    mine = seed_workspace(store)
    assert call("POST", f"/v1/workspaces/{mine}/providers/nova-reel/check", sub=OTHER)[0] == 404
    assert call("POST", f"{BASE}/providers/nova-canvas/check")[0] == 404  # only Nova Reel has Try it
    assert call("POST", CHECK, {"everything": True})[0] == 400
    assert agentcore.calls == []
