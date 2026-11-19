"""YouTube from the cloud (docs/CONTRACTS.md §29): the PO token sidecar, the yt-dlp arguments, the owner's words, and
the Cut step's order: one saved ``-J``, sections from it, one refresh, one full download, local cuts."""

from __future__ import annotations

import asyncio
import json
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from clipfactory_agent import pipeline as pipeline_mod
from clipfactory_agent import pot, proc, sources
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.pipeline import JobState, Pipeline, cut_failure
from clipfactory_agent.render import RenderResult
from clipfactory_agent.util import TransientError, UserFacingError

from .conftest import make_moment
from .test_fixes import FakeTracker

GB = 1024**3
YT = "https://www.youtube.com/watch?v=abc"
BOT = "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies"
E403 = "ERROR: unable to download video data: HTTP Error 403: Forbidden"
ROTATED = (
    "WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in "
    "the browser as a security measure. ERROR: [youtube] abc: Sign in to confirm you’re not a bot"
)


def info(seconds: float = 6060.0) -> dict[str, Any]:
    """A 1 h 41 min video: 1080p60 and 720p H.264, VP9, and an m4a audio track."""
    mbit = 1000 * 1000 / 8 * seconds  # bytes for one Mbit/s over the whole video
    return {
        "id": "abc",
        "duration": seconds,
        "webpage_url": YT,
        "formats": [
            {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": int(0.13 * mbit)},
            {"format_id": "299", "height": 1080, "vcodec": "avc1.64002a", "acodec": "none", "tbr": 3200},
            {"format_id": "298", "height": 720, "vcodec": "avc1.4d4020", "acodec": "none", "tbr": 1800},
            {"format_id": "135", "height": 480, "vcodec": "avc1.4d401f", "acodec": "none", "tbr": 700},
            {"format_id": "303", "height": 1080, "vcodec": "vp9", "acodec": "none", "tbr": 9000},
        ],
    }


# --- yt-dlp arguments ------------------------------------------------------------------------------------------


@pytest.fixture
def seen(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[list[str]]:
    calls: list[list[str]] = []

    async def run(cmd: list[str], **kw: Any) -> proc.Result:
        calls.append(list(cmd))
        if "-o" in cmd:
            out = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "m4a" if "-x" in cmd else "mp4"))
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"x")
        return proc.Result(json.dumps(info()).encode(), "")

    monkeypatch.setattr(proc, "run", run)
    monkeypatch.setenv("CF_POT_HOME", "/opt/bgutil/server")
    return calls


async def every_download(url: str, tmp_path: Path, **kw: Any) -> None:
    await sources.video_info(url, **kw)
    await sources.download_audio(url, tmp_path / "a", max_seconds=None, **kw)
    await sources.download_picture(url, "135", tmp_path / "p" / "picture.mp4", est_bytes=1, max_seconds=None, **kw)
    await sources.download_section(url, 1, 2, tmp_path / "s" / "s.mp4", **kw)


async def test_youtube_args_have_pot_and_clients(seen: list[list[str]], tmp_path: Path) -> None:
    await every_download(YT, tmp_path)
    await sources.download_section("ignored", 1, 2, tmp_path / "s2" / "s.mp4", info_json=tmp_path / "i.json")
    await sources.download_full(YT, "18", tmp_path / "f" / "full.mp4", est_bytes=100)
    assert len(seen) == 6
    for cmd in seen:
        pairs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--extractor-args"]
        assert pairs == ["youtube:player_client=default,mweb", "youtubepot-bgutilscript:server_home=/opt/bgutil/server"]
        assert "--no-warnings" not in cmd and "--proxy" not in cmd
    loaded = seen[4]
    assert loaded[loaded.index("--load-info-json") + 1] == str(tmp_path / "i.json") and "ignored" not in loaded
    full = seen[5]
    assert full[full.index("--http-chunk-size") + 1] == "10M" and full[full.index("--max-filesize") + 1] == "150"
    assert full[full.index("--merge-output-format") + 1] == "mp4"


