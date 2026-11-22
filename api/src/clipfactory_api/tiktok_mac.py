"""Your Mac posts it on TikTok (docs/CONTRACTS.md §47, ADR-83): a TikTok post that waits for the owner's Mac.

The Mac helper (``mac/tiktok-helper/``, its own PR) drives TikTok Studio in a background Chrome on his Mac. Clip
Factory's side is here: the clip's one TikTok post gets the status ``mac`` (never ``queued`` or
``pending_integration``, so no path that sends posts through TikTok's API ever touches it), the helper's queue and its
claim, steps, stop and done, and the owner's Send these to my Mac, Try again and Take it back.

* A Mac post comes from Upload (``source: "upload"``) or an auto-posting run (``"auto"``), both written by
  ``posts.create_for_clip`` in the clip's own Upload transaction (``tiktok_mac``), or from Send these to my Mac
  (``"sent"``, here): a clip with no TikTok post gets a new one, a Clip Factory TikTok post that failed, waits for
  setup or went up privately is handed over in place (its fields kept in ``beforeMac``).
* ``waiting`` → the helper's claim (a conditional write: one Mac, one try at a time) → ``working`` with its steps
  (``pressing`` sets ``macPressedAt``: from then on it is never claimed again by itself) → done, through
  ``tiktok_self.mark_posted`` (the post becomes ``posted``, ``by: "you"``, ``via: "mac"``), or ``stopped`` with a
  reason, which the owner's Try again turns back into ``waiting``.
* Every write is conditional on the state it was read in, so a race answers 409 and never posts twice.

Items: the post's internal ``mac*`` fields (``tiktok_self.MAC_FIELDS``; public as ``Post.mac``), the clip's
``tiktokForMac`` mark (a send made its post, ``tiktok_self.MAC_MARK``), and the helper item ``USER#{id}`` /
``MACHELPER`` (``seenAt``, ``state``, ``reason``, ``version``, ``device``), written by its ping. No table, index or
infrastructure change: every route is under ``ANY /v1/{proxy+}``.
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
from .tiktok_self import MAC_FIELDS, MAC_MARK, MAC_NOT_POSTING, MAC_TAKEN, MAC_WORKING, MADE_MARK, Refused

Item = dict[str, Any]

STATES = ("waiting", "working", "stopped")
STEPS = ("video", "opening", "uploading", "settings", "pressing", "finding")
SOURCES = ("upload", "auto", "sent")
HELPER_STATES = ("ok", "needs_you", "paused")
HELPER_SK = "MACHELPER"
# A claim whose helper sent no step for this long, and that never pressed Post, belongs to a helper that crashed.
STALE_CLAIM = timedelta(minutes=15)
QUEUE_MAX = 50
SEND_MAX = 25
REASON_MAX = 200
# Done without a link looks for the post from a minute before the claim (the §42 finder).
FIND_EARLY = timedelta(minutes=1)

MAY_HAVE_POSTED = "Your Mac may have posted it already. Check your TikTok first."
PRESSED = "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it."
MAC_OFF = "Your Mac posting is off. Turn it on in Settings › Posting › Your Mac posts TikTok."
AUTO_OFF = "Auto-posting is off, so this one waits."
# Send these to my Mac: why a clip did not go.
NOT_FOUND = "We could not find that clip."
SEND_NOT_UPLOADED = "Upload this clip first."
SEND_CAMPAIGN = "Campaign clips go on TikTok by hand. Tap Post it yourself."
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
    what an auto-posted or sent Mac post asks the Mac to set."""
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


def tiktok_audited(store: db.Store, user_id: str) -> bool:
    """The server twin of the web's ``tiktokAudited``: TikTok approved Clip Factory's public uploads (its
    ``app_review`` and ``posting_audit`` gates both ``ok``). Unknown counts as no."""
    from .oauth import setup as platform_setup

    setup = platform_setup.one_setup(store, user_id, "tiktok")
    states = {g.get("key"): g.get("state") for g in setup.get("gates") or []}
    return states.get("app_review") == "ok" and states.get("posting_audit") == "ok"


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
    """The ``MacJob`` the helper works from (§47.3)."""
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
    }
    for key in ("step", "claimedAt", "pressedAt"):
        if mac.get(key):
            out[key] = mac[key]
    return out


