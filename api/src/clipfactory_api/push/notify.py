"""``cf-prod-notify``: job changes on the table's stream → notifications on the owner's devices (CONTRACTS §32.5).

The event source mapping delivers only ``MODIFY`` records of ``JOB#`` items and of the Content Rewards items
``CAMPAIGN#``, ``CRSUB#``, ``CRMONEY``, ``CRCONN`` (§38.11: you're in, send now, approved, not approved, proof, money,
sign in again, did they say yes) and ``CRFIND`` (§41.4: new campaigns match, at most once a day); one each, deduped by
``NOTIFIED#cr#{key}``, under ``notify.contentRewards``, and of ``PAYSTATE#`` (§40.7: money on hold, money sent to
your bank; one each, deduped by ``NOTIFIED#getpaid#{key}``, under ``notify.getPaid``, never for the first read after
a grant). Each job record compares the job before and after the write and sends at most one notification:

- **ready**: the job became ``ready`` ("Your clips are ready. Tap to look."), when ``notify.ready`` is on;
- **stopped**: it became ``failed`` ("It stopped. Tap Try again."), when ``notify.stopped`` is on;
- **resumed**: a stopped run is picked up again (a new run with ``pickUp``), when ``notify.resumed`` is on (off by
  default: the job flow resumes by itself, up to 6 times a run, and the owner has nothing to do); it is quiet;
- **step**: a running job is on another step or another clip than the last card showed ("Cutting the clips · step 7
  of 10 · clip 3 of 10"), when ``notify.steps`` is on (off by default), at most once every 2 minutes per job. The
  step last shown is kept in ``NOTIFYSTEP#<jobId>``, so a change held back inside the 2 minutes is still sent by the
  job's next write once the gap is over.

Every notification of one job carries the same tag (the job id), so the newest replaces the one before it: one
live card per job on the lock screen, not a pile. Each also carries ``badge``, how many jobs are working now, for the
app icon's badge (the Badging API, §32.6).

Stream retries can deliver a record twice, so each notification first writes ``NOTIFIED#<jobId>#<run>#<event>``
once (2-day TTL); a step card is deduped by its ``NOTIFYSTEP#`` write instead. A device the push service calls gone (404, 410) is marked ``gone`` with a TTL; nothing here ever
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
from decimal import Decimal
from typing import Any

from .. import db, settings
from ..clock import Clock, iso, parse, utcnow
from ..log import log
from . import devices, webpush

Item = dict[str, Any]

TITLE_MAX = 40
STEP_GAP_SECONDS = 120
BADGE_JOBS = 50
DEDUPE_DAYS = 2
READY = "Your clips are ready. Tap to look."
STOPPED = "It stopped. Tap Try again."
TEST_TITLE = "Clip Factory"
RESUMED = "Picking up where it stopped."
MAC = "Open Clip Factory on your Mac to continue."  # docs/CONTRACTS.md §35.2
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
    if status in ACTIVE and _nudged(new) and not _nudged(old):
        return "mac"
    if status != "running":
        return None
    # The step now running. Whether it was already shown is decided against what was last sent (``_step_allowed``),
    # not against the old item, so a change held back inside the 2-minute gap is sent by a later write.
    now = running_step(new)
    if not now:
        return None
    clip = clip_of(new)
    return f"step:{now[0]}" + (f":{clip[0]}" if clip else "")


def _nudged(job: Mapping[str, Any]) -> bool:
    """The job flow marked a job no Mac claimed within 2 minutes (docs/CONTRACTS.md §35.2)."""
    mac = job.get("macFetch")
    return isinstance(mac, Mapping) and bool(mac.get("nudgedAt"))


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
    if event == "mac":
        return webpush.Message(title, MAC, job_id, url, ttl=24 * 3600, urgency="high", badge=badge)
    if event == "resumed":
        return webpush.Message(
            title, RESUMED, job_id, url, ttl=3600, urgency="normal", topic=f"job{job_id}"[:32], quiet=True, badge=badge
        )
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
    # The newest 50 jobs, as the web reads them: a count that never grows with every job the owner ever made.
    newest = store.query_all(db.user_pk(user_id), "JOB#", newest_first=True, cap=BADGE_JOBS)
    return sum(1 for j in newest if j.get("status") in ACTIVE)


def wanted(prefs: Mapping[str, Any], event: str) -> bool:
    if event == "ready":
        return bool(prefs.get("ready"))
    if event == "stopped":
        return bool(prefs.get("stopped"))
    if event == "resumed":
        return bool(prefs.get("resumed", False))
    if event == "mac":
        # The job needs the owner (open the app on the Mac), like "It stopped", so it follows that choice.
        return bool(prefs.get("stopped"))
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


def _step_allowed(deps: NotifyDeps, pk: str, job_id: str, shown: str) -> bool:
    """One conditional write decides a step card: it is sent when it shows something other than the last card
    (``shown``: the run, step and clip) and 2 minutes have passed since that card. It also dedupes a stream retry
    (the same ``shown`` again) and never uses up the slot unless the card goes out."""
    now = deps.clock()
    cutoff = iso(now - timedelta(seconds=STEP_GAP_SECONDS))
    try:
        deps.store.update_expr(
            pk,
            f"NOTIFYSTEP#{job_id}",
            "SET #at = :now, #ttl = :ttl, #type = :type, #shown = :shown",
            condition="attribute_not_exists(pk) OR (#shown <> :shown AND #at <= :cutoff)",
            names={"#at": "at", "#ttl": "ttl", "#type": "type", "#shown": "shown"},
            values={
                ":now": iso(now),
                ":cutoff": cutoff,
                ":ttl": int((now + timedelta(days=1)).timestamp()),
                ":type": "notifystep",
                ":shown": shown,
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
    if event.startswith("step:"):
        run = str(new.get("sessionId") or new.get("flowRun") or "")
        if not _step_allowed(deps, pk, job_id, f"{run}|{event}"):
            return None
    elif not _first_time(deps, pk, new, event):
        return None
    try:
        badge: int | None = working_count(deps.store, user_id)
    except Exception as e:  # the badge is a nicety: the notification goes without it
        log("warning", "notify.badge_failed", error=type(e).__name__)
        badge = None
    send_to_devices(deps, user_id, message_for(event, new, badge), subs)
    return event


# --- Content Rewards (§38.11) -----------------------------------------------------------------------------------

CR_PREFIXES = ("CAMPAIGN#", "CRSUB#", "CRMONEY", "CRCONN", "CRFIND")
CR_TITLE = "Content Rewards"
CR_SIGN_IN = "Sign in to Content Rewards again on your Mac, so your clips keep getting sent."
CR_PILOT = "Did Content Rewards say yes? Tap Connect Content Rewards on your Mac to check."
CR_SETUP_URL = "/settings/posting/setup/contentrewards"
CR_FIND_URL = "/campaigns/find"


def finder_words(count: int) -> str:
    """§41.4: "3 new campaigns match what you want." ("1 new campaign matches what you want.")."""
    if count == 1:
        return "1 new campaign matches what you want."
    return f"{count} new campaigns match what you want."


def _cut(text: Any, limit: int = TITLE_MAX) -> str:
    clean = " ".join(str(text or "").split()) or CR_TITLE
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


def _dollars(cents: int) -> str:
    whole, rest = divmod(int(cents), 100)
    return f"${whole:,}.{rest:02d}"


def _campaign_name(deps: NotifyDeps, user_id: str, campaign_id: Any) -> str:
    if not isinstance(campaign_id, str) or not campaign_id:
        return CR_TITLE
    item = deps.store.get(db.user_pk(user_id), f"CAMPAIGN#{campaign_id}") or {}
    return _cut(item.get("name"))


def cr_event(
    deps: NotifyDeps, user_id: str, sk: str, old: Mapping[str, Any], new: Mapping[str, Any]
) -> tuple[str, webpush.Message] | None:
    """(dedupe key, message) for one Content Rewards change, or None."""
    now = deps.clock()
    if sk.startswith("CAMPAIGN#"):
        before, after = old.get("membership"), new.get("membership")
        if after == "in" and before not in ("in", "manual"):
            uuid = sk.removeprefix("CAMPAIGN#")
            return f"in:{uuid}", webpush.Message(
                _cut(new.get("name")),
                "You're in! Tap to make clips.",
                f"cr-{uuid}",
                f"/campaigns/{uuid}",
                ttl=24 * 3600,
                urgency="high",
            )
        return None
    if sk.startswith("CRSUB#"):
        post_id, clip_id = str(new.get("postId") or sk.removeprefix("CRSUB#")), str(new.get("clipId") or "")
        if new.get("state") == "send_by_hand" and old.get("state") != "send_by_hand":
            send_by = parse(new.get("sendBy"))
            seconds = int((send_by - now).total_seconds()) if send_by else 0
            if seconds <= 0:
                return None
            minutes = max(1, -(-seconds // 60))
            return f"send:{post_id}", webpush.Message(
                CR_TITLE,
                f"Send this to Content Rewards now ({minutes} min left).",
                f"crsub-{clip_id}",
                f"/clips/{clip_id}?cr={post_id}",
                ttl=seconds,
                urgency="high",
            )
        if new.get("crStatus") != old.get("crStatus") and new.get("crStatus") in ("approved", "rejected"):
            name = _campaign_name(deps, user_id, new.get("campaignId"))
            body = (
                "Approved! The brand said yes to your clip."
                if new["crStatus"] == "approved"
                else "Not approved. Tap to see why."
            )
            return f"{new['crStatus']}:{post_id}", webpush.Message(
                name, body, f"crsub-{post_id}", f"/clips/{clip_id}", ttl=7 * 24 * 3600
            )
        old_proof: Mapping[str, Any] = old["proof"] if isinstance(old.get("proof"), Mapping) else {}
        new_proof: Mapping[str, Any] = new["proof"] if isinstance(new.get("proof"), Mapping) else {}
        if new_proof.get("notifiedAt") and not old_proof.get("notifiedAt"):
            name = _campaign_name(deps, user_id, new.get("campaignId"))
            return f"proof:{post_id}", webpush.Message(
                name,
                f"{name} wants proof of views now. Tap to see how.",
                f"crproof-{post_id}",
                f"/clips/{clip_id}?cr={post_id}",
                ttl=3 * 24 * 3600,
                urgency="high",
            )
        return None
    if sk == "CRMONEY":
        seen_before = set(old.get("payoutsSeen") or [])
        fresh = [p for p in new.get("payoutsSeen") or [] if p not in seen_before]
        if not fresh or not old.get("firstReadDone"):
            return None
        if int(old.get("paidTotalCents") or 0) == 0:
            body = "Your first money from Content Rewards!"
        else:
            body = f"Money from Content Rewards! {_dollars(int(new.get('lastPaidCents') or 0))} is in your balance."
        return f"money:{fresh[0]}", webpush.Message(
            CR_TITLE, body, "crmoney", "/money#content-rewards", ttl=7 * 24 * 3600
        )
    if sk == "CRFIND":
        return _finder_event(old, new)
    if sk == "CRCONN":
        soon = new.get("reason") == "expires_soon" and old.get("reason") != "expires_soon"
        dead = new.get("status") == "needs_reconnect" and old.get("status") != "needs_reconnect"
        if soon or dead:
            return f"signin:{'dead' if dead else 'soon'}:{new.get('signInBy') or ''}", webpush.Message(
                CR_TITLE, CR_SIGN_IN, "crconn", CR_SETUP_URL, ttl=7 * 24 * 3600, urgency="high"
            )
        if int(new.get("pilotReminders") or 0) > int(old.get("pilotReminders") or 0):
            return f"pilot:{new.get('pilotReminders')}:{new.get('pilotSentAt') or ''}", webpush.Message(
                CR_TITLE, CR_PILOT, "crpilot", CR_SETUP_URL, ttl=3 * 24 * 3600
            )
    return None


def _finder_event(old: Mapping[str, Any], new: Mapping[str, Any]) -> tuple[str, webpush.Message] | None:
    """The look set a new ``CRFIND.notice`` (§41.4): one "3 new campaigns match" while he wants to hear about new
    ones and didn't stop the finder. The look decides when (at most once a day); this only sends it."""
    notice: Mapping[str, Any] = new["notice"] if isinstance(new.get("notice"), Mapping) else {}
    before: Mapping[str, Any] = old["notice"] if isinstance(old.get("notice"), Mapping) else {}
    key, count = notice.get("key"), notice.get("count")
    if not isinstance(key, str) or not key or key == before.get("key"):
        return None
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        return None
    want: Mapping[str, Any] = new["want"] if isinstance(new.get("want"), Mapping) else {}
    if want.get("tellMe") is False or want.get("on") is False:
        return None
    return f"finder:{key}", webpush.Message(CR_TITLE, finder_words(count), "crfind", CR_FIND_URL, ttl=24 * 3600)


