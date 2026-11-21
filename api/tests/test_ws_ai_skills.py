"""Lamo Stories' own skills (docs/CONTRACTS.md §45.4 ``skills/``, §45.5 ``…/skills``, §45.6 ``Skill``, §45.26):
built-ins from ``stories/skills`` (read-only, can be switched off), skills written in the app or uploaded as a
SKILL.md (≤ 1 MB) or a .zip (≤ 20 MB), a new revision on every save (the last 10 kept, any restorable), enable and
disable, which agents use each, and delete (refused for built-ins). Clip Factory's skills are never read."""

from __future__ import annotations

from typing import Any

import pytest

from clipfactory_api.app import App
from clipfactory_api.workspaces import skills as skills_mod
from conftest import USER
from fakes import FakeS3, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    install,
    leaked,
    pk,
    prefix,
    skill_md,
    skill_zip,
    upload_skill,
    ws_call,
)

BUILTINS = ["driving-safety-teaching", "nonverbal-storytelling", "vertical-short-hooks"]
FORM = {"title": "Funny endings", "description": "Use it for every ending.", "instructions": "End on a big laugh."}


@pytest.fixture
def wcall(app: App) -> WsCall:
    install(app, FakeRuntime())
    return ws_call(app)


def _written(wcall: WsCall, **form: Any) -> dict[str, Any]:
    status, body = wcall("POST", f"{BASE}/skills", {**FORM, **form})
    assert status == 201, body
    return dict(body["skill"])


def test_built_ins_come_first_from_lamo_stories_own_folder(wcall: WsCall) -> None:
    status, body = wcall("GET", f"{BASE}/skills")
    assert status == 200
    assert [s["skillId"] for s in body["skills"]] == BUILTINS
    first = body["skills"][1]
    assert first["title"] == "Telling a story without words"
    assert (first["builtin"], first["source"], first["format"], first["enabled"]) == (True, "builtin", "md", True)
    assert first["agentIds"] == ["creative_director", "video_analysis", "storyboard", "character"]
    assert str(skills_mod.builtin_dir()).endswith(("stories/skills", "stories_skills"))
    status, got = wcall("GET", f"{BASE}/skills/nonverbal-storytelling")
    assert status == 200
    assert got["skill"]["content"].startswith("---\nname: nonverbal-storytelling")


def test_write_a_skill_in_the_app(wcall: WsCall, s3_client: FakeS3, table: FakeTable) -> None:
    skill = _written(wcall)
    assert (skill["title"], skill["source"], skill["format"], skill["enabled"]) == (
        "Funny endings",
        "written",
        "md",
        True,
    )
    assert skill["agentIds"] == []
    (rev,) = skill["revisions"]
    item = table.raw(pk(), f"SKILL#{skill['skillId']}")
    assert item is not None
    key = item["key"]
    assert key == f"{prefix()}skills/{skill['skillId']}/{rev['revisionId']}/SKILL.md"
    text = s3_client.objects[key].decode()
    assert text.startswith('---\nname: funny-endings\ndescription: "Use it for every ending."\n---')
    assert "End on a big laugh." in text
    _, got = wcall("GET", f"{BASE}/skills/{skill['skillId']}")
    assert "End on a big laugh." in got["skill"]["content"]
    assert leaked([skill, got]) == []


@pytest.mark.parametrize(
    ("form", "sentence"),
    [
        ({"title": ""}, "Give your skill a name."),
        ({"title": "x" * 61}, "The name is too long."),
        ({"description": "no"}, "Say when the agents should use it"),
        ({"instructions": " "}, "Write what the skill should do."),
    ],
)
def test_the_form_is_checked(wcall: WsCall, form: dict[str, Any], sentence: str) -> None:
    status, body = wcall("POST", f"{BASE}/skills", {**FORM, **form})
    assert status == 400
    assert body["error"]["message"].startswith(sentence)


