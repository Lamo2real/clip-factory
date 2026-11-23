"""Lamo Stories' own OAuth callback, Clip Factory's forward of ``w1.`` states, and the ``v1.`` refusal
(docs/CONTRACTS.md §45.13.3, §45.17, §45.30, ADR-72).

* ``GET /v1/stories-oauth/{platform}/callback`` (public, on Lamo Stories' own Lambda): ``w1.`` states write only
  ``SOCIAL#`` and ``cf-prod/workspaces/…`` secrets and always land on ``/stories/connections`` (expired, replayed,
  failing or missing their workspace too), with the keys and redirect URI of the app chosen at Connect;
* Clip Factory's callback (``cf-prod-hooks``) only forwards a ``w1.`` state there, with the query unchanged, and
  touches nothing; a ``v1.`` state whose item names a workspace writes nothing;
* every existing callback case is byte-identical with and without the Lamo Stories changes (table, secrets,
  redirect, platform calls), against the old ``hooks._oauth_callback`` and ``callback.handle_callback`` kept here.
"""

from __future__ import annotations

import contextlib
import copy
import json
import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import parse_qs, parse_qsl, urlsplit

import pytest

import test_money_grant
import test_oauth_callback as old_cases
import ws_social_support as sup
from clipfactory_api import db, hooks, release, s3
from clipfactory_api.agent_client import AgentClient
from clipfactory_api.app import App
from clipfactory_api.async_invoke import AsyncInvoker
from clipfactory_api.flow_client import FlowClient
from clipfactory_api.http import dispatch
from clipfactory_api.oauth import DEFAULT_SCOPES, MONEY_GRANT, OAuthEnv, callback, providers, setup, state
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.routes import ROUTES
from clipfactory_api.routes.setup import WebFiles
from clipfactory_api.skills import load_builtins
from clipfactory_api.workspaces import apps, social, social_callback
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from conftest import (
    APP_URL,
    CLIP_FLOW_ARN,
    HOOKS_URL,
    JOB_FLOW_ARN,
    LEARN_ARN,
    MONEY_ARN,
    STATE_KEY,
    STATE_SECRET,
    STATS_ARN,
    USER,
    Call,
    Clock,
    make_event,
)
from fakes import (
    FakeAgentCore,
    FakeCloudFront,
    FakeEmbeddings,
    FakeHttp,
    FakeLambda,
    FakeS3,
    FakeS3Vectors,
    FakeSecretsManager,
    FakeTable,
)
from test_oauth_callback import IG_TWO, META_LONG, META_TOKEN, SUCCESS, YOUTUBE_TOKEN
from test_oauth_state_formats import GOOD

ROOT = "/v1/workspaces/stories/social"


@pytest.fixture(autouse=True)
def _callback_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(apps.CALLBACK_ENV, sup.STORIES_CALLBACK)


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


@pytest.fixture
def ws_secrets(app: App, secrets_client: FakeSecretsManager) -> WorkspaceSecrets:
    sup.workspace(app.store)
    sup.choices(app.store, secrets_client)  # Lamo Stories' own Meta app, Clip Factory's app for the others
    return sup.install(app, secrets_client)


@pytest.fixture(autouse=True)
def _installed(ws_secrets: WorkspaceSecrets) -> None:
    return None


@pytest.fixture
def hooks_deps(store: db.Store, oauth_env: OAuthEnv, clock: Clock) -> Any:
    return sup.hooks_deps(store, oauth_env, clock)


def ws_secret_names(secrets_client: FakeSecretsManager) -> list[str]:
    return sorted(n for n in secrets_client.values if n.startswith(sup.WSP) and not n.endswith("/app"))


def back(app: App, hooks_deps: Any, platform: str, query: dict[str, str]) -> str:
    """The platform sends the owner back. Clip Factory's app (YouTube, TikTok, X here) has the hooks URI registered:
    the hooks Lambda forwards, and the forward is followed; Lamo Stories' own app (Meta here) comes straight back."""
    item = social.account_item(hooks_deps.store, USER, "stories", platform) or {}
    if apps.choice_of(platform, item) == "clips":
        forwarded = urlsplit(sup.land(hooks_deps, platform, query))
        assert f"{forwarded.scheme}://{forwarded.netloc}{forwarded.path}" == (
            f"{sup.STORIES_CALLBACK}/{platform}/callback"
        )
        query = dict(parse_qsl(forwarded.query, keep_blank_values=True))
    return sup.stories_callback(hooks_deps.app, platform, query)


@pytest.fixture
def land(app: App, hooks_deps: Any) -> Callable[[str, dict[str, str]], str]:
    hooks_deps.app = app

    def _land(platform: str, query: dict[str, str]) -> str:
        return back(app, hooks_deps, platform, query)

    return _land


Snapshot = tuple[list[dict[str, Any]], int]


def snapshot(table: FakeTable) -> Snapshot:
    return sup.lamo_clips_items(table), len(table.calls)


