"""Auto-posting: the oldest clips in Review go up by themselves, every X hours (docs/CONTRACTS.md §46, ADR-81).

* ``schedule``: the slots (whole UTC hours) and when the next run is (even gaps, across midnight, §46.4).
* ``pick``: which clips go next and which wait for the owner, with the reason he sees (§46.5).
* ``run``: one run (``run_once``), shared by the hourly tick and the API's test runs (§46.7, §46.8).
* ``handler``: Lambda ``cf-prod-autopost`` (the hourly EventBridge rule, §46.11).

This module holds the owner's setting (``Settings.autoPost``, §46.3: defaults, validation, merge) and the item keys
(§46.10). Every item is additive: new sort keys and attributes only.

Items:

* ``USER#{userId}`` / ``AUTOPOST``: ``lastRunAt`` (the last scheduled slot that ran), ``lastRunId``, ``lastNowAt``
  (the last test run, at most one a minute).
* ``USER#{userId}`` / ``AUTORUN#{runId}``: one run, its clips and their outcomes (``ttl`` 180 days).
* ``AUTOPOSTOWNERS`` / ``USER#{userId}``: the tick's owner list, found with one Query (never a Scan).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .. import db, validate
from ..errors import bad_request

KEYS = ("on", "everyHours", "perRun", "practice")
DEFAULTS: dict[str, Any] = {"on": False, "everyHours": 5, "perRun": 1, "practice": False}
EVERY_HOURS = (1, 24)
PER_RUN = (1, 5)
UNKNOWN = "autoPost has a setting Clip Factory does not know."
PICK_HOURS = "Pick 1 to 24 hours."
PICK_CLIPS = "Pick 1 to 5 clips."

OWNERS_PK = "AUTOPOSTOWNERS"
STATE_SK = "AUTOPOST"
RUN_PREFIX = "AUTORUN#"


def defaults() -> dict[str, Any]:
    return dict(DEFAULTS)


def _number(value: Any, lo: int, hi: int, message: str) -> int:
    number = validate.whole_number(value)
    if number is None or not lo <= number <= hi:
        raise bad_request(message)
    return number


def _check(field: str, value: Any) -> Any:
    if field == "everyHours":
        return _number(value, *EVERY_HOURS, PICK_HOURS)
    if field == "perRun":
        return _number(value, *PER_RUN, PICK_CLIPS)
    return validate.boolean(value, field)


def stored(raw: Any) -> dict[str, Any]:
    """The stored ``autoPost`` (``onAt`` included), validated; raises on anything that no longer validates, so the
    owner then reads the defaults (``settings.with_defaults``, as ``postPreset``)."""
    body = validate.obj(raw, "autoPost")
    validate.only_keys(body, (*KEYS, "onAt"))
    out = defaults()
    for field in KEYS:
        if field in body:
            out[field] = _check(field, body[field])
    on_at = body.get("onAt")
    if on_at is not None:
        if not isinstance(on_at, str) or not on_at:
            raise bad_request(UNKNOWN)
        out["onAt"] = on_at
    return out


def merge(current: Mapping[str, Any] | None, raw: Any, now: str) -> dict[str, Any]:
    """A ``PUT /v1/settings`` ``autoPost``: each of ``on``, ``everyHours``, ``perRun``, ``practice`` given is merged
    over the stored value. ``onAt`` is the server's: it is written when ``on`` goes from off to on and kept otherwise,
    and a body that sends it (or any unknown key) is refused."""
    body = validate.obj(raw, "autoPost")
    if set(body) - set(KEYS):
        raise bad_request(UNKNOWN)
    base = dict(current) if isinstance(current, Mapping) else {}
    out = {**defaults(), **{k: base[k] for k in (*KEYS, "onAt") if k in base}}
    for field, value in body.items():
        out[field] = _check(field, value)
    if out["on"] and not base.get("on"):
        out["onAt"] = now
    return out


def owner_sk(user_id: str) -> str:
    return f"USER#{user_id}"


def run_sk(run_id: str) -> str:
    return f"{RUN_PREFIX}{run_id}"


def register_owner(store: db.Store, user_id: str, now: str) -> None:
    """Puts the owner on the hourly tick's list (one Query of ``AUTOPOSTOWNERS`` finds them; never a Scan). Every
    ``PUT /v1/settings`` that carries ``autoPost`` calls this; the first one's ``since`` stays."""
    try:
        store.put(
            {"pk": OWNERS_PK, "sk": owner_sk(user_id), "type": "autopostowner", "userId": user_id, "since": now},
            if_absent=True,
        )
    except db.ConditionFailed:
        return


def owners(store: db.Store) -> list[str]:
    return [str(i["userId"]) for i in store.query_all(OWNERS_PK, "USER#") if isinstance(i.get("userId"), str)]
