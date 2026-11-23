"""Provider API keys (docs/CONTRACTS.md §45.3 ``PROVCRED#``, §45.5 ``…/providers/{providerId}/key``, §45.31):
stored only in Secrets Manager under ``cf-prod/workspaces/{ws}/providers/{providerId}`` with tags, a hint on the
item, never returned or logged; providers on the app's own AWS access never ask for one; and, until a provider that
takes a key is added in code, the route says so instead of storing anything."""

from __future__ import annotations

import json

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import hosts, provider_keys
from clipfactory_api.workspaces import types as ws
from conftest import STATE_SECRET
from fakes import FakeSecretsManager, FakeTable
from test_ws_ai_support import (
    BASE,
    FakeRuntime,
    WsCall,
    dynamodb_rules,  # noqa: F401 (the DynamoDB expression rules, after each test)
    install,
    leaked,
    pk,
    seed,
    ws_call,
)

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


def test_only_the_keyed_hosts_take_a_key(wcall: WsCall, secrets_client: FakeSecretsManager) -> None:
    """§45.37 G4: the Anthropic API, an OpenAI-compatible API and ElevenLabs take the owner's key; every maker on
    Lamo Stories' own AWS access (Bedrock, Polly) never asks for one."""
    assert set(provider_keys.KEYED) == {"anthropic", "openai_compatible", "elevenlabs"}
    status, body = wcall("PUT", f"{BASE}/providers/runway/key", {"key": KEY})
    assert (status, body["error"]["message"]) == (
        404,
        "Clip Stories has no provider called 'runway' that uses a key yet.",
    )
    status, body = wcall("PUT", f"{BASE}/providers/nova-canvas/key", {"key": KEY})
    assert (status, body["error"]["message"]) == (
        400,
        "Amazon Nova Canvas uses Clip Stories' own AWS access, so it needs no key.",
    )
    for aws in ("stability", "luma-ray", "polly", "bedrock"):
        assert wcall("PUT", f"{BASE}/providers/{aws}/key", {"key": KEY})[0] == 400
    assert wcall("PUT", f"{BASE}/providers/Bad_Id/key", {"key": KEY})[0] == 404
    assert secrets_client.writes == []


@pytest.mark.parametrize("host", ["anthropic", "openai_compatible", "elevenlabs"])
def test_a_keyed_hosts_key_is_saved_as_json_under_its_own_name(
    wcall: WsCall, secrets_client: FakeSecretsManager, table: FakeTable, host: str
) -> None:
    where = {"baseUrl": "https://api.groq.com/openai/v1"} if host == "openai_compatible" else {}
    status, body = wcall("PUT", f"{BASE}/providers/{host}/key", {"key": KEY, **where})
    assert status == 200, body
    name = f"cf-prod/workspaces/stories/providers/{host}"
    # an OpenAI-compatible key names the one address it is for, so it never goes anywhere else
    assert secrets_client.json(name) == {"key": KEY, **({"origin": "https://api.groq.com"} if where else {})}
    assert body["provider"]["key"] == {"saved": True, "hint": "4f2a", "savedAt": "2026-11-15T12:00:00.000Z"}
    assert KEY not in json.dumps(body)
    assert KEY not in json.dumps(table.all())
    _, listed = wcall("GET", f"{BASE}/providers")
    row = next(p for p in listed["providers"] if p["id"] == host)
    assert row["key"]["saved"] is True
    assert KEY not in json.dumps(listed)
    assert wcall("DELETE", f"{BASE}/providers/{host}/key")[0] == 204
    assert name not in secrets_client.values


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
        # §45.34: a provider that takes a key says whether one is saved (never the key itself)
        "key": {"saved": True, "hint": "4f2a", "savedAt": "2026-11-15T12:00:00.000Z"},
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
    with pytest.raises(ValueError, match="Clip Stories"):
        ws.provider_secret_name("cf-prod/workspaces/", "clips", "runway")
    with pytest.raises(ValueError, match="platforms"):
        ws.provider_secret_name("cf-prod/platforms/", "stories", "runway")


