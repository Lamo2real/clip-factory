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
