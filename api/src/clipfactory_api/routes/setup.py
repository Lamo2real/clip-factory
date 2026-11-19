"""/v1/setup and /v1/accounts: the posting setup list, keys, Check it, Connect and Disconnect (docs/CONTRACTS.md §17.4).

Keys and tokens go to Secrets Manager only: a response carries masked hints, never a key; nothing here logs one.
"""

from __future__ import annotations

import re
from datetime import timedelta
from typing import Any

from .. import posts, validate
from ..app import App
from ..clock import iso
from ..errors import ApiError, bad_request, conflict, not_found
from ..http import Request, Response, no_content, ok
from ..ids import ulid
from ..log import log
from ..oauth import (
    MONEY_GRANT,
    PKCE,
    SETUP_ORDER,
    STATE_SECONDS,
    OAuthEnv,
    callback,
    formats,
    label,
    money_capable,
    providers,
    setup,
    state,
)
from ..oauth.providers import AppKeys
from ..oauth.tokens import ReconnectNeededError, SecretsTokenProvider
from ..platforms import errors as platform_errors
from ..platforms.base import NotConnectedError, RetryablePublishError, obj

TIKTOK_FILE = re.compile(r"^tiktok[A-Za-z0-9_-]{4,64}\.txt$")
MAX_FILE_BYTES = 4096
REVIEW_STATES = ("draft", "in_review", "live", "not_approved")


def _platform(req: Request) -> str:
    platform = req.params["platform"]
    if platform not in SETUP_ORDER:
        raise not_found("We do not support that platform.")
    return platform


def _env(app: App) -> OAuthEnv:
    if app.oauth is None:
        raise ApiError(503, "unavailable", "Posting setup is not switched on for this app yet.")
    return app.oauth


def _owner_email(app: App, req: Request) -> str:
    return str(req.claims.get("email") or app.email_lookup(req.user_id, req.token) or "")


def _setup_body(app: App, req: Request, platform: str) -> Response:
    return ok({"setup": setup.one_setup(app.store, req.user_id, platform, app.clock())})


def _keys(env: OAuthEnv, platform: str) -> AppKeys | None:
    return AppKeys.from_secret(env.secrets.read(env.secrets.name(platform, "app"), fresh=True))


# --- the list --------------------------------------------------------------------------------------------------


def get_setup(app: App, req: Request) -> Response:
    env = _env(app)
    found = setup.all_setups(app.store, req.user_id, app.clock())
    return ok(
        {
            "platforms": found,
            "ready": sum(1 for s in found if s["ready"]),
            "values": setup.values(env, _owner_email(app, req)),
        }
    )


def get_platform(app: App, req: Request) -> Response:
    _env(app)
    return _setup_body(app, req, _platform(req))


def patch_platform(app: App, req: Request) -> Response:
    platform = _platform(req)
    _env(app)
    body = req.json()
    now = app.clock()
    if "gate" in body:
        validate.only_keys(body, {"gate", "state"})
        if platform != "tiktok" or body.get("gate") != "app_review":
            raise bad_request("Only TikTok's app review status can be picked here.")
        value = body.get("state")
        if value not in REVIEW_STATES:
            raise bad_request("Pick Draft, In review, Live or Not approved.")
        setup.set_gate(
            app.store, req.user_id, platform, "app_review", state=setup.APP_REVIEW[value], now=now, value=value
        )
        return _setup_body(app, req, platform)
    validate.only_keys(body, {"step", "done"})
    step = body.get("step")
    if not isinstance(step, str) or not setup.STEP_ID.match(step):
        raise bad_request("That step is not known.")
    done = validate.boolean(body.get("done"), "done")
    if done:
        current = setup.item(app.store, req.user_id, platform).get("stepsDone") or []
        if step not in current and len(current) >= setup.MAX_STEPS:
            raise bad_request("Too many steps are ticked.")
        setup.record(app.store, req.user_id, platform, now, add_steps=[step])
    else:
        setup.record(app.store, req.user_id, platform, now, drop_steps=[step])
    return _setup_body(app, req, platform)


