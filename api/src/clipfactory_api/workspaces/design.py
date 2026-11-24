"""Design with AI's request (docs/CONTRACTS.md §45.34, §45.42, §45.47): words and up to 8 photos (6 outside, 4 inside
a vehicle), a kind, a vehicle family, and up to 4 options.

No I/O here. ``parse`` checks the body (unknown keys are 400, as on every route); the route reads each photo with
``_design_picture`` (a ``design_ref`` or ``character_ref`` asset of this workspace whose file has arrived) and the
saved character a redesign starts from; ``task_input`` then writes the ``character_design`` task's input. The three
``reference*`` keys repeat the first photo, for an older agent.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .. import validate
from ..errors import bad_request, not_found
from ..ids import is_ulid
from . import catalog, characters, overrides

Item = dict[str, Any]

MAX_PHOTOS = 8  # §45.47 (was 6): at most 6 outside and 4 inside
MAX_OUTSIDE = 6
MAX_INSIDE = 4
MAX_COUNT = 4
MAX_AVOID = 8
DESCRIPTION_MAX = 600
NO_CHARACTER = "We could not find that character."  # the same sentence as routes/core.py
TOO_MANY = "Pick up to 8 photos."
TOO_MANY_OUTSIDE = "Pick up to 6 photos."  # the outside photos (all of them when no sides are sent), as before
TOO_MANY_INSIDE = "Pick up to 4 inside photos."
NOT_SIDES = "referenceSides must be outside or inside, one for each photo."
NO_VEHICLE = "Pick a car, truck, bus, motorbike, plane or boat."
INSIDE_CARS = "Inside photos are for a vehicle only."
VEHICLE_CARS = "vehicle is for a vehicle's design only."
BAD_COUNT = "count must be 1 to 4."
NOT_IDS = "referenceAssetIds must be a list of picture ids."
NEEDS_PERSON = "Describe the character, or add a picture of it."
NEEDS_CAR = "Add a photo of your car, or say what it is like."
AVOID_CARS = "avoid is for a car's design only."
KEYS = (
    "description",
    "referenceAssetId",
    "referenceAssetIds",
    "referenceSides",
    "vehicle",
    "kind",
    "count",
    "avoid",
    "characterId",
    "override",
)


@dataclass(frozen=True)
class DesignAsk:
    description: str | None
    asset_ids: list[str]  # ≤ 8, unique, the old referenceAssetId first
    character_id: str | None  # a ULID; else not_found(NO_CHARACTER)
    kind: str | None  # None: the saved character's kind, else "person"
    count: int | None  # None: 3 for a car, 1 for a person
    avoid: list[dict[str, Any]]  # each through characters.car_look; cars only
    override: dict[str, Any] | None
    sides: list[str] | None = None  # §45.47: one per asset id (outside or inside); None when the web sent none
    vehicle: str | None = None  # §45.47: the family the owner picked; None: the saved vehicle's, else a car


def _sides(body: Mapping[str, Any], raw: list[Any]) -> list[Any] | None:
    """``referenceSides`` lined up with ``raw`` (the old single picture is an outside photo), or None when not sent."""
    sides = body.get("referenceSides")
    if sides is None:
        return None
    many = body.get("referenceAssetIds") or []
    if not isinstance(sides, list) or len(sides) != len(many) or any(s not in catalog.PHOTO_SIDES for s in sides):
        raise bad_request(NOT_SIDES, "referenceSides")
    return ["outside"] * (len(raw) - len(sides)) + list(sides)


def parse(body: Mapping[str, Any]) -> DesignAsk:
    """The checked body of ``POST …/characters/design``."""
    validate.only_keys(body, KEYS)
    description = validate.string(body, "description", required=False, max_len=DESCRIPTION_MAX)
    raw: list[Any] = []
    if body.get("referenceAssetId") is not None:
        raw.append(body["referenceAssetId"])
    many = body.get("referenceAssetIds")
    if many is not None:
        if not isinstance(many, list):
            raise bad_request(NOT_IDS, "referenceAssetIds")
        raw.extend(many)
    if not all(isinstance(a, str) for a in raw):
        raise bad_request(NOT_IDS, "referenceAssetIds")
    lined = _sides(body, raw)
    side_of: dict[str, str] = {}
    for n, a in enumerate(raw):
        side_of.setdefault(a, lined[n] if lined is not None else "outside")  # a repeat keeps its first side
    asset_ids = list(side_of)
    if len(asset_ids) > MAX_PHOTOS:
        raise bad_request(TOO_MANY, "referenceAssetIds")
    if list(side_of.values()).count("outside") > MAX_OUTSIDE:
        raise bad_request(TOO_MANY_OUTSIDE, "referenceAssetIds")
    if list(side_of.values()).count("inside") > MAX_INSIDE:
        raise bad_request(TOO_MANY_INSIDE, "referenceSides")
    vehicle = body.get("vehicle")
    if vehicle is not None and vehicle not in catalog.VEHICLE_TYPES:
        raise bad_request(NO_VEHICLE, "vehicle")
    kind = body.get("kind")
    if kind is not None and kind not in catalog.CHARACTER_KINDS:
        raise bad_request(characters.NO_KIND, "kind")
    count = body.get("count")
    if count is not None and (isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_COUNT):
        raise bad_request(BAD_COUNT, "count")
    character_id = body.get("characterId")
    if character_id is not None and (not isinstance(character_id, str) or not is_ulid(character_id)):
        raise not_found(NO_CHARACTER)
    avoid_raw = body.get("avoid")
    avoid: list[dict[str, Any]] = []
    if avoid_raw is not None:
        if not isinstance(avoid_raw, list) or len(avoid_raw) > MAX_AVOID:
            raise bad_request(f"avoid must be a list of at most {MAX_AVOID} car looks.", "avoid")
        avoid = [characters.car_look(a) for a in avoid_raw]
    return DesignAsk(
        description=description,
        asset_ids=asset_ids,
        character_id=character_id,
        kind=str(kind) if kind is not None else None,
        count=count,
        avoid=avoid,
        override=overrides.model_override(body.get("override")),
        sides=[side_of[a] for a in asset_ids] if lined is not None else None,
        vehicle=str(vehicle) if vehicle is not None else None,
    )


def task_input(ask: DesignAsk, assets: list[Item], current: Item | None) -> Item:
    """The ``character_design`` task's input (§45.42, §45.47): ``{kind, count, description?, references,
    referenceAssetId?, referenceKey?, referenceContentType?, characterId?, avoid?, vehicle?}``. ``assets`` are the
    checked photos in the owner's order; ``current`` is the saved character a redesign starts from (its kind is
    kept). With ``referenceSides`` each reference carries its ``side``; ``vehicle`` (the family, which limits the
    bodies) is left out when it is a car, as before."""
    saved = str(current.get("kind") or "person") if current is not None else None
    if saved is not None and ask.kind is not None and ask.kind != saved:
        raise bad_request(f"Keep the same kind: this character is a {saved}.", "kind")
    kind = ask.kind or saved or "person"
    if ask.avoid and kind != "car":
        raise bad_request(AVOID_CARS, "avoid")
    if kind != "car" and "inside" in (ask.sides or []):
        raise bad_request(INSIDE_CARS, "referenceSides")
    if kind != "car" and ask.vehicle is not None:
        raise bad_request(VEHICLE_CARS, "vehicle")
    if not ask.description and not assets:
        raise bad_request(NEEDS_CAR if kind == "car" else NEEDS_PERSON)
    references = [{"assetId": a["assetId"], "key": a["key"], "contentType": a.get("contentType")} for a in assets]
    if ask.sides is not None:
        for ref, side in zip(references, ask.sides, strict=True):
            ref["side"] = side
    out: Item = {"kind": kind, "count": ask.count if ask.count is not None else (3 if kind == "car" else 1)}
    if ask.description:
        out["description"] = ask.description
    out["references"] = references
    if references:
        first = references[0]
        out.update(
            {
                "referenceAssetId": first["assetId"],
                "referenceKey": first["key"],
                "referenceContentType": first["contentType"],
            }
        )
    if current is not None:
        out["characterId"] = current["characterId"]
    if ask.avoid:
        out["avoid"] = ask.avoid
    saved_vehicle = characters.vehicle_of(current.get("car")) if current is not None and saved == "car" else None
    vehicle = ask.vehicle or saved_vehicle
    if kind == "car" and vehicle and vehicle != "car":
        out["vehicle"] = vehicle
    return out
