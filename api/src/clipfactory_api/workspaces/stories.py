"""Stories: what a request may ask, what an edit makes stale, and the approve rule (docs/CONTRACTS.md §45.9).

Statuses (who moves them: §45.9.1): create → ``producing``; a job ends in ``review`` or ``needs_check`` (agent) or
``failed``; cancel → the status before the job; PATCH keeps the status and grows ``stale``; produce and changes →
``producing``; approve (``review``, nothing stale, facts checked on this script version) → ``approved``; reject →
``rejected``; the first posted publishing job → ``published`` (story flow).
"""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from .. import validate
from ..errors import bad_request, conflict
from ..ids import is_ulid
from . import captions, catalog, overrides, shapes
from .ideas import LOGLINE_MAX, TITLE_MAX, character_ids
from .jobs import valid_stale_scenes

REMAKE_STATUSES: Final = ("draft", "review", "needs_check", "failed")
EDIT_STATUSES: Final = ("review", "needs_check", "failed")
REJECT_STATUSES: Final = ("review", "needs_check")
DOWNLOAD_STATUSES: Final = ("approved", "published")
SCENE_STEPS: Final = ("scenes", "animation")
DEFAULT_MOOD: Final = {
    "driving_safety": "tense",
    "everyday_skills": "playful",
    "comedy": "comedic",
    "explainer": "wonder",
}
ASPECTS: Final = shapes.ASPECTS
FORMAT_SET: Final = "The video's size is set once it is made. Make a new video for another size."
MAX_SECONDS = 89.5  # Facebook Reels' 90 s limit, with room for the audio tail (§45.9)
MAX_REFERENCES = 3  # reference videos per story (§45.28)
MAX_CAPTIONS = 40
MAX_SFX = 40
NOTE_MAX = 500
STALE_CAPTIONS: Final = ("captions", "assemble", "preview", "safety")
STALE_SOUND: Final = ("sound", "assemble", "preview")
STALE_LENGTH: Final = ("animation", "sound", "captions", "assemble", "preview")
STALE_POST: Final = ("safety",)
STALE_FORMAT: Final = ("scenes", "animation", "captions", "assemble", "preview")

NOT_YET = "Your changes aren't in the video yet. Tap Remake first."
CHANGED = "This story changed meanwhile. Reload it and try again."
BUSY = "A video is being made for this story. Wait until it is done."
NO_SCRIPT = "This story has no storyboard yet. Tap Try again first."
UP_TO_DATE = "Nothing to remake: the video already has every change."


