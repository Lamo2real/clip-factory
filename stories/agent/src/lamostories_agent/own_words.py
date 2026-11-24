"""Write it myself: the owner's own words, read by code (docs/CONTRACTS.md §45.46.6, ADR-95).

The faithful check (``own_script.own_problems``) never takes the adapter's word for what the owner wrote. Here, from
the owner's own "What happens" (never from the adapter's pieces), code reads which events it says, who does each one,
in which order and how many times, what it says does NOT happen, what it only mentions (a fear, a wish, an "if", a
warning, something said in quotes: it may be drawn, it is never owed), how someone feels, who is away, and the places
it names. Plain word rules, kept small on purpose: an event is read only from clear words ("falls", "jumps three
times", "Rosso skids"), and where the words are unclear (a pronoun two people could be) the check lets either be drawn
and the scene's note says who was. Pure: no I/O and no model."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any

# Code points that never show (Unicode's Default_Ignorable_Code_Point, beside the format characters Cf): a combining
# grapheme joiner, a variation selector or a Hangul filler pasted inside "falls" is read as if it were not there.
_IGNORABLE = re.compile(
    "[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164"
    "\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e0fff]"
)
# Letters of another script that look like Latin ones (a Cyrillic "а" in "fаlls"): inside a word that has Latin
# letters, read as the Latin letter (a word all in another script stays as it is).
_LOOKALIKE = str.maketrans(
    "аеорсухіјѕԁһӏԛԝɡАВЕКМНОРСТХУІЈЅαονρτυικχεΑΒΕΖΗΙΚΜΝΟΡΤΥΧ",
    "aeopcyxijsdhlqwgABEKMHOPCTXYIJSaovptuikxeABEZHIKMNOPTYX",
)
_LATIN = re.compile(r"[A-Za-z]")
_LETTER_RUN = re.compile(r"[^\W\d_]+")


def _latin(m: re.Match[str]) -> str:
    word = m.group(0)
    return word.translate(_LOOKALIKE) if _LATIN.search(word) else word


def clean(value: Any) -> str:
    """The words as they show: NFC, with the invisible characters taken out (a zero-width space, a soft hyphen, a
    combining grapheme joiner, a variation selector, a Hangul filler: "falls" with one inside is still "falls")."""
    text = unicodedata.normalize("NFC", str(value or ""))
    text = _IGNORABLE.sub("", "".join(ch for ch in text if unicodedata.category(ch) != "Cf"))
    return unicodedata.normalize("NFC", text)


def as_shown(value: Any) -> str:
    """``clean``, and a look-alike letter of another script inside a Latin word read as the Latin one ("fаlls" with a
    Cyrillic "а" is "falls"): how the events and the feelings are read. Never for names (a look-alike name is not the
    cast's name: the web asks who it is) nor for comparing the pieces with the words (they must copy them exactly)."""
    return _LETTER_RUN.sub(_latin, clean(value))


_ALNUM = re.compile(r"[^\W_]+")  # letters and digits (str.isalnum), as own_script.norm keeps them
_STOP = re.compile(r"[.!?;:\n…]")  # a sentence ends
_PAUSE = re.compile(r"[,()\[\]–—]")  # a clause ends inside a sentence
_OPEN_QUOTE = "“„«"
_CLOSE_QUOTE = "”»"


def tokens(value: Any) -> list[str]:
    """The words of a text in lower case, as ``own_script.norm`` gives them ("doesn't" is "doesn", "t")."""
    return [m.group(0).lower() for m in _ALNUM.finditer(clean(value))]


# Words that start a new clause ("Lamo falls and Rosa laughs"); a clause that starts with one and names nobody before
# its event is the clause before's subject's ("Lamo hugs Rosa and falls": Lamo falls).
BREAKERS = frozenset(
    {"and", "but", "then", "so", "while", "when", "after", "before", "until", "because", "meanwhile", "once", "as"}
)
# Joiners after which the next event happens at the same time: the order is not checked across them.
NOT_IN_ORDER = frozenset({"while", "when", "as", "meanwhile"})
# Joiners after which the next event happened first ("Lamo falls after he jumps": the jump first).
REVERSED = frozenset({"after", "because", "once", "since"})
# "up and down", "back and forth": one way of moving, never two clauses.
_PAIRS = frozenset({("up", "down"), ("down", "up"), ("back", "forth"), ("in", "out"), ("round", "round"),
                    ("over", "over"), ("on", "off"), ("to", "fro"), ("left", "right"), ("again", "again")})  # fmt: skip
_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
            "ten": 10, "eleven": 11, "twelve": 12, "twice": 2, "thrice": 3}  # fmt: skip
