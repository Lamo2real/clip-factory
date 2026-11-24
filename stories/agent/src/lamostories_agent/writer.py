"""The story writer's request and answer (docs/CONTRACTS.md §45.11.2): the prompt, the tool schema built from the
engine's catalog, and the code that turns an answer into a ``StoryScript``.

The writer only picks from the catalog and names characters by cast id; it never describes or changes how they look.
Code adds what is not the writer's to decide: the engine version, the story's own size (``story.format``, one of the
engine's six, 1080 × 1920 by default) at 30 fps, the seeds, the cast with its looks, faces and noises, the captions
switch, the music the owner picked and the safety sources. Every answer then goes through the engine's ``validate``,
``normalize`` and ``fit`` (pipeline.py); a character only makes the faces and noises in its own lists
(``cast_problems``, ``repair_cast``)."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from . import keys
from .guidance import Topic
from .series_memory import car_words

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
SIZES = {  # the engine's six sizes (§45.34 "Video size and shape"): resolution -> aspect
    (1080, 1920): "9:16",
    (720, 1280): "9:16",
    (1080, 1080): "1:1",
    (720, 720): "1:1",
    (1920, 1080): "16:9",
    (1280, 720): "16:9",
}
DEFAULT_SIZE = (1080, 1920)
DRIVING_ACTIONS = frozenset({"drive", "steer_left", "steer_right", "brake", "brace"})
VEHICLE_ACTIONS = frozenset({"move", "skid", "spin", "stop", "bump", "tyre_burst"})
VEHICLES = frozenset({"car", "truck"})

SYSTEM = """You write the storyboard of one short animated video for Clips Funded, a cartoon channel.

House rules (always):
- No voice-over and no spoken words. The story is told through movement, faces, body language, sound effects, the
  characters' non-verbal noises and music. Speech bubbles hold symbols only.
- The video's shape is the request's "format" (9:16 is vertical, 1:1 square, 16:9 wide); stage every scene for that
  frame. Scenes last 2 to 15 seconds; the whole video lands close to the target length.
- Recurring characters: use only the cast you are given, by cast id. Never describe or change how a character looks.
  Each cast member acts like its personality and traits, and its own sound moments use its favouriteEffects where
  they fit.
- A character only makes the faces in its faces list and only the noises in its noises list (a beat's "face" and
  "noise"). Use "neutral" when none of its faces fits.
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
- The engine's "rules" in the request say exactly what dir, rot, steering and a prop's state mean: follow them (a
  skid's dir is the side the car's rear slides to, and steering into it is the same side).
- Positions are 0..1 of the frame (x left to right, y top to bottom). A prop's "state" is free text; these mean
  something to the animator: cars and trucks "parked", "driving", "lights", "brakes", "flat"; an arrow "curve_left"
  or "curve_right"; a tree "pine" or "snow"; a phone "ring" or "on". An arrow points up at rot 0; a car seen from
  above ("top" view) points its nose up at rot 0 and turns clockwise as rot grows.
- Reference videos, when given, are other people's videos the owner liked: borrow only structure, timing and staging
  ideas from their analyses; never copy their characters, logos, footage, music or catchphrases.
- A cast member with kind "car" is a car, never an actor: put it in a scene's props as {kind: "car", castId}, and
  reach it in beats by its propId. People ride in it with inCar set to that propId. Its moves are prop actions (move,
  speed_up, stop, bounce, honk, blink, stall, skid). It makes faces only when its faces list has more than neutral.
- To show someone getting in or out, give them inCar and a get_in or get_out beat while the car is parked; the car
  moves only after get_in ends.
- The driver waves only while the car is stopped; a passenger may wave any time.
- In a story that is not a driving-safety one, a car may stall, stop or bump for fun, but no caption gives driving
  advice; if the story starts to teach it, set teachesSafety to true (see above). A story with a car of the cast is
  always fact checked for driving advice.
- There is no car dealer set: a story about buying a car stages the sale in the car park (parking_lot).
- When the request has a series, this video is its episode number `series.episode`: follow on from storySoFar and
  lastEpisodes (the same cast, places and running jokes, and where things stand now), never retell an earlier episode,
  and make it work on its own for someone who has not seen the others."""

# The night drive drawing style (§45.45): its house rules come after SYSTEM, which stays word for word. A request in
# the Bright style (classic) is the request it always was: no arts or shots lists, no shot rules, no cuts.
ARTS = ("night_drive", "classic")
NIGHT = "night_drive"
SHOT_RULES = ("shots", "shot_world")
NIGHT_LISTS = ("arts", "shots")
MAX_CUTS = 8

NIGHT_RULES = """House rules for this video's drawing style:
- This video is drawn in the night drive style. Car stories happen at night on highway_night or road_night unless
  the story needs day, snow, rain or a place indoors.
