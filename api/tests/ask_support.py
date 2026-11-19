"""Shared bits for the Ask assistant tests (§27): a fake Claude in Amazon Bedrock client that replays recorded turns.

A fixture turn lists the content blocks of one model response and its stop reason; ``events`` turns it into the
documented stream event sequence (``content_block_start`` → ``text_delta``/``citations_delta``/``input_json_delta``
→ ``content_block_stop``) the SDK's ``MessageStream`` yields, and ``get_final_message`` returns the message.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "ask"


def ns(value: Any) -> Any:
    """Objects with attributes, like the SDK's models; a tool_use ``input`` stays a dict, as in the SDK."""
    if isinstance(value, dict):
        return SimpleNamespace(**{k: (v if k == "input" else ns(v)) for k, v in value.items()})
    if isinstance(value, list):
        return [ns(v) for v in value]
    return value


def load(name: str) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = json.loads((FIXTURES / f"{name}.json").read_text())
    return turns


def events(turn: dict[str, Any]) -> list[Any]:
    out: list[Any] = [ns({"type": "message_start"})]
    for i, block in enumerate(turn.get("content", [])):
        kind = block["type"]
        if kind == "text":
            out.append(ns({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}}))
            for c in block.get("citations") or []:
                out.append(
                    ns({"type": "content_block_delta", "index": i, "delta": {"type": "citations_delta", "citation": c}})
                )
            text = block["text"]
            for at in range(0, len(text), 10):
                out.append(
                    ns(
                        {
                            "type": "content_block_delta",
                            "index": i,
                            "delta": {"type": "text_delta", "text": text[at : at + 10]},
                        }
                    )
                )
        elif kind == "tool_use":
            start = {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}
            out.append(ns({"type": "content_block_start", "index": i, "content_block": start}))
            out.append(
                ns(
                    {
                        "type": "content_block_delta",
                        "index": i,
                        "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])},
                    }
                )
            )
        else:  # thinking
            out.append(ns({"type": "content_block_start", "index": i, "content_block": {"type": kind}}))
        out.append(ns({"type": "content_block_stop", "index": i}))
    out.append(ns({"type": "message_stop"}))
    return out


def final(turn: dict[str, Any]) -> Any:
    usage = {
        "input_tokens": 3000,
        "output_tokens": 200,
        "cache_read_input_tokens": 70000,
        "cache_creation_input_tokens": 0,
    }
    usage.update(turn.get("usage") or {})
    return ns(
        {
            "model": turn.get("model", "anthropic.claude-opus-5-5"),
            "stop_reason": turn["stop_reason"],
            "content": turn.get("content", []),
            "usage": usage,
        }
    )


class FakeStream:
    def __init__(self, turn: dict[str, Any], on_event: Callable[[int], None] | None = None) -> None:
        self.turn = turn
        self.closed = False
        self.consumed = 0
        self._on_event = on_event

    def __enter__(self) -> FakeStream:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.closed = True

    def __iter__(self) -> Iterator[Any]:
        fail_at = self.turn.get("fail_after_events")
        for n, e in enumerate(events(self.turn)):
            if fail_at is not None and n == fail_at:
                raise RuntimeError("stream broke")
            self.consumed = n + 1
            if self._on_event is not None:
                self._on_event(n)
            yield e

    def get_final_message(self) -> Any:
        return final(self.turn)


class FakeMantle:
    """``client.beta.messages.stream(**kw)`` replaying ``turns`` (an Exception in the list is raised instead)."""

    def __init__(self, turns: list[Any], on_event: Callable[[int], None] | None = None) -> None:
        self.turns = list(turns)
        self.calls: list[dict[str, Any]] = []
        self.streams: list[FakeStream] = []
        self.on_event = on_event
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw: Any) -> FakeStream:
        snap = dict(kw)
        snap["messages"] = list(kw["messages"])
        snap["tools"] = copy.deepcopy(kw.get("tools"))
        self.calls.append(snap)
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        stream = FakeStream(turn, self.on_event)
        self.streams.append(stream)
        return stream


class ApiStatus(Exception):
    """Stands in for the SDK's APIStatusError (only ``status_code`` is read)."""

    def __init__(self, status_code: int) -> None:
        super().__init__(f"status {status_code}")
        self.status_code = status_code


class APITimeoutError(Exception):
    pass
