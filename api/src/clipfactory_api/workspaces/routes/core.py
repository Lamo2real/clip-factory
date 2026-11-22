"""Workspaces, dashboard, ideas, characters, stories, tasks, library, providers and guidance (docs/CONTRACTS.md §45.5).

Served only by Lamo Stories' own Lambda (``workspaces/http.py``). Every key is built from the JWT's ``sub`` and the
path's workspace id (``guard.require_workspace``: another owner's workspace is a 404, Lamo Clips on a Lamo Stories page
a 409), and every item read is checked again with ``guard.owned``. Nothing here reads or writes ``USER#{userId}``
(Lamo Clips' partition) or a Lamo Clips S3 prefix, and nothing here calls a model: AI work is a task or a job of
Lamo Stories' own runtime (``workspaces/agent.py``).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ... import db, validate
from ...app import App
from ...clock import iso, parse
from ...errors import ApiError, bad_request, conflict, not_found, too_large
from ...http import Request, Response, Route, no_content, ok, route
from ...ids import is_ulid, ulid
from ...log import log
from ...workspaces import (
    activity,
    ai_config,
    ai_resolve,
    characters,
    dashboard,
    deps,
    guard,
    guidance,
    ideas,
    jobs,
    library,
    media,
    overrides,
    provider_keys,
    providers,
    shapes,
    stories,
    tasks,
)
from ...workspaces import agent as story_agent
from ...workspaces import agents as agents_mod
from ...workspaces import types as ws
from ...workspaces.expr import Update

Item = dict[str, Any]
WS_NAME_MAX = 40
MAX_SCRIPT_BYTES = 2 * 1024 * 1024
REFERENCE_GRACE_SECONDS = 60 * 60  # a started upload may be completed for an hour
NO_IDEA = "We could not find that idea."
NO_CHARACTER = "We could not find that character."
NO_STORY = "We could not find that story."
NO_PICTURE = "We could not find that picture."
NO_TASK = "We could not find that helper task."
NO_REFERENCE_VIDEO = "We could not find one of those reference videos. Pick them again."
SETTINGS_CHANGED = "These settings changed on another screen. Reload and try again."
CHARACTER_CHANGED = "This character changed on another screen. Reload it and try again."
IMAGES_OFF = "AI pictures are off. Turn them on in Lamo Stories › Settings › Video › Picture maker."
SCRIPT_UNREADABLE = "We could not open the storyboard just now. Try again in a minute."
CANCEL_ATTEMPTS = 3
CHECK_JOBS_READ = 50  # the newest jobs looked at for a "Try it" still running (one takes a minute or two)
# A delete still deletes items and files after its stops: that much more of the 29 s is kept for it.
DELETE_RESERVE_SECONDS = 4.0


@dataclass
class Ctx:
    """One request. Its best-effort AgentCore calls (``stop``, ``_tell_agent``) run once each and only while
    ``story_agent.time_for_call`` says the call still ends inside the 29 s with ``reserve`` seconds to spare; inside
    ``stops_last`` they wait until the route's own start (which may need the whole 29 s) is done."""

    app: App
    req: Request
    workspace: Item
    now: datetime
    reserve: float = story_agent.AFTER_CALL_SECONDS
    deferred: list[str] | None = None  # set by ``stops_last``: the sessions to stop at its end
    _ai: tuple[Item, dict[str, Item]] | None = None  # the AI settings and agents, read once per request

    def ai_settings(self) -> tuple[Item, dict[str, Item]]:
        """The workspace's AI configuration and stored agents, for ``Story.effective`` (read once per request)."""
        if self._ai is None:
            self._ai = (
                ai_config.current(self.store, self.user_id, self.ws_id),
                agents_mod.read_all(self.store, self.user_id, self.ws_id),
            )
        return self._ai

    @property
    def user_id(self) -> str:
        return self.req.user_id

    @property
    def ws_id(self) -> str:
        return str(self.workspace["workspaceId"])

    @property
    def pk(self) -> str:
        return ws.workspace_pk(self.user_id, self.ws_id)

    @property
    def store(self) -> db.Store:
        return self.app.store

    @property
    def deps(self) -> deps.WsDeps:
        return deps.of(self.app)

    @property
    def config(self) -> Item:
        return shapes.stories_config(self.workspace)

    def presign(self, key: str) -> str:
        return self.app.media.presign_get(key)

    def at(self) -> str:
        return iso(self.now)

    def owned(self, item: Mapping[str, Any] | None, kind: str) -> Item | None:
        if item is None or item.get("type") != kind or not guard.owned(dict(item), self.user_id, self.ws_id):
            return None
        return dict(item)

    def time_for_call(self) -> bool:
        return story_agent.time_for_call(self.req.started, after=self.reserve)

    def stop(self) -> Callable[[str], None] | None:
        """Ends a fenced run's session (best effort, ``jobs.stop_quietly``): once, while the request has time."""
        agent = self.deps.agent
        if agent is None or not getattr(agent, "ready", False):
            return None

        def stop_in_time(session_id: str) -> None:
            if self.deferred is not None:
                self.deferred.append(session_id)
            elif self.time_for_call():
                agent.stop_session(session_id, attempts=1)
            else:
                log("info", "stories.stop_skipped", reason="no_time")  # the new sessionId already fences it

        return stop_in_time

    @contextlib.contextmanager
    def stops_last(self) -> Iterator[None]:
        """For a route that starts work: the fence's stops wait until the start is done (or the route refused)."""
        self.deferred = []
        try:
            yield
        finally:
            sessions, self.deferred = self.deferred, None
            stop = self.stop()
            for session_id in sessions:
                jobs.stop_quietly(stop, session_id)


def _ctx(app: App, req: Request, *, stories_only: bool = True) -> Ctx:
    now = app.clock()
    item = guard.require_workspace(app.store, req.user_id, req.params["ws"], stories=stories_only, now=now)
    return Ctx(app, req, item, now)


def _id(req: Request, name: str, message: str) -> str:
    value = req.params[name]
    if not is_ulid(value):
        raise not_found(message)
    return value


def _get(ctx: Ctx, prefix: str, item_id: str, kind: str, message: str) -> Item:
    found = ctx.owned(ctx.store.get(ctx.pk, f"{prefix}{item_id}"), kind)
    if found is None:
        raise not_found(message)
    return found


def _all(ctx: Ctx, prefix: str, kind: str, *, newest_first: bool = False) -> list[Item]:
    items = ctx.store.query_all(ctx.pk, prefix, newest_first=newest_first)
    return [i for i in (ctx.owned(x, kind) for x in items) if i is not None]


# --- workspaces -----------------------------------------------------------------------------------------------


def _registry(app: App, user_id: str) -> list[Item]:
    out = []
    for item in app.store.query_all(ws.registry_pk(user_id), ws.WS_SK):
        workspace_id = item.get("workspaceId")
        if (
            item.get("type") == ws.TYPE_WORKSPACE
            and isinstance(workspace_id, str)
            and ws.WORKSPACE_ID.match(workspace_id)
            and workspace_id != ws.CLIPS
            and item.get("sk") == ws.workspace_sk(workspace_id)
            and guard.owned(item, user_id, workspace_id)
        ):
            out.append(item)
    return out


def _with_first(app: App, user_id: str, now: datetime) -> list[Item]:
    items = _registry(app, user_id)
    if not any(i["workspaceId"] == ws.FIRST_STORIES_ID for i in items):
        items.append(guard.ensure_first_stories(app.store, user_id, now))
    # By createdAt; on a tie (made in the same millisecond) the first Lamo Stories workspace comes first.
    return sorted(
        items,
        key=lambda i: (str(i.get("createdAt") or ""), i["workspaceId"] != ws.FIRST_STORIES_ID, str(i["workspaceId"])),
    )


def list_workspaces(app: App, req: Request) -> Response:
    items = _with_first(app, req.user_id, app.clock())
    return ok({"workspaces": [guard.clips_workspace(), *[shapes.public_workspace(i) for i in items]]})


def _name_taken(items: list[Item], name: str, *, except_id: str | None = None) -> bool:
    if characters.same_name(name, ws.WORKSPACE_TYPES[ws.CLIPS].label):
        return True
    return any(characters.same_name(i.get("workspaceName"), name) and i["workspaceId"] != except_id for i in items)


def create_workspace(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"workspaceType", "workspaceName"})
    if body.get("workspaceType") != ws.STORIES:
        raise bad_request('workspaceType must be "stories".', "workspaceType")
    name = validate.required_string(body, "workspaceName", max_len=WS_NAME_MAX)
    now = app.clock()
    items = _with_first(app, req.user_id, now)
    if _name_taken(items, name):
        raise conflict(f"You already have a workspace called {name}. Pick another name.", "workspaceName")
    if len(items) >= ws.MAX_WORKSPACES:
        raise conflict(f"You can have at most {ws.MAX_WORKSPACES} workspaces.")
    workspace_id = ulid()
    item = {
        "pk": ws.registry_pk(req.user_id),
        "sk": ws.workspace_sk(workspace_id),
        "type": ws.TYPE_WORKSPACE,
        "userId": req.user_id,
        "workspaceId": workspace_id,
        "workspaceName": name,
        "workspaceType": ws.STORIES,
        "configuration": guard.default_stories_config(),
        "version": 1,
        "createdAt": iso(now),
        "updatedAt": iso(now),
    }
    app.store.put(item, if_absent=True)
    return ok({"workspace": shapes.public_workspace(item)}, 201)


def get_workspace(app: App, req: Request) -> Response:
    ctx = _ctx(app, req, stories_only=False)
    return ok({"workspace": shapes.public_workspace(ctx.workspace)})


CONFIG_CHOICES: dict[str, tuple[str, ...]] = {
    "youtubeCategory": ("1", "2", "23", "24", "27"),
    "youtubePrivacy": ("public", "unlisted", "private"),
}
PROVIDER_CHOICES: dict[str, tuple[str, ...]] = {
    "images": ("builtin-rig", "nova-canvas"),
    "video": ("builtin-2d", "nova-reel"),
    "audio": ("builtin-synth",),
}
QUALITIES = ("standard", "high", "best")
X_LIMIT_MAX = 10_000
EXTRA_FORMATS = ("webm", "mov")  # every video is MP4 too (§45.34 "Output formats")
KEEP_REFERENCES = ("all", "study_only", "days_30", "days_90")
KEEP_CHAT_PICTURES = ("all", "days_30", "days_90")


