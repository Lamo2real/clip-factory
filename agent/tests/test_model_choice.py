"""The owner's choice of model for clip jobs (docs/DECISIONS.md ADR-42): the pick comes from Settings, every Claude
step of the job uses it, one client per model, and a model Bedrock refuses as unavailable gives way to the default."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent.bedrock import Bedrock, model_unavailable
from clipfactory_agent.config import clip_models_from_models_json, load_config, model_from_models_json, profile_id
from clipfactory_agent.pipeline import Pipeline

from .deep_support import ToolClient, client_error
from .test_pipeline import World, assert_ready

REPO = Path(__file__).resolve().parents[2]
CLIP_MODELS = {
    "fable-5-2": "global.anthropic.claude-fable-5-2",
    "fable-5-1": "global.anthropic.claude-fable-5-1",
    "opus-5-5": "global.anthropic.claude-opus-5-5",
    "sonnet-5-5": "global.anthropic.claude-sonnet-5-5",
    "haiku-5-5": "eu.anthropic.claude-haiku-5-5",
}
CLAUDE_TOOLS = ("report_scenes", "check_moment", "submit_review")


# --- config/models.json --------------------------------------------------------------------------------------------


def test_clip_models_come_from_models_json_with_their_profiles() -> None:
    path = REPO / "config" / "models.json"
    got = clip_models_from_models_json(path)
    assert got == CLIP_MODELS and list(got) == list(CLIP_MODELS)  # the file's order is the screen's order
    assert model_from_models_json(path) == "global.anthropic.claude-fable-5-1"  # the default is unchanged
    data = json.loads(path.read_text("utf-8"))
    assert profile_id(data, "haiku-5-5") == "eu.anthropic.claude-haiku-5-5"
    assert profile_id(data, "nope") is None
    cfg = load_config(
        {"CF_REGION": "eu-north-1", "CF_TABLE": "t", "CF_MEDIA_BUCKET": "b", "CF_CONFIG_DIR": str(REPO / "config")}
    )
    assert cfg.model_id == "global.anthropic.claude-fable-5-1" and cfg.default_model_key == "fable-5-1"
    assert cfg.clip_models == CLIP_MODELS


def test_clip_models_without_a_file_or_list(tmp_path: Path) -> None:
    assert clip_models_from_models_json(tmp_path / "missing.json") == {}
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"profilePrefix": "global", "models": {"a": {"modelId": "anthropic.a"}}}))
    assert clip_models_from_models_json(path) == {}
    path.write_text(
        json.dumps({"clipModels": ["a", "gone", 3], "profilePrefix": "global", "models": {"a": {"modelId": "x.a"}}})
    )
    assert clip_models_from_models_json(path) == {"a": "global.x.a"}


# --- what counts as "this model is not available" ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "message", "unavailable"),
    [
        ("AccessDeniedException", "You don't have access to the model with the specified model ID.", True),
        ("ResourceNotFoundException", "Model not found.", True),
        ("ValidationException", "The provided model identifier is invalid.", True),
        ("ValidationException", "Invocation of model ID x with on-demand throughput isn't supported.", True),
        ("ValidationException", "The inference profile is not available in this Region.", True),
        ("ValidationException", "This model is not enabled for your account.", True),
        ("ValidationException", "tool_choice: type tool is not supported for this model.", False),
        ("ValidationException", "cachePoint is not supported for this model.", False),
        ("ValidationException", "Too many images for this model.", False),
        ("ValidationException", "messages: text content blocks must be non-empty", False),
        ("ThrottlingException", "Too many requests, please wait.", False),
        ("ServiceUnavailableException", "The model is not available right now.", False),
    ],
)
def test_model_unavailable(code: str, message: str, unavailable: bool) -> None:
    assert model_unavailable(client_error(code, message)) is unavailable


def test_model_unavailable_ignores_errors_without_a_response() -> None:
    assert model_unavailable(TimeoutError("slow")) is False


# --- a whole job with the owner's pick ------------------------------------------------------------------------------


class Choice:
    """A World whose owner picked ``pick``. ``clients`` holds one fake bedrock-runtime per model id; the default
    model's client is ``default``."""

    def __init__(self, world: World, pick: Any, refuse: set[str] | None = None) -> None:
        self.world = world
        self.made: list[str] = []
        self.refuse = refuse or set()
        self.clients: dict[str, ToolClient] = {}
        self.default = self._fake(world.cfg.model_id)
        world.cfg = type(world.cfg)(
            **{**world.cfg.__dict__, "default_model_key": "fable-5-1", "clip_models": dict(CLIP_MODELS)}
        )
        self.found: list[dict[str, Any]] = []
        settings = {"maxSourceHours": 6} if pick is None else {"maxSourceHours": 6, "clipModel": pick}

        async def get_settings(user_id: str) -> dict[str, Any]:
            return dict(settings)

        world.store.get_settings = get_settings  # type: ignore[method-assign]

    def _fake(self, model_id: str) -> ToolClient:
        def ready(kw: dict[str, Any]) -> dict[str, Any]:
            if model_id in self.refuse:
                raise client_error(
                    "AccessDeniedException", "You don't have access to the model with the specified model ID."
                )
            return {"ok": True}

        handlers = {**self.world.fable.handlers, "ready": ready}
        client = self.clients[model_id] = ToolClient(handlers)
        return client

    def bedrock(self, model_id: str) -> Bedrock:
        client = self.clients.get(model_id) or self._fake(model_id)
        b = Bedrock(model_id, "eu-north-1", client=client)
        b.forced_tool_choice = False
        return b

    def new_bedrock(self, model_id: str) -> Bedrock:
        self.made.append(model_id)
        return self.bedrock(model_id)

    def pipeline(self) -> Pipeline:
        w = self.world
        watcher = Bedrock("eu.amazon.nova-2-lite-v1:0", "eu-north-1", client=w.nova, cache_points=False)
        watcher.forced_tool_choice = False
        return Pipeline(
            w.cfg,
            w.store,  # type: ignore[arg-type]
            self.bedrock(w.cfg.model_id),
            w.transcriber,  # type: ignore[arg-type]
            watch_bedrock=watcher,
            new_bedrock=self.new_bedrock,
        )

    def patch_finder(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from clipfactory_agent import pipeline as pipeline_mod

        finder = pipeline_mod.find_moments

        async def find_moments(b: Any, **kw: Any) -> Any:
            self.found.append({"model_id": kw["model_id"], "bedrock": kw["bedrock"].model_id})
            return await finder(b, **kw)

        monkeypatch.setattr(pipeline_mod, "find_moments", find_moments)

    def tools(self, model_id: str) -> list[str]:
        client = self.clients.get(model_id)
        return [r["toolConfig"]["tools"][0]["toolSpec"]["name"] for r in client.requests] if client else []


async def run(choice: Choice) -> tuple[str, Any, dict[str, Any]]:
    from clipfactory_agent.jobs import Tracker, run_job
    from clipfactory_agent.pipeline import JobState

    w = choice.world
    pipe = choice.pipeline()
    st = JobState(job_id="J", user_id="u", workdir=w.tmp / "work" / "J")
    tr = Tracker(w.store, "u", "J", heartbeat=5, flush=5)  # type: ignore[arg-type]
    try:
        status = await run_job(tr, pipe.steps(st, tr), clip_count=lambda: len(st.candidates))
    finally:
        await pipe.close(st)
    return status, st, {s["key"]: s for s in tr.steps}


def model_writes(world: World) -> list[dict[str, Any]]:
    return [{k: v for k, v in w.items() if k in ("model", "modelWanted")} for w in world.store.writes if "model" in w]


async def test_no_pick_runs_the_default_model_without_a_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    w = World(tmp_path, monkeypatch)
    c = Choice(w, None)
    c.patch_finder(monkeypatch)
    status, st, steps = await run(c)
    assert_ready(status, steps)
    assert (st.model_key, st.model_id, st.model_wanted) == ("fable-5-1", "global.anthropic.claude-fable-5-1", None)
    assert c.made == []  # no new client for the default
    assert "ready" not in c.tools(w.cfg.model_id)  # the default model is never probed
    assert set(CLAUDE_TOOLS) <= set(c.tools(w.cfg.model_id))
    assert model_writes(w) == [{"model": "fable-5-1"}]
    assert c.found == [
        {"model_id": "global.anthropic.claude-fable-5-1", "bedrock": "global.anthropic.claude-fable-5-1"}
    ]
    assert '"model.chosen"' in capsys.readouterr().out


@pytest.mark.parametrize("pick", ["fable-5-2", "opus-5-5", "sonnet-5-5", "haiku-5-5"])
async def test_every_claude_step_uses_the_picked_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pick: str
) -> None:
    w = World(tmp_path, monkeypatch)
    c = Choice(w, pick)
    c.patch_finder(monkeypatch)
    status, st, steps = await run(c)
    assert_ready(status, steps)
    want = CLIP_MODELS[pick]
    assert (st.model_key, st.model_id, st.model_wanted) == (pick, want, None)
    assert c.made == [want]
    # The watcher, the second look and the review all went to the picked model; the default got nothing.
    tools = c.tools(want)
    assert tools.count("ready") == 1 and set(CLAUDE_TOOLS) <= set(tools)
    assert c.tools(w.cfg.model_id) == []
    # The finder (Agent SDK and Converse) got the picked model too.
    assert c.found == [{"model_id": want, "bedrock": want}]
    # Nova, the second watcher, is not the owner's pick.
    assert w.nova.requests and all(r["modelId"] == "eu.amazon.nova-2-lite-v1:0" for r in w.nova.requests)
    # No request carries a thinking budget, disabled thinking or sampling settings.
    for r in c.clients[want].requests:
        assert set(r["inferenceConfig"]) == {"maxTokens"}
        assert "additionalModelRequestFields" not in r
    assert model_writes(w) == [{"model": pick}]


