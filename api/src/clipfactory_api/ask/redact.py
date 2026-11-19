"""The secrets filter of Ask (docs/CONTRACTS.md §28.2, §28.5).

Two strengths:

* ``redact`` (wide) replaces anything that looks like a key, token, account id, email or a URL with a query by
  "[hidden]". It runs on the knowledge pack (the generator applies the same patterns), on the owner's data in
  APP STATE, and on every text-like or office file before the model reads it.
* ``Holdback`` (narrow) runs on every streamed answer. It hides only high-confidence shapes (private key blocks,
  ``AKIA``/``ASIA`` access keys, ``sk-``/``ghp_``/``xox`` style keys) and the owner's own stored values the worker
  holds (the search key), so Terraform examples, emails in a recipe and cited links with a query stay readable. It
  keeps the last 64 characters back, never cuts inside an unfinished word, and once a private key block starts it
  holds everything back until the block ends, so a key split over many deltas never leaves the worker.

``refused`` is the narrow refusal on the typed question: asking to be shown his own stored password, key, token or
cookie contents, or about other people's accounts. Questions about what a token is or how to store keys are answered.
"""

from __future__ import annotations

import re

HIDDEN = "[hidden]"
HOLD_BACK = 64

SECRET_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p)
    for p in (
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
        r"arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[^\s\"'`)\]]+",
        r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
        r"\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
        r"|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})",
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
        r"https?://[^\s\"'`<>)\]]*\?[^\s\"'`<>)\]]+",
        r"\b(?:eu|us|ap|ca|sa|me|af|il|mx)-[a-z]+-\d_[A-Za-z0-9]{9}\b",  # Cognito user pool ids
        r"(?i)\b(?:aws_secret_access_key|secret_access_key|client_secret|api_key|apikey|password|passwd|token)"
        r"\s*[=:]\s*[\"']?[A-Za-z0-9_\-./+=]{8,}",
        r"(?<!\d)\d{12}(?!\d)",  # AWS account ids
    )
)
# A Cognito app client id is 26 lower-case letters and digits; matched only next to the word "client".
CLIENT_ID = re.compile(r"(?i)(client[ _-]?id\W{0,4})[a-z0-9]{26}\b")

# The narrow set for model output: shapes that are almost never anything but a secret.
OUTPUT_PATTERNS: tuple[re.Pattern[str], ...] = (
    SECRET_PATTERNS[0],  # private key blocks (an unfinished block is held back by Holdback)
    SECRET_PATTERNS[2],  # AKIA/ASIA access keys
    SECRET_PATTERNS[3],  # sk-, ghp_, xox and similar keys
)
KEY_BEGIN = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
KEY_END = re.compile(r"-----END [A-Z ]*PRIVATE KEY-----")
# An unbroken token is held at most this long while it waits for a character no key contains.
HOLD_TOKEN_MAX = 2_000
_BREAK = re.compile(r"[\s,;:!?()\[\]{}<>\"'`\u3000-\u303f\uff0c\uff1a\uff1b]")

_MINE = r"(?:my|our|his|the app'?s|clip factory'?s|your|saved|stored)"
_STORED_THINGS = (
    r"(?:passwords?|passcodes?|api ?keys?|access ?keys?|secret ?keys?|secrets?|tokens?|credentials?|private keys?"
    r"|client ?secrets?|app ?secrets?|search ?keys?|keys?)"
)
_REFUSE = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        # "show me my API key", "what's my Instagram app secret", "read the app's saved token"
        r"\b(show|tell|give|reveal|read|print|send|display|what'?s|what is|whats|copy|leak|list)\b.{0,20}"
        rf"\b{_MINE}\b.{{0,30}}\b{_STORED_THINGS}\b",
        r"\b(show|read|see|print|give|tell)\b.{0,40}\bcookies?\b.{0,20}\b(file|txt|contents?|inside|say|says|values?)\b",
        r"\b(what'?s|what is|whats)\s+(in|inside)\b.{0,20}\bcookies?\b",
        rf"\b{_MINE}\b.{{0,20}}\bcookies?\b.{{0,20}}\b(contents?|values?)\b",
        r"\b(another|other|someone else'?s?|somebody else'?s?|other people'?s?)\s+(users?|owners?)\b.{0,30}"
        r"\b(accounts?|data|clips?|keys?|passwords?)\b",
        r"\b(log ?in|sign ?in|get into|hack)\b.{0,30}\b(someone|somebody|another person'?s?|other people'?s?)\b",
    )
)

