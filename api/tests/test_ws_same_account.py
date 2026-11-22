"""Clip Factory Stories has different accounts than Clip Factory (docs/CONTRACTS.md §45.37 G8; the owner's hard rule,
22 Nov 19:01: "I do not want videos generated in lamo stories … uploaded to the same accounts as clip factory thats a
hard no").

Per platform, the same account by **each** identity the platform gives (YouTube the channel id; Facebook the Page id;
Instagram the account id and the username; TikTok the open id and the username; X the user id and the handle) is
refused at connect and before every upload, also when Clip Factory connects it after Lamo Stories did. No route or
screen offers sharing an account."""

from __future__ import annotations

import json
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.oauth import setup as clips_setup
from clipfactory_api.oauth.providers import Linked
from clipfactory_api.workspaces import social
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.destinations import DestinationProblem, validate_destination
from clipfactory_api.workspaces.routes import ROUTES
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from conftest import NOW, USER, Call
from fakes import FakeSecretsManager, FakeTable
from test_oauth_state_formats import GOOD

# (platform, what matches, Clip Factory's ACCOUNT# fields, Lamo Stories' identity, its handle)
CASES: list[tuple[str, str, dict[str, Any], str, str]] = [
    ("youtube", "channel id", {"accountId": "UC-SAME"}, "UC-SAME", "@lamostories"),
    ("facebook", "page id", {"accountId": "p-same"}, "p-same", "Lamo Stories Page"),
    ("instagram", "account id", {"accountId": "1799"}, "1799", "@lamo.stories"),
    ("instagram", "username", {"accountId": "1784", "handle": "@Lamo.Clips"}, "1799", "@lamo.clips"),
    ("tiktok", "open id", {"accountId": "open-same"}, "open-same", "@lamostories"),
    ("tiktok", "username", {"accountId": "open-1", "handle": "@lamo.clips"}, "open-other-app", "@Lamo.Clips"),
    ("x", "user id", {"accountId": "42"}, "42", "@lamostories"),
    ("x", "handle", {"accountId": "41", "handle": "@LamoClips"}, "77", "@lamoclips"),
]
IDS = [f"{c[0]}-{c[1].replace(' ', '-')}" for c in CASES]


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


def _scope(store: db.Store, secrets_client: FakeSecretsManager) -> social.Scope:
    return social.Scope(store, WorkspaceSecrets(secrets_client), USER, "stories")


def _linked(platform: str, identity: str, handle: str) -> Linked:
    token = {**sup.TOKENS[platform], ws.SECRET_IDENTITY[platform]: identity}
    account = {"accountId": identity, "handle": handle, "name": "Lamo", "scopes": []}
    return Linked("connected", token=token, account=account)


@pytest.mark.parametrize(("platform", "what", "clips", "identity", "handle"), CASES, ids=IDS)
def test_clip_factorys_account_is_refused_at_connect(
    store: db.Store, secrets_client: FakeSecretsManager, platform: str, what: str, clips: dict[str, Any],
    identity: str, handle: str
) -> None:  # fmt: skip
    sup.workspace(store)
    sup.clips_account(store, None, platform, **clips)
    saved = social.save_connected(
        _scope(store, secrets_client),
        platform,
        _linked(platform, identity, handle),
        app_client_id=GOOD[platform]["clientId"],
        now=NOW,
    )
    assert saved["connectionStatus"] == "same_as_clips", what
    shown = social.public_account(saved, "stories", platform, clips=social.clips_identity(store, USER, platform))
    assert (shown["connectionStatus"], shown["warning"]) == ("same_as_clips", social.SAME_AT_CONNECT)
    assert shown["sharedWithClips"] is False


@pytest.mark.parametrize(("platform", "what", "clips", "identity", "handle"), CASES, ids=IDS)
def test_clip_factorys_account_is_refused_before_every_upload_also_when_it_connects_later(
    app: App, call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, platform: str,
    what: str, clips: dict[str, Any], identity: str, handle: str
) -> None:  # fmt: skip
    sup.ready(store, secrets_client)
    sup.install(app, secrets_client, sup.FakeStarter())
    sup.social(store, secrets_client, platform, identity=identity, handle=handle)
    job = sup.pubjob(store, platform, externalAccountId=identity)
    secrets = WorkspaceSecrets(secrets_client)
    assert validate_destination(store, secrets, USER, "stories", job).external_account_id == identity
    clips_before = json.dumps(sorted((i for i in table.all() if i["pk"] == f"USER#{USER}"), key=str), default=str)
    sup.clips_account(store, None, platform, **clips)  # Clip Factory connects that very account later
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, secrets, USER, "stories", job)
    assert (stopped.value.rule, stopped.value.kind) == (5, "same_as_clips"), what
    assert "Clip Factory's own account" in stopped.value.sentence
    # an old "Use it for both" changes nothing
    store.update(sup.PK, f"SOCIAL#{platform}", {"sharedWithClips": True, "sharedExternalAccountId": identity})
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, USER, "stories", job)
    # the card says why, and Clip Factory's own items were only read
    status, body = call("GET", "/v1/workspaces/stories/social")
    assert status == 200
    shown = next(a for a in body["accounts"] if a["platform"] == platform)
    assert (shown["connectionStatus"], shown["reason"], shown["warning"]) == (
        "same_as_clips",
        "clips_now",
        "This is Clip Factory's account now. Connect a different account made for Clip Factory Stories.",
    )
    after = [i for i in table.all() if i["pk"] == f"USER#{USER}" and not str(i["sk"]).startswith("ACCOUNT#")]
    assert json.dumps(sorted(after, key=str), default=str) == json.dumps(
        sorted((i for i in json.loads(clips_before) if not str(i["sk"]).startswith("ACCOUNT#")), key=str), default=str
    )


