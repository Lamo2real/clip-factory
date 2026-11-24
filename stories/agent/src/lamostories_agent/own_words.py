"""Write it myself: the owner's own words, read by code (docs/CONTRACTS.md §45.46.6, ADR-95).

The faithful check (``own_script.own_problems``) never takes the adapter's word for what the owner wrote. Here, from
the owner's own "What happens" (never from the adapter's pieces), code reads which events it says, who does each one,
in which order and how many times, what it says does NOT happen, how someone feels, who is away, and the places it
names. Plain word rules, kept small on purpose: an event is read only from clear words ("falls", "jumps three times",
"Rosso skids"), and where the words are unclear (a pronoun two people could be) the check lets either be drawn and
the scene's note says who was. Pure: no I/O and no model."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any


def clean(value: Any) -> str:
    """NFC, with the invisible format characters (a zero-width space, a soft hyphen, …) taken out: a pasted word reads
    as it shows (a zero-width space inside "falls" is still "falls")."""
    text = unicodedata.normalize("NFC", str(value or ""))
    return "".join(ch for ch in text if unicodedata.category(ch) != "Cf")


_ALNUM = re.compile(r"[^\W_]+")  # letters and digits (str.isalnum), as own_script.norm keeps them
_STOP = re.compile(r"[.!?;:\n…]")  # a sentence ends
_PAUSE = re.compile(r"[,()\[\]–—]")  # a clause ends inside a sentence


def tokens(value: Any) -> list[str]:
    """The words of a text in lower case, as ``own_script.norm`` gives them ("doesn't" is "doesn", "t")."""
    return [m.group(0).lower() for m in _ALNUM.finditer(clean(value))]


# Words that start a new clause ("Lamo falls and Rosa laughs"); a clause that starts with one and names nobody before
# its event is the clause before's subject's ("Lamo hugs Rosa and falls": Lamo falls).
BREAKERS = frozenset(
    {"and", "but", "then", "so", "while", "when", "after", "before", "until", "because", "meanwhile", "once", "as"}
)
# Joiners after which the next event may happen at the same time, or earlier: the order is not checked across them.
NOT_IN_ORDER = frozenset({"while", "when", "after", "before", "until", "because", "meanwhile", "as", "once"})
# Little words skipped when the subject of a clause is read ("Then suddenly Lamo falls").
SKIP = frozenset(
    {"and", "then", "so", "but", "the", "a", "an", "also", "too", "now", "next", "later", "suddenly", "finally",
     "first", "soon", "just", "still", "even", "only", "really", "very", "quickly", "slowly", "again", "both",
     "together", "s", "little", "big", "poor", "silly", "brave", "happy", "sad", "meanwhile", "after", "that",
     "this", "all", "of", "while", "when", "as", "once"}
)  # fmt: skip
PREPOSITIONS = frozenset(
    {"at", "to", "with", "past", "behind", "near", "from", "into", "onto", "towards", "toward", "for", "by", "over",
     "under", "around", "beside", "after", "like", "of", "in", "on", "through", "across", "without", "than"}
)  # fmt: skip
VEHICLE_WORDS = frozenset({"car", "cars", "truck", "van", "bus", "lorry", "taxi", "jeep", "vehicle"})
HE = frozenset({"he", "him", "his", "himself"})
SHE = frozenset({"she", "her", "hers", "herself"})
THEY = frozenset({"they", "them", "their", "themselves"})
PRONOUNS = HE | SHE | THEY | {"it"}
# A clause whose words say an event does not happen ("does not fall", "doesn't stop", "Don't trip!"): never drawn.
HARD_NO = frozenset(
    {"not", "never", "no", "t", "without", "nobody", "nothing", "neither", "nor", "dont", "doesnt", "didnt", "wont",
     "cant", "cannot", "isnt", "wasnt", "arent", "werent", "couldnt", "wouldnt", "shouldnt", "avoid", "avoids",
     "avoided", "avoiding", "instead"}
)  # fmt: skip
# "nearly falls": it may be drawn (a slip), but it is not owed.
SOFT_NO = frozenset({"almost", "nearly"})
_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
            "ten": 10, "twice": 2, "thrice": 3}  # fmt: skip
MAX_COUNT = 5
CAR = "@car"  # a mention's doer: any car of the scene ("the car skids")


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


# Strict words on purpose: an event the words say is owed (it must be drawn, by who does it), so only clear verbs
# count. Each stem is words in ``tokens`` form; the last one is a word start unless it ends with "$" (the whole word).
FAMILIES: dict[str, Family] = {
    "fall": Family(
        ("fall$", "falls$", "fell$", "falling$", "fallen$", "tumbl", "toppl", "collaps", "trips$", "tripped$",
         "tripping$", "trip over", "trip up", "slip$", "slips$", "slipped$", "slipping$"),
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
         "smashes$", "smashed$", "hits$", "hit$", "runs into", "ran into", "backs into", "reverses into"),
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
}  # fmt: skip
# The engine action -> the family it draws (a beat doing one is an event of that family).
ACTION_FAMILY = {a: name for name, fam in FAMILIES.items() for a in fam.actions}
_SAME_TIME = {"in", "into", "out", "on", "onto", "off"}  # "jumps in the car": getting in shows it too
_NOT_A_FALL_NEXT = {"asleep", "apart", "behind", "silent", "quiet", "ill", "sick", "short", "for"}
_NOT_AN_EVENT_AFTER = {"the", "this", "last", "next"}  # "in the fall", "this fall": a season
# A thing that falls or bounces ("watches the snow fall"): not a cast member's event.
_THINGS = frozenset(
    {"snow", "rain", "leaves", "leaf", "ball", "balls", "cup", "plate", "glass", "book", "toy", "toys", "hat",
     "night", "tree", "apple", "apples", "box", "phone", "ice", "water", "sky", "star", "stars", "sun", "petals",
     "flowers", "cake", "bag", "shoe", "shoes", "kite", "balloon", "rock", "rocks", "stone", "stones", "it"}
)  # fmt: skip

# How someone feels: a clause that says it, and what draws the other feeling (never drawn under its words).
HAPPY_WORDS = (
    "happy", "happily", "glad", "joy", "laugh", "giggl", "smile", "smiling", "grin", "cheer", "celebrat", "hug$",
    "hugs$", "hugged$", "hugging$", "kiss", "love", "loves$", "loved$", "proud", "excited", "delighted", "thrilled",
    "yay$", "hooray", "hurray", "enjoy", "high five",
)  # fmt: skip
SAD_WORDS = (
    "sad$", "sadly", "cry$", "cries$", "cried$", "crying$", "tears", "sob$", "sobs$", "sobbing", "upset", "unhappy",
    "angry", "angrily", "mad$", "furious", "scared", "afraid", "frightened", "terrified", "worried", "nervous",
    "grumpy", "sulk", "miserable", "lonely", "scream",
)  # fmt: skip
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
    count: int = 1
    denied: bool = False  # the words say it does not happen
    soft: bool = False  # "nearly": may be drawn, never owed
    ambiguous: bool = False
    outside: bool = False  # done by someone not drawn (left out, or not in the cast)
    also: frozenset[str] = frozenset()  # more actions that show it ("jumps in the car": get_in)


@dataclass
class Mood:
    clause: int
    happy: bool  # True: a happy clause; False: a sad, scared or angry one
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


def _split(text: str) -> tuple[list[str], list[str], list[int], list[str]]:
    """The words (lower case and as written), each word's sentence and the mark or joining word before it."""
    low: list[str] = []
    raw: list[str] = []
    sentence: list[int] = []
    gap: list[str] = []
    last, s = 0, 0
    for m in _ALNUM.finditer(text):
        between = text[last : m.start()]
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
        last = m.end()
    return low, raw, sentence, gap


