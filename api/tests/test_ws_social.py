"""Lamo Stories' social routes: the developer app choice, connect, list, choose, share, check, creator info,
disconnect (CONTRACTS §45.13, §45.30).

Connect uses only the app the owner chose (Lamo Stories' own, or Clip Factory's for YouTube, TikTok and X, read
only), never a fallback; Disconnect never calls a platform's revoke endpoint; nothing here ever writes Clip
Factory's ``ACCOUNT#``/``SETUP#`` items or a ``cf-prod/platforms/*`` secret; no token or app secret reaches a
response, an item or the logs (``leaked``).
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.oauth import OAuthEnv, providers, state
from clipfactory_api.oauth.providers import AppKeys
from clipfactory_api.workspaces import apps, social
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from conftest import NOW, OTHER, STATE_KEY, USER, Call
from fakes import FakeHttp, FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD
from test_setup_routes import leaked

ROOT = "/v1/workspaces/stories/social"
CHOICES = [
    ("youtube", "clips"),
    ("youtube", "own"),
    ("tiktok", "clips"),
    ("tiktok", "own"),
    ("x", "clips"),
    ("x", "own"),
    ("instagram", "own"),
    ("facebook", "own"),
]


@pytest.fixture(autouse=True)
def _callback_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(apps.CALLBACK_ENV, sup.STORIES_CALLBACK)


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


@pytest.fixture
def ws_secrets(app: App, secrets_client: FakeSecretsManager) -> WorkspaceSecrets:
    sup.app_keys(secrets_client)
    sup.workspace(app.store)
    return sup.install(app, secrets_client)


@pytest.fixture(autouse=True)
def _installed(ws_secrets: WorkspaceSecrets) -> None:
    return None


def accounts(call: Call) -> dict[str, Any]:
    status, body = call("GET", ROOT)
    assert status == 200, body
    return {a["platform"]: a for a in body["accounts"]}


def own_env(oauth_env: OAuthEnv) -> OAuthEnv:
    return apps.oauth_env_for(oauth_env, "own", sup.STORIES_CALLBACK)


# --- connect: only the chosen app (§45.13.2, §45.30) ------------------------------------------------------------


@pytest.mark.parametrize(("platform", "choice"), CHOICES)
def test_connect_uses_the_chosen_app_and_its_redirect_with_a_workspace_state(
    call: Call,
    store: db.Store,
    oauth_env: OAuthEnv,
    secrets_client: FakeSecretsManager,
    platform: str,
    choice: str,
) -> None:
    sup.own_keys(secrets_client, platform)
    sup.choose_app(store, platform, choice)
    writes = list(secrets_client.writes)
    status, body = call("POST", f"{ROOT}/{platform}/connect")
    assert status == 200, body
    assert body["expiresAt"] == "2026-11-15T12:10:00.000Z"
    url = body["authorizeUrl"]
    query = parse_qs(urlsplit(url).query)
    signed = query["state"][0]
    assert signed.startswith("w1.stories.")
    workspace_id, nonce = social.verify_state(STATE_KEY.encode(), platform, signed, int(NOW.timestamp()))
    assert workspace_id == "stories"
    assert store.get(f"OAUTH#{nonce}", "STATE") is None  # never Clip Factory's own state items
    item = store.get(f"OAUTH#ws.{nonce}", "STATE")
    assert item is not None
    assert (item["workspaceId"], item["socialAccountId"], item["userId"]) == ("stories", f"stories.{platform}", USER)
    assert (item["type"], item["appChoice"], item["appClientId"]) == ("ws_oauth", choice, GOOD[platform]["clientId"])
    env = oauth_env if choice == "clips" else own_env(oauth_env)
    if choice == "clips":
        assert item["redirectUri"] == f"{oauth_env.hooks_url}/oauth/{platform}/callback"
        name = f"cf-prod/platforms/{platform}/app"
    else:
        assert item["redirectUri"] == f"{sup.STORIES_CALLBACK}/{platform}/callback"
        name = f"cf-prod/workspaces/stories/{platform}/app"
    # The URL providers builds with that app's keys and redirect, but for the state and (YouTube) Google's picker.
    keys = AppKeys.from_secret(json.loads(secrets_client.values[name]))
    assert keys is not None
    challenge = state.pkce(STATE_KEY.encode(), nonce)[1] if platform in {"youtube", "x"} else None
    expected = parse_qs(urlsplit(providers.authorize_url(env, platform, keys, signed, challenge)).query)
    if platform == "youtube":
        assert query.pop("prompt") == ["select_account consent"]
        assert expected.pop("prompt") == ["consent"]
    if platform == "tiktok":
        assert query["disable_auto_auth"] == ["1"]
    assert query == expected
    assert secrets_client.writes == writes  # app keys are only read
    other = f"cf-prod/workspaces/stories/{platform}/app" if choice == "clips" else f"cf-prod/platforms/{platform}/app"
    assert ("get", other) not in secrets_client.calls  # the other app is never even read


@pytest.mark.parametrize(
    ("platform", "setup", "sentence"),
    [
        ("youtube", None, "Pick which app Lamo Stories uses for YouTube first."),
        ("x", None, "Pick which app Lamo Stories uses for X first."),
        ("instagram", None, "Paste your Lamo Stories Instagram app keys first."),
        ("tiktok", "own", "Paste your Lamo Stories TikTok app keys first."),
        ("facebook", "own", "Paste your Lamo Stories Facebook app keys first."),
        (
            "tiktok",
            "clips_without_keys",
            "Lamo Clips has no TikTok app keys yet. Set up TikTok in Lamo Clips first "
            "(Settings › Posting › Set up posting, up to the keys step).",
        ),
    ],
)
def test_connect_never_picks_an_app_by_itself(
    call: Call,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    platform: str,
    setup: str | None,
    sentence: str,
) -> None:
    if setup == "own":
        sup.choose_app(store, platform, "own")  # chosen, but no keys pasted
    elif setup == "clips_without_keys":
        del secrets_client.values[f"cf-prod/platforms/{platform}/app"]
        sup.choose_app(store, platform, "clips")
    status, body = call("POST", f"{ROOT}/{platform}/connect")
    assert status == 409
    assert body["error"]["message"] == sentence
    assert not [k for k in table.items if str(k[0]).startswith("OAUTH#")]  # no state was made
    if setup is None and platform in sup.SHARED:  # Clip Factory's keys exist, yet nothing falls back to them
        assert ("get", f"cf-prod/platforms/{platform}/app") not in secrets_client.calls


def test_a_meta_app_without_its_login_configuration_cannot_connect(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.own_keys(secrets_client, "facebook", keys={k: v for k, v in GOOD["facebook"].items() if k != "configId"})
    sup.choose_app(store, "facebook", "own")
    status, body = call("POST", f"{ROOT}/facebook/connect")
    assert status == 409
    assert body["error"]["message"] == "Paste your Lamo Stories Facebook app keys first."


def test_a_stored_clips_choice_on_meta_is_no_choice(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.app_keys(secrets_client)
    sup.choose_app(store, "instagram", "clips")  # never offered; if it were ever stored it means nothing
    status, body = call("POST", f"{ROOT}/instagram/connect")
    assert status == 409
    assert body["error"]["message"] == "Paste your Lamo Stories Instagram app keys first."
    assert not [c for c in secrets_client.calls if c[1].startswith("cf-prod/platforms/instagram")]


def test_an_own_app_needs_lamo_stories_callback_configured(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(apps.CALLBACK_ENV)
    sup.own_keys(secrets_client, "youtube")
    sup.choose_app(store, "youtube", "own")
    status, body = call("POST", f"{ROOT}/youtube/connect")
    assert (status, body["error"]["message"]) == (503, "Posting setup is not switched on for this app yet.")
    sup.choose_app(store, "youtube", "clips")  # Clip Factory's app needs only its registered redirect
    assert call("POST", f"{ROOT}/youtube/connect")[0] == 200


def test_reconnect_is_connect_again_and_keeps_the_account(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.social(store, secrets_client, "youtube", status="needs_reconnect", reason="token_dead")
    status, body = call("POST", f"{ROOT}/youtube/connect")
    assert status == 200, body
    shown = accounts(call)["youtube"]
    assert (shown["socialAccountId"], shown["externalAccountId"]) == ("stories.youtube", "UC-STORIES")
    assert shown["connectionStatus"] == "needs_reconnect"  # until the callback says otherwise


def test_routes_need_a_stories_workspace_of_this_owner(call: Call) -> None:
    status, body = call("GET", "/v1/workspaces/clips/social")
    assert status == 409
    assert body["error"]["message"] == "That is a Lamo Stories page. Switch to Lamo Stories first."
    assert call("GET", "/v1/workspaces/01JZ0000000000000000000000/social")[0] == 404
    assert call("PUT", "/v1/workspaces/clips/social/youtube/app", {"choice": "clips"})[0] == 409
    assert call("GET", ROOT, sub=OTHER)[0] == 200  # OTHER gets their own first workspace, empty
    other = call("GET", ROOT, sub=OTHER)[1]
    assert all(a["connectionStatus"] == "not_connected" for a in other["accounts"])
    assert all(a["app"] == {"choice": None, "saved": False} for a in other["accounts"])
    assert call("POST", f"{ROOT}/myspace/connect")[0] == 404
    assert call("POST", f"{ROOT}/youtube/connect", {"grant": "money"})[0] == 400


# --- the list -----------------------------------------------------------------------------------------------


def test_list_shows_five_accounts_their_app_limits_and_lamo_clips_without_names(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    sup.clips_account(store, None, "youtube")
    sup.social(store, secrets_client, "x")
    sup.social(store, secrets_client, "instagram")
    status, body = call("GET", ROOT)
    assert status == 200
    assert [a["platform"] for a in body["accounts"]] == ["youtube", "tiktok", "instagram", "facebook", "x"]
    for account in body["accounts"]:
        assert account["limits"], account["platform"]
        assert account["socialAccountId"] == f"stories.{account['platform']}"
    youtube, _, instagram, _, x = body["accounts"]
    assert (x["connectionStatus"], x["externalAccountId"], x["accountName"]) == ("connected", "77", "Lamo Stories x")
    assert x["lastCheckedAt"] == "2026-11-15T10:00:00.000Z"
    assert x["app"] == {"choice": "clips", "saved": False}
    assert any("shared with Lamo Clips" in line for line in x["limits"])
    assert instagram["app"]["choice"] == "own"
    assert instagram["app"]["saved"] is True
    assert set(instagram["app"]["hints"]) == {"clientId", "clientSecret", "configId"}
    assert any("own Meta app" in line for line in instagram["limits"])
    assert youtube["app"] == {"choice": None, "saved": False}
    assert any("First pick which app" in line for line in youtube["limits"])
    assert "appClientId" not in x
    # Only five attributes of Clip Factory's ACCOUNT# items can be read (§45.15): its names never are.
    assert body["clips"][0] == {"platform": "youtube", "connected": True, "name": None}
    assert body["clips"][1] == {"platform": "tiktok", "connected": False, "name": None}
    assert "UC123" not in json.dumps(body)  # Lamo Clips' ids never leave the server
    for op, kw in table.calls:
        if op == "get_item" and kw["Key"]["sk"].startswith("ACCOUNT#"):
            names = set(kw["ExpressionAttributeNames"].values())
            assert names == {"pk", "sk", "platform", "status", "accountId"}, kw
            assert kw["ProjectionExpression"]


@pytest.mark.parametrize(("platform", "choice"), [("tiktok", "clips"), ("tiktok", "own"), ("facebook", "own")])
def test_new_keys_of_the_chosen_app_ask_for_a_reconnect(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, platform: str, choice: str
) -> None:
    sup.social(store, secrets_client, platform, choice=choice)
    new = {**GOOD[platform], "clientId": "1234567890123" if platform == "facebook" else "awproductionkeys12345"}
    if choice == "clips":
        secrets_client.values[f"cf-prod/platforms/{platform}/app"] = json.dumps(new)
    else:
        sup.own_keys(secrets_client, platform, keys=new)
    found = accounts(call)[platform]
    assert (found["connectionStatus"], found["reason"]) == ("needs_reconnect", "keys_changed")
    item = store.get(sup.PK, f"SOCIAL#{platform}")
    assert item is not None  # stored, so the dashboard (which reads SOCIAL#) shows it under Needs you too
    assert (item["connectionStatus"], item["reason"]) == ("needs_reconnect", "keys_changed")
    assert item["appClientId"] == GOOD[platform]["clientId"]  # what it was connected with, for the record


def test_keys_of_the_other_app_never_count(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    sup.social(store, secrets_client, "youtube", choice="own")
    secrets_client.values["cf-prod/platforms/youtube/app"] = json.dumps({**GOOD["youtube"], "clientId": "other"})
    assert accounts(call)["youtube"]["connectionStatus"] == "connected"


def test_an_old_list_of_pages_is_stored_as_not_connected_when_read(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    store.put(
        {
            "pk": sup.PK,
            "sk": "SOCIAL#instagram",
            "type": "ws_social",
            "userId": USER,
            "workspaceId": "stories",
            "socialAccountId": "stories.instagram",
            "platform": "instagram",
            "connectionStatus": "choose_account",
            "choices": [{"id": "1799", "name": "lamostories", "usedByClips": False}],
            "choicesExpireAt": "2026-11-15T11:59:00.000Z",
            "appClientId": GOOD["instagram"]["clientId"],
            "app": sup.app_field("instagram", "own"),
            "createdAt": "2026-11-15T11:29:00.000Z",
            "updatedAt": "2026-11-15T11:29:00.000Z",
        }
    )
    found = accounts(call)["instagram"]
    assert (found["connectionStatus"], found["reason"], found["choices"]) == ("not_connected", "expired", None)
    item = store.get(sup.PK, "SOCIAL#instagram")
    assert item is not None
    assert (item["connectionStatus"], item["reason"]) == ("not_connected", "expired")
    assert "choices" not in item
    assert "choicesExpireAt" not in item
    assert item["app"]["choice"] == "own"
    assert accounts(call)["instagram"]["reason"] == "expired"  # the next read says the same


def test_a_stored_status_never_undoes_a_newer_connect(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    old = sup.social(store, secrets_client, "tiktok", appClientId="sandbox-keys")
    sup.social(store, secrets_client, "tiktok", updatedAt="2026-11-15T12:00:00.000Z")  # reconnected meanwhile
    shown = {"connectionStatus": "needs_reconnect", "reason": "keys_changed"}
    social.settle(store, USER, "stories", "tiktok", old, shown=shown, now=NOW)
    item = store.get(sup.PK, "SOCIAL#tiktok")
    assert item is not None
    assert (item["connectionStatus"], item.get("reason")) == ("connected", None)


# --- choose, share, check -------------------------------------------------------------------------------------


def test_choose_is_only_for_meta(call: Call) -> None:
    status, _ = call("POST", f"{ROOT}/youtube/choose", {"choiceId": "x"})
    assert status == 400
    assert call("POST", f"{ROOT}/facebook/choose", {"choiceId": "x"})[0] == 409
    assert call("POST", f"{ROOT}/facebook/choose", {"choiceId": "x", "extra": 1})[0] == 400


def test_an_old_list_of_pages_is_deleted(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    store.put(
        {
            "pk": sup.PK,
            "sk": "SOCIAL#facebook",
            "type": "ws_social",
            "userId": USER,
            "workspaceId": "stories",
            "socialAccountId": "stories.facebook",
            "platform": "facebook",
            "connectionStatus": "choose_account",
            "choices": [{"id": "p9", "name": "Lamo Stories Page", "usedByClips": False}],
            "choicesExpireAt": "2026-11-15T11:59:00.000Z",
            "appClientId": GOOD["facebook"]["clientId"],
        }
    )
    secrets_client.values["cf-prod/workspaces/stories/facebook/pending"] = json.dumps({"tokens": {"p9": "EAAG-X"}})
    status, body = call("POST", f"{ROOT}/facebook/choose", {"choiceId": "p9"})
    assert status == 409
    assert body["error"]["message"] == "That list is too old. Tap Connect again."
    assert "cf-prod/workspaces/stories/facebook/pending" not in secrets_client.values
    assert accounts(call)["facebook"]["connectionStatus"] == "not_connected"


def test_use_it_for_both_only_on_purpose(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    sup.clips_account(store, None, "youtube")
    sup.social(store, secrets_client, "youtube", status="same_as_clips", identity="UC123")
    assert call("POST", f"{ROOT}/youtube/share", {})[0] == 400
    assert call("POST", f"{ROOT}/youtube/share", {"confirm": "yes"})[0] == 400
    status, body = call("POST", f"{ROOT}/youtube/share", {"confirm": True})
    assert status == 200, body
    assert (body["account"]["connectionStatus"], body["account"]["sharedWithClips"]) == ("connected", True)
    item = store.get(sup.PK, "SOCIAL#youtube")
    assert item is not None
    assert item["sharedExternalAccountId"] == "UC123"
    assert "sharedExternalAccountId" not in body["account"]
    assert call("POST", f"{ROOT}/tiktok/share", {"confirm": True})[0] == 409


def test_check_marks_a_dead_token_and_brings_a_working_one_back(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp, clock: Any
) -> None:
    sup.social(store, secrets_client, "youtube")
    http.answers.append((401, {"error": {"code": 401}}))
    status, body = call("POST", f"{ROOT}/youtube/check")
    assert status == 200
    assert (body["account"]["connectionStatus"], body["account"]["reason"]) == ("needs_reconnect", "token_dead")
    assert http.calls[0].headers["Authorization"] == "Bearer ya29.WS-ACCESS"  # the workspace token only
    assert body["account"]["lastCheckedAt"] == "2026-11-15T12:00:00.000Z"
    http.answers.append((200, {"items": [{"id": "UC-STORIES"}]}))
    _, body = call("POST", f"{ROOT}/youtube/check")
    assert (body["account"]["connectionStatus"], body["account"]["reason"]) == ("connected", None)
    assert body["account"]["lastCheckedAt"] == "2026-11-15T12:00:00.000Z"


def test_check_with_an_own_meta_app_signs_with_its_own_secret(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    from clipfactory_api.platforms.base import appsecret_proof

    sup.social(store, secrets_client, "facebook")
    http.answers.append((200, {"id": "p9", "name": "Lamo Stories Page"}))
    status, body = call("POST", f"{ROOT}/facebook/check")
    assert status == 200, body
    proof = appsecret_proof(GOOD["facebook"]["clientSecret"], "EAAG-WS-FB")
    assert f"appsecret_proof={proof}" in http.calls[0].url
    assert not [c for c in secrets_client.calls if c[1].startswith("cf-prod/platforms/")]


def test_check_with_new_app_keys_asks_for_a_reconnect_without_calling(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "x", appClientId="old-client-id")
    _, body = call("POST", f"{ROOT}/x/check")
    assert (body["account"]["connectionStatus"], body["account"]["reason"]) == ("needs_reconnect", "keys_changed")
    assert http.calls == []


def test_check_needs_a_connection(call: Call) -> None:
    assert call("POST", f"{ROOT}/youtube/check")[0] == 409


# --- TikTok creator info ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("choice", ["clips", "own"])
def test_creator_info_uses_the_workspace_token_and_writes_no_setup_gate(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, http: FakeHttp, choice: str
) -> None:
    status, body = call("GET", f"{ROOT}/tiktok/creator-info")
    assert status == 409
    assert body["error"]["message"] == (
        "Lamo Stories' TikTok is not connected. Connect it in Lamo Stories › Connections."
    )
    sup.clips_account(store, secrets_client, "tiktok")
    sup.social(store, secrets_client, "tiktok", choice=choice)
    before = sup.lamo_clips_items(table)
    http.answers.append((200, "publish/tiktok_creator"))
    status, body = call("GET", f"{ROOT}/tiktok/creator-info")
    assert status == 200, body
    assert set(body["creator"]) == {
        "nickname",
        "username",
        "avatarUrl",
        "privacyOptions",
        "commentDisabled",
        "duetDisabled",
        "stitchDisabled",
        "maxDurationSec",
    }
    assert http.calls[0].headers["Authorization"] == "Bearer act.WS-ACCESS"
    assert sup.lamo_clips_items(table) == before
    assert ("get", "cf-prod/platforms/tiktok/token") not in secrets_client.calls


# --- the developer app (§45.30) --------------------------------------------------------------------------------


def test_meta_never_uses_clip_factorys_app(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    for platform in ("instagram", "facebook"):
        status, body = call("PUT", f"{ROOT}/{platform}/app", {"choice": "clips"})
        assert status == 400
        assert body["error"]["message"] == (
            "Facebook and Instagram always use Lamo Stories' own Meta app. Paste its keys."
        )
    assert store.get(sup.PK, "SOCIAL#instagram") is None
    assert call("PUT", f"{ROOT}/youtube/app", {"choice": "mine"})[0] == 400
    assert call("PUT", f"{ROOT}/youtube/app", {"choice": "clips", "clientId": "x"})[0] == 400
    assert call("PUT", f"{ROOT}/youtube/app", {"choice": "clips", "extra": 1})[0] == 400


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "x"])
def test_picking_clip_factorys_app_stores_only_the_choice(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, platform: str
) -> None:
    writes = list(secrets_client.writes)
    status, body = call("PUT", f"{ROOT}/{platform}/app", {"choice": "clips"})
    assert status == 200, body
    assert body["account"]["app"] == {"choice": "clips", "saved": False}
    assert body["account"]["connectionStatus"] == "not_connected"
    assert secrets_client.writes == writes  # nothing written anywhere: Clip Factory's keys are only read later
    item = store.get(sup.PK, f"SOCIAL#{platform}")
    assert item is not None
    assert (item["type"], item["userId"], item["workspaceId"], item["app"]) == (
        "ws_social",
        USER,
        "stories",
        {"choice": "clips"},
    )


@pytest.mark.parametrize("platform", ["youtube", "tiktok", "instagram", "facebook", "x"])
def test_own_app_keys_live_only_under_the_workspace_and_show_masked(
    call: Call,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    platform: str,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status, body = call("PUT", f"{ROOT}/{platform}/app", {"choice": "own", **GOOD[platform]})
    assert status == 200, body
    app = body["account"]["app"]
    assert (app["choice"], app["saved"]) == ("own", True)
    assert set(app["hints"]) == set(GOOD[platform])
    assert app["hints"]["clientSecret"] == "••••" + GOOD[platform]["clientSecret"][-4:]
    name = f"cf-prod/workspaces/stories/{platform}/app"
    stored = secrets_client.json(name)
    assert {k: stored[k] for k in GOOD[platform]} == GOOD[platform]
    assert {t["Key"]: t["Value"] for t in secrets_client.tags[name]} == {
        "app": "cf-prod",
        "workspace": "stories",
        "platform": platform,
    }
    assert not [w for w in secrets_client.writes if not w[1].startswith("cf-prod/workspaces/stories/")]
    logs = capsys.readouterr().out
    assert leaked(GOOD[platform]["clientSecret"], responses=[body], table=table, logs=logs) == []


def test_own_app_keys_are_checked_like_clip_factorys(call: Call) -> None:
    status, body = call("PUT", f"{ROOT}/youtube/app", {"choice": "own", "clientId": "123", "clientSecret": "x"})
    assert status == 400
    assert body["error"]["message"] == "The Client ID ends with .apps.googleusercontent.com. Copy it again."
    status, body = call("PUT", f"{ROOT}/youtube/app", {"choice": "own", **GOOD["youtube"], "configId": "1234567890"})
    assert status == 400
    assert body["error"]["message"] == "YouTube does not use a Configuration ID."
    status, body = call("PUT", f"{ROOT}/facebook/app", {"choice": "own", **GOOD["youtube"]})
    assert status == 400


META_APP = "cf-prod/workspaces/stories/{}/app"


def test_one_meta_app_is_entered_once_for_both(call: Call, store: db.Store, secrets_client: FakeSecretsManager) -> None:
    assert call("PUT", f"{ROOT}/instagram/app", {"choice": "own", **GOOD["instagram"]})[0] == 200
    shown = accounts(call)
    assert shown["facebook"]["app"]["choice"] == "own"
    assert shown["facebook"]["app"]["saved"] is True
    assert secrets_client.json(META_APP.format("facebook"))["clientId"] == GOOD["facebook"]["clientId"]
    # The same app's secret reset in Meta and pasted again on Instagram: Facebook gets it too, nobody disconnects.
    sup.social(store, secrets_client, "instagram")
    sup.social(store, secrets_client, "facebook")
    reset = {**GOOD["instagram"], "clientSecret": "f" * 32}
    assert call("PUT", f"{ROOT}/instagram/app", {"choice": "own", **reset})[0] == 200
    for platform in ("instagram", "facebook"):
        assert secrets_client.json(META_APP.format(platform))["clientSecret"] == "f" * 32
    shown = accounts(call)
    assert shown["instagram"]["connectionStatus"] == shown["facebook"]["connectionStatus"] == "connected"
    assert shown["instagram"]["app"]["hints"] == shown["facebook"]["app"]["hints"]


def test_a_new_meta_app_on_one_card_moves_both_and_disconnects_both(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "instagram")
    sup.social(store, secrets_client, "facebook")
    other = {"clientId": "6543210987654321", "clientSecret": "a" * 32, "configId": "111111111111111"}
    status, body = call("PUT", f"{ROOT}/facebook/app", {"choice": "own", **other})
    assert status == 200, body
    for platform in ("instagram", "facebook"):
        assert secrets_client.json(META_APP.format(platform)) == {**other, "savedAt": "2026-11-15T12:00:00.000Z"}
        assert f"cf-prod/workspaces/stories/{platform}/token" not in secrets_client.values
    shown = accounts(call)
    assert shown["instagram"]["connectionStatus"] == shown["facebook"]["connectionStatus"] == "not_connected"
    assert shown["instagram"]["app"]["hints"] == shown["facebook"]["app"]["hints"]
    assert http.calls == []  # never a revoke


def test_deleting_the_own_meta_app_deletes_it_for_both(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.social(store, secrets_client, "instagram")
    sup.social(store, secrets_client, "facebook")
    status, _ = call("DELETE", f"{ROOT}/instagram/app")
    assert status == 204
    shown = accounts(call)
    for platform in ("instagram", "facebook"):
        assert META_APP.format(platform) not in secrets_client.values
        assert f"cf-prod/workspaces/stories/{platform}/token" not in secrets_client.values
        assert shown[platform]["connectionStatus"] == "not_connected"
        assert shown[platform]["app"] == {"choice": None, "saved": False}


def test_a_change_of_app_disconnects_first_and_never_revokes(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.clips_account(store, secrets_client, "youtube")
    sup.social(store, secrets_client, "youtube", choice="clips")
    before = sup.lamo_clips_items(table)
    status, body = call("PUT", f"{ROOT}/youtube/app", {"choice": "own", **GOOD["youtube"]})
    assert status == 200, body
    assert body["account"]["connectionStatus"] == "not_connected"
    assert body["account"]["app"]["choice"] == "own"
    assert "cf-prod/workspaces/stories/youtube/token" not in secrets_client.values
    assert http.calls == []
    assert sup.lamo_clips_items(table) == before
    assert sup.clips_secret_writes(secrets_client) == []


def test_saving_the_same_own_app_again_keeps_the_connection(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.social(store, secrets_client, "x", choice="own")
    secret = {**GOOD["x"], "clientSecret": "N" * 50}  # a rotated secret of the same app
    status, body = call("PUT", f"{ROOT}/x/app", {"choice": "own", **secret})
    assert status == 200, body
    assert body["account"]["connectionStatus"] == "connected"
    assert "cf-prod/workspaces/stories/x/token" in secrets_client.values


def test_deleting_own_app_keys_disconnects_and_never_touches_clip_factorys(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "tiktok", choice="own")
    clips_keys = secrets_client.values["cf-prod/platforms/tiktok/app"]
    assert call("DELETE", f"{ROOT}/tiktok/app")[0] == 204
    shown = accounts(call)["tiktok"]
    assert (shown["connectionStatus"], shown["app"]) == ("not_connected", {"choice": None, "saved": False})
    assert "cf-prod/workspaces/stories/tiktok/app" not in secrets_client.values
    assert "cf-prod/workspaces/stories/tiktok/token" not in secrets_client.values
    assert secrets_client.values["cf-prod/platforms/tiktok/app"] == clips_keys
    assert http.calls == []
    # With Clip Factory's app chosen, deleting saved own keys leaves the connection alone.
    sup.social(store, secrets_client, "x", choice="clips")
    sup.own_keys(secrets_client, "x")
    assert call("DELETE", f"{ROOT}/x/app")[0] == 204
    shown = accounts(call)["x"]
    assert (shown["connectionStatus"], shown["app"]["choice"]) == ("connected", "clips")


def test_check_it_uses_the_own_app_and_lamo_stories_redirect(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    status, body = call("POST", f"{ROOT}/youtube/app/check")
    assert (status, body["error"]["message"]) == (409, "Paste your Lamo Stories YouTube app keys first.")
    assert call("PUT", f"{ROOT}/youtube/app", {"choice": "own", **GOOD["youtube"]})[0] == 200
    http.answers.append((400, {"error": "invalid_grant"}))
    status, body = call("POST", f"{ROOT}/youtube/app/check")
    assert status == 200, body
    assert body["check"] == {
        "at": "2026-11-15T12:00:00.000Z",
        "ok": True,
        "code": "not_connected",
        "message": "Your keys work. Now press Connect YouTube.",
        "account": "none",
    }
    sent = parse_qs(http.calls[0].body.decode())
    assert sent["redirect_uri"] == [f"{sup.STORIES_CALLBACK}/youtube/callback"]
    assert sent["client_id"] == [GOOD["youtube"]["clientId"]]
    assert accounts(call)["youtube"]["app"]["check"]["code"] == "not_connected"
    http.answers.append((401, {"error": "invalid_client"}))
    _, body = call("POST", f"{ROOT}/youtube/app/check")
    assert (body["check"]["ok"], body["check"]["code"]) == (False, "keys_wrong")


GRANT_OK = (400, {"error": "invalid_grant"})  # Google's answer to a made-up code with good keys


@pytest.mark.parametrize(
    ("answer", "expected", "status"),
    [
        (
            (200, {"items": [{"id": "UC-STORIES"}]}),
            {
                "ok": True,
                "code": "ok",
                "account": "ok",
                "message": "Everything works. Lamo Stories can post to YouTube.",
            },
            "connected",
        ),
        (
            (401, {"error": {"code": 401}}),
            {
                "ok": False,
                "code": "token_dead",
                "account": "dead",
                "message": "Your keys work, but the connection stopped. Press Connect again.",
            },
            "needs_reconnect",
        ),
        (
            (503, {}),
            {
                "ok": False,
                "code": "platform_down",
                "account": "none",
                "message": "YouTube did not answer. Try again in a few minutes.",
            },
            "connected",
        ),
    ],
)
def test_check_it_on_the_own_app_also_checks_the_connected_account(
    call: Call,
    store: db.Store,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    answer: tuple[int, Any],
    expected: dict[str, Any],
    status: str,
) -> None:
    sup.social(store, secrets_client, "youtube", choice="own", lastCheckedAt="2026-11-14T09:00:00.000Z")
    http.answers.extend([GRANT_OK, answer])
    code, body = call("POST", f"{ROOT}/youtube/app/check")
    assert code == 200, body
    assert body["check"] == {"at": "2026-11-15T12:00:00.000Z", **expected}
    assert http.calls[1].url.startswith(providers.YOUTUBE_CHANNELS)  # the workspace token, never Lamo Clips'
    assert http.calls[1].headers["Authorization"] == "Bearer ya29.WS-ACCESS"
    shown = accounts(call)["youtube"]
    assert shown["connectionStatus"] == status
    assert shown["app"]["check"] == {"at": "2026-11-15T12:00:00.000Z", **expected}
    checked = expected["code"] != "platform_down"
    assert shown["lastCheckedAt"] == ("2026-11-15T12:00:00.000Z" if checked else "2026-11-14T09:00:00.000Z")


def test_check_it_on_the_own_x_app_says_when_the_credits_ran_out(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "x", choice="own")
    http.answers.extend([(400, {"error": "invalid_request"}), (402, {"title": "CreditsDepleted"})])
    _, body = call("POST", f"{ROOT}/x/app/check")
    assert body["check"] == {
        "at": "2026-11-15T12:00:00.000Z",
        "ok": False,
        "code": "credits_empty",
        "account": "ok",
        "message": "Your X credits ran out. Buy more in Billing › Credits.",
    }
    assert accounts(call)["x"]["warning"] == social.X_CREDITS


def test_check_it_on_new_own_keys_says_the_account_must_connect_again(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "youtube", choice="own", appClientId="old-client.apps.googleusercontent.com")
    http.answers.append(GRANT_OK)
    _, body = call("POST", f"{ROOT}/youtube/app/check")
    assert body["check"] == {
        "at": "2026-11-15T12:00:00.000Z",
        "ok": False,
        "code": "token_dead",
        "account": "dead",
        "message": "The YouTube app keys changed. Connect again.",
    }
    assert len(http.calls) == 1  # the old token is never tried with the new app
    shown = accounts(call)["youtube"]
    assert (shown["connectionStatus"], shown["reason"]) == ("needs_reconnect", "keys_changed")
    assert shown["warning"] == "The YouTube app keys changed. Connect again."


# --- TikTok's own app: one open_id per app (§45.13.4) ---------------------------------------------------------


def test_an_own_tiktok_app_cannot_tell_lamo_clips_tiktok_and_says_so(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    # The very same TikTok account as Lamo Clips', connected through Lamo Stories' own app: another open_id.
    sup.clips_account(store, secrets_client, "tiktok")
    sup.social(store, secrets_client, "tiktok", choice="own", identity="open-same-person-other-app")
    shown = accounts(call)["tiktok"]
    assert shown["connectionStatus"] == "connected"
    assert (shown["reason"], shown["warning"]) == ("clips_unknown", social.TIKTOK_UNSURE)
    assert any("cannot tell" in line for line in shown["limits"])
    # Clip Factory's app gives the same open_id: compared as before, no warning.
    sup.social(store, secrets_client, "tiktok", choice="clips")
    shown = accounts(call)["tiktok"]
    assert (shown["reason"], shown["warning"]) == (None, None)
    # Without a Lamo Clips TikTok there is nothing to mix up.
    store.delete(f"USER#{USER}", "ACCOUNT#tiktok")
    sup.social(store, secrets_client, "tiktok", choice="own", identity="open-same-person-other-app")
    assert accounts(call)["tiktok"]["warning"] is None


# --- disconnect never revokes ---------------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["connected", "same_as_clips", "needs_reconnect", "choose_account", "none"])
@pytest.mark.parametrize("platform", ["youtube", "tiktok", "instagram", "facebook", "x"])
def test_disconnect_never_calls_a_revoke_endpoint(
    call: Call,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    platform: str,
    status: str,
) -> None:
    sup.clips_account(store, secrets_client, platform)
    if status != "none":
        sup.social(store, secrets_client, platform, status=status)
        secrets_client.values[f"cf-prod/workspaces/stories/{platform}/pending"] = json.dumps({"tokens": {}})
    before = sup.lamo_clips_items(table)
    clips_token = secrets_client.values[f"cf-prod/platforms/{platform}/token"]
    assert call("DELETE", f"{ROOT}/{platform}")[0] == 204
    assert http.calls == []  # no revoke, no call at all
    assert f"cf-prod/workspaces/stories/{platform}/token" not in secrets_client.values
    assert f"cf-prod/workspaces/stories/{platform}/pending" not in secrets_client.values
    assert secrets_client.values[f"cf-prod/platforms/{platform}/token"] == clips_token
    assert sup.lamo_clips_items(table) == before
    shown = accounts(call)[platform]
    assert (shown["connectionStatus"], shown["externalAccountId"], shown["lastCheckedAt"]) == (
        "not_connected",
        None,
        None,
    )
    if status != "none":
        assert shown["app"]["choice"] == sup.default_choice(platform)  # the app choice stays


def test_the_workspace_code_never_revokes() -> None:
    import inspect

    from clipfactory_api.workspaces import social_callback, tokens

    for module in (social, social_callback, tokens, apps):
        source = inspect.getsource(module)
        assert "revoke(" not in source
        assert "mark_account(store, user_id, platform" not in source
        assert "setup.put_account" not in source
        assert "setup.record" not in source
        assert "release_waiting" not in source


# --- leaked() over every new route -----------------------------------------------------------------------------


def test_no_token_or_key_leaks_from_any_social_or_publishing_route(
    call: Call,
    app: App,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    capsys: pytest.CaptureFixture[str],
) -> None:
    sup.install(app, secrets_client, sup.FakeStarter())
    for platform in ("youtube", "tiktok", "instagram", "facebook", "x"):
        sup.social(store, secrets_client, platform)
    sup.story(store)
    failed = sup.pubjob(store, "facebook", job_id="01JZ0000000000000000000002", publishingStatus="failed")
    responses: list[Any] = []
    http.answers.extend(
        [
            (200, {"items": [{"id": "UC-STORIES"}]}),
            (200, {"data": {"user": {"open_id": "open-stories"}}, "error": {"code": "ok"}}),
            (200, "publish/tiktok_creator"),
            (200, {"access_token": "APP-TOKEN-XYZ"}),
            (200, {"name": "Lamo Stories"}),
        ]
    )
    for method, path, body in (
        ("GET", ROOT, None),
        ("POST", f"{ROOT}/youtube/connect", None),
        ("POST", f"{ROOT}/instagram/connect", None),
        ("POST", f"{ROOT}/youtube/check", None),
        ("POST", f"{ROOT}/tiktok/check", None),
        ("GET", f"{ROOT}/tiktok/creator-info", None),
        ("POST", f"{ROOT}/youtube/share", {"confirm": True}),
        ("POST", f"{ROOT}/instagram/choose", {"choiceId": "1"}),
        ("PUT", f"{ROOT}/facebook/app", {"choice": "own", **GOOD["facebook"]}),
        ("POST", f"{ROOT}/facebook/app/check", None),
        ("PUT", f"{ROOT}/youtube/app", {"choice": "clips"}),
        ("POST", f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish", {"targets": []}),
        (
            "POST",
            f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish",
            {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]},
        ),
        ("GET", "/v1/workspaces/stories/publishing", None),
        ("POST", f"/v1/workspaces/stories/publishing/{failed['publishingJobId']}/retry", {}),
        ("DELETE", f"{ROOT}/x", None),
        ("DELETE", f"{ROOT}/tiktok/app", None),
        ("GET", "/v1/stories-oauth/youtube/callback", None),
    ):
        responses.append(call(method, path, body, sub=None if "stories-oauth" in path else USER)[1])
    assert [r["publishingJob"]["publishingStatus"] for r in responses if r and "publishingJob" in r] == ["queued"]
    assert any(r and r.get("publishingJobs") for r in responses)
    logs = capsys.readouterr().out
    for secret in [*sup.WS_SECRET_VALUES, STATE_KEY, "APP-TOKEN-XYZ", *(GOOD[p]["clientSecret"] for p in GOOD)]:
        assert leaked(secret, responses=responses, table=table, logs=logs) == [], secret


def test_the_api_never_loads_the_durable_sdk_or_the_stats_refresh() -> None:
    import subprocess
    import sys

    code = (
        "import sys, clipfactory_api.workspaces.http, clipfactory_api.workspaces.routes, clipfactory_api.hooks\n"
        "from clipfactory_api.workspaces import social_callback, publish, tokens, destinations, apps\n"
        "print('aws_durable_execution_sdk_python' in sys.modules, 'clipfactory_api.stats.refresh' in sys.modules,\n"
        "      'clipfactory_api.routes' in sys.modules)"
    )
    out = subprocess.run([sys.executable, "-c", code], check=True, capture_output=True, text=True).stdout
    assert out.strip() == "False False False"