def _options(platform: str) -> dict[str, Any]:
    if platform != "tiktok":
        return {}
    return {
        "options": {
            "privacyLevel": "SELF_ONLY",
            "disableComment": False,
            "disableDuet": False,
            "disableStitch": False,
            "brandContent": False,
            "brandOrganic": False,
        }
    }


def _clip_factory_lets_go(store: db.Store, platform: str) -> None:
    """Clip Factory disconnects (or its app keys change): its ACCOUNT# reads ``not_connected`` with no id or handle."""
    clips_setup.put_account(store, USER, platform, "not_connected", now=NOW)


@pytest.mark.parametrize(("platform", "what", "clips", "identity", "handle"), CASES, ids=IDS)
def test_clip_factorys_account_stays_refused_once_clip_factory_disconnects_it(
    app: App, call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, platform: str,
    what: str, clips: dict[str, Any], identity: str, handle: str
) -> None:  # fmt: skip
    """The reviewer's G8 blocker: Clip Factory connected, Lamo Stories connects the same account, Clip Factory then
    disconnects it. It stays refused at GET, at the tap and in the story flow, and no token of it is ever kept."""
    sup.ready(store, secrets_client)
    sup.install(app, secrets_client, sup.FakeStarter())
    sup.clips_account(store, None, platform, **clips)
    sup.social(store, secrets_client, platform, identity="old-one", handle="@old.one")  # an earlier, own account
    token_name = f"cf-prod/workspaces/stories/{platform}/token"
    assert token_name in secrets_client.values
    saved = social.save_connected(
        _scope(store, secrets_client),
        platform,
        _linked(platform, identity, handle),
        app_client_id=GOOD[platform]["clientId"],
        now=NOW,
    )
    assert saved["connectionStatus"] == "same_as_clips", what
    assert token_name not in secrets_client.values  # Lamo Stories keeps no way into Clip Factory's account
    clips_items = [i for i in table.all() if i["pk"] == f"USER#{USER}" and str(i["sk"]).startswith("ACCOUNT#")]
    _clip_factory_lets_go(store, platform)
    assert social.clips_identity(store, USER, platform) == social.NO_CLIPS
    # GET (and the settle it runs) keeps it Clip Factory's
    for _ in range(2):
        status, body = call("GET", "/v1/workspaces/stories/social")
        assert status == 200
        shown = next(a for a in body["accounts"] if a["platform"] == platform)
        assert shown["connectionStatus"] == "same_as_clips", what
        assert store.get(sup.PK, f"SOCIAL#{platform}")["connectionStatus"] == "same_as_clips"
        assert social.MATCHED not in json.dumps(body)  # the remembered identities are never returned
    # the tap
    status, body = call(
        "POST",
        f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish",
        {"targets": [{"platform": platform, "socialAccountId": f"stories.{platform}", **_options(platform)}]},
    )
    assert status == 409, body
    # the story flow, even if the item were turned back by hand and a token put back
    store.update(sup.PK, f"SOCIAL#{platform}", {"connectionStatus": "connected"}, remove=["reason"])
    secrets_client.values[token_name] = json.dumps(_linked(platform, identity, handle).token)
    job = sup.pubjob(store, platform, job_id="01JZ0000000000000000000PJ7", externalAccountId=identity)
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", job)
    assert (stopped.value.rule, stopped.value.kind) == (5, "same_as_clips"), what
    from clipfactory_api.flows.story_flow import run_story_flow
    from conftest import Clock
    from fakes import FakeDurableContext, FakeHttp

    http = FakeHttp()
    run_story_flow(
        FakeDurableContext(),
        sup.flow_event("01JZ0000000000000000000PJ7"),
        sup.flow_deps(store, secrets_client, http, Clock(NOW)),
    )
    assert http.calls == []  # nothing was sent
    ended = table.raw(sup.PK, "PUBJOB#01JZ0000000000000000000PJ7")
    assert ended is not None
    assert ended["publishingStatus"] == "needs_attention"
    # Clip Factory's own items were only read
    after = [i for i in table.all() if i["pk"] == f"USER#{USER}" and str(i["sk"]).startswith("ACCOUNT#")]
    assert len(after) == len(clips_items)


