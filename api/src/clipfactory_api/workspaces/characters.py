"""Characters: rigs that look and move the same in every video (docs/CONTRACTS.md §45.8).

``character_input`` checks a CharacterInput against the engine's vocabulary (``catalog.py``): a person (the default:
an older item has no kind) or a car (§45.42), which has a CarLook instead of a person's look, no voice and no noises,
only favourite effects, and only the neutral face unless it has eyes. ``cast_problem`` keeps a cast to at most one
car, with someone to drive it (§45.43). The same rules are the engine's ``validateCharacter`` and the agent's
``check_car``. Reference images are
the owner's uploads (png, jpeg or webp, at most 10 MB, at most 8), kept under the character's own prefix
``ws/{userId}/{workspaceId}/characters/{characterId}/refs/{assetId}.{ext}``; they never change the rig.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from typing import Any, Final

from .. import validate
from ..errors import bad_request
from . import catalog, shapes

NAME_MAX = 30
TEXT_MAX = 400
MAX_TRAITS = 8
TRAIT_MAX = 30
MIN_EXPRESSIONS = 3
MAX_SOUNDS = 8
MAX_REFERENCES = 8
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
UPLOAD_SECONDS = 15 * 60
PENDING_LIMIT = 8
REFERENCE_TYPES: Final = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
CHARACTER_KEYS: Final = shapes.CHARACTER_FIELDS
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
NO_KIND = "Pick a person or a car."
CAR_VOICE = "A car has no voice. Pick its sounds instead."
CAR_FACES = "A car with no face keeps only the neutral face."
FACES_RULE = "Pick at least 3 faces, and keep the neutral face."
PERSON_CAR = "Only a car has a car look."
ONE_CAR = "Pick one car."
NEEDS_DRIVER = "Add someone to drive it."


def _choice(value: Any, field: str, options: tuple[str, ...]) -> str:
    if value not in options:
        raise bad_request(f"{field} must be one of: {', '.join(options)}.")
    return str(value)


def _hex(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _HEX.match(value):
        raise bad_request(f"{field} must be a colour like #ffc94a.")
    return value.lower()


def _number(value: Any, field: str, lo: float, hi: float) -> float | int:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise bad_request(f"{field} must be a number.")
    if not lo <= value <= hi:
        raise bad_request(f"{field} must be between {lo:g} and {hi:g}.")
    return value


def _text(body: Mapping[str, Any], field: str, max_len: int) -> str:
    value = body.get(field, "")
    if not isinstance(value, str):
        raise bad_request(f"{field} must be text.")
    value = value.strip()
    if len(value) > max_len:
        raise bad_request(f"{field} is too long (at most {max_len} characters).")
    return value


def look(value: Any) -> dict[str, Any]:
    body = validate.obj(value, "look")
    validate.only_keys(
        body,
        {"body", "skin", "height", "width", "hair", "eyes", "brows", "nose", "mouth", "outfit", "accessory", "outline"},
    )
    hair = validate.obj(body.get("hair"), "look.hair")
    validate.only_keys(hair, {"style", "color"})
    eyes = validate.obj(body.get("eyes"), "look.eyes")
    validate.only_keys(eyes, {"shape", "color"})
    outfit = validate.obj(body.get("outfit"), "look.outfit")
    validate.only_keys(outfit, {"top", "bottom", "accent", "pattern"})
    return {
        "body": _choice(body.get("body"), "look.body", catalog.LOOK_BODIES),
        "skin": _hex(body.get("skin"), "look.skin"),
        "height": _number(body.get("height"), "look.height", 0.85, 1.15),
        "width": _number(body.get("width"), "look.width", 0.85, 1.15),
        "hair": {
            "style": _choice(hair.get("style"), "look.hair.style", catalog.HAIR_STYLES),
            "color": _hex(hair.get("color"), "look.hair.color"),
        },
        "eyes": {
            "shape": _choice(eyes.get("shape"), "look.eyes.shape", catalog.EYE_SHAPES),
            "color": _hex(eyes.get("color"), "look.eyes.color"),
        },
        "brows": _choice(body.get("brows"), "look.brows", catalog.BROWS),
        "nose": _choice(body.get("nose"), "look.nose", catalog.NOSES),
        "mouth": _choice(body.get("mouth"), "look.mouth", catalog.MOUTHS),
        "outfit": {
            "top": _hex(outfit.get("top"), "look.outfit.top"),
            "bottom": _hex(outfit.get("bottom"), "look.outfit.bottom"),
            "accent": _hex(outfit.get("accent"), "look.outfit.accent"),
            "pattern": _choice(outfit.get("pattern"), "look.outfit.pattern", catalog.PATTERNS),
        },
        "accessory": _choice(body.get("accessory"), "look.accessory", catalog.ACCESSORIES),
        "outline": _hex(body.get("outline"), "look.outline"),
    }


def car_look(value: Any) -> dict[str, Any]:
    """A CarLook (§45.42): catalog choices, #rrggbb colours and numbers in range; unknown keys are 400."""
    body = validate.obj(value, "car")
    validate.only_keys(
        body,
        {"body", "length", "height", "paint", "accent", "pattern", "windows", "wheels", "lights", "extra", "face",
         "outline"},
    )  # fmt: skip
    wheels = validate.obj(body.get("wheels"), "car.wheels")
    validate.only_keys(wheels, {"style", "rim", "size"})
    lights = validate.obj(body.get("lights"), "car.lights")
    validate.only_keys(lights, {"front", "rear"})
    face = validate.obj(body.get("face"), "car.face")
    validate.only_keys(face, {"eyes", "color", "mouth"})
    return {
        "body": _choice(body.get("body"), "car.body", catalog.CAR_BODIES),
        "length": _number(body.get("length"), "car.length", 0.85, 1.15),
        "height": _number(body.get("height"), "car.height", 0.85, 1.15),
        "paint": _hex(body.get("paint"), "car.paint"),
        "accent": _hex(body.get("accent"), "car.accent"),
        "pattern": _choice(body.get("pattern"), "car.pattern", catalog.CAR_PATTERNS),
        "windows": _choice(body.get("windows"), "car.windows", catalog.CAR_WINDOWS),
        "wheels": {
            "style": _choice(wheels.get("style"), "car.wheels.style", catalog.CAR_WHEELS),
            "rim": _hex(wheels.get("rim"), "car.wheels.rim"),
            "size": _number(wheels.get("size"), "car.wheels.size", 0.85, 1.2),
        },
        "lights": {
            "front": _choice(lights.get("front"), "car.lights.front", catalog.CAR_FRONT_LIGHTS),
            "rear": _choice(lights.get("rear"), "car.lights.rear", catalog.CAR_REAR_LIGHTS),
        },
        "extra": _choice(body.get("extra"), "car.extra", catalog.CAR_EXTRAS),
        "face": {
            "eyes": _choice(face.get("eyes"), "car.face.eyes", catalog.CAR_EYES),
            "color": _hex(face.get("color"), "car.face.color"),
            "mouth": _choice(face.get("mouth"), "car.face.mouth", catalog.CAR_MOUTHS),
        },
        "outline": _hex(body.get("outline"), "car.outline"),
    }


