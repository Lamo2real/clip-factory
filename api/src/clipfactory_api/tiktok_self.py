"""It's on TikTok (docs/CONTRACTS.md §42): the clip is on the owner's TikTok for Everyone, and Clip Factory is told.

The clip's TikTok post (one per clip, as everywhere) becomes ``posted`` with the public ``by: "you"``. When that post
was Clip Factory's own (waiting, failed, or uploaded privately) its earlier fields are kept in the internal
``beforeYou`` so Undo can put them back; a post made here carries the internal ``madeByYou`` and Undo deletes it. A
pasted link gives the video's id: the post joins the stats poller (``statsId`` + ``gsi2``) like any public post.
Nothing here calls TikTok's posting API, so TikTok's API rules for unaudited apps do not apply to it.

The owner's Mac (§47) finishes a Mac post through the same ``mark_posted`` (``mac``): the one TikTok post per clip
becomes ``posted``, ``by: "you"``, with the public ``via: "mac"``, in the same conditional write, so the Mac's done and
the owner's It's on TikTok can never both make a post. His It's on TikTok on a Mac post is allowed while it waits or
stopped (its Mac fields go into ``beforeYou``, so Undo puts the Mac post back), never while the Mac is posting it,
unless that job is stuck (``mac_stuck``: its own beat is ``MAC_BEAT_STALE`` old, or its claim ``MAC_CLAIM_MAX`` old,
the web's "Not sure it posted"; the beat counts only for a helper that beats its jobs, ``helper_beats``). Without a
link (``no_link``) it is refused on a job the Mac is on and never pressed Post for (``MAC_WORKING`` while it still beats
the job, else ``MAC_NOT_PRESSED``): the clip is not on TikTok, so only Try again helps. Marking a stopped or stuck Mac
post also puts the helper item back to ``ok`` when it needed him (``clear_needs_you``), as Try again does: nothing else
would let the Mac go on.
"""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from . import day7, db
from .clock import iso, parse
from .ids import ulid
from .posts import MAC_STATUS, PERF_CHECK_DELAY, posts_for_clip
from .tiktok_link import TikTokVideo

Item = dict[str, Any]

DECIDED = ("confirmed", "publishing", "posted", "failed")
NOT_UPLOADED = "Upload this clip first. Then your Mac can post it on TikTok."
STILL_UPLOADING = "This clip is still uploading to TikTok. Wait until it is done, then try again."
STILL_STARTING = "This clip is still starting to upload. Try again in a minute."
ALREADY_PUBLIC = "This clip is already on TikTok for everyone."
NOT_YOURS = "This clip was not marked as posted by you, so there is nothing to undo."
# §47: the owner's Mac posts it on TikTok.
MAC_WORKING = "Your Mac is posting it right now. Wait a minute."
MAC_NOT_POSTING = "Your Mac isn't posting this clip."
MAC_TAKEN = "Another try already has this clip."
MAC_POSTED = "Your Mac posted this one. To take it down, delete it in TikTok."
# It's on TikTok without a link on a job the Mac stopped working on before it pressed Post: it can't be on TikTok.
MAC_NOT_PRESSED = "Your Mac stopped before it pressed Post, so it isn't on TikTok. Tap Try again."
# The helper item (``USER#{id}`` / ``MACHELPER``, §47.3): when the Mac last checked in and how it is.
HELPER_SK = "MACHELPER"
# The stuck rule (§47.3, the web's ``macStuck`` uses the same minutes, a web test pins them): a Mac post still
# ``working`` whose own beat (``macBeatAt``, else ``macClaimedAt``) is this old: the helper re-sends its step every
# minute while it works on the job, so it stopped working on it (crashed, slept, lost its ledger).
MAC_BEAT_STALE = timedelta(minutes=5)
# ... or whose claim is this old, whatever its beats: 12 minutes of upload wait, the post wait and the find window.
MAC_CLAIM_MAX = timedelta(minutes=50)
# After Post was pressed the helper looks for the link this long (its FIND_FOR_MS): Try again waits until it is over.
MAC_FIND_WINDOW = timedelta(minutes=30)
# The first helper version that beats its jobs and reads Start my Mac again and Let them go (its paths.js VERSION; the
# web's MAC_BEATS_FROM, web and helper tests pin them). An older helper sends no beat during its long waits, so for its
# jobs only the claim's age counts (``MAC_CLAIM_MAX``): a healthy post is never called stuck while it is still on it.
MAC_BEATS_FROM = "1.1.0"
# The internal fields that make a post a Mac post (§47): its state (public as ``mac``), who claimed it and its beat,
# when an earlier try pressed Post and when the owner tried again after it (``macPressedBefore``, ``macAgainAt``: the
# helper's never-twice guard reads them), what a Clip Factory post was before it was handed over (``beforeMac``), and
# whether the post was made for the Mac (``madeForMac``, so Take it back deletes it).
MAC_FIELDS = (
    "macState",
    "macStep",
    "macSince",
    "macSource",
    "macClaimedAt",
    "macPressedAt",
    "macStoppedAt",
    "macReason",
    "macDevice",
    "macBeatAt",
    "macAttempt",
    "macPressedBefore",
    "macAgainAt",
    "beforeMac",
    "madeForMac",
)

