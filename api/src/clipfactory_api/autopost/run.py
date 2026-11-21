"""One auto-posting run (docs/CONTRACTS.md §46.7), shared by the hourly tick and the API's test runs (§46.8).

``run_once(deps, user_id, kind, slot)``; ``kind`` is ``scheduled``, ``practice_now`` or ``private_now``. Its ``mode``
is ``live``, ``practice`` (a scheduled run while Practice is on, or ``practice_now``) or ``private``
(``private_now``). ``runId = "{slot}#{kind}"`` (the slot to the second for a test run).

1. **Scheduled only:** off → ``off``. A run item of this slot already there → it is **resumed** (``done`` → ``done``;
   ``planned`` → step 4 with its own clips, never a new pick). Otherwise ``slot < nextRunAt`` → ``not_due``.
2. **Plan:** the first ``perRun`` taken clips (a Private test run: 1, never a campaign clip), each with its places.
3. **Claim:** one transaction puts ``AUTORUN#{runId}`` (``planned``, its clips) and moves ``AUTOPOST.lastRunAt`` to the
   slot (only forward). Cancelled because the run exists → resume it; cancelled on ``AUTOPOST`` alone → ``not_due``.
   A test run first moves ``AUTOPOST.lastNowAt`` (at most one a minute, else 409) and puts its run alone; it never
   moves the schedule.
4. **Send** each planned clip through Upload's own code (``uploads.upload_review_clip``): the same conditional
   transaction (``status = review``, posts created once) and idempotent flow start, so a clip is confirmed and its flow
   started only once, whichever run, retry or Upload gets there first. Practice sends nothing (``would_send``).
5. **Done:** the run item gets ``state: done`` and each clip's outcome. A new clip only starts with ``clip_seconds``
   left; the rest wait for the next run ("Out of time. It goes next run.").

The clip flow then posts each place one after another (§17.6), so one place failing never stops the others; Upload's
retries stay (up to 3 tries when a platform does not answer, none where a retry could post twice).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .. import clips, db, post_preset, release, settings, uploads
from ..app import App
from ..clock import iso
from ..errors import ApiError, conflict
from ..log import log
from . import STATE_SK, run_sk, schedule
from .pick import NOTHING_SET_UP, pick

Item = dict[str, Any]

KINDS = ("scheduled", "practice_now", "private_now")
RUN_TTL = timedelta(days=180)
NOW_EVERY = timedelta(seconds=60)
DEFAULT_TIME_BUDGET = 240.0
CLIP_SECONDS = 30.0
NOTHING_IN_REVIEW = "Nothing in Review, so nothing posted."
ALL_WAITING = "Every clip in Review is waiting for you."
NOTHING_TO_TEST = "Nothing in Review to test with."
OUT_OF_TIME = "Out of time. It goes next run."
THROWN_AWAY = "You threw it away first."
UPLOADED_BY_HAND = "You uploaded it yourself."
JUST_STARTED = "A test run just started. Wait a minute."


@dataclass
class RunDeps:
    """What a run needs: the ``App`` Upload's code takes (store, clip flow client, clock, Content Rewards deps) and
    its time. ``deadline`` (on ``monotonic``) is when the caller must be done; None → ``time_budget_seconds`` from the
    run's start. A new clip only starts while ``clip_seconds`` are left."""

    app: App
    time_budget_seconds: float = DEFAULT_TIME_BUDGET
    clip_seconds: float = CLIP_SECONDS
    monotonic: Callable[[], float] = field(default=time.monotonic)
    deadline: float | None = None


@dataclass(frozen=True)
class Outcome:
    """``off``, ``not_due``, ``done`` (the run of this slot had already finished) or ``ran``; ``run`` is its item."""

    result: str
    run: Item | None = None


def run_id_of(slot: datetime, kind: str) -> str:
    return f"{iso(slot)}#{kind}"


