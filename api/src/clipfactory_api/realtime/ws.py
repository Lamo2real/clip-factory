"""``cf-prod-ws``: the WebSocket routes ``$connect``, ``$disconnect`` and ``$default`` (docs/CONTRACTS.md §14.2).

``$connect`` (already authorized) stores a Connection item under the owner with a 2-hour ``ttl`` (API Gateway ends
every connection after 2 hours anyway). ``$disconnect`` removes it. ``$default`` answers ``{"action": "ping"}``
with a pong and ``{"action": "whoami"}`` with ``{"type": "whoami", "connectionId"}`` (Ask streams its answers to that
connection, §28.5); anything else gets ``{"type": "error", "code": "bad_request"}``. Every route answers 200.
"""

from __future__ import annotations

import faulthandler
import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .. import db
from ..clock import Clock, iso, utcnow
from ..log import log
from . import encode, is_gone, management_client

DEFAULT_TTL_SECONDS = 7200
# The pong is optional (the ping itself keeps the connection alive) and the Lambda stops at 10 s: one try of at most
# 4 s, so a slow reply is logged as ws.reply_failed instead of timing the whole invocation out (CONTRACTS §14.2).
REPLY_READ_TIMEOUT_SECONDS = 4
MAX_MESSAGE_BYTES = 4096
OK = {"statusCode": 200}


@dataclass
class WsDeps:
    store: db.Store
    management: Any
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    clock: Clock = field(default=utcnow)


def connection_item(user_id: str, connection_id: str, now_epoch: int, now_iso: str, ttl_seconds: int) -> dict[str, Any]:
    return {
        "pk": db.user_pk(user_id),
        "sk": db.conn_sk(connection_id),
        "gsi1pk": db.conn_sk(connection_id),
        "gsi1sk": "CONN",
        "type": "conn",
        "userId": user_id,
        "connectionId": connection_id,
        "connectedAt": now_iso,
        "ttl": now_epoch + ttl_seconds,
    }


def _authorized_sub(context: Mapping[str, Any]) -> str:
    authorizer = context.get("authorizer") or {}
    sub = authorizer.get("sub") if isinstance(authorizer, Mapping) else None
    return sub if isinstance(sub, str) else ""


def handle(event: Mapping[str, Any], deps: WsDeps) -> dict[str, Any]:
    context = event.get("requestContext") or {}
    route = str(context.get("routeKey") or "")
    connection_id = str(context.get("connectionId") or "")
    if not connection_id:
        log("error", "ws.no_connection", route=route)
        return OK
    if route == "$connect":
        return _connect(deps, context, connection_id)
    if route == "$disconnect":
        return _disconnect(deps, context, connection_id)
    return _default(deps, event, connection_id)


def _connect(deps: WsDeps, context: Mapping[str, Any], connection_id: str) -> dict[str, Any]:
    sub = _authorized_sub(context)
    if not sub:  # the authorizer always sets it; refuse rather than store an ownerless connection
        log("error", "ws.connect_without_sub", connectionId=connection_id)
        return {"statusCode": 401}
    now = deps.clock()
    deps.store.put(connection_item(sub, connection_id, int(now.timestamp()), iso(now), deps.ttl_seconds))
    log("info", "ws.connected", connectionId=connection_id)
    return OK


def _disconnect(deps: WsDeps, context: Mapping[str, Any], connection_id: str) -> dict[str, Any]:
    try:
        sub = _authorized_sub(context)
        if sub:
            deps.store.delete(db.user_pk(sub), db.conn_sk(connection_id))
        else:
            for item in deps.store.query_all(db.conn_sk(connection_id), "CONN", index="gsi1"):
                if item.get("type") == "conn":
                    deps.store.delete(item["pk"], item["sk"])
    except Exception as e:  # the ttl removes it later anyway
        log("warning", "ws.disconnect_cleanup_failed", connectionId=connection_id, error=type(e).__name__)
    log("info", "ws.disconnected", connectionId=connection_id)
    return OK


def _default(deps: WsDeps, event: Mapping[str, Any], connection_id: str) -> dict[str, Any]:
    raw = event.get("body") or ""
    message: Any = None
    if isinstance(raw, str) and len(raw) <= MAX_MESSAGE_BYTES:
        try:
            message = json.loads(raw)
        except ValueError:
            message = None
    if isinstance(message, dict) and message.get("action") == "ping":
        reply: dict[str, Any] = {"type": "pong", "at": iso(deps.clock())}
    elif isinstance(message, dict) and message.get("action") == "whoami":
        reply = {"type": "whoami", "connectionId": connection_id}
    else:
        reply = {"type": "error", "code": "bad_request"}
    try:
        deps.management.post_to_connection(ConnectionId=connection_id, Data=encode(reply))
    except Exception as e:
        if is_gone(e):
            log("info", "ws.reply_gone", connectionId=connection_id)
        else:
            log("warning", "ws.reply_failed", connectionId=connection_id, error=type(e).__name__)
    return OK


_deps: WsDeps | None = None


def _from_env() -> WsDeps:
    from ..app import table

    env = os.environ
    return WsDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        management=management_client(env["WS_ENDPOINT"], read_timeout=REPLY_READ_TIMEOUT_SECONDS, max_attempts=1),
        ttl_seconds=int(env.get("CONN_TTL_SECONDS") or DEFAULT_TTL_SECONDS),
    )


def get_deps(factory: Callable[[], WsDeps] = _from_env) -> WsDeps:
    global _deps
    if _deps is None:
        _deps = factory()
    return _deps


def warm() -> None:
    """Build the clients while Lambda is still initialising (full CPU, its own time budget), not inside the 10 s call."""
    if not (os.environ.get("TABLE_NAME") and os.environ.get("WS_ENDPOINT")):
        return
    try:
        get_deps()
    except Exception as e:  # the first call tries again and reports it
        log("error", "ws.init_failed", error=type(e).__name__)


warm()

HANG_DUMP_SECONDS = 8


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    # A call still running at 8 s (the limit is 10) writes its stack to the log: the next hang names its own line.
    faulthandler.dump_traceback_later(HANG_DUMP_SECONDS, exit=False)
    try:
        return handle(event, get_deps())
    finally:
        faulthandler.cancel_dump_traceback_later()
