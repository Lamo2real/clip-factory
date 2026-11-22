"""Which clips auto-posting takes next, and where they go (docs/CONTRACTS.md §46.5, §46.6).

Candidates are the owner's clips in Review, oldest first by their job's ``createdAt`` (the clip's own when the job is
gone), then ``rank`` (best first), then ``clipId``. A candidate is **taken** unless one of the rules below holds, in
this order; then it **waits** for the owner, with the reason he sees:

1. Its job exists and is not ``ready``.
2. It has no video.
3. An important check failed (one the agent drops clips for, §8; mostly ``campaign_rules`` that could not be checked).
4. It is for a campaign, and Content Rewards can't take it from Clip Factory by itself (§38.6): it goes only when
   Content Rewards is on and connected, the owner is ``in`` the campaign (not ``manual``), the campaign takes clips,
   it has places and the fit check passes; then it goes the campaign way (§38.14).
5. A run that is still going (an ``AUTORUN#`` item still ``planned`` within 15 minutes of its ``plannedAt``) has it:
   skipped silently, so two runs never take the same clip.

Before all of these, a clip the owner is throwing away right now (a Throw away's hold, ``holdUntil`` still in the future,
§46.2) is left out silently: not a candidate, neither taken nor waiting, so the next clip takes its turn.

Places of a normal clip: every platform ready on Set up posting except TikTok (TikTok's rules want the creator's own
pick for each post, §17.8), in STATS_ORDER; Settings › Where clips go is not read (Upload ignores it too, §33).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .. import clips, db
from ..app import App
from ..clock import parse
from ..errors import ApiError
from ..oauth import setup as platform_setup
from ..posts import UPLOAD_ORDER
from . import RUN_PREFIX

Item = dict[str, Any]

# §46.5 rule 3: the checklist keys the agent drops clips for (§8).
IMPORTANT_CHECKS = frozenset({"hear", "moving", "zero_context", "payoff", "campaign_rules", "logo", "disclosure"})
STILL_MAKING = "It is still being made."
NO_VIDEO = "Its video is missing."
CR_CANT = "It's for a campaign, and Content Rewards can't take clips from Clip Factory by itself yet."
BY_HAND = "It's for a campaign you send by hand."
NOTHING_SET_UP = "Nothing is set up to post to."
PLANNED_FRESH = timedelta(minutes=15)
RECENT_RUNS = 10  # the planned runs rule 5 looks at (one run an hour at most, and test runs one a minute)
NEXT_UP_MAX = 10
WAITING_MAX = 20


def check_failed(label: str) -> str:
    return f"A check didn't pass: {label}."


@dataclass(frozen=True)
class Taken:
    clip: Item
    places: tuple[str, ...]
    campaign: bool = False


@dataclass(frozen=True)
class Waiting:
    clip: Item
    reason: str


@dataclass
class Picked:
    """What a run (or the page) sees now: how many clips are in Review (a held one not counted), the ones taken (in
    order) and the ones that wait, and a normal clip's places."""

    candidates: int = 0
    taken: list[Taken] = field(default_factory=list)
    waiting: list[Waiting] = field(default_factory=list)
    places: list[str] = field(default_factory=list)


def places_now(setups: list[Item]) -> list[str]:
    """A normal clip's places (§46.6): ready on Set up posting, never TikTok, in STATS_ORDER."""
    ready = {s.get("platform") for s in setups if s.get("ready")}
    return [p for p in UPLOAD_ORDER if p in ready and p != "tiktok"]


def left_out(places: list[str]) -> list[Item]:
    """The places a run leaves out and why (§46.9 ``leftOut``): TikTok always (Post it yourself), the rest not set up."""
    return [
        {"platform": p, "reason": "tiktok_yourself" if p == "tiktok" else "not_set_up"}
        for p in UPLOAD_ORDER
        if p not in places
    ]


def ordered(store: db.Store, user_id: str, found: list[Item]) -> list[Item]:
    """The clips in Review, oldest first by their job's ``createdAt`` (the clip's own when the job is gone), then
    ``rank`` (best first), then ``clipId``. Their jobs come with them, under the internal ``_job`` key."""
    review = [c for c in found if c.get("type") == "clip" and c.get("status") == "review" and c.get("clipId")]
    job_ids = sorted({str(c["jobId"]) for c in review if c.get("jobId")})
    pk = db.user_pk(user_id)
    jobs = {str(j.get("jobId")): j for j in store.batch_get((pk, db.job_sk(i)) for i in job_ids) if j.get("jobId")}

    def key(clip: Item) -> tuple[str, float, str]:
        job = jobs.get(str(clip.get("jobId") or ""))
        made = str((job or {}).get("createdAt") or clip.get("createdAt") or "")
        rank = clip.get("rank", 0)
        return made, float(rank) if isinstance(rank, int | float) else 0.0, str(clip["clipId"])

    review.sort(key=key)
    return [{**c, "_job": jobs.get(str(c.get("jobId") or ""))} for c in review]