def public_helper(item: Mapping[str, Any] | None) -> Item | None:
    """``MacHelper``: when the helper last checked in and how it is (never its device id)."""
    if not item or not item.get("seenAt"):
        return None
    out: Item = {"seenAt": str(item["seenAt"]), "state": str(item.get("state") or "ok")}
    for key in ("reason", "version"):
        if item.get(key):
            out[key] = str(item[key])
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
        and (
            p.get("macState") == "working"
            or (p.get("macState") == "waiting" and (auto or p.get("macSource") != "auto"))
        )
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


# --- the helper's routes (§47.3) ----------------------------------------------------------------------------------


def ping(
    store: db.Store, user_id: str, *, state: str, device: str, reason: str | None, version: str | None, now: datetime
) -> None:
    """The helper checks in: the ``MACHELPER`` item says when, how it is (``ok``, ``needs_you``, ``paused``) and why."""
    item: Item = {
        "pk": db.user_pk(user_id),
        "sk": HELPER_SK,
        "type": "machelper",
        "userId": user_id,
        "seenAt": iso(now),
        "state": state,
        "device": device,
    }
    if reason:
        item["reason"] = _reason(reason)
    if version:
        item["version"] = version
    store.put(item)


def claim(store: db.Store, clip: Mapping[str, Any], device: str, now: datetime, settings: Mapping[str, Any]) -> Item:
    """The helper takes a Mac post: one conditional write, so one Mac and one try at a time. It takes a waiting post,
    or a working one whose helper crashed (no step for 15 minutes) and that never pressed Post. A post whose helper
    pressed Post is never claimed again by itself: it waits for the owner (never twice)."""
    row, _rows = mac_row(store, clip)
    if not is_on(settings):
        raise Refused(MAC_OFF)
    if row.get("macSource") == "auto" and row.get("macState") == "waiting" and not auto_on(settings):
        raise Refused(AUTO_OFF)
    condition = db.Condition(
        "#mState = :mWaiting OR (#mState = :mWorking AND attribute_not_exists(#mPressed) AND #mBeat < :mStale)",
        {"#mState": "macState", "#mPressed": "macPressedAt", "#mBeat": "macBeatAt"},
        {":mWaiting": "waiting", ":mWorking": "working", ":mStale": iso(now - STALE_CLAIM)},
    )
    attempt = row.get("macAttempt")
    fields: Item = {
        "macState": "working",
        "macClaimedAt": iso(now),
        "macDevice": device,
        "macBeatAt": iso(now),
        "macStep": "video",
        "macAttempt": (int(attempt) if isinstance(attempt, int) and not isinstance(attempt, bool) else 0) + 1,
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


def _own(row: Mapping[str, Any], device: str, states: Iterable[str]) -> None:
    if row.get("macDevice") != device or row.get("macState") not in tuple(states):
        raise Refused(MAC_TAKEN)


def step(
    store: db.Store, clip: Mapping[str, Any], device: str, name: str, now: datetime, *, settings: Mapping[str, Any]
) -> Item:
    """The helper's progress: only from the device that claimed it, while it works on it. ``pressing`` also sets
    ``macPressedAt``, the point of no return. While the switch is off, nothing before Post goes on (the owner's "Your
    Mac stops at once"); after Post the helper may still look for the link."""
    row, _rows = mac_row(store, clip)
    _own(row, device, ("working",))
    if not is_on(settings) and not row.get("macPressedAt"):
        raise Refused(MAC_OFF)
    fields: Item = {"macStep": name, "macBeatAt": iso(now)}
    if name == "pressing" and not row.get("macPressedAt"):
        fields["macPressedAt"] = iso(now)
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        expect_in={"status": [MAC_STATUS], "macState": ["working"], "macDevice": [device]},
    )
    try:
        return _write(store, row, request)
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
) -> Item:
    """The helper stopped instead of guessing. The post says why (at most 200 characters); once it pressed Post the
    reason is always ``PRESSED`` (only the owner knows whether it is on TikTok). ``needs_you`` also puts the helper
    item in ``needs_you`` with that reason."""
    row, _rows = mac_row(store, clip)
    _own(row, device, ("working", "stopped"))
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
        expect_in={"status": [MAC_STATUS], "macState": ["working", "stopped"], "macDevice": [device]},
    )
    try:
        written = _write(store, row, request)
    except db.ConditionFailed:
        raise Refused(MAC_TAKEN) from None
    if needs_you:
        store.update_expr(
            db.user_pk(str(clip["userId"])),
            HELPER_SK,
            "SET #st = :st, #re = :re, #se = :se, #de = :de, #ty = :ty, #us = :us",
            names={
                "#st": "state",
                "#re": "reason",
                "#se": "seenAt",
                "#de": "device",
                "#ty": "type",
                "#us": "userId",
            },
            values={
                ":st": "needs_you",
                ":re": said,
                ":se": iso(now),
                ":de": device,
                ":ty": "machelper",
                ":us": str(clip["userId"]),
            },
        )
    return written


