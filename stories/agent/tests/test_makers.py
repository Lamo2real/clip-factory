"""The makers and their models (docs/CONTRACTS.md §45.37 G1-G3, G7): the bundled picture, video and sound models of
``stories/config/models.json`` (an old file's single ``imageModel`` / ``videoModel`` reads as a one-item list), the
owner's own ``MAKERDEF#`` models, the workspace's pick read for each job (never a process-wide choice), the ended
models never picked or called, and the sound makers: the built-in synth stays the default and wordless; ElevenLabs
makes the effects and an instrumental music bed with the owner's key; Amazon Polly speaks only when the owner picks
it. Everything here runs on fakes (no AWS, no network)."""

from __future__ import annotations

import asyncio
import io
import json
import math
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from lamostories_agent import audio, config, keys, providers
from lamostories_agent.data import JobFence
from lamostories_agent.hosts import Answer
from lamostories_agent.pipeline import StoryJob
from lamostories_agent.providers import (
    ElevenLabsSound,
    OwnSound,
    PollyVoice,
    ProviderContext,
    ProviderFailed,
    ProviderUnavailable,
    maker_model,
    sound_models,
    spoken_lines,
)
from ls_fakes import PK, REPO, USER, WS, FakeTable, data, needs_ffmpeg
from test_hosts import FakeHttp, FakeKeys
from test_stories_pipeline import STORY, story_item, workspace, world

RAW = json.loads((REPO / "stories" / "config" / "models.json").read_text("utf-8"))


def makerdef(key: str, **fields: Any) -> dict[str, Any]:
    return {"pk": PK, "sk": f"MAKERDEF#{key}", "type": "ws_makerdef", "userId": USER, "workspaceId": WS, "key": key,
            **fields}  # fmt: skip


# --- the bundled lists -----------------------------------------------------------------------------------------------


def test_the_bundled_makers_are_the_settled_models_with_their_regions_and_nothing_ended_is_picked() -> None:
    lists = {kind: [m["key"] for m in RAW[config.MAKER_LISTS[kind]]] for kind in config.MAKER_KINDS}
    assert lists == {
        "image": ["nova-canvas", "stable-image-core", "stable-image-ultra", "sd3-5-large"],
        "video": ["nova-reel", "luma-ray2"],
        "audio": ["polly-neural", "elevenlabs-effects", "elevenlabs-music"],
    }
    by_key = {m["key"]: m for kind in config.MAKER_LISTS.values() for m in RAW[kind]}
    assert {k: (m["maker"], m["modelId"]) for k, m in by_key.items()} == {
        "nova-canvas": ("nova-canvas", "amazon.nova-canvas-v1:0"),
        "stable-image-core": ("stability", "stability.stable-image-core-v1:1"),
        "stable-image-ultra": ("stability", "stability.stable-image-ultra-v1:1"),
        "sd3-5-large": ("stability", "stability.sd3-5-large-v1:0"),
        "nova-reel": ("nova-reel", "amazon.nova-reel-v1:1"),
        "luma-ray2": ("luma-ray", "luma.ray-v2:0"),
        "polly-neural": ("polly", "neural"),
        "elevenlabs-effects": ("elevenlabs", "eleven_text_to_sound_v2"),
        "elevenlabs-music": ("elevenlabs", "music_v1"),
    }
    for key in ("stable-image-core", "stable-image-ultra", "sd3-5-large", "luma-ray2"):
        assert by_key[key]["region"] == "us-west-2" and by_key[key]["host"] == "Amazon Bedrock"
    assert {k for k, m in by_key.items() if m.get("ended")} == {"nova-canvas", "nova-reel"}
    assert all(by_key[k]["ended"] == "2026-09-30" for k in ("nova-canvas", "nova-reel"))
    assert (by_key["polly-neural"]["region"], by_key["polly-neural"]["host"]) == ("eu-west-1", "Amazon Polly")
    assert by_key["elevenlabs-effects"]["host"] == by_key["elevenlabs-music"]["host"] == "elevenlabs"
    assert all(m["price"] is None for m in by_key.values())  # no price is confirmed for any of them
    for m in by_key.values():
        assert set(m) <= {"key", "label", "provider", "maker", "host", "modelId", "region", "kind", "price", "note",
                          "ended", "role", "voice", "shotSec"}, m["key"]  # fmt: skip
    # the old single entries stay for older readers (and Terraform); nothing reads them for a pick any more
    assert (
        RAW["imageModel"]["modelId"] == "amazon.nova-canvas-v1:0"
        and RAW["videoModel"]["modelId"] == "amazon.nova-reel-v1:1"
    )
    # a maker's default is its first model that has not ended; an ended maker has none
    assert config.pick_model("image", "stability", None)["key"] == "stable-image-core"  # type: ignore[index]
    assert config.pick_model("image", "nova-canvas", None) is None
    assert config.pick_model("video", "nova-reel", None) is None
    defaults = json.loads((REPO / "stories" / "config" / "workspace-defaults.json").read_text("utf-8"))
    assert defaults["providers"] == {"images": "builtin-rig", "video": "builtin-2d", "audio": "builtin-synth",
                                     "imageModel": None, "videoModel": None, "audioModel": None}  # fmt: skip


