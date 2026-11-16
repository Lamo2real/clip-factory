from __future__ import annotations

import io
import json
import stat
import zipfile
from pathlib import Path

import pytest

from clipfactory_api import db, s3, skills
from clipfactory_api.ids import ulid
from clipfactory_api.skills import SkillError, parse_frontmatter, read_frontmatter, skill_md_from_zip
from conftest import OTHER, USER, Call
from fakes import FakeS3, FakeTable

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
        ("no frontmatter", "missing its name"),
        ("---\nname: a\n", "missing its name"),
        ("---\ndescription: d\n---\n", "missing its name"),
        ("---\nname: a\n---\n", "missing its name"),
        ("---\nname: Bad Name\ndescription: d\n---\n", "cannot read"),
        ("---\nname: ../x\ndescription: d\n---\n", "cannot read"),
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
        (make_zip({"README.md": "x"}), "exactly one skill"),
        (make_zip({"SKILL.md": SKILL, "b/SKILL.md": SKILL}), "exactly one skill"),
        (make_zip({"SKILL.md": SKILL, "../evil.sh": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL, "/abs.txt": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL, "a\\..\\b.txt": "x"}), "not allowed"),
        (make_zip({"SKILL.md": SKILL}, symlink="link"), "link"),
        (make_zip({"a/b/SKILL.md": SKILL}), "one folder"),
        (make_zip({"SKILL.md": b"\xff\xfe\x00bad"}), "plain text"),
        (b"not a zip", "not a .zip we can open"),
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


def lock_member(data: bytes, name: str) -> bytes:
    """``data`` with the "password-locked" flag set on ``name`` in its local and central headers."""
    buf = bytearray(data)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        offset = z.getinfo(name).header_offset
    buf[offset + 6] |= 0x1
    raw = name.encode()
    at = buf.find(b"PK\x01\x02")
    while at != -1:
        name_len = int.from_bytes(buf[at + 28 : at + 30], "little")
        if bytes(buf[at + 46 : at + 46 + name_len]) == raw:
            buf[at + 8] |= 0x1
        at = buf.find(b"PK\x01\x02", at + 4)
    return bytes(buf)


def bzip2_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("my-skill/SKILL.md", SKILL)
        z.writestr("my-skill/ref.md", "x", compress_type=zipfile.ZIP_BZIP2)
    return buf.getvalue()


LOCKED = lock_member(make_zip({"my-skill/SKILL.md": SKILL, "my-skill/locked.bin": "secret"}), "my-skill/locked.bin")


def test_the_locked_sample_really_is_locked() -> None:
    with zipfile.ZipFile(io.BytesIO(LOCKED)) as z, pytest.raises(RuntimeError, match="encrypted"):
        z.read("my-skill/locked.bin")


@pytest.mark.parametrize(("data", "message"), [(LOCKED, "password"), (bzip2_zip(), "cannot open")])
def test_zip_with_a_member_the_agent_cannot_open_is_refused(data: bytes, message: str) -> None:
    with pytest.raises(SkillError, match=message):
        skill_md_from_zip(data)
    assert "Body" in skill_md_from_zip(data, strict=False)  # the owner can still read an older stored one
    with pytest.raises(SkillError):
        skills.replace_skill_md_in_zip(data, SKILL)


def test_replace_in_zip_turns_zip_errors_into_skill_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(self: zipfile.ZipFile, name: object, pwd: object = None) -> bytes:
        raise RuntimeError("File is encrypted, password required for extraction")

    monkeypatch.setattr(zipfile.ZipFile, "read", broken)
    monkeypatch.setattr(skills, "skill_md_from_zip", lambda data, strict=True: SKILL)
    with pytest.raises(SkillError, match="Replace the whole file"):
        skills.replace_skill_md_in_zip(make_zip({"SKILL.md": SKILL, "a.md": "x"}), SKILL)


JARGON = ("frontmatter", "---", "utf-8", "digits", "skill.md", "lowercase")


