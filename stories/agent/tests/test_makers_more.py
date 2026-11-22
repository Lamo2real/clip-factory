"""The makers, second review (docs/CONTRACTS.md §45.37 G1-G4, G7): every Bedrock model id form the API saves (a
cross-Region profile id, an ARN, any video id) is kept and either used or refused with a sentence, never dropped; a key
that cannot be read stops with a plain sentence; the OpenAI-compatible picture maker (its request, retry, PNG and JPEG
answers, refusals, the job's own key); an own video model's bucket by Region; the sound makers bill each part with its
own model and never ask for what the mix leaves out; Try it never swaps a stale pick. Fakes only: no AWS, no network."""

from __future__ import annotations

import asyncio
import base64
import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from lamostories_agent import config, keys, providers
from lamostories_agent import hosts as keyed
from lamostories_agent.data import JobFence
from lamostories_agent.engine import Engine
from lamostories_agent.hosts import Answer
from lamostories_agent.pipeline import StoryJob
from lamostories_agent.providers import (
    OWN_VIDEO_NOT_READY,
    PICTURE_REFUSED,
    PICTURE_SETUP,
    VIDEO_UNKNOWN,
    ElevenLabsSound,
    OwnImages,
    OwnVideo,
    PollyVoice,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    sound_models,
)
from ls_fakes import ENGINE_DIR, USER, WS, needs_ffmpeg
from test_hosts import FakeHttp, FakeKeys
from test_makers import EVENTS, SCRIPT, FakeEngine, FakePolly, makerdef, sound_ctx, wav
from test_stories_pipeline import STORY, story_item, workspace, world
from test_stories_providers import PNG, FakeCanvasClient, portrait_world, run_portrait
from test_stories_round4 import FakeUS, check_world, run_check


@pytest.fixture(autouse=True)
def _no_retry_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    import functools

    from lamostories_agent.retry import retry

    monkeypatch.setattr(providers, "retry", functools.partial(retry, base=0.0))


def own(key: str, kind: str, model_id: str, region: str = "us-west-2", **fields: Any) -> dict[str, Any]:
    entry = config.maker_from_def(makerdef(key, kind=kind, host="bedrock", modelId=model_id, region=region, **fields))
    assert entry is not None, model_id
    return entry


# --- every Bedrock id form the API saves ---------------------------------------------------------------------------

PROFILE = "us.stability.sd3-5-large-v1:0"
ARN = "arn:aws:bedrock:us-west-2::foundation-model/stability.sd3-5-large-v1:0"


def test_the_api_s_bedrock_id_forms_are_kept_never_dropped() -> None:
    assert config.bare_model_id(PROFILE) == config.bare_model_id(ARN) == "stability.sd3-5-large-v1:0"
    assert config.bare_model_id("us.luma.ray-v2:0") == "luma.ray-v2:0"
    assert config.bare_model_id("global.amazon.nova-reel-v1:1") == "amazon.nova-reel-v1:1"
    assert config.bare_model_id("stability.x") == "stability.x"
    defs = [
        makerdef("custom-profile", kind="image", host="bedrock", modelId=PROFILE, region="us-west-2"),
        makerdef("custom-arn", kind="image", host="bedrock", modelId=ARN, region="us-west-2"),
        makerdef("custom-lumap", kind="video", host="bedrock", modelId="us.luma.ray-v2:0", region="us-west-2"),
        makerdef("custom-other", kind="video", host="bedrock", modelId="amazon.nova-pro-v1:0", region="us-east-1"),
    ]
    merged = config.merged_makers(defs)
    assert {m["key"]: m["modelId"] for k in ("image", "video") for m in merged[k] if m["custom"]} == {
        "custom-profile": PROFILE,
        "custom-arn": ARN,
        "custom-lumap": "us.luma.ray-v2:0",
        "custom-other": "amazon.nova-pro-v1:0",
    }  # as saved: the call uses the id the owner gave
    # a Bedrock picture model Lamo Stories cannot draw with is still left out, in any form (the API refuses it too)
    for bad in ("anthropic.claude-x", "us.anthropic.claude-x", "arn:aws:bedrock:us-west-2::foundation-model/meta.x"):
        assert config.maker_from_def(makerdef("custom-bad", kind="image", host="bedrock", modelId=bad)) is None


