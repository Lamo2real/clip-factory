"""The two reading connections of Get paid (docs/CONTRACTS.md §40.6). Run by ``cf-prod-hooks`` (the callback) and
``cf-prod-api`` (the key, the Whop sign-in link and the stops).

**"Allow payment reading"** (YouTube, ``PAYCONN#adsense``): its own connection, because the Google account that owns
AdSense for YouTube can be another one than the YouTube channel's. ``save_payments_grant`` exchanges the code itself
at Google's token endpoint (never ``providers.exchange``: that one demands the Connect scopes and reads the channel,
which an AdSense-only token always fails), checks only ``adsense.readonly``, lists the AdSense accounts with the new
token, then writes the secret ``cf-prod/platforms/adsense/token`` and one UpdateItem on ``PAYCONN#adsense``. Anything
short of that writes nothing. It never touches ``ACCOUNT#youtube``, the YouTube token, ``SETUP#`` or ``MONEYSTATE#``.

**"Connect Whop"** (Content Rewards, ``PAYCONN#whop``): Whop's OAuth 2.1 sign-in with PKCE (S256) and the owner's own
public Whop app (a ``client_id``, no secret). Clip Factory asks only for read scopes; it never moves money. Every call
to Whop carries ``Api-Version-Date``. Whop's OIDC metadata is read by the API (never the browser) and kept for a day.

Nothing here logs a code, a token, a key or a state.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

from .. import db
from ..clock import iso
from ..log import log
from ..oauth import OAuthEnv, state
from ..oauth.providers import FORM, GOOGLE_TOKEN, AppKeys, Fail, body, call
from ..platforms.base import HttpRequest, HttpResponse, obj
from . import ADSENSE, ADSENSE_SCOPE, WHOP, WHOP_API_VERSION, WHOP_SCOPES, payconn_sk

Item = dict[str, Any]
ADSENSE_ACCOUNTS = "https://adsense.googleapis.com/v2/accounts"
WHOP_METADATA = "https://api.whop.com/.well-known/openid-configuration"
WHOP_ME = "https://api.whop.com/api/v1/users/me"
METADATA_SECONDS = 24 * 3600
MAX_ACCOUNTS = 5
MAX_CODE_CHARS = 2048
DENIED = frozenset({"access_denied", "user_denied", "user_cancelled", "cancelled", "consent_required"})

PAYMENTS_RESULTS = (
    "payments_allowed",
    "payments_denied",
    "payments_missing",
    "payments_no_account",
    "payments_api_off",
    "payments_error",
)
WHOP_RESULTS = ("whop_connected", "whop_denied", "whop_missing", "whop_expired", "whop_error")
# The page shows these word for word (§40.6; M's tests check them).
SENTENCES = {
    "payments_allowed": "Clip Factory can see your YouTube payments now. It checks once a day.",
    "payments_denied": "You didn't allow it. Tap Allow payment reading to try again.",
    "payments_missing": "Tick **View your AdSense data** on Google's page. Then tap Allow payment reading again.",
    "payments_no_account": (
        "That Google account has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account "
        "that has it. Still no luck? Skip this step. Your ticks still work."
    ),
    "payments_api_off": "Tap Turn on AdSense reading, then **Enable**. Then tap Allow payment reading again.",
    "payments_error": "Something went wrong. Tap Allow payment reading again.",
    "whop_connected": "Clip Factory can see your Whop payouts now ({name}).",
    "whop_denied": "You didn't allow it. Tap Connect Whop to try again.",
    "whop_missing": "Tick all four boxes in your Whop app. Then tap Connect Whop.",
    "whop_expired": "That took too long. Tap Connect Whop again.",
    "whop_error": "Whop didn't answer. Tap Connect Whop again in a few minutes.",
}


def _denied(error: str) -> bool:
    return error in DENIED or "denied" in error or "cancel" in error


def mark(
    store: db.Store,
    user_id: str,
    source: str,
    now: datetime,
    fields: Mapping[str, Any],
    *,
    remove: tuple[str, ...] = (),
    first: Mapping[str, Any] | None = None,
) -> Item:
    """One UpdateItem on ``PAYCONN#{source}`` (made when missing): sets ``fields``, sets each of ``first`` only when it
    isn't there yet (``if_not_exists``), removes ``remove``."""
    sets: Item = {"type": "payconn", "source": source, "userId": user_id, **fields, "updatedAt": iso(now)}
    names: dict[str, str] = {}
    values: Item = {}
    parts = []
    for i, (key, value) in enumerate(sets.items()):
        names[f"#s{i}"], values[f":s{i}"] = key, value
        parts.append(f"#s{i} = :s{i}")
    for i, (key, value) in enumerate((first or {}).items()):
        names[f"#f{i}"], values[f":f{i}"] = key, value
        parts.append(f"#f{i} = if_not_exists(#f{i}, :f{i})")
    expression = "SET " + ", ".join(parts)
    if remove:
        for i, key in enumerate(remove):
            names[f"#r{i}"] = key
        expression += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove)))
    return store.update_expr(db.user_pk(user_id), payconn_sk(source), expression, names=names, values=values)