# --- keys ----------------------------------------------------------------------------------------------------------


def put_keys(app: App, req: Request) -> Response:
    platform = _platform(req)
    env = _env(app)
    body = req.json()
    validate.only_keys(body, formats.KEY_NAMES)
    needed = formats.needs(platform)
    if "configId" in body and "configId" not in needed:
        raise bad_request(f"{label(platform)} does not use a Configuration ID.")
    for name in needed:
        if body.get(name) in (None, ""):
            raise bad_request(
                {
                    "clientId": "Paste the first key.",
                    "clientSecret": "Paste the secret.",
                    "configId": "Paste the Configuration ID.",
                }[name]
            )
    cleaned = {name: formats.check(platform, name, body[name]) for name in needed}
    now = app.clock()
    previous = setup.item(app.store, req.user_id, platform)
    changed = previous.get("keysClientId") not in (None, cleaned["clientId"])
    # The old token was issued to the old app: it can only be revoked with the old keys, so read them first.
    old_keys = _keys(env, platform) if changed else None
    secret: dict[str, Any] = {**cleaned, "userId": req.user_id, "savedAt": iso(now)}
    env.secrets.write(env.secrets.name(platform, "app"), secret, platform=platform)
    if changed:
        account = setup.account_item(app.store, req.user_id, platform) or {}
        if account.get("status") not in (None, "not_connected"):
            _disconnect(app, env, req.user_id, platform, reason="keys_changed", keys=old_keys)
    setup.record(
        app.store,
        req.user_id,
        platform,
        now,
        {
            "keysSavedAt": iso(now),
            "keyHints": {name: formats.hint(name, value) for name, value in cleaned.items()},
            "keysClientId": cleaned["clientId"],
        },
        remove=["check"],
    )
    log("info", "setup.keys_saved", platform=platform, changed=changed)
    return _setup_body(app, req, platform)


def delete_keys(app: App, req: Request) -> Response:
    platform = _platform(req)
    env = _env(app)
    _disconnect(app, env, req.user_id, platform)
    env.secrets.delete(env.secrets.name(platform, "app"))
    setup.record(
        app.store, req.user_id, platform, app.clock(), remove=["keysSavedAt", "keyHints", "keysClientId", "check"]
    )
    log("info", "setup.keys_deleted", platform=platform)
    return no_content()


# --- Check it ------------------------------------------------------------------------------------------------------


def check(app: App, req: Request) -> Response:
    platform = _platform(req)
    env = _env(app)
    keys = _keys(env, platform)
    if keys is None:
        raise conflict(f"Paste your {label(platform)} keys first.")
    now = app.clock()
    code, message = providers.check_keys(env, platform, keys)
    result: dict[str, Any] = {"at": iso(now), "ok": code == "ok", "code": code, "message": message, "account": "none"}
    account = setup.account_item(app.store, req.user_id, platform) or {}
    if code == "ok" and account.get("status") in {"connected", "needs_reconnect"}:
        result.update(_check_account(app, env, platform, keys, account))
    elif code == "ok":
        result.update({"code": "not_connected", "message": providers.check_message("not_connected", platform)})
    setup.record(app.store, req.user_id, platform, now, {"check": result})
    return ok({"check": result, "setup": setup.one_setup(app.store, req.user_id, platform, now)})


