"""Provider API keys (docs/CONTRACTS.md §45.3 ``PROVCRED#``, §45.5 ``…/providers/{providerId}/key``, §45.31):
stored only in Secrets Manager under ``cf-prod/workspaces/{ws}/providers/{providerId}`` with tags, a hint on the
item, never returned or logged; providers on the app's own AWS access never ask for one; and, until a provider that
takes a key is added in code, the route says so instead of storing anything."""

from __future__ import annotations

import json

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import provider_keys
from clipfactory_api.workspaces import types as ws
from conftest import STATE_SECRET
from fakes import FakeSecretsManager, FakeTable
from test_ws_ai_support import BASE, FakeRuntime, WsCall, install, leaked, pk, seed, ws_call

KEY = "sk-live-0123456789abcdef4f2a"
NAME = "cf-prod/workspaces/stories/providers/runway"


@pytest.fixture
def wcall(app: App, secrets_client: FakeSecretsManager) -> WsCall:
    install(app, FakeRuntime(), secrets_client)
    return ws_call(app)


@pytest.fixture
def keyed(monkeypatch: pytest.MonkeyPatch) -> provider_keys.KeyedProvider:
    """A provider that takes a key, as one would be added in code (none exists today)."""
    found = provider_keys.KeyedProvider("animation", "runway", "Runway (test only)")
    monkeypatch.setitem(provider_keys.KEYED, "runway", found)
    return found


def test_no_provider_takes_a_key_today(wcall: WsCall, secrets_client: FakeSecretsManager) -> None:
    assert provider_keys.KEYED == {}
    status, body = wcall("PUT", f"{BASE}/providers/runway/key", {"key": KEY})
    assert (status, body["error"]["message"]) == (
        404,
        "Lamo Stories has no provider called 'runway' that uses a key yet.",
    )
    status, body = wcall("PUT", f"{BASE}/providers/nova-canvas/key", {"key": KEY})
    assert (status, body["error"]["message"]) == (
        400,
        "Amazon Nova Canvas uses Lamo Stories' own AWS access, so it needs no key.",
    )
    assert wcall("PUT", f"{BASE}/providers/Bad_Id/key", {"key": KEY})[0] == 404
    assert secrets_client.writes == []


def test_a_key_is_stored_only_in_secrets_manager(
    wcall: WsCall,
    keyed: provider_keys.KeyedProvider,
    secrets_client: FakeSecretsManager,
    table: FakeTable,
    store: db.Store,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status, body = wcall("PUT", f"{BASE}/providers/runway/key", {"key": f"  {KEY} "})
    assert status == 200
    assert body["provider"] == {
        "kind": "animation",
        "id": "runway",
        "label": "Runway (test only)",
        "state": "needs_setup",  # saved is not working: only a real call turns it on
        "line": "Key saved · ends 4f2a. It is checked on its first real call.",
    }
    assert secrets_client.json(NAME) == {"key": KEY}
    assert secrets_client.tags[NAME] == [
        {"Key": "app", "Value": "cf-prod"},
        {"Key": "workspace", "Value": "stories"},
        {"Key": "provider", "Value": "runway"},
    ]
    cred = table.raw(pk(), "PROVCRED#runway")
    assert cred is not None
    assert (cred["type"], cred["hint"], cred["savedAt"]) == ("ws_provcred", "4f2a", "2026-11-15T12:00:00.000Z")
    logs = capsys.readouterr().out
    assert KEY not in json.dumps(table.all())
    assert KEY not in json.dumps(body)
    assert KEY not in logs
    assert leaked([body]) == []
    # a second save puts a new value on the same secret
    assert wcall("PUT", f"{BASE}/providers/runway/key", {"key": "short"})[0] == 200
    assert secrets_client.json(NAME) == {"key": "short"}
    assert table.raw(pk(), "PROVCRED#runway")["hint"] == ""  # a short key gets no hint
    # only after a real call is it on
    seed(store, "PROVIDER#animation#runway", ws.TYPE_PROVIDER, state="on", checkedAt="2026-11-15T12:30:00.000Z")
    assert wcall("PUT", f"{BASE}/providers/runway/key", {"key": KEY})[1]["provider"]["state"] == "on"
    assert {n for _, n in secrets_client.writes} == {NAME}
    assert STATE_SECRET in secrets_client.values  # nothing else was touched


def test_delete_removes_the_secret_and_the_hint(
    wcall: WsCall, keyed: provider_keys.KeyedProvider, secrets_client: FakeSecretsManager, table: FakeTable
) -> None:
    wcall("PUT", f"{BASE}/providers/runway/key", {"key": KEY})
    assert wcall("DELETE", f"{BASE}/providers/runway/key")[0] == 204
    assert NAME not in secrets_client.values
    assert table.raw(pk(), "PROVCRED#runway") is None
    assert wcall("DELETE", f"{BASE}/providers/runway/key")[0] == 204  # already gone is fine


@pytest.mark.parametrize("body", [{}, {"key": ""}, {"key": 5}, {"key": "x" * 4097}, {"key": "x", "name": "y"}])
def test_key_validation(wcall: WsCall, keyed: provider_keys.KeyedProvider, body: dict[str, object]) -> None:
    assert wcall("PUT", f"{BASE}/providers/runway/key", body)[0] == 400


def test_the_secret_name_never_leaves_the_workspace_prefix() -> None:
    assert ws.provider_secret_name("cf-prod/workspaces/", "stories", "runway") == NAME
    with pytest.raises(ValueError, match="Lamo Stories"):
        ws.provider_secret_name("cf-prod/workspaces/", "clips", "runway")
    with pytest.raises(ValueError, match="platforms"):
        ws.provider_secret_name("cf-prod/platforms/", "stories", "runway")
