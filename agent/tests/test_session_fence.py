"""One run per job (docs/CONTRACTS.md §13): every job and clip write of a run is fenced on its sessionId."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from botocore.exceptions import ClientError

import clipfactory_agent.retry as retry_mod
from clipfactory_agent.captions import FIELDS
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.pipeline import JobState, Pipeline
from clipfactory_agent.render import RenderResult
from clipfactory_agent.store import Fence, Store
from clipfactory_agent.util import JobSuperseded

from .conftest import make_moment

S1, S2 = "cfjob-J-aaaaaaaa", "cfjob-J-bbbbbbbb"


def ccf() -> ClientError:
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")


def txn_canceled(*reasons: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": "TransactionCanceledException"},
            "CancellationReasons": [{"Code": r} for r in reasons],
        },
        "TransactWriteItems",
    )


class FakeClient:
    def __init__(self) -> None:
        self.transactions: list[list[dict[str, Any]]] = []
        self.fail: list[ClientError] = []

    def transact_write_items(self, TransactItems: list[dict[str, Any]]) -> dict[str, Any]:
        self.transactions.append(TransactItems)
        if self.fail:
            raise self.fail.pop(0)
        return {}


class FakeTable:
    """The Job item J of user U, as DynamoDB evaluates update conditions on it."""

    name = "table"

    def __init__(self, session: str, status: str = "running") -> None:
        self.job: dict[str, Any] = {"pk": "USER#U", "sk": "JOB#J", "sessionId": session, "status": status}
        self.updates: list[dict[str, Any]] = []
        self.client = FakeClient()
        self.meta = type("Meta", (), {"client": self.client})()

    def update_item(self, **kw: Any) -> dict[str, Any]:
        self.updates.append(kw)
        values = kw["ExpressionAttributeValues"]
        if not self.job:
            raise ccf()
        if ":sid" in values and self.job.get("sessionId") != values[":sid"]:
            raise ccf()
        if ":canceled" in values and self.job["status"] == "canceled":
            raise ccf()
        return {}

    def get_item(self, **kw: Any) -> dict[str, Any]:
        assert kw.get("ConsistentRead") is True
        return {"Item": self.job} if self.job else {}

    def put_item(self, **kw: Any) -> dict[str, Any]:
        raise AssertionError("an unfenced put")

    def delete_item(self, **kw: Any) -> dict[str, Any]:
        raise AssertionError("an unfenced delete")


def make_store(table: FakeTable) -> Store:
    store = Store.__new__(Store)
    store.table = table
    store.bucket = "bucket"
    return store


async def test_update_job_is_conditional_on_the_session() -> None:
    table = FakeTable(S1)
    store = make_store(table)
    assert await store.update_job("U", "J", {"progress": 0.5}, unless_canceled=True, session_id=S1) is True
    kw = table.updates[-1]
    assert kw["ConditionExpression"] == "attribute_exists(pk) AND #st <> :canceled AND #sid = :sid"
    assert kw["ExpressionAttributeNames"]["#sid"] == "sessionId" and kw["ExpressionAttributeValues"][":sid"] == S1


async def test_update_job_tells_a_cancel_from_a_newer_run() -> None:
    table = FakeTable(S1, status="canceled")
    store = make_store(table)
    assert await store.update_job("U", "J", {}, unless_canceled=True, session_id=S1) is False  # canceled, ours
    table.job.update(sessionId=S2, status="queued")
    with pytest.raises(JobSuperseded):
        await store.update_job("U", "J", {}, unless_canceled=True, session_id=S1)
    with pytest.raises(JobSuperseded):  # the final "canceled" write of a stale run is fenced too
        await store.update_job("U", "J", {"status": "canceled"}, unless_canceled=False, session_id=S1)
    table.job = {}
    with pytest.raises(JobSuperseded):  # the job is gone: stop quietly too
        await store.update_job("U", "J", {}, unless_canceled=True, session_id=S1)


async def test_update_job_without_a_session_is_unfenced() -> None:
    table = FakeTable(S2)
    store = make_store(table)
    assert await store.update_job("U", "J", {}, unless_canceled=False) is True
    assert table.updates[-1]["ConditionExpression"] == "attribute_exists(pk)"


async def test_fenced_clip_put_and_delete_are_transactions_with_a_job_check() -> None:
    table = FakeTable(S1)
    store = make_store(table)
    fence = Fence("U", "J", S1)
    await store.put_clip({"pk": "USER#U", "sk": "CLIP#C", "score": 7.5, "rank": 1}, fence=fence)
    await store.delete_item("USER#U", "CLIP#OLD", fence=fence)
    (check, put), (check2, delete) = table.client.transactions
    assert check == check2
    assert check["ConditionCheck"]["Key"] == {"pk": {"S": "USER#U"}, "sk": {"S": "JOB#J"}}
    assert check["ConditionCheck"]["ConditionExpression"] == "#sid = :sid"
    assert check["ConditionCheck"]["ExpressionAttributeValues"] == {":sid": {"S": S1}}
    assert put["Put"]["TableName"] == "table"
    assert put["Put"]["Item"]["score"] == {"N": "7.5"} and put["Put"]["Item"]["rank"] == {"N": "1"}
    assert delete == {"Delete": {"TableName": "table", "Key": {"pk": {"S": "USER#U"}, "sk": {"S": "CLIP#OLD"}}}}


async def test_fenced_write_of_a_stale_run_raises_superseded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(retry_mod.asyncio, "sleep", no_sleep)
    table = FakeTable(S2)
    store = make_store(table)
    fence = Fence("U", "J", S1)
    table.client.fail = [txn_canceled("ConditionalCheckFailed", "None")]
    with pytest.raises(JobSuperseded):
        await store.put_clip({"pk": "USER#U", "sk": "CLIP#C"}, fence=fence)
    table.client.fail = [txn_canceled("None", "TransactionConflict")]  # retried, then goes through
    await store.delete_item("USER#U", "CLIP#C", fence=fence)
    assert len(table.client.transactions) == 3
    table.client.fail = [txn_canceled("None", "ValidationError")]
    with pytest.raises(ClientError):
        await store.delete_item("USER#U", "CLIP#C", fence=fence)


# --- pipeline -----------------------------------------------------------------------------------------------------


class FakePipelineStore:
    def __init__(self, clips: list[dict[str, Any]] | None = None) -> None:
        self.clips = clips or []
        self.superseded = False
        self.uploads: list[str] = []
        self.deleted_keys: list[str] = []
        self.deleted_items: list[str] = []
        self.puts: list[tuple[dict[str, Any], Fence | None]] = []

    async def job_clips(self, job_id: str) -> list[dict[str, Any]]:
        return self.clips

    async def delete_item(self, pk: str, sk: str, *, fence: Fence | None = None) -> None:
        assert fence == Fence("U", "J", S1)
        if self.superseded:
            raise JobSuperseded()
        self.deleted_items.append(sk)

    async def delete_keys(self, keys: list[str]) -> None:
        self.deleted_keys += keys

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        self.uploads.append(key)

    async def put_clip(self, item: dict[str, Any], *, fence: Fence | None = None) -> None:
        if self.superseded:
            raise JobSuperseded()
        self.puts.append((item, fence))


class NoTracker:
    def report(self, fraction: float) -> None:
        pass

    async def check_cancel(self) -> None:
        pass


def job_state() -> JobState:
    return JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"), session_id=S1)


def review_clip(clip_id: str) -> dict[str, Any]:
    return {
        "pk": "USER#U",
        "sk": f"CLIP#{clip_id}",
        "userId": "U",
        "status": "review",
        "videoKey": f"jobs/J/clips/{clip_id}/clip.mp4",
        "coverKey": f"jobs/J/clips/{clip_id}/cover.jpg",
    }


def pipeline(store: FakePipelineStore) -> Pipeline:
    return Pipeline(None, store, None, None)  # type: ignore[arg-type]


async def test_clearing_old_clips_removes_files_only_after_the_fenced_delete() -> None:
    store = FakePipelineStore([review_clip("A"), {**review_clip("B"), "status": "confirmed"}])
    await pipeline(store)._clear_previous_clips(job_state())
    assert store.deleted_items == ["CLIP#A"]
    assert store.deleted_keys == ["jobs/J/clips/A/clip.mp4", "jobs/J/clips/A/cover.jpg"]


async def test_a_stale_run_never_removes_the_newer_runs_review_clips() -> None:
    store = FakePipelineStore([review_clip("NEW")])
    store.superseded = True
    with pytest.raises(JobSuperseded):
        await pipeline(store)._clear_previous_clips(job_state())
    assert store.deleted_items == [] and store.deleted_keys == []


def candidates(st: JobState, n: int) -> list[Candidate]:
    out = []
    for i in range(n):
        r = RenderResult(Path(f"c{i}.mp4"), Path(f"c{i}.jpg"), 27.0, [(100, 127)], [], "full", True)
        c = Candidate(make_moment(), r, index=i)
        st.clip_ids[id(c)] = f"C{i}"
        st.captions[f"C{i}"] = dict.fromkeys(FIELDS, "x")
        out.append(c)
    return out


async def test_finalize_puts_clips_fenced_on_the_session() -> None:
    store = FakePipelineStore()
    st = job_state()
    st.candidates = candidates(st, 2)
    await pipeline(store).finalize(st, NoTracker())  # type: ignore[arg-type]
    assert [(i["clipId"], f) for i, f in store.puts] == [("C0", st.fence), ("C1", st.fence)]
    assert store.deleted_keys == []


async def test_finalize_of_a_stale_run_removes_only_the_files_it_just_uploaded() -> None:
    store = FakePipelineStore()
    store.superseded = True
    st = job_state()
    st.candidates = candidates(st, 2)
    with pytest.raises(JobSuperseded):
        await pipeline(store).finalize(st, NoTracker())  # type: ignore[arg-type]
    assert store.puts == []
    assert store.uploads == ["jobs/J/clips/C0/clip.mp4", "jobs/J/clips/C0/cover.jpg"]
    assert store.deleted_keys == store.uploads