# The fields a Clip Factory TikTok post may hold that "posted by you" replaces (kept in ``beforeYou`` for Undo).
REPLACED = (
    "status",
    "url",
    "postedAt",
    "perfCheckAt",
    "privacy",
    "error",
    "platformPostId",
    "statsId",
    "statsDueAt",
    "gsi2pk",
    "gsi2sk",
    "metrics",
    "statsError",
    "nextRefreshAt",
    # What was learned from the earlier video: day-7 views (§16.12) and the snapshot/insights bookkeeping. A post by
    # him is another video, so it starts fresh and Undo puts these back.
    *day7.FIELDS,
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
)
STATS_FIELDS = ("statsId", "statsDueAt", "gsi2pk", "gsi2sk")
LEARNED = (
    "metrics",
    "statsError",
    "nextRefreshAt",
    *day7.FIELDS,
    "lastSnapshotAt",
    "lastSnapshotViews",
    "insightsDueAt",
)
# On the clip while a TikTok post made by his It's on TikTok exists: two taps at once can never make two TikTok posts.
MADE_MARK = "tiktokByYou"
# On the clip while a TikTok post made by Send these to my Mac exists (§47): It's on TikTok and a send at the same
# moment can never make two TikTok posts either.
MAC_MARK = "tiktokForMac"
# What Undo of It's on TikTok puts back: a Clip Factory post's fields, and a Mac post's.
UNDONE = (*REPLACED, *MAC_FIELDS)


@dataclass(frozen=True)
class MacDone:
    """The owner's Mac saying it posted the clip (§47): the device that claimed the post and, when the helper sends
    it, the claim's attempt (``macAttempt``), so an older attempt of the same device is never taken for the new one."""

    device: str
    attempt: int | None = None


def mac_privacy(row: Mapping[str, Any]) -> str:
    """What the Mac set: ``public`` only for Everyone (``PUBLIC_TO_EVERYONE``, every Mac post's choice), else
    ``private``."""
    options = row.get("postOptions")
    level = options.get("privacyLevel") if isinstance(options, Mapping) else None
    return "public" if level in (None, "PUBLIC_TO_EVERYONE") else "private"


