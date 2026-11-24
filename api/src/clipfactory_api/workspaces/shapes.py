"""The public shapes of workspace items (docs/CONTRACTS.md §45.6) and the production steps (§45.9).

Each function lists exactly the fields of its shape, so internal attributes (``scriptKey``, ``videoKey``,
``sessionId``, ``key`` ...) never reach a response. Presigned links are made only for keys under the workspace's
own ``ws/{userId}/{workspaceId}/`` prefix (``safe_url``); anything else is left out.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any, Final

from . import captions, guard, own_script
from . import types as ws

STEP_ORDER: Final = ("storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview")
STEP_LABEL: Final = {
    "storyboard": "Write the story",
    "safety": "Check the facts",
    "scenes": "Draw the scenes",
    "animation": "Animate",
    "sound": "Add sounds and music",
    "captions": "Add captions",
    "assemble": "Put it together",
    "preview": "Ready to watch",
    "portrait": "Draw the picture",
    "check": "Try it",  # a provider_check job's one step (§45.35 D2)
}
# A video made from the owner's own script (§45.46): its steps say what really happens (it stages their script).
OWN_STEP_LABEL: Final = {"storyboard": "Your script", "captions": "Add your words"}
STORY_STATUSES: Final = ("draft", "producing", "needs_check", "review", "approved", "rejected", "published", "failed")
CATEGORIES: Final = ("driving_safety", "everyday_skills", "comedy", "explainer")
ASSET_KINDS: Final = (
    "final_video",
    "cover",
    "storyboard",
    "scene_clip",
    "scene_still",
    "character_ref",
    "portrait",
    "audio",
    "captions",
    "design_ref",  # a picture for "Design with AI" (§45.5); the Library hides it
    "video",  # a WebM or MOV copy of a final video (§45.34 "Output formats"; the Library's Videos tab, §45.35 D10)
)
LIBRARY_HIDDEN: Final = frozenset({"design_ref"})
SAFETY_STATUSES: Final = ("pending", "ok", "problems", "skipped")
JOB_ACTIVE: Final = frozenset({"queued", "running"})
STEP_DONE: Final = frozenset({"done", "skipped"})

Presign = Callable[[str], str]

# Video size and shape (§45.34): each aspect's resolutions; 9:16 at 1080 by 1920 is the default.
ASPECTS: Final = {
    "9:16": ("1080x1920", "720x1280"),
    "1:1": ("1080x1080", "720x720"),
    "16:9": ("1920x1080", "1280x720"),
}
DEFAULT_FORMAT: Final = {"aspect": "9:16", "width": 1080, "height": 1920}
# The drawing style (§45.45): Night drive, the default for new videos, or Bright (``classic``, the first videos' look).
# A story made before it has no ``art`` and is drawn Bright.
ARTS: Final = ("night_drive", "classic")
DEFAULT_ART: Final = "night_drive"
PICK_ART: Final = "Pick a drawing style: Night drive or Bright."


def stored_art(story: Mapping[str, Any]) -> str:
    """A story's drawing style: its own ``art``, else ``classic`` (a story made before drawing styles)."""
    art = story.get("art")
    return str(art) if art in ARTS else "classic"


def format_of(aspect: Any, resolution: Any) -> dict[str, Any]:
    """``{aspect, width, height}`` of an aspect and a ``WxH`` resolution (the default when it is not a known pair)."""
    if aspect in ASPECTS and resolution in ASPECTS[str(aspect)]:
        width, height = (int(n) for n in str(resolution).split("x"))
        return {"aspect": str(aspect), "width": width, "height": height}
    return dict(DEFAULT_FORMAT)


def stored_format(story: Mapping[str, Any]) -> dict[str, Any]:
    """A story's ``format`` as stored; an older story without one is 9:16 at 1080 by 1920."""
    found = story.get("format") if isinstance(story.get("format"), Mapping) else None
    if not found:
        return dict(DEFAULT_FORMAT)
    return format_of(found.get("aspect"), f"{found.get('width')}x{found.get('height')}")


