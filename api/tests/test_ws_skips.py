"""Clips Funded's platform skips (``workspaces.skips``; the owner, 24 Nov: "if i skip on a platform setup then i dont
want to see it anywhere except in settings or social accounts tab").

A platform in the workspace's ``ONBOARD.skipped`` that is not connected is ``skipped`` on every SocialAccount, is not
counted in the setup's ``total``, and is left out of the dashboard's accounts and Needs you. Connected wins: the next
read drops the skip (one conditional put; a raced one is left for the next read). Skips are saved with the setup's own
``PATCH …/onboarding``; nothing new is stored, so a skip saved before counts at once. Clip Factory's
``setupSkipped`` and Clips Funded's skips never touch each other, and a skipped platform can never be posted to.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.workspaces import skips
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from conftest import USER, Call
from fakes import FakeSecretsManager, FakeTable
from test_ws_ai_support import dynamodb_rules  # noqa: F401 (the DynamoDB expression rules, after each test)

BASE = f"/v1/workspaces/{sup.WS}"
SOCIAL = f"{BASE}/social"
ONBOARDING = f"{BASE}/onboarding"
PUBLISH = f"{BASE}/stories/{sup.STORY_ID}/publish"
JOB = "01JZ0000000000000000000PJ1"


@pytest.fixture
def wcall(app: App) -> Call:
    """Clips Funded's own Lambda (its ``/v1/workspaces`` table)."""
    return sup.ws_call(app)


@pytest.fixture(autouse=True)
def ws_secrets(app: App, secrets_client: FakeSecretsManager) -> WorkspaceSecrets:
    sup.app_keys(secrets_client)
    sup.workspace(app.store)
    return sup.install(app, secrets_client)


def accounts(wcall: Call) -> dict[str, Any]:
    status, body = wcall("GET", SOCIAL)
    assert status == 200, body
    return {a["platform"]: a for a in body["accounts"]}


def onboarding(wcall: Call) -> dict[str, Any]:
    status, body = wcall("GET", ONBOARDING)
    assert status == 200, body
    return dict(body["onboarding"])


def states(found: dict[str, Any]) -> dict[str, str]:
    return {s["step"]: s["state"] for s in found["steps"]}


def dashboard(wcall: Call) -> dict[str, Any]:
    status, body = wcall("GET", f"{BASE}/dashboard")
    assert status == 200, body
    return dict(body["dashboard"])


def skip(wcall: Call, step: str, skipped: bool = True) -> dict[str, Any]:
    status, body = wcall("PATCH", ONBOARDING, {"step": step, "skipped": skipped})
    assert status == 200, body
    return dict(body["onboarding"])


def stored_skips(table: FakeTable) -> list[str]:
    item = table.raw(sup.PK, ws.ONBOARD_SK)
    return [str(s) for s in (item or {}).get("skipped") or []]


def test_every_account_says_whether_it_was_skipped_and_un_skip_brings_it_back(wcall: Call) -> None:
    shown = accounts(wcall)
    assert list(shown) == list(ws.PLATFORMS)
    assert {p: a["skipped"] for p, a in shown.items()} == dict.fromkeys(ws.PLATFORMS, False)
    after = skip(wcall, "x")
    assert states(after)["x"] == "skipped"
    shown = accounts(wcall)
    assert shown["x"]["skipped"] is True
    assert [p for p, a in shown.items() if a["skipped"]] == ["x"]
    # the single answers say it too (Check now, a developer-app change)
    status, body = wcall("PUT", f"{SOCIAL}/x/app", {"choice": "clips"})
    assert status == 200, body
    assert body["account"]["skipped"] is True
    # Un-skip: one PATCH, and it is back everywhere
    after = skip(wcall, "x", False)
    assert states(after)["x"] == "todo"
    assert accounts(wcall)["x"]["skipped"] is False
    assert [a["platform"] for a in dashboard(wcall)["accounts"]] == list(ws.PLATFORMS)


