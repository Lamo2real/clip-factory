"""My Mac posts TikTok for Clips Funded (docs/CONTRACTS.md §47.10, ADR-89): the owner's Mac helper posts a story's
TikTok job the way it posts Clip Factory's (§47), to Clips Funded's own TikTok only.

* A Mac job is the story's TikTok ``PUBJOB#`` with ``publishingStatus: "mac"`` (written by ``workspaces.publish``):
  ``waiting`` → the helper's claim (one conditional write: one Mac, one try at a time) → ``working`` with its steps
  (``pressing`` sets ``macPressedAt``, the point of no return; a re-sent step is the job's beat, ``macBeatAt``) → the
  Mac's done (``posted``, ``via: "mac"``) or ``stopped`` with a reason; the owner's Try again makes a stopped or stuck
  job wait again, and his It's on TikTok marks it posted (``by: "you"``). Every write is conditional on the state it
  was read in, so a race answers 409 and nothing is posted twice.
* Never another account: the claim runs ``validate_destination`` (the story, the connected TikTok on the same app,
  the token's open_id equal to the job's, never Clip Factory's account) and checks the stored ``@handle`` is still
  the job's; the Mac checks it is logged in to that handle before every post, and a done whose link is on another
  account is refused (``wrong_account``) with nothing written.
* The helper item is this workspace's ``USER#{u}#WS#{ws}`` / ``MACHELPER``, never Clip Factory's ``USER#{u}`` one, so a
  Clips Funded problem never pauses Clip Factory's posts and the other way round. A helper older than ``MAC_WS_FROM``
  gets an empty queue and cannot claim.
* Nothing here calls TikTok, reads Clip Factory's token or imports Clip Factory's Mac module (``tiktok_mac``); the
  timing constants are ``tiktok_self``'s, so both lanes share one stuck rule.
"""

from __future__ import annotations

import contextlib
import re
import unicodedata
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any, Final

from .. import db, mojibake
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found
from ..log import log
from ..tiktok_self import MAC_BEAT_STALE, MAC_CLAIM_MAX, MAC_FIND_WINDOW
from . import guard, media, publish, story_posted
from . import types as ws
from .destinations import DestinationProblem, confirm_not_clips_update, story_sk, validate_destination
from .social import Scope, social_sk

Item = dict[str, Any]

# The first helper that serves Clips Funded's lane (its paths.js VERSION; the helper and web tests read this line).
MAC_WS_FROM = "1.2.0"
# tiktok_mac.STALE_CLAIM (a test pins them equal; this module never imports tiktok_mac): a claim whose helper sent no
# beat for this long, and that never pressed Post, belongs to a helper that crashed.
STALE_CLAIM: Final = timedelta(minutes=15)

STATES: Final = ("waiting", "working", "stopped")
STEPS: Final = ("video", "opening", "uploading", "settings", "pressing", "finding")
HELPER_STATES: Final = ("ok", "needs_you", "paused")
QUEUE_MAX: Final = 50
REASON_MAX: Final = 200
STORY_TRIES: Final = 5
# A TikTok video link: the account's @name and the video id (anything after the id is ignored).
LINK: Final = re.compile(r"^https://(www\.)?tiktok\.com/@([A-Za-z0-9._]{2,30})/video/(\d{8,25})(?!\d)")

NOT_FOUND: Final = "We could not find that post."
NOT_MAC: Final = "Your Mac isn't posting this one."
MAC_OFF_WS: Final = "My Mac posts TikTok is off in Clips Funded."
MAC_OLD: Final = "Update the helper on your Mac."
UPDATE_FIRST: Final = "Update the helper on your Mac first."
PICK_SIGN_IN: Final = "Pick sign_in."
PICK_RESUME: Final = "Pick resume."
NOT_PAUSED: Final = "Your Mac isn't paused."
MAC_TAKEN: Final = "Another try already has this post."
MAC_WORKING: Final = "Your Mac is posting it right now. Wait a minute."
MAC_NOT_PRESSED: Final = "Your Mac stopped before it pressed Post, so it isn't on TikTok. Tap Try again."
MAY_HAVE_POSTED: Final = "Your Mac may have posted it already. Check your TikTok first."
MAC_STILL_LOOKING: Final = (
    "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later."
)
PRESSED: Final = (
    "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok."
)
WRONG_ACCOUNT: Final = "That post is on another TikTok account."
BAD_LINK: Final = "Paste the video's full TikTok link: tiktok.com/@name/video/…"
CHANGED: Final = "This post just changed. Try again."
# Why the claim stopped a job (§5.4): the server's own reasons.
ACCOUNT_CHANGED: Final = "Clips Funded's TikTok is a different account now. Tap Try again."
NOT_CONNECTED: Final = "Connect TikTok again in Social accounts. Then tap Try again."
VIDEO_GONE: Final = "The video is gone. Make it again, then tap Try again."
RECONNECT_KINDS: Final = frozenset({"not_connected", "reconnect", "keys_changed", "token_dead"})


