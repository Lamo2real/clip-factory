"""Lamo Stories' own social connections (docs/CONTRACTS.md §45.13, §45.30, ADR-72, ADR-79).

* The **developer app** per platform is the owner's explicit choice (``workspaces.apps``): Lamo Stories' own
  (always for Facebook and Instagram) or, for YouTube, TikTok and X, Clip Factory's. The choice, the masked hints of
  own keys and the last Check it live on ``SOCIAL#{platform}`` as ``app``; own keys only in
  ``cf-prod/workspaces/{ws}/{platform}/app``. Connect refuses with a plain sentence until a choice is made and its
  keys are there. The client id used is stored on the account (``appClientId``): when the chosen app's keys change,
  the account shows ``needs_reconnect`` ("The {Platform} app keys changed. Connect again.").
* The **workspace state** ``w1.{workspaceId}.{nonce}.{exp}.{sig}`` with ``sig = b64url(HMAC_SHA256(stateKey, "w1|" +
  platform + "|" + workspaceId + "|" + nonce + "|" + exp))``: the same key and 10 minutes as Clip Factory's ``v1.``
  states (§17.4), PKCE from the nonce as today. ``oauth.state.verify`` rejects it. Its item is
  ``OAUTH#ws.{nonce}``/``STATE`` (Lamo Stories' own key prefix) with the user, workspace, account, the app choice and
  the redirect URI of that choice (Clip Factory's app: its registered hooks URI, whose callback forwards ``w1.``
  states to Lamo Stories' own; Lamo Stories' own app: ``{STORIES_OAUTH_CALLBACK}/{platform}/callback``).
* ``SOCIAL#{platform}`` in the workspace partition holds only the public identity, the status, the scopes, the app
  choice and ``lastCheckedAt`` (set when a connect finishes and by Check); the token is
  ``cf-prod/workspaces/{workspaceId}/{platform}/token`` (``workspaces.secrets``).
* "Same place as Lamo Clips" compares the identity with ``ACCOUNT#{platform}.accountId``. TikTok gives each developer
  app its own ``open_id``, so with Lamo Stories' own TikTok app that comparison can never match: while Lamo Clips has
  a TikTok, the account says so (``clips_unknown``) and its first post waits for the owner's yes (§45.13.4).
* One own Meta app serves Instagram and Facebook: its keys are saved, changed and deleted for both at once.
* Nothing here writes ``ACCOUNT#``, ``SETUP#`` or a ``cf-prod/platforms/*`` secret, reads a Clip Factory token,
  releases Clip Factory posts or calls a platform's revoke endpoint (§45.13.6). Of Clip Factory's ``ACCOUNT#`` items
  only five attributes are ever read (``pk, sk, platform, status, accountId``: the "same place" comparison, §45.15).
"""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final
from urllib.parse import parse_qsl, quote, urlencode

from .. import db, validate
from ..clock import iso, parse
from ..errors import ApiError, bad_request, conflict
from ..log import log
from ..oauth import META, PKCE, STATE_SECONDS, OAuthEnv, formats, providers, setup, state
from ..oauth.providers import AppKeys, Linked
from ..platforms import errors as platform_errors
from ..platforms.base import NotConnectedError, ReconnectNeededError, RetryablePublishError, obj
from . import apps
from . import types as ws
from .apps import CLIPS, OWN, AppNotReady, CallbackOff, ChosenApp
from .secrets import WorkspaceSecrets
from .sentences import label

Item = dict[str, Any]

STATE_VERSION: Final = "w1"
STATE_TYPE: Final = "ws_oauth"  # never Clip Factory's "oauth"
_NONCE = re.compile(r"^[A-Za-z0-9_-]{22}$")
_SIG = re.compile(r"^[A-Za-z0-9_-]{43}$")
_EXP = re.compile(r"^[0-9]{9,11}$")
CHOICES_TTL: Final = timedelta(minutes=30)
YOUTUBE_PROMPT: Final = "select_account consent"
STATUSES: Final = ("not_connected", "connected", "choose_account", "needs_reconnect", "same_as_clips")
POSTABLE: Final = ("connected", "same_as_clips")
NOT_ON: Final = "Posting setup is not switched on for this app yet."
TIKTOK_NOT_CONNECTED: Final = "Lamo Stories' TikTok is not connected. Connect it in Lamo Stories › Connections."
LIST_TOO_OLD: Final = "That list is too old. Tap Connect again."
X_CREDITS: Final = "X has no credits left. Buy more in console.x.com › Billing › Credits."
# TikTok gives every developer app its own open_id for the same person (§45.13.4, ``clips_unknown``).
TIKTOK_UNSURE: Final = (
    "Lamo Stories cannot tell if this is Lamo Clips' TikTok, because TikTok gives each app its own id. Before the "
    "first post, Lamo Stories shows you the account to check."
)
# The only attributes of Clip Factory's ACCOUNT# items Lamo Stories may read (§45.15: an attribute-limited GetItem).
CLIPS_ACCOUNT_ATTRIBUTES: Final = ("pk", "sk", "platform", "status", "accountId")


def keys_changed_sentence(platform: str) -> str:
    """The account's ``warning`` while it is ``needs_reconnect`` because the chosen app's keys changed."""
    return f"The {label(platform)} app keys changed. Connect again."


def clips_unknown(platform: str, account: Mapping[str, Any], choice: str | None, clips: str) -> bool:
    """True while Lamo Stories cannot tell if this account is Lamo Clips' own (§45.13.4). TikTok gives every
    developer app its own ``open_id`` for the same person, so with Lamo Stories' own TikTok app the ids never match,
    even for Lamo Clips' own account. While Lamo Clips has a TikTok (``clips``, its ``accountId``), the owner says
    once, on the publish sheet, that this is the Lamo Stories account (``confirmAccount``, stored as
    ``notClipsConfirmed`` with the identity it was said for; every connect clears it). YouTube channel ids, Page ids,
    Instagram ids and X user ids are the same in every app: those are always compared."""
    identity = str(account.get("externalAccountId") or "")
    if platform != "tiktok" or choice != OWN or not clips or not identity or clips == identity:
        return False
    if account.get("sharedWithClips") is True and account.get("sharedExternalAccountId") == identity:
        return False
    return account.get("notClipsConfirmed") != identity


