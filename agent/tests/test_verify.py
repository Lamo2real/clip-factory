"""The second look (ADR-40): small timing moves only, everything validated again, weak moments swapped for good
spares, never fewer than the minimum, and any failure keeps the moment as picked."""

from __future__ import annotations

from typing import Any

from clipfactory_agent import verify
from clipfactory_agent.bedrock import Bedrock
from clipfactory_agent.schema import check
from clipfactory_agent.util import TransientError

from .conftest import make_moment
from .deep_support import FakeFrames, ToolClient, block, client_error, make_picture, no_cancel

LENGTH = (20.0, 45.0)


def answer(m: Any, **kw: Any) -> dict[str, Any]:
    base = {
        "keep": True,
        "start": m.start,
        "end": m.end,
        "payoff_at": m.payoff_at,
        "peak_at": m.peak_at,
        "hook_ok": True,
        "new_hook": None,
        "picture_score": 7,
        "seen": "a car chase",
    }
    base.update(kw)
    return base


def fix(m: Any, **kw: Any) -> Any:
    return verify.apply(m, answer(m, **kw), duration=4000, length=LENGTH)


def test_schema() -> None:
    m = make_moment()
    assert check(verify.VERIFY_SCHEMA, answer(m)) == []
    assert check(verify.VERIFY_SCHEMA, {**answer(m), "extra": 1})
    assert check(verify.VERIFY_SCHEMA, {"keep": True})


def test_time_moves_are_accepted_only_within_five_seconds() -> None:
    m = make_moment()  # 100..130, payoff 128, peak 120
    near = fix(m, start=103, end=126, payoff_at=125, peak_at=110)
    assert (near.start, near.end, near.payoff_at, near.peak_at) == (103, 126, 125, 110)
    far = fix(m, start=90, end=140)
    assert (far.start, far.end) == (100, 130)  # each ignored: more than 5 s away
    mixed = fix(m, start=104.9, end=200)
    assert (mixed.start, mixed.end) == (104.9, 130)
    assert fix(m, start="soon", end=None).start == 100


def test_the_result_is_validated_again() -> None:
    m = make_moment()
    assert (
        fix(m, hook_ok=False, new_hook="nobody expected the bridge to break").hook
        == "nobody expected the bridge to break"
    )
    assert fix(m, hook_ok=False, new_hook="bad").hook == m.hook  # a 1-word hook is refused: the old one stays
    assert fix(m, hook_ok=True, new_hook="nobody expected the bridge to break").hook == m.hook
    moved = fix(m, end=125, payoff_at=128)  # the payoff would fall outside the new end
    assert moved.end == 125 and moved.start <= moved.payoff_at <= 125.5
    short = make_moment(start=100, end=121, payoff_at=120, peak_at=110)
    clamped = fix(short, start=104)  # 17 s is under the 20 s minimum: validate stretches it back
    assert clamped.end - clamped.start == 20
    assert fix(make_moment(picked_for="Big crash")).picked_for == "Big crash"
    tease = fix(make_moment(tease=(126, 128)), start=102)
    assert tease.tease == (126, 128)


def moments() -> tuple[list[Any], list[Any]]:
    chosen = [
        make_moment(start=100 + 100 * i, end=130 + 100 * i, payoff_at=128 + 100 * i, peak_at=120 + 100 * i)
        for i in range(3)
    ]
    spares = [
        make_moment(start=1000 + 100 * i, end=1030 + 100 * i, payoff_at=1028 + 100 * i, peak_at=1020 + 100 * i)
        for i in range(2)
    ]
    return chosen, spares


def settle(answers: list[Any], clip_min: int = 2) -> tuple[list[Any], list[Any], list[dict[str, Any]]]:
    chosen, spares = moments()
    return verify.settle(chosen, spares, answers, duration=4000, length=LENGTH, clip_min=clip_min)


def test_a_weak_moment_is_swapped_for_the_best_verified_spare() -> None:
    chosen, spares = moments()
    answers = [
        answer(chosen[0]),
        answer(chosen[1], keep=False, seen="a loading screen"),
        answer(chosen[2]),
        answer(spares[0], keep=False),  # this spare does not hold up either
        answer(spares[1], start=1103),
    ]
    out, left, report = settle(answers)
    assert [m.start for m in out] == [100, 1103, 300]  # swapped in place, with the spare's own fix applied
    assert left == []
    assert [r["result"] for r in report] == ["dropped", "kept", "kept", "swapped for a spare", "kept"]
    assert report[3]["seen"] == "a loading screen" and report[1]["changed"]["start"] == 1103


def test_never_fewer_than_clip_min() -> None:
    chosen, spares = moments()
    bad = [answer(m, keep=False) for m in chosen] + [answer(s, keep=False) for s in spares]
    out, left, report = settle(bad, clip_min=2)
    assert [m.start for m in out] == [200, 300] and left == []  # one dropped, then the floor holds
    assert [r["result"] for r in report[2:]] == ["dropped", "kept (no spare left)", "kept (no spare left)"]
    out, _, _ = settle(bad, clip_min=3)
    assert len(out) == 3
    out, _, _ = settle(bad, clip_min=1)
    assert len(out) == 1


