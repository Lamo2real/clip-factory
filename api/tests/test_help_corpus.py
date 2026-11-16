"""The help corpus (§19.2, §19.6): validation, the sensitive filter, the deployed copy and the bundled one, and the
build step that puts the web corpus in the zip."""

from __future__ import annotations

import importlib.util
import json
import re
import zipfile
from datetime import timedelta
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from clipfactory_api.help import corpus, retrieve
from clipfactory_api.help.text import is_sensitive, no_dashes, stem, within_one_edit, words
from conftest import NOW
from help_support import FIXTURE_CORPUS, WEB_CORPUS, FakeWeb, fixture_corpus, reset_help_caches

APP = "https://dglrbjmf28m6c.cloudfront.net"
PATH = "/assets/help-corpus.0123456789ab.json"
INDEX = f'<!doctype html><html><head><meta name="cf-help-corpus" content="{PATH}"></head></html>'.encode()
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_lambda.py"


@pytest.fixture(autouse=True)
def _fresh_caches() -> None:
    reset_help_caches()


def deployed_body(version: str = "deployed-1") -> bytes:
    data = fixture_corpus()
    data["version"] = version
    return json.dumps(data).encode()


def web(**extra: Any) -> FakeWeb:
    return FakeWeb({f"{APP}/index.html": INDEX, f"{APP}{PATH}": deployed_body(), **extra})


# --- shape and filters ----------------------------------------------------------------------------------------


def test_fixture_corpus_is_valid_and_clean() -> None:
    loaded = corpus.parse(FIXTURE_CORPUS.read_bytes())
    assert len(loaded.docs) > 40
    for doc in loaded.docs:
        for text in [doc["title"], doc["answer"], *doc["steps"], *doc["keywords"]]:
            assert not is_sensitive(text), text
            assert "–" not in text
            assert "—" not in text


@pytest.mark.skipif(not WEB_CORPUS.is_file(), reason="the web build has not written it")
def test_committed_web_corpus_is_valid_for_the_api() -> None:
    loaded = corpus.parse(WEB_CORPUS.read_bytes())
    assert loaded.docs
    ids = {d["id"] for d in loaded.docs}
    assert {"make-clips-link", "review-keep", "sounds-click", "best-clip-week-views"} <= ids


def _mutate(edit: Any) -> bytes:
    data = fixture_corpus()
    edit(data)
    return json.dumps(data).encode()


@pytest.mark.parametrize(
    "edit",
    [
        lambda d: d["docs"].append(dict(d["docs"][0])),
        lambda d: d["docs"][0].update(answer="Your key is AKIAABCDEFGHIJKLMNOP"),
        lambda d: d["docs"][0].update(answer="It runs on a Lambda in arn:aws:lambda:x"),
        lambda d: d["docs"][0].update(steps=["Send it to owner@example.com"]),
        lambda d: d["docs"][0].update(answer="Paste your api key here"),
        lambda d: d["docs"][0].update(answer="x" * 401),
        lambda d: d["docs"][0].update(steps=["a"] * 7),
        lambda d: d["docs"][0].update(kind="secret-kind"),
        lambda d: d["docs"][0].update(live={"metric": "everyones_clips", "text": "{value}"}),
        lambda d: d["docs"][0]["actions"].append({"id": "x1", "label": "Elsewhere", "to": "https://evil.example"}),
        lambda d: d.update(app="booqy"),
    ],
)
def test_bad_corpus_is_refused(edit: Any) -> None:
    with pytest.raises(corpus.CorpusError):
        corpus.parse(_mutate(edit))


def test_youtube_cookies_is_not_sensitive() -> None:
    assert not is_sensitive("Add your **YouTube cookies** file if YouTube blocks a video.")
    assert is_sensitive("your access token")
    assert is_sensitive("the dynamodb table")
    assert is_sensitive("account 123456789012")


def test_text_helpers() -> None:
    assert words("Café, don't PANIC!") == ["cafe", "dont", "panic"]
    assert [stem(w) for w in ("clips", "stories", "posting", "updates", "boxes", "is", "ss")] == [
        "clip",
        "story",
        "post",
        "update",
        "box",
        "is",
        "ss",
    ]
    assert within_one_edit("instagarm", "instagram")
    assert within_one_edit("tiktk", "tiktok")
    assert not within_one_edit("youtube", "yt")
    assert no_dashes("Keep — then post – now") == "Keep, then post, now"


