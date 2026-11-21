"""Who makes what (docs/CONTRACTS.md §45.11.6, ADR-75): a static mirror of the agent's provider registry.

``agent/src/clipfactory_agent/stories/providers.py`` is the registry the pipeline calls; this mirror lists the same
kinds and ids so ``GET …/providers`` can answer without the agent. Each provider's state comes from the
``PROVIDER#{kind}#{providerId}`` item the agent writes after a real call: a provider shows ``on`` only after a real
call succeeded (with ``checkedAt``); nothing is shown as working because it was configured.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from . import types as ws

KINDS: Final = ("writer", "images", "animation", "audio")


@dataclass(frozen=True)
class Provider:
    kind: str
    id: str
    label: str
    builtin: bool
    line_on: str
    line_unchecked: str
    unavailable: str = ""  # a sentence when it cannot be used at all (interface only)


REGISTRY: Final[tuple[Provider, ...]] = (
    Provider(
        "writer",
        "bedrock-claude",
        "Claude on Amazon Bedrock",
        True,
        "Writes every story with the model picked in Settings.",
        "Not checked yet. It is checked when the first story is written.",
    ),
    Provider(
        "images",
        "builtin-rig",
        "Built-in characters",
        True,
        "Draws your characters the same way in every video.",
        "Not checked yet. It is checked when the first video is made.",
    ),
    Provider(
        "images",
        "nova-canvas",
        "Amazon Nova Canvas (AI pictures)",
        False,
        "Makes AI portraits of your characters. They show in the app and the Library only, never in a posted video.",
        "Make one portrait to check it. If Bedrock says it is not enabled, turn on Amazon Nova Canvas in the Bedrock "
        "console in Europe (Ireland).",
    ),
    Provider(
        "animation",
        "builtin-2d",
        "Built-in animation",
        True,
        "Animates every scene at 1080 by 1920, 30 frames a second.",
        "Not checked yet. It is checked when the first video is made.",
    ),
    Provider(
        "animation",
        "nova-reel",
        "Amazon Nova Reel (AI video)",
        False,
        "",
        "",
        unavailable=(
            "Not available: Nova Reel saves its videos in a United States bucket this app does not have, and its "
            "realistic clips would need AI labels that the posts do not set."
        ),
    ),
    Provider(
        "audio",
        "builtin-synth",
        "Built-in sounds and music",
        True,
        "Makes every sound effect, character noise and music track itself.",
        "Not checked yet. It is checked when the first video is made.",
    ),
)
OFF_LINE: Final = "Off. Pick it in Lamo Stories › Settings to use it."


def provider_sk(kind: str, provider_id: str) -> str:
    return f"{ws.PROVIDER_SK}{kind}#{provider_id}"


def _selected(p: Provider, config: Mapping[str, Any]) -> bool:
    chosen = config.get("providers") if isinstance(config.get("providers"), Mapping) else {}
    if p.kind == "writer":
        return True
    if p.kind == "images" and p.id == "builtin-rig":
        return True  # the rig always draws the characters in videos; the images choice is about portraits
    return (chosen or {}).get(p.kind) == p.id


def status(p: Provider, config: Mapping[str, Any], record: Mapping[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label}
    if p.unavailable:
        return {**out, "state": "unavailable", "line": p.unavailable}
    if not _selected(p, config):
        return {**out, "state": "off", "line": OFF_LINE}
    state = (record or {}).get("state")
    checked = (record or {}).get("checkedAt")
    error = (record or {}).get("lastError")
    if state == "on" and isinstance(checked, str) and checked:
        out.update(state="on", line=p.line_on, checkedAt=checked)
        return out
    out.update(state="needs_setup", line=str(error) if error else p.line_unchecked)
    if isinstance(checked, str) and checked:
        out["checkedAt"] = checked
    if error:
        out["lastError"] = str(error)
    return out


def statuses(config: Mapping[str, Any], records: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    by_key = {str(r.get("sk")): r for r in records}
    return [status(p, config, by_key.get(provider_sk(p.kind, p.id))) for p in REGISTRY]
