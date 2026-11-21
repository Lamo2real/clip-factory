"""The shared golden cases of §39 (docs/CONTRACTS.md §39.3, §39.2, §39.5).

* ``fixtures/cr_fit_cases.json``: stored items (a clip, its job, the campaign, ``CRCONN``, the setups, posts,
  submissions, the campaigns that own the moment elsewhere) and the ``CampaignFit`` the server answers for them: each
  rule and state, every verdict (``wait`` too), ``canUpload``, ``canRemake`` and ``softCodes``.
* ``fixtures/cr_fit_live_cases.json``: a server ``CampaignFit`` and the card's captions, Upload to chips and TikTok
  choices, and what ``fit.live`` makes of them: the four live items (``tags``, ``ad``, ``paid_switch``, ``places``),
  the verdict, the headline and ``canUpload``. The web's ``lib/crFit.ts`` (H) is checked against it.
* ``fixtures/channel_match_cases.json``: a campaign's channels, yt-dlp's facts about a video (``info``), the
  ``channelKeys`` the agent stores for it (``sources.channel_keys(info)``, I) and whether the fit says it matches
  (``true``, ``false``, or ``null``: nothing to compare). The agent's tests read it when present.
* ``fixtures/money_everywhere_cases.json``: one owner's stored money items and ``GET /v1/money/everywhere``, with
  the Get paid "Sent to your bank" lines and block (§40.4: ``payouts``, ``payconns``, ``paystates``, ``whopOn``).

Run ``uv run python tests/cr_fit_cases.py`` (from ``api/``) to write the files again after a deliberate change: the
expected answers come from the code, and every case is read by hand in review (the key ones also have their own
hand-written asserts in ``test_cr_fit.py`` and ``test_money_everywhere.py``).
"""

from __future__ import annotations

import copy
import json
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from clipfactory_api.clock import parse
from clipfactory_api.contentrewards import connection, fit, gates, rules

FIXTURES = Path(__file__).parent / "fixtures"
FIT_FILE = FIXTURES / "cr_fit_cases.json"
LIVE_FILE = FIXTURES / "cr_fit_live_cases.json"
CHANNEL_FILE = FIXTURES / "channel_match_cases.json"
MONEY_FILE = FIXTURES / "money_everywhere_cases.json"

NOW = "2026-11-15T12:00:00.000Z"
UUID = "200ea21b-be80-4db8-b552-8e32b148604e"
OTHER = "a1cefc3b-4533-438f-8e70-a7299550f1cf"
CLIP = "01J00000000000000000000CLP"
JOB = "01J00000000000000000000JOB"
LINK = "https://www.youtube.com/watch?v=faze123"
GOOD = {
    "youtubeTitle": "He did WHAT",
    "youtubeDescription": "#Ad The clutch of the year #FaZe @FaZeClan",
    "instagram": "#Ad The clutch of the year #FaZe @FaZeClan",
    "facebook": "#Ad The clutch of the year #FaZe @FaZeClan",
    "tiktok": "#Ad The clutch of the year #FaZe @FaZeClan",
    "x": "#Ad The clutch of the year #FaZe @FaZeClan",
}
PLAIN = {
    "youtubeTitle": "He did WHAT",
    "youtubeDescription": "The clutch of the year",
    "instagram": "The clutch of the year #gaming",
    "facebook": "The clutch of the year",
    "tiktok": "The clutch of the year",
    "x": "The clutch of the year",
}
TIKTOK_ON = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": True,
    "brandOrganic": False,
}
TIKTOK_OFF = {**TIKTOK_ON, "brandContent": False}


def setup(platform: str, *, ready: bool = True, audit: str | None = None) -> dict[str, Any]:
    gates_list = [{"key": "posting_audit", "state": audit}] if audit else []
    return {"platform": platform, "ready": ready, "gates": gates_list}


SETUPS = [setup("youtube"), setup("instagram"), setup("tiktok", audit="ok"), setup("x"), setup("facebook")]


def base_rules(**fields: Any) -> dict[str, Any]:
    return {
        **rules.empty(),
        "requiredHashtags": ["#FaZe"],
        "requiredTags": ["@FaZeClan"],
        "lengthMinSec": 15,
        "lengthMaxSec": 60,
        **fields,
    }


def allowed(**fields: Any) -> dict[str, Any]:
    return {**rules.empty()["allowedSources"], **fields}


def base_campaign(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "campaignId": UUID,
        "url": f"https://contentrewards.com/c/campaigns/{UUID}",
        "name": "FaZe Clips",
        "brand": "FaZe",
        "access": "open",
        "campaignType": "cpm",
        "state": "active",
        "membership": "in",
        "inSince": "2026-11-10T09:00:00.000Z",
        "idMatch": "typeid",
        "pay": [{"platform": "youtube", "per1kCents": 200}, {"platform": "instagram", "per1kCents": 200}],
        "budget": {"totalCents": 850000, "spentCents": 60992, "leftCents": 789008, "usedPct": 7.2},
        "platformsPaid": ["youtube", "instagram"],
        "rulesState": "ready",
        "rules": base_rules(),
        "uncertain": [],
        "logo": {"needed": False, "state": "none"},
        "anyway": [],
    }
    out.update(fields)
    return out


def base_conn(**fields: Any) -> dict[str, Any]:
    return {
        "status": "connected",
        "canSubmit": True,
        "crLinked": {},
        "stepsDone": ["connect", "ready-account", "ready-socials"],
        "signInBy": "2027-02-01T00:00:00.000Z",
        **fields,
    }


def checklist(**passes: bool) -> dict[str, Any]:
    items = [{"key": "length", "label": "Clip is 15–60 seconds (campaign rule)", "pass": True}]
    labels = {
        "logo": "Campaign logo on screen the whole clip",
        "disclosure": "'Paid partnership' shows at the start",
        "campaign_rules": "Follows the campaign's rules (no banned content)",
    }
    for key, ok in passes.items():
        items.append({"key": key, "label": labels.get(key, key), "pass": ok})
    return {"items": items, "fixes": []}


