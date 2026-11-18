"""Follow creators, part 1 (docs/CONTRACTS.md §24): parsing (no SSRF), signatures, webhooks, routes, keys, the tick
and the live push. No job is ever started here."""

from __future__ import annotations

import base64
import hashlib
import json
import random
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from clipfactory_api import db, hooks, settings
from clipfactory_api.app import App
from clipfactory_api.errors import ApiError
from clipfactory_api.follow import (
    CREATOR_PK,
    FOLLOWED_PK,
    WATCH_PK,
    creator_keys,
    follow_sk,
    public_follow,
    round_viewers,
    safe_avatar,
    signatures,
    tick,
    webhooks,
)
from clipfactory_api.follow import platforms as pf
from clipfactory_api.follow.parse import Wanted, parse
from clipfactory_api.oauth.secrets import Secrets
from clipfactory_api.platforms import HttpResponse
from clipfactory_api.realtime import broadcast
from conftest import NOW, USER, Call, Clock
from fakes import FakeSecretsManager, FakeSSM

PREFIX = "cf-prod/platforms/"
TWITCH_ID = "abcdefghijklmnopqrstuvwxyz0123"
TWITCH_SECRET = "zyxwvutsrqponmlkjihgfedcba9876"
EVENTSUB = "e" * 64
YT_CHANNEL = "UCabcdefghijklmnopqrstuv"
YT_KEY = "AIza" + "x" * 35


# --- a small router standing in for the platforms ----------------------------------------------------------------------


class RouteHttp:
    """Answers by URL prefix (longest first) and records every request. A handler gets the request."""

    def __init__(self) -> None:
        self.routes: dict[str, Callable[[Any], tuple[int, Any]]] = {}
        self.calls: list[Any] = []

    def on(self, prefix: str, answer: Any) -> None:
        self.routes[prefix] = answer if callable(answer) else (lambda _r, a=answer: a)

    def __call__(self, request: Any) -> HttpResponse:
        self.calls.append(request)
        for prefix in sorted(self.routes, key=len, reverse=True):
            if request.url.startswith(prefix):
                status, body = self.routes[prefix](request)
                raw = body if isinstance(body, bytes) else json.dumps(body).encode()
                return HttpResponse(status, {}, raw)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    def urls(self, prefix: str = "") -> list[str]:
        return [c.url for c in self.calls if c.url.startswith(prefix)]


def twitch_routes(http: RouteHttp, *, live: dict[str, Any] | None = None) -> None:
    http.on(pf.TWITCH_TOKEN_URL, (200, {"access_token": "app-token-1", "expires_in": 5000}))

    def users(req: Any) -> tuple[int, Any]:
        logins = parse_qs(urlsplit(req.url).query).get("login", [])
        rows = [
            {
                "id": f"9{len(x)}",
                "login": x,
                "display_name": x.title(),
                "profile_image_url": "https://static-cdn.jtvnw.net/a.png",
            }
            for x in logins
            if x != "nobodyhere"
        ]
        return 200, {"data": rows}

    def streams(req: Any) -> tuple[int, Any]:
        logins = parse_qs(urlsplit(req.url).query).get("user_login", [])
        rows = [dict(live[x], user_login=x, type="live") for x in logins if live and x in live]
        return 200, {"data": rows}

    subs: list[str] = []

    def subscribe(req: Any) -> tuple[int, Any]:
        if req.method == "GET":
            return 200, {"data": [{"id": s, "status": "enabled"} for s in subs], "pagination": {}}
        if req.method == "DELETE":
            return 204, b""
        body = json.loads(req.body)
        assert body["transport"]["secret"] == EVENTSUB
        assert body["transport"]["callback"].endswith("/hooks/twitch")
        subs.append(f"sub-{len(subs) + 1}")
        return 202, {"data": [{"id": subs[-1], "status": "webhook_callback_verification_pending"}]}

    http.on(f"{pf.TWITCH_API}/users", users)
    http.on(f"{pf.TWITCH_API}/streams", streams)
    http.on(f"{pf.TWITCH_API}/eventsub/subscriptions", subscribe)


@pytest.fixture
def follow_sm() -> FakeSecretsManager:
    return FakeSecretsManager()


@pytest.fixture
def rhttp() -> RouteHttp:
    return RouteHttp()


@pytest.fixture
def fenv(follow_sm: FakeSecretsManager, rhttp: RouteHttp, clock: Clock) -> pf.FollowEnv:
    return pf.FollowEnv(
        secrets=Secrets(follow_sm, PREFIX),
        http=rhttp,
        hooks_url="https://abc123.execute-api.eu-north-1.amazonaws.com/v1",
        clock=clock,
    )


@pytest.fixture
def fapp(app: App, fenv: pf.FollowEnv) -> App:
    app.follow = fenv
    return app


def save_twitch_keys(follow_sm: FakeSecretsManager) -> None:
    follow_sm.values[f"{PREFIX}twitch/app"] = json.dumps({"clientId": TWITCH_ID, "clientSecret": TWITCH_SECRET})
    follow_sm.values[f"{PREFIX}twitch/eventsub"] = json.dumps({"secret": EVENTSUB})


# --- parsing: links and names, never fetched ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "platform", "expected"),
    [
        ("https://www.twitch.tv/SomeStreamer", None, Wanted("twitch", "login", "somestreamer")),
        ("twitch.tv/some_streamer/videos", None, Wanted("twitch", "login", "some_streamer")),
        ("https://kick.com/Trainwreck-1", None, Wanted("kick", "slug", "trainwreck-1")),
        ("https://www.youtube.com/@CoolChannel", None, Wanted("youtube", "handle", "@CoolChannel")),
        (f"https://www.youtube.com/channel/{YT_CHANNEL}", None, Wanted("youtube", "channel", YT_CHANNEL)),
        ("https://youtu.be/dQw4w9WgXcQ", None, Wanted("youtube", "video", "dQw4w9WgXcQ")),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", None, Wanted("youtube", "video", "dQw4w9WgXcQ")),
        ("https://www.youtube.com/live/dQw4w9WgXcQ", None, Wanted("youtube", "video", "dQw4w9WgXcQ")),
        ("SomeStreamer", None, Wanted("", "name", "SomeStreamer")),
        ("@SomeStreamer", "twitch", Wanted("twitch", "login", "somestreamer")),
        ("CoolChannel", "youtube", Wanted("youtube", "handle", "@CoolChannel")),
        ("xQc", "kick", Wanted("kick", "slug", "xqc")),
    ],
)
def test_parse_reads_links_and_names(text: str, platform: str | None, expected: Wanted) -> None:
    assert parse(text, platform) == expected


