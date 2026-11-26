"""The Review overlay (docs/CONTRACTS.md §53 C5): the filter graph and subtitle file, the conditional write, the failure
path, the invocation, and one real render when ffmpeg is installed."""

from __future__ import annotations

import asyncio
import shutil
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from clipfactory_agent import overlay as ov
from clipfactory_agent import proc, render
from clipfactory_agent.server import create_app
from clipfactory_agent.store import Store

from .test_server import FakeRunner

U, JOB, CLIP = "user-1", "01JOB", "01CLIP"
EDIT_KEY = f"jobs/{JOB}/clips/{CLIP}/edit-3.mp4"


def png_bytes(w: int = 4, h: int = 2) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"".join(b"\x00" + b"\xff\x00\x00\xff" * w for _ in range(h))
    return (
        render.PNG_MAGIC
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def overlay_map(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "rev": 3,
        "status": "working",
        "logo": {"logoId": "LG1", "x": 0.8, "y": 0.1, "size": 0.2},
        "text": {"text": "Use code CLIPS #ad", "x": 0.5, "y": 0.9, "size": "m"},
    }
    base.update(kw)
    return base


def clip_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "pk": f"USER#{U}",
        "sk": f"CLIP#{CLIP}",
        "jobId": JOB,
        "status": "review",
        "videoKey": f"jobs/{JOB}/clips/{CLIP}/clip.mp4",
        "overlay": overlay_map(),
    }
    base.update(kw)
    return base


# --- the pure parts ------------------------------------------------------------------------------------------------


def test_parse_spec_clamps_and_cleans() -> None:
    spec = ov.parse_spec(
        {
            "logo": {"logoId": "LG1", "x": 3, "y": -1, "size": 0.9},
            "text": {"text": "  {\\b1}Hi\nthere  " + "x" * 200, "x": 0.5, "y": 0.5, "size": "huge"},
            "timing": {"startSec": 2, "endSec": 1},
        }
    )
    assert spec.logo == ov.LogoSpec("LG1", 1.0, 0.0, ov.SIZE_MAX, start=2.0, end=None)  # §53: the one picture's time
    assert spec.logos == (spec.logo,)
    assert spec.text is not None and len(spec.text.text) <= ov.MAX_TEXT and spec.text.size == "m"
    assert "{" not in spec.text.text and "\n" not in spec.text.text and "\\" not in spec.text.text
    assert (spec.start, spec.end) == (2.0, None)  # a backwards window: from 2 s to the end
    assert not spec.whole
    assert ov.parse_spec({"text": {"text": "a", "x": 0, "y": 0, "size": "s"}}).whole
    small = ov.parse_spec({"logo": {"logoId": "LG1", "x": 0.5, "y": 0.5, "size": 0.01}})
    assert small.logo is not None and small.logo.size == ov.SIZE_MIN


def test_parse_spec_needs_a_logo_or_words() -> None:
    for bad in (
        {},
        {"text": {"text": "  ", "x": 0, "y": 0, "size": "s"}},
        {"logo": {"logoId": "../x"}},
        {"logos": [{"logoId": "../x"}, "nope", None]},
    ):
        with pytest.raises(ov.OverlayFailed):
            ov.parse_spec(bad)


def layer(n: int, **kw: Any) -> dict[str, Any]:
    return {"layerId": f"L{n}", "logoId": f"LG{n}", "x": 0.1 * n, "y": 0.2, "size": 0.2, **kw}


def test_parse_spec_reads_the_layers_in_order_with_their_own_timing() -> None:
    spec = ov.parse_spec(
        {
            "logos": [layer(1, key="logos/u/LG1.png"), layer(2, timing={"startSec": 1, "endSec": 4}), layer(3)],
            "logo": {"logoId": "OLD", "x": 0.5, "y": 0.5, "size": 0.3},  # ignored when there are layers
            "timing": {"startSec": 9, "endSec": 12},  # the text's time only
            "text": {"text": "hi", "x": 0.5, "y": 0.5, "size": "s"},
        }
    )
    assert [lg.logo_id for lg in spec.logos] == ["LG1", "LG2", "LG3"]
    assert [lg.layer_id for lg in spec.logos] == ["L1", "L2", "L3"]
    assert spec.logos[0].key == "logos/u/LG1.png" and spec.logos[1].key is None
    assert [(lg.start, lg.end) for lg in spec.logos] == [(None, None), (1.0, 4.0), (None, None)]
    assert (spec.start, spec.end) == (9.0, 12.0)


def test_parse_spec_caps_the_layers_at_four_and_skips_unusable_ones() -> None:
    raw = [layer(n) for n in range(1, 8)]
    raw.insert(1, {"logoId": "../bad"})
    spec = ov.parse_spec({"logos": raw})
    assert ov.MAX_LAYERS == 4 and [lg.logo_id for lg in spec.logos] == ["LG1", "LG2", "LG3", "LG4"]


