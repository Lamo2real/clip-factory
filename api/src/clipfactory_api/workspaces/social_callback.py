"""Lamo Stories' own OAuth callback (docs/CONTRACTS.md §45.13.3, ADR-72, ADR-79).

Public ``GET /v1/stories-oauth/{platform}/callback`` on ``cf-prod-stories-api`` (``workspaces/routes/social.py``).
Lamo Stories' own developer apps register this URI; Clip Factory's apps keep their hooks URI, and Clip Factory's
callback only forwards a ``w1.`` state here with the query unchanged (``hooks.py``). The owner always lands on
``{APP_URL}/stories/connections?platform={p}&result={code}`` (``landing``; ``&ws={id}`` only after the signature
checked out), a code from ``WS_RESULTS``: nothing else from the request is reflected. Wrapped whole in try/except →
``error``.

1. the state's signature (``social.check_signature``, constant time) and expiry before anything else, then the
   single-use ``OAUTH#ws.{nonce}`` item, which must carry this platform, a user and exactly this workspace and
   social account;
2. the keys ``apps.app_keys`` picks, which must be the app chosen at Connect (``appChoice``, ``appClientId``); the
   code is exchanged with ``providers.exchange`` (the same code as Clip Factory, read-only use) and the
   ``redirectUri`` stored on the state, which must be that choice's;
3. the identity: **YouTube** is one channel per token (``channels?part=id,snippet&mine=true``: none →
   ``no_channel``; one → that channel; more than one → ``error`` and nothing written); **Meta** lists Pages (with
   their Instagram accounts) → ``choose_account`` when there are several; **TikTok** and **X** the signed-in user;
4. the token goes to the workspace secret, then ``SOCIAL#{platform}``: ``connected`` (with ``lastCheckedAt``),
   ``choose_account`` or ``same_as_clips`` (the identity is Clip Factory's own, compared read-only).

It never writes ``ACCOUNT#``, ``SETUP#`` or any ``cf-prod/platforms/*`` secret, never reads a Clip Factory token,
and never releases Clip Factory posts.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping
from typing import Any, Final

from .. import db
from ..log import log
from ..oauth import PKCE, OAuthEnv, providers, setup, state
from ..oauth.callback import DENIED, MAX_CODE_CHARS, RESULTS
from ..platforms.base import HttpRequest, HttpResponse
from . import apps, guard, social
from . import types as ws
from .secrets import WorkspaceSecrets

# §17.5's codes plus Lamo Stories' own one: the identity is Clip Factory's own destination (§45.13.4).
WS_RESULTS: Final = (*RESULTS, "same_as_clips")


def landing(app_url: str, platform: str, result: str, workspace_id: str | None = None) -> str:
    """``/stories/connections`` with a listed code only; ``&ws={id}`` only for a checked Lamo Stories id."""
    code = result if result in WS_RESULTS else "error"
    url = f"{app_url.rstrip('/')}/stories/connections?platform={platform if platform in ws.PLATFORMS else ''}"
    url += f"&result={code}"
    if workspace_id and workspace_id != ws.CLIPS and ws.WORKSPACE_ID.match(workspace_id):
        url += f"&ws={workspace_id}"
    return url


def consume(store: db.Store, nonce: str) -> dict[str, Any] | None:
    """Deletes Lamo Stories' state item ``OAUTH#ws.{nonce}`` once; the second caller gets None."""
    return store.delete_once(ws.oauth_pk(nonce), setup.OAUTH_SK)


