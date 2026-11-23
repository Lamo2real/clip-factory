"""Reference videos from a link (docs/CONTRACTS.md §45.40, ADR-88): ``POST …/references/link`` checks the link with
the allowlist every copy shares (``stories/agent/tests/fixtures/reference_links.json``), puts a ``fetching`` reference
and its ``reference_fetch`` job in one transaction and asks Clips Funded's own runtime to get it
(``fetch_reference``); ``POST …/references/{refId}/fetch`` is its Try again, only from ``fetch_failed``. The stale
fence, the orphan rule, a start that fails, Analyze before the video is here, GET's ``fetchJob`` beside the analysis
``job``, no ``url`` until the file is here, ``link`` public and ``titleFromLink`` never, a rename that keeps the owner's
own name, and a delete while fetching."""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api.app import App
from clipfactory_api.workspaces import reflinks
from conftest import USER, Clock
from fakes import FakeAgentCore, FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    STORIES_ARN,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    prefix,
    seed,
    ws_call,
)

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2] / "stories" / "agent" / "tests" / "fixtures" / "reference_links.json"
    ).read_text("utf-8")
)
GOOD = [c for c in FIXTURE["cases"] if "url" in c]
BAD = [c for c in FIXTURE["cases"] if "why" in c]
TIKTOK = "https://www.tiktok.com/@pip.the.cat/video/7301234567890123456"
MB = 1024 * 1024


@pytest.fixture
def runtime(app: App) -> FakeRuntime:
    found = install(app, FakeRuntime())
    assert found is not None
    return found


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime) -> WsCall:
    return ws_call(app)


def _link(wcall: WsCall, url: str = TIKTOK, **body: Any) -> dict[str, Any]:
    status, got = wcall("POST", f"{BASE}/references/link", {"url": url, **body})
    assert status == 202, got
    return dict(got)


def _arrived(table: FakeTable, s3: FakeS3, ref_id: str, job_id: str, **fields: Any) -> None:
    """What the agent leaves after a good fetch: the file in the reference's folder, ``ready``, no job."""
    s3.objects[f"{prefix()}references/{ref_id}/source.mp4"] = b"v"
    item = table.items[(pk(), f"REFVID#{ref_id}")]
    item.update(status="ready", bytes=24 * MB, durationSec=12.5, fetchedAt="2026-11-15T11:01:00.000Z", **fields)
    item.pop("currentJobId", None)
    item.pop("titleFromLink", None)
    table.items[(pk(), f"PJOB#{job_id}")].update(status="ready", progress=1)


# --- the allowlist ----------------------------------------------------------------------------------------------


def test_the_fixture_is_the_api_s_copy_too() -> None:
    assert FIXTURE["sites"] == reflinks.SITE_NAMES
    assert list(reflinks.PLATFORMS) == FIXTURE["platforms"]
    assert {c["site"] for c in GOOD} == set(reflinks.SITES)
    assert {c["why"] for c in BAD} == set(reflinks.WHYS)
    for c in GOOD:
        assert reflinks.clean_link(c["in"]) == (c["url"], c["site"]), c["in"]
        assert reflinks.clean_link(c["url"]) == (c["url"], c["site"]), c["url"]  # a cleaned link stays as it is
    for c in BAD:
        with pytest.raises(reflinks.LinkRefused) as e:
            reflinks.clean_link(c["in"])
        assert e.value.why == c["why"], c["in"]
    with pytest.raises(reflinks.LinkRefused):
        reflinks.clean_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=" + "a" * 2048)


@pytest.mark.parametrize("case", GOOD, ids=[c["in"][:60] for c in GOOD])
def test_every_good_link_makes_a_fetching_reference(case: dict[str, str], wcall: WsCall, runtime: FakeRuntime) -> None:
    got = _link(wcall, case["in"])
    ref = got["reference"]
    assert (ref["status"], ref["link"], ref["title"]) == (
        "fetching",
        case["url"],
        f"{FIXTURE['sites'][case['site']]} video",
    )
    assert [c["action"] for c in runtime.calls] == ["fetch_reference"]