def _name_tokens(name: str) -> list[list[str]]:
    full = tokens(name)
    if not full:
        return []
    return [full, full[:1]] if len(full) > 1 and len(full[0]) > 1 else [full]


def _mark_names(low: Sequence[str], names: Mapping[str, str]) -> dict[int, str]:
    """Word index -> cast key for every cast name in the words (the whole name, or its first word; "Dashs", a
    possessive typed without its apostrophe, is Dash)."""
    out: dict[int, str] = {}
    for key, name in names.items():
        for parts in _name_tokens(name):
            n = len(parts)
            for i in range(len(low) - n + 1):
                window = list(low[i : i + n])
                typo = n == 1 and len(parts[0]) >= 3 and window[0] == parts[0] + "s"
                if (window == parts or typo) and all(i + k not in out for k in range(n)):
                    for k in range(n):
                        out[i + k] = key
    return out


def _content(word: str, i: int, names_at: Mapping[int, str], outside_at: set[int]) -> bool:
    return i not in names_at and i not in outside_at and word not in SKIP


def _clauses(low: Sequence[str], sentence: Sequence[int], gap: Sequence[str], names_at: Mapping[int, str],
             outside_at: set[int]) -> list[Clause]:  # fmt: skip
    """The clauses: a sentence mark or a comma ends one, and so does a joining word once the clause has a word that
    is not a name ("Lamo and Rosa jump" stays one; "Lamo falls and Rosa laughs" is two). A clause with only names
    and little words in it joins the next one in its sentence ("Lamo, Rosa and Max dance")."""
    out: list[Clause] = []
    start, lead = 0, ""
    for i, word in enumerate(low):
        if i == 0:
            continue
        cut = gap[i] in (".", ",")
        if not cut and word in BREAKERS:
            cut = any(_content(low[k], k, names_at, outside_at) for k in range(start, i))
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
             outside_at: set[int]) -> tuple[set[str], bool, str | None, bool]:  # fmt: skip
    """Who a clause's words name before word ``upto``: (cast keys, someone outside the cast, the first pronoun, a
    car word), names after a preposition aside ("skids past Bolt", "waves at Rosa")."""
    keys: set[str] = set()
    outside = False
    pronoun: str | None = None
    vehicle = False
    for k in range(c.start, min(upto, c.end)):
        after_prep = k > c.start and low[k - 1] in PREPOSITIONS
        if k in names_at:
            if not after_prep:
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
    return all(low[k] in SKIP or low[k] in BREAKERS for k in range(start, upto))


