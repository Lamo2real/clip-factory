"""Reference videos (docs/CONTRACTS.md §57): the measuring, the clamped EditStyle, what cannot be copied yet, the
conditional writes, the failure path, the runner and the invocation, and one real scene detection when ffmpeg is
installed."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from clipfactory_agent import proc
from clipfactory_agent import reference as ref
from clipfactory_agent.server import create_app
from clipfactory_agent.store import Store

from .test_server import FakeRunner

U, REF = "user-1", "01REF"
VIDEO_KEY = f"refs/{U}/{REF}.mp4"
THUMB_KEY = f"refs/{U}/{REF}-thumb.jpg"

# What a model would answer for a typical "split facecam, yellow 2-word captions, hook text top, jump cuts, music".
TYPICAL: dict[str, Any] = {
    "format": {"aspect": "9:16", "layout": "split_facecam_top", "notes": "Facecam band is about a third"},
    "hook": {
        "seconds": 1.5,
        "onScreenText": "He did NOT expect this",
        "spoken": "Bro, watch this",
        "visual": "The streamer's shocked face",
        "textPosition": "top",
        "pattern": "Opens on the reaction, then shows what caused it",
    },
    "captions": {
        "present": True,
        "wordsPerLine": 2,
        "size": "large",
        "weight": "black",
        "casing": "upper",
        "color": "#ffffff",
        "highlightColor": "#FFE600",
        "highlightMode": "word",
        "outline": True,
        "box": False,
        "position": "middle",
        "emoji": False,
    },
    "placement": {"logo": "none", "extraText": ""},
    "pacing": {"zooms": "some", "jumpCuts": True, "speedRamps": False},
    "audio": {"music": True, "musicMood": "hype trap beat", "soundEffects": False, "voiceover": False},
    "ending": {"type": "punchline", "notes": "Ends on the laugh"},
    "summary": [
        "Facecam on top, game below",
        "Big white captions, 2 words a line, the said word turns yellow",
        "Hook text at the top in the first second: a surprise",
        "Pauses are cut out, a cut every 2 seconds",
        "Hype music under the voice",
    ],
}
MEASURED = {"aspect": "9:16", "cutsPer10s": 4.5, "avgShotSeconds": 2.2, "lengthSeconds": 34.0, "heard": True}


# --- the style ------------------------------------------------------------------------------------------------------


def test_a_typical_reference_is_kept_with_the_measured_numbers() -> None:
    style = ref.normalize_style(TYPICAL, MEASURED)
    assert style["format"] == {
        "aspect": "9:16",
        "layout": "split_facecam_top",
        "notes": "Facecam band is about a third",
    }
    assert style["captions"]["color"] == "#FFFFFF" and style["captions"]["highlightColor"] == "#FFE600"
    assert style["captions"]["wordsPerLine"] == 2 and style["captions"]["position"] == "middle"
    assert style["pacing"] == {
        "cutsPer10s": 4.5,
        "avgShotSeconds": 2.2,
        "zooms": "some",
        "jumpCuts": True,
        "lengthSeconds": 34.0,
        "speedRamps": False,
    }
    assert style["summary"] == TYPICAL["summary"]
    assert "extraText" not in style["placement"]  # an empty text is left out
    assert ref.unsupported_lines(style) == ["Added music"]


def test_every_field_is_clamped_and_unknown_ones_dropped() -> None:
    raw = {
        "format": {"aspect": "21:9", "layout": "SPLIT_FACECAM_BOTTOM", "notes": "x " * 200, "extra": 1},
        "hook": {"seconds": 12, "textPosition": "Middle", "onScreenText": "a" * 300, "pattern": 5},
        "captions": {
            "present": "yes",
            "wordsPerLine": 9,
            "size": "huge",
            "color": "yellow",
            "highlightColor": "#12345",
            "highlightMode": "word",
            "position": "top",
            "emoji": True,
        },
        "placement": {"logo": "top_right"},
        "pacing": {"zooms": "many", "speedRamps": True, "cutsPer10s": 99},
        "audio": {"music": False, "soundEffects": True},
        "ending": {"type": "fade"},
        "summary": ["  one   line  ", "one line", "", 3, "b" * 200, *[f"line {i}" for i in range(10)]],
        "unsupported": ["the model may not fill this"],
        "hacker": {"x": 1},
    }
    style = ref.normalize_style(raw, {**MEASURED, "aspect": None, "heard": False})
    assert set(style) <= {"format", "hook", "captions", "placement", "pacing", "audio", "ending", "summary"}
    assert "aspect" not in style["format"]  # no measured shape and none of the four from the model
    assert style["format"]["layout"] == "split_facecam_bottom" and len(style["format"]["notes"]) <= 120
    assert style["hook"]["seconds"] == 5 and style["hook"]["textPosition"] == "middle"
    assert len(style["hook"]["onScreenText"]) <= 80 and "pattern" not in style["hook"]
    cap = style["captions"]
    assert "present" not in cap and cap["wordsPerLine"] == 6 and "size" not in cap and "color" not in cap
    assert "highlightColor" not in cap and "highlightMode" not in cap  # a word highlight with no colour is dropped
    assert style["pacing"]["cutsPer10s"] == 4.5  # measured, never the model's
    lines = style["summary"]
    assert lines[0] == "one line" and len(lines) == 7 and all(len(x) <= 90 for x in lines)
    assert ref.unsupported_lines(style) == [
        "Facecam at the bottom",
        "Hook text in the middle",
        "Captions at the top",
        "Emoji in captions",
        "Many zooms",
        "Speed ramps",
        "A logo on every clip",
        "Sound effects",
        "A fade at the end",
    ]


def test_no_words_heard_means_no_spoken_hook() -> None:
    style = ref.normalize_style(TYPICAL, {**MEASURED, "heard": False})
    assert "spoken" not in style["hook"] and style["hook"]["onScreenText"] == "He did NOT expect this"


def test_a_short_summary_is_filled_from_the_style() -> None:
    raw = {**TYPICAL, "summary": ["Facecam on top, game below"]}
    lines = ref.normalize_style(raw, MEASURED)["summary"]
    assert lines[0] == "Facecam on top, game below" and 3 <= len(lines) <= 7
    assert "Big captions, 2 words a line" in lines


def test_wide_and_captionless_references() -> None:
    style = ref.normalize_style({"captions": {"present": False, "position": "top", "emoji": True}}, {"aspect": "16:9"})
    assert ref.unsupported_lines(style) == ["Square or wide videos"]  # no captions: where they sit does not matter


@pytest.mark.parametrize(
    ("w", "h", "aspect"),
    [(1080, 1920, "9:16"), (720, 720, "1:1"), (1920, 1080, "16:9"), (1080, 1350, "4:5"), (0, 5, None)],
)
def test_nearest_aspect(w: int, h: int, aspect: str | None) -> None:
    assert ref.nearest_aspect(w, h) == aspect


def test_the_schema_has_the_edit_style_sections_and_no_unsupported() -> None:
    props = ref.EDIT_STYLE_SCHEMA["properties"]
    assert set(props) == {"format", "hook", "captions", "placement", "pacing", "audio", "ending", "summary"}
    assert props["captions"]["properties"]["wordsPerLine"] == {"type": "integer", "minimum": 1, "maximum": 6}
    assert props["summary"]["minItems"] == 3 and props["summary"]["maxItems"] == 7


# --- the measuring ------------------------------------------------------------------------------------------------


def test_cuts_pacing_and_frame_times() -> None:
    text = "frame:0 pts:0 pts_time:0\nlavfi.scene_score=0.5\nframe:1 pts:1 pts_time:2.5\nx\nframe:2 pts_time:5\n"
    cuts = ref.parse_cuts(text + "frame:3 pts_time:200\n", 120)
    assert cuts == [2.5, 5.0]
    assert ref.pacing_numbers(cuts, 10) == (2.0, 3.33)
    assert ref.pacing_numbers([], 0) == (0.0, 0.0)
    assert ref.frame_times(40) == [0.0, 0.5, 1.0, 2.0, 3.0, 10.0, 20.0, 36.0]
    short = ref.frame_times(1.2)
    assert short[0] == 0.0 and max(short) <= 1.1 and len(short) == len(set(short))


def test_transcript_lines() -> None:
    words = [(0.4, 0.6, "Bro,"), (0.7, 0.9, "watch"), (1.0, 1.2, "this."), (2.0, 2.2, "Okay"), (40.0, 41.0, "late")]
    assert ref.transcript_text(words) == "[0.4] Bro, watch this.\n[2.0] Okay"


def test_only_the_owners_own_video_key_is_used() -> None:
    assert ref.own_video_key(U, REF, VIDEO_KEY)
    assert ref.own_video_key(U, REF, f"refs/{U}/{REF}.MOV")
    for bad in (None, f"refs/other/{REF}.mp4", f"refs/{U}/{REF}.mp4/../x.mp4", f"refs/{U}/{REF}.exe", "uploads/x.mp4"):
        assert not ref.own_video_key(U, REF, bad), bad


# --- the store ------------------------------------------------------------------------------------------------------


def _client_error(code: str) -> Exception:
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": "x"}}, "UpdateItem")


class FakeTable:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []
        self.items: list[dict[str, Any]] = []

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.error:
            raise self.error
        return {}

    def get_item(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        return {"Item": {"refId": REF, "analyzeRev": Decimal(3)}}

    def query(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        return {"Items": [{"sk": f"REFVID#{REF}", "duration": Decimal("12.5")}]}


def store_with(table: FakeTable) -> Store:
    store = Store.__new__(Store)
    store.table = table  # type: ignore[assignment]
    return store


async def test_finish_is_one_conditional_write_on_status_and_rev() -> None:
    table = FakeTable()
    fields = {
        "status": "x",
        "style": {"pacing": {"avgShotSeconds": 2.25}},
        "summary": ["a"],
        "error": "no",
        "width": 1080,
    }
    assert await store_with(table).finish_reference(U, REF, 3, fields) is True
    (call,) = table.calls
    assert call["Key"] == {"pk": f"USER#{U}", "sk": f"REFVID#{REF}"}
    assert call["ConditionExpression"] == "attribute_exists(pk) AND #st = :analyzing AND #ar = :rev"
    names, values = call["ExpressionAttributeNames"], call["ExpressionAttributeValues"]
    assert values[":analyzing"] == "analyzing" and values[":rev"] == 3
    assert (names["#st"], names["#ar"], names["#err"]) == ("status", "analyzeRev", "error")
    written = {names[f"#f{i}"]: values[f":f{i}"] for i in range(len(values) - 2)}
    assert written["status"] == "ready" and "error" not in written  # always ready; the error goes
    assert written["style"] == {"pacing": {"avgShotSeconds": Decimal("2.25")}}  # floats become Decimals
    assert call["UpdateExpression"].endswith("REMOVE #err")


async def test_fail_and_a_refused_condition() -> None:
    table = FakeTable()
    assert await store_with(table).fail_reference(U, REF, 3, "Nope.") is True
    call = table.calls[0]
    values, names = call["ExpressionAttributeValues"], call["ExpressionAttributeNames"]
    written = {names[f"#f{i}"]: values[f":f{i}"] for i in range(2)}
    assert written == {"status": "failed", "error": "Nope."} and "REMOVE" not in call["UpdateExpression"]
    assert call["ConditionExpression"] == "attribute_exists(pk) AND #st = :analyzing AND #ar = :rev"
    refused = store_with(FakeTable(_client_error("ConditionalCheckFailedException")))
    assert await refused.finish_reference(U, REF, 3, {}) is False
    assert await refused.fail_reference(U, REF, 3, "x") is False
    with pytest.raises(Exception, match="Boom"):
        await store_with(FakeTable(_client_error("Boom"))).fail_reference(U, REF, 3, "x")


async def test_ref_rows_and_get_ref() -> None:
    table = FakeTable()
    store = store_with(table)
    assert await store.ref_rows(U) == [{"sk": f"REFVID#{REF}", "duration": 12.5}]
    assert await store.get_ref(U, REF) == {"refId": REF, "analyzeRev": 3}
    assert table.calls[1]["Key"] == {"pk": f"USER#{U}", "sk": f"REFVID#{REF}"} and table.calls[1]["ConsistentRead"]


# --- the run ------------------------------------------------------------------------------------------------------


def ref_item(**kw: Any) -> dict[str, Any]:
    return {"refId": REF, "userId": U, "key": VIDEO_KEY, "size": 1000, "status": "analyzing", "analyzeRev": 3, **kw}


class FakeStore:
    def __init__(self, item: dict[str, Any] | None = None, *, finish_ok: bool = True) -> None:
        self.item = item
        self.finish_ok = finish_ok
        self.objects: dict[str, Any] = {VIDEO_KEY: b"video"}
        self.uploads: list[str] = []
        self.deleted: list[str] = []
        self.finished: list[tuple[int, dict[str, Any]]] = []
        self.failed: list[tuple[int, str]] = []

    async def get_ref(self, user_id: str, ref_id: str) -> dict[str, Any] | None:
        return self.item

    async def download(self, key: str, path: Path) -> None:
        path.write_bytes(self.objects[key])

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        self.objects[key] = path.read_bytes()
        self.uploads.append(key)

    async def get_json(self, key: str) -> Any:
        return self.objects[key]

    async def delete_keys(self, keys: Any) -> None:
        for k in keys:
            self.objects.pop(k, None)
            self.deleted.append(k)

    async def finish_reference(self, user_id: str, ref_id: str, rev: int, fields: dict[str, Any]) -> bool:
        self.finished.append((rev, fields))
        return self.finish_ok

    async def fail_reference(self, user_id: str, ref_id: str, rev: int, message: str) -> bool:
        self.failed.append((rev, message))
        return True


class FakeBedrock:
    def __init__(self, answer: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self.answer = answer or TYPICAL
        self.error = error
        self.image_limit: int | None = None
        self.calls: list[dict[str, Any]] = []

    async def structured(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.error:
            raise self.error
        return self.answer


class FakeFfmpeg:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, fail: bool = False, info: proc.MediaInfo | None = None):
        self.commands: list[list[str]] = []
        self.fail = fail
        self.info = info or proc.MediaInfo(
            duration=34.0, width=1080, height=1920, has_audio=True, has_video=True, fps=30
        )

        async def fake_probe(src: str) -> proc.MediaInfo:
            return self.info

        async def fake_run(args: Any, **kw: Any) -> proc.Result:
            assert kw.get("time_limit")
            self.commands.append(list(args))
            if self.fail:
                raise proc.CommandError("ffmpeg", 1, "broken")
            if args[-1] == "-":
                return proc.Result(b"frame:0 pts_time:2.1\nframe:1 pts_time:4.4\n", "")
            Path(args[-1]).write_bytes(b"\xff\xd8\xffjpeg")
            return proc.Result(b"", "")

        monkeypatch.setattr(proc, "probe", fake_probe)
        monkeypatch.setattr(proc, "run", fake_run)


class FakeTranscriber:
    def __init__(self, store: FakeStore, fail: bool = False) -> None:
        self.store, self.fail, self.stopped = store, fail, 0

    async def run(self, name: str, media_key: str, output_key: str, **_: Any) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("no speech")
        self.store.objects[output_key] = {
            "results": {"items": [{"start_time": "0.4", "end_time": "0.6", "alternatives": [{"content": "Bro"}]}]}
        }
        return {}

    async def stop(self, name: str) -> None:
        self.stopped += 1


async def test_a_good_reference_is_ready_with_one_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, bedrock, ff = FakeStore(ref_item()), FakeBedrock(), FakeFfmpeg(monkeypatch)
    words = FakeTranscriber(store)
    assert await ref.run_reference(store, bedrock, tmp_path, U, REF, 3, words) == "ready"  # type: ignore[arg-type]
    ((rev, fields),) = store.finished
    assert rev == 3 and fields["status"] == "ready" and fields["thumbKey"] == THUMB_KEY
    assert (fields["width"], fields["height"], fields["duration"]) == (1080, 1920, 34.0)
    assert fields["unsupported"] == ["Added music"] == fields["style"]["unsupported"]
    assert fields["summary"] == TYPICAL["summary"] and fields["style"]["pacing"]["cutsPer10s"] == round(2 / 34 * 10, 2)
    assert fields["style"]["hook"]["spoken"] == "Bro, watch this"  # words were heard
    assert THUMB_KEY in store.uploads and store.failed == []
    # the audio and the transcript were only for this run
    assert not any("-work-" in k for k in store.objects) and any("-work-3.m4a" in k for k in store.deleted)
    (call,) = bedrock.calls
    assert call["tool"] == "edit_style" and call["schema"] is ref.EDIT_STYLE_SCHEMA and "skills" in call
    images = [c for c in call["content"] if "image" in c]
    assert len(images) == 8 and "[0.4] Bro" in call["content"][0]["text"]
    assert "-t" in ff.commands[0] and ff.commands[0][ff.commands[0].index("-t") + 1] == "34.000"
    assert not (tmp_path / f"reference-{REF}-3").exists()


async def test_the_first_two_minutes_only_and_no_words_is_fine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, bedrock = FakeStore(ref_item()), FakeBedrock()
    ff = FakeFfmpeg(monkeypatch, info=proc.MediaInfo(600.0, 1920, 1080, True, True, 60))
    words = FakeTranscriber(store, fail=True)
    assert await ref.run_reference(store, bedrock, tmp_path, U, REF, 3, words) == "ready"  # type: ignore[arg-type]
    assert ff.commands[0][ff.commands[0].index("-t") + 1] == "120.000"
    fields = store.finished[0][1]
    assert "spoken" not in fields["style"]["hook"] and "No spoken words" in bedrock.calls[0]["content"][0]["text"]
    assert fields["style"]["format"]["aspect"] == "16:9" and "Square or wide videos" in fields["unsupported"]
    assert fields["style"]["pacing"]["lengthSeconds"] == 600.0 and words.stopped == 1


async def test_fewer_frames_when_bedrock_refuses_the_pictures(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from botocore.exceptions import ClientError

    store = FakeStore(ref_item())
    FakeFfmpeg(monkeypatch)
    too_many = ClientError({"Error": {"Code": "ValidationException", "Message": "too many images"}}, "Converse")
    bedrock = FakeBedrock()
    answers = [too_many]

    async def structured(**kw: Any) -> dict[str, Any]:
        bedrock.calls.append(kw)
        if answers:
            raise answers.pop()
        return TYPICAL

    bedrock.structured = structured  # type: ignore[method-assign]
    assert await ref.run_reference(store, bedrock, tmp_path, U, REF, 3) == "ready"  # type: ignore[arg-type]
    counts = [sum(1 for c in call["content"] if "image" in c) for call in bedrock.calls]
    assert counts == [8, 4]


@pytest.mark.parametrize(
    "item",
    [None, ref_item(status="ready"), ref_item(status="failed"), ref_item(analyzeRev=4), ref_item(analyzeRev=True)],
)
async def test_an_item_that_moved_on_is_left_alone(
    item: dict[str, Any] | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, bedrock, ff = FakeStore(item), FakeBedrock(), FakeFfmpeg(monkeypatch)
    assert await ref.run_reference(store, bedrock, tmp_path, U, REF, 3) == "stale"  # type: ignore[arg-type]
    assert ff.commands == [] and bedrock.calls == [] and store.finished == [] and store.failed == []


async def test_a_lost_race_writes_nothing_else_and_a_deleted_video_loses_its_thumb(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(ref_item(), finish_ok=False)
    FakeFfmpeg(monkeypatch)
    assert await ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3) == "stale"  # type: ignore[arg-type]
    assert store.failed == [] and THUMB_KEY in store.objects  # a newer try owns the item now; its thumb stays
    store2 = FakeStore(ref_item(), finish_ok=False)
    real_finish = store2.finish_reference

    async def finish_then_gone(*a: Any) -> bool:
        store2.item = None  # the owner deleted it meanwhile
        return await real_finish(*a)

    store2.finish_reference = finish_then_gone  # type: ignore[method-assign]
    assert await ref.run_reference(store2, FakeBedrock(), tmp_path, U, REF, 3) == "stale"  # type: ignore[arg-type]
    assert THUMB_KEY in store2.deleted


@pytest.mark.parametrize("item", [ref_item(key="uploads/x.mp4"), ref_item(key=f"refs/other/{REF}.mp4")])
async def test_a_key_outside_the_owners_folder_fails(
    item: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, ff = FakeStore(item), FakeFfmpeg(monkeypatch)
    assert await ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3) == "failed"  # type: ignore[arg-type]
    assert store.failed == [(3, ref.FAILED)] and ff.commands == []


async def test_ffmpeg_or_the_model_failing_marks_it_failed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(ref_item())
    FakeFfmpeg(monkeypatch, fail=True)
    assert await ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3) == "failed"  # type: ignore[arg-type]
    assert store.failed == [(3, ref.FAILED)] and store.finished == [] and store.uploads == []
    store = FakeStore(ref_item())
    FakeFfmpeg(monkeypatch)
    bedrock = FakeBedrock(error=RuntimeError("model down"))
    assert await ref.run_reference(store, bedrock, tmp_path, U, REF, 3) == "failed"  # type: ignore[arg-type]
    assert store.failed == [(3, ref.FAILED)] and not (tmp_path / f"reference-{REF}-3").exists()


async def test_a_video_without_a_picture_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(ref_item())
    FakeFfmpeg(monkeypatch, info=proc.MediaInfo(10.0, 0, 0, True, False))
    assert await ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3) == "failed"  # type: ignore[arg-type]
    assert store.failed == [(3, ref.FAILED)]


async def test_a_failure_that_cannot_be_written_never_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = FakeStore(ref_item())

    async def boom(*_: Any) -> bool:
        raise RuntimeError("ddb is down")

    store.fail_reference = boom  # type: ignore[method-assign]
    FakeFfmpeg(monkeypatch, fail=True)
    assert await ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3) == "failed"  # type: ignore[arg-type]


async def test_a_cancel_marks_it_failed_and_passes_the_cancel_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = FakeStore(ref_item())
    gate = asyncio.Event()
    FakeFfmpeg(monkeypatch)

    async def slow(*_: Any, **__: Any) -> proc.Result:
        gate.set()
        await asyncio.sleep(60)
        return proc.Result(b"", "")

    monkeypatch.setattr(proc, "run", slow)
    task = asyncio.create_task(ref.run_reference(store, FakeBedrock(), tmp_path, U, REF, 3))  # type: ignore[arg-type]
    await gate.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert store.failed == [(3, ref.FAILED)]


# --- the runner and the invocation --------------------------------------------------------------------------------


async def test_the_runner_is_busy_while_one_runs_and_ignores_a_repeat() -> None:
    gate = asyncio.Event()
    calls: list[tuple[Any, ...]] = []

    async def run(*args: Any) -> str:
        calls.append(args)
        await gate.wait()
        return "ready"

    runner = ref.ReferenceRunner(run)
    assert runner.busy is False
    assert runner.submit(U, REF, 3) is True and runner.busy is True
    assert runner.submit(U, REF, 3) is False
    assert runner.submit(U, REF, 4) is True
    await asyncio.sleep(0)
    gate.set()
    await asyncio.gather(*runner.tasks.values())
    await asyncio.sleep(0)
    assert runner.busy is False and sorted(c[2] for c in calls) == [3, 4]


async def test_a_crash_never_escapes_and_shutdown_cancels() -> None:
    async def crash(*_: Any) -> str:
        raise RuntimeError("boom")

    runner = ref.ReferenceRunner(crash)
    runner.submit(U, REF, 3)
    await asyncio.gather(*runner.tasks.values())
    assert runner.busy is False
    started = asyncio.Event()

    async def hang(*_: Any) -> str:
        started.set()
        await asyncio.sleep(60)
        return "ready"

    runner = ref.ReferenceRunner(hang)
    runner.submit(U, REF, 3)
    await started.wait()
    await runner.shutdown(within=2)
    assert runner.busy is False


class FakeReferences:
    def __init__(self) -> None:
        self.busy = False
        self.submitted: list[tuple[str, str, int]] = []

    def submit(self, user_id: str, ref_id: str, rev: int) -> bool:
        self.submitted.append((user_id, ref_id, rev))
        self.busy = True
        return True

    async def shutdown(self, within: float = 20.0) -> None:
        return None


def test_the_reference_action_is_accepted_at_once_without_a_job() -> None:
    runner, refs = FakeRunner(), FakeReferences()
    client = TestClient(create_app(runner, None, None, refs))
    assert client.get("/ping").json()["status"] == "Healthy"
    r = client.post("/invocations", json={"action": "reference", "userId": U, "refId": REF, "rev": 3})
    assert r.status_code == 200 and r.json() == {"accepted": True, "refId": REF, "rev": 3}
    assert refs.submitted == [(U, REF, 3)] and runner.submitted == []
    assert client.get("/ping").json()["status"] == "HealthyBusy"


def test_bad_reference_invocations() -> None:
    client = TestClient(create_app(FakeRunner(), None, None, FakeReferences()))
    good = {"action": "reference", "userId": U, "refId": REF, "rev": 3}
    for change in (
        {"userId": None},
        {"userId": "../x"},
        {"refId": None},
        {"refId": "a b"},
        {"refId": "../../x"},
        {"rev": None},
        {"rev": -1},
        {"rev": True},
        {"rev": 1.5},
    ):
        assert client.post("/invocations", json={**good, **change}).status_code == 400, change
    assert client.post("/invocations", json={**good, "rev": "7"}).json()["rev"] == 7
    assert TestClient(create_app(FakeRunner())).post("/invocations", json=good).status_code == 400


async def test_the_lifespan_shuts_the_references_down() -> None:
    from clipfactory_agent.server import app_lifespan

    stopped: list[str] = []

    class Refs(FakeReferences):
        async def shutdown(self, within: float = 20.0) -> None:
            stopped.append("refs")

    async with app_lifespan(None, {}, None, Refs())(None):  # type: ignore[arg-type]
        pass
    assert stopped == ["refs"]


# --- real ffmpeg ----------------------------------------------------------------------------------------------------


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg is not installed")
async def test_real_scene_cuts_and_thumbnail(tmp_path: Path) -> None:
    src = tmp_path / "cuts.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=270x480:r=30:d=1",
            "-f", "lavfi", "-i", "color=c=blue:s=270x480:r=30:d=1", "-f", "lavfi", "-i", "color=c=green:s=270x480:r=30:d=1",
            "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-pix_fmt", "yuv420p", str(src),
        ],
        check=True,
    )  # fmt: skip
    r = await proc.run(ref.scene_args(src, 3.0), time_limit=60)
    assert ref.parse_cuts(r.stdout.decode(), 3.0) == [1.0, 2.0]
    thumb = tmp_path / "t.jpg"
    await proc.run(ref.frame_args(src, 1.0, thumb, ref.THUMB_SCALE), time_limit=60)
    info = await proc.probe(str(thumb))
    assert (info.width, info.height) == (270, 480)  # never blown up past its own size
