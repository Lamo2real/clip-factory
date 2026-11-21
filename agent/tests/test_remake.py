"""A campaign copy of a clip (docs/CONTRACTS.md §39.3, ADR-63): the job the API makes with ``remake`` cuts that clip's
moment again with the campaign's marks, and finds, watches and picks nothing. Every job also gets ``sourceLanguage``
and ``source.channelKeys``. Offline, fakes only (the whole pipeline with test_pipeline's World)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import loudness, proc, sources
from clipfactory_agent import pipeline as pipeline_mod
from clipfactory_agent.bedrock import Facecam, FrameLayout
from clipfactory_agent.moments import Moment
from clipfactory_agent.pipeline import COPY_KEPT, COPY_MOMENT, COPY_SKIPPED, COPY_WORDS
from clipfactory_agent.remake import (
    CANT_COPY,
    FAILED_CHECKS,
    VIDEO_GONE,
    Remake,
    cant_earn,
    saved_index,
    saved_moment,
)
from clipfactory_agent.render import Marks, RenderResult
from clipfactory_agent.store import kept_video_keys
from clipfactory_agent.util import UserFacingError

from .conftest import make_moment
from .test_campaign import UUID, job_campaign
from .test_pipeline import INFO, World

ORIG = "01ORIGJOB00000000000000000"  # the job of the clip being copied
CLIP = "01ORIGCLIP0000000000000000"  # the clip being copied
KEPT = f"jobs/{ORIG}/source/video.mp4"
MAC = f"uploads/u/mac-{ORIG}/video.mp4"  # the whole video the owner's Mac sent for the original (§35.1)
LINK = {"type": "link", "url": "https://www.youtube.com/watch?v=abc"}
UPLOAD = {"type": "upload", "key": "uploads/u/video.mp4", "filename": "v.mp4"}
FACECAM = {"x": 0.7, "y": 0.05, "w": 0.25, "h": 0.3}
WORDS = [[100 + i * 2, 100.4 + i * 2, f"w{i}"] for i in range(60)]
ORIGINAL_MOMENT = make_moment(
    start=100.0, end=130.0, tease=(125.0, 126.5), payoff_at=128.0, peak_at=121.0, score=8.4, summary="He loses it"
)


def remake(**kw: Any) -> dict[str, Any]:
    """``job.remake`` as the API writes it (§39.3): the clip it copies and that clip's own fields."""
    out: dict[str, Any] = {
        "clipId": CLIP,
        "jobId": ORIG,
        "sourceStart": 100.0,
        "sourceEnd": 130.0,
        "layout": "facecam_top",
        "momentType": "rage",
        "hook": "he thought he got away with it",
        "pickedFor": "Big crash",
        "sourceKey": KEPT,
    }
    out.update(kw)
    return {k: v for k, v in out.items() if v is not None}