# Little words skipped when the subject of a clause is read ("Then suddenly Lamo falls", "Three times, Lamo jumps").
SKIP = frozenset(
    {"and", "then", "so", "but", "the", "a", "an", "also", "too", "now", "next", "later", "suddenly", "finally",
     "first", "soon", "just", "still", "even", "only", "really", "very", "quickly", "slowly", "again", "both",
     "together", "s", "little", "big", "poor", "silly", "brave", "happy", "sad", "meanwhile", "after", "that",
     "this", "all", "of", "while", "when", "as", "once", "times", "time", *_NUMBERS}
)  # fmt: skip
PREPOSITIONS = frozenset(
    {"at", "to", "with", "past", "behind", "near", "from", "into", "onto", "towards", "toward", "for", "by", "over",
     "under", "around", "beside", "after", "like", "of", "in", "on", "through", "across", "without", "than"}
)  # fmt: skip
VEHICLE_WORDS = frozenset({"car", "cars", "truck", "van", "bus", "lorry", "taxi", "jeep", "vehicle"})
# A car's parts: "a tyre bursts", "Rosso's engine stalls" is the car's event.
CAR_PARTS = frozenset({"tyre", "tyres", "tire", "tires", "wheel", "wheels", "engine", "brakes", "horn", "bonnet"})
# A body part: "Lamo's foot slips" is Lamo's slip.
BODY = frozenset({"foot", "feet", "leg", "legs", "knee", "knees", "bottom", "bum", "body"})
HE = frozenset({"he", "him", "his", "himself"})
SHE = frozenset({"she", "her", "hers", "herself"})
THEY = frozenset({"they", "them", "their", "themselves"})
EVERYONE = frozenset({"everyone", "everybody"})
PRONOUNS = HE | SHE | THEY | {"it"}
_POSSESSIVE_PRONOUNS = frozenset({"his", "her", "their", "its"})
MODALS = frozenset({"will", "would", "can", "could", "might", "may", "must", "should", "shall", "ll", "d"})
# A clause whose words say an event does not happen ("does not fall", "doesn't stop", "Don't trip!"): never drawn.
HARD_NO = frozenset(
    {"not", "never", "no", "t", "without", "nobody", "nothing", "neither", "nor", "dont", "doesnt", "didnt", "wont",
     "cant", "cannot", "isnt", "wasnt", "arent", "werent", "couldnt", "wouldnt", "shouldnt", "avoid", "avoids",
     "avoided", "avoiding", "instead"}
)  # fmt: skip
# "can't stop laughing", "doesn't stop jumping": a no before these says the event goes on.
_GOES_ON = frozenset({"stop", "stops", "stopped", "stopping", "help", "helps", "helped", "quit", "quits"})
# "nearly falls": it may be drawn (a slip), but it is not owed.
SOFT_NO = frozenset({"almost", "nearly"})
# Words before an event that only mention it (a wish, a fear, a warning, an "if", a future, something said): it may be
# drawn, it is never owed ("Lamo is afraid of falling", "If Lamo falls, …", "Lamo hopes Rosa will dance").
MAYBE = frozenset(
    {"if", "unless", "case", "might", "may", "could", "would", "should", "will", "ll", "shall", "must", "can",
     "want", "wants", "wanted", "wanting", "hope", "hopes", "hoped", "hoping", "wish", "wishes", "wished",
     "wishing", "afraid", "scared", "frightened", "terrified", "worried", "worries", "worry", "fear", "fears",
     "feared", "nervous", "try", "tries", "tried", "trying", "forget", "forgets", "forgot", "forgotten", "pretend",
     "pretends", "pretended", "dream", "dreams", "dreamt", "dreamed", "imagine", "imagines", "imagined", "think",
     "thinks", "thought", "remember", "remembers", "remembered", "tell", "tells", "told", "ask", "asks", "asked",
     "warn", "warns", "warned", "say", "says", "said", "shout", "shouts", "shouted", "yell", "yells", "yelled",
     "whisper", "whispers", "whispered", "plan", "plans", "planned"}
)  # fmt: skip
# Words that put an event at another time than the scene ("Lamo fell off his bike yesterday"): never owed.
_ANOTHER_TIME = frozenset({"yesterday", "ago", "tomorrow"})
_LAST = frozenset({"week", "night", "year", "time", "summer", "winter", "month", "weekend", "holiday", "holidays"})
# "Rosa trips Lamo", "Rosa topples Lamo": the one after it falls.
_TRIPS_SOMEONE = frozenset({"trips", "tripped", "tripping", "trip", "topples", "toppled", "toppling", "topple"})
# "starts to dance": it happens.
_STARTS = frozenset({"start", "starts", "started", "starting", "begin", "begins", "began", "beginning"})
MAX_COUNT = 5
CAR = "@car"  # a mention's doer: any car of the scene ("the car skids")
# Names that are everyday words too ("Lamo will fall": not Will). Written in lower case by an owner who writes
# capitals, they are the word, not the name (an owner who writes no capitals at all is read in any case).
NAME_WORDS = frozenset(
    {"will", "may", "mark", "rose", "bill", "pat", "sue", "grace", "joy", "hope", "faith", "ray", "jack", "frank",
     "rich", "dawn", "sky", "holly", "ivy", "lily", "daisy", "poppy", "ruby", "amber", "pearl", "honey", "sunny",
     "buddy", "dash", "bolt", "pip", "sandy", "art", "bob", "rob", "chip", "chase", "hunter", "summer", "autumn",
     "april", "june", "august", "robin", "jay", "wren", "rocky", "rusty", "sparky", "lucky", "max", "peg", "penny",
     "cherry", "berry", "ginger", "pepper", "sugar", "angel", "star", "storm", "river", "brook", "misty", "sage",
     "basil", "olive", "iris", "violet", "crystal", "diamond", "ace", "champ", "scout", "duke", "king", "prince",
     "queen", "princess", "captain", "doc", "kit", "kitty", "bunny", "bear", "teddy", "tiger", "fox", "wolf", "buzz",
     "flash", "speedy", "zippy", "turbo", "rocket", "jet", "blaze", "spark", "sparkle", "bubbles", "smudge", "patch",
     "spot", "socks", "muffin", "cookie", "biscuit", "peanut", "noodle", "pickle", "button", "nugget", "pumpkin",
     "pudding", "waffle", "mango", "apple", "plum", "lemon", "lime", "bean", "lightning", "red", "blue", "goldie",
     "snowy", "shadow", "dot", "pixie", "fairy", "bumble", "dusty", "zoom", "speed", "nana", "granny", "mum", "dad"}
)  # fmt: skip


@dataclass(frozen=True)
class Family:
    """An event the words can say, the engine actions (and sounds, and car states) that draw it, and whether only a
    car does it (a person driving that car counts)."""

    stems: tuple[str, ...]
    actions: frozenset[str]
    sfx: frozenset[str] = frozenset()
    states: frozenset[str] = frozenset()
    vehicle: bool = False
    needs: frozenset[str] = frozenset()  # a word the clause must also have ("tyre" for a burst)
    in_car: bool = False  # only with a car in the clause's words ("gets out of the car", "gets into Rosso")


