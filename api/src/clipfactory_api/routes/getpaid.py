"""/v1/getpaid: set up payouts, see if money can reach him, and what Google or Whop sent (docs/CONTRACTS.md §40.7).

Every route reads stored items only (no platform, Google or Whop call), except "Connect Whop" (Whop's OIDC metadata)
and "Stop reading Whop" (Whop's revoke, best effort). "Stop payment reading" never calls Google: Google's revoke
would end the YouTube connection too when it is the same Google account. Nothing here accepts a money amount, a bank
number, a card number or a tax number, and no answer carries a token, a key, a trace code or a publisher id.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from .. import db, money, validate
from ..app import App
from ..clock import iso
from ..errors import ApiError, bad_request, conflict, not_found
from ..getpaid import CR, GETPAID_SK, MAX_TICKS, PLACES, WHOP, grants, payconn_sk, status, view
from ..http import Request, Response, no_content, ok
from ..log import log
from ..oauth import STATE_SECONDS, OAuthEnv, setup, state

STEP_ID = re.compile(r"^[a-z0-9-]{1,40}$")
WHOP_KEY = re.compile(r"^app_[A-Za-z0-9]{4,64}$")


def _env(app: App) -> OAuthEnv:
    if app.oauth is None:
        raise ApiError(503, "unavailable", "Posting setup is not switched on for this app yet.")
    return app.oauth


def _cr_on(app: App) -> bool:
    return getattr(app, "contentrewards", None) is not None


def _whop_on(app: App) -> bool:
    return bool(getattr(app, "whop_connect", False))


def _whop(app: App) -> OAuthEnv:
    """The Whop routes: 503 "Coming soon." while ``WHOP_CONNECT`` is off (or Content Rewards is)."""
    if not _whop_on(app) or not _cr_on(app):
        raise ApiError(503, "unavailable", "Coming soon.")
    return _env(app)


def _get_paid(app: App, user_id: str) -> dict[str, Any]:
    redirect = app.oauth.redirect_uri(WHOP) if app.oauth is not None else ""
    whop_on = _whop_on(app) and _cr_on(app)
    return view.load(app.store, user_id, app.clock(), cr_on=_cr_on(app), whop_on=whop_on, whop_redirect=redirect)


def get_getpaid(app: App, req: Request) -> Response:
    """``GetPaid``; also puts the owner on the daily money run's list, like ``GET /v1/money``."""
    money.register_owner(app.store, req.user_id, app.clock())
    return ok(_get_paid(app, req.user_id))


def get_place(app: App, req: Request) -> Response:
    place = req.params["place"]
    if place not in PLACES or (place == CR and not _cr_on(app)):
        raise not_found("We could not find that place.")
    whop_on = _whop_on(app) and _cr_on(app)
    return ok(view.place(app.store, req.user_id, place, app.clock(), cr_on=_cr_on(app), whop_on=whop_on))


def patch_steps(app: App, req: Request) -> Response:
    """``{step, done}``: his "I did this" on a step Clip Factory can't see. ``meta-payout`` is one tick for both
    Meta places; Content Rewards' steps stay on its own connection (§38.7)."""
    body = req.json()
    validate.only_keys(body, {"step", "done"})
    step_id = body.get("step")
    if not isinstance(step_id, str) or not STEP_ID.match(step_id):
        raise bad_request("That step is not known.", "step")
    done = validate.boolean(body.get("done"), "done")
    found = status.platform_step(step_id)
    if found is None and step_id in status.CR_STEP_IDS:
        raise bad_request("Tick Content Rewards steps on its own card.", "step")
    if found is None:
        raise bad_request("That step is not known.", "step")
    if not found.manual:
        raise bad_request("Tap Allow payment reading instead.", "step")
    now = app.clock()
    current = view.ticks(app.store, req.user_id)
    if done and step_id not in current and len(current) >= MAX_TICKS:
        raise bad_request("Too many steps are ticked.", "step")
    names = {"#t": "type", "#u": "userId", "#a": "updatedAt", "#s": "stepsDone"}
    values: dict[str, Any] = {":t": "getpaid", ":u": req.user_id, ":a": iso(now), ":s": {step_id}}
    action = "ADD" if done else "DELETE"
    app.store.update_expr(
        db.user_pk(req.user_id), GETPAID_SK, f"SET #t = :t, #u = :u, #a = :a {action} #s :s", names=names, values=values
    )
    log("info", "getpaid.step", step=step_id, done=done)
    return ok(_get_paid(app, req.user_id))


# --- "Stop payment reading" (YouTube) -------------------------------------------------------------------------


