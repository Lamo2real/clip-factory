"""Each of the creative director's chat tools on its own: Lamo Stories items only, writes fenced on the answer,
buttons for everything that needs the owner's tap (docs/CONTRACTS.md §45.27, ADR-78)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent.chat import tools
from lamostories_agent.tasks.common import Superseded
from lamostories_agent.tasks.fence import MSG_LIVE, Fence
from test_tasks_support import PK, USER, WS, FakeModel, character_item, good_character, idea_item, services

MSG_SK = "MSG#C1#M2"


@pytest.fixture
def box(tmp_path: Path) -> Any:
    svc, db, s3 = services(tmp_path, FakeModel())
    db.seed({"pk": PK, "sk": MSG_SK, "userId": USER, "workspaceId": WS, "status": "streaming", "sessionId": "s1"})
    fence = Fence(svc.store, PK, MSG_SK, "s1", live=MSG_LIVE)
    tb = tools.Toolbox(svc, USER, WS, PK, fence, catalog=svc.catalog)
    tb.db, tb.s3 = db, s3  # type: ignore[attr-defined]
    return tb


def call(tb: Any, name: str, **args: Any) -> dict[str, Any]:
    result, ok = tb.run(name, args)
    assert ok, result
    return result


def error(tb: Any, name: str, **args: Any) -> str:
    result, ok = tb.run(name, args)
    assert not ok, result
    return str(result["error"])


def test_the_tool_list_is_lamo_stories_only_and_stable() -> None:
    names = [s["toolSpec"]["name"] for s in tools.specs()]
    assert names == [s["toolSpec"]["name"] for s in tools.specs()]
    assert set(names) == tools.TOOL_NAMES
    assert {
        "list_ideas",
        "read_idea",
        "list_characters",
        "read_character",
        "list_stories",
        "read_story",
        "list_references",
        "read_reference",
        "create_idea",
        "update_idea",
        "propose_character",
        "propose_story_change",
        "remember",
    } <= set(names)
    for spec in tools.specs():
        schema = spec["toolSpec"]["inputSchema"]["json"]
        assert schema["type"] == "object" and schema["additionalProperties"] is False


def test_reads_see_only_this_workspace(box: Any) -> None:
    box.db.seed(idea_item("I1"))
    box.db.seed({**idea_item("I2"), "userId": "other"})
    box.db.seed({**idea_item("I3"), "pk": "USER#u-1", "sk": "IDEA#I3"})  # Lamo Clips' partition is never read
    assert [i["ideaId"] for i in call(box, "list_ideas")["ideas"]] == ["I1"]
    assert call(box, "read_idea", ideaId="I1")["idea"]["title"] == "The great sandwich chase"
    assert "no idea" in error(box, "read_idea", ideaId="I2")
    box.db.seed(character_item("C1", "Bo", look={"body": "round"}))
    assert call(box, "list_characters")["characters"][0]["name"] == "Bo"
    assert call(box, "read_character", characterId="C1")["character"]["look"] == {"body": "round"}


def test_read_story_gives_the_storyboard_without_looks(box: Any) -> None:
    key = f"ws/{USER}/{WS}/stories/S1/script/v1.json"
    script = {
        "durationSec": 30,
        "cast": {"c1": {"name": "Bo", "look": {"body": "round"}}},
        "scenes": [{"sceneId": "s1", "title": "Pie", "beats": [{"who": "c1", "do": "run"}], "caption": None}],
        "captions": [],
    }
    box.s3.objects[key] = json.dumps(script).encode()
    box.db.seed(
        {
            "pk": PK,
            "sk": "STORY#S1",
            "userId": USER,
            "workspaceId": WS,
            "storyId": "S1",
            "title": "Pie",
            "status": "review",
            "scriptKey": key,
            "videoKey": "x",
        }
    )
    out = call(box, "read_story", storyId="S1")
    assert out["story"]["title"] == "Pie" and "scriptKey" not in out["story"] and "videoKey" not in out["story"]
    assert out["storyboard"]["cast"] == {"c1": "Bo"} and out["storyboard"]["scenes"][0]["sceneId"] == "s1"
    assert "look" not in json.dumps(out["storyboard"])
    assert call(box, "list_stories", status="review")["stories"][0]["scenes"] == 0


def test_read_reference_gives_its_analysis(box: Any) -> None:
    key = f"ws/{USER}/{WS}/references/R1/analysis.json"
    box.s3.objects[key] = json.dumps({"summary": "A cat falls."}).encode()
    box.db.seed(
        {
            "pk": PK,
            "sk": "REFVID#R1",
            "userId": USER,
            "workspaceId": WS,
            "refId": "R1",
            "title": "Cat",
            "status": "analyzed",
            "analysisKey": key,
        }
    )
    box.db.seed(
        {
            "pk": PK,
            "sk": "REFVID#R2",
            "userId": USER,
            "workspaceId": WS,
            "refId": "R2",
            "title": "Dog",
            "status": "ready",
        }
    )
    assert call(box, "read_reference", refId="R1")["analysis"] == {"summary": "A cat falls."}
    assert "Analyze" in call(box, "read_reference", refId="R2")["note"]
    assert {r["refId"] for r in call(box, "list_references")["references"]} == {"R1", "R2"}


def test_create_idea_writes_it_and_a_safety_idea_becomes_a_save_button(box: Any) -> None:
    box.db.seed(character_item("C1", "Bo"))
    out = call(
        box, "create_idea", title="Bo's pie", logline="A pie rolls away.", category="comedy", characterIds=["C1"]
    )
    saved = box.db.get(PK, f"IDEA#{out['idea']['ideaId']}")
    assert (
        saved["type"] == "ws_idea"
        and saved["source"] == "ai"
        and saved["status"] == "saved"
        and saved["characterIds"] == ["C1"]
    )
    assert saved["safetyTopicId"] is None and saved["needsGuidance"] is False
    out = call(
        box, "create_idea", title="Pip on black ice", logline="Pip's car skids on black ice.", category="driving_safety"
    )
    assert out["saved"] is False
    assert box.actions[-1]["kind"] == "save_idea" and box.actions[-1]["payload"]["idea"]["category"] == "driving_safety"
    assert len(box.db.prefixed(PK, "IDEA#")) == 1


def test_create_idea_checks_its_fields_and_concept(box: Any) -> None:
    assert "title needs" in error(box, "create_idea", title="", logline="x", category="comedy")
    assert "category must" in error(box, "create_idea", title="x", logline="y", category="horror")
    assert "not saved characters" in error(
        box, "create_idea", title="x", logline="y", category="comedy", characterIds=["ghost"]
    )
    assert "concept is not complete" in error(
        box,
        "create_idea",
        title="x",
        logline="y",
        category="comedy",
        concept={
            "premise": "p",
            "beats": ["a"],
            "lesson": "",
            "ending": "e",
            "tone": "funny",
            "durationSec": 30,
            "onScreenText": [],
        },
    )


def test_update_idea_writes_and_a_safety_idea_gets_a_button(box: Any) -> None:
    box.db.seed(idea_item("I1"))
    call(box, "update_idea", ideaId="I1", title="The great pie chase")
    assert box.db.get(PK, "IDEA#I1")["title"] == "The great pie chase"
    box.db.seed(idea_item("I2", category="driving_safety", safetyTopicId="skid-recovery"))
    call(box, "update_idea", ideaId="I2", logline="Pip skids and stays calm.")
    assert box.db.get(PK, "IDEA#I2")["logline"] != "Pip skids and stays calm."
    assert box.actions[-1] == {
        "kind": "save_idea",
        "label": "Save this idea",
        "payload": {"ideaId": "I2", "patch": {"logline": "Pip skids and stays calm."}},
    }


def test_writes_are_refused_once_the_answer_is_stopped(box: Any) -> None:
    box.db.seed({**box.db.get(PK, MSG_SK), "status": "stopped"})
    with pytest.raises(Superseded):
        box.run("remember", {"text": "never saved"})
    assert box.db.prefixed(PK, "MEM#") == []
    with pytest.raises(Superseded):
        box.run("create_idea", {"title": "x", "logline": "y", "category": "comedy"})
    assert box.db.prefixed(PK, "IDEA#") == []


def test_remember_saves_once(box: Any) -> None:
    call(box, "remember", text="Lamo likes slapstick endings")
    assert call(box, "remember", text="lamo likes slapstick endings")["note"] == "Already remembered."
    assert len(box.db.prefixed(PK, "MEM#")) == 1 and box.db.prefixed(PK, "MEM#")[0]["source"] == "chat"
    assert "300" in error(box, "remember", text="x" * 301)


def test_propose_character_offers_a_save_button_for_a_valid_rig(box: Any) -> None:
    box.db.seed(character_item("C1", "Bo"))
    out = call(box, "propose_character", character=good_character())
    assert out["button"] == "Save Pip"
    action = box.actions[-1]
    assert action["kind"] == "save_character" and action["payload"]["character"]["look"]["accessory"] == "scarf"
    assert "needs fixing" in error(
        box, "propose_character", character={**good_character(), "movementStyle": "moonwalk"}
    )
    assert "already used" in error(box, "propose_character", character=good_character("Bo"))
    assert box.db.prefixed(PK, "CHAR#") == [box.db.get(PK, "CHAR#C1")]  # nothing saved without the tap


def test_propose_story_change_checks_the_scenes(box: Any) -> None:
    box.db.seed(
        {
            "pk": PK,
            "sk": "STORY#S1",
            "userId": USER,
            "workspaceId": WS,
            "storyId": "S1",
            "status": "review",
            "scenes": [{"sceneId": "s1"}, {"sceneId": "s2"}],
        }
    )
    call(box, "propose_story_change", storyId="S1", sceneIds=["s2"])
    assert box.actions[-1] == {
        "kind": "remake_scene",
        "label": "Remake this scene",
        "payload": {"storyId": "S1", "sceneIds": ["s2"]},
    }
    call(box, "propose_story_change", storyId="S1", note="Make the ending funnier")
    assert (
        box.actions[-1]["label"] == "Make these changes"
        and box.actions[-1]["payload"]["note"] == "Make the ending funnier"
    )
    assert "not in that story" in error(box, "propose_story_change", storyId="S1", sceneIds=["s9"])
    assert "a note, scene ids" in error(box, "propose_story_change", storyId="S1")
    box.db.seed(
        {
            "pk": PK,
            "sk": "STORY#S2",
            "userId": USER,
            "workspaceId": WS,
            "storyId": "S2",
            "status": "producing",
            "scenes": [],
        }
    )
    assert "still being made" in error(box, "propose_story_change", storyId="S2", note="x")


def test_propose_story_change_offers_only_what_the_changes_route_takes(box: Any) -> None:
    for status in ("approved", "published", "rejected", "draft", "needs_check", "failed"):
        box.db.seed(
            {"pk": PK, "sk": f"STORY#{status}", "userId": USER, "workspaceId": WS, "storyId": status,
             "status": status, "scenes": [{"sceneId": "s1"}]}
        )  # fmt: skip
    for status in ("approved", "published", "rejected"):
        assert "can't be remade" in error(box, "propose_story_change", storyId=status, note="x")
    for status in ("draft", "needs_check", "failed"):
        call(box, "propose_story_change", storyId=status, note="x")
    assert [a["payload"]["storyId"] for a in box.actions] == ["draft", "needs_check", "failed"]
    assert tools.REMAKE_STATUSES == ("draft", "review", "needs_check", "failed")


def test_update_idea_into_or_out_of_driving_safety_is_the_owners_tap(box: Any) -> None:
    box.db.seed(idea_item("I1"))
    call(box, "update_idea", ideaId="I1", category="driving_safety")
    assert box.db.get(PK, "IDEA#I1")["category"] == "comedy"  # not written: the API matches the topic on save
    assert box.actions[-1]["payload"] == {"ideaId": "I1", "patch": {"category": "driving_safety"}}
    box.db.seed(idea_item("I2", category="driving_safety", safetyTopicId="skid-recovery"))
    call(box, "update_idea", ideaId="I2", category="comedy")
    assert box.db.get(PK, "IDEA#I2")["category"] == "driving_safety"
    assert box.actions[-1]["payload"] == {"ideaId": "I2", "patch": {"category": "comedy"}}
    call(box, "update_idea", ideaId="I1", category="explainer")  # an ordinary change is written
    assert box.db.get(PK, "IDEA#I1")["category"] == "explainer"


def test_an_idea_deleted_meanwhile_is_a_mistake_the_model_hears_about(box: Any) -> None:
    box.db.seed(idea_item("I1"))
    real_get = box.svc.store.get

    def deleted_after_read(pk: str, sk: str) -> Any:
        found = real_get(pk, sk)
        if sk == "IDEA#I1":
            box.db.items.pop((PK, "IDEA#I1"), None)  # the owner deletes it right after the tool read it
        return found

    box.svc.store.get = deleted_after_read
    assert "deleted meanwhile" in error(box, "update_idea", ideaId="I1", title="New title")
    assert box.db.get(PK, "IDEA#I1") is None and not box.fence.lost.is_set()
    call(box, "remember", text="the answer goes on")  # the answer's fence still holds


def test_offer_make_video_from_an_idea_or_a_brief(box: Any) -> None:
    box.db.seed(character_item("C1", "Bo"))
    box.db.seed(idea_item("I1"))
    box.db.seed(idea_item("I2", category="driving_safety", needsGuidance=True))
    call(box, "offer_make_video", ideaId="I1", characterIds=["C1"])
    assert box.actions[-1]["payload"] == {"story": {"characterIds": ["C1"], "ideaId": "I1"}}
    call(
        box,
        "offer_make_video",
        title="Bo bakes",
        logline="Bo bakes a cake that grows.",
        category="comedy",
        characterIds=["C1"],
        durationSec=200,
    )
    assert box.actions[-1]["payload"]["story"] == {
        "characterIds": ["C1"],
        "brief": {"title": "Bo bakes", "logline": "Bo bakes a cake that grows.", "category": "comedy"},
        "durationSec": 90,
    }
    assert "1 to 3" in error(box, "offer_make_video", ideaId="I1", characterIds=[])
    assert "no checked advice" in error(box, "offer_make_video", ideaId="I2", characterIds=["C1"])
    assert "checked advice" in error(
        box,
        "offer_make_video",
        title="Flying",
        logline="How to fly a car.",
        category="driving_safety",
        characterIds=["C1"],
    )
    assert box.db.prefixed(PK, "STORY#") == []


def test_offer_analyze_reference_and_open(box: Any) -> None:
    box.db.seed({"pk": PK, "sk": "REFVID#R1", "userId": USER, "workspaceId": WS, "refId": "R1", "status": "ready"})
    box.db.seed({"pk": PK, "sk": "REFVID#R2", "userId": USER, "workspaceId": WS, "refId": "R2", "status": "uploading"})
    call(box, "offer_analyze_reference", refId="R1")
    assert box.actions[-1] == {"kind": "analyze_reference", "label": "Analyze this video", "payload": {"refId": "R1"}}
    assert "still uploading" in error(box, "offer_analyze_reference", refId="R2")
    call(box, "offer_open", page="settings_ai")
    assert box.actions[-1]["payload"] == {"href": "/stories/settings/ai"}
    call(box, "offer_open", page="story", id="S1")
    assert box.actions[-1]["payload"] == {"href": "/stories/production/S1"}
    assert "needs the item's id" in error(box, "offer_open", page="story", id="../x")
    assert "not a Lamo Stories page" in error(box, "offer_open", page="clips")


def test_buttons_are_not_repeated_and_capped(box: Any) -> None:
    call(box, "offer_open", page="ideas")
    assert call(box, "offer_open", page="ideas")["note"] == "That button is already in your answer."
    for page in ("dashboard", "characters", "production", "references", "library"):
        call(box, "offer_open", page=page)
    assert "at most 6 buttons" in error(box, "offer_open", page="connections")
    assert len(box.actions) == tools.MAX_ACTIONS


def test_an_unknown_tool_is_an_error_result(box: Any) -> None:
    assert "no tool named" in error(box, "publish_now")
    assert "no tool named" in error(box, "_get")


def ref_item(ref_id: str, status: str = "analyzed", **extra: Any) -> dict[str, Any]:
    key = f"ws/{USER}/{WS}/references/{ref_id}/analysis.json"
    return {"pk": PK, "sk": f"REFVID#{ref_id}", "userId": USER, "workspaceId": WS, "refId": ref_id, "status": status,
            **({"analysisKey": key} if status == "analyzed" else {}), **extra}  # fmt: skip


def test_offer_make_video_carries_up_to_three_analyzed_references(box: Any) -> None:
    """§45.34: Make the video from the chat can take the references the owner and the director talked about."""
    box.db.seed(character_item("C1", "Bo"))
    box.db.seed(idea_item("I1"))
    for ref_id in ("R1", "R2", "R3", "R4"):
        box.db.seed(ref_item(ref_id))
    box.db.seed(ref_item("R5", status="ready"))
    box.db.seed({**ref_item("R6"), "workspaceId": "someone-else"})
    call(box, "offer_make_video", ideaId="I1", characterIds=["C1"], referenceIds=["R1", "R2", "R1"])
    assert box.actions[-1]["payload"] == {
        "story": {"characterIds": ["C1"], "referenceIds": ["R1", "R2"], "ideaId": "I1"}
    }
    assert "up to 3" in error(box, "offer_make_video", ideaId="I1", characterIds=["C1"],
                              referenceIds=["R1", "R2", "R3", "R4"])  # fmt: skip
    assert "not been analyzed" in error(box, "offer_make_video", ideaId="I1", characterIds=["C1"], referenceIds=["R5"])
    assert "not reference videos here" in error(
        box, "offer_make_video", ideaId="I1", characterIds=["C1"], referenceIds=["R6"]
    )
    spec = next(s for s in tools.specs() if s["toolSpec"]["name"] == "offer_make_video")
    assert spec["toolSpec"]["inputSchema"]["json"]["properties"]["referenceIds"]["maxItems"] == 3


def test_the_chat_brief_says_make_the_video_can_carry_references() -> None:
    from lamostories_agent.chat import turn

    assert "referenceIds" in turn.CHAT_BRIEF and "offer_make_video" in turn.CHAT_BRIEF


def test_the_chat_keeps_at_most_the_api_s_fifty_notes(box: Any) -> None:
    """§45.34: one limit for the chat and the owner, the API's 50, with the API's sentence."""
    from lamostories_agent import memory

    assert memory.CHAT_LIMIT == 50 and memory.FULL == "Memory is full (50 notes). Delete one first."
    for n in range(50):
        box.db.seed({"pk": PK, "sk": f"MEM#{n:04d}", "userId": USER, "workspaceId": WS, "memId": f"{n:04d}",
                     "text": f"fact {n}", "createdAt": f"2026-11-21T10:00:{n:02d}.000Z"})  # fmt: skip
    assert error(box, "remember", text="one more") == "Memory is full (50 notes). Delete one first."
