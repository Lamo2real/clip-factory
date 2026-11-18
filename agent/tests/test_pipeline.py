from __future__ import annotations

from pathlib import Path

from clipfactory_agent.captions import FIELDS
from clipfactory_agent.checklist import Candidate, Item
from clipfactory_agent.pipeline import JobState, clip_item
from clipfactory_agent.render import RenderResult

from .conftest import make_moment


def state(**job: object) -> JobState:
    st = JobState(job_id="01JOB", user_id="user-1", workdir=Path("/tmp/x"))
    st.job = {"notes": "Clips 15-30 seconds #GTA6", **job}
    st.settings = {"clipMin": 4, "clipMax": 8}
    return st


def test_job_state_targets() -> None:
    assert state(clipTarget={"min": 5, "max": 10}).clip_target == (5, 10)
    assert state(clipTarget={"min": 12, "max": 3}).clip_target == (10, 10)
    assert state().clip_target == (4, 8)  # settings when the job has none
    assert state().length == (15, 30)
    assert state().key("words.json") == "jobs/01JOB/source/words.json"


def test_clip_item_matches_the_contract() -> None:
    st = state()
    st.captions = {"01CLIP": dict.fromkeys(FIELDS, "x")}
    r = RenderResult(Path("clip.mp4"), Path("cover.jpg"), 27.4, [(100, 127.4)], [], "facecam_top", True)
    c = Candidate(make_moment(score=7.6), r, [Item("hear", "What do they hear?", True, "Loud.")], ["Moved the start."])
    item = clip_item(st, c, "01CLIP", 2, "jobs/01JOB/clips/01CLIP/", "youtube", "https://www.youtube.com/watch?v=abc")
    assert item["pk"] == "USER#user-1" and item["sk"] == "CLIP#01CLIP"
    assert item["gsi1pk"] == "JOB#01JOB" and item["gsi1sk"] == "CLIP#002"
    assert item["type"] == "clip" and item["status"] == "review" and item["rank"] == 2
    assert item["score"] == 8 and item["layout"] == "facecam_top" and item["momentType"] == "rage"
    assert item["sourceUrlAt"] == "https://www.youtube.com/watch?v=abc&t=100s"
    assert item["videoKey"] == "jobs/01JOB/clips/01CLIP/clip.mp4" and item["coverKey"].endswith("cover.jpg")
    assert item["checklist"] == {
        "items": [{"key": "hear", "label": "What do they hear?", "pass": True, "note": "Loud."}],
        "fixes": ["Moved the start."],
    }
    assert "videoUrl" not in item and "coverUrl" not in item  # the API adds presigned URLs
    upload = clip_item(st, c, "01CLIP", 1, "p/", "upload", "")
    assert "sourceUrlAt" not in upload


# --- the whole pipeline with fakes: ten steps, and every way the deep analysis can be missing (ADR-40) -----------

import asyncio  # noqa: E402
import json  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402

from clipfactory_agent import loudness, proc, sources  # noqa: E402
from clipfactory_agent import picture as picture_mod  # noqa: E402
from clipfactory_agent import pipeline as pipeline_mod  # noqa: E402
from clipfactory_agent import signals as signals_mod  # noqa: E402
from clipfactory_agent import verify as verify_mod  # noqa: E402
from clipfactory_agent.bedrock import Bedrock  # noqa: E402
from clipfactory_agent.checklist import Measured  # noqa: E402
from clipfactory_agent.config import Config  # noqa: E402
from clipfactory_agent.jobs import STEPS, Tracker, run_job  # noqa: E402
from clipfactory_agent.pipeline import ALMOST_NO_SPEECH, MOTION_ONLY, NOT_WATCHED, Pipeline  # noqa: E402
from clipfactory_agent.util import JobCanceled, JobSuperseded  # noqa: E402

from .deep_support import JPEG, ToolClient, client_error, event  # noqa: E402

SECONDS = 600.0
GB = 1024**3


