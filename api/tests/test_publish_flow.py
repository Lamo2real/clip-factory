"""The clip-flow's publishing step chain with the real publishers (docs/CONTRACTS.md §17.6, §17.12)."""

from __future__ import annotations

import copy
from typing import Any

import pytest
from aws_durable_execution_sdk_python import StepError
from aws_durable_execution_sdk_python.config import StepSemantics

from clipfactory_api import db, posts, s3
from clipfactory_api.flows.clip_flow import ClipFlowDeps, run_clip_flow
from clipfactory_api.oauth import setup
from clipfactory_api.oauth.providers import AppKeys
from clipfactory_api.oauth.tokens import Credentials, ReconnectNeededError
from clipfactory_api.platforms.publishers import publisher_for
from clipfactory_api.stats import config
from conftest import NOW, USER, Clock, seed_clip
from fakes import FakeBedrock, FakeDurableContext, FakeHttp, FakeS3, FakeTable, FakeVideo
from test_flows import FakeAdapter

MB = 1024 * 1024
SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc"
TIKTOK_OPTIONS = {
    "privacyLevel": "SELF_ONLY",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}


class FakeTokens:
    def __init__(self, dead: set[str] | None = None) -> None:
        self.dead = dead or set()
        self.marked: list[str] = []

    def credentials(self, platform: str, account: dict[str, Any]) -> Credentials:
        if platform in self.dead:
            raise ReconnectNeededError(f"Connect {platform} again")
        data = {"igUserId": "1784", "pageId": "p1", "username": "owner"}
        return Credentials(platform, "ACCESS", AppKeys("1234567890", "0123456789abcdef0123456789abcdef"), data)

    def mark_dead(self, platform: str, account: dict[str, Any]) -> ReconnectNeededError:
        self.marked.append(platform)
        return ReconnectNeededError("dead")


def cfg_with(**publish: dict[str, Any]) -> config.PlatformsConfig:
    raw = copy.deepcopy(config.load().raw)
    for platform, values in publish.items():
        raw["platforms"][platform]["publish"].update(values)
    return config.parse(raw)


def connect(store: db.Store, *platforms: str) -> None:
    for platform in platforms:
        setup.put_account(store, USER, platform, "connected", now=NOW, fields={"handle": "@owner", "accountId": "a1"})


def kept(store: db.Store, **fields: Any) -> dict[str, Any]:
    return seed_clip(
        store, status="confirmed", publishState="started", flowRun=1, decidedAt="2026-11-15T11:59:00.000Z", **fields
    )


def deps_for(
    store: db.Store, http: FakeHttp, *, tokens: FakeTokens | None = None, cfg: config.PlatformsConfig | None = None
) -> ClipFlowDeps:
    return ClipFlowDeps(
        store=store,
        bedrock=FakeBedrock(),
        model_id="global.anthropic.claude-fable-5-1",
        vectors=None,
        media=s3.Media(FakeS3(), "cf-prod-media-123"),
        adapters=FakeAdapter,
        clock=Clock(),
        sleep=lambda _s: None,
        http=http,
        publishers=publisher_for,
        tokens=tokens or FakeTokens(),
        video=lambda _clip: FakeVideo(3 * MB),
        cfg=cfg or config.load(),
    )


def post_for(store: db.Store, clip: dict[str, Any], platform: str) -> dict[str, Any]:
    return next(
        p for p in posts.posts_for_clip(store, USER, clip["clipId"], consistent=True) if p["platform"] == platform
    )


def event(clip: dict[str, Any]) -> dict[str, Any]:
    return {"clipId": clip["clipId"], "userId": USER, "run": 1}


YOUTUBE_OK = [
    (200, b"", {"Location": SESSION}),
    (201, "publish/youtube_video"),
    (200, "publish/youtube_uploaded"),
    (200, "publish/youtube_processed"),
]


def test_youtube_chain_names_and_waits(store: db.Store) -> None:
    connect(store, "youtube")
    clip = kept(store)
    http = FakeHttp(*YOUTUBE_OK)
    ctx = FakeDurableContext()
    out = run_clip_flow(ctx, event(clip), deps_for(store, http))
    assert out["outcome"] == "done"
    assert ctx.steps[:4] == ["ensure-posts", "publish-youtube", "check-youtube-1", "check-youtube-2"]
    assert ctx.waits[:2] == [("wait-youtube-1", 30), ("wait-youtube-2", 30)]
    assert ctx.configs["publish-youtube"].step_semantics == StepSemantics.AT_LEAST_ONCE_PER_RETRY
    youtube = post_for(store, clip, "youtube")
    assert youtube["status"] == "posted"
    assert youtube["url"] == "https://www.youtube.com/shorts/vid123"
    assert youtube["statsId"] == "vid123"
    assert youtube["publishHandle"] == {"videoId": "vid123"}  # the upload URL is gone once the upload is done
    assert "publishHandle" not in posts.public_post(youtube)
    assert post_for(store, clip, "x")["status"] == "pending_integration"


