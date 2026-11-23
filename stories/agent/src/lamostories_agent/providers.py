"""Who makes what: a registry of providers per kind (docs/CONTRACTS.md §45.11.6, §45.31, ADR-75, ADR-80).

The pipeline only ever calls ``REGISTRY[kind][providerId]`` (the workspace's ``configuration.providers``: ``images``,
``video`` for the animation kind, ``audio``; the writer provider is always ``bedrock-claude``, on the model the owner
picked for the task, §45.25), so a new provider is one class and one registry line. A job's ``meta.providers.writer``
names who really wrote: ``bedrock-claude`` only for an Anthropic model, ``bedrock-model:{key}`` for any other
(``writer_id``, §45.36 E7). Each kind has one Protocol:

* ``Writer.write(brief) -> dict``: a raw script (it always goes through normalize, validate and fit);
* ``ImageProvider.image(prompt, width, height, seed, refs) -> bytes``: a PNG;
* ``AnimationProvider.render_scene(script, scene_id, assets, out) -> SceneClip``: one scene's MP4;
* ``AudioProvider.mix(script, out) -> Path``: an m4a at 48 kHz, -14 LUFS;

and every provider has ``check() -> ProviderStatus``, its state before any call (the API's ``workspaces/providers.py``
mirrors these). The built-in animator, sounds and characters are code in this image with nothing to set up: ``on``,
as §45.11.6's and §45.31's tables give them. The writer and the AI providers are shown ``on`` only after a real call
answered: the job writes ``PROVIDER#{kind}#{id}`` after every real call (pipeline.py, portrait.py), which also gives
the built-ins their ``checkedAt`` or a later failure, never because something was configured.

The makers (docs/CONTRACTS.md §45.37 G1-G3, G7; the built-ins stay the default, nothing is ever swapped by itself):

* Pictures: ``builtin-rig`` (the engine's own drawing), ``stability`` (Stability AI's Stable Image Core, Stable Image
  Ultra and Stable Diffusion 3.5 Large on Amazon Bedrock, us-west-2) and ``own-images`` (a picture model the owner
  added: on Bedrock, or an OpenAI-compatible images API with his key). They draw character portraits for the app and
  the Library only, never anything inside a posted video.
* Video: ``builtin-2d`` and ``luma-ray`` (Luma AI Ray2 on Bedrock, us-west-2, ``StartAsyncInvoke``, 5-second shots
  into the us-west-2 bucket ``CF_VIDEO_WEST_BUCKET``; not ready while that switch is off) and ``own-video`` (a video
  model the owner added on Bedrock). Their realistic footage is used for the story's cut-aways only: scenes with no
  character in them. Scenes with characters are always drawn by the built-in animator, so a character looks the same
  in every shot (§45.8). A story that used one records it in ``PJOB#.meta.providers`` and is posted only with the
  platforms' AI labels (§45.14).
* Sound: ``builtin-synth`` (the default: effects, wordless character noises and the music, all made here),
  ``elevenlabs`` (the owner's ElevenLabs key: the effects and an instrumental music bed; never its text-to-speech),
  ``own-sound`` (a sound model the owner added) and ``polly`` (Amazon Polly's neural voices, eu-west-1, this runtime's
  own role, no key): opt-in, never the default, and the only path that speaks words, only when the owner picks it;
  it reads the story's captions aloud. Lamo Stories' videos are made without a voice otherwise (the owner's first
  request: "without traditional voice-over narration"). Character noises are always the built-in, wordless ones.
* ``nova-canvas`` and ``nova-reel``: Amazon ended both models on 30 September 2026 (their Bedrock model cards). They
  read ``ended``, and a pick of either stops with the ended line before any call; nothing switches to another maker.

Which model a maker makes with is the workspace's pick for the job (``configuration.providers.imageModel`` /
``videoModel`` / ``audioModel``; none: the maker's first model that has not ended), read per job, never a
process-wide choice (``maker_model``)."""

from __future__ import annotations

import asyncio
import base64
import functools
import json
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Protocol

from . import audio, config, keys, proc, writer
from . import hosts as keyed
from .engine import Engine, frame_count, write_json
from .models import unavailable
from .retry import retry
from .util import log

KINDS = ("writer", "images", "animation", "audio")
DEFAULTS = {"images": "builtin-rig", "animation": "builtin-2d", "audio": "builtin-synth"}
CONFIG_KEYS = {"images": "images", "animation": "video", "audio": "audio"}  # StoriesConfig.providers' names
WRITER_ID = "bedrock-claude"
OTHER_WRITER = "bedrock-model:"  # + the model's key: a storyboard written by a model that is not Anthropic's (E7)
CANVAS_NOT_ENABLED = "Bedrock says Nova Canvas is not enabled for this account in Europe (Ireland)."
CANVAS_SETUP = (
    "AI pictures are not set up yet. Turn on Amazon Nova Canvas in the Bedrock console, Region Europe (Ireland), "
    "then tap Try again."
)
CANVAS_REFUSED = "Nova Canvas would not draw this character. Change the description a little, then tap Try again."
REEL_NOT_READY = (  # §45.34: the agent's second guard says the API's own line
    "Amazon Nova Reel is not ready yet: {missing}. Pick Built-in animation in Settings › Video, or finish its setup."
)
REEL_NO_BUCKET = REEL_NOT_READY.format(  # word for word the API's NOT_READY["nova-reel"]
    missing="it needs a storage bucket in the United States (N. Virginia), which is switched off, and Amazon Nova "
    "Reel turned on for your account"
)
REEL_NOT_ENABLED = "Bedrock says Nova Reel is not enabled for this account in US East (N. Virginia)."
REEL_SETUP = REEL_NOT_READY.format(missing="it needs Amazon Nova Reel turned on for your account")
REEL_FAILED = "Nova Reel could not make this shot. Tap Try again, or pick the built-in animator in Settings."
SCENE_SECONDS = 30 * 60
REEL_SECONDS = 20 * 60  # Nova Reel takes about 90 s for a 6 s shot; give it room
REEL_SHOT = 6
REEL_POLL = 15.0
REEL_SIZES = ((1280, 720),)  # what Nova Reel 1.1 makes; a shot is scaled and cropped into the story's own frame
# Amazon ended Nova Canvas and Nova Reel on 30 September 2026 (§45.37 G7): never offered, never called.
ENDED_MAKERS = frozenset({"nova-canvas", "nova-reel"})
ENDED_DAY = "2026-09-30"
ENDED_LINE = "{label} was ended by Amazon on {day}. Pick another {what} maker in Clips Funded › Settings › Video."
ENDED_STATE_LINE = "Ended by Amazon on 30 Sep 2026."
WHAT = {"images": "picture", "animation": "video", "audio": "sound"}
MODEL_FIELDS = {"images": "imageModel", "animation": "videoModel", "audio": "audioModel"}
LUMA_SHOT = 5  # Luma AI Ray2 makes 5- or 9-second shots; Lamo Stories asks for 5 (Try it makes one)
WEST = "us-west-2"
LUMA_NOT_READY = (  # word for word the API's line (§45.37 G7)
    "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, "
    "and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup."
)
LUMA_SETUP = (
    "Luma AI Ray2 is not ready yet: it needs Luma AI Ray2 turned on for your account. Pick Built-in animation in "
    "Settings › Video, or finish its setup."
)
LUMA_NOT_ENABLED = "Bedrock says Luma AI Ray2 is not turned on for this account in US West (Oregon)."
SHOT_FAILED = "{label} could not make this shot. Tap Try again, or pick the Built-in animator in Settings › Video."
OWN_VIDEO_NOT_READY = (  # word for word the API's line (providers.NOT_READY["own-video"], §45.37 G2)
    "Your own video model is not ready yet: it needs a storage bucket in the United States (Oregon), which is "
    "switched off, and the model turned on for your account. Pick Built-in animation in Settings › Video, or finish "
    "its setup and tap Try it."
)
NO_OWN_MODEL = (
    "You have not added a {what} model yet. Add one in Clips Funded › Settings › Video, or pick another {what} maker."
)
NOT_ITS_MODEL = (
    "{label} can't use the {what} model you picked any more. Pick another in Clips Funded › Settings › Video."
)
PICTURE_SETUP = (
    "AI pictures are not set up yet: {why}. Pick Built-in characters in Settings › Video, or finish its setup, then "
    "tap Try again."
)
PICTURE_REFUSED = "{label} would not draw this character. Change the description a little, then tap Try again."
PICTURE_FAILED = "{label} did not answer. Tap Try again."
PICTURE_UNKNOWN = "Clips Funded can't ask {label} for a picture. Pick another picture maker in Settings › Video."
VIDEO_UNKNOWN = "Clips Funded can't ask {label} for video. Pick another video maker in Settings › Video."
SOUND_KEY = (
    "Paste your ElevenLabs key in Clips Funded › Settings › AI › Provider keys first, or pick Built-in sounds "
    "in Settings › Video, then tap Try again."
)
KEY_UNREADABLE = (
    "Clips Funded could not read the key you saved for {words}. Tap Try again. If it keeps happening, paste "
    "the key again in Clips Funded › Settings › AI › Provider keys."
)
KEY_ELSEWHERE = "Clips Funded did not make this picture: {why}."
SOUND_FAILED = (
    "{label} could not make the sounds. Tap Try again, or pick Built-in sounds in Clips Funded › Settings › Video."
)
SOUND_BEDROCK = (
    "Amazon Bedrock has no sound model Clips Funded can call yet. Pick another sound maker in "
    "Clips Funded › Settings › Video."
)
VOICE_FAILED = "Amazon Polly could not speak the words. Tap Try again, or pick Built-in sounds in Settings › Video."
VOICE_SETUP = (
    "Amazon Polly is not set up for this account in Europe (Ireland). Pick Built-in sounds in Settings › Video, then "
    "tap Try again."
)
MAX_MADE_EFFECTS = 16  # distinct effects ElevenLabs makes for one video; any more stay built in
POLLY_CHARACTERS = 3000  # Amazon Polly's limit for one SynthesizeSpeech text