class CopyWorld(World):
    """A copy job and what its original's job kept (words, clips.json, the framing, the whole video)."""

    def __init__(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        *,
        source: dict[str, Any],
        kept_video: bool = True,
        kept_words: bool = True,
        kept_clips: bool = True,
        remake_kw: dict[str, Any] | None = None,
        **job: Any,
    ) -> None:
        super().__init__(tmp_path, monkeypatch)
        self.mp = monkeypatch
        self.store.job = {
            "jobId": "J",
            "status": "queued",
            "source": dict(source),
            "clipTarget": {"min": 1, "max": 1},
            "campaignId": UUID,
            "campaign": job_campaign(),
            "remakeOf": {"clipId": CLIP, "jobId": ORIG},
            "remake": remake(**{"sourceKey": KEPT if kept_video else None, **(remake_kw or {})}),
            **job,
        }
        self.store.job = {k: v for k, v in self.store.job.items() if v is not None}
        self.info = {**self.info, "channel": "FaZe Clan", "uploader_id": "@FaZeClan"}
        files = self.store.files
        files["jobs/J/source/campaign-logo.png"] = b"\x89PNG logo"
        if source.get("type") == "upload":
            files["uploads/u/video.mp4"] = b"mp4"
        if kept_video:
            files[KEPT] = b"the whole video"
        if kept_words:
            files[f"jobs/{ORIG}/source/words.json"] = json.dumps(WORDS).encode()
            files[f"jobs/{ORIG}/source/meta.json"] = json.dumps({"language": "en-GB", "audioSeconds": 600}).encode()
            files[f"jobs/{ORIG}/source/loudness.json"] = json.dumps([-40.0] * 600).encode()
        if kept_clips:
            row = {"index": 3, "id": CLIP, "moment": ORIGINAL_MOMENT.to_dict(), "captions": {}}
            other = {"index": 0, "id": "01OTHER", "moment": make_moment(start=300, end=330).to_dict(), "captions": {}}
            files[f"jobs/{ORIG}/source/clips.json"] = json.dumps({"version": 1, "clips": [other, row]}).encode()
            done = {
                "version": 1,
                "moment": ORIGINAL_MOMENT.to_dict(),
                "frameLayout": {"scene": "gameplay", "facecam": FACECAM},
            }
            files[f"jobs/{ORIG}/source/render/03/done.json"] = json.dumps(done).encode()
        self.original = {k: v for k, v in files.items() if k.startswith(f"jobs/{ORIG}/")}
        self.original_clips: list[dict[str, Any]] = []
        self.counts = {"video_info": 0, "download_audio": 0, "loudness": 0, "section": 0}
        self.file_cuts: list[tuple[str, float, float]] = []
        self.ffmpeg_inputs: list[str] = []
        self.rendered: list[dict[str, Any]] = []
        self.fable.handlers["submit_review"] = lambda kw: {
            **dict.fromkeys(("zero_context", "pays_off", "hook_ok", "follows_rules"), True),
            **dict.fromkeys(("zero_context_note", "pays_off_note", "hook_note"), ""),
            **{"follows_rules_note": "Nothing banned.", "new_hook": None, "move_start_by": 0, "move_end_by": 0},
            "verdict": "keep",
        }
        self.copy_patches()

    def copy_patches(self) -> None:
        mp, w = self.mp, self
        video_info, download_audio, measure = sources.video_info, sources.download_audio, loudness.measure

        async def counted_info(*a: Any, **kw: Any) -> dict[str, Any]:
            w.counts["video_info"] += 1
            return await video_info(*a, **kw)

        async def counted_audio(*a: Any, **kw: Any) -> Path:
            w.counts["download_audio"] += 1
            return await download_audio(*a, **kw)

        async def counted_loudness(*a: Any, **kw: Any) -> list[float]:
            w.counts["loudness"] += 1
            return await measure(*a, **kw)

        async def download_section(url: str, start: float, end: float, dest: Path, *a: Any, **kw: Any) -> Path:
            w.counts["section"] += 1
            return dest

        async def ffmpeg_cut(src: str, start: float, end: float, dest: Path) -> Path:
            w.file_cuts.append((src, start, end))
            return dest

        async def run(args: list[str], **kw: Any) -> Any:
            if args and args[0] == "ffmpeg" and "-i" in args:
                w.ffmpeg_inputs.append(args[args.index("-i") + 1])
            Path(args[-1]).parent.mkdir(parents=True, exist_ok=True)
            Path(args[-1]).write_bytes(b"audio")  # an upload's sound, taken out with ffmpeg
            from clipfactory_agent.proc import Result

            return Result(b"", "")

        async def prepare_logo(src: Path, dest: Path) -> Path:
            dest.write_bytes(b"\x89PNG trimmed")
            return dest

        async def render_clip(m: Moment, *, workdir: Path, fetch_section: Any, **kw: Any) -> RenderResult:
            tease = m.tease
            await fetch_section(min(m.start, tease[0] if tease else m.start) - 2, m.end + 1.5, workdir / "section.mp4")
            marks: Marks | None = kw.get("marks")
            w.rendered.append({"moment": m, "marks": marks, "layout": kw.get("known_layout"), "words": kw["words"]})
            workdir.mkdir(parents=True, exist_ok=True)
            (workdir / "clip.mp4").write_bytes(b"clip")
            (workdir / "cover.jpg").write_bytes(b"cover")
            caps = [{"t0": 0.0, "t1": 1.0, "text": "w1 w2"}]
            return RenderResult(
                workdir / "clip.mp4", workdir / "cover.jpg", 30.0, [(m.start, m.end)], caps, "facecam_top", bool(tease),
                frame_layout=kw.get("known_layout"), logo=bool(marks and marks.logo),
                disclosure=bool(marks and marks.disclosure),
            )  # fmt: skip

        async def job_clips(job_id: str) -> list[dict[str, Any]]:
            return [c for c in w.original_clips if c.get("jobId") == job_id]

        mp.setattr(sources, "video_info", counted_info)
        mp.setattr(sources, "download_audio", counted_audio)
        mp.setattr(sources, "download_section", download_section)
        mp.setattr(loudness, "measure", counted_loudness)
        mp.setattr(pipeline_mod.Pipeline, "_ffmpeg_cut", staticmethod(ffmpeg_cut))
        mp.setattr(pipeline_mod.proc, "run", run)
        mp.setattr(pipeline_mod, "prepare_logo", prepare_logo)
        mp.setattr(pipeline_mod, "render_clip", render_clip)
        mp.setattr(self.store, "job_clips", job_clips)

    def own_writes(self) -> list[dict[str, Any]]:
        return [x for x in self.store.writes if "heartbeatAt" not in x]


