"""Write it myself: the owner's own script (docs/CONTRACTS.md §45.46, ADR-95).

The storyboard step does not write a story for these videos: the faithful adapter stages the owner's script on the
writer's ``animation_plan`` task, code puts the owner's words on screen (cues ``w_sN``), and ``own_problems`` proves
the staging kept the script (scenes and order, who, where, the words, every piece of what happens, nothing added).
The adapter is asked once more; still broken, the video stops with a sentence that names the scene and nothing is
saved. The fact check still runs (ADR-74) and only reports: the owner's words are never rewritten. The engine runs for
real (Deno) where a test needs it, as in the other pipeline tests."""

from __future__ import annotations

import asyncio
import copy
import json
import re
from pathlib import Path
from typing import Any

from lamostories_agent import keys, own_script, safety, writer
from lamostories_agent.engine import Engine
from lamostories_agent.pipeline import HELD_TOPIC
from lamostories_agent.tasks import series as recap_task
from ls_fakes import ENGINE_DIR, PK, USER, WS, needs_deno
from test_series_context import CAR
from test_stories_pipeline import (
    OK,
    POST,
    PREFIX,
    STORY,
    answers,
    assert_fenced,
    character,
    job_item,
    run_job,
    story_item,
    world,
)
from test_stories_safety import quality_off

