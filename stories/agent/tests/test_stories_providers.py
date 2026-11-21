"""The providers registry (docs/CONTRACTS.md §45.11.6, ADR-75) and the portrait job: a provider is chosen only through
``REGISTRY[kind][id]``; Nova Canvas is built, off until picked, and recorded as ``on`` or ``needs_setup`` only after a
real call answered (here a fake client: no AWS from this Mac); Nova Reel is the interface only."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import keys, providers
from lamostories_agent.data import JobFence
from lamostories_agent.engine import Engine
from lamostories_agent.pipeline import Services
from lamostories_agent.portrait import PortraitJob, colour_name, portrait_prompt
from lamostories_agent.providers import (
    CANVAS_NOT_ENABLED,
    CANVAS_SETUP,
    REEL_FAILED,
    REEL_NO_BUCKET,
    REEL_NOT_ENABLED,
    REEL_SETUP,
    REGISTRY,
    NovaCanvas,
    NovaReel,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    chosen,
    reel_prompt,
    statuses,
)
from lamostories_agent.raster import png_bytes
from ls_fakes import ENGINE_DIR, PK, REPO, USER, WS, FakeModels, FakeTable, data, needs_ffmpeg
from test_stories_pipeline import character, workspace

PNG = png_bytes(__import__("numpy").zeros((4, 4, 3), "uint8"))


class FakeCanvasClient:
    """bedrock-runtime's invoke_model for Nova Canvas: an image, or the error it is told to raise."""

    def __init__(
        self, *, error: tuple[str, str] | None = None, transient: int = 0, body: dict[str, Any] | None = None
    ) -> None:
        self.error = error
        self.transient = transient
        self.body = body
        self.calls: list[dict[str, Any]] = []

    def invoke_model(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.transient:
            self.transient -= 1
            raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeModel")
        if self.error:
            raise ClientError({"Error": {"Code": self.error[0], "Message": self.error[1]}}, "InvokeModel")
        return {"body": io.BytesIO(json.dumps(self.body or {"images": [base64.b64encode(PNG).decode()]}).encode())}


def ctx(client: FakeCanvasClient | None, model: str = "amazon.nova-canvas-v1:0") -> ProviderContext:
    return ProviderContext(
        engine=Engine(ENGINE_DIR, Path("/tmp")),
        workdir=Path("/tmp"),
        image_model_id=model,
        image_client=(lambda: client) if client else None,
    )


@pytest.fixture(autouse=True)
def _no_retry_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    """Nova Canvas's retries of a throttled call wait no time here (only that call's, not the event loop's sleeps)."""
    import functools

    from lamostories_agent.retry import retry

    monkeypatch.setattr(providers, "retry", functools.partial(retry, base=0.0))


def test_the_registry_has_every_kind_and_reads_the_workspace_s_provider_names() -> None:
    assert set(REGISTRY) == {"writer", "images", "animation", "audio"}
    assert chosen(None) == {
        "writer": "bedrock-claude",
        "images": "builtin-rig",
        "animation": "builtin-2d",
        "audio": "builtin-synth",
    }
    # StoriesConfig.providers names the animation kind "video" (§45.6)
    got = chosen({"providers": {"images": "nova-canvas", "video": "nova-reel", "audio": 3}})
    assert got["images"] == "nova-canvas" and got["animation"] == "nova-reel" and got["audio"] == "builtin-synth"
    assert chosen({"providers": {"video": "made-up"}})["animation"] == "builtin-2d"
    defaults = json.loads((REPO / "stories/config/workspace-defaults.json").read_text())
    assert chosen(defaults) == chosen(None)


def test_every_provider_says_its_state_in_one_plain_sentence_and_none_is_on_before_a_real_call() -> None:
    got = {(s.kind, s.id): s for s in statuses()}
    assert set(got) == {
        ("writer", "bedrock-claude"),
        ("images", "builtin-rig"),
        ("images", "nova-canvas"),
        ("animation", "builtin-2d"),
        ("animation", "nova-reel"),
        ("audio", "builtin-synth"),
    }
    assert all(s.state != "on" for s in got.values())  # "on" only after a real call (PROVIDER#)
    assert got[("images", "nova-canvas")].state == "off"
    reel = got[("animation", "nova-reel")]
    assert reel.state == "needs_setup" and reel.line == REEL_NO_BUCKET
    with_bucket = {(s.kind, s.id): s for s in statuses("cf-prod-stories-video-1-us")}
    assert with_bucket[("animation", "nova-reel")].line != REEL_NO_BUCKET
    assert all(s.line.endswith(".") and s.line[0].isupper() for s in got.values())


def test_nova_canvas_draws_with_the_image_model_and_a_fixed_seed() -> None:
    client = FakeCanvasClient()
    png = asyncio.run(NovaCanvas(ctx(client)).image("a cartoon", 1024, 1024, 12345, []))
    assert png == PNG
    (call,) = client.calls
    assert call["modelId"] == "amazon.nova-canvas-v1:0"
    body = json.loads(call["body"])
    assert body["taskType"] == "TEXT_IMAGE" and body["imageGenerationConfig"]["seed"] == 12345
    assert body["imageGenerationConfig"]["width"] == 1024


@pytest.mark.parametrize(
    ("client", "state", "sentence"),
    [
        (
            FakeCanvasClient(error=("AccessDeniedException", "You don't have access to the model")),
            "needs_setup",
            CANVAS_SETUP,
        ),
        (
            FakeCanvasClient(error=("ValidationException", "The model identifier is invalid")),
            "needs_setup",
            CANVAS_SETUP,
        ),
        (
            FakeCanvasClient(error=("ValidationException", "This request has been blocked by our content filters.")),
            "on",
            None,
        ),
        (FakeCanvasClient(transient=9), None, "Nova Canvas did not answer. Tap Try again."),
        (FakeCanvasClient(body={"images": [], "error": "nope"}), "on", None),
    ],
)
def test_nova_canvas_failures_say_what_the_call_proved(
    client: FakeCanvasClient, state: str | None, sentence: str | None
) -> None:
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(NovaCanvas(ctx(client)).image("a cartoon", 1024, 1024, 1, []))
    assert e.value.state == state
    if sentence:
        assert e.value.sentence == sentence
    assert "tap try again" in e.value.sentence.lower()
    if state == "needs_setup":
        assert e.value.last_error == CANVAS_NOT_ENABLED


def test_nova_canvas_without_an_image_model_proves_nothing_about_it() -> None:
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(NovaCanvas(ctx(FakeCanvasClient(), model="")).image("x", 1024, 1024, 1, []))
    assert e.value.state is None and e.value.sentence == CANVAS_SETUP  # no real call: no PROVIDER# state


def test_the_portrait_prompt_uses_words_and_never_hex() -> None:
    p = portrait_prompt(character())
    assert "#" not in p and "Lamo" in p and "cartoon" in p
    assert colour_name("#ff6f61") == "coral" and colour_name("bad") == "plain"


# --- the portrait job --------------------------------------------------------------------------------------------


def portrait_world(
    tmp_path: Path, client: FakeCanvasClient | None, images: str = "nova-canvas"
) -> tuple[Services, Any, FakeTable]:
    table = FakeTable()
    table.seed(workspace({"providers": {"images": images, "video": "builtin-2d", "audio": "builtin-synth"}}))
    table.seed(character("ch1"))
    table.seed(
        {
            "pk": PK,
            "sk": "PJOB#P1",
            "type": "ws_pjob",
            "userId": USER,
            "workspaceId": WS,
            "jobId": "P1",
            "contentType": "character",
            "contentId": "ch1",
            "jobType": "portrait",
            "status": "queued",
            "steps": [{"key": "portrait", "label": keys.PORTRAIT_LABEL, "status": "pending"}],
            "progress": 0,
            "configuration": {"run": ["portrait"], "from": None, "sceneIds": None, "note": None},
            "meta": {},
            "sessionId": "SP",
        }
    )
    d, store = data(table)
    svc = Services(
        data=d,
        work_root=tmp_path / "work",
        models=FakeModels({}),
        config_dir=REPO / "stories" / "config",
        engine_dir=ENGINE_DIR,
        image_model_id="amazon.nova-canvas-v1:0",
        image_client=(lambda: client) if client else None,
        heartbeat_seconds=0.2,
        flush_seconds=0.05,
    )
    return svc, store, table


def run_portrait(svc: Services) -> str:
    return asyncio.run(PortraitJob(svc, JobFence(USER, WS, "P1", "SP"), "ch1").run())


def test_a_portrait_is_saved_and_the_provider_is_on_after_the_real_call(tmp_path: Path) -> None:
    client = FakeCanvasClient()
    svc, store, table = portrait_world(tmp_path, client)
    assert run_portrait(svc) == "ready"
    job = table.item("PJOB#P1")
    assert (
        job is not None and job["status"] == "ready" and job["steps"][0]["status"] == "done" and job["progress"] == 1.0
    )
    (asset,) = table.prefix("ASSET#")
    assert asset["kind"] == "portrait" and asset["characterId"] == "ch1" and asset["contentType"] == "image/png"
    assert asset["key"] == f"ws/{USER}/{WS}/characters/ch1/portrait/{asset['assetId']}.png"
    assert store.objects[asset["key"]][0] == PNG
    assert asset["meta"]["seed"] == keys.seed_for("ch1", "portrait")
    prov = table.item("PROVIDER#images#nova-canvas")
    assert prov is not None and prov["state"] == "on" and prov["checkedAt"] and "lastError" not in prov
    assert json.loads(client.calls[0]["body"])["imageGenerationConfig"]["seed"] == keys.seed_for("ch1", "portrait")
    (usage,) = table.prefix("USAGE#")  # provider usage, priced only when a price is known
    assert usage["kind"] == "provider" and usage["providerId"] == "nova-canvas" and usage["images"] == 1
    assert usage["modelId"] == "amazon.nova-canvas-v1:0" and usage["cost"] is None
    # a second portrait keeps the first as an older version
    table.items[(PK, "PJOB#P1")]["status"] = "queued"
    table.items[(PK, "PJOB#P1")]["steps"] = [{"key": "portrait", "label": keys.PORTRAIT_LABEL, "status": "pending"}]
    assert run_portrait(svc) == "ready"
    assert sorted(a["meta"]["current"] for a in table.prefix("ASSET#")) == [0, 1]


def test_a_refused_portrait_records_needs_setup_and_fails_plainly(tmp_path: Path) -> None:
    svc, _store, table = portrait_world(tmp_path, FakeCanvasClient(error=("AccessDeniedException", "not authorized")))
    assert run_portrait(svc) == "failed"
    job = table.item("PJOB#P1")
    assert job is not None and job["error"] == CANVAS_SETUP and job["steps"][0]["status"] == "failed"
    prov = table.item("PROVIDER#images#nova-canvas")
    assert prov is not None and prov["state"] == "needs_setup" and prov["lastError"] == CANVAS_NOT_ENABLED
    assert table.prefix("ASSET#") == []


def test_a_transient_failure_records_nothing_about_the_provider(tmp_path: Path) -> None:
    svc, _store, table = portrait_world(tmp_path, FakeCanvasClient(transient=9))
    assert run_portrait(svc) == "failed"
    assert table.item("PROVIDER#images#nova-canvas") is None


def test_no_portrait_while_ai_pictures_are_off(tmp_path: Path) -> None:
    client = FakeCanvasClient()
    svc, _store, table = portrait_world(tmp_path, client, images="builtin-rig")
    assert run_portrait(svc) == "failed"
    job = table.item("PJOB#P1")
    assert job is not None and job["error"] == keys.IMAGES_OFF
    assert client.calls == [] and table.prefix("PROVIDER#") == [] and table.prefix("ASSET#") == []


def test_the_provider_seam_is_one_class_and_one_registry_line() -> None:
    class Echo:
        def __init__(self, c: ProviderContext) -> None:
            self.c = c

    registry = {**REGISTRY, "images": {**REGISTRY["images"], "echo": Echo}}
    assert isinstance(registry["images"]["echo"](ctx(None)), Echo)
    assert REGISTRY["images"]["builtin-rig"](ctx(None)).check().id == "builtin-rig"


# --- Nova Reel (§45.31): StartAsyncInvoke into the US bucket, cut-away scenes only ---------------------------------


class FakeReel:
    """bedrock-runtime in us-east-1 (start_async_invoke / get_async_invoke) and S3 there (download_file)."""

    def __init__(self, tmp: Path, *, error: tuple[str, str] | None = None, fail: bool = False) -> None:
        self.tmp = tmp
        self.error = error
        self.fail = fail
        self.starts: list[dict[str, Any]] = []
        self.polls = 0
        self.downloads: list[tuple[str, str]] = []

    def start_async_invoke(self, **kw: Any) -> dict[str, Any]:
        self.starts.append(kw)
        if self.error:
            raise ClientError({"Error": {"Code": self.error[0], "Message": self.error[1]}}, "StartAsyncInvoke")
        return {"invocationArn": "arn:aws:bedrock:us-east-1:1:async-invoke/abc"}

    def get_async_invoke(self, **kw: Any) -> dict[str, Any]:
        self.polls += 1
        if self.polls < 2:
            return {"status": "InProgress"}
        if self.fail:
            return {"status": "Failed", "failureMessage": "blocked"}
        uri = self.starts[0]["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] + "abc"
        return {"status": "Completed", "outputDataConfig": {"s3OutputDataConfig": {"s3Uri": uri}}}

    def download_file(self, bucket: str, key: str, path: str) -> None:
        import subprocess

        self.downloads.append((bucket, key))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=24", "-t", "6",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path],
            check=True, timeout=120,
        )  # fmt: skip


def reel_ctx(tmp: Path, fake: FakeReel | None, bucket: str = "cf-prod-stories-video-1-us") -> ProviderContext:
    async def no_wait(_: float) -> None:
        return None

    return ProviderContext(
        engine=Engine(ENGINE_DIR, tmp / ".deno"),
        workdir=tmp,
        video_bucket=bucket,
        video_model_id="amazon.nova-reel-v1:1",
        reel_client=(lambda: fake) if fake else None,
        us_s3=(lambda: fake) if fake else None,
        reel_prefix=lambda sid: f"ws/{USER}/{WS}/stories/ST1/reel/{sid}/v1/",
        sleep=no_wait,
    )


CUTAWAY = {"scenes": [{"sceneId": "s9", "title": "The icy road", "durationSec": 4, "set": "icy_road", "view": "side",
                       "camera": "wide", "actors": [], "props": [{"propId": "p1", "kind": "ice_sign", "x": 0.5,
                       "y": 0.5, "scale": 1, "rot": 0}], "beats": [], "sfx": [], "seed": 77}]}  # fmt: skip


@needs_ffmpeg
def test_nova_reel_makes_a_cut_away_shot_in_the_us_bucket(tmp_path: Path) -> None:
    fake = FakeReel(tmp_path)
    out = tmp_path / "s9.mp4"
    clip = asyncio.run(NovaReel(reel_ctx(tmp_path, fake)).render_scene(CUTAWAY, "s9", {}, out))
    (start,) = fake.starts
    assert start["modelId"] == "amazon.nova-reel-v1:1"
    assert start["modelInput"]["taskType"] == "TEXT_VIDEO"
    assert start["modelInput"]["videoGenerationConfig"] == {"durationSeconds": 6, "fps": 24, "dimension": "1280x720",
                                                            "seed": 77}  # fmt: skip
    assert start["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] == (
        f"s3://cf-prod-stories-video-1-us/ws/{USER}/{WS}/stories/ST1/reel/s9/v1/"
    )
    assert "no people" in start["modelInput"]["textToVideoParams"]["text"]
    assert fake.downloads == [("cf-prod-stories-video-1-us", f"ws/{USER}/{WS}/stories/ST1/reel/s9/v1/abc/output.mp4")]
    import subprocess

    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(out)],
        capture_output=True, check=True, timeout=60,
    ).stdout)  # fmt: skip
    video = probe["streams"][0]
    assert (video["width"], video["height"], video["avg_frame_rate"]) == (1080, 1920, "30/1")
    assert float(probe["format"]["duration"]) == pytest.approx(4.0, abs=0.1) and clip.duration_sec == 4