def _upload_errors() -> list[str]:
    out = []
    texts = ["no header", "---\nname: a\n", "---\ndescription: d\n---\n", "---\nname: a\n---\n"]
    texts += ["---\nname: Bad Name\ndescription: d\n---\n", "---\nname: a\ndescription: " + "d" * 1025 + "\n---\n"]
    for text in texts:
        with pytest.raises(SkillError) as e:
            read_frontmatter(text)
        out.append(str(e.value))
    with pytest.raises(SkillError) as e:
        skills.decode_text(b"\xff\xfe\x00bad")
    out.append(str(e.value))
    zips = [
        make_zip({"README.md": "x"}),
        make_zip({"SKILL.md": SKILL, "b/SKILL.md": SKILL}),
        make_zip({"SKILL.md": SKILL, "../evil.sh": "x"}),
        make_zip({"SKILL.md": SKILL}, symlink="link"),
        make_zip({"a/b/SKILL.md": SKILL}),
        make_zip({"SKILL.md": b"\xff\xfe\x00bad"}),
        b"not a zip",
        b"x" * (skills.ZIP_MAX_BYTES + 1),
        LOCKED,
        bzip2_zip(),
    ]
    for data in zips:
        with pytest.raises(SkillError) as e:
            skill_md_from_zip(data)
        out.append(str(e.value))
    for fn in (skills.skill_body, skills.frontmatter_extra):
        with pytest.raises(SkillError) as e:
            fn("no header")
        out.append(str(e.value))
    return out


def test_upload_errors_use_kid_words() -> None:
    messages = _upload_errors()
    assert len(messages) == 19
    for message in messages:
        assert not any(word in message.lower() for word in JARGON), message
        assert message.endswith("."), message


# --- slug, humanize, build and parse (§18.2, §18.3) -------------------------------------------------------------


@pytest.mark.parametrize(
    ("title", "name"),
    [
        ("Funny Moments FIRST!!", "funny-moments-first"),
        ("Ça va", "ca-va"),
        ("🎮🎮", "my-skill"),
        ("  --Hello__World--  ", "hello-world"),
        ("Crème brûlée 2", "creme-brulee-2"),
        ("", "my-skill"),
    ],
)
def test_slug_examples(title: str, name: str) -> None:
    assert skills.slug(title) == name


def test_slug_long_title_cuts_at_a_dash() -> None:
    title = "word " * 16  # 80 characters
    name = skills.slug(title)
    assert len(name) <= 64
    assert name == "-".join(["word"] * 13)  # 64 characters, cut where a dash was
    assert skills.NAME_RE.match(name)
    unbroken = skills.slug("a" * 80)
    assert unbroken == "a" * 64


@pytest.mark.parametrize(
    ("name", "title"),
    [
        ("funny-moments-first", "Funny moments first"),
        ("a", "A"),
        ("short-form-video-playbook", "Short form video playbook"),
    ],
)
def test_humanize(name: str, title: str) -> None:
    assert skills.humanize(name) == title


def test_build_skill_md_round_trips() -> None:
    description = 'Every time it picks "moments" from C:\\games: yes.'
    text = skills.build_skill_md("funny-moments-first", description, "Funny moments first", "Pick the loud parts.")
    assert text == (
        "---\nname: funny-moments-first\n"
        'description: "Every time it picks \\"moments\\" from C:\\\\games: yes."\n'
        "---\n\n# Funny moments first\n\nPick the loud parts.\n"
    )
    meta = read_frontmatter(text)
    assert (meta.name, meta.description) == ("funny-moments-first", description)
    item = {"title": "Funny moments first", "name": "funny-moments-first"}
    form = skills.parse_form(item, text)
    assert form == skills.SkillForm("Funny moments first", description, "Pick the loud parts.")
    assert skills.build_skill_md("funny-moments-first", form.description, form.title, form.instructions) == text


def test_build_skill_md_keeps_an_own_heading_and_extra_frontmatter() -> None:
    text = skills.build_skill_md("a-b", "When.", "A b", "# My rules\n\nBe kind.", "license: MIT\nmeta:\n  x: 1")
    assert text == '---\nname: a-b\ndescription: "When."\nlicense: MIT\nmeta:\n  x: 1\n---\n\n# My rules\n\nBe kind.\n'
    assert skills.parse_form({"title": "A b"}, text).instructions == "# My rules\n\nBe kind."
    assert skills.frontmatter_extra(text) == "license: MIT\nmeta:\n  x: 1"


def test_frontmatter_extra_drops_only_name_and_description() -> None:
    text = "---\nname: a\nallowed-tools: Read\ndescription: >\n  folded\n  text\nversion: 2\n---\nBody\n"
    assert skills.frontmatter_extra(text) == "allowed-tools: Read\nversion: 2"


