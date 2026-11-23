"""The creative chat (docs/CONTRACTS.md §45.5 ``…/chat``, §45.6, §45.9.1 tail, §45.25, §45.27): conversations with
the model and effort the next message will use, sending (a ``pending`` answer with its own session, the override
kept only on that answer), the 409 while an answer is being written, Stop, the stale-heartbeat fence, polling with
``after`` (from the cursor), pictures (never lost, never blocking), best-effort stops inside the 29 s, and delete.
The answer itself is written by Lamo Stories' own runtime (``chat_turn``)."""

from __future__ import annotations

import time
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import ai_config as cfg
from clipfactory_api.workspaces import ai_resolve as res
from clipfactory_api.workspaces import chat
from clipfactory_api.workspaces import types as ws
from conftest import USER, Clock
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    prefix,
    seed_idea,
    ws_call,
)


@pytest.fixture
def runtime(app: App) -> FakeRuntime:
    found = install(app, FakeRuntime())
    assert found is not None
    return found


@pytest.fixture
def wcall(app: App, runtime: FakeRuntime) -> WsCall:
    return ws_call(app)


def _conv(wcall: WsCall, **body: Any) -> dict[str, Any]:
    status, got = wcall("POST", f"{BASE}/chat", body)
    assert status == 201, got
    return dict(got["conversation"])


def _send(wcall: WsCall, conv_id: str, text: str = "An idea about ice?", **body: Any) -> tuple[int, Any]:
    return wcall("POST", f"{BASE}/chat/{conv_id}/messages", {"text": text, **body})


def _finish(table: FakeTable, conv_id: str, msg_id: str, text: str = "Here it is.") -> None:
    item = table.items[(pk(), f"MSG#{conv_id}#{msg_id}")]
    item.update(status="done", text=text)


def test_a_conversation_shows_what_its_next_message_uses(wcall: WsCall) -> None:
    conv = _conv(wcall)
    assert conv["title"] == "New chat"
    assert (conv["model"], conv["effort"], conv["projectRef"], conv["lastMessageAt"]) == (None, None, None, None)
    assert conv["effective"] == {"model": "opus-5-5", "effort": "high", "effortApplied": True, "from": "default"}
    conv = _conv(wcall, title="Ice ideas", model="fable-5-2", effort="max")
    assert conv["effective"] == {"model": "fable-5-2", "effort": "max", "effortApplied": True, "from": "conversation"}
    status, got = wcall("PATCH", f"{BASE}/chat/{conv['convId']}", {"model": None, "effort": "low"})
    assert status == 200
    assert got["conversation"]["effective"] == {
        "model": "opus-5-5",
        "effort": "low",
        "effortApplied": True,
        "from": "default",
    }
    _, listed = wcall("GET", f"{BASE}/chat")
    assert listed["conversations"][0]["convId"] == conv["convId"]  # newest first


def test_a_conversation_about_a_project_of_this_workspace(wcall: WsCall, store: db.Store) -> None:
    idea_id = seed_idea(store)
    conv = _conv(wcall, projectRef={"kind": "idea", "id": idea_id})
    assert conv["projectRef"] == {"kind": "idea", "id": idea_id}
    other = seed_idea(store, user="someone-else")
    status, body = wcall("POST", f"{BASE}/chat", {"projectRef": {"kind": "idea", "id": other}})
    assert (status, body["error"]["message"]) == (404, "We could not find that idea.")
    assert wcall("POST", f"{BASE}/chat", {"projectRef": {"kind": "clip", "id": idea_id}})[0] == 400
    assert (
        wcall("PATCH", f"{BASE}/chat/{conv['convId']}", {"projectRef": None})[1]["conversation"]["projectRef"] is None
    )


