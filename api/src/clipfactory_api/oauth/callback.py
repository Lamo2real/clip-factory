"""``GET /oauth/{platform}/callback`` (run by ``cf-prod-hooks``; docs/CONTRACTS.md §17.5).

1. Verify the signed state (format, HMAC in constant time, expiry, platform) and consume it once: a conditional
   DeleteItem of ``OAUTH#{nonce}``/``STATE``. Any failure → ``expired``.
2. ``error`` in the query → ``denied`` (the owner pressed cancel) or ``error``.
3. Exchange the code server side with the stored redirect URI and the app keys (``providers.exchange``).
4. Write the token secret (or the ``pending`` secret and the choices), then the Account and SETUP items.
5. ``connected``: the clips whose posts wait for this place go out (``release.release_waiting``, §17.6). A failure
   there is logged; the owner still lands on ``result=connected``.

The caller always redirects to ``{APP_URL}/settings/posting/setup/{platform}?result={code}``: a fixed path and a
code from ``RESULTS`` only, so nothing from the request is reflected (no open redirect). The query, the code, the
state and every token stay out of the logs.

"Allow money reading" (§25.4: the state item carries ``grant: "money"``) goes through ``save_money_grant`` instead
of ``save``: it merges the new token and scopes into the existing connection and never replaces the Account item.
Its codes (``MONEY_RESULTS``) send the owner back to ``/settings/posting/money?result={code}&platform={platform}``.

Get paid (§40.6) adds two more, each handed to ``getpaid.grants`` and never to ``save`` or ``save_money_grant``:
"Allow payment reading" (a YouTube state with ``grant: "payments"``: its own AdSense token, never the YouTube
connection; back to ``/settings/posting/getpaid/youtube?result={code}``) and "Connect Whop" (the platform ``whop``,
served on this callback only; back to ``/settings/posting/getpaid/contentrewards?result={code}#whop``). A payments
state is signed for ``youtube:payments`` (``state_label``), so one that is expired, used already or fails on the way
(a Secrets Manager or DynamoDB error) still lands on Get paid with ``payments_error``, never on the YouTube setup page.

Your bank (§40.5.5) is the platform ``bank``, handed to ``bank.grants.save_bank_grant`` before anything else (its own
state check, its own 25 s deadline, never ``save``). It always goes back to the public page
``{APP_URL}/bank-done?result={code}`` (a code from ``bank.RESULTS`` only), which needs no sign-in and shows no data.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from datetime import timedelta
from typing import Any

from .. import db, release
from ..bank import PLATFORM as BANK
from ..bank import RESULTS as BANK_RESULTS
from ..bank import ROUTE_SECONDS as BANK_SECONDS
from ..clock import iso
from ..getpaid import grants
from ..log import log
from . import MONEY_GRANT, PAYMENTS_GRANT, PKCE, SETUP_ORDER, OAuthEnv, providers, setup, state, state_label
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
MONEY_RESULTS = (
    "money_allowed",
    "money_denied",
    "money_missing",
    "money_not_connected",
    "money_wrong_account",
    "money_error",
)
PAYMENTS_RESULTS = grants.PAYMENTS_RESULTS
WHOP_RESULTS = grants.WHOP_RESULTS
WHOP = "whop"  # §40.6: Connect Whop's callback (never a posting platform, never /hooks/whop)
DENIED = frozenset({"access_denied", "user_denied", "user_cancelled", "cancelled", "consent_required"})
CHOICES_TTL = timedelta(minutes=30)
MAX_CODE_CHARS = 2048


def location(app_url: str, platform: str, result: str) -> str:
    if platform == BANK:
        code = result if result in BANK_RESULTS else "bank_error"
        return f"{app_url.rstrip('/')}/bank-done?result={code}"
    if platform == WHOP:
        code = result if result in WHOP_RESULTS else "whop_expired" if result == "expired" else "whop_error"
        return f"{app_url.rstrip('/')}/settings/posting/getpaid/contentrewards?result={code}#whop"
    if result in PAYMENTS_RESULTS and platform == "youtube":
        return f"{app_url.rstrip('/')}/settings/posting/getpaid/youtube?result={result}"
    if result in MONEY_RESULTS and platform in SETUP_ORDER:
        return f"{app_url.rstrip('/')}/settings/posting/money?result={result}&platform={platform}"
    code = result if result in RESULTS else "error"
    return f"{app_url.rstrip('/')}/settings/posting/setup/{platform}?result={code}"


def _signed_for(key: bytes, label: str, raw: str) -> bool:
    """Whether ``raw`` carries a good signature for ``label``, expired or not (any real ``exp`` is after 0)."""
    try:
        state.verify(key, label, raw, 0)
    except state.StateError:
        return False
    return True


def consume(store: db.Store, nonce: str) -> dict[str, Any] | None:
    """Deletes the state item once; the second caller gets None."""
    return store.delete_once(setup.oauth_pk(nonce), setup.OAUTH_SK)


def handle_callback(
    platform: str,
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    flows: release.ClipFlowStarter | None = None,
    *,
    bank_http: Callable[..., Any] | None = None,
    bank_monotonic: Callable[[], float] | None = None,
) -> str:
    """The result code (one of ``RESULTS``). On ``connected``, the clips waiting for this place go out
    (``release.release_waiting`` with ``flows``, §17.6); that never changes the result the owner sees."""
    started = time.monotonic()  # the release must be done before the owner's answer is due
    if platform == BANK:
        return _bank(query, store, env, bank_http, bank_monotonic)
    if platform not in SETUP_ORDER and platform != WHOP:
        return "error"
    now = env.clock()
    raw = str(query.get("state") or "")
    try:
        key = env.state_key()
    except state.StateError:
        return "expired"
    # "Allow payment reading" signs its state for its own label (§40.6): a failed one goes back to Get paid, never
    # to the YouTube setup page ("Press Connect YouTube again" would send him to the wrong button).
    payments = platform == "youtube" and _signed_for(key, state_label(platform, PAYMENTS_GRANT), raw)
    failed = "payments_error" if payments else "expired"
    signed_for = state_label(platform, PAYMENTS_GRANT if payments else None)
    try:
        nonce = state.verify(key, signed_for, raw, int(now.timestamp()))
        saved = consume(store, nonce)
    except state.StateError:
        return failed
    except Exception as e:
        if not payments:
            raise
        log("error", "oauth.payments_failed", error=type(e).__name__)
        return failed
    if saved is not None and saved.get("workspaceId"):  # §45.13.3: a Lamo Stories item never runs this path
        log("warning", "oauth.workspace_item_refused", platform=platform)
        return "error"
    if saved is None or saved.get("platform") != platform or not saved.get("userId"):
        return failed
    if payments and saved.get("grant") != PAYMENTS_GRANT:
        return failed
    user_id = str(saved["userId"])
    if platform == WHOP or (platform == "youtube" and saved.get("grant") == PAYMENTS_GRANT):
        handoff = grants.whop_result if platform == WHOP else grants.payments_result
        try:
            paid = handoff(
                query,
                store,
                env,
                user_id=user_id,
                nonce=nonce,
                key=key,
                redirect_uri=str(saved.get("redirectUri") or ""),
            )
        except Exception as e:  # a Secrets Manager or DynamoDB error: back to Get paid with a plain sentence
            log("error", "oauth.getpaid_failed", platform=platform, error=type(e).__name__)
            paid = "whop_error" if platform == WHOP else "payments_error"
        log("info", "oauth.callback", platform=platform, result=paid)
        return paid
    if saved.get("grant") == MONEY_GRANT:
        money = _money_result(
            platform,
            query,
            store,
            env,
            user_id=user_id,
            nonce=nonce,
            key=key,
            redirect_uri=str(saved.get("redirectUri") or ""),
        )
        log("info", "oauth.callback", platform=platform, result=money)
        return money
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
    if result == "connected" and flows is not None:
        try:
            release.release_waiting(store, flows, user_id, platform, deadline=started + release.ANSWER_SECONDS)
        except Exception as e:  # the account is connected either way; Post now in the Library is the backup
            log("error", "oauth.release_failed", platform=platform, error=type(e).__name__)
    log("info", "oauth.callback", platform=platform, result=result)
    return result


def _bank(
    query: Mapping[str, str],
    store: db.Store,
    env: OAuthEnv,
    http: Callable[..., Any] | None,
    monotonic: Callable[[], float] | None,
) -> str:
    """§40.5.5: Your bank's BankID return, with its own 25 s deadline (a ``bank.RESULTS`` code)."""
    from ..bank import eb
    from ..bank import grants as bank_grants

    bank_env = eb.from_oauth(env, http, monotonic)
    return bank_grants.save_bank_grant(query, store, bank_env, eb.Deadline(BANK_SECONDS, bank_env.monotonic))


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