@pytest.mark.parametrize(
    "text",
    [
        "https://evil.example.com/someone",
        "https://twitch.tv.evil.example/someone",
        "https://user:pass@twitch.tv/someone",
        "https://twitch.tv:8443/someone",
        "ftp://twitch.tv/someone",
        "http://169.254.169.254/latest/meta-data",
        "https://127.0.0.1/someone",
        "https://www.twitch.tv/videos/12345",
        "https://www.twitch.tv/a",
        "https://www.youtube.com/c/OldName",
        "https://kick.com/",
        "x" * 400,
        "not a name!",
        "",
    ],
)
def test_parse_refuses_other_hosts_user_info_ports_and_bad_ids(text: str) -> None:
    with pytest.raises(ApiError) as e:
        parse(text, None)
    assert e.value.status == 400


def test_parse_refuses_an_unknown_platform() -> None:
    with pytest.raises(ApiError):
        parse("someone", "tiktok")


def test_avatars_only_from_the_platforms_picture_hosts() -> None:
    assert safe_avatar("https://static-cdn.jtvnw.net/jtv_user_pictures/a.png")
    assert safe_avatar("https://yt3.ggpht.com/abc=s88")
    assert safe_avatar("https://files.kick.com/images/a.webp")
    assert safe_avatar("https://images.kick.com/a.webp")
    for bad in (
        "http://static-cdn.jtvnw.net/a.png",
        "https://evil.example/a.png",
        "https://x@yt3.ggpht.com/a",
        "javascript:alert(1)",
        5,
    ):
        assert safe_avatar(bad) == ""


def test_viewers_are_rounded_to_two_figures() -> None:
    assert [round_viewers(n) for n in (0, 42, 99, 123, 1234, 98765, -1, True, "5")] == [
        0,
        42,
        99,
        120,
        1200,
        99000,
        None,
        None,
        None,
    ]


def test_creator_keys_join_the_lessons_keys() -> None:
    assert creator_keys("youtube", YT_CHANNEL, "@Cool", "Cool Channel") == [
        f"youtube:id:{YT_CHANNEL}",
        "youtube:name:cool channel",
        "youtube:name:cool",
    ]
    assert creator_keys("twitch", "somestreamer", "somestreamer", "SomeStreamer") == [
        "twitch:id:somestreamer",
        "twitch:name:somestreamer",
    ]


# --- signatures ---------------------------------------------------------------------------------------------------------------


def test_twitch_signature_good_bad_and_stale() -> None:
    body = b'{"x":1}'
    ts = "2026-11-15T11:59:00.123456789Z"
    sig = signatures.twitch_signature(EVENTSUB, "m1", ts, body)
    assert signatures.twitch_valid(EVENTSUB, "m1", ts, body, signature=sig, now=NOW)
    assert not signatures.twitch_valid(EVENTSUB, "m1", ts, body + b" ", signature=sig, now=NOW)
    assert not signatures.twitch_valid("other", "m1", ts, body, signature=sig, now=NOW)
    assert not signatures.twitch_valid(EVENTSUB, "m1", ts, body, signature=sig, now=NOW + timedelta(minutes=11))
    assert not signatures.twitch_valid("", "m1", ts, body, signature=sig, now=NOW)


def _is_prime(n: int, rng: random.Random) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(20):
        x = pow(rng.randrange(2, n - 2), d, n)
        if x in {1, n - 1}:
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits: int, rng: random.Random) -> int:
    while True:
        candidate = rng.getrandbits(bits) | (3 << (bits - 2)) | 1
        if _is_prime(candidate, rng):
            return candidate