def test_send_writes_both_messages_and_asks_lamo_stories_runtime(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable
) -> None:
    conv = _conv(wcall)
    status, body = _send(wcall, conv["convId"], override={"model": "fable-5-2", "effort": "max"})
    assert status == 202
    user, answer = body["user"], body["assistant"]
    assert (user["role"], user["text"], user["status"]) == ("user", "An idea about ice?", "done")
    assert (answer["role"], answer["status"], answer["text"]) == ("assistant", "pending", "")
    # "Just for this message": the answer records what it runs with; the conversation's own setting is untouched
    assert (answer["model"], answer["effort"], answer["effortApplied"]) == ("fable-5-2", "max", True)
    item = table.raw(pk(), f"MSG#{conv['convId']}#{answer['msgId']}")
    assert item is not None
    assert item["requested"] == {"model": "fable-5-2", "effort": "max"}
    assert item["sessionId"].startswith(f"cfstory-{answer['msgId']}-")
    assert item["heartbeatAt"] == item["createdAt"]
    assert user["msgId"] < answer["msgId"]
    (sent,) = runtime.calls
    assert sent == {
        "action": "chat_turn",
        "user_id": USER,
        "workspace_id": "stories",
        "conv_id": conv["convId"],
        "msg_id": answer["msgId"],
        "session_id": item["sessionId"],
    }
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    assert got["conversation"]["model"] is None
    assert got["conversation"]["effective"]["model"] == "opus-5-5"
    assert got["conversation"]["title"] == "An idea about ice?"
    assert got["conversation"]["lastMessageAt"] == "2026-11-15T12:00:00.000Z"
    assert [m["role"] for m in got["messages"]] == ["user", "assistant"]
    assert leaked([body, got]) == []


def test_a_second_message_waits_for_the_answer_or_stop(wcall: WsCall, runtime: FakeRuntime, table: FakeTable) -> None:
    conv = _conv(wcall)
    _, first = _send(wcall, conv["convId"])
    status, body = _send(wcall, conv["convId"], "And another?")
    assert (status, body["error"]["message"]) == (409, "Wait for the answer, or tap Stop.")
    answer_id = first["assistant"]["msgId"]
    old_session = table.raw(pk(), f"MSG#{conv['convId']}#{answer_id}")["sessionId"]
    status, body = wcall("POST", f"{BASE}/chat/{conv['convId']}/messages/{answer_id}/stop")
    assert (status, body["message"]["status"]) == (200, "stopped")
    item = table.raw(pk(), f"MSG#{conv['convId']}#{answer_id}")
    assert item["sessionId"] != old_session  # the old run can write nothing more
    assert runtime.stopped == [old_session]
    assert _send(wcall, conv["convId"], "And another?")[0] == 202
    # stopping a finished answer changes nothing; a user message cannot be stopped
    status, body = wcall("POST", f"{BASE}/chat/{conv['convId']}/messages/{answer_id}/stop")
    assert (status, body["message"]["status"]) == (200, "stopped")
    assert wcall("POST", f"{BASE}/chat/{conv['convId']}/messages/{first['user']['msgId']}/stop")[0] == 409


def test_an_answer_whose_heartbeat_stopped_is_failed(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable, clock: Clock
) -> None:
    conv = _conv(wcall)
    _, first = _send(wcall, conv["convId"])
    answer_id = first["assistant"]["msgId"]
    clock.now += timedelta(minutes=2)
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    assert got["messages"][-1]["status"] == "pending"
    clock.now += timedelta(minutes=2)
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    assert got["messages"][-1]["status"] == "failed"
    assert got["messages"][-1]["error"] == "The answer stopped. Tap Try again."
    assert len(runtime.stopped) == 1
    assert _send(wcall, conv["convId"], "Try again")[0] == 202
    item = table.raw(pk(), f"MSG#{conv['convId']}#{answer_id}")
    assert item["status"] == "failed"


def test_streaming_with_a_fresh_heartbeat_is_left_alone(wcall: WsCall, table: FakeTable, clock: Clock) -> None:
    conv = _conv(wcall)
    _, first = _send(wcall, conv["convId"])
    key = (pk(), f"MSG#{conv['convId']}#{first['assistant']['msgId']}")
    clock.now += timedelta(minutes=10)
    table.items[key].update(status="streaming", text="Half", heartbeatAt="2026-11-15T12:09:30.000Z")
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    assert (got["messages"][-1]["status"], got["messages"][-1]["text"]) == ("streaming", "Half")


