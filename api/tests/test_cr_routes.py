"""/v1/contentrewards: Connect, the connection, campaigns, the logo, submissions and money (§38.3–§38.8)."""

from __future__ import annotations

import json
import urllib.parse
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import connection, public
from conftest import USER, Call, Clock
from cr_support import (
    APP_NAME,
    CLIENT_ID,
    CMP,
    TOKEN_NAME,
    UUID,
    UUID2,
    FakeCR,
    FakeInvoker,
    listed_campaign,
    make_deps,
    page,
    public_campaign,
    response,
    secret_values,
    seed_campaign,
    seed_connection,
    seed_setup,
    signed_state,
)
from fakes import FakeS3, FakeSecretsManager

BASE = "/v1/contentrewards"
JSON_URL = f"https://contentrewards.com/api/campaign/campaigns/{UUID}"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 40


@pytest.fixture
def cr(app: App, secrets_client: FakeSecretsManager, clock: Clock) -> Any:
    public.reset_limit()
    fake = FakeCR()
    fake.answer("get_me", {"id": "cre_0123456789abcdefghjkmnpqrs"})
    deps = make_deps(app.store, secrets_client, fake, clock, media=app.media, invoker=FakeInvoker())
    app.contentrewards = deps
    return deps


def fake_of(cr: Any) -> FakeCR:
    return cr.net  # type: ignore[no-any-return]


# --- switched off ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", BASE),
        ("POST", f"{BASE}/connect"),
        ("GET", f"{BASE}/campaigns"),
        ("POST", f"{BASE}/campaigns"),
        ("GET", f"{BASE}/money"),
        ("POST", f"{BASE}/seen"),
        ("GET", f"{BASE}/submissions"),
    ],
)
def test_switched_off_answers_503(call: Call, method: str, path: str) -> None:
    status, body = call(method, path, {})
    assert status == 503
    assert body["error"] == {"code": "unavailable", "message": "Content Rewards is not switched on for this app yet."}


def test_switched_off_job_with_a_campaign_is_503(call: Call) -> None:
    status, body = call(
        "POST", "/v1/jobs", {"source": {"type": "link", "url": "https://youtube.com/watch?v=x"}, "campaignId": UUID}
    )
    assert (status, body["error"]["code"]) == (503, "unavailable")


def test_ready_needs_every_name() -> None:
    from clipfactory_api.contentrewards import deps as cr_deps

    full = {
        "CONTENT_REWARDS": "on",
        "OAUTH_STATE_SECRET": "s",
        "SECRET_PREFIX": "p",
        "CAMPAIGNS_FUNCTION_ARN": "a",
        "STATS_FUNCTION_ARN": "b",
    }
    assert cr_deps.ready(full)
    assert not cr_deps.ready({**full, "CONTENT_REWARDS": "off"})
    assert not cr_deps.ready({k: v for k, v in full.items() if k != "CONTENT_REWARDS"})
    for name in ("OAUTH_STATE_SECRET", "SECRET_PREFIX", "CAMPAIGNS_FUNCTION_ARN", "STATS_FUNCTION_ARN"):
        assert not cr_deps.ready({k: v for k, v in full.items() if k != name})


# --- Connect --------------------------------------------------------------------------------------------------------


def _start(call: Call, port: int = 47812) -> dict[str, str]:
    status, body = call("POST", f"{BASE}/connect", {"port": port})
    assert status == 200, body
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(body["authorizeUrl"]).query))


def test_connect_start(call: Call, cr: Any, secrets_client: FakeSecretsManager) -> None:
    assert call("POST", f"{BASE}/connect", {"port": 8080})[0] == 400
    q = _start(call)
    assert q["redirect_uri"] == "http://127.0.0.1:47812/"
    assert q["client_id"] == CLIENT_ID
    assert json.loads(secrets_client.values[APP_NAME])["clientId"] == CLIENT_ID
    state_items = [i for i in cr.store._table.all() if str(i["sk"]).startswith("CRSTATE#")]
    assert len(state_items) == 1
    assert set(state_items[0]) == {"pk", "sk", "type", "port", "redirectUri", "clientId", "exp", "ttl"}  # no verifier
    _start(call)
    assert sum(1 for r, _t in fake_of(cr).requests if r.url.endswith("/oauth2/register")) == 1  # registered once


