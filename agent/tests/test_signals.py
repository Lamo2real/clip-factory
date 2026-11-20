"""The merged signals (ADR-40): events from two watchers, hot spots from any subset of tracks, the picture lines the
finder reads, and the plain words that say why a clip was picked."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from clipfactory_agent import signals
from clipfactory_agent.signals import Event, Signals, build, hot_spots, make_visual_log, merge_events, picked_for

from .conftest import make_moment


def ev(t0: float, t1: float, kind: str = "crash", intensity: int = 8, **kw: Any) -> dict[str, Any]:
    return {"t0": t0, "t1": t1, "kind": kind, "what": kw.pop("what", "car flips"), "intensity": intensity, **kw}


def chunk(i: int, events: list[dict[str, Any]], size: float = 150) -> dict[str, Any]:
    return {"i": i, "start": i * size, "end": (i + 1) * size, "ok": True, "scene": "", "events": events}


def quiet(n: int = 1200) -> list[float]:
    return [-40.0] * n


def still(n: int = 1200) -> list[float]:
    return [0.01] * n


# --- merging the two watchers ----------------------------------------------------------------------------------


def test_same_kind_within_three_seconds_becomes_one_event_with_both_sources() -> None:
    out = merge_events(
        [ev(100, 104, intensity=7, what="fable words", face="shocked")],
        [ev(106, 110, intensity=9, what="nova words")],
    )
    assert len(out) == 1
    e = out[0]
    assert (e.t0, e.t1, e.intensity, e.what, e.src) == (100, 110, 9, "nova words", ["fable", "nova"])
    assert e.face == "shocked"  # kept from the watcher that saw a face


def test_different_kinds_or_far_apart_stay_separate() -> None:
    out = merge_events([ev(100, 104), ev(100, 104, kind="stunt")], [ev(108, 110), ev(300, 302)])
    assert [(e.kind, e.t0, e.src) for e in out] == [
        ("crash", 100, ["fable"]),
        ("stunt", 100, ["fable"]),
        ("crash", 108, ["nova"]),
        ("crash", 300, ["nova"]),
    ]


def test_overlapping_chunks_do_not_double_an_event() -> None:
    out = merge_events([ev(146, 152), ev(147, 151, intensity=6)], [])
    assert len(out) == 1 and out[0].src == ["fable"] and out[0].intensity == 8


def test_visual_log_coverage_and_failed() -> None:
    log = make_visual_log(
        [chunk(0, [ev(10, 12)]), chunk(1, [])],
        [{**chunk(1, [ev(400, 410)], size=300)}],
        [{"start": 300, "end": 450, "src": "fable", "reason": "busy"}],
    )
    assert log["version"] == 1
    assert log["coverage"] == [[0, 600]] and log["fable"] == [[0, 300]] and log["nova"] == [[300, 600]]
    assert log["failed"][0]["reason"] == "busy" and len(log["events"]) == 2
    # Fable lost a chunk to a busy service: even though Nova covered it, a Try again watches once more.
    assert not signals.log_covers(log, 620)
    log["failed"][0]["reason"] = "refused"  # refused for good: watching again would not help
    assert signals.log_covers(log, 620) and not signals.log_covers(log, 700) and not signals.log_covers(None, 10)
    log["failed"] = [{"start": 300, "end": 450, "src": "nova", "reason": "busy"}]
    assert signals.log_covers(log, 620)  # only Fable's losses count
    assert signals.covered_span(log["coverage"], 450, 600) and not signals.covered_span(log["coverage"], 550, 700)


# --- hot spots ---------------------------------------------------------------------------------------------------


def spots(**kw: Any) -> list[signals.HotSpot]:
    args: dict[str, Any] = {"words": [], "loud": quiet(), "motion": still(), "heatmap": []}
    args.update(kw)
    return hot_spots(args.pop("events", []), **args)


def test_no_tracks_no_hot_spots() -> None:
    assert spots() == []
    assert build(duration=1200, words=[], loud=quiet(), heatmap=[], speakers=None, visual_log=None, motion=None) is None
    assert build(duration=1200, words=[], loud=quiet(), heatmap=[], speakers=None, visual_log=None, motion=[]) is None


def test_each_track_alone_makes_a_hot_spot() -> None:
    loud = quiet()
    loud[500] = -10.0
    assert [(h.t, h.sources, h.reasons) for h in spots(loud=loud)] == [(500, ["loud"], ["loud"])]
    motion = still()
    motion[700] = 0.2
    assert [(h.t, h.sources) for h in spots(motion=motion)] == [(700, ["motion"])]
    seen = spots(events=[Event(300, 305, "crash", "x", 8, src=["fable"])])
    assert [(h.t, h.score, h.reasons) for h in seen] == [(300, 2.4, ["seen"])]
    nova = spots(events=[Event(300, 305, "crash", "x", 8, src=["nova"])])
    assert nova[0].score == 1.6  # Nova weighs 2, Fable 3
    assert spots(heatmap=[{"start": 900, "end": 920, "value": 1.0}])[0].sources == ["replayed"]


def test_weak_and_calm_events_are_not_hot_spots() -> None:
    assert spots(events=[Event(300, 305, "other", "x", 3, src=["fable"])]) == []  # 0.9 < 1
    assert spots(events=[Event(300, 305, "calm", "x", 9, src=["fable"])]) == []


def test_agreeing_sources_add_up_and_get_a_bonus() -> None:
    loud = quiet()
    loud[302] = -10.0  # +30 dB: capped at 2
    motion = still()
    motion[303] = 0.2  # x20: capped at 2
    both = spots(events=[Event(300, 305, "crash", "x", 10, src=["fable", "nova"])], loud=loud, motion=motion)
    assert len(both) == 1
    h = both[0]
    assert h.score == pytest.approx(3 + 2 + 2 + 2 + 1)  # fable + nova + loud + motion + the agreement bonus
    assert h.sources[0] == "fable" and set(h.sources) == {"fable", "nova", "loud", "motion"}
    assert h.reasons == ["seen", "loud", "fast picture"]
    alone = spots(events=[Event(300, 305, "crash", "x", 10, src=["fable"])])
    assert alone[0].score == 3.0  # one source: no bonus


def test_sources_further_than_four_seconds_apart_do_not_add_up_but_merge_within_eight() -> None:
    loud = quiet()
    loud[307] = -10.0
    far = spots(events=[Event(300, 301, "crash", "x", 10, src=["fable"])], loud=loud)
    assert len(far) == 1 and far[0].score == 3.0 and far[0].t == 300  # merged (7 s), not summed
    assert far[0].sources == ["fable", "loud"]
    loud2 = quiet()
    loud2[320] = -10.0
    assert len(spots(events=[Event(300, 301, "crash", "x", 10, src=["fable"])], loud=loud2)) == 2


def test_silent_means_no_word_within_five_seconds() -> None:
    e = [Event(300, 302, "crash", "x", 9, src=["fable"]), Event(600, 602, "stunt", "x", 9, src=["fable"])]
    words = [[296.0, 296.4, "whoa"], [700.0, 700.3, "ok"]]
    out = spots(events=e, words=words)
    assert [(h.t, h.silent) for h in out] == [(300, False), (600, True)]


def test_build_decides_silence_from_the_words_and_reports_coverage() -> None:
    log = make_visual_log(
        [chunk(0, [ev(100, 104, silent=True), ev(140, 142, silent=False)])], [chunk(0, [], size=300)], []
    )
    s = build(
        duration=600,
        words=[[101.0, 101.5, "no"]],
        loud=quiet(600),
        heatmap=[],
        speakers=[[101.0, 102.0, "S1"]],
        visual_log=log,
        motion=still(600),
    )
    assert s is not None
    assert [e.silent for e in s.events] == [False, True]  # the model's guess is overruled by the words
    assert s.coverage == {"picture": 0.5, "fable": 0.25, "nova": 0.5, "motion": 1.0, "speakers": 1.0}
    assert s.watched and s.coverage_percent == 50
    assert s.strong_in(0, 150) and not s.strong_in(150, 600)
    assert s.to_json()["version"] == 1 and s.to_json()["hotspots"][0]["sources"] == ["fable"]


def test_motion_alone_is_a_signal_but_not_watched() -> None:
    motion = still(600)
    motion[300] = 0.3
    s = build(duration=600, words=[], loud=quiet(600), heatmap=[], speakers=None, visual_log=None, motion=motion)
    assert s is not None and not s.watched and s.coverage_percent == 0
    assert s.hotspots[0].t == 300 and s.hotspots[0].silent and s.strong_in(0, 600)


# --- what the finder reads -----------------------------------------------------------------------------------------


def brief(sig: Signals | None, words: list[list[Any]] | None = None, speakers: Any = None) -> Any:
    return SimpleNamespace(words=words or [], speakers=speakers, signals=sig)


def test_timeline_interleaves_picture_lines_in_time_order() -> None:
    sig = Signals(
        duration=4000,
        events=[
            Event(3731, 3736, "crash", "car flips off the bridge into the river", 9, True, "shocked", "", ["fable"]),
            Event(3740, 3741, "on_screen_text", "big red letters", 5, False, "calm", "WASTED", ["nova"]),
        ],
    )
    words = [[3733.0, 3733.3, "no"], [3733.4, 3733.7, "way"], [3733.8, 3734.0, "no"], [3734.1, 3734.4, "way"]]
    text = signals.timeline(brief(sig, words, [[3733.0, 3735.0, "S1"]]), 3600, 3800)
    assert text.splitlines() == [
        "[1:02:11] (seen) crash 9/10, nobody talking: car flips off the bridge into the river | face: shocked",
        "[1:02:13] S1: no way no way",
        '[1:02:20] (seen) on screen text 5/10: big red letters | on screen: "WASTED"',
    ]
    assert signals.timeline(brief(None, words), 3600, 3800) == "[1:02:13] no way no way"
    assert signals.timeline(brief(None), 0, 10) == ""


def test_timeline_shows_the_strongest_120_and_counts_the_rest() -> None:
    events = [Event(float(i), i + 1.0, "stunt", f"e{i}", 9 if i < 120 else 2, src=["fable"]) for i in range(150)]
    lines = signals.timeline(brief(Signals(duration=600, events=events)), 0, 600).splitlines()
    assert len(lines) == 121 and lines[-1] == "(+30 weaker picture notes not shown)"
    assert all("9/10" in ln for ln in lines[:-1])


def test_extra_hints_lists_fast_picture_and_hot_spots_with_a_cap() -> None:
    motion = still(4000)
    motion[3731] = 0.2
    loud = quiet(4000)
    loud[3731] = -10.0
    events = [Event(3731, 3735, "crash", "x", 9, src=["fable"])]
    sig = Signals(
        duration=4000,
        events=events,
        motion=motion,
        hotspots=hot_spots(events, words=[[3700.0, 3700.2, "hi"]], loud=loud, motion=motion, heatmap=[]),
    )
    assert signals.extra_hints(brief(sig), 3600, 3900).splitlines() == [
        "Fast picture: 1:02:11 (x20)",
        "Hot spots: 1:02:11 (seen + loud + fast picture, nobody talking)",
    ]
    assert signals.extra_hints(brief(sig), 0, 600) == ""
    assert signals.extra_hints(brief(None), 0, 600) == ""
    many = Signals(
        duration=4000, hotspots=[signals.HotSpot(i * 10.0, 1 + i / 100, False, ["loud"], ["loud"]) for i in range(40)]
    )
    line = signals.extra_hints(brief(many), 0, 600)
    assert line.count("(loud)") == signals.MAX_HOTSPOTS == 25 and line.endswith("(+15 weaker ones)")


def test_seen_block_is_relative_to_the_clip() -> None:
    sig = Signals(duration=600, events=[Event(105, 108, "stunt", "bike backflip", 8, True, src=["fable"])])
    assert signals.seen_block(sig, 100, 130) == "[5.0s] (seen) stunt 8/10, nobody talking: bike backflip"
    assert signals.seen_block(sig, 200, 230) == "" and signals.seen_block(None, 100, 130) == ""


# --- why a clip was picked -----------------------------------------------------------------------------------------


def why(events: list[Event] | None = None, **kw: Any) -> str | None:
    sig = Signals(duration=600, events=events or [], motion=kw.pop("motion", still(600)))
    args: dict[str, Any] = {"signals": sig, "loud": quiet(600), "heatmap": [], "speakers": None}
    args.update(kw)
    return picked_for(make_moment(start=100, end=130), **args)


@pytest.mark.parametrize(
    ("kind", "words"),
    [
        ("crash", "Big crash"),
        ("explosion", "Big boom"),
        ("chase", "Wild chase"),
        ("stunt", "Cool stunt"),
        ("fight", "Big fight"),
        ("fail", "Big fail"),
        ("death_screen", "Big fail"),
        ("win", "Big win"),
        ("glitch", "Weird glitch"),
        ("jump_scare", "Jump scare"),
        ("face_reaction", "Big reaction"),
    ],
)
def test_picked_for_names_what_was_seen(kind: str, words: str) -> None:
    assert why([Event(110, 114, kind, "x", 8, src=["fable"])]) == words


def test_picked_for_other_evidence() -> None:
    loud = quiet(600)
    loud[110] = -10.0
    assert why(loud=loud) == "Loud moment"
    laughing = [Event(109, 112, "funny_visual", "x", 6, face="laughing", src=["fable"])]
    assert why(laughing, loud=loud) == "Loud laugh"  # not "Loud laugh + Big reaction": the laugh is the reaction
    motion = still(600)
    motion[115] = 0.2
    assert why(motion=motion) == "Fast action"
    assert why(heatmap=[{"start": 120, "end": 140, "value": 1.0}]) == "People rewatch this"
    talk = [[100, 104, "S1"], [104, 108, "S2"], [108, 112, "S1"], [112, 116, "S2"]]
    assert why(speakers=talk) == "Back and forth"
    assert why(speakers=[[100, 130, "S1"]]) is None
    assert why([Event(110, 112, "other", "x", 8, face="shocked", src=["nova"])]) == "Big reaction"
    assert why([Event(110, 112, "calm", "x", 9, src=["fable"])]) is None
    assert why([Event(110, 112, "crash", "x", 3, src=["fable"])]) is None  # too weak to name
    assert why([Event(300, 302, "crash", "x", 9, src=["fable"])]) is None  # outside the clip


def test_picked_for_joins_the_top_two_and_stays_short() -> None:
    loud = quiet(600)
    loud[110] = -10.0
    motion = still(600)
    motion[115] = 0.2
    laughing = [Event(109, 112, "funny_visual", "x", 6, face="laughing", src=["fable"])]
    assert why(laughing, loud=loud, motion=motion) == "Loud laugh + Fast action"
    top = why([Event(110, 114, "crash", "x", 10, src=["fable", "nova"])], loud=loud, motion=motion)
    assert top is not None and top.startswith("Big crash + ") and len(top) <= signals.MAX_PICKED_FOR
    every = [
        *signals.KIND_WORDS.values(),
        signals.LOUD_LAUGH,
        signals.LOUD,
        signals.FAST,
        signals.REWATCH,
        signals.TALK,
    ]
    assert max(len(a) + 3 + len(b) for a in every for b in every if a != b) <= signals.MAX_PICKED_FOR


def test_picked_for_works_without_any_picture() -> None:
    loud = quiet(600)
    loud[110] = -10.0
    assert (
        picked_for(make_moment(start=100, end=130), signals=None, loud=loud, heatmap=[], speakers=None) == "Loud moment"
    )
    assert picked_for(make_moment(start=100, end=130), signals=None, loud=quiet(600), heatmap=[], speakers=None) is None


# --- chat hype (docs/CONTRACTS.md §37) ----------------------------------------------------------------------------

from clipfactory_agent.chat import ChatSignal, ChatSpike  # noqa: E402


def cspike(t: float, **kw: Any) -> ChatSpike:
    base: dict[str, Any] = {"t": t, "onset": t + 5, "peak": t + 9, "z": 9.0, "lift": 6.0, "strength": 2.4}
    base.update(kw)
    return ChatSpike(window=(t - 5, t + 3), **base)


def crowd(*spikes: ChatSpike) -> ChatSignal:
    return ChatSignal("twitch", 1.0, 1000, 5, [], list(spikes))


def test_chat_with_loud_scores_higher_and_says_chat_went_wild() -> None:
    loud = quiet()
    loud[500] = -10.0
    alone = hot_spots([], words=[], loud=loud, motion=still(), heatmap=[])
    both = hot_spots([], words=[], loud=loud, motion=still(), heatmap=[], chat=crowd(cspike(502)))
    assert len(alone) == len(both) == 1
    assert both[0].score > alone[0].score + 2  # chat's own weight plus the bonus for two sources
    assert sorted(both[0].reasons) == ["chat went wild", "loud"]


def test_a_flagged_chat_spike_adds_no_hot_spot_and_no_reason() -> None:
    flagged = crowd(cspike(502, flag="raid", strength=0.7))
    assert hot_spots([], words=[], loud=quiet(), motion=still(), heatmap=[], chat=flagged) == []
    m = make_moment(start=495, end=530)
    assert picked_for(m, signals=None, loud=quiet(), heatmap=[], speakers=None, chat=flagged) is None


def test_picked_for_says_chat_went_wild_when_the_moment_is_inside() -> None:
    loud = quiet(600)
    loud[112] = -10.0
    m = make_moment(start=100, end=130)
    # the burst comes after the clip ends (t + 5 = 133), but the moment it points to is inside
    text = picked_for(m, signals=None, loud=loud, heatmap=[], speakers=None, chat=crowd(cspike(128)))
    assert text is not None and sorted(text.split(" + ")) == ["Chat went wild", "Loud moment"]
    assert picked_for(m, signals=None, loud=quiet(600), heatmap=[], speakers=None, chat=crowd(cspike(200))) is None


def test_chat_went_wild_with_a_loud_laugh_fits() -> None:
    assert len("Chat went wild + Loud laugh") <= signals.MAX_PICKED_FOR
    assert signals.SOURCE_WORDS["chat"] == "chat went wild" and signals.CHAT == "Chat went wild"
