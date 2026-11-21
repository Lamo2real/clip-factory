"""Waiting posts go out once their place is connected (docs/CONTRACTS.md §17.6, §33.3, §33.6): the shared release,
the OAuth callback, the Meta account pick, Check it, and Post now (Confirm with ``platforms``)."""

from __future__ import annotations

import json
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, hooks, release
from clipfactory_api.flow_client import FlowClient
from clipfactory_api.oauth import OAuthEnv, setup
from conftest import APP_URL, CLIP_FLOW_ARN, JOB_FLOW_ARN, NOW, USER, Call, Clock, seed_clip
from fakes import FakeHttp, FakeLambda, FakeSecretsManager, FakeSSM, FakeTable
from test_oauth_callback import IG_ME, IG_ONE, IG_TWO, META_LONG, META_TOKEN
from test_oauth_state_formats import GOOD

PK = db.user_pk(USER)
TIKTOK = {
    "privacyLevel": "PUBLIC_TO_EVERYONE",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}


def _connect(store: db.Store, platform: str, status: str = "connected") -> None:
    store.put(
        {
            "pk": PK,
            "sk": f"ACCOUNT#{platform}",
            "type": "account",
            "userId": USER,
            "platform": platform,
            "status": status,
        }
    )


def _clip(store: db.Store, status: str = "posted", **fields: Any) -> dict[str, Any]:
    return seed_clip(store, status=status, publishState="started", postsCreated=True, flowRun=1, **fields)


def _post(store: db.Store, clip: dict[str, Any], platform: str, status: str, **fields: Any) -> str:
    post_id = f"P{platform}{clip['clipId'][-6:]}"
    store.put(
        {
            "pk": PK,
            "sk": db.post_sk(post_id),
            "gsi1pk": f"CLIP#{clip['clipId']}",
            "gsi1sk": f"POST#{platform}",
            "type": "post",
            "userId": USER,
            "postId": post_id,
            "clipId": clip["clipId"],
            "platform": platform,
            "status": status,
            **fields,
        }
    )
    ids = list((store.get(clip["pk"], clip["sk"]) or {}).get("postIds") or [])
    store.update(clip["pk"], clip["sk"], {"postIds": [*ids, post_id]})
    return post_id


def _starts(lambda_client: FakeLambda) -> list[str]:
    return [c["DurableExecutionName"] for c in lambda_client.calls if c["FunctionName"] == CLIP_FLOW_ARN]


@pytest.fixture
def flows(lambda_client: FakeLambda) -> FlowClient:
    return FlowClient(lambda_client, JOB_FLOW_ARN, CLIP_FLOW_ARN)


# --- the shared release -----------------------------------------------------------------------------------------


def test_connected_place_releases_waiting_posts_and_starts_a_new_run(
    store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda
) -> None:
    _connect(store, "instagram")
    posted = _clip(store)
    _post(store, posted, "youtube", "posted")
    ig = _post(store, posted, "instagram", "pending_integration", error="old", publishHandle={"container": "c"})
    fb = _post(store, posted, "facebook", "pending_integration")  # another place, not connected
    failed = _clip(store, status="failed")
    ig_failed = _post(store, failed, "instagram", "pending_integration")
    assert release.release_waiting(store, flows, USER, "instagram") == 2
    stored = table.raw(PK, db.post_sk(ig))
    assert stored is not None
    assert stored["status"] == "queued"
    assert "error" not in stored
    assert "publishHandle" not in stored
    assert (table.raw(PK, db.post_sk(fb)) or {})["status"] == "pending_integration"
    assert (table.raw(PK, db.post_sk(ig_failed)) or {})["status"] == "queued"
    clip = table.raw(posted["pk"], posted["sk"]) or {}
    assert (clip["status"], clip["flowRun"], clip["publishState"]) == ("posted", 2, "started")
    assert (table.raw(failed["pk"], failed["sk"]) or {})["status"] == "confirmed"  # like Try again
    assert sorted(_starts(lambda_client)) == sorted([f"clip-{posted['clipId']}-2", f"clip-{failed['clipId']}-2"])


