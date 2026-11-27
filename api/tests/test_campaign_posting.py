"""Posting Content Rewards campaign clips (docs/CONTRACTS.md §38.14, tests §38.20 "api posting (B)").

Confirm and Try again for campaign clips (every 400/409), the places rule, the posts' ``campaignId`` and
``postOptions.campaign``; the publishers' request shapes (YouTube Paid promotion and its retry, X's paid partnership
and its retry, TikTok branded and public, Meta nothing extra); ``campaign_caption`` on every platform; never made for
kids; and no publisher or adapter that can take a post down. Offline: recorded answers and in-memory items only. The
Content Rewards items are seeded with their literal keys (§38.11), as the API reads them.
"""

from __future__ import annotations

import inspect
import json
import re
from typing import Any

import pytest

from clipfactory_api import db, posts
from clipfactory_api.platforms import base, make_adapters
from clipfactory_api.platforms import publishers as publishers_module
from clipfactory_api.platforms.base import Published, PublishError
from clipfactory_api.platforms.campaign_caption import (
    campaign_caption,
    campaign_options,
    disclosure_of,
    required_items,
    x_length,
)
from clipfactory_api.platforms.publishers import (
    PUBLISHERS,
    AdapterPublisher,
    FacebookPublisher,
    InstagramPublisher,
    LabelledPublished,
    TikTokPublisher,
    XPublisher,
    YouTubePublisher,
    caption,
    x_text,
)
from conftest import NOW, USER, Call, seed_clip, seed_job
from fakes import FakeHttp, FakeLambda, FakeTable
from test_publishers import SESSION, form, make_job

CAMPAIGN = "0b5c1f3e-1a2b-4c3d-9e8f-123456789abc"
RULES: dict[str, Any] = {
    "lengthMinSec": 15,
    "lengthMaxSec": 60,
    "requiredHashtags": ["#FaZe"],
    "requiredTags": ["@FaZeClan"],
    "requiredCaptionText": None,
    "disclosure": {"caption": "#Ad", "onScreen": "Paid partnership", "spoken": False},
    "logo": {"required": False, "rules": None},
    "bannedContent": [],
}
CAMPAIGN_OPTIONS = {"paidPartnership": True, "disclosure": "#Ad", "required": ["#FaZe", "@FaZeClan"]}
TIKTOK = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": True,
    "brandOrganic": False,
}
PK = db.user_pk(USER)


# --- small fakes: the items, with their literal keys ---------------------------------------------------------------


def put_campaign(store: db.Store, **fields: Any) -> dict[str, Any]:
    item = {
        "pk": PK,
        "sk": f"CAMPAIGN#{CAMPAIGN}",
        "type": "campaign",
        "campaignId": CAMPAIGN,
        "name": "FaZe Clips",
        "brand": "FaZe",
        "state": "active",
        "membership": "in",
        "platformsPaid": ["youtube", "instagram"],
        "rules": RULES,
        "rulesState": "ready",
        **fields,
    }
    store.put(item)
    return item


def put_job_campaign(store: db.Store, **campaign: Any) -> dict[str, Any]:
    """A job made for the campaign: its internal ``campaign`` (``JobCampaign``, §38.8)."""
    found = {
        "campaignId": CAMPAIGN,
        "name": "FaZe Clips",
        "brand": "FaZe",
        "platformsPaid": ["youtube", "instagram"],
        "rules": RULES,
        "plainRules": ["Every caption has #FaZe and @FaZeClan."],
        "rulesVersion": 1,
        "at": "2026-11-15T11:00:00.000Z",
        **campaign,
    }
    return seed_job(store, status="ready", campaignId=CAMPAIGN, campaign=found)


def campaign_clip(store: db.Store, **fields: Any) -> dict[str, Any]:
    job = put_job_campaign(store)
    return seed_clip(store, job_id=job["jobId"], campaignId=CAMPAIGN, **fields)


def ready(store: db.Store, *places: str, audit: str | None = None, review: str | None = None) -> None:
    """Connected and ready on Set up posting (§17.4): YouTube's published app ticked, TikTok's audit and app review
    as given (both ``ok`` / ``live``: TikTok approved the app, so a campaign clip's TikTok may go through its API)."""
    for platform in places:
        store.put(
            {
                "pk": PK,
                "sk": f"ACCOUNT#{platform}",
                "type": "account",
                "userId": USER,
                "platform": platform,
                "status": "connected",
            }
        )
        setup: dict[str, Any] = {"pk": PK, "sk": f"SETUP#{platform}", "type": "setup", "platform": platform}
        if platform == "youtube":
            setup["stepsDone"] = ["key-publish"]
        if platform == "tiktok" and (audit or review):
            setup["gates"] = {
                **({"posting_audit": {"state": audit, "at": "2026-11-14T10:00:00.000Z"}} if audit else {}),
                **({"app_review": {"value": review}} if review else {}),
            }
        store.put(setup)


def put_crconn(store: db.Store, **fields: Any) -> None:
    store.put({"pk": PK, "sk": "CRCONN", "type": "crconn", "status": "connected", "crLinked": {}, **fields})


def confirm(call: Call, clip_id: str, body: dict[str, Any]) -> tuple[int, Any]:
    return call("POST", f"/v1/clips/{clip_id}/confirm", body)


def stored_posts(table: FakeTable) -> dict[str, dict[str, Any]]:
    return {p["platform"]: p for p in table.all() if p.get("type") == "post"}


def message(body: Any) -> str:
    return str(body["error"]["message"])


# --- Confirm: what a campaign post carries ---------------------------------------------------------------------------


def test_campaign_posts_carry_campaign_id_and_the_campaign_options(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert status == 200
    assert {p["platform"]: p.get("campaignId") for p in body["posts"]} == {"youtube": CAMPAIGN, "instagram": CAMPAIGN}
    found = stored_posts(table)
    assert found["youtube"]["campaignId"] == CAMPAIGN
    assert found["youtube"]["postOptions"] == {"privacy": "public", "madeForKids": False, "campaign": CAMPAIGN_OPTIONS}
    assert found["instagram"]["postOptions"] == {"campaign": CAMPAIGN_OPTIONS}
    # postOptions are internal: never in an answer.
    assert all("postOptions" not in p for p in body["posts"])


def test_youtube_options_are_forced_public_and_not_for_kids(call: Call, store: db.Store, table: FakeTable) -> None:
    ready(store, "youtube")
    put_campaign(store)
    clip = campaign_clip(store)
    options = {"youtube": {"category": "24", "notifySubscribers": False, "privacy": "public"}}
    assert confirm(call, clip["clipId"], {"platforms": ["youtube"], "options": options})[0] == 200
    assert stored_posts(table)["youtube"]["postOptions"] == {
        "category": "24",
        "notifySubscribers": False,
        "privacy": "public",
        "madeForKids": False,
        "campaign": CAMPAIGN_OPTIONS,
    }


@pytest.mark.parametrize(
    ("youtube", "sentence"),
    [
        ({"privacy": "unlisted"}, "Campaign clips must be public. Pick Everyone."),
        ({"privacy": "private"}, "Campaign clips must be public. Pick Everyone."),
        ({"madeForKids": True}, "Campaign clips are never made for kids."),
    ],
)
def test_youtube_choices_a_campaign_cannot_take_are_refused(
    call: Call, store: db.Store, youtube: dict[str, Any], sentence: str
) -> None:
    ready(store, "youtube")
    put_campaign(store)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"], "options": {"youtube": youtube}})
    assert (status, message(body)) == (400, sentence)
    assert posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) == []