class Refused(Exception):
    """A plain sentence for the owner, with the HTTP status that goes with it (409 or 400)."""

    def __init__(self, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _beat(row: Mapping[str, Any]) -> datetime | None:
    """The job's own beat: ``macBeatAt`` (claim, every step, every re-sent step), else its claim."""
    return parse(row.get("macBeatAt")) or parse(row.get("macClaimedAt"))


def _version(raw: Any) -> tuple[int, ...] | None:
    """``"1.1.0"`` → ``(1, 1, 0)``; None when it isn't a version (absent, ``"dev"``)."""
    parts = str(raw or "").strip().split(".")
    return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else None


def helper_beats(item: Mapping[str, Any] | None) -> bool:
    """The owner's helper beats every job it works on (§47.3): unless its item says a version older than
    ``MAC_BEATS_FROM`` (the helper on his Mac until it is installed again)."""
    said = _version(item.get("version")) if item else None
    return said is None or said >= (_version(MAC_BEATS_FROM) or ())


def mac_stuck(row: Mapping[str, Any], now: datetime, *, beats: bool = True) -> bool:
    """A Mac post still ``working`` that its Mac stopped working on (§47.3): its own beat is ``MAC_BEAT_STALE`` old
    or more, or its claim ``MAC_CLAIM_MAX`` old or more, whichever comes first. Only then may the owner say it's on
    TikTok, or try again: while the Mac beats the job it is still posting or looking for it. ``beats`` is
    ``helper_beats`` of the owner's helper: for an older helper only the claim's age counts."""
    if row.get("status") != MAC_STATUS or row.get("macState") != "working":
        return False
    beat = _beat(row)
    claimed = parse(row.get("macClaimedAt"))
    return (beats and beat is not None and now - beat >= MAC_BEAT_STALE) or (
        claimed is not None and now - claimed >= MAC_CLAIM_MAX
    )


def working_stuck(store: db.Store, user_id: str, row: Mapping[str, Any], now: datetime) -> bool:
    """``mac_stuck`` with the owner's helper item read for ``beats`` (only for a ``working`` Mac post)."""
    if row.get("status") != MAC_STATUS or row.get("macState") != "working":
        return False
    return mac_stuck(row, now, beats=helper_beats(store.get(db.user_pk(user_id), HELPER_SK)))


def beat_fresh(row: Mapping[str, Any], now: datetime) -> bool:
    """The Mac beat this job less than ``MAC_BEAT_STALE`` ago (``macBeatAt``, else ``macClaimedAt``)."""
    beat = _beat(row)
    return beat is not None and now - beat < MAC_BEAT_STALE


def window_over(row: Mapping[str, Any], now: datetime) -> bool:
    """The find window after Post was pressed is over: no ``macPressedAt``, or it is ``MAC_FIND_WINDOW`` old or more
    (the helper has stopped looking for the link by then, so a new try can never meet the first)."""
    pressed = parse(row.get("macPressedAt"))
    return pressed is None or now - pressed >= MAC_FIND_WINDOW


def clear_needs_you(store: db.Store, user_id: str) -> None:
    """The helper item goes back to ``ok`` (without its reason, ``needsYouClipId`` and ``needsYouCode``) when it was
    ``needs_you``: the owner answered the stopped post (Try again, or It's on TikTok), so the Mac goes on. Nothing
    changes when it did not need him."""
    with contextlib.suppress(db.ConditionFailed):
        store.update_expr(
            db.user_pk(user_id),
            HELPER_SK,
            "SET #st = :ok REMOVE #re, #nc, #cd",
            condition="#st = :nu",
            names={"#st": "state", "#re": "reason", "#nc": "needsYouClipId", "#cd": "needsYouCode"},
            values={":ok": "ok", ":nu": "needs_you"},
        )


def tiktok_row(rows: list[Item]) -> Item | None:
    return next((p for p in rows if p.get("platform") == "tiktok" and p.get("type") == "post"), None)


def _stats_fields(post_id: str, video: TikTokVideo, now: datetime, min_interval: int) -> Item:
    due = iso(now + timedelta(minutes=min_interval))
    return {"statsId": video.video_id, "statsDueAt": due, "gsi2pk": db.STATS_GSI_PK, "gsi2sk": f"{due}#{post_id}"}


def check_can_mark(store: db.Store, clip: Mapping[str, Any], now: datetime) -> None:
    """Find it for me's check before the finder asks TikTok anything (§42.2): the refusals ``mark_posted`` would give
    without a link (``Refused``), so a clip that can't be marked never costs a TikTok call."""
    _checked(store, clip, None, now, no_link=False)


def _checked(
    store: db.Store, clip: Mapping[str, Any], mac: MacDone | None, now: datetime, *, no_link: bool
) -> tuple[list[Item], Item | None, bool]:
    """The clip's posts, its TikTok post and whether that is a stuck Mac post (``working_stuck``), once every refusal
    of ``mark_posted`` passed (``Refused``)."""
    status = clip.get("status")
    if status not in DECIDED:
        raise Refused(NOT_UPLOADED)
    if not clip.get("postsCreated"):
        raise Refused(STILL_STARTING)
    rows = posts_for_clip(store, str(clip["userId"]), str(clip["clipId"]), consistent=True)
    row = tiktok_row(rows)
    stuck = row is not None and mac is None and working_stuck(store, str(clip["userId"]), row, now)
    _check_mac(row, mac, now, stuck=stuck, no_link=no_link)
    if row is not None and row.get("status") == "queued":
        raise Refused(STILL_UPLOADING)
    if row is not None and row.get("by") != "you" and row.get("status") == "posted" and row.get("privacy") == "public":
        raise Refused(ALREADY_PUBLIC)
    return rows, row, stuck


def mark_posted(
    store: db.Store,
    clip: Mapping[str, Any],
    video: TikTokVideo | None,
    now: datetime,
    *,
    min_interval: int,
    count_views: bool = True,
    mac: MacDone | None = None,
    no_link: bool = False,
) -> None:
    """Writes the clip's TikTok post as posted by the owner (creating it when the clip has none). With ``video``
    the post gets its link and, when ``count_views``, joins the poller. Marking again only adds or changes the link.
    ``mac`` is the owner's Mac saying it posted it (§47): only the Mac post it claimed (``macDevice``, and
    ``macAttempt`` when given, still ``working`` or ``stopped``) becomes posted, with ``via: "mac"``, the privacy it
    set (``mac_privacy``) and its Mac fields gone; a post it already finished only gets the link. Without ``mac`` (his
    It's on TikTok) a Mac post still ``working`` is refused unless it is stuck (``working_stuck``); with ``no_link``
    (his "It's on TikTok, no link") also while the Mac has not pressed Post for it (``MAC_WORKING`` while it still beats
    the job, even past ``MAC_CLAIM_MAX``; else ``MAC_NOT_PRESSED``: it can't be on TikTok). A stopped or stuck Mac post
    he marks also clears the helper's ``needs_you`` (``clear_needs_you``). Raises ``Refused``."""
    status = clip.get("status")
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    rows, row, stuck = _checked(store, clip, mac, now, no_link=no_link)

    if row is None:
        _new_post(store, clip, rows, video, now, min_interval=min_interval, count_views=count_views)
        return

    post_id = str(row["postId"])
    fields: Item = {"status": "posted", "by": "you", "privacy": "public"}
    remove: list[str] = []
    expect = _mac_fields(row, mac, fields, remove, stuck=stuck)
    answered = mac is None and row.get("status") == MAC_STATUS and row.get("macState") in ("stopped", "working")
    if row.get("by") != "you":
        # Clip Factory's own post (waiting, failed or private), or a Mac post: keep what it was, for Undo. The Mac's
        # own done keeps nothing: what it posted is on TikTok and is never undone.
        if mac is None:
            fields["beforeYou"] = {k: row[k] for k in UNDONE if k in row}
        posted_at = now
        fields["postedAt"] = iso(posted_at)
        fields["perfCheckAt"] = iso(posted_at + PERF_CHECK_DELAY)
        remove += [k for k in ("error", "platformPostId", "url", *LEARNED) if k in row]
        remove += [k for k in STATS_FIELDS if k in row]
    if video is not None:
        fields["url"] = video.url
        remove = [k for k in remove if k != "url"]
        same = row.get("by") == "you" and row.get("statsId") == video.video_id
        if row.get("by") == "you" and not same:
            # Another video than the one he linked before: its numbers and what was learned from it go.
            remove += [k for k in LEARNED if k in row and k not in remove]
        if count_views and not same:
            fields.update(_stats_fields(post_id, video, now, min_interval))
            remove = [k for k in remove if k not in STATS_FIELDS]
        elif not count_views:
            remove += [k for k in STATS_FIELDS if k in row and k not in remove]
    updates = [
        db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            fields,
            remove=remove,
            expect_in=expect,
        )
    ]
    clip_fields = _clip_status(status, [r for r in rows if r is not row], now_posted=True)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    store.transact(updates=updates)
    if answered:
        clear_needs_you(store, user_id)


