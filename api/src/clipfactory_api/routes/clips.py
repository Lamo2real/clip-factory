"""/v1/clips: review, caption edits, confirm, decline and similar clips. Nothing is published without Confirm."""

from __future__ import annotations

import contextlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .. import (
    clip_overlay,
    clips,
    db,
    logos,
    mojibake,
    post_preset,
    posts,
    release,
    s3,
    settings,
    tiktok_find,
    tiktok_link,
    tiktok_mac,
    tiktok_self,
    uploads,
    validate,
    vectors,
)
from ..app import App
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..ids import is_ulid
from ..log import log
from ..oauth import setup as platform_setup
from ..platforms import label as platform_label
from ..platforms.campaign_caption import campaign_options
from ..stats import config as stats_config

ALREADY_DECIDED = "This clip has already been uploaded or thrown away."
ALREADY_DECLINED = "This clip was thrown away, so it cannot be uploaded."
AUTO_SENT = "Auto-posting already sent this clip."


def _clip_or_404(app: App, req: Request) -> dict[str, Any]:
    clip_id = req.params["clipId"]
    item = app.store.get(db.user_pk(req.user_id), db.clip_sk(clip_id)) if is_ulid(clip_id) else None
    if item is None:
        raise not_found("We could not find that clip.")
    return item


def _require_review(item: dict[str, Any]) -> None:
    if item.get("status") != "review":
        raise conflict(ALREADY_DECIDED)


def list_clips(app: App, req: Request) -> Response:
    status = req.query.get("status") or "review"
    if status not in clips.STATUS_GROUPS:
        raise bad_request("status must be review, confirmed, posted, declined or all.")
    wanted = clips.STATUS_GROUPS[status]
    job_id = req.query.get("jobId")
    if job_id:
        if not is_ulid(job_id):
            raise bad_request("jobId is not valid.")
        items = clips.clips_for_job(app.store, req.user_id, job_id)
        items.sort(key=lambda c: (c.get("rank", 0), c.get("clipId", "")))
    else:
        items = clips.all_clips(app.store, req.user_id)
    if wanted is not None:
        items = [c for c in items if c.get("status") in wanted]
    by_clip = clips.posts_by_clip(posts.all_posts(app.store, req.user_id)) if items else {}
    now = app.clock()
    return ok({"clips": [clips.public_clip(c, app.media, posts=by_clip.get(c["clipId"], []), now=now) for c in items]})


def get_clip(app: App, req: Request) -> Response:
    item = _clip_or_404(app, req)
    found = posts.posts_for_clip(app.store, req.user_id, item["clipId"])
    return ok({"clip": clips.public_clip(item, app.media, posts=found, now=app.clock())})


def patch_clip(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, {"captions"})
    if "captions" not in body:
        raise bad_request("captions is required.")
    patch = clips.caption_patch(body["captions"])
    item = _clip_or_404(app, req)
    _require_review(item)
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"captions": clips.merged_captions(item.get("captions"), patch)},
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    return ok({"clip": clips.public_clip(updated, app.media)})


TIKTOK_PRIVACY = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY")
# TikTok's rule: branded content (a paid partnership) is only for Everyone or Friends.
TIKTOK_BRANDED_PRIVACY = tiktok_mac.BRANDED_PRIVACY
TIKTOK_SWITCHES = ("disableComment", "disableDuet", "disableStitch", "brandContent", "brandOrganic")


def tiktok_options(raw: Any) -> dict[str, Any]:
    """The "Post to TikTok" sheet's choices (§17.8), validated."""
    body = validate.obj(raw, "tiktok")
    validate.only_keys(body, {"privacyLevel", *TIKTOK_SWITCHES})
    privacy = body.get("privacyLevel")
    if privacy not in TIKTOK_PRIVACY:
        raise bad_request("Pick who can see it on TikTok.")
    out: dict[str, Any] = {"privacyLevel": privacy}
    for name in TIKTOK_SWITCHES:
        out[name] = validate.boolean(body.get(name, False), name)
    if out["brandContent"] and privacy not in TIKTOK_BRANDED_PRIVACY:
        raise bad_request("Branded content can only be seen by Everyone or Friends on TikTok. Pick who can see it.")
    return out


def upload_platforms(raw: Any) -> list[str]:
    """The places the owner picked on Upload (§33): a non-empty list of known platforms, each once, in STATS_ORDER."""
    if not isinstance(raw, list) or not raw:
        raise bad_request("Pick at least one place to upload to.")
    seen: list[str] = []
    for value in raw:
        if not isinstance(value, str) or value not in posts.UPLOAD_ORDER:
            raise bad_request("One of the places to upload to is not one Clip Factory knows.")
        if value in seen:
            raise bad_request(f"{platform_label(value)} is in the list twice. Pick each place once.")
        seen.append(value)
    return [p for p in posts.UPLOAD_ORDER if p in seen]


def _require_set_up(app: App, user_id: str, platforms: list[str]) -> None:
    """Every chosen place must have a connected account (§33): a clip is never sent somewhere that is not set up."""
    for platform in platforms:
        if posts.connected_account(app.store, user_id, platform) is None:
            raise bad_request(f"{platform_label(platform)} is not set up yet. Turn it off, then tap Upload.")


# --- Content Rewards campaign clips (docs/CONTRACTS.md §38.14) ------------------------------------------------------
#
# The items are read by their literal keys (CAMPAIGN#{uuid}, CRCONN, SETUP#tiktok; §38.11). The one import of the
# Content Rewards package is the fit check (§39.3), only while it is switched on (``_require_fit``).

