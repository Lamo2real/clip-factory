"""Car characters from real photos (docs/CONTRACTS.md §45.42): several photos, several cartoon options in one call,
no makes in the words, and the car's portrait prompt and chat refusal."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import images
from lamostories_agent.chat import tools
from lamostories_agent.engine import character_errors
from lamostories_agent.portrait import portrait_prompt
from lamostories_agent.tasks import characters, design
from lamostories_agent.tasks.catalog import engine_catalog, ids
from lamostories_agent.tasks.characters import (
    BRANDS,
    car_schema,
    car_words,
    check_car,
    check_detail,
    detail_rules,
    detail_schema,
    has_profile,
    read_study,
    strip_brands,
)
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
    assert value["name"] == "Vehicle"  # §45.47: the visible word is Vehicle
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


def test_four_photos_make_four_labelled_pictures_at_full_size_and_three_options(tmp_path: Path) -> None:
    images_ = SizedImages()
    model = FakeModel(answer(a_car("Rosso"), a_car("Ruby"), a_car("Rocket")))
    svc, db, s3 = services(tmp_path, model, images=images_)  # type: ignore[arg-type]
    db.seed(character_item("C1", "Pip"))
    db.seed(car_task(seed_photos(db, s3, 4), description="my red hatchback, a bit old"))
    assert run(svc) == "done"
    assert images_.calls == [("picture.jpg", None)] * 4  # 1568 px up to four photos (§45.48)
    content = model.calls[0]["messages"][0]["content"]
    labels = [b["text"] for b in content if "text" in b and b["text"].startswith("Photo ")]
    assert labels == ["Photo 1 of 4:", "Photo 2 of 4:", "Photo 3 of 4:", "Photo 4 of 4:"]
    kinds = ["image" if "image" in b else b["text"][:6] for b in content]
    # each label right before its photo (after the two briefs)
    assert content[0]["text"].startswith("Turn the real car in the PHOTOS into 3 cartoon car characters")
    assert content[1]["text"].startswith("The lines below are newer than the lines above")  # the detail brief
    assert kinds[2:10] == ["Photo ", "image"] * 4
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
    for count, tokens in ((1, 24000), (3, 40000), (4, 48000)):
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
    assert db.get(PK, "TASK#T1")["error"] == "Those photos don't show a vehicle. Try other photos."
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
    assert db.get(PK, "TASK#T1")["error"] == "Add a photo of your vehicle, or say what it is like."


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


# --- a vehicle's likeness: detail, study, shared outline (docs/CONTRACTS.md §45.48) ---------------------------------

FIXTURE = Path(__file__).resolve().parents[3] / "web" / "test" / "fixtures" / "car-detail-looks.json"


def detail_cat() -> dict[str, Any]:
    cat = engine_catalog()
    assert cat["carDetail"]["rules"], "the engine's catalog has no carDetail"
    return cat


def rules_of() -> dict[str, Any]:
    return detail_rules(detail_cat()) or {}


def presets_of() -> dict[str, Any]:
    return dict(detail_cat()["carDetail"]["presets"]["profile"])


def spider_profile() -> dict[str, Any]:
    return copy.deepcopy(design.DETAIL_EXAMPLES[0]["profile"])


def spider_detail() -> dict[str, Any]:
    return {
        "v": 1,
        "toon": 30,
        "profile": spider_profile(),
        "roof": {"type": "open", "hoops": "twin"},
        "wheels": {"shape": "split", "spokes": 5, "tyre": 22, "lip": 10},
        "brakes": {"disc": "ceramic", "caliper": "#ffd21f"},
        "lights": {"front": {"shape": "swept", "drl": "line"}, "rear": {"shape": "round"}},
        "front": {"grille": "none", "intake": "split3", "splitter": "blade", "bumper": "body"},
        "bonnet": {"vent": "duct"},
        "side": {
            "intake": "scoop",
            "intakeX": 66,
            "skirts": "lip",
            "doors": 1,
            "handles": "flush",
            "crease": "wedge",
            "mirror": "stalk",
        },
        "rear": {"diffuser": "fins", "exhaust": "high", "spoiler": "ducktail"},
        "stripe": {"layout": "centre", "color": "#111111", "width": 60},
        "finish": "satin",
        "cabin": {"rows": 1, "seat": "#1b1b1d", "dial": "#ffd21f", "wheel": "flat"},
    }


def a_detailed_car(name: str = "Dart", detail: Any = None, **car: Any) -> dict[str, Any]:
    value = a_car(name)
    value["car"].update({"body": "sports", "paint": "#55575a", "length": 1.1, "height": 0.9, **car})
    value["car"]["detail"] = spider_detail() if detail is None else detail
    return value


@pytest.fixture
def engine_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """The engine's own check passes (the live engine is tested once, below)."""
    monkeypatch.setattr(design, "character_errors", lambda value: [])


