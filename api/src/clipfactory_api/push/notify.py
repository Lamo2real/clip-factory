"""``cf-prod-notify``: job changes on the table's stream → notifications on the owner's devices (CONTRACTS §32.5).

The event source mapping delivers only ``MODIFY`` records of ``JOB#`` items. Each record compares the job before and
after the write and sends at most one notification:

- **ready**: the job became ``ready`` ("Your clips are ready. Tap to look."), when ``notify.ready`` is on;
- **stopped**: it became ``failed`` ("It stopped. Tap Try again."), when ``notify.stopped`` is on;
- **resumed**: a stopped run is picked up again (a new run with ``pickUp``), when ``notify.resumed`` is on;
- **step**: a running job started another step or another clip ("Cutting the clips · step 7 of 10 · clip 3 of 10"),
  when ``notify.steps`` is on (off by default), at most once every 2 minutes per job.

Every notification of one job carries the same tag (the job id), so the newest replaces the one before it: one
live card per job on the lock screen, not a pile. Each also carries ``badge``, how many jobs are working now, for the
app icon's badge (the Badging API, §32.6).

Stream retries can deliver a record twice, so each notification first writes ``NOTIFIED#<jobId>#<run>#<event>``
once (2-day TTL). A device the push service calls gone (404, 410) is marked ``gone`` with a TTL; nothing here ever
deletes an item. Sending is best effort: a failure is logged (status codes and ids only) and never retried, so one
bad device can never hold up the stream.
"""

from __future__ import annotations

import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from .. import db, settings
from ..clock import Clock, iso, utcnow
from ..log import log
from . import devices, webpush

Item = dict[str, Any]

TITLE_MAX = 40
STEP_GAP_SECONDS = 120
DEDUPE_DAYS = 2
READY = "Your clips are ready. Tap to look."
STOPPED = "It stopped. Tap Try again."
TEST_TITLE = "Clip Factory"
RESUMED = "Picking up where it stopped."
TEST_BODY = "Notifications are on 🎉"
ACTIVE = ("queued", "running")
CLIP_OF = re.compile(r"\bclip (\d+) of (\d+)\b", re.IGNORECASE)
# What each step is doing, in the words the job page uses (docs/CONTRACTS.md §32.6).
DOING = {
    "resolve": "Finding the video",
    "download": "Getting the video",
    "transcribe": "Writing down the words",
    "analyze": "Listening for big moments",
    "watch": "Watching the video",
    "select": "Picking the best moments",
    "render": "Cutting the clips",
    "checklist": "Checking each clip",
    "captions": "Writing the captions",
    "finalize": "Finishing up",
}
GONE = frozenset({404, 410})


def video_title(job: Mapping[str, Any]) -> str:
    """The video's name, cut to 40 characters. Never the link: a lock screen is no place for addresses."""
    raw = job.get("source")
    source: Mapping[str, Any] = raw if isinstance(raw, dict) else {}
    title = " ".join(str(source.get("title") or source.get("filename") or "Your video").split())
    return title if len(title) <= TITLE_MAX else title[: TITLE_MAX - 1].rstrip() + "…"


def running_step(job: Mapping[str, Any]) -> tuple[str, int, int] | None:
    """(key, number, how many) of the step running now, or None."""
    steps = [s for s in job.get("steps") or [] if isinstance(s, dict)]
    for n, step in enumerate(steps, start=1):
        if step.get("status") == "running":
            return str(step.get("key")), n, len(steps)
    return None


def clip_of(job: Mapping[str, Any]) -> tuple[int, int] | None:
    """(clip, how many) from the running step's live line ("Cutting clip 3 of 10…"), or None."""
    for step in job.get("steps") or []:
        if isinstance(step, dict) and step.get("status") == "running":
            found = CLIP_OF.search(str(step.get("message") or ""))
            return (int(found.group(1)), int(found.group(2))) if found else None
    return None