def test_a_stored_one_picture_edit_still_reads_as_one_layer_with_the_overall_time() -> None:
    legacy = ov.parse_spec({**overlay_map(), "timing": {"startSec": 2, "endSec": 5}})
    assert len(legacy.logos) == 1 and legacy.logo == legacy.logos[0]
    assert legacy.logo is not None and (legacy.logo.start, legacy.logo.end) == (2.0, 5.0)
    assert ov.parse_spec({"logos": [], "logo": overlay_map()["logo"]}).logo is not None  # an empty list falls back


def test_graph_places_the_logo_inside_the_frame_and_keeps_the_picture_format() -> None:
    spec = ov.parse_spec(overlay_map())
    graph = ov.overlay_graph(spec, 1080, 1920, Path("/tmp/cf-work/overlay-C-3/overlay.ass"), 30)
    assert "[1:v]scale=216:1920:force_original_aspect_ratio=decrease,format=rgba[lg1]" in graph
    assert "[0:v][lg1]overlay=x='min(max(0.8000*W-w/2,0),W-w)':y='min(max(0.1000*H-h/2,0),H-h)'[o1]" in graph
    assert "enable=" not in graph  # the whole clip
    assert "[o1]ass=filename=/tmp/cf-work/overlay-C-3/overlay.ass[ot]" in graph
    assert graph.endswith("[ot]format=yuv420p[vout]")


def test_graph_with_a_window_and_only_text_or_only_a_logo() -> None:
    spec = ov.parse_spec({**overlay_map(), "timing": {"startSec": 2, "endSec": 5.5}})
    graph = ov.overlay_graph(spec, 1080, 1920, Path("/tmp/a.ass"), 20)
    assert "overlay=x=" in graph and ":enable='between(t,2.000,5.500)'[o1]" in graph  # the one picture, as in §53
    only_text = ov.overlay_graph(ov.parse_spec({"text": overlay_map()["text"]}), 1080, 1920, Path("/tmp/a.ass"), 9)
    assert only_text == "[0:v]ass=filename=/tmp/a.ass[ot];[ot]format=yuv420p[vout]"
    only_logo = ov.overlay_graph(ov.parse_spec({"logo": overlay_map()["logo"]}), 1080, 1920, Path("/x/a.ass"), 9)
    assert "ass=" not in only_logo and only_logo.endswith("[o1]format=yuv420p[vout]")
    with pytest.raises(ValueError):
        ov.overlay_graph(spec, 1080, 1920, Path("/tmp/it's.ass"), 20)


def test_graph_with_two_layers_stacks_them_in_order_each_with_its_own_time() -> None:
    spec = ov.parse_spec(
        {
            "logos": [layer(1), layer(2, x=0.25, y=0.75, size=0.4, timing={"startSec": 3, "endSec": 8})],
            "text": {"text": "hi", "x": 0.5, "y": 0.9, "size": "m"},
        }
    )
    graph = ov.overlay_graph(spec, 1080, 1920, Path("/w/o.ass"), 20)
    assert graph.split(";") == [
        "[1:v]scale=216:1920:force_original_aspect_ratio=decrease,format=rgba[lg1]",
        "[0:v][lg1]overlay=x='min(max(0.1000*W-w/2,0),W-w)':y='min(max(0.2000*H-h/2,0),H-h)'[o1]",
        "[2:v]scale=432:1920:force_original_aspect_ratio=decrease,format=rgba[lg2]",
        "[o1][lg2]overlay=x='min(max(0.2500*W-w/2,0),W-w)':y='min(max(0.7500*H-h/2,0),H-h)'"
        ":enable='between(t,3.000,8.000)'[o2]",
        "[o2]ass=filename=/w/o.ass[ot]",
        "[ot]format=yuv420p[vout]",
    ]


def test_graph_with_four_layers_has_one_input_and_one_overlay_per_layer_and_text_last() -> None:
    timings = [None, {"startSec": 1, "endSec": 2}, {"startSec": 5}, {"endSec": 7}]
    spec = ov.parse_spec(
        {
            "logos": [layer(n + 1, **({"timing": t} if t else {})) for n, t in enumerate(timings)],
            "text": {"text": "hi", "x": 0.5, "y": 0.9, "size": "m"},
        }
    )
    graph = ov.overlay_graph(spec, 1080, 1920, Path("/w/o.ass"), 10)
    parts = graph.split(";")
    assert len(parts) == 4 * 2 + 2  # a scale and an overlay each, then the text and the final format
    for n in range(1, 5):
        assert f"[{n}:v]scale=" in graph and f"[lg{n}]overlay=" in graph and f"[o{n}]" in graph
    assert "[5:v]" not in graph
    assert "between(t,1.000,2.000)" in graph and "between(t,5.000,10.000)" in graph  # to the clip's end
    assert "between(t,0.000,7.000)" in graph  # no start = from the first frame
    assert graph.count("enable=") == 3  # the first layer is on the whole clip
    assert parts[-2] == "[o4]ass=filename=/w/o.ass[ot]" and parts[-1] == "[ot]format=yuv420p[vout]"


