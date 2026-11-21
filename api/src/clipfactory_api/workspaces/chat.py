"""Lamo Stories' creative chat: conversations, messages, pictures and Stop (docs/CONTRACTS.md §45.3 ``CONV#``,
``MSG#``; §45.4 ``chat/``; §45.5; §45.6 ``Conversation``, ``Message``; §45.9.1 tail; §45.25; §45.27; ADR-78).

Sending writes the owner's message and a ``pending`` answer (with its own ``sessionId``, ``heartbeatAt`` and, as
``requested``, the "Just for this message" override, which is never saved as a setting), then asks **Lamo Stories'
own runtime** to answer (``chat_turn``); the agent streams the text into the answer and the web polls. A second
message while the last answer is ``pending`` or ``streaming`` is a 409. An answer whose heartbeat stopped is failed
by ``settle`` ("The answer stopped. Tap Try again."), and Stop fences it with a new ``sessionId``. Every conversation
shows the model and effort its next message will use (``effective``, the same rules as the agent).
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db, validate
from ..clock import iso, parse
from ..errors import bad_request, conflict, not_found, too_large
from ..ids import is_ulid, ulid
from ..log import log
from . import agents as agents_mod
from . import ai_config as cfg
from . import ai_resolve as res
from . import guard
from . import types as ws

DEFAULT_TITLE: Final = "New chat"
TITLE_MAX: Final = 80
TEXT_MAX: Final = 8000
MAX_ATTACHMENTS: Final = 4
PICTURE_MAX: Final = 5 * 1024 * 1024
PICTURE_TYPES: Final = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_WAITING: Final = 20
UPLOAD_SECONDS: Final = 900
GET_SECONDS: Final = 3600
SHOWN: Final = 500
STALE_AFTER: Final = timedelta(minutes=3)  # pending or streaming with no heartbeat for this long (§45.9.1)
ACTIVE: Final = ("pending", "streaming")
STATUSES: Final = ("pending", "streaming", "done", "failed", "stopped")
AGENT: Final = "creative_director"

NOT_FOUND: Final = "We could not find that chat."
MSG_NOT_FOUND: Final = "We could not find that message."
WAIT: Final = "Wait for the answer, or tap Stop."
STOPPED_LINE: Final = "The answer stopped. Tap Try again."
DID_NOT_START: Final = "The answer did not start. Tap Try again."
NOT_UPLOADED: Final = "That picture did not finish uploading. Add it again."
PROJECT_KINDS: Final = {
    "idea": (ws.IDEA_SK, "idea"),
    "story": (ws.STORY_SK, "video"),
    "character": (ws.CHAR_SK, "character"),
    "reference": (ws.REFVID_SK, "reference video"),
}


def conv_sk(conv_id: str) -> str:
    return f"{ws.CONV_SK}{conv_id}"


def msg_prefix(conv_id: str) -> str:
    return f"{ws.MSG_SK}{conv_id}#"


def msg_sk(conv_id: str, msg_id: str) -> str:
    return f"{msg_prefix(conv_id)}{msg_id}"


def chat_prefix(user_id: str, workspace_id: str, conv_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}chat/{conv_id}/"


# --- shapes ---------------------------------------------------------------------------------------------------


def setting(conv: Mapping[str, Any]) -> dict[str, Any]:
    return {"model": conv.get("model") or None, "effort": conv.get("effort") or None}


def effective(conv: Mapping[str, Any], *, ai: Mapping[str, Any], agent: Mapping[str, Any] | None) -> dict[str, Any]:
    """What the conversation's next message will use (the override of one message aside)."""
    found, _ = res.shown(task="chat", agent=agent, ai=ai, conversation=setting(conv))
    return found


def public_conversation(conv: Mapping[str, Any], eff: dict[str, Any]) -> dict[str, Any]:
    ref = conv.get("projectRef")
    created = str(conv.get("createdAt") or "")
    return {
        "convId": str(conv.get("convId")),
        "title": str(conv.get("title") or DEFAULT_TITLE),
        "model": conv.get("model") or None,
        "effort": conv.get("effort") or None,
        "effective": eff,
        "projectRef": {"kind": str(ref["kind"]), "id": str(ref["id"])} if isinstance(ref, Mapping) else None,
        "lastMessageAt": conv.get("lastMessageAt") or None,
        "createdAt": created,
        "updatedAt": str(conv.get("updatedAt") or created),
    }


