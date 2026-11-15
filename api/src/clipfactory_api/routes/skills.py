"""/v1/skills: built-in skills (bundled, can be turned off) and the owner's own SKILL.md or zip uploads."""

from __future__ import annotations

import zipfile
from typing import Any

from .. import db, s3, skills, validate
from ..app import App
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..ids import is_ulid, ulid
from ..log import log

CONTENT_TYPES = {"md": "text/markdown", "zip": "application/zip"}
LIMITS = {"md": skills.MD_MAX_BYTES, "zip": skills.ZIP_MAX_BYTES}
SKILL_FIELDS = ("skillId", "name", "description", "enabled", "builtin", "format", "size", "createdAt")


def _public(item: dict[str, Any]) -> dict[str, Any]:
    return {k: item[k] for k in SKILL_FIELDS if k in item}


def _builtin_view(app: App, user_id: str) -> list[dict[str, Any]]:
    choices = {i["skillId"]: i for i in app.store.query_all(db.user_pk(user_id), f"SKILL#{skills.BUILTIN_PREFIX}")}
    return [
        {
            "skillId": b.skill_id,
            "name": b.name,
            "description": b.description,
            "enabled": bool(choices.get(b.skill_id, {}).get("enabled", True)),
            "builtin": True,
            "format": "md",
            "size": b.size,
            "createdAt": skills.BUILTIN_CREATED_AT,
        }
        for b in app.builtin_skills()
    ]


def _owner_items(app: App, user_id: str) -> list[dict[str, Any]]:
    return [i for i in app.store.query_all(db.user_pk(user_id), "SKILL#") if not i.get("builtin") and i.get("name")]


def _builtin(app: App, skill_id: str) -> skills.BuiltinSkill | None:
    return next((b for b in app.builtin_skills() if b.skill_id == skill_id), None)


def _owner_or_404(app: App, req: Request) -> dict[str, Any]:
    skill_id = req.params["skillId"]
    item = app.store.get(db.user_pk(req.user_id), db.skill_sk(skill_id)) if is_ulid(skill_id) else None
    if item is None or item.get("builtin"):
        raise not_found("We could not find that skill.")
    return item


def _format_of(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".md"):
        return "md"
    if lower.endswith(".zip"):
        return "zip"
    raise bad_request("Upload a SKILL.md (.md) or a zip (.zip) file.")


def list_skills(app: App, req: Request) -> Response:
    owner = sorted((_public(i) for i in _owner_items(app, req.user_id)), key=lambda s: s["name"])
    return ok({"skills": _builtin_view(app, req.user_id) + owner})


def create_upload(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"filename"})
    fmt = _format_of(validate.required_string(body, "filename", max_len=255))
    skill_id = ulid()
    key = s3.skill_key(req.user_id, skill_id, fmt)
    content_type = CONTENT_TYPES[fmt]
    return ok(
        {
            "skillId": skill_id,
            "key": key,
            "uploadUrl": app.media.presign_put(key, content_type),
            "headers": {"Content-Type": content_type},
        }
    )


def register(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"skillId", "key"})
    skill_id = validate.required_string(body, "skillId", max_len=64)
    key = validate.required_string(body, "key", max_len=512)
    if not is_ulid(skill_id):
        raise bad_request("skillId is not valid.")
    fmt = next((f for f in ("md", "zip") if key == s3.skill_key(req.user_id, skill_id, f)), None)
    if fmt is None:
        raise bad_request("That upload does not belong to you.")
    pk, sk = db.user_pk(req.user_id), db.skill_sk(skill_id)
    if app.store.get(pk, sk) is not None:
        raise conflict("That skill is already added.")
    head = app.media.head(key)
    if head is None:
        raise bad_request("We could not find the uploaded file. Upload it again.")
    try:
        data, meta = _read_upload(app, key, fmt, int(head.get("ContentLength", 0)))
    except skills.SkillError as e:
        _discard(app, key)
        raise bad_request(str(e)) from e
    taken = {b.name for b in app.builtin_skills()} | {i["name"] for i in _owner_items(app, req.user_id)}
    if meta.name in taken:
        _discard(app, key)
        raise conflict(f"A skill named {meta.name} already exists.")
    item = {
        "pk": pk,
        "sk": sk,
        "type": "skill",
        "userId": req.user_id,
        "skillId": skill_id,
        "name": meta.name,
        "description": meta.description,
        "enabled": True,
        "builtin": False,
        "format": fmt,
        "size": len(data),
        "createdAt": iso(app.clock()),
        "key": key,
    }
    try:
        app.store.put(item, if_absent=True)
    except db.ConditionFailed as e:
        raise conflict("That skill is already added.") from e
    log("info", "skill.added", skillId=skill_id, format=fmt)
    return ok({"skill": _public(item)}, 201)


def _read_upload(app: App, key: str, fmt: str, size: int) -> tuple[bytes, skills.Frontmatter]:
    too_big = skills.SkillError("The file is larger than " + ("1 MB." if fmt == "md" else "20 MB."))
    if size > LIMITS[fmt]:
        raise too_big
    try:
        data = app.media.read(key, LIMITS[fmt])
    except ValueError as e:
        raise too_big from e
    text = skills.decode_text(data) if fmt == "md" else skills.skill_md_from_zip(data)
    return data, skills.read_frontmatter(text)


def _discard(app: App, key: str) -> None:
    try:
        app.media.delete(key)
    except Exception as e:
        log("warning", "skill.discard_failed", error=type(e).__name__)


def patch_skill(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"enabled"})
    enabled = validate.boolean(body.get("enabled"), "enabled")
    skill_id = req.params["skillId"]
    builtin = _builtin(app, skill_id)
    if builtin is not None:
        # Only the owner's choice is stored for a built-in skill.
        app.store.put(
            {
                "pk": db.user_pk(req.user_id),
                "sk": db.skill_sk(skill_id),
                "type": "skill_choice",
                "userId": req.user_id,
                "skillId": skill_id,
                "builtin": True,
                "enabled": enabled,
                "updatedAt": iso(app.clock()),
            }
        )
        view = next(s for s in _builtin_view(app, req.user_id) if s["skillId"] == skill_id)
        return ok({"skill": {**view, "enabled": enabled}})
    item = _owner_or_404(app, req)
    try:
        updated = app.store.update(item["pk"], item["sk"], {"enabled": enabled})
    except db.ConditionFailed as e:
        raise not_found("We could not find that skill.") from e
    return ok({"skill": _public(updated)})


def delete_skill(app: App, req: Request) -> Response:
    if _builtin(app, req.params["skillId"]) is not None:
        raise conflict("Built-in skills cannot be deleted. Turn it off instead.")
    item = _owner_or_404(app, req)
    app.store.delete(item["pk"], item["sk"])
    key = item.get("key")
    if isinstance(key, str) and key.startswith(f"skills/{req.user_id}/{item['skillId']}/"):
        _discard(app, key)
    log("info", "skill.deleted", skillId=item["skillId"])
    return no_content()


def content(app: App, req: Request) -> Response:
    builtin = _builtin(app, req.params["skillId"])
    if builtin is not None:
        return ok({"content": skills.decode_text(builtin.path.read_bytes())})
    item = _owner_or_404(app, req)
    fmt = item.get("format", "md")
    try:
        data = app.media.read(item["key"], LIMITS.get(fmt, skills.MD_MAX_BYTES))
        text = skills.decode_text(data) if fmt == "md" else skills.skill_md_from_zip(data)
    except (skills.SkillError, ValueError, zipfile.BadZipFile) as e:
        raise not_found("We could not read that skill's file.") from e
    return ok({"content": text})