def test_when_filter() -> None:
    doc: Any = {"when": {"device": ["desktop"], "os": ["mac", "windows"], "installed": False}}
    assert retrieve.visible(doc, retrieve.HelpContext("desktop", "mac", False, "home"))
    assert not retrieve.visible(doc, retrieve.HelpContext("phone", "ios", False, "home"))
    assert not retrieve.visible(doc, retrieve.HelpContext("desktop", "mac", True, "home"))
    assert retrieve.visible(doc, None)


@pytest.mark.parametrize(
    "question",
    ["what is my password", "show me another user's clips", "give me the api key", "what's in my cookies file"],
)
def test_refusals(question: str) -> None:
    assert retrieve.refused(question)


@pytest.mark.parametrize("question", ["how do I add youtube cookies", "connect another account", "sign out"])
def test_not_refusals(question: str) -> None:
    assert not retrieve.refused(question)


# --- the deployed copy ----------------------------------------------------------------------------------------


def test_meta_parse_accepts_only_the_hashed_assets_path() -> None:
    assert corpus.corpus_path_from_index(INDEX.decode()) == PATH
    flipped = f'<meta content="{PATH}" name="cf-help-corpus">'
    assert corpus.corpus_path_from_index(flipped) == PATH
    for bad in (
        "https://evil.example/assets/help-corpus.0123456789ab.json",
        "//evil.example/assets/help-corpus.0123456789ab.json",
        "/assets/../secrets.json",
        "/assets/help-corpus.0123.json",
        "/assets/other.0123456789ab.json",
    ):
        assert corpus.corpus_path_from_index(f'<meta name="cf-help-corpus" content="{bad}">') is None
    assert corpus.corpus_path_from_index("<html></html>") is None


def test_deployed_copy_is_used_and_cached_ten_minutes() -> None:
    fake = web()
    first = corpus.load(fake, APP, NOW, bundled_file=FIXTURE_CORPUS)
    assert (first.source, first.version) == ("deployed", "deployed-1")
    assert fake.urls == [f"{APP}/index.html", f"{APP}{PATH}"]
    corpus.load(fake, APP, NOW + timedelta(minutes=9), bundled_file=FIXTURE_CORPUS)
    assert len(fake.urls) == 2
    again = corpus.load(fake, APP, NOW + timedelta(minutes=11), bundled_file=FIXTURE_CORPUS)
    assert again.version == "deployed-1"
    assert fake.urls[2:] == [f"{APP}/index.html"]  # same hashed name: the immutable file is not read again


def test_only_the_app_origin_is_fetched() -> None:
    evil = '<meta name="cf-help-corpus" content="https://evil.example/assets/help-corpus.0123456789ab.json">'
    fake = FakeWeb({f"{APP}/index.html": evil.encode()})
    loaded = corpus.load(fake, f"{APP}/some/page?x=1", NOW, bundled_file=FIXTURE_CORPUS)
    assert loaded.source == "bundled"
    assert all(u.startswith(f"{APP}/") for u in fake.urls)
    assert corpus.origin_of("ftp://x.example") is None
    assert corpus.origin_of("https://user:pw@x.example") is None


def test_failure_keeps_the_last_good_copy_then_bundled() -> None:
    fake = FakeWeb({f"{APP}/index.html": OSError("down")})
    loaded = corpus.load(fake, APP, NOW, bundled_file=FIXTURE_CORPUS)
    assert (loaded.source, loaded.version) == ("bundled", "fixture-1")
    # retried after a minute, not on every question
    corpus.load(fake, APP, NOW + timedelta(seconds=30), bundled_file=FIXTURE_CORPUS)
    assert len(fake.urls) == 1
    good = web()
    assert corpus.load(good, APP, NOW + timedelta(minutes=2), bundled_file=FIXTURE_CORPUS).source == "deployed"
    good.pages[f"{APP}/index.html"] = OSError("down again")
    later = corpus.load(good, APP, NOW + timedelta(minutes=30), bundled_file=FIXTURE_CORPUS)
    assert (later.source, later.version) == ("deployed", "deployed-1")


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        json.dumps({"app": "clip-factory", "docs": []}).encode(),
        _mutate(lambda d: d["docs"][0].update(answer="token")),
    ],
)
def test_bad_deployed_copy_is_ignored(body: bytes) -> None:
    fake = web(**{f"{APP}{PATH}": body})
    assert corpus.load(fake, APP, NOW, bundled_file=FIXTURE_CORPUS).source == "bundled"