# --- §45.13.5: each platform's rules for a second account, in plain words, per app choice -----------------------

_YOUTUBE = (
    "One Google sign-in can hold several channels (Brand Accounts).",
    "A connection posts to exactly one channel: the one you pick in Google's list.",
    "To change it, tap Pick another channel. Google will ask which channel. Pick your Lamo Stories channel.",
)
_TIKTOK = (
    "Sign in to your Lamo Stories account on tiktok.com in this browser first. TikTok connects the account "
    "that is signed in.",
)
_X = (
    "Use a separate X account. First sign in to your Lamo Stories account on x.com in this browser. X connects "
    "the account that is signed in.",
)
_META = (
    "Lamo Stories uses its own Meta app, so Lamo Clips' Facebook connection is never touched.",
    "Facebook will ask which Pages this app may use. Tick only your Lamo Stories Page.",
    "A new Meta app in Development mode lets you, its admin, connect your own Pages. Going Live needs Meta's "
    "App Review.",
)
_LIMITS: Final[dict[str, dict[str | None, tuple[str, ...]]]] = {
    "youtube": {
        CLIPS: (
            *_YOUTUBE,
            "Both channels share Clip Factory's Google project: about 6 uploads a day in all, counted together.",
        ),
        OWN: (*_YOUTUBE, "Your own Google project has its own daily units: about 6 uploads a day."),
        None: (*_YOUTUBE, "First pick which app Lamo Stories uses: your own, or Clip Factory's (quicker)."),
    },
    "tiktok": {
        CLIPS: (
            "While TikTok is still reviewing Clip Factory's app, only accounts added as Sandbox target users can connect.",
            "Until TikTok approves the app, the account must be private and posts stay Only me.",
            "When the app goes live with new keys, Lamo Stories asks you to connect again.",
            *_TIKTOK,
        ),
        OWN: (
            "A new TikTok app needs TikTok's review, which can take days to weeks. Until then only Sandbox target "
            "users can connect, the account must be private and posts stay Only me.",
            *_TIKTOK,
            "TikTok gives each app its own id, so Lamo Stories cannot tell if it is Lamo Clips' TikTok. Before the "
            "first post, check the account Lamo Stories shows you.",
        ),
        None: (*_TIKTOK, "First pick which app Lamo Stories uses: your own, or Clip Factory's (quicker)."),
    },
    "instagram": {
        OWN: (
            "Use a separate professional (Business or Creator) Instagram account, linked to a Facebook Page.",
            *_META,
        ),
        None: (
            "Use a separate professional (Business or Creator) Instagram account, linked to a Facebook Page.",
            *_META,
        ),
    },
    "facebook": {
        OWN: ("Use a separate Facebook Page managed by the same Facebook login.", *_META),
        None: ("Use a separate Facebook Page managed by the same Facebook login.", *_META),
    },
    "x": {
        CLIPS: (*_X, "Posts use Clip Factory's X app credits and your one monthly X limit, shared with Lamo Clips."),
        OWN: (*_X, "Your own X app needs its own credits. Lamo Stories' own monthly X limit applies."),
        None: (*_X, "First pick which app Lamo Stories uses: your own, or Clip Factory's (quicker)."),
    },
}


def limits(platform: str, choice: str | None) -> list[str]:
    found = _LIMITS[platform]
    return list(found.get(choice) or found[None])


# --- the workspace state (§45.13.2) -------------------------------------------------------------------------------


def _mac(key: bytes, message: str) -> str:
    return state.b64url(hmac.new(key, message.encode(), hashlib.sha256).digest())


def sign_state(key: bytes, platform: str, workspace_id: str, nonce: str, exp: int) -> str:
    if not key:
        raise ValueError("the state key is empty")
    if workspace_id == ws.CLIPS or not ws.WORKSPACE_ID.match(workspace_id):
        raise ValueError("not a Lamo Stories workspace id")
    signature = _mac(key, f"{STATE_VERSION}|{platform}|{workspace_id}|{nonce}|{exp}")
    return f"{STATE_VERSION}.{workspace_id}.{nonce}.{exp}.{signature}"


def check_signature(key: bytes, platform: str, value: str) -> tuple[str, str, int]:
    """``(workspaceId, nonce, exp)`` of a well-formed ``w1.`` state whose signature matches (constant time);
    ``state.StateError`` otherwise. The expiry is checked by ``verify_state``."""
    if not key or not isinstance(value, str) or len(value) > state.MAX_STATE_CHARS:
        raise state.StateError("bad state")
    parts = value.split(".")
    if len(parts) != 5 or parts[0] != STATE_VERSION:
        raise state.StateError("bad state")
    _, workspace_id, nonce, exp_text, signature = parts
    if (
        workspace_id == ws.CLIPS
        or not ws.WORKSPACE_ID.match(workspace_id)
        or not (_NONCE.match(nonce) and _EXP.match(exp_text) and _SIG.match(signature))
    ):
        raise state.StateError("bad state")
    expected = _mac(key, f"{STATE_VERSION}|{platform}|{workspace_id}|{nonce}|{exp_text}")
    if not hmac.compare_digest(expected.encode(), signature.encode()):
        raise state.StateError("bad signature")
    return workspace_id, nonce, int(exp_text)


def verify_state(key: bytes, platform: str, value: str, now: int) -> tuple[str, str]:
    workspace_id, nonce, exp = check_signature(key, platform, value)
    if exp <= now:
        raise state.StateError("expired")
    return workspace_id, nonce


# --- items ----------------------------------------------------------------------------------------------------------


def social_sk(platform: str) -> str:
    return f"{ws.SOCIAL_SK}{platform}"


def account_item(store: db.Store, user_id: str, workspace_id: str, platform: str) -> Item | None:
    """The workspace's ``SOCIAL#{platform}``, or None (also when its ``userId``/``workspaceId`` disagree)."""
    return apps.social_item(store, user_id, workspace_id, platform)


