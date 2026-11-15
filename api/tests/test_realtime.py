"""Live updates: the $connect authorizer, the WebSocket routes and the stream broadcaster (docs/CONTRACTS.md §14.2)."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.realtime import authorizer, broadcast, ws
from clipfactory_api.realtime.authorizer import Verifier
from conftest import NOW, OTHER, USER, Clock
from fakes import FakeManagement, FakeTable

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "jwks.json").read_text())
REGION = "eu-north-1"
POOL = "eu-north-1_TestPool"
CLIENT = "test-client-id"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}"
METHOD_ARN = "arn:aws:execute-api:eu-north-1:123456789012:abc123/live/$connect"
T0 = 1_800_000_000.0


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _int(value: str) -> int:
    return int.from_bytes(authorizer.b64url_decode(value), "big")


def sign(claims: dict[str, Any], *, kid: str = "test-key-1", alg: str = "RS256") -> str:
    """RS256 with the fixed TEST-ONLY key in tests/fixtures/jwks.json (PKCS#1 v1.5, SHA-256)."""
    n, d = _int(FIXTURE["keys"][0]["n"]), _int(FIXTURE["private"]["d"])
    header = _b64(json.dumps({"alg": alg, "kid": kid, "typ": "JWT"}).encode())
    payload = _b64(json.dumps(claims).encode())
    k = (n.bit_length() + 7) // 8
    t = authorizer.SHA256_DIGEST_INFO + hashlib.sha256(f"{header}.{payload}".encode()).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    signature = pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")
    return f"{header}.{payload}.{_b64(signature)}"


def claims(**overrides: Any) -> dict[str, Any]:
    return {
        "sub": USER,
        "iss": ISSUER,
        "token_use": "access",
        "client_id": CLIENT,
        "exp": int(T0) + 900,
        "iat": int(T0),
        **overrides,
    }


class Jwks:
    def __init__(self) -> None:
        self.fetched: list[str] = []
        self.document: dict[str, Any] = {"keys": FIXTURE["keys"]}

    def __call__(self, url: str) -> dict[str, Any]:
        self.fetched.append(url)
        return self.document


@pytest.fixture
def jwks() -> Jwks:
    return Jwks()


@pytest.fixture
def verifier(jwks: Jwks) -> Verifier:
    return Verifier(REGION, POOL, CLIENT, fetch=jwks, now=lambda: T0)


def _event(token: str | None) -> dict[str, Any]:
    event: dict[str, Any] = {"type": "REQUEST", "methodArn": METHOD_ARN, "requestContext": {"requestId": "r1"}}
    if token is not None:
        event["queryStringParameters"] = {"token": token}
    return event


def test_authorizer_accepts_a_valid_access_token(verifier: Verifier, jwks: Jwks) -> None:
    out = authorizer.authorize(_event(sign(claims())), verifier)
    assert out == {
        "principalId": USER,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [{"Action": "execute-api:Invoke", "Effect": "Allow", "Resource": METHOD_ARN}],
        },
        "context": {"sub": USER},
    }
    assert jwks.fetched == [f"{ISSUER}/.well-known/jwks.json"]


@pytest.mark.parametrize(
    "token",
    [
        sign(claims(iss="https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_Other")),
        sign(claims(client_id="someone-else")),
        sign(claims(token_use="id")),
        sign(claims(exp=int(T0))),  # exp == now: no leeway
        sign(claims(exp=int(T0) - 1)),
        sign(claims(sub="")),
        sign(claims(), kid="unknown-kid"),
        sign(claims(), alg="HS256"),
        sign(claims())[:-6] + "AAAAAA",  # bad signature
        sign(claims()).replace(".", "", 1),
        "not-a-jwt",
        "",
    ],
    ids=[
        "wrong-iss",
        "wrong-client",
        "id-token",
        "exp-now",
        "expired",
        "no-sub",
        "unknown-kid",
        "hs256",
        "bad-signature",
        "malformed",
        "garbage",
        "empty",
    ],
)
def test_authorizer_rejects(verifier: Verifier, token: str) -> None:
    with pytest.raises(Exception, match=r"^Unauthorized$"):
        authorizer.authorize(_event(token), verifier)


def test_authorizer_rejects_a_payload_changed_after_signing(verifier: Verifier) -> None:
    header, _, signature = sign(claims()).split(".")
    forged = _b64(json.dumps(claims(sub=OTHER)).encode())
    with pytest.raises(Exception, match=r"^Unauthorized$"):
        authorizer.authorize(_event(f"{header}.{forged}.{signature}"), verifier)


