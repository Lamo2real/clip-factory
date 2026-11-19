"""Retrieval: which help doc answers a question (docs/CONTRACTS.md §19.4). Same rules as ``retrieve.ts``.

* In-memory BM25F (k1 1.2, b 0.75) over the docs that pass the ``when`` filter. Field weights: title 3, keywords
  2.5, where 1.5, answer and steps 1.
* Words are folded (lower case, no diacritics), split on anything that is not a letter or digit, stopwords
  dropped, stemmed (``text.stem``). Every content word of the question is a *group*: its stem, plus the stems of a
  synonym phrase it belongs to ("tik tok" → tiktok, "delete" → throw away), plus, for stems of 5+ letters that no
  doc uses, every doc stem of 5+ letters one edit away ("instagarm" → instagram).
* A doc's score is the sum over the distinct terms of all groups of ``weight * bm25(term)``; weight is 1 for the
  question's own words and 0.5 for words merged in from the previous question (follow-ups). A doc on the page the
  owner is on gets +10 % (a skill page counts as Settings). Ties go to curated guides, then to the smaller id; a guide within 10 % of the best
  generated doc on the same route (path without the hash) counts as a tie.
* The best doc is accepted only when its score ≥ ``MIN_SCORE``, at least half of the question's content groups
  match it, and at least one of the question's own terms is in its title or keywords.
* Follow-ups: the question is ranked on its own first. It is merged with the previous *user* question from the
  history only when it starts with "and", "what about", "how about", "where is that", or when it is short (≤ 4
  content words) and unknown on its own. So a complete question asked right after another one keeps its answer.
  The previous user turn's words are its text plus ``seen``, what its pictures showed (§26).
* Open-ended questions (owner report 2026-11-19): a question whose content words are all vague ("What do I do now?",
  "I'm stuck", "what is this screen") is unknown, never matched to a topic, unless words read from his pictures came
  with it. Words that say when, not what (``TITLE_IGNORED``: now, next, again…) never count for the title rule, so
  "now" can't pick "Is anything running right now". retrieve.ts uses the same two lists.
* Pictures (§26): the words the look step read from the owner's pictures join the query with weight 0.75. They can
  satisfy the title rule, and a picture question is also accepted when at least a quarter of the picture words
  match the best doc. Refusals are checked on the typed question only.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .corpus import HelpDoc
from .text import DEFAULT_STOPWORDS, DEFAULT_SYNONYMS, fold, stem, within_one_edit, words

K1 = 1.2
B = 0.75
MIN_SCORE = 2.0
MIN_MATCHED = 0.5
MAX_CANDIDATES = 6
PAGE_BOOST = 1.1
GUIDE_TIE = 0.9  # a guide within 10 % of a generated doc on the same route counts as a tie, and wins it
FOLLOW_UP_WEIGHT = 0.5
PICTURE_WEIGHT = 0.75
PICTURE_MIN_MATCHED = 0.25
FOLLOW_UP_MAX_WORDS = 4
FUZZY_MIN_LEN = 5
FIELD_WEIGHTS = {"title": 3.0, "keywords": 2.5, "where": 1.5, "body": 1.0}
FOLLOW_UP_STARTS = ("and ", "what about ", "how about ", "and on ", "where is that")

# Words that say "help me" without saying with what. A question made only of these (and stopwords) is open-ended.
VAGUE_WORDS = frozenset(
    [
        "now",
        "next",
        "then",
        "stuck",
        "lost",
        "confused",
        "confusing",
        "happen",
        "happens",
        "happened",
        "happening",
        "going",
        "ok",
        "okay",
        "hi",
        "hello",
        "hey",
        "thanks",
        "thank",
        "yes",
        "no",
        "still",
        "again",
        "right",
        "thing",
        "things",
        "something",
        "anything",
        "everything",
        "nothing",
        "wrong",
        "else",
        "see",
        "seeing",
        "look",
        "looking",
        "mean",
        "means",
        "understand",
        "figure",
        "screen",
        "screens",
        "picture",
        "pictures",
        "image",
        "photo",
        "screenshot",
        "work",
        "works",
        "working",
        "problem",
        "issue",
        # Words that point at a screen Ask can't see ("What should I press here?", "is this done", "which button?").
        "press",
        "pressing",
        "click",
        "clicking",
        "tap",
        "tapping",
        "push",
        "here",
        "there",
        "this",
        "that",
        "button",
        "buttons",
        "done",
        "finished",
        "should",
        "do",
        "doing",
        "which",
        "on",
        "with",
        "in",
        "at",
        "to",
        "for",
    ]
)
VAGUE_STEMS = frozenset(stem(w) for w in VAGUE_WORDS)
# Of those, the ones that never count for the title rule (they say when, not what).
TITLE_IGNORED = frozenset(stem(w) for w in ["now", "next", "then", "right", "again", "still", "ok", "okay"])

REFUSED_TEXT = "I can't help with that. I only know how to use Clip Factory."
UNKNOWN_TEXT = "I don't know that one yet. Try other words, or pick a question below."

# Asks for secrets, the cookie file's contents, other people's things, or how Clip Factory itself is run.
_REFUSE = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\b(passwords?|passcodes?|api ?keys?|access ?keys?|secret|secrets|tokens?|credentials?|private keys?)\b",
        r"\b(show|read|see|print|give|tell)\b.{0,40}\bcookies?\b.{0,20}\b(file|txt|contents?|inside|say|says|values?)\b",
        r"\b(what'?s|what is|whats)\s+(in|inside)\b.{0,20}\bcookies?\b",
        r"\bcookies?\b.{0,20}\b(contents?|values?)\b",
        r"\b(another|other|someone else'?s?|somebody else'?s?|other people'?s?)\s+(users?|persons?|people|owners?|creators?)\b",
        r"\b(someone|somebody) else'?s?\b",
        r"\bother people'?s?\b",
        r"\b(your|clip factory'?s?|the app'?s?)\s+(servers?|database|backend|infrastructure|source code|aws|cloud|hosting)\b",
        r"\bhow (is|are) (it|this|you|clip factory|the app) (hosted|built|run)\b",
        r"\b(aws|amazon web services|dynamodb|lambda|bedrock|cognito|cloudfront|terraform|s3 bucket)\b",
    )
]

Status = Literal["answer", "unknown", "refused"]


@dataclass(frozen=True)
class HelpContext:
    """What the client says about where it is: enums only (§19.6)."""

    device: str | None = None
    os: str | None = None
    installed: bool | None = None
    page: str | None = None


@dataclass(frozen=True)
class Ranked:
    status: Status
    candidates: list[HelpDoc] = field(default_factory=list)  # best first, ≤ 6; empty unless status is "answer"
    score: float = 0.0
    question: str = ""  # the question ranked (merged with the previous one for a follow-up)

    @property
    def top(self) -> HelpDoc | None:
        return self.candidates[0] if self.candidates else None


def page_of(route: str) -> str:
    """The router's page name for an app path (``lib/router.ts`` ``match``)."""
    path = route.split("?", 1)[0].split("#", 1)[0].rstrip("/") or "/"
    if path == "/":
        return "home"
    if path == "/jobs":
        return "jobs"
    if path.startswith("/jobs/"):
        return "job"
    if path == "/review":
        return "review"
    if path == "/library":
        return "library"
    if path.startswith("/clips/"):
        return "clip"
    if path == "/settings" or path.startswith("/settings/"):
        return "settings"
    if path == "/get-app":
        return "get_app"
    return "not_found"


