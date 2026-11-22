"""Design with AI: the character agent's ``CharacterInput`` drafts from words or a picture (§45.8, §45.26, §45.33)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from lamostories_agent.tasks import design
from lamostories_agent.tasks.catalog import engine_catalog, ids
from lamostories_agent.tasks.characters import character_schema, check_character
from lamostories_agent.tasks.work import run_task
from test_tasks_support import (
    PK,
    USER,
    WS,
    FakeImages,
    FakeModel,
    character_item,
    good_character,
    reply,
    services,
    task_item,
)

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}
KEY = f"ws/{USER}/{WS}/design/A1.png"


def run(svc) -> str:
    return asyncio.run(run_task(svc, PAYLOAD))


def test_the_schema_comes_from_the_engines_catalog() -> None:
    cat = engine_catalog()
    schema = character_schema(cat)
    look = schema["properties"]["look"]["properties"]
    assert look["body"]["enum"] == ids(cat, "looks", "body")
    assert look["hair"]["properties"]["style"]["enum"] == ids(cat, "looks", "hair")
    assert schema["properties"]["voice"]["properties"]["noises"]["items"]["enum"] == ids(cat, "noises")
    assert "neutral" in schema["properties"]["expressions"]["items"]["enum"]

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False and set(node["required"]) == set(node["properties"])
            if isinstance(node.get("type"), str):
                for bad in ("minimum", "maximum", "minLength", "maxLength", "pattern"):
                    assert bad not in node  # structured outputs take no numeric or length limits
            for v in node.values():
                walk(v)

    walk(schema)


def test_check_character_keeps_only_catalog_choices_and_fixes_slips() -> None:
    cat = engine_catalog()
    value, problems = check_character(good_character(), cat)
    assert problems == [] and value is not None
    assert value["look"]["width"] == 1.15  # clamped into 0.85..1.15
    assert value["look"]["skin"] == "#f2c9a0"
    bad = good_character()
    bad["look"]["body"] = "triangle"
    assert check_character(bad, cat)[0] is None
    raw = good_character()
    raw["expressions"] = ["happy", "sad", "grumpy"]
    value, problems = check_character(raw, cat)
    assert value is not None and value["expressions"] == ["neutral", "happy", "sad"] and problems  # neutral added
    assert check_character(good_character("Bo"), cat, taken_names=["bo"])[0] is None


def test_design_from_a_description(tmp_path: Path) -> None:
    model = FakeModel(reply(data=good_character()))
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Bo"))
    db.seed(task_item("T1", "character_design", input={"description": "a nervous driver who loves scarves"}))
    assert run(svc) == "done"
    character = db.get(PK, "TASK#T1")["result"]["character"]
    assert character["name"] == "Pip" and character["look"]["accessory"] == "scarf"
    call = model.calls[0]
    assert call["task"] == "character_design" and call["ctx"].agent_id == "character"
    assert "a nervous driver who loves scarves" in model.texts(0) and '"Bo"' in model.texts(0)
    assert db.prefixed(PK, "CHAR#") == [db.get(PK, "CHAR#C1")]  # nothing saved


def test_design_from_a_picture_goes_through_the_picture_helper(tmp_path: Path) -> None:
    images = FakeImages()
    model = FakeModel(reply(data=good_character()))
    svc, db, s3 = services(tmp_path, model, images=images)
    s3.objects[KEY] = b"png-bytes"
    db.seed(
        {
            "pk": PK,
            "sk": "ASSET#A1",
            "userId": USER,
            "workspaceId": WS,
            "assetId": "A1",
            "kind": "design_ref",
            "key": KEY,
        }
    )
    db.seed(task_item("T1", "character_design", input={"referenceAssetId": "A1"}))
    assert run(svc) == "done"
    assert len(images.paths) == 1 and s3.reads == [KEY]
    assert model.images(0) == [{"image": {"format": "jpeg", "source": {"bytes": b"\xff\xd8jpeg:picture.png"}}}]
    assert not any((tmp_path / "work").glob("design-*"))  # the download is cleaned up


def test_a_picture_from_outside_the_workspace_is_refused(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, s3 = services(tmp_path, model)
    s3.objects["uploads/clip.png"] = b"x"
    db.seed(
        {
            "pk": PK,
            "sk": "ASSET#A1",
            "userId": USER,
            "workspaceId": WS,
            "assetId": "A1",
            "kind": "design_ref",
            "key": "uploads/clip.png",
        }
    )
    db.seed(
        {
            "pk": PK,
            "sk": "ASSET#A2",
            "userId": USER,
            "workspaceId": WS,
            "assetId": "A2",
            "kind": "final_video",
            "key": KEY,
        }
    )
    db.seed(task_item("T1", "character_design", input={"referenceAssetId": "A1"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == design.NO_PICTURE
    db.seed(task_item("T1", "character_design", input={"referenceAssetId": "A2"}))
    assert run(svc) == "failed"
    assert s3.reads == [] and model.calls == []


def test_a_picture_the_helper_cannot_open_fails_with_its_sentence(tmp_path: Path) -> None:
    svc, db, s3 = services(tmp_path, FakeModel(), images=FakeImages(fail=True))
    s3.objects[KEY] = b"x"
    db.seed(
        {
            "pk": PK,
            "sk": "ASSET#A1",
            "userId": USER,
            "workspaceId": WS,
            "assetId": "A1",
            "kind": "design_ref",
            "key": KEY,
        }
    )
    db.seed(task_item("T1", "character_design", input={"referenceAssetId": "A1"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "I can't open that picture. Try a screenshot or a photo."


def test_an_answer_outside_the_catalog_is_asked_again(tmp_path: Path) -> None:
    bad = good_character()
    bad["movementStyle"] = "moonwalk"
    model = FakeModel(reply(data=bad), reply(data=good_character()))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"description": "x"}))
    assert run(svc) == "done"
    assert "movementStyle must be one of" in model.texts(1)


def test_nothing_to_go_on(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(task_item("T1", "character_design", input={}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == design.NEEDS_SOMETHING


def test_a_redesign_starts_from_the_saved_character_and_keeps_its_name(tmp_path: Path) -> None:
    """§45.34: with characterId the agent gets that character as CURRENT, its name is not TAKEN (so keeping it is
    fine) and it is asked to change only what the owner described."""
    saved = character_item("C1", "Pip", description="A tiny courier.", look=good_character()["look"])
    redesigned = good_character("Pip")
    model = FakeModel(reply(data=redesigned))
    svc, db, _ = services(tmp_path, model)
    db.seed(saved)
    db.seed(character_item("C2", "Bo"))
    db.seed(task_item("T1", "character_design", input={"description": "give Pip a red scarf", "characterId": "C1"}))
    assert run(svc) == "done"
    assert len(model.calls) == 1  # no second paid call for "already used by another character"
    assert db.get(PK, "TASK#T1")["result"]["character"]["name"] == "Pip"
    text = model.texts(0)
    assert "This is a redesign of the saved character in CURRENT" in text and "Keep its name exactly" in text
    data = json.loads(text.split("DATA as JSON:\n", 1)[1])
    assert data["taken"] == ["Bo"]  # its own name is left out
    assert data["current"]["name"] == "Pip" and data["current"]["description"] == "A tiny courier."
    assert data["current"]["expressions"] == ["neutral", "happy", "surprised"]
    assert data["current"]["look"] == saved["look"] and data["description"] == "give Pip a red scarf"


def test_a_redesign_of_a_character_that_is_gone_says_so(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, _ = services(tmp_path, model)
    db.seed({**character_item("C9", "Other"), "workspaceId": "someone-else"})
    db.seed(task_item("T1", "character_design", input={"description": "x", "characterId": "C9"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == design.GONE and model.calls == []


def test_a_new_design_still_keeps_every_saved_name_taken(tmp_path: Path) -> None:
    model = FakeModel(reply(data=good_character()))
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Bo"))
    db.seed(task_item("T1", "character_design", input={"description": "someone new"}))
    assert run(svc) == "done"
    data = json.loads(model.texts(0).split("DATA as JSON:\n", 1)[1])
    assert data["taken"] == ["Bo"] and "current" not in data
    assert "redesign" not in model.texts(0)
