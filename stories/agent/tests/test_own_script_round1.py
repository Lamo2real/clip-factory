"""Write it myself, round 1 of the re-review (24 Nov): the reviewers' attacks on PR #201 at 114c58bf, ported as they
were written (/tmp/own-attack-r1, tests/test_attacks_r1*.py). Each asserts what a faithful check does: an event the
words only mention is never forced, who does what (each of "Lamo and Rosa", "sees Lamo fall", "Rosa trips Lamo",
"her car"), a character's own he or she, feelings (the one who hugs, "who is crying", "not happy", more feeling
words), order ("before"), counts ("again", exact counts, "three times" anywhere in the clause), hidden and look-alike
letters, a car's tricks, the fact check's staging fix, a remake after the words changed, and the web's Who."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import own_script, own_words
from test_own_script import LAMO, PLACES, ROSA, beat, own_story, own_world, piece, saved, scene
from test_stories_pipeline import answers, character, run_job

CAST = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Rosa"}}
CASTMAP = {"ch1": "c1", "ch2": "c2"}
PLACES = {**PLACES, "living_room": "Living room", "city_street": "City street", "icy_road": "Icy road"}
G = {"c1": "he", "c2": "she"}  # what the characters' own descriptions say (StoryJob._own_genders)


def sc(sid: str, what: str, caption: str | None = None, who: tuple[str, ...] = (), place: str | None = None,
       leave: tuple[str, ...] = (), known: tuple[str, ...] = ()) -> dict[str, Any]:  # fmt: skip
    return {"sceneId": sid, "what": what, "caption": caption, "who": list(who), "place": place,
            "leaveOut": list(leave), "known": list(known)}  # fmt: skip


TAIL_OWN = sc("s2", "Lamo waves.")


def tail() -> dict[str, Any]:
    return scene("s2", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO])


def check(own_scenes: list[dict[str, Any]], answer_scenes: list[dict[str, Any]], *, cast: Any = None,
          cars: Any = None, castmap: Any = None, asked: Any = None,
          genders: Any = None) -> tuple[list[own_script.Problem], dict[str, Any]]:  # fmt: skip
    answer = {"teachesSafety": False, "safetyTopicId": None, "scenes": answer_scenes}
    own = own_script.scenes_of(own_scenes)
    script = own_script.script_from_own(
        answer, own, title="T", engine_version=6, seed=1, cast=cast or CAST, captions_on=True, music=None,
        topic=None, cars=cars, genders=genders,
    )  # fmt: skip
    problems = own_script.own_problems(answer, script, own, castmap or CASTMAP, places=PLACES, asked=asked,
                                       genders=genders)  # fmt: skip
    return problems, script


def keys_of(problems: list[own_script.Problem]) -> list[str]:
    return [p.key for p in problems]


def why(problems: list[own_script.Problem]) -> list[str]:
    return [p.for_model for p in problems]


def note_of(script: dict[str, Any], sid: str = "s1") -> str:
    return next(s["note"] for s in script["scenes"] if s["sceneId"] == sid) or ""


def walk(at: float = 0.3, who: str = "c1") -> dict[str, Any]:
    return beat(at, 2.0, who, "walk", to={"x": 0.6, "y": 0.72})


# --- cars ------------------------------------------------------------------------------------------------------------

ROSSO = {"c3": {"characterId": "ch3", "name": "Rosso"}}
CAR_MAP = {"ch1": "c1", "ch2": "c2", "ch3": "c3"}


def car(pid: str = "car1", cast_id: str = "c3", x: float = 0.5, state: str = "driving") -> dict[str, Any]:
    return {"propId": pid, "kind": "car", "castId": cast_id, "x": x, "y": 0.76, "scale": 1, "rot": 0, "state": state}


DRIVER = {**LAMO, "inCar": "car1"}


def one_car(own: list[dict[str, Any]], a: list[dict[str, Any]]) -> tuple[list[own_script.Problem], dict[str, Any]]:
    return check(own, a, cars=ROSSO, castmap=CAR_MAP, genders=G)


# === A. synonyms and events implied by verbs =========================================================================


def test_a1_stumbles_drawn_as_a_plain_walk() -> None:
    own = [sc("s1", "Lamo stumbles over a rock."), TAIL_OWN]
    a = [scene("s1", "park", [walk()], [piece("Lamo stumbles over a rock.", (0,))], [LAMO]), tail()]
    problems, script = check(own, a, genders=G)
    print("A1", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "a stumble drawn as a plain walk, no problem, no note"


@pytest.mark.parametrize("what", ["Rosso slams into the wall.", "Rosso rams the fence.", "Rosso ploughs into the hedge.",
                                  "Rosso smacks into a tree.", "Rosso rear-ends the bus."])  # fmt: skip
def test_a2_a_crash_said_with_another_verb_drawn_as_a_stop(what: str) -> None:
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 4, "c1", "drive"), beat(0, 2, "car1", "move"), beat(2, 1, "car1", "stop")],
               [piece(what, (0, 1, 2))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("A2", what, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"{what!r}: the crash is gone (move, stop), no problem, no note"


def test_holds_a2_crashes_into_is_owed() -> None:
    what = "Rosso crashes into the wall."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 4, "c1", "drive"), beat(0, 2, "car1", "move"), beat(2, 1, "car1", "stop")],
               [piece(what, (0, 1, 2))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    assert one_car(own, a)[0]


@pytest.mark.parametrize("what", ["Lamo slams on the brakes.", "Rosso stops at the red light.",
                                  "Rosso screeches to a halt."])  # fmt: skip
def test_a3_braking_or_stopping_drawn_as_driving_on(what: str) -> None:
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")],
               [piece(what, (0, 1))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("A3", what, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"{what!r} drawn as Rosso driving straight on: no problem, no note"


def test_a4_gets_out_of_the_car_drawn_as_getting_in() -> None:
    what = "Lamo gets out of the car."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0.3, 1.5, "c1", "get_in")], [piece(what, (0,))],
               [{**LAMO, "x": 0.4}], props=[car(state="parked")]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("A4", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "getting out drawn as getting in: no problem, no note"


def test_a5_a_tyre_that_bursts_with_no_name_before_it_is_never_owed() -> None:
    own = [sc("s1", "Lamo drives Rosso home. Suddenly a tyre bursts.", who=("ch1", "ch3"), place="city_street"),
           TAIL_OWN]  # fmt: skip
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 3, "car1", "move"), beat(3, 1, "car1", "stop")],
               [piece("Lamo drives Rosso home.", (0, 1)), piece("Suddenly a tyre bursts.", (2,))], [DRIVER],
               props=[car()]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("A5", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "the tyre burst is gone (Rosso just stops): no problem, no note"


# === B. who does what ================================================================================================


def test_b1_everyone_dances_drawn_as_two_smiles() -> None:
    own = [sc("s1", "Everyone dances.", who=("ch1", "ch2")), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "idle", face="happy"), beat(0.3, 2, "c2", "idle", face="happy")],
               [piece("Everyone dances.", (0, 1))], [LAMO, ROSA]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("B1", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "'Everyone dances.' with nobody dancing: no problem, no note"


@pytest.mark.parametrize("what,beats", [
    ("Lamo and Rosa both fall over.", [beat(0.3, 1.2, "c1", "fall"), beat(0.3, 1.2, "c2", "wave")]),
    ("Lamo dances with Rosa.", [beat(0.3, 2, "c1", "dance"), beat(0.3, 2, "c2", "idle")]),
    ("Rosa trips Lamo.", [beat(0.3, 1.2, "c2", "fall"), beat(0.3, 1.2, "c1", "idle")]),
])  # fmt: skip
def test_b2_a_shared_or_done_to_event_drawn_by_only_one_or_the_wrong_one(what: str, beats: list[Any]) -> None:
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", beats, [piece(what, (0, 1))], [LAMO, ROSA]), tail()]
    problems, script = check(own, a, genders=G)
    print("B2", what, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"{what!r} drawn as {[(b['who'], b['do']) for b in beats]}: silent"


def test_b3_rosa_sees_lamo_fall_and_laughs_drawn_the_other_way_round() -> None:
    what = "Rosa sees Lamo fall and laughs."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.2, "c2", "fall"), beat(0.3, 1.2, "c1", "idle"),
                              beat(1.8, 1.5, "c1", "celebrate", face="laughing", noise="laugh")],
               [piece("Rosa sees Lamo fall", (0, 1)), piece("and laughs.", (2,))], [LAMO, ROSA]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("B3", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Rosa falls and Lamo laughs, where Lamo falls and Rosa laughs: silent"


def _two_drivers() -> tuple[dict[str, Any], dict[str, Any], dict[str, str], list[dict[str, Any]], list[dict[str, Any]]]:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Max"}}
    cars = {"c3": {"characterId": "ch3", "name": "Rosso"}, "c4": {"characterId": "ch4", "name": "Bolt"}}
    castmap = {"ch1": "c1", "ch2": "c2", "ch3": "c3", "ch4": "c4"}
    actors = [{**LAMO, "inCar": "car1"}, {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left", "inCar": "car2"}]
    props = [car("car1", "c3", 0.3), car("car2", "c4", 0.7)]
    return cast, cars, castmap, actors, props


def test_b4_maxs_car_skids_drawn_as_lamos_car_skidding() -> None:
    cast, cars, castmap, actors, props = _two_drivers()
    what = "Lamo and Max race. Max's car skids on the ice."
    own = [sc("s1", what, who=("ch1", "ch2", "ch3", "ch4"), place="icy_road"), TAIL_OWN]
    a = [scene("s1", "icy_road", [beat(0, 2, "car1", "move"), beat(0, 2, "car2", "move"), beat(2.2, 0.5, "c2", "idle"),
                                  beat(2.5, 1.5, "car1", "skid", sfx="skid")],
               [piece("Lamo and Max race.", (0, 1)), piece("Max's car", (2,)), piece("skids on the ice.", (3,))],
               actors, props=props), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, cars=cars, castmap=castmap, genders={"c1": "he", "c2": "he"})
    print("B4", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Lamo's Rosso skids where the owner wrote Max's car: silent"


def test_b5_her_car_honks_drawn_as_his_car_honking() -> None:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Rosa"}}
    cars = {"c3": {"characterId": "ch3", "name": "Rosso"}, "c4": {"characterId": "ch4", "name": "Bolt"}}
    castmap = {"ch1": "c1", "ch2": "c2", "ch3": "c3", "ch4": "c4"}
    actors = [{**LAMO, "inCar": "car1"}, {**ROSA, "inCar": "car2"}]
    props = [car("car1", "c3", 0.3), car("car2", "c4", 0.7)]
    what = "Lamo waves at Rosa. Then her car honks."
    own = [sc("s1", what, who=("ch1", "ch2", "ch3", "ch4"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0.3, 1.5, "c1", "wave"), beat(0.3, 1.5, "c2", "idle"),
                                     beat(2.2, 1.0, "car1", "honk", sfx="honk")],
               [piece("Lamo waves at Rosa.", (0, 1)), piece("Then her car honks.", (2,))], actors,
               props=props), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, cars=cars, castmap=castmap, genders=G)
    print("B5", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Lamo's car honks where the owner wrote her (Rosa's) car: silent"


def test_b6_he_two_sentences_back_is_lost_and_rosa_falls_instead() -> None:
    what = "Lamo waves. Rosa smiles. He trips and falls."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "wave"), beat(1.4, 1.0, "c2", "idle", face="happy"),
                              beat(2.6, 1.2, "c2", "fall")],
               [piece("Lamo waves.", (0,)), piece("Rosa smiles.", (1,)), piece("He trips and falls.", (2,))],
               [LAMO, ROSA]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("B6", why(problems), "| note:", note_of(script))
    assert problems or "Rosa" in note_of(script), "'He trips' (Lamo, a boy) drawn as Rosa falling: silent"


def test_holds_b7_two_boys_one_he_is_told_in_the_note() -> None:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Max"}}
    max_ = {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left"}
    what = "Lamo pushes Max and he falls."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "gesture"), beat(0.3, 1.0, "c2", "idle"),
                              beat(1.5, 1.2, "c1", "fall")],
               [piece(what, (0, 1, 2))], [LAMO, max_]), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, genders={"c1": "he", "c2": "he"})
    print("B7", why(problems), "| note:", note_of(script))
    assert problems or "Lamo" in note_of(script)


def test_b8_a_cast_member_called_will() -> None:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Will"}}
    will = {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left"}
    what = "Lamo will fall over."
    own = [sc("s1", what, who=("ch1", "ch2")), TAIL_OWN]  # the web ticks Will too (names are read in any case)
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "idle"), beat(0.3, 1.2, "c2", "fall")],
               [piece(what, (0, 1))], [LAMO, will]), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, castmap=CASTMAP, genders={"c1": "he", "c2": "he"})
    print("B8", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Will falls where Lamo will fall: silent"


# === C. events the words name but do not say happen (the check FORCES them) ==========================================


@pytest.mark.parametrize("what,beats", [
    ("Lamo is afraid of falling.", [beat(0.3, 2, "c1", "cower", face="scared")]),
    ("Lamo wants to jump, but he is too scared.", [beat(0.3, 2, "c1", "cower", face="scared")]),
    ("Lamo tries to jump but can't.", [beat(0.3, 2, "c1", "shake_head", face="sad")]),
    ("Lamo is scared he might fall off the wall.", [beat(0.3, 2, "c1", "idle", face="scared")]),
    ("If Lamo falls, Rosa will catch him.", [beat(0.3, 2, "c1", "walk", to={"x": 0.5, "y": 0.72}),
                                            beat(0.3, 2, "c2", "idle", face="determined")]),
    ("Lamo hopes Rosa will dance with him.", [beat(0.3, 2, "c1", "think", face="happy"), beat(0.3, 2, "c2", "idle")]),
    ("Lamo fell off his bike yesterday, so today he walks.", [beat(0.3, 2, "c1", "walk", to={"x": 0.6, "y": 0.72})]),
])  # fmt: skip
def test_c1_the_check_forces_an_event_the_words_do_not_say_happens(what: str, beats: list[Any]) -> None:
    own = [sc("s1", what), TAIL_OWN]
    actors = [LAMO, ROSA] if any(b["who"] == "c2" for b in beats) else [LAMO]
    a = [scene("s1", "park", beats, [piece(what, tuple(range(len(beats))))], actors), tail()]
    problems, _ = check(own, a, genders=G)
    print("C1", what, why(problems))
    assert not problems, f"the faithful staging of {what!r} is refused: the retry is told to draw the event"


@pytest.mark.parametrize("what", ["Lamo drives slowly in case Rosso skids on the ice.", "Lamo forgets to honk.",
                                  "Rosa tells Lamo to slow down or he will crash."])  # fmt: skip
def test_c2_a_car_event_the_words_warn_of_is_forced(what: str) -> None:
    own = [sc("s1", what, who=("ch1", "ch3") + (("ch2",) if "Rosa" in what else ()), place="icy_road"), TAIL_OWN]
    actors = [DRIVER] + ([{**ROSA, "inCar": "car1"}] if "Rosa" in what else [])
    beats = [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")]
    if "Rosa" in what:
        beats.append(beat(0.5, 1.5, "c2", "point", face="worried"))
    a = [scene("s1", "icy_road", beats, [piece(what, tuple(range(len(beats))))], actors, props=[car()]), tail()]
    problems, _ = one_car(own, a)
    print("C2", what, why(problems))
    assert not problems, f"the faithful staging of {what!r} is refused: the retry is told to draw the crash/skid/honk"


def test_c3_a_shout_in_quotes_makes_the_shouter_jump() -> None:
    what = 'Rosa shouts "Jump!" and Lamo jumps.'
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.2, "c2", "point", face="determined"), beat(1.6, 1.0, "c1", "jump")],
               [piece('Rosa shouts "Jump!"', (0,)), piece("and Lamo jumps.", (1,))], [LAMO, ROSA]), tail()]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    print("C3", why(problems))
    assert not problems, "the faithful staging is refused: Rosa is told to jump because she shouted 'Jump!'"


@pytest.mark.parametrize("what", ["Lamo's tower of blocks topples over.", "Lamo's ice cream falls on the floor."])
def test_c4_a_things_fall_is_owed_by_its_owner(what: str) -> None:
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "kitchen", [beat(0.3, 1.5, "c1", "gasp", face="sad", noise="gasp")], [piece(what, (0,))],
               [LAMO]), tail()]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    print("C4", what, why(problems))
    assert not problems, f"{what!r}: Lamo himself is told to fall"


# === D. feelings =====================================================================================================


def test_d1_not_happy_drawn_laughing() -> None:
    own = [sc("s1", "Lamo is not happy."), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "celebrate", face="laughing", noise="laugh")],
               [piece("Lamo is not happy.", (0,))], [LAMO]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("D1", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "'not happy' drawn as a laughing celebration: silent"


@pytest.mark.parametrize("what", ["Lamo weeps.", "Lamo sighs.", "Lamo frowns.", "Lamo is cross.", "Lamo is gloomy.",
                                  "Lamo is heartbroken.", "Lamo whimpers."])  # fmt: skip
def test_d2_a_sad_word_the_reader_does_not_know_drawn_laughing(what: str) -> None:
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "celebrate", face="laughing", noise="laugh")], [piece(what, (0,))],
               [LAMO]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("D2", what, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"{what!r} drawn as a laughing celebration: silent"


@pytest.mark.parametrize("what", ["Lamo beams.", "Lamo chuckles.", "Lamo is overjoyed.", "Lamo is cheerful."])
def test_d3_a_happy_word_the_reader_does_not_know_drawn_crying(what: str) -> None:
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "cower", face="sad", noise="sigh")], [piece(what, (0,))], [LAMO]),
         tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("D3", what, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"{what!r} drawn sad: silent"


def test_d4_a_crying_lamo_with_a_laughing_beat_beside_his_sad_one() -> None:
    own = [sc("s1", "Lamo cries."), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "idle", face="sad"),
                              beat(1.5, 2.0, "c1", "idle", face="laughing", noise="laugh")],
               [piece("Lamo cries.", (0, 1))], [LAMO]), tail()]  # fmt: skip
    problems, script = check(own, a, genders=G)
    print("D4", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "a crying Lamo laughs for two seconds (one sad beat covers it): silent"


def test_d5_rosa_hugs_lamo_who_is_crying() -> None:
    what = "Rosa hugs Lamo, who is crying."
    own = [sc("s1", what), TAIL_OWN]
    faithful = [scene("s1", "park", [beat(0.3, 2, "c2", "idle", face="happy"), beat(0.3, 2, "c1", "idle", face="sad")],
                      [piece(what, (0, 1))], [LAMO, ROSA]), tail()]  # fmt: skip
    p1, _ = check(own, faithful, genders=G)
    flipped = copy.deepcopy(faithful)
    flipped[0]["beats"][0]["face"], flipped[0]["beats"][1]["face"] = "sad", "laughing"
    p2, _ = check(own, flipped, genders=G)
    print("D5 faithful:", why(p1), "| flipped:", why(p2))
    assert not p1, "the faithful staging (kind Rosa, crying Lamo) is refused: the retry is told to flip the feelings"


# === E. order and counts =============================================================================================


def test_e1_jumps_before_he_falls_drawn_fall_first() -> None:
    what = "Lamo jumps before he falls."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.2, 1.2, "c1", "fall"), beat(2.0, 1.0, "c1", "jump")],
               [piece(what, (0, 1))], [LAMO]), tail()]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    print("E1", why(problems))
    assert "OWN_ORDER" in keys_of(problems), "'jumps before he falls' drawn fall then jump: no order problem"


@pytest.mark.parametrize("what,beats", [
    ("Lamo jumps, then falls, then jumps again.", [beat(0.2, 1, "c1", "jump"), beat(1.5, 1.2, "c1", "fall")]),
    ("Lamo falls, gets up and falls again.", [beat(0.2, 1.2, "c1", "fall"), beat(1.6, 1.0, "c1", "get_up")]),
    ("Lamo dances. Rosa claps. Then Lamo dances again.", [beat(0.2, 1.5, "c1", "dance"),
                                                         beat(1.8, 1.0, "c2", "celebrate")]),
])  # fmt: skip
def test_e2_an_event_said_again_is_owed_once(what: str, beats: list[Any]) -> None:
    own = [sc("s1", what), TAIL_OWN]
    actors = [LAMO, ROSA] if any(b["who"] == "c2" for b in beats) else [LAMO]
    a = [scene("s1", "park", beats, [piece(what, tuple(range(len(beats))))], actors), tail()]
    problems, _ = check(own, a, genders=G)
    print("E2", what, why(problems))
    assert problems, f"{what!r}: the second one is never drawn, no problem"


@pytest.mark.parametrize("what", ["Lamo jumps up and down three times.", "Lamo jumps on the big bed three times.",
                                  "Three times, Lamo jumps.", "Lamo jumps a few times."])  # fmt: skip
def test_e3_a_count_the_reader_does_not_see(what: str) -> None:
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "jump")], [piece(what, (0,))], [LAMO]), tail()]
    problems, _ = check(own, a, genders=G)
    print("E3", what, why(problems))
    assert problems, f"{what!r} drawn as one jump: no problem"


@pytest.mark.parametrize("what,n", [("Lamo jumps twice.", 5), ("Lamo jumps once.", 3), ("Lamo falls once.", 4)])
def test_e4_more_times_than_the_words_say(what: str, n: int) -> None:
    own = [sc("s1", what), TAIL_OWN]
    do = "fall" if "falls" in what else "jump"
    beats = [beat(0.2 + i * 0.9, 0.8, "c1", do) for i in range(n)]
    a = [scene("s1", "park", beats, [piece(what, tuple(range(n)))], [LAMO]), tail()]
    problems, _ = check(own, a, genders=G)
    print("E4", what, n, why(problems))
    assert problems, f"{what!r} drawn {n} times: no problem"


def test_e5_ten_jumps_drawn_as_five() -> None:
    what = "Lamo jumps ten times."
    own = [sc("s1", what), TAIL_OWN]
    beats = [beat(0.2 + i * 0.9, 0.8, "c1", "jump") for i in range(5)]
    a = [scene("s1", "park", beats, [piece(what, tuple(range(5)))], [LAMO], dur=6), tail()]
    problems, script = check(own, a, genders=G)
    print("E5", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "'ten times' drawn as five jumps: silent (MAX_COUNT = 5)"


# === F. hidden characters beyond the format characters ===============================================================


@pytest.mark.parametrize("hidden", ["\u034f", "\ufe0f", "\u3164", "CYR"])
def test_f1_an_invisible_mark_or_a_lookalike_inside_the_owners_falls(hidden: str) -> None:
    what = "Lamo fa" + hidden + "lls over." if hidden != "CYR" else "Lamo f\u0430lls over."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [walk()], [piece(what, (0,))], [LAMO]), tail()]
    problems, script = check(own, a, genders=G)
    print("F1", repr(what), own_words.tokens(what), why(problems))
    assert problems or note_of(script), f"{what!r} shows as 'Lamo falls over.', drawn as a walk: silent"


# === G. the series memory: an action the check does not count as an event ===========================================


@pytest.mark.parametrize("do", ["vanish", "appear", "blink", "bounce", "flash"])
def test_g1_a_running_joke_drawn_with_a_prop_action_that_is_no_event(do: str) -> None:
    what = "Lamo drives Rosso home."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 2.5, "car1", "move"),
                                     beat(2.6, 1.5, "car1", do)],
               [piece(what, (0, 1, 2))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("G1", do, why(problems), "| note:", note_of(script))
    assert problems or note_of(script), f"Rosso does {do} under 'Lamo drives Rosso home.': silent"


# === H. Check the facts: the staging fix and the owner's own events ==================================================


def _fact_fix(own: list[dict[str, Any]], first: list[dict[str, Any]], fixed: dict[str, Any], ref_index: str
              ) -> tuple[bool, list[own_script.Problem], list[own_script.Problem], dict[str, Any]]:  # fmt: skip
    p0, script = one_car(own, first)
    assert p0 == [], why(p0)
    owners = own_script.owners_beat(script, "s1", ref_index, own[0]["what"])
    own_s = own_script.scenes_of(own)
    merged, _ = own_script.merged_take(script, fixed, own_s, ["s1"], genders=G)
    out = own_script.own_problems(fixed, merged, own_s, CAR_MAP, places=PLACES, asked=["s1"], genders=G)
    kept = own_script.kept_problems(script, merged, own_s, ["s1"])
    return owners, out, kept, merged


def test_h1_the_fact_checks_fix_takes_the_owners_phone_away() -> None:
    what = "Lamo looks at his phone while he drives."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    phone = {"propId": "ph1", "kind": "phone", "x": 0.45, "y": 0.6, "scale": 1, "rot": 0}
    first = [scene("s1", "city_street", [beat(0, 5, "c1", "drive", face="happy"), beat(0, 5, "car1", "move")],
                   [piece(what, (0, 1), props=["ph1"])], [DRIVER], props=[car(), phone]), tail()]  # fmt: skip
    # the checker: "beat:s1:0: Lamo uses a phone while driving: not safe" -> a new take "without changing what happens"
    fixed = {"scenes": [scene("s1", "city_street", [beat(0, 5, "c1", "drive", face="determined"),
                                                    beat(0, 5, "car1", "move")],
                              [piece(what, (0, 1))], [DRIVER], props=[car()])]}  # fmt: skip
    owners, out, kept, merged = _fact_fix(own, first, fixed, "0")
    print("H1 owners_beat:", owners, "| own_problems:", why(out), "| kept:", why(kept), "| note:", note_of(merged))
    assert owners or out or kept or note_of(merged), "the owner's phone is gone; the step says 'Scenes set up again'"


def test_h2_the_fact_checks_fix_makes_a_car_that_does_not_stop_stop() -> None:
    what = "Rosso doesn't stop at the stop sign."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    sign = {"propId": "sg1", "kind": "stop_sign", "x": 0.8, "y": 0.7, "scale": 1, "rot": 0}
    first = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")],
                   [piece(what, (0, 1))], [DRIVER], props=[car(), sign]), tail()]  # fmt: skip
    fixed = {"scenes": [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 2.5, "car1", "move"),
                                                    beat(2.5, 1.5, "car1", "stop")],
                              [piece(what, (0, 1, 2))], [DRIVER], props=[car(), sign])]}  # fmt: skip
    owners, out, kept, merged = _fact_fix(own, first, fixed, "1")
    print("H2 owners_beat:", owners, "| own_problems:", why(out), "| kept:", why(kept), "| note:", note_of(merged))
    assert owners or out or kept or note_of(merged), "'doesn't stop' becomes a stop after the fact check's fix"


# === I. a remake, and the limits =====================================================================================


def test_i1_remake_of_s1_after_s2s_words_changed_past_its_label() -> None:
    long_v1 = "Lamo walks to the park with Rosa and Max, and then Lamo dances."
    long_v2 = "Lamo walks to the park with Rosa and Max, and then Lamo falls."
    assert own_script.label(long_v1) == own_script.label(long_v2)
    v1 = [sc("s1", "Lamo waves."), sc("s2", long_v1, known=("Max",))]
    a = [scene("s1", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO]),
         scene("s2", "park", [walk(), beat(2.5, 1.5, "c1", "dance")],
               [piece("Lamo walks to the park with Rosa and Max,", (0,), place=True, closest="walking alone"),
                piece("and then Lamo dances.", (1,))], [LAMO])]  # fmt: skip
    p, script = check(v1, a, genders=G)
    v2 = copy.deepcopy(v1)
    v2[1]["what"] = long_v2
    own2 = own_script.scenes_of(v2)
    remake = {"scenes": [scene("s1", "park", [beat(0.4, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO])]}
    merged, _ = own_script.merged_take(script, remake, own2, ["s1"], genders=G)
    out = own_script.own_problems(remake, merged, own2, CASTMAP, places=PLACES, asked=["s1"], genders=G)
    print("I1 v1:", why(p), "| remake s1 against v2:", why(out))
    # guarded in the pipeline only by the API marking the storyboard stale on any what change (_staged_as_now)
    assert out, "s2 still dances where v2 says falls; the remake's own check never looks (guarded only by 'stale')"


def test_holds_i2_a_160_letter_scene_with_its_event_at_the_end() -> None:
    what = ("Lamo walks to the shop with Rosa, buys some milk and bread, says hello to the man, walks all the way back "
            "home, opens the door, and then he trips and falls.")  # fmt: skip
    assert len(what) <= own_script.MAX_WHAT
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [walk(), beat(0.3, 2, "c2", "walk", to={"x": 0.8, "y": 0.72}),
                              beat(2.4, 1.0, "c1", "gesture", face="happy"), beat(3.4, 1, "c1", "walk")],
               [piece(what, (0, 1, 2, 3))], [LAMO, ROSA], dur=6), tail()]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    print("I2", why(problems))
    assert problems


# === round 1, part 2: corrected setups and end to end ============================================================


def test_b4_fixed_maxs_car_skids_drawn_as_lamos_car_skidding() -> None:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Max"}}
    cars = {"c3": {"characterId": "ch3", "name": "Rosso"}, "c4": {"characterId": "ch4", "name": "Bolt"}}
    castmap = {"ch1": "c1", "ch2": "c2", "ch3": "c3", "ch4": "c4"}
    actors = [{**LAMO, "inCar": "car1"}, {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left", "inCar": "car2"}]
    props = [car("car1", "c3", 0.3), car("car2", "c4", 0.7)]
    what = "Lamo and Max race. Max's car skids on the ice."
    own = [sc("s1", what, who=("ch1", "ch2", "ch3", "ch4"), place="icy_road"), TAIL_OWN]
    a = [scene("s1", "icy_road", [beat(0, 5, "c1", "drive"), beat(0, 5, "c2", "drive"), beat(0, 2, "car1", "move"),
                                  beat(0, 2, "car2", "move"), beat(2.2, 0.5, "c2", "idle", face="worried"),
                                  beat(2.5, 1.5, "car1", "skid", sfx="skid")],
               [piece("Lamo and Max race.", (0, 1, 2, 3)), piece("Max's car", (4,)), piece("skids on the ice.", (5,))],
               actors, props=props), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, cars=cars, castmap=castmap, genders={"c1": "he", "c2": "he"})
    print("B4", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Lamo's Rosso skids where the owner wrote Max's car (pieces split): silent"


def test_b6b_given_genders_are_unlearnt_and_the_faithful_he_is_refused() -> None:
    what = "Lamo waves. Rosa smiles. He trips and falls."
    own = [sc("s1", what), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 1.0, "c1", "wave"), beat(1.4, 1.0, "c2", "idle", face="happy"),
                              beat(2.6, 1.2, "c1", "fall")],
               [piece("Lamo waves.", (0,)), piece("Rosa smiles.", (1,)), piece("He trips and falls.", (2,))],
               [LAMO, ROSA]), tail()]  # fmt: skip
    problems, _ = check(own, a, genders=G)  # Lamo a boy, Rosa a girl (their own descriptions)
    print("B6b", why(problems))
    assert not problems, "Lamo (the only boy) falling for 'He trips' is refused; the retry is told Rosa falls"


def test_d5c_the_staging_the_retry_asks_for_drops_lamos_tears() -> None:
    what = "Rosa hugs Lamo, who is crying."
    own = [sc("s1", what), TAIL_OWN]
    complied = [scene("s1", "park", [beat(0.3, 2, "c2", "idle", face="thinking"), beat(0.3, 2, "c1", "idle",
                                                                                      face="happy")],
                      [piece(what, (0, 1))], [LAMO, ROSA]), tail()]  # fmt: skip
    problems, script = check(own, complied, genders=G)
    print("D5c", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "Lamo, who is crying, drawn happy (what the retry asked for): silent"


def test_h2b_a_first_take_stops_a_car_the_words_say_does_not_stop() -> None:
    what = "Rosso doesn't stop at the stop sign."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    sign = {"propId": "sg1", "kind": "stop_sign", "x": 0.8, "y": 0.7, "scale": 1, "rot": 0}
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 2.5, "car1", "move"),
                                     beat(2.5, 1.5, "car1", "stop")],
               [piece(what, (0, 1, 2))], [DRIVER], props=[car(), sign]), tail()]  # fmt: skip
    problems, script = one_car(own, a)
    print("H2b", why(problems), "| note:", note_of(script))
    assert problems or note_of(script), "'doesn't stop' drawn as a stop (no brake sound, no brake lights): silent"


def test_i1_fixed_remake_of_s1_after_s2s_words_changed_past_its_label() -> None:
    v1w = "Lamo walks to the park and looks at the ducks, then he dances."
    v2w = "Lamo walks to the park and looks at the ducks, then he falls."
    assert own_script.label(v1w) == own_script.label(v2w)
    v1 = [sc("s1", "Lamo waves."), sc("s2", v1w)]
    a = [scene("s1", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO]),
         scene("s2", "park", [beat(0.3, 2, "c1", "walk", to={"x": 0.6, "y": 0.72}),
                              beat(2.4, 1.0, "c1", "look_left", face="happy"), beat(3.5, 1.5, "c1", "dance")],
               [piece("Lamo walks to the park and looks at the ducks,", (0, 1), place=True),
                piece("then he dances.", (2,))], [LAMO])]  # fmt: skip
    p, script = check(v1, a, genders=G)
    assert p == [], why(p)
    v2 = copy.deepcopy(v1)
    v2[1]["what"] = v2w
    own2 = own_script.scenes_of(v2)
    remake = {"scenes": [scene("s1", "park", [beat(0.4, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO])]}
    merged, _ = own_script.merged_take(script, remake, own2, ["s1"], genders=G)
    out = own_script.own_problems(remake, merged, own2, {"ch1": "c1", "ch2": "c2"}, places=PLACES, asked=["s1"],
                                  genders=G)  # fmt: skip
    print("I1 remake of s1 against v2 (s2 still dances):", why(out))
    assert out, "guarded only by the API's storyboard-stale mark (_staged_as_now): the check itself never looks"


# --- end to end: the check's retry instruction makes the silent change -----------------------------------------------


def _e2e(tmp_path: Path, what: str, first: list[dict[str, Any]], second: list[dict[str, Any]],
         chars: dict[str, str] | None = None) -> tuple[str, list[str], dict[str, Any], list[str]]:  # fmt: skip
    scenes = [
        {"sceneId": "s1", "what": what, "caption": None, "who": [], "place": "park", "leaveOut": []},
        {"sceneId": "s2", "what": "Lamo waves.", "caption": None, "who": [], "place": "park", "leaveOut": []},
    ]

    def staging(
        beats: list[dict[str, Any]], shows: list[dict[str, Any]], actors: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return {"teachesSafety": False, "safetyTopicId": None, "scenes": [
            scene("s1", "park", beats, shows, actors),
            scene("s2", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO]),
        ]}  # fmt: skip

    replies = answers(animation_plan=[staging(*first), staging(*second)], storyboard=AssertionError("never"))
    ids = ["ch1", "ch2"] if any(a["castId"] == "c2" for a in first[2]) else ["ch1"]
    svc, store, table, models = own_world(tmp_path, story=own_story(scenes, characterIds=ids), replies=replies)
    if chars:
        table.seed({**character("ch1"), "name": "Lamo", "description": chars["ch1"]})
        if "ch2" in chars:
            table.seed({**character("ch2"), "name": "Rosa", "description": chars["ch2"], "personality": "Kind."})
    status = run_job(svc)
    tasks = models.tasks()
    retry: list[str] = []
    if len(models.calls) > 1:
        retry = json.loads(models.calls[1]["messages"][0]["content"][1]["text"].split("\n", 1)[1]).get("problems") or []
    script: dict[str, Any] = {}
    if status == "ready":
        _story, script = saved(store, table)
    return status, tasks, script, retry


def test_e2e_c1_afraid_of_falling_the_retry_makes_lamo_fall_and_the_video_is_ready_with_no_note(tmp_path: Path) -> None:
    what = "Lamo is afraid of falling."
    faithful = ([beat(0.3, 2, "c1", "cower", face="shocked")], [piece(what, (0,))], [LAMO])
    told = ([beat(0.3, 1.2, "c1", "fall", face="shocked")], [piece(what, (0,))], [LAMO])
    status, tasks, script, retry = _e2e(tmp_path, what, faithful, told)
    s1 = script["scenes"][0] if script else {}
    print(
        "E2E-C1",
        status,
        tasks,
        "| retry:",
        retry,
        "| saved s1:",
        [b["do"] for b in s1.get("beats", [])],
        "| note:",
        s1.get("note"),
    )
    assert not (status == "ready" and any(b["do"] == "fall" for b in s1["beats"]) and not s1.get("note")), (
        "the owner wrote Lamo is AFRAID of falling; the video shows him falling, no note"
    )


def test_e2e_b6_he_trips_the_retry_makes_rosa_fall_and_the_video_is_ready_with_no_note(tmp_path: Path) -> None:
    what = "Lamo waves. Rosa smiles. He trips and falls."
    shows = [piece("Lamo waves.", (0,)), piece("Rosa smiles.", (1,)), piece("He trips and falls.", (2,))]
    faithful = ([beat(0.3, 1.0, "c1", "wave"), beat(1.4, 1.0, "c2", "idle", face="happy"), beat(2.6, 1.2, "c1", "fall")],
                shows, [LAMO, ROSA])  # fmt: skip
    told = ([beat(0.3, 1.0, "c1", "wave"), beat(1.4, 1.0, "c2", "idle", face="happy"), beat(2.6, 1.2, "c2", "fall")],
            shows, [LAMO, ROSA])  # fmt: skip
    status, tasks, script, retry = _e2e(tmp_path, what, faithful, told, chars={"ch1": "A cheeky boy.",
                                                                               "ch2": "A kind girl."})  # fmt: skip
    s1 = script["scenes"][0] if script else {}
    print(
        "E2E-B6",
        status,
        tasks,
        "| retry:",
        retry,
        "| saved s1:",
        [(b["who"], b["do"]) for b in s1.get("beats", [])],
        "| note:",
        s1.get("note"),
    )
    assert not (
        status == "ready" and ("c2", "fall") in [(b["who"], b["do"]) for b in s1["beats"]] and not s1.get("note")
    ), "'He trips and falls' (Lamo, a boy): the video shows Rosa falling, no note"


# === round 1, part 3: the web's Who fed to the check ==============================================================


def test_w1_rosa_is_not_at_home_with_the_who_the_web_sends() -> None:
    what = "Rosa is not at home, so Lamo is alone."
    # the web's sceneWho for this scene is ["ch2", "ch1"] (probe.ts): Rosa is ticked because the words name her
    own = [sc("s1", what, who=("ch2", "ch1")), sc("s2", "Lamo waves.", who=("ch1",))]
    a = [scene("s1", "living_room", [beat(0.3, 2.0, "c1", "sit", face="sad")],
               [piece("Rosa is not at home,", (0,), closest="an empty chair"), piece("so Lamo is alone.", (0,))],
               [LAMO]),
         scene("s2", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO])]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    withr = copy.deepcopy(a)
    withr[0]["actors"].append(dict(ROSA))
    withr[0]["beats"].append(beat(0.3, 2.0, "c2", "idle"))
    withr[0]["shows"][0]["beats"] = [1]
    p2, s2 = check(own, withr, genders=G)
    print("W1 without Rosa:", why(problems), "| with Rosa drawn:", why(p2), "| note:", note_of(s2))
    assert not problems, "through the web (Who ticked from the words) the check forces Rosa, who is not at home, in"


def test_w2_he_walks_home_alone_with_the_who_carried_over() -> None:
    own = [
        sc("s1", "Lamo and Rosa play in the park.", who=("ch1", "ch2")),
        sc("s2", "Later, he walks home alone.", who=("ch1", "ch2")),
    ]  # the web carries Who over (probe.ts)
    # (setup corrected from the reviewers' file: "play" says no jump, so Rosa runs; at 114c58bf the jump was refused
    # too, beside the Rosa the carried Who forced in)
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "run", to={"x": 0.6, "y": 0.72}),
                              beat(0.3, 2, "c2", "run", to={"x": 0.2, "y": 0.72})],
               [piece("Lamo and Rosa play in the park.", (0, 1), place=True)], [LAMO, ROSA]),
         scene("s2", "park", [beat(0.3, 2, "c1", "walk", to={"x": 0.8, "y": 0.72})],
               [piece("Later, he walks home alone.", (0,))], [LAMO])]  # fmt: skip
    problems, _ = check(own, a, genders=G)
    print("W2", why(problems))
    assert not problems, "'he walks home alone' must have Rosa in it (Who carried over): the retry adds her"


# === round 1, the fixer's own attacks: the faithful staging still passes, and the new rules hold ===================


def _one(what: str, beats: list[dict[str, Any]], *, actors: Any = None, who: tuple[str, ...] = (),
         pieces: Any = None, genders: Any = G) -> list[own_script.Problem]:  # fmt: skip
    own = [sc("s1", what, who=who), TAIL_OWN]
    actors = actors or ([LAMO, ROSA] if any(b["who"] == "c2" for b in beats) else [LAMO])
    shows = pieces or [piece(what, tuple(range(len(beats))))]
    return check(own, [scene("s1", "park", beats, shows, actors), tail()], genders=genders)[0]


def test_f_cant_stop_jumping_is_owed_and_a_stop_sign_is_no_stop() -> None:
    assert _one("Lamo can't stop jumping.", [beat(0.3, 1, "c1", "jump")]) == []
    assert _one("Lamo can't stop jumping.", [walk()]), "'can't stop jumping' says he jumps: a walk is no jump"
    reading = own_words.read("Rosso waits at the bus stop by the stop sign.", {"c3": "Rosso"}, cars=["c3"])
    assert [m.family for m in reading.mentions] == []
    reading = own_words.read("Rosso's brakes don't work, so it can't stop.", {"c3": "Rosso"}, cars=["c3"])
    assert [(m.family, m.denied) for m in reading.mentions] == [("stop", True)]


def test_f_a_car_that_comes_to_a_stop_is_owed_and_one_that_cannot_never_stops() -> None:
    what = "Rosso comes to a stop at the stop sign."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    on = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")], [piece(what, (0, 1))],
                [DRIVER], props=[car()]), tail()]  # fmt: skip
    assert one_car(own, on)[0], "a stop drawn as driving on"
    stops = copy.deepcopy(on)
    stops[0]["beats"] = [beat(0, 5, "c1", "drive"), beat(0, 2.5, "car1", "move"), beat(2.5, 1.5, "car1", "stop")]
    stops[0]["shows"][0]["beats"] = [0, 1, 2]
    assert one_car(own, stops)[0] == []
    what = "Rosso's brakes don't work, so it can't stop."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    stops[0]["shows"][0]["words"] = what
    assert one_car(own, stops)[0], "a car the words say can't stop is drawn stopping"
    on[0]["shows"][0]["words"] = what
    assert one_car(own, on)[0] == []


def test_f_who_falls_trips_over_someone_and_falls_with_someone_watching() -> None:
    assert _one("Lamo trips over Rosa.", [beat(0.3, 1.2, "c1", "fall"), beat(0.3, 1.2, "c2", "idle")]) == []
    assert _one("Lamo trips over Rosa.", [beat(0.3, 1.2, "c2", "fall"), beat(0.3, 1.2, "c1", "idle")])
    assert _one("Lamo falls with Rosa watching.", [beat(0.3, 1.2, "c1", "fall"), beat(0.3, 1.2, "c2", "idle")]) == []
    assert _one("Lamo and Rosa dance.", [beat(0.3, 2, "c1", "dance"), beat(0.3, 2, "c2", "dance")]) == []


def test_f_after_says_which_came_first() -> None:
    what = "Lamo falls after he jumps."
    assert _one(what, [beat(0.2, 1.0, "c1", "jump"), beat(1.6, 1.2, "c1", "fall")]) == []
    assert "OWN_ORDER" in keys_of(_one(what, [beat(0.2, 1.2, "c1", "fall"), beat(2.0, 1.0, "c1", "jump")]))


def test_f_when_rosso_honks_lamo_jumps_in_that_order() -> None:
    what = "When Rosso honks, Lamo jumps."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    parked = car(state="parked", x=0.7)
    good = [scene("s1", "city_street", [beat(0.2, 1.0, "car1", "honk", sfx="honk"), beat(1.4, 1.0, "c1", "jump")],
                  [piece(what, (0, 1))], [LAMO], props=[parked]), tail()]  # fmt: skip
    assert one_car(own, good)[0] == []
    bad = copy.deepcopy(good)
    bad[0]["beats"] = [beat(1.6, 1.0, "car1", "honk", sfx="honk"), beat(0.2, 1.0, "c1", "jump")]
    assert "OWN_ORDER" in keys_of(one_car(own, bad)[0])


def test_f_feelings_that_change_and_words_that_are_no_feeling() -> None:
    # one piece, two feelings in order: one beat each is right
    assert (
        _one(
            "Lamo cries, then laughs.",
            [beat(0.3, 1, "c1", "idle", face="sad"), beat(1.5, 1.5, "c1", "idle", face="laughing", noise="laugh")],
        )
        == []
    )
    assert _one("Lamo turns on the full beam.", [beat(0.3, 2, "c1", "idle", face="worried")]) == []
    assert _one("Lamo crosses the road.", [beat(0.3, 2, "c1", "walk", to={"x": 0.6, "y": 0.72}, face="laughing")]) == []
    assert _one("Lamo sighs with relief.", [beat(0.3, 2, "c1", "idle", face="relieved")]) == []
    assert _one("Lamo can't stop laughing.", [beat(0.3, 2, "c1", "idle", face="sad")]), "laughing drawn sad"
    assert (
        _one(
            "Lamo tells Rosa a joke and she laughs.",
            [beat(0.3, 1, "c1", "gesture"), beat(1.5, 1.5, "c2", "idle", face="laughing")],
        )
        == []
    )
    assert _one(
        "Lamo tells Rosa a joke and she laughs.",
        [beat(0.3, 1, "c1", "gesture"), beat(1.5, 1.5, "c2", "idle", face="sad")],
    )


def test_f_a_foot_that_slips_is_its_owners_fall() -> None:
    what = "Lamo's foot slips on the ice."
    assert _one(what, [walk()]), "Lamo's foot slips: Lamo slips"
    assert _one(what, [beat(0.3, 1.2, "c1", "slip")]) == []


def test_f_names_by_their_last_word_and_in_a_script_with_no_capitals() -> None:
    names = {"c1": "Pip", "c2": "Nana Rose"}
    assert own_words.named_keys("Rose hugs Pip.", names) == ["c1", "c2"]
    assert own_words.named_keys("The sun rose and Pip woke up.", names) == ["c1"]
    assert own_words.named_keys("lamo and rosa dance.", {"c1": "Lamo", "c2": "Rosa"}) == ["c1", "c2"]
    assert own_words.named_keys("lamo will dance.", {"c1": "Lamo", "c2": "Will"}) == ["c1", "c2"]  # no capitals
    assert own_words.named_keys("Lamo will dance.", {"c1": "Lamo", "c2": "Will"}) == ["c1"]
    assert _one("lamo and rosa dance.", [beat(0.3, 2, "c1", "dance"), beat(0.3, 2, "c2", "idle")])


def test_f_getting_in_and_out_of_a_car_is_owed_and_getting_into_bed_is_not() -> None:
    assert own_words.read("Lamo gets into bed.", {"c1": "Lamo"}).mentions == []
    what = "Lamo gets out of Rosso and waves."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0.3, 1.2, "c1", "get_out"), beat(1.7, 1, "c1", "wave")],
               [piece(what, (0, 1))], [{**LAMO, "x": 0.4, "inCar": "car1"}], props=[car(state="parked")]),
         tail()]  # fmt: skip
    assert one_car(own, a)[0] == []
    a[0]["beats"][0]["do"] = "get_in"
    assert one_car(own, a)[0], "getting in drawn where the words say he gets out"


def test_f_a_cars_event_by_its_owner() -> None:
    what = "Rosso's tyre bursts."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(1, 1, "car1", "tyre_burst", sfx="tyre_burst")],
               [piece(what, (0, 1))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    assert one_car(own, a)[0] == []
    what = "Lamo's car skids."  # his car: the one he drives
    own = [sc("s1", what, who=("ch1", "ch3"), place="icy_road"), TAIL_OWN]
    a = [scene("s1", "icy_road", [beat(0, 5, "c1", "drive"), beat(0.3, 1.5, "car1", "skid", sfx="skid")],
               [piece(what, (0, 1))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    assert one_car(own, a)[0] == []
    what = "Lamo and Rosa zoom off in Rosso."  # one car's event shows for everyone in it
    own = [sc("s1", what, who=("ch1", "ch2", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0.5, 2, "car1", "speed_up", sfx="whoosh"),
                                     beat(0.5, 2, "c2", "idle", face="happy")],
               [piece(what, (0, 1, 2))], [DRIVER, {**ROSA, "inCar": "car1"}], props=[car()]), tail()]  # fmt: skip
    assert one_car(own, a)[0] == []


def test_f_counts_add_up_and_said_things_are_never_owed() -> None:
    what = "Lamo jumps three times, then jumps again."
    assert _one(what, [beat(0.2 + i * 0.9, 0.8, "c1", "jump") for i in range(4)]) == []
    assert _one(what, [beat(0.2 + i * 0.9, 0.8, "c1", "jump") for i in range(3)])
    assert (
        _one(
            'Rosa says "Don\'t fall!" and Lamo falls.',
            [beat(0.3, 1, "c2", "point"), beat(1.5, 1.2, "c1", "fall")],
            pieces=[piece('Rosa says "Don\'t fall!"', (0,)), piece("and Lamo falls.", (1,))],
        )
        == []
    )
    assert _one('Lamo shouts "I fell!"', [beat(0.3, 1.5, "c1", "gesture", face="happy")]) == []
    assert _one("If it rains, Lamo will dance.", [beat(0.3, 1.5, "c1", "think")]) == []


def test_f_a_pronoun_with_no_name_is_one_of_the_scenes_own_people() -> None:
    own = [sc("s1", "He falls.", who=("ch1", "ch2")), TAIL_OWN]
    rosa_falls = [scene("s1", "park", [beat(0.3, 1.2, "c2", "fall"), beat(0.3, 1.2, "c1", "idle")],
                        [piece("He falls.", (0, 1))], [LAMO, ROSA]), tail()]  # fmt: skip
    assert check(own, rosa_falls, genders=G)[0], "'He falls' (Lamo, the only boy of its Who) drawn as Rosa"


def test_f_alone_and_away_with_the_who_the_web_sends() -> None:
    names = {"c1": "Lamo", "c2": "Rosa"}
    assert own_words.read("Rosa is away, so Lamo plays alone.", names).absent == {"c2"}
    assert own_words.read("Lamo leaves Rosa alone.", names).absent == set()
    assert own_words.read("Lamo feels alone at the party with Rosa.", names).absent == set()
    own = [sc("s1", "Rosa is away, so Lamo plays alone.", who=("ch1", "ch2")), TAIL_OWN]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "idle", face="sad")],
               [piece("Rosa is away,", (0,), closest="an empty bench"), piece("so Lamo plays alone.", (0,))],
               [LAMO]), tail()]  # fmt: skip
    assert check(own, a, genders=G)[0] == []


def test_f_the_agent_never_stops_on_a_word_the_web_no_longer_asks_about() -> None:
    cast = ["Pip", "Dash", "Bolt", "Rosso", "Nana Rose"]
    for what in ("Pip likes Pizza.", "Dash eats Pizza.", "Pip opens the Fridge.", "Pip turns Left.", "Pip is the Winner!",
                 "Dash and Pip play football. Goal!", "Dash and his Dog play.", "Dash sees a big Dinosaur.",
                 "Pip falls asleep. Zzz.", "Pip and Dash go to Disneyland.", "Rosso drives to Tesco.",
                 "Pip and Dash eat at McDonald's.", "Pip watches Peppa Pig on TV.", "Bolt sees a shiny Ferrari."):  # fmt: skip
        assert own_script.unknown_name(what, cast) is None, what
    assert own_script.unknown_name("Dash meets his best friend Zara.", cast) == "Zara"
    assert own_script.unknown_name("Dash hugs his Mum.", cast) == "Mum"
    assert own_script.unknown_name("Peppa Pig waves.", cast, ["Peppa", "Pig"]) is None  # answered word by word
    assert own_script.names_in("Rose hugs Pip.", {"c1": "Pip", "c2": "Nana Rose"}) == ["c1", "c2"]


def test_f_the_web_and_the_agent_read_the_same_everyday_names() -> None:
    import re
    from pathlib import Path

    web = (Path(__file__).resolve().parents[3] / "web" / "src" / "stories" / "studio" / "ownScript.ts").read_text(
        "utf-8"
    )
    block = web.split("export const NAME_WORDS = new Set(", 1)[1].split(").split", 1)[0]
    words = {w for lit in re.findall(r'"([^"]*)"', block) for w in lit.split()}
    assert words == own_words.NAME_WORDS, sorted(words ^ own_words.NAME_WORDS)
    for name, mine in (("DETERMINERS", own_script.DETERMINERS), ("PERSON_WORDS", own_script.PERSON_WORDS),
                       ("PET_WORDS", own_script.PET_WORDS), ("NOT_A_THINGS_WORD", own_script._NOT_A_THINGS_WORD)):  # fmt: skip
        lit = web.split(f"const {name} = new Set(", 1)[1].split(".split(", 1)[0]
        got = {w for part in re.findall(r'"([^"]*)"', lit) for w in part.split()}
        assert got == mine, (name, sorted(got ^ mine))
    # a name after a full stop, a comma or a joining word is still asked ("the park and Max", "At the park, Max")
    for what in (
        "Lamo runs to the park and Max waves.",
        "Lamo goes to the park. Max waves.",
        "At the park, Max waves.",
    ):
        assert own_script.unknown_name(what, ["Lamo"]) == "Max", what


def test_f_they_and_a_longer_names_last_word_feel_it_too() -> None:
    names = {"c1": "Pip", "c2": "Nana Rose"}
    moods = own_words.read("Pip falls over. They both laugh.", names, present=["c1", "c2"]).moods
    assert [(m.happy, sorted(m.who)) for m in moods] == [(True, ["c1", "c2"])]
    assert [(m.happy, sorted(m.who)) for m in own_words.read("Rose hugs Pip.", names).moods] == [(True, ["c2"])]


def test_f_a_fact_problem_about_the_owners_own_phone_is_only_reported() -> None:
    what = "Lamo looks at his phone while he drives."
    phone = {"propId": "ph1", "kind": "phone", "x": 0.45, "y": 0.6, "scale": 1, "rot": 0}
    script = {"scenes": [{"sceneId": "s1", "beats": [beat(0, 5, "c1", "drive", face="happy"),
                                                     beat(0, 5, "car1", "move")], "props": [car(), phone]}]}  # fmt: skip
    assert own_script.owners_beat(script, "s1", "0", what, "Lamo uses a phone while driving: not safe.")
    assert not own_script.owners_beat(script, "s1", "0", what, "Laughing at the wheel is not safe.")
    assert not own_script.owners_beat(script, "s1", "0", "Lamo drives home.", "Lamo uses a phone while driving.")
    # a new take that drops the phone the words say is refused
    old = {"cast": CAST, "cars": ROSSO, "scenes": [{"sceneId": "s1", **script["scenes"][0]}]}
    take = copy.deepcopy(old)
    take["scenes"][0]["props"] = [car()]
    own = own_script.scenes_of([sc("s1", what, who=("ch1", "ch3")), TAIL_OWN])
    assert [p.key for p in own_script.kept_problems(old, take, own, ["s1"])] == ["OWN_NOT_SHOWN"]
    assert own_script.kept_problems(old, copy.deepcopy(old), own, ["s1"]) == []