def assert_found_nothing(w: CopyWorld, steps: dict[str, dict[str, Any]]) -> None:
    """No analyze, watch or select: no finder, no watchers, no second look, no loudness, no picture, no chat."""
    assert w.briefs == [] and w.scene_calls() == 0 and w.nova.requests == [] and w.fable.calls("check_moment") == []
    assert w.counts["loudness"] == 0 and w.prepares == 0 and w.picture_downloads == 0 and w.chat_box_looks == 0
    assert not w.store.has("visual_log.json") and not w.store.has("signals.json") and not w.store.has("chat.json")
    for key in ("analyze", "watch"):
        assert (steps[key]["status"], steps[key]["message"]) == ("skipped", COPY_SKIPPED)
    assert (steps["select"]["status"], steps["select"]["message"]) == ("done", COPY_MOMENT)


def assert_one_campaign_copy(w: CopyWorld) -> dict[str, Any]:
    """One clip, a campaign clip that says which clip it copies, with the campaign's checks and captions."""
    assert len(w.store.clips) == 1 and len(w.rendered) == 1
    clip = w.store.clips[0]
    assert clip["campaignId"] == UUID and clip["remakeOf"] == {"clipId": CLIP, "jobId": ORIG}
    assert (clip["sourceStart"], clip["sourceEnd"], clip["momentType"]) == (100.0, 130.0, "rage")
    assert clip["hook"] == "he thought he got away with it" and clip["pickedFor"] == "Big crash"
    assert w.rendered[0]["marks"] == Marks(logo=w.st.workdir / "logo.png", disclosure="Paid partnership")
    got = {i["key"]: i["pass"] for i in clip["checklist"]["items"]}
    for key in ("logo", "disclosure", "campaign_rules", "length", "campaign_tags"):
        assert got[key] is True, (key, clip["checklist"])
    caps = clip["captions"]
    assert all(caps[f].startswith("#Ad ") for f in ("youtubeDescription", "instagram", "facebook", "tiktok", "x"))
    assert all("@FaZeClan" in caps[f] and "#FaZe" in caps[f] for f in ("instagram", "tiktok", "x"))
    review = w.fable.calls("submit_review")
    assert len(review) == 1 and "<campaign_rules>" in review[0]["messages"][0]["content"][0]["text"]
    # the original clip's job is only ever read
    assert {k: v for k, v in w.store.files.items() if k.startswith(f"jobs/{ORIG}/")} == w.original
    return clip


# --- the copy, end to end ---------------------------------------------------------------------------------------


