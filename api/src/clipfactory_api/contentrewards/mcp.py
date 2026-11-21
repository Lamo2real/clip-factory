"""``McpClient``: CR's MCP server over plain JSON-RPC POSTs (docs/CONTRACTS.md §38.9 "MCP calls").

One JSON-RPC message per ``POST {MCP_URL}``; headers ``MCP-Protocol-Version``, ``Api-Version``, ``Mcp-Name`` (on
``tools/call``), ``User-Agent`` and the bearer token, and **never** ``Origin`` (CR answers 403 to any request that has
one). ``initialize`` (+ ``notifications/initialized``) once per client (one per container: the server is
sessionless). An event-stream body is read from its last ``data:`` line. A tool's result is
``result.structuredContent``; ``isError`` results carry the error object as text. At most 2 calls a second.

Untrusted text in results (names, briefs, links, review comments) is data: never logged, escaped on the web.
"""

from __future__ import annotations

import json
import re
import time
from collections import deque
from collections.abc import Callable, Mapping
from typing import Any

from ..clock import Clock
from ..log import log
from ..platforms.base import HttpRequest, HttpResponse
from . import config, connection
from .net import Net, NetworkError
from .tokens import CrTokens, TokenError

Item = dict[str, Any]
_RETRY_SECONDS = re.compile(r"(\d+(?:\.\d+)?)\s*(?:s\b|sec|second)", re.IGNORECASE)
_SCOPE = re.compile(r'scope="([^"]*)"')
BUG_CODES = frozenset({"invalid_request", "invalid_id", "idempotency_key_reused", "context_not_allowed"})
_feedback_sent: dict[str, float] = {}