def test_a_campaign_post_waits_for_post_now_while_a_normal_one_is_released(
    store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda
) -> None:
    """§39.3: a Content Rewards campaign post is never released by itself when its account comes back (the campaign
    may have ended or been held meanwhile): it waits for Post now, which runs the fit check. A normal post still
    goes, and a campaign clip's start that never went through is still finished."""
    _connect(store, "instagram")
    campaign = _clip(store, campaignId="200ea21b-be80-4db8-b552-8e32b148604e")
    waiting = _post(
        store, campaign, "instagram", "pending_integration", campaignId="200ea21b-be80-4db8-b552-8e32b148604e"
    )
    normal = _clip(store)
    released = _post(store, normal, "instagram", "pending_integration")
    assert release.release_waiting(store, flows, USER, "instagram") == 1
    assert (table.raw(PK, db.post_sk(waiting)) or {})["status"] == "pending_integration"
    assert (table.raw(PK, db.post_sk(released)) or {})["status"] == "queued"
    assert _starts(lambda_client) == [f"clip-{normal['clipId']}-2"]
    unstarted = seed_clip(
        store,
        status="confirmed",
        publishState="pending",
        postsCreated=True,
        flowRun=1,
        campaignId="200ea21b-be80-4db8-b552-8e32b148604e",
    )
    _post(store, unstarted, "instagram", "queued", campaignId="200ea21b-be80-4db8-b552-8e32b148604e")
    assert release.release_waiting(store, flows, USER, "instagram") == 0
    assert f"clip-{unstarted['clipId']}-1" in _starts(lambda_client)  # Confirm checked the fit moments before


def test_not_connected_changes_nothing(
    store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda
) -> None:
    _connect(store, "instagram", status="needs_reconnect")
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    assert release.release_waiting(store, flows, USER, "instagram") == 0
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "pending_integration"
    assert _starts(lambda_client) == []


@pytest.mark.parametrize("status", ["review", "publishing", "declined"])
def test_only_uploaded_and_settled_clips_are_released(
    store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda, status: str
) -> None:
    _connect(store, "instagram")
    clip = _clip(store, status=status)
    ig = _post(store, clip, "instagram", "pending_integration")
    assert release.release_waiting(store, flows, USER, "instagram") == 0
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "pending_integration"
    assert (table.raw(clip["pk"], clip["sk"]) or {})["flowRun"] == 1
    assert _starts(lambda_client) == []


def test_repeating_is_a_no_op(store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda) -> None:
    _connect(store, "instagram")
    clip = _clip(store, status="confirmed")
    _post(store, clip, "instagram", "pending_integration")
    assert release.release_waiting(store, flows, USER, "instagram") == 1
    assert release.release_waiting(store, flows, USER, "instagram") == 0
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2"]
    assert (table.raw(clip["pk"], clip["sk"]) or {})["flowRun"] == 2


def test_a_failed_flow_start_stays_retryable(
    store: db.Store, table: FakeTable, flows: FlowClient, lambda_client: FakeLambda
) -> None:
    _connect(store, "instagram")
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    lambda_client.fail = True
    assert release.release_waiting(store, flows, USER, "instagram") == 1  # no exception reaches the caller
    stored = table.raw(clip["pk"], clip["sk"]) or {}
    assert (stored["flowRun"], stored["publishState"]) == (2, "pending")
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "queued"
    lambda_client.fail = False
    # The next release (another connect, Check it) finishes the start of the same run: no run 3.
    assert release.release_waiting(store, flows, USER, "instagram") == 0
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2", f"clip-{clip['clipId']}-2"]
    stored = table.raw(clip["pk"], clip["sk"]) or {}
    assert (stored["flowRun"], stored["publishState"]) == (2, "started")


