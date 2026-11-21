"""The story writer's request and answer (docs/CONTRACTS.md §45.11.2): the prompt, the tool schema built from the
engine's catalog, and the code that turns an answer into a ``StoryScript``.

The writer only picks from the catalog and names characters by cast id; it never describes or changes how they look.
Code adds what is not the writer's to decide: the engine version, 1080 × 1920 at 30 fps, the seeds, the cast with
its looks, the captions switch, the music the owner picked and the safety sources. Every answer then goes through
the engine's ``validate``, ``normalize`` and ``fit`` (pipeline.py)."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from . import keys
from .guidance import Topic

POST_FIELDS = ("youtubeTitle", "youtubeDescription", "instagram", "facebook", "tiktok", "x")
POST_LIMITS = {
    "youtubeTitle": 100,
    "youtubeDescription": 5000,
    "instagram": 2200,
    "facebook": 5000,
    "tiktok": 2200,
    "x": 280,
}
MAX_SCENES = 12
MAX_SECONDS = 89.5
DRIVING_ACTIONS = frozenset({"drive", "steer_left", "steer_right", "brake", "brace"})
VEHICLE_ACTIONS = frozenset({"move", "skid", "spin", "stop", "bump", "tyre_burst"})
VEHICLES = frozenset({"car", "truck"})

SYSTEM = """You write the storyboard of one short animated video for Lamo Stories, a cartoon channel.

House rules (always):
- No voice-over and no spoken words. The story is told through movement, faces, body language, sound effects, the
  characters' non-verbal noises and music. Speech bubbles hold symbols only.
- Vertical 9:16 video. Scenes last 2 to 15 seconds; the whole video lands close to the target length.
- Recurring characters: use only the cast you are given, by cast id. Never describe or change how a character looks.
- Use only ids from the catalog for sets, views, cameras, actions, prop kinds, prop actions, faces, bubbles, noises,
  effects and music moods. A beat's "who" is a cast id or a prop id of the same scene; characters do actions, props do
  prop actions.
- The videos are for a general audience on YouTube, Instagram, Facebook, TikTok and X. They are never made for
  children.
- Nothing dangerous is ever shown as fun or as something to copy. A mistake is shown as a mistake, and the scene
  after it shows the safe way.
- Captions are short (at most 60 characters), plain and kind. Leave captions empty when the captions switch is off.
- Driving advice only from the checked guidance you are given: every on-screen instruction takes its words from one
  guidance step or dont and names its id in "guidanceRef". Never add advice of your own, never use a step that is not
  in the list, and do not show braking or gear changes unless the guidance gives them. If a story of another kind
  starts to teach driving safety, set teachesSafety to true and pick the closest topic id, or set it to null.
- Positions are 0..1 of the frame (x left to right, y top to bottom). A prop's "state" is free text; these mean
  something to the animator: cars and trucks "parked", "driving", "lights", "brakes", "flat"; an arrow "curve_left"
  or "curve_right"; a tree "pine" or "snow"; a phone "ring" or "on". An arrow points up at rot 0; a car seen from
  above ("top" view) points its nose up at rot 0 and turns clockwise as rot grows.
- Reference videos, when given, are other people's videos the owner liked: borrow only structure, timing and staging
  ideas from their analyses; never copy their characters, logos, footage, music or catchphrases."""

CAPTIONS_PROMPT = """You write the six post captions of one finished Lamo Stories video (a short animated story with
no voice-over), from its script.

- youtubeTitle: at most 100 characters, no hashtags, makes people curious.
- youtubeDescription: two or three short lines, ending with #shorts.
- instagram, facebook, tiktok: one or two short lines with a few relevant hashtags.
- x: at most 200 characters.
- Plain, kind words for a general audience; never written for children; no false promises.
- For a driving-safety video every description names the sources the advice is based on (given below) and says
  "Check your local road rules."