@pytest.mark.parametrize("url", ["https://www.twitch.tv/videos/1", "https://kick.com/x/videos/abc"])
async def test_twitch_and_kick_arguments_are_unchanged(seen: list[list[str]], tmp_path: Path, url: str) -> None:
    await every_download(url, tmp_path, proxy="http://u:p@proxy:1")
    for cmd in seen:
        assert "--no-warnings" in cmd and "--extractor-args" not in cmd and "--proxy" not in cmd


async def test_proxy_added_to_youtube_args_only(seen: list[list[str]], tmp_path: Path) -> None:
    await every_download(YT, tmp_path, proxy="http://u:p@proxy:1")
    assert all(cmd[cmd.index("--proxy") + 1] == "http://u:p@proxy:1" for cmd in seen)
    assert sources.youtube_args(Path("/c.txt"))[-2:] == ["--cookies", "/c.txt"]


def test_no_pot_home_no_script_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CF_POT_HOME", raising=False)
    assert sources.youtube_args() == ["--extractor-args", "youtube:player_client=default,mweb"]


async def test_video_info_saves_the_json(seen: list[list[str]], tmp_path: Path) -> None:
    path = tmp_path / "source" / "cut-info.json"
    got = await sources.video_info(YT, info_json=path)
    assert json.loads(path.read_bytes()) == got


# --- the owner's words -----------------------------------------------------------------------------------------


def err(tail: str) -> proc.CommandError:
    return proc.CommandError("yt-dlp", 1, tail)


def test_explain_rotated_cookies_says_cookies_ran_out() -> None:
    e = sources.explain(err(ROTATED), "youtube", True)
    assert str(e) == sources.COOKIES_EXPIRED and sources.kind_of(e) == "cookies"
    # Without cookies the same text is the bot check.
    assert str(sources.explain(err(ROTATED), "youtube", False)) == sources.BLOCKED_NO_COOKIES


def test_explain_kinds() -> None:
    assert sources.kind_of(sources.explain(err(BOT), "youtube", True)) == "blocked"
    assert sources.kind_of(sources.explain(err(E403), "youtube", True, section=True)) == "retry"
    assert sources.kind_of(sources.explain(err("Read timed out"), "youtube", True, section=True)) == "transient"
    assert sources.kind_of(sources.explain(err("ERROR: Video unavailable"), "youtube", True)) == "gone"
    assert sources.kind_of(sources.explain(err("ERROR: odd"), "youtube", True)) == "other"
    assert sources.kind_of(ValueError()) == "other"


RAW = ("yt-dlp", "ffmpeg", "error:", "http", "403", "--", "cookies.txt", "googlevideo", "player", "po token", "retry")


def test_explain_words_never_carry_ytdlp_text() -> None:
    tails = [BOT, E403, ROTATED, "ERROR: [youtube] abc: KeyError('streamingData')", "fragment 3 not found"]
    texts = list(sources.OWNER_WORDS)
    for t in tails:
        for cookies in (False, True):
            e = sources.explain(err(t), "youtube", cookies)
            if isinstance(e, UserFacingError):
                texts.append(str(e))
    assert len(texts) > len(sources.OWNER_WORDS)
    for t in texts:
        low = t.lower()
        assert "Try again" in t or "Use a video file" in t, t
        assert "the agent" not in low and "Retry" not in t, t
        assert not any(r in low for r in RAW), t
        assert len(t) <= 160, t


def test_cut_failure_order() -> None:
    gone = "This video is private or members-only, so it can't be downloaded."
    assert cut_failure([]) == sources.CUT_FAILED
    assert cut_failure([gone]) == gone
    assert cut_failure([sources.CUT_TOO_BIG, sources.COOKIES_EXPIRED]) == sources.COOKIES_EXPIRED
    assert cut_failure([sources.CUT_TOO_BIG, gone]) == sources.CUT_TOO_BIG
    assert cut_failure([gone, sources.COOKIES_EXPIRED, sources.BLOCKED_WITH_COOKIES]) == sources.CUT_BLOCKED