# Strict words on purpose: an event the words say is owed (it must be drawn, by who does it), so only clear verbs
# count. Each stem is words in ``tokens`` form; the last one is a word start unless it ends with "$" (the whole word).
FAMILIES: dict[str, Family] = {
    "fall": Family(
        ("fall$", "falls$", "fell$", "falling$", "fallen$", "tumbl", "toppl", "collaps", "trips$", "tripped$",
         "tripping$", "trip over", "trip up", "slip$", "slips$", "slipped$", "slipping$", "stumbl"),
        frozenset({"fall", "slip"}),
    ),
    "jump": Family(
        ("jump$", "jumps$", "jumped$", "jumping$", "leap$", "leaps$", "leapt$", "leaped$", "leaping$", "hop$", "hops$",
         "hopped$", "hopping$"),
        frozenset({"jump"}),
    ),
    "dance": Family(("dance$", "dances$", "danced$", "dancing$", "boogie"), frozenset({"dance"})),
    "skid": Family(
        ("skid$", "skids$", "skidded$", "skidding$", "aquaplan", "spins$", "spun$", "spinning$", "spin out",
         "slides$", "slid$", "sliding$", "loses control", "lose control", "lost control"),
        frozenset({"skid", "spin"}), sfx=frozenset({"skid"}), vehicle=True,
    ),
    "speed": Family(
        ("speeds$", "sped$", "speeding$", "speed up", "fast$", "faster$", "fastest$", "zoom$", "zooms$", "zoomed$",
         "zooming$", "races$", "raced$", "accelerat", "floor it", "floors it", "zips$", "zipped$", "zipping$",
         "whizz"),
        frozenset({"speed_up"}), vehicle=True,
    ),
    "burst": Family(
        ("punctur", "blowout", "blow out", "blows out", "burst", "pops$", "popped$", "goes flat", "flat$"),
        frozenset({"tyre_burst"}), sfx=frozenset({"tyre_burst"}), states=frozenset({"flat"}), vehicle=True,
        needs=frozenset({"tyre", "tire", "tyres", "tires", "wheel", "wheels", "puncture", "punctured", "blowout",
                         "flat"}),
    ),
    "bump": Family(
        ("bump$", "bumps$", "bumped$", "bumping$", "crash$", "crashes$", "crashed$", "crashing$", "collid", "smash$",
         "smashes$", "smashed$", "hits$", "hit$", "runs into", "ran into", "backs into", "reverses into",
         "slams into", "slammed into", "slam into", "slamming into", "ram$", "rams$", "rammed$", "ramming$",
         "ploughs into", "ploughed into", "plough into", "plows into", "plowed into", "plow into", "smacks into",
         "smacked into", "smack into", "bashes into", "bashed into", "rear ends",
         "rear ended", "rear end", "thumps into", "thumped into"),
        frozenset({"bump"}), sfx=frozenset({"bump", "thud"}), vehicle=True,
    ),
    "honk": Family(
        ("honk$", "honks$", "honked$", "honking$", "toot$", "toots$", "tooted$", "tooting$", "sounds the horn",
         "beeps the horn"),
        frozenset({"honk"}), sfx=frozenset({"honk", "beep"}), vehicle=True,
    ),
    "stall": Family(
        ("stall$", "stalls$", "stalled$", "stalling$", "won t start", "doesn t start", "does not start",
         "will not start", "wont start", "doesnt start", "breaks down", "broke down", "broken down", "conks out"),
        frozenset({"stall"}), vehicle=True,
    ),
    # a car that stops or brakes ("stops at the red light", "slams on the brakes", "screeches to a halt"); the brakes
    # as a thing ("the brakes fail") and a stop sign are no stop
    "stop": Family(
        ("stop$", "stops$", "stopped$", "stopping$", "halt", "brake$", "brakes$", "braked$", "braking$",
         "on the brake", "hits the brake", "hit the brake", "presses the brake", "press the brake",
         "applies the brake", "pulls over", "pull over", "pulled over", "pulling over", "pulls up", "pulled up"),
        frozenset({"stop", "brake"}), sfx=frozenset({"brake_squeal", "screech"}), states=frozenset({"brakes"}),
        vehicle=True,
    ),
    "get_in": Family(
        ("gets in", "get in", "got in", "getting in", "gets into", "get into", "got into", "getting into",
         "climbs in", "climb in", "climbed in", "climbs into", "climbed into", "steps in", "stepped in",
         "steps into"),
        frozenset({"get_in"}), in_car=True,
    ),
    "get_out": Family(
        ("gets out", "get out", "got out", "getting out", "climbs out", "climb out", "climbed out", "steps out",
         "stepped out", "step out"),
        frozenset({"get_out"}), in_car=True,
    ),
}  # fmt: skip
# The engine action -> the family it draws (a beat doing one is an event of that family).
ACTION_FAMILY = {a: name for name, fam in FAMILIES.items() for a in fam.actions}
_SAME_TIME = {"in", "into", "out", "on", "onto", "off"}  # "jumps in the car": getting in shows it too
_NOT_A_FALL_NEXT = {"asleep", "apart", "behind", "silent", "quiet", "ill", "sick", "short", "for"}
_NOT_AN_EVENT_AFTER = {"the", "this", "last", "next"}  # "in the fall", "this fall": a season
_NOT_A_STOP_NEXT = {"sign", "signs", "light", "lights", "button", "watch", "sticker"}  # "the stop sign"
_NOT_A_STOP_AFTER = {"the", "a", "bus", "next", "last", "first", "pit", "one", "non", "his", "her", "its", "their",
                     "s", "my", "your", "our", "hand", "handbrake"}  # fmt: skip
# A thing that falls or bounces ("watches the snow fall"): not a cast member's event.
_THINGS = frozenset(
    {"snow", "rain", "leaves", "leaf", "ball", "balls", "cup", "plate", "glass", "book", "toy", "toys", "hat",
     "night", "tree", "apple", "apples", "box", "phone", "ice", "water", "sky", "star", "stars", "sun", "petals",
     "flowers", "cake", "bag", "shoe", "shoes", "kite", "balloon", "rock", "rocks", "stone", "stones", "it"}
)  # fmt: skip

# How someone feels: a clause that says it, and what draws the other feeling (never drawn under its words).
HAPPY_WORDS = (
    "happy", "happi", "glad", "joy", "laugh", "giggl", "smile", "smiling", "grin", "cheer", "celebrat", "hug$",
    "hugs$", "hugged$", "hugging$", "kiss", "love", "loves$", "loved$", "proud", "excited", "delighted", "thrilled",
    "yay$", "hooray", "hurray", "enjoy", "high five", "chuckl", "overjoyed", "beam$", "beams$", "beamed$",
    "beaming$", "jolly", "glee", "chuffed", "ecstatic", "relie",
)  # fmt: skip
SAD_WORDS = (
    "sad$", "sadly", "cry$", "cries$", "cried$", "crying$", "tears", "sob$", "sobs$", "sobbing", "upset", "unhappy",
    "angry", "angrily", "mad$", "furious", "scared", "afraid", "frightened", "terrified", "worried", "nervous",
    "grumpy", "sulk", "miserable", "lonely", "scream", "weep", "wept$", "sigh$", "sighs$", "sighed$", "sighing$",
    "frown", "cross$", "gloomy", "glum", "heartbroken", "whimper", "sniffl", "moan", "groan", "grumbl", "pout",
    "disappointed", "jealous", "annoyed", "tearful",
)  # fmt: skip
_NOT_A_BEAM_AFTER = frozenset({"high", "full", "main", "dipped", "low", "light", "lights", "headlight", "headlights",
                               "the", "a", "his", "her", "its", "their", "s", "laser", "sun", "wooden"})  # fmt: skip
_CROSS_AFTER = frozenset({"is", "was", "are", "were", "gets", "got", "get", "feels", "felt", "feel", "looks",
                          "looked", "look", "very", "so", "really", "s", "too", "quite", "bit"})  # fmt: skip
HAPPY_DRAWN = {
    "face": frozenset({"happy", "laughing", "proud", "relieved"}),
    "noise": frozenset({"yay", "laugh", "giggle"}),
    "do": frozenset({"celebrate", "dance", "thumbs_up"}),
    "bubble": frozenset({"heart", "music"}),
    "sfx": frozenset({"tada"}),
}
SAD_DRAWN = {
    "face": frozenset({"sad", "angry", "scared", "worried"}),
    "noise": frozenset({"sigh", "yelp"}),
    "do": frozenset({"cower", "facepalm"}),
    "bubble": frozenset({"angry", "sweat"}),
    "sfx": frozenset({"sad_trombone"}),
}
# Words for a place a scene is in ("through the forest", "at school"), after one of these words.
PLACE_PREPS = frozenset({"in", "at", "inside", "through", "across", "around", "on", "along"})
PLACE_DETS = frozenset({"the", "a", "an", "his", "her", "their", "my", "our", "your", "some", "this", "that"})
# "alone", "on his own": everyone else is away.
_ALONE = frozenset({"alone"})
_OWN_ALONE = (("on", "his", "own"), ("on", "her", "own"), ("by", "himself"), ("by", "herself"))


