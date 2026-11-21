"""``POST /v1/jobs`` with a ``campaignId`` (docs/CONTRACTS.md §38.5): the campaign is checked again and its rules are
copied onto the job (``Job.campaign``, internal ``JobCampaign``); the ready logo is copied to
``jobs/{jobId}/source/campaign-logo.{ext}`` so a later logo change never breaks a queued job.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .. import db, s3
from ..errors import ApiError, bad_request, conflict
from ..log import log
from . import campaigns, config, connection, gates, links, logo, public
from .deps import CrDeps
from .mcp import CrError
from .util import obj

Item = dict[str, Any]
CHANGED = "The brand changed the rules. I'm reading them again. This takes about 30 seconds."
FOOTAGE_ONLY = "This campaign only pays for clips from its own videos. Pick one on the campaign page."
NOT_CHECKED = "Couldn't check the campaign just now."
RETRY_AFTER = 30


def _retry(message: str) -> ApiError:
    return ApiError(409, "conflict", message, extra={"retryAfter": RETRY_AFTER})


def _same_link(a: str, b: str) -> bool:
    return links.normalize_post_url(a) == links.normalize_post_url(b)


def prepare(  # noqa: PLR0917 (one call site: the job route)
    deps: CrDeps, user_id: str, campaign_id: Any, anyway: Any, source: Mapping[str, Any], job_id: str, now: datetime
) -> tuple[Item, str | None]:
    """``(JobCampaign, campaignNote or None)``, or the refusal of §38.5 as an ``ApiError``."""
    if not isinstance(campaign_id, str) or not links.UUID.match(campaign_id):
        raise bad_request("campaignId must be a campaign id.", "campaignId")
    if anyway is not None and (not isinstance(anyway, list) or not all(isinstance(c, str) for c in anyway)):
        raise bad_request("campaignAnyway must list stop codes.", "campaignAnyway")
    item = campaigns.get_or_404(deps.store, user_id, campaign_id)
    hash_before = item.get("briefHash")
    conn = connection.load(deps.store, user_id)
    note = None if _fresh(deps, user_id, item, conn, now) else NOT_CHECKED
    if campaigns.retry_read(item, now):
        campaigns.start_read(deps, user_id, item, now)  # a failed (or stuck) read is tried again: 409 below
    accepted = sorted(
        {*(str(c) for c in item.get("anyway") or []), *(str(c) for c in anyway or [])}
        & (gates.SOFT - {"not_connected"})
    )
    item["anyway"] = accepted
    if item.get("rulesState") == "reading" and item.get("briefHash") != hash_before and hash_before:
        campaigns.save(deps, user_id, item)
        raise _retry(CHANGED)
    campaigns.save(deps, user_id, item)
    view = campaigns.View(deps, user_id, now)
    places = view.places(item)
    stops = gates.stops(item, view.conn, places, now)
    if item.get("rulesState") == "reading":
        raise _retry("Reading the rules… (about 30 seconds)")
    hard = [s for s in stops if s["hard"]]
    if hard:
        raise conflict(hard[0]["text"])
    soft = [s for s in stops if not s["hard"] and s["code"] != "not_connected" and not s.get("anyway")]
    if soft:
        raise conflict(" ".join(s["text"] for s in soft))
    rules_now = obj(item.get("rules"))
    allowed = obj(rules_now.get("allowedSources"))
    if allowed.get("campaignProvidedOnly") and source.get("type") == "link":
        videos = [str(v.get("url")) for v in rules_now.get("sourceVideos") or [] if isinstance(v, Mapping)]
        if not any(_same_link(str(source.get("url")), v) for v in videos):
            raise bad_request(FOOTAGE_ONLY, "source")
    snapshot = campaigns.snapshot(item, places, now)
    if gates.logo_needed(item):
        target = copy_logo(deps.media, item, job_id)
        if target is not None:
            snapshot["logoKey"] = target
    return snapshot, note


def copy_logo(media: s3.Media | None, item: Mapping[str, Any], job_id: str) -> str | None:
    """The campaign's logo copied to ``jobs/{jobId}/source/campaign-logo.{ext}`` (§38.11); the copy's key, or None
    when the campaign has no logo (or there is no bucket)."""
    logo_key = item.get("logoKey")
    if not isinstance(logo_key, str) or not logo_key or media is None:
        return None
    ext = logo.ext_of(logo_key)
    target = logo.job_logo_key(job_id, ext)
    data = media.read(logo_key, config.LOGO_MAX_BYTES)
    media.put(target, data, logo.CONTENT_TYPES.get(ext, "image/png"))
    return target


def logo_again(store: db.Store, media: s3.Media | None, user_id: str, job: Mapping[str, Any]) -> Item | None:
    """Try again on a campaign job: the campaign's logo as it is now is copied onto the job again (the same copy as
    the job's start), so "Add it on the campaign page, then tap Try again" works. The job's ``campaign`` with the new
    ``logoKey``, or None when there is nothing to copy (not a campaign job, no logo needed or added, the campaign
    removed). Best effort: a failed copy keeps the job's own copy and the retry goes on."""
    snapshot = job.get("campaign")
    campaign_id = job.get("campaignId")
    if not isinstance(snapshot, Mapping) or not isinstance(campaign_id, str) or not links.UUID.match(campaign_id):
        return None
    item = store.get(db.user_pk(user_id), db.campaign_sk(campaign_id))
    if not isinstance(item, Mapping) or not (gates.logo_needed(item) or gates.logo_needed(snapshot)):
        return None
    try:
        target = copy_logo(media, item, str(job["jobId"]))
    except Exception as e:
        log("warning", "cr.retry_logo_failed", jobId=job.get("jobId"), error=type(e).__name__)
        return None
    if target is None:
        return None
    log("info", "cr.retry_logo_copied", jobId=job.get("jobId"))
    return {**snapshot, "logoKey": target}


def _fresh(deps: CrDeps, user_id: str, item: Item, conn: Mapping[str, Any], now: datetime) -> bool:
    """A job start reads the public JSON and CR's list (an owner action), at most 8 s together (§38.10). False when
    CR could not be read in that time: the job starts with the stored rules and status ("Couldn't check the campaign
    just now.")."""
    end = deps.monotonic() + config.JOB_CHECK_SECONDS
    ok = True
    try:
        pub = public.read(deps.net, str(item["campaignId"]), monotonic=deps.monotonic, end=end, open_graph=False)
        campaigns.apply_public(item, pub, now)
    except public.PublicGone:
        item["state"] = "ended"
    except public.PublicDown:
        ok = False
    if not connection.signed_in(conn) or conn.get("blocked"):
        return ok
    found = None
    left = end - deps.monotonic()
    if left >= config.JOB_LIST_MIN_SECONDS:
        try:
            with deps.mcp(user_id).within(left):
                found = campaigns.list_campaigns(deps, user_id, fresh=True)
        except CrError as e:
            log("info", "cr.job_check_failed", code=e.code)
    if found is None:
        found = campaigns.cached_list(deps, user_id)  # read in the last 2 minutes: still fresh enough
    if found is None:
        return False
    campaigns.settle_membership(item, conn, found[0], found[1], now)
    if campaigns.needs_read(item):
        campaigns.start_read(deps, user_id, item, now)
    return ok
