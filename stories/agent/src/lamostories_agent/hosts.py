"""The keyed hosts of the models the owner adds (docs/CONTRACTS.md §45.37 G4): the Anthropic API, any https base URL
that speaks the OpenAI chat-completions API, and ElevenLabs (sound effects and instrumental music only), each called
with the owner's own key.

* **Keys.** Each lives only in Secrets Manager, ``cf-prod/workspaces/{workspaceId}/providers/{host}`` (JSON
  ``{"key": …}``, written by the API's provider-keys route), and is read per call for the workspace the call works
  for (``ProviderKeys``); it is never logged, stored, sent anywhere else or returned. This runtime's role may read
  only ``…/workspaces/*/providers/*`` (infra/modules/stories_agent).
* **One shape.** Each host takes the model client's Converse-shaped request (system blocks, messages, tool specs) and
  answers in the same shape (content blocks, a stop reason, usage), so ``models.BedrockModels`` keeps one contract
  for every host: the effort only where that API takes it (the Anthropic API's ``output_config.effort``, an
  OpenAI-compatible ``reasoning_effort``), tools with automatic choice, a refusal as the ``refusal`` stop reason,
  usage recorded by the client. No host ever falls back to another model: the Anthropic API's server-side
  ``fallbacks`` is never sent, which would be a silent substitution (§45.25).
* **Errors.** A host's refusal is a ``HostError``, shaped like a botocore ``ClientError`` (``response``: an error
  code and the HTTP status), so the client's retry (``retry.is_transient``: 429, 5xx, timeouts) and its plain sentences
  read every host the same way; ``found`` carries the model's status and the reason in words when the host refused the
  key or the model.
* **Addresses.** Only https, and only to the public internet: an OpenAI-compatible base URL is checked when it is
  saved (``config.safe_base_url``) and again on every call, where the host name is resolved and every address it
  gives must be public (never loopback, private, link-local, the instance metadata service or reserved); the
  connection then goes to the address that was checked, and redirects are never followed.

The Anthropic API is called through Anthropic's official Python SDK (``anthropic``) with its own retries off (the
model client retries 429, 5xx and timeouts itself, like every host)."""

from __future__ import annotations

import base64
import http.client
import json
import socket
import ssl
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

from . import config, keys
from .util import log

READ_TIMEOUT = 15 * 60  # a long structured answer with adaptive thinking can take minutes
CHECK_TIMEOUT = 30.0
KEY_PAGE = "Lamo Stories › Settings › AI › Provider keys"
ELEVENLABS_BASE = "https://api.elevenlabs.io"
ELEVENLABS_FORMAT = "mp3_44100_128"  # every ElevenLabs plan may ask for it
MAX_ANSWER_BYTES = 64 * 1024 * 1024  # no host's answer is read past this


class HostError(Exception):
    """A keyed host refused or failed a request. ``response`` mirrors a botocore error (``Error.Code``,
    ``Error.Message``, ``ResponseMetadata.HTTPStatusCode``); ``kind`` is ``key`` | ``model`` | ``effort`` | ``tools``
    | ``limit`` | ``content`` | ``other``; ``found`` is ``(status, reason)`` when the key or the model was refused;
    ``sent`` is False only when nothing reached the host (no key, an address that is not allowed)."""

    def __init__(
        self,
        message: str,
        *,
        code: str,
        status: int = 0,
        kind: str = "other",
        found: tuple[str, str] | None = None,
        host: str = "",
        sent: bool = True,
    ) -> None:
        super().__init__(message)
        self.response = {"Error": {"Code": code, "Message": message}, "ResponseMetadata": {"HTTPStatusCode": status}}
        self.status_code = status
        self.kind = kind
        self.found = found
        self.host = host
        self.sent = sent


def host_words(host: str) -> str:
    """The host as a sentence names it ("the Anthropic API", "ElevenLabs", …)."""
    return config.HOST_LABELS.get(host, host)