def test_a_layer_whose_time_falls_outside_the_clip_is_left_out() -> None:
    spec = ov.parse_spec({"logos": [layer(1), layer(2, timing={"startSec": 40, "endSec": 50}), layer(3)]})
    assert [lg.logo_id for lg, _, _ in ov.visible_layers(spec, 20)] == ["LG1", "LG3"]
    graph = ov.overlay_graph(spec, 1080, 1920, Path("/w/o.ass"), 20)
    assert "[3:v]" not in graph and "[o2]" in graph


def test_ass_is_one_centred_line_in_the_hook_font_with_a_dark_edge() -> None:
    text = ov.TextSpec("Use code CLIPS #ad", 0.5, 0.9, "m")
    ass = ov.overlay_ass(text, 1080, 1920, 0, 12.5)
    assert "PlayResX: 1080" in ass and "PlayResY: 1920" in ass and "WrapStyle: 2" in ass
    style = next(ln for ln in ass.splitlines() if ln.startswith("Style: Overlay"))
    fields = style.removeprefix("Style: ").split(",")
    assert fields[1] == "Inter" and fields[2] == "68" and fields[3] == "&H00FFFFFF" and fields[5] == "&H00000000"
    assert fields[7] == "-1" and fields[16] == "7" and fields[18] == "5"  # bold, outline 7, alignment 5 (centre)
    assert "Dialogue: 0,0:00:00.00,0:00:12.50,Overlay,,0,0,0,,{\\an5\\pos(540,1728)\\q2}Use code CLIPS #ad" in ass


def test_text_sizes_and_a_long_line_stays_inside_the_frame() -> None:
    sizes = [ov.text_layout(ov.TextSpec("hi", 0.5, 0.5, k), 1080, 1920)[0] for k in "sml"]
    assert sizes == [48, 68, 92]
    # a different resolution scales the font; a long line in the corner is pulled in and shrunk until it fits
    assert ov.text_layout(ov.TextSpec("hi", 0.5, 0.5, "m"), 540, 960)[0] == 34
    long = ov.TextSpec("x" * 80, 1.0, 1.0, "l")
    size, cx, cy = ov.text_layout(long, 1080, 1920)
    half = 80 * ov.CHAR_WIDTH * size / 2
    assert cx - half >= -1 and cx + half <= 1081 and cy + size * 0.7 <= 1921 and size < 92


def test_the_text_cannot_inject_ass_or_filter_syntax() -> None:
    spec = ov.parse_spec({"text": {"text": "a{\\fs500}b,c;d'e\\Nf", "x": 0.5, "y": 0.5, "size": "m"}})
    assert spec.text is not None
    ass = ov.overlay_ass(spec.text, 1080, 1920, 0, 5)
    event = next(ln for ln in ass.splitlines() if ln.startswith("Dialogue"))
    body = event.split("}", 1)[1]
    assert "{" not in body and "\\" not in body


def test_ffmpeg_args_copy_the_audio_and_reuse_the_clip_encoder() -> None:
    args = ov.ffmpeg_args(Path("/w/orig.mp4"), [Path("/w/logo.png")], "G", 30.0, Path("/w/edit.mp4"))
    joined = " ".join(args)
    assert "-c:a copy" in joined and "-map 0:a?" in joined and "-map [vout]" in joined
    assert " ".join(render.video_encode_args()) in joined
    assert "-loop 1 -t 31.000 -i /w/logo.png" in joined and joined.endswith("-movflags +faststart /w/edit.mp4")
    assert "-i /w/logo.png" not in " ".join(ov.ffmpeg_args(Path("/w/o.mp4"), [], "G", 3, Path("/w/e.mp4")))
    many = ov.ffmpeg_args(Path("/w/o.mp4"), [Path("/w/a.png"), Path("/w/b.jpg")], "G", 3, Path("/w/e.mp4"))
    assert " ".join(many).startswith(
        "ffmpeg -v error -y -filter_complex_threads 1 -i /w/o.mp4 -loop 1 -t 4.000 -i /w/a.png -loop 1 -t 4.000 -i /w/b.jpg"
    )
    # the clip render's own options still carry the same video settings
    assert " ".join(render.video_encode_args()) in " ".join(render.encode_args(10, True))


def test_the_named_areas() -> None:
    assert render.CAPTION_BAND == (60, 1180, 908, 1380)
    assert render.FACECAM_BAND == (0, 400, 1080, 960)


# --- the conditional write ----------------------------------------------------------------------------------------


