"""Lamo Stories' own skills (docs/CONTRACTS.md §45.3 ``SKILL#``, §45.4, §45.5, §45.6 ``Skill``, §45.26, ADR-78).

Two kinds:

* **built-ins**, the ``SKILL.md`` files of ``stories/skills/`` (bundled into the Lambda as
  ``clipfactory_api/stories_skills/``): read-only; the owner may switch one off (a small ``SKILL#{name}`` item
  holds that choice) or take it away from an agent, never change or delete it;
* **the owner's**, written in the app (title, when to use it, instructions) or uploaded as a ``SKILL.md`` (≤ 1 MB)
  or a ``.zip`` (≤ 20 MB) to ``ws/{userId}/{workspaceId}/skills/{skillId}/{revisionId}/``. Every save is a new
  revision; the last 10 are kept and any of them can be restored.

``agentIds`` is derived from the agents' ``skillIds``. Clip Factory's skills (``USER#{userId}`` ``SKILL#`` items, the
``skills/`` prefix, the repository's ``skills/`` folder) are never read: only the pure ``SKILL.md`` and zip helpers
of ``clipfactory_api.skills`` are used, as a library.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from functools import cache
from pathlib import Path
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict, not_found, too_large
from ..ids import is_ulid, ulid
from ..log import log
from ..skills import (
    MD_MAX_BYTES,
    NAME_RE,
    ZIP_MAX_BYTES,
    SkillError,
    SkillTooLarge,
    build_skill_md,
    clean_text,
    decode_text,
    frontmatter_extra,
    humanize,
    parse_form,
    read_frontmatter,
    replace_skill_md_in_zip,
    skill_md_from_zip,
    slug,
)
from . import agents as agents_mod
from . import ai_config as cfg
from . import types as ws

KEEP_REVISIONS: Final = 10
MAX_SKILLS: Final = 50
UPLOAD_SECONDS: Final = 900
FILES: Final = {"md": "SKILL.md", "zip": "skill.zip"}
CONTENT_TYPES: Final = {"md": "text/markdown", "zip": "application/zip"}
LIMITS: Final = {"md": MD_MAX_BYTES, "zip": ZIP_MAX_BYTES}
TITLE_MAX: Final = 60
DESCRIPTION_MIN: Final = 3
DESCRIPTION_MAX: Final = 1024
INSTRUCTIONS_MAX: Final = 50_000
BUILTIN_CREATED_AT: Final = "2026-11-21T00:00:00.000Z"
_ULID: Final = r"[0-7][0-9A-HJKMNP-TV-Z]{25}"

NOT_FOUND: Final = "We could not find that skill."
BUILTIN_LOCKED: Final = "Built-in skills are part of Clips Funded. You can switch one off, but not change or delete it."
STALE: Final = "This skill was changed somewhere else. Load it again, then save."
NO_FILE: Final = "We could not find the uploaded file. Upload it again."
WRONG_FILE: Final = "Pick a SKILL.md file or a .zip."
TOO_MANY: Final = f"You have {MAX_SKILLS} skills already. Delete one first."
BOTH: Final = "Upload a file or change the words, not both at once."


# --- built-ins ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Builtin:
    skill_id: str
    title: str
    description: str
    size: int
    text: str


def builtin_dir() -> Path:
    """The bundled copies in the Lambda; in a checkout, the repository's ``stories/skills`` (never ``skills/``)."""
    packaged = Path(__file__).resolve().parents[1] / "stories_skills"
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[4] / "stories" / "skills"


def _title(text: str, name: str) -> str:
    body = text.split("---", 2)[-1] if text.lstrip().startswith("---") else text
    for line in body.splitlines():
        if line.startswith("# "):
            return line[2:].strip()[:TITLE_MAX] or humanize(name)
    return humanize(name)


