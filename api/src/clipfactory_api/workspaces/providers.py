"""Who makes what (docs/CONTRACTS.md §45.11.6, ADR-75): a static mirror of the agent's provider registry.

``agent/src/clipfactory_agent/stories/providers.py`` is the registry the pipeline calls; this mirror lists the same
kinds and ids so ``GET …/providers`` can answer without the agent. A provider shows ``on`` only after a real call
succeeded, with ``checkedAt``; nothing is shown as working because it was configured. The proof is the
``PROVIDER#{kind}#{providerId}`` item the agent writes after a real call (Nova Canvas, after a portrait), or, for a
built-in provider, a story job's own step for it that finished with real work (the writer: ``storyboard``; the
characters: ``scenes``; the animation: ``animation``; the sounds: ``sound``), at that step's ``finishedAt``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
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
PROOF_STEP: Final = {"writer": "storyboard", "images": "scenes", "animation": "animation", "audio": "sound"}
NOTHING_MADE: Final = "Nothing changed"  # the agent's message for a step that had nothing to (re)make
JOBS_READ: Final = 200  # the newest story jobs looked at for proof


def provider_sk(kind: str, provider_id: str) -> str:
    return f"{ws.PROVIDER_SK}{kind}#{provider_id}"


def _selected(p: Provider, config: Mapping[str, Any]) -> bool:
    chosen = config.get("providers") if isinstance(config.get("providers"), Mapping) else {}
    if p.kind == "writer":
        return True
    if p.kind == "images" and p.id == "builtin-rig":
        return True  # the rig always draws the characters in videos; the images choice is about portraits
    return (chosen or {}).get(p.kind) == p.id


def _builtin_used(p: Provider, job: Mapping[str, Any]) -> bool:
    """Whether the job made this kind with this built-in provider (the job's ``meta.providers``, built-in when unset;
    the characters in a video are always drawn by the rig, whatever makes portraits)."""
    if p.kind == "images":
        return p.id == "builtin-rig"
    meta = job.get("meta") if isinstance(job.get("meta"), Mapping) else {}
    chosen = (meta or {}).get("providers") if isinstance((meta or {}).get("providers"), Mapping) else {}
    return str((chosen or {}).get(p.kind) or p.id) == p.id


def proven(jobs: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """``PROVIDER#`` sort key → when a story job's step made by that built-in provider last finished with real work.
    Only steps the job ran count (the others show ``done`` for files made before), and never a step that had nothing
    to make."""
    out: dict[str, str] = {}
    for job in jobs:
        if job.get("contentType") != "animation":
            continue
        config = job.get("configuration") if isinstance(job.get("configuration"), Mapping) else {}
        run = set((config or {}).get("run") or [])
        steps = {str(s.get("key")): s for s in job.get("steps") or [] if isinstance(s, Mapping)}
        for p in REGISTRY:
            step = steps.get(PROOF_STEP[p.kind])
            if not p.builtin or step is None or step.get("key") not in run or step.get("status") != "done":
                continue
            if str(step.get("message") or "").startswith(NOTHING_MADE) or not _builtin_used(p, job):
                continue
            at = str(step.get("finishedAt") or job.get("updatedAt") or "")
            key = provider_sk(p.kind, p.id)
            if at and at > out.get(key, ""):
                out[key] = at
    return out


def status(
    p: Provider, config: Mapping[str, Any], record: Mapping[str, Any] | None, proven_at: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label}
    if p.unavailable:
        return {**out, "state": "unavailable", "line": p.unavailable}
    if not _selected(p, config):
        return {**out, "state": "off", "line": OFF_LINE}
    state = (record or {}).get("state")
    checked = (record or {}).get("checkedAt")
    error = (record or {}).get("lastError")
    if state == "on" and isinstance(checked, str) and checked:
        out.update(state="on", line=p.line_on, checkedAt=max(checked, proven_at or ""))
        return out
    if p.builtin and proven_at and not (isinstance(checked, str) and checked > proven_at):
        out.update(state="on", line=p.line_on, checkedAt=proven_at)  # a newer real call than any recorded failure
        return out
    out.update(state="needs_setup", line=str(error) if error else p.line_unchecked)
    if isinstance(checked, str) and checked:
        out["checkedAt"] = checked
    if error:
        out["lastError"] = str(error)
    return out


def statuses(
    config: Mapping[str, Any], records: Sequence[Mapping[str, Any]], jobs: Iterable[Mapping[str, Any]] = ()
) -> list[dict[str, Any]]:
    by_key = {str(r.get("sk")): r for r in records}
    proof = proven(jobs)
    return [
        status(p, config, by_key.get(provider_sk(p.kind, p.id)), proof.get(provider_sk(p.kind, p.id))) for p in REGISTRY
    ]