# --- §25.4 "Allow money reading" ------------------------------------------------------------------------------


def _money_result(
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
    """The money grant's code. Anything short of a clean success writes nothing: the old token and Account stay."""
    error = str(query.get("error") or query.get("error_code") or "")
    if error:
        denied = error in DENIED or "denied" in error or "cancel" in error
        return "money_denied" if denied else "money_missing"
    code = str(query.get("code") or "")
    if not code or len(code) > MAX_CODE_CHARS:
        return "money_error"
    if not redirect_uri.startswith("https://") or (env.hooks_url and redirect_uri != env.redirect_uri(platform)):
        return "money_error"
    keys = AppKeys.from_secret(env.secrets.read(env.secrets.name(platform, "app"), fresh=True))
    if keys is None:
        return "money_error"
    verifier = state.pkce(key, nonce)[0] if PKCE.get(platform) else None
    try:
        linked = providers.exchange(env, platform, keys, code, redirect_uri=redirect_uri, verifier=verifier)
    except providers.Fail as e:
        # A Connect scope missing, TikTok refusing a scope it has not approved yet, a dead code: nothing changes.
        log("warning", "oauth.money_grant_refused", platform=platform, code=e.code)
        return "money_missing" if e.code == "missing_permissions" else "money_error"
    return save_money_grant(store, env, user_id, platform, linked)


def save_money_grant(store: db.Store, env: OAuthEnv, user_id: str, platform: str, linked: Linked) -> str:
    """Merges a money grant into the existing connection (§25.4). Never ``put_account``, never the gates, never a
    disconnect: (1) the Account must exist, be connected and be the same account (channel, TikTok user), and every
    money scope must be granted, else nothing is written; (2) the token secret is written; (3) one UpdateItem sets
    ``scopes`` to the union of old and new and removes ``moneyScopesMissing``, keeping every other field."""
    if linked.status != "connected":
        return "money_error"
    account = setup.account_item(store, user_id, platform)
    if account is None or account.get("status") != "connected":
        return "money_not_connected"
    old_id = str(account.get("accountId") or "")
    new_id = str(linked.account.get("accountId") or "")
    if not new_id or (old_id and old_id != new_id):
        return "money_wrong_account"
    granted = {str(s) for s in linked.account.get("scopes") or []}
    if any(s not in granted for s in env.money_scopes.get(platform, ())):
        return "money_missing"
    now = env.clock()
    env.secrets.write(env.secrets.name(platform, "token"), linked.token, platform=platform)
    old_scopes = {str(s) for s in account.get("scopes") or []}
    setup.mark_account(
        store,
        user_id,
        platform,
        now,
        remove=["moneyScopesMissing"],
        scopes=sorted(old_scopes | granted),
        moneyAllowedAt=iso(now),
    )
    # The Money page this lands on starts a Check now, which registers the owner for the daily run (cf-prod-hooks
    # may only write OAUTH#, HOOK# and USER# items, and that is all this needs).
    log("info", "oauth.money_grant", platform=platform)
    return "money_allowed"
