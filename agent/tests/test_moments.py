from __future__ import annotations

from clipfactory_agent.moments import Moment, choose, dedupe, length_target, spare_count, validate
from clipfactory_agent.transcript import lines, windows

from .conftest import make_moment, raw_moment

LEN = (20.0, 45.0)


def test_validate_accepts_and_normalises() -> None:
    m, problems = validate(raw_moment(hook="  the plan was   simple until this happened "), duration=3600, length=LEN)
    assert problems == []
    assert m is not None
    assert m.hook == "the plan was simple until this happened"
    assert m.length == 30
    assert m.people == ["Sam"]


def test_validate_clamps_long_and_short_clips() -> None:
    m, _ = validate(raw_moment(start=100, end=200, payoff_at=140), duration=3600, length=LEN)
    assert m is not None and m.end == 145
    m, _ = validate(raw_moment(start=100, end=105, payoff_at=104), duration=3600, length=LEN)
    assert m is not None and m.end == 120


def test_validate_rejects_payoff_cut_off_by_clamp() -> None:
    m, problems = validate(raw_moment(start=100, end=200, payoff_at=190), duration=3600, length=LEN)
    assert m is None and "payoff_at" in problems[0]


def test_validate_rejects_bad_answers() -> None:
    assert validate(raw_moment(needs_context=True), duration=3600, length=LEN)[0] is None
    assert validate(raw_moment(hook="funny moment"), duration=3600, length=LEN)[0] is None
    assert validate(raw_moment(moment_type="cute"), duration=3600, length=LEN)[0] is None
    assert validate(raw_moment(start=4000, end=4030), duration=3600, length=LEN)[0] is None
    assert validate({"start": 1}, duration=3600, length=LEN)[0] is None


def test_validate_clamps_score_tease_and_peak() -> None:
    m, _ = validate(raw_moment(score=14, tease_start=127, tease_end=128.5, peak_at=999), duration=3600, length=LEN)
    assert m is not None
    assert m.score == 10
    assert m.tease == (127, 128.5)
    assert m.peak_at == 128  # outside the clip: the payoff stands in
    m, _ = validate(raw_moment(tease_start=10, tease_end=11), duration=3600, length=LEN)
    assert m is not None and m.tease is None  # a tease must come from inside the clip


def test_validate_end_of_video() -> None:
    m, _ = validate(raw_moment(start=3570, end=3600, payoff_at=3590, peak_at=3590), duration=3595, length=LEN)
    assert m is not None and m.end == 3595


def test_length_target_from_notes() -> None:
    assert length_target(None) == (20, 45)
    assert length_target("Keep clips 15-30 seconds please") == (15, 30)
    assert length_target("clips under 30 s") == (18, 30)
    assert length_target("max 60 seconds") == (20, 60)
    assert length_target("1-2 s") == (20, 45)


def test_dedupe_keeps_higher_score() -> None:
    a = make_moment(start=100, end=130, score=6)
    b = make_moment(start=120, end=150, score=8)
    c = make_moment(start=200, end=230, score=5)
    assert dedupe([a, b, c]) == [b, c]


def test_choose_counts_and_spares() -> None:
    pool = [make_moment(start=i * 100, end=i * 100 + 30, score=9 - i * 0.5, moment_type="rage") for i in range(12)]
    chosen, spares = choose(pool, 3, 5)
    assert len(chosen) == 5  # 7 score >= 6, capped at max
    assert len(spares) == spare_count(5) == 3
    chosen, spares = choose(pool[-3:], 5, 10)
    assert len(chosen) == 3 and spares == []  # fewer exist than the minimum


def test_choose_prefers_variety() -> None:
    a = make_moment(start=0, end=30, score=9, moment_type="rage")
    b = make_moment(start=100, end=130, score=8.6, moment_type="rage")
    c = make_moment(start=200, end=230, score=8.5, moment_type="chaos")
    chosen, _ = choose([a, b, c], 2, 2)
    assert [m.moment_type for m in chosen] == ["rage", "chaos"]


def test_moment_roundtrip() -> None:
    m = make_moment(tease=(120.0, 121.5), people=["A"])
    assert Moment.from_dict(m.to_dict()) == m


def test_transcript_lines_and_windows() -> None:
    words = [[0.5, 0.8, "Hello"], [1.0, 1.2, "there."], [6.0, 6.3, "Next"], [20, 20.4, "Later"], [4000, 4001, "far"]]
    text = lines(words, 0, 60)
    assert text.splitlines() == ["[0:00:00] Hello there.", "[0:00:06] Next", "[0:00:20] Later"]
    assert windows(3700) == [(0, 1860), (1800, 3660), (3600, 3700)]
    assert windows(0) == []