def test_upload_a_skill_md_and_a_zip(wcall: WsCall, s3_client: FakeS3) -> None:
    up = upload_skill(wcall, s3_client, skill_md().encode())
    assert up["key"].startswith(f"{prefix()}skills/{up['skillId']}/")
    assert up["key"].endswith("/SKILL.md")
    assert up["headers"] == {"Content-Type": "text/markdown"}
    op, params, seconds = s3_client.presigned[-1]
    assert (op, params["Key"], seconds) == ("put_object", up["key"], 900)
    status, body = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})
    assert status == 201
    md = body["skill"]
    assert (md["title"], md["description"], md["source"], md["format"]) == (
        "Funny endings",
        "Use for every ending.",
        "upload",
        "md",
    )
    up = upload_skill(wcall, s3_client, skill_zip(extra={"notes.txt": b"hi"}), filename="funny.zip")
    assert up["headers"] == {"Content-Type": "application/zip"}
    status, body = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})
    assert status == 201
    assert body["skill"]["format"] == "zip"
    _, got = wcall("GET", f"{BASE}/skills/{up['skillId']}")
    assert got["skill"]["content"].startswith("---\nname: funny-endings")
    # the same upload cannot make the skill twice
    assert wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})[0] == 409


def test_bad_uploads_are_refused_and_their_file_deleted(wcall: WsCall, s3_client: FakeS3) -> None:
    assert wcall("POST", f"{BASE}/skills/uploads", {"filename": "notes.txt"})[0] == 400
    up = upload_skill(wcall, s3_client, b"no header here")
    status, body = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})
    assert status == 400
    assert "missing its name" in body["error"]["message"]
    assert up["key"] not in s3_client.objects
    up = upload_skill(wcall, s3_client, b"x" * (1024 * 1024 + 1))
    assert wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})[0] == 413
    assert up["key"] not in s3_client.objects
    up = upload_skill(wcall, s3_client, b"not a zip", filename="x.zip")
    assert wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})[0] == 400
    up = upload_skill(wcall, s3_client, skill_md().encode())
    status, body = wcall(
        "POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"].replace("SKILL.md", "x.md")}
    )
    assert status == 400
    # a key of another skill, another workspace or Clip Factory's skills/ prefix is never read
    for key in (
        f"skills/{USER}/{up['skillId']}/01JD0000000000000000000000/SKILL.md",
        f"ws/{USER}/other/skills/x/SKILL.md",
    ):
        assert wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": key})[0] == 400
    status, body = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"]})
    assert status == 400
    assert not [r for r in s3_client.reads if r.startswith("skills/")]


def test_every_save_is_a_revision_and_the_last_ten_are_kept(wcall: WsCall, s3_client: FakeS3, table: FakeTable) -> None:
    skill = _written(wcall)
    skill_id = skill["skillId"]
    first_key = table.raw(pk(), f"SKILL#{skill_id}")["key"]
    for n in range(11):
        status, body = wcall("PUT", f"{BASE}/skills/{skill_id}", {"version": n + 1, "instructions": f"Take {n}."})
        assert status == 200, body
    revisions = body["skill"]["revisions"]
    assert len(revisions) == 10
    assert body["skill"]["version"] == 12
    assert first_key not in s3_client.objects  # the oldest revisions' files are deleted
    _, got = wcall("GET", f"{BASE}/skills/{skill_id}")
    assert "Take 10." in got["skill"]["content"]
    assert got["skill"]["title"] == "Funny endings"
    # restore an older one: copied to a new revision, the words come back
    older = revisions[3]["revisionId"]
    status, body = wcall("POST", f"{BASE}/skills/{skill_id}/restore", {"revisionId": older})
    assert status == 200
    assert len(body["skill"]["revisions"]) == 10
    _, got = wcall("GET", f"{BASE}/skills/{skill_id}")
    assert "Take 7." in got["skill"]["content"]
    assert wcall("POST", f"{BASE}/skills/{skill_id}/restore", {"revisionId": "nope"})[0] == 404
    assert wcall("PUT", f"{BASE}/skills/{skill_id}", {"version": 1, "enabled": False})[0] == 409


def test_a_new_file_for_an_uploaded_skill(wcall: WsCall, s3_client: FakeS3) -> None:
    up = upload_skill(wcall, s3_client, skill_md().encode())
    _, body = wcall("POST", f"{BASE}/skills", {"skillId": up["skillId"], "key": up["key"]})
    again = upload_skill(
        wcall, s3_client, skill_zip(skill_md(name="big-laughs", description="Bigger.")), "x.zip", up["skillId"]
    )
    status, body = wcall("PUT", f"{BASE}/skills/{up['skillId']}", {"version": 1, "key": again["key"]})
    assert status == 200
    assert (body["skill"]["title"], body["skill"]["format"], len(body["skill"]["revisions"])) == (
        "Big laughs",
        "zip",
        2,
    )
    status, body = wcall("PUT", f"{BASE}/skills/{up['skillId']}", {"version": 2, "description": "Use it now."})
    assert status == 200
    assert body["skill"]["description"] == "Use it now."
    assert body["skill"]["format"] == "zip"
    assert wcall("PUT", f"{BASE}/skills/{up['skillId']}", {"version": 3, "key": again["key"], "title": "x"})[0] == 400


