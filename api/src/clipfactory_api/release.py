"""Waiting posts go out once their place is connected (docs/CONTRACTS.md §17.6, §33.3, §33.6).

A post is ``pending_integration`` when its place had no connected account at Confirm, or when the clip flow found the
account gone (``NotConnectedError``). ``release_waiting`` keeps the Library's promise "Posts once these accounts are
connected": it runs right after an account becomes ``connected`` (the OAuth callback in ``cf-prod-hooks``, the Meta
account pick and Check it in ``cf-prod-api``) and, per clip, does what Try again does: the waiting posts go back to
``queued`` in one transaction with a new flow run on the clip, then ``clip-{clipId}-{flowRun}`` starts. A Content
Rewards campaign post (``campaignId``) is never released by itself: it waits for Post now, which goes through Try
again and the fit check (§39.3), so it never goes up days later after the campaign ended or was held.

``restart`` and ``start_flow`` are shared with ``routes/clips.py`` (Confirm and Try again), so both Lambdas write the
same conditional updates. Everything here is safe to repeat: the writes are conditional on the states read, and a flow
start is idempotent on its execution name. Every post a run sends carries that run's number (``flowRun`` on the post,
internal): a run only sends its own posts, so a second Post now or release while an earlier run is still uploading
starts a run for the new place only and never sends a video twice.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Protocol

from . import clips, db, posts
from .flow_client import FlowStartError, Started
from .log import log

Item = dict[str, Any]

# Only a clip the owner uploaded and whose flow has settled (or never ran) gets its waiting posts released. ``review``
# was never uploaded; ``publishing`` is still running its flow, which skipped the waiting post: Post now does it later.
RELEASABLE = ("posted", "confirmed", "failed")
# The owner waits for the answer while this runs (cf-prod-hooks stops at 28 s, API Gateway waits 29 s): the last clip
# must be done this long after the request began.
ANSWER_SECONDS = 25.0
# The longest one clip can take: its flow start (the Lambda client tries twice, 2 s to connect and 6 s to read each)
# and its few DynamoDB calls. A clip only starts while this much time is left; the clips left still wait, and the
# Library offers Post now for them.
CLIP_SECONDS = 18.0


class ClipFlowStarter(Protocol):
    def start_clip_flow(self, clip_id: str, user_id: str, run: int) -> Started: ...


def start_flow(store: db.Store, flows: ClipFlowStarter, clip: Mapping[str, Any]) -> Item:
    """Starts ``clip-{clipId}-{flowRun}``; on success the clip becomes ``publishState: started``. A failed start
    leaves it ``pending``, so the next Confirm (or the next release) starts it again."""
    run = int(clip.get("flowRun") or 1)
    try:
        started = flows.start_clip_flow(str(clip["clipId"]), str(clip["userId"]), run)
    except (FlowStartError, ValueError) as e:
        log("error", "clip.flow_start_failed", clipId=clip["clipId"], run=run, error=str(e))
        return dict(clip)
    fields: Item = {"publishState": clips.PUBLISH_STARTED, "flowRun": run}
    if started.execution_arn:
        fields["flowExecutionArn"] = started.execution_arn
    expect: Item = {"publishState": [clips.PUBLISH_PENDING]}
    if clip.get("flowRun"):
        expect["flowRun"] = [run]  # a clip kept before flow runs existed has none yet
    try:
        updated = store.update(str(clip["pk"]), str(clip["sk"]), fields, expect_in=expect)
    except db.ConditionFailed:
        return store.get(str(clip["pk"]), str(clip["sk"])) or dict(clip)
    log("info", "clip.flow_started", clipId=clip["clipId"], flow=started.name, existed=started.execution_arn is None)
    return updated


def restart(
    store: db.Store,
    flows: ClipFlowStarter,
    clip: Mapping[str, Any],
    chosen: Iterable[Mapping[str, Any]],
    *,
    clip_posts: Iterable[Mapping[str, Any]] = (),
    tiktok: Mapping[str, Any] | None = None,
    event: str = "clip.try_again",
) -> Item:
    """``chosen`` posts (``failed`` or ``pending_integration``) go back to ``queued`` and a new flow run starts. One
    transaction sets the posts (each conditional on the status it was read with; ``flowRun: run + 1``, so only the new
    run sends them; ``error`` and ``publishHandle`` removed, so an upload starts fresh, §17.6) and the clip
    (``flowRun + 1``, ``publishState: pending``; a ``failed`` clip becomes ``confirmed``, a ``posted`` or ``confirmed``
    one keeps its status). When the current run never started (``publishState: pending``), its ``queued`` posts among
    ``clip_posts`` (every post of the clip, as read) go to the new run too, upload handles kept. New TikTok sheet choices
    (``tiktok``) replace the TikTok post's ``postOptions``. A parallel Try again or release that won the race is
    finished instead (its flow start)."""
    picked = list(chosen)
    run = int(clip.get("flowRun") or 1)
    status = str(clip.get("status"))
    ids = {str(p.get("postId")) for p in picked}
    unstarted = clip.get("publishState") == clips.PUBLISH_PENDING
    carried = [
        p
        for p in clip_posts
        if unstarted
        and p.get("status") == "queued"
        and str(p.get("postId")) not in ids
        and int(p.get("flowRun") or run) == run
    ]
    expect: Item = {"status": [status], "flowRun": [run]} if clip.get("flowRun") else {"status": [status]}
    if carried:
        expect["publishState"] = [clips.PUBLISH_PENDING]  # a start that went through meanwhile keeps its posts
    clip_update = db.update_request(
        str(clip["pk"]),
        str(clip["sk"]),
        {
            "status": "confirmed" if status == "failed" else status,
            "publishState": clips.PUBLISH_PENDING,
            "flowRun": run + 1,
        },
        remove=["flowExecutionArn"],
        expect_in=expect,
    )
    post_updates = [
        db.update_request(
            str(p["pk"]),
            str(p["sk"]),
            {
                "status": "queued",
                "flowRun": run + 1,
                **({"postOptions": dict(tiktok)} if tiktok and p.get("platform") == "tiktok" else {}),
            },
            remove=["error", "publishHandle"],
            expect_in={"status": [str(p.get("status"))]},
        )
        for p in picked
    ]
    post_updates += [
        db.update_request(str(p["pk"]), str(p["sk"]), {"flowRun": run + 1}, expect_in={"status": ["queued"]})
        for p in carried
    ]
    try:
        store.transact(updates=[clip_update, *post_updates])
    except db.ConditionFailed:
        current = store.get(str(clip["pk"]), str(clip["sk"])) or dict(clip)
        if current.get("status") in {"confirmed", "posted"} and current.get("publishState") == clips.PUBLISH_PENDING:
            return start_flow(store, flows, current)  # a parallel Try again or release reset it; finish its start
        return current
    log(
        "info",
        event,
        clipId=clip["clipId"],
        run=run + 1,
        posts=len(picked),
        carried=len(carried),
        platforms=",".join(sorted({str(p["platform"]) for p in picked})),
    )
    refreshed = store.get(str(clip["pk"]), str(clip["sk"])) or dict(clip)
    return start_flow(store, flows, refreshed)


def has_tiktok_choice(post: Mapping[str, Any]) -> bool:
    """TikTok posts only with who-can-see-it picked by the owner (§17.8): a waiting TikTok post without that choice
    is never released on its own; Post now opens the TikTok sheet first."""
    options = post.get("postOptions")
    return isinstance(options, Mapping) and isinstance(options.get("privacyLevel"), str)


def release_waiting(
    store: db.Store,
    flows: ClipFlowStarter,
    user_id: str,
    platform: str,
    *,
    deadline: float | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    """Releases every ``pending_integration`` post of ``platform`` (but a campaign post, §39.3) whose clip is
    ``posted``, ``confirmed`` or ``failed``, when that platform's Account is ``connected``; returns how many clips started a new run. A clip of
    this platform whose earlier start did not go through (a ``queued`` post, ``publishState: pending``) gets its start
    finished. ``deadline`` (on ``clock``) is when the caller must answer, by default ``ANSWER_SECONDS`` from now: a
    clip only starts while ``CLIP_SECONDS`` are left. Never raises: a clip that fails is logged and skipped (the next
    release or Post now does it)."""
    if deadline is None:
        deadline = clock() + ANSWER_SECONDS
    try:
        # Strongly consistent: every caller wrote the Account as connected a moment ago.
        if posts.connected_account(store, user_id, platform, consistent=True) is None:
            return 0
        rows = store.query_all(db.user_pk(user_id), "POST#", consistent=True)
    except Exception as e:
        log("error", "release.read_failed", platform=platform, error=type(e).__name__)
        return 0
    by_clip: dict[str, list[Item]] = {}
    waiting: dict[str, list[Item]] = {}
    unstarted: set[str] = set()
    for p in rows:
        if p.get("type") != "post" or not p.get("clipId"):
            continue
        clip_id = str(p["clipId"])
        by_clip.setdefault(clip_id, []).append(p)
        if p.get("platform") != platform:
            continue
        if (
            p.get("status") == "pending_integration"
            and not p.get("campaignId")  # §39.3: a campaign post waits for Post now, which runs the fit check
            and (platform != "tiktok" or has_tiktok_choice(p))
        ):
            waiting.setdefault(clip_id, []).append(p)
        elif p.get("status") == "queued":
            unstarted.add(clip_id)
    pending = sorted(set(waiting) | unstarted)
    released = 0
    for n, clip_id in enumerate(pending):
        if clock() + CLIP_SECONDS > deadline:
            log("warning", "release.out_of_time", platform=platform, left=len(pending) - n)
            break
        try:
            clip = store.get(db.user_pk(user_id), db.clip_sk(clip_id))
            if clip is None or clip.get("status") not in RELEASABLE:
                continue
            if clip_id in waiting:
                restart(store, flows, clip, waiting[clip_id], clip_posts=by_clip[clip_id], event="clip.released")
                released += 1
            elif clip.get("publishState") == clips.PUBLISH_PENDING:
                start_flow(store, flows, clip)
        except Exception as e:  # one clip never stops the others, nor the connection that called this
            log("error", "release.clip_failed", clipId=clip_id, platform=platform, error=type(e).__name__)
    if released:
        log("info", "release.done", platform=platform, clips=released)
    return released
