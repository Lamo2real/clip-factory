"""Ideas: the owner's own, and the drafts of AI ideas, Expand and Variations (docs/CONTRACTS.md §45.7, ADR-74).

The API runs no model. AI ideas, Expand and Variations are tasks (``TASK#``) of the ``creative_director`` agent in
Lamo Stories' own runtime (``workspaces/tasks.py``); this module checks what the owner sends and the drafts a finished
task returns, and does the topic matching, which happens once, here in the API: when a draft is saved as an idea, when
an expanded concept is put on an idea, and when a story is created.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

from .. import validate
from ..errors import ApiError, bad_request
from ..ids import is_ulid
from . import guidance, overrides, shapes

TITLE_MAX = 80
LOGLINE_MAX = 280
TOPIC_MAX = 200
MAX_CHARACTERS = 3
TONES: Final = ("funny", "calm", "tense_then_relief", "wholesome")
SOURCES: Final = ("manual", "ai", "variation")
IDEA_KEYS: Final = ("title", "logline", "category", "characterIds", "concept", "source", "parentIdeaId")


# --- the owner's input -----------------------------------------------------------------------------------------


def _str_list(value: Any, field: str, *, max_items: int, max_len: int, min_items: int = 0) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise bad_request(f"{field} must be a list of text.")
    items = [v.strip() for v in value if v.strip()]
    if len(items) < min_items or len(items) > max_items:
        raise bad_request(f"{field} needs {min_items} to {max_items} lines.")
    for v in items:
        if len(v) > max_len:
            raise bad_request(f"Each line of {field} can be at most {max_len} characters.")
    return items


def concept(value: Any) -> dict[str, Any]:
    """A VideoConcept (§45.6), checked."""
    body = validate.obj(value, "concept")
    validate.only_keys(body, {"premise", "beats", "lesson", "ending", "tone", "durationSec", "onScreenText"})
    tone = body.get("tone")
    if tone not in TONES:
        raise bad_request("concept.tone must be funny, calm, tense_then_relief or wholesome.")
    lesson = body.get("lesson")
    if lesson is not None and not isinstance(lesson, str):
        raise bad_request("concept.lesson must be text or null.")
    lesson_text = (lesson or "").strip()
    if len(lesson_text) > LOGLINE_MAX:
        raise bad_request(f"concept.lesson can be at most {LOGLINE_MAX} characters.")
    return {
        "premise": validate.required_string(body, "premise", max_len=600),
        "beats": _str_list(body.get("beats"), "concept.beats", min_items=3, max_items=8, max_len=160),
        "lesson": lesson_text or None,
        "ending": validate.required_string(body, "ending", max_len=LOGLINE_MAX),
        "tone": tone,
        "durationSec": validate.integer(body.get("durationSec"), "concept.durationSec", lo=15, hi=90),
        "onScreenText": _str_list(body.get("onScreenText", []), "concept.onScreenText", max_items=6, max_len=60),
    }


def character_ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and is_ulid(v) for v in value):
        raise bad_request("characterIds must be a list of character ids.")
    ids = list(dict.fromkeys(value))
    if len(ids) > MAX_CHARACTERS:
        raise bad_request("Pick at most 3 characters.")
    return ids


def idea_input(body: Mapping[str, Any], *, partial: bool = False) -> dict[str, Any]:
    """IdeaInput (or a Partial of it), checked. Unknown keys are 400."""
    validate.only_keys(body, IDEA_KEYS)
    out: dict[str, Any] = {}
    if not partial or "title" in body:
        out["title"] = validate.required_string(body, "title", max_len=TITLE_MAX)
    if not partial or "logline" in body:
        out["logline"] = validate.required_string(body, "logline", max_len=LOGLINE_MAX)
    if not partial or "category" in body:
        if body.get("category") not in shapes.CATEGORIES:
            raise bad_request("category must be driving_safety, everyday_skills, comedy or explainer.")
        out["category"] = body["category"]
    if "characterIds" in body:
        out["characterIds"] = character_ids(body["characterIds"])
    if "concept" in body:
        out["concept"] = None if body["concept"] is None else concept(body["concept"])
    if "source" in body:
        if body["source"] not in SOURCES:
            raise bad_request("source must be manual, ai or variation.")
        out["source"] = body["source"]
    if "parentIdeaId" in body:
        parent = body["parentIdeaId"]
        if parent is not None and not (isinstance(parent, str) and is_ulid(parent)):
            raise bad_request("parentIdeaId is not valid.")
        out["parentIdeaId"] = parent
    return out


def idea_texts(idea: Mapping[str, Any]) -> list[str]:
    """Everything the topic match reads: the title, the line and the concept's words."""
    texts = [str(idea.get("title") or ""), str(idea.get("logline") or "")]
    c = idea.get("concept")
    if isinstance(c, Mapping):
        texts += [str(c.get("premise") or ""), str(c.get("lesson") or ""), str(c.get("ending") or "")]
        texts += [str(b) for b in c.get("beats") or []] + [str(t) for t in c.get("onScreenText") or []]
    return texts


