"""Every platform HTTP call of the posting setup (docs/CONTRACTS.md §17.4–§17.6).

Authorize URLs, **Check it**, the code exchange and profile reads of the callback, token refresh, revoke and
TikTok's creator info. HTTP goes through the ``HttpClient`` of ``OAuthEnv`` (urllib in production, recorded answers
in the tests) to fixed https hosts only. Keys and tokens travel in POST bodies or headers, never in a URL (Meta's
token endpoint is called with POST and a form body); no URL built here is ever logged.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

from ..clock import iso
from ..log import log
from ..platforms.base import HttpRequest, HttpResponse, NetworkError, appsecret_proof, obj
from . import OAuthEnv, label

GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"  # noqa: S105 - an endpoint, not a secret
GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke"
YOUTUBE_CHANNELS = "https://www.googleapis.com/youtube/v3/channels"
TIKTOK_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/"
TIKTOK_API = "https://open.tiktokapis.com"
TIKTOK_TOKEN = f"{TIKTOK_API}/v2/oauth/token/"
TIKTOK_REVOKE = f"{TIKTOK_API}/v2/oauth/revoke/"
TIKTOK_USER = f"{TIKTOK_API}/v2/user/info/?fields=open_id,avatar_url,display_name"
TIKTOK_CREATOR = f"{TIKTOK_API}/v2/post/publish/creator_info/query/"
TIKTOK_SCOPES = "user.info.basic,video.publish,video.list"
TIKTOK_REQUIRED = ("user.info.basic", "video.publish", "video.list")
META_DIALOG_HOST = "https://www.facebook.com"
GRAPH = "https://graph.facebook.com"
X_AUTHORIZE = "https://x.com/i/oauth2/authorize"
X_TOKEN = "https://api.x.com/2/oauth2/token"  # noqa: S105 - an endpoint, not a secret
X_REVOKE = "https://api.x.com/2/oauth2/revoke"
X_ME = "https://api.x.com/2/users/me?user.fields=profile_image_url,username,name"
X_SCOPES = "tweet.read tweet.write users.read media.write offline.access"
X_REQUIRED = ("tweet.read", "tweet.write", "users.read", "media.write", "offline.access")
CHECK_CODE = "cf-check"
DUMMY_VERIFIER = "cf-check-verifier-cf-check-verifier-cf-check"
REFRESH_WARN = timedelta(days=7)


@dataclass(frozen=True)
class AppKeys:
    client_id: str
    client_secret: str
    config_id: str | None = None

    @staticmethod
    def from_secret(value: dict[str, Any] | None) -> AppKeys | None:
        if not value or not value.get("clientId") or not value.get("clientSecret"):
            return None
        config = value.get("configId")
        return AppKeys(str(value["clientId"]), str(value["clientSecret"]), str(config) if config else None)


class Fail(Exception):
    """The setup step ended with one of the §17.5 result codes."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


class Dead(Exception):
    """The platform says the user token (or refresh token) is no longer valid."""


@dataclass
class Linked:
    """The outcome of a successful code exchange."""

    status: str  # "connected" | "choose"
    token: dict[str, Any] = field(default_factory=dict)  # the token secret (connected)
    account: dict[str, Any] = field(default_factory=dict)  # handle, name, avatarUrl, accountId, scopes, ...
    choices: list[dict[str, Any]] = field(default_factory=list)  # choose: {id, name, avatarUrl}
    pending: dict[str, Any] | None = None  # choose: the secret that holds the tokens of every choice
    gates: dict[str, str] = field(default_factory=dict)


# --- small HTTP helpers ------------------------------------------------------------------------------------------


def _form(data: dict[str, str]) -> bytes:
    return urlencode(data).encode()


FORM = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}


def _basic(keys: AppKeys) -> str:
    raw = f"{quote(keys.client_id, safe='')}:{quote(keys.client_secret, safe='')}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def call(env: OAuthEnv, request: HttpRequest) -> HttpResponse:
    try:
        return env.http(request)
    except NetworkError as e:
        raise Fail("platform_down") from e