def test_a_replayed_start_does_not_create_a_second_video(store: db.Store) -> None:
    connect(store, "youtube")
    clip = kept(store)
    http = FakeHttp(*YOUTUBE_OK)
    ctx = FakeDurableContext(replay={"publish-youtube"})
    run_clip_flow(ctx, event(clip), deps_for(store, http))
    assert [c.method for c in http.calls].count("POST") == 1
    assert post_for(store, clip, "youtube")["status"] == "posted"


def test_instagram_chain_with_finish(store: db.Store) -> None:
    connect(store, "instagram")
    clip = kept(store)
    http = FakeHttp(
        (200, "publish/instagram_limit"),
        (200, "publish/instagram_container"),
        (200, "publish/instagram_upload"),
        (200, {"status_code": "IN_PROGRESS"}),
        (200, "publish/instagram_status_finished"),
        (200, "publish/instagram_publish"),
        (200, "publish/instagram_permalink"),
    )
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, http))
    assert ctx.steps[1:5] == ["publish-instagram", "check-instagram-1", "check-instagram-2", "finish-instagram"]
    assert ctx.waits[:2] == [("wait-instagram-1", 60), ("wait-instagram-2", 60)]
    assert ctx.configs["finish-instagram"].step_semantics == StepSemantics.AT_MOST_ONCE_PER_RETRY
    ig = post_for(store, clip, "instagram")
    assert (ig["status"], ig["url"]) == ("posted", "https://www.instagram.com/reel/C1a2b3c4d5/")


@pytest.mark.parametrize(("platform", "posted"), [("youtube", True), ("instagram", False)])
def test_over_max_checks(store: db.Store, platform: str, posted: bool) -> None:
    connect(store, platform)
    clip = kept(store)
    if platform == "youtube":
        answers = [YOUTUBE_OK[0], YOUTUBE_OK[1], *[(200, "publish/youtube_uploaded")] * 2]
    else:
        answers = [
            (200, "publish/instagram_limit"),
            (200, "publish/instagram_container"),
            (200, "publish/instagram_upload"),
            *[(200, {"status_code": "IN_PROGRESS"})] * 2,
        ]
    http = FakeHttp(*answers)
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, http, cfg=cfg_with(**{platform: {"maxChecks": 2}})))
    post = post_for(store, clip, platform)
    if posted:
        assert f"posted-{platform}" in ctx.steps
        assert post["status"] == "posted"
        assert post["url"] == "https://www.youtube.com/shorts/vid123"
    else:
        assert f"post-failed-{platform}" in ctx.steps
        assert post["status"] == "failed"
        assert post["error"] == "Instagram could not finish this video. Press Try again."
    assert f"check-{platform}-3" not in ctx.steps


class InterruptingContext(FakeDurableContext):
    def __init__(self, interrupted: str) -> None:
        super().__init__()
        self.interrupted = interrupted

    def step(self, func: Any, name: str | None = None, config: Any = None) -> Any:
        if name == self.interrupted:
            self.steps.append(name)
            self.configs[name] = config
            raise StepError(message="interrupted", error_type="StepInterruptedError")
        return super().step(func, name=name, config=config)


def test_an_interrupted_at_most_once_step_asks_the_owner_to_look(store: db.Store) -> None:
    connect(store, "tiktok")
    clip = kept(store)
    store.update(db.user_pk(USER), db.clip_sk(clip["clipId"]), {"postsCreated": True})
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.post_sk("01JPOSTTIKTOK0000000000000"),
            "gsi1pk": f"CLIP#{clip['clipId']}",
            "gsi1sk": "POST#tiktok",
            "type": "post",
            "userId": USER,
            "postId": "01JPOSTTIKTOK0000000000000",
            "clipId": clip["clipId"],
            "platform": "tiktok",
            "status": "queued",
            "postOptions": TIKTOK_OPTIONS,
        }
    )
    ctx = InterruptingContext("publish-tiktok")
    run_clip_flow(ctx, event(clip), deps_for(store, FakeHttp()))
    assert ctx.configs["publish-tiktok"].step_semantics == StepSemantics.AT_MOST_ONCE_PER_RETRY
    post = post_for(store, clip, "tiktok")
    assert post["status"] == "failed"
    assert post["error"] == "We are not sure it posted. Look on TikTok before you press Try again."


def test_a_dead_token_fails_the_post_with_connect_again(store: db.Store, table: FakeTable) -> None:
    connect(store, "x")
    clip = kept(store)
    tokens = FakeTokens(dead={"x"})
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, FakeHttp(), tokens=tokens))
    post = post_for(store, clip, "x")
    assert post["status"] == "failed"
    assert post["error"] == "Connect X again in Settings › Posting › Set up posting, then press Try again."
    assert ctx.attempts["publish-x"] == 1  # never retried
    assert tokens.marked == ["x"]


def test_a_platform_401_marks_the_account(store: db.Store) -> None:
    connect(store, "youtube")
    clip = kept(store)
    tokens = FakeTokens()
    run_clip_flow(
        FakeDurableContext(), event(clip), deps_for(store, FakeHttp((401, {"error": {"code": 401}})), tokens=tokens)
    )
    assert post_for(store, clip, "youtube")["error"].startswith("Connect YouTube again")
    assert tokens.marked == ["youtube"]