def no_key(host: str) -> HostError:
    reason = f"there is no key for {host_words(host)} saved yet (paste one in {KEY_PAGE})"
    return HostError(reason, code="NoKey", kind="key", found=("denied", reason), host=host, sent=False)


def refused(host: str, status: int, message: str) -> HostError:
    """A host's HTTP refusal in Lamo Stories' terms. 408, 429 and 5xx stay transient (the client retries them)."""
    words = host_words(host)
    low = " ".join(message.lower().split())
    if status == 401:
        reason = f"{words} refused the saved key (paste it again in {KEY_PAGE})"
        return HostError(message, code="AccessDeniedException", status=401, kind="key", found=("denied", reason),
                         host=host)  # fmt: skip
    if status == 403:
        reason = f"{words} says this key may not use it"
        return HostError(message, code="AccessDeniedException", status=403, kind="model", found=("denied", reason),
                         host=host)  # fmt: skip
    if status == 404:
        reason = f"{words} cannot find this model"
        return HostError(message, code="ResourceNotFoundException", status=404, kind="model",
                         found=("not_found", reason), host=host)  # fmt: skip
    if status == 429:
        return HostError(message, code="ThrottlingException", status=429, kind="limit",
                         found=("error", f"its limit on {words} is used up for now"), host=host)  # fmt: skip
    if status in (0, 408) or status >= 500:
        return HostError(message, code="RequestTimeout" if status in (0, 408) else "ServiceUnavailableException",
                         status=status, host=host)  # fmt: skip
    if "effort" in low:
        return HostError(message, code="ValidationException", status=status, kind="effort", host=host)
    if any(w in low for w in ("tool", "function")) and any(
        w in low for w in ("support", "not available", "not enabled")
    ):
        return HostError(message, code="ValidationException", status=status, kind="tools", host=host)
    if "model" in low and any(w in low for w in ("not found", "does not exist", "unknown model", "invalid model")):
        reason = f"{words} does not accept this model name"
        return HostError(message, code="ValidationException", status=status, kind="model",
                         found=("not_found", reason), host=host)  # fmt: skip
    if any(w in low for w in ("safety", "content policy", "moderation", "blocked")):
        return HostError(message, code="ValidationException", status=status, kind="content", host=host)
    return HostError(message, code="ValidationException", status=status, host=host)


def redact(text: str, key: str | None) -> str:
    """``text`` with the key taken out (a host that echoes it back never puts it in a log or a record)."""
    out = str(text or "")
    if key and len(key) >= 6:
        out = out.replace(key, "[key]")
    return out


# --- the owner's keys ----------------------------------------------------------------------------------------------


class ProviderKeys:
    """Reads one workspace's key for one keyed host from Secrets Manager, per call (§45.37 G4). ``prefix`` is the
    workspaces' secret prefix (``cf-prod/workspaces/``); ``client`` makes the Secrets Manager client. A secret that is
    not there reads as no key; one that cannot be read is a ``HostError`` (the call fails plainly, nothing else is
    tried)."""

    def __init__(self, prefix: str, client: Callable[[], Any]) -> None:
        self.prefix = prefix if prefix.endswith("/") else prefix + "/"
        self._client = client

    def name(self, workspace_id: str, host: str) -> str:
        if workspace_id == keys.CLIPS or not keys.WORKSPACE_ID.match(workspace_id):
            raise ValueError("not a Lamo Stories workspace id")
        if host not in config.KEYED_HOSTS:
            raise ValueError("not a keyed host")
        return f"{self.prefix}{workspace_id}/providers/{host}"

    def key(self, workspace_id: str, host: str) -> str | None:
        name = self.name(workspace_id, host)
        try:
            got = self._client().get_secret_value(SecretId=name)
        except Exception as e:
            code = str(((getattr(e, "response", None) or {}).get("Error") or {}).get("Code") or "")
            if code == "ResourceNotFoundException":
                return None
            log("warn", "stories.provider_key_unreadable", host=host, code=code, error=type(e).__name__)
            reason = f"Lamo Stories could not read the saved key for {host_words(host)}"
            raise HostError(reason, code="KeyUnreadable", kind="key", found=("error", reason), host=host,
                            sent=False) from e  # fmt: skip
        raw = str(got.get("SecretString") or "").strip()
        try:
            data = json.loads(raw)
        except ValueError:
            return raw or None
        found = data.get("key") if isinstance(data, dict) else data if isinstance(data, str) else None
        return (str(found).strip() or None) if found else None