def visible(doc: HelpDoc, context: HelpContext | None) -> bool:
    """The ``when`` filter. Without a context nothing is filtered (the client always sends one)."""
    when = doc.get("when")
    if not when or context is None:
        return True
    if "device" in when and context.device is not None and context.device not in when["device"]:
        return False
    if "os" in when and context.os is not None and context.os not in when["os"]:
        return False
    return not ("installed" in when and context.installed is not None and context.installed != when["installed"])


def refused(question: str) -> bool:
    folded = fold(question).replace("\u2019", "'")
    return any(p.search(folded) for p in _REFUSE)


# --- the index --------------------------------------------------------------------------------------------------


def _terms(text: str, stopwords: frozenset[str]) -> list[str]:
    return [stem(w) for w in words(text) if w not in stopwords]


@dataclass
class _Index:
    docs: list[HelpDoc]
    tf: list[dict[str, float]]  # weighted term frequency per doc
    lengths: list[float]
    title_terms: list[set[str]]  # title + keywords
    df: Counter[str]
    avg_len: float
    vocab_set: set[str] = field(default_factory=set)


def _build(docs: Sequence[HelpDoc], stopwords: frozenset[str]) -> _Index:
    tfs: list[dict[str, float]] = []
    lengths: list[float] = []
    titles: list[set[str]] = []
    df: Counter[str] = Counter()
    for doc in docs:
        fields = {
            "title": _terms(doc["title"], stopwords),
            "keywords": [t for k in doc["keywords"] for t in _terms(k, stopwords)],
            "where": _terms(doc["where"], stopwords),
            "body": _terms(" ".join([doc["answer"], *doc["steps"]]), stopwords),
        }
        tf: dict[str, float] = {}
        length = 0.0
        for name, terms in fields.items():
            weight = FIELD_WEIGHTS[name]
            length += weight * len(terms)
            for term in terms:
                tf[term] = tf.get(term, 0.0) + weight
        tfs.append(tf)
        lengths.append(length)
        titles.append(set(fields["title"]) | set(fields["keywords"]))
        df.update(tf.keys())
    avg = (sum(lengths) / len(lengths)) if lengths else 1.0
    return _Index(list(docs), tfs, lengths, titles, df, avg or 1.0, set(df))