def body(resp: HttpResponse) -> dict[str, Any]:
    found = resp.json()
    return found if isinstance(found, dict) else {}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


def _graph(env: OAuthEnv, path: str) -> str:
    return f"{GRAPH}/{env.graph_version}/{path.lstrip('/')}"


def _graph_get(env: OAuthEnv, path: str, token: str, secret: str, params: dict[str, str] | None = None) -> HttpResponse:
    query = dict(params or {})
    query["appsecret_proof"] = appsecret_proof(secret, token)
    return call(env, HttpRequest("GET", f"{_graph(env, path)}?{urlencode(query)}", _bearer(token)))


def _error_text(data: dict[str, Any]) -> str:
    error = data.get("error")
    parts = [str(data.get("error_description") or ""), str(data.get("message") or "")]
    if isinstance(error, dict):
        parts += [str(error.get("code") or ""), str(error.get("message") or ""), str(error.get("type") or "")]
    else:
        parts.append(str(error or ""))
    return " ".join(parts).lower()


def token_error(resp: HttpResponse) -> str:
    """The result code for a failed token request (§17.5 step 4)."""
    data = body(resp)
    text = _error_text(data)
    if resp.status >= 500:
        return "platform_down"
    if "redirect_uri" in text or "redirect uri" in text or "redirect_uri_mismatch" in text:
        return "redirect_wrong"
    if resp.status == 401 or "invalid_client" in text or "unauthorized_client" in text:
        return "keys_wrong"
    error = data.get("error")
    if isinstance(error, dict) and str(error.get("code")) in {"101", "1"}:
        return "keys_wrong"
    return "error"


def _expires_at(now: datetime, seconds: Any) -> str | None:
    if isinstance(seconds, bool) or not isinstance(seconds, int | float | str):
        return None
    try:
        value = int(seconds)
    except ValueError:
        return None
    return iso(now + timedelta(seconds=value)) if value > 0 else None


def _scope_list(raw: Any, sep: str) -> list[str]:
    return [s for s in str(raw or "").replace(",", " " if sep == " " else ",").split(sep) if s]


# --- authorize URLs ------------------------------------------------------------------------------------------------


def authorize_url(
    env: OAuthEnv, platform: str, keys: AppKeys, state: str, challenge: str | None, *, rerequest: bool = False
) -> str:
    redirect = env.redirect_uri(platform)
    if platform == "youtube":
        params = {
            "client_id": keys.client_id,
            "redirect_uri": redirect,
            "response_type": "code",
            "scope": " ".join(env.scopes["youtube"]),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
        }
        if challenge:
            params |= {"code_challenge": challenge, "code_challenge_method": "S256"}
        return f"{GOOGLE_AUTHORIZE}?{urlencode(params, quote_via=quote)}"
    if platform == "tiktok":
        params = {
            "client_key": keys.client_id,
            "response_type": "code",
            "scope": TIKTOK_SCOPES,
            "redirect_uri": redirect,
            "state": state,
            "disable_auto_auth": "1",
        }
        return f"{TIKTOK_AUTHORIZE}?{urlencode(params, quote_via=quote)}"
    if platform in {"instagram", "facebook"}:
        params = {
            "client_id": keys.client_id,
            "config_id": keys.config_id or "",
            "redirect_uri": redirect,
            "response_type": "code",
        }
        if platform == "instagram":
            params["override_default_response_type"] = "true"
        params["state"] = state
        if platform == "facebook" and rerequest:
            params["auth_type"] = "rerequest"
        return f"{META_DIALOG_HOST}/{env.graph_version}/dialog/oauth?{urlencode(params, quote_via=quote)}"
    if platform == "x":
        params = {
            "response_type": "code",
            "client_id": keys.client_id,
            "redirect_uri": redirect,
            "scope": X_SCOPES,
            "state": state,
        }
        if challenge:
            params |= {"code_challenge": challenge, "code_challenge_method": "S256"}
        return f"{X_AUTHORIZE}?{urlencode(params, quote_via=quote)}"
    raise ValueError(f"unknown platform: {platform}")


