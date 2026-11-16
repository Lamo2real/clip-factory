"""Words: normalising, stemming, stopwords, the sensitive-word filter and the no-dashes rule (§19.2, §19.4).

``web/src/features/help/retrieve.ts`` implements the same rules; the shared eval file keeps the two honest.
"""

from __future__ import annotations

import re
import unicodedata

# Used when the corpus carries no ``stopwords`` list. Short on purpose: "off", "on", "up" and numbers carry meaning
# in this app ("turn off sounds"), so they are not stopwords.
_STOPWORDS_TEXT = """a about after again all am an and any are as at be been before being but by can could did do does doing
    for from get got had has have having he her here hers him his how i if in into is it its just me might my
    myself need of or our please she should so some than that the their them then there these they this those to
    too us very via was we were what whats when where which while who why will with would you your yours i'm im
    can't cant don't dont want wanna let lets sure"""
DEFAULT_STOPWORDS: frozenset[str] = frozenset(_STOPWORDS_TEXT.split())

# Phrase → canonical words (§19.2). Matching is on normalised words; the canonical words are added, never replace.
DEFAULT_SYNONYMS: dict[str, str] = {
    "delete": "throw away",
    "remove": "throw away",
    "trash": "throw away",
    "discard": "throw away",
    "confirm": "keep",
    "approve": "keep",
    "save clip": "keep",
    "retry": "try again",
    "redo": "try again",
    "insta": "instagram",
    "ig": "instagram",
    "yt": "youtube",
    "tik tok": "tiktok",
    "twitter": "x",
    "vod": "source",
    "stream": "source",
    "video": "source",
    "link": "source",
    "stats": "performance",
    "statistics": "performance",
    "numbers": "performance",
    "views": "performance",
    "sound effect": "sound",
    "beep": "sound",
    "install": "get the app",
    "download": "get the app",
    "dark": "reduce motion",
    "calm": "reduce motion",
    "calmer": "reduce motion",
}

_SPLIT = re.compile(r"[^a-z0-9]+")


def fold(text: str) -> str:
    """Lower case without diacritics ("Café" → "cafe")."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def words(text: str) -> list[str]:
    """Normalised words in order (apostrophes join: "don't" → "dont")."""
    return [w for w in _SPLIT.split(fold(text).replace("'", "").replace("\u2019", "")) if w]


def stem(word: str) -> str:
    """A light suffix stemmer: -ies→y, -es, -s, -ing, -ed, -ly; never below 3 letters."""
    if word.isdigit():
        return word
    for suffix, repl in (("ies", "y"), ("ing", ""), ("ed", ""), ("ly", ""), ("es", ""), ("s", "")):
        if word.endswith(suffix) and len(word) - len(suffix) + len(repl) >= 3:
            if suffix == "es" and not word.endswith(("ches", "shes", "sses", "xes", "zes")):
                continue  # "updates" → "update" through -s below, not "updat"
            if suffix == "s" and word.endswith("ss"):
                continue
            return word[: len(word) - len(suffix)] + repl
    return word


def within_one_edit(a: str, b: str) -> bool:
    """True when ``a`` and ``b`` differ by at most one insert, delete, substitution or swap of neighbours."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:
        diff = [i for i in range(la) if a[i] != b[i]]
        if len(diff) == 1:
            return True
        return len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]]
    if la > lb:
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1 :]


# --- the sensitive-word filter and the no-dashes rule ----------------------------------------------------------

SENSITIVE = re.compile(
    r"arn:|amazonaws|AKIA[0-9A-Z]{12,}|\b\d{12}\b|[\w.+-]+@[\w-]+\.[\w.]+|s3://|https?://[^\s]*\?"
    r"|\b(?:passwords?|secrets?|tokens?|api keys?|access keys?|lambdas?|dynamodb|bedrock|cognito|cloudfront"
    r"|agentcore|terraform|jwts?|sub claim)\b",
    re.IGNORECASE,
)
DASHES = re.compile(r"\s*[–—]\s*")


def is_sensitive(text: str) -> bool:
    return SENSITIVE.search(text) is not None


def no_dashes(text: str) -> str:
    """Em and en dashes become a comma and a space (the owner's copy never uses them)."""
    return DASHES.sub(", ", text)