def _der_len(n: int) -> bytes:
    if n < 128:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _der(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + _der_len(len(value)) + value


def _der_int(n: int) -> bytes:
    raw = n.to_bytes((n.bit_length() + 8) // 8, "big")
    return _der(0x02, raw)


class RsaKey:
    """A throwaway 1024-bit RSA key made with the standard library (test only)."""

    def __init__(self, seed: int = 7) -> None:
        rng = random.Random(seed)
        e = 65537
        while True:
            p, q = _prime(512, rng), _prime(512, rng)
            phi = (p - 1) * (q - 1)
            if p != q and phi % e:
                break
        self.n, self.e, self.d = p * q, e, pow(e, -1, phi)

    def pem(self) -> str:
        rsa = _der(0x30, _der_int(self.n) + _der_int(self.e))
        alg = _der(0x30, _der(0x06, bytes.fromhex("2a864886f70d010101")) + b"\x05\x00")
        spki = _der(0x30, alg + _der(0x03, b"\x00" + rsa))
        b64 = base64.b64encode(spki).decode()
        return (
            "-----BEGIN PUBLIC KEY-----\n"
            + "\n".join(b64[i : i + 64] for i in range(0, len(b64), 64))
            + "\n-----END PUBLIC KEY-----\n"
        )

    def sign(self, message: bytes) -> str:
        k = (self.n.bit_length() + 7) // 8
        t = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(message).digest()
        em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
        return base64.b64encode(pow(int.from_bytes(em, "big"), self.d, self.n).to_bytes(k, "big")).decode()


@pytest.fixture(scope="module")
def kick_key() -> RsaKey:
    return RsaKey()


def test_kick_rsa_good_bad_and_stale(kick_key: RsaKey) -> None:
    key = signatures.load_public_key(kick_key.pem())
    ts = "2026-11-15T11:58:00Z"
    body = b'{"is_live":true}'
    sig = kick_key.sign(f"m1.{ts}.".encode() + body)
    assert signatures.kick_valid(key, "m1", ts, body, signature=sig, now=NOW)
    assert not signatures.kick_valid(key, "m2", ts, body, signature=sig, now=NOW)
    assert not signatures.kick_valid(key, "m1", ts, body + b"x", signature=sig, now=NOW)
    assert not signatures.kick_valid(key, "m1", ts, body, signature="not base64!", now=NOW)
    assert not signatures.kick_valid(key, "m1", ts, body, signature=sig, now=NOW + timedelta(minutes=12))


def test_public_key_reader_refuses_junk() -> None:
    for junk in ("", "hello", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"):
        with pytest.raises(signatures.PublicKeyError):
            signatures.load_public_key(junk)


# --- webhooks -------------------------------------------------------------------------------------------------------------------


def _hook(platform: str, body: bytes, headers: dict[str, str], method: str = "POST") -> dict[str, Any]:
    return {
        "httpMethod": method,
        "resource": "/hooks/{platform}",
        "path": f"/hooks/{platform}",
        "pathParameters": {"platform": platform},
        "headers": headers,
        "body": body.decode(),
        "isBase64Encoded": False,
        "requestContext": {"requestId": "rest-1", "stage": "v1"},
    }


def _twitch_headers(
    kind: str, body: bytes, *, message: str = "m1", ts: str = "2026-11-15T11:59:30Z", sub: str = ""
) -> dict[str, str]:
    headers = {
        "Twitch-Eventsub-Message-Id": message,
        "Twitch-Eventsub-Message-Timestamp": ts,
        "Twitch-Eventsub-Message-Type": kind,
        "Twitch-Eventsub-Message-Signature": signatures.twitch_signature(EVENTSUB, message, ts, body),
    }
    if sub:
        headers["Twitch-Eventsub-Subscription-Type"] = sub
    return headers


@pytest.fixture
def hook_deps(store: db.Store, fenv: pf.FollowEnv, rhttp: RouteHttp, kick_key: RsaKey) -> hooks.HooksDeps:
    rhttp.on(f"{pf.KICK_API}/public-key", (200, {"data": {"public_key": kick_key.pem()}}))
    return hooks.HooksDeps(
        store=store,
        app_url="https://d111111abcdef8.cloudfront.net",
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=Clock(),
        follow=fenv,
        kick_keys=webhooks.KickKeys(rhttp),
    )


def _follow_item(store: db.Store, platform: str, platform_id: str, user: str = USER, **fields: Any) -> None:
    store.put(
        {
            "pk": db.user_pk(user),
            "sk": follow_sk(platform, platform_id),
            "type": "follow",
            "followId": f"{platform}:{platform_id}",
            "userId": user,
            "platform": platform,
            "platformId": platform_id,
            "handle": platform_id,
            "name": platform_id,
            "autoClips": True,
            "followedAt": "2026-11-15T10:00:00.000Z",
            "permissionAt": "2026-11-15T10:00:00.000Z",
            "resolved": True,
            **fields,
        }
    )
    store.put(
        {
            "pk": FOLLOWED_PK,
            "sk": f"{platform}#{platform_id}#{user}",
            "type": "followed",
            "userId": user,
            "platform": platform,
            "platformId": platform_id,
        }
    )


def test_twitch_without_a_secret_is_refused_and_nothing_is_stored(hook_deps: hooks.HooksDeps, table: Any) -> None:
    body = b'{"challenge":"abc"}'
    out = hooks.handle(_hook("twitch", body, _twitch_headers("webhook_callback_verification", body)), hook_deps)
    assert out["statusCode"] == 401
    assert table.all() == []


def test_twitch_verification_post_echoes_the_challenge_as_text(
    hook_deps: hooks.HooksDeps, follow_sm: FakeSecretsManager
) -> None:
    save_twitch_keys(follow_sm)
    body = json.dumps({"challenge": "pogchamp-kappa-360noscope", "subscription": {"type": "stream.online"}}).encode()
    out = hooks.handle(_hook("twitch", body, _twitch_headers("webhook_callback_verification", body)), hook_deps)
    assert out["statusCode"] == 200
    assert out["body"] == "pogchamp-kappa-360noscope"
    assert out["headers"]["content-type"].startswith("text/plain")


def test_twitch_bad_or_stale_signature_is_401(
    hook_deps: hooks.HooksDeps, follow_sm: FakeSecretsManager, table: Any
) -> None:
    save_twitch_keys(follow_sm)
    body = b'{"challenge":"abc"}'
    headers = _twitch_headers("webhook_callback_verification", body)
    headers["Twitch-Eventsub-Message-Signature"] = "sha256=" + "0" * 64
    assert hooks.handle(_hook("twitch", body, headers), hook_deps)["statusCode"] == 401
    stale = _twitch_headers("webhook_callback_verification", body, ts="2026-11-15T11:00:00Z")
    assert hooks.handle(_hook("twitch", body, stale), hook_deps)["statusCode"] == 401
    assert table.all() == []


def test_twitch_online_then_offline_updates_every_follower_and_notices_the_stream(
    hook_deps: hooks.HooksDeps, follow_sm: FakeSecretsManager, store: db.Store, table: Any
) -> None:
    save_twitch_keys(follow_sm)
    _follow_item(store, "twitch", "somestreamer")
    _follow_item(store, "twitch", "somestreamer", user="other-user")
    online = json.dumps(
        {
            "subscription": {"type": "stream.online"},
            "event": {
                "id": "4242",
                "broadcaster_user_id": "1337",
                "broadcaster_user_login": "somestreamer",
                "type": "live",
                "started_at": "2026-11-15T11:00:00Z",
            },
        }
    ).encode()
    out = hooks.handle(
        _hook("twitch", online, _twitch_headers("notification", online, message="on1", sub="stream.online")), hook_deps
    )
    assert out["statusCode"] == 200
    mine = store.get(db.user_pk(USER), follow_sk("twitch", "somestreamer"))
    assert mine
    assert mine["live"]["isLive"] is True
    assert mine["live"]["streamId"] == "4242"
    assert store.get(db.user_pk("other-user"), follow_sk("twitch", "somestreamer"))["live"]["isLive"] is True  # type: ignore[index]
    # The same delivery again does nothing more.
    again = hooks.handle(
        _hook("twitch", online, _twitch_headers("notification", online, message="on1", sub="stream.online")), hook_deps
    )
    assert again["statusCode"] == 200
    offline = json.dumps(
        {
            "subscription": {"type": "stream.offline"},
            "event": {"broadcaster_user_id": "1337", "broadcaster_user_login": "somestreamer"},
        }
    ).encode()
    hooks.handle(
        _hook("twitch", offline, _twitch_headers("notification", offline, message="off1", sub="stream.offline")),
        hook_deps,
    )
    mine = store.get(db.user_pk(USER), follow_sk("twitch", "somestreamer"))
    assert mine
    assert mine["live"]["isLive"] is False
    assert mine["last"]["text"] == "Stream ended"
    watches = [i for i in table.all() if i["pk"] == WATCH_PK]
    assert {w["sk"] for w in watches} == {"twitch#stream:4242#" + USER, "twitch#stream:4242#other-user"}
    assert all(w["state"] == "waiting" and w["autoMaking"] is False and w["kind"] == "stream" for w in watches)
    # No job was started: part 1 never makes clips by itself.
    assert not [i for i in table.all() if str(i["sk"]).startswith("JOB#")]
    # A late "online" for the stream that already ended changes nothing.
    hooks.handle(
        _hook("twitch", online, _twitch_headers("notification", online, message="on-late", sub="stream.online")),
        hook_deps,
    )
    assert store.get(db.user_pk(USER), follow_sk("twitch", "somestreamer"))["live"]["isLive"] is False  # type: ignore[index]


def test_twitch_revocation_marks_the_creator_for_repair(
    hook_deps: hooks.HooksDeps, follow_sm: FakeSecretsManager, store: db.Store
) -> None:
    save_twitch_keys(follow_sm)
    store.put(
        {
            "pk": CREATOR_PK,
            "sk": "twitch#somestreamer",
            "platform": "twitch",
            "platformId": "somestreamer",
            "broadcasterId": "1337",
            "subs": {"online": "s1"},
            "subsStatus": "ok",
        }
    )
    body = json.dumps(
        {
            "subscription": {
                "type": "stream.online",
                "status": "authorization_revoked",
                "condition": {"broadcaster_user_id": "1337"},
            }
        }
    ).encode()
    assert hooks.handle(_hook("twitch", body, _twitch_headers("revocation", body)), hook_deps)["statusCode"] == 200
    assert store.get(CREATOR_PK, "twitch#somestreamer")["subsStatus"] == "revoked"  # type: ignore[index]


def _kick_headers(key: RsaKey, body: bytes, *, message: str = "k1", ts: str = "2026-11-15T11:59:00Z") -> dict[str, str]:
    return {
        "Kick-Event-Message-Id": message,
        "Kick-Event-Message-Timestamp": ts,
        "Kick-Event-Type": "livestream.status.updated",
        "Kick-Event-Version": "1",
        "Kick-Event-Signature": key.sign(f"{message}.{ts}.".encode() + body),
    }


def test_kick_signed_status_updates_the_badge(
    hook_deps: hooks.HooksDeps, kick_key: RsaKey, store: db.Store, rhttp: RouteHttp
) -> None:
    _follow_item(store, "kick", "trainwreck")
    body = json.dumps(
        {
            "broadcaster": {"user_id": 55, "channel_slug": "Trainwreck"},
            "is_live": True,
            "title": "Late night",
            "started_at": "2026-11-15T11:30:00Z",
        }
    ).encode()
    out = hooks.handle(_hook("kick", body, _kick_headers(kick_key, body)), hook_deps)
    assert out["statusCode"] == 200
    item = store.get(db.user_pk(USER), follow_sk("kick", "trainwreck"))
    assert item
    assert item["live"] == {
        "isLive": True,
        "title": "Late night",
        "startedAt": "2026-11-15T11:30:00Z",
        "checkedAt": "2026-11-15T12:00:00.000Z",
    }
    # A forged signature: 401, and the public key is fetched again at most once in 10 minutes.
    forged = _kick_headers(RsaKey(seed=99), body, message="k2")
    for _ in range(3):
        assert hooks.handle(_hook("kick", body, forged), hook_deps)["statusCode"] == 401
    assert len(rhttp.urls(f"{pf.KICK_API}/public-key")) == 1


def test_follow_hooks_have_no_get_and_no_oauth_callback(hook_deps: hooks.HooksDeps) -> None:
    assert hooks.handle(_hook("twitch", b"", {}, method="GET"), hook_deps)["statusCode"] == 404
    event = _hook("kick", b"", {}, method="GET")
    event["resource"] = "/oauth/{platform}/callback"
    assert hooks.handle(event, hook_deps)["statusCode"] == 404
    assert "twitch" not in settings.PLATFORMS
    assert "kick" not in settings.PLATFORMS


# --- routes ------------------------------------------------------------------------------------------------------------------------


def test_a_name_alone_asks_which_site(fapp: App, call: Call) -> None:
    assert call("POST", "/v1/follows/lookup", {"text": "SomeStreamer"}) == (
        200,
        {"needsPlatform": True, "name": "SomeStreamer"},
    )


def test_twitch_without_keys_is_found_by_name_and_needs_keys(fapp: App, call: Call, rhttp: RouteHttp) -> None:
    status, body = call("POST", "/v1/follows/lookup", {"text": "https://twitch.tv/SomeStreamer"})
    assert status == 200
    assert body["creator"] == {
        "platform": "twitch",
        "platformId": "somestreamer",
        "handle": "somestreamer",
        "name": "somestreamer",
        "avatarUrl": "",
        "url": "https://www.twitch.tv/somestreamer",
        "resolved": False,
        "needsKeys": True,
    }
    assert rhttp.calls == []  # nothing was fetched


def test_lookup_never_fetches_a_pasted_host(fapp: App, call: Call, rhttp: RouteHttp) -> None:
    status, _ = call("POST", "/v1/follows/lookup", {"text": "https://169.254.169.254/latest"})
    assert status == 400
    assert rhttp.calls == []


def test_twitch_lookup_with_keys_and_follow_list_patch_delete(
    fapp: App, call: Call, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any
) -> None:
    save_twitch_keys(follow_sm)
    twitch_routes(
        rhttp,
        live={
            "somestreamer": {
                "id": "77",
                "title": "Speedruns",
                "viewer_count": 1234,
                "started_at": "2026-11-15T11:00:00Z",
            }
        },
    )
    status, body = call("POST", "/v1/follows/lookup", {"text": "SomeStreamer", "platform": "twitch"})
    assert status == 200
    creator = body["creator"]
    assert creator["name"] == "Somestreamer"
    assert creator["resolved"] is True
    assert creator["live"]["isLive"] is True
    assert creator["live"]["viewers"] == 1200
    assert all(u.startswith(("https://id.twitch.tv/", "https://api.twitch.tv/")) for u in rhttp.urls())
    # No permission answer: no follow.
    status, err = call("POST", "/v1/follows", {"platform": "twitch", "platformId": "somestreamer", "permission": False})
    assert status == 400
    assert "said you can" in err["error"]["message"]
    status, body = call("POST", "/v1/follows", {"platform": "twitch", "platformId": "SomeStreamer", "permission": True})
    assert status == 201
    follow = body["follow"]
    assert follow["followId"] == "twitch:somestreamer"
    assert follow["autoClips"] is True
    assert follow["permissionAt"]
    assert table.raw(FOLLOWED_PK, f"twitch#somestreamer#{USER}")
    assert table.raw(CREATOR_PK, "twitch#somestreamer")["wanted"] is True
    # Following again is fine and changes nothing.
    assert (
        call("POST", "/v1/follows", {"platform": "twitch", "platformId": "somestreamer", "permission": True})[0] == 201
    )
    status, view = call("GET", "/v1/follows")
    assert status == 200
    assert [f["followId"] for f in view["follows"]] == ["twitch:somestreamer"]
    assert view["kickWebhookUrl"].endswith("/hooks/kick")
    twitch_slot = next(k for k in view["keys"] if k["platform"] == "twitch")
    assert twitch_slot["needed"] is True
    status, body = call("PATCH", "/v1/follows/twitch/somestreamer", {"autoClips": False})
    assert status == 200
    assert body["follow"]["autoClips"] is False
    assert call("DELETE", "/v1/follows/twitch/somestreamer")[0] == 204
    assert table.raw(db.user_pk(USER), follow_sk("twitch", "somestreamer")) is None
    assert table.raw(FOLLOWED_PK, f"twitch#somestreamer#{USER}") is None
    assert table.raw(CREATOR_PK, "twitch#somestreamer")  # the creator item stays (the tick unsubscribes it)
    assert call("DELETE", "/v1/follows/twitch/somestreamer")[0] == 404
    assert call("PATCH", "/v1/follows/twitch/somestreamer", {"autoClips": True})[0] == 404
    assert call("PATCH", "/v1/follows/keys/twitch", {"autoClips": True})[0] == 404


def test_youtube_lookup_from_a_video_uses_oembed_and_the_page_never_the_pasted_host(
    fapp: App, call: Call, rhttp: RouteHttp
) -> None:
    rhttp.on(
        f"{pf.YOUTUBE_SITE}/oembed",
        (200, {"author_url": "https://www.youtube.com/@CoolChannel", "author_name": "Cool"}),
    )
    rhttp.on(
        f"{pf.YOUTUBE_SITE}/@CoolChannel",
        (200, f'<html><link rel="canonical" href="https://www.youtube.com/channel/{YT_CHANNEL}"></html>'.encode()),
    )
    feed = "<feed><author><name>Cool &amp; Calm</name></author><entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><title>Hi</title><published>2026-11-14T10:00:00+00:00</published></entry></feed>"
    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (200, feed.encode()))
    status, body = call("POST", "/v1/follows/lookup", {"text": "https://youtu.be/dQw4w9WgXcQ"})
    assert status == 200
    assert body["creator"]["platformId"] == YT_CHANNEL
    assert body["creator"]["name"] == "Cool & Calm"
    assert body["creator"]["handle"] == "@CoolChannel"
    assert all(u.startswith("https://www.youtube.com/") for u in rhttp.urls())


def test_keys_are_saved_to_secrets_only_hinted_checked_and_removed_without_deleting(
    fapp: App, call: Call, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any
) -> None:
    assert call("PUT", "/v1/follows/keys/twitch", {"clientId": "short", "clientSecret": TWITCH_SECRET})[0] == 400
    status, view = call("PUT", "/v1/follows/keys/twitch", {"clientId": f" {TWITCH_ID} ", "clientSecret": TWITCH_SECRET})
    assert status == 200
    assert follow_sm.json(f"{PREFIX}twitch/app")["clientId"] == TWITCH_ID
    assert len(follow_sm.json(f"{PREFIX}twitch/eventsub")["secret"]) == 64
    slot = next(k for k in view["keys"] if k["platform"] == "twitch")
    assert slot["saved"] is True
    assert slot["hints"]["clientSecret"] == "••••9876"
    text = json.dumps(view) + json.dumps(table.all())
    assert TWITCH_SECRET not in text
    assert TWITCH_ID not in text
    twitch_routes(rhttp)
    status, body = call("POST", "/v1/follows/keys/twitch/check", None)
    assert status == 200
    assert body["check"]["ok"] is True
    rhttp.on(pf.TWITCH_TOKEN_URL, (400, {"message": "invalid client"}))
    status, body = call("POST", "/v1/follows/keys/twitch/check", None)
    assert body["check"]["code"] == "keys_rejected"
    eventsub = follow_sm.values[f"{PREFIX}twitch/eventsub"]
    call("PUT", "/v1/follows/keys/twitch", {"clientId": TWITCH_ID, "clientSecret": TWITCH_SECRET})
    assert follow_sm.values[f"{PREFIX}twitch/eventsub"] == eventsub  # made once, never replaced
    assert call("DELETE", "/v1/follows/keys/twitch")[0] == 204
    assert follow_sm.json(f"{PREFIX}twitch/app") == {"removed": True, "removedAt": "2026-11-15T12:00:00.000Z"}
    assert ("delete", f"{PREFIX}twitch/app") not in follow_sm.writes
    _, view = call("GET", "/v1/follows")
    assert next(k for k in view["keys"] if k["platform"] == "twitch")["saved"] is False
    assert call("PUT", "/v1/follows/keys/youtube-read", {"apiKey": "nope"})[0] == 400
    assert call("PUT", "/v1/follows/keys/youtube-read", {"apiKey": YT_KEY})[0] == 200
    assert follow_sm.json(f"{PREFIX}youtube/readkey")["apiKey"] == YT_KEY
    assert call("PUT", "/v1/follows/keys/tiktok", {"clientId": "x"})[0] == 404


def test_follow_settings_are_checked() -> None:
    assert settings.with_defaults({})["followDailyMax"] == 0  # no limit by default (the owner's choice)
    assert (
        settings.merge_update(
            settings.with_defaults({}), {"followDailyMax": 20, "followMinMinutes": 240, "followPaused": True}
        )["followDailyMax"]
        == 20
    )
    for bad in ({"followDailyMax": 21}, {"followDailyMax": -1}, {"followMinMinutes": 5}, {"followPaused": "yes"}):
        with pytest.raises(ApiError):
            settings.merge_update(settings.with_defaults({}), bad)


# --- the tick ----------------------------------------------------------------------------------------------------------------------


@pytest.fixture
def tdeps(store: db.Store, fenv: pf.FollowEnv, clock: Clock) -> tick.TickDeps:
    return tick.TickDeps(store=store, env=fenv, clock=clock)


def test_tick_does_nothing_for_twitch_without_keys(tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp) -> None:
    _follow_item(store, "twitch", "somestreamer", resolved=False)
    out = tick.run(tdeps)
    assert out["twitch"] == "no_keys"
    assert rhttp.calls == []


def test_tick_fills_in_twitch_names_badges_and_subscribes_once_per_creator(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any, clock: Clock
) -> None:
    save_twitch_keys(follow_sm)
    twitch_routes(
        rhttp,
        live={"somestreamer": {"id": "88", "title": "Hello", "viewer_count": 50, "started_at": "2026-11-15T11:50:00Z"}},
    )
    _follow_item(store, "twitch", "somestreamer", resolved=False)
    _follow_item(store, "twitch", "somestreamer", user="other-user", resolved=False)
    out = tick.run(tdeps)
    assert out["twitch"] == "ok"
    item = store.get(db.user_pk(USER), follow_sk("twitch", "somestreamer"))
    assert item
    assert item["resolved"] is True
    assert item["name"] == "Somestreamer"
    assert item["avatarUrl"].startswith("https://static-cdn")
    assert item["live"]["isLive"] is True
    assert item["live"]["streamId"] == "88"
    creator = table.raw(CREATOR_PK, "twitch#somestreamer")
    assert creator["subsStatus"] == "ok"
    assert set(creator["subs"]) == {"online", "offline"}
    posts = [c for c in rhttp.calls if c.method == "POST" and "eventsub" in c.url]
    assert len(posts) == 2  # online and offline, once for the creator (not once per follower)
    # A second tick: same live state, no new writes to the follows, no new subscriptions.
    writes = len(table.calls)
    clock.now = NOW + timedelta(minutes=5)
    tick.run(tdeps)
    later = [
        c
        for c in table.calls[writes:]
        if c[0] in {"put_item", "update_item"} and str(c[1].get("Key", {}).get("pk", "")).startswith("USER#")
    ]
    assert later == []
    assert len([c for c in rhttp.calls if c.method == "POST" and "eventsub" in c.url]) == 2
    # Both unfollow: the next tick unsubscribes the creator.
    for user in (USER, "other-user"):
        store.delete(db.user_pk(user), follow_sk("twitch", "somestreamer"))
        store.delete(FOLLOWED_PK, f"twitch#somestreamer#{user}")
    clock.now = NOW + timedelta(minutes=10)
    tick.run(tdeps)
    assert len([c for c in rhttp.calls if c.method == "DELETE"]) == 2
    assert table.raw(CREATOR_PK, "twitch#somestreamer")["subsStatus"] == "none"


def test_tick_notices_a_finished_twitch_stream_without_starting_a_job(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any, clock: Clock
) -> None:
    save_twitch_keys(follow_sm)
    live: dict[str, Any] = {
        "somestreamer": {"id": "99", "title": "Long one", "viewer_count": 10, "started_at": "2026-11-15T08:00:00Z"}
    }
    twitch_routes(rhttp, live=live)
    _follow_item(store, "twitch", "somestreamer")
    tick.run(tdeps)
    live.clear()
    clock.now = NOW + timedelta(minutes=5)
    tick.run(tdeps)
    watch = table.raw(WATCH_PK, f"twitch#stream:99#{USER}")
    assert watch["state"] == "waiting"
    assert watch["autoMaking"] is False
    assert watch["title"] == "Long one"
    assert not [i for i in table.all() if str(i["sk"]).startswith("JOB#")]


def test_tick_lease_stops_overlapping_runs(tdeps: tick.TickDeps, store: db.Store) -> None:
    store.put({"pk": "FOLLOWTICK", "sk": "LEASE", "until": "2026-11-15T12:01:00.000Z"})
    assert tick.run(tdeps) == {"ran": False}


def test_tick_notices_youtube_uploads_after_the_follow_only(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, table: Any, clock: Clock
) -> None:
    _follow_item(store, "youtube", YT_CHANNEL, followedAt="2026-11-15T10:00:00.000Z")

    def entries(*rows: tuple[str, str]) -> bytes:
        return (
            "<feed><author><name>Cool</name></author>"
            + "".join(
                f"<entry><yt:videoId>{v}</yt:videoId><title>T {v}</title><published>{p}</published></entry>"
                for v, p in rows
            )
            + "</feed>"
        ).encode()

    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (200, entries(("oldvideo001", "2026-11-14T09:00:00+00:00"))))
    tick.run(tdeps)
    assert [i for i in table.all() if i["pk"] == WATCH_PK] == []
    rhttp.on(
        f"{pf.YOUTUBE_SITE}/feeds/videos.xml",
        (200, entries(("newvideo001", "2026-11-15T11:00:00+00:00"), ("oldvideo001", "2026-11-14T09:00:00+00:00"))),
    )
    clock.now = NOW + timedelta(minutes=5)
    tick.run(tdeps)
    watches = [i for i in table.all() if i["pk"] == WATCH_PK]
    assert [w["sk"] for w in watches] == [f"youtube#newvideo001#{USER}"]
    assert watches[0]["kind"] == "upload"
    assert watches[0]["autoMaking"] is False
    assert store.get(db.user_pk(USER), follow_sk("youtube", YT_CHANNEL))["last"]["text"] == "New video"  # type: ignore[index]
    assert all(u.startswith("https://www.youtube.com/feeds/") for u in rhttp.urls())  # no read key: feed only


def test_youtube_units_stop_at_the_daily_limit(store: db.Store) -> None:
    assert tick._spend_units(store, NOW, 999)
    assert tick._spend_units(store, NOW, 1)
    assert not tick._spend_units(store, NOW, 1)


# --- the live push --------------------------------------------------------------------------------------------------------------


def test_follow_items_are_pushed_with_their_public_shape() -> None:
    item = {
        "pk": f"USER#{USER}",
        "sk": "FOLLOW#twitch#somestreamer",
        "type": "follow",
        "userId": USER,
        "platform": "twitch",
        "platformId": "somestreamer",
        "name": "Some",
        "creatorKeys": ["twitch:id:somestreamer"],
        "avatarUrl": "https://evil.example/a.png",
        "live": {"isLive": True},
    }
    record = {
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"pk": {"S": item["pk"]}, "sk": {"S": item["sk"]}}, "NewImage": {}},
    }
    message = broadcast.message_for(record, lambda _image: dict(item))
    assert message is not None
    assert message["type"] == "follow"
    assert message["id"] == "twitch:somestreamer"
    assert "creatorKeys" not in message["item"]
    assert "userId" not in message["item"]
    assert message["item"]["avatarUrl"] == ""
    removed = broadcast.message_for(
        {"eventName": "REMOVE", "dynamodb": {"Keys": record["dynamodb"]["Keys"]}}, lambda _i: {}
    )
    assert removed == {"type": "follow", "op": "delete", "id": "twitch:somestreamer"}
    keys_record = {
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"pk": {"S": item["pk"]}, "sk": {"S": "FOLLOWKEYS#twitch"}}},
    }
    assert broadcast.message_for(keys_record, lambda _i: {}) is None
    assert public_follow(item)["followId"] == "twitch:somestreamer"