class KeySource(Protocol):
    def key(self, workspace_id: str, host: str) -> str | None: ...


# --- plain HTTPS, public addresses only ----------------------------------------------------------------------------


@dataclass
class Answer:
    status: int
    body: bytes
    headers: dict[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8") or "null")
        except (ValueError, UnicodeDecodeError):
            return None


class Http(Protocol):
    def __call__(
        self, method: str, url: str, *, headers: dict[str, str], body: bytes | None, timeout: float
    ) -> Answer: ...


Resolver = Callable[[str, int], list[str]]


def _resolve(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


class _Pinned(http.client.HTTPSConnection):
    """An HTTPS connection to the address that was checked, with the host's own name for TLS (SNI and the
    certificate check), so a name that resolves somewhere else a moment later is never reached."""

    def __init__(self, host: str, port: int, address: str, timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(host, port, timeout=timeout, context=context)
        self._address = address
        self._tls = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._tls.wrap_socket(sock, server_hostname=self.host)


def https(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
    resolve: Resolver = _resolve,
) -> Answer:
    """One HTTPS request to a public address: an ``Answer`` for any HTTP answer; a ``HostError`` (code
    ``RequestTimeout``, transient) when nothing answered, or (not sent) when the address is not allowed. Redirects are
    never followed."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme != "https" or not config.safe_host(host) or parts.username or parts.password:
        raise HostError("That address is not allowed.", code="AddressNotAllowed", kind="model",
                        found=("not_found", "its address is not a public https address"), sent=False)  # fmt: skip
    port = parts.port or 443
    try:
        addresses = resolve(host, port)
    except OSError as e:
        raise HostError("The host name did not resolve.", code="RequestTimeout") from e
    if not addresses or not all(config.public_ip(a) for a in addresses):
        raise HostError("That address is not allowed.", code="AddressNotAllowed", kind="model",
                        found=("not_found", "its address is not on the public internet"), sent=False)  # fmt: skip
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    conn = _Pinned(host, port, addresses[0], timeout, ssl.create_default_context())
    try:
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        data = r.read(MAX_ANSWER_BYTES + 1)
        if len(data) > MAX_ANSWER_BYTES:
            raise HostError("The answer was too big.", code="ValidationException", status=r.status)
        return Answer(int(r.status), data, {k.lower(): v for k, v in r.getheaders()})
    except HostError:
        raise
    except (OSError, http.client.HTTPException) as e:
        raise HostError(f"Nothing answered ({type(e).__name__}).", code="RequestTimeout") from e
    finally:
        conn.close()


def said(answer: Answer) -> str:
    """The host's own error words from an error body (JSON ``error.message``, ``detail`` or ``message``), short."""
    data = answer.json()
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:300]
        if isinstance(err, str):
            return err[:300]
        detail = data.get("detail")
        if isinstance(detail, dict) and detail.get("message"):
            return str(detail["message"])[:300]
        if isinstance(detail, list) and detail and isinstance(detail[0], dict):
            return str(detail[0].get("msg") or "")[:300]
        if isinstance(detail, str):
            return detail[:300]
        if data.get("message"):
            return str(data["message"])[:300]
    return answer.body.decode("utf-8", "replace")[:300] if answer.body and data is None else ""


# --- one model call ------------------------------------------------------------------------------------------------


@dataclass
class HostCall:
    """What the model client asks a keyed host for, in its own (Converse) shape."""

    model_id: str
    system: list[str]
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]  # Converse ``toolSpec`` entries
    max_tokens: int
    effort: str | None = None  # sent only when set (the model offers it and takes this host's effort field)
    cache: bool = False
    base_url: str | None = None


@dataclass
class HostAnswer:
    content: list[dict[str, Any]]  # Converse blocks: text, toolUse, reasoningContent
    stop_reason: str  # end_turn | tool_use | max_tokens | refusal | stop_sequence
    usage: dict[str, int]


def _image(block: dict[str, Any]) -> tuple[str, str] | None:
    image = block.get("image")
    if not isinstance(image, dict):
        return None
    raw = (image.get("source") or {}).get("bytes")
    if not isinstance(raw, bytes | bytearray):
        return None
    fmt = str(image.get("format") or "jpeg").lower()
    return f"image/{'jpeg' if fmt == 'jpg' else fmt}", base64.b64encode(bytes(raw)).decode("ascii")


def _result_text(content: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for c in content or []:
        if "text" in c:
            parts.append(str(c["text"]))
        elif "json" in c:
            parts.append(json.dumps(c["json"], ensure_ascii=False, default=str))
    return "\n".join(parts)


def _spec(tool: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    spec = tool.get("toolSpec") or tool
    schema = (spec.get("inputSchema") or {}).get("json") or spec.get("input_schema") or {"type": "object"}
    return str(spec["name"]), str(spec.get("description") or spec["name"]), schema


def _dump(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return obj
    dump = getattr(obj, "model_dump", None)
    return dict(dump()) if callable(dump) else dict(vars(obj))


def _say(on_text: Callable[[str], None] | None, text: str) -> None:
    if on_text is None:
        return
    try:
        on_text(text)
    except Exception as e:  # a writer's fault never stops the answer
        log("warn", "stories.on_text_failed", error=type(e).__name__)


# --- the Anthropic API ---------------------------------------------------------------------------------------------


def to_anthropic(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Converse messages as Messages API messages. Thinking blocks go back unchanged, with their signature."""
    out: list[dict[str, Any]] = []
    for m in messages:
        blocks: list[dict[str, Any]] = []
        for b in m.get("content") or []:
            if "text" in b:
                if str(b["text"]).strip():
                    blocks.append({"type": "text", "text": str(b["text"])})
            elif "image" in b:
                found = _image(b)
                if found:
                    blocks.append({"type": "image", "source": {"type": "base64", "media_type": found[0],
                                                                "data": found[1]}})  # fmt: skip
            elif "toolUse" in b:
                use = b["toolUse"]
                blocks.append({"type": "tool_use", "id": use.get("toolUseId"), "name": use.get("name"),
                               "input": use.get("input") or {}})  # fmt: skip
            elif "toolResult" in b:
                res = b["toolResult"]
                blocks.append({"type": "tool_result", "tool_use_id": res.get("toolUseId"),
                               "content": _result_text(res.get("content") or []) or "(nothing)",
                               "is_error": res.get("status") == "error"})  # fmt: skip
            elif "reasoningContent" in b:
                rc = b["reasoningContent"] or {}
                if "redactedContent" in rc:
                    data = rc["redactedContent"]
                    text = data.decode() if isinstance(data, bytes | bytearray) else str(data)
                    blocks.append({"type": "redacted_thinking", "data": text})
                else:
                    rt = rc.get("reasoningText") or {}
                    if rt.get("signature"):
                        blocks.append({"type": "thinking", "thinking": str(rt.get("text") or ""),
                                       "signature": str(rt["signature"])})  # fmt: skip
        if blocks:
            out.append({"role": "assistant" if m.get("role") == "assistant" else "user", "content": blocks})
    return out


def from_anthropic(content: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for b in content:
        kind = b.get("type")
        if kind == "text":
            out.append({"text": str(b.get("text") or "")})
        elif kind == "tool_use":
            out.append({"toolUse": {"toolUseId": b.get("id"), "name": b.get("name"), "input": b.get("input") or {}}})
        elif kind == "thinking":
            out.append({"reasoningContent": {"reasoningText": {"text": str(b.get("thinking") or ""),
                                                               "signature": str(b.get("signature") or "")}}})  # fmt: skip
        elif kind == "redacted_thinking":
            out.append({"reasoningContent": {"redactedContent": str(b.get("data") or "").encode()}})
    return out


ANTHROPIC_BASE = "https://api.anthropic.com"  # always this address: no setting or environment variable moves the key


class AnthropicHost:
    """The Anthropic API through Anthropic's official SDK, always streamed (long answers, and the chat's live text).
    Each call makes a client for the owner's key on Anthropic's own address (``ANTHROPIC_BASE``, never read from the
    environment) with the SDK's retries off; ``http_client`` is a test's fake transport (an ``anthropic``
    ``DefaultHttpxClient``)."""

    host = "anthropic"

    def __init__(self, http_client: Any = None) -> None:
        self._http_client = http_client

    def client(self, key: str) -> Any:
        import anthropic

        extra = {"http_client": self._http_client} if self._http_client is not None else {}
        return anthropic.Anthropic(api_key=key, base_url=ANTHROPIC_BASE, max_retries=0, timeout=READ_TIMEOUT, **extra)

    @staticmethod
    def request(call: HostCall) -> dict[str, Any]:
        """The Messages API request (a test records it): the effort as ``output_config.effort`` only when set, a
        cache point on the last system block only for a model that takes one, tools with automatic choice; never
        ``thinking`` (the models think adaptively by themselves and refuse a budget) and never ``fallbacks``."""
        kw: dict[str, Any] = {"model": call.model_id, "max_tokens": int(call.max_tokens),
                              "messages": to_anthropic(call.messages)}  # fmt: skip
        system: list[dict[str, Any]] = [{"type": "text", "text": s} for s in call.system if s.strip()]
        if system:
            if call.cache:
                system[-1]["cache_control"] = {"type": "ephemeral"}
            kw["system"] = system
        if call.tools:
            kw["tools"] = [{"name": n, "description": d, "input_schema": s} for n, d, s in map(_spec, call.tools)]
            kw["tool_choice"] = {"type": "auto"}
        if call.effort:
            kw["output_config"] = {"effort": call.effort}
        return kw

    def send(self, key: str, call: HostCall, on_text: Callable[[str], None] | None) -> HostAnswer:
        kw = self.request(call)
        text = ""
        try:
            with self.client(key).messages.stream(**kw) as stream:
                for piece in stream.text_stream:
                    text += str(piece)
                    _say(on_text, text)
                final = _dump(stream.get_final_message())
        except HostError:
            raise
        except Exception as e:
            raise self.error(e, key) from e
        usage = _dump(final.get("usage") or {})
        return HostAnswer(
            from_anthropic([_dump(b) for b in final.get("content") or []]),
            str(final.get("stop_reason") or ""),
            {
                "input": int(usage.get("input_tokens") or 0),
                "output": int(usage.get("output_tokens") or 0),
                "cacheRead": int(usage.get("cache_read_input_tokens") or 0),
                "cacheWrite": int(usage.get("cache_creation_input_tokens") or 0),
            },
        )

    def error(self, e: BaseException, key: str | None = None) -> HostError:
        """The SDK's typed errors as a ``HostError``: its status for an HTTP refusal, a transient timeout for a
        connection that failed."""
        import anthropic

        message = redact(str(getattr(e, "message", None) or e), key)[:500]
        if isinstance(e, anthropic.APIStatusError):
            return refused(self.host, int(e.status_code), message)
        if isinstance(e, anthropic.APIConnectionError):  # also APITimeoutError
            return HostError(message, code="RequestTimeout", host=self.host)
        return HostError(message, code="ClientError", host=self.host)


# --- any OpenAI-compatible chat-completions API -------------------------------------------------------------------


def to_openai(system: list[str], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    joined = "\n\n".join(s for s in system if s.strip())
    if joined:
        out.append({"role": "system", "content": joined})
    for m in messages:
        role = "assistant" if m.get("role") == "assistant" else "user"
        parts: list[dict[str, Any]] = []
        calls: list[dict[str, Any]] = []
        for b in m.get("content") or []:
            if "text" in b and str(b["text"]).strip():
                parts.append({"type": "text", "text": str(b["text"])})
            elif "image" in b:
                found = _image(b)
                if found:
                    parts.append({"type": "image_url", "image_url": {"url": f"data:{found[0]};base64,{found[1]}"}})
            elif "toolUse" in b:
                use = b["toolUse"]
                calls.append({"id": use.get("toolUseId"), "type": "function",
                              "function": {"name": use.get("name"),
                                           "arguments": json.dumps(use.get("input") or {}, ensure_ascii=False)}})  # fmt: skip
            elif "toolResult" in b:
                res = b["toolResult"]
                out.append({"role": "tool", "tool_call_id": res.get("toolUseId"),
                            "content": _result_text(res.get("content") or []) or "(nothing)"})  # fmt: skip
        if role == "assistant":
            text = "".join(p["text"] for p in parts if p["type"] == "text")
            msg: dict[str, Any] = {"role": "assistant", "content": text or None}
            if calls:
                msg["tool_calls"] = calls
            if text or calls:
                out.append(msg)
        elif parts:
            only_text = all(p["type"] == "text" for p in parts)
            out.append({"role": "user", "content": "\n\n".join(p["text"] for p in parts) if only_text else parts})
    return out


FINISH = {"stop": "end_turn", "tool_calls": "tool_use", "function_call": "tool_use", "length": "max_tokens",
          "content_filter": "refusal"}  # fmt: skip


class OpenAICompatibleHost:
    """Any https base URL that speaks the OpenAI chat-completions API (``POST {baseUrl}/chat/completions``, the key as
    a bearer token), public addresses only. Not streamed: the whole answer comes at once (``on_text`` gets it once)."""

    host = "openai_compatible"

    def __init__(self, http: Http | None = None) -> None:
        self._http: Http = http or https

    @staticmethod
    def request(call: HostCall) -> dict[str, Any]:
        """The chat-completions body (a test records it): ``reasoning_effort`` only when set (then the token limit is
        ``max_completion_tokens``, as reasoning models take it; else ``max_tokens``), tools with automatic choice."""
        body: dict[str, Any] = {"model": call.model_id, "messages": to_openai(call.system, call.messages)}
        body["max_completion_tokens" if call.effort else "max_tokens"] = int(call.max_tokens)
        if call.tools:
            body["tools"] = [{"type": "function", "function": {"name": n, "description": d, "parameters": s}}
                             for n, d, s in map(_spec, call.tools)]  # fmt: skip
            body["tool_choice"] = "auto"
        if call.effort:
            body["reasoning_effort"] = call.effort
        return body

    def send(self, key: str, call: HostCall, on_text: Callable[[str], None] | None) -> HostAnswer:
        base = config.safe_base_url(call.base_url)
        if base is None:
            raise HostError("no base URL", code="AddressNotAllowed", kind="model",
                            found=("not_found", "its address is not a public https address"), host=self.host,
                            sent=False)  # fmt: skip
        body = json.dumps(self.request(call), ensure_ascii=False).encode()
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"}
        answer = self._http("POST", f"{base}/chat/completions", headers=headers, body=body, timeout=READ_TIMEOUT)
        if answer.status != 200:
            raise refused(self.host, answer.status, redact(said(answer), key) or f"HTTP {answer.status}")
        data = answer.json()
        try:
            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message") or {}
        except (AttributeError, IndexError, TypeError) as e:
            raise HostError("The answer was not chat completions JSON.", code="ServiceUnavailableException",
                            status=502, host=self.host) from e  # fmt: skip
        content: list[dict[str, Any]] = []
        text = message.get("content")
        if isinstance(text, list):
            text = "".join(str(p.get("text") or "") for p in text if isinstance(p, dict))
        if isinstance(text, str) and text:
            content.append({"text": text})
            _say(on_text, text)
        for c in message.get("tool_calls") or []:
            fn = c.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            content.append({"toolUse": {"toolUseId": c.get("id"), "name": fn.get("name"),
                                        "input": args if isinstance(args, dict) else {}}})  # fmt: skip
        reason = str(choice.get("finish_reason") or "")
        stop = "refusal" if message.get("refusal") and not content else FINISH.get(reason, reason or "end_turn")
        usage = data.get("usage") or {}
        details = usage.get("prompt_tokens_details") or {}
        cached = int(details.get("cached_tokens") or 0) if isinstance(details, dict) else 0
        return HostAnswer(
            content,
            stop,
            {"input": max(0, int(usage.get("prompt_tokens") or 0) - cached),
             "output": int(usage.get("completion_tokens") or 0), "cacheRead": cached, "cacheWrite": 0},
        )  # fmt: skip


def image_size(width: int, height: int) -> str:
    """The images-API size nearest the asked shape (square, tall or wide)."""
    if abs(width - height) <= max(width, height) // 10:
        return "1024x1024"
    return "1024x1536" if height > width else "1536x1024"


def openai_picture(http: Http, base_url: str, key: str, model_id: str, prompt: str, width: int, height: int) -> bytes:
    """One picture from an OpenAI-compatible images API (``POST {baseUrl}/images/generations``, ``b64_json``): the
    image's bytes. Raises ``HostError`` (``kind`` ``content`` when the host's safety check refused the prompt)."""
    base = config.safe_base_url(base_url)
    if base is None:
        raise HostError("no base URL", code="AddressNotAllowed", kind="model",
                        found=("not_found", "its address is not a public https address"), host="openai_compatible",
                        sent=False)  # fmt: skip
    payload = {"model": model_id, "prompt": prompt[:3000], "n": 1, "size": image_size(width, height),
               "response_format": "b64_json"}  # fmt: skip
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"}
    answer = http("POST", f"{base}/images/generations", headers=headers, body=json.dumps(payload).encode(),
                  timeout=READ_TIMEOUT)  # fmt: skip
    if answer.status == 400 and "response_format" in said(answer):  # a model that always answers in base64
        payload.pop("response_format")
        answer = http("POST", f"{base}/images/generations", headers=headers, body=json.dumps(payload).encode(),
                      timeout=READ_TIMEOUT)  # fmt: skip
    if answer.status != 200:
        raise refused("openai_compatible", answer.status, redact(said(answer), key) or f"HTTP {answer.status}")
    data = answer.json()
    rows = data.get("data") if isinstance(data, dict) else None
    first = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
    try:
        return base64.b64decode(str(first.get("b64_json") or ""), validate=True)
    except (ValueError, TypeError) as e:
        raise HostError("The answer had no picture.", code="ValidationException", status=200, kind="content",
                        host="openai_compatible") from e  # fmt: skip


def openai_models(http: Http, base_url: str, key: str) -> list[str]:
    """``GET {baseUrl}/models`` (costs nothing): the model ids the key may use. Raises ``HostError`` on a refusal."""
    base = config.safe_base_url(base_url)
    if base is None:
        raise HostError("no base URL", code="AddressNotAllowed", kind="model",
                        found=("not_found", "its address is not a public https address"), host="openai_compatible",
                        sent=False)  # fmt: skip
    answer = http("GET", f"{base}/models", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                  body=None, timeout=CHECK_TIMEOUT)  # fmt: skip
    if answer.status != 200:
        raise refused("openai_compatible", answer.status, redact(said(answer), key) or f"HTTP {answer.status}")
    data = answer.json()
    rows = data.get("data") if isinstance(data, dict) else data
    return [str(r.get("id") or r.get("model_id")) for r in rows or [] if isinstance(r, dict)]


# --- ElevenLabs: sound effects and an instrumental music bed, never a voice ---------------------------------------


class ElevenLabs:
    """One workspace's ElevenLabs calls with its own key (§45.37 G3, G7): sound effects (``POST
    /v1/sound-generation``) and an instrumental music bed (``POST /v1/music`` with ``force_instrumental``), never its
    text-to-speech. Checked on 2026-11-22 against elevenlabs.io/docs/api-reference (text-to-sound-effects/convert:
    ``text``, ``duration_seconds`` 0.5-30, ``loop``, ``prompt_influence``, ``model_id``; music/compose: ``prompt``,
    ``music_length_ms`` 3000-600000, ``model_id``, ``force_instrumental``; both answer audio in ``output_format``).
    Raises ``HostError`` and never tries another provider."""

    host = "elevenlabs"
    EFFECT_MIN, EFFECT_MAX = 0.5, 30.0
    MUSIC_MIN_MS, MUSIC_MAX_MS = 3000, 600_000

    def __init__(self, key: str, http: Http | None = None, base: str = ELEVENLABS_BASE) -> None:
        self._key = key
        self._http: Http = http or https
        self.base = base.rstrip("/")

    def _headers(self, accept: str = "audio/mpeg") -> dict[str, str]:
        return {"xi-api-key": self._key, "Content-Type": "application/json", "Accept": accept}

    def _post(self, path: str, body: dict[str, Any]) -> bytes:
        answer = self._http("POST", f"{self.base}{path}?output_format={ELEVENLABS_FORMAT}", headers=self._headers(),
                            body=json.dumps(body).encode(), timeout=300.0)  # fmt: skip
        if answer.status != 200:
            raise refused(self.host, answer.status, redact(said(answer), self._key) or f"HTTP {answer.status}")
        if not answer.body:
            raise HostError("ElevenLabs sent no sound.", code="ServiceUnavailableException", status=502,
                            host=self.host)  # fmt: skip
        return answer.body

    def effect(self, text: str, seconds: float, *, loop: bool, model_id: str) -> bytes:
        """One sound effect (an MP3), ``seconds`` long (kept within 0.5-30 s)."""
        secs = round(min(self.EFFECT_MAX, max(self.EFFECT_MIN, float(seconds))), 2)
        body = {"text": text[:450], "duration_seconds": secs, "loop": bool(loop), "prompt_influence": 0.5,
                "model_id": model_id}  # fmt: skip
        return self._post("/v1/sound-generation", body)

    def music(self, prompt: str, seconds: float, *, model_id: str) -> bytes:
        """The music bed (an MP3), always instrumental (``force_instrumental``)."""
        ms = int(min(self.MUSIC_MAX_MS, max(self.MUSIC_MIN_MS, round(float(seconds) * 1000))))
        body = {"prompt": prompt[:2000], "music_length_ms": ms, "model_id": model_id, "force_instrumental": True}
        return self._post("/v1/music", body)

    def check(self) -> list[str]:
        """``GET /v1/models`` (costs nothing): proves the key is accepted. Returns the model ids it lists."""
        answer = self._http("GET", f"{self.base}/v1/models", headers=self._headers("application/json"), body=None,
                            timeout=CHECK_TIMEOUT)  # fmt: skip
        if answer.status != 200:
            raise refused(self.host, answer.status, redact(said(answer), self._key) or f"HTTP {answer.status}")
        rows = answer.json()
        return [str(r.get("model_id")) for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