def busy(store: db.Store, user_id: str, now: datetime) -> set[str]:
    """Rule 5: the clips of runs still going (``planned``, within 15 minutes of when they planned: ``plannedAt``, or
    the slot ``at`` on runs stored before it existed). A tick that arrives late in its hour still protects its clips."""
    page = store.query_page(db.user_pk(user_id), RUN_PREFIX, newest_first=True, limit=RECENT_RUNS, consistent=True)
    out: set[str] = set()
    for run in page.items:
        planned_at = parse(run.get("plannedAt")) or parse(run.get("at"))
        if run.get("state") != "planned" or planned_at is None or now - planned_at > PLANNED_FRESH:
            continue
        out.update(str(c.get("clipId")) for c in run.get("clips") or [] if isinstance(c, Mapping))
    return out


def _plain_reason(clip: Item) -> str | None:
    """Rules 1 to 3."""
    job = clip.get("_job")
    if isinstance(job, Mapping) and job.get("status") != "ready":
        return STILL_MAKING
    if not clip.get("videoKey"):
        return NO_VIDEO
    checklist = clip.get("checklist")
    items = checklist.get("items") if isinstance(checklist, Mapping) else None
    for check in items or []:
        if isinstance(check, Mapping) and check.get("key") in IMPORTANT_CHECKS and check.get("pass") is False:
            return check_failed(str(check.get("label") or check.get("key")))
    return None


@dataclass
class _Context:
    app: App
    user_id: str
    setups: list[Item]
    normal: list[str]
    crconn: Mapping[str, Any]

    @property
    def linked(self) -> Any:
        return self.crconn.get("crLinked")


def _campaign(ctx: _Context, clip: Item) -> tuple[bool, str | None, list[str]]:
    """Rule 4: (is a campaign clip, the reason it waits or None, its places)."""
    from ..routes import clips as checks  # Upload's campaign rules (§38.14)

    plain = {k: v for k, v in clip.items() if k != "_job"}
    campaign = checks.campaign_clip(ctx.app, ctx.user_id, plain)
    if campaign is None:
        return False, None, ctx.normal
    if getattr(ctx.app, "contentrewards", None) is None or ctx.crconn.get("status") != "connected":
        return True, CR_CANT, []
    if campaign.item is not None and campaign.item.get("membership") == "manual":
        return True, BY_HAND, []
    try:
        checks._require_campaign_open(ctx.app, campaign)
    except ApiError as e:
        return True, e.message, []
    refusals = [checks._place_refusal(p, campaign, ctx.setups, ctx.linked) for p in ctx.normal]
    places = [p for p, refusal in zip(ctx.normal, refusals, strict=True) if refusal is None]
    if not places:
        return True, next((r for r in refusals if r), NOTHING_SET_UP), []
    try:
        checks._require_fit(ctx.app, ctx.user_id, plain, chosen=places)
    except ApiError as e:
        return True, e.message, []
    return True, None, places


def pick(
    app: App,
    user_id: str,
    now: datetime,
    *,
    found: list[Item] | None = None,
    limit: int | None = None,
    normal_only: bool = False,
) -> Picked:
    """The clips in Review, taken or waiting. ``found`` is the owner's clips when the caller read them already.
    ``limit`` stops once that many are taken (a run needs only its own). ``normal_only`` takes no campaign clip (a
    Private test run: a campaign post is never sent to Content Rewards as a test)."""
    store = app.store
    pk = db.user_pk(user_id)
    every = ordered(store, user_id, found if found is not None else clips.all_clips(store, user_id))
    # Being thrown away (§46.2): neither counted, taken nor waiting, so the next clip takes its turn and a run whose only
    # clips are held says "Nothing in Review, so nothing posted." (not that they wait for him: Waiting leaves them out).
    candidates = [c for c in every if not clips.is_held(c, now)]
    setups = platform_setup.all_setups(store, user_id, now)
    normal = places_now(setups)
    out = Picked(candidates=len(candidates), places=normal)
    if not candidates:
        return out
    ctx = _Context(app, user_id, setups, normal, store.get(pk, db.CRCONN_SK) or {})
    taken_by_others = busy(store, user_id, now)
    for clip in candidates:
        if limit is not None and len(out.taken) >= limit:
            break
        plain = {k: v for k, v in clip.items() if k != "_job"}
        reason = _plain_reason(clip)
        is_campaign, places = False, normal
        if reason is None:
            is_campaign, reason, places = _campaign(ctx, clip)
        if reason is not None:
            out.waiting.append(Waiting(plain, reason))
            continue
        if str(clip["clipId"]) in taken_by_others or (normal_only and is_campaign):
            continue
        out.taken.append(Taken(plain, tuple(places), is_campaign))
    return out