def event_for(old: Mapping[str, Any], new: Mapping[str, Any]) -> str | None:
    """``ready``, ``stopped``, ``resumed``, ``step:<key>[:<clip>]`` or None for one change of a job."""
    status, before = new.get("status"), old.get("status")
    if status == "ready" and before != "ready":
        return "ready"
    if status == "failed" and before != "failed":
        return "stopped"
    if status in ACTIVE and new.get("pickUp") and new.get("sessionId") != old.get("sessionId"):
        return "resumed"
    if status != "running":
        return None
    now, was = running_step(new), running_step(old)
    if not now:
        return None
    clip, clip_was = clip_of(new), clip_of(old)
    if was is None or was[0] != now[0] or (clip and clip != clip_was):
        return f"step:{now[0]}" + (f":{clip[0]}" if clip else "")
    return None


def step_line(job: Mapping[str, Any]) -> str:
    """ "Cutting the clips · step 7 of 10 · clip 3 of 10": what the job is doing, in the job page's words."""
    step = running_step(job)
    if not step:
        return "Working"
    key, n, total = step
    parts = [DOING.get(key, "Working"), f"step {n} of {total}"]
    clip = clip_of(job)
    if clip:
        parts.append(f"clip {clip[0]} of {clip[1]}")
    return " · ".join(parts)


def message_for(event: str, job: Mapping[str, Any], badge: int | None = None) -> webpush.Message:
    """One job's notification. The tag is the job id, so each one replaces that job's last one."""
    job_id = str(job.get("jobId") or "")
    title, url = video_title(job), f"/jobs/{job_id}"
    if event == "ready":
        return webpush.Message(title, READY, job_id, url, ttl=24 * 3600, urgency="high", badge=badge)
    if event == "stopped":
        return webpush.Message(title, STOPPED, job_id, url, ttl=24 * 3600, urgency="high", badge=badge)
    if event == "resumed":
        return webpush.Message(title, RESUMED, job_id, url, ttl=3600, urgency="normal", badge=badge)
    # A progress card: it replaces the last one quietly. One not delivered yet is replaced by the next (Topic), and
    # it is worth nothing after 10 minutes.
    return webpush.Message(
        title,
        step_line(job),
        job_id,
        url,
        ttl=600,
        urgency="normal",
        topic=f"job{job_id}"[:32],
        quiet=True,
        badge=badge,
    )


def working_count(store: db.Store, user_id: str) -> int:
    """How many of the owner's jobs are queued or running (the app icon's badge)."""
    return sum(1 for j in store.query_all(db.user_pk(user_id), "JOB#") if j.get("status") in ACTIVE)


def wanted(prefs: Mapping[str, Any], event: str) -> bool:
    if event == "ready":
        return bool(prefs.get("ready"))
    if event == "stopped":
        return bool(prefs.get("stopped"))
    if event == "resumed":
        return bool(prefs.get("resumed", True))
    return bool(prefs.get("steps"))


@dataclass
class NotifyDeps:
    store: db.Store
    key: devices.VapidKey
    deserialize: Callable[[Mapping[str, Any]], Item]
    post: webpush.Poster = webpush.urllib_post
    clock: Clock = utcnow
    epoch: Callable[[], float] = time.time
    sent_log: list[tuple[str, int]] = field(default_factory=list)  # (deviceId, status); tests read it


def send_to_devices(deps: NotifyDeps, user_id: str, message: webpush.Message, subs: list[Item]) -> int:
    """Sends one message to each device; marks gone ones. Returns how many push services took it."""
    key = deps.key.private()
    delivered = 0
    for sub in subs:
        device_id = str(sub.get("deviceId"))
        try:
            status = webpush.send(
                devices.subscription(sub), message, key, deps.key.subject, post=deps.post, now=deps.epoch
            )
        except Exception as e:
            log("warning", "notify.send_failed", deviceId=device_id, error=type(e).__name__)
            continue
        deps.sent_log.append((device_id, status))
        if 200 <= status < 300:
            delivered += 1
        elif status in GONE:
            _mark_gone(deps, sub)
        else:
            log("warning", "notify.refused", deviceId=device_id, status=status)
    log("info", "notify.sent", userId=user_id, devices=len(subs), delivered=delivered)
    return delivered


def _mark_gone(deps: NotifyDeps, sub: Item) -> None:
    ttl = int(deps.clock().timestamp()) + devices.GONE_TTL_SECONDS
    try:
        deps.store.update(sub["pk"], sub["sk"], {"gone": True, "ttl": ttl}, expect_present=["endpoint"])
        log("info", "notify.device_gone", deviceId=sub.get("deviceId"))
    except Exception as e:
        log("warning", "notify.gone_failed", deviceId=sub.get("deviceId"), error=type(e).__name__)


