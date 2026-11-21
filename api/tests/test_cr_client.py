"""The Content Rewards client: links, TypeIDs, OAuth, tokens and MCP (docs/CONTRACTS.md §38.4, §38.9, §38.20)."""

from __future__ import annotations

import json
import urllib.parse
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import config, connection, ids, links, oauth
from clipfactory_api.contentrewards.mcp import CrError, McpClient, parse_body
from clipfactory_api.contentrewards.net import NetworkError
from clipfactory_api.contentrewards.tokens import CrTokens, TokenError
from clipfactory_api.oauth.secrets import SecretMissing, Secrets
from conftest import USER, Clock
from cr_support import (
    CLIENT_ID,
    CMP,
    ORG,
    TOKEN_NAME,
    UUID,
    UUID2,
    FakeCR,
    Sleeper,
    listed_campaign,
    make_deps,
    page,
    public_campaign,
    response,
    seed_connection,
    tool_error,
)
from fakes import FakeSecretsManager, FakeTable

# --- links (§38.4) -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        f"https://contentrewards.com/c/campaigns/{UUID}",
        f"https://www.contentrewards.com/c/campaigns/{UUID.upper()}/",
        f"contentrewards.com/c/campaigns/{UUID}?utm=x",
        f"https://contentrewards.com/discover/{UUID}",
        f"https://contentrewards.com/c/discover/{UUID}",
        f"https://whop.com/experiences/exp_123/campaigns/{UUID}",
    ],
)
def test_campaign_link_shapes(url: str) -> None:
    parsed = links.parse_campaign_url(url)
    assert parsed.kind == "campaign"
    assert parsed.uuid == UUID
    assert parsed.url == f"https://contentrewards.com/c/campaigns/{UUID}"


def test_group_and_refused_links() -> None:
    assert links.parse_campaign_url(f"https://contentrewards.com/c/campaigns/{UUID}?group=1").kind == "group"
    invite = links.parse_campaign_url("https://contentrewards.com/c/invite/abc123")
    assert (invite.kind, invite.text) == ("refused", links.INVITE)
    checkout = links.parse_campaign_url("https://whop.com/checkout/plan_123")
    assert (checkout.kind, checkout.text) == ("refused", links.CHECKOUT)
    for page_url in (
        "https://contentrewards.com/c/discover",
        "https://contentrewards.com/c/home",
        "https://contentrewards.com/clippedin",
    ):
        found = links.parse_campaign_url(page_url)
        assert (found.kind, found.text) == ("refused", links.CR_PAGE)
    for other in ("https://youtube.com/watch?v=abc", "https://whop.com/somewhere", "not a link", ""):
        assert links.parse_campaign_url(other).kind == "none"


def test_post_links_normalise_and_sources() -> None:
    same = [
        "https://www.youtube.com/shorts/abcDEF12345",
        "https://youtu.be/abcDEF12345?si=xyz",
        "https://m.youtube.com/watch?v=abcDEF12345&feature=share",
    ]
    assert {links.normalize_post_url(u) for u in same} == {"youtube:abcDEF12345"}
    assert links.normalize_post_url("https://www.instagram.com/reel/C1x2y3/?igsh=1") == "instagram:C1x2y3"
    assert links.normalize_post_url("https://x.com/faze/status/123") == links.normalize_post_url(
        "https://twitter.com/faze/status/123"
    )
    assert links.source_kind("https://drive.google.com/file/d/abc/view") == "google_drive"
    assert links.source_kind("https://www.dropbox.com/s/x/clip.mp4?dl=0") == "dropbox"
    assert links.source_kind("https://www.twitch.tv/faze") == "twitch"
    assert links.source_kind("http://youtube.com/watch?v=1") == "other"  # https only
    assert links.source_kind("https://evil.example/clip.mp4") == "video_file"
    assert links.offerable("https://evil.example/clip.mp4") is False


