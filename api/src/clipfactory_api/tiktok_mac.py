"""Your Mac posts it on TikTok (docs/CONTRACTS.md §47, ADR-83): a TikTok post that waits for the owner's Mac.

The Mac helper (``mac/tiktok-helper/``, its own PR) drives TikTok Studio in a background Chrome on his Mac. Clip
Factory's side is here: the clip's one TikTok post gets the status ``mac`` (never ``queued`` or
``pending_integration``, so no path that sends posts through TikTok's API ever touches it), the helper's queue and its
claim, steps, stop and done, and the owner's Send these to my Mac, Try again and Take it back.

* A Mac post comes from Upload (``source: "upload"``) or an auto-posting run (``"auto"``), both written by
  ``posts.create_for_clip`` in the clip's own Upload transaction (``tiktok_mac``), or from Send these to my Mac
  (``"sent"``, here; ``"upload"`` when the owner tapped Post with my Mac on one row, ``now: true``): a clip with no
  TikTok post gets a new one, a Clip Factory TikTok post that failed, waits for setup or went up privately is handed
  over in place (its fields kept in ``beforeMac``). A row's tap (``now: true``) on a Mac post that already waits makes
  it an Upload tap's in place. A campaign clip never gets one (``CAMPAIGN_SKIPS``, ADR-86 round 3): the helper can't
  mark a post as Branded content yet, and Content Rewards never receives what the Mac posts.
* ``waiting`` → the helper's claim (a conditional write: one Mac, one try at a time) → ``working`` with its steps
  (``pressing`` sets ``macPressedAt``: from then on it is never claimed again by itself; a re-sent step is the job's
  beat, ``macBeatAt``) → done, through ``tiktok_self.mark_posted`` (the post becomes ``posted``, ``by: "you"``,
  ``via: "mac"``), or ``stopped`` with a reason, which the owner's Try again turns back into ``waiting`` (also a job
  that is stuck, ``mac_stuck``; after Post was pressed only once the find window is over, ``window_over``).
* Every write is conditional on the state it was read in, so a race answers 409 and never posts twice.

Items: the post's internal ``mac*`` fields (``tiktok_self.MAC_FIELDS``; public as ``Post.mac``), the clip's
``tiktokForMac`` mark (a send made its post, ``tiktok_self.MAC_MARK``), and the helper item ``USER#{id}`` /
``MACHELPER`` (``seenAt``, ``state``, ``reason``, ``version``, ``device``, ``login``, ``backlogAt``, ``holdBefore``,
``backfill``), written by its ping, plus what the server writes on it: ``needsYouClipId`` (the stop that needs the
owner) and the owner's requests (``loginRequest*``, ``resumeRequestAt``, ``letGoRequestAt``), each removed when the
helper says it did that one. No table, index or infrastructure change: every route is under ``ANY /v1/{proxy+}``.
"""

from __future__ import annotations

import contextlib
import re
import unicodedata
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from . import db, mojibake, post_preset, tiktok_self
from .clock import iso, parse
from .ids import ulid
from .posts import MAC_STATUS, new_mac_fields, posts_for_clip, public_mac
from .tiktok_self import (
    HELPER_SK,
    MAC_FIELDS,
    MAC_MARK,
    MAC_NOT_POSTING,
    MAC_TAKEN,
    MAC_WORKING,
    MADE_MARK,
    Refused,
    clear_needs_you,
    window_over,
    working_stuck,
)

Item = dict[str, Any]

STATES = ("waiting", "working", "stopped")
STEPS = ("video", "opening", "uploading", "settings", "pressing", "finding")
SOURCES = ("upload", "auto", "sent")
HELPER_STATES = ("ok", "needs_you", "paused")
# A claim whose helper sent no step for this long, and that never pressed Post, belongs to a helper that crashed.
STALE_CLAIM = timedelta(minutes=15)
# §47.8: the TikTok login the helper keeps in the Mac's Keychain, and what the owner can ask it to do with it.
LOGIN_STATES = ("saved", "none")
LOGIN_ACTIONS = ("change", "forget")
NO_HELPER = "Set up your Mac first. Then it can keep your TikTok login."
# The owner's Start my Mac again and Let them go (``POST /v1/tiktok/mac/request``): the helper does it on its next tick.
REQUESTS = {"resume": "resumeRequestAt", "let_go": "letGoRequestAt"}
PICK_REQUEST = "Pick resume or let_go."
NOT_SEEN = "Your Mac hasn't checked in yet. Set it up on your Mac."
NOT_PAUSED = "Your Mac isn't paused."
NOT_HOLDING = "Your Mac isn't holding any clips."
QUEUE_MAX = 50
SEND_MAX = 25
REASON_MAX = 200
# Done without a link looks for the post from a minute before the claim (the §42 finder).
FIND_EARLY = timedelta(minutes=1)

