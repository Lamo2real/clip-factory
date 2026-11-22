"""The creative chat's answer: streaming, the tool loop, buttons, stop, overrides and compaction (§45.27, §45.25)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from lamostories_agent import models
from lamostories_agent.chat import history, turn
from lamostories_agent.chat.turn import run_turn
from test_tasks_support import PK, USER, WS, FakeImages, FakeModel, character_item, idea_item, reply, services

CONV = "C1"
ASK = "01JD0000000000000000000002"
ANSWER = "01JD0000000000000000000003"
PAYLOAD = {"userId": USER, "workspaceId": WS, "convId": CONV, "msgId": ANSWER}
MSG_SK = f"MSG#{CONV}#{ANSWER}"


def conv(**extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"CONV#{CONV}",
        "userId": USER,
        "workspaceId": WS,
        "convId": CONV,
        "title": "Ideas",
        "model": None,
        "effort": None,
        "projectRef": None,
        **extra,
    }


def msg(msg_id: str, role: str, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "pk": PK,
        "sk": f"MSG#{CONV}#{msg_id}",
        "type": "ws_msg",
        "userId": USER,
        "workspaceId": WS,
        "msgId": msg_id,
        "convId": CONV,
        "role": role,
        "text": text,
        "attachments": [],
        "status": "done",
        "actions": [],
        "createdAt": "2026-11-21T18:00:00.000Z",
        **extra,
    }


def pending(**extra: Any) -> dict[str, Any]:
    fields = {"status": "pending", "sessionId": "cfstory-m1", "heartbeatAt": "2026-11-21T18:00:00.000Z", **extra}
    return msg(ANSWER, "assistant", "", **fields)


def seed(
    db,
    text: str = "Give me an idea about picnics",
    *,
    conversation: dict | None = None,
    answer: dict | None = None,
    ask: dict | None = None,
) -> None:
    db.seed(conversation or conv())
    db.seed(ask or msg(ASK, "user", text))
    db.seed(answer or pending())


def run(svc) -> str:
    return asyncio.run(run_turn(svc, PAYLOAD))


def test_a_plain_answer_streams_into_the_message_and_ends_done(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            "Here is one: Bo's runaway pie rolls down the hill.",
            model="opus-5-5",
            effort="high",
            usage={"input": 900, "output": 40},
        )
    )
    svc, db, _ = services(tmp_path, model)
    seed(db)
    texts: list[str] = []
    db.on_write = lambda op, pk, sk: texts.append(db.get(pk, sk).get("status")) if sk == MSG_SK else None
    assert run(svc) == "done"
    answer = db.get(PK, MSG_SK)
    assert answer["status"] == "done" and answer["text"] == "Here is one: Bo's runaway pie rolls down the hill."
    assert (answer["model"], answer["effort"], answer["effortApplied"]) == ("opus-5-5", "high", True)
    assert answer["usage"] == {"input": 900, "output": 40} and answer["actions"] == []
    # streamed: the first piece is written at once, the rest at most every 0.5 s, then the end
    assert texts[0] == "streaming" and texts[-1] == "done" and len(texts) <= 3
    call = model.calls[0]
    assert call["task"] == "chat" and call["ctx"].agent_id == "creative_director"
    assert (call["ctx"].conv_id, call["ctx"].msg_id, call["ctx"].session_id) == (CONV, ANSWER, "cfstory-m1")
    assert call["override"] is None
    names = [t["toolSpec"]["name"] for t in call["tools"]]
    assert "remember" in names and "offer_make_video" in names
    assert not any(n.startswith(("clip", "post", "publish", "render")) for n in names)
    first = call["messages"][0]
    assert first["role"] == "user" and "No voice-over" in first["content"][0]["text"]
    assert call["messages"][-1]["content"][-1] == {"text": "Give me an idea about picnics"}


def test_streaming_writes_at_most_every_half_second(tmp_path: Path) -> None:
    model = FakeModel(reply("word " * 400))
    model.chunk = 1
    svc, db, _ = services(tmp_path, model)
    seed(db)
    assert run(svc) == "done"
    writes = [w for w in db.writes if w[2] == MSG_SK]
    assert len(writes) <= 3  # 2000 pieces in well under a second: one streaming write and the end


def test_the_text_so_far_replaces_the_rounds_text_and_a_restarted_stream_is_not_repeated(tmp_path: Path) -> None:
    model = FakeModel(
        reply("Let me look.", tools=[("list_ideas", {})]),
        reply("Here is one: Bo's runaway pie rolls down the hill."),
    )
    model.restart_after = 3  # the client retried a temporary error: the round's text starts again
    svc, db, _ = services(tmp_path, model)
    svc.stream_every_s = 0.0  # every piece is written
    seed(db)
    seen: list[str] = []
    db.on_write = lambda op, pk, sk: seen.append(db.get(pk, sk)["text"]) if sk == MSG_SK else None
    assert run(svc) == "done"
    final = "Let me look.\n\nHere is one: Bo's runaway pie rolls down the hill."
    assert db.get(PK, MSG_SK)["text"] == final
    assert len(seen) > 10 and all(final.startswith(t) for t in seen)  # never a piece repeated, also after a restart


def test_the_clients_refusal_fails_the_answer_with_its_sentence_and_a_settings_button(tmp_path: Path) -> None:
    class ModelRefused(Exception):
        pass

    sentence = "Claude Opus 5.5 said no to this request. Change the wording a little and try again."
    svc, db, _ = services(tmp_path, FakeModel(ModelRefused(sentence)))
    seed(db)
    assert run(svc) == "failed"
    answer = db.get(PK, MSG_SK)
    assert answer["error"] == sentence and answer["actions"] == [turn.PICK_MODEL]


def test_the_message_override_wins_over_the_conversation_model_and_effort_separately(tmp_path: Path) -> None:
    model = FakeModel(reply("ok"))
    svc, db, _ = services(tmp_path, model)
    seed(db, conversation=conv(model="sonnet-5-5", effort="low"), answer=pending(requested={"effort": "max"}))
    assert run(svc) == "done"
    assert model.calls[0]["override"] == {"model": "sonnet-5-5", "effort": "max"}
    assert "requested" in db.get(PK, MSG_SK)  # the override is the API's; nothing here saves it as a setting
    assert db.get(PK, f"CONV#{CONV}")["effort"] == "low"


def test_the_tool_loop_reads_writes_and_offers_buttons_without_doing_them(tmp_path: Path) -> None:
    model = FakeModel(
        reply("Let me look.", tools=[("list_characters", {}), ("list_ideas", {"status": "all"})]),
        reply(
            "Saving the idea and offering a video.",
            tools=[
                (
                    "create_idea",
                    {
                        "title": "Bo's pie",
                        "logline": "Bo chases a pie down a hill.",
                        "category": "comedy",
                        "characterIds": ["C1"],
                    },
                ),
                ("offer_make_video", {"ideaId": "I1", "characterIds": ["C1"], "durationSec": 40}),
                ("remember", {"text": "Lamo likes slapstick endings"}),
            ],
        ),
        reply("Done. Tap Make the video when you like it."),
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Bo"))
    db.seed(idea_item("I1"))
    seed(db)
    assert run(svc) == "done"
    answer = db.get(PK, MSG_SK)
    assert (
        answer["text"]
        == "Let me look.\n\nSaving the idea and offering a video.\n\nDone. Tap Make the video when you like it."
    )
    kinds = [a["kind"] for a in answer["actions"]]
    assert kinds == ["open", "make_video"]
    assert answer["actions"][1]["payload"] == {"story": {"characterIds": ["C1"], "ideaId": "I1", "durationSec": 40}}
    # the idea and the memory were written, nothing else of the studio was
    ideas = db.prefixed(PK, "IDEA#")
    assert {i["title"] for i in ideas} == {"The great sandwich chase", "Bo's pie"}
    assert [m["text"] for m in db.prefixed(PK, "MEM#")] == ["Lamo likes slapstick endings"]
    assert db.prefixed(PK, "STORY#") == [] and db.prefixed(PK, "PJOB#") == []
    # the tool results went back to the model in one user message per round
    results = model.calls[1]["messages"][-1]["content"]
    assert [r["toolResult"]["toolUseId"] for r in results] == ["t0", "t1"]
    assert results[0]["toolResult"]["content"][0]["json"]["characters"][0]["name"] == "Bo"
    assert answer["usage"] == {"input": 300, "output": 60}


def test_a_tool_mistake_goes_back_to_the_model_as_an_error(tmp_path: Path) -> None:
    model = FakeModel(
        reply(
            "",
            tools=[
                ("offer_make_video", {"characterIds": ["nobody"], "title": "x", "logline": "y", "category": "comedy"})
            ],
        ),
        reply("Pick a character first."),
    )
    svc, db, _ = services(tmp_path, model)
    seed(db)
    assert run(svc) == "done"
    result = model.calls[1]["messages"][-1]["content"][0]["toolResult"]
    assert result["status"] == "error" and "not saved characters" in result["content"][0]["json"]["error"]
    assert db.get(PK, MSG_SK)["actions"] == []


def test_stop_refuses_the_next_write_and_nothing_more_is_written(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())

    def stopped_while_thinking(call):
        db.seed({**db.get(PK, MSG_SK), "status": "stopped"})  # the owner tapped Stop
        return reply("A long answer", tools=[("remember", {"text": "should not be saved"})])

    svc.model = FakeModel(stopped_while_thinking)
    seed(db)
    assert run(svc) == "superseded"
    answer = db.get(PK, MSG_SK)
    assert answer["status"] == "stopped" and answer["text"] == ""
    assert db.prefixed(PK, "MEM#") == []


def test_a_model_that_is_not_available_fails_the_answer_with_its_sentence_and_a_settings_button(tmp_path: Path) -> None:
    sentence = "Claude Fable 5.2 isn't available right now: no access. Pick another model in Lamo Stories › Settings › AI, or try again."
    model = FakeModel(models.ModelUnavailable(sentence))
    svc, db, _ = services(tmp_path, model)
    seed(db, conversation=conv(model="fable-5-2"))
    assert run(svc) == "failed"
    answer = db.get(PK, MSG_SK)
    assert answer["status"] == "failed" and answer["error"] == sentence
    assert answer["actions"] == [turn.PICK_MODEL]
    assert len(model.calls) == 1


def test_an_unexpected_error_is_a_plain_sentence(tmp_path: Path) -> None:
    svc, db, _ = services(
        tmp_path, FakeModel(RuntimeError("socket closed https://x.s3.amazonaws.com/a?X-Amz-Signature=abc"))
    )
    seed(db)
    assert run(svc) == "failed"
    assert db.get(PK, MSG_SK)["error"] == "The answer stopped. Tap Try again."


def test_only_the_newest_pictures_go_to_the_model_through_the_helper(tmp_path: Path) -> None:
    images = FakeImages()
    model = FakeModel(reply("Nice car!"))
    svc, db, s3 = services(tmp_path, model, images=images)
    old_key = f"ws/{USER}/{WS}/chat/{CONV}/P0.png"
    new_key = f"ws/{USER}/{WS}/chat/{CONV}/P1.jpg"
    s3.objects[old_key] = b"old"
    s3.objects[new_key] = b"new"
    db.seed(conv())
    db.seed(
        msg("01JD0000000000000000000000", "user", "look", attachments=[{"assetId": "P0", "contentType": "image/png"}])
    )
    db.seed(msg("01JD0000000000000000000001", "assistant", "Cute."))
    db.seed(msg(ASK, "user", "and this one?", attachments=[{"assetId": "P1", "contentType": "image/jpeg"}]))
    db.seed(pending())
    assert run(svc) == "done"
    assert s3.reads == [new_key] and len(images.paths) == 1
    assert len(model.images(0)) == 1
    assert "[The owner attached 1 picture(s) here.]" in model.texts(0)


def test_a_picture_outside_the_conversation_folder_is_refused(tmp_path: Path) -> None:
    svc, db, s3 = services(tmp_path, FakeModel())
    s3.objects["uploads/x.png"] = b"x"
    seed(
        db,
        ask=msg(
            ASK, "user", "see", attachments=[{"assetId": "P1", "contentType": "image/png", "key": "uploads/x.png"}]
        ),
    )
    assert run(svc) == "failed"
    assert db.get(PK, MSG_SK)["error"] == "I can't open that picture. Try a screenshot or a photo."
    assert s3.reads == []


def test_a_long_conversation_is_compacted_into_a_summary_and_every_message_stays(tmp_path: Path) -> None:
    model = FakeModel(reply("Summary: the owner wants picnic comedies with Bo."), reply("Sure."))
    svc, db, _ = services(tmp_path, model)
    db.seed(conv())
    n = history.COMPACT_MESSAGES + 2
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        db.seed(msg(f"01JC{i:022d}", role, f"message {i}"))
    db.seed(msg(ASK, "user", "and now?"))
    db.seed(pending())
    assert run(svc) == "done"
    saved = db.get(PK, f"CONV#{CONV}")
    assert saved["summary"] == "Summary: the owner wants picnic comedies with Bo."
    kept_from = n + 1 - history.KEEP_RECENT
    assert saved["summaryUpToMsgId"] == f"01JC{kept_from - 1:022d}"
    assert "message 0" in model.texts(0) and model.calls[0]["tools"] is None
    sent = model.texts(1)
    assert "Summary of the earlier part" in sent and "message 0\n" not in sent and "and now?" in sent
    assert len(db.prefixed(PK, f"MSG#{CONV}#")) == n + 2  # the full messages stay readable


def test_a_compacted_conversation_sends_only_messages_after_the_summary(tmp_path: Path) -> None:
    model = FakeModel(reply("ok"))
    svc, db, _ = services(tmp_path, model)
    db.seed(conv(summary="They talked about pies.", summaryUpToMsgId="01JD0000000000000000000001"))
    db.seed(msg("01JD0000000000000000000000", "user", "old question"))
    db.seed(msg("01JD0000000000000000000001", "assistant", "old answer"))
    db.seed(msg(ASK, "user", "new question"))
    db.seed(pending())
    assert run(svc) == "done"
    sent = model.texts(0)
    assert "They talked about pies." in sent and "old question" not in sent and "new question" in sent


def test_the_project_the_conversation_is_about_is_named(tmp_path: Path) -> None:
    model = FakeModel(reply("ok"))
    svc, db, _ = services(tmp_path, model)
    db.seed(idea_item("I1"))
    seed(db, conversation=conv(projectRef={"kind": "idea", "id": "I1"}))
    assert run(svc) == "done"
    assert "This conversation is about this idea" in model.texts(0) and "The great sandwich chase" in model.texts(0)


def test_a_switched_off_creative_director_answers_nothing(tmp_path: Path) -> None:
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
    seed(db)
    assert run(svc) == "failed"
    assert "switched off" in db.get(PK, MSG_SK)["error"] and model.calls == []


def test_an_answer_that_is_not_live_is_left_alone(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    seed(db, answer=pending(status="done"))
    assert run(svc) == "skipped"
    seed(db, answer=pending())
    assert asyncio.run(run_turn(svc, {**PAYLOAD, "sessionId": "cfstory-other"})) == "skipped"
    assert db.writes == []


def test_a_deleted_conversation_fails_the_answer(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(msg(ASK, "user", "hi"))
    db.seed(pending())
    assert run(svc) == "failed"
    assert db.get(PK, MSG_SK)["error"] == turn.GONE


def test_the_tool_loop_stops_after_eight_rounds(tmp_path: Path) -> None:
    model = FakeModel(*[reply("", tools=[("list_ideas", {})]) for _ in range(turn.MAX_ROUNDS)])
    svc, db, _ = services(tmp_path, model)
    seed(db)
    assert run(svc) == "done"
    assert len(model.calls) == turn.MAX_ROUNDS
    assert db.get(PK, MSG_SK)["text"].endswith("Ask me to carry on.)")


def test_a_question_that_sorts_after_its_answer_is_still_answered(tmp_path: Path) -> None:
    model = FakeModel(reply("ok"))
    svc, db, _ = services(tmp_path, model)
    seed(db, ask=msg("01JD0000000000000000000009", "user", "same millisecond question"))
    assert run(svc) == "done"
    assert model.calls[0]["messages"][-1]["content"][-1] == {"text": "same millisecond question"}


def test_an_answer_that_failed_before_any_reply_keeps_the_model_and_effort_it_was_sent_with(tmp_path: Path) -> None:
    """§45.34: the API wrote the effective model and effort on the pending answer; a failure before any reply keeps
    them (a refusal names them itself), so the failed message still shows what was asked."""
    sentence = "Claude Fable 5.2 does not accept Maximum effort here (Amazon Bedrock refused it). Pick another level in Lamo Stories › Settings › AI."
    model = FakeModel(models.EffortUnavailable(sentence, model="fable-5-2", effort="max", sent=True, status="error"))
    svc, db, _ = services(tmp_path, model)
    seed(db, answer=pending(model="fable-5-2", effort="max", effortApplied=True))
    assert run(svc) == "failed"
    answer = db.get(PK, MSG_SK)
    assert (answer["model"], answer["effort"], answer["effortApplied"]) == ("fable-5-2", "max", False)
    assert answer["error"] == sentence

    # a failure that names no model leaves what the API wrote as it is
    svc, db, _ = services(tmp_path, FakeModel(RuntimeError("socket closed")))
    seed(db, answer=pending(model="sonnet-5-5", effort="low", effortApplied=True))
    assert run(svc) == "failed"
    answer = db.get(PK, MSG_SK)
    assert (answer["model"], answer["effort"]) == ("sonnet-5-5", "low")
