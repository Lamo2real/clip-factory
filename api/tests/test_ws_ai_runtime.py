"""The AI routes reach only Lamo Stories' own runtime, with the calls ``workspaces/agent.py`` (builder A) offers
(docs/CONTRACTS.md §45.5, §45.11.1, §45.24). On a branch without builder A's client the check is skipped; once both
are together it proves the test fake and the real client take the same keyword arguments and send the contract's
actions (``run_task`` / ``check_models``, ``chat_turn``, ``process_reference``) to ``cf_prod_story_agent``."""

from __future__ import annotations

import inspect

import pytest

from fakes import FakeAgentCore
from test_ws_ai_support import STORIES_ARN, FakeRuntime

CALLS = ("start_task", "start_chat_turn", "start_reference", "stop_session")


def _params(cls: type, name: str) -> list[str]:
    return [p for p in inspect.signature(cls.__dict__[name]).parameters if p != "self"]


def test_the_fake_matches_lamo_stories_runtime_client() -> None:
    agent = pytest.importorskip("clipfactory_api.workspaces.agent")
    real = agent.StoryAgent
    for name in CALLS:
        assert name in real.__dict__, name
        assert _params(real, name) == _params(FakeRuntime, name), name


def test_the_real_client_sends_the_contracts_actions() -> None:
    agent = pytest.importorskip("clipfactory_api.workspaces.agent")
    core = FakeAgentCore()
    client = agent.StoryAgent(core, STORIES_ARN)
    if "start_task" not in agent.StoryAgent.__dict__:
        pytest.skip("builder A's round-2 client is not on this branch yet")
    session = "cfstory-01JD0000000000000000000000-abcdefgh"
    client.start_task(user_id="u", workspace_id="stories", task_id="t1", kind="check_models", session_id=session)
    client.start_chat_turn(user_id="u", workspace_id="stories", conv_id="c1", msg_id="m1", session_id=session)
    client.start_reference(user_id="u", workspace_id="stories", ref_id="r1", job_id="j1", session_id=session)
    assert [c["payload"]["action"] for c in core.calls] == ["check_models", "chat_turn", "process_reference"]
    assert {c["agentRuntimeArn"] for c in core.calls} == {STORIES_ARN}
    assert core.calls[1]["payload"] == {
        "action": "chat_turn",
        "userId": "u",
        "workspaceId": "stories",
        "convId": "c1",
        "msgId": "m1",
    }
    assert core.calls[2]["payload"]["refId"] == "r1"
    assert core.calls[2]["payload"]["jobId"] == "j1"