class Denied(Exception):
    def __init__(self, code: str) -> None:
        self.response = {"Error": {"Code": code}}


def _client_error(code: str) -> Exception:
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": "x"}}, "UpdateItem")


class FakeTable:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.error:
            raise self.error
        return {}


def store_with(table: FakeTable) -> Store:
    store = Store.__new__(Store)
    store.table = table  # type: ignore[assignment]
    return store


async def test_finish_is_one_conditional_write_on_status_and_rev() -> None:
    table = FakeTable()
    assert await store_with(table).finish_overlay(U, CLIP, 3, EDIT_KEY, "orig.mp4") is True
    (call,) = table.calls
    assert call["Key"] == {"pk": f"USER#{U}", "sk": f"CLIP#{CLIP}"}
    assert call["ConditionExpression"] == "attribute_exists(pk) AND #st = :review AND #ov.#rev = :rev"
    values, names = call["ExpressionAttributeValues"], call["ExpressionAttributeNames"]
    assert values[":review"] == "review" and values[":rev"] == 3 and values[":edit"] == EDIT_KEY
    assert values[":orig"] == "orig.mp4" and values[":ready"] == "ready"
    expr = call["UpdateExpression"]
    assert "#ek = :edit" in expr and "#vk = :edit" in expr and "#ov.#os = :ready" in expr
    assert "#ok = if_not_exists(#ok, :orig)" in expr  # origVideoKey only when not set yet
    assert (names["#ek"], names["#vk"], names["#ok"], names["#st"]) == ("editKey", "videoKey", "origVideoKey", "status")


async def test_a_refused_condition_is_false_and_other_errors_raise() -> None:
    assert (
        await store_with(FakeTable(_client_error("ConditionalCheckFailedException"))).finish_overlay(
            U, CLIP, 3, EDIT_KEY, "o"
        )
        is False
    )
    with pytest.raises(Exception, match="Boom"):
        await store_with(FakeTable(_client_error("Boom"))).fail_overlay(U, CLIP, 3, "x")
    table = FakeTable()
    assert await store_with(table).fail_overlay(U, CLIP, 3, "Nope.") is True
    call = table.calls[0]
    assert call["ConditionExpression"].startswith("attribute_exists(pk) AND #ov.#rev = :rev")
    assert (
        call["ExpressionAttributeValues"][":msg"] == "Nope."
        and call["ExpressionAttributeValues"][":failed"] == "failed"
    )


# --- the run ------------------------------------------------------------------------------------------------------


class FakeStore:
    """The overlay's store: records every write; ``clip`` is what DynamoDB holds and ``finish_ok`` the condition."""

    def __init__(self, clip: dict[str, Any] | None = None, *, finish_ok: bool = True) -> None:
        self.clip = clip
        self.finish_ok = finish_ok
        self.items: dict[tuple[str, str], dict[str, Any]] = {}
        self.objects: dict[str, bytes] = {
            f"jobs/{JOB}/clips/{CLIP}/clip.mp4": b"video",
            "logos/user-1/LG1.png": png_bytes(),
        }
        self.uploads: list[str] = []
        self.deleted: list[str] = []
        self.finished: list[tuple[Any, ...]] = []
        self.failed: list[tuple[int, str]] = []
        self.fail_upload = False

    async def get_clip(self, user_id: str, clip_id: str) -> dict[str, Any] | None:
        return self.clip

    async def get_item(self, pk: str, sk: str) -> dict[str, Any] | None:
        return self.items.get((pk, sk))

    async def exists(self, key: str) -> bool:
        return key in self.objects

    async def download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.objects[key])

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        if self.fail_upload:
            raise RuntimeError("s3 is down")
        self.objects[key] = path.read_bytes()
        self.uploads.append(key)

    async def delete_keys(self, keys: Any) -> None:
        for k in keys:
            self.objects.pop(k, None)
            self.deleted.append(k)

    async def finish_overlay(self, user_id: str, clip_id: str, rev: int, edit_key: str, orig_key: str) -> bool:
        self.finished.append((user_id, clip_id, rev, edit_key, orig_key))
        return self.finish_ok

    async def fail_overlay(self, user_id: str, clip_id: str, rev: int, message: str) -> bool:
        self.failed.append((rev, message))
        return True


class FakeFfmpeg:
    """Stands in for ffprobe and ffmpeg: the probe answers, ffmpeg writes the output file and remembers its command."""

    def __init__(
        self, monkeypatch: pytest.MonkeyPatch, *, fail: bool = False, probe: proc.MediaInfo | None = None
    ) -> None:
        self.commands: list[list[str]] = []
        self.fail = fail
        self.info = probe or proc.MediaInfo(
            duration=20.0, width=1080, height=1920, has_audio=True, has_video=True, fps=30
        )

        async def fake_probe(src: str) -> proc.MediaInfo:
            return self.info

        async def fake_run(args: Any, **_: Any) -> proc.Result:
            self.commands.append(list(args))
            if self.fail:
                raise proc.CommandError("ffmpeg", 1, "Error opening filters!")
            Path(args[-1]).write_bytes(b"edited")
            return proc.Result(b"", "")

        monkeypatch.setattr(proc, "probe", fake_probe)
        monkeypatch.setattr(proc, "run", fake_run)