def _finish(call: Call, q: dict[str, str], **extra: Any) -> tuple[int, Any]:
    body = {"state": q["state"], "code": "code123", **extra}
    return call("POST", f"{BASE}/connect/finish", body)  # type: ignore[no-any-return]


def test_connect_finish_success(call: Call, cr: Any, secrets_client: FakeSecretsManager, capsys: Any) -> None:
    q = _start(call)
    status, body = _finish(call, q, iss="https://id.contentrewards.com")
    assert status == 200
    assert body["result"] == "connected"
    conn = body["connection"]
    assert (conn["status"], conn["canSubmit"]) == ("connected", True)
    assert "ready-account" in conn["stepsDone"]
    form = fake_of(cr).token_forms()[0]
    assert form["grant_type"] == ["authorization_code"]
    assert form["redirect_uri"] == ["http://127.0.0.1:47812/"]
    assert len(form["code_verifier"][0]) == 43
    assert form["resource"] == ["https://mcp.contentrewards.com/mcp"]
    item = connection.load(cr.store, USER)
    assert json.loads(secrets_client.versions[TOKEN_NAME][item["tokenVersionId"]])["accessToken"] == "at_1"
    from clipfactory_api.clock import parse

    assert item["signInBy"] == iso(parse(item["connectedAt"]) + timedelta(days=90))  # type: ignore[operator]
    assert ("cr_check", (USER, "campaigns")) in cr.invoker.calls
    assert cr.store.get(db.CROWNERS_PK, db.user_pk(USER))
    leaks = [*list(secret_values(secrets_client)), "code123", q["state"]]
    out = capsys.readouterr().out + json.dumps(body) + json.dumps(cr.store._table.all(), default=str)
    assert not [s for s in leaks if s in out]


@pytest.mark.parametrize(
    ("token", "tools", "result", "missing"),
    [
        (
            {"scope": "org:read campaigns:read submissions:read earnings:read"},
            None,
            "read_only",
            ["my_submissions:write"],
        ),
        ({"scope": None}, None, "connected", None),  # no scope in the answer: the requested ones
        ({}, ["get_me", "list_my_campaigns"], "read_only", None),  # tools/list without create_my_submission
        (
            {"scope": "campaigns:read my_submissions:write"},
            None,
            "connected",
            ["org:read", "submissions:read", "earnings:read"],
        ),
    ],
)
def test_connect_finish_scopes(
    call: Call, cr: Any, token: dict[str, Any], tools: list[str] | None, result: str, missing: list[str] | None
) -> None:
    fake = fake_of(cr)
    fake.tokens = [fake.token_ok(**token)]
    if tools is not None:
        fake.tool_names = tools
    status, body = _finish(call, _start(call))
    assert (status, body["result"]) == (200, result)
    assert body["connection"].get("missing") == missing
    if missing and "org:read" in missing:
        assert body["connection"]["reason"] == "missing_permissions"


@pytest.mark.parametrize(
    ("extra", "result"),
    [
        ({"error": "access_denied"}, "denied"),
        (
            {"error": "access_denied", "errorDescription": "This account is not allowed to connect apps (pilot)"},
            "not_allowed",
        ),
        ({"error": "server_error", "errorDescription": "Not eligible for the MCP pilot"}, "not_allowed"),
        ({"error": "server_error"}, "error"),
    ],
)
def test_connect_finish_errors(call: Call, cr: Any, extra: dict[str, Any], result: str) -> None:
    q = _start(call)
    status, body = call("POST", f"{BASE}/connect/finish", {"state": q["state"], **extra})
    assert (status, body["result"]) == (200, result)
    assert body["connection"]["lastResult"] == result


