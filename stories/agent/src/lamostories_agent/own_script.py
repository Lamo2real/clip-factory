"""Write it myself: the owner's own script, staged and never written (docs/CONTRACTS.md §45.46, ADR-95).

The owner wrote what happens, scene by scene, and the words on screen. The storyboard agent does not write a story for
such a video: a **faithful adapter** stages it for the engine (the writer's ``animation_plan`` task, with the strict
rules below), one scene per script scene, and code, never a model, puts the owner's caption words on screen as cues
``w_sN``. A **code check** (``own_problems``) then proves the staging kept the script: the scenes and their order, who
is in each scene and where it happens, the caption words, every piece of each "What happens" tied to something drawn,
and nothing added beyond small gap fillers. The adapter is asked once more with the exact problems; if it still fails
the video stops with an honest sentence that names the scene (``keys.OWN_*``) and nothing is saved.

Pure: no I/O and no model. The pipeline (``StoryJob._storyboard_own``) and the writer provider use it."""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, NamedTuple

from . import keys, writer

MAX_SCENES = 12
MIN_SCENES = 2
MAX_WHAT = 160
MAX_CAPTION = 60
MAX_PIECES = 12
MAX_NOTE = 200
CUE_PREFIX = "w_"
OWN_REF = "own:"
WINDOW_TOLERANCE = 0.05
READING_SHARE = 0.9  # a scene with words lasts at least 90 % of their reading time after fitting

# The engine's actions (web/src/stories/engine/catalog.ts CATALOG.actions and .propActions; test_own_script checks
# the copy). A beat no piece of "What happens" names may only do one of FILLER: a small gap filler, never an event.
ACTIONS = (
    "idle", "walk", "run", "jump", "wave", "point", "shrug", "facepalm", "celebrate", "cower", "sit", "drive",
    "steer_left", "steer_right", "brake", "brace", "look_left", "look_right", "nod", "shake_head", "thumbs_up", "slip",
    "fall", "get_up", "dance", "think", "gesture", "gasp", "get_in", "get_out",
)  # fmt: skip
PROP_ACTIONS = (
    "move", "skid", "spin", "stop", "bump", "tyre_burst", "appear", "vanish", "wobble", "flash", "speed_up", "bounce",
    "honk", "blink", "stall",
)  # fmt: skip
FILLER = frozenset({"idle", "look_left", "look_right", "nod", "gesture"})

# Capitalised words that are not names (the web's own list, studio/ownScript.ts): a name the cast does not have is
# asked about there; here it only decides which sentence the owner reads when such a name could not be drawn.
COMMON_WORDS = frozenset(
    (
        "the", "then", "he", "she", "they", "it", "i", "oh", "no", "yes", "suddenly", "later", "scene", "shot", "a",
        "an", "and", "but", "so", "or", "when", "while", "after", "before", "now", "next", "finally", "first", "last",
        "at", "in", "on", "of", "to", "from", "with", "by", "for", "his", "her", "their", "its", "our", "my", "your",
        "we", "you", "us", "them", "him", "me", "everyone", "everybody", "someone", "somebody", "nobody", "nothing",
        "something", "meanwhile", "there", "here", "this", "that", "these", "those", "what", "why", "how", "who",
        "where", "which", "one", "two", "three", "ok", "okay", "wow", "hey", "hi", "hello", "bye", "goodbye",
        "please", "thanks", "thank", "sorry", "uh", "um", "hmm", "yay", "oops", "ouch", "phew", "mum", "mom", "dad",
        "mummy", "daddy", "grandma", "grandpa", "today", "tomorrow", "yesterday", "morning", "evening", "night",
        "day", "caption", "words", "text", "on-screen", "end", "the-end", "soon", "once", "outside", "inside", "back",
        "home", "school", "work", "up", "down", "out", "all", "both", "every", "each", "some", "many", "more",
        "again", "still", "just", "very", "too", "not", "never", "always", "maybe", "if", "because", "until", "as",
        "like", "big", "little", "small", "new", "old", "good", "bad", "happy", "sad",
    )
)  # fmt: skip
_WORD = re.compile(r"[^\W\d_][\w'’-]*")


class Problem(NamedTuple):
    """One break of the owner's script: the scene's number (1-based), a precise sentence for the adapter's retry and
    the owner's sentence (§45.46.4). ``key`` names the rule (``OWN_LOST``, …); ``reading`` marks a reading-time problem,
    shown to the owner only when nothing else is left."""

    scene_no: int
    for_model: str
    for_owner: str
    key: str = ""
    reading: bool = False


# --- the owner's script -------------------------------------------------------------------------------------------