@dataclass(frozen=True)
class ProviderStatus:
    kind: str
    id: str
    label: str
    state: str  # on | off | needs_setup | unavailable | ended
    line: str
    checkedAt: str | None = None
    lastError: str | None = None

    def public(self) -> dict[str, Any]:
        out = {"kind": self.kind, "id": self.id, "label": self.label, "state": self.state, "line": self.line}
        if self.checkedAt:
            out["checkedAt"] = self.checkedAt
        if self.lastError:
            out["lastError"] = self.lastError
        return out


@dataclass
class SceneClip:
    path: Path
    still: Path | None
    duration_sec: float


class ProviderUnavailable(Exception):
    """A provider that cannot run here; the owner's sentence is the message."""


class ProviderFailed(Exception):
    """A provider's real call failed. ``state`` is what that call proved (None: nothing, try again); ``detail`` is
    what Bedrock itself said, when it said something (Try it records it, §45.35 D2)."""

    def __init__(
        self, sentence: str, *, state: str | None = None, last_error: str | None = None, detail: str | None = None
    ) -> None:
        super().__init__(sentence)
        self.sentence = sentence
        self.state = state
        self.last_error = last_error
        self.detail = detail


def read_key(ctx: ProviderContext, host: str, url: str | None = None) -> str | None:
    """This workspace's key for a keyed host, read for this call (§45.37 G4); None when none is saved. A key that is
    there but cannot be read (Secrets Manager denied or throttled the read) stops the step with a plain sentence and
    proves nothing about the maker (``state`` None: no ``PROVIDER#`` record is written for a read that never reached
    it). An OpenAI-compatible key is read for the model's ``url``: a key saved for another address is never sent
    (``KEY_ELSEWHERE``, nothing proven either)."""
    if ctx.provider_key is None:
        return None
    try:
        return ctx.provider_key(host) if url is None else ctx.provider_key(host, url)
    except keyed.HostError as e:
        if e.code == "KeyForOtherAddress":
            log("warn", "stories.provider_key_other_address", host=host)
            raise ProviderFailed(KEY_ELSEWHERE.format(why=e.found[1] if e.found else str(e)),
                                 last_error=_said(e.found[1] if e.found else str(e)) or None) from e  # fmt: skip
        words = keyed.host_words(host)
        found = e.found[1] if e.found else ""
        log("warn", "stories.provider_key_failed", host=host, error=type(e).__name__)
        raise ProviderFailed(KEY_UNREADABLE.format(words=words), last_error=_said(found) or None) from e
    except ValueError as e:
        log("warn", "stories.provider_key_failed", host=host, error=type(e).__name__)
        raise ProviderFailed(KEY_UNREADABLE.format(words=keyed.host_words(host))) from e


def _said(text: str) -> str:
    text = " ".join(str(text or "").split())
    return "" if not text else (text[:1].upper() + text[1:]).rstrip(".") + "."


Ask = Callable[..., Awaitable[Any]]  # pipeline.StoryJob.ask(task=..., messages=..., schema=..., max_tokens=...)


@dataclass
class ProviderContext:
    """What a job gives its providers."""

    engine: Engine
    workdir: Path
    ask: Ask | None = None  # the writer's model call (models.complete through the job, §45.25)
    image_model_id: str = ""
    image_client: Callable[[], Any] | None = None
    character: dict[str, Any] | None = None
    on_progress: Callable[[int, int], None] | None = None
    seed: int = 0
    crf: int = 20
    video_bucket: str = ""
    video_model_id: str = ""
    reel_client: Callable[[], Any] | None = None  # bedrock-runtime in us-east-1
    us_s3: Callable[[], Any] | None = None  # S3 in us-east-1 (the US bucket)
    reel_prefix: Callable[[str], str] | None = None  # scene id -> the shot's prefix in the shots' bucket
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    extra: dict[str, Any] = field(default_factory=dict)
    # The workspace's picks for this job (§45.37 G1): the model each maker makes with (``maker_model``), and for sound
    # the model of each part (``sound_models``: effects, music, voice).
    image_model: dict[str, Any] | None = None
    video_model: dict[str, Any] | None = None
    sound_models: dict[str, dict[str, Any]] = field(default_factory=dict)
    bedrock: Callable[[str], Any] | None = None  # bedrock-runtime in a Region
    s3_in: Callable[[str], Any] | None = None  # S3 in a Region (the shots' buckets)
    video_west_bucket: str = ""  # Luma AI Ray2's bucket in us-west-2 (empty while the switch is off)
    provider_key: Callable[..., str | None] | None = None  # this workspace's key for a keyed host (and url), per call
    http: Any = None  # hosts.Http (tests give a fake)
    polly: Callable[[str], Any] | None = None  # Amazon Polly in a Region


class Writer(Protocol):
    def __init__(self, ctx: ProviderContext) -> None: ...

    async def write(self, brief: dict[str, Any]) -> dict[str, Any]: ...

    def check(self) -> ProviderStatus: ...


class ImageProvider(Protocol):
    def __init__(self, ctx: ProviderContext) -> None: ...

    async def image(self, prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes: ...

    def check(self) -> ProviderStatus: ...


class AnimationProvider(Protocol):
    def __init__(self, ctx: ProviderContext) -> None: ...

    async def render_scene(
        self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path
    ) -> SceneClip: ...

    def check(self) -> ProviderStatus: ...


class AudioProvider(Protocol):
    def __init__(self, ctx: ProviderContext) -> None: ...

    async def mix(self, script: dict[str, Any], out: Path) -> Path: ...

    def check(self) -> ProviderStatus: ...


class _Base:
    kind: ClassVar[str] = ""
    id: ClassVar[str] = ""
    label: ClassVar[str] = ""
    state: ClassVar[str] = "on"
    line: ClassVar[str] = ""

    def __init__(self, ctx: ProviderContext) -> None:
        self.ctx = ctx

    def check(self) -> ProviderStatus:
        return ProviderStatus(self.kind, self.id, self.label, self.state, self.line)


def _refused_model(e: BaseException) -> bool:
    """Bedrock refused the model itself (access, Region or model id): what proves a provider needs setting up. A
    throttle proves nothing about it."""
    found = unavailable(e)
    return found is not None and found[0] in ("denied", "not_found")


# --- writer -------------------------------------------------------------------------------------------------------


class BedrockWriter(_Base):
    """The storyboard agent's script, on the owner's model and effort for the task (``storyboard`` for a whole
    story or a rewrite, ``scene_rewrite`` for named scenes, §45.25; ``animation_plan`` for the re-staging pass after
    the engine refused the first staging, §45.37 G5: the same agent, the same schema, its own model and effort)."""

    kind, id, label = "writer", WRITER_ID, "Claude on Amazon Bedrock"
    state = "needs_setup"
    line = "Writes every story on the model you pick in Settings › AI. Shown as on after its first answer."

    async def write(self, brief: dict[str, Any]) -> dict[str, Any]:
        if self.ctx.ask is None:
            raise RuntimeError("the writer needs the job's model call")
        mode = str(brief.get("mode") or "full")
        schema = writer.storyboard_schema(
            brief.get("catalog") or {},
            brief.get("castIds") or [],
            brief.get("topicIds") or [],
            mode=mode,
            scene_ids=brief.get("sceneIds") or None,
        )
        task = "scene_rewrite" if mode == "scenes" else "storyboard"
        if brief.get("restage"):
            task = "animation_plan"
        prompt = (
            writer.SYSTEM + "\n\n" + writer.instructions(mode, note=brief.get("note"), scene_ids=brief.get("sceneIds"))
        )
        reply = await self.ctx.ask(
            task=task,
            messages=[{"role": "user", "content": [{"text": prompt}, *writer.content(brief.get("request") or {})]}],
            schema=schema,
            max_tokens=32000,
        )
        data: dict[str, Any] = reply.data or {}
        return data


# --- images -------------------------------------------------------------------------------------------------------


def portrait_script(ch: dict[str, Any], seed: int, engine_version: int) -> dict[str, Any]:
    """A 2-second studio scene of the character alone (the built-in picture of it)."""
    return {
        "engine": engine_version,
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "durationSec": 2,
        "title": str(ch.get("name") or "Portrait")[:80],
        "seed": seed,
        "cast": {
            "c1": {
                "characterId": str(ch.get("characterId") or "c1"),
                "name": str(ch.get("name") or ""),
                "look": ch.get("look") or {},
                "movementStyle": ch.get("movementStyle") or "calm",
                "voice": ch.get("voice") or {"style": "none", "pitch": 1, "noises": [], "sfx": []},
            }
        },
        "scenes": [
            {
                "sceneId": "s1",
                "title": "Portrait",
                "durationSec": 2,
                "seed": seed,
                "set": "studio",
                "view": "side",
                "camera": "close",
                "actors": [{"castId": "c1", "x": 0.5, "y": 0.7, "facing": "right"}],
                "props": [],
                "beats": [{"at": 0, "dur": 2, "who": "c1", "do": "idle", "face": "happy"}],
                "sfx": [],
                "caption": None,
                "note": None,
            }
        ],
        "music": None,
        "captionsOn": False,
        "captions": [],
        "safety": None,
    }


class RigImages(_Base):
    """The character drawn by the engine itself: a still of it standing in the studio set."""

    kind, id, label = "images", "builtin-rig", "Built-in characters"
    state = "on"
    line = "Built in: draws your characters the same way in every video. Nothing to set up."

    async def image(self, prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes:
        script = portrait_script(self.ctx.character or {}, seed, await self.ctx.engine.version())
        work = self.ctx.workdir / "portrait"
        path = write_json(work / "script.json", script)
        jpg = work / "still.jpg"
        await render_still(self.ctx.engine, path, 30, jpg, work)
        png = work / "portrait.png"
        await proc.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(jpg), "-vf", f"crop=1080:1080:0:420,scale={width}:{height}",
             "-frames:v", "1", str(png)],
            time_limit=120,
        )  # fmt: skip
        return png.read_bytes()


