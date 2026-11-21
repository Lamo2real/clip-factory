"""Connect, Check it and Disconnect (docs/CONTRACTS.md §38.9 "Registering", "Connect start", "Connect finish").

The desktop app's loopback door only carries the one-time code; the code exchange, the token and every CR call stay
here. The PKCE verifier is derived from the signed state (never stored). Connect and Disconnect run under the same
refresh lease as every refresh, so exactly one process ever holds a refresh token. Never logs ``code``, ``state``,
tokens or the query.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso
from ..errors import ApiError, bad_request, conflict
from ..log import log
from ..oauth import state as oauth_state
from ..oauth.tokens import clear_lease, take_lease
from . import campaigns, config, connection, oauth
from .deps import CrDeps
from .mcp import CrError, McpClient
from .tokens import Access, TokenError, app_name, token_name

Item = dict[str, Any]
LEASE_WAIT_TRIES = 5
DELETE_RETRY_SECONDS = 10
_PILOT = re.compile(r"connect apps|pilot|not allowed|not eligible", re.IGNORECASE)


@dataclass
class _Fixed:
    """A just-issued token for the two calls of Connect finish (get_me, tools/list)."""

    store: db.Store
    token: str

    def access(self, user_id: str, *, stale: str | None = None) -> Access:
        if stale is not None:
            raise TokenError("dead")
        return Access(self.token, {}, {})


def busy() -> ApiError:
    return conflict("Try again in a few seconds.")


def _state_key(deps: CrDeps) -> bytes:
    if deps.state_key is None:
        raise ApiError(503, "unavailable", "Content Rewards is not switched on for this app yet.")
    return deps.state_key()


def client_id(deps: CrDeps, now: datetime, *, again: bool = False) -> str:
    """CR's ``client_id`` for this install: registered once (RFC 7591), again only when the secret is missing or CR
    said ``invalid_client``."""
    name = app_name(deps.secrets)
    found = None if again else deps.secrets.read(name, fresh=True)
    if found and found.get("clientId"):
        return str(found["clientId"])
    try:
        registered = oauth.register(deps.net, now)
    except oauth.OAuthFail as e:
        retry = int(e.retry_after) if e.retry_after else None
        raise campaigns.platform_down("Content Rewards didn't answer. Try again in a minute.", retry) from e
    deps.secrets.write(name, registered, platform=config.SECRET_KEY)
    log("info", "cr.registered")
    return str(registered["clientId"])


def start(deps: CrDeps, user_id: str, port: Any, now: datetime) -> Item:
    if isinstance(port, bool) or port not in config.PORTS:
        raise bad_request("port must be one of 47811 to 47815.", "port")
    key = _state_key(deps)
    connection.ensure(deps.store, user_id, now)
    cid = client_id(deps, now)
    nonce = oauth_state.new_nonce()
    exp = int((now + config.CONNECT_STATE).timestamp())
    signed = oauth_state.sign(key, config.STATE_PLATFORM, nonce, exp)
    _verifier, challenge = oauth_state.pkce(key, nonce)
    deps.store.put(
        {
            "pk": db.user_pk(user_id),
            "sk": db.crstate_sk(nonce),
            "type": "crstate",
            "port": int(port),
            "redirectUri": oauth.redirect_uri(int(port)),
            "clientId": cid,
            "exp": exp,
            "ttl": exp + 300,
        }
    )
    return {
        "authorizeUrl": oauth.authorize_url(cid, int(port), signed, challenge),
        "expiresAt": iso(now + config.CONNECT_STATE),
    }


def _result(deps: CrDeps, user_id: str, now: datetime, result: str) -> Item:
    connection.ensure(deps.store, user_id, now)
    item = connection.update(deps.store, user_id, now, {"lastResult": result})
    return {"result": result, "connection": connection.public(item, now)}


def _lease(deps: CrDeps, user_id: str) -> bool:
    pk, sk = connection.key(user_id)
    for attempt in range(LEASE_WAIT_TRIES + 1):
        if take_lease(deps.store, pk, sk, deps.clock(), config.LEASE):
            return True
        if attempt < LEASE_WAIT_TRIES:
            deps.sleep(1.0)
    return False


def finish(  # noqa: PLR0915 (the steps of §38.9 Connect finish, in order)
    deps: CrDeps, user_id: str, body: Mapping[str, Any], now: datetime
) -> Item:
    key = _state_key(deps)
    signed = body.get("state")
    try:
        nonce = oauth_state.verify(key, config.STATE_PLATFORM, str(signed or ""), int(now.timestamp()))
    except oauth_state.StateError:
        return _result(deps, user_id, now, "expired")
    found = deps.store.delete_once(db.user_pk(user_id), db.crstate_sk(nonce))
    if found is None:
        return _result(deps, user_id, now, "expired")
    if body.get("error") is not None:
        error = str(body.get("error") or "")
        text = f"{error} {body.get('errorDescription') or ''}"
        if error == "access_denied" and not _PILOT.search(str(body.get("errorDescription") or "")):
            return _result(deps, user_id, now, "denied")
        if _PILOT.search(text):
            return _result(deps, user_id, now, "not_allowed")
        return _result(deps, user_id, now, "error")
    iss = body.get("iss")
    if iss is not None and iss != config.ISSUER:
        log("warning", "cr.iss_mismatch")
        return _result(deps, user_id, now, "error")
    code = body.get("code")
    if not isinstance(code, str) or not code:
        return _result(deps, user_id, now, "error")
    verifier, _challenge = oauth_state.pkce(key, nonce)
    cid = str(found.get("clientId") or "")
    try:
        answer = oauth.exchange(deps.net, cid, str(found.get("redirectUri")), code, verifier)
    except oauth.OAuthFail as e:
        if e.kind == "invalid_client":
            deps.secrets.delete(app_name(deps.secrets))  # register again next time
            return _result(deps, user_id, now, "error")
        if e.kind in {"down", "rate"}:
            return _result(deps, user_id, now, "cr_down")
        if e.kind == "dead":
            return _result(deps, user_id, now, "expired")
        if _PILOT.search(e.code):
            return _result(deps, user_id, now, "not_allowed")
        return _result(deps, user_id, now, "error")
    fresh = oauth.secret_from(answer, now, requested=config.SCOPES)
    granted = set(fresh["scope"].split())
    client = McpClient(
        deps.net,
        _Fixed(deps.store, fresh["accessToken"]),  # type: ignore[arg-type]
        user_id,
        deps.clock,
        sleep=deps.sleep,
        monotonic=deps.monotonic,
    )
    try:
        me = client.call("get_me", {})
        tools = client.tools()
    except CrError as e:
        log("info", "cr.connect_read_failed", code=e.code)
        if e.code == "permission_denied":
            return _result(deps, user_id, now, "not_allowed")
        return _result(deps, user_id, now, "cr_down" if e.retryable else "error")
    creator = str(me.get("id") or "")
    fresh["creatorId"] = creator
    missing = [s for s in config.SCOPES if s not in granted]
    can_submit = config.WRITE_SCOPE in granted and "create_my_submission" in tools
    status = "connected" if can_submit else "read_only"
    result = "connected" if can_submit else "read_only"
    if not _lease(deps, user_id):
        oauth.revoke(deps.net, cid, fresh["refreshToken"])
        return _result(deps, user_id, now, "busy")
    pk, sk = connection.key(user_id)
    try:
        old_conn = connection.load(deps.store, user_id)
        old_secret = None
        if old_conn.get("tokenVersionId"):
            old_secret = deps.secrets.read(token_name(deps.secrets), version_id=str(old_conn["tokenVersionId"]))
        version = _write_token(deps, fresh)
        if version is None:
            oauth.revoke(deps.net, cid, fresh["refreshToken"])
            return _result(deps, user_id, now, "cr_down")
        if old_secret and old_secret.get("refreshToken") and old_secret.get("refreshToken") != fresh["refreshToken"]:
            oauth.revoke(deps.net, cid, str(old_secret["refreshToken"]))
        steps = {str(s) for s in old_conn.get("stepsDone") or []} | {"ready-account"}
        fields: Item = {
            "status": status,
            "creatorId": creator,
            "scopes": sorted(granted),
            "canSubmit": can_submit,
            "connectedAt": iso(now),
            "signInBy": iso(now + config.SIGN_IN_DAYS),
            "tokenIssuedAt": fresh["issuedAt"],
            "lastRefreshAt": iso(now),
            "lastResult": result,
            "check": connection.check("ok" if can_submit else "read_only", now),
            "stepsDone": steps,
            "userId": user_id,
            "type": "crconn",
        }
        if version:
            fields["tokenVersionId"] = version
        remove = ["refreshLeaseUntil", "blocked", "warnedAt"]
        if missing:
            fields["missing"] = missing
        else:
            remove.append("missing")
        if any(s in config.READ_SCOPES for s in missing):
            fields["reason"] = "missing_permissions"
        else:
            remove.append("reason")
        if old_conn.get("creatorId") and old_conn.get("creatorId") != creator:
            fields["crLinked"] = {}
            remove += ["typeidVerified", "orgMatched"]
            log("info", "cr.account_changed")
        updated = deps.store.update(pk, sk, fields, remove=remove)
    finally:
        clear_lease(deps.store, pk, sk)
    campaigns.own(deps.store, user_id, now)
    if deps.invoker is not None:
        try:
            deps.invoker.cr_check(user_id, "campaigns")
        except Exception as e:  # the campaigns are re-checked on the next tick anyway
            log("warning", "cr.check_invoke_failed", error=type(e).__name__)
    log("info", "cr.connected", result=result)
    return {"result": result, "connection": connection.public(updated, now)}


def _write_token(deps: CrDeps, fresh: Mapping[str, Any]) -> str | None:
    """Create-or-put; right after a Disconnect a "scheduled for deletion" answer is retried for up to 10 s."""
    name = token_name(deps.secrets)
    for second in range(DELETE_RETRY_SECONDS + 1):
        try:
            return deps.secrets.write(name, dict(fresh), platform=config.SECRET_KEY)
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code != "InvalidRequestException" or second == DELETE_RETRY_SECONDS:
                if code == "InvalidRequestException":
                    return None
                raise
            deps.sleep(1.0)
    return None


def check(deps: CrDeps, user_id: str, now: datetime) -> Item:
    connection.ensure(deps.store, user_id, now)
    conn = connection.load(deps.store, user_id)
    last = conn.get("check")
    from ..clock import parse

    at = parse(conn.get("lastCheckAt"))
    if isinstance(last, Mapping) and at is not None and now - at < config.CONNECTION_CHECK_EVERY:
        return {"check": dict(last), "connection": connection.public(conn, now)}
    if not connection.signed_in(conn):
        code = "token_dead" if conn.get("status") == "needs_reconnect" else "not_connected"
    else:
        client = deps.mcp(user_id)
        try:
            client.call("get_me", {})
            tools = client.tools()
            fresh = connection.load(deps.store, user_id)
            if fresh.get("reason") == "missing_permissions":
                code = "missing_permissions"
            elif config.WRITE_SCOPE in (fresh.get("scopes") or []) and "create_my_submission" in tools:
                code = "ok"
            else:
                code = "read_only"
        except CrError as e:
            code = {
                "token_dead": "token_dead",
                "invalid_token": "token_dead",
                "not_connected": "token_dead",
                "insufficient_scope": "missing_permissions",
                "permission_denied": "blocked",
            }.get(e.code, "cr_down")
    result = connection.check(code, now)
    updated = connection.update(deps.store, user_id, now, {"check": result, "lastCheckAt": iso(now)})
    return {"check": result, "connection": connection.public(updated, now)}


def disconnect(deps: CrDeps, user_id: str, now: datetime) -> None:
    connection.ensure(deps.store, user_id, now)
    if not _lease(deps, user_id):
        raise busy()
    pk, sk = connection.key(user_id)
    try:
        conn = connection.load(deps.store, user_id)
        name = token_name(deps.secrets)
        secret = None
        if conn.get("tokenVersionId"):
            secret = deps.secrets.read(name, version_id=str(conn["tokenVersionId"]))
        if secret is None:
            secret = deps.secrets.read(name, fresh=True)
        if secret and secret.get("refreshToken"):
            cid = str((deps.secrets.read(app_name(deps.secrets), fresh=True) or {}).get("clientId") or "")
            if cid:
                oauth.revoke(deps.net, cid, str(secret["refreshToken"]))
        deps.secrets.delete(name)
        deps.store.update(
            pk,
            sk,
            {"status": "not_connected", "canSubmit": False, "updatedAt": iso(now)},
            remove=[
                "refreshLeaseUntil",
                "tokenVersionId",
                "tokenIssuedAt",
                "lastRefreshAt",
                "reason",
                "blocked",
                "missing",
                "scopes",
                "connectedAt",
                "signInBy",
                "check",
                "warnedAt",
            ],
        )
    finally:
        clear_lease(deps.store, pk, sk)
    log("info", "cr.disconnected")


def patch(deps: CrDeps, user_id: str, body: Mapping[str, Any], now: datetime) -> Item:
    """One of ``{said}``, ``{step, done}``, ``{relinked}``, ``{finance}`` (§38.8)."""
    from ..settings import PLATFORMS

    keys = set(body)
    connection.ensure(deps.store, user_id, now)
    conn = connection.load(deps.store, user_id)
    fields: Item = {}
    remove: list[str] = []
    if keys == {"said"}:
        if body["said"] == "pilot_sent":
            fields["pilotSentAt"] = iso(now)
            fields["pilotReminders"] = 0
            fields["pilotRemindAt"] = iso(now + config.PILOT_EVERY)
        elif body["said"] is None:
            remove += ["pilotSentAt", "pilotReminders", "pilotRemindAt"]
        else:
            raise bad_request('said must be "pilot_sent" or null.', "said")
    elif keys == {"step", "done"}:
        step, done = body["step"], body["done"]
        if not isinstance(step, str) or not connection.STEP_ID.match(step) or not isinstance(done, bool):
            raise bad_request("step must be a step id and done true or false.", "step")
        steps = {str(s) for s in conn.get("stepsDone") or []}
        steps = steps | {step} if done else steps - {step}
        if len(steps) > config.MAX_STEPS_DONE:
            raise bad_request("Too many steps are ticked.", "step")
        if steps:
            fields["stepsDone"] = steps
        else:
            remove.append("stepsDone")
        if step == "ready-socials" and done:
            fields["crLinked"] = {k: v for k, v in connection.crlinked(conn).items() if v is not False}
    elif keys == {"relinked"}:
        platform = body["relinked"]
        if platform not in PLATFORMS:
            raise bad_request("relinked must be a platform.", "relinked")
        linked = connection.crlinked(conn)
        linked.pop(str(platform), None)
        fields["crLinked"] = linked
    elif keys == {"finance"}:
        if body["finance"] is None:
            remove.append("finance")
        elif isinstance(body["finance"], bool):
            fields["finance"] = body["finance"]
        else:
            raise bad_request("finance must be true, false or null.", "finance")
    else:
        raise bad_request("Send one of said, step and done, relinked or finance.")
    updated = connection.update(deps.store, user_id, now, fields, remove=remove)
    return connection.public(updated, now)
