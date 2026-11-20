"""Mac fetches it (docs/CONTRACTS.md §35.1): when YouTube blocks the cloud, a job made with a ``macFetch`` map waits
for the owner's Mac instead of failing; everything else fails exactly as before (test_youtube.py)."""

from __future__ import annotations

from pathlib import Path

import pytest

from clipfactory_agent import callback as cbmod
from clipfactory_agent import sources
from clipfactory_agent.callback import report
from clipfactory_agent.jobs import run_job
from clipfactory_agent.util import WAITING_FOR_MAC, NeedsMac, UserFacingError

from .test_callback import FakeLambda, make
from .test_fixes import FakeTracker
from .test_jobs import FakeStore, ok_steps, tracker
from .test_youtube import BOT, E403, ROTATED, Tube, err, pipe


@pytest.fixture
def tube(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Tube:
    return Tube(tmp_path, monkeypatch)


def test_blocked_and_run_out_cookies_wait_for_the_mac() -> None:
    for tail, cookies in ((BOT, False), (BOT, True), (ROTATED, True)):
        e = sources.explain_or_mac(err(tail), "youtube", cookies, mac_ok=True)
        assert isinstance(e, NeedsMac), tail
        assert str(e) == WAITING_FOR_MAC
    # A plain 403 on a whole download too: the cloud's address is refused, the Mac's is not.
    assert isinstance(sources.explain_or_mac(err(E403), "youtube", False, mac_ok=True), NeedsMac)


def test_what_a_mac_cannot_fix_fails_as_before() -> None:
    private = "ERROR: [youtube] abc: Private video. Sign in if you've been granted access"
    assert not isinstance(sources.explain_or_mac(err(private), "youtube", False, mac_ok=True), NeedsMac)
    live = "ERROR: [youtube] abc: This live event will begin in 2 hours"
    assert not isinstance(sources.explain_or_mac(err(live), "youtube", False, mac_ok=True), NeedsMac)
    # Twitch and Kick never wait for a Mac.
    assert not isinstance(sources.explain_or_mac(err(BOT), "twitch", False, mac_ok=True), NeedsMac)
    # A job from before §35 (no macFetch map) keeps the old words.
    old = sources.explain_or_mac(err(BOT), "youtube", False, mac_ok=False)
    assert not isinstance(old, NeedsMac) and str(old) == sources.BLOCKED_NO_COOKIES


async def test_cut_step_blocked_everywhere_waits_for_the_mac(tube: Tube) -> None:
    tube.section_always = BOT
    tube.full_error = BOT
    p, st = pipe(), tube.state(3)
    st.mac_ok = True
    with pytest.raises(NeedsMac):
        await p.render(st, FakeTracker())  # type: ignore[arg-type]
    assert tube.kinds().count("full") == 1


async def test_cut_step_blocked_at_its_first_question_waits_for_the_mac(tube: Tube) -> None:
    tube.info_error = BOT
    st = tube.state(2)
    st.mac_ok = True
    with pytest.raises(NeedsMac):
        await pipe().render(st, FakeTracker())  # type: ignore[arg-type]
    assert tube.kinds() == ["info"]


async def test_a_403_left_after_the_full_download_waits_for_the_mac(tube: Tube) -> None:
    tube.section_always = E403
    tube.full_error = E403
    st = tube.state(2)
    st.mac_ok = True
    with pytest.raises(NeedsMac):
        await pipe().render(st, FakeTracker())  # type: ignore[arg-type]


async def test_too_big_for_the_cloud_waits_for_the_mac(tube: Tube) -> None:
    tube.section_always = BOT
    tube.free = sources.DISK_RESERVE + 1000
    st = tube.state(2)
    st.mac_ok = True
    with pytest.raises(NeedsMac):
        await pipe().render(st, FakeTracker())  # type: ignore[arg-type]


async def test_cut_step_still_cuts_when_one_clip_works(tube: Tube) -> None:
    tube.section_always = E403
    st = tube.state(2)
    st.mac_ok = True
    assert await pipe().render(st, FakeTracker()) == "Cut 2 clips."  # type: ignore[arg-type]


async def test_twitch_never_waits_for_a_mac(tube: Tube) -> None:
    tube.info_error = BOT
    st = tube.state(1)
    st.mac_ok = True
    st.source = {"type": "link", "platform": "twitch", "url": "https://www.twitch.tv/videos/1"}
    st.meta = {}
    tube.section_always = BOT
    with pytest.raises(UserFacingError) as e:
        await pipe().render(st, FakeTracker())  # type: ignore[arg-type]
    assert not isinstance(e.value, NeedsMac)


async def test_the_job_keeps_running_and_says_it_waits_for_the_mac() -> None:
    store = FakeStore()

    async def blocked() -> str:
        raise NeedsMac("blocked")

    t = tracker(store)
    status = await run_job(t, ok_steps(resolve=blocked), clip_count=lambda: 0)
    assert status == "mac"
    assert all(w.get("status") != "failed" for w in store.writes)
    steps = {s["key"]: s for s in store.last["steps"]}
    assert steps["resolve"]["status"] == "running"
    assert steps["resolve"]["message"] == WAITING_FOR_MAC
    assert steps["download"]["status"] == "pending"
    assert t.error == WAITING_FOR_MAC


async def test_the_flow_is_told_to_wait_for_the_mac() -> None:
    client = FakeLambda()
    await report(make(client), "mac", job_id="J", clip_count=0, error=WAITING_FOR_MAC)
    assert client.calls == [
        (
            "failure",
            {"CallbackId": "cb-0123456789abcdef", "Error": {"ErrorType": "MacFetch", "ErrorMessage": WAITING_FOR_MAC}},
        )
    ]
    assert cbmod.MAC_FETCH == "MacFetch"