def _number(value: Any, field: str, lo: float, hi: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise bad_request(f"{field} must be a number.")
    if not lo <= value <= hi:
        raise bad_request(f"{field} must be between {lo:g} and {hi:g}.")
    return float(value)


def _int_or_float(value: float) -> int | float:
    return int(value) if float(value).is_integer() else round(value, 3)


# --- create ---------------------------------------------------------------------------------------------------


def reference_ids(value: Any) -> list[str]:
    """``referenceIds`` (≤ 3 reference video ids, §45.28); the route checks each is this workspace's ``REFVID#``."""
    if not isinstance(value, list) or not all(isinstance(v, str) and is_ulid(v) for v in value):
        raise bad_request("referenceIds must be a list of reference video ids.", "referenceIds")
    ids = list(dict.fromkeys(value))
    if len(ids) > MAX_REFERENCES:
        raise bad_request(f"Pick at most {MAX_REFERENCES} reference videos.", "referenceIds")
    return ids


format_of = shapes.format_of
stored_format = shapes.stored_format


def video_format(value: Any, field: str = "format") -> dict[str, Any]:
    """A story's ``format`` (§45.34): ``{aspect, width, height}``, one of the six sizes, the size matching the shape."""
    body = validate.obj(value, field)
    validate.only_keys(body, {"aspect", "width", "height"})
    aspect = body.get("aspect")
    if aspect not in ASPECTS:
        raise bad_request("Pick a shape: 9:16 (tall), 1:1 (square) or 16:9 (wide).", field)
    size = f"{validate.whole_number(body.get('width'))}x{validate.whole_number(body.get('height'))}"
    if size not in ASPECTS[str(aspect)]:
        sizes = " or ".join(s.replace("x", " by ") for s in ASPECTS[str(aspect)])
        raise bad_request(f"A {aspect} video is {sizes}.", field)
    return format_of(aspect, size)


STORY_KEYS: Final = (
    "ideaId",
    "brief",
    "title",
    "characterIds",
    "durationSec",
    "captionsOn",
    "musicMood",
    "referenceIds",
    "ai",
    "override",
    "format",
)


def story_input(body: Mapping[str, Any]) -> dict[str, Any]:
    """StoryInput (§45.6): an idea or a short brief, 1 to 3 characters, the length, captions and music, the reference
    videos, the video's own model and effort (``ai``, kept), and ``override`` (the first job only, never kept)."""
    validate.only_keys(body, STORY_KEYS)
    out: dict[str, Any] = {}
    has_idea, has_brief = body.get("ideaId") is not None, body.get("brief") is not None
    if has_idea == has_brief:
        raise bad_request("Pick an idea or type a short concept.")
    if has_idea:
        if not (isinstance(body["ideaId"], str) and is_ulid(body["ideaId"])):
            raise bad_request("ideaId is not valid.")
        out["ideaId"] = body["ideaId"]
    else:
        brief = validate.obj(body["brief"], "brief")
        validate.only_keys(brief, {"title", "logline", "category"})
        if brief.get("category") not in shapes.CATEGORIES:
            raise bad_request("brief.category must be driving_safety, everyday_skills, comedy or explainer.")
        out["brief"] = {
            "title": validate.required_string(brief, "title", max_len=TITLE_MAX),
            "logline": validate.required_string(brief, "logline", max_len=LOGLINE_MAX),
            "category": brief["category"],
        }
    if body.get("title") is not None:
        out["title"] = validate.required_string(body, "title", max_len=TITLE_MAX)
    ids = character_ids(body.get("characterIds"))
    if not ids:
        raise bad_request("Pick at least one character.")
    out["characterIds"] = ids
    if body.get("durationSec") is not None:
        out["durationSec"] = validate.integer(body["durationSec"], "durationSec", lo=15, hi=90)
    if body.get("captionsOn") is not None:
        out["captionsOn"] = validate.boolean(body["captionsOn"], "captionsOn")
    if body.get("musicMood") is not None:
        if body["musicMood"] not in catalog.MUSIC_MOODS:
            raise bad_request("musicMood is not one of the music moods.")
        out["musicMood"] = body["musicMood"]
    out["referenceIds"] = reference_ids(body["referenceIds"]) if body.get("referenceIds") is not None else []
    out["ai"] = overrides.ai_setting(body["ai"]) if body.get("ai") is not None else overrides.empty_setting()
    out["override"] = overrides.model_override(body.get("override"))
    if body.get("format") is not None:
        out["format"] = video_format(body["format"])
    return out


# --- runs -----------------------------------------------------------------------------------------------------


def has_script(story: Mapping[str, Any]) -> bool:
    return bool(story.get("scriptKey")) and int(story.get("scriptVersion") or 0) > 0


def produce_input(
    body: Mapping[str, Any], story: Mapping[str, Any]
) -> tuple[str | None, list[str] | None, dict[str, str] | None]:
    """(``from``, ``sceneIds``, the override for this job only)."""
    validate.only_keys(body, {"from", "sceneIds", "override"})
    from_step = body.get("from")
    if from_step is not None and from_step not in shapes.STEP_ORDER:
        raise bad_request("from must be one of the steps.")
    scene_ids = body.get("sceneIds")
    if scene_ids is not None:
        if from_step not in SCENE_STEPS:
            raise bad_request('sceneIds only go with from "scenes" or "animation".')
        scene_ids = scene_list(scene_ids, story)
    return from_step, scene_ids, overrides.model_override(body.get("override"))


def scene_list(value: Any, story: Mapping[str, Any]) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        raise bad_request("sceneIds must be a list of scene ids.")
    known = {str(s.get("sceneId")) for s in story.get("scenes") or [] if isinstance(s, Mapping)}
    ids = list(dict.fromkeys(value))
    unknown = [s for s in ids if s not in known]
    if unknown:
        raise bad_request(f"This story has no scene {unknown[0]}.")
    return ids


def _all_scenes(story: Mapping[str, Any]) -> list[str]:
    return [str(s.get("sceneId")) for s in story.get("scenes") or [] if isinstance(s, Mapping) and s.get("sceneId")]


def _named_scenes(story: Mapping[str, Any], run: list[str], scene_ids: list[str] | None) -> list[str] | None:
    """The scenes an explicit ``from "scenes" | "animation"`` re-renders: the ones asked for plus every scene already
    out of date, so an older take never stays in the video next to newer sound and captions."""
    if not scene_ids:
        return scene_ids
    stale = set(story.get("stale") or [])
    if "scenes" in run and "scenes" in stale:
        return _all_scenes(story)  # the stills are out of date, and which ones is not known
    if "animation" in stale:
        known = valid_stale_scenes(story)
        if not known:
            return _all_scenes(story)  # every scene's animation is out of date
        wanted = {*scene_ids, *known}
        return [s for s in _all_scenes(story) if s in wanted]
    return scene_ids


def produce_run(
    story: Mapping[str, Any], from_step: str | None, scene_ids: list[str] | None
) -> tuple[list[str], list[str] | None]:
    """(the steps the job runs, the scenes it re-renders). No ``from``: exactly the ``stale`` steps (§45.9)."""
    if not has_script(story):
        return list(shapes.STEP_ORDER), None
    if from_step is not None:
        run = list(shapes.STEP_ORDER[shapes.STEP_ORDER.index(from_step) :])
        return run, _named_scenes(story, run, scene_ids)
    run = shapes.ordered_steps(story.get("stale") or [])
    if not run and not story.get("videoKey"):
        run = list(shapes.STEP_ORDER[1:])  # a storyboard and no video: make everything after the storyboard
    if not run:
        raise conflict(UP_TO_DATE)
    scenes = valid_stale_scenes(story)
    if "animation" in run and "scenes" not in run and scenes:
        return run, scenes
    return run, None


def changes_again(story: Mapping[str, Any], last: Mapping[str, Any] | None) -> tuple[str | None, list[str]] | None:
    """(note, sceneIds) when "Try again" must repeat an "Ask for changes" or "Remake this scene" whose storyboard
    never finished, so the note and the chosen scenes are not lost; else None (a plain produce)."""
    if last is None or last.get("jobType") != "changes" or last.get("status") not in ("failed", "canceled"):
        return None
    if last.get("contentId") != story.get("storyId") or "storyboard" not in (story.get("stale") or []):
        return None
    if not has_script(story):
        return None
    config = last.get("configuration") if isinstance(last.get("configuration"), Mapping) else {}
    note = (config or {}).get("note")
    known = set(_all_scenes(story))
    scenes = [str(s) for s in (config or {}).get("sceneIds") or [] if str(s) in known]
    note = note.strip() if isinstance(note, str) and note.strip() else None
    if note is None and not scenes:
        return None
    return note, scenes


def done_steps(story: Mapping[str, Any]) -> list[str]:
    """Steps a new job does not run show as done when the story was made before, else skipped."""
    return list(shapes.STEP_ORDER) if has_script(story) else []


def changes_input(
    body: Mapping[str, Any], story: Mapping[str, Any]
) -> tuple[str | None, list[str] | None, dict[str, str] | None]:
    """(the note, the scenes, the override for this job only)."""
    validate.only_keys(body, {"note", "sceneIds", "override"})
    note = body.get("note")
    if note is not None:
        if not isinstance(note, str):
            raise bad_request("note must be text.")
        note = note.strip()
        if len(note) > NOTE_MAX:
            raise bad_request(f"The note can be at most {NOTE_MAX} characters.")
    scene_ids = scene_list(body["sceneIds"], story) if body.get("sceneIds") is not None else None
    if not note and not scene_ids:
        raise bad_request("Write what to change, or pick a scene to remake.")
    return note or None, scene_ids, overrides.model_override(body.get("override"))


# --- approve --------------------------------------------------------------------------------------------------


def approve_problem(story: Mapping[str, Any]) -> str | None:
    """None when §45.9's approve rule holds, else the sentence of the 409."""
    if story.get("status") != "review":
        if story.get("status") == "needs_check":
            return _facts(story) or NOT_YET
        return "Only a video that is waiting for review can be approved."
    if shapes.ordered_steps(story.get("stale") or []):
        return NOT_YET
    safety = story.get("safety")
    if safety is None:
        return None
    if not isinstance(safety, Mapping):
        return NOT_YET
    if safety.get("status") == "ok" and safety.get("checkedScriptVersion") == story.get("scriptVersion"):
        return None
    if (
        safety.get("status") == "skipped"
        and story.get("category") != "driving_safety"
        and not story.get("safetyTopicId")
    ):
        return None  # the quality agent is off ("Quality check is off", §45.33); never for driving content (§45.34)
    return _facts(story) or NOT_YET


def carried_check(story: Mapping[str, Any], new_version: int) -> dict[str, Any] | None:
    """The fact check moved onto a new script version that changed no text it reads (effects, music, a scene's
    length: the captions, scene captions and the actions stay word for word), or None when there is nothing to carry
    (no check, a check that is due anyway, or one made on another version)."""
    safety = story.get("safety")
    if not isinstance(safety, Mapping) or safety.get("status") not in ("ok", "problems", "skipped"):
        return None
    if "safety" in (story.get("stale") or []):
        return None
    if safety.get("checkedScriptVersion") != story.get("scriptVersion"):
        return None
    return {**safety, "checkedScriptVersion": new_version}


def _facts(story: Mapping[str, Any]) -> str | None:
    safety = story.get("safety")
    if isinstance(safety, Mapping) and safety.get("status") == "problems":
        problems = [str(p) for p in safety.get("problems") or [] if str(p).strip()]
        if problems:
            return "Fix the facts first: " + " ".join(p if p.endswith(".") else p + "." for p in problems[:5])
    return None


# --- PATCH ----------------------------------------------------------------------------------------------------


def _caption_cue(value: Any, n: int) -> dict[str, Any]:
    cue = validate.obj(value, f"captions[{n}]")
    validate.only_keys(cue, {"id", "at", "dur", "text", "guidanceRef"})
    out: dict[str, Any] = {
        "id": validate.required_string(cue, "id", max_len=40),
        "at": _number(cue.get("at"), f"captions[{n}].at", 0, MAX_SECONDS),
        "dur": _number(cue.get("dur"), f"captions[{n}].dur", 0.2, 15),
        "text": validate.required_string(cue, "text", max_len=60),
    }
    if cue.get("guidanceRef") is not None:
        out["guidanceRef"] = validate.required_string(cue, "guidanceRef", max_len=80)
    return out


def _sfx_cue(value: Any, where: str) -> dict[str, Any]:
    cue = validate.obj(value, where)
    validate.only_keys(cue, {"id", "at", "sfx", "volume"})
    if cue.get("sfx") not in catalog.SFX:
        raise bad_request(f"{where}.sfx is not one of the sound effects.")
    return {
        "id": validate.required_string(cue, "id", max_len=40),
        "at": _number(cue.get("at"), f"{where}.at", 0, 15),
        "sfx": cue["sfx"],
        "volume": _number(cue.get("volume"), f"{where}.volume", 0, 1),
    }


def _unique_ids(items: list[dict[str, Any]], what: str) -> None:
    ids = [i["id"] for i in items]
    if len(ids) != len(set(ids)):
        raise bad_request(f"Two {what} have the same id.")


def patch_input(body: Mapping[str, Any]) -> dict[str, Any]:
    """StoryPatch (§45.6), checked."""
    validate.only_keys(
        body,
        {
            "version",
            "title",
            "postCaptions",
            "captions",
            "musicMood",
            "captionsOn",
            "scenes",
            "ai",
            "referenceIds",
            "format",
        },
    )
    out: dict[str, Any] = {"version": validate.integer(body.get("version"), "version", lo=1, hi=10**9)}
    if "title" in body:
        out["title"] = validate.required_string(body, "title", max_len=TITLE_MAX)
    if "postCaptions" in body:
        out["postCaptions"] = captions.patch(body["postCaptions"])
    if "ai" in body:
        out["ai"] = overrides.ai_setting(body["ai"]) if body["ai"] is not None else overrides.empty_setting()
    if "referenceIds" in body:
        out["referenceIds"] = reference_ids(body["referenceIds"] if body["referenceIds"] is not None else [])
    if "format" in body:
        out["format"] = video_format(body["format"])
    if "captions" in body:
        raw = body["captions"]
        if not isinstance(raw, list) or len(raw) > MAX_CAPTIONS:
            raise bad_request(f"captions must be a list of at most {MAX_CAPTIONS}.")
        out["captions"] = [_caption_cue(c, n) for n, c in enumerate(raw)]
        _unique_ids(out["captions"], "captions")
    if "musicMood" in body:
        if body["musicMood"] not in catalog.MUSIC_MOODS:
            raise bad_request("musicMood is not one of the music moods.")
        out["musicMood"] = body["musicMood"]
    if "captionsOn" in body:
        out["captionsOn"] = validate.boolean(body["captionsOn"], "captionsOn")
    if "scenes" in body:
        out["scenes"] = _scene_edits(body["scenes"])
    return out


def _scene_edits(raw_scenes: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_scenes, list) or not raw_scenes:
        raise bad_request("scenes must be a list of scene edits.")
    edits = []
    for n, raw_edit in enumerate(raw_scenes):
        where = f"scenes[{n}]"
        edit = validate.obj(raw_edit, where)
        validate.only_keys(edit, {"sceneId", "caption", "durationSec", "sfx"})
        clean: dict[str, Any] = {"sceneId": validate.required_string(edit, "sceneId", max_len=60)}
        if "caption" in edit:
            caption = edit["caption"]
            if caption is not None and not isinstance(caption, str):
                raise bad_request(f"{where}.caption must be text or null.")
            text = (caption or "").strip()
            if len(text) > 60:
                raise bad_request("A scene caption can be at most 60 characters.")
            clean["caption"] = text or None
        if "durationSec" in edit:
            clean["durationSec"] = _number(edit["durationSec"], f"{where}.durationSec", 2, 15)
        if "sfx" in edit:
            sfx = edit["sfx"]
            if not isinstance(sfx, list) or len(sfx) > MAX_SFX:
                raise bad_request(f"{where}.sfx must be a list of at most {MAX_SFX} sound effects.")
            clean["sfx"] = [_sfx_cue(c, f"{where}.sfx[{k}]") for k, c in enumerate(sfx)]
            _unique_ids(clean["sfx"], "sound effects")
        edits.append(clean)
    if len({e["sceneId"] for e in edits}) != len(edits):
        raise bad_request("Each scene can be edited once per change.")
    return edits


SCRIPT_FIELDS: Final = ("captions", "musicMood", "captionsOn", "scenes")


def touches_script(patch: Mapping[str, Any]) -> bool:
    return any(k in patch for k in SCRIPT_FIELDS)


def resizes(story: Mapping[str, Any], patch: Mapping[str, Any]) -> bool:
    """A new size for a story that has a storyboard: the storyboard is written again in that size (§45.34)."""
    changed = "format" in patch and patch["format"] != stored_format(story)
    return changed and has_script(story) and not story.get("videoKey")  # a made video's size is set (FORMAT_SET)


def needs_script(story: Mapping[str, Any], patch: Mapping[str, Any]) -> bool:
    return touches_script(patch) or resizes(story, patch)


def _remap(t: float, old: list[tuple[float, float]], new: list[tuple[float, float]]) -> float:
    """A whole-video time after scene lengths changed: same scene, same share of it."""
    for (o_start, o_len), (n_start, n_len) in zip(old, new, strict=True):
        if t < o_start + o_len or (o_start, o_len) == old[-1]:
            share = 0.0 if o_len <= 0 else min(max(t - o_start, 0.0), o_len) / o_len
            return round(n_start + share * n_len, 3)
    return t


def _bounds(lengths: list[float]) -> list[tuple[float, float]]:
    out, start = [], 0.0
    for length in lengths:
        out.append((start, length))
        start += length
    return out


@dataclass
class _Edit:
    """What one PATCH changes, gathered while it is applied."""

    sets: dict[str, Any] = field(default_factory=dict)
    stale: set[str] = field(default_factory=set)
    stale_scenes: set[str] = field(default_factory=set)
    format_stale: set[str] = field(default_factory=set)  # a new size: every picture is redone, the script stays
    owner: dict[str, list[str]] = field(
        default_factory=lambda: {"captions": [], "sceneCaptions": [], "postCaptions": []}
    )


def _story_fields(edit: _Edit, story: Mapping[str, Any], patch: Mapping[str, Any]) -> None:
    if "title" in patch and patch["title"] != story.get("title"):
        edit.sets["title"] = patch["title"]
    if "ai" in patch and patch["ai"] != shapes.ai_setting(story.get("ai")):
        edit.sets["ai"] = patch["ai"]  # for the next jobs only: nothing in the video changes
    if "referenceIds" in patch and patch["referenceIds"] != list(story.get("referenceIds") or []):
        edit.sets["referenceIds"] = patch["referenceIds"]  # read by the next storyboard: nothing becomes stale
    if "format" in patch and patch["format"] != stored_format(story):
        if story.get("videoKey"):  # the first run finished: the size is set (§45.34)
            raise conflict(FORMAT_SET)
        edit.sets["format"] = patch["format"]
        if has_script(story):  # positions are shares of the frame: a new storyboard version in the new size, and
            edit.format_stale.update(STALE_FORMAT)  # every picture is redone (§45.34: the script's size is it)
    if "postCaptions" in patch:
        merged = captions.merged(story.get("postCaptions"), patch["postCaptions"])
        if merged != captions.merged(story.get("postCaptions"), {}):
            edit.sets["postCaptions"] = merged
            edit.stale.update(STALE_POST)
            edit.owner["postCaptions"] = sorted(patch["postCaptions"])


def _switches(edit: _Edit, new: dict[str, Any], patch: Mapping[str, Any]) -> None:
    if "captionsOn" in patch and bool(new.get("captionsOn", True)) != patch["captionsOn"]:
        new["captionsOn"] = patch["captionsOn"]
        edit.sets["captionsOn"] = patch["captionsOn"]
        edit.stale.update(STALE_CAPTIONS)
    if "musicMood" in patch:
        old_music = new.get("music") if isinstance(new.get("music"), Mapping) else None
        if patch["musicMood"] != (old_music or {}).get("mood", "none"):
            volume = (old_music or {}).get("volume", 0.5)
            new["music"] = None if patch["musicMood"] == "none" else {"mood": patch["musicMood"], "volume": volume}
            edit.sets["musicMood"] = patch["musicMood"]
            edit.stale.update(STALE_SOUND)


def _scale_scene(scene: dict[str, Any], seconds: float) -> None:
    """A new scene length: its beats and effects keep their place in it (as ``fitDuration`` scales them)."""
    length = float(scene.get("durationSec") or 0)
    ratio = seconds / length if length > 0 else 1.0
    for beat in scene.get("beats") or []:
        if isinstance(beat, dict):
            beat["at"] = round(float(beat.get("at") or 0) * ratio, 3)
            beat["dur"] = round(float(beat.get("dur") or 0) * ratio, 3)
    scene["sfx"] = [
        {**cue, "at": round(float(cue.get("at") or 0) * ratio, 3)}
        for cue in scene.get("sfx") or []
        if isinstance(cue, Mapping)
    ]
    scene["durationSec"] = _int_or_float(seconds)


def _scene_edit(edit: _Edit, scene: dict[str, Any], change: Mapping[str, Any]) -> None:
    scene_id = str(change["sceneId"])
    if "durationSec" in change and abs(change["durationSec"] - float(scene.get("durationSec") or 0)) > 1e-6:
        _scale_scene(scene, change["durationSec"])
        edit.stale.update(STALE_LENGTH)
        edit.stale_scenes.add(scene_id)
    if "caption" in change and change["caption"] != scene.get("caption"):
        scene["caption"] = change["caption"]
        edit.stale.update(STALE_CAPTIONS)
        edit.owner["sceneCaptions"].append(scene_id)
    if "sfx" in change:
        limit = float(scene.get("durationSec") or 0)
        if any(c["at"] >= limit for c in change["sfx"]):
            raise bad_request(f"A sound effect in {scene.get('title') or scene_id} starts after the scene ends.")
        cues = [{**c, "at": _int_or_float(c["at"]), "volume": _int_or_float(c["volume"])} for c in change["sfx"]]
        if cues != list(scene.get("sfx") or []):
            scene["sfx"] = cues
            edit.stale.update(STALE_SOUND)


def _retime_captions(new: dict[str, Any], old_lengths: list[float], new_lengths: list[float]) -> None:
    old_b, new_b = _bounds(old_lengths), _bounds(new_lengths)
    for cue in new.get("captions") or []:
        if isinstance(cue, dict):
            start = float(cue.get("at") or 0)
            end = start + float(cue.get("dur") or 0)
            cue["at"] = _remap(start, old_b, new_b)
            cue["dur"] = max(0.2, round(_remap(end, old_b, new_b) - cue["at"], 3))
    new["durationSec"] = _int_or_float(round(sum(new_lengths), 3))


def _captions(edit: _Edit, new: dict[str, Any], given: list[dict[str, Any]], total: float) -> None:
    cues = [{**c, "at": _int_or_float(c["at"]), "dur": _int_or_float(c["dur"])} for c in given]
    if any(c["at"] >= total for c in cues):
        raise bad_request("A caption starts after the video ends.")
    if cues != list(new.get("captions") or []):
        old = {str(c.get("id")): c for c in new.get("captions") or [] if isinstance(c, Mapping)}
        edit.owner["captions"] = [c["id"] for c in cues if old.get(c["id"]) != c]
        new["captions"] = cues
        edit.stale.update(STALE_CAPTIONS)


def apply_patch(
    story: Mapping[str, Any], script: Mapping[str, Any] | None, patch: Mapping[str, Any]
) -> tuple[dict[str, Any] | None, dict[str, Any], set[str], set[str], dict[str, list[str]]]:
    """Applies a checked StoryPatch. Returns (the new script or None, story fields to set, steps made stale, scenes
    whose animation is stale, the owner's edited text ids)."""
    edit = _Edit()
    _story_fields(edit, story, patch)
    resize = "format" in edit.sets and has_script(story)
    if not touches_script(patch) and not resize:
        return None, edit.sets, edit.stale | edit.format_stale, edit.stale_scenes, edit.owner
    if script is None:
        raise conflict(NO_SCRIPT)
    new = copy.deepcopy(dict(script))
    if resize:  # the agent sizes every picture, the captions and the video from the script (StoryScript.width)
        new["width"], new["height"] = edit.sets["format"]["width"], edit.sets["format"]["height"]
    _switches(edit, new, patch)
    scenes = [dict(s) for s in new.get("scenes") or [] if isinstance(s, Mapping)]
    by_id = {str(s.get("sceneId")): s for s in scenes}
    old_lengths = [float(s.get("durationSec") or 0) for s in scenes]
    for change in patch.get("scenes") or []:
        scene = by_id.get(change["sceneId"])
        if scene is None:
            raise bad_request(f"This story has no scene {change['sceneId']}.")
        _scene_edit(edit, scene, change)
    new_lengths = [float(s.get("durationSec") or 0) for s in scenes]
    total = sum(new_lengths)
    if total > MAX_SECONDS:
        raise bad_request(f"The video would be {total:.1f} seconds long. Keep it under 90: make a scene shorter.")
    if new_lengths != old_lengths:
        _retime_captions(new, old_lengths, new_lengths)
    new["scenes"] = scenes
    if "captions" in patch:
        _captions(edit, new, patch["captions"], total)
    if (
        not resize
        and not edit.stale - set(STALE_POST)
        and not set(edit.sets)
        - {
            "title",
            "postCaptions",
            "ai",
            "referenceIds",
            "format",
        }
    ):
        return None, edit.sets, edit.stale | edit.format_stale, edit.stale_scenes, edit.owner
    edit.sets["scenes"] = [
        {"sceneId": str(s.get("sceneId")), "title": str(s.get("title") or ""), "durationSec": s.get("durationSec")}
        for s in scenes
    ]
    return new, edit.sets, edit.stale | edit.format_stale, edit.stale_scenes, edit.owner
