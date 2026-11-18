from __future__ import annotations

from pathlib import Path

from clipfactory_agent.checklist import (
    REVIEW_SCHEMA,
    Candidate,
    Measured,
    Outcome,
    check_all,
    critical_failure,
    frame_difference,
    judged_items,
    measured_items,
    parse_mean_volume,
    plan_fix,
    review_prompt,
)
from clipfactory_agent.render import RenderResult
from clipfactory_agent.schema import check

from .conftest import make_moment

LEN = (20.0, 45.0)
GOOD_REVIEW = {
    "zero_context": True,
    "zero_context_note": "Clear.",
    "pays_off": True,
    "pays_off_note": "Ends on it.",
    "hook_ok": True,
    "hook_note": "Good.",
    "new_hook": None,
    "move_start_by": 0,
    "move_end_by": 0,
    "verdict": "keep",
}


def render(duration: float = 30.0, captions: int = 5) -> RenderResult:
    return RenderResult(
        video=Path("clip.mp4"),
        cover=Path("cover.jpg"),
        duration=duration,
        segments=[(100, 130)],
        captions=[{"t0": i, "t1": i + 0.5, "text": "WORD"} for i in range(captions)],
        layout="blur_fill",
        tease=False,
    )


def test_review_schema_accepts_good_review() -> None:
    assert check(REVIEW_SCHEMA, GOOD_REVIEW) == []


def test_measured_items_pass_and_fail() -> None:
    m = make_moment()
    items = measured_items(m, render(), Measured(-20, 5.0), LEN)
    assert all(i.passed for i in items)
    items = measured_items(make_moment(hook="funny moment"), render(60, 0), Measured(-60, 0.1), LEN)
    failed = {i.key for i in items if not i.passed}
    assert failed == {"hear", "read", "moving", "length", "captions"}
    assert critical_failure(items) is not None
    assert {"key", "label", "pass", "note"} == set(items[0].public())


def test_plan_fix_opens_on_sound_and_applies_review() -> None:
    m = make_moment(start=100, end=130, peak_at=110)
    items = measured_items(m, render(), Measured(-60, 5), LEN) + judged_items(
        {**GOOD_REVIEW, "hook_ok": False, "new_hook": "nobody expected the plan to go this wrong", "move_end_by": -4}
    )
    fixed, fixes = plan_fix(
        m,
        items,
        {**GOOD_REVIEW, "hook_ok": False, "new_hook": "nobody expected the plan to go this wrong", "move_end_by": -4},
        length=LEN,
        first_loud=lambda t: t + 1.0,
    )
    assert fixed.start == 101 and fixed.end == 126
    assert fixed.hook == "nobody expected the plan to go this wrong"
    assert len(fixes) == 3


def test_plan_fix_nothing_to_do() -> None:
    m = make_moment()
    items = measured_items(m, render(), Measured(-20, 5), LEN) + judged_items(GOOD_REVIEW)
    fixed, fixes = plan_fix(m, items, GOOD_REVIEW, length=LEN, first_loud=lambda t: t)
    assert fixed is m and fixes == []


def test_plan_fix_clamps_moves() -> None:
    m = make_moment(start=100, end=130)
    review = {**GOOD_REVIEW, "pays_off": False, "move_start_by": 50, "move_end_by": -50}
    items = judged_items(review)
    fixed, _ = plan_fix(m, items, review, length=LEN, first_loud=lambda t: t)
    assert fixed.start == 108  # +8 at most
    assert fixed.end == fixed.start + 20  # -10 at most, then the minimum length


def test_parsers() -> None:
    assert parse_mean_volume("[Parsed_volumedetect_0 @ 0x] mean_volume: -23.4 dB") == -23.4
    assert parse_mean_volume("nothing") == -90
    assert frame_difference(bytes([0, 10, 20]), bytes([0, 20, 20])) == 10 / 3
    assert frame_difference(b"", b"") == 0


def test_review_prompt_mentions_hook_and_transcript() -> None:
    text = review_prompt(make_moment(), render(captions=1), "tag @me")
    assert "he thought he got away with it" in text and "[0.0s] WORD" in text and "tag @me" in text


async def test_check_all_replaces_failures_with_spares() -> None:
    a, b, c = (Candidate(make_moment(start=s, end=s + 30), render(), index=i) for i, s in enumerate((0, 100, 200)))
    spares = [make_moment(start=900, end=930), make_moment(start=1000, end=1030)]
    cut_calls: list[float] = []

    async def check(x: Candidate) -> Outcome:
        return Outcome(x.moment.start != 100, x, "bad" if x.moment.start == 100 else "")

    async def cut(m):  # type: ignore[no-untyped-def]
        cut_calls.append(m.start)
        return Candidate(m, render(), index=3)

    passed, failed = await check_all([a, b, c], spares, check=check, cut=cut, want=3)
    assert [p.moment.start for p in passed] == [0, 200, 900]
    assert len(failed) == 1 and cut_calls == [900]


async def test_check_all_skips_spares_that_cannot_be_cut() -> None:
    a = Candidate(make_moment(), render())

    async def check(x: Candidate) -> Outcome:
        return Outcome(x.moment.start == 1000, x)

    async def cut(m):  # type: ignore[no-untyped-def]
        return None if m.start == 900 else Candidate(m, render())

    passed, failed = await check_all(
        [a], [make_moment(start=900, end=930), make_moment(start=1000, end=1030)], check=check, cut=cut, want=1
    )
    assert [p.moment.start for p in passed] == [1000]
    assert len(failed) == 1


def test_review_prompt_gains_a_seen_block_only_when_something_was_seen() -> None:
    from clipfactory_agent.checklist import review_prompt as rp

    r = RenderResult(
        Path("c.mp4"), Path("c.jpg"), 30.0, [(100, 130)], [{"t0": 0.0, "t1": 1.0, "text": "no way"}], "full", False
    )
    m = make_moment()
    plain = rp(m, r, "notes")
    assert rp(m, r, "notes", seen="") == plain and "Seen" not in plain  # byte-identical without picture events
    seen = rp(m, r, "notes", seen="[5.0s] (seen) stunt 8/10, nobody talking: bike backflip")
    assert seen.startswith(plain) and seen.endswith("[5.0s] (seen) stunt 8/10, nobody talking: bike backflip")
    assert "Seen (machine-made picture notes" in seen


def test_captions_item_passes_when_the_clip_has_no_speech() -> None:
    from clipfactory_agent.checklist import Measured as Me
    from clipfactory_agent.checklist import measured_items as mi

    r = RenderResult(Path("c.mp4"), Path("c.jpg"), 30.0, [(100, 130)], [], "full", False)
    m = make_moment()

    def item(**kw: bool) -> object:
        return next(i for i in mi(m, r, Me(-10.0, 5.0), (20, 45), **kw) if i.key == "captions")

    assert item().passed is False and item(has_speech=True).passed is False  # today: speech but no captions fails
    silent = item(has_speech=False)
    assert silent.passed is True and silent.note == "No speech to caption."  # type: ignore[attr-defined]
