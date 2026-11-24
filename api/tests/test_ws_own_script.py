"""Write it myself: a video made from the owner's own script of what happens (docs/CONTRACTS.md §45.46)."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import catalog, guidance, own_script
from conftest import Call
from fakes import FakeAgentCore, FakeS3
from ws_support import (
    BASE,
    caller,
    install,
    leaked,
    pk,
    script,
    seed_character,
    seed_idea,
    seed_story,
    story_key,
)

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / "web" / "src" / "stories" / "engine"
ALL = ["storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview"]
CAPTION_STEPS = ["safety", "captions", "assemble", "preview"]


@pytest.fixture
def call(app: App) -> Call:
    return caller(app)


@pytest.fixture(autouse=True)
def wired(app: App, agentcore: FakeAgentCore, s3_client: FakeS3) -> None:
    install(app, agentcore, s3_client)


@pytest.fixture
def dash(store: db.Store) -> str:
    return str(seed_character(store, name="Dash")["characterId"])


@pytest.fixture
def rosa(store: db.Store) -> str:
    return str(seed_character(store, name="Rosa")["characterId"])


def _stored(store: db.Store, story_id: str) -> dict[str, Any]:
    found = store.get(pk(), f"STORY#{story_id}")
    assert found is not None
    return found


def _scene(what: str, caption: str | None = None, **more: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"what": what, **more}
    if caption is not None:
        out["caption"] = caption
    return out


def _create(call: Call, cast: list[str], scenes: list[dict[str, Any]], **body: Any) -> tuple[int, Any]:
    brief = body.pop("brief", {"title": "Dash learns to juggle", "category": "comedy"})
    payload: dict[str, Any] = {"characterIds": cast, "ownScript": {"scenes": scenes}, **body}
    if "ideaId" not in body:
        payload["brief"] = brief
    return call("POST", f"{BASE}/stories", payload)


def _full(scene_id: str, what: str, caption: str | None = None, **more: Any) -> dict[str, Any]:
    return {"sceneId": scene_id, "what": what, "caption": caption, "who": [], "place": None, "leaveOut": [], **more}


OWN = {
    "scenes": [
        _full("s1", "Dash wakes up late.", "Oh no!", place="kitchen"),
        _full("s2", "Dash runs for the bus."),
    ]
}


def _made_own(store: db.Store, s3_client: FakeS3, cast: list[str], **fields: Any) -> dict[str, Any]:
    """A made video of an owner's script: scene s1 has the caption "Oh no!" (cue w_s1), scene s2 none."""
    story = seed_story(store, s3_client, characterIds=cast, ownScript=copy.deepcopy(fields.pop("own", OWN)), **fields)
    staged = script()  # two scenes of 3 s
    for scene in staged["scenes"]:
        scene["caption"] = None
    staged["captions"] = [{"id": "w_s1", "at": 0.25, "dur": 2.5, "text": "Oh no!"}]
    s3_client.objects[story["scriptKey"]] = json.dumps(staged).encode()
    return story


def _patch(call: Call, story: dict[str, Any], **changes: Any) -> tuple[int, Any]:
    return call("PATCH", f"{BASE}/stories/{story['storyId']}", {"version": story["version"], **changes})


def _with(own: dict[str, Any], n: int, **changes: Any) -> dict[str, Any]:
    out = copy.deepcopy(own)
    out["scenes"][n].update(changes)
    return out


# --- create ---------------------------------------------------------------------------------------------------