def test_an_old_models_file_with_single_entries_reads_as_one_item_lists() -> None:
    old = {k: v for k, v in RAW.items() if k not in ("imageModels", "videoModels", "audioModels")}
    image = config.bundled_makers("image", old)
    video = config.bundled_makers("video", old)
    assert [(m["key"], m["maker"], m["modelId"]) for m in image] == [
        ("nova-canvas", "nova-canvas", "amazon.nova-canvas-v1:0")
    ]
    assert [(m["key"], m["maker"], m["region"]) for m in video] == [("nova-reel", "nova-reel", "us-east-1")]
    assert config.bundled_makers("audio", old) == []


# --- the owner's own maker models (MAKERDEF#) ------------------------------------------------------------------------


def test_the_owners_maker_models_are_checked_and_merged_per_kind() -> None:
    good = [
        makerdef("custom-sdxl", kind="image", host="bedrock", modelId="stability.sd3-5-large-v1:0", region="us-west-2",
                 label="My SD"),
        makerdef("custom-oc-pic", kind="image", host="openai_compatible", modelId="gpt-image-1",
                 baseUrl="https://api.openai.com/v1/"),
        makerdef("custom-luma9", kind="video", host="bedrock", modelId="luma.ray-v2:0", region="us-west-2"),
        makerdef("custom-fx", kind="audio", host="elevenlabs", modelId="eleven_text_to_sound_v3"),
        makerdef("custom-tune", kind="audio", host="elevenlabs", modelId="music_v2"),
    ]  # fmt: skip
    bad = [
        makerdef("sdxl", kind="image", host="bedrock", modelId="stability.x"),  # not custom-…
        makerdef("custom-stable-image-core", kind="image", host="bedrock", modelId="x"),  # fine key, odd id
        makerdef("custom-llm-pic", kind="image", host="bedrock", modelId="anthropic.claude-x"),  # cannot draw
        makerdef("custom-vid", kind="video", host="openai_compatible", modelId="sora", baseUrl="https://a.example.com"),
        makerdef("custom-anth", kind="image", host="anthropic", modelId="claude-opus-5-5"),
        makerdef("custom-local", kind="image", host="openai_compatible", modelId="x", baseUrl="https://10.0.0.2/v1"),
        makerdef("custom-voice", kind="audio", host="elevenlabs", modelId="eleven_v3", role="voice"),  # never a voice
        makerdef("custom-what", kind="smell", host="bedrock", modelId="x"),
        makerdef("custom-noid", kind="image", host="bedrock", modelId=""),
    ]  # fmt: skip
    merged = config.merged_makers(good + bad)
    own = {m["key"]: m for kind in config.MAKER_KINDS for m in merged[kind] if m["custom"]}
    assert set(own) == {"custom-sdxl", "custom-oc-pic", "custom-luma9", "custom-fx", "custom-tune"}
    assert {k: m["maker"] for k, m in own.items()} == {"custom-sdxl": "own-images", "custom-oc-pic": "own-images",
                                                         "custom-luma9": "own-video", "custom-fx": "own-sound",
                                                         "custom-tune": "own-sound"}  # fmt: skip
    assert own["custom-oc-pic"]["baseUrl"] == "https://api.openai.com/v1" and own["custom-oc-pic"]["region"] is None
    assert (own["custom-fx"]["role"], own["custom-tune"]["role"]) == ("effects", "music")
    # never shadowing a bundled key, at most 20 per kind
    shadow = {**makerdef("custom-x", kind="image", host="bedrock", modelId="stability.x"), "key": "stable-image-core"}
    assert config.maker_from_def(shadow) is None
    many = [makerdef(f"custom-p{i:02d}", kind="image", host="bedrock", modelId="stability.x") for i in range(25)]
    assert sum(1 for m in config.merged_makers(many)["image"] if m["custom"]) == config.MAX_CUSTOM == 20