def scenes_of(value: Any) -> list[dict[str, Any]]:
    """The owner's scenes, in order, from a story (``ownScript``), an ``OwnScript`` or its list: each with its
    ``sceneId`` (the API gives ``s1..sN`` on every save; positional when missing), ``what`` and ``caption`` exactly as
    stored (an empty caption is no caption), ``who`` (characterIds), ``place`` and ``leaveOut``. Empty when there is
    none: a story made by the AI writer."""
    if isinstance(value, Mapping):  # a story (only its ownScript counts, never its own scenes list) or an OwnScript
        value = value.get("ownScript") if "ownScript" in value or set(value) - {"scenes"} else value
    if isinstance(value, Mapping):
        value = value.get("scenes")
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    used: set[str] = set()
    for i, raw in enumerate(value):
        if not isinstance(raw, Mapping):
            continue
        sid = str(raw.get("sceneId") or "")
        if not keys.SCENE_ID.match(sid) or sid in used:
            sid = f"s{i + 1}"
        used.add(sid)
        caption = raw.get("caption")
        place = raw.get("place")
        out.append(
            {
                "sceneId": sid,
                "what": str(raw.get("what") or ""),
                "caption": caption if isinstance(caption, str) and caption.strip() else None,
                "who": list(dict.fromkeys(str(c) for c in raw.get("who") or [] if isinstance(c, str) and c)),
                "place": place if isinstance(place, str) and place else None,
                "leaveOut": [str(n) for n in raw.get("leaveOut") or [] if isinstance(n, str) and n.strip()],
            }
        )
    return out


def need(caption: str | None) -> float:
    """A scene's reading time in seconds (§45.46.4): with words ``min(15, max(3, 2 + len / 15))``, else 3."""
    if not caption:
        return 3.0
    return min(15.0, max(3.0, 2 + len(caption) / 15))


def default_length(scenes: Sequence[Mapping[str, Any]]) -> int:
    """The length the API and the web pick when the owner picks none (§45.46.4)."""
    n = len(scenes)
    total = sum(need(s.get("caption")) for s in scenes)
    return int(max(15, min(90, 15 * n, 5 * math.ceil(max(total, 5 * n) / 5))))


def target(duration_sec: Any, scenes: Sequence[Mapping[str, Any]]) -> float:
    """The adapter's fit target (§45.46.4): the story's length kept between every scene's reading time (at least 15 s)
    and 15 s a scene (at most 89.5 s). With 2 scenes or more the low end is never above the high end."""
    n = max(1, len(scenes))
    lo = max(15.0, sum(need(s.get("caption")) for s in scenes))
    hi = min(writer.MAX_SECONDS, 15.0 * n)
    try:
        want = float(duration_sec)
    except (TypeError, ValueError):
        want = float(default_length(scenes))
    if not math.isfinite(want) or want <= 0:
        want = float(default_length(scenes))
    return round(max(lo, min(hi, want)), 2)


def texts(own: Any) -> list[str]:
    """Every text the owner wrote (each scene's what and caption), in order: what the API matches the topic over."""
    out: list[str] = []
    for s in scenes_of(own):
        out.append(s["what"])
        if s["caption"]:
            out.append(s["caption"])
    return out


def concept(story: Mapping[str, Any]) -> dict[str, Any]:
    """What the post captions are told of an owner's story: its title, its kind and its scenes as written."""
    out = {"title": story.get("title"), "category": story.get("category"),
           "scenes": [s["what"] for s in scenes_of(story)]}  # fmt: skip
    return {k: v for k, v in out.items() if v is not None}


def post_texts(post: Mapping[str, Any] | None) -> dict[str, str]:
    """The texts the AI wrote on an owner's video: the post captions only, never the owner's words."""
    return {f"post:{f}": str(post[f]) for f in writer.POST_FIELDS if post and post.get(f)}


def has_words(story: Mapping[str, Any]) -> bool:
    return any(s["caption"] for s in scenes_of(story))


def norm(value: Any) -> str:
    """NFC, lower case, every character that is not a letter or digit a space, spaces collapsed, ends trimmed."""
    text = unicodedata.normalize("NFC", str(value or "")).lower()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text).split())


def same_words(a: Any, b: Any) -> bool:
    """The owner's words, compared exactly: case, punctuation and emoji count; only NFC and runs of spaces may differ
    (so a space or a composed letter never refuses a video). Code copies the words as typed, so this only guards
    against a later step changing them."""

    def flat(value: Any) -> str:
        return " ".join(unicodedata.normalize("NFC", str(value or "")).split())

    return flat(a) == flat(b)


