"""Design with AI's request (docs/CONTRACTS.md §45.34, §45.41): words and up to 6 photos, a kind, and up to 4 options.

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

MAX_PHOTOS = 6
MAX_COUNT = 4
MAX_AVOID = 8
DESCRIPTION_MAX = 600
NO_CHARACTER = "We could not find that character."  # the same sentence as routes/core.py
TOO_MANY = "Pick up to 6 photos."
BAD_COUNT = "count must be 1 to 4."
NOT_IDS = "referenceAssetIds must be a list of picture ids."
NEEDS_PERSON = "Describe the character, or add a picture of it."
NEEDS_CAR = "Add a photo of your car, or say what it is like."
AVOID_CARS = "avoid is for a car's design only."
KEYS = ("description", "referenceAssetId", "referenceAssetIds", "kind", "count", "avoid", "characterId", "override")


@dataclass(frozen=True)
class DesignAsk:
    description: str | None
    asset_ids: list[str]  # ≤ 6, unique, the old referenceAssetId first
    character_id: str | None  # a ULID; else not_found(NO_CHARACTER)
    kind: str | None  # None: the saved character's kind, else "person"
    count: int | None  # None: 3 for a car, 1 for a person
    avoid: list[dict[str, Any]]  # each through characters.car_look; cars only
    override: dict[str, Any] | None


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
    asset_ids = list(dict.fromkeys(raw))
    if len(asset_ids) > MAX_PHOTOS:
        raise bad_request(TOO_MANY, "referenceAssetIds")
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
    )


def task_input(ask: DesignAsk, assets: list[Item], current: Item | None) -> Item:
    """The ``character_design`` task's input (§45.41): ``{kind, count, description?, references, referenceAssetId?,
    referenceKey?, referenceContentType?, characterId?, avoid?}``. ``assets`` are the checked photos in the owner's
    order; ``current`` is the saved character a redesign starts from (its kind is kept)."""
    saved = str(current.get("kind") or "person") if current is not None else None
    if saved is not None and ask.kind is not None and ask.kind != saved:
        raise bad_request(f"Keep the same kind: this character is a {saved}.", "kind")
    kind = ask.kind or saved or "person"
    if ask.avoid and kind != "car":
        raise bad_request(AVOID_CARS, "avoid")
    if not ask.description and not assets:
        raise bad_request(NEEDS_CAR if kind == "car" else NEEDS_PERSON)
    references = [{"assetId": a["assetId"], "key": a["key"], "contentType": a.get("contentType")} for a in assets]
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
    return out