def _expires_at(now: datetime, seconds: Any) -> str | None:
    if isinstance(seconds, bool) or not isinstance(seconds, int | float | str):
        return None
    try:
        value = int(seconds)
    except ValueError:
        return None
    return iso(now + timedelta(seconds=value)) if value > 0 else None


def _scopes(raw: Any) -> list[str]:
    return [s for s in str(raw or "").replace(",", " ").split(" ") if s]


# --- YouTube: "Allow payment reading" ---------------------------------------------------------------------------


def payments_result(
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    *,
    user_id: str,
    nonce: str,
    key: bytes,
    redirect_uri: str,
) -> str:
    """The callback's answer for a ``grant: "payments"`` state (already checked and used once)."""
    error = str(query.get("error") or query.get("error_code") or "")
    if error:
        return "payments_denied" if _denied(error) else "payments_error"
    code = str(query.get("code") or "")
    if not code or len(code) > MAX_CODE_CHARS:
        return "payments_error"
    if not redirect_uri.startswith("https://") or (env.hooks_url and redirect_uri != env.redirect_uri("youtube")):
        return "payments_error"
    keys = AppKeys.from_secret(env.secrets.read(env.secrets.name("youtube", "app"), fresh=True))
    if keys is None:
        return "payments_error"
    verifier = state.pkce(key, nonce)[0]
    return save_payments_grant(store, env, user_id, keys, code, redirect_uri=redirect_uri, verifier=verifier)


def _api_off(resp: HttpResponse) -> bool:
    error = obj(body(resp).get("error"))
    reasons = {str(obj(e).get("reason") or "") for e in error.get("errors") or []}
    details = {str(obj(d).get("reason") or "") for d in error.get("details") or []}
    return "accessNotConfigured" in reasons or "SERVICE_DISABLED" in details


