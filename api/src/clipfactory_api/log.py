"""Structured JSON logs, one object per line, so CloudWatch Logs Insights can query fields.

Only ids, counts and outcomes are logged. Fields whose names suggest content or credentials are dropped, so a
careless call can never leak a caption, a presigned URL or a token.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import UTC, datetime

LogValue = str | int | float | bool | None

_BANNED = re.compile(r"content|text|body|secret|token|password|authorization|cookie|url$|caption", re.IGNORECASE)
_LEVELS = {"debug": 10, "info": 20, "warning": 30, "error": 40}


def _threshold() -> int:
    return _LEVELS.get(os.environ.get("LOG_LEVEL", "info").lower(), 20)


def safe_fields(fields: dict[str, LogValue]) -> dict[str, LogValue]:
    out: dict[str, LogValue] = {}
    for name, value in fields.items():
        if _BANNED.search(name):
            continue
        out[name] = value[:300] if isinstance(value, str) else value
    return out


def log(level: str, event: str, **fields: LogValue) -> None:
    if _LEVELS.get(level, 20) < _threshold():
        return
    line = {"level": level, "event": event, "ts": datetime.now(UTC).isoformat(), **safe_fields(fields)}
    print(json.dumps(line, default=str), file=sys.stdout, flush=True)
