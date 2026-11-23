"""A reference video from its link (docs/CONTRACTS.md §45.40): the ``fetch_reference`` job, offline. yt-dlp is a fake
``proc.run`` that leaves a real (tiny) video where yt-dlp would, Google Drive and Dropbox a fake opener, the egress
guard a fake with the real one's ``url``, ``over`` and ``refused``. What is pinned: the yt-dlp arguments, the allowed
extractors (checked against yt-dlp's own lookup), the owner's sentences, the Drive and Dropbox rules, the fenced end
and the file deleted again when that end is refused."""

from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Callable
from pathlib import Path
from types import TracebackType
from typing import Any

import pytest

import test_tasks_support as tasks_world
from lamostories_agent import proc, reffetch, reflinks, retention
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import Services
from lamostories_agent.reffetch import FetchFailed, FetchJob
from ls_fakes import FIXTURES, PK, USER, WS, FakeModels, FakeTable, data, needs_ffmpeg
from test_chat_tools import box, error  # noqa: F401 (the chat tools' own fixture)

FOLDER = f"ws/{USER}/{WS}/references/R1/"
KEY = FOLDER + "source.mp4"
TIKTOK = "https://www.tiktok.com/@pip.the.cat/video/7301234567890123456"
DRIVE = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view"
FIXTURE = json.loads((FIXTURES / "reference_links.json").read_text("utf-8"))
GiB = 1024 * 1024 * 1024


# --- yt-dlp's arguments and extractors ---------------------------------------------------------------------------


def test_every_platform_shape_has_an_allowed_extractor() -> None:
    """yt-dlp's own extractor lookup, only over the allowed ones, takes every platform link of the fixture, and none
    of them is ``generic`` (offline: ``suitable`` only matches the address)."""
    from yt_dlp.extractor import gen_extractor_classes

    allowed = set(reffetch.extractors_ok())
    assert "generic" not in allowed
    classes = [ie for ie in gen_extractor_classes() if str(ie.IE_NAME).lower() in allowed]
    platform = [c for c in FIXTURE["cases"] if c.get("site") in reflinks.PLATFORMS]
    assert {c["site"] for c in platform} == set(reflinks.PLATFORMS)
    shares = [c for c in platform if reflinks.is_share_link(c["url"])]
    assert len(shares) == 3  # Facebook's /share/r/, /share/v/ and fb.watch
    for case in platform:
        takers = [str(ie.IE_NAME).lower() for ie in classes if ie.suitable(case["url"])]
        if case in shares:
            assert takers == [], case["url"]  # only generic would take one: the agent opens it first (open_share)
            continue
        assert takers, case["url"]
        assert "generic" not in takers
    every = [ie for ie in gen_extractor_classes() if ie.suitable("https://example.com/video.mp4")]
    assert [str(ie.IE_NAME).lower() for ie in every] == ["generic"]  # what an arbitrary page would have reached