# --- the pick, read per job -------------------------------------------------------------------------------------------


def test_the_pick_is_the_makers_model_and_an_ended_or_foreign_pick_stops_with_a_sentence() -> None:
    makers = config.merged_makers([makerdef("custom-luma9", kind="video", host="bedrock", modelId="luma.ray-v2:0",
                                            region="us-west-2")])  # fmt: skip
    pick = lambda kind, name, model=None: maker_model(kind, {"providers": {  # noqa: E731
        {"images": "images", "animation": "video", "audio": "audio"}[kind]: name,
        providers.MODEL_FIELDS[kind]: model}}, makers)  # fmt: skip
    assert pick("images", "builtin-rig") is None and pick("animation", "builtin-2d") is None
    assert pick("images", "stability")["key"] == "stable-image-core"  # type: ignore[index]
    assert pick("images", "stability", "stable-image-ultra")["key"] == "stable-image-ultra"  # type: ignore[index]
    assert pick("animation", "luma-ray")["modelId"] == "luma.ray-v2:0"  # type: ignore[index]
    assert pick("animation", "own-video")["key"] == "custom-luma9"  # type: ignore[index]
    with pytest.raises(ProviderUnavailable) as canvas:
        pick("images", "nova-canvas")
    assert str(canvas.value) == (
        "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › Settings "
        "› Video."
    )
    with pytest.raises(ProviderUnavailable) as reel:
        pick("animation", "nova-reel", "nova-reel")
    assert str(reel.value) == (
        "Amazon Nova Reel 1.1 was ended by Amazon on 30 Sep 2026. Pick another video maker in Lamo Stories › Settings › "
        "Video."
    )
    with pytest.raises(ProviderUnavailable) as foreign:
        pick("images", "stability", "luma-ray2")
    assert str(foreign.value) == (
        "Stability AI pictures can't use the picture model you picked any more. Pick another in Lamo Stories › "
        "Settings › Video."
    )
    with pytest.raises(ProviderUnavailable) as none:
        pick("images", "own-images")
    assert str(none.value) == providers.NO_OWN_MODEL.format(what="picture")


def test_the_sound_parts_of_a_pick() -> None:
    def parts(name: str, model: str | None = None) -> dict[str, str]:
        got = sound_models({"providers": {"audio": name, "audioModel": model}})
        return {role: m["key"] for role, m in got.items()}

    assert parts("builtin-synth") == {}
    assert parts("elevenlabs") == {"effects": "elevenlabs-effects", "music": "elevenlabs-music"}
    assert parts("elevenlabs", "elevenlabs-music") == {"music": "elevenlabs-music", "effects": "elevenlabs-effects"}
    assert parts("polly") == {"voice": "polly-neural"}


def test_each_job_reads_the_workspaces_own_makers_now(tmp_path: Path) -> None:
    svc, _store, table, _ = world(tmp_path)
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    first = asyncio.run(job.makers())
    assert not [m for m in first["image"] if m["custom"]]
    table.seed(makerdef("custom-sdxl", kind="image", host="bedrock", modelId="stability.sd3-5-large-v1:0"))
    table.seed({**makerdef("custom-theirs", kind="image", host="bedrock", modelId="stability.x"), "userId": "user-2"})
    again = StoryJob(svc, JobFence(USER, WS, "J2", "S2"), STORY)
    second = asyncio.run(again.makers())
    assert [m["key"] for m in second["image"] if m["custom"]] == ["custom-sdxl"]  # never another owner's
    again.config = {"providers": {"images": "own-images", "imageModel": "custom-sdxl", "video": "luma-ray"}}
    again.maker_models = second
    ctx = again._ctx()
    assert ctx.image_model["key"] == "custom-sdxl" and ctx.video_model["key"] == "luma-ray2"  # type: ignore[index]
    assert ctx.video_model_id == "luma.ray-v2:0"


# --- the sound makers --------------------------------------------------------------------------------------------------


def wav(seconds: float, freq: float = 440.0) -> bytes:
    n = int(16000 * seconds)
    samples = (0.5 * np.sin(2 * math.pi * freq * np.arange(n) / 16000) * 32767).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(samples.tobytes())
    return out.getvalue()