def test_authorizer_rejects_a_missing_token(verifier: Verifier) -> None:
    with pytest.raises(Exception, match=r"^Unauthorized$"):
        authorizer.authorize(_event(None), verifier)


def test_unknown_kid_refetches_the_keys_once(verifier: Verifier, jwks: Jwks) -> None:
    authorizer.authorize(_event(sign(claims())), verifier)
    with pytest.raises(Exception, match="Unauthorized"):
        authorizer.authorize(_event(sign(claims(), kid="rotated")), verifier)
    assert len(jwks.fetched) == 2


def test_keys_are_cached_for_an_hour(jwks: Jwks) -> None:
    clock = {"now": T0}
    v = Verifier(REGION, POOL, CLIENT, fetch=jwks, now=lambda: clock["now"])
    v.verify(sign(claims(exp=int(T0) + 7200, jti="a")))
    clock["now"] = T0 + 1800
    v.verify(sign(claims(exp=int(T0) + 7200, jti="b")))
    assert len(jwks.fetched) == 1
    clock["now"] = T0 + 3700
    v.verify(sign(claims(exp=int(T0) + 7200, jti="c")))
    assert len(jwks.fetched) == 2


def test_valid_tokens_are_cached_until_they_expire(jwks: Jwks) -> None:
    clock = {"now": T0}
    v = Verifier(REGION, POOL, CLIENT, fetch=jwks, now=lambda: clock["now"])
    token = sign(claims())
    assert v.verify(token) == USER
    jwks.document = {"keys": []}  # a cached token needs no key lookup
    clock["now"] = T0 + 600
    assert v.verify(token) == USER
    clock["now"] = T0 + 900
    with pytest.raises(authorizer.Unauthorized):
        v.verify(token)


def test_jwks_errors_deny(jwks: Jwks) -> None:
    def broken(url: str) -> dict[str, Any]:
        raise OSError("down")

    v = Verifier(REGION, POOL, CLIENT, fetch=broken, now=lambda: T0)
    with pytest.raises(Exception, match=r"^Unauthorized$"):
        authorizer.authorize(_event(sign(claims())), v)


def test_authorizer_never_logs_the_token(verifier: Verifier, capsys: pytest.CaptureFixture[str]) -> None:
    good, bad = sign(claims()), sign(claims(client_id="x"))
    authorizer.authorize(_event(good), verifier)
    with pytest.raises(Exception, match="Unauthorized"):
        authorizer.authorize(_event(bad), verifier)
    logged = capsys.readouterr().out
    assert logged
    for token in (good, bad):
        for part in token.split("."):
            assert part not in logged


def test_small_keys_are_refused() -> None:
    assert not authorizer.rs256_valid(authorizer.RsaKey(n=(1 << 1023) + 1, e=65537), b"x", b"\x00" * 128)


# --- cf-prod-ws ----------------------------------------------------------------------------------------------------


@pytest.fixture
def management() -> FakeManagement:
    return FakeManagement()


@pytest.fixture
def ws_deps(store: db.Store, management: FakeManagement) -> ws.WsDeps:
    return ws.WsDeps(store=store, management=management, clock=Clock())


def _ws_event(
    route: str, *, sub: str | None = USER, body: str | None = None, connection: str = "conn-1"
) -> dict[str, Any]:
    context: dict[str, Any] = {"routeKey": route, "connectionId": connection, "requestId": "r"}
    if sub:
        context["authorizer"] = {"sub": sub, "principalId": sub}
    event: dict[str, Any] = {"requestContext": context}
    if body is not None:
        event["body"] = body
    return event


def test_connect_stores_the_connection(ws_deps: ws.WsDeps, table: FakeTable) -> None:
    assert ws.handle(_ws_event("$connect"), ws_deps) == {"statusCode": 200}
    item = table.raw(db.user_pk(USER), "CONN#conn-1")
    assert item == {
        "pk": f"USER#{USER}",
        "sk": "CONN#conn-1",
        "gsi1pk": "CONN#conn-1",
        "gsi1sk": "CONN",
        "type": "conn",
        "userId": USER,
        "connectionId": "conn-1",
        "connectedAt": "2026-11-15T12:00:00.000Z",
        "ttl": int(NOW.timestamp()) + 7200,
    }


def test_connect_without_an_authorized_sub_is_refused(ws_deps: ws.WsDeps, table: FakeTable) -> None:
    assert ws.handle(_ws_event("$connect", sub=None), ws_deps)["statusCode"] == 401
    assert table.items == {}


