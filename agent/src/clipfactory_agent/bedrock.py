"""Direct Bedrock Converse calls: structured output through a single tool, and vision on one frame.

Claude Fable 5.1 rejects a forced ``toolChoice`` (it always thinks), so the first refusal of a forced choice switches
this client to ``auto`` with the tool named in the prompt; the answer is then validated and, if it is wrong, sent back
once with the exact problems."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from .retry import retry
from .schema import check
from .util import TransientError, UserFacingError, log


class ModelError(Exception):
    """The model did not produce a usable answer."""


@dataclass
class Facecam:
    x: float
    y: float
    w: float
    h: float


@dataclass
class FrameLayout:
    facecam: Facecam | None
    scene: str


LAYOUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["has_facecam", "x", "y", "w", "h", "scene"],
    "properties": {
        "has_facecam": {
            "type": "boolean",
            "description": "A webcam box showing the streamer is overlaid on the frame.",
        },
        "x": {"type": "number", "description": "Left edge of the facecam box in pixels of this image."},
        "y": {"type": "number", "description": "Top edge in pixels."},
        "w": {"type": "number", "description": "Width in pixels."},
        "h": {"type": "number", "description": "Height in pixels."},
        "scene": {
            "type": "string",
            "enum": ["gameplay", "camera_only", "menu_or_loading", "other"],
            "description": "What fills most of the frame.",
        },
    },
}


def facecam_from_box(r: dict[str, Any], width: int, height: int) -> FrameLayout:
    """The model's pixel box as fractions of the frame, or no facecam when the box is implausible."""
    scene = str(r.get("scene") or "other")
    if not r.get("has_facecam") or width <= 0 or height <= 0:
        return FrameLayout(None, scene)
    x, y, w, h = (float(r.get(k) or 0) for k in ("x", "y", "w", "h"))
    if w < 40 or h < 30:
        return FrameLayout(None, scene)
    f = Facecam(x / width, y / height, w / width, h / height)
    if f.x < 0 or f.y < 0 or f.x + f.w > 1.02 or f.y + f.h > 1.02 or f.w > 0.7 or f.h > 0.8:
        return FrameLayout(None, scene)
    f.w = min(f.w, 1 - f.x)
    f.h = min(f.h, 1 - f.y)
    return FrameLayout(f, scene)


class Bedrock:
    def __init__(self, model_id: str, region: str, client: Any = None) -> None:
        self.model_id = model_id
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "bedrock-runtime",
                region_name=region,
                config=Config(connect_timeout=10, read_timeout=600, retries={"max_attempts": 4, "mode": "adaptive"}),
            )
        self.client = client
        self.forced_tool_choice = True

    def _converse(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        r: dict[str, Any] = self.client.converse(**kwargs)
        return r

    async def _call(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        return await retry(lambda: asyncio.to_thread(self._converse, kwargs), what="bedrock.converse", attempts=4)

    async def structured(
        self,
        *,
        system: str,
        content: list[dict[str, Any]],
        tool: str,
        description: str,
        schema: dict[str, Any],
        max_tokens: int = 16000,
    ) -> dict[str, Any]:
        """The model's answer as a dict that fits ``schema``, delivered through the tool ``tool``."""
        from botocore.exceptions import ClientError

        nudge = f"\n\nAnswer only by calling the {tool} tool once, with every required field."
        messages: list[dict[str, Any]] = [{"role": "user", "content": [*content, {"text": nudge.strip()}]}]
        tool_config: dict[str, Any] = {
            "tools": [{"toolSpec": {"name": tool, "description": description, "inputSchema": {"json": schema}}}]
        }
        for attempt in range(3):
            tool_config["toolChoice"] = {"tool": {"name": tool}} if self.forced_tool_choice else {"auto": {}}
            kwargs = {
                "modelId": self.model_id,
                "system": [{"text": system}],
                "messages": messages,
                "toolConfig": tool_config,
                "inferenceConfig": {"maxTokens": max_tokens},
            }
            try:
                r = await self._call(kwargs)
            except ClientError as e:
                msg = str(e).lower()
                if (
                    self.forced_tool_choice
                    and e.response.get("Error", {}).get("Code") == "ValidationException"
                    and ("tool_choice" in msg or "toolchoice" in msg or "tool choice" in msg)
                ):
                    log("info", "bedrock.forced_tool_choice_off", model=self.model_id)
                    self.forced_tool_choice = False
                    continue
                raise
            stop = r.get("stopReason")
            if stop in ("guardrail_intervened", "content_filtered") or stop == "refusal":
                raise ModelError("The model declined this request.")
            blocks = ((r.get("output") or {}).get("message") or {}).get("content") or []
            use = next((b["toolUse"] for b in blocks if "toolUse" in b and b["toolUse"].get("name") == tool), None)
            if use is None:
                problems = [f"You did not call {tool}."]
            else:
                value = use.get("input")
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        value = None
                problems = check(schema, value) if isinstance(value, dict) else ["The tool input is not an object."]
                if not problems:
                    assert isinstance(value, dict)
                    return value
            if attempt == 2:
                break
            # Show the model its own answer and what is wrong with it.
            messages.append({"role": "assistant", "content": blocks or [{"text": "(no answer)"}]})
            feedback = "Problems: " + "; ".join(problems[:20]) + nudge
            if use is not None:
                messages.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "toolResult": {
                                    "toolUseId": use["toolUseId"],
                                    "content": [{"text": feedback}],
                                    "status": "error",
                                }
                            }
                        ],
                    }
                )
            else:
                messages.append({"role": "user", "content": [{"text": feedback}]})
            if stop == "max_tokens":
                raise TransientError("The model ran out of room for its answer.")
        raise ModelError(f"The model's answer did not fit the expected shape ({'; '.join(problems[:3])}).")

    async def detect_layout(self, jpeg: bytes, width: int, height: int) -> FrameLayout:
        """Where the facecam is in a frame from a stream, if there is one."""
        r = await self.structured(
            system="You look at frames from livestreams and describe their layout precisely.",
            content=[
                {"image": {"format": "jpeg", "source": {"bytes": jpeg}}},
                {
                    "text": f"This is a {width}x{height} frame from a livestream. If a webcam/facecam box showing a "
                    "person is overlaid on the gameplay, give its tight bounding box in pixels of this image "
                    "(x, y = top-left). If the whole frame is a camera shot, or there is no facecam, set "
                    "has_facecam=false and the box to 0. Also say what fills most of the frame."
                },
            ],
            tool="report_layout",
            description="Report the frame's layout.",
            schema=LAYOUT_SCHEMA,
            max_tokens=4000,
        )
        return facecam_from_box(r, width, height)


def model_failure(e: Exception) -> UserFacingError:
    return UserFacingError(f"Claude could not finish this step ({str(e)[:200]}). Press Retry.")
