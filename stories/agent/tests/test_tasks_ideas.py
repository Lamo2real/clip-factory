"""AI ideas, Expand and Variations as tasks of the creative director (docs/CONTRACTS.md §45.7, §45.25, §45.9.1)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from lamostories_agent import models
from lamostories_agent.tasks import ideas
from lamostories_agent.tasks.work import run_task
from test_tasks_support import PK, USER, WS, FakeModel, character_item, idea_item, reply, services, task_item

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}


def run(svc, payload=PAYLOAD) -> str:
    return asyncio.run(run_task(svc, payload))


def draft(
    title: str, logline: str, category: str = "comedy", characters: list[str] | None = None, topic: str = ""
) -> dict:
    return {"title": title, "logline": logline, "category": category, "topicId": topic, "characters": characters or []}


def test_brainstorm_returns_drafts_with_the_house_brief_characters_and_guidance(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            data={
                "ideas": [
                    draft("Bo and the runaway pie", "Bo's pie rolls away at a picnic.", characters=["Bo"]),
                    draft("Pip's wrong door", "Pip opens every door but the right one.", characters=["Pip", "Nobody"]),
                ]
            },
            model="fable-5-2",
            effort="medium",
        )
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Bo"))
    db.seed(character_item("C2", "Pip"))
    db.seed(
        task_item(
            "T1",
            "brainstorm",
            input={"topic": "picnics", "count": 2},
            override={"model": "fable-5-2", "effort": "medium"},
        )
    )

    assert run(svc) == "done"
    task = db.get(PK, "TASK#T1")
    assert task["status"] == "done"
    assert task["result"]["drafts"] == [
        {
            "title": "Bo and the runaway pie",
            "logline": "Bo's pie rolls away at a picnic.",
            "category": "comedy",
            "source": "ai",
            "characterIds": ["C1"],
        },
        {
            "title": "Pip's wrong door",
            "logline": "Pip opens every door but the right one.",
            "category": "comedy",
            "source": "ai",
            "characterIds": ["C2"],
        },
    ]
    assert (task["model"], task["effort"], task["effortApplied"]) == ("fable-5-2", "medium", True)
    call = model.calls[0]
    assert call["task"] == "brainstorm" and call["ctx"].agent_id == "creative_director" and call["ctx"].task_id == "T1"
    assert call["ctx"].session_id == "cfstory-s1"
    assert call["override"] == {"model": "fable-5-2", "effort": "medium"}  # the per-request override, as stored
    assert call["schema"] == ideas.DRAFTS_SCHEMA
    text = model.texts(0)
    for words in (
        "No voice-over",
        "Never made for children",
        "9:16",
        "30 to 60 seconds",
        "Nothing dangerous",
        "picnics",
        "Bo is cheerful",
        "skid-recovery",
    ):
        assert words in text, words
    # nothing is saved: drafts only
    assert db.prefixed(PK, "IDEA#") == []


def test_a_bad_answer_is_asked_once_more_then_the_task_fails_plainly(tmp_path: Path) -> None:
    model = FakeModel(reply(text="not json"), reply(data={"ideas": []}))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", input={"count": 3}))
    assert run(svc) == "failed"
    task = db.get(PK, "TASK#T1")
    assert task["status"] == "failed" and task["error"] == "The idea helper could not finish. Tap Try again."
    assert len(model.calls) == 2
    assert "broke these rules" in model.texts(1)


def test_the_second_answer_is_taken_when_it_fixes_the_first(tmp_path: Path) -> None:
    model = FakeModel(
        reply(data={"ideas": [draft("x" * 90, "too long title")]}),
        reply(data={"ideas": [draft("Short title", "A fine line.")]}),
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", input={"count": 1}))
    assert run(svc) == "done"
    assert db.get(PK, "TASK#T1")["result"]["drafts"][0]["title"] == "Short title"


def test_driving_safety_drafts_must_name_a_checked_topic(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            data={
                "ideas": [
                    draft("Flying cars", "How to drive a flying car safely.", "driving_safety"),
                    draft(
                        "Pip on black ice",
                        "Pip's car starts skidding on black ice and Pip stays calm.",
                        "driving_safety",
                        topic="skid-recovery",
                    ),
                ]
            }
        ),
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", input={"count": 1, "category": "driving_safety"}))
    assert run(svc) == "done"
    drafts = db.get(PK, "TASK#T1")["result"]["drafts"]
    assert [d["title"] for d in drafts] == ["Pip on black ice"]
    assert "topicId" not in drafts[0]  # topic matching stays the API's (§45.7)


def test_a_model_the_owner_picked_that_is_not_available_fails_with_its_sentence_and_no_other_model(
    tmp_path: Path,
) -> None:
    sentence = "Claude Fable 5.2 isn't available right now: access denied. Pick another model in Funded Clips › Settings › AI, or try again."
    model = FakeModel(models.ModelUnavailable(sentence))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", override={"model": "fable-5-2"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == sentence
    assert len(model.calls) == 1 and model.calls[0]["override"] == {"model": "fable-5-2"}


def test_an_effort_the_model_does_not_offer_is_refused_not_swapped(tmp_path: Path) -> None:
    model = FakeModel(models.EffortUnavailable("Claude Haiku 5.5 does not offer Maximum. Pick another level."))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "variations", input={"ideaId": "I1"}))
    db.seed(idea_item("I1"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Claude Haiku 5.5 does not offer Maximum. Pick another level."
    assert len(model.calls) == 1


def test_variations_are_drafts_of_the_same_category_with_their_parent(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            data={
                "ideas": [
                    draft("The great soup chase", "Bo's soup slides off the table.", characters=["Bo"]),
                    draft("A safety lesson", "Brake on ice.", "driving_safety"),
                    draft("The great hat chase", "The wind takes Bo's hat."),
                ]
            }
        )
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Bo"))
    db.seed(idea_item("I1", characterIds=["C1"]))
    db.seed(task_item("T1", "variations", input={"ideaId": "I1", "count": 2}))
    assert run(svc) == "done"
    drafts = db.get(PK, "TASK#T1")["result"]["drafts"]
    assert [d["title"] for d in drafts] == ["The great soup chase", "The great hat chase"]
    assert all(d["source"] == "variation" and d["parentIdeaId"] == "I1" and d["category"] == "comedy" for d in drafts)
    assert "The great sandwich chase" in model.texts(0)


def test_expand_writes_the_concept_on_the_idea_with_the_task_end_and_returns_the_idea(tmp_path: Path) -> None:
    concept = {
        "premise": "Bo drops a sandwich on a hill and chases it.",
        "beats": ["Bo drops it", "It rolls", "Bo dives", "A dog catches it"],
        "lesson": "",
        "ending": "The dog shares.",
        "tone": "funny",
        "onScreenText": ["Oops!"],
    }
    model = FakeModel(reply(data=concept))
    svc, db, _ = services(tmp_path, model)
    db.seed(idea_item("I1"))
    db.seed({"pk": f"USER#{USER}#WSREG", "sk": f"WS#{WS}", "configuration": {"defaultDurationSec": 50}})
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1"}))
    assert run(svc) == "done"
    idea = db.get(PK, "IDEA#I1")
    assert idea["concept"] == {**concept, "lesson": None, "durationSec": 50}
    assert idea["title"] == "The great sandwich chase"  # the title is kept
    result = db.get(PK, "TASK#T1")["result"]["idea"]
    assert result["concept"]["durationSec"] == 50 and result["ideaId"] == "I1" and "pk" not in result
    assert "50 seconds" in model.texts(0)
    # one transaction: the idea and the task's end
    assert ("update", PK, "IDEA#I1") in db.writes


def test_expand_of_a_safety_idea_gets_only_the_shown_steps_of_its_topic(tmp_path: Path) -> None:
    concept = {
        "premise": "p",
        "beats": ["a", "b", "c"],
        "lesson": "Ease off.",
        "ending": "e",
        "tone": "calm",
        "onScreenText": [],
    }
    model = FakeModel(reply(data=concept))
    svc, db, _ = services(tmp_path, model)
    db.seed(idea_item("I1", category="driving_safety", safetyTopicId="skid-recovery"))
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1", "durationSec": 40}))
    assert run(svc) == "done"
    text = model.texts(0)
    assert "Remove the cause: ease off the accelerator." in text
    from lamostories_agent import config

    topic = next(t for t in config.guidance()["topics"] if t["id"] == "skid-recovery")
    for hidden in [s["text"] for s in topic["steps"] + topic["donts"] if not s["shown"]]:
        assert hidden not in text
    assert db.get(PK, "IDEA#I1")["concept"]["durationSec"] == 40


def test_expand_of_a_safety_idea_without_checked_advice_gives_no_driving_instructions(tmp_path: Path) -> None:
    concept = {
        "premise": "p",
        "beats": ["a", "b", "c"],
        "lesson": "",
        "ending": "e",
        "tone": "calm",
        "onScreenText": [],
    }
    model = FakeModel(reply(data=concept))
    svc, db, _ = services(tmp_path, model)
    db.seed(idea_item("I1", category="driving_safety", needsGuidance=True))
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1"}))
    assert run(svc) == "done"
    assert "no checked guidance covers it yet" in model.texts(0)


def test_expand_of_an_idea_of_another_workspace_or_user_finds_nothing(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, _ = services(tmp_path, model)
    db.seed({**idea_item("I1"), "userId": "someone-else"})
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == ideas.NO_IDEA
    assert model.calls == []


def test_a_switched_off_agent_stops_its_tasks(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, _ = services(tmp_path, model)
    db.seed(
        {
            "pk": PK,
            "sk": "AGENT#creative_director",
            "userId": USER,
            "workspaceId": WS,
            "name": "Creative director",
            "active": False,
        }
    )
    db.seed(task_item("T1", "brainstorm"))
    assert run(svc) == "failed"
    assert (
        db.get(PK, "TASK#T1")["error"]
        == "Creative director is switched off. Switch it on in Funded Clips › Settings › Agents."
    )
    assert model.calls == []


def test_a_task_that_is_not_live_or_belongs_to_another_session_is_never_written(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", status="failed"))
    db.seed(task_item("T2", "brainstorm"))
    assert run(svc) == "skipped"
    assert run(svc, {**PAYLOAD, "taskId": "T2", "sessionId": "cfstory-other"}) == "skipped"
    assert run(svc, {"userId": USER, "workspaceId": "clips", "taskId": "T1"}) == "skipped"
    assert db.writes == [] and model.calls == []


def test_a_superseded_session_writes_nothing_after_the_fence_moves(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(task_item("T1", "brainstorm"))

    def answer(call):
        # the API's stale-heartbeat fence fails the task and gives it a new session while the model thinks
        db.seed(
            {
                **db.get(PK, "TASK#T1"),
                "status": "failed",
                "sessionId": "cfstory-new",
                "error": "The helper stopped. Tap Try again.",
            }
        )
        return reply(data={"ideas": [draft("A", "B")]})

    svc.model = FakeModel(answer)
    assert run(svc) == "superseded"
    task = db.get(PK, "TASK#T1")
    assert (
        task["status"] == "failed"
        and task["error"] == "The helper stopped. Tap Try again."
        and task.get("result") is None
    )


def test_the_heartbeat_keeps_the_task_alive_and_a_refused_heartbeat_ends_it(tmp_path: Path) -> None:
    import threading

    release = threading.Event()
    svc, db, _ = services(tmp_path, FakeModel())
    svc.heartbeat_s = 0.02

    def slow(call):
        release.wait(2)
        return reply(data={"ideas": [draft("A", "B")]})

    svc.model = FakeModel(slow)
    db.seed(task_item("T1", "brainstorm", input={"count": 1}))

    async def go() -> str:
        job = asyncio.create_task(run_task(svc, PAYLOAD))
        await asyncio.sleep(0.15)
        beats = [w for w in db.writes if w[2] == "TASK#T1"]
        assert len(beats) >= 3  # running + heartbeats
        db.seed({**db.get(PK, "TASK#T1"), "sessionId": "cfstory-new"})
        out = await job
        release.set()
        return out

    assert asyncio.run(go()) == "superseded"
    assert db.get(PK, "TASK#T1").get("result") is None


def test_an_unknown_kind_fails_plainly(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(task_item("T1", "storyboard"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Funded Clips' agent does not know that kind of AI work yet."


class ModelRefused(Exception):
    """Like builder E's ``models.ModelRefused`` (its message is the owner's sentence)."""


class AnswerInvalid(Exception):
    """Like builder E's ``models.AnswerInvalid``: the client already asked once more."""


