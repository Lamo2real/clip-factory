"""The shared eval file runs through the Python retriever (§19.11).

``web/src/features/help/helpEvals.json`` and the committed ``help-corpus.json`` are the shared contract: when the
web build has written them, every case must hit its expected top doc here exactly as in ``retrieve.test.ts``. The
api keeps its own cases over a stand-in corpus (``tests/fixtures/help``) so the retriever is tested before the web
files exist and offline in any checkout.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from clipfactory_api.help import corpus, retrieve
from help_support import FIXTURE_CORPUS, FIXTURE_EVALS, WEB_CORPUS, WEB_EVALS, eval_cases

REQUIRED = {
    "How do I make clips from a Twitch link?",
    "Where do I change my click sound?",
    "Why is my clip private on TikTok?",
    "How do I connect Instagram?",
    "How many views did my best clip get this week?",
    "How do I add a skill?",
    "What does Keep do?",
    "make clips from youtube",
    "paste a kick link",
    "upload my own video",
    "where is my job",
    "my job failed",
    "delete a clip",
    "undo throw away",
    "change the tiktok caption",
    "see views for a clip",
    "refresh the stats",
    "star the best clips",
    "how many clips are waiting?",
    "is anything running?",
    "connect youtube",
    "connect tik tok",
    "post to X",
    "does X cost money",
    "turn off sounds",
    "change error sound",
    "make it calmer",
    "change background",
    "download for mac",
    "add to home screen",
    "update the app",
    "youtube says sign in to confirm",
    "make more clips each time",
    "what is a skill",
    "turn off a skill",
    "sign out",
    "and the error sound?",
    "instagarm connect",
    "what's the weather",
    "write my homework",
    "what is my password",
    "show me another user's clips",
    "give me the api key",
}


def _outcome(loaded: corpus.Corpus, case: dict[str, Any]) -> str:
    ctx = retrieve.HelpContext(**case["context"]) if case.get("context") else None
    ranked = retrieve.rank(
        loaded.docs, case["q"], case.get("history"), ctx, synonyms=loaded.synonyms, stopwords=loaded.stopwords
    )
    top = ranked.top
    return top["id"] if ranked.status == "answer" and top is not None else ranked.status


def _check(corpus_file: Path, evals_file: Path) -> list[str]:
    loaded = corpus.parse(corpus_file.read_bytes())
    failures = []
    for case in eval_cases(evals_file):
        got = _outcome(loaded, case)
        if got != case["expect"]:
            failures.append(f"{case['q']!r}: expected {case['expect']}, got {got}")
    return failures


def test_fixture_evals_cover_the_required_questions() -> None:
    cases = eval_cases(FIXTURE_EVALS)
    assert len(cases) >= 44
    assert {c["q"] for c in cases} >= REQUIRED


def test_fixture_evals_all_hit_their_doc() -> None:
    assert _check(FIXTURE_CORPUS, FIXTURE_EVALS) == []


def test_fixture_eval_expectations_name_real_docs() -> None:
    ids = {d["id"] for d in corpus.parse(FIXTURE_CORPUS.read_bytes()).docs}
    for case in eval_cases(FIXTURE_EVALS):
        assert case["expect"] in ids | {"unknown", "refused"}, case


@pytest.mark.skipif(not (WEB_EVALS.is_file() and WEB_CORPUS.is_file()), reason="the web build has not written them")
def test_shared_web_evals_hit_their_doc_in_python_too() -> None:
    cases = eval_cases(WEB_EVALS)
    assert len(cases) >= 44
    assert _check(WEB_CORPUS, WEB_EVALS) == []