def _new_post(
    store: db.Store,
    clip: Mapping[str, Any],
    rows: list[Item],
    video: TikTokVideo | None,
    now: datetime,
    *,
    min_interval: int,
    count_views: bool,
) -> None:
    """The owner's It's on TikTok on a clip with no TikTok post: a new one (``madeByYou``), in one transaction with
    the clip, which gets ``tiktokByYou`` only while neither that mark nor a send's ``tiktokForMac`` is there (never
    two posts)."""
    status = clip.get("status")
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    post_id = ulid()
    posted_at = now
    item: Item = {
        "pk": db.user_pk(user_id),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip_id}",
        "gsi1sk": "POST#tiktok",
        "type": "post",
        "userId": user_id,
        "createdAt": iso(now),
        "flowRun": int(clip.get("flowRun") or 1),
        "postId": post_id,
        "clipId": clip_id,
        "platform": "tiktok",
        "status": "posted",
        "by": "you",
        "madeByYou": True,
        "privacy": "public",
        "postedAt": iso(posted_at),
        "perfCheckAt": iso(posted_at + PERF_CHECK_DELAY),
        **({"campaignId": clip["campaignId"]} if clip.get("campaignId") else {}),
    }
    if video is not None:
        item["url"] = video.url
        if count_views:
            item.update(_stats_fields(post_id, video, now, min_interval))
    update = db.update_request(
        db.user_pk(user_id),
        db.clip_sk(clip_id),
        {
            "postIds": [*_post_ids(clip, rows), post_id],
            MADE_MARK: post_id,
            **_clip_status(status, rows, now_posted=True),
        },
        expect_in={"status": [status]},
        expect_absent=[MADE_MARK, MAC_MARK],
    )
    store.transact(puts=[item], updates=[update])


