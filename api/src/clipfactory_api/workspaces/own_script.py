"""Write it myself: the owner's own script of what happens (docs/CONTRACTS.md §45.46).

An ``OwnScript`` is 2 to 12 scenes, each with what happens (``what``), the words on screen (``caption``), who is in it
(``who``, some of the story's ``characterIds``), the place (``place``, a catalog set), the names the owner left out
(``leaveOut``) and, only when there are some, the capitalised words the owner already answered (``known``: another name
for someone in Who, or not a name). The words are kept exactly as typed: only their ends are trimmed, and a value over
its limit, or a caption mark the burned-in words would change (braces, a backslash), is refused (400), never
changed. The API gives the scene ids (``s1`` … ``sN``, by position) on every save; the owner's caption
cue of scene ``sN`` is ``w_sN`` (built by code, never by a model).
"""

from __future__ import annotations

import math
import unicodedata
from collections.abc import Iterable, Mapping
from typing import Any, Final

from .. import validate
from ..errors import bad_request
from . import catalog

SCENES_MIN: Final = 2
SCENES_MAX: Final = 12
WHAT_MAX: Final = 160
CAPTION_MAX: Final = 60
WHO_MAX: Final = 4
LEAVE_OUT_MAX: Final = 5
KNOWN_MAX: Final = 12
NAME_MAX: Final = 40
LOGLINE_MAX: Final = 280  # ideas.LOGLINE_MAX (ideas imports guidance; this module stays light)
SCENE_KEYS: Final = ("sceneId", "what", "caption", "who", "place", "leaveOut", "known")
CAPTION_MARKS: Final = frozenset("{}\\")  # the video's burned-in words (libass) would change them
CUE_PREFIX: Final = "w_"

# §45.46.4's sentences (the web's own checks say the same, so an 8 year old never sees two wordings)
FEW: Final = "Write at least 2 scenes."
MANY: Final = "Up to 12 scenes."
EMPTY: Final = "Scene {n} is empty. Write what happens."
LONG: Final = "Scene {n} is too long. Use 160 letters or fewer."
CAPTION_LONG: Final = "Scene {n}'s caption is too long. Use 60 letters or fewer."
NOT_IN_CAST: Final = "Scene {n} has someone who isn't in the cast."
TOO_MANY_WHO: Final = "Scene {n} has too many people. Keep 4 or fewer."
MARKS: Final = "Scene {n}'s caption can't use {{ }} or \\. Take them out."
BAD_PLACE: Final = "Scene {n}'s place isn't one we can draw. Pick one from the list."
PLAIN: Final = "Use plain letters in scene {n}."
TOO_MANY_LEFT_OUT: Final = "Scene {n} leaves out too many names. Keep 5 or fewer."
NAME_LONG: Final = "Scene {n} has a name that is too long. Use 40 letters or fewer."
NO_OWN_SCRIPT: Final = "This video has no script of yours."
FOLLOWS_SCRIPT: Final = "This video follows your script. Tap Change my script."
ONE_AT_A_TIME: Final = "Change your script by itself, then the rest."


def _plain(text: str, *, newline: bool) -> bool:
    """No control characters (a newline only where it is allowed). Format characters such as the zero-width joiner
    that holds an emoji together are not control characters, so emoji stay."""
    return not any(unicodedata.category(ch) == "Cc" and not (newline and ch == "\n") for ch in text)


def _what(raw: Mapping[str, Any], i: int) -> str:
    n, field = i + 1, f"ownScript.scenes[{i}].what"
    value = raw.get("what")
    if value is not None and not isinstance(value, str):
        raise bad_request(EMPTY.format(n=n), field)
    text = (value or "").strip()
    if not text:
        raise bad_request(EMPTY.format(n=n), field)
    if len(text) > WHAT_MAX:
        raise bad_request(LONG.format(n=n), field)
    if not _plain(text, newline=True):
        raise bad_request(PLAIN.format(n=n), field)
    return text