def clips_account(store: db.Store, user_id: str, platform: str) -> Item | None:
    """Clip Factory's ``ACCOUNT#{platform}``: read only, and only its five comparable attributes (an
    attribute-limited GetItem, the one read of a Clip Factory item that Lamo Stories' roles allow, §45.15)."""
    names = {f"#a{i}": name for i, name in enumerate(CLIPS_ACCOUNT_ATTRIBUTES)}
    table: Any = store._table
    out = table.get_item(
        Key={"pk": db.user_pk(user_id), "sk": setup.account_sk(platform)},
        ConsistentRead=True,
        ProjectionExpression=", ".join(names),
        ExpressionAttributeNames=names,
    )
    item = out.get("Item") if isinstance(out, Mapping) else None
    if not item:
        return None
    found: Item = db.from_dynamo(item)
    return {k: v for k, v in found.items() if k in CLIPS_ACCOUNT_ATTRIBUTES}


def clips_identity(store: db.Store, user_id: str, platform: str) -> str:
    """Clip Factory's destination on this platform (its ``accountId``), or "" when it has none."""
    found = clips_account(store, user_id, platform) or {}
    return str(found.get("accountId") or "") if found.get("status") != "not_connected" else ""


def put_account(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    platform: str,
    *,
    status: str,
    now: datetime,
    fields: Mapping[str, Any] | None = None,
    previous: Mapping[str, Any] | None = None,
) -> Item:
    """Replaces the workspace's ``SOCIAL#{platform}`` with a whole new connection state (connect, choose,
    disconnect). The app choice (``app``) is the owner's setting, not part of a connection: it is always kept."""
    if status not in STATUSES:
        raise ValueError(f"unknown status: {status}")
    kept = (previous or {}).get("app")
    item: Item = {
        "pk": ws.workspace_pk(user_id, workspace_id),
        "sk": social_sk(platform),
        "type": ws.TYPE_SOCIAL,
        "userId": user_id,
        "workspaceId": workspace_id,
        "socialAccountId": ws.social_account_id(workspace_id, platform),
        "platform": platform,
        "connectionStatus": status,
        "sharedWithClips": False,
        "createdAt": str((previous or {}).get("createdAt") or iso(now)),
        "updatedAt": iso(now),
        **({"app": dict(kept)} if isinstance(kept, Mapping) and kept else {}),
        **{k: v for k, v in (fields or {}).items() if v not in (None, "")},
    }
    store.put(item)
    return item


def mark_account(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    platform: str,
    now: datetime,
    *,
    remove: Iterable[str] = (),
    expect_in: Mapping[str, Iterable[Any]] | None = None,
    **fields: Any,
) -> Item | None:
    """Sets fields on an existing ``SOCIAL#{platform}``; a missing one stays missing (None)."""
    try:
        return store.update(
            ws.workspace_pk(user_id, workspace_id),
            social_sk(platform),
            {**fields, "updatedAt": iso(now)},
            remove=list(remove),
            expect_in=expect_in,
        )
    except db.ConditionFailed:
        return None


def upsert_account(
    store: db.Store, user_id: str, workspace_id: str, platform: str, *, now: datetime, fields: Mapping[str, Any]
) -> Item:
    """Sets ``fields`` on ``SOCIAL#{platform}``, making it (``not_connected``) when the platform never connected.
    Conditional on the item being this owner's and this workspace's."""
    names = {
        "#t": "type",
        "#u": "userId",
        "#w": "workspaceId",
        "#a": "socialAccountId",
        "#p": "platform",
        "#s": "connectionStatus",
        "#sh": "sharedWithClips",
        "#c": "createdAt",
        "#up": "updatedAt",
    }
    values: Item = {
        ":t": ws.TYPE_SOCIAL,
        ":u": user_id,
        ":w": workspace_id,
        ":a": ws.social_account_id(workspace_id, platform),
        ":p": platform,
        ":s": "not_connected",
        ":f": False,
        ":now": iso(now),
    }
    sets = [
        "#t = :t",
        "#u = :u",
        "#w = :w",
        "#a = :a",
        "#p = :p",
        "#s = if_not_exists(#s, :s)",
        "#sh = if_not_exists(#sh, :f)",
        "#c = if_not_exists(#c, :now)",
        "#up = :now",
    ]
    for i, (name, value) in enumerate(fields.items()):
        names[f"#f{i}"] = name
        values[f":f{i}"] = value
        sets.append(f"#f{i} = :f{i}")
    return store.update_expr(
        ws.workspace_pk(user_id, workspace_id),
        social_sk(platform),
        "SET " + ", ".join(sets),
        condition="attribute_not_exists(pk) OR (#u = :u AND #w = :w)",
        names=names,
        values=values,
    )


def record_result(
    store: db.Store, user_id: str, workspace_id: str, platform: str, *, now: datetime, result: str
) -> None:
    """``lastResult`` on ``SOCIAL#{platform}`` (made as ``not_connected`` when the platform never connected)."""
    upsert_account(store, user_id, workspace_id, platform, now=now, fields={"lastResult": result})


@dataclass(frozen=True)
class Scope:
    """One owner's one Lamo Stories workspace: every key and secret name below is built from these checked ids."""

    store: db.Store
    secrets: WorkspaceSecrets
    user_id: str
    workspace_id: str

    def account(self, platform: str) -> Item | None:
        return account_item(self.store, self.user_id, self.workspace_id, platform)

    def chosen(self, platform: str, account: Mapping[str, Any] | apps._Unread | None = apps.UNREAD) -> ChosenApp:
        """The chosen developer app and its keys; ``AppNotReady`` when none is chosen or its keys are missing."""
        return apps.require_app(self.store, self.secrets, self.user_id, self.workspace_id, platform, account=account)

    def put(self, platform: str, status: str, now: datetime, fields: Mapping[str, Any] | None = None) -> Item:
        return put_account(
            self.store,
            self.user_id,
            self.workspace_id,
            platform,
            status=status,
            now=now,
            fields=fields,
            previous=self.account(platform),
        )

    def mark(
        self,
        platform: str,
        now: datetime,
        *,
        remove: Iterable[str] = (),
        expect_in: Mapping[str, Iterable[Any]] | None = None,
        **fields: Any,
    ) -> Item | None:
        return mark_account(
            self.store, self.user_id, self.workspace_id, platform, now, remove=remove, expect_in=expect_in, **fields
        )


# --- public shapes ---------------------------------------------------------------------------------------------


class Keep:
    """No app-key check (the caller did not read the keys)."""


KEEP: Final = Keep()