def test_nova_reel_needs_its_us_bucket_and_says_what_a_refusal_proved(tmp_path: Path) -> None:
    with pytest.raises(ProviderUnavailable) as off:
        asyncio.run(NovaReel(reel_ctx(tmp_path, FakeReel(tmp_path), bucket="")).render_scene(CUTAWAY, "s9", {},
                                                                                              tmp_path / "x.mp4"))  # fmt: skip
    assert str(off.value) == REEL_NO_BUCKET
    denied = FakeReel(tmp_path, error=("AccessDeniedException", "You don't have access to the model"))
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(NovaReel(reel_ctx(tmp_path, denied)).render_scene(CUTAWAY, "s9", {}, tmp_path / "x.mp4"))
    assert e.value.state == "needs_setup" and e.value.last_error == REEL_NOT_ENABLED and e.value.sentence == REEL_SETUP
    failed = FakeReel(tmp_path, fail=True)
    with pytest.raises(ProviderFailed) as f:
        asyncio.run(NovaReel(reel_ctx(tmp_path, failed)).render_scene(CUTAWAY, "s9", {}, tmp_path / "x.mp4"))
    assert f.value.state == "on" and f.value.sentence == REEL_FAILED


def test_nova_reel_never_draws_a_scene_with_a_character() -> None:
    from lamostories_agent.pipeline import StoryJob

    job = StoryJob.__new__(StoryJob)
    job.config = {"providers": {"video": "nova-reel"}}
    assert job._scene_provider({"actors": [{"castId": "c1"}]}) == "builtin-2d"
    assert job._scene_provider({"actors": []}) == "nova-reel"
    prompt = reel_prompt({}, {**CUTAWAY["scenes"][0], "title": "Lamo slips"})
    assert "Lamo" not in prompt and "icy road" in prompt and "ice sign" in prompt  # places and things, no one