# --- the owner's routes (§47.2) -----------------------------------------------------------------------------------


def retry(store: db.Store, clip: Mapping[str, Any], *, not_on_tiktok: bool) -> None:
    """The owner's Try again on a stopped Mac post: it waits for the Mac again, keeping its place (``since``). After
    the Mac pressed Post, only when he says it is not on TikTok (``not_on_tiktok``, which clears ``macPressedAt``).
    A post already waiting is left as it is. The helper item goes back to ``ok`` when it needed him."""
    row, _rows = mac_row(store, clip)
    state = row.get("macState")
    if state == "working":
        raise Refused(MAC_WORKING)
    if state != "stopped":
        return
    if row.get("macPressedAt") and not not_on_tiktok:
        raise Refused(MAY_HAVE_POSTED)
    cleared = ["macStep", "macClaimedAt", "macStoppedAt", "macReason"]
    if not_on_tiktok:
        cleared.append("macPressedAt")
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        {"macState": "waiting"},
        remove=[k for k in cleared if k in row],
        expect_in={"status": [MAC_STATUS], "macState": ["stopped"]},
    )
    try:
        _write(store, row, request)
    except db.ConditionFailed:
        raise Refused(CHANGED) from None
    with contextlib.suppress(db.ConditionFailed):  # it did not need him
        store.update_expr(
            db.user_pk(str(clip["userId"])),
            HELPER_SK,
            "SET #st = :ok REMOVE #re",
            condition="#st = :nu",
            names={"#st": "state", "#re": "reason"},
            values={":ok": "ok", ":nu": "needs_you"},
        )


def take_back(store: db.Store, clip: Mapping[str, Any]) -> None:
    """Take it back (Post it yourself instead): only while the Mac post waits or stopped (a conditional write). A post
    made for the Mac is deleted and leaves ``postIds``; a Clip Factory post that was handed over gets its fields back
    (``beforeMac``). The clip's status follows the clip flow's settle rule (§14.5)."""
    row, rows = mac_row(store, clip)
    if row.get("macState") == "working":
        raise Refused(MAC_WORKING)
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    others = [r for r in rows if r is not row]
    if row.get("madeForMac") or not isinstance(row.get("beforeMac"), Mapping):
        if not store.delete_if(
            str(row["pk"]), str(row["sk"]), {"status": [MAC_STATUS], "macState": ["waiting", "stopped"]}
        ):
            fresh = tiktok_self.tiktok_row(posts_for_clip(store, user_id, clip_id, consistent=True))
            if fresh is not None and fresh.get("status") == MAC_STATUS and fresh.get("macState") == "working":
                raise Refused(MAC_WORKING)
            raise Refused(CHANGED)
        _forget(store, clip, str(row["postId"]), others)
        return
    before = row["beforeMac"]
    back = {k: v for k, v in before.items() if k in HANDED_OVER}
    back.setdefault("status", "failed")
    remove = [k for k in MAC_FIELDS if k in row]
    remove += [k for k in HANDED_OVER if k in row and k not in back]
    updates = [
        db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            back,
            remove=remove,
            expect_in={"status": [MAC_STATUS], "macState": ["waiting", "stopped"]},
        )
    ]
    status = str(clip.get("status"))
    restored = {**{k: v for k, v in row.items() if k not in remove}, **back}
    clip_fields = tiktok_self._clip_status(status, [*others, restored], now_posted=False)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    try:
        store.transact(updates=updates)
    except db.ConditionFailed:
        fresh = tiktok_self.tiktok_row(posts_for_clip(store, user_id, clip_id, consistent=True))
        if fresh is not None and fresh.get("status") == MAC_STATUS and fresh.get("macState") == "working":
            raise Refused(MAC_WORKING) from None
        raise Refused(CHANGED) from None