def kind_of(body: Mapping[str, Any]) -> str:
    """``person`` (the default) or ``car``; anything else is 400."""
    value = body.get("kind")
    if value is None:
        return "person"
    if value not in catalog.CHARACTER_KINDS:
        raise bad_request(NO_KIND, "kind")
    return str(value)


def _ids(value: Any, field: str, options: tuple[str, ...], max_items: int) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise bad_request(f"{field} must be a list.")
    out = list(dict.fromkeys(value))
    if len(out) > max_items:
        raise bad_request(f"{field} can hold at most {max_items}.")
    for v in out:
        _choice(v, field, options)
    return out


def voice(value: Any) -> dict[str, Any]:
    body = validate.obj(value, "voice")
    validate.only_keys(body, {"style", "pitch", "noises", "sfx"})
    return {
        "style": _choice(body.get("style"), "voice.style", catalog.VOICE_STYLES),
        "pitch": _number(body.get("pitch"), "voice.pitch", 0.5, 2),
        "noises": _ids(body.get("noises", []), "voice.noises", catalog.NOISES, MAX_SOUNDS),
        "sfx": _ids(body.get("sfx", []), "voice.sfx", catalog.SFX, MAX_SOUNDS),
    }


def _car_voice(value: Any) -> dict[str, Any]:
    """A car's voice: style none and no noises (else ``CAR_VOICE``), up to 8 favourite effects, pitch stored as 1."""
    body = validate.obj(value, "voice")
    validate.only_keys(body, {"style", "pitch", "noises", "sfx"})
    if body.get("style", "none") != "none" or body.get("noises") not in (None, []):
        raise bad_request(CAR_VOICE, "voice")
    if body.get("pitch") is not None:
        _number(body.get("pitch"), "voice.pitch", 0.5, 2)
    return {
        "style": "none",
        "pitch": 1,
        "noises": [],
        "sfx": _ids(body.get("sfx", []), "voice.sfx", catalog.SFX, MAX_SOUNDS),
    }