class MemStore:
    """S3 and the Job item in memory."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.job: dict[str, Any] = {
            "jobId": "J",
            "status": "queued",
            "source": {"type": "link", "url": "https://www.youtube.com/watch?v=abc"},
            "clipTarget": {"min": 2, "max": 3},
        }
        self.clips: list[dict[str, Any]] = []
        self.writes: list[dict[str, Any]] = []
        self.fail_put: str | None = None

    async def get_job(self, user_id: str, job_id: str) -> dict[str, Any]:
        return self.job

    async def get_settings(self, user_id: str) -> dict[str, Any]:
        return {"maxSourceHours": 6}

    async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
        self.writes.append(json.loads(json.dumps(fields)))
        return True

    async def job_clips(self, job_id: str) -> list[dict[str, Any]]:
        return []

    async def skill_rows(self, user_id: str) -> list[dict[str, Any]]:
        return []

    async def latest_learnings(self, user_id: str, n: int = 10) -> list[dict[str, Any]]:
        return []

    async def exists(self, key: str) -> bool:
        return key in self.files

    async def get_bytes(self, key: str) -> bytes:
        return self.files[key]

    async def get_json(self, key: str) -> Any:
        return json.loads(self.files[key])

    async def put_json(self, key: str, value: Any) -> None:
        if self.fail_put and self.fail_put in key:
            raise OSError("S3 is down")
        self.files[key] = json.dumps(value).encode()

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        self.files[key] = Path(path).read_bytes()

    async def download(self, key: str, path: Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(self.files[key])

    async def copy(self, src: str, dest: str) -> None:
        self.files[dest] = self.files[src]

    async def tag_temporary(self, key: str) -> None:
        pass

    async def delete_keys(self, keys: Any) -> None:
        pass

    async def put_clip(self, item: dict[str, Any], fence: Any = None) -> None:
        self.clips.append(item)

    def presign(self, key: str, seconds: int = 3600) -> str:
        return f"https://s3.test/{key}"

    def json(self, name: str) -> Any:
        return json.loads(self.files[f"jobs/J/source/{name}"])

    def has(self, name: str) -> bool:
        return f"jobs/J/source/{name}" in self.files


def transcript_doc(words: int = 60, speakers: bool = True) -> dict[str, Any]:
    items = [
        {
            "type": "pronunciation",
            "start_time": str(100 + i * 2),
            "end_time": str(100.4 + i * 2),
            "alternatives": [{"content": f"w{i}"}],
        }
        for i in range(words)
    ]
    results: dict[str, Any] = {"items": items}
    if speakers:
        results["speaker_labels"] = {
            "segments": [
                {"start_time": "100.0", "end_time": "160.0", "speaker_label": "spk_0"},
                {"start_time": "160.0", "end_time": "220.4", "speaker_label": "spk_1"},
            ]
        }
    return {"results": results}


class FakeTranscriber:
    def __init__(self, store: MemStore, doc: dict[str, Any]) -> None:
        self.store, self.doc, self.runs = store, doc, 0

    async def run(self, name: str, media_key: str, out_key: str, **kw: Any) -> dict[str, Any]:
        self.runs += 1
        self.kw = kw
        self.store.files[out_key] = json.dumps(self.doc).encode()
        return {"LanguageCode": "en-US"}

    async def stop(self, name: str) -> None:
        pass


INFO = {
    "title": "Big stream",
    "channel": "Streamer",
    "duration": SECONDS,
    "webpage_url": "https://www.youtube.com/watch?v=abc",
    "formats": [
        {
            "format_id": "135",
            "height": 480,
            "fps": 30,
            "vcodec": "avc1.4d401e",
            "acodec": "none",
            "filesize": 50_000_000,
        }
    ],
}


class World:
    """One job's fakes. Each test changes one thing and runs every step."""

    def __init__(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **cfg: Any) -> None:
        self.tmp = tmp_path
        self.store = MemStore()
        self.transcriber = FakeTranscriber(self.store, transcript_doc())
        self.fable = ToolClient(
            {
                "report_scenes": lambda kw: {"scene": "a chase", "events": [event(110, 114, intensity=9)]},
                "check_moment": self.check_moment,
            }
        )
        self.nova = ToolClient({"report_scenes": lambda kw: {"scene": "x", "events": [event(10, 14, kind="stunt")]}})
        self.briefs: list[Any] = []
        self.picture_downloads = 0
        self.prepares = 0
        self.info = dict(INFO)
        self.free = 100 * GB
        self.prepare_error: Exception | None = None
        self.prepare_delay = 0.0
        self.download_error: Exception | None = None
        self.motion = [0.01] * int(SECONDS)
        builtin = tmp_path / "builtin"
        (builtin / "playbook").mkdir(parents=True)
        (builtin / "playbook" / "SKILL.md").write_text("---\nname: playbook\n---\nCore")
        self.cfg = Config(
            region="eu-north-1",
            table="t",
            bucket="b",
            model_id="global.anthropic.claude-fable-5-1",
            skills_dir=builtin,
            work_root=tmp_path / "work",
            **{"watch_model_id": "eu.amazon.nova-2-lite-v1:0", **cfg},
        )
        self.patch(monkeypatch)

    def check_moment(self, kw: dict[str, Any]) -> dict[str, Any]:
        text = kw["messages"][0]["content"][-2]["text"]
        start = float(text.split("start: ")[1].split(" s")[0])
        end = float(text.split("end: ")[1].split(" s")[0])
        return {
            "keep": True,
            "start": start,
            "end": end,
            "payoff_at": end - 2,
            "peak_at": start + 10,
            "hook_ok": True,
            "new_hook": None,
            "picture_score": 8,
            "seen": "a crash",
        }

    def patch(self, mp: pytest.MonkeyPatch) -> None:
        async def video_info(url: str, cookies: Any = None) -> dict[str, Any]:
            return self.info

        async def download_audio(url: str, dest: Path, **kw: Any) -> Path:
            (dest / "audio.m4a").write_bytes(b"audio")
            return dest / "audio.m4a"

        async def download_picture(url: str, format_id: str, dest: Path, **kw: Any) -> Path:
            self.picture_downloads += 1
            if self.download_error:
                raise self.download_error
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"small video")
            return dest

        async def probe(src: str) -> proc.MediaInfo:
            if "part-" in src:
                return proc.MediaInfo(300.0, 768, 432, False, True, 2.0)
            return proc.MediaInfo(SECONDS, 1920, 1080, True, True, 30.0)

        async def prepare(src: str, out: Path, **kw: Any) -> Any:
            self.prepares += 1
            if self.prepare_delay:
                await asyncio.sleep(self.prepare_delay)
            if self.prepare_error:
                raise self.prepare_error
            out.mkdir(parents=True, exist_ok=True)
            files = [out / "part-0000.mp4", out / "part-0001.mp4"]
            for f in files:
                f.write_bytes(b"part")
            return files, list(self.motion), list(self.motion)

        async def grab_frames(part: Path, t0: float, t1: float, out_dir: Path) -> list[tuple[float, bytes]]:
            n = int((t1 - picture_mod.grid(t0)) * 2)
            return [(picture_mod.grid(t0) + j / 2, JPEG) for j in range(max(0, n))]

        async def measure_loudness(audio: Path, workdir: Path) -> list[float]:
            loud = [-40.0] * int(SECONDS)
            loud[112] = -10.0
            return loud

        async def find_moments(b: Any, **kw: Any) -> Any:
            self.briefs.append(b)
            chosen = [make_moment(start=100, end=130), make_moment(start=300, end=330, payoff_at=328, peak_at=320)]
            return chosen, [make_moment(start=450, end=480, payoff_at=478, peak_at=470)]

        async def render_clip(m: Any, *, workdir: Path, **kw: Any) -> RenderResult:
            workdir.mkdir(parents=True, exist_ok=True)
            (workdir / "clip.mp4").write_bytes(b"clip")
            (workdir / "cover.jpg").write_bytes(b"cover")
            caps = [{"t0": 0.0, "t1": 1.0, "text": "w1 w2"}]
            return RenderResult(
                workdir / "clip.mp4", workdir / "cover.jpg", 30.0, [(m.start, m.end)], caps, "blur_fill", False
            )

        async def measure(video: Path) -> Measured:
            return Measured(-10.0, 5.0)

        mp.setattr(sources, "video_info", video_info)
        mp.setattr(sources, "download_audio", download_audio)
        mp.setattr(sources, "download_picture", download_picture)
        mp.setattr(proc, "probe", probe)
        mp.setattr(picture_mod, "prepare", prepare)
        mp.setattr(picture_mod, "grab_frames", grab_frames)
        mp.setattr(loudness, "measure", measure_loudness)
        mp.setattr(pipeline_mod, "find_moments", find_moments)
        mp.setattr(pipeline_mod, "render_clip", render_clip)
        mp.setattr(pipeline_mod, "measure", measure)
        mp.setattr(pipeline_mod.shutil, "disk_usage", lambda p: SimpleNamespace(free=self.free))

    def pipeline(self) -> Pipeline:
        def client(c: ToolClient, **kw: Any) -> Bedrock:
            b = Bedrock("m", "eu-north-1", client=c, **kw)
            b.forced_tool_choice = False
            return b

        watcher = client(self.nova, cache_points=False) if self.cfg.deep_enabled and self.cfg.watch_model_id else None
        return Pipeline(self.cfg, self.store, client(self.fable), self.transcriber, watch_bedrock=watcher)  # type: ignore[arg-type]

    async def run(self) -> tuple[str, JobState, dict[str, dict[str, Any]]]:
        pipe = self.pipeline()
        self.st = JobState(job_id="J", user_id="u", workdir=self.tmp / "work" / "J")
        tr = Tracker(self.store, "u", "J", heartbeat=5, flush=5)  # type: ignore[arg-type]
        try:
            status = await run_job(tr, pipe.steps(self.st, tr), clip_count=lambda: len(self.st.candidates))
        finally:
            await pipe.close(self.st)
        return status, self.st, {s["key"]: s for s in tr.steps}

    def scene_calls(self) -> int:
        return len(self.fable.calls("report_scenes"))


