"""Which chat messages are short text edits (docs/CONTRACTS.md §45.37 G5; the owner's second request §4: "Simple text
modifications: Low").

A short message that only asks to rename something, fix a word, a typo or the spelling, or shorten a caption, a title
or a line goes through the task ``text_edit`` (the creative director, with its tools; the owner's model and effort for
that task, suggested Low); everything else stays ``chat``. A message with pictures, or one that also asks for new
work (ideas, a story, a video, a remake, a study), is never a text edit. The rule is plain words, so the owner can
predict it, and it only picks the task: §45.25's precedence still decides the model and the effort (a one-time choice
or the conversation's own setting wins over the task's), and nothing else changes about the answer."""

from __future__ import annotations

import re

MAX_EDIT_CHARS = 200
TEXT_EDIT = "text_edit"
CHAT = "chat"

_EDIT = re.compile(
    r"""(?ix)
    \b(
        re-?name | re-?title
      | call\s+(it|him|her|them|this|that|the\s+\w+)\s+["'“‘]?\w
      | (change|fix|correct|edit|tweak|update)\s+(the\s+|a\s+|this\s+|that\s+|its\s+|his\s+|her\s+)?
        (\w+\s+)?(name|title|word|words|wording|caption|captions|line|spelling|typo|typos|grammar|text)\b
      | typos?
      | misspel\w*
      | shorten | shorter | trim\s+(the\s+|this\s+|that\s+)?(\w+\s+)?(caption|title|line|text|description)
      | make\s+(it|the\s+\w+|this|that)\s+(shorter|snappier|punchier|tighter)
      | replace\s+["'“‘]?\S+.*\bwith\b
      | change\s+["'“‘][^"'”’]+["'”’]\s+(to|into)\b
      | spell\s+(it|the\s+\w+|\w+)\s+(as|with)\b
    )
    """
)
_NEW_WORK = re.compile(
    r"""(?ix)
    \b(
        new\s+(idea|ideas|story|stories|video|videos|character|characters|scene|scenes)
      | (make|produce|render|create)\s+(a|the|another|this|that)\s+(video|story|clip)
      | brainstorm | ideas\s+(for|about) | write\s+(a|an|me|another)\b
      | remake | redo\s+the\s+(scene|video) | analy[sz]e | study\s+(this|the)
    )
    """
)


def is_text_edit(text: str, *, pictures: int = 0) -> bool:
    """True for a short message that only asks for a small text change (rename, a word, a typo, shorter)."""
    words = " ".join(str(text or "").split())
    if not words or pictures or len(words) > MAX_EDIT_CHARS:
        return False
    if _NEW_WORK.search(words):
        return False
    return bool(_EDIT.search(words))


def chat_task(text: str, *, pictures: int = 0) -> str:
    """The task of the chat's answer to this message: ``text_edit`` for a short text edit, else ``chat``."""
    return TEXT_EDIT if is_text_edit(text, pictures=pictures) else CHAT