def test_normalize_form_cleans_text() -> None:
    form = skills.normalize_form(
        {
            "title": "  Funny\nmoments ",
            "description": "Every\r\ntime\n\nit  picks.",
            "instructions": " a\r\nb\x07\tc \n",
        }
    )
    assert form == skills.SkillForm("Funny moments", "Every time it picks.", "a\nb\tc")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", ""),
        ("title", "x" * 61),
        ("title", "!!!"),
        ("description", "ab"),
        ("description", "d" * 1025),
        ("instructions", ""),
        ("instructions", "i" * 50_001),
        ("title", 5),
    ],
)
def test_normalize_form_limits(field: str, value: object) -> None:
    body: dict[str, object] = {"title": "Funny", "description": "When it picks.", "instructions": "Do it."}
    body[field] = value
    with pytest.raises(skills.FormError) as caught:
        skills.normalize_form(body)
    assert caught.value.field == field


def test_normalize_form_accepts_the_limits() -> None:
    form = skills.normalize_form({"title": "x" * 60, "description": "abc", "instructions": "i" * 50_000})
    assert len(form.title) == 60


def test_replace_skill_md_in_zip_keeps_every_other_member() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(zipfile.ZipInfo("my-skill/", date_time=(2024, 1, 2, 3, 4, 6)), b"")
        z.writestr(zipfile.ZipInfo("my-skill/ref/notes.md", date_time=(2024, 1, 2, 3, 4, 6)), b"notes \x00 bytes")
        z.writestr(zipfile.ZipInfo("my-skill/SKILL.md", date_time=(2024, 1, 2, 3, 4, 6)), SKILL)
        z.writestr(zipfile.ZipInfo("my-skill/z.bin", date_time=(2023, 5, 6, 7, 8, 10)), bytes(range(256)))
    new = skills.replace_skill_md_in_zip(buf.getvalue(), "---\nname: b\ndescription: d\n---\nNew\n")
    with zipfile.ZipFile(io.BytesIO(buf.getvalue())) as before, zipfile.ZipFile(io.BytesIO(new)) as after:
        assert [i.filename for i in before.infolist()] == [i.filename for i in after.infolist()]
        for old, now in zip(before.infolist(), after.infolist(), strict=True):
            assert old.date_time == now.date_time
            if not old.filename.endswith("SKILL.md"):
                assert before.read(old) == after.read(now)
    assert skill_md_from_zip(new) == "---\nname: b\ndescription: d\n---\nNew\n"
    assert skills.zip_other_files(new) == ["my-skill/ref/notes.md", "my-skill/z.bin"]


# --- routes ---------------------------------------------------------------------------------------------------

BUILTIN_ID = "builtin-short-form-video-playbook"
FORM = {
    "title": "Funny Moments FIRST!!",
    "description": "Every time it picks moments from my Minecraft videos.",
    "instructions": "Pick the moments where I laugh the loudest.\nNever use bad words in captions.",
}


def _upload(
    call: Call, s3_client: FakeS3, filename: str, data: bytes, skill_id: str | None = None
) -> tuple[int, dict[str, object]]:
    body: dict[str, str] = {"filename": filename}
    if skill_id:
        body["skillId"] = skill_id
    status, presign = call("POST", "/v1/skills/uploads", body)
    assert status == 200
    s3_client.objects[presign["key"]] = data
    if skill_id:
        return 200, presign
    return call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": presign["key"]})


def _write(call: Call, **changes: str) -> dict[str, object]:
    status, body = call("POST", "/v1/skills", {**FORM, **changes})
    assert status == 201, body
    skill: dict[str, object] = body["skill"]
    return skill


def test_list_includes_builtin(call: Call) -> None:
    status, body = call("GET", "/v1/skills")
    assert status == 200
    (builtin,) = body["skills"]
    assert builtin == {
        "skillId": BUILTIN_ID,
        "name": "short-form-video-playbook",
        "title": "Short form video playbook",
        "description": "Plan, script and hook short clips.",
        "builtin": True,
        "source": "builtin",
        "format": "md",
        "size": builtin["size"],
        "createdAt": skills.BUILTIN_CREATED_AT,
        "updatedAt": skills.BUILTIN_CREATED_AT,
        "version": 1,
    }