def assert_lamo_clips_untouched(table: FakeTable, before: Snapshot, secrets: FakeSecretsManager) -> None:
    """Clip Factory's items exactly as before, no ``cf-prod/platforms/*`` secret written or token read, and not one
    write call since to an ``ACCOUNT#`` or ``SETUP#`` key (or anything outside the workspace partition but the
    consumed ``OAUTH#ws.`` state)."""
    items, calls = before
    assert sup.lamo_clips_items(table) == items
    assert sup.clips_secret_writes(secrets) == []
    assert not [c for c in secrets.calls if c[1].startswith(sup.APP) and not c[1].endswith("/app")]
    for op, kw in table.calls[calls:]:
        key = kw.get("Key") or kw.get("Item") or {}
        pk, sk = str(key.get("pk")), str(key.get("sk"))
        if op == "get_item" and sk.startswith("ACCOUNT#"):
            assert set(kw["ExpressionAttributeNames"].values()) == set(social.CLIPS_ACCOUNT_ATTRIBUTES)
        if op not in {"put_item", "update_item", "delete_item"}:
            continue
        assert not sk.startswith(("ACCOUNT#", "SETUP#")), (op, pk, sk)
        assert pk.startswith((f"USER#{USER}#WS#", "OAUTH#ws.")) or (op == "put_item" and pk == f"USER#{USER}#WSREG"), (
            op,
            pk,
            sk,
        )


# --- connected, same as Lamo Clips, choose ---------------------------------------------------------------------


@pytest.mark.parametrize("platform", list(SUCCESS))
def test_a_workspace_connect_writes_only_its_own_secret_and_social_item(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    capsys: pytest.CaptureFixture[str],
    platform: str,
) -> None:
    signed = sup.ws_start(call, platform)
    assert signed.startswith("w1.stories.")
    before = snapshot(table)
    http.answers.extend(SUCCESS[platform])
    assert land(platform, {"code": "THE-CODE", "state": signed}) == sup.landing(platform, "connected")
    assert http.answers == []
    assert_lamo_clips_untouched(table, before, secrets_client)
    item = store.get(sup.PK, f"SOCIAL#{platform}")
    assert item is not None
    assert item["connectionStatus"] == "connected"
    assert item["appClientId"] == GOOD[platform]["clientId"]
    assert item["sharedWithClips"] is False
    assert item["lastCheckedAt"] == "2026-11-15T12:00:00.000Z"
    assert item["app"]["choice"] == sup.default_choice(platform)  # the owner's choice stays as it was
    token = secrets_client.json(f"{sup.WSP}stories/{platform}/token")
    assert str(token[social.ws.SECRET_IDENTITY[platform]]) == item["externalAccountId"]
    assert ws_secret_names(secrets_client) == [f"{sup.WSP}stories/{platform}/token"]
    assert secrets_client.tags[f"{sup.WSP}stories/{platform}/token"] == [
        {"Key": "app", "Value": "cf-prod"},
        {"Key": "workspace", "Value": "stories"},
        {"Key": "platform", "Value": platform},
    ]
    assert not [i for i in table.all() if str(i["pk"]).startswith("OAUTH#")]  # consumed
    exchange = http.calls[0]
    expected_redirect = (
        f"{HOOKS_URL}/oauth/{platform}/callback"
        if sup.default_choice(platform) == "clips"
        else f"{sup.STORIES_CALLBACK}/{platform}/callback"
    )
    sent = {**parse_qs(urlsplit(exchange.url).query), **parse_qs((exchange.body or b"").decode())}
    assert sent["redirect_uri"] == [expected_redirect]
    logs = capsys.readouterr().out
    _, listed = call("GET", ROOT)
    dumped = json.dumps(table.all(), default=str) + json.dumps(listed) + logs
    for secret in [*old_cases.SECRETS_SEEN, "THE-CODE", signed, GOOD[platform]["clientSecret"]]:
        assert secret not in dumped, secret


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "x"])
def test_an_own_app_comes_straight_back_to_lamo_stories(
    call: Call,
    app: App,
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    platform: str,
) -> None:
    sup.own_keys(secrets_client, platform)
    sup.choose_app(store, platform, "own")
    signed = sup.ws_start(call, platform)
    before = snapshot(table)
    http.answers.extend(SUCCESS[platform])
    location = sup.stories_callback(app, platform, {"code": "C", "state": signed})
    assert location == sup.landing(platform, "connected")
    assert_lamo_clips_untouched(table, before, secrets_client)
    sent = http.calls[0].body.decode()
    assert parse_qs(sent)["redirect_uri"] == [f"{sup.STORIES_CALLBACK}/{platform}/callback"]
    assert ("get", f"cf-prod/platforms/{platform}/app") not in secrets_client.calls


def test_youtube_asks_google_for_its_account_and_channel_picker(call: Call) -> None:
    status, body = call("POST", f"{ROOT}/youtube/connect")
    assert status == 200
    query = parse_qs(urlsplit(body["authorizeUrl"]).query)
    assert query["prompt"] == ["select_account consent"]