def campaign_clip(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "clipId": CLIP,
        "jobId": JOB,
        "status": "review",
        "campaignId": UUID,
        "durationSec": 42.4,
        "captions": dict(GOOD),
        "checklist": checklist(disclosure=True),
    }
    out.update(fields)
    return out


def normal_clip(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "clipId": CLIP,
        "jobId": JOB,
        "status": "review",
        "durationSec": 42.4,
        "captions": dict(PLAIN),
        "checklist": checklist(),
    }
    out.update(fields)
    return out


def source(**fields: Any) -> dict[str, Any]:
    return {
        "type": "link",
        "platform": "youtube",
        "url": LINK,
        "channel": "FaZe Clan",
        "channelId": "UCfazeclan",
        **fields,
    }


def campaign_job(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "jobId": JOB,
        "status": "ready",
        "campaignId": UUID,
        "campaign": {"campaignId": UUID, "name": "FaZe Clips", "brand": "FaZe", "rules": base_rules()},
        "source": source(),
        "sourceLanguage": "en-US",
        "createdAt": "2026-11-15T10:00:00.000Z",
    }
    out.update(fields)
    return out


def judged_by(rules_then: dict[str, Any], **fields: Any) -> dict[str, Any]:
    """A campaign job whose own rules copy (what the agent made and judged the clip by) is ``rules_then``."""
    snapshot = {"campaignId": UUID, "name": "FaZe Clips", "brand": "FaZe", "rules": rules_then}
    return campaign_job(campaign=snapshot, **fields)


# The agent's ``campaign_rules`` row when Claude's review never came back (``checklist.judged_items``, §38.13).
UNCHECKED_ROW = {
    "key": "campaign_rules",
    "label": "Follows the campaign's rules (no banned content)",
    "pass": False,
    "note": "Claude couldn't check the campaign's rules. Check it yourself.",
}


def normal_job(**fields: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "jobId": JOB,
        "status": "ready",
        "source": source(),
        "sourceLanguage": "en-US",
        "createdAt": "2026-11-15T10:00:00.000Z",
    }
    out.update(fields)
    return out


def post(platform: str, status: str = "posted", **fields: Any) -> dict[str, Any]:
    return {
        "postId": f"01J0000000000000000POST{platform[:2].upper()}",
        "clipId": CLIP,
        "platform": platform,
        "status": status,
        **fields,
    }


def case(name: str, **kw: Any) -> dict[str, Any]:
    """One stored situation. Unset parts are a clean campaign clip of FaZe Clips that can earn."""
    return {
        "name": name,
        "now": kw.pop("now", NOW),
        "clip": kw.pop("clip", None) or campaign_clip(),
        "job": kw.pop("job", None) or campaign_job(),
        "campaign": kw.pop("campaign", None) or base_campaign(),
        "conn": kw.pop("conn", None) or base_conn(),
        "setups": kw.pop("setups", SETUPS),
        "posts": kw.pop("posts", []),
        "crsubs": kw.pop("crsubs", []),
        "others": kw.pop("others", []),
        "sourceKept": kw.pop("source_kept", True),
        "remakeOn": kw.pop("remake_on", True),
        "captions": kw.pop("captions", None),
        "chosen": kw.pop("chosen", None),
        "tiktok": kw.pop("tiktok", None),
        **({"expect": kw.pop("expect")} if "expect" in kw else {}),
    }


def run(c: dict[str, Any]) -> dict[str, Any]:
    """The server's answer for a case: A's stops and places from the stored items, then ``fit.fit``."""
    now = parse(c["now"])
    assert now is not None
    item, conn = c["campaign"], c["conn"]
    paid = [str(p) for p in item.get("platformsPaid") or []]
    places = gates.upload_places(paid, c["setups"], connection.crlinked(conn))
    return fit.fit(
        copy.deepcopy(c["clip"]),
        copy.deepcopy(c["job"]),
        copy.deepcopy(item),
        stops=gates.stops(item, conn, places, now),
        places=places,
        conn=conn,
        posts=c["posts"],
        crsubs=c["crsubs"],
        others=c["others"],
        source_kept=c["sourceKept"],
        remake_on=c["remakeOn"],
        now=now,
        captions=c["captions"],
        chosen=c["chosen"],
        tiktok=c["tiktok"],
        tiktok_waits=gates.tiktok_waits(paid, c["setups"]),
    )


