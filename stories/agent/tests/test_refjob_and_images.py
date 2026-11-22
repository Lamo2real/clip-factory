"""The reference-analysis job's runner and fencing (docs/CONTRACTS.md §45.28, §45.33) with a fake ``reference.analyze``
(builder E2's), and the picture helper every model picture goes through (``images.to_model_image``)."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import images
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import Services
from lamostories_agent.refjob import NOT_BUILT, TOO_LONG, ReferenceJob, ReferenceRun
from lamostories_agent.util import UserFacingError
from ls_fakes import PK, USER, WS, FakeModels, FakeTable, data, needs_ffmpeg

FOLDER = f"ws/{USER}/{WS}/references/R1/"
ANALYSIS = {"summary": "A cat falls off a sofa.", "hook": {"atSec": 0.5, "what": "the wobble"}, "shots": [],
            "pacing": {"cutsPer10s": 2, "notes": "quick"}, "gags": ["fall"], "sound": "silence, then a thud",
            "captions": "none", "borrow": ["the wobble before the fall"], "avoid": ["the cat"]}  # fmt: skip


def video(path: Path, seconds: float, size: str = "320x240") -> bytes:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={size}:r=10", "-t", str(seconds),
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)],
        check=True, timeout=300,
    )  # fmt: skip
    return path.read_bytes()


def ref_world(tmp_path: Path, seconds: float = 3.0) -> tuple[Services, Any, FakeTable, FakeModels]:
    table = FakeTable()
    steps = [{"key": k, "label": label, "status": "pending"} for k, label in
             (("look", "Look at it"), ("listen", "Listen"), ("write", "Write it up"))]  # fmt: skip
    table.seed({"pk": PK, "sk": "PJOB#J1", "type": "ws_pjob", "userId": USER, "workspaceId": WS, "jobId": "J1",
                "contentType": "reference", "contentId": "R1", "jobType": "reference_analysis", "status": "queued",
                "steps": steps, "progress": 0, "configuration": {"run": ["look", "listen", "write"]}, "meta": {},
                "sessionId": "S1"})  # fmt: skip
    table.seed({"pk": PK, "sk": "REFVID#R1", "type": "ws_refvid", "userId": USER, "workspaceId": WS, "refId": "R1",
                "title": "Cat", "status": "analyzing", "key": FOLDER + "source.mp4", "currentJobId": "J1",
                "ai": {"model": None, "effort": None}})  # fmt: skip
    d, store = data(table)
    store.objects[FOLDER + "source.mp4"] = (video(tmp_path / "src.mp4", seconds), "video/mp4")
    models = FakeModels({"reference_analysis": ANALYSIS})
    svc = Services(data=d, work_root=tmp_path / "work", models=models, heartbeat_seconds=0.2, flush_seconds=0.05)
    return svc, store, table, models


async def fake_analyze(run: ReferenceRun) -> dict[str, Any]:
    assert run.source.is_file() and run.duration_sec == pytest.approx(3.0, abs=0.2) and run.ref_id == "R1"
    async with run.step("look"):
        run.report(1, 2)
        frame = run.work / "f.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(run.source), "-frames:v", "1", str(frame)], check=True)
        picture = await asyncio.to_thread(run.to_model_image, frame)
        notes = await run.ask(messages=[{"role": "user", "content": [run.image_block(picture), {"text": "Look."}]}])
    async with run.step("listen"):
        pass
    async with run.step("write"):
        assert notes.data == ANALYSIS
    return dict(ANALYSIS)


@needs_ffmpeg
def test_a_reference_is_analyzed_through_its_own_job_and_written_back_fenced(tmp_path: Path) -> None:
    svc, store, table, models = ref_world(tmp_path)
    job = ReferenceJob(svc, JobFence(USER, WS, "J1", "S1"), "R1")
    job.analyze = fake_analyze
    assert asyncio.run(job.run()) == "ready"
    pjob, ref = table.item("PJOB#J1"), table.item("REFVID#R1")
    assert pjob is not None and ref is not None
    assert pjob["status"] == "ready" and [s["status"] for s in pjob["steps"]] == ["done", "done", "done"]
    assert pjob["meta"]["models"] == [{"step": "look", "agentId": "video_analysis", "task": "reference_analysis",
                                       "model": "opus-5-5", "effort": "high", "effortApplied": True}]  # fmt: skip
    assert ref["status"] == "analyzed" and ref["analysisKey"] == FOLDER + "analysis.json" and "currentJobId" not in ref
    assert ref["analyzedWith"] == {"model": "opus-5-5", "effort": "high"}
    assert ref["durationSec"] == pytest.approx(3.0, abs=0.2)
    assert json.loads(store.objects[FOLDER + "analysis.json"][0]) == ANALYSIS
    (call,) = models.calls
    assert call["ctx"].agent_id == "video_analysis" and call["ctx"].job_id == "J1" and call["ctx"].session_id == "S1"
    assert all(k.startswith(FOLDER) for k in [*store.objects, *store.reads])
    for txn in table.txns:  # every write is fenced on the job's session
        ((_kind, first),) = txn[0].items()
        assert first["Key"]["sk"] == "PJOB#J1" and "S1" in first["ExpressionAttributeValues"].values()


@needs_ffmpeg
def test_without_the_analysis_code_the_job_fails_plainly(tmp_path: Path) -> None:
    from lamostories_agent import refjob

    svc, _store, table, _ = ref_world(tmp_path)
    saved = refjob.find_analyze
    refjob.find_analyze = lambda: None  # type: ignore[assignment]
    try:
        assert asyncio.run(ReferenceJob(svc, JobFence(USER, WS, "J1", "S1"), "R1").run()) == "failed"
    finally:
        refjob.find_analyze = saved
    pjob, ref = table.item("PJOB#J1"), table.item("REFVID#R1")
    assert pjob is not None and pjob["error"] == NOT_BUILT and ref is not None and ref["status"] == "failed"
    assert "currentJobId" not in ref  # cleared the same way as on a story: REMOVE


@needs_ffmpeg
def test_a_video_over_ten_minutes_is_refused(tmp_path: Path) -> None:
    svc, store, table, _ = ref_world(tmp_path)
    long = tmp_path / "long.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=s=16x16:r=1", "-t", "605", "-c:v",
                    "libx264", "-preset", "ultrafast", str(long)], check=True, timeout=300)  # fmt: skip
    store.objects[FOLDER + "source.mp4"] = (long.read_bytes(), "video/mp4")
    job = ReferenceJob(svc, JobFence(USER, WS, "J1", "S1"), "R1")
    job.analyze = fake_analyze
    assert asyncio.run(job.run()) == "failed"
    assert table.item("PJOB#J1")["error"] == TOO_LONG  # type: ignore[index]


@needs_ffmpeg
def test_a_superseded_reference_run_writes_nothing(tmp_path: Path) -> None:
    svc, _store, table, models = ref_world(tmp_path)
    before = dict(table.items)
    assert asyncio.run(ReferenceJob(svc, JobFence(USER, WS, "J1", "S-old"), "R1").run()) == "superseded"
    assert table.items == before and models.calls == []


@needs_ffmpeg
def test_every_picture_for_a_model_is_a_small_jpeg_without_its_metadata(tmp_path: Path) -> None:
    big = tmp_path / "big.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=3000x2000", "-frames:v", "1",
                    "-metadata", "comment=secret-gps", str(big)], check=True, timeout=60)  # fmt: skip
    jpeg = images.to_model_image(big)
    assert jpeg[:2] == b"\xff\xd8" and len(jpeg) <= images.MAX_BYTES and b"secret-gps" not in jpeg
    out = tmp_path / "out.jpg"
    out.write_bytes(jpeg)
    dims = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
                           str(out)], capture_output=True, text=True, check=True).stdout.strip()  # fmt: skip
    w, h = (int(x) for x in dims.split(","))
    assert max(w, h) <= images.LONG_EDGE and w / h == pytest.approx(1.5, abs=0.01)
    assert images.image_block(jpeg) == {"image": {"format": "jpeg", "source": {"bytes": jpeg}}}
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not a picture")
    with pytest.raises(UserFacingError) as e:
        images.to_model_image(bad)
    assert str(e.value) == "I can't open that picture. Try a screenshot or a photo."


@needs_ffmpeg
def test_study_only_clears_the_video_once_its_study_is_written_and_a_new_study_says_why_it_cannot(
    tmp_path: Path,
) -> None:
    """§45.34 keepReferences "study_only": after the job writes the study, the video file goes; analysis.json and the
    REFVID# item stay, with the note the reference's page shows."""
    from lamostories_agent import refjob

    svc, store, table, _ = ref_world(tmp_path)
    table.seed({"pk": f"USER#{USER}#WSREG", "sk": f"WS#{WS}", "userId": USER, "workspaceId": WS,
                "workspaceType": "stories", "configuration": {"production": {"keepReferences": "study_only"}}})  # fmt: skip
    job = ReferenceJob(svc, JobFence(USER, WS, "J1", "S1"), "R1")
    job.analyze = fake_analyze
    assert asyncio.run(job.run()) == "ready"
    assert FOLDER + "source.mp4" not in store.objects and FOLDER + "source.mp4" in store.deleted
    assert json.loads(store.objects[FOLDER + "analysis.json"][0]) == ANALYSIS
    ref = table.item("REFVID#R1")
    assert ref is not None and ref["status"] == "analyzed" and ref["sourceRemovedAt"]
    assert ref["note"] == "The video was removed to save space. Its study stays."

    # Analyze again: the job says plainly that the video is gone, and its study stays
    table.seed({**table.items[(PK, "REFVID#R1")], "status": "analyzing", "currentJobId": "J2"})
    table.seed({**table.items[(PK, "PJOB#J1")], "sk": "PJOB#J2", "jobId": "J2", "status": "queued", "sessionId": "S2"})
    again = ReferenceJob(svc, JobFence(USER, WS, "J2", "S2"), "R1")
    again.analyze = fake_analyze
    assert asyncio.run(again.run()) == "failed"
    assert table.item("PJOB#J2")["error"] == refjob.REMOVED  # type: ignore[index]
    assert FOLDER + "analysis.json" in store.objects
