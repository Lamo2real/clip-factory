"""Which chat messages are short text edits (docs/CONTRACTS.md §45.37 G5; the owner's second request §4: "Simple text
modifications: Low", "Detailed animation planning: High").

A message goes through the task ``text_edit`` (the creative director, with its tools; the owner's model and effort for
that task, suggested Low) only when it is nothing but one small text change, said up front:

* rename or retitle something ("Rename Lamo to Bobo", "Retitle it Icy Ride"),
* call it something ("Call it \"Icy Ride\""),
* fix or change a word, a typo, the spelling, a name, a title, a caption or a line ("Fix the typo in the title",
  "Change the name of the dog to Rex"),
* shorten or trim a caption, a title or a line ("Shorten the caption of scene 2", "Make the title shorter"),
* replace one word with another ("Replace slid with skidded", "Change \"slid\" to \"skidded\"").

Everything else stays ``chat``: a question (a ``?``, or a message that starts like one), a message with pictures, one
longer than 200 characters, one that also asks for something else (a second clause such as "… and make the dog fly",
"… then render it", or a second sentence), or one that asks for new or bigger work anywhere in it (next, another, new,
add, remove, render, post, ideas, a plan, a remake, a study). Words inside double quotes are the new text itself and
never count against it ("Call it \"The Next Ride\"" is still an edit). A message that is not clearly a text edit is
answered as ``chat``, so new stories and re-staging are never planned at the Low effort meant for small text changes.
The rule is plain words, so the owner can predict it, and it only picks the task: §45.25's precedence still decides
the model and the effort (a one-time choice or the conversation's own setting wins over the task's), and nothing else
changes about the answer."""

from __future__ import annotations

import re

MAX_EDIT_CHARS = 200
TEXT_EDIT = "text_edit"
CHAT = "chat"

_THING = (
    r"(name|names|title|word|words|wording|caption|captions|line|lines|spelling|typo|typos|grammar|text|description)"
)
_OF = r"(the\s+|a\s+|this\s+|that\s+|its\s+|his\s+|her\s+|my\s+|their\s+)?"

# What may come before the edit: "please", "ok", "now", "just".
_LEAD = re.compile(r"(?i)^(please,?\s+|pls\s+|ok(ay)?,?\s+|now,?\s+|just\s+)*")
# The whole message (after that) is one of these, said first.
_EDIT = re.compile(
    rf"""(?ix)
    ^(
        re-?name\b
      | re-?title\b
      | call\s+(it|him|her|them|this|that|the\s+\w+)\s+["“]?\w
      | (fix|correct|change|edit|tweak|update)\s+{_OF}(\w+\s+)?{_THING}\b
      | (shorten|trim|tighten)\s+{_OF}(\w+\s+)?(caption|captions|title|line|lines|text|description|name)\b
      | make\s+{_OF}(\w+\s+)?(caption|captions|title|line|lines|text|description|name)\s+
        (shorter|snappier|punchier|tighter|clearer)\b
      | replace\s+["“]?[\w'’-]+["”]?\s+with\s+["“]?\w
      | change\s+["“][^"“”]+["”]\s+(to|into)\s+\S
      | spell\s+(it|the\s+\w+|\w+)\s+(as|with)\s+\S
    )
    """
)
# Anything here (outside double quotes) makes it more than a text edit.
_MORE = re.compile(
    r"""(?ix)
    \b(
        next | another | new | add | adding | remove | removing | delete | render | rerender | re-render | produce
      | post | publish | upload | remake | redo | regenerate | brainstorm | ideas? | plan | story\s+about
      | analy[sz]e | study | animate | draw | scene\s+changes?
    )\b
    """
)
# A second clause that asks for something else: "… and make …", "…, then render …", "… also add …".
_SECOND = re.compile(
    r"""(?ix)
    (\band\b|\bthen\b|\balso\b|\bplus\b|;|,)\s+(then\s+|also\s+|please\s+|can\s+you\s+|could\s+you\s+)*
    (make|add|remove|render|produce|post|publish|create|write|redo|remake|change|keep|give|draw|animate|put|move|let|
     have|turn|use|set|show|plan|study|analy[sz]e|check|fix|rename|shorten|trim|replace|call|try|start|send|
     generate|swap|delete|do)\b
    """
)
_QUESTION = re.compile(
    r"(?i)^(why|how|what|when|where|who|which|could|can|would|will|should|shall|do|does|did|is|are|was|were|may)\b"
)
_QUOTED = re.compile(r"\"[^\"]*\"|“[^”]*”")
_SENTENCES = re.compile(r"[.!]\s+\S")


def is_text_edit(text: str, *, pictures: int = 0) -> bool:
    """True for a short message that is nothing but one small text change (rename, a word, a typo, shorter)."""
    words = " ".join(str(text or "").split())
    if not words or pictures or len(words) > MAX_EDIT_CHARS:
        return False
    lead = _LEAD.match(words)
    body = words[lead.end() :] if lead else words
    if not _EDIT.search(body):
        return False
    rest = _QUOTED.sub(" ", body)  # the new words themselves never count against the edit
    if "?" in rest or _QUESTION.search(rest):
        return False
    return not (_MORE.search(rest) or _SECOND.search(rest) or _SENTENCES.search(rest))


def chat_task(text: str, *, pictures: int = 0) -> str:
    """The task of the chat's answer to this message: ``text_edit`` for a short text edit, else ``chat``."""
    return TEXT_EDIT if is_text_edit(text, pictures=pictures) else CHAT