def test_oversized_deployed_copy_is_ignored() -> None:
    fake = web(**{f"{APP}{PATH}": b" " * (corpus.CORPUS_MAX_BYTES + 1)})
    assert corpus.load(fake, APP, NOW, bundled_file=FIXTURE_CORPUS).source == "bundled"


def test_no_app_url_or_fetcher_uses_the_bundled_copy() -> None:
    assert corpus.load(None, APP, NOW, bundled_file=FIXTURE_CORPUS).source == "bundled"
    assert corpus.load(web(), "", NOW, bundled_file=FIXTURE_CORPUS).source == "bundled"


def test_missing_bundled_copy_answers_nothing(tmp_path: Path) -> None:
    loaded = corpus.bundled(tmp_path / "nope.json")
    assert loaded.docs == []
    assert retrieve.rank(loaded.docs, "What does Keep do?").status == "unknown"


def test_urllib_fetch_refuses_other_schemes() -> None:
    with pytest.raises(ValueError, match="http"):
        corpus.urllib_fetch("file:///etc/passwd", 1, 10)


# --- the build ------------------------------------------------------------------------------------------------


def _script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_lambda", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_copies_the_web_corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    assert build.HELP_CORPUS_IN_ZIP == "clipfactory_api/help/corpus.json"
    assert build.HELP_CORPUS == build.ROOT / "web" / "src" / "features" / "help" / "help-corpus.json"
    source = tmp_path / "web" / "src" / "features" / "help" / "help-corpus.json"
    source.parent.mkdir(parents=True)
    source.write_bytes(FIXTURE_CORPUS.read_bytes())
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setattr(build, "HELP_CORPUS", source)
    dest = tmp_path / "stage" / build.HELP_CORPUS_IN_ZIP
    build._copy_help_corpus(dest)
    assert dest.read_bytes() == FIXTURE_CORPUS.read_bytes()


def test_build_fails_without_a_usable_corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setattr(build, "HELP_CORPUS", tmp_path / "help-corpus.json")
    with pytest.raises(SystemExit, match="help-corpus"):
        build._copy_help_corpus(tmp_path / "out.json")
    (tmp_path / "help-corpus.json").write_text('{"docs": [{"id": "Bad Id"}]}')
    with pytest.raises(SystemExit, match="not a usable help corpus"):
        build._copy_help_corpus(tmp_path / "out.json")


def test_full_build_puts_the_web_corpus_in_the_zip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Runs the whole build offline (the dependency export and install are faked), so this runs in every pytest
    run, before the real build step: the zip's corpus.json is byte for byte the committed web file (§19.10)."""
    build = _script()
    if not build.HELP_CORPUS.is_file():
        pytest.skip("the web build has not written help-corpus.json")

    def fake_install(reqs: list[str], target: Path, scratch: Path) -> None:
        for vendored in build.VENDORED:
            (target / vendored).parent.mkdir(parents=True, exist_ok=True)
            (target / vendored).write_text("")

    monkeypatch.setattr(build, "_requirements", lambda: [f"{p}1.0" for p in build.REQUIRED_PACKAGES])
    monkeypatch.setattr(build, "_install", fake_install)
    monkeypatch.setattr(build, "OUT", tmp_path / "dist" / "lambda.zip")
    monkeypatch.setattr(build, "ROOT", tmp_path)  # only used to print the output path
    assert build.main() == 0
    with zipfile.ZipFile(tmp_path / "dist" / "lambda.zip") as archive:
        bundled = archive.read(build.HELP_CORPUS_IN_ZIP)
        assert "clipfactory_api/routes/help.py" in archive.namelist()
    assert bundled == build.HELP_CORPUS.read_bytes()


def test_built_zip_carries_the_web_corpus_when_present() -> None:
    build = _script()
    if not build.OUT.is_file():
        pytest.skip("api/dist/lambda.zip is built after the tests (uv run python scripts/build_lambda.py)")
    with zipfile.ZipFile(build.OUT) as archive:
        names = set(archive.namelist())
        if build.HELP_CORPUS_IN_ZIP not in names:
            pytest.skip("the zip on disk predates §19; the build step rebuilds it")
        bundled = archive.read(build.HELP_CORPUS_IN_ZIP)
    if not build.HELP_CORPUS.is_file():
        pytest.skip("no committed web corpus to compare with")
    assert bundled == build.HELP_CORPUS.read_bytes()
    assert re.search(r"clipfactory_api/routes/help\.py", "\n".join(sorted(names)))