# --- review fixes: empty prefixes, leaked subscriptions, YouTube safety, retries, time budget -------------------------------


def test_an_empty_prefix_queries_the_whole_partition_without_begins_with(store: db.Store, table: Any) -> None:
    store.put({"pk": FOLLOWED_PK, "sk": "twitch#a#u1", "type": "followed"})
    store.put({"pk": FOLLOWED_PK, "sk": "kick#b#u1", "type": "followed"})
    assert len(store.query_all(FOLLOWED_PK, "")) == 2
    last = [c for c in table.calls if c[0] == "query"][-1][1]
    assert last["KeyConditionExpression"] == "pk = :pk"
    assert ":prefix" not in last["ExpressionAttributeValues"]
    # The fake refuses an empty begins_with prefix, as DynamoDB does.
    with pytest.raises(Exception, match="ValidationException"):
        table.query(
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={":pk": FOLLOWED_PK, ":prefix": ""},
            ScanIndexForward=True,
        )


def _twitch_subs_api(http: RouteHttp, *, fail_offline_once: bool = False) -> list[dict[str, Any]]:
    """EventSub with real-ish behaviour: 409 for a duplicate, filters on GET, and an optional one-off failure."""
    made: list[dict[str, Any]] = []
    failed = {"done": not fail_offline_once}

    def handler(req: Any) -> tuple[int, Any]:
        query = parse_qs(urlsplit(req.url).query)
        if req.method == "GET":
            rows = [
                s
                for s in made
                if ("type" not in query or s["type"] == query["type"][0])
                and ("user_id" not in query or s["condition"]["broadcaster_user_id"] == query["user_id"][0])
            ]
            return 200, {"data": rows, "pagination": {}}
        if req.method == "DELETE":
            made[:] = [s for s in made if s["id"] != query["id"][0]]
            return 204, b""
        body = json.loads(req.body)
        if body["type"] == "stream.offline" and not failed["done"]:
            failed["done"] = True
            return 503, {"error": "down"}
        if any(s["type"] == body["type"] and s["condition"] == body["condition"] for s in made):
            return 409, {"error": "exists"}
        row = {
            "id": f"sub-{len(made) + 1}",
            "type": body["type"],
            "status": "enabled",
            "condition": body["condition"],
            "transport": {"method": "webhook", "callback": body["transport"]["callback"]},
        }
        made.append(row)
        return 202, {"data": [row]}

    http.on(f"{pf.TWITCH_API}/eventsub/subscriptions", handler)
    return made