# --- reading ---------------------------------------------------------------------------------------------------


def _version(raw: Any) -> tuple[int, ...] | None:
    """``"1.2.0"`` → ``(1, 2, 0)``; None when it isn't a version."""
    parts = str(raw or "").strip().split(".")
    return tuple(int(p) for p in parts) if parts and all(p.isdigit() for p in parts) else None


def new_enough(raw: Any) -> bool:
    """The helper says ``MAC_WS_FROM`` or newer; anything else (older, absent, not a version) is too old."""
    said = _version(raw)
    return said is not None and said >= (_version(MAC_WS_FROM) or ())


def _pk(user_id: str, workspace_id: str) -> str:
    return ws.workspace_pk(user_id, workspace_id)


def is_on(workspace: Mapping[str, Any]) -> bool:
    config = workspace.get("configuration")
    return publish.mac_on(config if isinstance(config, Mapping) else None)


def helper_item(store: db.Store, user_id: str, workspace_id: str) -> Item | None:
    found = store.get(_pk(user_id, workspace_id), ws.MACHELPER_SK)
    return found if guard.owned(found, user_id, workspace_id) else None


def public_helper(item: Mapping[str, Any] | None) -> Item | None:
    """``WsMacHelper``: when the Mac last checked in for this workspace and how it is (never its device id)."""
    if not item or not item.get("seenAt"):
        return None
    state = item.get("state")
    out: Item = {
        "seenAt": str(item["seenAt"]),
        "state": state if state in HELPER_STATES else "ok",
        "setUp": item.get("setUp") is True,
    }
    for key in ("reason", "version", "handle", "needsYouJobId", "needsYouStoryId"):
        if item.get(key):
            out[key] = str(item[key])
    if item.get("loginRequestAt"):
        out["loginRequest"] = {"at": str(item["loginRequestAt"])}
    if item.get("resumeRequestAt"):
        out["resumeRequest"] = {"at": str(item["resumeRequestAt"])}
    return out


def public_account(store: db.Store, user_id: str, workspace_id: str) -> Item | None:
    """Clips Funded's TikTok as the Mac card shows it: ``{handle, accountName, status}``, or None."""
    item = store.get(_pk(user_id, workspace_id), social_sk("tiktok"))
    if not guard.owned(item, user_id, workspace_id) or item is None:
        return None
    return {
        "handle": str(item["handle"]) if isinstance(item.get("handle"), str) and item["handle"] else None,
        "accountName": str(item["accountName"]) if item.get("accountName") else None,
        "status": str(item.get("connectionStatus") or "not_connected"),
    }


def _attempt(row: Mapping[str, Any]) -> int:
    value = row.get("macAttempt")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else 0


def caption(story: Mapping[str, Any]) -> str:
    """The story's TikTok caption (else its title), repaired as the API's text is (§5) and in NFC."""
    captions = story.get("postCaptions")
    text = str((captions if isinstance(captions, Mapping) else {}).get("tiktok") or "") or str(story.get("title") or "")
    return unicodedata.normalize("NFC", mojibake.repair(text))


def file_name(title: str) -> str:
    """The name the helper saves the video under in Downloads (its ``ownFile`` knows the prefix)."""
    return f"clips-funded-{media.slug(title, 'video')}.mp4"


def job(row: Mapping[str, Any], story: Mapping[str, Any] | None) -> Item:
    """The ``WsMacJob`` the helper works from: the only account it may go to, the AI label, the fixed public
    options, and where the job stands (its beat, and after a re-wait that followed a press, when Post was pressed
    before and when the owner tried again: the helper's never-twice guard)."""
    story = story or {}
    title = str(story.get("title") or "")
    options = publish.MAC_OPTIONS
    out: Item = {
        "workspaceId": str(row.get("workspaceId") or ""),
        "publishingJobId": str(row.get("publishingJobId") or ""),
        "storyId": str(row.get("contentId") or ""),
        "hook": title,
        "caption": caption(story),
        "fileName": file_name(title),
        "account": {"handle": str(row.get("handle") or ""), "openId": str(row.get("externalAccountId") or "")},
        "aiLabel": True,
        "privacy": str(options["privacyLevel"]),
        "comment": options["disableComment"] is not True,
        "duet": options["disableDuet"] is not True,
        "stitch": options["disableStitch"] is not True,
        "source": "upload",
        "since": str(row.get("macSince") or ""),
        "state": str(row.get("macState") or "waiting"),
        "attempt": _attempt(row),
    }
    for field, key in (
        ("macStep", "step"),
        ("macClaimedAt", "claimedAt"),
        ("macPressedAt", "pressedAt"),
        ("macBeatAt", "beatAt"),
        ("macPressedBefore", "pressedBefore"),
        ("macAgainAt", "againAt"),
    ):
        if row.get(field):
            out[key] = str(row[field])
    return out


