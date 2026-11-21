"""Who makes what: a registry of providers per kind (docs/CONTRACTS.md §45.11.6, §45.31, ADR-75, ADR-80).

The pipeline only ever calls ``REGISTRY[kind][providerId]`` (the workspace's ``configuration.providers``: ``images``,
``video`` for the animation kind, ``audio``; the writer is always ``bedrock-claude``, on the model the owner picked
for the task, §45.25), so a new provider is one class and one registry line. Each kind has one Protocol:

* ``Writer.write(brief) -> dict``: a raw script (it always goes through normalize, validate and fit);
* ``ImageProvider.image(prompt, width, height, seed, refs) -> bytes``: a PNG;
* ``AnimationProvider.render_scene(script, scene_id, assets, out) -> SceneClip``: one scene's MP4;
* ``AudioProvider.mix(script, out) -> Path``: an m4a at 48 kHz, -14 LUFS;

and every provider has ``check() -> ProviderStatus``, its state before any call (the API's ``workspaces/providers.py``
mirrors these). A provider is shown ``on`` only after a real call answered: the job writes ``PROVIDER#{kind}#{id}``
then (pipeline.py, portrait.py), never because it was configured.

* ``nova-canvas`` (Amazon Nova Canvas, Bedrock in eu-west-1) draws character portraits for the app and the Library
  only, never anything inside a posted video.
* ``nova-reel`` (Amazon Nova Reel 1.1, Bedrock in us-east-1, ``StartAsyncInvoke``) writes 6-second shots to the US
  bucket ``CF_VIDEO_BUCKET`` (``needs_setup`` while it is empty). Its realistic footage is used for the story's
  cut-aways only: scenes with no character in them. Scenes with characters are always drawn by the built-in animator,
  so a character looks the same in every shot (§45.8). A story that used it records ``nova-reel`` in
  ``PJOB#.meta.providers`` and is posted only with the platforms' AI labels (§45.14)."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Protocol

from . import audio, keys, proc, writer
from .engine import Engine, frame_count, write_json
from .models import unavailable
from .retry import retry
from .util import log

KINDS = ("writer", "images", "animation", "audio")
DEFAULTS = {"images": "builtin-rig", "animation": "builtin-2d", "audio": "builtin-synth"}
CONFIG_KEYS = {"images": "images", "animation": "video", "audio": "audio"}  # StoriesConfig.providers' names
WRITER_ID = "bedrock-claude"
CANVAS_NOT_ENABLED = "Bedrock says Nova Canvas is not enabled for this account in Europe (Ireland)."
CANVAS_SETUP = (
    "AI pictures are not set up yet. Turn on Amazon Nova Canvas in the Bedrock console, Region Europe (Ireland), "
    "then tap Try again."
)
CANVAS_REFUSED = "Nova Canvas would not draw this character. Change the description a little, then tap Try again."
REEL_NO_BUCKET = (
    "Nova Reel needs a storage bucket in the USA (N. Virginia), which is switched off. Pick the built-in animator in "
    "Lamo Stories › Settings › Video, then tap Try again."
)
REEL_NOT_ENABLED = "Bedrock says Nova Reel is not enabled for this account in US East (N. Virginia)."
REEL_SETUP = (
    "AI video is not set up yet. Turn on Amazon Nova Reel in the Bedrock console, Region US East (N. Virginia), or pick "
    "the built-in animator in Lamo Stories › Settings › Video, then tap Try again."
)
REEL_FAILED = "Nova Reel could not make this shot. Tap Try again, or pick the built-in animator in Settings."
SCENE_SECONDS = 30 * 60
REEL_SECONDS = 20 * 60  # Nova Reel takes about 90 s for a 6 s shot; give it room
REEL_SHOT = 6
REEL_POLL = 15.0


@dataclass(frozen=True)
class ProviderStatus:
    kind: str
    id: str
    label: str
    state: str  # on | off | needs_setup | unavailable
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
    """A provider's real call failed. ``state`` is what that call proved (None: nothing, try again)."""

    def __init__(self, sentence: str, *, state: str | None = None, last_error: str | None = None) -> None:
        super().__init__(sentence)
        self.sentence = sentence
        self.state = state
        self.last_error = last_error


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
    reel_prefix: Callable[[str], str] | None = None  # scene id -> the shot's prefix in the US bucket
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    extra: dict[str, Any] = field(default_factory=dict)


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
    story or a rewrite, ``scene_rewrite`` for named scenes, §45.25)."""

    kind, id, label = "writer", WRITER_ID, "Claude on Amazon Bedrock"
    state = "needs_setup"
    line = "Writes every story on the model you pick in Settings › AI. Shown as on after its first answer."

    async def write(self, brief: dict[str, Any]) -> dict[str, Any]:
        if self.ctx.ask is None:
            raise RuntimeError("the writer needs the job's model call")
        mode = str(brief.get("mode") or "full")
        schema = writer.storyboard_schema(
            brief.get("catalog") or {}, brief.get("castIds") or [], brief.get("topicIds") or [], mode=mode
        )
        task = "scene_rewrite" if mode == "scenes" else "storyboard"
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
    state = "needs_setup"
    line = "Draws your characters the same way in every video. Shown as on after the first scenes are drawn."

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
    """Amazon Nova Canvas in eu-west-1 (``imageModel`` in stories/config/models.json): portraits for the app only."""

    kind, id, label = "images", "nova-canvas", "Amazon Nova Canvas"
    state = "off"
    line = "Makes AI pictures of your characters for the app only. Pick it in Lamo Stories › Settings to try it."

    async def image(self, prompt: str, width: int, height: int, seed: int, refs: list[Path]) -> bytes:
        """One TEXT_IMAGE call (the references stay the owner's look to aim for; they are not sent). Raises
        ProviderFailed with what the call proved about the provider."""
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


# --- animation ----------------------------------------------------------------------------------------------------


async def render_still(engine: Engine, script_path: Path, frame: int, out: Path, work: Path) -> None:
    spec = {"deno": engine.argv(), "script": str(script_path), "from": frame, "to": frame + 1, "out": str(out)}
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
    state = "needs_setup"
    line = "Animates every scene on the server. Shown as on after the first video is animated."
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
    """Amazon Nova Reel 1.1 (``videoModel`` in stories/config/models.json), through ``StartAsyncInvoke`` into the US
    bucket, for a scene with no character in it (a cut-away)."""

    kind, id, label = "animation", "nova-reel", "Amazon Nova Reel"
    state = "needs_setup"
    line = (
        "Makes realistic AI shots for scenes without characters. Needs its US (N. Virginia) storage switched on and "
        "the model turned on in Bedrock; posts that use it get AI labels."
    )

    def check(self) -> ProviderStatus:
        line = self.line if self.ctx.video_bucket else REEL_NO_BUCKET
        return ProviderStatus(self.kind, self.id, self.label, "needs_setup", line)

    async def render_scene(
        self, script: dict[str, Any], scene_id: str, assets: dict[str, Path], out: Path
    ) -> SceneClip:
        if not self.ctx.video_bucket:
            raise ProviderUnavailable(REEL_NO_BUCKET)
        if self.ctx.reel_client is None or self.ctx.us_s3 is None or self.ctx.reel_prefix is None:
            raise ProviderUnavailable(REEL_SETUP)
        scene = next((s for s in script.get("scenes") or [] if s.get("sceneId") == scene_id), None)
        if scene is None:
            raise ValueError(f"scene {scene_id} is not in the script")
        from botocore.exceptions import ClientError

        client = self.ctx.reel_client()
        prefix = self.ctx.reel_prefix(scene_id)
        model_input = {
            "taskType": "TEXT_VIDEO",
            "textToVideoParams": {"text": reel_prompt(script, scene)},
            "videoGenerationConfig": {
                "durationSeconds": REEL_SHOT,
                "fps": 24,
                "dimension": "1280x720",
                "seed": int(scene.get("seed") or self.ctx.seed or 0) % 2147483646,
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
            log("warn", "stories.reel_refused", code=(e.response.get("Error") or {}).get("Code"))
            if _refused_model(e):
                raise ProviderFailed(REEL_SETUP, state="needs_setup", last_error=REEL_NOT_ENABLED) from e
            raise ProviderFailed(REEL_FAILED) from e
        arn = str(started.get("invocationArn") or "")
        uri = await self._wait(client, arn)
        local = self.ctx.workdir / "reel" / f"{scene_id}-shot.mp4"
        local.parent.mkdir(parents=True, exist_ok=True)
        bucket, _, key = uri.removeprefix("s3://").partition("/")
        if bucket != self.ctx.video_bucket or not key.startswith(prefix):
            raise ProviderFailed(REEL_FAILED, state="on", last_error="The shot was not where it was asked to be.")
        s3 = self.ctx.us_s3()
        await asyncio.to_thread(s3.download_file, bucket, f"{key.rstrip('/')}/output.mp4", str(local))
        seconds = float(scene.get("durationSec") or REEL_SHOT)
        await fit_shot(local, out, seconds, self.ctx.crf)
        if self.ctx.on_progress:
            self.ctx.on_progress(1, 1)
        return SceneClip(out, None, seconds)

    async def _wait(self, client: Any, arn: str) -> str:
        """Polls ``GetAsyncInvoke`` until the shot is ready; returns its S3 folder."""
        waited = 0.0
        while waited < REEL_SECONDS:
            got = await asyncio.to_thread(client.get_async_invoke, invocationArn=arn)
            status = str(got.get("status") or "")
            if status == "Completed":
                return str(((got.get("outputDataConfig") or {}).get("s3OutputDataConfig") or {}).get("s3Uri") or "")
            if status == "Failed":
                log("warn", "stories.reel_failed", detail=str(got.get("failureMessage") or "")[:300])
                raise ProviderFailed(REEL_FAILED, state="on", last_error="Nova Reel could not make the shot.")
            await self.ctx.sleep(REEL_POLL)
            waited += REEL_POLL
        raise ProviderFailed(REEL_FAILED)


async def fit_shot(src: Path, out: Path, seconds: float, crf: int) -> None:
    """A 16:9 shot as a 1080×1920 scene clip of ``seconds``: cropped to fill the frame, looped if it is shorter, 30 fps,
    no sound (the story's own mix is added at assembly)."""
    await proc.run(
        ["ffmpeg", "-v", "error", "-y", "-stream_loop", "-1", "-i", str(src), "-t", f"{seconds:.3f}",
         "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30", "-an",
         "-c:v", "libx264", "-preset", "fast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
         str(out)],
        time_limit=600,
    )  # fmt: skip


# --- audio --------------------------------------------------------------------------------------------------------


class BuiltinSynth(_Base):
    kind, id, label = "audio", "builtin-synth", "Built-in sounds"
    state = "needs_setup"
    line = "Makes every sound effect, noise and tune on the server. Shown as on after the first video's sound."

    async def mix(self, script: dict[str, Any], out: Path) -> Path:
        work = self.ctx.workdir / "sound"
        script_path = write_json(work / "script.json", script)
        events = await self.ctx.engine.audio(script_path)
        seconds = frame_count(script) / 30.0
        m = script.get("music") or {}
        mood = str(m.get("mood") or "none") if isinstance(m, dict) else "none"
        volume = float(m.get("volume") or 0.4) if isinstance(m, dict) else 0.0
        stereo = await asyncio.to_thread(
            audio.mix, events, seconds, mood=mood, music_volume=volume, seed=int(script.get("seed") or 0)
        )
        out.parent.mkdir(parents=True, exist_ok=True)
        loud = await audio.master(stereo, work / "mix.wav", out)
        log("info", "stories.sound", events=len(events), seconds=round(seconds, 2), mood=mood, loudness=loud)
        return out


REGISTRY: dict[str, dict[str, type[Any]]] = {
    "writer": {WRITER_ID: BedrockWriter},
    "images": {"builtin-rig": RigImages, "nova-canvas": NovaCanvas},
    "animation": {"builtin-2d": Builtin2D, "nova-reel": NovaReel},
    "audio": {"builtin-synth": BuiltinSynth},
}


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


def has_actors(scene: dict[str, Any]) -> bool:
    return bool(scene.get("actors"))


def provider_item(fence_pk: str, user_id: str, workspace_id: str, kind: str, pid: str, state: str, at: str,
                  last_error: str | None = None) -> dict[str, Any]:  # fmt: skip
    """``PROVIDER#{kind}#{id}``: what a real call proved (written only by the agent, after the call, §45.11.6)."""
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
    return item


def statuses(video_bucket: str = "") -> list[ProviderStatus]:
    """Every provider's state before any call (the API's ``workspaces/providers.py`` mirrors this table)."""
    ctx = ProviderContext(engine=Engine(Path("."), Path(".")), workdir=Path("."), video_bucket=video_bucket)
    return [cls(ctx).check() for kind in KINDS for cls in REGISTRY[kind].values()]