@pytest.mark.parametrize("model_id", [PROFILE, ARN])
def test_a_picture_model_saved_as_a_profile_id_or_an_arn_draws_with_the_stability_shape(model_id: str) -> None:
    client = FakeCanvasClient()
    entry = own("custom-sd", "image", model_id)
    ctx = ProviderContext(engine=Engine(ENGINE_DIR, Path("/tmp")), workdir=Path("/tmp"), image_model=entry,
                          bedrock=client)  # type: ignore[arg-type]  # fmt: skip
    assert asyncio.run(OwnImages(ctx).image("a cartoon", 1024, 1024, 7, [])) == PNG
    (call,) = client.calls
    assert call["modelId"] == model_id and client.regions == ["us-west-2"]
    body = json.loads(call["body"])
    assert body["seed"] == 7 and body["output_format"] == "png" and "aspect_ratio" in body


async def _no_wait(_: float) -> None:
    return None


def video_ctx(fake: Any, entry: dict[str, Any], *, west: str = "cf-prod-stories-video-1-usw2",
              us: str = "cf-prod-stories-video-1-us") -> ProviderContext:  # fmt: skip
    return ProviderContext(engine=Engine(ENGINE_DIR, Path("/tmp")), workdir=Path("/tmp"), video_model=entry,
                           video_west_bucket=west, video_bucket=us, bedrock=fake, s3_in=fake,
                           reel_prefix=lambda sid: f"ws/{USER}/{WS}/stories/ST1/reel/{sid}/v1/", sleep=_no_wait)  # fmt: skip


def test_a_luma_model_saved_as_a_profile_id_is_asked_with_the_luma_shape_and_its_own_id() -> None:
    fake = FakeUS()
    entry = own("custom-lumap", "video", "us.luma.ray-v2:0")
    key = asyncio.run(OwnVideo(video_ctx(fake, entry)).shot("a road", 1, 1080, 1920, "ws/x/reel/s1/v1/"))
    (start,) = fake.starts
    assert start["modelId"] == "us.luma.ray-v2:0" and start["modelInput"]["duration"] == "5s"
    assert (
        start["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"] == "s3://cf-prod-stories-video-1-usw2/ws/x/reel/s1/v1/"
    )
    assert key.endswith(".mp4") and set(fake.regions) == {"us-west-2"}


def test_a_video_model_lamo_stories_cannot_ask_is_refused_before_any_call() -> None:
    fake = FakeUS()
    entry = own("custom-other", "video", "amazon.nova-pro-v1:0", region="us-east-1", label="Nova Pro")
    for call in (
        lambda: OwnVideo(video_ctx(fake, entry)).shot("a road", 1, 1080, 1920, "p/"),
        lambda: OwnVideo(video_ctx(fake, entry)).render_scene({"scenes": []}, "s1", {}, Path("/tmp/x.mp4")),
    ):
        with pytest.raises(ProviderUnavailable) as e:
            asyncio.run(call())
        assert str(e.value) == VIDEO_UNKNOWN.format(label="Nova Pro")
    assert fake.starts == [] and fake.regions == []


# --- an own video model: its Region's bucket -------------------------------------------------------------------------


def test_an_own_nova_reel_shaped_model_in_n_virginia_uses_the_us_bucket_and_the_nova_reel_shape() -> None:
    fake = FakeUS()
    entry = own("custom-reel", "video", "amazon.nova-reel-v1:1", region="us-east-1")
    video = OwnVideo(video_ctx(fake, entry))
    assert video.bucket(entry) == "cf-prod-stories-video-1-us" and video.shot_seconds(entry) == providers.REEL_SHOT
    asyncio.run(video.shot("a road", 9, 1080, 1920, "ws/x/reel/s1/v1/"))
    (start,) = fake.starts
    assert start["modelId"] == "amazon.nova-reel-v1:1" and set(fake.regions) == {"us-east-1"}
    assert start["modelInput"]["taskType"] == "TEXT_VIDEO"
    assert start["modelInput"]["videoGenerationConfig"]["durationSeconds"] == providers.REEL_SHOT
    assert start["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"].startswith("s3://cf-prod-stories-video-1-us/")


