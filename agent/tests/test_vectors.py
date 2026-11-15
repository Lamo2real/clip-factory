"""S3 Vectors, "what worked before" (docs/CONTRACTS.md §14.6)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_agent import vectors as v
from clipfactory_agent.agent import Brief, system_prompt
from clipfactory_agent.captions import FIELDS
from clipfactory_agent.checklist import Candidate
from clipfactory_agent.config import load_config
from clipfactory_agent.pipeline import JobState, Pipeline
from clipfactory_agent.render import RenderResult

from .conftest import make_moment

FIXTURES = Path(__file__).parent / "fixtures"
API_FIXTURE = Path(__file__).parents[2] / "api" / "tests" / "fixtures" / "embed_text.json"


def cases(path: Path) -> list[tuple[dict[str, Any], str]]:
    data = json.loads(path.read_text("utf-8"))
    rows = data.get("cases", [data]) if isinstance(data, dict) else data
    return [(r["clip"], r.get("text", r.get("expected"))) for r in rows]


# --- the shared text formula --------------------------------------------------------------------------------------


@pytest.mark.parametrize(("clip", "text"), cases(FIXTURES / "embed_text.json"))
def test_embed_text_matches_the_shared_fixture(clip: dict[str, Any], text: str) -> None:
    assert v.embed_text(clip) == text


def test_embed_text_matches_the_api_fixture_too() -> None:
    if not API_FIXTURE.is_file():
        pytest.skip("api/tests/fixtures/embed_text.json is not there yet")
    for clip, text in cases(API_FIXTURE):
        assert v.embed_text(clip) == text


def test_embed_text_without_captions() -> None:
    assert v.embed_text({"momentType": "funny", "hook": "h", "summary": "s"}) == "funny\nh\n\ns"


def test_query_text_and_transcript() -> None:
    words = [[0, 1, "hello"], [1, 2, "there"], [2, 3]]
    assert v.transcript_text(words) == "hello there"
    assert v.query_text("T", "C", "N", "x" * 5000) == "T\nC\nN\n" + "x" * 4000


@pytest.mark.parametrize(
    ("score", "bucket"), [(0, "low"), (4, "low"), (4.4, "low"), (5, "mid"), (7, "mid"), (8, "high"), (10, "high")]
)
def test_score_bucket(score: float, bucket: str) -> None:
    assert v.score_bucket(score) == bucket


def clip_row(clip_id: str = "C1", **kw: Any) -> dict[str, Any]:
    return {
        "clipId": clip_id,
        "userId": "U",
        "momentType": "rage",
        "hook": "he thought he got away with it",
        "summary": "He loses it",
        "captions": {"youtubeTitle": "He Almost Got Away"},
        "score": 8,
        "status": "review",
        **kw,
    }


def test_clip_metadata_has_exactly_the_contract_keys() -> None:
    meta = v.clip_metadata(clip_row(), ["youtube", "tiktok"])
    assert meta == {
        "userId": "U",
        "momentType": "rage",
        "platforms": ["youtube", "tiktok"],
        "status": "review",
        "scoreBucket": "high",
        "hook": "he thought he got away with it",
        "title": "He Almost Got Away",
        "summary": "He loses it",
    }
    filterable = {k: meta[k] for k in ("userId", "momentType", "platforms", "status", "scoreBucket")}
    assert len(json.dumps(filterable).encode()) < 2048
    assert "performance" not in meta  # added by the clip flow after the 48-hour check


# --- fakes --------------------------------------------------------------------------------------------------------


class FakeTitan:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail: Exception | None = None

    def invoke_model(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(kw)
        if self.fail:
            raise self.fail
        body = json.loads(kw["body"])
        seed = float(len(body["inputText"]) % 7)
        return {"body": io.BytesIO(json.dumps({"embedding": [seed] * body["dimensions"]}).encode())}


class FakeS3Vectors:
    def __init__(self, answers: list[list[dict[str, Any]]] | None = None) -> None:
        self.puts: list[dict[str, Any]] = []
        self.queries: list[dict[str, Any]] = []
        self.answers = answers or []
        self.fail: Exception | None = None

    def put_vectors(self, **kw: Any) -> dict[str, Any]:
        if self.fail:
            raise self.fail
        self.puts.append(kw)
        return {}

    def query_vectors(self, **kw: Any) -> dict[str, Any]:
        self.queries.append(kw)
        if self.fail:
            raise self.fail
        return {"vectors": self.answers.pop(0) if self.answers else [], "distanceMetric": "cosine"}


def make(titan: FakeTitan, s3v: FakeS3Vectors) -> v.Vectors:
    return v.Vectors(
        "cf-prod-vectors-1", "clips", "amazon.titan-embed-text-v2:0", "eu-north-1", bedrock=titan, s3vectors=s3v
    )


def row(key: str, distance: float, status: str = "performed", **meta: Any) -> dict[str, Any]:
    return {
        "key": key,
        "distance": distance,
        "metadata": {
            "userId": "U",
            "status": status,
            "momentType": "rage",
            "hook": f"hook {key}",
            "title": "T",
            **meta,
        },
    }


# --- embedding and writing ------------------------------------------------------------------------------------------


async def test_embed_calls_titan_v2_with_1024_normalized_dimensions() -> None:
    titan = FakeTitan()
    out = await make(titan, FakeS3Vectors()).embed("hello")
    assert len(out) == 1024
    call = titan.calls[0]
    assert call["modelId"] == "amazon.titan-embed-text-v2:0"
    assert json.loads(call["body"]) == {"inputText": "hello", "dimensions": 1024, "normalize": True}


async def test_put_clips_writes_one_put_vectors_with_the_contract_metadata() -> None:
    titan, s3v = FakeTitan(), FakeS3Vectors()
    n = await make(titan, s3v).put_clips([clip_row("C1"), clip_row("C2", score=3)], ["youtube"])
    assert n == 2 and len(s3v.puts) == 1
    put = s3v.puts[0]
    assert (put["vectorBucketName"], put["indexName"]) == ("cf-prod-vectors-1", "clips")
    keys = [x["key"] for x in put["vectors"]]
    assert keys == ["C1", "C2"]
    assert all(len(x["data"]["float32"]) == 1024 for x in put["vectors"])
    assert put["vectors"][1]["metadata"]["scoreBucket"] == "low"
    assert all(x["metadata"]["status"] == "review" for x in put["vectors"])
    assert [json.loads(c["body"])["inputText"] for c in titan.calls] == [v.embed_text(clip_row("C1"))] * 2


# --- reading ------------------------------------------------------------------------------------------------------


async def test_query_prefers_performed_clips_of_the_owner() -> None:
    perf = json.dumps({"views": 12400, "likes": 900, "comments": 3, "shares": 1, "posts": 1, "checkedAt": "x"})
    s3v = FakeS3Vectors([[row("A", 0.1, performance=perf), row("B", 0.3), row("C", 0.2)]])
    hits = await v.what_worked_before(make(FakeTitan(), s3v), "U", "brief")
    assert len(s3v.queries) == 1
    q = s3v.queries[0]
    assert q["topK"] == 8 and q["returnMetadata"] is True and q["returnDistance"] is True
    assert q["filter"] == {"$and": [{"userId": {"$eq": "U"}}, {"status": {"$eq": "performed"}}]}
    assert [h.clip_id for h in hits] == ["A", "C", "B"]
    assert hits[0].similarity == 0.9 and hits[0].performance and hits[0].performance["views"] == 12400


async def test_fewer_than_three_performed_hits_falls_back_to_all_the_owners_clips() -> None:
    s3v = FakeS3Vectors([[row("A", 0.1)], [row("A", 0.1), row("R", 0.4, status="review")]])
    hits = await v.what_worked_before(make(FakeTitan(), s3v), "U", "brief")
    assert [q["filter"] for q in s3v.queries] == [
        {"$and": [{"userId": {"$eq": "U"}}, {"status": {"$eq": "performed"}}]},
        {"userId": {"$eq": "U"}},
    ]
    assert s3v.queries[0]["queryVector"] == s3v.queries[1]["queryVector"]  # embedded once
    assert [h.clip_id for h in hits] == ["A", "R"]


@pytest.mark.parametrize("where", ["titan", "s3vectors"])
async def test_any_error_skips_what_worked_before(where: str, capsys: pytest.CaptureFixture[str]) -> None:
    titan, s3v = FakeTitan(), FakeS3Vectors()
    if where == "titan":
        titan.fail = ValueError("bad")
    else:
        s3v.fail = PermissionError("403")
    assert await v.what_worked_before(make(titan, s3v), "U", "brief") == []
    assert "vectors.query_failed" in capsys.readouterr().out


async def test_no_vectors_configured_means_no_hits() -> None:
    assert await v.what_worked_before(None, "U", "brief") == []


def test_prompt_section_lists_each_hit_as_advice() -> None:
    hits = [
        v.Hit(
            "A", 0.83, "rage", "he lost it", "He Lost It", "A big reaction", {"views": 12400, "likes": 900}, "performed"
        ),
        v.Hit("B", 0.5, "funny_fail", "oops", "Oops", "A fall", None, "review"),
    ]
    text = v.prompt_section(hits)
    assert text.startswith("What worked before")
    assert "advice" in text and "never a rule" in text
    assert "similarity 0.83" in text and "12,400 views, 900 likes" in text and "funny fail" in text
    assert "not measured yet" in text
    assert v.prompt_section([]) == ""


def brief(**kw: Any) -> Brief:
    base: dict[str, Any] = {
        "title": "T",
        "channel": "C",
        "platform": "youtube",
        "duration": 600.0,
        "notes": "",
        "clip_min": 1,
        "clip_max": 3,
        "length": (20.0, 45.0),
        "words": [],
        "loud": [],
    }
    return Brief(**{**base, **kw})


def test_system_prompt_includes_what_worked_before_only_when_there_are_hits() -> None:
    assert "What worked before" not in system_prompt(brief())
    hit = v.Hit("A", 0.9, "rage", "he lost it", "He Lost It", "s", {"views": 5, "likes": 1}, "performed")
    assert "What worked before" in system_prompt(brief(similar=[hit]))


def test_config_reads_the_vector_settings() -> None:
    base = {"CF_TABLE": "t", "CF_MEDIA_BUCKET": "b", "CF_REGION": "eu-north-1", "CF_MODEL_ID": "m"}
    cfg = load_config(base)
    assert (cfg.vector_bucket, cfg.vector_index, cfg.embed_model_id) == (None, "clips", "amazon.titan-embed-text-v2:0")
    cfg = load_config({**base, "CF_VECTOR_BUCKET": "cf-prod-vectors-1", "CF_VECTOR_INDEX": "clips2"})
    assert (cfg.vector_bucket, cfg.vector_index) == ("cf-prod-vectors-1", "clips2")


# --- the pipeline -------------------------------------------------------------------------------------------------


class Store:
    """Clip items by clipId; ``events`` records the order of vector and clip writes."""

    def __init__(self, events: list[str] | None = None) -> None:
        self.puts: list[dict[str, Any]] = []
        self.clips: dict[str, str] = {}
        self.events = events if events is not None else []
        self.fail_statuses = False

    async def upload(self, path: Path, key: str, content_type: str) -> None:
        pass

    async def put_clip(self, item: dict[str, Any], *, fence: Any = None) -> None:
        self.events.append(f"clip {item['clipId']}")
        self.puts.append(item)
        self.clips[item["clipId"]] = item["status"]

    async def clip_statuses(self, user_id: str, clip_ids: list[str]) -> dict[str, str]:
        if self.fail_statuses:
            raise PermissionError("403")
        return {i: self.clips[i] for i in clip_ids if i in self.clips}


class ApiS3Vectors(FakeS3Vectors):
    """The index as the API and clip-flow change it: Keep rewrites the metadata, Decline deletes the vector."""

    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.index: dict[str, dict[str, Any]] = {}
        self.events = events

    def put_vectors(self, **kw: Any) -> dict[str, Any]:
        super().put_vectors(**kw)
        for vec in kw["vectors"]:
            self.events.append(f"vector {vec['key']}")
            self.index[vec["key"]] = vec
        return {}


class DecideOnUpload(Store):
    """The owner keeps the first clip and declines the second as soon as each becomes visible."""

    def __init__(self, s3v: ApiS3Vectors, events: list[str]) -> None:
        super().__init__(events)
        self.s3v = s3v

    async def put_clip(self, item: dict[str, Any], *, fence: Any = None) -> None:
        await super().put_clip(item, fence=fence)
        key = item["clipId"]
        if key == "C0":  # Keep: clip-flow's upsert-vector (not_posted) writes status confirmed
            self.clips[key] = "confirmed"
            if key in self.s3v.index:
                self.s3v.index[key]["metadata"]["status"] = "confirmed"
        else:  # Decline: the API sets the clip declined and deletes its vector
            self.clips[key] = "declined"
            self.s3v.index.pop(key, None)


class NoTracker:
    def report(self, fraction: float) -> None:
        pass

    async def check_cancel(self) -> None:
        pass


def state(n: int) -> JobState:
    st = JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"), session_id="S")
    st.settings = {"platforms": ["youtube", "instagram"]}
    for i in range(n):
        r = RenderResult(Path(f"c{i}.mp4"), Path(f"c{i}.jpg"), 27.0, [(100, 127)], [], "full", True)
        c = Candidate(make_moment(score=6.0 + i), r, index=i)
        st.clip_ids[id(c)] = f"C{i}"
        st.captions[f"C{i}"] = dict.fromkeys(FIELDS, f"title {i}")
        st.candidates.append(c)
    return st


async def test_finalize_puts_the_new_clips_vectors() -> None:
    events: list[str] = []
    s3v = ApiS3Vectors(events)
    store = Store(events)
    p = Pipeline(None, store, None, None, vectors=make(FakeTitan(), s3v))  # type: ignore[arg-type]
    await p.finalize(state(2), NoTracker())  # type: ignore[arg-type]
    assert len(store.puts) == 2 and len(s3v.puts) == 1
    assert events == ["vector C0", "vector C1", "clip C0", "clip C1"]  # vectors exist before any clip is visible
    vecs = s3v.puts[0]["vectors"]
    assert [x["key"] for x in vecs] == ["C0", "C1"]
    assert vecs[0]["metadata"] == {
        "userId": "U",
        "momentType": "rage",
        "platforms": ["youtube", "instagram"],
        "status": "review",
        "scoreBucket": "mid",
        "hook": "he thought he got away with it",
        "title": "title 0",
        "summary": "He loses it",
    }


async def test_finalize_survives_a_vector_failure(capsys: pytest.CaptureFixture[str]) -> None:
    s3v = FakeS3Vectors()
    s3v.fail = PermissionError("403")
    store = Store()
    p = Pipeline(None, store, None, None, vectors=make(FakeTitan(), s3v))  # type: ignore[arg-type]
    msg = await p.finalize(state(1), NoTracker())  # type: ignore[arg-type]
    assert msg == "1 clip(s) ready for review." and len(store.puts) == 1
    assert "vectors.put_failed" in capsys.readouterr().out


async def test_a_keep_or_decline_during_finalize_is_not_undone() -> None:
    events: list[str] = []
    s3v = ApiS3Vectors(events)
    store = DecideOnUpload(s3v, events)
    p = Pipeline(None, store, None, None, vectors=make(FakeTitan(), s3v))  # type: ignore[arg-type]
    await p.finalize(state(2), NoTracker())  # type: ignore[arg-type]
    assert s3v.index["C0"]["metadata"]["status"] == "confirmed"
    assert "C1" not in s3v.index


async def test_declined_and_missing_clips_never_reach_what_worked_before() -> None:
    s3v = FakeS3Vectors([[row("A", 0.1), row("B", 0.2), row("C", 0.3), row("D", 0.4)]])
    store = Store()
    store.clips = {"A": "performed", "B": "declined", "D": "review"}  # C: vector of a clip never written
    p = Pipeline(None, store, None, None, vectors=make(FakeTitan(), s3v))  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"))
    assert [h.clip_id for h in await p._similar(st)] == ["A", "D"]


async def test_a_failed_clip_check_skips_what_worked_before(capsys: pytest.CaptureFixture[str]) -> None:
    s3v = FakeS3Vectors([[row("A", 0.1), row("B", 0.2), row("C", 0.3)]])
    store = Store()
    store.fail_statuses = True
    p = Pipeline(None, store, None, None, vectors=make(FakeTitan(), s3v))  # type: ignore[arg-type]
    assert await p._similar(JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"))) == []
    assert "vectors.clip_check_failed" in capsys.readouterr().out


async def test_similar_clips_are_looked_up_from_the_brief() -> None:
    s3v = FakeS3Vectors([[row("A", 0.1), row("B", 0.2), row("C", 0.3)]])
    titan = FakeTitan()
    store = Store()
    store.clips = {"A": "performed", "B": "performed", "C": "performed"}
    p = Pipeline(None, store, None, None, vectors=make(titan, s3v))  # type: ignore[arg-type]
    st = JobState(job_id="J", user_id="U", workdir=Path("/tmp/x"))
    st.source = {"title": "Big stream", "channel": "Sam"}
    st.job = {"notes": "only funny bits"}
    st.words = [[0, 1, "hello"], [1, 2, "chat"]]
    hits = await p._similar(st)
    assert [h.clip_id for h in hits] == ["A", "B", "C"]
    assert json.loads(titan.calls[0]["body"])["inputText"] == "Big stream\nSam\nonly funny bits\nhello chat"
    assert await Pipeline(None, None, None, None)._similar(st) == []  # type: ignore[arg-type]