MAY_HAVE_POSTED = "Your Mac may have posted it already. Check your TikTok first."
PRESSED = "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok."
# Try again after Post was pressed waits for the end of the find window (``tiktok_self.MAC_FIND_WINDOW``).
MAC_STILL_LOOKING = "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later."
# A campaign clip never gets a Mac post (D1): the helper can't set TikTok's Branded content disclosure yet, and the
# Mac's done never reaches Content Rewards. The one source of these words (Upload, Try again, send, Content Rewards).
CAMPAIGN_SKIPS = "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet."
MAC_OFF = "Your Mac posting is off. Turn it on in Settings › Posting › Your Mac posts TikTok."
AUTO_OFF = "Auto-posting is off, so this one waits."
# Send these to my Mac: why a clip did not go.
NOT_FOUND = "We could not find that clip."
SEND_NOT_UPLOADED = "Upload this clip first."
SEND_CAMPAIGN = CAMPAIGN_SKIPS
SEND_TEST = "This was a Private test, so it stays off TikTok."
SEND_HAS_IT = "Your Mac already has this clip."
SEND_YOURS = "You already posted this one on TikTok."
CHANGED = "This clip just changed. Try again."

# A Clip Factory TikTok post's fields that a hand-over to the Mac replaces (kept in ``beforeMac`` for Take it back).
HANDED_OVER = (*tiktok_self.REPLACED, "postOptions", "publishHandle")
# The Clip Factory TikTok posts Send these to my Mac hands over in place: waiting for setup, failed, or private.
HANDABLE = ("pending_integration", "failed", "posted")


# --- the setting (Settings.tiktokMac, §47; validated and merged in settings.py) ---------------------------------


def is_on(settings: Mapping[str, Any]) -> bool:
    raw = settings.get("tiktokMac")
    return isinstance(raw, Mapping) and raw.get("on") is True


def auto_on(settings: Mapping[str, Any]) -> bool:
    raw = settings.get("autoPost")
    return isinstance(raw, Mapping) and raw.get("on") is True


def preset_options(settings: Mapping[str, Any]) -> Item:
    """My settings' TikTok choices (§36: Everyone, Comment, Duet and Stitch on) in the TikTok sheet's shape (§17.8):
    what every Mac post asks the Mac to set. Never Branded content: no campaign clip gets a Mac post."""
    raw = settings.get("postPreset")
    preset = raw.get("tiktok") if isinstance(raw, Mapping) else None
    tiktok = {**post_preset.DEFAULTS["tiktok"], **(preset if isinstance(preset, Mapping) else {})}
    return {
        "privacyLevel": str(tiktok.get("privacy") or "PUBLIC_TO_EVERYONE"),
        "disableComment": tiktok.get("comments") is False,
        "disableDuet": tiktok.get("duet") is False,
        "disableStitch": tiktok.get("stitch") is False,
        "brandContent": False,
        "brandOrganic": False,
    }


def setup_audited(setup: Mapping[str, Any]) -> bool:
    """TikTok's ``PlatformSetup`` (§17.4) says TikTok approved Clip Factory's public uploads: its ``app_review`` and
    ``posting_audit`` gates both ``ok``. Unknown counts as no."""
    states = {g.get("key"): g.get("state") for g in setup.get("gates") or [] if isinstance(g, Mapping)}
    return states.get("app_review") == "ok" and states.get("posting_audit") == "ok"


def tiktok_audited(store: db.Store, user_id: str) -> bool:
    """The server twin of the web's ``tiktokAudited`` (``setup_audited`` of his TikTok setup)."""
    from .oauth import setup as platform_setup

    return setup_audited(platform_setup.one_setup(store, user_id, "tiktok"))


# --- reading -----------------------------------------------------------------------------------------------------


def video_file_name(hook: str) -> str:
    """The web's ``videoFileName``: the name the helper saves the video under in Downloads."""
    base = unicodedata.normalize("NFKD", hook)
    base = re.sub(r"[^A-Za-z0-9_\s-]", "", base).strip()
    base = re.sub(r"\s+", "-", base)[:40]
    base = re.sub(r"-+$", "", base)
    return f"clip-factory-{base or 'clip'}.mp4"


def caption(clip: Mapping[str, Any]) -> str:
    """The clip's stored TikTok caption, repaired as every Clip the API returns (§5) and in NFC."""
    captions = clip.get("captions")
    text = str((captions if isinstance(captions, Mapping) else {}).get("tiktok") or "")
    return unicodedata.normalize("NFC", mojibake.repair(text))