def _check_account(app: App, env: OAuthEnv, platform: str, keys: AppKeys, account: dict[str, Any]) -> dict[str, Any]:
    tokens = SecretsTokenProvider(app.store, env)
    try:
        creds = tokens.credentials(platform, account)
    except ReconnectNeededError:
        return _dead(platform)
    except NotConnectedError:
        return {"code": "not_connected", "message": providers.check_message("not_connected", platform)}
    except Exception as e:
        log("warning", "setup.check_token_failed", platform=platform, error=type(e).__name__)
        return {"ok": False, "code": "platform_down", "message": providers.check_message("platform_down", platform)}
    verdict = providers.check_profile(env, platform, keys, creds.data, creds.access_token)
    now = app.clock()
    if verdict == "dead":
        tokens.mark_dead(platform, account)
        return _dead(platform)
    if verdict == "credits_empty":
        setup.set_gate(app.store, str(account.get("userId")), platform, "credits", state="action", now=now)
        return {
            "ok": False,
            "code": "credits_empty",
            "message": providers.check_message("credits_empty", platform),
            "account": "ok",
        }
    if verdict == "platform_down":
        return {"ok": False, "code": "platform_down", "message": providers.check_message("platform_down", platform)}
    if account.get("status") == "needs_reconnect":
        setup.mark_account(app.store, str(account.get("userId")), platform, now, remove=["reason"], status="connected")
    return {"account": "ok", "message": f"Everything works. Clip Factory can post to {label(platform)}."}


def _dead(platform: str) -> dict[str, Any]:
    return {
        "ok": False,
        "code": "token_dead",
        "message": providers.check_message("token_dead", platform),
        "account": "dead",
    }


# --- TikTok verification file --------------------------------------------------------------------------------------


def tiktok_file(app: App, req: Request) -> Response:
    _env(app)
    body = req.json()
    validate.only_keys(body, {"filename", "content"})
    filename = body.get("filename")
    content = body.get("content")
    if not isinstance(filename, str) or not TIKTOK_FILE.match(filename):
        raise bad_request("Use the file TikTok gave you. Its name starts with tiktok and ends with .txt.")
    if (
        not isinstance(content, str)
        or not content.strip()
        or len(content.encode()) > MAX_FILE_BYTES
        or any(not (32 <= ord(c) < 127 or c in "\r\n\t") for c in content)
    ):
        raise bad_request("That is not TikTok's file. Download it again from TikTok.")
    if app.web_files is None:
        raise ApiError(503, "unavailable", "Posting setup is not switched on for this app yet.")
    app.web_files.put(filename, content)
    setup.record(app.store, req.user_id, "tiktok", app.clock(), add_files=[filename])
    log("info", "setup.tiktok_file", action="put")
    return _setup_body(app, req, "tiktok")


def delete_tiktok_file(app: App, req: Request) -> Response:
    _env(app)
    filename = req.params["filename"]
    if not TIKTOK_FILE.match(filename):
        raise not_found("We could not find that file.")
    if app.web_files is None:
        raise ApiError(503, "unavailable", "Posting setup is not switched on for this app yet.")
    app.web_files.delete(filename)
    setup.record(app.store, req.user_id, "tiktok", app.clock(), drop_files=[filename])
    log("info", "setup.tiktok_file", action="delete")
    return no_content()


# --- accounts: connect, choose, disconnect, TikTok creator info ---------------------------------------------------


def list_accounts(app: App, req: Request) -> Response:
    _env(app)
    return ok({"accounts": posts.accounts(app.store, req.user_id)})