# --- Check it ------------------------------------------------------------------------------------------------------

CHECK_MESSAGES = {
    "keys_wrong": "The keys do not work. Copy them again from the developer website.",
    "redirect_wrong": "The return address does not match. Copy it again with the Copy button.",
    "not_connected": "Your keys work. Now press Connect {name}.",
    "token_dead": "Your keys work, but the connection stopped. Press Connect again.",
    "missing_permissions": "A permission box was not ticked. Press Connect again and tick every box.",
    "credits_empty": "Your X credits ran out. Buy more in Billing › Credits.",
    "platform_down": "{name} did not answer. Try again in a few minutes.",
}


def check_message(code: str, platform: str) -> str:
    return CHECK_MESSAGES.get(code, "Everything works.").format(name=label(platform))


def check_keys(env: OAuthEnv, platform: str, keys: AppKeys) -> tuple[str, str]:
    """``(code, message)`` for the app keys alone (no user token needed)."""
    name = label(platform)
    try:
        if platform == "youtube":
            data = {
                "grant_type": "authorization_code",
                "code": CHECK_CODE,
                "client_id": keys.client_id,
                "client_secret": keys.client_secret,
                "redirect_uri": env.redirect_uri(platform),
            }
            resp = call(env, HttpRequest("POST", GOOGLE_TOKEN, FORM, _form(data)))
            text = _error_text(body(resp))
            if resp.status >= 500:
                return "platform_down", check_message("platform_down", platform)
            if "redirect_uri" in text:
                return "redirect_wrong", check_message("redirect_wrong", platform)
            if "invalid_client" in text or resp.status == 401:
                return "keys_wrong", check_message("keys_wrong", platform)
            return "ok", f"Your {name} keys look right."
        if platform == "tiktok":
            data = {
                "client_key": keys.client_id,
                "client_secret": keys.client_secret,
                "grant_type": "client_credentials",
            }
            resp = call(env, HttpRequest("POST", TIKTOK_TOKEN, FORM, _form(data)))
            if resp.status >= 500:
                return "platform_down", check_message("platform_down", platform)
            if resp.status == 200 and body(resp).get("access_token"):
                return "ok", "Your TikTok keys work."
            return "keys_wrong", check_message("keys_wrong", platform)
        if platform in {"instagram", "facebook"}:
            form = {
                "client_id": keys.client_id,
                "client_secret": keys.client_secret,
                "grant_type": "client_credentials",
            }
            resp = call(env, HttpRequest("POST", _graph(env, "oauth/access_token"), FORM, _form(form)))
            if resp.status >= 500:
                return "platform_down", check_message("platform_down", platform)
            token = body(resp).get("access_token")
            if resp.status != 200 or not isinstance(token, str):
                return "keys_wrong", check_message("keys_wrong", platform)
            app = call(
                env,
                HttpRequest("GET", f"{_graph(env, quote(keys.client_id, safe=''))}?fields=name", _bearer(token)),
            )
            app_name = str(body(app).get("name") or "") if app.status == 200 else ""
            return "ok", f"Your keys work. Meta calls your app '{app_name}'." if app_name else "Your keys work."
        if platform == "x":
            data = {
                "grant_type": "authorization_code",
                "code": CHECK_CODE,
                "redirect_uri": env.redirect_uri(platform),
                "code_verifier": DUMMY_VERIFIER,
                "client_id": keys.client_id,
            }
            headers = {**FORM, "Authorization": _basic(keys)}
            resp = call(env, HttpRequest("POST", X_TOKEN, headers, _form(data)))
            if resp.status >= 500:
                return "platform_down", check_message("platform_down", platform)
            if resp.status == 401:
                return "keys_wrong", check_message("keys_wrong", platform)
            return "ok", "Your keys look right."
    except Fail as e:
        return e.code, check_message(e.code, platform)
    raise ValueError(f"unknown platform: {platform}")