def strict(detail: Any, rules: dict[str, Any]) -> list[str]:
    """The engine's walker in words (CONTRACTS §45.48): the problems of a detail, none when it is valid."""
    out: list[str] = []
    if not isinstance(detail, dict):
        return ["not an object"]
    if detail.get("v") != 1 or isinstance(detail.get("v"), bool):
        out.append("v")
    if len(json.dumps(detail, separators=(",", ":"))) > 2400:
        out.append("too long")

    def walk(node: dict[str, Any], prefix: str) -> None:
        for key, value in node.items():
            path = prefix + key
            if path == "v":
                continue
            rule = rules.get(path)
            if rule is None:
                if isinstance(value, dict) and any(r.startswith(path + ".") for r in rules):
                    walk(value, path + ".")
                else:
                    out.append(path)
            elif "e" in rule:
                if value not in rule["e"]:
                    out.append(path)
            elif "n" in rule:
                lo, hi = rule["n"]
                if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                    out.append(path)
            elif "c" in rule:
                if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-f]{6}", value):
                    out.append(path)
            elif "b" in rule:
                if not isinstance(value, bool):
                    out.append(path)
            elif "l" in rule and (
                not isinstance(value, list)
                or len(value) > rule["max"]
                or len(set(value)) != len(value)
                or any(v not in rule["l"] for v in value)
            ):
                out.append(path)

    walk(detail, "")
    profile = detail.get("profile")
    if isinstance(profile, dict) and len(profile) < len([r for r in rules if r.startswith("profile.")]):
        out.append("profile")
    return out


def test_the_shared_fixture_is_kept_by_the_check_and_repaired_when_wrong() -> None:
    if not FIXTURE.is_file():
        pytest.skip("the shared fixture is not in this checkout")
    rules, presets = rules_of(), presets_of()
    fixture = json.loads(FIXTURE.read_text("utf-8"))
    assert len(fixture["valid"]) >= 40 and len(fixture["invalid"]) >= 40

    def pruned(node: Any) -> Any:  # an empty object (or list) means "the preset": the repair leaves it out
        if isinstance(node, dict):
            kept = {k: pruned(v) for k, v in node.items()}
            return {k: v for k, v in kept.items() if v not in ({}, [])}
        return node

    for look in fixture["valid"]:
        if "detail" not in look:
            continue
        assert strict(look["detail"], rules) == []
        want = pruned(look["detail"])
        if "profile" in want and has_profile(look["body"]):  # the numbers wait in the editor; here they are the body's
            want["profile"]["body"] = look["body"]
        assert check_detail(look["detail"], rules, presets, body=look["body"]) == want, look["detail"]
    for case in fixture["invalid"]:
        look = case["look"]
        fixed = check_detail(look.get("detail"), rules, presets, body=look.get("body"))
        if not isinstance(look.get("detail"), dict):
            assert fixed is None
            continue
        assert fixed is not None and strict(fixed, rules) == [], (case["path"], fixed)
        assert check_detail(fixed, rules, presets, body=look.get("body")) == fixed  # repairing twice changes nothing


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ({"toon": 130}, {"toon": 100}),
        ({"toon": -4}, {"toon": 0}),
        ({"toon": 30.5}, {"toon": 31}),
        ({"toon": "30"}, {}),
        ({"toon": True}, {}),
        ({"toon": float("nan")}, {}),
        ({"wheels": {"spokes": 2, "tyre": 99}}, {"wheels": {"spokes": 3, "tyre": 60}}),
        ({"roof": {"type": "convertible", "hoops": "twin"}}, {"roof": {"hoops": "twin"}}),
        ({"roof": {"type": "Open"}}, {}),
        ({"roof": "open"}, {}),
        ({"brakes": {"caliper": "#FFD21F"}}, {"brakes": {"caliper": "#ffd21f"}}),
        ({"brakes": {"caliper": "yellow"}}, {}),
        ({"trim": "#fff", "mirrorColor": "#ABCDEF"}, {"mirrorColor": "#abcdef"}),
        ({"glow": True, "roof": {"glow": 1, "rails": True}}, {"roof": {"rails": True}}),
        ({"front": {"fog": "yes"}, "side": {"rubStrip": True}}, {"side": {"rubStrip": True}}),
        ({"roof": None, "wheels": {}, "side": {"intake": None}}, {}),
        ({"side": {"doors": 4, "intakeX": 19}}, {"side": {"doors": 3, "intakeX": 20}}),
        ({"extras": ["antenna", "antenna", "rocket", "ladder"]}, {"extras": ["antenna", "ladder"]}),
        ({"extras": "antenna"}, {}),
        ({"extras": ["rocket"]}, {}),
        ({}, {}),
        ({"v": 7}, {}),
    ],
)
def test_check_detail_repairs_each_kind_of_mistake_silently(raw: dict[str, Any], want: dict[str, Any]) -> None:
    assert check_detail({"v": 1, **raw}, rules_of(), presets_of(), body="sports") == {"v": 1, **want}