def _stem_at(toks: Sequence[str], i: int, stem: str) -> int:
    """The number of words of ``stem`` that match at word ``i`` (0: none)."""
    parts = stem.split()
    if i + len(parts) > len(toks):
        return 0
    for k, part in enumerate(parts):
        word = toks[i + k]
        last = k == len(parts) - 1
        if part.endswith("$"):
            if word != part[:-1]:
                return 0
        elif last:
            if not word.startswith(part):
                return 0
        elif word != part:
            return 0
    return len(parts)


def find(toks: Sequence[str], stems: Iterable[str]) -> list[tuple[int, int]]:
    """(word index, words) of each place the stems match, in order, the longest at each word."""
    stems = list(stems)
    out: list[tuple[int, int]] = []
    for i in range(len(toks)):
        best = max((_stem_at(toks, i, s) for s in stems), default=0)
        if best:
            out.append((i, best))
    return out


@dataclass
class Clause:
    start: int  # first word
    end: int  # one past the last word
    sentence: int
    lead: str  # the joining word or mark that started it ("and", ",", "." or "")
    subject: frozenset[str] | None = None  # cast keys; None: someone the cast does not name (or nobody)
    ambiguous: bool = False  # a pronoun two people could be
    outside: bool = False  # someone left out, or not in the cast


@dataclass
class Mention:
    """One event the owner's words say."""

    family: str
    at: int  # word index
    clause: int
    doers: frozenset[str] | None  # cast keys (or "@car": any car of the scene); None: anyone
    count: int = 1  # how many times it is owed (at most MAX_COUNT)
    denied: bool = False  # the words say it does not happen
    soft: bool = False  # "nearly": may be drawn, never owed
    ambiguous: bool = False
    outside: bool = False  # done by someone not drawn (left out, or not in the cast)
    also: frozenset[str] = frozenset()  # more actions that show it ("jumps in the car": get_in)
    maybe: bool = False  # only mentioned ("afraid of falling", "if he falls", "will dance"): may be drawn, never owed
    said_count: int = 1  # the count the words give ("ten times": 10)
    exact: bool = False  # the words give a count ("twice", "once", "three times"): exactly that many
    again: bool = False  # "falls again": one more, never the one before


@dataclass
class Mood:
    clause: int
    happy: bool  # True: a happy clause; False: a sad, scared or angry one (or "not happy")
    who: frozenset[str]


@dataclass
class Reading:
    words: list[str]
    raw: list[str]
    clauses: list[Clause] = field(default_factory=list)
    mentions: list[Mention] = field(default_factory=list)
    moods: list[Mood] = field(default_factory=list)
    absent: set[str] = field(default_factory=set)
    places: list[tuple[int, str]] = field(default_factory=list)  # (word index, the place word)
    names_at: dict[int, str] = field(default_factory=dict)  # word index -> cast key

    def text(self, start: int, end: int) -> str:
        return " ".join(self.raw[start:end])


def _scan(text: str) -> tuple[list[str], list[str], list[int], list[str], list[bool]]:
    """The words (lower case and as written), each word's sentence, the mark or joining word before it, and whether
    it is inside quotation marks (something said: "Rosa shouts “Jump!”")."""
    low: list[str] = []
    raw: list[str] = []
    sentence: list[int] = []
    gap: list[str] = []
    quoted: list[bool] = []
    last, s, inside = 0, 0, False
    for m in _ALNUM.finditer(text):
        between = text[last : m.start()]
        for ch in between:
            if ch == '"':
                inside = not inside
            elif ch in _OPEN_QUOTE:
                inside = True
            elif ch in _CLOSE_QUOTE:
                inside = False
        if low and _STOP.search(between):
            s += 1
            gap.append(".")
        elif low and _PAUSE.search(between):
            gap.append(",")
        else:
            gap.append("")
        low.append(m.group(0).lower())
        raw.append(m.group(0))
        sentence.append(s)
        quoted.append(inside)
        last = m.end()
    return low, raw, sentence, gap, quoted


def _split(text: str) -> tuple[list[str], list[str], list[int], list[str]]:
    """The words (lower case and as written), each word's sentence and the mark or joining word before it."""
    low, raw, sentence, gap, _quoted = _scan(text)
    return low, raw, sentence, gap


def _name_tokens(name: str) -> list[list[str]]:
    """The words a name is called by: the whole name, and the first and the last word of a longer one ("Nana" and
    "Rose" for Nana Rose)."""
    full = tokens(name)
    if not full:
        return []
    out = [full]
    if len(full) > 1:
        for part in (full[:1], full[-1:]):
            if len(part[0]) > 1 and part not in out:
                out.append(part)
    return out


def writes_capitals(raw: Sequence[str]) -> bool:
    """True when the owner writes capital letters (then a name that is an everyday word in lower case is the word)."""
    return any(w[:1].isupper() for w in raw)


def _mark_names(low: Sequence[str], names: Mapping[str, str], raw: Sequence[str] | None = None) -> dict[int, str]:
    """Word index -> cast key for every cast name in the words (the whole name, or its first or last word; "Dashs", a
    possessive typed without its apostrophe, is Dash), longer names first. A name that is an everyday word too
    (``NAME_WORDS``: "will", "rose") written in lower case by an owner who writes capitals is the word."""
    capitals = raw is not None and writes_capitals(raw)
    out: dict[int, str] = {}
    called = sorted(((key, parts) for key, name in names.items() for parts in _name_tokens(name)),
                    key=lambda kp: -len(kp[1]))  # fmt: skip
    for key, parts in called:
        n = len(parts)
        for i in range(len(low) - n + 1):
            window = list(low[i : i + n])
            typo = n == 1 and len(parts[0]) >= 3 and window[0] == parts[0] + "s"
            if not (window == parts or typo) or any(i + k in out for k in range(n)):
                continue
            if capitals and raw is not None and not raw[i][:1].isupper() and parts[0] in NAME_WORDS:
                continue  # "Lamo will fall": the word will, not Will
            for k in range(n):
                out[i + k] = key
    return out


def named_keys(text: str, names: Mapping[str, str]) -> list[str]:
    """The cast keys the words name, in the order of ``names`` (as ``_mark_names`` reads them)."""
    low, raw, _s, _g = _split(clean(text))
    found = set(_mark_names(low, names, raw).values())
    return [k for k in names if k in found]


def _content(word: str, i: int, names_at: Mapping[int, str], outside_at: set[int]) -> bool:
    return i not in names_at and i not in outside_at and word not in SKIP