def check_profile(env: OAuthEnv, platform: str, keys: AppKeys, token: dict[str, Any], access: str) -> str:
    """``ok`` | ``dead`` | ``credits_empty`` | ``platform_down`` for the connected account's token."""
    try:
        if platform == "youtube":
            resp = call(env, HttpRequest("GET", f"{YOUTUBE_CHANNELS}?part=id&mine=true", _bearer(access)))
        elif platform == "tiktok":
            resp = call(env, HttpRequest("GET", f"{TIKTOK_API}/v2/user/info/?fields=open_id", _bearer(access)))
            if resp.status == 200 and str((body(resp).get("error") or {}).get("code") or "ok") != "ok":
                return "dead"
        elif platform == "instagram":
            resp = _graph_get(
                env, str(token.get("igUserId") or "me"), access, keys.client_secret, {"fields": "username"}
            )
        elif platform == "facebook":
            resp = _graph_get(env, str(token.get("pageId") or "me"), access, keys.client_secret, {"fields": "name"})
        elif platform == "x":
            resp = call(env, HttpRequest("GET", X_ME, _bearer(access)))
            if resp.status == 402:
                return "credits_empty"
        else:
            raise ValueError(platform)
    except Fail:
        return "platform_down"
    if resp.status >= 500:
        return "platform_down"
    error = body(resp).get("error")
    if resp.status == 401 or (isinstance(error, dict) and str(error.get("code")) == "190"):
        return "dead"
    return "ok"


# --- code exchange (the callback) ---------------------------------------------------------------------------------


def exchange(
    env: OAuthEnv, platform: str, keys: AppKeys, code: str, *, redirect_uri: str, verifier: str | None
) -> Linked:
    now = env.clock()
    if platform == "youtube":
        return _youtube(env, keys, code, redirect=redirect_uri, verifier=verifier, now=now)
    if platform == "tiktok":
        return _tiktok(env, keys, code, redirect_uri, now)
    if platform == "instagram":
        return _instagram(env, keys, code, redirect_uri, now)
    if platform == "facebook":
        return _facebook(env, keys, code, redirect_uri)
    if platform == "x":
        return _x(env, keys, code, redirect=redirect_uri, verifier=verifier, now=now)
    raise Fail("error")


def _token_ok(resp: HttpResponse) -> dict[str, Any]:
    data = body(resp)
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        raise Fail(token_error(resp))
    return data


def _youtube(env: OAuthEnv, keys: AppKeys, code: str, *, redirect: str, verifier: str | None, now: datetime) -> Linked:
    form = {
        "code": code,
        "client_id": keys.client_id,
        "client_secret": keys.client_secret,
        "redirect_uri": redirect,
        "grant_type": "authorization_code",
    }
    if verifier:
        form["code_verifier"] = verifier
    data = _token_ok(call(env, HttpRequest("POST", GOOGLE_TOKEN, FORM, _form(form))))
    granted = set(_scope_list(data.get("scope"), " "))
    missing = [s for s in env.scopes["youtube"] if s not in granted]
    if missing:
        raise Fail("missing_permissions", ",".join(missing))
    access = str(data["access_token"])
    resp = call(env, HttpRequest("GET", f"{YOUTUBE_CHANNELS}?part=id,snippet&mine=true", _bearer(access)))
    if resp.status >= 500:
        raise Fail("platform_down")
    items = body(resp).get("items") or []
    if resp.status != 200 or not items or not isinstance(items[0], dict):
        raise Fail("no_channel" if resp.status == 200 else "error")
    channel = items[0]
    snippet = channel.get("snippet") or {}
    title = str(snippet.get("title") or "")
    handle = str(snippet.get("customUrl") or title)
    avatar = ((snippet.get("thumbnails") or {}).get("default") or {}).get("url")
    token = {
        "accessToken": access,
        "expiresAt": _expires_at(now, data.get("expires_in")),
        "refreshToken": data.get("refresh_token"),
        "scope": " ".join(sorted(granted)),
        "channelId": str(channel.get("id") or ""),
    }
    account = {
        "handle": handle,
        "name": title or handle,
        "avatarUrl": avatar if isinstance(avatar, str) else None,
        "accountId": str(channel.get("id") or ""),
        "scopes": sorted(granted),
    }
    return Linked("connected", token=token, account=account)