def test_connected_wins_and_a_platform_that_needs_the_owner_later_comes_back(
    wcall: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    sup.social(store, secrets_client, "youtube")
    after = skip(wcall, "youtube")
    # accepted, but connected wins: the step is done, the account is not skipped and the stored skip is dropped
    assert states(after)["youtube"] == "done"
    assert after["total"] == 11
    assert accounts(wcall)["youtube"]["skipped"] is False
    assert stored_skips(table) == []
    # later it needs connecting again: it is not skipped, so it is back in every list
    store.update(sup.PK, "SOCIAL#youtube", {"connectionStatus": "needs_reconnect", "reason": "token_dead"})
    shown = accounts(wcall)["youtube"]
    assert (shown["connectionStatus"], shown["skipped"]) == ("needs_reconnect", False)
    d = dashboard(wcall)
    assert "youtube" in [a["platform"] for a in d["accounts"]]
    assert [(n["platform"], n["href"]) for n in d["needsYou"]] == [("youtube", "/stories/connections/youtube")]
    assert states(onboarding(wcall))["youtube"] == "todo"


def test_the_setup_count_leaves_out_a_skipped_platform_only(wcall: Call) -> None:
    before = onboarding(wcall)
    assert (before["done"], before["total"]) == (0, 11)
    after = skip(wcall, "x")
    assert (after["done"], after["total"]) == (0, 10)
    assert len(after["steps"]) == 11  # every step is still listed, the skipped one says so
    assert states(after)["x"] == "skipped"
    skip(wcall, "x", False)
    after = skip(wcall, "video")  # a step of another kind skipped is still to do later: it counts
    assert (after["done"], after["total"]) == (0, 11)
    assert states(after)["video"] == "skipped"
    both = skip(wcall, "tiktok")
    assert (both["done"], both["total"]) == (0, 10)
    status, body = wcall("PATCH", ONBOARDING, {"step": "agents", "done": True})
    assert status == 200, body
    assert (body["onboarding"]["done"], body["onboarding"]["total"]) == (1, 10)


def test_the_dashboard_leaves_out_a_skipped_platform_and_fix_it_opens_the_platforms_page(
    wcall: Call, store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    sup.story(store, status="published")
    for platform in ("x", "tiktok"):
        sup.social(store, secrets_client, platform, status="needs_reconnect", reason="token_dead")
    error = "This {} account (Lamo Stories) needs connecting again. Open Clips Funded › Social accounts, then tap Try again."
    sup.pubjob(store, "x", JOB, publishingStatus="needs_attention", error=error.format("X"))
    sup.pubjob(store, "tiktok", "01JZ0000000000000000000PJ2", publishingStatus="needs_attention",
               error=error.format("TikTok"))  # fmt: skip
    before = dashboard(wcall)
    assert {n["platform"] for n in before["needsYou"]} == {"x", "tiktok"}
    skip(wcall, "x")
    d = dashboard(wcall)
    assert [a["platform"] for a in d["accounts"]] == ["youtube", "tiktok", "instagram", "facebook"]
    assert [n["platform"] for n in d["needsYou"]] == ["tiktok", "tiktok"]  # X's own line and its stopped post are gone
    assert [n["href"] for n in d["needsYou"]] == ["/stories/connections/tiktok"] * 2
    assert d["counts"]["needsYou"] == 2
    # it still shows on Social accounts, with its problem
    x = accounts(wcall)["x"]
    assert (x["connectionStatus"], x["skipped"]) == ("needs_reconnect", True)


def test_all_five_skipped_leaves_no_accounts_to_count(wcall: Call) -> None:
    for platform in ws.PLATFORMS:
        skip(wcall, platform)
    assert dashboard(wcall)["accounts"] == []
    found = onboarding(wcall)
    assert (found["done"], found["total"]) == (0, 6)
    assert all(a["skipped"] for a in accounts(wcall).values())


def test_a_skip_stored_before_this_counts_at_once_and_nothing_rewrites_it(
    wcall: Call, store: db.Store, table: FakeTable
) -> None:
    """Keep owner data: the owner's X skip, stored by the setup's Skip for now before skips meant anything here."""
    item = {
        "pk": sup.PK,
        "sk": ws.ONBOARD_SK,
        "type": ws.TYPE_ONBOARD,
        "userId": USER,
        "workspaceId": sup.WS,
        "stepsDone": ["agents"],
        "skipped": ["x"],
        "finishedAt": "2026-11-23T20:00:00.000Z",
        "createdAt": "2026-11-20T10:00:00.000Z",
        "updatedAt": "2026-11-23T20:00:00.000Z",
    }
    store.put(item)
    kept = json.dumps(table.raw(sup.PK, ws.ONBOARD_SK), sort_keys=True, default=str)
    assert accounts(wcall)["x"]["skipped"] is True
    found = onboarding(wcall)
    assert (found["done"], found["total"]) == (2, 10)
    assert states(found)["x"] == "skipped"
    assert "x" not in [a["platform"] for a in dashboard(wcall)["accounts"]]
    assert json.dumps(table.raw(sup.PK, ws.ONBOARD_SK), sort_keys=True, default=str) == kept


def test_clips_funded_and_clip_factory_keep_their_own_skips(
    app: App, call: Call, wcall: Call, table: FakeTable
) -> None:
    status, body = call("PUT", "/v1/settings", {"setupSkipped": ["x"]})
    assert status == 200, body
    clips_settings = json.dumps(table.raw(db.user_pk(USER), "SETTINGS"), sort_keys=True, default=str)
    # Clip Factory's X skip is not Clips Funded's
    assert accounts(wcall)["x"]["skipped"] is False
    assert onboarding(wcall)["total"] == 11
    # Clips Funded's skip is not Clip Factory's
    skip(wcall, "tiktok")
    assert accounts(wcall)["tiktok"]["skipped"] is True
    assert call("GET", "/v1/settings")[1]["settings"]["setupSkipped"] == ["x"]
    assert json.dumps(table.raw(db.user_pk(USER), "SETTINGS"), sort_keys=True, default=str) == clips_settings
    # only the workspace's own ONBOARD item holds it
    assert stored_skips(table) == ["tiktok"]
    assert table.raw(sup.PK, ws.ONBOARD_SK)["workspaceId"] == sup.WS


def test_a_skipped_platform_is_never_posted_to(
    app: App, wcall: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager
) -> None:
    starter = sup.FakeStarter()
    sup.install(app, secrets_client, starter)
    sup.ready(store, secrets_client, "youtube")
    skip(wcall, "x")
    assert accounts(wcall)["x"]["skipped"] is True
    before = sorted(str(i["sk"]) for i in table.all() if str(i["sk"]).startswith("PUBJOB#"))
    status, body = wcall("POST", PUBLISH, {"targets": [{"platform": "x", "socialAccountId": "stories.x"}]})
    assert status == 409, body
    assert sorted(str(i["sk"]) for i in table.all() if str(i["sk"]).startswith("PUBJOB#")) == before == []
    assert starter.started == []


def test_a_raced_drop_is_left_for_the_next_read(
    wcall: Call,
    store: db.Store,
    table: FakeTable,
    secrets_client: FakeSecretsManager,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    sup.social(store, secrets_client, "youtube")
    store.put({**ws_onboard(["youtube", "x"]), "updatedAt": "2026-11-15T09:00:00.000Z"})
    real = db.Store.put_when
    raced: list[str] = []

    def another_write_lands_first(self: db.Store, item: Any, condition: str, **kw: Any) -> None:
        if item.get("sk") == ws.ONBOARD_SK and not raced:
            raced.append(condition)
            table.items[(sup.PK, ws.ONBOARD_SK)]["updatedAt"] = "2026-11-15T11:59:59.000Z"
        real(self, item, condition, **kw)

    monkeypatch.setattr(db.Store, "put_when", another_write_lands_first)
    shown = accounts(wcall)  # the read still answers, right
    assert (shown["youtube"]["skipped"], shown["x"]["skipped"]) == (False, True)
    assert raced == ["#u = :before"]
    assert stored_skips(table) == ["youtube", "x"]  # the other write won; nothing was lost
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert {"level": "info", "event": "ws_skips.drop_raced"}.items() <= next(
        line for line in lines if line.get("event") == "ws_skips.drop_raced"
    ).items()
    # the next read drops it
    monkeypatch.setattr(db.Store, "put_when", real)
    assert accounts(wcall)["youtube"]["skipped"] is False
    assert stored_skips(table) == ["x"]


def test_the_pure_helpers() -> None:
    assert skips.stored(None) == []
    assert skips.stored({"skipped": ["x", "video", "tiktok", "agents"]}) == ["tiktok", "x"]
    assert skips.stored({"skipped": "x"}) == []
    assert skips.effective(["tiktok", "x"], {"tiktok": "connected", "x": "needs_reconnect"}) == frozenset({"x"})
    assert skips.effective(["youtube"], {}) == frozenset({"youtube"})
    assert skips.social_href("x") == "/stories/connections/x"
    assert skips.social_href(None) == "/stories/connections"
    assert skips.social_href("myspace") == "/stories/connections"


def ws_onboard(skipped: list[str]) -> dict[str, Any]:
    return {
        "pk": sup.PK,
        "sk": ws.ONBOARD_SK,
        "type": ws.TYPE_ONBOARD,
        "userId": USER,
        "workspaceId": sup.WS,
        "stepsDone": [],
        "skipped": skipped,
        "finishedAt": None,
        "createdAt": "2026-11-15T09:00:00.000Z",
        "updatedAt": "2026-11-15T09:00:00.000Z",
    }