def ordered_steps(steps: Iterable[str]) -> list[str]:
    """Step keys once each, in step order (unknown keys dropped)."""
    wanted = set(steps)
    return [s for s in STEP_ORDER if s in wanted]


def safe_url(presign: Presign, user_id: str, workspace_id: str, key: Any) -> str | None:
    """A presigned GET for ``key`` only when it is a file of this workspace (``ws/{userId}/{workspaceId}/…``)."""
    if not isinstance(key, str) or not key.startswith(ws.s3_prefix(user_id, workspace_id)) or ".." in key:
        return None
    return presign(key)


# --- workspace ------------------------------------------------------------------------------------------------


def public_workspace(item: Mapping[str, Any]) -> dict[str, Any]:
    if item.get("workspaceType") == ws.CLIPS or item.get("builtin"):
        return guard.clips_workspace()
    config = guard.default_stories_config()
    stored = item.get("configuration")
    if isinstance(stored, Mapping):
        for key, value in stored.items():
            if key not in config:
                continue  # an older key no longer in StoriesConfig is never shown
            if isinstance(config[key], Mapping) and isinstance(value, Mapping):
                config[key] = {**config[key], **{k: v for k, v in value.items() if k in config[key]}}
            elif not isinstance(config[key], Mapping):
                config[key] = value
    out: dict[str, Any] = {
        "workspaceId": str(item["workspaceId"]),
        "workspaceName": ws.shown_workspace_name(item.get("workspaceName")),
        "workspaceType": str(item.get("workspaceType") or ws.STORIES),
        "builtin": False,
        "configuration": config,
        "version": int(item.get("version") or 1),
    }
    for key in ("createdAt", "updatedAt"):
        if item.get(key):
            out[key] = item[key]
    return out


def stories_config(item: Mapping[str, Any]) -> dict[str, Any]:
    """The workspace's StoriesConfig with defaults filled in."""
    config: dict[str, Any] = public_workspace(item)["configuration"]
    return config


# --- ideas ----------------------------------------------------------------------------------------------------