# The places in Settings where he enters keys (checked against web/src/lib/settingsTree.ts by the tests).
REFUSED_ANSWER = (
    "I can't show passwords, keys or tokens, and I never read them. You enter them yourself in "
    "**Settings › Posting › Set up posting** (for the posting apps) or **Settings › App & account › Ask** "
    "(for web search)."
)


def redact(text: str) -> tuple[str, bool]:
    """(text with every secret-looking part replaced, whether anything was replaced). The wide filter."""
    hit = False
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn(HIDDEN, text)
        hit = hit or n > 0
    text, n = CLIENT_ID.subn(lambda m: m.group(1) + HIDDEN, text)
    return text, hit or n > 0


def redact_output(text: str, values: tuple[str, ...] = ()) -> tuple[str, bool]:
    """The narrow filter for answers: high-confidence key shapes and the given stored values only."""
    hit = False
    for value in values:
        if value and value in text:
            text = text.replace(value, HIDDEN)
            hit = True
    for pattern in OUTPUT_PATTERNS:
        text, n = pattern.subn(HIDDEN, text)
        hit = hit or n > 0
    return text, hit


_HOW = re.compile(r"\b(how|where|why|should|best way)\b", re.IGNORECASE)


def refused(question: str) -> bool:
    folded = question.replace(chr(0x2019), "'")
    if _REFUSE[0].search(folded) and not _HOW.search(folded):
        return True
    return any(p.search(folded) for p in _REFUSE[1:])


class Holdback:
    """Streams answer text through ``redact_output``. It keeps the last ``HOLD_BACK`` characters, never cuts inside
    an unbroken word (up to ``HOLD_TOKEN_MAX``), and inside a private key block holds everything back until
    ``-----END … PRIVATE KEY-----`` (or the end of the answer), so a secret split over many deltas is still hidden
    before any of it leaves the worker."""

    def __init__(self, hold: int = HOLD_BACK, values: tuple[str, ...] = ()) -> None:
        self._hold = hold
        self._values = tuple(v for v in values if v and len(v) >= 8)
        self._pending = ""
        self._in_key = False
        self.hit = False

    def secret(self, value: str | None) -> None:
        """Adds one stored value (the search key) that must never be shown."""
        if value and len(value) >= 8 and value not in self._values:
            self._values = (*self._values, value)

    def _clean(self, text: str) -> str:
        cleaned, hit = redact_output(text, self._values)
        self.hit = self.hit or hit
        return cleaned

    def _skip_key(self) -> bool:
        """Inside a key block: drops text up to its END. True when the block is still open."""
        end = KEY_END.search(self._pending)
        if end is None:
            # Keep only a tail that could hold the start of the END marker.
            self._pending = self._pending[-40:]
            return True
        self._pending = self._pending[end.end() :]
        self._in_key = False
        return False

    def push(self, text: str) -> str:
        """Adds text; returns what is safe to send now."""
        self._pending += text
        out = ""
        while True:
            if self._in_key and self._skip_key():
                return out
            begin = KEY_BEGIN.search(self._pending)
            if begin is not None and KEY_END.search(self._pending, begin.end()) is None:
                out += self._clean(self._pending[: begin.start()]) + HIDDEN
                self.hit = True
                self._pending = self._pending[begin.end() :]
                self._in_key = True
                continue
            break
        if len(self._pending) <= self._hold:
            return out
        # Cut the raw text at a character no key contains, at least ``hold`` characters from the end: a key can't
        # straddle the cut, so the part sent is cleaned whole and the unfinished tail waits, uncleaned, for more.
        pending = self._pending
        cut = max(0, len(pending) - self._hold)
        breaks = [m.start() for m in _BREAK.finditer(pending, 0, cut + 1)]
        if breaks and breaks[-1] > 0:
            cut = breaks[-1] + 1
        elif len(pending) < HOLD_TOKEN_MAX:
            return out  # one long unbroken token: wait for its end (it could still grow into a key)
        out += self._clean(pending[:cut])
        self._pending = pending[cut:]
        return out

    def flush(self) -> str:
        if self._in_key:
            self._pending, self._in_key = "", False
            return ""
        cleaned = self._clean(self._pending)
        self._pending = ""
        return cleaned