def test_poll_with_after(wcall: WsCall, table: FakeTable) -> None:
    conv = _conv(wcall)
    _, one = _send(wcall, conv["convId"])
    _finish(table, conv["convId"], one["assistant"]["msgId"])
    _, two = _send(wcall, conv["convId"], "More?")
    status, got = wcall("GET", f"{BASE}/chat/{conv['convId']}", query={"after": one["assistant"]["msgId"]})
    assert status == 200
    assert [m["msgId"] for m in got["messages"]] == [two["user"]["msgId"], two["assistant"]["msgId"]]
    assert wcall("GET", f"{BASE}/chat/{conv['convId']}", query={"after": "nope"})[0] == 400
    # older history page by page (an addition to the contract's after, so the whole history stays readable)
    status, got = wcall("GET", f"{BASE}/chat/{conv['convId']}", query={"before": two["user"]["msgId"]})
    assert status == 200
    assert [m["msgId"] for m in got["messages"]] == [one["user"]["msgId"], one["assistant"]["msgId"]]
    assert wcall("GET", f"{BASE}/chat/{conv['convId']}", query={"before": "01JD0000000000000000000000"})[0] == 404


def test_pictures_go_to_the_conversations_own_prefix(wcall: WsCall, s3_client: FakeS3, table: FakeTable) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    status, up = wcall(
        "POST", f"{BASE}/chat/{conv_id}/attachments", {"filename": "a.png", "contentType": "image/png", "size": 1000}
    )
    assert status == 200
    assert up["headers"] == {"Content-Type": "image/png"}
    op, params, seconds = s3_client.presigned[-1]
    key = params["Key"]
    assert (op, params["ContentLength"], seconds) == ("put_object", 1000, 900)
    assert key == f"{prefix()}chat/{conv_id}/{up['assetId']}.png"
    status, body = _send(wcall, conv_id, attachments=[{"assetId": up["assetId"]}])
    assert (status, body["error"]["message"]) == (400, "That picture did not finish uploading. Add it again.")
    s3_client.objects[key] = b"\x89PNG" + b"0" * 996
    status, body = _send(wcall, conv_id, attachments=[{"assetId": up["assetId"]}])
    assert status == 202
    (picture,) = body["user"]["attachments"]
    assert picture["assetId"] == up["assetId"]
    assert picture["contentType"] == "image/png"
    assert picture["url"].startswith("https://")
    item = table.raw(pk(), f"MSG#{conv_id}#{body['user']['msgId']}")
    assert item["attachments"][0]["key"] == key  # the agent reads the key from the item
    assert table.raw(pk(), f"CONV#{conv_id}")["uploads"] == {}
    assert leaked([body]) == []
    for bad in ({"contentType": "image/gif", "size": 10}, {"contentType": "image/png", "size": 0}):
        assert wcall("POST", f"{BASE}/chat/{conv_id}/attachments", {"filename": "a", **bad})[0] == 400
    big = {"filename": "a", "contentType": "image/jpeg", "size": 5 * 1024 * 1024 + 1}
    assert wcall("POST", f"{BASE}/chat/{conv_id}/attachments", big)[0] == 413


def test_a_model_that_cannot_see_pictures_is_refused(
    wcall: WsCall, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    models = res.models()
    for m in models:
        if m["key"] == "haiku-5-5":
            m["vision"] = False
    monkeypatch.setattr(res, "models", lambda: [dict(m) for m in models])
    conv = _conv(wcall, model="haiku-5-5")
    _, up = wcall(
        "POST",
        f"{BASE}/chat/{conv['convId']}/attachments",
        {"filename": "a.png", "contentType": "image/png", "size": 4},
    )
    s3_client.objects[f"{prefix()}chat/{conv['convId']}/{up['assetId']}.png"] = b"\x89PNG"
    status, body = _send(wcall, conv["convId"], attachments=[{"assetId": up["assetId"]}])
    assert (status, body["error"]["message"]) == (400, "Claude Haiku 5.5 can't look at pictures. Pick another model.")


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"text": ""}, 400),
        ({"text": "x" * 8001}, 400),
        ({"text": "hi", "override": {"model": "gpt-9"}}, 400),
        ({"text": "hi", "override": {"effort": "turbo"}}, 400),
        ({"text": "hi", "override": {"temperature": 1}}, 400),
        ({"text": "hi", "attachments": [{"assetId": "x"}] * 5}, 400),
        ({"text": "hi", "colour": "red"}, 400),
    ],
)
def test_send_validation(wcall: WsCall, table: FakeTable, body: dict[str, Any], status: int) -> None:
    conv = _conv(wcall)
    assert wcall("POST", f"{BASE}/chat/{conv['convId']}/messages", body)[0] == status
    assert not [k for k in table.items if k[1].startswith(f"MSG#{conv['convId']}")]