def connect(app: App, req: Request) -> Response:
    platform = _platform(req)
    env = _env(app)
    body = req.json()
    validate.only_keys(body, {"grant"})
    grant = body.get("grant")
    if grant is not None and grant != MONEY_GRANT:
        raise bad_request('grant can only be "money".')
    money = grant == MONEY_GRANT
    keys = _keys(env, platform)
    if keys is None or (platform in {"instagram", "facebook"} and not keys.config_id):
        raise conflict(f"Paste your {label(platform)} keys first.")
    if money:
        # §25.4 "Allow money reading": only where it means something, and only on top of a working connection.
        if not money_capable(env, platform):
            raise bad_request(f"{label(platform)} does not share money with apps, so there is nothing to allow.")
        if posts.connected_account(app.store, req.user_id, platform) is None:
            raise conflict(f"Connect {label(platform)} first in Settings › Posting › Set up posting.")
    now = app.clock()
    if platform in {"instagram", "facebook"}:
        _drop_pending(app, env, req.user_id, platform)  # a new Connect never leaves an old list of Page tokens behind
    exp = int(now.timestamp()) + STATE_SECONDS
    key = env.state_key()
    nonce = state.new_nonce()
    signed = state.sign(key, platform, nonce, exp)
    app.store.put(
        {
            "pk": setup.oauth_pk(nonce),
            "sk": setup.OAUTH_SK,
            "type": "oauth",
            "userId": req.user_id,
            "platform": platform,
            "redirectUri": env.redirect_uri(platform),
            "createdAt": iso(now),
            "ttl": exp + 300,
            **({"grant": MONEY_GRANT} if money else {}),
        },
        if_absent=True,
    )
    challenge = state.pkce(key, nonce)[1] if PKCE.get(platform) else None
    rerequest = not money and setup.item(app.store, req.user_id, platform).get("lastResult") == "missing_permissions"
    url = providers.authorize_url(env, platform, keys, signed, challenge, rerequest=rerequest, money=money)
    log("info", "setup.connect_started", platform=platform, grant=grant or "connect")
    return ok({"authorizeUrl": url, "expiresAt": iso(now + timedelta(seconds=STATE_SECONDS))})


def choose(app: App, req: Request) -> Response:
    platform = _platform(req)
    env = _env(app)
    if platform not in {"instagram", "facebook"}:
        raise bad_request(f"{label(platform)} has nothing to pick.")
    body = req.json()
    validate.only_keys(body, {"accountId"})
    choice = validate.required_string(body, "accountId", max_len=64)
    now = app.clock()
    item = setup.item(app.store, req.user_id, platform)
    gone = conflict("That list is too old. Press Connect again.")
    choices = item.get("choices") or []
    expires = item.get("choicesExpireAt")
    if not expires or expires <= iso(now):
        _drop_pending(app, env, req.user_id, platform)  # the list is too old: its tokens must not stay behind
        raise gone
    if not any(c.get("id") == choice for c in choices):
        raise gone
    pending = env.secrets.read(env.secrets.name(platform, "pending"), fresh=True)
    if pending is None:
        raise gone
    try:
        linked = providers.chosen(platform, pending, choice, list(env.scopes.get(platform, ())))
    except providers.Fail as e:
        raise gone from e
    callback.save(app.store, env, req.user_id, platform, linked)
    log("info", "setup.chosen", platform=platform)
    return _setup_body(app, req, platform)


def _drop_pending(app: App, env: OAuthEnv, user_id: str, platform: str) -> None:
    """Delete the Meta ``pending`` secret (the user token and every Page token) and the choices that went with it."""
    env.secrets.delete(env.secrets.name(platform, "pending"))
    setup.record(app.store, user_id, platform, app.clock(), remove=["choices", "choicesExpireAt"])


def disconnect(app: App, req: Request) -> Response:
    platform = _platform(req)
    _disconnect(app, _env(app), req.user_id, platform)
    return no_content()


def _disconnect(
    app: App,
    env: OAuthEnv,
    user_id: str,
    platform: str,
    *,
    reason: str | None = None,
    keys: AppKeys | None = None,
) -> None:
    """Revoke (best effort), delete the token and pending secrets, Account ``not_connected``; YouTube data that came
    from the API is forgotten (YouTube Developer Policies). ``keys`` are the app keys the token was issued to (the
    old keys when they were just replaced); by default the saved keys are used."""
    secrets = env.secrets
    token = secrets.read(secrets.name(platform, "token"), fresh=True)
    if token is not None:
        providers.revoke(env, platform, keys or _keys(env, platform), token)
    secrets.delete(secrets.name(platform, "token"))
    secrets.delete(secrets.name(platform, "pending"))
    now = app.clock()
    setup.put_account(app.store, user_id, platform, "not_connected", now=now, fields={"reason": reason})
    setup.record(app.store, user_id, platform, now, remove=["choices", "choicesExpireAt"])
    if platform == "youtube" and app.invoker is not None:
        try:
            app.invoker.forget(user_id, platform)
        except Exception as e:  # the token is gone either way; the next forget (or a reconnect) cleans up
            log("error", "setup.forget_failed", platform=platform, error=type(e).__name__)
    log("info", "setup.disconnected", platform=platform, reason=reason)