from types import SimpleNamespace  # noqa: E402


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> World:
    return World(tmp_path, monkeypatch)


def assert_ready(status: str, steps: dict[str, dict[str, Any]], watch: str = "done") -> None:
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    assert list(steps) == [k for k, _, _ in STEPS] and len(steps) == 10
    for key, s in steps.items():
        assert s["status"] == (watch if key == "watch" else "done"), (key, s)


async def test_ten_steps_and_the_picture_reaches_the_finder(world: World) -> None:
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert [s["key"] for s in world.store.writes[-1]["steps"]] == [
        "resolve",
        "download",
        "transcribe",
        "analyze",
        "watch",
        "select",
        "render",
        "checklist",
        "captions",
        "finalize",
    ]
    assert steps["download"]["message"] == "Got 0:10:00 of sound."
    assert steps["watch"]["message"] == "Watched all 0:10:00. Saw 6 big things."
    # resolve chose the small rendition; download started the picture in the background; watch used it
    assert world.store.json("meta.json")["picture"] == {
        "formatId": "135",
        "height": 480,
        "fps": 30,
        "estBytes": 50_000_000,
    }
    pic = world.store.json("picture.json")
    assert [p["key"] for p in pic["parts"]] == [
        "jobs/J/source/picture/part-0000.mp4",
        "jobs/J/source/picture/part-0001.mp4",
    ]
    assert pic["seconds"] == 600 and world.store.has("picture/part-0001.mp4")
    assert not (st.workdir / "source" / "picture.mp4").exists()  # the downloaded source is deleted once cut
    assert world.scene_calls() == 4 and len(world.nova.calls("report_scenes")) == 2  # 4 chunks, 2 parts
    assert world.store.has("watch/chunk-0003.json") and world.store.has("watch/nova-0001.json")
    log = world.store.json("visual_log.json")
    assert log["coverage"] == [[0, 600]] and log["failed"] == []
    assert world.store.json("signals.json")["coverage"]["picture"] == 1.0
    assert world.store.json("speakers.json")[0] == [100.0, 160.0, "S1"]
    # the finder got the signals and the speakers
    b = world.briefs[0]
    assert b.signals is not None and b.signals.watched and b.speakers[1][2] == "S2"
    assert any(e.kind == "crash" and e.src == ["fable"] for e in b.signals.events)
    # the second look saw every chosen moment and spare, and the picked clips say why
    assert len(world.fable.calls("check_moment")) == 3
    assert world.store.json("moments.json")["secondLook"][0]["result"] == "kept"
    assert world.store.clips[0]["pickedFor"] == "Big crash + Loud moment"
    assert world.store.clips[1]["pickedFor"] == "Cool stunt"  # what Nova saw inside that clip
    assert not (st.workdir / "picture").exists()  # the local parts are gone before render
    deep = world.store.json("meta.json")["deep"]
    assert {k: v["status"] for k, v in deep.items()} == {
        "speakers": "ok",
        "prep": "ok",
        "decode": "ok",
        "fable": "ok",
        "nova": "ok",
        "secondLook": "ok",
    }
    review = next(
        q for q in world.fable.calls("submit_review") if "Seen (machine-made" in q["messages"][0]["content"][0]["text"]
    )
    assert "(seen) crash 9/10" in review["messages"][0]["content"][0]["text"]


