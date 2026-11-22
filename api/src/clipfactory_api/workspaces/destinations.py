"""``validate_destination``: the one check before every Lamo Stories publishing operation (docs/CONTRACTS.md §45.14,
ADR-73).

Run by the API at the tap (publish, retry) and by the story flow **inside the body of every step that calls a
platform** (publish, check, finish, numbers). All five rules hold, or nothing is sent:

1. the workspace exists for this user and is a ``stories`` workspace;
2. the story is in the same workspace partition, its ``storyId`` is the job's ``contentId``, it is ``approved`` or
   ``published``, and it has a final video (under its own ``ws/`` prefix) and ``actualDurationSec``;
3. the social account is in the same workspace partition, its ``socialAccountId`` is ``{workspaceId}.{platform}``
   (and the job's), its platform is the job's, its status ``connected``, its ``appClientId`` equals the client id of
   the developer app the owner chose (``workspaces.apps.app_keys``, §45.30: Lamo Stories' own, or Clip Factory's on
   purpose; none chosen is "not set up"), and its ``externalAccountId`` equals the one the job recorded;
4. the credentials are read from ``cf-prod/workspaces/{workspaceId}/{platform}/token`` only (built from the checked
   ids by ``workspaces.types.secret_name``), and the identity **inside the secret** equals the job's and the
   account's ``externalAccountId``; a missing secret or field is "not connected";
5. that identity is not Lamo Clips' own destination (``ACCOUNT#{platform}.accountId``, read only), unless
   ``sharedWithClips`` is true and ``sharedExternalAccountId`` equals it. With Lamo Stories' own TikTok app the
   two can never be compared (TikTok gives each app its own ``open_id``, ``social.clips_unknown``): while Lamo Clips
   has a TikTok, the owner must have said once that this account is Lamo Stories' (``confirmAccount`` at the tap,
   then ``notClipsConfirmed`` on ``SOCIAL#tiktok``), or nothing is sent.

There is no default account: no target, no post. A failure raises ``DestinationProblem`` with its kind and a plain
Lamo Stories sentence; the caller stops that job (``needs_attention``) and sends nothing.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso, utcnow
from . import apps, guard, social
from . import types as ws
from .secrets import WorkspaceSecrets
from .sentences import story_sentence

Item = dict[str, Any]
POSTABLE_STORY = ("approved", "published")


class DestinationProblem(Exception):
    """A rule of §45.14 failed: nothing may be sent. ``kind`` is a ``workspaces.sentences`` kind."""

    def __init__(self, rule: int, kind: str, sentence: str, account: Item | None = None) -> None:
        super().__init__(sentence)
        self.rule = rule
        self.kind = kind
        self.sentence = sentence
        self.account = account  # ``clips_unknown``: the account to show the owner (public identity only)


@dataclass(frozen=True)
class Destination:
    workspace: Item
    story: Item
    account: Item
    platform: str
    social_account_id: str
    external_account_id: str
    token: Item
    app_client_id: str
    app: apps.ChosenApp  # the developer app: its keys, and whose limits apply (shared only with Clip Factory's)
    # at the tap: the owner just said this TikTok is Lamo Stories' own (``clips_unknown``); the caller stores it
    confirms_not_clips: bool = False

    @property
    def account_name(self) -> str | None:
        name = self.account.get("accountName")
        return str(name) if name else None


def story_sk(story_id: str) -> str:
    return f"{ws.STORY_SK}{story_id}"


def final_prefix(user_id: str, workspace_id: str, story_id: str) -> str:
    return f"{ws.s3_prefix(user_id, workspace_id)}stories/{story_id}/final/"


def _fail(rule: int, kind: str, platform: str, name: str | None = None) -> DestinationProblem:
    return DestinationProblem(rule, kind, story_sentence(platform, kind, name))


def validate_destination(
    store: db.Store,
    secrets: WorkspaceSecrets,
    user_id: str,
    workspace_id: str,
    job_or_target: Mapping[str, Any],
    *,
    at_tap: bool = False,
    now: datetime | None = None,
    confirm: str | None = None,
) -> Destination:
    """The checked destination of one publishing job (or, ``at_tap``, of one target the owner just picked: it has
    no recorded identity yet, so the account's current one becomes the job's). ``DestinationProblem`` otherwise.
    ``confirm`` (at the tap only) is the ``externalAccountId`` the owner saw and tapped on the publish sheet.

    It sends nothing and reads only; the one write is the status it finds out on its own: an account connected with
    app keys the chosen app no longer has is stored as ``needs_reconnect`` (``social.note_keys_changed``,
    conditional), so the dashboard's Needs you list shows it too."""
    platform = str(job_or_target.get("platform") or "")
    if platform not in ws.PLATFORMS:
        raise _fail(3, "not_connected", platform)
    # 1. the workspace
    workspace = guard.find_workspace(store, user_id, workspace_id)
    if workspace is None or workspace.get("workspaceType") != ws.STORIES or workspace_id == ws.CLIPS:
        raise _fail(1, "workspace", platform)
    pk = ws.workspace_pk(user_id, workspace_id)
    # 2. the story
    story_id = str(job_or_target.get("contentId") or "")
    story = store.get(pk, story_sk(story_id)) if story_id else None
    duration = (story or {}).get("actualDurationSec")
    video = str((story or {}).get("videoKey") or "")
    if (
        story is None
        or not guard.owned(story, user_id, workspace_id)
        or story.get("storyId") != story_id
        or story.get("status") not in POSTABLE_STORY
        or not video.startswith(final_prefix(user_id, workspace_id, story_id))
        or not video.endswith(".mp4")
        or isinstance(duration, bool)
        or not isinstance(duration, int | float)
        or duration <= 0
    ):
        raise _fail(2, "story", platform)
    # 3. the social account
    expected_id = ws.social_account_id(workspace_id, platform)
    account = store.get(pk, social.social_sk(platform))
    name = str(account.get("accountName")) if account and account.get("accountName") else None
    if (
        account is None
        or not guard.owned(account, user_id, workspace_id)
        or account.get("socialAccountId") != expected_id
        or job_or_target.get("socialAccountId") != expected_id
        or account.get("platform") != platform
    ):
        raise _fail(3, "not_connected", platform, name)
    status = account.get("connectionStatus")
    if status == "same_as_clips":
        raise _fail(3, "same_as_clips", platform, name)
    if status != "connected":
        kind = "reconnect" if status == "needs_reconnect" else "not_connected"
        raise _fail(3, kind, platform, name)
    chosen = apps.app_keys(store, secrets, user_id, workspace_id, platform, account=account)
    app_client_id = str(account.get("appClientId") or "")
    if chosen is None or not app_client_id or chosen.client_id != app_client_id:
        social.note_keys_changed(store, user_id, workspace_id, platform, account, now=now or utcnow())
        raise _fail(3, "keys_changed", platform, name)
    identity = str(account.get("externalAccountId") or "")
    recorded = job_or_target.get("externalAccountId")
    if not identity:
        raise _fail(3, "not_connected", platform, name)
    if not at_tap and (not isinstance(recorded, str) or not recorded):
        raise _fail(3, "changed", platform, name)  # a job always records where it goes; nothing to fall back on
    if not at_tap and recorded != identity:
        raise _fail(3, "changed", platform, name)
    # 4. the credentials and the identity inside them
    token = secrets.read(workspace_id, platform, "token")
    inside = str((token or {}).get(ws.SECRET_IDENTITY[platform]) or "")
    if token is None or not inside:
        raise _fail(4, "not_connected", platform, name)
    if inside != identity:
        raise _fail(4, "changed", platform, name)
    # 5. never Lamo Clips' own place, unless the owner said "Use it for both" for exactly this identity
    unsure = _rule_5(store, user_id, account, chosen, identity, confirm=confirm if at_tap else None)
    return Destination(
        workspace=workspace,
        story=story,
        account=account,
        platform=platform,
        social_account_id=expected_id,
        external_account_id=identity,
        token=token,
        app_client_id=app_client_id,
        app=chosen,
        confirms_not_clips=unsure,
    )


