"""Saved "Make a new video" forms (docs/CONTRACTS.md §45.47, ADR-97).

A draft is its own ``VDRAFT#{draftId}`` item, never a ``STORY#`` (a story's ``draft`` status already means "Not made
yet"). At most 50 per workspace and 32 KB each. The form is checked **loosely**: types and limits only, because a
draft may be unfinished (no title yet, no cast yet, ids of characters that were deleted since). Unknown keys are 400,
as on every route. Pure: the routes are in ``routes/video_drafts.py``; ``create_story`` deletes the draft a video is
made from in the same write.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final, Protocol

from .. import validate
from ..errors import bad_request, too_large
from ..ids import is_ulid
from . import overrides, stories
from . import types as ws
from .types import VIDEO_DRAFT_SK

Item = dict[str, Any]

MAX_DRAFTS: Final = 50
MAX_DRAFT_BYTES: Final = 32_000
NAME_MAX: Final = 60
TEXT_MAX: Final = 2000  # loose: a draft may hold words the form will still ask to shorten
CATEGORY_MAX: Final = 40
MOOD_MAX: Final = 40
MAX_SCENES: Final = 40
MAX_WHO: Final = 12
WHO_MAX: Final = 80
MAX_ANSWERS: Final = 40
ANSWER_KEY_MAX: Final = 80
UNTITLED: Final = "Untitled video"
SOURCES: Final = ("idea", "own", "script")
FORM_KEYS: Final = (
    "source",
    "ideaId",
    "title",
    "logline",
    "category",
    "script",
    "characterIds",
    "roles",
    "seriesId",
    "durationSec",
    "format",
    "art",
    "captionsOn",
    "musicMood",
    "referenceIds",
    "ai",
)

TOO_MANY: Final = "You have 50 drafts. Delete one first."
TOO_BIG: Final = "This draft is too big to save. Make the script shorter."
NO_DRAFT: Final = "That draft is gone."
CHANGED: Final = "This draft changed on another screen. Open it again."


class DraftCtx(Protocol):
    """What ``new_item`` needs of a request (``routes.core.Ctx``)."""

    @property
    def user_id(self) -> str: ...

    @property
    def ws_id(self) -> str: ...

    @property
    def pk(self) -> str: ...

    def at(self) -> str: ...


def draft_sk(draft_id: str) -> str:
    return f"{VIDEO_DRAFT_SK}{draft_id}"


def _text(value: Any, field: str, max_len: int = TEXT_MAX) -> str:
    if not isinstance(value, str):
        raise bad_request(f"{field} must be text.", field)
    if len(value) > max_len:
        raise bad_request(f"{field} is too long (at most {max_len} characters).", field)
    return value


def _id(value: Any, field: str) -> str:
    if not (isinstance(value, str) and is_ulid(value)):
        raise bad_request(f"{field} is not valid.", field)
    return value


def _ids(value: Any, field: str, max_items: int) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and is_ulid(v) for v in value):
        raise bad_request(f"{field} must be a list of ids.", field)
    ids = list(dict.fromkeys(value))
    if len(ids) > max_items:
        raise bad_request(f"{field} can hold at most {max_items}.", field)
    return ids


def _scene(value: Any, field: str) -> Item:
    body = validate.obj(value, field)
    validate.only_keys(body, {"what", "caption", "who"})
    out: Item = {"what": _text(body.get("what", ""), f"{field}.what")}
    if body.get("caption") is not None:
        out["caption"] = _text(body["caption"], f"{field}.caption")
    if body.get("who") is not None:
        who = body["who"]
        if not isinstance(who, list) or len(who) > MAX_WHO:
            raise bad_request(f"{field}.who must be a list of at most {MAX_WHO}.", field)
        out["who"] = [_text(w, f"{field}.who", WHO_MAX) for w in who]
    return out


def _script(value: Any) -> Item:
    body = validate.obj(value, "form.script")
    validate.only_keys(body, {"scenes", "answers"})
    scenes = body.get("scenes", [])
    if not isinstance(scenes, list) or len(scenes) > MAX_SCENES:
        raise bad_request(f"form.script.scenes must be a list of at most {MAX_SCENES}.", "form.script")
    out: Item = {"scenes": [_scene(s, f"form.script.scenes[{n}]") for n, s in enumerate(scenes)]}
    if body.get("answers") is not None:
        answers = validate.obj(body["answers"], "form.script.answers")
        if len(answers) > MAX_ANSWERS:
            raise bad_request(f"form.script.answers can hold at most {MAX_ANSWERS}.", "form.script")
        out["answers"] = {
            _text(k, "form.script.answers", ANSWER_KEY_MAX): _text(v, "form.script.answers") for k, v in answers.items()
        }
    return out


def _roles(value: Any) -> Item:
    body = validate.obj(value, "form.roles")
    validate.only_keys(body, {"mainId", "villainId"})
    out: Item = {"mainId": _id(body.get("mainId"), "form.roles.mainId")}
    if body.get("villainId") is not None:
        out["villainId"] = _id(body["villainId"], "form.roles.villainId")
    return out


def draft_input(body: Any) -> Item:
    """A VideoDraftForm (§45.47), checked loosely: each key's type and limits; unknown keys are 400; whatever is left
    out stays out. Over 32 KB is 413."""
    form = validate.obj(body, "form")
    validate.only_keys(form, FORM_KEYS)
    out: Item = {}
    if form.get("source") is not None:
        if form["source"] not in SOURCES:
            raise bad_request("form.source must be idea, own or script.", "form.source")
        out["source"] = form["source"]
    if form.get("ideaId") is not None:
        out["ideaId"] = _id(form["ideaId"], "form.ideaId")
    for key in ("title", "logline"):
        if form.get(key) is not None:
            out[key] = _text(form[key], f"form.{key}")
    if form.get("category") is not None:
        out["category"] = _text(form["category"], "form.category", CATEGORY_MAX)
    if form.get("script") is not None:
        out["script"] = _script(form["script"])
    if form.get("characterIds") is not None:
        out["characterIds"] = _ids(form["characterIds"], "form.characterIds", stories.MAX_CAST)
    if form.get("roles") is not None:
        out["roles"] = _roles(form["roles"])
    if form.get("seriesId") is not None:
        out["seriesId"] = _id(form["seriesId"], "form.seriesId")
    elif "seriesId" in form:  # null: No series, picked on purpose
        out["seriesId"] = None
    if form.get("durationSec") is not None:
        out["durationSec"] = validate.integer(form["durationSec"], "form.durationSec", lo=15, hi=90)
    if form.get("format") is not None:
        out["format"] = stories.video_format(form["format"], "form.format")
    if form.get("art") is not None:
        out["art"] = stories.art_style(form["art"], "form.art")
    if form.get("captionsOn") is not None:
        out["captionsOn"] = validate.boolean(form["captionsOn"], "form.captionsOn")
    if form.get("musicMood") is not None:
        out["musicMood"] = _text(form["musicMood"], "form.musicMood", MOOD_MAX)
    if form.get("referenceIds") is not None:
        out["referenceIds"] = _ids(form["referenceIds"], "form.referenceIds", stories.MAX_REFERENCES)
    if form.get("ai") is not None:
        ai = overrides.model_override(form["ai"], "form.ai")
        if ai:
            out["ai"] = ai
    if len(json.dumps(out, ensure_ascii=False).encode()) > MAX_DRAFT_BYTES:
        raise too_large(TOO_BIG)
    return out


def name_of(form: Mapping[str, Any], idea_title: str | None = None) -> str:
    """The draft's name: its title, else the idea's title, else "Untitled video"; at most 60 letters."""
    for found in (form.get("title"), idea_title):
        name = " ".join(str(found or "").split())
        if name:
            return name[:NAME_MAX].rstrip()
    return UNTITLED


# The store drops null map values, so "No series, picked on purpose" (``seriesId: null``) is kept as "" and shown as
# null again (``shapes.public_video_draft``).
NO_SERIES_STORED: Final = ""


def stored_form(form: Mapping[str, Any]) -> Item:
    """The form as it is written: a null ``seriesId`` becomes ``NO_SERIES_STORED``."""
    out = dict(form)
    if "seriesId" in out and out["seriesId"] is None:
        out["seriesId"] = NO_SERIES_STORED
    return out


def new_item(ctx: DraftCtx, form: Mapping[str, Any], *, draft_id: str, name: str) -> Item:
    at = ctx.at()
    return {
        "pk": ctx.pk,
        "sk": draft_sk(draft_id),
        "type": ws.TYPE_VIDEO_DRAFT,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "draftId": draft_id,
        "name": name,
        "form": stored_form(form),
        "version": 1,
        "createdAt": at,
        "updatedAt": at,
    }