def public_message(app: Any, item: Mapping[str, Any]) -> dict[str, Any]:
    """``Message`` (§45.6): pictures as presigned links; ``sessionId``, ``heartbeatAt``, ``requested`` and the keys
    stay inside."""
    prefix = ws.s3_prefix(str(item.get("userId")), str(item.get("workspaceId")))
    pictures = []
    for a in item.get("attachments") or []:
        if not isinstance(a, Mapping) or not str(a.get("key") or "").startswith(prefix):
            continue
        pictures.append(
            {
                "assetId": str(a.get("assetId")),
                "url": app.media.presign_get(str(a["key"]), GET_SECONDS),
                "contentType": str(a.get("contentType") or ""),
            }
        )
    usage = item.get("usage") if isinstance(item.get("usage"), Mapping) else None
    status = str(item.get("status") or "done")
    out: dict[str, Any] = {
        "msgId": str(item.get("msgId")),
        "convId": str(item.get("convId")),
        "role": "assistant" if item.get("role") == "assistant" else "user",
        "text": str(item.get("text") or ""),
        "attachments": pictures,
        "status": status if status in STATUSES else "done",
        "model": item.get("model") or None,
        "effort": item.get("effort") or None,
        "effortApplied": item.get("effortApplied") if isinstance(item.get("effortApplied"), bool) else None,
        "usage": ({"input": int(usage.get("input") or 0), "output": int(usage.get("output") or 0)} if usage else None),
        "actions": [
            {
                "kind": str(a.get("kind")),
                "label": str(a.get("label") or ""),
                "payload": dict(a.get("payload") or {}) if isinstance(a.get("payload"), Mapping) else {},
            }
            for a in item.get("actions") or []
            if isinstance(a, Mapping) and a.get("kind")
        ],
        "createdAt": str(item.get("createdAt") or ""),
    }
    if item.get("error"):
        out["error"] = str(item["error"])
    return out


# --- reads ----------------------------------------------------------------------------------------------------


def _conv(store: db.Store, user_id: str, workspace_id: str, conv_id: str) -> dict[str, Any]:
    if not is_ulid(conv_id):
        raise not_found(NOT_FOUND)
    item = cfg.get_owned(store, user_id, workspace_id, conv_sk(conv_id))
    if item is None:
        raise not_found(NOT_FOUND)
    return item


