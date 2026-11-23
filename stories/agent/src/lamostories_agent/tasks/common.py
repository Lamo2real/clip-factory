"""Small shared pieces of Lamo Stories' creative agents: ids, times, keys, plain errors, log redaction.

Everything here belongs to builder E2's packages (``chat``, ``memory``, ``reference``, ``tasks``); builder E's own
helpers are not imported, so the two can change independently. Keys follow docs/CONTRACTS.md §45.3: every item lives
in its workspace's partition ``USER#{userId}#WS#{workspaceId}`` (never ``USER#{userId}`` itself, which is Clip Factory's).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
WORKSPACE_ID = re.compile(r"^(stories|[0-9A-HJKMNP-TV-Z]{26})$")  # never "clips": Clip Factory has no partition
SAFE_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$")
_PRESIGNED = re.compile(r"https://[^\s\"']*(X-Amz-Signature|X-Amz-Credential|Signature=)[^\s\"']*")


class TaskFailed(Exception):
    """The work stops with this plain sentence for the owner (it names the button, never raw tool output)."""


class Superseded(Exception):
    """The item this run works for was stopped, canceled or taken over by a newer run: write nothing more."""


class Refused(Exception):
    """A fenced write was refused by another item's condition (that item was deleted or changed), while the fence
    itself still holds: the run can still end its own item with a plain sentence."""


def ulid() -> str:
    """A ULID: 48 bits of milliseconds then 80 random bits, Crockford base32 (sortable by time)."""
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(out))


def now_iso() -> str:
    """``2026-11-21T18:00:00.000Z``: the same form as every other Lamo Stories and clip job timestamp."""
    at = datetime.now(UTC)
    return at.strftime("%Y-%m-%dT%H:%M:%S.") + f"{at.microsecond // 1000:03d}Z"


def ws_pk(user_id: str, workspace_id: str) -> str:
    if not user_id or "#" in user_id:
        raise ValueError("not a user id")
    if not WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Clips Funded workspace id")
    return f"USER#{user_id}#WS#{workspace_id}"


def registry_pk(user_id: str) -> str:
    return f"USER#{user_id}#WSREG"


def ws_prefix(user_id: str, workspace_id: str) -> str:
    """``ws/{userId}/{workspaceId}/``: the only S3 prefix Lamo Stories reads or writes (§45.4)."""
    ws_pk(user_id, workspace_id)
    return f"ws/{user_id}/{workspace_id}/"


def in_workspace(key: str, user_id: str, workspace_id: str) -> bool:
    """True when an S3 key read from an item really is under this workspace's own prefix."""
    return isinstance(key, str) and key.startswith(ws_prefix(user_id, workspace_id)) and ".." not in key


def owned(item: dict[str, Any] | None, user_id: str, workspace_id: str) -> bool:
    """The second, independent check (§45.3): the item's own ``userId`` and ``workspaceId`` match the request."""
    return bool(item) and item.get("userId") == user_id and item.get("workspaceId") == workspace_id  # type: ignore[union-attr]


def plain(value: Any) -> Any:
    """DynamoDB's Decimals as ints or floats, recursively (what the model and the web see)."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [plain(v) for v in value]
    return value


INTERNAL = frozenset(
    {
        "pk",
        "sk",
        "type",
        "userId",
        "ttl",
        "gsi1pk",
        "gsi1sk",
        "gsi2pk",
        "gsi2sk",
        "sessionId",
        "heartbeatAt",
        "key",
        "analysisKey",
        "scriptKey",
        "videoKey",
        "coverKey",
        "stillKeys",
        "requested",
        "override",
        "input",
        "summary",
        "summaryUpToMsgId",
    }
)


def public(item: dict[str, Any] | None) -> dict[str, Any]:
    """An item without its keys and internal attributes (what a tool or a task result may show)."""
    return {k: plain(v) for k, v in (item or {}).items() if k not in INTERNAL}


def redact(text: str) -> str:
    return _PRESIGNED.sub("[presigned link]", text)


def log(level: str, event: str, **fields: Any) -> None:
    """One JSON line on stderr; presigned links are redacted and long values cut."""
    out: dict[str, Any] = {"level": level, "event": event}
    for k, v in fields.items():
        out[k] = redact(v)[:1500] if isinstance(v, str) else v
    with contextlib.suppress(Exception):  # logging must never break the work
        sys.stderr.write(json.dumps(out, default=str) + "\n")


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_dict(value: Any) -> dict[str, Any]:
    """``value`` when it is a map, else an empty one (items read from the table or a model are never trusted)."""
    return value if isinstance(value, dict) else {}


def clip(text: Any, limit: int) -> str:
    """A string trimmed and cut to ``limit`` characters (never raises)."""
    return str(text if text is not None else "").strip()[:limit]