def handle(
    platform: str,
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    secrets: WorkspaceSecrets | None,
    *,
    base: str | None = None,
) -> tuple[str, str | None]:
    """``(result, workspaceId)``: a code from ``WS_RESULTS`` and the workspace id once the state's signature
    checked out (else None). Never raises."""
    workspace_id: str | None = None
    try:
        if platform not in ws.PLATFORMS:
            return "error", None
        now = env.clock()
        key = env.state_key()
        try:
            workspace_id, nonce, exp = social.check_signature(key, platform, str(query.get("state") or ""))
        except state.StateError:
            return "expired", None
        if exp <= int(now.timestamp()):
            return "expired", workspace_id
        saved = consume(store, nonce)
        if (
            saved is None
            or saved.get("type") != social.STATE_TYPE
            or saved.get("platform") != platform
            or not saved.get("userId")
        ):
            return "expired", workspace_id
        if saved.get("workspaceId") != workspace_id or saved.get("socialAccountId") != ws.social_account_id(
            workspace_id, platform
        ):
            log("warning", "ws_callback.state_item_mismatch", platform=platform)
            return "error", workspace_id
        if secrets is None:
            return "error", workspace_id
        user_id = str(saved["userId"])
        workspace = guard.find_workspace(store, user_id, workspace_id)
        if workspace is None or workspace.get("workspaceType") != ws.STORIES:
            return "error", workspace_id
        scope = social.Scope(store, secrets, user_id, workspace_id)
        result = _result(platform, query, scope, env, saved, nonce=nonce, key=key, base=base)
    except Exception as e:  # the owner always lands on Lamo Stories' Connections page with a plain sentence
        log("error", "ws_callback.failed", platform=platform, error=type(e).__name__)
        return "error", workspace_id
    log("info", "ws_callback", platform=platform, result=result)
    return (result if result in WS_RESULTS else "error"), workspace_id


class _Recorder:
    """Keeps the platform's answers of the code exchange, so the YouTube channel count is read from the very
    answer ``providers.exchange`` used (no second call)."""

    def __init__(self, http: Any) -> None:
        self._http = http
        self.seen: list[tuple[HttpRequest, HttpResponse]] = []

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response: HttpResponse = self._http(request)
        self.seen.append((request, response))
        return response


def _youtube_channels(recorder: _Recorder) -> int:
    count = 0
    for request, response in recorder.seen:
        if request.url.startswith(providers.YOUTUBE_CHANNELS) and response.status == 200:
            body = response.json()
            items = body.get("items") if isinstance(body, dict) else None
            count = len([i for i in items or [] if isinstance(i, dict)])
    return count


def _result(
    platform: str,
    query: Mapping[str, str],
    scope: social.Scope,
    env: OAuthEnv,
    saved: Mapping[str, Any],
    *,
    nonce: str,
    key: bytes,
    base: str | None,
) -> str:
    error = str(query.get("error") or query.get("error_code") or "")
    if error:
        return "denied" if error in DENIED or "denied" in error or "cancel" in error else "error"
    code = str(query.get("code") or "")
    if not code or len(code) > MAX_CODE_CHARS:
        return "error"
    choice = str(saved.get("appChoice") or "")
    chosen = apps.app_keys(scope.store, scope.secrets, scope.user_id, scope.workspace_id, platform)
    if chosen is None or chosen.choice != choice or chosen.client_id != saved.get("appClientId"):
        # The app (or its keys) changed after Connect: the code belongs to the old one. Tap Connect again.
        log("warning", "ws_callback.app_changed", platform=platform)
        return "expired"
    redirect_uri = str(saved.get("redirectUri") or "")
    try:
        expected = apps.redirect_uri(env, chosen.choice, platform, base)
    except apps.CallbackOff:
        return "error"
    if not redirect_uri.startswith("https://") or redirect_uri != expected:
        return "redirect_wrong"
    verifier = state.pkce(key, nonce)[0] if PKCE.get(platform) else None
    recorder = _Recorder(env.http)
    try:
        linked = providers.exchange(
            dataclasses.replace(env, http=recorder),
            platform,
            chosen.keys,
            code,
            redirect_uri=redirect_uri,
            verifier=verifier,
        )
    except providers.Fail as e:
        if e.code == "missing_permissions":  # shown on the card; the next Connect asks Facebook again (rerequest)
            social.record_result(
                scope.store, scope.user_id, scope.workspace_id, platform, now=env.clock(), result=e.code
            )
            scope.mark(platform, env.clock(), missing=e.detail.split(",") if e.detail else [])
        return e.code if e.code in WS_RESULTS else "error"
    if platform == "youtube" and _youtube_channels(recorder) != 1:
        # One token posts to exactly one channel: with more than one there is no way to tell which. Nothing written.
        count = _youtube_channels(recorder)
        log("warning", "ws_callback.youtube_channels", count=count)
        return "no_channel" if count == 0 else "error"
    now = env.clock()
    if linked.status == "choose":
        social.save_choose(scope, platform, linked, app_client_id=chosen.client_id, now=now)
        return "choose"
    try:
        saved_account = social.save_connected(scope, platform, linked, app_client_id=chosen.client_id, now=now)
    except social.SaveRefused:
        return "error"
    return "same_as_clips" if saved_account["connectionStatus"] == "same_as_clips" else "connected"