def _forget(store: db.Store, clip: Mapping[str, Any], post_id: str, others: list[Item]) -> None:
    """The clip after its Mac post was deleted: off ``postIds``, without the send's mark, settled again. Read again
    and written once more when the clip changed meanwhile (a deleted post the list still named is never read)."""
    pk, sk = db.user_pk(str(clip["userId"])), db.clip_sk(str(clip["clipId"]))
    current: Mapping[str, Any] | None = clip
    for _ in range(3):
        if current is None:
            return
        status = str(current.get("status"))
        ids = [i for i in tiktok_self._post_ids(current, [*others]) if i != post_id]
        fields: Item = {"postIds": ids, **tiktok_self._clip_status(status, others, now_posted=False)}
        try:
            store.update(
                pk,
                sk,
                fields,
                remove=[MAC_MARK] if current.get(MAC_MARK) else [],
                expect_in={"status": [status]},
            )
            return
        except db.ConditionFailed:
            current = store.get(pk, sk)


def send(
    store: db.Store,
    user_id: str,
    clip: Mapping[str, Any] | None,
    settings: Mapping[str, Any],
    now: datetime,
    *,
    is_campaign: bool,
) -> str | None:
    """Send this clip to the Mac (Send these to my Mac): None when it went, else why not. It goes when Post it
    yourself would show (§42.1): uploaded, its TikTok not out for everyone, not by him, not uploading (``queued``) and
    not a Mac post already; never a campaign clip or a Private test. A clip without a TikTok post gets a new Mac post
    (``madeForMac``, its id in ``postIds`` and in the clip's ``tiktokForMac``, written only while neither that mark nor
    ``tiktokByYou`` is there: two sends, or a send and I posted it, never make two posts). A Clip Factory TikTok post
    that waits for setup, failed or went up privately is handed over in place, its fields kept in ``beforeMac``. Its
    options are My settings' (Everyone, Comment, Duet and Stitch on)."""
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
            **new_mac_fields("sent", at),
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
    refusal = _not_handable(row)
    if refusal:
        return refusal
    before = {k: row[k] for k in HANDED_OVER if k in row}
    handed = {**new_mac_fields("sent", at), "beforeMac": before, "postOptions": options}
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


def check_done(row: Mapping[str, Any], device: str) -> None:
    """The Mac's done comes from the device that claimed the post, while it works on it or after it stopped; a post
    it already finished (``via: "mac"``) is answered again. Anything else is ``Refused`` (``mark_posted`` checks the
    same in its write)."""
    if row.get("status") == MAC_STATUS:
        _own(row, device, ("working", "stopped"))
    elif row.get("via") != "mac":
        raise Refused(MAC_NOT_POSTING)


def since_for_finder(post: Mapping[str, Any]) -> str | None:
    """Done without a link looks for the post from a minute before the claim (the §42 finder's ``since``)."""
    claimed = parse(post.get("macClaimedAt"))
    return iso(claimed - FIND_EARLY) if claimed is not None else None