def test_the_yt_dlp_arguments_are_pinned() -> None:
    proxy = "http://127.0.0.1:4321"
    info = reffetch.info_args(TIKTOK, proxy)
    get = reffetch.download_args(TIKTOK, proxy, 123456, Path("/tmp/ls-work/J1/get"))
    for args in (info, get):
        assert args[0] == "yt-dlp" and args[-2:] == ["--", TIKTOK]
        for flag in ("--ignore-config", "--no-playlist", "--no-cache-dir"):
            assert flag in args
        assert args[args.index("--proxy") + 1] == proxy
        extractors = args[args.index("--use-extractors") + 1].split(",")
        assert extractors == list(reffetch.EXTRACTORS) and "generic" not in extractors
        assert not [a for a in args if a.startswith(("--cookies", "--exec", "--load-info-json", "--config",
                                                     "--netrc", "--username", "--password"))]  # fmt: skip
        assert args[args.index("-f") + 1] == reffetch.FORMAT
    assert "-J" in info and "-o" not in info
    assert get[get.index("--match-filter") + 1] == "!is_live & duration <=? 600.5"
    assert get[get.index("--max-filesize") + 1] == "123456"
    assert get[get.index("-o") + 1] == "/tmp/ls-work/J1/get/source.%(ext)s"
    assert get[get.index("--merge-output-format") + 1] == "mp4"
    assert "height<=720" in reffetch.FORMAT and "--newline" in get
    env = reffetch.proxy_env(proxy)
    assert {env[k] for k in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy")} == {proxy}
    assert env["NO_PROXY"] == ""
    assert "--extractor-args" not in info + get  # the YouTube clients and PO token are for YouTube only


def test_youtube_gets_clips_funded_s_own_po_token_and_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    monkeypatch.setenv("CF_STORIES_POT_HOME", "/opt/bgutil/server")
    for args in (reffetch.info_args(yt, "http://127.0.0.1:1", "youtube"),
                 reffetch.download_args(yt, "http://127.0.0.1:1", 1, Path("/tmp/x"), "youtube")):  # fmt: skip
        given = [args[i + 1] for i, a in enumerate(args) if a == "--extractor-args"]
        assert given == ["youtube:player_client=default,mweb", "youtubepot-bgutilscript:server_home=/opt/bgutil/server"]
        assert args[-2:] == ["--", yt] and not [a for a in args if a.startswith("--cookies")]
    monkeypatch.delenv("CF_STORIES_POT_HOME")
    args = reffetch.info_args(yt, "http://127.0.0.1:1", "youtube")
    assert [args[i + 1] for i, a in enumerate(args) if a == "--extractor-args"] == [
        "youtube:player_client=default,mweb"
    ]


def test_yt_dlps_words_reach_the_log_without_the_link_or_the_post_id() -> None:
    said = ("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. "
            "[youtube] Extracting URL: https://www.youtube.com/watch?v=dQw4w9WgXcQ "
            "ERROR: [twitter] 1859000000000000000: No video could be found in this tweet "
            "ERROR: Unsupported URL: www.tiktok.com/@pip.the.cat")  # fmt: skip
    out = reffetch.quiet(said)
    for secret in ("dQw4w9WgXcQ", "1859000000000000000", "youtube.com/watch", "pip.the.cat"):
        assert secret not in out
    assert "[youtube] Sign in to confirm you're not a bot." in out and "[twitter] No video could be found" in out
    assert reffetch.quiet("[download] Destination: /tmp/x/source.mp4") == "[download] Destination: /tmp/x/source.mp4"


@pytest.mark.parametrize(
    ("said", "sentence"),
    [
        ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", reffetch.PRIVATE),
        (
            "ERROR: [youtube] abc: Sign in to confirm you're not a bot.",
            "TikTok didn't let us get it. Save the video, then upload it.",
        ),
        (
            "ERROR: [Instagram] C1: Requested content is not available, rate-limit reached or login required",
            "TikTok didn't let us get it. Save the video, then upload it.",
        ),
        (
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            "TikTok didn't let us get it. Save the video, then upload it.",
        ),
        ("ERROR: HTTP Error 429: Too Many Requests", "TikTok didn't let us get it. Save the video, then upload it."),
        ("ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader", reffetch.GONE),
        ("ERROR: [TikTok] 1: HTTP Error 404: Not Found", reffetch.GONE),
        ("ERROR: [youtube] abc: This live event will begin in 3 hours.", reffetch.LIVE),
        ("ERROR: [youtube] abc: Premieres in 2 hours", reffetch.LIVE),
        ("[download] skipping .. does not pass filter (!is_live & duration <=? 600.5)", reffetch.TOO_LONG),
        ("File is larger than max-filesize (3000000000 bytes > 2147483648 bytes). Aborting.", reffetch.TOO_BIG),
        ("ERROR: Unsupported URL: https://www.tiktok.com/@a", reffetch.NO_VIDEO),
        ("ERROR: [twitter] 1: No video could be found in this tweet", reffetch.NO_VIDEO),
        ("ERROR: Requested format is not available. Use --list-formats", reffetch.NO_VIDEO),
        ("ERROR: Unable to download webpage: <urlopen error timed out>", "We couldn't reach TikTok. Tap Try again."),
        ("ERROR: Connection reset by peer", "We couldn't reach TikTok. Tap Try again."),
        ("ERROR: something new and strange", reffetch.FAILED),
    ],
)
def test_the_tools_words_become_the_owners_sentence(said: str, sentence: str) -> None:
    assert reffetch.explain(said, "tiktok") == sentence


def test_the_facts_refuse_live_too_long_and_too_big_before_any_download() -> None:
    def j(**kw: Any) -> bytes:
        return json.dumps({"title": "  Pip \n skates  ", "duration": 30, **kw}).encode()

    got = reffetch.facts(j(requested_formats=[{"filesize": 10}, {"filesize_approx": 5}]), 100)
    assert (got.title, got.duration, got.estimate) == ("Pip skates", 30, 15)
    assert reffetch.facts(j(title="x" * 200), 100).title == "x" * 80
    for raw, sentence in ((j(is_live=True), reffetch.LIVE), (j(live_status="is_upcoming"), reffetch.LIVE),
                          (j(duration=601), reffetch.TOO_LONG), (j(filesize=101), reffetch.TOO_BIG),
                          (b"not json", reffetch.NO_VIDEO), (json.dumps({"entries": []}).encode(), reffetch.NO_VIDEO)):  # fmt: skip
        with pytest.raises(FetchFailed) as e:
            reffetch.facts(raw, 100)
        assert str(e.value) == sentence
    assert reffetch.facts(json.dumps({"entries": [{"title": "One", "duration": 9}]}).encode(), 100).title == "One"


def test_the_disk_gives_the_cap() -> None:
    assert reffetch.room(10 * GiB) == 2 * GiB
    assert reffetch.room(GiB) == 256 * 1024 * 1024
    with pytest.raises(FetchFailed) as e:
        reffetch.room(800 * 1024 * 1024)
    assert str(e.value) == reffetch.NO_ROOM


# --- Google Drive and Dropbox ------------------------------------------------------------------------------------


class Answer:
    def __init__(self, status: int, headers: dict[str, str] | None = None, body: bytes = b"") -> None:
        self.status = status
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.body = body
        self.closed = False

    def header(self, name: str) -> str:
        return self.headers.get(name.lower(), "")

    def read(self, n: int) -> bytes:
        out, self.body = self.body[:n], self.body[n:]
        return out

    def close(self) -> None:
        self.closed = True


def opener(answers: dict[str, Answer], asked: list[str] | None = None) -> reffetch.Opener:
    def open_(proxy: str, url: str, seconds: float) -> reffetch.Answer:
        assert proxy == "http://127.0.0.1:9" and seconds == reffetch.READ_SECONDS
        if asked is not None:
            asked.append(url)
        return answers[url]

    return open_


MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 100
DRIVE_GET = (
    "https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345&export=download&confirm=t"
)


def fetch(answers: dict[str, Answer], tmp_path: Path, url: str = DRIVE, site: str = "drive", cap: int = 10_000,
          **kw: Any) -> str | None:  # fmt: skip
    return reffetch.download_direct(url, site, proxy="http://127.0.0.1:9", cap=cap, dest=tmp_path / "f",
                                    opener=opener(answers), **kw)  # fmt: skip


def test_drive_and_dropbox_give_their_download_address() -> None:
    assert reffetch.direct_url(DRIVE, "drive") == DRIVE_GET
    assert (
        reffetch.direct_url("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345", "drive") == DRIVE_GET
    )
    assert reffetch.direct_url("https://www.dropbox.com/scl/fi/k2/pip.mov?rlkey=q1w2", "dropbox") == (
        "https://www.dropbox.com/scl/fi/k2/pip.mov?rlkey=q1w2&dl=1"
    )


def test_a_shared_drive_file_is_streamed_with_its_name_as_the_title(tmp_path: Path) -> None:
    hop = "https://doc-0s-1c-docs.googleusercontent.com/docs/x"
    answers = {DRIVE_GET: Answer(303, {"Location": hop}),
               hop: Answer(200, {"Content-Type": "video/mp4", "Content-Disposition":
                                 "attachment; filename=\"pip_on-ice.mp4\"; filename*=UTF-8''pip_on-ice%20two.mp4"},
                           MP4)}  # fmt: skip
    assert fetch(answers, tmp_path) == "pip on ice two"
    assert (tmp_path / "f").read_bytes() == MP4
    assert all(a.closed for a in answers.values())


@pytest.mark.parametrize(
    ("answers", "sentence"),
    [
        (
            {DRIVE_GET: Answer(302, {"Location": "https://accounts.google.com/ServiceLogin?x"})},
            reffetch.DRIVE_NOT_SHARED,
        ),
        ({DRIVE_GET: Answer(200, {"Content-Type": "text/html; charset=utf-8"}, b"<html>")}, reffetch.DRIVE_NOT_SHARED),
        ({DRIVE_GET: Answer(403)}, reffetch.DRIVE_NOT_SHARED),
        ({DRIVE_GET: Answer(404)}, reffetch.GONE),
        ({DRIVE_GET: Answer(503)}, "We couldn't reach Google Drive. Tap Try again."),
        ({DRIVE_GET: Answer(302, {"Location": "https://evil.example/file.mp4"})}, reffetch.NO_VIDEO),
        ({DRIVE_GET: Answer(302, {"Location": "http://drive.usercontent.google.com/x"})}, reffetch.NO_VIDEO),
        ({DRIVE_GET: Answer(200, {"Content-Type": "video/mp4", "Content-Length": "10001"}, MP4)}, reffetch.TOO_BIG),
        ({DRIVE_GET: Answer(200, {"Content-Type": "video/mp4"}, MP4 + b"\x00" * 10_000)}, reffetch.TOO_BIG),
        ({DRIVE_GET: Answer(200, {"Content-Type": "video/mp4"}, b"GIF89a" + b"\x00" * 100)}, reffetch.NO_VIDEO),
        ({DRIVE_GET: Answer(200, {"Content-Type": "video/mp4"}, b"\x00\x00")}, reffetch.NO_VIDEO),
    ],
)
def test_drive_refusals(answers: dict[str, Answer], sentence: str, tmp_path: Path) -> None:
    with pytest.raises(FetchFailed) as e:
        fetch(answers, tmp_path)
    assert str(e.value) == sentence


def test_at_most_three_redirects(tmp_path: Path) -> None:
    hops = [DRIVE_GET] + [f"https://drive.usercontent.google.com/hop{i}" for i in range(4)]
    answers = {hops[i]: Answer(302, {"Location": hops[i + 1]}) for i in range(4)}
    answers[hops[4]] = Answer(200, {"Content-Type": "video/mp4"}, MP4)
    with pytest.raises(FetchFailed) as e:
        fetch(answers, tmp_path)
    assert str(e.value) == reffetch.NO_VIDEO
    answers[DRIVE_GET] = Answer(302, {"Location": hops[2]})  # three redirects are fine
    assert fetch(answers, tmp_path) is None
    assert (tmp_path / "f").read_bytes() == MP4


def test_dropbox_sign_in_and_a_long_video_stopped_early(tmp_path: Path) -> None:
    url = "https://www.dropbox.com/s/abc123xyz/pip.mp4"
    get = "https://www.dropbox.com/s/abc123xyz/pip.mp4?dl=1"
    with pytest.raises(FetchFailed) as e:
        fetch({get: Answer(302, {"Location": "https://www.dropbox.com/login?cont=x"})}, tmp_path, url, "dropbox")
    assert str(e.value) == reffetch.DROPBOX_NOT_SHARED
    big = MP4 + b"\x00" * (reffetch.PROBE_AFTER + 10)
    seen: list[Path] = []

    def probe(path: Path) -> float:
        seen.append(path)
        return 900.0

    with pytest.raises(FetchFailed) as e:
        fetch({get: Answer(200, {"Content-Type": "video/mp4"}, big)}, tmp_path, url, "dropbox", cap=2 * len(big),
              probe=probe)  # fmt: skip
    assert str(e.value) == reffetch.TOO_LONG and seen == [tmp_path / "f"]


# --- Facebook share links ----------------------------------------------------------------------------------------

SHARE = "https://www.facebook.com/share/r/1AbCdEfGh/"
REEL = "https://www.facebook.com/reel/1234567890123456"


def open_share(answers: dict[str, Answer], url: str = SHARE) -> str:
    return reffetch.open_share(url, proxy="http://127.0.0.1:9", opener=opener(answers))


def test_a_facebook_share_link_leads_to_its_video_checked_again() -> None:
    answers = {SHARE: Answer(302, {"Location": REEL + "/?mibextid=wwXIfr&rdid=abc"})}
    assert open_share(answers) == REEL + "/"
    assert all(a.closed for a in answers.values())
    watch = "https://fb.watch/abc123/"
    hop = "https://www.facebook.com/watch/?v=1234567890&ref=sharing"
    assert open_share({watch: Answer(301, {"Location": hop})}, watch) == "https://www.facebook.com/watch/?v=1234567890"
    page = (
        b'<html><head><meta property="og:url" content="https://www.facebook.com/reel/1234567890123456/?s=1&amp;x=2" />'
    )
    assert open_share({SHARE: Answer(200, {"Content-Type": "text/html; charset=utf-8"}, page)}) == REEL + "/"
    # an http answer is written as https, like a pasted one: only https is ever fetched
    assert open_share({SHARE: Answer(302, {"Location": "http://www.facebook.com/reel/1234567890123456"})}) == REEL


@pytest.mark.parametrize(
    ("answers", "sentence"),
    [
        ({SHARE: Answer(302, {"Location": "https://www.facebook.com/login/?next=x"})},
         "Facebook didn't let us get it. Save the video, then upload it."),
        ({SHARE: Answer(200, {"Content-Type": "text/html"}, b"<html>Log in to Facebook</html>")},
         "Facebook didn't let us get it. Save the video, then upload it."),
        ({SHARE: Answer(302, {"Location": "https://evil.example/reel/1"})}, reffetch.NO_VIDEO),
        ({SHARE: Answer(302, {"Location": "https://www.facebook.com:8443/reel/1"})}, reffetch.NO_VIDEO),
        ({SHARE: Answer(302, {"Location": "https://169.254.169.254/latest/"})}, reffetch.NO_VIDEO),
        ({SHARE: Answer(404)}, reffetch.GONE),
        ({SHARE: Answer(503)}, "We couldn't reach Facebook. Tap Try again."),
    ],
)  # fmt: skip
def test_a_share_link_that_leads_nowhere_good_says_why(answers: dict[str, Answer], sentence: str) -> None:
    with pytest.raises(FetchFailed) as e:
        open_share(answers)
    assert str(e.value) == sentence


def test_a_share_link_never_leads_to_another_share_link_forever() -> None:
    hops = [SHARE] + [f"https://www.facebook.com/share/r/hop{i}/" for i in range(4)]
    with pytest.raises(FetchFailed) as e:
        open_share({hops[i]: Answer(302, {"Location": hops[i + 1]}) for i in range(4)})
    assert str(e.value) == reffetch.NO_VIDEO


# --- the job -----------------------------------------------------------------------------------------------------


def video(path: Path, seconds: float = 2.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x120:r=10", "-t", str(seconds),
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)],
        check=True, timeout=300,
    )  # fmt: skip


