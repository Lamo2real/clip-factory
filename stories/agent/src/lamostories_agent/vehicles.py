"""Vehicles (docs/CONTRACTS.md §45.47): a vehicle is still a ``kind: "car"`` character; its family comes from its
``car.body`` and is never stored. The same table as the engine's ``VEHICLE_OF`` (web/src/stories/engine/types.ts) and
the API's ``catalog.VEHICLE_OF``. Kept free of other imports, so the writer can read it without loading the tasks."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Final

VEHICLE_TYPES: Final = ("car", "truck", "bus", "motorbike", "plane", "boat")
VEHICLE_OF: Final[dict[str, str]] = {
    "hatchback": "car",
    "sedan": "car",
    "estate": "car",
    "suv": "car",
    "sports": "car",
    "compact": "car",
    "pickup": "truck",
    "van": "truck",
    "bus": "bus",
    "motorbike": "motorbike",
    "plane": "plane",
    "boat": "boat",
}
# The families a design with no ``vehicle`` may pick from: the bodies there were before vehicles (§45.42).
FAMILIES_BEFORE: Final = ("car", "truck")
# Riders per body. The engine draws two seats in every body (engine/car.ts CAR_SEATS: the first rider drives); raise
# one here only when the engine draws more.
SEATS: Final[dict[str, int]] = {body: 2 for body in VEHICLE_OF}
DEFAULT_SEATS: Final = 2
PHOTO_SIDES: Final = ("outside", "inside")


def vehicle_of(car: Any) -> str:
    """The family of a car look (``car`` when the body is unknown)."""
    body = car.get("body") if isinstance(car, Mapping) else None
    return VEHICLE_OF.get(str(body), "car")


def seats_of(car: Any) -> int:
    body = car.get("body") if isinstance(car, Mapping) else None
    return SEATS.get(str(body), DEFAULT_SEATS)


def bodies_for(all_bodies: Iterable[str], families: Iterable[str]) -> list[str]:
    """The bodies of ``all_bodies`` (the engine's order) in these families; every body when none is (an engine that
    does not have that family yet)."""
    allowed = set(families)
    bodies = list(all_bodies)
    picked = [b for b in bodies if VEHICLE_OF.get(b, "car") in allowed]
    return picked or bodies