def creator_info(env: OAuthEnv, access: str) -> tuple[int, dict[str, Any]]:
    """``(status, body)`` of TikTok's ``creator_info/query`` (callers map errors with ``platforms.errors``)."""
    headers = {**_bearer(access), "Content-Type": "application/json; charset=UTF-8"}
    resp = call(env, HttpRequest("POST", TIKTOK_CREATOR, headers, b"{}"))
    return resp.status, body(resp)


def posting_audit(creator: dict[str, Any]) -> str:
    options = [str(o) for o in creator.get("privacy_level_options") or []]
    if not options:
        return "unknown"
    return "limited" if set(options) == {"SELF_ONLY"} else "ok"


def _tiktok(env: OAuthEnv, keys: AppKeys, code: str, redirect: str, now: datetime) -> Linked:
    form = {
        "client_key": keys.client_id,
        "client_secret": keys.client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect,
    }
    resp = call(env, HttpRequest("POST", TIKTOK_TOKEN, FORM, _form(form)))
    data = body(resp)
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        raise Fail(token_error(resp))
    granted = set(_scope_list(data.get("scope"), ","))
    missing = [s for s in TIKTOK_REQUIRED if s not in granted]
    if missing:
        raise Fail("missing_permissions", ",".join(missing))
    access = str(data["access_token"])
    info = call(env, HttpRequest("GET", TIKTOK_USER, _bearer(access)))
    if info.status >= 500:
        raise Fail("platform_down")
    user = (body(info).get("data") or {}).get("user") or {}
    status, creator_body = creator_info(env, access)
    creator = obj(creator_body.get("data"))
    username = str(creator.get("creator_username") or "")
    nickname = str(creator.get("creator_nickname") or user.get("display_name") or username)
    refresh_seconds = int(data.get("refresh_expires_in") or 0)
    refresh_at = now + timedelta(seconds=refresh_seconds) if refresh_seconds else None
    token = {
        "accessToken": access,
        "expiresAt": _expires_at(now, data.get("expires_in")),
        "refreshToken": data.get("refresh_token"),
        "refreshExpiresAt": iso(refresh_at) if refresh_at else None,
        "openId": str(data.get("open_id") or user.get("open_id") or ""),
        "username": username,
        "scope": ",".join(sorted(granted)),
    }
    account: dict[str, Any] = {
        "handle": f"@{username}" if username else nickname,
        "name": nickname,
        "avatarUrl": creator.get("creator_avatar_url") or user.get("avatar_url"),
        "accountId": token["openId"],
        "scopes": sorted(granted),
    }
    if refresh_at is not None:
        account["reconnectBy"] = iso(refresh_at - REFRESH_WARN)
        if refresh_at - now < REFRESH_WARN:
            account["reason"] = "expires_soon"
    gates = {"posting_audit": posting_audit(creator) if status == 200 else "unknown"}
    return Linked("connected", token=token, account=account, gates=gates)


def _meta_token(env: OAuthEnv, keys: AppKeys, code: str, redirect: str) -> dict[str, Any]:
    form = {"client_id": keys.client_id, "client_secret": keys.client_secret, "code": code, "redirect_uri": redirect}
    resp = call(env, HttpRequest("POST", _graph(env, "oauth/access_token"), FORM, _form(form)))
    data = body(resp)
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        raise Fail(token_error(resp))
    return data


