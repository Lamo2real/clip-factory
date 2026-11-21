"""Campaign captions (docs/CONTRACTS.md §38.14): every publisher runs a campaign post's caption through
``campaign_caption`` just before sending it, so a caption the owner edited on Review still qualifies.

* The disclosure (``#Ad`` unless the campaign asks for another) goes first, the same rule as the agent (§38.13): it is
  put in front unless a ``#ad``-like token already starts within the first 30 characters.
* Every required hashtag, tag and phrase the caption lacks is added at the end.
* Each platform's limits hold, and the required items are never what gets cut: Instagram 2,200 characters and 30
  hashtags (other hashtags are dropped first), X 280 characters (the free text is shortened, never a tag), YouTube's
  description 5,000 bytes, TikTok and Facebook 2,200 characters.

Pure code: no I/O and no imports from the rest of the app. ``campaign`` is the post's internal
``postOptions.campaign`` (``{paidPartnership, disclosure, required}``), made by ``campaign_options`` at Confirm.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

DISCLOSURES = ("#Ad", "#ad", "#Sponsored", "#sponsored", "#PaidPartnership")
DEFAULT_DISCLOSURE = "#Ad"
# The tokens that already tell viewers it is an ad (case-insensitive), when they start in the first 30 characters.
AD_LIKE = frozenset(d.lower() for d in DISCLOSURES)
DISCLOSURE_WINDOW = 30
# (limit, unit): characters, except YouTube's description, which YouTube counts in bytes.
LIMITS: dict[str, tuple[int, str]] = {
    "youtube": (5000, "bytes"),
    "tiktok": (2200, "chars"),
    "instagram": (2200, "chars"),
    "facebook": (2200, "chars"),
    "x": (280, "chars"),
}
HASHTAG_LIMITS = {"instagram": 30}
ONE_LINE = frozenset({"x"})  # X's text is sent on one line (publishers.x_text)
ELLIPSIS = "…"
_HASHTAG = re.compile(r"#\w+")
_TOKEN = re.compile(r"[#@][\w.]*\w")
_PLACEHOLDER = re.compile(r"\[[^\]]*\]|\{[^}]*\}|<[^>]*>")


# --- what a campaign post carries (Confirm, §38.14) ---------------------------------------------------------------


def disclosure_of(raw: Any) -> str:
    """The campaign's caption disclosure, one of ``DISCLOSURES``; ``#Ad`` for anything else."""
    return raw if isinstance(raw, str) and raw in DISCLOSURES else DEFAULT_DISCLOSURE


def _strings(raw: Any) -> list[str]:
    return [s.strip() for s in raw if isinstance(s, str) and s.strip()] if isinstance(raw, list | tuple) else []


def required_items(rules: Mapping[str, Any] | None) -> list[str]:
    """The required hashtags, then tags, then the required caption text (placeholders like ``[your hook]``,
    ``{x}`` and ``<x>`` removed; a text made only of ``#``/``@`` tokens adds each token, anything else is one
    phrase), each once (case-insensitive), as the agent's ``required_tags`` does (§38.13)."""
    rules = rules or {}
    found = [*_strings(rules.get("requiredHashtags")), *_strings(rules.get("requiredTags"))]
    text = rules.get("requiredCaptionText")
    if isinstance(text, str):
        fixed = " ".join(_PLACEHOLDER.sub(" ", text).split())
        tokens = fixed.split(" ") if fixed else []
        if tokens and all(t[:1] in {"#", "@"} for t in tokens):
            found += tokens
        elif fixed:
            found.append(fixed)
    out: list[str] = []
    seen: set[str] = set()
    for item in found:
        if item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


def campaign_options(rules: Mapping[str, Any] | None) -> dict[str, Any]:
    """The internal ``postOptions.campaign`` of every campaign post (§38.14)."""
    disclosure = (rules or {}).get("disclosure")
    caption = disclosure.get("caption") if isinstance(disclosure, Mapping) else None
    return {"paidPartnership": True, "disclosure": disclosure_of(caption), "required": required_items(rules)}


# --- the caption ---------------------------------------------------------------------------------------------------


def _measure(platform: str, text: str) -> int:
    _, unit = LIMITS.get(platform, (2200, "chars"))
    return len(text.encode()) if unit == "bytes" else len(text)


def _is_token(item: str) -> bool:
    return bool(_TOKEN.fullmatch(item))


def _token_pattern(item: str) -> re.Pattern[str]:
    # A whole token: "#FaZe" is not in "#FaZeClan", "@faze" is not in "@faze.clan"; a full stop after it is fine.
    return re.compile(rf"(?<![\w#@]){re.escape(item)}(?![\w]|\.\w)", re.IGNORECASE)