async def test_a_copy_cuts_its_one_moment_from_the_kept_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD)
    status, _st, steps = await w.run()
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    assert_found_nothing(w, steps)
    assert steps["download"]["message"] == COPY_KEPT and steps["transcribe"]["message"] == COPY_WORDS
    # nothing fetched, nothing transcribed, no copy of the whole video: the moment (with its tease) is cut from it
    assert w.counts == {"video_info": 0, "download_audio": 0, "loudness": 0, "section": 0}
    assert w.transcriber.runs == 0 and not w.store.has("video.mp4") and not w.store.has("audio.m4a")
    assert w.file_cuts == [(f"https://s3.test/{KEPT}", 98.0, 131.5)]
    m = w.rendered[0]["moment"]
    assert m.tease == (125.0, 126.5) and (m.payoff_at, m.peak_at) == (128.0, 121.0)
    # framed like the clip it copies (its job's render/03), so the picture is not looked at again
    assert w.rendered[0]["layout"] == FrameLayout(Facecam(**FACECAM), "gameplay")
    clip = assert_one_campaign_copy(w)
    assert clip["summary"] == "He loses it" and clip["score"] == 8
    # the kept words, now the copy's own (so Try again reuses them), and the language heard then
    assert w.store.json("words.json") == WORDS
    assert w.rendered[0]["words"] == w.store.json("words.json")
    assert w.store.json("meta.json")["language"] == "en-GB"
    assert {"sourceLanguage": "en-GB"} in w.own_writes()
    assert w.store.json("moments.json")["chosen"][0]["tease"] == [125.0, 126.5]
    assert w.store.json("moments.json")["spares"] == []


async def test_a_copy_of_a_link_clip_fetches_its_moment_from_the_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False)
    status, _st, steps = await w.run()
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    assert_found_nothing(w, steps)
    # resolved as today (the channel check, the channel keys), the kept words reused, only the moment downloaded
    assert w.counts["video_info"] >= 1 and w.counts["download_audio"] == 0 and w.transcriber.runs == 0
    assert w.counts["section"] == 1 and w.file_cuts == []
    resolve = next(x for x in w.own_writes() if "source" in x)
    assert resolve["source"]["channelKeys"] == sources.channel_keys(w.info) and "campaignNote" not in resolve
    assert_one_campaign_copy(w)


async def test_a_copy_whose_words_are_gone_is_transcribed_like_any_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, kept_words=False)
    status, _st, steps = await w.run()
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    assert_found_nothing(w, steps)  # the sound and the words, never the picture or the chat
    assert w.counts["download_audio"] == 1 and w.transcriber.runs == 1
    assert steps["download"]["message"] == "Got 0:10:00 of sound." and steps["transcribe"]["message"] != COPY_WORDS
    assert {"sourceLanguage": "en-US"} in w.own_writes()  # what Transcribe heard
    assert_one_campaign_copy(w)


async def test_a_kept_video_that_went_meanwhile_means_the_link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, remake_kw={"sourceKey": KEPT})
    assert w.store.job["remake"]["sourceKey"] == KEPT and KEPT not in w.store.files
    status, st, _ = await w.run()
    assert status == "ready" and st.remake is not None and st.remake.source_key is None
    assert w.counts["section"] == 1 and w.file_cuts == []


async def test_a_kept_video_is_read_whatever_the_source_key_says(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source={**UPLOAD, "key": KEPT})  # not under uploads/: only sourceKey is read
    status, _st, _ = await w.run()
    assert status == "ready" and w.file_cuts == [(f"https://s3.test/{KEPT}", 98.0, 131.5)]
    assert_one_campaign_copy(w)


async def test_a_copy_of_a_video_file_that_is_gone_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD, kept_video=False)
    del w.store.files["uploads/u/video.mp4"]
    status, _st, steps = await w.run()
    assert status == "failed" and steps["resolve"]["message"] == VIDEO_GONE
    assert VIDEO_GONE == "This video is gone from Clip Factory. Make new clips for this campaign."
    assert w.store.clips == []


async def test_the_moment_comes_from_the_clip_item_when_its_job_kept_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, kept_clips=False)
    w.original_clips = [
        {"jobId": ORIG, "clipId": CLIP, "userId": "someone-else", "score": 1, "summary": "Not his"},
        {"jobId": ORIG, "clipId": CLIP, "userId": "u", "score": 9, "summary": "He loses it", "momentType": "chaos"},
    ]
    status, _st, _ = await w.run()
    assert status == "ready"
    m = w.rendered[0]["moment"]
    assert (m.start, m.end, m.tease, m.payoff_at, m.peak_at) == (100.0, 130.0, None, 130.0, 115.0)
    assert w.rendered[0]["layout"] is None  # no framing kept: render looks at the picture again
    clip = assert_one_campaign_copy(w)
    assert (clip["score"], clip["summary"], clip["momentType"]) == (9, "He loses it", "rage")