def test_create_with_an_own_script_stores_it_gives_ids_and_starts_production(
    call: Call, store: db.Store, agentcore: FakeAgentCore, dash: str, rosa: str
) -> None:
    scenes = [
        _scene("Dash wakes up late.", "Oh no!", who=[dash], place="kitchen", sceneId="s9"),
        _scene("Rosa throws him three apples.", who=[rosa, dash, rosa]),
        _scene("Dash juggles them all.", "Ta-da!", leaveOut=["Max", " Max "]),
    ]
    status, body = _create(call, [dash, rosa], scenes)
    assert status == 201
    story, job = body["story"], body["job"]
    assert story["ownScript"] == {
        "scenes": [
            _full("s1", "Dash wakes up late.", "Oh no!", who=[dash], place="kitchen"),
            _full("s2", "Rosa throws him three apples.", who=[rosa, dash]),
            _full("s3", "Dash juggles them all.", "Ta-da!", leaveOut=["Max"]),
        ]
    }
    assert story["status"] == "producing"
    assert story["title"] == "Dash learns to juggle"
    assert job["configuration"] == {"run": ALL, "from": None, "sceneIds": None, "note": None}
    assert agentcore.calls[-1]["payload"]["action"] == "process_story"
    item = _stored(store, story["storyId"])
    assert own_script.public(item["ownScript"]) == story["ownScript"]  # DynamoDB keeps no nulls inside a map
    # The brief needs no line: scene 1 gives it.
    assert item["brief"] == {"title": "Dash learns to juggle", "logline": "Dash wakes up late.", "category": "comedy"}


def test_an_own_script_can_start_from_an_idea_and_its_concept_is_not_used(
    call: Call, store: db.Store, dash: str
) -> None:
    idea = seed_idea(
        store,
        concept={
            "premise": "p",
            "beats": ["a", "b"],
            "lesson": None,
            "ending": "e",
            "tone": "funny",
            "durationSec": 60,
            "onScreenText": ["x"],
        },
    )
    status, body = _create(
        call, [dash], [_scene("Dash dances."), _scene("The toast burns.", "Oops")], ideaId=idea["ideaId"]
    )
    assert status == 201
    story = body["story"]
    assert story["title"] == "The kitchen dance"
    assert story["ideaId"] == idea["ideaId"]
    assert story["durationSec"] == 15  # the script's length, never the concept's 60 s
    item = _stored(store, story["storyId"])
    assert "concept" not in item["brief"]
    assert item["brief"]["logline"] == "Lamo dances while the toast burns."  # the idea's own line
    assert call("GET", f"{BASE}/ideas")[1]["ideas"][0]["status"] == "used"
    # The owner's title overrides the idea's, as it always does.
    status, body = _create(
        call, [dash], [_scene("Dash dances."), _scene("Bye.")], ideaId=idea["ideaId"], title="My dance"
    )
    assert (status, body["story"]["title"]) == (201, "My dance")


def _scenes(n: int) -> list[dict[str, Any]]:
    return [_scene(f"Dash does thing {k + 1}.") for k in range(n)]


@pytest.mark.parametrize(
    ("scenes", "message", "field"),
    [
        (_scenes(1), "Write at least 2 scenes.", "ownScript.scenes"),
        (_scenes(13), "Up to 12 scenes.", "ownScript.scenes"),
        ([_scene("Dash wakes."), _scene("   ")], "Scene 2 is empty. Write what happens.", "ownScript.scenes[1].what"),
        (
            [_scene("Dash wakes."), {"caption": "Hi"}],
            "Scene 2 is empty. Write what happens.",
            "ownScript.scenes[1].what",
        ),
        (
            [_scene("x" * 161), _scene("Dash wakes.")],
            "Scene 1 is too long. Use 160 letters or fewer.",
            "ownScript.scenes[0].what",
        ),
        ([_scene("Dash\u0007 wakes."), _scene("Bye.")], "Use plain letters in scene 1.", "ownScript.scenes[0].what"),
        ([_scene("Dash\twakes."), _scene("Bye.")], "Use plain letters in scene 1.", "ownScript.scenes[0].what"),
        (
            [_scene("Dash wakes."), _scene("Bye.", "y" * 61)],
            "Scene 2's caption is too long. Use 60 letters or fewer.",
            "ownScript.scenes[1].caption",
        ),
        (
            [_scene("Dash wakes."), _scene("Bye.", "Oh\nno")],
            "Use plain letters in scene 2.",
            "ownScript.scenes[1].caption",
        ),
        (
            [_scene("Dash wakes.", who=["01J0000000000000000000000Z"]), _scene("Bye.")],
            "Scene 1 has someone who isn't in the cast.",
            "ownScript.scenes[0].who",
        ),
        (
            [_scene("Dash wakes.", place="beach"), _scene("Bye.")],
            "Scene 1's place isn't one we can draw. Pick one from the list.",
            "ownScript.scenes[0].place",
        ),
        (
            [_scene("Dash wakes.", leaveOut=["A", "B", "C", "D", "E", "F"]), _scene("Bye.")],
            "Scene 1 leaves out too many names. Keep 5 or fewer.",
            "ownScript.scenes[0].leaveOut",
        ),
        (
            [_scene("Dash wakes.", leaveOut=["M" * 41]), _scene("Bye.")],
            "Scene 1 has a name that is too long. Use 40 letters or fewer.",
            "ownScript.scenes[0].leaveOut",
        ),
    ],
)
def test_bad_own_scripts_are_400_with_kid_sentences(
    call: Call, dash: str, scenes: list[dict[str, Any]], message: str, field: str
) -> None:
    status, body = _create(call, [dash], scenes)
    assert (status, body["error"]["message"], body["error"]["field"]) == (400, message, field)