def job(post: Mapping[str, Any], clip: Mapping[str, Any]) -> Item:
    """The ``MacJob`` the helper works from (§47.3), with its beat and, after a re-wait that followed a press, when
    Post was pressed before and when the owner tried again (the helper's never-twice guard)."""
    options = post.get("postOptions")
    choices: Mapping[str, Any] = options if isinstance(options, Mapping) else {}
    mac = public_mac(post) or {}
    out: Item = {
        "clipId": str(clip.get("clipId")),
        "postId": str(post.get("postId")),
        "hook": str(clip.get("hook") or ""),
        "caption": caption(clip),
        "fileName": video_file_name(str(clip.get("hook") or "")),
        "privacy": str(choices.get("privacyLevel") or "PUBLIC_TO_EVERYONE"),
        "comment": choices.get("disableComment") is not True,
        "duet": choices.get("disableDuet") is not True,
        "stitch": choices.get("disableStitch") is not True,
        "source": str(mac.get("source") or "upload"),
        "since": str(mac.get("since") or ""),
        "state": str(mac.get("state") or "waiting"),
        "attempt": _attempt(post),
    }
    for key in ("step", "claimedAt", "pressedAt", "beatAt"):
        if mac.get(key):
            out[key] = mac[key]
    for field, key in (("macPressedBefore", "pressedBefore"), ("macAgainAt", "againAt")):
        if post.get(field):
            out[key] = str(post[field])
    return out


def _attempt(post: Mapping[str, Any]) -> int:
    """How many claims the post had (``macAttempt``); the helper may send it back with each step, stop and done."""
    value = post.get("macAttempt")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def public_helper(item: Mapping[str, Any] | None) -> Item | None:
    """``MacHelper``: when the helper last checked in and how it is (never its device id), the clip a needs-you stop
    is on, what its plan says (``backlogAt``, ``holdBefore``, ``backfill``) and the owner's pending requests."""
    if not item or not item.get("seenAt"):
        return None
    out: Item = {"seenAt": str(item["seenAt"]), "state": str(item.get("state") or "ok")}
    for key in ("reason", "version", "needsYouClipId", "backlogAt", "holdBefore"):
        if item.get(key):
            out[key] = str(item[key])
    if item.get("backfill") is True:
        out["backfill"] = True
    if item.get("login") in LOGIN_STATES:
        out["login"] = str(item["login"])
    if item.get("loginRequestAction") in LOGIN_ACTIONS and item.get("loginRequestAt"):
        out["loginRequest"] = {"action": str(item["loginRequestAction"]), "at": str(item["loginRequestAt"])}
    if item.get("resumeRequestAt"):
        out["resumeRequest"] = {"at": str(item["resumeRequestAt"])}
    if item.get("letGoRequestAt"):
        out["letGoRequest"] = {"at": str(item["letGoRequestAt"])}
    return out


def helper_item(store: db.Store, user_id: str) -> Item | None:
    return store.get(db.user_pk(user_id), HELPER_SK)


def queue(store: db.Store, user_id: str, settings: Mapping[str, Any]) -> list[Item]:
    """The helper's queue: empty while the switch is off; else the Mac posts that wait (but an auto-posted one while
    auto-posting is off: "While it is off, nothing posts") and the ones a Mac is working on (so a restarted helper sees
    its own). Upload's first, then oldest ``since`` first (then the oldest clip), at most 50."""
    if not is_on(settings):
        return []
    auto = auto_on(settings)
    rows = [
        p
        for p in store.query_all(db.user_pk(user_id), "POST#", consistent=True)
        if p.get("type") == "post"
        and p.get("platform") == "tiktok"
        and p.get("status") == MAC_STATUS
        and p.get("macState") in ("working", "waiting")
        # While auto-posting is off, nothing auto-posted goes on ("While it is off, nothing posts"): not a waiting one,
        # and not one a Mac claimed but never pressed Post for. One whose Post was pressed stays, so the Mac can still
        # find its link.
        and (auto or p.get("macSource") != "auto" or bool(p.get("macPressedAt")))
    ]
    pk = db.user_pk(user_id)
    clip_ids = sorted({str(p.get("clipId")) for p in rows})
    found = {str(c.get("clipId")): c for c in store.batch_get((pk, db.clip_sk(i)) for i in clip_ids)} if rows else {}

    def order(p: Mapping[str, Any]) -> tuple[int, str, str, str]:
        clip = found.get(str(p.get("clipId"))) or {}
        return (
            0 if p.get("macSource") == "upload" else 1,
            str(p.get("macSince") or ""),
            str(clip.get("decidedAt") or clip.get("createdAt") or ""),
            str(p.get("clipId") or ""),
        )

    out = []
    for post in sorted(rows, key=order):
        clip = found.get(str(post.get("clipId")))
        if clip is None or clip.get("type") != "clip":
            continue
        out.append(job(post, clip))
        if len(out) >= QUEUE_MAX:
            break
    return out


