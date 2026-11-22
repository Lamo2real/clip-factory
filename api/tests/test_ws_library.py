"""The Library, the providers list and the guidance list (docs/CONTRACTS.md §45.11.5, §45.11.6, §45.12)."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import config, guidance, providers
from conftest import OTHER, USER, Call
from fakes import FakeS3
from ws_support import (
    BASE,
    caller,
    install,
    pk,
    prefix,
    presigned_keys,
    seed_asset,
    seed_character,
    seed_item,
    seed_job,
    seed_story,
)


@pytest.fixture
def call(app: App) -> Call:
    """Through Lamo Stories' own route table (its own Lambda), not Clip Factory's."""
    return caller(app)


ROOT = Path(__file__).resolve().parents[2]
AGENT_REGISTRY = ROOT / "stories" / "agent" / "src" / "lamostories_agent" / "providers.py"


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


def test_the_videos_tab_lists_the_webm_and_mov_copies(call: Call, store: db.Store, s3_client: FakeS3) -> None:
    """§45.35 D10: the agent keeps each extra format (``production.extraFormats``) as an ``ASSET#`` of kind
    ``video``; the Library's Videos tab asks for ``final_video`` and ``video``, each with its own link."""
    story = seed_story(store, s3_client)
    sid = story["storyId"]
    mp4 = seed_asset(store, s3_client, kind="final_video", storyId=sid, key=f"{prefix()}stories/{sid}/final/v1.mp4")
    webm = seed_asset(store, s3_client, kind="video", storyId=sid, key=f"{prefix()}stories/{sid}/final/v1.webm",
                      contentType="video/webm", meta={"current": 1, "format": "webm"})  # fmt: skip
    mov = seed_asset(store, s3_client, kind="video", storyId=sid, key=f"{prefix()}stories/{sid}/final/v1.mov",
                     contentType="video/quicktime", meta={"current": 1, "format": "mov"})  # fmt: skip
    status, body = call("GET", f"{BASE}/library", query={"kind": "video"})
    assert status == 200, body
    copies = {i["assetId"]: i for i in body["items"]}
    assert set(copies) == {webm["assetId"], mov["assetId"]}
    assert {i["meta"]["format"] for i in copies.values()} == {"webm", "mov"}
    assert {i["kind"] for i in copies.values()} == {"video"}
    assert all(i["url"].startswith("https://") and i["title"] == story["title"] for i in copies.values())
    finals = call("GET", f"{BASE}/library", query={"kind": "final_video"})[1]["items"]
    assert mp4["assetId"] in {i["assetId"] for i in finals}
    assert not {webm["assetId"], mov["assetId"]} & {i["assetId"] for i in finals}
    everything = {i["assetId"] for i in call("GET", f"{BASE}/library")[1]["items"]}
    assert {mp4["assetId"], webm["assetId"], mov["assetId"]} <= everything


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


def _providers(call: Call) -> dict[tuple[str, str], dict[str, Any]]:
    status, body = call("GET", f"{BASE}/providers")
    assert status == 200
    # the registry in order, then the keyed hosts' own rows (§45.37 G4: the Anthropic API, an OpenAI-compatible API)
    assert [(p["kind"], p["id"]) for p in body["providers"]] == [
        *((p.kind, p.id) for p in providers.REGISTRY),
        ("writer", "anthropic"),
        ("writer", "openai_compatible"),
    ]
    return {(p["kind"], p["id"]): p for p in body["providers"]}


def _pick(call: Call, chosen: dict[str, str]) -> None:
    version = call("GET", BASE)[1]["workspace"]["version"]
    assert call("PATCH", BASE, {"version": version, "configuration": {"providers": chosen}})[0] == 200