def test_one_broken_clip_never_stops_the_others(
    store: db.Store, table: FakeTable, flows: FlowClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _connect(store, "instagram")
    first = _clip(store, clipId="01JAAAAAAAAAAAAAAAAAAAAAA1")
    second = _clip(store, clipId="01JAAAAAAAAAAAAAAAAAAAAAA2")
    _post(store, first, "instagram", "pending_integration")
    ok = _post(store, second, "instagram", "pending_integration")
    real = release.restart

    def broken(store_: db.Store, flows_: Any, clip: Any, *args: Any, **kwargs: Any) -> Any:
        if clip["clipId"] == first["clipId"]:
            raise RuntimeError("boom")
        return real(store_, flows_, clip, *args, **kwargs)

    monkeypatch.setattr(release, "restart", broken)
    assert release.release_waiting(store, flows, USER, "instagram") == 1
    assert (table.raw(PK, db.post_sk(ok)) or {})["status"] == "queued"


def test_out_of_time_leaves_the_rest_waiting(store: db.Store, table: FakeTable, flows: FlowClient) -> None:
    _connect(store, "instagram")
    clips = [_clip(store, clipId=f"01JAAAAAAAAAAAAAAAAAAAAAB{n}") for n in range(3)]
    ids = [_post(store, c, "instagram", "pending_integration") for c in clips]
    # A clip only starts while one slow clip still fits before the answer is due (the caller's deadline).
    ticks = iter([0.0, 0.5, 1.5])
    deadline = release.CLIP_SECONDS + 1.0
    assert release.release_waiting(store, flows, USER, "instagram", deadline=deadline, clock=lambda: next(ticks)) == 2
    assert [(table.raw(PK, db.post_sk(i)) or {})["status"] for i in ids] == ["queued", "queued", "pending_integration"]


def test_tiktok_waits_for_the_owners_choice(store: db.Store, table: FakeTable, flows: FlowClient) -> None:
    _connect(store, "tiktok")
    bare = _clip(store)
    chosen = _clip(store)
    no_choice = _post(store, bare, "tiktok", "pending_integration")
    with_choice = _post(store, chosen, "tiktok", "pending_integration", postOptions=dict(TIKTOK))
    assert release.release_waiting(store, flows, USER, "tiktok") == 1
    assert (table.raw(PK, db.post_sk(no_choice)) or {})["status"] == "pending_integration"
    assert (table.raw(PK, db.post_sk(with_choice)) or {})["status"] == "queued"


def test_the_release_reads_the_account_strongly_consistent(
    store: db.Store, table: FakeTable, flows: FlowClient
) -> None:
    _connect(store, "instagram")
    clip = _clip(store)
    _post(store, clip, "instagram", "pending_integration")
    table.calls.clear()
    assert release.release_waiting(store, flows, USER, "instagram") == 1
    account_reads = [
        kw for name, kw in table.calls if name == "query" and "ACCOUNT#" in kw["ExpressionAttributeValues"].values()
    ]
    assert account_reads
    assert all(kw.get("ConsistentRead") for kw in account_reads)


# --- one run per place: two Post now taps never send one video twice ------------------------------------------------


def _flow_deps(store: db.Store, adapters: dict[str, Any]) -> Any:
    from test_flows import _clip_deps

    return _clip_deps(store, adapters)


def test_a_second_post_now_starts_a_run_for_its_own_place_only(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    from clipfactory_api.flows.clip_flow import run_clip_flow
    from fakes import FakeDurableContext
    from test_flows import FakeAdapter

    _connect(store, "instagram")
    _connect(store, "facebook")
    clip = _clip(store)
    _post(store, clip, "youtube", "posted")
    ig = _post(store, clip, "instagram", "pending_integration")
    fb = _post(store, clip, "facebook", "pending_integration")
    # Post now, Instagram; a moment later Post now, Facebook, while run 2 is still uploading Instagram.
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})[0] == 200
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["facebook"]})[0] == 200
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2", f"clip-{clip['clipId']}-3"]
    assert (table.raw(PK, db.post_sk(ig)) or {})["flowRun"] == 2
    assert (table.raw(PK, db.post_sk(fb)) or {})["flowRun"] == 3
    adapters = {"instagram": FakeAdapter("instagram"), "facebook": FakeAdapter("facebook")}
    event = {"clipId": clip["clipId"], "userId": USER}
    run_clip_flow(FakeDurableContext(), {**event, "run": 3}, _flow_deps(store, adapters))
    assert adapters["facebook"].published == [fb]
    assert adapters["instagram"].published == []  # run 2's post: run 3 leaves it alone
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "queued"
    run_clip_flow(FakeDurableContext(), {**event, "run": 2}, _flow_deps(store, adapters))
    assert adapters["instagram"].published == [ig]
    assert adapters["facebook"].published == [fb]  # sent once