def short(words: Any, limit: int = 40) -> str:
    """At most ``limit`` characters of the words, with "…" when cut (only in messages, never in the video)."""
    text = " ".join(str(words or "").split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


def label(what: str, limit: int = 40) -> str:
    """A scene's label (``Scene.title``): the first words of what happens, cut at a word to ``limit`` with "…"."""
    text = " ".join(str(what or "").split())
    if len(text) <= limit:
        return text or "Scene"
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,.;:!?-") + "…"


def _cut(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,.;:") + "…"


def _has_name(words: str, name: str) -> bool:
    name = " ".join(str(name or "").split())
    if not name:
        return False
    return re.search(r"(?<!\w)" + re.escape(name) + r"(?!\w)", words, re.IGNORECASE) is not None


def names_in(words: str, names: Mapping[str, str]) -> list[str]:
    """The cast keys whose names are in ``words``, as whole words, whatever the case."""
    return [k for k, n in names.items() if _has_name(words, n)]


def unknown_name(
    words: str, names: Iterable[str], answered: Iterable[str] = (), places: Iterable[str] = ()
) -> str | None:
    """The first capitalised word that looks like a name nobody gave: not a common word, not a place word, not a cast
    name and not one the owner left out (the web asks "Who is Max?" for it first)."""
    known = {n.lower() for n in [*names, *answered]}
    known_words = {w for n in known for w in n.split()}
    place_words = {w.lower() for p in places for w in str(p).split()}
    for m in _WORD.finditer(words):
        word = re.sub(r"['’]s$", "", m.group(0))
        if not word[:1].isupper():
            continue
        low = word.lower()
        if low in COMMON_WORDS or low in known or low in known_words or low in place_words:
            continue
        return word
    return None


# --- the request, the schema and the prompt -------------------------------------------------------------------------


def cast_map(
    cast: Mapping[str, Mapping[str, Any]], cars: Mapping[str, Mapping[str, Any]] | None = None
) -> dict[str, str]:
    """characterId -> cast key (``c1``…), for the people and the cars of the cast the script is staged with."""
    out: dict[str, str] = {}
    for key, member in [*cast.items(), *(cars or {}).items()]:
        cid = (member or {}).get("characterId")
        if isinstance(cid, str) and cid and cid not in out:
            out[cid] = str(key)
    return out


def request_scenes(own: Sequence[Mapping[str, Any]], castmap: Mapping[str, str]) -> list[dict[str, Any]]:
    """The owner's scenes as the adapter reads them: never the caption words (code places them), only whether there
    are any and how long the scene must last for them."""
    return [
        {
            "sceneId": s["sceneId"],
            "what": s["what"],
            "hasCaption": bool(s["caption"]),
            "who": [castmap[c] for c in s.get("who") or [] if c in castmap],
            "place": s.get("place"),
            "leaveOut": list(s.get("leaveOut") or []),
            "minSec": round(need(s["caption"]), 1),
        }
        for s in own
    ]


RULES = """This time the owner wrote the story. You do not write it: you stage it for the engine.
"ownScript" is the owner's script: scenes in order, each with what happens ("what"), who is in it ("who", cast ids),
the place ("place", a set id) and the names the owner left out ("leaveOut"). These rules win over anything above:
- Make exactly one scene for each script scene, in the same order, with the same sceneId. Never add, drop, merge,
  split or reorder scenes.
- Show what "what" says, and only that. You choose only what the engine needs to show it: camera, view, positions,
  timing, poses, faces, the characters' own noises, sound effects, props that set the scene, and cuts in the night
  drive style. Never add an event, a character, a twist, a lesson or an ending the owner did not write. Where the
  owner shows a mistake, faces and sounds may show that it is a mistake.
- In "shows", split each scene's "what" into pieces, copying its words exactly and in order, so that together they
  are the whole "what". For each piece, name what shows it: beat numbers (0-based, this scene's beats), effect
  numbers, "place" or "camera". A piece you can only show roughly gets "closest": a few words on how it is drawn. A
  piece you cannot show at all gets "notShown": true and "why".
- A beat that no piece names may only be idle, look_left, look_right, nod or gesture. Every prop action belongs to a
  piece.
- "who" given: exactly those cast members are in the scene (people as actors, a car of the cast as its car prop).
  Not given: pick them from the cast by the names in "what". Never draw anyone who is not in the cast. A name in
  "what" that is not in the cast is notShown, unless it is in "leaveOut".
- "place" given: use that set. Not given: the set the words name, else the closest one, and say so in "closest".
- Write no caption: every scene's caption is null and there is no captions list. Code puts the owner's words on
  screen exactly as written. Each scene lasts at least its "minSec"; the whole video lands on "targetSec".
- The series memory, when given, keeps things consistent (the same places, running jokes, where things stand). Never
  use it to add or change an event.
- Reference videos, when given, lend timing and staging ideas only. Never copy their characters or footage.
- Stage driving exactly as the owner wrote it, even where the checked guidance says otherwise: never correct it
  yourself, because the fact check reports it to the owner. When a scene's words state a guidance step, put that
  step id in the scene's "guidanceRef". If any scene teaches driving or road safety, set teachesSafety to true and
  pick the closest topic id, or null."""


def instructions(mode: str, scene_ids: Sequence[str] = (), problems: Sequence[str] | None = None) -> str:
    """What this call asks: the whole script (``own``) or a new take of some scenes (``own_scenes``); the retry also
    names the rules the last staging broke."""
    if mode == "own_scenes":
        text = (
            f"Stage a new take of only these scenes: {', '.join(scene_ids)}. Keep each scene's pieces, cast, place and "
            "length; make the camera, positions and timing different. Answer with those scenes only, with the same ids."
        )
    else:
        text = "Stage the owner's whole script."
    if problems:
        text += "\n\nYour last staging broke these rules. Fix exactly these:\n" + "\n".join(f"- {p}" for p in problems)
    return text


_INDEX = {"type": "array", "maxItems": 14, "items": {"type": "integer", "minimum": 0, "maximum": 13}}
SHOW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["words", "beats", "sfx", "place", "camera", "closest", "notShown", "why"],
    "properties": {
        "words": {
            "type": "string",
            "maxLength": MAX_WHAT,
            "description": "A piece of the scene's what, copied exactly.",
        },
        "beats": {**_INDEX, "description": "The numbers (0-based) of this scene's beats that show this piece."},
        "sfx": {**_INDEX, "description": "The numbers of this scene's beats whose sound effect shows this piece."},
        "place": {"type": "boolean", "description": "The scene's set shows this piece."},
        "camera": {"type": "boolean", "description": "The scene's camera or view shows this piece."},
        "closest": {
            "type": ["string", "null"],
            "maxLength": 60,
            "description": 'Only when it is shown roughly: how it is drawn, as words after "is", e.g. "in the Park".',
        },
        "notShown": {"type": "boolean", "description": "True only when nothing can show this piece."},
        "why": {"type": ["string", "null"], "maxLength": 80, "description": "Why it is not shown, or null."},
    },
}


def schema(
    catalog: dict[str, Any],
    cast_ids: Sequence[str],
    car_ids: Sequence[str] = (),
    *,
    scene_ids: Sequence[str],
    topic_ids: Sequence[str] = (),
    shown: Sequence[str] = (),
    art: str | None = None,
    mode: str = "own",
) -> dict[str, Any]:
    """The adapter's answer (§45.46.6): the writer's staging fields of each scene (no title, caption or note: code sets
    them), with ``sceneId`` one of the asked ids, ``guidanceRef`` (a shown step of the story's topic, or null) and
    ``shows`` (the pieces of what happens and what shows each). There is no captions list: the model cannot write
    captions. ``own``: exactly one scene per script scene; ``own_scenes``: exactly the asked ones."""
    asked = list(dict.fromkeys(str(s) for s in scene_ids))
    base = writer.scene_schema(catalog, cast_ids, asked or None, car_ids, art)
    props = {k: v for k, v in base["properties"].items() if k not in ("title", "caption", "note")}
    props["sceneId"] = {"type": "string", "enum": asked, "description": "The script scene's own id."}
    props["guidanceRef"] = {
        "type": ["string", "null"],
        "enum": [*dict.fromkeys(str(s) for s in shown), None],
        "description": "The checked guidance step this scene's words state, or null.",
    }
    props["shows"] = {"type": "array", "minItems": 1, "maxItems": MAX_PIECES, "items": SHOW_SCHEMA}
    required = [k for k in base["required"] if k not in ("title", "caption", "note")] + ["guidanceRef", "shows"]
    scene = {**base, "properties": props, "required": required}
    scenes = {"type": "array", "minItems": len(asked), "maxItems": len(asked), "items": scene}
    if mode == "own_scenes":
        return {
            "type": "object",
            "additionalProperties": False,
            "required": ["scenes"],
            "properties": {"scenes": scenes, "teachesSafety": {"type": ["boolean", "null"]}},
        }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["teachesSafety", "safetyTopicId", "scenes"],
        "properties": {
            "teachesSafety": {"type": "boolean"},
            "safetyTopicId": {"type": ["string", "null"], "enum": [*topic_ids, None]},
            "scenes": scenes,
            "music": {
                "type": ["object", "null"],
                "additionalProperties": False,
                "required": ["volume"],
                "properties": {"volume": {"type": "number", "minimum": 0, "maximum": 1}},
            },
        },
    }