def test_the_clients_refusal_is_its_sentence_and_never_retried(tmp_path: Path) -> None:
    sentence = "Claude Opus 5.5 said no to this request. Change the wording a little and try again."
    model = FakeModel(ModelRefused(sentence))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == sentence and len(model.calls) == 1


def test_an_answer_the_client_gave_up_on_is_not_asked_for_again(tmp_path: Path) -> None:
    model = FakeModel(AnswerInvalid("The answer did not fit: ideas is required"))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm"))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == ideas.FAILED and len(model.calls) == 1


def test_asking_again_after_a_tool_answer_gives_each_tool_call_its_result(tmp_path: Path) -> None:
    first = reply(tools=[("submit_answer", {"ideas": [draft("x" * 90, "too long")]})])
    first = models.Reply(**{**first.__dict__, "data": {"ideas": [draft("x" * 90, "too long")]}})
    model = FakeModel(first, reply(data={"ideas": [draft("Short", "Fine.")]}))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "brainstorm", input={"count": 1}))
    assert run(svc) == "done"
    again = model.calls[1]["messages"]
    assert again[-2]["role"] == "assistant" and "toolUse" in again[-2]["content"][0]
    result = again[-1]["content"][0]["toolResult"]
    assert again[-1]["role"] == "user" and result["toolUseId"] == "t0" and result["status"] == "error"
    assert "broke these rules" in result["content"][0]["text"]