async def test_a_good_edit_goes_live_with_one_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, ff = FakeStore(clip_item()), FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "ready"
    assert store.uploads == [EDIT_KEY] and store.objects[EDIT_KEY] == b"edited"
    # the clip's own video is the original here (no origVideoKey yet) and is handed to the write to keep
    assert store.finished == [(U, CLIP, 3, EDIT_KEY, f"jobs/{JOB}/clips/{CLIP}/clip.mp4")]
    assert store.failed == [] and store.deleted == []
    (cmd,) = ff.commands
    assert cmd[0] == "ffmpeg" and "copy" in cmd and cmd[cmd.index("-c:a") + 1] == "copy"
    assert not (tmp_path / f"overlay-{CLIP}-3").exists()  # the work folder is gone


async def test_the_legacy_single_logo_renders_as_one_layer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, ff = FakeStore(clip_item()), FakeFfmpeg(monkeypatch)  # overlay_map() has `logo` and no `logos`
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "ready"
    (cmd,) = ff.commands
    assert cmd.count("-loop") == 1 and sum(1 for a in cmd if a == "-i") == 2  # the clip and the one logo
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "[0:v][lg1]overlay=" in graph and "[o1]ass=filename=" in graph and "[lg2]" not in graph


async def test_layers_are_fetched_once_per_distinct_logo_and_drawn_in_one_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    layers = [
        layer(1, logoId="LG1"),
        layer(2, logoId="LG2", timing={"startSec": 2, "endSec": 6}),
        layer(3, logoId="LG1", x=0.9),  # the same picture again: a second copy
        layer(4, logoId="LG2"),
        layer(5, logoId="LG1"),  # a fifth: ignored
    ]
    clip = clip_item(overlay=overlay_map(logo=None, logos=layers))
    del clip["overlay"]["logo"]
    store, ff = FakeStore(clip), FakeFfmpeg(monkeypatch)
    store.objects["logos/user-1/LG2.png"] = png_bytes(6, 3)
    downloads: list[str] = []
    real = store.download

    async def spy(key: str, path: Path) -> None:
        downloads.append(key)
        await real(key, path)

    store.download = spy  # type: ignore[method-assign]
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "ready"
    assert sorted(k for k in downloads if k.startswith("logos/")) == ["logos/user-1/LG1.png", "logos/user-1/LG2.png"]
    (cmd,) = ff.commands  # one ffmpeg run for every layer and the text
    inputs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-i"]
    assert len(inputs) == 1 + 4 and inputs[1] == inputs[3] and inputs[2] == inputs[4] and inputs[1] != inputs[2]
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.count("overlay=") == 4 and "between(t,2.000,6.000)" in graph and "[5:v]" not in graph
    assert graph.index("[o4]ass=") > graph.index("[o3][lg4]overlay=")  # the text on top of every picture
    assert store.finished and store.failed == []


async def test_a_layers_own_key_is_used_when_it_is_in_the_owners_folder(tmp_path: Path) -> None:
    store = FakeStore(clip_item())
    store.objects = {"logos/user-1/LG1.jpg": b"x", "logos/user-1/LG1.png": png_bytes()}
    got = await ov.fetch_logo(store, U, "LG1", tmp_path, hint="logos/user-1/LG1.png", stem="logo-2")
    assert got.name == "logo-2.png"
    store.objects = {"logos/user-1/LG1.webp": b"RIFF\0\0\0\0WEBPVP8X" + b"\0" * 20, "other/LG1.png": png_bytes()}
    got = await ov.fetch_logo(store, U, "LG1", tmp_path, hint="other/LG1.png")  # a foreign key is ignored
    assert got.name == "logo.webp"


async def test_every_layer_outside_the_clip_with_no_text_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip = clip_item(
        overlay={"rev": 3, "status": "working", "logos": [layer(1, timing={"startSec": 40, "endSec": 50})]}
    )
    store = FakeStore(clip)
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert store.failed == [(3, "Those times are outside the clip.")]


