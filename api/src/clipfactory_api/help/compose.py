"""The composer: a complete answer from the ranked docs, with no model (docs/CONTRACTS.md §19.4, §19.5).

Same output as ``compose.ts``. The model step may only reword this; when it fails, this is what the owner sees.
"""

from __future__ import annotations

from typing import NotRequired, TypedDict

from .corpus import HelpAction, HelpLive
from .retrieve import REFUSED_TEXT, UNKNOWN_TEXT, Ranked
from .text import no_dashes

GO_HOME: HelpAction = {"id": "go-home", "label": "Go Home", "to": "/"}
MAX_TEXT = 600


class HelpAnswer(TypedDict):
    known: bool
    text: str
    steps: list[str]
    actions: list[HelpAction]
    sources: list[str]
    refused: NotRequired[bool]
    live: NotRequired[HelpLive]


def refused_answer() -> HelpAnswer:
    return {"known": False, "refused": True, "text": REFUSED_TEXT, "steps": [], "actions": [], "sources": []}


def unknown_answer() -> HelpAnswer:
    return {"known": False, "text": UNKNOWN_TEXT, "steps": [], "actions": [_copy(GO_HOME)], "sources": []}


def compose(ranked: Ranked) -> HelpAnswer:
    if ranked.status == "refused":
        return refused_answer()
    top = ranked.top
    if ranked.status != "answer" or top is None:
        return unknown_answer()
    live = top.get("live")
    # A live answer leads with its number sentence ("Your best clip this week got {value} views."); the browser
    # fills {value} with the owner's own token (§19.7).
    text = f"{live['text']} {top['answer']}" if live else top["answer"]
    answer: HelpAnswer = {
        "known": True,
        "text": no_dashes(text)[:MAX_TEXT],
        "steps": [no_dashes(s) for s in top["steps"]],
        "actions": [_copy(a) for a in top["actions"][:2]],
        "sources": [top["id"]],
    }
    if live:
        answer["live"] = live.copy()
    return answer


def _copy(action: HelpAction) -> HelpAction:
    out: HelpAction = {"id": action["id"], "label": action["label"], "to": action["to"]}
    if "highlight" in action:
        out["highlight"] = list(action["highlight"])
    return out