def test_bad_bodies_around_an_own_script_are_400(call: Call, dash: str) -> None:
    two = [_scene("Dash wakes."), _scene("Bye.")]
    assert _create(call, [dash], [*two[:1], {"what": "x", "mood": "sad"}])[0] == 400
    assert _create(call, [dash], two, brief={"category": "comedy"})[0] == 400  # a title is still needed
    assert _create(call, [dash], two, brief={"title": "x", "category": "rap"})[0] == 400
    assert call("POST", f"{BASE}/stories", {"characterIds": [dash], "ownScript": {"scenes": two, "x": 1}})[0] == 400
    # Without an own script a brief's line is still required, as before.
    status, _ = call("POST", f"{BASE}/stories", {"characterIds": [dash], "brief": {"title": "x", "category": "comedy"}})
    assert status == 400


def test_words_are_never_cut_or_changed(call: Call, dash: str) -> None:
    sixty = "A" * 58 + "!?"
    emoji = "Oh no!! 🙈🎉 Ça va? 👨‍👩‍👧"  # a family emoji is joined by zero-width joiners
    what = "Dash wakes up.\nHe yawns  twice."
    status, body = _create(
        call,
        [dash],
        [_scene("  " + what + "  ", "  " + sixty + "  "), _scene("x" * 160, emoji), _scene("Bye.", "   ")],
    )
    assert status == 201
    scenes = body["story"]["ownScript"]["scenes"]
    assert [s["what"] for s in scenes] == [what, "x" * 160, "Bye."]
    assert [s["caption"] for s in scenes] == [sixty, emoji, None]  # only the ends are trimmed; empty is no caption
    got = call("GET", f"{BASE}/stories/{body['story']['storyId']}")[1]["story"]["ownScript"]
    assert got == body["story"]["ownScript"]


# --- the topic, the captions switch and the length ------------------------------------------------------------


def test_an_own_script_safety_story_needs_checked_advice_matched_from_its_scenes(call: Call, dash: str) -> None:
    brief = {"title": "Dash drives home", "category": "driving_safety"}
    scenes = [_scene("Dash drives home after school."), _scene("Thick fog rolls in.", "Slow down")]
    status, body = _create(call, [dash], scenes, brief=brief)
    assert (status, body["story"]["safetyTopicId"]) == (201, "fog-driving")
    # Words with no checked advice cannot become a safety video.
    status, body = _create(call, [dash], [_scene("Dash drives home."), _scene("A volcano erupts.")], brief=brief)
    assert status == 409
    assert body["error"]["message"] == guidance.NO_GUIDANCE
    assert {"id": "skid-recovery"}.items() <= body["error"]["topics"][0].items()


def test_a_matched_topic_is_kept_for_any_kind(call: Call, store: db.Store, s3_client: FakeS3, dash: str) -> None:
    scenes = [_scene("Dash looks for his hat."), _scene("The fog rolls in and hides it.")]
    status, body = _create(call, [dash], scenes)
    assert (status, body["story"]["category"], body["story"]["safetyTopicId"]) == (201, "comedy", "fog-driving")
    plain = _create(call, [dash], [_scene("Dash looks for his hat."), _scene("It is on his head.")])[1]["story"]
    assert plain["safetyTopicId"] is None
    # A kind that is not driving safety, with a matched topic, is never approved on a skipped fact check.
    skipped = {"topicId": None, "status": "skipped", "problems": [], "checkedScriptVersion": 1, "citations": []}
    story = _made_own(store, s3_client, [dash], safetyTopicId="fog-driving", safety=skipped)
    status, _ = call("POST", f"{BASE}/stories/{story['storyId']}/approve", {"version": story["version"]})
    assert status == 409