def _clauses(low: Sequence[str], sentence: Sequence[int], gap: Sequence[str], names_at: Mapping[int, str],
             outside_at: set[int]) -> list[Clause]:  # fmt: skip
    """The clauses: a sentence mark or a comma ends one, and so does a joining word once the clause has a word that
    is not a name ("Lamo and Rosa jump" stays one; "Lamo falls and Rosa laughs" is two), unless it ends its sentence
    ("Lamo jumps once.") or joins a pair ("up and down"). A clause with only names and little words in it joins the
    next one in its sentence ("Lamo, Rosa and Max dance", "Three times, Lamo jumps")."""
    out: list[Clause] = []
    start, lead = 0, ""
    for i, word in enumerate(low):
        if i == 0:
            continue
        cut = gap[i] in (".", ",")
        if not cut and word in BREAKERS:
            last_word = i + 1 >= len(low) or gap[i + 1] == "."
            pair = word == "and" and i + 1 < len(low) and (low[i - 1], low[i + 1]) in _PAIRS
            cut = not last_word and not pair and any(_content(low[k], k, names_at, outside_at) for k in range(start, i))
        if cut:
            out.append(Clause(start, i, sentence[start], lead))
            start, lead = i, (word if word in BREAKERS else gap[i])
    if low:
        out.append(Clause(start, len(low), sentence[start], lead))
    merged: list[Clause] = []
    carry: Clause | None = None
    for part in out:
        c = part
        if carry is not None:
            if carry.sentence == c.sentence:
                c = Clause(carry.start, c.end, c.sentence, carry.lead)
            else:
                merged.append(carry)
            carry = None
        if not any(_content(low[k], k, names_at, outside_at) for k in range(c.start, c.end)):
            carry = c  # only names (and little words): it joins the next clause
            continue
        merged.append(c)
    if carry is not None:
        merged.append(carry)
    return merged


def _leading(low: Sequence[str], c: Clause, upto: int, names_at: Mapping[int, str],
             outside_at: set[int], poss: set[int] = frozenset()) -> tuple[set[str], bool, str | None, bool]:  # type: ignore[assignment]  # fmt: skip
    """Who a clause's words name before word ``upto``: (cast keys, someone outside the cast, the first pronoun, a
    car word), names after a preposition and owners ("Lamo's ice cream") aside ("skids past Bolt", "waves at
    Rosa")."""
    keys: set[str] = set()
    outside = False
    pronoun: str | None = None
    vehicle = False
    for k in range(c.start, min(upto, c.end)):
        after_prep = k > c.start and low[k - 1] in PREPOSITIONS
        if k in names_at:
            if not after_prep and k not in poss:
                keys.add(names_at[k])
        elif k in outside_at:
            if not after_prep:
                outside = True
        elif pronoun is None and not keys and low[k] in PRONOUNS:
            pronoun = low[k]
        if low[k] in VEHICLE_WORDS:
            vehicle = True
    return keys, outside, pronoun, vehicle


def _only_little(low: Sequence[str], start: int, upto: int) -> bool:
    return all(low[k] in SKIP or low[k] in BREAKERS or low[k] in MODALS for k in range(start, upto))


def learn_genders(texts: Iterable[str], names: Mapping[str, str], given: Mapping[str, str] | None = None,
                  people: Iterable[str] = ()) -> dict[str, str]:  # fmt: skip
    """cast key -> "he" or "she", from what is known of the characters (``given``: their own descriptions, which
    always win) and the owner's own words: a sentence that names one person and later says he, his, she or hers
    (never him or her, which are mostly someone else: "Rosa waves at him") tells it. A person told both is left
    unknown."""
    told = {k: v for k, v in (given or {}).items() if v in ("he", "she")}
    seen: dict[str, set[str]] = {}
    people = set(people) or set(names)
    for text in texts:
        low, raw, sentence, _gap = _split(clean(text))
        at = _mark_names(low, {k: v for k, v in names.items() if k in people}, raw)
        by_sentence: dict[int, list[int]] = {}
        for i in range(len(low)):
            by_sentence.setdefault(sentence[i], []).append(i)
        for s in sorted(by_sentence):
            idx = by_sentence[s]
            named = list(dict.fromkeys(at[i] for i in idx if i in at))
            first_name = next((i for i in idx if i in at), None)
            if len(named) != 1 or first_name is None or named[0] in told:
                continue
            for i in idx:
                word = low[i]
                g = "he" if word in ("he", "his", "himself") else "she" if word in ("she", "hers", "herself") else None
                if g is not None and i > first_name:
                    seen.setdefault(named[0], set()).add(g)
    return {**{k: next(iter(v)) for k, v in seen.items() if len(v) == 1}, **told}


GENDER_WORDS = {
    "he": frozenset({"he", "his", "him", "boy", "man", "dad", "father", "brother", "son", "grandpa", "grandad",
                     "uncle", "king", "prince", "mr", "husband", "guy", "gentleman", "lad"}),
    "she": frozenset({"she", "her", "girl", "woman", "mum", "mom", "mother", "sister", "daughter", "grandma",
                      "granny", "aunt", "queen", "princess", "mrs", "ms", "miss", "wife", "lady", "nana"}),
}  # fmt: skip


def gender_of(character: Mapping[str, Any] | None) -> str | None:
    """He or she ("he", "she") when a character's own description, personality or traits say only one; else None."""
    if not character:
        return None
    text = " ".join(
        [str(character.get("description") or ""), str(character.get("personality") or "")]
        + [str(t) for t in character.get("traits") or [] if isinstance(t, str)]
    )
    words = set(tokens(text))
    said = [g for g, ws in GENDER_WORDS.items() if words & ws]
    return said[0] if len(said) == 1 else None