def _fit_cases() -> list[dict[str, Any]]:
    cam = base_campaign
    rl = base_rules
    return [
        case("a clean campaign clip fits"),
        case("tiktok branded content on", campaign=cam(platformsPaid=["youtube", "tiktok"]), tiktok=TIKTOK_ON),
        case(
            "tiktok branded content off is almost ready",
            campaign=cam(platformsPaid=["youtube", "tiktok"]),
            chosen=["youtube", "tiktok"],
            tiktok=TIKTOK_OFF,
        ),
        case(
            "a missing tag still fits", clip=campaign_clip(captions={**GOOD, "instagram": "#Ad The clutch @FaZeClan"})
        ),
        case(
            "#Ad not at the start still fits",
            clip=campaign_clip(captions={**GOOD, "instagram": "The clutch of the year #FaZe @FaZeClan #Ad"}),
        ),
        case(
            "content rewards hasn't let clip factory look",
            campaign=cam(membership="unknown"),
            conn={"status": "not_connected", "lastResult": "not_allowed"},
        ),
        case(
            "the brand's own disclosure and a phrase",
            campaign=cam(
                rules=rl(
                    disclosure={"caption": "#Sponsored", "onScreen": "Sponsored", "spoken": False},
                    requiredCaptionText="Use code FAZE",
                )
            ),
            job=campaign_job(
                campaign={
                    "campaignId": UUID,
                    "name": "FaZe Clips",
                    "rules": rl(
                        disclosure={"caption": "#Sponsored", "onScreen": "Sponsored", "spoken": False},
                        requiredCaptionText="Use code FAZE",
                    ),
                }
            ),
        ),
        case("too long", clip=campaign_clip(durationSec=72.2)),
        case("too short", clip=campaign_clip(durationSec=12.6)),
        case(
            "an exact length: a cut clip a little over still fits",
            campaign=cam(rules=rl(lengthMinSec=30, lengthMaxSec=30)),
            clip=campaign_clip(durationSec=30.6),
        ),
        case(
            "an exact length: two seconds over is too long",
            campaign=cam(rules=rl(lengthMinSec=30, lengthMaxSec=30)),
            clip=campaign_clip(durationSec=32.2),
        ),
        case("only a minimum", campaign=cam(rules=rl(lengthMaxSec=None))),
        case("only a maximum", campaign=cam(rules=rl(lengthMinSec=None))),
        case("no length rule is not listed", campaign=cam(rules=rl(lengthMinSec=None, lengthMaxSec=None))),
        case("the deadline is later", campaign=cam(rules=rl(clipUntil="2026-11-23"))),
        case("today is the last day", campaign=cam(rules=rl(clipUntil="2026-11-15"))),
        case("the deadline passed", campaign=cam(rules=rl(clipUntil="2026-11-14"))),
        case("held is a wait", campaign=cam(held={"at": NOW, "pending": 3})),
        case("paused is a wait", campaign=cam(state="paused")),
        case("waiting for the brand is a wait", campaign=cam(membership="waiting", access="application")),
        case("reading the rules is a wait", campaign=cam(rulesState="reading")),
        case("connected but not checked yet is a wait", campaign=cam(membership="unknown")),
        case("not connected: connect first", campaign=cam(membership="unknown"), conn={"status": "not_connected"}),
        case("not joined", campaign=cam(membership="not_joined")),
        case("left", campaign=cam(membership="left")),
        case("apply first", campaign=cam(membership="apply_first", access="application")),
        case("the rules failed", campaign=cam(rulesState="failed")),
        case("ended", campaign=cam(state="ended")),
        case("the money is gone", campaign=cam(budget={"usedPct": 96.0, "leftCents": 10})),
        case("the brand wants its own picture on top", campaign=cam(rules=rl(overlayRequired=True))),
        case("drafts first", campaign=cam(rules=rl(draftsFirst=True))),
        case("not accepted", campaign=cam(membership="not_accepted")),
        case(
            "soft stops: notes and checks, and the ones not accepted",
            campaign=cam(
                budget={"usedPct": 60.0, "leftCents": 388000},
                rules=rl(faceOnCamera=True, audience="40% US viewers"),
                anyway=["face_needed"],
            ),
        ),
        case("a low rate is a note", campaign=cam(pay=[{"platform": "youtube", "per1kCents": 50}])),
        case(
            "in by hand and not connected: send it yourself",
            campaign=cam(membership="manual"),
            conn={"status": "not_connected", "stepsDone": ["ready-account", "ready-socials"]},
        ),
        case(
            "the brand wants it said out loud: one check, not two",
            campaign=cam(rules=rl(disclosure={"caption": "#Ad", "onScreen": "Paid partnership", "spoken": True})),
        ),
        case("no place set up yet", setups=[setup("youtube", ready=False), setup("instagram", ready=False)]),
        case("where it pays isn't known yet", campaign=cam(platformsPaid=[])),
        case("tiktok only", campaign=cam(platformsPaid=["tiktok"])),
        case("a paid place not set up is a note", setups=[setup("youtube"), setup("instagram", ready=False)]),
        case(
            "tiktok before its audit is a note",
            campaign=cam(platformsPaid=["youtube", "tiktok"]),
            setups=[setup("youtube"), setup("tiktok", audit="waiting")],
        ),
        case("a place turned off on the card", chosen=["youtube"]),
        case("accounts added: not checked", conn=base_conn(stepsDone=["connect", "ready-account"])),
        case("content rewards doesn't know instagram", conn=base_conn(crLinked={"youtube": True, "instagram": False})),
        case(
            "content rewards doesn't know the only place",
            campaign=cam(platformsPaid=["youtube"]),
            conn=base_conn(crLinked={"youtube": False}),
        ),
        case(
            "the logo is on the clip, even after the campaign's logo was deleted",
            campaign=cam(logo={"needed": True, "state": "none"}, rules=rl(logo={"required": True, "rules": None})),
            clip=campaign_clip(checklist=checklist(logo=True, disclosure=True)),
            job=judged_by(rl(logo={"required": True, "rules": None})),
        ),
        case(
            "the logo row passed only because the job didn't ask for one",
            campaign=cam(logo={"needed": True, "state": "ready"}, rules=rl(logo={"required": True, "rules": None})),
            clip=campaign_clip(
                checklist={
                    "items": [
                        {"key": "logo", "label": "x", "pass": True, "note": "This campaign does not ask for a logo."},
                        {"key": "disclosure", "label": "x", "pass": True},
                    ],
                    "fixes": [],
                }
            ),
        ),
        case(
            "the logo is missing and a ready logo can be put on a copy",
            campaign=cam(logo={"needed": True, "state": "ready"}, rules=rl(logo={"required": True, "rules": None})),
            clip=campaign_clip(checklist=checklist(logo=False, disclosure=True)),
        ),
        case(
            "the logo is missing and the campaign has none yet",
            campaign=cam(logo={"needed": True, "state": "none"}, rules=rl(logo={"required": True, "rules": None})),
            clip=campaign_clip(checklist=checklist(disclosure=True)),
        ),
        case("paid partnership isn't on the video", clip=campaign_clip(checklist=checklist(disclosure=False))),
        case(
            "a campaign video",
            campaign=cam(rules=rl(sourceVideos=[{"url": LINK, "kind": "youtube", "note": None}])),
        ),
        case(
            "only its own videos: another link",
            campaign=cam(
                rules=rl(
                    allowedSources=allowed(campaignProvidedOnly=True),
                    sourceVideos=[{"url": "https://www.youtube.com/watch?v=other", "kind": "youtube", "note": None}],
                )
            ),
        ),
        case(
            "only its own videos: a video file",
            campaign=cam(rules=rl(allowedSources=allowed(campaignProvidedOnly=True))),
            job=campaign_job(source={"type": "upload", "platform": "upload", "key": "uploads/u/x.mp4"}),
        ),
        case(
            "a ruled-out site",
            campaign=cam(rules=rl(allowedSources=allowed(youtube=True, twitch=True))),
            job=campaign_job(source=source(platform="kick", url="https://kick.com/faze/videos/1")),
        ),
        case(
            "the channel matches by its stored keys",
            campaign=cam(rules=rl(allowedSources=allowed(channels=[{"name": "FaZe Clan", "url": None}]))),
            job=campaign_job(source=source(channel="Some Name", channelKeys=["fazeclan", "ucfazeclan"])),
        ),
        case(
            "the channel doesn't match: look yourself",
            campaign=cam(rules=rl(allowedSources=allowed(channels=[{"name": "FaZe Clan", "url": None}]))),
            job=campaign_job(source=source(channel="Valorant Daily", channelId="UCvalo")),
        ),
        case(
            "a video file: where it is from is unknown",
            campaign=cam(rules=rl(allowedSources=allowed(channels=[{"name": "FaZe Clan", "url": None}]))),
            job=campaign_job(source={"type": "upload", "platform": "upload", "key": "uploads/u/x.mp4"}),
        ),
        case(
            "a Mac-fetched video keeps its link and site",
            campaign=cam(rules=rl(allowedSources=allowed(channels=[{"name": "FaZe Clan", "url": None}]))),
            job=campaign_job(
                source={
                    "type": "upload",
                    "platform": "upload",
                    "key": f"uploads/u/mac-{JOB}/video.mp4",
                    "fetchedBy": "mac",
                    "linkPlatform": "youtube",
                    "url": LINK,
                    "channel": "FaZe Clan",
                }
            ),
        ),
        case(
            "source notes can't be checked",
            campaign=cam(rules=rl(allowedSources=allowed(notes="Only clips of the Flank Invitational."))),
        ),
        case(
            "an allowed site",
            campaign=cam(rules=rl(allowedSources=allowed(youtube=True))),
        ),
        case(
            "the language matches one of two",
            campaign=cam(rules=rl(language="English or Spanish")),
            job=campaign_job(sourceLanguage="es-ES"),
        ),
        case("EN only", campaign=cam(rules=rl(language="EN only"))),
        case(
            "the wrong language", campaign=cam(rules=rl(language="English")), job=campaign_job(sourceLanguage="es-ES")
        ),
        case("no stored language", campaign=cam(rules=rl(language="English")), job=campaign_job(sourceLanguage=None)),
        case("a rule that names no known language", campaign=cam(rules=rl(language="Tagalog"))),
        case("“de” in Spanish words is not German", campaign=cam(rules=rl(language="Español de España"))),
        case("“it” is not Italian", campaign=cam(rules=rl(language="Any, as long as it is clear"))),
        case("“keep it clean” names no language", campaign=cam(rules=rl(language="Any, keep it clean"))),
        case(
            "banned content checked and fine",
            campaign=cam(rules=rl(bannedContent=["swearing", "No gambling"])),
            clip=campaign_clip(checklist=checklist(disclosure=True, campaign_rules=True)),
            job=judged_by(rl(bannedContent=["swearing", "No gambling"])),
        ),
        case(
            "banned content added after the clip was judged",
            campaign=cam(rules=rl(bannedContent=["swearing", "gambling"])),
            clip=campaign_clip(checklist=checklist(disclosure=True, campaign_rules=True)),
            job=judged_by(rl(bannedContent=["Swearing"])),
        ),
        case(
            "the review never came back: look yourself, never a no",
            campaign=cam(rules=rl(bannedContent=["gambling"], otherRules=["Show the scoreboard."])),
            clip=campaign_clip(
                checklist={
                    "items": [{"key": "disclosure", "label": "x", "pass": True}, UNCHECKED_ROW],
                    "fixes": [],
                }
            ),
            job=judged_by(rl(bannedContent=["gambling"], otherRules=["Show the scoreboard."])),
        ),
        case(
            "the review never came back and nothing is banned",
            clip=campaign_clip(
                checklist={
                    "items": [{"key": "disclosure", "label": "x", "pass": True}, UNCHECKED_ROW],
                    "fixes": [],
                }
            ),
        ),
        case(
            "banned content found",
            campaign=cam(rules=rl(bannedContent=["gambling"])),
            clip=campaign_clip(
                checklist={
                    "items": [
                        {"key": "disclosure", "label": "x", "pass": True},
                        {"key": "campaign_rules", "label": "x", "pass": False, "note": "Shows gambling at 0:12."},
                    ],
                    "fixes": [],
                }
            ),
        ),
        case(
            "banned content never judged",
            campaign=cam(rules=rl(bannedContent=["swearing", "gambling"])),
        ),
        case(
            "two things to check yourself",
            campaign=cam(rules=rl(uncertain=["Clips must feel organic"], faceOnCamera=True)),
        ),
        case("one thing to check yourself", campaign=cam(rules=rl(uncertain=["Use the official broadcast."]))),
        case(
            "uncertain lines from the item when the rules have none, and at most five",
            campaign=cam(rules=rl(), uncertain=[f"Rule {n}" for n in range(1, 8)]),
        ),
        case(
            "the brand's cover picture and layout",
            campaign=cam(rules=rl(coverImageRequired=True, layoutNotes="Facecam on the left.")),
        ),
        case(
            "a campaign clip's other rules were judged",
            campaign=cam(rules=rl(otherRules=["Show the scoreboard."])),
            clip=campaign_clip(checklist=checklist(disclosure=True, campaign_rules=True)),
            job=judged_by(rl(otherRules=["Show the scoreboard."])),
        ),
        case(
            "an other rule added after the clip was judged",
            campaign=cam(rules=rl(otherRules=["Show the scoreboard.", "Keep the music."])),
            clip=campaign_clip(checklist=checklist(disclosure=True, campaign_rules=True)),
            job=judged_by(rl(otherRules=["Show the scoreboard."])),
        ),
        case(
            "a campaign clip known from its posts only",
            clip={k: v for k, v in campaign_clip().items() if k != "campaignId"},
            job={k: v for k, v in campaign_job().items() if k not in ("campaignId", "campaign")},
            posts=[post("youtube", "failed", campaignId=UUID)],
        ),
        case(
            "a campaign clip for another campaign",
            posts=[post("youtube", "queued", campaignId=OTHER)],
            others=[{"campaignId": OTHER, "name": "Valorant Clips"}],
        ),
        case("send by hand when the ids are ambiguous", campaign=cam(idMatch="ambiguous")),
        case("read only: send by hand", conn=base_conn(status="read_only", canSubmit=False)),
        # normal clips
        case("a normal clip that could earn", clip=normal_clip(), job=normal_job()),
        case(
            "a normal clip with other rules and banned content",
            clip=normal_clip(),
            job=normal_job(),
            campaign=cam(rules=rl(otherRules=["Show the scoreboard."], bannedContent=["swearing"])),
        ),
        case(
            "a normal clip already up on YouTube",
            clip=normal_clip(status="posted"),
            job=normal_job(),
            posts=[post("youtube", "posted"), post("instagram", "failed")],
        ),
        case(
            "a normal clip whose moment is on another campaign",
            clip=normal_clip(),
            job=normal_job(),
            others=[{"campaignId": OTHER, "name": "Valorant Clips"}],
        ),
        case("a normal clip while copies are off", clip=normal_clip(), job=normal_job(), remake_on=False),
        case("a normal clip whose video is gone", clip=normal_clip(), job=normal_job(), source_kept=False),
        case(
            "a normal clip too long for the campaign",
            clip=normal_clip(durationSec=95.0),
            job=normal_job(),
        ),
        case(
            "a normal clip with a soft stop not accepted",
            clip=normal_clip(),
            job=normal_job(),
            campaign=cam(budget={"usedPct": 60.0, "leftCents": 388000}),
        ),
        case(
            "a normal clip, the logo missing on the campaign page first",
            clip=normal_clip(),
            job=normal_job(),
            campaign=cam(logo={"needed": True, "state": "none"}, rules=rl(logo={"required": True, "rules": None})),
        ),
        case(
            "a normal clip of a held campaign can't be copied yet",
            clip=normal_clip(),
            job=normal_job(),
            campaign=cam(held={"at": NOW, "pending": 3}),
        ),
        case(
            "a normal clip from a channel that doesn't match can't be suggested",
            clip=normal_clip(),
            job=normal_job(source=source(channel="Valorant Daily", channelId="UCvalo")),
            campaign=cam(rules=rl(allowedSources=allowed(channels=[{"name": "FaZe Clan", "url": None}]))),
        ),
    ]


