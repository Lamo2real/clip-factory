"""Notifications (docs/CONTRACTS.md §32): Web Push encryption and VAPID, the device routes, and cf-prod-notify.

A fake push service decrypts every message with the browser's private key and checks the VAPID signature, so the
tests prove what a real browser would show, without any network.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from clipfactory_api import db, settings
from clipfactory_api.app import App
from clipfactory_api.jobs import STEPS
from clipfactory_api.push import devices, notify, webpush
from clipfactory_api.realtime.broadcast import _deserializer
from conftest import USER, Call, Clock, seed_job
from fakes import FakeSecretsManager

SECRET = "cf-prod/notify/vapid"
SUBJECT = "https://d111111abcdef8.cloudfront.net"
APPLE = "https://web.push.apple.com/QGuQyavXutnMH7vvR"
GOOGLE = "https://fcm.googleapis.com/fcm/send/abc:def"


def _pem(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
    ).decode()


VAPID = ec.generate_private_key(ec.SECP256R1())
VAPID_PEM = _pem(VAPID)


class Browser:
    """One browser's push subscription: it can read what was sent to it."""

    def __init__(self, endpoint: str = APPLE) -> None:
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"0123456789abcdef"
        self.endpoint = endpoint

    def json(self, label: str = "iPhone") -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "keys": {
                "p256dh": webpush.b64u(webpush.raw_public(self.key.public_key())),
                "auth": webpush.b64u(self.auth),
            },
            "deviceLabel": label,
        }

    def decrypt(self, body: bytes) -> dict[str, Any]:
        salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
        as_public = body[21 : 21 + idlen]
        assert rs == 4096
        assert idlen == 65
        ua_public = webpush.raw_public(self.key.public_key())
        shared = self.key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))

        def hkdf(s: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
            return HKDF(algorithm=hashes.SHA256(), length=n, salt=s, info=info).derive(ikm)

        ikm = hkdf(self.auth, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
        cek = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
        nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
        plain = AESGCM(cek).decrypt(nonce, body[21 + idlen :], None)
        assert plain.endswith(b"\x02")
        return json.loads(plain[:-1])  # type: ignore[no-any-return]


class PushService:
    """Answers each POST with a status (201 unless told otherwise) and checks it like Apple's or Google's would."""

    def __init__(self, browsers: list[Browser]) -> None:
        self.browsers = {b.endpoint: b for b in browsers}
        self.status: dict[str, int] = {}
        self.received: list[tuple[str, dict[str, str], dict[str, Any]]] = []

    def __call__(self, url: str, headers: dict[str, str], body: bytes, timeout: float) -> int:
        assert timeout <= 10
        assert headers["Content-Encoding"] == "aes128gcm"
        _verify_vapid(headers["Authorization"], url)
        self.received.append((url, headers, self.browsers[url].decrypt(body)))
        return self.status.get(url, 201)

    @property
    def shown(self) -> list[dict[str, Any]]:
        return [r[2] for r in self.received]


def _verify_vapid(value: str, url: str) -> None:
    assert value.startswith("vapid t=")
    token, k = value[len("vapid t=") :].split(", k=")
    assert k == webpush.public_key_b64(VAPID)
    header, claims, sig = token.split(".")
    payload = json.loads(webpush.unb64u(claims))
    assert payload["aud"] == "https://" + url.split("/")[2]
    assert payload["sub"] == SUBJECT
    raw = webpush.unb64u(sig)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    try:
        VAPID.public_key().verify(der, f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as e:  # pragma: no cover - a failure is the test failing
        raise AssertionError("bad VAPID signature") from e


@pytest.fixture
def push_secrets() -> FakeSecretsManager:
    return FakeSecretsManager({SECRET: VAPID_PEM})


@pytest.fixture
def iphone() -> Browser:
    return Browser(APPLE)


@pytest.fixture
def service(iphone: Browser) -> PushService:
    return PushService([iphone, Browser(GOOGLE)])


@pytest.fixture
def push_app(app: App, push_secrets: FakeSecretsManager, service: PushService) -> App:
    app.push = devices.VapidKey(push_secrets, SECRET, SUBJECT)
    app.push_post = service
    return app


# ---------- encryption and VAPID ----------


def test_encrypt_round_trip_and_fresh_salt_each_time(iphone: Browser) -> None:
    sub = iphone.json()
    a = webpush.encrypt(b'{"x":1}', sub["keys"]["p256dh"], sub["keys"]["auth"])
    b = webpush.encrypt(b'{"x":1}', sub["keys"]["p256dh"], sub["keys"]["auth"])
    assert a[:16] != b[:16]  # a new salt and sender key per message
    assert iphone.decrypt(a) == {"x": 1}


def test_encrypt_refuses_too_large_and_bad_keys(iphone: Browser) -> None:
    sub = iphone.json()
    with pytest.raises(ValueError, match="too large"):
        webpush.encrypt(b"x" * 5000, sub["keys"]["p256dh"], sub["keys"]["auth"])
    with pytest.raises(ValueError, match="not valid"):
        webpush.encrypt(b"x", webpush.b64u(b"\x04" + b"1" * 10), sub["keys"]["auth"])


def test_vapid_key_must_be_p256() -> None:
    other = ec.generate_private_key(ec.SECP384R1())
    with pytest.raises(ValueError, match="P-256"):
        webpush.load_private_key(_pem(other))
    assert webpush.load_private_key(VAPID_PEM).curve.name == "secp256r1"


def test_vapid_token_expires_within_24_hours() -> None:
    value = webpush.vapid_authorization(VAPID, APPLE, SUBJECT, now=1_000_000.0)
    claims = json.loads(webpush.unb64u(value.split("t=")[1].split(".")[1]))
    assert claims["exp"] - 1_000_000 <= 24 * 3600
    assert claims["aud"] == "https://web.push.apple.com"


def test_endpoint_allow_list() -> None:
    assert devices.allowed_endpoint(APPLE)
    assert devices.allowed_endpoint(GOOGLE)
    assert devices.allowed_endpoint("https://updates.push.services.mozilla.com/wpush/v2/x")
    assert devices.allowed_endpoint("https://wns2-db5p.notify.windows.com/w/?token=x")
    for bad in (
        "http://web.push.apple.com/x",
        "https://evil.example/x",
        "https://web.push.apple.com.evil.example/x",
        "https://notify.windows.com/x",
        "https://user:pw@web.push.apple.com/x",
        "https://web.push.apple.com:8443/x",
        "https://169.254.169.254/latest",
    ):
        assert not devices.allowed_endpoint(bad), bad


# ---------- routes ----------


def test_key_is_503_until_set_up(call: Call) -> None:
    status, body = call("GET", "/v1/push/key")
    assert status == 503
    assert body["error"]["message"] == "Notifications are not set up yet. Try again after the next update."


def test_key_is_the_public_half_only(push_app: App, call: Call) -> None:
    status, body = call("GET", "/v1/push/key")
    assert status == 200
    assert body == {"publicKey": webpush.public_key_b64(VAPID)}
    assert len(webpush.unb64u(body["publicKey"])) == 65
    assert "PRIVATE" not in json.dumps(body)


def test_put_device_is_idempotent_and_never_returns_the_endpoint(
    push_app: App, call: Call, iphone: Browser, clock: Clock
) -> None:
    status, body = call("PUT", "/v1/push/devices/phone-12345678", iphone.json())
    assert status == 200
    assert body["device"] == {
        "deviceId": "phone-12345678",
        "kind": "webpush",
        "deviceLabel": "iPhone",
        "createdAt": "2026-11-15T12:00:00.000Z",
        "updatedAt": "2026-11-15T12:00:00.000Z",
    }
    clock.now += timedelta(hours=1)
    status, body = call("PUT", "/v1/push/devices/phone-12345678", iphone.json())
    assert body["device"]["createdAt"] == "2026-11-15T12:00:00.000Z"
    assert body["device"]["updatedAt"] == "2026-11-15T13:00:00.000Z"
    status, listed = call("GET", "/v1/push/devices")
    assert status == 200
    assert [d["deviceId"] for d in listed["devices"]] == ["phone-12345678"]
    assert "endpoint" not in json.dumps(listed)
    assert "p256dh" not in json.dumps(listed)


@pytest.mark.parametrize(
    "patch",
    [
        {"endpoint": "https://evil.example/push"},
        {"endpoint": "http://web.push.apple.com/x"},
        {"keys": {"p256dh": "AAAA", "auth": "AAAA"}},
        {"keys": "nope"},
        {"deviceLabel": "<script>"},
        {"extra": True},
    ],
)
def test_put_device_refuses_bad_subscriptions(
    push_app: App, call: Call, iphone: Browser, patch: dict[str, Any]
) -> None:
    status, body = call("PUT", "/v1/push/devices/phone-12345678", {**iphone.json(), **patch})
    assert status == 400, body
    assert call("GET", "/v1/push/devices")[1]["devices"] == []


def test_put_device_refuses_bad_device_id(push_app: App, call: Call, iphone: Browser) -> None:
    assert call("PUT", "/v1/push/devices/x", iphone.json())[0] == 400


def test_delete_device(push_app: App, call: Call, iphone: Browser) -> None:
    call("PUT", "/v1/push/devices/phone-12345678", iphone.json())
    assert call("DELETE", "/v1/push/devices/phone-12345678") == (204, None)
    assert call("GET", "/v1/push/devices")[1]["devices"] == []
    assert call("DELETE", "/v1/push/devices/phone-12345678") == (204, None)  # already gone: still fine


def test_send_test_reaches_the_device_once_every_10_seconds(
    push_app: App, call: Call, iphone: Browser, service: PushService, clock: Clock
) -> None:
    call("PUT", "/v1/push/devices/phone-12345678", iphone.json())
    status, body = call("POST", "/v1/push/test", {"deviceId": "phone-12345678"})
    assert (status, body) == (200, {"sent": 1, "devices": 1})
    assert service.shown == [
        {
            "title": "Clip Factory",
            "body": "Notifications are on 🎉",
            "tag": "test",
            "url": "/settings/app/notifications",
        }
    ]
    status, body = call("POST", "/v1/push/test", {"deviceId": "phone-12345678"})
    assert status == 429
    clock.now += timedelta(seconds=11)
    assert call("POST", "/v1/push/test", {})[0] == 200


def test_send_test_without_a_device_is_404(push_app: App, call: Call) -> None:
    status, body = call("POST", "/v1/push/test", {})
    assert status == 404
    assert body["error"]["message"] == "Turn on notifications on this device first."


def test_settings_notify_choices(call: Call) -> None:
    assert call("GET", "/v1/settings")[1]["settings"]["notify"] == {
        "ready": True,
        "stopped": True,
        "resumed": False,
        "steps": False,
        "contentRewards": True,  # §38.11, on by default
        "getPaid": True,  # §40.7, on by default
        "earn": True,  # §58, on by default
    }
    status, body = call("PUT", "/v1/settings", {"notify": {"steps": True}})
    assert status == 200
    assert body["settings"]["notify"] == {
        "ready": True,
        "stopped": True,
        "resumed": False,
        "steps": True,
        "contentRewards": True,
        "getPaid": True,
        "earn": True,
    }
    status, body = call("PUT", "/v1/settings", {"notify": {"contentRewards": False}})
    assert status == 200
    assert body["settings"]["notify"]["contentRewards"] is False
    status, body = call("PUT", "/v1/settings", {"notify": {"loud": True}})
    assert status == 400
    assert body["error"]["message"] == (
        "Notifications must say on or off for: clips ready, stopped, picked up, every step, Content Rewards news, "
        "money on hold or sent, ready to earn."
    )
    assert call("PUT", "/v1/settings", {"notify": {"ready": "yes"}})[0] == 400


# ---------- cf-prod-notify ----------


def _ddb(value: Any) -> dict[str, Any]:
    from boto3.dynamodb.types import TypeSerializer

    return TypeSerializer().serialize(db.to_dynamo(value))  # type: ignore[no-any-return]


def _record(old: dict[str, Any], new: dict[str, Any], event: str = "MODIFY") -> dict[str, Any]:
    return {
        "eventName": event,
        "dynamodb": {
            "Keys": {"pk": {"S": new["pk"]}, "sk": {"S": new["sk"]}},
            "OldImage": {k: _ddb(v) for k, v in old.items()},
            "NewImage": {k: _ddb(v) for k, v in new.items()},
        },
    }


def _steps(running: str | None) -> list[dict[str, Any]]:
    out, seen = [], False
    for key, label in STEPS:
        if key == running:
            out.append({"key": key, "label": label, "status": "running"})
            seen = True
        else:
            out.append({"key": key, "label": label, "status": "pending" if seen or running is None else "done"})
    return out


@pytest.fixture
def deps(push_app: App, service: PushService, clock: Clock) -> notify.NotifyDeps:
    return notify.NotifyDeps(
        store=push_app.store, key=push_app.push, deserialize=_deserializer(), post=service, clock=clock
    )


@pytest.fixture
def job(store: db.Store, call: Call, iphone: Browser, push_app: App) -> dict[str, Any]:
    call("PUT", "/v1/push/devices/phone-12345678", iphone.json())
    return seed_job(store, source={"type": "link", "platform": "youtube", "title": "Kai Cenat Scammed Me!.mp4"})


def test_ready_and_stopped_are_sent_with_the_video_title(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store
) -> None:
    store.put({**job, "status": "ready"})  # the stream record follows the write
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    notify.process({"Records": [_record(job, {**job, "status": "failed", "sessionId": "run-2"})]}, deps)
    assert service.shown == [
        {
            "title": "Kai Cenat Scammed Me!.mp4",
            "body": "Your clips are ready. Tap to look.",
            "tag": job["jobId"],
            "url": f"/jobs/{job['jobId']}",
            "badge": 0,
        },
        {
            "title": "Kai Cenat Scammed Me!.mp4",
            "body": "It stopped. Tap Try again.",
            "tag": job["jobId"],
            "url": f"/jobs/{job['jobId']}",
            "badge": 0,
        },
    ]
    assert service.received[0][1]["Urgency"] == "high"


def test_a_stream_retry_never_sends_twice(deps: notify.NotifyDeps, job: dict[str, Any], service: PushService) -> None:
    record = _record(job, {**job, "status": "ready"})
    notify.process({"Records": [record]}, deps)
    notify.process({"Records": [record]}, deps)
    assert len(service.shown) == 1


def test_choices_are_respected(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store
) -> None:
    settings.save(
        store, USER, {"notify": {"ready": False, "stopped": True, "steps": False}}, "2026-11-15T12:00:00.000Z"
    )
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    assert service.shown == []


def test_steps_are_off_by_default(deps: notify.NotifyDeps, job: dict[str, Any], service: PushService) -> None:
    notify.process({"Records": [_record({**job, "steps": _steps("select")}, {**job, "steps": _steps("render")})]}, deps)
    assert service.shown == []


def test_steps_when_on_say_the_step_and_wait_2_minutes(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store, clock: Clock
) -> None:
    settings.save(store, USER, {"notify": {"steps": True}}, "2026-11-15T12:00:00.000Z")
    a, b, c = ({**job, "status": "running", "steps": _steps(k)} for k in ("select", "render", "checklist"))
    notify.process({"Records": [_record(a, b)]}, deps)
    notify.process({"Records": [_record(b, c)]}, deps)  # 0 s later: held back
    clock.now += timedelta(minutes=2)
    notify.process({"Records": [_record(b, c)]}, deps)
    assert [s["body"] for s in service.shown] == [
        "Cutting the clips · step 7 of 10",
        "Checking each clip · step 8 of 10",
    ]
    # One card per job: every one has the job's tag, so the newest replaces the last; progress is quiet.
    assert {s["tag"] for s in service.shown} == {job["jobId"]}
    assert all(s["quiet"] is True and s["badge"] == 1 for s in service.shown)
    headers = service.received[0][1]
    assert headers["Topic"] == f"job{job['jobId']}"[:32]
    assert headers["TTL"] == "600"
    # Heartbeats (same step) and a finished step with no new one send nothing.
    notify.process({"Records": [_record(c, {**c, "heartbeatAt": "later"})]}, deps)
    assert len(service.shown) == 2


def _with_note(job: dict[str, Any], running: str, note: str) -> dict[str, Any]:
    steps = _steps(running)
    for s in steps:
        if s["key"] == running:
            s["message"] = note
    return {**job, "status": "running", "steps": steps}


def test_a_new_clip_updates_the_card_with_its_number(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store, clock: Clock
) -> None:
    settings.save(store, USER, {"notify": {"steps": True}}, "2026-11-15T12:00:00.000Z")
    a = _with_note(job, "render", "Cutting clip 2 of 10…")
    b = _with_note(job, "render", "Cutting clip 3 of 10…")
    notify.process({"Records": [_record(a, b)]}, deps)
    clock.now += timedelta(minutes=3)
    notify.process({"Records": [_record(b, {**b, "heartbeatAt": "later"})]}, deps)  # same clip: nothing
    c = _with_note(job, "checklist", "Checking clip 4 of 10…")
    notify.process({"Records": [_record(b, c)]}, deps)
    assert [s["body"] for s in service.shown] == [
        "Cutting the clips · step 7 of 10 · clip 3 of 10",
        "Checking each clip · step 8 of 10 · clip 4 of 10",
    ]


def test_picked_up_again_is_off_by_default(deps: notify.NotifyDeps, job: dict[str, Any], service: PushService) -> None:
    stopped = {**job, "status": "failed", "pickUp": True, "sessionId": "run-1"}
    again = {**job, "status": "queued", "pickUp": True, "sessionId": "run-2"}
    notify.process({"Records": [_record(stopped, again)]}, deps)
    assert service.shown == []


def test_picked_up_again_when_asked_is_quiet_and_replaceable(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store
) -> None:
    settings.save(store, USER, {"notify": {"resumed": True}}, "2026-11-15T12:00:00.000Z")
    stopped = {**job, "status": "failed", "pickUp": True, "sessionId": "run-1"}
    again = {**job, "status": "queued", "pickUp": True, "sessionId": "run-2", "note": "Picking up where it stopped…"}
    notify.process({"Records": [_record(stopped, again)]}, deps)
    notify.process({"Records": [_record(again, {**again, "status": "running"})]}, deps)  # same run: nothing new
    assert [(s["body"], s["tag"], s["badge"], s["quiet"]) for s in service.shown] == [
        ("Picking up where it stopped.", job["jobId"], 1, True)
    ]
    assert service.received[0][1]["Topic"] == f"job{job['jobId']}"[:32]


def test_a_step_held_back_inside_the_gap_is_sent_by_the_next_write_after_it(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store, clock: Clock
) -> None:
    settings.save(store, USER, {"notify": {"steps": True}}, "2026-11-15T12:00:00.000Z")
    a, b, c = ({**job, "status": "running", "steps": _steps(k)} for k in ("select", "render", "checklist"))
    notify.process({"Records": [_record(a, b)]}, deps)  # sent
    clock.now += timedelta(seconds=60)
    notify.process({"Records": [_record(b, c)]}, deps)  # inside the gap: held back
    assert len(service.shown) == 1
    # Nothing changes any more: only heartbeats follow. Once the gap is over the next one shows the new step.
    notify.process({"Records": [_record(c, {**c, "heartbeatAt": "1"})]}, deps)
    assert len(service.shown) == 1
    clock.now += timedelta(seconds=61)
    beat = {**c, "heartbeatAt": "2"}
    notify.process({"Records": [_record(c, beat)]}, deps)
    assert [s["body"] for s in service.shown][-1] == "Checking each clip · step 8 of 10"
    # ...and once only: the same step again (a heartbeat, or a stream retry) sends nothing.
    clock.now += timedelta(minutes=5)
    notify.process({"Records": [_record(c, beat), _record(c, {**c, "heartbeatAt": "3"})]}, deps)
    assert len(service.shown) == 2


def test_a_dropped_card_does_not_use_up_the_slot(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store, clock: Clock
) -> None:
    settings.save(store, USER, {"notify": {"steps": True}}, "2026-11-15T12:00:00.000Z")
    store.put({**job, "status": "running"})
    b = {**job, "status": "running", "steps": _steps("render")}
    # A step card for a job whose owner has no device sends nothing and leaves no mark behind.
    store.update(db.user_pk(USER), devices.sub_sk("phone-12345678"), {"gone": True})
    notify.process({"Records": [_record(job, b)]}, deps)
    assert store.get(db.user_pk(USER), f"NOTIFYSTEP#{job['jobId']}") is None


def test_many_auto_resumes_in_one_run_send_nothing_by_default(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService
) -> None:
    before = {**job, "status": "running", "pickUp": True, "sessionId": "run-0"}
    for n in range(1, 7):
        after = {**before, "sessionId": f"run-{n}"}
        notify.process({"Records": [_record(before, after)]}, deps)
        before = after
    assert service.shown == []


def test_the_badge_counts_every_working_job(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store
) -> None:
    seed_job(store, status="running")
    seed_job(store, status="queued")
    seed_job(store, status="ready")
    store.put({**job, "status": "ready"})
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    assert service.shown[0]["badge"] == 2


def test_a_gone_device_is_marked_and_skipped(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, store: db.Store
) -> None:
    service.status[APPLE] = 410
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    item = store.get(db.user_pk(USER), devices.sub_sk("phone-12345678"))
    assert item is not None
    assert item["gone"] is True
    assert item["ttl"] > 0
    assert devices.active(store, USER) == []
    notify.process({"Records": [_record(job, {**job, "status": "failed", "sessionId": "run-2"})]}, deps)
    assert len(service.received) == 1  # never sent to it again


def test_one_failing_device_never_stops_the_others(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, call: Call
) -> None:
    other = Browser(GOOGLE)
    service.browsers[GOOGLE] = other
    call("PUT", "/v1/push/devices/mac-12345678", other.json("Mac"))
    service.status[APPLE] = 500
    out = notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    assert out == {"batchItemFailures": []}
    assert sorted(r[0] for r in service.received) == sorted([APPLE, GOOGLE])


def test_only_job_modify_records_count(deps: notify.NotifyDeps, job: dict[str, Any], service: PushService) -> None:
    clip = {**job, "sk": "CLIP#C1", "status": "ready"}
    notify.process({"Records": [_record(job, {**job, "status": "ready"}, "INSERT"), _record(job, clip)]}, deps)
    assert service.shown == []


def test_long_titles_are_cut_and_links_never_shown() -> None:
    long = {"jobId": "J", "source": {"title": "A" * 60}}
    assert notify.video_title(long) == "A" * 39 + "…"
    assert notify.video_title({"source": {"url": "https://youtube.com/watch?v=x"}}) == "Your video"


def test_nothing_secret_is_logged(
    deps: notify.NotifyDeps, job: dict[str, Any], service: PushService, capsys: pytest.CaptureFixture[str]
) -> None:
    service.status[APPLE] = 410
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    out = capsys.readouterr().out
    assert "notify.device_gone" in out
    for secret in ("PRIVATE KEY", APPLE, "QGuQyavXutnMH7vvR", webpush.b64u(b"0123456789abcdef")):
        assert secret not in out


def test_the_same_phone_under_two_device_ids_is_one_device(
    push_app: App, call: Call, store: db.Store, deps: notify.NotifyDeps, job: dict[str, Any], service: PushService
) -> None:
    # Cleared storage (or the Home Screen app and Safari keeping separate storage) makes a new id for the same phone.
    phone = service.browsers[APPLE]
    assert call("PUT", "/v1/push/devices/second-id-1234", phone.json())[0] in (200, 204)
    assert [d["deviceId"] for d in devices.active(store, USER)] == ["second-id-1234"]
    notify.process({"Records": [_record(job, {**job, "status": "ready"})]}, deps)
    assert len(service.received) == 1  # one buzz, not two
    # Saving it again (the page re-sends it when it opens) changes nothing.
    assert call("PUT", "/v1/push/devices/second-id-1234", phone.json())[0] in (200, 204)
    assert [d["deviceId"] for d in devices.active(store, USER)] == ["second-id-1234"]


# ---------- Content Rewards news (§38.11) ----------

CR_UUID = "200ea21b-be80-4db8-b552-8e32b148604e"
CR_POST = "01J0000000000000000000000P"
CR_CLIP = "01J0000000000000000000000C"


@pytest.fixture
def phone(call: Call, iphone: Browser, push_app: App) -> None:
    call("PUT", "/v1/push/devices/phone-12345678", iphone.json())


def _cr(sk: str, **fields: Any) -> dict[str, Any]:
    return {"pk": db.user_pk(USER), "sk": sk, "userId": USER, **fields}


def _campaign(**fields: Any) -> dict[str, Any]:
    return _cr(f"CAMPAIGN#{CR_UUID}", type="campaign", campaignId=CR_UUID, name="FaZe Clips", **fields)


def _sub(**fields: Any) -> dict[str, Any]:
    return _cr(f"CRSUB#{CR_POST}", type="crsub", postId=CR_POST, clipId=CR_CLIP, campaignId=CR_UUID, **fields)


def test_cr_events_each_once(
    deps: notify.NotifyDeps, phone: None, service: PushService, store: db.Store, clock: Clock
) -> None:
    from datetime import timedelta

    from clipfactory_api.clock import iso

    store.put(_campaign(membership="in"))
    records = [
        _record(_campaign(membership="not_joined"), _campaign(membership="in")),
        _record(_campaign(membership="manual"), _campaign(membership="in")),  # from manual: no "You're in"
        _record(_sub(state="sending"), _sub(state="send_by_hand", sendBy=iso(clock.now + timedelta(minutes=12)))),
        _record(_sub(state="sent", crStatus="pending"), _sub(state="approved", crStatus="approved")),
        _record(_sub(state="sent", crStatus="pending"), _sub(state="rejected", crStatus="rejected")),
        _record(_sub(state="sent", proof={}), _sub(state="sent", proof={"notifiedAt": iso(clock.now)})),
        _record(
            _cr("CRMONEY", firstReadDone=True, paidTotalCents=500, payoutsSeen=["pay_1"]),
            _cr("CRMONEY", firstReadDone=True, paidTotalCents=921, lastPaidCents=421, payoutsSeen=["pay_2", "pay_1"]),
        ),
        _record(
            _cr("CRCONN", status="connected"),
            _cr("CRCONN", status="connected", reason="expires_soon", signInBy="2027-02-13"),
        ),
        _record(
            _cr("CRCONN", status="connected", pilotReminders=0),
            _cr("CRCONN", status="connected", pilotReminders=1, pilotSentAt="x"),
        ),
    ]
    notify.process({"Records": records}, deps)
    notify.process({"Records": records}, deps)  # a stream retry: nothing twice
    shown = [(m["title"], m["body"], m["tag"], m["url"]) for m in service.shown]
    assert shown == [
        ("FaZe Clips", "You're in! Tap to make clips.", f"cr-{CR_UUID}", f"/campaigns/{CR_UUID}"),
        (
            "Content Rewards",
            "Send this to Content Rewards now (12 min left).",
            f"crsub-{CR_CLIP}",
            f"/clips/{CR_CLIP}?cr={CR_POST}",
        ),
        ("FaZe Clips", "Approved! The brand said yes to your clip.", f"crsub-{CR_POST}", f"/clips/{CR_CLIP}"),
        ("FaZe Clips", "Not approved. Tap to see why.", f"crsub-{CR_POST}", f"/clips/{CR_CLIP}"),
        (
            "FaZe Clips",
            "FaZe Clips wants proof of views now. Tap to see how.",
            f"crproof-{CR_POST}",
            f"/clips/{CR_CLIP}?cr={CR_POST}",
        ),
        (
            "Content Rewards",
            "Money from Content Rewards! $4.21 is in your balance.",
            "crmoney",
            "/money#content-rewards",
        ),
        (
            "Content Rewards",
            "Sign in to Content Rewards again on your Mac, so your clips keep getting sent.",
            "crconn",
            "/settings/posting/setup/contentrewards",
        ),
        (
            "Content Rewards",
            "Did Content Rewards say yes? Tap Connect Content Rewards on your Mac to check.",
            "crpilot",
            "/settings/posting/setup/contentrewards",
        ),
    ]
    send_now = service.received[1][1]
    assert send_now["Urgency"] == "high"
    assert send_now["TTL"] == "720"


def test_cr_first_money_and_old_money(deps: notify.NotifyDeps, phone: None, service: PushService) -> None:
    first = _record(
        _cr("CRMONEY", firstReadDone=True, paidTotalCents=0, payoutsSeen=[]),
        _cr("CRMONEY", firstReadDone=True, paidTotalCents=500, lastPaidCents=500, payoutsSeen=["pay_1"]),
    )
    quiet = _record(
        _cr("CRMONEY", firstReadDone=False, payoutsSeen=[]),
        _cr("CRMONEY", firstReadDone=True, paidTotalCents=9000, payoutsSeen=["pay_9"]),
    )
    notify.process({"Records": [first, quiet]}, deps)
    assert [m["body"] for m in service.shown] == ["Your first money from Content Rewards!"]


def test_cr_choice_off_and_inserts_ignored(
    deps: notify.NotifyDeps, phone: None, service: PushService, store: db.Store
) -> None:
    from clipfactory_api import settings

    record = _record(_campaign(membership="not_joined"), _campaign(membership="in"))
    notify.process({"Records": [_record({}, _campaign(membership="in"), event="INSERT")]}, deps)
    settings.save(
        store, USER, {"notify": {**settings.DEFAULTS["notify"], "contentRewards": False}}, "2026-11-15T12:00:00.000Z"
    )
    notify.process({"Records": [record]}, deps)
    assert service.shown == []