def test_an_own_video_model_in_a_region_without_a_bucket_says_it_is_not_ready_and_calls_nothing() -> None:
    fake = FakeUS()
    for region in ("eu-west-1", "us-east-2"):
        entry = own("custom-luma-eu", "video", "luma.ray-v2:0", region=region)
        assert OwnVideo(video_ctx(fake, entry)).bucket(entry) == ""
        with pytest.raises(ProviderUnavailable) as e:
            asyncio.run(OwnVideo(video_ctx(fake, entry)).shot("a road", 1, 1080, 1920, "p/"))
        assert str(e.value) == OWN_VIDEO_NOT_READY
    off = own("custom-reel", "video", "amazon.nova-reel-v1:1", region="us-east-1")
    with pytest.raises(ProviderUnavailable):  # the US bucket switched off
        asyncio.run(OwnVideo(video_ctx(fake, off, us="")).shot("a road", 1, 1080, 1920, "p/"))
    assert fake.starts == []


# --- a key that cannot be read -----------------------------------------------------------------------------------


class UnreadableKeys:
    """Secrets Manager refusing the read (AccessDenied, KMS or a throttle) through the real ``ProviderKeys``."""

    def __init__(self, code: str = "AccessDeniedException") -> None:
        self.code = code
        self.asked: list[str] = []

    def get_secret_value(self, *, SecretId: str) -> dict[str, Any]:
        self.asked.append(SecretId)
        raise ClientError({"Error": {"Code": self.code, "Message": "no"}}, "GetSecretValue")


OC_PIC = {"key": "custom-oc", "label": "GPT image", "maker": "own-images", "hostId": "openai_compatible",
          "kind": "image", "modelId": "gpt-image-1", "baseUrl": "https://api.example-images.com/v1"}  # fmt: skip


@pytest.mark.parametrize("code", ["AccessDeniedException", "ThrottlingException", "KMSAccessDeniedException"])
def test_a_key_that_cannot_be_read_stops_with_a_plain_sentence_and_proves_nothing(tmp_path: Path, code: str) -> None:
    secrets = UnreadableKeys(code)
    source = keyed.ProviderKeys("cf-prod/workspaces/", lambda: secrets)
    http = FakeHttp(Answer(200, b""))
    reader = lambda host: source.key(WS, host)  # noqa: E731
    with pytest.raises(ProviderFailed) as sound:
        asyncio.run(ElevenLabsSound(sound_ctx(tmp_path, sound_models=sound_models({"providers": {"audio": "elevenlabs"}}),
                                              provider_key=reader, http=http)).mix(SCRIPT, tmp_path / "m.m4a"))  # fmt: skip
    assert (
        sound.value.sentence
        == providers.KEY_UNREADABLE.format(words="ElevenLabs")
        == (
            "Lamo Stories could not read the key you saved for ElevenLabs. Tap Try again. If it keeps happening, paste "
            "the key again in Lamo Stories › Settings › AI › Provider keys."
        )
    )
    assert sound.value.state is None  # a read that never reached ElevenLabs proves nothing about it
    assert sound.value.last_error == "Lamo Stories could not read the saved key for ElevenLabs."
    ctx = ProviderContext(engine=Engine(ENGINE_DIR, Path("/tmp")), workdir=tmp_path, image_model=OC_PIC,
                          provider_key=reader, http=http)  # fmt: skip
    with pytest.raises(ProviderFailed) as picture:
        asyncio.run(OwnImages(ctx).image("a cartoon", 1024, 1024, 1, []))
    assert picture.value.sentence == providers.KEY_UNREADABLE.format(words="the OpenAI-compatible API")
    assert picture.value.state is None
    assert http.calls == [] and secrets.asked == [f"cf-prod/workspaces/{WS}/providers/elevenlabs",
                                                  f"cf-prod/workspaces/{WS}/providers/openai_compatible"]  # fmt: skip