def read(
    what: str,
    names: Mapping[str, str],
    *,
    cars: Iterable[str] = (),
    outside: Iterable[str] = (),
    genders: Mapping[str, str] | None = None,
    present: Iterable[str] | None = None,
) -> Reading:
    """The owner's "What happens" of one scene, read. ``names``: cast key -> name (people and cars); ``cars``: the
    cars' keys; ``outside``: the names the owner left out (people the video does not draw); ``genders``: cast key ->
    "he"/"she" where known; ``present``: the scene's own people (its Who) when known: who a pronoun is when the words
    name nobody ("He walks home alone."), and who "they" and "everyone" are."""
    low, raw, sentence, gap, quoted = _scan(as_shown(what))
    strict_low, strict_raw, _s, _g, _q = _scan(clean(what))  # the same words, each letter as typed
    names_at = _mark_names(strict_low, names, strict_raw)
    car_keys = set(cars)
    people = {k for k in names if k not in car_keys}
    here_people = [k for k in dict.fromkeys(present or []) if k in people]
    out_words = {w for x in outside for w in tokens(x)}
    outside_at = {i for i, w in enumerate(low) if w in out_words and i not in names_at and raw[i][:1].isupper()}
    poss = {i for i in names_at if i + 1 < len(low) and low[i + 1] == "s" and names_at.get(i + 1) != names_at[i]}
    reading = Reading(low, raw, names_at=names_at)
    reading.clauses = _clauses(low, sentence, gap, names_at, outside_at)
    sexes = dict(genders or {})

    def everyone() -> frozenset[str]:
        return frozenset(here_people or sorted(people))

    def resolve(pronoun: str, at_word: int) -> tuple[frozenset[str] | None, bool]:
        """Who a pronoun is: the person named before it whose he or she it is (the latest sentence that has one, and
        anyone of unknown he or she named since: then either may be it), else the only one named; with nobody named,
        the scene's own people of that he or she; "they": everyone named before (or the scene's people)."""
        if pronoun == "it":
            return frozenset({CAR}), False
        before = [names_at[i] for i in sorted(names_at) if i < at_word and names_at[i] in people and i not in poss]
        if pronoun in THEY or pronoun in EVERYONE:
            many = list(dict.fromkeys([*before, *here_people]))
            return (frozenset(many) if len(many) > 1 else everyone() or None), False
        want = "he" if pronoun in HE else "she"
        unknown: list[str] = []
        for s in range(sentence[at_word] if at_word < len(sentence) else 0, -1, -1):
            here = list(dict.fromkeys(
                names_at[i] for i in sorted(names_at, reverse=True)
                if sentence[i] == s and i < at_word and names_at[i] in people and i not in poss
            ))  # fmt: skip
            if not here:
                continue
            match = [p for p in here if sexes.get(p) == want]
            unknown += [p for p in here if sexes.get(p) is None and p not in unknown]
            if match:
                cands = list(dict.fromkeys([*match[:1], *unknown]))
                return frozenset(cands), len(cands) > 1
        if unknown:
            return frozenset(unknown), len(unknown) > 1
        match = [p for p in here_people if sexes.get(p) == want]
        maybe = [p for p in here_people if sexes.get(p) is None]
        if len(match) == 1 and not maybe:
            return frozenset(match), False
        cands = [*match, *maybe]
        return (frozenset(cands), len(cands) > 1) if cands else (None, False)

    for k, c in enumerate(reading.clauses):
        lead_keys: set[str] = set()
        lead_outside = False
        first_other: int | None = None
        for i in range(c.start, c.end):  # the names at the clause's start, before its first other word
            if i in names_at and i not in poss:
                lead_keys.add(names_at[i])
            elif i in outside_at:
                lead_outside = True
            elif low[i] not in SKIP and i not in names_at:
                first_other = i
                break
        prev = reading.clauses[k - 1] if k > 0 else None
        if lead_keys:
            c.subject = frozenset(lead_keys)
        elif first_other is not None and (low[first_other] in PRONOUNS or low[first_other] in EVERYONE):
            c.subject, c.ambiguous = resolve(low[first_other], first_other)
        elif (first_other is not None and low[first_other] in ("who", "whose") and prev is not None
              and prev.sentence == c.sentence and prev.end - 1 in names_at):  # fmt: skip
            c.subject = frozenset({names_at[prev.end - 1]})  # "Rosa hugs Lamo, who is crying": Lamo cries
        elif lead_outside:
            c.outside = True
        elif prev is not None and prev.sentence == c.sentence and c.lead in BREAKERS | {","}:
            c.subject, c.ambiguous, c.outside = prev.subject, prev.ambiguous, prev.outside  # "Lamo hugs Rosa and falls"

    def run_before(c: Clause, at: int) -> tuple[list[str], int | None]:
        """The names right before word ``at`` (only little words, joiners or other names between: "Lamo and Rosa
        both fall", "Rosa sees Lamo fall", "he might fall") and the place of a pronoun there."""
        keys: list[str] = []
        pronoun: int | None = None
        j = at - 1
        while j >= c.start:
            w = low[j]
            if j in names_at and j not in poss:
                keys.insert(0, names_at[j])
            elif (w in PRONOUNS or w in EVERYONE) and w not in _POSSESSIVE_PRONOUNS:
                pronoun = j if pronoun is None else pronoun
            elif not (w in SKIP or w in MODALS or w in ("or", "nor")):
                break
            j -= 1
        return list(dict.fromkeys(keys)), pronoun

    def owner_of(j: int, c: Clause) -> tuple[frozenset[str] | None, bool] | None:
        """Whose thing word ``j`` is ("Max's car", "his red car", "Lamo's foot"): (who, ambiguous), else None."""
        for q in range(j - 1, max(c.start, j - 4) - 1, -1):
            if q in poss:
                return frozenset({names_at[q]}), False
            if low[q] in _POSSESSIVE_PRONOUNS:
                return resolve(low[q], q)
            if q in names_at or low[q] in BREAKERS:
                return None
        return None

    def doers_of(name: str, fam: Family, c: Clause, at: int, n: int) -> tuple[frozenset[str] | None, bool, bool, bool]:
        """(who does it, a pronoun two people could be, someone not drawn, each of them: "Lamo and Rosa jump")."""
        keys, pronoun = run_before(c, at)
        each = len(keys) > 1 and "or" not in low[c.start : at]
        doers: frozenset[str] | None = None
        ambiguous = outside_doer = False
        head = at - 1
        while head >= c.start and (low[head] in SKIP or low[head] in MODALS) and head not in names_at:
            head -= 1
        head_word = low[head] if head >= c.start else ""
        if keys or pronoun is not None:
            doers = frozenset(keys)
            if pronoun is not None:
                who, ambiguous = resolve(low[pronoun], pronoun)
                each = each or low[pronoun] in THEY or low[pronoun] in EVERYONE
                doers = doers | (who or frozenset())
            doers = doers or None
        elif head_word in VEHICLE_WORDS or head_word in CAR_PARTS or head_word in BODY:
            owner = owner_of(head, c)
            if head_word in BODY:
                if owner is not None:
                    doers, ambiguous = owner
            elif fam.vehicle:
                doers, ambiguous = owner if owner is not None else (frozenset({CAR}), False)
        elif head >= c.start and owner_of(head + 1, c) is not None and head not in names_at:
            doers = None  # "Lamo's ice cream falls": a thing of his, not Lamo
        else:
            lead, out, lead_pronoun, _vehicle = _leading(low, c, at, names_at, outside_at, poss)
            if lead:
                doers = frozenset(lead)
            elif c.subject is not None and (lead_pronoun is not None or _only_little(low, c.start, at)):
                doers, ambiguous = c.subject, c.ambiguous
            elif out or (c.outside and _only_little(low, c.start, at)):
                return frozenset(), False, True, False
        nxt_at = at + n
        if doers is not None and nxt_at < c.end and nxt_at in names_at:
            if name == "fall":
                if n == 1 and low[at] in _TRIPS_SOMEONE:  # "Rosa trips Lamo": Lamo falls ("trips over Rosa": Lamo)
                    doers = None if nxt_at in poss else frozenset({names_at[nxt_at]})
                    each = False
            else:  # "Rosso hits Bolt": either may show it
                doers = doers | {names_at[nxt_at]}
                each = False
        if doers is not None and name in ("dance", "jump") and nxt_at < c.end and low[nxt_at] == "with":
            more = []
            j = nxt_at + 1
            while j < c.end and (j in names_at or low[j] in SKIP):
                if j in names_at and j not in poss:
                    more.append(names_at[j])
                j += 1
            if more and (j >= c.end or low[j] in PREPOSITIONS):  # "Lamo dances with Rosa": both dance
                doers, each = doers | frozenset(more), True
        if fam.vehicle and doers is None:
            doers = frozenset({CAR})  # "Suddenly a tyre bursts": a car of the scene
        if not fam.vehicle and doers is not None and doers <= {CAR}:
            doers = None  # "It falls": a thing, not a cast member
        return doers, ambiguous, outside_doer, each

    for k, c in enumerate(reading.clauses):
        toks = low[c.start : c.end]
        hard = [c.start + i for i, w in enumerate(toks) if w in HARD_NO]
        soft = [c.start + i for i, w in enumerate(toks) if w in SOFT_NO]
        another_time = any(w in _ANOTHER_TIME for w in toks) or any(
            toks[i] == "last" and i + 1 < len(toks) and toks[i + 1] in _LAST for i in range(len(toks))
        )
        car_named = bool(set(toks) & VEHICLE_WORDS) or any(names_at.get(i) in car_keys for i in range(c.start, c.end))
        for name, fam in FAMILIES.items():
            if fam.needs and not set(toks) & fam.needs:
                continue
            if fam.in_car and not car_named:
                continue
            for i, n in find(toks, fam.stems):
                at = c.start + i
                if quoted[at] or _not_an_event(name, low, at, n):
                    continue  # something said ('Rosa shouts "Jump!"'), or no event at all
                doers, ambiguous, outside_doer, each = doers_of(name, fam, c, at, n)
                nxt = low[at + n] if at + n < len(low) else ""
                also = frozenset({"get_in", "get_out"}) if name == "jump" and nxt in _SAME_TIME else frozenset()
                said_count, exact = _count(low, at, n, c)
                mention = Mention(name, at, k, doers, ambiguous=ambiguous, outside=outside_doer, also=also)
                # a no before the event says it does not happen ("doesn't start" is its own words: never before them);
                # "can't stop jumping" says it goes on
                mention.denied = any(j < at and not any(w in _GOES_ON for w in low[j + 1 : at]) for j in hard)
                mention.soft = any(j < at for j in soft)
                mention.maybe = another_time or _only_mentioned(low, c, at)
                mention.said_count, mention.exact = said_count, exact
                mention.count = max(1, min(MAX_COUNT, said_count))
                rest = low[at + n : c.end]
                mention.again = "again" in rest or any(rest[j : j + 2] == ["once", "more"] for j in range(len(rest)))
                if each and doers and len(doers) > 1 and not fam.vehicle:  # a car's event shows for its driver too
                    reading.mentions += [replace(mention, doers=frozenset({d})) for d in sorted(doers)]
                else:
                    reading.mentions.append(mention)
        reading.moods += _moods(low, c, k, hard, names_at, people, poss, run_before, resolve, everyone)
    reading.mentions.sort(key=lambda m: m.at)
    reading.absent = _absent(low, names_at, people)
    reading.absent |= _alone(low, reading, names_at, people, here_people, run_before, quoted)
    for i in range(1, len(low)):
        if low[i - 1] in PLACE_PREPS or (i >= 2 and low[i - 1] in PLACE_DETS and low[i - 2] in PLACE_PREPS):
            reading.places.append((i, low[i]))
    return reading