class CrError(Exception):
    """One refused or failed MCP call.

    ``code``: CR's error ``code`` when there is one; else ``firewall`` (HTTP 403 with no error object), ``network``,
    ``server_error`` (5xx with no error object), ``jsonrpc`` (with ``jsonrpc``), ``not_connected``, ``token_dead`` or
    ``platform_down`` (the token could not be had now). ``tool_result``: the error came inside a tool result."""

    def __init__(
        self,
        code: str,
        *,
        detail: str = "",
        status: int = 0,
        retry_after: float | None = None,
        jsonrpc: int | None = None,
        scopes: tuple[str, ...] = (),
        request_id: str = "",
        tool_result: bool = False,
        sent: bool = True,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail[:500]
        self.status = status
        self.retry_after = retry_after
        self.jsonrpc = jsonrpc
        self.scopes = scopes
        self.request_id = request_id
        self.tool_result = tool_result
        self.sent = sent

    @property
    def retryable(self) -> bool:
        return self.code in {
            "network",
            "server_error",
            "service_unavailable",
            "timeout",
            "rate_limited",
            "firewall",
            "platform_down",
            "internal_error",
            "upstream_unavailable",
        }


def _error_object(text: Any) -> Item | None:
    if isinstance(text, Mapping):
        return dict(text)
    if not isinstance(text, str | bytes):
        return None
    try:
        found = json.loads(text)
    except ValueError:
        return None
    return dict(found) if isinstance(found, Mapping) else None


def _from_object(
    obj: Mapping[str, Any],
    *,
    status: int,
    tool_result: bool,
    retry_after: float | None = None,
    scopes: tuple[str, ...] = (),
) -> CrError:
    code = str(obj.get("code") or "")
    detail = str(obj.get("detail") or "")
    wait = retry_after
    if code == "rate_limited" and wait is None:
        found = _RETRY_SECONDS.search(detail)
        wait = float(found.group(1)) if found else None
    return CrError(
        code or ("server_error" if status >= 500 else "error"),
        detail=detail,
        status=int(obj.get("status") or status or 0),
        retry_after=wait,
        scopes=scopes,
        request_id=str(obj.get("request_id") or ""),
        tool_result=tool_result,
    )


def parse_body(response: HttpResponse) -> Any:
    """The JSON-RPC message of a JSON body or of an event stream's last ``data:`` line."""
    raw = response.body.decode("utf-8", errors="replace")
    ctype = response.headers.get("content-type", "")
    if "text/event-stream" in ctype or raw.lstrip().startswith(("event:", "data:")):
        data = [line[5:].strip() for line in raw.splitlines() if line.startswith("data:")]
        raw = data[-1] if data else ""
    try:
        return json.loads(raw) if raw.strip() else None
    except ValueError:
        return None


class McpClient:
    def __init__(
        self,
        net: Net,
        tokens: CrTokens,
        user_id: str,
        clock: Clock,
        *,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.net = net
        self.tokens = tokens
        self.user_id = user_id
        self.clock = clock
        self.sleep = sleep
        self.monotonic = monotonic
        self.initialized = False
        self.calls = 0  # tool calls made by this client (the poller's per-owner cap)
        self._ids = 0
        self._recent: deque[float] = deque(maxlen=config.CALLS_PER_SECOND)
        self._tools: set[str] | None = None

    # --- public ------------------------------------------------------------------------------------------------

    def call(self, tool: str, args: Mapping[str, Any] | None = None, timeout: float = config.READ_TIMEOUT) -> Item:
        self._initialize()
        message = {"name": tool, "arguments": dict(args or {})}
        result = self._rpc("tools/call", message, timeout=timeout, tool=tool)
        self.calls += 1
        if not isinstance(result, Mapping):
            raise CrError("server_error", detail="no result")
        if result.get("isError"):
            content = result.get("content") or []
            text = content[0].get("text") if content and isinstance(content[0], Mapping) else None
            obj = _error_object(text) or {"code": "error"}
            err = _from_object(obj, status=200, tool_result=True)
            if err.code == "permission_denied" and tool != "create_my_submission":
                self._blocked()
            raise err
        structured = result.get("structuredContent")
        if isinstance(structured, Mapping):
            return dict(structured)
        content = result.get("content") or []
        text = content[0].get("text") if content and isinstance(content[0], Mapping) else None
        return _error_object(text) or {}

    def tools(self) -> set[str]:
        if self._tools is None:
            self._initialize()
            result = self._rpc("tools/list", {}, timeout=config.READ_TIMEOUT)
            rows = result.get("tools") if isinstance(result, Mapping) else None
            self._tools = {str(t.get("name")) for t in rows or [] if isinstance(t, Mapping)}
        return set(self._tools)

    def list_all(self, tool: str, args: Mapping[str, Any], max_pages: int) -> tuple[list[Item], bool]:
        """Every row (upserted by ``id``), following ``next_cursor`` until ``has_more`` is false or ``max_pages``;
        ``(rows, complete)``. An ``invalid_cursor`` restarts the list once."""
        restarted = False
        while True:
            rows: dict[str, Item] = {}
            cursor: str | None = None
            try:
                for _ in range(max_pages):
                    page_args = {**args, "limit": config.PAGE_LIMIT}
                    if cursor:
                        page_args["cursor"] = cursor
                    page = self.call(tool, page_args)
                    for row in page.get("data") or []:
                        if isinstance(row, Mapping):
                            rows[str(row.get("id") or len(rows))] = dict(row)
                    cursor = page.get("next_cursor") if isinstance(page.get("next_cursor"), str) else None
                    if not page.get("has_more") or not cursor:
                        return list(rows.values()), True
                return list(rows.values()), False
            except CrError as e:
                if e.code == "invalid_cursor" and not restarted:
                    restarted = True
                    continue
                raise

    def feedback(self, code: str, tool: str, request_id: str = "") -> None:
        """An unknown or bug error, at most once per code per day per container; no personal data, URLs or tokens."""
        now = self.monotonic()
        if now - _feedback_sent.get(code, -1e9) < 86400:
            return
        _feedback_sent[code] = now
        args: Item = {
            "kind": "bug",
            "message": f"Clip Factory got the error code {code} from {tool}.",
            "about_tool": tool,
            "agent_name": config.AGENT_NAME,
            "agent_version": config.AGENT_VERSION,
        }
        if re.fullmatch(r"req_[0-7][0-9a-hjkmnp-tv-z]{25}", request_id or ""):
            args["about_request_id"] = request_id
        try:
            self.call("send_feedback", args)
        except CrError as e:
            log("warning", "cr.feedback_failed", code=e.code)

    # --- JSON-RPC ------------------------------------------------------------------------------------------------

    def _initialize(self) -> None:
        if self.initialized:
            return
        self._rpc(
            "initialize",
            {
                "protocolVersion": config.PROTOCOL,
                "capabilities": {},
                "clientInfo": {"name": config.AGENT_NAME, "version": config.AGENT_VERSION},
            },
            timeout=config.READ_TIMEOUT,
        )
        self._rpc("notifications/initialized", None, timeout=config.READ_TIMEOUT, notify=True)
        self.initialized = True

    def _pace(self) -> None:
        if len(self._recent) == self._recent.maxlen:
            wait = 1.0 - (self.monotonic() - self._recent[0])
            if wait > 0:
                self.sleep(wait)
        self._recent.append(self.monotonic())

    def _rpc(self, method: str, params: Any, *, timeout: float, tool: str | None = None, notify: bool = False) -> Any:
        try:
            access = self.tokens.access(self.user_id)
        except TokenError as e:
            raise CrError(
                {"not_connected": "not_connected", "dead": "token_dead"}.get(e.kind, "platform_down"), sent=False
            ) from e
        response = self._post(method, params, access.token, timeout=timeout, tool=tool, notify=notify)
        if response.status == 401:
            try:
                access = self.tokens.access(self.user_id, stale=access.token)
            except TokenError as e:
                raise CrError(
                    "token_dead" if e.kind in {"dead", "not_connected"} else "platform_down", sent=False
                ) from e
            response = self._post(method, params, access.token, timeout=timeout, tool=tool, notify=notify)
            if response.status == 401:
                self._dead()
                raise CrError("invalid_token", status=401)
        if response.status >= 300:
            raise self._http_error(response, tool)
        if access.conn.get("blocked"):
            self._unblock()
        if notify:
            return None
        message = parse_body(response)
        if not isinstance(message, Mapping):
            raise CrError("server_error", status=response.status, detail="not JSON-RPC")
        error = message.get("error")
        if isinstance(error, Mapping):
            code = error.get("code")
            raise CrError(
                "jsonrpc", jsonrpc=code if isinstance(code, int) else None, detail=str(error.get("message") or "")
            )
        return message.get("result")

    def _post(
        self, method: str, params: Any, token: str, *, timeout: float, tool: str | None, notify: bool
    ) -> HttpResponse:
        body: Item = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            self._ids += 1
            body["id"] = self._ids
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": config.PROTOCOL,
            "Api-Version": config.API_VERSION,
            "Authorization": f"Bearer {token}",
            "User-Agent": config.USER_AGENT,
        }
        if tool:
            headers["Mcp-Name"] = tool
        self._pace()
        try:
            return self.net(HttpRequest("POST", config.MCP_URL, headers, json.dumps(body).encode()), timeout)
        except NetworkError as e:
            raise CrError("network", sent=e.sent) from e

    def _http_error(self, response: HttpResponse, tool: str | None = None) -> CrError:
        obj = _error_object(response.body)
        wait = None
        raw = response.headers.get("retry-after")
        try:
            wait = float(raw) if raw is not None else None
        except ValueError:
            wait = None
        if response.status == 403:
            if obj is None or not obj.get("code"):
                return CrError("firewall", status=403)
            code = str(obj.get("code"))
            if code == "insufficient_scope":
                found = _SCOPE.search(response.headers.get("www-authenticate", ""))
                scopes = tuple(found.group(1).split()) if found else ()
                if not scopes and tool == "create_my_submission":
                    scopes = (config.WRITE_SCOPE,)
                self._missing(scopes)
                return _from_object(obj, status=403, tool_result=False, scopes=scopes)
            if code == "permission_denied":
                self._blocked()
            return _from_object(obj, status=403, tool_result=False)
        if response.status == 429:
            err = _from_object(obj or {"code": "rate_limited"}, status=429, tool_result=False, retry_after=wait)
            err.code = "rate_limited"
            return err
        if obj is not None and obj.get("code"):
            return _from_object(obj, status=response.status, tool_result=False, retry_after=wait)
        return CrError("server_error" if response.status >= 500 else "error", status=response.status, retry_after=wait)

    # --- what CR's answers teach CRCONN --------------------------------------------------------------------------

    def _blocked(self) -> None:
        now = self.clock()
        connection.update(
            self.tokens.store, self.user_id, now, {"blocked": True, "check": connection.check("blocked", now)}
        )
        log("error", "cr.blocked")

    def _unblock(self) -> None:
        now = self.clock()
        connection.update(
            self.tokens.store, self.user_id, now, {"check": connection.check("ok", now)}, remove=["blocked"]
        )

    def _missing(self, scopes: tuple[str, ...]) -> None:
        now = self.clock()
        conn = connection.load(self.tokens.store, self.user_id)
        missing = sorted({*(conn.get("missing") or []), *scopes})
        fields: Item = {"missing": missing}
        if config.WRITE_SCOPE in scopes:
            fields.update({"status": "read_only", "canSubmit": False})
        if not scopes or any(s in config.READ_SCOPES for s in scopes):
            fields["reason"] = "missing_permissions"
        if connection.signed_in(conn):
            connection.update(self.tokens.store, self.user_id, now, fields)

    def _dead(self) -> None:
        now = self.clock()
        connection.update(
            self.tokens.store,
            self.user_id,
            now,
            {"status": "needs_reconnect", "reason": "token_dead", "check": connection.check("token_dead", now)},
        )
        log("warning", "cr.token_dead")


def read_only_tool(client: McpClient) -> None:
    """``-32602`` on ``create_my_submission``: the tool is not offered to this sign-in."""
    now = client.clock()
    connection.update(client.tokens.store, client.user_id, now, {"status": "read_only", "canSubmit": False})
