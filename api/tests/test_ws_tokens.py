"""``WorkspaceTokenProvider``: refresh, rotation, dead tokens, the TikTok watch and the lease, written only under the
workspace (docs/CONTRACTS.md §45.14, §45.19).

Every case also checks that nothing outside ``USER#{u}#WS#{ws}`` and ``cf-prod/workspaces/{ws}/`` is written, that a
seeded ``ACCOUNT#tiktok`` stays byte-identical, and that ``cf-prod/platforms/*/token`` is never even read.
"""

from __future__ import annotations

import copy
import dataclasses
import inspect
import json
from typing import Any
from urllib.parse import parse_qs

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.oauth import OAuthEnv, setup
from clipfactory_api.oauth import tokens as clips_tokens
from clipfactory_api.platforms.base import NotConnectedError, ReconnectNeededError, RetryablePublishError
from clipfactory_api.workspaces import tokens
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from clipfactory_api.workspaces.tokens import WorkspaceTokenProvider
from conftest import NOW, USER
from fakes import FakeHttp, FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD

SOON = "2026-11-15T12:03:00.000Z"


@pytest.fixture
def ws_secrets(secrets_client: FakeSecretsManager, store: db.Store) -> WorkspaceSecrets:
    sup.app_keys(secrets_client)
    sup.workspace(store)
    # Lamo Clips' own TikTok connection and token: they must stay exactly as they are.
    setup.put_account(
        store, USER, "tiktok", "connected", now=NOW, fields={"accountId": "open-1", "reconnectBy": "2027-01-01"}
    )
    secrets_client.values["cf-prod/platforms/tiktok/token"] = json.dumps({"accessToken": "CLIPS", "openId": "open-1"})
    return WorkspaceSecrets(secrets_client)


@pytest.fixture
def provider(store: db.Store, oauth_env: OAuthEnv, ws_secrets: WorkspaceSecrets) -> WorkspaceTokenProvider:
    return WorkspaceTokenProvider(store, oauth_env, ws_secrets, USER, "stories", sleep=lambda _s: None)


def only_workspace_writes(table: FakeTable, secrets_client: FakeSecretsManager, since: int) -> None:
    for op, kw in table.calls[since:]:
        if op in {"put_item", "update_item", "delete_item"}:
            key = kw.get("Key") or kw.get("Item") or {}
            assert str(key.get("pk")).startswith(f"USER#{USER}#WS#stories"), (op, key)
    for _, name in secrets_client.writes:
        assert name.startswith("cf-prod/workspaces/stories/"), name
    for _, name in secrets_client.calls:
        assert not name.startswith("cf-prod/platforms/") or name.endswith("/app"), name


def clips_tiktok(table: FakeTable) -> Any:
    return copy.deepcopy(table.raw(db.user_pk(USER), "ACCOUNT#tiktok"))


def test_a_fresh_token_is_used_as_is(
    provider: WorkspaceTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "youtube")
    creds = provider.credentials("youtube")
    assert creds.access_token == "ya29.WS-ACCESS"
    assert creds.app.client_id == GOOD["youtube"]["clientId"]
    assert provider("youtube", {"accountId": "anything", "pk": "USER#someone-else"}) == "ya29.WS-ACCESS"
    assert http.calls == []
    assert ("get", "cf-prod/workspaces/stories/youtube/token") in secrets_client.calls


def test_no_workspace_token_is_not_connected_even_when_lamo_clips_has_one(
    provider: WorkspaceTokenProvider, secrets_client: FakeSecretsManager
) -> None:
    secrets_client.values["cf-prod/platforms/youtube/token"] = json.dumps({"accessToken": "CLIPS-YT"})
    with pytest.raises(NotConnectedError) as e:
        provider.credentials("youtube")
    assert "Clip Factory Stories' YouTube" in str(e.value)
    assert "Settings" not in str(e.value)
    assert ("get", "cf-prod/platforms/youtube/token") not in secrets_client.calls


def test_meta_uses_the_page_token_and_never_refreshes(
    provider: WorkspaceTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "instagram", token={**sup.TOKENS["instagram"], "expiresAt": SOON})
    assert provider("instagram") == "EAAG-WS-PAGE"
    assert http.calls == []


def test_google_refresh_writes_the_workspace_secret(
    provider: WorkspaceTokenProvider,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
) -> None:
    sup.social(store, secrets_client, "youtube", token={**sup.TOKENS["youtube"], "expiresAt": SOON})
    since, before = len(table.calls), clips_tiktok(table)
    http.answers.append((200, {"access_token": "NEW", "expires_in": 3599}))
    assert provider("youtube") == "NEW"
    sent = parse_qs(http.calls[0].body.decode())
    assert sent["refresh_token"] == ["1//WS-REFRESH"]
    assert sent["client_id"] == [GOOD["youtube"]["clientId"]]
    stored = secrets_client.json("cf-prod/workspaces/stories/youtube/token")
    assert (stored["accessToken"], stored["refreshToken"], stored["channelId"]) == (
        "NEW",
        "1//WS-REFRESH",
        "UC-STORIES",
    )
    only_workspace_writes(table, secrets_client, since)
    assert clips_tiktok(table) == before