# --- the full download's format --------------------------------------------------------------------------------


def test_full_format_ladder() -> None:
    i, seconds = info(), 6060.0
    est = {h: sources.full_format(i, seconds, 100 * GB, reserve=0)["estBytes"] for h in (1080,)}  # type: ignore[index]
    want_1080 = int((3200 * 1000 * seconds / 8 + 0.13 * 1000 * 1000 / 8 * seconds) * 1.1)
    assert abs(est[1080] - want_1080) <= 2  # the H.264 rung, never the bigger VP9 one
    reserve = sources.DISK_RESERVE
    pick = sources.full_format(i, seconds, reserve + want_1080 + 1)
    assert pick and pick["height"] == 1080 and pick["format"] == sources.VIDEO_FORMAT
    pick = sources.full_format(i, seconds, reserve + want_1080 - 1)
    assert pick and pick["height"] == 720 and "height<=720" in pick["format"]
    pick = sources.full_format(i, seconds, reserve + int(0.9 * GB))
    assert pick and pick["height"] == 480
    assert sources.full_format(i, seconds, reserve + 1000) is None
    assert sources.full_format({"formats": []}, seconds, 100 * GB) is None


# --- the Cut step --------------------------------------------------------------------------------------------------


class Tube:
    """yt-dlp and ffmpeg for one YouTube job: what each section, the -J and the full download do, and every command."""

    def __init__(self, tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.cmds: list[list[str]] = []
        self.info_error: str | None = None
        self.info_errors: list[str] = []  # popped per -J before info_error applies
        self.cookie_files: list[tuple[str, int]] = []  # each yt-dlp call's --cookies path and its mode
        self.section_errors: list[str] = []  # popped per section download; empty = works
        self.section_always: str | None = None
        self.full_error: str | None = None
        self.ffmpeg_fail_at: set[float] = set()
        self.free = 100 * GB
        self.tmp = tmp

        async def run(cmd: list[str], **kw: Any) -> proc.Result:
            self.cmds.append(list(cmd))
            await asyncio.sleep(0.01)  # let the parallel cut interleave
            if cmd[0] == "ffmpeg":
                if float(cmd[cmd.index("-ss") + 1]) in self.ffmpeg_fail_at:
                    raise proc.CommandError("ffmpeg", 1, "Invalid data found when processing input")
                Path(cmd[-1]).write_bytes(b"cut")
                return proc.Result(b"", "")
            if "--cookies" in cmd:
                ck = Path(cmd[cmd.index("--cookies") + 1])
                self.cookie_files.append((str(ck), stat.S_IMODE(ck.stat().st_mode) if ck.exists() else -1))
            if "-J" in cmd:
                problem = self.info_errors.pop(0) if self.info_errors else self.info_error
                if problem:
                    raise err(problem)
                return proc.Result(json.dumps(info()).encode(), "")
            out = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "mp4"))
            if out.name == "full.mp4":
                if self.full_error:
                    raise err(self.full_error)
            elif "--download-sections" in cmd:
                problem = self.section_errors.pop(0) if self.section_errors else self.section_always
                if problem:
                    raise err(problem)
            elif self.full_error:
                raise err(self.full_error)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"video")
            return proc.Result(b"", "")

        async def render_clip(m: Any, *, workdir: Path, fetch_section: Any, **kw: Any) -> RenderResult:
            workdir.mkdir(parents=True, exist_ok=True)
            src = await fetch_section(m.start, m.end, workdir / "src.mp4")
            return RenderResult(src, src, 30.0, [(m.start, m.end)], [], "blur_fill", False)

        monkeypatch.setattr(proc, "run", run)
        monkeypatch.setattr(pipeline_mod, "render_clip", render_clip)
        monkeypatch.setattr(pipeline_mod.shutil, "disk_usage", lambda p: SimpleNamespace(free=self.free))
        monkeypatch.setattr("clipfactory_agent.retry.random.random", lambda: 0.0)
        monkeypatch.setattr("clipfactory_agent.retry.asyncio.sleep", _no_sleep)

    def kinds(self) -> list[str]:
        out = []
        for c in self.cmds:
            if c[0] == "ffmpeg":
                out.append("local" if "full.mp4" in c[c.index("-i") + 1] else "ffmpeg")
            elif "-J" in c:
                out.append("info")
            elif "full.%(ext)s" in c[c.index("-o") + 1]:
                out.append("full")
            elif "--download-sections" in c:
                out.append("section+json" if "--load-info-json" in c else "section")
            else:
                out.append("full")
        return out

    def state(self, n: int) -> JobState:
        st = JobState(job_id="J", user_id="u", workdir=self.tmp / "work")
        st.source = {"type": "link", "platform": "youtube", "url": YT, "durationSec": 6060.0}
        st.meta = {"webpageUrl": YT}
        st.chosen = [make_moment(start=100 + 100 * i, end=130 + 100 * i) for i in range(n)]
        st.skills_block = SimpleNamespace()  # type: ignore[assignment]
        return st