def mac_row(store: db.Store, clip: Mapping[str, Any]) -> tuple[Item, list[Item]]:
    """The clip's TikTok post when it is a Mac post (and all its posts), else ``Refused(MAC_NOT_POSTING)``."""
    rows = posts_for_clip(store, str(clip["userId"]), str(clip["clipId"]), consistent=True)
    row = tiktok_self.tiktok_row(rows)
    if row is None or row.get("status") != MAC_STATUS:
        raise Refused(MAC_NOT_POSTING)
    return row, rows


def _reason(raw: Any) -> str:
    text = " ".join(str(raw or "").split())
    return text[:REASON_MAX].rstrip()


def _write(store: db.Store, row: Mapping[str, Any], request: Mapping[str, Any]) -> Item:
    """One conditional write of a Mac post; returns the post as written. ``db.ConditionFailed`` when it changed."""
    store.transact(updates=[request])
    return store.get(str(row["pk"]), str(row["sk"])) or dict(row)


def _go_now(store: db.Store, row: Mapping[str, Any]) -> None:
    """A waiting Mac post becomes an Upload tap's (``macSource: "upload"``): the owner tapped Post with my Mac or Try
    again on its row (``now: true``), so the Mac posts it at once and first instead of after the next auto-posting run
    (``sent``) or with the run's own clips (``auto``, also while auto-posting is off: he tapped it). It keeps its place
    (``since``). One conditional write, only while it still waits; ``db.ConditionFailed`` when it changed (the Mac
    claimed it meanwhile). Nothing to write when it already is one."""
    if row.get("macSource") == "upload":
        return
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        {"macSource": "upload"},
        expect_in={"status": [MAC_STATUS], "macState": ["waiting"]},
    )
    store.transact(updates=[request])


# --- the helper's routes (§47.3) ----------------------------------------------------------------------------------


def ping(
    store: db.Store,
    user_id: str,
    *,
    state: str,
    device: str,
    reason: str | None,
    version: str | None,
    now: datetime,
    login: str | None = None,
    login_done: str | None = None,
    backlog_at: str | None = None,
    hold_before: str | None = None,
    backfill: bool = False,
    resume_done: str | None = None,
    let_go_done: str | None = None,
) -> None:
    """The helper checks in: the ``MACHELPER`` item says when, how it is (``ok``, ``needs_you``, ``paused``) and why,
    whether a TikTok login is kept in the Mac's Keychain (``login``: ``saved`` | ``none``, §47.8), and what its plan
    says (§47.3): when the first backlog clip goes (``backlog_at``), the auto-posting clips it holds (made before
    ``hold_before``) and a backfill (``backfill``). Each of those three is removed by a ping without it, and
    ``needsYouClipId`` by a ping whose state is not ``needs_you``. The owner's pending requests (login, resume, let go)
    stay until the helper says it handled that one (``login_done``, ``resume_done``, ``let_go_done`` = its ``at``): a
    newer request meanwhile stays."""
    current = helper_item(store, user_id)
    fields: Item = {"type": "machelper", "userId": user_id, "seenAt": iso(now), "state": state, "device": device}
    if reason:
        fields["reason"] = _reason(reason)
    if version:
        fields["version"] = version
    if login in LOGIN_STATES:
        fields["login"] = login
    plan: Item = {"backlogAt": backlog_at, "holdBefore": hold_before, "backfill": True if backfill else None}
    fields.update({k: v for k, v in plan.items() if v is not None})
    if current is None:
        store.put({"pk": db.user_pk(user_id), "sk": HELPER_SK, **fields})
    else:
        gone = [k for k, v in plan.items() if v is None]
        if not reason:
            gone.append("reason")
        if state != "needs_you":
            gone.append("needsYouClipId")
        store.update(db.user_pk(user_id), HELPER_SK, fields, remove=[k for k in gone if k in current])
    for done, names in (
        (login_done, ("loginRequestAt", "loginRequestAction")),
        (resume_done, ("resumeRequestAt",)),
        (let_go_done, ("letGoRequestAt",)),
    ):
        if done:
            _request_done(store, user_id, done, names)


def _request_done(store: db.Store, user_id: str, done: str, names: tuple[str, ...]) -> None:
    """Removes the owner's request (its ``at`` is ``names[0]``) only while it is still the one the helper did."""
    placeholders = {f"#r{i}": name for i, name in enumerate(names)}
    with contextlib.suppress(db.ConditionFailed):  # a newer request came meanwhile: it stays
        store.update_expr(
            db.user_pk(user_id),
            HELPER_SK,
            "REMOVE " + ", ".join(placeholders),
            condition="#r0 = :done",
            names=placeholders,
            values={":done": done},
        )


def login_request(store: db.Store, user_id: str, action: str, now: datetime) -> Item:
    """The owner's Change TikTok login / Forget TikTok login (§47.8): the helper does it the next time it checks in.
    Returns the helper item. Refused when no Mac ever checked in."""
    if helper_item(store, user_id) is None:
        raise Refused(NO_HELPER)
    return store.update(db.user_pk(user_id), HELPER_SK, {"loginRequestAction": action, "loginRequestAt": iso(now)})


