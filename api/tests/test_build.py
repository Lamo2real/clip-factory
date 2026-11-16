"""api/scripts/build_lambda.py: the new handlers and config/platforms.json ship in the zip (§16.4, §16.10)."""

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


def test_handlers_include_stats_and_learn() -> None:
    build = _script()
    assert "clipfactory_api/stats/handler.py" in build.HANDLERS
    assert "clipfactory_api/weekly.py" in build.HANDLERS
    assert build.PLATFORMS_CONFIG_IN_ZIP == "clipfactory_api/config/platforms.json"


def test_platforms_config_is_validated_and_copied(tmp_path: Path) -> None:
    build = _script()
    dest = tmp_path / build.PLATFORMS_CONFIG_IN_ZIP
    build._copy_platforms_config(dest)
    assert json.loads(dest.read_text()) == json.loads(build.PLATFORMS_CONFIG.read_text())


def test_missing_platforms_config_fails_the_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    monkeypatch.setattr(build, "PLATFORMS_CONFIG", tmp_path / "config" / "platforms.json")
    monkeypatch.setattr(build, "ROOT", tmp_path)
    with pytest.raises(SystemExit, match=r"platforms\.json"):
        build._copy_platforms_config(tmp_path / "out.json")


def test_built_zip_contains_the_config_when_present() -> None:
    build = _script()
    if not build.OUT.is_file():
        pytest.skip("api/dist/lambda.zip is built after the tests (uv run python scripts/build_lambda.py)")
    with zipfile.ZipFile(build.OUT) as archive:
        names = set(archive.namelist())
    if "clipfactory_api/stats/handler.py" not in names:
        pytest.skip("the zip on disk predates §16; the build step rebuilds it")
    assert build.PLATFORMS_CONFIG_IN_ZIP in names
    assert "clipfactory_api/weekly.py" in names
