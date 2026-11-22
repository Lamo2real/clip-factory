"""Small helpers of Lamo Stories' own agent: ids, time, logging and plain-language errors.

Written here on purpose (docs/CONTRACTS.md §45.24, ADR-76): this runtime imports nothing from Clip Factory's agent."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import UTC, datetime
from typing import Any

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid(now_ms: int | None = None, rand: bytes | None = None) -> str:
    """A 26-character ULID: 48 bits of milliseconds then 80 random bits, Crockford base32 (time-sortable)."""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    r = os.urandom(10) if rand is None else rand
    n = (ms << 80) | int.from_bytes(r, "big")
    return "".join(_CROCKFORD[(n >> (5 * i)) & 31] for i in reversed(range(26)))


def now_iso() -> str:
    """``2026-11-21T18:00:00.000Z``: the same form as every other timestamp in the table (§45.3)."""
    t = datetime.now(UTC)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def today() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


_AMZ_PARAM = re.compile(r"(X-Amz-[A-Za-z-]+)=[^&\s\"'<>]+", re.IGNORECASE)
_URL_LOGIN = re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^/\s:@\"'<>]+:[^/\s@\"'<>]+@", re.IGNORECASE)


def redact_urls(text: str) -> str:
    """``text`` with every ``X-Amz-*`` query value blanked (a presigned URL's credential, signature and token never
    reach a log line, §45.11.1) and any ``user:pass@`` in a URL blanked."""
    return _URL_LOGIN.sub(r"\1<redacted>@", _AMZ_PARAM.sub(r"\1=<redacted>", text))


def log(level: str, event: str, **fields: Any) -> None:
    """One JSON line per event on stdout (AgentCore ships it to the runtime's log group); strings are redacted."""
    fields = {k: redact_urls(v) if isinstance(v, str) else v for k, v in fields.items()}
    line = {"level": level, "event": event, "time": now_iso(), **fields}
    sys.stdout.write(json.dumps(line, default=str) + "\n")
    sys.stdout.flush()


class UserFacingError(Exception):
    """A failure whose message is written for the owner (it names the button to tap) and is shown as is."""


class TransientError(Exception):
    """A failure worth retrying (throttling, a network blip, a 5xx)."""


class JobCanceled(Exception):
    """The owner canceled the work."""


class JobSuperseded(JobCanceled):
    """The item's ``sessionId`` changed or it was canceled or settled (a refused fenced write): this run is stale. It
    stops and writes nothing more (§45.11.1: "A refused write ends the run")."""