async def test_with_nothing_true_to_say_about_the_clip_no_copy_is_made(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, kept_clips=False)
    w.original_clips = [{"jobId": ORIG, "clipId": CLIP, "userId": "someone-else", "score": 9, "summary": "x"}]
    status, _st, steps = await w.run()
    assert status == "failed" and steps["select"]["message"] == CANT_COPY and w.store.clips == []
    assert CANT_COPY == "Clip Factory couldn't make this copy. Make new clips for this campaign."


async def test_trying_a_copy_again_reuses_its_own_words(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD)
    assert (await w.run())[0] == "ready"
    for k in list(w.store.files):
        if k.startswith(f"jobs/{ORIG}/source/") and k != KEPT:
            del w.store.files[k]  # the original job's words and files expired meanwhile
    w.store.clips.clear()
    w.original_clips = [{"jobId": ORIG, "clipId": CLIP, "userId": "u", "score": 8, "summary": "He loses it"}]
    w.store.job["sourceLanguage"] = "en-GB"
    w.store.writes.clear()
    w.rendered.clear()
    status, _st, steps = await w.run()
    assert status == "ready" and steps["transcribe"]["message"] == "Used the words from last time."
    assert steps["download"]["message"] == COPY_KEPT and w.transcriber.runs == 0
    assert all("sourceLanguage" not in x for x in w.own_writes())  # written once
    assert len(w.store.clips) == 1 and w.store.clips[0]["remakeOf"] == {"clipId": CLIP, "jobId": ORIG}
    # the moment and the framing the first run had, from the copy's own moments.json and render/00
    m = w.rendered[0]["moment"]
    assert m.tease == (125.0, 126.5) and (m.payoff_at, m.peak_at) == (128.0, 121.0)
    assert w.rendered[0]["layout"] == FrameLayout(Facecam(**FACECAM), "gameplay")


async def test_a_copy_tried_again_never_takes_another_spans_moment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, kept_clips=False)
    w.original_clips = [{"jobId": ORIG, "clipId": CLIP, "userId": "u", "score": 9, "summary": "He loses it"}]
    other = make_moment(start=200.0, end=230.0, tease=(225.0, 226.0))
    w.store.files["jobs/J/source/moments.json"] = json.dumps(
        {"version": pipeline_mod.MOMENTS_VERSION, "chosen": [other.to_dict()], "spares": []}
    ).encode()
    done = {"version": 1, "moment": other.to_dict(), "frameLayout": {"scene": "gameplay", "facecam": FACECAM}}
    w.store.files["jobs/J/source/render/00/done.json"] = json.dumps(done).encode()
    status, _st, _ = await w.run()
    assert status == "ready"
    m = w.rendered[0]["moment"]
    assert (m.start, m.end, m.tease) == (100.0, 130.0, None) and w.rendered[0]["layout"] is None


async def test_a_copy_of_a_file_the_mac_sent_is_cut_from_that_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = {"type": "upload", "key": MAC, "filename": "video.mp4", "fetchedBy": "mac"}
    w = CopyWorld(tmp_path, monkeypatch, source=source, kept_video=False, remake_kw={"sourceKey": MAC})
    w.store.files[MAC] = b"the whole video"
    status, st, steps = await w.run()
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    assert st.remake is not None and st.remake.source_key == MAC
    assert w.file_cuts == [(f"https://s3.test/{MAC}", 98.0, 131.5)]
    assert not w.store.has("video.mp4") and w.counts["section"] == 0  # no copy of it in the copy's own folder
    assert_one_campaign_copy(w)


async def test_a_copy_never_downloads_its_whole_kept_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD)
    heads: list[str] = []

    async def head(key: str) -> dict[str, Any]:
        heads.append(key)
        return {"ContentLength": 15}

    w.store.head = head  # type: ignore[attr-defined]  # plenty of disk (World): a normal upload would be downloaded
    status, st, _ = await w.run()
    assert status == "ready" and heads == []
    assert w.file_cuts == [(f"https://s3.test/{KEPT}", 98.0, 131.5)]
    assert not (st.workdir / "source" / "upload.mp4").exists()


