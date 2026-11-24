"""The parts of the animation engine's vocabulary the API checks (docs/CONTRACTS.md §45.10).

A mirror of ``web/src/stories/engine/catalog.ts`` and ``engine/types.ts`` for the fields the API validates (a
character's look, faces, moves and sounds; a story edit's effects, captions and music). ``tests/test_ws_characters.py``
compares these lists with the TypeScript files, so the two never drift.
"""

from __future__ import annotations

from typing import Final

EXPRESSIONS: Final = (
    "neutral",
    "happy",
    "laughing",
    "surprised",
    "shocked",
    "scared",
    "worried",
    "angry",
    "determined",
    "thinking",
    "sad",
    "proud",
    "dizzy",
    "relieved",
)
MOVEMENT_STYLES: Final = ("bouncy", "calm", "clumsy", "zippy", "heavy")
NOISES: Final = ("gasp", "whoa", "hmm", "yay", "oops", "laugh", "giggle", "sigh", "yelp", "phew", "babble")
SFX: Final = (
    "whoosh",
    "skid",
    "screech",
    "tyre_burst",
    "thud",
    "bump",
    "honk",
    "engine",
    "brake_squeal",
    "pop",
    "boing",
    "ding",
    "tada",
    "sad_trombone",
    "footsteps",
    "wind",
    "rain",
    "snow_crunch",
    "click",
    "beep",
    "swoosh_up",
    "heartbeat",
    "tick",
)
MUSIC_MOODS: Final = ("none", "calm", "playful", "tense", "triumphant", "wonder", "comedic")

# CharacterLook (engine/types.ts): the rig's choices.
LOOK_BODIES: Final = ("bean", "round", "tall", "square")
HAIR_STYLES: Final = ("none", "short", "spiky", "curly", "long", "bun", "cap")
EYE_SHAPES: Final = ("round", "oval", "sleepy")
BROWS: Final = ("thin", "thick")
NOSES: Final = ("dot", "button", "long", "none")
MOUTHS: Final = ("small", "wide")
PATTERNS: Final = ("plain", "stripes", "dots")
ACCESSORIES: Final = ("none", "glasses", "scarf", "bowtie", "helmet", "headphones")
VOICE_STYLES: Final = ("babble", "hum", "none")

# A character's kind (engine/types.ts CharacterKind, §45.42): an older item with none is a person.
CHARACTER_KINDS: Final = ("person", "car")

# CarLook (engine/types.ts, catalog.ts ``carLooks``): a car character's choices (§45.42).
CAR_BODIES: Final = ("hatchback", "sedan", "estate", "suv", "pickup", "van", "sports", "compact")
CAR_PATTERNS: Final = ("plain", "two_tone", "stripe", "racing_stripes")
CAR_WINDOWS: Final = ("clear", "tinted", "dark")
CAR_WHEELS: Final = ("steel", "hubcap", "alloy", "sport", "offroad")
CAR_FRONT_LIGHTS: Final = ("round", "square", "slim")
CAR_REAR_LIGHTS: Final = ("round", "bar", "square")
CAR_EXTRAS: Final = ("none", "roof_rack", "spoiler", "roof_box")
CAR_EYES: Final = ("none", "windscreen", "headlights")
CAR_MOUTHS: Final = ("none", "grille")
