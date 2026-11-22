"""Lamo Stories' agent stays apart from Clip Factory (docs/CONTRACTS.md §45.1, §45.3, §45.4, §45.24, ADR-76):

* nothing in ``lamostories_agent`` imports Clip Factory's agent or API (an AST scan, beside the scaffold's regex one);
* no source string names a Clip Factory S3 prefix, its secrets, its model list or its runtime;
* no sort key it writes starts with a prefix the live-update or notification streams forward (read from Terraform);
* every partition is the workspace's own and every S3 key is under ``ws/``; Lamo Clips' id is refused;
* only ``models.py`` calls Converse, only ``providers.py`` calls the image and video models."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from lamostories_agent import keys
from lamostories_agent.data import JobFence
from ls_fakes import REPO, data

PKG = Path(__file__).resolve().parents[1] / "src" / "lamostories_agent"
CLIP_PREFIXES = ("uploads/", "jobs/", "skills/", "private/", "ask/", "campaigns/")


def sources() -> list[Path]:
    return sorted(PKG.rglob("*.py"))


def test_nothing_imports_clip_factory_code() -> None:
    for path in sources():
        tree = ast.parse(path.read_text("utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith(("clipfactory_agent", "clipfactory_api")), path.name
                assert node.level <= 1, f"{path.name}: reaches outside the package"
            if isinstance(node, ast.Import):
                assert not any(a.name.startswith(("clipfactory_agent", "clipfactory_api")) for a in node.names), path


def test_no_source_names_a_clip_factory_prefix_secret_model_list_or_runtime() -> None:
    for path in sources():
        tree = ast.parse(path.read_text("utf-8"))
        # a literal after a dynamic part of an f-string (``f"{ws_prefix(...)}skills/..."``) is inside ws/, not a prefix
        inner = {
            id(v)
            for j in ast.walk(tree)
            if isinstance(j, ast.JoinedStr)
            for v in j.values[1:]
            if isinstance(v, ast.Constant)
        }
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)) or id(node) in inner:
                continue
            text = node.value
            assert not text.startswith(CLIP_PREFIXES), f"{path.name}: {text!r}"
            for bad in ("cf-prod/platforms", "cf_prod_clip_agent", "clipModel", "SETUP#", "ACCOUNT#"):
                assert bad not in text, f"{path.name}: {text!r}"
            assert not re.search(r"(?<!stories/)config/models\.json", text), f"{path.name}: Clip Factory's model list"


def stream_prefixes() -> set[str]:
    out: set[str] = set()
    for tf in ("infra/modules/realtime/main.tf", "infra/modules/notify/main.tf"):
        out |= set(re.findall(r'prefix\s*=\s*"([^"]+)"', (REPO / tf).read_text("utf-8")))
    return out


def test_no_sort_key_the_agent_writes_reaches_a_lamo_clips_stream() -> None:
    prefixes = stream_prefixes()
    assert {"JOB#", "CLIP#", "ACCOUNT#", "JOBLIVE#"} <= prefixes
    made = [
        keys.story_sk("S"),
        keys.job_sk("J"),
        keys.asset_sk("A"),
        keys.activity_sk("2026-11-21T18:00:00.000Z", "X"),
        keys.provider_sk("images", "nova-canvas"),
        keys.modelstatus_sk("opus-5-5"),
        keys.usage_sk("2026-11-21", "U"),
        keys.refvid_sk("R"),
        keys.agent_sk("storyboard"),
        keys.skill_sk("K"),
        keys.MEM_PREFIX + "M",
        keys.AICONFIG_SK,
        keys.char_sk("C"),
        keys.idea_sk("I"),
        keys.workspace_sk("stories"),
    ]
    for sk in made:
        assert not any(sk.startswith(p) for p in prefixes), sk
    for kind in (keys.TYPE_PJOB, keys.TYPE_ASSET, keys.TYPE_ACTIVITY, keys.TYPE_PROVIDER, keys.TYPE_USAGE,
                 keys.TYPE_MODELSTATUS):  # fmt: skip
        assert kind.startswith("ws_")


def test_partitions_and_files_are_the_workspace_s_own() -> None:
    assert keys.ws_pk("u", "stories") == "USER#u#WS#stories"
    with pytest.raises(ValueError):
        keys.ws_pk("u", "clips")
    with pytest.raises(ValueError):
        keys.ws_pk("u", "../x")
    for key in (
        keys.script_key("u", "stories", "S", 1),
        keys.scene_clip_key("u", "stories", "S", "s1", 2),
        keys.scene_still_key("u", "stories", "S", "s1", 2),
        keys.audio_key("u", "stories", "S", 1),
        keys.captions_key("u", "stories", "S", 1),
        keys.final_key("u", "stories", "S", 1),
        keys.cover_key("u", "stories", "S", 1),
        keys.portrait_key("u", "stories", "C", "A"),
        keys.reference_prefix("u", "stories", "R"),
        keys.reel_prefix("u", "stories", "S", "s1", 1),
    ):
        assert key.startswith("ws/u/stories/"), key
    with pytest.raises(ValueError):
        keys.scene_clip_key("u", "stories", "S", "../s1", 1)
    with pytest.raises(ValueError):
        keys.story_prefix("u", "clips", "S")


async def test_the_data_layer_refuses_anything_outside_the_workspace() -> None:
    d, store = data()
    fence = JobFence("u", "stories", "J", "S")
    with pytest.raises(ValueError):
        await d.put_bytes(fence, "jobs/J/clips/x.mp4", b"x", "video/mp4")
    with pytest.raises(ValueError):
        await d.put_bytes(fence, "ws/other-user/stories/x.json", b"x", "application/json")
    with pytest.raises(ValueError):
        await d.delete_files(fence, ["skills/u/k1/SKILL.md"])
    with pytest.raises(ValueError):
        await d.write(fence, puts=[{"pk": "USER#u", "sk": "SETUP#x"}])
    assert store.objects == {} and store.deleted == []


def calls(name: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for path in sources():
        n = sum(
            1
            for node in ast.walk(ast.parse(path.read_text("utf-8")))
            if isinstance(node, ast.Attribute) and node.attr == name
        )
        if n:
            out[path.name] = n
    return out


def test_only_the_model_client_talks_to_the_reasoning_models_and_only_providers_to_the_media_models() -> None:
    assert set(calls("converse")) == {"models.py"} and set(calls("converse_stream")) == {"models.py"}
    assert set(calls("invoke_model")) == {"providers.py"}
    assert set(calls("start_async_invoke")) == {"providers.py"} and set(calls("get_async_invoke")) == {"providers.py"}