def test_a_run_that_never_started_hands_its_posts_to_the_new_run(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "instagram")
    _connect(store, "facebook")
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    fb = _post(store, clip, "facebook", "pending_integration")
    lambda_client.fail = True
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})[0] == 200
    assert (table.raw(clip["pk"], clip["sk"]) or {})["publishState"] == "pending"  # run 2 never started
    lambda_client.fail = False
    code, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["facebook"]})
    assert code == 200
    assert "startPending" not in body["clip"]
    assert (table.raw(PK, db.post_sk(ig)) or {})["flowRun"] == 3  # nobody would ever start run 2
    assert (table.raw(PK, db.post_sk(fb)) or {})["flowRun"] == 3
    stored = table.raw(clip["pk"], clip["sk"]) or {}
    assert (stored["flowRun"], stored["publishState"]) == (3, "started")


def test_posts_made_by_upload_belong_to_the_first_run(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "instagram")
    clip = seed_clip(store, status="review")
    assert call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})[0] == 200
    made = [i for i in table.all() if i.get("type") == "post" and i.get("clipId") == clip["clipId"]]
    assert [i["flowRun"] for i in made] == [1]
    _, listed = call("GET", "/v1/posts", query={"clipId": clip["clipId"]})
    assert listed["posts"]
    assert all("flowRun" not in p for p in listed["posts"])


# --- a start that did not go through: the Library offers Try again (startPending) ------------------------------------


def test_a_stuck_start_shows_as_start_pending_and_try_again_finishes_it(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    _connect(store, "instagram")
    clip = _clip(store)
    _post(store, clip, "youtube", "posted")
    _post(store, clip, "instagram", "pending_integration")
    lambda_client.fail = True
    assert release.release_waiting(store, FlowClient(lambda_client, JOB_FLOW_ARN, CLIP_FLOW_ARN), USER, "instagram")
    _, got = call("GET", f"/v1/clips/{clip['clipId']}")
    assert got["clip"]["startPending"] is True
    assert "publishState" not in got["clip"]
    lambda_client.fail = False
    # The big Try again sends no places: on a posted clip it finishes the start of the same run.
    code, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {})
    assert code == 200
    assert "startPending" not in body["clip"]
    assert _starts(lambda_client)[-1] == f"clip-{clip['clipId']}-2"
    assert (table.raw(clip["pk"], clip["sk"]) or {})["publishState"] == "started"


# --- automatic: the OAuth callback, the Meta pick, Check it --------------------------------------------------------


@pytest.fixture
def hooks_deps(store: db.Store, oauth_env: OAuthEnv, clock: Clock, flows: FlowClient) -> hooks.HooksDeps:
    return hooks.HooksDeps(
        store=store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=clock,
        oauth=oauth_env,
        flows=flows,
    )