def _tiktok_answers(public: bool) -> list[Any]:
    creator = {
        "data": {"creator_username": "owner", "privacy_level_options": ["PUBLIC_TO_EVERYONE", "SELF_ONLY"]},
        "error": {"code": "ok"},
    }
    complete: dict[str, Any] = {"data": {"status": "PUBLISH_COMPLETE"}, "error": {"code": "ok"}}
    return (
        [(200, creator), (200, "publish/tiktok_init"), (201, b""), (200, complete)]
        if public
        else [
            (200, creator),
            (200, "publish/tiktok_init"),
            (201, b""),
            (200, "publish/tiktok_status_complete"),
        ]
    )


def test_private_tiktok_never_joins_the_poller(store: db.Store, call: Any) -> None:
    connect(store, "tiktok")
    clip = kept(store)
    store.update(db.user_pk(USER), db.clip_sk(clip["clipId"]), {"postsCreated": True})
    _seed_post(store, clip, "tiktok", postOptions=TIKTOK_OPTIONS)
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, FakeHttp(*_tiktok_answers(public=False))))
    post = post_for(store, clip, "tiktok")
    assert (post["status"], post["privacy"], post["url"]) == ("posted", "private", "https://www.tiktok.com/@owner")
    for absent in ("statsId", "gsi2pk", "gsi2sk"):
        assert absent not in post
    assert ctx.waits[0] == ("wait-tiktok-1", 15)
    assert not [w for w in ctx.waits if w[0] and w[0].startswith("wait-tiktok-id")]


def test_public_tiktok_gets_its_id_later(store: db.Store) -> None:
    connect(store, "tiktok")
    clip = kept(store)
    store.update(db.user_pk(USER), db.clip_sk(clip["clipId"]), {"postsCreated": True})
    _seed_post(store, clip, "tiktok", postOptions={**TIKTOK_OPTIONS, "privacyLevel": "PUBLIC_TO_EVERYONE"})
    later = [
        (200, {"data": {"status": "PUBLISH_COMPLETE"}, "error": {"code": "ok"}}),
        (200, "publish/tiktok_status_complete"),
    ]
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, FakeHttp(*_tiktok_answers(public=True), *later)))
    assert "tiktok-id-1" in ctx.steps
    assert "tiktok-id-2" in ctx.steps
    assert "tiktok-id-3" not in ctx.steps
    assert ("wait-tiktok-id-1", 600) in ctx.waits
    post = post_for(store, clip, "tiktok")
    assert post["statsId"] == "7311234567890123456"
    assert post["gsi2pk"] == "STATS"
    assert post["url"] == "https://www.tiktok.com/@owner/video/7311234567890123456"


def _seed_post(store: db.Store, clip: dict[str, Any], platform: str, **fields: Any) -> None:
    post_id = "01JPOST" + platform.upper().ljust(19, "0")[:19]
    store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.post_sk(post_id),
            "gsi1pk": f"CLIP#{clip['clipId']}",
            "gsi1sk": f"POST#{platform}",
            "type": "post",
            "userId": USER,
            "postId": post_id,
            "clipId": clip["clipId"],
            "platform": platform,
            "status": "queued",
            **fields,
        }
    )


def test_x_stops_at_the_monthly_cap(store: db.Store) -> None:
    connect(store, "x")
    clip = kept(store)
    store.put({"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 9.99, "version": 1})
    http = FakeHttp()
    run_clip_flow(FakeDurableContext(), event(clip), deps_for(store, http))
    post = post_for(store, clip, "x")
    assert (post["status"], post["error"]) == ("failed", "Clip Factory stopped X at your $10 limit this month.")
    assert http.calls == []


def test_x_post_is_counted_and_credits_errors_open_the_gate(store: db.Store) -> None:
    connect(store, "x")
    clip = kept(store)
    http = FakeHttp((402, {"title": "CreditsDepleted"}))
    run_clip_flow(FakeDurableContext(), event(clip), deps_for(store, http))
    post = post_for(store, clip, "x")
    assert (
        post["error"] == "Your X credits ran out. Buy more in console.x.com › Billing › Credits, then press Try again."
    )
    budget = store.get("RATE#x", "BUDGET")
    assert budget is not None
    assert budget["monthUsd"] == 0.015
    gates = setup.item(store, USER, "x")["gates"]
    assert gates["credits"]["state"] == "action"


def test_x_full_post(store: db.Store) -> None:
    connect(store, "x")
    clip = kept(store)
    http = FakeHttp(
        (200, "publish/x_initialize"),
        (204, b""),
        (200, "publish/x_finalize"),
        (200, "publish/x_status_succeeded"),
        (201, "publish/x_tweet"),
    )
    ctx = FakeDurableContext()
    run_clip_flow(ctx, event(clip), deps_for(store, http))
    assert ctx.steps[1:4] == ["publish-x", "check-x-1", "finish-x"]
    assert ("wait-x-1", 5) in ctx.waits
    post = post_for(store, clip, "x")
    assert (post["status"], post["url"]) == ("posted", "https://x.com/owner/status/1880028300000000001")