class FakeGuard:
    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.url = "http://127.0.0.1:9"
        self.over = False
        self.refused = 0
        self.opened = False
        self.closed = False

    async def __aenter__(self) -> FakeGuard:
        self.opened = True
        return self

    async def __aexit__(self, kind: type[BaseException] | None, value: BaseException | None,
                        tb: TracebackType | None) -> None:  # fmt: skip
        self.closed = True


def world(tmp_path: Path, link: str = TIKTOK, **ref: Any) -> tuple[Services, Any, FakeTable]:
    table = FakeTable()
    table.seed({"pk": PK, "sk": "PJOB#J1", "type": "ws_pjob", "userId": USER, "workspaceId": WS, "jobId": "J1",
                "contentType": "reference", "contentId": "R1", "jobType": "reference_fetch", "status": "queued",
                "steps": [{"key": "get", "label": "Get the video", "status": "pending"}], "progress": 0,
                "configuration": {"run": ["get"]}, "meta": {}, "sessionId": "S1"})  # fmt: skip
    table.seed({"pk": PK, "sk": "REFVID#R1", "type": "ws_refvid", "userId": USER, "workspaceId": WS, "refId": "R1",
                "title": "TikTok video", "status": "fetching", "link": link, "titleFromLink": True, "bytes": 0,
                "contentType": "video/mp4", "key": KEY, "currentJobId": "J1", "ai": {"model": None, "effort": None},
                **ref})  # fmt: skip
    d, store = data(table)
    svc = Services(data=d, work_root=tmp_path / "work", models=FakeModels({}), heartbeat_seconds=0.2,
                   flush_seconds=0.05)  # fmt: skip
    return svc, store, table