def _has(text: str, item: str) -> bool:
    if _is_token(item):
        return bool(_token_pattern(item).search(text))
    return " ".join(item.split()).casefold() in " ".join(text.split()).casefold()


def _ad_first(text: str) -> bool:
    for match in _HASHTAG.finditer(text):
        if match.start() >= DISCLOSURE_WINDOW:
            return False
        if match.group(0).lower() in AD_LIKE:
            return True
    return False


def _tidy(text: str, one_line: bool) -> str:
    if one_line:
        return " ".join(text.split())
    lines = [re.sub(r"[ \t]{2,}", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _remove(text: str, item: str) -> str:
    if _is_token(item):
        return _token_pattern(item).sub("", text)
    words = [re.escape(w) for w in item.split()]
    return re.compile(r"\s+".join(words), re.IGNORECASE).sub("", text) if words else text


def _kept_hashtags(disclosure: str, required: list[str]) -> set[str]:
    keep = {disclosure.lower(), *AD_LIKE}
    for item in required:
        keep.update(h.lower() for h in _HASHTAG.findall(item))
    return keep


def _fit_hashtags(text: str, limit: int, keep: set[str]) -> str:
    """At most ``limit`` hashtags: the last ones that are not kept go first."""
    found = list(_HASHTAG.finditer(text))
    extra = len(found) - limit
    if extra <= 0:
        return text
    drop: list[re.Match[str]] = []
    for match in reversed(found):
        if len(drop) == extra:
            break
        if match.group(0).lower() not in keep:
            drop.append(match)
    for match in drop:  # from the end, so earlier offsets stay right
        text = text[: match.start()] + text[match.end() :]
    return text


def _prefix(platform: str, text: str, room: int) -> str:
    """The longest start of ``text`` that fits ``room`` (in the platform's unit)."""
    if LIMITS.get(platform, (0, "chars"))[1] == "bytes":
        return text.encode()[:room].decode("utf-8", "ignore")
    return text[:room]


def _shorten(platform: str, text: str, room: int) -> str:
    """``text`` cut at a word to fit ``room``, with "…" when anything was cut ("" when nothing fits)."""
    if _measure(platform, text) <= room:
        return text
    budget = room - _measure(platform, ELLIPSIS)
    if budget <= 0:
        return ""
    head = _prefix(platform, text, budget)
    if text[len(head) : len(head) + 1].strip() and re.search(r"\s", head):
        head = re.sub(r"\S+$", "", head)  # it stopped inside a word: cut back to the last space
    head = head.rstrip()
    return head + ELLIPSIS if head else ""


def _fit_length(platform: str, text: str, disclosure: str, required: list[str], one_line: bool) -> str:
    limit, _ = LIMITS.get(platform, (2200, "chars"))
    if _measure(platform, text) <= limit:
        return text
    # Too long: the disclosure, then the free text shortened, then every required item. Nothing required is cut.
    free = text
    for item in [disclosure, *required]:
        free = _remove(free, item)
    free = _tidy(free, one_line)
    sep = " " if one_line else "\n\n"
    tail = " ".join(required)
    fixed = disclosure + (sep + tail if tail else "")
    room = limit - _measure(platform, fixed) - _measure(platform, " ")
    short = _shorten(platform, free, room) if room > 0 else ""
    if not short:
        return fixed
    return f"{disclosure} {short}" + (sep + tail if tail else "")


def campaign_caption(platform: str, text: str, campaign: Mapping[str, Any] | None) -> str:
    """``text`` for a campaign post on ``platform``: the disclosure first, every required item in, inside the
    platform's limits. ``campaign`` is ``postOptions.campaign``; without one the text is returned unchanged."""
    if not isinstance(campaign, Mapping):
        return text
    disclosure = disclosure_of(campaign.get("disclosure"))
    required = [r for r in _strings(campaign.get("required")) if r.casefold() != disclosure.casefold()]
    one_line = platform in ONE_LINE
    out = _tidy(text, one_line)
    if not _ad_first(out):
        out = _tidy(f"{disclosure} {_remove(out, disclosure)}", one_line)
    missing = [r for r in required if not _has(out, r)]
    if missing:
        sep = " " if one_line else "\n\n"
        out = f"{out}{sep}{' '.join(missing)}"
    if platform in HASHTAG_LIMITS:
        out = _tidy(_fit_hashtags(out, HASHTAG_LIMITS[platform], _kept_hashtags(disclosure, required)), one_line)
    return _fit_length(platform, out, disclosure, required, one_line)
