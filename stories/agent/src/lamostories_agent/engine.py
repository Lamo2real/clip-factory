"""The animation engine's command line, run with Deno (docs/CONTRACTS.md §45.10).

The engine is the same TypeScript folder the browser draws previews with, copied into Lamo Stories' own image at
``/app/stories-engine/`` (``stories/agent/Dockerfile``). Deno (the binary of its PyPI wheel, in the venv) runs it with
``--allow-read`` only: no network, no writes but its own cache in the job's scratch space. Every call has a time
limit and is killed with its process group on cancel (``proc.run``). Its stdout is JSON; its errors are logged, never
shown to the owner."""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import config, proc
from .util import log

DEFAULT_ENGINE_DIR = Path("/app/stories-engine")
CALL_SECONDS = 120.0


def find_engine_dir(configured: Path | None = None) -> Path:
    """The engine folder: the configured one, the image's, or the repository's (local runs and tests)."""
    for d in (configured, config.engine_dir(), DEFAULT_ENGINE_DIR):
        if d is not None and (d / "cli.ts").is_file():
            return d
    return configured or DEFAULT_ENGINE_DIR


def deno_binary() -> str:
    """``CF_DENO``, else the venv's ``deno`` (from the ``deno`` wheel, beside this interpreter), else PATH's."""
    found = os.environ.get("CF_DENO")
    if found:
        return found
    beside = Path(sys.executable).parent / "deno"
    if beside.is_file():
        return str(beside)
    return shutil.which("deno") or "deno"


class EngineError(Exception):
    """The engine refused a script or did not answer; the detail goes to the log only."""


@dataclass
class Engine:
    engine_dir: Path
    deno_dir: Path
    deno: str = field(default_factory=deno_binary)
    _catalog: dict[str, Any] | None = field(default=None, init=False, repr=False)

    @property
    def cli(self) -> Path:
        return self.engine_dir / "cli.ts"

    def env(self) -> dict[str, str]:
        return {"DENO_DIR": str(self.deno_dir), "DENO_NO_UPDATE_CHECK": "1", "DENO_NO_PROMPT": "1"}

    def argv(self, *args: str) -> list[str]:
        """The command for ``cli.ts args...``: through ``env`` so Deno gets its own cache folder (``proc.run`` keeps
        the agent's environment as it is)."""
        envs = [f"{k}={v}" for k, v in self.env().items()]
        return [
            "env",
            *envs,
            self.deno,
            "run",
            "--allow-read",
            "--no-config",
            "--no-lock",
            "--quiet",
            str(self.cli),
            *args,
        ]

    async def _json(self, *args: str, time_limit: float = CALL_SECONDS) -> Any:
        self.deno_dir.mkdir(parents=True, exist_ok=True)
        try:
            r = await proc.run(self.argv(*args), time_limit=time_limit, cwd=self.deno_dir)
        except proc.CommandError as e:
            raise EngineError(f"engine {args[0]} failed: {e.tail[:400]}") from e
        try:
            return json.loads(r.stdout or b"null")
        except ValueError as e:
            raise EngineError(f"engine {args[0]} did not answer JSON") from e

    async def catalog(self) -> dict[str, Any]:
        """``{"engine": n, "catalog": CATALOG}``, once per engine object."""
        if self._catalog is None:
            got = await self._json("catalog")
            if not isinstance(got, dict) or not isinstance(got.get("catalog"), dict):
                raise EngineError("engine catalog has no catalog")
            self._catalog = got
        return self._catalog

    async def version(self) -> int:
        return int((await self.catalog()).get("engine") or 0)

    async def validate(self, script_path: Path) -> list[str]:
        """The script's problems; empty when it validates."""
        got = await self._json("validate", str(script_path))
        if isinstance(got, dict) and got.get("ok") is True:
            return []
        errors = got.get("errors") if isinstance(got, dict) else None
        return [str(e) for e in errors] if isinstance(errors, list) and errors else ["The script did not validate."]

    async def normalize(self, script_path: Path) -> dict[str, Any]:
        return self._dict(await self._json("normalize", str(script_path)), "normalize")

    async def fit(self, script_path: Path, seconds: float) -> dict[str, Any]:
        return self._dict(await self._json("fit", f"{seconds:g}", str(script_path)), "fit")

    async def scenes(self, script_path: Path) -> list[dict[str, Any]]:
        got = await self._json("scenes", str(script_path))
        if not isinstance(got, list):
            raise EngineError("engine scenes is not a list")
        return [s for s in got if isinstance(s, dict)]

    async def text(self, script_path: Path) -> list[dict[str, Any]]:
        got = await self._json("text", str(script_path))
        return [e for e in got if isinstance(e, dict)] if isinstance(got, list) else []

    async def audio(self, script_path: Path) -> list[dict[str, Any]]:
        got = await self._json("audio", str(script_path))
        return [e for e in got if isinstance(e, dict)] if isinstance(got, list) else []

    async def repair(self, script_path: Path) -> tuple[dict[str, Any], list[str]] | None:
        """The engine's repair helper (``cli.ts repair``: each stray face becomes ``neutral`` and each stray noise is
        dropped, §45.34): the repaired script and what it changed, or None when this engine has no such command (the
        agent then applies the same rule itself)."""
        try:
            got = await self._json("repair", str(script_path))
        except EngineError as e:
            log("info", "stories.engine_no_repair", detail=str(e)[:200])
            return None
        if isinstance(got, dict) and isinstance(got.get("script"), dict):
            notes: list[Any] = next(
                (got[k] for k in ("changes", "repaired", "fixed", "log") if isinstance(got.get(k), list)), []
            )
            return dict(got["script"]), [str(n) for n in notes]
        if isinstance(got, dict) and isinstance(got.get("scenes"), list):
            return got, []
        return None

    @staticmethod
    def _dict(got: Any, what: str) -> dict[str, Any]:
        if not isinstance(got, dict):
            raise EngineError(f"engine {what} is not an object")
        return got


def write_json(path: Path, value: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")), "utf-8")
    return path


def frame_count(script: dict[str, Any]) -> int:
    """``round(durationSec × fps)`` over the scenes, as the engine's ``frameCount``."""
    total = sum(float(s.get("durationSec") or 0) for s in script.get("scenes") or [])
    return round(total * int(script.get("fps") or 30))
