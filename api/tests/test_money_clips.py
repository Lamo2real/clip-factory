"""Money per clip (docs/CONTRACTS.md §27.5, ADR-50): GET /v1/money/clips.

Only what YouTube reported for each video is money; every other app is "not shared" (never a guess). Per 1,000
views shows only when the money and the views come from the same stored YouTube report and the views are at
least 1,000.
"""

from __future__ import annotations

import json
from typing import Any

from clipfactory_api import db
from conftest import USER, Call, seed_clip
from fakes import FakeS3

PK = db.user_pk(USER)


def post(
    store: db.Store,
    clip_id: str,
    platform: str,
    n: int,
    *,
    views: int | None = None,
    posted: str = "2026-10-01",
    **extra: Any,
) -> dict[str, Any]:
    post_id = f"01JZ{platform[:2].upper()}{n:020d}"
    item: dict[str, Any] = {
        "pk": PK,
        "sk": db.post_sk(post_id),
        "type": "post",
        "postId": post_id,
        "clipId": clip_id,
        "platform": platform,
        "status": "posted",
        "postedAt": f"{posted}T10:00:00.000Z",
        "url": f"https://example.com/{platform}/{n}",
        **extra,
    }
    if views is not None:
        item["metrics"] = {"views": views}
    store.put(item)
    return item


def window(amount: int, views: int, n: int = 30, to: str = "2026-11-16") -> dict[str, Any]:
    start = {7: "2026-11-10", 30: "2026-10-18", 90: "2026-08-19"}[n]
    return {
        "amountMicros": amount,
        "views": views,
        "from": start,
        "to": to,
        "currency": "USD",
        "source": "youtube.estimatedRevenue",
        "fetchedAt": "2026-11-18T06:00:00.000Z",
    }


def three_clips(store: db.Store, s3_client: FakeS3) -> list[str]:
    ids = []
    for i, (money30, yt_views, tt_views) in enumerate(
        [(1_200_000, 4_000, 90_000), (4_100_000, 2_500, 10), (0, 300, 50_000)]
    ):
        clip = seed_clip(store, s3_client, status="posted", hook=f"Hook {i}", captions={"youtubeTitle": f"Title {i}"})
        ids.append(clip["clipId"])
        post(
            store,
            clip["clipId"],
            "youtube",
            i,
            views=yt_views * 2,
            posted=f"2026-10-0{i + 1}",
            revenue={"amountMicros": money30 * 2, "currency": "USD", "through": "2026-11-16", "views": yt_views * 2},
            revenueWindows={"30": window(money30, yt_views)},
            statsId=f"vid{i}",
        )
        post(store, clip["clipId"], "tiktok", i, views=tt_views)
    return ids