def _caption(raw: Mapping[str, Any], i: int) -> str | None:
    n, field = i + 1, f"ownScript.scenes[{i}].caption"
    value = raw.get("caption")
    if value is None:
        return None
    if not isinstance(value, str):
        raise bad_request(PLAIN.format(n=n), field)
    text = value.strip()
    if not text:
        return None  # an empty caption is no caption
    if len(text) > CAPTION_MAX:
        raise bad_request(CAPTION_LONG.format(n=n), field)
    if not _plain(text, newline=False):
        raise bad_request(PLAIN.format(n=n), field)
    if CAPTION_MARKS & set(text):
        raise bad_request(MARKS.format(n=n), field)
    return text


def _who(raw: Mapping[str, Any], i: int, character_ids: Iterable[str]) -> list[str]:
    n, field = i + 1, f"ownScript.scenes[{i}].who"
    value = raw.get("who")
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise bad_request(NOT_IN_CAST.format(n=n), field)
    cast = set(character_ids)
    if any(v not in cast for v in value):
        raise bad_request(NOT_IN_CAST.format(n=n), field)
    who = list(dict.fromkeys(value))  # a repeat counts once
    if len(who) > WHO_MAX:
        raise bad_request(TOO_MANY_WHO.format(n=n), field)
    return who


def _place(raw: Mapping[str, Any], i: int) -> str | None:
    value = raw.get("place")
    if value is None:
        return None
    if value not in catalog.SETS:
        raise bad_request(BAD_PLACE.format(n=i + 1), f"ownScript.scenes[{i}].place")
    return str(value)


def _leave_out(raw: Mapping[str, Any], i: int) -> list[str]:
    n, field = i + 1, f"ownScript.scenes[{i}].leaveOut"
    value = raw.get("leaveOut")
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise bad_request(PLAIN.format(n=n), field)
    names = list(dict.fromkeys(v.strip() for v in value if v.strip()))
    if len(names) > LEAVE_OUT_MAX:
        raise bad_request(TOO_MANY_LEFT_OUT.format(n=n), field)
    if any(len(name) > NAME_MAX for name in names):
        raise bad_request(NAME_LONG.format(n=n), field)
    if not all(_plain(name, newline=False) for name in names):
        raise bad_request(PLAIN.format(n=n), field)
    return names


def _known(raw: Mapping[str, Any], i: int) -> list[str]:
    n, field = i + 1, f"ownScript.scenes[{i}].known"
    value = raw.get("known")
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise bad_request(PLAIN.format(n=n), field)
    names = list(dict.fromkeys(v.strip() for v in value if v.strip()))
    if len(names) > KNOWN_MAX or any(len(name) > NAME_MAX for name in names):
        raise bad_request(NAME_LONG.format(n=n), field)
    if not all(_plain(name, newline=False) for name in names):
        raise bad_request(PLAIN.format(n=n), field)
    return names


def own_script(value: Any, character_ids: Iterable[str]) -> dict[str, Any]:
    """The owner's script, checked (§45.46 limits), with the scene ids given by position. ``character_ids``: the
    story's cast; each scene's ``who`` is some of it. Every scene comes back with all six keys (and ``known`` when it
    has some)."""
    body = validate.obj(value, "ownScript")
    validate.only_keys(body, {"scenes"})
    raw_scenes = body.get("scenes")
    if not isinstance(raw_scenes, list) or len(raw_scenes) < SCENES_MIN:
        raise bad_request(FEW, "ownScript.scenes")
    if len(raw_scenes) > SCENES_MAX:
        raise bad_request(MANY, "ownScript.scenes")
    cast = list(character_ids)
    scenes = []
    for i, item in enumerate(raw_scenes):
        raw = validate.obj(item, f"ownScript.scenes[{i}]")
        validate.only_keys(raw, SCENE_KEYS)  # sceneId is ignored on input: the ids are given here
        scene = {
            "sceneId": f"s{i + 1}",
            "what": _what(raw, i),
            "caption": _caption(raw, i),
            "who": _who(raw, i, cast),
            "place": _place(raw, i),
            "leaveOut": _leave_out(raw, i),
        }
        known = _known(raw, i)
        if known:  # additive: only a scene with answered words has it
            scene["known"] = known
        scenes.append(scene)
    return {"scenes": scenes}