@pytest.mark.parametrize("case", BAD, ids=[c["in"][:60] or "empty" for c in BAD])
def test_every_bad_link_is_a_400_on_url_with_the_cards_sentence(case: dict[str, str], wcall: WsCall, table: FakeTable,
                                                                 runtime: FakeRuntime) -> None:  # fmt: skip
    status, got = wcall("POST", f"{BASE}/references/link", {"url": case["in"]})
    assert (status, got["error"]["message"], got["error"]["field"]) == (400, reflinks.SENTENCES[case["why"]], "url")
    assert [i for i in table.all() if str(i["sk"]).startswith(("REFVID#", "PJOB#"))] == []
    assert runtime.calls == []


# --- create -----------------------------------------------------------------------------------------------------


def test_a_link_makes_the_reference_and_its_job_in_one_transaction_then_starts_it(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable
) -> None:
    table.calls.clear()
    got = _link(wcall, f"Look! {TIKTOK}?is_from_webapp=1 #fyp")
    ref, job = got["reference"], got["job"]
    assert ref == {
        **ref,
        "status": "fetching",
        "title": "TikTok video",
        "link": TIKTOK,
        "bytes": 0,
        "durationSec": None,
        "currentJobId": job["jobId"],
    }
    assert "url" not in ref  # nothing to play yet
    assert (job["jobType"], job["contentType"], job["contentId"], job["status"]) == (
        "reference_fetch",
        "reference",
        ref["refId"],
        "queued",
    )
    assert job["steps"] == [{"key": "get", "label": "Get the video", "status": "pending"}]
    assert job["configuration"] == {"run": ["get"], "from": None, "sceneIds": None, "note": None}
    (txn,) = [kw for name, kw in table.calls if name == "transact_write_items"]
    puts = sorted(a["Put"]["Item"]["sk"] for a in txn["TransactItems"])
    assert puts == sorted([f"PJOB#{job['jobId']}", f"REFVID#{ref['refId']}"])
    item = table.raw(pk(), f"REFVID#{ref['refId']}")
    assert item["key"] == f"{prefix()}references/{ref['refId']}/source.mp4"
    assert (item["titleFromLink"], item["contentType"]) == (True, "video/mp4")
    stored = table.raw(pk(), f"PJOB#{job['jobId']}")
    (sent,) = runtime.calls
    assert sent == {"action": "fetch_reference", "user_id": USER, "workspace_id": "stories", "ref_id": ref["refId"],
                    "job_id": job["jobId"], "session_id": stored["sessionId"]}  # fmt: skip
    assert stored["sessionId"].startswith(f"cfstory-{job['jobId']}-")
    assert leaked([got]) == []


def test_only_url_and_title_and_the_title_is_the_owners_when_given(wcall: WsCall, table: FakeTable) -> None:
    status, got = wcall("POST", f"{BASE}/references/link", {"url": TIKTOK, "size": 1})
    assert (status, got["error"]["message"]) == (400, "Unknown field: size.")
    assert wcall("POST", f"{BASE}/references/link", {"url": 7})[1]["error"]["field"] == "url"
    assert wcall("POST", f"{BASE}/references/link", {"url": TIKTOK, "title": " "})[1]["error"]["field"] == "title"
    assert wcall("POST", f"{BASE}/references/link", {"url": TIKTOK, "title": "x" * 81})[1]["error"]["field"] == "title"
    got = _link(wcall, title="  Pip   skates ")["reference"]
    assert got["title"] == "Pip skates"
    assert "titleFromLink" not in table.raw(pk(), f"REFVID#{got['refId']}")