def public_app(platform: str, item: Mapping[str, Any] | None) -> Item:
    """``SocialAccount.app``: the choice, whether own keys are saved, their masked hints and the last Check it."""
    raw = (item or {}).get("app")
    app = raw if isinstance(raw, Mapping) else {}
    out: Item = {"choice": apps.choice_of(platform, item), "saved": bool(app.get("savedAt"))}
    hints = app.get("hints")
    if isinstance(hints, Mapping) and hints and out["saved"]:
        out["hints"] = {str(k): str(v) for k, v in hints.items()}
    check = app.get("check")
    if isinstance(check, Mapping) and check:
        out["check"] = {
            "at": str(check.get("at") or ""),
            "ok": bool(check.get("ok")),
            "code": str(check.get("code") or ""),
            "message": str(check.get("message") or ""),
        }
        if check.get("account") in ("ok", "dead", "none"):
            out["check"]["account"] = check["account"]
    return out


def public_account(
    item: Mapping[str, Any] | None,
    workspace_id: str,
    platform: str,
    *,
    app_client_id: str | Keep | None = KEEP,
    now: datetime | None = None,
    clips: str | None = None,
) -> Item:
    """``SocialAccount`` (§45.6). Never the token, the lease, ``appClientId`` or ``sharedExternalAccountId``.
    ``app_client_id`` is the chosen app's current client id (None: no app is set up any more): an account connected
    with other keys is ``needs_reconnect``, its ``warning`` "The {Platform} app keys changed. Connect again.".
    ``clips`` is Lamo Clips' identity on this platform when the caller read it: a TikTok that Lamo Stories cannot
    tell apart from it (``clips_unknown``) has ``reason`` ``clips_unknown`` and the ``TIKTOK_UNSURE`` warning."""
    item = item or {}
    status = str(item.get("connectionStatus") or "not_connected")
    if status not in STATUSES:
        status = "not_connected"
    reason = item.get("reason") if isinstance(item.get("reason"), str) else None
    if (
        status in (*POSTABLE, "needs_reconnect")
        and not isinstance(app_client_id, Keep)
        and item.get("appClientId") != app_client_id
    ):
        status, reason = "needs_reconnect", "keys_changed"
    choices = None
    if status == "choose_account":
        expires = parse(item.get("choicesExpireAt"))
        raw = item.get("choices")
        if isinstance(raw, list) and raw and (now is None or (expires is not None and expires > now)):
            choices = [
                {
                    "id": str(c.get("id")),
                    "name": str(c.get("name") or c.get("id")),
                    **({"avatarUrl": c["avatarUrl"]} if isinstance(c.get("avatarUrl"), str) else {}),
                    "usedByClips": bool(c.get("usedByClips")),
                }
                for c in raw
                if isinstance(c, Mapping) and c.get("id")
            ]
        else:
            status, reason = "not_connected", "expired"
    identity = status not in ("not_connected", "choose_account")
    app = public_app(platform, item)
    warning = _text(item.get("warning"))
    if status == "needs_reconnect" and reason == "keys_changed":
        warning = warning or keys_changed_sentence(platform)
    elif status == "connected" and clips is not None and clips_unknown(platform, item, app["choice"], clips):
        reason, warning = reason or "clips_unknown", warning or TIKTOK_UNSURE
    return {
        "socialAccountId": ws.social_account_id(workspace_id, platform),
        "workspaceId": workspace_id,
        "platform": platform,
        "app": app,
        "lastCheckedAt": _text(item.get("lastCheckedAt")) if identity else None,
        "connectionStatus": status,
        "externalAccountId": _text(item.get("externalAccountId")) if identity else None,
        "accountName": _text(item.get("accountName")) if identity else None,
        "handle": _text(item.get("handle")) if identity else None,
        "avatarUrl": _text(item.get("avatarUrl")) if identity else None,
        "sharedWithClips": bool(item.get("sharedWithClips")) and status == "connected",
        "connectedAt": _text(item.get("connectedAt")) if identity else None,
        "missing": [str(m) for m in item.get("missing") or [] if m],
        "reason": reason,
        "reconnectBy": _text(item.get("reconnectBy")) if identity else None,
        "choices": choices,
        "limits": limits(platform, app["choice"]),
        "warning": warning,
    }


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def clips_destinations(store: db.Store, user_id: str) -> list[Item]:
    """Clip Factory's destination per platform: whether it has one, never ids or tokens (``ClipsDestination``).
    ``name`` stays null: the one read of ``ACCOUNT#`` Lamo Stories may make has no name in it (§45.15)."""
    out: list[Item] = []
    for platform in ws.PLATFORMS:
        found = clips_account(store, user_id, platform) or {}
        out.append({"platform": platform, "connected": found.get("status") == "connected", "name": None})
    return out


def list_accounts(scope: Scope, now: datetime) -> Item:
    return {
        "accounts": [public_of(scope, platform, now) for platform in ws.PLATFORMS],
        "clips": clips_destinations(scope.store, scope.user_id),
    }


def public_of(scope: Scope, platform: str, now: datetime) -> Item:
    """The public account, checked against the chosen app's current keys (a key change → ``needs_reconnect``). A
    status worked out here is also stored (``settle``), so every reader of ``SOCIAL#`` (the dashboard too) sees
    what the Connections page shows."""
    item = scope.account(platform)
    client_id: str | Keep | None = KEEP
    if item is not None and item.get("connectionStatus") in (*POSTABLE, "needs_reconnect"):
        chosen = apps.app_keys(scope.store, scope.secrets, scope.user_id, scope.workspace_id, platform, account=item)
        client_id = chosen.client_id if chosen is not None else None
    clips = None
    if item is not None and platform == "tiktok" and item.get("connectionStatus") == "connected":
        clips = clips_identity(scope.store, scope.user_id, platform)
    shown = public_account(item, scope.workspace_id, platform, app_client_id=client_id, now=now, clips=clips)
    if item is not None:
        settle(scope.store, scope.user_id, scope.workspace_id, platform, item, shown=shown, now=now)
    return shown