TITLE = "Lamo learns to juggle"
SCENES: list[dict[str, Any]] = [
    {"sceneId": "s1", "what": "Lamo wakes up late.", "caption": "Oh no!!", "who": [], "place": None, "leaveOut": []},
    {"sceneId": "s2", "what": "Lamo runs to the park and Rosa waves.", "caption": None, "who": ["ch1", "ch2"],
     "place": "park", "leaveOut": []},
    {"sceneId": "s3", "what": "Lamo juggles three balls for Rosa.", "caption": "Ta-da! 🎉", "who": [], "place": None,
     "leaveOut": []},
]  # fmt: skip
LAMO = {"castId": "c1", "x": 0.35, "y": 0.72, "facing": "right"}
ROSA = {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left"}
RUN = ["storyboard"]
CHECK_RUN = ["storyboard", "safety"]


def beat(at: float, dur: float, who: str, do: str, **extra: Any) -> dict[str, Any]:
    return {"at": at, "dur": dur, "who": who, "do": do, **extra}


def piece(words: str, beats: tuple[int, ...] = (), **extra: Any) -> dict[str, Any]:
    out = {"words": words, "beats": list(beats), "sfx": [], "place": False, "camera": False, "closest": None,
           "notShown": False, "why": None}  # fmt: skip
    out.update(extra)
    return out


def scene(
    sid: str, place: str, beats: list[dict[str, Any]], shows: list[dict[str, Any]], actors: list[dict[str, Any]],
    *, dur: float = 5, props: list[dict[str, Any]] | None = None, ref: str | None = None, camera: str = "medium",
) -> dict[str, Any]:  # fmt: skip
    return {"sceneId": sid, "durationSec": dur, "set": place, "view": "side", "camera": camera,
            "actors": copy.deepcopy(actors), "props": props or [], "beats": beats, "guidanceRef": ref,
            "shows": shows}  # fmt: skip


def staging() -> dict[str, Any]:
    """The adapter's answer for SCENES: one scene per script scene, every piece tied to what shows it."""
    return {
        "teachesSafety": False,
        "safetyTopicId": None,
        "music": {"volume": 0.5},
        "scenes": [
            scene("s1", "kitchen", [beat(0.3, 1.5, "c1", "gasp", face="shocked", noise="gasp"),
                                    beat(2.2, 1.0, "c1", "look_left")],
                  [piece("Lamo wakes up late.", (0,), place=True)], [LAMO]),
            scene("s2", "park", [beat(0.2, 2.0, "c1", "run", to={"x": 0.55, "y": 0.72}),
                                 beat(2.4, 1.5, "c2", "wave", face="happy")],
                  [piece("Lamo runs to the park", (0,), place=True), piece("and Rosa waves.", (1,))], [LAMO, ROSA]),
            scene("s3", "park", [beat(0.3, 3.0, "c1", "dance", face="happy"), beat(1.0, 1.2, "c2", "celebrate")],
                  [piece("Lamo juggles three balls", (0,), closest="a happy dance"), piece("for Rosa.", (1,))],
                  [LAMO, ROSA]),
        ],
    }  # fmt: skip


def rosa() -> dict[str, Any]:
    return {**character("ch2"), "name": "Rosa", "personality": "Kind and calm."}


def rosso() -> dict[str, Any]:
    return {**character("ch3"), "name": "Rosso", "kind": "car", "car": copy.deepcopy(CAR), "look": None,
            "movementStyle": "zippy", "expressions": ["neutral"],
            "voice": {"style": "none", "pitch": 1, "noises": [], "sfx": ["engine", "honk"]}}  # fmt: skip


def own_story(scenes: list[dict[str, Any]] | None = None, **over: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "title": TITLE,
        "characterIds": ["ch1", "ch2"],
        "durationSec": 15,
        "captionsOn": True,
        "brief": {"title": TITLE, "logline": SCENES[0]["what"], "category": "comedy"},
        "ownScript": {"scenes": copy.deepcopy(scenes or SCENES)},
    }
    fields.update(over)
    return story_item(**fields)


def own_world(
    tmp_path: Path, *, replies: dict[str, Any] | None = None, story: dict[str, Any] | None = None,
    run: list[str] | None = None, **job: Any,
) -> tuple[Any, Any, Any, Any]:  # fmt: skip
    got = replies or answers(animation_plan=staging(), storyboard=AssertionError("the writer never writes it"))
    svc, store, table, models = world(tmp_path, got, story=story or own_story(), job=job_item("J1", "S1", run=run or RUN,
                                                                                                **job))  # fmt: skip
    table.seed(rosa())
    return svc, store, table, models


def request_of(call: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(call["messages"][0]["content"][1]["text"].split("\n", 1)[1])
    return out


def saved(store: Any, table: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    story = table.item(f"STORY#{STORY}")
    assert story is not None
    return story, json.loads(store.objects[story["scriptKey"]][0])


def final_script(answer: dict[str, Any] | None = None, scenes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The script code builds from an answer (no engine: each scene keeps its own length)."""
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Rosa"}}
    return own_script.script_from_own(
        answer or staging(), own_script.scenes_of(scenes or SCENES), title=TITLE, engine_version=6, seed=1, cast=cast,
        captions_on=True, music=None, topic=None,
    )  # fmt: skip


CASTMAP = {"ch1": "c1", "ch2": "c2"}
PLACES = {"park": "Park", "kitchen": "Kitchen", "foggy_road": "Foggy road"}


def broken(answer: dict[str, Any], script: dict[str, Any], scenes: Any = None, **kw: Any) -> list[str]:
    return [p.key for p in own_script.own_problems(answer, script, scenes or SCENES, CASTMAP, places=PLACES, **kw)]


# --- the faithful check, pure ---------------------------------------------------------------------------------------


def test_own_problems_catches_each_break() -> None:
    answer, script = staging(), final_script()
    assert own_script.own_problems(answer, script, SCENES, CASTMAP, places=PLACES) == []
    assert [c["id"] for c in script["captions"]] == ["w_s1", "w_s3"]
    assert [c["text"] for c in script["captions"]] == ["Oh no!!", "Ta-da! 🎉"]  # exactly as the owner wrote them

    def variant(change: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        a, s = copy.deepcopy(answer), copy.deepcopy(script)
        change(a, s)
        return a, s

    # 1. a dropped scene, and two scenes swapped
    a, s = variant(lambda a, s: s["scenes"].pop(1))
    assert "OWN_LOST" in broken(a, s)
    a, s = variant(lambda a, s: s["scenes"].reverse())
    assert "OWN_LOST" in broken(a, s)
    # 2. a changed word, an extra caption (unless the owner added it himself), a scene caption set
    a, s = variant(lambda a, s: s["captions"][0].update(text="Oh yes!!"))
    assert broken(a, s) == ["OWN_WORDS"]
    extra = {"id": "cap9", "at": 6.0, "dur": 2.0, "text": "Be careful!"}
    a, s = variant(lambda a, s: s["captions"].append(extra))
    problems = own_script.own_problems(a, s, SCENES, CASTMAP, places=PLACES)
    assert [(p.key, p.scene_no) for p in problems] == [("OWN_EXTRA", 2)]
    assert problems[0].for_owner == "Scene 2 got something you didn't write. Tap Try again."
    assert broken(a, s, owner_cues=["cap9"]) == []
    a, s = variant(lambda a, s: s["scenes"][1].update(caption="Run!"))
    assert broken(a, s) == ["OWN_EXTRA"]
    # 3. who: a missing cast member, an added one, a piece naming Lamo tied to Rosa's beat
    a, s = variant(lambda a, s: s["scenes"][1]["actors"].pop(1))
    problems = own_script.own_problems(a, s, SCENES, CASTMAP, places=PLACES)
    assert problems[0].key == "OWN_NOT_SHOWN" and "“Rosa”" in problems[0].for_owner
    only_lamo = copy.deepcopy(SCENES)
    only_lamo[0]["who"] = ["ch1"]
    a, s = variant(lambda a, s: s["scenes"][0]["actors"].append(dict(ROSA)))
    assert broken(a, s, only_lamo) == ["OWN_EXTRA"]
    a, s = variant(lambda a, s: a["scenes"][1]["shows"][0].update(beats=[1]))
    assert broken(a, s) == ["OWN_NOT_SHOWN", "OWN_EXTRA"]  # Lamo is not drawn for his words; the run is unnamed
    # 4. a changed place
    a, s = variant(lambda a, s: s["scenes"][1].update(set="kitchen"))
    problems = own_script.own_problems(a, s, SCENES, CASTMAP, places=PLACES)
    assert [p.for_owner for p in problems] == ["Scene 2 didn't stay in the park. Tap Try again."]
    # 5. pieces that do not cover the text, an unnamed beat that is not a filler, an unnamed prop beat, lost beats
    a, s = variant(lambda a, s: a["scenes"][0]["shows"][0].update(words="Lamo wakes up"))
    assert broken(a, s) == ["OWN_LOST"]
    a, s = variant(lambda a, s: a["scenes"][0]["shows"].append(piece("and cries.", (0,))))
    assert broken(a, s) == ["OWN_LOST"]  # nothing added to what the owner wrote

    def added(do: str, who: str = "c1") -> Any:
        def change(a: dict[str, Any], s: dict[str, Any]) -> None:
            for x in (a, s):  # in the answer and, as normalizing keeps every beat, in the final script
                x["scenes"][0]["beats"].append(beat(3.5, 1.0, who, do))

        return change

    a, s = variant(added("jump"))
    assert broken(a, s) == ["OWN_EXTRA"]
    a, s = variant(added("nod"))
    assert broken(a, s) == []  # a small filler may go anywhere
    cone = {"propId": "cone1", "kind": "cone", "x": 0.8, "y": 0.8, "scale": 1, "rot": 0}

    def prop_beat(a: dict[str, Any], s: dict[str, Any]) -> None:
        added("wobble", "cone1")(a, s)
        for x in (a, s):
            x["scenes"][0]["props"].append(dict(cone))

    a, s = variant(prop_beat)
    assert broken(a, s) == ["OWN_EXTRA"]
    a, s = variant(lambda a, s: s["scenes"][0]["beats"].pop())
    assert broken(a, s) == ["OWN_LOST"]

    # 6. reading time: told to the model, shown to the owner only when nothing else is left
    def shorter(a: dict[str, Any], s: dict[str, Any]) -> None:
        s["scenes"][0]["durationSec"] = 2
        s["captions"] = own_script.owner_cues(s, own_script.scenes_of(SCENES))  # code times them in the new windows

    a, s = variant(shorter)
    problems = own_script.own_problems(a, s, SCENES, CASTMAP, places=PLACES)
    assert [(p.key, p.reading) for p in problems] == [("OWN_WORDS", True)]
    assert "scene s1 lasts 2 s; it needs at least 3 s" in problems[0].for_model
    both = [*problems, *own_script.own_problems(*variant(lambda a, s: s["scenes"][1].update(set="kitchen")), SCENES,
                                                CASTMAP, places=PLACES)]  # fmt: skip
    assert own_script.owner_sentence(both) == "Scene 2 didn't stay in the park. Tap Try again."
    assert own_script.owner_sentence(problems) == "Scene 1's caption didn't stay as you wrote it. Tap Try again."


def test_the_words_check_is_exact_case_punctuation_and_emoji_count() -> None:
    script = final_script()

    def words(text: str) -> list[str]:
        s = copy.deepcopy(script)
        next(c for c in s["captions"] if c["id"] == "w_s3").update(text=text)
        return broken(staging(), s)

    assert words("Ta-da! 🎉") == []
    assert words("  Ta-da!   🎉 ") == []  # only runs of spaces may differ
    assert words("Ta-da! ") == ["OWN_WORDS"]  # the emoji dropped
    assert words("ta-da! 🎉") == ["OWN_WORDS"]  # the case changed
    assert words("Ta-da 🎉") == ["OWN_WORDS"]  # the punctuation changed
    assert own_script.same_words("Cafe\u0301", "Café")  # NFC: a composed letter is the same letter


def test_a_left_out_name_may_be_not_shown_and_an_unknown_place_is_drawn_closest_with_a_note() -> None:
    scenes = [
        {"sceneId": "s1", "what": "Lamo and Max fly a kite on the beach.", "caption": None, "who": [], "place": None,
         "leaveOut": ["Max"]},
        {"sceneId": "s2", "what": "Lamo waves.", "caption": None, "who": [], "place": None, "leaveOut": []},
    ]  # fmt: skip
    answer = {
        "teachesSafety": False, "safetyTopicId": None,
        "scenes": [
            scene("s1", "park", [beat(0.3, 2.5, "c1", "point", face="happy")],
                  [piece("Lamo", (0,)), piece("and Max", notShown=True, why="Max is not in the cast"),
                   piece("fly a kite", (0,), closest="Lamo pointing at the sky"),
                   piece("on the beach.", place=True, closest="in the Park")], [LAMO]),
            scene("s2", "park", [beat(0.3, 1.5, "c1", "wave", face="happy")], [piece("Lamo waves.", (0,))], [LAMO]),
        ],
    }  # fmt: skip
    script = final_script(answer, scenes)
    assert own_script.own_problems(answer, script, scenes, CASTMAP, places=PLACES) == []
    assert script["scenes"][0]["note"] == (
        "Drawn a bit differently: “fly a kite” is Lamo pointing at the sky; “on the beach.” is in the Park. "
        "Not drawn: Max."
    )
    assert script["scenes"][1]["note"] is None
    assert script["scenes"][0]["title"] == "Lamo and Max fly a kite on the beach."
    assert own_script.drawn_differently(answer) == 1
    # Max not left out: the owner is told who could not be drawn, never someone made up for him
    asked = copy.deepcopy(scenes)
    asked[0]["leaveOut"] = []
    problems = own_script.own_problems(answer, final_script(answer, asked), asked, CASTMAP, places=PLACES)
    assert [p.for_owner for p in problems] == [
        "Scene 1 didn't fit: Max isn't in your cast. Add Max to the cast, or change scene 1."
    ]
    # any other piece left unshown says which words did not fit (at most 40 characters of them)
    answer["scenes"][1]["shows"] = [piece("Lamo waves.", notShown=True, why="no")]
    problems = own_script.own_problems(answer, script, scenes, CASTMAP, places=PLACES)
    assert [p.for_owner for p in problems] == [
        "Scene 2 didn't fit: we couldn't show “Lamo waves.”. Change scene 2, then tap Try again.",
        "Scene 2 got something you didn't write. Tap Try again.",  # its wave is now a beat no piece names
    ]
    assert own_script.short("x" * 50) == "x" * 40 + "…"
    assert own_script.label("Lamo wakes up very late on a rainy Monday morning again") == (
        "Lamo wakes up very late on a rainy…"
    )


def test_reading_time_length_and_the_sentences() -> None:
    assert own_script.need(None) == 3 and own_script.need("Oh no!!") == 3
    assert own_script.need("x" * 60) == 6
    four = [{"caption": "x" * 60}] * 4
    assert own_script.default_length(four) == 25
    assert own_script.default_length([{"caption": None}] * 2) == 15
    assert own_script.target(10, SCENES) == 15  # at least 15 s
    assert own_script.target(120, SCENES) == 45  # at most 15 s a scene
    assert own_script.target(None, SCENES) == 15
    assert own_script.target(200, [{"caption": "x"}] * 12) == 89.5
    assert keys.OWN_STEP_LABELS == {"storyboard": "Your script", "captions": "Add your words"}
    assert keys.OWN_LOST.format(n=2) == "Scene 2 got lost while we set it up. Tap Try again."
    assert keys.OWN_WORDS.format(n=2) == "Scene 2's caption didn't stay as you wrote it. Tap Try again."
    assert keys.OWN_NOT_SHOWN.format(n=2, words="Dash flies") == (
        "Scene 2 didn't fit: we couldn't show “Dash flies”. Change scene 2, then tap Try again."
    )
    assert keys.OWN_WHO.format(n=2, name="Max") == (
        "Scene 2 didn't fit: Max isn't in your cast. Add Max to the cast, or change scene 2."
    )
    assert keys.OWN_EXTRA.format(n=2) == "Scene 2 got something you didn't write. Tap Try again."
    assert keys.OWN_PLACE.format(n=2, place="kitchen") == "Scene 2 didn't stay in the kitchen. Tap Try again."
    assert own_script.engine_sentence(["scene 3 (s3): durationSec is 1"]) == keys.OWN_LOST.format(n=3)
    assert own_script.engine_sentence(["cast c1: bad"]) == keys.WRITER_FAILED
    assert "Funded Clips" not in json.dumps([own_script.RULES, *(getattr(keys, k) for k in dir(keys))], default=str)


def _ts_ids(key: str) -> list[str]:
    text = (ENGINE_DIR / "catalog.ts").read_text("utf-8")
    m = re.search(r"\n  " + key + r": \[(.*?)\n  \],", text, re.S)
    assert m, key
    return re.findall(r'id: "([^"]+)"', m.group(1))


def test_the_fillers_and_the_actions_match_the_engine_catalog() -> None:
    assert list(own_script.ACTIONS) == _ts_ids("actions")
    assert list(own_script.PROP_ACTIONS) == _ts_ids("propActions")
    assert set(own_script.FILLER) <= set(own_script.ACTIONS)
    assert sorted(own_script.FILLER) == ["gesture", "idle", "look_left", "look_right", "nod"]


def test_the_schema_has_no_captions_and_one_scene_per_script_scene() -> None:
    catalog = {"sets": [{"id": "park"}], "cameras": [{"id": "wide"}], "actions": [{"id": "idle"}]}
    got = own_script.schema(catalog, ["c1"], (), scene_ids=["s1", "s2"], topic_ids=["t"], shown=["t.1"])
    assert "captions" not in got["properties"] and got["required"] == ["teachesSafety", "safetyTopicId", "scenes"]
    scenes = got["properties"]["scenes"]
    assert scenes["minItems"] == scenes["maxItems"] == 2
    item = scenes["items"]["properties"]
    assert item["sceneId"]["enum"] == ["s1", "s2"]
    assert not {"title", "caption", "note"} & set(item)
    assert item["guidanceRef"]["enum"] == ["t.1", None]
    assert item["shows"]["items"] == own_script.SHOW_SCHEMA
    take = own_script.schema(catalog, ["c1"], (), scene_ids=["s2"], mode="own_scenes")
    assert take["properties"]["scenes"]["maxItems"] == 1 and "captions" not in take["properties"]


# --- the adapter in the pipeline ------------------------------------------------------------------------------------


@needs_deno
def test_the_adapter_keeps_every_scene_in_order_and_every_word_as_written(tmp_path: Path) -> None:
    svc, store, table, _models = own_world(tmp_path)
    assert run_job(svc) == "ready"
    story, script = saved(store, table)
    assert [s["sceneId"] for s in script["scenes"]] == ["s1", "s2", "s3"]
    assert [s["sceneId"] for s in story["scenes"]] == ["s1", "s2", "s3"]
    assert all(s["caption"] is None for s in script["scenes"])
    cues = {c["id"]: c for c in script["captions"]}
    assert set(cues) == {"w_s1", "w_s3"}
    assert cues["w_s1"]["text"] == "Oh no!!" and cues["w_s3"]["text"] == "Ta-da! 🎉"
    windows = writer.scene_windows(script)
    for sid in ("s1", "s3"):  # inside its scene's window after the fit
        lo, hi = windows[sid]
        assert lo <= cues[f"w_{sid}"]["at"] and cues[f"w_{sid}"]["at"] + cues[f"w_{sid}"]["dur"] <= hi + 0.05
    assert abs(sum(hi - lo for lo, hi in windows.values()) - 15) < 0.2
    assert [s["set"] for s in script["scenes"]] == ["kitchen", "park", "park"]
    assert {a["castId"] for a in script["scenes"][1]["actors"]} == {"c1", "c2"}
    assert script["scenes"][2]["note"] == "Drawn a bit differently: “Lamo juggles three balls” is a happy dance."
    assert script["title"] == TITLE and "shows" not in json.dumps(script)
    sidecar = json.loads(store.objects[story["scriptKey"].removesuffix(".json") + ".writer.json"][0])
    assert sidecar["ownScript"] is True
    assert sidecar["texts"] and all(k.startswith("post:") for k in sidecar["texts"])  # never the owner's words
    job = table.item("PJOB#J1")
    assert job is not None
    steps = {s["key"]: s for s in job["steps"]}
    assert steps["storyboard"]["label"] == "Your script" and steps["captions"]["label"] == "Add your words"
    assert steps["safety"]["label"] == "Check the facts"
    assert steps["storyboard"]["message"] == "3 scenes, 15 s · 1 drawn a bit differently"
    assert job["meta"]["targetSec"] == 15 and job["meta"]["writerModel"] == "opus-5-5"
    assert story["ownScript"] == own_story()["ownScript"]  # the agent never writes the owner's script
    assert_fenced(table, "S1")


@needs_deno
def test_the_adapter_uses_animation_plan_and_never_the_storyboard_task(tmp_path: Path) -> None:
    svc, _store, table, models = own_world(tmp_path)
    assert run_job(svc) == "ready"
    assert models.tasks() == ["animation_plan", "captions"]
    call = models.calls[0]
    assert call["ctx"].agent_id == "storyboard"
    prompt = call["messages"][0]["content"][0]["text"]
    assert prompt.startswith(writer.SYSTEM) and own_script.RULES in prompt
    assert prompt.endswith("Stage the owner's whole script.")
    assert "captions" not in call["schema"]["properties"]
    assert call["schema"]["properties"]["scenes"]["items"]["properties"]["sceneId"]["enum"] == ["s1", "s2", "s3"]
    request = request_of(call)
    assert "story" not in request and "current" not in request
    assert [s["sceneId"] for s in request["ownScript"]["scenes"]] == ["s1", "s2", "s3"]
    s2 = request["ownScript"]["scenes"][1]
    assert s2 == {"sceneId": "s2", "what": "Lamo runs to the park and Rosa waves.", "hasCaption": False,
                  "who": ["c1", "c2"], "place": "park", "leaveOut": [], "minSec": 3.0}  # fmt: skip
    assert request["targetSec"] == 15
    text = json.dumps(request, ensure_ascii=False)
    assert "Oh no!!" not in text and "Ta-da" not in text  # code places the words; the model never needs them
    assert '"look"' not in text  # never the looks
    job = table.item("PJOB#J1")
    assert job is not None
    assert [(m["step"], m["task"]) for m in job["meta"]["models"]] == [
        ("storyboard", "animation_plan"),
        ("storyboard", "captions"),
    ]
    assert job["meta"]["providers"]["writer"] == "bedrock-claude"  # E7 names the model that set up the scenes


@needs_deno
def test_the_idea_concept_is_not_sent(tmp_path: Path) -> None:
    idea = {"pk": PK, "sk": "IDEA#I1", "type": "ws_idea", "userId": USER, "workspaceId": WS, "ideaId": "I1",
            "title": "An idea", "logline": "The idea's own logline.", "concept": {"beats": ["The idea's beat."]}}  # fmt: skip
    story = own_story(ideaId="I1", brief={"title": TITLE, "category": "comedy"})
    svc, _store, table, models = own_world(tmp_path, story=story)
    table.seed(idea)
    assert run_job(svc) == "ready"
    for call in models.calls:
        assert "idea's" not in json.dumps(call["messages"], ensure_ascii=False)
    post = request_of(models.calls[1])
    assert post["story"] == {"title": TITLE, "category": "comedy", "scenes": [s["what"] for s in SCENES]}


@needs_deno
def test_the_adapter_is_asked_once_more_then_fails_naming_the_scene_without_saving(tmp_path: Path) -> None:
    bad = staging()
    bad["scenes"][1]["set"] = "kitchen"  # the owner said the park
    replies = answers(animation_plan=[bad, copy.deepcopy(bad)], storyboard=AssertionError("never"))
    svc, store, table, models = own_world(tmp_path, replies=replies)
    assert run_job(svc) == "failed"
    assert models.tasks() == ["animation_plan", "animation_plan"]
    retry = models.calls[1]
    assert "Your last staging broke these rules. Fix exactly these:" in retry["messages"][0]["content"][0]["text"]
    assert "scene s2 happens in park: use set park." in request_of(retry)["problems"]
    job, story = table.item("PJOB#J1"), table.item(f"STORY#{STORY}")
    assert job is not None and story is not None
    assert job["error"] == "Scene 2 didn't stay in the park. Tap Try again."
    assert job["steps"][0]["status"] == "failed" and job["steps"][0]["message"] == job["error"]
    # nothing that changed the story is saved: no script, no sidecar, no storyboard row, no story fields
    assert story["scriptVersion"] == 0 and "scriptKey" not in story and story["scenes"] == []
    assert not store.objects and not [a for a in table.prefix("ASSET#") if a["kind"] == "storyboard"]
    assert story["status"] == "failed"

    # the second staging fixes it: the video is made
    good = answers(animation_plan=[bad, staging()], storyboard=AssertionError("never"))
    svc, store, table, models = own_world(tmp_path / "again", replies=good)
    assert run_job(svc) == "ready"
    assert models.tasks() == ["animation_plan", "animation_plan", "captions"]


@needs_deno
def test_the_fact_check_reports_but_never_rewrites_an_owner_script(tmp_path: Path) -> None:
    scenes = [
        {"sceneId": "s1", "what": "Lamo drives into thick fog.", "caption": "Fog ahead!", "who": [], "place": None,
         "leaveOut": []},
        {"sceneId": "s2", "what": "Lamo puts on full beam in the fog.", "caption": "Full beam on!", "who": [],
         "place": "foggy_road", "leaveOut": []},
    ]  # fmt: skip
    car = {"propId": "car1", "kind": "car", "x": 0.5, "y": 0.75, "scale": 1, "rot": 0, "state": "driving"}
    driver = {"castId": "c1", "x": 0.5, "y": 0.72, "facing": "right", "inCar": "car1"}
    answer = {
        "teachesSafety": True, "safetyTopicId": "fog-driving",
        "scenes": [
            scene("s1", "foggy_road", [beat(0, 5, "c1", "drive", face="neutral"), beat(0, 5, "car1", "move")],
                  [piece("Lamo drives into thick fog.", (0, 1), place=True)], [driver], props=[dict(car)]),
            scene("s2", "foggy_road", [beat(0, 5, "c1", "drive", face="happy"), beat(1, 1, "car1", "blink")],
                  [piece("Lamo puts on full beam", (0, 1)), piece("in the fog.", place=True)], [driver],
                  props=[dict(car)]),
        ],
    }  # fmt: skip
    flagged = {"ok": False, "problems": [
        {"ref": "own:s2", "problem": "The checked advice says to use dipped headlights in fog."},
        {"ref": "caption:w_s2", "problem": "Full beam in fog dazzles you."},
        {"ref": "beat:s2:1", "problem": "Flashing full beam in fog is not on the checked list."},
        {"ref": "post:x", "problem": "This post tells people to use full beam in fog."},
    ]}  # fmt: skip
    still = {"ok": False, "problems": flagged["problems"][:2]}
    replies = answers(animation_plan=answer, storyboard=AssertionError("the writer's fix never runs"),
                      captions=[dict(POST), {**POST, "x": "Lamo meets the fog."}], fact_check=[flagged, still])  # fmt: skip
    story = own_story(scenes, category="driving_safety", safetyTopicId="fog-driving", characterIds=["ch1"])
    svc, store, table, models = own_world(tmp_path, replies=replies, story=story, run=CHECK_RUN)
    assert run_job(svc) == "needs_check"
    assert models.tasks() == ["animation_plan", "captions", "fact_check", "captions", "fact_check"]
    check = models.calls[2]
    assert check["messages"][0]["content"][0]["text"].endswith(safety.OWN_CHECK_LINE)
    items = {i["ref"]: i for i in request_of(check)["items"]}
    assert items["own:s2"]["text"] == "Lamo puts on full beam in the fog."
    assert items["caption:w_s2"]["text"] == "Full beam on!"
    fix = models.calls[3]["messages"][0]["content"][-1]["text"]
    assert "post captions" in fix and "x: This post tells people" in fix
    story_now, script = saved(store, table)
    assert story_now["status"] == "needs_check" and story_now["scriptVersion"] == 2
    assert story_now["postCaptions"]["x"] == "Lamo meets the fog."  # only the AI's post caption changed
    first = json.loads(store.objects[PREFIX + "script/v1.json"][0])
    assert script["scenes"] == first["scenes"] and script["captions"] == first["captions"]  # the owner's story stays
    assert [c["text"] for c in script["captions"]] == ["Fog ahead!", "Full beam on!"]
    assert story_now["safety"]["status"] == "problems"
    assert story_now["safety"]["problems"] == [
        "Your scene 2: The checked advice says to use dipped headlights in fog.",
        "Your scene 2's caption “Full beam on!”: Full beam in fog dazzles you.",
    ]
    job = table.item("PJOB#J1")
    assert job is not None and job["steps"][1]["message"] == "2 things to check in your script"
    assert story_now["ownScript"]["scenes"][1]["what"] == "Lamo puts on full beam in the fog."


@needs_deno
def test_an_owner_script_that_teaches_driving_is_checked_and_held_without_a_topic(tmp_path: Path) -> None:
    answer = staging()
    answer.update({"teachesSafety": True, "safetyTopicId": None})
    advice = {"ok": False, "problems": [{"ref": "own:s1", "problem": "This gives driving advice."}]}
    replies = answers(animation_plan=answer, storyboard=AssertionError("never"), fact_check=quality_off(advice))
    svc, _store, table, models = own_world(tmp_path, replies=replies, run=CHECK_RUN)
    assert run_job(svc) == "needs_check"
    checks = [c for c in models.calls if c["task"] == "fact_check"]
    assert checks and all(c.get("allow_inactive") is True for c in checks)  # never skipped, the agent's switch off
    assert {i["ref"] for i in request_of(checks[0])["items"]} >= {"own:s1", "own:s2", "own:s3", "caption:w_s1"}
    story = table.item(f"STORY#{STORY}")
    assert story is not None and story["status"] == "needs_check"
    assert story["safety"]["problems"] == ["Your scene 1: This gives driving advice.", HELD_TOPIC]


@needs_deno
def test_series_memory_and_the_cast_with_its_car_reach_the_adapter(tmp_path: Path) -> None:
    scenes = [
        {"sceneId": "s1", "what": "Lamo drives Rosso to the park.", "caption": None, "who": ["ch1", "ch3"],
         "place": "park", "leaveOut": []},
        {"sceneId": "s2", "what": "Rosso honks and Lamo laughs.", "caption": "Beep!", "who": [], "place": None,
         "leaveOut": []},
    ]  # fmt: skip
    car = {"propId": "car1", "kind": "car", "castId": "c2", "x": 0.5, "y": 0.75, "scale": 1, "rot": 0,
           "state": "driving"}  # fmt: skip
    driver = {"castId": "c1", "x": 0.5, "y": 0.72, "facing": "right", "inCar": "car1"}
    answer = {
        "teachesSafety": False, "safetyTopicId": None,
        "scenes": [
            scene("s1", "park", [beat(0, 5, "c1", "drive", face="happy"), beat(0, 5, "car1", "move")],
                  [piece("Lamo drives Rosso", (0, 1)), piece("to the park.", place=True)], [driver],
                  props=[dict(car)]),
            scene("s2", "park", [beat(0.5, 1, "car1", "honk", sfx="honk"), beat(1.5, 2, "c1", "idle", face="happy")],
                  [piece("Rosso honks", (0,), sfx=[0]), piece("and Lamo laughs.", (1,))], [driver],
                  props=[{**car, "state": "parked"}]),
        ],
    }  # fmt: skip
    story = own_story(scenes, characterIds=["ch1", "ch3"], seriesId="SR1")
    svc, store, table, models = own_world(tmp_path, story=story,
                                          replies=answers(animation_plan=answer, storyboard=AssertionError("never")))  # fmt: skip
    table.seed(rosso())
    table.seed({"pk": PK, "sk": "SERIES#SR1", "type": "ws_series", "userId": USER, "workspaceId": WS,
                "seriesId": "SR1", "name": "My first car", "line": "Lamo and Rosso", "castIds": ["ch1", "ch3"],
                "storySoFar": "Who: Lamo and Rosso.", "summaries": [], "version": 1})  # fmt: skip
    assert run_job(svc) == "ready"
    request = request_of(models.calls[0])
    assert request["series"]["storySoFar"] == "Who: Lamo and Rosso." and request["series"]["episode"] == 1
    assert [(c["castId"], c["kind"]) for c in request["cast"]] == [("c1", "person"), ("c2", "car")]
    assert request["ownScript"]["scenes"][0]["who"] == ["c1", "c2"]  # the car of the cast by its cast key
    _story, script = saved(store, table)
    assert script["cars"]["c2"]["name"] == "Rosso" and "c2" not in script["cast"]
    assert [c["text"] for c in script["captions"]] == ["Beep!"]


@needs_deno
def test_remake_this_scene_on_an_owner_script_keeps_its_pieces_and_words(tmp_path: Path) -> None:
    svc, store, table, models = own_world(tmp_path)
    assert run_job(svc) == "ready"
    _first_story, first = saved(store, table)
    take = staging()["scenes"][2]
    take["camera"] = "close"
    take["beats"] = [beat(0.2, 2.5, "c1", "celebrate", face="happy"), beat(0.5, 1.0, "c2", "wave", face="happy")]
    models.answers["animation_plan"] = {"scenes": [take], "teachesSafety": None}
    table.seed({**table.items[(PK, f"STORY#{STORY}")], "status": "producing", "currentJobId": "J2"})
    table.seed(job_item("J2", "S2", run=RUN, job_type="changes", sceneIds=["s3"], note="Make it longer"))
    assert run_job(svc, "J2", "S2") == "ready"
    call = models.calls[-2]
    assert call["task"] == "animation_plan"
    prompt = call["messages"][0]["content"][0]["text"]
    assert "Stage a new take of only these scenes: s3." in prompt and "Make it longer" not in prompt  # no note
    assert call["schema"]["properties"]["scenes"]["maxItems"] == 1
    assert request_of(call)["sceneIds"] == ["s3"] and "current" in request_of(call)
    story, script = saved(store, table)
    assert story["scriptVersion"] == 2
    assert script["scenes"][:2] == first["scenes"][:2]
    s3 = script["scenes"][2]
    assert s3["camera"] == "close" and s3["durationSec"] == first["scenes"][2]["durationSec"]
    assert s3["seed"] == keys.seed_for("J2", "scene", "s3")
    assert script["captions"] == first["captions"]  # the words and their timing stay


@needs_deno
def test_fit_and_normalize_keep_the_owner_words_and_scene_order(tmp_path: Path) -> None:
    answer = staging()
    for s, d in zip(answer["scenes"], (4, 7, 9), strict=True):
        s["durationSec"] = d
    cast = {"c1": next(iter(json.loads((ENGINE_DIR / "fixtures" / "sample-script.json").read_text())["cast"].values()))}
    cast["c2"] = {**cast["c1"], "characterId": "ch2", "name": "Rosa"}
    script = own_script.script_from_own(answer, own_script.scenes_of(SCENES), title=TITLE, engine_version=6, seed=3,
                                        cast=cast, captions_on=True, music=None, topic=None)  # fmt: skip
    engine = Engine(ENGINE_DIR, tmp_path / ".deno")
    path = tmp_path / "s.json"

    async def go() -> dict[str, Any]:
        path.write_text(json.dumps(script))
        assert await engine.validate(path) == []
        normal = await engine.normalize(path)
        path.write_text(json.dumps(normal))
        return await engine.fit(path, 30)

    fitted = asyncio.run(go())
    assert [s["sceneId"] for s in fitted["scenes"]] == ["s1", "s2", "s3"]
    assert [(c["id"], c["text"]) for c in fitted["captions"]] == [("w_s1", "Oh no!!"), ("w_s3", "Ta-da! 🎉")]
    windows = writer.scene_windows(fitted)
    for c in fitted["captions"]:
        lo, hi = windows[c["id"].removeprefix("w_")]
        assert lo - 0.05 <= c["at"] and c["at"] + c["dur"] <= hi + 0.05
    assert own_script.own_problems(answer, fitted, SCENES, CASTMAP, places=PLACES) == []


# --- the story so far reads the owner's scenes ---------------------------------------------------------------------


def test_the_recap_reads_the_owners_scenes(tmp_path: Path) -> None:
    from test_tasks_series import answer, run
    from test_tasks_series import story_item as series_story
    from test_tasks_series import world as series_world
    from test_tasks_support import FakeModel

    model = FakeModel(answer())
    svc, db = series_world(tmp_path, model)
    db.seed(series_story(ownScript={"scenes": copy.deepcopy(SCENES)}))
    assert run(svc) == "done"
    text = model.texts(0)
    assert recap_task.OWN_SCRIPT_RULE in text
    data = json.loads(text.split("DATA as JSON:\n", 1)[1])
    assert data["episode"]["ownScript"] == [
        {"what": "Lamo wakes up late.", "caption": "Oh no!!"},
        {"what": "Lamo runs to the park and Rosa waves.", "caption": None},
        {"what": "Lamo juggles three balls for Rosa.", "caption": "Ta-da! 🎉"},
    ]
    # a story the AI wrote sends the recap what it always did
    model2 = FakeModel(answer())
    svc2, _db2 = series_world(tmp_path / "plain", model2)
    assert run(svc2) == "done"
    assert recap_task.OWN_SCRIPT_RULE not in model2.texts(0)
    assert "ownScript" not in json.loads(model2.texts(0).split("DATA as JSON:\n", 1)[1])["episode"]


def test_a_story_the_ai_wrote_is_never_an_owner_script() -> None:
    ai = story_item(scenes=[{"sceneId": "s1", "title": "Icy road", "durationSec": 3}])
    assert own_script.scenes_of(ai) == [] and own_script.scenes_of({**ai, "ownScript": None}) == []
    assert [s["sceneId"] for s in own_script.scenes_of(own_story())] == ["s1", "s2", "s3"]
    assert own_script.scenes_of({"scenes": SCENES}) == own_script.scenes_of(SCENES)


def test_the_checker_items_of_a_story_the_ai_wrote_are_as_before() -> None:
    script = final_script()
    plain = safety.items(script, dict(POST))
    assert not [i for i in plain if i["ref"].startswith("own:")]
    assert [i["where"] for i in plain if i["ref"].startswith("caption:")] == [
        "Caption “Oh no!!”",
        "Caption “Ta-da! 🎉”",
    ]
    own = safety.items(script, dict(POST), own=own_script.scenes_of(SCENES))
    assert [i["ref"] for i in own][:3] == ["own:s1", "own:s2", "own:s3"]
    assert [i["where"] for i in own if i["ref"].startswith("caption:")] == [
        "Your scene 1's caption “Oh no!!”",
        "Your scene 3's caption “Ta-da! 🎉”",
    ]
    assert OK["ok"] is True