def test_extras_are_cut_to_six_and_a_non_object_is_no_detail() -> None:
    every = rules_of()["extras"]["l"]
    got = check_detail({"extras": [*every, *every]}, rules_of(), presets_of(), body="suv")
    assert got is not None and got["extras"] == every[:6]
    for raw in (None, "open top", 5, ["roof"]):
        assert check_detail(raw, rules_of(), presets_of(), body="suv") is None


def test_a_profile_with_missing_numbers_is_filled_from_its_bodys_preset() -> None:
    rules, presets = rules_of(), presets_of()
    half = {"body": "suv", "lh": 999, "axF": 20, "wheelD": 3}
    got = check_detail({"profile": half}, rules, presets, body="sports")
    assert got is not None
    profile = got["profile"]
    assert profile["body"] == "sports"  # the numbers are the picked body's (the engine reads them only for it)
    assert profile["lh"] == 520 and profile["axF"] == 20 and profile["wheelD"] == 20  # clamped, not refused
    rest = {k: v for k, v in profile.items() if k not in (*half, "body")}
    assert rest == {k: v for k, v in presets["sports"].items() if k not in (*half, "body")}
    assert len(profile) == len([r for r in rules if r.startswith("profile.")]) == 35
    assert strict(got, rules) == []
    # no usable body to fill from: the profile goes, the rest stays
    lost = check_detail({"profile": {"lh": 300}, "finish": "matte"}, rules, {}, body="sports")
    assert lost == {"v": 1, "finish": "matte"}


@pytest.mark.parametrize("body", ["motorbike", "plane", "boat"])
def test_a_motorbike_plane_or_boat_keeps_its_parts_but_loses_the_outline(body: str) -> None:
    got = check_detail(spider_detail(), rules_of(), presets_of(), body=body)
    assert got is not None and "profile" not in got and "toon" not in got
    assert got["wheels"]["shape"] == "split" and got["stripe"]["layout"] == "centre"