def request(store: db.Store, user_id: str, action: str, now: datetime) -> Item:
    """The owner's Start my Mac again (``resume``) or Let them go (``let_go``, §47.3): the helper does it on its next
    tick and says so in its ping (``resumeDone`` / ``letGoDone``). One conditional write, so a Mac that is no longer
    paused, or no longer holds clips, is refused (``Refused``). Returns the helper item."""
    if action not in REQUESTS:
        raise Refused(PICK_REQUEST, 400)
    item = helper_item(store, user_id)
    if item is None:
        raise Refused(NOT_SEEN)
    if action == "resume":
        condition, values, refusal = "#st = :paused", {":paused": "paused"}, NOT_PAUSED
        names = {"#st": "state", "#at": REQUESTS[action]}
    else:
        condition, values, refusal = "attribute_exists(#hb)", {}, NOT_HOLDING
        names = {"#hb": "holdBefore", "#at": REQUESTS[action]}
    try:
        return store.update_expr(
            db.user_pk(user_id),
            HELPER_SK,
            "SET #at = :at",
            condition=condition,
            names=names,
            values={**values, ":at": iso(now)},
        )
    except db.ConditionFailed:
        raise Refused(refusal) from None


def claim(store: db.Store, clip: Mapping[str, Any], device: str, now: datetime, settings: Mapping[str, Any]) -> Item:
    """The helper takes a Mac post: one conditional write, so one Mac and one try at a time. It takes a waiting post
    that has no ``macPressedAt``, or a working one whose helper crashed (no beat for ``STALE_CLAIM``) and that never
    pressed Post. A post whose helper pressed Post is never claimed again by itself, whatever its state: it waits for
    the owner (never twice). A claim keeps ``macPressedBefore`` and ``macAgainAt`` for the helper's own guard."""
    row, _rows = mac_row(store, clip)
    if not is_on(settings):
        raise Refused(MAC_OFF)
    if row.get("macSource") == "auto" and not auto_on(settings):
        raise Refused(AUTO_OFF)
    condition = db.Condition(
        "(#mState = :mWaiting AND attribute_not_exists(#mPressed))"
        " OR (#mState = :mWorking AND attribute_not_exists(#mPressed) AND #mBeat < :mStale)",
        {"#mState": "macState", "#mPressed": "macPressedAt", "#mBeat": "macBeatAt"},
        {":mWaiting": "waiting", ":mWorking": "working", ":mStale": iso(now - STALE_CLAIM)},
    )
    fields: Item = {
        "macState": "working",
        "macClaimedAt": iso(now),
        "macDevice": device,
        "macBeatAt": iso(now),
        "macStep": "video",
        "macAttempt": _attempt(row) + 1,
    }
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        remove=[k for k in ("macStoppedAt", "macReason") if k in row],
        expect_in={"status": [MAC_STATUS]},
        also=condition,
    )
    try:
        return _write(store, row, request)
    except db.ConditionFailed:
        raise Refused(MAC_TAKEN) from None


def _own(row: Mapping[str, Any], device: str, states: Iterable[str], attempt: int | None = None) -> None:
    if not tiktok_self.owns(row, device, tuple(states), attempt):
        raise Refused(MAC_TAKEN)


def _claim_of(device: str, states: list[str], attempt: int | None) -> dict[str, list[Any]]:
    """The write's condition: still this device's claim (and attempt, when the helper sent it), in these states."""
    expect: dict[str, list[Any]] = {"status": [MAC_STATUS], "macState": states, "macDevice": [device]}
    if attempt is not None:
        expect["macAttempt"] = [attempt]
    return expect


def step(
    store: db.Store,
    clip: Mapping[str, Any],
    device: str,
    name: str,
    now: datetime,
    *,
    settings: Mapping[str, Any],
    attempt: int | None = None,
) -> tuple[Item, bool]:
    """The helper's progress: only from the device that claimed it, while it works on it. Every step sets
    ``macBeatAt``, so the same step sent again is the job's beat (§47.3: the helper re-sends it every minute while it
    works on the job). ``pressing`` also sets ``macPressedAt`` the first time, the point of no return. While the
    switch is off, nothing before Post goes on (the owner's "Your Mac stops at once"); after Post the helper may still
    look for the link. Returns the post as written and whether this step pressed Post for the first time."""
    row, _rows = mac_row(store, clip)
    _own(row, device, ("working",), attempt)
    if not is_on(settings) and not row.get("macPressedAt"):
        raise Refused(MAC_OFF)
    if row.get("macSource") == "auto" and not row.get("macPressedAt") and not auto_on(settings):
        # Auto-posting was turned off while the Mac worked on it, before Post: it goes back to waiting (so the owner
        # sees "Waiting · auto-posting is off") and nothing more happens until auto-posting is on again.
        back = db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            {"macState": "waiting"},
            remove=[k for k in ("macStep", "macClaimedAt", "macDevice", "macBeatAt") if k in row],
            expect_in=_claim_of(device, ["working"], attempt),
            expect_absent=["macPressedAt"],
        )
        try:
            store.transact(updates=[back])
        except db.ConditionFailed:
            raise Refused(MAC_TAKEN) from None
        raise Refused(AUTO_OFF)
    fields: Item = {"macStep": name, "macBeatAt": iso(now)}
    pressed = name == "pressing" and not row.get("macPressedAt")
    if pressed:
        fields["macPressedAt"] = iso(now)
    update = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        expect_in=_claim_of(device, ["working"], attempt),
    )
    try:
        return _write(store, row, update), pressed
    except db.ConditionFailed:
        raise Refused(MAC_TAKEN) from None