def test_channel_href_cases() -> None:
    assert links.channel_href("FaZe", "https://www.youtube.com/@FaZeClan") == "https://www.youtube.com/@FaZeClan/videos"
    assert links.channel_href("FaZe", "https://www.twitch.tv/faze/") == "https://www.twitch.tv/faze"
    assert links.channel_href("@ZooMaa", None) == "https://www.youtube.com/@ZooMaa/videos"
    follows = [{"name": "Zoo Maa", "url": "https://www.twitch.tv/zoomaa"}]
    assert links.channel_href("zoo  maa", None, follows) == "https://www.twitch.tv/zoomaa"
    assert links.channel_href("FaZe Clan", "https://evil.example/faze") == (
        "https://www.youtube.com/results?search_query=FaZe+Clan"
    )


# --- TypeIDs and matching (§38.9) -----------------------------------------------------------------------------------


def test_typeid_vectors() -> None:
    assert ids.typeid("cmp", "200ea21b-be80-4db8-b552-8e32b148604e") == "cmp_101th1qfm09pwbamme6armgr2e"
    assert ids.typeid("cmp", "a1cefc3b-4533-438f-8e70-a7299550f1cf") == "cmp_51svy3ph9k8e7rww5756an1wef"


def test_match_rules() -> None:
    public = public_campaign()
    by_typeid = listed_campaign()
    assert ids.match_campaign([by_typeid], UUID, public) == (by_typeid, "typeid")
    by_name = listed_campaign("cmp_7zzzzzzzzzzzzzzzzzzzzzzzzz")
    assert ids.match_campaign([by_name], UUID, public) == (by_name, "name")
    # after a verified mismatch the encoded id is never used
    assert ids.match_campaign([by_typeid], UUID, public, use_typeid=False) == (by_typeid, "name")
    sibling = listed_campaign("cmp_6zzzzzzzzzzzzzzzzzzzzzzzzz")
    assert ids.match_campaign([by_name, sibling], UUID, public) == (None, "ambiguous")
    other_rate = listed_campaign(
        "cmp_5zzzzzzzzzzzzzzzzzzzzzzzzz", platforms=[{"platform": "youtube", "rate": {"currency": "usd", "value": 999}}]
    )
    assert ids.match_campaign([other_rate], UUID, public) == (None, "none")
    other_org = listed_campaign("cmp_4zzzzzzzzzzzzzzzzzzzzzzzzz", org="org_0zzzzzzzzzzzzzzzzzzzzzzzzz")
    assert ids.match_campaign([other_org], UUID, public) == (None, "none")
    assert ids.match_campaign([], UUID2, None) == (None, "none")
    assert ORG.startswith("org_")


# --- OAuth (§38.9) --------------------------------------------------------------------------------------------------


def test_registration_body_and_429() -> None:
    fake = FakeCR()
    found = oauth.register(fake, Clock().now)
    request, _timeout = fake.requests[0]
    body = json.loads(request.body or b"{}")
    assert body == {
        "client_name": "Clip Factory",
        "redirect_uris": [f"http://127.0.0.1:{p}/" for p in (47811, 47812, 47813, 47814, 47815)],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }
    assert "client_secret" not in body
    assert "jwks" not in body
    assert found["clientId"] == CLIENT_ID
    assert found["extra"] == {"registration_access_token": "rat_secret"}
    fake.registers.append(response(429, {"error": "temporarily_unavailable"}, {"Retry-After": "7"}))
    with pytest.raises(oauth.OAuthFail) as caught:
        oauth.register(fake, Clock().now)
    assert (caught.value.kind, caught.value.retry_after) == ("rate", 7.0)


def test_authorize_url_is_exact() -> None:
    url = oauth.authorize_url("cli_1", 47813, "v1.state", "c" * 43)
    parts = urllib.parse.urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == "https://id.contentrewards.com/oauth2/authorize"
    pairs = urllib.parse.parse_qsl(parts.query)
    names = [k for k, _v in pairs]
    assert len(names) == len(set(names))  # exactly one of each
    q = dict(pairs)
    assert q == {
        "response_type": "code",
        "client_id": "cli_1",
        "redirect_uri": "http://127.0.0.1:47813/",
        "scope": "org:read campaigns:read submissions:read earnings:read my_submissions:write",
        "state": "v1.state",
        "code_challenge": "c" * 43,
        "code_challenge_method": "S256",
        "resource": "https://mcp.contentrewards.com/mcp",
    }
    assert "%20" in parts.query
    assert "+" not in parts.query


# --- secrets (additive, §38.9) --------------------------------------------------------------------------------------