class FakeYtDlp:
    """yt-dlp as ``proc.run``: ``-J`` answers ``info``; the download leaves a real video where ``-o`` says, unless
    ``during`` (run then) says otherwise."""

    def __init__(self, info: dict[str, Any] | None = None, fail: str | None = None,
                 during: Callable[[], None] | None = None) -> None:  # fmt: skip
        self.info = info or {"title": "Pip skates on ice", "duration": 2.0}
        self.fail = fail
        self.during = during
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, args: list[str], **kw: Any) -> proc.Result:
        self.calls.append({"args": list(args), **kw})
        if self.fail:
            raise proc.CommandError("yt-dlp", 1, self.fail)
        if "-J" in args:
            return proc.Result(json.dumps(self.info).encode(), "")
        out = Path(args[args.index("-o") + 1].replace("%(ext)s", "mp4"))
        await asyncio.to_thread(video, out)
        kw["on_out_line"]("[download]  50.0% of 1.00MiB at 1.00MiB/s ETA 00:01")
        if self.during:
            self.during()
        return proc.Result(b"", "")


def job_for(svc: Services, ytdlp: FakeYtDlp | None = None, session: str = "S1") -> FetchJob:
    job = FetchJob(svc, JobFence(USER, WS, "J1", session), "R1")
    job.guard = FakeGuard  # type: ignore[assignment]
    job.free = lambda _path: 50 * GiB
    if ytdlp is not None:
        job.run_cmd = ytdlp
    return job