# --- code builds the script -----------------------------------------------------------------------------------------


def _pieces(scene: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(p) for p in scene.get("shows") or [] if isinstance(p, Mapping)]


def note_for(answer_scene: Mapping[str, Any], own_scene: Mapping[str, Any]) -> str | None:
    """The scene's note, written by code (never by the model): the pieces drawn a bit differently and the names the
    owner left out, at most 200 characters."""
    parts: list[str] = []
    rough = [
        f"“{short(p.get('words'))}” is {' '.join(str(p['closest']).split()).rstrip('.')}"
        for p in _pieces(answer_scene)
        if isinstance(p.get("closest"), str) and p["closest"].strip() and not p.get("notShown")
    ]
    if rough:
        parts.append("Drawn a bit differently: " + "; ".join(rough) + ".")
    left = [" ".join(n.split()) for n in own_scene.get("leaveOut") or [] if n.strip()]
    if left:
        parts.append("Not drawn: " + ", ".join(dict.fromkeys(left)) + ".")
    return _cut(" ".join(parts), MAX_NOTE) if parts else None


def drawn_differently(answer: Mapping[str, Any]) -> int:
    """How many scenes have a piece drawn a bit differently (the step's done message)."""
    return sum(
        1
        for s in answer.get("scenes") or []
        if isinstance(s, Mapping)
        and any(
            isinstance(p.get("closest"), str) and p["closest"].strip() and not p.get("notShown") for p in _pieces(s)
        )
    )


