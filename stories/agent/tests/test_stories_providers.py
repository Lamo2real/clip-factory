"""The providers registry (docs/CONTRACTS.md §45.11.6, §45.37, ADR-75) and the portrait job: a provider is chosen only
through ``REGISTRY[kind][id]``; the AI picture maker (Stability AI on Bedrock) is off until picked and recorded as
``on`` or ``needs_setup`` only after a real call answered (here a fake client: no AWS from this Mac); Luma AI Ray2 makes
cut-aways into the us-west-2 bucket; Amazon ended Nova Canvas and Nova Reel, so they read ``ended`` and are never
called (§45.37 G7)."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import config, keys, providers
from lamostories_agent.data import JobFence
from lamostories_agent.engine import Engine
from lamostories_agent.pipeline import Services
from lamostories_agent.portrait import PortraitJob, colour_name, portrait_prompt
from lamostories_agent.providers import (
    ENDED_STATE_LINE,
    LUMA_NOT_ENABLED,
    LUMA_NOT_READY,
    LUMA_SETUP,
    PICTURE_FAILED,
    PICTURE_SETUP,
    REGISTRY,
    SHOT_FAILED,
    LumaRay,
    NovaCanvas,
    NovaReel,
    OwnImages,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    StabilityImages,
    chosen,
    reel_prompt,
    statuses,
)
from lamostories_agent.raster import png_bytes
from ls_fakes import ENGINE_DIR, PK, REPO, USER, WS, FakeModels, FakeTable, data, needs_ffmpeg
from test_stories_pipeline import character, workspace

PNG = png_bytes(__import__("numpy").zeros((4, 4, 3), "uint8"))


class FakeCanvasClient:
    """bedrock-runtime's invoke_model for a picture model (Stability AI, or an Amazon one the owner added): an image,
    or the error it is told to raise. ``regions`` are the Regions a client was asked for."""

    def __init__(
        self, *, error: tuple[str, str] | None = None, transient: int = 0, body: dict[str, Any] | None = None
    ) -> None:
        self.error = error
        self.transient = transient
        self.body = body
        self.calls: list[dict[str, Any]] = []
        self.regions: list[str] = []

    def __call__(self, region: str) -> FakeCanvasClient:
        self.regions.append(region)
        return self

    def invoke_model(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.transient:
            self.transient -= 1
            raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeModel")
        if self.error:
            raise ClientError({"Error": {"Code": self.error[0], "Message": self.error[1]}}, "InvokeModel")
        return {"body": io.BytesIO(json.dumps(self.body or {"images": [base64.b64encode(PNG).decode()]}).encode())}


CORE = config.pick_model("image", "stability", "stable-image-core")


def ctx(client: FakeCanvasClient | None, model: dict[str, Any] | None = CORE) -> ProviderContext:
    return ProviderContext(
        engine=Engine(ENGINE_DIR, Path("/tmp")),
        workdir=Path("/tmp"),
        image_model=model,
        image_model_id=str((model or {}).get("modelId") or ""),
        image_client=(lambda: client) if client else None,
        bedrock=client,
    )


@pytest.fixture(autouse=True)
def _no_retry_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    """A picture maker's retries of a throttled call wait no time here (only that call's, not the event loop's
    sleeps)."""
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
    got = chosen({"providers": {"images": "stability", "video": "luma-ray", "audio": "polly"}})
    assert (got["images"], got["animation"], got["audio"]) == ("stability", "luma-ray", "polly")
    assert chosen({"providers": {"video": "made-up"}})["animation"] == "builtin-2d"
    defaults = json.loads((REPO / "stories/config/workspace-defaults.json").read_text())
    assert chosen(defaults) == chosen(None)


def test_every_provider_says_its_state_in_one_plain_sentence_and_only_the_built_ins_start_on() -> None:
    got = {(s.kind, s.id): s for s in statuses()}
    assert set(got) == {
        ("writer", "bedrock-claude"),
        ("images", "builtin-rig"),
        ("images", "nova-canvas"),
        ("images", "stability"),
        ("images", "own-images"),
        ("animation", "builtin-2d"),
        ("animation", "nova-reel"),
        ("animation", "luma-ray"),
        ("animation", "own-video"),
        ("audio", "builtin-synth"),
        ("audio", "polly"),
        ("audio", "elevenlabs"),
        ("audio", "own-sound"),
    }
    # the built-ins are on (§45.11.6, §45.31: nothing to set up); the writer and the AI ones only after a real call
    assert {k: s.state for k, s in got.items() if s.state == "on"} == {
        ("images", "builtin-rig"): "on",
        ("animation", "builtin-2d"): "on",
        ("audio", "builtin-synth"): "on",
    }
    assert got[("writer", "bedrock-claude")].state == "needs_setup"
    # Amazon ended Nova Canvas and Nova Reel (§45.37 G7): never shown as something to set up
    assert ENDED_STATE_LINE == "Ended by Amazon on 30 Sep 2026."
    for gone in (("images", "nova-canvas"), ("animation", "nova-reel")):
        assert (got[gone].state, got[gone].line) == ("ended", ENDED_STATE_LINE)
    # the AI makers are off until the owner picks one; Luma AI Ray2 says what is missing while its bucket is off
    assert {k for k, s in got.items() if s.state == "off"} == {("images", "stability"), ("images", "own-images"),
                                                               ("animation", "own-video"), ("audio", "polly"),
                                                               ("audio", "elevenlabs"), ("audio", "own-sound")}  # fmt: skip
    luma = got[("animation", "luma-ray")]
    assert luma.state == "needs_setup" and luma.line == LUMA_NOT_READY
    with_bucket = {(s.kind, s.id): s for s in statuses("", "cf-prod-stories-video-1-usw2")}
    assert with_bucket[("animation", "luma-ray")].line != LUMA_NOT_READY
    assert (
        got[("audio", "polly")].line
        == "Adds words spoken aloud. Your videos are made without a voice unless you pick this."
    )
    assert all(s.line.endswith(".") and s.line[0].isupper() for s in got.values())


def test_stability_draws_with_the_picked_model_in_oregon_and_a_fixed_seed() -> None:
    client = FakeCanvasClient()
    png = asyncio.run(StabilityImages(ctx(client)).image("a cartoon", 1024, 1024, 12345, []))
    assert png == PNG
    (call,) = client.calls
    assert call["modelId"] == "stability.stable-image-core-v1:1" and client.regions == ["us-west-2"]
    body = json.loads(call["body"])
    assert (body["seed"], body["aspect_ratio"], body["output_format"]) == (12345, "1:1", "png")
    assert body["prompt"] == "a cartoon" and "realistic" in body["negative_prompt"]
    tall = json.loads(providers.stability_body("x", 1080, 1920, 1))
    assert tall["aspect_ratio"] == "9:16"
    ultra = config.pick_model("image", "stability", "stable-image-ultra")
    asyncio.run(StabilityImages(ctx(client, ultra)).image("a cartoon", 1024, 1024, 1, []))
    assert client.calls[-1]["modelId"] == "stability.stable-image-ultra-v1:1"  # the pick, never another model


def test_an_amazon_picture_model_the_owner_added_takes_the_nova_canvas_request_shape() -> None:
    client = FakeCanvasClient()
    titan = {"key": "custom-titan", "label": "My Titan", "maker": "own-images", "hostId": "bedrock",
             "modelId": "amazon.titan-image-generator-v2:0", "region": "us-east-1", "kind": "image"}  # fmt: skip
    assert asyncio.run(OwnImages(ctx(client, titan)).image("a cartoon", 1024, 1024, 12345, [])) == PNG
    (call,) = client.calls
    body = json.loads(call["body"])
    assert body["taskType"] == "TEXT_IMAGE" and body["imageGenerationConfig"]["seed"] == 12345
    assert body["imageGenerationConfig"]["width"] == 1024 and client.regions == ["us-east-1"]


def test_nova_canvas_is_ended_and_never_called() -> None:
    client = FakeCanvasClient()
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(NovaCanvas(ctx(client)).image("a cartoon", 1024, 1024, 1, []))
    assert str(e.value) == (
        "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › "
        "Settings › Video."
    )
    assert client.calls == [] and NovaCanvas(ctx(None)).check().state == "ended"
    ended = config.pick_model("image", "nova-canvas", "nova-canvas")  # a stray pick of the ended model itself
    with pytest.raises(ProviderUnavailable) as again:
        asyncio.run(OwnImages(ctx(client, ended)).image("x", 1024, 1024, 1, []))
    assert "was ended by Amazon on 30 Sep 2026" in str(again.value) and client.calls == []


@pytest.mark.parametrize(
    ("client", "state", "sentence"),
    [
        (
            FakeCanvasClient(error=("AccessDeniedException", "You don't have access to the model")),
            "needs_setup",
            PICTURE_SETUP.format(
                why="Amazon Bedrock has not turned on Stable Image Core for this account in US West (Oregon)"
            ),
        ),
        (
            FakeCanvasClient(error=("ValidationException", "The model identifier is invalid")),
            "needs_setup",
            PICTURE_SETUP.format(
                why="Amazon Bedrock has not turned on Stable Image Core for this account in US West (Oregon)"
            ),
        ),
        (
            FakeCanvasClient(error=("ValidationException", "This request has been blocked by our content filters.")),
            "on",
            None,
        ),
        (FakeCanvasClient(transient=9), None, PICTURE_FAILED.format(label="Stable Image Core")),
        (FakeCanvasClient(body={"images": [], "error": "nope"}), "on", None),
        (FakeCanvasClient(body={"images": ["x"], "finish_reasons": ["Filter reason: prompt"]}), "on", None),
    ],
)
def test_picture_failures_say_what_the_call_proved(
    client: FakeCanvasClient, state: str | None, sentence: str | None
) -> None:
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(StabilityImages(ctx(client)).image("a cartoon", 1024, 1024, 1, []))
    assert e.value.state == state
    if sentence:
        assert e.value.sentence == sentence
    assert "tap try again" in e.value.sentence.lower()
    if state == "needs_setup":
        assert e.value.last_error == "Bedrock says Stable Image Core is not turned on for this account."


def test_a_picture_maker_without_a_model_proves_nothing_about_it() -> None:
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(OwnImages(ctx(FakeCanvasClient(), model=None)).image("x", 1024, 1024, 1, []))
    assert str(e.value) == providers.NO_OWN_MODEL.format(what="picture")  # no real call: no PROVIDER# state


def test_the_portrait_prompt_uses_words_and_never_hex() -> None:
    p = portrait_prompt(character())
    assert "#" not in p and "Lamo" in p and "cartoon" in p
    assert colour_name("#ff6f61") == "coral" and colour_name("bad") == "plain"


# --- the portrait job --------------------------------------------------------------------------------------------


def portrait_world(
    tmp_path: Path, client: FakeCanvasClient | None, images: str = "stability", image_model: str | None = None
) -> tuple[Services, Any, FakeTable]:
    table = FakeTable()
    table.seed(workspace({"providers": {"images": images, "video": "builtin-2d", "audio": "builtin-synth",
                                        "imageModel": image_model}}))  # fmt: skip
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
        image_model_id="amazon.nova-canvas-v1:0",  # the old process-wide id: never what a portrait uses (§45.37 G1)
        image_client=(lambda: client) if client else None,
        bedrock_runtime=client,
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
    assert asset["meta"]["model"] == "stable-image-core"  # the maker's first model: nothing was picked
    prov = table.item("PROVIDER#images#stability")
    assert prov is not None and prov["state"] == "on" and prov["checkedAt"] and "lastError" not in prov
    assert json.loads(client.calls[0]["body"])["seed"] == keys.seed_for("ch1", "portrait")
    assert client.calls[0]["modelId"] == "stability.stable-image-core-v1:1" and set(client.regions) == {"us-west-2"}
    (usage,) = table.prefix("USAGE#")  # provider usage, priced only when a price is known
    assert usage["kind"] == "provider" and usage["providerId"] == "stability" and usage["images"] == 1
    assert usage["modelId"] == "stability.stable-image-core-v1:1" and usage["cost"] is None
    # a second portrait keeps the first as an older version
    table.items[(PK, "PJOB#P1")]["status"] = "queued"
    table.items[(PK, "PJOB#P1")]["steps"] = [{"key": "portrait", "label": keys.PORTRAIT_LABEL, "status": "pending"}]
    assert run_portrait(svc) == "ready"
    assert sorted(a["meta"]["current"] for a in table.prefix("ASSET#")) == [0, 1]


def test_the_portrait_uses_the_picked_model_read_for_the_job(tmp_path: Path) -> None:
    client = FakeCanvasClient()
    svc, _store, table = portrait_world(tmp_path, client, image_model="sd3-5-large")
    assert run_portrait(svc) == "ready"
    assert [c["modelId"] for c in client.calls] == ["stability.sd3-5-large-v1:0"]
    assert table.item("PJOB#P1")["meta"]["imageModel"] == "sd3-5-large"  # type: ignore[index]
    # a pick that is not one of the maker's models stops with a sentence, and nothing is swapped
    client2 = FakeCanvasClient()
    svc, _store, table = portrait_world(tmp_path / "b", client2, image_model="luma-ray2")
    assert run_portrait(svc) == "failed" and client2.calls == []
    assert table.item("PJOB#P1")["error"] == providers.NOT_ITS_MODEL.format(
        what="picture", label="Stability AI pictures"
    )  # type: ignore[index]


def test_a_portrait_with_nova_canvas_picked_stops_with_the_ended_line_and_calls_nothing(tmp_path: Path) -> None:
    client = FakeCanvasClient()
    svc, _store, table = portrait_world(tmp_path, client, images="nova-canvas")
    assert run_portrait(svc) == "failed"
    job = table.item("PJOB#P1")
    assert job is not None and job["error"] == (
        "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › "
        "Settings › Video."
    )
    assert client.calls == [] and table.prefix("PROVIDER#") == [] and table.prefix("ASSET#") == []


def test_a_refused_portrait_records_needs_setup_and_fails_plainly(tmp_path: Path) -> None:
    svc, _store, table = portrait_world(tmp_path, FakeCanvasClient(error=("AccessDeniedException", "not authorized")))
    assert run_portrait(svc) == "failed"
    job = table.item("PJOB#P1")
    setup = PICTURE_SETUP.format(
        why="Amazon Bedrock has not turned on Stable Image Core for this account in US West (Oregon)"
    )
    assert job is not None and job["error"] == setup and job["steps"][0]["status"] == "failed"
    prov = table.item("PROVIDER#images#stability")
    assert prov is not None and prov["state"] == "needs_setup"
    assert prov["lastError"] == "Bedrock says Stable Image Core is not turned on for this account."
    assert table.prefix("ASSET#") == []


def test_a_transient_failure_records_nothing_about_the_provider(tmp_path: Path) -> None:
    svc, _store, table = portrait_world(tmp_path, FakeCanvasClient(transient=9))
    assert run_portrait(svc) == "failed"
    assert table.item("PROVIDER#images#stability") is None


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


# --- Luma AI Ray2 (§45.37 G7): StartAsyncInvoke into the us-west-2 bucket, cut-away scenes only -------------------


class FakeWest:
    """bedrock-runtime in us-west-2 (start_async_invoke / get_async_invoke) and S3 there (list, download). A Luma shot
    lands as ``{folder}/{some name}.mp4`` (AWS's pages name the folder, not the file)."""

    def __init__(self, tmp: Path, *, error: tuple[str, str] | None = None, fail: bool = False) -> None:
        self.tmp = tmp
        self.error = error
        self.fail = fail
        self.starts: list[dict[str, Any]] = []
        self.polls = 0
        self.downloads: list[tuple[str, str]] = []
        self.regions: list[str] = []

    def __call__(self, region: str) -> FakeWest:
        self.regions.append(region)
        return self

    def start_async_invoke(self, **kw: Any) -> dict[str, Any]:
        self.starts.append(kw)
        if self.error:
            raise ClientError({"Error": {"Code": self.error[0], "Message": self.error[1]}}, "StartAsyncInvoke")
        return {"invocationArn": "arn:aws:bedrock:us-west-2:1:async-invoke/abc"}

    def get_async_invoke(self, **kw: Any) -> dict[str, Any]:
        self.polls += 1
        if self.polls < 2:
            return {"status": "InProgress"}
        if self.fail:
            return {"status": "Failed", "failureMessage": "blocked"}
        uri = self.starts[0]["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] + "abc"
        return {"status": "Completed", "outputDataConfig": {"s3OutputDataConfig": {"s3Uri": uri}}}

    def list_objects_v2(self, *, Bucket: str, Prefix: str) -> dict[str, Any]:
        return {"Contents": [{"Key": f"{Prefix}manifest.json"}, {"Key": f"{Prefix}d8a1-shot.mp4"}]}

    def download_file(self, bucket: str, key: str, path: str) -> None:
        import subprocess

        self.downloads.append((bucket, key))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=24", "-t", "5",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path],
            check=True, timeout=120,
        )  # fmt: skip


LUMA = config.pick_model("video", "luma-ray", None)


def luma_ctx(tmp: Path, fake: FakeWest | None, bucket: str = "cf-prod-stories-video-1-usw2") -> ProviderContext:
    async def no_wait(_: float) -> None:
        return None

    return ProviderContext(
        engine=Engine(ENGINE_DIR, tmp / ".deno"),
        workdir=tmp,
        video_model=LUMA,
        video_west_bucket=bucket,
        bedrock=fake,
        s3_in=fake,
        reel_prefix=lambda sid: f"ws/{USER}/{WS}/stories/ST1/reel/{sid}/v1/",
        sleep=no_wait,
    )


CUTAWAY = {"scenes": [{"sceneId": "s9", "title": "The icy road", "durationSec": 4, "set": "icy_road", "view": "side",
                       "camera": "wide", "actors": [], "props": [{"propId": "p1", "kind": "ice_sign", "x": 0.5,
                       "y": 0.5, "scale": 1, "rot": 0}], "beats": [], "sfx": [], "seed": 77}]}  # fmt: skip


@needs_ffmpeg
def test_luma_ray_makes_a_cut_away_shot_in_the_oregon_bucket(tmp_path: Path) -> None:
    fake = FakeWest(tmp_path)
    out = tmp_path / "s9.mp4"
    clip = asyncio.run(LumaRay(luma_ctx(tmp_path, fake)).render_scene(CUTAWAY, "s9", {}, out))
    (start,) = fake.starts
    assert start["modelId"] == "luma.ray-v2:0" and set(fake.regions) == {"us-west-2"}
    assert start["modelInput"] == {"prompt": start["modelInput"]["prompt"], "aspect_ratio": "9:16", "loop": False,
                                   "duration": "5s", "resolution": "720p"}  # fmt: skip
    assert start["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] == (
        f"s3://cf-prod-stories-video-1-usw2/ws/{USER}/{WS}/stories/ST1/reel/s9/v1/"
    )
    assert "no people" in start["modelInput"]["prompt"]
    assert fake.downloads == [
        ("cf-prod-stories-video-1-usw2", f"ws/{USER}/{WS}/stories/ST1/reel/s9/v1/abc/d8a1-shot.mp4")
    ]
    import subprocess

    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(out)],
        capture_output=True, check=True, timeout=60,
    ).stdout)  # fmt: skip
    video = probe["streams"][0]
    assert (video["width"], video["height"], video["avg_frame_rate"]) == (1080, 1920, "30/1")
    assert float(probe["format"]["duration"]) == pytest.approx(4.0, abs=0.1) and clip.duration_sec == 4