def test_connect_finish_state_and_iss(call: Call, cr: Any, clock: Clock) -> None:
    q = _start(call)
    assert _finish(call, {"state": q["state"] + "x"})[1]["result"] == "expired"  # tampered
    nonce = q["state"].split(".")[1]
    from clipfactory_api.oauth import state as oauth_state

    other = oauth_state.sign(b"s" * 64, "youtube", nonce, int((clock.now + timedelta(minutes=5)).timestamp()))
    assert _finish(call, {"state": other})[1]["result"] == "expired"  # another "platform"
    assert _finish(call, q, iss="https://evil.example")[1]["result"] == "error"
    assert _finish(call, q)[1]["result"] == "expired"  # used once already
    q2 = _start(call)
    clock.now += timedelta(minutes=6)
    assert _finish(call, q2)[1]["result"] == "expired"
    assert signed_state("x" * 22, 1)  # the helper signs like the api


def test_connect_finish_cr_down_and_busy(call: Call, cr: Any) -> None:
    fake = fake_of(cr)
    fake.tokens = [response(502, {})]
    assert _finish(call, _start(call))[1]["result"] == "cr_down"
    connection.ensure(cr.store, USER, cr.clock.now)
    cr.store.update(db.user_pk(USER), db.CRCONN_SK, {"refreshLeaseUntil": iso(cr.clock.now + timedelta(hours=1))})
    assert _finish(call, _start(call))[1]["result"] == "busy"
    assert fake.revoked  # the new refresh token is not kept


def test_connect_with_another_account(call: Call, cr: Any, secrets_client: FakeSecretsManager) -> None:
    seed_connection(
        cr, USER, cr.clock.now, creator="cre_old", refresh="rt_old", crLinked={"youtube": False}, typeidVerified=True
    )
    _status, body = _finish(call, _start(call))
    assert body["result"] == "connected"
    item = connection.load(cr.store, USER)
    assert (item["creatorId"], item["crLinked"]) == ("cre_0123456789abcdefghjkmnpqrs", {})
    assert "typeidVerified" not in item
    assert fake_of(cr).revoked == ["rt_old"]


# --- check, patch, disconnect ---------------------------------------------------------------------------------------


def test_check_it(call: Call, cr: Any) -> None:
    status, body = call("POST", f"{BASE}/check")
    assert (status, body["check"]["code"]) == (200, "not_connected")
    seed_connection(cr, USER, cr.clock.now)
    cr.store.update(db.user_pk(USER), db.CRCONN_SK, {}, remove=["check", "lastCheckAt"])
    status, body = call("POST", f"{BASE}/check")
    assert {k: v for k, v in body["check"].items() if k != "at"} == {
        "ok": True,
        "code": "ok",
        "message": "Content Rewards answers. You're signed in.",
    }
    before = len(fake_of(cr).requests)
    assert call("POST", f"{BASE}/check")[1]["check"]["code"] == "ok"  # at most once a minute
    assert len(fake_of(cr).requests) == before


def test_patch_connection(call: Call, cr: Any) -> None:
    seed_connection(cr, USER, cr.clock.now, crLinked={"youtube": False, "x": True})
    assert call("PATCH", f"{BASE}/connection", {"said": "pilot_sent"})[1]["connection"]["pilotSentAt"]
    assert "pilotSentAt" not in call("PATCH", f"{BASE}/connection", {"said": None})[1]["connection"]
    assert call("PATCH", f"{BASE}/connection", {"step": "ready-socials", "done": True})[1]["connection"][
        "crLinked"
    ] == {"x": True}
    assert call("PATCH", f"{BASE}/connection", {"step": "Bad Id!", "done": True})[0] == 400
    assert call("PATCH", f"{BASE}/connection", {"relinked": "x"})[1]["connection"]["crLinked"] == {}
    assert call("PATCH", f"{BASE}/connection", {"relinked": "myspace"})[0] == 400
    assert call("PATCH", f"{BASE}/connection", {"finance": True})[1]["connection"]["finance"] is True
    assert "finance" not in call("PATCH", f"{BASE}/connection", {"finance": None})[1]["connection"]
    assert call("PATCH", f"{BASE}/connection", {"finance": True, "said": None})[0] == 400