def public(value: Any) -> dict[str, Any]:
    """``Story.ownScript`` as stored, with exactly the six keys per scene (an absent one as null or []), and ``known``
    only when the scene has some."""
    scenes = []
    for raw in _scenes(value) if isinstance(value, Mapping) else []:
        scene: dict[str, Any] = {
            "sceneId": str(raw.get("sceneId") or ""),
            "what": str(raw.get("what") or ""),
            "caption": raw.get("caption") if isinstance(raw.get("caption"), str) and raw.get("caption") else None,
            "who": [str(w) for w in raw.get("who") or []],
            "place": raw.get("place") if isinstance(raw.get("place"), str) and raw.get("place") else None,
            "leaveOut": [str(w) for w in raw.get("leaveOut") or []],
        }
        known = [str(w) for w in raw.get("known") or [] if str(w).strip()]
        if known:
            scene["known"] = known
        scenes.append(scene)
    return {"scenes": scenes}


def _scenes(own: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [s for s in own.get("scenes") or [] if isinstance(s, Mapping)]


# --- reading time and length (§45.46.4: the same in the web, the API and the agent) ----------------------------------


def need(scene: Mapping[str, Any]) -> float:
    """The seconds a scene needs: 3, or with a caption enough to read it (``min(15, max(3, 2 + letters / 15))``)."""
    caption = scene.get("caption")
    if not isinstance(caption, str) or not caption:
        return 3.0
    return min(15.0, max(3.0, 2 + len(caption) / 15))


def default_length(own: Mapping[str, Any]) -> int:
    """The video's length when the owner picks none: ``clamp(5 * ceil(max(Σneed, 5n) / 5), 15, min(90, 15n))``."""
    scenes = _scenes(own)
    n = len(scenes)
    total = 0.0
    for scene in scenes:  # left to right, as the web's reduce (Python's sum() of floats rounds differently)
        total += need(scene)
    raw = 5 * math.ceil(max(total, 5 * n) / 5)
    return int(min(max(raw, 15), 90, 15 * n))


# --- what other parts read ------------------------------------------------------------------------------------


def texts(own: Mapping[str, Any]) -> list[str]:
    """Every word the owner wrote (the topic match reads them): what happens in each scene, then the captions."""
    scenes = _scenes(own)
    whats = [str(s.get("what") or "") for s in scenes]
    return whats + [str(s["caption"]) for s in scenes if isinstance(s.get("caption"), str) and s["caption"]]


# The owner's words that make a script driving content (the agent's own_script.DRIVING_WORDS and the web's
# studio/ownScript.ts DRIVING_WORDS, kept the same by tests): only such a script is matched to a checked topic when
# its kind is not driving safety (§45.46.5), so a joke about a puddle never gets road rules it did not ask for.
DRIVING_WORDS: Final = (
    "drive",
    "driv",
    "drove",
    "brak",
    "seatbelt",
    "seat belt",
    "steer",
    "speed",
    "motorway",
    "highway",
    "traffic",
    "road",
    "crossing",
    "indicator",
    "headlight",
    "full beam",
    "dipped",
    "overtak",
    "junction",
    "roundabout",
    "pedestrian",
    "zebra",
)


def _words(text: str) -> str:
    """Lower case, every character that is not a letter or digit a space (the agent's ``norm``)."""
    clean = "".join(ch for ch in unicodedata.normalize("NFC", text) if unicodedata.category(ch) != "Cf")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in clean.lower()).split())


def about_driving(own: Mapping[str, Any]) -> bool:
    """True when the owner's words (any scene's what or caption) talk about driving or the road (a word that starts
    with one of ``DRIVING_WORDS``, as the agent reads them)."""
    flat = [f" {_words(t)}" for t in texts(own)]
    return any(f" {w}" in t for t in flat for w in DRIVING_WORDS)


def logline_of(own: Mapping[str, Any]) -> str:
    """A brief's line when none was given: scene 1's ``what`` on one line (at most 280 characters)."""
    scenes = _scenes(own)
    return " ".join(str(scenes[0].get("what") or "").split())[:LOGLINE_MAX] if scenes else ""