def test_secrets_versions_and_put_only() -> None:
    client = FakeSecretsManager()
    secrets = Secrets(client)
    first = secrets.write("cf-prod/platforms/contentrewards/token", {"a": 1})
    second = secrets.write("cf-prod/platforms/contentrewards/token", {"a": 2})
    assert first
    assert second
    assert first != second
    assert secrets.read("cf-prod/platforms/contentrewards/token", version_id=first) == {"a": 1}
    assert secrets.read("cf-prod/platforms/contentrewards/token", version_id=second) == {"a": 2}
    with pytest.raises(SecretMissing):
        secrets.write("cf-prod/platforms/contentrewards/gone", {"a": 1}, create=False)
    assert "cf-prod/platforms/contentrewards/gone" not in client.values
    assert secrets.write("cf-prod/platforms/x/app", {"k": 1}) != ""  # old callers: create-or-put as before


# --- tokens (§38.9) -------------------------------------------------------------------------------------------------


@pytest.fixture
def setup() -> tuple[Any, FakeCR, FakeSecretsManager, Clock]:
    clock = Clock()
    client = FakeSecretsManager()
    fake = FakeCR()
    deps = make_deps(db.Store(FakeTable()), client, fake, clock)
    return deps, fake, client, clock


def test_fresh_token_is_used_without_refresh(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(minutes=5))
    assert deps.tokens().access(USER).token == "at_0"
    assert fake.token_forms() == []


def test_refresh_writes_put_only_before_use_and_sets_the_version(setup: Any) -> None:
    deps, fake, client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=60))
    got = deps.tokens().access(USER)
    assert got.token == "at_1"
    forms = fake.token_forms()
    assert forms == [
        {
            "grant_type": ["refresh_token"],
            "refresh_token": ["rt_0"],
            "client_id": [CLIENT_ID],
            "resource": [config.MCP_URL],
        }
    ]
    conn = connection.load(deps.store, USER)
    assert "refreshLeaseUntil" not in conn
    assert json.loads(client.versions[TOKEN_NAME][conn["tokenVersionId"]])["refreshToken"] == "rt_1"
    assert client.writes[-1] == ("put", TOKEN_NAME)  # put-only: never a create
    assert conn["tokenIssuedAt"] == iso(clock.now)


