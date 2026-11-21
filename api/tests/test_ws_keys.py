"""Lamo Stories keys can never reach a Lamo Clips reader (docs/CONTRACTS.md §45.3, ADR-70).

The live-update and notification streams forward items by sort-key prefix; the prefixes are read from the Terraform
that sets them, so a new stream prefix there that collides with a workspace prefix fails here.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from clipfactory_api.workspaces import types as ws

ROOT = Path(__file__).resolve().parents[2]
STREAM_FILES = (ROOT / "infra/modules/realtime/main.tf", ROOT / "infra/modules/notify/main.tf")
USER = "11111111-2222-3333-4444-555555555555"


def stream_prefixes() -> set[str]:
    found: set[str] = set()
    for f in STREAM_FILES:
        found |= set(re.findall(r'prefix = "([^"]+)"', f.read_text()))
    assert "JOB#" in found, "the stream filters were not found"
    assert "CLIP#" in found, "the stream filters were not found"
    return found


def test_no_workspace_prefix_is_forwarded_by_a_stream() -> None:
    prefixes = stream_prefixes()
    for sk in (*ws.ITEM_PREFIXES, ws.WS_SK):
        assert not any(sk.startswith(p) for p in prefixes), sk


def test_workspace_partitions_are_never_lamo_clips_partition() -> None:
    assert ws.registry_pk(USER) == f"USER#{USER}#WSREG"
    assert ws.workspace_pk(USER, "stories") == f"USER#{USER}#WS#stories"
    assert ws.workspace_pk(USER, "stories") != f"USER#{USER}"
    with pytest.raises(ValueError, match="Lamo Clips"):
        ws.workspace_pk(USER, ws.CLIPS)
    with pytest.raises(ValueError, match="Lamo Clips"):
        ws.s3_prefix(USER, ws.CLIPS)


def test_types_never_reuse_lamo_clips_item_types() -> None:
    clips_types = {"job", "jobLive", "clip", "post", "account", "setup", "oauth", "stat", "week", "learning", "skill"}
    ours = {ws.TYPE_WORKSPACE, ws.TYPE_IDEA, ws.TYPE_CHARACTER, ws.TYPE_STORY, ws.TYPE_PJOB, ws.TYPE_ASSET}
    ours |= {ws.TYPE_SOCIAL, ws.TYPE_PUBJOB}
    assert not ours & clips_types


def test_secret_names_stay_in_the_workspace_prefix() -> None:
    name = ws.secret_name(ws.WS_SECRET_PREFIX, "stories", "youtube", "token")
    assert name == "cf-prod/workspaces/stories/youtube/token"
    for bad in (("clips", "youtube", "token"), ("stories", "myspace", "token"), ("stories", "youtube", "app")):
        with pytest.raises(ValueError, match=r"unknown|not a Lamo Stories"):
            ws.secret_name(ws.WS_SECRET_PREFIX, *bad)
    with pytest.raises(ValueError, match="never live under"):
        ws.secret_name("cf-prod/platforms/", "stories", "youtube", "token")
    with pytest.raises(ValueError, match="not a Lamo Stories"):
        ws.secret_name(ws.WS_SECRET_PREFIX, "../platforms", "youtube", "token")


def test_registry_has_the_built_in_workspace_and_stories() -> None:
    assert ws.WORKSPACE_TYPES[ws.CLIPS].builtin
    assert not ws.WORKSPACE_TYPES[ws.STORIES].builtin
    assert ws.WORKSPACE_ID.match("clips")
    assert ws.WORKSPACE_ID.match("stories")
    assert ws.WORKSPACE_ID.match("01JZ0000000000000000000000")
    assert not ws.WORKSPACE_ID.match("USER#x")
    assert ws.social_account_id("stories", "youtube") == "stories.youtube"
