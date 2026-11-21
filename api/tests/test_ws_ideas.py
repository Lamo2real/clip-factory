"""Ideas: the owner's own, AI ideas, Expand and Variations, with the skills block first (CONTRACTS §45.7, ADR-74)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ideas
from conftest import Call
from fakes import FakeS3, client_error
from ws_support import BASE, FakeModel, install, seed_character, seed_idea, use_model


@pytest.fixture(autouse=True)
def wired(app: App, s3_client: FakeS3) -> None:
    install(app, None, s3_client)


def test_manual_ideas_are_saved_listed_patched_and_deleted(call: Call, store: db.Store) -> None:
    status, body = call(
        "POST", f"{BASE}/ideas", {"title": "Toast trouble", "logline": "Lamo burns toast.", "category": "comedy"}
    )
    assert status == 201
    idea = body["idea"]
    assert idea["status"] == "saved"
    assert idea["source"] == "manual"
    assert idea["safetyTopicId"] is None
    assert idea["needsGuidance"] is False
    assert idea["storyIds"] == []
    status, body = call("PATCH", f"{BASE}/ideas/{idea['ideaId']}", {"logline": "Lamo burns toast twice."})
    assert status == 200
    assert body["idea"]["logline"] == "Lamo burns toast twice."
    assert [i["ideaId"] for i in call("GET", f"{BASE}/ideas")[1]["ideas"]] == [idea["ideaId"]]
    assert call("GET", f"{BASE}/ideas", query={"status": "used"})[1]["ideas"] == []
    assert call("GET", f"{BASE}/ideas", query={"status": "nope"})[0] == 400
    assert call("DELETE", f"{BASE}/ideas/{idea['ideaId']}")[0] == 204
    assert call("GET", f"{BASE}/ideas")[1]["ideas"] == []
    assert call("DELETE", f"{BASE}/ideas/{idea['ideaId']}")[0] == 404


def test_driving_safety_ideas_get_their_topic_from_the_checked_list(call: Call) -> None:
    covered = call(
        "POST",
        f"{BASE}/ideas",
        {"title": "Black ice", "logline": "Lamo's car starts sliding on black ice.", "category": "driving_safety"},
    )[1]["idea"]
    assert covered["safetyTopicId"] == "skid-recovery"
    assert covered["needsGuidance"] is False
    uncovered = call(
        "POST",
        f"{BASE}/ideas",
        {"title": "Lava road", "logline": "What to do when a volcano erupts near you.", "category": "driving_safety"},
    )[1]["idea"]
    assert uncovered["safetyTopicId"] is None
    assert uncovered["needsGuidance"] is True
    # Changing the words re-runs the match (once, here in the API).
    patched = call("PATCH", f"{BASE}/ideas/{uncovered['ideaId']}", {"logline": "A tyre blowout on the motorway."})[1]
    assert patched["idea"]["safetyTopicId"] == "tyre-blowout"
    assert patched["idea"]["needsGuidance"] is False
    back = call("PATCH", f"{BASE}/ideas/{uncovered['ideaId']}", {"category": "comedy"})[1]["idea"]
    assert back["safetyTopicId"] is None
    assert back["needsGuidance"] is False


@pytest.mark.parametrize(
    "body",
    [
        {"title": "", "logline": "x", "category": "comedy"},
        {"title": "x" * 81, "logline": "x", "category": "comedy"},
        {"title": "x", "logline": "x" * 281, "category": "comedy"},
        {"title": "x", "logline": "x", "category": "horror"},
        {"title": "x", "logline": "x", "category": "comedy", "safetyTopicId": "skid-recovery"},
        {"title": "x", "logline": "x", "category": "comedy", "characterIds": ["01J0000000000000000000000Z"]},
        {"title": "x", "logline": "x", "category": "comedy", "characterIds": ["a", "b", "c", "d"]},
        {"title": "x", "logline": "x", "category": "comedy", "concept": {"premise": "p", "beats": ["a"]}},
    ],
)
def test_bad_ideas_are_refused(call: Call, body: dict[str, Any]) -> None:
    assert call("POST", f"{BASE}/ideas", body)[0] == 400


def _drafts(*ideas_: dict[str, Any]) -> str:
    return json.dumps({"ideas": list(ideas_)})


def _draft(
    title: str, logline: str, category: str = "comedy", topic: str = "", characters: list[str] | None = None
) -> dict[str, Any]:
    return {"title": title, "logline": logline, "category": category, "topicId": topic, "characters": characters or []}


def test_ai_ideas_send_the_skills_block_first_then_the_house_brief(call: Call, app: App, store: db.Store) -> None:
    hero = seed_character(store, name="Lamo", personality="Brave but clumsy")
    model = use_model(app, FakeModel(_drafts(_draft("Oops, the toast", "Lamo fights a toaster.", characters=["lamo"]))))
    status, body = call("POST", f"{BASE}/ideas/generate", {"topic": "kitchen", "count": 2})
    assert status == 200
    assert body["drafts"] == [
        {
            "title": "Oops, the toast",
            "logline": "Lamo fights a toaster.",
            "category": "comedy",
            "source": "ai",
            "characterIds": [hero["characterId"]],
        }
    ]
    sent = model.calls[0]
    assert sent["modelId"] == "eu.anthropic.claude-haiku-5-5"
    texts = model.system_texts()
    assert texts[0].startswith('<owner_skills count="1">')
    assert "short-form-video-playbook" in texts[0]
    assert texts[-1].startswith(ideas.HOUSE_BRIEF)
    assert "no voice-over" in texts[-1]
    assert "Never made for children" in texts[-1]
    assert sent["outputConfig"]["textFormat"]["type"] == "json_schema"
    data = json.loads(model.user_text().split("\n", 1)[1])
    assert data["characters"][0]["name"] == "Lamo"
    assert data["characters"][0]["personality"] == "Brave but clumsy"
    assert {"id": "skid-recovery", "title": data["guidance"][0]["title"]} == data["guidance"][0]
    assert store.query_all(f"USER#{hero['userId']}#WS#stories", "IDEA#") == []  # nothing saved


def test_a_bad_answer_is_asked_once_more_then_the_helper_is_busy(call: Call, app: App) -> None:
    good = _drafts(
        _draft(
            "Skid school", "Lamo learns what to do when the car is sliding on ice.", "driving_safety", "skid-recovery"
        )
    )
    model = use_model(app, FakeModel("not json", good))
    status, body = call("POST", f"{BASE}/ideas/generate", {"category": "driving_safety"})
    assert status == 200
    assert body["drafts"][0]["category"] == "driving_safety"
    assert "broke these rules" in model.user_text(1)
    # A driving-safety idea that no checked topic covers is refused, then the second answer too.
    lava = _drafts(_draft("Lava road", "Escape a volcano by car.", "driving_safety", "volcano"))
    use_model(app, FakeModel(lava, lava))
    status, body = call("POST", f"{BASE}/ideas/generate", {"category": "driving_safety"})
    assert status == 503
    assert body["error"] == {"code": "platform_down", "message": "The idea helper is busy. Try again in a minute."}


def test_bedrock_errors_and_the_time_limit_end_in_busy(call: Call, app: App, monkeypatch: pytest.MonkeyPatch) -> None:
    model = use_model(
        app, FakeModel(client_error("ThrottlingException", 429), client_error("ThrottlingException", 429))
    )
    assert call("POST", f"{BASE}/ideas/generate", {})[0] == 503
    assert len(model.calls) == 2
    monkeypatch.setattr(ideas, "BUDGET_SECONDS", 5.0)  # less than one call needs: no call at all
    late = use_model(app, FakeModel())
    assert call("POST", f"{BASE}/ideas/generate", {})[0] == 503
    assert late.calls == []


def test_the_helper_off_is_a_plain_503(call: Call) -> None:
    status, body = call("POST", f"{BASE}/ideas/generate", {})
    assert status == 503
    assert body["error"]["code"] == "unavailable"


def test_generate_checks_its_body(call: Call, app: App) -> None:
    use_model(app, FakeModel())
    assert call("POST", f"{BASE}/ideas/generate", {"count": 7})[0] == 400
    assert call("POST", f"{BASE}/ideas/generate", {"topic": "x" * 201})[0] == 400
    assert call("POST", f"{BASE}/ideas/generate", {"category": "horror"})[0] == 400
    assert call("POST", f"{BASE}/ideas/generate", {"kids": True})[0] == 400


def _concept(**extra: Any) -> dict[str, Any]:
    return {
        "premise": "Lamo drives to the shop on an icy morning.",
        "beats": ["Lamo gets in the car", "The car slides", "Lamo eases off and steers", "Lamo cheers"],
        "lesson": "Ease off the accelerator and steer where you want to go.",
        "ending": "Lamo parks safely and does a happy dance.",
        "tone": "tense_then_relief",
        "durationSec": 80,
        "onScreenText": ["Ease off the accelerator", "Steer where you want to go"],
        "topicId": "skid-recovery",
        **extra,
    }


def test_expand_fills_the_concept_and_keeps_the_title(call: Call, app: App, store: db.Store) -> None:
    idea = seed_idea(
        store, title="Icy morning", logline="Lamo has to drive to work.", category="driving_safety", needsGuidance=True
    )
    model = use_model(app, FakeModel(json.dumps(_concept())))
    status, body = call("POST", f"{BASE}/ideas/{idea['ideaId']}/expand", {"durationSec": 40})
    assert status == 200
    out = body["idea"]
    assert out["title"] == "Icy morning"
    assert out["concept"]["durationSec"] == 40  # the owner's length wins over the model's
    assert out["concept"]["beats"][1] == "The car slides"
    assert out["safetyTopicId"] == "skid-recovery"  # the concept's words (and the model's pick) found the topic
    assert out["needsGuidance"] is False
    data = json.loads(model.user_text().split("\n", 1)[1])
    shown = data["guidance"][0]["steps"]
    assert "Remove the cause: release the brake." not in " ".join(str(s) for g in data["guidance"] for s in g["steps"])
    assert shown, "the writer gets the shown steps only"


def test_expand_refuses_a_bad_concept_twice(call: Call, app: App, store: db.Store) -> None:
    idea = seed_idea(store)
    bad = json.dumps(_concept(beats=["only one"], topicId=""))
    use_model(app, FakeModel(bad, bad))
    assert call("POST", f"{BASE}/ideas/{idea['ideaId']}/expand", {})[0] == 503
    assert "concept" not in store.get(idea["pk"], idea["sk"])  # type: ignore[operator]


def test_variations_are_drafts_from_the_idea(call: Call, app: App, store: db.Store) -> None:
    idea = seed_idea(store)
    use_model(app, FakeModel(_drafts(_draft("Toast 2", "The toaster strikes back."), _draft("Toast 3", "Toast rain."))))
    status, body = call("POST", f"{BASE}/ideas/{idea['ideaId']}/variations", {"count": 2})
    assert status == 200
    assert [d["source"] for d in body["drafts"]] == ["variation", "variation"]
    assert {d["parentIdeaId"] for d in body["drafts"]} == {idea["ideaId"]}
    # A variation of another category is not a variation of this idea.
    use_model(app, FakeModel(_drafts(_draft("Off", "x", "explainer")), _drafts(_draft("Off", "x", "explainer"))))
    assert call("POST", f"{BASE}/ideas/{idea['ideaId']}/variations", {})[0] == 503
    assert call("POST", f"{BASE}/ideas/{idea['ideaId']}/variations", {"count": 5})[0] == 400


def test_saving_a_draft_keeps_its_source_and_parent(call: Call, store: db.Store) -> None:
    parent = seed_idea(store)
    status, body = call(
        "POST",
        f"{BASE}/ideas",
        {
            "title": "Toast 2",
            "logline": "The toaster strikes back.",
            "category": "comedy",
            "source": "variation",
            "parentIdeaId": parent["ideaId"],
        },
    )
    assert status == 201
    assert body["idea"]["source"] == "variation"
    assert body["idea"]["parentIdeaId"] == parent["ideaId"]