def test_the_lease_needs_20_seconds_of_lambda(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    deps.remaining = lambda: 19.0
    with pytest.raises(TokenError) as caught:
        deps.tokens().access(USER)
    assert caught.value.kind == "down"
    assert fake.token_forms() == []


def test_two_refreshers_make_one_refresh(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    pk, sk = db.user_pk(USER), db.CRCONN_SK
    deps.store.update(pk, sk, {"refreshLeaseUntil": iso(clock.now + timedelta(seconds=30))})  # another holds it
    other = CrTokens(deps.store, deps.secrets, fake, clock)

    def sleep_and_refresh(_seconds: float) -> None:
        if not fake.token_forms():  # the lease holder refreshes while we wait
            deps.store.update(pk, sk, {}, remove=["refreshLeaseUntil"])
            other.access(USER)
            deps.store.update(pk, sk, {"refreshLeaseUntil": iso(clock.now + timedelta(seconds=30))})

    mine = CrTokens(deps.store, deps.secrets, fake, clock, sleep_and_refresh)
    assert mine.access(USER).token == "at_1"
    assert len(fake.token_forms()) == 1


def test_lost_answer_retries_the_same_refresh_token_once(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    fake.tokens = [NetworkError("timeout", sent=True), fake.token_ok()]
    assert deps.tokens().access(USER).token.startswith("at_")
    forms = fake.token_forms()
    assert [f["refresh_token"] for f in forms] == [["rt_0"], ["rt_0"]]


def test_429_waits_then_tries_once(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    sleeper = Sleeper()
    deps.sleep = sleeper
    fake.tokens = [response(429, {"error": "slow_down"}, {"Retry-After": "4"}), fake.token_ok()]
    assert deps.tokens().access(USER).token.startswith("at_")
    assert 4.0 in sleeper.slept
    assert len(fake.token_forms()) == 2


def test_a_stale_version_is_never_refreshed(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"tokenIssuedAt": iso(clock.now + timedelta(minutes=1))})
    with pytest.raises(TokenError) as caught:
        deps.tokens().access(USER)
    assert caught.value.kind == "busy"
    assert fake.token_forms() == []


def test_disconnect_during_a_refresh_throws_the_result_away(setup: Any) -> None:
    deps, fake, client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))

    def answer_then_disconnect(request: Any, timeout: float) -> Any:
        if request.url == config.TOKEN_URL:
            client.delete_secret(SecretId=TOKEN_NAME, ForceDeleteWithoutRecovery=True)
            deps.store.update(db.user_pk(USER), db.CRCONN_SK, {"status": "not_connected"})
        return fake(request, timeout)

    deps.net = answer_then_disconnect
    with pytest.raises(TokenError) as caught:
        CrTokens(deps.store, deps.secrets, deps.net, clock).access(USER)
    assert caught.value.kind == "not_connected"
    assert TOKEN_NAME not in client.values  # never re-created
    assert fake.revoked == ["rt_1"]


def test_invalid_grant_needs_reconnect(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(seconds=30))
    fake.tokens = [response(400, {"error": "invalid_grant"})]
    with pytest.raises(TokenError) as caught:
        deps.tokens().access(USER)
    assert caught.value.kind == "dead"
    conn = connection.load(deps.store, USER)
    assert (conn["status"], conn["reason"]) == ("needs_reconnect", "token_dead")


def test_daily_keep_alive(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now, expires_in=timedelta(minutes=9))
    assert deps.tokens().keep_alive(USER, clock.now) == "fresh"
    clock.now += timedelta(hours=25)
    assert deps.tokens().keep_alive(USER, clock.now) == "refreshed"
    assert len(fake.token_forms()) == 1


def test_the_90_days() -> None:
    now = Clock().now
    item = {"status": "connected", "signInBy": iso(now + timedelta(days=6)), "connectedAt": iso(now)}
    assert connection.effective(item, now) == ("connected", "expires_soon")
    assert connection.effective(item, now + timedelta(days=7)) == ("needs_reconnect", "signed_out_90_days")
    assert connection.effective({**item, "signInBy": iso(now + timedelta(days=30))}, now) == ("connected", None)


# --- MCP (§38.9) ----------------------------------------------------------------------------------------------------


def test_mcp_headers_timeouts_and_initialize_once(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now)
    fake.answer("get_me", {"id": "cre_1"})
    fake.answer("create_my_submission", {"id": "sub_1", "status": "pending"})
    client = deps.mcp(USER)
    client.call("get_me", {})
    client.call("get_me", {})
    client.call("create_my_submission", {"campaign": CMP, "url": "u", "idempotency_key": "k"}, timeout=30)
    methods = [json.loads(r.body or b"{}").get("method") for r, _t in fake.requests]
    assert methods.count("initialize") == 1
    assert methods.count("notifications/initialized") == 1
    for request, timeout in fake.requests:
        assert "Origin" not in request.headers
        assert "origin" not in {k.lower() for k in request.headers}
        assert request.headers["Api-Version"] == "2026-10-01"
        assert request.headers["MCP-Protocol-Version"] == "2025-11-25"
        assert request.headers["User-Agent"] == "ClipFactory/1"
        assert request.headers["Accept"] == "application/json, text/event-stream"
        assert timeout in (10.0, 30)
    calls = fake.calls()
    assert [h["Mcp-Name"] for _a, h, _t in calls] == ["get_me", "get_me", "create_my_submission"]
    assert [t for _a, _h, t in calls] == [10.0, 10.0, 30]


def test_event_stream_body_and_is_error() -> None:
    stream = response(
        200,
        b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n',
        {"Content-Type": "text/event-stream"},
    )
    assert parse_body(stream) == {"jsonrpc": "2.0", "id": 1, "result": {"ok": 1}}


def test_tool_errors_and_http_errors(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now)
    fake.answer("get_my_balance", tool_error("rate_limited", "Try again in 12 seconds."))
    with pytest.raises(CrError) as caught:
        deps.mcp(USER).call("get_my_balance", {})
    assert (caught.value.code, caught.value.retry_after, caught.value.tool_result) == ("rate_limited", 12.0, True)
    fake.mcp_http = [response(403, b"")]
    with pytest.raises(CrError) as caught:
        deps.mcp(USER).call("get_my_balance", {})
    assert caught.value.code == "firewall"  # retry later, CRCONN untouched
    assert not connection.load(deps.store, USER).get("blocked")
    fake.mcp_http = [response(403, {"code": "permission_denied", "detail": "Origin"})]
    with pytest.raises(CrError) as caught:
        deps.mcp(USER).call("get_my_balance", {})
    assert connection.load(deps.store, USER)["blocked"] is True
    fake.answer("get_my_balance", {"available": {"currency": "usd", "value": 1}})
    deps.mcp(USER).call("get_my_balance", {})
    assert "blocked" not in connection.load(deps.store, USER)  # cleared by the next successful call
    fake.mcp_http = [
        response(403, {"code": "insufficient_scope"}, {"WWW-Authenticate": 'Bearer scope="my_submissions:write"'})
    ]
    with pytest.raises(CrError):
        deps.mcp(USER).call("get_my_balance", {})
    conn = connection.load(deps.store, USER)
    assert (conn["status"], conn["canSubmit"], conn["missing"]) == ("read_only", False, ["my_submissions:write"])


def test_401_refreshes_once_then_needs_reconnect(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now)
    fake.answer("get_me", {"id": "cre_1"})
    fake.mcp_http = [response(401, {"code": "invalid_token"})]
    assert deps.mcp(USER).call("get_me", {}) == {"id": "cre_1"}
    assert len(fake.token_forms()) == 1
    fake.mcp_http = [response(401, {"code": "invalid_token"}), response(401, {"code": "invalid_token"})]
    with pytest.raises(CrError):
        deps.mcp(USER).call("get_me", {})
    assert connection.load(deps.store, USER)["status"] == "needs_reconnect"


def test_paging_to_the_end_with_caps_and_invalid_cursor(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now)
    a, b = listed_campaign(), listed_campaign(CMP.replace("cmp_1", "cmp_2"))
    fake.answer("list_my_campaigns", page([a], more=True, cursor="c1"), page([b]))
    rows, complete = deps.mcp(USER).list_all("list_my_campaigns", {"status": ["active", "paused"]}, 20)
    assert complete
    assert [r["id"] for r in rows] == [a["id"], b["id"]]
    assert [args.get("cursor") for args, _h, _t in fake.calls("list_my_campaigns")] == [None, "c1"]
    assert all(args["limit"] == 25 for args, _h, _t in fake.calls("list_my_campaigns"))
    fake.answer("list_my_campaigns", page([a], more=True, cursor="c1"))
    rows, complete = deps.mcp(USER).list_all("list_my_campaigns", {}, 2)
    assert not complete  # a capped list: nothing becomes "left" on this read
    fake.answer("list_my_campaigns", page([a], more=True, cursor="c1"), tool_error("invalid_cursor"), page([b]))
    rows, complete = deps.mcp(USER).list_all("list_my_campaigns", {}, 20)
    assert complete
    assert [r["id"] for r in rows] == [b["id"]]


def test_two_calls_a_second(setup: Any) -> None:
    deps, fake, _client, clock = setup
    seed_connection(deps, USER, clock.now)
    fake.answer("get_me", {"id": "cre_1"})
    sleeper = Sleeper()
    times = iter([0.0, 0.0, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 1.5, 1.5, 1.6, 1.6, 1.7, 1.7])
    client = McpClient(fake, deps.tokens(), USER, clock, sleep=sleeper, monotonic=lambda: next(times, 2.0))
    client.initialized = True
    for _ in range(3):
        client.call("get_me", {})
    assert sleeper.slept
    assert sleeper.slept[0] > 0


def test_organization_falls_back_to_the_brand_name() -> None:
    public = public_campaign()
    row = {
        **listed_campaign("cmp_7zzzzzzzzzzzzzzzzzzzzzzzzz", org="org_7zzzzzzzzzzzzzzzzzzzzzzzzz"),
        "brand_account": {"name": "ClippedIn"},
    }
    assert ids.match_campaign([row], UUID, public) == (row, "name")  # the org TypeID never matched: the brand
    other = {**row, "brand_account": {"name": "Someone Else"}}
    assert ids.match_campaign([other], UUID, public) == (None, "none")