_INDEXES: dict[tuple[int, tuple[str, ...], frozenset[str]], tuple[Sequence[HelpDoc], _Index]] = {}


def _index_for(all_docs: Sequence[HelpDoc], shown: list[HelpDoc], stopwords: frozenset[str]) -> _Index:
    """The index for one corpus and one ``when`` view, kept per warm Lambda (the corpus changes rarely)."""
    key = (id(all_docs), tuple(d["id"] for d in shown), stopwords)
    hit = _INDEXES.get(key)
    if hit is not None and hit[0] is all_docs:
        return hit[1]
    if len(_INDEXES) > 16:
        _INDEXES.clear()
    index = _build(shown, stopwords)
    _INDEXES[key] = (all_docs, index)
    return index


def _bm25(index: _Index, n: int, term: str) -> float:
    tf = index.tf[n].get(term, 0.0)
    if tf <= 0:
        return 0.0
    count = len(index.docs)
    df = index.df[term]
    idf = math.log(1 + (count - df + 0.5) / (df + 0.5))
    norm = K1 * (1 - B + B * index.lengths[n] / index.avg_len)
    return idf * tf * (K1 + 1) / (tf + norm)


# --- the query --------------------------------------------------------------------------------------------------


@dataclass
class _Group:
    alternatives: set[str]
    weight: float
    own: bool  # from the question itself (not merged in from the previous one)
    picture: bool = False  # read from the owner's pictures (§26)


