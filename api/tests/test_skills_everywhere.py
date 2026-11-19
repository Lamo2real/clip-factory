"""No model call may skip the skills block (docs/CONTRACTS.md §18.6).

Every ``src/**/*.py`` file is parsed and ``problems`` lists each way around the shared helper:

- ``.converse`` may only be used as a call inside ``learn.converse_text``;
- every ``converse_text(`` call must pass ``skills=``;
- ``invoke_model`` (Titan embeddings) may only be called in ``vectors.py`` with ``modelId=self.embed_model_id``;
- ``converse_stream`` / ``invoke_model_with_response_stream`` may not appear at all;
- none of these names may appear as a string (``getattr(bedrock, "converse")`` and the like);
- ``getattr`` / ``operator.attrgetter`` / ``operator.methodcaller`` may only take a plain string name, never a computed
  one (``getattr(bedrock, "con" + "verse")``);
- ``converse_text`` may only be called, never passed around or aliased (so every call is seen with its ``skills=``);
- ``.messages.stream(`` (the Messages API on Claude in Amazon Bedrock, Ask §28) may only be called inside
  ``learn.stream_messages``, every ``stream_messages(`` call must pass ``skills=``, and ``messages.create`` is not used.

A future model call therefore has to go through the helper. The bypass tests below prove the scan fails on each one.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "clipfactory_api"
STREAMING = {"converse_stream", "invoke_model_with_response_stream"}
MODEL_CALLS = {"converse", "invoke_model"} | STREAMING
DYNAMIC_LOOKUPS = {"getattr", "attrgetter", "methodcaller"}
HELPERS = {"converse_text", "stream_messages"}


def _is_embed_model(call: ast.Call) -> bool:
    for k in call.keywords:
        if k.arg == "modelId":
            v = k.value
            return (
                isinstance(v, ast.Attribute)
                and v.attr == "embed_model_id"
                and isinstance(v.value, ast.Name)
                and v.value.id == "self"
            )
    return False


def _called_name(call: ast.Call) -> str:
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    if isinstance(call.func, ast.Name):
        return call.func.id
    return ""


def _file_problems(rel: str, tree: ast.AST) -> list[str]:
    out: list[str] = []

    def visit(node: ast.AST, func: str, callee_of: ast.Call | None) -> None:
        """``func`` is the outermost enclosing function; ``callee_of`` is set when ``node`` is a call's func."""
        where = f"{rel}:{getattr(node, 'lineno', 0)}"
        if isinstance(node, ast.Attribute) and node.attr in MODEL_CALLS:
            attr = node.attr
            if attr in STREAMING:
                out.append(f"{where} streaming model call {attr}")
            elif callee_of is None:
                out.append(f"{where} {attr} used without calling it (an alias would bypass the skills block)")
            elif attr == "converse" and (rel, func) != ("learn.py", "converse_text"):
                out.append(f"{where} .converse( outside learn.converse_text")
            elif attr == "invoke_model" and not (rel == "vectors.py" and _is_embed_model(callee_of)):
                out.append(f"{where} invoke_model that is not the Titan embedding call in vectors.py")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in MODEL_CALLS:
            out.append(f"{where} the string {node.value!r} (getattr or a dynamic call would bypass the skills block)")
        if isinstance(node, ast.Call) and _called_name(node) in DYNAMIC_LOOKUPS:
            names = node.args[1:2] if _called_name(node) == "getattr" else node.args[:1]
            if any(not (isinstance(a, ast.Constant) and isinstance(a.value, str)) for a in names):
                out.append(f"{where} {_called_name(node)} with a computed name (it could reach a model call)")
        if isinstance(node, ast.Name) and node.id == "converse_text" and callee_of is None:
            out.append(f"{where} converse_text used without calling it (an alias would hide a missing skills=)")
        is_helper_call = isinstance(node, ast.Call) and _called_name(node) in HELPERS
        if is_helper_call and not any(k.arg == "skills" for k in getattr(node, "keywords", [])):
            out.append(f"{where} {_called_name(node)}( without skills=")
        if isinstance(node, ast.Name) and node.id == "stream_messages" and callee_of is None:
            out.append(f"{where} stream_messages used without calling it (an alias would hide a missing skills=)")
        if (
            isinstance(node, ast.Attribute)
            and node.attr in {"stream", "create"}
            and isinstance(node.value, ast.Attribute)
            and node.value.attr == "messages"
            and not (node.attr == "stream" and callee_of is not None and (rel, func) == ("learn.py", "stream_messages"))
        ):
            out.append(f"{where} .messages.{node.attr} outside learn.stream_messages")
        for child in ast.iter_child_nodes(node):
            is_def = isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef)
            name = child.name if is_def and not func else func
            visit(child, name, node if isinstance(node, ast.Call) and child is node.func else None)

    visit(tree, "", None)
    return out