def _check_mac(
    row: Mapping[str, Any] | None, mac: MacDone | None, now: datetime, *, stuck: bool, no_link: bool = False
) -> None:
    """§47: the Mac's done is only for the Mac post its device (and attempt) claimed, or one it already finished; his
    It's on TikTok is never taken while the Mac is posting it, unless that job is stuck (``stuck``), and without a
    link never on a job the Mac has not pressed Post for (D3: it is not on TikTok; while the Mac still beats it, it
    may still post it)."""
    if row is None or row.get("status") != MAC_STATUS:
        if mac is not None and (row is None or row.get("via") != "mac"):
            raise Refused(MAC_NOT_POSTING)
        return
    if mac is not None:
        if not owns(row, mac.device, ("working", "stopped"), mac.attempt):
            raise Refused(MAC_TAKEN)
        return
    if row.get("macState") != "working":
        return
    if not stuck:
        raise Refused(MAC_WORKING)
    if no_link and not row.get("macPressedAt"):
        raise Refused(MAC_WORKING if beat_fresh(row, now) else MAC_NOT_PRESSED)


def owns(row: Mapping[str, Any], device: str, states: tuple[str, ...], attempt: int | None = None) -> bool:
    """The Mac post is ``device``'s claim, in one of ``states`` (and of ``attempt``, when the helper sends it)."""
    if row.get("macDevice") != device or row.get("macState") not in states:
        return False
    return attempt is None or row.get("macAttempt") == attempt