def _groups(
    text: str, weight: float, own: bool, synonyms: Mapping[str, str], stopwords: frozenset[str], *, vocab: set[str]
) -> list[_Group]:
    raw = words(text)
    extra: dict[int, set[str]] = {}
    for phrase, canonical in synonyms.items():
        parts = words(phrase)
        size = len(parts)
        if not size:
            continue
        canon = {stem(w) for w in words(canonical) if w not in stopwords}
        for i in range(len(raw) - size + 1):
            if raw[i : i + size] == parts:
                for j in range(i, i + size):
                    extra.setdefault(j, set()).update(canon)
    groups: list[_Group] = []
    for i, word in enumerate(raw):
        if word in stopwords and i not in extra:
            continue
        alternatives = {stem(word)} if word not in stopwords else set()
        alternatives |= extra.get(i, set())
        fuzzy = {
            v
            for a in alternatives
            if len(a) >= FUZZY_MIN_LEN and a not in vocab
            for v in vocab
            if len(v) >= FUZZY_MIN_LEN and within_one_edit(a, v)
        }
        alternatives |= fuzzy
        if alternatives:
            groups.append(_Group(alternatives, weight, own))
    return groups


def content_words(text: str, stopwords: frozenset[str] = DEFAULT_STOPWORDS) -> list[str]:
    return [w for w in words(text) if w not in stopwords]


# A platform name alone says where, not what: "what do I do now with facebook" is still open (web PLATFORM_WORDS).
PLATFORM_WORDS = frozenset({"facebook", "instagram", "tiktok", "youtube", "twitter", "x", "meta", "google"})


def open_ended(question: str, stopwords: frozenset[str] = DEFAULT_STOPWORDS) -> bool:
    """True when the question has content words and every one is vague ("What do I do now?"), or every one is vague
    but a platform name ("what do I do now with facebook"). Only the assistant, looking at his screen, can answer."""
    raw = words(question)
    found = [w for w in raw if w not in stopwords]
    vague = [w for w in found if w in VAGUE_WORDS or stem(w) in VAGUE_STEMS]
    if not found:
        # Every word is a stop word ("what do i do", "is this done"): open when it names a vague word at all.
        return any(w in VAGUE_WORDS for w in raw)
    rest = [w for w in found if w not in vague]
    return not rest or (bool(vague) and all(w in PLATFORM_WORDS for w in rest))


def previous_user_question(history: Sequence[Mapping[str, Any]] | None) -> str | None:
    for turn in reversed(list(history or [])):
        if turn.get("role") != "user" or not isinstance(turn.get("text"), str):
            continue
        seen = turn.get("seen")
        text = f"{turn['text']} {seen}" if isinstance(seen, str) and seen.strip() else str(turn["text"])
        if text.strip():
            return text.strip()
    return None


def starts_follow_up(question: str) -> bool:
    """Starts with an explicit follow-up phrase ("and the error sound?", "what about TikTok?")."""
    return (" ".join(words(question)) + " ").startswith(FOLLOW_UP_STARTS)


def is_follow_up(question: str, stopwords: frozenset[str] = DEFAULT_STOPWORDS) -> bool:
    """Short enough (≤ 4 content words) or worded like a follow-up: may borrow the previous question's words."""
    return len(content_words(question, stopwords)) <= FOLLOW_UP_MAX_WORDS or starts_follow_up(question)


def boost_page(page: str | None) -> str | None:
    """The page a doc boost compares against: a skill page is part of Settings (§19.4)."""
    if not page:
        return None
    return "settings" if page == "skill" else page


def _route_path(doc: HelpDoc) -> str:
    return doc["route"].split("#", 1)[0]


def _guides_first(scored: list[tuple[float, int, str, int]], docs: list[HelpDoc]) -> list[tuple[float, int, str, int]]:
    """A curated guide wins a near tie (within 10 %) with a generated doc on the same route."""
    top = docs[scored[0][3]]
    if top["kind"] == "guide":
        return scored
    for i, row in enumerate(scored[1:], start=1):
        doc = docs[row[3]]
        if -row[0] < GUIDE_TIE * -scored[0][0]:
            break
        if doc["kind"] == "guide" and _route_path(doc) == _route_path(top):
            return [row, *scored[:i], *scored[i + 1 :]]
    return scored