def staged(
    answer: Mapping[str, Any], own: Sequence[Mapping[str, Any]], *, min_sec: bool = True
) -> list[dict[str, Any]]:
    """The answer's scenes as engine scenes, in the owner's order (one per script scene the answer has): the title a
    label of what happens, no caption, the note by code, no ``shows`` or ``guidanceRef`` (they stay in the answer for
    the check). ``min_sec``: a scene shorter than its reading time is made that long (timing is the AI's gap, the
    owner's words need it); beats stay inside the longer scene."""
    got: dict[str, Mapping[str, Any]] = {}
    for s in answer.get("scenes") or []:
        if isinstance(s, Mapping) and str(s.get("sceneId")) not in got:
            got[str(s.get("sceneId"))] = s
    out: list[dict[str, Any]] = []
    for o in own:
        raw = got.get(o["sceneId"])
        if raw is None:
            continue
        scene = {k: v for k, v in raw.items() if k not in ("shows", "guidanceRef", "title", "caption", "note")}
        scene["sceneId"] = o["sceneId"]
        scene["title"] = label(o["what"])
        scene["caption"] = None
        scene["note"] = note_for(raw, o)
        if min_sec:
            scene["durationSec"] = round(min(15.0, max(_num(scene.get("durationSec")), need(o["caption"]))), 2)
        out.append(scene)
    return out


def guidance_refs(answer: Mapping[str, Any], shown: Iterable[str]) -> dict[str, str]:
    """sceneId -> the shown guidance step the adapter said the scene's words state."""
    ok = set(shown)
    return {
        str(s.get("sceneId")): str(s["guidanceRef"])
        for s in answer.get("scenes") or []
        if isinstance(s, Mapping) and isinstance(s.get("guidanceRef"), str) and s["guidanceRef"] in ok
    }


def owner_cues(
    script: Mapping[str, Any],
    own: Sequence[Mapping[str, Any]],
    *,
    refs: Mapping[str, str] | None = None,
    keep_from: Mapping[str, Any] | None = None,
    extra_ids: Iterable[str] = (),
    keep_timing: bool = False,
) -> list[dict[str, Any]]:
    """The video's caption cues, built by code (§45.46.4): one ``w_sN`` per scene with words, exactly as written, from
    0.25 s after its scene starts to 0.25 s before it ends (``refs``: its guidance step). ``keep_from``: an earlier
    script whose cues the owner added in the caption editor (``extra_ids``, never ``w_``) stay, inside the video;
    with ``keep_timing`` (a new take keeps each scene's length) its ``w_`` cue timing stays too while it still lies
    inside its scene."""
    windows = writer.scene_windows(dict(script))
    total = sum(hi - lo for lo, hi in windows.values())
    old = {str(c.get("id")): c for c in (keep_from or {}).get("captions") or [] if isinstance(c, Mapping)}
    out: list[dict[str, Any]] = []
    for o in own:
        sid = o["sceneId"]
        if not o["caption"] or sid not in windows:
            continue
        lo, hi = windows[sid]
        cue_id = CUE_PREFIX + sid
        at, dur = round(lo + 0.25, 3), round(max(0.3, hi - lo - 0.5), 3)
        prev = old.get(cue_id) if keep_timing else None
        if prev is not None:
            p_at, p_dur = _num(prev.get("at"), -1.0), _num(prev.get("dur"))
            if lo - WINDOW_TOLERANCE <= p_at and p_at + p_dur <= hi + WINDOW_TOLERANCE and p_dur >= 0.3:
                at, dur = p_at, p_dur
        cue: dict[str, Any] = {"id": cue_id, "at": at, "dur": dur, "text": o["caption"]}
        if refs and refs.get(sid):
            cue["guidanceRef"] = refs[sid]
        out.append(cue)
    extra = {str(i) for i in extra_ids}
    for cid, c in old.items():
        if cid in extra and not cid.startswith(CUE_PREFIX) and total > 0.3 and isinstance(c.get("text"), str):
            try:
                at = min(max(0.0, float(c.get("at") or 0)), round(total - 0.3, 3))
                dur = max(0.3, min(float(c.get("dur") or 0.3), round(total - at, 3)))
            except (TypeError, ValueError):
                continue
            out.append({**dict(c), "at": at, "dur": dur})
    return sorted(out, key=lambda c: float(c["at"]))


def script_from_own(
    answer: dict[str, Any],
    own: Sequence[Mapping[str, Any]],
    *,
    title: str,
    engine_version: int,
    seed: int,
    cast: dict[str, dict[str, Any]],
    captions_on: bool,
    music: dict[str, Any] | None,
    topic: Any,
    size: tuple[int, int] = writer.DEFAULT_SIZE,
    cars: dict[str, dict[str, Any]] | None = None,
    art: str | None = None,
    keep_from: Mapping[str, Any] | None = None,
    extra_ids: Iterable[str] = (),
) -> dict[str, Any]:
    """A whole ``StoryScript`` from the adapter's answer (§45.46.6): what ``writer.script_from`` builds (cast, cars,
    engine, size, seed, music, captions switch, safety, art), the story's own title, the scenes in the owner's order
    and the owner's caption cues. Scene captions are always null; the cues are always built (``captionsOn`` decides
    whether they are burned in)."""
    script = writer.script_from(
        {"scenes": staged(answer, own)},
        title=title,
        engine_version=engine_version,
        seed=seed,
        cast=cast,
        captions_on=captions_on,
        music=music,
        topic=topic,
        size=size,
        cars=cars,
        art=art,
    )
    shown = topic.shown_ids if topic is not None else set()
    script["captions"] = owner_cues(
        script, own, refs=guidance_refs(answer, shown), keep_from=keep_from, extra_ids=extra_ids
    )
    return script


