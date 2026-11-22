"""One auto-posting run (docs/CONTRACTS.md §46.7), shared by the hourly tick and the API's test runs (§46.8).

``run_once(deps, user_id, kind, slot)``; ``kind`` is ``scheduled``, ``practice_now`` or ``private_now``. Its ``mode``
is ``live``, ``practice`` (a scheduled run while Practice is on, or ``practice_now``) or ``private``
(``private_now``). ``runId = "{slot}#{kind}"`` (the slot to the second for a test run).

1. **Scheduled only:** off → ``off``. A run item of this slot already there → it is **resumed** (``done`` → ``done``;
   ``planned`` → step 4 with its own clips, never a new pick). Otherwise ``slot < nextRunAt`` → ``not_due``, and
   ``AUTOPOST.lastTickAt`` becomes the slot (the page then stops showing this hour as the next run, §46.4).
2. **Plan:** the first ``perRun`` taken clips (a Private test run: 1, never a campaign clip), each with its places.
   The run item says when it planned (``plannedAt``, the clock's time): rule 5 of the pick counts from it.
3. **Claim:** one transaction puts ``AUTORUN#{runId}`` (``planned``, its clips) and moves ``AUTOPOST.lastRunAt`` to the
   slot (only forward). Cancelled because the run exists → resume it; cancelled because ``lastRunAt`` already reached
   the slot → ``not_due``. Cancelled for neither (DynamoDB also cancels on a write to ``AUTOPOST`` at that moment, such
   as a test run's, or on throttling) → claim again once, then raise: the Lambda's retry of the same event claims the
   same slot, so the gaps stay even. A test run first moves ``AUTOPOST.lastNowAt`` (at most one a minute, else 409)
   and puts its run alone; it never moves the schedule. Once a live scheduled run has claimed, it first finishes the
   start of every clip an earlier scheduled run confirmed whose clip flow never started (``publishState: pending``
   after all of that run's Lambda retries), with Upload's own ``release.start_flow``, while ``clip_seconds`` are
   left for that start and for each of its own planned clips (earlier ones left over wait for the next run).
4. **Send** each planned clip through Upload's own code (``uploads.upload_review_clip``; with Your Mac posts TikTok
   on, a live run's normal clip also gets a TikTok post for the owner's Mac, §47): the same conditional
   transaction (``status = review``, no live Throw away hold, posts created once) and idempotent flow start, so a clip
   is confirmed and its flow started only once, whichever run, retry or Upload gets there first. Practice sends
   nothing (``would_send``). A clip still in Review after its transaction was cancelled (nothing took it) is tried
   once more; a clip the owner is throwing away (its hold is on) is skipped: "You threw it away first."
5. **Done:** the run item gets ``state: done`` and each clip's outcome. A new clip only starts with ``clip_seconds``
   left; the rest wait for the next run ("Out of time. It goes next run."). A scheduled run whose clip flow did not
   start stays ``planned`` and raises once every clip was tried: the Lambda's retry resumes it and finishes the start.

The clip flow then posts each place one after another (§17.6), so one place failing never stops the others; Upload's
retries stay (up to 3 tries when a platform does not answer, none where a retry could post twice).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .. import clips, db, post_preset, release, settings, tiktok_mac, uploads
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
ANOTHER_RUN = "Another auto-posting run sent it first."
NOT_SENT = "It changed while it was being sent. It goes next run."
JUST_STARTED = "A test run just started. Wait a minute."
TRIES = 2  # the claim, and one clip's Upload, when DynamoDB cancelled it though nothing had taken it


class ClaimFailed(Exception):
    """The claim was cancelled though neither the run nor a later slot had it (§46.7 step 3): the Lambda's retry of
    the same event claims this slot again."""


class FlowNotStarted(Exception):
    """A scheduled run sent its clips but a clip flow did not start (§14.5): the run stays ``planned`` and the
    Lambda's retry of the same event resumes it and finishes the start."""


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
            return _not_due(store, pk, slot)
        mode = "practice" if auto.get("practice") else "live"
    else:
        slot = slot.replace(microsecond=0)
        run_id = run_id_of(slot, kind)
        mode = "practice" if kind == "practice_now" else "private"
        _claim_now(store, user_id, slot)
    found = clips.all_clips(store, user_id)
    planned, note = _plan(app, user_id, kind, mode, auto, every=found)
    item: Item = {
        "pk": pk,
        "sk": run_sk(run_id),
        "type": "autorun",
        "userId": user_id,
        "runId": run_id,
        "at": iso(slot),
        "plannedAt": iso(app.clock()),
        "kind": kind,
        "mode": mode,
        "state": "planned",
        "clips": planned,
        "ttl": int((app.clock() + RUN_TTL).timestamp()),
        **({"note": note} if note else {}),
    }
    if kind == "scheduled":
        for _ in range(TRIES):
            try:
                store.transact(puts=[item], updates=[_last_run(pk, iso(slot), run_id)])
                break
            except db.ConditionFailed:
                existing = store.get(pk, run_sk(run_id))
                if existing is not None:  # another delivery of this slot claimed first: its plan stands
                    return _resume(deps, user_id, existing, current, deadline)
                if str((store.get(pk, STATE_SK) or {}).get("lastRunAt") or "") >= iso(slot):
                    return _not_due(store, pk, slot)  # another run of a later slot moved the schedule first
                log("warning", "autopost.claim_cancelled", runId=run_id)  # a conflict or throttling: claim again
        else:
            raise ClaimFailed(run_id)
        if mode == "live":  # Practice sends nothing, not even an earlier run's clip
            _finish_starts(deps, run_id, found, deadline, own=len(planned))
    else:
        store.put(item, if_absent=True)
    log("info", "autopost.planned", runId=run_id, mode=mode, clips=len(planned), note=note or "")
    return Outcome("ran", _send(deps, user_id, item, current, deadline))


