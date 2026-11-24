"""Car characters from real photos (docs/CONTRACTS.md §45.42): several photos, several cartoon options in one call,
no makes in the words, and the car's portrait prompt and chat refusal."""

from __future__ import annotations

import asyncio
import copy
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import images
from lamostories_agent.chat import tools
from lamostories_agent.portrait import portrait_prompt
from lamostories_agent.tasks import design
from lamostories_agent.tasks.catalog import engine_catalog, ids
from lamostories_agent.tasks.characters import BRANDS, car_schema, car_words, check_car, strip_brands
from lamostories_agent.tasks.fence import MSG_LIVE, Fence
from lamostories_agent.tasks.work import run_task
from test_tasks_support import PK, USER, WS, FakeModel, character_item, good_character, reply, services, task_item

PAYLOAD = {"userId": USER, "workspaceId": WS, "taskId": "T1"}

CAR: dict[str, Any] = {
    "body": "hatchback",
    "length": 1,
    "height": 1,
    "paint": "#d8352a",
    "accent": "#f4f1ea",
    "pattern": "plain",
    "windows": "clear",
    "wheels": {"style": "alloy", "rim": "#c9ccd2", "size": 1},
    "lights": {"front": "round", "rear": "bar"},
    "extra": "none",
    "face": {"eyes": "none", "color": "#1c1842", "mouth": "none"},
    "outline": "#1c1842",
}