def test_the_providers_list_shows_each_keyed_providers_key_state(
    wcall: WsCall, keyed: provider_keys.KeyedProvider, secrets_client: FakeSecretsManager
) -> None:
    """``ProviderStatus.key`` (§45.34): present only for a provider that takes a key; the key card offers "Remove
    the saved key" only while ``saved``."""
    _, body = wcall("GET", f"{BASE}/providers")
    by = {p["id"]: p for p in body["providers"]}
    assert by["runway"]["key"] == {"saved": False, "hint": None, "savedAt": None}
    assert by["runway"]["state"] == "needs_setup"
    keyed = {"runway", "anthropic", "openai_compatible", "elevenlabs"}  # §45.37 G4: the keyed hosts too
    assert all("key" not in p for i, p in by.items() if i not in keyed)  # the others take no key
    wcall("PUT", f"{BASE}/providers/runway/key", {"key": KEY})
    _, body = wcall("GET", f"{BASE}/providers")
    shown = next(p for p in body["providers"] if p["id"] == "runway")
    assert shown["key"] == {"saved": True, "hint": "4f2a", "savedAt": "2026-11-15T12:00:00.000Z"}
    assert KEY not in json.dumps(body)
    wcall("DELETE", f"{BASE}/providers/runway/key")
    _, body = wcall("GET", f"{BASE}/providers")
    assert next(p for p in body["providers"] if p["id"] == "runway")["key"]["saved"] is False


def test_only_the_keyed_rows_carry_a_key(wcall: WsCall) -> None:
    """The registry's makers on AWS take no key; ElevenLabs' key shows on its sound maker's row, the Anthropic API
    and an OpenAI-compatible API have their own rows (§45.37 G4)."""
    _, body = wcall("GET", f"{BASE}/providers")
    keyed = {p["id"] for p in body["providers"] if "key" in p}
    assert keyed == {"elevenlabs", "anthropic", "openai_compatible"}
    assert next(p for p in body["providers"] if p["id"] == "elevenlabs")["kind"] == "audio"


GROQ = "https://api.groq.com/openai/v1"
TOGETHER = "https://api.together.xyz/v1"
REASONING = {
    "label": "Llama on Groq",
    "provider": "Meta",
    "host": "openai_compatible",
    "baseUrl": GROQ,
    "modelId": "meta-llama/llama-4-maverick",
    "efforts": [],
    "vision": False,
    "maxOutputTokens": 8000,
    "effortField": "none",
}
PICTURE_ON_OTHER = {
    "kind": "image",
    "label": "Pictures on Together",
    "provider": "Black Forest Labs",
    "host": "openai_compatible",
    "baseUrl": TOGETHER,
    "modelId": "black-forest-labs/flux-pro",
}