@needs_ffmpeg
def test_a_tiktok_link_arrives_as_the_references_own_file_with_the_videos_title(tmp_path: Path) -> None:
    svc, store, table = world(tmp_path)
    ytdlp = FakeYtDlp()
    assert asyncio.run(job_for(svc, ytdlp).run()) == "ready"
    ref, pjob = table.item("REFVID#R1"), table.item("PJOB#J1")
    assert ref is not None and pjob is not None
    assert ref["status"] == "ready" and ref["title"] == "Pip skates on ice"
    assert "currentJobId" not in ref and "titleFromLink" not in ref
    assert ref["bytes"] == len(store.objects[KEY][0]) and ref["durationSec"] == pytest.approx(2.0, abs=0.2)
    assert ref["fetchedAt"]
    assert store.objects[KEY][1] == "video/mp4" and list(store.objects) == [KEY]
    assert pjob["status"] == "ready" and pjob["progress"] == 1
    assert [(s["key"], s["status"]) for s in pjob["steps"]] == [("get", "done")]
    info, get = ytdlp.calls
    assert "-J" in info["args"] and info["time_limit"] == 120
    assert (get["time_limit"], get["stall_limit"]) == (20 * 60, 120)
    assert info["env"]["HTTPS_PROXY"] == get["env"]["HTTPS_PROXY"] == "http://127.0.0.1:9"
    assert get["args"][get["args"].index("--max-filesize") + 1] == str(2 * GiB)
    for txn in table.txns:  # every write is fenced on the job's session
        ((_kind, first),) = txn[0].items()
        assert first["Key"]["sk"] == "PJOB#J1" and "S1" in first["ExpressionAttributeValues"].values()