def learn_genders(texts: Iterable[str], names: Mapping[str, str], given: Mapping[str, str] | None = None,
                  people: Iterable[str] = ()) -> dict[str, str]:  # fmt: skip
    """cast key -> "he" or "she", from what is known of the characters (``given``) and the owner's own words: a
    sentence that names one person and says he or she of someone (or starts the next sentence so) tells it. A person
    told both is left unknown."""
    seen: dict[str, set[str]] = {k: {v} for k, v in (given or {}).items() if v in ("he", "she")}
    people = set(people) or set(names)
    for text in texts:
        low, _raw, sentence, _gap = _split(clean(text))
        at = _mark_names(low, {k: v for k, v in names.items() if k in people})
        by_sentence: dict[int, list[int]] = {}
        for i in range(len(low)):
            by_sentence.setdefault(sentence[i], []).append(i)
        prev_one: str | None = None
        for s in sorted(by_sentence):
            idx = by_sentence[s]
            named = list(dict.fromkeys(at[i] for i in idx if i in at))
            first_name = next((i for i in idx if i in at), None)
            for i in idx:
                word = low[i]
                g = "he" if word in HE else "she" if word in SHE else None
                if g is None:
                    continue
                if len(named) == 1 and first_name is not None and i > first_name:
                    seen.setdefault(named[0], set()).add(g)
                elif not named and prev_one is not None and i == idx[0]:
                    seen.setdefault(prev_one, set()).add(g)
            prev_one = named[0] if len(named) == 1 else None
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1}