def test_a_campaign_clip_must_name_its_places(call: Call, store: db.Store) -> None:
    ready(store, "youtube")
    put_campaign(store)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {})
    assert (status, message(body)) == (400, "Pick where it goes, then tap Upload.")
    stored = store.get(PK, db.clip_sk(clip["clipId"]))
    assert stored is not None
    assert stored["status"] == "review"


def test_a_place_off_the_live_campaign_list_is_refused(call: Call, store: db.Store) -> None:
    ready(store, "youtube", "instagram", "x")
    # The brand dropped Instagram since the job started: the live CAMPAIGN# list wins over the job's copy.
    put_campaign(store, platformsPaid=["youtube"])
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert (status, message(body)) == (400, "This campaign doesn't pay for Instagram. Turn it off, then tap Upload.")
    status, body = confirm(call, clip["clipId"], {"platforms": ["x"]})
    assert (status, message(body)) == (400, "This campaign doesn't pay for X. Turn it off, then tap Upload.")
    assert confirm(call, clip["clipId"], {"platforms": ["youtube"]})[0] == 200


def test_the_jobs_places_count_only_when_the_campaign_item_has_none(call: Call, store: db.Store) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store, platformsPaid=[])
    clip = campaign_clip(store)
    assert confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})[0] == 200


# --- the places rule (§38.8 uploadPlaces: paid ∩ ready ∩ not crLinked false, TikTok only after its audit) ------------


def test_nothing_set_up_is_refused(call: Call, store: db.Store) -> None:
    put_campaign(store)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert (status, message(body)) == (400, "YouTube is not set up yet. Turn it off, then tap Upload.")


def test_a_connected_place_that_is_not_ready_is_refused(call: Call, store: db.Store) -> None:
    ready(store, "instagram")
    store.put({"pk": PK, "sk": "ACCOUNT#youtube", "type": "account", "platform": "youtube", "status": "connected"})
    put_campaign(store)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert (status, message(body)) == (400, "YouTube is not set up yet. Turn it off, then tap Upload.")


@pytest.mark.parametrize(
    ("audit", "review"),
    [
        (None, None),
        ("unknown", "live"),
        ("waiting", "live"),
        ("limited", "live"),
        # The posting audit alone is not TikTok's approval: the app review must be live too (D1).
        ("ok", None),
        ("ok", "in_review"),
        ("ok", "draft"),
    ],
)
def test_tiktok_is_refused_until_tiktok_approved_the_app(
    call: Call, store: db.Store, table: FakeTable, audit: str | None, review: str | None
) -> None:
    ready(store, "youtube", "tiktok", audit=audit, review=review)
    put_campaign(store, platformsPaid=["youtube", "tiktok"])
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "tiktok"], "tiktok": TIKTOK})
    assert (status, message(body)) == (
        400,
        "Campaign clips go on TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok. "
        "Or turn TikTok off, then tap Upload.",
    )
    assert stored_posts(table) == {}


def test_tiktok_goes_after_its_audit_branded_and_public(call: Call, store: db.Store, table: FakeTable) -> None:
    ready(store, "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["tiktok"])
    clip = campaign_clip(store)
    status, _ = confirm(call, clip["clipId"], {"platforms": ["tiktok"], "tiktok": TIKTOK})
    assert status == 200
    assert stored_posts(table)["tiktok"]["postOptions"] == {**TIKTOK, "campaign": CAMPAIGN_OPTIONS}


def test_a_tiktok_only_campaign_before_the_audit_has_no_place(call: Call, store: db.Store) -> None:
    ready(store, "youtube", "tiktok")
    put_campaign(store, platformsPaid=["tiktok"])
    clip = campaign_clip(store)
    assert confirm(call, clip["clipId"], {"platforms": ["tiktok"], "tiktok": TIKTOK})[0] == 400
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert (status, message(body)) == (400, "This campaign doesn't pay for YouTube. Turn it off, then tap Upload.")


@pytest.mark.parametrize(
    ("tiktok", "sentence"),
    [
        ({**TIKTOK, "privacyLevel": "MUTUAL_FOLLOW_FRIENDS"}, "Campaign clips must be public. Pick Everyone."),
        (
            {**TIKTOK, "privacyLevel": "SELF_ONLY", "brandContent": False},
            "Campaign clips must be public. Pick Everyone.",
        ),
        ({**TIKTOK, "brandContent": False}, "Turn on Branded content on TikTok for campaign clips."),
        (
            {**TIKTOK, "brandContent": False, "brandOrganic": True},
            "Turn on Branded content on TikTok for campaign clips.",
        ),
    ],
)
def test_tiktok_choices_a_campaign_cannot_take_are_refused(
    call: Call, store: db.Store, tiktok: dict[str, Any], sentence: str
) -> None:
    ready(store, "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["tiktok"])
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["tiktok"], "tiktok": tiktok})
    assert (status, message(body)) == (400, sentence)


def test_tiktok_still_needs_the_owners_own_choice(call: Call, store: db.Store) -> None:
    """Nothing picks who can see it for him (§17.8), not even for a campaign clip."""
    ready(store, "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["tiktok"])
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["tiktok"]})
    assert (status, message(body)) == (400, "Pick who can see it on TikTok.")


def test_a_place_content_rewards_refused_as_unlinked_comes_back_after_i_added_it(call: Call, store: db.Store) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store)
    put_crconn(store, crLinked={"youtube": False, "instagram": True})
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert status == 400
    assert message(body) == (
        "Add YouTube in Content Rewards first. Then tap I added it, or turn YouTube off and tap Upload."
    )
    # "I added it" (PATCH …/connection {"relinked": "youtube"}) puts it back to unknown (§39.1: "add", never "link").
    put_crconn(store, crLinked={"instagram": True})
    assert confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})[0] == 200


