"""Jobs that never stop partway (docs/CONTRACTS.md §30), the agent's side: a resumed run picks up the moments and
the clips already cut, the Cut step's memory is bounded, an out-of-memory kill costs one try of one clip, uploads never
run the YouTube machinery, and a container shutdown tells the job flow instead of marking the job canceled."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from clipfactory_agent import jobs as jobs_mod
from clipfactory_agent import pipeline as pipeline_mod
from clipfactory_agent import pot, proc
from clipfactory_agent.callback import DurableCallback
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.jobs import STEPS, JobRunner, StepDone, Tracker, run_job
from clipfactory_agent.pipeline import JobState, Pipeline, RenderGate
from clipfactory_agent.render import RenderResult, filter_graph
from clipfactory_agent.server import app_lifespan, make_run

from .conftest import make_moment
from .test_callback import FakeLambda
from .test_pipeline import GB, MemStore, World


@pytest.fixture(autouse=True)
def _no_shutdown() -> Any:
    jobs_mod.SHUTDOWN.clear()
    yield
    jobs_mod.SHUTDOWN.clear()


class FakeTracker:
    async def check_cancel(self) -> None:
        pass

    def report(self, fraction: float, *, alive: bool = True) -> None:
        pass

    def say(self, note: str) -> None:
        pass


def result(workdir: Path, m: Any) -> RenderResult:
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "clip.mp4").write_bytes(b"clip")
    (workdir / "cover.jpg").write_bytes(b"cover")
    return RenderResult(workdir / "clip.mp4", workdir / "cover.jpg", 30.0, [(m.start, m.end)], [], "blur_fill", False)


@pytest.fixture
def world(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> World:
    return World(tmp_path, monkeypatch)


def render_world(tmp_path: Path, n: int = 10) -> tuple[Pipeline, JobState, MemStore]:
    store = MemStore()
    p = Pipeline(SimpleNamespace(model_id="m"), store, None, None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path / "J")
    st.source = {"type": "upload"}
    st.chosen = [make_moment(start=100 + 100 * i, end=130 + 100 * i) for i in range(n)]
    return p, st, store


# --- moments and clips are picked up -----------------------------------------------------------------------------


async def test_render_cuts_only_the_clips_not_saved_yet(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p, st, store = render_world(tmp_path)
    cut: list[int] = []

    async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        cut.append(index)
        return Candidate(m, result(st.workdir / "clips" / f"{index:02d}", m), index=index)

    monkeypatch.setattr(p, "_cut", fake_cut)
    # A first run cut clips 0-3, saving each one, then stopped.
    first = JobState(job_id="J", user_id="u", workdir=tmp_path / "first")
    first.chosen = st.chosen
    for i in range(4):
        await p._save_clip(first, await fake_cut(first, st.chosen[i], i))
    assert store.has("render/03/done.json") and store.has("render/03/clip.mp4") and store.has("render/03/cover.jpg")
    cut.clear()

    st.pick_up = True
    msg = await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert sorted(cut) == [4, 5, 6, 7, 8, 9]
    assert [c.index for c in st.candidates] == list(range(10))
    assert st.candidates[0].render.video.read_bytes() == b"clip"  # downloaded back to this run's disk
    assert msg == "Cut 10 clips."
    assert store.has("render/09/done.json")  # this run saved its clips too


async def test_saved_clips_are_ignored_unless_picking_up_or_for_another_moment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p, st, _store = render_world(tmp_path, n=2)
    cut: list[int] = []

    async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        cut.append(index)
        return Candidate(m, result(st.workdir / "clips" / f"{index:02d}", m), index=index)

    monkeypatch.setattr(p, "_cut", fake_cut)
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert sorted(cut) == [0, 1]
    cut.clear()
    st.chosen[1] = make_moment(start=900, end=930)  # a fresh pick at index 1
    st.pick_up = True
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert cut == [1]
    cut.clear()
    st.pick_up = False  # Try again after a real failure: starts over
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert sorted(cut) == [0, 1]


async def test_a_resumed_job_reuses_moments_and_clips(world: World) -> None:
    status, _, _ = await world.run()
    assert status == "ready" and len(world.briefs) == 1
    saved = world.store.json("moments.json")
    assert saved["version"] == 1 and saved["settings"] and len(saved["chosen"]) == 2
    assert world.store.has("render/00/done.json") and world.store.has("render/01/done.json")

    renders: list[int] = []
    real = pipeline_mod.render_clip

    async def counting(m: Any, **kw: Any) -> RenderResult:
        renders.append(1)
        return await real(m, **kw)

    pipeline_mod.render_clip = counting  # type: ignore[assignment]
    try:
        world.store.job.update(status="queued", pickUp=True)
        status, st, steps = await world.run()
    finally:
        pipeline_mod.render_clip = real  # type: ignore[assignment]
    assert status == "ready"
    assert len(world.briefs) == 1  # no second model call to pick
    assert steps["select"]["message"] == "Used the 2 moments picked last time."
    assert renders == []  # both clips came back from S3
    assert len(st.candidates) == 2
    # The same clips keep the same ids; the clips already written are not written a second time.
    assert len(world.store.clips) == 2 and len({c["clipId"] for c in world.store.clips}) == 2


async def test_a_run_that_stopped_in_finish_up_never_posts_a_clip_twice(world: World) -> None:
    status, _, _ = await world.run()
    assert status == "ready"
    first = [dict(c) for c in world.store.clips]
    saved = world.store.json("clips.json")
    assert [r["id"] for r in saved["clips"]] == [c["clipId"] for c in first]
    # The run stopped after writing only the first clip (the owner may already have kept it).
    world.store.clips = [{**first[0], "status": "kept"}]
    world.store.job.update(status="queued", pickUp=True)
    status, st, _ = await world.run()
    assert status == "ready"
    assert [c["clipId"] for c in world.store.clips] == [c["clipId"] for c in first]  # one item per clip, same ids
    assert world.store.clips[0]["status"] == "kept"  # the owner's choice is left alone
    assert st.captions[first[1]["clipId"]] == first[1]["captions"]  # captions reused, not written again


async def test_changed_notes_pick_again(world: World) -> None:
    await world.run()
    world.store.job.update(status="queued", pickUp=True, notes="only the funny bits")
    await world.run()
    assert len(world.briefs) == 2


# --- the tracker on a resumed run ----------------------------------------------------------------------------------


class Writes:
    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []
        self.removed: list[tuple[str, ...]] = []

    async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
        self.writes.append(json.loads(json.dumps(fields)))
        self.removed.append(tuple(kw.get("remove") or ()))
        return True


async def test_a_resumed_run_keeps_the_done_steps_and_the_progress() -> None:
    old_steps = [{"key": k, "label": label, "status": "pending"} for k, label, _ in STEPS]
    for s in old_steps[:6]:
        s.update(status="done", message=f"{s['key']} first time", finishedAt="2026-11-19T16:20:00.000Z")
    old_steps[6]["status"] = "failed"
    job = {"pickUp": True, "steps": old_steps, "progress": 0.79, "clipCount": 0}
    store = Writes()
    tr = Tracker(store, "U", "J", session_id="S2", heartbeat=5, flush=5, resume=job)  # type: ignore[arg-type]

    async def step() -> StepDone:
        return StepDone("again")

    status = await run_job(tr, [(k, step) for k, _, _ in STEPS], clip_count=lambda: 4)
    assert status == "ready"
    first = store.writes[0]
    assert first["status"] == "running" and "clipCount" not in first and first["progress"] == 0.79
    assert first["steps"][0]["message"] == "resolve first time"
    assert all(w["progress"] >= 0.79 for w in store.writes)
    # A done step never flips back to running; the steps after it run as usual.
    assert all(w["steps"][0]["status"] == "done" for w in store.writes)
    assert store.writes[-1]["steps"][6] | {"startedAt": "", "finishedAt": ""} == {
        "key": "render",
        "label": "Cut the clips",
        "status": "done",
        "message": "again",
        "startedAt": "",
        "finishedAt": "",
    }
    assert store.removed[-1] == ("note", "pickUp")


async def test_a_fresh_run_still_resets_the_count() -> None:
    store = Writes()
    tr = Tracker(store, "U", "J", heartbeat=5, flush=5, resume={"steps": [], "progress": 0.5})  # type: ignore[arg-type]
    await tr.begin()
    await tr.stop()
    assert store.writes[0]["clipCount"] == 0 and store.writes[0]["progress"] == 0.0


# --- bounded memory -----------------------------------------------------------------------------------------------


def test_the_tease_has_its_own_input() -> None:
    ass = Path("/tmp/cf-work/J/clips/00/captions.ass")
    graph = filter_graph([(20, 21.5), (2, 10), (12, 18)], ["[vin]null[lay]"], ass, has_audio=True, tease=True)
    assert graph.startswith("[1:v]setpts=PTS-STARTPTS[v0];[1:a]asetpts=PTS-STARTPTS,")
    assert "[0:v]trim=start=20.000" not in graph  # the body's input never waits for the tease
    assert "[0:v]trim=start=2.000:end=10.000" in graph and "[0:v]trim=start=12.000:end=18.000" in graph


async def test_the_section_cut_is_capped(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen: list[list[str]] = []

    async def run(args: list[str], **kw: Any) -> proc.Result:
        seen.append(list(args))
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", run)
    await Pipeline._ffmpeg_cut("https://s3.test/x", 1, 2, tmp_path / "s.mp4")
    await Pipeline._ffmpeg_cut(str(tmp_path / "local.mp4"), 1, 2, tmp_path / "s.mp4")
    remote, local = (" ".join(a) for a in seen)
    for cmd in (remote, local):
        assert "-vf scale='min(1920,iw)':-2:flags=bicubic,fps=30" in cmd
        assert "-crf 18" in cmd and "-threads 2" in cmd
    assert "-rw_timeout" in remote and "-rw_timeout" not in local


async def test_concurrency_follows_free_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def peak(free: int | None, height: int = 1080) -> int:
        p, st, _ = render_world(tmp_path, n=4)
        st.meta["picture"] = {"height": height}
        monkeypatch.setattr(pipeline_mod, "free_memory", lambda: free)
        running = 0
        top = 0

        async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
            nonlocal running, top
            running += 1
            top = max(top, running)
            await asyncio.sleep(0.02)
            running -= 1
            return Candidate(m, result(st.workdir / f"c{index}", m), index=index)

        monkeypatch.setattr(p, "_cut", fake_cut)
        await p.render(st, FakeTracker())  # type: ignore[arg-type]
        return top

    assert await peak(6 * GB) == 2
    assert await peak(2 * GB) == 1  # under 3 GiB free: one clip at a time
    assert await peak(6 * GB, height=2160) == 1  # a 4K source: one at a time
    assert await peak(None) == 2  # not Linux (tests): the ceiling


async def test_the_gate_lets_a_second_clip_in_once_memory_frees() -> None:
    free = [False]
    gate = RenderGate(2, lambda: free[0])
    async with gate:
        second = asyncio.create_task(gate.__aenter__())
        await asyncio.sleep(0.05)
        assert not second.done()
        free[0] = True
        async with gate._cond:
            gate._cond.notify_all()
        await asyncio.wait_for(second, 1)
        assert gate.running == 2
        await gate.__aexit__()


async def test_a_clip_killed_for_memory_is_tried_once_more_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p, st, _ = render_world(tmp_path, n=3)
    tries: dict[int, int] = {}
    killed = proc.CommandError("ffmpeg", -9, "")

    async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        tries[index] = tries.get(index, 0) + 1
        if index == 1 and tries[index] == 1:
            raise killed
        if index == 2:
            raise killed  # killed every time: skipped after the second try
        return Candidate(m, result(st.workdir / f"c{index}", m), index=index)

    monkeypatch.setattr(p, "_cut", fake_cut)
    msg = await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert tries == {0: 1, 1: 2, 2: 2}
    assert [c.index for c in st.candidates] == [0, 1]
    assert msg == "Cut 2 clips; 1 could not be cut."


async def test_a_clip_in_flight_when_runs_died_is_cut_last_alone_then_left_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p, st, store = render_world(tmp_path, n=5)
    st.session_id = "S3"
    st.pick_up = True
    store.files["jobs/J/source/render/01/started.json"] = json.dumps({"session": "S2", "runs": 1}).encode()
    store.files["jobs/J/source/render/02/started.json"] = json.dumps({"session": "S2", "runs": 2}).encode()
    store.files["jobs/J/source/render/03/started.json"] = json.dumps({"session": "S2", "runs": 0}).encode()
    order: list[int] = []
    running = 0
    top = 0

    async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        nonlocal running, top
        running += 1
        top = max(top, running)
        marker = json.loads(store.files[f"jobs/J/source/render/{index:02d}/started.json"])
        assert marker["session"] == "S3"  # marked before it is cut
        order.append(index)
        await asyncio.sleep(0.01)
        running -= 1
        if index == 4:
            raise proc.CommandError("ffmpeg", 1, "bad fragment")
        return Candidate(m, result(st.workdir / f"c{index}", m), index=index)

    monkeypatch.setattr(p, "_cut", fake_cut)
    msg = await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert 2 not in order  # in flight during two deaths: left out, the job goes on
    assert order[-1] == 1  # in flight during one death: cut last
    assert top == 1  # picking up: one clip at a time
    assert json.loads(store.files["jobs/J/source/render/01/started.json"])["runs"] == 2
    assert json.loads(store.files["jobs/J/source/render/04/started.json"])["runs"] == 0  # a plain failure, not a death
    assert [c.index for c in st.candidates] == [0, 1, 3]
    assert msg == "Cut 3 clips; 2 could not be cut."


async def test_a_fresh_run_ignores_old_markers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p, st, store = render_world(tmp_path, n=2)
    st.session_id = "S9"
    store.files["jobs/J/source/render/01/started.json"] = json.dumps({"session": "S2", "runs": 5}).encode()
    cut: list[int] = []

    async def fake_cut(st: JobState, m: Any, index: int, layout: Any = None) -> Candidate:
        cut.append(index)
        return Candidate(m, result(st.workdir / f"c{index}", m), index=index)

    monkeypatch.setattr(p, "_cut", fake_cut)
    assert await p.render(st, FakeTracker()) == "Cut 2 clips."  # type: ignore[arg-type]
    assert sorted(cut) == [0, 1]


def test_mount_type_reads_the_longest_mount(tmp_path: Path) -> None:
    mounts = tmp_path / "mounts"
    mounts.write_text("overlay / overlay rw,relatime 0 0\ntmpfs /tmp tmpfs rw 0 0\n/dev/vdb /tmp/cf-work ext4 rw 0 0\n")
    assert pipeline_mod.mount_type(Path("/tmp/cf-work/J/source"), mounts) == "ext4"
    assert pipeline_mod.mount_type(Path("/tmp/other"), mounts) == "tmpfs"
    assert pipeline_mod.mount_type(Path("/srv"), mounts) == "overlay"
    assert pipeline_mod.mount_type(Path("/srv"), tmp_path / "none") == "unknown"


async def test_an_upload_is_not_copied_to_a_disk_in_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p, st, store = render_world(tmp_path, n=1)
    store.files["jobs/J/source/video.mp4"] = b"x" * 1000

    async def head(key: str) -> dict[str, Any]:
        return {"ContentLength": 3 * GB}

    store.head = head  # type: ignore[attr-defined]
    srcs: list[str] = []

    async def cut(src: str, start: float, end: float, dest: Path) -> Path:
        srcs.append(src)
        return dest

    monkeypatch.setattr(p, "_ffmpeg_cut", cut)
    monkeypatch.setattr(pipeline_mod.shutil, "disk_usage", lambda _: SimpleNamespace(free=20 * GB))
    monkeypatch.setattr(pipeline_mod, "mount_type", lambda _: "tmpfs")
    monkeypatch.setattr(pipeline_mod, "free_memory", lambda: 6 * GB)
    await p._fetch_section(st, 1, 2, tmp_path / "s.mp4")
    assert srcs == ["https://s3.test/jobs/J/source/video.mp4"]  # 3 GB in RAM would starve the cut: read from S3


# --- uploads never run the YouTube machinery ----------------------------------------------------------------------


async def test_an_upload_never_starts_deno_or_the_youtube_cut(world: World, monkeypatch: pytest.MonkeyPatch) -> None:
    world.store.job["source"] = {"type": "upload", "key": "uploads/u/video.mp4", "filename": "v.mp4"}
    world.store.files["uploads/u/video.mp4"] = b"mp4"
    started: list[int] = []

    async def ensure_started() -> None:
        started.append(1)

    async def run(args: list[str], **kw: Any) -> proc.Result:
        Path(args[-1]).write_bytes(b"audio")
        return proc.Result(b"", "")

    monkeypatch.setattr(pot, "ensure_started", ensure_started)
    monkeypatch.setattr(proc, "run", run)
    status, st, _ = await world.run()
    assert status == "ready"
    assert started == []
    p = world.pipeline()
    for call in (p._save_info(st), p._ensure_full(st), p._cut_full(st, Path("x"), 0, 1, Path("y"))):
        with pytest.raises(RuntimeError, match="not uploads"):
            await call


async def test_an_upload_is_cut_from_one_local_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p, st, store = render_world(tmp_path, n=1)
    store.files["jobs/J/source/video.mp4"] = b"x" * 1000
    heads: list[str] = []

    async def head(key: str) -> dict[str, Any]:
        heads.append(key)
        return {"ContentLength": 1000}

    store.head = head  # type: ignore[attr-defined]
    srcs: list[str] = []

    async def cut(src: str, start: float, end: float, dest: Path) -> Path:
        srcs.append(src)
        return dest

    monkeypatch.setattr(p, "_ffmpeg_cut", cut)
    monkeypatch.setattr(pipeline_mod.shutil, "disk_usage", lambda _: SimpleNamespace(free=10 * GB))
    for _ in range(3):
        await p._fetch_section(st, 1, 2, tmp_path / "s.mp4")
    local = str(st.workdir / "source" / "upload.mp4")
    assert srcs == [local] * 3 and heads == ["jobs/J/source/video.mp4"]  # downloaded once
    assert Path(local).read_bytes() == b"x" * 1000

    p2, st2, store2 = render_world(tmp_path / "small", n=1)
    store2.head = head  # type: ignore[attr-defined]
    monkeypatch.setattr(p2, "_ffmpeg_cut", cut)
    monkeypatch.setattr(pipeline_mod.shutil, "disk_usage", lambda _: SimpleNamespace(free=2 * GB))
    srcs.clear()
    await p2._fetch_section(st2, 1, 2, tmp_path / "s.mp4")
    assert srcs == ["https://s3.test/jobs/J/source/video.mp4"]  # no room: read from S3 as before


async def test_pot_starts_only_when_a_youtube_call_asks(monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[Any] = []

    async def start(env: Any = None) -> None:
        started.append(env)

    monkeypatch.setattr(pot, "start", start)
    monkeypatch.setattr(pot, "_config", [])
    pot.configure({"CF_POT": "off"})
    assert started == []  # the app started: no Deno yet
    await pot.ready(0.01)
    assert started == [{"CF_POT": "off"}]


# --- a container shutdown -----------------------------------------------------------------------------------------


class JobStore:
    def __init__(self) -> None:
        self.job: dict[str, Any] = {"jobId": "J", "status": "queued", "sessionId": "S1"}
        self.writes: list[dict[str, Any]] = []

    async def get_job(self, user_id: str, job_id: str) -> dict[str, Any]:
        return self.job

    async def update_job(self, user_id: str, job_id: str, fields: dict[str, Any], **kw: Any) -> bool:
        self.writes.append(fields)
        self.job.update(fields)
        return True


class SlowSteps:
    def steps(self, st: Any, tr: Any) -> list[tuple[str, Any]]:
        async def slow() -> StepDone:
            await asyncio.sleep(60)
            return StepDone("never")

        return [("resolve", slow)]


async def test_sigterm_stops_the_job_and_tells_the_flow(tmp_path: Path) -> None:
    store, client = JobStore(), FakeLambda()
    run = make_run(
        store,  # type: ignore[arg-type]
        SlowSteps(),  # type: ignore[arg-type]
        tmp_path,
        lambda cb: DurableCallback(cb, client, retry_base=0.001, heartbeat_every=60),
    )
    runner = JobRunner(run, tmp_path)
    lifespan = app_lifespan(runner, {"CF_POT": "off"})
    async with lifespan(None):  # type: ignore[arg-type]
        assert runner.submit("J", "U", "S1", "CB1")
        await asyncio.sleep(0.05)
        assert store.job["status"] == "running"
    # uvicorn ran the app's shutdown (SIGTERM): the job is not canceled, the flow is told to resume it.
    assert not runner.busy
    assert store.job["status"] == "running"
    assert "canceled" not in [w.get("status") for w in store.writes]
    assert client.calls[-1] == (
        "failure",
        {"CallbackId": "CB1", "Error": {"ErrorType": "AgentStopped", "ErrorMessage": "Picking up where it stopped…"}},
    )


async def test_an_owner_cancel_is_still_a_cancel(tmp_path: Path) -> None:
    store, client = JobStore(), FakeLambda()
    run = make_run(store, SlowSteps(), tmp_path, lambda cb: DurableCallback(cb, client, retry_base=0.001))  # type: ignore[arg-type]
    runner = JobRunner(run, tmp_path)
    runner.submit("J", "U", "S1", "CB1")
    await asyncio.sleep(0.05)
    runner.cancel("J", "S1")
    await asyncio.sleep(0.1)
    assert store.job["status"] == "canceled"
    assert client.calls[-1][1]["Error"]["ErrorType"] == "Canceled"
