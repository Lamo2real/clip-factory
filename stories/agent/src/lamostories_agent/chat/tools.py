"""The creative director's tools in the chat: Lamo Stories tools only (docs/CONTRACTS.md §45.27, ADR-78).

Read tools: ideas, characters, stories (with their storyboards, never the looks) and reference analyses of this
workspace. Write tools: create or update an idea, and ``remember`` (``MEM#``); every write is a transaction with a
ConditionCheck on the answer's own ``MSG#`` (its session and a live status), so a stopped answer writes nothing.
Anything that costs a render, changes a video, analyzes a reference or saves a character is only **offered**: the
tool adds an action button to the answer and the owner's tap calls the normal route. Driving-safety ideas are saved
through the owner's tap too, so the API matches them to checked advice (§45.7).

Action payloads (``Message.actions[].payload``), one per kind, each what its route takes:

* ``make_video``: ``{"story": StoryInput}`` → ``POST …/stories``;
* ``remake_scene``: ``{"storyId", "sceneIds": [...], "note"?}`` → ``POST …/stories/{storyId}/changes``;
* ``analyze_reference``: ``{"refId"}`` → ``POST …/references/{refId}/analyze``;
* ``save_character``: ``{"character": CharacterInput}`` → ``POST …/characters``;
* ``save_idea``: ``{"idea": IdeaInput}`` → ``POST …/ideas``, or ``{"ideaId", "patch": Partial<IdeaInput>}`` → ``PATCH``;
* ``open``: ``{"href": "/stories/…"}`` (a Lamo Stories page only).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from lamostories_agent import memory
from lamostories_agent.tasks import guidance
from lamostories_agent.tasks.characters import check_character
from lamostories_agent.tasks.common import (
    Refused,
    Superseded,
    TaskFailed,
    clip,
    in_workspace,
    now_iso,
    owned,
    public,
    ulid,
    ws_prefix,
)
from lamostories_agent.tasks.fence import Fence
from lamostories_agent.tasks.ideas import CATEGORIES, LOGLINE_MAX, TITLE_MAX, TONES, check_concept
from lamostories_agent.tasks.services import Services
from lamostories_agent.tasks.store import Expr

MAX_ACTIONS = 6
MAX_LIST = 40
MAX_REFS = 3  # reference videos one story may use (§45.28)
ACTION_KINDS = ("make_video", "remake_scene", "analyze_reference", "save_character", "save_idea", "open")
PAGES = {
    "dashboard": "/stories",
    "ideas": "/stories/ideas",
    "characters": "/stories/characters",
    "character": "/stories/characters/{id}",
    "production": "/stories/production",
    "story": "/stories/production/{id}",
    "review": "/stories/review/{id}",
    "references": "/stories/references",
    "reference": "/stories/references/{id}",
    "library": "/stories/library",
    "connections": "/stories/connections",
    "settings_ai": "/stories/settings/ai",
    "settings_agents": "/stories/settings/agents",
    "settings_memory": "/stories/settings/memory",
}
PAGE_LABELS = {
    "dashboard": "Open the dashboard",
    "ideas": "Open Ideas",
    "characters": "Open Characters",
    "character": "Open this character",
    "production": "Open Production",
    "story": "Open this video",
    "review": "Review this video",
    "references": "Open References",
    "reference": "Open this reference",
    "library": "Open the Library",
    "connections": "Open Social accounts",
    "settings_ai": "Open AI settings",
    "settings_agents": "Open Agents settings",
    "settings_memory": "Open Memory",
}
STORY_STATUSES = ("draft", "producing", "needs_check", "review", "approved", "rejected", "published", "failed")
REMAKE_STATUSES = ("draft", "review", "needs_check", "failed")  # the API's changes route takes exactly these
NOT_REMAKABLE = {
    "producing": "That video is still being made. Offer the change after it is ready.",
    "approved": "That video is approved, so it can't be remade. Offer a new video with offer_make_video instead.",
    "published": "That video is posted, so it can't be remade. Offer a new video with offer_make_video instead.",
    "rejected": "That video was rejected, so it can't be remade. Offer a new video with offer_make_video instead.",
}
CHANGED = "That changed meanwhile (it may have been deleted). Read it again before you try."
IDEA_GONE = "That idea was deleted meanwhile. Use list_ideas, or create_idea for a new one."


class ToolError(Exception):
    """A tool call the model can fix: the sentence goes back to it as an error result."""


def _spec(name: str, description: str, props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "toolSpec": {
            "name": name,
            "description": description,
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": props,
                    "required": required or [],
                    "additionalProperties": False,
                }
            },
        }
    }


_STR = {"type": "string"}
_IDS = {"type": "array", "items": {"type": "string"}}
_CONCEPT = {
    "type": "object",
    "description": "a full video concept",
    "properties": {
        "premise": _STR,
        "beats": {"type": "array", "items": _STR, "description": "3 to 8 short lines"},
        "lesson": {"type": "string", "description": "one line, or an empty string"},
        "ending": _STR,
        "tone": {"type": "string", "enum": list(TONES)},
        "durationSec": {"type": "integer", "description": "15 to 90, 30 to 60 suggested"},
        "onScreenText": {"type": "array", "items": _STR, "description": "up to 6 captions of 60 characters"},
    },
    "required": ["premise", "beats", "lesson", "ending", "tone", "durationSec", "onScreenText"],
}
_IDEA_PROPS = {
    "title": {"type": "string", "description": f"at most {TITLE_MAX} characters"},
    "logline": {"type": "string", "description": f"one line, at most {LOGLINE_MAX} characters"},
    "category": {"type": "string", "enum": list(CATEGORIES)},
    "characterIds": {**_IDS, "description": "up to 3 saved character ids"},
    "concept": _CONCEPT,
}


def specs() -> list[dict[str, Any]]:
    """The tool list in Converse's ``toolSpec`` form (a fixed order, so the request prefix stays the same)."""
    return [
        _spec(
            "list_ideas",
            "List the saved ideas, newest first.",
            {"status": {"type": "string", "enum": ["saved", "used", "all"]}},
        ),
        _spec("read_idea", "Read one idea with its concept.", {"ideaId": _STR}, ["ideaId"]),
        _spec("list_characters", "List the saved recurring characters with their personalities.", {}),
        _spec(
            "read_character",
            "Read one character: personality, traits, faces, moves, voice and look.",
            {"characterId": _STR},
            ["characterId"],
        ),
        _spec(
            "list_stories",
            "List the videos (stories), newest first.",
            {"status": {"type": "string", "enum": [*STORY_STATUSES, "all"]}},
        ),
        _spec(
            "read_story",
            "Read one story and its storyboard: scenes, beats, captions and effects.",
            {"storyId": _STR},
            ["storyId"],
        ),
        _spec("list_references", "List the reference videos the owner uploaded.", {}),
        _spec("read_reference", "Read the analysis of one reference video.", {"refId": _STR}, ["refId"]),
        _spec(
            "create_idea",
            "Save a new idea now (not for driving_safety: those get a Save button so the app can match them to checked "
            "advice).",
            _IDEA_PROPS,
            ["title", "logline", "category"],
        ),
        _spec(
            "update_idea",
            "Change a saved idea's title, logline, characters or concept now (driving_safety ideas get a Save button "
            "instead).",
            {"ideaId": _STR, **{k: v for k, v in _IDEA_PROPS.items() if k != "category"}},
            ["ideaId"],
        ),
        _spec(
            "offer_save_idea",
            "Offer a Save this idea button for a draft idea.",
            _IDEA_PROPS,
            ["title", "logline", "category"],
        ),
        _spec(
            "propose_character",
            "Offer a Save this character button for a new character draft (a full rig from the allowed choices).",
            {
                "character": {
                    "type": "object",
                    "description": "a CharacterInput: name, description, personality, traits, movementStyle, expressions, look, voice",
                }
            },
            ["character"],
        ),
        _spec(
            "propose_story_change",
            "Offer a button that remakes scenes of a story or asks for changes (a note and/or scene ids).",
            {
                "storyId": _STR,
                "note": {"type": "string", "description": "what to change, at most 500 characters"},
                "sceneIds": _IDS,
            },
            ["storyId"],
        ),
        _spec(
            "offer_make_video",
            "Offer a Make the video button: from a saved idea, or from a short brief, with 1 to 3 saved characters and "
            "up to 3 analyzed reference videos whose study the writer should follow.",
            {
                "ideaId": _STR,
                "title": _STR,
                "logline": _STR,
                "category": {"type": "string", "enum": list(CATEGORIES)},
                "characterIds": _IDS,
                "referenceIds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": MAX_REFS,
                    "description": "up to 3 analyzed reference videos (list_references)",
                },
                "durationSec": {"type": "integer", "description": "15 to 90"},
            },
            ["characterIds"],
        ),
        _spec("offer_analyze_reference", "Offer an Analyze this reference video button.", {"refId": _STR}, ["refId"]),
        _spec(
            "offer_open",
            "Offer a button that opens a Clip Factory Stories page.",
            {
                "page": {"type": "string", "enum": list(PAGES)},
                "id": {"type": "string", "description": "the item id for one-item pages"},
            },
            ["page"],
        ),
        _spec(
            "remember",
            "Remember one short fact or preference of the owner for later (at most 300 characters).",
            {"text": _STR},
            ["text"],
        ),
    ]


