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
FIRST_STORIES_NAME: Final = "Clips Funded"
# The first workspace's earlier default names: "Lamo Stories" until 22 Nov 2026, then "Clip Factory Stories", "Clip
# Stories" and "Funded Clips" until 23 Nov 2026.
# A stored workspace still named one of them is shown with today's name (``shown_workspace_name``); the stored item
# itself is never rewritten.
OLD_STORIES_NAME: Final = "Lamo Stories"
OLD_STORIES_NAMES: Final = (OLD_STORIES_NAME, "Clip Factory Stories", "Clip Stories", "Funded Clips")
MAX_WORKSPACES: Final = 10


def shown_workspace_name(stored: object) -> str:
    """The name a person sees for a stored ``workspaceName``: an old default reads as today's default."""
    name = str(stored or "")
    return FIRST_STORIES_NAME if name in OLD_STORIES_NAMES else name


@dataclass(frozen=True)
class WorkspaceType:
    key: str
    label: str
    builtin: bool  # exactly one, never stored (Lamo Clips)


# The registry (CONTRACTS §45.2). A future brand is a new `stories` workspace (no code) or one new entry here.
WORKSPACE_TYPES: Final[dict[str, WorkspaceType]] = {
    CLIPS: WorkspaceType(CLIPS, "Lamo Clips", builtin=True),
    STORIES: WorkspaceType(STORIES, "Clips Funded", builtin=False),
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
ACT_SK: Final = "ACT#"  # ACT#{at}#{id}: recent activity, ttl 90 days (§45.16.3)
PROVIDER_SK: Final = "PROVIDER#"  # PROVIDER#{kind}#{providerId}: written only by the agent after a real call (§45.11.6)
# The second request (§45.3, §45.24-§45.31).
AGENT_SK: Final = "AGENT#"
SKILL_SK: Final = (
    "SKILL#"  # a Lamo Stories skill, in the workspace partition (Clip Factory's skills are USER#{u}/SKILL#)
)
TASK_SK: Final = "TASK#"
CONV_SK: Final = "CONV#"
MSG_SK: Final = "MSG#"  # MSG#{convId}#{msgId}
MEM_SK: Final = "MEM#"
REFVID_SK: Final = "REFVID#"
MODELSTATUS_SK: Final = "MODELSTATUS#"
USAGE_SK: Final = "USAGE#"  # USAGE#{day}#{id}
PROVCRED_SK: Final = "PROVCRED#"
ONBOARD_SK: Final = "ONBOARD"  # an exact sort key
AICONFIG_SK: Final = "AICONFIG"  # an exact sort key
MODELDEF_SK: Final = "MODELDEF#"  # MODELDEF#{key}: a reasoning model the owner added (§45.34 "Adding models")
CHECKLOCK_SK: Final = "CHECKLOCK#"  # CHECKLOCK#{providerId}: the one "Try it" running (``checkJobId``, §45.35 D2)
# §45.37 G2: a picture, video or sound model the owner added (MAKERDEF#{key}) and its access check (MAKERSTATUS#{key}).
MAKERDEF_SK: Final = "MAKERDEF#"
MAKERSTATUS_SK: Final = "MAKERSTATUS#"
# §45.37 G6: what Lamo Stories used of Clip Factory's shared developer app, per platform and window (its own counters).
SHAREUSE_SK: Final = "SHAREUSE#"
ITEM_PREFIXES: Final = (
    IDEA_SK,
    CHAR_SK,
    STORY_SK,
    PJOB_SK,
    ASSET_SK,
    SOCIAL_SK,
    PUBJOB_SK,
    ACT_SK,
    PROVIDER_SK,
    AGENT_SK,
    SKILL_SK,
    TASK_SK,
    CONV_SK,
    MSG_SK,
    MEM_SK,
    REFVID_SK,
    MODELSTATUS_SK,
    USAGE_SK,
    PROVCRED_SK,
    ONBOARD_SK,
    AICONFIG_SK,
    MODELDEF_SK,
    CHECKLOCK_SK,
    MAKERDEF_SK,
    MAKERSTATUS_SK,
    SHAREUSE_SK,
)

# Item `type` values (never "job", "clip", "post", "account", "setup": Lamo Clips readers filter on those).
TYPE_WORKSPACE: Final = "workspace"
TYPE_IDEA: Final = "ws_idea"
TYPE_CHARACTER: Final = "ws_character"
TYPE_STORY: Final = "ws_story"
TYPE_PJOB: Final = "ws_pjob"
TYPE_ASSET: Final = "ws_asset"
TYPE_SOCIAL: Final = "ws_social"
TYPE_PUBJOB: Final = "ws_pubjob"
TYPE_ACTIVITY: Final = "ws_activity"
TYPE_PROVIDER: Final = "ws_provider"
TYPE_AGENT: Final = "ws_agent"
TYPE_SKILL: Final = "ws_skill"
TYPE_TASK: Final = "ws_task"
TYPE_CONV: Final = "ws_conv"
TYPE_MSG: Final = "ws_msg"
TYPE_MEM: Final = "ws_mem"
TYPE_REFVID: Final = "ws_refvid"
TYPE_MODELSTATUS: Final = "ws_modelstatus"
TYPE_USAGE: Final = "ws_usage"
TYPE_PROVCRED: Final = "ws_provcred"
TYPE_ONBOARD: Final = "ws_onboard"
TYPE_AICONFIG: Final = "ws_aiconfig"
TYPE_MODELDEF: Final = "ws_modeldef"
TYPE_CHECKLOCK: Final = "ws_checklock"
TYPE_MAKERDEF: Final = "ws_makerdef"
TYPE_MAKERSTATUS: Final = "ws_makerstatus"
TYPE_SHAREUSE: Final = "ws_shareuse"


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
SECRET_KINDS: Final = ("app", "token", "pending")  # app: Lamo Stories' own developer app keys (§45.30)
# A provider id (§45.31) or a keyed host id (§45.37 G4: ``anthropic``, ``openai_compatible``, ``elevenlabs``).
PROVIDER_ID: Final = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")
# Lamo Stories' OAuth state items use their own key prefix, so its roles never reach Clip Factory's OAUTH#{nonce}.
WS_OAUTH_PK_PREFIX: Final = "OAUTH#ws."
# Platforms whose shared-app choice is allowed (§45.30): Meta always uses Lamo Stories' own app.
SHARED_APP_PLATFORMS: Final = ("youtube", "tiktok", "x")


def oauth_pk(nonce: str) -> str:
    return f"{WS_OAUTH_PK_PREFIX}{nonce}"


def rate_pk(workspace_id: str, platform: str) -> str:
    """Lamo Stories' own rate counters, used only with its own developer app (§45.30)."""
    if workspace_id == CLIPS or not WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Clips Funded workspace id")
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform: {platform}")
    return f"RATE#WS#{workspace_id}#{platform}"


# §45.37 G6: the one counter of what **all** of Lamo Stories (every owner, every stories workspace) used of Clip
# Factory's shared developer app: the app's quotas are one per app, as Clip Factory's own RATE#{platform} are. Never a
# workspace id ("~" is in no WORKSPACE_ID), never one of Clip Factory's RATE#{platform} keys.
SHARED_APP_KEY: Final = "~shared"


def shared_rate_pk(platform: str) -> str:
    """``RATE#WS#~shared#{platform}``: Lamo Stories' one shared-app counter partition per platform."""
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform: {platform}")
    return f"RATE#WS#{SHARED_APP_KEY}#{platform}"


def provider_secret_name(prefix: str, workspace_id: str, provider_id: str) -> str:
    """``cf-prod/workspaces/{ws}/providers/{providerId}`` (§45.31): an external provider's API key."""
    base = _workspace_base(prefix, workspace_id)
    if not PROVIDER_ID.match(provider_id):
        raise ValueError("not a provider id")
    return f"{base}{workspace_id}/providers/{provider_id}"


def _workspace_base(prefix: str, workspace_id: str) -> str:
    if workspace_id == CLIPS or not WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Clips Funded workspace id")
    base = prefix if prefix.endswith("/") else prefix + "/"
    if "/platforms/" in base:
        raise ValueError("workspace secrets never live under cf-prod/platforms/")
    return base


# The identity field inside each platform's token secret (written by oauth.providers.exchange / chosen, kept by
# refresh): the publishing check compares it with the job's and the account's externalAccountId (§45.14 rule 4).
SECRET_IDENTITY: Final = {
    "youtube": "channelId",
    "tiktok": "openId",
    "instagram": "igUserId",
    "facebook": "pageId",
    "x": "xUserId",
}

# Workspace OAuth states start with this; Lamo Clips' start with "v1." (§45.13.2).
WS_STATE_PREFIX: Final = "w1."


def secret_name(prefix: str, workspace_id: str, platform: str, kind: str) -> str:
    """``cf-prod/workspaces/{workspaceId}/{platform}/{app|token|pending}`` (CONTRACTS §45.13.1, §45.30), built only from
    ids that were already validated against the workspace partition. Refuses Lamo Clips and anything under
    ``platforms/``."""
    if kind not in SECRET_KINDS:
        raise ValueError(f"unknown secret kind: {kind}")
    if platform not in PLATFORMS:
        raise ValueError(f"unknown platform: {platform}")
    base = _workspace_base(prefix, workspace_id)
    return f"{base}{workspace_id}/{platform}/{kind}"
