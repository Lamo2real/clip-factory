"""vectors.py, learn.py, flow_client.py, posts.create_for_clip and the platform stubs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db, posts, settings
from clipfactory_api.flow_client import FlowClient, FlowStartError, clip_flow_name, job_flow_name
from clipfactory_api.platforms import PLATFORMS, NotConnectedError, adapter_for
from clipfactory_api.vectors import Vectors, clip_metadata, embed_text, parse_performance, score_bucket
from conftest import CLIP_FLOW_ARN, JOB_FLOW_ARN, USER, seed_clip
from fakes import FakeEmbeddings, FakeLambda, FakeS3Vectors, FakeTable

FIXTURES = Path(__file__).parent / "fixtures"


# --- vectors -------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case", json.loads((FIXTURES / "embed_text.json").read_text())["cases"], ids=lambda c: c["name"]
)
def test_embed_text_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    assert embed_text(case["clip"]) == case["expected"]


@pytest.mark.parametrize(
    ("score", "bucket"),
    [(0, "low"), (4, "low"), (4.9, "low"), (5, "mid"), (7, "mid"), (8, "high"), (10, "high"), (None, "low")],
)
def test_score_bucket(score: object, bucket: str) -> None:
    assert score_bucket(score) == bucket


def test_clip_metadata_shape() -> None:
    clip = {
        "userId": USER,
        "momentType": "rage",
        "hook": "h" * 400,
        "summary": "s" * 3000,
        "score": 9,
        "captions": {"youtubeTitle": "t"},
    }
    meta = clip_metadata(clip, "review", ["youtube", "x"])
    assert meta == {
        "userId": USER,
        "momentType": "rage",
        "platforms": ["youtube", "x"],
        "status": "review",
        "scoreBucket": "high",
        "hook": "h" * 300,
        "title": "t",
        "summary": "s" * 2000,
    }
    with pytest.raises(ValueError, match="status"):
        clip_metadata(clip, "posted", [])


def test_embed_calls_titan_with_invoke_model(vectors: Vectors, embeddings: FakeEmbeddings) -> None:
    values = vectors.embed("rage\nhook")
    assert len(values) == 1024
    (call,) = embeddings.calls
    assert call["modelId"] == "amazon.titan-embed-text-v2:0"
    assert call["body"] == {"inputText": "rage\nhook", "dimensions": 1024, "normalize": True}


def test_upsert_merges_into_an_existing_vector(
    vectors: Vectors, s3v: FakeS3Vectors, embeddings: FakeEmbeddings
) -> None:
    s3v.vectors["C1"] = {
        "key": "C1",
        "data": {"float32": [0.25] * 1024},
        "metadata": {
            "userId": USER,
            "momentType": "rage",
            "platforms": ["youtube", "x"],
            "status": "review",
            "scoreBucket": "high",
            "hook": "h",
            "title": "t",
            "summary": "s",
        },
    }
    clip = {"clipId": "C1", "userId": USER, "momentType": "rage"}
    perf = {"views": 5, "likes": 1, "comments": 0, "shares": 0, "posts": 1, "checkedAt": "2026-11-17T12:00:00.000Z"}
    assert vectors.upsert_clip(clip, status="performed", platforms=["youtube"], performance=perf) == "updated"
    stored = s3v.vectors["C1"]
    assert stored["data"]["float32"] == [0.25] * 1024  # the agent's embedding is kept
    assert stored["metadata"]["status"] == "performed"
    assert stored["metadata"]["platforms"] == ["youtube"]
    assert stored["metadata"]["hook"] == "h"
    assert json.loads(stored["metadata"]["performance"]) == perf
    assert embeddings.calls == []
    (get,) = [kw for op, kw in s3v.calls if op == "get_vectors"]
    assert get["keys"] == ["C1"]
    assert get["returnData"] is True
    assert get["returnMetadata"] is True


def test_upsert_rejects_an_unknown_status_before_any_call(vectors: Vectors, s3v: FakeS3Vectors) -> None:
    with pytest.raises(ValueError, match="status"):
        vectors.upsert_clip({"clipId": "C", "userId": USER}, status="posted")
    assert s3v.calls == []


def test_delete_and_similar_without_a_vector(vectors: Vectors, s3v: FakeS3Vectors) -> None:
    vectors.delete_clip(USER, "nope")
    assert vectors.similar(USER, "nope") == []
    assert [op for op, _ in s3v.calls] == ["delete_vectors", "get_vectors"]


def test_similar_rounds_and_clamps(vectors: Vectors, s3v: FakeS3Vectors) -> None:
    s3v.vectors["SELF"] = {
        "key": "SELF",
        "data": {"float32": [0.1] * 1024},
        "metadata": {"userId": USER, "status": "review"},
    }
    s3v.query_result = [
        {"key": "SELF", "distance": 0.0, "metadata": {"userId": USER}},
        {"key": "A", "distance": 0.123, "metadata": {"userId": USER}},
        {"key": "B", "distance": 1.4, "metadata": {"userId": USER}},
        {"key": "C", "distance": 0.2, "metadata": {"userId": "someone-else"}},
    ]
    hits = vectors.similar(USER, "SELF")
    assert [(h.clip_id, h.similarity) for h in hits] == [("A", 0.88), ("B", 0.0)]


def test_parse_performance() -> None:
    assert parse_performance('{"views": 3}') == {"views": 3}
    assert parse_performance({"views": 3}) == {"views": 3}
    assert parse_performance("nope") is None
    assert parse_performance("[1]") is None
    assert parse_performance(None) is None


# --- flow client ---------------------------------------------------------------------------------------------------


def test_flow_names_are_valid_durable_execution_names() -> None:
    assert job_flow_name("01JABCDEFGHJKMNPQRSTVWXYZ0", 2) == "job-01JABCDEFGHJKMNPQRSTVWXYZ0-2"
    assert clip_flow_name("01JABCDEFGHJKMNPQRSTVWXYZ0", 1) == "clip-01JABCDEFGHJKMNPQRSTVWXYZ0-1"
    with pytest.raises(ValueError, match="name"):
        clip_flow_name("x" * 70, 1)
    with pytest.raises(ValueError, match="name"):
        job_flow_name("bad id", 1)


def test_flow_client_uses_the_alias_and_a_deterministic_payload() -> None:
    fake = FakeLambda()
    client = FlowClient(fake, JOB_FLOW_ARN, CLIP_FLOW_ARN)
    first = client.start_clip_flow("C1", USER, 1)
    again = client.start_clip_flow("C1", USER, 1)
    assert first.execution_arn is not None
    assert again.execution_arn is None  # same name and payload: Lambda returns the existing execution
    assert (
        fake.calls[0]["Payload"]
        == fake.calls[1]["Payload"]
        == json.dumps({"clipId": "C1", "run": 1, "userId": USER}, sort_keys=True)
    )
    assert fake.calls[0]["FunctionName"] == CLIP_FLOW_ARN
    assert fake.calls[0]["InvocationType"] == "Event"


def test_flow_client_errors() -> None:
    fake = FakeLambda()
    with pytest.raises(FlowStartError, match="alias"):
        FlowClient(fake, "", CLIP_FLOW_ARN).start_job_flow("J", USER, "s", 1)
    with pytest.raises(FlowStartError, match="alias"):
        FlowClient(fake, "arn:aws:lambda:eu-north-1:123456789012:function:cf-prod-job-flow", "").start_job_flow(
            "J", USER, "s", 1
        )
    fake.fail = True
    with pytest.raises(FlowStartError, match="ServiceException"):
        FlowClient(fake, JOB_FLOW_ARN, "").start_job_flow("J", USER, "s", 1)


def test_flow_client_fits_inside_the_api_lambda_timeout() -> None:
    from clipfactory_api import flow_client

    config = flow_client.make_client("eu-north-1").meta.config
    assert (config.connect_timeout + config.read_timeout) * config.retries["total_max_attempts"] < 20


# --- posts.create_for_clip -----------------------------------------------------------------------------------------


def test_create_for_clip_is_one_transaction_and_runs_once(store: db.Store, table: FakeTable) -> None:
    clip = seed_clip(store, status="confirmed")
    defaults = settings.with_defaults(None)
    created = posts.create_for_clip(store, USER, clip, defaults, "now")
    assert len(created) == 5
    again = posts.create_for_clip(store, USER, {**clip, "postsCreated": True}, defaults, "now")
    assert sorted(p["postId"] for p in again) == sorted(p["postId"] for p in created)
    with pytest.raises(db.ConditionFailed):  # a stale copy without the flag cannot create a second set
        posts.create_for_clip(store, USER, clip, defaults, "now")
    assert len(posts.posts_for_clip(store, USER, clip["clipId"], consistent=True)) == 5


def test_create_for_clip_keeps_posts_made_before_the_flag(store: db.Store) -> None:
    clip = seed_clip(store, status="confirmed")
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.post_sk("OLD"),
            "gsi1pk": f"CLIP#{clip['clipId']}",
            "gsi1sk": "POST#youtube",
            "type": "post",
            "userId": USER,
            "postId": "OLD",
            "clipId": clip["clipId"],
            "platform": "youtube",
            "status": "pending_integration",
        }
    )
    found = posts.create_for_clip(store, USER, clip, settings.with_defaults(None), "now")
    assert sorted(p["platform"] for p in found) == sorted(PLATFORMS)
    assert [p["postId"] for p in found if p["platform"] == "youtube"] == ["OLD"]


def test_transaction_failure_writes_nothing(store: db.Store, table: FakeTable) -> None:
    clip = seed_clip(store, status="review")
    with pytest.raises(db.ConditionFailed):
        posts.create_for_clip(store, USER, clip, settings.with_defaults(None), "now", expect_status=["confirmed"])
    assert posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) == []
    assert "postsCreated" not in table.raw(clip["pk"], clip["sk"])  # type: ignore[operator]


def test_batch_get(store: db.Store) -> None:
    a, b = seed_clip(store), seed_clip(store)
    pk = db.user_pk(USER)
    found = store.batch_get([(pk, db.clip_sk(a["clipId"])), (pk, db.clip_sk(b["clipId"])), (pk, db.clip_sk("NONE"))])
    assert sorted(c["clipId"] for c in found) == sorted([a["clipId"], b["clipId"]])
    assert store.batch_get([]) == []


# --- platforms -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("platform", PLATFORMS)
def test_phase_one_adapters_report_not_connected(platform: str) -> None:
    adapter = adapter_for(platform)
    assert adapter.platform == platform
    assert adapter.idempotent is (platform != "x")  # X has no idempotency key for a new post
    with pytest.raises(NotConnectedError, match="next phase"):
        adapter.publish({}, None, idempotency_key="P")
    with pytest.raises(NotConnectedError):
        adapter.metrics({}, None)
    with pytest.raises(NotConnectedError):
        adapter_for("myspace")