def a_car(name: str = "Rosso", **extra: Any) -> dict[str, Any]:
    return {
        "kind": "car",
        "name": name,
        "description": "A small red hatchback, a bit old, always ready.",
        "personality": "Eager and a little nervous on hills.",
        "traits": ["eager", "loyal"],
        "movementStyle": "zippy",
        "expressions": ["neutral"],
        "car": copy.deepcopy(CAR),
        "voice": {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine", "honk"]},
        **extra,
    }


def answer(*variants: dict[str, Any], problem: str | None = None) -> Any:
    return reply(data={"variants": list(variants), "problem": problem})


class SizedImages:
    """The picture helper, keeping the long edge each photo was asked for (None: the helper's own default)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, int | None]] = []

    def __call__(self, path: Path, long_edge: int | None = None) -> bytes:
        assert path.exists(), path
        self.calls.append((path.name, long_edge))
        return b"\xff\xd8jpeg:" + str(len(self.calls)).encode()


def run(svc: Any) -> str:
    return asyncio.run(run_task(svc, PAYLOAD))


def seed_photos(db: Any, s3: Any, n: int) -> list[str]:
    out = []
    for i in range(n):
        key = f"ws/{USER}/{WS}/design/P{i}.jpg"
        s3.objects[key] = b"jpeg"
        db.seed({"pk": PK, "sk": f"ASSET#P{i}", "userId": USER, "workspaceId": WS, "assetId": f"P{i}",
                 "kind": "design_ref", "key": key})  # fmt: skip
        out.append(f"P{i}")
    return out


def car_task(asset_ids: list[str], **extra: Any) -> dict[str, Any]:
    refs = [{"assetId": a, "key": f"ws/{USER}/{WS}/design/{a}.jpg", "contentType": "image/jpeg"} for a in asset_ids]
    return task_item("T1", "character_design", input={"kind": "car", "count": 3, "references": refs, **extra})


def data_of(model: FakeModel, n: int = 0) -> dict[str, Any]:
    return dict(json.loads(model.texts(n).split("DATA as JSON:\n", 1)[1]))


# --- the schema and the check -----------------------------------------------------------------------------------


def test_the_car_schema_comes_from_the_engines_car_catalog() -> None:
    cat = engine_catalog()
    schema = car_schema(cat)
    car = schema["properties"]["car"]["properties"]
    assert schema["properties"]["kind"]["enum"] == ["car"]
    assert car["body"]["enum"] == ids(cat, "carLooks", "body")
    assert car["wheels"]["properties"]["style"]["enum"] == ids(cat, "carLooks", "wheels")
    assert car["face"]["properties"]["eyes"]["enum"] == ["none", "windscreen", "headlights"]
    voice = schema["properties"]["voice"]["properties"]
    assert voice["style"]["enum"] == ["none"] and voice["noises"]["maxItems"] == 0
    assert voice["sfx"]["items"]["enum"] == ids(cat, "sfx")
    assert "look" not in schema["properties"]

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False and set(node["required"]) == set(node["properties"])
            if isinstance(node.get("type"), str):
                for bad in ("minimum", "maximum", "minLength", "maxLength", "pattern"):
                    assert bad not in node
            for v in node.values():
                walk(v)

    walk(schema)
    walk(design.design_schema(cat, 3))


def test_check_car_clamps_forces_no_voice_and_keeps_faces_to_the_rule() -> None:
    cat = engine_catalog()
    value, problems = check_car(a_car(), cat)
    assert problems == [] and value is not None
    assert value["kind"] == "car" and value["car"] == CAR and "look" not in value
    raw = a_car(voice={"style": "babble", "pitch": 1.7, "noises": ["gasp"], "sfx": ["engine", "vroom"]})
    raw["car"]["length"] = 1.4
    raw["expressions"] = ["neutral", "happy", "sad"]
    value, problems = check_car(raw, cat)
    assert value is not None and problems  # the bad effect is reported, so the first answer is asked again
    assert value["voice"] == {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine"]}
    assert value["car"]["length"] == 1.15
    assert value["expressions"] == ["neutral"]  # no eyes: only the neutral face
    eyes = a_car(expressions=["neutral"])
    eyes["car"]["face"] = {"eyes": "windscreen", "color": "#1c1842", "mouth": "grille"}
    value, problems = check_car(eyes, cat)
    assert value is not None and value["expressions"] == ["neutral", "happy", "surprised"] and problems
    bad = a_car()
    bad["car"]["body"] = "limo"
    assert check_car(bad, cat)[0] is None
    assert check_car(a_car("Bo"), cat, taken_names=[" bo "])[0] is None
    assert check_car("a car", cat)[0] is None


def test_a_make_in_the_words_is_reported_then_replaced() -> None:
    cat = engine_catalog()
    raw = a_car("Ferrari", description="A red Volkswagen Golf, a bit old.", traits=["fast like a Porsche", "loyal"])
    value, problems = check_car(raw, cat)
    assert value is not None
    assert any("do not use car brand or model names" in p for p in problems)
    assert value["name"] == "Car"
    assert value["description"] == "A red car Golf, a bit old."
    assert value["traits"] == ["fast like a car", "loyal"]
    assert strip_brands("my land rover and a Mercedes-Benz") == ("my car and a car", ["land rover", "Mercedes-Benz"])
    assert strip_brands("a mini seat that is smart") == ("a mini seat that is smart", [])
    assert strip_brands("Fordham Road") == ("Fordham Road", [])  # whole words only
    assert "toyota" in BRANDS and "mini" not in BRANDS
    # models and nicknames too, and a make with a hyphen after it; everyday words that are also models stay
    assert strip_brands("my Corolla, the Merc and a Mini Cooper") == ("my car, the car and a car",
                                                                     ["Corolla", "Merc", "Mini Cooper"])  # fmt: skip
    assert strip_brands("a BMW-ish Model 3") == ("a car-ish car", ["BMW", "Model 3"])
    assert strip_brands("a Toyota Corolla") == ("a car", ["Toyota", "Corolla"])
    assert strip_brands("golf, a beetle and a merchant") == ("golf, a beetle and a merchant", [])


@pytest.mark.parametrize(
    ("change", "words"),
    [
        ({}, "a red hatchback with alloy wheels and round lights"),
        ({"length": 0.9}, "a small red hatchback with alloy wheels and round lights"),
        ({"length": 1.1, "paint": "#2f6fd1", "body": "sedan"}, "a long blue saloon with alloy wheels and round lights"),
        ({"paint": "#ff8c28", "body": "suv", "wheels": {"style": "offroad"}}, "an orange SUV with off-road tyres and round lights"),
        ({"face": {"eyes": "windscreen"}}, "a red hatchback with alloy wheels, round lights and eyes on its windscreen"),
        ({"paint": "#f4f1ea", "body": "compact", "lights": {"front": "slim"}}, "a white tiny car with alloy wheels and slim lights"),
    ],
)  # fmt: skip
def test_car_words(change: dict[str, Any], words: str) -> None:
    assert car_words({**CAR, **change}) == words
    assert len(car_words({**CAR, **change})) <= 80


# --- the task ---------------------------------------------------------------------------------------------------


def test_four_photos_make_four_labelled_pictures_at_1024_and_three_options(tmp_path: Path) -> None:
    images_ = SizedImages()
    model = FakeModel(answer(a_car("Rosso"), a_car("Ruby"), a_car("Rocket")))
    svc, db, s3 = services(tmp_path, model, images=images_)  # type: ignore[arg-type]
    db.seed(character_item("C1", "Pip"))
    db.seed(car_task(seed_photos(db, s3, 4), description="my red hatchback, a bit old"))
    assert run(svc) == "done"
    assert images_.calls == [("picture.jpg", 1024)] * 4
    content = model.calls[0]["messages"][0]["content"]
    labels = [b["text"] for b in content if "text" in b and b["text"].startswith("Photo ")]
    assert labels == ["Photo 1 of 4:", "Photo 2 of 4:", "Photo 3 of 4:", "Photo 4 of 4:"]
    kinds = ["image" if "image" in b else b["text"][:6] for b in content]
    assert kinds[1:9] == ["Photo ", "image"] * 4  # each label right before its photo
    assert content[0]["text"].startswith("Turn the real car in the PHOTOS into 3 cartoon car characters")
    data = data_of(model)
    assert data["count"] == 3 and data["taken"] == ["Pip"] and data["description"] == "my red hatchback, a bit old"
    assert set(data["catalog"]) == {"carLooks", "expressions", "movementStyles", "sfx"}
    assert [e["id"] for e in data["catalog"]["carLooks"]["body"]][:2] == ["hatchback", "sedan"]
    result = db.get(PK, "TASK#T1")["result"]
    assert [c["name"] for c in result["characters"]] == ["Rosso", "Ruby", "Rocket"]
    assert result["character"] == result["characters"][0]
    assert model.calls[0]["task"] == "character_design" and model.calls[0]["ctx"].agent_id == "character"
    assert not any((tmp_path / "work").glob("design-*"))  # every download is cleaned up
    assert db.prefixed(PK, "CHAR#") == [db.get(PK, "CHAR#C1")]  # nothing saved


def test_one_photo_that_cannot_be_opened_is_named(tmp_path: Path) -> None:
    seen: list[int] = []

    def opens(path: Path, long_edge: int | None = None) -> bytes:
        seen.append(1)
        if len(seen) == 3:
            raise ValueError("not a picture")
        return b"\xff\xd8jpeg"

    model = FakeModel()
    svc, db, s3 = services(tmp_path, model, images=opens)  # type: ignore[arg-type]
    db.seed(car_task(seed_photos(db, s3, 4)))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Photo 3 can't be opened. Remove it and try again."
    assert model.calls == []
    assert not any((tmp_path / "work").glob("design-*"))


def test_up_to_three_photos_go_at_the_helpers_own_size(tmp_path: Path) -> None:
    images_ = SizedImages()
    model = FakeModel(answer(a_car("Rosso"), a_car("Ruby"), a_car("Rocket")))
    svc, db, s3 = services(tmp_path, model, images=images_)  # type: ignore[arg-type]
    db.seed(car_task(seed_photos(db, s3, 3)))
    assert run(svc) == "done"
    assert images_.calls == [("picture.jpg", None)] * 3  # 1568 px: the helper's default


def test_max_tokens_grows_with_the_count(tmp_path: Path) -> None:
    for count, tokens in ((1, 18000), (3, 30000), (4, 36000)):
        model = FakeModel(answer(*[a_car(f"Car{i}") for i in range(count)]))
        svc, db, _ = services(tmp_path, model)
        db.seed(task_item("T1", "character_design", input={"kind": "car", "count": count, "description": "a red car"}))
        assert run(svc) == "done"
        assert model.calls[0]["max_tokens"] == tokens
        assert len(db.get(PK, "TASK#T1")["result"]["characters"]) == count


def test_each_option_is_checked_and_a_taken_name_is_asked_again(tmp_path: Path) -> None:
    model = FakeModel(
        answer(a_car("Pip"), a_car("Ruby"), a_car("Ruby")),  # Pip is saved; the second Ruby repeats the first
        answer(a_car("Rosso"), a_car("Ruby"), a_car("Rocket")),
    )
    svc, db, _ = services(tmp_path, model)
    db.seed(character_item("C1", "Pip"))
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 3, "description": "a red car"}))
    assert run(svc) == "done"
    text = model.texts(1)
    assert "option 1: the name Pip is already used" in text and "option 3: the name Ruby is already used" in text
    assert [c["name"] for c in db.get(PK, "TASK#T1")["result"]["characters"]] == ["Rosso", "Ruby", "Rocket"]


def test_on_the_last_try_the_valid_options_are_kept(tmp_path: Path) -> None:
    bad = a_car("Broken")
    bad["car"]["wheels"]["style"] = "spinners"
    model = FakeModel(answer(a_car("Rosso"), bad), answer(a_car("Rosso"), bad))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 3, "description": "a red car"}))
    assert run(svc) == "done"
    assert [c["name"] for c in db.get(PK, "TASK#T1")["result"]["characters"]] == ["Rosso"]
    assert "give 3 valid options; 1 were valid" in model.texts(1)


def test_nothing_valid_fails_with_the_car_helpers_sentence(tmp_path: Path) -> None:
    bad = a_car()
    bad["car"] = {}
    model = FakeModel(answer(bad), answer(bad))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "description": "a red car"}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "The car helper could not finish. Tap Try again."


def test_a_make_in_a_name_is_asked_again_then_replaced(tmp_path: Path) -> None:
    model = FakeModel(answer(a_car("Ferrari Fred")), answer(a_car("Ferrari Fred")))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 1, "description": "a red car"}))
    assert run(svc) == "done"
    assert len(model.calls) == 2 and "do not use car brand or model names (found: ferrari)" in model.texts(1)
    assert db.get(PK, "TASK#T1")["result"]["character"]["name"] == "car Fred"


def test_photos_that_show_no_car_say_so(tmp_path: Path) -> None:
    model = FakeModel(answer(problem="These are photos of a cat."))
    svc, db, s3 = services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 2)))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Those photos don't show a car. Try other photos."
    assert len(model.calls) == 1


def test_a_model_that_cannot_see_pictures_is_refused_before_any_call(tmp_path: Path) -> None:
    model = FakeModel()
    svc, db, s3 = services(tmp_path, model)
    db.seed({"pk": PK, "sk": "MODELDEF#custom-text", "userId": USER, "workspaceId": WS, "key": "custom-text",
             "label": "Text Only (mine)", "provider": "Mistral", "modelId": "mistral.text-only", "region": None,
             "efforts": [], "defaultEffort": None, "vision": False, "maxOutputTokens": 4096, "price": None})  # fmt: skip
    task = car_task(seed_photos(db, s3, 2))
    db.seed({**task, "override": {"model": "custom-text"}})
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == design.NO_VISION.format(label="Text Only (mine)")
    assert model.calls == [] and s3.reads == []


def test_nothing_to_go_on_for_a_car(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 3, "references": []}))
    assert run(svc) == "failed"
    assert db.get(PK, "TASK#T1")["error"] == "Add a photo of your car, or say what it is like."


def test_make_more_sends_avoid_and_a_redesign_keeps_the_saved_name(tmp_path: Path) -> None:
    saved = character_item("C1", "Rosso", kind="car", car=CAR, description="A small red hatchback.")
    model = FakeModel(answer(a_car("Rosso"), a_car("Rosso"), a_car("Rosso")))
    svc, db, _ = services(tmp_path, model)
    db.seed(saved)
    blue = {**CAR, "paint": "#2f6fd1"}
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 3, "description": "make it sportier",
                                                       "characterId": "C1", "avoid": [CAR, blue]}))  # fmt: skip
    assert run(svc) == "done"
    assert len(model.calls) == 1  # the saved name is not "taken" by the options of its own redesign
    text = model.texts(0)
    assert "This is a redesign of the saved car in CURRENT" in text
    data = data_of(model)
    assert data["avoid"] == [CAR, blue] and data["current"]["car"] == CAR and data["current"]["name"] == "Rosso"
    assert data["taken"] == []
    assert [c["name"] for c in db.get(PK, "TASK#T1")["result"]["characters"]] == ["Rosso"] * 3


def test_a_person_with_several_photos_still_makes_one_character(tmp_path: Path) -> None:
    images_ = SizedImages()
    model = FakeModel(reply(data=good_character()))
    svc, db, s3 = services(tmp_path, model, images=images_)  # type: ignore[arg-type]
    ids_ = seed_photos(db, s3, 2)
    refs = [{"assetId": a, "key": "", "contentType": "image/jpeg"} for a in ids_]
    db.seed(task_item("T1", "character_design", input={"kind": "person", "count": 1, "references": refs}))
    assert run(svc) == "done"
    assert images_.calls == [("picture.jpg", None)] * 2
    assert "Photo 1 of 2:" in model.texts(0) and "Photo 2 of 2:" in model.texts(0)
    assert model.texts(0).startswith("Design one recurring cartoon character")  # the person brief, unchanged
    result = db.get(PK, "TASK#T1")["result"]
    assert result["characters"] == [result["character"]] and result["character"]["name"] == "Pip"
    assert model.calls[0]["max_tokens"] == 16000


# --- the picture helper, the portrait and the chat ------------------------------------------------------------------

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@needs_ffmpeg
def test_the_picture_helper_takes_a_smaller_long_edge(tmp_path: Path) -> None:
    big = tmp_path / "big.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=3000x2000", "-frames:v", "1",
                    str(big)], check=True, timeout=60)  # fmt: skip
    out = tmp_path / "out.jpg"
    out.write_bytes(images.to_model_image(big, long_edge=1024))
    dims = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0",
                           str(out)], capture_output=True, text=True, check=True).stdout.strip()  # fmt: skip
    w, h = (int(x) for x in dims.split(","))
    assert max(w, h) <= 1024 and w / h == pytest.approx(1.5, abs=0.01)


def test_a_cars_portrait_is_the_car_in_words_with_no_badges_or_plate() -> None:
    prompt = portrait_prompt({"kind": "car", "name": "Rosso", "car": {**CAR, "length": 0.9}})
    assert prompt == (
        "A friendly cartoon small red hatchback with alloy wheels and round lights, three-quarter view, bold clean "
        "outline, flat colours, plain soft background. No logos, no badges, no text, no number plate."
    )
    assert portrait_prompt({**good_character(), "kind": "person"}).startswith("A friendly flat 2D cartoon character")


def test_the_chat_does_not_draft_a_car(tmp_path: Path) -> None:
    svc, db, _ = services(tmp_path, FakeModel())
    sk = "MSG#S1#M1"
    db.seed({"pk": PK, "sk": sk, "userId": USER, "workspaceId": WS, "status": "streaming", "sessionId": "s1"})
    tb = tools.Toolbox(svc, USER, WS, PK, Fence(svc.store, PK, sk, "s1", live=MSG_LIVE), catalog=svc.catalog)
    result, ok = tb.run("propose_character", {"character": a_car()})
    assert not ok and result["error"] == "Make cars in Characters: tap New character, then A car."
    assert tb.actions == []