def _rule_5(
    store: db.Store,
    user_id: str,
    account: Mapping[str, Any],
    chosen: apps.ChosenApp,
    identity: str,
    *,
    confirm: str | None,
) -> bool:
    """Rule 5; True when it passed only because the owner just confirmed a TikTok Lamo Stories cannot compare."""
    platform = chosen.platform
    name = str(account.get("accountName")) if account.get("accountName") else None
    clips = social.clips_identity(store, user_id, platform)
    if clips and clips == identity:
        shared = account.get("sharedWithClips") is True and account.get("sharedExternalAccountId") == identity
        if not shared:
            raise _fail(5, "same_as_clips", platform, name)
    if not social.clips_unknown(platform, account, chosen.choice, clips):
        return False
    if confirm != identity:
        shown = {"externalAccountId": identity, "accountName": name, "handle": _handle(account)}
        raise DestinationProblem(5, "clips_unknown", story_sentence(platform, "clips_unknown", name), shown)
    return True


def _handle(account: Mapping[str, Any]) -> str | None:
    found = account.get("handle")
    return str(found) if isinstance(found, str) and found else None


def confirm_not_clips_update(destination: Destination, now: datetime) -> dict[str, Any]:
    """The conditional UpdateItem (for the publish or retry transaction) that stores the owner's "this TikTok is
    Lamo Stories' own" for exactly the identity they saw: only while the account still is that connected one."""
    account = destination.account
    return db.update_request(
        str(account["pk"]),
        str(account["sk"]),
        {"notClipsConfirmed": destination.external_account_id, "updatedAt": iso(now)},
        expect_in={"connectionStatus": ["connected"], "externalAccountId": [destination.external_account_id]},
    )