def test_rows_group_by_clip_and_sort_by_money_with_youtubes_numbers(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    ids = three_clips(store, s3_client)
    status, body = call("GET", "/v1/money/clips", query={"period": "30"})
    assert status == 200
    assert [c["clipId"] for c in body["clips"]] == [ids[1], ids[0], ids[2]]
    assert body["sortedBy"] == "money"
    assert (body["period"], body["from"], body["to"]) == (30, "2026-10-18", "2026-11-16")
    top = body["clips"][0]
    assert top["title"] == "Title 1"
    assert top["coverUrl"].startswith("https://")
    assert top["totals"] == [{"currency": "USD", "amountMicros": 4_100_000}]
    assert top["views"] == 5_000 + 10  # lifetime views, so far, of the selected apps
    yt, tt = top["platforms"]
    assert yt["platform"] == "youtube"
    assert yt["moneyState"] == "reported"
    assert yt["money"] == {
        "amountMicros": 4_100_000,
        "currency": "USD",
        "from": "2026-10-18",
        "to": "2026-11-16",
        "tag": "YouTube's estimate",
        "source": "youtube.estimatedRevenue",
    }
    # 4.10 for 2,500 views in the same report: 1.64 per 1,000.
    assert yt["per1000Views"] == {
        "amountMicros": 1_640_000,
        "currency": "USD",
        "views": 2_500,
        "tag": "YouTube's numbers",
    }
    assert tt == {
        "platform": "tiktok",
        "postId": tt["postId"],
        "postedAt": "2026-10-01T10:00:00.000Z",
        "views": 10,
        "money": None,
        "per1000Views": None,
        "moneyState": "not_shared",
        "url": tt["url"],
    }
    zero = body["clips"][2]
    assert zero["totals"] == [{"currency": "USD", "amountMicros": 0}]
    assert zero["platforms"][0]["per1000Views"] is None  # 300 views: too few for a fair number


def test_per_1000_needs_the_same_reports_views(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(store, s3_client, status="posted")
    # Lifetime money without the report's views: the post's own views are never used for it.
    post(
        store,
        clip["clipId"],
        "youtube",
        1,
        views=50_000,
        revenue={"amountMicros": 9_000_000, "currency": "USD", "through": "2026-11-16"},
    )
    body = call("GET", "/v1/money/clips", query={"period": "all"})[1]
    line = body["clips"][0]["platforms"][0]
    assert line["money"]["amountMicros"] == 9_000_000
    assert line["money"]["from"] == "2026-10-01"
    assert line["money"]["to"] == "2026-11-16"
    assert line["per1000Views"] is None
    assert body["period"] == "all"
    assert body["from"] is None


def test_all_uses_lifetime_money_and_periods_use_their_window(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    three_clips(store, s3_client)
    lifetime = call("GET", "/v1/money/clips", query={"period": "all", "platforms": "youtube"})[1]
    assert [c["totals"][0]["amountMicros"] for c in lifetime["clips"]] == [8_200_000, 2_400_000, 0]
    seven = call("GET", "/v1/money/clips", query={"period": "7", "platforms": "youtube"})[1]
    assert all(c["platforms"][0]["moneyState"] == "not_reported_yet" for c in seven["clips"])
    assert all(c["totals"] == [] for c in seven["clips"])


def test_only_apps_that_dont_share_sort_by_views_with_a_note(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ids = three_clips(store, s3_client)
    body = call("GET", "/v1/money/clips", query={"platforms": "tiktok", "sort": "money"})[1]
    assert body["sortedBy"] == "views"
    assert body["note"] == "TikTok doesn't share money per video. Sorted by views."
    assert [c["clipId"] for c in body["clips"]] == [ids[0], ids[2], ids[1]]
    assert all(c["totals"] == [] for c in body["clips"])
    two = call("GET", "/v1/money/clips", query={"platforms": "tiktok,x"})[1]
    assert two["note"] == "TikTok and X don't share money per video. Sorted by views."


def test_sort_by_views(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    ids = three_clips(store, s3_client)
    body = call("GET", "/v1/money/clips", query={"sort": "views"})[1]
    assert body["sortedBy"] == "views"
    assert [c["clipId"] for c in body["clips"]] == [ids[0], ids[2], ids[1]]
    assert "note" not in body


def test_pages_and_a_changed_list_says_load_again(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    for i in range(5):
        clip = seed_clip(store, s3_client, status="posted")
        post(store, clip["clipId"], "youtube", i, views=100 + i, revenueWindows={"30": window(i * 1000, 100)})
    first = call("GET", "/v1/money/clips", query={"limit": "2"})[1]
    assert len(first["clips"]) == 2
    assert len(s3_client.presigned) == 2  # covers signed for this page only
    second = call("GET", "/v1/money/clips", query={"limit": "2", "cursor": first["nextCursor"]})[1]
    third = call("GET", "/v1/money/clips", query={"limit": "2", "cursor": second["nextCursor"]})[1]
    assert "nextCursor" not in third
    seen = [c["clipId"] for page in (first, second, third) for c in page["clips"]]
    assert len(seen) == len(set(seen)) == 5
    # The same cursor with other apps or days no longer fits.
    status, err = call("GET", "/v1/money/clips", query={"limit": "2", "cursor": first["nextCursor"], "period": "90"})
    assert status == 400
    assert err["error"]["message"] == "This list changed. Load it again."
    assert call("GET", "/v1/money/clips", query={"cursor": "not-a-cursor!!"})[0] == 400


def test_parameters_are_checked(call: Call) -> None:
    assert call("GET", "/v1/money/clips", query={"period": "365"})[0] == 400
    assert call("GET", "/v1/money/clips", query={"sort": "newest"})[0] == 400
    assert call("GET", "/v1/money/clips", query={"limit": "51"})[0] == 400
    assert call("GET", "/v1/money/clips", query={"limit": "0"})[0] == 400
    assert call("GET", "/v1/money/clips", query={"platforms": "vine"})[0] == 400
    status, body = call("GET", "/v1/money/clips")
    assert status == 200
    assert body["clips"] == []


def test_clips_posted_after_the_money_window_wait(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    old = seed_clip(store, s3_client, status="posted")
    new = seed_clip(store, s3_client, status="posted")
    post(store, old["clipId"], "youtube", 1, views=5, revenueWindows={"30": window(10, 5)})
    post(store, new["clipId"], "youtube", 2, views=5, posted="2026-11-18")
    body = call("GET", "/v1/money/clips")[1]
    assert [c["clipId"] for c in body["clips"]] == [old["clipId"]]


def test_internal_fields_never_leave(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    clip = seed_clip(store, s3_client, status="posted", spokenText="secret words", creatorKeys=["k"])
    post(
        store,
        clip["clipId"],
        "youtube",
        1,
        views=5_000,
        revenueWindows={"30": window(1_000_000, 4_000)},
        statsId="vidX",
        gsi2pk="STATS",
        refreshStartedAt="x",
        day7Verdict={"median": 1},
    )
    text = json.dumps(call("GET", "/v1/money/clips")[1])
    for key in (
        "videoKey",
        "coverKey",
        "spokenText",
        "creatorKeys",
        "statsId",
        "gsi2pk",
        "day7Verdict",
        "fetchedAt",
        "pk",
        '"sk"',
    ):
        assert key not in text