def save_payments_grant(
    store: db.Store,
    env: OAuthEnv,
    user_id: str,
    keys: AppKeys,
    code: str,
    *,
    redirect_uri: str,
    verifier: str | None,
) -> str:
    """§40.6 steps 1–5. Writes the secret and ``PAYCONN#adsense`` only after every check passed."""
    now = env.clock()
    form = {
        "code": code,
        "client_id": keys.client_id,
        "client_secret": keys.client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    if verifier:
        form["code_verifier"] = verifier
    try:
        resp = call(env, HttpRequest("POST", GOOGLE_TOKEN, FORM, urlencode(form).encode()))
    except Fail:
        return "payments_error"
    data = body(resp)
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        log("warning", "getpaid.payments_refused", status=resp.status)
        return "payments_error"
    granted = _scopes(data.get("scope"))
    wanted = tuple(env.payment_scopes.get("youtube") or (ADSENSE_SCOPE,))
    if any(s not in granted for s in wanted):
        return "payments_missing"
    access = str(data["access_token"])
    try:
        listed = call(env, HttpRequest("GET", ADSENSE_ACCOUNTS, {"Authorization": f"Bearer {access}"}))
    except Fail:
        return "payments_error"
    if listed.status == 403:
        return "payments_api_off" if _api_off(listed) else "payments_no_account"
    if listed.status != 200:
        return "payments_error"
    accounts = [a for a in body(listed).get("accounts") or [] if isinstance(a, Mapping) and a.get("name")]
    if not accounts:
        return "payments_no_account"
    names = [str(a["name"]) for a in accounts[:MAX_ACCOUNTS]]
    token = {
        "accessToken": access,
        "expiresAt": _expires_at(now, data.get("expires_in")),
        "refreshToken": data.get("refresh_token"),
        "scope": " ".join(sorted(granted)),
        "clientId": keys.client_id,
        "accounts": names,
    }
    env.secrets.write(env.secrets.name(ADSENSE, "token"), token, platform=ADSENSE)
    mark(
        store,
        user_id,
        ADSENSE,
        now,
        {
            "status": "connected",
            "accounts": [
                {"name": str(a["name"]), "displayName": str(a.get("displayName") or "")[:80]}
                for a in accounts[:MAX_ACCOUNTS]
            ],
            "scopes": sorted(granted),
            "lastResult": "payments_allowed",
        },
        remove=("reason", "stoppedAt"),
        first={"connectedAt": iso(now)},  # a second Allow keeps the first moment
    )
    log("info", "getpaid.payments_allowed", accounts=len(names))
    return "payments_allowed"


def stop_payments(store: db.Store, env: OAuthEnv, user_id: str, now: datetime) -> None:
    """ "Stop payment reading": delete Clip Factory's AdSense token and say ``not_connected``. **No call to Google's
    revoke**: it would end every scope the user gave the app, the YouTube connection too when it is the same Google
    account. ``PAYSTATE#youtube`` and every ``PAYOUT#youtube#…`` stay (records of real money)."""
    env.secrets.delete(env.secrets.name(ADSENSE, "token"))
    if store.get(db.user_pk(user_id), payconn_sk(ADSENSE)) is not None:
        mark(
            store,
            user_id,
            ADSENSE,
            now,
            {"status": "not_connected", "stoppedAt": iso(now)},
            remove=("reason", "connectedAt", "refreshLeaseUntil"),
        )
    log("info", "getpaid.payments_stopped")


# --- Content Rewards: "Connect Whop" ----------------------------------------------------------------------------

_metadata: dict[str, tuple[float, Item]] = {}
_lock = threading.Lock()


def forget_metadata() -> None:
    with _lock:
        _metadata.clear()


def whop_headers(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    return {"Accept": "application/json", "Api-Version-Date": WHOP_API_VERSION, **(extra or {})}


def _whop_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    parts = urlsplit(value)
    host = parts.hostname or ""
    if parts.scheme != "https" or not (host == "whop.com" or host.endswith(".whop.com")):
        return None
    return value


def whop_metadata(env: OAuthEnv, *, now: float | None = None) -> Item | None:
    """Whop's OIDC metadata (``authorization_endpoint``, ``token_endpoint``, ``revocation_endpoint``), kept for a day
    per container. None when Whop didn't answer or named an endpoint off Whop's own https hosts."""
    moment = time.monotonic() if now is None else now
    with _lock:
        hit = _metadata.get(WHOP_METADATA)
        if hit and moment - hit[0] < METADATA_SECONDS:
            return dict(hit[1])
    try:
        resp = call(env, HttpRequest("GET", WHOP_METADATA, whop_headers()))
    except Fail:
        return None
    data = body(resp)
    if resp.status != 200:
        return None
    found: Item = {
        "authorization_endpoint": _whop_url(data.get("authorization_endpoint")),
        "token_endpoint": _whop_url(data.get("token_endpoint")),
        "revocation_endpoint": _whop_url(data.get("revocation_endpoint")),
    }
    if not found["authorization_endpoint"] or not found["token_endpoint"]:
        return None
    with _lock:
        _metadata[WHOP_METADATA] = (moment, found)
    return dict(found)


def whop_authorize_url(meta: Mapping[str, Any], client_id: str, redirect_uri: str, signed: str, challenge: str) -> str:
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(("openid", *WHOP_SCOPES)),
        "state": signed,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{meta['authorization_endpoint']}?{urlencode(params, quote_via=quote)}"


def whop_result(
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    *,
    user_id: str,
    nonce: str,
    key: bytes,
    redirect_uri: str,
) -> str:
    """The callback's answer for a Whop state (already checked and used once)."""
    error = str(query.get("error") or "")
    if error:
        return "whop_denied" if _denied(error) else "whop_error"
    code = str(query.get("code") or "")
    if not code or len(code) > MAX_CODE_CHARS:
        return "whop_error"
    if not redirect_uri.startswith("https://") or (env.hooks_url and redirect_uri != env.redirect_uri(WHOP)):
        return "whop_error"
    app = env.secrets.read(env.secrets.name(WHOP, "app"), fresh=True) or {}
    client_id = str(app.get("clientId") or "")
    if not client_id:
        return "whop_error"
    verifier = state.pkce(key, nonce)[0]
    return save_whop_grant(store, env, user_id, client_id, code, redirect_uri=redirect_uri, verifier=verifier)


def save_whop_grant(
    store: db.Store,
    env: OAuthEnv,
    user_id: str,
    client_id: str,
    code: str,
    *,
    redirect_uri: str,
    verifier: str,
) -> str:
    """The public-client code exchange (``client_id`` and ``code_verifier``, no secret), the four read scopes, then
    ``users/me`` for the ``user_`` id and name; the token secret and ``PAYCONN#whop`` only after all of that."""
    now = env.clock()
    meta = whop_metadata(env)
    if meta is None:
        return "whop_error"
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": verifier,
    }
    try:
        resp = call(
            env, HttpRequest("POST", str(meta["token_endpoint"]), {**FORM, **whop_headers()}, urlencode(form).encode())
        )
    except Fail:
        return "whop_error"
    data = body(resp)
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        reason = str(data.get("error") or "")
        log("warning", "getpaid.whop_refused", status=resp.status)
        return "whop_expired" if reason == "invalid_grant" else "whop_error"
    granted = _scopes(data["scope"]) if "scope" in data else ["openid", *WHOP_SCOPES]
    if any(s not in granted for s in WHOP_SCOPES):
        return "whop_missing"
    access = str(data["access_token"])
    try:
        me = call(env, HttpRequest("GET", WHOP_ME, whop_headers({"Authorization": f"Bearer {access}"})))
    except Fail:
        return "whop_error"
    user = body(me)
    whop_id = str(user.get("id") or "")
    if me.status != 200 or not whop_id.startswith("user_"):
        return "whop_error"
    username = str(user.get("username") or "").strip().lstrip("@")[:40]
    token = {
        "accessToken": access,
        "expiresAt": _expires_at(now, data.get("expires_in")),
        "refreshToken": data.get("refresh_token"),
        "scope": " ".join(sorted(granted)),
        "whopUserId": whop_id,
    }
    version = env.secrets.write(env.secrets.name(WHOP, "token"), token, platform=WHOP)
    fields: Item = {
        "status": "connected",
        "accountId": whop_id,
        "accountName": f"@{username}" if username else "Whop",
        "connectedAt": iso(now),
        "scopes": sorted(granted),
        "lastResult": "whop_connected",
    }
    if version:
        fields["tokenVersionId"] = version
    mark(store, user_id, WHOP, now, fields, remove=("reason", "stoppedAt"))
    log("info", "getpaid.whop_connected")
    return "whop_connected"


def revoke_whop(env: OAuthEnv, client_id: str, token: Mapping[str, Any]) -> None:
    """Best effort, at the metadata's ``revocation_endpoint`` when there is one: the token secret goes either way."""
    try:
        meta = whop_metadata(env)
        endpoint = (meta or {}).get("revocation_endpoint")
        value = str(token.get("refreshToken") or token.get("accessToken") or "")
        if not endpoint or not value:
            return
        hint = "refresh_token" if token.get("refreshToken") else "access_token"
        form = {"token": value, "token_type_hint": hint, "client_id": client_id}
        call(env, HttpRequest("POST", str(endpoint), {**FORM, **whop_headers()}, urlencode(form).encode()))
    except Exception as e:
        log("warning", "getpaid.whop_revoke_failed", error=type(e).__name__)