def assert_not_watched(world: World, st: JobState, steps: dict[str, dict[str, Any]]) -> None:
    assert steps["watch"]["message"] == NOT_WATCHED
    assert world.scene_calls() == 0 and world.nova.requests == [] and world.fable.calls("check_moment") == []
    assert world.briefs[0].signals is None  # the finder gets exactly what it got before the picture was watched
    assert not world.store.has("visual_log.json") and len(world.store.clips) == 2


async def test_no_rendition_that_fits_skips_the_watching(world: World) -> None:
    world.info = {**INFO, "formats": []}
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert world.store.json("meta.json")["picture"] is None and world.picture_downloads == 0
    assert world.store.json("meta.json")["deep"]["prep"] == {"status": "skipped", "reason": "no picture that fits"}


async def test_a_disk_too_small_skips_the_watching(world: World) -> None:
    world.free = picture_mod.DISK_RESERVE + 1000
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert world.picture_downloads == 0


async def test_a_blocked_picture_download_skips_the_watching(world: World, capsys: pytest.CaptureFixture[str]) -> None:
    world.download_error = proc.CommandError("yt-dlp", 1, "ERROR: Sign in to confirm you're not a bot")
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert world.picture_downloads == 1 and '"picture.prep_failed"' in capsys.readouterr().out
    assert world.store.json("meta.json")["deep"]["prep"]["status"] == "skipped"
    assert "bot" not in json.dumps(steps)  # yt-dlp's words never reach the owner


async def test_a_failed_ffmpeg_pass_skips_the_watching(world: World) -> None:
    world.prepare_error = proc.CommandError("ffmpeg", 1, "Invalid data found")
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert not (st.workdir / "source" / "picture.mp4").exists()


