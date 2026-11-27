"""The voice that reads a clip's take out loud (voice.py): one Polly call, and no failure of it ever raises."""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

from clipfactory_agent import proc, usage, voice
from clipfactory_agent.usage import Meter, Prices
from clipfactory_agent.voice import TakeVoice, VoiceConfig, load_voice_config, voice_config

REPO = Path(__file__).resolve().parents[2]
CFG = VoiceConfig("polly", "neural", "Matthew", "eu-west-1")
TAKE = "Honestly, the lookout had one job here."


class StubPolly:
    def __init__(self, audio: Any = b"ID3" + b"\x00" * 4000, error: Exception | None = None, wait: float = 0.0) -> None:
        self.audio, self.error, self.wait = audio, error, wait
        self.calls: list[dict[str, Any]] = []

    def synthesize_speech(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.wait:
            time.sleep(self.wait)
        if self.error:
            raise self.error
        return {"AudioStream": io.BytesIO(self.audio) if isinstance(self.audio, bytes) else self.audio}


def probe_as(seconds: float, has_audio: bool = True) -> Any:
    async def probe(src: str) -> proc.MediaInfo:
        return proc.MediaInfo(seconds, 0, 0, has_audio, False)

    return probe


def test_the_voice_comes_from_models_json() -> None:
    got = load_voice_config(REPO / "config")
    assert got == CFG and got.language == "en"
    data = json.loads((REPO / "config" / "models.json").read_text("utf-8"))
    assert data["takeVoice"] == {"service": "polly", "engine": "neural", "voice": "Matthew", "region": "eu-west-1"}
    # the price is AWS's own for neural voices in that region ($16 per million characters), with where it was read
    price = data["pricing"]["voice"]
    assert price["confirmed"] is True and price["perCharacter"] == 0.000016 and "eu-west-1" in price["source"]
    # so a job that spoke its takes still has an exact cost (a take is at most 90 characters: about a seventh of a cent)
    m = Meter(Prices(data))
    m.record_voice(90)
    s = m.summary()
    assert s is not None and s["estimated"] is False and s["totalDollars"] == s["voice"]["dollars"] == 0.00144


def test_a_missing_or_odd_voice_entry_means_no_voice(tmp_path: Path) -> None:
    assert load_voice_config(tmp_path) is None
    assert voice_config(None) is None and voice_config({}) is None
    assert voice_config({"takeVoice": {"service": "other", "engine": "x", "voice": "y", "region": "z"}}) is None
    assert (
        voice_config({"takeVoice": {"service": "polly", "engine": "neural", "voice": "", "region": "eu-west-1"}})
        is None
    )
    got = voice_config(
        {
            "takeVoice": {
                "service": "polly",
                "engine": "neural",
                "voice": "Elin",
                "region": "eu-west-1",
                "language": "sv",
            }
        }
    )
    assert got is not None and got.language == "sv"


def test_the_client_is_made_at_the_first_take_in_the_voice_region(monkeypatch: pytest.MonkeyPatch) -> None:
    import boto3

    made: list[tuple[str, str]] = []

    def client(service: str, region_name: str, config: Any) -> object:
        made.append((service, region_name))
        return object()

    monkeypatch.setattr(boto3, "client", client)
    v = TakeVoice(CFG)
    assert made == []  # nothing at start-up
    assert v.client is v.client
    assert made == [("polly", "eu-west-1")]


def test_the_voice_only_reads_its_own_language() -> None:
    v = TakeVoice(CFG, client=StubPolly())
    assert v.speaks("en-US") and v.speaks("en") and v.speaks("EN-gb")
    assert not v.speaks("sv-SE") and not v.speaks("") and not v.speaks(None) and not v.speaks("enx")


async def test_a_take_becomes_an_mp3_with_its_length(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(proc, "probe", probe_as(2.75))
    meter = Meter(Prices({}))
    token = usage.bind(meter)
    try:
        polly = StubPolly()
        got = await TakeVoice(CFG, client=polly).say(f"  {TAKE}\n", tmp_path / "voice" / "a.mp3")
    finally:
        usage._current.reset(token)
    assert got is not None and got.path.read_bytes().startswith(b"ID3")
    assert got.duration == 2.75 and got.characters == len(TAKE)
    assert polly.calls == [
        {
            "Engine": "neural",
            "OutputFormat": "mp3",
            "SampleRate": "24000",
            "Text": TAKE,
            "TextType": "text",
            "VoiceId": "Matthew",
        }
    ]
    # the characters sent are on the job's meter, with no invented price
    s = meter.summary()
    assert s is not None and s["voice"] == {"characters": len(TAKE), "calls": 1, "estimated": True}
    assert s["estimated"] is True and s["totalDollars"] == 0


async def test_access_denied_is_logged_and_answers_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(proc, "probe", probe_as(2.0))
    denied = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "not allowed"}}, "SynthesizeSpeech")
    got = await TakeVoice(CFG, client=StubPolly(error=denied)).say(TAKE, tmp_path / "a.mp3")
    assert got is None and not (tmp_path / "a.mp3").exists()
    assert '"event": "voice.failed"' in capsys.readouterr().out


@pytest.mark.parametrize("audio", [b"", b"tiny", None])
async def test_empty_audio_answers_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, audio: Any) -> None:
    monkeypatch.setattr(proc, "probe", probe_as(2.0))
    assert await TakeVoice(CFG, client=StubPolly(audio=audio)).say(TAKE, tmp_path / "a.mp3") is None


@pytest.mark.parametrize(("seconds", "has_audio"), [(0.0, True), (40.0, True), (2.0, False)])
async def test_audio_that_is_not_a_sentence_answers_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seconds: float, has_audio: bool
) -> None:
    monkeypatch.setattr(proc, "probe", probe_as(seconds, has_audio))
    assert await TakeVoice(CFG, client=StubPolly()).say(TAKE, tmp_path / "a.mp3") is None


async def test_a_slow_answer_and_a_broken_file_answer_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(voice, "CALL_SECONDS", 0.05)
    assert await TakeVoice(CFG, client=StubPolly(wait=0.3)).say(TAKE, tmp_path / "a.mp3") is None

    async def broken(src: str) -> proc.MediaInfo:
        raise proc.CommandError("ffprobe", 1, "Invalid data found")

    monkeypatch.setattr(voice, "CALL_SECONDS", 30.0)
    monkeypatch.setattr(proc, "probe", broken)
    assert await TakeVoice(CFG, client=StubPolly()).say(TAKE, tmp_path / "b.mp3") is None
    assert await TakeVoice(CFG, client=StubPolly()).say("   ", tmp_path / "c.mp3") is None  # nothing to say


def test_voice_characters_add_up_across_runs_and_get_a_price_once_confirmed() -> None:
    priced = {"pricing": {"voice": {"perCharacter": 0.00002, "confirmed": True}}}
    m = Meter(Prices(priced), {"voice": {"characters": 100, "calls": 2}})
    m.record_voice(50)
    m.record_voice(0)
    s = m.summary()
    assert s is not None and s["voice"] == {"characters": 150, "calls": 3, "estimated": False, "dollars": 0.003}
    assert s["totalDollars"] == 0.003 and s["estimated"] is False
    # a job that spoke nothing has no voice key at all
    quiet = Meter(Prices(priced))
    quiet.record_transcribe(60)
    assert "voice" not in (quiet.summary() or {})
