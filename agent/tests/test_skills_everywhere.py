"""Every model call gets the owner's skills block first in its system prompt (docs/CONTRACTS.md §18.6).

Two kinds of checks: a code scan that fails when a model call skips the helpers (so a future call cannot forget the
skills), and fake-client runs of each call site that look at the real requests.

The scan is as strict as the API's (api/tests/test_skills_everywhere.py): model method names may not appear as strings,
getattr / attrgetter / methodcaller may only take a plain string name, and converse / structured / detect_layout /
sdk_options / the SDK's query may only be called in place (functools.partial(..., skills=) is the one allowed wrapper),
so an alias cannot hide a call without skills=."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from clipfactory_agent import agent as agent_mod
from clipfactory_agent import captions as captions_mod
from clipfactory_agent.bedrock import Bedrock, ModelError
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.pipeline import JobState, Pipeline
from clipfactory_agent.render import RenderResult
from clipfactory_agent.skills import SkillDoc, skills_block

from .conftest import make_moment
from .test_agent import brief

SRC = Path(__file__).resolve().parents[1] / "src" / "clipfactory_agent"
RAW_CALLS = {"invoke_model", "converse_stream", "invoke_model_with_response_stream"}
# Titan embeddings are not text generation: vectors.py may use invoke_model, but only with the embed model id.
EMBED_FILE, EMBED_MODEL_ATTR = "vectors.py", "embed_model_id"
MODEL_METHOD_NAMES = {"converse", "_converse", *RAW_CALLS}  # also caught as getattr(x, "converse")
# Bedrock's private senders: only these methods may touch them (anything else must go through structured(skills=)).
PRIVATE_SENDERS = {"_call", "_converse"}
SENDER_USERS = {("bedrock.py", f"Bedrock.{m}") for m in ("structured", "_call", "_converse")}
SDK_MODULE = "claude_agent_sdk"
SDK_FORBIDDEN = {"ClaudeSDKClient"}  # a second way into the Agent SDK; none is allowed today
# Same strength as api/tests/test_skills_everywhere.py: a lookup by a computed name could reach any model call.
DYNAMIC_LOOKUPS = {"getattr", "attrgetter", "methodcaller"}
# Methods that must always be called in place, so every call is seen with its skills= (an alias would hide it).
# functools.partial(<method>, skills=...) is the one allowed way to pass detect_layout/structured around.
CALL_ONLY_METHODS = {"converse", "structured", "detect_layout"}
CALL_ONLY_FUNCS = {"sdk_options"}  # plus query, when imported from the Agent SDK


class _Scan(ast.NodeVisitor):
    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.scope: list[str] = []
        self.problems: list[str] = []
        self.sdk_options_vars: dict[str, set[str]] = {}  # function -> names bound to sdk_options(..., skills=...)
        self.embed_ok: set[int] = set()  # ids of invoke_model nodes passed with modelId=<...>.embed_model_id
        self.called: set[int] = set()  # ids of nodes that are a call's func (or partial(<it>, skills=...))
        self.sdk_query = False  # this file imports query from the Agent SDK

    def _where(self, node: ast.AST) -> str:
        return f"{self.filename}:{getattr(node, 'lineno', '?')}"

    def _visit_scope(self, node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_ClassDef = _visit_scope
    visit_FunctionDef = _visit_scope
    visit_AsyncFunctionDef = _visit_scope

    def _function(self) -> str:
        return ".".join(self.scope)

    def visit_Assign(self, node: ast.Assign) -> None:
        v = node.value
        if (
            isinstance(v, ast.Call)
            and isinstance(v.func, ast.Name)
            and v.func.id == "sdk_options"
            and any(k.arg == "skills" for k in v.keywords)
        ):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    self.sdk_options_vars.setdefault(self._function(), set()).add(t.id)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            if a.name == SDK_MODULE or a.name.startswith(SDK_MODULE + "."):
                self.problems.append(f"{self._where(node)}: import {a.name} (use from-imports so the scan sees query)")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module and (node.module == SDK_MODULE or node.module.startswith(SDK_MODULE + ".")):
            for a in node.names:
                if a.name == "query":
                    self.sdk_query = True
                if a.name == "*" or (a.name == "query" and a.asname and a.asname != "query"):
                    self.problems.append(f"{self._where(node)}: {SDK_MODULE} {a.name} imported under another name")
                if a.name in SDK_FORBIDDEN:
                    self.problems.append(f"{self._where(node)}: {a.name} outside the allow-list")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in SDK_FORBIDDEN:
            self.problems.append(f"{self._where(node)}: {node.id} outside the allow-list")
        call_only = node.id in CALL_ONLY_FUNCS or (node.id == "query" and self.sdk_query)
        if call_only and isinstance(node.ctx, ast.Load) and id(node) not in self.called:
            self.problems.append(f"{self._where(node)}: {node.id} used without calling it (an alias hides skills=)")
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and node.value in MODEL_METHOD_NAMES:
            self.problems.append(f"{self._where(node)}: the string {node.value!r} (a dynamic call could use it)")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in RAW_CALLS and id(node) not in self.embed_ok:
            self.problems.append(f"{self._where(node)}: {node.attr} outside the allow-list")
        if node.attr in SDK_FORBIDDEN:
            self.problems.append(f"{self._where(node)}: {node.attr} outside the allow-list")
        if node.attr in CALL_ONLY_METHODS and id(node) not in self.called:
            self.problems.append(f"{self._where(node)}: {node.attr} used without calling it (an alias hides skills=)")
        if node.attr in PRIVATE_SENDERS and (self.filename, self._function()) not in SENDER_USERS:
            # store.py and vectors.py have their own self._call helpers (not model calls); anything else reaching a
            # _call/_converse (self.bedrock._call, b._converse, Bedrock's own new methods) skips structured(skills=).
            own_helper = (
                self.filename != "bedrock.py"
                and node.attr == "_call"
                and isinstance(node.value, ast.Name)
                and node.value.id == "self"
            )
            if not own_helper:
                self.problems.append(f"{self._where(node)}: {node.attr} outside Bedrock.structured")
        self.generic_visit(node)

    def _mark_embed_calls(self, node: ast.Call) -> None:
        """In vectors.py, an invoke_model (called or passed to a helper) is fine only with modelId=<x>.embed_model_id."""
        if self.filename != EMBED_FILE:
            return
        model = next((k.value for k in node.keywords if k.arg == "modelId"), None)
        if not (isinstance(model, ast.Attribute) and model.attr == EMBED_MODEL_ATTR):
            return
        for n in [node.func, *node.args, *(k.value for k in node.keywords)]:
            if isinstance(n, ast.Attribute) and n.attr == "invoke_model":
                self.embed_ok.add(id(n))

    def visit_Call(self, node: ast.Call) -> None:
        f = node.func
        name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
        keywords = {k.arg for k in node.keywords}
        here = (self.filename, self._function())
        self._mark_embed_calls(node)
        self.called.add(id(f))
        if name == "partial" and node.args and "skills" in keywords:
            self.called.add(id(node.args[0]))  # functools.partial(b.detect_layout, skills=...) keeps the skills
        if (
            name == "getattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value in MODEL_METHOD_NAMES
        ):
            self.problems.append(f"{self._where(node)}: getattr(..., {node.args[1].value!r}) hides a model call")
        if name in DYNAMIC_LOOKUPS:
            names = node.args[1:2] if name == "getattr" else node.args[:1]
            if any(not (isinstance(a, ast.Constant) and isinstance(a.value, str)) for a in names):
                self.problems.append(f"{self._where(node)}: {name} with a computed name (the scan cannot check it)")
        if isinstance(f, ast.Attribute) and name == "converse" and here != ("bedrock.py", "Bedrock._converse"):
            self.problems.append(f"{self._where(node)}: .converse( outside Bedrock._converse")
        if isinstance(f, ast.Attribute) and name == "structured" and "skills" not in keywords:
            self.problems.append(f"{self._where(node)}: .structured( without skills=")
        if name == "detect_layout" and isinstance(f, ast.Attribute) and "skills" not in keywords:
            self.problems.append(f"{self._where(node)}: detect_layout( without skills=")
        if isinstance(f, ast.Name) and name == "query":
            if (self.filename, self._function()) != ("agent.py", "find_with_sdk"):
                self.problems.append(f"{self._where(node)}: query( outside agent.find_with_sdk")
            opts = next((k.value for k in node.keywords if k.arg == "options"), None)
            ok = isinstance(opts, ast.Name) and opts.id in self.sdk_options_vars.get(self._function(), set())
            if not ok:
                self.problems.append(f"{self._where(node)}: query( options not built by sdk_options(..., skills=)")
        if name == "sdk_options" and isinstance(f, ast.Name) and "skills" not in keywords:
            self.problems.append(f"{self._where(node)}: sdk_options( without skills=")
        self.generic_visit(node)


def scan(filename: str, source: str) -> list[str]:
    s = _Scan(filename)
    s.visit(ast.parse(source))
    return s.problems


def test_no_model_call_skips_the_skills() -> None:
    problems: list[str] = []
    files = sorted(SRC.rglob("*.py"))
    assert files
    for path in files:
        problems += scan(path.relative_to(SRC).as_posix(), path.read_text("utf-8"))
    assert problems == []


@pytest.mark.parametrize(
    ("filename", "source", "why"),
    [
        ("pipeline.py", "def f(c):\n    c.converse(modelId='m')\n", ".converse( outside"),
        ("bedrock.py", "class Bedrock:\n    def other(self):\n        self.client.converse()\n", ".converse( outside"),
        ("captions.py", "async def f(b):\n    await b.structured(system='s')\n", "without skills="),
        ("render.py", "async def f(b):\n    await b.detect_layout(1, 2, 3)\n", "without skills="),
        ("pipeline.py", "def f(c):\n    c.invoke_model(body='x')\n", "invoke_model outside"),
        ("vectors.py", "def f(c):\n    c.converse_stream()\n", "converse_stream outside"),
        ("pipeline.py", "async def f(o):\n    query(prompt=1, options=o)\n", "query( outside"),
        (
            "agent.py",
            "async def find_with_sdk(b):\n    o = sdk_options(b)\n    query(prompt=1, options=o)\n",
            "sdk_options( without skills=",
        ),
        # a new Bedrock method that builds its own system prompt and sends it through _call
        (
            "bedrock.py",
            "class Bedrock:\n    async def summarize(self, t):\n"
            "        return await self._call({'modelId': 'm', 'system': [{'text': 'x'}], 'messages': []})\n",
            "_call outside Bedrock.structured",
        ),
        ("pipeline.py", "async def f(self):\n    await self.bedrock._call({'modelId': 'm'})\n", "_call outside"),
        ("captions.py", "def f(b):\n    b._converse({'modelId': 'm'})\n", "_converse outside"),
        (
            "agent.py",
            "from claude_agent_sdk import query as run\nasync def f(o):\n    run(prompt=1, options=o)\n",
            "imported under another name",
        ),
        (
            "agent.py",
            "from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions\n"
            "async def f():\n    c = ClaudeSDKClient(options=ClaudeAgentOptions(system_prompt='x'))\n"
            "    await c.query('hi')\n",
            "ClaudeSDKClient outside",
        ),
        ("agent.py", "import claude_agent_sdk as s\nasync def f(o):\n    s.query(prompt=1, options=o)\n", "import"),
        (
            "vectors.py",
            "def f(c, body):\n    c.invoke_model(modelId='global.anthropic.claude-x', body=body)\n",
            "invoke_model outside",
        ),
        (
            "vectors.py",
            "async def f(self, body):\n    await self._call('x', self.bedrock.invoke_model, modelId='claude', body=body)\n",
            "invoke_model outside",
        ),
        ("pipeline.py", "def f(c):\n    getattr(c, 'converse')(modelId='m')\n", "getattr(..., 'converse')"),
        ("pipeline.py", "def f(c, n):\n    getattr(c, n)(modelId='m')\n", "computed name"),
        ("pipeline.py", "import operator\ndef f(c, n):\n    operator.methodcaller(n)(c)\n", "computed name"),
        ("pipeline.py", "from operator import attrgetter\ndef f(c, n):\n    attrgetter(n)(c)()\n", "computed name"),
        ("pipeline.py", "import operator\ndef f(c):\n    operator.methodcaller('converse')(c)\n", "the string"),
        ("pipeline.py", "def f(c):\n    send = c.converse\n    send(modelId='m')\n", "converse used without"),
        ("captions.py", "async def f(b):\n    ask = b.structured\n    await ask(system='s')\n", "structured used"),
        ("render.py", "def f(b, run):\n    run(look=b.detect_layout)\n", "detect_layout used without"),
        (
            "agent.py",
            "from claude_agent_sdk import query\nasync def find_with_sdk(o):\n    run = query\n    run(prompt=1, options=o)\n",
            "query used without",
        ),
        ("agent.py", "def f(b):\n    build = sdk_options\n    return build(b)\n", "sdk_options used without"),
    ],
)
def test_the_scan_catches_a_bypass(filename: str, source: str, why: str) -> None:
    assert any(why in p for p in scan(filename, source))


def test_the_scan_allows_the_helpers() -> None:
    ok = (
        "async def find_with_sdk(b, s):\n    options = sdk_options(b, skills=s)\n    query(prompt=1, options=options)\n"
    )
    assert scan("agent.py", ok) == []
    titan = (
        "class V:\n    async def _call(self, what, fn, **kw):\n        return fn(**kw)\n"
        "    async def embed(self, body):\n"
        "        return await self._call('t', self.bedrock.invoke_model, modelId=self.embed_model_id, body=body)\n"
    )
    assert scan("vectors.py", titan) == []
    assert scan("store.py", "class S:\n    async def get(self):\n        return await self._call('ddb', 1)\n") == []
    bedrock_ok = (
        "class Bedrock:\n    def _converse(self, kw):\n        return self.client.converse(**kw)\n"
        "    async def _call(self, kw):\n        return self._converse(kw)\n"
        "    async def structured(self, *, skills):\n        return await self._call({})\n"
    )
    assert scan("bedrock.py", bedrock_ok) == []
    partial_ok = "import functools\ndef f(b, s):\n    return functools.partial(b.detect_layout, skills=s)\n"
    assert scan("pipeline.py", partial_ok) == []
    assert scan("pipeline.py", partial_ok.replace(", skills=s", "")) != []
    # a local variable called query is fine when the file does not import the Agent SDK's query
    assert scan("sources.py", "def f(u):\n    query = [1]\n    query.append(2)\n    return query\n") == []
    assert scan("store.py", "def f(e):\n    return getattr(e, 'response', None)\n") == []


# --- the real requests ----------------------------------------------------------------------------------------


class RecordingClient:
    """A bedrock-runtime stand-in that records every Converse request and never gives a usable answer."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.requests.append(kw)
        return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [{"text": "hm"}]}}}