def _merge_section(current: Mapping[str, Any], value: Any, name: str) -> Item:
    chosen = validate.obj(value, f"configuration.{name}")
    validate.only_keys(chosen, current.keys())
    return {**dict(current), **chosen}


def _money(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not 0 <= value <= X_LIMIT_MAX:
        raise bad_request(f"{field} must be a number of dollars from 0 to {X_LIMIT_MAX}.")
    return value if isinstance(value, int) or not float(value).is_integer() else int(value)


def _config_patch(current: Mapping[str, Any], value: Any) -> Item:
    """Partial<StoriesConfig> (§45.6) merged onto the current configuration; each section may be partial too."""
    body = validate.obj(value, "configuration")
    validate.only_keys(body, current.keys())
    out = dict(current)
    for key, v in body.items():
        if key == "defaultDurationSec":
            out[key] = validate.integer(v, "configuration.defaultDurationSec", lo=15, hi=90)
        elif key in {"captionsOn", "musicOn"}:
            out[key] = validate.boolean(v, f"configuration.{key}")
        elif key == "providers":
            merged = _merge_section(current.get("providers") or {}, v, key)
            for kind, provider_id in merged.items():
                if provider_id not in PROVIDER_CHOICES.get(kind, ()):
                    raise bad_request(f"configuration.providers.{kind} is not a provider of that kind.")
            out[key] = merged
        elif key == "video":
            merged = _merge_section(current.get("video") or {}, v, key)
            if merged.get("aspect") not in stories.ASPECTS:
                raise bad_request("Pick a shape: 9:16 (tall), 1:1 (square) or 16:9 (wide).", "configuration.video")
            if merged.get("resolution") not in stories.ASPECTS[str(merged["aspect"])]:
                sizes = " or ".join(s.replace("x", " by ") for s in stories.ASPECTS[str(merged["aspect"])])
                raise bad_request(f"A {merged['aspect']} video is {sizes}.", "configuration.video")
            if merged.get("fps") != 30:
                raise bad_request("The built-in animator makes 30 frames a second only.", "configuration.video")
            if merged.get("quality") not in QUALITIES:
                raise bad_request("configuration.video.quality must be standard, high or best.")
            out[key] = merged
        elif key == "production":
            merged = _merge_section(current.get("production") or {}, v, key)
            merged["burnCaptions"] = validate.boolean(
                merged.get("burnCaptions"), "configuration.production.burnCaptions"
            )
            merged["scenesAtOnce"] = validate.integer(
                merged.get("scenesAtOnce"), "configuration.production.scenesAtOnce", lo=1, hi=3
            )
            if merged.get("keepVersions") != "all":
                merged["keepVersions"] = validate.integer(
                    merged.get("keepVersions"), "configuration.production.keepVersions", lo=1, hi=10
                )
            formats = merged.get("extraFormats")
            if not isinstance(formats, list) or any(f not in EXTRA_FORMATS for f in formats):
                raise bad_request(
                    "Every video is an MP4. Pick extra formats from WebM and MOV, or none.",
                    "configuration.production.extraFormats",
                )
            merged["extraFormats"] = [f for f in EXTRA_FORMATS if f in formats]
            if merged.get("keepReferences") not in KEEP_REFERENCES:
                raise bad_request(
                    "Keep reference videos: pick all, only their study, 30 days or 90 days.",
                    "configuration.production.keepReferences",
                )
            if merged.get("keepChatPictures") not in KEEP_CHAT_PICTURES:
                raise bad_request(
                    "Keep chat pictures: pick all, 30 days or 90 days.", "configuration.production.keepChatPictures"
                )
            out[key] = merged
        elif key == "xMonthlyLimitUsd":
            out[key] = None if v is None else _money(v, "configuration.xMonthlyLimitUsd")
        elif key in CONFIG_CHOICES:
            if v not in CONFIG_CHOICES[key]:
                raise bad_request(f"configuration.{key} must be one of: {', '.join(CONFIG_CHOICES[key])}.")
            out[key] = v
    return out


def patch_workspace(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    body = req.json()
    validate.only_keys(body, {"workspaceName", "configuration", "version"})
    version = validate.integer(body.get("version"), "version", lo=1, hi=10**9)
    sets: Item = {"updatedAt": ctx.at()}
    if "workspaceName" in body:
        name = validate.required_string(body, "workspaceName", max_len=WS_NAME_MAX)
        if _name_taken(_registry(app, ctx.user_id), name, except_id=ctx.ws_id):
            raise conflict(f"You already have a workspace called {name}. Pick another name.", "workspaceName")
        sets["workspaceName"] = name
    if "configuration" in body:
        sets["configuration"] = _config_patch(ctx.config, body["configuration"])
        if isinstance(body["configuration"], Mapping) and "providers" in body["configuration"]:
            sets["providersPickedAt"] = ctx.at()  # the setup's step 4, even when the pick is unchanged (§45.34)
    if int(ctx.workspace.get("version") or 1) != version:
        raise conflict(SETTINGS_CHANGED)
    update = Update(ws.registry_pk(ctx.user_id), ws.workspace_sk(ctx.ws_id), sets=sets).bump()
    try:
        item = update.equals("version", version).equals("userId", ctx.user_id).run(app.store)
    except db.ConditionFailed as e:
        raise conflict(SETTINGS_CHANGED) from e
    return ok({"workspace": shapes.public_workspace(item)})


# --- ideas ----------------------------------------------------------------------------------------------------


def _idea_item(ctx: Ctx, fields: Mapping[str, Any], g: guidance.Guidance) -> Item:
    idea_id = ulid()
    item: Item = {
        "pk": ctx.pk,
        "sk": f"{ws.IDEA_SK}{idea_id}",
        "type": ws.TYPE_IDEA,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "ideaId": idea_id,
        "source": "manual",
        "characterIds": [],
        "status": "saved",
        **{k: v for k, v in fields.items() if v is not None},
        "createdAt": ctx.at(),
        "updatedAt": ctx.at(),
    }
    item.update(ideas.safety_fields(g, item))
    return item


def _check_characters(ctx: Ctx, ids: list[str]) -> list[Item]:
    if not ids:
        return []
    found = ctx.store.batch_get([(ctx.pk, f"{ws.CHAR_SK}{c}") for c in ids])
    owned = {i["characterId"]: i for i in (ctx.owned(f, ws.TYPE_CHARACTER) for f in found) if i is not None}
    if any(c not in owned for c in ids):
        raise bad_request("We could not find one of those characters. Pick them again.", "characterIds")
    return [owned[c] for c in ids]


def list_ideas(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    status = req.query.get("status") or "all"
    if status not in {"saved", "used", "all"}:
        raise bad_request("status must be saved, used or all.")
    items = _all(ctx, ws.IDEA_SK, ws.TYPE_IDEA, newest_first=True)
    shown = [shapes.public_idea(i) for i in items]
    return ok({"ideas": [i for i in shown if status == "all" or i["status"] == status]})


def create_idea(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    fields = ideas.idea_input(req.json())
    _check_characters(ctx, fields.get("characterIds") or [])
    if fields.get("parentIdeaId") and not ctx.owned(
        ctx.store.get(ctx.pk, f"{ws.IDEA_SK}{fields['parentIdeaId']}"), ws.TYPE_IDEA
    ):
        fields.pop("parentIdeaId")  # the idea it came from is gone: keep the new one anyway
    item = _idea_item(ctx, fields, guidance.load())
    ctx.store.put(item, if_absent=True)
    return ok({"idea": shapes.public_idea(item)}, 201)


def patch_idea(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    idea_id = _id(req, "ideaId", NO_IDEA)
    current = _get(ctx, ws.IDEA_SK, idea_id, ws.TYPE_IDEA, NO_IDEA)
    changes = ideas.idea_input(req.json(), partial=True)
    if not changes:
        raise bad_request("Nothing to change.")
    _check_characters(ctx, changes.get("characterIds") or [])
    merged = {**current, **changes}
    update = Update(ctx.pk, current["sk"], sets={"updatedAt": ctx.at()})
    for key, value in {**changes, **ideas.safety_fields(guidance.load(), merged)}.items():
        if value is None:
            update.removes.append(key)
        else:
            update.sets[key] = value
    try:
        item = update.equals("userId", ctx.user_id).equals("workspaceId", ctx.ws_id).run(ctx.store)
    except db.ConditionFailed as e:
        raise not_found(NO_IDEA) from e
    return ok({"idea": shapes.public_idea(item)})


def delete_idea(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    idea = _get(ctx, ws.IDEA_SK, _id(req, "ideaId", NO_IDEA), ws.TYPE_IDEA, NO_IDEA)
    ctx.store.delete(ctx.pk, idea["sk"])
    return no_content()


def _refuse_unusable(
    ctx: Ctx,
    *,
    project: Any,
    request: Mapping[str, Any] | None = None,
    field: str,
    kinds: tuple[str, ...] = overrides.STORY_TASKS,
) -> None:
    overrides.refuse_unusable(
        ctx.store,
        ctx.user_id,
        ctx.ws_id,
        project=project if isinstance(project, Mapping) else None,
        request=request,
        field=field,
        kinds=kinds,
    )


def _task_reply(
    ctx: Ctx,
    kind: str,
    task_input: Mapping[str, Any],
    override: Mapping[str, Any] | None,
    *,
    project: Any = None,
) -> Response:
    """Writes the task and asks Lamo Stories' runtime to do it: ``202 { task }`` (a refused start is a failed task).
    ``project``: the video's own setting, for a story's task (§45.25 level 2)."""
    tasks.refuse_if_off(ctx.store, ctx.user_id, ctx.ws_id, kind)
    _refuse_unusable(ctx, project=project, request=override, field="override", kinds=(kind,))
    task = tasks.new_task(ctx.user_id, ctx.ws_id, kind=kind, task_input=task_input, override=override, now=ctx.now)
    started = tasks.start(ctx.store, ctx.deps.agent, task, ctx.now, started=ctx.req.started, stop=ctx.stop())
    return ok({"task": tasks.public_task(started)}, 202)


def generate_ideas(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    task_input, override = ideas.generate_body(req.json())
    return _task_reply(ctx, "brainstorm", task_input, override)


def expand_idea(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    idea = _get(ctx, ws.IDEA_SK, _id(req, "ideaId", NO_IDEA), ws.TYPE_IDEA, NO_IDEA)
    task_input, override = ideas.expand_body(req.json(), idea, int(ctx.config["defaultDurationSec"]))
    return _task_reply(ctx, "expand_idea", task_input, override)


def idea_variations(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    idea = _get(ctx, ws.IDEA_SK, _id(req, "ideaId", NO_IDEA), ws.TYPE_IDEA, NO_IDEA)
    task_input, override = ideas.variations_body(req.json(), idea)
    return _task_reply(ctx, "variations", task_input, override)


# --- tasks ----------------------------------------------------------------------------------------------------


def _apply_expand(ctx: Ctx, task: Item, result: Item) -> Item:
    """A finished Expand: the concept goes on the idea once (keeping its title) and the topic match runs here, in
    the API (§45.7); ``result.idea`` is the idea as it is now. The agent may have written the concept itself."""
    idea_id = (task.get("input") or {}).get("ideaId") if isinstance(task.get("input"), Mapping) else None
    idea = ctx.owned(ctx.store.get(ctx.pk, f"{ws.IDEA_SK}{idea_id}"), ws.TYPE_IDEA) if is_ulid(idea_id) else None
    if idea is None:
        return {k: v for k, v in result.items() if k != "idea"}
    if not task.get("applied"):
        found = ideas.expanded(result)
        pick = found[1] if found else result.get("topicId")
        merged = {**idea, "concept": found[0]} if found else idea
        safety = ideas.safety_fields(guidance.load(), merged, pick if isinstance(pick, str) else None)
        update = Update(ctx.pk, idea["sk"], sets={"needsGuidance": safety["needsGuidance"], "updatedAt": ctx.at()})
        if found:
            update.sets["concept"] = found[0]
        if safety["safetyTopicId"] is None:
            update.removes.append("safetyTopicId")
        else:
            update.sets["safetyTopicId"] = safety["safetyTopicId"]
        mark = Update(ctx.pk, str(task["sk"]), sets={"applied": True}).equals("status", "done")
        mark.absent_or_null("applied")
        # Refused: applied already by another read, or the idea is gone. Either way, show what is stored.
        with contextlib.suppress(db.ConditionFailed):
            ctx.store.transact(updates=[update.equals("userId", ctx.user_id).request(), mark.request()])
        idea = ctx.owned(ctx.store.get(ctx.pk, idea["sk"]), ws.TYPE_IDEA) or idea
    return {**result, "idea": shapes.public_idea(idea)}


def _task_result(ctx: Ctx, task: Item) -> Item:
    """What the web shows of a finished task: drafts checked like ideas the owner types, a concept put on its idea."""
    out = tasks.public_task(task)
    result = out.get("result")
    if task.get("status") != "done" or not isinstance(result, dict):
        return out
    kind = task.get("kind")
    task_input = task.get("input") if isinstance(task.get("input"), Mapping) else {}
    if kind in ("brainstorm", "variations"):
        known = [c["characterId"] for c in _all(ctx, ws.CHAR_SK, ws.TYPE_CHARACTER)]
        parent = None
        category = (task_input or {}).get("category") if kind == "brainstorm" else None
        if kind == "variations":
            parent_id = (task_input or {}).get("ideaId")
            parent = ctx.owned(ctx.store.get(ctx.pk, f"{ws.IDEA_SK}{parent_id}"), ws.TYPE_IDEA)
            category = (parent or {}).get("category")
        result["drafts"] = ideas.drafts(
            result.get("drafts"),
            known_characters=known,
            source="variation" if kind == "variations" else "ai",
            category=str(category) if category else None,
            parent_id=str(parent["ideaId"]) if parent else None,
            limit=int((task_input or {}).get("count") or 6),
        )
    elif kind == "expand_idea":
        result = _apply_expand(ctx, task, result)
    out["result"] = result
    return out


def get_task(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    task_id = _id(req, "taskId", NO_TASK)
    found = _get(ctx, ws.TASK_SK, task_id, ws.TYPE_TASK, NO_TASK)
    task = jobs.settle_task(ctx.store, found, ctx.now, stop=ctx.stop()) or found
    return ok({"task": _task_result(ctx, task)})


# --- characters -----------------------------------------------------------------------------------------------


def _story_counts(ctx: Ctx) -> dict[str, int]:
    counts: dict[str, int] = {}
    for story in _all(ctx, ws.STORY_SK, ws.TYPE_STORY):
        for character_id in set(story.get("characterIds") or []):
            counts[character_id] = counts.get(character_id, 0) + 1
    return counts


def _with_portrait(ctx: Ctx, item: Item) -> Item:
    """The agent's portrait file (an ``ASSET#`` of kind portrait) recorded on the character once its job is done."""
    job_id = item.get("portraitJobId")
    stored = item.get("portrait") if isinstance(item.get("portrait"), Mapping) else None
    if not job_id or (stored or {}).get("jobId") == job_id:
        return item
    job = ctx.owned(ctx.store.get(ctx.pk, jobs.job_sk(str(job_id))), ws.TYPE_PJOB)
    if job is None or job.get("status") != "ready":
        return item
    found = [
        a
        for a in _all(ctx, ws.ASSET_SK, ws.TYPE_ASSET, newest_first=True)
        if a.get("kind") == "portrait" and a.get("characterId") == item["characterId"]
    ]
    if not found:
        return item
    portrait = {"assetId": found[0]["assetId"], "key": found[0].get("key"), "jobId": job_id}
    try:
        return Update(ctx.pk, item["sk"], sets={"portrait": portrait}).equals("portraitJobId", job_id).run(ctx.store)
    except db.ConditionFailed:
        return {**item, "portrait": portrait}


def _public_character(ctx: Ctx, item: Item, counts: Mapping[str, int] | None = None) -> Item:
    counts = _story_counts(ctx) if counts is None else counts
    item = _with_portrait(ctx, item)
    return shapes.public_character(item, ctx.presign, ctx.user_id, story_count=counts.get(item["characterId"], 0))


def list_characters(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    counts = _story_counts(ctx)
    items = sorted(_all(ctx, ws.CHAR_SK, ws.TYPE_CHARACTER), key=lambda c: str(c.get("name") or "").casefold())
    return ok({"characters": [_public_character(ctx, c, counts) for c in items]})


def _name_used(ctx: Ctx, name: str, *, except_id: str | None = None) -> bool:
    return any(
        characters.same_name(c.get("name"), name) and c["characterId"] != except_id
        for c in _all(ctx, ws.CHAR_SK, ws.TYPE_CHARACTER)
    )


def create_character(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    fields = characters.character_input(req.json())
    if _name_used(ctx, fields["name"]):
        raise conflict(f"You already have a character called {fields['name']}. Pick another name.", "name")
    character_id = ulid()
    item: Item = {
        "pk": ctx.pk,
        "sk": f"{ws.CHAR_SK}{character_id}",
        "type": ws.TYPE_CHARACTER,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "characterId": character_id,
        **fields,
        "references": [],
        "pendingRefs": {},
        "refsVersion": 0,
        "version": 1,
        "createdAt": ctx.at(),
        "updatedAt": ctx.at(),
    }
    ctx.store.put(item, if_absent=True)
    return ok({"character": _public_character(ctx, item, {})}, 201)


def _character(ctx: Ctx) -> Item:
    return _get(ctx, ws.CHAR_SK, _id(ctx.req, "characterId", NO_CHARACTER), ws.TYPE_CHARACTER, NO_CHARACTER)


def get_character(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    return ok({"character": _public_character(ctx, _character(ctx))})


def put_character(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    current = _character(ctx)
    body = req.json()
    fields = characters.character_input(body, extra=("version",))
    version = validate.integer(body.get("version"), "version", lo=1, hi=10**9)
    if int(current.get("version") or 1) != version:
        raise conflict(CHARACTER_CHANGED)
    if _name_used(ctx, fields["name"], except_id=current["characterId"]):
        raise conflict(f"You already have a character called {fields['name']}. Pick another name.", "name")
    update = Update(ctx.pk, current["sk"], sets={**fields, "updatedAt": ctx.at()}).bump()
    try:
        item = update.equals("version", version).equals("userId", ctx.user_id).run(ctx.store)
    except db.ConditionFailed as e:
        raise conflict(CHARACTER_CHANGED) from e
    return ok({"character": _public_character(ctx, item)})


def _active_jobs(ctx: Ctx) -> list[Item]:
    """Every queued or running job of the workspace, after the stale-heartbeat fence."""
    out = []
    for job in _all(ctx, ws.PJOB_SK, ws.TYPE_PJOB):
        if jobs.active(job):
            settled = jobs.settle(ctx.store, job, ctx.now, stop=ctx.stop())
            if jobs.active(settled):
                out.append(dict(settled or job))
    return out


def delete_character(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    ctx.reserve = DELETE_RESERVE_SECONDS  # the fence's stops leave time for the deletes after them
    item = _character(ctx)
    character_id = item["characterId"]
    running = _active_jobs(ctx)
    for job in running:
        if job.get("contentType") == "character" and job.get("contentId") == character_id:
            raise conflict(f"A picture of {item.get('name')} is being made. Wait until it is done.")
    story_keys = [
        (ctx.pk, jobs.story_sk(str(j.get("contentId")))) for j in running if j.get("contentType") == "animation"
    ]
    for story in ctx.store.batch_get(story_keys) if story_keys else []:
        if guard.owned(story, ctx.user_id, ctx.ws_id) and character_id in (story.get("characterIds") or []):
            raise conflict(f"{item.get('name')} is in a story that is being made. Wait until it is done.")
    assets = [a for a in _all(ctx, ws.ASSET_SK, ws.TYPE_ASSET) if a.get("characterId") == character_id]
    ctx.app.media.delete_prefix(shapes.character_prefix(ctx.user_id, ctx.ws_id, character_id))
    for asset in assets:
        ctx.store.delete(ctx.pk, asset["sk"])
    ctx.store.delete(ctx.pk, item["sk"])
    return no_content()


def _pending(item: Mapping[str, Any], now: datetime) -> dict[str, Item]:
    """Started uploads that may still be completed."""
    out: dict[str, Item] = {}
    raw = item.get("pendingRefs") if isinstance(item.get("pendingRefs"), Mapping) else {}
    for asset_id, pending in (raw or {}).items():
        started = parse(pending.get("startedAt")) if isinstance(pending, Mapping) else None
        if started is not None and (now - started).total_seconds() < REFERENCE_GRACE_SECONDS:
            out[str(asset_id)] = dict(pending)
    return out


def _refs_update(ctx: Ctx, item: Mapping[str, Any]) -> Update:
    """Reference changes are fenced on their own counter, so an open editor's ``version`` stays valid."""
    update = Update(ctx.pk, str(item["sk"]), sets={"updatedAt": ctx.at()})
    update.adds["refsVersion"] = 1
    current = int(item.get("refsVersion") or 0)
    return update.missing_or_equals("refsVersion", 0) if current == 0 else update.equals("refsVersion", current)


def reference_upload(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    item = _character(ctx)
    content_type, size = _picture_body(req.json())
    pending = _pending(item, ctx.now)
    if len(item.get("references") or []) + len(pending) >= characters.MAX_REFERENCES:
        raise conflict("A character can have at most 8 pictures. Delete one first.")
    if len(pending) >= characters.PENDING_LIMIT:
        raise conflict("Wait for the pictures you are sending to finish first.")
    asset_id = ulid()
    key = characters.reference_key(
        shapes.character_prefix(ctx.user_id, ctx.ws_id, item["characterId"]), asset_id, content_type
    )
    pending[asset_id] = {"key": key, "contentType": content_type, "size": size, "startedAt": ctx.at()}
    update = _refs_update(ctx, item)
    update.sets["pendingRefs"] = pending
    try:
        update.run(ctx.store)
    except db.ConditionFailed as e:
        raise conflict(CHARACTER_CHANGED) from e
    url = app.media.presign_put_sized(key, content_type, size, seconds=characters.UPLOAD_SECONDS)
    return ok({"assetId": asset_id, "uploadUrl": url, "headers": {"Content-Type": content_type}})


def _forget_pending(ctx: Ctx, item: Mapping[str, Any], pending: dict[str, Item], asset_id: str) -> None:
    """A refused upload no longer counts towards the 8 pictures (best effort)."""
    update = _refs_update(ctx, item)
    update.sets["pendingRefs"] = {k: v for k, v in pending.items() if k != asset_id}
    with contextlib.suppress(db.ConditionFailed):
        update.run(ctx.store)


def reference_complete(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    item = _character(ctx)
    asset_id = _id(req, "assetId", NO_PICTURE)
    if any(r.get("assetId") == asset_id for r in item.get("references") or []):
        return ok({"character": _public_character(ctx, item)})
    pending = _pending(item, ctx.now)
    started = pending.get(asset_id)
    if started is None:
        raise not_found("We could not find that upload. Send the picture again.")
    key = str(started["key"])
    if not key.startswith(shapes.character_prefix(ctx.user_id, ctx.ws_id, item["characterId"])):
        raise not_found(NO_PICTURE)
    head = app.media.head(key)
    if head is None:
        raise bad_request("The picture did not finish sending. Try again.")
    size = int(head.get("ContentLength") or 0)
    stored_type = str(head.get("ContentType") or started["contentType"]).lower()
    if not 0 < size <= characters.MAX_REFERENCE_BYTES or stored_type != started["contentType"]:
        app.media.delete(key)
        _forget_pending(ctx, item, pending, asset_id)
        raise bad_request("That picture could not be used. Pick a PNG, JPEG or WebP under 10 MB.")
    if len(item.get("references") or []) >= characters.MAX_REFERENCES:
        app.media.delete(key)
        raise conflict("A character can have at most 8 pictures. Delete one first.")
    ref = {"assetId": asset_id, "key": key, "contentType": stored_type, "createdAt": ctx.at()}
    pending.pop(asset_id)
    update = _refs_update(ctx, item)
    update.sets.update({"references": [*(item.get("references") or []), ref], "pendingRefs": pending})
    asset = {
        "pk": ctx.pk,
        "sk": f"{ws.ASSET_SK}{asset_id}",
        "type": ws.TYPE_ASSET,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "assetId": asset_id,
        "kind": "character_ref",
        "characterId": item["characterId"],
        "key": key,
        "contentType": stored_type,
        "bytes": size,
        "meta": {"current": 1},
        "createdAt": ctx.at(),
    }
    try:
        ctx.store.transact(puts=[asset], updates=[update.request()])
    except db.ConditionFailed as e:
        raise conflict(CHARACTER_CHANGED) from e
    return ok({"character": _public_character(ctx, _character(ctx))})


def reference_delete(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    item = _character(ctx)
    asset_id = _id(req, "assetId", NO_PICTURE)
    refs = list(item.get("references") or [])
    ref = next((r for r in refs if r.get("assetId") == asset_id), None)
    if ref is None:
        raise not_found(NO_PICTURE)
    update = _refs_update(ctx, item)
    update.sets["references"] = [r for r in refs if r.get("assetId") != asset_id]
    try:
        update.run(ctx.store)
    except db.ConditionFailed as e:
        raise conflict(CHARACTER_CHANGED) from e
    ctx.store.delete(ctx.pk, f"{ws.ASSET_SK}{asset_id}")
    key = ref.get("key")
    if isinstance(key, str) and key.startswith(shapes.character_prefix(ctx.user_id, ctx.ws_id, item["characterId"])):
        app.media.delete(key)
    return ok({"character": _public_character(ctx, _character(ctx))})


def make_portrait(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    with ctx.stops_last():  # the fence's stops wait: the start may need the whole 29 s
        item = _character(ctx)
        if ctx.config["providers"].get("images") != "nova-canvas":
            raise conflict(IMAGES_OFF)
        if item.get("portraitJobId"):
            previous = ctx.owned(ctx.store.get(ctx.pk, jobs.job_sk(str(item["portraitJobId"]))), ws.TYPE_PJOB)
            if jobs.active(jobs.settle(ctx.store, previous, ctx.now, stop=ctx.stop())):
                raise conflict(f"A picture of {item.get('name')} is being made. Wait until it is done.")
        job_id = ulid()
        job = jobs.new_job(
            ctx.user_id,
            ctx.ws_id,
            job_id=job_id,
            content_type="character",
            content_id=item["characterId"],
            job_type="portrait",
            run=["portrait"],
            steps=[{"key": "portrait", "label": shapes.STEP_LABEL["portrait"], "status": "pending"}],
            now=ctx.now,
            meta={"providers": {"images": "nova-canvas"}},
        )
        mark = Update(ctx.pk, item["sk"], sets={"portraitJobId": job_id}).equals("userId", ctx.user_id)
        ctx.store.transact(puts=[job], updates=[mark.request()])
        agent = ctx.deps.agent
        if agent is None or not getattr(agent, "ready", False):
            return ok(
                {"job": shapes.public_job(jobs.fail_start(ctx.store, job, None, ctx.now, jobs.PORTRAIT_NOT_SET_UP))},
                202,
            )
        try:
            agent.start_portrait(
                user_id=ctx.user_id,
                workspace_id=ctx.ws_id,
                character_id=item["characterId"],
                job_id=job_id,
                session_id=job["sessionId"],
            )
        except Exception as e:
            log("warning", "stories.portrait_start_failed", jobId=job_id, error=type(e).__name__)
            session_id = str(job["sessionId"])
            job = jobs.fail_start(ctx.store, job, None, ctx.now, jobs.PORTRAIT_NOT_STARTED)
            _stop_after_failed_start(ctx, session_id)
        return ok({"job": shapes.public_job(job)}, 202)


# --- "Design with AI" ----------------------------------------------------------------------------------------

DESIGN_MAX = 600
DESIGN_KINDS = ("design_ref", "character_ref")
DESIGN_UNFINISHED = "The picture did not finish sending. Send it again."


def _picture_body(body: Mapping[str, Any]) -> tuple[str, int]:
    """``{ filename, contentType: png | jpeg | webp, size ≤ 10 MB }`` → (the type, the size)."""
    validate.only_keys(body, {"filename", "contentType", "size"})
    validate.required_string(body, "filename", max_len=255)
    content_type = str(body.get("contentType") or "").lower()
    if content_type not in characters.REFERENCE_TYPES:
        raise bad_request("Pick a PNG, JPEG or WebP picture.", "contentType")
    size = body.get("size")
    if isinstance(size, int) and not isinstance(size, bool) and size > characters.MAX_REFERENCE_BYTES:
        raise too_large("The picture is larger than 10 MB. Pick a smaller one.")
    return content_type, validate.integer(size, "size", lo=1, hi=characters.MAX_REFERENCE_BYTES)


def design_upload(app: App, req: Request) -> Response:
    """A picture for "Design with AI": an ``ASSET#`` of kind ``design_ref`` at ``ws/{u}/{ws}/design/{assetId}.{ext}``
    (the Library hides it) and a presigned PUT that signs its type and length (15 minutes)."""
    ctx = _ctx(app, req)
    content_type, size = _picture_body(req.json())
    asset_id = ulid()
    key = f"{ws.s3_prefix(ctx.user_id, ctx.ws_id)}design/{asset_id}.{characters.REFERENCE_TYPES[content_type]}"
    asset = {
        "pk": ctx.pk,
        "sk": f"{ws.ASSET_SK}{asset_id}",
        "type": ws.TYPE_ASSET,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "assetId": asset_id,
        "kind": "design_ref",
        "storyId": None,
        "characterId": None,
        "key": key,
        "contentType": content_type,
        "bytes": size,
        "meta": {"current": 1},
        "createdAt": ctx.at(),
    }
    ctx.store.put(asset, if_absent=True)
    url = app.media.presign_put_sized(key, content_type, size, seconds=characters.UPLOAD_SECONDS)
    return ok({"assetId": asset_id, "uploadUrl": url, "headers": {"Content-Type": content_type}})


def _design_picture(ctx: Ctx, asset_id: Any) -> Item:
    """A ``design_ref`` or ``character_ref`` asset of this workspace only (else 404), whose file has arrived."""
    if not isinstance(asset_id, str) or not is_ulid(asset_id):
        raise not_found(NO_PICTURE)
    asset = ctx.owned(ctx.store.get(ctx.pk, f"{ws.ASSET_SK}{asset_id}"), ws.TYPE_ASSET)
    key = (asset or {}).get("key")
    if (
        asset is None
        or asset.get("kind") not in DESIGN_KINDS
        or not isinstance(key, str)
        or not key.startswith(ws.s3_prefix(ctx.user_id, ctx.ws_id))
    ):
        raise not_found(NO_PICTURE)
    head = ctx.app.media.head(key)
    if head is None:
        raise bad_request(DESIGN_UNFINISHED, "referenceAssetId")
    if not 0 < int(head.get("ContentLength") or 0) <= characters.MAX_REFERENCE_BYTES:
        raise bad_request("That picture could not be used. Pick a PNG, JPEG or WebP under 10 MB.", "referenceAssetId")
    return asset


def design_character(app: App, req: Request) -> Response:
    """The character agent suggests a CharacterInput from words and/or a picture: ``202 { task }`` (a draft). With
    ``characterId`` (this workspace's character, else 404) it redesigns that character: the agent gets it as the
    current one, keeps its name and changes only what the owner asked (§45.34)."""
    ctx = _ctx(app, req)
    body = req.json()
    validate.only_keys(body, {"description", "referenceAssetId", "override", "characterId"})
    description = validate.string(body, "description", required=False, max_len=DESIGN_MAX)
    override = overrides.model_override(body.get("override"))
    task_input: Item = {}
    if body.get("characterId") is not None:
        character_id = body["characterId"]
        if not isinstance(character_id, str) or not is_ulid(character_id):
            raise not_found(NO_CHARACTER)
        task_input["characterId"] = _get(ctx, ws.CHAR_SK, character_id, ws.TYPE_CHARACTER, NO_CHARACTER)["characterId"]
    if description:
        task_input["description"] = description
    if body.get("referenceAssetId") is not None:
        asset = _design_picture(ctx, body["referenceAssetId"])
        task_input.update(
            {
                "referenceAssetId": asset["assetId"],
                "referenceKey": asset["key"],
                "referenceContentType": asset.get("contentType"),
            }
        )
    if not set(task_input) - {"characterId"}:
        raise bad_request("Describe the character, or add a picture of it.")
    return _task_reply(ctx, "character_design", task_input, override)


# --- stories --------------------------------------------------------------------------------------------------


def _story(ctx: Ctx) -> Item:
    return _get(ctx, ws.STORY_SK, _id(ctx.req, "storyId", NO_STORY), ws.TYPE_STORY, NO_STORY)


def _reread_story(ctx: Ctx, story: Mapping[str, Any]) -> Item:
    return ctx.owned(ctx.store.get(ctx.pk, str(story["sk"])), ws.TYPE_STORY) or dict(story)


def _job_of(ctx: Ctx, story: Mapping[str, Any]) -> Item | None:
    job_id = story.get("currentJobId") or story.get("lastJobId")
    if not isinstance(job_id, str) or not job_id:
        return None
    job = ctx.owned(ctx.store.get(ctx.pk, jobs.job_sk(job_id)), ws.TYPE_PJOB)
    return job if job is not None and job.get("contentId") == story.get("storyId") else None


def _settled(ctx: Ctx, story: Item) -> tuple[Item, Item | None]:
    """The story and its current (or last) job, after the stale-heartbeat fence."""
    job = _job_of(ctx, story)
    if job is not None and jobs.is_stale(job, ctx.now):
        job = jobs.settle(ctx.store, job, ctx.now, stop=ctx.stop(), story=story)
        story = _reread_story(ctx, story)
    return story, job


def _public_story(ctx: Ctx, story: Mapping[str, Any]) -> Item:
    """``Story`` with ``effective`` (§45.34): what the next run's storyboard would use, from §45.25's precedence."""
    out = shapes.public_story(story, ctx.presign, ctx.user_id, ctx.app.media.bucket)
    ai, agents = ctx.ai_settings()
    out["effective"], _ = ai_resolve.story_effective(story, ai=ai, agents=agents, task="storyboard")
    return out


def _read_script(ctx: Ctx, story: Mapping[str, Any], *, required: bool = False) -> Item | None:
    key = story.get("scriptKey")
    prefix = shapes.story_prefix(ctx.user_id, ctx.ws_id, str(story["storyId"]))
    if not isinstance(key, str) or not key.startswith(prefix):
        return None
    try:
        parsed = json.loads(ctx.app.media.read(key, MAX_SCRIPT_BYTES))
    except Exception as e:
        log("warning", "stories.script_unreadable", storyId=story.get("storyId"), error=type(e).__name__)
        if required:
            raise ApiError(503, "platform_down", SCRIPT_UNREADABLE) from e
        return None
    return parsed if isinstance(parsed, dict) else None


def _require_topic(story: Mapping[str, Any]) -> None:
    if story.get("category") == "driving_safety" and not story.get("safetyTopicId"):
        g = guidance.load()
        raise ApiError(409, "conflict", guidance.NO_GUIDANCE, extra={"topics": guidance.topic_choices(g)})


def _meta(ctx: Ctx, story: Mapping[str, Any]) -> Item:
    """What the API knows when a job starts; the agent adds the writer model, engine version, seed, actual length and
    each step's model and effort (``meta.models``) as it goes."""
    chosen = dict(ctx.config.get("providers") or {})
    return {
        "scriptVersion": int(story.get("scriptVersion") or 0) or None,
        "targetSec": story.get("durationSec"),
        "safetyTopicId": story.get("safetyTopicId"),
        "providers": {
            "writer": "bedrock-claude",
            "images": "builtin-rig",
            "animation": str(chosen.get("video") or "builtin-2d"),
            "audio": str(chosen.get("audio") or "builtin-synth"),
        },
    }


def _story_job(
    ctx: Ctx,
    story: Mapping[str, Any],
    *,
    job_type: str,
    run: list[str],
    from_step: str | None,
    scene_ids: list[str] | None,
    note: str | None,
    story_version: int,
    override: Mapping[str, Any] | None = None,
) -> Item:
    """A story job. Its override is refused (400) when, on top of the video's own setting, the model that would run
    does not offer its effort (§45.25)."""
    _refuse_unusable(ctx, project=story.get("ai"), request=override, field="override")
    return jobs.new_job(
        ctx.user_id,
        ctx.ws_id,
        job_id=ulid(),
        content_type="animation",
        content_id=str(story["storyId"]),
        job_type=job_type,
        run=run,
        steps=jobs.story_steps(run, stories.done_steps(story)),
        now=ctx.now,
        from_step=from_step,
        scene_ids=scene_ids,
        note=note,
        meta=_meta(ctx, story),
        story_version=story_version,
        override=override,
        reference_ids=[str(r) for r in story.get("referenceIds") or []],
        video_format=stories.stored_format(story),
    )


def _stop_after_failed_start(ctx: Ctx, session_id: str) -> None:
    """A start that failed may still have opened a runtime session (a refusal, or a timeout after the runtime took
    the job): end it, best effort, when the request still has time for it (``Ctx.stop``). Either way the job's new
    ``sessionId`` fences the run out, so its first write is refused and it stops by itself."""
    jobs.stop_quietly(ctx.stop(), session_id)


def _start(ctx: Ctx, story: Item, job: Item) -> tuple[Item, Item]:
    """Sends the job to the agent; a refused or impossible start fails it at once with a plain sentence."""
    agent = ctx.deps.agent
    sentence = None
    asked = False
    if agent is None or not getattr(agent, "ready", False):
        sentence = jobs.NOT_SET_UP
    else:
        try:
            asked = True
            agent.start_story(
                user_id=ctx.user_id,
                workspace_id=ctx.ws_id,
                story_id=str(story["storyId"]),
                job_id=str(job["jobId"]),
                session_id=str(job["sessionId"]),
            )
        except Exception as e:
            log("warning", "stories.start_failed", jobId=job.get("jobId"), error=type(e).__name__)
            sentence = jobs.NOT_STARTED
    if sentence is not None:
        session_id = str(job["sessionId"])
        job = jobs.fail_start(ctx.store, job, story, ctx.now, sentence)
        story = _reread_story(ctx, story)
        if asked:
            _stop_after_failed_start(ctx, session_id)
    return story, job


def _writer_on(ctx: Ctx, run: list[str]) -> None:
    """A run that writes the story needs the storyboard agent: switched off, it is refused at once (§45.26)."""
    if "storyboard" in run:
        tasks.refuse_if_off(ctx.store, ctx.user_id, ctx.ws_id, "storyboard")


def _launch(ctx: Ctx, story: Item, job: Item, *, note: str | None = None) -> tuple[Item, Item]:
    """Moves the story to ``producing`` with the new job, in one transaction with the job's item, then starts it."""
    _writer_on(ctx, list((job.get("configuration") or {}).get("run") or []))
    sets: Item = {
        "status": "producing",
        "statusBefore": story.get("status") or "draft",
        "currentJobId": job["jobId"],
        "lastJobId": job["jobId"],
        "updatedAt": ctx.at(),
    }
    if note:
        sets["reviewNote"] = note
    update = Update(ctx.pk, str(story["sk"]), sets=sets).bump()
    update.equals("version", story.get("version")).one_of("status", stories.REMAKE_STATUSES)
    update.absent_or_null("currentJobId")
    try:
        ctx.store.transact(puts=[job], updates=[update.request()])
    except db.ConditionFailed as e:
        raise conflict(stories.CHANGED) from e
    return _start(ctx, _reread_story(ctx, story), job)


def list_stories(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    status = req.query.get("status") or "all"
    if status != "all" and status not in shapes.STORY_STATUSES:
        raise bad_request("status must be a story status or all.")
    limit = validate.query_int(req.query, "limit", default=20, lo=1, hi=50)

    def keep(item: Item) -> bool:
        return ctx.owned(item, ws.TYPE_STORY) is not None and (status == "all" or item.get("status") == status)

    items, cursor = library.filtered_page(
        ctx.store, ctx.pk, ws.STORY_SK, keep, limit=limit, cursor=req.query.get("cursor")
    )
    out = []
    for found in items:
        story = _settled(ctx, found)[0] if found.get("status") == "producing" else found
        out.append(_public_story(ctx, story))
    return ok({"stories": out, "nextCursor": cursor})


def _check_references(ctx: Ctx, ids: list[str]) -> None:
    """Each reference video is this workspace's own ``REFVID#`` (builder A2's items, only read here)."""
    if not ids:
        return
    found = ctx.store.batch_get([(ctx.pk, f"{ws.REFVID_SK}{r}") for r in ids])
    owned = {i.get("refId") for i in (ctx.owned(f, ws.TYPE_REFVID) for f in found) if i is not None}
    if any(r not in owned for r in ids):
        raise bad_request(NO_REFERENCE_VIDEO, "referenceIds")


def _default_format(config: Mapping[str, Any]) -> Item:
    """The workspace's default size and shape (Settings › Video), as a story's ``format`` (§45.34)."""
    video = config.get("video") if isinstance(config.get("video"), Mapping) else {}
    return stories.format_of((video or {}).get("aspect"), (video or {}).get("resolution"))


def _refuse_not_ready(ctx: Ctx) -> None:
    """409 with the maker's own sentence while the picked video maker is not ready (§45.34): nothing switches to
    another maker by itself. The picture maker never stops a video (§45.35 D3: it gates portraits only)."""
    sentence = providers.not_ready(ctx.config, _all(ctx, ws.PROVIDER_SK, ws.TYPE_PROVIDER))
    if sentence:
        raise conflict(sentence)


def create_story(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    fields = stories.story_input(req.json())
    _refuse_not_ready(ctx)
    cast = _check_characters(ctx, fields["characterIds"])
    _check_references(ctx, fields["referenceIds"])
    _refuse_unusable(ctx, project=fields["ai"], field="ai")
    config = ctx.config
    g = guidance.load()
    idea: Item | None = None
    if "ideaId" in fields:
        idea = _get(ctx, ws.IDEA_SK, fields["ideaId"], ws.TYPE_IDEA, NO_IDEA)
        brief: Item = {"title": idea.get("title"), "logline": idea.get("logline"), "category": idea.get("category")}
        if isinstance(idea.get("concept"), Mapping):
            brief["concept"] = idea["concept"]
        topic = idea.get("safetyTopicId") if idea.get("category") == "driving_safety" else None
    else:
        brief = dict(fields["brief"])
        topic = guidance.match(g, [brief["title"], brief["logline"]]) if brief["category"] == "driving_safety" else None
    if idea is not None and idea.get("category") == "driving_safety" and not topic:
        topic = guidance.match(g, ideas.idea_texts(idea))  # the concept's words count too (an Expand put them there)
    category = str(brief.get("category") or "explainer")
    if category == "driving_safety" and not topic:
        raise ApiError(409, "conflict", guidance.NO_GUIDANCE, extra={"topics": guidance.topic_choices(g)})
    concept = brief.get("concept") if isinstance(brief.get("concept"), Mapping) else {}
    duration = fields.get("durationSec") or (concept or {}).get("durationSec") or config["defaultDurationSec"]
    mood = fields.get("musicMood") or (stories.DEFAULT_MOOD.get(category, "calm") if config.get("musicOn") else "none")
    story_id = ulid()
    story: Item = {
        "pk": ctx.pk,
        "sk": jobs.story_sk(story_id),
        "type": ws.TYPE_STORY,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "storyId": story_id,
        "contentType": "animation",
        "title": fields.get("title") or str(brief.get("title") or "")[: ideas.TITLE_MAX],
        "status": "draft",
        "category": category,
        "ideaId": idea["ideaId"] if idea else None,
        "characterIds": [c["characterId"] for c in cast],
        "durationSec": int(duration),
        "captionsOn": fields.get("captionsOn", config.get("captionsOn", True)),
        "musicMood": mood,
        "postCaptions": shapes.empty_captions(),
        "scenes": [],
        "scriptVersion": 0,
        "stale": [],
        "safetyTopicId": topic,
        "posted": [],
        "brief": brief,
        "ai": fields["ai"],
        "referenceIds": fields["referenceIds"],
        "format": fields.get("format") or _default_format(config),
        "version": 1,
        "createdAt": ctx.at(),
        "updatedAt": ctx.at(),
    }
    run = list(shapes.STEP_ORDER)
    _writer_on(ctx, run)
    job = _story_job(
        ctx,
        story,
        job_type="produce",
        run=run,
        from_step=None,
        scene_ids=None,
        note=None,
        story_version=1,
        override=fields["override"],
    )
    story.update(
        {"status": "producing", "statusBefore": "draft", "currentJobId": job["jobId"], "lastJobId": job["jobId"]}
    )
    updates = []
    if idea is not None:
        use = Update(ctx.pk, idea["sk"], sets={"status": "used", "updatedAt": ctx.at()})
        use.adds["storyIds"] = {story_id}
        updates.append(use.equals("userId", ctx.user_id).request())
    try:
        ctx.store.transact(puts=[story, job], updates=updates)
    except db.ConditionFailed as e:
        raise conflict("That idea changed meanwhile. Try again.") from e
    story, job = _start(ctx, story, job)
    return ok({"story": _public_story(ctx, story), "job": shapes.public_job(job)}, 201)


def get_story(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story, job = _settled(ctx, _story(ctx))
    return ok(
        {
            "story": _public_story(ctx, story),
            "job": shapes.public_job(job) if job else None,
            "script": _read_script(ctx, story),
        }
    )


def story_jobs(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story = _story(ctx)
    out = []
    for found in _all(ctx, ws.PJOB_SK, ws.TYPE_PJOB, newest_first=True):
        if found.get("contentType") != "animation" or found.get("contentId") != story["storyId"]:
            continue
        job = jobs.settle(ctx.store, found, ctx.now, stop=ctx.stop()) if jobs.is_stale(found, ctx.now) else found
        out.append(shapes.public_job(job or found))
    return ok({"jobs": out})


def _merge_owner(story: Mapping[str, Any], owner: Mapping[str, list[str]]) -> Item | None:
    """The owner's own text (never rewritten by the fact check, §45.11.5), kept per story."""
    if not any(owner.values()):
        return None
    current = story.get("ownerEdits") if isinstance(story.get("ownerEdits"), Mapping) else {}
    return {k: sorted(set((current or {}).get(k) or []) | set(v)) for k, v in owner.items()}


def patch_story(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story = _story(ctx)
    patch = stories.patch_input(req.json())
    if "referenceIds" in patch:
        _check_references(ctx, patch["referenceIds"])
    if "ai" in patch and patch["ai"] != shapes.ai_setting(story.get("ai")):  # only a changed setting is checked
        _refuse_unusable(ctx, project=patch["ai"], field="ai")
    story, job = _settled(ctx, story)
    if jobs.active(job) or story.get("currentJobId") or story.get("status") == "producing":
        raise conflict(stories.BUSY)
    if int(story.get("version") or 1) != patch["version"]:
        raise conflict(stories.CHANGED)
    if story.get("status") not in stories.EDIT_STATUSES:
        raise conflict("You can change a video once it is made and before it is approved.")
    script = _read_script(ctx, story, required=True) if stories.needs_script(story, patch) else None
    new_script, sets, stale_add, stale_scenes, owner = stories.apply_patch(story, script, patch)
    if not sets and new_script is None:
        return ok({"story": _public_story(ctx, story), "script": script or _read_script(ctx, story)})
    update = Update(ctx.pk, story["sk"], sets={**sets, "updatedAt": ctx.at()})
    key = ""
    if new_script is not None:
        number = int(story.get("scriptVersion") or 0) + 1
        key = f"{shapes.story_prefix(ctx.user_id, ctx.ws_id, story['storyId'])}script/v{number}.json"
        update.sets.update({"scriptVersion": number, "scriptKey": key})
    if stale_add:
        update.sets["stale"] = shapes.ordered_steps([*(story.get("stale") or []), *stale_add])
        if "safety" in stale_add and isinstance(story.get("safety"), Mapping):
            update.sets["safety"] = {**story["safety"], "status": "pending"}
    if new_script is not None and "safety" not in stale_add:
        carried = stories.carried_check(story, int(update.sets["scriptVersion"]))
        if carried is not None:
            update.sets["safety"] = carried
    _edit_bookkeeping(update, story, stale_scenes, owner)
    update.bump().equals("version", patch["version"]).one_of("status", stories.EDIT_STATUSES)
    update.absent_or_null("currentJobId")
    try:
        item = update.run(ctx.store)  # first win the version, so two edits at once never share v{n+1}
    except db.ConditionFailed as e:
        raise conflict(stories.CHANGED) from e
    if new_script is not None:
        data = json.dumps(new_script, ensure_ascii=False).encode()
        try:
            app.media.put(key, data, "application/json")
        except Exception as e:
            _undo_patch(ctx, story, item, list(update.sets))
            log("warning", "stories.script_write_failed", storyId=story["storyId"], error=type(e).__name__)
            raise ApiError(503, "platform_down", "We could not save the change just now. Try again.") from e
        _register_script(ctx, story, key, int(item.get("scriptVersion") or 0), len(data))
    return ok({"story": _public_story(ctx, item), "script": new_script or script or _read_script(ctx, item)})


def _edit_bookkeeping(
    update: Update, story: Mapping[str, Any], stale_scenes: set[str], owner: Mapping[str, list[str]]
) -> None:
    """The scenes whose animation the edit made stale, and the ids of the text the owner wrote himself."""
    if stale_scenes:
        known = jobs.valid_stale_scenes(story)
        whole = "animation" in (story.get("stale") or []) and not known
        if not whole:
            update.sets["staleScenes"] = sorted(set(known) | stale_scenes)
    edits = _merge_owner(story, owner)
    if edits is not None:
        update.sets["ownerEdits"] = edits


def _register_script(ctx: Ctx, story: Mapping[str, Any], key: str, number: int, size: int) -> None:
    """The owner's storyboard version becomes the Library's current storyboard (§45.12): a new ``ASSET#`` with
    ``meta.current = 1``, and the older ones kept with ``meta.current = 0``. Best effort: the story and its file are
    already saved, so a refused write only leaves the Library one version behind."""
    story_id = str(story["storyId"])
    older = [
        a
        for a in _all(ctx, ws.ASSET_SK, ws.TYPE_ASSET)
        if a.get("storyId") == story_id
        and a.get("kind") == "storyboard"
        and int(((a.get("meta") or {}) if isinstance(a.get("meta"), Mapping) else {}).get("current", 1) or 0) == 1
    ]
    asset_id = ulid()
    asset = {
        "pk": ctx.pk,
        "sk": f"{ws.ASSET_SK}{asset_id}",
        "type": ws.TYPE_ASSET,
        "userId": ctx.user_id,
        "workspaceId": ctx.ws_id,
        "assetId": asset_id,
        "kind": "storyboard",
        "storyId": story_id,
        "characterId": None,
        "key": key,
        "contentType": "application/json",
        "bytes": size,
        "version": number,
        "meta": {"current": 1, "by": "owner"},
        "createdAt": ctx.at(),
    }
    retire = [
        Update(ctx.pk, str(a["sk"]), sets={"meta": {**dict(a.get("meta") or {}), "current": 0}})
        .equals("userId", ctx.user_id)
        .request()
        for a in older[: db.MAX_TRANSACT_ITEMS - 1]
    ]
    try:
        ctx.store.transact(puts=[asset], updates=retire)
    except Exception as e:
        log("warning", "stories.script_asset_failed", storyId=story_id, error=type(e).__name__)


def _undo_patch(ctx: Ctx, before: Mapping[str, Any], after: Mapping[str, Any], fields: list[str]) -> None:
    """The new script could not be written: every field the edit set goes back to what it was (best effort)."""
    undo = Update(ctx.pk, str(before["sk"]), sets={"updatedAt": ctx.at()})
    for name in fields:
        if name == "updatedAt":
            continue
        if before.get(name) is None:
            undo.removes.append(name)
        else:
            undo.sets[name] = before[name]
    with contextlib.suppress(db.ConditionFailed):
        undo.bump().equals("version", after.get("version")).run(ctx.store)


def _tell_agent(ctx: Ctx, job: Mapping[str, Any], *, wind_down: bool) -> None:
    """After the cancel: the run's ``cancel`` (``wind_down``), then its session stopped outright; once each, best
    effort, and only while the request has time (a slow ``cancel`` leaves the stop to the fence)."""
    agent = ctx.deps.agent
    if agent is None or not getattr(agent, "ready", False):
        return
    session_id, job_id = str(job["sessionId"]), str(job["jobId"])
    calls: list[tuple[str, Callable[[], None]]] = [("stop", lambda: agent.stop_session(session_id, attempts=1))]
    if wind_down:
        calls.insert(0, ("cancel", lambda: agent.cancel(job_id, session_id, attempts=1)))
    for name, call in calls:
        if not ctx.time_for_call():
            log("info", "stories.cancel_call_skipped", jobId=job_id, call=name)
            return
        try:
            call()
        except Exception as e:
            log("warning", "stories.cancel_call_failed", jobId=job_id, call=name, error=type(e).__name__)


def _stop_job(ctx: Ctx, story: Item, job: Item | None, *, wind_down: bool = True) -> tuple[Item, Item | None]:
    """Cancels a running job (its writes fenced out by a new sessionId), then tells the agent (best effort,
    ``_tell_agent``). A cancel refused because the run wrote meanwhile is tried again on what is stored now."""
    if job is None or not jobs.active(job):
        return story, job
    canceled = None
    for _ in range(CANCEL_ATTEMPTS):
        if jobs.cancel(ctx.store, job, story, ctx.now):
            canceled = job
            break
        story = _reread_story(ctx, story)
        found = ctx.owned(ctx.store.get(ctx.pk, str(job["sk"])), ws.TYPE_PJOB)
        if found is None or not jobs.active(found):
            break
        job = found
    if canceled is not None:
        _tell_agent(ctx, canceled, wind_down=wind_down)
    return _reread_story(ctx, story), ctx.owned(ctx.store.get(ctx.pk, str(job["sk"])), ws.TYPE_PJOB)


def delete_story(app: App, req: Request) -> Response:
    """The running job is canceled and its session stopped outright, not sent a ``cancel`` whose wind-down would
    write again; the stop comes before the files go, while the request keeps time for the deletes after it."""
    ctx = _ctx(app, req)
    ctx.reserve = DELETE_RESERVE_SECONDS
    story, job = _settled(ctx, _story(ctx))
    story, _ = _stop_job(ctx, story, job, wind_down=False)
    story_id = story["storyId"]
    story_jobs_items = [
        j
        for j in _all(ctx, ws.PJOB_SK, ws.TYPE_PJOB)
        if j.get("contentType") == "animation" and j.get("contentId") == story_id
    ]
    assets = [a for a in _all(ctx, ws.ASSET_SK, ws.TYPE_ASSET) if a.get("storyId") == story_id]
    for found in story_jobs_items:
        ctx.store.delete(ctx.pk, found["sk"])
    app.media.delete_prefix(shapes.story_prefix(ctx.user_id, ctx.ws_id, story_id))
    for asset in assets:
        ctx.store.delete(ctx.pk, asset["sk"])
    ctx.store.delete(ctx.pk, story["sk"])
    if story.get("ideaId"):
        forget = Update(ctx.pk, f"{ws.IDEA_SK}{story['ideaId']}", sets={"updatedAt": ctx.at()})
        forget.deletes["storyIds"] = {story_id}
        with contextlib.suppress(db.ConditionFailed):  # the idea was deleted already
            forget.equals("userId", ctx.user_id).run(ctx.store)
    return no_content()


def _ready_to_remake(ctx: Ctx, story: Item) -> tuple[Item, Item | None]:
    story, job = _settled(ctx, story)
    if jobs.active(job) or story.get("status") == "producing":
        raise conflict(stories.BUSY)
    if story.get("status") not in stories.REMAKE_STATUSES:
        raise conflict("This video can't be remade now.")
    _require_topic(story)
    return story, job


def produce(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    with ctx.stops_last():  # the fence's stops wait: the start may need the whole 29 s
        story = _story(ctx)
        from_step, scene_ids, override = stories.produce_input(req.json(), story)
        _refuse_not_ready(ctx)
        story, last = _ready_to_remake(ctx, story)
        again = stories.changes_again(story, last) if from_step is None else None
        if again is not None:  # "Try again" after an "Ask for changes" or "Remake this scene" that did not finish
            note, chosen = again
            job = _story_job(
                ctx,
                story,
                job_type="changes",
                run=shapes.ordered_steps(story.get("stale") or []),
                from_step="storyboard",
                scene_ids=chosen,
                note=note,
                story_version=int(story.get("version") or 0) + 1,
                override=override,
            )
            story, job = _launch(ctx, story, job, note=note)
            return ok({"story": _public_story(ctx, story), "job": shapes.public_job(job)}, 202)
        run, scenes = stories.produce_run(story, from_step, scene_ids)
        job = _story_job(
            ctx,
            story,
            job_type="produce",
            run=run,
            from_step=from_step if stories.has_script(story) else None,
            scene_ids=scenes,
            note=None,
            story_version=int(story.get("version") or 0) + 1,
            override=override,
        )
        story, job = _launch(ctx, story, job)
        return ok({"story": _public_story(ctx, story), "job": shapes.public_job(job)}, 202)


def request_changes(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    with ctx.stops_last():  # the fence's stops wait: the start may need the whole 29 s
        story = _story(ctx)
        note, scene_ids, override = stories.changes_input(req.json(), story)
        _refuse_not_ready(ctx)
        story, _ = _ready_to_remake(ctx, story)
        if not stories.has_script(story):
            raise conflict(stories.NO_SCRIPT)
        job = _story_job(
            ctx,
            story,
            job_type="changes",
            run=list(shapes.STEP_ORDER),
            from_step="storyboard",
            scene_ids=scene_ids,
            note=note,
            story_version=int(story.get("version") or 0) + 1,
            override=override,
        )
        story, job = _launch(ctx, story, job, note=note)
        activity.record(ctx.store, ctx.user_id, ctx.ws_id, "changes", story, now=ctx.now)
        return ok({"story": _public_story(ctx, story), "job": shapes.public_job(job)}, 202)


def story_captions(app: App, req: Request) -> Response:
    """Review's **Write them again** (§45.11.2): the storyboard agent drafts the six post captions from the current
    script, ``202 { task }``; the draft is in ``result.postCaptions`` (the agent's key, the same name as the story's
    field) and is saved only through PATCH (``StoryPatch.postCaptions``)."""
    ctx = _ctx(app, req)
    story = _story(ctx)
    body = req.json()
    validate.only_keys(body, {"override"})
    override = overrides.model_override(body.get("override"))
    if not stories.has_script(story):
        raise conflict(stories.NO_SCRIPT)
    task_input = {"storyId": story["storyId"], "scriptVersion": int(story.get("scriptVersion") or 0)}
    return _task_reply(ctx, "captions", task_input, override, project=story.get("ai"))


def cancel_story(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story, job = _settled(ctx, _story(ctx))
    if job is not None and story.get("currentJobId") == job.get("jobId"):
        story, job = _stop_job(ctx, story, job)
    return ok({"story": _public_story(ctx, story), "job": shapes.public_job(job) if job else None})


def approve(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story = _story(ctx)
    body = req.json()
    validate.only_keys(body, {"version"})
    version = validate.integer(body.get("version"), "version", lo=1, hi=10**9)
    story, _ = _settled(ctx, story)
    if int(story.get("version") or 1) != version:
        raise conflict(stories.CHANGED)
    problem = stories.approve_problem(story)
    if problem:
        raise conflict(problem)
    update = Update(ctx.pk, story["sk"], sets={"status": "approved", "approvedAt": ctx.at(), "updatedAt": ctx.at()})
    try:
        item = update.bump().equals("version", version).equals("status", "review").run(ctx.store)
    except db.ConditionFailed as e:
        raise conflict(stories.CHANGED) from e
    activity.record(ctx.store, ctx.user_id, ctx.ws_id, "approved", item, now=ctx.now)
    return ok({"story": _public_story(ctx, item)})


def reject(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story = _story(ctx)
    body = req.json()
    validate.only_keys(body, {"reason"})
    reason = validate.string(body, "reason", required=False, max_len=stories.NOTE_MAX)
    story, _ = _settled(ctx, story)
    if story.get("status") not in stories.REJECT_STATUSES:
        raise conflict("Only a video that is waiting for review can be rejected.")
    update = Update(ctx.pk, story["sk"], sets={"status": "rejected", "updatedAt": ctx.at()})
    if reason:
        update.sets["reviewNote"] = reason
    try:
        item = update.bump().one_of("status", stories.REJECT_STATUSES).absent_or_null("currentJobId").run(ctx.store)
    except db.ConditionFailed as e:
        raise conflict(stories.CHANGED) from e
    activity.record(ctx.store, ctx.user_id, ctx.ws_id, "rejected", item, now=ctx.now)
    return ok({"story": _public_story(ctx, item)})


DOWNLOAD_FORMATS = ("mp4", "webm", "mov")
NO_FORMAT = "That format was not made for this video."


def _format_key(ctx: Ctx, story: Mapping[str, Any], video_key: str, fmt: str) -> str:
    """The key of the story's current video in ``fmt``: the MP4 itself, or the ``final/v{n}.{fmt}`` made beside it
    (an ``ASSET#`` of the story with ``meta.format``, §45.34); 404 when that format was not made."""
    if fmt == "mp4":
        return video_key
    wanted = video_key.rsplit(".", 1)[0] + f".{fmt}"
    for asset in _all(ctx, ws.ASSET_SK, ws.TYPE_ASSET):
        meta = asset.get("meta") if isinstance(asset.get("meta"), Mapping) else {}
        if (
            asset.get("storyId") == story.get("storyId")
            and asset.get("kind") in ("final_video", "video")
            and (meta or {}).get("format") == fmt
            and asset.get("key") == wanted
        ):
            return wanted
    raise not_found(NO_FORMAT)


def download(app: App, req: Request) -> Response:
    """The finished video as a file: MP4 (the default), or WebM or MOV when Settings made them (§45.34). GET takes
    ``?format=``, POST ``{ format? }``."""
    ctx = _ctx(app, req)
    story = _story(ctx)
    if req.method == "POST":
        body = req.json()
        validate.only_keys(body, {"format"})
        fmt = body.get("format") if body.get("format") is not None else "mp4"
    else:
        fmt = req.query.get("format") or "mp4"
    if fmt not in DOWNLOAD_FORMATS:
        raise bad_request("format must be mp4, webm or mov.", "format")
    if story.get("status") not in stories.DOWNLOAD_STATUSES:
        raise conflict("Approve the video first, then download it.")
    key = story.get("videoKey")
    if not isinstance(key, str) or not key.startswith(shapes.story_prefix(ctx.user_id, ctx.ws_id, story["storyId"])):
        raise conflict("The video file is missing. Tap Remake the whole video.")
    key = _format_key(ctx, story, key, str(fmt))
    filename = f"{media.slug(str(story.get('title') or ''))}.{fmt}"
    url = media.presign_download(media.client(ctx.deps), app.media.bucket, key, filename)
    return ok({"url": url, "filename": filename})


# --- library, providers, guidance, dashboard ------------------------------------------------------------------


def get_library(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    kind = req.query.get("kind") or "all"
    if kind != "all" and kind not in shapes.ASSET_KINDS:
        raise bad_request("kind must be a file kind or all.")
    story_id = req.query.get("storyId") or None
    character_id = req.query.get("characterId") or None
    for value, name in ((story_id, "storyId"), (character_id, "characterId")):
        if value is not None and not is_ulid(value):
            raise bad_request(f"{name} is not valid.")
    limit = validate.query_int(req.query, "limit", default=50, lo=1, hi=100)
    keep = library.asset_filter(
        ctx.user_id, ctx.ws_id, kind=None if kind == "all" else kind, story_id=story_id, character_id=character_id
    )
    items, cursor = library.filtered_page(
        ctx.store, ctx.pk, ws.ASSET_SK, keep, limit=limit, cursor=req.query.get("cursor")
    )
    return ok(
        {"items": library.library_items(ctx.store, ctx.presign, ctx.user_id, ctx.ws_id, items), "nextCursor": cursor}
    )


def get_providers(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    records = _all(ctx, ws.PROVIDER_SK, ws.TYPE_PROVIDER)
    found = ctx.store.query_all(ctx.pk, ws.PJOB_SK, newest_first=True, cap=providers.JOBS_READ)
    story_jobs = [j for j in (ctx.owned(x, ws.TYPE_PJOB) for x in found) if j is not None]
    model_statuses = _all(ctx, ws.MODELSTATUS_SK, ws.TYPE_MODELSTATUS)
    checks = {p: _check_job(ctx, story_jobs, p) for p in providers.CHECKABLE}
    if any(j is not None and j.get("status") == "ready" for j in checks.values()):
        records = _all(ctx, ws.PROVIDER_SK, ws.TYPE_PROVIDER)  # a check that just ended wrote its proof first
    shown = providers.statuses(ctx.config, records, story_jobs, model_statuses)
    for row in shown:
        if row["id"] in checks:  # "Try it" (§45.35 D2): its newest job, so Settings › Video shows how it went
            job = checks[row["id"]]
            row["check"] = shapes.public_job(job) if job is not None else None
    shown += provider_keys.statuses(ctx.store, ctx.user_id, ctx.ws_id)  # each with its ``key`` (§45.34)
    return ok({"providers": shown})


def _check_job(ctx: Ctx, found: list[Item], provider_id: str) -> Item | None:
    """The newest "Try it" job of the maker (after the stale-heartbeat fence), or None."""
    job = providers.check_job_of(found, provider_id)
    return jobs.settle(ctx.store, job, ctx.now, stop=ctx.stop()) if job is not None else None


def check_provider(app: App, req: Request) -> Response:
    """``POST …/providers/nova-reel/check`` → ``202 { job }`` (§45.35 D2, "Try it" in Settings › Video): a one-step
    ``provider_check`` job; Lamo Stories' agent makes one 6-second test shot (Amazon bills it), proves
    ``PROVIDER#animation#nova-reel`` or records Bedrock's sentence, and deletes the test file. Never behind the
    not-ready guard (that is how the maker becomes ready), and one at a time."""
    ctx = _ctx(app, req)
    provider_id = "nova-reel"
    validate.only_keys(req.json(), ())
    with ctx.stops_last():  # the fence's stops wait: the start may need the whole 29 s
        newest = ctx.store.query_page(ctx.pk, ws.PJOB_SK, newest_first=True, limit=CHECK_JOBS_READ).items
        previous = _check_job(ctx, [j for j in (ctx.owned(x, ws.TYPE_PJOB) for x in newest) if j], provider_id)
        if jobs.active(previous):
            raise conflict(providers.CHECK_BUSY)
        job_id = ulid()
        job = jobs.new_job(
            ctx.user_id,
            ctx.ws_id,
            job_id=job_id,
            content_type=providers.CHECK_CONTENT_TYPE,
            content_id=provider_id,
            job_type=providers.CHECK_JOB_TYPE,
            run=[providers.CHECK_STEP],
            steps=[{"key": providers.CHECK_STEP, "label": shapes.STEP_LABEL["check"], "status": "pending"}],
            now=ctx.now,
            meta={"providers": {providers.CHECKABLE[provider_id]: provider_id}},
        )
        ctx.store.put(job, if_absent=True)
        agent = ctx.deps.agent
        if agent is None or not getattr(agent, "ready", False):
            failed = jobs.fail_start(ctx.store, job, None, ctx.now, jobs.CHECK_NOT_SET_UP)
            return ok({"job": shapes.public_job(failed)}, 202)
        try:
            agent.start_provider_check(
                user_id=ctx.user_id,
                workspace_id=ctx.ws_id,
                provider_id=provider_id,
                job_id=job_id,
                session_id=job["sessionId"],
            )
        except Exception as e:
            log("warning", "stories.provider_check_start_failed", jobId=job_id, error=type(e).__name__)
            session_id = str(job["sessionId"])
            job = jobs.fail_start(ctx.store, job, None, ctx.now, jobs.CHECK_NOT_STARTED)
            _stop_after_failed_start(ctx, session_id)
        log("info", "stories.provider_check_started", jobId=job_id, provider=provider_id)
        return ok({"job": shapes.public_job(job)}, 202)


def get_guidance(app: App, req: Request) -> Response:
    _ctx(app, req)
    g = guidance.load()
    return ok({"topics": [guidance.public_topic(g, t) for t in g.topics], "checkedAt": g.checked_at})


def get_dashboard(app: App, req: Request) -> Response:
    ctx = _ctx(app, req)
    story_items = []
    current_jobs: dict[str, Item] = {}
    for found in _all(ctx, ws.STORY_SK, ws.TYPE_STORY, newest_first=True):
        story = found
        if found.get("status") == "producing":
            story, job = _settled(ctx, found)
            if job is not None:
                current_jobs[str(job["jobId"])] = job
        story_items.append(story)
    activity_page = ctx.store.query_page(ctx.pk, ws.ACT_SK, newest_first=True, limit=dashboard.ACTIVITY_SHOWN * 2)
    recent = [a for a in (ctx.owned(x, ws.TYPE_ACTIVITY) for x in activity_page.items) if a is not None]
    built = dashboard.build(
        story_items,
        current_jobs,
        _all(ctx, ws.PUBJOB_SK, ws.TYPE_PUBJOB),
        _all(ctx, ws.SOCIAL_SK, ws.TYPE_SOCIAL),
        recent,
    )
    return ok({"dashboard": built})


BASE = "/v1/workspaces"
W = BASE + "/{ws}"

ROUTES: list[Route] = [
    route("GET", BASE, list_workspaces),
    route("POST", BASE, create_workspace),
    route("GET", W, get_workspace),
    route("PATCH", W, patch_workspace),
    route("GET", W + "/dashboard", get_dashboard),
    route("GET", W + "/ideas", list_ideas),
    route("POST", W + "/ideas", create_idea),
    # Before "/ideas/{ideaId}" so "generate" never reads as an idea id.
    route("POST", W + "/ideas/generate", generate_ideas),
    route("PATCH", W + "/ideas/{ideaId}", patch_idea),
    route("DELETE", W + "/ideas/{ideaId}", delete_idea),
    route("POST", W + "/ideas/{ideaId}/expand", expand_idea),
    route("POST", W + "/ideas/{ideaId}/variations", idea_variations),
    route("GET", W + "/tasks/{taskId}", get_task),
    route("GET", W + "/characters", list_characters),
    route("POST", W + "/characters", create_character),
    # Before "/characters/{characterId}…" so "design" never reads as a character id.
    route("POST", W + "/characters/design/uploads", design_upload),
    route("POST", W + "/characters/design", design_character),
    route("GET", W + "/characters/{characterId}", get_character),
    route("PUT", W + "/characters/{characterId}", put_character),
    route("DELETE", W + "/characters/{characterId}", delete_character),
    route("POST", W + "/characters/{characterId}/references", reference_upload),
    route("POST", W + "/characters/{characterId}/references/{assetId}/complete", reference_complete),
    route("DELETE", W + "/characters/{characterId}/references/{assetId}", reference_delete),
    route("POST", W + "/characters/{characterId}/portrait", make_portrait),
    route("GET", W + "/stories", list_stories),
    route("POST", W + "/stories", create_story),
    route("GET", W + "/stories/{storyId}", get_story),
    route("GET", W + "/stories/{storyId}/jobs", story_jobs),
    route("PATCH", W + "/stories/{storyId}", patch_story),
    route("DELETE", W + "/stories/{storyId}", delete_story),
    route("POST", W + "/stories/{storyId}/produce", produce),
    route("POST", W + "/stories/{storyId}/cancel", cancel_story),
    route("POST", W + "/stories/{storyId}/approve", approve),
    route("POST", W + "/stories/{storyId}/reject", reject),
    route("POST", W + "/stories/{storyId}/changes", request_changes),
    route("POST", W + "/stories/{storyId}/captions", story_captions),
    route("GET", W + "/stories/{storyId}/download", download),
    route("POST", W + "/stories/{storyId}/download", download),
    route("GET", W + "/library", get_library),
    route("GET", W + "/providers", get_providers),
    route("POST", W + "/providers/nova-reel/check", check_provider),
    route("GET", W + "/guidance", get_guidance),
]