# --- the campaign must take clips ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fields", "sentence"),
    [
        ({"state": "ended"}, "This campaign has ended. Pick another one."),
        ({"state": "paused"}, "The brand paused this campaign. I'll tell you when it opens again."),
        ({"membership": "not_joined"}, "Not joined yet: tap Join Campaign on Content Rewards. I'll see it by myself."),
        ({"membership": "waiting"}, "The brand hasn't let you in yet. I'll tell you when you're in."),
        ({"membership": "not_accepted"}, "The brand said no to this one. That's OK! Pick another campaign."),
        ({"membership": "unknown"}, "Connect Content Rewards so I can see if you're in."),
        (
            {"held": {"at": "2026-11-15T09:00:00.000Z", "pending": 5}},
            "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
        ),
        (
            # Older than a day but not cleared yet: still held, as the card's stop says, until the poller clears it.
            {"held": {"at": "2026-11-14T11:00:00.000Z", "pending": 5}},
            "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
        ),
    ],
)
def test_a_campaign_that_does_not_take_clips_is_refused(
    call: Call, store: db.Store, fields: dict[str, Any], sentence: str
) -> None:
    ready(store, "youtube")
    put_campaign(store, **fields)
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert (status, body["error"]["code"], message(body)) == (409, "conflict", sentence)
    assert posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) == []


def test_a_removed_campaign_is_refused(call: Call, store: db.Store) -> None:
    ready(store, "youtube")
    clip = campaign_clip(store)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert (status, message(body)) == (409, "Add the campaign again on the Campaigns page.")


@pytest.mark.parametrize("fields", [{"membership": "manual"}, {"held": None}, {"held": {}}])
def test_manual_membership_and_a_cleared_hold_can_post(call: Call, store: db.Store, fields: dict[str, Any]) -> None:
    ready(store, "youtube")
    put_campaign(store, **fields)
    clip = campaign_clip(store)
    assert confirm(call, clip["clipId"], {"platforms": ["youtube"]})[0] == 200


def test_a_clip_that_outlived_its_job_follows_the_campaign_items_rules(
    call: Call, store: db.Store, table: FakeTable
) -> None:
    ready(store, "youtube")
    put_campaign(store, rules={**RULES, "disclosure": {"caption": "#Sponsored"}, "requiredTags": []})
    clip = seed_clip(store, campaignId=CAMPAIGN)  # its job is gone (§34 keeps clips waiting in Review)
    assert confirm(call, clip["clipId"], {"platforms": ["youtube"]})[0] == 200
    assert stored_posts(table)["youtube"]["postOptions"]["campaign"] == {
        "paidPartnership": True,
        "disclosure": "#Sponsored",
        "required": ["#FaZe"],
    }


def test_a_clip_without_a_campaign_is_unchanged(call: Call, store: db.Store, table: FakeTable) -> None:
    ready(store, "youtube")
    put_campaign(store)
    clip = seed_clip(store)
    options = {"youtube": {"privacy": "unlisted", "madeForKids": True}}
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"], "options": options})
    assert status == 200
    assert "campaignId" not in body["posts"][0]
    assert stored_posts(table)["youtube"]["postOptions"] == options["youtube"]


# --- Try again and Post now run the same checks --------------------------------------------------------------------


def failed_campaign_clip(
    store: db.Store, *places: str, status: str = "failed", post_status: str = "failed"
) -> dict[str, Any]:
    clip = campaign_clip(store, status=status, publishState="started", postsCreated=True, flowRun=1)
    for platform in places:
        options: dict[str, Any] = {"campaign": CAMPAIGN_OPTIONS}
        if platform == "tiktok":
            options = {**TIKTOK, **options}
        store.put(
            {
                "pk": PK,
                "sk": db.post_sk(f"P{platform}"),
                "gsi1pk": f"CLIP#{clip['clipId']}",
                "gsi1sk": f"POST#{platform}",
                "type": "post",
                "userId": USER,
                "postId": f"P{platform}",
                "clipId": clip["clipId"],
                "platform": platform,
                "status": post_status,
                "campaignId": CAMPAIGN,
                "flowRun": 1,
                "error": "Posting did not work. Press Try again.",
                "postOptions": options,
            }
        )
    store.update(PK, db.clip_sk(clip["clipId"]), {"postIds": [f"P{p}" for p in places]})
    return clip


@pytest.mark.parametrize(
    ("fields", "status", "sentence"),
    [
        ({"state": "ended"}, 409, "This campaign has ended. Pick another one."),
        ({"membership": "left"}, 409, "Content Rewards doesn't show this campaign for you any more."),
        (
            {"platformsPaid": ["instagram"]},
            400,
            "This campaign doesn't pay for YouTube any more. Tap Try again on another place.",
        ),
    ],
)
def test_try_again_runs_the_campaign_checks(
    call: Call, store: db.Store, lambda_client: FakeLambda, fields: dict[str, Any], status: int, sentence: str
) -> None:
    ready(store, "youtube")
    put_campaign(store, **fields)
    clip = failed_campaign_clip(store, "youtube")
    code, body = confirm(call, clip["clipId"], {})
    assert code == status
    assert message(body).startswith(sentence)
    assert store.get(PK, db.post_sk("Pyoutube"))["status"] == "failed"  # type: ignore[index]
    assert lambda_client.calls == []


@pytest.mark.parametrize(
    ("place", "setup", "sentence"),
    [
        (
            "youtube",
            {"paid": ["instagram"]},
            "This campaign doesn't pay for YouTube any more. Tap Try again on another place.",
        ),
        (
            "youtube",
            {"ready": False},
            "YouTube is not set up yet. Set it up in Settings › Posting › Set up posting, then tap Try again.",
        ),
        (
            "tiktok",
            {"audit": "waiting"},
            "Campaign clips go on TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok. "
            "Tap Try again on another place.",
        ),
        (
            "tiktok",
            {"audit": "ok", "review": None},
            "Campaign clips go on TikTok from your Mac. Turn it on in Settings › Posting › Your Mac posts TikTok. "
            "Tap Try again on another place.",
        ),
        ("youtube", {"unlinked": True}, "Add YouTube in Content Rewards first, then tap Try again."),
    ],
)
def test_try_again_says_what_to_tap_on_its_own_screen(
    call: Call, store: db.Store, lambda_client: FakeLambda, place: str, setup: dict[str, Any], sentence: str
) -> None:
    """Library and the post line have no switch and no Upload: the sentences name Try again (§38.1)."""
    if setup.get("ready", True):
        ready(store, place, audit=setup.get("audit", "ok"), review=setup.get("review", "live"))
    put_campaign(store, platformsPaid=setup.get("paid", ["youtube", "tiktok"]))
    if setup.get("unlinked"):
        put_crconn(store, crLinked={place: False})
    clip = failed_campaign_clip(store, place, status="posted")
    body = {"platforms": [place], **({"tiktok": TIKTOK} if place == "tiktok" else {})}
    status, answer = confirm(call, clip["clipId"], body)
    assert (status, message(answer)) == (400, sentence)
    assert "Upload" not in sentence
    assert lambda_client.calls == []


