"""Shared bits for the Ask Clip Factory tests (§19): the fixture corpus, a fake Haiku and a fake web server."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "help"
FIXTURE_CORPUS = FIXTURES / "corpus.json"
FIXTURE_EVALS = FIXTURES / "evals.json"
REPO = Path(__file__).resolve().parents[2]
WEB_HELP = REPO / "web" / "src" / "features" / "help"
WEB_CORPUS = WEB_HELP / "help-corpus.json"
WEB_EVALS = WEB_HELP / "helpEvals.json"
MODEL_ID = "eu.anthropic.claude-haiku-5-5"


def reset_help_caches() -> None:
    """The warm-Lambda caches (corpus, switch, skill files, cache points) start empty in every test."""
    from clipfactory_api import skill_prompt
    from clipfactory_api.help import corpus, guard

    corpus._CACHE = corpus.CorpusCache()
    corpus._bundled.clear()
    guard._SWITCH = guard.SwitchCache()
    skill_prompt.FILE_CACHE.clear()
    skill_prompt.reset_cache_points()


def fixture_corpus() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(FIXTURE_CORPUS.read_text())
    return data


def eval_cases(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text())
    cases = data["cases"] if isinstance(data, dict) else data
    assert isinstance(cases, list)
    # Like web/test/helpRetrieve.test.ts: a case without its own context runs with the file's defaultContext.
    default = data.get("defaultContext") if isinstance(data, dict) else None
    if default:
        cases = [c if c.get("context") else {**c, "context": dict(default)} for c in cases]
    return cases


def model_json(**fields: Any) -> str:
    base: dict[str, Any] = {"known": True, "text": "", "steps": [], "actionIds": [], "sourceIds": []}
    base.update(fields)
    return json.dumps(base)


class FakeHaiku:
    """Answers Converse like Claude Haiku 5.5 with JSON-schema output (thinking disabled: text only)."""

    def __init__(self, text: str = "", stop_reason: str = "end_turn") -> None:
        self.text = text
        self.stop_reason = stop_reason
        self.calls: list[dict[str, Any]] = []
        self.error: BaseException | None = None

    def converse(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.error is not None:
            raise self.error
        return {
            "output": {"message": {"role": "assistant", "content": [{"text": self.text}]}},
            "stopReason": self.stop_reason,
            "usage": {"inputTokens": 900, "outputTokens": 120},
        }


def throttled() -> ClientError:
    return ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow"}}, "Converse")


class FakeWeb:
    """``Fetcher`` over a dict of url → body (bytes) or exception."""

    def __init__(self, pages: dict[str, Any]) -> None:
        self.pages = pages
        self.urls: list[str] = []

    def __call__(self, url: str, timeout: float, max_bytes: int) -> bytes:
        self.urls.append(url)
        assert timeout <= 3
        page = self.pages.get(url)
        if page is None:
            raise OSError("404")
        if isinstance(page, BaseException):
            raise page
        if len(page) > max_bytes:
            raise ValueError("too large")
        return bytes(page)