def merged_take(
    old: dict[str, Any],
    answer: dict[str, Any],
    own: Sequence[Mapping[str, Any]],
    asked: Sequence[str],
    *,
    shown: Iterable[str] = (),
    extra_ids: Iterable[str] = (),
) -> tuple[dict[str, Any], list[str]]:
    """Remake this scene on an owner's script: the old script with only the asked scenes replaced by the new take
    (each keeps its length, ``writer.merge_scenes``), the cues built again from the owner's words. Returns the script
    and the asked ids the answer left out."""
    asked_own = [o for o in own if o["sceneId"] in set(asked)]
    take = {"scenes": staged(answer, asked_own, min_sec=False)}
    script, missing = writer.merge_scenes(old, take, list(asked), new_take=True)
    refs = {**_old_refs(old), **guidance_refs(answer, shown)}
    script["captions"] = owner_cues(script, own, refs=refs, keep_from=old, extra_ids=extra_ids, keep_timing=True)
    return script, missing


def _old_refs(old: Mapping[str, Any]) -> dict[str, str]:
    return {
        str(c["id"]).removeprefix(CUE_PREFIX): str(c["guidanceRef"])
        for c in old.get("captions") or []
        if isinstance(c, Mapping) and str(c.get("id") or "").startswith(CUE_PREFIX) and c.get("guidanceRef")
    }


# --- the faithful check ---------------------------------------------------------------------------------------------