def creator_info(app: App, req: Request) -> Response:
    env = _env(app)
    account = posts.connected_account(app.store, req.user_id, "tiktok")
    if account is None:
        raise conflict("Connect TikTok first.")
    tokens = SecretsTokenProvider(app.store, env)
    try:
        creds = tokens.credentials("tiktok", account)
        status, body = providers.creator_info(env, creds.access_token)
    except ReconnectNeededError as e:
        raise conflict(str(e)) from e
    except NotConnectedError as e:
        raise conflict("Connect TikTok first.") from e
    except (RetryablePublishError, providers.Fail) as e:
        # TikTok was slow, busy or down (also while refreshing the token): nothing is wrong on our side.
        log("warning", "setup.creator_info_failed", error=type(e).__name__)
        raise ApiError(503, "platform_down", "TikTok did not answer. Try again in a minute.") from e
    error = obj(body.get("error"))
    if status != 200 or str(error.get("code") or "ok") != "ok":
        problem = platform_errors.classify("tiktok", status, body)
        if problem.kind == "reconnect":
            tokens.mark_dead("tiktok", account)
        if problem.retryable:  # TikTok answered with 5xx or "slow down": a try-again, not a conflict
            log("warning", "setup.creator_info_failed", error=problem.kind)
            raise ApiError(503, "platform_down", "TikTok did not answer. Try again in a minute.")
        raise conflict(problem.sentence)
    data = obj(body.get("data"))
    options = [str(o) for o in data.get("privacy_level_options") or []]
    setup.set_gate(
        app.store, req.user_id, "tiktok", "posting_audit", state=providers.posting_audit(data), now=app.clock()
    )
    return ok(
        {
            "creator": {
                "nickname": str(data.get("creator_nickname") or ""),
                "username": str(data.get("creator_username") or ""),
                "avatarUrl": str(data.get("creator_avatar_url") or ""),
                "privacyOptions": options,
                "commentDisabled": bool(data.get("comment_disabled")),
                "duetDisabled": bool(data.get("duet_disabled")),
                "stitchDisabled": bool(data.get("stitch_disabled")),
                "maxDurationSec": int(data.get("max_video_post_duration_sec") or 0),
            }
        }
    )


# --- web files (TikTok verification) -------------------------------------------------------------------------------


class WebFiles:
    """Puts and deletes ``tiktok*.txt`` files at the root of the web bucket and clears CloudFront's copy."""

    def __init__(self, s3: Any, bucket: str, cloudfront: Any, distribution_id: str) -> None:
        self._s3 = s3
        self.bucket = bucket
        self._cloudfront = cloudfront
        self.distribution_id = distribution_id

    def put(self, filename: str, content: str) -> None:
        self._check(filename)
        self._s3.put_object(
            Bucket=self.bucket,
            Key=filename,
            Body=content.encode(),
            ContentType="text/plain; charset=utf-8",
            CacheControl="no-cache",
        )
        self._invalidate(filename)

    def delete(self, filename: str) -> None:
        self._check(filename)
        self._s3.delete_object(Bucket=self.bucket, Key=filename)
        self._invalidate(filename)

    @staticmethod
    def _check(filename: str) -> None:
        if not TIKTOK_FILE.match(filename):
            raise ValueError("only TikTok verification files")

    def _invalidate(self, filename: str) -> None:
        try:
            self._cloudfront.create_invalidation(
                DistributionId=self.distribution_id,
                InvalidationBatch={"Paths": {"Quantity": 1, "Items": [f"/{filename}"]}, "CallerReference": ulid()},
            )
        except Exception as e:  # no-cache already makes the next read fresh within the default TTL
            log("warning", "setup.invalidation_failed", error=type(e).__name__)