def test_a_youtube_token_with_two_channels_writes_nothing(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
) -> None:
    signed = sup.ws_start(call, "youtube")
    before = copy.deepcopy(table.all())
    two = {"items": [*old_cases.YOUTUBE_CHANNELS["items"], {"id": "UC999", "snippet": {"title": "Another"}}]}
    http.answers.extend([(200, YOUTUBE_TOKEN), (200, two)])
    assert land("youtube", {"code": "C", "state": signed}) == sup.landing("youtube", "error")
    after = [i for i in table.all() if not str(i["pk"]).startswith("OAUTH#")]
    assert after == [i for i in before if not str(i["pk"]).startswith("OAUTH#")]
    assert ws_secret_names(secrets_client) == []
    assert len(http.calls) == 2  # the exchange and its one channel list: no second call to count


def test_a_youtube_token_without_a_channel_is_no_channel(
    call: Call, land: Callable[[str, dict[str, str]], str], http: FakeHttp
) -> None:
    signed = sup.ws_start(call, "youtube")
    http.answers.extend([(200, YOUTUBE_TOKEN), (200, {"items": []})])
    assert land("youtube", {"code": "C", "state": signed}) == sup.landing("youtube", "no_channel")


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "x"])
def test_lamo_clips_own_account_is_held_as_same_as_clips(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    platform: str,
) -> None:
    sup.clips_account(store, None, platform)
    before = snapshot(table)
    signed = sup.ws_start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert land(platform, {"code": "C", "state": signed}) == sup.landing(platform, "same_as_clips")
    item = store.get(sup.PK, f"SOCIAL#{platform}")
    assert item is not None
    assert item["connectionStatus"] == "same_as_clips"
    assert_lamo_clips_untouched(table, before, secrets_client)
    _, listed = call("GET", ROOT)
    account = next(a for a in listed["accounts"] if a["platform"] == platform)
    assert account["connectionStatus"] == "same_as_clips"
    assert account["sharedWithClips"] is False
    # §45.37 G8: it can never post, and the card says why up front
    assert account["warning"] == (
        "This is Clip Factory's own account. Clip Factory Stories needs its own separate account: sign in with a "
        "different one."
    )


@pytest.mark.parametrize("platform", ["tiktok", "x"])
def test_clip_factorys_account_is_known_by_its_username_too(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    platform: str,
) -> None:
    """§45.37 G8 (b): Clip Factory's account with another id (TikTok gives each app its own open id) but the same
    username is still Clip Factory's: held as ``same_as_clips`` at connect, and Clip Factory's items only read."""
    signed = sup.ws_start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert land(platform, {"code": "C", "state": signed}) == sup.landing(platform, "connected")
    found = store.get(sup.PK, f"SOCIAL#{platform}") or {}
    handle = str(found.get("handle") or "")
    assert handle.startswith("@"), handle
    sup.clips_account(store, None, platform, accountId="another-app-id", handle=handle.upper())
    before = snapshot(table)
    signed = sup.ws_start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert land(platform, {"code": "C", "state": signed}) == sup.landing(platform, "same_as_clips")
    assert (store.get(sup.PK, f"SOCIAL#{platform}") or {})["connectionStatus"] == "same_as_clips"
    assert_lamo_clips_untouched(table, before, secrets_client)


SEVERAL = {
    "instagram": ([(200, META_TOKEN), (200, META_LONG), (200, old_cases.IG_ME), (200, IG_TWO)], "1785"),
    "facebook": (
        [
            *SUCCESS["facebook"][:4],
            (200, {"data": [old_cases.FB_PAGE, {**old_cases.FB_PAGE, "id": "p2", "name": "Lamo Stories Page"}]}),
        ],
        "p2",
    ),
}


def test_meta_with_several_pages_needs_a_choice_marking_lamo_clips_page(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
) -> None:
    sup.clips_account(store, secrets_client, "instagram")  # Lamo Clips posts to @owner (1784)
    before = snapshot(table)
    signed = sup.ws_start(call, "instagram")
    http.answers.extend(SEVERAL["instagram"][0])
    assert land("instagram", {"code": "C", "state": signed}) == sup.landing("instagram", "choose")
    assert ws_secret_names(secrets_client) == [f"{sup.WSP}stories/instagram/pending"]
    _, listed = call("GET", ROOT)
    account = next(a for a in listed["accounts"] if a["platform"] == "instagram")
    assert account["connectionStatus"] == "choose_account"
    assert [(c["id"], c["usedByClips"]) for c in account["choices"]] == [("1784", True), ("1785", False)]
    status, chosen = call("POST", f"{ROOT}/instagram/choose", {"choiceId": "1785"})
    assert status == 200, chosen
    assert chosen["account"]["connectionStatus"] == "connected"
    assert chosen["account"]["externalAccountId"] == "1785"
    assert chosen["account"]["warning"] is None
    assert chosen["account"]["lastCheckedAt"] == "2026-11-15T12:00:00.000Z"
    assert http.answers == []
    assert ws_secret_names(secrets_client) == [f"{sup.WSP}stories/instagram/token"]
    assert_lamo_clips_untouched(table, before, secrets_client)  # never a read of Clip Factory's Meta token


