"""A character as the character agent may suggest it: a valid ``CharacterInput`` made only of the engine's choices
(docs/CONTRACTS.md §45.6, §45.8, §45.33).

A character is a rig, so the agent picks from the catalog's look and voice choices, faces, movement styles, noises
and effects; colours are ``#rrggbb``; sizes and pitch are clamped into their ranges. The same check serves the
"Design with AI" task and the chat's "Save this character" draft. Nothing is saved here: the owner saves the draft.

A car character (§45.42) has a ``car`` look from ``catalog.carLooks`` instead of a person's look, no voice (style
``none``, pitch 1, no noises) and only favourite effects; with no eyes it keeps only the neutral face. ``check_car``
is the same rule set as the API's ``characters.character_input`` and the engine's ``validateCharacter``, and it keeps
car makes out of the words (``BRANDS``): the animator draws no badges and only plain plates.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
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


# --- cars (§45.42) -------------------------------------------------------------------------------------------------

# Car makes, matched as whole words in any case: a car character is never named or described by its make. Common
# English words that are also makes (mini, seat, smart, ram, lucid, alpine) are left out on purpose.
BRANDS: frozenset[str] = frozenset(
    {
        "abarth", "alfa romeo", "aston martin", "audi", "bentley", "bmw", "bugatti", "buick", "byd", "cadillac",
        "chevrolet", "chevy", "chrysler", "citroen", "citroën", "cupra", "dacia", "daewoo", "daihatsu", "datsun",
        "dodge", "ferrari", "fiat", "ford", "geely", "gmc", "holden", "honda", "hummer", "hyundai", "infiniti",
        "isuzu", "jaguar", "jeep", "kia", "lada", "lamborghini", "lancia", "land rover", "lexus", "lincoln",
        "maserati", "maybach", "mazda", "mclaren", "mercedes", "mercedes-benz", "mitsubishi", "nissan", "opel",
        "peugeot", "polestar", "pontiac", "porsche", "proton", "renault", "rivian", "rolls-royce", "rover", "saab",
        "skoda", "škoda", "subaru", "suzuki", "tesla", "toyota", "vauxhall", "volkswagen", "volvo", "vw",
    }
)  # fmt: skip
# Model names and nicknames that are not also everyday words (golf, beetle, mustang, polo, focus, leaf stay out), so
# a car is never called "Corolla" or "the Merc" either.
MODELS: frozenset[str] = frozenset(
    {
        "astra", "beemer", "bimmer", "camaro", "camry", "civic", "clio", "corolla", "corsa", "corvette", "cr-v",
        "cx-5", "elantra", "f-150", "f150", "fabia", "hilux", "impreza", "jetta", "lambo", "land cruiser",
        "landcruiser", "megane", "mégane", "merc", "miata", "micra", "mini cooper", "model 3", "model s", "model x",
        "model y", "mx-5", "octavia", "passat", "picanto", "prius", "qashqai", "range rover", "rav4", "sportage",
        "tiguan", "twingo", "yaris", "zafira",
    }
)  # fmt: skip
# Whole words in any case: nothing may come right before (a letter or a hyphen) or a letter right after, so
# "BMW-ish" is caught and "Fordham" is not.
_BRAND = re.compile(
    r"(?<![\w-])(" + "|".join(re.escape(b) for b in sorted(BRANDS | MODELS, key=len, reverse=True)) + r")(?!\w)",
    re.I,
)
_CAR_CAR = re.compile(r"\bcar(?: car)+\b")
NO_BRANDS = "do not use car brand or model names"
CAR_FACES_ON = ("happy", "surprised")

# The 14 plain colour words a car's paint is called by (image models and writers read words better than hex).
CAR_COLOURS: dict[str, tuple[int, int, int]] = {
    "red": (216, 53, 42),
    "orange": (255, 140, 40),
    "yellow": (245, 200, 50),
    "green": (60, 150, 70),
    "teal": (40, 150, 150),
    "blue": (47, 111, 209),
    "navy": (28, 34, 80),
    "purple": (122, 79, 209),
    "pink": (255, 143, 177),
    "brown": (110, 70, 40),
    "beige": (225, 205, 170),
    "white": (244, 241, 234),
    "silver": (170, 175, 182),
    "black": (28, 28, 34),
}
_BODY_WORDS = {
    "hatchback": "hatchback",
    "sedan": "saloon",
    "estate": "estate",
    "suv": "SUV",
    "pickup": "pickup",
    "van": "van",
    "sports": "sports car",
    "compact": "tiny car",
}
_WHEEL_WORDS = {
    "steel": "steel wheels",
    "hubcap": "hubcaps",
    "alloy": "alloy wheels",
    "sport": "sporty wheels",
    "offroad": "off-road tyres",
}
_EYE_WORDS = {"windscreen": "eyes on its windscreen", "headlights": "headlight eyes"}


def car_colour(hex_color: Any) -> str:
    """The nearest of the 14 plain colour words for ``#rrggbb``."""
    try:
        r, g, b = (int(str(hex_color)[i : i + 2], 16) for i in (1, 3, 5))
    except ValueError:
        return "red"
    return min(CAR_COLOURS, key=lambda n: sum((x - y) ** 2 for x, y in zip(CAR_COLOURS[n], (r, g, b), strict=True)))


