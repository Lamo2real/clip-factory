"""Reference videos (docs/CONTRACTS.md §45.4 ``references/``, §45.5 ``…/references``, §45.6, §45.28, §45.33):
a presigned multipart upload (100 MB parts, ≤ 2 GB), complete with every part's etag, Analyze as a
``reference_analysis`` job on Lamo Stories' own runtime (its own step track, the one-off override kept on the job
only), the analysis read from S3, rename, the video's own model and effort, the stale-job fence and delete."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api.app import App
from conftest import USER, Clock
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    prefix,
    ws_call,
)

MB = 1024 * 1024
ANALYSIS = {
    "summary": "A car slides on ice and the driver steers out.",
    "hook": {"atSec": 0.8, "what": "the slide starts at once"},
    "pacing": {"cutsPer10s": 4.2, "notes": "fast"},
    "shots": [{"start": 0, "end": 2.1, "what": "slide", "acting": "wide eyes", "sound": "screech"}],
    "gags": ["the coffee survives"],
    "sound": "loud then silent",
    "captions": "two words a line",
    "borrow": ["the silent beat"],
    "avoid": ["the logo"],
}


@pytest.fixture
def runtime(app: App) -> FakeRuntime:
    found = install(app, FakeRuntime())
    assert found is not None
    return found


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime) -> WsCall:
    return ws_call(app)


def _create(wcall: WsCall, size: int = 250 * MB, **body: Any) -> dict[str, Any]:
    status, got = wcall(
        "POST",
        f"{BASE}/references",
        {"filename": "skid.mp4", "contentType": "video/mp4", "size": size, "title": "Skid", **body},
    )
    assert status == 201, got
    return dict(got)


def _upload(wcall: WsCall, s3: FakeS3, size: int = 250 * MB) -> dict[str, Any]:
    created = _create(wcall, size)
    upload_id = created["upload"]["uploadId"]
    parts = [
        {"partNumber": p["partNumber"], "etag": s3.send_part(upload_id, p["partNumber"], b"v")}
        for p in created["upload"]["parts"]
    ]
    status, got = wcall("POST", f"{BASE}/references/{created['reference']['refId']}/complete", {"parts": parts})
    assert status == 200, got
    return dict(got["reference"])


def test_a_multipart_upload_in_100_mb_parts(wcall: WsCall, s3_client: FakeS3, table: FakeTable) -> None:
    created = _create(wcall)
    ref = created["reference"]
    assert (ref["status"], ref["bytes"], ref["durationSec"], ref["currentJobId"]) == ("uploading", 250 * MB, None, None)
    assert ref["ai"] == {"model": None, "effort": None}
    assert "url" not in ref
    parts = created["upload"]["parts"]
    assert [p["partNumber"] for p in parts] == [1, 2, 3]
    item = table.raw(pk(), f"REFVID#{ref['refId']}")
    assert item["key"] == f"{prefix()}references/{ref['refId']}/source.mp4"
    assert s3_client.multipart[created["upload"]["uploadId"]]["key"] == item["key"]
    ops = [(op, p["Key"], p.get("PartNumber"), s) for op, p, s in s3_client.presigned]
    assert ops == [("upload_part", item["key"], n, 6 * 3600) for n in (1, 2, 3)]
    assert leaked([created["reference"], created["upload"]["parts"]]) == []  # the upload id is the contract's own
    upload_id = created["upload"]["uploadId"]
    etags = [{"partNumber": n, "etag": s3_client.send_part(upload_id, n, b"x")} for n in (1, 2, 3)]
    assert wcall("POST", f"{BASE}/references/{ref['refId']}/complete", {"parts": etags[:2]})[0] == 400
    assert wcall("POST", f"{BASE}/references/{ref['refId']}/complete", {"parts": [etags[0]] * 3})[0] == 400
    wrong = [{**etags[0], "etag": '"nope"'}, *etags[1:]]
    status, body = wcall("POST", f"{BASE}/references/{ref['refId']}/complete", {"parts": wrong})
    assert (status, body["error"]["message"]) == (400, "The upload did not finish. Upload the video again.")
    status, body = wcall("POST", f"{BASE}/references/{ref['refId']}/complete", {"parts": list(reversed(etags))})
    assert status == 200
    assert (body["reference"]["status"], body["reference"]["bytes"]) == ("ready", 3)
    assert body["reference"]["url"].startswith("https://")
    assert "uploadId" not in table.raw(pk(), f"REFVID#{ref['refId']}")


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"contentType": "video/webm"}, 400),
        ({"size": 2 * 1024 * MB + 1}, 413),
        ({"size": 0}, 400),
        ({"title": " "}, 400),
        ({"title": "x" * 81}, 400),
        ({"url": "https://youtube.com/watch?v=x"}, 400),
    ],
)
def test_create_validation(wcall: WsCall, body: dict[str, Any], status: int) -> None:
    full = {"filename": "a.mov", "contentType": "video/quicktime", "size": MB, "title": "Skid", **body}
    assert wcall("POST", f"{BASE}/references", full)[0] == status


def test_analyze_starts_a_job_on_lamo_stories_own_runtime(
    wcall: WsCall, runtime: FakeRuntime, s3_client: FakeS3, table: FakeTable
) -> None:
    ref = _upload(wcall, s3_client)
    ref_id = ref["refId"]
    status, body = wcall(
        "POST", f"{BASE}/references/{ref_id}/analyze", {"override": {"model": "fable-5-2", "effort": "max"}}
    )
    assert status == 202
    job = body["job"]
    assert body["reference"]["status"] == "analyzing"
    assert body["reference"]["currentJobId"] == job["jobId"]
    assert (job["contentType"], job["contentId"], job["jobType"], job["status"]) == (
        "reference",
        ref_id,
        "reference_analysis",
        "queued",
    )
    assert [(s["key"], s["label"], s["status"]) for s in job["steps"]] == [
        ("look", "Look at it", "pending"),
        ("listen", "Listen", "pending"),
        ("write", "Write it up", "pending"),
    ]
    assert job["configuration"] == {"run": ["look", "listen", "write"], "from": None, "sceneIds": None, "note": None}
    item = table.raw(pk(), f"PJOB#{job['jobId']}")
    assert item["configuration"]["override"] == {"model": "fable-5-2", "effort": "max"}  # this job only
    assert item["sessionId"].startswith(f"cfstory-{job['jobId']}-")
    assert table.raw(pk(), f"REFVID#{ref_id}")["ai"] == {}  # never saved as the video's setting
    (sent,) = runtime.calls
    assert sent == {
        "action": "process_reference",
        "user_id": USER,
        "workspace_id": "stories",
        "ref_id": ref_id,
        "job_id": job["jobId"],
        "session_id": item["sessionId"],
    }
    assert leaked([body]) == []
    status, again = wcall("POST", f"{BASE}/references/{ref_id}/analyze", {})
    assert (status, again["error"]["message"]) == (409, "This video is being studied already. Wait until it is done.")


def test_analyze_needs_a_finished_upload_and_a_usable_model(wcall: WsCall, s3_client: FakeS3) -> None:
    created = _create(wcall)
    status, body = wcall("POST", f"{BASE}/references/{created['reference']['refId']}/analyze", {})
    assert (status, body["error"]["message"]) == (409, "Wait until the video has finished uploading.")
    ref = _upload(wcall, s3_client)
    assert wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {"override": {"model": "gpt-9"}})[0] == 400
    assert wcall("PATCH", f"{BASE}/agents/video_analysis", {"version": 1, "active": False})[0] == 200
    status, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    assert (status, body["error"]["message"]) == (
        409,
        "Video analysis is switched off. Switch it on in Funded Clips › Settings › Agents.",
    )


def test_a_start_that_fails_fails_the_job_at_once(app: App, s3_client: FakeS3, table: FakeTable) -> None:
    runtime = FakeRuntime()
    runtime.fail = True
    install(app, runtime)
    wcall = ws_call(app)
    ref = _upload(wcall, s3_client)
    status, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    assert status == 202
    assert (body["job"]["status"], body["job"]["error"]) == (
        "failed",
        "Studying the video did not start. Tap Try again.",
    )
    assert body["job"]["steps"][0]["status"] == "failed"
    assert (body["reference"]["status"], body["reference"]["currentJobId"]) == ("failed", None)
    runtime.fail = False
    assert wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})[0] == 202  # Try again


def test_a_job_whose_heartbeat_stopped_is_failed(
    wcall: WsCall, runtime: FakeRuntime, s3_client: FakeS3, clock: Clock, table: FakeTable
) -> None:
    ref = _upload(wcall, s3_client)
    _, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    job_id = body["job"]["jobId"]
    clock.now += timedelta(minutes=2)
    assert wcall("GET", f"{BASE}/references/{ref['refId']}")[1]["reference"]["status"] == "analyzing"
    clock.now += timedelta(minutes=2)
    status, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (status, got["reference"]["status"], got["reference"]["currentJobId"]) == (200, "failed", None)
    job = table.raw(pk(), f"PJOB#{job_id}")
    assert (job["status"], job["error"]) == ("failed", "Studying the video stopped. Tap Try again.")
    assert len(runtime.stopped) == 1


def _analyzed(table: FakeTable, s3: FakeS3, ref_id: str) -> str:
    """The reference as the agent leaves it after a good analysis."""
    key = f"{prefix()}references/{ref_id}/analysis.json"
    s3.objects[key] = json.dumps(ANALYSIS).encode()
    table.items[(pk(), f"REFVID#{ref_id}")].update(
        status="analyzed", analysisKey=key, analyzedWith={"model": "opus-5-5", "effort": "high"}
    )
    return key


def test_a_re_analysis_that_does_not_start_keeps_the_earlier_analysis(
    app: App, s3_client: FakeS3, table: FakeTable
) -> None:
    runtime = FakeRuntime()
    install(app, runtime)
    wcall = ws_call(app)
    ref = _upload(wcall, s3_client)
    _analyzed(table, s3_client, ref["refId"])
    runtime.fail = True
    status, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    assert (status, body["job"]["status"]) == (202, "failed")
    assert (body["reference"]["status"], body["reference"]["currentJobId"]) == ("analyzed", None)
    status, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (got["reference"]["status"], got["analysis"]["summary"]) == ("analyzed", ANALYSIS["summary"])


def test_a_stalled_re_analysis_keeps_the_earlier_analysis(
    wcall: WsCall, runtime: FakeRuntime, s3_client: FakeS3, clock: Clock, table: FakeTable
) -> None:
    ref = _upload(wcall, s3_client)
    _analyzed(table, s3_client, ref["refId"])
    _, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    assert body["reference"]["status"] == "analyzing"
    clock.now += timedelta(minutes=4)  # the job's heartbeat stopped
    _, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (got["reference"]["status"], got["reference"]["currentJobId"]) == ("analyzed", None)
    assert got["analysis"] is not None
    assert table.raw(pk(), f"PJOB#{body['job']['jobId']}")["status"] == "failed"
    # a job that is gone altogether: the same rule
    _, again = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    del table.items[(pk(), f"PJOB#{again['job']['jobId']}")]
    _, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (got["reference"]["status"], got["reference"]["currentJobId"]) == ("analyzed", None)
    item = table.raw(pk(), f"REFVID#{ref['refId']}")
    assert "statusBefore" not in item


def test_get_returns_the_analysis_from_s3(wcall: WsCall, s3_client: FakeS3, table: FakeTable) -> None:
    ref = _upload(wcall, s3_client)
    status, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (status, got["analysis"]) == (200, None)
    key = f"{prefix()}references/{ref['refId']}/analysis.json"
    s3_client.objects[key] = json.dumps(ANALYSIS).encode()
    table.items[(pk(), f"REFVID#{ref['refId']}")].update(
        status="analyzed", analysisKey=key, analyzedWith={"model": "opus-5-5", "effort": "high"}, durationSec=42
    )
    status, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert got["analysis"] == {**ANALYSIS, "hook": {"atSec": 0.8, "what": "the slide starts at once"}}
    assert got["reference"]["analyzedWith"] == {"model": "opus-5-5", "effort": "high"}
    assert got["reference"]["durationSec"] == 42.0
    _, listed = wcall("GET", f"{BASE}/references")
    assert [r["refId"] for r in listed["references"]] == [ref["refId"]]
    assert leaked([got, listed]) == []


def test_rename_and_the_videos_own_model(wcall: WsCall, s3_client: FakeS3, runtime: FakeRuntime) -> None:
    ref = _upload(wcall, s3_client)
    status, body = wcall(
        "PATCH",
        f"{BASE}/references/{ref['refId']}",
        {"title": "Ice skid", "ai": {"model": "sonnet-5-5", "effort": None}},
    )
    assert status == 200
    assert (body["reference"]["title"], body["reference"]["ai"]) == (
        "Ice skid",
        {"model": "sonnet-5-5", "effort": None},
    )
    assert wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"ai": {"model": "gpt-9"}})[0] == 400
    assert wcall("PATCH", f"{BASE}/references/{ref['refId']}", {})[0] == 400


def test_delete_removes_the_files_and_stops_the_job(
    wcall: WsCall, runtime: FakeRuntime, s3_client: FakeS3, table: FakeTable
) -> None:
    ref = _upload(wcall, s3_client)
    _, body = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    s3_client.objects[f"{prefix()}references/{ref['refId']}/frames/0001.jpg"] = b"j"
    assert wcall("DELETE", f"{BASE}/references/{ref['refId']}")[0] == 204
    assert not [k for k in s3_client.objects if f"/references/{ref['refId']}/" in k]
    assert table.raw(pk(), f"REFVID#{ref['refId']}") is None
    assert table.raw(pk(), f"PJOB#{body['job']['jobId']}") is None
    assert len(runtime.stopped) == 1
    assert wcall("GET", f"{BASE}/references/{ref['refId']}")[0] == 404
    created = _create(wcall)
    upload_id = created["upload"]["uploadId"]
    assert wcall("DELETE", f"{BASE}/references/{created['reference']['refId']}")[0] == 204
    assert s3_client.multipart[upload_id]["aborted"] is True


# --- §45.34: the analysis job on the reference's page, and its own setting ----------------------------------------


def test_get_answers_the_analysis_job_so_the_page_shows_each_step_and_the_reason(
    wcall: WsCall, runtime: FakeRuntime, s3_client: FakeS3, table: FakeTable, clock: Clock
) -> None:
    ref = _upload(wcall, s3_client)
    status, got = wcall("GET", f"{BASE}/references/{ref['refId']}")
    assert (status, got["job"]) == (200, None)  # never studied
    _, started = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    job_id = started["job"]["jobId"]
    got = wcall("GET", f"{BASE}/references/{ref['refId']}")[1]
    assert got["job"]["jobId"] == job_id  # the job of currentJobId while it runs
    assert [s["key"] for s in got["job"]["steps"]] == ["look", "listen", "write"]
    assert [s["label"] for s in got["job"]["steps"]] == ["Look at it", "Listen", "Write it up"]
    # the agent fails it with its own reason and clears currentJobId: the newest job is still answered
    reason = "This video is longer than 10 minutes."
    table.items[(pk(), f"PJOB#{job_id}")].update(status="failed", error=reason)
    table.items[(pk(), f"REFVID#{ref['refId']}")].update(status="failed")
    table.items[(pk(), f"REFVID#{ref['refId']}")].pop("currentJobId", None)
    got = wcall("GET", f"{BASE}/references/{ref['refId']}")[1]
    assert (got["job"]["jobId"], got["job"]["status"], got["job"]["error"]) == (job_id, "failed", reason)
    assert leaked([got]) == []
    # a second, newer study is the one shown
    clock.now += timedelta(minutes=1)
    _, again = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    table.items[(pk(), f"PJOB#{again['job']['jobId']}")].update(status="ready")
    table.items[(pk(), f"REFVID#{ref['refId']}")].pop("currentJobId", None)
    assert wcall("GET", f"{BASE}/references/{ref['refId']}")[1]["job"]["jobId"] == again["job"]["jobId"]


def test_an_analysis_jobs_model_records_are_the_same_as_a_storys(
    wcall: WsCall, s3_client: FakeS3, table: FakeTable
) -> None:
    """§45.35 D5: a reference analysis job's ``meta.models`` carries the same exact records (the model id and Region
    really called, the task, ``failed``), and nothing else the agent may keep beside them."""
    ref = _upload(wcall, s3_client)
    _, started = wcall("POST", f"{BASE}/references/{ref['refId']}/analyze", {})
    record = {"step": "look", "agentId": "video_analysis", "task": "reference_analysis", "model": "opus-5-5",
              "modelId": "global.anthropic.claude-opus-5-5", "region": "eu-north-1", "effort": "high",
              "effortApplied": False, "failed": True}  # fmt: skip
    table.items[(pk(), f"PJOB#{started['job']['jobId']}")]["meta"] = {"models": [{**record, "secret": "x"}, "junk"]}
    got = wcall("GET", f"{BASE}/references/{ref['refId']}")[1]
    assert got["job"]["meta"]["models"] == [record]
    assert leaked([got]) == []


def test_another_references_or_a_storys_job_is_never_answered(
    wcall: WsCall, s3_client: FakeS3, table: FakeTable
) -> None:
    ref = _upload(wcall, s3_client)
    other = _upload(wcall, s3_client)
    _, started = wcall("POST", f"{BASE}/references/{other['refId']}/analyze", {})
    table.items[(pk(), f"REFVID#{ref['refId']}")]["currentJobId"] = started["job"]["jobId"]  # a wrong pointer
    table.items[(pk(), "PJOB#01JD000000000000000000STJ")] = {
        "pk": pk(), "sk": "PJOB#01JD000000000000000000STJ", "type": "ws_pjob", "userId": USER,
        "workspaceId": "stories", "jobId": "01JD000000000000000000STJ", "contentType": "animation",
        "contentId": ref["refId"], "status": "ready", "createdAt": "2026-11-15T13:00:00.000Z",
    }  # fmt: skip
    assert wcall("GET", f"{BASE}/references/{ref['refId']}")[1]["job"] is None


def test_patch_takes_a_title_and_the_videos_own_setting_alone_or_together(wcall: WsCall, s3_client: FakeS3) -> None:
    """``patchReference(ws, refId, { title?, ai? })`` (§45.34): "Keep with this video" saves the setting alone."""
    ref = _upload(wcall, s3_client)
    status, body = wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"ai": {"model": "fable-5-2", "effort": "high"}})
    assert (status, body["reference"]["ai"], body["reference"]["title"]) == (
        200,
        {"model": "fable-5-2", "effort": "high"},
        "Skid",
    )
    status, body = wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"title": "  Ice   skid "})
    assert (status, body["reference"]["title"], body["reference"]["ai"]["model"]) == (200, "Ice skid", "fable-5-2")
    status, body = wcall("PATCH", f"{BASE}/references/{ref['refId']}", {"ai": {"model": None, "effort": None}})
    assert body["reference"]["ai"] == {"model": None, "effort": None}
    for bad in ({"ai": {"effort": "turbo"}}, {"title": ""}, {"ai": "fable-5-2"}, {"colour": "red"}):
        assert wcall("PATCH", f"{BASE}/references/{ref['refId']}", bad)[0] == 400, bad