def _num(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _names(script: Mapping[str, Any]) -> tuple[dict[str, str], set[str]]:
    """(cast key -> name for the people and the cars, the cars' keys) of a script."""
    people = {str(k): str((v or {}).get("name") or k) for k, v in (script.get("cast") or {}).items()}
    cars = {str(k): str((v or {}).get("name") or k) for k, v in (script.get("cars") or {}).items()}
    return {**people, **cars}, set(cars)


def _in_scene(scene: Mapping[str, Any]) -> set[str]:
    """Who is drawn in a scene: its actors' cast ids and the cast ids of its car props."""
    out = {str(a.get("castId")) for a in scene.get("actors") or [] if isinstance(a, Mapping) and a.get("castId")}
    out |= {str(p.get("castId")) for p in scene.get("props") or [] if isinstance(p, Mapping) and p.get("castId")}
    return out


def _owner(key: str, n: int, **words: Any) -> str:
    return str(getattr(keys, key)).format(n=n, **words)


def _p(n: int, key: str, for_model: str, *, reading: bool = False, **words: Any) -> Problem:
    """A problem of scene ``n`` with the owner's sentence ``keys.{key}`` (``words``: its blanks)."""
    return Problem(n, for_model, _owner(key, n, **words), key, reading)


def own_problems(
    answer: Mapping[str, Any],
    script: Mapping[str, Any],
    own: Any,
    castmap: Mapping[str, str],
    owner_cues: Iterable[str] = (),
    *,
    asked: Sequence[str] | None = None,
    places: Mapping[str, str] | None = None,
) -> list[Problem]:
    """Whether the staging kept the owner's script (§45.46.6), run on the final script (after ``_prepare``, the cast
    repair and a remake's merge) and, for the events, on the adapter's answer (where its beat numbers are valid).
    ``owner_cues``: the ids of the cues the owner added in the caption editor (``ownerEdits.captions``); ``asked``: a
    remake's scenes (only they are in the answer); ``places``: set id -> its label. Empty when nothing broke."""
    scenes = scenes_of(own)
    by_id = {s["sceneId"]: (i + 1, s) for i, s in enumerate(scenes)}
    names, car_keys = _names(script)
    labels = dict(places or {})
    final = {str(s.get("sceneId")): s for s in script.get("scenes") or [] if isinstance(s, Mapping)}
    windows = writer.scene_windows(dict(script))
    out: list[Problem] = []

    # 1. the scenes and their order
    have = [str(s.get("sceneId")) for s in script.get("scenes") or [] if isinstance(s, Mapping)]
    want = [s["sceneId"] for s in scenes]
    if have != want:
        n = next((i + 1 for i, sid in enumerate(want) if i >= len(have) or have[i] != sid), len(want) or 1)
        order = f"in this order: {', '.join(want)}. Yours were: {', '.join(have) or 'none'}."
        out.append(_p(n, "OWN_LOST", "Make exactly one scene for each script scene, " + order))

    # 2. the words: exactly one cue w_sN for a scene with words, as written, inside its scene; nothing else
    out += _words(scenes, final, windows, [c for c in script.get("captions") or [] if isinstance(c, Mapping)],
                  {str(i) for i in owner_cues})  # fmt: skip

    # 3. who, and 4. where
    for sid, scene in final.items():
        if sid not in by_id:
            continue
        n, s = by_id[sid]
        drawn = _in_scene(scene)
        wanted = {castmap[c] for c in s.get("who") or [] if c in castmap}
        added = drawn - set(names)
        if wanted:
            for k in sorted(wanted - drawn):
                name = names.get(k, k)
                out.append(_p(n, "OWN_NOT_SHOWN", f"scene {sid} must have {name} ({k}) in it.", words=short(name)))
            added |= drawn - wanted
        for k in sorted(added):
            out.append(_p(n, "OWN_EXTRA", f"scene {sid} must not have {names.get(k, k)} ({k}): the owner did not."))
        place = s.get("place")
        if place and scene.get("set") != place:
            where = labels.get(place, place.replace("_", " ")).lower()
            out.append(_p(n, "OWN_PLACE", f"scene {sid} happens in {place}: use set {place}.", place=where))

    # 5. the events, on the answer
    given = {str(s.get("sceneId")): s for s in answer.get("scenes") or [] if isinstance(s, Mapping)}
    for sid in want:
        n, s = by_id[sid]
        raw = given.get(sid)
        if raw is None or (asked is not None and sid not in asked):
            continue  # a scene the answer does not have is lost (rule 1); a remake only has the asked ones
        wanted = {castmap[c] for c in s.get("who") or [] if c in castmap}
        out += _events(n, s, raw, final.get(sid), names, car_keys, list(labels.values()), wanted)

    # 6. reading time, after fitting
    for sid in want:
        n, s = by_id[sid]
        shown = final.get(sid)
        if not s["caption"] or shown is None:
            continue
        d, needed = _num(shown.get("durationSec")), need(s["caption"])
        if d < READING_SHARE * needed - 1e-9:
            text = f"scene {sid} lasts {d:g} s; it needs at least {needed:g} s for its words."
            out.append(_p(n, "OWN_WORDS", text, reading=True))
    return out


def _words(
    scenes: Sequence[Mapping[str, Any]],
    final: Mapping[str, Mapping[str, Any]],
    windows: Mapping[str, tuple[float, float]],
    cues: Sequence[Mapping[str, Any]],
    extra: set[str],
) -> list[Problem]:
    """Rule 2: each scene with words has exactly one cue ``w_sN`` with the owner's words exactly (``same_words``: case,
    punctuation and emoji count; only space and NFC differences never refuse a video), inside its scene's window; no
    scene caption and no other cue, except one the owner added himself (``extra``)."""
    out: list[Problem] = []
    for n, s in enumerate(scenes, start=1):
        sid = s["sceneId"]
        mine = [c for c in cues if str(c.get("id")) == CUE_PREFIX + sid]
        if s["caption"] and len(mine) != 1:
            out.append(_p(n, "OWN_WORDS", f"scene {sid} needs exactly one caption cue {CUE_PREFIX}{sid}."))
        elif s["caption"] and not same_words(mine[0].get("text"), s["caption"]):
            out.append(_p(n, "OWN_WORDS", f"scene {sid}'s caption must be the owner's words exactly."))
        elif s["caption"] and sid in windows:
            lo, hi = windows[sid]
            at, dur = _num(mine[0].get("at"), -1), _num(mine[0].get("dur"))
            if at < lo - WINDOW_TOLERANCE or at + dur > hi + WINDOW_TOLERANCE:
                out.append(_p(n, "OWN_WORDS", f"scene {sid}'s caption must show inside scene {sid}."))
        elif not s["caption"] and mine:
            out.append(_p(n, "OWN_EXTRA", f"scene {sid} has no words of the owner's: write no caption."))
        scene = final.get(sid)
        if scene is not None and scene.get("caption") not in (None, ""):
            out.append(_p(n, "OWN_EXTRA", "Write no caption: every scene's caption is null."))
    ours = {CUE_PREFIX + s["sceneId"] for s in scenes if s["caption"]}
    numbers = {s["sceneId"]: n for n, s in enumerate(scenes, start=1)}
    for c in cues:
        cid = str(c.get("id"))
        if cid in ours or cid in extra or (cid.startswith(CUE_PREFIX) and cid.removeprefix(CUE_PREFIX) in numbers):
            continue  # the owner's (a w_ cue of a scene with no words is that scene's problem above)
        at = _num(c.get("at"))
        n = next((numbers[k] for k, (lo, hi) in windows.items() if k in numbers and lo <= at < hi), 1)
        out.append(_p(n, "OWN_EXTRA", "Write no captions: code puts the owner's words on screen."))
    return out


def _events(
    n: int,
    own_scene: Mapping[str, Any],
    raw: Mapping[str, Any],
    final_scene: Mapping[str, Any] | None,
    names: Mapping[str, str],
    car_keys: set[str],
    place_labels: Sequence[str],
    wanted: set[str],
) -> list[Problem]:
    """Rule 5 for one scene: the pieces cover what happens exactly; each is shown by something or is a name the owner
    left out; each cast name in a piece is drawn by one of its beats; a beat no piece names is a small filler; a prop
    action always belongs to a piece; normalizing kept every beat."""
    sid = own_scene["sceneId"]
    leave = [x for x in own_scene.get("leaveOut") or [] if x.strip()]
    pieces = _pieces(raw)
    beats = [b for b in raw.get("beats") or [] if isinstance(b, Mapping)]
    props = {str(p.get("propId")): p for p in raw.get("props") or [] if isinstance(p, Mapping)}
    riders = {str(a.get("castId")): str(a.get("inCar")) for a in raw.get("actors") or []
              if isinstance(a, Mapping) and a.get("inCar")}  # fmt: skip
    out: list[Problem] = []
    if norm(" ".join(str(p.get("words") or "") for p in pieces)) != norm(own_scene["what"]):
        text = f"scene {sid}: the pieces in shows must copy its what exactly, in order, all of it and nothing else"
        out.append(_p(n, "OWN_LOST", f"{text}: {own_scene['what']!r}."))
    named: set[int] = set()
    for p in pieces:
        words = str(p.get("words") or "")
        if p.get("notShown"):
            if any(_has_name(words, x) for x in leave):
                continue  # a name the owner left out: not drawn, and the scene can still be made
            who = unknown_name(words, names.values(), leave, place_labels)
            if who is not None:
                out.append(_p(n, "OWN_WHO", f"scene {sid}: “{words}” names {who}, who is not in the cast.", name=who))
            else:
                text = f"scene {sid}: “{words}” must be shown (only a name the owner left out may be not shown)."
                out.append(_p(n, "OWN_NOT_SHOWN", text, words=short(words)))
            continue
        own_beats = _indexes(p.get("beats"), len(beats))
        own_sfx = [i for i in _indexes(p.get("sfx"), len(beats)) if beats[i].get("sfx")]
        if not (own_beats or own_sfx or p.get("place") is True or p.get("camera") is True):
            text = f"scene {sid}: “{words}” names nothing that shows it (beats, sfx, place or camera)."
            out.append(_p(n, "OWN_NOT_SHOWN", text, words=short(words)))
            continue
        named |= set(own_beats)
        doers = {str(beats[i].get("who")) for i in own_beats}
        for k in names_in(words, names):
            if (wanted and k not in wanted) or any(norm(x) == norm(names[k]) for x in leave):
                continue  # someone the owner did not put in this scene, or left out: never drawn for these words
            if k in car_keys:
                cars_here = {pid for pid, pr in props.items() if pr.get("castId") == k}
                ok = bool(doers & cars_here) or any(riders.get(d) in cars_here for d in doers)
            else:
                ok = k in doers
            if not ok:
                text = f"scene {sid}: “{words}” names {names[k]} ({k}): one of its beats must be {names[k]}'s."
                out.append(_p(n, "OWN_NOT_SHOWN", text, words=short(words)))
    for i, b in enumerate(beats):
        who, action = str(b.get("who")), str(b.get("do"))
        if i in named:
            continue
        if who in props:
            text = f"scene {sid}: beat {i} ({action} by the {props[who].get('kind')}) is a prop action no piece names."
            out.append(_p(n, "OWN_EXTRA", text))
        elif action not in FILLER:
            only = ", ".join(sorted(FILLER))
            text = f"scene {sid}: beat {i} ({action}) is not in what happens; name it in a piece or use only {only}."
            out.append(_p(n, "OWN_EXTRA", text))
    if final_scene is not None and len(final_scene.get("beats") or []) < len(beats):
        out.append(_p(n, "OWN_LOST", f"scene {sid} lost beats while it was set up."))
    return out


def _indexes(value: Any, size: int) -> list[int]:
    return [i for i in value or [] if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < size]


def post_fix_text(problems: Sequence[Mapping[str, Any]]) -> str:
    """What the post captions task is told on an owner's script when the fact check found problems in them: the
    owner's own words are never rewritten, only the AI's post captions (§45.46)."""
    lines = [f"- {str(p.get('ref') or '').removeprefix('post:')}: {p.get('problem')}" for p in problems]
    return (
        "The fact checker found these problems in the post captions. Write the post captions again so every problem "
        "is gone, and keep every caption that has none:\n" + "\n".join(lines)
    )


def owner_sentence(problems: Sequence[Problem]) -> str:
    """The sentence the owner reads when the staging still broke the script: the first problem that is not about
    reading time (that one only when nothing else is left)."""
    first = next((p for p in problems if not p.reading), problems[0])
    return first.for_owner


_SCENE_NO = re.compile(r"\bscene (\d+)\b")


def engine_sentence(errors: Sequence[str]) -> str:
    """The owner's sentence when the engine still refused the staging: the scene it names got lost, else the
    writer's own sentence."""
    for e in errors:
        m = _SCENE_NO.search(str(e))
        if m:
            return _owner("OWN_LOST", int(m.group(1)))
    return keys.WRITER_FAILED
