"""The voice that reads a clip's take out loud ("Your take", owner request 2026-11-27).

One Amazon Polly ``SynthesizeSpeech`` call per take, with the service, engine, voice and region from
``config/models.json`` (``takeVoice``). The voice is an extra: whatever goes wrong here (no access, the wrong region,
a slow answer, empty or unreadable audio) is logged and answered with ``None``, and the clip is made with the take as
text only. Nothing in this module can fail a job."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import proc
from . import usage as usage_mod
from .util import JobCanceled, log

CALL_SECONDS = 30.0  # one take is a sentence: an answer that takes longer is not coming
MAX_SECONDS = 12.0  # a 90-character sentence is about 6 s; anything much longer is not the take
MIN_BYTES = 256  # less than this is no speech at all
MAX_CHARS = 200  # never send more than a sentence, whatever the caller passes
SAMPLE_RATE = "24000"


@dataclass(frozen=True)
class VoiceConfig:
    service: str
    engine: str
    voice: str
    region: str
    language: str = "en"  # the language the voice speaks (an optional ``language`` in the config; Matthew is English)


@dataclass(frozen=True)
class Spoken:
    """A take as speech: the mp3 on disk, how long it is and how many characters were sent (what Polly bills)."""

    path: Path
    duration: float
    characters: int


def voice_config(data: Mapping[str, Any] | None) -> VoiceConfig | None:
    """``takeVoice`` of a parsed config/models.json, or None when it is missing, incomplete or names a service this
    module does not speak to."""
    raw = data.get("takeVoice") if isinstance(data, Mapping) else None
    if not isinstance(raw, Mapping) or raw.get("service") != "polly":
        return None
    engine, voice, region = raw.get("engine"), raw.get("voice"), raw.get("region")
    if not all(isinstance(v, str) and v for v in (engine, voice, region)):
        return None
    language = raw.get("language")
    return VoiceConfig(
        "polly", str(engine), str(voice), str(region), language if isinstance(language, str) and language else "en"
    )


def load_voice_config(config_dir: Path) -> VoiceConfig | None:
    try:
        data = json.loads((config_dir / "models.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return voice_config(data if isinstance(data, dict) else None)


class TakeVoice:
    """Reads takes out loud. The Polly client is made at the first take, never at start-up, so a job that speaks
    nothing never touches the service."""

    def __init__(self, cfg: VoiceConfig, client: Any = None) -> None:
        self.cfg = cfg
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "polly",
                region_name=self.cfg.region,
                config=Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 2, "mode": "standard"}),
            )
        return self._client

    def speaks(self, language: str | None) -> bool:
        """Whether this voice can read a clip in ``language`` (a BCP 47 code, as Transcribe names it). An unknown
        language is not read: the wrong accent is worse than no voice."""
        want = self.cfg.language.lower()
        got = (language or "").lower()
        return bool(got) and (got == want or got.startswith(want + "-"))

    def _synthesize(self, text: str) -> bytes:
        r = self.client.synthesize_speech(
            Engine=self.cfg.engine,
            OutputFormat="mp3",
            SampleRate=SAMPLE_RATE,
            Text=text,
            TextType="text",
            VoiceId=self.cfg.voice,
        )
        stream = r.get("AudioStream")
        if stream is None:
            return b""
        data = stream.read() if hasattr(stream, "read") else stream
        return bytes(data or b"")

    async def say(self, text: str, dest: Path) -> Spoken | None:
        """``text`` as an mp3 at ``dest`` with its length, or None when the voice could not be made. Never raises
        (but a cancelled job still stops)."""
        text = " ".join(text.split())[:MAX_CHARS]
        if not text:
            return None
        try:
            audio = await asyncio.wait_for(asyncio.to_thread(self._synthesize, text), CALL_SECONDS)
            if len(audio) < MIN_BYTES:
                log("warn", "voice.empty", bytes=len(audio))
                return None
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(audio)
            usage_mod.record_voice(len(text))  # billed per character sent, whether or not the audio is used
            info = await proc.probe(str(dest))
            if not info.has_audio or not 0.2 <= info.duration <= MAX_SECONDS:
                log("warn", "voice.unusable", seconds=round(info.duration, 2), audio=info.has_audio)
                return None
            return Spoken(dest, round(info.duration, 3), len(text))
        except (JobCanceled, asyncio.CancelledError):
            raise
        except Exception as e:  # access denied, the region, a timeout, a broken file: the clip is made without it
            log("warn", "voice.failed", error=type(e).__name__, detail=str(e)[:200])
            return None