def _context(store: db.Store, user_id: str, workspace_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    return cfg.current(store, user_id, workspace_id), agents_mod.read(store, user_id, workspace_id, AGENT)


def list_conversations(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    """Newest first (by the last message, else when it was made)."""
    ai, agent = _context(store, user_id, workspace_id)
    items = cfg.query_owned(store, user_id, workspace_id, ws.CONV_SK)
    items.sort(
        key=lambda c: (str(c.get("lastMessageAt") or c.get("createdAt") or ""), str(c.get("convId"))), reverse=True
    )
    return [public_conversation(c, effective(c, ai=ai, agent=agent)) for c in items]


def conversation(store: db.Store, user_id: str, workspace_id: str, conv: Mapping[str, Any]) -> dict[str, Any]:
    ai, agent = _context(store, user_id, workspace_id)
    return public_conversation(conv, effective(conv, ai=ai, agent=agent))


def get(app: Any, user_id: str, workspace_id: str, conv_id: str, after: str | None, *, now: datetime) -> dict[str, Any]:
    store = app.store
    conv = _conv(store, user_id, workspace_id, conv_id)
    if after:
        if not is_ulid(after):
            raise bad_request("after is not a message id.", "after")
        items = cfg.query_owned(store, user_id, workspace_id, msg_prefix(conv_id))
        items = [m for m in items if str(m.get("msgId") or "") > after][:SHOWN]
    else:
        page = store.query_page(
            cfg.pk(user_id, workspace_id), msg_prefix(conv_id), newest_first=True, limit=SHOWN, consistent=True
        )
        items = [m for m in reversed(page.items) if guard.owned(m, user_id, workspace_id)]
    items = [settle(app, m, now) if m.get("role") == "assistant" else m for m in items]
    return {
        "conversation": conversation(store, user_id, workspace_id, conv),
        "messages": [public_message(app, m) for m in items],
    }


# --- the stale-heartbeat fence and Stop -----------------------------------------------------------------------


def is_stale(item: Mapping[str, Any], now: datetime) -> bool:
    if item.get("role") != "assistant" or item.get("status") not in ACTIVE:
        return False
    beat = parse(item.get("heartbeatAt")) or parse(item.get("createdAt"))
    return beat is None or now - beat > STALE_AFTER


def settle(app: Any, item: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Fails an answer whose heartbeat stopped (conditional on what was read, with a new ``sessionId`` so the old run
    can write nothing more), then stops its old session; a refused condition re-reads what is stored."""
    if not is_stale(item, now):
        return item
    old_session = item.get("sessionId")
    names = {"#st": "status", "#e": "error", "#sid": "sessionId", "#u": "updatedAt", "#hb": "heartbeatAt"}
    values: dict[str, Any] = {
        ":failed": "failed",
        ":err": STOPPED_LINE,
        ":new": cfg.new_session(str(item.get("msgId"))),
        ":u": iso(now),
        ":st": item.get("status"),
        ":sid": old_session,
    }
    condition = "attribute_exists(pk) AND #st = :st AND #sid = :sid"
    if item.get("heartbeatAt"):
        condition += " AND #hb = :hb"
        values[":hb"] = item["heartbeatAt"]
    try:
        updated = app.store.update_expr(
            str(item["pk"]),
            str(item["sk"]),
            "SET #st = :failed, #e = :err, #sid = :new, #u = :u",
            condition=condition,
            names=names,
            values=values,
        )
    except db.ConditionFailed:
        return app.store.get(str(item["pk"]), str(item["sk"])) or item
    log("info", "ws.chat_answer_settled", msgId=str(item.get("msgId")))
    cfg.stop_quietly(app, old_session)
    return dict(updated)


def _last_answer(app: Any, user_id: str, workspace_id: str, conv_id: str, now: datetime) -> dict[str, Any] | None:
    page = app.store.query_page(
        cfg.pk(user_id, workspace_id), msg_prefix(conv_id), newest_first=True, limit=10, consistent=True
    )
    for m in page.items:
        if m.get("role") == "assistant" and guard.owned(m, user_id, workspace_id):
            return settle(app, m, now)
    return None


def stop(app: Any, user_id: str, workspace_id: str, conv_id: str, msg_id: str, *, now: datetime) -> dict[str, Any]:
    _conv(app.store, user_id, workspace_id, conv_id)
    if not is_ulid(msg_id):
        raise not_found(MSG_NOT_FOUND)
    item = cfg.get_owned(app.store, user_id, workspace_id, msg_sk(conv_id, msg_id))
    if item is None:
        raise not_found(MSG_NOT_FOUND)
    if item.get("role") != "assistant":
        raise conflict("Only an answer can be stopped.")
    if item.get("status") not in ACTIVE:
        return public_message(app, item)
    stopped = _fence(app, item, "stopped", None, now)
    return public_message(app, stopped)


def _fence(app: Any, item: Mapping[str, Any], status: str, error: str | None, now: datetime) -> dict[str, Any]:
    old_session = item.get("sessionId")
    sets: dict[str, Any] = {
        "status": status,
        "sessionId": cfg.new_session(str(item.get("msgId"))),
        "updatedAt": iso(now),
    }
    if error:
        sets["error"] = error
    try:
        updated = app.store.update(
            str(item["pk"]),
            str(item["sk"]),
            sets,
            expect_in={"status": list(ACTIVE), "sessionId": [old_session]},
        )
    except db.ConditionFailed:
        return app.store.get(str(item["pk"]), str(item["sk"])) or dict(item)
    cfg.stop_quietly(app, old_session)
    return dict(updated)


# --- create, change, delete -----------------------------------------------------------------------------------


def clean_project_ref(store: db.Store, user_id: str, workspace_id: str, value: Any) -> dict[str, str] | None:
    """``{kind, id}`` of an idea, story, character or reference video **of this workspace**, else 404."""
    if value is None:
        return None
    ref = validate.obj(value, "projectRef")
    validate.only_keys(ref, ("kind", "id"))
    kind = ref.get("kind")
    if kind not in PROJECT_KINDS:
        raise bad_request("projectRef.kind must be idea, story, character or reference.", "projectRef")
    item_id = ref.get("id")
    prefix, word = PROJECT_KINDS[str(kind)]
    if not isinstance(item_id, str) or not is_ulid(item_id):
        raise not_found(f"We could not find that {word}.")
    if cfg.get_owned(store, user_id, workspace_id, f"{prefix}{item_id}") is None:
        raise not_found(f"We could not find that {word}.")
    return {"kind": str(kind), "id": item_id}


def _title(value: Any) -> str:
    if not isinstance(value, str):
        raise bad_request("title must be text.", "title")
    title = " ".join(value.split())
    if not title:
        raise bad_request("Give the chat a name.", "title")
    if len(title) > TITLE_MAX:
        raise bad_request(f"The name is too long (at most {TITLE_MAX} characters).", "title")
    return title


def _check_setting(store: db.Store, user_id: str, workspace_id: str, model: str | None, effort: str | None) -> None:
    ai, agent = _context(store, user_id, workspace_id)
    try:
        res.resolve(task="chat", agent=agent, ai=ai, conversation={"model": model, "effort": effort})
    except res.ResolveError as e:
        raise bad_request(e.message, "effort" if e.kind == "effort" else "model") from e


def create(app: Any, user_id: str, workspace_id: str, body: Mapping[str, Any], *, now: datetime) -> dict[str, Any]:
    validate.only_keys(body, ("title", "projectRef", "model", "effort"))
    store = app.store
    title = _title(body["title"]) if body.get("title") is not None else DEFAULT_TITLE
    model = cfg.optional_model(body.get("model"))
    effort = cfg.optional_effort(body.get("effort"))
    _check_setting(store, user_id, workspace_id, model, effort)
    ref = clean_project_ref(store, user_id, workspace_id, body.get("projectRef"))
    conv_id = ulid()
    at = iso(now)
    item: dict[str, Any] = {
        **cfg.base_item(user_id, workspace_id, conv_sk(conv_id), ws.TYPE_CONV),
        "convId": conv_id,
        "title": title,
        "model": model,
        "effort": effort,
        "projectRef": ref,
        "uploads": {},
        "createdAt": at,
        "updatedAt": at,
    }
    store.put(item, if_absent=True)
    return conversation(store, user_id, workspace_id, item)


def patch(
    app: Any, user_id: str, workspace_id: str, conv_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("title", "model", "effort", "projectRef"))
    if not body:
        raise bad_request("Change at least one thing.")
    store = app.store
    conv = _conv(store, user_id, workspace_id, conv_id)
    sets: dict[str, Any] = {"updatedAt": iso(now)}
    removes: list[str] = []
    if "title" in body:
        sets["title"] = _title(body.get("title"))
    model = conv.get("model") or None
    effort = conv.get("effort") or None
    for field in ("model", "effort"):
        if field not in body:
            continue
        value = cfg.optional_model(body.get(field)) if field == "model" else cfg.optional_effort(body.get(field))
        if field == "model":
            model = value
        else:
            effort = value
        if value:
            sets[field] = value
        else:
            removes.append(field)
    if "model" in body or "effort" in body:
        _check_setting(store, user_id, workspace_id, model, effort)
    if "projectRef" in body:
        ref = clean_project_ref(store, user_id, workspace_id, body.get("projectRef"))
        if ref:
            sets["projectRef"] = ref
        else:
            removes.append("projectRef")
    try:
        updated = store.update(
            str(conv["pk"]),
            str(conv["sk"]),
            sets,
            remove=removes,
            expect_in={"userId": [user_id], "workspaceId": [workspace_id]},
        )
    except db.ConditionFailed as e:
        raise not_found(NOT_FOUND) from e
    return conversation(store, user_id, workspace_id, updated)


def delete(app: Any, user_id: str, workspace_id: str, conv_id: str, now: datetime) -> None:
    """Stops an answer still being written, then deletes the messages, the conversation and its pictures."""
    store = app.store
    conv = _conv(store, user_id, workspace_id, conv_id)
    for m in cfg.query_owned(store, user_id, workspace_id, msg_prefix(conv_id)):
        if m.get("role") == "assistant" and m.get("status") in ACTIVE:
            _fence(app, m, "stopped", None, now)
        store.delete(str(m["pk"]), str(m["sk"]))
    if not store.delete_if(str(conv["pk"]), str(conv["sk"]), {"userId": [user_id], "workspaceId": [workspace_id]}):
        raise not_found(NOT_FOUND)
    try:
        app.media.delete_prefix(chat_prefix(user_id, workspace_id, conv_id))
    except Exception as e:
        log("warning", "ws.chat_files_left", error=type(e).__name__, convId=conv_id)


# --- pictures -------------------------------------------------------------------------------------------------


def attachment(
    app: Any, user_id: str, workspace_id: str, conv_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """A presigned PUT (type and exact length signed, 15 minutes) for one picture of the next message."""
    validate.only_keys(body, ("filename", "contentType", "size"))
    validate.required_string(body, "filename", max_len=200)
    content_type = body.get("contentType")
    if content_type not in PICTURE_TYPES:
        raise bad_request("Pick a PNG, JPEG or WebP picture.", "contentType")
    size = validate.whole_number(body.get("size"))
    if size is None or size < 1:
        raise bad_request("size must be the picture's size in bytes.", "size")
    if size > PICTURE_MAX:
        raise too_large("Pictures can be at most 5 MB. Pick a smaller one.")
    store = app.store
    conv = _conv(store, user_id, workspace_id, conv_id)
    waiting = conv.get("uploads") if isinstance(conv.get("uploads"), Mapping) else {}
    if len(waiting or {}) >= MAX_WAITING:
        raise conflict("Too many pictures are waiting. Send them with a message first.")
    asset_id = ulid()
    key = f"{chat_prefix(user_id, workspace_id, conv_id)}{asset_id}.{PICTURE_TYPES[str(content_type)]}"
    record = {"key": key, "contentType": str(content_type), "size": size, "createdAt": iso(now)}
    names = {"#up": "uploads", "#a": asset_id, "#uid": "userId", "#wid": "workspaceId"}
    values = {":rec": record, ":uid": user_id, ":wid": workspace_id}
    try:
        store.update_expr(
            str(conv["pk"]),
            str(conv["sk"]),
            "SET #up.#a = :rec",
            condition="attribute_exists(pk) AND attribute_exists(#up) AND #uid = :uid AND #wid = :wid",
            names=names,
            values=values,
        )
    except db.ConditionFailed:
        try:
            store.update_expr(
                str(conv["pk"]),
                str(conv["sk"]),
                "SET #up = :map",
                condition="attribute_exists(pk) AND attribute_not_exists(#up) AND #uid = :uid AND #wid = :wid",
                names={"#up": "uploads", "#uid": "userId", "#wid": "workspaceId"},
                values={":map": {asset_id: record}, ":uid": user_id, ":wid": workspace_id},
            )
        except db.ConditionFailed as e:
            raise not_found(NOT_FOUND) from e
    url = app.media.presign_put_sized(key, str(content_type), size, UPLOAD_SECONDS)
    return {"assetId": asset_id, "uploadUrl": url, "headers": {"Content-Type": str(content_type)}}


def _pictures(app: Any, conv: Mapping[str, Any], raw: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The message's pictures (each one uploaded to this conversation and checked), and the uploads still waiting."""
    waiting = dict(conv.get("uploads") or {}) if isinstance(conv.get("uploads"), Mapping) else {}
    if raw is None:
        return [], waiting
    if not isinstance(raw, list) or len(raw) > MAX_ATTACHMENTS:
        raise bad_request(f"Add at most {MAX_ATTACHMENTS} pictures to one message.", "attachments")
    prefix = chat_prefix(str(conv["userId"]), str(conv["workspaceId"]), str(conv["convId"]))
    out: list[dict[str, Any]] = []
    for entry in raw:
        a = validate.obj(entry, "attachments")
        validate.only_keys(a, ("assetId",))
        asset_id = a.get("assetId")
        record = waiting.get(asset_id) if isinstance(asset_id, str) else None
        if not isinstance(record, Mapping) or not str(record.get("key") or "").startswith(prefix):
            raise bad_request(NOT_UPLOADED, "attachments")
        if any(p["assetId"] == asset_id for p in out):
            raise bad_request("Each picture can be added once.", "attachments")
        head = app.media.head(str(record["key"]))
        if head is None:
            raise bad_request(NOT_UPLOADED, "attachments")
        size = int(head.get("ContentLength") or 0)
        if size > PICTURE_MAX:
            raise too_large("Pictures can be at most 5 MB. Pick a smaller one.")
        out.append(
            {
                "assetId": str(asset_id),
                "key": str(record["key"]),
                "contentType": str(record.get("contentType") or ""),
                "bytes": size,
            }
        )
    for p in out:
        waiting.pop(p["assetId"], None)
    return out, waiting


# --- sending --------------------------------------------------------------------------------------------------


def send(
    app: Any, user_id: str, workspace_id: str, conv_id: str, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    validate.only_keys(body, ("text", "attachments", "override"))
    raw_text = body.get("text")
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise bad_request("Write a message.", "text")
    text = raw_text.replace("\r\n", "\n").strip()
    if len(text) > TEXT_MAX:
        raise bad_request(f"The message is too long (at most {TEXT_MAX:,} characters).", "text")
    override = cfg.clean_override(body.get("override"))
    store = app.store
    conv = _conv(store, user_id, workspace_id, conv_id)
    last = _last_answer(app, user_id, workspace_id, conv_id, now)
    if last is not None and last.get("status") in ACTIVE:
        raise conflict(WAIT)
    ai, agent = _context(store, user_id, workspace_id)
    off = agents_mod.switched_off(agent)
    if off:
        raise conflict(off)
    try:
        eff = res.resolve(task="chat", agent=agent, ai=ai, request=override, conversation=setting(conv))
    except res.ResolveError as e:
        raise bad_request(e.message, "override" if override else None) from e
    pictures, waiting = _pictures(app, conv, body.get("attachments"))
    info = res.model(eff["model"]) or {}
    if pictures and not info.get("vision"):
        raise bad_request(f"{info.get('label') or eff['model']} can't look at pictures. Pick another model.")
    at = iso(now)
    user_msg_id, answer_id = ulid(), ulid()
    session_id = cfg.new_session(answer_id)
    user_item = {
        **cfg.base_item(user_id, workspace_id, msg_sk(conv_id, user_msg_id), ws.TYPE_MSG),
        "msgId": user_msg_id,
        "convId": conv_id,
        "role": "user",
        "text": text,
        "attachments": pictures,
        "status": "done",
        "actions": [],
        "createdAt": at,
        "updatedAt": at,
    }
    answer = {
        **cfg.base_item(user_id, workspace_id, msg_sk(conv_id, answer_id), ws.TYPE_MSG),
        "msgId": answer_id,
        "convId": conv_id,
        "role": "assistant",
        "text": "",
        "attachments": [],
        "status": "pending",
        "model": eff["model"],
        "effort": eff["effort"],
        "effortApplied": eff["effortApplied"],
        "actions": [],
        "createdAt": at,
        "updatedAt": at,
        "sessionId": session_id,
        "heartbeatAt": at,
        "requested": override,
    }
    conv_sets: dict[str, Any] = {"lastMessageAt": at, "updatedAt": at, "uploads": waiting}
    if str(conv.get("title") or DEFAULT_TITLE) == DEFAULT_TITLE:
        conv_sets["title"] = " ".join(text.split())[:60] or DEFAULT_TITLE
    try:
        store.transact(
            puts=[user_item, answer],
            updates=[
                db.update_request(
                    str(conv["pk"]),
                    str(conv["sk"]),
                    conv_sets,
                    expect_in={"userId": [user_id], "workspaceId": [workspace_id]},
                )
            ],
        )
    except db.ConditionFailed as e:
        raise not_found(NOT_FOUND) from e
    answer = _start(app, user_id, workspace_id, conv_id, answer, now=now)
    return {"user": public_message(app, user_item), "assistant": public_message(app, answer)}


def _start(
    app: Any, user_id: str, workspace_id: str, conv_id: str, answer: dict[str, Any], *, now: datetime
) -> dict[str, Any]:
    agent = cfg.runtime(app)
    problem = cfg.NOT_ON if agent is None else None
    if agent is not None:
        try:
            agent.start_chat_turn(
                user_id=user_id,
                workspace_id=workspace_id,
                conv_id=conv_id,
                msg_id=str(answer["msgId"]),
                session_id=str(answer["sessionId"]),
            )
        except Exception as e:
            log("warning", "ws.chat_turn_not_started", error=type(e).__name__, msgId=str(answer["msgId"]))
            problem = DID_NOT_START
    if problem is None:
        return answer
    with contextlib.suppress(db.ConditionFailed):
        failed: dict[str, Any] = app.store.update(
            str(answer["pk"]),
            str(answer["sk"]),
            {"status": "failed", "error": problem, "updatedAt": iso(now)},
            expect_in={"status": ["pending"], "sessionId": [answer["sessionId"]]},
        )
        return failed
    found: dict[str, Any] | None = app.store.get(str(answer["pk"]), str(answer["sk"]))
    return found or answer