def test_the_100_limit_the_same_link_twice_and_three_on_their_way(wcall: WsCall, store: Any) -> None:
    _link(wcall)
    status, got = wcall("POST", f"{BASE}/references/link", {"url": f"{TIKTOK}?lang=en"})
    assert (status, got["error"]["message"]) == (409, "That video is in your list already.")
    _link(wcall, "https://youtu.be/dQw4w9WgXcQ")
    _link(wcall, "https://x.com/pip/status/1")
    status, got = wcall("POST", f"{BASE}/references/link", {"url": "https://www.instagram.com/reel/Cabc/"})
    assert (status, got["error"]["message"]) == (409, "Three videos are on their way already. Wait for one to arrive.")
    for n in range(97):
        seed(store, f"REFVID#01JD00000000000000000{n:05d}", "ws_refvid", refId=f"01JD00000000000000000{n:05d}",
             title="Old", status="ready", key="k", bytes=1)  # fmt: skip
    status, got = wcall("POST", f"{BASE}/references/link", {"url": "https://www.instagram.com/reel/Cabc/"})
    assert (status, got["error"]["message"]) == (409, "You have 100 reference videos already. Delete one first.")


def test_a_start_that_fails_leaves_fetch_failed_and_try_again_starts_it(
    app: App, table: FakeTable, clock: Clock
) -> None:
    runtime = FakeRuntime()
    runtime.fail = True
    install(app, runtime)
    wcall = ws_call(app)
    got = _link(wcall)
    assert (got["job"]["status"], got["job"]["error"]) == ("failed", "Getting the video did not start. Tap Try again.")
    assert got["job"]["steps"][0]["status"] == "failed"
    assert (got["reference"]["status"], got["reference"]["currentJobId"]) == ("fetch_failed", None)
    assert "url" not in got["reference"]
    runtime.fail = False
    clock.now += timedelta(seconds=5)
    status, again = wcall("POST", f"{BASE}/references/{got['reference']['refId']}/fetch", {})
    assert status == 202, again
    assert (again["reference"]["status"], again["job"]["status"]) == ("fetching", "queued")
    assert again["job"]["jobId"] != got["job"]["jobId"]
    assert again["reference"]["currentJobId"] == again["job"]["jobId"]
    assert [c["action"] for c in runtime.calls] == ["fetch_reference", "fetch_reference"]
    status, body = wcall("POST", f"{BASE}/references/{got['reference']['refId']}/fetch", {})
    assert (status, body["error"]["message"]) == (409, "It is getting the video now.")
    assert wcall("POST", f"{BASE}/references/{got['reference']['refId']}/fetch", {"x": 1})[0] == 400


def test_the_same_link_again_after_it_did_not_arrive_says_where_try_again_is(app: App) -> None:
    runtime = FakeRuntime()
    runtime.fail = True
    install(app, runtime)
    wcall = ws_call(app)
    assert _link(wcall)["reference"]["status"] == "fetch_failed"
    status, got = wcall("POST", f"{BASE}/references/link", {"url": TIKTOK})
    assert (status, got["error"]["message"]) == (409, "That one didn't arrive. Tap it in your list, then Try again.")
    assert [c["action"] for c in runtime.calls] == ["fetch_reference"]  # nothing new started


def test_no_runtime_is_the_not_switched_on_sentence(app: App) -> None:
    install(app, None)
    got = _link(ws_call(app))
    assert (got["reference"]["status"], got["job"]["error"]) == (
        "fetch_failed",
        "Clips Funded's AI helper isn't switched on yet.",
    )


def test_a_fetch_whose_heartbeat_stopped_is_fetch_failed(
    wcall: WsCall, runtime: FakeRuntime, clock: Clock, table: FakeTable
) -> None:
    got = _link(wcall)
    ref_id, job_id = got["reference"]["refId"], got["job"]["jobId"]
    clock.now += timedelta(minutes=2)
    assert wcall("GET", f"{BASE}/references/{ref_id}")[1]["reference"]["status"] == "fetching"
    clock.now += timedelta(minutes=2)
    status, body = wcall("GET", f"{BASE}/references/{ref_id}")
    assert (status, body["reference"]["status"], body["reference"]["currentJobId"]) == (200, "fetch_failed", None)
    assert (body["fetchJob"]["status"], body["fetchJob"]["error"]) == (
        "failed",
        "Getting the video stopped. Tap Try again.",
    )
    assert body["job"] is None  # never studied: `job` is the analysis job only
    job = table.raw(pk(), f"PJOB#{job_id}")
    assert (job["status"], job["error"]) == ("failed", "Getting the video stopped. Tap Try again.")
    assert len(runtime.stopped) == 1