def test_built_ins_are_on_ai_providers_only_after_a_real_call(call: Call, store: db.Store) -> None:
    states = _providers(call)
    # Built into Lamo Stories' own image: nothing to set up (§45.11.6's table).
    for key in (("images", "builtin-rig"), ("animation", "builtin-2d"), ("audio", "builtin-synth")):
        assert states[key]["state"] == "on"
        assert "checkedAt" not in states[key]
    # The writer is on only once a model answered; Amazon Nova Canvas and Nova Reel have ended (§45.37 G7), each with
    # its one-tap replacement; Stability AI is off until picked; Luma AI Ray2 is built but needs its United States
    # (Oregon) bucket, picked or not (never "pick it to use it": picking it would not make it work).
    assert states[("writer", "bedrock-claude")]["state"] == "needs_setup"
    assert "Check models" in states[("writer", "bedrock-claude")]["line"]
    for key, replacement in ((("images", "nova-canvas"), "stability"), (("animation", "nova-reel"), "luma-ray")):
        ended = states[key]
        assert (ended["state"], ended["line"], ended["replacement"]) == (
            "ended",
            "Ended by Amazon on 30 Sep 2026.",
            replacement,
        )
        assert ended["models"][0]["endedLine"] == "Ended by Amazon on 30 Sep 2026"
    assert states[("images", "stability")]["state"] == "off"
    assert [m["key"] for m in states[("images", "stability")]["models"]] == [
        "stable-image-core",
        "stable-image-ultra",
        "sd3-5-large",
    ]
    assert all(m["regionLine"] == "Runs in the US (Oregon)" for m in states[("images", "stability")]["models"])
    unpicked_ray = states[("animation", "luma-ray")]
    assert unpicked_ray["state"] == "needs_setup"
    assert unpicked_ray["line"] == providers.LUMA_NOT_READY
    assert "United States (Oregon)" in unpicked_ray["line"]
    assert unpicked_ray["line"] != providers.OFF_LINE
    assert states[("audio", "polly")]["line"] == (
        "Off. Adds words spoken aloud. Your videos are made without a voice unless you pick this."
    )
    assert states[("audio", "polly")]["label"] == "A spoken voice (Amazon Polly)"
    assert all(not row["picked"] for key, row in states.items() if "picked" in row and not key[1].startswith("builtin"))
    seed_item(store, "PROVIDER#writer#bedrock-claude", "ws_provider", state="on")  # no checkedAt: not proven
    seed_item(store, "MODELSTATUS#fable-5-2", "ws_modelstatus", status="denied", checkedAt="2026-11-15T11:10:00.000Z")
    assert _providers(call)[("writer", "bedrock-claude")]["state"] == "needs_setup"
    seed_item(store, "MODELSTATUS#opus-5-5", "ws_modelstatus", status="ok", checkedAt="2026-11-15T11:20:00.000Z")
    writer = _providers(call)[("writer", "bedrock-claude")]
    assert (writer["state"], writer["checkedAt"]) == ("on", "2026-11-15T11:20:00.000Z")
    _pick(call, {"images": "stability", "imageModel": "sd3-5-large", "video": "luma-ray"})
    states = _providers(call)
    stability = states[("images", "stability")]
    assert (stability["state"], stability["picked"], stability["model"]) == ("needs_setup", True, "sd3-5-large")
    ray = states[("animation", "luma-ray")]
    assert (ray["state"], ray["picked"], ray["model"]) == ("needs_setup", True, "luma-ray2")
    assert "United States (Oregon)" in ray["line"]
    assert states[("animation", "builtin-2d")]["state"] == "on"  # not picked any more, still built in and working
    assert states[("animation", "builtin-2d")]["picked"] is False
    seed_item(
        store,
        "PROVIDER#images#stability",
        "ws_provider",
        state="needs_setup",
        checkedAt="2026-11-15T11:30:00.000Z",
        lastError="Bedrock says this Stability AI model is not enabled for this account in US West (Oregon).",
    )
    picture = _providers(call)[("images", "stability")]
    assert picture["state"] == "needs_setup"
    assert picture["line"].startswith("Bedrock says this Stability AI model is not enabled")
    assert picture["lastError"] == picture["line"]
    seed_item(store, "PROVIDER#images#stability", "ws_provider", state="on", checkedAt="2026-11-15T11:40:00.000Z")
    picture = _providers(call)[("images", "stability")]
    assert (picture["state"], picture["checkedAt"]) == ("on", "2026-11-15T11:40:00.000Z")


def test_another_owners_records_never_count(call: Call, store: db.Store) -> None:
    seed_item(
        store, "MODELSTATUS#opus-5-5", "ws_modelstatus", user=OTHER, status="ok", checkedAt="2026-11-15T11:00:00.000Z"
    )
    store.put(
        {
            "pk": pk(),
            "sk": "MODELSTATUS#haiku-5-5",
            "type": "ws_modelstatus",
            "userId": OTHER,
            "workspaceId": "stories",
            "status": "ok",
            "checkedAt": "2026-11-15T11:00:00.000Z",
        }
    )
    _pick(call, {"images": "stability"})
    store.put(
        {
            "pk": pk(),
            "sk": "PROVIDER#images#stability",
            "type": "ws_provider",
            "userId": OTHER,
            "workspaceId": "stories",
            "state": "on",
            "checkedAt": "2026-11-15T11:00:00.000Z",
        }
    )
    states = _providers(call)
    assert states[("writer", "bedrock-claude")]["state"] == "needs_setup"
    assert states[("images", "stability")]["state"] == "needs_setup"


def test_a_finished_job_dates_the_built_ins_and_a_later_failure_shows(
    call: Call, store: db.Store, s3_client: FakeS3
) -> None:
    story = seed_story(store, s3_client)
    steps = [
        {"key": k, "label": k, "status": "done", "finishedAt": "2026-11-15T11:05:00.000Z"}
        for k in ("storyboard", "safety", "scenes", "animation")
    ] + [
        {"key": "sound", "label": "sound", "status": "done", "message": "Nothing changed", "finishedAt": "x"},
        {"key": "captions", "label": "captions", "status": "skipped"},
    ]
    seed_job(store, story, status="ready", steps=steps, meta={"providers": {"animation": "builtin-2d"}})
    states = _providers(call)
    assert states[("animation", "builtin-2d")]["checkedAt"] == "2026-11-15T11:05:00.000Z"
    assert states[("images", "builtin-rig")]["checkedAt"] == "2026-11-15T11:05:00.000Z"
    assert "checkedAt" not in states[("audio", "builtin-synth")]  # its step had nothing to make
    writer = states[("writer", "bedrock-claude")]
    assert (writer["state"], writer["checkedAt"]) == ("on", "2026-11-15T11:05:00.000Z")
    seed_item(
        store,
        "PROVIDER#animation#builtin-2d",
        "ws_provider",
        state="needs_setup",
        checkedAt="2026-11-15T11:50:00.000Z",
        lastError="The animator could not start ffmpeg. Tap Try again.",
    )
    failed = _providers(call)[("animation", "builtin-2d")]
    assert failed["state"] == "needs_setup"
    assert failed["line"] == "The animator could not start ffmpeg. Tap Try again."