CAMPAIGN_PICK = "Pick where it goes, then tap Upload."
CAMPAIGN_GONE = "Add the campaign again on the Campaigns page."
CAMPAIGN_PUBLIC = "Campaign clips must be public. Pick Everyone."
CAMPAIGN_KIDS = "Campaign clips are never made for kids."
CAMPAIGN_BRANDED = "Turn on Branded content on TikTok for campaign clips."
CAMPAIGN_HELD = (
    "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again."
)
CAMPAIGN_CAN_POST = ("in", "manual")
# Try again (Library, a clip's post line) has no switch and no Upload: its sentences name the buttons it has.
TRY_ANOTHER = "Tap Try again on another place."
# The stop that keeps a campaign from taking clips (§38.4): its state first, then the owner's membership.
CAMPAIGN_STATE_STOPS = {
    "ended": "This campaign has ended. Pick another one.",
    "paused": "The brand paused this campaign. I'll tell you when it opens again.",
}
CAMPAIGN_MEMBERSHIP_STOPS = {
    "unknown": "Connect Content Rewards so I can see if you're in.",
    "not_joined": "Not joined yet: tap Join Campaign on Content Rewards. I'll see it by myself.",
    "apply_first": "Did you tap Submit application on Content Rewards? Then tap Yes, I applied.",
    "waiting": "The brand hasn't let you in yet. I'll tell you when you're in.",
    "left": (
        "Content Rewards doesn't show this campaign for you any more. Open it to check: you may have left, or the "
        "brand removed you."
    ),
    "not_accepted": "The brand said no to this one. That's OK! Pick another campaign.",
}


@dataclass(frozen=True)
class CampaignClip:
    """A clip made for a campaign: the live ``CAMPAIGN#`` item (None when it was removed), the places the campaign
    pays for and the internal ``postOptions.campaign`` every one of its posts carries."""

    campaign_id: str
    item: Mapping[str, Any] | None
    paid: tuple[str, ...]
    options: dict[str, Any]


def _platform_list(raw: Any) -> tuple[str, ...]:
    found = raw if isinstance(raw, list | tuple | set) else []
    return tuple(p for p in posts.UPLOAD_ORDER if p in found)


def campaign_clip(
    app: App, user_id: str, clip: Mapping[str, Any], clip_posts: list[dict[str, Any]] | None = None
) -> CampaignClip | None:
    """The campaign this clip follows: its job's ``campaign`` (the rules copied at ``POST /v1/jobs``), else the
    clip's or its posts' ``campaignId`` (a clip that outlived its job) with the rules of the ``CAMPAIGN#`` item.
    None for a clip without a campaign (everything then works exactly as before)."""
    pk = db.user_pk(user_id)
    job = app.store.get(pk, db.job_sk(str(clip["jobId"]))) if clip.get("jobId") else None
    raw = (job or {}).get("campaign")
    job_campaign: Mapping[str, Any] = raw if isinstance(raw, Mapping) and raw.get("campaignId") else {}
    from_posts = next((str(p["campaignId"]) for p in clip_posts or [] if p.get("campaignId")), "")
    campaign_id = str(job_campaign.get("campaignId") or clip.get("campaignId") or from_posts or "")
    if not campaign_id:
        return None
    item = app.store.get(pk, f"CAMPAIGN#{campaign_id}")
    rules = job_campaign.get("rules") if job_campaign else (item or {}).get("rules")
    # The live list wins: the brand may have changed it since the job started; the job's copy only when it has none.
    paid = _platform_list((item or {}).get("platformsPaid")) or _platform_list(job_campaign.get("platformsPaid"))
    return CampaignClip(campaign_id, item, paid, campaign_options(rules if isinstance(rules, Mapping) else None))


def _require_campaign_open(app: App, campaign: CampaignClip) -> None:
    """409 unless the owner is in the campaign (``in`` or ``manual``) and it takes clips (not held, paused, ended)."""
    item = campaign.item
    if item is None:
        raise conflict(CAMPAIGN_GONE)
    state = item.get("state")
    if state in CAMPAIGN_STATE_STOPS:
        raise conflict(CAMPAIGN_STATE_STOPS[str(state)])
    membership = item.get("membership")
    if membership not in CAMPAIGN_CAN_POST:
        raise conflict(CAMPAIGN_MEMBERSHIP_STOPS.get(str(membership), CAMPAIGN_MEMBERSHIP_STOPS["unknown"]))
    if item.get("held"):  # held until the poller clears it (§38.12), the same rule as the card's stop
        raise conflict(CAMPAIGN_HELD)


def _place_refusal(
    platform: str,
    campaign: CampaignClip,
    setups: list[dict[str, Any]],
    linked: Any,
    *,
    try_again: bool = False,
    mac_on: bool = False,
    api: bool = False,
) -> str | None:
    """Why a campaign clip can't go to ``platform`` (None when it can): the §38.8 ``uploadPlaces`` rule, the
    campaign's paid places ∩ places ready on Set up posting ∩ not refused by Content Rewards as unlinked, TikTok once
    TikTok approved the app (``app_review`` and ``posting_audit`` both ok, ``tiktok_mac.setup_audited``) or while Your
    Mac posts TikTok is on (``mac_on``: the owner's Mac posts it, for Everyone with Branded content). Before the
    approval with the Mac off it says to turn the Mac on (``tiktok_mac.CAMPAIGN_MAC_OFF``); ``api`` (Try again through
    TikTok's API) with the Mac on says the Mac posts it (``tiktok_mac.CAMPAIGN_MAC_POSTS``). Upload's sentences say to
    turn the place off; Try again's (Library, a clip's post line: no switch and no Upload there) name the buttons
    those screens have."""
    name = platform_label(platform)
    setup = next((s for s in setups if s.get("platform") == platform), {})
    if platform not in campaign.paid:
        if try_again:
            return f"This campaign doesn't pay for {name} any more. {TRY_ANOTHER}"
        return f"This campaign doesn't pay for {name}. Turn it off, then tap Upload."
    if not setup.get("ready"):
        if try_again:
            return f"{name} is not set up yet. Set it up in Settings › Posting › Set up posting, then tap Try again."
        return f"{name} is not set up yet. Turn it off, then tap Upload."
    if platform == "tiktok" and not tiktok_mac.setup_audited(setup):
        if not mac_on:
            then = TRY_ANOTHER if try_again else "Or turn TikTok off, then tap Upload."
            return f"{tiktok_mac.CAMPAIGN_MAC_OFF} {then}"
        if api:
            return tiktok_mac.CAMPAIGN_MAC_POSTS
    if isinstance(linked, Mapping) and linked.get(platform) is False:
        if try_again:
            return f"Add {name} in Content Rewards first, then tap Try again."
        return f"Add {name} in Content Rewards first. Then tap I added it, or turn {name} off and tap Upload."
    return None