def safety_fields(g: guidance.Guidance, idea: Mapping[str, Any], pick: str | None = None) -> dict[str, Any]:
    """``safetyTopicId`` and ``needsGuidance`` (§45.7): topic matching happens once, here."""
    if idea.get("category") != "driving_safety":
        return {"safetyTopicId": None, "needsGuidance": False}
    topic = guidance.match(g, idea_texts(idea), pick)
    return {"safetyTopicId": topic, "needsGuidance": topic is None}


# --- the task bodies (§45.5) -------------------------------------------------------------------------------------


def _category(value: Any) -> str:
    if value not in shapes.CATEGORIES:
        raise bad_request("category must be driving_safety, everyday_skills, comedy or explainer.")
    return str(value)


def generate_body(body: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, str] | None]:
    """``{ topic?, category?, count?: 1..6 (4), override? }`` → (the task's input, the override)."""
    validate.only_keys(body, {"topic", "category", "count", "override"})
    out: dict[str, Any] = {"count": validate.integer(body.get("count", 4), "count", lo=1, hi=6)}
    topic = validate.string(body, "topic", required=False, max_len=TOPIC_MAX)
    if topic:
        out["topic"] = topic
    if body.get("category") is not None:
        out["category"] = _category(body["category"])
    return out, overrides.model_override(body.get("override"))


def expand_body(
    body: Mapping[str, Any], idea: Mapping[str, Any], default_sec: int
) -> tuple[dict[str, Any], dict[str, str] | None]:
    """``{ durationSec?: 15..90, override? }`` for one saved idea (the concept's length, else the workspace's)."""
    validate.only_keys(body, {"durationSec", "override"})
    concept_now = idea.get("concept") if isinstance(idea.get("concept"), Mapping) else {}
    default = (concept_now or {}).get("durationSec") or default_sec
    duration = validate.integer(body.get("durationSec", default), "durationSec", lo=15, hi=90)
    return {"ideaId": str(idea["ideaId"]), "durationSec": duration}, overrides.model_override(body.get("override"))


def variations_body(body: Mapping[str, Any], idea: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, str] | None]:
    """``{ count?: 1..4 (3), override? }`` for one saved idea."""
    validate.only_keys(body, {"count", "override"})
    count = validate.integer(body.get("count", 3), "count", lo=1, hi=4)
    return {"ideaId": str(idea["ideaId"]), "count": count}, overrides.model_override(body.get("override"))


# --- what a finished task returns ----------------------------------------------------------------------------------


def drafts(
    raw: Any,
    *,
    known_characters: Iterable[str],
    source: str,
    category: str | None = None,
    parent_id: str | None = None,
    limit: int = 6,
) -> list[dict[str, Any]]:
    """The agent's drafts as ``IdeaInput`` the owner can save as they are (``POST …/ideas``): each one checked like
    an idea the owner types, characters only of this workspace, a variation keeping its idea's category and parent.
    A draft the checks refuse is left out; nothing is saved here (the owner taps Save)."""
    known = set(known_characters)
    out: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, Mapping):
            continue
        fields = {k: item[k] for k in ("title", "logline", "category", "concept") if item.get(k) is not None}
        if category is not None:
            fields["category"] = category
        try:
            draft = idea_input(fields)
        except ApiError:
            continue
        ids = [c for c in item.get("characterIds") or [] if isinstance(c, str) and c in known]
        if ids:
            draft["characterIds"] = list(dict.fromkeys(ids))[:MAX_CHARACTERS]
        draft["source"] = source
        if parent_id:
            draft["parentIdeaId"] = parent_id
        out.append(draft)
        if len(out) == limit:
            break
    return out


def expanded(raw: Any) -> tuple[dict[str, Any], str | None] | None:
    """(the checked concept, the agent's topic pick) from a finished Expand task's ``result``; None when unusable."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("concept"), Mapping):
        return None
    found = dict(raw["concept"])
    found.setdefault("lesson", None)
    found.setdefault("onScreenText", [])
    try:
        checked = concept({k: v for k, v in found.items() if k in CONCEPT_KEYS})
    except ApiError:
        return None
    pick = raw.get("topicId")
    return checked, pick if isinstance(pick, str) and pick else None


CONCEPT_KEYS: Final = ("premise", "beats", "lesson", "ending", "tone", "durationSec", "onScreenText")