def settle(
    store: db.Store,
    user_id: str,
    workspace_id: str,
    platform: str,
    item: Mapping[str, Any],
    *,
    shown: Mapping[str, Any],
    now: datetime,
) -> None:
    """Stores the two statuses a read works out on its own: the chosen app's keys changed → ``needs_reconnect``
    (``keys_changed``), and a list of Pages older than 30 minutes → ``not_connected`` (``expired``, the choices
    removed). Conditional on the very item read (status and ``updatedAt``), so a connect that landed meanwhile is
    never undone; best effort (the response is right either way)."""
    stored = item.get("connectionStatus")
    status, reason = shown.get("connectionStatus"), shown.get("reason")
    updated_at = item.get("updatedAt")
    if (status, reason) == (stored, item.get("reason")) or not isinstance(updated_at, str):
        return
    remove: list[str] = []
    if (status, reason) == ("needs_reconnect", "keys_changed"):
        pass
    elif (status, reason) == ("not_connected", "expired") and stored == "choose_account":
        remove = ["choices", "choicesExpireAt"]
    else:
        return
    try:
        mark_account(
            store,
            user_id,
            workspace_id,
            platform,
            now,
            remove=remove,
            expect_in={"connectionStatus": [stored], "updatedAt": [updated_at]},
            connectionStatus=status,
            reason=reason,
        )
    except Exception as e:
        log("warning", "ws_social.settle_failed", platform=platform, error=type(e).__name__)
        return
    log("info", "ws_social.settled", platform=platform, status=status, reason=reason)


def note_keys_changed(
    store: db.Store, user_id: str, workspace_id: str, platform: str, item: Mapping[str, Any], *, now: datetime
) -> None:
    """``validate_destination`` found the account's ``appClientId`` is not the chosen app's client id any more:
    stored as ``needs_reconnect`` (``keys_changed``), conditional on the item read; best effort."""
    shown = {"connectionStatus": "needs_reconnect", "reason": "keys_changed"}
    if item.get("connectionStatus") in POSTABLE:
        settle(store, user_id, workspace_id, platform, item, shown=shown, now=now)


# --- Connect (§45.13.2); Reconnect is the same call (the account id stays) ---------------------------------------


def authorize_url(
    env: OAuthEnv, platform: str, keys: AppKeys, signed: str, challenge: str | None, *, rerequest: bool = False
) -> str:
    """``providers.authorize_url`` (the chosen app's keys, scopes and redirect URI: ``env`` is the choice's
    environment, ``apps.oauth_env_for``) with, for YouTube, ``prompt=select_account consent`` so Google always shows
    its account and channel picker (Brand Accounts included)."""
    url = providers.authorize_url(env, platform, keys, signed, challenge, rerequest=rerequest)
    if platform != "youtube":
        return url
    base, _, query = url.partition("?")
    params = [(k, YOUTUBE_PROMPT if k == "prompt" else v) for k, v in parse_qsl(query, keep_blank_values=True)]
    return f"{base}?{urlencode(params, quote_via=quote)}"


def drop_pending(scope: Scope, platform: str, now: datetime) -> None:
    """Deletes the workspace's Meta ``pending`` secret (every Page token of the last list) and its choices."""
    scope.secrets.delete(scope.workspace_id, platform, "pending")
    item = scope.account(platform)
    if item is None:
        return
    if item.get("connectionStatus") == "choose_account":
        scope.mark(platform, now, remove=["choices", "choicesExpireAt"], connectionStatus="not_connected")
    elif "choices" in item or "choicesExpireAt" in item:
        scope.mark(platform, now, remove=["choices", "choicesExpireAt"])


def connect(scope: Scope, env: OAuthEnv, platform: str, now: datetime, *, base: str | None = None) -> Item:
    """The authorize URL of the chosen app. Refuses (409, a plain sentence) while no app is chosen or its keys are
    missing; never falls back to the other app."""
    current = scope.account(platform)
    try:
        chosen = scope.chosen(platform, current)
        choice_env = apps.oauth_env_for(env, chosen.choice, base)
    except AppNotReady as e:
        raise conflict(e.sentence) from e
    except CallbackOff as e:
        raise ApiError(503, "unavailable", NOT_ON) from e
    if platform in META:
        drop_pending(scope, platform, now)  # never leave an old list of Page tokens behind
    store, user_id, workspace_id = scope.store, scope.user_id, scope.workspace_id
    exp = int(now.timestamp()) + STATE_SECONDS
    key = env.state_key()
    nonce = state.new_nonce()
    signed = sign_state(key, platform, workspace_id, nonce, exp)
    store.put(
        {
            "pk": ws.oauth_pk(nonce),
            "sk": setup.OAUTH_SK,
            "type": STATE_TYPE,
            "userId": user_id,
            "workspaceId": workspace_id,
            "socialAccountId": ws.social_account_id(workspace_id, platform),
            "platform": platform,
            "appChoice": chosen.choice,
            "appClientId": chosen.client_id,
            "redirectUri": choice_env.redirect_uri(platform),
            "createdAt": iso(now),
            "ttl": exp + 300,
        },
        if_absent=True,
    )
    challenge = state.pkce(key, nonce)[1] if PKCE.get(platform) else None
    rerequest = platform == "facebook" and (current or {}).get("lastResult") == "missing_permissions"
    url = authorize_url(choice_env, platform, chosen.keys, signed, challenge, rerequest=rerequest)
    log("info", "ws_social.connect_started", platform=platform, workspaceId=workspace_id, app=chosen.choice)
    return {"authorizeUrl": url, "expiresAt": iso(now + timedelta(seconds=STATE_SECONDS))}


# --- saving a connection (the callback and choose) -----------------------------------------------------------


class SaveRefused(Exception):
    """The answer cannot be saved (an identity that does not match its own token): nothing was written."""


def save_choose(scope: Scope, platform: str, linked: Linked, *, app_client_id: str, now: datetime) -> Item:
    """Meta listed several Pages: the workspace ``pending`` secret first, then ``choose_account`` with the
    choices, each marked ``usedByClips`` when it is Clip Factory's own destination.

    The old token secret is left as it is (as Clip Factory's own ``save`` does): nothing can post with it meanwhile
    (a ``choose_account`` account fails rule 3 of ``validate_destination``), the owner's choice overwrites it
    (``save_connected``) and Disconnect deletes it."""
    clips = clips_identity(scope.store, scope.user_id, platform)
    choices = [
        {
            "id": str(c.get("id")),
            "name": str(c.get("name") or c.get("id")),
            **({"avatarUrl": c["avatarUrl"]} if isinstance(c.get("avatarUrl"), str) else {}),
            "usedByClips": bool(clips) and str(c.get("id")) == clips,
        }
        for c in linked.choices
        if c.get("id")
    ]
    scope.secrets.write(scope.workspace_id, platform, "pending", linked.pending or {})
    return scope.put(
        platform,
        "choose_account",
        now,
        {
            "choices": choices,
            "choicesExpireAt": iso(now + CHOICES_TTL),
            "appClientId": app_client_id,
            "scopes": list(linked.account.get("scopes") or []) or None,
        },
    )