class FakeEngine:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events

    async def audio(self, path: Path) -> list[dict[str, Any]]:
        return self.events


EVENTS = [
    {"kind": "sfx", "id": "pop", "at": 0.5, "volume": 0.8},
    {"kind": "sfx", "id": "engine", "at": 1.0, "dur": 2.0, "volume": 0.6},
    {"kind": "sfx", "id": "pop", "at": 3.0, "volume": 0.8},
    {"kind": "noise", "id": "gasp", "at": 2.0, "pitch": 1.1, "volume": 0.9},
]
SCRIPT = {"seed": 3, "fps": 30, "durationSec": 4, "scenes": [{"sceneId": "s1", "durationSec": 4, "caption": "Ice!"}],
          "music": {"mood": "calm", "volume": 0.5},
          "captions": [{"id": "c1", "at": 0.2, "dur": 1.5, "text": "Slow down on ice."},
                       {"id": "c2", "at": 1.0, "dur": 1.5, "text": "Brake gently."}]}  # fmt: skip


def sound_ctx(tmp: Path, events: list[dict[str, Any]] = EVENTS, **kw: Any) -> ProviderContext:
    return ProviderContext(engine=FakeEngine(events), workdir=tmp, **kw)  # type: ignore[arg-type]


def test_the_frame_count_of_the_sound_script() -> None:
    from lamostories_agent.engine import frame_count

    assert frame_count(SCRIPT) == 120


@needs_ffmpeg
def test_elevenlabs_makes_each_effect_once_and_an_instrumental_bed_with_the_owners_key(tmp_path: Path) -> None:
    http = FakeHttp(lambda call: Answer(200, wav(0.8 if "sound-generation" in call["url"] else 3.0)))
    keys_ = FakeKeys({(WS, "elevenlabs"): "el-owner"})
    parts = sound_models({"providers": {"audio": "elevenlabs"}})
    ctx = sound_ctx(tmp_path, sound_models=parts, provider_key=lambda host: keys_.key(WS, host), http=http)
    maker = ElevenLabsSound(ctx)
    out = asyncio.run(maker.mix(SCRIPT, tmp_path / "mix.m4a"))
    assert out.is_file() and out.stat().st_size > 0
    urls = [c["url"].split("?")[0] for c in http.calls]
    assert urls.count("https://api.elevenlabs.io/v1/sound-generation") == 2  # pop and engine, each once
    assert urls.count("https://api.elevenlabs.io/v1/music") == 1
    assert not any("text-to-speech" in u or "/speech" in u for u in urls)  # never a voice
    effects = [c["body"] for c in http.calls if "sound-generation" in c["url"]]
    assert {b["model_id"] for b in effects} == {"eleven_text_to_sound_v2"}
    engine = next(b for b in effects if "engine" in b["text"])
    assert engine["loop"] is True and engine["duration_seconds"] == 2.0
    assert all("No voices, no speech, no words" in b["text"] for b in effects)
    (music,) = [c["body"] for c in http.calls if "/v1/music" in c["url"]]
    assert music["force_instrumental"] is True and music["model_id"] == "music_v1" and music["music_length_ms"] == 4000
    assert "no vocals" in music["prompt"].lower()
    assert all(c["headers"]["xi-api-key"] == "el-owner" for c in http.calls) and keys_.reads == [(WS, "elevenlabs")]
    assert maker.made == {"effects": "elevenlabs-effects", "music": "elevenlabs-music"}
    assert maker.made_units is not None and maker.made_units[1] == "second" and maker.made_units[0] > 0


def test_elevenlabs_without_a_key_proves_it_needs_setting_up_and_calls_nothing(tmp_path: Path) -> None:
    http = FakeHttp(Answer(200, b""))
    ctx = sound_ctx(tmp_path, sound_models=sound_models({"providers": {"audio": "elevenlabs"}}),
                    provider_key=lambda host: None, http=http)  # fmt: skip
    with pytest.raises(ProviderFailed) as e:
        asyncio.run(ElevenLabsSound(ctx).mix(SCRIPT, tmp_path / "mix.m4a"))
    assert e.value.state == "needs_setup" and e.value.sentence == providers.SOUND_KEY and http.calls == []
    refused = FakeHttp(Answer(401, b'{"detail": {"message": "invalid api key"}}'))
    ctx = sound_ctx(tmp_path, sound_models=sound_models({"providers": {"audio": "elevenlabs"}}),
                    provider_key=lambda host: "el-x", http=refused)  # fmt: skip
    with pytest.raises(ProviderFailed) as r:
        asyncio.run(ElevenLabsSound(ctx).mix(SCRIPT, tmp_path / "mix.m4a"))
    assert r.value.state == "needs_setup" and r.value.last_error == "ElevenLabs refused the saved key."