def test_a_failed_look_keeps_the_moment_and_an_unchecked_spare_is_never_swapped_in() -> None:
    chosen, spares = moments()
    out, left, report = settle([None, answer(chosen[1], keep=False), None, None, None], clip_min=3)
    assert out == chosen  # nothing verified to swap in, and the floor is 3
    assert left == spares  # unchecked spares stay spares
    assert report[2]["result"] == "not checked" and "keep" not in report[2]
    out, left, _ = settle([None] * 5)
    assert out == chosen and left == spares


async def look(client: Any, **kw: Any) -> tuple[list[Any], list[Any], list[dict[str, Any]], FakeFrames]:
    chosen, spares = moments()
    frames = kw.pop("frames", None) or FakeFrames(make_picture(4000))
    b = Bedrock("m", "r", client=client)
    b.forced_tool_choice = False
    out = await verify.second_look(
        chosen,
        spares,
        bedrock=b,
        skills=block(),
        frames=frames,
        words=[[110.0, 110.4, "watch"], [110.5, 110.9, "this"]],
        speakers=None,
        duration=4000,
        length=LENGTH,
        clip_min=2,
        check_cancel=no_cancel,
        **kw,
    )
    return (*out, frames)


async def test_second_look_sends_every_frame_around_the_moment_and_the_words() -> None:
    def reply(kw: dict[str, Any]) -> dict[str, Any]:
        text = kw["messages"][0]["content"][-2]["text"]
        start = float(text.split("start: ")[1].split(" s")[0])
        return answer(
            make_moment(start=start, end=start + 30, payoff_at=start + 28, peak_at=start + 20), start=start + 2
        )

    client = ToolClient({"check_moment": reply})
    out, left, report, frames = await look(client)
    assert len(client.requests) == 5 and (97.0, 133.0) in frames.asked
    first = next(q for q in client.requests if "start: 100 s" in q["messages"][0]["content"][-2]["text"])
    content = first["messages"][0]["content"]
    assert sum(1 for c in content if "image" in c) == 72  # 36 s at two frames a second
    assert content[0] == {"text": "[0:01:37] 97 s"} and "[0:01:50] watch this" in content[-2]["text"]
    assert (
        first["system"][0]["text"].startswith("<owner_skills") and "check one picked clip" in first["system"][1]["text"]
    )
    assert [m.start for m in out] == [102, 202, 302] and [m.start for m in left] == [1002, 1102]
    assert all(r["result"] == "kept" for r in report)


async def test_any_failure_keeps_the_moment_as_picked(monkeypatch: Any) -> None:
    chosen, spares = moments()

    async def boom(self: Any, **kw: Any) -> dict[str, Any]:
        raise TransientError("throttled")

    monkeypatch.setattr(Bedrock, "structured", boom)
    out, left, report, _ = await look(ToolClient())
    assert out == chosen and left == spares and all(r["result"] == "not checked" for r in report)
    monkeypatch.undo()
    out, left, _, _ = await look(ToolClient())  # no usable answer (ModelError)
    assert out == chosen and left == spares
    frames = FakeFrames(make_picture(4000))
    frames.fail = OSError("part missing")
    client = ToolClient({"check_moment": lambda kw: answer(chosen[0], keep=False)})
    out, left, _, _ = await look(client, frames=frames)
    assert out == chosen and client.requests == []


async def test_the_deadline_keeps_what_was_not_checked() -> None:
    client = ToolClient({"check_moment": lambda kw: answer(make_moment(), keep=False)})
    chosen, spares = moments()
    out, left, _report, _ = await look(client, deadline_seconds=0)
    assert out == chosen and left == spares and client.requests == []


async def test_too_many_images_thins_the_frames_and_later_looks_start_thin() -> None:
    sizes: list[int] = []

    def reply(kw: dict[str, Any]) -> dict[str, Any]:
        n = sum(1 for c in kw["messages"][0]["content"] if "image" in c)
        sizes.append(n)
        if n > 20:
            raise client_error("ValidationException", "You can include up to 20 images.")
        text = kw["messages"][0]["content"][-2]["text"]
        start = float(text.split("start: ")[1].split(" s")[0])
        return answer(make_moment(start=start, end=start + 30, payoff_at=start + 28, peak_at=start + 20))

    client = ToolClient({"check_moment": reply})
    _out, _left, report, _ = await look(client)
    assert all(r["result"] == "kept" for r in report)
    assert max(n for n in sizes if n <= 20) == 20
    assert len([n for n in sizes if n > 20]) <= verify.VERIFY_CONCURRENCY  # only the looks already in flight
    first = next(q for q in client.requests if "start: 100 s" in q["messages"][0]["content"][-2]["text"])
    stamps = [c["text"] for c in first["messages"][0]["content"] if "text" in c and c["text"].startswith("[")]
    assert stamps[0] == "[0:01:37] 97 s" and stamps[-1] == "[0:02:12] 132.5 s"  # thinned evenly, both ends kept


async def test_a_tripped_second_look_budget_keeps_the_picks(monkeypatch: Any) -> None:
    from clipfactory_agent import guard

    monkeypatch.setattr(verify, "second_look_budget", lambda n: guard.CallBudget("second_look", 2))
    chosen, _spares = moments()
    client = ToolClient({"check_moment": lambda kw: answer(chosen[0], keep=False)})
    out, _left, report, _ = await look(client)
    assert len(client.requests) == 2
    assert sum(1 for r in report if r["result"] == "not checked") == 3
    assert len(out) >= 2  # never below clip_min
