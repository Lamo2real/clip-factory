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
    if "clipfactory_api/skill_prompt.py" not in names:
        pytest.skip("the zip on disk predates §18; the build step rebuilds it")
    assert any(n.startswith("clipfactory_api/builtin_skills/") and n.endswith("/SKILL.md") for n in names)


def test_built_in_skills_are_copied_into_the_package(tmp_path: Path) -> None:
    build = _script()
    count = build._copy_skills(tmp_path / "builtin_skills")
    assert count >= 1
    assert sorted(p.name for p in (tmp_path / "builtin_skills").glob("*/SKILL.md")) == ["SKILL.md"] * count


def _elf(machine: int) -> bytes:
    return b"\x7fELF" + bytes([2, 1]) + bytes(12) + machine.to_bytes(2, "little") + bytes(40)


def test_notify_handler_and_cryptography_ship() -> None:
    build = _script()
    assert "clipfactory_api/push/notify.py" in build.HANDLERS  # cf-prod-notify (§32.5)
    assert "cryptography==" in build.REQUIRED_PACKAGES


def test_only_arm64_linux_compiled_files_are_allowed() -> None:
    build = _script()
    rust = "cryptography/hazmat/bindings/_rust.abi3.so"
    assert build._compiled_ok(rust, _elf(183))  # aarch64
    assert not build._compiled_ok(rust, _elf(62))  # x86-64
    assert not build._compiled_ok(rust, b"\xcf\xfa\xed\xfe" + bytes(60))  # a macOS file
    assert build._compiled_ok("_cffi_backend.cpython-313-aarch64-linux-gnu.so")
    assert not build._compiled_ok("_cffi_backend.cpython-313-darwin.so")
    assert not build._compiled_ok("other/_thing.abi3.so", _elf(183))
