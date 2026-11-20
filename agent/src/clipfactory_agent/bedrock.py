"""Direct Bedrock Converse calls: structured output through a single tool, and vision on one frame.

Claude Fable 5.1 rejects a forced ``toolChoice`` (it always thinks), so the first refusal of a forced choice switches
this client to ``auto`` with the tool named in the prompt; the answer is then validated and, if it is wrong, sent back
once with the exact problems.

Every call gets the owner's skills block first in its ``system`` (docs/CONTRACTS.md §18.6): ``structured`` takes it
as a required keyword, and ``_converse`` is the only place in this package that calls ``converse``. A cache point
follows a long block; if Bedrock refuses cache points, they are switched off for this client and the call is sent
again without one.

Model calls run in their own small thread pool, not asyncio's default one: the deep analysis keeps a dozen long
calls in flight, and on two CPUs the default pool (six threads) would queue the job's heartbeat writes behind them.
Every answer's token counts are logged as ``bedrock.usage``, so what a job really costs can be read from the logs.

No request sets ``thinking``, ``temperature``, ``top_p`` or ``top_k`` (docs/DECISIONS.md ADR-42): every model the
owner may pick (Fable 5.2 and 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5) refuses a thinking budget, ``thinking: disabled``
or non-default sampling, and runs adaptive thinking when ``thinking`` is left out. ``probe`` makes one small call
first, so a model the account cannot call is found before a job depends on it."""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from .retry import retry
from .schema import check
from .skills import SkillsBlock, compose_system
from .util import TransientError, UserFacingError, log

MODEL_THREADS = 16
# The longest one Converse try may take before it is given up and tried again: far above a slow answer (a long
# structured answer with adaptive thinking takes a few minutes), below botocore's own retries of its 600 s read time.
CALL_SECONDS = 12 * 60
_POOL = ThreadPoolExecutor(MODEL_THREADS, thread_name_prefix="cf-model")


class ModelError(Exception):
    """The model did not produce a usable answer."""


# Bedrock's answers when a model or inference profile cannot be called from this account: no model access, a model
# or profile not offered here, or not offered on demand. Throttling and outages are not among them (retry.py).
_UNAVAILABLE_CODES = frozenset({"AccessDeniedException", "ResourceNotFoundException"})
_UNAVAILABLE_WORDS = (
    "not available",
    "isn't available",
    "unavailable",
    "not enabled",
    "isn't enabled",
    "access denied",
    "access to the model",
    "don't have access",
    "do not have access",
    "not authorized",
    "model identifier is invalid",
    "invalid model",
    "model id",
    "inference profile",
    "on-demand throughput",
    "not supported",
    "isn't supported",
    "end of its life",
)


# What the owner reads when Bedrock refuses the model because it is not turned on for the account (Bedrock model
# access, not the video's fault): the exact place to turn it on, then Try again.
MODEL_ACCESS_MESSAGE = (
    "Claude is not turned on for your AWS account yet. In AWS, open Amazon Bedrock in Stockholm (eu-north-1), "
    "go to Model catalog, open Claude Opus 5.5 and Claude Opus 4.8, and turn on access. Then tap Try again."
)


def model_unavailable(e: BaseException) -> bool:
    """True when Bedrock refused a call because the model cannot be used here (access, existence or offer), not
    because the request or the moment was wrong (docs/DECISIONS.md ADR-42)."""
    response = getattr(e, "response", None)
    if not isinstance(response, dict):
        return False
    err = response.get("Error") or {}
    code = str(err.get("Code") or "")
    if code in _UNAVAILABLE_CODES:
        return True
    if code != "ValidationException":
        return False
    msg = f"{err.get('Message') or ''} {e}".lower()
    if any(w in msg for w in ("tool", "cache", "image", "token")):
        return False  # a request setting the model does not take (structured switches those off itself)
    return ("model" in msg or "profile" in msg) and any(w in msg for w in _UNAVAILABLE_WORDS)


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


PROBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ok"],
    "properties": {"ok": {"type": "boolean"}},
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
    def __init__(self, model_id: str, region: str, client: Any = None, *, cache_points: bool = True) -> None:
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
        self.cache_points = cache_points  # False for a model whose prompt cache is smaller than the skills block
        # The most images one request may carry, once the model has refused more (watch.learn_image_limit). None
        # until then: Bedrock's user guide sets no image count of its own, while the Converse API reference names 20
        # per message, so the first refusal teaches the real number and every later call is sized to it.
        self.image_limit: int | None = None
        self.reachable = False  # set once ``probe`` got an answer

    def _converse(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        r: dict[str, Any] = self.client.converse(**kwargs)
        return r

    async def _call(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """One Converse answer, tried up to four times on throttling and outages; each try stops waiting after
        ``CALL_SECONDS`` (a TimeoutError, tried again), so a call that never answers can't hold a step forever. A
        model that is not turned on (``model_unavailable``) is not tried again."""
        loop = asyncio.get_running_loop()
        return await retry(
            lambda: asyncio.wait_for(loop.run_in_executor(_POOL, self._converse, kwargs), CALL_SECONDS),
            what="bedrock.converse",
            attempts=4,
        )

    def _log_usage(self, tool: str, r: dict[str, Any]) -> None:
        usage = r.get("usage") or {}
        if usage:
            log(
                "info",
                "bedrock.usage",
                model=self.model_id,
                tool=tool,
                inputTokens=int(usage.get("inputTokens") or 0),
                outputTokens=int(usage.get("outputTokens") or 0),
                cacheReadInputTokens=int(usage.get("cacheReadInputTokens") or 0),
                cacheWriteInputTokens=int(usage.get("cacheWriteInputTokens") or 0),
            )

    async def probe(self, *, skills: SkillsBlock) -> BaseException | None:
        """One small structured call to see whether this model can be called at all, with the owner's skills first
        like every call (it also writes them to the prompt cache for the calls that follow). Returns Bedrock's
        refusal when the model is unavailable (``model_unavailable``), else None: an answer, or any other failure
        (busy, a timeout, a bad answer), which is not a reason to give up on the model. A model that answered once
        is not asked again."""
        if self.reachable:
            return None
        try:
            await self.structured(
                system="You confirm that you can answer.",
                skills=skills,
                content=[{"text": "Set ok to true."}],
                tool="ready",
                description="Say that you are ready.",
                schema=PROBE_SCHEMA,
                max_tokens=2000,
            )
        except Exception as e:
            if model_unavailable(e):
                return e
            log("warn", "model.probe_failed", model=self.model_id, error=type(e).__name__, detail=str(e)[:300])
            return None
        self.reachable = True
        return None

    async def structured(
        self,
        *,
        system: str,
        skills: SkillsBlock,
        content: list[dict[str, Any]],
        tool: str,
        description: str,
        schema: dict[str, Any],
        max_tokens: int = 16000,
    ) -> dict[str, Any]:
        """The model's answer as a dict that fits ``schema``, delivered through the tool ``tool``. ``skills`` goes
        first in the system prompt, then ``system``."""
        from botocore.exceptions import ClientError

        nudge = f"\n\nAnswer only by calling the {tool} tool once, with every required field."
        messages: list[dict[str, Any]] = [{"role": "user", "content": [*content, {"text": nudge.strip()}]}]
        tool_config: dict[str, Any] = {
            "tools": [{"toolSpec": {"name": tool, "description": description, "inputSchema": {"json": schema}}}]
        }
        attempt = -1
        while attempt < 2:
            attempt += 1
            tool_config["toolChoice"] = {"tool": {"name": tool}} if self.forced_tool_choice else {"auto": {}}
            kwargs = {
                "modelId": self.model_id,
                "system": compose_system(skills, system, cache_point=self.cache_points),
                "messages": messages,
                "toolConfig": tool_config,
                "inferenceConfig": {"maxTokens": max_tokens},
            }
            try:
                r = await self._call(kwargs)
            except ClientError as e:
                msg = str(e).lower()
                invalid = e.response.get("Error", {}).get("Code") == "ValidationException"
                # A configuration the model refuses is switched off and the same request sent again; it does not
                # use up one of the three answers.
                if (
                    invalid
                    and self.cache_points
                    and any(w in msg for w in ("cachepoint", "cache point", "cache_point"))
                ):
                    log("info", "bedrock.cache_point_off", model=self.model_id)
                    self.cache_points = False
                    attempt -= 1
                    continue
                if (
                    invalid
                    and self.forced_tool_choice
                    and ("tool_choice" in msg or "toolchoice" in msg or "tool choice" in msg)
                ):
                    log("info", "bedrock.forced_tool_choice_off", model=self.model_id)
                    self.forced_tool_choice = False
                    attempt -= 1
                    continue
                raise
            self._log_usage(tool, r)
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

    async def detect_layout(self, jpeg: bytes, width: int, height: int, *, skills: SkillsBlock) -> FrameLayout:
        """Where the facecam is in a frame from a stream, if there is one."""
        r = await self.structured(
            system="You look at frames from livestreams and describe their layout precisely.",
            skills=skills,
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
    """The model's own error goes to the log; the owner gets a plain sentence with the next step."""
    log("warn", "model.failed", error=type(e).__name__, detail=str(e)[:500])
    return UserFacingError("Claude could not finish this step. Tap Try again.")