def _connect_instagram(call: Call, hooks_deps: hooks.HooksDeps, http: FakeHttp, pages: dict[str, Any]) -> str:
    assert call("PUT", "/v1/setup/instagram/keys", GOOD["instagram"])[0] == 200
    _, body = call("POST", "/v1/accounts/instagram/connect")
    signed = str(parse_qs(urlsplit(body["authorizeUrl"]).query)["state"][0])
    http.answers.extend([(200, META_TOKEN), (200, META_LONG), (200, IG_ME), (200, pages)])
    event = {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "pathParameters": {"platform": "instagram"},
        "queryStringParameters": {"code": "C", "state": signed},
        "requestContext": {"requestId": "rest-1"},
    }
    out = hooks.handle(event, hooks_deps)
    assert out["statusCode"] == 302
    return str(out["headers"]["location"]).rsplit("result=", 1)[1]


def test_the_oauth_callback_releases_waiting_posts(
    call: Call,
    store: db.Store,
    table: FakeTable,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    lambda_client: FakeLambda,
) -> None:
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    assert _connect_instagram(call, hooks_deps, http, IG_ONE) == "connected"
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "queued"
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2"]


def test_the_callback_stays_connected_when_the_release_fails(
    call: Call,
    store: db.Store,
    table: FakeTable,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")

    def broken(*_: Any, **__: Any) -> int:
        raise RuntimeError("boom")

    monkeypatch.setattr(release, "release_waiting", broken)
    assert _connect_instagram(call, hooks_deps, http, IG_ONE) == "connected"
    assert (store.get(PK, "ACCOUNT#instagram") or {})["status"] == "connected"
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "pending_integration"
    assert "oauth.release_failed" in capsys.readouterr().out


def test_the_callback_survives_a_failing_flow_start(
    call: Call,
    store: db.Store,
    table: FakeTable,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    lambda_client: FakeLambda,
) -> None:
    clip = _clip(store)
    _post(store, clip, "instagram", "pending_integration")
    lambda_client.fail = True
    assert _connect_instagram(call, hooks_deps, http, IG_ONE) == "connected"
    assert (table.raw(clip["pk"], clip["sk"]) or {})["publishState"] == "pending"


def test_the_callback_deadline_counts_from_the_start_of_the_request(
    call: Call,
    store: db.Store,
    table: FakeTable,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[float] = []
    real = release.release_waiting

    def spy(*args: Any, deadline: float | None = None, **kwargs: Any) -> int:
        assert deadline is not None
        seen.append(deadline - time.monotonic())
        return real(*args, deadline=deadline, **kwargs)

    monkeypatch.setattr(release, "release_waiting", spy)
    assert _connect_instagram(call, hooks_deps, http, IG_ONE) == "connected"
    # The code exchange and the writes ran first: less than the whole answer time is left for the release.
    assert seen
    assert 0 < seen[0] < release.ANSWER_SECONDS


def test_the_meta_account_pick_releases_waiting_posts(
    call: Call,
    store: db.Store,
    table: FakeTable,
    hooks_deps: hooks.HooksDeps,
    http: FakeHttp,
    lambda_client: FakeLambda,
) -> None:
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    assert _connect_instagram(call, hooks_deps, http, IG_TWO) == "choose"
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "pending_integration"
    status, _ = call("POST", "/v1/accounts/instagram/choose", {"accountId": "1785"})
    assert status == 200
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "queued"
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2"]


def test_check_it_that_reconnects_releases_waiting_posts(
    call: Call, store: db.Store, table: FakeTable, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    from test_setup_routes import connect_account, put_token, save_keys

    save_keys(call, "x")
    connect_account(store, "x")
    setup.mark_account(store, USER, "x", NOW, status="needs_reconnect", reason="token_dead")
    put_token(secrets_client, "x", {"accessToken": "AT", "expiresAt": "2026-11-15T14:00:00.000Z", "username": "me"})
    clip = _clip(store)
    x = _post(store, clip, "x", "pending_integration")
    http.answers.extend([(400, {"error": "invalid_request"}), (200, {"data": {"id": "1"}})])
    _, body = call("POST", "/v1/setup/x/check")
    assert body["setup"]["account"]["status"] == "connected"
    assert (table.raw(PK, db.post_sk(x)) or {})["status"] == "queued"


# --- manual: Post now (Confirm with platforms) ----------------------------------------------------------------------


@pytest.mark.parametrize("status", ["posted", "failed", "confirmed"])
def test_post_now_sends_a_waiting_place_that_is_connected(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda, status: str
) -> None:
    _connect(store, "instagram")
    clip = _clip(store, status=status)
    ig = _post(store, clip, "instagram", "pending_integration")
    fb = _post(store, clip, "facebook", "pending_integration")
    code, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})
    assert code == 200
    by = {p["platform"]: p["status"] for p in body["posts"]}
    assert by == {"instagram": "queued", "facebook": "pending_integration"}
    assert (table.raw(PK, db.post_sk(fb)) or {})["status"] == "pending_integration"
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "queued"
    assert _starts(lambda_client) == [f"clip-{clip['clipId']}-2"]
    assert body["clip"]["status"] == ("confirmed" if status == "failed" else status)


def test_post_now_for_a_place_not_connected_is_a_plain_400(
    call: Call, store: db.Store, table: FakeTable, lambda_client: FakeLambda
) -> None:
    clip = _clip(store)
    ig = _post(store, clip, "instagram", "pending_integration")
    code, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["instagram"]})
    assert code == 400
    assert body["error"]["message"] == "Instagram is not set up yet. Turn it off, then tap Upload."
    assert (table.raw(PK, db.post_sk(ig)) or {})["status"] == "pending_integration"
    assert _starts(lambda_client) == []