def has_words(own: Mapping[str, Any]) -> bool:
    """Any scene has a caption (its steps then say "Add your words", and the captions switch defaults on)."""
    return any(isinstance(s.get("caption"), str) and s["caption"] for s in _scenes(own))


def cue_id(scene_id: str) -> str:
    return f"{CUE_PREFIX}{scene_id}"


def only_words(old: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    """The same scenes, each with the same what, who, place and left-out names: only captions may differ."""
    before, after = public(old)["scenes"], public(new)["scenes"]
    keys = ("sceneId", "what", "who", "place", "leaveOut")
    return len(before) == len(after) and all(
        all(a[k] == b[k] for k in keys) for a, b in zip(before, after, strict=True)
    )


def _round(value: float) -> int | float:
    value = round(value, 3)
    return int(value) if float(value).is_integer() else value


READING_SHARE: Final = 0.9  # the agent's rule: a scene with words lasts at least 90 % of their reading time
MIN_CUE: Final = 0.3  # the agent's shortest cue (writer.CAPTION_SCHEMA)


def word_cues(script: Mapping[str, Any], own: Mapping[str, Any]) -> list[dict[str, Any]] | None:
    """The script's caption cues with the owner's words applied (a words-only change, §45.46): a changed caption
    changes its ``w_sN`` cue's text, a new one gets a cue at ``start + 0.25`` for ``d - 0.5`` (at least 0.3 s) inside
    its scene, and a cleared one loses its cue. Every other cue stays as it is. None when the script's scenes are not
    the script's, or a new or changed caption needs more reading time than its scene has (the agent's 90 % rule): it
    is then staged again."""
    windows: dict[str, tuple[float, float]] = {}
    start = 0.0
    for scene in script.get("scenes") or []:
        if not isinstance(scene, Mapping):
            continue
        length = float(scene.get("durationSec") or 0)
        windows[str(scene.get("sceneId"))] = (start, length)
        start += length
    scenes = public(own)["scenes"]
    if any(s["sceneId"] not in windows for s in scenes):
        return None
    cues = [dict(c) for c in script.get("captions") or [] if isinstance(c, Mapping)]
    for scene in scenes:
        wanted, caption = cue_id(scene["sceneId"]), scene["caption"]
        found = next((k for k, c in enumerate(cues) if c.get("id") == wanted), None)
        changed = caption is not None and (found is None or cues[found].get("text") != caption)
        if changed and windows[scene["sceneId"]][1] < READING_SHARE * need(scene) - 1e-9:
            return None  # too long to read in the scene as it is: staged again, so the scene gets the time
        if caption is None:
            if found is not None:
                cues.pop(found)
        elif found is not None:
            if cues[found].get("text") != caption:
                cues[found] = {**cues[found], "text": caption}
        else:
            at, length = windows[scene["sceneId"]]
            cue = {"id": wanted, "at": _round(at + 0.25), "dur": _round(max(MIN_CUE, length - 0.5)), "text": caption}
            later = next((k for k, c in enumerate(cues) if float(c.get("at") or 0) > at + 0.25), len(cues))
            cues.insert(later, cue)
    return cues


def mirrored(own: Mapping[str, Any], cues: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """A captions edit (the CaptionEditor) on an owner's script, copied into it: scene ``sN``'s caption is the text of
    cue ``w_sN``, or null when that cue is gone. Both copies of the owner's words stay the same."""
    by_id = {str(c.get("id")): c for c in cues if isinstance(c, Mapping)}
    out = public(own)
    for i, scene in enumerate(out["scenes"]):
        cue = by_id.get(cue_id(scene["sceneId"]))
        text = str(cue.get("text") or "").strip() if cue is not None else ""
        if text and not _plain(text, newline=False):
            raise bad_request(PLAIN.format(n=i + 1), "captions")
        if CAPTION_MARKS & set(text):
            raise bad_request(MARKS.format(n=i + 1), "captions")
        scene["caption"] = text or None
    return out