def owner_block(size: int = 50) -> Any:
    return skills_block(
        [
            SkillDoc("playbook", "", "Built-in rules", True),
            SkillDoc("my-rules", "", "Always tag @me " + "z" * size, False),
        ]
    )


def assert_block_first(requests: list[dict[str, Any]], block: Any, task: str | None = None) -> None:
    assert requests
    for r in requests:
        system = r["system"]
        assert system[0]["text"] == block.text and system[0]["text"].startswith("<owner_skills")
        assert sum(str(part.get("text", "")).count("<owner_skills") for part in system) == 1
        for m in r["messages"]:
            for c in m["content"]:
                assert "<owner_skills" not in str(c.get("text", ""))
        if task is not None:
            assert system[-1]["text"].startswith(task)


async def test_moment_fallback_sends_the_block_first() -> None:
    client = RecordingClient()
    block = owner_block()
    found = await agent_mod.find_with_converse(brief(), Bedrock("m", "r", client=client), skills=block)
    assert found == []
    assert_block_first(client.requests, block, "You are the clip finder")


async def test_layout_check_sends_the_block_first() -> None:
    client = RecordingClient()
    block = owner_block()
    with pytest.raises(ModelError):
        await Bedrock("m", "r", client=client).detect_layout(b"jpeg", 1280, 720, skills=block)
    assert_block_first(client.requests, block, "You look at frames")