def test_try_again_through_tiktoks_api_with_the_mac_on_says_the_mac_posts_it(
    call: Call, store: db.Store, lambda_client: FakeLambda
) -> None:
    """Before TikTok approves the app its API would post a campaign clip privately: the owner's Mac posts it."""
    assert call("PUT", "/v1/settings", {"tiktokMac": {"on": True}})[0] == 200
    ready(store, "tiktok", audit="waiting")
    put_campaign(store, platformsPaid=["youtube", "tiktok"])
    clip = failed_campaign_clip(store, "tiktok", status="posted")
    status, answer = confirm(call, clip["clipId"], {"platforms": ["tiktok"], "tiktok": TIKTOK})
    assert (status, message(answer)) == (400, "Your Mac posts campaign clips on TikTok. Tap Post with my Mac.")
    assert lambda_client.calls == []


def test_try_again_keeps_the_campaign_options(call: Call, store: db.Store, table: FakeTable) -> None:
    ready(store, "youtube", "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["youtube", "tiktok"])
    clip = failed_campaign_clip(store, "youtube", "tiktok")
    friends = {**TIKTOK, "privacyLevel": "MUTUAL_FOLLOW_FRIENDS"}
    status, body = confirm(call, clip["clipId"], {"tiktok": friends})
    assert (status, message(body)) == (400, "Campaign clips must be public. Pick Everyone.")
    picked = {**TIKTOK, "disableComment": True}
    status, body = confirm(call, clip["clipId"], {"tiktok": picked})
    assert status == 200
    found = stored_posts(table)
    assert {p: found[p]["status"] for p in found} == {"youtube": "queued", "tiktok": "queued"}
    # Try again replaces TikTok's choices; the campaign part goes along unchanged.
    assert found["tiktok"]["postOptions"] == {**picked, "campaign": CAMPAIGN_OPTIONS}
    assert found["youtube"]["postOptions"] == {"campaign": CAMPAIGN_OPTIONS}
    assert {p["campaignId"] for p in body["posts"]} == {CAMPAIGN}


def test_post_now_runs_the_campaign_checks(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store, held={"at": "2026-11-15T11:30:00.000Z", "pending": 3})
    clip = failed_campaign_clip(store, "youtube", status="posted", post_status="pending_integration")
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube"]})
    assert (status, message(body)) == (
        409,
        "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.",
    )
    assert lambda_client.calls == []
    put_campaign(store)  # the brand checked the other clips: the hold is gone
    assert confirm(call, clip["clipId"], {"platforms": ["youtube"]})[0] == 200
    assert store.get(PK, db.post_sk("Pyoutube"))["status"] == "queued"  # type: ignore[index]


# --- campaign_caption (pure) ---------------------------------------------------------------------------------------


def test_required_items_and_the_campaign_options() -> None:
    assert required_items(RULES) == ["#FaZe", "@FaZeClan"]
    rules = {**RULES, "requiredCaptionText": "[your hook] @fazeclan #FaZeUp"}
    assert required_items(rules) == ["#FaZe", "@FaZeClan", "#FaZeUp"]  # tokens only: each once
    rules = {**RULES, "requiredCaptionText": "Use code {code} FAZE10 at checkout"}
    assert required_items(rules) == ["#FaZe", "@FaZeClan", "Use code FAZE10 at checkout"]
    assert required_items(None) == []
    assert campaign_options(RULES) == CAMPAIGN_OPTIONS
    assert campaign_options({**RULES, "disclosure": {"caption": "#PaidPartnership"}})["disclosure"] == (
        "#PaidPartnership"
    )
    assert campaign_options({"disclosure": {"caption": "<b>ad</b>"}}) == {
        "paidPartnership": True,
        "disclosure": "#Ad",
        "required": [],
    }
    assert [disclosure_of(v) for v in ("#sponsored", "#AD", None, 3)] == ["#sponsored", "#Ad", "#Ad", "#Ad"]


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "instagram", "facebook", "x"])
def test_the_disclosure_goes_first_and_every_required_item_is_added(platform: str) -> None:
    out = campaign_caption(platform, "wait for it", CAMPAIGN_OPTIONS)
    if platform == "youtube":  # the tags sit right after #Ad: YouTube shows only the first hashtags (§38.14)
        assert out.startswith("#Ad #FaZe @FaZeClan wait for it")
    else:
        assert out.startswith("#Ad wait for it")
        assert out.endswith("#FaZe @FaZeClan")
    assert out.count("#FaZe") == 1


@pytest.mark.parametrize(
    "text",
    [
        "#ad wait for it #FaZe @FaZeClan",
        "Wait for it #AD @fazeclan #faze",
        "#Sponsored wait #FaZe and @FaZeClan.",
    ],
)
def test_a_caption_that_already_qualifies_is_kept(text: str) -> None:
    assert campaign_caption("tiktok", text, CAMPAIGN_OPTIONS) == text


def test_a_late_disclosure_moves_to_the_front() -> None:
    text = "This is the craziest moment of the stream #FaZe @FaZeClan #Ad"
    assert campaign_caption("tiktok", text, CAMPAIGN_OPTIONS) == (
        "#Ad This is the craziest moment of the stream #FaZe @FaZeClan"
    )


def test_a_lookalike_is_not_the_required_item() -> None:
    out = campaign_caption("tiktok", "#Ad wow #FaZeClan @FaZeClanFan #adventure", CAMPAIGN_OPTIONS)
    assert out == "#Ad wow #FaZeClan @FaZeClanFan #adventure\n\n#FaZe @FaZeClan"


def test_an_edited_caption_is_fixed() -> None:
    """The owner deleted #Ad and the tag on Review: the publisher puts them back (§38.5)."""
    edited = "my own words\nsecond line  #FaZe"
    assert campaign_caption("instagram", edited, CAMPAIGN_OPTIONS) == "#Ad my own words\nsecond line #FaZe\n\n@FaZeClan"