def test_an_own_bedrock_sound_model_is_refused_with_a_sentence(tmp_path: Path) -> None:
    makers = config.merged_makers([makerdef("custom-bsound", kind="audio", host="bedrock", modelId="amazon.sound-x")])
    parts = sound_models({"providers": {"audio": "own-sound"}}, makers)
    assert [m["key"] for m in parts.values()] == ["custom-bsound"]
    with pytest.raises(ProviderUnavailable) as e:
        asyncio.run(
            OwnSound(sound_ctx(tmp_path, sound_models=parts, provider_key=lambda h: "k")).mix(
                SCRIPT, tmp_path / "m.m4a"
            )
        )
    assert str(e.value) == providers.SOUND_BEDROCK


class FakePolly:
    def __init__(self) -> None:
        self.spoken: list[dict[str, Any]] = []
        self.regions: list[str] = []

    def __call__(self, region: str) -> FakePolly:
        self.regions.append(region)
        return self

    def synthesize_speech(self, **kw: Any) -> dict[str, Any]:
        self.spoken.append(kw)
        return {"AudioStream": io.BytesIO(wav(1.2, 300.0))}


def test_polly_speaks_the_captions_only_when_picked(tmp_path: Path) -> None:
    assert spoken_lines(SCRIPT) == [(0.2, "Slow down on ice."), (1.0, "Brake gently.")]
    assert spoken_lines({**SCRIPT, "captions": []}) == [(0.0, "Ice!")]
    assert PollyVoice.state == "off" and providers.DEFAULTS["audio"] == "builtin-synth"


@needs_ffmpeg
def test_the_polly_voice_reads_the_captions_in_ireland_one_line_after_another(tmp_path: Path) -> None:
    polly = FakePolly()
    ctx = sound_ctx(tmp_path, sound_models=sound_models({"providers": {"audio": "polly"}}), polly=polly)
    maker = PollyVoice(ctx)
    asyncio.run(maker.mix(SCRIPT, tmp_path / "mix.m4a"))
    assert set(polly.regions) == {"eu-west-1"}
    assert [s["Text"] for s in polly.spoken] == ["Slow down on ice.", "Brake gently."]
    assert all((s["Engine"], s["VoiceId"], s["OutputFormat"]) == ("neural", "Joanna", "mp3") for s in polly.spoken)
    assert maker.made == {"voice": "polly-neural", "lines": 2}
    assert maker.made_units == (float(len("Slow down on ice.") + len("Brake gently.")), "character")


@needs_ffmpeg
def test_the_built_in_sounds_stay_the_default_and_never_call_anyone(tmp_path: Path) -> None:
    from lamostories_agent.providers import BuiltinSynth

    polly, http = FakePolly(), FakeHttp(Answer(200, b""))
    maker = BuiltinSynth(sound_ctx(tmp_path, polly=polly, http=http, provider_key=lambda h: "k"))
    asyncio.run(maker.mix(SCRIPT, tmp_path / "mix.m4a"))
    assert polly.spoken == [] and http.calls == [] and maker.made == {} and maker.made_units is None


def test_the_mix_uses_made_effects_a_made_bed_and_ducks_under_words() -> None:
    made = {"pop": np.sin(np.arange(4800) / 10.0).astype(np.float32)}
    plain = audio.mix(EVENTS[:1], 2.0, mood=None, music_volume=0, seed=1)
    with_made = audio.mix(EVENTS[:1], 2.0, mood=None, music_volume=0, seed=1, effects=made)
    assert plain.shape == with_made.shape and not np.allclose(plain, with_made)
    bed = np.ones(48000, dtype=np.float32) * 0.1
    quiet = audio.mix([], 2.0, mood="calm", music_volume=1.0, seed=1, bed=bed)
    talk = audio.mix([], 2.0, mood="calm", music_volume=1.0, seed=1, bed=bed,
                     voices=[(0.5, np.sin(np.arange(24000) / 5.0).astype(np.float32))])  # fmt: skip
    assert quiet.shape == talk.shape == (2, 96000)
    # the made bed (a steady level here) is the music, not the mood's own loop
    assert abs(float(quiet[:, 40000:50000].std())) < 1e-3 and float(quiet[:, 40000:50000].mean()) > 0.1
    # while the words play the music ducks under them (the bed's level drops), and the words are there
    window = slice(30000, 50000)
    assert float(talk[:, window].mean()) < 0.8 * float(quiet[:, window].mean())
    assert float(talk[:, window].std()) > 10 * float(quiet[:, window].std()) + 0.01