@pytest.mark.parametrize("platform", ["tiktok", "x"])
def test_rotation_writes_the_new_secret_put_only_before_use_and_clears_the_lease(
    provider: WorkspaceTokenProvider,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
    platform: str,
) -> None:
    sup.social(store, secrets_client, platform, token={**sup.TOKENS[platform], "expiresAt": SOON})
    since, before = len(table.calls), clips_tiktok(table)
    answer: dict[str, Any] = {"access_token": "NEW", "expires_in": 7200, "refresh_token": "R2"}
    if platform == "tiktok":
        answer["refresh_expires_in"] = 31_536_000
    http.answers.append((200, answer))
    order: list[str] = []
    original = secrets_client.put_secret_value

    def put(**kw: Any) -> dict[str, Any]:
        order.append("secret")
        return original(**kw)

    secrets_client.put_secret_value = put  # type: ignore[method-assign,assignment]
    token = provider(platform)
    order.append("used")
    assert token == "NEW"
    assert order == ["secret", "used"]
    assert secrets_client.json(f"cf-prod/workspaces/stories/{platform}/token")["refreshToken"] == "R2"
    assert not [w for w in secrets_client.writes if w[0] == "create"]  # put only
    item = table.raw(sup.PK, f"SOCIAL#{platform}")
    assert item is not None
    assert "refreshLeaseUntil" not in item
    only_workspace_writes(table, secrets_client, since)
    assert clips_tiktok(table) == before


def test_a_held_lease_waits_for_the_other_refresher(
    provider: WorkspaceTokenProvider, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    sup.social(store, secrets_client, "x", token={**sup.TOKENS["x"], "expiresAt": SOON})
    store.update(sup.PK, "SOCIAL#x", {"refreshLeaseUntil": "2026-11-15T12:00:20.000Z"})
    since = len(table.calls)
    with pytest.raises(RetryablePublishError) as e:
        provider("x")
    assert "Settings" not in str(e.value)
    only_workspace_writes(table, secrets_client, since)


def test_a_disconnect_during_a_refresh_is_not_connected(
    provider: WorkspaceTokenProvider, store: db.Store, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.social(store, secrets_client, "youtube", token={**sup.TOKENS["youtube"], "expiresAt": SOON})

    def answer(_request: Any) -> Any:
        del secrets_client.values["cf-prod/workspaces/stories/youtube/token"]  # Disconnect, a moment ago
        from clipfactory_api.platforms import HttpResponse

        return HttpResponse(200, {}, json.dumps({"access_token": "NEW", "expires_in": 3599}).encode())

    provider.env = dataclasses.replace(provider.env, http=answer)
    with pytest.raises(NotConnectedError):
        provider("youtube")
    assert "cf-prod/workspaces/stories/youtube/token" not in secrets_client.values  # never re-created


def test_a_dead_token_marks_only_the_workspace_account(
    provider: WorkspaceTokenProvider,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
) -> None:
    sup.social(store, secrets_client, "tiktok", token={**sup.TOKENS["tiktok"], "expiresAt": SOON})
    since, before = len(table.calls), clips_tiktok(table)
    http.answers.append((400, {"error": "invalid_grant"}))
    with pytest.raises(ReconnectNeededError) as e:
        provider("tiktok")
    assert str(e.value) == (
        "This TikTok account (Lamo Stories tiktok) needs connecting again. Open Clip Factory Stories › Social accounts, "
        "then tap Try again."
    )
    item = table.raw(sup.PK, "SOCIAL#tiktok")
    assert item is not None
    assert (item["connectionStatus"], item["reason"]) == ("needs_reconnect", "token_dead")
    only_workspace_writes(table, secrets_client, since)
    assert clips_tiktok(table) == before


def test_the_tiktok_watch_sets_reconnect_by_on_the_workspace_account(
    provider: WorkspaceTokenProvider,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    http: FakeHttp,
) -> None:
    sup.social(store, secrets_client, "tiktok", token={**sup.TOKENS["tiktok"], "expiresAt": SOON})
    since, before = len(table.calls), clips_tiktok(table)
    http.answers.append(
        (200, {"access_token": "NEW", "expires_in": 86400, "refresh_token": "R2", "refresh_expires_in": 3 * 86400})
    )
    assert provider("tiktok") == "NEW"
    item = table.raw(sup.PK, "SOCIAL#tiktok")
    assert item is not None
    assert item["reason"] == "expires_soon"
    assert item["reconnectBy"] == "2026-11-11T12:00:00.000Z"
    only_workspace_writes(table, secrets_client, since)
    assert clips_tiktok(table) == before


def test_its_own_class_with_none_of_lamo_clips_helpers() -> None:
    assert not issubclass(WorkspaceTokenProvider, clips_tokens.SecretsTokenProvider)
    source = inspect.getsource(tokens)
    for name in (
        "SecretsTokenProvider",
        "mark_account(self.store, _user_id",
        "setup.",
        "stats.refresh",
        "refresh_posts",
    ):
        assert name not in source, name
    assert "from ..oauth.tokens import Credentials, clear_lease, take_lease" in source
    with pytest.raises(ValueError, match="Clip Factory Stories"):
        WorkspaceTokenProvider(None, None, None, USER, "clips")  # type: ignore[arg-type]