def _story_of(store: db.Store, user_id: str, workspace_id: str, row: Mapping[str, Any]) -> Item | None:
    story_id = str(row.get("contentId") or "")
    found = store.get(_pk(user_id, workspace_id), story_sk(story_id)) if story_id else None
    if not guard.owned(found, user_id, workspace_id) or found is None or found.get("storyId") != story_id:
        return None
    return found


def queue(store: db.Store, user_id: str, workspace: Mapping[str, Any], version: str | None = None) -> list[Item]:
    """The helper's queue for this workspace: empty while the switch is off or for a helper older than
    ``MAC_WS_FROM``; else the Mac jobs that wait or that a Mac works on (so a restarted helper sees its own), oldest
    ``since`` first, at most 50."""
    workspace_id = str(workspace["workspaceId"])
    if not is_on(workspace) or (version is not None and not new_enough(version)):
        return []
    pk = _pk(user_id, workspace_id)
    rows = [
        j
        for j in store.query_all(pk, ws.PUBJOB_SK, consistent=True)
        if guard.owned(j, user_id, workspace_id)
        and j.get("platform") == "tiktok"
        and j.get("publishingStatus") == publish.MAC_STATUS
        and j.get("macState") in ("waiting", "working")
    ]
    if not rows:
        return []
    rows.sort(key=lambda j: (str(j.get("macSince") or ""), str(j.get("publishingJobId") or "")))
    story_ids = sorted({str(j.get("contentId") or "") for j in rows} - {""})
    found = {
        str(s.get("storyId")): s
        for s in store.batch_get((pk, story_sk(i)) for i in story_ids)
        if guard.owned(s, user_id, workspace_id) and s.get("type") == ws.TYPE_STORY
    }
    out: list[Item] = []
    for row in rows:
        story = found.get(str(row.get("contentId") or ""))
        if story is None:
            continue
        out.append(job(row, story))
        if len(out) >= QUEUE_MAX:
            break
    return out


def status(store: db.Store, user_id: str, workspace: Mapping[str, Any], version: str | None = None) -> Item:
    """``WsMacStatus``: the switch, the helper, the account it posts to and the queue."""
    workspace_id = str(workspace["workspaceId"])
    return {
        "on": is_on(workspace),
        "helper": public_helper(helper_item(store, user_id, workspace_id)),
        "account": public_account(store, user_id, workspace_id),
        "queue": queue(store, user_id, workspace, version),
    }


# --- the helper item --------------------------------------------------------------------------------------------


def _reason(raw: Any) -> str:
    text = " ".join(str(raw or "").split())
    return text[:REASON_MAX].rstrip()


def ping(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    *,
    state: str,
    reason: str | None,
    version: str,
    device: str,
    set_up: bool,
    handle: str | None,
    login_done: str | None,
    now: datetime,
    resume_done: str | None = None,
) -> None:
    """The helper checks in for this workspace: when, how it is and why, its version and device, and whether its
    Chrome profile is logged in to this workspace's TikTok (``setUp``, the ``handle`` it read). ``needsYouJobId``
    and ``needsYouStoryId`` go with any ping whose state isn't ``needs_you``; the owner's Log in on my Mac and Start my
    Mac again stay until the helper says it handled that one (``login_done`` / ``resume_done``: its ``at``)."""
    pk = _pk(user_id, workspace_id)
    current = store.get(pk, ws.MACHELPER_SK)
    fields: Item = {
        "type": ws.TYPE_MACHELPER,
        "userId": user_id,
        "workspaceId": workspace_id,
        "seenAt": iso(now),
        "state": state,
        "version": version,
        "device": device,
        "setUp": set_up,
    }
    if reason:
        fields["reason"] = _reason(reason)
    if handle:
        fields["handle"] = handle
    if current is None:
        store.put({"pk": pk, "sk": ws.MACHELPER_SK, **fields})
    else:
        gone = [k for k, given in (("reason", reason), ("handle", handle)) if not given]
        if state != "needs_you":
            gone += ["needsYouJobId", "needsYouStoryId"]
        store.update(pk, ws.MACHELPER_SK, fields, remove=[k for k in gone if k in current])
    for done, key in ((login_done, "loginRequestAt"), (resume_done, "resumeRequestAt")):
        if not done:
            continue
        with contextlib.suppress(db.ConditionFailed):  # a newer request came meanwhile: it stays
            store.update_expr(
                pk,
                ws.MACHELPER_SK,
                "REMOVE #rq",
                condition="#rq = :done",
                names={"#rq": key},
                values={":done": done},
            )