def test_a_switched_off_creative_director_or_no_runtime(app: App, wcall: WsCall, table: FakeTable) -> None:
    conv = _conv(wcall)
    assert wcall("PATCH", f"{BASE}/agents/creative_director", {"version": 1, "active": False})[0] == 200
    status, body = _send(wcall, conv["convId"])
    assert status == 409
    assert (
        body["error"]["message"]
        == "Creative director is switched off. Switch it on in Funded Clips › Settings › Agents."
    )
    assert wcall("PATCH", f"{BASE}/agents/creative_director", {"version": 2, "active": True})[0] == 200
    install(app, None)
    status, body = _send(wcall, conv["convId"])
    assert status == 202
    assert (body["assistant"]["status"], body["assistant"]["error"]) == (
        "failed",
        "Funded Clips' AI helper isn't switched on yet.",
    )
    runtime = FakeRuntime()
    runtime.fail = True
    install(app, runtime)
    status, body = _send(wcall, conv["convId"])
    assert (body["assistant"]["status"], body["assistant"]["error"]) == (
        "failed",
        "The answer did not start. Tap Try again.",
    )


def test_delete_stops_the_answer_and_removes_everything(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable, s3_client: FakeS3
) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    _send(wcall, conv_id)
    s3_client.objects[f"{prefix()}chat/{conv_id}/x.png"] = b"png"
    status, _ = wcall("DELETE", f"{BASE}/chat/{conv_id}")
    assert status == 204
    assert not [k for k in table.items if conv_id in k[1]]
    assert not [k for k in s3_client.objects if f"/chat/{conv_id}/" in k]
    assert len(runtime.stopped) == 1
    assert wcall("GET", f"{BASE}/chat/{conv_id}")[0] == 404
    assert wcall("DELETE", f"{BASE}/chat/{conv_id}")[0] == 404


def test_another_owners_conversation_is_never_found(app: App, wcall: WsCall, store: db.Store) -> None:
    conv = _conv(wcall)
    status, _ = wcall("GET", f"{BASE}/chat/{conv['convId']}", sub="99999999-8888-7777-6666-555555555555")
    assert status == 404
    store.put(
        {
            "pk": pk(),
            "sk": f"{ws.CONV_SK}01JD0000000000000000000009",
            "type": ws.TYPE_CONV,
            "userId": USER,
            "workspaceId": "another",
            "convId": "01JD0000000000000000000009",
        }
    )
    assert wcall("GET", f"{BASE}/chat/01JD0000000000000000000009")[0] == 404
    _, listed = wcall("GET", f"{BASE}/chat")
    assert [c["convId"] for c in listed["conversations"]] == [conv["convId"]]


# --- one answer at a time, also when two messages arrive at once ----------------------------------------------