def stopped(
    store: db.Store,
    clip: Mapping[str, Any],
    device: str,
    reason: str,
    now: datetime,
    *,
    needs_you: bool = False,
    attempt: int | None = None,
) -> Item:
    """The helper stopped instead of guessing. The post says why (at most 200 characters); once it pressed Post the
    reason is always ``PRESSED`` (only the owner knows whether it is on TikTok). ``needs_you`` also puts the helper
    item in ``needs_you`` with that reason and this clip (``needsYouClipId``: Settings and the rows link to it)."""
    row, _rows = mac_row(store, clip)
    _own(row, device, ("working", "stopped"), attempt)
    said = _reason(reason)
    fields: Item = {
        "macState": "stopped",
        "macStoppedAt": iso(now),
        "macReason": PRESSED if row.get("macPressedAt") else said,
    }
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        expect_in=_claim_of(device, ["working", "stopped"], attempt),
    )
    try:
        written = _write(store, row, request)
    except db.ConditionFailed:
        raise Refused(MAC_TAKEN) from None
    if needs_you:
        store.update_expr(
            db.user_pk(str(clip["userId"])),
            HELPER_SK,
            "SET #st = :st, #re = :re, #se = :se, #de = :de, #ty = :ty, #us = :us, #nc = :nc",
            names={
                "#st": "state",
                "#re": "reason",
                "#se": "seenAt",
                "#de": "device",
                "#ty": "type",
                "#us": "userId",
                "#nc": "needsYouClipId",
            },
            values={
                ":st": "needs_you",
                ":re": said,
                ":se": iso(now),
                ":de": device,
                ":ty": "machelper",
                ":us": str(clip["userId"]),
                ":nc": str(clip["clipId"]),
            },
        )
    return written


# --- the owner's routes (§47.2) -----------------------------------------------------------------------------------


def retry(store: db.Store, clip: Mapping[str, Any], *, not_on_tiktok: bool, at: datetime, now: bool = False) -> None:
    """The owner's Try again (§47.3, at ``at``): a stopped Mac post, or a stuck one (``working_stuck``), waits for the
    Mac again, keeping its place (``since``). A post the Mac still works on is refused (``MAC_WORKING``). After the Mac
    pressed Post, only when he says it is not on TikTok (``not_on_tiktok``) and only once the find window is over
    (``window_over``, else ``MAC_STILL_LOOKING``): the press moves to ``macPressedBefore`` and ``macAgainAt`` says when
    he tried again, so the helper's never-twice guard can tell this re-wait from a lost press. Without ``now`` a post
    already waiting is left as it is. One write, conditional on the post as read (a stopped one still stopped, a stuck
    one the same claim, beat and press: a new claim or beat meanwhile answers ``CHANGED``); then the helper item goes
    back to ``ok`` when it needed him.

    ``now`` (a row's Try again or Post with my Mac) also makes it an Upload tap's (``macSource: "upload"``), so the Mac
    posts it at once and first instead of waiting for the next auto-posting run (``sent``). That holds for a post that
    already waits too (``_go_now``: the waiting row's own button), and for an auto-posting run's post (``auto``), also
    while auto-posting is off: the owner tapped it himself, so "while it is off, nothing posts" (which holds back what
    auto-posting picked) no longer applies to it."""
    row, _rows = mac_row(store, clip)
    state = row.get("macState")
    stuck = working_stuck(store, str(clip["userId"]), row, at)
    if state == "working" and not stuck:
        raise Refused(MAC_WORKING)
    if state not in ("stopped", "working"):
        if now and state == "waiting":
            try:
                _go_now(store, row)
            except db.ConditionFailed:
                raise Refused(CHANGED) from None
        return
    pressed = row.get("macPressedAt")
    if pressed and not not_on_tiktok:
        raise Refused(MAY_HAVE_POSTED)
    if pressed and not window_over(row, at):
        raise Refused(MAC_STILL_LOOKING)
    fields: Item = {"macState": "waiting", "macAgainAt": iso(at)}
    cleared = ["macStep", "macClaimedAt", "macStoppedAt", "macReason"]
    if pressed:
        fields["macPressedBefore"] = str(pressed)
        cleared.append("macPressedAt")
    if stuck:
        cleared += ["macDevice", "macBeatAt"]  # the stuck claim is gone: the Mac claims it afresh
    if now:
        fields["macSource"] = "upload"
    expect: dict[str, list[Any]] = {"status": [MAC_STATUS], "macState": [str(state)]}
    same = ("macPressedAt", "macClaimedAt", "macBeatAt") if stuck else ("macPressedAt",)
    for key in same:
        if row.get(key):
            expect[key] = [str(row[key])]
    update = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        remove=[k for k in cleared if k in row],
        expect_in=expect,
    )
    try:
        _write(store, row, update)
    except db.ConditionFailed:
        raise Refused(CHANGED) from None
    clear_needs_you(store, str(clip["userId"]))


