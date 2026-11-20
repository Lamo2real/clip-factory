"""The built-in viral clip editing skill (skills/viral-clip-editing/SKILL.md): the parts the code relies on."""

from __future__ import annotations

import re
from pathlib import Path

from clipfactory_agent.skills import SKILL_MAX_PROMPT_CHARS

SKILL = Path(__file__).resolve().parents[2] / "skills" / "viral-clip-editing" / "SKILL.md"


def text() -> str:
    return SKILL.read_text("utf-8")


def test_the_section_headings_the_finder_names_are_unchanged() -> None:
    headings = re.findall(r"^## (\d)\. (.+)$", text(), flags=re.MULTILINE)
    assert [n for n, _ in headings] == [str(i) for i in range(1, 9)]
    assert headings[0][1] == "Which moments go viral, and why"
    assert headings[1][1] == "Where the clip starts and ends"
    assert headings[2][1] == "The hook"


def test_the_chat_block_is_in_reading_the_signals() -> None:
    body = text()
    signals = body[body.index("### Reading the signals") : body.index("### Skip these")]
    chat = signals[signals.index("**Chat**") :]
    assert signals.index("**Viewers:**") < signals.index("**Chat**")
    for words in ("lags", "2 to 10 seconds", "moment ~", "raid", "giveaway", "!commands", "bot", "sub", "unrelated"):
        assert words in chat, words
    assert "never a clip" in chat and "names" in chat


def test_the_skill_fits_in_the_prompt() -> None:
    assert len(text()) < SKILL_MAX_PROMPT_CHARS