def _only_mentioned(low: Sequence[str], c: Clause, at: int) -> bool:
    """True when the words before an event only mention it: a fear, a wish, an "if", a future, a warning or something
    said ("afraid of falling", "wants to jump", "If Lamo falls", "will dance", "tells Lamo to slow down or he will
    crash"), "to" before it ("tries to jump"; "starts to dance" happens), or a preposition before its "-ing"."""
    before = low[c.start : at]
    if any(w in MAYBE and low[c.start + i + 1 : c.start + i + 2] != ["t"] for i, w in enumerate(before)):
        return True  # ("can't" is a no, never a maybe: "can't stop jumping" says he jumps)
    prev = low[at - 1] if at - 1 >= c.start else ""
    if prev == "to" and not (at - 2 >= c.start and low[at - 2] in _STARTS):
        return True
    return low[at].endswith("ing") and prev in ("of", "about", "from", "for")


def _moods(
    low: Sequence[str], c: Clause, k: int, hard: Sequence[int], names_at: Mapping[int, str], people: set[str],
    poss: set[int], run_before: Any, resolve: Any, everyone: Any,
) -> list[Mood]:  # fmt: skip
    """How someone feels in a clause: who feels it is who the words put right before the feeling word ("Rosa hugs
    Lamo": Rosa; "makes Lamo laugh": Lamo), else the clause's subject; a no before a happy word ("is not happy",
    "doesn't smile") is a sad one (never drawn happy); a no before a sad word says nothing."""
    toks = low[c.start : c.end]
    happy_at = [c.start + i for i, _n in find(toks, HAPPY_WORDS) if _a_feeling(low, c.start + i)]
    sad_at = [c.start + i for i, _n in find(toks, SAD_WORDS) if _a_feeling(low, c.start + i)]

    def negated(at: int) -> bool:
        return any(j < at and not any(w in _GOES_ON for w in low[j + 1 : at]) for j in hard)

    pos_happy = [i for i in happy_at if not negated(i)]
    not_happy = [i for i in happy_at if negated(i)]
    sad = [i for i in sad_at if not negated(i)]
    if pos_happy and not sad:
        happy, at_words = True, pos_happy
    elif sad and not pos_happy:
        happy, at_words = False, sad
    elif not_happy and not pos_happy and not sad:
        happy, at_words = False, not_happy  # "Lamo is not happy": never drawn happy
    else:
        return []
    who: set[str] = set()
    for at in at_words:
        keys, pronoun = run_before(c, at)
        found = set(keys)
        if pronoun is not None:
            found |= set(resolve(low[pronoun], pronoun)[0] or ())
        if not found:
            found = {names_at[i] for i in range(c.start, at) if i in names_at and i not in poss
                     and not (i > c.start and low[i - 1] in PREPOSITIONS)}  # fmt: skip
        if not found and c.subject:
            found = set(c.subject)
        who |= found
    who = {p for p in who if p in people}
    return [Mood(k, happy, frozenset(who))] if who else []


def _a_feeling(low: Sequence[str], at: int) -> bool:
    """A feeling word that is one: never the headlights' "full beam" or "crosses the road"."""
    prev = low[at - 1] if at > 0 else ""
    if low[at].startswith("beam"):
        return prev not in _NOT_A_BEAM_AFTER
    if low[at] == "cross":
        return prev in _CROSS_AFTER
    return True


