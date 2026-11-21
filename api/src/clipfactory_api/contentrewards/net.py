"""HTTP for the CR client: one request, its own timeout, never a redirect (docs/CONTRACTS.md §38.9).

``Net = (HttpRequest, timeout seconds) -> HttpResponse``. Production uses ``urllib`` with redirects turned off (a 3xx
comes back as it is); tests record the requests and answer from fixtures. A request that never got an HTTP answer
raises ``NetworkError`` (``sent`` tells whether the request may have reached the server, which matters for a
single-use refresh token).
"""

from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from ..platforms.base import HttpRequest, HttpResponse

MAX_RESPONSE_BYTES = 2_000_000

Net = Callable[[HttpRequest, float], HttpResponse]


class NetworkError(Exception):
    def __init__(self, message: str, *, sent: bool = True) -> None:
        super().__init__(message)
        self.sent = sent


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def urllib_net(request: HttpRequest, timeout: float) -> HttpResponse:
    if not request.url.startswith("https://"):
        raise NetworkError("only https requests are allowed", sent=False)
    req = urllib.request.Request(request.url, data=request.body, method=request.method, headers=request.headers)  # noqa: S310
    try:
        with _opener.open(req, timeout=timeout) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return HttpResponse(resp.status, headers, resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as e:
        headers = {k.lower(): v for k, v in (e.headers.items() if e.headers else [])}
        return HttpResponse(e.code, headers, e.read(MAX_RESPONSE_BYTES))
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        # A refused connection or a failed DNS lookup never reached CR; anything else may have.
        sent = not isinstance(reason, ConnectionRefusedError | OSError) or isinstance(reason, TimeoutError)
        raise NetworkError(type(reason or e).__name__, sent=sent) from e
    except (TimeoutError, OSError) as e:
        raise NetworkError(type(e).__name__, sent=True) from e