@dataclass
class Toolbox:
    svc: Services
    user_id: str
    workspace_id: str
    pk: str
    fence: Fence
    actions: list[dict[str, Any]] = field(default_factory=list)
    catalog: Callable[[], dict[str, Any]] | None = None

    # --- helpers -------------------------------------------------------------------------------------------------

    def _get(self, sk: str, missing: str) -> dict[str, Any]:
        item = self.svc.store.get(self.pk, sk)
        if not item or not owned(item, self.user_id, self.workspace_id):
            raise ToolError(missing)
        return item

    def _list(self, prefix: str) -> list[dict[str, Any]]:
        found = self.svc.store.query(self.pk, prefix)
        return [i for i in found if owned(i, self.user_id, self.workspace_id)]

    def _s3_json(self, key: Any) -> Any:
        if not isinstance(key, str) or not in_workspace(key, self.user_id, self.workspace_id):
            return None
        try:
            return json.loads(self.svc.s3.get_object(Bucket=self.svc.bucket, Key=key)["Body"].read())
        except Exception:
            return None

    def offer(self, kind: str, label: str, payload: dict[str, Any]) -> dict[str, Any]:
        if kind not in ACTION_KINDS:
            raise ToolError("That button is not one Clip Factory Stories has.")
        action = {"kind": kind, "label": clip(label, 40), "payload": payload}
        if any(a["kind"] == kind and a["payload"] == payload for a in self.actions):
            return {"ok": True, "button": action["label"], "note": "That button is already in your answer."}
        if len(self.actions) >= MAX_ACTIONS:
            raise ToolError(f"An answer can carry at most {MAX_ACTIONS} buttons.")
        self.actions.append(action)
        return {
            "ok": True,
            "button": action["label"],
            "note": "The owner sees this button under your answer; it does nothing until he taps it.",
        }

    def _characters(self, ids: Any, *, need: bool = False) -> list[str]:
        wanted = [str(i) for i in ids] if isinstance(ids, list) else []
        known = {str(c["characterId"]) for c in self._list("CHAR#") if c.get("characterId")}
        bad = [i for i in wanted if i not in known]
        if bad:
            raise ToolError(f"These are not saved characters: {', '.join(bad)}. Use list_characters.")
        out = list(dict.fromkeys(wanted))
        if len(out) > 3 or (need and not out):
            raise ToolError("Pick 1 to 3 saved characters.")
        return out

    def _studied(self, r: dict[str, Any]) -> bool:
        """Whether a reference has a study (``analysisKey`` in its own folder), whatever its status: a re-analysis
        that runs or failed keeps the earlier one (§45.35 D9)."""
        key = str(r.get("analysisKey") or "")
        folder = f"{ws_prefix(self.user_id, self.workspace_id)}references/{r.get('refId')}/"
        return bool(key) and in_workspace(key, self.user_id, self.workspace_id) and key.startswith(folder)

    def _references(self, ids: Any) -> list[str]:
        """Up to 3 reference videos of this workspace that have a study (what the writer reads, §45.28); anything
        else is a mistake the model can fix."""
        if ids is None:
            return []
        wanted = list(dict.fromkeys(str(i) for i in ids)) if isinstance(ids, list) else None
        if wanted is None or len(wanted) > MAX_REFS:
            raise ToolError(f"Pick up to {MAX_REFS} reference videos.")
        refs = {str(r["refId"]): r for r in self._list("REFVID#") if r.get("refId")}
        unknown = [i for i in wanted if i not in refs]
        if unknown:
            raise ToolError(f"These are not reference videos here: {', '.join(unknown)}. Use list_references.")
        waiting = [i for i in wanted if not self._studied(refs[i])]
        if waiting:
            raise ToolError(
                f"These reference videos have not been analyzed yet: {', '.join(waiting)}. Offer the Analyze button "
                "first."
            )
        return wanted

    def _idea_fields(self, args: dict[str, Any], *, partial: bool) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, limit in (("title", TITLE_MAX), ("logline", LOGLINE_MAX)):
            if key in args or not partial:
                value = str(args.get(key) or "").strip()
                if not value or len(value) > limit:
                    raise ToolError(f"{key} needs 1 to {limit} characters.")
                out[key] = value
        if "category" in args or not partial:
            if args.get("category") not in CATEGORIES:
                raise ToolError(f"category must be one of {', '.join(CATEGORIES)}.")
            out["category"] = args["category"]
        if "characterIds" in args:
            out["characterIds"] = self._characters(args.get("characterIds"))
        if args.get("concept") is not None:
            raw = args["concept"]
            duration = raw.get("durationSec") if isinstance(raw, dict) else None
            try:
                seconds = min(90, max(15, int(duration))) if duration is not None else 45
            except (TypeError, ValueError):
                seconds = 45
            concept, problems = check_concept(raw, duration=seconds, final=True)
            if concept is None:
                raise ToolError("The concept is not complete: " + "; ".join(problems))
            out["concept"] = concept
        return out

    def _gated(self, ops: list[tuple[str, str, str, Any]], *, gone: str = CHANGED) -> None:
        """Writes only while this answer is still live (a ConditionCheck on its own ``MSG#``). When only the other
        item refused (it was deleted or changed meanwhile), the model is told ``gone`` and the answer goes on."""
        try:
            self.fence.transact([*ops, self.fence.check_op()])
        except Superseded:
            raise
        except Refused as e:
            raise ToolError(gone) from e
        except Exception as e:
            raise ToolError("That did not save. Try again.") from e

    # --- the tools -----------------------------------------------------------------------------------------------

    def list_ideas(self, args: dict[str, Any]) -> dict[str, Any]:
        status = args.get("status") if args.get("status") in ("saved", "used") else None
        ideas = [i for i in self._list("IDEA#") if status is None or i.get("status") == status]
        ideas.sort(key=lambda i: str(i.get("createdAt") or ""), reverse=True)
        return {
            "ideas": [
                {
                    "ideaId": i.get("ideaId"),
                    "title": i.get("title"),
                    "logline": i.get("logline"),
                    "category": i.get("category"),
                    "status": i.get("status"),
                    "hasConcept": isinstance(i.get("concept"), dict),
                    "characterIds": i.get("characterIds") or [],
                    "needsGuidance": bool(i.get("needsGuidance")),
                }
                for i in ideas[:MAX_LIST]
            ]
        }

    def read_idea(self, args: dict[str, Any]) -> dict[str, Any]:
        return {"idea": public(self._get(f"IDEA#{args.get('ideaId')}", "There is no idea with that id."))}

    def list_characters(self, args: dict[str, Any]) -> dict[str, Any]:
        chars = sorted(self._list("CHAR#"), key=lambda c: str(c.get("name") or "").lower())
        return {
            "characters": [
                {
                    "characterId": c.get("characterId"),
                    "name": c.get("name"),
                    "personality": clip(c.get("personality"), 400),
                    "traits": c.get("traits") or [],
                    "movementStyle": c.get("movementStyle"),
                    "expressions": c.get("expressions") or [],
                }
                for c in chars[:MAX_LIST]
            ]
        }

    def read_character(self, args: dict[str, Any]) -> dict[str, Any]:
        c = self._get(f"CHAR#{args.get('characterId')}", "There is no character with that id.")
        keep = (
            "characterId",
            "name",
            "description",
            "personality",
            "traits",
            "movementStyle",
            "expressions",
            "look",
            "voice",
            "storyCount",
        )
        return {"character": {k: v for k, v in public(c).items() if k in keep}}

    def list_stories(self, args: dict[str, Any]) -> dict[str, Any]:
        status = args.get("status") if args.get("status") in STORY_STATUSES else None
        stories = [s for s in self._list("STORY#") if status is None or s.get("status") == status]
        stories.sort(key=lambda s: str(s.get("createdAt") or ""), reverse=True)
        return {
            "stories": [
                {
                    "storyId": s.get("storyId"),
                    "title": s.get("title"),
                    "status": s.get("status"),
                    "category": s.get("category"),
                    "durationSec": s.get("durationSec"),
                    "scenes": len(s.get("scenes") or []),
                    "characterIds": s.get("characterIds") or [],
                    "updatedAt": s.get("updatedAt"),
                }
                for s in stories[:MAX_LIST]
            ]
        }

    def read_story(self, args: dict[str, Any]) -> dict[str, Any]:
        s = self._get(f"STORY#{args.get('storyId')}", "There is no story with that id.")
        keep = (
            "storyId",
            "title",
            "status",
            "category",
            "ideaId",
            "characterIds",
            "durationSec",
            "actualDurationSec",
            "captionsOn",
            "musicMood",
            "postCaptions",
            "scriptVersion",
            "stale",
            "safety",
            "reviewNote",
            "referenceIds",
        )
        out: dict[str, Any] = {"story": {k: v for k, v in public(s).items() if k in keep}}
        script = self._s3_json(s.get("scriptKey"))
        if isinstance(script, dict):
            out["storyboard"] = {
                "durationSec": script.get("durationSec"),
                "cast": {k: (v or {}).get("name") for k, v in (script.get("cast") or {}).items()},
                "music": script.get("music"),
                "captions": script.get("captions") or [],
                "scenes": [
                    {
                        k: sc.get(k)
                        for k in (
                            "sceneId",
                            "title",
                            "durationSec",
                            "set",
                            "view",
                            "camera",
                            "actors",
                            "props",
                            "beats",
                            "sfx",
                            "caption",
                            "note",
                        )
                    }
                    for sc in script.get("scenes") or []
                ],
            }
        return out

    def list_references(self, args: dict[str, Any]) -> dict[str, Any]:
        refs = sorted(self._list("REFVID#"), key=lambda r: str(r.get("createdAt") or ""), reverse=True)
        return {
            "references": [
                {
                    "refId": r.get("refId"),
                    "title": r.get("title"),
                    "status": r.get("status"),
                    "durationSec": r.get("durationSec"),
                    "studied": self._studied(r),  # usable in offer_make_video (§45.35 D9)
                }
                for r in refs[:MAX_LIST]
            ]
        }

    def read_reference(self, args: dict[str, Any]) -> dict[str, Any]:
        r = self._get(f"REFVID#{args.get('refId')}", "There is no reference video with that id.")
        out: dict[str, Any] = {"reference": {k: r.get(k) for k in ("refId", "title", "status", "durationSec")}}
        analysis = self._s3_json(r.get("analysisKey"))
        if isinstance(analysis, dict):
            out["analysis"] = analysis
        else:
            out["note"] = "It has not been analyzed yet. Offer the Analyze button."
        return out

    def create_idea(self, args: dict[str, Any]) -> dict[str, Any]:
        fields = self._idea_fields(args, partial=False)
        if fields["category"] == "driving_safety":
            return self._safety_idea({"idea": {**fields, "source": "ai"}})
        at = now_iso()
        idea_id = ulid()
        item = {
            "type": "ws_idea",
            "userId": self.user_id,
            "workspaceId": self.workspace_id,
            "ideaId": idea_id,
            **fields,
            "characterIds": fields.get("characterIds", []),
            "source": "ai",
            "status": "saved",
            "safetyTopicId": None,
            "needsGuidance": False,
            "storyIds": [],
            "createdAt": at,
            "updatedAt": at,
        }
        self._gated([("put", self.pk, f"IDEA#{idea_id}", item)])
        self.offer("open", "Open Ideas", {"href": PAGES["ideas"]})
        return {"ok": True, "idea": public(item)}

    def update_idea(self, args: dict[str, Any]) -> dict[str, Any]:
        idea = self._get(f"IDEA#{args.get('ideaId')}", "There is no idea with that id.")
        fields = self._idea_fields({k: v for k, v in args.items() if k != "ideaId"}, partial=True)
        if not fields:
            raise ToolError("Say what to change: a title, a logline, the characters or the concept.")
        if "driving_safety" in (idea.get("category"), fields.get("category")):
            # into, out of or inside driving safety: the owner's tap, so the API matches (or clears) the topic
            return self._safety_idea({"ideaId": idea["ideaId"], "patch": fields})
        at = now_iso()
        write = (
            Expr()
            .set({**fields, "updatedAt": at})
            .exists()
            .eq("userId", self.user_id)
            .eq("workspaceId", self.workspace_id)
        )
        self._gated([("update", self.pk, str(idea["sk"]), write)], gone=IDEA_GONE)
        return {"ok": True, "idea": public({**idea, **fields, "updatedAt": at})}

    def _safety_idea(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.offer("save_idea", "Save this idea", payload)
        return {
            "ok": True,
            "saved": False,
            "note": "Driving-safety ideas are saved by the owner's tap, so the app can match them to checked advice. A Save this idea button was added.",
        }

    def offer_save_idea(self, args: dict[str, Any]) -> dict[str, Any]:
        fields = self._idea_fields(args, partial=False)
        return self.offer("save_idea", "Save this idea", {"idea": {**fields, "source": "ai"}})

    def propose_character(self, args: dict[str, Any]) -> dict[str, Any]:
        if self.catalog is None:
            raise ToolError("Characters can't be drafted right now.")
        taken = [str(c.get("name") or "") for c in self._list("CHAR#")]
        character, problems = check_character(args.get("character"), self.catalog(), taken_names=taken)
        if character is None:
            raise ToolError("The character draft needs fixing: " + "; ".join(problems[:8]))
        result = self.offer("save_character", f"Save {character['name']}", {"character": character})
        if problems:
            result["fixed"] = problems[:8]
        return result

    def propose_story_change(self, args: dict[str, Any]) -> dict[str, Any]:
        story = self._get(f"STORY#{args.get('storyId')}", "There is no story with that id.")
        note = clip(args.get("note"), 500)
        scene_ids = [str(s) for s in args.get("sceneIds") or []] if isinstance(args.get("sceneIds"), list) else []
        known = {str(s.get("sceneId")) for s in story.get("scenes") or [] if isinstance(s, dict)}
        bad = [s for s in scene_ids if s not in known]
        if bad:
            raise ToolError(f"These scenes are not in that story: {', '.join(bad)}. Use read_story.")
        if not note and not scene_ids:
            raise ToolError("Give a note, scene ids, or both.")
        status = story.get("status")
        if status not in REMAKE_STATUSES:
            raise ToolError(NOT_REMAKABLE.get(str(status), "That video can't be remade now."))
        payload: dict[str, Any] = {"storyId": story["storyId"], "sceneIds": list(dict.fromkeys(scene_ids))}
        if note:
            payload["note"] = note
        label = "Remake this scene" if scene_ids and not note and len(scene_ids) == 1 else "Make these changes"
        return self.offer("remake_scene", label, payload)

    def offer_make_video(self, args: dict[str, Any]) -> dict[str, Any]:
        cast = self._characters(args.get("characterIds"), need=True)
        story: dict[str, Any] = {"characterIds": cast}
        refs = self._references(args.get("referenceIds"))
        if refs:
            story["referenceIds"] = refs
        if args.get("ideaId"):
            idea = self._get(f"IDEA#{args.get('ideaId')}", "There is no idea with that id.")
            if idea.get("needsGuidance"):
                raise ToolError(
                    "That driving-safety idea has no checked advice yet, so it can't be made. Say so to the owner."
                )
            story["ideaId"] = idea["ideaId"]
        else:
            fields = self._idea_fields({k: args.get(k) for k in ("title", "logline", "category")}, partial=False)
            if (
                fields["category"] == "driving_safety"
                and guidance.keyword_match([fields["title"], fields["logline"]]) is None
            ):
                raise ToolError(
                    "Clip Factory Stories only makes driving-safety videos from checked advice, and this one isn't in "
                    "the list."
                )
            story["brief"] = fields
        if args.get("durationSec") is not None:
            try:
                story["durationSec"] = min(90, max(15, int(args["durationSec"])))
            except (TypeError, ValueError) as e:
                raise ToolError("durationSec is a number of seconds from 15 to 90.") from e
        return self.offer("make_video", "Make the video", {"story": story})

    def offer_analyze_reference(self, args: dict[str, Any]) -> dict[str, Any]:
        r = self._get(f"REFVID#{args.get('refId')}", "There is no reference video with that id.")
        if r.get("status") in ("uploading", "analyzing"):
            raise ToolError("That video is still uploading or being analyzed.")
        return self.offer("analyze_reference", "Analyze this video", {"refId": r["refId"]})

    def offer_open(self, args: dict[str, Any]) -> dict[str, Any]:
        page = args.get("page")
        if page not in PAGES:
            raise ToolError("That is not a Clip Factory Stories page.")
        href = PAGES[str(page)]
        if "{id}" in href:
            item_id = str(args.get("id") or "")
            if not item_id or not all(ch.isalnum() for ch in item_id):
                raise ToolError("That page needs the item's id.")
            href = href.replace("{id}", item_id)
        label = PAGE_LABELS.get(str(page), "Open it")
        return self.offer("open", label, {"href": href})

    def remember(self, args: dict[str, Any]) -> dict[str, Any]:
        text = clip(args.get("text"), 1000)
        if not text:
            raise ToolError("Say what to remember.")
        if len(text) > memory.TEXT_MAX:
            raise ToolError(f"Keep it to {memory.TEXT_MAX} characters.")
        found = memory.already(self.svc.store, self.user_id, self.workspace_id, text)
        if found is not None:
            return {"ok": True, "note": "Already remembered.", "memory": public(found)}
        if len(memory.items(self.svc.store, self.user_id, self.workspace_id)) >= memory.CHAT_LIMIT:
            raise ToolError(memory.FULL)
        item = memory.new_item(self.user_id, self.workspace_id, text, source="chat")
        pk, sk = item.pop("pk"), item.pop("sk")
        self._gated([("put", pk, sk, item)])
        return {"ok": True, "memory": public(item)}

    # --- dispatch ------------------------------------------------------------------------------------------------

    def run(self, name: str, args: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """``(result, ok)`` for one tool call; a mistake the model can fix comes back as an error result."""
        fn = getattr(self, name, None) if name in TOOL_NAMES else None
        if fn is None:
            return {"error": f"There is no tool named {name}."}, False
        try:
            return fn(args if isinstance(args, dict) else {}), True
        except ToolError as e:
            return {"error": str(e)}, False
        except (Superseded, TaskFailed):
            raise


TOOL_NAMES = frozenset(s["toolSpec"]["name"] for s in specs())