def stop_adsense(app: App, req: Request) -> Response:
    grants.stop_payments(app.store, _env(app), req.user_id, app.clock())
    return no_content()


# --- "Connect Whop" (Content Rewards) -------------------------------------------------------------------------


def _key_hint(client_id: str) -> str:
    return f"{client_id[:6]}…{client_id[-4:]}"


def put_whop_key(app: App, req: Request) -> Response:
    """His own Whop app's Client ID (a public client: no secret). A new key while connected ends the old sign-in."""
    env = _whop(app)
    body = req.json()
    validate.only_keys(body, {"clientId"})
    raw = body.get("clientId")
    client_id = raw.strip() if isinstance(raw, str) else ""
    if not WHOP_KEY.match(client_id):
        raise bad_request("Your Whop key starts with app_.", "clientId")
    now = app.clock()
    old = env.secrets.read(env.secrets.name(WHOP, "app"), fresh=True) or {}
    conn = app.store.get(db.user_pk(req.user_id), payconn_sk(WHOP)) or {}
    env.secrets.write(
        env.secrets.name(WHOP, "app"),
        {"clientId": client_id, "userId": req.user_id, "savedAt": iso(now)},
        platform=WHOP,
    )
    fields: dict[str, Any] = {"keyHint": _key_hint(client_id)}
    remove: tuple[str, ...] = ()
    signed_in = conn.get("status") in {"connected", "needs_reconnect"}
    if signed_in and old.get("clientId") not in (None, client_id):
        env.secrets.delete(env.secrets.name(WHOP, "token"))  # it belongs to the old app
        fields.update(status="keys_saved", reason="keys_changed")
        remove = ("connectedAt", "refreshLeaseUntil")
    elif not signed_in:
        fields["status"] = "keys_saved"
    grants.mark(app.store, req.user_id, WHOP, now, fields, remove=remove)
    log("info", "getpaid.whop_key_saved", changed=old.get("clientId") not in (None, client_id))
    return ok(_get_paid(app, req.user_id))


def connect_whop(app: App, req: Request) -> Response:
    env = _whop(app)
    saved = env.secrets.read(env.secrets.name(WHOP, "app"), fresh=True) or {}
    client_id = str(saved.get("clientId") or "")
    if not client_id:
        raise conflict("Save your Whop key first.")
    meta = grants.whop_metadata(env)
    if meta is None:
        raise ApiError(503, "platform_down", "Whop didn't answer. Try again in a few minutes.")
    now = app.clock()
    exp = int(now.timestamp()) + STATE_SECONDS
    key = env.state_key()
    nonce = state.new_nonce()
    signed = state.sign(key, WHOP, nonce, exp)
    redirect = env.redirect_uri(WHOP)
    app.store.put(
        {
            "pk": setup.oauth_pk(nonce),
            "sk": setup.OAUTH_SK,
            "type": "oauth",
            "userId": req.user_id,
            "platform": WHOP,
            "redirectUri": redirect,
            "createdAt": iso(now),
            "ttl": exp + 300,
        },
        if_absent=True,
    )
    url = grants.whop_authorize_url(meta, client_id, redirect, signed, state.pkce(key, nonce)[1])
    log("info", "getpaid.whop_connect_started")
    return ok({"authorizeUrl": url, "expiresAt": iso(now + timedelta(seconds=STATE_SECONDS))})


def stop_whop(app: App, req: Request) -> Response:
    """ "Stop reading Whop": revoke (best effort), delete the token secret, keep his Whop key (``keys_saved``). Every
    ``PAYOUT#contentrewards#…`` stays."""
    env = _whop(app)
    now = app.clock()
    saved = env.secrets.read(env.secrets.name(WHOP, "app"), fresh=True) or {}
    token = env.secrets.read(env.secrets.name(WHOP, "token"), fresh=True)
    if token is not None and saved.get("clientId"):
        grants.revoke_whop(env, str(saved["clientId"]), token)
    env.secrets.delete(env.secrets.name(WHOP, "token"))
    if app.store.get(db.user_pk(req.user_id), payconn_sk(WHOP)) is not None:
        grants.mark(
            app.store,
            req.user_id,
            WHOP,
            now,
            {"status": "keys_saved" if saved.get("clientId") else "not_connected", "stoppedAt": iso(now)},
            remove=("reason", "connectedAt", "refreshLeaseUntil"),
        )
    log("info", "getpaid.whop_stopped")
    return no_content()


__all__ = [
    "connect_whop",
    "get_getpaid",
    "get_place",
    "patch_steps",
    "put_whop_key",
    "stop_adsense",
    "stop_whop",
]