def _resume(deps: RunDeps, user_id: str, run: Item, current: Mapping[str, Any], deadline: float) -> Outcome:
    if run.get("state") == "done":
        return Outcome("done", run)
    log("info", "autopost.resumed", runId=run.get("runId"))
    return Outcome("ran", _send(deps, user_id, run, current, deadline))


def _not_due(store: db.Store, pk: str, slot: datetime) -> Outcome:
    """§46.4: this slot's tick looked and found it not due (``AUTOPOST.lastTickAt``), so the page stops showing this
    hour as the next run. No condition: the item is created when it is not there yet."""
    store.update_expr(
        pk,
        STATE_SK,
        "SET #k = :slot, #t = :type",
        names={"#k": "lastTickAt", "#t": "type"},
        values={":slot": iso(slot), ":type": "autopost"},
    )
    return Outcome("not_due")


def _finish_starts(deps: RunDeps, run_id: str, found: list[Item], deadline: float, *, own: int) -> None:
    """§46.7 step 3: a clip an earlier scheduled run confirmed whose clip flow never started (its run's Lambda retries
    ran out) gets its start finished now, with Upload's own ``release.start_flow`` (idempotent on the execution name,
    conditional on ``publishState: pending``). Each is read again first; one that fails is logged and skipped. One
    only starts while ``clip_seconds`` are left for it and for each of this run's ``own`` planned clips, so earlier
    clips never push this run's own into "Out of time. It goes next run."."""
    app = deps.app
    for stale in found:
        earlier = stale.get("autoRun")
        if not (
            stale.get("type") == "clip"
            and isinstance(earlier, str)
            and earlier.endswith("#scheduled")
            and earlier != run_id
            and stale.get("publishState") == clips.PUBLISH_PENDING
            and stale.get("status") in clips.STARTABLE
        ):
            continue
        if deps.monotonic() + deps.clip_seconds * (own + 1) > deadline:
            return  # the time left is this run's own clips'; the next run finishes the rest
        clip_id = str(stale.get("clipId"))
        try:
            clip = app.store.get(str(stale["pk"]), str(stale["sk"]))
            if (
                not clip
                or clip.get("publishState") != clips.PUBLISH_PENDING
                or clip.get("status") not in clips.STARTABLE
            ):
                continue
            started = release.start_flow(app.store, app.flows, clip)
        except Exception as e:  # one clip never stops the run
            log("error", "autopost.finish_start_failed", runId=run_id, clipId=clip_id, error=type(e).__name__)
            continue
        if started.get("publishState") == clips.PUBLISH_PENDING:
            log("warning", "autopost.finish_start_failed", runId=run_id, clipId=clip_id, error="not_started")
            continue
        log("info", "autopost.finished_start", runId=run_id, clipId=clip_id, earlierRunId=earlier)


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