def test_luma_ray_needs_its_oregon_bucket_and_says_what_a_refusal_proved(tmp_path: Path) -> None:
    with pytest.raises(ProviderUnavailable) as off:
        asyncio.run(LumaRay(luma_ctx(tmp_path, FakeWest(tmp_path), bucket="")).render_scene(CUTAWAY, "s9", {},
                                                                                             tmp_path / "x.mp4"))  # fmt: skip
    assert (
        str(off.value)
        == LUMA_NOT_READY
        == (
            "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched "
            "off, and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its "
            "setup."
        )
    )
    denied = FakeWest(tmp_path, error=("AccessDeniedException", "You don't have access to the model"))
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(LumaRay(luma_ctx(tmp_path, denied)).render_scene(CUTAWAY, "s9", {}, tmp_path / "x.mp4"))
    assert e.value.state == "needs_setup" and e.value.last_error == LUMA_NOT_ENABLED and e.value.sentence == LUMA_SETUP
    failed = FakeWest(tmp_path, fail=True)
    with pytest.raises(ProviderFailed) as f:
        asyncio.run(LumaRay(luma_ctx(tmp_path, failed)).render_scene(CUTAWAY, "s9", {}, tmp_path / "x.mp4"))
    assert f.value.state == "on" and f.value.sentence == SHOT_FAILED.format(label="Luma AI Ray2")


