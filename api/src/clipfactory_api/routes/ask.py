"""Ask as a full assistant: start, stop, files and the web search key (docs/CONTRACTS.md §27.6).

``POST /v1/help/asks`` checks the question and starts ``cf-prod-ask`` with an async Invoke; the answer streams back
over the owner's WebSocket. Order of work: JWT (as every route) → kill switch (``assistant``) → parse (≤ 200 KB) →
the connection is the owner's → rate limit (the §19.6 item, plus ≤ 400 a day) → the secrets refusal on the typed
words (no model call, its files deleted) → Invoke. The question, history and file names are never logged.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .. import db
from ..app import App
from ..errors import ApiError
from ..http import Request, Response, no_content, ok
from ..log import LogValue, log

ASK_MAX_BODY = 200_000
QUESTION_CHARS = 4000
USER_TURN_CHARS = 4000
ASSISTANT_TURN_CHARS = 12_000
HISTORY_CHARS = 90_000
HISTORY_TURNS = 60
UUID4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CONNECTION_ID = re.compile(r"^[A-Za-z0-9=_+/-]{4,128}$")
MIME = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,40}/[a-z0-9][a-z0-9.+-]{0,60}$")
FORMAT = re.compile(r"^[A-Z0-9]{1,5}$")
STOP_TTL_S = 600
PRESIGN_S = 300
KEY_CHARS = 200

BAD_QUESTION = "Ask a question with up to 4,000 letters."
TOO_MANY_FILES = "You can send 10 files at a time."
FILE_TOO_BIG = "That file is too big. The most is 25 MB."
FILES_TOO_BIG = "Those files are too big together. The most is 50 MB."
OFF = "Ask is turned off right now."
NOT_LIVE = "Ask lost its live link. Trying again."
RATE_LIMITED = "Let's take a short break. Ask again in a minute."
UNAVAILABLE = "Ask can't answer right now."
BAD_KEY = "That key didn't work. Check you copied all of it."


def _bad(message: str = BAD_QUESTION) -> ApiError:
    return ApiError(400, "bad_request", message)


def _unavailable() -> ApiError:
    return ApiError(503, "unavailable", UNAVAILABLE)


def _switch(app: App) -> Any:
    from ..help import guard

    try:
        switch = guard.check_switch(app.store, app.clock(), flag_enabled=app.help.enabled)
    except guard.GuardUnavailable:
        raise _unavailable() from None
    if not switch.enabled or not switch.assistant or not app.ask.ready:
        raise ApiError(403, "help_off", OFF)
    return switch


def web_state(app: App, switch: Any) -> str:
    """ "on" when a search key is saved, "no_key" when not, "off" by the kill switch."""
    if not switch.web:
        return "off"
    if app.ask.secrets is None:
        return "no_key"
    try:
        app.ask.secrets.describe_secret(SecretId=app.ask.search_secret)
    except Exception:
        return "no_key"
    return "on"


def assistant_status(app: App, switch: Any) -> dict[str, Any]:
    """The ``assistant`` field of ``GET /v1/help`` (§27.6)."""
    from ..ask.files import LIMITS

    on = bool(switch.enabled and switch.assistant and app.ask.ready)
    return {
        "on": on,
        "web": web_state(app, switch) if on else "off",
        "files": bool(on and switch.files),
        "limits": dict(LIMITS),
    }


# --- POST /v1/help/files ----------------------------------------------------------------------------------------


def create_files(app: App, req: Request) -> Response:
    from ..ask import files as askfiles
    from ..help import guard

    switch = _switch(app)
    if not switch.files:
        raise ApiError(403, "help_off", "Files are off right now. Tell me in words.")
    body = req.json()
    raw = body.get("files")
    if set(body) != {"files"} or not isinstance(raw, list) or not raw:
        raise _bad("Add a file first.")
    if len(raw) > askfiles.FILES_PER_QUESTION:
        raise _bad(TOO_MANY_FILES)
    wanted: list[tuple[str, str, int, askfiles.Kind]] = []
    for f in raw:
        if not isinstance(f, dict) or set(f) != {"name", "type", "size"}:
            raise _bad("That file does not look right.")
        name, mime, size = f["name"], f["type"], f["size"]
        if not isinstance(name, str) or not name or len(name) > askfiles.NAME_MAX:
            raise _bad("That file name is too long.")
        if not isinstance(mime, str) or len(mime) > askfiles.TYPE_MAX:
            raise _bad("That file does not look right.")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise _bad("That file is empty.")
        if size > askfiles.BYTES_PER_FILE:
            raise _bad(FILE_TOO_BIG)
        try:
            kind = askfiles.kind_of(name, mime)
        except askfiles.FileRefused as e:
            raise _bad(e.message) from None
        content_type = mime.lower() if MIME.match(mime.lower()) else "application/octet-stream"
        wanted.append((name, content_type, size, kind))
    total = sum(w[2] for w in wanted)
    if total > askfiles.BYTES_PER_QUESTION:
        raise _bad(FILES_TOO_BIG)
    try:
        wait = guard.reserve_files(
            app.store,
            req.user_id,
            app.clock(),
            count=len(wanted),
            size=total,
            per_day=askfiles.FILES_PER_DAY,
            bytes_per_day=askfiles.FILE_BYTES_PER_DAY,
        )
    except guard.GuardUnavailable:
        raise _unavailable() from None
    if wait is not None:
        raise ApiError(
            429,
            "rate_limited",
            "You sent lots of files today. Try again tomorrow.",
            extra={"retryAfter": wait},
            headers={"Retry-After": str(wait)},
        )
    out = []
    for _name, content_type, size, kind in wanted:
        file_id = askfiles.new_file_id()
        url = app.media.presign_put_sized(askfiles.file_key(req.user_id, file_id), content_type, size, PRESIGN_S)
        out.append(
            {
                "fileId": file_id,
                "kind": kind,
                "url": url,
                "headers": {"Content-Type": content_type, "Content-Length": str(size)},
                "expiresIn": PRESIGN_S,
            }
        )
    log("info", "help.files", count=len(out), kb=round(total / 1024))
    return ok({"files": out})


def delete_file(app: App, req: Request) -> Response:
    from ..ask import files as askfiles

    file_id = req.params["fileId"]
    if not askfiles.FILE_ID.match(file_id):
        raise _bad("That file does not look right.")
    try:
        app.media.delete(askfiles.file_key(req.user_id, file_id))
    except Exception as e:  # best effort; the 1-day rule removes it anyway
        log("warning", "help.file_delete_failed", error=type(e).__name__)
    return no_content()


# --- POST /v1/help/asks -----------------------------------------------------------------------------------------


def _history(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > HISTORY_TURNS:
        raise _bad()
    out, total = [], 0
    for turn in raw:
        if not isinstance(turn, dict) or not {"role", "text"} <= set(turn) <= {"role", "text", "files"}:
            raise _bad()
        role, text = turn["role"], turn["text"]
        if role not in {"user", "assistant"} or not isinstance(text, str):
            raise _bad()
        if len(text) > (USER_TURN_CHARS if role == "user" else ASSISTANT_TURN_CHARS):
            raise _bad()
        kept: dict[str, Any] = {"role": role, "text": text}
        files = turn.get("files")
        if files is not None:
            if role != "user" or not isinstance(files, list) or len(files) > 10:
                raise _bad()
            names = []
            for f in files:
                if not isinstance(f, dict) or set(f) != {"name", "format"}:
                    raise _bad()
                if not isinstance(f["name"], str) or not isinstance(f["format"], str):
                    raise _bad()
                names.append({"name": f["name"][:120], "format": f["format"][:8]})
            kept["files"] = names
        total += len(text)
        out.append(kept)
    if total > HISTORY_CHARS:
        raise _bad()
    return out


def _file_refs(raw: Any) -> list[dict[str, Any]]:
    from ..ask import files as askfiles

    if raw is None:
        return []
    if not isinstance(raw, list):
        raise _bad()
    if len(raw) > askfiles.FILES_PER_QUESTION:
        raise _bad(TOO_MANY_FILES)
    out = []
    for f in raw:
        if not isinstance(f, dict) or not {"fileId", "name", "format", "kind"} <= set(f) <= {
            "fileId",
            "name",
            "format",
            "kind",
            "carried",
        }:
            raise _bad("That file does not look right.")
        if not isinstance(f["fileId"], str) or not askfiles.FILE_ID.match(f["fileId"]):
            raise _bad("That file does not look right.")
        if f["kind"] not in {"image", "pdf", "text", "office"} or not isinstance(f["name"], str):
            raise _bad("That file does not look right.")
        if not isinstance(f["format"], str) or not FORMAT.match(f["format"]):
            raise _bad("That file does not look right.")
        if "carried" in f and not isinstance(f["carried"], bool):
            raise _bad("That file does not look right.")
        out.append(
            {
                "fileId": f["fileId"],
                "name": f["name"][: askfiles.NAME_MAX],
                "format": f["format"],
                "kind": f["kind"],
                "carried": bool(f.get("carried")),
            }
        )
    if len({f["fileId"] for f in out}) != len(out):
        raise _bad("That file does not look right.")
    return out


def _parse(req: Request) -> dict[str, Any]:
    from .help import _parse_context

    try:
        body = req.json(max_bytes=ASK_MAX_BODY)
    except ApiError:
        raise _bad() from None
    allowed = {"askId", "connectionId", "question", "history", "context", "files"}
    if set(body) - allowed or not {"askId", "connectionId", "question"} <= set(body):
        raise _bad()
    ask_id, connection_id, question = body["askId"], body["connectionId"], body["question"]
    if not isinstance(ask_id, str) or not UUID4.match(ask_id):
        raise _bad()
    if not isinstance(connection_id, str) or not CONNECTION_ID.match(connection_id):
        raise _bad()
    if not isinstance(question, str):
        raise _bad()
    question = question.strip()
    files = _file_refs(body.get("files"))
    if not (0 if files else 1) <= len(question) <= QUESTION_CHARS:
        raise _bad()
    context = _parse_context(body.get("context"))
    return {
        "askId": ask_id,
        "connectionId": connection_id,
        "question": question,
        "history": _history(body.get("history")),
        "context": {k: v for k, v in (context.__dict__ if context else {}).items() if v is not None},
        "files": files,
    }


def start(app: App, req: Request) -> Response:
    record: dict[str, LogValue] = {"outcome": "ask_error"}
    try:
        return _start(app, req, record)
    finally:
        log("info", "help.ask_start", requestId=req.request_id, **record)


def _start(app: App, req: Request, record: dict[str, LogValue]) -> Response:
    from ..ask import files as askfiles
    from ..ask.redact import REFUSED_ANSWER, refused
    from ..help import guard

    try:
        switch = _switch(app)
    except ApiError as e:
        record["outcome"] = "ask_off" if e.status == 403 else "ask_error"
        raise
    try:
        body = _parse(req)
    except ApiError:
        record["outcome"] = "ask_bad_body"
        raise
    record["askId"] = body["askId"]
    record["files"] = len(body["files"])
    try:
        conn = app.store.get(db.user_pk(req.user_id), db.conn_sk(body["connectionId"]))
    except Exception:
        raise _unavailable() from None
    if not conn:
        record["outcome"] = "ask_not_live"
        raise ApiError(409, "not_live", NOT_LIVE)
    try:
        reserved = guard.reserve_question(
            app.store,
            req.user_id,
            app.clock(),
            per_minute=app.help.rate_per_minute,
            per_hour=app.help.rate_per_hour,
            asks_per_day=app.ask.asks_per_day,
        )
    except guard.GuardUnavailable:
        raise _unavailable() from None
    if reserved.wait is not None:
        record["outcome"] = "ask_rate_limited"
        raise ApiError(
            429,
            "rate_limited",
            RATE_LIMITED,
            extra={"retryAfter": reserved.wait},
            headers={"Retry-After": str(reserved.wait)},
        )
    if body["question"] and refused(body["question"]):
        record["outcome"] = "ask_refused_secret"
        for f in body["files"]:
            try:
                app.media.delete(askfiles.file_key(req.user_id, f["fileId"]))
            except Exception as e:
                log("warning", "help.file_delete_failed", error=type(e).__name__)
        return ok({"askId": body["askId"], "refused": True, "text": REFUSED_ANSWER})
    payload = {
        "askId": body["askId"],
        "sub": req.user_id,
        "connectionId": body["connectionId"],
        "requestId": req.request_id,
        "flags": {"web": switch.web, "files": switch.files},
        "body": {k: body[k] for k in ("question", "history", "context", "files")},
    }
    data = json.dumps(payload, separators=(",", ":")).encode()
    try:
        app.ask.lambda_client.invoke(FunctionName=app.ask.function_name, InvocationType="Event", Payload=data)
    except Exception as e:
        record["outcome"] = "ask_error"
        log("error", "help.ask_invoke_failed", error=type(e).__name__)
        raise _unavailable() from None
    record["outcome"] = "ask_started"
    return ok({"askId": body["askId"]}, 202)


def stop(app: App, req: Request) -> Response:
    from ..ask.worker import stop_sk

    ask_id = req.params["askId"]
    if not UUID4.match(ask_id):
        raise _bad("That answer does not look right.")
    now = app.clock()
    try:
        app.store.put(
            {
                "pk": db.user_pk(req.user_id),
                "sk": stop_sk(ask_id),
                "type": "ask_stop",
                "ttl": int(now.timestamp()) + STOP_TTL_S,
            }
        )
    except Exception:
        raise _unavailable() from None
    return no_content()


# --- the web search key -------------------------------------------------------------------------------------


def put_search_key(app: App, req: Request) -> Response:
    _switch(app)
    body = req.json()
    key = body.get("key")
    if set(body) != {"key"} or not isinstance(key, str) or not key.strip() or len(key) > KEY_CHARS:
        raise _bad(BAD_KEY)
    key = key.strip()
    if app.ask.check_key is not None and not app.ask.check_key(key):
        log("info", "help.search_key", outcome="rejected")
        raise _bad(BAD_KEY)
    secrets = app.ask.secrets
    if secrets is None:
        raise _unavailable()
    name = app.ask.search_secret
    try:
        try:
            secrets.put_secret_value(SecretId=name, SecretString=key)
        except Exception as e:
            if (getattr(e, "response", None) or {}).get("Error", {}).get("Code") != "ResourceNotFoundException":
                raise
            secrets.create_secret(
                Name=name,
                SecretString=key,
                Tags=[{"Key": "app", "Value": "clip-factory"}, {"Key": "area", "Value": "ask"}],
            )
    except Exception as e:
        log("warning", "help.search_key_failed", error=type(e).__name__)
        raise _unavailable() from None
    log("info", "help.search_key", outcome="saved")
    return no_content()


def delete_search_key(app: App, req: Request) -> Response:
    _switch(app)
    secrets = app.ask.secrets
    if secrets is None:
        raise _unavailable()
    try:
        secrets.delete_secret(SecretId=app.ask.search_secret, ForceDeleteWithoutRecovery=True)
    except Exception as e:
        if (getattr(e, "response", None) or {}).get("Error", {}).get("Code") != "ResourceNotFoundException":
            log("warning", "help.search_key_failed", error=type(e).__name__)
            raise _unavailable() from None
    log("info", "help.search_key", outcome="removed")
    return no_content()
