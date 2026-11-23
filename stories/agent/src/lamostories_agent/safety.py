"""Step ``safety``: a second model call checks the facts (docs/CONTRACTS.md §45.11.5, ADR-74), and the ``preview``
step's final review of the finished video (§45.11.3). Both are the quality agent's tasks (``fact_check``,
``final_review``), on the owner's model and effort for them (§45.25).

The checker has its own prompt and answers through the schema below. It reads every on-screen caption, every scene
caption, every beat that shows a driving action and the post captions, against the topic's shown steps, donts and
caveats (and the hidden steps, which must never appear), and, for every story, whether anything shows a dangerous act
as something to copy. Code checks the guidance references first: a caption may only name a shown step or dont."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from .guidance import Topic
from .writer import DRIVING_ACTIONS, POST_FIELDS, VEHICLES
from .writer import VEHICLE_ACTIONS as WRITER_VEHICLE_ACTIONS

# §45.42: a car's speed_up and stall are driving moves the checker reads too (a car of the cast, a car prop with a
# castId, included). get_in and get_out are a character's actions, never driving ones.
VEHICLE_ACTIONS = WRITER_VEHICLE_ACTIONS | frozenset({"speed_up", "stall"})

CHECK_TOOL = "check_facts"
CHECK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ok", "problems"],
    "properties": {
        "ok": {"type": "boolean"},
        "problems": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["ref", "problem"],
                "properties": {
                    "ref": {"type": "string", "description": "The item's ref, exactly as given."},
                    "problem": {"type": "string", "maxLength": 300, "description": "One plain sentence."},
                    "fix": {"type": ["string", "null"], "maxLength": 300},
                },
            },
        },
    },
}

CHECK_SYSTEM = """You are the fact checker of Clips Funded, a channel of short animated videos without voice-over.

You get one video's texts and driving actions, each with a ref, and, for a driving-safety video, the checked advice it
must follow: the steps and donts that may be shown, the caveats, and the steps that are NOT checked (they must never
appear, in words or in action). Each driving action item names who does it ("who"), the action ("do"), its side
("dir", when it has one) and when it happens in its scene ("at" and "dur", in seconds), so a skid and the steering
that answers it can be matched by time. The engine's "catalog" and "propStates" say what each id means.

Report a problem for an item when:
- it gives driving advice that is not in the checked steps or donts, contradicts them or their caveats, or shows a
  step that is not checked;
- a caption's guidanceRef does not match what the caption says;
- anything shows a dangerous act as fun or as something to copy (for every video, safety topic or not);
- a beat's action does not match what it means in the engine's "rules" (given with the video): for example the
  driver's steer_left or steer_right must match the skid's dir (a skid's dir is the side the car's rear slides to,
  and steering into the skid is that same side).
A mistake that the story clearly shows as a mistake, followed by the safe way, is fine. Jokes and feelings are fine.

Each problem is one plain sentence a beginner understands, with the item's ref. Set ok to true only when there is no
problem."""

REVIEW_PROMPT = """You take the last look at one finished Clips Funded video before the owner sees it: its script and
eight frames from the video, in order, with their times.

Report a problem only when it would be wrong to post the video as it is:
- something dangerous is shown as fun or as something to copy;
- an on-screen text is cut off, unreadable, covered, or says something different from the script;
- a driving action or a caption disagrees with the checked advice given below (for a driving-safety video);
- the story cannot be understood without words (no clear want, turn or ending).
Taste and small things are not problems. Each problem is one plain sentence a beginner understands. Set ok to true
only when there is no problem."""


@dataclass
class Check:
    """What one check found: problems by item ref (empty when the story passed)."""

    problems: list[dict[str, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def sentences(self, names: dict[str, str]) -> list[str]:
        out: list[str] = []
        for p in self.problems:
            where = names.get(p["ref"], "")
            line = f"{where}: {p['problem']}" if where else p["problem"]
            if line not in out:
                out.append(line)
        return out


def items(script: dict[str, Any], post: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every item the checker reads, with its ref and where it is (for the owner's sentences)."""
    cast = {k: str((v or {}).get("name") or k) for k, v in (script.get("cast") or {}).items()}
    cars = {k: str((v or {}).get("name") or k) for k, v in (script.get("cars") or {}).items()}
    out: list[dict[str, Any]] = []
    for c in script.get("captions") or []:
        out.append(
            {
                "ref": f"caption:{c.get('id')}",
                "where": f"Caption “{c.get('text')}”",
                "text": c.get("text"),
                "at": c.get("at"),
                "guidanceRef": c.get("guidanceRef"),
            }
        )
    for s in script.get("scenes") or []:
        sid = str(s.get("sceneId"))
        title = str(s.get("title") or sid)
        if s.get("caption"):
            out.append({"ref": f"scene:{sid}", "where": f"Scene “{title}”", "text": s["caption"]})
        props = {str(p.get("propId")): p for p in s.get("props") or []}
        for i, b in enumerate(s.get("beats") or []):
            who, action = str(b.get("who")), str(b.get("do"))
            vehicle = who in props and str(props[who].get("kind")) in VEHICLES and action in VEHICLE_ACTIONS
            if action not in DRIVING_ACTIONS and not vehicle:
                continue
            prop = props.get(who, {})
            name = cast.get(who) or cars.get(str(prop.get("castId") or "")) or f"the {prop.get('kind', 'prop')}"
            words = f"{name} does {action.replace('_', ' ')}"
            if b.get("dir") in ("left", "right"):
                words += f" to the {b['dir']}"  # a skid's dir: the side the rear slides to (the engine's rules)
            if b.get("face"):
                words += f" with a {b['face']} face"
            out.append({"ref": f"beat:{sid}:{i}", "where": f"Scene “{title}”", "action": words, "set": s.get("set"),
                        "who": who, "do": action, "dir": b.get("dir"), "at": b.get("at"), "dur": b.get("dur")})  # fmt: skip
    for f in POST_FIELDS:
        if post and post.get(f):
            out.append({"ref": f"post:{f}", "where": f"Post caption ({f})", "text": post[f]})
    return out