@needs_ffmpeg
def test_the_owners_own_name_is_kept(tmp_path: Path) -> None:
    svc, _store, table = world(tmp_path, title="Mine")
    table.items[(PK, "REFVID#R1")].pop("titleFromLink")
    assert asyncio.run(job_for(svc, FakeYtDlp()).run()) == "ready"
    assert table.item("REFVID#R1")["title"] == "Mine"  # type: ignore[index]


@needs_ffmpeg
def test_a_rename_while_it_downloads_wins(tmp_path: Path) -> None:
    svc, _store, table = world(tmp_path)

    def rename() -> None:
        item = table.items[(PK, "REFVID#R1")]
        item["title"] = "Mine"
        item.pop("titleFromLink")

    assert asyncio.run(job_for(svc, FakeYtDlp(during=rename)).run()) == "ready"
    ref = table.item("REFVID#R1")
    assert ref is not None and (ref["status"], ref["title"]) == ("ready", "Mine")


@needs_ffmpeg
@pytest.mark.parametrize("beat", [0.2, 60.0])
def test_a_reference_deleted_while_it_downloads_leaves_no_file(tmp_path: Path, beat: float) -> None:
    """Caught by the heartbeat (nothing was uploaded yet) or by the final write (the file just uploaded goes again)."""
    svc, store, table = world(tmp_path)
    svc.heartbeat_seconds = svc.flush_seconds = beat

    def delete() -> None:  # the API's delete: the job canceled, the reference gone
        table.items[(PK, "PJOB#J1")]["status"] = "canceled"
        del table.items[(PK, "REFVID#R1")]

    assert asyncio.run(job_for(svc, FakeYtDlp(during=delete)).run()) == "superseded"
    assert KEY not in store.objects
    if beat > 1:  # only the final write could see it: the file it had just uploaded is deleted again
        assert KEY in store.deleted