def test_list_sorts_by_name_drops_enabled_and_removes_choice_items(
    call: Call, s3_client: FakeS3, table: FakeTable
) -> None:
    _write(call, title="Zebra rules")
    _write(call, title="Apple rules")
    store = db.Store(table)
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.skill_sk(BUILTIN_ID),
            "type": "skill_choice",
            "skillId": BUILTIN_ID,
            "builtin": True,
            "enabled": False,
        }
    )
    legacy_id = ulid()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.skill_sk(legacy_id),
            "type": "skill",
            "skillId": legacy_id,
            "name": "middle",
            "description": "Old.",
            "enabled": False,
            "builtin": False,
            "format": "md",
            "size": 3,
            "createdAt": "2026-11-01T00:00:00.000Z",
            "key": f"skills/{USER}/{legacy_id}/SKILL.md",
        }
    )
    status, body = call("GET", "/v1/skills")
    assert status == 200
    assert [s["name"] for s in body["skills"]] == ["short-form-video-playbook", "apple-rules", "middle", "zebra-rules"]
    assert all("enabled" not in s for s in body["skills"])
    legacy = body["skills"][2]
    assert (legacy["title"], legacy["version"], legacy["updatedAt"], legacy["source"]) == (
        "Middle",
        1,
        "2026-11-01T00:00:00.000Z",
        "upload",
    )
    assert store.get(db.user_pk(USER), db.skill_sk(BUILTIN_ID)) is None


def test_upload_presign_scoped_to_caller(call: Call, s3_client: FakeS3) -> None:
    status, body = call("POST", "/v1/skills/uploads", {"filename": "My Skill.zip"})
    assert status == 200
    assert s3.skill_key_format(body["key"], USER, body["skillId"]) == "zip"
    assert body["headers"] == {"Content-Type": "application/zip"}
    op, params, expires = s3_client.presigned[-1]
    assert (op, params["Key"], params["ContentType"], expires) == ("put_object", body["key"], "application/zip", 3600)
    assert call("POST", "/v1/skills/uploads", {"filename": "evil.exe"})[0] == 400
    assert call("POST", "/v1/skills/uploads", {"filename": "a.md", "skillId": BUILTIN_ID})[0] == 409
    assert call("POST", "/v1/skills/uploads", {"filename": "a.md", "skillId": ulid()})[0] == 404


def test_register_md_skill(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "SKILL.md", SKILL.encode())
    assert status == 201
    skill = body["skill"]
    assert isinstance(skill, dict)
    assert skill["name"] == "my-skill"
    assert skill["title"] == "My skill"
    assert skill["description"] == "Find the funniest moments."
    assert (skill["builtin"], skill["source"], skill["format"], skill["version"]) == (False, "upload", "md", 1)
    assert skill["size"] == len(SKILL.encode())
    assert "key" not in skill
    assert "enabled" not in skill
    _, content = call("GET", f"/v1/skills/{skill['skillId']}/content")
    assert content["content"] == SKILL


def test_register_zip_skill(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "skill.zip", make_zip({"my-skill/SKILL.md": SKILL, "my-skill/a.md": "x"}))
    assert status == 201
    skill = body["skill"]
    assert isinstance(skill, dict)
    assert skill["format"] == "zip"
    status, detail = call("GET", f"/v1/skills/{skill['skillId']}")
    assert status == 200
    assert detail["content"] == SKILL
    assert detail["files"] == ["my-skill/a.md"]
    assert detail["form"] == {"title": "My skill", "description": "Find the funniest moments.", "instructions": "Body"}


def test_register_accepts_a_legacy_key(call: Call, s3_client: FakeS3) -> None:
    skill_id = ulid()
    key = s3.legacy_skill_key(USER, skill_id, "md")
    s3_client.objects[key] = SKILL.encode()
    assert call("POST", "/v1/skills", {"skillId": skill_id, "key": key})[0] == 201


def test_register_rejects_bad_zip_and_discards_it(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "skill.zip", make_zip({"README.md": "x"}))
    assert status == 400
    assert "exactly one skill" in body["error"]["message"]  # type: ignore[index]
    assert not any(k.endswith("skill.zip") for k in s3_client.objects)


