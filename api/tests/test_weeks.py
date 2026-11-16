"""Library › This week, the weekly picks and cf-prod-learn (docs/CONTRACTS.md §16.2, §16.6)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from clipfactory_api import db, learn, weekly, weeks
from clipfactory_api.ids import ulid
from clipfactory_api.realtime.broadcast import message_for
from clipfactory_api.vectors import Vectors
from conftest import LEARN_ARN, OTHER, USER, Call, seed_clip
from fakes import FakeBedrock, FakeLambda, FakeS3Vectors, FakeTable

WEEK = "2026-W46"  # Monday 9 Nov 2026
FROM = "2026-11-08T23:00:00.000Z"  # local Monday 00:00 in UTC+1
TO = "2026-11-15T23:00:00.000Z"
Q = {"from": FROM, "to": TO}


def kept(store: db.Store, *, decided: str = "2026-11-10T10:00:00.000Z", **fields: Any) -> dict[str, Any]:
    return seed_clip(store, **{"status": "confirmed", "decidedAt": decided, **fields})


def post(
    store: db.Store, clip: dict[str, Any], platform: str, posted_at: str | None, views: int | None = None
) -> dict[str, Any]:
    post_id = ulid()
    item: dict[str, Any] = {
        "pk": db.user_pk(clip["userId"]),
        "sk": db.post_sk(post_id),
        "gsi1pk": f"CLIP#{clip['clipId']}",
        "gsi1sk": f"POST#{platform}",
        "type": "post",
        "userId": clip["userId"],
        "postId": post_id,
        "clipId": clip["clipId"],
        "platform": platform,
        "status": "posted" if posted_at else "pending_integration",
    }
    if posted_at:
        item["postedAt"] = posted_at
    if views is not None:
        item["metrics"] = {
            "views": views,
            "likes": 1,
            "comments": None,
            "shares": 0,
            "checkedAt": "2026-11-15T00:00:00.000Z",
        }
    store.put(item)
    return item


# --- bounds -------------------------------------------------------------------------------------------------------


def test_week_bounds() -> None:
    assert weeks.week_bounds_ok(WEEK, FROM, TO) is not None
    assert weeks.week_bounds_ok(WEEK, "2026-11-09T00:00:00.000Z", "2026-11-16T00:00:00.000Z") is not None
    # DST weeks are 167 or 169 hours long.
    assert weeks.week_bounds_ok("2026-W13", "2026-03-22T23:00:00.000Z", "2026-03-29T22:00:00.000Z") is not None
    assert weeks.week_bounds_ok("2026-W44", "2026-10-25T22:00:00.000Z", "2026-11-01T23:00:00.000Z") is not None
    assert weeks.week_bounds_ok(WEEK, FROM, "2026-11-16T23:00:00.000Z") is None  # 8 days
    assert weeks.week_bounds_ok(WEEK, "2026-11-11T00:00:00.000Z", "2026-11-18T00:00:00.000Z") is None  # not Monday
    assert weeks.week_bounds_ok("2026-W54", FROM, TO) is None
    assert weeks.week_bounds_ok("2026-W53", FROM, TO) is None  # 2026 has 53 weeks, but these dates are W46
    assert weeks.iso_monday("2026-W53") == datetime(2026, 12, 28, tzinfo=UTC)
    assert weeks.iso_monday("2025-W53") is None  # 2025 has only 52 ISO weeks
    assert weeks.week_bounds_ok("26-W46", FROM, TO) is None


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"from": FROM},
        {"from": "yesterday", "to": TO},
        {"from": FROM, "to": "2026-11-22T23:00:00.000Z"},
    ],
)
def test_get_week_bad_bounds_400(call: Call, query: dict[str, str]) -> None:
    status, body = call("GET", f"/v1/weeks/{WEEK}", query=query or None)
    assert status == 400
    assert body["error"]["message"] == "That week does not look right. Go back to This week."


def test_get_week_bad_id_400(call: Call) -> None:
    assert call("GET", "/v1/weeks/2026-46", query=Q)[0] == 400
    assert call("GET", "/v1/weeks/2026-W00", query=Q)[0] == 400


# --- GET week -----------------------------------------------------------------------------------------------------


def test_week_anchor_rule_sort_and_shape(call: Call, store: db.Store) -> None:
    a = kept(store, status="posted", hook="A")  # posted this week, 900 views
    post(store, a, "youtube", "2026-11-12T10:00:00.000Z", 600)
    post(store, a, "x", "2026-11-13T10:00:00.000Z", None)
    post(store, a, "tiktok", "2026-11-14T10:00:00.000Z", 300)
    b = kept(store, decided="2026-11-14T10:00:00.000Z", hook="B")  # kept, not posted: anchored on decidedAt
    c = kept(store, decided="2026-11-11T10:00:00.000Z", hook="C")
    early = kept(store, decided="2026-11-01T10:00:00.000Z", status="posted")  # decided earlier, posted this week
    post(store, early, "instagram", "2026-11-09T08:00:00.000Z", 50)
    late = kept(store, decided="2026-11-15T10:00:00.000Z", status="posted")  # decided this week, posted next week
    post(store, late, "youtube", "2026-11-16T10:00:00.000Z", 5000)
    kept(store, decided="2026-11-12T10:00:00.000Z", status="review")  # not kept
    kept(store, decided="2026-11-12T10:00:00.000Z", status="declined")
    kept(store, decided="2026-11-12T10:00:00.000Z", user=OTHER)
    status, body = call("GET", f"/v1/weeks/{WEEK}", query=Q)
    assert status == 200
    view = body["week"]
    assert view["week"] == WEEK
    assert view["from"] == FROM
    assert view["to"] == TO
    assert view["clipIds"] == []
    assert view["learnState"] == "none"
    assert "learning" not in view
    order = [row["clip"]["clipId"] for row in view["clips"]]
    assert order == [a["clipId"], early["clipId"], b["clipId"], c["clipId"]]  # views desc, then newest anchor
    first = view["clips"][0]
    assert first["anchorAt"] == "2026-11-12T10:00:00.000Z"
    assert first["posted"] is True
    assert first["totals"] == {"views": 900, "likes": 2, "comments": 0, "shares": 0}
    assert first["views"] == {"youtube": 600, "tiktok": 300, "x": None}
    assert first["best"] is False
    assert first["clip"]["coverUrl"].startswith("https://")
    assert "videoUrl" not in first["clip"]
    assert view["clips"][2]["posted"] is False
    assert view["clips"][2]["views"] == {}
    assert view["clips"][2]["anchorAt"] == "2026-11-14T10:00:00.000Z"


def test_week_views_leave_out_private_posts(call: Call, store: db.Store) -> None:
    """A private TikTok never gets numbers, so the week card must not show "numbers soon" for it."""
    clip = kept(store, decided="2026-11-12T10:00:00.000Z", status="posted")
    post(store, clip, "youtube", "2026-11-12T10:00:00.000Z", 600)
    private = post(store, clip, "tiktok", "2026-11-12T10:00:00.000Z")
    private["privacy"] = "private"
    store.put(private)
    status, body = call("GET", f"/v1/weeks/{WEEK}", query=Q)
    assert status == 200
    assert body["week"]["clips"][0]["views"] == {"youtube": 600}


# --- PUT best -----------------------------------------------------------------------------------------------------


def learn_invokes(lambda_client: FakeLambda) -> list[dict[str, Any]]:
    return [c for c in lambda_client.calls if c["FunctionName"] == LEARN_ARN]


def test_put_best_saves_flags_and_starts_learning(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    a, b, c = kept(store), kept(store), kept(store)
    status, body = call(
        "PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [a["clipId"], b["clipId"]]}
    )
    assert status == 202
    view = body["week"]
    assert view["clipIds"] == [a["clipId"], b["clipId"]]
    assert view["learnState"] == "learning"
    assert view["savedAt"] == "2026-11-15T12:00:00.000Z"
    assert {r["clip"]["clipId"]: r["best"] for r in view["clips"]} == {
        a["clipId"]: True,
        b["clipId"]: True,
        c["clipId"]: False,
    }
    assert "revision" not in json.dumps(body)
    assert "unpickedClipIds" not in json.dumps(body)
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert (item["revision"], item["unpickedClipIds"], item["type"]) == (1, [], "week")
    for clip in (a, b):
        assert store.get(clip["pk"], clip["sk"])["bestWeek"] == WEEK  # type: ignore[index]
    (invoke,) = learn_invokes(lambda_client)
    assert invoke["InvocationType"] == "Event"
    assert invoke["payload"] == {"userId": USER, "week": WEEK, "revision": 1}
    transact = [kw for name, kw in table.calls if name == "transact_write_items"]
    assert len(transact) == 1
    assert len(transact[0]["TransactItems"]) == 3

    # Swap b for c: c picked, b unpicked (best false, bestWeek removed), revision 2.
    status, body = call(
        "PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [a["clipId"], c["clipId"]]}
    )
    assert status == 202
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert item["revision"] == 2
    assert item["unpickedClipIds"] == [b["clipId"]]
    unpicked = store.get(b["pk"], b["sk"])
    assert unpicked is not None
    assert unpicked["best"] is False
    assert "bestWeek" not in unpicked
    assert store.get(c["pk"], c["sk"])["best"] is True  # type: ignore[index]
    assert learn_invokes(lambda_client)[-1]["payload"]["revision"] == 2
    assert len([kw for name, kw in table.calls if name == "transact_write_items"][-1]["TransactItems"]) == 3


def test_put_same_set_is_200_and_does_nothing(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    a, b = kept(store), kept(store)
    call("PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [a["clipId"], b["clipId"]]})
    status, body = call(
        "PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [b["clipId"], a["clipId"]]}
    )
    assert status == 200
    assert body["week"]["clipIds"] == [a["clipId"], b["clipId"]]
    assert len(learn_invokes(lambda_client)) == 1
    status, _ = call(
        "PUT",
        "/v1/weeks/2026-W45/best",
        {"from": "2026-11-01T23:00:00.000Z", "to": "2026-11-08T23:00:00.000Z", "clipIds": []},
    )
    assert status == 200  # nothing stored and nothing picked: same set


def test_put_empty_set_still_starts_the_learner(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    a = kept(store)
    call("PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [a["clipId"]]})
    status, body = call("PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": []})
    assert status == 202
    assert body["week"]["learnState"] == "skipped"
    assert learn_invokes(lambda_client)[-1]["payload"]["revision"] == 2


def test_put_rejects_foreign_or_too_many_clips(call: Call, store: db.Store) -> None:
    clips = [kept(store) for _ in range(11)]
    other_week = kept(store, decided="2026-11-02T10:00:00.000Z")
    other_owner = kept(store, user=OTHER)
    path = f"/v1/weeks/{WEEK}/best"
    status, body = call("PUT", path, {"from": FROM, "to": TO, "clipIds": [c["clipId"] for c in clips]})
    assert status == 400
    assert "at most 10" in body["error"]["message"]
    for foreign in (other_week, other_owner):
        status, body = call("PUT", path, {"from": FROM, "to": TO, "clipIds": [foreign["clipId"]]})
        assert status == 400
        assert body["error"]["message"] == "Pick clips from this week only."
    assert call("PUT", path, {"from": FROM, "to": TO, "clipIds": [clips[0]["clipId"]] * 2})[0] == 400
    assert call("PUT", path, {"from": FROM, "to": "2026-11-20T00:00:00.000Z", "clipIds": []})[0] == 400
    assert call("PUT", path, {"from": FROM, "to": TO, "clipIds": "all"})[0] == 400
    assert call("PUT", path, {"from": FROM, "to": TO, "clipIds": [], "extra": 1})[0] == 400


NEXT = "2026-W47"
NEXT_Q = {"from": TO, "to": "2026-11-22T23:00:00.000Z"}


def test_a_pick_that_moves_to_the_next_week_never_blocks_saving(
    call: Call, store: db.Store, lambda_client: FakeLambda
) -> None:
    """Kept and starred on Sunday, posted on Monday: the clip's anchor moves to the next week. The old week keeps
    saving (the stale id is dropped and unpicked), and the clip can be starred in its new week."""
    a = kept(store)
    moved = kept(store, decided="2026-11-15T20:00:00.000Z")  # Sunday evening, still this week
    path = f"/v1/weeks/{WEEK}/best"
    assert call("PUT", path, {**Q, "clipIds": [a["clipId"], moved["clipId"]]})[0] == 202
    post(store, moved, "tiktok", "2026-11-16T09:00:00.000Z", views=50)  # Monday: next week now

    status, body = call("GET", f"/v1/weeks/{WEEK}", query=Q)
    assert status == 200
    assert body["week"]["clipIds"] == [a["clipId"]]  # the moved clip is no longer listed nor shown as picked
    assert [r["clip"]["clipId"] for r in body["week"]["clips"]] == [a["clipId"]]

    # An older page sends back the stored picks, stale id included: accepted, and the stale pick is dropped.
    status, body = call("PUT", path, {**Q, "clipIds": [a["clipId"], moved["clipId"]]})
    assert status == 202
    assert body["week"]["clipIds"] == [a["clipId"]]
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert item["clipIds"] == [a["clipId"]]
    assert item["unpickedClipIds"] == [moved["clipId"]]
    cleared = store.get(moved["pk"], moved["sk"])
    assert cleared is not None
    assert cleared["best"] is False
    assert "bestWeek" not in cleared
    assert call("PUT", path, {**Q, "clipIds": [a["clipId"]]})[0] == 200  # same picks now: nothing to do
    # A clip that was never this week's is still refused.
    other = kept(store, decided="2026-11-02T10:00:00.000Z")
    assert (
        call("PUT", path, {**Q, "clipIds": [other["clipId"]]})[1]["error"]["message"]
        == "Pick clips from this week only."
    )

    # Starred in its new week; a later save of the old week leaves that star alone.
    status, body = call("PUT", f"/v1/weeks/{NEXT}/best", {**NEXT_Q, "clipIds": [moved["clipId"]]})
    assert status == 202
    assert {r["clip"]["clipId"]: r["best"] for r in body["week"]["clips"]} == {moved["clipId"]: True}
    assert call("PUT", path, {**Q, "clipIds": []})[0] == 202
    again = store.get(moved["pk"], moved["sk"])
    assert again is not None
    assert (again["best"], again["bestWeek"]) == (True, NEXT)


def test_a_stale_pick_still_starred_for_the_old_week_is_cleared_once(call: Call, store: db.Store) -> None:
    """The stored pick moved on and was re-starred in its new week before the old week was saved again."""
    a = kept(store)
    moved = kept(store, decided="2026-11-15T20:00:00.000Z")
    path = f"/v1/weeks/{WEEK}/best"
    assert call("PUT", path, {**Q, "clipIds": [moved["clipId"]]})[0] == 202
    post(store, moved, "youtube", "2026-11-17T09:00:00.000Z")
    assert call("PUT", f"/v1/weeks/{NEXT}/best", {**NEXT_Q, "clipIds": [moved["clipId"]]})[0] == 202
    status, body = call("PUT", path, {**Q, "clipIds": [moved["clipId"], a["clipId"]]})
    assert status == 202
    assert body["week"]["clipIds"] == [a["clipId"]]
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert item["unpickedClipIds"] == []  # the learner must not mark it "not best": it is next week's best
    kept_star = store.get(moved["pk"], moved["sk"])
    assert kept_star is not None
    assert (kept_star["best"], kept_star["bestWeek"]) == (True, NEXT)


def test_put_invoke_failure_marks_the_week_failed(call: Call, store: db.Store, lambda_client: FakeLambda) -> None:
    a = kept(store)
    lambda_client.fail = True
    status, body = call("PUT", f"/v1/weeks/{WEEK}/best", {"from": FROM, "to": TO, "clipIds": [a["clipId"]]})
    assert status == 202
    assert body["week"]["learnState"] == "failed"
    assert store.get(db.user_pk(USER), db.week_sk(WEEK))["learnState"] == "failed"  # type: ignore[index]


def test_get_week_shows_the_learning(call: Call, store: db.Store) -> None:
    a = kept(store, best=True, bestWeek=WEEK)
    learning_id = ulid()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.week_sk(WEEK),
            "type": "week",
            "userId": USER,
            "week": WEEK,
            "from": FROM,
            "to": TO,
            "clipIds": [a["clipId"]],
            "savedAt": "2026-11-15T10:00:00.000Z",
            "learnState": "done",
            "learningId": learning_id,
            "revision": 3,
            "unpickedClipIds": [],
        }
    )
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.learning_sk(learning_id),
            "type": "learning",
            "userId": USER,
            "learningId": learning_id,
            "kind": "week",
            "week": WEEK,
            "title": f"Best of week {WEEK}",
            "text": "Short rage hooks won.",
            "clipIds": [a["clipId"]],
            "postIds": [],
            "createdAt": "2026-11-15T10:01:00.000Z",
        }
    )
    _, body = call("GET", f"/v1/weeks/{WEEK}", query=Q)
    view = body["week"]
    assert view["learnState"] == "done"
    assert view["learningId"] == learning_id
    assert view["learning"]["text"] == "Short rage hooks won."
    assert view["learning"]["kind"] == "week"
    assert view["learning"]["title"] == "Best of week 2026-W46"
    assert view["clips"][0]["best"] is True


# --- broadcast ----------------------------------------------------------------------------------------------------


def test_broadcast_maps_week_items_with_public_week() -> None:
    item = {
        "pk": db.user_pk(USER),
        "sk": db.week_sk(WEEK),
        "type": "week",
        "userId": USER,
        "week": WEEK,
        "from": FROM,
        "to": TO,
        "clipIds": ["A"],
        "savedAt": "2026-11-15T10:00:00.000Z",
        "learnState": "learning",
        "revision": 4,
        "unpickedClipIds": ["B"],
    }
    record = {
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"pk": {"S": item["pk"]}, "sk": {"S": item["sk"]}}, "NewImage": {"x": 1}},
    }
    message = message_for(record, lambda _image: dict(item))
    assert message == {
        "type": "week",
        "op": "upsert",
        "id": WEEK,
        "item": {
            "week": WEEK,
            "from": FROM,
            "to": TO,
            "clipIds": ["A"],
            "savedAt": "2026-11-15T10:00:00.000Z",
            "learnState": "learning",
        },
    }
    removed = {"eventName": "REMOVE", "dynamodb": {"Keys": record["dynamodb"]["Keys"]}}
    assert message_for(removed, lambda _image: {}) == {"type": "week", "op": "delete", "id": WEEK}


# --- cf-prod-learn ------------------------------------------------------------------------------------------------


def seed_week(
    store: db.Store, picks: list[str], *, revision: int = 1, unpicked: list[str] | None = None, **fields: Any
) -> None:
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.week_sk(WEEK),
            "type": "week",
            "userId": USER,
            "week": WEEK,
            "from": FROM,
            "to": TO,
            "clipIds": picks,
            "unpickedClipIds": unpicked or [],
            "savedAt": "2026-11-15T10:00:00.000Z",
            "learnState": "learning" if picks else "skipped",
            "revision": revision,
            **fields,
        }
    )


def deps(store: db.Store, bedrock: FakeBedrock | None = None, vectors: Vectors | None = None) -> weekly.WeeklyDeps:
    from conftest import Clock

    sleeps: list[float] = []
    return weekly.WeeklyDeps(
        store=store,
        bedrock=bedrock or FakeBedrock("Pick rage hooks under 30 seconds."),
        model_id="global.anthropic.claude-fable-5-1",
        vectors=vectors,
        clock=Clock(),
        sleep=sleeps.append,
    )


def test_learn_week_writes_one_week_learning(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    a = kept(store, status="posted", hook="He lost it")
    pa = post(store, a, "youtube", "2026-11-12T10:00:00.000Z", 900)
    b = kept(store, hook="Calm walk")
    seed_week(store, [a["clipId"]], unpicked=[b["clipId"]])
    bedrock = FakeBedrock("Pick rage hooks under 30 seconds.")
    out = weekly.learn_week(deps(store, bedrock, vectors), USER, WEEK, 1)
    assert out == {"week": WEEK, "outcome": "learning"}
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert item["learnState"] == "done"
    learning = store.get(db.user_pk(USER), db.learning_sk(item["learningId"]))
    assert learning is not None
    assert learning["kind"] == "week"
    assert learning["week"] == WEEK
    assert learning["title"] == "Best of week 2026-W46"
    assert learning["text"] == "Pick rage hooks under 30 seconds."
    assert learning["clipIds"] == [a["clipId"]]
    assert learning["postIds"] == [pa["postId"]]
    (converse,) = bedrock.calls
    assert converse["modelId"] == "global.anthropic.claude-fable-5-1"
    assert converse["inferenceConfig"] == {"maxTokens": 4000}
    assert converse["additionalModelRequestFields"] == {"output_config": {"effort": "low"}}
    for banned in ("temperature", "topP", "topK"):
        assert banned not in converse["inferenceConfig"]
        assert banned not in converse["additionalModelRequestFields"]
    rows = json.loads(converse["messages"][0]["content"][0]["text"].split("\n", 1)[1])
    assert {r["hook"]: r["picked"] for r in rows} == {"He lost it": True, "Calm walk": False}
    picked = next(r for r in rows if r["picked"])
    assert picked["platforms"] == {"youtube": {"views": 900, "likes": 1, "comments": None, "shares": 0}}
    assert picked["totalViews"] == 900
    assert picked["tiktokCaption"] == "wait for it"
    # Vectors: picked best=true, unpicked best=false (missing vectors are embedded from the clip).
    assert s3v.vectors[a["clipId"]]["metadata"]["best"] is True
    assert s3v.vectors[b["clipId"]]["metadata"]["best"] is False


def test_learn_week_reuses_the_learning_id(store: db.Store) -> None:
    a = kept(store)
    learning_id = ulid()
    seed_week(store, [a["clipId"]], revision=2, learningId=learning_id)
    assert weekly.learn_week(deps(store), USER, WEEK, 2)["outcome"] == "learning"
    assert store.get(db.user_pk(USER), db.week_sk(WEEK))["learningId"] == learning_id  # type: ignore[index]
    assert len(store.query_all(db.user_pk(USER), "LEARNING#")) == 1


def test_learn_week_superseded_writes_nothing(
    store: db.Store, table: FakeTable, vectors: Vectors, s3v: FakeS3Vectors
) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]], revision=3)
    before = table.all()
    bedrock = FakeBedrock()
    assert weekly.learn_week(deps(store, bedrock, vectors), USER, WEEK, 2) == {"week": WEEK, "outcome": "superseded"}
    assert table.all() == before
    assert bedrock.calls == []
    assert s3v.vectors == {}


def test_learn_week_survives_vector_errors(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]])
    s3v.fail = True
    assert weekly.learn_week(deps(store, vectors=vectors), USER, WEEK, 1)["outcome"] == "learning"


def test_learn_week_keeps_vector_metadata(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    a = kept(store)
    s3v.vectors[a["clipId"]] = {
        "key": a["clipId"],
        "data": {"float32": [0.5] * 1024},
        "metadata": {"userId": USER, "status": "performed", "performance": "{}", "best": False},
    }
    seed_week(store, [a["clipId"]])
    weekly.learn_week(deps(store, vectors=vectors), USER, WEEK, 1)
    meta = s3v.vectors[a["clipId"]]["metadata"]
    assert meta == {"userId": USER, "status": "performed", "performance": "{}", "best": True}
    assert s3v.vectors[a["clipId"]]["data"]["float32"][0] == 0.5


def test_learn_week_empty_picks_delete_the_old_learning(store: db.Store, vectors: Vectors, s3v: FakeS3Vectors) -> None:
    a = kept(store)
    learning_id = ulid()
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.learning_sk(learning_id),
            "type": "learning",
            "learningId": learning_id,
            "text": "old",
        }
    )
    seed_week(
        store, [], revision=2, unpicked=[a["clipId"]], learningId=learning_id, learnedAt="2026-11-14T00:00:00.000Z"
    )
    bedrock = FakeBedrock()
    assert weekly.learn_week(deps(store, bedrock, vectors), USER, WEEK, 2)["outcome"] == "skipped"
    assert store.get(db.user_pk(USER), db.learning_sk(learning_id)) is None
    item = store.get(db.user_pk(USER), db.week_sk(WEEK))
    assert item is not None
    assert item["learnState"] == "skipped"
    assert "learningId" not in item
    assert bedrock.calls == []
    assert s3v.vectors[a["clipId"]]["metadata"]["best"] is False


@pytest.mark.parametrize("stop", ["max_tokens", "refusal", "content_filtered"])
def test_learn_week_stop_reasons_fail_without_a_learning(store: db.Store, stop: str) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]])
    out = weekly.learn_week(deps(store, FakeBedrock(stop_reason=stop)), USER, WEEK, 1)
    assert out == {"week": WEEK, "outcome": stop}
    assert store.get(db.user_pk(USER), db.week_sk(WEEK))["learnState"] == "failed"  # type: ignore[index]
    assert store.query_all(db.user_pk(USER), "LEARNING#") == []


def test_learn_week_empty_answer_and_bedrock_errors_fail(store: db.Store) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]])
    assert weekly.learn_week(deps(store, FakeBedrock(text="")), USER, WEEK, 1)["outcome"] == "failed"
    bedrock = FakeBedrock()
    bedrock.fail = True
    d = deps(store, bedrock)
    assert weekly.learn_week(d, USER, WEEK, 1)["outcome"] == "failed"
    assert len(bedrock.calls) == 3  # two retries
    assert store.query_all(db.user_pk(USER), "LEARNING#") == []


def test_learn_week_answer_is_capped(store: db.Store) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]])
    weekly.learn_week(deps(store, FakeBedrock("word " * 300)), USER, WEEK, 1)
    (learning,) = store.query_all(db.user_pk(USER), "LEARNING#")
    assert len(learning["text"]) <= 500


@pytest.mark.parametrize(
    "event",
    [None, {}, {"userId": USER, "week": "bad", "revision": 1}, {"userId": USER, "week": WEEK, "revision": "1"}],
)
def test_learn_handler_bad_events(store: db.Store, event: Any) -> None:
    assert weekly.handle(event, deps(store))["outcome"] == "bad_event"


def test_learn_handler_runs_and_builds_deps_once(store: db.Store, monkeypatch: pytest.MonkeyPatch) -> None:
    a = kept(store)
    seed_week(store, [a["clipId"]])
    built: list[int] = []

    def factory() -> weekly.WeeklyDeps:
        built.append(1)
        return deps(store)

    monkeypatch.setattr(weekly, "_deps", None)
    weekly.get_deps(factory)
    weekly.get_deps(factory)
    assert built == [1]
    assert weekly.handler({"userId": USER, "week": WEEK, "revision": 1})["outcome"] == "learning"
    monkeypatch.setattr(weekly, "_deps", None)


def test_week_rows_shape() -> None:
    clip = {
        "hook": "h",
        "momentType": "rage",
        "durationSec": 20,
        "layout": "blur_fill",
        "score": 7,
        "captions": {"youtubeTitle": "T", "tiktok": "x" * 300},
    }
    posts = [
        {"platform": "tiktok", "status": "posted", "metrics": {"views": 5, "likes": 1}},
        {"platform": "x", "status": "pending_integration"},
    ]
    (row,) = learn.week_rows([(clip, posts, True)])
    assert row == {
        "picked": True,
        "hook": "h",
        "momentType": "rage",
        "durationSec": 20,
        "layout": "blur_fill",
        "score": 7,
        "youtubeTitle": "T",
        "tiktokCaption": "x" * 200,
        "platforms": {"tiktok": {"views": 5, "likes": 1, "comments": None, "shares": None}},
        "totalViews": 5,
    }