def test_another_disclosure_and_a_phrase() -> None:
    options = {"paidPartnership": True, "disclosure": "#Sponsored", "required": ["Use code FAZE10"]}
    assert campaign_caption("facebook", "Watch this", options) == "#Sponsored Watch this\n\nUse code FAZE10"
    assert campaign_caption("facebook", "use  code faze10 now", options) == "#Sponsored use code faze10 now"


def test_the_brands_own_disclosure_is_never_stood_in_for() -> None:
    """The brand asked for #Sponsored: a #ad the owner typed doesn't count, so #Sponsored still goes first."""
    options = {"paidPartnership": True, "disclosure": "#Sponsored", "required": ["#FaZe"]}
    assert campaign_caption("tiktok", "#ad wait for it #FaZe", options) == "#Sponsored #ad wait for it #FaZe"
    assert campaign_caption("tiktok", "#sponsored wait for it #FaZe", options) == "#sponsored wait for it #FaZe"
    paid = {**options, "disclosure": "#PaidPartnership"}
    assert campaign_caption("x", "#Sponsored wow #FaZe", paid) == "#PaidPartnership #Sponsored wow #FaZe"
    # With #Ad (the default) any #ad-like tag up front counts, as the agent's rule (§38.13).
    assert campaign_caption("tiktok", "#Sponsored wow #FaZe @FaZeClan", CAMPAIGN_OPTIONS) == (
        "#Sponsored wow #FaZe @FaZeClan"
    )


def test_without_a_campaign_the_caption_is_unchanged() -> None:
    assert campaign_caption("instagram", "  No way #gaming  ", None) == "  No way #gaming  "


def test_instagram_keeps_the_required_hashtags_inside_30() -> None:
    text = "No way " + " ".join(f"#tag{i}" for i in range(40))
    out = campaign_caption("instagram", text, CAMPAIGN_OPTIONS)
    tags = re.findall(r"#\w+", out)
    assert len(tags) == 30
    assert tags[0] == "#Ad"
    assert "#FaZe" in tags
    assert "@FaZeClan" in out
    assert "#tag27" in tags
    assert "#tag28" not in tags  # the last free hashtags are the ones dropped


def test_instagram_keeps_the_required_items_inside_2200_characters() -> None:
    out = campaign_caption("instagram", "word " * 600, CAMPAIGN_OPTIONS)
    assert len(out) <= 2200
    assert out.startswith("#Ad word")
    assert out.endswith("…\n\n#FaZe @FaZeClan")


def test_x_shortens_the_free_text_and_never_a_tag() -> None:
    options = {**CAMPAIGN_OPTIONS, "required": ["#FaZe", "#FaZeUp", "@FaZeClan", "@FaZeBanks"]}
    text = "So " + "unreal " * 60 + "#FaZe in the middle"
    out = campaign_caption("x", text, options)
    assert len(out) <= 280
    assert out.startswith("#Ad So unreal")
    assert out.endswith("… #FaZe #FaZeUp @FaZeClan @FaZeBanks")
    assert "\n" not in out


def test_x_counts_emoji_and_cjk_twice() -> None:
    assert x_length("abc é ü \u2018\u2019 \u2014 ") == 13  # Latin, its accents and common punctuation count 1
    assert x_length("😀") == x_length("字") == x_length("…") == 2
    out = campaign_caption("x", "😀" * 200, CAMPAIGN_OPTIONS)
    assert x_length(out) <= 280
    assert out.startswith("#Ad 😀")
    assert out.endswith("… #FaZe @FaZeClan")
    assert x_text(out) == out  # nothing more to cut: the tags reach X whole
    text = "字" * 100 + " then " + "😀" * 100
    out = campaign_caption("x", text, CAMPAIGN_OPTIONS)
    assert x_length(out) <= 280
    assert out.endswith(" #FaZe @FaZeClan")


def test_x_cuts_a_post_without_a_campaign_by_xs_count() -> None:
    assert x_text("😀 " * 100) == ("😀 " * 92).strip() + "…"  # 200 characters, but 300 to X
    assert x_length(x_text("😀 " * 100)) <= 280
    assert x_text("a " * 100) == ("a " * 100).strip()  # under 280 as X counts it: unchanged


def test_youtube_description_fits_5000_bytes() -> None:
    out = campaign_caption("youtube", "é" * 3000, CAMPAIGN_OPTIONS)
    assert len(out.encode()) <= 5000
    assert out.startswith("#Ad é")
    assert out.endswith("#FaZe @FaZeClan")


# --- publisher request shapes --------------------------------------------------------------------------------------


def youtube_job(http: FakeHttp, **kw: Any) -> tuple[Any, list[dict[str, Any]]]:
    options = {"privacy": "public", "madeForKids": False, "campaign": CAMPAIGN_OPTIONS, **kw.pop("options", {})}
    job, saved, _ = make_job("youtube", http, options=options, **kw)
    return job, saved


def test_youtube_campaign_start_turns_paid_promotion_on() -> None:
    http = FakeHttp((200, b"", {"Location": SESSION}), (201, "publish/youtube_video"))
    job, saved = youtube_job(http)
    YouTubePublisher().start(job)
    init = http.calls[0]
    assert init.url == (
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable"
        "&part=snippet,status,paidProductPlacementDetails"
    )
    assert json.loads(init.body) == {
        "snippet": {
            "title": "He did WHAT",
            "description": "#Ad #FaZe @FaZeClan Full stream on the channel.",
            "categoryId": "20",
        },
        "status": {"privacyStatus": "public", "selfDeclaredMadeForKids": False, "containsSyntheticMedia": False},
        "paidProductPlacementDetails": {"hasPaidProductPlacement": True},
    }
    assert saved == [{"sessionUri": SESSION}, {"videoId": "vid123"}]


@pytest.mark.parametrize("fixture", ["publish/youtube_campaign_paid_refused", "publish/youtube_campaign_part_refused"])
def test_youtube_refusing_paid_promotion_starts_once_more_without_it(
    fixture: str, store: db.Store, capsys: pytest.CaptureFixture[str]
) -> None:
    http = FakeHttp((400, fixture), (200, b"", {"Location": SESSION}), (201, "publish/youtube_video"))
    job, saved = youtube_job(http)
    progress = YouTubePublisher().start(job)
    first, second, upload = http.calls
    assert first.url.endswith("&part=snippet,status,paidProductPlacementDetails")
    assert second.url.endswith("&part=snippet,status")
    assert "paidProductPlacementDetails" not in json.loads(second.body)
    assert json.loads(second.body)["status"]["privacyStatus"] == "public"
    assert upload.method == "PUT"  # the video is sent once, after the session exists
    assert saved == [{"sessionUri": SESSION, "paidLabel": "not_set"}, {"paidLabel": "not_set", "videoId": "vid123"}]
    assert "publish.youtube_paid_refused" in capsys.readouterr().out
    # The finished post says so: paidLabel "not_set" is public on the Post.
    done = YouTubePublisher().published(job, progress.handle)
    assert isinstance(done, LabelledPublished)
    assert done.paid_label == "not_set"
    item = {"pk": PK, "sk": db.post_sk("P1"), "type": "post", "postId": "P1", "platform": "youtube", "status": "queued"}
    store.put(item)
    written = posts.mark_posted(store, item, done, NOW)
    assert written["paidLabel"] == "not_set"
    assert posts.public_post(written)["paidLabel"] == "not_set"


