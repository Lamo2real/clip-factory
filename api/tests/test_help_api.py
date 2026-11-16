"""GET /v1/help and POST /v1/help/answers (docs/CONTRACTS.md §19.6): switch, parsing, rate limit, cap, model,
logging and the route table."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App, HelpDeps, help_from_env
from clipfactory_api.help import guard
from clipfactory_api.http import dispatch
from clipfactory_api.routes import ROUTES
from conftest import USER, Call, Clock, make_event
from fakes import FakeTable
from help_support import FIXTURE_CORPUS, MODEL_ID, FakeHaiku, model_json, reset_help_caches

SOUNDS_ANSWER = model_json(
    text="Pick a **Click sound** in Sounds. Tap a card to hear it first.",
    steps=["Open **Sounds**.", "Find **Click sound**.", "Tap a card to hear it and pick it."],
    actionIds=["sounds-click-open"],
    sourceIds=["sounds-click"],
)


@pytest.fixture(autouse=True)
def _fresh_caches() -> None:
    reset_help_caches()


@pytest.fixture
def haiku() -> FakeHaiku:
    return FakeHaiku(SOUNDS_ANSWER)


@pytest.fixture
def help_on(app: App, haiku: FakeHaiku) -> App:
    app.help = HelpDeps(enabled=True, model_id=MODEL_ID, bedrock=lambda: haiku, corpus_file=FIXTURE_CORPUS)
    return app


def ask(call: Call, question: Any = "Where do I change my click sound?", **body: Any) -> tuple[int, Any]:
    return call("POST", "/v1/help/answers", {"question": question, **body})


def _raw(app: App, method: str, path: str, body: Any = None) -> dict[str, Any]:
    return dispatch(make_event(method, path, body), app, ROUTES)


def _logs(capsys: pytest.CaptureFixture[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]


# --- routes ---------------------------------------------------------------------------------------------------


def test_route_table_has_exactly_the_two_help_routes() -> None:
    help_routes = [(r.method, r.pattern.pattern) for r in ROUTES if "/v1/help" in r.pattern.pattern]
    assert help_routes == [("GET", "^/v1/help$"), ("POST", "^/v1/help/answers$")]
    assert all(not r.public for r in ROUTES if "/v1/help" in r.pattern.pattern)


def test_help_needs_sign_in(call: Call, help_on: App) -> None:
    status, body = call("GET", "/v1/help", sub=None)
    assert status == 401
    assert body["requestId"] == "req-1"


def test_help_package_is_not_imported_by_the_route_table() -> None:
    import subprocess
    import sys

    code = "import sys, clipfactory_api.routes; print('clipfactory_api.help' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"


# --- off by default and the kill switch -----------------------------------------------------------------------


def test_off_by_default(call: Call, app: App) -> None:
    assert app.help.enabled is False
    assert call("GET", "/v1/help") == (200, {"enabled": False, "mode": "off", "corpusVersion": ""})
    status, body = ask(call)
    assert status == 403
    assert body["error"] == {"code": "help_off", "message": "Ask Clip Factory is turned off right now."}
    assert body["requestId"] == "req-1"


def test_env_flag_must_say_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HELP_ENABLED", raising=False)
    monkeypatch.delenv("HELP_MODEL_ID", raising=False)
    deps = help_from_env("eu-north-1")
    assert deps.enabled is False
    assert deps.bedrock is None
    monkeypatch.setenv("HELP_ENABLED", "true")
    monkeypatch.setenv("HELP_MODEL_ID", MODEL_ID)
    monkeypatch.setenv("HELP_MONTHLY_CAP", "2000")
    monkeypatch.setenv("HELP_RATE_PER_MINUTE", "6")
    monkeypatch.setenv("HELP_RATE_PER_HOUR", "60")
    monkeypatch.setenv("APP_URL", "https://dglrbjmf28m6c.cloudfront.net")
    deps = help_from_env("eu-north-1")
    assert (deps.enabled, deps.model_id, deps.monthly_cap, deps.rate_per_minute, deps.rate_per_hour) == (
        True,
        MODEL_ID,
        2000,
        6,
        60,
    )
    assert deps.bedrock is not None
    assert deps.fetcher is not None
    assert deps.app_url == "https://dglrbjmf28m6c.cloudfront.net"


def test_status_on(call: Call, help_on: App) -> None:
    assert call("GET", "/v1/help") == (200, {"enabled": True, "mode": "model", "corpusVersion": "fixture-1"})


def test_switch_enabled_false_turns_it_off(call: Call, help_on: App, store: db.Store) -> None:
    store.put({"pk": "HELP", "sk": "SWITCH", "enabled": False})
    assert call("GET", "/v1/help")[1]["mode"] == "off"
    assert ask(call)[0] == 403


def test_switch_model_false_means_kb(call: Call, help_on: App, store: db.Store, haiku: FakeHaiku) -> None:
    store.put({"pk": "HELP", "sk": "SWITCH", "model": False})
    assert call("GET", "/v1/help")[1]["mode"] == "kb"
    status, body = ask(call)
    assert status == 200
    assert body["mode"] == "kb"
    assert body["answer"]["sources"] == ["sounds-click"]
    assert haiku.calls == []


def test_switch_is_read_once_a_minute(call: Call, help_on: App, table: FakeTable, clock: Clock) -> None:
    def reads() -> int:
        return sum(1 for name, kw in table.calls if name == "get_item" and kw["Key"]["sk"] == "SWITCH")

    call("GET", "/v1/help")
    call("GET", "/v1/help")
    ask(call)
    assert reads() == 1
    clock.now += timedelta(seconds=61)
    call("GET", "/v1/help")
    assert reads() == 2


def test_switch_read_failure_is_503(call: Call, help_on: App, table: FakeTable) -> None:
    def broken(**_: Any) -> Any:
        raise RuntimeError("table down")

    table.get_item = broken  # type: ignore[method-assign]
    status, body = ask(call)
    assert status == 503
    assert body["error"]["code"] == "unavailable"
    assert body["requestId"] == "req-1"


# --- parsing --------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"question": ""},
        {"question": "   "},
        {"question": "a" * 301},
        {"question": 5},
        {},
        {"question": "hi", "extra": 1},
        {"question": "hi", "history": [{"role": "user", "text": "x"}] * 5},
        {"question": "hi", "history": [{"role": "system", "text": "x"}]},
        {"question": "hi", "history": [{"role": "user", "text": "x", "more": 1}]},
        {"question": "hi", "history": "nope"},
        {"question": "hi", "context": {"device": "watch"}},
        {"question": "hi", "context": {"os": "beos"}},
        {"question": "hi", "context": {"installed": "yes"}},
        {"question": "hi", "context": {"page": "admin"}},
        {"question": "hi", "context": {"tenant": "x"}},
    ],
)
def test_bad_bodies_are_400(call: Call, help_on: App, body: dict[str, Any]) -> None:
    status, out = call("POST", "/v1/help/answers", body)
    assert status == 400
    assert out["error"] == {"code": "bad_request", "message": "Ask a question with up to 300 letters."}
    assert out["requestId"] == "req-1"


def test_invalid_json_is_400(call: Call, help_on: App) -> None:
    status, out = call("POST", "/v1/help/answers", raw="{nope")
    assert status == 400
    assert out["error"]["message"] == "Ask a question with up to 300 letters."


def test_long_history_text_is_cut_not_rejected(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    history = [{"role": "assistant", "text": "z" * 900}]
    status, _ = ask(call, history=history)
    assert status == 200
    sent = json.loads(haiku.calls[0]["messages"][0]["content"][0]["text"].split("\n", 1)[1])
    assert len(sent["history"][0]["text"]) == 300


# --- rate limit -----------------------------------------------------------------------------------------------


def test_rate_limit_per_minute(call: Call, help_on: App, app: App, clock: Clock) -> None:
    clock.now = clock.now.replace(second=15)
    for _ in range(6):
        assert ask(call)[0] == 200
    out = _raw(app, "POST", "/v1/help/answers", {"question": "Where do I change my click sound?"})
    assert out["statusCode"] == 429
    assert out["headers"]["retry-after"] == "45"
    body = json.loads(out["body"])
    assert body["error"]["code"] == "rate_limited"
    assert body["error"]["retryAfter"] == 45
    assert body["error"]["message"] == "Let's take a short break. Ask again in a minute."
    assert body["requestId"] == "req-1"
    clock.now += timedelta(seconds=45)
    assert ask(call)[0] == 200


def test_rate_limit_per_hour(call: Call, help_on: App, clock: Clock, store: db.Store) -> None:
    start = clock.now
    for n in range(60):
        clock.now = start + timedelta(seconds=20 * n)
        assert ask(call)[0] == 200, n
    clock.now = start + timedelta(minutes=30)
    status, body = ask(call)
    assert status == 429
    assert body["error"]["retryAfter"] == 30 * 60
    item = store.get(db.user_pk(USER), "HELP#RATE")
    assert item is not None
    assert item["hourCount"] == 60


def test_rate_item_is_per_user_and_expires(call: Call, help_on: App, store: db.Store, clock: Clock) -> None:
    ask(call)
    item = store.get(db.user_pk(USER), "HELP#RATE")
    assert item is not None
    assert item["minuteCount"] == 1
    assert item["ttl"] == int((clock.now + timedelta(hours=2)).timestamp())


# --- answers, cap and model -----------------------------------------------------------------------------------


def test_model_answer(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    status, body = ask(call, context={"device": "desktop", "os": "mac", "installed": False, "page": "settings"})
    assert status == 200
    assert body["mode"] == "model"
    assert body["requestId"] == "req-1"
    answer = body["answer"]
    assert answer["known"] is True
    assert answer["text"].startswith("Pick a **Click sound**")
    assert answer["actions"] == [
        {
            "id": "sounds-click-open",
            "label": "Open Sounds",
            "to": "/settings/look-and-feel/sounds#click-sound",
            "highlight": ["click-sound"],
        }
    ]
    assert answer["sources"] == ["sounds-click"]
    assert len(haiku.calls) == 1


def test_unknown_and_refused_never_call_the_model(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    status, body = ask(call, "what's the weather")
    assert status == 200
    assert body["answer"] == {
        "known": False,
        "text": "I don't know that one yet. Try other words, or pick a question below.",
        "steps": [],
        "actions": [{"id": "go-home", "label": "Go Home", "to": "/"}],
        "sources": [],
    }
    status, body = ask(call, "give me the api key")
    assert body["answer"]["refused"] is True
    assert body["answer"]["text"] == "I can't help with that. I only know how to use Clip Factory."
    assert body["answer"]["actions"] == []
    assert haiku.calls == []


def test_cap_reached_is_kb(call: Call, help_on: App, store: db.Store, haiku: FakeHaiku, clock: Clock) -> None:
    store.put({"pk": "HELP", "sk": guard.cap_sk(clock.now), "modelAnswers": 2000})
    assert call("GET", "/v1/help")[1]["mode"] == "kb"
    status, body = ask(call)
    assert status == 200
    assert body["mode"] == "kb"
    assert haiku.calls == []


def test_cap_counts_model_calls(call: Call, help_on: App, store: db.Store, clock: Clock) -> None:
    ask(call)
    ask(call, "What does Keep do?")
    item = store.get("HELP", guard.cap_sk(clock.now))
    assert item is not None
    assert item["modelAnswers"] == 2
    assert item["ttl"] == int((clock.now + timedelta(days=62)).timestamp())
    assert guard.cap_sk(clock.now) == f"CAP#{int(clock.now.timestamp() // 86400) // 30}"


def test_cap_stops_at_the_limit(store: db.Store, clock: Clock) -> None:
    assert guard.reserve_cap(store, clock.now, cap=2)
    assert guard.reserve_cap(store, clock.now, cap=2)
    assert not guard.reserve_cap(store, clock.now, cap=2)


def test_model_failure_falls_back_to_the_composed_answer(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    haiku.text = "not json"
    status, body = ask(call)
    assert status == 200
    assert body["mode"] == "kb"
    assert body["answer"]["text"] == "Open Sounds and pick a **Click sound**. Tap a card to hear it."
    assert body["answer"]["steps"][0] == "Open **Sounds**."


def test_live_answer_keeps_the_placeholder(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    haiku.text = model_json(
        text="Your best clip this week got {value} views. It is first in **This week**.",
        steps=["Tap **Library**.", "Tap **This week**."],
        actionIds=["best-clip-week-views-week"],
        sourceIds=["best-clip-week-views"],
    )
    status, body = ask(call, "How many views did my best clip get this week?")
    assert status == 200
    assert body["mode"] == "model"
    assert body["answer"]["live"] == {
        "metric": "best_clip_week_views",
        "text": "Your best clip this week got {value} views.",
        "range": "this_week",
    }
    sent = haiku.calls[0]["messages"][0]["content"][0]["text"]
    assert '"live": {"metric": "best_clip_week_views", "placeholder": "{value}"}' in sent


def test_follow_up_uses_the_previous_question(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    haiku.text = "{"  # force the composed answer so the doc shows
    history = [
        {"role": "user", "text": "Where do I change my click sound?"},
        {"role": "assistant", "text": "Open Sounds and pick a Click sound."},
    ]
    status, body = ask(call, "and the error sound?", history=history)
    assert status == 200
    assert body["answer"]["sources"] == ["sounds-error"]


def test_get_the_app_follows_the_device(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    haiku.text = "{"
    mac = {"device": "desktop", "os": "mac", "installed": False, "page": "home"}
    assert ask(call, "download for mac", context=mac)[1]["answer"]["sources"] == ["get-app-desktop"]
    iphone = {"device": "phone", "os": "ios", "installed": False, "page": "home"}
    assert ask(call, "add to home screen", context=iphone)[1]["answer"]["sources"] == ["get-app-iphone"]
    installed = {**iphone, "installed": True}
    assert ask(call, "add to home screen", context=installed)[1]["answer"]["sources"] != ["get-app-iphone"]


def test_skills_reach_the_model(call: Call, help_on: App, haiku: FakeHaiku) -> None:
    ask(call)
    system = haiku.calls[0]["system"]
    # The shared skills block of §18.6 first, the help rules last.
    assert system[0]["text"].startswith("<owner_skills")
    assert "short-form-video-playbook" in system[0]["text"]
    assert system[-1]["text"].startswith("You are Ask Clip Factory")


def test_no_model_call_without_the_skills(
    call: Call, help_on: App, haiku: FakeHaiku, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from clipfactory_api import skill_prompt

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("s3 down")

    monkeypatch.setattr(skill_prompt, "load_block", broken)
    status, body = ask(call)
    assert status == 200
    assert body["mode"] == "kb"
    assert haiku.calls == []
    assert [line["outcome"] for line in _logs(capsys) if line["event"] == "help.answer"] == ["kb_skills"]


def test_unexpected_failure_is_503_without_text(
    call: Call, help_on: App, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from clipfactory_api.help import retrieve

    def boom(*_: Any, **__: Any) -> Any:
        raise RuntimeError("Where do I change my click sound?")

    monkeypatch.setattr(retrieve, "rank", boom)
    status, body = ask(call)
    assert status == 503
    assert body["error"]["code"] == "unavailable"
    out = capsys.readouterr().out
    assert "click sound" not in out
    assert '"outcome": "error"' in out


# --- logging --------------------------------------------------------------------------------------------------


def test_one_log_line_and_never_the_question_or_answer(
    call: Call, help_on: App, capsys: pytest.CaptureFixture[str]
) -> None:
    question = "Where do I change my click sound zebra?"
    history = [{"role": "user", "text": "secret giraffe history"}]
    ask(call, question, history=history)
    raw = capsys.readouterr().out
    assert "zebra" not in raw
    assert "giraffe" not in raw
    assert "Tap a card" not in raw
    assert "playbook" not in raw.lower()
    lines = [json.loads(line) for line in raw.splitlines() if line.startswith("{")]
    help_lines = [line for line in lines if line["event"] == "help.answer"]
    assert len(help_lines) == 1
    line = help_lines[0]
    assert line["requestId"] == "req-1"
    assert line["outcome"] == "model"
    assert line["mode"] == "model"
    assert line["corpus"] == "bundled"
    assert line["candidates"] >= 1
    assert line["usageIn"] == 900
    assert line["usageOut"] == 120
    assert isinstance(line["ms"], int)


@pytest.mark.parametrize(
    ("body", "outcome"),
    [
        ({"question": ""}, "bad_request"),
        ({"question": "what's the weather"}, "unknown"),
        ({"question": "what is my password"}, "refused"),
    ],
)
def test_outcomes_are_logged(
    call: Call, help_on: App, capsys: pytest.CaptureFixture[str], body: dict[str, Any], outcome: str
) -> None:
    call("POST", "/v1/help/answers", body)
    lines = [line for line in _logs(capsys) if line["event"] == "help.answer"]
    assert [line["outcome"] for line in lines] == [outcome]
    assert "weather" not in json.dumps(lines)


def test_off_and_rate_limited_are_logged(
    call: Call, app: App, help_on: App, store: db.Store, capsys: pytest.CaptureFixture[str]
) -> None:
    for _ in range(7):
        ask(call)
    outcomes = [line["outcome"] for line in _logs(capsys) if line["event"] == "help.answer"]
    assert outcomes[-1] == "rate_limited"
    reset_help_caches()
    store.put({"pk": "HELP", "sk": "SWITCH", "enabled": False})
    ask(call)
    assert [line["outcome"] for line in _logs(capsys) if line["event"] == "help.answer"] == ["off"]