def _first_time(deps: NotifyDeps, pk: str, job: Mapping[str, Any], event: str) -> bool:
    """Writes the dedupe item once; False when this notification was already sent (a stream retry)."""
    now = deps.clock()
    run = str(job.get("sessionId") or job.get("flowRun") or "")
    item = {
        "pk": pk,
        "sk": f"NOTIFIED#{job.get('jobId')}#{run}#{event}",
        "type": "notified",
        "at": iso(now),
        "ttl": int((now + timedelta(days=DEDUPE_DAYS)).timestamp()),
    }
    try:
        deps.store.put(item, if_absent=True)
    except db.ConditionFailed:
        return False
    return True


def _step_allowed(deps: NotifyDeps, pk: str, job_id: str) -> bool:
    """At most one step notification every 2 minutes per job (one conditional write)."""
    now = deps.clock()
    cutoff = iso(now - timedelta(seconds=STEP_GAP_SECONDS))
    try:
        deps.store.update_expr(
            pk,
            f"NOTIFYSTEP#{job_id}",
            "SET #at = :now, #ttl = :ttl, #type = :type",
            condition="attribute_not_exists(pk) OR #at <= :cutoff",
            names={"#at": "at", "#ttl": "ttl", "#type": "type"},
            values={
                ":now": iso(now),
                ":cutoff": cutoff,
                ":ttl": int((now + timedelta(days=1)).timestamp()),
                ":type": "notifystep",
            },
        )
    except db.ConditionFailed:
        return False
    return True


def handle_change(deps: NotifyDeps, old: Mapping[str, Any], new: Mapping[str, Any]) -> str | None:
    """Sends the notification one job change calls for; returns the event sent, or None."""
    event = event_for(old, new)
    user_id = str(new.get("userId") or "")
    job_id = str(new.get("jobId") or "")
    if event is None or not user_id or not job_id:
        return None
    prefs = settings.load(deps.store, user_id).get("notify") or {}
    if not wanted(prefs, event):
        return None
    subs = devices.active(deps.store, user_id)
    if not subs:
        return None
    pk = db.user_pk(user_id)
    if event.startswith("step:") and not _step_allowed(deps, pk, job_id):
        return None
    if not _first_time(deps, pk, new, event):
        return None
    try:
        badge: int | None = working_count(deps.store, user_id)
    except Exception as e:  # the badge is a nicety: the notification goes without it
        log("warning", "notify.badge_failed", error=type(e).__name__)
        badge = None
    send_to_devices(deps, user_id, message_for(event, new, badge), subs)
    return event


def process(event: Mapping[str, Any], deps: NotifyDeps) -> dict[str, list[Any]]:
    records = [r for r in event.get("Records", []) if isinstance(r, Mapping)]
    sent = 0
    for record in records:
        data = record.get("dynamodb") or {}
        sk = ((data.get("Keys") or {}).get("sk") or {}).get("S", "")
        if record.get("eventName") != "MODIFY" or not str(sk).startswith("JOB#"):
            continue
        old, new = data.get("OldImage"), data.get("NewImage")
        if not isinstance(old, Mapping) or not isinstance(new, Mapping):
            continue
        try:
            if handle_change(deps, deps.deserialize(old), deps.deserialize(new)):
                sent += 1
        except Exception as e:  # one bad record or device never holds up the stream
            log("error", "notify.failed", error=type(e).__name__)
    log("info", "notify.done", records=len(records), sent=sent)
    return {"batchItemFailures": []}


_deps: NotifyDeps | None = None


def _from_env() -> NotifyDeps:
    import boto3

    from ..app import _short_config, region, table
    from ..realtime.broadcast import _deserializer

    env = os.environ
    return NotifyDeps(
        store=db.Store(table(env["TABLE_NAME"])),
        key=devices.VapidKey(
            boto3.client("secretsmanager", region_name=region(), config=_short_config()),
            env["PUSH_VAPID_SECRET"],
            env["PUSH_SUBJECT"],
        ),
        deserialize=_deserializer(),
    )


def handler(event: dict[str, Any], _context: Any = None) -> dict[str, list[Any]]:
    global _deps
    if _deps is None:
        _deps = _from_env()
    return process(event, _deps)
