"""Who makes what (docs/CONTRACTS.md §45.11.6, §45.31, ADR-75, ADR-80): a static mirror of the agent's provider
registry (``stories/agent/src/lamostories_agent/providers.py``), so ``GET …/providers`` answers without the agent.

States, as §45.11.6's table gives them:

* the built-in animator, sounds and characters (``builtin-2d``, ``builtin-synth``, ``builtin-rig``) are code in Lamo
  Stories' own image with nothing to set up: ``on`` (picked or not), with ``checkedAt`` the last time a story job's
  step made by it finished with real work; a later failure the agent recorded (``PROVIDER#``) shows instead;
* the writer (``bedrock-claude``) is ``on`` only after a model answered: a ``MODELSTATUS#`` item with ``ok`` (Check
  models, or any real call) or a finished storyboard step; until then it says to tap Check models;
* Amazon Nova Canvas is ``off`` until the owner picks it, then ``needs_setup`` until the agent's real call answers
  (``PROVIDER#{kind}#{id}`` with ``state = on`` and ``checkedAt``);
* Amazon Nova Reel is built but ``needs_setup`` (its United States bucket is switched off), picked or not, until a
  ``PROVIDER#`` record says ``on``: picking it never makes it look ready.

Nothing is shown as working because it was configured.

``StoriesConfig.providers`` names the kinds ``images``, ``video`` and ``audio``; ``ProviderStatus.kind`` calls the
video kind ``animation`` (the registry's name).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from . import types as ws

KINDS: Final = ("writer", "images", "animation", "audio")
CONFIG_KEY: Final = {"images": "images", "animation": "video", "audio": "audio"}


@dataclass(frozen=True)
class Provider:
    kind: str
    id: str
    label: str
    builtin: bool
    line_on: str
    line_unchecked: str
    off_until_picked: bool = False  # only Nova Canvas: off until the owner picks it (§45.11.6)


REGISTRY: Final[tuple[Provider, ...]] = (
    Provider(
        "writer",
        "bedrock-claude",
        "Claude on Amazon Bedrock",
        False,
        "Writes every story with the model and effort picked in Lamo Stories › Settings › AI.",
        "Not checked yet. Tap Check models in Lamo Stories › Settings › AI.",
    ),
    Provider(
        "images",
        "builtin-rig",
        "Built-in characters",
        True,
        "Built in: draws your characters the same way in every video. Nothing to set up.",
        "",
    ),
    Provider(
        "images",
        "nova-canvas",
        "Amazon Nova Canvas (AI pictures)",
        False,
        "Makes AI portraits of your characters. They show in the app and the Library only, never in a posted video.",
        "Make one portrait to check it. If Bedrock says it is not enabled, turn on Amazon Nova Canvas in the Bedrock "
        "console in Europe (Ireland).",
        off_until_picked=True,
    ),
    Provider(
        "animation",
        "builtin-2d",
        "Built-in animation",
        True,
        "Built in: animates every scene at 1080 by 1920, 30 frames a second. Nothing to set up.",
        "",
    ),
    Provider(
        "animation",
        "nova-reel",
        "Amazon Nova Reel 1.1 (AI video)",
        False,
        "Makes 6-second AI shots for backgrounds. Videos that use them are posted with the platforms' AI labels.",
        "Needs a storage bucket in the United States (N. Virginia), which is switched off, and Amazon Nova Reel "
        "enabled for your account. Until then the built-in animation makes your videos.",
    ),
    Provider(
        "audio",
        "builtin-synth",
        "Built-in sounds and music",
        True,
        "Built in: makes every sound effect, character noise and music track itself. Nothing to set up.",
        "",
    ),
)
OFF_LINE: Final = "Off. Pick it in Lamo Stories › Settings to use it."
WRITER_FAILED: Final = "No model has answered yet. Tap Check models in Lamo Stories › Settings › AI to see why."
PROOF_STEP: Final = {"writer": "storyboard", "images": "scenes", "animation": "animation", "audio": "sound"}
NOTHING_MADE: Final = "Nothing changed"  # the agent's message for a step that had nothing to (re)make
JOBS_READ: Final = 200  # the newest story jobs looked at for proof


def provider_sk(kind: str, provider_id: str) -> str:
    return f"{ws.PROVIDER_SK}{kind}#{provider_id}"


def _selected(p: Provider, config: Mapping[str, Any]) -> bool:
    chosen = config.get("providers") if isinstance(config.get("providers"), Mapping) else {}
    return p.kind in CONFIG_KEY and (chosen or {}).get(CONFIG_KEY[p.kind]) == p.id


def _used(p: Provider, job: Mapping[str, Any]) -> bool:
    """Whether the job made this kind with this provider (the job's ``meta.providers``; the characters in a video
    are always drawn by the rig, whatever makes portraits)."""
    if p.kind == "images":
        return p.id == "builtin-rig"
    if p.kind == "writer":
        return True
    meta = job.get("meta") if isinstance(job.get("meta"), Mapping) else {}
    chosen = (meta or {}).get("providers") if isinstance((meta or {}).get("providers"), Mapping) else {}
    default = "builtin-2d" if p.kind == "animation" else "builtin-synth"
    found = (chosen or {}).get(p.kind) or (chosen or {}).get(CONFIG_KEY.get(p.kind, p.kind)) or default
    return str(found) == p.id


def proven(jobs: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """``PROVIDER#`` sort key → when a story job's step made by that provider last finished with real work. Only
    steps the job ran count (the others show ``done`` for files made before), and never a step with nothing to do."""
    out: dict[str, str] = {}
    for job in jobs:
        if job.get("contentType") != "animation":
            continue
        config = job.get("configuration") if isinstance(job.get("configuration"), Mapping) else {}
        run = set((config or {}).get("run") or [])
        steps = {str(s.get("key")): s for s in job.get("steps") or [] if isinstance(s, Mapping)}
        for p in REGISTRY:
            step = steps.get(PROOF_STEP[p.kind])
            if step is None or step.get("key") not in run or step.get("status") != "done":
                continue
            if str(step.get("message") or "").startswith(NOTHING_MADE) or not _used(p, job):
                continue
            at = str(step.get("finishedAt") or job.get("updatedAt") or "")
            key = provider_sk(p.kind, p.id)
            if at and at > out.get(key, ""):
                out[key] = at
    return out


def _writer_ok(model_statuses: Sequence[Mapping[str, Any]]) -> str | None:
    """When a model last answered (``MODELSTATUS#`` with ``ok``), else None."""
    times = [str(m.get("checkedAt") or "") for m in model_statuses if m.get("status") == "ok"]
    times = [t for t in times if t]
    return max(times) if times else None


def status(
    p: Provider,
    config: Mapping[str, Any],
    record: Mapping[str, Any] | None,
    proven_at: str | None = None,
    model_statuses: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label}
    if p.off_until_picked and not _selected(p, config):
        return {**out, "state": "off", "line": OFF_LINE}
    state = (record or {}).get("state")
    checked = (record or {}).get("checkedAt")
    checked = checked if isinstance(checked, str) and checked else None
    error = (record or {}).get("lastError")
    if p.kind == "writer":
        answered = max([t for t in (_writer_ok(model_statuses), proven_at) if t], default=None)
        if answered:
            return {**out, "state": "on", "line": p.line_on, "checkedAt": answered}
        line = WRITER_FAILED if model_statuses else p.line_unchecked
        return {**out, "state": "needs_setup", "line": line}
    if state == "on" and checked:
        return {**out, "state": "on", "line": p.line_on, "checkedAt": max(checked, proven_at or "")}
    if p.builtin:
        failed_later = state not in (None, "on") and checked and checked > (proven_at or "")
        if not failed_later:
            on = {**out, "state": "on", "line": p.line_on}
            return {**on, "checkedAt": proven_at} if proven_at else on
    out.update(state="needs_setup", line=str(error) if error else p.line_unchecked)
    if checked:
        out["checkedAt"] = checked
    if error:
        out["lastError"] = str(error)
    return out


def statuses(
    config: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    jobs: Iterable[Mapping[str, Any]] = (),
    model_statuses: Sequence[Mapping[str, Any]] = (),
) -> list[dict[str, Any]]:
    by_key = {str(r.get("sk")): r for r in records}
    proof = proven(jobs)
    return [
        status(
            p,
            config,
            by_key.get(provider_sk(p.kind, p.id)),
            proof.get(provider_sk(p.kind, p.id)),
            model_statuses,
        )
        for p in REGISTRY
    ]
