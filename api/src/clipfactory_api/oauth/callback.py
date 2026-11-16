"""``GET /oauth/{platform}/callback`` (run by ``cf-prod-hooks``; docs/CONTRACTS.md §17.5).

1. Verify the signed state (format, HMAC in constant time, expiry, platform) and consume it once: a conditional
   DeleteItem of ``OAUTH#{nonce}``/``STATE``. Any failure → ``expired``.
2. ``error`` in the query → ``denied`` (the owner pressed cancel) or ``error``.
3. Exchange the code server side with the stored redirect URI and the app keys (``providers.exchange``).
4. Write the token secret (or the ``pending`` secret and the choices), then the Account and SETUP items.

The caller always redirects to ``{APP_URL}/settings/posting/setup/{platform}?result={code}``: a fixed path and a
code from ``RESULTS`` only, so nothing from the request is reflected (no open redirect). The query, the code, the
state and every token stay out of the logs.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from typing import Any

from .. import db
from ..clock import iso
from ..log import log
from . import PKCE, SETUP_ORDER, OAuthEnv, providers, setup, state
from .providers import AppKeys, Linked

RESULTS = (
    "connected",
    "choose",
    "denied",
    "expired",
    "keys_wrong",
    "redirect_wrong",
    "missing_permissions",
    "no_channel",
    "no_accounts",
    "wrong_account_type",
    "no_pages",
    "platform_down",
    "error",
)
DENIED = frozenset({"access_denied", "user_denied", "user_cancelled", "cancelled", "consent_required"})
CHOICES_TTL = timedelta(minutes=30)
MAX_CODE_CHARS = 2048


def location(app_url: str, platform: str, result: str) -> str:
    code = result if result in RESULTS else "error"
    return f"{app_url.rstrip('/')}/settings/posting/setup/{platform}?result={code}"


def consume(store: db.Store, nonce: str) -> dict[str, Any] | None:
    """Deletes the state item once; the second caller gets None."""
    return store.delete_once(setup.oauth_pk(nonce), setup.OAUTH_SK)


def handle_callback(platform: str, query: Mapping[str, str], store: db.Store, env: OAuthEnv) -> str:
    """The result code (one of ``RESULTS``)."""
    if platform not in SETUP_ORDER:
        return "error"
    now = env.clock()
    try:
        key = env.state_key()
        nonce = state.verify(key, platform, str(query.get("state") or ""), int(now.timestamp()))
    except state.StateError:
        return "expired"
    saved = consume(store, nonce)
    if saved is None or saved.get("platform") != platform or not saved.get("userId"):
        return "expired"
    user_id = str(saved["userId"])
    result = _result(
        platform,
        query,
        store,
        env,
        user_id=user_id,
        nonce=nonce,
        key=key,
        redirect_uri=str(saved.get("redirectUri") or ""),
    )
    try:
        setup.record(store, user_id, platform, env.clock(), {"lastResult": result})
    except Exception as e:  # the result is shown either way
        log("warning", "oauth.record_failed", platform=platform, error=type(e).__name__)
    log("info", "oauth.callback", platform=platform, result=result)
    return result


def _result(
    platform: str,
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    *,
    user_id: str,
    nonce: str,
    key: bytes,
    redirect_uri: str,
) -> str:
    error = str(query.get("error") or query.get("error_code") or "")
    if error:
        return "denied" if error in DENIED or "denied" in error or "cancel" in error else "error"
    code = str(query.get("code") or "")
    if not code or len(code) > MAX_CODE_CHARS:
        return "error"
    # The redirect URI saved at Connect is the one the authorize URL carried (the token request must repeat it).
    if not redirect_uri.startswith("https://") or (env.hooks_url and redirect_uri != env.redirect_uri(platform)):
        return "redirect_wrong"
    keys = AppKeys.from_secret(env.secrets.read(env.secrets.name(platform, "app"), fresh=True))
    if keys is None:
        return "keys_wrong"
    verifier = state.pkce(key, nonce)[0] if PKCE.get(platform) else None
    try:
        linked = providers.exchange(env, platform, keys, code, redirect_uri=redirect_uri, verifier=verifier)
    except providers.Fail as e:
        if e.code == "missing_permissions":
            setup.mark_account(store, user_id, platform, env.clock(), missing=e.detail.split(",") if e.detail else [])
        return e.code if e.code in RESULTS else "error"
    save(store, env, user_id, platform, linked)
    return "connected" if linked.status == "connected" else "choose"


def save(store: db.Store, env: OAuthEnv, user_id: str, platform: str, linked: Linked) -> None:
    """Secrets first, then the items (an Account never says "connected" without its token)."""
    secrets = env.secrets
    now = env.clock()
    if linked.status == "choose":
        secrets.write(secrets.name(platform, "pending"), linked.pending or {}, platform=platform)
        setup.put_account(store, user_id, platform, "choose_account", now=now)
        setup.record(
            store,
            user_id,
            platform,
            now,
            {"choices": linked.choices, "choicesExpireAt": iso(now + CHOICES_TTL)},
        )
        return
    secrets.write(secrets.name(platform, "token"), linked.token, platform=platform)
    secrets.delete(secrets.name(platform, "pending"))
    setup.put_account(
        store, user_id, platform, "connected", now=now, fields={"connectedAt": iso(now), **linked.account}
    )
    current = setup.item(store, user_id, platform).get("gates")
    gates: dict[str, Any] = dict(current) if isinstance(current, Mapping) else {}
    for key, value in linked.gates.items():
        gates[key] = {"state": value, "at": iso(now)}
    if platform == "x":
        gates.pop("credits", None)  # a fresh connection starts without a credits problem
    setup.record(store, user_id, platform, now, {"gates": gates}, remove=["choices", "choicesExpireAt"])