GENDER_WORDS = {
    "he": frozenset({"he", "his", "him", "boy", "man", "dad", "father", "brother", "son", "grandpa", "grandad",
                     "uncle", "king", "prince", "mr", "husband", "guy", "gentleman", "lad"}),
    "she": frozenset({"she", "her", "girl", "woman", "mum", "mom", "mother", "sister", "daughter", "grandma",
                      "granny", "aunt", "queen", "princess", "mrs", "ms", "miss", "wife", "lady"}),
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
) -> Reading:
    """The owner's "What happens" of one scene, read. ``names``: cast key -> name (people and cars); ``cars``: the
    cars' keys; ``outside``: the names the owner left out (people the video does not draw); ``genders``: cast key ->
    "he"/"she" where known."""
    text = clean(what)
    low, raw, sentence, gap = _split(text)
    names_at = _mark_names(low, names)
    car_keys = set(cars)
    people = {k for k in names if k not in car_keys}
    out_words = {w for x in outside for w in tokens(x)}
    outside_at = {i for i, w in enumerate(low) if w in out_words and i not in names_at and raw[i][:1].isupper()}
    reading = Reading(low, raw, names_at=names_at)
    reading.clauses = _clauses(low, sentence, gap, names_at, outside_at)
    sexes = dict(genders or {})

    def resolve(pronoun: str, c: Clause, k: int) -> tuple[frozenset[str] | None, bool]:
        """Who a pronoun at a clause's start is: the person named before it whose he or she it is, else the only
        one named; two people that could both be it are ambiguous (either may be drawn, the note says who)."""
        if pronoun == "it":
            return frozenset({CAR}), False
        if pronoun in THEY:
            prev = next((x for x in reversed(reading.clauses[:k]) if x.subject), None)
            return (prev.subject if prev else None), False
        want = "he" if pronoun in HE else "she"
        for s in range(c.sentence, -1, -1):  # the latest sentence that names someone first
            here = list(dict.fromkeys(
                names_at[i] for i in sorted(names_at) if sentence[i] == s and i < c.start and names_at[i] in people
            ))  # fmt: skip
            if not here:
                continue
            match = [p for p in here if sexes.get(p) == want]
            if len(match) == 1:
                return frozenset(match), False
            maybe = [p for p in here if sexes.get(p) in (None, want)]
            if maybe:
                return frozenset(maybe), len(maybe) > 1
            return None, False
        return None, False

    for k, c in enumerate(reading.clauses):
        lead_keys: set[str] = set()
        lead_outside = False
        first_other: int | None = None
        for i in range(c.start, c.end):  # the names at the clause's start, before its first other word
            if i in names_at:
                lead_keys.add(names_at[i])
            elif i in outside_at:
                lead_outside = True
            elif low[i] not in SKIP:
                first_other = i
                break
        if lead_keys:
            c.subject = frozenset(lead_keys)
        elif first_other is not None and low[first_other] in PRONOUNS:
            c.subject, c.ambiguous = resolve(low[first_other], c, k)
        elif lead_outside:
            c.outside = True
        elif k > 0 and reading.clauses[k - 1].sentence == c.sentence and c.lead in BREAKERS | {","}:
            prev = reading.clauses[k - 1]  # "Lamo hugs Rosa and falls": Lamo falls
            c.subject, c.ambiguous, c.outside = prev.subject, prev.ambiguous, prev.outside

    for k, c in enumerate(reading.clauses):
        toks = low[c.start : c.end]
        hard = [c.start + i for i, w in enumerate(toks) if w in HARD_NO]
        soft = [c.start + i for i, w in enumerate(toks) if w in SOFT_NO]
        for name, fam in FAMILIES.items():
            if fam.needs and not set(toks) & fam.needs:
                continue
            for i, n in find(toks, fam.stems):
                at = c.start + i
                if _not_an_event(name, low, at, n):
                    continue
                keys, out, pronoun, vehicle = _leading(low, c, at, names_at, outside_at)
                doers: frozenset[str] | None
                ambiguous = outside_doer = False
                if keys:
                    doers = frozenset(keys)
                elif c.subject is not None and (pronoun is not None or _only_little(low, c.start, at)):
                    doers, ambiguous = c.subject, c.ambiguous
                elif out or (c.outside and _only_little(low, c.start, at)):
                    doers, outside_doer = frozenset(), True
                else:
                    doers = None  # "The boy falls": someone, the words do not say who
                nxt_at = at + n
                if doers is not None and nxt_at < c.end and nxt_at in names_at:
                    doers = doers | {names_at[nxt_at]}  # "Rosa trips Lamo", "Rosso hits Bolt": either may show it
                if fam.vehicle and vehicle:  # "Dash's car skids", "the car skids": the car does it
                    doers = (doers or frozenset()) | {CAR}
                if not fam.vehicle and doers is not None and doers <= {CAR}:
                    doers = None  # "It falls": a thing, not a cast member
                nxt = low[at + n] if at + n < len(low) else ""
                also = frozenset({"get_in", "get_out"}) if name == "jump" and nxt in _SAME_TIME else frozenset()
                mention = Mention(name, at, k, doers, ambiguous=ambiguous, outside=outside_doer, also=also)
                mention.denied = any(j < at for j in hard)  # "doesn't start" is its own words: never before them
                mention.soft = any(j < at for j in soft)
                mention.count = _count(low, at, n, c)
                reading.mentions.append(mention)
        happy = bool(find(toks, HAPPY_WORDS))
        sad = bool(find(toks, SAD_WORDS))
        if happy != sad and not hard:
            who = {names_at[i] for i in range(c.start, c.end) if i in names_at and names_at[i] in people}
            if c.subject:
                who |= {p for p in c.subject if p in people}
            if who:
                reading.moods.append(Mood(k, happy, frozenset(who)))
    reading.absent = _absent(low, names_at, people)
    for i in range(1, len(low)):
        if low[i - 1] in PLACE_PREPS or (i >= 2 and low[i - 1] in PLACE_DETS and low[i - 2] in PLACE_PREPS):
            reading.places.append((i, low[i]))
    return reading


def _not_an_event(name: str, low: Sequence[str], at: int, n: int) -> bool:
    """Words that look like an event and are not one: "falls asleep", "in the fall", "the snow falls", "fast
    asleep", "hits the brakes"."""
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
    return (
        name == "bump"
        and low[at] in ("hits", "hit")
        and (nxt in ("brakes", "brake") or (nxt == "the" and after in ("brakes", "brake", "road", "gas")))
    )


def _count(low: Sequence[str], at: int, n: int, c: Clause) -> int:
    """How many times the words say the event happens ("three times", "twice", "3 jumps"); 1 when they don't say."""

    def number(word: str) -> int | None:
        return _NUMBERS.get(word) or (int(word) if word.isdigit() and len(word) < 3 else None)

    for k in range(at + n, min(c.end, at + n + 4)):
        if low[k] in ("twice", "thrice"):
            return min(MAX_COUNT, _NUMBERS[low[k]])
        num = number(low[k])
        if num and k + 1 < c.end and low[k + 1] == "times":
            return max(1, min(MAX_COUNT, num))
    if at - 1 >= c.start:
        num = number(low[at - 1])
        if num and num > 1 and low[at].endswith("s"):
            return min(MAX_COUNT, num)
    return 1


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