def login_request(store: db.Store, user_id: str, workspace_id: str, now: datetime) -> Item:
    """The owner's Log in on my Mac: the helper opens a TikTok window on its next tick. Refused until a helper of
    ``MAC_WS_FROM`` or newer checked in for this workspace. Returns the helper item."""
    item = helper_item(store, user_id, workspace_id)
    if item is None or not new_enough(item.get("version")):
        raise conflict(UPDATE_FIRST)
    return store.update(_pk(user_id, workspace_id), ws.MACHELPER_SK, {"loginRequestAt": iso(now)})


def resume_request(store: db.Store, user_id: str, workspace_id: str, now: datetime) -> Item:
    """The owner's Start my Mac again in Clips Funded: the helper ends this Mac's pause on its next tick (the same pause
    Clip Factory's button ends) and says so in its ping (``resumeDone``). Refused until a helper of ``MAC_WS_FROM`` or
    newer checked in for this workspace, and while it isn't paused (one conditional write). Returns the helper item."""
    item = helper_item(store, user_id, workspace_id)
    if item is None or not new_enough(item.get("version")):
        raise conflict(UPDATE_FIRST)
    try:
        return store.update_expr(
            _pk(user_id, workspace_id),
            ws.MACHELPER_SK,
            "SET #rq = :at",
            condition="#st = :paused",
            names={"#rq": "resumeRequestAt", "#st": "state"},
            values={":at": iso(now), ":paused": "paused"},
        )
    except db.ConditionFailed:
        raise conflict(NOT_PAUSED) from None


def clear_needs_you(store: db.Store, user_id: str, workspace_id: str, publishing_job_id: str) -> None:
    """The workspace's helper item goes back to ``ok`` when it needed the owner for this job: he answered it (Try
    again, or It's on TikTok), so the Mac goes on. Nothing changes otherwise (and Clip Factory's item never)."""
    with contextlib.suppress(db.ConditionFailed):
        store.update_expr(
            _pk(user_id, workspace_id),
            ws.MACHELPER_SK,
            "SET #st = :ok REMOVE #re, #nj, #ns",
            condition="#st = :nu AND #nj = :id",
            names={"#st": "state", "#re": "reason", "#nj": "needsYouJobId", "#ns": "needsYouStoryId"},
            values={":ok": "ok", ":nu": "needs_you", ":id": publishing_job_id},
        )


# --- the rules ---------------------------------------------------------------------------------------------------


def _beat(row: Mapping[str, Any]) -> datetime | None:
    return parse(row.get("macBeatAt")) or parse(row.get("macClaimedAt"))


def stuck(row: Mapping[str, Any], now: datetime) -> bool:
    """A Mac job still ``working`` that its Mac stopped working on: no beat for ``MAC_BEAT_STALE`` or a claim
    ``MAC_CLAIM_MAX`` old (every helper of ``MAC_WS_FROM`` or newer beats its jobs)."""
    if row.get("publishingStatus") != publish.MAC_STATUS or row.get("macState") != "working":
        return False
    beat = _beat(row)
    claimed = parse(row.get("macClaimedAt"))
    return (beat is not None and now - beat >= MAC_BEAT_STALE) or (
        claimed is not None and now - claimed >= MAC_CLAIM_MAX
    )


def beat_fresh(row: Mapping[str, Any], now: datetime) -> bool:
    beat = _beat(row)
    return beat is not None and now - beat < MAC_BEAT_STALE


def window_over(row: Mapping[str, Any], now: datetime) -> bool:
    """The find window after Post was pressed is over (or Post was never pressed)."""
    pressed = parse(row.get("macPressedAt"))
    return pressed is None or now - pressed >= MAC_FIND_WINDOW


def _claimable(row: Mapping[str, Any], now: datetime) -> bool:
    """What the claim's condition says, as read: waiting and never pressed, or a crashed claim never pressed."""
    if row.get("publishingStatus") != publish.MAC_STATUS or row.get("macPressedAt"):
        return False
    if row.get("macState") == "waiting":
        return True
    beat = parse(row.get("macBeatAt"))
    return row.get("macState") == "working" and beat is not None and beat < now - STALE_CLAIM


def _claim_condition(now: datetime) -> db.Condition:
    return db.Condition(
        "(#mState = :mWaiting AND attribute_not_exists(#mPressed))"
        " OR (#mState = :mWorking AND attribute_not_exists(#mPressed) AND #mBeat < :mStale)",
        {"#mState": "macState", "#mPressed": "macPressedAt", "#mBeat": "macBeatAt"},
        {":mWaiting": "waiting", ":mWorking": "working", ":mStale": iso(now - STALE_CLAIM)},
    )