def test_nova_reel_is_ended_and_never_called(tmp_path: Path) -> None:
    fake = FakeWest(tmp_path)
    reel = NovaReel(ProviderContext(engine=Engine(ENGINE_DIR, tmp_path), workdir=tmp_path,
                                    video_bucket="cf-prod-stories-video-1-us", reel_client=lambda: fake,
                                    us_s3=lambda: fake))  # fmt: skip
    sentence = "Amazon Nova Reel 1.1 was ended by Amazon on 30 Sep 2026. Pick another video maker in Lamo Stories › Settings › Video."
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(reel.render_scene(CUTAWAY, "s9", {}, tmp_path / "x.mp4"))
    assert str(e.value) == sentence
    with pytest.raises(ProviderUnavailable):
        asyncio.run(reel.shot("x", 1, "1280x720", "p/"))
    assert fake.starts == [] and reel.check().state == "ended"


def test_an_ai_video_maker_never_draws_a_scene_with_a_character() -> None:
    from lamostories_agent.pipeline import StoryJob

    job = StoryJob.__new__(StoryJob)
    for maker in ("luma-ray", "own-video"):
        job.config = {"providers": {"video": maker}}
        assert job._scene_provider({"actors": [{"castId": "c1"}]}) == "builtin-2d"
        assert job._scene_provider({"actors": []}) == maker
    prompt = reel_prompt({}, {**CUTAWAY["scenes"][0], "title": "Lamo slips"})
    assert "Lamo" not in prompt and "icy road" in prompt and "ice sign" in prompt  # places and things, no one