async def test_an_earlier_edit_is_redrawn_on_the_original(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    orig = f"jobs/{JOB}/clips/{CLIP}/clip.mp4"
    clip = clip_item(origVideoKey=orig, videoKey=f"jobs/{JOB}/clips/{CLIP}/edit-2.mp4", editKey="e")
    store = FakeStore(clip)
    downloads: list[str] = []
    real = store.download

    async def spy(key: str, path: Path) -> None:
        downloads.append(key)
        await real(key, path)

    store.download = spy  # type: ignore[method-assign]
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "ready"
    assert downloads[0] == orig  # never the already-edited file: no logo on a logo


async def test_a_new_edit_removes_the_earlier_edit_file_once_it_is_live(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orig = f"jobs/{JOB}/clips/{CLIP}/clip.mp4"
    old = f"jobs/{JOB}/clips/{CLIP}/edit-2.mp4"
    store = FakeStore(clip_item(origVideoKey=orig, videoKey=old, editKey=old))
    store.objects[old] = b"old edit"
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "ready"
    assert store.deleted == [old] and orig in store.objects  # the original is never touched


async def test_a_new_edit_that_lost_the_race_keeps_the_earlier_edit_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = f"jobs/{JOB}/clips/{CLIP}/edit-2.mp4"
    store = FakeStore(
        clip_item(origVideoKey=f"jobs/{JOB}/clips/{CLIP}/clip.mp4", videoKey=old, editKey=old), finish_ok=False
    )
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "stale"
    assert store.deleted == [EDIT_KEY]  # only its own output


async def test_a_stale_run_deletes_its_output_and_writes_nothing_else(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(clip_item(), finish_ok=False)
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "stale"
    assert EDIT_KEY in store.deleted and EDIT_KEY not in store.objects
    assert store.failed == []  # the clip moved on: a stale run never marks it failed


@pytest.mark.parametrize(
    "clip",
    [
        None,
        clip_item(status="posted"),
        clip_item(status="declined"),
        clip_item(overlay=overlay_map(rev=4)),
        clip_item(overlay=overlay_map(status="ready")),
        clip_item(jobId="OTHER"),
        {k: v for k, v in clip_item().items() if k != "overlay"},
    ],
)
async def test_a_clip_that_moved_on_is_left_alone(
    clip: dict[str, Any] | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, ff = FakeStore(clip), FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "stale"
    assert ff.commands == [] and store.uploads == [] and store.failed == [] and store.finished == []


async def test_ffmpeg_failing_marks_the_edit_failed_with_one_sentence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(clip_item())
    FakeFfmpeg(monkeypatch, fail=True)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert store.failed == [(3, ov.FAILED)] and store.finished == [] and store.uploads == []
    assert not (tmp_path / f"overlay-{CLIP}-3").exists()


async def test_an_upload_that_dies_midway_deletes_the_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(clip_item())
    store.fail_upload = True
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert store.failed == [(3, ov.FAILED)] and store.finished == []


async def test_the_write_raising_deletes_the_output_and_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(clip_item())

    async def boom(*_: Any) -> bool:
        raise RuntimeError("ddb is down")

    store.finish_overlay = boom  # type: ignore[method-assign]
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert EDIT_KEY in store.deleted and store.failed == [(3, ov.FAILED)]


async def test_a_failure_that_cannot_be_written_never_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(clip_item())

    async def boom(*_: Any) -> bool:
        raise RuntimeError("ddb is down")

    store.fail_overlay = boom  # type: ignore[method-assign]
    FakeFfmpeg(monkeypatch, fail=True)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"


@pytest.mark.parametrize(
    ("objects", "item", "sentence"),
    [
        ({}, None, "The logo could not be found. Pick it again."),
        (
            {"logos/user-1/LG1.png": b"<html>not a picture</html>"},
            None,
            "That logo could not be read. Use a PNG, JPG or WebP picture.",
        ),
    ],
)
async def test_a_missing_or_wrong_logo_says_so(
    objects: dict[str, bytes], item: Any, sentence: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(clip_item())
    store.objects = {f"jobs/{JOB}/clips/{CLIP}/clip.mp4": b"v", **objects}
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert store.failed == [(3, sentence)]


async def test_the_logo_key_comes_from_its_item_only_inside_the_owners_folder(tmp_path: Path) -> None:
    webp = b"RIFF\0\0\0\0WEBPVP8X" + b"\0" * 20  # a 1 x 1 WebP header
    store = FakeStore(clip_item())
    store.objects = {"logos/user-1/LG1.webp": webp, "logos/someone-else/LG1.png": png_bytes()}
    item = store.items[(f"USER#{U}", "LOGO#LG1")] = {"key": "logos/someone-else/LG1.png"}
    found = await ov.fetch_logo(store, U, "LG1", tmp_path)  # another owner's folder is ignored: the convention wins
    assert found.name == "logo.webp" and found.read_bytes() == webp
    store.objects["logos/user-1/own.png"] = png_bytes()
    item["key"] = "logos/user-1/LG1.png"  # its own key is used when it is in the owner's folder
    store.objects["logos/user-1/LG1.png"] = png_bytes()
    assert (await ov.fetch_logo(store, U, "LG1", tmp_path)).name == "logo.png"
    jpeg = render.JPEG_MAGIC + b"\xe0\x00\x04\x00\x00\xff\xc0\x00\x0b\x08\x00\x10\x00\x20\x01\x01\x11\x00"
    store.items.clear()
    store.objects = {"logos/user-1/LG1.jpg": jpeg}
    assert (await ov.fetch_logo(store, U, "LG1", tmp_path)).name == "logo.jpg"


async def test_times_outside_the_clip_say_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(clip_item(overlay=overlay_map(timing={"startSec": 40, "endSec": 50})))
    FakeFfmpeg(monkeypatch)
    assert await ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3) == "failed"
    assert store.failed == [(3, "Those times are outside the clip.")]


async def test_a_cancel_marks_the_edit_failed_and_passes_the_cancel_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(clip_item())
    gate = asyncio.Event()
    FakeFfmpeg(monkeypatch)

    async def slow(*_: Any, **__: Any) -> proc.Result:
        gate.set()
        await asyncio.sleep(60)
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", slow)
    task = asyncio.create_task(ov.run_overlay(store, tmp_path, U, CLIP, JOB, 3))
    await gate.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert store.failed == [(3, "The edit was interrupted. Try again.")]


# --- the runner and the invocation --------------------------------------------------------------------------------


async def test_the_runner_is_busy_while_an_edit_runs_and_ignores_a_repeat() -> None:
    gate = asyncio.Event()
    calls: list[tuple[Any, ...]] = []

    async def run(*args: Any) -> str:
        calls.append(args)
        await gate.wait()
        return "ready"

    runner = ov.OverlayRunner(run)
    assert runner.busy is False
    assert runner.submit(U, CLIP, JOB, 3) is True and runner.busy is True
    assert runner.submit(U, CLIP, JOB, 3) is False  # the same rev again: a repeated invocation
    assert runner.submit(U, CLIP, JOB, 4) is True  # a newer rev runs too
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*runner.tasks.values())
    await asyncio.sleep(0)
    assert runner.busy is False and sorted(c[3] for c in calls) == [3, 4]


async def test_a_crashing_run_never_escapes_the_runner() -> None:
    async def run(*_: Any) -> str:
        raise RuntimeError("boom")

    runner = ov.OverlayRunner(run)
    runner.submit(U, CLIP, JOB, 3)
    await asyncio.gather(*runner.tasks.values())
    assert runner.busy is False


async def test_shutdown_cancels_the_running_edits() -> None:
    started = asyncio.Event()

    async def run(*_: Any) -> str:
        started.set()
        await asyncio.sleep(60)
        return "ready"

    runner = ov.OverlayRunner(run)
    runner.submit(U, CLIP, JOB, 3)
    await started.wait()
    await runner.shutdown(within=2)
    assert runner.busy is False


class FakeOverlays:
    def __init__(self) -> None:
        self.busy = False
        self.submitted: list[tuple[str, str, str, int]] = []

    def submit(self, user_id: str, clip_id: str, job_id: str, rev: int) -> bool:
        self.submitted.append((user_id, clip_id, job_id, rev))
        self.busy = True
        return True

    async def shutdown(self, within: float = 20.0) -> None:
        return None


def test_the_overlay_action_is_accepted_at_once_and_keeps_the_runtime_alive() -> None:
    runner, overlays = FakeRunner(), FakeOverlays()
    client = TestClient(create_app(runner, None, overlays))
    assert client.get("/ping").json()["status"] == "Healthy"
    r = client.post("/invocations", json={"action": "overlay", "userId": U, "clipId": CLIP, "jobId": JOB, "rev": 3})
    assert r.status_code == 200 and r.json() == {"accepted": True, "clipId": CLIP, "rev": 3}
    assert overlays.submitted == [(U, CLIP, JOB, 3)] and runner.submitted == []
    assert client.get("/ping").json()["status"] == "HealthyBusy"  # a render keeps the session alive
    assert runner.canceled == []


def test_a_job_cancel_never_reaches_an_overlay() -> None:
    runner, overlays = FakeRunner(), FakeOverlays()
    client = TestClient(create_app(runner, None, overlays))
    client.post("/invocations", json={"action": "overlay", "userId": U, "clipId": CLIP, "jobId": JOB, "rev": 3})
    client.post("/invocations", json={"action": "cancel", "jobId": JOB})
    assert overlays.busy is True and overlays.submitted == [(U, CLIP, JOB, 3)]


def test_bad_overlay_invocations() -> None:
    client = TestClient(create_app(FakeRunner(), None, FakeOverlays()))
    good = {"action": "overlay", "userId": U, "clipId": CLIP, "jobId": JOB, "rev": 3}
    for change in (
        {"userId": None},
        {"userId": "../x"},
        {"clipId": None},
        {"clipId": "a b"},
        {"jobId": "../x"},
        {"rev": None},
        {"rev": -1},
        {"rev": True},
        {"rev": 1.5},
        {"rev": "x"},
    ):
        r = client.post("/invocations", json={**good, **change})
        assert r.status_code == 400, change
    assert client.post("/invocations", json={**good, "rev": "7"}).json()["rev"] == 7
    # a runtime built without an overlay runner refuses the action instead of dropping it
    assert TestClient(create_app(FakeRunner())).post("/invocations", json=good).status_code == 400


# --- one real render ----------------------------------------------------------------------------------------------


def _has_filters(*names: str) -> bool:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, check=False).stdout
    return all(f" {n} " in out for n in names)


@pytest.mark.skipif(not _has_filters("overlay"), reason="ffmpeg is not installed")
async def test_a_real_logo_render_keeps_size_fps_and_audio(tmp_path: Path) -> None:
    src = tmp_path / "in.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=270x480:r=30:d=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            str(src),
        ],
        check=True,
    )  # fmt: skip
    logo = tmp_path / "logo.png"
    logo.write_bytes(png_bytes(40, 20))
    spec = ov.parse_spec(
        {"logo": {"logoId": "LG1", "x": 0.5, "y": 0.5, "size": 0.3}, "timing": {"startSec": 0.5, "endSec": 1.5}}
    )
    out = tmp_path / "out.mp4"
    graph = ov.overlay_graph(spec, 270, 480, tmp_path / "x.ass", 2.0)
    await proc.run(ov.ffmpeg_args(src, [logo], graph, 2.0, out), time_limit=120)
    info = await proc.probe(str(out))
    assert (info.width, info.height, info.has_audio) == (270, 480, True) and info.fps == 30
    assert 1.8 <= info.duration <= 2.2

    def pixel(at: float) -> bytes:
        return subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(out), "-frames:v", "1", "-vf", "crop=1:1:135:240,format=rgb24",
             "-f", "rawvideo", "-"],
            capture_output=True, check=True,
        ).stdout  # fmt: skip

    assert pixel(1.0)[0] > 150 and pixel(0.1)[0] < 150 and pixel(1.8)[0] < 150  # red logo only inside its window