def owns(row: Mapping[str, Any], device: str, states: Iterable[str], attempt: int | None = None) -> bool:
    """The Mac job is ``device``'s claim, in one of ``states`` (and of ``attempt``, when the helper sends it)."""
    if row.get("publishingStatus") != publish.MAC_STATUS:
        return False
    if row.get("macDevice") != device or row.get("macState") not in tuple(states):
        return False
    return attempt is None or row.get("macAttempt") == attempt


def _claim_of(device: str, states: list[str], attempt: int | None) -> dict[str, list[Any]]:
    expect: dict[str, list[Any]] = {"publishingStatus": [publish.MAC_STATUS], "macState": states, "macDevice": [device]}
    if attempt is not None:
        expect["macAttempt"] = [attempt]
    return expect


def _row(store: db.Store, user_id: str, workspace_id: str, publishing_job_id: str) -> Item:
    found = publish.job_item(store, user_id, workspace_id, publishing_job_id)
    if found is None:
        raise not_found(NOT_FOUND)
    return found


def _mac_row(store: db.Store, user_id: str, workspace_id: str, publishing_job_id: str) -> Item:
    found = _row(store, user_id, workspace_id, publishing_job_id)
    if found.get("publishingStatus") != publish.MAC_STATUS:
        raise conflict(NOT_MAC)
    return found


def _write(store: db.Store, row: Mapping[str, Any], request: Mapping[str, Any], refusal: str = MAC_TAKEN) -> Item:
    """One conditional write of a Mac job; the job as written. A changed job is ``409`` with ``refusal``."""
    try:
        store.transact(updates=[request])
    except db.ConditionFailed:
        raise conflict(refusal) from None
    return store.get(str(row["pk"]), str(row["sk"])) or dict(row)


def link_of(raw: Any) -> tuple[str, str]:
    """A TikTok video link → (its ``@name`` without the @, the canonical link). ``400`` when it isn't one."""
    found = LINK.match(raw) if isinstance(raw, str) else None
    if found is None:
        raise bad_request(BAD_LINK, "link")
    name, video_id = found.group(2), found.group(3)
    return name, f"https://www.tiktok.com/@{name}/video/{video_id}"


def _same_handle(name: str, handle: Any) -> bool:
    return isinstance(handle, str) and handle.lstrip("@").lower() == name.lower()


def _wrong_account() -> ApiError:
    return ApiError(409, "wrong_account", WRONG_ACCOUNT)


# --- the helper's routes ----------------------------------------------------------------------------------------


def _claim_reason(problem: DestinationProblem) -> str:
    if problem.kind == "changed":
        return ACCOUNT_CHANGED
    if problem.kind == "story":
        return VIDEO_GONE
    if problem.kind in RECONNECT_KINDS:
        return NOT_CONNECTED
    return problem.sentence  # Clip Factory's own account, or one Clips Funded cannot tell apart: its own sentence


def _destination_problem(scope: Scope, row: Mapping[str, Any], now: datetime) -> tuple[str | None, Item | None]:
    """Why the job may not go to its account now (None when it may), and its story."""
    try:
        destination = validate_destination(
            scope.store, scope.secrets, scope.user_id, scope.workspace_id, row, at_tap=False, now=now
        )
    except DestinationProblem as e:
        return _claim_reason(e), None
    stored = destination.account.get("handle")
    recorded = str(row.get("handle") or "")
    if not recorded or not publish.MAC_HANDLE.match(recorded) or not _same_handle(recorded.lstrip("@"), stored):
        return ACCOUNT_CHANGED, destination.story
    return None, destination.story