def code_problems(script: dict[str, Any], topic: Topic | None) -> list[dict[str, str]]:
    """What code alone can tell: a guidance reference that is not a shown step or dont of the story's topic."""
    shown = topic.shown_ids if topic else set()
    out = []
    for c in script.get("captions") or []:
        ref = c.get("guidanceRef")
        if ref and ref not in shown:
            out.append(
                {
                    "ref": f"caption:{c.get('id')}",
                    "problem": "This caption uses advice that is not on the checked list.",
                }
            )
    return out


UNCHECKED_NOTE = (
    "The writer said this video teaches driving safety, but no checked advice covers it. Report every item that gives "
    "driving advice or shows how to handle a driving situation: none of it is checked. Also check that nothing "
    "dangerous is shown as fun."
)


def request(
    script: dict[str, Any], post: dict[str, Any] | None, topic: Topic | None, *, unchecked_advice: bool = False
) -> dict[str, Any]:
    """The checker's input. ``unchecked_advice``: a story the writer flagged ``teachesSafety`` with no checked topic;
    any driving advice in it is a problem (§45.11.5: it is held until the owner picks a topic or takes the advice
    out)."""
    body: dict[str, Any] = {
        "video": {"title": script.get("title"), "lengthSec": script.get("durationSec")},
        "items": [{k: v for k, v in it.items() if k != "where" and v is not None} for it in items(script, post)],
    }
    if topic is not None:
        body["guidance"] = {
            "topic": topic.title,
            "steps": [{"id": s["id"], "text": s["text"]} for s in topic.steps],
            "donts": [{"id": d["id"], "text": d["text"]} for d in topic.donts],
            "caveats": topic.caveats,
            "countryNotes": topic.country_notes,
            "notChecked": [{"id": h["id"], "text": h["text"]} for h in topic.hidden],
        }
    else:
        body["guidance"] = None
        body["note"] = (
            UNCHECKED_NOTE
            if unchecked_advice
            else "This video teaches no driving advice: check only that nothing dangerous is shown as fun."
        )
    return body


def parse(answer: dict[str, Any], refs: Sequence[str]) -> Check:
    known = set(refs)
    problems = []
    for p in answer.get("problems") or []:
        if not isinstance(p, dict) or not str(p.get("problem") or "").strip():
            continue
        ref = str(p.get("ref") or "")
        problems.append({"ref": ref if ref in known else "", "problem": str(p["problem"]).strip()[:300]})
    if not problems and answer.get("ok") is False:
        problems.append({"ref": "", "problem": "The fact checker was not sure this story is right."})
    return Check(problems)


def review_request(script: dict[str, Any], topic: Topic | None, times: Sequence[float]) -> dict[str, Any]:
    """The final review's text part (the frames follow it as pictures)."""
    body: dict[str, Any] = {
        "video": {"title": script.get("title"), "lengthSec": script.get("durationSec")},
        "scenes": [
            {k: s.get(k) for k in ("sceneId", "title", "durationSec", "set", "caption") if s.get(k) is not None}
            for s in script.get("scenes") or []
        ],
        "captions": [{"at": c.get("at"), "text": c.get("text")} for c in script.get("captions") or []],
        "frames": [{"frame": i + 1, "atSec": round(t, 2)} for i, t in enumerate(times)],
    }
    if topic is not None:
        body["guidance"] = {
            "topic": topic.title,
            "steps": [s["text"] for s in topic.steps],
            "donts": [d["text"] for d in topic.donts],
        }
    return body


def parse_review(answer: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for p in answer.get("problems") or []:
        text = str((p or {}).get("problem") or "").strip() if isinstance(p, dict) else ""
        if text and text not in out:
            out.append(text[:300])
    if not out and answer.get("ok") is False:
        out.append("The last look found something to check in the finished video.")
    return out


def allowed_refs(run: Sequence[str]) -> set[str]:
    """Which kinds of text a rewrite may change in a job that runs ``run``: post captions always (no video
    change); on-screen captions only when the captions and the assembly run after; scenes (their captions and
    beats) only when the scenes are drawn and animated again too."""
    kinds = {"post"}
    if {"captions", "assemble", "preview"} <= set(run):
        kinds.add("caption")
    if {"scenes", "animation", "captions", "assemble", "preview"} <= set(run):
        kinds |= {"scene", "beat"}
    return kinds
