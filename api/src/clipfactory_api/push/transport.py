"""What the push code needs without cryptography (imported by every API cold start): base64url and the HTTP post."""

from __future__ import annotations

import base64
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


# (url, headers, body, timeout) → HTTP status. Tests pass a fake push service.
Poster = Callable[[str, dict[str, str], bytes, float], int]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None  # a push service never redirects; the message is never re-sent anywhere else


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_post(url: str, headers: dict[str, str], body: bytes, timeout: float) -> int:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310 (allow-listed https)
    try:
        with _opener.open(request, timeout=timeout) as response:
            return int(response.status)
    except urllib.error.HTTPError as e:
        return int(e.code)