def claim(
    scope: Scope, workspace: Mapping[str, Any], publishing_job_id: str, *, device: str, version: str, now: datetime
) -> Item:
    """The helper takes a Mac job: one conditional write, so one Mac and one try at a time (waiting and never
    pressed, or working and never pressed with no beat for ``STALE_CLAIM``). Before it, the destination is checked;
    a job that may not go to its account is stopped with the reason, in one conditional write."""
    store, user_id, workspace_id = scope.store, scope.user_id, scope.workspace_id
    row = _mac_row(store, user_id, workspace_id, publishing_job_id)
    if not is_on(workspace):
        raise conflict(MAC_OFF_WS)
    if not new_enough(version):
        raise ApiError(409, "mac_old", MAC_OLD)
    if not _claimable(row, now):
        raise conflict(MAC_TAKEN)
    reason, story = _destination_problem(scope, row, now)
    if reason is not None:
        stop = db.update_request(
            str(row["pk"]),
            str(row["sk"]),
            {"macState": "stopped", "macStoppedAt": iso(now), "macReason": reason, "updatedAt": iso(now)},
            remove=[k for k in ("macStep", "macClaimedAt", "macDevice", "macBeatAt") if k in row],
            expect_in={"publishingStatus": [publish.MAC_STATUS]},
            also=_claim_condition(now),
        )
        _write(store, row, stop)
        log("warning", "ws_mac.stopped_at_claim", publishingJobId=publishing_job_id)
        raise conflict(reason)
    fields: Item = {
        "macState": "working",
        "macClaimedAt": iso(now),
        "macDevice": device,
        "macBeatAt": iso(now),
        "macStep": "video",
        "macAttempt": _attempt(row) + 1,
        "updatedAt": iso(now),
    }
    request = db.update_request(
        str(row["pk"]),
        str(row["sk"]),
        fields,
        remove=[k for k in ("macStoppedAt", "macReason") if k in row],
        expect_in={"publishingStatus": [publish.MAC_STATUS]},
        also=_claim_condition(now),
    )
    written = _write(store, row, request)
    log("info", "ws_mac.claimed", publishingJobId=publishing_job_id, attempt=written.get("macAttempt"))
    return job(written, story)


def step(
    store: db.Store,
    user_id: str,
    workspace: Mapping[str, Any],
    publishing_job_id: str,
    *,
    device: str,
    name: str,
    attempt: int | None,
    now: datetime,
) -> Item:
    """The helper's progress, only from the device that claimed the job while it works on it; the same step sent
    again is the job's beat. The first ``pressing`` sets ``macPressedAt``. While the switch is off nothing before Post
    goes on (``MAC_OFF_WS``); after Post the helper may still look for the link."""
    workspace_id = str(workspace["workspaceId"])
    row = _mac_row(store, user_id, workspace_id, publishing_job_id)
    if not owns(row, device, ("working",), attempt):
        raise conflict(MAC_TAKEN)
    if not is_on(workspace) and not row.get("macPressedAt"):
        raise conflict(MAC_OFF_WS)
    fields: Item = {"macStep": name, "macBeatAt": iso(now), "updatedAt": iso(now)}
    pressed = name == "pressing" and not row.get("macPressedAt")
    if pressed:
        fields["macPressedAt"] = iso(now)
    request = db.update_request(
        str(row["pk"]), str(row["sk"]), fields, expect_in=_claim_of(device, ["working"], attempt)
    )
    written = _write(store, row, request)
    if pressed:
        log("info", "ws_mac.pressing", publishingJobId=publishing_job_id)
    return job(written, _story_of(store, user_id, workspace_id, written))


def stopped(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    publishing_job_id: str,
    *,
    device: str,
    reason: str,
    needs_you: bool,
    attempt: int | None,
    now: datetime,
) -> Item:
    """The helper stopped instead of guessing: the job says why (at most 200 characters; once Post was pressed
    always ``PRESSED``). ``needs_you`` puts this workspace's helper item in ``needs_you`` with the job and its story
    (never Clip Factory's helper item)."""
    row = _mac_row(store, user_id, workspace_id, publishing_job_id)
    if not owns(row, device, ("working", "stopped"), attempt):
        raise conflict(MAC_TAKEN)
    said = _reason(reason)
    fields: Item = {
        "macState": "stopped",
        "macStoppedAt": iso(now),
        "macReason": PRESSED if row.get("macPressedAt") else said,
        "updatedAt": iso(now),
    }
    request = db.update_request(
        str(row["pk"]), str(row["sk"]), fields, expect_in=_claim_of(device, ["working", "stopped"], attempt)
    )
    written = _write(store, row, request)
    if needs_you:
        store.update_expr(
            _pk(user_id, workspace_id),
            ws.MACHELPER_SK,
            "SET #st = :st, #re = :re, #se = :se, #de = :de, #ty = :ty, #us = :us, #ws = :ws, #nj = :nj, #ns = :ns",
            names={
                "#st": "state",
                "#re": "reason",
                "#se": "seenAt",
                "#de": "device",
                "#ty": "type",
                "#us": "userId",
                "#ws": "workspaceId",
                "#nj": "needsYouJobId",
                "#ns": "needsYouStoryId",
            },
            values={
                ":st": "needs_you",
                ":re": said,
                ":se": iso(now),
                ":de": device,
                ":ty": ws.TYPE_MACHELPER,
                ":us": user_id,
                ":ws": workspace_id,
                ":nj": publishing_job_id,
                ":ns": str(row.get("contentId") or ""),
            },
        )
    log("info", "ws_mac.stopped", publishingJobId=publishing_job_id, pressed=bool(row.get("macPressedAt")))
    return job(written, _story_of(store, user_id, workspace_id, written))


# --- posted: the Mac's done and the owner's It's on TikTok ---------------------------------------------------------