def problems(src_dir: Path) -> list[str]:
    """Every model call in ``src_dir`` that could skip the skills block (empty when the package is clean)."""
    out: list[str] = []
    for path in sorted(src_dir.rglob("*.py")):
        rel = path.relative_to(src_dir).as_posix()
        out += _file_problems(rel, ast.parse(path.read_text(), filename=rel))
    return out


def test_no_model_call_skips_the_skills_block() -> None:
    assert problems(SRC) == []


def test_the_stream_helper_is_really_used() -> None:
    calls = [
        n
        for p in SRC.rglob("*.py")
        for n in ast.walk(ast.parse(p.read_text()))
        if isinstance(n, ast.Call) and _called_name(n) == "stream_messages"
    ]
    assert calls, "learn.stream_messages is Ask's one Messages API helper"


def test_the_helper_is_really_used() -> None:
    calls = [
        n
        for p in SRC.rglob("*.py")
        for n in ast.walk(ast.parse(p.read_text()))
        if isinstance(n, ast.Call) and _called_name(n) == "converse_text"
    ]
    assert calls, "converse_text is the API's one model call helper"


CLEAN_LEARN = (
    "def converse_text(bedrock, *, skills):\n"
    "    return bedrock.converse(modelId='m', messages=[])\n"
    "def distil(b, block):\n"
    "    return converse_text(b, skills=block)\n"
)
CLEAN_VECTORS = (
    "class V:\n"
    "    def embed(self, text):\n"
    "        return self._bedrock.invoke_model(modelId=self.embed_model_id, body=text)\n"
)


def _write_package(root: Path, extra: dict[str, str]) -> Path:
    files = {"learn.py": CLEAN_LEARN, "vectors.py": CLEAN_VECTORS, **extra}
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    return root


def test_a_clean_sample_has_no_problems(tmp_path: Path) -> None:
    assert problems(_write_package(tmp_path, {})) == []


@pytest.mark.parametrize(
    ("files", "expected"),
    [
        ({"weekly.py": "def ask(b):\n    return b.converse(modelId='m', messages=[])\n"}, "outside learn"),
        ({"weekly.py": "def ask(b):\n    return converse_text(b)\n"}, "without skills="),
        (
            {"ask/worker.py": "def go(c):\n    return c.beta.messages.stream(model='m')\n"},
            "outside learn.stream_messages",
        ),
        ({"ask/worker.py": "def go(c):\n    return c.messages.create(model='m')\n"}, "outside learn.stream_messages"),
        ({"ask/worker.py": "def go(c):\n    return stream_messages(c, model='m')\n"}, "without skills="),
        ({"weekly.py": "def ask(b):\n    send = getattr(b, 'converse')\n    return send()\n"}, "'converse'"),
        ({"weekly.py": "def ask(b):\n    send = b.converse\n    return send(modelId='m')\n"}, "without calling"),
        (
            {"vectors.py": CLEAN_VECTORS + "def claude(b, t):\n    return b.invoke_model(modelId='claude', body=t)\n"},
            "not the Titan",
        ),
        ({"weekly.py": "def ask(b):\n    return b.invoke_model(modelId='claude', body='x')\n"}, "not the Titan"),
        ({"weekly.py": "def ask(b):\n    return b.converse_stream(modelId='m')\n"}, "streaming"),
        ({"weekly.py": "def ask(b):\n    return getattr(b, 'invoke_model_with_response_stream')()\n"}, "string"),
        ({"flows/x.py": "class A:\n    def go(self, b):\n        return b.converse()\n"}, "outside learn"),
        ({"weekly.py": "def ask(b):\n    return getattr(b, 'con' + 'verse')()\n"}, "computed name"),
        ({"weekly.py": "def ask(b, name):\n    return getattr(b, name)(modelId='m')\n"}, "computed name"),
        ({"weekly.py": "import operator\ndef ask(b, n):\n    return operator.methodcaller(n)(b)\n"}, "computed name"),
        ({"weekly.py": "def ask(b):\n    send = converse_text\n    return send(b)\n"}, "converse_text used without"),
    ],
)
def test_the_scan_catches_each_bypass(tmp_path: Path, files: dict[str, str], expected: str) -> None:
    found = problems(_write_package(tmp_path, files))
    assert found, files
    assert any(expected in p for p in found), found


def test_the_help_call_is_scanned_like_every_other() -> None:
    """Ask Clip Factory (§19.5) has no exception: its one model call is a ``converse_text`` call with ``skills=``."""
    path = SRC / "help" / "model.py"
    tree = ast.parse(path.read_text())
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _called_name(n) == "converse_text"]
    assert len(calls) == 1
    assert any(k.arg == "skills" for k in calls[0].keywords)
    assert _file_problems("help/model.py", tree) == []
    # Swapping the helper for a direct Bedrock call in the help module is caught.
    bypass = path.read_text().replace("converse_text(\n            bedrock,", "bedrock.converse(\n            bedrock,")
    assert any("outside learn.converse_text" in p for p in _file_problems("help/model.py", ast.parse(bypass)))
