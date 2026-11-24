"""Upload's core: a clip in Review goes up to the places given (docs/CONTRACTS.md §14.5, §33, §36.3, §38.14).

Shared by Upload (``routes/clips.confirm``) and auto-posting (``autopost/run.py``, §46.7), so both make the same checks,
write the same conditional transaction and start the same idempotent flow: a clip is confirmed, and its flow started,
only once, whoever taps or runs first. The checks Upload shares with Try again (the places, the campaign rules and its
fit) stay in ``routes/clips.py``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import clips, db, posts, release, settings
from . import tiktok_mac as mac_posts
from .app import App
from .clock import iso
from .errors import ApiError, bad_request
from .log import log

Item = dict[str, Any]


class ClipTaken(Exception):
    """The clip left Review before its posts were written: another Upload, a Throw away or an auto-posting run won
    the race (the transaction's condition failed), or, for an auto-posting run only, a Throw away holds it (§46.7).
    The caller reads the clip again."""


def upload_review_clip(
    app: App,
    user_id: str,
    item: Item,
    *,
    platforms: list[str] | None,
    options: Mapping[str, Mapping[str, Any]] | None = None,
    tiktok: dict[str, Any] | None = None,
    captions_patch: Mapping[str, str] | None = None,
    auto: Mapping[str, Any] | None = None,
    tiktok_mac: bool = False,
    mac_choices: bool = False,
) -> tuple[Item, list[Item]]:
    """Uploads ``item`` (a clip in Review) and returns the confirmed clip (internal shape) and its posts. ``platforms``
    picks exactly where it goes; without it (older clients) Settings › Where clips go decides. ``options`` are the
    per-clip choices for YouTube, Instagram and X (§36.3); only the places that go keep theirs. ``tiktok`` is the
    TikTok sheet's choices, required when TikTok goes (§17.8). A campaign clip (§38.14) must name its places, only ones
    the campaign pays for, while the campaign takes clips, public and never made for kids. Raises Upload's own
    400/409 ``ApiError`` sentences, and ``ClipTaken`` when the clip left Review meanwhile. When ``tiktok`` carries
    TikTok's label (Branded content or Your brand), whether TikTok goes or not, the clip keeps it (``tiktokLabel``,
    §47), so a later Send these to my Mac posts it with its label.

    ``auto`` (``{runId, at, test?}``, only ever set by an auto-posting run, §46.7) marks the clip (internal
    ``autoRun``, ``autoAt``, ``autoTest``) and every post (``autoRun``); with ``test: "private"`` every post's
    ``postOptions`` also says ``test: "private"`` (§46.8). No request body can set these. With ``auto`` the clip's
    write also needs no live Throw away hold (``holdUntil`` absent or past, §46.7); Upload by hand ignores the hold.

    Your Mac posts it on TikTok (§47), only while ``settings.tiktokMac.on``: Upload by hand with TikTok among
    ``platforms``, while TikTok has not approved Clip Factory's public uploads, writes the TikTok post as a Mac post
    (``source: "upload"``) instead of ``queued`` (the sheet's choices are still required and checked); an
    auto-posting run's live clip (``tiktok_mac=True``, never a Private test) also gets one (``source: "auto"``), though
    TikTok is never one of its places. A Mac post keeps the card's own TikTok choices when the card is in Mac mode
    (``mac_choices``, the body's ``tiktokMac``), else My settings' (``tiktok_mac.preset_options``); a campaign clip's
    are always for Everyone with Branded content (``tiktok_mac.campaign_tiktok``), checked like Upload's TikTok. An
    auto-posting run's campaign clip gets its Mac post only when TikTok is one of its places and the fit passes with
    TikTok too (else its other places go as before). Both go through ``create_for_clip``'s explicit ``tiktok_mac``
    path, in the same transaction as the other posts. Otherwise TikTok's rule is exactly as before."""
    from .routes import clips as checks  # Upload's and Try again's shared checks (§33, §38.14)

    patch = dict(captions_patch or {})
    chosen = platforms
    per_clip: dict[str, dict[str, Any]] = {p: dict(o) for p, o in (options or {}).items()}
    now = iso(app.clock())
    current_settings = settings.load(app.store, user_id)
    campaign = checks.campaign_clip(app, user_id, item)
    if campaign is not None and chosen is None:
        raise bad_request(checks.CAMPAIGN_PICK)  # Settings › Where clips go never decides for a campaign clip
    if chosen is not None:
        checks._require_set_up(app, user_id, chosen)
        tiktok_queued = "tiktok" in chosen
    else:
        tiktok_queued = "tiktok" in current_settings.get("platforms", []) and (
            posts.connected_account(app.store, user_id, "tiktok") is not None
        )
    if tiktok_queued and tiktok is None:
        raise bad_request("Pick who can see it on TikTok.")
    mac_source = _mac_source(
        app, user_id, current_settings=current_settings, chosen=chosen, auto=auto, asked=tiktok_mac
    )
    mac_options = (
        _mac_options(
            current_settings, tiktok, card=mac_choices and mac_source == "upload", campaign=campaign is not None
        )
        if mac_source
        else None
    )
    # The TikTok choices Upload checks and stores: the Mac's when Upload hands TikTok to the Mac.
    going_tiktok = mac_options if mac_source == "upload" else tiktok
    captions = clips.merged_captions(item.get("captions"), patch)
    if campaign is not None and chosen is not None:
        mac_on = mac_posts.is_on(current_settings)
        per_clip = _campaign_checks(app, user_id, item, campaign, chosen, per_clip, going_tiktok, captions, mac_on)
        auto_mac = mac_source == "auto" and mac_options is not None
        if auto_mac and _auto_mac_refusal(app, user_id, item, campaign, chosen=chosen, tiktok=mac_options or {}):
            mac_source, mac_options = None, None
    fields: Item = {
        "status": "confirmed",
        "decidedAt": now,
        "captions": captions,
        "publishState": clips.PUBLISH_PENDING,
        "flowRun": 1,
    }
    if chosen is not None:
        fields["uploadTo"] = chosen
    if mac_posts.labelled(tiktok):
        fields["tiktokLabel"] = mac_posts.label_of(tiktok)
    post_options: dict[str, dict[str, Any]] = {
        **{p: o for p, o in per_clip.items() if chosen is None or p in chosen},
        **({"tiktok": tiktok} if tiktok else {}),
    }
    if mac_options is not None:
        post_options["tiktok"] = mac_options
    post_fields: Item | None = None
    not_held: db.Condition | None = None
    if auto is not None:
        fields.update({"autoRun": str(auto["runId"]), "autoAt": str(auto["at"])})
        not_held = db.Condition(
            "attribute_not_exists(#holdUntil) OR #holdUntil < :holdNow", {"#holdUntil": "holdUntil"}, {":holdNow": now}
        )
        post_fields = {"autoRun": str(auto["runId"])}
        if auto.get("test") == "private":
            fields["autoTest"] = "private"
            for place in chosen or []:
                post_options[place] = {**post_options.get(place, {}), "test": "private"}
    try:
        created = posts.create_for_clip(
            app.store,
            user_id,
            item,
            current_settings,
            now,
            clip_fields=fields,
            expect_status=["review"],
            post_options=post_options or None,
            campaign_id=campaign.campaign_id if campaign else None,
            campaign_options=campaign.options if campaign else None,
            post_fields=post_fields,
            clip_condition=not_held,
            tiktok_mac=mac_source,
        )
    except db.ConditionFailed as e:
        raise ClipTaken(str(item["clipId"])) from e
    confirmed = release.start_flow(app.store, app.flows, {**item, **fields, "postsCreated": True})
    log(
        "info",
        "clip.confirmed",
        clipId=item["clipId"],
        posts=len(created),
        **({"autoRun": auto["runId"]} if auto else {}),
        **({"tiktokMac": mac_source} if mac_source else {}),
    )
    return confirmed, created


def _mac_source(
    app: App,
    user_id: str,
    *,
    current_settings: Mapping[str, Any],
    chosen: list[str] | None,
    auto: Mapping[str, Any] | None,
    asked: bool,
) -> str | None:
    """Whether this Upload hands TikTok to the owner's Mac (§47), and from where: ``"upload"``, ``"auto"`` or None.
    A campaign clip too (an auto-posting run's only after ``_auto_mac_refusal``)."""
    if not mac_posts.is_on(current_settings):
        return None
    if auto is None:
        if chosen and "tiktok" in chosen and not mac_posts.tiktok_audited(app.store, user_id):
            return "upload"
        return None
    return "auto" if asked and not auto.get("test") else None


def _mac_options(
    current_settings: Mapping[str, Any], tiktok: Mapping[str, Any] | None, *, card: bool, campaign: bool
) -> Item:
    """The Mac post's TikTok choices: the card's own (``card``: Upload by hand from a card in Mac mode; a campaign
    clip's are checked like Upload's TikTok, Everyone with Branded content, ``_require_campaign_tiktok``), else My
    settings' (an older web, an auto-posting run), for Everyone with Branded content on a campaign clip."""
    if card and tiktok is not None:
        return dict(tiktok)
    options = mac_posts.preset_options(current_settings)
    if campaign:
        return mac_posts.campaign_tiktok(options)
    # A card on TikTok's API path (an older web, or settings read before the Mac went on) may still carry a label: the
    # Mac post keeps it, as the clip's ``tiktokLabel`` does (§47.12).
    return mac_posts.with_label(options, tiktok) if tiktok is not None and mac_posts.labelled(tiktok) else options


def _campaign_checks(  # noqa: PLR0917 (one call site)
    app: App,
    user_id: str,
    item: Mapping[str, Any],
    campaign: Any,
    chosen: list[str],
    per_clip: dict[str, dict[str, Any]],
    tiktok: Mapping[str, Any] | None,
    captions: Mapping[str, Any],
    mac_on: bool,
) -> dict[str, dict[str, Any]]:
    """A campaign clip's Upload checks (§38.14, §39.3): the campaign takes clips, every chosen place is one of its
    places, YouTube public and never made for kids, TikTok's choices (``tiktok``: the Mac's when the Mac posts it) for
    Everyone with Branded content, and the fit. Returns the per-clip options with YouTube's made safe."""
    from .routes import clips as checks

    checks._require_campaign_open(app, campaign)
    checks._require_campaign_places(app, user_id, campaign, chosen, mac_on=mac_on)
    if "youtube" in chosen:
        per_clip = {**per_clip, "youtube": checks._campaign_youtube(per_clip)}
    going = tiktok if "tiktok" in chosen else None
    checks._require_campaign_tiktok(going)
    checks._require_fit(app, user_id, item, captions=captions, chosen=chosen, tiktok=going)
    return per_clip


def _auto_mac_refusal(
    app: App,
    user_id: str,
    item: Mapping[str, Any],
    campaign: Any,
    *,
    chosen: list[str],
    tiktok: Mapping[str, Any],
) -> str | None:
    """Why an auto-posting run's campaign clip gets no Mac post (None when it does): TikTok must be one of its places
    (the campaign pays for it, it is set up and Content Rewards knows it, ``_place_refusal``) and the clip must still
    fit with TikTok among its places, with the Mac's choices."""
    from .oauth import setup as platform_setup
    from .routes import clips as checks

    setups = platform_setup.all_setups(app.store, user_id)
    linked = (app.store.get(db.user_pk(user_id), "CRCONN") or {}).get("crLinked")
    refusal = checks._place_refusal("tiktok", campaign, setups, linked, mac_on=True)
    if refusal is None:
        places = [p for p in posts.UPLOAD_ORDER if p in {*chosen, "tiktok"}]
        try:
            checks._require_fit(app, user_id, item, captions=item.get("captions"), chosen=places, tiktok=tiktok)
        except ApiError as e:
            refusal = e.message
    if refusal is not None:
        log("info", "clip.campaign_mac_skipped", clipId=item["clipId"], reason=refusal)
    return refusal