def test_a_detail_over_2400_characters_loses_its_fine_keys_first_and_keeps_the_outline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rules, presets = rules_of(), presets_of()
    big = spider_detail()
    big["extras"] = rules["extras"]["l"][:6]
    big["trim"] = big["mirrorColor"] = "#123456"
    size = len(json.dumps(big, separators=(",", ":")))
    assert check_detail(big, rules, presets, body="sports") == {"v": 1, **{k: v for k, v in big.items() if k != "v"}}
    monkeypatch.setattr(characters, "DETAIL_MAX_CHARS", size - 20)  # the order is the point, so shrink the budget
    got = check_detail(big, rules, presets, body="sports")
    assert got is not None and "extras" not in got  # the first fine key to go
    assert "trim" in got and "profile" in got and "wheels" in got  # one drop was enough
    assert len(json.dumps(got, separators=(",", ":"))) <= size - 20
    monkeypatch.setattr(characters, "DETAIL_MAX_CHARS", 700)  # far too small: fine keys, then the rest; never an error
    small = check_detail(big, rules, presets, body="sports")
    assert small is not None and "profile" in small
    assert not {"extras", "trim", "mirrorColor", "cabin"} & set(small)


def test_check_car_keeps_a_detail_and_puts_the_classic_sliders_at_one() -> None:
    cat = engine_catalog()
    value, problems = check_car(a_detailed_car(), cat)
    assert problems == [] and value is not None
    assert value["car"]["detail"] == spider_detail()
    assert value["car"]["length"] == 1 and value["car"]["height"] == 1 and value["car"]["wheels"]["size"] == 1
    kept = a_detailed_car(detail={"v": 1, "finish": "matte"})
    value, problems = check_car(kept, cat)  # no profile: the sliders keep the answer's own numbers
    assert value is not None and value["car"]["detail"] == {"v": 1, "finish": "matte"}
    assert value["car"]["length"] == 1.1 and value["car"]["height"] == 0.9


def test_an_old_answer_without_a_detail_still_equals_the_car_and_a_null_detail_is_left_out() -> None:
    cat = engine_catalog()
    value, problems = check_car(a_car(), cat)
    assert problems == [] and value is not None and value["car"] == CAR and "detail" not in value["car"]
    for nothing in (None, "none", 3, []):
        raw = a_car()
        raw["car"]["detail"] = nothing
        got, found = check_car(raw, cat)
        assert got is not None and found == [] and got["car"] == CAR


def test_a_broken_detail_never_refuses_a_car_or_adds_a_problem() -> None:
    raw = a_detailed_car(detail={"v": 9, "toon": 500, "wheels": {"shape": "spinners"}, "mystery": 1, "profile": {}})
    value, problems = check_car(raw, engine_catalog())
    assert problems == [] and value is not None
    assert value["car"]["detail"]["toon"] == 100 and "wheels" not in value["car"]["detail"]
    assert strict(value["car"]["detail"], rules_of()) == []


# --- the schema ------------------------------------------------------------------------------------------------------