@cache
def builtins() -> tuple[Builtin, ...]:
    out = []
    root = builtin_dir()
    for path in sorted(root.glob("*/SKILL.md")) if root.is_dir() else []:
        data = path.read_bytes()
        try:
            text = decode_text(data)
            meta = read_frontmatter(text)
        except SkillError:
            continue  # a broken built-in is a build bug; the build check catches it
        out.append(Builtin(meta.name, _title(text, meta.name), meta.description, len(data), text))
    return tuple(out)


def builtin(skill_id: str) -> Builtin | None:
    return next((b for b in builtins() if b.skill_id == skill_id), None)


# --- keys and items -------------------------------------------------------------------------------------------


def skill_sk(skill_id: str) -> str:
    return f"{ws.SKILL_SK}{skill_id}"


def skill_prefix(user_id: str, workspace_id: str, skill_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}skills/{skill_id}/"


def revision_key(user_id: str, workspace_id: str, skill_id: str, revision_id: str, fmt: str) -> str:
    return f"{skill_prefix(user_id, workspace_id, skill_id)}{revision_id}/{FILES[fmt]}"


def parse_key(key: Any, user_id: str, workspace_id: str, skill_id: str) -> tuple[str, str] | None:
    """``(revisionId, format)`` when ``key`` is an upload key of exactly this skill of this workspace, else None."""
    if not isinstance(key, str):
        return None
    pattern = re.escape(skill_prefix(user_id, workspace_id, skill_id)) + f"({_ULID})/(SKILL\\.md|skill\\.zip)"
    m = re.fullmatch(pattern, key)
    if m is None:
        return None
    return m.group(1), ("zip" if m.group(2) == "skill.zip" else "md")


def valid_id(skill_id: str) -> bool:
    return is_ulid(skill_id) or (bool(NAME_RE.match(skill_id)) and builtin(skill_id) is not None)


