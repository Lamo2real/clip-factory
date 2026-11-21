"""api/scripts/build_lambda.py ships Lamo Stories' checked guidance in the zip (docs/CONTRACTS.md §45.11.5, §45.17)."""

from __future__ import annotations

import importlib.util
import json
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_lambda.py"


def _script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_lambda", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_guidance_is_validated_and_copied(tmp_path: Path) -> None:
    build = _script()
    assert build.STORIES_GUIDANCE_IN_ZIP == "clipfactory_api/config/stories-guidance.json"
    dest = tmp_path / build.STORIES_GUIDANCE_IN_ZIP
    build._copy_stories_guidance(dest)
    assert json.loads(dest.read_text()) == json.loads(build.STORIES_GUIDANCE.read_text())


def test_missing_or_broken_guidance_fails_the_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setattr(build, "STORIES_GUIDANCE", tmp_path / "config" / "stories-guidance.json")
    with pytest.raises(SystemExit, match=r"stories-guidance\.json"):
        build._copy_stories_guidance(tmp_path / "out.json")
    broken = json.loads((SCRIPT.parents[2] / "config" / "stories-guidance.json").read_text())
    broken["topics"][0]["steps"][0]["sources"] = ["NOT-A-SOURCE"]
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "stories-guidance.json").write_text(json.dumps(broken))
    with pytest.raises(SystemExit, match="not usable guidance"):
        build._copy_stories_guidance(tmp_path / "out.json")


def test_the_api_reads_the_packaged_copy_first(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_api.workspaces import guidance

    build = _script()
    assert guidance.REPO_FILE == build.STORIES_GUIDANCE
    assert guidance.load().checked_at == json.loads(build.STORIES_GUIDANCE.read_text())["checkedAt"]


def test_a_built_zip_holds_the_guidance_when_present() -> None:
    build = _script()
    if not build.OUT.is_file():
        pytest.skip("api/dist/lambda.zip is built after the tests (uv run python scripts/build_lambda.py)")
    with zipfile.ZipFile(build.OUT) as archive:
        names = set(archive.namelist())
    if "clipfactory_api/workspaces/guidance.py" not in names:
        pytest.skip("the zip on disk predates §45; the build step rebuilds it")
    assert build.STORIES_GUIDANCE_IN_ZIP in names