def _mac_fields(
    row: Mapping[str, Any], mac: MacDone | None, fields: Item, remove: list[str], *, stuck: bool
) -> dict[str, list[Any]]:
    """The write's condition, and what a Mac post loses (§47): its Mac fields go; the Mac's done adds ``via: "mac"``
    and the privacy the Mac set, and needs the claim to still be its own; his It's on TikTok needs the Mac not to be
    posting it (or that stuck job, unchanged: the same claim, beat and press)."""
    expect: dict[str, list[Any]] = {"status": [str(row.get("status"))]}
    if row.get("status") == MAC_STATUS:
        remove += [k for k in MAC_FIELDS if k in row]
        if mac is not None:
            # The Mac posted it: it stays his one TikTok post, and Undo never takes it back (it is on TikTok).
            fields["via"] = "mac"
            fields["privacy"] = mac_privacy(row)
            expect.update({"macDevice": [mac.device], "macState": ["working", "stopped"]})
            if mac.attempt is not None:
                expect["macAttempt"] = [mac.attempt]
        elif stuck:
            expect.update({"macState": ["working"], "macClaimedAt": [str(row.get("macClaimedAt"))]})
            for key in ("macBeatAt", "macPressedAt"):
                if row.get(key):
                    expect[key] = [str(row[key])]
        else:
            expect["macState"] = ["waiting", "stopped"]  # never while the Mac is posting it
    elif mac is not None:
        fields["via"] = "mac"  # a repeat of the Mac's done: only the link changes
        fields["privacy"] = str(row.get("privacy") or "public")
    return expect


def undo(store: db.Store, clip: Mapping[str, Any]) -> None:
    """Takes back the owner's It's on TikTok: a post made here is deleted, Clip Factory's own post gets its fields
    back."""
    user_id = str(clip["userId"])
    clip_id = str(clip["clipId"])
    rows = posts_for_clip(store, user_id, clip_id, consistent=True)
    row = tiktok_row(rows)
    if row is None or row.get("by") != "you":
        raise Refused(NOT_YOURS)
    if row.get("via") == "mac":
        raise Refused(MAC_POSTED)  # §47: it is on TikTok; taking it down happens in TikTok
    others = [r for r in rows if r is not row]
    status = str(clip.get("status"))
    if row.get("madeByYou"):
        ids = [i for i in _post_ids(clip, rows) if i != str(row["postId"])]
        clip_fields: Item = {"postIds": ids, **_clip_status(status, others, now_posted=False)}
        store.transact(
            updates=[
                db.update_request(
                    db.user_pk(user_id),
                    db.clip_sk(clip_id),
                    clip_fields,
                    remove=[MADE_MARK],
                    expect_in={"status": [status]},
                )
            ]
        )
        store.delete_if(str(row["pk"]), str(row["sk"]), {"by": ["you"]})
        return
    kept = row.get("beforeYou")
    before: Mapping[str, Any] = kept if isinstance(kept, Mapping) else {}
    back = {k: v for k, v in before.items() if k in UNDONE}
    back.setdefault("status", "failed")
    remove = ["by", "beforeYou", *[k for k in UNDONE if k in row and k not in back]]
    updates = [db.update_request(str(row["pk"]), str(row["sk"]), back, remove=remove, expect_in={"by": ["you"]})]
    restored = {**row, **back}
    clip_fields = _clip_status(status, [*others, restored], now_posted=False)
    if clip_fields:
        updates.append(
            db.update_request(db.user_pk(user_id), db.clip_sk(clip_id), clip_fields, expect_in={"status": [status]})
        )
    store.transact(updates=updates)


def _post_ids(clip: Mapping[str, Any], rows: list[Item]) -> list[str]:
    """The clip's ``postIds``. Clips uploaded before that list existed have none; their posts were all read by the
    full fallback query (``posts_for_clip``), so the list starts from those, or later reads would see only the new one."""
    kept = clip.get("postIds")
    if isinstance(kept, list):
        return [str(i) for i in kept]
    return [str(r["postId"]) for r in rows if r.get("postId")]


def _clip_status(status: Any, others: list[Item], *, now_posted: bool) -> Item:
    """The clip's new status, when it changes: what the clip flow's settle would say (§14.5), never while its own
    upload is still running (``publishing``, or a ``confirmed`` clip with posts on their way)."""
    if status not in ("confirmed", "posted", "failed"):
        return {}
    statuses = {r.get("status") for r in others}
    if "queued" in statuses:
        return {}
    if now_posted or "posted" in statuses:
        new = "posted"
    elif "failed" in statuses:
        new = "failed"
    else:
        new = "confirmed"
    return {"status": new} if new != status else {}


def posted_at(row: Mapping[str, Any]) -> datetime | None:
    return parse(row.get("postedAt"))