def test_the_mirror_names_the_agents_providers() -> None:
    assert {p.kind for p in providers.REGISTRY} == set(providers.KINDS)
    assert {(p.kind, p.id) for p in providers.REGISTRY} == {
        ("writer", "bedrock-claude"),
        ("images", "builtin-rig"),
        ("images", "nova-canvas"),
        ("animation", "builtin-2d"),
        ("animation", "nova-reel"),
        ("audio", "builtin-synth"),
        # §45.37 G7: the makers after Amazon ended Nova Canvas and Nova Reel
        ("images", "stability"),
        ("images", "own-images"),
        ("animation", "luma-ray"),
        ("animation", "own-video"),
        ("audio", "polly"),
        ("audio", "elevenlabs"),
        ("audio", "own-sound"),
    }
    defaults = config.workspace_defaults()["providers"]
    for kind, key in providers.CONFIG_KEY.items():
        assert any(p.kind == kind and p.id == defaults[key] for p in providers.REGISTRY)
    if not AGENT_REGISTRY.is_file():
        pytest.skip("the agent's registry (builder E, CONTRACTS §45.11.6) is not in this checkout yet")
    names = {
        n.value
        for n in ast.walk(ast.parse(AGENT_REGISTRY.read_text()))
        if isinstance(n, ast.Constant) and isinstance(n.value, str)
    }
    missing = [p.id for p in providers.REGISTRY if p.id not in names]
    assert missing == [], f"the agent registry does not name {missing}"


def _agent_states(source: Path | None = None) -> dict[str, str]:
    """Each agent provider class's ``id`` and its ``state`` before any call (``kind, id, label = …`` or ``id, label =
    …``, ``state = …``), a ``state`` a class does not set itself taken from its base classes in the same file."""
    classes: dict[str, tuple[list[str], str | None, str | None]] = {}
    for node in ast.walk(ast.parse((source or AGENT_REGISTRY).read_text())):
        if not isinstance(node, ast.ClassDef):
            continue
        provider_id = state = None
        for stmt in node.body:
            if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
                continue
            target, value = stmt.targets[0], stmt.value
            if isinstance(target, ast.Tuple) and isinstance(value, ast.Tuple):
                names = [t.id for t in target.elts if isinstance(t, ast.Name)]
                if "id" in names and isinstance(value.elts[names.index("id")], ast.Constant):
                    provider_id = value.elts[names.index("id")].value  # type: ignore[attr-defined]
            elif isinstance(target, ast.Name) and target.id == "state" and isinstance(value, ast.Constant):
                state = value.value
        bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
        classes[node.name] = (bases, provider_id, state)

    def state_of(name: str) -> str | None:
        bases, _, state = classes.get(name, ([], None, None))
        if state is not None:
            return state
        return next((found for b in bases if (found := state_of(b)) is not None), None)

    out: dict[str, str] = {}
    for name, (_, provider_id, _) in classes.items():
        found = state_of(name)
        if isinstance(provider_id, str) and isinstance(found, str):
            out[provider_id] = found
    return out


def test_the_ai_providers_start_in_the_agents_state() -> None:
    """Before any call, with the workspace defaults, every AI maker shows the state the agent's registry starts it in
    (§45.37 G7: Nova Canvas and Nova Reel ended; Luma AI Ray2 needs its bucket; the others off until picked). The
    built-ins and the writer follow §45.11.6's table and real proof here."""
    defaults = {"providers": config.workspace_defaults()["providers"]}
    shown = {p.id: providers.status(p, defaults, None)["state"] for p in providers.REGISTRY}
    assert {
        i: shown[i] for i in shown if i not in ("bedrock-claude", "builtin-rig", "builtin-2d", "builtin-synth")
    } == {
        "nova-canvas": "ended",
        "nova-reel": "ended",
        "stability": "off",
        "own-images": "off",
        "luma-ray": "needs_setup",
        "own-video": "off",
        "polly": "off",
        "elevenlabs": "off",
        "own-sound": "off",
    }
    if not AGENT_REGISTRY.is_file():
        pytest.skip("the agent's registry (builder E, CONTRACTS §45.11.6) is not in this checkout yet")
    agent = _agent_states()
    ai = [p.id for p in providers.REGISTRY if not p.builtin and p.kind != "writer"]
    assert {i: shown[i] for i in ai} == {i: agent.get(i) for i in ai}


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
    good = json.loads((ROOT / "stories" / "config" / "guidance.json").read_text())
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