def test_disconnect(call: Call, cr: Any, secrets_client: FakeSecretsManager) -> None:
    seed_connection(cr, USER, cr.clock.now, refresh="rt_live")
    seed_campaign(cr.store, USER, cr.clock.now)
    cr.store.update(db.user_pk(USER), db.CRCONN_SK, {"refreshLeaseUntil": iso(cr.clock.now + timedelta(hours=1))})
    status, body = call("DELETE", f"{BASE}/connection")
    assert (status, body["error"]["message"]) == (409, "Try again in a few seconds.")
    cr.store.update(db.user_pk(USER), db.CRCONN_SK, {}, remove=["refreshLeaseUntil"])
    assert call("DELETE", f"{BASE}/connection")[0] == 204
    assert TOKEN_NAME not in secrets_client.values
    assert fake_of(cr).revoked == ["rt_live"]
    assert connection.load(cr.store, USER)["status"] == "not_connected"
    assert cr.store.get(db.user_pk(USER), db.campaign_sk(UUID))  # campaigns stay


# --- campaigns ------------------------------------------------------------------------------------------------------


def test_add_refusals(call: Call, cr: Any) -> None:
    status, body = call("POST", f"{BASE}/campaigns", {"url": "https://contentrewards.com/c/invite/abc"})
    assert status == 400
    assert body["error"]["message"].startswith("That's an invite link.")
    assert call("POST", f"{BASE}/campaigns", {"url": "https://youtube.com/watch?v=1"})[0] == 400
    fake_of(cr).public[JSON_URL] = response(404, {"error": {"code": "NOT_FOUND"}})
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}"})
    assert (status, body["error"]["message"]) == (404, "That campaign is gone from Content Rewards. Pick another one.")
    fake_of(cr).public[JSON_URL] = response(500, {})
    fake_of(cr).public[f"https://contentrewards.com/c/campaigns/{UUID}"] = response(500, b"")
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}"})
    assert (status, body["error"]["code"]) == (503, "platform_down")


def test_add_when_not_connected(call: Call, cr: Any) -> None:
    fake_of(cr).public[JSON_URL] = public_campaign(application=False)
    seed_setup(cr.store, USER, "youtube")
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://whop.com/experiences/e/campaigns/{UUID}"})
    assert status == 201
    campaign = body["campaign"]
    assert (campaign["membership"], campaign["nextStep"]["kind"], campaign["rulesState"]) == (
        "unknown",
        "connect",
        "waiting_for_join",
    )
    assert campaign["pay"][0] == {
        "platform": "youtube",
        "per1kCents": 200,
        "perPostCents": None,
        "minPayoutCents": 1000,
        "maxPayoutCents": 35000,
        "minViews": None,
    }
    assert campaign["budget"]["leftCents"] == 850000 - 60992
    assert campaign["uploadPlaces"] == ["youtube"]
    assert campaign["type"] == "cpm"
    assert campaign["url"] == f"https://contentrewards.com/c/campaigns/{UUID}"
    assert ("brand_picture", (USER, UUID)) in cr.invoker.calls
    assert cr.store.get(db.CROWNERS_PK, db.user_pk(USER))
    status, again = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}"})
    assert status == 200  # already added: re-checked
    assert "public" not in again["campaign"]
    assert "brief" not in again["campaign"]


def test_add_connected_and_listed(call: Call, cr: Any) -> None:
    seed_connection(cr, USER, cr.clock.now)
    fake_of(cr).public[JSON_URL] = public_campaign()
    fake_of(cr).answer("list_my_campaigns", page([listed_campaign()]))
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}"})
    assert status == 201
    assert (body["campaign"]["membership"], body["campaign"]["celebrate"]) == ("in", "in")
    assert body["campaign"]["rulesState"] == "reading"
    assert ("read_campaign", (USER, UUID)) in cr.invoker.calls
    stored = cr.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert (stored["crId"], stored["idMatch"]) == (CMP, "typeid")
    assert call("POST", f"{BASE}/seen", {"key": f"in:{UUID}"}) == (200, {"ok": True})
    assert call("POST", f"{BASE}/seen", {"key": f"in:{UUID}"})[0] == 404


