"""The Library, the providers list and the guidance list (docs/CONTRACTS.md §45.11.5, §45.11.6, §45.12)."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import guidance, providers
from conftest import OTHER, USER, Call
from fakes import FakeS3
from ws_support import BASE, install, pk, prefix, presigned_keys, seed_asset, seed_character, seed_item, seed_story

ROOT = Path(__file__).resolve().parents[2]
AGENT_REGISTRY = ROOT / "agent" / "src" / "clipfactory_agent" / "stories" / "providers.py"


@pytest.fixture(autouse=True)
def wired(app: App, s3_client: FakeS3) -> None:
    install(app, None, s3_client)


def _asset_id(n: int) -> str:
    return f"01J00000000000000000000A{n:02d}"


def test_the_library_lists_assets_newest_first_with_titles_and_filters(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client, title="Ice test")
    hero = seed_character(store, name="Lamo")
    final = seed_asset(store, s3_client, assetId=_asset_id(1), storyId=story["storyId"], key=story["videoKey"])
    still = seed_asset(
        store,
        s3_client,
        assetId=_asset_id(2),
        storyId=story["storyId"],
        kind="scene_still",
        key=f"{prefix()}stories/{story['storyId']}/scenes/s1/still-v1.jpg",
        contentType="image/jpeg",
        meta={"sceneId": "s1", "current": 1},
    )
    ref = seed_asset(
        store,
        s3_client,
        assetId=_asset_id(3),
        characterId=hero["characterId"],
        kind="character_ref",
        key=f"{prefix()}characters/{hero['characterId']}/refs/{_asset_id(3)}.png",
        contentType="image/png",
        version=None,
    )
    status, body = call("GET", f"{BASE}/library")
    assert status == 200
    items = body["items"]
    assert [i["assetId"] for i in items] == [ref["assetId"], still["assetId"], final["assetId"]]
    assert items[0]["title"] == "Lamo"
    assert items[1]["title"] == "Ice test"
    assert items[1]["meta"] == {"sceneId": "s1", "current": 1}
    assert items[0]["version"] is None
    assert items[2]["version"] == 1
    assert all(i["url"].startswith("https://") for i in items)
    assert "key" not in json.dumps(items)
    only = call("GET", f"{BASE}/library", query={"kind": "scene_still"})[1]["items"]
    assert [i["assetId"] for i in only] == [still["assetId"]]
    by_story = call("GET", f"{BASE}/library", query={"storyId": story["storyId"]})[1]["items"]
    assert {i["assetId"] for i in by_story} == {final["assetId"], still["assetId"]}
    by_character = call("GET", f"{BASE}/library", query={"characterId": hero["characterId"]})[1]["items"]
    assert [i["assetId"] for i in by_character] == [ref["assetId"]]
    assert call("GET", f"{BASE}/library", query={"kind": "song"})[0] == 400
    assert call("GET", f"{BASE}/library", query={"storyId": "x"})[0] == 400
    assert call("GET", f"{BASE}/library", query={"limit": "101"})[0] == 400


def test_the_library_pages_with_its_own_cursor(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    for n in range(5):
        seed_asset(store, s3_client, assetId=_asset_id(n), key=f"{prefix()}stories/x/final/v{n}.mp4")
    first = call("GET", f"{BASE}/library", query={"limit": "2"})[1]
    assert [i["assetId"] for i in first["items"]] == [_asset_id(4), _asset_id(3)]
    second = call("GET", f"{BASE}/library", query={"limit": "2", "cursor": first["nextCursor"]})[1]
    assert [i["assetId"] for i in second["items"]] == [_asset_id(2), _asset_id(1)]
    last = call("GET", f"{BASE}/library", query={"limit": "2", "cursor": second["nextCursor"]})[1]
    assert [i["assetId"] for i in last["items"]] == [_asset_id(0)]
    assert last["nextCursor"] is None
    # A cursor of another partition is refused.
    forged = db.encode_cursor({"pk": f"USER#{USER}", "sk": "ASSET#x"})
    assert call("GET", f"{BASE}/library", query={"cursor": forged})[0] == 400


def test_a_key_outside_the_workspace_is_never_presigned(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    seed_asset(store, s3_client, assetId=_asset_id(1), key="jobs/01J/clips/01J/clip.mp4")
    seed_asset(store, s3_client, assetId=_asset_id(2), key=f"ws/{OTHER}/stories/stories/x/final/v1.mp4")
    seed_asset(store, s3_client, assetId=_asset_id(3), key=f"{prefix()}../../uploads/x.mp4")
    assert call("GET", f"{BASE}/library")[1]["items"] == []
    assert presigned_keys(s3_client) == []


def test_providers_are_on_only_after_a_real_call(call: Call, store: db.Store) -> None:
    status, body = call("GET", f"{BASE}/providers")
    assert status == 200
    states = {(p["kind"], p["id"]): p for p in body["providers"]}
    assert [(p["kind"], p["id"]) for p in body["providers"]] == [(p.kind, p.id) for p in providers.REGISTRY]
    assert {p["state"] for p in body["providers"]} == {"needs_setup", "off", "unavailable"}  # nothing proven yet
    assert states[("images", "nova-canvas")]["state"] == "off"
    assert states[("animation", "nova-reel")]["state"] == "unavailable"
    assert "us" not in states[("animation", "builtin-2d")]["line"].split()
    seed_item(store, "PROVIDER#animation#builtin-2d", "ws_provider", state="on", checkedAt="2026-11-15T11:00:00.000Z")
    seed_item(store, "PROVIDER#writer#bedrock-claude", "ws_provider", state="on")  # no checkedAt: not proven
    version = call("GET", BASE)[1]["workspace"]["version"]
    call("PATCH", BASE, {"version": version, "configuration": {"providers": {"images": "nova-canvas"}}})
    seed_item(
        store,
        "PROVIDER#images#nova-canvas",
        "ws_provider",
        state="needs_setup",
        checkedAt="2026-11-15T11:30:00.000Z",
        lastError="Bedrock says Nova Canvas is not enabled for this account in Europe (Ireland).",
    )
    states = {(p["kind"], p["id"]): p for p in call("GET", f"{BASE}/providers")[1]["providers"]}
    assert states[("animation", "builtin-2d")]["state"] == "on"
    assert states[("animation", "builtin-2d")]["checkedAt"] == "2026-11-15T11:00:00.000Z"
    assert states[("writer", "bedrock-claude")]["state"] == "needs_setup"
    canvas = states[("images", "nova-canvas")]
    assert canvas["state"] == "needs_setup"
    assert canvas["line"].startswith("Bedrock says Nova Canvas is not enabled")
    # Another owner's record never counts.
    seed_item(
        store,
        "PROVIDER#audio#builtin-synth",
        "ws_provider",
        user=OTHER,
        state="on",
        checkedAt="2026-11-15T11:00:00.000Z",
    )
    store.put(
        {
            "pk": pk(),
            "sk": "PROVIDER#audio#builtin-synth",
            "type": "ws_provider",
            "userId": OTHER,
            "workspaceId": "stories",
            "state": "on",
            "checkedAt": "2026-11-15T11:00:00.000Z",
        }
    )
    states = {(p["kind"], p["id"]): p for p in call("GET", f"{BASE}/providers")[1]["providers"]}
    assert states[("audio", "builtin-synth")]["state"] == "needs_setup"


def test_the_mirror_names_the_agents_providers() -> None:
    assert {p.kind for p in providers.REGISTRY} == set(providers.KINDS)
    assert {(p.kind, p.id) for p in providers.REGISTRY} == {
        ("writer", "bedrock-claude"),
        ("images", "builtin-rig"),
        ("images", "nova-canvas"),
        ("animation", "builtin-2d"),
        ("animation", "nova-reel"),
        ("audio", "builtin-synth"),
    }
    if not AGENT_REGISTRY.is_file():
        pytest.skip("the agent's registry (builder E, CONTRACTS §45.11.6) is not in this checkout yet")
    names = {
        n.value
        for n in ast.walk(ast.parse(AGENT_REGISTRY.read_text()))
        if isinstance(n, ast.Constant) and isinstance(n.value, str)
    }
    missing = [p.id for p in providers.REGISTRY if p.id not in names]
    assert missing == [], f"the agent registry does not name {missing}"


def test_guidance_lists_every_topic_with_its_sources(call: Call) -> None:
    status, body = call("GET", f"{BASE}/guidance")
    assert status == 200
    assert body["checkedAt"] == "2026-11-21"
    topics = {t["id"]: t for t in body["topics"]}
    assert len(topics) == 12
    skid = topics["skid-recovery"]
    assert set(skid) == {"id", "title", "steps", "donts", "caveats", "citations"}
    hidden = next(s for s in skid["steps"] if not s["shown"])
    assert hidden["why"]
    assert all(
        set(c) <= {"publisher", "title", "url", "section"} and c["url"].startswith("https://")
        for c in skid["citations"]
    )
    assert '"quote":' not in json.dumps(body)
    assert '"keywords":' not in json.dumps(body)
    assert call("GET", "/v1/workspaces/clips/guidance")[0] == 409


def test_topic_matching_reads_keywords_and_a_checked_pick() -> None:
    g = guidance.load()
    assert guidance.match(g, ["My tyre blew out on the motorway"]) == "tyre-blowout"
    assert guidance.match(g, ["A deer jumped onto the road"]) == "animal-on-road"
    assert guidance.match(g, ["Pancakes for breakfast"]) is None
    assert guidance.match(g, ["Pancakes for breakfast"], "fog-driving") == "fog-driving"  # a valid pick stands in
    assert guidance.match(g, ["Pancakes for breakfast"], "volcano") is None  # an invented pick never counts


def test_a_broken_guidance_file_fails_to_load(tmp_path: Path) -> None:
    good = json.loads((ROOT / "config" / "stories-guidance.json").read_text())
    for breaking in (
        lambda d: d["topics"][0]["steps"][0]["sources"].append("NOPE"),
        lambda d: d["topics"][0]["steps"][2].pop("why"),
        lambda d: d["sources"][next(iter(d["sources"]))].update(url="http://plain"),
        lambda d: d["topics"].append(d["topics"][0]),
        lambda d: d.pop("checkedAt"),
    ):
        data = json.loads(json.dumps(good))
        breaking(data)
        path = tmp_path / "g.json"
        path.write_text(json.dumps(data))
        with pytest.raises(guidance.GuidanceError):
            guidance.load(path)
