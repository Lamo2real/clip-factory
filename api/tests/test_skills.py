from __future__ import annotations

import io
import stat
import zipfile
from pathlib import Path

import pytest

from clipfactory_api import skills
from clipfactory_api.skills import SkillError, parse_frontmatter, read_frontmatter, skill_md_from_zip
from conftest import OTHER, USER, Call
from fakes import FakeS3

SKILL = """---
name: my-skill
description: Find the funniest moments.
---
Body
"""

REPO_SKILLS = Path(__file__).resolve().parents[2] / "skills"


def make_zip(files: dict[str, str | bytes], *, symlink: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, "/etc/passwd")
    return buf.getvalue()


# --- frontmatter ----------------------------------------------------------------------------------------------


def test_frontmatter_plain_and_quoted() -> None:
    fields = parse_frontmatter("---\nname: \"a-b\"\ndescription: 'It''s fine'\nother: x: y\n---\n")
    assert fields == {"name": "a-b", "description": "It's fine", "other": "x: y"}


def test_frontmatter_folded_block_and_continuation() -> None:
    text = "---\nname: a\ndescription: >\n  line one\n  line two\nmeta:\n  nested: 1\n---\n"
    fields = parse_frontmatter(text)
    assert fields["description"] == "line one line two"
    text = "---\nname: a\ndescription: first part\n  second part\n---\n"
    assert parse_frontmatter(text)["description"] == "first part second part"


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("no frontmatter", "must start"),
        ("---\nname: a\n", "not closed"),
        ("---\ndescription: d\n---\n", "needs a name"),
        ("---\nname: a\n---\n", "needs a description"),
        ("---\nname: Bad Name\ndescription: d\n---\n", "lowercase"),
        ("---\nname: ../x\ndescription: d\n---\n", "lowercase"),
        ("---\nname: a\ndescription: " + "d" * 1025 + "\n---\n", "too long"),
    ],
)
def test_frontmatter_errors(text: str, message: str) -> None:
    with pytest.raises(SkillError, match=message):
        read_frontmatter(text)


def test_repository_builtin_skills_parse() -> None:
    found = skills.load_builtins(REPO_SKILLS)
    assert found, "the repository ships at least one built-in skill"
    for b in found:
        assert b.skill_id == f"builtin-{b.name}"
        assert b.description


# --- zips -----------------------------------------------------------------------------------------------------


def test_zip_with_skill_at_root_or_one_folder() -> None:
    assert "Body" in skill_md_from_zip(make_zip({"SKILL.md": SKILL, "ref/notes.md": "x"}))
    assert "Body" in skill_md_from_zip(make_zip({"my-skill/SKILL.md": SKILL, "my-skill/ref.md": "x"}))


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (make_zip({"README.md": "x"}), "exactly one SKILL.md"),
        (make_zip({"SKILL.md": SKILL, "b/SKILL.md": SKILL}), "exactly one SKILL.md"),
        (make_zip({"SKILL.md": SKILL, "../evil.sh": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL, "/abs.txt": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL, "a\\..\\b.txt": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL}, symlink="link"), "link"),
        (make_zip({"a/b/SKILL.md": SKILL}), "one folder"),
        (make_zip({"SKILL.md": b"\xff\xfe\x00bad"}), "UTF-8"),
        (b"not a zip", "not a valid zip"),
    ],
)
def test_zip_errors(data: bytes, message: str) -> None:
    with pytest.raises(SkillError, match=message):
        skill_md_from_zip(data)


def test_zip_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(skills, "ZIP_MAX_ENTRIES", 2)
    with pytest.raises(SkillError, match="more than"):
        skill_md_from_zip(make_zip({"SKILL.md": SKILL, "a": "1", "b": "2"}))
    monkeypatch.setattr(skills, "ZIP_MAX_UNCOMPRESSED", 10)
    with pytest.raises(SkillError, match="unpacks"):
        skill_md_from_zip(make_zip({"SKILL.md": SKILL}))


# --- routes ---------------------------------------------------------------------------------------------------


def _upload(call: Call, s3_client: FakeS3, filename: str, data: bytes) -> tuple[int, dict[str, object]]:
    status, presign = call("POST", "/v1/skills/uploads", {"filename": filename})
    assert status == 200
    s3_client.objects[presign["key"]] = data
    return call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": presign["key"]})


def test_list_includes_builtin(call: Call) -> None:
    status, body = call("GET", "/v1/skills")
    assert status == 200
    (builtin,) = body["skills"]
    assert builtin["skillId"] == "builtin-short-form-video-playbook"
    assert builtin["builtin"] is True
    assert builtin["enabled"] is True
    assert builtin["format"] == "md"