def _cr_first_time(deps: NotifyDeps, pk: str, key: str) -> bool:
    now = deps.clock()
    item = {
        "pk": pk,
        "sk": f"NOTIFIED#cr#{key}",
        "type": "notified",
        "at": iso(now),
        "ttl": int((now + timedelta(days=DEDUPE_DAYS)).timestamp()),
    }
    try:
        deps.store.put(item, if_absent=True)
    except db.ConditionFailed:
        return False
    return True


def handle_cr_change(deps: NotifyDeps, sk: str, old: Mapping[str, Any], new: Mapping[str, Any]) -> str | None:
    """Sends the one notification a Content Rewards change calls for (under ``notify.contentRewards``)."""
    user_id = str(new.get("userId") or "")
    if not user_id:
        pk = str(new.get("pk") or "")
        user_id = pk.removeprefix("USER#") if pk.startswith("USER#") else ""
    if not user_id:
        return None
    found = cr_event(deps, user_id, sk, old, new)
    if found is None:
        return None
    key, message = found
    prefs = settings.load(deps.store, user_id).get("notify") or {}
    if not prefs.get("contentRewards", True):
        return None
    subs = devices.active(deps.store, user_id)
    if not subs or not _cr_first_time(deps, db.user_pk(user_id), key):
        return None
    send_to_devices(deps, user_id, message, subs)
    return key


