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
from .app import App
from .clock import iso
from .errors import bad_request
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
) -> tuple[Item, list[Item]]:
    """Uploads ``item`` (a clip in Review) and returns the confirmed clip (internal shape) and its posts. ``platforms``
    picks exactly where it goes; without it (older clients) Settings › Where clips go decides. ``options`` are the
    per-clip choices for YouTube, Instagram and X (§36.3); only the places that go keep theirs. ``tiktok`` is the
    TikTok sheet's choices, required when TikTok goes (§17.8). A campaign clip (§38.14) must name its places, only ones
    the campaign pays for, while the campaign takes clips, public and never made for kids. Raises Upload's own
    400/409 ``ApiError`` sentences, and ``ClipTaken`` when the clip left Review meanwhile.

    ``auto`` (``{runId, at, test?}``, only ever set by an auto-posting run, §46.7) marks the clip (internal
    ``autoRun``, ``autoAt``, ``autoTest``) and every post (``autoRun``); with ``test: "private"`` every post's
    ``postOptions`` also says ``test: "private"`` (§46.8). No request body can set these. With ``auto`` the clip's
    write also needs no live Throw away hold (``holdUntil`` absent or past, §46.7); Upload by hand ignores the hold."""
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
    if campaign is not None and chosen is not None:
        checks._require_campaign_open(app, campaign)
        checks._require_campaign_places(app, user_id, campaign, chosen)
        if "youtube" in chosen:
            per_clip = {**per_clip, "youtube": checks._campaign_youtube(per_clip)}
        checks._require_campaign_tiktok(tiktok if "tiktok" in chosen else None)
        checks._require_fit(
            app,
            user_id,
            item,
            captions=clips.merged_captions(item.get("captions"), patch),
            chosen=chosen,
            tiktok=tiktok if "tiktok" in chosen else None,
        )
    fields: Item = {
        "status": "confirmed",
        "decidedAt": now,
        "captions": clips.merged_captions(item.get("captions"), patch),
        "publishState": clips.PUBLISH_PENDING,
        "flowRun": 1,
    }
    if chosen is not None:
        fields["uploadTo"] = chosen
    post_options: dict[str, dict[str, Any]] = {
        **{p: o for p, o in per_clip.items() if chosen is None or p in chosen},
        **({"tiktok": tiktok} if tiktok else {}),
    }
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
    )
    return confirmed, created