def car_words(car: Mapping[str, Any]) -> str:
    """The car in plain words, at most 80 characters: "a small red hatchback with alloy wheels and round lights"."""
    try:
        length = float(car.get("length") or 1)
    except (TypeError, ValueError):
        length = 1.0
    size = "small " if length < 0.95 else "long " if length > 1.05 else ""
    body = _BODY_WORDS.get(str(car.get("body")), "car")
    head = f"{size}{car_colour(car.get('paint'))} {body}"
    head = ("an " if head[0] in "aeiou" else "a ") + head
    wheels = _WHEEL_WORDS.get(str((car.get("wheels") or {}).get("style")), "wheels")
    lights = f"{(car.get('lights') or {}).get('front') or 'round'} lights"
    eyes = _EYE_WORDS.get(str((car.get("face") or {}).get("eyes")))
    for words in (
        f"{head} with {wheels}, {lights} and {eyes}" if eyes else f"{head} with {wheels} and {lights}",
        f"{head} with {eyes}" if eyes else f"{head} with {wheels}",
        head,
    ):
        if len(words) <= 80:
            return words
    return head[:80]


def strip_brands(text: str) -> tuple[str, list[str]]:
    """The text with every car make, model or nickname replaced by "car", and the ones found."""
    found = [m.group(1) for m in _BRAND.finditer(text)]
    if not found:
        return text, []
    return _CAR_CAR.sub("car", " ".join(_BRAND.sub("car", text).split())), found  # "Toyota Corolla": one "car"


def car_schema(cat: dict[str, Any]) -> dict[str, Any]:
    """The JSON schema of one car ``CharacterInput`` (kind "car") built from ``catalog.carLooks``; limits are in the
    descriptions, as for people, and code checks them."""
    car = _obj(
        {
            "body": _enum(ids(cat, "carLooks", "body"), "the closest body to the real car"),
            "length": {"type": "number", "description": "0.85 to 1.15 (1 is the body's usual length)"},
            "height": {"type": "number", "description": "0.85 to 1.15 (1 is the body's usual height)"},
            "paint": _hex("the main body panels' colour"),
            "accent": _hex("the second colour: roof and pillars (two_tone), the stripes, the mirror caps"),
            "pattern": _enum(ids(cat, "carLooks", "pattern")),
            "windows": _enum(ids(cat, "carLooks", "windows")),
            "wheels": _obj(
                {
                    "style": _enum(ids(cat, "carLooks", "wheels")),
                    "rim": _hex("rims"),
                    "size": {"type": "number", "description": "0.85 to 1.2 (1 is usual)"},
                }
            ),
            "lights": _obj(
                {"front": _enum(ids(cat, "carLooks", "frontLights")), "rear": _enum(ids(cat, "carLooks", "rearLights"))}
            ),
            "extra": _enum(ids(cat, "carLooks", "extra"), "only when the photos show one"),
            "face": _obj(
                {
                    "eyes": _enum(ids(cat, "carLooks", "eyes"), "none: a real-looking car (the default)"),
                    "color": _hex("eyes"),
                    "mouth": _enum(ids(cat, "carLooks", "mouth")),
                }
            ),
            "outline": _hex("outline (a dark colour)"),
        }
    )
    voice = _obj(
        {
            "style": _enum(["none"], "a car has no voice"),
            "pitch": {"type": "number", "description": "always 1"},
            "noises": {"type": "array", "items": _enum(ids(cat, "noises")), "maxItems": 0, "description": "none"},
            "sfx": {"type": "array", "items": _enum(ids(cat, "sfx")), "description": "up to 8 favourite effects"},
        }
    )
    return _obj(
        {
            "kind": _enum(["car"]),
            "name": {
                "type": "string",
                "description": f"1 to {NAME_MAX} characters, not a name already used, never a make",
            },
            "description": {"type": "string", "description": f"how it looks, at most {TEXT_MAX} characters, no make"},
            "personality": {"type": "string", "description": f"at most {TEXT_MAX} characters"},
            "traits": {"type": "array", "items": {"type": "string"}, "description": "up to 8 short traits, no make"},
            "movementStyle": _enum(ids(cat, "movementStyles")),
            "expressions": {
                "type": "array",
                "items": _enum(ids(cat, "expressions")),
                "description": 'with no eyes only ["neutral"]; with eyes at least 3, always neutral',
            },
            "car": car,
            "voice": voice,
        }
    )