def _meta_error(resp: HttpResponse) -> str:
    error = body(resp).get("error")
    code = str(error.get("code")) if isinstance(error, dict) else ""
    if resp.status >= 500:
        return "platform_down"
    if code == "10":
        return "wrong_account_type"
    return "error"


def _long_lived(env: OAuthEnv, keys: AppKeys, short: str) -> str:
    """Swap the short user token of the code exchange for a long-lived one (POST, form body)."""
    form = {
        "grant_type": "fb_exchange_token",
        "client_id": keys.client_id,
        "client_secret": keys.client_secret,
        "fb_exchange_token": short,
    }
    resp = call(env, HttpRequest("POST", _graph(env, "oauth/access_token"), FORM, _form(form)))
    user_token = str(body(resp).get("access_token") or "") if resp.status == 200 else ""
    if not user_token:
        raise Fail(token_error(resp))
    return user_token


IG_PAGE_FIELDS = "id,name,access_token,instagram_business_account{id,username,profile_picture_url}"


def _instagram(env: OAuthEnv, keys: AppKeys, code: str, redirect: str, now: datetime) -> Linked:
    """Facebook Login for Business with a user access token: every Page with a linked Instagram professional
    account is a choice; its Page token publishes and reads stats (the user token is never stored)."""
    data = _meta_token(env, keys, code, redirect)
    user_token = _long_lived(env, keys, str(data["access_token"]))
    secret = keys.client_secret
    me = _graph_get(env, "me", user_token, secret, {"fields": "id"})
    user_id = str(body(me).get("id") or "") if me.status == 200 else ""
    pages = _graph_get(env, "me/accounts", user_token, secret, {"fields": IG_PAGE_FIELDS})
    if pages.status != 200:
        raise Fail(_meta_error(pages))
    rows = [
        p
        for p in body(pages).get("data") or []
        if isinstance(p, dict)
        and p.get("id")
        and p.get("access_token")
        and isinstance(p.get("instagram_business_account"), dict)
        and p["instagram_business_account"].get("id")
    ]
    if not rows:
        raise Fail("no_accounts")
    choices: list[dict[str, Any]] = []
    tokens: dict[str, str] = {}
    page_ids: dict[str, str] = {}
    for p in rows:
        ig = p["instagram_business_account"]
        ig_id = str(ig["id"])
        if ig_id in tokens:
            continue
        username = ig.get("username")
        choices.append(
            {"id": ig_id, "name": f"@{username}" if username else ig_id, "avatarUrl": ig.get("profile_picture_url")}
        )
        tokens[ig_id] = str(p["access_token"])
        page_ids[ig_id] = str(p["id"])
    scopes = list(env.scopes["instagram"])
    if len(choices) > 1:
        pending = {"userId": user_id, "choices": choices, "tokens": tokens, "pages": page_ids}
        return Linked("choose", choices=choices, pending=pending)
    choice = choices[0]
    return Linked(
        "connected",
        token=_ig_token(choice["id"], page_ids[choice["id"]], tokens[choice["id"]], user_id),
        account=_ig_account(choice, scopes),
    )


def _ig_token(ig_user_id: str, page_id: str, page_token: str, user_id: Any) -> dict[str, Any]:
    return {"pageAccessToken": page_token, "pageId": page_id, "igUserId": ig_user_id, "userId": user_id}


def _ig_account(choice: dict[str, Any], scopes: list[str]) -> dict[str, Any]:
    return {
        "handle": choice["name"],
        "name": choice["name"],
        "avatarUrl": choice.get("avatarUrl"),
        "accountId": choice["id"],
        "scopes": scopes,
    }