def test_youtube_forbidding_paid_promotion_starts_once_more_without_it(capsys: pytest.CaptureFixture[str]) -> None:
    """A 403 that names the part (a feature this app isn't allowed, §38.21) is a refusal too, not a dead end."""
    http = FakeHttp(
        (403, "publish/youtube_campaign_paid_forbidden"),
        (200, b"", {"Location": SESSION}),
        (201, "publish/youtube_video"),
    )
    job, saved = youtube_job(http)
    YouTubePublisher().start(job)
    first, second, upload = http.calls
    assert first.url.endswith(",paidProductPlacementDetails")
    assert second.url.endswith("&part=snippet,status")
    assert upload.method == "PUT"
    assert saved[0] == {"sessionUri": SESSION, "paidLabel": "not_set"}
    assert "publish.youtube_paid_refused" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("status", "fixture"),
    [(400, "publish/youtube_campaign_bad_request"), (403, "publish/youtube_campaign_forbidden")],
)
def test_youtube_other_errors_are_not_retried_without_paid_promotion(status: int, fixture: str) -> None:
    http = FakeHttp((status, fixture))
    job, _ = youtube_job(http)
    with pytest.raises(PublishError):
        YouTubePublisher().start(job)
    assert len(http.calls) == 1


def test_youtube_resume_keeps_the_paid_label() -> None:
    http = FakeHttp((308, b"", {"Range": "bytes=0-1048575"}), (200, "publish/youtube_video"))
    job, saved = youtube_job(http, handle={"sessionUri": SESSION, "paidLabel": "not_set"})
    YouTubePublisher().start(job)
    assert saved[-1] == {"paidLabel": "not_set", "videoId": "vid123"}


@pytest.mark.parametrize(
    "options",
    [
        {"madeForKids": True, "privacy": "unlisted"},
        {"madeForKids": True, "privacy": "private"},
        {"selfDeclaredMadeForKids": True},
    ],
)
def test_a_campaign_post_is_never_made_for_kids_and_always_public(options: dict[str, Any]) -> None:
    job, _ = youtube_job(FakeHttp(), options=options, settings={"youtubePrivacy": "private"})
    status = YouTubePublisher().metadata(job)["status"]
    assert (status["privacyStatus"], status["selfDeclaredMadeForKids"]) == ("public", False)


def test_a_post_without_a_campaign_sends_no_paid_switch() -> None:
    job, _, _ = make_job("youtube", FakeHttp())
    assert "paidProductPlacementDetails" not in YouTubePublisher().metadata(job)
    assert "paidProductPlacementDetails" not in YouTubePublisher.upload_url(job)
    assert isinstance(YouTubePublisher().published(job, {"videoId": "v"}), Published)
    assert not isinstance(YouTubePublisher().published(job, {"videoId": "v"}), LabelledPublished)


def x_job(http: FakeHttp, campaign: dict[str, Any] | None = CAMPAIGN_OPTIONS) -> tuple[Any, list[dict[str, Any]]]:
    options = {"campaign": campaign} if campaign else {}
    job, saved, _ = make_job(
        "x",
        http,
        handle={"mediaId": "m1", "finalized": True},
        data={"username": "owner"},
        options=options,
        captions={"x": "unreal https://example.com/x"},
    )
    return job, saved


def test_x_campaign_tweet_is_a_paid_partnership() -> None:
    http = FakeHttp((201, "publish/x_tweet"))
    job, saved = x_job(http)
    done = XPublisher().finish(job, job.handle)
    assert json.loads(http.calls[0].body) == {
        "text": "#Ad unreal #FaZe @FaZeClan",
        "media": {"media_ids": ["m1"]},
        "paid_partnership": True,
    }
    assert saved == [{"mediaId": "m1", "finalized": True, "tweetId": "1880028300000000001"}]
    assert type(done.published) is Published


@pytest.mark.parametrize(
    ("status", "fixture"), [(400, "publish/x_campaign_paid_refused"), (403, "publish/x_campaign_paid_forbidden")]
)
def test_x_refusing_the_paid_partnership_tweets_once_more_without_it(
    status: int, fixture: str, capsys: pytest.CaptureFixture[str]
) -> None:
    http = FakeHttp((status, fixture), (201, "publish/x_tweet"))
    job, saved = x_job(http)
    done = XPublisher().finish(job, job.handle)
    first, second = (json.loads(c.body) for c in http.calls)
    assert first["paid_partnership"] is True
    assert second == {"text": "#Ad unreal #FaZe @FaZeClan", "media": {"media_ids": ["m1"]}}
    assert saved[-1]["paidLabel"] == "not_set"
    assert isinstance(done.published, LabelledPublished)
    assert done.published.paid_label == "not_set"
    assert "publish.x_paid_refused" in capsys.readouterr().out


def test_x_other_refusals_are_not_retried_without_the_paid_partnership() -> None:
    http = FakeHttp(
        (403, b'{"title": "Forbidden", "detail": "You are not allowed to create a Post with duplicate content."}')
    )
    job, saved = x_job(http)
    with pytest.raises(PublishError):
        XPublisher().finish(job, job.handle)
    assert len(http.calls) == 1
    assert saved == []


def test_x_without_a_campaign_is_unchanged() -> None:
    http = FakeHttp((201, "publish/x_tweet"))
    job, _ = x_job(http, campaign=None)
    XPublisher().finish(job, job.handle)
    assert json.loads(http.calls[0].body) == {"text": "unreal", "media": {"media_ids": ["m1"]}}