def take_back(store: db.Store, clip: Mapping[str, Any]) -> None:
    """Take it back (kept for older apps; the web no longer offers it): only while the Mac post waits or stopped, and
    never once the Mac pressed Post (it may be on TikTok: the owner's ways out are his It's on TikTok, or Try again
    once it's not on TikTok). A post made for the Mac is deleted and leaves ``postIds`` (and ``tiktokForMac``); a Clip
    Factory post that was handed over gets its fields back (``beforeMac``). The post and the clip (its settle rule,
    §14.5) are one transaction, conditional on the post as read; a clip that changed meanwhile (a flow settled it) is
    read again, at most 3 times."""
    for _ in range(3):
        row, rows = mac_row(store, clip)
        _can_take_back(row)
        others = [r for r in rows if r is not row]
        try:
            store.transact(**_take_back_writes(clip, row, others))
            return
        except db.ConditionFailed:
            fresh = store.get(db.user_pk(str(clip["userId"])), db.clip_sk(str(clip["clipId"])))
            if fresh is None:
                raise Refused(CHANGED) from None
            clip = fresh
    raise Refused(CHANGED)


def _can_take_back(row: Mapping[str, Any]) -> None:
    if row.get("macState") == "working":
        raise Refused(MAC_WORKING)
    if row.get("macPressedAt"):
        raise Refused(MAY_HAVE_POSTED)


def _take_back_writes(clip: Mapping[str, Any], row: Mapping[str, Any], others: list[Item]) -> dict[str, Any]:
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    status = str(clip.get("status"))
    still = {"status": [MAC_STATUS], "macState": ["waiting", "stopped"]}
    if row.get("madeForMac") or not isinstance(row.get("beforeMac"), Mapping):
        ids = [i for i in tiktok_self._post_ids(clip, [*others, dict(row)]) if i != str(row["postId"])]
        clip_update = db.update_request(
            db.user_pk(user_id),
            db.clip_sk(clip_id),
            {"postIds": ids, **tiktok_self._clip_status(status, others, now_posted=False)},
            remove=[MAC_MARK] if clip.get(MAC_MARK) else [],
            expect_in={"status": [status]},
        )
        post_delete = db.delete_request(str(row["pk"]), str(row["sk"]), expect_in=still, expect_absent=["macPressedAt"])
        return {"updates": [clip_update], "deletes": [post_delete]}
    before = row["beforeMac"]
    back = {k: v for k, v in before.items() if k in HANDED_OVER}
    back.setdefault("status", "failed")
    remove = [k for k in MAC_FIELDS if k in row]
    remove += [k for k in HANDED_OVER if k in row and k not in back]
    updates = [
        db.update_request(
            str(row["pk"]), str(row["sk"]), back, remove=remove, expect_in=still, expect_absent=["macPressedAt"]
        )
    ]
    restored = {**{k: v for k, v in row.items() if k not in remove}, **back}
    clip_fields = tiktok_self._clip_status(status, [*others, restored], now_posted=False)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    return {"updates": updates}