async def test_a_link_copy_with_a_kept_video_takes_nothing_from_the_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stored = {**LINK, "platform": "youtube", "title": "Big stream", "channelKeys": ["fazeclan"], "durationSec": 600}
    w = CopyWorld(tmp_path, monkeypatch, source=stored, kept_words=False, macFetch={})

    async def blocked(*a: Any, **kw: Any) -> dict[str, Any]:
        w.counts["video_info"] += 1
        raise proc.CommandError("yt-dlp", 1, "ERROR: Sign in to confirm you're not a bot")

    monkeypatch.setattr(sources, "video_info", blocked)
    status, _st, steps = await w.run()
    assert status == "ready", {k: (s["status"], s.get("message")) for k, s in steps.items()}
    # blocked on the link, yet no wait for the Mac: the sound and the moment both come from the kept video
    assert w.counts["video_info"] == 1 and w.counts["download_audio"] == 0 and w.counts["section"] == 0
    assert w.ffmpeg_inputs == [f"https://s3.test/{KEPT}"] and w.transcriber.runs == 1
    assert w.file_cuts == [(f"https://s3.test/{KEPT}", 98.0, 131.5)]
    resolve = next(x for x in w.own_writes() if "source" in x)
    assert resolve["source"]["channelKeys"] == ["fazeclan"] and resolve["source"]["title"] == "Big stream"
    assert_one_campaign_copy(w)


async def test_a_blocked_link_still_waits_for_the_mac_when_no_video_is_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, kept_video=False, macFetch={})

    async def blocked(*a: Any, **kw: Any) -> dict[str, Any]:
        raise proc.CommandError("yt-dlp", 1, "ERROR: Sign in to confirm you're not a bot")

    monkeypatch.setattr(sources, "video_info", blocked)
    status, _st, _ = await w.run()
    assert status != "ready" and w.store.clips == [] and w.rendered == []


def review_saying(**kw: Any) -> Any:
    base: dict[str, Any] = {
        **dict.fromkeys(("zero_context", "pays_off", "hook_ok", "follows_rules"), True),
        **dict.fromkeys(("zero_context_note", "pays_off_note", "hook_note"), ""),
        **{"follows_rules_note": "Nothing banned.", "new_hook": None, "move_start_by": 0, "move_end_by": 0},
        "verdict": "keep",
    }
    return lambda _kw: {**base, **kw}


@pytest.mark.parametrize(
    ("review", "words"),
    [
        (
            {"follows_rules": False, "follows_rules_note": "Shows gambling at 0:12."},
            "This copy can't earn on FaZe Clips: Shows gambling at 0:12. Make new clips for this campaign.",
        ),
        (  # the campaign's own rules come first, before any other check that failed
            {"follows_rules": False, "follows_rules_note": "Swears at 0:03", "zero_context": False},
            "This copy can't earn on FaZe Clips: Swears at 0:03. Make new clips for this campaign.",
        ),
        (
            {"zero_context": False, "zero_context_note": "You need to know who Tom is."},
            "This copy can't earn on FaZe Clips: You need to know who Tom is. Make new clips for this campaign.",
        ),
        ({"verdict": "drop"}, FAILED_CHECKS),
    ],
)
async def test_a_copy_whose_clip_fails_its_checks_says_why_in_plain_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, review: dict[str, Any], words: str
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD)
    w.fable.handlers["submit_review"] = review_saying(**review)
    status, _st, steps = await w.run()
    assert status == "failed" and steps["checklist"]["message"] == words
    assert "checklist" not in words and "notes" not in words  # never the normal job's words: a copy has no notes
    assert w.store.clips == [] and len(w.rendered) == 1  # one moment, no spare cut in its place
    assert {k: v for k, v in w.store.files.items() if k.startswith(f"jobs/{ORIG}/")} == w.original


