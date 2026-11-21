"""api/scripts/build_lambda.py ships Lamo Stories' own configuration and skills in the zip, validated (docs/CONTRACTS.md
§45.11.5, §45.17, §45.24): the whole ``stories/config/`` folder as ``clipfactory_api/stories_config/`` and
``stories/skills/`` as ``clipfactory_api/stories_skills/``; nothing of Clip Factory's ``config/`` or ``skills/``."""

from __future__ import annotations

import importlib.util
import json
import shutil
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_lambda.py"
REPO = SCRIPT.parents[2]


def _script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_lambda", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, build: ModuleType) -> Path:
    """A copy of stories/config and stories/skills the test may break."""
    shutil.copytree(REPO / "stories" / "config", tmp_path / "stories" / "config")
    shutil.copytree(REPO / "stories" / "skills", tmp_path / "stories" / "skills")
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setattr(build, "STORIES_CONFIG", tmp_path / "stories" / "config")
    monkeypatch.setattr(build, "STORIES_SKILLS", tmp_path / "stories" / "skills")
    return tmp_path / "stories"


def test_the_whole_stories_config_folder_is_validated_and_copied(tmp_path: Path) -> None:
    build = _script()
    assert build.STORIES_CONFIG == REPO / "stories" / "config"
    assert build.STORIES_CONFIG_IN_ZIP == "clipfactory_api/stories_config"
    names = build._copy_stories_config(tmp_path / "stories_config")
    wanted = sorted(p.name for p in (REPO / "stories" / "config").glob("*.json"))
    assert names == [f"clipfactory_api/stories_config/{n}" for n in wanted]
    for name in ("guidance.json", "models.json", "agents.json", "workspace-defaults.json", "resolve-cases.json"):
        assert name in wanted
        copied = json.loads((tmp_path / "stories_config" / name).read_text())
        assert copied == json.loads((REPO / "stories" / "config" / name).read_text())


def test_every_built_in_stories_skill_is_copied(tmp_path: Path) -> None:
    build = _script()
    names = build._copy_stories_skills(tmp_path / "stories_skills")
    for skill in ("nonverbal-storytelling", "driving-safety-teaching", "vertical-short-hooks"):
        assert f"clipfactory_api/stories_skills/{skill}/SKILL.md" in names
        assert (tmp_path / "stories_skills" / skill / "SKILL.md").read_bytes() == (
            REPO / "stories" / "skills" / skill / "SKILL.md"
        ).read_bytes()


@pytest.mark.parametrize(
    ("name", "breaks", "match"),
    [
        ("guidance.json", lambda d: d["topics"][0]["steps"][0].update(sources=["NOT-A-SOURCE"]), "guidance.json"),
        ("models.json", lambda d: d["models"][0].update(efforts=["turbo"]), "models.json"),
        ("models.json", lambda d: d.update(defaultModel="gpt-9"), "models.json"),
        ("agents.json", lambda d: d["agents"].pop(), "agents.json"),
    ],
)
def test_a_broken_stories_config_file_fails_the_build(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, breaks: object, match: str
) -> None:
    build = _script()
    stories = _fake_tree(tmp_path, monkeypatch, build)
    path = stories / "config" / name
    data = json.loads(path.read_text())
    breaks(data)  # type: ignore[operator]
    path.write_text(json.dumps(data))
    with pytest.raises(SystemExit, match=match):
        build._copy_stories_config(tmp_path / "out")


def test_a_missing_stories_config_file_fails_the_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    stories = _fake_tree(tmp_path, monkeypatch, build)
    (stories / "config" / "workspace-defaults.json").unlink()
    with pytest.raises(SystemExit, match=r"workspace-defaults\.json"):
        build._copy_stories_config(tmp_path / "out")


def test_a_broken_stories_skill_fails_the_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build = _script()
    stories = _fake_tree(tmp_path, monkeypatch, build)
    skill = stories / "skills" / "vertical-short-hooks" / "SKILL.md"
    skill.write_text(skill.read_text().replace("name: vertical-short-hooks", "name: something-else"))
    with pytest.raises(SystemExit, match="something-else"):
        build._copy_stories_skills(tmp_path / "out")
    skill.write_text("# no front matter\n")
    with pytest.raises(SystemExit, match="not a usable skill"):
        build._copy_stories_skills(tmp_path / "out")


def test_the_api_reads_the_packaged_copy_first(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from clipfactory_api.workspaces import config, guidance

    assert config.config_dir() == REPO / "stories" / "config"
    assert config.skills_dir() == REPO / "stories" / "skills"
    build = _script()
    packaged = tmp_path / "stories_config"
    build._copy_stories_config(packaged)
    monkeypatch.setattr(config, "_PACKAGED", packaged)
    assert config.config_dir() == packaged
    assert guidance.load(packaged / "guidance.json").checked_at == guidance.load().checked_at


def test_a_built_zip_holds_lamo_stories_config_and_skills_when_present() -> None:
    build = _script()
    if not build.OUT.is_file():
        pytest.skip("api/dist/lambda.zip is built after the tests (uv run python scripts/build_lambda.py)")
    with zipfile.ZipFile(build.OUT) as archive:
        names = set(archive.namelist())
    if "clipfactory_api/workspaces/config.py" not in names:
        pytest.skip("the zip on disk predates §45.24; the build step rebuilds it")
    assert "clipfactory_api/stories_config/guidance.json" in names
    assert "clipfactory_api/stories_config/models.json" in names
    assert "clipfactory_api/stories_skills/nonverbal-storytelling/SKILL.md" in names
    assert "clipfactory_api/config/stories-guidance.json" not in names


def test_an_offline_full_build_puts_lamo_stories_files_in_the_zip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole build with the dependency export and install faked (no network): the zip carries every
    ``stories/config`` file and built-in Lamo Stories skill byte for byte, and Lamo Stories' own Lambda handler."""
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
        names = set(archive.namelist())
        for path in sorted((REPO / "stories" / "config").glob("*.json")):
            assert archive.read(f"clipfactory_api/stories_config/{path.name}") == path.read_bytes()
        for path in sorted((REPO / "stories" / "skills").glob("*/SKILL.md")):
            name = f"clipfactory_api/stories_skills/{path.parent.name}/SKILL.md"
            assert archive.read(name) == path.read_bytes()
    assert "clipfactory_api/workspaces/http.py" in names
    assert "clipfactory_api/config/stories-guidance.json" not in names
    assert not [n for n in names if n.startswith("clipfactory_api/builtin_skills/") and "stories" in n]
