"""Keeping and clearing files after each job (docs/CONTRACTS.md §45.34; request 2 §6F "Media storage. Reference-video
storage. Asset retention."): ``keepReferences`` and ``keepChatPictures``, only under the workspace's own ``ws/``
prefix, never a reference that is being worked on, the study always kept, logged with what was removed. And provider
usage (§45.34 "Provider usage and cost"): every provider call's ``USAGE#`` names the provider, its units and unit."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from lamostories_agent import retention
from lamostories_agent.data import JobFence
from lamostories_agent.pipeline import StoryJob
from ls_fakes import PK, USER, WS, FakeStore, FakeTable, data, needs_deno

NOW = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
REFS = f"ws/{USER}/{WS}/references/"
CHAT = f"ws/{USER}/{WS}/chat/"


def world() -> tuple[Any, FakeStore, FakeTable, JobFence]:
    table = FakeTable()
    table.seed({"pk": PK, "sk": "PJOB#J1", "type": "ws_pjob", "userId": USER, "workspaceId": WS, "jobId": "J1",
                "status": "ready", "sessionId": "S1"})  # fmt: skip
    d, store = data(table)
    return d, store, table, JobFence(USER, WS, "J1", "S1")


def ref(table: FakeTable, store: FakeStore, ref_id: str, *, status: str = "analyzed", age_days: int = 1,
        **extra: Any) -> None:  # fmt: skip
    prefix = f"{REFS}{ref_id}/"
    item = {"pk": PK, "sk": f"REFVID#{ref_id}", "type": "ws_refvid", "userId": USER, "workspaceId": WS, "refId": ref_id,
            "status": status, "key": prefix + "source.mp4",
            "createdAt": (NOW - timedelta(days=age_days)).isoformat().replace("+00:00", "Z"), **extra}  # fmt: skip
    if status == "analyzed":
        item["analysisKey"] = prefix + "analysis.json"
        store.objects[prefix + "analysis.json"] = (b'{"summary": "x"}', "application/json")
    table.seed(item)
    store.objects[prefix + "source.mp4"] = (b"v" * 1000, "video/mp4")
    store.objects[prefix + "frames/f0001.jpg"] = (b"j" * 10, "image/jpeg")


def apply(d: Any, fence: JobFence, **production: Any) -> dict[str, dict[str, int]]:
    return asyncio.run(retention.after_job(d, fence, {"production": production}, now=NOW))


def test_keep_everything_by_default() -> None:
    d, store, table, fence = world()
    ref(table, store, "R1")
    before = dict(store.objects)
    assert apply(d, fence) == {} and store.objects == before and store.listed == []


def test_study_only_clears_a_studied_reference_s_video_and_frames_and_keeps_its_study(
    capsys: pytest.CaptureFixture[str],
) -> None:
    d, store, table, fence = world()
    ref(table, store, "R1")
    ref(table, store, "R2", status="ready")  # not studied yet: kept
    ref(table, store, "R3", status="analyzing", currentJobId="J9")  # being worked on: never touched
    got = apply(d, fence, keepReferences="study_only")
    assert got == {"references": {"files": 2, "bytes": 1010}}
    assert sorted(store.deleted) == [f"{REFS}R1/frames/f0001.jpg", f"{REFS}R1/source.mp4"]
    assert f"{REFS}R1/analysis.json" in store.objects  # the study stays
    r1 = table.item("REFVID#R1")
    assert r1 is not None and r1["status"] == "analyzed" and r1["fileRemovedAt"]  # the name the API reads
    assert "sourceRemovedAt" not in r1
    assert r1["note"] == "The video was removed to save space. Its study stays."
    assert table.item("REFVID#R2").get("fileRemovedAt") is None  # type: ignore[union-attr]
    assert all(p.startswith(f"ws/{USER}/{WS}/") for p in store.listed)
    assert '"stories.retention"' in capsys.readouterr().out
    assert apply(d, fence, keepReferences="study_only") == {"references": {"files": 0, "bytes": 0}}  # done once


def test_days_clears_references_by_age_only() -> None:
    d, store, table, fence = world()
    ref(table, store, "OLD", age_days=31)
    ref(table, store, "NEW", age_days=29)
    ref(table, store, "OLD9", age_days=91, status="failed")
    assert apply(d, fence, keepReferences="days_30")["references"]["files"] == 4
    assert f"{REFS}NEW/source.mp4" in store.objects and f"{REFS}OLD/source.mp4" not in store.objects
    assert table.item("REFVID#OLD9")["note"] == "The video was removed to save space."  # type: ignore[index]


def test_a_reference_the_api_already_cleared_is_left_alone() -> None:
    d, store, table, fence = world()
    ref(table, store, "R1", fileRemovedAt="2026-11-20T10:00:00.000Z")
    ref(table, store, "R2", sourceRemovedAt="2026-11-20T10:00:00.000Z")  # an earlier build's name: still read
    assert apply(d, fence, keepReferences="study_only") == {"references": {"files": 0, "bytes": 0}}
    assert store.deleted == [] and table.item("REFVID#R1").get("note") is None  # type: ignore[union-attr]


def msg(table: FakeTable, store: FakeStore, conv: str, msg_id: str, age_days: int, *names: str,
        owner: str = USER, now: datetime = NOW) -> list[str]:  # fmt: skip
    """A chat message with its pictures (as the API writes them: ``attachments`` with key and bytes)."""
    keys_ = [f"{CHAT}{conv}/{n}" for n in names]
    for k in keys_:
        store.objects[k] = (b"p" * 5, "image/png")
    table.seed({"pk": PK, "sk": f"MSG#{conv}#{msg_id}", "type": "ws_msg", "userId": owner, "workspaceId": WS,
                "convId": conv, "msgId": msg_id, "role": "user", "text": "Look at this", "status": "done",
                "attachments": [{"assetId": f"A{i}", "key": k, "contentType": "image/png", "bytes": 5}
                                for i, k in enumerate(keys_)],
                "createdAt": (now - timedelta(days=age_days)).isoformat().replace("+00:00", "Z")})  # fmt: skip
    return keys_


def test_chat_pictures_go_with_their_old_message_which_keeps_its_words() -> None:
    """keepChatPictures days_N, per message as the API's cleanup: the files of a message that old go, the message
    keeps its words with no attachments left (so the chat never shows a picture that is gone) and
    ``picturesRemovedAt``; newer messages and anything outside the workspace are never touched."""
    d, store, table, fence = world()
    old = msg(table, store, "C1", "M1", 100, "P1.png", "P2.png")
    new = msg(table, store, "C1", "M2", 10, "P3.png")
    other = f"ws/{USER}/01JD0000000000000000000000/chat/C1/P9.png"
    clips = "uploads/clip.png"
    for key in (other, clips):
        store.objects[key] = (b"p" * 5, "image/png")
    table.seed({"pk": PK, "sk": "MSG#C1#M3", "userId": USER, "workspaceId": WS, "convId": "C1", "msgId": "M3",
                "attachments": [{"assetId": "X", "key": other, "bytes": 5}, {"assetId": "Y", "key": clips}],
                "createdAt": "2026-01-01T00:00:00.000Z"})  # fmt: skip  # keys outside this conversation's folder
    got = apply(d, fence, keepChatPictures="days_90")
    assert got == {"chatPictures": {"files": 2, "bytes": 10}}
    assert sorted(store.deleted) == sorted(old)
    m1 = table.item("MSG#C1#M1")
    assert m1 is not None and m1["attachments"] == [] and m1["picturesRemovedAt"] and m1["text"] == "Look at this"
    assert [a["key"] for a in table.item("MSG#C1#M2")["attachments"]] == new  # type: ignore[index]
    assert other in store.objects and clips in store.objects and new[0] in store.objects
    assert apply(d, fence, keepChatPictures="days_90") == {"chatPictures": {"files": 0, "bytes": 0}}  # done once


def test_a_message_of_another_owner_in_the_partition_is_never_cleared() -> None:
    d, store, table, fence = world()
    keys_ = msg(table, store, "C1", "M1", 100, "P1.png", owner="someone-else")
    assert apply(d, fence, keepChatPictures="days_30") == {"chatPictures": {"files": 0, "bytes": 0}}
    assert store.deleted == [] and keys_[0] in store.objects


def test_a_failure_while_clearing_never_changes_the_job(tmp_path: Path) -> None:
    d, store, table, fence = world()
    ref(table, store, "R1")

    async def broken(prefix: str) -> list[dict[str, Any]]:
        raise RuntimeError("S3 is down")

    store.list_keys = broken  # type: ignore[method-assign]
    assert apply(d, fence, keepReferences="study_only") == {}


@needs_deno
def test_a_story_job_clears_files_after_its_end(tmp_path: Path) -> None:
    from test_stories_pipeline import job_item, run_job
    from test_stories_pipeline import world as story_world

    svc, store, _table, _ = story_world(
        tmp_path, job=job_item("J1", "S1", run=["storyboard"]), config={"production": {"keepChatPictures": "days_30"}}
    )
    (key,) = msg(_table, store, "C1", "M1", 40, "P1.png", now=datetime.now(UTC))
    assert run_job(svc) == "ready"
    assert store.deleted == [key]
    assert _table.item("MSG#C1#M1")["attachments"] == []  # type: ignore[index]


# --- provider usage -------------------------------------------------------------------------------------------------


def test_every_provider_usage_names_the_provider_its_units_and_unit_and_is_priced_when_the_owner_gave_a_price(
    tmp_path: Path,
) -> None:
    from test_stories_pipeline import world as story_world

    svc, _store, table, _ = story_world(tmp_path)
    table.seed({"pk": PK, "sk": "AICONFIG", "userId": USER, "workspaceId": WS,
                "prices": {"nova-reel": {"inputPer1M": 0, "outputPer1M": 0, "perUnit": 0.08, "unit": "second",
                                         "currency": "USD", "source": "owner"}}})  # fmt: skip
    job = StoryJob(svc, JobFence(USER, WS, "J1", "S1"), "ST1")

    async def go() -> None:
        await job.provider_usage("nova-reel", "amazon.nova-reel-v1:1", provider="nova-reel", units=12, unit="second",
                                 videoSec=12, shots=2)  # fmt: skip
        await job.provider_usage("builtin-2d", "", provider="builtin-rig", units=3.5, unit="second", renderSec=3.5)
        await job.provider_usage("nova-canvas", "amazon.nova-canvas-v1:0", provider="nova-canvas", units=1,
                                 unit="image", images=1)  # fmt: skip

    asyncio.run(go())
    rows = {u["provider"]: u for u in table.prefix("USAGE#")}
    assert set(rows) == {"nova-reel", "builtin-rig", "nova-canvas"}
    assert all(u["kind"] == "provider" for u in rows.values())
    reel = rows["nova-reel"]
    assert (reel["units"], reel["unit"], reel["cost"], reel["currency"]) == (12, "second", 0.96, "USD")
    rig = rows["builtin-rig"]
    assert (rig["units"], rig["unit"], rig["cost"], rig["currency"], rig["providerId"]) == (
        3.5, "second", 0, None, "builtin-2d")  # fmt: skip
    canvas = rows["nova-canvas"]
    assert (canvas["units"], canvas["unit"], canvas["cost"]) == (1, "image", None)  # no price yet: not priced


def test_a_portrait_records_one_image(tmp_path: Path) -> None:
    from test_stories_providers import FakeCanvasClient, portrait_world, run_portrait

    svc, _store, table = portrait_world(tmp_path, FakeCanvasClient())
    assert run_portrait(svc) == "ready"
    (usage,) = table.prefix("USAGE#")
    assert (usage["provider"], usage["units"], usage["unit"], usage["cost"]) == ("nova-canvas", 1, "image", None)