def test_disconnect_removes_the_connection(ws_deps: ws.WsDeps, table: FakeTable) -> None:
    ws.handle(_ws_event("$connect"), ws_deps)
    assert ws.handle(_ws_event("$disconnect"), ws_deps) == {"statusCode": 200}
    assert table.items == {}


def test_disconnect_without_sub_finds_the_owner_through_gsi1(ws_deps: ws.WsDeps, table: FakeTable) -> None:
    ws.handle(_ws_event("$connect"), ws_deps)
    ws.handle(_ws_event("$connect", connection="conn-2"), ws_deps)
    assert ws.handle(_ws_event("$disconnect", sub=None), ws_deps) == {"statusCode": 200}
    assert list(table.items) == [(db.user_pk(USER), "CONN#conn-2")]


def test_disconnect_always_answers_200(ws_deps: ws.WsDeps, table: FakeTable) -> None:
    table.fail_queries = True
    assert ws.handle(_ws_event("$disconnect", sub=None), ws_deps) == {"statusCode": 200}


def test_ping_gets_a_pong(ws_deps: ws.WsDeps, management: FakeManagement) -> None:
    assert ws.handle(_ws_event("$default", body='{"action":"ping"}'), ws_deps) == {"statusCode": 200}
    assert management.sent == [("conn-1", {"type": "pong", "at": "2026-11-15T12:00:00.000Z"})]


@pytest.mark.parametrize("body", ['{"action":"subscribe"}', "not json", "[]", None, "x" * 5000])
def test_anything_else_gets_bad_request(ws_deps: ws.WsDeps, management: FakeManagement, body: str | None) -> None:
    assert ws.handle(_ws_event("$default", body=body), ws_deps) == {"statusCode": 200}
    assert management.sent == [("conn-1", {"type": "error", "code": "bad_request"})]


def test_ping_to_a_gone_connection_is_fine(ws_deps: ws.WsDeps, management: FakeManagement) -> None:
    management.gone.add("conn-1")
    assert ws.handle(_ws_event("$default", body='{"action":"ping"}'), ws_deps) == {"statusCode": 200}


# --- cf-prod-broadcast ---------------------------------------------------------------------------------------------


def _ddb(value: Any) -> dict[str, Any]:
    """A DynamoDB stream attribute value (the low-level typed form)."""
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, int | float):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [_ddb(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _ddb(v) for k, v in value.items()}}
    raise TypeError(value)


def _record(
    item: dict[str, Any], *, event: str = "MODIFY", seq: str = "1", old: dict[str, Any] | None = None
) -> dict[str, Any]:
    data: dict[str, Any] = {"Keys": {"pk": {"S": item["pk"]}, "sk": {"S": item["sk"]}}, "SequenceNumber": seq}
    if event != "REMOVE":
        data["NewImage"] = {k: _ddb(v) for k, v in item.items()}
    if old is not None or event == "REMOVE":
        data["OldImage"] = {k: _ddb(v) for k, v in (old or item).items()}
    return {"eventName": event, "dynamodb": data}


def _job(**fields: Any) -> dict[str, Any]:
    return {
        "pk": f"USER#{USER}",
        "sk": "JOB#J1",
        "type": "job",
        "userId": USER,
        "jobId": "J1",
        "status": "running",
        "progress": 0.5,
        "sessionId": "cfjob-secret-session",
        "heartbeatAt": "2026-11-15T12:00:00.000Z",
        "flowRun": 1,
        "flowExecutionArn": "arn:aws:lambda:...",
        **fields,
    }


@pytest.fixture
def bc_deps(store: db.Store, management: FakeManagement) -> broadcast.BroadcastDeps:
    store.put({"pk": db.user_pk(USER), "sk": "CONN#c1", "type": "conn", "userId": USER, "connectionId": "c1"})
    store.put({"pk": db.user_pk(USER), "sk": "CONN#c2", "type": "conn", "userId": USER, "connectionId": "c2"})
    store.put({"pk": db.user_pk(OTHER), "sk": "CONN#o1", "type": "conn", "userId": OTHER, "connectionId": "o1"})
    return broadcast.BroadcastDeps(store=store, management=management, deserialize=broadcast._deserializer())


def test_broadcast_coalesces_heartbeats_and_hides_internal_fields(
    bc_deps: broadcast.BroadcastDeps, management: FakeManagement
) -> None:
    records = [
        _record(_job(progress=0.1), seq="1"),
        _record(_job(progress=0.2), seq="2"),
        _record(_job(progress=0.3), seq="3"),
    ]
    assert broadcast.process({"Records": records}, bc_deps) == {"batchItemFailures": []}
    assert [c for c, _ in management.sent] == ["c1", "c2"]
    message = management.sent[0][1]
    assert message["type"] == "job"
    assert message["op"] == "upsert"
    assert message["id"] == "J1"
    assert message["item"]["progress"] == 0.3
    for hidden in ("pk", "sk", "type", "userId", "sessionId", "heartbeatAt", "flowRun", "flowExecutionArn"):
        assert hidden not in message["item"]