def test_captions_on_and_length_defaults(call: Call, dash: str) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    status, _ = call("PATCH", BASE, {"version": version, "configuration": {"captionsOn": False}})
    assert status == 200
    no_words = [_scene(f"Dash does thing {k}.") for k in range(4)]
    story = _create(call, [dash], no_words)[1]["story"]
    assert (story["captionsOn"], story["durationSec"]) == (False, 20)  # the workspace's switch; 4 scenes of 5 s
    words = [_scene(f"Dash does thing {k}.", "Z" * 60) for k in range(12)]
    story = _create(call, [dash], words)[1]["story"]
    assert (story["captionsOn"], story["durationSec"]) == (
        True,
        75,
    )  # words on screen: 12 scenes of 6 s to read, rounded up
    story = _create(call, [dash], words, captionsOn=False, durationSec=40)[1]["story"]
    assert (story["captionsOn"], story["durationSec"]) == (False, 40)  # what the owner picked always wins


def test_reading_time_and_the_default_length() -> None:
    assert own_script.need({"caption": None}) == 3
    assert own_script.need({"caption": "Oh no!"}) == 3
    assert own_script.need({"caption": "x" * 60}) == 6
    assert own_script.need({"caption": "x" * 30}) == 4
    two = {"scenes": [{"caption": None}, {"caption": None}]}
    assert own_script.default_length(two) == 15
    assert own_script.default_length({"scenes": [{"caption": None}] * 12}) == 60
    assert own_script.default_length({"scenes": [{"caption": "x" * 60}] * 12}) == 75
    assert own_script.default_length({"scenes": [{"caption": "x" * 45}] * 7}) == 35


# --- shown -----------------------------------------------------------------------------------------------------


def test_the_own_script_is_shown_and_old_stories_have_none(
    call: Call, store: db.Store, s3_client: FakeS3, dash: str
) -> None:
    created = _create(call, [dash], [_scene("Dash wakes up late.", "Oh no!"), _scene("Dash runs.")])[1]
    got = call("GET", f"{BASE}/stories/{created['story']['storyId']}")[1]
    listed = call("GET", f"{BASE}/stories")[1]
    assert got["story"]["ownScript"]["scenes"][0]["caption"] == "Oh no!"
    assert listed["stories"][0]["ownScript"] == got["story"]["ownScript"]
    old = seed_story(store, s3_client)
    shown = call("GET", f"{BASE}/stories/{old['storyId']}")[1]
    assert "ownScript" not in shown["story"]
    assert leaked([created, got, listed, shown]) == []


def test_job_steps_say_your_script(call: Call, store: db.Store, s3_client: FakeS3, dash: str) -> None:
    def labels(job: dict[str, Any]) -> dict[str, str]:
        return {s["key"]: s["label"] for s in job["steps"]}

    words = _create(call, [dash], [_scene("Dash wakes up late.", "Oh no!"), _scene("Dash runs.")])[1]["job"]
    assert labels(words)["storyboard"] == "Your script"
    assert labels(words)["captions"] == "Add your words"
    assert labels(words)["safety"] == "Check the facts"
    quiet = _create(call, [dash], [_scene("Dash wakes up late."), _scene("Dash runs.")])[1]["job"]
    assert (labels(quiet)["storyboard"], labels(quiet)["captions"]) == ("Your script", "Add captions")
    # A remake of an owner's script says the same; an old story's job is word for word as before.
    own = _made_own(store, s3_client, [dash])
    again = call("POST", f"{BASE}/stories/{own['storyId']}/produce", {"from": "storyboard"})[1]["job"]
    assert (labels(again)["storyboard"], labels(again)["captions"]) == ("Your script", "Add your words")
    old = seed_story(store, s3_client)
    before = call("POST", f"{BASE}/stories/{old['storyId']}/produce", {"from": "storyboard"})[1]["job"]
    assert (labels(before)["storyboard"], labels(before)["captions"]) == ("Write the story", "Add captions")