def test_a_portrait_whose_key_cannot_be_read_fails_with_the_sentence_and_writes_no_record(tmp_path: Path) -> None:
    svc, _store, table = portrait_world(tmp_path, None, images="own-images", image_model="custom-oc")
    table.seed(makerdef("custom-oc", kind="image", host="openai_compatible", modelId="gpt-image-1",
                        baseUrl="https://api.example-images.com/v1", label="GPT image"))  # fmt: skip
    svc.provider_keys = keyed.ProviderKeys("cf-prod/workspaces/", UnreadableKeys)
    svc.http = FakeHttp(Answer(200, b""))
    assert run_portrait(svc) == "failed"
    assert table.item("PJOB#P1")["error"] == providers.KEY_UNREADABLE.format(words="the OpenAI-compatible API")  # type: ignore[index]
    assert table.prefix("PROVIDER#") == [] and svc.http.calls == []


# --- the OpenAI-compatible picture maker ---------------------------------------------------------------------------


def picture_answer(data: bytes) -> Answer:
    return Answer(200, json.dumps({"data": [{"b64_json": base64.b64encode(data).decode()}]}).encode())


def oc_ctx(tmp: Path, http: FakeHttp, key: str | None = "oc-owner-key-123") -> ProviderContext:
    keys_ = FakeKeys({(WS, "openai_compatible"): key} if key else {})
    return ProviderContext(engine=Engine(ENGINE_DIR, Path("/tmp")), workdir=tmp, image_model=OC_PIC,
                           provider_key=lambda host: keys_.key(WS, host), http=http)  # fmt: skip


def test_the_openai_compatible_picture_maker_asks_its_address_with_the_owner_s_key(tmp_path: Path) -> None:
    http = FakeHttp(picture_answer(PNG))
    assert asyncio.run(OwnImages(oc_ctx(tmp_path, http)).image("a cartoon dog", 1024, 1024, 1, [])) == PNG
    (call,) = http.calls
    assert (call["method"], call["url"]) == ("POST", "https://api.example-images.com/v1/images/generations")
    assert call["headers"]["Authorization"] == "Bearer oc-owner-key-123"
    assert call["body"] == {"model": "gpt-image-1", "prompt": "a cartoon dog", "n": 1, "size": "1024x1024",
                            "response_format": "b64_json"}  # fmt: skip
    tall = FakeHttp(picture_answer(PNG))
    asyncio.run(OwnImages(oc_ctx(tmp_path, tall)).image("x", 1080, 1920, 1, []))
    assert tall.calls[0]["body"]["size"] == "1024x1536"


def test_a_model_that_always_answers_in_base64_is_asked_again_without_response_format(tmp_path: Path) -> None:
    http = FakeHttp(
        Answer(400, b'{"error": {"message": "Unknown parameter: \'response_format\'."}}'), picture_answer(PNG)
    )
    assert asyncio.run(OwnImages(oc_ctx(tmp_path, http)).image("a cartoon", 1024, 1024, 1, [])) == PNG
    first, second = http.calls
    assert first["body"]["response_format"] == "b64_json" and "response_format" not in second["body"]


@needs_ffmpeg
def test_a_jpeg_answer_is_kept_as_a_png(tmp_path: Path) -> None:
    jpeg = tmp_path / "in.jpg"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1",
                    str(jpeg)], check=True, timeout=60)  # fmt: skip
    data = jpeg.read_bytes()
    assert data[:3] == b"\xff\xd8\xff"
    got = asyncio.run(OwnImages(oc_ctx(tmp_path / "w", FakeHttp(picture_answer(data)))).image("x", 16, 16, 1, []))
    assert got.startswith(b"\x89PNG")