_real_sleep = asyncio.sleep


async def _no_sleep(*_: Any) -> None:
    await _real_sleep(0)


def pipe() -> Pipeline:
    p = Pipeline(SimpleNamespace(youtube_proxy_secret=None, region="eu-north-1"), None, None, None)  # type: ignore[arg-type]
    p.claude = lambda st: SimpleNamespace(detect_layout=lambda *a, **k: None)  # type: ignore[method-assign]
    return p


@pytest.fixture
def tube(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Tube:
    return Tube(tmp_path, monkeypatch)


async def test_cut_sections_use_one_saved_info(tube: Tube) -> None:
    p, st = pipe(), tube.state(3)
    assert await p.render(st, FakeTracker()) == "Cut 3 clips."  # type: ignore[arg-type]
    assert tube.kinds() == ["info", "section+json", "section+json", "section+json"]
    assert st.info_json == tube.tmp / "work" / "source" / "cut-info.json" and st.info_json.is_file()


async def test_cut_fallback_order(tube: Tube) -> None:
    """A 403, one refresh, a second 403, then exactly one full download even with two cuts at once; every later
    clip is cut from the local file, and the file is gone at the end."""
    tube.section_always = E403
    p, st = pipe(), tube.state(4)
    assert await p.render(st, FakeTracker()) == "Cut 4 clips."  # type: ignore[arg-type]
    k = tube.kinds()
    assert k[:2] == ["info", "section+json"]
    assert k.count("info") == 2 and k.count("full") == 1 and k.count("local") == 4
    assert k.index("full") < min(i for i, x in enumerate(k) if x == "local")
    assert k[k.index("info", 1) - 1] == "section+json"  # the refresh came after a failed section
    assert all(x == "local" for x in k[k.index("full") + 1 :])
    full = st.full_source
    assert full is not None and full.is_file()
    full_cmd = next(c for c in tube.cmds if tube.kinds()[tube.cmds.index(c)] == "full")
    assert full_cmd[full_cmd.index("-f") + 1] == sources.VIDEO_FORMAT and "--load-info-json" in full_cmd
    await p.close(st)
    assert not full.exists() and not (tube.tmp / "work" / "source" / "cut-info.json").exists()


async def test_section_works_after_the_refresh(tube: Tube) -> None:
    tube.section_errors = [E403]
    p, st = pipe(), tube.state(1)
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert tube.kinds() == ["info", "section+json", "info", "section+json"]


async def test_cut_blocked_on_first_try_goes_straight_to_full(tube: Tube) -> None:
    tube.section_always = BOT
    p, st = pipe(), tube.state(2)
    assert await p.render(st, FakeTracker()) == "Cut 2 clips."  # type: ignore[arg-type]
    k = tube.kinds()
    assert k.count("info") == 1 and k.count("full") == 1 and k.count("local") == 2


async def test_one_clip_failing_still_finishes(tube: Tube) -> None:
    tube.section_always = E403
    # The full download is the clips' range from 40 s (100 s minus FULL_PAD), so clip 1 at 200 s is at 160 s in it.
    tube.ffmpeg_fail_at = {160.0}
    p, st = pipe(), tube.state(3)
    assert await p.render(st, FakeTracker()) == "Cut 2 clips; 1 could not be cut."  # type: ignore[arg-type]
    assert [c.index for c in st.candidates] == [0, 2]


async def test_all_clips_blocked_says_cut_blocked(tube: Tube) -> None:
    tube.section_always = BOT
    tube.full_error = BOT
    p, st = pipe(), tube.state(3)
    with pytest.raises(UserFacingError) as e:
        await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert str(e.value) == sources.CUT_BLOCKED
    assert tube.kinds().count("full") == 1  # the failure is remembered; the other clips do not try again


async def test_info_blocked_at_the_start_says_cut_blocked(tube: Tube) -> None:
    tube.info_error = BOT
    with pytest.raises(UserFacingError) as e:
        await pipe().render(tube.state(2), FakeTracker())  # type: ignore[arg-type]
    assert str(e.value) == sources.CUT_BLOCKED and tube.kinds() == ["info"]


async def test_info_other_failure_falls_back_to_plain_sections(tube: Tube) -> None:
    tube.info_error = "ERROR: something odd"
    p, st = pipe(), tube.state(1)
    assert await p.render(st, FakeTracker()) == "Cut 1 clip."  # type: ignore[arg-type]
    assert tube.kinds() == ["info", "section"]


async def test_rotated_cookies_say_so(tube: Tube) -> None:
    tube.info_error = ROTATED
    st = tube.state(1)
    st.cookies = tube.tmp / "cookies.txt"
    with pytest.raises(UserFacingError) as e:
        await pipe().render(st, FakeTracker())  # type: ignore[arg-type]
    assert str(e.value) == sources.COOKIES_EXPIRED


async def test_too_big_says_use_a_file(tube: Tube) -> None:
    tube.section_always = BOT
    tube.free = sources.DISK_RESERVE + 1000
    p, st = pipe(), tube.state(2)
    with pytest.raises(UserFacingError) as e:
        await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert str(e.value) == sources.CUT_TOO_BIG and "full" not in tube.kinds()


async def test_twitch_sections_keep_their_retry(tube: Tube) -> None:
    tube.section_errors = [E403]
    p, st = pipe(), tube.state(1)
    st.source = {"type": "link", "platform": "twitch", "url": "https://www.twitch.tv/videos/1"}
    st.meta = {}
    assert await p.render(st, FakeTracker()) == "Cut 1 clip."  # type: ignore[arg-type]
    assert tube.kinds() == ["section", "section"]


async def test_a_failing_clip_still_lets_the_job_finish(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """End to end: one picked moment cannot be cut, the job still reaches the checklist and ends ready."""
    from .test_pipeline import World

    world = World(tmp_path, monkeypatch)
    real = pipeline_mod.render_clip

    async def render_clip(m: Any, **kw: Any) -> Any:
        if m.start == 100:
            raise UserFacingError(sources.CUT_FAILED)
        return await real(m, **kw)

    monkeypatch.setattr(pipeline_mod, "render_clip", render_clip)
    status, st, steps = await world.run()
    assert steps["render"]["message"] == "Cut 1 clip; 1 could not be cut."
    assert steps["checklist"]["status"] == "done" and status == "ready"
    assert all(isinstance(c, Candidate) for c in st.candidates) and st.candidates


# --- the optional proxy ----------------------------------------------------------------------------------------


async def test_proxy_secret_missing_is_fine(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    p = pipe()
    st = JobState(job_id="J", user_id="u", workdir=Path("/tmp/none"))
    assert await p._youtube_proxy(st) is None  # no secret name: nothing is read
    p.cfg = SimpleNamespace(youtube_proxy_secret="cf-prod/agent/youtube-proxy", region="eu-north-1")  # type: ignore[assignment]
    values: list[str | None] = [None, "", "not a url", "http://user:hunter2@proxy.example:8080"]

    def read(name: str, region: str) -> str | None:
        assert name == "cf-prod/agent/youtube-proxy"
        return values.pop(0)

    monkeypatch.setattr(pipeline_mod, "read_secret", read)
    assert [await p._youtube_proxy(st) for _ in range(3)] == [None, None, None]
    assert await p._youtube_proxy(st) == "http://user:hunter2@proxy.example:8080"

    def denied(name: str, region: str) -> str | None:
        raise RuntimeError("AccessDenied")

    monkeypatch.setattr(pipeline_mod, "read_secret", denied)
    assert await p._youtube_proxy(st) is None
    assert "hunter2" not in capsys.readouterr().out


def test_read_secret_missing_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    class NotFound(Exception):
        pass

    class Client:
        exceptions = SimpleNamespace(ResourceNotFoundException=NotFound)

        def get_secret_value(self, SecretId: str) -> dict[str, str]:
            if SecretId == "gone":
                raise NotFound()
            return {"SecretString": "http://p:1"}

    import boto3

    monkeypatch.setattr(boto3, "client", lambda *a, **k: Client())
    assert pipeline_mod.read_secret("gone", "eu-north-1") is None
    assert pipeline_mod.read_secret("there", "eu-north-1") == "http://p:1"


# --- the PO token sidecar --------------------------------------------------------------------------------------


def test_pot_command_is_loopback_and_read_only() -> None:
    cmd = pot.command(Path("/opt/bgutil/server"))
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1" and cmd[cmd.index("--port") + 1] == "4416"
    assert not any(a.startswith("--allow-write") or a in ("-A", "--allow-all", "--allow-run") for a in cmd)
    assert "--allow-read=/opt/bgutil/server/node_modules" in cmd and cmd[-5].endswith("src/main.ts")


async def test_pot_server_restart_and_off(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "server"
    (home / "src").mkdir(parents=True)
    (home / "src" / "main.ts").write_text("")
    count = tmp_path / "starts"
    deno = tmp_path / "deno"
    deno.write_text(f"#!/bin/sh\necho x >> {count}\nexit 3\n")
    deno.chmod(deno.stat().st_mode | stat.S_IEXEC)

    assert pot.from_env({"CF_POT": "off", "CF_POT_HOME": str(home)}) is None
    assert pot.from_env({"CF_POT_HOME": str(tmp_path / "nowhere")}) is None
    assert await pot.start({"CF_POT": "off", "CF_POT_HOME": str(home)}) is None
    assert await pot.ready(0.1) is True  # nothing to wait for

    server = pot.from_env({"CF_POT_HOME": str(home), "CF_POT_DENO": str(deno)})
    assert server is not None
    server.backoff = 0.01
    monkeypatch.setattr(pot, "PORT", 1)  # nothing listens there
    server.start()
    try:
        for _ in range(200):
            if count.is_file() and len(count.read_text().split()) >= 3:
                break
            await asyncio.sleep(0.02)
        assert len(count.read_text().split()) >= 3  # it exited and was started again
        assert await server.ready(0.3) is False
    finally:
        await server.stop()
    n = len(count.read_text().split())
    await asyncio.sleep(0.1)
    assert len(count.read_text().split()) == n  # stopped for good


async def test_pot_ready_waits_for_ping(monkeypatch: pytest.MonkeyPatch) -> None:
    answers = iter([False, False, True])

    async def ping(within: float = 2.0) -> bool:
        return next(answers)

    monkeypatch.setattr(pot, "ping", ping)
    monkeypatch.setattr(pot.asyncio, "sleep", _no_sleep)
    assert await pot.PotServer(Path("/x")).ready(5) is True


async def test_ping_reads_a_real_http_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    async def handle(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        await r.readline()
        w.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"version":"2.0.2"}')
        await w.drain()
        w.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    monkeypatch.setattr(pot, "PORT", server.sockets[0].getsockname()[1])
    try:
        assert await pot.ping() is True
    finally:
        server.close()
        await server.wait_closed()


def test_transient_section_error_is_still_retried() -> None:
    e = sources.explain(err("Read timed out"), "youtube", False, section=True)
    assert isinstance(e, TransientError)


def test_error_tail_keeps_the_stale_cookies_warning() -> None:
    text = "\n".join(
        [
            "WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated",
            *[f"WARNING: [youtube] abc: unable to extract thing {i}" for i in range(5)],
            "ERROR: [youtube] abc: Sign in to confirm you’re not a bot",
        ]
    )
    tail = proc.error_tail(text)
    assert tail.startswith("WARNING: [youtube] The provided YouTube account cookies are no longer valid")
    assert tail.endswith("not a bot")
    assert str(sources.explain(err(tail), "youtube", True)) == sources.COOKIES_EXPIRED


# --- review fixes: stale cookies, 429, the range download, the -J retry, own cookie files, redaction -----------------

STALE = (
    "WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in "
    "the browser as a security measure."
)


def test_stale_cookies_with_a_403_stay_a_retry() -> None:
    """The stale warning only blames the cookies when the error is the bot check; a 403 still goes to the fallback."""
    e = sources.explain(err(f"{STALE} {E403}"), "youtube", True, section=True)
    assert sources.kind_of(e) == "retry"
    e = sources.explain(
        err(f"{STALE} ERROR: [download] Got error: fragment 3 not found"), "youtube", True, section=True
    )
    assert sources.kind_of(e) == "retry"
    e = sources.explain(err(f"{STALE} {BOT}"), "youtube", True, section=True)
    assert str(e) == sources.COOKIES_EXPIRED and sources.kind_of(e) == "cookies"


def test_section_429_goes_to_the_fallback() -> None:
    t = "ERROR: unable to download video data: HTTP Error 429: Too Many Requests"
    assert sources.kind_of(sources.explain(err(t), "youtube", True, section=True)) == "retry"
    assert sources.kind_of(sources.explain(err(t), "youtube", True)) == "transient"


async def test_stale_cookies_and_403_sections_still_cut_from_the_full_download(tube: Tube) -> None:
    tube.section_always = f"{STALE} {E403}"
    p, st = pipe(), tube.state(2)
    st.cookies = tube.tmp / "work" / "cookies.txt"
    st.cookies.parent.mkdir(parents=True, exist_ok=True)
    st.cookies.write_text("# Netscape HTTP Cookie File\n")
    assert await p.render(st, FakeTracker()) == "Cut 2 clips."  # type: ignore[arg-type]
    assert tube.kinds().count("full") == 1 and tube.kinds().count("local") == 2


async def test_full_fallback_downloads_only_the_clips_range(tube: Tube) -> None:
    """Clips at 100–430 s of a 1 h 41 min video: the full download is 40–490 s, and the cuts are shifted by 40 s."""
    tube.section_always = BOT
    p, st = pipe(), tube.state(4)
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    full = next(c for c, k in zip(tube.cmds, tube.kinds(), strict=True) if k == "full")
    assert full[full.index("--download-sections") + 1] == "*40.00-490.00" and "--max-filesize" not in full
    starts = sorted(float(c[c.index("-ss") + 1]) for c, k in zip(tube.cmds, tube.kinds(), strict=True) if k == "local")
    assert starts == [60.0, 160.0, 260.0, 360.0]


def test_full_plan_whole_or_range() -> None:
    i = info()
    whole = pipeline_mod.full_plan(i, 6060.0, (100.0, 5000.0), 100 * GB)
    assert whole is not None and whole[1] is None  # spread over most of the video: the sturdier whole download
    part = pipeline_mod.full_plan(i, 6060.0, (100.0, 400.0), 100 * GB)
    assert part is not None and part[1] == (40.0, 460.0)
    # A 4 h stream that does not fit the disk whole still fits as the clips' range.
    long = info(4 * 3600.0)
    free = sources.DISK_RESERVE + 1 * GB
    assert sources.full_format(long, 4 * 3600.0, free) is None
    plan = pipeline_mod.full_plan(long, 4 * 3600.0, (600.0, 7000.0), free)
    assert plan is not None and plan[1] == (540.0, 7060.0)
    assert pipeline_mod.full_plan(long, 4 * 3600.0, None, free) is None


def test_full_format_time_limit_and_unknown_sizes() -> None:
    i = info()
    # At 0.4 MB/s the 1080p rung (about 2.8 GB) would take longer than 90 min: the next one that fits in time wins.
    pick = sources.full_format(i, 6060.0, 100 * GB, rate=400_000)
    assert pick is not None and pick["height"] < 1080
    bare = {"duration": 3600.0, "formats": [{"format_id": "1", "height": 1080, "vcodec": "avc1", "acodec": "none"}]}
    pick = sources.full_format(bare, 3600.0, 100 * GB)
    assert pick is not None and pick["estBytes"] >= 5_000_000 * 3600 // 8  # never "about 0"
    assert sources.full_format(bare, 3600.0, sources.DISK_RESERVE + 1 * GB) is None


async def test_full_fallback_retries_a_missing_info(tube: Tube) -> None:
    """The first -J timed out (kind other); the fallback asks once more instead of blaming YouTube."""
    tube.info_errors = ["ERROR: Read timed out"]
    tube.section_always = BOT
    p, st = pipe(), tube.state(2)
    assert await p.render(st, FakeTracker()) == "Cut 2 clips."  # type: ignore[arg-type]
    assert tube.kinds().count("info") == 2 and tube.kinds().count("full") == 1


async def test_full_fallback_without_any_info_says_cut_failed(tube: Tube) -> None:
    tube.info_error = "ERROR: something odd"
    tube.section_always = E403
    p, st = pipe(), tube.state(1)
    with pytest.raises(UserFacingError) as e:
        await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert str(e.value) == sources.CUT_FAILED


async def test_info_json_is_replaced_whole(tube: Tube) -> None:
    p, st = pipe(), tube.state(1)
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    folder = tube.tmp / "work" / "source"
    assert [f.name for f in folder.iterdir() if f.name.endswith(".tmp")] == []
    assert json.loads((folder / "cut-info.json").read_bytes())["id"] == "abc"


async def test_every_ytdlp_call_gets_its_own_cookies_copy(tube: Tube) -> None:
    tube.section_always = E403
    p, st = pipe(), tube.state(3)
    st.cookies = tube.tmp / "work" / "cookies.txt"
    st.cookies.parent.mkdir(parents=True, exist_ok=True)
    st.cookies.write_text("# Netscape HTTP Cookie File\n")
    await p.render(st, FakeTracker())  # type: ignore[arg-type]
    paths = [path for path, _ in tube.cookie_files]
    assert len(paths) >= 4 and len(set(paths)) == len(paths) and str(st.cookies) not in paths
    assert all(mode == 0o600 for _, mode in tube.cookie_files)
    assert not any(Path(x).exists() for x in paths) and st.cookies.is_file()


def test_redact_urls_googlevideo_and_proxy_login() -> None:
    from clipfactory_agent.util import redact_urls

    media = "https://rr3---sn-abc.googlevideo.com/videoplayback?expire=1&ip=13.48.1.2&sig=AbC"
    out = redact_urls(f"ERROR: {media} 403")
    assert "13.48.1.2" not in out and "sig=AbC" not in out and "googlevideo.com/videoplayback?<redacted>" in out
    out = redact_urls("Unable to connect to proxy http://user:s3cret@proxy.example:8080")
    assert "s3cret" not in out and "user:" not in out and "http://<redacted>@proxy.example:8080" in out
    assert redact_urls("https://www.youtube.com/watch?v=abc") == "https://www.youtube.com/watch?v=abc"