def test_tiktok_campaign_post_is_branded_and_public() -> None:
    http = FakeHttp((200, "publish/tiktok_creator"), (200, "publish/tiktok_init"), (201, b""))
    job, _, _ = make_job("tiktok", http, options={**TIKTOK, "campaign": CAMPAIGN_OPTIONS})
    TikTokPublisher().start(job)
    assert json.loads(http.calls[1].body)["post_info"] == {
        "title": "#Ad wait for it\n\n#FaZe @FaZeClan",
        "privacy_level": "PUBLIC_TO_EVERYONE",
        "disable_comment": False,
        "disable_duet": False,
        "disable_stitch": True,
        "brand_content_toggle": True,
        "brand_organic_toggle": False,
        "is_aigc": False,
    }


def test_instagram_campaign_post_sends_nothing_extra() -> None:
    http = FakeHttp(
        (200, "publish/instagram_limit"), (200, "publish/instagram_container"), (200, "publish/instagram_upload")
    )
    job, _, _ = make_job("instagram", http, data={"igUserId": "1784"}, options={"campaign": CAMPAIGN_OPTIONS})
    InstagramPublisher().start(job)
    container = form(http.calls[1])
    assert set(container) == {"media_type", "caption", "share_to_feed", "upload_type", "appsecret_proof"}
    assert container["caption"] == ["#Ad No way #gaming\n\n#FaZe @FaZeClan"]
    # The lookup of a published container matches the caption that was sent.
    assert caption(job, "instagram") == "#Ad No way #gaming\n\n#FaZe @FaZeClan"


def test_facebook_campaign_post_sends_nothing_extra() -> None:
    http = FakeHttp((200, "publish/facebook_finish"))
    job, _, _ = make_job(
        "facebook",
        http,
        data={"pageId": "p1"},
        handle={"videoId": "1234567890123", "uploaded": True},
        options={"campaign": CAMPAIGN_OPTIONS},
    )
    FacebookPublisher().finish(job, job.handle)
    finish = form(http.calls[0])
    assert set(finish) == {"upload_phase", "video_id", "video_state", "description", "appsecret_proof"}
    assert finish["description"] == ["#Ad Watch this\n\n#FaZe @FaZeClan"]


# --- nothing ever takes a post down ---------------------------------------------------------------------------------

TAKE_DOWN = re.compile(r"delete|unpublish|remove|takedown|take_down|privacy|hide|archive", re.IGNORECASE)


def test_no_publisher_or_adapter_can_delete_unpublish_or_change_privacy() -> None:
    classes: list[type[Any]] = [
        *(type(p()) for p in PUBLISHERS.values()),
        AdapterPublisher,
        *(type(a) for a in make_adapters().values()),
        base.AdapterBase,
    ]
    for cls in classes:
        names = [n for n, _ in inspect.getmembers(cls, inspect.isfunction) if not n.startswith("__")]
        assert not [n for n in names if TAKE_DOWN.search(n)], cls.__name__
        source = inspect.getsource(cls)
        assert '"DELETE"' not in source, cls.__name__
    # The publishers only ever create (POST/PUT) or read (GET).
    methods = set(re.findall(r'HttpRequest\("([A-Z]+)"', inspect.getsource(publishers_module)))
    assert methods <= {"GET", "POST", "PUT"}


def test_the_paid_label_is_public_and_the_campaign_options_are_not() -> None:
    item = {
        "postId": "P1",
        "clipId": "C1",
        "platform": "youtube",
        "status": "posted",
        "campaignId": CAMPAIGN,
        "paidLabel": "not_set",
        "postOptions": {"campaign": CAMPAIGN_OPTIONS},
        "publishHandle": {"paidLabel": "not_set"},
    }
    out = posts.public_post(item, NOW)
    assert (out["campaignId"], out["paidLabel"]) == (CAMPAIGN, "not_set")
    assert "postOptions" not in out
    assert "publishHandle" not in out


def test_mark_posted_without_a_label_writes_none(store: db.Store) -> None:
    item = {"pk": PK, "sk": db.post_sk("P2"), "type": "post", "postId": "P2", "platform": "x", "status": "queued"}
    store.put(item)
    written = posts.mark_posted(store, item, Published("https://x.com/o/status/1", "2026-11-15T12:00:00.000Z"), NOW)
    assert "paidLabel" not in written


# --- §39.3: the fit check at Confirm, Try again and Post now (Content Rewards switched on) -------------------------

FITS = {"items": [{"key": "disclosure", "label": "'Paid partnership' shows at the start", "pass": True}], "fixes": []}


@pytest.fixture
def cr_on(app: Any, secrets_client: Any, clock: Any) -> Any:
    """Content Rewards switched on (its deps exist): Confirm runs the fit after B's checks. Its fake fails any call:
    the fit reads stored items only."""
    from cr_support import FakeCR, make_deps

    deps = make_deps(app.store, secrets_client, FakeCR(), clock)
    app.contentrewards = deps
    return deps


def fitting_clip(store: db.Store, **fields: Any) -> dict[str, Any]:
    return campaign_clip(store, checklist=fields.pop("checklist", FITS), **fields)


def test_a_campaign_clip_that_can_earn_uploads_with_tags_and_ad_still_missing(
    call: Call, store: db.Store, table: FakeTable, cr_on: Any
) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store)
    put_crconn(store)
    clip = fitting_clip(store)  # CAPTIONS have neither #Ad nor #FaZe: the publisher puts them back (§38.14)
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert status == 200, body
    assert {p["platform"] for p in body["posts"]} == {"youtube", "instagram"}
    assert stored_posts(table)["instagram"]["postOptions"] == {"campaign": CAMPAIGN_OPTIONS}
    assert cr_on.net.requests == []


@pytest.mark.parametrize(
    ("campaign", "clip", "sentence"),
    [
        (
            {"rules": {**RULES, "clipUntil": "2026-11-01"}},
            {},
            "This clip can't earn on FaZe Clips: FaZe Clips stopped taking clips on 1 Nov.",
        ),
        (
            {},
            {"durationSec": 75.0},
            "This clip can't earn on FaZe Clips: This clip is 75 seconds. FaZe Clips takes 15 to 60 seconds.",
        ),
        (
            {},
            {"checklist": {"items": [], "fixes": []}},
            "This clip can't earn on FaZe Clips: “Paid partnership” isn't on the video. Clip Factory can't make a "
            "FaZe Clips copy yet. Make new clips for this campaign.",
        ),
        (
            {"rulesState": "reading"},
            {},
            "Not yet for FaZe Clips: Reading the rules… Look again in a minute.",
        ),
        (
            {"logo": {"needed": True, "state": "none"}, "rules": {**RULES, "logo": {"required": True, "rules": None}}},
            {},
            "This clip can't earn on FaZe Clips: Add the FaZe logo on the campaign page first.",
        ),
        (
            {"rules": {**RULES, "overlayRequired": True}},
            {},
            "This clip can't earn on FaZe Clips: This campaign wants its own picture on top of the video. Clip Factory "
            "can't add it yet. Pick another campaign.",
        ),
    ],
)
def test_confirm_refuses_a_campaign_clip_that_cant_earn(
    call: Call, store: db.Store, cr_on: Any, campaign: dict[str, Any], clip: dict[str, Any], sentence: str
) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store, **campaign)
    put_crconn(store)
    found = fitting_clip(store, **clip)
    status, body = confirm(call, found["clipId"], {"platforms": ["youtube", "instagram"]})
    assert (status, body["error"]["code"], message(body)) == (409, "conflict", sentence)
    assert posts.posts_for_clip(store, USER, found["clipId"], consistent=True) == []