@pytest.mark.parametrize("platform", sorted(SEVERAL))
def test_a_list_of_pages_over_an_old_token_keeps_it_until_the_choice(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    platform: str,
) -> None:
    token_name = f"{sup.WSP}stories/{platform}/token"
    signed = sup.ws_start(call, platform)
    http.answers.extend(SUCCESS[platform])
    assert land(platform, {"code": "C", "state": signed}) == sup.landing(platform, "connected")
    old_token = secrets_client.values[token_name]
    answers, choice = SEVERAL[platform]
    signed = sup.ws_start(call, platform)
    http.answers.extend(answers)
    assert land(platform, {"code": "C", "state": signed}) == sup.landing(platform, "choose")
    assert ws_secret_names(secrets_client) == [f"{sup.WSP}stories/{platform}/pending", token_name]
    assert secrets_client.values[token_name] == old_token  # kept: nothing can post while a Page is being picked
    item = store.get(sup.PK, f"SOCIAL#{platform}")
    assert item is not None
    assert item["connectionStatus"] == "choose_account"
    assert "externalAccountId" not in item
    status, chosen = call("POST", f"{ROOT}/{platform}/choose", {"choiceId": choice})
    assert status == 200, chosen
    assert (chosen["account"]["connectionStatus"], chosen["account"]["externalAccountId"]) == ("connected", choice)
    assert ws_secret_names(secrets_client) == [token_name]
    identity = social.ws.SECRET_IDENTITY[platform]
    assert str(secrets_client.json(token_name)[identity]) == choice  # the choice overwrote the old token


# --- every way a workspace state can fail still lands on Lamo Stories' Social accounts ---------------------------


def test_expired_replayed_forged_and_mismatched_states(
    call: Call, land: Callable[[str, dict[str, str]], str], http: FakeHttp, clock: Clock
) -> None:
    signed = sup.ws_start(call, "x")
    # a broken signature: no ws in the landing (it was not checked)
    assert land("x", {"code": "C", "state": signed[:-2] + "AA"}) == sup.landing("x", "expired", ws_id=None)
    assert land("x", {"code": "C", "state": "w1.garbage"}) == sup.landing("x", "expired", ws_id=None)
    assert land("youtube", {"code": "C", "state": signed}) == sup.landing("youtube", "expired", ws_id=None)
    # expired: the signature checks out, so ws is there
    later = clock.now
    clock.now = later.replace(minute=11)
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "expired")
    clock.now = later
    # used once (the expiry above did not consume it), then replayed
    http.answers.extend(SUCCESS["x"])
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "connected")
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "expired")
    assert http.answers == []


def test_an_expired_state_whose_item_is_gone_still_lands_on_connections(app: App, http: FakeHttp) -> None:
    key = STATE_KEY.encode()
    signed = social.sign_state(key, "tiktok", "stories", state.new_nonce(), 1_794_744_600)
    assert sup.stories_callback(app, "tiktok", {"code": "C", "state": signed}) == sup.landing("tiktok", "expired")
    assert sup.stories_callback(app, "tiktok", {}) == sup.landing("tiktok", "expired", ws_id=None)
    assert sup.stories_callback(app, "myspace", {}) == f"{APP_URL}/stories/connections?platform=&result=error"
    assert http.calls == []


def test_clip_factorys_state_items_are_never_consumed_here(
    call: Call, app: App, store: db.Store, table: FakeTable, http: FakeHttp
) -> None:
    signed = sup.ws_start(call, "x")
    nonce = signed.split(".")[2]
    item = store.get(f"OAUTH#ws.{nonce}", "STATE")
    assert item is not None
    store.delete(f"OAUTH#ws.{nonce}", "STATE")
    store.put({**item, "pk": f"OAUTH#{nonce}", "type": "oauth"})  # as if it were Clip Factory's
    assert sup.stories_callback(app, "x", {"code": "C", "state": signed}) == sup.landing("x", "expired")
    assert store.get(f"OAUTH#{nonce}", "STATE") is not None  # untouched
    assert http.calls == []


def test_a_state_item_for_another_workspace_writes_nothing(
    call: Call,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    secrets_client: FakeSecretsManager,
) -> None:
    signed = sup.ws_start(call, "x")
    nonce = signed.split(".")[2]
    store.update(f"OAUTH#ws.{nonce}", "STATE", {"workspaceId": "01JZ0000000000000000000000"})
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "error")
    assert http.calls == []
    assert store.get(sup.PK, "SOCIAL#x")["connectionStatus"] == "not_connected"  # type: ignore[index]
    assert ws_secret_names(secrets_client) == []
    signed = sup.ws_start(call, "x")
    nonce = signed.split(".")[2]
    store.update(f"OAUTH#ws.{nonce}", "STATE", {}, remove=["workspaceId"])
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "error")
    assert http.calls == []