Check = Callable[[Item], dict[str, list[Any]] | None]


def _finish(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    row: Item,
    *,
    url: str | None,
    by_you: bool,
    check: Check,
    now: datetime,
) -> Item:
    """The job becomes ``posted`` (``via: "mac"``, or ``by: "you"``) with its link, its Mac fields gone, and the
    story gets the post (``story_posted``) with its ``ACT#``, all in one transaction. ``check`` gives the job's
    condition as read (``ApiError`` when it may not be marked; None when it already is: answered as it is). A story
    written meanwhile is read again (a few times)."""
    pk = _pk(user_id, workspace_id)
    for _ in range(STORY_TRIES):
        expect = check(row)
        if expect is None:
            return row
        fields: Item = {"publishingStatus": "posted", "postedAt": iso(now), "privacy": "public", "updatedAt": iso(now)}
        fields["by" if by_you else "via"] = "you" if by_you else "mac"
        if url:
            fields["url"] = url
        remove = [k for k in (*publish.MAC_FIELDS, "error") if k in row]
        updates = [db.update_request(pk, str(row["sk"]), fields, remove=remove, expect_in=expect)]
        story = _story_of(store, user_id, workspace_id, row)
        title = str((story or {}).get("title") or "")
        if story is not None:
            # A post handed over from Only me: its private link on the story makes way for this one (one TikTok link).
            before = row.get("beforeMac")
            private = before.get("url") if isinstance(before, Mapping) and isinstance(before.get("url"), str) else None
            write = story_posted.story_write(story, "tiktok", url or "", iso(now), now, replace=private)
            if write is not None:
                updates.append(write.request(pk, str(story["sk"])))
        act = story_posted.activity(
            pk,
            row,
            "posted",
            user_id=user_id,
            workspace_id=workspace_id,
            story_id=str(row.get("contentId") or ""),
            at=iso(now),
            title=title,
            now=now,
        )
        try:
            store.transact(updates=updates, puts=[act])
        except db.ConditionFailed:
            fresh = store.get(pk, str(row["sk"]))
            if fresh is None:
                raise not_found(NOT_FOUND) from None
            row = fresh
            continue
        return store.get(pk, str(row["sk"])) or {**row, **fields}
    raise conflict(CHANGED)


def done(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    publishing_job_id: str,
    *,
    device: str,
    link: str,
    attempt: int | None,
    now: datetime,
) -> Item:
    """The Mac posted it: only the job its device (and attempt) claimed, while it works on it or after it stopped,
    and only with a link on the job's own account (``wrong_account`` otherwise, nothing written). A repeat is answered
    as the first. No finder and no TikTok call: the link is the proof."""
    row = _row(store, user_id, workspace_id, publishing_job_id)
    name, url = link_of(link)
    if not _same_handle(name, row.get("handle")):
        log("warning", "ws_mac.wrong_account", publishingJobId=publishing_job_id)
        raise _wrong_account()

    def check(current: Item) -> dict[str, list[Any]] | None:
        if current.get("publishingStatus") == "posted" and current.get("via") == "mac":
            return None  # a repeat of the Mac's done
        if current.get("publishingStatus") != publish.MAC_STATUS:
            raise conflict(NOT_MAC)
        if not owns(current, device, ("working", "stopped"), attempt):
            raise conflict(MAC_TAKEN)
        return _claim_of(device, ["working", "stopped"], attempt)

    written = _finish(store, user_id, workspace_id, row, url=url, by_you=False, check=check, now=now)
    log("info", "ws_mac.done", publishingJobId=publishing_job_id)
    return written