- Keep every caption the owner wrote himself exactly as it is (listed under "keep")."""


def catalog_ids(catalog: dict[str, Any], key: str) -> list[str]:
    return [str(e["id"]) for e in catalog.get(key) or [] if isinstance(e, dict) and e.get("id")]


def _enum(values: Sequence[str], *, nullable: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"type": ["string", "null"] if nullable else "string", "enum": list(values)}
    if nullable:
        out["enum"] = [*values, None]
    return out


def _num(lo: float, hi: float) -> dict[str, Any]:
    return {"type": "number", "minimum": lo, "maximum": hi}


def scene_schema(catalog: dict[str, Any], cast_ids: Sequence[str]) -> dict[str, Any]:
    actions = catalog_ids(catalog, "actions") + catalog_ids(catalog, "propActions")
    point = {
        "type": ["object", "null"],
        "additionalProperties": False,
        "required": ["x", "y"],
        "properties": {"x": _num(0, 1), "y": _num(0, 1)},
    }
    beat = {
        "type": "object",
        "additionalProperties": False,
        "required": ["at", "dur", "who", "do"],
        "properties": {
            "at": _num(0, 15),
            "dur": _num(0.1, 15),
            "who": {"type": "string", "description": "A cast id, or a prop id of this scene."},
            "do": _enum(actions),
            "face": _enum(catalog_ids(catalog, "expressions"), nullable=True),
            "to": point,
            "dir": _enum(["left", "right"], nullable=True),
            "bubble": _enum(catalog_ids(catalog, "bubbles"), nullable=True),
            "noise": _enum(catalog_ids(catalog, "noises"), nullable=True),
            "sfx": _enum(catalog_ids(catalog, "sfx"), nullable=True),
        },
    }
    actor = {
        "type": "object",
        "additionalProperties": False,
        "required": ["castId", "x", "y", "facing"],
        "properties": {
            "castId": _enum(list(cast_ids)),
            "x": _num(0, 1),
            "y": _num(0, 1),
            "facing": _enum(["left", "right"]),
            "inCar": {"type": ["string", "null"], "description": "The prop id of a car or truck it sits in."},
        },
    }
    prop = {
        "type": "object",
        "additionalProperties": False,
        "required": ["propId", "kind", "x", "y", "scale", "rot"],
        "properties": {
            "propId": {"type": "string", "maxLength": 24},
            "kind": _enum(catalog_ids(catalog, "props")),
            "x": _num(-0.5, 1.5),
            "y": _num(-0.5, 1.5),
            "scale": _num(0.1, 4),
            "rot": _num(-360, 360),
            "color": {"type": ["string", "null"], "description": "#rrggbb, or null for the prop's own colour."},
            "state": {"type": ["string", "null"], "maxLength": 40},
        },
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["sceneId", "title", "durationSec", "set", "view", "camera", "actors", "props", "beats", "caption"],
        "properties": {
            "sceneId": {"type": "string", "maxLength": 24, "description": "Short and unique: s1, s2, ..."},
            "title": {"type": "string", "maxLength": 40},
            "durationSec": _num(2, 15),
            "set": _enum(catalog_ids(catalog, "sets")),
            "view": _enum(["side", "top"]),
            "camera": _enum(catalog_ids(catalog, "cameras")),
            "actors": {"type": "array", "maxItems": 3, "items": actor},
            "props": {"type": "array", "maxItems": 10, "items": prop},
            "beats": {"type": "array", "minItems": 1, "maxItems": 14, "items": beat},
            "caption": {"type": ["string", "null"], "maxLength": 60},
            "note": {"type": ["string", "null"], "maxLength": 200},
        },
    }


CAPTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "at", "dur", "text"],
    "properties": {
        "id": {"type": "string", "maxLength": 24},
        "at": _num(0, MAX_SECONDS),
        "dur": _num(0.3, 15),
        "text": {"type": "string", "maxLength": 60},
        "guidanceRef": {"type": ["string", "null"], "description": "The guidance step or dont id it comes from."},
    },
}

POST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": list(POST_FIELDS),
    "properties": {f: {"type": "string", "maxLength": POST_LIMITS[f]} for f in POST_FIELDS},
}


def storyboard_schema(
    catalog: dict[str, Any], cast_ids: Sequence[str], topic_ids: Sequence[str], *, mode: str
) -> dict[str, Any]:
    """The ``write_storyboard`` tool's input schema. ``full``: the whole story; ``scenes``: only the named scenes
    (and, if they change, the whole captions list); ``fix``: the whole story again with the facts fixed."""
    scenes = {
        "type": "array",
        "minItems": 1,
        "maxItems": MAX_SCENES,
        "items": scene_schema(catalog, cast_ids),
    }
    captions = {"type": "array", "maxItems": 24, "items": CAPTION_SCHEMA}
    if mode == "scenes":
        return {
            "type": "object",
            "additionalProperties": False,
            "required": ["scenes"],
            "properties": {
                "scenes": scenes,
                "captions": {**captions, "type": ["array", "null"]},
                "teachesSafety": {"type": ["boolean", "null"]},  # these scenes now teach driving safety
            },
        }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "teachesSafety", "safetyTopicId", "scenes", "music", "captions"],
        "properties": {
            "title": {"type": "string", "maxLength": 80},
            "teachesSafety": {"type": "boolean"},
            "safetyTopicId": _enum(list(topic_ids), nullable=True),
            "scenes": {**scenes, "minItems": 2},
            "music": {
                "type": ["object", "null"],
                "additionalProperties": False,
                "required": ["mood", "volume"],
                "properties": {"mood": _enum(catalog_ids(catalog, "musicMoods")), "volume": _num(0, 1)},
            },
            "captions": captions,
        },
    }


def captions_request(
    script: dict[str, Any],
    topic: Topic | None,
    *,
    keep: dict[str, str],
    concept: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """The ``captions`` call's message: the final script without looks, the sources of a safety story and the owner's
    own captions to keep."""
    body: dict[str, Any] = {
        "story": concept or {"title": script.get("title")},
        "script": without_looks(script),
        "sources": [c.get("publisher") for c in topic.citations] if topic else None,
        "keep": keep,
    }
    return [
        {
            "role": "user",
            "content": [
                {"text": CAPTIONS_PROMPT},
                {"text": "The video, as JSON:\n" + json.dumps(body, ensure_ascii=False, separators=(",", ":"))},
            ],
        }
    ]


def cast_brief(cast: dict[str, dict[str, Any]], characters: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """What the writer may know of each cast member: never the look."""
    out = []
    for cid, member in cast.items():
        ch = characters.get(str(member.get("characterId"))) or {}
        voice = member.get("voice") or {}
        out.append(
            {
                "castId": cid,
                "name": member.get("name"),
                "personality": ch.get("personality") or "",
                "description": ch.get("description") or "",
                "traits": ch.get("traits") or [],
                "movementStyle": member.get("movementStyle"),
                "faces": ch.get("expressions") or [],
                "noises": voice.get("noises") or [],
                "favouriteEffects": voice.get("sfx") or [],
            }
        )
    return out


def without_looks(script: dict[str, Any]) -> dict[str, Any]:
    """A script as the writer may see it: the cast by id, name and movement style only, never the looks."""
    cast = {
        cid: {"name": (m or {}).get("name"), "movementStyle": (m or {}).get("movementStyle")}
        for cid, m in (script.get("cast") or {}).items()
    }
    return {**script, "cast": cast}


def content(brief: dict[str, Any]) -> list[dict[str, Any]]:
    return [{"text": "The request, as JSON:\n" + json.dumps(brief, ensure_ascii=False, separators=(",", ":"))}]


def instructions(mode: str, *, note: str | None, scene_ids: Sequence[str] | None) -> str:
    if mode == "scenes" and not note:
        return (
            f"Write a new take of only these scenes: {', '.join(scene_ids or [])}. Keep the cast, the story beat, the "
            "scene's place and length; make the action and staging different. Answer with those scenes only, with "
            "the same scene ids."
        )
    if mode == "scenes":
        return (
            f"Change only these scenes, following the owner's note: {', '.join(scene_ids or [])}. Keep every other "
            "scene as it is. Answer with those scenes (same ids), and with the whole captions list only if a "
            "caption has to change."
        )
    if mode == "fix":
        return (
            "The fact checker found problems. Rewrite the story so every problem is gone, using only the checked "
            "guidance. Keep every text listed under 'keep' exactly as it is (the owner wrote it), keep each scene's id "
            "and length, and change nothing that is not needed to fix the problems."
        )
    if note:
        return "Rewrite the whole story following the owner's note, keeping the cast."
    return "Write the whole story."


def clean(value: Any) -> Any:
    """The answer without null optional fields (the engine's types use absent, not null)."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_scene(raw: dict[str, Any], used: set[str], index: int) -> dict[str, Any]:
    scene = clean(raw)
    sid = str(scene.get("sceneId") or "")
    if not keys.SCENE_ID.match(sid) or sid in used:
        sid = next(f"s{i}" for i in range(index + 1, index + 200) if f"s{i}" not in used)
    used.add(sid)
    scene["sceneId"] = sid
    scene.setdefault("note", None)
    scene.setdefault("caption", None)
    scene["sfx"] = [clean(c) for c in scene.get("sfx") or [] if isinstance(c, dict)]
    for p in scene.get("props") or []:
        if "color" in p and not _COLOR.match(str(p["color"])):
            del p["color"]
        if isinstance(p.get("color"), str):
            p["color"] = p["color"].lower()
    return scene


def clean_captions(raw: Sequence[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, c in enumerate(raw or []):
        cue = clean(c)
        cid = str(cue.get("id") or "")
        if not keys.SAFE_ID.match(cid) or cid in seen:
            cid = f"cap{i + 1}"
            while cid in seen:
                cid += "x"
        seen.add(cid)
        cue["id"] = cid
        cue["text"] = str(cue.get("text") or "")[:60]
        out.append(cue)
    return sorted(out, key=lambda c: float(c.get("at") or 0))


def post_captions(raw: dict[str, Any] | None, topic: Topic | None) -> dict[str, str]:
    """The six post captions within each platform's limit; a safety story's descriptions name its sources."""
    raw = raw or {}
    out = {f: str(raw.get(f) or "").strip() for f in POST_FIELDS}
    if not re.search(r"(?i)#shorts\b", out["youtubeDescription"]):
        out["youtubeDescription"] = f"{out['youtubeDescription']} #shorts".strip()
    if topic is not None and topic.citations:
        publishers = ", ".join(dict.fromkeys(c["publisher"] for c in topic.citations if c.get("publisher")))
        line = f"Based on advice from {publishers}. Check your local road rules."
        for f in ("youtubeDescription", "instagram", "facebook", "tiktok"):
            if publishers and publishers.split(",")[0] not in out[f]:
                out[f] = f"{out[f]}\n\n{line}".strip()
    for f, limit in POST_LIMITS.items():
        out[f] = out[f][:limit]
    return out


def script_from(
    answer: dict[str, Any],
    *,
    title: str,
    engine_version: int,
    seed: int,
    cast: dict[str, dict[str, Any]],
    captions_on: bool,
    music: dict[str, Any] | None,
    topic: Topic | None,
) -> dict[str, Any]:
    """A whole ``StoryScript`` from a ``full`` (or ``fix``) answer."""
    used: set[str] = set()
    scenes = [clean_scene(s, used, i) for i, s in enumerate(answer.get("scenes") or [])]
    return {
        "engine": engine_version,
        "fps": 30,
        "width": 1080,
        "height": 1920,
        "durationSec": round(sum(float(s.get("durationSec") or 0) for s in scenes), 3),
        "title": title[:80],
        "seed": seed,
        "cast": cast,
        "scenes": scenes,
        "music": music,
        "captionsOn": captions_on,
        "captions": clean_captions(answer.get("captions")) if captions_on else [],
        "safety": {"topicId": topic.id, "citations": topic.citations} if topic else None,
    }


def scene_windows(script: dict[str, Any]) -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    t = 0.0
    for s in script.get("scenes") or []:
        d = float(s.get("durationSec") or 0)
        out[str(s.get("sceneId"))] = (t, t + d)
        t += d
    return out


def merge_scenes(
    old: dict[str, Any],
    answer: dict[str, Any],
    scene_ids: Sequence[str],
    *,
    new_take: bool,
    seeds: dict[str, int],
) -> tuple[dict[str, Any], list[str]]:
    """The old script with only ``scene_ids`` replaced by the answer's scenes (same ids and places). A new take keeps
    each scene's length and gets a new seed. Returns the script and what is missing from the answer."""
    got = {str(s.get("sceneId")): s for s in answer.get("scenes") or [] if isinstance(s, dict)}
    missing = [sid for sid in scene_ids if sid not in got]
    scenes = []
    for i, s in enumerate(old.get("scenes") or []):
        sid = str(s.get("sceneId"))
        if sid in scene_ids and sid in got:
            fresh = clean_scene(got[sid], set(), i)
            fresh["sceneId"] = sid
            if new_take:
                fresh["durationSec"] = s.get("durationSec")
            fresh["seed"] = seeds[sid]
            scenes.append(fresh)
        else:
            scenes.append(s)
    script = {**old, "scenes": scenes}
    script["durationSec"] = round(sum(float(s.get("durationSec") or 0) for s in scenes), 3)
    caps = answer.get("captions")
    if isinstance(caps, list) and not new_take:
        windows = scene_windows(old)
        target = [windows[s] for s in scene_ids if s in windows]

        def inside(c: dict[str, Any]) -> bool:
            a = float(c.get("at") or 0)
            return any(lo <= a < hi for lo, hi in target)

        kept = [c for c in old.get("captions") or [] if not inside(c)]
        script["captions"] = clean_captions([*kept, *[c for c in clean_captions(caps) if inside(c)]])
    return script, missing


def texts(script: dict[str, Any], post: dict[str, Any] | None) -> dict[str, str]:
    """Every text a person reads, by reference: ``caption:{id}``, ``scene:{sceneId}``, ``post:{field}``."""
    out = {f"caption:{c.get('id')}": str(c.get("text") or "") for c in script.get("captions") or []}
    for s in script.get("scenes") or []:
        if s.get("caption"):
            out[f"scene:{s.get('sceneId')}"] = str(s["caption"])
    for f in POST_FIELDS:
        if post and post.get(f):
            out[f"post:{f}"] = str(post[f])
    return out


def restore(
    script: dict[str, Any], post: dict[str, str], base: dict[str, Any], base_post: dict[str, Any], refs: set[str]
) -> None:
    """Puts each text named in ``refs`` back as it was in ``base`` (the owner's words are never rewritten)."""
    base_caps = {str(c.get("id")): c for c in base.get("captions") or []}
    base_scenes = {str(s.get("sceneId")): s for s in base.get("scenes") or []}
    caps = {str(c.get("id")): c for c in script.get("captions") or []}
    for ref in refs:
        kind, _, ident = ref.partition(":")
        if kind == "caption" and ident in base_caps:
            if ident in caps:
                caps[ident]["text"] = base_caps[ident].get("text")
            else:
                script.setdefault("captions", []).append(dict(base_caps[ident]))
        elif kind == "scene" and ident in base_scenes:
            for s in script.get("scenes") or []:
                if s.get("sceneId") == ident:
                    s["caption"] = base_scenes[ident].get("caption")
        elif kind == "post" and ident in POST_FIELDS:
            post[ident] = str(base_post.get(ident) or "")
    script["captions"] = sorted(script.get("captions") or [], key=lambda c: float(c.get("at") or 0))
