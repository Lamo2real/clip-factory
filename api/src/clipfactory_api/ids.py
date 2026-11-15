"""ULIDs (26 chars, Crockford base32, time-sortable) with the standard library only.

Ids made in the same millisecond by one process stay strictly increasing (the random part is incremented), so
"newest first" ordering by sort key never shuffles items created in a burst.
"""

from __future__ import annotations

import secrets
import threading
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_RANDOM_BITS = 80
_RANDOM_MAX = (1 << _RANDOM_BITS) - 1

_lock = threading.Lock()
_last_ms = -1
_last_random = 0


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def ulid(now_ms: int | None = None) -> str:
    global _last_ms, _last_random
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    with _lock:
        if ms <= _last_ms:
            # Same (or an earlier, after a clock step back) millisecond: keep ordering by bumping the last id.
            ms = _last_ms
            if _last_random >= _RANDOM_MAX:
                ms += 1
                _last_random = secrets.randbits(_RANDOM_BITS)
            else:
                _last_random += 1
        else:
            _last_random = secrets.randbits(_RANDOM_BITS)
        _last_ms = ms
        rand = _last_random
    return _encode(ms, 10) + _encode(rand, 16)


def is_ulid(value: object) -> bool:
    return isinstance(value, str) and len(value) == 26 and value[0] in "01234567" and all(c in ALPHABET for c in value)


def random_suffix(length: int = 8) -> str:
    """Lowercase letters and digits, for AgentCore session ids."""
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))
