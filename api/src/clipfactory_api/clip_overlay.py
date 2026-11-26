"""The logo and text drawn on a clip in Review (docs/CONTRACTS.md §53 C1, C5).

The clip item carries ``cr`` (``{active, campaignId?}``) and ``overlay`` (``{rev, status, error?, logos?, logo?,
text?, timing?}``; §54: ``logos`` is the list of picture layers, ``logo`` the old single picture). The edit is made by the agent on the original file; the API only checks the request, writes the clip's
``overlay`` as ``working`` and asks the agent (``AgentClient.overlay``). Internal fields (never public):
``origVideoKey`` and ``editKey`` on the clip, and inside ``overlay`` the ``startedAt`` moment (the 5-minute timeout)
and each picture's bucket ``key`` (so the agent needs no second read). Every write that changes the edit is conditional
on the ``overlay`` that was read, so a render that finishes meanwhile is never mixed with a reset or a new edit.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db, s3
from .clock import parse
from .errors import bad_request
from .mojibake import repair

Item = dict[str, Any]

WORKING_FOR = timedelta(minutes=5)  # a render that has not answered after this long counts as failed
TEXT_MAX = 80
LOGO_SIZE = (0.08, 0.5)  # of the clip's width
TEXT_SIZES = ("s", "m", "l")
MAX_LAYERS = 4  # §54 L1: pictures on one clip
MIN_SHOWN = 0.1  # seconds: the shortest "Only part of the clip"

STILL_MAKING = "The edit is still being made."
TOO_LONG = "The edit took too long. Tap Make it to try again."
COULD_NOT_START = "Clip Factory couldn't start the edit. Tap Make it to try again."
NEED_ONE = "Add a logo or some words first."
TURN_ON = "Turn on CR active first."
BAD_TEXT = "Type a few words, up to 80 letters."
BAD_TIME = "Pick a start and an end inside the clip."
BAD_PLACE = "Move it back onto the picture."
BAD_SIZE = "Pick a size."
TOO_MANY = "Up to 4 pictures."
BAD_LAYER_ID = "Each picture needs its own short id."
ONE_KIND = "Send the pictures as one list."

INTERNAL_OVERLAY_FIELDS = ("startedAt",)
_SPACES = re.compile(r"\s+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_LAYER_ID = re.compile(r"^[A-Za-z0-9_-]{1,24}$")


def overlay_of(item: Mapping[str, Any]) -> Mapping[str, Any]:
    found = item.get("overlay")
    return found if isinstance(found, Mapping) else {}


def timed_out(overlay: Mapping[str, Any], now: datetime) -> bool:
    """A ``working`` edit whose ask is older than 5 minutes (or has no start time at all)."""
    if overlay.get("status") != "working":
        return False
    started = parse(overlay.get("startedAt"))
    return started is None or now - started > WORKING_FOR


def is_working(item: Mapping[str, Any], now: datetime) -> bool:
    """The edit is still being made: Confirm, Upload and auto-posting wait for it (``STILL_MAKING``)."""
    overlay = overlay_of(item)
    return overlay.get("status") == "working" and not timed_out(overlay, now)


def public_overlay(overlay: Mapping[str, Any], now: datetime | None) -> Item:
    """The ``Clip.overlay`` shape: no internal field, no bucket key. With ``now``, a timed-out ``working`` reads as
    ``failed`` with one sentence (``GET`` reports it; nothing is written)."""
    out: Item = {k: v for k, v in overlay.items() if k not in INTERNAL_OVERLAY_FIELDS}
    logo = out.get("logo")
    if isinstance(logo, Mapping):
        out["logo"] = {k: v for k, v in logo.items() if k != "key"}
    layers = out.get("logos")
    if isinstance(layers, list):
        out["logos"] = [{k: v for k, v in x.items() if k != "key"} if isinstance(x, Mapping) else x for x in layers]
    if now is not None and timed_out(overlay, now):
        out["status"] = "failed"
        out["error"] = TOO_LONG
    return out


# --- the request -----------------------------------------------------------------------------------------------------


def _number(value: Any, lo: float, hi: float, sentence: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise bad_request(sentence)
    if not lo <= value <= hi:
        raise bad_request(sentence)
    return round(float(value), 4)


def _place(raw: Mapping[str, Any]) -> dict[str, float]:
    return {"x": _number(raw.get("x"), 0, 1, BAD_PLACE), "y": _number(raw.get("y"), 0, 1, BAD_PLACE)}


def logo_part(raw: Any) -> dict[str, Any]:
    """``{logoId, x, y, size}`` checked (the library lookup is the route's)."""
    if not isinstance(raw, dict):
        raise bad_request("logo must be an object.")
    unknown = sorted(set(raw) - {"logoId", "x", "y", "size"})
    if unknown:
        raise bad_request(f"Unknown field: {unknown[0]}.")
    logo_id = raw.get("logoId")
    if not isinstance(logo_id, str) or not logo_id:
        raise bad_request("Pick a logo.")
    return {"logoId": logo_id, **_place(raw), "size": _number(raw.get("size"), *LOGO_SIZE, BAD_SIZE)}


def layers_part(raw: Any, duration: Any = None) -> list[dict[str, Any]]:
    """``[{layerId, logoId, x, y, size, timing?}]`` (§54 L3, L4): at most 4, ``layerId`` unique and short, each picture
    placed and sized as §53, ``timing`` inside the clip when its length (``duration``) is known. The library lookup
    and the bucket ``key`` are the route's."""
    if not isinstance(raw, list):
        raise bad_request("logos must be a list.")
    if len(raw) > MAX_LAYERS:
        raise bad_request(TOO_MANY)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise bad_request("Each picture must be an object.")
        unknown = sorted(set(entry) - {"layerId", "logoId", "x", "y", "size", "timing"})
        if unknown:
            raise bad_request(f"Unknown field: {unknown[0]}.")
        layer_id = entry.get("layerId")
        if not isinstance(layer_id, str) or not _LAYER_ID.match(layer_id) or layer_id in seen:
            raise bad_request(BAD_LAYER_ID)
        seen.add(layer_id)
        layer: dict[str, Any] = {
            "layerId": layer_id,
            **logo_part({k: v for k, v in entry.items() if k not in {"layerId", "timing"}}),
        }
        if entry.get("timing") is not None:
            layer["timing"] = timing_part(entry["timing"], duration)
        out.append(layer)
    return out


def text_part(raw: Any) -> dict[str, Any]:
    """``{text, x, y, size}``: one short line (80 characters at most), white with a dark edge, size s, m or l."""
    if not isinstance(raw, dict):
        raise bad_request("text must be an object.")
    unknown = sorted(set(raw) - {"text", "x", "y", "size"})
    if unknown:
        raise bad_request(f"Unknown field: {unknown[0]}.")
    text = raw.get("text")
    if not isinstance(text, str):
        raise bad_request(BAD_TEXT)
    line = _SPACES.sub(" ", _CONTROL.sub(" ", repair(text))).strip()
    if not line or len(line) > TEXT_MAX:
        raise bad_request(BAD_TEXT)
    size = raw.get("size")
    if size not in TEXT_SIZES:
        raise bad_request(BAD_SIZE)
    return {"text": line, **_place(raw), "size": size}


def timing_part(raw: Any, duration: Any) -> dict[str, float]:
    """``{startSec, endSec}`` inside the clip (when its length is known)."""
    if not isinstance(raw, dict):
        raise bad_request("timing must be an object.")
    unknown = sorted(set(raw) - {"startSec", "endSec"})
    if unknown:
        raise bad_request(f"Unknown field: {unknown[0]}.")
    length = float(duration) if isinstance(duration, int | float) and not isinstance(duration, bool) else 86_400.0
    start = _number(raw.get("startSec"), 0, length, BAD_TIME)
    end = _number(raw.get("endSec"), 0, length + 0.05, BAD_TIME)
    if end - start < MIN_SHOWN:
        raise bad_request(BAD_TIME)
    return {"startSec": start, "endSec": end}


# --- what is written -------------------------------------------------------------------------------------------------


def next_rev(item: Mapping[str, Any]) -> int:
    """The next ``overlay.rev``. It only ever grows: the counter ``overlayRev`` (internal, kept when Reset removes
    ``overlay``) is read too, so a render still running from before a Reset can never match a newer edit's ``rev``."""
    seen = [int(v) for v in (item.get("overlayRev"), overlay_of(item).get("rev")) if isinstance(v, int | float)]
    return max(seen, default=0) + 1


def working(
    item: Mapping[str, Any],
    now_iso: str,
    *,
    logos: list[Item] | None = None,
    text: Item | None,
    timing: Item | None,
) -> Item:
    """The new ``overlay``: the next ``rev``, ``working``, no old error. New edits write ``logos`` only (§54 L3);
    ``timing`` is the text's time."""
    out: Item = {"rev": next_rev(item), "status": "working", "startedAt": now_iso}
    for name, part in (("logos", logos or None), ("text", text), ("timing", timing)):
        if part is not None:
            out[name] = part
    return out


def one_layer(logo: Item, timing: Item | None) -> Item:
    """§53's single ``logo`` as one §54 layer: it keeps the request's one ``timing`` (which §53 shared with the text)."""
    return {"layerId": "l1", **logo, **({"timing": timing} if timing is not None else {})}


def same_overlay(item: Mapping[str, Any]) -> tuple[list[str], db.Condition | None]:
    """The condition that the clip's ``overlay`` is still the one read: ``(expect_absent, also)`` for ``Store.update``."""
    if "overlay" in item:
        return [], db.Condition("#ov = :ov", {"#ov": "overlay"}, {":ov": item["overlay"]})
    return ["overlay"], None


def reset_writes(item: Mapping[str, Any]) -> tuple[dict[str, Any], list[str], str | None]:
    """What putting the original back writes: ``(fields to set, fields to remove, the edited file to delete)``.
    ``videoKey`` goes back to ``origVideoKey``; ``overlay``, ``editKey`` and ``origVideoKey`` are removed."""
    set_fields: dict[str, Any] = {}
    remove = [name for name in ("overlay", "editKey", "origVideoKey") if name in item]
    original = item.get("origVideoKey")
    if isinstance(original, str) and original:
        set_fields["videoKey"] = original
    now_video = set_fields.get("videoKey") or item.get("videoKey")
    edited = item.get("editKey")
    gone = edited if isinstance(edited, str) and edited and edited != now_video and _own_file(item, edited) else None
    return set_fields, remove, gone


def _own_file(item: Mapping[str, Any], key: str) -> bool:
    return s3.is_safe_key(key) and key.startswith(f"jobs/{item.get('jobId')}/")
