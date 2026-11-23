"""The picture, video and sound makers and their models (docs/CONTRACTS.md §45.37 G1–G3, G7; the owner's second
request §5: "Image-generation models. Video-generation models. Audio-generation models … allow me to select these
providers and models independently", and §3: "support adding new models and providers without rebuilding the
application").

**Makers** are the ids ``StoriesConfig.providers`` names (G7):

* pictures (``images``): ``builtin-rig`` (the default), ``nova-canvas`` (ended), ``stability`` (Stability AI on
  Amazon Bedrock, US Oregon), ``own-images`` (picture models the owner adds);
* video (``video``): ``builtin-2d`` (the default), ``nova-reel`` (ended), ``luma-ray`` (Luma AI Ray2 on Amazon
  Bedrock, US Oregon: cut-aways; "Try it" lives here), ``own-video``;
* sound (``audio``): ``builtin-synth`` (the default), ``polly`` (Amazon Polly neural voices: opt-in, the only maker
  that speaks words, never the default), ``elevenlabs`` (the owner's ElevenLabs key: sound effects and an instrumental
  music bed only, never its text-to-speech), ``own-sound`` (sound models the owner adds).

**Models.** ``stories/config/models.json`` lists the bundled ones in ``imageModels``, ``videoModels`` and
``audioModels`` (each ``maker`` = its maker id). A file from before the lists has one ``imageModel`` and one
``videoModel``; each reads as a one-item list (``nova-canvas`` / ``nova-reel``), so nothing breaks whichever shape the
file has. ``ended`` (a day) marks a model its maker retired; a maker whose bundled models have all ended is ended too:
it is never the default, never newly picked, never called (an existing pick is refused at the next job with
``ended_sentence``), and reads "Ended by Amazon on 30 Sep 2026" with its replacement one tap away.

**Picks.** ``StoriesConfig.providers`` keeps ``images`` / ``video`` / ``audio`` (the maker) and gains ``imageModel``
/ ``videoModel`` / ``audioModel``: a model key of the picked maker, or null for that maker's first model that has
not ended. ``PATCH /v1/workspaces/{ws}`` checks them (``clean_providers``): only what the body changes is held to
"not ended", so an older stored pick never blocks another setting; changing the maker without a model resets the
model to null. The agent reads the workspace's pick per job (never a cached process-wide choice).

**The owner's own maker models** (G2): ``MAKERDEF#{key}`` items, ``PUT`` / ``DELETE
/v1/workspaces/{ws}/makers/models/{key}``: a key ``^custom-[a-z0-9-]{1,40}$`` (never a bundled key, never an added
reasoning model's key), at most ``MAX_PER_KIND`` per kind, ``409`` on delete while Settings › Video picks it. Where
it runs (G4), and only what Lamo Stories' agent can call is accepted: pictures on ``bedrock`` (a ``stability.*`` or
``amazon.titan-image*`` model, also as a cross-Region profile id or an ARN) or ``openai_compatible`` (``POST
{baseUrl}/images/generations``); video on ``bedrock`` only (a ``luma.*`` model); sound on ``elevenlabs`` only, and
only its sound-effect (``eleven_text_to_sound*``) and music (``music_*``) models, never its text-to-speech. Amazon
Bedrock has no sound model, so a Bedrock sound model is refused with a sentence (the host stays known, for the day
Amazon adds one). A model id Amazon ended (Nova Canvas, Nova Reel) is never added again (G7). They belong to the
``own-*`` maker of their kind. **Check models** (``POST …/ai/check-models`` with
``makers``) asks the agent for an access check that costs nothing (Bedrock ``GetFoundationModelAvailability`` /
``GetFoundationModel`` in the model's Region, ElevenLabs a GET of its model list, Polly ``DescribeVoices``), written
to ``MAKERSTATUS#{key}`` (``ok`` "Works", ``denied`` "No access", ``not_found`` "Not found", with the provider's own
sentence). Nothing is shown as working because it is listed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any, Final

from .. import db, validate
from ..clock import iso
from ..errors import bad_request, conflict, not_found
from ..log import log
from . import ai_config as cfg
from . import config, hosts
from . import types as ws

KINDS: Final = ("image", "video", "audio")
MAKER_FIELD: Final = {"image": "images", "video": "video", "audio": "audio"}  # StoriesConfig.providers keys
PICK_FIELD: Final = {"image": "imageModel", "video": "videoModel", "audio": "audioModel"}
PICK_FIELDS: Final = tuple(PICK_FIELD.values())
STATUS_KIND: Final = {"image": "images", "video": "animation", "audio": "audio"}  # ProviderStatus.kind
KIND_OF_FIELD: Final = {v: k for k, v in MAKER_FIELD.items()}
LIST_FIELD: Final = {"image": "imageModels", "video": "videoModels", "audio": "audioModels"}
OLD_FIELD: Final = {"image": "imageModel", "video": "videoModel"}
OLD_KEY: Final = {"image": "nova-canvas", "video": "nova-reel"}  # an older file's one entry: its key and maker
BUILTIN: Final = {"image": "builtin-rig", "video": "builtin-2d", "audio": "builtin-synth"}
OWN: Final = {"image": "own-images", "video": "own-video", "audio": "own-sound"}
MAKERS: Final = {
    "image": ("builtin-rig", "nova-canvas", "stability", "own-images"),
    "video": ("builtin-2d", "nova-reel", "luma-ray", "own-video"),
    "audio": ("builtin-synth", "polly", "elevenlabs", "own-sound"),
}
# The one-tap replacement of an ended maker (G7): never switched to by itself.
REPLACEMENT: Final = {"nova-canvas": "stability", "nova-reel": "luma-ray"}
# Where a maker model of each kind may run (G4). Anthropic's API makes text only; an OpenAI-compatible sound API
# speaks words, which Lamo Stories never adds (G3); video makers are Bedrock only.
KIND_HOSTS: Final = {
    "image": (hosts.BEDROCK, hosts.OPENAI_COMPATIBLE),
    "video": (hosts.BEDROCK,),
    "audio": (hosts.ELEVENLABS, hosts.BEDROCK),
}
# A Bedrock picture model the agent knows how to call (G7): Stability AI's or Amazon Titan Image's (Nova Canvas, the
# third family the agent knows, was ended by Amazon: ``ENDED_FAMILIES``).
BEDROCK_PICTURE: Final = re.compile(r"^(?:stability\.|amazon\.titan-image)")
# A Bedrock video model the agent knows how to call: Luma AI's (Nova Reel was ended by Amazon).
BEDROCK_VIDEO: Final = re.compile(r"^luma\.")
# Model families Amazon ended (G7): never added as an own model, whatever version or spelling.
ENDED_FAMILIES: Final = re.compile(r"^amazon\.nova-(?:canvas|reel)")
# ElevenLabs makes sound effects and music for Lamo Stories, never a voice (G3, G7).
ELEVENLABS_SOUND: Final = re.compile(r"^(?:eleven_text_to_sound|music_)")
KIND_WORD: Final = {"image": "picture", "video": "video", "audio": "sound"}
MAX_PER_KIND: Final = 20
LABEL_MAX: Final = 60
PROVIDER_MAX: Final = 40
NOTE_MAX: Final = 200
PRICE_UNITS: Final = ("image", "second", "character", "request")
FIELDS: Final = ("kind", "label", "provider", "host", "baseUrl", "modelId", "region", "price", "note")
STATUSES: Final = ("ok", "not_checked", "denied", "not_found", "error")
# One set of status words everywhere (round 5 E17).
STATUS_LINE: Final = {
    "ok": "Works.",
    "not_checked": "Not checked yet. Tap Check models to see if it works.",
    "denied": "No access.",
    "not_found": "Not found.",
    "error": "Problem. Tap Check models to try again.",
}
MONTHS: Final = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
REGION_WORDS: Final = {
    "us-west-2": "Runs in the US (Oregon)",
    "us-east-1": "Runs in the US (N. Virginia)",
    "eu-west-1": "Runs in Europe (Ireland)",
    "eu-north-1": "Runs in Europe (Stockholm)",
}

NOT_FOUND: Final = "Clip Factory Stories has no picture, video or sound model you added with that name."
BAD_KIND: Final = "Say what the model makes: image (pictures), video or audio (sound effects and music)."
BUNDLED: Final = "That model comes with Clip Factory Stories, so it can't be changed or removed."
REASONING_TAKEN: Final = "You already added an AI model with that name in Settings › AI. Pick another name."
KIND_FIXED: Final = "A model you added keeps what it makes. Remove it and add it again as another kind."
BAD_PICTURE_MODEL: Final = (
    "Clip Factory Stories can make pictures on Amazon Bedrock with Stability AI's or Amazon Titan Image's models. "
    "Paste a model id like stability.stable-image-core-v1:1."
)
BAD_VIDEO_MODEL: Final = (
    "Clip Factory Stories can make video on Amazon Bedrock with Luma AI's models only. Paste a model id like "
    "luma.ray-v2:0."
)
ENDED_MODEL: Final = (
    "Amazon ended that model on 30 Sep 2026, so it can't be added. Pick another model, like "
    "stability.stable-image-core-v1:1 for pictures or luma.ray-v2:0 for video."
)
NO_BEDROCK_SOUND: Final = (
    "Amazon Bedrock has no sound-effect or music model yet, so Clip Factory Stories can't add one there. Add an "
    "ElevenLabs model instead, like eleven_text_to_sound_v2."
)
ELEVENLABS_ONLY_SOUND: Final = (
    "ElevenLabs is used for sound effects and music only, never a voice. Paste a model like eleven_text_to_sound_v2 "
    "or music_v1."
)
BAD_PRICE: Final = "Type the price of one picture, one second, one character or one request, like perUnit 0.04 USD."


def makerdef_sk(key: str) -> str:
    return f"{ws.MAKERDEF_SK}{key}"


def makerstatus_sk(key: str) -> str:
    return f"{ws.MAKERSTATUS_SK}{key}"


def kind_of_maker(maker: Any) -> str | None:
    return next((k for k in KINDS if maker in MAKERS[k]), None)


def bad_host(kind: str) -> str:
    where = {
        "image": "Amazon Bedrock (bedrock) or an OpenAI-compatible API (openai_compatible)",
        "video": "Amazon Bedrock (bedrock)",
        "audio": "ElevenLabs (elevenlabs) or Amazon Bedrock (bedrock): sound effects and music only, never a voice",
    }[kind]
    return f"A {KIND_WORD[kind]} model runs on {where}."


# --- the bundled models (stories/config/models.json) ------------------------------------------------------------


def _text(value: Any, default: str = "") -> str:
    return " ".join(value.split()) if isinstance(value, str) else default


def file_price(value: Any) -> dict[str, Any] | None:
    """A ``{ perUnit, unit, currency }`` price, or None (an older file's ``pricing: null``)."""
    if not isinstance(value, Mapping):
        return None
    per = value.get("perUnit")
    unit = value.get("unit")
    if isinstance(per, bool) or not isinstance(per, int | float) or unit not in PRICE_UNITS:
        return None
    return {"perUnit": float(per), "unit": str(unit), "currency": str(value.get("currency") or "USD")}


def _entry(raw: Mapping[str, Any], kind: str, key: str, maker: str) -> dict[str, Any]:
    region = raw.get("region")
    ended = raw.get("ended")
    out: dict[str, Any] = {
        "key": key,
        "label": _text(raw.get("label"), key),
        "provider": _text(raw.get("provider"), "Amazon"),
        "maker": maker,
        "hostId": hosts.host_id(raw.get("host"), bundled=True),
        "host": _text(raw.get("host"), hosts.LABEL[hosts.BEDROCK]),
        "modelId": _text(raw.get("modelId")),
        "region": str(region) if isinstance(region, str) and region else None,
        "kind": kind,
        "price": file_price(raw.get("price") if "price" in raw else raw.get("pricing")),
        "note": _text(raw.get("note")),
        "ended": str(ended) if isinstance(ended, str) and ended else None,
        "custom": False,
    }
    if out["hostId"] in hosts.HOSTS and out["hostId"] != hosts.BEDROCK:
        out["host"] = hosts.host_label(out["hostId"])
    return out


def bundled(kind: str | None = None) -> list[dict[str, Any]]:
    """The bundled maker models of one kind (or all), in the file's order; an older file's single entries as
    one-item lists."""
    found = config.load("models.json")
    out: list[dict[str, Any]] = []
    for k in KINDS:
        if kind is not None and k != kind:
            continue
        listed = found.get(LIST_FIELD[k])
        if isinstance(listed, list):
            for raw in listed:
                if isinstance(raw, Mapping) and isinstance(raw.get("key"), str) and raw["key"]:
                    maker = raw.get("maker") if isinstance(raw.get("maker"), str) and raw["maker"] else raw["key"]
                    out.append(_entry(raw, k, str(raw["key"]), str(maker)))
            continue
        old = found.get(OLD_FIELD[k]) if k in OLD_FIELD else None
        if isinstance(old, Mapping):
            out.append(_entry(old, k, OLD_KEY[k], OLD_KEY[k]))
    return out


def bundled_keys() -> set[str]:
    return {str(m["key"]) for m in bundled()}


def ended_day(raw: Any) -> str:
    """``2026-09-30`` → ``30 Sep 2026``."""
    try:
        day = date.fromisoformat(str(raw)[:10])
    except ValueError:
        return str(raw)
    return f"{day.day} {MONTHS[day.month - 1]} {day.year}"


def ended_line(m: Mapping[str, Any]) -> str:
    """ "Ended by Amazon on 30 Sep 2026" (G7)."""
    return f"Ended by {m.get('provider') or 'its maker'} on {ended_day(m.get('ended'))}"


def ended_sentence(m: Mapping[str, Any]) -> str:
    """What a pick of an ended model or maker is refused with, before any call (G7): "Amazon Nova Canvas was ended by
    Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › Settings › Video." """
    word = KIND_WORD.get(str(m.get("kind")), "picture")
    return (
        f"{m.get('label')} was ended by {m.get('provider') or 'its maker'} on {ended_day(m.get('ended'))}. "
        f"Pick another {word} maker in Clip Factory Stories › Settings › Video."
    )


def maker_ended(maker: str) -> dict[str, Any] | None:
    """The bundled model that stands for a maker whose bundled models have all ended (None while one still runs, and
    for the built-in and own makers, which never end)."""
    own = [m for m in bundled() if m.get("maker") == maker]
    if own and all(m.get("ended") for m in own):
        return own[0]
    return None


def region_words(region: Any) -> str | None:
    if not isinstance(region, str) or not region:
        return None
    return REGION_WORDS.get(region, f"Runs in {region}")


# --- the owner's own models (MAKERDEF#) -------------------------------------------------------------------------


def items(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    return [
        i for i in cfg.query_owned(store, user_id, workspace_id, ws.MAKERDEF_SK) if i.get("type") == ws.TYPE_MAKERDEF
    ]


def as_model(item: Mapping[str, Any]) -> dict[str, Any] | None:
    """A ``MAKERDEF#`` item as a maker model (``custom: True``, its maker the ``own-*`` one of its kind), or None
    when it is not a usable one."""
    from .model_defs import KEY

    key, kind, model_id = item.get("key"), item.get("kind"), item.get("modelId")
    if not isinstance(key, str) or not KEY.match(key) or kind not in KINDS or not isinstance(model_id, str):
        return None
    host = hosts.host_id(item.get("host"))
    if host not in KIND_HOSTS[str(kind)]:
        return None
    region = item.get("region") if host == hosts.BEDROCK else None
    if host == hosts.BEDROCK and not isinstance(region, str):
        return None
    base_url = item.get("baseUrl") if host == hosts.OPENAI_COMPATIBLE else None
    out: dict[str, Any] = {
        "key": key,
        "label": _text(item.get("label"), key),
        "provider": _text(item.get("provider")),
        "maker": OWN[str(kind)],
        "hostId": host,
        "host": hosts.host_label(host, base_url),
        "modelId": model_id,
        "region": region,
        "kind": str(kind),
        "price": file_price(item.get("price")),
        "note": _text(item.get("note")),
        "ended": None,
        "custom": True,
        # internal (never in MakerModelInfo): a proof older than this change is not one of this model (providers)
        "changedAt": str(item.get("updatedAt") or ""),
    }
    if isinstance(base_url, str) and base_url:
        out["baseUrl"] = base_url
    return out


def custom(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    """The workspace's own maker models, by key; a key the file has is never one."""
    taken = bundled_keys()
    out = []
    for item in sorted(items(store, user_id, workspace_id), key=lambda i: str(i.get("key") or "")):
        found = as_model(item)
        if found is not None and found["key"] not in taken:
            out.append(found)
    return out


def all_models(extra: Iterable[Mapping[str, Any]] = ()) -> list[dict[str, Any]]:
    return [*bundled(), *[dict(m) for m in extra]]


def models_of(maker: str, models: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [dict(m) for m in models if m.get("maker") == maker]


def find(key: Any, models: Iterable[Mapping[str, Any]]) -> dict[str, Any] | None:
    return next((dict(m) for m in models if m.get("key") == key), None) if isinstance(key, str) else None


def effective_model(
    providers: Mapping[str, Any], kind: str, models: Iterable[Mapping[str, Any]]
) -> dict[str, Any] | None:
    """The model the picked maker of ``kind`` uses: the pick when it is one of the maker's, else the maker's first
    model that has not ended; None for a built-in maker (or one with no model)."""
    listed = list(models)
    maker = str(providers.get(MAKER_FIELD[kind]) or BUILTIN[kind])
    own = models_of(maker, listed)
    picked = find(providers.get(PICK_FIELD[kind]), own)
    if picked is not None:
        return picked
    return next((m for m in own if not m.get("ended")), None)


# --- checking the picks (PATCH /v1/workspaces/{ws}) -------------------------------------------------------------


def clean_providers(
    current: Mapping[str, Any], body: Mapping[str, Any], models: Iterable[Mapping[str, Any]]
) -> dict[str, Any]:
    """``configuration.providers`` merged onto the stored one and checked (G1, G7). Every maker must be one of its
    kind's; a maker or model the body picks must not have ended; a model must be one of its maker's (a built-in
    maker has none); a new maker without a model in the body resets the model to null."""
    listed = list(models)
    known = {*MAKER_FIELD.values(), *PICK_FIELDS}
    validate.only_keys(body, known)
    merged: dict[str, Any] = {**{k: current.get(k) for k in known}, **dict(body)}
    for kind in KINDS:
        field, pick = MAKER_FIELD[kind], PICK_FIELD[kind]
        maker = merged.get(field) or BUILTIN[kind]
        if maker not in MAKERS[kind]:
            raise bad_request(f"configuration.providers.{field} is not a provider of that kind.")
        merged[field] = maker
        changed_maker = field in body and body[field] != current.get(field)
        if changed_maker:
            gone = maker_ended(str(maker))
            if gone is not None:
                raise bad_request(ended_sentence(gone), f"configuration.providers.{field}")
            if pick not in body:
                merged[pick] = None
        value = merged.get(pick)
        if pick not in body and not changed_maker:
            continue  # a stored pick is not looked at again: only what the body changes
        if value is None or value == "":
            merged[pick] = None
            continue
        if not isinstance(value, str):
            raise bad_request(f"configuration.providers.{pick} must be a model name or null.")
        own = models_of(str(maker), listed)
        if not own:
            raise bad_request(
                f"The maker picked in configuration.providers.{field} has no models to pick. Leave {pick} empty.",
                f"configuration.providers.{pick}",
            )
        found = find(value, own)
        if found is None:
            raise bad_request(
                f"'{value}' is not a model of that {KIND_WORD[kind]} maker. Pick one of its models.",
                f"configuration.providers.{pick}",
            )
        if found.get("ended"):
            raise bad_request(ended_sentence(found), f"configuration.providers.{pick}")
    return merged


def picked_keys(providers: Mapping[str, Any]) -> dict[str, str]:
    """The model keys the saved picks name, by kind (only those set)."""
    return {k: str(providers[PICK_FIELD[k]]) for k in KINDS if isinstance(providers.get(PICK_FIELD[k]), str)}


# --- statuses (MAKERSTATUS#, written only by the agent) ---------------------------------------------------------


def status_items(store: db.Store, user_id: str, workspace_id: str) -> dict[str, dict[str, Any]]:
    found = cfg.query_owned(store, user_id, workspace_id, ws.MAKERSTATUS_SK)
    out: dict[str, dict[str, Any]] = {}
    for item in sorted(found, key=lambda i: str(i.get("checkedAt") or "")):  # the newest wins
        if item.get("type") != ws.TYPE_MAKERSTATUS:
            continue
        key = item.get("model") if isinstance(item.get("model"), str) and item.get("model") else None
        out[str(key or str(item.get("sk") or "")[len(ws.MAKERSTATUS_SK) :])] = item
    return out


def model_info(m: Mapping[str, Any], status: Mapping[str, Any] | None) -> dict[str, Any]:
    """``MakerModelInfo`` (§45.37): what Settings › Video shows for one model, with its access check."""
    state = str((status or {}).get("status") or "not_checked")
    if state not in STATUSES:
        state = "error"
    checked = (status or {}).get("checkedAt")
    line = str((status or {}).get("line") or "") if state not in ("not_checked", "ok") else ""
    if m.get("ended"):  # final: never "tap Check models" (it is never called again, G7; Amazon answers not found)
        state, line = "not_found", f"{ended_line(m)}."
    out: dict[str, Any] = {
        "key": str(m.get("key")),
        "label": str(m.get("label") or m.get("key")),
        "provider": str(m.get("provider") or ""),
        "maker": str(m.get("maker") or ""),
        "host": str(m.get("host") or hosts.LABEL[hosts.BEDROCK]),
        "hostId": str(m.get("hostId") or hosts.BEDROCK),
        "modelId": str(m.get("modelId") or ""),
        "region": m.get("region") if isinstance(m.get("region"), str) else None,
        "regionLine": region_words(m.get("region")),
        "kind": str(m.get("kind") or ""),
        "price": dict(m["price"]) if isinstance(m.get("price"), Mapping) else None,
        "note": str(m.get("note") or ""),
        "custom": bool(m.get("custom")),
        "ended": str(m["ended"]) if m.get("ended") else None,
        "endedLine": ended_line(m) if m.get("ended") else None,
        "status": state,
        "statusLine": line or STATUS_LINE[state],
        "checkedAt": str(checked) if isinstance(checked, str) and checked and not m.get("ended") else None,
    }
    if m.get("baseUrl"):
        out["baseUrl"] = str(m["baseUrl"])
    return out


def infos(store: db.Store, user_id: str, workspace_id: str) -> list[dict[str, Any]]:
    statuses = status_items(store, user_id, workspace_id)
    return [model_info(m, statuses.get(str(m["key"]))) for m in all_models(custom(store, user_id, workspace_id))]


# --- Check models' makers (``input.makers`` of a check_models task) ---------------------------------------------


def clean_check(raw: Any, models: Iterable[Mapping[str, Any]]) -> list[str]:
    """The maker models to check: each once, every one known and not ended (an ended model is never called)."""
    listed = list(models)
    if not isinstance(raw, list) or not raw or len(raw) > len(listed):
        raise bad_request("makers must be a list of the picture, video or sound models to check.", "makers")
    keys: list[str] = []
    for key in raw:
        found = find(key, listed)
        if found is None:
            raise bad_request(f"Clip Factory Stories has no picture, video or sound model called '{key}'.", "makers")
        if found.get("ended"):
            raise bad_request(ended_sentence(found), "makers")
        if key not in keys:
            keys.append(str(key))
    return keys


# --- adding and removing (PUT / DELETE …/makers/models/{key}) ----------------------------------------------------


def clean_key(store: db.Store, user_id: str, workspace_id: str, key: Any) -> str:
    from . import ai_resolve as res
    from .model_defs import BAD_KEY, KEY, model_sk

    if not isinstance(key, str) or not KEY.match(key):
        raise bad_request(BAD_KEY, "key")
    if key in bundled_keys() or key in res.bundled_keys():
        raise bad_request(BUNDLED, "key")
    if cfg.get_owned(store, user_id, workspace_id, model_sk(key)) is not None:
        raise bad_request(REASONING_TAKEN, "key")
    return key


def _clean_text(body: Mapping[str, Any], name: str, limit: int, sentence: str, *, required: bool = True) -> str:
    value = body.get(name)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not " ".join(value.split())):
        raise bad_request(sentence, name)
    text = " ".join(value.split())
    if len(text) > limit:
        raise bad_request(f"That is too long (at most {limit} characters).", name)
    return text


def clean_price(value: Any, kind: str) -> dict[str, Any] | None:
    if value is None:
        return None
    body = validate.obj(value, "price")
    validate.only_keys(body, ("perUnit", "unit", "currency"))
    per = body.get("perUnit")
    unit = body.get("unit")
    if isinstance(per, bool) or not isinstance(per, int | float) or not 0 <= float(per) <= cfg.MAX_PRICE:
        raise bad_request(BAD_PRICE, "price")
    if unit not in PRICE_UNITS:
        raise bad_request(BAD_PRICE, "price")
    currency = body.get("currency", "USD")
    if not isinstance(currency, str) or not cfg.CURRENCY.match(currency.strip().upper()):
        raise bad_request("currency must be a three-letter code, for example USD or EUR.", "price")
    return {"perUnit": float(per), "unit": str(unit), "currency": currency.strip().upper()}


def clean(body: Mapping[str, Any], *, kind_was: str | None = None) -> dict[str, Any]:
    """A maker model body, checked: every sentence is one the owner can act on."""
    from .model_defs import clean_model_id, clean_region, region_problem

    validate.only_keys(body, FIELDS)
    kind = body.get("kind")
    if kind not in KINDS:
        raise bad_request(BAD_KIND, "kind")
    if kind_was is not None and kind != kind_was:
        raise bad_request(KIND_FIXED, "kind")
    kind = str(kind)
    host = hosts.clean_host(body.get("host"), allowed=KIND_HOSTS[kind], refused=bad_host(kind))
    out: dict[str, Any] = {
        "kind": kind,
        "label": _clean_text(body, "label", LABEL_MAX, "Give the model a name people can read."),
        "provider": _clean_text(body, "provider", PROVIDER_MAX, "Say who makes the model, like Stability AI."),
        "host": host,
        "note": _clean_text(body, "note", NOTE_MAX, "note must be text.", required=False),
        "price": clean_price(body.get("price"), kind),
    }
    if host == hosts.BEDROCK:
        model_id = clean_model_id(body.get("modelId"))
        region = clean_region(body.get("region"))
        mismatch = region_problem(model_id, region)
        if mismatch is not None:
            raise bad_request(mismatch, "region")
        bare = _bare_model_id(model_id)
        if ENDED_FAMILIES.match(bare) or bare in _ended_ids():
            raise bad_request(ENDED_MODEL, "modelId")
        if kind == "image" and not BEDROCK_PICTURE.match(bare):
            raise bad_request(BAD_PICTURE_MODEL, "modelId")
        if kind == "video" and not BEDROCK_VIDEO.match(bare):
            raise bad_request(BAD_VIDEO_MODEL, "modelId")
        if kind == "audio":
            raise bad_request(NO_BEDROCK_SOUND, "host")
        if not hosts.empty(body.get("baseUrl")):
            raise bad_request(hosts.BASE_URL_ONLY_OPENAI, "baseUrl")
        out.update(modelId=model_id, region=region)
    else:
        out["modelId"] = hosts.clean_keyed_model_id(body.get("modelId"))
        if host == hosts.ELEVENLABS and not ELEVENLABS_SOUND.match(out["modelId"]):
            raise bad_request(ELEVENLABS_ONLY_SOUND, "modelId")
        if not hosts.empty(body.get("region")):
            raise bad_request(hosts.REGION_ONLY_BEDROCK, "region")
        if host == hosts.OPENAI_COMPATIBLE:
            out["baseUrl"] = hosts.clean_base_url(body.get("baseUrl"))
        elif not hosts.empty(body.get("baseUrl")):
            raise bad_request(hosts.BASE_URL_ONLY_OPENAI, "baseUrl")
    return out


def _ended_ids() -> set[str]:
    """The model ids of every bundled model Amazon ended (G7)."""
    return {str(m["modelId"]) for m in bundled() if m.get("ended") and m.get("modelId")}


def _bare_model_id(model_id: str) -> str:
    """The model id inside an ARN or a cross-Region profile id (``us.stability.…`` → ``stability.…``)."""
    tail = model_id.rsplit("/", 1)[-1]
    parts = tail.split(".")
    if len(parts) > 2 and parts[0] in ("us", "eu", "apac", "global", "jp", "au", "ca", "us-gov"):
        tail = ".".join(parts[1:])
    return tail


def get_item(store: db.Store, user_id: str, workspace_id: str, key: str) -> dict[str, Any] | None:
    item = cfg.get_owned(store, user_id, workspace_id, makerdef_sk(key))
    return item if item is not None and item.get("type") == ws.TYPE_MAKERDEF else None


def put(
    store: db.Store, user_id: str, workspace_id: str, key: Any, body: Mapping[str, Any], *, now: datetime
) -> dict[str, Any]:
    """Adds or replaces one maker model; returns its ``MakerModelInfo``. Changing its model id, Region, host or
    address clears its access check (it reads "Not checked yet")."""
    key = clean_key(store, user_id, workspace_id, key)
    existing = get_item(store, user_id, workspace_id, key)
    fields = clean(body, kind_was=str(existing["kind"]) if existing else None)
    if fields["host"] == hosts.OPENAI_COMPATIBLE:
        from .provider_keys import check_openai_origin

        check_openai_origin(store, user_id, workspace_id, key, str(fields["baseUrl"]))  # its key goes there only
    kind = fields["kind"]
    if (
        existing is None
        and sum(1 for i in items(store, user_id, workspace_id) if i.get("kind") == kind) >= MAX_PER_KIND
    ):
        raise conflict(f"You can add at most {MAX_PER_KIND} {KIND_WORD[kind]} models. Remove one first.")
    at = iso(now)
    item = {
        **cfg.base_item(user_id, workspace_id, makerdef_sk(key), ws.TYPE_MAKERDEF),
        "key": key,
        **{k: v for k, v in fields.items() if v not in (None, "") or k == "price"},
        "createdAt": str((existing or {}).get("createdAt") or at),
        "updatedAt": at,
    }
    if existing is None:
        try:
            store.put(item, if_absent=True)
        except db.ConditionFailed as e:
            raise conflict("That model was added a moment ago somewhere else. Load the page again.") from e
    else:
        store.put_when(
            item,
            "#u = :u AND #w = :w",
            names={"#u": "userId", "#w": "workspaceId"},
            values={":u": user_id, ":w": workspace_id},
        )
        if any(str(existing.get(n) or "") != str(item.get(n) or "") for n in ("modelId", "region", "host", "baseUrl")):
            owner = {"userId": [user_id], "workspaceId": [workspace_id]}
            store.delete_if(cfg.pk(user_id, workspace_id), makerstatus_sk(key), owner)
    log("info", "ws.maker_model_added" if existing is None else "ws.maker_model_changed", key=key, kind=kind)
    found = as_model(item)
    if found is None:  # unreachable: ``clean`` checked every field ``as_model`` reads
        raise bad_request(NOT_FOUND, "key")
    status = status_items(store, user_id, workspace_id).get(key)
    return model_info(found, status)


def delete(store: db.Store, user_id: str, workspace_id: str, workspace: Mapping[str, Any], key: Any) -> None:
    """Removes an added maker model; ``409`` while Settings › Video picks it. Its access check goes too."""
    from .model_defs import KEY
    from .shapes import stories_config

    if isinstance(key, str) and key in bundled_keys():
        raise conflict(BUNDLED)
    if not isinstance(key, str) or not KEY.match(key):
        raise not_found(NOT_FOUND)
    item = get_item(store, user_id, workspace_id, key)
    if item is None:
        raise not_found(NOT_FOUND)
    providers = stories_config(workspace).get("providers") or {}
    kind = str(item.get("kind") or "")
    used = effective_model(providers, kind, all_models(custom(store, user_id, workspace_id))) if kind in KINDS else None
    picked = kind in KINDS and (providers.get(PICK_FIELD[kind]) == key or (used or {}).get("key") == key)
    if picked:
        label = str(item.get("label") or key)
        raise conflict(
            f"{label} is picked as the {KIND_WORD[kind]} model in Settings › Video. Pick another model there first, "
            "then remove it."
        )
    owner = {"userId": [user_id], "workspaceId": [workspace_id]}
    if not store.delete_if(cfg.pk(user_id, workspace_id), makerdef_sk(key), owner):
        raise not_found(NOT_FOUND)
    store.delete_if(cfg.pk(user_id, workspace_id), makerstatus_sk(key), owner)
    log("info", "ws.maker_model_removed", key=key)