def character_input(body: Mapping[str, Any], *, extra: tuple[str, ...] = ()) -> dict[str, Any]:
    """CharacterInput (§45.6, §45.42), checked; unknown keys are 400. It has every key of ``shapes.CHARACTER_FIELDS``:
    a person's ``car`` is None, and a car's ``look`` is None (whatever was sent)."""
    validate.only_keys(body, (*CHARACTER_KEYS, *extra))
    kind = kind_of(body)
    name = validate.required_string(body, "name", max_len=NAME_MAX)
    traits_raw = body.get("traits", [])
    if not isinstance(traits_raw, list) or not all(isinstance(t, str) for t in traits_raw):
        raise bad_request("traits must be a list of words.")
    traits = list(dict.fromkeys(t.strip() for t in traits_raw if t.strip()))
    if len(traits) > MAX_TRAITS:
        raise bad_request(f"Pick at most {MAX_TRAITS} traits.")
    if any(len(t) > TRAIT_MAX for t in traits):
        raise bad_request(f"Each trait can be at most {TRAIT_MAX} characters.")
    expressions = _ids(body.get("expressions"), "expressions", catalog.EXPRESSIONS, len(catalog.EXPRESSIONS))
    car: dict[str, Any] | None = None
    if kind == "car":
        car = car_look(body.get("car"))
        if car["face"]["eyes"] == "none":
            if expressions != ["neutral"]:
                raise bad_request(CAR_FACES, "expressions")
        elif len(expressions) < MIN_EXPRESSIONS or "neutral" not in expressions:
            raise bad_request(FACES_RULE)
        rig: dict[str, Any] | None = None
        sounds = _car_voice(body.get("voice"))
    else:
        if body.get("car") is not None:
            raise bad_request(PERSON_CAR, "car")
        if len(expressions) < MIN_EXPRESSIONS or "neutral" not in expressions:
            raise bad_request(FACES_RULE)
        rig = look(body.get("look"))
        sounds = voice(body.get("voice"))
    return {
        "name": name,
        "description": _text(body, "description", TEXT_MAX),
        "personality": _text(body, "personality", TEXT_MAX),
        "traits": traits,
        "movementStyle": _choice(body.get("movementStyle"), "movementStyle", catalog.MOVEMENT_STYLES),
        "expressions": expressions,
        "look": rig,
        "voice": sounds,
        "kind": kind,
        "car": car,
    }


def cast_problem(items: Iterable[Mapping[str, Any]]) -> str | None:
    """A story's or a series' cast (§45.43): at most one car, and someone to drive it. None when it is fine."""
    kinds = [str(i.get("kind") or "person") for i in items]
    cars = kinds.count("car")
    if cars >= 2:
        return ONE_CAR
    if cars == 1 and len(kinds) == 1:
        return NEEDS_DRIVER
    return None


def same_name(a: Any, b: Any) -> bool:
    return " ".join(str(a or "").lower().split()) == " ".join(str(b or "").lower().split())


def reference_key(prefix: str, asset_id: str, content_type: str) -> str:
    """``{characterPrefix}refs/{assetId}.{png|jpg|webp}``."""
    return f"{prefix}refs/{asset_id}.{REFERENCE_TYPES[content_type]}"
