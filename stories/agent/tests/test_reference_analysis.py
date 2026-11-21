"""Reference-video analysis on a short generated fixture video, exactly per §45.33's steps: scene detection for the
cuts, frames ≤ 512 px, batches ≤ 20 pictures, a merge call, sound notes only from loudness and silences."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent.reference import analyze, media
from lamostories_agent.reference.analyze import run_reference
from test_tasks_support import PK, USER, WS, FakeImages, FakeModel, reply, services

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs ffmpeg"
)

KEY = f"ws/{USER}/{WS}/references/R1/source.mp4"
PAYLOAD = {"userId": USER, "workspaceId": WS, "refId": "R1", "jobId": "J1"}


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """12 s, 320×568: white, then navy, then a test pattern (cuts at 4 s and 8 s); a tone, 4 s of silence, a loud tone."""
    out = tmp_path_factory.mktemp("fixture") / "ref.mp4"
    graph = (
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];"
        "[3:a]aresample=48000[a0];[4:a]atrim=0:4[a1];[5:a]aresample=48000[a2];[a0][a1][a2]concat=n=3:v=0:a=1[a]"
    )
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=white:s=320x568:d=4:r=30",
        "-f", "lavfi", "-i", "color=c=0x101060:s=320x568:d=4:r=30",
        "-f", "lavfi", "-i", "testsrc2=s=320x568:d=4:r=30",
        "-f", "lavfi", "-i", "sine=f=440:d=4",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=4",
        "-f", "lavfi", "-i", "sine=f=880:d=4,volume=4",
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out),
    ]  # fmt: skip
    subprocess.run(cmd, check=True, timeout=120)
    return out


def size_of(path: Path) -> tuple[int, int]:
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    s = json.loads(done.stdout)["streams"][0]
    return int(s["width"]), int(s["height"])


class SizedImages(FakeImages):
    def __init__(self) -> None:
        super().__init__()
        self.sizes: list[tuple[int, int]] = []

    def __call__(self, path: Path) -> bytes:
        if len(self.sizes) < 4:
            self.sizes.append(size_of(path))
        return super().__call__(path)


def batch_answer(call: dict[str, Any]) -> Any:
    data = json.loads(call["messages"][0]["content"][-1]["text"].split("DATA as JSON:\n", 1)[1])
    return reply(
        data={
            "shots": [
                {"shot": s["shot"], "what": f"shot {s['shot']} happens", "acting": "big eyes"} for s in data["shots"]
            ],
            "gags": [{"atSec": 9.0, "what": "the pattern surprises"}],
            "onScreenText": "none",
            "notes": "steady",
        },
        model="sonnet-5-5",
        effort="high",
    )


def merge_answer(call: dict[str, Any]) -> Any:
    data = json.loads(call["messages"][0]["content"][-1]["text"].split("DATA as JSON:\n", 1)[1])
    return reply(
        data={
            "summary": "Three plain shots and a surprise.",
            "hook": {"atSec": 0.5, "what": "a white flash"},
            "pacingNotes": "a cut every 4 seconds",
            "shots": [{"shot": s["shot"], "what": f"merged {s['shot']}", "acting": "calm"} for s in data["shots"]],
            "gags": ["the pattern appears"],
            "captions": "no captions",
            "borrow": ["the steady rhythm"],
            "avoid": ["the test pattern itself"],
        },
        model="sonnet-5-5",
        effort="high",
    )


def answers(call: dict[str, Any]) -> Any:
    return (
        merge_answer(call) if "Merge these notes" in call["messages"][0]["content"][0]["text"] else batch_answer(call)
    )


def seed(db: Any, **job_extra: Any) -> None:
    db.seed(
        {
            "pk": PK, "sk": "REFVID#R1", "type": "ws_refvid", "userId": USER, "workspaceId": WS, "refId": "R1",
            "title": "Fixture", "status": "analyzing", "key": KEY, "ai": {"model": "sonnet-5-5", "effort": None},
            "currentJobId": "J1", "durationSec": None, "bytes": 1000,
        }
    )  # fmt: skip
    db.seed(
        {
            "pk": PK, "sk": "PJOB#J1", "type": "ws_pjob", "userId": USER, "workspaceId": WS, "jobId": "J1",
            "contentType": "reference", "contentId": "R1", "jobType": "reference_analysis", "status": "queued",
            "sessionId": "cfstory-j1", "heartbeatAt": "2026-11-21T18:00:00.000Z",
            "steps": [
                {"key": "look", "label": "Look at it", "status": "pending"},
                {"key": "listen", "label": "Listen", "status": "pending"},
                {"key": "write", "label": "Write it up", "status": "pending"},
            ],
            "configuration": {"run": [], "from": None, "sceneIds": None, "note": None, "override": {"effort": "high"}},
            "meta": {"writerModel": None, "engineVersion": None},
            **job_extra,
        }
    )  # fmt: skip


def run(svc: Any) -> str:
    return asyncio.run(run_reference(svc, PAYLOAD))


def test_media_reads_the_fixture(clip: Path) -> None:
    info = media.probe("ffprobe", clip)
    assert info.has_video and info.has_audio and abs(info.duration - 12) < 0.2
    cuts = media.cut_times("ffmpeg", clip, info.duration)
    assert [round(c) for c in cuts] == [4, 8]
    loud = media.loudness("ffmpeg", clip)
    assert loud.integrated is not None and loud.momentary
    assert any(3.5 <= s <= 4.5 and 7.5 <= e <= 8.5 for s, e in loud.silences)


def test_shots_frames_and_sound_are_code_not_guesses(tmp_path: Path) -> None:
    shots = analyze.shots_from([4.0, 8.0], 12.0)
    assert shots == [{"start": 0.0, "end": 4.0}, {"start": 4.0, "end": 8.0}, {"start": 8.0, "end": 12.0}]
    assert analyze.cuts_per_10s([4.0, 8.0], 12.0) == 1.67
    assert analyze.steady_rate(10) == 2.0 and analyze.steady_rate(600) == 1.0
    samples = [(i / 4, tmp_path / f"{i}.jpg") for i in range(48)]
    picks = analyze.pick_frames(samples, shots, 12.0)
    starts = [p.at for p in picks if p.why == "start"]
    assert starts == [0.0, 4.0, 8.0]
    assert {p.at for p in picks if p.why == "middle"} == {2.0, 6.0, 10.0}
    assert len(picks) <= 600 and [p.at for p in picks] == sorted(p.at for p in picks)
    long = [(i / 2, tmp_path / f"{i}.jpg") for i in range(1200)]  # 10 minutes at 2 frames a second
    many = analyze.shots_from([float(t) for t in range(2, 600, 2)], 600.0)  # 300 shots
    assert len(analyze.pick_frames(long, many, 600.0)) == 600
    loud = media.Loudness(-16.0, [(t / 10, -12.0 if t < 40 else -70.0) for t in range(80)], [(4.0, 8.0)])
    overall, per_shot = analyze.sound_notes(loud, shots[:2], 8.0)
    assert "can't hear" in overall and "silent stretch" in overall
    assert per_shot[1] == "silent" and per_shot[0].startswith(("loud", "very loud"))
    assert analyze.sound_notes(None, shots, 12.0)[0].startswith("The video has no sound track.")


def test_the_whole_analysis_on_the_fixture(tmp_path: Path, clip: Path) -> None:
    images = SizedImages()
    model = FakeModel(*[answers] * 10)
    svc, db, s3 = services(tmp_path, model, images=images)
    s3.files[KEY] = clip
    seed(db)
    assert run(svc) == "done"

    batches = [c for c in model.calls if "Merge these notes" not in c["messages"][0]["content"][0]["text"]]
    merges = [c for c in model.calls if c not in batches]
    assert len(merges) == 1 and len(batches) >= 2
    sizes = [len([b for m in c["messages"] for b in m["content"] if "image" in b]) for c in batches]
    assert all(1 <= n <= 20 for n in sizes) and sum(sizes) == len(images.paths) <= 600
    assert all(max(w, h) <= 512 for w, h in images.sizes) and images.sizes[0] == (288, 512)
    for c in model.calls:
        assert c["task"] == "reference_analysis" and c["ctx"].agent_id == "video_analysis" and c["ctx"].job_id == "J1"
        assert c["override"] == {"model": "sonnet-5-5", "effort": "high"}  # the job's effort over the reference's model
    firsts = sorted(c["messages"][0]["content"][1]["text"] for c in batches)  # batches run 3 at a time
    assert "Frame at 0.00 s (shot 1, start):" in firsts

    analysis_key = f"ws/{USER}/{WS}/references/R1/analysis.json"
    analysis = json.loads(s3.objects[analysis_key])
    assert set(analysis) == {"summary", "hook", "pacing", "shots", "gags", "sound", "captions", "borrow", "avoid"}
    assert [(s["start"], s["end"]) for s in analysis["shots"]] == [(0.0, 4.0), (4.0, 8.0), (8.0, 12.0)]
    assert analysis["pacing"]["cutsPer10s"] == pytest.approx(1.67, abs=0.05)
    assert analysis["shots"][1]["sound"] == "silent" and analysis["shots"][0]["what"] == "merged 1"
    assert "can't hear" in analysis["sound"]
    assert analysis["hook"] == {"atSec": 0.5, "what": "a white flash"}

    ref = db.get(PK, "REFVID#R1")
    assert ref["status"] == "analyzed" and ref["analysisKey"] == analysis_key and ref["currentJobId"] is None
    assert ref["analyzedWith"] == {"model": "sonnet-5-5", "effort": "high"} and abs(ref["durationSec"] - 12) < 0.2
    job = db.get(PK, "PJOB#J1")
    assert job["status"] == "ready" and job["progress"] == 1.0
    assert [s["status"] for s in job["steps"]] == ["done", "done", "done"]
    assert {(m["step"], m["model"], m["effort"], m["effortApplied"]) for m in job["meta"]["models"]} == {
        ("look", "sonnet-5-5", "high", True),
        ("write", "sonnet-5-5", "high", True),
    }
    assert job["meta"]["engineVersion"] is None  # the API's own meta keys are kept
    assert not any((tmp_path / "work").iterdir())  # the download and frames are cleaned up
    assert all(k.startswith(f"ws/{USER}/{WS}/") for k in s3.reads + s3.writes)
    assert all(pk == PK for _, pk, _ in db.writes)


def test_a_batch_bedrock_refuses_for_size_is_split(tmp_path: Path, clip: Path) -> None:
    def picky(call: dict[str, Any]) -> Any:
        n = len([b for m in call["messages"] for b in m["content"] if "image" in b])
        if n > 10:
            return ClientError({"Error": {"Code": "ValidationException", "Message": "Input is too large"}}, "Converse")
        return answers(call)

    model = FakeModel(*[picky] * 20)
    svc, db, s3 = services(tmp_path, model)
    s3.files[KEY] = clip
    seed(db)
    assert run(svc) == "done"
    answered = [c for c in model.calls if "Merge these notes" not in c["messages"][0]["content"][0]["text"]]
    counts = [len([b for m in c["messages"] for b in m["content"] if "image" in b]) for c in answered]
    assert counts.count(20) == 2  # refused, asked once more, refused again: then split
    assert all(n <= 10 for n in counts if n != 20)


def test_too_long_or_not_a_video_fails_plainly(tmp_path: Path, clip: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    model = FakeModel()
    svc, db, s3 = services(tmp_path, model)
    s3.files[KEY] = clip
    seed(db)
    monkeypatch.setattr(analyze, "MAX_SECONDS", 5.0)
    assert run(svc) == "failed"
    job = db.get(PK, "PJOB#J1")
    assert job["status"] == "failed" and job["error"] == analyze.TOO_LONG and job["steps"][0]["status"] == "failed"
    assert db.get(PK, "REFVID#R1")["status"] == "failed" and model.calls == []
    monkeypatch.setattr(analyze, "MAX_SECONDS", 600.5)
    s3.files.pop(KEY)
    s3.objects[KEY] = b"this is not a video"
    seed(db)
    assert run(svc) == "failed"
    assert db.get(PK, "PJOB#J1")["error"] == analyze.CANT_OPEN


def test_a_failed_reanalysis_keeps_the_old_analysis(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    seed(db)
    db.seed({**db.get(PK, "REFVID#R1"), "analysisKey": f"ws/{USER}/{WS}/references/R1/analysis.json"})
    assert run(svc) == "failed"  # the source is missing
    assert db.get(PK, "REFVID#R1")["status"] == "analyzed"
    assert db.get(PK, "PJOB#J1")["error"] == analyze.NO_VIDEO


def test_a_canceled_job_writes_nothing_more(tmp_path: Path, clip: Path) -> None:
    svc, db, s3 = services(tmp_path, FakeModel())

    def cancel_then_answer(call: dict[str, Any]) -> Any:
        db.seed({**db.get(PK, "PJOB#J1"), "status": "canceled"})
        return answers(call)

    svc.model = FakeModel(*[cancel_then_answer] * 10)
    s3.files[KEY] = clip
    seed(db)
    assert run(svc) == "superseded"
    assert db.get(PK, "PJOB#J1")["status"] == "canceled"
    assert db.get(PK, "REFVID#R1")["status"] == "analyzing"
    assert s3.writes == []


def test_a_job_that_is_not_live_or_not_a_reference_is_skipped(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    seed(db, status="ready")
    assert run(svc) == "skipped"
    seed(db, jobType="produce")
    assert run(svc) == "skipped"
    seed(db, contentId="R9")
    assert run(svc) == "skipped"
    assert db.writes == []