def test_register_rejects_a_zip_with_a_locked_member(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "skill.zip", LOCKED)
    assert status == 400
    assert "password" in body["error"]["message"]  # type: ignore[index]
    assert not any(k.endswith("skill.zip") for k in s3_client.objects)


def test_register_error_for_a_plain_note_has_a_next_step(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "SKILL.md", b"Just a note with no header.")
    assert status == 400
    message = body["error"]["message"]  # type: ignore[index]
    assert "Write a skill" in message
    assert not any(word in message.lower() for word in JARGON)


def test_register_rejects_too_large(call: Call, s3_client: FakeS3) -> None:
    status, body = _upload(call, s3_client, "SKILL.md", b"x" * (skills.MD_MAX_BYTES + 1))
    assert status == 400
    assert "larger than 1 MB" in body["error"]["message"]  # type: ignore[index]


def test_register_rejects_duplicate_name(call: Call, s3_client: FakeS3) -> None:
    assert _upload(call, s3_client, "SKILL.md", SKILL.encode())[0] == 201
    status, body = _upload(call, s3_client, "SKILL.md", SKILL.encode())
    assert status == 409
    assert body["error"] == {  # type: ignore[index]
        "code": "conflict",
        "message": "You already have a skill called My skill. To change it, open it and tap Replace the whole file.",
        "field": "title",
    }
    clash = SKILL.replace("my-skill", "short-form-video-playbook").encode()
    status, body = _upload(call, s3_client, "SKILL.md", clash)
    assert status == 409
    assert body["error"]["message"] == (  # type: ignore[index]
        "Clip Factory already has a skill called Short form video playbook. "
        "Change the name inside your file, then upload it again."
    )


def test_register_key_must_match_caller_and_id(call: Call, s3_client: FakeS3) -> None:
    _, presign = call("POST", "/v1/skills/uploads", {"filename": "SKILL.md"})
    foreign = presign["key"].replace(USER, OTHER)
    s3_client.objects[foreign] = SKILL.encode()
    assert call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": foreign})[0] == 400
    assert call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": presign["key"]})[0] == 400  # not uploaded
    assert call("POST", "/v1/skills", {"skillId": "nope", "key": presign["key"]})[0] == 400
    s3_client.objects[presign["key"]] = SKILL.encode()
    status, body = call("POST", "/v1/skills", {"skillId": presign["skillId"], "key": presign["key"], "enabled": True})
    assert status == 400
    assert body["error"]["message"] == "Unknown field: enabled."


# create (written in the app)


def test_write_a_skill(call: Call, s3_client: FakeS3) -> None:
    skill = _write(call)
    assert skill["name"] == "funny-moments-first"
    assert skill["title"] == "Funny Moments FIRST!!"
    assert (skill["source"], skill["format"], skill["version"]) == ("written", "md", 1)
    assert skill["createdAt"] == skill["updatedAt"] == "2026-11-15T12:00:00.000Z"
    (key,) = [k for k in s3_client.objects if str(skill["skillId"]) in k]
    assert s3.skill_key_format(key, USER, str(skill["skillId"])) == "md"
    assert s3_client.put_types[key] == "text/markdown"
    text = s3_client.objects[key].decode()
    assert skill["size"] == len(s3_client.objects[key])
    assert read_frontmatter(text).name == "funny-moments-first"
    status, detail = call("GET", f"/v1/skills/{skill['skillId']}")
    assert status == 200
    assert detail["skill"] == skill
    assert detail["content"] == text
    assert detail["form"] == {
        "title": FORM["title"],
        "description": FORM["description"],
        "instructions": FORM["instructions"],
    }
    assert "formBlocked" not in detail
    assert detail["files"] == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", ""),
        ("title", "x" * 61),
        ("description", "ab"),
        ("description", "d" * 1025),
        ("instructions", "i" * 50_001),
    ],
)
def test_write_limits(call: Call, field: str, value: str) -> None:
    status, body = call("POST", "/v1/skills", {**FORM, field: value})
    assert status == 400
    assert body["error"]["field"] == field


def test_write_body_over_256_kb_is_too_large(call: Call) -> None:
    status, body = call("POST", "/v1/skills", raw=json.dumps({**FORM, "instructions": "i" * (256 * 1024)}))
    assert (status, body["error"]["code"]) == (413, "too_large")