def _require_campaign_places(
    app: App,
    user_id: str,
    campaign: CampaignClip,
    places: list[str],
    *,
    try_again: bool = False,
    mac_on: bool | None = None,
    api: bool = False,
) -> None:
    """400 with the reason when a place is not one of this campaign clip's places (``_place_refusal``). ``mac_on``
    is Your Mac posts TikTok (read from Settings when not given)."""
    if mac_on is None:
        mac_on = tiktok_mac.is_on(settings.load(app.store, user_id))
    setups = platform_setup.all_setups(app.store, user_id)
    linked = (app.store.get(db.user_pk(user_id), "CRCONN") or {}).get("crLinked")
    for platform in places:
        refusal = _place_refusal(platform, campaign, setups, linked, try_again=try_again, mac_on=mac_on, api=api)
        if refusal:
            raise bad_request(refusal)


def mac_campaign_refusal(
    app: App, user_id: str, clip: Mapping[str, Any], campaign: CampaignClip, tiktok: Mapping[str, Any]
) -> str | None:
    """Why the owner's Mac can't post this campaign clip on TikTok now (None when it can): Upload's checks for TikTok
    with the Mac's own choices (Send these to my Mac, a row's Post with my Mac): the campaign takes clips
    (``_require_campaign_open``), TikTok is one of its places while the Mac is on (``_require_campaign_places``) and
    the clip can earn there (``_require_fit``)."""
    try:
        _require_campaign_open(app, campaign)
        _require_campaign_places(app, user_id, campaign, ["tiktok"], try_again=True, mac_on=True)
        _require_fit(app, user_id, clip, chosen=["tiktok"], tiktok=tiktok)
    except ApiError as e:
        return e.message
    return None


def campaign_closed(app: App, campaign: CampaignClip | None) -> str | None:
    """Why the campaign takes no clips now (``_require_campaign_open``'s words), None when it does or there is none."""
    if campaign is None:
        return None
    try:
        _require_campaign_open(app, campaign)
    except ApiError as e:
        return e.message
    return None


def _require_campaign_tiktok(tiktok: Mapping[str, Any] | None) -> None:
    """TikTok's own rules stay (§17.8: the owner picks who can see it, nothing is picked for him); a campaign clip
    must be for Everyone with Branded content ticked."""
    if tiktok is None:
        return
    if tiktok.get("privacyLevel") != "PUBLIC_TO_EVERYONE":
        raise bad_request(CAMPAIGN_PUBLIC)
    if tiktok.get("brandContent") is not True:
        raise bad_request(CAMPAIGN_BRANDED)


def _require_fit(
    app: App,
    user_id: str,
    clip: Mapping[str, Any],
    *,
    captions: Mapping[str, Any] | None = None,
    chosen: list[str] | None = None,
    tiktok: Mapping[str, Any] | None = None,
) -> None:
    """§39.3: a campaign clip goes up the campaign way only when it can earn: 409 with the first ``no``, ``remake``
    or ``todo`` item's words (a wait item: "Not yet for …"). Only while Content Rewards is switched on (its deps
    exist); a clip without a campaign never gets here, so its Confirm is exactly as before."""
    deps = getattr(app, "contentrewards", None)
    if deps is None:
        return
    from ..contentrewards import fit

    found = fit.for_clip(
        deps, user_id, str(clip["clipId"]), app.clock(), captions=captions, chosen=chosen, tiktok=tiktok
    )
    refusal = fit.upload_refusal(found["fits"][0]) if found["fits"] else None
    if refusal:
        raise conflict(refusal)