def test_an_idea_deleted_while_it_is_expanded_fails_the_task_plainly(tmp_path: Path) -> None:
    concept = {
        "premise": "p",
        "beats": ["a", "b", "c"],
        "lesson": "",
        "ending": "e",
        "tone": "funny",
        "onScreenText": [],
    }
    svc, db, _ = services(tmp_path, FakeModel())

    def answer(call):
        del db.items[(PK, "IDEA#I1")]  # the owner deletes the idea while the model thinks
        return reply(data=concept)

    svc.model = FakeModel(answer)
    db.seed(idea_item("I1"))
    db.seed(task_item("T1", "expand_idea", input={"ideaId": "I1", "durationSec": 40}))
    assert run(svc) == "failed"
    task = db.get(PK, "TASK#T1")
    assert task["status"] == "failed" and task["error"] == ideas.NO_IDEA
    assert db.get(PK, "IDEA#I1") is None


def test_a_heartbeat_that_fails_for_another_reason_does_not_stop_the_beat(tmp_path: Path) -> None:
    import threading

    from botocore.exceptions import ClientError

    release = threading.Event()
    svc, db, _ = services(tmp_path, FakeModel())
    svc.heartbeat_s = 0.02
    svc.model = FakeModel(lambda call: (release.wait(2), reply(data={"ideas": [draft("A", "B")]}))[1])
    db.seed(task_item("T1", "brainstorm", input={"count": 1}))
    real = db.update_item
    failed = []

    def flaky(**p):
        beat = p.get("ExpressionAttributeNames", {}).get("#n0") == "heartbeatAt"  # a heartbeat sets only that
        if beat and len(failed) < 2:
            failed.append(1)
            raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "UpdateItem")
        return real(**p)

    async def go() -> str:
        job = asyncio.create_task(run_task(svc, PAYLOAD))
        await asyncio.sleep(0.03)
        db.update_item = flaky  # type: ignore[method-assign]
        await asyncio.sleep(0.2)
        beats = len([w for w in db.writes if w[2] == "TASK#T1"])
        release.set()
        out = await job
        assert failed == [1, 1] and beats >= 3  # two throttled beats, and beating went on
        return out

    assert asyncio.run(go()) == "done"


def test_a_task_that_failed_on_bedrock_s_own_error_keeps_the_model_and_effort_it_was_sent_with(tmp_path: Path) -> None:
    """§45.34: not only a refusal; any failed send (``models._send`` puts what was asked on Bedrock's own error)."""
    from ls_fakes import client_error

    raw = client_error("ModelTimeoutException", "The model took too long")
    models._asked(raw, models.Choice(model="fable-5-2", effort="medium", effort_applied=True, source="request"))
    svc, db, _ = services(tmp_path, FakeModel(raw))
    db.seed(task_item("T1", "brainstorm", override={"model": "fable-5-2", "effort": "medium"}))
    assert run(svc) == "failed"
    task = db.get(PK, "TASK#T1")
    assert (task["model"], task["effort"], task["effortApplied"]) == ("fable-5-2", "medium", False)