def run_once(deps: RunDeps, user_id: str, kind: str, slot: datetime) -> Outcome:
    if kind not in KINDS:
        raise ValueError(f"unknown run kind: {kind}")
    app = deps.app
    store = app.store
    pk = db.user_pk(user_id)
    deadline = deps.deadline if deps.deadline is not None else deps.monotonic() + deps.time_budget_seconds
    current = settings.load(store, user_id)
    auto = current["autoPost"]
    if kind == "scheduled":
        slot = schedule.floor_hour(slot)
        if not auto.get("on"):
            return Outcome("off")
        run_id = run_id_of(slot, kind)
        existing = store.get(pk, run_sk(run_id))
        if existing is not None:  # a retried delivery, or a run that overlaps this one: never a second pick
            return _resume(deps, user_id, existing, current, deadline)
        if not schedule.is_due(auto, store.get(pk, STATE_SK), slot):
            return Outcome("not_due")
        mode = "practice" if auto.get("practice") else "live"
    else:
        slot = slot.replace(microsecond=0)
        run_id = run_id_of(slot, kind)
        mode = "practice" if kind == "practice_now" else "private"
        _claim_now(store, user_id, slot)
    planned, note = _plan(app, user_id, kind, mode, auto)
    item: Item = {
        "pk": pk,
        "sk": run_sk(run_id),
        "type": "autorun",
        "userId": user_id,
        "runId": run_id,
        "at": iso(slot),
        "kind": kind,
        "mode": mode,
        "state": "planned",
        "clips": planned,
        "ttl": int((app.clock() + RUN_TTL).timestamp()),
        **({"note": note} if note else {}),
    }
    if kind == "scheduled":
        try:
            store.transact(puts=[item], updates=[_last_run(pk, iso(slot), run_id)])
        except db.ConditionFailed:
            existing = store.get(pk, run_sk(run_id))
            if existing is None:
                return Outcome("not_due")  # another run of a later slot moved the schedule first
            return _resume(deps, user_id, existing, current, deadline)
    else:
        store.put(item, if_absent=True)
    log("info", "autopost.planned", runId=run_id, mode=mode, clips=len(planned), note=note or "")
    return Outcome("ran", _send(deps, user_id, item, current, deadline))


def _resume(deps: RunDeps, user_id: str, run: Item, current: Mapping[str, Any], deadline: float) -> Outcome:
    if run.get("state") == "done":
        return Outcome("done", run)
    log("info", "autopost.resumed", runId=run.get("runId"))
    return Outcome("ran", _send(deps, user_id, run, current, deadline))


def _last_run(pk: str, slot: str, run_id: str) -> Item:
    """The claim's ``AUTOPOST`` update: ``lastRunAt`` only ever moves forward (the item may not exist yet)."""
    return {
        "Key": {"pk": pk, "sk": STATE_SK},
        "UpdateExpression": "SET #l = :slot, #r = :run, #t = :type",
        "ConditionExpression": "attribute_not_exists(#l) OR #l < :slot",
        "ExpressionAttributeNames": {"#l": "lastRunAt", "#r": "lastRunId", "#t": "type"},
        "ExpressionAttributeValues": {":slot": slot, ":run": run_id, ":type": "autopost"},
    }


def _claim_now(store: db.Store, user_id: str, now: datetime) -> None:
    """A test run (§46.8): at most one a minute (409 otherwise)."""
    try:
        store.update_expr(
            db.user_pk(user_id),
            STATE_SK,
            "SET #n = :now, #t = :type",
            condition="attribute_not_exists(#n) OR #n <= :limit",
            names={"#n": "lastNowAt", "#t": "type"},
            values={":now": iso(now), ":type": "autopost", ":limit": iso(now - NOW_EVERY)},
        )
    except db.ConditionFailed as e:
        raise conflict(JUST_STARTED) from e