@needs_ffmpeg
def test_a_fetch_the_api_fenced_out_meanwhile_leaves_no_file(tmp_path: Path) -> None:
    svc, store, table = world(tmp_path)
    svc.heartbeat_seconds = svc.flush_seconds = 60.0

    def fence() -> None:  # the stale-heartbeat fence: a new session, the reference fetch_failed
        table.items[(PK, "PJOB#J1")].update(status="failed", sessionId="S2")
        item = table.items[(PK, "REFVID#R1")]
        item["status"] = "fetch_failed"
        item.pop("currentJobId")

    assert asyncio.run(job_for(svc, FakeYtDlp(during=fence)).run()) == "superseded"
    assert KEY not in store.objects and KEY in store.deleted
    assert table.item("REFVID#R1")["status"] == "fetch_failed"  # type: ignore[index]


@needs_ffmpeg
def test_a_newer_run_s_file_is_never_deleted(tmp_path: Path) -> None:
    svc, store, table = world(tmp_path)
    svc.heartbeat_seconds = svc.flush_seconds = 60.0

    def newer() -> None:  # fenced out, Try again, and a newer run now owns the reference
        table.items[(PK, "PJOB#J1")].update(status="failed", sessionId="S2")
        table.items[(PK, "REFVID#R1")]["currentJobId"] = "J2"

    assert asyncio.run(job_for(svc, FakeYtDlp(during=newer)).run()) == "superseded"
    assert KEY in store.objects and store.deleted == []


@pytest.mark.parametrize(
    ("info", "sentence"),
    [({"title": "x", "duration": 900}, reffetch.TOO_LONG), ({"title": "x", "is_live": True}, reffetch.LIVE),
     ({"title": "x", "duration": 9, "filesize": 3 * GiB}, reffetch.TOO_BIG)],
)  # fmt: skip
def test_the_facts_stop_it_before_anything_is_downloaded(tmp_path: Path, info: dict[str, Any], sentence: str) -> None:
    svc, store, table = world(tmp_path)
    ytdlp = FakeYtDlp(info=info)
    assert asyncio.run(job_for(svc, ytdlp).run()) == "failed"
    assert [("-J" in c["args"]) for c in ytdlp.calls] == [True]  # the download never ran
    assert store.objects == {}
    ref, pjob = table.item("REFVID#R1"), table.item("PJOB#J1")
    assert ref is not None and pjob is not None
    assert (ref["status"], "currentJobId" in ref) == ("fetch_failed", False)
    assert (pjob["status"], pjob["error"]) == ("failed", sentence)
    assert pjob["steps"][0]["status"] == "failed" and pjob["steps"][0]["message"] == sentence


def test_yt_dlps_refusal_is_the_owners_sentence(tmp_path: Path) -> None:
    svc, _store, table = world(tmp_path)
    ytdlp = FakeYtDlp(fail="ERROR: [TikTok] 1: Sign in to confirm you're not a bot")
    assert asyncio.run(job_for(svc, ytdlp).run()) == "failed"
    assert table.item("PJOB#J1")["error"] == "TikTok didn't let us get it. Save the video, then upload it."  # type: ignore[index]


def test_a_refused_address_or_too_many_bytes_say_so(tmp_path: Path) -> None:
    for attr, sentence in (("refused", reffetch.NO_VIDEO), ("over", reffetch.TOO_BIG)):
        svc, _store, table = world(tmp_path / attr)
        job = job_for(svc, FakeYtDlp(fail="ERROR: Tunnel connection failed: 403 Forbidden"))

        class Marked(FakeGuard):
            def __init__(self, cap: int, which: str = attr) -> None:
                super().__init__(cap)
                setattr(self, which, 1 if which == "refused" else True)

        job.guard = Marked  # type: ignore[assignment]
        assert asyncio.run(job.run()) == "failed"
        assert table.item("PJOB#J1")["error"] == sentence  # type: ignore[index]


