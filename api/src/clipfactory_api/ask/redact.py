"""The secrets filter of Ask (docs/CONTRACTS.md §27.2, §27.5).

``redact`` replaces anything that looks like a key, token, account id or email with "[hidden]". It runs on the
knowledge pack (the generator applies the same patterns), on ``.tfvars``/``.env``/``.pem`` files before the model
reads them, and on every streamed answer (``Holdback`` keeps the last 64 characters back so a key split over two
deltas is still caught). ``refused`` is the narrow refusal on the typed question: asking to see or be told a
password, key, token or cookie contents, or about other people's accounts. It is not the §19.2 infra-word filter:
the owner may ask about Terraform, AWS or how the app is built.
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

_REFUSE = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\b(show|tell|give|reveal|read|print|send|display|what'?s|what is|whats|copy|leak|list)\b.{0,40}"
        r"\b(passwords?|passcodes?|api ?keys?|access ?keys?|secret ?keys?|secrets|tokens?|credentials?|private keys?)\b",
        r"\b(show|read|see|print|give|tell)\b.{0,40}\bcookies?\b.{0,20}\b(file|txt|contents?|inside|say|says|values?)\b",
        r"\b(what'?s|what is|whats)\s+(in|inside)\b.{0,20}\bcookies?\b",
        r"\bcookies?\b.{0,20}\b(contents?|values?)\b",
        r"\b(another|other|someone else'?s?|somebody else'?s?|other people'?s?)\s+(users?|owners?)\b.{0,30}"
        r"\b(accounts?|data|clips?|keys?|passwords?)\b",
        r"\b(log ?in|sign ?in|get into|hack)\b.{0,30}\b(someone|somebody|another person'?s?|other people'?s?)\b",
    )
)

REFUSED_ANSWER = (
    "I can't help with passwords, keys or tokens, and I never show them. You enter them yourself in "
    "**Settings › Posting › Accounts** (for the posting apps) or **Settings › App › Ask** (for web search)."
)


def redact(text: str) -> tuple[str, bool]:
    """(text with every secret-looking part replaced, whether anything was replaced)."""
    hit = False
    for pattern in SECRET_PATTERNS:
        text, n = pattern.subn(HIDDEN, text)
        hit = hit or n > 0
    text, n = CLIENT_ID.subn(lambda m: m.group(1) + HIDDEN, text)
    return text, hit or n > 0


def refused(question: str) -> bool:
    folded = question.replace(chr(0x2019), "'")
    return any(p.search(folded) for p in _REFUSE)


class Holdback:
    """Streams text through ``redact`` while keeping the last ``HOLD_BACK`` characters until more arrives, so a
    secret split across two model deltas is still replaced before any of it leaves the worker."""

    def __init__(self, hold: int = HOLD_BACK) -> None:
        self._hold = hold
        self._pending = ""
        self.hit = False

    def push(self, text: str) -> str:
        """Adds text; returns what is safe to send now."""
        self._pending += text
        if len(self._pending) <= self._hold:
            return ""
        cleaned, hit = redact(self._pending)
        self.hit = self.hit or hit
        # Never cut inside a replacement or a word that might still grow into a secret: keep the tail.
        cut = max(0, len(cleaned) - self._hold)
        space = cleaned.rfind(" ", 0, cut + 1)
        if space > 0:
            cut = space + 1
        out, self._pending = cleaned[:cut], cleaned[cut:]
        return out

    def flush(self) -> str:
        cleaned, hit = redact(self._pending)
        self.hit = self.hit or hit
        self._pending = ""
        return cleaned