def test_add_application_not_listed(call: Call, cr: Any) -> None:
    seed_connection(cr, USER, cr.clock.now)
    seed_setup(cr.store, USER, "youtube")
    fake_of(cr).public[JSON_URL] = public_campaign()
    fake_of(cr).answer("list_my_campaigns", page([]))
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}"})
    campaign = body["campaign"]
    assert (campaign["membership"], campaign["nextStep"]["button"]["label"]) == ("apply_first", "Yes, I applied")
    assert campaign["rulesState"] == "reading"  # an application campaign's requirements are public
    status, body = call("PATCH", f"{BASE}/campaigns/{UUID}", {"said": "applied"})
    assert (status, body["campaign"]["membership"]) == (200, "waiting")
    body = call("PATCH", f"{BASE}/campaigns/{UUID}", {"said": None})[1]
    assert body["campaign"]["membership"] == "apply_first"
    body = call("PATCH", f"{BASE}/campaigns/{UUID}", {"said": "not_eligible"})[1]
    assert body["campaign"]["membership"] == "not_accepted"
    assert call("PATCH", f"{BASE}/campaigns/{UUID}", {"said": "maybe"})[0] == 400


def test_group_link(call: Call, cr: Any) -> None:
    fake_of(cr).public[f"https://contentrewards.com/api/campaign/campaigns/discover/{UUID}"] = {
        "data": {
            "group": {"name": "ForgeGUI", "campaigns": [{"id": UUID, "name": "Basic"}, {"id": UUID2, "name": "Pro"}]}
        }
    }
    status, body = call("POST", f"{BASE}/campaigns", {"url": f"https://contentrewards.com/c/campaigns/{UUID}?group=1"})
    assert status == 200
    assert body["group"]["name"] == "ForgeGUI"
    assert [c["campaignId"] for c in body["group"]["choices"]] == [UUID, UUID2]
    assert cr.store.get(db.user_pk(USER), db.campaign_sk(UUID)) is None  # nothing added


def test_overview_get_list_and_delete(call: Call, cr: Any, s3_client: FakeS3) -> None:
    seed_connection(cr, USER, cr.clock.now)
    seed_campaign(cr.store, USER, cr.clock.now, brandKey=f"campaigns/{USER}/{UUID}/brand.png")
    s3_client.objects[f"campaigns/{USER}/{UUID}/brand.png"] = PNG
    status, body = call("GET", BASE)
    assert status == 200
    assert set(body) == {"connection", "campaigns", "money", "waitingSends"}
    summary = body["campaigns"][0]
    assert {"campaignId", "name", "chip", "nextStepText", "hardStops", "clipCounts"} <= set(summary)
    assert summary["brandPictureUrl"].startswith("https://")
    assert fake_of(cr).requests == []  # GET /v1/contentrewards never calls CR
    assert call("GET", f"{BASE}/campaigns")[1]["campaigns"][0]["campaignId"] == UUID
    assert call("GET", f"{BASE}/campaigns/{UUID2}")[0] == 404
    fake_of(cr).public[JSON_URL] = public_campaign()
    assert call("GET", f"{BASE}/campaigns/{UUID}")[0] == 200  # a stale preview is re-read on open
    assert len(fake_of(cr).requests) == 1
    assert call("DELETE", f"{BASE}/campaigns/{UUID}")[0] == 204
    assert cr.store.get(db.user_pk(USER), db.campaign_sk(UUID)) is None
    assert f"campaigns/{USER}/{UUID}/brand.png" not in s3_client.objects


def test_check_now_rate_limit_and_pasted_rules(call: Call, cr: Any) -> None:
    seed_campaign(
        cr.store,
        USER,
        cr.clock.now,
        membership="manual",
        said="joined_by_hand",
        rulesState="waiting_for_join",
        rules=None,
    )
    fake_of(cr).public[JSON_URL] = public_campaign(application=False)
    status, body = call("POST", f"{BASE}/campaigns/{UUID}/read", {"pastedRules": "Use #FaZe in every caption."})
    assert (status, body["campaign"]["rulesState"]) == (202, "reading")
    assert ("read_campaign", (USER, UUID)) in cr.invoker.calls
    status, _body = call("POST", f"{BASE}/campaigns/{UUID}/read", {})
    assert status == 200  # at most every 30 s: the stored one
    assert call("POST", f"{BASE}/campaigns/{UUID}/read", {"pastedRules": "x" * 8001})[0] == 400