def _facebook(env: OAuthEnv, keys: AppKeys, code: str, redirect: str) -> Linked:
    data = _meta_token(env, keys, code, redirect)
    user_token = _long_lived(env, keys, str(data["access_token"]))
    secret = keys.client_secret
    perms = _graph_get(env, "me/permissions", user_token, secret)
    if perms.status != 200:
        raise Fail(_meta_error(perms))
    declined = [
        str(p.get("permission"))
        for p in body(perms).get("data") or []
        if isinstance(p, dict) and p.get("status") != "granted"
    ]
    if declined:
        raise Fail("missing_permissions", ",".join(declined))
    me = _graph_get(env, "me", user_token, secret, {"fields": "id"})
    user_id = str(body(me).get("id") or "") if me.status == 200 else ""
    pages = _graph_get(env, "me/accounts", user_token, secret, {"fields": "id,name,access_token,tasks,picture{url}"})
    if pages.status != 200:
        raise Fail(_meta_error(pages))
    usable = [
        p
        for p in body(pages).get("data") or []
        if isinstance(p, dict) and p.get("id") and p.get("access_token") and "CREATE_CONTENT" in (p.get("tasks") or [])
    ]
    if not usable:
        raise Fail("no_pages")
    choices = [
        {
            "id": str(p["id"]),
            "name": str(p.get("name") or p["id"]),
            "avatarUrl": ((p.get("picture") or {}).get("data") or {}).get("url"),
        }
        for p in usable
    ]
    tokens = {str(p["id"]): str(p["access_token"]) for p in usable}
    scopes = list(env.scopes["facebook"])
    if len(usable) > 1:
        return Linked("choose", choices=choices, pending={"userId": user_id, "choices": choices, "tokens": tokens})
    choice = choices[0]
    token = {"pageAccessToken": tokens[str(choice["id"])], "pageId": choice["id"], "userId": user_id}
    return Linked("connected", token=token, account=_page_account(choice, scopes))


def _page_account(choice: dict[str, Any], scopes: list[str]) -> dict[str, Any]:
    return {
        "handle": choice["name"],
        "name": choice["name"],
        "avatarUrl": choice.get("avatarUrl"),
        "accountId": choice["id"],
        "scopes": scopes,
    }


def chosen(platform: str, pending: dict[str, Any], choice_id: str, scopes: list[str]) -> Linked:
    """The token and account of one Meta choice (POST /v1/accounts/{platform}/choose)."""
    choice = next((c for c in pending.get("choices") or [] if c.get("id") == choice_id), None)
    if choice is None:
        raise Fail("error")
    page_token = (pending.get("tokens") or {}).get(choice_id)
    if not page_token:
        raise Fail("error")
    if platform == "instagram":
        page_id = (pending.get("pages") or {}).get(choice_id)
        if not page_id:
            raise Fail("error")
        token = _ig_token(choice_id, str(page_id), str(page_token), pending.get("userId"))
        return Linked("connected", token=token, account=_ig_account(choice, scopes))
    token = {"pageAccessToken": page_token, "pageId": choice_id, "userId": pending.get("userId")}
    return Linked("connected", token=token, account=_page_account(choice, scopes))


def _x(env: OAuthEnv, keys: AppKeys, code: str, *, redirect: str, verifier: str | None, now: datetime) -> Linked:
    form = {"code": code, "grant_type": "authorization_code", "redirect_uri": redirect, "client_id": keys.client_id}
    if verifier:
        form["code_verifier"] = verifier
    headers = {**FORM, "Authorization": _basic(keys)}
    data = _token_ok(call(env, HttpRequest("POST", X_TOKEN, headers, _form(form))))
    granted = set(_scope_list(data.get("scope"), " "))
    missing = [s for s in X_REQUIRED if s not in granted]
    if missing:
        raise Fail("missing_permissions", ",".join(missing))
    access = str(data["access_token"])
    me = call(env, HttpRequest("GET", X_ME, _bearer(access)))
    if me.status >= 500:
        raise Fail("platform_down")
    user = body(me).get("data") or {}
    if me.status != 200 or not user.get("id"):
        raise Fail("error")
    username = str(user.get("username") or "")
    token = {
        "accessToken": access,
        "expiresAt": _expires_at(now, data.get("expires_in")),
        "refreshToken": data.get("refresh_token"),
        "xUserId": str(user["id"]),
        "username": username,
        "scope": " ".join(sorted(granted)),
    }
    account = {
        "handle": f"@{username}" if username else str(user.get("name") or ""),
        "name": str(user.get("name") or username),
        "avatarUrl": user.get("profile_image_url"),
        "accountId": str(user["id"]),
        "scopes": sorted(granted),
    }
    return Linked("connected", token=token, account=account)