def _canvas_body(prompt: str, width: int, height: int, seed: int) -> str:
    return json.dumps(
        {
            "taskType": "TEXT_IMAGE",
            "textToImageParams": {
                "text": prompt[:1000],
                "negativeText": "photo, realistic, text, letters, watermark, scary, blood",
            },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "width": width,
                "height": height,
                "cfgScale": 7.0,
                "seed": seed % 2147483646,
                "quality": "standard",
            },
        }
    )


class NovaCanvas(_Base):
    """Amazon Nova Canvas: ended by Amazon on 30 September 2026 (§45.37 G7). It reads ``ended`` and is never called:
    a portrait that still picks it stops with the ended line. ``bedrock_canvas`` keeps how it was called, for an
    Amazon picture model the owner adds himself."""

    kind, id, label = "images", "nova-canvas", "Amazon Nova Canvas"
    state = "ended"
    line = ENDED_STATE_LINE

    async def image(self, prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes:
        raise ProviderUnavailable(ended_line("images", None, bundled_label(self.id, self.kind, self.label)))

    async def bedrock_canvas(self, prompt: str, width: int, height: int, seed: int) -> bytes:
        """One TEXT_IMAGE call of the Nova Canvas request shape (``ctx.image_model_id`` on ``ctx.image_client``).
        Raises ProviderFailed with what the call proved about the provider."""
        if not self.ctx.image_model_id or self.ctx.image_client is None:
            raise ProviderFailed(CANVAS_SETUP, state=None, last_error="No image model is configured.")
        from botocore.exceptions import ClientError

        client = self.ctx.image_client()
        body = _canvas_body(prompt, width, height, seed)
        try:
            r = await retry(
                lambda: asyncio.to_thread(
                    client.invoke_model,
                    modelId=self.ctx.image_model_id,
                    body=body,
                    contentType="application/json",
                    accept="application/json",
                ),
                what="bedrock.nova_canvas",
                attempts=3,
            )
        except ClientError as e:
            msg = str((e.response.get("Error") or {}).get("Message") or "")
            log("warn", "stories.canvas_refused", code=(e.response.get("Error") or {}).get("Code"), detail=msg[:300])
            if _refused_model(e):
                raise ProviderFailed(CANVAS_SETUP, state="needs_setup", last_error=CANVAS_NOT_ENABLED) from e
            if any(w in msg.lower() for w in ("blocked", "content", "filter")):
                raise ProviderFailed(CANVAS_REFUSED, state="on") from e
            raise ProviderFailed("Nova Canvas did not answer. Tap Try again.") from e
        raw = r["body"].read() if hasattr(r.get("body"), "read") else r.get("body")
        try:
            data = json.loads(raw)
            images = data.get("images") or []
            if data.get("error") or not images:
                raise ValueError(str(data.get("error") or "no image"))
            png = base64.b64decode(images[0])
        except (ValueError, TypeError) as e:
            log("warn", "stories.canvas_no_image", detail=str(e)[:300])
            raise ProviderFailed(CANVAS_REFUSED, state="on") from e
        if not png.startswith(b"\x89PNG"):
            raise ProviderFailed("Nova Canvas sent something that is not a picture. Tap Try again.", state="on")
        return png


# --- AI picture makers (§45.37 G1, G7): Stability AI on Bedrock, or a picture model the owner added ---------------


def stability_body(prompt: str, width: int, height: int, seed: int) -> str:
    """A Stability AI text-to-image request on Bedrock (Stable Image Core, Stable Image Ultra and Stable Diffusion 3.5
    Large take the same fields, AWS's model-parameters pages): the prompt, what to leave out, a fixed seed, the
    nearest aspect ratio and a PNG."""
    ratio = width / max(1, height)
    choices = {"1:1": 1.0, "16:9": 16 / 9, "9:16": 9 / 16, "2:3": 2 / 3, "3:2": 3 / 2, "4:5": 4 / 5, "5:4": 5 / 4}
    aspect = min(choices, key=lambda k: abs(choices[k] - ratio))
    return json.dumps(
        {
            "prompt": prompt[:10000],
            "negative_prompt": "photo, realistic, text, letters, watermark, scary, blood",
            "seed": int(seed) % 4294967294,
            "aspect_ratio": aspect,
            "output_format": "png",
        }
    )


def picture_from(data: Any, label: str) -> bytes:
    """The PNG of a Stability AI or Amazon picture answer; a filtered answer (``finish_reasons``) is a refusal that
    proves the maker works."""
    body = data if isinstance(data, dict) else {}
    images = body.get("images") or []
    reasons = [r for r in body.get("finish_reasons") or [] if r]
    if body.get("error") or not images or reasons:
        raise ProviderFailed(PICTURE_REFUSED.format(label=label), state="on",
                             detail=str(body.get("error") or (reasons[0] if reasons else ""))[:300] or None)  # fmt: skip
    try:
        png = base64.b64decode(images[0])
    except (ValueError, TypeError) as e:
        raise ProviderFailed(PICTURE_REFUSED.format(label=label), state="on") from e
    if not png.startswith(b"\x89PNG"):
        raise ProviderFailed(f"{label} sent something that is not a picture. Tap Try again.", state="on")
    return png


class AiPictures(_Base):
    """A picture maker that draws with the job's picked model (``ctx.image_model``): a Stability AI or Amazon picture
    model on Bedrock in its own Region, or a model on an OpenAI-compatible images API (``POST
    {baseUrl}/images/generations``) with the owner's key. Portraits for the app only. Shown ``on`` only after a real
    picture came back (the job writes ``PROVIDER#``)."""

    kind = "images"
    state = "off"

    def _entry(self) -> dict[str, Any]:
        entry = self.ctx.image_model
        if not entry or not entry.get("modelId"):
            raise ProviderUnavailable(NO_OWN_MODEL.format(what="picture") if self.id == "own-images"
                                      else PICTURE_SETUP.format(why="no picture model is picked"))  # fmt: skip
        if config.ended(entry):
            raise ProviderUnavailable(ended_line("images", entry, str(entry.get("label") or self.label)))
        return entry

    async def image(self, prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes:
        entry = self._entry()
        label = str(entry.get("label") or self.label)
        if config.host_of(entry) == "openai_compatible":
            return await self._openai(entry, label, prompt, width, height)
        model_id = str(entry["modelId"])  # called as saved; its shape is the foundation model's (profile id, ARN)
        bare = config.bare_model_id(model_id)
        if bare.startswith("stability."):
            body = stability_body(prompt, width, height, seed)
        elif bare.startswith(("amazon.titan-image", "amazon.nova-canvas")):
            body = _canvas_body(prompt, width, height, seed)
        else:
            raise ProviderUnavailable(PICTURE_UNKNOWN.format(label=label))
        if self.ctx.bedrock is None:
            raise ProviderUnavailable(PICTURE_SETUP.format(why="Clips Funded cannot reach Amazon Bedrock"))
        from botocore.exceptions import ClientError

        client = self.ctx.bedrock(str(entry.get("region") or WEST))
        try:
            r = await retry(
                lambda: asyncio.to_thread(client.invoke_model, modelId=model_id, body=body,
                                          contentType="application/json", accept="application/json"),
                what="bedrock.picture",
                attempts=3,
            )  # fmt: skip
        except ClientError as e:
            error = e.response.get("Error") or {}
            said = str(error.get("Message") or "")[:300]
            log("warn", "stories.picture_refused", model=model_id, code=error.get("Code"), detail=said)
            if "end of its life" in said.lower():
                raise ProviderUnavailable(ended_line("images", entry, label)) from e
            if _refused_model(e):
                why = f"Amazon Bedrock has not turned on {label} for this account in US West (Oregon)"
                if entry.get("region") and entry.get("region") != WEST:
                    why = f"Amazon Bedrock has not turned on {label} for this account in {entry['region']}"
                raise ProviderFailed(PICTURE_SETUP.format(why=why), state="needs_setup",
                                     last_error=f"Bedrock says {label} is not turned on for this account.",
                                     detail=said or None) from e  # fmt: skip
            if any(w in said.lower() for w in ("blocked", "content", "filter", "moderat")):
                raise ProviderFailed(PICTURE_REFUSED.format(label=label), state="on", detail=said or None) from e
            raise ProviderFailed(PICTURE_FAILED.format(label=label), detail=said or None) from e
        raw = r["body"].read() if hasattr(r.get("body"), "read") else r.get("body")
        try:
            data = json.loads(raw)
        except (ValueError, TypeError) as e:
            raise ProviderFailed(PICTURE_REFUSED.format(label=label), state="on") from e
        return picture_from(data, label)

    async def _openai(self, entry: dict[str, Any], label: str, prompt: str, width: int, height: int) -> bytes:
        key = read_key(self.ctx, "openai_compatible", str(entry.get("baseUrl") or ""))
        if not key:
            raise ProviderFailed(PICTURE_SETUP.format(why="there is no OpenAI-compatible key saved in Settings › AI › "
                                 "Provider keys"), state="needs_setup", last_error="No key is saved.")  # fmt: skip
        http = self.ctx.http or keyed.https
        try:
            data = await asyncio.to_thread(keyed.openai_picture, http, str(entry.get("baseUrl") or ""), key,
                                           str(entry["modelId"]), prompt, width, height)  # fmt: skip
        except keyed.HostError as e:
            said = keyed.redact(str(e), key)[:300]
            log("warn", "stories.picture_refused", model=entry.get("modelId"), code=keyed.HostError.__name__,
                kind=e.kind, detail=said)  # fmt: skip
            if e.kind in ("key", "model") and e.found:
                raise ProviderFailed(PICTURE_SETUP.format(why=e.found[1]), state="needs_setup",
                                     last_error=e.found[1][:1].upper() + e.found[1][1:] + ".", detail=said) from e  # fmt: skip
            if e.kind == "content":
                raise ProviderFailed(PICTURE_REFUSED.format(label=label), state="on", detail=said) from e
            raise ProviderFailed(PICTURE_FAILED.format(label=label), detail=said) from e
        if not data.startswith(b"\x89PNG") and not data[:3] == b"\xff\xd8\xff" and not data[:4] == b"RIFF":
            raise ProviderFailed(f"{label} sent something that is not a picture. Tap Try again.", state="on")
        return data if data.startswith(b"\x89PNG") else await to_png(data, self.ctx.workdir)


async def to_png(data: bytes, work: Path) -> bytes:
    """A JPEG or WebP picture as a PNG (portraits are kept as PNG), through ffmpeg."""
    work.mkdir(parents=True, exist_ok=True)
    src, out = work / "picture.in", work / "picture.png"
    src.write_bytes(data)
    await proc.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-frames:v", "1", str(out)], time_limit=120)
    return out.read_bytes()


class StabilityImages(AiPictures):
    """Stability AI's pictures on Amazon Bedrock in us-west-2 (Stable Image Core, Ultra, SD 3.5 Large)."""

    id, label = "stability", "Stability AI pictures"
    line = (
        "Makes AI pictures of your characters for the app with Stability AI on Amazon Bedrock. Runs in the US "
        "(Oregon). Off until you pick it."
    )


class OwnImages(AiPictures):
    """A picture model the owner added in Settings › Video (``MAKERDEF#``)."""

    id, label = "own-images", "Your picture models"
    line = "Makes pictures with a picture model you added in Settings › Video. Off until you pick it."


# --- animation ----------------------------------------------------------------------------------------------------


def script_size(script_path: Path) -> tuple[int, int]:
    """The script's own width and height (one of the engine's six sizes, §45.34)."""
    try:
        got = json.loads(script_path.read_text("utf-8"))
        return int(got.get("width") or 1080), int(got.get("height") or 1920)
    except (OSError, ValueError, TypeError, AttributeError):
        return 1080, 1920


async def render_still(engine: Engine, script_path: Path, frame: int, out: Path, work: Path) -> None:
    width, height = script_size(script_path)
    spec = {"deno": engine.argv(), "script": str(script_path), "from": frame, "to": frame + 1, "out": str(out),
            "width": width, "height": height}  # fmt: skip
    spec_path = write_json(work / f"still-{out.stem}.json", spec)
    engine.deno_dir.mkdir(parents=True, exist_ok=True)
    await proc.run(
        [sys.executable, "-m", "lamostories_agent.scene_render", "still", "--spec", str(spec_path)],
        time_limit=600,
        cwd=engine.deno_dir,
    )


class Builtin2D(_Base):
    """The engine's draw lists rasterized with numpy and encoded with libx264, in a process of its own per scene."""

    kind, id, label = "animation", "builtin-2d", "Built-in animator"
    state = "on"
    line = "Built in: animates every scene at the video's size, 30 frames a second. Nothing to set up."
    preset: ClassVar[str] = "fast"

    async def render_scene(
        self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path
    ) -> SceneClip:
        work = self.ctx.workdir / "render"
        script_path = write_json(work / f"script-{scene_id}.json", script)
        ranges = {str(s.get("sceneId")): s for s in await self.ctx.engine.scenes(script_path)}
        if scene_id not in ranges:
            raise ValueError(f"scene {scene_id} is not in the script")
        first, end = int(ranges[scene_id]["from"]), int(ranges[scene_id]["to"])
        spec = {
            "deno": self.ctx.engine.argv(),
            "script": str(script_path),
            "from": first,
            "to": end,
            "out": str(out),
            "assets": {k: str(v) for k, v in assets.items()},
            "preset": self.preset,
            "crf": self.ctx.crf,
            "width": int(script.get("width") or 1080),
            "height": int(script.get("height") or 1920),
        }
        spec_path = write_json(work / f"spec-{scene_id}.json", spec)
        total = end - first
        report = self.ctx.on_progress

        def progress(line: str) -> None:
            parts = line.split()
            if report and len(parts) == 3 and parts[0] == "progress":
                report(int(parts[1]), int(parts[2]))

        out.parent.mkdir(parents=True, exist_ok=True)
        await proc.run(
            [sys.executable, "-m", "lamostories_agent.scene_render", "clip", "--spec", str(spec_path)],
            time_limit=SCENE_SECONDS,
            stall_limit=10 * 60,
            on_out_line=progress,
            cwd=self.ctx.engine.deno_dir,
        )
        if report:
            report(total, total)
        return SceneClip(out, None, total / 30.0)


def reel_prompt(script: dict[str, Any], scene: dict[str, Any]) -> str:
    """A text-to-video prompt for a cut-away scene: the place, the weather and the props, never a character."""
    labels = {"icy_road": "an icy road", "snowy_road": "a snowy road", "rainy_road": "a rainy road",
              "foggy_road": "a foggy road", "road_night": "a road at night", "road_day": "a road on a sunny day",
              "highway": "a motorway", "country_road": "a country road", "city_street": "a city street",
              "parking_lot": "a parking lot", "kitchen": "a kitchen", "living_room": "a living room",
              "office": "an office", "park": "a park", "studio": "a plain bright studio"}  # fmt: skip
    place = labels.get(str(scene.get("set")), str(scene.get("set") or "a road").replace("_", " "))
    things = ", ".join(dict.fromkeys(str(p.get("kind")).replace("_", " ") for p in scene.get("props") or []))
    view = "seen from above" if scene.get("view") == "top" else "at eye level"
    parts = [f"Slow cinematic shot of {place}, {view}"]
    if things:
        parts.append(f"with {things}")
    parts.append("no people, no text, no logos, calm camera, natural light")
    return ", ".join(parts)[:500]


class NovaReel(_Base):
    """Amazon Nova Reel 1.1: ended by Amazon on 30 September 2026 (§45.37 G7). It reads ``ended`` and is never called:
    a story that still picks it stops with the ended line before any call. ``reel_scene`` and ``reel_shot`` keep how
    it was called (``StartAsyncInvoke`` into the US bucket), for an Amazon video model the owner adds himself."""

    kind, id, label = "animation", "nova-reel", "Amazon Nova Reel"
    state = "ended"
    line = ENDED_STATE_LINE

    def check(self) -> ProviderStatus:
        return ProviderStatus(self.kind, self.id, self.label, "ended", self.line)

    async def render_scene(
        self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path
    ) -> SceneClip:
        raise ProviderUnavailable(ended_line("animation", None, bundled_label(self.id, self.kind, self.label)))

    async def shot(self, prompt: str, seed: int, dimension: str, prefix: str) -> str:
        raise ProviderUnavailable(ended_line("animation", None, bundled_label(self.id, self.kind, self.label)))

    async def reel_scene(self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path) -> SceneClip:
        """One cut-away with the Nova Reel request shape (``ctx.video_model_id`` into ``ctx.video_bucket``)."""
        if not self.ctx.video_bucket:
            raise ProviderUnavailable(REEL_NO_BUCKET)
        if self.ctx.reel_client is None or self.ctx.us_s3 is None or self.ctx.reel_prefix is None:
            raise ProviderUnavailable(REEL_SETUP)
        scene = next((s for s in script.get("scenes") or [] if s.get("sceneId") == scene_id), None)
        if scene is None:
            raise ValueError(f"scene {scene_id} is not in the script")
        prefix = self.ctx.reel_prefix(scene_id)
        dimension = reel_dimension(int(script.get("width") or 1080), int(script.get("height") or 1920))
        seed = int(scene.get("seed") or self.ctx.seed or 0)
        key = await self.reel_shot(reel_prompt(script, scene), seed, dimension, prefix)
        local = self.ctx.workdir / "reel" / f"{scene_id}-shot.mp4"
        local.parent.mkdir(parents=True, exist_ok=True)
        bucket = self.ctx.video_bucket
        s3 = self.ctx.us_s3()
        await asyncio.to_thread(s3.download_file, bucket, f"{key.rstrip('/')}/output.mp4", str(local))
        seconds = float(scene.get("durationSec") or REEL_SHOT)
        size = (int(script.get("width") or 1080), int(script.get("height") or 1920))
        await fit_shot(local, out, seconds, self.ctx.crf, size)
        if self.ctx.on_progress:
            self.ctx.on_progress(1, 1)
        return SceneClip(out, None, seconds)

    async def reel_shot(self, prompt: str, seed: int, dimension: str, prefix: str) -> str:
        """One 6-second shot (``StartAsyncInvoke``, then ``GetAsyncInvoke`` until it is ready) written under
        ``prefix`` in the US bucket; returns the shot's folder key there. Raises ProviderFailed with what the call
        proved (and Bedrock's own words in ``detail``)."""
        if self.ctx.reel_client is None:
            raise ProviderUnavailable(REEL_SETUP)
        from botocore.exceptions import ClientError

        client = self.ctx.reel_client()
        model_input = {
            "taskType": "TEXT_VIDEO",
            "textToVideoParams": {"text": prompt[:500]},
            "videoGenerationConfig": {
                "durationSeconds": REEL_SHOT,
                "fps": 24,
                "dimension": dimension,
                "seed": int(seed) % 2147483646,
            },
        }
        try:
            started = await asyncio.to_thread(
                client.start_async_invoke,
                modelId=self.ctx.video_model_id,
                modelInput=model_input,
                outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{self.ctx.video_bucket}/{prefix}"}},
            )
        except ClientError as e:
            error = e.response.get("Error") or {}
            said = str(error.get("Message") or "")[:300] or None
            log("warn", "stories.reel_refused", code=error.get("Code"))
            if _refused_model(e):
                raise ProviderFailed(REEL_SETUP, state="needs_setup", last_error=REEL_NOT_ENABLED, detail=said) from e
            raise ProviderFailed(REEL_FAILED, detail=said) from e
        arn = str(started.get("invocationArn") or "")
        uri = await self._wait(client, arn)
        bucket, _, key = uri.removeprefix("s3://").partition("/")
        if bucket != self.ctx.video_bucket or not key.startswith(prefix):
            raise ProviderFailed(REEL_FAILED, state="on", last_error="The shot was not where it was asked to be.")
        return key

    async def _wait(self, client: Any, arn: str) -> str:
        """Polls ``GetAsyncInvoke`` until the shot is ready; returns its S3 folder."""
        waited = 0.0
        while waited < REEL_SECONDS:
            got = await asyncio.to_thread(client.get_async_invoke, invocationArn=arn)
            status = str(got.get("status") or "")
            if status == "Completed":
                return str(((got.get("outputDataConfig") or {}).get("s3OutputDataConfig") or {}).get("s3Uri") or "")
            if status == "Failed":
                said = str(got.get("failureMessage") or "")[:300] or None
                log("warn", "stories.reel_failed", detail=said)
                raise ProviderFailed(
                    REEL_FAILED, state="on", last_error="Nova Reel could not make the shot.", detail=said
                )
            await self.ctx.sleep(REEL_POLL)
            waited += REEL_POLL
        raise ProviderFailed(REEL_FAILED)


# --- AI video makers (§45.37 G7): Luma AI Ray2 on Bedrock, or a video model the owner added ----------------------


def luma_aspect(width: int, height: int) -> str:
    """The Luma AI Ray2 aspect ratio nearest the story's frame (its documented ratios)."""
    want = width / max(1, height)
    ratios = {"1:1": 1.0, "16:9": 16 / 9, "9:16": 9 / 16, "4:3": 4 / 3, "3:4": 3 / 4, "21:9": 21 / 9, "9:21": 9 / 21}
    return min(ratios, key=lambda k: abs(ratios[k] - want))


def luma_input(prompt: str, width: int, height: int) -> dict[str, Any]:
    """A Luma AI Ray2 text-to-video request (AWS's Luma AI model-parameters page): the prompt (≤ 5000 characters and
    300 tokens), the nearest aspect ratio, one 5-second 720p shot that does not loop."""
    return {"prompt": prompt[:1500], "aspect_ratio": luma_aspect(width, height), "loop": False,
            "duration": f"{LUMA_SHOT}s", "resolution": "720p"}  # fmt: skip


class AiVideo(_Base):
    """A video maker that makes a cut-away (a scene with no character) with the job's picked model
    (``ctx.video_model``) through ``StartAsyncInvoke`` into the shots' bucket of the model's Region: us-west-2's
    (``CF_VIDEO_WEST_BUCKET``), or for an Amazon Nova Reel model the owner added, us-east-1's (``CF_VIDEO_BUCKET``)."""

    kind = "animation"
    state = "off"
    not_ready: ClassVar[str] = LUMA_NOT_READY

    def _entry(self) -> dict[str, Any]:
        entry = self.ctx.video_model or (config.pick_model("video", self.id, None) or {})
        if not entry.get("modelId"):
            raise ProviderUnavailable(NO_OWN_MODEL.format(what="video"))
        if config.ended(entry):
            raise ProviderUnavailable(ended_line("animation", entry, str(entry.get("label") or self.label)))
        if not config.bare_model_id(entry.get("modelId")).startswith(config.BEDROCK_VIDEO):  # before any call
            raise ProviderUnavailable(VIDEO_UNKNOWN.format(label=str(entry.get("label") or self.label)))
        return entry

    def _region(self, entry: dict[str, Any]) -> str:
        return str(entry.get("region") or WEST)

    def bucket(self, entry: dict[str, Any] | None = None) -> str:
        region = self._region(entry or self.ctx.video_model or {"region": WEST})
        if region == WEST:
            return self.ctx.video_west_bucket
        return self.ctx.video_bucket if region == "us-east-1" else ""

    def shot_seconds(self, entry: dict[str, Any] | None = None) -> int:
        model_id = config.bare_model_id((entry or self.ctx.video_model or {}).get("modelId"))
        return REEL_SHOT if model_id.startswith("amazon.nova-reel") else LUMA_SHOT

    def model_input(self, entry: dict[str, Any], prompt: str, seed: int, width: int, height: int) -> dict[str, Any]:
        model_id = config.bare_model_id(entry.get("modelId"))  # the request's shape; the call keeps the saved id
        label = str(entry.get("label") or self.label)
        if model_id.startswith("luma."):
            return luma_input(prompt, width, height)
        if model_id.startswith("amazon.nova-reel"):
            return {"taskType": "TEXT_VIDEO", "textToVideoParams": {"text": prompt[:500]},
                    "videoGenerationConfig": {"durationSeconds": REEL_SHOT, "fps": 24,
                                              "dimension": reel_dimension(width, height),
                                              "seed": int(seed) % 2147483646}}  # fmt: skip
        raise ProviderUnavailable(VIDEO_UNKNOWN.format(label=label))

    async def render_scene(
        self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path
    ) -> SceneClip:
        entry = self._entry()
        if not self.bucket(entry):
            raise ProviderUnavailable(self.not_ready)
        if self.ctx.bedrock is None or self.ctx.s3_in is None or self.ctx.reel_prefix is None:
            raise ProviderUnavailable(self.setup_line())
        scene = next((s for s in script.get("scenes") or [] if s.get("sceneId") == scene_id), None)
        if scene is None:
            raise ValueError(f"scene {scene_id} is not in the script")
        width, height = int(script.get("width") or 1080), int(script.get("height") or 1920)
        seed = int(scene.get("seed") or self.ctx.seed or 0)
        key = await self.shot(reel_prompt(script, scene), seed, width, height, self.ctx.reel_prefix(scene_id))
        local = self.ctx.workdir / "shots" / f"{scene_id}-shot.mp4"
        local.parent.mkdir(parents=True, exist_ok=True)
        s3 = self.ctx.s3_in(self._region(entry))
        await asyncio.to_thread(s3.download_file, self.bucket(entry), key, str(local))
        seconds = float(scene.get("durationSec") or self.shot_seconds(entry))
        await fit_shot(local, out, seconds, self.ctx.crf, (width, height))
        if self.ctx.on_progress:
            self.ctx.on_progress(1, 1)
        return SceneClip(out, None, seconds)

    def setup_line(self) -> str:
        return LUMA_SETUP

    async def shot(self, prompt: str, seed: int, width: int, height: int, prefix: str) -> str:
        """One shot (``StartAsyncInvoke``, then ``GetAsyncInvoke`` until it is ready) under ``prefix`` in the shots'
        bucket of the model's Region; returns the MP4's key there. Raises ProviderFailed with what the call proved
        (and Bedrock's own words in ``detail``)."""
        entry = self._entry()
        label = str(entry.get("label") or self.label)
        bucket = self.bucket(entry)
        if not bucket:
            raise ProviderUnavailable(self.not_ready)
        if self.ctx.bedrock is None:
            raise ProviderUnavailable(self.setup_line())
        from botocore.exceptions import ClientError

        model_input = self.model_input(entry, prompt, seed, width, height)
        client = self.ctx.bedrock(self._region(entry))
        try:
            started = await asyncio.to_thread(
                client.start_async_invoke,
                modelId=str(entry.get("modelId")),
                modelInput=model_input,
                outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{bucket}/{prefix}"}},
            )
        except ClientError as e:
            error = e.response.get("Error") or {}
            said = str(error.get("Message") or "")[:300] or None
            log("warn", "stories.shot_refused", maker=self.id, code=error.get("Code"))
            if said and "end of its life" in said.lower():
                raise ProviderUnavailable(ended_line("animation", entry, label)) from e
            if _refused_model(e):
                raise ProviderFailed(self.setup_line(), state="needs_setup", last_error=self.not_enabled(label),
                                     detail=said) from e  # fmt: skip
            raise ProviderFailed(SHOT_FAILED.format(label=label), detail=said) from e
        arn = str(started.get("invocationArn") or "")
        uri = await self._wait(client, arn, label)
        got_bucket, _, folder = uri.removeprefix("s3://").partition("/")
        if got_bucket != bucket or not folder.startswith(prefix):
            raise ProviderFailed(SHOT_FAILED.format(label=label), state="on",
                                 last_error="The shot was not where it was asked to be.")  # fmt: skip
        return await self._mp4_in(entry, bucket, folder)

    def not_enabled(self, label: str) -> str:
        return LUMA_NOT_ENABLED if self.id == "luma-ray" else f"Bedrock says {label} is not turned on for this account."

    async def _mp4_in(self, entry: dict[str, Any], bucket: str, folder: str) -> str:
        """The shot's MP4 under ``folder`` (AWS's pages name the folder, not the file: the first ``.mp4`` there; Nova
        Reel's ``output.mp4`` when the listing finds none)."""
        assert self.ctx.s3_in is not None
        s3 = self.ctx.s3_in(self._region(entry))
        prefix = folder.rstrip("/") + "/"
        listed = await asyncio.to_thread(s3.list_objects_v2, Bucket=bucket, Prefix=prefix)
        found = sorted(str(o.get("Key")) for o in listed.get("Contents") or [] if str(o.get("Key")).endswith(".mp4"))
        return found[0] if found else f"{prefix}output.mp4"

    async def _wait(self, client: Any, arn: str, label: str) -> str:
        waited = 0.0
        while waited < REEL_SECONDS:
            got = await asyncio.to_thread(client.get_async_invoke, invocationArn=arn)
            status = str(got.get("status") or "")
            if status == "Completed":
                return str(((got.get("outputDataConfig") or {}).get("s3OutputDataConfig") or {}).get("s3Uri") or "")
            if status == "Failed":
                said = str(got.get("failureMessage") or "")[:300] or None
                log("warn", "stories.shot_failed", maker=self.id, detail=said)
                raise ProviderFailed(SHOT_FAILED.format(label=label), state="on",
                                     last_error=f"{label} could not make the shot.", detail=said)  # fmt: skip
            await self.ctx.sleep(REEL_POLL)
            waited += REEL_POLL
        raise ProviderFailed(SHOT_FAILED.format(label=label))


class LumaRay(AiVideo):
    """Luma AI Ray2 on Amazon Bedrock in us-west-2: 5-second shots for cut-aways, into the us-west-2 bucket (off
    until ``stories_video_west_bucket`` is switched on). Try it is here (``provider_check``)."""

    id, label = "luma-ray", "Luma AI Ray2"
    state = "needs_setup"
    line = (
        "Makes realistic AI shots of 5 seconds for scenes with no characters (cut-aways). Runs in the US (Oregon). "
        "Videos that use them are posted with the platforms' AI labels. Shown as on after its first shot."
    )

    def check(self) -> ProviderStatus:
        line = self.line if self.ctx.video_west_bucket else LUMA_NOT_READY
        return ProviderStatus(self.kind, self.id, self.label, "needs_setup", line)


class OwnVideo(AiVideo):
    """A video model the owner added on Bedrock (a Luma AI or Amazon Nova Reel model id) in a Region where Lamo Stories
    has a shots bucket; cut-aways only."""

    id, label = "own-video", "Your video models"
    line = (
        "Makes AI shots for scenes with no characters with a video model you added in Settings › Video. Off until you "
        "pick it."
    )
    not_ready = OWN_VIDEO_NOT_READY

    def setup_line(self) -> str:
        return OWN_VIDEO_NOT_READY


def reel_dimension(width: int, height: int) -> str:
    """The Nova Reel size nearest the story's frame (by shape, then by size): 1280x720, the one it makes."""
    want = width / max(1, height)
    w, h = min(REEL_SIZES, key=lambda s: (abs(s[0] / s[1] - want), abs(s[0] * s[1] - width * height)))
    return f"{w}x{h}"


async def fit_shot(src: Path, out: Path, seconds: float, crf: int, size: tuple[int, int] = (1080, 1920)) -> None:
    """A Nova Reel shot as a scene clip of the story's own size (``size``) and ``seconds``: scaled and cropped to fill
    the frame, looped if it is shorter, 30 fps, no sound (the story's own mix is added at assembly)."""
    w, h = size
    await proc.run(
        ["ffmpeg", "-v", "error", "-y", "-stream_loop", "-1", "-i", str(src), "-t", f"{seconds:.3f}",
         "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps=30", "-an",
         "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         str(out)],
        time_limit=600,
    )  # fmt: skip


# --- audio --------------------------------------------------------------------------------------------------------


class BuiltinSynth(_Base):
    kind, id, label = "audio", "builtin-synth", "Built-in sounds"
    state = "on"
    line = "Built in: makes every sound effect, noise and tune on the server. Nothing to set up."

    def __init__(self, ctx: ProviderContext) -> None:
        super().__init__(ctx)
        self.made_seconds = 0.0  # seconds of sound an outside maker made (its USAGE#); 0 for the synth
        self.made_units: tuple[float, str] | None = None  # what an outside maker bills: (units, "second" | "character")
        self.made: dict[str, Any] = {}  # which models made which part (the audio asset's meta)
        # what each outside model made, billed part by part (one USAGE# each, also for the parts made before a later
        # call failed): ``{"role", "key", "modelId", "units", "unit"}``
        self.made_parts: list[dict[str, Any]] = []

    async def mix(self, script: dict[str, Any], out: Path) -> Path:
        work = self.ctx.workdir / "sound"
        script_path = write_json(work / "script.json", script)
        events = await self.ctx.engine.audio(script_path)
        seconds = frame_count(script) / 30.0
        mood, volume = music_of(script)
        effects, bed, voices = await self.made_sounds(script, events, seconds, mood, work)
        extra: dict[str, Any] = {}
        if effects:
            extra["effects"] = effects
        if bed is not None:
            extra["bed"] = bed
        if voices:
            extra["voices"] = voices
        stereo = await asyncio.to_thread(
            functools.partial(audio.mix, events, seconds, mood=mood, music_volume=volume,
                              seed=int(script.get("seed") or 0), **extra)
        )  # fmt: skip
        out.parent.mkdir(parents=True, exist_ok=True)
        loud = await audio.master(stereo, work / "mix.wav", out)
        log("info", "stories.sound", maker=self.id, events=len(events), seconds=round(seconds, 2), mood=mood,
            loudness=loud, made=len(effects or {}), bed=bed is not None, voices=len(voices or []))  # fmt: skip
        return out

    async def made_sounds(
        self, script: dict[str, Any], events: list[dict[str, Any]], seconds: float, mood: str, work: Path
    ) -> tuple[dict[str, Any] | None, Any, list[tuple[float, Any]] | None]:
        """The sounds an outside maker made: effects by id, a music bed and spoken lines at their times. The synth
        makes everything itself."""
        return None, None, None


def effect_prompt(sfx_id: str) -> str:
    """Words for one effect of the engine's catalog, for a sound-effect model: a short cartoon effect, never a voice,
    words or music."""
    words = SFX_WORDS.get(sfx_id, sfx_id.replace("_", " "))
    return f"Cartoon sound effect: {words}. Clean and punchy. No voices, no speech, no words, no music."


SFX_WORDS = {
    "whoosh": "a quick whoosh of something flying past",
    "skid": "car tyres skidding on a road",
    "screech": "a long tyre screech of a car braking hard",
    "tyre_burst": "a car tyre bursting with a pop and a hiss",
    "thud": "a soft heavy thud",
    "bump": "a small bump of a car going over a kerb",
    "honk": "a friendly car horn honk",
    "engine": "a small car engine running steadily",
    "brake_squeal": "car brakes squealing",
    "pop": "a bubbly pop",
    "boing": "a springy boing",
    "ding": "a bright single bell ding",
    "tada": "a short happy fanfare",
    "sad_trombone": "a sad trombone, wah wah wah",
    "footsteps": "light footsteps walking",
    "wind": "wind blowing outside",
    "rain": "steady rain falling",
    "snow_crunch": "footsteps crunching in snow",
    "click": "a small click",
    "beep": "a short electronic beep",
    "swoosh_up": "a rising swoosh",
    "heartbeat": "a steady heartbeat",
    "tick": "a clock ticking",
}
MOOD_WORDS = {
    "calm": "calm, gentle music with soft piano and warm pads",
    "playful": "playful, bouncy cartoon music with pizzicato strings and light percussion",
    "tense": "tense, suspenseful music with low strings and a ticking pulse",
    "triumphant": "triumphant, uplifting music with brass and drums",
    "wonder": "dreamy music full of wonder, with bells and soft strings",
    "comedic": "comedic cartoon music with woodblocks, bassoon and a quirky rhythm",
}


def music_of(script: dict[str, Any]) -> tuple[str, float]:
    """The story's music: its mood and its volume, as the mix reads them."""
    m = script.get("music") or {}
    if not isinstance(m, dict):
        return "none", 0.0
    return str(m.get("mood") or "none"), float(m.get("volume") or 0.4)


def music_heard(script: dict[str, Any], seconds: float) -> bool:
    """True when the mix plays music under this story (a known mood, a volume above 0, some length): only then is a
    music bed worth asking a maker for."""
    mood, volume = music_of(script)
    return mood in audio.MOODS and volume > 0 and seconds > 0


def music_prompt(mood: str) -> str:
    """Words for the music bed: the story's mood, instrumental only."""
    words = MOOD_WORDS.get(mood, f"{mood.replace('_', ' ')} background music")
    return (
        f"Background music for a short animated cartoon: {words}. Instrumental only: no vocals, no singing, no speech."
    )


async def decode(data: bytes, work: Path, name: str) -> Any:
    """An audio file's bytes (MP3, WAV, …) as mono float32 samples at 48 kHz, through ffmpeg."""
    import numpy as np

    work.mkdir(parents=True, exist_ok=True)
    src, raw = work / f"{name}.in", work / f"{name}.f32"
    src.write_bytes(data)
    try:
        await proc.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-f", "f32le", "-ac", "1", "-ar",
                        str(audio.SR), str(raw)], time_limit=300)  # fmt: skip
        return np.frombuffer(raw.read_bytes(), dtype="<f4").astype(np.float32)
    finally:
        src.unlink(missing_ok=True)
        raw.unlink(missing_ok=True)


def natural_seconds(sfx_id: str) -> float:
    """How long the synth's own take of an effect is (an effect that does not hold), for asking a model for one."""
    try:
        return round(len(audio.effect_sound(sfx_id, audio.rng_for("len", sfx_id), None)) / audio.SR, 2)
    except KeyError:
        return 1.0


EL = keyed.ElevenLabs  # its limits: an effect is 0.5-30 s, a music bed 3-600 s (what each call is billed for)


class MadeSound(BuiltinSynth):
    """A sound maker with the owner's ElevenLabs key (§45.37 G3, G7): each distinct effect of the story made once from
    words (``/v1/sound-generation``) and, when the story has music, an instrumental bed for the whole video
    (``/v1/music``, ``force_instrumental``). Character noises stay the built-in, wordless ones, and no speech is ever
    asked for. Any part with no model of its own (``ctx.sound_models``) is made by the synth."""

    state = "off"

    def roles(self) -> dict[str, dict[str, Any]]:
        return {r: m for r, m in self.ctx.sound_models.items() if r in ("effects", "music")}

    async def made_sounds(
        self, script: dict[str, Any], events: list[dict[str, Any]], seconds: float, mood: str, work: Path
    ) -> tuple[dict[str, Any] | None, Any, list[tuple[float, Any]] | None]:
        roles = self.roles()
        if not roles:
            raise ProviderUnavailable(NO_OWN_MODEL.format(what="sound"))
        if any(config.host_of(m) == "bedrock" for m in roles.values()):
            raise ProviderUnavailable(SOUND_BEDROCK)
        key = read_key(self.ctx, "elevenlabs")
        if not key:
            raise ProviderFailed(SOUND_KEY, state="needs_setup", last_error="No ElevenLabs key is saved.")
        client = keyed.ElevenLabs(key, self.ctx.http or keyed.https)
        wanted: dict[str, float] = {}
        for e in sorted(events, key=lambda e: float(e.get("at") or 0)):
            sid = str(e.get("id") or "")
            if e.get("kind") != "sfx" or sid not in audio.SFX:
                continue
            dur = e.get("dur")
            secs = float(dur) if dur is not None and sid in audio.LOOPING else natural_seconds(sid)
            wanted[sid] = max(wanted.get(sid, 0.0), min(audio.MAX_EFFECT_SECONDS, secs))
        if len(wanted) > MAX_MADE_EFFECTS:
            log("info", "stories.sound_effects_capped", maker=self.id, asked=len(wanted), made=MAX_MADE_EFFECTS)
        effects: dict[str, Any] = {}
        bed: Any = None
        label = self.label
        billed = {"effects": 0.0, "music": 0.0}  # seconds each model made (billed), even when a later call fails
        try:
            fx = roles.get("effects")
            if fx is not None:
                label = str(fx.get("label") or label)
                for sid in list(wanted)[:MAX_MADE_EFFECTS]:
                    ask = functools.partial(asyncio.to_thread, client.effect, effect_prompt(sid), wanted[sid],
                                            loop=sid in audio.LOOPING, model_id=str(fx["modelId"]))  # fmt: skip
                    data = await retry(ask, what="elevenlabs.effect", attempts=3)
                    billed["effects"] += min(EL.EFFECT_MAX, max(EL.EFFECT_MIN, wanted[sid]))
                    effects[sid] = await decode(data, work / "made", f"fx-{len(effects)}")
            tune = roles.get("music")
            if tune is not None and music_heard(script, seconds):  # never a bed the mix would leave out
                label = str(tune.get("label") or label)
                ask = functools.partial(asyncio.to_thread, client.music, music_prompt(mood), seconds,
                                        model_id=str(tune["modelId"]))  # fmt: skip
                data = await retry(ask, what="elevenlabs.music", attempts=3)
                billed["music"] += min(EL.MUSIC_MAX_MS, max(EL.MUSIC_MIN_MS, seconds * 1000)) / 1000
                bed = await decode(data, work / "made", "music")
        except keyed.HostError as e:
            said = keyed.redact(str(e), key)[:300]
            log("warn", "stories.sound_maker_failed", maker=self.id, status=e.status_code, kind=e.kind, detail=said)
            if e.kind == "key":
                raise ProviderFailed(SOUND_KEY, state="needs_setup",
                                     last_error="ElevenLabs refused the saved key.", detail=said) from e  # fmt: skip
            if e.kind == "model" and e.found:
                raise ProviderFailed(SOUND_FAILED.format(label=label), state="needs_setup",
                                     last_error=e.found[1][:1].upper() + e.found[1][1:] + ".", detail=said) from e  # fmt: skip
            raise ProviderFailed(SOUND_FAILED.format(label=label), detail=said) from e
        finally:
            self._bill(roles, billed)
        self.made = {
            "effects": (roles.get("effects") or {}).get("key") if effects else None,
            "music": (roles.get("music") or {}).get("key") if bed is not None else None,
        }
        self.made_units = (round(self.made_seconds, 3), "second")
        return effects or None, bed, None

    def _bill(self, roles: dict[str, dict[str, Any]], billed: dict[str, float]) -> None:
        """One part per model that made something (its own model id and seconds), for the job's ``USAGE#`` rows."""
        self.made_parts = [
            {"role": role, "key": roles[role].get("key"), "modelId": str(roles[role].get("modelId") or ""),
             "units": round(secs, 3), "unit": "second"}
            for role, secs in billed.items()
            if secs > 0 and role in roles
        ]  # fmt: skip
        self.made_seconds = round(sum(billed.values()), 3)


class ElevenLabsSound(MadeSound):
    """ElevenLabs' sound effects and instrumental music with the owner's key (the bundled ``elevenlabs-effects`` and
    ``elevenlabs-music``); never its text-to-speech."""

    id, label = "elevenlabs", "ElevenLabs effects and music"
    line = (
        "Makes the sound effects and an instrumental music bed with your ElevenLabs key. Character noises stay built "
        "in, and it never makes a voice. Off until you pick it."
    )


class OwnSound(MadeSound):
    """A sound model the owner added (``own-sound``): on ElevenLabs, the effects or the music bed (its ``role``); the
    rest stays built in. A Bedrock one is refused with a sentence: Amazon Bedrock has no sound model yet."""

    id, label = "own-sound", "Your sound models"
    line = "Makes the effects or the music with a sound model you added in Settings › Video. Off until you pick it."


def spoken_lines(script: dict[str, Any]) -> list[tuple[float, str]]:
    """What Amazon Polly reads aloud: the story's captions at their times (the words already on screen), or, for a
    story without captions, each scene's caption at its start. Words only, never longer than Polly takes."""
    out: list[tuple[float, str]] = []
    for cue in script.get("captions") or []:
        text = " ".join(str((cue or {}).get("text") or "").split()) if isinstance(cue, dict) else ""
        if text:
            out.append((max(0.0, float(cue.get("at") or 0)), text[:POLLY_CHARACTERS]))
    if out:
        return sorted(out)
    at = 0.0
    for scene in script.get("scenes") or []:
        text = " ".join(str(scene.get("caption") or "").split())
        if text:
            out.append((at, text[:POLLY_CHARACTERS]))
        at += float(scene.get("durationSec") or 0)
    return out


class PollyVoice(BuiltinSynth):
    """Opt-in, never the default (§45.37 G7): Amazon Polly's neural voices (eu-west-1, this runtime's own role, no
    key) read the story's captions aloud; the effects, the character noises and the music stay the built-in ones, and
    the music ducks under the words. Lamo Stories' videos are made without a voice unless the owner picks this."""

    id, label = "polly", "A spoken voice (Amazon Polly)"
    state = "off"
    line = "Adds words spoken aloud. Your videos are made without a voice unless you pick this."

    async def made_sounds(
        self, script: dict[str, Any], events: list[dict[str, Any]], seconds: float, mood: str, work: Path
    ) -> tuple[dict[str, Any] | None, Any, list[tuple[float, Any]] | None]:
        lines = spoken_lines(script)
        if not lines:
            return None, None, None
        entry = self.ctx.sound_models.get("voice") or config.pick_model("audio", self.id, None) or {}
        if self.ctx.polly is None:
            raise ProviderFailed(VOICE_FAILED)
        from botocore.exceptions import ClientError

        client = self.ctx.polly(str(entry.get("region") or "eu-west-1"))
        voice = str(entry.get("voice") or "Joanna")
        engine = str(entry.get("modelId") or "neural")
        spoken: list[tuple[float, Any]] = []
        free_at = 0.0
        characters = 0
        for i, (at, text) in enumerate(lines):
            start = max(at, free_at)  # a line never talks over the one before it
            if start >= seconds:  # past the end: never asked for (or billed)
                break
            try:
                speak = functools.partial(asyncio.to_thread, client.synthesize_speech, Engine=engine, VoiceId=voice,
                                          OutputFormat="mp3", SampleRate="24000", Text=text, TextType="text")  # fmt: skip
                r = await retry(speak, what="polly.speech", attempts=3)
            except ClientError as e:
                error = e.response.get("Error") or {}
                said = str(error.get("Message") or "")[:300] or None
                log("warn", "stories.voice_failed", code=error.get("Code"), detail=said)
                if str(error.get("Code") or "") in ("AccessDeniedException", "UnrecognizedClientException"):
                    raise ProviderFailed(VOICE_SETUP, state="needs_setup",
                                         last_error="Amazon Polly refused this account in Europe (Ireland).",
                                         detail=said) from e  # fmt: skip
                raise ProviderFailed(VOICE_FAILED, detail=said) from e
            characters += len(text)  # billed once Polly answered
            self.made_parts = [{"role": "voice", "key": entry.get("key"), "modelId": engine,
                                "units": float(characters), "unit": "character"}]  # fmt: skip
            stream = r.get("AudioStream")
            data = stream.read() if hasattr(stream, "read") else bytes(stream or b"")
            samples = await decode(data, work / "voice", f"line-{i}")
            spoken.append((start, samples))
            free_at = start + len(samples) / audio.SR + 0.15
        self.made = {"voice": entry.get("key"), "lines": len(spoken)}
        self.made_units = (float(characters), "character")
        return None, None, spoken


REGISTRY: dict[str, dict[str, type[Any]]] = {
    "writer": {WRITER_ID: BedrockWriter},
    "images": {
        "builtin-rig": RigImages,
        "nova-canvas": NovaCanvas,
        "stability": StabilityImages,
        "own-images": OwnImages,
    },
    "animation": {"builtin-2d": Builtin2D, "nova-reel": NovaReel, "luma-ray": LumaRay, "own-video": OwnVideo},
    "audio": {"builtin-synth": BuiltinSynth, "polly": PollyVoice, "elevenlabs": ElevenLabsSound, "own-sound": OwnSound},
}
AI_VIDEO = frozenset({"nova-reel", "luma-ray", "own-video"})  # cut-aways only (scenes with no character)


def chosen(configuration: dict[str, Any] | None) -> dict[str, str]:
    """The workspace's provider per kind (``configuration.providers``: ``images``, ``video``, ``audio``); a missing or
    unknown id is the built-in one, which is also what the API saves by default (workspace-defaults.json)."""
    picked = dict(DEFAULTS)
    raw = (configuration or {}).get("providers") or {}
    if isinstance(raw, dict):
        for kind, name in CONFIG_KEYS.items():
            pid = raw.get(name)
            if isinstance(pid, str) and pid in REGISTRY[kind]:
                picked[kind] = pid
    return {"writer": WRITER_ID, **picked}


def writer_id(model_key: str, maker: str | None = None, host: str | None = None) -> str:
    """``meta.providers.writer`` for a storyboard written by ``model_key`` (§45.36 E7): ``bedrock-claude`` only when
    an Anthropic model wrote it on Amazon Bedrock, else ``bedrock-model:{key}`` (the screens name it from the model's
    label, maker and host, so a Claude model on the Anthropic API reads "… on Anthropic API", §45.37 G4). ``maker`` is
    who makes the model, lower case, as its reply says; without it a bundled model's own entry is read (an added model
    unknown here is never called Claude)."""
    if maker is None:
        info = config.model(model_key)
        maker = config.maker(info) if info else ""
    if host not in (None, "", "bedrock"):
        return f"{OTHER_WRITER}{model_key}"
    return WRITER_ID if maker.strip().lower() == "anthropic" else f"{OTHER_WRITER}{model_key}"


def has_actors(scene: dict[str, Any]) -> bool:
    return bool(scene.get("actors"))


def provider_item(fence_pk: str, user_id: str, workspace_id: str, kind: str, pid: str, state: str, at: str,
                  last_error: str | None = None, model: str | None = None) -> dict[str, Any]:  # fmt: skip
    """``PROVIDER#{kind}#{id}``: what a real call proved (written only by the agent, after the call, §45.11.6), with
    the ``model`` key it was made with for a maker that has models (§45.37: the API counts a proof only for the model
    in use)."""
    item: dict[str, Any] = {
        "pk": fence_pk,
        "sk": keys.provider_sk(kind, pid),
        "type": keys.TYPE_PROVIDER,
        "userId": user_id,
        "workspaceId": workspace_id,
        "kind": kind,
        "providerId": pid,
        "state": state,
        "checkedAt": at,
    }
    if last_error:
        item["lastError"] = last_error
    if model:
        item["model"] = model
    return item


def statuses(video_bucket: str = "", video_west_bucket: str = "") -> list[ProviderStatus]:
    """Every provider's state before any call (the API's ``workspaces/providers.py`` mirrors this table)."""
    ctx = ProviderContext(engine=Engine(Path("."), Path(".")), workdir=Path("."), video_bucket=video_bucket,
                          video_west_bucket=video_west_bucket)  # fmt: skip
    return [cls(ctx).check() for kind in KINDS for cls in REGISTRY[kind].values()]


def ended_line(kind: str, entry: dict[str, Any] | None, label: str) -> str:
    """The sentence a pick of an ended maker or model stops with, before any call (§45.37 G7): "Amazon Nova Canvas
    was ended by Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › Settings › Video." """
    day = config.ended_words(str((entry or {}).get("ended") or ENDED_DAY))
    return ENDED_LINE.format(label=label, day=day, what=WHAT.get(kind, kind))


def bundled_label(pid: str, kind: str, fallback: str) -> str:
    """The label of a maker's first bundled model (models.json), which the API's ended sentence also uses: "Amazon
    Nova Reel 1.1 was ended by Amazon …"."""
    listed = config.models_of(pid, config.MAKER_KIND_OF.get(kind, kind))
    return str(listed[0].get("label") or fallback) if listed else fallback


def maker_model(
    kind: str, configuration: dict[str, Any] | None, makers: dict[str, list[dict[str, Any]]] | None = None
) -> dict[str, Any] | None:
    """The model the workspace's maker of ``kind`` (``images`` | ``animation`` | ``audio``) makes with for this job
    (§45.37 G1): its pick (``configuration.providers.imageModel`` / ``videoModel`` / ``audioModel``) when it is one of
    that maker's models, else the maker's first model that has not ended. None for a built-in maker (it has no
    models). Raises ``ProviderUnavailable`` with the owner's sentence, before any call, for an ended maker or model, a
    pick that is not one of the maker's models, or an own maker with no model added yet; nothing is swapped."""
    pid = chosen(configuration)[kind]
    if pid == DEFAULTS.get(kind):
        return None
    cls = REGISTRY[kind][pid]
    raw = (configuration or {}).get("providers") if isinstance(configuration, dict) else None
    pick = raw.get(MODEL_FIELDS[kind]) if isinstance(raw, dict) else None
    model_kind = config.MAKER_KIND_OF[kind]
    listed = config.models_of(pid, model_kind, makers)
    if pid in ENDED_MAKERS:  # named by its model's label, as the API's sentence names it ("Amazon Nova Reel 1.1")
        raise ProviderUnavailable(ended_line(kind, listed[0] if listed else None, bundled_label(pid, kind, cls.label)))
    if not listed:
        if pid.startswith("own-"):
            raise ProviderUnavailable(NO_OWN_MODEL.format(what=WHAT[kind]))
        return None
    entry = config.pick_model(model_kind, pid, pick, makers)
    if entry is None:
        raise ProviderUnavailable(NOT_ITS_MODEL.format(what=WHAT[kind], label=cls.label))
    if config.ended(entry):
        raise ProviderUnavailable(ended_line(kind, entry, str(entry.get("label") or cls.label)))
    return entry


def sound_models(
    configuration: dict[str, Any] | None, makers: dict[str, list[dict[str, Any]]] | None = None
) -> dict[str, dict[str, Any]]:
    """The model of each part of the sound for this job (``effects``, ``music``, ``voice``): the picked model for its
    own part, and for each other part the maker's first model of that part (ElevenLabs makes the effects and the
    music bed even when only one of its two models is picked). Empty for the built-in sounds. Raises
    ``ProviderUnavailable`` as ``maker_model`` does."""
    picked = maker_model("audio", configuration, makers)
    if picked is None:
        return {}
    pid = chosen(configuration)["audio"]
    out = {config.role_of(picked): picked}
    if pid.startswith("own-"):
        return out
    for m in config.models_of(pid, "audio", makers):
        role = config.role_of(m)
        if role not in out and not config.ended(m):
            out[role] = m
    return out