@pytest.mark.parametrize("change", ["other_app", "new_keys", "no_app"])
def test_an_app_changed_after_connect_exchanges_nothing(
    call: Call,
    app: App,
    land: Callable[[str, dict[str, str]], str],
    http: FakeHttp,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    change: str,
) -> None:
    signed = sup.ws_start(call, "tiktok")  # Clip Factory's app
    if change == "other_app":
        sup.own_keys(secrets_client, "tiktok")
        sup.choose_app(store, "tiktok", "own")
    elif change == "new_keys":
        secrets_client.values["cf-prod/platforms/tiktok/app"] = json.dumps({**GOOD["tiktok"], "clientId": "n" * 12})
    else:
        sup.choose_app(store, "tiktok", None)
    query = {"code": "C", "state": signed}
    assert sup.stories_callback(app, "tiktok", query) == sup.landing("tiktok", "expired")
    assert http.calls == []
    assert ws_secret_names(secrets_client) == []


def test_a_redirect_that_is_not_the_choices_own_is_refused(
    call: Call, app: App, http: FakeHttp, store: db.Store
) -> None:
    signed = sup.ws_start(call, "x")
    nonce = signed.split(".")[2]
    store.update(f"OAUTH#ws.{nonce}", "STATE", {"redirectUri": "https://evil.example/x/callback"})
    assert sup.stories_callback(app, "x", {"code": "C", "state": signed}) == sup.landing("x", "redirect_wrong")
    assert http.calls == []


def test_a_failure_inside_the_workspace_path_lands_on_connections(
    call: Call, land: Callable[[str, dict[str, str]], str], monkeypatch: pytest.MonkeyPatch, store: db.Store
) -> None:
    signed = sup.ws_start(call, "x")

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(providers, "exchange", broken)
    assert land("x", {"code": "C", "state": signed}) == sup.landing("x", "error")
    assert store.get(sup.PK, "SOCIAL#x")["connectionStatus"] == "not_connected"  # type: ignore[index]


def test_without_workspace_secrets_or_posting_setup_a_w1_state_lands_on_connections(
    call: Call, app: App, http: FakeHttp, secrets_client: FakeSecretsManager
) -> None:
    from clipfactory_api.workspaces import deps

    signed = sup.ws_start(call, "x")
    deps.install(app, deps.WsDeps(story_flow_arn=sup.STORY_FLOW_ARN, secrets=None))
    found = sup.stories_callback(app, "x", {"code": "C", "state": signed})
    assert found == sup.landing("x", "error")
    app.oauth = None
    assert sup.stories_callback(app, "x", {"code": "C", "state": signed}).startswith("/stories/connections?")
    assert http.calls == []


def test_a_cancelled_workspace_connect(call: Call, land: Callable[[str, dict[str, str]], str], http: FakeHttp) -> None:
    signed = sup.ws_start(call, "tiktok")
    assert land("tiktok", {"error": "access_denied", "state": signed}) == sup.landing("tiktok", "denied")
    assert http.calls == []


def test_missing_permissions_makes_the_next_facebook_connect_ask_again(
    call: Call, land: Callable[[str, dict[str, str]], str], http: FakeHttp
) -> None:
    signed = sup.ws_start(call, "facebook")
    http.answers.extend(
        [(200, META_TOKEN), (200, {"access_token": "L"}), (200, {"data": [{"permission": "x", "status": "declined"}]})]
    )
    assert land("facebook", {"code": "C", "state": signed}) == sup.landing("facebook", "missing_permissions")
    _, body = call("POST", f"{ROOT}/facebook/connect")
    assert "auth_type=rerequest" in body["authorizeUrl"]
    _, listed = call("GET", ROOT)
    account = next(a for a in listed["accounts"] if a["platform"] == "facebook")
    assert account["missing"] == ["x"]


def test_the_landing_reflects_nothing_from_the_request() -> None:
    assert social_callback.landing(APP_URL, "x", "https://evil.example", "stories") == (
        f"{APP_URL}/stories/connections?platform=x&result=error&ws=stories"
    )
    assert social_callback.landing(APP_URL, "x", "connected", "../evil") == (
        f"{APP_URL}/stories/connections?platform=x&result=connected"
    )
    assert social_callback.landing(APP_URL, "x", "connected", "clips").endswith("result=connected")
    assert set(social_callback.WS_RESULTS) == {*callback.RESULTS, "same_as_clips"}


def test_the_state_formats_never_cross() -> None:
    key = STATE_KEY.encode()
    nonce = state.new_nonce()
    w1 = social.sign_state(key, "youtube", "stories", nonce, 1_900_000_000)
    v1 = state.sign(key, "youtube", nonce, 1_900_000_000)
    assert len(w1) < state.MAX_STATE_CHARS
    with pytest.raises(state.StateError):
        state.verify(key, "youtube", w1, 1_800_000_000)
    with pytest.raises(state.StateError):
        social.verify_state(key, "youtube", v1, 1_800_000_000)
    with pytest.raises(state.StateError):
        social.verify_state(key, "x", w1, 1_800_000_000)  # bound to the platform
    forged = w1.replace("w1.stories.", "w1.01JZ0000000000000000000000.")
    with pytest.raises(state.StateError):
        social.verify_state(key, "youtube", forged, 1_800_000_000)  # the workspace id is signed
    assert social.verify_state(key, "youtube", w1, 1_800_000_000) == ("stories", nonce)
    with pytest.raises(ValueError, match="Clip Factory Stories"):
        social.sign_state(key, "youtube", "clips", nonce, 1_900_000_000)