def owner_items(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    return cfg.query_owned(store, user_id, workspace_id, ws.SKILL_SK)


def known_ids(store: db.Store, user_id: str, workspace_id: str) -> list[str]:
    """Every skill an agent may be given: the built-ins and the owner's (switched on or off)."""
    owned = [str(i["skillId"]) for i in owner_items(store, user_id, workspace_id) if not i.get("builtin")]
    return [b.skill_id for b in builtins()] + owned


def _agent_ids(skill_id: str, agents: Mapping[str, Mapping[str, Any]]) -> list[str]:
    return [a for a, item in agents.items() if skill_id in (item.get("skillIds") or [])]


def _revisions(item: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [dict(r) for r in item.get("revisions") or [] if isinstance(r, Mapping) and r.get("revisionId")]


def public(item: Mapping[str, Any], agents: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """``Skill`` (§45.6) of an owner's skill; the revision keys stay inside."""
    skill_id = str(item.get("skillId"))
    created = str(item.get("createdAt") or "")
    return {
        "skillId": skill_id,
        "title": str(item.get("title") or humanize(str(item.get("name") or ""))),
        "description": str(item.get("description") or ""),
        "builtin": False,
        "source": "upload" if item.get("source") == "upload" else "written",
        "format": "zip" if item.get("format") == "zip" else "md",
        "enabled": item.get("enabled") is not False,
        "agentIds": _agent_ids(skill_id, agents),
        "revisions": [
            {
                "revisionId": str(r["revisionId"]),
                "savedAt": str(r.get("savedAt") or ""),
                "size": int(r.get("size") or 0),
            }
            for r in _revisions(item)
        ],
        "version": int(item.get("version") or 0),
        "createdAt": created,
        "updatedAt": str(item.get("updatedAt") or created),
    }


def public_builtin(
    b: Builtin, choice: Mapping[str, Any] | None, agents: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    return {
        "skillId": b.skill_id,
        "title": b.title,
        "description": b.description,
        "builtin": True,
        "source": "builtin",
        "format": "md",
        "enabled": (choice or {}).get("enabled") is not False,
        "agentIds": _agent_ids(b.skill_id, agents),
        "revisions": [],
        "version": int((choice or {}).get("version") or 0),
        "createdAt": BUILTIN_CREATED_AT,
        "updatedAt": str((choice or {}).get("updatedAt") or BUILTIN_CREATED_AT),
    }


def list_all(store: db.Store, user_id: str, workspace_id: str, now: datetime) -> list[dict[str, Any]]:
    """Built-ins first (by name), then the owner's skills, oldest first."""
    agents = agents_mod.ensure(store, user_id, workspace_id, now)
    items = owner_items(store, user_id, workspace_id)
    choices = {str(i["skillId"]): i for i in items if i.get("builtin")}
    out = [public_builtin(b, choices.get(b.skill_id), agents) for b in builtins()]
    owned = sorted((i for i in items if not i.get("builtin")), key=lambda i: str(i.get("createdAt") or ""))
    return out + [public(i, agents) for i in owned]


def get(app: Any, user_id: str, workspace_id: str, skill_id: str, now: datetime) -> dict[str, Any]:
    """One skill with its ``SKILL.md`` text as ``content``."""
    agents = agents_mod.ensure(app.store, user_id, workspace_id, now)
    b = builtin(skill_id)
    if b is not None:
        choice = cfg.get_owned(app.store, user_id, workspace_id, skill_sk(skill_id))
        return {**public_builtin(b, choice, agents), "content": b.text}
    item = _owner_item(app.store, user_id, workspace_id, skill_id)
    return {**public(item, agents), "content": _current_text(app, item)}


def _owner_item(store: db.Store, user_id: str, workspace_id: str, skill_id: str) -> dict[str, Any]:
    if not is_ulid(skill_id):
        raise not_found(NOT_FOUND)
    item = cfg.get_owned(store, user_id, workspace_id, skill_sk(skill_id))
    if item is None or item.get("builtin"):
        raise not_found(NOT_FOUND)
    return item


def _current_text(app: Any, item: Mapping[str, Any]) -> str:
    key = str(item.get("key") or "")
    fmt = "zip" if item.get("format") == "zip" else "md"
    if not key.startswith(ws.s3_prefix(str(item["userId"]), str(item["workspaceId"]))):
        return ""
    try:
        data = app.media.read(key, LIMITS[fmt])
    except Exception as e:
        log("warning", "ws.skill_read_failed", error=type(e).__name__)
        return ""
    try:
        return skill_md_from_zip(data, strict=False) if fmt == "zip" else decode_text(data)
    except SkillError:
        return ""


# --- uploads --------------------------------------------------------------------------------------------------


def _format_of(filename: str) -> str:
    lowered = filename.strip().lower()
    if lowered.endswith(".md"):
        return "md"
    if lowered.endswith(".zip"):
        return "zip"
    raise bad_request(WRONG_FILE, "filename")


def upload(app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
    """A presigned PUT for a new skill (a new ``skillId``) or a new revision of one of the owner's skills."""
    validate.only_keys(body, ("filename", "skillId"))
    filename = validate.required_string(body, "filename", max_len=200)
    fmt = _format_of(filename)
    skill_id = body.get("skillId")
    if skill_id is not None:
        if not isinstance(skill_id, str):
            raise bad_request("skillId must be text.", "skillId")
        if builtin(skill_id) is not None:
            raise conflict(BUILTIN_LOCKED)
        _owner_item(app.store, user_id, workspace_id, skill_id)
    else:
        skill_id = ulid()
    key = revision_key(user_id, workspace_id, skill_id, ulid(), fmt)
    url = app.media.presign_put(key, CONTENT_TYPES[fmt], UPLOAD_SECONDS)
    return {"skillId": skill_id, "key": key, "uploadUrl": url, "headers": {"Content-Type": CONTENT_TYPES[fmt]}}


@dataclass(frozen=True)
class Parsed:
    name: str
    description: str
    size: int
    fmt: str


def _read_upload(app: Any, key: str, fmt: str) -> Parsed:
    """Reads and checks an uploaded file; a bad one is deleted again and answered with the owner's sentence."""
    head = app.media.head(key)
    if head is None:
        raise bad_request(NO_FILE, "key")
    limit = LIMITS[fmt]
    too_big = ("This file is larger than 1 MB." if fmt == "md" else "This .zip is larger than 20 MB.") + (
        " Make it smaller and try again."
    )
    if int(head.get("ContentLength") or 0) > limit:
        _delete_quietly(app, key)
        raise too_large(too_big)
    try:
        data = app.media.read(key, limit)
    except ValueError as e:
        _delete_quietly(app, key)
        raise too_large(too_big) from e
    try:
        text = skill_md_from_zip(data) if fmt == "zip" else decode_text(data)
        meta = read_frontmatter(text)
    except SkillTooLarge as e:
        _delete_quietly(app, key)
        raise too_large(str(e)) from e
    except SkillError as e:
        _delete_quietly(app, key)
        raise bad_request(str(e), "key") from e
    return Parsed(meta.name, meta.description, len(data), fmt)


def _delete_quietly(app: Any, key: str) -> None:
    with contextlib.suppress(Exception):
        app.media.delete(key)


def _revision(revision_id: str, key: str, size: int, fmt: str, at: str) -> dict[str, Any]:
    return {"revisionId": revision_id, "savedAt": at, "size": size, "key": key, "format": fmt}


def _kept(revisions: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """The newest ``KEEP_REVISIONS`` revisions, and the keys of the ones dropped."""
    return revisions[:KEEP_REVISIONS], [str(r.get("key")) for r in revisions[KEEP_REVISIONS:] if r.get("key")]


# --- create ---------------------------------------------------------------------------------------------------


def clean_form(body: Mapping[str, Any], current: Mapping[str, str] | None = None) -> tuple[str, str, str]:
    """The three answers of the Write-a-skill form; with ``current``, missing ones keep their saved value."""
    values: dict[str, str] = {}
    for field in ("title", "description", "instructions"):
        raw = body.get(field, (current or {}).get(field, ""))
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raise bad_request(f"{field} must be text.", field)
        values[field] = clean_text(raw)
    title = " ".join(values["title"].split())
    description = " ".join(values["description"].split())
    instructions = values["instructions"]
    if not title:
        raise bad_request("Give your skill a name.", "title")
    if len(title) > TITLE_MAX:
        raise bad_request(f"The name is too long. Use at most {TITLE_MAX} characters.", "title")
    if not re.search(r"[^\W_]", title):
        raise bad_request("Put at least one letter or number in the name.", "title")
    if len(description) < DESCRIPTION_MIN:
        raise bad_request("Say when the agents should use it (at least 3 characters).", "description")
    if len(description) > DESCRIPTION_MAX:
        raise bad_request(f"This answer is too long. Use at most {DESCRIPTION_MAX} characters.", "description")
    if not instructions:
        raise bad_request("Write what the skill should do.", "instructions")
    if len(instructions) > INSTRUCTIONS_MAX:
        raise bad_request(f"This answer is too long. Use at most {INSTRUCTIONS_MAX:,} characters.", "instructions")
    return title, description, instructions


def create(app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime) -> dict[str, Any]:
    """From an upload (``{skillId, key}``) or from the form (``{title, description, instructions}``)."""
    store = app.store
    owned = [i for i in owner_items(store, user_id, workspace_id) if not i.get("builtin")]
    if len(owned) >= MAX_SKILLS:
        raise conflict(TOO_MANY)
    at = iso(now)
    if "key" in body or "skillId" in body:
        validate.only_keys(body, ("skillId", "key"))
        skill_id = body.get("skillId")
        if not isinstance(skill_id, str) or not is_ulid(skill_id):
            raise bad_request("skillId is not valid. Upload the file again.", "skillId")
        found = parse_key(body.get("key"), user_id, workspace_id, skill_id)
        if found is None:
            raise bad_request("That upload does not belong to this skill. Upload the file again.", "key")
        if cfg.get_owned(store, user_id, workspace_id, skill_sk(skill_id)) is not None:
            raise conflict("That skill exists already. Save the file as a new version of it instead.")
        revision_id, fmt = found
        key = str(body["key"])
        parsed = _read_upload(app, key, fmt)
        fields = {
            "title": humanize(parsed.name)[:TITLE_MAX],
            "name": parsed.name,
            "description": parsed.description,
            "source": "upload",
            "format": fmt,
        }
        size = parsed.size
    else:
        validate.only_keys(body, ("title", "description", "instructions"))
        title, description, instructions = clean_form(body)
        skill_id, revision_id, fmt = ulid(), ulid(), "md"
        name = slug(title)
        text = build_skill_md(name, description, title, instructions)
        data = text.encode()
        if len(data) > MD_MAX_BYTES:
            raise too_large("This skill is larger than 1 MB. Make it shorter.")
        key = revision_key(user_id, workspace_id, skill_id, revision_id, "md")
        app.media.put(key, data, CONTENT_TYPES["md"])
        fields = {"title": title, "name": name, "description": description, "source": "written", "format": "md"}
        size = len(data)
    item = {
        **cfg.base_item(user_id, workspace_id, skill_sk(skill_id), ws.TYPE_SKILL),
        "skillId": skill_id,
        "builtin": False,
        **fields,
        "enabled": True,
        "key": key,
        "revisions": [_revision(revision_id, key, size, fmt, at)],
        "version": 1,
        "createdAt": at,
        "updatedAt": at,
    }
    try:
        store.put(item, if_absent=True)
    except db.ConditionFailed as e:
        raise conflict("That skill exists already. Save the file as a new version of it instead.") from e
    log("info", "ws.skill_created", skillId=skill_id, source=str(fields["source"]))
    return public(item, agents_mod.ensure(store, user_id, workspace_id, now))


# --- change, restore, delete ----------------------------------------------------------------------------------


def put(
    app: Any, user_id: str, workspace_id: str, skill_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("version", "title", "description", "instructions", "key", "enabled"))
    version = validate.whole_number(body.get("version"))
    if version is None:
        raise bad_request("version is required.", "version")
    if len(body) == 1:
        raise bad_request("Change at least one thing.")
    store = app.store
    at = iso(now)
    b = builtin(skill_id)
    if b is not None:
        if set(body) - {"version", "enabled"}:
            raise conflict(BUILTIN_LOCKED)
        enabled = validate.boolean(body.get("enabled"), "enabled")
        _save_builtin_choice(store, user_id, workspace_id, skill_id, enabled=enabled, version=version, at=at)
        return list_one(store, user_id, workspace_id, skill_id, now)
    item = _owner_item(store, user_id, workspace_id, skill_id)
    if int(item.get("version") or 0) != version:
        raise conflict(STALE)
    form = {"title", "description", "instructions"} & set(body)
    if form and "key" in body:
        raise bad_request(BOTH)
    sets: dict[str, Any] = {}
    if "enabled" in body:
        sets["enabled"] = validate.boolean(body.get("enabled"), "enabled")
    dropped: list[str] = []
    if "key" in body:
        found = parse_key(body.get("key"), user_id, workspace_id, skill_id)
        if found is None:
            raise bad_request("That upload does not belong to this skill. Upload the file again.", "key")
        revision_id, fmt = found
        if any(r.get("revisionId") == revision_id for r in _revisions(item)):
            raise conflict("That file is saved already.")
        key = str(body["key"])
        parsed = _read_upload(app, key, fmt)
        revisions, dropped = _kept([_revision(revision_id, key, parsed.size, fmt, at), *_revisions(item)])
        sets.update(
            title=humanize(parsed.name)[:TITLE_MAX],
            name=parsed.name,
            description=parsed.description,
            source="upload",
            format=fmt,
            key=key,
            revisions=revisions,
        )
    elif form:
        sets.update(_edit_words(app, item, body, at))
        revisions, dropped = _kept(sets.pop("revisions"))
        sets["revisions"] = revisions
    updated = _write(store, item, sets, at, version)
    for old in dropped:
        _delete_quietly(app, old)
    return public(updated, agents_mod.ensure(store, user_id, workspace_id, now))


def _edit_words(app: Any, item: Mapping[str, Any], body: Mapping[str, Any], at: str) -> dict[str, Any]:
    """A new revision with the form's words: a rebuilt ``SKILL.md`` (other frontmatter kept), or the same zip with
    only its ``SKILL.md`` replaced."""
    user_id, workspace_id, skill_id = str(item["userId"]), str(item["workspaceId"]), str(item["skillId"])
    fmt = "zip" if item.get("format") == "zip" else "md"
    key = str(item.get("key") or "")
    try:
        data = app.media.read(key, LIMITS[fmt])
        text = skill_md_from_zip(data) if fmt == "zip" else decode_text(data)
        saved = parse_form(item, text)
        extra = frontmatter_extra(text)
    except (SkillError, ValueError) as e:
        raise bad_request("We could not open the saved file to change it. Upload a new file instead.") from e
    title, description, instructions = clean_form(body, saved.as_json())
    name = slug(title) if item.get("source") == "written" else str(item.get("name") or slug(title))
    new_text = build_skill_md(name, description, title, instructions, extra)
    try:
        new_data = replace_skill_md_in_zip(data, new_text) if fmt == "zip" else new_text.encode()
    except SkillTooLarge as e:
        raise too_large(str(e)) from e
    except SkillError as e:
        raise bad_request(str(e)) from e
    if len(new_data) > LIMITS[fmt]:
        raise too_large("This skill is too large now. Make it shorter.")
    revision_id = ulid()
    new_key = revision_key(user_id, workspace_id, skill_id, revision_id, fmt)
    app.media.put(new_key, new_data, CONTENT_TYPES[fmt])
    return {
        "title": title,
        "name": name,
        "description": description,
        "key": new_key,
        "revisions": [_revision(revision_id, new_key, len(new_data), fmt, at), *_revisions(item)],
    }


def _write(store: db.Store, item: Mapping[str, Any], sets: dict[str, Any], at: str, version: int) -> dict[str, Any]:
    names = {"#u": "updatedAt", "#v": "version", "#uid": "userId", "#wid": "workspaceId"}
    values: dict[str, Any] = {
        ":u": at,
        ":v": version,
        ":nv": version + 1,
        ":uid": item["userId"],
        ":wid": item["workspaceId"],
    }
    parts = ["#u = :u", "#v = :nv"]
    for i, (field, value) in enumerate(sets.items()):
        names[f"#s{i}"] = field
        values[f":s{i}"] = value
        parts.append(f"#s{i} = :s{i}")
    try:
        return store.update_expr(
            str(item["pk"]),
            str(item["sk"]),
            "SET " + ", ".join(parts),
            condition="attribute_exists(pk) AND #v = :v AND #uid = :uid AND #wid = :wid",
            names=names,
            values=values,
        )
    except db.ConditionFailed as e:
        raise conflict(STALE) from e


def _save_builtin_choice(
    store: db.Store, user_id: str, workspace_id: str, skill_id: str, *, enabled: bool, version: int, at: str
) -> None:
    choice = cfg.get_owned(store, user_id, workspace_id, skill_sk(skill_id))
    if choice is None:
        if version != 0:
            raise conflict(STALE)
        item = {
            **cfg.base_item(user_id, workspace_id, skill_sk(skill_id), ws.TYPE_SKILL),
            "skillId": skill_id,
            "builtin": True,
            "enabled": enabled,
            "version": 1,
            "createdAt": at,
            "updatedAt": at,
        }
        try:
            store.put(item, if_absent=True)
        except db.ConditionFailed as e:
            raise conflict(STALE) from e
        return
    _write(store, choice, {"enabled": enabled}, at, version)


def list_one(store: db.Store, user_id: str, workspace_id: str, skill_id: str, now: datetime) -> dict[str, Any]:
    found = next((s for s in list_all(store, user_id, workspace_id, now) if s["skillId"] == skill_id), None)
    if found is None:
        raise not_found(NOT_FOUND)
    return found


def restore(
    app: Any, user_id: str, workspace_id: str, skill_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """Makes an older revision the current one again: its file is copied to a new revision (so every revision keeps
    its own file and the last 10 stay restorable)."""
    validate.only_keys(body, ("revisionId",))
    if builtin(skill_id) is not None:
        raise conflict(BUILTIN_LOCKED)
    store = app.store
    item = _owner_item(store, user_id, workspace_id, skill_id)
    revision_id = body.get("revisionId")
    revisions = _revisions(item)
    old = next((r for r in revisions if r.get("revisionId") == revision_id), None)
    if old is None:
        raise not_found("We could not find that version of the skill.")
    if revisions and revisions[0].get("revisionId") == revision_id:
        return public(item, agents_mod.ensure(store, user_id, workspace_id, now))
    fmt = "zip" if old.get("format") == "zip" else "md"
    old_key = str(old.get("key") or "")
    if parse_key(old_key, user_id, workspace_id, skill_id) is None:
        raise not_found("We could not find that version of the skill.")
    try:
        data = app.media.read(old_key, LIMITS[fmt])
        text = skill_md_from_zip(data) if fmt == "zip" else decode_text(data)
        meta = read_frontmatter(text)
    except (SkillError, ValueError) as e:
        raise bad_request("That version can't be opened any more. Pick another one.") from e
    except Exception as e:
        raise not_found("We could not find that version of the skill.") from e
    at = iso(now)
    new_id = ulid()
    new_key = revision_key(user_id, workspace_id, skill_id, new_id, fmt)
    app.media.put(new_key, data, CONTENT_TYPES[fmt])
    kept, dropped = _kept([_revision(new_id, new_key, len(data), fmt, at), *revisions])
    # a written skill's title is its heading (build_skill_md writes it); an uploaded one's comes from its name
    title = _title(text, meta.name) if item.get("source") == "written" else humanize(meta.name)
    sets = {
        "title": title[:TITLE_MAX],
        "name": meta.name,
        "description": meta.description,
        "format": fmt,
        "key": new_key,
        "revisions": kept,
    }
    updated = _write(store, item, sets, at, int(item.get("version") or 0))
    for key in dropped:
        _delete_quietly(app, key)
    return public(updated, agents_mod.ensure(store, user_id, workspace_id, now))


def delete(app: Any, user_id: str, workspace_id: str, skill_id: str, now: datetime) -> None:
    if builtin(skill_id) is not None:
        raise conflict("Built-in skills can't be deleted. You can switch one off instead.")
    store = app.store
    item = _owner_item(store, user_id, workspace_id, skill_id)
    if not store.delete_if(str(item["pk"]), str(item["sk"]), {"userId": [user_id], "workspaceId": [workspace_id]}):
        raise not_found(NOT_FOUND)
    agents_mod.drop_skill(store, user_id, workspace_id, skill_id, now)
    try:
        app.media.delete_prefix(skill_prefix(user_id, workspace_id, skill_id))
    except Exception as e:  # the item is gone; files left behind are only space, never used again
        log("warning", "ws.skill_files_left", error=type(e).__name__, skillId=skill_id)