def test_anyway_takes_soft_stops_only(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, cr.clock.now)
    assert call("PATCH", f"{BASE}/campaigns/{UUID}", {"anyway": ["face_needed"]})[1]["campaign"]["anyway"] == [
        "face_needed"
    ]
    assert call("PATCH", f"{BASE}/campaigns/{UUID}", {"anyway": ["ended"]})[0] == 400
    assert call("PATCH", f"{BASE}/campaigns/{UUID}", {"anyway": ["not_connected"]})[0] == 400


# --- the logo -------------------------------------------------------------------------------------------------------


def test_logo_upload_checks(call: Call, cr: Any, s3_client: FakeS3) -> None:
    seed_campaign(cr.store, USER, cr.clock.now)
    status, body = call(
        "POST", f"{BASE}/campaigns/{UUID}/logo", {"filename": "l.svg", "contentType": "image/svg+xml", "size": 100}
    )
    assert status == 400
    assert body["error"]["message"].startswith("Clip Factory needs a PNG, JPG or WebP picture.")
    status, body = call(
        "POST",
        f"{BASE}/campaigns/{UUID}/logo",
        {"filename": "l.png", "contentType": "image/png", "size": 10 * 1024 * 1024 + 1},
    )
    assert (status, body["error"]["message"]) == (413, "That picture is too big. Use one under 10 MB.")
    status, body = call(
        "POST", f"{BASE}/campaigns/{UUID}/logo", {"filename": "l.png", "contentType": "image/png", "size": len(PNG)}
    )
    assert status == 200
    assert body["key"] == f"campaigns/{USER}/{UUID}/logo-1.png"
    assert body["headers"] == {"Content-Type": "image/png"}
    s3_client.objects[body["key"]] = b"<svg>not a png</svg>"
    status, _err = call("POST", f"{BASE}/campaigns/{UUID}/logo/done", {"key": body["key"]})
    assert status == 400
    assert body["key"] not in s3_client.objects
    s3_client.objects[body["key"]] = PNG
    status, done = call("POST", f"{BASE}/campaigns/{UUID}/logo/done", {"key": body["key"]})
    assert status == 200
    assert done["campaign"]["logo"]["state"] == "ready"
    assert done["campaign"]["logo"]["url"]
    assert call("POST", f"{BASE}/campaigns/{UUID}/logo/done", {"key": f"campaigns/{USER}/{UUID2}/logo-1.png"})[0] == 400
    assert call("DELETE", f"{BASE}/campaigns/{UUID}/logo")[1]["campaign"]["logo"]["state"] == "none"
    assert body["key"] not in s3_client.objects


def test_logo_link(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, cr.clock.now)
    status, body = call(
        "POST", f"{BASE}/campaigns/{UUID}/logo/link", {"url": "https://drive.google.com/drive/folders/AbCdEfGhIjKl"}
    )
    assert (status, body["error"]["message"]) == (
        400,
        "That's a folder. Open the logo file in it, then copy that link.",
    )
    url = "https://drive.google.com/file/d/AbCdEfGhIjKlMn/view"
    status, body = call("POST", f"{BASE}/campaigns/{UUID}/logo/link", {"url": url})
    assert (status, body["campaign"]["logo"]["state"]) == (202, "fetching")
    assert ("fetch_logo", (USER, UUID, url)) in cr.invoker.calls


# --- submissions ----------------------------------------------------------------------------------------------------

JOB = "01J0000000000000000000000J"
CLIP = "01J0000000000000000000000C"
POST = "01J0000000000000000000000P"


