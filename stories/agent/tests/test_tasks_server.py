"""The creative agents' actions on the runtime's server: registered by the scaffold's ``register_all``, answered at
once, run in the background through the runner (docs/CONTRACTS.md §45.11.1, §45.33)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from starlette.testclient import TestClient

from lamostories_agent import chat, reference, tasks
from lamostories_agent.server import Actions, create_app, register_all
from lamostories_agent.tasks import services as svc_mod
from test_tasks_support import PK, USER, WS, FakeModel, reply, services, task_item


class RecordingRunner:
    def __init__(self) -> None:
        self.spawned: list[tuple[str, str]] = []
        self.coros: list[Any] = []

    def spawn(self, id: str, session_id: str, coro: Any) -> bool:
        self.spawned.append((id, session_id))
        self.coros.append(coro)
        return True

    def cancel(self, id: str) -> bool:
        return False

    def busy(self) -> bool:
        return bool(self.coros)

    async def shutdown(self) -> None:
        return None


def test_register_all_adds_the_creative_actions() -> None:
    actions = Actions()
    register_all(actions, None)
    assert {"run_task", "check_models", "chat_turn", "process_reference"} <= set(actions.table)


def test_an_existing_process_reference_is_left_alone() -> None:
    actions = Actions()

    def builder_e(payload: dict[str, Any]) -> dict[str, Any]:
        return {"accepted": True, "id": "E"}

    actions.register("process_reference", builder_e)
    reference.register(actions, None)
    assert actions.table["process_reference"] is builder_e


def test_actions_answer_at_once_and_spawn_through_the_runner() -> None:
    actions = Actions()
    runner = RecordingRunner()
    for package in (chat, tasks, reference):
        package.register(actions, runner)
    client = TestClient(create_app(actions))
    got = client.post(
        "/invocations", json={"action": "run_task", "userId": USER, "workspaceId": WS, "taskId": "T1"}
    ).json()
    assert got == {"accepted": True, "id": "T1"}
    got = client.post(
        "/invocations", json={"action": "chat_turn", "userId": USER, "workspaceId": WS, "convId": "C1", "msgId": "M2"}
    ).json()
    assert got == {"accepted": True, "id": "M2"}
    got = client.post(
        "/invocations",
        json={"action": "process_reference", "userId": USER, "workspaceId": WS, "refId": "R1", "jobId": "J1"},
    ).json()
    assert got == {"accepted": True, "id": "J1"}
    assert [s[0] for s in runner.spawned] == ["T1", "M2", "J1"]
    assert client.post("/invocations", json={"action": "run_task"}).json()["accepted"] is False
    for coro in runner.coros:
        coro.close()


def test_the_local_runner_runs_a_task_and_ping_says_busy(tmp_path: Path) -> None:
    svc, db, _ = services(
        tmp_path,
        FakeModel(
            reply(
                data={"ideas": [{"title": "A", "logline": "B", "category": "comedy", "topicId": "", "characters": []}]}
            )
        ),
    )
    db.seed(task_item("T1", "brainstorm", input={"count": 1}))
    svc_mod.install(svc)
    try:
        actions = Actions()
        tasks.register(actions, None)
        local = svc_mod.runner_for(actions, None)

        async def go() -> None:
            out = actions.table["run_task"]({"userId": USER, "workspaceId": WS, "taskId": "T1"})
            assert out == {"accepted": True, "id": "T1"}
            assert actions.busy()
            again = actions.table["run_task"]({"userId": USER, "workspaceId": WS, "taskId": "T1"})
            assert again == {"accepted": True, "id": "T1"}  # a duplicate while it runs is ignored
            while local.busy():
                await asyncio.sleep(0.01)

        asyncio.run(go())
        assert db.get(PK, "TASK#T1")["status"] == "done"
        assert not actions.busy()
    finally:
        svc_mod.install(None)


def test_check_models_action_runs_only_check_models_tasks(tmp_path: Path) -> None:
    from lamostories_agent.tasks.work import run_task

    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(task_item("T1", "brainstorm"))
    assert (
        asyncio.run(run_task(svc, {"userId": USER, "workspaceId": WS, "taskId": "T1"}, kinds=("check_models",)))
        == "failed"
    )


def test_the_model_client_comes_from_the_runner_or_the_models_module(monkeypatch) -> None:
    import pytest

    from lamostories_agent import models

    monkeypatch.delattr(models, "default_client", raising=False)
    monkeypatch.delattr(models, "get_client", raising=False)
    with pytest.raises(svc_mod.ServiceMissing):
        svc_mod.find_model_client(object())
    fake = FakeModel()

    class WithClient:
        model_client = fake

    assert svc_mod.find_model_client(WithClient()) is fake
    monkeypatch.setattr(models, "default_client", lambda: fake, raising=False)
    assert svc_mod.find_model_client(None) is fake


def test_the_model_client_is_found_in_the_shared_services_of_builder_e(monkeypatch) -> None:
    """Builder E keeps its client as ``lamostories_agent.services.get().models`` (its jobs use the same one)."""
    import sys
    import types

    from lamostories_agent import models

    monkeypatch.delattr(models, "default_client", raising=False)
    monkeypatch.delattr(models, "get_client", raising=False)
    fake = FakeModel()
    shared = types.ModuleType("lamostories_agent.services")
    shared.get = lambda: types.SimpleNamespace(models=fake)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "lamostories_agent.services", shared)
    assert svc_mod.find_model_client(object()) is fake

    def not_configured() -> Any:
        raise RuntimeError("Clip Factory Stories' agent is missing its table or bucket setting.")

    shared.get = not_configured  # type: ignore[attr-defined]
    import pytest

    with pytest.raises(svc_mod.ServiceMissing):
        svc_mod.find_model_client(object())


def test_a_missing_model_client_fails_the_task_at_once_with_a_plain_sentence(tmp_path: Path, monkeypatch) -> None:
    from lamostories_agent import models
    from lamostories_agent.tasks.work import run_task

    monkeypatch.delattr(models, "default_client", raising=False)
    monkeypatch.delattr(models, "get_client", raising=False)
    svc, db, _ = services(tmp_path, FakeModel())
    svc.model = svc_mod.LazyModel(object())
    db.seed(task_item("T1", "brainstorm"))
    assert asyncio.run(run_task(svc, {"userId": USER, "workspaceId": WS, "taskId": "T1"})) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == svc_mod.NO_CLIENT


def test_reference_analyze_is_the_function_builder_es_job_awaits() -> None:
    import inspect

    assert callable(reference.analyze) and inspect.iscoroutinefunction(reference.analyze)


def test_with_builder_es_process_reference_registered_first_the_app_still_builds() -> None:
    actions = Actions()
    runner = RecordingRunner()
    actions.register("process_reference", lambda payload: {"accepted": True, "id": "E"})
    for package in (chat, tasks, reference):  # register_all's order after builder E's own jobs
        package.register(actions, runner)
    assert {"run_task", "check_models", "chat_turn", "process_reference"} <= set(actions.table)
    assert actions.table["process_reference"]({})["id"] == "E"