def test_switch_skills_on_and_off_built_ins_too(wcall: WsCall, table: FakeTable) -> None:
    status, body = wcall("PUT", f"{BASE}/skills/vertical-short-hooks", {"version": 0, "enabled": False})
    assert status == 200
    assert (body["skill"]["enabled"], body["skill"]["version"]) == (False, 1)
    assert table.raw(pk(), "SKILL#vertical-short-hooks")["builtin"] is True
    status, body = wcall("PUT", f"{BASE}/skills/vertical-short-hooks", {"version": 1, "enabled": True})
    assert (status, body["skill"]["enabled"]) == (200, True)
    mine = _written(wcall)
    status, body = wcall("PUT", f"{BASE}/skills/{mine['skillId']}", {"version": 1, "enabled": False})
    assert (status, body["skill"]["enabled"], len(body["skill"]["revisions"])) == (200, False, 1)


def test_built_ins_cannot_be_changed_or_deleted(wcall: WsCall) -> None:
    for body in ({"version": 0, "title": "Mine now"}, {"version": 0, "instructions": "x"}):
        status, got = wcall("PUT", f"{BASE}/skills/nonverbal-storytelling", body)
        assert status == 409
        assert got["error"]["message"].startswith("Built-in skills are part of Lamo Stories.")
    assert wcall("DELETE", f"{BASE}/skills/nonverbal-storytelling")[0] == 409
    assert wcall("POST", f"{BASE}/skills/nonverbal-storytelling/restore", {"revisionId": "x"})[0] == 409
    assert (
        wcall("POST", f"{BASE}/skills/uploads", {"filename": "SKILL.md", "skillId": "nonverbal-storytelling"})[0] == 409
    )


def test_delete_takes_the_skill_out_of_every_agent_and_its_files(
    wcall: WsCall, s3_client: FakeS3, table: FakeTable
) -> None:
    mine = _written(wcall)
    skill_id = mine["skillId"]
    assert (
        wcall("PATCH", f"{BASE}/agents/storyboard", {"version": 1, "skillIds": [skill_id, "nonverbal-storytelling"]})[0]
        == 200
    )
    status, _ = wcall("DELETE", f"{BASE}/skills/{skill_id}")
    assert status == 204
    assert table.raw(pk(), f"SKILL#{skill_id}") is None
    assert not [k for k in s3_client.objects if f"/skills/{skill_id}/" in k]
    _, agent = wcall("GET", f"{BASE}/agents/storyboard")
    assert agent["agent"]["skillIds"] == ["nonverbal-storytelling"]
    assert wcall("DELETE", f"{BASE}/skills/{skill_id}")[0] == 404
    assert wcall("GET", f"{BASE}/skills/{skill_id}")[0] == 404


def test_clip_factory_skills_are_invisible(wcall: WsCall, table: FakeTable, s3_client: FakeS3) -> None:
    table.items[(f"USER#{USER}", "SKILL#01JD0000000000000000000001")] = {
        "pk": f"USER#{USER}",
        "sk": "SKILL#01JD0000000000000000000001",
        "type": "skill",
        "userId": USER,
        "skillId": "01JD0000000000000000000001",
        "name": "clip-hooks",
    }
    s3_client.objects[f"skills/{USER}/01JD0000000000000000000001/r/SKILL.md"] = skill_md().encode()
    _, body = wcall("GET", f"{BASE}/skills")
    assert [s["skillId"] for s in body["skills"]] == BUILTINS
    assert wcall("GET", f"{BASE}/skills/01JD0000000000000000000001")[0] == 404
    assert wcall("GET", f"{BASE}/skills/short-form-video-playbook")[0] == 404  # Clip Factory's built-in
    assert not [
        c for c in table.calls if c[0] == "query" and c[1]["ExpressionAttributeValues"][":pk"] == f"USER#{USER}"
    ]