def test_a_fetch_whose_job_is_gone_is_fetch_failed(wcall: WsCall, table: FakeTable) -> None:
    got = _link(wcall)
    del table.items[(pk(), f"PJOB#{got['job']['jobId']}")]
    (listed,) = wcall("GET", f"{BASE}/references")[1]["references"]
    assert (listed["status"], listed["currentJobId"]) == ("fetch_failed", None)


def test_analyze_waits_for_the_video(wcall: WsCall, app: App, table: FakeTable, runtime: FakeRuntime) -> None:
    got = _link(wcall)
    ref_id = got["reference"]["refId"]
    status, body = wcall("POST", f"{BASE}/references/{ref_id}/analyze", {})
    assert (status, body["error"]["message"]) == (409, "Wait until the video is here.")
    table.items[(pk(), f"REFVID#{ref_id}")]["status"] = "fetch_failed"
    table.items[(pk(), f"REFVID#{ref_id}")].pop("currentJobId")
    status, body = wcall("POST", f"{BASE}/references/{ref_id}/analyze", {})
    assert (status, body["error"]["message"]) == (409, "Get the video first. Tap Try again.")


def test_fetch_again_only_from_fetch_failed(wcall: WsCall, table: FakeTable, s3_client: FakeS3) -> None:
    got = _link(wcall)
    ref_id = got["reference"]["refId"]
    _arrived(table, s3_client, ref_id, got["job"]["jobId"])
    status, body = wcall("POST", f"{BASE}/references/{ref_id}/fetch", {})
    assert (status, body["error"]["message"]) == (409, "This video is here already.")
    assert wcall("POST", f"{BASE}/references/01JD0000000000000000000000/fetch", {})[0] == 404
    created = wcall("POST", f"{BASE}/references",
                    {"filename": "a.mp4", "contentType": "video/mp4", "size": MB, "title": "Up"})[1]  # fmt: skip
    status, body = wcall("POST", f"{BASE}/references/{created['reference']['refId']}/fetch", {})
    assert (status, body["error"]["message"]) == (409, "This video is here already.")
    assert created["reference"]["link"] is None  # an upload


def test_fetch_again_keeps_the_three_at_once_rule(app: App, table: FakeTable) -> None:
    runtime = FakeRuntime()
    install(app, runtime)
    wcall = ws_call(app)
    runtime.fail = True
    failed = _link(wcall)["reference"]
    runtime.fail = False
    for url in ("https://youtu.be/dQw4w9WgXcQ", "https://x.com/pip/status/1", "https://www.instagram.com/reel/Cabc/"):
        _link(wcall, url)
    status, body = wcall("POST", f"{BASE}/references/{failed['refId']}/fetch", {})
    assert (status, body["error"]["message"]) == (409, "Three videos are on their way already. Wait for one to arrive.")


