"""/v1/follows: Settings › Clip making › Streamers I follow (docs/CONTRACTS.md §24.1).

* GET: the owner's follows, the key slots (Twitch, Kick, YouTube read key) and the Kick webhook address.
* POST /lookup ``{text, platform?}``: what was typed, looked up (parse only, fixed platform hosts: §24.4).
* POST ``{platform, platformId, permission: true}``: follow, after "Yes, they said I can".
* PATCH /{platform}/{platformId} ``{autoClips}``; DELETE /{platform}/{platformId}: unfollow (only this owner's items).
* PUT, DELETE /keys/{platform} and POST /keys/{platform}/check: the keys (Secrets Manager only, masked hints back).
"""

from __future__ import annotations

from typing import Any

from .. import validate
from ..app import App
from ..errors import bad_request, not_found
from ..follow import KEY_PLATFORMS, PLATFORMS, all_follows, is_platform_id, keys, model, normal_id, public_follow
from ..follow import platforms as pf
from ..follow.parse import parse
from ..http import Request, Response, no_content, ok
from ..platforms.base import urllib_client

NOT_FOLLOWED = "You do not follow that streamer any more. Reload the page."


def env(app: App) -> pf.FollowEnv:
    if app.follow is None:
        secrets = app.oauth.secrets if app.oauth is not None else None
        hooks_url = app.oauth.hooks_url if app.oauth is not None else ""
        http = app.oauth.http if app.oauth is not None else urllib_client
        app.follow = pf.FollowEnv(secrets=secrets, http=http, hooks_url=hooks_url, clock=app.clock)
    return app.follow


def _creator(req: Request) -> tuple[str, str]:
    platform = req.params["platform"]
    platform_id = req.params["platformId"]
    if platform not in PLATFORMS or not is_platform_id(platform, platform_id):
        raise not_found(NOT_FOLLOWED)
    return platform, normal_id(platform, platform_id)


def _key_platform(req: Request) -> str:
    platform = req.params["platform"]
    if platform not in KEY_PLATFORMS:
        raise not_found("We do not use keys for that.")
    return platform


def _view(app: App, req: Request) -> dict[str, Any]:
    e = env(app)
    follows = sorted(all_follows(app.store, req.user_id), key=lambda f: str(f.get("followedAt") or ""))
    return {
        "follows": [public_follow(f) for f in follows],
        "keys": keys.overview(app.store, e, req.user_id),
        "kickWebhookUrl": e.callback("kick"),
    }


def list_follows(app: App, req: Request) -> Response:
    return ok(_view(app, req))


def lookup(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, ("text", "platform"))
    wanted = parse(body.get("text"), body.get("platform"))
    if not wanted.platform:
        return ok({"needsPlatform": True, "name": wanted.value})
    return ok({"needsPlatform": False, "creator": model.lookup(env(app), wanted)})


def create(app: App, req: Request) -> Response:
    body = req.json()
    validate.only_keys(body, ("platform", "platformId", "permission"))
    platform = body.get("platform")
    platform_id = body.get("platformId")
    if platform not in PLATFORMS:
        raise bad_request("Pick YouTube, Twitch or Kick.", "platform")
    if not isinstance(platform_id, str) or not is_platform_id(platform, platform_id):
        raise bad_request("Find the streamer first.", "platformId")
    if body.get("permission") is not True:
        raise bad_request(
            "Clip Factory follows a streamer only when they said you can make clips of their videos.", "permission"
        )
    follow = model.follow(app.store, env(app), req.user_id, platform, normal_id(platform, platform_id), now=app.clock())
    return ok({"follow": follow}, 201)


def patch(app: App, req: Request) -> Response:
    platform, platform_id = _creator(req)
    body = req.json()
    validate.only_keys(body, ("autoClips",))
    on = validate.boolean(body.get("autoClips"), "autoClips")
    return ok({"follow": model.set_auto(app.store, req.user_id, platform, platform_id, on)})


def delete(app: App, req: Request) -> Response:
    platform, platform_id = _creator(req)
    if not model.unfollow(app.store, req.user_id, platform, platform_id):
        raise not_found(NOT_FOLLOWED)
    return no_content()


def put_keys(app: App, req: Request) -> Response:
    platform = _key_platform(req)
    values = keys.clean(platform, req.json())
    keys.save(app.store, env(app), req.user_id, platform, values=values, now=app.clock())
    return ok(_view(app, req))


def delete_keys(app: App, req: Request) -> Response:
    platform = _key_platform(req)
    keys.remove(app.store, env(app), req.user_id, platform, app.clock())
    return no_content()


def check_keys(app: App, req: Request) -> Response:
    platform = _key_platform(req)
    result = keys.check(app.store, env(app), req.user_id, platform, app.clock())
    return ok({"check": result, **_view(app, req)})