async def test_captions_send_the_block_first() -> None:
    client = RecordingClient()
    block = owner_block()
    out = await captions_mod.write_captions(
        Bedrock("m", "r", client=client),
        [captions_mod.ClipText("A", make_moment(), "no way")],
        notes="",
        skills=block,
        skills_text="Required tags: #mine",
        system="You write social captions for short clips.",
    )
    assert "#mine" in out["A"]["tiktok"]
    assert_block_first(client.requests, block, "You write social captions")


async def test_checklist_review_sends_the_block_first(tmp_path: Path) -> None:
    client = RecordingClient()
    block = owner_block()
    pipe = Pipeline(SimpleNamespace(), None, Bedrock("m", "r", client=client), None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path)
    st.skills_block = block
    r = RenderResult(tmp_path / "c.mp4", tmp_path / "c.jpg", 30.0, [(100, 130)], [], "full", False)
    review = await pipe._review(st, Candidate(make_moment(), r))
    assert review["verdict"] == "keep"  # no usable answer: the measured checks decide
    assert_block_first(client.requests, block, "You review short vertical clips")


async def test_a_long_block_gets_a_cache_point_until_bedrock_refuses_it() -> None:
    from botocore.exceptions import ClientError

    class Refuses(RecordingClient):
        def converse(self, **kw: Any) -> dict[str, Any]:
            if any("cachePoint" in part for part in kw["system"]):
                self.requests.append(kw)
                raise ClientError(
                    {"Error": {"Code": "ValidationException", "Message": "cachePoint is not supported here"}},
                    "Converse",
                )
            return super().converse(**kw)

    client = Refuses()
    block = owner_block(9_000)
    b = Bedrock("m", "r", client=client)
    with pytest.raises(ModelError):
        await b.detect_layout(b"jpeg", 1280, 720, skills=block)
    assert client.requests[0]["system"][1] == {"cachePoint": {"type": "default"}}
    assert b.cache_points is False
    # the refused request did not use up an answer: three more were sent, without the cache point
    assert len(client.requests) == 4
    assert all(len(r["system"]) == 2 for r in client.requests[1:])
    assert_block_first(client.requests, block)


