"""Stops, the next step and its one vermilion button, and ``uploadPlaces`` (docs/CONTRACTS.md §38.4, §38.8)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import campaigns, gates, rules
from conftest import NOW
from cr_support import UUID

CONNECTED = {"status": "connected", "canSubmit": True}
NOT_CONNECTED: dict[str, Any] = {"status": "not_connected"}
REFUSED = {"status": "not_connected", "lastResult": "not_allowed"}


def setup(platform: str, *, ready: bool = True, audit: str | None = None) -> dict[str, Any]:
    gates_list = [{"key": "posting_audit", "state": audit}] if audit else []
    return {"platform": platform, "ready": ready, "gates": gates_list}


SETUPS = [setup("youtube"), setup("instagram"), setup("x", ready=False), setup("tiktok", audit="unknown")]


def campaign(**fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "campaignId": UUID,
        "url": f"https://contentrewards.com/c/campaigns/{UUID}",
        "name": "FaZe Clips",
        "brand": "FaZe",
        "access": "open",
        "campaignType": "cpm",
        "state": "active",
        "membership": "in",
        "pay": [{"platform": "youtube", "per1kCents": 200}, {"platform": "instagram", "per1kCents": 200}],
        "budget": {"totalCents": 1000, "spentCents": 100, "leftCents": 900, "usedPct": 10.0},
        "platformsPaid": ["youtube", "instagram"],
        "rulesState": "ready",
        "rules": {**rules.empty(), "requiredHashtags": ["#FaZe"]},
        "logo": {"needed": False, "state": "none"},
        "anyway": [],
    }
    base.update(fields)
    return base


def codes(item: dict[str, Any], conn: dict[str, Any] = CONNECTED, places: list[str] | None = None) -> list[str]:
    found = places if places is not None else gates.upload_places(item.get("platformsPaid") or [], SETUPS, {})
    return [s["code"] for s in gates.stops(item, conn, found, NOW)]


def step(item: dict[str, Any], conn: dict[str, Any] = CONNECTED, places: list[str] | None = None) -> dict[str, Any]:
    found = places if places is not None else gates.upload_places(item.get("platformsPaid") or [], SETUPS, {})
    return gates.next_step(item, conn, gates.stops(item, conn, found, NOW), NOW)


# --- uploadPlaces ---------------------------------------------------------------------------------------------------


def test_upload_places_cases() -> None:
    assert gates.upload_places(["youtube", "instagram", "x"], SETUPS, {}) == ["youtube", "instagram"]
    assert gates.upload_places(["tiktok", "youtube"], SETUPS, {}) == ["youtube"]  # TikTok before its audit
    after = [*SETUPS[:3], setup("tiktok", audit="ok")]
    assert gates.upload_places(["tiktok", "youtube"], after, {}) == ["youtube", "tiktok"]  # STATS_ORDER
    assert gates.upload_places(["youtube", "instagram"], SETUPS, {"youtube": False}) == ["instagram"]
    assert gates.upload_places(["youtube", "instagram"], SETUPS, {}) == ["youtube", "instagram"]  # relinked: unknown
    assert gates.upload_places(["youtube"], [], {}) == []  # nothing set up
    assert gates.upload_places(["tiktok"], SETUPS, {}) == []  # TikTok only


# --- stops ----------------------------------------------------------------------------------------------------------


def test_a_clean_campaign_has_no_stops() -> None:
    assert codes(campaign()) == []
    assert step(campaign())["kind"] == "make_clips"


@pytest.mark.parametrize(
    ("fields", "code", "hard"),
    [
        ({"membership": "unknown"}, "not_checked", True),
        ({"membership": "not_joined"}, "not_joined", True),
        ({"membership": "apply_first"}, "apply_first", True),
        ({"membership": "waiting"}, "waiting", True),
        ({"membership": "left"}, "left", True),
        ({"membership": "not_accepted"}, "not_accepted", True),
        ({"rulesState": "reading"}, "rules_reading", True),
        ({"rulesState": "failed"}, "rules_failed", True),
        ({"state": "paused"}, "paused", True),
        ({"state": "ended"}, "ended", True),
        ({"rules": {**rules.empty(), "clipUntil": "2026-11-01"}}, "deadline", True),
        ({"budget": {"usedPct": 96.0, "leftCents": 10}}, "budget_gone", True),
        ({"budget": {"usedPct": 60.0, "leftCents": 388000}}, "budget_half", False),
        ({"pay": [{"platform": "youtube", "per1kCents": 50}]}, "low_rate", False),
        (
            {
                "logo": {"needed": True, "state": "none"},
                "rules": {**rules.empty(), "logo": {"required": True, "rules": None}},
            },
            "logo_missing",
            True,
        ),
        ({"platformsPaid": ["tiktok"]}, "tiktok_only", True),
        ({"platformsPaid": ["x"]}, "no_place", True),
        ({"held": {"at": iso(NOW), "pending": 3}}, "held", True),
        ({"capReached": True}, "cap_reached", True),
        ({"rules": {**rules.empty(), "draftsFirst": True}}, "drafts_first", True),
        ({"rules": {**rules.empty(), "soundRequired": True}}, "sound_needed", True),
        ({"rules": {**rules.empty(), "faceOnCamera": True}}, "face_needed", False),
        (
            {
                "rules": {
                    **rules.empty(),
                    "disclosure": {"caption": "#Ad", "onScreen": "Paid partnership", "spoken": True},
                }
            },
            "spoken_needed",
            False,
        ),
        ({"rules": {**rules.empty(), "audience": "40% US viewers"}}, "audience", False),
    ],
)
def test_every_stop(fields: dict[str, Any], code: str, hard: bool) -> None:
    item = campaign(**fields)
    found = {
        s["code"]: s
        for s in gates.stops(item, CONNECTED, gates.upload_places(item.get("platformsPaid") or [], SETUPS, {}), NOW)
    }
    assert code in found
    assert found[code]["hard"] is hard
    assert found[code]["text"]


def test_stop_words() -> None:
    texts = {
        s["code"]: s["text"]
        for s in gates.stops(
            campaign(
                budget={"usedPct": 60.0, "leftCents": 388000},
                pay=[{"platform": "youtube", "per1kCents": 50}],
                rules={**rules.empty(), "clipUntil": "2026-11-01"},
            ),
            CONNECTED,
            ["youtube"],
            NOW,
        )
    }
    assert texts["budget_half"] == "Half the money is used. $3,880 is left. Post soon, before it runs out."
    assert texts["low_rate"].startswith("It pays only $0.50 per 1,000 views.")
    assert texts["deadline"] == "This campaign stopped taking clips on 1 Nov. Pick another one."
    no_place = gates.stops(campaign(platformsPaid=["youtube", "instagram"]), CONNECTED, [], NOW)
    found = next(s for s in no_place if s["code"] == "no_place")
    assert found["text"] == "Set up YouTube first. This campaign pays for YouTube and Instagram."
    assert found["fixHref"] == "/settings/posting/setup/youtube"


def test_manual_and_not_connected_is_a_note_only() -> None:
    item = campaign(membership="manual")
    stop = next(s for s in gates.stops(item, NOT_CONNECTED, ["youtube"], NOW) if s["code"] == "not_connected")
    assert stop["hard"] is False
    assert "anyway" not in stop
    assert step(item, NOT_CONNECTED, ["youtube"])["kind"] == "make_clips"  # never asks for "Make clips anyway"


# --- the next step: one vermilion button per row -------------------------------------------------------------------


def _button(found: dict[str, Any]) -> str | None:
    button = found.get("button")
    return button["label"] if button else None


@pytest.mark.parametrize(
    ("fields", "conn", "kind", "chip", "button"),
    [
        ({"membership": "unknown"}, NOT_CONNECTED, "connect", "Connect first", "Connect Content Rewards"),
        ({"membership": "unknown"}, REFUSED, "check_yourself", "Check it yourself", "Open campaign"),
        ({"membership": "not_joined"}, CONNECTED, "join", "Not joined yet", "Open campaign"),
        ({"membership": "apply_first", "access": "application"}, CONNECTED, "applied", "Applied?", "Yes, I applied"),
        ({"membership": "waiting", "access": "application"}, CONNECTED, "wait", "Waiting for the brand", None),
        ({"membership": "in"}, CONNECTED, "make_clips", "You're in", "Make clips for this campaign"),
        ({"membership": "in", "state": "paused"}, CONNECTED, "stop", "Paused", None),
        ({"membership": "left"}, CONNECTED, "join", "Not in your list", "Open campaign"),
        ({"membership": "not_accepted"}, CONNECTED, "pick_another", "Not accepted", "Find another campaign"),
        ({"membership": "manual"}, CONNECTED, "make_clips", "You're in", "Make clips for this campaign"),
    ],
)
def test_membership_rows(
    fields: dict[str, Any], conn: dict[str, Any], kind: str, chip: str, button: str | None
) -> None:
    found = step(campaign(**fields), conn)
    assert (found["kind"], found["chip"], _button(found)) == (kind, chip, button)


def test_row_details() -> None:
    connect = step(campaign(membership="unknown"), NOT_CONNECTED)
    assert connect["button"]["href"] == "/settings/posting/setup/contentrewards"
    assert connect["asks"][0]["said"] == "joined_by_hand"
    applied = step(campaign(membership="apply_first", access="application"))
    assert applied["button"]["action"] == "said_applied"
    assert [a["said"] for a in applied["asks"]] == ["not_eligible", "joined_by_hand"]
    joined = step(campaign(membership="not_joined", canSayInBy=iso(NOW + timedelta(minutes=1))))
    assert joined["asks"] == []
    joined = step(campaign(membership="not_joined", canSayInBy=iso(NOW - timedelta(minutes=1))))
    assert joined["asks"] == [{"label": "I joined, but it still says not joined", "said": "joined_by_hand"}]
    celebrate = step(campaign(celebrate="in"))
    assert celebrate["text"] == "You're in! Make clips for this campaign."
    assert celebrate["button"]["href"] == f"/?campaign={UUID}"
    manual = step(campaign(membership="manual"))
    assert manual["text"] == "You're in. After each post, I'll remind you to send it to Content Rewards yourself."


def test_the_priority_order() -> None:
    # a hard stop beats membership
    assert step(campaign(membership="not_joined", state="ended"))["kind"] == "pick_another"
    # rules to paste beat the logo
    paste = step(
        campaign(
            membership="manual",
            rulesState="waiting_for_join",
            rules=None,
            logo={"needed": True, "state": "none"},
            public={"configuration": {"rules": {"branding": {"logoRequired": True}}}},
        )
    )
    assert paste["kind"] == "rules_paste"
    assert _button(paste) == "Open campaign"
    # the logo beats soft stops
    logo = step(campaign(rules={**rules.empty(), "logo": {"required": True, "rules": None}, "faceOnCamera": True}))
    assert logo["kind"] == "logo"
    assert logo["button"]["action"] == "logo_picker"
    # soft stops not accepted → one "Make clips anyway"
    soft = step(campaign(rules={**rules.empty(), "faceOnCamera": True}, budget={"usedPct": 60.0, "leftCents": 5}))
    assert soft["kind"] == "anyway"
    assert _button(soft) == "Make clips anyway"
    accepted = step(campaign(rules={**rules.empty(), "faceOnCamera": True}, anyway=["face_needed"]))
    assert accepted["kind"] == "make_clips"
    # footage only → pick a video
    pick = step(
        campaign(
            rules={
                **rules.empty(),
                "allowedSources": {**rules.empty()["allowedSources"], "campaignProvidedOnly": True},
            },
            sourceVideos=[{"url": "https://www.youtube.com/watch?v=abc"}],
        )
    )
    assert pick["kind"] == "pick_video"
    assert "button" not in pick


def test_every_step_has_at_most_one_vermilion() -> None:
    for membership in ("unknown", "not_joined", "apply_first", "waiting", "in", "left", "not_accepted", "manual"):
        for conn in (CONNECTED, NOT_CONNECTED, REFUSED):
            found = step(campaign(membership=membership, access="application"), conn)
            assert isinstance(found.get("button"), dict | type(None))
            assert all(g["label"] != _button(found) for g in found.get("glass") or [])


def test_settle_membership_transitions() -> None:
    listed = [
        {
            "id": "cmp_101th1qfm09pwbamme6armgr2e",
            "name": "x",
            "status": "active",
            "access": "open",
            "type": "cpm",
            "platforms": [],
            "description": "Brief",
        }
    ]
    item = campaign(membership="not_joined", waitingSince=iso(NOW - timedelta(days=1)), celebrate=None)
    campaigns.settle_membership(item, CONNECTED, listed, True, NOW)
    assert item["membership"] == "in"
    assert item["celebrate"] == "in"
    assert item["brief"] == "Brief"
    assert item["nextCheckAt"] == iso(NOW + timedelta(hours=6))
    campaigns.settle_membership(item, CONNECTED, [], True, NOW)
    assert item["membership"] == "left"
    item = campaign(membership="in", lastListedAt=iso(NOW))
    campaigns.settle_membership(item, CONNECTED, [], False, NOW)
    assert item["membership"] == "in"  # a capped list makes nothing "left"
    manual = campaign(membership="manual", said="joined_by_hand", lastListedAt=None)
    campaigns.settle_membership(manual, CONNECTED, listed, True, NOW)
    assert manual["membership"] == "in"
    assert manual.get("autoSince")
    assert not manual.get("celebrate")
    waiting = campaign(membership="unknown", access="application", lastListedAt=None)
    campaigns.settle_membership(waiting, CONNECTED, [], True, NOW)
    assert waiting["membership"] == "apply_first"
    assert waiting["nextCheckAt"] == iso(NOW + timedelta(minutes=15))
    waiting["said"] = "applied"
    campaigns.settle_membership(waiting, CONNECTED, [], True, NOW + timedelta(days=8))
    assert waiting["membership"] == "waiting"
    assert waiting["nextCheckAt"] == iso(NOW + timedelta(days=8, hours=6))
    campaigns.settle_membership(waiting, CONNECTED, [], True, NOW + timedelta(days=31))
    assert "nextCheckAt" not in waiting  # stops after 30 days: "Still waiting? Tap Check now."