def test_why_a_copy_cant_earn_is_short_and_plain() -> None:
    assert cant_earn("FaZe Clips", "Shows gambling at 0:12.") == (
        "This copy can't earn on FaZe Clips: Shows gambling at 0:12. Make new clips for this campaign."
    )
    assert cant_earn("", "The opening looks still.") == (
        "This copy can't earn: The opening looks still. Make new clips for this campaign."
    )
    assert (
        cant_earn("FaZe Clips", "  ")
        == FAILED_CHECKS
        == ("This copy didn't pass its checks. Make new clips for this campaign.")
    )
    long = cant_earn("FaZe Clips", "word " * 80)
    assert long.endswith("… Make new clips for this campaign.") and len(long) < 200


async def test_a_copy_framed_unlike_its_original_is_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD, remake_kw={"layout": "blur_fill"})
    assert (await w.run())[0] == "ready"
    out = capsys.readouterr().out
    assert '"remake.layout_changed"' in out and '"blur_fill"' in out and '"facecam_top"' in out
    w2 = CopyWorld(tmp_path / "same", monkeypatch, source=UPLOAD)
    assert (await w2.run())[0] == "ready" and '"remake.layout_changed"' not in capsys.readouterr().out


@pytest.mark.parametrize(
    "job",
    [
        {"remake": "not a map"},
        {"remake": remake(clipId=None)},
        {"remake": remake(jobId="../other")},
        {"remake": remake(clipId=CLIP + "\n")},
        {"remake": remake(sourceStart=130.0, sourceEnd=100.0)},
        {"remake": remake(sourceEnd=float("nan"))},
        {"campaign": None, "campaignId": None},  # a copy is always a campaign clip
    ],
)
async def test_a_copy_that_cant_be_read_fails_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, job: dict[str, Any]
) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=LINK, **job)
    status, _st, steps = await w.run()
    assert status == "failed" and steps["resolve"]["message"] == CANT_COPY
    assert w.briefs == [] and w.store.clips == [] and w.rendered == []


# --- reading ``job.remake`` -------------------------------------------------------------------------------------


def test_a_job_without_remake_has_none() -> None:
    assert Remake.from_job({}, "u") is None and Remake.from_job({"remakeOf": {"clipId": CLIP}}, "u") is None


def test_remake_reads_the_contract_fields() -> None:
    r = Remake.from_job({"remake": remake()}, "u")
    assert r == Remake(
        CLIP, ORIG, 100.0, 130.0, "rage", "he thought he got away with it", "Big crash", "facecam_top", KEPT
    )
    assert r.remake_of == {"clipId": CLIP, "jobId": ORIG}
    odd = Remake.from_job({"remake": remake(momentType="not-a-kind", hook="  ", pickedFor=7)}, "u")
    assert odd is not None and (odd.moment_type, odd.hook, odd.picked_for) == (None, None, None)


@pytest.mark.parametrize(
    ("key", "kept"),
    [
        (KEPT, True),
        (f"uploads/u/mac-{ORIG}/video.mp4", True),  # the file the owner's Mac sent (§35.1)
        (f"uploads/someone/mac-{ORIG}/video.mp4", False),  # another owner's
        ("jobs/01OTHERJOB/source/video.mp4", False),  # another job's
        (f"jobs/{ORIG}/source/words.json", False),
        ("private/u/youtube-cookies.txt", False),
        ("", False),
    ],
)
def test_only_the_two_kept_places_are_read_as_the_video(key: str, kept: bool) -> None:
    r = Remake.from_job({"remake": remake(sourceKey=key)}, "u")
    assert r is not None and (r.source_key == key) is kept
    assert kept_video_keys("u", ORIG) == (KEPT, f"uploads/u/mac-{ORIG}/video.mp4")


def test_the_moment_is_the_clips_own() -> None:
    r = Remake.from_job({"remake": remake(hook="a new hook", pickedFor=None)}, "u")
    assert r is not None
    m = r.moment(ORIGINAL_MOMENT, None)
    assert m.hook == "a new hook" and m.tease == (125.0, 126.5) and m.picked_for == ORIGINAL_MOMENT.picked_for
    # a saved moment of another span is not this clip's: the Clip item's facts are used instead
    other = make_moment(start=90.0, end=130.0)
    m = r.moment(other, {"score": 6, "summary": "Saved", "pickedFor": "Loud moment"})
    assert (m.start, m.score, m.summary, m.picked_for, m.tease) == (100.0, 6.0, "Saved", "Loud moment", None)
    with pytest.raises(UserFacingError, match="couldn't make this copy"):
        r.moment(other, None)
    with pytest.raises(UserFacingError):
        r.moment(None, {"summary": "no score"})