async def test_job_state_refuses_a_model_call_before_analyze(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError):
        _ = JobState(job_id="J", user_id="u", workdir=tmp_path).block


async def test_analyze_builds_the_block_and_counts_skipped_skills(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    (builtin / "playbook").mkdir(parents=True)
    (builtin / "playbook" / "SKILL.md").write_text("---\nname: playbook\n---\nCore")

    class Store:
        async def exists(self, key: str) -> bool:
            return True

        async def get_json(self, key: str) -> Any:
            return [-40.0] * 10

        async def skill_rows(self, user_id: str) -> list[dict[str, Any]]:
            return [
                {"skillId": "1", "name": "mine", "type": "skill", "key": "k1", "enabled": False},
                {"skillId": "2", "name": "gone", "type": "skill", "key": "k2"},
            ]

        async def get_bytes(self, key: str) -> bytes:
            if key == "k2":
                raise FileNotFoundError(key)
            return b"---\nname: mine\n---\nMy rules"

        async def latest_learnings(self, user_id: str, n: int = 10) -> list[dict[str, Any]]:
            return []

    class Tracker:
        def report(self, f: float) -> None:
            pass

    pipe = Pipeline(SimpleNamespace(skills_dir=builtin), Store(), None, None)  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="u", workdir=tmp_path / "work")
    msg = await pipe.analyze(st, Tracker())  # type: ignore[arg-type]
    assert "using 2 skill(s); 1 could not be read" in msg
    assert st.block.counts["builtin"] == 1 and st.block.counts["owner"] == 1
    assert '<skill name="mine" source="owner">' in st.block.text


async def test_sdk_prompt_file_starts_with_the_block(tmp_path: Path) -> None:
    block = owner_block()
    b = brief()
    opts = agent_mod.sdk_options(
        b, agent_mod.MomentTools(b), model_id="m", region="r", workdir=tmp_path, skill_names=[], skills=block
    )
    text = Path(opts.system_prompt["path"]).read_text("utf-8")
    assert text.startswith(block.text + "\n\nYou are the clip finder")
    assert text.count("<owner_skills") == 1