def test_tick_saves_each_twitch_subscription_at_once_and_finds_the_id_after_a_409(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any, clock: Clock
) -> None:
    save_twitch_keys(follow_sm)
    twitch_routes(rhttp)
    made = _twitch_subs_api(rhttp, fail_offline_once=True)
    _follow_item(store, "twitch", "somestreamer")
    assert tick.run(tdeps)["twitch"] == "down"  # the offline subscribe failed
    creator = table.raw(CREATOR_PK, "twitch#somestreamer")
    assert creator["subs"] == {"online": "sub-1"}  # saved before the failure, never leaked
    clock.now = NOW + timedelta(minutes=5)
    assert tick.run(tdeps)["twitch"] == "ok"
    creator = table.raw(CREATOR_PK, "twitch#somestreamer")
    assert creator["subs"] == {"online": "sub-1", "offline": "sub-2"}  # the 409 for online looked up sub-1
    assert creator["subsStatus"] == "ok"
    # Unfollow: both real subscriptions go.
    store.delete(db.user_pk(USER), follow_sk("twitch", "somestreamer"))
    store.delete(FOLLOWED_PK, f"twitch#somestreamer#{USER}")
    clock.now = NOW + timedelta(minutes=10)
    tick.run(tdeps)
    assert made == []


def test_tick_repair_removes_subscriptions_for_broadcasters_nobody_follows(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any
) -> None:
    save_twitch_keys(follow_sm)
    twitch_routes(rhttp)
    made = _twitch_subs_api(rhttp)
    callback = "https://abc123.execute-api.eu-north-1.amazonaws.com/v1/hooks/twitch"
    made.append(
        {
            "id": "orphan-1",
            "type": "stream.online",
            "status": "enabled",
            "condition": {"broadcaster_user_id": "555"},
            "transport": {"method": "webhook", "callback": callback},
        }
    )
    _follow_item(store, "twitch", "somestreamer")
    tick.run(tdeps)
    assert "orphan-1" not in {s["id"] for s in made}
    assert len(made) == 2  # the followed creator's online and offline stay