def _live_cases(fits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Server fits and the card's state as he types and taps."""
    by_name = {c["name"]: c for c in fits}

    def server(name: str) -> dict[str, Any]:
        return copy.deepcopy(by_name[name]["expect"])

    tiktok = server("tiktok branded content on")
    clean = server("a clean campaign clip fits")
    phrase = server("the brand's own disclosure and a phrase")
    turned_off = server("a place turned off on the card")
    checks = server("two things to check yourself")
    wait = server("held is a wait")
    remake = server("paid partnership isn't on the video")
    out = [
        {"name": "nothing changed", "fit": clean, "card": {"captions": GOOD, "chosen": None, "tiktok": None}},
        {
            "name": "he deletes a tag on Instagram",
            "fit": clean,
            "card": {"captions": {**GOOD, "instagram": "#Ad The clutch @FaZeClan"}, "chosen": None, "tiktok": None},
        },
        {
            "name": "he moves #Ad to the end on Instagram and deletes everything on YouTube",
            "fit": clean,
            "card": {
                "captions": {
                    **GOOD,
                    "instagram": "The clutch of the year, unreal #FaZe @FaZeClan #Ad",
                    "youtubeDescription": "",
                },
                "chosen": None,
                "tiktok": None,
            },
        },
        {
            "name": "he turns Instagram off",
            "fit": clean,
            "card": {"captions": GOOD, "chosen": ["youtube"], "tiktok": None},
        },
        {
            "name": "he turns Instagram back on",
            "fit": turned_off,
            "card": {"captions": GOOD, "chosen": ["youtube", "instagram"], "tiktok": None},
        },
        {
            "name": "he turns TikTok's Branded content off",
            "fit": tiktok,
            "card": {"captions": GOOD, "chosen": ["youtube", "tiktok"], "tiktok": TIKTOK_OFF},
        },
        {
            "name": "he turns TikTok's Branded content on",
            "fit": tiktok,
            "card": {"captions": GOOD, "chosen": ["youtube", "tiktok"], "tiktok": TIKTOK_ON},
        },
        {
            "name": "the brand's own disclosure and a phrase: the phrase deleted",
            "fit": phrase,
            "card": {
                "captions": {**GOOD, "tiktok": "#Sponsored the clutch #FaZe @FaZeClan", "instagram": "#Ad the clutch"},
                "chosen": None,
                "tiktok": None,
            },
        },
        {
            "name": "checks stay checks while he types",
            "fit": checks,
            "card": {"captions": {**GOOD, "instagram": "the clutch"}, "chosen": None, "tiktok": None},
        },
        {
            "name": "a wait stays a wait",
            "fit": wait,
            "card": {"captions": GOOD, "chosen": ["instagram"], "tiktok": None},
        },
        {
            "name": "a copy is still needed",
            "fit": remake,
            "card": {"captions": PLAIN, "chosen": None, "tiktok": None},
        },
    ]
    for c in out:
        card = c["card"]
        c["expect"] = fit.live(c["fit"], captions=card["captions"], chosen=card["chosen"], tiktok=card["tiktok"])
    return out


# --- channel matching (shared with the agent, I) ---------------------------------------------------------------


_NOT_WORD = re.compile(r"[\W_]+")


def channel_keys(info: dict[str, Any]) -> list[str]:
    """A copy of the agent's ``sources.channel_keys`` (I owns it): every name and handle yt-dlp gives, as keys."""

    def key(text: str) -> str:
        return _NOT_WORD.sub("", text.casefold())

    texts = [info.get(k) for k in ("channel", "uploader", "creator", "uploader_id", "channel_id")]
    for k in ("channel_url", "uploader_url"):
        url = info.get(k)
        if isinstance(url, str):
            texts.append(fit._handle(url))
    keys = [key(str(t)) for t in texts if isinstance(t, str) and t]
    return [k for k in dict.fromkeys(keys) if len(k) >= fit.MIN_CHANNEL_KEY]


def _channel_cases() -> list[dict[str, Any]]:
    faze = [{"name": "FaZe Clan", "url": "https://www.youtube.com/@FaZeClan"}]
    rows = [
        ("a name that matches", faze, {"channel": "FaZe Clan", "channel_id": "UC1"}),
        (
            "a handle from the channel link",
            faze,
            {"channel": "Clips", "channel_url": "https://www.youtube.com/@FaZeClan"},
        ),
        (
            "a shorter name inside the campaign's",
            [{"name": "FaZe Clan Official", "url": None}],
            {"uploader": "FaZe Clan"},
        ),
        ("punctuation and case don't count", [{"name": "faze_clan", "url": None}], {"channel": "FAZE CLAN!"}),
        (
            "a twitch channel link",
            [{"name": "x", "url": "https://www.twitch.tv/fazeclan"}],
            {"uploader_id": "fazeclan"},
        ),
        (
            "a /channel/ link",
            [{"name": "x", "url": "https://www.youtube.com/channel/UCfaze123"}],
            {"channel_id": "UCfaze123"},
        ),
        ("another channel", faze, {"channel": "Valorant Daily", "channel_id": "UCvalo"}),
        ("too short to compare", [{"name": "FC", "url": None}], {"channel": "FaZe Clan"}),
        ("nothing known about the video", faze, {}),
        ("the campaign names no channel", [], {"channel": "FaZe Clan"}),
    ]
    out = []
    for name, channels, info in rows:
        keys = channel_keys(info)
        out.append(
            {
                "name": name,
                "channels": channels,
                "info": info,
                "channelKeys": keys,
                "matches": fit.channel_matches(channels, keys or None),
            }
        )
    return out


# --- all your money (§39.2) --------------------------------------------------------------------------------------


MONEY_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
YT = {"platform": "youtube", "status": "connected", "scopes": [MONEY_SCOPE]}
FB = {"platform": "facebook", "status": "connected"}


def days(platform: str, end: str, amounts: list[int | None], currency: str = "USD") -> list[dict[str, Any]]:
    """One row a day ending on ``end`` (None: no row that day)."""
    last = date.fromisoformat(end)
    first = last - timedelta(days=len(amounts) - 1)
    return [
        {"platform": platform, "date": (first + timedelta(days=i)).isoformat(), "amountMicros": a, "currency": currency}
        for i, a in enumerate(amounts)
        if a is not None
    ]


def crmoney(**fields: Any) -> dict[str, Any]:
    return {
        "firstReadDone": True,
        "paidByDayDone": True,
        "paidTotalCents": 6240,
        "stillEarningCents": 420,
        "readyToMoveCents": 1825,
        "onItsWayCents": 0,
        "asOf": "2026-11-19T14:10:00.000Z",
        "lastPaidAt": "2026-11-12T09:00:00.000Z",
        "paidByDay": {"2026-11-12": 500, "2026-11-01": 300, "2026-10-01": 999},
        **fields,
    }


def money_case(name: str, **kw: Any) -> dict[str, Any]:
    out = {
        "name": name,
        "today": kw.pop("today", "2026-11-19T15:00:00.000Z"),
        "facebookVerified": kw.pop("facebook_verified", False),
        "accounts": kw.pop("accounts", {"youtube": YT}),
        "states": kw.pop("states", {"youtube": {"state": "earning", "lastCheckedAt": "2026-11-19T06:00:00.000Z"}}),
        "rows": kw.pop("rows", days("youtube", "2026-11-16", [400_000] * 31)),
        "crOn": kw.pop("cr_on", True),
        "crconn": kw.pop("crconn", {"status": "connected", "signInBy": "2027-02-01T00:00:00.000Z"}),
        "crmoney": kw.pop("crmoney", crmoney()),
    }
    # §40.4 (Get paid): what Google and Whop say they sent toward his bank. Only the cases that store some.
    for key in ("payouts", "payconns", "paystates", "whopOn"):
        if key in kw:
            out[key] = kw.pop(key)
    return out


# --- §40.4: the stored Get paid items (the shapes of §40.7) --------------------------------------------------------

ADSENSE_ON = {
    "type": "payconn",
    "source": "adsense",
    "status": "connected",
    "connectedAt": "2026-10-01T09:00:00.000Z",
    "accounts": [{"name": "accounts/pub-1234567890123456", "displayName": "Main"}],
}
WHOP_ON = {
    "type": "payconn",
    "source": "whop",
    "status": "connected",
    "connectedAt": "2026-10-01T09:00:00.000Z",
    "accountId": "user_abc123",
    "accountName": "@owner",
    "tokenVersionId": "v3",
}
READ = {"type": "paystate", "firstReadDone": True, "lastCheckedAt": "2026-11-19T06:00:00.000Z"}


def google(day: str, text: str, account: str = "3456", **fields: Any) -> dict[str, Any]:
    return {
        "sk": f"PAYOUT#youtube#{day}#{account}",
        "type": "payout",
        "place": "youtube",
        "by": "google",
        "source": "adsense.payments",
        "account": account,
        "date": day,
        "amountText": text,
        "state": "sent",
        "fetchedAt": "2026-11-19T06:00:00.000Z",
        **fields,
    }


def whop(day: str, payout_id: str, status: str, micros: int, currency: str = "USD", **fields: Any) -> dict[str, Any]:
    states = {"completed": "sent", "processing": "on_its_way", "failed": "didnt_go_through", "reversed": "came_back"}
    return {
        "sk": f"PAYOUT#contentrewards#{day}#{payout_id}",
        "type": "payout",
        "place": "contentrewards",
        "by": "whop",
        "source": "whop.payouts",
        "payoutId": payout_id,
        "status": status,
        "state": states.get(status, "on_its_way"),
        "date": day,
        "amountMicros": micros,
        "currency": currency,
        "traceCode": "UETR-secret-trace",
        "fetchedAt": "2026-11-19T06:00:00.000Z",
        **fields,
    }


def _sent_cases() -> list[dict[str, Any]]:
    both = {"adsense": ADSENSE_ON, "whop": WHOP_ON}
    read = {"youtube": READ, "contentrewards": {**READ, "kyc": "approved"}}
    return [
        money_case(
            "sent to your bank: Google in kronor and Whop in dollars, never added together",
            payouts={
                "youtube": [google("2026-10-23", "kr 1 234,56 SEK"), google("2026-09-22", "SEK 1,233.44")],
                "contentrewards": [
                    whop("2026-11-10", "po_1", "completed", 40_000_000, estimatedArrival="2026-11-14"),
                    whop("2026-11-17", "po_2", "processing", 12_000_000),
                    whop("2026-10-02", "po_0", "reversed", 9_000_000),
                ],
            },
            payconns=both,
            paystates=read,
            whopOn=True,
        ),
        money_case(
            "sent to your bank: Google and Whop in dollars make one line",
            payouts={
                "youtube": [google("2026-10-23", "USD 170.00")],
                "contentrewards": [whop("2026-11-10", "po_1", "completed", 40_000_000)],
            },
            payconns=both,
            paystates=read,
            whopOn=True,
        ),
        money_case(
            "sent to your bank: Google's money type can't be read, so nothing is added up",
            payouts={"youtube": [google("2026-10-23", "$1,234.57"), google("2026-09-22", "1 234,56 kr")]},
            payconns={"adsense": ADSENSE_ON},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: one of Google's payments can't be read",
            payouts={"youtube": [google("2026-10-23", "kr 1 234,56 SEK"), google("2026-09-22", "$1,234.57")]},
            payconns={"adsense": ADSENSE_ON},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: two AdSense accounts paid on the same day stay two payments",
            payouts={
                "youtube": [google("2026-10-23", "€87.65", "1111"), google("2026-10-23", "€12.35", "2222")],
            },
            payconns={"adsense": ADSENSE_ON},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: a payment Google no longer lists stops counting",
            payouts={
                "youtube": [
                    google("2026-10-23", "kr 1 234,56 SEK"),
                    google("2026-09-22", "kr 999,00 SEK", state="gone", goneAt="2026-11-01T06:00:00.000Z"),
                ],
            },
            payconns={"adsense": ADSENSE_ON},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: payment reading on, nothing sent yet",
            payouts={"youtube": []},
            payconns={"adsense": ADSENSE_ON},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: payment reading just allowed, checking",
            payconns={"adsense": {**ADSENSE_ON, "connectedAt": "2026-11-19T09:00:00.000Z"}},
            paystates={},
        ),
        money_case(
            "sent to your bank: the first read is late",
            payconns={"adsense": {**ADSENSE_ON, "connectedAt": "2026-11-17T09:00:00.000Z"}},
            paystates={},
        ),
        money_case(
            "sent to your bank: payment reading allowed again after Stop, the old read doesn't count",
            payconns={"adsense": {**ADSENSE_ON, "connectedAt": "2026-11-19T14:00:00.000Z"}},
            paystates={"youtube": {**READ, "lastCheckedAt": "2026-11-16T06:00:00.000Z"}},
        ),
        money_case(
            "sent to your bank: reads failing for 10 days never say nothing sent yet",
            payconns={"adsense": ADSENSE_ON, "whop": WHOP_ON},
            paystates={
                "youtube": {**READ, "lastCheckedAt": "2026-11-09T06:00:00.000Z", "lastError": "Google said 500"},
                "contentrewards": {**READ, "lastCheckedAt": "2026-11-09T06:00:00.000Z", "lastError": "Whop said 500"},
            },
            whopOn=True,
        ),
        money_case(
            "sent to your bank: payment reading needs a reconnect",
            payconns={"adsense": {**ADSENSE_ON, "status": "needs_reconnect", "reason": "token_dead"}},
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: payment reading stopped, Google's payments stay",
            payouts={"youtube": [google("2026-10-23", "kr 1 234,56 SEK")]},
            payconns={
                "adsense": {"type": "payconn", "status": "not_connected", "stoppedAt": "2026-11-03T10:00:00.000Z"}
            },
            paystates={"youtube": READ},
        ),
        money_case(
            "sent to your bank: Connect Whop is on but not connected",
            payconns={"whop": {"type": "payconn", "source": "whop", "status": "keys_saved", "keyHint": "app_Ab…wxyz"}},
            whopOn=True,
        ),
        money_case(
            "sent to your bank: Whop needs a reconnect",
            payconns={"whop": {**WHOP_ON, "status": "needs_reconnect", "reason": "token_dead"}},
            paystates={"contentrewards": READ},
            whopOn=True,
        ),
        money_case(
            "sent to your bank: Connect Whop switched off says not available",
            payconns={"whop": WHOP_ON},
            paystates={"contentrewards": READ},
            whopOn=False,
        ),
    ]


def money_run(c: dict[str, Any]) -> dict[str, Any]:
    from clipfactory_api.money import everywhere

    today = parse(c["today"])
    assert today is not None
    return everywhere.everywhere(
        monetization(c["facebookVerified"]),
        {p: c["accounts"].get(p) for p in ("youtube", "tiktok", "instagram", "facebook", "x")},
        c["states"],
        c["rows"],
        c["crconn"],
        c["crmoney"],
        c["crOn"],
        today,
        payouts=c.get("payouts"),
        payconns=c.get("payconns"),
        paystates=c.get("paystates"),
        whop_on=bool(c.get("whopOn")),
    )


def monetization(facebook_verified: bool) -> Any:
    from dataclasses import replace

    from clipfactory_api.money import rules as money_rules

    cfg = money_rules.load()
    if facebook_verified == cfg.platform("facebook").money_verified:
        return cfg
    platforms = dict(cfg.platforms)
    platforms["facebook"] = replace(platforms["facebook"], money_verified=facebook_verified)
    return replace(cfg, platforms=platforms)


def _money_cases() -> list[dict[str, Any]]:
    out = [
        money_case("YouTube and Content Rewards give one USD total"),
        money_case("Content Rewards switched off: no row", cr_on=False),
        money_case(
            "nothing stored: the last 30 days, nothing to add up",
            rows=[],
            states={},
            crconn={"status": "not_connected"},
            crmoney={},
        ),
        money_case("YouTube not set up", accounts={}, rows=[], states={}),
        money_case("YouTube needs your OK", accounts={"youtube": {**YT, "scopes": []}}, rows=[], states={}),
        money_case(
            "YouTube not in the Partner Program yet",
            rows=[],
            states={"youtube": {"state": "not_yet", "lastCheckedAt": "2026-11-19T06:00:00.000Z"}},
        ),
        money_case(
            "YouTube in the program, nothing reported yet", rows=[], states={"youtube": {"state": "in_program"}}
        ),
        money_case(
            "YouTube couldn't be checked and nothing is stored",
            rows=[],
            states={"youtube": {"state": "earning", "lastError": "Couldn't check YouTube."}},
        ),
        money_case(
            "YouTube couldn't be checked today, money stored",
            states={"youtube": {"state": "earning", "lastError": "Couldn't check YouTube."}},
            rows=days("youtube", "2026-11-14", [100_000] * 10),
        ),
        money_case(
            "a reported $0 day is a number",
            rows=days("youtube", "2026-11-16", [0, 0, 0]),
        ),
        money_case(
            "Facebook verified, behind while YouTube is up to date",
            facebook_verified=True,
            accounts={"youtube": YT, "facebook": FB},
            states={"youtube": {"state": "earning"}, "facebook": {"state": "earning"}},
            rows=days("youtube", "2026-11-16", [400_000] * 30) + days("facebook", "2026-10-27", [50_000] * 5),
        ),
        money_case(
            "two currencies are never added together",
            facebook_verified=True,
            accounts={"youtube": YT, "facebook": FB},
            states={"youtube": {"state": "earning"}, "facebook": {"state": "earning"}},
            rows=days("youtube", "2026-11-16", [400_000] * 30) + days("facebook", "2026-11-16", [900_000] * 30, "EUR"),
        ),
        money_case("Content Rewards not set up", crconn={"status": "not_connected"}, crmoney={}),
        money_case("Content Rewards: sign in again", crconn={"status": "needs_reconnect"}),
        money_case(
            "Content Rewards past its 90 days: sign in again",
            crconn={"status": "connected", "signInBy": "2026-11-18T00:00:00.000Z"},
        ),
        money_case("Content Rewards didn't answer", crmoney={"error": "cr_down"}),
        money_case(
            "Content Rewards: the first read is still going",
            crmoney={"firstReadDone": False, "readyToMoveCents": 1825, "asOf": "2026-11-19T14:10:00.000Z"},
        ),
        money_case(
            "Content Rewards: no campaign money yet",
            crmoney=crmoney(paidTotalCents=0, stillEarningCents=0, readyToMoveCents=0, onItsWayCents=0, paidByDay={}),
        ),
        money_case("Content Rewards: paid by day not read yet", crmoney=crmoney(paidByDayDone=None)),
        money_case(
            "Content Rewards couldn't be checked today",
            crmoney=crmoney(error="cr_down"),
        ),
        money_case(
            "only Content Rewards: the last 30 days",
            accounts={},
            rows=[],
            states={},
        ),
        *_sent_cases(),
    ]
    for c in out:
        c["expect"] = money_run(c)
    return out


def build() -> dict[str, list[dict[str, Any]]]:
    fits = _fit_cases()
    for c in fits:
        c["expect"] = run(c)
    return {
        "fit": fits,
        "live": _live_cases(fits),
        "channel": _channel_cases(),
        "money": _money_cases(),
    }


def _line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _fit_json(value: Any, pad: str) -> str:
    """A ``CampaignFit`` with one line per field and per item."""
    if not isinstance(value, dict):
        return _line(value)
    parts = []
    for k, v in value.items():
        if k == "items" and isinstance(v, list) and v:
            items = ",\n".join(f"{pad}   {_line(i)}" for i in v)
            parts.append(f'{pad}  "items": [\n{items}\n{pad}  ]')
        else:
            parts.append(f"{pad}  {_line(k)}: {_line(v)}")
    return "{\n" + ",\n".join(parts) + "\n" + pad + " }"


def dump(cases: list[dict[str, Any]], fits: tuple[str, ...] = ()) -> str:
    """One line per part of a case (and per item of a ``CampaignFit``), so a change reads as a small diff."""
    out = []
    for c in cases:
        parts = [f"  {_line(k)}: {_fit_json(v, '  ') if k in fits else _line(v)}" for k, v in c.items()]
        out.append(" {\n" + ",\n".join(parts) + "\n }")
    return "[\n" + ",\n".join(out) + "\n]\n"


def write() -> None:
    found = build()
    FIT_FILE.write_text(dump(found["fit"], ("expect",)))
    LIVE_FILE.write_text(dump(found["live"], ("fit", "expect")))
    CHANNEL_FILE.write_text(dump(found["channel"]))
    MONEY_FILE.write_text(dump(found["money"]))


if __name__ == "__main__":
    write()