- Cut often, like a short film: a new shot every 2 to 4 seconds, as cuts inside a scene; the action and sound go on
  across a cut.
- Open a drive on road_wide or road_behind, then driver_view. Cut to face for each reaction (a new face or a noise).
  Use mirror when a car comes up behind, side_window when one is alongside, speed_dial when the car speeds up or
  slows down.
- Show the cast's car whole at least once: the whole scene or road_behind.
- Use pedals only on a brake beat that a guidance step gives, and never use speed_dial to teach a speed."""


DEFAULT_ART = NIGHT  # the workspace default for new videos (stories/config/workspace-defaults.json video.art)


def workspace_art(config: dict[str, Any] | None) -> str:
    """The workspace's drawing style for new videos (Settings › Video): its ``video.art``, else the default."""
    video = (config or {}).get("video")
    art = video.get("art") if isinstance(video, dict) else None
    return str(art) if art in ARTS else DEFAULT_ART


def art_of(item: Any) -> str:
    """A story's or a script's drawing style: ``night_drive`` only when it says so; anything else (an older story or
    script with none) is ``classic``."""
    return NIGHT if isinstance(item, dict) and item.get("art") == NIGHT else "classic"


def system_for(art: str | None) -> str:
    """The writer's system text: SYSTEM, and the night drive house rules after it for a night drive video."""
    return SYSTEM + "\n\n" + NIGHT_RULES if art == NIGHT else SYSTEM


def styled_request(lists: dict[str, Any], rules: dict[str, Any], art: str | None) -> dict[str, Any]:
    """The catalog lists and the engine's rules as the writer reads them in this drawing style: a Bright (classic)
    request leaves out the arts and shots lists and the two shot rules, so it is the request it was before them; a
    night drive request has them all and its ``art``."""
    if art == NIGHT:
        return {"catalog": lists, **rules, "art": NIGHT}
    kept = dict(rules)
    if isinstance(kept.get("rules"), list):
        kept["rules"] = [r for r in kept["rules"] if not (isinstance(r, dict) and r.get("id") in SHOT_RULES)]
    return {"catalog": {k: v for k, v in lists.items() if k not in NIGHT_LISTS}, **kept}


CAPTIONS_TEMPLATE = """You write the six post captions of one finished Clips Funded video (a short {shape} animated
story with no voice-over), from its script.

- youtubeTitle: at most 100 characters, no hashtags, makes people curious.
- youtubeDescription: two or three short lines{shorts}
- instagram, facebook, tiktok: one or two short lines with a few relevant hashtags.
- x: at most 200 characters.
- Plain, kind words for a general audience; never written for children; no false promises.
- For a driving-safety video every description names the sources the advice is based on (given below) and says
  "Check your local road rules."
- Keep every caption the owner wrote himself exactly as it is (listed under "keep")."""
SHAPES = {"9:16": "vertical", "1:1": "square", "16:9": "wide"}  # what the post captions call each shape (§45.35 D13)
SHORTS = re.compile(r"(?i)(?<![\w#])#shorts\b")


def captions_prompt(aspect: str = "9:16") -> str:
    """The captions call's rules for the video's own shape: only a vertical (9:16) video is a Short, so only its
    YouTube description ends with #shorts (§45.35 D13)."""
    shorts = ", ending with #shorts." if aspect == "9:16" else ". No #shorts: this video is not a Short."
    return CAPTIONS_TEMPLATE.format(shape=SHAPES.get(aspect, "vertical"), shorts=shorts)


CAPTIONS_PROMPT = captions_prompt("9:16")


def aspect_of(story_format: Any = None, script: dict[str, Any] | None = None) -> str:
    """The video's shape: the story's ``format.aspect``, else the script's own size, else 9:16 (§45.34)."""
    if isinstance(story_format, dict) and story_format.get("aspect") in SHAPES:
        return str(story_format["aspect"])
    size = (int((script or {}).get("width") or 1080), int((script or {}).get("height") or 1920))
    return SIZES.get(size, "9:16")


def shorts_tag(description: str, aspect: str) -> str:
    """The YouTube description with ``#shorts`` exactly when the video is vertical (9:16): added when it is missing,
    taken out of a square or wide video's (§45.35 D13)."""
    text = description.strip()
    if aspect == "9:16":
        return text if SHORTS.search(text) else f"{text} #shorts".strip()
    return re.sub(r"[ \t]{2,}", " ", SHORTS.sub("", text)).strip()


