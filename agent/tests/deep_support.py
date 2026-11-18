"""Shared fakes for the deep-analysis tests (ADR-40): a Bedrock client that answers by tool name, a picture with
fake frames, and small builders."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from clipfactory_agent import picture
from clipfactory_agent.skills import SkillDoc, SkillsBlock, skills_block

JPEG = b"\xff\xd8\xff-frame"


def block() -> SkillsBlock:
    return skills_block([SkillDoc("playbook", "", "Built-in rules", True), SkillDoc("mine", "", "Tag @me", False)])


def tool_reply(name: str, value: Any, usage: dict[str, int] | None = None) -> dict[str, Any]:
    return {
        "stopReason": "tool_use",
        "usage": usage or {"inputTokens": 100, "outputTokens": 20},
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": name, "input": value}}],
            }
        },
    }


def client_error(code: str, message: str = "nope") -> Exception:
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": code, "Message": message}}, "Converse")


class ToolClient:
    """A bedrock-runtime stand-in: ``handlers[tool name]`` gets the request and returns the tool input (or raises)."""

    def __init__(self, handlers: dict[str, Callable[[dict[str, Any]], Any]] | None = None) -> None:
        self.handlers = handlers or {}
        self.requests: list[dict[str, Any]] = []

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.requests.append(kw)
        name = kw["toolConfig"]["tools"][0]["toolSpec"]["name"]
        handler = self.handlers.get(name)
        if handler is None:
            return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": "hm"}]}}}
        return tool_reply(name, handler(kw))

    def calls(self, tool: str) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["toolConfig"]["tools"][0]["toolSpec"]["name"] == tool]


def event(start: float, end: float, kind: str = "crash", intensity: int = 8, **kw: Any) -> dict[str, Any]:
    return {
        "start": start,
        "end": end,
        "kind": kind,
        "what": kw.pop("what", "car flips off the bridge"),
        "intensity": intensity,
        "silent": kw.pop("silent", True),
        "face": kw.pop("face", "none"),
        "text_on_screen": kw.pop("text_on_screen", ""),
        **kw,
    }


def make_picture(seconds: float, job: str = "J") -> picture.Picture:
    parts = []
    i, t = 0, 0.0
    while t < seconds:
        end = min(seconds, t + picture.PART_SECONDS)
        parts.append(picture.Part(i, t, end, f"jobs/{job}/source/picture/part-{i:04d}.mp4", 1000))
        i, t = i + 1, end
    motion = [0.01] * int(seconds)
    return picture.Picture(seconds=seconds, parts=parts, motion=motion, scene=list(motion))


class FakeFrames(picture.Frames):
    """Frames without ffmpeg: one fake JPEG per half second of whatever is asked for."""

    def __init__(self, pic: picture.Picture, local_dir: Path = Path("/tmp/none")) -> None:
        async def fetch(key: str, path: Path) -> None:
            raise AssertionError("not used")

        super().__init__(pic, local_dir, fetch)
        self.asked: list[tuple[float, float]] = []
        self.fail: Exception | None = None

    async def between(self, t0: float, t1: float) -> list[tuple[float, bytes]]:
        self.asked.append((t0, t1))
        if self.fail:
            raise self.fail
        out, t = [], picture.grid(t0)
        while t < min(t1, self.pic.seconds):
            out.append((t, JPEG))
            t += 0.5
        return out


async def no_cancel() -> None:
    return None
