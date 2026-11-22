"""Undoes Mac Roman mojibake: UTF-8 text that something on a Mac read as Mac Roman (docs/CONTRACTS.md §5 Captions).

macOS turns text into this when it passes through a tool that has no UTF-8 locale: ``pbcopy`` and ``pbpaste`` run
from an app or launchd, for example, read every UTF-8 byte as one Mac Roman letter. 💀 (F0 9F 92 80) then becomes
``\\uf8ffüíÄ`` (an Apple logo and three letters), é becomes ``√©`` and 日本 becomes ``Êó•Êú¨``. Pasted into a caption,
it was saved like that and copied on into TikTok (seen 22 Nov 2026).

``repair`` turns each such run back into the character it came from. It only touches what cannot be real text:
* a 3- or 4-byte UTF-8 character (emoji, CJK, typographic quotes). Its Mac Roman letters (an Apple logo, or ``Ê``,
  ``Â`` and friends followed by two or three of ``ÄÅÇÉüí•``) do not occur together in real words;
* a 2-byte one only after ``√`` or ``¬`` (C3 and C2: é, ü, ñ, å, ©, a no-break space), which real captions never put
  before an accented letter.
Other 2-byte leads are left alone on purpose: Mac Roman D0 to D5 are the dashes and curly quotes, so a real French
"l'été" written with a curly apostrophe (D5) would otherwise turn Armenian. Text without such a run, real emoji
included, comes back exactly as it was.

Stored items are never rewritten for this: the API repairs captions when they are saved, shown and posted."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# Each non-ASCII character Mac Roman has, and the byte it stands for (0x80–0xFF).
_HIGH = bytes(range(0x80, 0x100))
_BYTE: dict[str, int] = {ch: b for b, ch in zip(_HIGH, _HIGH.decode("mac_roman"), strict=True)}
# 2-byte leads that are safe to read back: √ (C3, Latin-1 letters) and ¬ (C2, Latin-1 signs).
_SAFE_PAIR_LEADS = frozenset({0xC2, 0xC3})


def _length(lead: int) -> int:
    """How many bytes a UTF-8 character starting with ``lead`` has, or 0 when it cannot start one we repair."""
    if lead in _SAFE_PAIR_LEADS:
        return 2
    if 0xE0 <= lead <= 0xEF:
        return 3
    if 0xF0 <= lead <= 0xF4:
        return 4
    return 0


def repair(text: str) -> str:
    """``text`` with every Mac Roman mojibake run turned back into its character; anything else as it was."""
    if text.isascii():
        return text
    out: list[str] = []
    i = 0
    while i < len(text):
        lead = _BYTE.get(text[i], 0)
        size = _length(lead)
        if size and i + size <= len(text):
            # ASCII and characters Mac Roman has no byte for count as 0: never a continuation byte.
            tail = [_BYTE.get(ch, 0) for ch in text[i + 1 : i + size]]
            if all(0x80 <= b <= 0xBF for b in tail):
                try:
                    out.append(bytes([lead, *tail]).decode("utf-8"))
                    i += size
                    continue
                except UnicodeDecodeError:
                    pass  # an overlong or surrogate form: not something a real character turned into
        out.append(text[i])
        i += 1
    return "".join(out)


def repair_captions(captions: Any) -> Any:
    """A clip's ``captions`` map with every text repaired (a copy). Anything that is not a map comes back as it was."""
    if not isinstance(captions, Mapping):
        return captions
    return {k: repair(v) if isinstance(v, str) else v for k, v in captions.items()}