def save_connected(scope: Scope, platform: str, linked: Linked, *, app_client_id: str, now: datetime) -> Item:
    """The workspace token secret first, then ``SOCIAL#{platform}``: ``connected``, or ``same_as_clips`` when the
    identity is Clip Factory's own. Clears ``sharedWithClips`` and ``sharedExternalAccountId`` (every connect and
    choose does, §45.13.4) and sets ``lastCheckedAt``."""
    identity = str(linked.account.get("accountId") or "")
    inside = str(linked.token.get(ws.SECRET_IDENTITY[platform]) or "")
    if not identity or identity != inside:
        raise SaveRefused("the identity does not match its token")
    scope.secrets.write(scope.workspace_id, platform, "token", linked.token)
    scope.secrets.delete(scope.workspace_id, platform, "pending")
    same = identity == clips_identity(scope.store, scope.user_id, platform)
    fields: Item = {
        "externalAccountId": identity,
        "accountName": linked.account.get("name") or linked.account.get("handle"),
        "handle": linked.account.get("handle"),
        "avatarUrl": linked.account.get("avatarUrl") if isinstance(linked.account.get("avatarUrl"), str) else None,
        "appClientId": app_client_id,
        "connectedAt": iso(now),
        "lastCheckedAt": iso(now),
        "scopes": list(linked.account.get("scopes") or []) or None,
        "reconnectBy": linked.account.get("reconnectBy"),
        "reason": linked.account.get("reason"),
    }
    return scope.put(platform, "same_as_clips" if same else "connected", now, fields)


# --- choose, share, check, disconnect, creator info ------------------------------------------------------


def choose(scope: Scope, env: OAuthEnv, platform: str, choice_id: str, now: datetime) -> Item:
    if platform not in META:
        raise bad_request(f"{label(platform)} has nothing to pick.")
    item = scope.account(platform)
    gone = conflict(LIST_TOO_OLD)
    if item is None or item.get("connectionStatus") != "choose_account":
        raise gone
    expires = item.get("choicesExpireAt")
    if not isinstance(expires, str) or expires <= iso(now):
        drop_pending(scope, platform, now)  # the list is too old: its tokens must not stay behind
        raise gone
    if not any(isinstance(c, Mapping) and c.get("id") == choice_id for c in item.get("choices") or []):
        raise gone
    pending = scope.secrets.read(scope.workspace_id, platform, "pending")
    if pending is None:
        raise gone
    try:
        linked = providers.chosen(platform, pending, choice_id, list(env.scopes.get(platform, ())))
        saved = save_connected(scope, platform, linked, app_client_id=str(item.get("appClientId") or ""), now=now)
    except (providers.Fail, SaveRefused) as e:
        raise gone from e
    log("info", "ws_social.chosen", platform=platform, status=saved["connectionStatus"])
    return saved


def share(scope: Scope, platform: str, now: datetime) -> Item:
    """The owner's explicit "Use it for both" (§45.13.4): ``connected`` with ``sharedWithClips`` and the identity
    it was shared for. Only from ``same_as_clips``."""
    item = scope.account(platform)
    if item is not None and item.get("connectionStatus") == "connected" and item.get("sharedWithClips"):
        return item
    if item is None or item.get("connectionStatus") != "same_as_clips":
        raise conflict(f"There is nothing to share. Connect Lamo Stories' {label(platform)} first.")
    identity = str(item.get("externalAccountId") or "")
    if not identity:
        raise conflict(f"There is nothing to share. Connect Lamo Stories' {label(platform)} first.")
    shared = identity == clips_identity(scope.store, scope.user_id, platform)
    fields: Item = {"connectionStatus": "connected", "sharedWithClips": shared}
    if shared:
        fields["sharedExternalAccountId"] = identity
    updated = scope.mark(
        platform,
        now,
        remove=[] if shared else ["sharedExternalAccountId"],
        expect_in={"connectionStatus": ["same_as_clips"], "externalAccountId": [identity]},
        **fields,
    )
    if updated is None:
        raise conflict(f"Lamo Stories' {label(platform)} changed. Look at it again.")
    log("info", "ws_social.shared", platform=platform, shared=shared)
    return updated


def disconnect(scope: Scope, platform: str, now: datetime) -> None:
    """Deletes only this workspace's token and pending secrets and sets the account ``not_connected`` (its app
    choice stays). Never a platform revoke call (§45.13.6): Google's and TikTok's revoke end the app's whole grant
    for that account, which can be Clip Factory's too."""
    scope.secrets.delete(scope.workspace_id, platform, "token")
    scope.secrets.delete(scope.workspace_id, platform, "pending")
    if scope.account(platform) is not None:
        scope.put(platform, "not_connected", now)
    log("info", "ws_social.disconnected", platform=platform)


def _down(platform: str) -> ApiError:
    return ApiError(503, "platform_down", f"{label(platform)} did not answer. Try again in a few minutes.")