@pytest.mark.skipif(not _has_filters("ass", "overlay"), reason="ffmpeg with libass is not installed")
async def test_a_real_text_render(tmp_path: Path) -> None:
    src = tmp_path / "in.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=540x960:r=30:d=2", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )  # fmt: skip
    spec = ov.parse_spec({"text": {"text": "Use code CLIPS", "x": 0.5, "y": 0.5, "size": "l"}})
    ass = tmp_path / "overlay.ass"
    ass.write_text(ov.overlay_ass(spec.text, 540, 960, 0, 2) if spec.text else "", "utf-8")
    out = tmp_path / "out.mp4"
    await proc.run(ov.ffmpeg_args(src, [], ov.overlay_graph(spec, 540, 960, ass, 2.0), 2.0, out), time_limit=120)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", "1", "-i", str(out), "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    ).stdout  # fmt: skip
    assert any(b > 200 for b in raw)  # white letters on the black picture


@pytest.mark.skipif(not _has_filters("overlay"), reason="ffmpeg is not installed")
async def test_a_real_two_layer_render_shows_each_picture_in_its_own_window(tmp_path: Path) -> None:
    src = tmp_path / "in.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=270x480:r=30:d=3", "-c:v", "libx264",
         "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )  # fmt: skip
    logo = tmp_path / "logo.png"
    logo.write_bytes(png_bytes(40, 20))
    spec = ov.parse_spec(
        {
            "logos": [
                {"logoId": "A", "x": 0.25, "y": 0.25, "size": 0.3, "timing": {"startSec": 0.0, "endSec": 1.0}},
                {"logoId": "B", "x": 0.75, "y": 0.75, "size": 0.3, "timing": {"startSec": 2.0, "endSec": 3.0}},
            ]
        }
    )
    out = tmp_path / "out.mp4"
    graph = ov.overlay_graph(spec, 270, 480, tmp_path / "x.ass", 3.0)
    await proc.run(ov.ffmpeg_args(src, [logo, logo], graph, 3.0, out), time_limit=120)

    def red(at: float, x: int, y: int) -> int:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(out), "-frames:v", "1", "-vf", f"crop=1:1:{x}:{y},format=rgb24",
             "-f", "rawvideo", "-"],
            capture_output=True, check=True,
        ).stdout  # fmt: skip
        return raw[0]

    assert red(0.5, 67, 120) > 150 and red(0.5, 202, 360) < 150  # the first picture only
    assert red(1.5, 67, 120) < 150 and red(1.5, 202, 360) < 150  # neither
    assert red(2.5, 67, 120) < 150 and red(2.5, 202, 360) > 150  # the second only