def test_upload_presign_scoped_to_caller(call: Call, s3_client: FakeS3) -> None:
    status, body = call("POST", "/v1/skills/uploads", {"filename": "My Skill.zip"})
    assert status == 200
    assert body["key"] == f"skills/{USER}/{body['skillId']}/skill.zip"
    assert body["headers"] == {"Content-Type": "application/zip"}
    op, params, expires = s3_client.presigned[-1]
    assert (op, params["Key"], params["ContentType"], expires) == ("put_object", body["key"], "application/zip", 3600)
    assert call("POST", "/v1/skills/uploads", {"filename": "evil.exe"})[0] == 400


def test_register_md_skill(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "SKILL.md", SKILL.encode())
    assert status == 201
    skill = body["skill"]
    assert skill["name"] == "my-skill"
    assert skill["description"] == "Find the funniest moments."
    assert skill["builtin"] is False
    assert skill["enabled"] is True
    assert skill["format"] == "md"
    assert skill["size"] == len(SKILL.encode())
    assert "key" not in skill
    _, listing = call("GET", "/v1/skills")
    assert [s["name"] for s in listing["skills"]] == ["short-form-video-playbook", "my-skill"]
    _, content = call("GET", f"/v1/skills/{skill['skillId']}/content")
    assert content["content"] == SKILL


def test_register_zip_skill(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "skill.zip", make_zip({"my-skill/SKILL.md": SKILL}))
    assert status == 201
    assert body["skill"]["format"] == "zip"
    _, content = call("GET", f"/v1/skills/{body['skill']['skillId']}/content")
    assert content["content"] == SKILL


def test_register_rejects_bad_zip_and_discards_it(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "skill.zip", make_zip({"README.md": "x"}))
    assert status == 400
    assert "exactly one SKILL.md" in body["error"]["message"]
    assert not any(k.endswith("skill.zip") for k in s3_client.objects)


def test_register_rejects_too_large(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "SKILL.md", b"x" * (skills.MD_MAX_BYTES + 1))
    assert status == 400
    assert "larger than 1 MB" in body["error"]["message"]


def test_register_rejects_duplicate_name(call: Call, s3_client: FakeS3) -> None:
    assert _upload(call, s3_client, "SKILL.md", SKILL.encode())[0] == 201
    assert _upload(call, s3_client, "SKILL.md", SKILL.encode())[0] == 409
    clash = SKILL.replace("my-skill", "short-form-video-playbook").encode()
    assert _upload(call, s3_client, "SKILL.md", clash)[0] == 409


def test_register_key_must_match_caller_and_id(call: Call, s3_client: FakeS3) -> None:
    _, presign = call("POST", "/v1/skills/uploads", {"filename": "SKILL.md"})
    foreign = f"skills/{OTHER}/{presign['skillId']}/SKILL.md"
    s3_client.objects[foreign] = SKILL.encode()
    assert call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": foreign})[0] == 400
    assert call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": presign["key"]})[0] == 400  # not uploaded
    assert call("POST", "/v1/skills", {"skillId": "nope", "key": presign["key"]})[0] == 400


def test_toggle_builtin_and_owner_skill(call: Call, s3_client: FakeS3) -> None:
    status, body = call("PATCH", "/v1/skills/builtin-short-form-video-playbook", {"enabled": False})
    assert status == 200
    assert body["skill"]["enabled"] is False
    _, listing = call("GET", "/v1/skills")
    assert listing["skills"][0]["enabled"] is False
    assert len(listing["skills"]) == 1  # the stored choice is not listed as its own skill
    _, created = _upload(call, s3_client, "SKILL.md", SKILL.encode())
    skill_id = created["skill"]["skillId"]  # type: ignore[index]
    _, body = call("PATCH", f"/v1/skills/{skill_id}", {"enabled": False})
    assert body["skill"]["enabled"] is False
    assert call("PATCH", f"/v1/skills/{skill_id}", {"enabled": "no"})[0] == 400
    assert call("PATCH", "/v1/skills/01JABCDEFGHJKMNPQRSTVWXYZ0", {"enabled": True})[0] == 404


def test_delete(call: Call, s3_client: FakeS3) -> None:
    assert call("DELETE", "/v1/skills/builtin-short-form-video-playbook")[0] == 409
    _, created = _upload(call, s3_client, "SKILL.md", SKILL.encode())
    skill_id = created["skill"]["skillId"]  # type: ignore[index]
    status, body = call("DELETE", f"/v1/skills/{skill_id}")
    assert (status, body) == (204, None)
    assert not any(skill_id in k for k in s3_client.objects)
    assert call("DELETE", f"/v1/skills/{skill_id}")[0] == 404


def test_builtin_content(call: Call) -> None:
    status, body = call("GET", "/v1/skills/builtin-short-form-video-playbook/content")
    assert status == 200
    assert body["content"].startswith("---")
