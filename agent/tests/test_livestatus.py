"""The live status line (docs/CONTRACTS.md §31): fixed templates, the throttle, the 30-second refresh, scrubbing,
the run's sessionId, and that it never fails a job."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from clipfactory_agent import livestatus
from clipfactory_agent.jobs import Tracker, run_job, watched
from clipfactory_agent.livestatus import LiveStatus, parse_ffmpeg_progress, parse_ytdlp, scrub

from .test_jobs import FakeStore, ok_steps


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def live(clock: Clock | None = None, **kw: Any) -> tuple[LiveStatus, list[dict[str, Any]]]:
    written: list[dict[str, Any]] = []

    async def write(item: dict[str, Any]) -> None:
        written.append(item)

    return LiveStatus(write, "J1", "S1", now=clock or Clock(), **kw), written


async def test_each_kind_fills_its_fixed_template() -> None:
    ls, _ = live()
    ls.emit("step", key="download")
    assert ls.state == {"step": "download", "text": "Getting the video"}
    ls.emit("download", pct=34.2, got=412e6, total=1.2e9, speed=4.1e6)
    assert ls.state["detail"] == "412 MB of 1.2 GB · 34%"
    assert ls.state["tech"] == "yt-dlp · 4 MB/s"
    ls.emit("step", key="render")
    ls.emit("cut", i=3, n=10)
    ls.emit("cut_progress", i=3, at=41.2, length=58, w=1080, h=1920, fps=30)
    assert (ls.state["text"], ls.state["detail"], ls.state["i"], ls.state["n"]) == (
        "Cutting clip 3 of 10",
        "0:41 of 0:58",
        3,
        10,
    )
    assert ls.state["tech"] == "ffmpeg · 1080×1920 · 30 fps"
    ls.emit("check", i=4, n=10)
    assert ls.state["text"] == "Checking clip 4 of 10 with Claude"
    ls.emit("save", i=2, n=10)
    assert ls.state["text"] == "Saving clip 2 of 10"
    ls.emit("note", text="Checking clip 5 of 10…")
    assert (ls.state["text"], ls.state["i"], ls.state["n"]) == ("Checking clip 5 of 10", 5, 10)
    ls.emit("step", key="transcribe")
    ls.emit("transcribe_part", i=3, n=8)
    assert ls.state["detail"] == "3 of 8 parts done"
    ls.emit("step", key="watch")
    ls.emit("watch_part", i=2, n=5)
    assert (ls.state["text"], ls.state["detail"]) == ("Watching the video with Claude", "2 of 5 parts done")
    ls.emit("resume", done=6)
    assert ls.state["text"] == "Picking up where it stopped" and ls.state["detail"] == "6 steps already done"


async def test_an_unknown_kind_or_free_text_never_reaches_the_line() -> None:
    ls, _ = live()
    ls.emit("step", key="render")
    ls.emit("shell", text="ffmpeg -i /tmp/x.mp4")
    assert ls.state == {"step": "render", "text": "Cutting the clips"}
    ls.emit("download", pct=10, got=1, total=10, speed=0, cmd="yt-dlp --cookies /private/u/cookies.txt")
    assert "cookies" not in str(ls.state)


async def test_a_model_call_sets_since_once_and_clears_it_when_every_call_ended() -> None:
    ls, _ = live()
    ls.emit("step", key="checklist")
    with ls.thinking("global.anthropic.claude-opus-5-5"):
        assert ls.state["tech"] == "Claude Opus 5.5 · thinking"
        since = ls.state["since"]
        with ls.thinking("global.anthropic.claude-opus-5-5"):
            assert ls.state["since"] == since  # a second call in parallel keeps the first start
        assert "since" in ls.state
    assert "since" not in ls.state and "tech" not in ls.state


def test_model_names() -> None:
    assert livestatus.model_name("global.anthropic.claude-fable-5-1") == "Claude Fable 5.1"
    assert livestatus.model_name("eu.amazon.nova-2-lite-v1:0") == "Nova"
    assert livestatus.model_name("something-else") == "the AI"


@pytest.mark.parametrize(
    "dirty",
    [
        "Cutting https://bucket.s3.amazonaws.com/jobs/x/clip.mp4?X-Amz-Signature=abc",
        "Reading /app/work/01JOB/source/audio.m4a now",
        "token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh",
        "proxy http://user:secret@10.0.0.1:8080/x",
    ],
)
def test_scrub_removes_links_paths_and_keys(dirty: str) -> None:
    out = scrub(dirty, 80)
    for bad in ("https://", "/app/work", "eyJhbGci", "secret", "X-Amz-Signature=abc", "s3.amazonaws"):
        assert bad not in out


def test_scrub_caps_and_keeps_one_line() -> None:
    assert scrub("a\nb\tc", 80) == "a b c"
    out = scrub("x" * 10 + " " + "word " * 40, 80)
    assert len(out) <= 80 and out.endswith("…")


async def test_note_text_is_scrubbed_and_capped() -> None:
    ls, _ = live()
    ls.emit("step", key="render")
    ls.emit("note", text="Saving /app/work/01JOB/clips/a/clip.mp4 " + "very long " * 20)
    assert "/app/work" not in ls.state["text"] and len(ls.state["text"]) <= livestatus.MAX_TEXT


async def test_throttle_one_write_per_second_and_only_when_changed() -> None:
    clock = Clock()
    ls, written = live(clock)
    assert await ls.flush() is False  # nothing to say yet
    ls.emit("step", key="render")
    assert await ls.flush() is True
    ls.emit("cut", i=1, n=10)
    assert await ls.flush() is False  # under a second since the last write
    clock.t += 1.0
    assert await ls.flush() is True
    clock.t += 5
    assert await ls.flush() is False  # nothing changed, refresh not due
    ls.emit("cut", i=1, n=10)
    assert await ls.flush() is False  # the same words again are not a change
    assert [w["text"] for w in written] == ["Cutting the clips", "Cutting clip 1 of 10"]


async def test_refresh_every_30_seconds_while_nothing_changes() -> None:
    clock = Clock()
    ls, written = live(clock)
    ls.emit("step", key="select")
    await ls.flush()
    clock.t += 29
    assert await ls.flush() is False
    clock.t += 1
    assert await ls.flush() is True
    assert len(written) == 2 and written[0]["text"] == written[1]["text"]


async def test_the_item_carries_the_job_session_time_and_ttl() -> None:
    ls, written = live()
    ls.emit("step", key="render")
    ls.emit("cut", i=2, n=5)
    await ls.flush(force=True)
    item = written[-1]
    assert item["jobId"] == "J1" and item["sessionId"] == "S1" and item["step"] == "render"
    assert item["i"] == 2 and item["n"] == 5 and item["at"].endswith("Z")
    assert item["ttl"] > 0
    assert set(item) <= {
        "jobId",
        "sessionId",
        "step",
        "text",
        "detail",
        "tech",
        "since",
        "i",
        "n",
        "pct",
        "at",
        "lastChange",
        "ttl",
    }


async def test_a_failed_write_is_logged_and_never_raises() -> None:
    async def boom(item: dict[str, Any]) -> None:
        raise RuntimeError("ddb down")

    ls = LiveStatus(boom, "J1", "S1", now=Clock())
    ls.emit("step", key="render")
    assert await ls.flush(force=True) is False


async def test_emit_outside_a_job_does_nothing() -> None:
    livestatus.emit("cut", i=1, n=2)  # no line in this context: no error
    with livestatus.thinking("x"):
        pass


def test_tool_progress_readers() -> None:
    seen = parse_ytdlp("[download]  34.2% of ~  1.20GiB at    4.10MiB/s ETA 00:12 (frag 3/90)")
    assert seen is not None and seen["pct"] == 34.2 and round(seen["total"] / 1024**3, 2) == 1.2
    assert round(seen["speed"] / 1024**2, 2) == 4.1
    assert parse_ytdlp("[download] Destination: /tmp/x.m4a") is None
    assert parse_ffmpeg_progress("out_time_us=41000000") == 41.0
    assert parse_ffmpeg_progress("out_time_ms=1500000") == 1.5
    assert parse_ffmpeg_progress("out_time_us=N/A") is None
    assert parse_ffmpeg_progress("frame=12") is None


class LiveStore(FakeStore):
    def __init__(self, session: str | None = None) -> None:
        super().__init__(session)
        self.live: list[dict[str, Any]] = []

    async def put_live(self, user_id: str, item: dict[str, Any]) -> None:
        self.live.append(item)


async def test_the_tracker_writes_each_step_and_its_notes_to_the_live_line() -> None:
    store = LiveStore("S1")
    tr = Tracker(store, "U", "J", session_id="S1", heartbeat=0.05, flush=0.01)

    async def render() -> str:
        livestatus.emit("cut", i=1, n=3)
        tr.say("Saving clip 1 of 3…")
        await asyncio.sleep(1.6)  # long enough for the throttled loop (1 s gap, 0.25 s ticks) to write
        return "Cut 3 clips."

    status = await run_job(tr, ok_steps(render=render), clip_count=lambda: 3)
    assert status == "ready"
    texts = [w["text"] for w in store.live]
    assert "Finding the video" in texts and "Cutting the clips" in texts
    assert "Saving clip 1 of 3" in texts
    assert all(w["sessionId"] == "S1" for w in store.live)
    assert tr.live is not None and tr.live.closed  # no writes after the job ended


async def test_a_resumed_run_says_it_picks_up_where_it_stopped() -> None:
    store = LiveStore("S1")
    resume = {"pickUp": True, "steps": [{"key": "resolve", "status": "done"}, {"key": "download", "status": "done"}]}
    tr = Tracker(store, "U", "J", session_id="S1", heartbeat=0.05, flush=0.01, resume=resume)
    await tr.begin()
    try:
        assert tr.live is not None
        assert tr.live.state["text"] == "Picking up where it stopped"
        assert tr.live.state["detail"] == "2 steps already done"
    finally:
        await tr.stop()


async def test_a_live_update_is_a_sign_of_life_for_the_step_watchdog() -> None:
    store = LiveStore("S1")
    tr = Tracker(store, "U", "J", session_id="S1", stall_seconds={"render": 0.3}, watch_tick=0.05)
    await tr.begin()
    try:
        await tr.start("render")

        async def busy() -> str:
            for _ in range(10):  # 0.6 s in all, longer than the 0.3 s limit, but alive the whole time
                await asyncio.sleep(0.06)
                livestatus.emit("cut_progress", at=_, length=10)
            return "done"

        assert await watched(tr, "render", busy) == "done"
    finally:
        await tr.stop()


async def test_a_store_without_put_live_has_no_line() -> None:
    tr = Tracker(FakeStore(), "U", "J")
    assert tr.live is None
    tr.say("anything")  # no error


async def test_clips_cut_at_the_same_time_never_mix_their_numbers() -> None:
    ls, _ = live()
    ls.emit("step", key="render")
    ls.emit("cut", i=2, n=10)
    ls.emit("cut", i=3, n=10)
    ls.emit("cut_progress", i=2, at=12, length=58, w=1080, h=1920, fps=30)
    ls.emit("cut_progress", i=3, at=40, length=45, w=1080, h=1920, fps=30)  # not on the line: kept, not shown
    assert (ls.state["text"], ls.state["detail"], ls.state["pct"]) == ("Cutting clip 2 of 10", "0:12 of 0:58", 20)
    assert ls.state["tech"] == "ffmpeg · 1080×1920 · 30 fps"
    ls.emit("cut_done", i=2)  # clip 3 takes the line with its own numbers
    assert (ls.state["text"], ls.state["detail"], ls.state["pct"]) == ("Cutting clip 3 of 10", "0:40 of 0:45", 88)
    ls.emit("cut", i=4, n=10)
    assert ls.state["text"] == "Cutting clip 3 of 10"  # the lowest clip still being cut stays on the line
    ls.emit("cut_done", i=3)
    assert ls.state["text"] == "Cutting clip 4 of 10" and "detail" not in ls.state


async def test_the_ffmpeg_words_come_from_the_render_size() -> None:
    ls, _ = live()
    ls.emit("cut", i=1, n=2)
    ls.emit("cut_progress", i=1, at=1, length=10, w=720, h=1280, fps=24)
    assert ls.state["tech"] == "ffmpeg · 720×1280 · 24 fps"
    ls.emit("cut_progress", i=1, at=2, length=10)
    assert ls.state["tech"] == "ffmpeg"


async def test_the_full_video_download_has_its_own_words() -> None:
    ls, _ = live()
    ls.emit("step", key="render")
    ls.emit("download", full=True, pct=10.0, got=1e8, total=1e9, speed=2e6)
    assert ls.state["text"] == "Getting the full video"
    assert ls.state["detail"] == "100 MB of 1.0 GB · 10%"
    ls.emit("download", pct=10.0, got=1e8, total=1e9, speed=2e6)
    assert ls.state["text"] == "Getting the video"


async def test_parts_are_counted_as_done_not_as_the_one_being_worked_on() -> None:
    ls, _ = live()
    ls.emit("transcribe_part", i=0, n=8)
    assert ls.state["detail"] == "0 of 8 parts done"
    ls.emit("watch_part", i=2, n=5)
    assert ls.state["detail"] == "2 of 5 parts done"


async def test_the_item_says_when_the_words_last_really_changed() -> None:
    ls, written = live()
    ls.emit("step", key="select")
    first = ls._changed_at
    await ls.flush(force=True)
    await asyncio.sleep(1.1)
    await ls.flush(force=True)  # the refresh: a new ``at``, the same ``lastChange``
    assert written[1]["lastChange"] == written[0]["lastChange"] == first
    assert written[1]["at"] >= written[0]["at"]
    await asyncio.sleep(1.1)
    ls.emit("note", text="Picking clip 2 of 4")
    await ls.flush(force=True)
    assert written[2]["lastChange"] > first


async def test_a_failed_write_is_tried_again_not_lost() -> None:
    clock = Clock()
    calls: list[str] = []

    async def flaky(item: dict[str, Any]) -> None:
        calls.append(item["text"])
        if len(calls) == 1:
            raise RuntimeError("throttled")

    ls = LiveStatus(flaky, "J1", "S1", now=clock)
    ls.emit("step", key="render")
    assert await ls.flush() is False  # failed
    assert await ls.flush() is False  # retry waits one gap
    clock.t += 1.0
    assert await ls.flush() is True  # and then goes out, long before the 30 s refresh
    assert calls == ["Cutting the clips", "Cutting the clips"]


async def test_two_writes_at_once_land_in_order_and_the_newest_is_last() -> None:
    order: list[str] = []
    gate = asyncio.Event()

    async def slow(item: dict[str, Any]) -> None:
        if item["text"] == "Cutting the clips":
            await gate.wait()  # the first write is slow
        order.append(item["text"])

    ls = LiveStatus(slow, "J1", "S1", now=Clock())
    ls.emit("step", key="render")
    first = asyncio.create_task(ls.flush(force=True))
    await asyncio.sleep(0.05)
    ls.emit("step", key="checklist")
    second = asyncio.create_task(ls.flush(force=True))
    await asyncio.sleep(0.05)
    gate.set()
    await asyncio.gather(first, second)
    assert order == ["Cutting the clips", "Checking the clips with Claude"]
