"""A character as the character agent may suggest it: a valid ``CharacterInput`` made only of the engine's choices
(docs/CONTRACTS.md §45.6, §45.8, §45.33).

A character is a rig, so the agent picks from the catalog's look and voice choices, faces, movement styles, noises
and effects; colours are ``#rrggbb``; sizes and pitch are clamped into their ranges. The same check serves the
"Design with AI" task and the chat's "Save this character" draft. Nothing is saved here: the owner saves the draft.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from typing import Any

from .catalog import ids
from .common import as_dict, as_list

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
NAME_MAX = 30
TEXT_MAX = 400
TRAITS_MAX = 8
TRAIT_MAX = 30
VOICE_LIST_MAX = 8


def _enum(values: list[str], description: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"type": "string", "enum": values}
    if description:
        out["description"] = description
    return out


def _obj(props: dict[str, Any], description: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
    }
    if description:
        out["description"] = description
    return out


def _hex(description: str) -> dict[str, Any]:
    return {"type": "string", "description": f"{description}, a colour as #rrggbb"}


def character_schema(cat: dict[str, Any]) -> dict[str, Any]:
    """The JSON schema of one ``CharacterInput`` built from the engine's catalog (limits are in the descriptions:
    structured outputs take no numeric or length limits, so code checks them)."""
    look = _obj(
        {
            "body": _enum(ids(cat, "looks", "body")),
            "skin": _hex("skin"),
            "height": {"type": "number", "description": "0.85 to 1.15 (1 is average)"},
            "width": {"type": "number", "description": "0.85 to 1.15 (1 is average)"},
            "hair": _obj({"style": _enum(ids(cat, "looks", "hair")), "color": _hex("hair")}),
            "eyes": _obj({"shape": _enum(ids(cat, "looks", "eyes")), "color": _hex("eyes")}),
            "brows": _enum(ids(cat, "looks", "brows")),
            "nose": _enum(ids(cat, "looks", "nose")),
            "mouth": _enum(ids(cat, "looks", "mouth")),
            "outfit": _obj(
                {
                    "top": _hex("top"),
                    "bottom": _hex("bottom"),
                    "accent": _hex("accent"),
                    "pattern": _enum(ids(cat, "looks", "pattern")),
                }
            ),
            "accessory": _enum(ids(cat, "looks", "accessory")),
            "outline": _hex("outline (a dark colour)"),
        }
    )
    voice = _obj(
        {
            "style": _enum(ids(cat, "looks", "voiceStyle")),
            "pitch": {"type": "number", "description": "0.5 (deep) to 2 (squeaky); 1 is average"},
            "noises": {"type": "array", "items": _enum(ids(cat, "noises")), "description": "up to 8 noises it makes"},
            "sfx": {"type": "array", "items": _enum(ids(cat, "sfx")), "description": "up to 8 favourite effects"},
        }
    )
    return _obj(
        {
            "name": {"type": "string", "description": f"1 to {NAME_MAX} characters, not a name already used"},
            "description": {
                "type": "string",
                "description": f"how it looks and who it is, at most {TEXT_MAX} characters",
            },
            "personality": {"type": "string", "description": f"at most {TEXT_MAX} characters"},
            "traits": {
                "type": "array",
                "items": {"type": "string"},
                "description": "up to 8 short traits, 30 characters each",
            },
            "movementStyle": _enum(ids(cat, "movementStyles")),
            "expressions": {
                "type": "array",
                "items": _enum(ids(cat, "expressions")),
                "description": "the faces it uses: at least 3, always neutral",
            },
            "look": look,
            "voice": voice,
        }
    )


def _clamp(value: Any, lo: float, hi: float, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(v):
        return default
    return round(min(hi, max(lo, v)), 3)


def check_character(
    raw: Any, cat: dict[str, Any], *, taken_names: Iterable[str] = ()
) -> tuple[dict[str, Any] | None, list[str]]:
    """``(CharacterInput, problems)``: the value is ``None`` when a choice is not the engine's or something required is
    missing; lengths over a limit are cut (and reported, so the first answer is asked again)."""
    if not isinstance(raw, dict):
        return None, ["the answer must be one character object"]
    problems: list[str] = []
    soft: list[str] = []
    taken = {n.strip().lower() for n in taken_names}

    def text(key: str, limit: int, *, required: bool = False) -> str:
        value = raw.get(key)
        s = value.strip() if isinstance(value, str) else ""
        if required and not s:
            problems.append(f"{key} is required")
        if len(s) > limit:
            soft.append(f"{key} must be at most {limit} characters")
        return s[:limit]

    def pick(value: Any, allowed: list[str], where: str) -> str:
        if value not in allowed:
            problems.append(f"{where} must be one of: {', '.join(allowed)}")
            return allowed[0] if allowed else ""
        return str(value)

    def colour(value: Any, where: str) -> str:
        if not isinstance(value, str) or not HEX.match(value.strip()):
            problems.append(f"{where} must be a colour like #3a7bd5")
            return "#000000"
        return value.strip().lower()

    name = text("name", NAME_MAX, required=True)
    if name and name.lower() in taken:
        problems.append(f"the name {name} is already used by another character; pick a new name")
    traits_raw = as_list(raw.get("traits"))
    traits = [t.strip() for t in traits_raw if isinstance(t, str) and t.strip()]
    if len(traits) > TRAITS_MAX or any(len(t) > TRAIT_MAX for t in traits):
        soft.append(f"traits: at most {TRAITS_MAX}, each at most {TRAIT_MAX} characters")
    traits = [t[:TRAIT_MAX] for t in traits]
    faces_allowed = ids(cat, "expressions")
    faces_raw = as_list(raw.get("expressions"))
    faces = list(dict.fromkeys(str(f) for f in faces_raw))
    bad_faces = [f for f in faces if f not in faces_allowed]
    if bad_faces:
        soft.append(f"expressions must come from: {', '.join(faces_allowed)}")
    faces = [f for f in faces if f in faces_allowed]
    if "neutral" in faces_allowed and "neutral" not in faces:
        faces.insert(0, "neutral")
    if len(faces) < 3:
        problems.append("expressions needs at least 3 faces")

    look_raw = as_dict(raw.get("look"))
    hair = as_dict(look_raw.get("hair"))
    eyes = as_dict(look_raw.get("eyes"))
    outfit = as_dict(look_raw.get("outfit"))
    if not look_raw:
        problems.append("look is required")
    look = {
        "body": pick(look_raw.get("body"), ids(cat, "looks", "body"), "look.body"),
        "skin": colour(look_raw.get("skin"), "look.skin"),
        "height": _clamp(look_raw.get("height"), 0.85, 1.15, 1.0),
        "width": _clamp(look_raw.get("width"), 0.85, 1.15, 1.0),
        "hair": {
            "style": pick(hair.get("style"), ids(cat, "looks", "hair"), "look.hair.style"),
            "color": colour(hair.get("color"), "look.hair.color"),
        },
        "eyes": {
            "shape": pick(eyes.get("shape"), ids(cat, "looks", "eyes"), "look.eyes.shape"),
            "color": colour(eyes.get("color"), "look.eyes.color"),
        },
        "brows": pick(look_raw.get("brows"), ids(cat, "looks", "brows"), "look.brows"),
        "nose": pick(look_raw.get("nose"), ids(cat, "looks", "nose"), "look.nose"),
        "mouth": pick(look_raw.get("mouth"), ids(cat, "looks", "mouth"), "look.mouth"),
        "outfit": {
            "top": colour(outfit.get("top"), "look.outfit.top"),
            "bottom": colour(outfit.get("bottom"), "look.outfit.bottom"),
            "accent": colour(outfit.get("accent"), "look.outfit.accent"),
            "pattern": pick(outfit.get("pattern"), ids(cat, "looks", "pattern"), "look.outfit.pattern"),
        },
        "accessory": pick(look_raw.get("accessory"), ids(cat, "looks", "accessory"), "look.accessory"),
        "outline": colour(look_raw.get("outline"), "look.outline"),
    }
    voice_raw = as_dict(raw.get("voice"))

    def some(value: Any, allowed: list[str], where: str) -> list[str]:
        items = list(dict.fromkeys(str(v) for v in value)) if isinstance(value, list) else []
        if any(v not in allowed for v in items):
            soft.append(f"{where} must come from: {', '.join(allowed)}")
        kept = [v for v in items if v in allowed]
        if len(kept) > VOICE_LIST_MAX:
            soft.append(f"{where}: at most {VOICE_LIST_MAX}")
        return kept[:VOICE_LIST_MAX]

    voice = {
        "style": pick(voice_raw.get("style"), ids(cat, "looks", "voiceStyle"), "voice.style"),
        "pitch": _clamp(voice_raw.get("pitch"), 0.5, 2.0, 1.0),
        "noises": some(voice_raw.get("noises"), ids(cat, "noises"), "voice.noises"),
        "sfx": some(voice_raw.get("sfx"), ids(cat, "sfx"), "voice.sfx"),
    }
    value = {
        "name": name,
        "description": text("description", TEXT_MAX),
        "personality": text("personality", TEXT_MAX),
        "traits": traits[:TRAITS_MAX],
        "movementStyle": pick(raw.get("movementStyle"), ids(cat, "movementStyles"), "movementStyle"),
        "expressions": faces,
        "look": look,
        "voice": voice,
    }
    if problems:
        return None, problems + soft
    return value, soft