def _clip_and_post(cr: Any, **post: Any) -> None:
    pk = db.user_pk(USER)
    cr.store.put(
        {
            "pk": pk,
            "sk": db.job_sk(JOB),
            "type": "job",
            "jobId": JOB,
            "campaignId": UUID,
            "campaign": {"campaignId": UUID, "name": "FaZe Clips", "rules": {}},
        }
    )
    cr.store.put(
        {
            "pk": pk,
            "sk": db.clip_sk(CLIP),
            "type": "clip",
            "clipId": CLIP,
            "jobId": JOB,
            "captions": {"youtubeTitle": "He did WHAT"},
        }
    )
    cr.store.put(
        {
            "pk": pk,
            "sk": db.post_sk(POST),
            "type": "post",
            "postId": POST,
            "clipId": CLIP,
            "userId": USER,
            "gsi1pk": f"CLIP#{CLIP}",
            "gsi1sk": f"POST#{POST}",
            "platform": "youtube",
            "status": "queued",
            **post,
        }
    )


def test_submissions_made_up_and_send_by_hand(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, cr.clock.now)
    _clip_and_post(cr)
    status, body = call("GET", f"{BASE}/submissions", query={"clipId": CLIP})
    assert status == 200
    sub = body["submissions"][0]
    assert (sub["state"], sub["line"], sub["clipTitle"]) == (
        "waiting_for_post",
        "Goes to Content Rewards after it posts.",
        "He did WHAT",
    )
    assert call("GET", f"{BASE}/submissions")[0] == 400
    now = cr.clock.now
    cr.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.crsub_sk(POST),
            "type": "crsub",
            "postId": POST,
            "clipId": CLIP,
            "campaignId": UUID,
            "platform": "youtube",
            "state": "send_by_hand",
            "url": "https://youtu.be/a",
            "postedAt": iso(now - timedelta(minutes=18)),
            "sendBy": iso(now + timedelta(minutes=12)),
            "deadline": iso(now - timedelta(minutes=3)),
            "key": POST,
            "gen": 0,
        }
    )
    body = call("GET", f"{BASE}/submissions", query={"campaignId": UUID})[1]
    assert body["submissions"][0]["line"] == "Send this to Content Rewards now (12 min left)"
    assert body["submissions"][0]["minutesLeft"] == 12
    assert call("GET", BASE)[1]["waitingSends"][0]["postId"] == POST
    status, body = call("PATCH", f"{BASE}/submissions/{POST}", {"said": "sent_by_hand"})
    assert body["submission"]["state"] == "sent_by_hand"
    status, body = call("PATCH", f"{BASE}/submissions/{POST}", {"said": None})  # undo within 8 s
    assert body["submission"]["state"] == "send_by_hand"
    assert call("PATCH", f"{BASE}/submissions/{POST}", {"said": "appealed"})[0] == 409
    cr.clock.now = now + timedelta(minutes=13)
    status, body = call("POST", f"{BASE}/submissions/{POST}/send")
    assert (status, body["error"]["message"]) == (409, "Too late for this one.")


def test_try_sending_again(call: Call, cr: Any) -> None:
    seed_connection(cr, USER, cr.clock.now)
    seed_campaign(cr.store, USER, cr.clock.now)
    now = cr.clock.now
    _clip_and_post(
        cr,
        status="posted",
        url="https://youtu.be/abcDEF12345",
        postedAt=iso(now - timedelta(minutes=26)),
        privacy="public",
    )
    cr.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.crsub_sk(POST),
            "type": "crsub",
            "postId": POST,
            "clipId": CLIP,
            "campaignId": UUID,
            "crId": CMP,
            "platform": "youtube",
            "state": "send_by_hand",
            "url": "https://youtu.be/abcDEF12345",
            "postedAt": iso(now - timedelta(minutes=26)),
            "sendBy": iso(now + timedelta(minutes=4)),
            "deadline": iso(now - timedelta(minutes=1)),
            "key": POST,
            "gen": 0,
        }
    )
    fake = fake_of(cr)
    fake.answer("list_my_campaigns", page([listed_campaign()]))
    fake.answer("create_my_submission", {"id": "sub_5", "status": "pending"})
    status, body = call("POST", f"{BASE}/submissions/{POST}/send")
    assert (status, body["submission"]["state"]) == (200, "sent")
    assert fake.calls("create_my_submission")[0][2] == 25.0