@pytest.mark.parametrize(
    ("answer", "state", "sentence"),
    [
        (Answer(400, b'{"error": {"message": "Your request was rejected by our safety system."}}'), "on",
         PICTURE_REFUSED.format(label="GPT image")),
        (Answer(401, b'{"error": {"message": "Incorrect API key provided: oc-owner-key-123"}}'), "needs_setup",
         PICTURE_SETUP.format(why="the OpenAI-compatible API refused the saved key (paste it again in Lamo Stories "
                                  "› Settings › AI › Provider keys)")),
        (Answer(403, b'{"error": {"message": "not allowed"}}'), "needs_setup",
         PICTURE_SETUP.format(why="the OpenAI-compatible API says this key may not use it")),
        (Answer(404, b'{"error": {"message": "no such model"}}'), "needs_setup",
         PICTURE_SETUP.format(why="the OpenAI-compatible API cannot find this model")),
        (Answer(200, b'{"data": [{"b64_json": "!!not base64!!"}]}'), "on", PICTURE_REFUSED.format(label="GPT image")),
        (picture_answer(b"<html>not a picture</html>"), "on",
         "GPT image sent something that is not a picture. Tap Try again."),
    ],
)  # fmt: skip
def test_openai_compatible_picture_failures_say_what_the_call_proved_and_never_show_the_key(
    tmp_path: Path, answer: Answer, state: str, sentence: str
) -> None:
    http = FakeHttp(answer)
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(OwnImages(oc_ctx(tmp_path, http)).image("a cartoon", 1024, 1024, 1, []))
    assert (e.value.state, e.value.sentence) == (state, sentence)
    for text in (e.value.sentence, e.value.last_error or "", e.value.detail or ""):
        assert "oc-owner-key-123" not in text


def test_without_a_key_the_openai_compatible_picture_maker_needs_setting_up_and_calls_nothing(tmp_path: Path) -> None:
    http = FakeHttp(picture_answer(PNG))
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(OwnImages(oc_ctx(tmp_path, http, key=None)).image("a cartoon", 1024, 1024, 1, []))
    assert e.value.state == "needs_setup" and http.calls == []


def test_a_portrait_job_with_an_own_openai_compatible_model_reads_its_own_workspace_s_key(tmp_path: Path) -> None:
    svc, store, table = portrait_world(tmp_path, None, images="own-images", image_model="custom-oc")
    table.seed(makerdef("custom-oc", kind="image", host="openai_compatible", modelId="gpt-image-1",
                        baseUrl="https://api.example-images.com/v1", label="GPT image"))  # fmt: skip
    keys_ = FakeKeys({(WS, "openai_compatible"): "oc-owner-key-123", ("other-ws", "openai_compatible"): "not-it"})
    http = FakeHttp(picture_answer(PNG))
    svc.provider_keys, svc.http = keys_, http
    assert run_portrait(svc) == "ready"
    assert keys_.reads == [(WS, "openai_compatible")]
    assert http.calls[0]["headers"]["Authorization"] == "Bearer oc-owner-key-123"
    (asset,) = table.prefix("ASSET#")
    assert store.objects[asset["key"]][0] == PNG and asset["meta"]["model"] == "custom-oc"
    assert table.item("PROVIDER#images#own-images")["state"] == "on"  # type: ignore[index]
    (usage,) = table.prefix("USAGE#")
    assert usage["modelId"] == "gpt-image-1" and usage["units"] == 1


# --- the sound makers: each part billed on its own model, nothing made that the mix leaves out ---------------------


def _el_ctx(tmp: Path, http: FakeHttp) -> ProviderContext:
    keys_ = FakeKeys({(WS, "elevenlabs"): "el-owner"})
    return sound_ctx(tmp, sound_models=sound_models({"providers": {"audio": "elevenlabs"}}),
                     provider_key=lambda host: keys_.key(WS, host), http=http)  # fmt: skip


@needs_ffmpeg
@pytest.mark.parametrize("mood", ["none", "spooky_unknown"])
def test_no_music_bed_is_asked_for_when_the_mix_would_play_none(tmp_path: Path, mood: str) -> None:
    http = FakeHttp(lambda call: Answer(200, wav(0.8)))
    maker = ElevenLabsSound(_el_ctx(tmp_path, http))
    asyncio.run(maker.mix({**SCRIPT, "music": {"mood": mood, "volume": 0.5}}, tmp_path / "mix.m4a"))
    assert not any("/v1/music" in c["url"] for c in http.calls)
    assert [p["role"] for p in maker.made_parts] == ["effects"] and maker.made["music"] is None


@needs_ffmpeg
def test_each_sound_part_is_billed_on_its_own_model(tmp_path: Path) -> None:
    http = FakeHttp(lambda call: Answer(200, wav(0.8 if "sound-generation" in call["url"] else 3.0)))
    maker = ElevenLabsSound(_el_ctx(tmp_path, http))
    asyncio.run(maker.mix(SCRIPT, tmp_path / "mix.m4a"))
    assert {p["modelId"]: (p["role"], p["unit"]) for p in maker.made_parts} == {
        "eleven_text_to_sound_v2": ("effects", "second"),
        "music_v1": ("music", "second"),
    }
    assert {p["key"] for p in maker.made_parts} == {"elevenlabs-effects", "elevenlabs-music"}