def test_post_now_on_tiktok_needs_the_owners_choice(call: Call, store: db.Store, table: FakeTable) -> None:
    _connect(store, "tiktok")
    clip = _clip(store)
    tt = _post(store, clip, "tiktok", "pending_integration")
    code, body = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["tiktok"]})
    assert code == 400
    assert body["error"]["message"] == "Pick who can see it on TikTok."
    code, _ = call("POST", f"/v1/clips/{clip['clipId']}/confirm", {"platforms": ["tiktok"], "tiktok": TIKTOK})
    assert code == 200
    stored = table.raw(PK, db.post_sk(tt)) or {}
    assert stored["status"] == "queued"
    assert stored["postOptions"] == TIKTOK


def test_hooks_env_starts_the_clip_flow_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    import boto3

    made: list[str] = []

    class Client:
        def __init__(self, name: str) -> None:
            made.append(name)

    monkeypatch.setattr(boto3, "client", lambda name, **_: Client(name))
    monkeypatch.setenv("TABLE_NAME", "cf-prod-data")
    monkeypatch.setenv("APP_URL", APP_URL)
    monkeypatch.delenv("OAUTH_STATE_SECRET", raising=False)
    monkeypatch.setenv("CLIP_FLOW_ARN", CLIP_FLOW_ARN)
    monkeypatch.setattr("clipfactory_api.app.table", lambda name: object())
    deps = hooks._from_env()
    assert isinstance(deps.flows, FlowClient)
    assert deps.flows.clip_flow_arn == CLIP_FLOW_ARN
    assert "lambda" in made
    monkeypatch.delenv("CLIP_FLOW_ARN")
    assert hooks._from_env().flows is None


def test_release_logs_the_clip_and_the_place(
    store: db.Store, flows: FlowClient, capsys: pytest.CaptureFixture[str]
) -> None:
    _connect(store, "instagram")
    clip = _clip(store)
    _post(store, clip, "instagram", "pending_integration")
    release.release_waiting(store, flows, USER, "instagram")
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    released = [line for line in lines if line["event"] == "clip.released"]
    assert released
    assert released[0]["platforms"] == "instagram"