@pytest.mark.parametrize(
    ("sk", "kind", "id_field", "internal"),
    [
        ("CLIP#C1", "clip", "clipId", ("videoKey", "coverKey", "publishState", "postsCreated", "flowExecutionArn")),
        ("POST#P1", "post", "postId", ("gsi1pk", "createdAt")),
        ("LEARNING#L1", "learning", "learningId", ("userId",)),
    ],
)
def test_broadcast_type_mapping(
    bc_deps: broadcast.BroadcastDeps,
    management: FakeManagement,
    sk: str,
    kind: str,
    id_field: str,
    internal: tuple[str, ...],
) -> None:
    item_id = sk.split("#", 1)[1]
    item = {
        "pk": f"USER#{USER}",
        "sk": sk,
        "type": kind,
        "userId": USER,
        id_field: item_id,
        "status": "review",
        "videoKey": "jobs/x/clip.mp4",
        "coverKey": "jobs/x/cover.jpg",
        "publishState": "started",
        "postsCreated": True,
        "flowExecutionArn": "arn",
        "gsi1pk": "CLIP#C1",
        "createdAt": "2026-11-15T12:00:00.000Z",
        "text": "t",
    }
    broadcast.process({"Records": [_record(item, event="INSERT")]}, bc_deps)
    message = management.sent[0][1]
    assert (message["type"], message["op"], message["id"]) == (kind, "upsert", item_id)
    for hidden in internal:
        assert hidden not in message["item"]
    assert "videoUrl" not in message["item"]
    assert "coverUrl" not in message["item"]


def test_broadcast_delete_uses_the_old_image(bc_deps: broadcast.BroadcastDeps, management: FakeManagement) -> None:
    broadcast.process({"Records": [_record(_job(), event="REMOVE")]}, bc_deps)
    assert management.sent[0][1] == {"type": "job", "op": "delete", "id": "J1"}


def test_broadcast_only_reaches_the_owner(bc_deps: broadcast.BroadcastDeps, management: FakeManagement) -> None:
    other_job = _job(pk=f"USER#{OTHER}", userId=OTHER, jobId="J9", sk="JOB#J9")
    broadcast.process({"Records": [_record(other_job)]}, bc_deps)
    assert [c for c, _ in management.sent] == ["o1"]


def test_broadcast_ignores_other_items(bc_deps: broadcast.BroadcastDeps, management: FakeManagement) -> None:
    records = [
        _record({"pk": f"USER#{USER}", "sk": "CONN#c3", "type": "conn"}),
        _record({"pk": "HOOK#youtube", "sk": "HOOK#H1", "type": "hook"}),
        _record({"pk": f"USER#{USER}", "sk": "SETTINGS", "type": "settings"}),
        {"eventName": "MODIFY", "dynamodb": {}},
    ]
    assert broadcast.process({"Records": records}, bc_deps) == {"batchItemFailures": []}
    assert management.sent == []


def test_broadcast_cleans_up_gone_connections(
    bc_deps: broadcast.BroadcastDeps, management: FakeManagement, table: FakeTable
) -> None:
    management.gone.add("c1")
    management.broken.add("c2")  # another error: logged and skipped, the connection stays
    out = broadcast.process({"Records": [_record(_job())]}, bc_deps)
    assert out == {"batchItemFailures": []}
    assert table.raw(db.user_pk(USER), "CONN#c1") is None
    assert table.raw(db.user_pk(USER), "CONN#c2") is not None


def test_broadcast_large_item_is_sent_as_partial(bc_deps: broadcast.BroadcastDeps, management: FakeManagement) -> None:
    big = _job(notes="x" * 30_000)
    broadcast.process({"Records": [_record(big)]}, bc_deps)
    assert management.sent[0][1] == {"type": "job", "op": "upsert", "id": "J1", "partial": True}


def test_broadcast_reports_records_only_when_the_query_fails(
    bc_deps: broadcast.BroadcastDeps, management: FakeManagement, table: FakeTable
) -> None:
    table.fail_queries = True
    out = broadcast.process({"Records": [_record(_job(), seq="11"), _record(_job(), seq="12")]}, bc_deps)
    assert out == {"batchItemFailures": [{"itemIdentifier": "11"}, {"itemIdentifier": "12"}]}
    assert management.sent == []