def check(scope: Scope, env: OAuthEnv, platform: str, now: datetime) -> Item:
    """A live profile call with the workspace token and the chosen app: ``token_dead`` → ``needs_reconnect``; a
    working token brings a ``needs_reconnect`` account back. Sets ``lastCheckedAt`` whenever the platform answered."""
    from .tokens import WorkspaceTokenProvider

    store, secrets, user_id, workspace_id = scope.store, scope.secrets, scope.user_id, scope.workspace_id
    item = scope.account(platform)
    if item is None or item.get("connectionStatus") not in (*POSTABLE, "needs_reconnect"):
        raise conflict(f"Connect Lamo Stories' {label(platform)} first.")
    chosen = apps.app_keys(store, secrets, user_id, workspace_id, platform, account=item)
    if chosen is None or chosen.client_id != item.get("appClientId"):
        marked = scope.mark(platform, now, connectionStatus="needs_reconnect", reason="keys_changed")
        return marked or dict(item)
    tokens = WorkspaceTokenProvider(store, env, secrets, user_id, workspace_id)
    try:
        creds = tokens.credentials(platform)
    except ReconnectNeededError:
        return scope.mark(platform, now, lastCheckedAt=iso(now)) or dict(item)
    except NotConnectedError:
        tokens.mark_dead(platform)
        return scope.mark(platform, now, lastCheckedAt=iso(now)) or dict(item)
    except RetryablePublishError as e:
        raise _down(platform) from e
    if str(creds.data.get(ws.SECRET_IDENTITY[platform]) or "") != str(item.get("externalAccountId") or ""):
        tokens.mark_dead(platform)
        return scope.mark(platform, now, lastCheckedAt=iso(now)) or dict(item)
    verdict = providers.check_profile(env, platform, chosen.keys, creds.data, creds.access_token)
    if verdict == "platform_down":
        raise _down(platform)
    if verdict == "dead":
        tokens.mark_dead(platform)
        return scope.mark(platform, now, lastCheckedAt=iso(now)) or dict(item)
    fields: Item = {"lastCheckedAt": iso(now)}
    remove: list[str] = []
    if item.get("connectionStatus") == "needs_reconnect":
        clips = clips_identity(store, user_id, platform)
        identity = str(item.get("externalAccountId") or "")
        shared = bool(item.get("sharedWithClips")) and item.get("sharedExternalAccountId") == identity
        fields["connectionStatus"] = "same_as_clips" if identity == clips and not shared else "connected"
        remove.append("reason")
    if verdict == "credits_empty":
        fields["warning"] = X_CREDITS
    elif item.get("warning"):
        remove.append("warning")
    return scope.mark(platform, now, remove=remove, **fields) or dict(item)


def creator_info(scope: Scope, env: OAuthEnv) -> Item:
    """TikTok's creator info with the workspace token and the chosen app only (the §17.4 shape). Writes no
    ``SETUP#`` gate."""
    from .tokens import WorkspaceTokenProvider

    item = scope.account("tiktok")
    if item is None or item.get("connectionStatus") != "connected":
        raise conflict(TIKTOK_NOT_CONNECTED)
    chosen = apps.app_keys(scope.store, scope.secrets, scope.user_id, scope.workspace_id, "tiktok", account=item)
    if chosen is None or chosen.client_id != item.get("appClientId"):
        raise conflict(TIKTOK_NOT_CONNECTED)
    tokens = WorkspaceTokenProvider(scope.store, env, scope.secrets, scope.user_id, scope.workspace_id)
    try:
        creds = tokens.credentials("tiktok")
        if str(creds.data.get("openId") or "") != str(item.get("externalAccountId") or ""):
            raise NotConnectedError(TIKTOK_NOT_CONNECTED)
        status, body = providers.creator_info(env, creds.access_token)
    except ReconnectNeededError as e:
        raise conflict(str(e)) from e
    except NotConnectedError as e:
        raise conflict(TIKTOK_NOT_CONNECTED) from e
    except (RetryablePublishError, providers.Fail) as e:
        log("warning", "ws_social.creator_info_failed", error=type(e).__name__)
        raise ApiError(503, "platform_down", "TikTok did not answer. Try again in a minute.") from e
    error = obj(body.get("error"))
    if status != 200 or str(error.get("code") or "ok") != "ok":
        problem = platform_errors.classify("tiktok", status, body)
        if problem.kind == "reconnect":
            raise conflict(str(tokens.mark_dead("tiktok")))
        if problem.retryable:
            raise ApiError(503, "platform_down", "TikTok did not answer. Try again in a minute.")
        from .sentences import story_sentence

        raise conflict(story_sentence("tiktok", problem.kind, item.get("accountName")))
    data = obj(body.get("data"))
    return {
        "nickname": str(data.get("creator_nickname") or ""),
        "username": str(data.get("creator_username") or ""),
        "avatarUrl": str(data["creator_avatar_url"]) if data.get("creator_avatar_url") else None,
        "privacyOptions": [str(o) for o in data.get("privacy_level_options") or []],
        "commentDisabled": bool(data.get("comment_disabled")),
        "duetDisabled": bool(data.get("duet_disabled")),
        "stitchDisabled": bool(data.get("stitch_disabled")),
        "maxDurationSec": int(data.get("max_video_post_duration_sec") or 0),
    }


# --- the developer app (§45.30) -------------------------------------------------------------------------------

META_ONLY_OWN: Final = "Facebook and Instagram always use Lamo Stories' own Meta app. Paste its keys."
KEY_ASK: Final = {
    "clientId": "Paste the first key.",
    "clientSecret": "Paste the secret.",
    "configId": "Paste the Configuration ID.",
}


def _app_of(item: Mapping[str, Any] | None) -> Item:
    raw = (item or {}).get("app")
    return dict(raw) if isinstance(raw, Mapping) else {}


def _store_app(scope: Scope, platform: str, app: Mapping[str, Any], now: datetime) -> Item:
    return upsert_account(scope.store, scope.user_id, scope.workspace_id, platform, now=now, fields={"app": dict(app)})


def _connected_or_listed(item: Mapping[str, Any] | None) -> bool:
    return item is not None and item.get("connectionStatus") not in (None, "not_connected")


def app_platforms(platform: str) -> tuple[str, ...]:
    """The platforms one developer app serves: one own Meta app is Instagram's and Facebook's (§45.30), so its keys
    are saved, changed and deleted for both at once; every other platform has its own."""
    return tuple(p for p in ws.PLATFORMS if p in META) if platform in META else (platform,)