def test_two_messages_sent_at_once_get_one_answer(
    app: App, wcall: WsCall, runtime: FakeRuntime, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A double tap: the second send reads the same state as the first (no answer yet) and the first one commits
    while the second is between its check and its write. The second must not leave a second pending answer."""
    conv = _conv(wcall)
    conv_id = conv["convId"]
    real_last = chat._last_answer
    seen: list[Any] = []

    def racing_last(*args: Any, **kwargs: Any) -> Any:
        found = real_last(*args, **kwargs)
        if not seen:  # the first send's check: the other tap lands right after it
            seen.append(None)
            seen.append(chat.send(app, USER, "stories", conv_id, {"text": "Tap one"}, now=app.clock()))
        return found

    monkeypatch.setattr(chat, "_last_answer", racing_last)
    status, body = _send(wcall, conv_id, "Tap two")
    assert (status, body["error"]["message"]) == (409, "Wait for the answer, or tap Stop.")
    assert seen[1]["assistant"]["status"] == "pending"
    answers = [i for k, i in table.items.items() if k[1].startswith(f"MSG#{conv_id}#") and i["role"] == "assistant"]
    users = [i for k, i in table.items.items() if k[1].startswith(f"MSG#{conv_id}#") and i["role"] == "user"]
    assert (len(answers), [u["text"] for u in users]) == (1, ["Tap one"])
    assert runtime.actions() == ["chat_turn"]


def test_a_picture_asked_for_while_a_message_is_sent_is_kept(
    app: App, wcall: WsCall, s3_client: FakeS3, table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    real_pictures = chat._pictures
    asked: list[str] = []

    def racing_pictures(*args: Any, **kwargs: Any) -> Any:
        found = real_pictures(*args, **kwargs)
        if not asked:  # another picture is asked for between the send's read and its write
            body = {"filename": "b.png", "contentType": "image/png", "size": 4}
            asked.append(chat.attachment(app, USER, "stories", conv_id, body, now=app.clock())["assetId"])
        return found

    monkeypatch.setattr(chat, "_pictures", racing_pictures)
    assert _send(wcall, conv_id)[0] == 202  # read again after the picture's write, then sent
    assert list(table.raw(pk(), f"CONV#{conv_id}")["uploads"]) == asked


def _ask_picture(wcall: WsCall, conv_id: str) -> tuple[int, Any]:
    body = {"filename": "a.png", "contentType": "image/png", "size": 4}
    return wcall("POST", f"{BASE}/chat/{conv_id}/attachments", body)


def test_pictures_never_sent_do_not_block_the_conversation(
    wcall: WsCall, s3_client: FakeS3, table: FakeTable, clock: Clock
) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    for _ in range(20):  # added and removed again, failed uploads, a reload: none of them is ever sent
        assert _ask_picture(wcall, conv_id)[0] == 200
    status, body = _ask_picture(wcall, conv_id)
    assert (status, body["error"]["message"]) == (409, "Too many pictures are waiting. Send them with a message first.")
    clock.now += timedelta(minutes=16)  # their upload links have closed: they no longer count
    status, up = _ask_picture(wcall, conv_id)
    assert status == 200
    s3_client.objects[f"{prefix()}chat/{conv_id}/{up['assetId']}.png"] = b"\x89PNG"
    clock.now += timedelta(hours=2)  # a picture uploaded earlier can still be sent later the same day
    status, body = _send(wcall, conv_id, attachments=[{"assetId": up["assetId"]}])
    assert status == 202
    assert len(table.raw(pk(), f"CONV#{conv_id}")["uploads"]) == 20
    clock.now += timedelta(days=1, minutes=1)  # a day on, the ones never sent are forgotten
    assert _ask_picture(wcall, conv_id)[0] == 200
    assert len(table.raw(pk(), f"CONV#{conv_id}")["uploads"]) == 1


def test_waiting_pictures_are_capped(wcall: WsCall, table: FakeTable, clock: Clock) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    for _ in range(3):
        for _ in range(20):
            assert _ask_picture(wcall, conv_id)[0] == 200
        clock.now += timedelta(minutes=16)
    assert len(table.raw(pk(), f"CONV#{conv_id}")["uploads"]) == chat.MAX_KEPT


def test_the_poll_reads_only_the_newer_messages(wcall: WsCall, table: FakeTable) -> None:
    conv = _conv(wcall)
    conv_id = conv["convId"]
    _, one = _send(wcall, conv_id)
    _finish(table, conv_id, one["assistant"]["msgId"])
    _, two = _send(wcall, conv_id, "More?")
    table.calls.clear()
    status, got = wcall("GET", f"{BASE}/chat/{conv_id}", query={"after": two["user"]["msgId"]})
    assert status == 200
    assert [m["msgId"] for m in got["messages"]] == [two["assistant"]["msgId"]]
    queries = [kw for name, kw in table.calls if name == "query" and ":prefix" in kw["ExpressionAttributeValues"]]
    reads = [q for q in queries if q["ExpressionAttributeValues"][":prefix"] == f"MSG#{conv_id}#"]
    assert len(reads) == 1
    assert reads[0]["ExclusiveStartKey"] == {"pk": pk(), "sk": f"MSG#{conv_id}#{two['user']['msgId']}"}
    assert reads[0]["ScanIndexForward"] is True
    assert reads[0]["ConsistentRead"] is True
    missing = "01JD0000000000000000000000"
    status, body = wcall("GET", f"{BASE}/chat/{conv_id}", query={"after": missing})
    assert (status, body["error"]["message"]) == (404, "We could not find that message.")


# --- best-effort stops: once, after the start, only while the request has time -------------------------------


def test_a_stale_answers_stop_comes_after_the_new_start_and_is_tried_once(
    wcall: WsCall, runtime: FakeRuntime, table: FakeTable, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    conv = _conv(wcall)
    _, first = _send(wcall, conv["convId"])
    old_session = table.raw(pk(), f"MSG#{conv['convId']}#{first['assistant']['msgId']}")["sessionId"]
    order: list[str] = []
    real_stop, real_start = runtime.stop_session, runtime.start_chat_turn

    def stop(session_id: str, *, attempts: int = 2) -> None:
        order.append("stop")
        real_stop(session_id, attempts=attempts)

    def start(**kw: Any) -> None:
        order.append("start")
        real_start(**kw)

    monkeypatch.setattr(runtime, "stop_session", stop)
    monkeypatch.setattr(runtime, "start_chat_turn", start)
    clock.now += timedelta(minutes=4)  # the first answer's heartbeat stopped
    assert _send(wcall, conv["convId"], "Try again")[0] == 202
    assert order == ["start", "stop"]
    assert (runtime.stopped, runtime.stop_attempts) == ([old_session], [1])


def test_no_stop_is_made_when_the_request_has_no_time_left(
    wcall: WsCall, runtime: FakeRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    conv = _conv(wcall)
    _, first = _send(wcall, conv["convId"])
    real_begin = cfg.begin_request
    monkeypatch.setattr(cfg, "begin_request", lambda started: real_begin(time.monotonic() - 10))  # 10 s gone
    status, body = wcall("POST", f"{BASE}/chat/{conv['convId']}/messages/{first['assistant']['msgId']}/stop")
    assert (status, body["message"]["status"]) == (200, "stopped")  # fenced all the same
    assert runtime.stopped == []


# --- §45.35 D4: the one-time choice comes back; D5: what the call really used ----------------------------------


def test_an_answer_returns_its_one_time_choice_on_every_read(wcall: WsCall, table: FakeTable) -> None:
    """ "Just for this message" is kept on the answer (``requested``) and returned, so Try again and the chat cards
    use it on every device; the user's own message never carries it, and an answer sent without one says null."""
    conv = _conv(wcall)
    status, body = _send(wcall, conv["convId"], override={"effort": "low"})
    assert status == 202
    assert body["assistant"]["requested"] == {"effort": "low"}
    assert "requested" not in body["user"]
    _finish(table, conv["convId"], body["assistant"]["msgId"])
    status, plain = _send(wcall, conv["convId"], text="And another?")
    assert status == 202
    assert plain["assistant"]["requested"] is None
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    by_id = {m["msgId"]: m for m in got["messages"]}
    assert by_id[body["assistant"]["msgId"]]["requested"] == {"effort": "low"}
    assert by_id[plain["assistant"]["msgId"]]["requested"] is None
    assert [m for m in got["messages"] if m["role"] == "user" and "requested" in m] == []
    assert leaked([body, plain, got]) == []
    # a stored choice with anything else in it shows only the model and effort
    item = table.items[(pk(), f"MSG#{conv['convId']}#{plain['assistant']['msgId']}")]
    item["requested"] = {"model": "fable-5-2", "effort": "max", "note": "x"}
    shown = chat.public_message(_App(), item)
    assert shown["requested"] == {"model": "fable-5-2", "effort": "max"}


class _App:
    class media:  # the app's media helper, as public_message reads it
        @staticmethod
        def presign_get(key: str, seconds: int) -> str:
            return f"https://example.test/{seconds}"


def test_an_answer_shows_the_model_id_and_region_it_really_called(wcall: WsCall, table: FakeTable) -> None:
    """§45.35 D5: the agent records ``modelId`` (the Bedrock id or profile really called), ``region``, ``task`` and
    ``failed: true`` on the answer; the API passes them through (left out while not recorded)."""
    conv = _conv(wcall)
    _, body = _send(wcall, conv["convId"])
    answer_id = body["assistant"]["msgId"]
    assert not {"modelId", "region", "task", "failed"} & set(body["assistant"])
    item = table.items[(pk(), f"MSG#{conv['convId']}#{answer_id}")]
    item.update(status="failed", error="Amazon Bedrock refused it.", modelId="global.anthropic.claude-opus-5-5",
                region="eu-north-1", task="chat", failed=True)  # fmt: skip
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    shown = next(m for m in got["messages"] if m["msgId"] == answer_id)
    assert {k: shown[k] for k in ("model", "modelId", "region", "task", "failed")} == {
        "model": "opus-5-5",
        "modelId": "global.anthropic.claude-opus-5-5",
        "region": "eu-north-1",
        "task": "chat",
        "failed": True,
    }
    item["failed"] = "yes"  # only a real true counts
    _, got = wcall("GET", f"{BASE}/chat/{conv['convId']}")
    assert "failed" not in next(m for m in got["messages"] if m["msgId"] == answer_id)