def _plan(app: App, user_id: str, kind: str, mode: str, auto: Mapping[str, Any]) -> tuple[list[Item], str | None]:
    """The run's clips (``{clipId, hook, places}``) and its note."""
    private = mode == "private"
    count = 1 if private else int(auto.get("perRun") or 1)
    found = pick(app, user_id, app.clock(), limit=count, normal_only=private)
    if private and not found.taken:
        return [], NOTHING_TO_TEST
    if not private and found.candidates == 0:
        return [], NOTHING_IN_REVIEW
    # X has no private posts, so a Private test run leaves it out (§46.8).
    places = [p for p in found.places if not (private and p == "x")]
    if not places:
        return [], NOTHING_SET_UP
    if not found.taken:
        return [], ALL_WAITING
    return [
        {
            "clipId": str(t.clip["clipId"]),
            "hook": str(t.clip.get("hook") or ""),
            "places": [p for p in t.places if not (private and p == "x")],
        }
        for t in found.taken[:count]
    ], None


def _send(deps: RunDeps, user_id: str, run: Item, current: Mapping[str, Any], deadline: float) -> Item:
    store = deps.app.store
    out: list[Item] = []
    for planned in run.get("clips") or []:
        entry: Item = {k: planned[k] for k in ("clipId", "hook", "places") if k in planned}
        if run.get("mode") == "practice":
            entry["outcome"] = "would_send"  # Practice: picked on time, nothing sent, the clip stays in Review
        elif deps.monotonic() + deps.clip_seconds > deadline:
            entry.update({"outcome": "skipped", "reason": OUT_OF_TIME})
        else:
            outcome, reason = _send_one(deps.app, user_id, run, planned, current)
            entry["outcome"] = outcome
            if reason:
                entry["reason"] = reason
        out.append(entry)
    pk, sk = str(run["pk"]), str(run["sk"])
    try:
        done = store.update(pk, sk, {"state": "done", "clips": out}, expect_in={"state": ["planned"]})
    except db.ConditionFailed:
        # An overlapping invocation of this run finished first: its outcomes stand.
        done = store.get(pk, sk) or {**run, "state": "done", "clips": out}
    log(
        "info",
        "autopost.done",
        runId=run.get("runId"),
        mode=run.get("mode"),
        sent=sum(1 for c in out if c.get("outcome") == "sent"),
        skipped=sum(1 for c in out if c.get("outcome") == "skipped"),
    )
    return done


def _send_one(
    app: App, user_id: str, run: Item, planned: Mapping[str, Any], current: Mapping[str, Any]
) -> tuple[str, str | None]:
    """One planned clip through Upload's own code: ``sent`` or ``skipped`` with the reason."""
    pk = db.user_pk(user_id)
    clip_id = str(planned["clipId"])
    places = [str(p) for p in planned.get("places") or []]
    clip = app.store.get(pk, db.clip_sk(clip_id))
    if clip is not None and clip.get("status") == "review":
        from ..routes import clips as checks  # Upload's campaign rules (§38.14)

        auto: Item = {"runId": str(run["runId"]), "at": str(run["at"])}
        if run.get("mode") == "private":
            auto["test"] = "private"
        campaign = checks.campaign_clip(app, user_id, clip) is not None
        try:
            uploads.upload_review_clip(
                app,
                user_id,
                clip,
                platforms=places,
                options=post_preset.upload_options(current, places, campaign=campaign),
                auto=auto,
            )
        except uploads.ClipTaken:
            clip = app.store.get(pk, db.clip_sk(clip_id))
        except ApiError as e:  # a campaign or fit refusal, or a place that is no longer set up: Upload's sentence
            log("info", "autopost.skipped", runId=run.get("runId"), clipId=clip_id, status=e.status)
            return "skipped", e.message
        else:
            return "sent", None
    return _taken(app, run, clip)


def _taken(app: App, run: Item, clip: Item | None) -> tuple[str, str | None]:
    """The clip left Review before this run sent it: this run's own (a retry or an overlap sent it) or the owner's."""
    if clip is not None and clip.get("autoRun") == run.get("runId"):
        if clip.get("publishState") == clips.PUBLISH_PENDING and clip.get("status") in clips.STARTABLE:
            release.start_flow(app.store, app.flows, clip)  # its start did not go through: finish it (§14.5)
        return "sent", None
    if clip is None or clip.get("status") == "declined":
        return "skipped", THROWN_AWAY
    return "skipped", UPLOADED_BY_HAND