def set_app(scope: Scope, platform: str, body: Mapping[str, Any], now: datetime) -> Item:
    """``PUT …/social/{platform}/app``: ``{choice: "clips"}`` (YouTube, TikTok, X only) or ``{choice: "own",
    clientId, clientSecret, configId?}`` (the same formats as §17.4, stored only in
    ``cf-prod/workspaces/{ws}/{platform}/app``, shown as masked hints). A change of app disconnects the account first
    (never a revoke). One own Meta app serves Instagram and Facebook (entered once): its keys are always saved for
    both, and each one whose app changed (another client id) is disconnected."""
    validate.only_keys(body, {"choice", *formats.KEY_NAMES})
    choice = body.get("choice")
    if choice not in (OWN, CLIPS):
        raise bad_request("Pick your own app or Clip Factory's app.", "choice")
    if choice == CLIPS and platform not in ws.SHARED_APP_PLATFORMS:
        raise bad_request(META_ONLY_OWN, "choice")
    item = scope.account(platform)
    before = apps.choice_of(platform, item)
    if choice == CLIPS:
        if any(name in body for name in formats.KEY_NAMES):
            raise bad_request("Clip Factory's app needs no keys here.", "choice")
        if before != CLIPS and _connected_or_listed(item):
            disconnect(scope, platform, now)
        app = {**_app_of(scope.account(platform)), "choice": CLIPS}
        _store_app(scope, platform, app, now)
        log("info", "ws_social.app_chosen", platform=platform, app=CLIPS)
        return public_of(scope, platform, now)
    needed = formats.needs(platform)
    if "configId" in body and "configId" not in needed:
        raise bad_request(f"{label(platform)} does not use a Configuration ID.", "configId")
    for name in needed:
        if body.get(name) in (None, ""):
            raise bad_request(KEY_ASK[name], name)
    cleaned = {name: formats.check(platform, name, body[name]) for name in needed}
    for each in app_platforms(platform):
        found = item if each == platform else scope.account(each)
        _save_own(scope, each, cleaned, now, item=found, before=apps.choice_of(each, found))
    log("info", "ws_social.app_chosen", platform=platform, app=OWN)
    return public_of(scope, platform, now)


def _save_own(
    scope: Scope,
    platform: str,
    cleaned: Mapping[str, str],
    now: datetime,
    *,
    item: Mapping[str, Any] | None,
    before: str | None,
) -> None:
    old = scope.secrets.own_app_keys(scope.workspace_id, platform)
    other_app = before != OWN or old is None or old.client_id != cleaned["clientId"]
    if other_app and _connected_or_listed(item):
        disconnect(scope, platform, now)  # the old token was issued to the old app: never posted to again
    scope.secrets.write(scope.workspace_id, platform, "app", {**cleaned, "savedAt": iso(now)})
    app = {
        "choice": OWN,
        "savedAt": iso(now),
        "hints": {name: formats.hint(name, value) for name, value in cleaned.items()},
    }
    _store_app(scope, platform, app, now)


def delete_app(scope: Scope, platform: str, now: datetime) -> None:
    """``DELETE …/social/{platform}/app``: Lamo Stories' own app keys only (Clip Factory's are never touched). When
    they were the chosen app, the account is disconnected first and no app is chosen any more. The own Meta app is
    one app: deleting it on Instagram or Facebook deletes it for both (``app_platforms``)."""
    for each in app_platforms(platform):
        item = scope.account(each)
        before = apps.choice_of(each, item)
        if before == OWN:
            disconnect(scope, each, now)
        scope.secrets.delete(scope.workspace_id, each, "app")
        if item is not None:
            app = {"choice": CLIPS} if before == CLIPS else {}
            if app:
                _store_app(scope, each, app, now)
            else:
                scope.mark(each, now, remove=["app"])
        log("info", "ws_social.app_deleted", platform=each)


def check_app(scope: Scope, env: OAuthEnv, platform: str, now: datetime, *, base: str | None = None) -> Item:
    """``POST …/social/{platform}/app/check``: Check it (§17.4's checks) on Lamo Stories' own app keys, with its own
    redirect URI: the keys first, then, when the account is connected with this app, its token (``check``: the same
    live profile call as Check now, which also sets ``lastCheckedAt``), as ``KeyCheck.account`` (``ok`` | ``dead`` |
    ``none``). The result is kept on ``SOCIAL#.app.check``."""
    keys = scope.secrets.own_app_keys(scope.workspace_id, platform)
    if keys is None:
        raise conflict(apps.not_ready_sentence(platform, "own_missing"))
    try:
        own_env = apps.oauth_env_for(env, OWN, base)
    except CallbackOff as e:
        raise ApiError(503, "unavailable", NOT_ON) from e
    code, message = providers.check_keys(own_env, platform, keys)
    result: Item = {"at": iso(now), "ok": code == "ok", "code": code, "message": message, "account": "none"}
    item = scope.account(platform)
    connected = item is not None and item.get("connectionStatus") in (*POSTABLE, "needs_reconnect")
    if code == "ok" and connected and item is not None and apps.choice_of(platform, item) == OWN:
        result.update(_check_own_account(scope, env, platform, client_id=keys.client_id, item=item, now=now))
    elif code == "ok":
        result.update({"code": "not_connected", "message": providers.check_message("not_connected", platform)})
    _store_app(scope, platform, {**_app_of(scope.account(platform)), "check": result}, now)
    log("info", "ws_social.app_checked", platform=platform, code=result["code"], account=result["account"])
    return result


def _check_own_account(
    scope: Scope, env: OAuthEnv, platform: str, *, client_id: str, item: Mapping[str, Any], now: datetime
) -> Item:
    """§17.4's account part of Check it, for the account connected with Lamo Stories' own app."""
    dead: Item = {"ok": False, "code": "token_dead", "account": "dead"}
    if item.get("appClientId") != client_id:  # connected with other keys: they can never post again
        scope.mark(platform, now, connectionStatus="needs_reconnect", reason="keys_changed")
        return {**dead, "message": keys_changed_sentence(platform)}
    try:
        checked = check(scope, env, platform, now)
    except ApiError as e:
        if e.code != "platform_down":
            raise
        return {"ok": False, "code": "platform_down", "message": providers.check_message("platform_down", platform)}
    if checked.get("connectionStatus") == "needs_reconnect":
        return {**dead, "message": providers.check_message("token_dead", platform)}
    if checked.get("warning") == X_CREDITS:
        return {
            "ok": False,
            "code": "credits_empty",
            "message": providers.check_message("credits_empty", platform),
            "account": "ok",
        }
    return {"account": "ok", "message": f"Everything works. Lamo Stories can post to {label(platform)}."}


def secrets_or_503(found: WorkspaceSecrets | None) -> WorkspaceSecrets:
    if found is None:
        raise ApiError(503, "unavailable", NOT_ON)
    return found
