"""Write it myself, round 2 of the re-review (24 Nov): the reviewers' attacks on PR #201 at 059e6a10, ported as they
were written (/tmp/own-attack-r2, tests/test_attacks_r2.py), and the fixer's own cases. Each asserts what a faithful
check does: a no is about the word it comes before ("Rosa doesn't see Lamo slip": he slips), "Before Lamo jumps, he
dances" is the dance first, the plain actions the engine has are owed ("Lamo nods" is never a head shake), the same
event said in another sentence happens again, counts the words spell or give after a comma, real events after a fear
or a shout ("so scared he jumps"), more words for falls, jumps, dances and a car's events, feelings said by their sound
and a feeling that must show, the fact check never redraws the owner's laugh, who does what (Max's car, two boys and
one "he", someone the cast does not have), a forgotten closing quote and look-alike letters.

R14 (the web's Who carried into "They swim in the pond" and the cast's car ticked for a toy car) is not ported as
written: the check keeps honouring a Who the owner sends, and the web no longer sends those (its premise is gone, as
N17's was; web/test/storiesOwnScript.test.tsx › round 2). ``test_r14_with_the_who_the_web_now_sends`` checks the
same scenes with the Who the web now sends. A FAILING test is an attack that slips through (or a faithful staging the
check refuses, so its retry would change what happens); ``test_holds_*`` asserts a defence that held."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import own_script, own_words
from test_own_script import LAMO, ROSA, beat, piece, scene
from test_own_script_round1 import (
    CAR_MAP,
    CASTMAP,
    DRIVER,
    PLACES,
    ROSSO,
    TAIL_OWN,
    G,
    _e2e,
    car,
    check,
    note_of,
    one_car,
    sc,
    tail,
    walk,
    why,
)

MAX = {"castId": "c2", "x": 0.7, "y": 0.72, "facing": "left"}
LAMO_MAX = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Max"}}
BOYS = {"c1": "he", "c2": "he"}


def silent(problems: list[own_script.Problem], script: dict[str, Any]) -> bool:
    return not problems and not note_of(script)


def solo(what: str, beats: list[dict[str, Any]], *, actors: Any = None, pieces: Any = None, genders: Any = G,
         who: tuple[str, ...] = ()) -> tuple[list[own_script.Problem], dict[str, Any]]:  # fmt: skip
    own = [sc("s1", what, who=who), TAIL_OWN]
    actors = actors or ([LAMO, ROSA] if any(b["who"] == "c2" for b in beats) else [LAMO])
    shows = pieces or [piece(what, tuple(range(len(beats))))]
    return check(own, [scene("s1", "park", beats, shows, actors), tail()], genders=genders)


def plain_drive(what: str, place: str = "city_street") -> tuple[list[own_script.Problem], dict[str, Any]]:
    own = [sc("s1", what, who=("ch1", "ch3"), place=place), TAIL_OWN]
    a = [scene("s1", place, [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")], [piece(what, (0, 1))],
               [DRIVER], props=[car()]), tail()]  # fmt: skip
    return one_car(own, a)


# === R1. synonyms: a person's fall, a jump, a dance said another way, drawn as a plain walk ==========================


@pytest.mark.parametrize("what", ["Lamo crashes to the ground.", "Lamo loses his balance.", "Lamo keels over.",
                                  "Lamo wipes out on his skateboard.", "Lamo lands on his bottom.",
                                  "Lamo goes flying."])  # fmt: skip
def test_r1_a_fall_said_another_way_drawn_as_a_walk(what: str) -> None:
    problems, script = solo(what, [walk()])
    print("R1", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as a plain walk: no problem, no note"


@pytest.mark.parametrize("what", ["Lamo bounces on the bed.", "Lamo springs into the air.", "Lamo grooves to the music.",
                                  "Lamo does a little jig."])  # fmt: skip
def test_r1b_a_jump_or_a_dance_said_another_way_drawn_as_a_walk(what: str) -> None:
    problems, script = solo(what, [walk()])
    print("R1b", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as a plain walk: no problem, no note"


# === R2. a car's event said another way (or implied by its verb), drawn as driving straight on ========================


@pytest.mark.parametrize("what", ["Lamo slams the brakes.", "Rosso beeps at the bus.", "Rosso bangs into the wall.",
                                  "Rosso drives into a tree.", "Rosso knocks into the bin.",
                                  "Rosso goes really quickly.", "Rosso rushes to school.",
                                  "Rosso runs out of petrol.", "Rosso's tyre goes bang."])  # fmt: skip
def test_r2_a_cars_event_said_another_way_drawn_as_driving_on(what: str) -> None:
    problems, script = plain_drive(what)
    print("R2", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as Rosso driving straight on: no problem, no note"


def test_holds_r2_the_words_the_reader_knows() -> None:
    for what in ("Lamo slams on the brakes.", "Rosso honks at the bus.", "Rosso crashes into the wall.",
                 "Rosso speeds to school."):  # fmt: skip
        assert plain_drive(what)[0], what


# === R3. engine actions the reader does not know: a yes drawn as a no, sitting drawn as running =====================


@pytest.mark.parametrize("what,drawn", [
    ("Lamo nods.", "shake_head"), ("Lamo shakes his head.", "nod"), ("Lamo sits down.", "run"),
    ("Lamo runs away.", "sit"), ("Lamo gives a thumbs up.", "facepalm"), ("Lamo gets up.", "sit"),
    ("Lamo waves at Rosa.", "point"),
])  # fmt: skip
def test_r3_an_action_the_engine_has_drawn_as_another(what: str, drawn: str) -> None:
    beats = [beat(0.3, 1.5, "c1", drawn)]
    actors = [LAMO, ROSA] if "Rosa" in what else [LAMO]
    if "Rosa" in what:
        beats.append(beat(0.3, 1.5, "c2", "idle"))
    problems, script = solo(what, beats, actors=actors)
    print("R3", what, "drawn", drawn, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as {drawn}: no problem, no note"


# === R4. feelings: shown only by a sound in the words, dropped, or drawn with a face the lists do not know =========


@pytest.mark.parametrize("what", ["Lamo goes boo hoo.", "Lamo wails.", "Lamo bawls his eyes out.", "Lamo whines."])
def test_r4_crying_said_by_its_sound_drawn_laughing(what: str) -> None:
    problems, _script = solo(what, [beat(0.3, 2, "c1", "celebrate", face="laughing", noise="laugh")])
    print("R4", what, why(problems))
    assert problems, f"{what!r} drawn as Lamo laughing and celebrating"


@pytest.mark.parametrize("what", ["Lamo squeals with delight.", "Lamo cackles.", "Lamo chortles.",
                                  "Lamo goes hee hee hee."])  # fmt: skip
def test_r4b_laughing_said_by_its_sound_drawn_crying(what: str) -> None:
    problems, _script = solo(what, [beat(0.3, 2, "c1", "cower", face="sad", noise="sigh")])
    print("R4b", what, why(problems))
    assert problems, f"{what!r} drawn as Lamo sad, cowering and sighing"


@pytest.mark.parametrize("what", ["Lamo cries.", "Lamo laughs.", "Lamo is very sad."])
def test_r4c_the_only_feeling_of_the_scene_dropped(what: str) -> None:
    problems, script = solo(what, [walk()])
    print("R4c", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as Lamo walking with no feeling at all: silent"


def test_r4d_happy_drawn_shocked_with_a_heartbeat() -> None:
    problems, script = solo("Lamo is calm and happy.", [beat(0.3, 2, "c1", "gasp", face="shocked", noise="whoa",
                                                             sfx="heartbeat")])  # fmt: skip
    print("R4d", why(problems), "| note:", note_of(script))
    assert problems, "calm and happy drawn as a shocked gasp with a heartbeat"


@pytest.mark.parametrize("what,beats", [
    ("Lamo wins the race.", [beat(0.3, 1.5, "c1", "run", to={"x": 0.7, "y": 0.72}),
                             beat(2.0, 1.5, "c1", "facepalm", face="angry", bubble="angry")]),
    ("Lamo loses the race.", [beat(0.3, 1.5, "c1", "run", to={"x": 0.7, "y": 0.72}),
                              beat(2.0, 1.5, "c1", "celebrate", face="laughing", bubble="heart")]),
])  # fmt: skip
def test_r4e_a_running_joke_of_the_series_flips_a_win_or_a_loss(what: str, beats: list[Any]) -> None:
    problems, script = solo(what, beats)
    print("R4e", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r}: the running joke's opposite feeling passes"


# === R5. words before the event that look like "only a mention" but are not ====================================


@pytest.mark.parametrize("what,beats", [
    ("Lamo is so scared he jumps!", [beat(0.3, 2, "c1", "cower", face="scared")]),
    ("Rosa's loud shout makes Lamo jump.", [beat(0.3, 1, "c2", "point"), beat(1.4, 1.2, "c1", "gasp", face="shocked")]),
    ("Rosa tells a joke that makes Lamo fall off his chair.",
     [beat(0.3, 1, "c2", "gesture", face="happy"), beat(1.4, 2, "c1", "sit", face="laughing", noise="laugh")]),
    ("Lamo climbs the tree to jump into the pool.", [beat(0.3, 2, "c1", "walk", to={"x": 0.6, "y": 0.72})]),
    ("Lamo and Rosa take turns to jump.", [beat(0.3, 1, "c1", "wave"), beat(1.4, 1, "c2", "wave")]),
])  # fmt: skip
def test_r5_a_real_event_read_as_only_mentioned(what: str, beats: list[Any]) -> None:
    problems, script = solo(what, beats)
    print("R5", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r}: the event is dropped, no problem, no note"


# === R6. a "no" that is about seeing, not about the event: the check refuses the faithful staging =================


@pytest.mark.parametrize("what,beats", [
    ("Rosa doesn't see Lamo slip on the ice.", [beat(0.3, 1.5, "c2", "look_left"), beat(0.5, 1.2, "c1", "slip")]),
    ("Nobody sees Lamo fall.", [beat(0.5, 1.2, "c1", "fall")]),
    ("Rosa can't believe that Lamo jumps so high.", [beat(0.3, 1.5, "c2", "gasp", face="surprised"),
                                                    beat(0.5, 1.2, "c1", "jump")]),
])  # fmt: skip
def test_r6_the_faithful_event_is_refused_as_does_not_happen(what: str, beats: list[Any]) -> None:
    problems, _script = solo(what, beats)
    print("R6", what, why(problems))
    assert not problems, f"{what!r}: Lamo's own event is refused as 'does not happen'; the retry removes it"


def test_r6_e2e_the_retry_takes_lamos_slip_away_and_the_video_is_ready(tmp_path: Path) -> None:
    what = "Rosa doesn't see Lamo slip on the ice."
    shows = [piece(what, (0, 1))]
    faithful = ([beat(0.3, 1.5, "c2", "look_left"), beat(0.5, 1.2, "c1", "slip")], shows, [LAMO, ROSA])
    told = ([beat(0.3, 1.5, "c2", "look_left"), beat(0.5, 1.5, "c1", "walk", to={"x": 0.5, "y": 0.72})], shows,
            [LAMO, ROSA])  # fmt: skip
    status, _tasks, script, retry = _e2e(tmp_path, what, faithful, told)
    s1 = script["scenes"][0] if script else {}
    print("R6-E2E", status, "| retry:", retry, "| saved:", [(b["who"], b["do"]) for b in s1.get("beats", [])],
          "| note:", s1.get("note"))  # fmt: skip
    assert not (status == "ready" and not any(b["do"] in ("slip", "fall") for b in s1["beats"])
                and not s1.get("note")), "the owner's slip is gone, the video is ready, no note"  # fmt: skip


# === R7. a conditional after the event, and quotes the reader does not know =======================================


def test_r7_a_fall_only_in_an_if_after_it_is_forced() -> None:
    what = "Lamo falls if he runs too fast, so he walks slowly."
    problems, _ = solo(what, [walk()])
    print("R7", why(problems))
    assert not problems, "'falls if he runs too fast, so he walks slowly': the check forces the fall"


@pytest.mark.parametrize("what,quote", [("Rosa shouts 'Jump!' and Lamo jumps.", "'Jump!'"),
                                        ("Rosa shouts ‘Jump!’ and Lamo jumps.", "‘Jump!’"),
                                        ("Rosa shouts „Jump!“ and Lamo jumps.", "„Jump!“")])  # fmt: skip
def test_r7b_a_shout_in_single_or_other_quotes_makes_the_shouter_jump(what: str, quote: str) -> None:
    pieces = [piece(f"Rosa shouts {quote}", (0,)), piece("and Lamo jumps.", (1,))]
    problems, _ = solo(what, [beat(0.3, 1.2, "c2", "point", face="determined"), beat(1.6, 1.0, "c1", "jump")],
                       pieces=pieces)  # fmt: skip
    print("R7b", what, why(problems))
    assert not problems, f"{what!r}: Rosa is told to jump because she shouted it"


def test_r7c_a_quote_never_closed_hides_the_rest_of_the_scene() -> None:
    what = 'Rosa shouts "Watch out! Lamo trips and falls.'
    pieces = [piece('Rosa shouts "Watch out!', (0,)), piece("Lamo trips and falls.", (1,))]
    problems, script = solo(what, [beat(0.3, 1.2, "c2", "point", face="worried"), walk(1.5)], pieces=pieces)
    print("R7c", why(problems), "| note:", note_of(script))
    assert not silent(problems, script), "a forgotten closing quote: Lamo's fall is never owed, a walk passes"


# === R8. counts: spelled out, big, a couple, after a comma, said again in another sentence ========================


@pytest.mark.parametrize("what", ["Lamo jumps fifteen times.", "Lamo jumps 100 times.", "Lamo jumps a hundred times.",
                                  "Lamo jumps a couple of times.", "Lamo hops, three times!"])  # fmt: skip
def test_r8_a_count_the_reader_misses_drawn_once(what: str) -> None:
    problems, script = solo(what, [beat(0.3, 1.0, "c1", "jump")])
    print("R8", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as one jump: no problem, no note"


@pytest.mark.parametrize("what,beats", [
    ("Lamo falls over. He gets up. Then he falls over.", [beat(0.3, 1.2, "c1", "fall"), beat(1.6, 1.0, "c1", "get_up")]),
    ("Lamo jumps. Rosa claps. Lamo jumps.", [beat(0.3, 1.0, "c1", "jump"), beat(1.5, 1.0, "c2", "celebrate")]),
])  # fmt: skip
def test_r8b_the_same_event_said_again_in_a_later_sentence_is_owed_once(what: str, beats: list[Any]) -> None:
    problems, script = solo(what, beats)
    print("R8b", what, why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r}: the second one is gone, no problem, no note"


def test_r8c_two_exact_counts_said_apart_are_capped_to_one() -> None:
    what = "Lamo jumps twice. Rosa claps. Lamo jumps twice."
    beats = [beat(0.2, 0.5, "c1", "jump"), beat(0.8, 0.5, "c1", "jump"), beat(1.5, 1.0, "c2", "celebrate"),
             beat(2.7, 0.5, "c1", "jump"), beat(3.3, 0.5, "c1", "jump")]  # fmt: skip
    problems, _ = solo(what, beats)
    print("R8c", why(problems))
    assert not problems, "four jumps (twice, then twice again) refused: the retry is told to draw exactly 2"


# === R9. order: "Before X, Y" and "but first" =====================================================================


@pytest.mark.parametrize("what", ["Before Lamo jumps into the pool, he dances.",
                                  "Lamo jumps into the pool, but first he dances."])  # fmt: skip
def test_r9_the_faithful_order_is_refused(what: str) -> None:
    problems, _ = solo(what, [beat(0.3, 1.5, "c1", "dance"), beat(2.2, 1.0, "c1", "jump")])
    print("R9", what, why(problems))
    assert not problems, f"{what!r}: dance first (as written) is refused; the retry jumps first"


def test_r9_e2e_the_retry_reverses_the_owners_order_and_the_video_is_ready(tmp_path: Path) -> None:
    what = "Before Lamo jumps into the pool, he dances."
    shows = [piece(what, (0, 1))]
    faithful = ([beat(0.3, 1.5, "c1", "dance"), beat(2.2, 1.0, "c1", "jump")], shows, [LAMO])
    told = ([beat(2.2, 1.5, "c1", "dance"), beat(0.3, 1.0, "c1", "jump")], shows, [LAMO])
    status, _tasks, script, retry = _e2e(tmp_path, what, faithful, told)
    s1 = script["scenes"][0] if script else {}
    order = [b["do"] for b in sorted(s1.get("beats", []), key=lambda b: b["at"])]
    print("R9-E2E", status, "| retry:", retry, "| saved order:", order, "| note:", s1.get("note"))
    assert not (status == "ready" and order[:1] == ["jump"] and not s1.get("note")), (
        "the owner wrote the dance first; the video jumps first, no note"
    )


# === R10. who: two boys and one "he", Max's car drawn as Lamo's Rosso, someone the cast does not have ==============


def test_r10_two_boys_one_he_the_check_picks_the_last_named_and_refuses_the_other() -> None:
    what = "Lamo waves at Max. He trips and falls."
    pieces = [piece("Lamo waves at Max.", (0, 1)), piece("He trips and falls.", (2,))]
    lamo = [beat(0.3, 1.0, "c1", "wave"), beat(0.3, 1.0, "c2", "idle"), beat(1.6, 1.2, "c1", "fall")]
    max_ = [beat(0.3, 1.0, "c1", "wave"), beat(0.3, 1.0, "c2", "idle"), beat(1.6, 1.2, "c2", "fall")]
    own = [sc("s1", what), TAIL_OWN]
    p1, s1 = check(own, [scene("s1", "park", lamo, pieces, [LAMO, MAX]), tail()], cast=LAMO_MAX, genders=BOYS)
    p2, s2 = check(own, [scene("s1", "park", max_, pieces, [LAMO, MAX]), tail()], cast=LAMO_MAX, genders=BOYS)
    print("R10 Lamo falls:", why(p1), "| note:", note_of(s1), "|| Max falls:", why(p2), "| note:", note_of(s2))
    assert not p1 and "Lamo" in note_of(s1) and "Max" in note_of(s2), (
        "'He' could be Lamo or Max: the check decides Max silently (Lamo's fall is refused, Max's has no note)"
    )


def test_r10b_maxs_car_honks_drawn_as_lamos_rosso_honking() -> None:
    cast = {"c1": {"characterId": "ch1", "name": "Lamo"}, "c2": {"characterId": "ch2", "name": "Max"}}
    castmap = {"ch1": "c1", "ch2": "c2", "ch3": "c3"}
    what = "Lamo walks past Max's car. Max's car honks."
    # the web ticks the cast's one car (Rosso) in a scene whose words say "car" (sceneWho, CAR_WORDS)
    own = [sc("s1", what, who=("ch1", "ch2", "ch3"), place="city_street"), TAIL_OWN]
    a = [scene("s1", "city_street", [walk(), beat(0.3, 2, "c2", "idle", face="happy"),
                                     beat(2.6, 1.0, "car1", "honk", sfx="honk")],
               [piece("Lamo walks past Max's car. Max's", (0, 1)), piece("car honks.", (2,))],
               [LAMO, MAX], props=[car(state="parked")]), tail()]  # fmt: skip
    problems, script = check(own, a, cast=cast, cars=ROSSO, castmap=castmap, genders=BOYS)
    print("R10b", why(problems), "| note:", note_of(script))
    assert not silent(problems, script), "Lamo's car Rosso honks where the owner wrote Max's car: silent"


@pytest.mark.parametrize("what,beats", [
    ("A man falls over in the park.", [beat(0.3, 1.5, "c1", "gasp", face="shocked")]),
    ("The Grinch falls down the chimney.", [beat(0.3, 1.5, "c1", "point", face="surprised")]),
    ("The Grinch falls down the chimney.", [beat(0.3, 1.5, "c1", "fall")]),
])  # fmt: skip
def test_r10c_an_event_by_someone_not_in_the_cast_dropped_or_given_to_lamo(what: str, beats: list[Any]) -> None:
    assert own_script.unknown_name(what, ["Lamo", "Rosa"]) is None  # never asked about
    problems, script = solo(what, beats)
    print("R10c", what, [(b["who"], b["do"]) for b in beats], why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!r} drawn as {[(b['who'], b['do']) for b in beats]}: silent"


# === R11. the fact check's staging fix drops the owner's laugh =====================================================


def test_r11_the_fact_checks_fix_drops_the_owners_laugh_at_the_wheel() -> None:
    what = "Lamo laughs as he drives Rosso home."
    own = [sc("s1", what, who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    first = [scene("s1", "city_street", [beat(0, 5, "c1", "drive", face="laughing", noise="laugh"),
                                         beat(0, 5, "car1", "move")],
                   [piece(what, (0, 1))], [DRIVER], props=[car()]), tail()]  # fmt: skip
    p0, script = one_car(own, first)
    assert p0 == [], why(p0)
    problem = "Lamo laughing at the wheel is not safe: keep eyes on the road."
    owners = own_script.owners_beat(script, "s1", "0", what, problem)
    fixed = {"scenes": [scene("s1", "city_street", [beat(0, 5, "c1", "drive"), beat(0, 5, "car1", "move")],
                              [piece(what, (0, 1))], [DRIVER], props=[car()])]}  # fmt: skip
    own_s = own_script.scenes_of(own)
    merged, _ = own_script.merged_take(script, fixed, own_s, ["s1"], genders=G)
    out = own_script.own_problems(fixed, merged, own_s, CAR_MAP, places=PLACES, asked=["s1"], genders=G)
    kept = own_script.kept_problems(script, merged, own_s, ["s1"])
    print("R11 owners_beat:", owners, "| own_problems:", why(out), "| kept:", why(kept), "| note:", note_of(merged))
    assert owners or out or kept or note_of(merged), "the owner's laugh is gone after the fact check's fix: silent"


# === R12. hidden and look-alike letters the cleaner does not know ================================================


@pytest.mark.parametrize(
    "what",
    [
        "Lamo fɑlls over.",  # Latin alpha
        "Lamo faⅼⅼs over.",  # small roman numeral fifty
        "Lamo \U0001d41f\U0001d41a\U0001d425\U0001d425\U0001d42c over.",
    ],
)  # bold "falls"
def test_r12_a_fall_in_letters_the_reader_does_not_fold_drawn_as_a_walk(what: str) -> None:
    problems, script = solo(what, [walk()])
    print("R12", ascii(what), why(problems), "| note:", note_of(script))
    assert not silent(problems, script), f"{what!a} shows as 'falls': a walk passes"


# === R13. near the limits ========================================================================================


def test_holds_r13_a_160_letter_scene_with_six_events_one_dropped() -> None:
    what = ("Lamo jumps, then Rosa dances, then Lamo falls, then Rosa jumps, then Lamo dances, and then at the very "
            "end of the long day Rosa trips and falls over.")  # fmt: skip
    assert len(what) <= own_script.MAX_WHAT
    beats = [beat(0.2, 0.6, "c1", "jump"), beat(0.9, 0.6, "c2", "dance"), beat(1.6, 0.6, "c1", "fall"),
             beat(2.3, 0.6, "c2", "jump"), beat(3.0, 0.6, "c1", "dance"), beat(3.7, 0.6, "c2", "idle")]  # fmt: skip
    problems, _ = solo(what, beats)
    print("R13", why(problems))
    assert problems


def test_r13b_twelve_scenes_the_last_he_is_two_boys_and_told() -> None:
    whats = [f"Lamo and Max play game {i}." for i in range(1, 12)] + ["He falls."]
    own = [sc(f"s{i + 1}", w, who=("ch1", "ch2")) for i, w in enumerate(whats)]
    a = [scene(f"s{i + 1}", "park", [beat(0.3, 1.5, "c1", "run", to={"x": 0.6, "y": 0.72}), beat(0.3, 1.5, "c2", "idle")],
               [piece(w, (0, 1))], [LAMO, MAX], dur=3) for i, w in enumerate(whats[:-1])]  # fmt: skip
    a.append(scene("s12", "park", [beat(0.3, 1.2, "c2", "fall"), beat(0.3, 1.2, "c1", "idle")],
                   [piece("He falls.", (0, 1))], [LAMO, MAX], dur=3))  # fmt: skip
    problems, script = check(own, a, cast=LAMO_MAX, genders=BOYS)
    print("R13b", why(problems), "| note:", note_of(script, "s12"))
    assert not problems and "Max" in note_of(script, "s12")


def test_r4d2_happy_drawn_shocked_with_no_sound() -> None:
    problems, script = solo("Lamo is calm and happy.", [beat(0.3, 2, "c1", "gasp", face="shocked", noise="whoa")])
    print("R4d2", why(problems), "| note:", note_of(script))
    assert problems, "calm and happy drawn as a shocked gasp ('whoa')"


# === R14. the web's Who: only where the words put people (web/src/stories/studio/ownScript.ts sceneWho, round 2) ====
# toOwnScript now gives s2 "Lamo sees some ducks. They swim in the pond." who ["ch1"] (they may be the ducks) and
# "Lamo plays with his toy car in his bedroom." who ["ch1"] (a toy car is no car of the cast)


@pytest.mark.parametrize("what,extra", [("Lamo sees some ducks. They swim in the pond.", None),
                                        ("Lamo plays with his toy car in his bedroom.", "car")])  # fmt: skip
def test_r14_with_the_who_the_web_now_sends(what: str, extra: Any) -> None:
    own = [sc("s1", "Lamo and Rosa play in the park.", who=("ch1", "ch2")), sc("s2", what, who=("ch1",))]
    a = [scene("s1", "park", [beat(0.3, 2, "c1", "run", to={"x": 0.6, "y": 0.72}),
                              beat(0.3, 2, "c2", "run", to={"x": 0.2, "y": 0.72})],
               [piece("Lamo and Rosa play in the park.", (0, 1), place=True)], [LAMO, ROSA]),
         scene("s2", "living_room" if extra else "park", [beat(0.3, 2, "c1", "idle", face="happy")],
               [piece(what, (0,), closest="Lamo watching, the ducks not drawn" if not extra else
                      "Lamo playing on the floor, the toy car not drawn")], [LAMO])]  # fmt: skip
    problems, script = check(own, a, cars=ROSSO, castmap=CAR_MAP, genders=G)
    print("R14", what, why(problems), "| note:", note_of(script, "s2"))
    assert not problems, why(problems)


def test_r3_e2e_lamo_nods_drawn_shaking_his_head_is_saved_ready(tmp_path: Path) -> None:
    what = "Lamo nods."
    shows = [piece(what, (0,))]
    status, tasks, script, _retry = _e2e(tmp_path, what, ([beat(0.3, 1.5, "c1", "shake_head")], shows, [LAMO]),
                                        ([beat(0.3, 1.5, "c1", "shake_head")], shows, [LAMO]))  # fmt: skip
    s1 = script["scenes"][0] if script else {}
    print("R3-E2E", status, tasks, "| saved:", [b["do"] for b in s1.get("beats", [])], "| note:", s1.get("note"))
    assert not (status == "ready" and [b["do"] for b in s1["beats"]] == ["shake_head"] and not s1.get("note")), (
        "the owner wrote Lamo nods (yes); the video shows him shaking his head (no), no note"
    )


def test_holds_r15_a_remake_after_a_caption_only_edit_of_another_scene_keeps_the_new_words() -> None:
    v1 = [sc("s1", "Lamo waves.", caption="Hi!"), sc("s2", "Lamo jumps.", caption="Wow!")]
    a = [scene("s1", "park", [beat(0.3, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO]),
         scene("s2", "park", [beat(0.3, 1.0, "c1", "jump")], [piece("Lamo jumps.", (0,))], [LAMO])]  # fmt: skip
    p, script = check(v1, a, genders=G)
    assert p == [], why(p)
    v2 = copy.deepcopy(v1)
    v2[1]["caption"] = "So high!"
    own2 = own_script.scenes_of(v2)
    remake = {"scenes": [scene("s1", "park", [beat(0.4, 1.5, "c1", "wave")], [piece("Lamo waves.", (0,))], [LAMO])]}
    merged, _ = own_script.merged_take(script, remake, own2, ["s1"], genders=G)
    out = own_script.own_problems(remake, merged, own2, CASTMAP, places=PLACES, asked=["s1"], genders=G)
    cue = next(c for c in merged["captions"] if c["id"] == "w_s2")
    print("R15", why(out), cue)
    assert cue["text"] == "So high!" and not [x for x in out if not x.reading]


# === the fixer's own cases: faithful stagings still pass, and more slips are caught ==========================
@pytest.mark.parametrize(
    "what,beats",
    [
        ("Lamo doesn't see the ice and slips.", [beat(0.3, 1.2, "c1", "slip")]),
        ("Rosa doesn't notice Lamo fall.", [beat(0.3, 1.5, "c2", "look_left"), beat(0.5, 1.2, "c1", "fall")]),
        ("Before he dances, Lamo jumps.", [beat(0.3, 1.0, "c1", "jump"), beat(1.6, 1.5, "c1", "dance")]),
        ("After Lamo jumps, he dances.", [beat(0.3, 1.0, "c1", "jump"), beat(1.6, 1.5, "c1", "dance")]),
        ("Lamo trips. He falls.", [beat(0.3, 1.0, "c1", "slip"), beat(1.5, 1.2, "c1", "fall")]),
        ("Lamo jumps many times.", [beat(0.2 + i * 0.7, 0.6, "c1", "jump") for i in range(4)]),
        ("Lamo jumps fifteen times.", [beat(0.2 + i * 0.7, 0.6, "c1", "jump") for i in range(5)]),
        ("Lamo hugs Rosa.", [beat(0.3, 1.5, "c1", "gesture", face="happy"), beat(0.3, 1.5, "c2", "idle")]),
        (
            "If Lamo is sad, Rosa hugs him.",
            [beat(0.3, 1.5, "c2", "gesture", face="happy"), beat(0.3, 1.5, "c1", "idle")],
        ),
        ("Lamo laughs.", [beat(0.3, 1.5, "c1", "idle", face="laughing", noise="laugh")]),
        ("Lamo nods.", [beat(0.3, 1.5, "c1", "nod")]),
        (
            "Lamo sits down, then he gets up and runs away.",
            [
                beat(0.3, 1.0, "c1", "sit"),
                beat(1.5, 0.8, "c1", "get_up"),
                beat(2.5, 1.5, "c1", "run", to={"x": 0.9, "y": 0.72}),
            ],
        ),
        (
            "Lamo and Rosa walk home.",
            [
                beat(0.3, 2, "c1", "walk", to={"x": 0.6, "y": 0.72}),
                beat(0.3, 2, "c2", "walk", to={"x": 0.8, "y": 0.72}),
            ],
        ),
        ("Lamo and the dog jump.", [beat(0.3, 1.0, "c1", "jump")]),
        ("Rosa tells Lamo to jump, and he jumps.", [beat(0.3, 1, "c2", "point"), beat(1.5, 1.0, "c1", "jump")]),
        ("Lamo is scared of the dark.", [beat(0.3, 1.5, "c1", "cower", face="scared")]),
        (
            "Rosa shouts 'Lamo's going to fall!' and Lamo laughs.",
            [beat(0.3, 1, "c2", "point", face="worried"), beat(1.5, 1.5, "c1", "idle", face="laughing")],
        ),
        ("Lamo pushes Max and he cries.", None),
    ],
)
def test_fixer_faithful_stagings_still_pass(what: str, beats: Any) -> None:
    if beats is None:
        own = [sc("s1", what), TAIL_OWN]
        b = [beat(0.3, 1.0, "c1", "gesture"), beat(1.3, 1.5, "c2", "idle", face="sad", noise="sigh")]
        p, _s = check(
            own, [scene("s1", "park", b, [piece(what, (0, 1))], [LAMO, MAX]), tail()], cast=LAMO_MAX, genders=BOYS
        )
    else:
        p, _s = solo(what, beats)
    assert p == [], why(p)


@pytest.mark.parametrize(
    "what,beats",
    [
        ("Lamo doesn't even try to jump.", [beat(0.3, 1.0, "c1", "jump")]),
        ("Rosa doesn't let Lamo fall.", [beat(0.3, 1.5, "c2", "gesture"), beat(0.5, 1.2, "c1", "fall")]),
        ("Nobody falls.", [beat(0.3, 1.2, "c1", "fall")]),
        ("Lamo refuses to dance.", [beat(0.3, 1.2, "c1", "dance")]),
        ("Lamo trips. He falls.", [beat(0.3, 1.2, "c1", "fall")]),
        ("Lamo jumps many times.", [beat(0.3, 1.0, "c1", "jump")]),
        ("Lamo is happy.", [walk()]),
        ("Lamo and Rosa laugh.", [beat(0.3, 1.5, "c1", "idle", face="laughing"), beat(0.3, 1.5, "c2", "idle")]),
        ("Lamo walks home.", [beat(0.3, 1.5, "c1", "run", to={"x": 0.6, "y": 0.72})]),
        ("Lamo points at Rosa.", [beat(0.3, 1.5, "c1", "wave"), beat(0.3, 1.5, "c2", "idle")]),
        ("Lamo shrugs.", [beat(0.3, 1.5, "c1", "facepalm")]),
        ("Lamo jumps, then he jumps twice more.", [beat(0.3, 1.0, "c1", "jump")]),
        ("Lamo slips on a banana skin! He lands on his bum.", [beat(0.3, 1.2, "c1", "slip")]),
    ],
)
def test_fixer_more_slips_are_caught(what: str, beats: Any) -> None:
    p, s = solo(what, beats)
    assert p or note_of(s), f"{what!r} {beats}"


def test_fixer_car_words_and_a_driver_who_runs_out_of_petrol() -> None:
    assert plain_drive("Rosso drives into the car park.", "parking_lot")[0] == []
    assert plain_drive("Rosso drives to the shop quickly.")[0], "quickly after drives is speeding"
    assert plain_drive("Lamo quickly checks his mirror.")[0] == []
    # "Lamo runs out of petrol": no run for someone in the car, the stall is owed
    own = [sc("s1", "Lamo runs out of petrol.", who=("ch1", "ch3"), place="city_street"), TAIL_OWN]
    a = [
        scene(
            "s1",
            "city_street",
            [beat(0, 5, "c1", "drive"), beat(1, 2, "car1", "stall")],
            [piece("Lamo runs out of petrol.", (0, 1))],
            [DRIVER],
            props=[car()],
        ),
        tail(),
    ]
    assert one_car(own, a)[0] == [], why(one_car(own, a)[0])
    assert plain_drive("Lamo runs out of petrol.")[0]
    r = own_words.read("Lamo presses the brakes hard.", {"c1": "Lamo"})
    assert [m.family for m in r.mentions] == ["stop"]
    r = own_words.read("The brakes fail.", {"c1": "Lamo"})
    assert [m.family for m in r.mentions] == []


def test_fixer_someone_the_cast_does_not_have() -> None:
    p, s = solo("A dog jumps over Lamo.", [beat(0.3, 1.5, "c1", "gasp", face="surprised")])
    assert p == [] and "dog is not drawn" in note_of(s), (why(p), note_of(s))
    p, s = solo("Lamo's dog jumps.", [beat(0.3, 1.5, "c1", "point")])
    assert p == [] and "not drawn" in note_of(s), (why(p), note_of(s))
    p, s = solo("A man falls over in the park.", [beat(0.3, 1.5, "c1", "fall")])
    assert p, "the man's fall drawn as Lamo's"