def posted(
    store: db.Store, user_id: str, workspace_id: str, publishing_job_id: str, *, link: str | None, now: datetime
) -> Item:
    """The owner's It's on TikTok: allowed while the Mac job waits or stopped, or works on it once stuck; without a
    link never on a job the Mac works on and never pressed Post for (it isn't on TikTok). A link must be on the job's
    own account. Marking a posted job again only changes its link."""
    row = _row(store, user_id, workspace_id, publishing_job_id)
    url: str | None = None
    if link is not None:
        name, url = link_of(link)
        if not _same_handle(name, row.get("handle")):
            raise _wrong_account()
    if row.get("publishingStatus") == "posted" and (row.get("by") == "you" or row.get("via") == "mac"):
        if url and row.get("url") != url:
            update = db.update_request(
                str(row["pk"]),
                str(row["sk"]),
                {"url": url, "updatedAt": iso(now)},
                expect_in={"publishingStatus": ["posted"]},
            )
            return _write(store, row, update, CHANGED)
        return row
    answered = row.get("macState") in ("stopped", "working")

    def check(current: Item) -> dict[str, list[Any]] | None:
        if current.get("publishingStatus") == "posted" and (current.get("by") == "you" or current.get("via") == "mac"):
            return None  # marked meanwhile (his other tap, or the Mac's done)
        if current.get("publishingStatus") != publish.MAC_STATUS:
            raise conflict(NOT_MAC)
        state = current.get("macState")
        if state == "working":
            if not stuck(current, now):
                raise conflict(MAC_WORKING)
            if url is None and not current.get("macPressedAt"):
                raise conflict(MAC_WORKING if beat_fresh(current, now) else MAC_NOT_PRESSED)
            expect: dict[str, list[Any]] = {
                "publishingStatus": [publish.MAC_STATUS],
                "macState": ["working"],
                "macClaimedAt": [str(current.get("macClaimedAt"))],
            }
            for key in ("macBeatAt", "macPressedAt"):
                if current.get(key):
                    expect[key] = [str(current[key])]
            return expect
        return {"publishingStatus": [publish.MAC_STATUS], "macState": ["waiting", "stopped"]}

    written = _finish(store, user_id, workspace_id, row, url=url, by_you=True, check=check, now=now)
    if answered:
        clear_needs_you(store, user_id, workspace_id, publishing_job_id)
    log("info", "ws_mac.posted_by_you", publishingJobId=publishing_job_id, link=url is not None)
    return written


# --- the owner's Try again ----------------------------------------------------------------------------------------


def retry(scope: Scope, publishing_job_id: str, *, not_on_tiktok: bool, confirm: str | None, now: datetime) -> Item:
    """The owner's Try again on a Mac job's row: a stopped job, or a stuck one, waits for the Mac again (keeping its
    place, ``since``); a job the Mac still works on is refused. After Post was pressed only when he says it is not on
    TikTok and once the find window is over: the press moves to ``macPressedBefore`` and ``macAgainAt`` says when he
    tried again (the helper's never-twice guard). The account is checked as at Post it: when it changed since the job
    was recorded, the ``409`` names it, and with ``confirm`` equal to it the new identity is recorded. One write,
    conditional on the job as read; then the workspace's helper item goes back to ``ok`` when it needed him for this
    job."""
    store, user_id, workspace_id = scope.store, scope.user_id, scope.workspace_id
    row = _mac_row(store, user_id, workspace_id, publishing_job_id)
    state = row.get("macState")
    is_stuck = stuck(row, now)
    if state == "working" and not is_stuck:
        raise conflict(MAC_WORKING)
    if state not in ("stopped", "working"):
        return row  # it already waits
    pressed = row.get("macPressedAt")
    if pressed and not not_on_tiktok:
        raise conflict(MAY_HAVE_POSTED)
    if pressed and not window_over(row, now):
        raise conflict(MAC_STILL_LOOKING)
    target = {"platform": "tiktok", "socialAccountId": row.get("socialAccountId"), "contentId": row.get("contentId")}
    destination = publish._check(store, scope.secrets, user_id, workspace_id, target, now=now, confirm=confirm)
    fields: Item = {"macState": "waiting", "macAgainAt": iso(now), "macSource": "upload", "updatedAt": iso(now)}
    if destination.external_account_id != row.get("externalAccountId"):
        if confirm != destination.external_account_id:
            raise publish._changed_account("tiktok", destination)
        fields["externalAccountId"] = destination.external_account_id
    fields["handle"] = publish.mac_handle(destination)  # the same open_id: its current @name
    fields["accountName"] = destination.account_name
    cleared = ["macStep", "macClaimedAt", "macStoppedAt", "macReason"]
    if pressed:
        fields["macPressedBefore"] = str(pressed)
        cleared.append("macPressedAt")
    if is_stuck:
        cleared += ["macDevice", "macBeatAt"]  # the stuck claim is gone: the Mac claims it afresh
    expect: dict[str, list[Any]] = {"publishingStatus": [publish.MAC_STATUS], "macState": [str(state)]}
    for key in ("macPressedAt", "macClaimedAt", "macBeatAt") if is_stuck else ("macPressedAt",):
        if row.get(key):
            expect[key] = [str(row[key])]
    update = db.update_request(
        str(row["pk"]), str(row["sk"]), fields, remove=[k for k in cleared if k in row], expect_in=expect
    )
    confirmed = [confirm_not_clips_update(destination, now)] if destination.confirms_not_clips else []
    try:
        store.transact(updates=[update, *confirmed])
    except db.ConditionFailed:
        raise conflict(CHANGED) from None
    clear_needs_you(store, user_id, workspace_id, publishing_job_id)
    log("info", "ws_mac.retry", publishingJobId=publishing_job_id, notOnTikTok=not_on_tiktok)
    return store.get(str(row["pk"]), str(row["sk"])) or {**row, **fields}