# --- PATCH ------------------------------------------------------------------------------------------------------


def test_patch_words_only_updates_the_cues_and_marks_only_caption_steps_stale(
    call: Call, store: db.Store, s3_client: FakeS3, dash: str
) -> None:
    story = _made_own(store, s3_client, [dash])
    new = _with(_with(OWN, 0, caption="Oh no!!"), 1, caption="Run, Dash!")
    status, body = _patch(call, story, ownScript=new)
    assert status == 200
    out = body["story"]
    assert out["stale"] == CAPTION_STEPS
    assert out["scriptVersion"] == 2
    assert out["safety"]["status"] == "pending"
    assert out["ownScript"] == new
    v2 = json.loads(s3_client.objects[story_key(story["storyId"], "script/v2.json")])
    assert v2["captions"] == [
        {"id": "w_s1", "at": 0.25, "dur": 2.5, "text": "Oh no!!"},
        {"id": "w_s2", "at": 3.25, "dur": 2.5, "text": "Run, Dash!"},  # inside scene 2's window (3 to 6 s)
    ]
    assert [s["caption"] for s in v2["scenes"]] == [None, None]
    item = _stored(store, story["storyId"])
    assert item["ownerEdits"]["captions"] == ["w_s1", "w_s2"]
    library = call("GET", f"{BASE}/library")[1]["items"]
    assert any(i["kind"] == "storyboard" and i["meta"] == {"current": 1, "by": "owner"} for i in library)
    # A cleared caption takes its cue out.
    status, body = _patch(call, {**story, "version": out["version"]}, ownScript=_with(new, 0, caption=None))
    assert status == 200
    v3 = json.loads(s3_client.objects[story_key(story["storyId"], "script/v3.json")])
    assert [c["id"] for c in v3["captions"]] == ["w_s2"]
    assert body["story"]["ownScript"]["scenes"][0]["caption"] is None
    # The same script again changes nothing.
    same = body["story"]
    status, body = _patch(call, same, ownScript=same["ownScript"])
    assert (status, body["story"]["version"], body["story"]["scriptVersion"]) == (200, same["version"], 3)


def test_patch_anything_else_marks_every_step_stale(
    call: Call, store: db.Store, s3_client: FakeS3, agentcore: FakeAgentCore, dash: str, rosa: str
) -> None:
    story = _made_own(store, s3_client, [dash, rosa])
    swapped = {"scenes": [OWN["scenes"][1], OWN["scenes"][0]]}
    status, body = _patch(call, story, ownScript=swapped)
    assert status == 200
    out = body["story"]
    assert out["stale"] == ALL
    assert out["scriptVersion"] == 1  # the script is staged again by the agent, not edited here
    assert story_key(story["storyId"], "script/v2.json") not in s3_client.objects
    assert [(s["sceneId"], s["what"]) for s in out["ownScript"]["scenes"]] == [
        ("s1", "Dash runs for the bus."),
        ("s2", "Dash wakes up late."),
    ]
    assert out["safety"]["status"] == "pending"
    job = call("POST", f"{BASE}/stories/{story['storyId']}/produce", {})[1]["job"]
    assert job["configuration"]["run"] == ALL
    # Who is in a scene, a scene added and a changed place each stage it again too.
    for change in (
        _with(OWN, 1, who=[rosa]),
        {"scenes": [*OWN["scenes"], _full("s3", "Dash gets on.")]},
        _with(OWN, 0, place="park"),
    ):
        fresh = _made_own(store, s3_client, [dash, rosa])
        assert _patch(call, fresh, ownScript=change)[1]["story"]["stale"] == ALL
    # Someone not in the cast is refused, as on create.
    fresh = _made_own(store, s3_client, [dash])
    status, body = _patch(call, fresh, ownScript=_with(OWN, 1, who=[rosa]))
    assert (status, body["error"]["message"]) == (400, "Scene 2 has someone who isn't in the cast.")