@pytest.mark.parametrize(("platform", "what", "clips", "identity", "handle"), CASES, ids=IDS)
def test_an_account_clip_factory_took_later_stays_refused_after_it_lets_go(
    store: db.Store, secrets_client: FakeSecretsManager, platform: str, what: str, clips: dict[str, Any],
    identity: str, handle: str
) -> None:  # fmt: skip
    """Lamo Stories connected first; Clip Factory connects that account later (found before an upload, with no GET in
    between), then disconnects it. Still refused, and connecting that very account again is refused at connect."""
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, platform, identity=identity, handle=handle)
    job = sup.pubjob(store, platform, externalAccountId=identity)
    secrets = WorkspaceSecrets(secrets_client)
    sup.clips_account(store, None, platform, **clips)
    with pytest.raises(DestinationProblem):
        validate_destination(store, secrets, USER, "stories", job)
    stored = store.get(sup.PK, f"SOCIAL#{platform}")
    assert stored is not None
    assert (stored["connectionStatus"], stored["reason"]) == ("same_as_clips", "clips_now")
    _clip_factory_lets_go(store, platform)
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, secrets, USER, "stories", job)
    assert stopped.value.kind == "same_as_clips", what
    again = social.save_connected(
        _scope(store, secrets_client),
        platform,
        _linked(platform, identity, handle),
        app_client_id=GOOD[platform]["clientId"],
        now=NOW,
    )
    assert again["connectionStatus"] == "same_as_clips", what
    # a different account made for Clip Factory Stories connects and posts
    fresh = _linked(platform, "brand-new-1", "@brand.new")
    if "username" in fresh.token:
        fresh.token["username"] = "brand.new"
    other = social.save_connected(
        _scope(store, secrets_client),
        platform,
        fresh,
        app_client_id=GOOD[platform]["clientId"],
        now=NOW,
    )
    assert other["connectionStatus"] == "connected"
    assert identity in other[social.MATCHED]["ids"]  # still remembered for the next connect
    job = sup.pubjob(store, platform, job_id="01JZ0000000000000000000PJ8", externalAccountId="brand-new-1")
    assert validate_destination(store, secrets, USER, "stories", job).external_account_id == "brand-new-1"


def test_the_username_inside_the_token_is_compared_too(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    """The account was saved with a display name only, but the token knows the username: still refused."""
    sup.ready(store, secrets_client)
    token = {**sup.TOKENS["x"], "username": "LamoClips"}
    sup.social(store, secrets_client, "x", handle="Lamo", token=token)
    sup.clips_account(store, None, "x", accountId="41", handle="@lamoclips")
    job = sup.pubjob(store, "x")
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", job)
    assert stopped.value.kind == "same_as_clips"


def test_a_display_name_alone_is_never_taken_for_the_same_account(
    store: db.Store, secrets_client: FakeSecretsManager
) -> None:
    """Two accounts may share a display name (and YouTube's and Facebook's names are not identities): only ids and
    "@" usernames are compared."""
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, "facebook", handle="Lamo")
    sup.clips_account(store, None, "facebook", handle="Lamo")
    job = sup.pubjob(store, "facebook")
    assert validate_destination(store, WorkspaceSecrets(secrets_client), USER, "stories", job).platform == "facebook"
    assert not social.same_account(
        "youtube", {"externalAccountId": "UC1", "handle": "@x"}, social.ClipsAccount("UC2", "x")
    )


def test_no_route_or_screen_offers_sharing_an_account(call: Call, store: db.Store) -> None:
    assert not [r for r in ROUTES if "share" in r.pattern.pattern]
    for platform in ws.PLATFORMS:
        assert call("POST", f"/v1/workspaces/stories/social/{platform}/share", {"confirm": True})[0] == 404
    assert not hasattr(social, "share")
    assert not hasattr(social, "shared_for")
    # no API sentence offers it any more (the web's Social accounts screen is the web's own test, §45.37 G8 c)
    from clipfactory_api.workspaces import onboarding, sentences

    lines = [onboarding.same_as_clips_line(p) for p in ws.PLATFORMS]
    lines += [sentences.story_sentence(p, "same_as_clips") for p in ws.PLATFORMS]
    lines += [line for p in ws.PLATFORMS for choice in ("own", "clips", None) for line in social.limits(p, choice)]
    assert [line for line in lines if "for both" in line or "same place" in line] == []