def test_appeal_and_proof(call: Call, cr: Any) -> None:
    seed_campaign(cr.store, USER, cr.clock.now)
    _clip_and_post(cr, status="posted")
    now = cr.clock.now
    cr.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.crsub_sk(POST),
            "type": "crsub",
            "postId": POST,
            "clipId": CLIP,
            "campaignId": UUID,
            "platform": "youtube",
            "state": "rejected",
            "crStatus": "rejected",
            "reason": {"code": "refused", "brandSaid": "Logo missing in the first seconds."},
            "postedAt": iso(now - timedelta(days=1)),
            "proof": {"notifiedAt": iso(now), "dueAt": iso(now)},
        }
    )
    sub = call("GET", f"{BASE}/submissions", query={"clipId": CLIP})[1]["submissions"][0]
    assert sub["line"] == (
        "Not approved: “Logo missing in the first seconds.” Next time: keep the logo on screen the whole clip."
    )
    assert sub["appeal"]["href"] == "https://contentrewards.com/c/submissions"
    body = call("PATCH", f"{BASE}/submissions/{POST}", {"said": "appealed"})[1]
    assert body["submission"]["line"] == "Asked again ✓ · The answer takes 2 to 7 days."
    body = call("PATCH", f"{BASE}/submissions/{POST}", {"said": "proof_sent"})[1]
    assert body["submission"]["proof"]["doneAt"] == iso(now)


def test_submissions_check_rate_limit(call: Call, cr: Any) -> None:
    seed_connection(cr, USER, cr.clock.now)
    seed_campaign(cr.store, USER, cr.clock.now)
    _clip_and_post(cr, status="posted")
    cr.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": db.crsub_sk(POST),
            "type": "crsub",
            "postId": POST,
            "clipId": CLIP,
            "campaignId": UUID,
            "platform": "youtube",
            "state": "sent",
            "submissionId": "sub_1",
            "crStatus": "pending",
            "sentAt": iso(cr.clock.now),
        }
    )
    fake = fake_of(cr)
    fake.answer("list_my_submissions", page([{"id": "sub_1", "status": "approved", "post": {"views": 12345}}]))
    body = call("POST", f"{BASE}/submissions/check", {"clipId": CLIP})[1]
    assert body["submissions"][0]["line"] == "Approved ✓ · 12.3K views on YouTube"
    before = len(fake.requests)
    call("POST", f"{BASE}/submissions/check", {"clipId": CLIP})
    assert len(fake.requests) == before  # at most once a minute per clip


# --- money ----------------------------------------------------------------------------------------------------------


def test_money_and_refresh_limit(call: Call, cr: Any) -> None:
    status, body = call("GET", f"{BASE}/money")
    assert (status, body["state"], body["tag"]) == (200, "not_connected", "Content Rewards' numbers")
    assert call("POST", f"{BASE}/money/refresh")[0] == 409
    seed_connection(cr, USER, cr.clock.now)
    status, body = call("POST", f"{BASE}/money/refresh")
    assert (status, body["started"]) == (202, True)
    assert ("cr_check", (USER, "money")) in cr.invoker.calls
    status, body = call("POST", f"{BASE}/money/refresh")
    assert (status, body["started"]) == (200, False)
    assert body["nextAllowedAt"] == iso(cr.clock.now + timedelta(minutes=10))
    assert call("POST", f"{BASE}/seen", {"key": "money:pay_x"})[0] == 404


def test_a_request_never_undoes_a_rules_read(call: Call, cr: Any) -> None:
    """A PATCH that read the item before cf-prod-campaigns wrote the rules keeps those rules."""
    from clipfactory_api.contentrewards import campaigns, rules

    seed_campaign(cr.store, USER, cr.clock.now, rulesState="reading", rules=None)
    stale = cr.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    cr.store.update(
        db.user_pk(USER), db.campaign_sk(UUID), {"rulesState": "ready", "rules": rules.empty(), "rulesVersion": 1}
    )
    stale["anyway"] = ["face_needed"]
    campaigns.save(cr, USER, stale)
    item = cr.store.get(db.user_pk(USER), db.campaign_sk(UUID)) or {}
    assert (item["rulesState"], item["rulesVersion"], item["anyway"]) == ("ready", 1, ["face_needed"])