def test_the_kept_clips_file_is_read_by_clip_id() -> None:
    doc = {"version": 1, "clips": [{"index": 3, "id": CLIP, "moment": ORIGINAL_MOMENT.to_dict()}, {"id": "x"}]}
    assert saved_moment(doc, CLIP) == ORIGINAL_MOMENT and saved_index(doc, CLIP) == 3
    assert saved_moment(doc, "x") is None and saved_index(doc, "x") is None
    assert saved_moment(None, CLIP) is None and saved_moment({"clips": [{"id": CLIP, "moment": {}}]}, CLIP) is None
    assert saved_index({"clips": [{"id": CLIP, "index": True}]}, CLIP) is None


# --- every job: the language heard and the channel's keys ------------------------------------------------------


async def test_every_job_gets_the_language_transcribe_heard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = World(tmp_path, monkeypatch)
    status, st, _ = await w.run()
    assert status == "ready" and st.remake is None
    langs = [x for x in w.store.writes if "sourceLanguage" in x]
    assert langs == [{"sourceLanguage": "en-US"}]  # Transcribe's LanguageCode, written once
    assert w.store.json("meta.json")["language"] == "en-US"
    assert all("remakeOf" not in c for c in w.store.clips)


async def test_skipped_transcribe_gives_the_language_from_meta(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = World(tmp_path, monkeypatch)
    w.store.files["jobs/J/source/meta.json"] = json.dumps({"language": "de-DE"}).encode()
    w.store.files["jobs/J/source/words.json"] = json.dumps(WORDS).encode()
    status, _st, steps = await w.run()
    assert status == "ready" and steps["transcribe"]["message"] == "Used the words from last time."
    assert w.transcriber.runs == 0
    assert [x for x in w.store.writes if "sourceLanguage" in x] == [{"sourceLanguage": "de-DE"}]
    # a job that says it already is not written again; nothing heard, nothing written
    w.store.job["sourceLanguage"] = "de-DE"
    w.store.writes.clear()
    assert (await w.run())[0] == "ready" and all("sourceLanguage" not in x for x in w.store.writes)
    w.store.files["jobs/J/source/meta.json"] = b"{}"
    del w.store.job["sourceLanguage"]
    w.store.writes.clear()
    assert (await w.run())[0] == "ready" and all("sourceLanguage" not in x for x in w.store.writes)


async def test_a_link_job_keeps_its_channels_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = World(tmp_path, monkeypatch)
    w.info = {**INFO, "channel": "FaZe Clan", "uploader_id": "@FaZeClan", "channel_url": "https://youtube.com/@FaZe"}
    status, _st, _ = await w.run()
    assert status == "ready"
    source = next(x for x in w.store.writes if "source" in x)["source"]
    assert source["channelKeys"] == sources.channel_keys(w.info) == ["fazeclan", "faze"]
    # a video with no channel at all: an empty list (never the keys of an earlier run)
    w.store.job["source"] = {**w.store.job["source"], "channelKeys": ["stale"]}
    w.info = {k: v for k, v in INFO.items() if k != "channel"}
    w.store.writes.clear()
    assert (await w.run())[0] == "ready"
    assert next(x for x in w.store.writes if "source" in x)["source"]["channelKeys"] == []


async def test_an_upload_has_no_channel_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    w = CopyWorld(tmp_path, monkeypatch, source=UPLOAD)
    for k in ("remake", "remakeOf", "campaign", "campaignId"):
        del w.store.job[k]
    w.store.job["clipTarget"] = {"min": 2, "max": 3}
    status, _st, _ = await w.run()
    assert status == "ready" and len(w.store.clips) == 2
    assert "channelKeys" not in next(x for x in w.own_writes() if "source" in x)["source"]
    assert w.file_cuts and all(src == "https://s3.test/jobs/J/source/video.mp4" for src, _, _ in w.file_cuts)