def test_a_restaged_safety_story_needs_checked_advice_for_its_new_words(
    call: Call, store: db.Store, s3_client: FakeS3, dash: str
) -> None:
    own = {"scenes": [_full("s1", "Dash drives home."), _full("s2", "Thick fog rolls in.", "Slow down")]}
    story = _made_own(
        store, s3_client, [dash], own=own, title="Home", category="driving_safety", safetyTopicId="fog-driving"
    )
    status, body = _patch(call, story, ownScript=_with(own, 1, what="A volcano erupts."))
    assert (status, body["error"]["message"]) == (409, guidance.NO_GUIDANCE)
    assert _stored(store, story["storyId"])["version"] == story["version"]
    status, body = _patch(call, story, ownScript=_with(own, 1, what="The road turns to black ice and Dash skids."))
    assert (status, body["story"]["safetyTopicId"]) == (200, "skid-recovery")


def test_a_patch_of_an_own_script_needs_one(call: Call, store: db.Store, s3_client: FakeS3, dash: str) -> None:
    old = seed_story(store, s3_client, characterIds=[dash])
    status, body = _patch(call, old, ownScript=OWN)
    assert (status, body["error"]["message"], body["error"]["field"]) == (
        400,
        "This video has no script of yours.",
        "ownScript",
    )
    story = _made_own(store, s3_client, [dash])
    status, body = _patch(call, story, ownScript=OWN, captions=[])
    assert status == 400
    status, body = _patch(call, story, ownScript={"scenes": OWN["scenes"][:1]})
    assert (status, body["error"]["message"]) == (400, "Write at least 2 scenes.")


def test_a_caption_edit_is_mirrored_into_the_own_script(
    call: Call, store: db.Store, s3_client: FakeS3, dash: str
) -> None:
    story = _made_own(store, s3_client, [dash])
    cues = [
        {"id": "w_s1", "at": 0.25, "dur": 2.5, "text": "Whoops"},
        {"id": "w_s2", "at": 3.25, "dur": 2, "text": "Go go go"},
        {"id": "extra", "at": 5, "dur": 0.5, "text": "Mine too"},
    ]
    status, body = _patch(call, story, captions=cues)
    assert status == 200
    out = body["story"]
    assert [s["caption"] for s in out["ownScript"]["scenes"]] == ["Whoops", "Go go go"]
    assert out["stale"] == CAPTION_STEPS
    assert [c["text"] for c in body["script"]["captions"]] == ["Whoops", "Go go go", "Mine too"]
    status, body = _patch(call, out, captions=[cues[2]])
    assert status == 200
    assert [s["caption"] for s in body["story"]["ownScript"]["scenes"]] == [None, None]
    # An old story's caption edit is as before: there is no script of the owner's to mirror into.
    old = seed_story(store, s3_client)
    status, body = _patch(call, old, captions=[{"id": "cap1", "at": 0.5, "dur": 2, "text": "Steer"}])
    assert status == 200
    assert "ownScript" not in body["story"]
    assert "ownScript" not in _stored(store, old["storyId"])


def test_asking_for_changes_with_a_note_is_409_and_remake_this_scene_works(
    call: Call, store: db.Store, s3_client: FakeS3, dash: str
) -> None:
    story = _made_own(store, s3_client, [dash])
    url = f"{BASE}/stories/{story['storyId']}/changes"
    status, body = call("POST", url, {"note": "Make it funnier"})
    assert (status, body["error"]["message"]) == (409, "This video follows your script. Tap Change my script.")
    status, body = call("POST", url, {"note": "Again", "sceneIds": ["s2"]})
    assert status == 409
    assert _stored(store, story["storyId"])["status"] == "review"
    status, body = call("POST", url, {"sceneIds": ["s2"]})
    assert status == 202
    job = body["job"]
    assert (job["jobType"], job["configuration"]["sceneIds"], job["configuration"]["note"]) == ("changes", ["s2"], None)
    assert job["steps"][0]["label"] == "Your script"


# --- drift ------------------------------------------------------------------------------------------------------


def test_sets_match_the_engine_catalog() -> None:
    text = (ENGINE / "catalog.ts").read_text()
    m = re.search(r"\n  sets: \[(.*?)\n  \],", text, re.S)
    assert m
    assert list(catalog.SETS) == re.findall(r'id: "([^"]+)"', m.group(1))
    assert len(catalog.SETS) == 16