def test_the_openai_compatible_key_only_ever_goes_to_its_one_address(
    wcall: WsCall, secrets_client: FakeSecretsManager, table: FakeTable
) -> None:
    """The reviewer's G4 major: one key per OpenAI-compatible host, so every model there must use the address the key
    is for; another address is refused (409) until that key is removed, and the secret names its address for the
    agent to check before every call."""
    name = "cf-prod/workspaces/stories/providers/openai_compatible"
    status, body = wcall("PUT", f"{BASE}/providers/openai_compatible/key", {"key": KEY})
    assert (status, body["error"]["message"]) == (409, provider_keys.NEED_MODEL_FIRST)
    assert wcall("PUT", f"{BASE}/ai/models/custom-llama", REASONING)[0] == 200
    status, body = wcall("PUT", f"{BASE}/providers/openai_compatible/key", {"key": KEY})
    assert status == 200, body
    assert secrets_client.json(name) == {"key": KEY, "origin": "https://api.groq.com"}
    assert body["provider"]["line"].startswith("Key saved for api.groq.com · ends 4f2a.")
    assert table.raw(pk(), "PROVCRED#openai_compatible")["forOrigin"] == "https://api.groq.com"
    assert "forOrigin" not in json.dumps(body)  # internal: only the host name, in the line
    # a second service: refused while the first one's model is there
    status, body = wcall("PUT", f"{BASE}/makers/models/custom-flux", PICTURE_ON_OTHER)
    assert (status, body["error"]["message"]) == (409, hosts.ONE_SERVICE.format(host="api.groq.com"))
    # moving the only model to another address: refused while the key is for the first one
    status, body = wcall("PUT", f"{BASE}/ai/models/custom-llama", {**REASONING, "baseUrl": TOGETHER})
    assert (status, body["error"]["message"]) == (
        409,
        hosts.KEY_FOR_OTHER.format(saved="api.groq.com", host="api.together.xyz"),
    )
    # the same address (another path) is fine
    assert wcall("PUT", f"{BASE}/ai/models/custom-llama", {**REASONING, "baseUrl": GROQ + "/"})[0] == 200
    # remove the key: then the model may move, and the new key is for the new address
    assert wcall("DELETE", f"{BASE}/providers/openai_compatible/key")[0] == 204
    assert wcall("PUT", f"{BASE}/ai/models/custom-llama", {**REASONING, "baseUrl": TOGETHER})[0] == 200
    status, body = wcall("PUT", f"{BASE}/providers/openai_compatible/key", {"key": KEY, "baseUrl": GROQ})
    assert (status, body["error"]["message"]) == (409, hosts.ONE_SERVICE.format(host="api.together.xyz"))
    assert wcall("PUT", f"{BASE}/providers/openai_compatible/key", {"key": KEY})[0] == 200
    assert secrets_client.json(name) == {"key": KEY, "origin": "https://api.together.xyz"}
    status, body = wcall("PUT", f"{BASE}/providers/elevenlabs/key", {"key": KEY, "baseUrl": GROQ})
    assert (status, body["error"]["message"]) == (400, provider_keys.BASE_URL_ONLY_FOR_OPENAI)


def test_a_keyed_hosts_row_is_on_once_a_model_there_answered_its_check(wcall: WsCall, store: db.Store) -> None:
    """The reviewer's G4 major: the Anthropic API's (and an OpenAI-compatible API's) row reads the checks of the
    models the owner added there, made since the key was saved; nobody writes ``PROVIDER#writer#anthropic``."""
    opus = {**REASONING, "label": "Opus on the Anthropic API", "provider": "Anthropic", "host": "anthropic",
            "modelId": "claude-opus-5-5", "effortField": "output_config", "efforts": ["low", "high"]}  # fmt: skip
    opus.pop("baseUrl")
    assert wcall("PUT", f"{BASE}/ai/models/custom-opus", opus)[0] == 200
    seed(store, "MODELSTATUS#custom-opus", ws.TYPE_MODELSTATUS, model="custom-opus", status="error",
         line="No key yet.", checkedAt="2026-11-15T11:00:00.000Z", by="check")  # fmt: skip
    assert wcall("PUT", f"{BASE}/providers/anthropic/key", {"key": KEY})[0] == 200  # saved at 12:00
    rows = {p["id"]: p for p in wcall("GET", f"{BASE}/providers")[1]["providers"]}
    assert rows["anthropic"]["state"] == "needs_setup"  # the check before the key says nothing of it
    seed(store, "MODELSTATUS#custom-opus", ws.TYPE_MODELSTATUS, model="custom-opus", status="ok", line="Works.",
         checkedAt="2026-11-15T12:05:00.000Z", by="check")  # fmt: skip
    rows = {p["id"]: p for p in wcall("GET", f"{BASE}/providers")[1]["providers"]}
    assert (rows["anthropic"]["state"], rows["anthropic"]["checkedAt"]) == ("on", "2026-11-15T12:05:00.000Z")
    seed(store, "MODELSTATUS#custom-opus", ws.TYPE_MODELSTATUS, model="custom-opus", status="denied",
         line="Anthropic says the key is not valid.", checkedAt="2026-11-15T12:10:00.000Z", by="check")  # fmt: skip
    row = {p["id"]: p for p in wcall("GET", f"{BASE}/providers")[1]["providers"]}["anthropic"]
    assert (row["state"], row["line"]) == ("needs_setup", "Anthropic says the key is not valid.")
    assert KEY not in json.dumps(row)