def check_car(
    raw: Any, cat: dict[str, Any], *, taken_names: Iterable[str] = ()
) -> tuple[dict[str, Any] | None, list[str]]:
    """``(car CharacterInput, problems)``: the value is ``None`` when a choice is not the engine's, something required
    is missing or the name is taken; numbers are clamped, the voice is forced to none, a car with no eyes keeps only
    the neutral face, and a make in the words is replaced by "car" (and reported, so the first answer is asked
    again)."""
    if not isinstance(raw, dict):
        return None, ["each option must be one car object"]
    problems: list[str] = []
    soft: list[str] = []
    taken = {n.strip().lower() for n in taken_names}
    brands: list[str] = []

    def words(value: Any, limit: int, key: str, *, required: bool = False) -> str:
        s = value.strip() if isinstance(value, str) else ""
        s, found = strip_brands(s)
        brands.extend(found)
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
            problems.append(f"{where} must be a colour like #d8352a")
            return "#000000"
        return value.strip().lower()

    name = words(raw.get("name"), NAME_MAX, "name", required=True)
    if name.lower() == "car" and brands:
        name = "Car"
    if name and name.lower() in taken:
        problems.append(f"the name {name} is already used by another character; pick a new name")
    traits = [words(t, 10**6, "traits") for t in as_list(raw.get("traits")) if isinstance(t, str) and t.strip()]
    traits = [t for t in dict.fromkeys(traits) if t]
    if len(traits) > TRAITS_MAX or any(len(t) > TRAIT_MAX for t in traits):
        soft.append(f"traits: at most {TRAITS_MAX}, each at most {TRAIT_MAX} characters")
    traits = [t[:TRAIT_MAX] for t in traits][:TRAITS_MAX]
    body = as_dict(raw.get("car"))
    if not body:
        problems.append("car is required")
    wheels = as_dict(body.get("wheels"))
    lights = as_dict(body.get("lights"))
    face = as_dict(body.get("face"))
    eyes = pick(face.get("eyes"), ids(cat, "carLooks", "eyes"), "car.face.eyes")
    car: dict[str, Any] = {
        "body": pick(body.get("body"), ids(cat, "carLooks", "body"), "car.body"),
        "length": _clamp(body.get("length"), 0.85, 1.15, 1.0),
        "height": _clamp(body.get("height"), 0.85, 1.15, 1.0),
        "paint": colour(body.get("paint"), "car.paint"),
        "accent": colour(body.get("accent"), "car.accent"),
        "pattern": pick(body.get("pattern"), ids(cat, "carLooks", "pattern"), "car.pattern"),
        "windows": pick(body.get("windows"), ids(cat, "carLooks", "windows"), "car.windows"),
        "wheels": {
            "style": pick(wheels.get("style"), ids(cat, "carLooks", "wheels"), "car.wheels.style"),
            "rim": colour(wheels.get("rim"), "car.wheels.rim"),
            "size": _clamp(wheels.get("size"), 0.85, 1.2, 1.0),
        },
        "lights": {
            "front": pick(lights.get("front"), ids(cat, "carLooks", "frontLights"), "car.lights.front"),
            "rear": pick(lights.get("rear"), ids(cat, "carLooks", "rearLights"), "car.lights.rear"),
        },
        "extra": pick(body.get("extra"), ids(cat, "carLooks", "extra"), "car.extra"),
        "face": {
            "eyes": eyes,
            "color": colour(face.get("color"), "car.face.color"),
            "mouth": pick(face.get("mouth"), ids(cat, "carLooks", "mouth"), "car.face.mouth"),
        },
        "outline": colour(body.get("outline"), "car.outline"),
    }
    faces_allowed = ids(cat, "expressions")
    if eyes == "none":
        faces = ["neutral"]
    else:
        faces = [f for f in dict.fromkeys(str(f) for f in as_list(raw.get("expressions"))) if f in faces_allowed]
        if "neutral" not in faces:
            faces.insert(0, "neutral")
        if len(faces) < 3:
            faces += [f for f in CAR_FACES_ON if f not in faces][: 3 - len(faces)]
            soft.append("a car with eyes needs at least 3 faces, neutral among them")
    voice_raw = as_dict(raw.get("voice"))
    sfx_allowed = ids(cat, "sfx")
    sfx = list(dict.fromkeys(str(v) for v in as_list(voice_raw.get("sfx"))))
    if any(v not in sfx_allowed for v in sfx) or len([v for v in sfx if v in sfx_allowed]) > VOICE_LIST_MAX:
        soft.append(f"voice.sfx: up to {VOICE_LIST_MAX} of: {', '.join(sfx_allowed)}")
    value = {
        "kind": "car",
        "name": name,
        "description": words(raw.get("description"), TEXT_MAX, "description"),
        "personality": words(raw.get("personality"), TEXT_MAX, "personality"),
        "traits": traits,
        "movementStyle": pick(raw.get("movementStyle"), ids(cat, "movementStyles"), "movementStyle"),
        "expressions": faces,
        "car": car,
        "voice": {
            "style": "none",
            "pitch": 1,
            "noises": [],
            "sfx": [v for v in sfx if v in sfx_allowed][:VOICE_LIST_MAX],
        },
    }
    if brands:
        soft.append(f"{NO_BRANDS} (found: {', '.join(dict.fromkeys(b.lower() for b in brands))})")
    if problems:
        return None, problems + soft
    return value, soft