async def test_a_picture_that_takes_too_long_is_given_up(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.prepare_delay = 30
    monkeypatch.setattr(pipeline_mod, "prep_deadline", lambda seconds: 0.05)
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert world.store.json("meta.json")["deep"]["prep"] == {"status": "skipped", "reason": "deadline"}
    assert st.picture_task is not None and st.picture_task.done()


def no_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bedrock's own retries (retry.py) without their waits: one try, as if the retries had already run out."""

    async def once(fn: Any, **kw: Any) -> Any:
        return await fn()

    monkeypatch.setattr("clipfactory_agent.bedrock.retry", once)


def refuse_some(world: World, bad: set[str]) -> None:
    def answer(kw: dict[str, Any]) -> dict[str, Any]:
        first = kw["messages"][0]["content"][0]["text"]
        if any(first.startswith(f"[{stamp}]") for stamp in bad):
            raise client_error("ThrottlingException", "slow down")
        return {"scene": "a chase", "events": [event(110, 114, intensity=9)]}

    world.fable.handlers["report_scenes"] = answer


async def test_some_fable_chunks_failing_is_most_of_the_video(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    no_backoff(monkeypatch)
    world.cfg = Config(**{**world.cfg.__dict__, "watch_model_id": None})  # Nova is not there to fill the gap
    refuse_some(world, {"0:02:24"})  # the second chunk (its lead-in starts at 144 s)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"] == "Watched most of the video (3 of 4 parts)."
    log = world.store.json("visual_log.json")
    assert log["failed"] == [{"start": 150.0, "end": 300.0, "src": "fable", "reason": "busy"}]
    assert world.store.json("meta.json")["deep"]["fable"]["status"] == "partial"
    assert world.store.json("meta.json")["deep"]["nova"]["status"] == "skipped"
    assert world.briefs[0].signals.coverage_percent == 75


async def test_nova_covers_the_chunks_fable_lost(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    no_backoff(monkeypatch)
    refuse_some(world, {"0:02:24"})
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"].startswith("Watched all 0:10:00.")  # every part was watched by one of the two
    log = world.store.json("visual_log.json")
    assert len(log["failed"]) == 1 and log["coverage"] == [[0, 600]] and log["fable"] == [[0, 150], [300, 600]]


async def test_all_fable_chunks_failing_leaves_nova_and_motion(world: World) -> None:
    world.fable.handlers.pop("report_scenes")  # no usable answer, ever
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"].startswith("Watched all 0:10:00.")
    sig = world.briefs[0].signals
    assert sig.events and all(e.src == ["nova"] for e in sig.events)
    deep = world.store.json("meta.json")["deep"]
    assert deep["fable"] == {"status": "skipped", "reason": "bad_answer"} and deep["nova"]["status"] == "ok"


async def test_nova_denied_changes_nothing_else(world: World) -> None:
    def denied(kw: dict[str, Any]) -> Any:
        raise client_error("AccessDeniedException", "not authorized to perform bedrock:InvokeModel")

    world.nova.handlers["report_scenes"] = denied
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"] == "Watched all 0:10:00. Saw 4 big things."
    assert world.store.json("meta.json")["deep"]["nova"] == {"status": "skipped", "reason": "denied"}
    assert all(e.src == ["fable"] for e in world.briefs[0].signals.events)


async def test_both_watchers_failing_leaves_the_motion(world: World) -> None:
    world.fable.handlers.pop("report_scenes")
    world.nova.handlers.pop("report_scenes")
    world.motion[112] = 0.3
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"] == MOTION_ONLY
    sig = world.briefs[0].signals
    assert sig is not None and not sig.events and not sig.watched
    assert [h.t for h in sig.hotspots] == [112.0] and set(sig.hotspots[0].sources) == {"loud", "motion"}
    assert world.store.clips[0]["pickedFor"] == "Loud moment + Fast action"


async def test_no_speaker_labels_is_no_speakers_file(world: World) -> None:
    world.transcriber.doc = transcript_doc(speakers=False)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert not world.store.has("speakers.json") and world.briefs[0].speakers is None
    assert world.store.json("meta.json")["deep"]["speakers"]["status"] == "skipped"


async def test_signals_build_failing_gives_the_finder_what_it_had_before(
    world: World, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(**kw: Any) -> Any:
        raise RuntimeError("a bug in the merge")

    monkeypatch.setattr(signals_mod, "build", boom)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert world.briefs[0].signals is None and len(world.store.clips) == 2
    out = capsys.readouterr().out
    assert '"signals.build_failed"' in out and '"level": "error"' in out


async def test_a_failed_second_look_keeps_the_moment_as_picked(world: World) -> None:
    world.fable.handlers.pop("check_moment")
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert [(m.start, m.end) for m in st.chosen] == [(100, 130), (300, 330)]
    assert world.store.json("meta.json")["deep"]["secondLook"]["status"] == "skipped"
    assert all(r["result"] == "not checked" for r in world.store.json("moments.json")["secondLook"])


async def test_a_weak_moment_is_swapped_for_the_spare(world: World) -> None:
    keep = world.check_moment

    def check(kw: dict[str, Any]) -> dict[str, Any]:
        a = keep(kw)
        return {**a, "keep": a["start"] != 300}

    world.fable.handlers["check_moment"] = check
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert [m.start for m in st.chosen] == [100, 450] and st.spares == []
    assert sorted(c["sourceStart"] for c in world.store.clips) == [100, 450]


async def test_picked_for_that_cannot_be_built_is_left_out(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(m: Any, **kw: Any) -> Any:
        raise RuntimeError("a bug")

    monkeypatch.setattr(signals_mod, "picked_for", boom)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert all("pickedFor" not in c for c in world.store.clips)


async def test_deep_off_downloads_no_picture_and_skips_the_watching(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = World(tmp_path, monkeypatch, deep_enabled=False)
    status, st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert_not_watched(world, st, steps)
    assert world.picture_downloads == 0 and world.prepares == 0 and st.picture_task is None
    assert world.store.json("meta.json")["picture"] is None
    # The switch restores the prompts from before ADR-40: no speaker labels asked for, none given to the finder.
    assert world.transcriber.kw["speakers"] is False
    assert world.briefs[0].speakers is None and not world.store.has("speakers.json")


async def test_deep_off_on_a_retried_job_with_a_saved_log_still_watches_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import dataclasses

    off = World(tmp_path, monkeypatch)
    await off.run()
    assert off.store.has("visual_log.json")
    off.cfg = dataclasses.replace(off.cfg, deep_enabled=False)
    off.briefs.clear()
    status, st, steps = await off.run()
    assert_ready(status, steps, watch="skipped")
    assert steps["watch"]["message"] == NOT_WATCHED and st.signals is None and st.picture_task is None
    assert off.briefs[0].signals is None and off.briefs[0].speakers is None


async def test_a_storage_failure_while_saving_the_log_keeps_what_was_seen(world: World) -> None:
    world.store.fail_put = "visual_log.json"
    status, st, steps = await world.run()
    assert_ready(status, steps)  # watch never raises: the job's step retries cannot repeat it
    assert steps["watch"]["message"].startswith("Watched all") and world.scene_calls() == 4
    assert st.signals is not None and st.signals.events  # the picker still gets what was seen
    assert world.store.json("signals.json")["version"] == 1


async def test_try_again_reuses_what_was_watched(world: World) -> None:
    await world.run()
    calls, downloads, prepares, runs = (
        world.scene_calls(),
        world.picture_downloads,
        world.prepares,
        world.transcriber.runs,
    )
    looks = len(world.fable.calls("check_moment"))
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"] == "Used what it saw last time."
    assert st.picture_task is None  # the picture is not prepared again
    assert (world.scene_calls(), world.picture_downloads, world.prepares, world.transcriber.runs) == (
        calls,
        downloads,
        prepares,
        runs,
    )
    assert world.briefs[1].signals is not None and world.briefs[1].speakers
    assert len(world.fable.calls("check_moment")) == looks + 3  # the second look fetches its frames from S3
    assert world.store.clips[-2]["pickedFor"] == "Big crash + Loud moment"


async def test_try_again_after_a_partial_watch_only_watches_what_is_missing(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_backoff(monkeypatch)
    world.cfg = Config(**{**world.cfg.__dict__, "watch_model_id": None})
    refuse_some(world, {"0:02:24"})
    await world.run()
    world.fable.requests.clear()
    world.fable.handlers["report_scenes"] = lambda kw: {"scene": "", "events": []}
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert world.scene_calls() == 1 and world.picture_downloads == 1 and world.prepares == 1
    assert steps["watch"]["message"].startswith("Watched all")


async def test_close_cancels_the_picture_task(world: World) -> None:
    world.prepare_delay = 60
    pipe = world.pipeline()
    st = JobState(job_id="J", user_id="u", workdir=world.tmp / "work" / "J")
    tr = Tracker(world.store, "u", "J", heartbeat=5, flush=5)  # type: ignore[arg-type]
    steps = dict(pipe.steps(st, tr))
    await steps["resolve"]()
    await steps["download"]()
    task = st.picture_task
    assert task is not None and not task.done()
    await asyncio.sleep(0.01)
    await pipe.close(st)
    assert task.cancelled()
    await pipe.close(st)  # closing twice, or a run that never started the task, is fine
    await pipe.close(JobState(job_id="X", user_id="u", workdir=world.tmp))


async def test_a_cancel_during_the_watch_stops_it(world: World) -> None:
    def cancel(kw: dict[str, Any]) -> Any:
        raise JobSuperseded()

    world.fable.handlers["report_scenes"] = cancel
    status, _st, _steps = await world.run()
    assert status == "superseded" and world.store.clips == []


async def test_a_cancel_while_the_picture_is_still_preparing_stops_the_wait(world: World) -> None:
    world.prepare_delay = 30
    pipe = world.pipeline()
    st = JobState(job_id="J", user_id="u", workdir=world.tmp / "work" / "J")
    tr = Tracker(world.store, "u", "J", heartbeat=5, flush=5)  # type: ignore[arg-type]
    steps = dict(pipe.steps(st, tr))
    for key in ("resolve", "download", "transcribe", "analyze"):
        await steps[key]()
    watching = asyncio.create_task(steps["watch"]())
    await asyncio.sleep(0.05)
    assert not watching.done()  # waiting for the picture
    tr.canceled.set()
    with pytest.raises(JobCanceled):
        await asyncio.wait_for(watching, 5)
    await pipe.close(st)
    assert st.picture_task is not None and st.picture_task.cancelled()
    assert not (st.workdir / "picture").exists()  # a canceled preparation leaves nothing on disk


async def test_disk_filled_up_between_resolve_and_the_picture_download(world: World) -> None:
    real = world.pipeline

    def pipeline() -> Pipeline:
        pipe = real()
        resolve = pipe.resolve

        async def shrink_after_resolve(st: JobState, tr: Tracker) -> Any:
            out = await resolve(st, tr)
            world.free = picture_mod.DISK_RESERVE + 1000  # resolve chose with 100 GB free; now it is gone
            return out

        pipe.resolve = shrink_after_resolve  # type: ignore[method-assign]
        return pipe

    world.pipeline = pipeline  # type: ignore[method-assign]
    status, _st, steps = await world.run()
    assert_ready(status, steps, watch="skipped")
    assert world.picture_downloads == 0
    assert world.store.json("meta.json")["deep"]["prep"] == {"status": "skipped", "reason": "OSError"}


async def test_a_failed_download_leaves_no_picture_files(world: World) -> None:
    def leave_a_part_file() -> None:
        part = world.tmp / "work" / "J" / "source" / "picture.mp4.part"
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(b"half a video")

    real = sources.download_picture

    async def download_picture(*a: Any, **kw: Any) -> Path:
        leave_a_part_file()
        return await real(*a, **kw)

    world.download_error = proc.CommandError("yt-dlp", 1, "ERROR: timed out")
    sources.download_picture = download_picture  # type: ignore[assignment]
    try:
        status, st, steps = await world.run()
    finally:
        sources.download_picture = real  # type: ignore[assignment]
    assert_ready(status, steps, watch="skipped")
    assert not list((st.workdir / "source").glob("picture.*"))


async def test_a_second_look_that_raises_keeps_the_picks(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*a: Any, **kw: Any) -> Any:
        raise RuntimeError("a bug in the second look")

    monkeypatch.setattr(verify_mod, "second_look", boom)
    status, st, steps = await world.run()
    assert_ready(status, steps)
    assert [(m.start, m.end) for m in st.chosen] == [(100, 130), (300, 330)]
    assert world.store.json("meta.json")["deep"]["secondLook"] == {"status": "skipped", "reason": "RuntimeError"}


async def test_under_half_watched_says_part_of_the_video(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    no_backoff(monkeypatch)
    world.cfg = Config(**{**world.cfg.__dict__, "watch_model_id": None})
    refuse_some(world, {"0:00:00", "0:02:24", "0:04:54"})  # three of the four chunks
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert steps["watch"]["message"] == "Watched part of the video (1 of 4 parts)."


async def test_few_words_with_strong_picture_events_goes_on(world: World) -> None:
    world.transcriber.doc = transcript_doc(words=3)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert world.store.json("meta.json")["fewWords"] is True and len(world.store.clips) == 2


async def test_few_words_without_picture_events_fails_with_the_old_words(world: World) -> None:
    world.transcriber.doc = transcript_doc(words=3)
    world.fable.handlers["report_scenes"] = lambda kw: {"scene": "", "events": [event(10, 12, intensity=5)]}
    world.nova.handlers["report_scenes"] = lambda kw: {"scene": "", "events": []}
    status, _st, steps = await world.run()
    assert status == "failed" and steps["transcribe"]["status"] == "done" and steps["select"]["status"] == "failed"
    assert (
        steps["select"]["message"]
        == ALMOST_NO_SPEECH
        == (
            "Almost no speech was found in this video, so there is nothing to pick moments from. "
            "Clip Factory needs talking or commentary."
        )
    )
    assert world.briefs == []


async def test_few_words_and_no_picture_at_all_fails_the_same_way(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = World(tmp_path, monkeypatch, deep_enabled=False)
    world.transcriber.doc = transcript_doc(words=3)
    status, _st, steps = await world.run()
    assert status == "failed" and steps["select"]["message"] == ALMOST_NO_SPEECH


async def test_an_upload_is_read_in_place_without_a_copy(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.store.job["source"] = {"type": "upload", "key": "uploads/u/video.mp4", "filename": "v.mp4"}
    world.store.files["uploads/u/video.mp4"] = b"mp4"
    seen: list[dict[str, Any]] = []

    async def run(args: list[str], **kw: Any) -> proc.Result:
        Path(args[-1]).write_bytes(b"audio")  # the audio extraction
        return proc.Result(b"", "")

    real_prepare = picture_mod.prepare

    async def prepare(src: str, out: Path, **kw: Any) -> Any:
        seen.append({"src": src, **kw})
        return await real_prepare(src, out, **kw)

    monkeypatch.setattr(proc, "run", run)
    monkeypatch.setattr(picture_mod, "prepare", prepare)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert world.store.json("meta.json")["picture"] == {"upload": True, "height": 1080, "fps": 30.0}
    assert world.picture_downloads == 0  # no copy: ffmpeg reads the presigned video
    assert seen[0]["src"] == "https://s3.test/jobs/J/source/video.mp4" and seen[0]["keyframes"] is False  # 10 minutes
    assert world.store.json("picture.json")["decode"] == "all"


@pytest.mark.parametrize(("speed", "mode"), [(0.5, "keyframes"), (0.0, "keyframes"), (40.0, "all")])
async def test_a_tall_long_upload_is_decoded_fully_when_the_measured_speed_allows(
    world: World, monkeypatch: pytest.MonkeyPatch, speed: float, mode: str
) -> None:
    world.store.job["source"] = {"type": "upload", "key": "uploads/u/video.mp4", "filename": "v.mp4"}
    world.store.files["uploads/u/video.mp4"] = b"mp4"
    seen: list[dict[str, Any]] = []
    probed: list[str] = []

    async def run(args: list[str], **kw: Any) -> proc.Result:
        Path(args[-1]).write_bytes(b"audio")
        return proc.Result(b"", "")

    async def decode_speed(src: str, **kw: Any) -> float:
        probed.append(src)
        return speed

    real_prepare = picture_mod.prepare

    async def prepare(src: str, out: Path, **kw: Any) -> Any:
        seen.append(kw)
        return await real_prepare(src, out, **kw)

    monkeypatch.setattr(proc, "run", run)
    monkeypatch.setattr(picture_mod, "prepare", prepare)
    monkeypatch.setattr(picture_mod, "decode_speed", decode_speed)
    # The fake source is 10 minutes long; count it as long enough to be in doubt.
    monkeypatch.setattr(picture_mod, "keyframes_only", lambda height, seconds: height > 720)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert probed == ["https://s3.test/jobs/J/source/video.mp4"]
    assert seen[0]["keyframes"] is (mode == "keyframes")
    assert world.store.json("picture.json")["decode"] == mode
    assert world.store.json("meta.json")["deep"]["decode"] == {"status": "ok", "mode": mode}


def test_full_decode_rule() -> None:
    four_hours = 4 * 3600
    assert picture_mod.time_limit(four_hours) == 4800 and pipeline_mod.prep_deadline(four_hours) == 4800
    assert picture_mod.full_decode_fits(four_hours, 5.0)  # 48 min of decoding, limit 80 min
    assert not picture_mod.full_decode_fits(four_hours, 2.0)  # 2 h of decoding
    assert not picture_mod.full_decode_fits(four_hours, 0.0)  # the probe failed


async def test_a_part_over_the_part_limit_is_encoded_smaller_once(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    shrunk: list[str] = []

    async def prepare(src: str, out: Path, **kw: Any) -> Any:
        out.mkdir(parents=True, exist_ok=True)
        files = [out / "part-0000.mp4", out / "part-0001.mp4"]
        files[0].write_bytes(b"part")
        with files[1].open("wb") as f:
            f.truncate(picture_mod.PART_MAX_BYTES + 1)
        return files, [0.01] * 600, [0.01] * 600

    async def shrink(part: Path) -> Path:
        shrunk.append(part.name)
        part.write_bytes(b"smaller")
        return part

    monkeypatch.setattr(picture_mod, "prepare", prepare)
    monkeypatch.setattr(picture_mod, "shrink", shrink)
    status, _st, steps = await world.run()
    assert_ready(status, steps)
    assert shrunk == ["part-0001.mp4"] and world.store.json("picture.json")["parts"][1]["bytes"] == 7