def public_idea(item: Mapping[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ideaId": str(item["ideaId"]),
        "workspaceId": str(item["workspaceId"]),
        "title": str(item.get("title") or ""),
        "logline": str(item.get("logline") or ""),
        "category": str(item.get("category") or "explainer"),
        "characterIds": list(item.get("characterIds") or []),
        "source": str(item.get("source") or "manual"),
        "status": "used" if item.get("status") == "used" else "saved",
        "safetyTopicId": item.get("safetyTopicId") or None,
        "needsGuidance": bool(item.get("needsGuidance")),
        "storyIds": sorted(item.get("storyIds") or []),
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }
    if isinstance(item.get("concept"), Mapping):
        concept = dict(item["concept"])
        concept.setdefault("lesson", None)
        out["concept"] = concept
    if item.get("parentIdeaId"):
        out["parentIdeaId"] = item["parentIdeaId"]
    if item.get("seriesId"):  # §45.44: left out when the idea is in no series
        out["seriesId"] = str(item["seriesId"])
    return out


# --- characters -----------------------------------------------------------------------------------------------

CHARACTER_FIELDS: Final = (
    "name",
    "description",
    "personality",
    "traits",
    "movementStyle",
    "expressions",
    "look",
    "voice",
    "kind",
    "car",
)


def public_character(
    item: Mapping[str, Any], presign: Presign, user_id: str, *, story_count: int = 0
) -> dict[str, Any]:
    workspace_id = str(item["workspaceId"])
    references = []
    for ref in item.get("references") or []:
        url = safe_url(presign, user_id, workspace_id, ref.get("key"))
        if url:
            shown = {
                "assetId": str(ref["assetId"]),
                "url": url,
                "contentType": str(ref.get("contentType") or ""),
                "createdAt": str(ref.get("createdAt") or ""),
            }
            if ref.get("side") in ("outside", "inside"):  # §45.47: left out means outside
                shown["side"] = str(ref["side"])
            references.append(shown)
    portrait = None
    stored = item.get("portrait")
    if isinstance(stored, Mapping):
        url = safe_url(presign, user_id, workspace_id, stored.get("key"))
        if url:
            portrait = {"assetId": str(stored.get("assetId") or ""), "url": url}
    out: dict[str, Any] = {"characterId": str(item["characterId"]), "workspaceId": workspace_id}
    for key in CHARACTER_FIELDS:
        out[key] = item.get(key)
    out["kind"] = item.get("kind") or "person"  # §45.42: an older item has no kind, so it is a person
    if out["kind"] == "car":
        out.pop("look", None)
    else:
        out.pop("car", None)
    out.update(
        {
            "references": references,
            "portrait": portrait,
            "storyCount": story_count,
            "version": int(item.get("version") or 1),
            "createdAt": str(item.get("createdAt") or ""),
            "updatedAt": str(item.get("updatedAt") or ""),
        }
    )
    return out


# --- stories --------------------------------------------------------------------------------------------------


def empty_captions() -> dict[str, str]:
    return captions.empty()


def storage_location(bucket: str, user_id: str, workspace_id: str, story_id: str) -> str:
    return f"s3://{bucket}/{story_prefix(user_id, workspace_id, story_id)}"


def story_prefix(user_id: str, workspace_id: str, story_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}stories/{story_id}/"


def character_prefix(user_id: str, workspace_id: str, character_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}characters/{character_id}/"


def public_story(item: Mapping[str, Any], presign: Presign, user_id: str, bucket: str) -> dict[str, Any]:
    workspace_id = str(item["workspaceId"])
    story_id = str(item["storyId"])
    stills = item.get("stillKeys") if isinstance(item.get("stillKeys"), Mapping) else {}
    scenes = []
    for scene in item.get("scenes") or []:
        if not isinstance(scene, Mapping):
            continue
        entry: dict[str, Any] = {
            "sceneId": str(scene.get("sceneId") or ""),
            "title": str(scene.get("title") or ""),
            "durationSec": scene.get("durationSec") or 0,
        }
        url = safe_url(presign, user_id, workspace_id, (stills or {}).get(entry["sceneId"]))
        if url:
            entry["stillUrl"] = url
        scenes.append(entry)
    posted = [
        {"platform": str(p.get("platform")), "url": str(p.get("url"))}
        for p in item.get("posted") or []
        if isinstance(p, Mapping) and p.get("platform") and p.get("url")
    ]
    out: dict[str, Any] = {
        "storyId": story_id,
        "workspaceId": workspace_id,
        "contentType": "animation",
        "title": str(item.get("title") or ""),
        "status": str(item.get("status") or "draft"),
        "category": str(item.get("category") or "explainer"),
        "ideaId": item.get("ideaId") or None,
        "characterIds": list(item.get("characterIds") or []),
        "durationSec": item.get("durationSec") or 45,
        "actualDurationSec": item.get("actualDurationSec"),
        "captionsOn": bool(item.get("captionsOn", True)),
        "musicMood": str(item.get("musicMood") or "none"),
        "postCaptions": captions.merged(item.get("postCaptions"), {}),
        "scenes": scenes,
        "scriptVersion": int(item.get("scriptVersion") or 0),
        "storageLocation": storage_location(bucket, user_id, workspace_id, story_id),
        "stale": ordered_steps(item.get("stale") or []),
        "safetyTopicId": item.get("safetyTopicId") or None,
        "safety": _safety(item.get("safety")),
        "reviewNote": item.get("reviewNote") or None,
        "currentJobId": item.get("currentJobId") or None,
        "ai": ai_setting(item.get("ai")),
        "referenceIds": [str(r) for r in item.get("referenceIds") or [] if isinstance(r, str)],
        "format": stored_format(item),
        "art": stored_art(item),
        "posted": posted,
        "version": int(item.get("version") or 1),
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }
    video = safe_url(presign, user_id, workspace_id, item.get("videoKey"))
    if video:
        out["videoUrl"] = video
    cover = safe_url(presign, user_id, workspace_id, item.get("coverKey"))
    if cover:
        out["coverUrl"] = cover
    for key in ("approvedAt", "publishedAt"):
        if item.get(key):
            out[key] = item[key]
    if item.get("seriesId"):  # §45.44: left out when the story is in no series
        out["seriesId"] = str(item["seriesId"])
    if isinstance(item.get("ownScript"), Mapping):  # §45.46: only a video made from the owner's own script
        out["ownScript"] = own_script.public(item["ownScript"])
    roles = public_roles(item.get("roles"))
    if roles:  # §45.47: left out on older videos and when nothing was picked
        out["roles"] = roles
    return out


def public_roles(value: Any) -> dict[str, str] | None:
    """CastRoles ``{mainId, villainId?}`` (§45.47), or None."""
    if not isinstance(value, Mapping) or not isinstance(value.get("mainId"), str) or not value["mainId"]:
        return None
    out = {"mainId": str(value["mainId"])}
    if isinstance(value.get("villainId"), str) and value["villainId"]:
        out["villainId"] = str(value["villainId"])
    return out


# --- video drafts (§45.47) ------------------------------------------------------------------------------------


def public_video_draft(item: Mapping[str, Any]) -> dict[str, Any]:
    """The public ``VideoDraft``: the owner's saved form as it was sent (checked loosely), its name and version."""
    form = dict(item["form"]) if isinstance(item.get("form"), Mapping) else {}
    if form.get("seriesId") == "":  # video_drafts.NO_SERIES_STORED: No series, picked on purpose
        form["seriesId"] = None
    return {
        "draftId": str(item["draftId"]),
        "workspaceId": str(item["workspaceId"]),
        "name": str(item.get("name") or ""),
        "form": form,
        "version": int(item.get("version") or 1),
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }


def ai_setting(value: Any) -> dict[str, Any]:
    """A video's own model and effort (``Story.ai``), ``{model: null, effort: null}`` when it has none."""
    stored = value if isinstance(value, Mapping) else {}
    model, effort = stored.get("model"), stored.get("effort")
    return {
        "model": model if isinstance(model, str) and model else None,
        "effort": effort if isinstance(effort, str) and effort else None,
    }


def _safety(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    status = value.get("status")
    return {
        "topicId": value.get("topicId") or None,
        "status": status if status in SAFETY_STATUSES else "pending",
        "problems": [str(p) for p in value.get("problems") or []],
        "checkedScriptVersion": value.get("checkedScriptVersion"),
        "citations": [dict(c) for c in value.get("citations") or [] if isinstance(c, Mapping)],
    }


# --- production jobs ------------------------------------------------------------------------------------------

META_KEYS: Final = (
    "writerModel",
    "engineVersion",
    "seed",
    "scriptVersion",
    "targetSec",
    "actualSec",
    "safetyTopicId",
)


def progress(steps: Iterable[Mapping[str, Any]], status: str | None = None) -> float:
    """(done and skipped steps + the running step's i/n) ÷ the number of steps (§45.9.1)."""
    steps = list(steps)
    if not steps:
        return 1.0 if status == "ready" else 0.0
    total = 0.0
    for step in steps:
        if step.get("status") in STEP_DONE:
            total += 1
        elif step.get("status") == "running":
            i, n = step.get("i"), step.get("n")
            if isinstance(i, int | float) and isinstance(n, int | float) and n > 0:
                total += max(0.0, min(1.0, float(i) / float(n)))
    return round(min(1.0, total / len(steps)), 4)


def _step(raw: Mapping[str, Any]) -> dict[str, Any]:
    key = str(raw.get("key") or "")
    out: dict[str, Any] = {
        "key": key,
        "label": str(raw.get("label") or STEP_LABEL.get(key, key)),
        "status": str(raw.get("status") or "pending"),
    }
    for name in ("message", "startedAt", "finishedAt", "i", "n"):
        if raw.get(name) is not None:
            out[name] = raw[name]
    return out


def _text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


CALL_FIELDS: Final = ("modelId", "region", "task")


def call_record(item: Mapping[str, Any]) -> dict[str, Any]:
    """What a model call really used, as the agent recorded it (§45.35 D5, on ``meta.models`` entries, ``TASK#`` and
    assistant ``MSG#``): ``modelId`` (the Bedrock model id or inference profile really called), ``region``, the
    ``task`` and ``failed: true`` when the call failed. Each is left out when the agent did not record it (an older
    item, or a call that never started)."""
    out: dict[str, Any] = {name: item[name] for name in CALL_FIELDS if _text_or_none(item.get(name))}
    if item.get("failed") is True:
        out["failed"] = True
    return out


def model_records(value: Any) -> list[dict[str, Any]]:
    """``meta.models`` (§45.25 "Recorded", §45.34, §45.35 D5): per step, the model, its Bedrock id and Region, the
    effort and whether it was really sent, the task, and ``failed: true`` for a step that stopped on its model. An
    older entry without them still shows (without those keys)."""
    out = []
    for entry in value if isinstance(value, list) else []:
        if not isinstance(entry, Mapping) or not isinstance(entry.get("model"), str):
            continue
        effort = entry.get("effort")
        out.append(
            {
                "step": str(entry.get("step") or ""),
                "agentId": str(entry.get("agentId") or ""),
                "model": str(entry["model"]),
                "effort": effort if isinstance(effort, str) else None,
                "effortApplied": bool(entry.get("effortApplied")),
                **call_record(entry),
            }
        )
    return out


_models = model_records


def public_job(item: Mapping[str, Any]) -> dict[str, Any]:
    steps = [_step(s) for s in item.get("steps") or [] if isinstance(s, Mapping)]
    raw_config = item.get("configuration") if isinstance(item.get("configuration"), Mapping) else {}
    config = raw_config or {}
    raw_meta = item.get("meta") if isinstance(item.get("meta"), Mapping) else {}
    meta: dict[str, Any] = {k: (raw_meta or {}).get(k) for k in META_KEYS}
    providers = (raw_meta or {}).get("providers")
    meta["providers"] = {str(k): str(v) for k, v in providers.items()} if isinstance(providers, Mapping) else {}
    meta["models"] = _models((raw_meta or {}).get("models"))
    out: dict[str, Any] = {
        "jobId": str(item["jobId"]),
        "workspaceId": str(item["workspaceId"]),
        "contentType": str(item.get("contentType") or "animation"),
        "contentId": str(item.get("contentId") or ""),
        "jobType": str(item.get("jobType") or "produce"),
        "status": str(item.get("status") or "queued"),
        "steps": steps,
        "progress": progress(steps, str(item.get("status") or "")),
        "configuration": {
            "run": list(config.get("run") or []),
            "from": config.get("from") or None,
            "sceneIds": list(config["sceneIds"]) if isinstance(config.get("sceneIds"), list) else None,
            "note": config.get("note") or None,
        },
        "meta": meta,
        "createdAt": str(item.get("createdAt") or ""),
        "updatedAt": str(item.get("updatedAt") or ""),
    }
    if item.get("error"):
        out["error"] = str(item["error"])
    return out


# --- assets ---------------------------------------------------------------------------------------------------


def public_asset(item: Mapping[str, Any], presign: Presign, user_id: str, *, title: str) -> dict[str, Any] | None:
    """A LibraryItem, or None when its key is not a file of this workspace."""
    url = safe_url(presign, user_id, str(item["workspaceId"]), item.get("key"))
    if url is None:
        return None
    meta = item.get("meta") if isinstance(item.get("meta"), Mapping) else {}
    return {
        "assetId": str(item["assetId"]),
        "kind": str(item.get("kind") or ""),
        "storyId": item.get("storyId") or None,
        "characterId": item.get("characterId") or None,
        "title": title,
        "url": url,
        "contentType": str(item.get("contentType") or ""),
        "bytes": int(item.get("bytes") or 0),
        "version": item.get("version"),
        "createdAt": str(item.get("createdAt") or ""),
        "meta": {str(k): v for k, v in (meta or {}).items() if isinstance(v, str | int | float)},
    }