def walk_house_rules(node: Any, path: str = "") -> None:
    """Every object is closed with every property required; no numeric or length keywords."""
    if isinstance(node, dict):
        kinds = node.get("type")
        if "object" in (kinds if isinstance(kinds, list) else [kinds]):
            assert node["additionalProperties"] is False, path
            assert set(node["required"]) == set(node["properties"]), path
        if not path.endswith("/properties"):  # a property may be NAMED "pattern"; a keyword may not be used
            for bad in ("minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "format"):
                assert bad not in node, (path, bad)
        for key, value in node.items():
            walk_house_rules(value, f"{path}/{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            walk_house_rules(value, f"{path}/{i}")


def test_the_detail_schema_follows_the_house_rules_and_the_engines_rules() -> None:
    rules = rules_of()
    schema = detail_schema(rules)
    walk_house_rules(schema)
    props = schema["properties"]
    assert next(iter(props)) == "v" and props["v"] == {"type": "integer", "enum": [1]}
    assert schema["type"] == ["object", "null"]
    assert props["roof"]["properties"]["type"]["enum"] == [*rules["roof.type"]["e"], None]
    assert props["roof"]["properties"]["rails"]["type"] == ["boolean", "null"]
    assert props["wheels"]["properties"]["spokes"]["description"] == "3 to 24"
    assert props["toon"]["type"] == ["integer", "null"] and props["toon"]["description"].startswith("0 to 100")
    assert props["lights"]["properties"]["front"]["properties"]["shape"]["enum"][-1] is None
    extras = props["extras"]
    assert extras["maxItems"] == 6 and extras["items"]["enum"] == rules["extras"]["l"] and "null" in extras["type"]
    profile = props["profile"]
    assert profile["type"] == ["object", "null"] and len(profile["properties"]) == 35
    assert all("null" not in v["type"] for v in profile["properties"].values())  # all together, none left out
    assert profile["properties"]["body"]["enum"] == rules["profile.body"]["e"]
    assert profile["properties"]["lh"]["description"] == "150 to 520"

    def leaves(node: dict[str, Any]) -> int:
        inner = node.get("properties")
        return sum(leaves(v) for v in inner.values()) if inner else 1

    assert leaves(schema) - 1 == len(rules)  # every rule has its place; the "v" is the one more


def test_a_motorbike_plane_or_boat_schema_has_no_profile_and_no_toon() -> None:
    schema = detail_schema(rules_of(), profile=False)
    walk_house_rules(schema)
    assert "profile" not in schema["properties"] and "toon" not in schema["properties"]
    assert "wheels" in schema["properties"] and "stripe" in schema["properties"]


def test_the_car_schema_carries_the_detail_and_an_old_engine_gets_the_schema_it_had() -> None:
    cat = engine_catalog()
    schema = car_schema(cat)
    car = schema["properties"]["car"]
    assert car["properties"]["detail"]["properties"]["profile"] and "detail" in car["required"]
    walk_house_rules(schema)
    old = {k: v for k, v in cat.items() if k != "carDetail"}
    plain = car_schema(old)["properties"]["car"]
    assert "detail" not in plain["properties"] and "detail" not in plain["required"]
    assert "study" not in design.design_schema(old, 3)["properties"]


def test_the_design_schema_asks_for_the_study_first() -> None:
    schema = design.design_schema(engine_catalog(), 3)
    assert list(schema["properties"])[:3] == ["study", "variants", "problem"]
    assert schema["required"] == ["study", "variants", "problem"]
    study = schema["properties"]["study"]["properties"]
    assert study["photos"]["items"]["properties"]["shows"]["enum"][:2] == ["side", "front_34"]
    assert set(study) == {"photos", "best_side", "notes"} and study["notes"]["maxItems"] == 3
    walk_house_rules(schema)


# --- the task --------------------------------------------------------------------------------------------------------


def test_a_detail_survives_the_task_and_nothing_of_the_study_is_stored(tmp_path: Path, engine_ok: None) -> None:
    study = {"photos": [{"n": 1, "shows": "side"}], "best_side": 1, "notes": ["a Toyota-like shadow hides the nose"]}
    model = FakeModel(reply(data={"study": study, "variants": [a_detailed_car("Dart")], "problem": None}))
    svc, db, s3 = services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 1), count=1))
    assert run(svc) == "done"
    result = db.get(PK, "TASK#T1")["result"]
    assert set(result) == {"character", "characters"} and "study" not in json.dumps(result)
    assert result["character"]["car"]["detail"] == spider_detail()
    assert model.calls[0]["schema"]["properties"]["study"]
    assert "detail" in model.calls[0]["schema"]["properties"]["variants"]["items"]["properties"]["car"]["properties"]


def test_every_option_shares_option_ones_outline_body_and_sliders(tmp_path: Path, engine_ok: None) -> None:
    other = spider_detail()
    other["profile"]["lh"] = 300
    other["toon"] = 60
    other["wheels"]["shape"] = "star"
    second = a_detailed_car("Dash", detail=other, body="sedan", length=0.9)
    model = FakeModel(answer(a_detailed_car("Dart"), second, a_car("Dot")))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 3, "description": "a grey sports car"}))
    assert run(svc) == "done"
    first, mid, last = db.get(PK, "TASK#T1")["result"]["characters"]
    for option in (mid, last):
        assert option["car"]["detail"]["profile"] == first["car"]["detail"]["profile"]
        assert option["car"]["body"] == "sports" and option["car"]["length"] == 1 and option["car"]["height"] == 1
        assert option["car"]["wheels"]["size"] == 1
    assert mid["car"]["detail"]["toon"] == 60 and mid["car"]["detail"]["wheels"]["shape"] == "star"  # its own parts
    assert last["car"]["detail"] == {"v": 1, "profile": first["car"]["detail"]["profile"]}


