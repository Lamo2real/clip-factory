"""The second watcher, Nova 2 Lite on video (ADR-40): what it is sent, the time offset, and every way it can be
missing without anything else changing."""

from __future__ import annotations

from typing import Any

from clipfactory_agent import guard, nova, watch
from clipfactory_agent.bedrock import Bedrock
from clipfactory_agent.guard import Deadline
from clipfactory_agent.picture import Part
from clipfactory_agent.util import TransientError

from .deep_support import ToolClient, block, client_error, event, make_picture, no_cancel

VIDEO = b"\x00\x00\x00\x18ftypmp42-video"


async def run(client: Any, seconds: float = 900, video: bytes = VIDEO, **kw: Any) -> Any:
    pic = make_picture(seconds)

    async def read(part: Part) -> bytes:
        return video

    b = Bedrock("eu.amazon.nova-2-lite-v1:0", "eu-north-1", client=client, cache_points=False) if client else None
    return await nova.watch_parts(
        pic.parts,
        bedrock=b,
        skills=block(),
        read=read,
        budget=kw.pop("budget", guard.nova_budget(len(pic.parts))),
        deadline=Deadline(60),
        check_cancel=no_cancel,
        **kw,
    )


async def test_a_part_goes_as_one_video_block_with_its_start_time() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "x", "events": [event(12, 20, kind="stunt")]}})
    r = await run(client)
    assert r.status == {"status": "ok"} and len(client.requests) == 3
    req = next(q for q in client.requests if "starts at 0:05:00" in q["messages"][0]["content"][1]["text"])
    assert req["modelId"] == "eu.amazon.nova-2-lite-v1:0"
    assert req["messages"][0]["content"][0] == {"video": {"format": "mp4", "source": {"bytes": VIDEO}}}
    assert "0 to 300" in req["messages"][0]["content"][1]["text"]
    # no cache point (Nova's cache is smaller than the skills block), and the skills block still goes first
    assert [list(p) for p in req["system"]] == [["text"], ["text"]]
    assert req["system"][0]["text"].startswith("<owner_skills") and "one video" in req["system"][1]["text"]


async def test_times_are_shifted_by_the_part_start_and_clamped() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "x", "events": [event(12, 20), event(290, 400)]}})
    r = await run(client)
    assert [(e["t0"], e["t1"]) for e in r.done[1]["events"]] == [(312, 320), (590, 600)]
    assert r.done[2]["start"] == 600 and r.done[2]["end"] == 900


async def test_skipped_entirely_without_a_watch_model() -> None:
    r = await run(None)
    assert r.units == [] and r.done == {} and r.status["status"] == "skipped"


async def test_denied_or_missing_model_stops_the_track_at_once() -> None:
    for code, why in (("AccessDeniedException", "denied"), ("ResourceNotFoundException", "not_found")):

        def refuse(kw: dict[str, Any], code: str = code) -> Any:
            raise client_error(code)

        client = ToolClient({"report_scenes": refuse})
        r = await run(client, seconds=3000)
        assert r.stopped == why and not r.done and r.status["status"] == "skipped"
        assert len(client.requests) <= nova.NOVA_CONCURRENCY  # not once per part


async def test_requests_refused_as_invalid_stop_the_track_after_three() -> None:
    def refuse(kw: dict[str, Any]) -> Any:
        raise client_error("ValidationException", "video input is not supported")

    client = ToolClient({"report_scenes": refuse})
    r = await run(client, seconds=6000)
    assert r.stopped == "invalid" and not r.done
    assert len(client.requests) <= nova.MAX_INVALID + nova.NOVA_CONCURRENCY


async def test_one_bad_part_is_only_that_part() -> None:
    def answer(kw: dict[str, Any]) -> Any:
        if "starts at 0:05:00" in kw["messages"][0]["content"][1]["text"]:
            return {"scene": 1}  # the wrong shape, three times
        return {"scene": "ok", "events": []}

    r = await run(ToolClient({"report_scenes": answer}))
    assert sorted(r.done) == [0, 2] and r.failed == {1: "bad_answer"} and r.status["status"] == "partial"


async def test_a_busy_model_is_waited_out_then_given_up_after_max_tries(monkeypatch: Any) -> None:
    tries = {"n": 0}
    monkeypatch.setattr(watch, "RETRY_BASE", 0.0)

    async def structured(self: Any, **kw: Any) -> dict[str, Any]:
        tries["n"] += 1
        if tries["n"] <= 2:
            raise TransientError("throttled")
        return {"scene": "", "events": []}

    monkeypatch.setattr(Bedrock, "structured", structured)
    r = await run(ToolClient(), seconds=300)
    assert tries["n"] == 3 and r.status == {"status": "ok"}  # busy twice, then watched

    async def always_busy(self: Any, **kw: Any) -> dict[str, Any]:
        tries["n"] += 1
        raise TransientError("throttled")

    tries["n"] = 0
    monkeypatch.setattr(Bedrock, "structured", always_busy)
    r = await run(ToolClient(), seconds=300)
    assert tries["n"] == watch.MAX_TRIES and r.failed == {0: "busy"}  # bounded, never a loop


async def test_a_part_too_big_for_nova_is_not_sent() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "", "events": []}})
    r = await run(client, seconds=300, video=b"x" * (nova.NOVA_MAX_BYTES + 1))
    assert client.requests == [] and r.failed == {0: "error"}


async def test_the_budget_bounds_the_calls() -> None:
    client = ToolClient({"report_scenes": lambda kw: {"scene": "", "events": []}})
    r = await run(client, seconds=3000, budget=guard.CallBudget("nova", 2))
    assert len(client.requests) == 2 and r.stopped == "guard" and len(r.done) == 2