@needs_ffmpeg
def test_what_was_made_before_a_later_call_failed_is_still_billed(tmp_path: Path) -> None:
    def answer(call: dict[str, Any]) -> Answer:
        return Answer(200, wav(0.8)) if "sound-generation" in call["url"] else Answer(400, b'{"detail": "bad"}')

    svc, _store, table, _ = world(tmp_path, config={"providers": {"images": "builtin-rig", "video": "builtin-2d",
                                                                 "audio": "elevenlabs"}})  # fmt: skip
    svc.http = FakeHttp(answer)
    svc.provider_keys = FakeKeys({(WS, "elevenlabs"): "el-owner"})
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    job.story = story_item()
    job.config = workspace({"providers": {"audio": "elevenlabs"}})["configuration"]
    job.maker_models = asyncio.run(job.makers())
    job.engine = FakeEngine(EVENTS)  # type: ignore[assignment]
    job.work.mkdir(parents=True, exist_ok=True)
    with pytest.raises(ProviderFailed):
        asyncio.run(job._make_sound(SCRIPT))
    (usage,) = table.prefix("USAGE#")  # the two effects ElevenLabs made (and billed); the music never came
    assert usage["modelId"] == "eleven_text_to_sound_v2" and usage["units"] == pytest.approx(2.5, abs=0.01)
    assert not [a for a in table.prefix("ASSET#") if a["kind"] == "audio"]


@needs_ffmpeg
def test_a_spoken_line_past_the_end_of_the_video_is_never_asked_for(tmp_path: Path) -> None:
    polly = FakePolly()
    script = {**SCRIPT, "captions": [{"id": "c1", "at": 0.2, "dur": 1.5, "text": "Slow down on ice."},
                                     {"id": "c2", "at": 9.0, "dur": 1.5, "text": "Too late."}]}  # fmt: skip
    maker = PollyVoice(sound_ctx(tmp_path, sound_models=sound_models({"providers": {"audio": "polly"}}), polly=polly))
    asyncio.run(maker.mix(script, tmp_path / "mix.m4a"))
    assert [s["Text"] for s in polly.spoken] == ["Slow down on ice."]
    assert maker.made_parts == [{"role": "voice", "key": "polly-neural", "modelId": "neural",
                                 "units": float(len("Slow down on ice.")), "unit": "character"}]  # fmt: skip


# --- Try it never tests another model in place of a stale pick -----------------------------------------------------


def test_try_it_with_a_stale_luma_pick_stops_with_the_story_job_s_sentence_and_calls_nothing(tmp_path: Path) -> None:
    fake = FakeUS()
    svc, table = check_world(tmp_path, fake)
    table.seed(workspace({"providers": {"images": "builtin-rig", "video": "luma-ray", "audio": "builtin-synth",
                                        "videoModel": "custom-deleted"}}))  # fmt: skip
    assert run_check(svc) == "failed"
    job = table.item("PJOB#J9")
    assert job is not None and job["error"] == providers.NOT_ITS_MODEL.format(what="video", label="Luma AI Ray2")
    assert fake.starts == [] and table.item(keys.provider_sk("animation", "luma-ray")) is None
    # the same pick stops a story the same way
    with pytest.raises(ProviderUnavailable) as story:
        providers.maker_model("animation", {"providers": {"video": "luma-ray", "videoModel": "custom-deleted"}})
    assert str(story.value) == job["error"]


def test_try_it_without_a_pick_uses_luma_ray2(tmp_path: Path) -> None:
    fake = FakeUS()
    svc, table = check_world(tmp_path, fake)
    table.seed(workspace({"providers": {"images": "builtin-rig", "video": "luma-ray", "audio": "builtin-synth",
                                        "videoModel": None}}))  # fmt: skip
    assert run_check(svc) == "ready"
    assert [s["modelId"] for s in fake.starts] == ["luma.ray-v2:0"]