def _score(index: _Index, groups: list[_Group], context: HelpContext | None, merged: str) -> Ranked:
    if not groups:
        return Ranked("unknown", question=merged)
    weights: dict[str, float] = {}
    for g in groups:
        for term in g.alternatives:
            weights[term] = max(weights.get(term, 0.0), g.weight)
    own = [g for g in groups if g.own and not g.picture]
    pictures = [g for g in groups if g.picture]
    own_terms = {t for g in [*own, *pictures] for t in g.alternatives} - TITLE_IGNORED
    page = boost_page(context.page if context is not None else None)
    scored: list[tuple[float, int, str, int]] = []
    for n, doc in enumerate(index.docs):
        score = sum(w * _bm25(index, n, t) for t, w in weights.items())
        if score <= 0:
            continue
        if page and page_of(doc["route"]) == page:
            score *= PAGE_BOOST
        scored.append((-round(score, 6), 0 if doc["kind"] == "guide" else 1, doc["id"], n))
    if not scored:
        return Ranked("unknown", question=merged)
    scored.sort()
    scored = _guides_first(scored, index.docs)
    best_score = -scored[0][0]
    best = scored[0][3]
    tf = index.tf[best]
    matched = sum(1 for g in own if any(tf.get(t, 0) > 0 for t in g.alternatives))
    title_hit = bool(own_terms & index.title_terms[best])
    enough = (bool(own) or not pictures) and matched >= MIN_MATCHED * len(own)
    if pictures and not enough:
        seen = sum(1 for g in pictures if any(tf.get(t, 0) > 0 for t in g.alternatives))
        enough = seen >= max(1, math.ceil(PICTURE_MIN_MATCHED * len(pictures)))
    if best_score < MIN_SCORE or not enough or not title_hit:
        return Ranked("unknown", score=best_score, question=merged)
    return Ranked(
        "answer",
        [index.docs[s[3]] for s in scored[:MAX_CANDIDATES]],
        best_score,
        merged,
    )


def rank(
    docs: Sequence[HelpDoc],
    question: str,
    history: Sequence[Mapping[str, Any]] | None = None,
    context: HelpContext | None = None,
    *,
    synonyms: Mapping[str, str] | None = None,
    stopwords: frozenset[str] | None = None,
    picture_words: Sequence[str] = (),
) -> Ranked:
    """Ranks the visible docs for a question. Refusals and unknowns carry no candidates (and never cost a model
    call). The question is ranked on its own first; see the module docstring for when it borrows the previous
    question's words."""
    if refused(question):
        return Ranked("refused", question=question)
    synonyms = DEFAULT_SYNONYMS if synonyms is None else synonyms
    stopwords = DEFAULT_STOPWORDS if stopwords is None else stopwords
    if not picture_words and open_ended(question, stopwords):
        return Ranked("unknown", question=question)
    shown = [d for d in docs if visible(d, context)]
    if not shown:
        return Ranked("unknown", question=question)
    index = _index_for(docs, shown, stopwords)
    vocab = index.vocab_set
    groups = _groups(question, 1.0, True, synonyms, stopwords, vocab=vocab)
    if picture_words:
        seen = _groups(" ".join(picture_words), PICTURE_WEIGHT, True, synonyms, stopwords, vocab=vocab)
        groups = groups + [_Group(g.alternatives, g.weight, True, picture=True) for g in seen]
    previous = previous_user_question(history)
    if previous is None or previous.strip() == question.strip():
        return _score(index, groups, context, question)
    if not starts_follow_up(question):
        alone = _score(index, groups, context, question)
        if alone.status == "answer" or not is_follow_up(question, stopwords):
            return alone
    groups = groups + _groups(previous, FOLLOW_UP_WEIGHT, not groups, synonyms, stopwords, vocab=vocab)
    return _score(index, groups, context, f"{previous} {question}")