def catalog_ids(catalog: dict[str, Any], key: str) -> list[str]:
    return [str(e["id"]) for e in catalog.get(key) or [] if isinstance(e, dict) and e.get("id")]


def _enum(values: Sequence[str], *, nullable: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"type": ["string", "null"] if nullable else "string", "enum": list(values)}
    if nullable:
        out["enum"] = [*values, None]
    return out


def _num(lo: float, hi: float) -> dict[str, Any]:
    return {"type": "number", "minimum": lo, "maximum": hi}


def scene_schema(
    catalog: dict[str, Any],
    cast_ids: Sequence[str],
    scene_ids: Sequence[str] | None = None,
    car_ids: Sequence[str] = (),
    art: str | None = None,
) -> dict[str, Any]:
    """One scene; with ``scene_ids`` (a remake of named scenes) its ``sceneId`` is one of exactly those. ``cast_ids``
    are the people (the actors); ``car_ids`` the cast's cars (§45.43), reached only as a car prop's ``castId``: with
    none, the schema is exactly what it was before cars. ``art`` ``night_drive`` adds the scene's ``cuts`` between
    shots (§45.45); in the Bright style the schema is what it was before them."""
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
    prop: dict[str, Any] = {
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
    if car_ids:
        prop["properties"]["castId"] = {
            "type": ["string", "null"],
            "enum": [*car_ids, None],
            "description": "A car of the cast, on kind car only.",
        }
    out: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "required": ["sceneId", "title", "durationSec", "set", "view", "camera", "actors", "props", "beats", "caption"],
        "properties": {
            "sceneId": (
                {**_enum(list(scene_ids)), "description": "One of the scenes you were asked to remake."}
                if scene_ids
                else {"type": "string", "maxLength": 24, "description": "Short and unique: s1, s2, ..."}
            ),
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
    if art == NIGHT:
        cut = {
            "type": "object",
            "additionalProperties": False,
            "required": ["at", "shot"],
            "properties": {
                "at": _num(0, 15),
                "shot": _enum(catalog_ids(catalog, "shots")),
                "who": {"type": ["string", "null"], "description": "Whose face or whose car; left out: the driver."},
            },
        }
        out["properties"]["cuts"] = {
            "type": ["array", "null"],
            "maxItems": MAX_CUTS,
            "items": cut,
            "description": "Cuts to other shots, seconds from the scene's start, at least 0.6 s apart.",
        }
    return out


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
    catalog: dict[str, Any],
    cast_ids: Sequence[str],
    topic_ids: Sequence[str],
    *,
    mode: str,
    scene_ids: Sequence[str] | None = None,
    car_ids: Sequence[str] = (),
    art: str | None = None,
) -> dict[str, Any]:
    """The ``write_storyboard`` tool's input schema (``car_ids``: the cast's cars, §45.43; ``art``: the drawing style,
    night drive adds each scene's cuts, §45.45). ``full``: the whole story; ``scenes``: only the named scenes
    (``scene_ids``: each answer scene's id is one of them, and there are exactly as many scenes as asked, §45.34) and,
    if they change, the whole captions list; ``fix``: the whole story again with the facts fixed."""
    asked = list(dict.fromkeys(str(s) for s in scene_ids or [])) if mode == "scenes" else []
    scenes: dict[str, Any] = {
        "type": "array",
        "minItems": len(asked) or 1,
        "maxItems": len(asked) or MAX_SCENES,
        "items": scene_schema(catalog, cast_ids, asked or None, car_ids, art),
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
    aspect: str | None = None,
) -> list[dict[str, Any]]:
    """The ``captions`` call's message: the video's shape (``aspect``, else the script's size), the final script
    without looks, the sources of a safety story and the owner's own captions to keep."""
    shape = aspect if aspect in SHAPES else aspect_of(None, script)
    body: dict[str, Any] = {
        "story": concept or {"title": script.get("title")},
        "format": {"aspect": shape, "shape": SHAPES[shape]},
        "script": without_looks(script),
        "sources": [c.get("publisher") for c in topic.citations] if topic else None,
        "keep": keep,
    }
    return [
        {
            "role": "user",
            "content": [
                {"text": captions_prompt(shape)},
                {"text": "The video, as JSON:\n" + json.dumps(body, ensure_ascii=False, separators=(",", ":"))},
            ],
        }
    ]


CAR_SEATS = 2  # the engine's car seats (engine/car.ts CAR_SEATS): the first rider drives


def cast_brief(
    cast: dict[str, dict[str, Any]],
    characters: dict[str, dict[str, Any]],
    cars: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """What the writer may know of each cast member: never the look. Its faces and noises are the ones the script's
    cast carries (the character's own lists), the only ones it may make. People come first (``kind`` person, the first
    one ``main``), then the cast's cars (§45.43): a car is a prop only, described in words."""
    out: list[dict[str, Any]] = []
    for cid, member in cast.items():
        ch = characters.get(str(member.get("characterId"))) or {}
        voice = member.get("voice") or {}
        faces = member.get("expressions") if isinstance(member.get("expressions"), list) else ch.get("expressions")
        out.append(
            {
                "castId": cid,
                "name": member.get("name"),
                "personality": ch.get("personality") or "",
                "description": ch.get("description") or "",
                "traits": ch.get("traits") or [],
                "movementStyle": member.get("movementStyle"),
                "faces": list(faces or []),
                "noises": voice.get("noises") or [],
                "favouriteEffects": voice.get("sfx") or [],
                "kind": "person",
                "main": not out,
            }
        )
    for cid, member in (cars or {}).items():
        ch = characters.get(str(member.get("characterId"))) or {}
        voice = member.get("voice") or {}
        faces = member.get("expressions") if isinstance(member.get("expressions"), list) else ch.get("expressions")
        out.append(
            {
                "castId": cid,
                "name": member.get("name"),
                "kind": "car",
                "main": False,
                "personality": ch.get("personality") or "",
                "description": ch.get("description") or "",
                "traits": ch.get("traits") or [],
                "movementStyle": member.get("movementStyle"),
                "faces": list(faces or ["neutral"]),
                "favouriteEffects": voice.get("sfx") or [],
                "car": car_words(member.get("car")),
                "seats": CAR_SEATS,
                "propOnly": True,
            }
        )
    return out


def cast_ids_of(brief: Sequence[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """(the people's cast ids, the cars' cast ids) of a ``cast_brief``: actors are people only."""
    people = [str(c["castId"]) for c in brief if c.get("kind") != "car"]
    cars = [str(c["castId"]) for c in brief if c.get("kind") == "car"]
    return people, cars


def without_looks(script: dict[str, Any]) -> dict[str, Any]:
    """A script as the writer may see it: the cast (and its cars) by id, name and movement style only, never the
    looks."""
    cast = {
        cid: {"name": (m or {}).get("name"), "movementStyle": (m or {}).get("movementStyle")}
        for cid, m in (script.get("cast") or {}).items()
    }
    out = {**script, "cast": cast}
    if script.get("cars"):
        out["cars"] = {
            cid: {"name": (m or {}).get("name"), "movementStyle": (m or {}).get("movementStyle"), "kind": "car"}
            for cid, m in (script.get("cars") or {}).items()
        }
    return out


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


def post_captions(raw: dict[str, Any] | None, topic: Topic | None, aspect: str = "9:16") -> dict[str, str]:
    """The six post captions within each platform's limit; a safety story's descriptions name its sources; only a
    vertical (9:16) video's YouTube description carries #shorts (§45.35 D13)."""
    raw = raw or {}
    out = {f: str(raw.get(f) or "").strip() for f in POST_FIELDS}
    out["youtubeDescription"] = shorts_tag(out["youtubeDescription"], aspect)
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
    size: tuple[int, int] = DEFAULT_SIZE,
    cars: dict[str, dict[str, Any]] | None = None,
    art: str | None = None,
) -> dict[str, Any]:
    """A whole ``StoryScript`` from a ``full`` (or ``fix``) answer, at the story's own size; the cast's cars
    (§45.43) are stored in ``cars`` only when there are any, so a people-only script is as before; ``art`` is written
    only for the night drive style (§45.45), so a Bright script is as before."""
    used: set[str] = set()
    scenes = [clean_scene(s, used, i) for i, s in enumerate(answer.get("scenes") or [])]
    width, height = size if size in SIZES else DEFAULT_SIZE
    script: dict[str, Any] = {
        "engine": engine_version,
        "fps": 30,
        "width": width,
        "height": height,
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
    if cars:
        script["cars"] = cars
    if art == NIGHT:
        script["art"] = NIGHT
    return script


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
    seeds: dict[str, int] | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """The old script with only ``scene_ids`` replaced by the answer's scenes (same ids and places). A new take keeps
    each scene's length. A remade scene has no seed here, so ``normalizeScript`` treats it as new (it gets the place's
    ambient sounds); the pipeline gives it its new seed after normalizing (``reseed``, §45.34). ``seeds`` sets them
    now instead (only for a script that is not normalized again). Returns the script and what is missing from the
    answer."""
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
            fresh.pop("seed", None)
            if seeds and sid in seeds:
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


def missing_sentence(missing: Sequence[str], asked: Sequence[str]) -> str:
    """What the writer is told when its remake left out asked scenes (it is asked once more, §45.34)."""
    return (
        f"Your answer left out these scenes: {', '.join(missing)}. Answer with exactly these scenes, each with its "
        f"own id: {', '.join(asked)}."
    )


def size_of(story: dict[str, Any], config: dict[str, Any] | None = None) -> tuple[int, int]:
    """The story's own size (``story.format``, set from the workspace default at create), else the workspace's
    ``video.resolution``, else 1080 × 1920. Only the engine's six sizes are used."""
    fmt = story.get("format")
    if isinstance(fmt, dict):
        try:
            got = (int(fmt.get("width") or 0), int(fmt.get("height") or 0))
        except (TypeError, ValueError):
            got = (0, 0)
        if got in SIZES:
            return got
    raw = str(((config or {}).get("video") or {}).get("resolution") or "")
    w, _, h = raw.partition("x")
    if w.isdigit() and h.isdigit() and (int(w), int(h)) in SIZES:
        return int(w), int(h)
    return DEFAULT_SIZE


def format_of(size: tuple[int, int]) -> dict[str, Any]:
    width, height = size
    return {"aspect": SIZES.get(size, "9:16"), "width": width, "height": height}


def _own_lists(member: dict[str, Any]) -> tuple[set[str] | None, set[str] | None]:
    """A cast member's faces and noises, or None for a list it does not carry (a script saved before cast members
    carried their expressions: nothing is limited there)."""
    faces = member.get("expressions")
    if not isinstance(faces, list):
        return None, None
    voice = member.get("voice") if isinstance(member.get("voice"), dict) else {}
    noises = voice.get("noises") if isinstance(voice, dict) else None
    return {str(f) for f in faces}, ({str(n) for n in noises} if isinstance(noises, list) else None)


def cast_problems(script: dict[str, Any]) -> list[str]:
    """Each beat whose face is not one of its character's faces, or whose noise is not one of its noises (§45.34),
    as one sentence the writer can fix."""
    cast = script.get("cast") or {}
    out: list[str] = []
    for scene in script.get("scenes") or []:
        for i, beat in enumerate(scene.get("beats") or []):
            member = cast.get(beat.get("who"))
            if not isinstance(member, dict):
                continue
            faces, noises = _own_lists(member)
            name = str(member.get("name") or beat.get("who"))
            where = f"scene {scene.get('sceneId')} beat {i + 1} ({beat.get('who')})"
            face, noise = beat.get("face"), beat.get("noise")
            if faces is not None and face is not None and face not in faces:
                out.append(
                    f"{where}: face {face!r} is not one of {name}'s faces; use one of {', '.join(sorted(faces))}."
                )
            if noises is not None and noise is not None and noise not in noises:
                allowed = ", ".join(sorted(noises)) or "none"
                out.append(f"{where}: noise {noise!r} is not one of {name}'s noises; use one of {allowed}.")
    return out


_CAST_WORDS = re.compile(r"\b(face|faces|noise|noises)\b", re.I)


def only_cast_problems(errors: Sequence[str]) -> bool:
    """Whether every problem left is about a character's faces or noises (what ``repair_cast`` can mend)."""
    return bool(errors) and all(_CAST_WORDS.search(str(e)) for e in errors)


def repair_cast(script: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The script with each stray face swapped for ``neutral`` and each stray noise dropped (the last resort after the
    writer was asked once more, §45.34). Returns the script and what was changed."""
    out = json.loads(json.dumps(script))
    cast = out.get("cast") or {}
    changed: list[str] = []
    for scene in out.get("scenes") or []:
        for i, beat in enumerate(scene.get("beats") or []):
            member = cast.get(beat.get("who"))
            if not isinstance(member, dict):
                continue
            faces, noises = _own_lists(member)
            where = f"{scene.get('sceneId')}.{i + 1}"
            if faces is not None and beat.get("face") is not None and beat["face"] not in faces:
                changed.append(f"{where} face {beat['face']} -> neutral")
                beat["face"] = "neutral"
            if noises is not None and beat.get("noise") is not None and beat["noise"] not in noises:
                changed.append(f"{where} noise {beat['noise']} dropped")
                del beat["noise"]
    return out, changed