def test_when_option_one_has_no_outline_no_option_has_one(tmp_path: Path, engine_ok: None) -> None:
    plain = spider_detail()
    del plain["profile"]
    model = FakeModel(answer(a_detailed_car("Dart", detail=plain), a_detailed_car("Dash")))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 2, "description": "a grey sports car"}))
    assert run(svc) == "done"
    options = db.get(PK, "TASK#T1")["result"]["characters"]
    assert all("profile" not in o["car"]["detail"] for o in options)


def test_an_engine_refusal_drops_that_options_detail_and_the_classic_look_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[str] = []

    def refuses(value: dict[str, Any]) -> list[str]:
        seen.append(value["name"])
        return ["car.detail.profile is wrong"] if value["name"] == "Dash" else []

    monkeypatch.setattr(design, "character_errors", refuses)
    model = FakeModel(answer(a_detailed_car("Dart"), a_detailed_car("Dash", length=0.9)))
    svc, db, _ = services(tmp_path, model)
    db.seed(task_item("T1", "character_design", input={"kind": "car", "count": 2, "description": "a grey sports car"}))
    assert run(svc) == "done"
    assert len(model.calls) == 1  # never a second call for it
    first, second = db.get(PK, "TASK#T1")["result"]["characters"]
    assert "detail" in first["car"]
    # option 2 lost its own detail, kept its classic look, then took option 1's outline like every option
    assert second["car"]["detail"] == {"v": 1, "profile": first["car"]["detail"]["profile"]}
    assert seen == ["Dart", "Dash"]


def test_the_live_engine_accepts_the_checked_reference_look() -> None:
    value, problems = check_car(a_detailed_car(), engine_catalog())
    assert problems == [] and value is not None
    assert character_errors(value) == [], "the engine's validateCharacter must accept the repaired detail"
    broken = copy.deepcopy(value)
    broken["car"]["detail"]["toon"] = 2.5
    assert character_errors(broken) != []


def test_data_carries_the_rules_the_presets_and_four_examples_and_no_make(tmp_path: Path, engine_ok: None) -> None:
    model = FakeModel(answer(a_car("Rosso")))
    svc, db, s3 = services(tmp_path, model)
    db.seed(car_task(seed_photos(db, s3, 2), count=1))
    assert run(svc) == "done"
    detail = data_of(model)["detail"]
    assert set(detail) == {"rules", "preset", "examples"}
    assert detail["rules"]["roof.type"]["open"] and detail["rules"]["wheels.spokes"] == "3 to 24"
    assert detail["rules"]["extras"]["up to"] == 6 and detail["rules"]["brakes.caliper"] == "a colour as #rrggbb"
    assert set(detail["preset"]) == {
        "hatchback",
        "sedan",
        "estate",
        "suv",
        "sports",
        "compact",
        "pickup",
        "van",
    }  # the default families: no bus
    assert len(detail["examples"]) == 4 and all(len(e["profile"]) == 35 for e in detail["examples"])
    size = len(json.dumps(detail, ensure_ascii=False, separators=(",", ":")))  # as the prompt sends it
    assert 5000 < size < 14000, size  # about 9 KB of rules and presets, plus the four examples
    assert strip_brands(json.dumps(detail))[1] == []
    assert not any(path.startswith("profile.") for path in detail["rules"])  # their ranges are in the schema
    for e in design.DETAIL_EXAMPLES:  # the examples are valid details of the engine's own rules
        assert strict({"v": 1, "profile": e["profile"]}, rules_of()) == []