def test_write_file_over_1_mb_is_too_large(call: Call, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(skills, "MD_MAX_BYTES", 100)
    status, body = call("POST", "/v1/skills", {**FORM, "instructions": "i" * 200})
    assert (status, body["error"]["code"]) == (413, "too_large")


def test_write_rejects_duplicates_and_mixed_bodies(call: Call) -> None:
    _write(call)
    status, body = call("POST", "/v1/skills", {**FORM, "title": "funny moments first"})
    assert status == 409
    assert body["error"] == {
        "code": "conflict",
        "message": "You already have a skill called funny moments first. Pick another name.",
        "field": "title",
    }
    status, body = call("POST", "/v1/skills", {**FORM, "title": "Short form video playbook"})
    assert (status, body["error"]["field"]) == (409, "title")
    assert (
        body["error"]["message"]
        == "Clip Factory already has a skill called Short form video playbook. Pick another name."
    )
    assert call("POST", "/v1/skills", {**FORM, "skillId": ulid()})[0] == 400
    assert call("POST", "/v1/skills", {**FORM, "enabled": True})[0] == 400


# read


def test_get_builtin_and_unknown(call: Call) -> None:
    status, detail = call("GET", f"/v1/skills/{BUILTIN_ID}")
    assert status == 200
    assert detail["skill"]["builtin"] is True
    assert detail["content"].startswith("---")
    assert (detail["form"], detail["formBlocked"], detail["files"]) == (None, "builtin", [])
    assert call("GET", f"/v1/skills/{ulid()}")[0] == 404
    assert call("GET", "/v1/skills/builtin-nope")[0] == 404
    assert call("GET", "/v1/skills/not-an-id")[0] == 404


def test_get_too_long_for_the_form(call: Call, s3_client: FakeS3) -> None:
    long_md = "---\nname: long\ndescription: Long one.\n---\n" + "x" * 50_001 + "\n"
    _, body = _upload(call, s3_client, "SKILL.md", long_md.encode())
    skill_id = body["skill"]["skillId"]  # type: ignore[index]
    _, detail = call("GET", f"/v1/skills/{skill_id}")
    assert (detail["form"], detail["formBlocked"]) == (None, "too_long")


def test_another_owner_cannot_read(call: Call) -> None:
    skill = _write(call)
    assert call("GET", f"/v1/skills/{skill['skillId']}", sub=OTHER)[0] == 404
    assert call("DELETE", f"/v1/skills/{skill['skillId']}", sub=OTHER)[0] == 404


# update


def test_put_form_on_md_keeps_extra_frontmatter(call: Call, s3_client: FakeS3) -> None:
    md = "---\nname: my-skill\nlicense: MIT\ndescription: Old.\nmeta:\n  a: 1\n---\nOld body\n"
    _, body = _upload(call, s3_client, "SKILL.md", md.encode())
    skill = body["skill"]
    assert isinstance(skill, dict)
    old_key = next(k for k in s3_client.objects if skill["skillId"] in k)
    status, out = call("PUT", f"/v1/skills/{skill['skillId']}", {"version": 1, **FORM})
    assert status == 200, out
    new = out["skill"]
    assert (new["version"], new["name"], new["title"], new["source"]) == (
        2,
        "funny-moments-first",
        FORM["title"],
        "upload",
    )
    assert old_key not in s3_client.objects
    (new_key,) = [k for k in s3_client.objects if skill["skillId"] in k]
    text = s3_client.objects[new_key].decode()
    assert text.startswith('---\nname: funny-moments-first\ndescription: "Every time')
    assert "license: MIT\nmeta:\n  a: 1\n---\n" in text
    assert new["size"] == len(s3_client.objects[new_key])
    _, detail = call("GET", f"/v1/skills/{skill['skillId']}")
    assert detail["form"]["instructions"] == FORM["instructions"]
    # renaming to its own name is allowed
    assert call("PUT", f"/v1/skills/{skill['skillId']}", {"version": 2, **FORM})[0] == 200


def test_put_form_on_zip_keeps_every_other_member(call: Call, s3_client: FakeS3) -> None:
    data = make_zip({"my-skill/SKILL.md": SKILL, "my-skill/ref.bin": bytes(range(256)), "my-skill/b.md": "B"})
    _, body = _upload(call, s3_client, "skill.zip", data)
    skill_id = body["skill"]["skillId"]  # type: ignore[index]
    status, out = call("PUT", f"/v1/skills/{skill_id}", {"version": 1, **FORM})
    assert status == 200
    assert out["skill"]["format"] == "zip"
    (key,) = [k for k in s3_client.objects if skill_id in k]
    assert key.endswith("/skill.zip")
    with zipfile.ZipFile(io.BytesIO(data)) as before, zipfile.ZipFile(io.BytesIO(s3_client.objects[key])) as after:
        assert before.namelist() == after.namelist()
        for name in ("my-skill/ref.bin", "my-skill/b.md"):
            assert before.read(name) == after.read(name)
        assert read_frontmatter(after.read("my-skill/SKILL.md").decode()).name == "funny-moments-first"


def test_put_form_on_a_stored_locked_zip_is_400_not_500(call: Call, s3_client: FakeS3) -> None:
    _, body = _upload(call, s3_client, "skill.zip", make_zip({"my-skill/SKILL.md": SKILL, "my-skill/locked.bin": "s"}))
    skill_id = body["skill"]["skillId"]  # type: ignore[index]
    (key,) = [k for k in s3_client.objects if skill_id in k]
    s3_client.objects[key] = LOCKED  # an older upload, from before locked members were refused
    assert call("GET", f"/v1/skills/{skill_id}")[0] == 200  # the owner can still read it
    status, out = call("PUT", f"/v1/skills/{skill_id}", {"version": 1, **FORM})
    assert status == 400, out
    assert "password" in out["error"]["message"]
    assert s3_client.objects[key] == LOCKED


def test_put_replace_file(call: Call, s3_client: FakeS3) -> None:
    skill = _write(call)
    skill_id = str(skill["skillId"])
    old_key = next(k for k in s3_client.objects if skill_id in k)
    _, presign = _upload(call, s3_client, "skill.zip", make_zip({"SKILL.md": SKILL}), skill_id=skill_id)
    assert presign["skillId"] == skill_id
    status, out = call("PUT", f"/v1/skills/{skill_id}", {"version": 1, "key": presign["key"]})
    assert status == 200, out
    assert (out["skill"]["format"], out["skill"]["name"], out["skill"]["title"]) == ("zip", "my-skill", "My skill")
    assert out["skill"]["source"] == "upload"
    assert old_key not in s3_client.objects


def test_put_replace_file_name_clash_uses_upload_words(call: Call, s3_client: FakeS3) -> None:
    _write(call, title="My skill")
    other = _write(call, title="Other one")
    other_id = str(other["skillId"])
    _, presign = _upload(call, s3_client, "SKILL.md", SKILL.encode(), skill_id=other_id)
    status, body = call("PUT", f"/v1/skills/{other_id}", {"version": 1, "key": presign["key"]})
    assert (status, body["error"]["field"]) == (409, "title")
    assert body["error"]["message"] == (
        "You already have a skill called My skill. To change it, open it and tap Replace the whole file."
    )
    assert presign["key"] not in s3_client.objects
    builtin = SKILL.replace("my-skill", "short-form-video-playbook").encode()
    _, presign = _upload(call, s3_client, "SKILL.md", builtin, skill_id=other_id)
    status, body = call("PUT", f"/v1/skills/{other_id}", {"version": 1, "key": presign["key"]})
    assert status == 409
    assert body["error"]["message"].startswith("Clip Factory already has a skill called Short form video playbook.")


def test_put_replace_with_another_skills_key_is_refused(call: Call, s3_client: FakeS3) -> None:
    mine = _write(call)
    other = _write(call, title="Other one")
    _, presign = _upload(call, s3_client, "SKILL.md", SKILL.encode(), skill_id=str(other["skillId"]))
    status, body = call("PUT", f"/v1/skills/{mine['skillId']}", {"version": 1, "key": presign["key"]})
    assert status == 400
    assert body["error"]["message"] == "That upload does not belong to you."
    legacy = s3.legacy_skill_key(USER, str(mine["skillId"]), "md")
    s3_client.objects[legacy] = SKILL.encode()
    assert call("PUT", f"/v1/skills/{mine['skillId']}", {"version": 1, "key": legacy})[0] == 400


def test_put_stale_version_conflicts_and_keeps_the_old_file(call: Call, s3_client: FakeS3, table: FakeTable) -> None:
    skill = _write(call)
    skill_id = str(skill["skillId"])
    (old_key,) = [k for k in s3_client.objects if skill_id in k]
    status, body = call("PUT", f"/v1/skills/{skill_id}", {"version": 2, **FORM})
    assert status == 409
    assert body["error"]["message"] == "This skill was changed somewhere else. Load the newest one, then save again."
    # A save from another screen lands between our read and our write: the new object is deleted again.
    real_update = table.update_item

    def racing_update(**kw: object) -> dict[str, object]:
        real_update(**db.update_request(db.user_pk(USER), db.skill_sk(skill_id), {"version": 7}))
        return real_update(**kw)

    table.update_item = racing_update  # type: ignore[method-assign]
    status, _ = call("PUT", f"/v1/skills/{skill_id}", {"version": 1, **FORM, "instructions": "New words."})
    table.update_item = real_update  # type: ignore[method-assign]
    assert status == 409
    assert [k for k in s3_client.objects if skill_id in k] == [old_key]


def test_put_legacy_item_without_version(call: Call, s3_client: FakeS3, store: db.Store) -> None:
    skill_id = ulid()
    key = s3.legacy_skill_key(USER, skill_id, "md")
    s3_client.objects[key] = SKILL.encode()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.skill_sk(skill_id),
            "type": "skill",
            "userId": USER,
            "skillId": skill_id,
            "name": "my-skill",
            "description": "Find.",
            "enabled": False,
            "builtin": False,
            "format": "md",
            "size": len(SKILL),
            "createdAt": "2026-11-01T00:00:00.000Z",
            "key": key,
        }
    )
    status, out = call("PUT", f"/v1/skills/{skill_id}", {"version": 1, **FORM})
    assert status == 200
    assert out["skill"]["version"] == 2
    item = store.get(db.user_pk(USER), db.skill_sk(skill_id))
    assert item is not None
    assert "enabled" not in item
    assert key not in s3_client.objects