def test_get_answers_the_fetch_job_beside_the_analysis_job_and_the_file_once_it_is_here(
    wcall: WsCall, table: FakeTable, s3_client: FakeS3, clock: Clock
) -> None:
    got = _link(wcall)
    ref_id, fetch_id = got["reference"]["refId"], got["job"]["jobId"]
    body = wcall("GET", f"{BASE}/references/{ref_id}")[1]
    assert (body["job"], body["fetchJob"]["jobId"], body["fetchJob"]["jobType"]) == (None, fetch_id, "reference_fetch")
    assert "url" not in body["reference"]
    _arrived(table, s3_client, ref_id, fetch_id, title="Pip on ice")
    body = wcall("GET", f"{BASE}/references/{ref_id}")[1]
    assert (body["reference"]["status"], body["reference"]["title"], body["reference"]["bytes"]) == (
        "ready",
        "Pip on ice",
        24 * MB,
    )
    assert body["reference"]["url"].startswith("https://")
    assert body["reference"]["link"] == TIKTOK
    clock.now += timedelta(minutes=1)
    status, started = wcall("POST", f"{BASE}/references/{ref_id}/analyze", {})
    assert status == 202, started
    body = wcall("GET", f"{BASE}/references/{ref_id}")[1]
    assert (body["job"]["jobId"], body["job"]["jobType"]) == (started["job"]["jobId"], "reference_analysis")
    assert (body["fetchJob"]["jobId"], body["fetchJob"]["status"]) == (fetch_id, "ready")
    assert leaked([body, wcall("GET", f"{BASE}/references")[1]]) == []


def test_an_old_analysis_job_without_a_job_type_is_still_the_analysis_job(wcall: WsCall, store: Any) -> None:
    created = wcall("POST", f"{BASE}/references",
                    {"filename": "a.mp4", "contentType": "video/mp4", "size": MB, "title": "Up"})[1]  # fmt: skip
    ref_id = created["reference"]["refId"]
    seed(store, "PJOB#01JD000000000000000000OLD", "ws_pjob", jobId="01JD000000000000000000OLD",
         contentType="reference", contentId=ref_id, status="ready")  # fmt: skip
    body = wcall("GET", f"{BASE}/references/{ref_id}")[1]
    assert (body["job"]["jobId"], body["job"]["jobType"], body["fetchJob"]) == (
        "01JD000000000000000000OLD",
        "reference_analysis",
        None,
    )


def test_a_rename_takes_title_from_link_away(wcall: WsCall, table: FakeTable) -> None:
    ref = _link(wcall)["reference"]
    assert table.raw(pk(), f"REFVID#{ref['refId']}")["titleFromLink"] is True
    status, body = wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"ai": {"model": "opus-5-5", "effort": None}})
    assert status == 200
    assert table.raw(pk(), f"REFVID#{ref['refId']}")["titleFromLink"] is True  # only a rename takes it away
    status, body = wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"title": "Mine"})
    assert (status, body["reference"]["title"]) == (200, "Mine")
    assert "titleFromLink" not in table.raw(pk(), f"REFVID#{ref['refId']}")
    assert leaked([body]) == []


def test_delete_while_fetching_cancels_the_job(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable, s3_client: FakeS3
) -> None:
    got = _link(wcall)
    ref_id, job_id = got["reference"]["refId"], got["job"]["jobId"]
    session = table.raw(pk(), f"PJOB#{job_id}")["sessionId"]
    s3_client.objects[f"{prefix()}references/{ref_id}/get/source.part"] = b"x"
    assert wcall("DELETE", f"{BASE}/references/{ref_id}")[0] == 204
    assert session in runtime.stopped
    assert table.raw(pk(), f"REFVID#{ref_id}") is None
    assert table.raw(pk(), f"PJOB#{job_id}") is None
    assert not [k for k in s3_client.objects if k.startswith(f"{prefix()}references/{ref_id}/")]


def test_the_real_client_sends_fetch_reference_to_clips_funded_s_own_runtime() -> None:
    from clipfactory_api.workspaces import agent

    core = FakeAgentCore()
    client = agent.StoryAgent(core, STORIES_ARN)
    session = "cfstory-01JD0000000000000000000000-abcdefgh"
    client.start_reference_fetch(user_id="u", workspace_id="stories", ref_id="r1", job_id="j1", session_id=session)
    (sent,) = core.calls
    assert sent["agentRuntimeArn"] == STORIES_ARN
    assert sent["payload"] == {"action": "fetch_reference", "userId": "u", "workspaceId": "stories", "refId": "r1",
                               "jobId": "j1"}  # fmt: skip