def send(
    store: db.Store,
    user_id: str,
    clip: Mapping[str, Any] | None,
    settings: Mapping[str, Any],
    now: datetime,
    *,
    is_campaign: bool,
    source: str = "sent",
) -> str | None:
    """Send this clip to the Mac (Send these to my Mac): None when it went, else why not. It goes when it is not on
    TikTok yet (§42.1): uploaded, its TikTok not out for everyone, not by him, not uploading (``queued``) and not a
    Mac post already; never a campaign clip (``is_campaign``: ``SEND_CAMPAIGN``, nothing written) or a Private test. A
    clip without a TikTok post gets a new Mac post (``madeForMac``, its id in ``postIds`` and in the clip's
    ``tiktokForMac``, written only while neither that mark nor ``tiktokByYou`` is there: two sends, or a send and his
    It's on TikTok, never make two posts). A Clip Factory TikTok post that waits for setup, failed or went up
    privately is handed over in place, its fields kept in ``beforeMac``. Its options are My settings' (Everyone,
    Comment, Duet and Stitch on: ``preset_options``).

    ``source`` is the post's ``macSource``: ``sent`` (the backlog, one after each auto-posting run) or ``upload``
    (the owner's Post with my Mac on one row, ``now: true``: at once and first, as an Upload tap). With ``upload`` a
    Mac post that already waits (``sent`` or ``auto``) goes too: it becomes an Upload tap's in place (``_go_now``), and
    it counts as sent. Every other Mac post (working, stopped) is still ``SEND_HAS_IT``: Try again is its way."""
    if clip is None or clip.get("type") != "clip":
        return NOT_FOUND
    status = clip.get("status")
    if status not in tiktok_self.DECIDED:
        return SEND_NOT_UPLOADED
    if not clip.get("postsCreated"):
        return tiktok_self.STILL_STARTING
    if is_campaign:
        return SEND_CAMPAIGN
    if clip.get("autoTest") == "private":
        return SEND_TEST
    clip_id = str(clip["clipId"])
    rows = posts_for_clip(store, user_id, clip_id, consistent=True)
    row = tiktok_self.tiktok_row(rows)
    at = iso(now)
    options = preset_options(settings)
    if row is None:
        post_id = ulid()
        item: Item = {
            "pk": db.user_pk(user_id),
            "sk": db.post_sk(post_id),
            "gsi1pk": f"CLIP#{clip_id}",
            "gsi1sk": "POST#tiktok",
            "type": "post",
            "userId": user_id,
            "createdAt": at,
            "flowRun": int(clip.get("flowRun") or 1),
            "postId": post_id,
            "clipId": clip_id,
            "platform": "tiktok",
            **new_mac_fields(source, at),
            "madeForMac": True,
            "postOptions": options,
        }
        fields: Item = {
            "postIds": [*tiktok_self._post_ids(clip, rows), post_id],
            MAC_MARK: post_id,
            **tiktok_self._clip_status(status, [*rows, item], now_posted=False),
        }
        update = db.update_request(
            db.user_pk(user_id),
            db.clip_sk(clip_id),
            fields,
            expect_in={"status": [str(status)]},
            expect_absent=[MADE_MARK, MAC_MARK],
        )
        try:
            store.transact(puts=[item], updates=[update])
        except db.ConditionFailed:
            return CHANGED
        return None
    if source == "upload" and row.get("status") == MAC_STATUS and row.get("macState") == "waiting":
        try:
            _go_now(store, row)
        except db.ConditionFailed:
            return CHANGED
        return None
    refusal = _not_handable(row)
    if refusal:
        return refusal
    before = {k: row[k] for k in HANDED_OVER if k in row}
    handed = {**new_mac_fields(source, at), "beforeMac": before, "postOptions": options}
    remove = [k for k in HANDED_OVER if k in row and k not in handed]
    updates = [
        db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            handed,
            remove=remove,
            expect_in={"status": [str(row.get("status"))]},
            expect_absent=["by", "macState"],
        )
    ]
    others = [r for r in rows if r is not row]
    clip_fields = tiktok_self._clip_status(status, [*others, {**row, **handed}], now_posted=False)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    try:
        store.transact(updates=updates)
    except db.ConditionFailed:
        return CHANGED
    return None


def _not_handable(row: Mapping[str, Any]) -> str | None:
    status = row.get("status")
    if status == MAC_STATUS:
        return SEND_HAS_IT
    if row.get("by") == "you":
        return SEND_YOURS
    if status == "queued":
        return tiktok_self.STILL_UPLOADING
    if status == "posted" and row.get("privacy") == "public":
        return tiktok_self.ALREADY_PUBLIC
    if status not in HANDABLE:
        return SEND_HAS_IT
    return None


def check_done(row: Mapping[str, Any], device: str, attempt: int | None = None) -> None:
    """The Mac's done comes from the device that claimed the post, while it works on it or after it stopped; a post
    it already finished (``via: "mac"``) is answered again. Anything else is ``Refused`` (``mark_posted`` checks the
    same in its write)."""
    if row.get("status") == MAC_STATUS:
        _own(row, device, ("working", "stopped"), attempt)
    elif row.get("via") != "mac":
        raise Refused(MAC_NOT_POSTING)


def since_for_finder(post: Mapping[str, Any]) -> str | None:
    """Done without a link looks for the post from a minute before the claim (the §42 finder's ``since``)."""
    claimed = parse(post.get("macClaimedAt"))
    return iso(claimed - FIND_EARLY) if claimed is not None else None
