"""The workspace registry, keys and names shared by every Lamo Stories module (docs/CONTRACTS.md §45.2-§45.4, §45.13).

Pure: no AWS clients, no I/O. Builders A (core) and B (social and publishing) both import from here; neither changes
a key format without changing CONTRACTS §45 first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

CLIPS: Final = "clips"  # the built-in workspace id and type: today's app, never written as an item
STORIES: Final = "stories"  # the workspace type of Lamo Stories; also the id of the first Lamo Stories workspace
FIRST_STORIES_ID: Final = "stories"
FIRST_STORIES_NAME: Final = "Lamo Stories"
MAX_WORKSPACES: Final = 10


@dataclass(frozen=True)
class WorkspaceType:
    key: str
    label: str
    builtin: bool  # exactly one, never stored (Lamo Clips)


# The registry (CONTRACTS §45.2). A future brand is a new `stories` workspace (no code) or one new entry here.
WORKSPACE_TYPES: Final[dict[str, WorkspaceType]] = {
    CLIPS: WorkspaceType(CLIPS, "Lamo Clips", builtin=True),
    STORIES: WorkspaceType(STORIES, "Lamo Stories", builtin=False),
}

WORKSPACE_ID: Final = re.compile(r"^(clips|stories|[0-9A-HJKMNP-TV-Z]{26})$")
PLATFORMS: Final = ("youtube", "tiktok", "instagram", "facebook", "x")

# Sort-key prefixes inside a workspace partition (CONTRACTS §45.3). None may start with a prefix that the live-update
# or notification streams forward (STREAM_PREFIXES); tests/test_ws_keys.py reads those from Terraform and checks.
WS_SK: Final = "WS#"
IDEA_SK: Final = "IDEA#"
CHAR_SK: Final = "CHAR#"
STORY_SK: Final = "STORY#"
PJOB_SK: Final = "PJOB#"
ASSET_SK: Final = "ASSET#"
SOCIAL_SK: Final = "SOCIAL#"
PUBJOB_SK: Final = "PUBJOB#"
ITEM_PREFIXES: Final = (IDEA_SK, CHAR_SK, STORY_SK, PJOB_SK, ASSET_SK, SOCIAL_SK, PUBJOB_SK)

# Item `type` values (never "job", "clip", "post", "account", "setup": Lamo Clips readers filter on those).
TYPE_WORKSPACE: Final = "workspace"
TYPE_IDEA: Final = "ws_idea"
TYPE_CHARACTER: Final = "ws_character"
TYPE_STORY: Final = "ws_story"
TYPE_PJOB: Final = "ws_pjob"
TYPE_ASSET: Final = "ws_asset"
TYPE_SOCIAL: Final = "ws_social"
TYPE_PUBJOB: Final = "ws_pubjob"


def registry_pk(user_id: str) -> str:
    return f"USER#{user_id}#WSREG"


def workspace_sk(workspace_id: str) -> str:
    return f"{WS_SK}{workspace_id}"


def workspace_pk(user_id: str, workspace_id: str) -> str:
    """The partition of one (non-built-in) workspace's data. Never ``USER#{userId}`` itself: that is Lamo Clips'."""
    if workspace_id == CLIPS:
        raise ValueError("Lamo Clips has no workspace partition: its data is USER#{userId} as it always was")
    return f"USER#{user_id}#WS#{workspace_id}"


def s3_prefix(user_id: str, workspace_id: str) -> str:
    """``ws/{userId}/{workspaceId}/`` (CONTRACTS §45.4). Lamo Clips' prefixes are never under ``ws/``."""
    if workspace_id == CLIPS:
        raise ValueError("Lamo Clips files are not under ws/")
    return f"ws/{user_id}/{workspace_id}/"


def social_account_id(workspace_id: str, platform: str) -> str:
    """One social account per platform per workspace; the id is stable so a reconnect keeps it (§45.3)."""
    return f"{workspace_id}.{platform}"


WS_SECRET_PREFIX: Final = "cf-prod/workspaces/"  # noqa: S105 (a name prefix, not a secret); never under platforms/
SECRET_KINDS: Final = ("token", "pending")


def secret_name(prefix: str, workspace_id: str, platform: str, kind: str) -> str:
    """``cf-prod/workspaces/{workspaceId}/{platform}/{token|pending}`` (CONTRACTS §45.13.1), built only from ids that
    were already validated against the workspace partition. Refuses Lamo Clips and anything under ``platforms/``."""
    if kind not in SECRET_KINDS:
        raise ValueError(f"unknown secret kind: {kind}")
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform: {platform}")
    if workspace_id == CLIPS or not WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Lamo Stories workspace id")
    base = prefix if prefix.endswith("/") else prefix + "/"
    if "/platforms/" in base:
        raise ValueError("workspace secrets never live under cf-prod/platforms/")
    return f"{base}{workspace_id}/{platform}/{kind}"