def test_no_room_a_wrong_key_and_another_current_job(tmp_path: Path) -> None:
    svc, _store, table = world(tmp_path / "a")
    job = job_for(svc, FakeYtDlp())
    job.free = lambda _path: 600 * 1024 * 1024
    assert asyncio.run(job.run()) == "failed"
    assert table.item("PJOB#J1")["error"] == reffetch.NO_ROOM  # type: ignore[index]
    svc, _store, table = world(tmp_path / "b", key=f"ws/{USER}/{WS}/references/R2/source.mp4")
    assert asyncio.run(job_for(svc, FakeYtDlp()).run()) == "failed"
    assert table.item("PJOB#J1")["error"] == reffetch.REF_GONE  # type: ignore[index]
    svc, _store, table = world(tmp_path / "c", link="https://vimeo.com/1")
    assert asyncio.run(job_for(svc, FakeYtDlp()).run()) == "failed"
    assert table.item("PJOB#J1")["error"] == reffetch.NO_VIDEO  # type: ignore[index]
    svc, _store, table = world(tmp_path / "d", currentJobId="J2")
    before = dict(table.items)
    ytdlp = FakeYtDlp()
    assert asyncio.run(job_for(svc, ytdlp).run()) == "superseded"
    assert table.items == before and ytdlp.calls == []


@needs_ffmpeg
def test_a_drive_link_comes_through_the_opener(tmp_path: Path) -> None:
    svc, store, table = world(tmp_path, link=DRIVE)
    clip = tmp_path / "clip.mp4"
    video(clip)
    asked: list[str] = []
    job = job_for(svc)
    job.opener = opener({DRIVE_GET: Answer(200, {"Content-Type": "video/mp4", "Content-Disposition":
                                                 'attachment; filename="Pip_skates.mp4"'}, clip.read_bytes())},
                        asked)  # fmt: skip
    assert asyncio.run(job.run()) == "ready"
    assert asked == [DRIVE_GET]
    ref = table.item("REFVID#R1")
    assert ref is not None and (ref["status"], ref["title"]) == ("ready", "Pip skates")
    assert KEY in store.objects


@needs_ffmpeg
def test_a_facebook_share_link_is_opened_first_and_only_its_video_goes_to_yt_dlp(tmp_path: Path) -> None:
    svc, _store, table = world(tmp_path, link=SHARE)
    asked: list[str] = []
    ytdlp = FakeYtDlp()
    job = job_for(svc, ytdlp)
    job.opener = opener({SHARE: Answer(302, {"Location": REEL + "?mibextid=x"})}, asked)
    assert asyncio.run(job.run()) == "ready"
    assert asked == [SHARE]
    assert [c["args"][-1] for c in ytdlp.calls] == [REEL, REEL]
    assert table.item("REFVID#R1")["link"] == SHARE  # type: ignore[index]  # the owner's own link stays


def test_the_log_of_a_refused_fetch_holds_no_link(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    svc, _store, _table = world(tmp_path)
    said = "ERROR: [TikTok] 7301234567890123456: Unsupported URL: https://www.tiktok.com/@pip.the.cat/video/7301234567890123456"
    assert asyncio.run(job_for(svc, FakeYtDlp(fail=said)).run()) == "failed"
    out = capsys.readouterr().out
    assert "stories.fetch_info_failed" in out and "7301234567890123456" not in out and "pip.the.cat" not in out


# --- the rest of the agent ---------------------------------------------------------------------------------------


def test_a_video_on_its_way_is_busy_for_the_keep_settings() -> None:
    assert "fetching" in retention.BUSY


def test_the_director_never_offers_analyze_before_the_video_is_here(box: Any) -> None:  # noqa: F811
    where = {"pk": tasks_world.PK, "userId": tasks_world.USER, "workspaceId": tasks_world.WS}
    box.db.seed({**where, "sk": "REFVID#R1", "refId": "R1", "status": "fetching"})
    box.db.seed({**where, "sk": "REFVID#R2", "refId": "R2", "status": "fetch_failed"})
    assert error(box, "offer_analyze_reference", refId="R1") == "That video is still on its way."
    assert error(box, "offer_analyze_reference", refId="R2") == "That video didn't arrive. Open it and tap Try again."


def test_the_runtime_takes_fetch_reference() -> None:
    from lamostories_agent import runner

    class Actions:
        def __init__(self) -> None:
            self.found: dict[str, Any] = {}
            self.busy_checks: list[Any] = []

        def register(self, name: str, fn: Any) -> None:
            self.found[name] = fn

    actions = Actions()
    runner.register(actions, runner.JobRunner(), lambda: None)
    assert "fetch_reference" in actions.found
    assert actions.found["fetch_reference"]({"userId": USER, "workspaceId": "clips", "refId": "R1", "jobId": "J1",
                                             "sessionId": "S"})["accepted"] is False  # fmt: skip