async def test_a_refused_pick_falls_back_to_the_default_for_the_whole_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    w = World(tmp_path, monkeypatch)
    c = Choice(w, "fable-5-2", refuse={"global.anthropic.claude-fable-5-2"})
    c.patch_finder(monkeypatch)
    status, st, steps = await run(c)
    assert_ready(status, steps)
    assert (st.model_key, st.model_id, st.model_wanted) == (
        "fable-5-1",
        "global.anthropic.claude-fable-5-1",
        "fable-5-2",
    )
    assert c.tools("global.anthropic.claude-fable-5-2") == ["ready"]  # refused on its first call, never used again
    assert set(CLAUDE_TOOLS) <= set(c.tools(w.cfg.model_id))
    assert c.found == [{"model_id": w.cfg.model_id, "bedrock": w.cfg.model_id}]
    assert model_writes(w) == [{"model": "fable-5-2"}, {"model": "fable-5-1", "modelWanted": "fable-5-2"}]
    out = capsys.readouterr().out
    fallback = [json.loads(line) for line in out.splitlines() if '"model.fallback"' in line]
    assert len(fallback) == 1 and fallback[0]["wanted"] == "fable-5-2" and fallback[0]["using"] == "fable-5-1"


async def test_a_busy_probe_keeps_the_pick(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Only "not available" gives the pick up: a probe that fails for another reason keeps the owner's model."""
    w = World(tmp_path, monkeypatch)
    c = Choice(w, "opus-5-5")
    client = c._fake(CLIP_MODELS["opus-5-5"])
    client.handlers["ready"] = lambda kw: (_ for _ in ()).throw(client_error("ValidationException", "bad input"))
    status, st, steps = await run(c)
    assert_ready(status, steps)
    assert st.model_key == "opus-5-5" and st.model_wanted is None
    assert c.tools(w.cfg.model_id) == []


@pytest.mark.parametrize("pick", ["gpt-9", "nova-2-lite", "", 7])
async def test_an_unknown_pick_uses_the_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, pick: Any) -> None:
    w = World(tmp_path, monkeypatch)
    c = Choice(w, pick)
    status, st, steps = await run(c)
    assert_ready(status, steps)
    assert (st.model_key, st.model_wanted) == ("fable-5-1", None)
    assert c.made == [] and model_writes(w) == [{"model": "fable-5-1"}]


def test_one_client_per_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_agent.pipeline import JobState

    w = World(tmp_path, monkeypatch)
    c = Choice(w, "opus-5-5")
    pipe = c.pipeline()
    clients = []
    for pick in ("opus-5-5", "sonnet-5-5", "opus-5-5", "fable-5-1"):
        st = JobState(job_id="J", user_id="u", workdir=tmp_path)
        st.settings = {"clipModel": pick}
        pipe.pick_model(st)
        clients.append(pipe.claude(st))
    assert c.made == [CLIP_MODELS["opus-5-5"], CLIP_MODELS["sonnet-5-5"]]
    assert clients[0] is clients[2] and clients[3] is pipe.bedrock