def test_the_callback_route_is_public_and_kept_out_of_the_jwt_table() -> None:
    import ws_routes_social
    from clipfactory_api.workspaces.routes import ROUTES as WS_ROUTES
    from clipfactory_api.workspaces.routes.social import CALLBACK_ROUTES

    assert len(CALLBACK_ROUTES) == len(ws_routes_social.CALLBACK)
    for method, path in ws_routes_social.CALLBACK:
        assert [r.public for r in CALLBACK_ROUTES if r.method == method and r.pattern.match(path)] == [True]
        assert not any(r.pattern.match(path) for r in WS_ROUTES)
    assert not any(r.public for r in WS_ROUTES)


# --- Clip Factory's callback only forwards a w1. state (§45.13.3, §45.17) ---------------------------------------


def test_the_hooks_lambda_forwards_a_w1_state_and_touches_nothing(
    hooks_deps: Any, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    calls, secret_calls = len(table.calls), len(secrets_client.calls)
    event = sup.callback_event("youtube", {"code": "4/0A+b c", "state": "w1.stories.N.1.S", "scope": "a b"})
    event["multiValueQueryStringParameters"] = {
        "code": ["4/0A+b c"],
        "state": ["w1.stories.N.1.S"],
        "scope": ["a b"],
    }
    out = hooks.handle(event, hooks_deps)
    assert out["statusCode"] == 302
    assert out["headers"]["cache-control"] == "no-store"
    assert out["headers"]["referrer-policy"] == "no-referrer"
    location = urlsplit(out["headers"]["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == f"{sup.STORIES_CALLBACK}/youtube/callback"
    assert parse_qsl(location.query) == [("code", "4/0A+b c"), ("state", "w1.stories.N.1.S"), ("scope", "a b")]
    assert len(table.calls) == calls  # no read, no write
    assert len(secrets_client.calls) == secret_calls  # not even the state key
    assert http.calls == []


def test_the_forward_target_comes_from_configuration_only(
    store: db.Store, oauth_env: OAuthEnv, clock: Clock, table: FakeTable
) -> None:
    query = {"state": "w1.x", "redirect": "https://evil.example", "host": "evil.example"}
    deps_ = sup.hooks_deps(store, oauth_env, clock)
    location = sup.land(deps_, "x", query)
    assert location.startswith(f"{sup.STORIES_CALLBACK}/x/callback?")
    off = sup.hooks_deps(store, oauth_env, clock, stories_callback="")
    assert sup.land(off, "x", query) == f"{APP_URL}/stories/connections?platform=x&result=error"
    nothing = sup.hooks_deps(store, oauth_env, clock, stories_callback="http://insecure.example")
    assert sup.land(nothing, "x", query) == f"{APP_URL}/stories/connections?platform=x&result=error"


def test_the_hooks_lambda_gains_no_workspace_code() -> None:
    import inspect

    source = inspect.getsource(hooks)
    assert "workspaces" not in source
    assert "WS_SECRET_PREFIX" not in source
    source = inspect.getsource(callback)
    assert "workspaces" not in source
    assert "w1." not in source


# --- a v1. state with a workspace item, and the old cases byte for byte --------------------------------------


def test_a_v1_state_whose_item_names_a_workspace_writes_nothing(
    hooks_deps: Any, http: FakeHttp, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    sup.app_keys(secrets_client, "youtube")
    nonce = state.new_nonce()
    signed = state.sign(STATE_KEY.encode(), "youtube", nonce, 1_794_830_400)
    store.put(
        {
            "pk": f"OAUTH#{nonce}",
            "sk": "STATE",
            "type": "oauth",
            "userId": USER,
            "platform": "youtube",
            "redirectUri": f"{HOOKS_URL}/oauth/youtube/callback",
            "workspaceId": "stories",
            "socialAccountId": "stories.youtube",
        }
    )
    before = [i for i in copy.deepcopy(table.all()) if not str(i["pk"]).startswith("OAUTH#")]
    writes_before = list(secrets_client.writes)
    location = sup.land(hooks_deps, "youtube", {"code": "C", "state": signed})
    assert location == f"{APP_URL}/settings/posting/setup/youtube?result=error"
    assert [i for i in table.all() if not str(i["pk"]).startswith("OAUTH#")] == before
    assert secrets_client.writes == writes_before
    assert http.calls == []
    assert setup.item(store, USER, "youtube") == {}


# The old code, verbatim from before Lamo Stories (main at b9fd20f), to replay every existing case with both.
def old_oauth_callback(platform: str, event: Mapping[str, Any], deps: hooks.HooksDeps) -> dict[str, Any]:
    result = "error"
    if deps.oauth is not None:
        try:
            result = old_handle_callback(platform, hooks._query(event), deps.store, deps.oauth, deps.flows)
        except Exception:
            result = "error"
    headers = {"location": callback.location(deps.app_url, platform, result), "referrer-policy": "no-referrer"}
    return hooks._response(302, headers=headers)


def old_handle_callback(
    platform: str,
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    flows: release.ClipFlowStarter | None = None,
) -> str:
    started = time.monotonic()
    if platform not in callback.SETUP_ORDER:
        return "error"
    now = env.clock()
    try:
        key = env.state_key()
        nonce = state.verify(key, platform, str(query.get("state") or ""), int(now.timestamp()))
    except state.StateError:
        return "expired"
    saved = callback.consume(store, nonce)
    if saved is None or saved.get("platform") != platform or not saved.get("userId"):
        return "expired"
    user_id = str(saved["userId"])
    if saved.get("grant") == MONEY_GRANT:
        return callback._money_result(
            platform,
            query,
            store,
            env,
            user_id=user_id,
            nonce=nonce,
            key=key,
            redirect_uri=str(saved.get("redirectUri") or ""),
        )
    result = callback._result(
        platform,
        query,
        store,
        env,
        user_id=user_id,
        nonce=nonce,
        key=key,
        redirect_uri=str(saved.get("redirectUri") or ""),
    )
    with contextlib.suppress(Exception):  # as the old code: the result is shown either way
        setup.record(store, user_id, platform, env.clock(), {"lastResult": result})
    if result == "connected" and flows is not None:
        with contextlib.suppress(Exception):  # as the old code
            release.release_waiting(store, flows, user_id, platform, deadline=started + release.ANSWER_SECONDS)
    return result


class World:
    """One fresh app, hooks deps and fakes, built the way conftest builds them."""

    def __init__(self, tmp: Any) -> None:
        self.table = FakeTable()
        self.store = db.Store(self.table)
        self.secrets = FakeSecretsManager({STATE_SECRET: STATE_KEY})
        self.http = FakeHttp()
        self.clock = Clock()
        self.lambda_client = FakeLambda()
        secrets = Secrets(self.secrets)
        self.oauth = OAuthEnv(
            secrets=secrets,
            app_url=APP_URL,
            hooks_url=HOOKS_URL,
            state_key=lambda: secrets.read_text(STATE_SECRET).encode(),
            http=self.http,
            clock=self.clock,
            graph_version="v27.0",
            scopes=dict(DEFAULT_SCOPES),
        )
        from clipfactory_api.vectors import Vectors

        builtin = tmp / "builtin" / "short-form-video-playbook"
        builtin.mkdir(parents=True, exist_ok=True)
        (builtin / "SKILL.md").write_text("---\nname: x\ndescription: y\n---\n")
        self.app = App(
            store=self.store,
            media=s3.Media(FakeS3(), "cf-prod-media-123"),
            agent=AgentClient(FakeAgentCore(), "arn:aws:bedrock-agentcore:eu-north-1:123:runtime/cf_prod_clip_agent"),
            flows=FlowClient(self.lambda_client, JOB_FLOW_ARN, CLIP_FLOW_ARN),
            vectors=Vectors(FakeS3Vectors(), FakeEmbeddings(), "cf-prod-vectors-123", "clips", "t"),
            invoker=AsyncInvoker(self.lambda_client, STATS_ARN, LEARN_ARN, MONEY_ARN),
            clock=self.clock,
            email_lookup=lambda sub, token: "owner@example.com" if token else None,
            builtins=lambda: load_builtins(tmp / "builtin"),
            oauth=self.oauth,
            web_files=WebFiles(FakeS3(), "cf-prod-web-123", FakeCloudFront(), "E1ABCDEF"),
        )
        self.deps = hooks.HooksDeps(
            store=self.store,
            app_url=APP_URL,
            verify_token=lambda: "verify-me-123",
            clock=self.clock,
            oauth=self.oauth,
            flows=FlowClient(self.lambda_client, JOB_FLOW_ARN, CLIP_FLOW_ARN),
        )

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        out = dispatch(make_event(method, path, body), self.app, ROUTES)
        return out["statusCode"], (json.loads(out["body"]) if out["body"] else None)

    def start(self, platform: str, *, money: bool = False) -> str:
        if not money:
            assert self.call("PUT", f"/v1/setup/{platform}/keys", GOOD[platform])[0] == 200
        _, body = self.call("POST", f"/v1/accounts/{platform}/connect", {"grant": "money"} if money else None)
        return str(parse_qs(urlsplit(body["authorizeUrl"]).query)["state"][0])

    def back(self, platform: str, query: dict[str, str]) -> str:
        out = hooks.handle(sup.callback_event(platform, query), self.deps)
        return str(out["headers"]["location"])

    def record(self) -> dict[str, Any]:
        return {
            "table": sorted(
                (json.dumps(i, sort_keys=True, default=str) for i in self.table.all()),
            ),
            "table_calls": [json.dumps(c, sort_keys=True, default=str) for c in self.table.calls if c[0] != "get_item"],
            "secrets": dict(self.secrets.values),
            "secret_writes": list(self.secrets.writes),
            "secret_tags": {k: list(v) for k, v in self.secrets.tags.items()},
            "http": [(c.method, c.url, c.body, sorted(c.headers.items())) for c in self.http.calls],
            "flows": list(self.lambda_client.calls),
        }


Scenario = Callable[[World], list[str]]


def connect_then(platform: str, answers: list[Any], query: dict[str, str]) -> Scenario:
    def run(world: World) -> list[str]:
        signed = world.start(platform)
        world.http.answers.extend(answers)
        return [world.back(platform, {**query, "state": signed})]

    return run


def scenarios() -> dict[str, Scenario]:
    found: dict[str, Scenario] = {}
    for platform, answers in old_cases.SUCCESS.items():
        found[f"success-{platform}"] = connect_then(platform, answers, {"code": "THE-CODE"})
    marks = {m.name: m for m in old_cases.test_callback_results.pytestmark}
    for i, (platform, answers, _) in enumerate(marks["parametrize"].args[1]):
        found[f"result-{i}-{platform}"] = connect_then(platform, list(answers), {"code": "C"})
    for i, (error, _) in enumerate(old_cases.test_owner_pressed_cancel.pytestmark[0].args[1]):
        found[f"cancel-{i}"] = connect_then("tiktok", [], {"error": error})
    found["choose-instagram"] = connect_then(
        "instagram", [(200, META_TOKEN), (200, META_LONG), (200, old_cases.IG_ME), (200, IG_TWO)], {"code": "C"}
    )
    second = {**old_cases.FB_PAGE, "id": "p2", "name": "Second", "access_token": "EAAG-PAGE-2"}
    found["choose-facebook"] = connect_then(
        "facebook", [*SUCCESS["facebook"][:4], (200, {"data": [old_cases.FB_PAGE, second]})], {"code": "C"}
    )

    def replayed(world: World) -> list[str]:
        signed = world.start("x")
        world.http.answers.extend(SUCCESS["x"])
        return [world.back("x", {"code": "C", "state": signed}), world.back("x", {"code": "C", "state": signed})]

    def state_checks(world: World) -> list[str]:
        signed = world.start("youtube")
        out = [
            world.back("youtube", {"code": "C"}),
            world.back("youtube", {"code": "C", "state": signed[:-2] + "AA"}),
            world.back("x", {"code": "C", "state": signed}),
        ]
        world.clock.now = world.clock.now.replace(minute=11)
        return [*out, world.back("youtube", {"code": "C", "state": signed})]

    def forged(world: World) -> list[str]:
        signed = state.sign(STATE_KEY.encode(), "youtube", "AAAAAAAAAAAAAAAAAAAAAA", 1_794_744_600)
        return [world.back("youtube", {"code": "C", "state": signed})]

    def evil(world: World) -> list[str]:
        query = {"state": "x", "redirect": "https://evil.example", "next": "//evil.example", "result": "connected"}
        return [world.back("youtube", query)]

    def keys_deleted(world: World) -> list[str]:
        signed = world.start("x")
        del world.secrets.values["cf-prod/platforms/x/app"]
        return [world.back("x", {"code": "C", "state": signed})]

    def money(answers: list[Any], query: dict[str, str]) -> Scenario:
        def run(world: World) -> list[str]:
            first = world.start("youtube")
            world.http.answers.extend(SUCCESS["youtube"])
            out = [world.back("youtube", {"code": "FIRST", "state": first})]
            signed = world.start("youtube", money=True)
            world.http.answers.extend(answers)
            return [*out, world.back("youtube", {**query, "state": signed})]

        return run

    found.update(replayed=replayed, state_checks=state_checks, forged=forged, evil=evil, keys_deleted=keys_deleted)
    found["money-allowed"] = money(
        [(200, test_money_grant.YT_MONEY_TOKEN), (200, old_cases.YOUTUBE_CHANNELS)], {"code": "M"}
    )
    for i, (answers, query, _) in enumerate(
        test_money_grant.test_youtube_money_grant_writes_nothing_when_anything_is_off.pytestmark[0].args[1]
    ):
        found[f"money-{i}"] = money(list(answers), dict(query))
    return found


@pytest.mark.parametrize("name", sorted(scenarios()))
def test_every_old_callback_case_is_byte_identical_with_the_workspace_branch(
    name: str, tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    scenario = scenarios()[name]
    nonces = iter(f"N{n:021d}" for n in range(100))
    monkeypatch.setattr(state, "new_nonce", lambda: next(nonces))
    new_world = World(tmp_path / "new")
    new_locations = scenario(new_world)
    new_record = new_world.record()

    nonces = iter(f"N{n:021d}" for n in range(100))
    monkeypatch.setattr(hooks, "_oauth_callback", old_oauth_callback)
    old_world = World(tmp_path / "old")
    old_locations = scenario(old_world)
    old_record = old_world.record()

    assert new_locations == old_locations
    for location in new_locations:
        assert "/stories/" not in location
    assert new_record == old_record