# --- the sound step of a story job ---------------------------------------------------------------------------------


@needs_ffmpeg
def test_the_sound_step_uses_the_picked_maker_records_its_usage_and_proves_it(tmp_path: Path) -> None:
    http = FakeHttp(lambda call: Answer(200, wav(0.8 if "sound-generation" in call["url"] else 3.0)))
    svc, _store, table, _ = world(tmp_path, config={"providers": {"images": "builtin-rig", "video": "builtin-2d",
                                                                 "audio": "elevenlabs"}})  # fmt: skip
    svc.http = http
    svc.provider_keys = FakeKeys({(WS, "elevenlabs"): "el-owner"})
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    job.story = story_item()
    job.config = workspace({"providers": {"audio": "elevenlabs"}})["configuration"]
    job.maker_models = asyncio.run(job.makers())
    job.engine = FakeEngine(EVENTS)  # type: ignore[assignment]
    job.work.mkdir(parents=True, exist_ok=True)
    asyncio.run(job._make_sound(SCRIPT))
    (asset,) = [a for a in table.prefix("ASSET#") if a["kind"] == "audio"]
    assert asset["meta"]["provider"] == "elevenlabs" and asset["meta"]["madeEffects"] == "elevenlabs-effects"
    prov = table.item(keys.provider_sk("audio", "elevenlabs"))
    assert prov is not None and prov["state"] == "on"
    # one USAGE# per model that made a part, each with its own model id and seconds (§45.37 G1: per-model prices)
    rows = {u["modelId"]: u for u in table.prefix("USAGE#")}
    assert set(rows) == {"eleven_text_to_sound_v2", "music_v1"}
    for usage in rows.values():
        assert (usage["provider"], usage["unit"], usage["kind"]) == ("elevenlabs", "second", "provider")
        assert usage["units"] > 0 and usage["cost"] is None and usage["soundSec"] == usage["units"]
    assert rows["music_v1"]["units"] == 4.0  # the whole video's bed
    assert rows["eleven_text_to_sound_v2"]["units"] == pytest.approx(
        2.0 + max(0.5, providers.natural_seconds("pop")), abs=0.01
    )  # engine (2 s) and pop (ElevenLabs makes 0.5 s at least), each made once
    # a refused key is recorded on the maker, and the step fails with the sentence that says what to do
    svc.provider_keys = FakeKeys({})
    job2 = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), STORY)
    job2.story, job2.config, job2.maker_models = job.story, job.config, job.maker_models
    job2.engine = FakeEngine(EVENTS)  # type: ignore[assignment]
    with pytest.raises(ProviderFailed):
        asyncio.run(job2._make_sound(SCRIPT))
    assert table.item(keys.provider_sk("audio", "elevenlabs"))["state"] == "needs_setup"  # type: ignore[index]


def test_the_ai_makers_start_in_the_state_the_apis_mirror_shows() -> None:
    """The API's ``workspaces/providers.py`` reads each agent class's ``state`` (its registry test): an AI maker is
    off until picked, Luma AI Ray2 needs setting up, the ended ones read ended."""
    got = {cls.id: cls.state for kind in providers.KINDS for cls in providers.REGISTRY[kind].values()}
    assert got == {"bedrock-claude": "needs_setup", "builtin-rig": "on", "nova-canvas": "ended", "stability": "off",
                   "own-images": "off", "builtin-2d": "on", "nova-reel": "ended", "luma-ray": "needs_setup",
                   "own-video": "off", "builtin-synth": "on", "polly": "off", "elevenlabs": "off", "own-sound": "off"}  # fmt: skip


def test_the_workspace_table_fake_reads_its_own_partition() -> None:
    table = FakeTable()
    d, _ = data(table)
    table.seed(makerdef("custom-a", kind="image", host="bedrock", modelId="stability.x"))
    got = asyncio.run(d.query_prefix(PK, config.MAKERDEF_PREFIX))
    assert [r["key"] for r in got] == ["custom-a"]
