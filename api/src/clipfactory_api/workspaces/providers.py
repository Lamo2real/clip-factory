"""Who makes what (docs/CONTRACTS.md §45.11.6, §45.31, §45.37 G1–G3 and G7, ADR-75, ADR-80): a static mirror of the
agent's provider registry (``stories/agent/src/lamostories_agent/providers.py``), so ``GET …/providers`` answers
without the agent. Each maker row also lists its models (``models``: ``makers.model_info``), whether it is the
workspace's pick (``picked``) and the model it uses (``model``).

States:

* the built-in animator, sounds and characters (``builtin-2d``, ``builtin-synth``, ``builtin-rig``) are code in Lamo
  Stories' own image with nothing to set up: ``on`` (picked or not), with ``checkedAt`` the last time a story job's
  step made by it finished with real work; a later failure the agent recorded (``PROVIDER#``) shows instead;
* the writer (``bedrock-claude``) is ``on`` only after a model answered (a ``MODELSTATUS#`` with ``ok``) or a
  finished storyboard step;
* Amazon Nova Canvas and Amazon Nova Reel are ``ended`` (AWS ended both on 2026-09-30): "Ended by Amazon on 30 Sep
  2026" with the one-tap ``replacement`` (Stability AI, Luma AI Ray2); never the default, never called, never
  switched away from by itself;
* Luma AI Ray2 (``luma-ray``, US Oregon) is built but ``needs_setup`` until a ``PROVIDER#animation#luma-ray`` record
  says ``on`` (its "Try it" shot): it needs the off-by-default United States (Oregon) bucket and model access;
* your own video model (``own-video``) is the same: it writes its shots to the same off-by-default bucket, so only
  its own "Try it" shot (``PROVIDER#animation#own-video``) makes it ``on``, never the free access check;
* every other AI maker (``stability``, ``own-images``, ``polly``, ``elevenlabs``, ``own-sound``) is ``off`` until the
  owner picks it, then ``needs_setup`` until a real call (``PROVIDER#``) or the access check of the model it uses
  (``MAKERSTATUS#`` ``ok``, Check models) says it works; ElevenLabs first needs the owner's key, an own maker first
  needs a model, and an own model on a keyed host its key. Amazon Polly is the only maker that speaks words and is
  opt-in only.

A proof is of the model it was made with: a ``PROVIDER#`` record naming another ``model`` than the one in use, or
older than the owner's last change of his own model in use, proves nothing, and a newer failed access check of the
model in use wins over an older ``on``.

Nothing is shown as working because it was configured. **A maker that is not ready** (§45.34, §45.35 D3): a story's
create, produce and changes answer 409 with ``not_ready``'s sentence while the picked video maker is not ``on`` (or
ended), or the picked sound maker still lacks what only the owner can give (ElevenLabs' key, an own sound model);
nothing switches to another maker by itself (the agent's ``ProviderUnavailable`` is the second guard). Pictures
never stop a video: the picture maker makes portraits only, and ``portrait_problem`` gates those alone. **Try it**
(D2, G7): ``POST …/providers/{luma-ray|own-video}/check`` starts a one-step ``provider_check`` job (one 5-second
shot), never behind that guard, so the maker can become ready without making a video first.

``StoriesConfig.providers`` names the kinds ``images``, ``video`` and ``audio``; ``ProviderStatus.kind`` calls the
video kind ``animation`` (the registry's name).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from . import makers
from . import types as ws

KINDS: Final = ("writer", "images", "animation", "audio")
CONFIG_KEY: Final = {"images": "images", "animation": "video", "audio": "audio"}
MAKER_KIND: Final = {"images": "image", "animation": "video", "audio": "audio"}  # → makers.KINDS


@dataclass(frozen=True)
class Provider:
    kind: str
    id: str
    label: str
    builtin: bool
    line_on: str
    line_unchecked: str
    off_until_picked: bool = False  # off until the owner picks it (§45.11.6, G7)
    key_host: str | None = None  # the keyed host whose key it needs (G4: ElevenLabs)
    own: bool = False  # the owner's own models (G2): it needs one first


LUMA_NOT_READY: Final = (
    "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, "
    "and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup."
)
POLLY_LINE: Final = "Adds words spoken aloud. Your videos are made without a voice unless you pick this."

REGISTRY: Final[tuple[Provider, ...]] = (
    Provider(
        "writer",
        "bedrock-claude",
        "Claude on Amazon Bedrock",
        False,
        "Writes every story with the model and effort picked in Clip Factory Stories › Settings › AI.",
        "Not checked yet. Tap Check models in Clip Factory Stories › Settings › AI.",
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
        "Made AI portraits of your characters.",
        "Ended by Amazon on 30 Sep 2026.",
        off_until_picked=True,
    ),
    Provider(
        "animation",
        "builtin-2d",
        "Built-in animation",
        True,
        "Built in: animates every scene at the video's size, 30 frames a second. Nothing to set up.",
        "",
    ),
    Provider(
        "animation",
        "nova-reel",
        "Amazon Nova Reel 1.1 (AI video)",
        False,
        "Made 6-second AI shots for scenes with no characters (cut-aways).",
        "Ended by Amazon on 30 Sep 2026.",
    ),
    Provider(
        "audio",
        "builtin-synth",
        "Built-in sounds and music",
        True,
        "Built in: makes every sound effect, character noise and music track itself. Nothing to set up.",
        "",
    ),
    Provider(
        "images",
        "stability",
        "Stability AI pictures",
        False,
        "Makes AI portraits of your characters with Stability AI on Amazon Bedrock. Runs in the US (Oregon). They "
        "show in the app and the Library only, never in a posted video.",
        "Make one portrait, or tap Check models, to check it. If Bedrock says no, turn on the Stability AI model in "
        "the Bedrock console in US West (Oregon).",
        off_until_picked=True,
    ),
    Provider(
        "images",
        "own-images",
        "Your own picture model",
        False,
        "Makes AI portraits of your characters with the picture model you added. They show in the app and the "
        "Library only, never in a posted video.",
        "Tap Check models to see if your picture model works.",
        off_until_picked=True,
        own=True,
    ),
    Provider(
        "animation",
        "luma-ray",
        "Luma AI Ray2 (AI video)",
        False,
        "Makes 5-second AI shots for scenes with no characters (cut-aways). Runs in the US (Oregon). Videos that use "
        "them are posted with the platforms' AI labels.",
        LUMA_NOT_READY,
    ),
    Provider(
        "animation",
        "own-video",
        "Your own video model",
        False,
        "Makes AI shots for scenes with no characters (cut-aways) with the video model you added. Videos that use "
        "them are posted with the platforms' AI labels.",
        "Tap Check models to see if your video model works.",
        off_until_picked=True,
        own=True,
    ),
    Provider(
        "audio",
        "polly",
        "A spoken voice (Amazon Polly)",
        False,
        POLLY_LINE,
        "Tap Check models to see if Amazon Polly works for you. " + POLLY_LINE,
        off_until_picked=True,
    ),
    Provider(
        "audio",
        "elevenlabs",
        "ElevenLabs sound effects and music",
        False,
        "Makes the sound effects and an instrumental music bed with your ElevenLabs account. Never a voice.",
        "Key saved. Tap Check models to see if ElevenLabs works.",
        off_until_picked=True,
        key_host="elevenlabs",
    ),
    Provider(
        "audio",
        "own-sound",
        "Your own sound model",
        False,
        "Makes the sound effects and the music bed with the sound model you added. Never a voice.",
        "Tap Check models to see if your sound model works.",
        off_until_picked=True,
        own=True,
    ),
)
KIND_WORDS: Final = {"images": "Picture maker", "animation": "Video maker", "audio": "Sound maker"}
OFF_LINE: Final = "Off. Pick it in Clip Factory Stories › Settings › Video › Picture maker to use it."
WRITER_FAILED: Final = "No model has answered yet. Tap Check models in Clip Factory Stories › Settings › AI to see why."
PROOF_STEP: Final = {"writer": "storyboard", "images": "scenes", "animation": "animation", "audio": "sound"}
NOTHING_MADE: Final = "Nothing changed"  # the agent's message for a step that had nothing to (re)make
JOBS_READ: Final = 200  # the newest story jobs looked at for proof
NEEDS_KEY: Final = {"elevenlabs": "Paste your ElevenLabs key in Clip Factory Stories › Settings › Video to use it."}
KEY_PLACE: Final = {
    "elevenlabs": "Clip Factory Stories › Settings › Video",
    "openai_compatible": "Clip Factory Stories › Settings › AI › Provider keys",
    "anthropic": "Clip Factory Stories › Settings › AI › Provider keys",
}


def needs_key(host: str) -> str:
    """What a maker whose model runs on a keyed host says while that host has no saved key."""
    from .hosts import LABEL

    return f"Paste your {LABEL.get(host, host)} key in {KEY_PLACE.get(host, KEY_PLACE['anthropic'])} to use it."


def _model_needs_key(model: Mapping[str, Any] | None, known: Known) -> str | None:
    """The keyed host of the model in use when its key is not saved, else None."""
    from .provider_keys import KEYED

    host = str((model or {}).get("hostId") or "")
    return host if host in KEYED and host not in known.keys else None


def off_line(p: Provider) -> str:
    """What an AI maker that is not picked says (one place to pick it, per kind)."""
    if p.id == "polly":
        return f"Off. {POLLY_LINE}"
    where = KIND_WORDS.get(p.kind, "Picture maker")
    return f"Off. Pick it in Clip Factory Stories › Settings › Video › {where} to use it."


def own_missing(p: Provider) -> str:
    word = makers.KIND_WORD[MAKER_KIND[p.kind]]
    return f"Add a {word} model first: tap Add a model in Clip Factory Stories › Settings › Video."


# What a story's create, produce and changes say while the picked maker is not ready (§45.34, G7: Luma AI Ray2's
# sentence word for word in the agent too).
NOT_READY: Final = {
    "luma-ray": LUMA_NOT_READY,
    "own-video": (
        "Your own video model is not ready yet: it needs a storage bucket in the United States (Oregon), which is "
        "switched off, and the model turned on for your account. Pick Built-in animation in Settings › Video, or "
        "finish its setup and tap Try it."
    ),
    "elevenlabs": (
        "ElevenLabs is not ready yet: it needs your ElevenLabs key. Paste it in Settings › Video, or pick Built-in "
        "sounds and music there."
    ),
    "own-sound": (
        "Your own sound model is not ready yet: add a sound model in Settings › Video, or pick Built-in sounds and "
        "music there."
    ),
}


# "Try it" (§45.35 D2, G7): the makers that can be tried once from Settings › Video, by id → their registry kind.
CHECKABLE: Final = {"luma-ray": "animation", "own-video": "animation"}
CHECK_JOB_TYPE: Final = "provider_check"
CHECK_CONTENT_TYPE: Final = "provider"
CHECK_STEP: Final = "check"
CHECK_BUSY: Final = "Luma AI Ray2 is being tried. Wait until it is done."
CHECK_BUSY_LINE: Final = {
    "luma-ray": CHECK_BUSY,
    "own-video": "Your own video model is being tried. Wait until it is done.",
}
ONLY_TRY: Final = "Only Luma AI Ray2 and your own video model have a Try it."


def try_problem(provider_id: str, config: Mapping[str, Any], known: Known) -> str | None:
    """Why "Try it" cannot start for this maker (409), or None: an own video model must be added first."""
    p = find(provider_id, CHECKABLE.get(provider_id))
    if p is None or not p.own:
        return None
    model = _maker_model(p, config, known)
    if model is None:
        return own_missing(p)
    keyless = _model_needs_key(model, known)
    return needs_key(keyless) if keyless is not None else None


def check_job_of(jobs: Iterable[Mapping[str, Any]], provider_id: str) -> Mapping[str, Any] | None:
    """The newest "Try it" job of this maker among ``jobs`` (newest first, as ``GET …/providers`` reads them)."""
    for job in jobs:
        if (
            job.get("jobType") == CHECK_JOB_TYPE
            and job.get("contentType") == CHECK_CONTENT_TYPE
            and job.get("contentId") == provider_id
        ):
            return job
    return None


def check_lock_sk(provider_id: str) -> str:
    """``CHECKLOCK#{providerId}``: names the maker's newest "Try it" job (``checkJobId``). Every new try replaces it
    in one transaction with its job, on the condition that it still names the job that was read (or is absent), so
    two taps at the same moment never start two billed shots (§45.35 D2, "one at a time"). Internal: never returned,
    written only by the API, never read by the agent."""
    return f"{ws.CHECKLOCK_SK}{provider_id}"


def provider_sk(kind: str, provider_id: str) -> str:
    return f"{ws.PROVIDER_SK}{kind}#{provider_id}"


def find(provider_id: Any, kind: str | None = None) -> Provider | None:
    return next((p for p in REGISTRY if p.id == provider_id and (kind is None or p.kind == kind)), None)


def _chosen(config: Mapping[str, Any]) -> Mapping[str, Any]:
    found = config.get("providers")
    return found if isinstance(found, Mapping) else {}


def _selected(p: Provider, config: Mapping[str, Any]) -> bool:
    return p.kind in CONFIG_KEY and _chosen(config).get(CONFIG_KEY[p.kind]) == p.id


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


@dataclass(frozen=True)
class Known:
    """What the maker rows read besides ``PROVIDER#``: every maker model (bundled and the owner's), their access
    checks (``MAKERSTATUS#`` by model key) and the keyed hosts whose key is saved."""

    models: tuple[Mapping[str, Any], ...] = ()
    checks: Mapping[str, Mapping[str, Any]] | None = None
    keys: frozenset[str] = frozenset()

    @classmethod
    def bundled(cls) -> Known:
        return cls(models=tuple(makers.bundled()))


def _maker_model(p: Provider, config: Mapping[str, Any], known: Known) -> Mapping[str, Any] | None:
    """The model this maker uses: the workspace's pick when the maker is picked, else its first that has not ended."""
    kind = MAKER_KIND.get(p.kind)
    if kind is None:
        return None
    providers = dict(_chosen(config))
    providers[makers.MAKER_FIELD[kind]] = p.id
    if not _selected(p, config):
        providers[makers.PICK_FIELD[kind]] = None
    return makers.effective_model(providers, kind, known.models)


def status(
    p: Provider,
    config: Mapping[str, Any],
    record: Mapping[str, Any] | None,
    proven_at: str | None = None,
    model_statuses: Sequence[Mapping[str, Any]] = (),
    *,
    known: Known | None = None,
) -> dict[str, Any]:
    known = known if known is not None else Known.bundled()
    out: dict[str, Any] = {"kind": p.kind, "id": p.id, "label": p.label}
    gone = makers.maker_ended(p.id)
    if gone is not None:  # G7: ended by its maker; never "off" or "needs setup" (nothing would make it work again)
        out.update(state="ended", line=f"{makers.ended_line(gone)}.", endedAt=str(gone.get("ended")))
        if p.id in makers.REPLACEMENT:
            out["replacement"] = makers.REPLACEMENT[p.id]
        return out
    if p.off_until_picked and not _selected(p, config):
        return {**out, "state": "off", "line": off_line(p)}
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
    if p.key_host is not None and p.key_host not in known.keys:
        return {**out, "state": "needs_setup", "line": NEEDS_KEY.get(p.id, p.line_unchecked)}
    model = None if p.builtin else _maker_model(p, config, known)
    if p.own and model is None:
        return {**out, "state": "needs_setup", "line": own_missing(p)}
    keyless = _model_needs_key(model, known)
    if keyless is not None:
        return {**out, "state": "needs_setup", "line": needs_key(keyless)}
    access = (known.checks or {}).get(str((model or {}).get("key") or "")) if model is not None else None
    access_at = str((access or {}).get("checkedAt") or "")
    if state == "on" and checked and not _proves(record, model, checked):
        state = None  # a proof of another model (or of this own model before the owner changed it)
    newer_access = access is not None and access_at > (checked or "")
    failed_since = newer_access and str((access or {}).get("status") or "") in ("denied", "not_found", "error")
    if state == "on" and checked and not failed_since:
        return {**out, "state": "on", "line": p.line_on, "checkedAt": max(checked, proven_at or "")}
    if p.builtin:
        failed_later = state not in (None, "on") and checked and checked > (proven_at or "")
        if not failed_later:
            on = {**out, "state": "on", "line": p.line_on}
            return {**on, "checkedAt": proven_at} if proven_at else on
    if p.id not in CHECKABLE and newer_access and (access or {}).get("status") == "ok":
        # the access check of the model it uses answered "Works" (G2): Luma AI Ray2 and your own video model also
        # need their bucket, so only their own "Try it" shot makes them on
        return {**out, "state": "on", "line": p.line_on, "checkedAt": access_at}
    out.update(state="needs_setup", line=str(error) if error else p.line_unchecked)
    failed = str((access or {}).get("status") or "")
    if newer_access and failed in ("denied", "not_found", "error"):
        out["line"] = str((access or {}).get("line") or makers.STATUS_LINE[failed])
        out["lastError"] = out["line"]
        out["checkedAt"] = access_at
        return out
    if checked:
        out["checkedAt"] = checked
    if error:
        out["lastError"] = str(error)
    return out


def _proves(record: Mapping[str, Any] | None, model: Mapping[str, Any] | None, checked: str) -> bool:
    """Whether a ``PROVIDER#`` proof covers the model in use: one that names its ``model`` must name this one, and an
    own model the owner changed after the proof was made is not the one proven."""
    if model is None:
        return True
    named = (record or {}).get("model")
    if isinstance(named, str) and named and named != model.get("key"):
        return False
    changed = str(model.get("changedAt") or "")
    return not (model.get("custom") and changed and changed > checked)


def statuses(
    config: Mapping[str, Any],
    records: Sequence[Mapping[str, Any]],
    jobs: Iterable[Mapping[str, Any]] = (),
    model_statuses: Sequence[Mapping[str, Any]] = (),
    known: Known | None = None,
) -> list[dict[str, Any]]:
    """Every row of ``GET …/providers``: the registry in order, each maker with its models, ``picked`` and the model
    it uses (``model``)."""
    known = known if known is not None else Known.bundled()
    by_key = {str(r.get("sk")): r for r in records}
    proof = proven(jobs)
    out = []
    for p in REGISTRY:
        row = status(
            p,
            config,
            by_key.get(provider_sk(p.kind, p.id)),
            proof.get(provider_sk(p.kind, p.id)),
            model_statuses,
            known=known,
        )
        kind = MAKER_KIND.get(p.kind)
        if kind is not None:
            row["picked"] = _selected(p, config)
            used = None if p.builtin or row["state"] == "ended" else _maker_model(p, config, known)
            row["model"] = str(used["key"]) if used else None
            if not p.builtin:
                row["models"] = [
                    makers.model_info(m, (known.checks or {}).get(str(m["key"])))
                    for m in makers.models_of(p.id, known.models)
                ]
        out.append(row)
    return out


# The makers whose state stops a story's create, produce and changes (§45.35 D3: the video maker; the sound maker
# only for what only the owner can give; the picture maker makes portraits, which never stop a video).
GATES_VIDEOS: Final = ("animation", "audio")


def not_ready(
    config: Mapping[str, Any], records: Sequence[Mapping[str, Any]], known: Known | None = None
) -> str | None:
    """The sentence a story's create, produce or changes stops with (409) while the picked video maker is not ``on``
    (or has ended), or the picked sound maker lacks its key or model; None when it is ready. Nothing is switched to a
    built-in maker. A recorded failure is said in the agent's own words. The picture maker is never looked at here
    (§45.35 D3)."""
    known = known if known is not None else Known.bundled()
    by_key = {str(r.get("sk")): r for r in records}
    chosen = _chosen(config)
    for kind in GATES_VIDEOS:
        picked = chosen.get(CONFIG_KEY[kind])
        p = find(picked, kind)
        if p is None or p.builtin:
            continue
        gone = makers.maker_ended(p.id)
        if gone is not None:
            return makers.ended_sentence(gone)
        model = _maker_model(p, config, known)
        if model is not None and model.get("ended"):
            return makers.ended_sentence(model)
        record = by_key.get(provider_sk(p.kind, p.id))
        shown = status(p, config, record, known=known)
        if p.own and model is None:  # nothing to check yet: the owner adds a model first
            return NOT_READY["own-sound"] if kind == "audio" else own_missing(p)
        keyless = _model_needs_key(model, known)
        if kind == "audio":
            if p.key_host is not None and p.key_host not in known.keys:
                return NOT_READY.get(p.id, str(shown["line"]))
            if keyless is not None:
                return needs_key(keyless)
            continue
        if shown["state"] == "on":
            continue
        error = (record or {}).get("lastError")
        return str(error) if isinstance(error, str) and error.strip() else NOT_READY.get(p.id, shown["line"])
    return None


IMAGES_OFF: Final = "AI pictures are off. Turn them on in Clip Factory Stories › Settings › Video › Picture maker."


def portrait_problem(config: Mapping[str, Any], known: Known | None = None) -> str | None:
    """Why a portrait cannot be made with the picked picture maker (409), or None: the built-in characters make no
    portraits, an ended maker or model is never called (G7), an own maker needs a model first."""
    known = known if known is not None else Known.bundled()
    picked = _chosen(config).get("images")
    p = find(picked, "images")
    if p is None or p.builtin:
        return IMAGES_OFF
    gone = makers.maker_ended(p.id)
    if gone is not None:
        return makers.ended_sentence(gone)
    model = _maker_model(p, config, known)
    if model is not None and model.get("ended"):
        return makers.ended_sentence(model)
    if p.own and model is None:
        return own_missing(p)
    keyless = _model_needs_key(model, known)
    if keyless is not None:
        return needs_key(keyless)
    return None
