"""The engine's vocabulary, read from the engine itself (``cli.ts catalog``, docs/CONTRACTS.md §45.10, §45.33).

The character agent may use only these look and voice choices, faces, movement styles, noises and effects; the same
file the browser and the animator draw from is the one source, so a new choice in the engine reaches the agent with
no change here.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from functools import cache
from typing import Any

from lamostories_agent import config


def deno_bin() -> str:
    try:
        import deno  # the Deno binary from its PyPI wheel (§45.11.1)

        return str(deno.find_deno_bin())
    except Exception:
        return shutil.which("deno") or "deno"


@cache
def engine_catalog() -> dict[str, Any]:
    """``{"engine": n, "catalog": CATALOG}`` from ``deno run --allow-read cli.ts catalog`` (cached per process)."""
    cli = config.engine_dir() / "cli.ts"
    env = {**os.environ, "DENO_NO_UPDATE_CHECK": "1", "DENO_NO_PROMPT": "1"}
    done = subprocess.run(
        [deno_bin(), "run", "--allow-read", str(cli), "catalog"],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError("the engine's catalog could not be read: " + done.stderr.strip()[:400])
    data = json.loads(done.stdout)
    if not isinstance(data, dict) or not isinstance(data.get("catalog"), dict):
        raise RuntimeError("the engine's catalog is not the expected shape")
    return data


def ids(catalog: dict[str, Any], *path: str) -> list[str]:
    """The ids of one catalog list, e.g. ``ids(cat, "looks", "body")`` or ``ids(cat, "expressions")``."""
    node: Any = catalog.get("catalog", catalog)
    for p in path:
        node = node.get(p) if isinstance(node, dict) else None
    return [str(e["id"]) for e in node or [] if isinstance(e, dict) and "id" in e]


def labelled(catalog: dict[str, Any], *path: str) -> list[dict[str, str]]:
    node: Any = catalog.get("catalog", catalog)
    for p in path:
        node = node.get(p) if isinstance(node, dict) else None
    return [{"id": str(e["id"]), "label": str(e.get("label") or e["id"])} for e in node or [] if isinstance(e, dict)]