def test_the_briefs_say_likeness_with_no_make_and_the_options_are_one_vehicle() -> None:
    for brief in (design.CAR_BRIEF, design.DETAIL_BRIEF, design.DETAIL_PARTS_BRIEF, design.CAR_REDESIGN):
        assert strip_brands(brief)[1] == [], brief
    assert design.CAR_BRIEF.startswith("Turn the real car in the PHOTOS into {count} cartoon car characters")
    assert "Every option is the SAME vehicle" in design.CAR_BRIEF and "clearly different" not in design.CAR_BRIEF
    assert "option 1 `toon` 30" in design.CAR_BRIEF and "option 3 `toon` 0" in design.CAR_BRIEF
    assert "but true to this vehicle's own shape and details" in design.CAR_BRIEF
    assert design.DETAIL_BRIEF.startswith("The lines below are newer than the lines above and win where they differ.")
    assert "likeness is the job" in design.DETAIL_BRIEF and "write `study` first" in design.DETAIL_BRIEF
    assert "never write its make, model or badge anywhere" in design.DETAIL_BRIEF
    assert design.DETAIL_BRIEF.rstrip().endswith("Still a cartoon: bold, friendly, clean.")
    assert "set length, height and wheels.size to 1" in design.CAR_REDESIGN


def test_the_redesign_block_comes_before_the_detail_brief(tmp_path: Path, engine_ok: None) -> None:
    saved = character_item("C1", "Rosso", kind="car", car=CAR, description="A small red hatchback.")
    model = FakeModel(answer(a_car("Rosso")))
    svc, db, s3 = services(tmp_path, model)
    db.seed(saved)
    db.seed(car_task(seed_photos(db, s3, 1), count=1, characterId="C1"))
    assert run(svc) == "done"
    blocks = [b["text"] for b in model.calls[0]["messages"][0]["content"] if "text" in b]
    assert blocks[0].startswith("Turn the real car") and blocks[1].startswith("This is a redesign of the saved car")
    assert blocks[2].startswith("The lines below are newer") and blocks[3].startswith("Photo 1 of 1")


def test_the_picture_edge_is_1568_up_to_four_photos_then_1280(tmp_path: Path) -> None:
    for photos, edge in ((1, None), (4, None), (5, 1280), (8, 1280)):
        images_ = SizedImages()
        model = FakeModel(answer(a_car("Rosso")))
        svc, db, s3 = services(tmp_path, model, images=images_)  # type: ignore[arg-type]
        db.seed(car_task(seed_photos(db, s3, photos), count=1))
        assert run(svc) == "done"
        assert [e for _, e in images_.calls] == [edge] * photos


def test_a_cars_words_may_add_open_top_and_the_brake_colour_inside_80_characters() -> None:
    spider = {**CAR, "body": "sports", "paint": "#55575a", "wheels": {"style": "sport"}, "lights": {"front": "slim"},
              "detail": spider_detail()}  # fmt: skip
    words = car_words(spider)
    assert words == "a grey open-top sports car with sporty wheels, yellow brakes and slim lights"
    assert len(words) <= 80
    assert car_words({**spider, "detail": {"v": 1}}) == "a grey sports car with sporty wheels and slim lights"
    assert car_words({**spider, "detail": {"v": 1, "roof": {"type": "closed"}}}).startswith("a grey sports car")
    eyes = {**spider, "face": {"eyes": "windscreen"}, "length": 1.1}
    assert len(car_words(eyes)) <= 80 and car_words(eyes).startswith("a long grey open-top sports car")
    assert car_words({**spider, "body": "plane"}) == "a grey plane with slim lights"  # no wheels, no brakes
    assert strip_brands(words)[1] == []


def test_the_study_is_read_cut_and_brand_stripped() -> None:
    got = read_study({"photos": [{"n": 1, "shows": "side"}, {"n": 2, "shows": "bird"}, {"n": 3.4, "shows": "top"}, "x"],
                      "best_side": 1.0, "notes": ["a Toyota Corolla", " ", "b", "c", "d"]})  # fmt: skip
    assert got == {"photos": [{"n": 1, "shows": "side"}, {"n": 3, "shows": "top"}], "best_side": 1,
                   "notes": ["a car", "b", "c"]}  # fmt: skip
    assert read_study(None) == {"photos": [], "best_side": None, "notes": []}
    assert read_study({"best_side": "left"})["best_side"] is None