def test_confirm_lets_a_clip_whose_rules_review_never_came_back_go_up(call: Call, store: db.Store, cr_on: Any) -> None:
    """The agent's "couldn't check" row reads ``pass: false``, but nothing was judged: it is the owner's own check
    (§39.3 ``banned`` "the review never came back"), never a refusal, and "Claude" never reaches the screen."""
    ready(store, "youtube", "instagram")
    put_campaign(store, rules={**RULES, "bannedContent": ["gambling"]})
    put_crconn(store)
    unchecked = {
        "key": "campaign_rules",
        "label": "Follows the campaign's rules (no banned content)",
        "pass": False,
        "note": "Claude couldn't check the campaign's rules. Check it yourself.",
    }
    clip = fitting_clip(store, checklist={"items": [*FITS["items"], unchecked], "fixes": []})
    status, body = confirm(call, clip["clipId"], {"platforms": ["youtube", "instagram"]})
    assert status == 200, body
    assert {p["platform"] for p in body["posts"]} == {"youtube", "instagram"}


def test_confirm_checks_the_merged_captions_and_the_chosen_places(
    call: Call, store: db.Store, cr_on: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from clipfactory_api import clips
    from clipfactory_api.contentrewards import fit

    ready(store, "youtube", "tiktok", audit="ok", review="live")
    put_campaign(store, platformsPaid=["youtube", "tiktok"])
    put_crconn(store)
    found = fitting_clip(store)
    seen: list[dict[str, Any]] = []
    real = fit.for_clip

    def spy(*args: Any, **kw: Any) -> Any:
        seen.append(kw)
        return real(*args, **kw)

    monkeypatch.setattr(fit, "for_clip", spy)
    patch = {"tiktok": "#Ad the clutch #FaZe @FaZeClan"}
    body = {"platforms": ["tiktok"], "captions": patch, "tiktok": TIKTOK}
    assert confirm(call, found["clipId"], body)[0] == 200
    assert seen == [
        {"captions": clips.merged_captions(found["captions"], patch), "chosen": ["tiktok"], "tiktok": TIKTOK}
    ]


def test_a_clip_without_a_campaign_never_asks_the_fit_and_posts_exactly_as_before(
    call: Call,
    app: Any,
    store: db.Store,
    table: FakeTable,
    secrets_client: Any,
    clock: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from clipfactory_api.contentrewards import fit
    from cr_support import FakeCR, make_deps

    ready(store, "youtube", "instagram")
    before = seed_clip(store, clipId="01J000000000000000000NRM01")
    assert confirm(call, before["clipId"], {"platforms": ["youtube", "instagram"]})[0] == 200
    app.contentrewards = make_deps(app.store, secrets_client, FakeCR(), clock)
    monkeypatch.setattr(fit, "for_clip", lambda *a, **k: pytest.fail("a normal clip never asks the fit"))
    after = seed_clip(store, clipId="01J000000000000000000NRM02")
    assert confirm(call, after["clipId"], {"platforms": ["youtube", "instagram"]})[0] == 200

    def shape(clip_id: str) -> list[dict[str, Any]]:
        rows = [p for p in table.all() if p.get("type") == "post" and p.get("clipId") == clip_id]
        return sorted(
            ({k: v for k, v in p.items() if k not in ("pk", "sk", "postId", "clipId", "gsi1pk")} for p in rows),
            key=lambda p: str(p["platform"]),
        )

    assert shape(after["clipId"]) == shape(before["clipId"])


def test_try_again_and_post_now_run_the_fit(call: Call, store: db.Store, cr_on: Any, lambda_client: FakeLambda) -> None:
    ready(store, "youtube", "instagram")
    put_campaign(store, rules={**RULES, "clipUntil": "2026-11-01"})
    put_crconn(store)
    clip = failed_campaign_clip(store, "instagram", status="posted")
    store.update(PK, db.clip_sk(clip["clipId"]), {"checklist": FITS})
    status, body = confirm(call, clip["clipId"], {"platforms": ["instagram"]})
    assert (status, message(body)) == (
        409,
        "This clip can't earn on FaZe Clips: FaZe Clips stopped taking clips on 1 Nov.",
    )
    assert (store.get(PK, db.post_sk("Pinstagram")) or {})["status"] == "failed"
    # Post now of a waiting campaign post: the same check
    waiting = failed_campaign_clip(store, "youtube", status="confirmed", post_status="pending_integration")
    store.update(PK, db.clip_sk(waiting["clipId"]), {"checklist": FITS})
    status, body = confirm(call, waiting["clipId"], {"platforms": ["youtube"]})
    assert status == 409
    # once the campaign takes clips again, Try again goes
    put_campaign(store)
    assert confirm(call, clip["clipId"], {"platforms": ["instagram"]})[0] == 200
    assert (store.get(PK, db.post_sk("Pinstagram")) or {})["status"] == "queued"


def test_missing_required_tags_join_every_caption_and_youtube_gets_them_first() -> None:
    from clipfactory_api.platforms.campaign_caption import campaign_caption, campaign_options

    rules = {"requiredHashtags": ["#gta6", "#Clipup"], "disclosure": {"caption": "#Ad"}}
    options = campaign_options(rules)
    tiktok = campaign_caption("tiktok", "#gta6 #xqc #gaming #gtavi #npc", options)
    assert "#Clipup" in tiktok
    assert tiktok.count("#gta6") == 1
    assert tiktok.startswith("#Ad")
    insta = campaign_caption("instagram", "#gaming #gta6 #xqc #gtavi #twitchclips", options)
    assert "#Clipup" in insta
    assert insta.count("#gta6") == 1
    yt = campaign_caption("youtube", "A funny moment\n\n#shorts #gaming", options)
    assert yt.split()[:3] == ["#Ad", "#gta6", "#Clipup"]
    assert yt.endswith("#shorts #gaming")
    again = campaign_caption("youtube", yt, options)
    assert again == yt  # nothing doubles
