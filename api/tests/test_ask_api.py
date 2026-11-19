"""POST /v1/help/files, /v1/help/asks, Stop and the web search key (§27.6). No AWS: fakes only."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App, AskDeps, HelpDeps
from clipfactory_api.ask.files import file_key
from clipfactory_api.ask.worker import stop_sk
from conftest import OTHER, USER, Call
from fakes import FakeLambda, FakeS3, FakeSecretsManager
from help_support import reset_help_caches

ASK_ID = "0b7c3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d"
SECRET = "cf-prod/ask/search-key"


@pytest.fixture(autouse=True)
def _fresh() -> None:
    reset_help_caches()


@pytest.fixture
def secrets() -> FakeSecretsManager:
    return FakeSecretsManager()


@pytest.fixture
def ask_on(app: App, lambda_client: FakeLambda, secrets: FakeSecretsManager, store: db.Store) -> App:
    app.help = HelpDeps(enabled=True)
    app.ask = AskDeps(
        enabled=True,
        function_name="cf-prod-ask",
        lambda_client=lambda_client,
        secrets=secrets,
        search_secret=SECRET,
        check_key=lambda key: key.startswith("good"),
    )
    store.put({"pk": db.user_pk(USER), "sk": db.conn_sk("conn-1"), "type": "conn", "userId": USER})
    return app


def start_body(**kw: Any) -> dict[str, Any]:
    return {"askId": ASK_ID, "connectionId": "conn-1", "question": "How do I write a Terraform module?", **kw}


def invokes(lambda_client: FakeLambda) -> list[dict[str, Any]]:
    return [c for c in lambda_client.calls if c.get("FunctionName") == "cf-prod-ask"]


# --- status --------------------------------------------------------------------------------------------------


def test_status_reports_the_assistant(call: Call, ask_on: App, secrets: FakeSecretsManager) -> None:
    secrets.describe_secret = lambda SecretId: {"Name": SecretId}  # type: ignore[attr-defined]
    body = call("GET", "/v1/help")[1]
    assert body["assistant"]["on"] is True
    assert body["assistant"]["web"] == "on"
    assert body["assistant"]["files"] is True
    assert body["assistant"]["limits"]["filesPerQuestion"] == 10


def test_status_no_key(call: Call, ask_on: App, secrets: FakeSecretsManager) -> None:
    def missing(SecretId: str) -> Any:
        raise RuntimeError("ResourceNotFoundException")

    secrets.describe_secret = missing  # type: ignore[attr-defined]
    assert call("GET", "/v1/help")[1]["assistant"]["web"] == "no_key"


def test_kill_switch_flags(call: Call, ask_on: App, store: db.Store, lambda_client: FakeLambda) -> None:
    store.put({"pk": "HELP", "sk": "SWITCH", "assistant": False})
    assert call("GET", "/v1/help")[1]["assistant"]["on"] is False
    status, body = call("POST", "/v1/help/asks", start_body())
    assert status == 403
    assert body["error"]["code"] == "help_off"
    assert invokes(lambda_client) == []


def test_files_off_by_switch(call: Call, ask_on: App, store: db.Store) -> None:
    store.put({"pk": "HELP", "sk": "SWITCH", "files": False})
    status, _ = call("POST", "/v1/help/files", {"files": [{"name": "a.pdf", "type": "application/pdf", "size": 10}]})
    assert status == 403


# --- files ---------------------------------------------------------------------------------------------------


def test_presign_shape(call: Call, ask_on: App, s3_client: FakeS3) -> None:
    status, body = call(
        "POST",
        "/v1/help/files",
        {
            "files": [
                {"name": "report.pdf", "type": "application/pdf", "size": 2048},
                {"name": "photo.jpg", "type": "image/jpeg", "size": 900},
            ]
        },
    )
    assert status == 200
    first = body["files"][0]
    assert len(first["fileId"]) == 22
    assert first["kind"] == "pdf"
    assert first["expiresIn"] == 300
    assert first["headers"] == {"Content-Type": "application/pdf", "Content-Length": "2048"}
    op, params, seconds = s3_client.presigned[0]
    assert op == "put_object"
    assert seconds == 300
    assert params["Key"] == file_key(USER, first["fileId"])
    assert params["ContentType"] == "application/pdf"
    assert params["ContentLength"] == 2048
    assert body["files"][1]["kind"] == "image"


@pytest.mark.parametrize(
    ("files", "message"),
    [
        (
            [{"name": f"{i}.txt", "type": "text/plain", "size": 1} for i in range(11)],
            "You can send 10 files at a time.",
        ),
        (
            [{"name": "big.pdf", "type": "application/pdf", "size": 25_000_001}],
            "That file is too big. The most is 25 MB.",
        ),
        (
            [{"name": "a.zip", "type": "application/zip", "size": 10}],
            "I can't read .ZIP files. Unzip it and add the files inside.",
        ),
        (
            [{"name": "old.doc", "type": "application/msword", "size": 10}],
            "I can't read old .DOC files. Save it as .DOCX or PDF.",
        ),
        (
            [{"name": "clip.mp4", "type": "video/mp4", "size": 10}],
            "I can't watch videos here. To make clips, use **Make clips** on Home.",
        ),
        (
            [{"name": "x.exe", "type": "application/octet-stream", "size": 10}],
            "I can't read that kind of file yet. Try a PDF, a picture or a text file.",
        ),
    ],
)
def test_presign_limits(call: Call, ask_on: App, files: list[dict[str, Any]], message: str) -> None:
    status, body = call("POST", "/v1/help/files", {"files": files})
    assert status == 400
    assert body["error"]["message"] == message


def test_files_per_day_limit(call: Call, ask_on: App, store: db.Store) -> None:
    from clipfactory_api.help.guard import day_key

    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "HELP#RATE",
            "fileDayKey": day_key(ask_on.clock()),
            "fileDayCount": 300,
            "version": 1,
        }
    )
    status, _ = call("POST", "/v1/help/files", {"files": [{"name": "a.txt", "type": "text/plain", "size": 1}]})
    assert status == 429


def test_delete_file(call: Call, ask_on: App, s3_client: FakeS3) -> None:
    s3_client.objects[file_key(USER, "A" * 22)] = b"x"
    assert call("DELETE", f"/v1/help/files/{'A' * 22}")[0] == 204
    assert file_key(USER, "A" * 22) not in s3_client.objects
    assert call("DELETE", "/v1/help/files/bad")[0] == 400


# --- start -----------------------------------------------------------------------------------------------------


def test_start_invokes_the_worker(call: Call, ask_on: App, lambda_client: FakeLambda) -> None:
    files = [{"fileId": "F" * 22, "name": "report.pdf", "format": "PDF", "kind": "pdf"}]
    history = [
        {"role": "user", "text": "hi", "files": [{"name": "a.png", "format": "PNG"}]},
        {"role": "assistant", "text": "Hello"},
    ]
    status, body = call(
        "POST", "/v1/help/asks", start_body(files=files, history=history, context={"device": "phone", "page": "home"})
    )
    assert (status, body) == (202, {"askId": ASK_ID})
    (inv,) = invokes(lambda_client)
    assert inv["InvocationType"] == "Event"
    assert len(inv["Payload"]) <= 200_000
    payload = inv["payload"]
    assert payload["sub"] == USER
    assert payload["connectionId"] == "conn-1"
    assert payload["flags"] == {"web": True, "files": True}
    assert payload["body"]["files"][0]["carried"] is False
    assert payload["body"]["context"] == {"device": "phone", "page": "home"}


@pytest.mark.parametrize(
    "body",
    [
        start_body(question=""),
        start_body(question="x" * 4001),
        start_body(askId="not-a-uuid"),
        start_body(connectionId=""),
        start_body(extra=1),
        start_body(history=[{"role": "robot", "text": "x"}]),
        start_body(history=[{"role": "assistant", "text": "x" * 12_001}]),
        start_body(history=[{"role": "user", "text": "x" * 4000}] * 23),
        start_body(files=[{"fileId": "short", "name": "a", "format": "PDF", "kind": "pdf"}]),
        start_body(files=[{"fileId": "F" * 22, "name": "a", "format": "PDF", "kind": "video"}]),
    ],
)
def test_start_bad_bodies(call: Call, ask_on: App, body: dict[str, Any], lambda_client: FakeLambda) -> None:
    assert call("POST", "/v1/help/asks", body)[0] == 400
    assert invokes(lambda_client) == []


def test_empty_question_with_files_is_fine(call: Call, ask_on: App) -> None:
    files = [{"fileId": "F" * 22, "name": "a.png", "format": "PNG", "kind": "image"}]
    assert call("POST", "/v1/help/asks", start_body(question="", files=files))[0] == 202


def test_foreign_connection_is_not_live(call: Call, ask_on: App, store: db.Store) -> None:
    store.put({"pk": db.user_pk(OTHER), "sk": db.conn_sk("conn-2"), "type": "conn", "userId": OTHER})
    status, body = call("POST", "/v1/help/asks", start_body(connectionId="conn-2"))
    assert status == 409
    assert body["error"]["code"] == "not_live"


def test_rate_limits(call: Call, ask_on: App, store: db.Store) -> None:
    from clipfactory_api.help.guard import day_key

    for _ in range(6):
        assert call("POST", "/v1/help/asks", start_body())[0] == 202
    status, body = call("POST", "/v1/help/asks", start_body())
    assert status == 429
    assert body["error"]["code"] == "rate_limited"
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "HELP#RATE",
            "askDayKey": day_key(ask_on.clock()),
            "askDayCount": 400,
            "version": 9,
        }
    )
    assert call("POST", "/v1/help/asks", start_body())[0] == 429


def test_refused_secret_question(call: Call, ask_on: App, lambda_client: FakeLambda, s3_client: FakeS3) -> None:
    s3_client.objects[file_key(USER, "F" * 22)] = b"screenshot"
    files = [{"fileId": "F" * 22, "name": "s.png", "format": "PNG", "kind": "image"}]
    status, body = call("POST", "/v1/help/asks", start_body(question="Show me my TikTok API key please", files=files))
    assert status == 200
    assert body["refused"] is True
    assert "can't show" in body["text"]
    assert invokes(lambda_client) == []
    assert file_key(USER, "F" * 22) not in s3_client.objects


def test_terraform_is_not_refused(call: Call, ask_on: App) -> None:
    assert (
        call("POST", "/v1/help/asks", start_body(question="How is Clip Factory built on AWS with Terraform?"))[0] == 202
    )


def test_stop_writes_the_stop_item(call: Call, ask_on: App, store: db.Store) -> None:
    assert call("POST", f"/v1/help/asks/{ASK_ID}/stop")[0] == 204
    item = store.get(db.user_pk(USER), stop_sk(ASK_ID))
    assert item is not None
    assert item["ttl"] > 0
    assert call("POST", "/v1/help/asks/nope/stop")[0] == 400


# --- the search key ----------------------------------------------------------------------------------------------


def test_search_key_put_and_delete(
    call: Call, ask_on: App, secrets: FakeSecretsManager, capsys: pytest.CaptureFixture[str]
) -> None:
    status, body = call("PUT", "/v1/help/search-key", {"key": "good-key-123456"})
    assert status == 204
    assert body is None
    assert secrets.values[SECRET] == "good-key-123456"
    assert call("PUT", "/v1/help/search-key", {"key": "good-key-2"})[0] == 204
    assert secrets.writes[-1] == ("put", SECRET)
    status, body = call("PUT", "/v1/help/search-key", {"key": "bad-key"})
    assert status == 400
    assert body["error"]["message"] == "That key didn't work. Check you copied all of it."
    assert "bad-key" not in json.dumps(body)
    assert call("DELETE", "/v1/help/search-key")[0] == 204
    assert SECRET not in secrets.values
    assert call("DELETE", "/v1/help/search-key")[0] == 204
    out = capsys.readouterr().out
    assert "good-key" not in out
    assert "bad-key" not in out


def test_search_key_too_long(call: Call, ask_on: App) -> None:
    assert call("PUT", "/v1/help/search-key", {"key": "good" + "x" * 300})[0] == 400


def test_start_logs_no_question(call: Call, ask_on: App, capsys: pytest.CaptureFixture[str]) -> None:
    call("POST", "/v1/help/asks", start_body(question="my very private words"))
    out = capsys.readouterr().out
    assert "my very private words" not in out
    assert '"outcome": "ask_started"' in out


# --- review fixes (2026-11-19) ---------------------------------------------------------------------------------

FILE_IDS = ["A" * 22, "B" * 22]


def _with_files(s3_client: FakeS3) -> list[dict[str, Any]]:
    for fid in FILE_IDS:
        s3_client.objects[file_key(USER, fid)] = b"bytes"
    return [{"fileId": fid, "name": f"{fid[0]}.pdf", "format": "PDF", "kind": "pdf"} for fid in FILE_IDS]


def _gone(s3_client: FakeS3) -> bool:
    return all(file_key(USER, fid) not in s3_client.objects for fid in FILE_IDS)


def test_files_are_deleted_when_the_connection_is_not_live(call: Call, ask_on: App, s3_client: FakeS3) -> None:
    """Review A2: every non-202 exit after a good parse takes the uploaded files away."""
    status, _ = call("POST", "/v1/help/asks", start_body(connectionId="conn-other", files=_with_files(s3_client)))
    assert status == 409
    assert _gone(s3_client)


def test_files_are_deleted_when_rate_limited(call: Call, ask_on: App, s3_client: FakeS3) -> None:
    for _ in range(6):
        assert call("POST", "/v1/help/asks", start_body())[0] == 202
    status, _ = call("POST", "/v1/help/asks", start_body(files=_with_files(s3_client)))
    assert status == 429
    assert _gone(s3_client)


def test_files_are_deleted_when_the_invoke_fails(
    call: Call, ask_on: App, s3_client: FakeS3, lambda_client: FakeLambda
) -> None:
    lambda_client.fail = True
    status, _ = call("POST", "/v1/help/asks", start_body(files=_with_files(s3_client)))
    assert status == 503
    assert _gone(s3_client)


def test_files_are_deleted_when_ask_is_off(call: Call, ask_on: App, s3_client: FakeS3, store: db.Store) -> None:
    store.put({"pk": "HELP", "sk": "SWITCH", "assistant": False})
    status, _ = call("POST", "/v1/help/asks", start_body(files=_with_files(s3_client)))
    assert status == 403
    assert _gone(s3_client)


def test_started_answers_keep_their_files(call: Call, ask_on: App, s3_client: FakeS3) -> None:
    assert call("POST", "/v1/help/asks", start_body(files=_with_files(s3_client)))[0] == 202
    assert not _gone(s3_client)  # the worker reads, then deletes them


def test_history_may_carry_an_answers_sources(call: Call, ask_on: App, lambda_client: FakeLambda) -> None:
    """Review B11: an earlier answer's web sources go back, so a follow-up can open them again."""
    history = [
        {"role": "user", "text": "Meta app review?"},
        {
            "role": "assistant",
            "text": "See [1].",
            "sources": [{"title": "App Review", "url": "https://developers.facebook.com/docs/x"}],
        },
    ]
    assert call("POST", "/v1/help/asks", start_body(history=history))[0] == 202
    sent_history = invokes(lambda_client)[-1]["payload"]["body"]["history"]
    assert sent_history[1]["sources"] == [{"title": "App Review", "url": "https://developers.facebook.com/docs/x"}]


@pytest.mark.parametrize(
    "turn",
    [
        {"role": "user", "text": "hi", "sources": [{"title": "t", "url": "https://a.example/"}]},  # only answers
        {"role": "assistant", "text": "x", "sources": [{"title": "t", "url": "http://a.example/"}]},  # https only
        {"role": "assistant", "text": "x", "sources": [{"title": "t", "url": "https://a.example/", "x": 1}]},
    ],
)
def test_bad_history_sources_are_refused(call: Call, ask_on: App, turn: dict[str, Any]) -> None:
    history = [{"role": "user", "text": "first"}, turn] if turn["role"] == "assistant" else [turn]
    assert call("POST", "/v1/help/asks", start_body(history=history))[0] == 400