def test_put_rules(call: Call) -> None:
    assert call("PUT", f"/v1/skills/{BUILTIN_ID}", {"version": 1, **FORM})[0] == 409
    assert call("PUT", f"/v1/skills/{ulid()}", {"version": 1, **FORM})[0] == 404
    skill = _write(call)
    path = f"/v1/skills/{skill['skillId']}"
    assert call("PUT", path, FORM)[0] == 400  # no version
    assert call("PUT", path, {"version": 0, **FORM})[0] == 400
    assert call("PUT", path, {"version": 1, **FORM, "enabled": True})[0] == 400
    assert call("PUT", path, {"version": 1, **FORM, "title": ""})[0] == 400
    _write(call, title="Taken name")
    status, body = call("PUT", path, {"version": 1, **FORM, "title": "Taken Name"})
    assert (status, body["error"]["field"]) == (409, "title")
    assert body["error"]["message"] == "You already have a skill called Taken Name. Pick another name."


def test_patch_always_answers_no_switch(call: Call) -> None:
    skill = _write(call)
    for path, body in [
        (f"/v1/skills/{skill['skillId']}", {"enabled": False}),
        (f"/v1/skills/{BUILTIN_ID}", {"enabled": True}),
        (f"/v1/skills/{ulid()}", None),
    ]:
        status, out = call("PATCH", path, body)
        assert status == 400
        assert out["error"]["message"] == "Skills are always used now, so there is no switch."


# delete


def test_delete_removes_every_revision(call: Call, s3_client: FakeS3) -> None:
    status, body = call("DELETE", f"/v1/skills/{BUILTIN_ID}")
    assert status == 409
    assert body["error"]["message"].startswith("Built-in skills are part of Clip Factory.")
    skill = _write(call)
    skill_id = str(skill["skillId"])
    s3_client.objects[f"skills/{USER}/{skill_id}/{ulid()}/SKILL.md"] = b"left over"
    s3_client.objects[s3.legacy_skill_key(USER, skill_id, "zip")] = b"older"
    status, body = call("DELETE", f"/v1/skills/{skill_id}")
    assert (status, body) == (204, None)
    assert not any(skill_id in k for k in s3_client.objects)
    assert call("DELETE", f"/v1/skills/{skill_id}")[0] == 404


def test_builtin_content(call: Call) -> None:
    status, body = call("GET", f"/v1/skills/{BUILTIN_ID}/content")
    assert status == 200
    assert body["content"].startswith("---")