_FEEL = frozenset({"feel", "feels", "felt", "feeling"})


def _alone(
    low: Sequence[str], reading: Reading, names_at: Mapping[int, str], people: set[str], here_people: Sequence[str],
    run_before: Any, quoted: Sequence[bool],
) -> set[str]:  # fmt: skip
    """The people the words say are not there because someone is alone ("so Lamo is alone", "he walks home alone",
    "on his own"): everyone of the scene but who is alone."""
    out: set[str] = set()
    for c in reading.clauses:
        toks = low[c.start : c.end]
        at = next((c.start + i for i, w in enumerate(toks) if w in _ALONE), None)
        if at is None:
            at = next((c.start + i for i in range(len(toks)) if any(tuple(toks[i : i + len(p)]) == p
                                                                     for p in _OWN_ALONE)), None)  # fmt: skip
        if at is None or quoted[at] or any(w in HARD_NO or w in _FEEL for w in low[c.start : at]):
            continue  # "is not alone", "feels alone at the party", something said
        keys, _pronoun = run_before(c, at)
        who, ambiguous = c.subject, c.ambiguous
        if not who or ambiguous or not set(keys) <= set(who):
            continue  # "Lamo leaves Rosa alone": Lamo is there
        everyone = set(here_people) | {names_at[i] for i in names_at if names_at[i] in people}
        out |= everyone - set(who)
    return out


def _not_an_event(name: str, low: Sequence[str], at: int, n: int) -> bool:
    """Words that look like an event and are not one: "falls asleep", "in the fall", "the snow falls", "fast
    asleep", "hits the brakes" (a stop, not a bump), "the stop sign", "the brakes fail"."""
    nxt = low[at + n] if at + n < len(low) else ""
    after = low[at + n + 1] if at + n + 1 < len(low) else ""
    prev = low[at - 1] if at > 0 else ""
    if name == "fall":
        if nxt in _NOT_A_FALL_NEXT or (nxt == "in" and after == "love"):
            return True
        if low[at] == "fall" and prev in _NOT_AN_EVENT_AFTER:
            return True
    if name in ("fall", "jump") and prev in _THINGS:
        return True  # the snow falls, the ball falls: a thing's, not a cast member's
    if name == "speed" and nxt == "asleep":
        return True
    if name == "stop" and n == 1:
        if low[at] in ("stop", "stops") and nxt in _NOT_A_STOP_NEXT:
            return True  # the stop sign, the stop light
        before2 = low[at - 2] if at > 1 else ""
        if (
            low[at] in ("stop", "brake", "brakes")
            and prev in _NOT_A_STOP_AFTER
            and not (prev == "a" and before2 == "to")
        ):
            return True  # the bus stop, the brakes as a thing ("comes to a stop" is one)
    return (
        name == "bump"
        and low[at] in ("hits", "hit")
        and (nxt in ("brakes", "brake") or (nxt == "the" and after in ("brakes", "brake", "road", "gas")))
    )


def _count(low: Sequence[str], at: int, n: int, c: Clause) -> tuple[int, bool]:
    """(how many times the words say the event happens, whether they give a count): "three times" anywhere after it
    in its clause or before it ("Three times, Lamo jumps"), "twice", "once", "a few times", "3 jumps"; (1, False)
    when they don't say."""

    def number(word: str) -> int | None:
        return _NUMBERS.get(word) or (int(word) if word.isdigit() and len(word) < 3 else None)

    def times_at(k: int) -> int | None:
        w = low[k]
        if w in ("twice", "thrice"):
            return _NUMBERS[w]
        num = number(w)
        if num and k + 1 < c.end and low[k + 1] == "times":
            return num
        if w in ("few", "several", "many", "lots") and "times" in low[k + 1 : min(c.end, k + 3)]:
            return 2
        return None

    for k in range(at + n, c.end):
        if low[k] == "once" and k == at + n and not (k + 1 < c.end and low[k + 1] == "more"):
            return 1, True
        got = times_at(k)
        if got:
            return got, True
    for k in range(c.start, at):
        got = times_at(k)
        if got:
            return got, True
    if at - 1 >= c.start:
        num = number(low[at - 1])
        if num and num > 1 and low[at].endswith("s"):
            return num, True
    return 1, False


_AWAY_AFTER = frozenset({"away", "gone", "absent", "missing"})
_NOT_HERE = frozenset({"at", "here", "there", "home", "around", "anywhere"})


def _absent(low: Sequence[str], names_at: Mapping[int, str], people: set[str]) -> set[str]:
    """The cast people the words say are not there ("Rosa is not at home", "Rosa isn't here", "without Rosa", "Rosa
    is away"): never drawn, and never owed."""
    out: set[str] = set()
    ends: dict[int, str] = {}
    for i, k in names_at.items():
        if k in people and (i + 1 not in names_at or names_at[i + 1] != k):
            ends[i] = k
    starts = {i for i, k in names_at.items() if i - 1 not in names_at or names_at[i - 1] != k}
    for i, k in ends.items():
        after = low[i + 1 : i + 5]
        if after[:1] and after[0] in ("is", "was", "s") and len(after) >= 2:
            rest = after[1:]
            if (rest[0] in ("not", "never") and len(rest) >= 2 and rest[1] in _NOT_HERE) or rest[0] in _AWAY_AFTER:
                out.add(k)
        if after[:2] in (["isn", "t"], ["wasn", "t"]) and len(after) >= 3 and after[2] in _NOT_HERE:
            out.add(k)
        if after[:2] in (["has", "gone"], ["has", "left"], ["s", "gone"]):
            out.add(k)
    for i in starts:
        k = names_at[i]
        if k not in people:
            continue
        before = low[max(0, i - 2) : i]
        if before[-1:] == ["without"] or before == ["without", "the"] or before[-1:] == ["no"]:
            out.add(k)
    return out


def valence(beat: Mapping[str, Any]) -> tuple[bool, bool]:
    """(draws a happy feeling, draws a sad, scared or angry one) for one beat."""
    happy = any(beat.get(f) in HAPPY_DRAWN[f] for f in HAPPY_DRAWN)
    sad = any(beat.get(f) in SAD_DRAWN[f] for f in SAD_DRAWN)
    return happy, sad


def piece_spans(what: str, pieces: Sequence[str]) -> list[tuple[int, int]] | None:
    """Each piece's words in the owner's "What happens" (word index from, to), when the pieces are its words in order;
    None when they are not (the check says so)."""
    whole = tokens(what)
    out: list[tuple[int, int]] = []
    at = 0
    for p in pieces:
        n = len(tokens(p))
        if tokens(p) != whole[at : at + n]:
            return None
        out.append((at, at + n))
        at += n
    return out if at == len(whole) else None