def _yt_feed(*rows: tuple[str, str]) -> bytes:
    return (
        "<feed><author><name>Cool</name></author>"
        + "".join(
            f"<entry><yt:videoId>{v}</yt:videoId><title>T {v}</title><published>{p}</published></entry>"
            for v, p in rows
        )
        + "</feed>"
    ).encode()


def _yt_videos(http: RouteHttp, states: dict[str, str]) -> None:
    def handler(req: Any) -> tuple[int, Any]:
        ids = parse_qs(urlsplit(req.url).query)["id"][0].split(",")
        items = [
            {
                "id": v,
                "snippet": {"title": f"T {v}", "liveBroadcastContent": states[v]},
                "liveStreamingDetails": {"actualStartTime": "2026-11-15T11:00:00Z", "concurrentViewers": "120"},
            }
            for v in ids
            if v in states
        ]
        return 200, {"items": items}

    http.on(f"{pf.YOUTUBE_API}/videos", handler)
    http.on(f"{pf.YOUTUBE_API}/channels", (200, {"items": []}))


def test_youtube_live_video_is_a_stream_not_an_upload_and_a_failed_feed_never_ends_it(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp, follow_sm: FakeSecretsManager, table: Any, clock: Clock
) -> None:
    follow_sm.values[pf.secret_name(Secrets(follow_sm, PREFIX), "youtube-read")] = json.dumps({"apiKey": YT_KEY})
    _follow_item(store, "youtube", YT_CHANNEL, followedAt="2026-11-15T10:00:00.000Z")
    states = {"livevideo01": "live"}
    _yt_videos(rhttp, states)
    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (200, _yt_feed(("livevideo01", "2026-11-15T11:00:00+00:00"))))
    tick.run(tdeps)
    mine = store.get(db.user_pk(USER), follow_sk("youtube", YT_CHANNEL))
    assert mine
    assert mine["live"]["isLive"] is True
    assert [i for i in table.all() if i["pk"] == WATCH_PK] == []  # live: not a ready upload
    # A failed feed (5xx) is missing data: the badge stays LIVE and no "stream ended" is noticed.
    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (503, b""))
    clock.now = NOW + timedelta(minutes=5)
    tick.run(tdeps)
    mine = store.get(db.user_pk(USER), follow_sk("youtube", YT_CHANNEL))
    assert mine
    assert mine["live"]["isLive"] is True
    assert [i for i in table.all() if i["pk"] == WATCH_PK] == []
    # It ends: one WATCH item, kind "stream" with endedAt.
    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (200, _yt_feed(("livevideo01", "2026-11-15T11:00:00+00:00"))))
    states["livevideo01"] = "none"
    clock.now = NOW + timedelta(minutes=10)
    tick.run(tdeps)
    watches = [i for i in table.all() if i["pk"] == WATCH_PK]
    assert len(watches) == 1
    assert watches[0]["kind"] == "stream"
    assert watches[0]["endedAt"]


