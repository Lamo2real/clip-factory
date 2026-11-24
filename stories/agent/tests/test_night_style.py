"""The night drive drawing style on the agent's side (docs/CONTRACTS.md §45.45).

A night drive story's writer request carries ``art``, the arts and shots lists, the two shot rules and each scene's
``cuts`` in its schema, and its own house rules come after SYSTEM, which stays word for word. A Bright (classic)
story's request and schema are what they were before drawing styles. The script keeps ``art`` only for night drive,
the scene hash counts it, the built-in portrait and the AI cut-away prompt follow it, the fact checker sees the shot a
beat is in, and the director reads and offers it.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from lamostories_agent import providers, safety, writer
from lamostories_agent.chat import tools
from lamostories_agent.pipeline import scene_hash
from ls_fakes import needs_deno

CATALOG = {
    "actions": [{"id": "wave"}, {"id": "get_in"}],
    "propActions": [{"id": "move"}, {"id": "honk"}],
    "props": [{"id": "car"}, {"id": "truck"}],
    "sets": [{"id": "road_day"}, {"id": "highway_night"}],
    "cameras": [{"id": "wide"}],
    "arts": [{"id": "night_drive", "label": "Night drive"}, {"id": "classic", "label": "Bright"}],
    "shots": [{"id": "scene"}, {"id": "driver_view"}, {"id": "face"}, {"id": "mirror"}],
}

RULES = {
    "rules": [
        {"id": "skid_dir", "text": "A skid."},
        {"id": "shots", "text": "Cuts."},
        {"id": "shot_world", "text": "W."},
    ],
    "limits": {"scenes": 30},
    "formats": [],
}


def test_a_bright_schema_is_what_it_was_and_a_night_one_has_the_cuts() -> None:
    plain = writer.scene_schema(CATALOG, ["c1"])
    assert json.dumps(plain, sort_keys=True) == json.dumps(
        writer.scene_schema(CATALOG, ["c1"], None, (), "classic"), sort_keys=True
    )
    assert "cuts" not in plain["properties"]
    night = writer.scene_schema(CATALOG, ["c1"], art="night_drive")
    cuts = night["properties"]["cuts"]
    assert cuts["maxItems"] == 8
    assert cuts["items"]["required"] == ["at", "shot"]
    assert cuts["items"]["properties"]["shot"]["enum"] == ["scene", "driver_view", "face", "mirror"]
    assert "cuts" not in night["required"]
    # everything else in the night schema is the Bright one
    rest = copy.deepcopy(night)
    del rest["properties"]["cuts"]
    assert rest == plain
    board = writer.storyboard_schema(CATALOG, ["c1"], [], mode="full", art="night_drive")
    assert "cuts" in board["properties"]["scenes"]["items"]["properties"]
    bright = writer.storyboard_schema(CATALOG, ["c1"], [], mode="full")
    assert "cuts" not in bright["properties"]["scenes"]["items"]["properties"]


def test_the_night_house_rules_come_after_the_old_system_word_for_word() -> None:
    assert writer.system_for("classic") == writer.SYSTEM
    assert writer.system_for(None) == writer.SYSTEM
    night = writer.system_for("night_drive")
    assert night.startswith(writer.SYSTEM + "\n\n")
    flat = " ".join(night.split())
    for line in (
        "This video is drawn in the night drive style. Car stories happen at night on highway_night or road_night "
        "unless the story needs day, snow, rain or a place indoors.",
        "Cut often, like a short film: a new shot every 2 to 4 seconds, as cuts inside a scene; the action and sound go "
        "on across a cut.",
        "Open a drive on road_wide or road_behind, then driver_view. Cut to face for each reaction (a new face or a "
        "noise). Use mirror when a car comes up behind, side_window when one is alongside, speed_dial when the car "
        "speeds up or slows down.",
        "Show the cast's car whole at least once: the whole scene or road_behind.",
        "Use pedals only on a brake beat that a guidance step gives, and never use speed_dial to teach a speed.",
    ):
        assert line in flat, line
    # the older rule it squares with is still there
    assert "do not show braking or gear changes unless the guidance gives them" in " ".join(writer.SYSTEM.split())
    # the reference video is never named
    assert "reference" not in writer.NIGHT_RULES.lower()


def test_a_bright_request_leaves_out_the_styles_shots_and_shot_rules() -> None:
    lists = {k: v for k, v in CATALOG.items()}
    bright = writer.styled_request(lists, RULES, "classic")
    assert set(bright) == {"catalog", "rules", "limits", "formats"}
    assert "arts" not in bright["catalog"] and "shots" not in bright["catalog"]
    assert [r["id"] for r in bright["rules"]] == ["skid_dir"]
    assert writer.styled_request(lists, RULES, None) == bright
    night = writer.styled_request(lists, RULES, "night_drive")
    assert night["art"] == "night_drive"
    assert night["catalog"] == lists
    assert [r["id"] for r in night["rules"]] == ["skid_dir", "shots", "shot_world"]
    # the inputs stay as they were
    assert [r["id"] for r in RULES["rules"]] == ["skid_dir", "shots", "shot_world"]


def test_the_style_of_a_story_a_script_and_a_workspace() -> None:
    assert writer.art_of({"art": "night_drive"}) == "night_drive"
    assert writer.art_of({"art": "classic"}) == "classic"
    assert writer.art_of({}) == "classic"  # a story or script made before drawing styles
    assert writer.art_of(None) == "classic"
    assert writer.workspace_art({"video": {"art": "classic"}}) == "classic"
    assert writer.workspace_art({"video": {"aspect": "9:16"}}) == "night_drive"
    assert writer.workspace_art(None) == "night_drive"


def _answer() -> dict[str, Any]:
    return {"title": "T", "scenes": [{"sceneId": "s1", "title": "S", "durationSec": 3, "cuts": None}], "captions": []}


def test_the_script_keeps_art_only_for_night_drive() -> None:
    args: dict[str, Any] = {"title": "t", "engine_version": 7, "seed": 1, "cast": {}, "captions_on": False,
                            "music": None, "topic": None}  # fmt: skip
    bright = writer.script_from(_answer(), **args)
    assert "art" not in bright
    assert writer.script_from(_answer(), **args, art="classic") == bright
    night = writer.script_from(_answer(), **args, art="night_drive")
    assert night["art"] == "night_drive"
    assert "cuts" not in night["scenes"][0]  # a null cuts list is left out, as every null optional field


def test_the_scene_hash_counts_the_style_and_a_bright_scene_hashes_as_before() -> None:
    scene = {"sceneId": "s1", "actors": [], "beats": [], "props": []}
    script = {"engine": 7, "width": 1080, "height": 1920, "fps": 30, "seed": 3, "cast": {}, "scenes": [scene]}
    plain = scene_hash(script, scene)
    assert scene_hash({**script, "art": "night_drive"}, scene) != plain
    assert scene_hash(copy.deepcopy(script), scene) == plain


def test_the_built_in_portrait_and_the_cut_away_prompt_follow_the_style() -> None:
    ch = {"characterId": "ch1", "name": "Pip", "look": {}}
    bright = providers.portrait_script(ch, 1, 7)
    assert "art" not in bright
    assert providers.portrait_script(ch, 1, 7, "classic") == bright
    assert providers.portrait_script(ch, 1, 7, "night_drive")["art"] == "night_drive"
    scene = {"set": "highway_night", "view": "side", "props": [{"kind": "car"}]}
    words = providers.reel_prompt({"art": "night_drive"}, scene)
    assert words.startswith("Slow cinematic shot of a motorway at night under orange street lights, at eye level")
    assert "at night under orange street lights, muted blue and teal colours, flat cartoon look" in words
    assert "muted blue" not in providers.reel_prompt({}, {**scene, "set": "road_day"})


def test_the_fact_checker_sees_the_shot_only_in_a_scene_that_cuts() -> None:
    beats = [{"at": 0.5, "dur": 1, "who": "car1", "do": "move"}, {"at": 2.5, "dur": 1, "who": "car1", "do": "stop"}]
    scene = {"sceneId": "s1", "title": "Drive", "set": "highway_night", "beats": beats,
             "props": [{"propId": "car1", "kind": "car"}], "actors": []}  # fmt: skip
    plain = safety.items({"scenes": [scene]}, None)
    assert all("shot" not in i for i in plain)
    cut = safety.items(
        {"scenes": [{**scene, "cuts": [{"at": 1, "shot": "driver_view"}, {"at": 2, "shot": "mirror"}]}]}, None
    )
    assert "shot" not in cut[0]  # before the first cut: the whole scene
    assert cut[1]["shot"] == "mirror"
    assert {k: v for k, v in cut[1].items() if k != "shot"} == plain[1]


def test_the_director_reads_the_style_and_cuts_and_offers_a_style() -> None:
    spec = next(s for s in tools.specs() if s["toolSpec"]["name"] == "offer_make_video")
    art = spec["toolSpec"]["inputSchema"]["json"]["properties"]["art"]
    assert art["enum"] == ["night_drive", "classic"]
    assert "art" not in spec["toolSpec"]["inputSchema"]["json"].get("required", [])
    plain = {"sceneId": "s1", "title": "S"}
    assert "cuts" not in tools._scene_view(plain)
    assert tools._scene_view({**plain, "cuts": [{"at": 1, "shot": "face"}]})["cuts"] == [{"at": 1, "shot": "face"}]


@needs_deno
def test_a_night_story_asks_the_writer_with_its_style_and_a_bright_one_as_before(tmp_path: Path) -> None:
    from test_stories_pipeline import job_item, run_job, story_item, world

    def request_of(models: Any) -> tuple[str, dict[str, Any], dict[str, Any]]:
        call = next(c for c in models.calls if c["task"] == "storyboard")
        content = call["messages"][0]["content"]
        return content[0]["text"], json.loads(content[1]["text"].split("\n", 1)[1]), call["schema"]

    svc, _store, _table, models = world(tmp_path / "n", job=job_item("J1", "S1", run=["storyboard"]),
                                        story=story_item(art="night_drive"))  # fmt: skip
    assert run_job(svc) == "ready"
    prompt, request, schema = request_of(models)
    assert writer.NIGHT_RULES in prompt
    assert request["art"] == "night_drive"
    assert "shots" in request["catalog"] and "arts" in request["catalog"]
    assert {"shots", "shot_world"} <= {r["id"] for r in request["rules"]}
    assert "cuts" in schema["properties"]["scenes"]["items"]["properties"]

    svc, _store, _table, models = world(tmp_path / "b", job=job_item("J1", "S1", run=["storyboard"]))
    assert run_job(svc) == "ready"
    prompt, request, schema = request_of(models)
    assert writer.NIGHT_RULES not in prompt and prompt.startswith(writer.SYSTEM + "\n\n")
    assert "art" not in request
    assert "shots" not in request["catalog"] and "arts" not in request["catalog"]
    assert not {"shots", "shot_world"} & {r["id"] for r in request["rules"]}
    assert "cuts" not in schema["properties"]["scenes"]["items"]["properties"]