# --- refresh and revoke -------------------------------------------------------------------------------------------


def refresh(env: OAuthEnv, platform: str, keys: AppKeys, token: dict[str, Any]) -> dict[str, Any]:
    """The token secret after a refresh (rotating refresh tokens replaced). ``Dead`` when the platform refuses the
    refresh token; ``Fail("platform_down")`` when it does not answer."""
    now = env.clock()
    refresh_token = str(token.get("refreshToken") or "")
    if not refresh_token:
        raise Dead("no refresh token")
    if platform == "youtube":
        form = {
            "grant_type": "refresh_token",
            "client_id": keys.client_id,
            "client_secret": keys.client_secret,
            "refresh_token": refresh_token,
        }
        resp = call(env, HttpRequest("POST", GOOGLE_TOKEN, FORM, _form(form)))
    elif platform == "tiktok":
        form = {
            "client_key": keys.client_id,
            "client_secret": keys.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
        resp = call(env, HttpRequest("POST", TIKTOK_TOKEN, FORM, _form(form)))
    elif platform == "x":
        form = {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": keys.client_id}
        resp = call(env, HttpRequest("POST", X_TOKEN, {**FORM, "Authorization": _basic(keys)}, _form(form)))
    else:
        raise ValueError(f"{platform} tokens do not refresh")
    data = body(resp)
    if resp.status in (408, 429) or resp.status >= 500:
        # Busy or slow is not a dead token: keep the account and let the step retry later.
        raise Fail("platform_down")
    if resp.status != 200 or not isinstance(data.get("access_token"), str):
        log("warning", "oauth.refresh_refused", platform=platform, status=resp.status)
        raise Dead(token_error(resp))
    out = dict(token)
    out["accessToken"] = data["access_token"]
    out["expiresAt"] = _expires_at(now, data.get("expires_in"))
    if data.get("refresh_token"):
        out["refreshToken"] = data["refresh_token"]
    if platform == "tiktok" and data.get("refresh_expires_in"):
        out["refreshExpiresAt"] = _expires_at(now, data.get("refresh_expires_in"))
    if data.get("scope"):
        out["scope"] = data["scope"]
    return out


def revoke(env: OAuthEnv, platform: str, keys: AppKeys | None, token: dict[str, Any]) -> None:
    """Best effort: the token secret is deleted either way."""
    try:
        if platform == "youtube":
            value = str(token.get("refreshToken") or token.get("accessToken") or "")
            if value:
                call(env, HttpRequest("POST", GOOGLE_REVOKE, FORM, _form({"token": value})))
        elif platform == "tiktok" and keys is not None and token.get("accessToken"):
            form = {
                "client_key": keys.client_id,
                "client_secret": keys.client_secret,
                "token": str(token["accessToken"]),
            }
            call(env, HttpRequest("POST", TIKTOK_REVOKE, FORM, _form(form)))
        elif platform == "x" and keys is not None:
            value = str(token.get("refreshToken") or token.get("accessToken") or "")
            hint = "refresh_token" if token.get("refreshToken") else "access_token"
            if value:
                form = {"token": value, "token_type_hint": hint, "client_id": keys.client_id}
                call(env, HttpRequest("POST", X_REVOKE, {**FORM, "Authorization": _basic(keys)}, _form(form)))
        # Instagram and Facebook: only a Page token is kept, which cannot revoke the app; removing the app in
        # Facebook's Business Integrations settings is the owner's own step.
    except Exception as e:
        log("warning", "oauth.revoke_failed", platform=platform, error=type(e).__name__)