# --- Get paid (§40.7) -----------------------------------------------------------------------------------------

GETPAID_PREFIX = "PAYSTATE#"
GETPAID_TITLE = TEST_TITLE  # "Clip Factory"
GETPAID_DEDUPE_DAYS = 30
GETPAID_TTL = 7 * 24 * 3600
HOLD_YOUTUBE = "Your YouTube money is on hold. Tap to see why."
HOLD_WHOP = "Whop can't send your money. Tap to see why."
PLACE_URL = {
    "youtube": "/settings/posting/getpaid/youtube",
    "contentrewards": "/settings/posting/getpaid/contentrewards",
}
SENT_URL = "/money"
AMOUNT_MAX = 40
# Money types written without decimals (ISO 4217 exponent 0): "1,235 JPY", never "1,235.00 JPY".
NO_DECIMALS = frozenset(
    {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"}
)


def money_words(micros: Any, currency: Any) -> str | None:
    """Whop's amount as words ("$40.00", "412.00 SEK", "1,235 JPY", "$40.005"): formatting only, never a conversion
    and never rounded (every decimal Whop sent is shown; 2 at least, none for a money type without them)."""
    if isinstance(micros, bool) or not isinstance(micros, int) or micros < 0:
        return None
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        return None
    amount = Decimal(micros) / Decimal(1_000_000)  # exact: micros have at most 6 decimals
    exponent = amount.normalize().as_tuple().exponent
    shown = -exponent if isinstance(exponent, int) and exponent < 0 else 0
    places = max(0 if currency in NO_DECIMALS else 2, shown)
    number = f"{amount:,.{places}f}"
    return f"${number}" if currency == "USD" else f"{number} {currency}"


def _newer(old: Any, new: Any) -> Mapping[str, Any] | None:
    """``new`` when it is a sent row newer than ``old`` (by date, then sort key)."""
    if not isinstance(new, Mapping) or not isinstance(new.get("sk"), str):
        return None
    known = isinstance(old, Mapping) and isinstance(old.get("sk"), str)
    if known and (str(new.get("date") or ""), new["sk"]) <= (str(old.get("date") or ""), old["sk"]):
        return None
    return new


def _sent_body(place: str, sent: Mapping[str, Any]) -> str:
    if place == "youtube":
        text = " ".join(str(sent.get("text") or "").splitlines()).strip()[:AMOUNT_MAX]  # Google's own words
        what = text or "you money"
        return f"Money sent to your bank: Google sent {what}. It arrives in up to 7 workdays."
    amount = money_words(sent.get("amountMicros"), sent.get("currency"))
    return f"Money sent to your bank: Whop sent {amount or 'you money'}."


def getpaid_events(sk: str, old: Mapping[str, Any], new: Mapping[str, Any]) -> list[tuple[str, webpush.Message]]:
    """(dedupe key, message) for each Get paid event one ``PAYSTATE#`` change calls for. None for the first read after
    a grant: it fills the old payments quietly."""
    place = sk.removeprefix(GETPAID_PREFIX)
    if place not in PLACE_URL or not old.get("firstReadDone"):
        return []
    out: list[tuple[str, webpush.Message]] = []
    if place == "youtube":
        holds = [h for h in new.get("holds") or [] if isinstance(h, Mapping)]
        if holds and not old.get("holds"):
            since = str(new.get("holdSince") or holds[0].get("since") or "")
            message = webpush.Message(
                GETPAID_TITLE, HOLD_YOUTUBE, "getpaid-hold-youtube", PLACE_URL[place], ttl=GETPAID_TTL, urgency="high"
            )
            out.append((f"hold:youtube:{since}", message))
    else:
        hold = new.get("hold")
        if isinstance(hold, Mapping) and not isinstance(old.get("hold"), Mapping):
            message = webpush.Message(
                GETPAID_TITLE, HOLD_WHOP, "getpaid-hold-whop", PLACE_URL[place], ttl=GETPAID_TTL, urgency="high"
            )
            out.append((f"hold:whop:{hold.get('kind') or ''}:{hold.get('since') or ''}", message))
    sent = _newer(old.get("lastSent"), new.get("lastSent"))
    if sent is not None:
        message = webpush.Message(
            GETPAID_TITLE, _sent_body(place, sent), f"getpaid-sent-{place}", SENT_URL, ttl=GETPAID_TTL
        )
        out.append((f"sent:{place}:{sent['sk']}", message))
    return out


def _get_paid_on(deps: NotifyDeps, user_id: str) -> bool:
    """``notify.getPaid``, on by default. An API without §40's settings field refuses the key, so a stored value is
    read as stored when the settings shape doesn't know it yet."""
    prefs = settings.load(deps.store, user_id).get("notify") or {}
    if isinstance(prefs.get("getPaid"), bool):
        return bool(prefs["getPaid"])
    stored = (deps.store.get(db.user_pk(user_id), db.SETTINGS_SK) or {}).get("notify")
    value = stored.get("getPaid") if isinstance(stored, Mapping) else None
    return value if isinstance(value, bool) else True


def _getpaid_first_time(deps: NotifyDeps, pk: str, key: str) -> bool:
    now = deps.clock()
    item = {
        "pk": pk,
        "sk": f"NOTIFIED#getpaid#{key}",
        "type": "notified",
        "at": iso(now),
        "ttl": int((now + timedelta(days=GETPAID_DEDUPE_DAYS)).timestamp()),
    }
    try:
        deps.store.put(item, if_absent=True)
    except db.ConditionFailed:
        return False
    return True


def handle_getpaid_change(deps: NotifyDeps, sk: str, old: Mapping[str, Any], new: Mapping[str, Any]) -> list[str]:
    """Sends each Get paid notification a ``PAYSTATE#`` change calls for (under ``notify.getPaid``); returns their keys."""
    pk = str(new.get("pk") or "")
    user_id = str(new.get("userId") or (pk.removeprefix("USER#") if pk.startswith("USER#") else ""))
    if not user_id:
        return []
    found = getpaid_events(sk, old, new)
    if not found or not _get_paid_on(deps, user_id):
        return []
    subs = devices.active(deps.store, user_id)
    if not subs:
        return []
    sent = []
    for key, message in found:
        if _getpaid_first_time(deps, db.user_pk(user_id), key):
            send_to_devices(deps, user_id, message, subs)
            sent.append(key)
    return sent


def process(event: Mapping[str, Any], deps: NotifyDeps) -> dict[str, list[Any]]:
    records = [r for r in event.get("Records", []) if isinstance(r, Mapping)]
    sent = 0
    for record in records:
        data = record.get("dynamodb") or {}
        sk = str(((data.get("Keys") or {}).get("sk") or {}).get("S", ""))
        watched = sk.startswith("JOB#") or sk.startswith(CR_PREFIXES) or sk.startswith(GETPAID_PREFIX)
        if record.get("eventName") != "MODIFY" or not watched:
            continue
        old, new = data.get("OldImage"), data.get("NewImage")
        if not isinstance(old, Mapping) or not isinstance(new, Mapping):
            continue
        try:
            if sk.startswith(GETPAID_PREFIX):
                sent += len(handle_getpaid_change(deps, sk, deps.deserialize(old), deps.deserialize(new)))
            elif sk.startswith(CR_PREFIXES):
                if handle_cr_change(deps, sk, deps.deserialize(old), deps.deserialize(new)):
                    sent += 1
            elif handle_change(deps, deps.deserialize(old), deps.deserialize(new)):
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
