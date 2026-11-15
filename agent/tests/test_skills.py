from __future__ import annotations

import io
import stat
import zipfile
from pathlib import Path

import pytest

from clipfactory_agent.skills import (
    SkillError,
    builtin_choices,
    extract_zip,
    parse_frontmatter,
    prepare_skills,
    safe_name,
    skills_prompt,
)

MD = b'---\nname: "My Rules"\ndescription: Owner rules\n---\n\n# Rules\nAlways tag @me\n'


def zip_bytes(files: dict[str, bytes], symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
    return buf.getvalue()


def test_parse_frontmatter() -> None:
    meta, body = parse_frontmatter(MD.decode())
    assert meta == {"name": "My Rules", "description": "Owner rules"}
    assert body.startswith("# Rules")
    assert parse_frontmatter("no front matter") == ({}, "no front matter")
    assert parse_frontmatter("---\nname: x\nnever closed") == ({}, "---\nname: x\nnever closed")


def test_safe_name() -> None:
    assert safe_name("My Rules!") == "my-rules"
    assert safe_name("../../etc") == "etc"
    assert safe_name("???") == "skill"


def test_extract_zip_finds_skill_folder(tmp_path: Path) -> None:
    data = zip_bytes(
        {"pack/SKILL.md": MD, "pack/ref/notes.md": b"x", "other.txt": b"y", "__MACOSX/pack/._SKILL.md": b"z"}
    )
    out = extract_zip(data, tmp_path / "s")
    assert (out / "SKILL.md").read_bytes() == MD
    assert (out / "ref" / "notes.md").is_file()
    assert not (out / "other.txt").exists()


@pytest.mark.parametrize(
    ("files", "symlink", "why"),
    [
        ({"SKILL.md": MD, "../evil.md": b"x"}, None, "unsafe path"),
        ({"SKILL.md": MD, "/abs.md": b"x"}, None, "unsafe path"),
        ({"SKILL.md": MD}, "link", "symbolic link"),
        ({"a/SKILL.md": MD, "b/SKILL.md": MD}, None, "exactly one"),
        ({"README.md": b"x"}, None, "exactly one"),
    ],
)
def test_extract_zip_refuses_unsafe(tmp_path: Path, files: dict[str, bytes], symlink: str | None, why: str) -> None:
    with pytest.raises(SkillError, match=why):
        extract_zip(zip_bytes(files, symlink), tmp_path / "s")
    assert not (tmp_path / "evil.md").exists()


def test_extract_zip_refuses_bombs_and_garbage(tmp_path: Path) -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("SKILL.md", MD)
        zf.writestr("big.bin", b"\0" * (51 * 1024 * 1024))
    with pytest.raises(SkillError, match="too large"):
        extract_zip(buf.getvalue(), tmp_path / "s")
    with pytest.raises(SkillError, match="not a zip"):
        extract_zip(b"nope", tmp_path / "t")


def test_builtin_choices() -> None:
    rows = [{"skillId": "builtin-playbook", "enabled": False}, {"skillId": "01ABC", "enabled": True}]
    assert builtin_choices(rows) == {"playbook": False}


async def test_prepare_skills_writes_builtin_and_owner_skills(tmp_path: Path) -> None:
    builtin = tmp_path / "app-skills"
    (builtin / "playbook").mkdir(parents=True)
    (builtin / "playbook" / "SKILL.md").write_text("---\nname: playbook\ndescription: core\n---\nBody")
    (builtin / "off").mkdir()
    (builtin / "off" / "SKILL.md").write_text("---\nname: off\n---\nOff")
    store = {
        "skills/u/1/SKILL.md": MD,
        "skills/u/2/skill.zip": zip_bytes({"z/SKILL.md": b"---\nname: zipped\n---\nZ", "z/a.txt": b"a"}),
        "skills/u/3/skill.zip": b"broken",
    }

    async def fetch(key: str) -> bytes:
        return store[key]

    rows = [
        {"skillId": "builtin-off", "enabled": False},
        {
            "skillId": "1",
            "name": "My Rules",
            "enabled": True,
            "builtin": False,
            "format": "md",
            "key": "skills/u/1/SKILL.md",
            "createdAt": "1",
        },
        {
            "skillId": "2",
            "name": "zipped",
            "enabled": True,
            "builtin": False,
            "format": "zip",
            "key": "skills/u/2/skill.zip",
            "createdAt": "2",
        },
        {
            "skillId": "3",
            "name": "broken",
            "enabled": True,
            "builtin": False,
            "format": "zip",
            "key": "skills/u/3/skill.zip",
            "createdAt": "3",
        },
        {
            "skillId": "4",
            "name": "disabled",
            "enabled": False,
            "builtin": False,
            "format": "md",
            "key": "skills/u/4/SKILL.md",
        },
    ]
    work = tmp_path / "work"
    docs = await prepare_skills(work, builtin, rows, fetch)
    assert [d.name for d in docs] == ["playbook", "my-rules", "zipped"]
    root = work / ".claude" / "skills"
    assert sorted(p.name for p in root.iterdir()) == ["my-rules", "playbook", "zipped"]
    assert (root / "zipped" / "a.txt").read_text() == "a"
    assert not (work / ".skill-staging").exists()
    prompt = skills_prompt(docs)
    assert '<skill name="my-rules">' in prompt and "Always tag @me" in prompt