def _plan(
    app: App, user_id: str, kind: str, mode: str, auto: Mapping[str, Any], *, every: list[Item]
) -> tuple[list[Item], str | None]:
    """The run's clips (``{clipId, hook, places}``) and its note. ``every`` is the owner's clips, read once."""
    private = mode == "private"
    count = 1 if private else int(auto.get("perRun") or 1)
    found = pick(app, user_id, app.clock(), found=every, limit=count, normal_only=private)
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
    unstarted: list[str] = []
    for planned in run.get("clips") or []:
        entry: Item = {k: planned[k] for k in ("clipId", "hook", "places") if k in planned}
        if run.get("mode") == "practice":
            entry["outcome"] = "would_send"  # Practice: picked on time, nothing sent, the clip stays in Review
        elif deps.monotonic() + deps.clip_seconds > deadline:
            entry.update({"outcome": "skipped", "reason": OUT_OF_TIME})
        else:
            outcome, reason, started = _send_one(deps.app, user_id, run, planned, current)
            entry["outcome"] = outcome
            if reason:
                entry["reason"] = reason
            if not started:
                unstarted.append(str(planned["clipId"]))
        out.append(entry)
    if unstarted and run.get("kind") == "scheduled":
        # Nobody is there at 3 a.m. to tap Try again: the run stays planned and the Lambda's retry finishes the start.
        log("error", "autopost.flow_not_started", runId=run.get("runId"), clipIds=",".join(unstarted))
        raise FlowNotStarted(str(run.get("runId")))
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
) -> tuple[str, str | None, bool]:
    """One planned clip through Upload's own code: ``sent`` or ``skipped`` with the reason, and whether its clip flow
    started (False only for a clip this run sent whose start did not go through, §14.5)."""
    from ..routes import clips as checks  # Upload's campaign rules (§38.14)

    pk = db.user_pk(user_id)
    clip_id = str(planned["clipId"])
    places = [str(p) for p in planned.get("places") or []]
    clip = app.store.get(pk, db.clip_sk(clip_id))
    auto: Item = {"runId": str(run["runId"]), "at": str(run["at"])}
    if run.get("mode") == "private":
        auto["test"] = "private"
    for _ in range(TRIES):
        if clip is None or clip.get("status") != "review" or clips.is_held(clip, app.clock()):
            return _taken(app, run, clip)
        campaign = checks.campaign_clip(app, user_id, clip) is not None
        try:
            confirmed, _posts = uploads.upload_review_clip(
                app,
                user_id,
                clip,
                platforms=places,
                options=post_preset.upload_options(current, places, campaign=campaign),
                auto=auto,
                # §47: with Your Mac posts TikTok on, a live run's normal clip also gets a TikTok post for the Mac (in
                # the same transaction; TikTok is still never one of the run's places). Never Practice or a Private test.
                tiktok_mac=run.get("mode") == "live" and tiktok_mac.is_on(current),
            )
        except uploads.ClipTaken:
            # Another run, a Throw away (or its hold) or an Upload took it, or DynamoDB cancelled the transaction (a
            # write to the clip at that moment, or throttling) and it is still in Review: read it again.
            clip = app.store.get(pk, db.clip_sk(clip_id))
        except ApiError as e:  # a campaign or fit refusal, or a place that is no longer set up: Upload's sentence
            log("info", "autopost.skipped", runId=run.get("runId"), clipId=clip_id, status=e.status)
            return "skipped", e.message, True
        else:
            return "sent", None, confirmed.get("publishState") != clips.PUBLISH_PENDING
    if clip is None or clip.get("status") != "review" or clips.is_held(clip, app.clock()):
        return _taken(app, run, clip)
    log("warning", "autopost.not_sent", runId=run.get("runId"), clipId=clip_id)
    return "skipped", NOT_SENT, True  # still in Review: it goes in the next run


def _taken(app: App, run: Item, clip: Item | None) -> tuple[str, str | None, bool]:
    """The clip left Review before this run sent it (this run's own: a retry or an overlap sent it; another run's; or
    the owner's), or the owner is throwing it away (still in Review, its hold on)."""
    if clip is not None and clip.get("autoRun") == run.get("runId"):
        if clip.get("publishState") == clips.PUBLISH_PENDING and clip.get("status") in clips.STARTABLE:
            clip = release.start_flow(app.store, app.flows, clip)  # its start did not go through: finish it (§14.5)
            return "sent", None, clip.get("publishState") != clips.PUBLISH_PENDING
        return "sent", None, True
    if clip is None or clip.get("status") in {"declined", "review"}:  # thrown away, or held by a Throw away
        return "skipped", THROWN_AWAY, True
    if clip.get("autoRun"):  # a test run (or a run of another slot) sent it between this run's plan and its send
        return "skipped", ANOTHER_RUN, True
    return "skipped", UPLOADED_BY_HAND, True