def _campaign_youtube(per_clip: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """YouTube's options for a campaign clip: public and never made for kids (anything else is refused)."""
    youtube = dict(per_clip.get("youtube") or {})
    if youtube.get("privacy", "public") != "public":
        raise bad_request(CAMPAIGN_PUBLIC)
    if youtube.get("madeForKids") is True:
        raise bad_request(CAMPAIGN_KIDS)
    return {**youtube, "privacy": "public", "madeForKids": False}


def confirm(app: App, req: Request) -> Response:
    """Upload a clip (docs/CONTRACTS.md §14.5, §33). Safe to repeat: the posts are created once and the durable
    ``cf-prod-clip-flow`` start is idempotent on its execution name. With TikTok going (connected and chosen, or
    enabled in settings when nothing is chosen), the TikTok sheet's choices are required (§17.8). ``platforms`` picks
    exactly where the clip goes; without it (older clients) Settings › Where clips go decides, as before. On a
    ``posted``, ``failed`` or ``confirmed`` clip, ``platforms`` names the failed posts to try again (one platform's
    Try again) and the waiting posts to send now that their place is connected (Post now, §33.6). A campaign clip
    (§38.14) must name its places, only ones the campaign pays for, while the campaign takes clips, public and never
    made for kids; its posts carry ``campaignId`` and ``postOptions.campaign``. The upload itself is
    ``uploads.upload_review_clip``, the code auto-posting sends its clips through too (§46.7). ``tiktokMac: true``
    (optional, additive, §47) says the card is in Mac mode: ``tiktok`` holds its own TikTok row's choices, which the
    Mac post keeps (without it an Upload's Mac post uses My settings, as before)."""
    body = req.json()
    validate.only_keys(body, {"captions", "tiktok", "platforms", "options", "tiktokMac"})
    patch = clips.caption_patch(body["captions"]) if body.get("captions") is not None else {}
    options = tiktok_options(body["tiktok"]) if body.get("tiktok") is not None else None
    chosen = upload_platforms(body["platforms"]) if body.get("platforms") is not None else None
    # Per-clip choices for YouTube, Instagram and X from the card's rows (§36.3); only the places that go keep theirs.
    per_clip = post_preset.clip_options(body["options"]) if body.get("options") is not None else {}
    card_mac = validate.boolean(body.get("tiktokMac", False), "tiktokMac")
    item = _clip_or_404(app, req)
    if item.get("status") == "review":
        try:
            confirmed, created = uploads.upload_review_clip(
                app,
                req.user_id,
                item,
                platforms=chosen,
                options=per_clip,
                tiktok=options,
                captions_patch=patch,
                mac_choices=card_mac,
            )
        except uploads.ClipTaken:
            # Another Confirm (or a Decline, or an auto-posting run) won the race: carry on from the clip's state.
            item = _clip_or_404(app, req)
        else:
            return ok({"clip": clips.public_clip(confirmed, app.media), "posts": created})
    status = item.get("status")
    if status == "declined":
        raise conflict(ALREADY_DECLINED)
    if status == "review":
        raise conflict("This clip changed while you pressed Upload. Please try again.")
    if status == "failed" or (status in {"posted", "confirmed"} and chosen is not None):
        item = _try_again(app, item, tiktok=options, platforms=chosen)
    elif status in {"confirmed", "publishing", "posted"} and item.get("publishState") == clips.PUBLISH_PENDING:
        item = _start_flow(app, item)  # an earlier Confirm, Try again or release stopped before its flow started
    return ok({"clip": clips.public_clip(item, app.media), "posts": _posts(app, req.user_id, item["clipId"])})


def _posts(app: App, user_id: str, clip_id: str) -> list[dict[str, Any]]:
    return [posts.public_post(p) for p in posts.posts_for_clip(app.store, user_id, clip_id, consistent=True)]


def _start_flow(app: App, clip: dict[str, Any]) -> dict[str, Any]:
    """Starts ``clip-{clipId}-{flowRun}`` (``release.start_flow``, shared with the OAuth callback)."""
    return release.start_flow(app.store, app.flows, clip)


def _try_again(
    app: App, clip: dict[str, Any], *, tiktok: dict[str, Any] | None = None, platforms: list[str] | None = None
) -> dict[str, Any]:
    """Failed posts go back to ``queued`` and a new flow run starts (``release.restart``). Without ``platforms`` (a
    ``failed`` clip, whose every post failed) all failed posts are tried again; with it only the named ones, which also
    works on a ``posted`` clip where one place did not work (§33). Named places still ``pending_integration`` are
    released the same way once they are connected (Post now, §33.6); one not connected yet is a 400 with the plain
    sentence Upload uses. A ``failed`` clip becomes ``confirmed``; a ``posted`` one stays ``posted``. Naming nothing
    to send changes nothing. New TikTok sheet choices (``tiktok``) replace the TikTok post's ``postOptions``, so a
    privacy TikTok no longer offers can be picked again. A campaign clip's posts get the checks of Confirm first
    (§38.14), and new TikTok choices keep the post's ``postOptions.campaign``."""
    rows = posts.posts_for_clip(app.store, clip["userId"], clip["clipId"], consistent=True)
    named = [p for p in rows if platforms is None or p.get("platform") in platforms]
    failed = [p for p in named if p.get("status") == "failed"]
    waiting = [p for p in named if platforms is not None and p.get("status") == "pending_integration"]
    if waiting:
        _require_set_up(
            app, clip["userId"], [p for p in posts.UPLOAD_ORDER if any(w["platform"] == p for w in waiting)]
        )
        if tiktok is None and any(p["platform"] == "tiktok" and not release.has_tiktok_choice(p) for p in waiting):
            raise bad_request("Pick who can see it on TikTok.")
    if not failed and not waiting:
        # Nothing to send among the named places. A start that did not go through earlier still gets finished.
        return _start_flow(app, clip) if clip.get("publishState") == clips.PUBLISH_PENDING else clip
    campaign = campaign_clip(app, clip["userId"], clip, rows)
    if campaign is not None:
        going = [p for p in posts.UPLOAD_ORDER if any(r.get("platform") == p for r in [*failed, *waiting])]
        _require_campaign_open(app, campaign)
        _require_campaign_places(app, clip["userId"], campaign, going, try_again=True, api=True)
        _require_fit(app, clip["userId"], clip, chosen=going, tiktok=tiktok if "tiktok" in going else None)
        if tiktok is not None and "tiktok" in going:
            _require_campaign_tiktok(tiktok)
            kept = next((r.get("postOptions") for r in rows if r.get("platform") == "tiktok"), None)
            frozen = kept.get("campaign") if isinstance(kept, Mapping) else None
            # release.restart replaces the TikTok post's postOptions: the campaign part goes along unchanged.
            tiktok = {**tiktok, "campaign": dict(frozen) if isinstance(frozen, Mapping) else campaign.options}
    return release.restart(app.store, app.flows, clip, [*failed, *waiting], clip_posts=rows, tiktok=tiktok)


# --- It's on TikTok (§42) ----------------------------------------------------------------------------------------

OTHER_ACCOUNT = "Saved. Views only show for posts on the TikTok account you connected."
# Only the Mac's own done saves without a link when nothing is found (the Mac knows it posted).
NOT_FOUND_YET = "Saved. Clip Factory could not find it on your TikTok yet. Tap Find it for me in a minute."
# Find it for me never saves without a link (D3): these two 409s write nothing.
FIND_NONE = "Not found yet. Try again in a minute, or paste the link."
FIND_CANT = "Clip Factory can't look on your TikTok until TikTok is connected. Paste the link instead."
BOTH = "Send a link or noLink, not both."
SINCE_LIMIT = timedelta(hours=24)


def _since(app: App, raw: Any) -> datetime:
    """When the owner opened the sheet (the post is newer), never more than a day back and never in the future."""
    now = app.clock()
    at = parse(raw) if isinstance(raw, str) else None
    if at is None:
        return now - timedelta(hours=1)
    return min(max(at, now - SINCE_LIMIT), now)


def _has_link(app: App, user_id: str, item: Mapping[str, Any]) -> bool:
    rows = posts.posts_for_clip(app.store, user_id, str(item["clipId"]), consistent=True)
    row = tiktok_self.tiktok_row(rows)
    return bool(row and row.get("by") == "you" and row.get("url"))


def clip_file(app: App, req: Request) -> Response:
    """``GET /v1/clips/{clipId}/file``: a 1-hour link that saves the clip's video as a file (Save the video, §42)."""
    item = _clip_or_404(app, req)
    if item.get("status") == "declined" or not item.get("videoKey"):
        raise not_found("This clip has no video any more.")
    name = f"clip-factory-{str(item.get('hook') or 'clip')[:40]}.mp4"
    filename = s3.safe_filename(name, "clip-factory.mp4")
    return ok({"url": app.media.presign_download(str(item["videoKey"]), filename), "filename": filename})


def tiktok_posted(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/tiktok/posted`` ``{link?, since?, noLink?}``: the clip is on the owner's TikTok (his
    It's on TikTok, §42.2). The clip's TikTok post becomes ``posted`` with ``by: "you"``.

    * ``link``: read by ``tiktok_link`` (full or short); it gives the video's id, so its numbers are read like any
      public post's when it is on the connected TikTok account.
    * ``noLink: true`` ("It's on TikTok, no link"): saved without a link and without the finder
      (``mark_posted(no_link=True)``: never while the Mac has not pressed Post and still beats the job).
    * Neither (Find it for me): a post already his with a link is answered as it is. Else, after the same refusals as
      a save (``tiktok_self.check_can_mark``, so a Mac post still at work is ``MAC_WORKING`` before TikTok is asked),
      the finder looks on his TikTok; found → saved with its link. Nothing found (``FIND_NONE``) or TikTok not
      connected (``FIND_CANT``) is a 409 and nothing is written."""
    body = req.json()
    validate.only_keys(body, {"link", "since", "noLink"})
    link = body.get("link")
    if link is not None and not isinstance(link, str):
        raise bad_request("Paste the TikTok link as text.")
    no_link = validate.boolean(body.get("noLink", False), "noLink")
    has_link = bool(link and link.strip())
    if has_link and no_link:
        raise bad_request(BOTH)
    item = _clip_or_404(app, req)
    note: str | None = None
    video: tiktok_link.TikTokVideo | None = None
    count_views = True
    if has_link:
        video, count_views, note = tiktok_video(app, req.user_id, item, link, None)
    elif not no_link:
        if _has_link(app, req.user_id, item):
            return _with_posts(app, req)  # already his, with its link: nothing to find
        try:
            tiktok_self.check_can_mark(app.store, item, app.clock())
        except tiktok_self.Refused as e:
            raise conflict(e.message) from e
        video = _find(app, req.user_id, item, body.get("since"))
    minutes = stats_config.load().platform("tiktok").min_interval
    try:
        try:
            tiktok_self.mark_posted(
                app.store, item, video, app.clock(), min_interval=minutes, count_views=count_views, no_link=no_link
            )
        except db.ConditionFailed:
            # A second tap at the same moment (or the clip just changed): read it again and write once more, which
            # only adds the link when the first one already marked it.
            fresh = _clip_or_404(app, req)
            tiktok_self.mark_posted(
                app.store, fresh, video, app.clock(), min_interval=minutes, count_views=count_views, no_link=no_link
            )
    except tiktok_self.Refused as e:
        raise conflict(e.message) from e
    except db.ConditionFailed as e:
        raise conflict("This clip just changed. Try again.") from e
    log("info", "clip.tiktok_by_you", clipId=item["clipId"], link=video is not None, views=count_views, noLink=no_link)
    if video is not None:
        send_to_cr(app, req, str(item["clipId"]))  # a campaign post the Mac posted gets its link only now
    return _with_posts(app, req, note=note)


# A send CR asks to try again (it can't see the post yet) gets one more try this long after, when the request has the
# time; then it waits for the owner's Send.
CR_AGAIN_AFTER = 8.0


def send_to_cr(app: App, req: Request, clip_id: str, *, posted_at: Any = None) -> None:
    """A campaign post the owner's Mac posted goes to Content Rewards once it has its link (§47.8): after the Mac's
    done, and after his Add link / It's on TikTok gives a link to a post his Mac posted. Only for the clip's TikTok post
    that is ``posted`` by the Mac (``via: "mac"``), public, for a campaign (``campaignId``), with its ``url``, while
    Content Rewards is on, and only once (no ``CRSUB#{postId}`` yet): ``contentrewards.submit.send`` creates it, keeps
    to CR's 30 minutes and never raises. Those 30 minutes count from ``posted_at`` (the Mac's press, when the done
    knows it), else the post's ``postedAt``. A send CR asks to try again later (it can't see the post yet) gets one more
    try ``CR_AGAIN_AFTER`` seconds later while the request has the time, then waits for the owner's Send, as the Send
    button's own route leaves it (``send_by_hand``). Never breaks the answer it follows."""
    deps = getattr(app, "contentrewards", None)
    if deps is None:
        return
    try:
        rows = posts.posts_for_clip(app.store, req.user_id, clip_id, consistent=True)
        row = tiktok_self.tiktok_row(rows)
        if row is None or not _goes_to_cr(row):
            return
        from ..contentrewards import config as cr_config
        from ..contentrewards import submissions, submit

        post_id = str(row["postId"])
        if deps.store.get(*submissions.key(req.user_id, post_id)) is not None:
            return  # sent (or tried) already: CR's own reminders and the owner's Send take it from there
        deps.for_request(req.started)
        campaign_id = str(row["campaignId"])
        result = submit.send(
            deps, req.user_id, post_id, campaign_id, timeout=cr_config.SUBMIT_TIMEOUT_API, posted_at=posted_at
        )
        if result.get("pending") and deps.remaining() > CR_AGAIN_AFTER + cr_config.SUBMIT_TIMEOUT_API + 2:
            deps.sleep(CR_AGAIN_AFTER)
            result = submit.send(deps, req.user_id, post_id, campaign_id, timeout=cr_config.SUBMIT_TIMEOUT_API)
        if result.get("pending"):
            reason = {"code": "not_sent_by_app", "text": submissions.reason_text("not_sent_by_app", "tiktok")}
            with contextlib.suppress(db.ConditionFailed):
                deps.store.update(
                    *submissions.key(req.user_id, post_id),
                    {"state": "send_by_hand", "reason": reason, "updatedAt": iso(app.clock())},
                    expect_in={"state": ["sending"]},
                )
        log("info", "clip.mac_cr_sent", clipId=clip_id, outcome=result.get("outcome"))
    except Exception as e:  # the post is saved either way; CR's reminders still name it
        log("error", "clip.mac_cr_failed", clipId=clip_id, error=type(e).__name__)


def _goes_to_cr(row: Mapping[str, Any]) -> bool:
    return (
        row.get("via") == "mac"
        and bool(row.get("campaignId"))
        and row.get("status") == "posted"
        and row.get("privacy") == "public"
        and bool(row.get("url"))
    )


def _find(app: App, user_id: str, item: Mapping[str, Any], since: Any) -> tiktok_link.TikTokVideo:
    """Find it for me (§42.2): the post on his connected TikTok made since ``since``; a 409 when TikTok is not
    connected (``FIND_CANT``) or nothing is found (``FIND_NONE``), so nothing is ever saved without its link."""
    account = posts.connected_account(app.store, user_id, "tiktok")
    if account is None or app.oauth is None:
        raise conflict(FIND_CANT)
    found = tiktok_find.find_recent(
        app.oauth,
        app.store,
        account,
        since=_since(app, since),
        caption=mojibake.repair(str((item.get("captions") or {}).get("tiktok") or "")),
    )
    if found is None:
        raise conflict(FIND_NONE)
    return found


def tiktok_video(
    app: App, user_id: str, item: Mapping[str, Any], link: str | None, since: Any
) -> tuple[tiktok_link.TikTokVideo | None, bool, str | None]:
    """The TikTok video a clip was posted as (his It's on TikTok with a link, §42, and the Mac's done, §47): the pasted
    ``link`` read by ``tiktok_link`` (400 when it is not a TikTok video), else (only the Mac's done), with TikTok
    connected and no link stored yet, the post found on his TikTok made since ``since`` (``NOT_FOUND_YET`` when none).
    Also whether its views count (the link is on the connected account) and the answer's ``note``."""
    account = posts.connected_account(app.store, user_id, "tiktok")
    if link and link.strip():
        try:
            video = tiktok_link.resolve(link, app.tiktok_open)
        except tiktok_link.LinkError as e:
            raise bad_request(str(e)) from e
        # The connected handle is "@username" when TikTok gave one, else the display name (which a link never has).
        stored = str((account or {}).get("handle") or "")
        handle = stored[1:].lower() if stored.startswith("@") else ""
        if account is None or (handle and video.handle and video.handle.lower() != handle):
            return video, False, OTHER_ACCOUNT
        return video, True, None
    if account is not None and app.oauth is not None and not _has_link(app, user_id, item):
        # No link: look for the post on his connected TikTok (posted since the sheet opened, or the Mac claimed it).
        found = tiktok_find.find_recent(
            app.oauth,
            app.store,
            account,
            since=_since(app, since),
            caption=mojibake.repair(str((item.get("captions") or {}).get("tiktok") or "")),
        )
        return found, True, None if found is not None else NOT_FOUND_YET
    return None, True, None


def tiktok_posted_undo(app: App, req: Request) -> Response:
    """``DELETE /v1/clips/{clipId}/tiktok/posted``: Undo of It's on TikTok (§42)."""
    item = _clip_or_404(app, req)
    try:
        tiktok_self.undo(app.store, item)
    except tiktok_self.Refused as e:
        raise conflict(e.message) from e
    except db.ConditionFailed as e:
        raise conflict("This clip just changed. Try again.") from e
    return _with_posts(app, req)


def _with_posts(app: App, req: Request, *, note: str | None = None) -> Response:
    fresh = _clip_or_404(app, req)
    rows = posts.posts_for_clip(app.store, req.user_id, fresh["clipId"], consistent=True)
    out: dict[str, Any] = {
        "clip": clips.public_clip(fresh, app.media, posts=rows),
        "posts": [posts.public_post(p) for p in rows],
    }
    if note:
        out["note"] = note
    return ok(out)


def decline(app: App, req: Request) -> Response:
    item = _clip_or_404(app, req)
    _require_review(item)
    now = iso(app.clock())
    try:
        updated = app.store.update(
            item["pk"],
            item["sk"],
            {"status": "declined", "decidedAt": now},
            remove=["videoKey", "coverKey", "editKey", "origVideoKey"],
            expect_in={"status": ["review"]},
        )
    except db.ConditionFailed as e:
        raise conflict(ALREADY_DECIDED) from e
    _delete_files(app, item)
    _delete_vector(app, req.user_id, item["clipId"])
    log("info", "clip.declined", clipId=item["clipId"])
    return ok({"clip": clips.public_clip(updated, app.media)})


# --- CR active: a logo and text on the clip (§53 C1, C5, C6) ---------------------------------------------------------

NO_CAMPAIGN = "We could not find that campaign."
OVERLAY_TRIES = 3


def _overlay_write(
    app: App, req: Request, build: Any, *, only_when_changed: bool = False
) -> tuple[dict[str, Any], dict[str, Any], str | None]:
    """Reads the clip, asks ``build(item)`` for ``(fields to set, fields to remove, a file to delete afterwards)``
    and writes them only while the clip is still in Review with the very ``overlay`` that was read; if a render
    finished (or another change came) meanwhile, reads again, up to 3 times. Returns ``(the clip as written, the
    clip read, the file to delete)``; ``only_when_changed`` returns the clip untouched when ``build`` has nothing."""
    for attempt in range(OVERLAY_TRIES):
        item = _clip_or_404(app, req)
        _require_review(item)
        set_fields, remove, gone = build(item)
        if only_when_changed and not set_fields and not remove:
            return item, item, None
        absent, also = clip_overlay.same_overlay(item)
        try:
            updated = app.store.update(
                item["pk"],
                item["sk"],
                set_fields,
                remove=remove,
                expect_in={"status": ["review"]},
                expect_absent=absent,
                also=also,
            )
        except db.ConditionFailed:
            if attempt == OVERLAY_TRIES - 1:
                raise conflict("This clip just changed. Try again.") from None
            continue
        return updated, item, gone
    raise conflict("This clip just changed. Try again.")  # pragma: no cover (the loop always returns or raises)


def _delete_edit(app: App, key: str | None) -> None:
    if key:
        try:
            app.media.delete(key)
        except Exception as e:  # the clip is back to its original either way; a stray file is never linked
            log("error", "clip.edit_delete_failed", error=type(e).__name__)


def _own_campaign(app: App, user_id: str, raw: Any) -> str:
    """The owner's campaign id (lower case), else 404: ``campaignId`` must be one of the owner's campaigns."""
    from ..contentrewards import links

    text = raw.strip().lower() if isinstance(raw, str) else ""
    found = app.store.get(db.user_pk(user_id), db.campaign_sk(text)) if links.UUID.match(text) else None
    if found is None or found.get("type") != "campaign":
        raise not_found(NO_CAMPAIGN)
    return text


def put_cr(app: App, req: Request) -> Response:
    """``PUT /v1/clips/{clipId}/cr`` ``{active, campaignId?}`` → ``{clip}`` (§53 C1, C5). Only while the clip is in
    Review. Switching on stores ``cr`` and nothing else; switching off also puts the original back."""
    body = req.json()
    validate.only_keys(body, {"active", "campaignId"})
    if "active" not in body:
        raise bad_request("active is required.")
    active = validate.boolean(body["active"], "active")
    campaign = _own_campaign(app, req.user_id, body["campaignId"]) if active and body.get("campaignId") else None

    def build(item: dict[str, Any]) -> tuple[dict[str, Any], list[str], str | None]:
        if active:
            return {"cr": {"active": True, **({"campaignId": campaign} if campaign else {})}}, [], None
        set_fields, remove, gone = clip_overlay.reset_writes(item)
        return {**set_fields, "cr": {"active": False}}, remove, gone

    updated, _before, gone = _overlay_write(app, req, build)
    _delete_edit(app, gone)
    log("info", "clip.cr", clipId=updated["clipId"], active=active)
    return ok({"clip": clips.public_clip(updated, app.media, now=app.clock())})


def put_overlay(app: App, req: Request) -> Response:
    """``PUT /v1/clips/{clipId}/overlay`` ``{logos?, logo?, text?, timing?}`` → ``{clip}`` with
    ``overlay.status: "working"`` (§53 C5, §54 L4: up to 4 picture layers; ``logo`` is one layer; the edit is stored as
    ``logos``). At least one picture or the text; ``cr.active`` is required (409). The agent draws on the original file and
    sets ``videoKey`` to the edited one when it is done; this route only writes ``working`` and asks it."""
    body = req.json()
    validate.only_keys(body, {"logo", "logos", "text", "timing"})
    if body.get("logo") is not None and body.get("logos"):
        raise bad_request(clip_overlay.ONE_KIND)
    logo = clip_overlay.logo_part(body["logo"]) if body.get("logo") is not None else None
    layers = clip_overlay.layers_part(body["logos"]) if body.get("logos") is not None else []
    text = clip_overlay.text_part(body["text"]) if body.get("text") is not None else None
    if logo is None and not layers and text is None:
        raise bad_request(clip_overlay.NEED_ONE)
    item = _clip_or_404(app, req)
    _require_review(item)
    if not (item.get("cr") or {}).get("active"):
        raise conflict(clip_overlay.TURN_ON)
    duration = item.get("durationSec")
    timing = clip_overlay.timing_part(body["timing"], duration) if body.get("timing") is not None else None
    if layers:
        layers = clip_overlay.layers_part(body["logos"], duration)  # again, now with the clip's length
    elif logo is not None:  # §53's one picture is one layer; it keeps the shared timing
        layers = [clip_overlay.one_layer(logo, timing)]
    keys: dict[str, str] = {}
    for layer in layers:
        logo_id = layer["logoId"]
        if logo_id not in keys:
            found = logos.get_item(app.store, req.user_id, logo_id)
            if found is None or found.get("status") != "ready":
                raise not_found("We could not find that logo.")
            keys[logo_id] = str(found["key"])
        layer["key"] = keys[logo_id]  # internal: the agent reads the picture by it (never public)
    now = app.clock()
    started = iso(now)

    def build(current: dict[str, Any]) -> tuple[dict[str, Any], list[str], str | None]:
        if not (current.get("cr") or {}).get("active"):
            raise conflict(clip_overlay.TURN_ON)
        fresh = clip_overlay.working(current, started, logos=layers, text=text, timing=timing)
        return {"overlay": fresh, "overlayRev": fresh["rev"]}, [], None

    updated, _before, _gone = _overlay_write(app, req, build)
    rev = int(updated["overlay"]["rev"])
    try:
        app.agent.overlay(req.user_id, str(updated["clipId"]), str(updated["jobId"]), rev)
    except Exception as e:  # the agent could not be reached or refused: the clip says so, the owner taps Make it again
        log("error", "clip.overlay_start_failed", clipId=updated["clipId"], error=type(e).__name__)
        updated = _overlay_failed(app, updated, clip_overlay.COULD_NOT_START)
    else:
        log("info", "clip.overlay_started", clipId=updated["clipId"], rev=rev)
    return ok({"clip": clips.public_clip(updated, app.media, now=app.clock())})


def _overlay_failed(app: App, item: dict[str, Any], sentence: str) -> dict[str, Any]:
    """``failed`` with one sentence, only while the clip still has the very ``overlay`` that was just written."""
    failed = {**{k: v for k, v in item["overlay"].items() if k != "error"}, "status": "failed", "error": sentence}
    absent, also = clip_overlay.same_overlay(item)
    try:
        return app.store.update(
            item["pk"],
            item["sk"],
            {"overlay": failed},
            expect_in={"status": ["review"]},
            expect_absent=absent,
            also=also,
        )
    except db.ConditionFailed:  # changed meanwhile (a reset, a newer edit): that newer state stands
        return app.store.get(item["pk"], item["sk"]) or item


def delete_overlay(app: App, req: Request) -> Response:
    """``DELETE /v1/clips/{clipId}/overlay`` → ``{clip}`` (Reset, §53 C5): ``videoKey`` back to the original, the edited
    file deleted, ``overlay``, ``editKey`` and ``origVideoKey`` removed; ``cr`` stays. Safe to repeat."""
    item = _clip_or_404(app, req)
    if not any(name in item for name in ("overlay", "editKey", "origVideoKey")):
        return ok({"clip": clips.public_clip(item, app.media, now=app.clock())})

    def build(current: dict[str, Any]) -> tuple[dict[str, Any], list[str], str | None]:
        return clip_overlay.reset_writes(current)

    updated, _before, gone = _overlay_write(app, req, build, only_when_changed=True)
    _delete_edit(app, gone)
    log("info", "clip.overlay_reset", clipId=updated["clipId"])
    return ok({"clip": clips.public_clip(updated, app.media, now=app.clock())})


def hold(app: App, req: Request) -> Response:
    """``POST /v1/clips/{clipId}/hold`` (§46.2, §46.9): Throw away holds a clip in Review on the server the moment it
    is tapped, for a day (internal ``holdUntil``, ``clips.HOLD_FOR``), so no auto-posting run sends it while Undo's
    toast is up, or before a decline that comes late (a phone locked during the toast). The decline itself still goes
    when the toast ends; Undo lifts the hold. A clip no longer in Review → 409: "Auto-posting already sent this clip."
    when a run sent it, else Upload's own sentence."""
    validate.only_keys(req.json(), ())
    item = _clip_or_404(app, req)
    until = iso(app.clock() + clips.HOLD_FOR)
    try:
        updated = app.store.update(item["pk"], item["sk"], {"holdUntil": until}, expect_in={"status": ["review"]})
    except db.ConditionFailed:
        item = _clip_or_404(app, req)
        raise conflict(AUTO_SENT if item.get("autoRun") else ALREADY_DECIDED) from None
    log("info", "clip.held", clipId=item["clipId"])
    return ok({"clip": clips.public_clip(updated, app.media)})


def hold_undo(app: App, req: Request) -> Response:
    """``DELETE /v1/clips/{clipId}/hold`` (§46.2, §46.9): Undo lifts the hold. Safe to repeat, and never refused
    because the clip moved on meanwhile (204 either way); 404 only for a clip that is not the caller's."""
    item = _clip_or_404(app, req)
    with contextlib.suppress(db.ConditionFailed):  # the clip's job was deleted meanwhile: nothing holds it any more
        app.store.update_expr(
            item["pk"], item["sk"], "REMOVE #h", condition="attribute_exists(pk)", names={"#h": "holdUntil"}
        )
    return no_content()


def _delete_vector(app: App, user_id: str, clip_id: str) -> None:
    if app.vectors is None:
        return
    try:
        app.vectors.delete_clip(user_id, clip_id)
    except Exception as e:  # the clip is declined either way; a leftover vector is never shown (not "performed")
        log("error", "clip.delete_vector_failed", clipId=clip_id, error=type(e).__name__)


def similar(app: App, req: Request) -> Response:
    """Up to 5 of the owner's measured clips most like this one (docs/CONTRACTS.md §14.6); ``[]`` on any error."""
    item = _clip_or_404(app, req)
    if app.vectors is None:
        return ok({"clips": []})
    try:
        hits = app.vectors.similar(req.user_id, item["clipId"], k=vectors.SIMILAR_TOP_K)
        pk = db.user_pk(req.user_id)
        found = {c.get("clipId"): c for c in app.store.batch_get((pk, db.clip_sk(h.clip_id)) for h in hits)}
        out = []
        for hit in hits:
            clip = found.get(hit.clip_id)
            if clip is None or clip.get("status") == "declined" or clip.get("userId") != req.user_id:
                continue
            out.append(_similar_clip(app, hit, clip))
    except Exception as e:
        log("error", "clip.similar_failed", clipId=item["clipId"], error=type(e).__name__)
        return ok({"clips": []})
    out.sort(key=lambda c: -float(c["similarity"]))
    return ok({"clips": out[: vectors.SIMILAR_MAX]})


def _similar_clip(app: App, hit: vectors.Hit, clip: dict[str, Any]) -> dict[str, Any]:
    meta = hit.metadata
    raw_captions = clip.get("captions")
    captions: dict[str, Any] = raw_captions if isinstance(raw_captions, dict) else {}
    out: dict[str, Any] = {
        "clipId": hit.clip_id,
        "hook": str(clip.get("hook") or meta.get("hook") or ""),
        "title": str(captions.get("youtubeTitle") or meta.get("title") or ""),
        "momentType": str(clip.get("momentType") or meta.get("momentType") or ""),
        "similarity": hit.similarity,
    }
    performance = _performance(meta.get("performance"))
    if performance is not None:
        out["performance"] = performance
    if clip.get("coverKey"):
        out["coverUrl"] = app.media.presign_get(clip["coverKey"])
    return out


def _performance(raw: object) -> dict[str, Any] | None:
    parsed = vectors.parse_performance(raw)
    if parsed is None:
        return None
    perf: dict[str, Any] = {}
    for key in ("views", "likes", "comments", "shares", "posts"):
        value = parsed.get(key, 0)
        perf[key] = int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0
    if isinstance(parsed.get("checkedAt"), str):
        perf["checkedAt"] = parsed["checkedAt"]
    return perf


def _delete_files(app: App, item: dict[str, Any]) -> None:
    try:
        app.media.delete_prefix(s3.clip_prefix(item["jobId"], item["clipId"]))
        # Keys normally live under the clip's prefix; delete them by name too in case the agent stored them elsewhere.
        for field in ("videoKey", "coverKey", "editKey", "origVideoKey"):
            key = item.get(field)
            if isinstance(key, str) and s3.is_safe_key(key) and key.startswith(f"jobs/{item['jobId']}/"):
                app.media.delete(key)
    except Exception as e:
        # The clip is declined either way; its files stay unreachable (the API never links a declined clip).
        log("error", "clip.delete_files_failed", clipId=item["clipId"], error=type(e).__name__)