def test_a_stream_notice_moves_an_earlier_upload_notice_on(store: db.Store, table: Any) -> None:
    from clipfactory_api.follow.model import notice

    assert notice(store, USER, "youtube", YT_CHANNEL, vkey="vid12345678", now=NOW, kind="upload", title="Live!")
    assert notice(store, USER, "youtube", YT_CHANNEL, vkey="vid12345678", now=NOW, kind="stream", started_at="x")
    watch = table.raw(WATCH_PK, f"youtube#vid12345678#{USER}")
    assert watch["kind"] == "stream"
    assert watch["endedAt"]
    assert not notice(store, USER, "youtube", YT_CHANNEL, vkey="vid12345678", now=NOW, kind="stream")  # once


def test_a_twitch_retry_after_a_failed_live_change_is_handled_again(
    hook_deps: hooks.HooksDeps,
    follow_sm: FakeSecretsManager,
    store: db.Store,
    table: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    save_twitch_keys(follow_sm)
    _follow_item(store, "twitch", "somestreamer", live={"isLive": True, "streamId": "7"})
    store.put(
        {"pk": CREATOR_PK, "sk": "twitch#somestreamer", "type": "creator", "live": {"isLive": True, "streamId": "7"}}
    )
    offline = json.dumps(
        {
            "subscription": {"type": "stream.offline"},
            "event": {"broadcaster_user_id": "1337", "broadcaster_user_login": "somestreamer"},
        }
    ).encode()
    real = webhooks.apply_live
    calls = {"n": 0}

    def flaky(*a: Any, **k: Any) -> bool:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("throttled")
        return real(*a, **k)

    monkeypatch.setattr(webhooks, "apply_live", flaky)
    event = _hook("twitch", offline, _twitch_headers("notification", offline, message="off9", sub="stream.offline"))
    first = hooks.handle(event, hook_deps)
    assert first["statusCode"] >= 500
    again = hooks.handle(event, hook_deps)
    assert again["statusCode"] == 200
    assert table.raw(WATCH_PK, f"twitch#stream:7#{USER}")["kind"] == "stream"
    assert table.raw("HOOK#twitch", "HOOK#off9")["done"] is True
    third = hooks.handle(event, hook_deps)
    assert third["statusCode"] == 200
    assert calls["n"] == 2  # a done message is not handled again


def test_tick_stops_inside_the_youtube_loop_when_out_of_time(
    tdeps: tick.TickDeps, store: db.Store, rhttp: RouteHttp
) -> None:
    for n in range(3):
        _follow_item(store, "youtube", f"UC{n:022d}")
    rhttp.on(f"{pf.YOUTUBE_SITE}/feeds/videos.xml", (200, _yt_feed()))
    ticks = iter([0.0, 0.0, 0.0, 0.0, 200.0, 200.0, 200.0, 200.0, 200.0, 200.0])
    tdeps.monotonic = lambda: next(ticks, 200.0)
    tick.run(tdeps)
    assert len(rhttp.urls(f"{pf.YOUTUBE_SITE}/feeds/")) < 3
