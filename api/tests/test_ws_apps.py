"""The developer app choice everywhere it matters (docs/CONTRACTS.md §45.30, §45.14, ADR-79), the AI labels
(§45.14) and verify-before-publish (§45.13 "Account Management", the second request's §7).

* ``apps.app_keys`` is the one helper: no choice or missing keys is "not set up", never a fallback; Meta never reads
  Clip Factory's app; ``validate_destination``, the token refresh and the flow use the chosen app's keys only;
* with Lamo Stories' own app the limits are its own (``RATE#WS#{ws}#{platform}``, ``xMonthlyLimitUsd``), with Clip
  Factory's app they are shared (``RATE#{platform}``), on purpose;
* a story whose job used ``nova-reel`` posts only through the labelling wrappers (YouTube ``containsSyntheticMedia``,
  TikTok ``is_aigc``); Instagram, Facebook and X refuse it;
* the publish answer names the account each target goes to, and ``confirmAccount`` stops a target whose account
  changed since the owner looked.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

import ws_social_support as sup
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.flows.story_flow import run_story_flow
from clipfactory_api.oauth import OAuthEnv
from clipfactory_api.platforms.publishers import TikTokPublisher, YouTubePublisher
from clipfactory_api.stats import config
from clipfactory_api.workspaces import apps, publish
from clipfactory_api.workspaces import types as ws
from clipfactory_api.workspaces.destinations import DestinationProblem, validate_destination
from clipfactory_api.workspaces.secrets import WorkspaceSecrets
from clipfactory_api.workspaces.tokens import WorkspaceTokenProvider
from conftest import USER, Call, Clock
from fakes import FakeDurableContext, FakeHttp, FakeSecretsManager, FakeTable, client_error
from test_oauth_state_formats import GOOD

PUBLISH = f"/v1/workspaces/stories/stories/{sup.STORY_ID}/publish"
JOB_SK = "PUBJOB#01JZ0000000000000000000PJ1"
TIKTOK_OPTIONS = {
    "privacyLevel": "SELF_ONLY",
    "disableComment": False,
    "disableDuet": False,
    "disableStitch": False,
    "brandContent": False,
    "brandOrganic": False,
}
YOUTUBE_OK = [
    (200, b"", {"Location": "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=a"}),
    (201, "publish/youtube_video"),
    (200, "publish/youtube_uploaded"),
    (200, "publish/youtube_processed"),
]
YOUTUBE_NUMBERS = [
    (200, {"items": [{"id": "vid123", "statistics": {"viewCount": "100", "likeCount": "9", "commentCount": "2"}}]}),
    (403, {"error": {"code": 403}}),
]


@pytest.fixture
def call(app: App) -> Call:
    return sup.ws_call(app)


@pytest.fixture
def secrets(secrets_client: FakeSecretsManager) -> WorkspaceSecrets:
    return WorkspaceSecrets(secrets_client)


# --- the one helper ---------------------------------------------------------------------------------------------


def test_no_choice_is_not_set_up_and_never_a_fallback(
    store: db.Store, secrets: WorkspaceSecrets, secrets_client: FakeSecretsManager
) -> None:
    sup.app_keys(secrets_client)
    sup.own_keys(secrets_client, "youtube", "instagram")
    for platform in ws.PLATFORMS:
        assert apps.app_keys(store, secrets, USER, "stories", platform) is None
        with pytest.raises(apps.AppNotReady) as found:
            apps.require_app(store, secrets, USER, "stories", platform)
        assert found.value.reason == "no_choice"
    assert secrets_client.calls == []  # nothing is even read before a choice is made


def test_each_choice_reads_only_its_own_app(
    store: db.Store, secrets: WorkspaceSecrets, secrets_client: FakeSecretsManager
) -> None:
    sup.app_keys(secrets_client)
    sup.own_keys(secrets_client, *ws.PLATFORMS, keys=None)
    sup.choose_app(store, "youtube", "clips")
    sup.choose_app(store, "x", "own")
    youtube = apps.app_keys(store, secrets, USER, "stories", "youtube")
    x = apps.app_keys(store, secrets, USER, "stories", "x")
    assert youtube is not None
    assert (youtube.choice, youtube.shared, youtube.client_id) == ("clips", True, GOOD["youtube"]["clientId"])
    assert x is not None
    assert (x.choice, x.shared) == ("own", False)
    assert [name for _, name in secrets_client.calls] == [
        "cf-prod/platforms/youtube/app",
        "cf-prod/workspaces/stories/x/app",
    ]


def test_meta_never_reads_clip_factorys_app(store: db.Store, secrets: WorkspaceSecrets) -> None:
    sup.choose_app(store, "facebook", "clips")
    assert apps.choice_of("facebook", {"app": {"choice": "clips"}}) is None
    assert apps.app_keys(store, secrets, USER, "stories", "facebook") is None
    with pytest.raises(ValueError, match="never uses Clip Factory"):
        secrets.clips_app_keys("instagram")
    assert apps.choices("instagram") == ("own",)
    assert apps.choices("tiktok") == ("own", "clips")


def test_an_unreadable_clip_factory_app_key_is_not_set_up(store: db.Store, secrets_client: FakeSecretsManager) -> None:
    class Denied(FakeSecretsManager):
        def get_secret_value(self, SecretId: str, VersionId: str | None = None) -> dict[str, Any]:
            raise client_error("AccessDeniedException", 400)

    sup.choose_app(store, "tiktok", "clips")
    assert apps.app_keys(store, WorkspaceSecrets(Denied()), USER, "stories", "tiktok") is None


def test_the_own_apps_environment_keeps_every_field_but_the_redirect(oauth_env: OAuthEnv) -> None:
    import dataclasses

    own = apps.oauth_env_for(oauth_env, "own", sup.STORIES_CALLBACK)
    for field in dataclasses.fields(OAuthEnv):
        assert getattr(own, field.name) is getattr(oauth_env, field.name), field.name
    assert own.redirect_uri("x") == f"{sup.STORIES_CALLBACK}/x/callback"
    assert oauth_env.redirect_uri("x").endswith("/v1/oauth/x/callback")
    assert apps.oauth_env_for(oauth_env, "clips") is oauth_env
    with pytest.raises(apps.CallbackOff):
        apps.oauth_env_for(oauth_env, "own", "")


def test_own_rate_counters_never_touch_clip_factorys(store: db.Store, table: FakeTable) -> None:
    own = apps.rate_store(store, "own", "stories", "x")
    assert apps.rate_store(store, "clips", "stories", "x") is store
    own.update_expr("RATE#x", "BUDGET", "SET #a = :a", names={"#a": "monthUsd"}, values={":a": 1})
    assert own.get("RATE#x", "BUDGET") == {"pk": "RATE#WS#stories#x", "sk": "BUDGET", "monthUsd": 1}
    assert store.get("RATE#x", "BUDGET") is None
    with pytest.raises(ValueError, match="only this platform"):
        own.get("RATE#youtube", "BUDGET")
    with pytest.raises(ValueError, match="only this platform"):
        own.get(db.user_pk(USER), "ACCOUNT#x")
    with pytest.raises(AttributeError):
        own.put({"pk": "RATE#x", "sk": "BUDGET"})  # type: ignore[attr-defined]


def test_the_own_x_limit_is_the_workspace_setting() -> None:
    cfg = config.load()
    assert apps.rates_config(cfg, "clips", {"configuration": {"xMonthlyLimitUsd": 3}}) is cfg
    assert apps.rates_config(cfg, "own", {"configuration": {"xMonthlyLimitUsd": None}}) is cfg  # the default cap
    own = apps.rates_config(cfg, "own", {"configuration": {"xMonthlyLimitUsd": 3}})
    assert own.platform("x").budget["monthlyUsd"] == 3.0
    assert cfg.platform("x").budget["monthlyUsd"] != 3.0  # Clip Factory's config is never changed
    assert own.platform("youtube") == cfg.platform("youtube")


# --- validate_destination and the token refresh follow the choice -----------------------------------------------


def test_rule_3_uses_the_chosen_app(
    store: db.Store, secrets: WorkspaceSecrets, secrets_client: FakeSecretsManager
) -> None:
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, "x", choice="own")
    job = {"platform": "x", "contentId": sup.STORY_ID, "socialAccountId": "stories.x", "externalAccountId": "77"}
    found = validate_destination(store, secrets, USER, "stories", job)
    assert (found.app.choice, found.app.client_id) == ("own", GOOD["x"]["clientId"])
    secrets_client.values["cf-prod/platforms/x/app"] = json.dumps({**GOOD["x"], "clientId": "other-app-12345678901"})
    assert validate_destination(store, secrets, USER, "stories", job).app.choice == "own"  # the other app never counts
    sup.own_keys(secrets_client, "x", keys={**GOOD["x"], "clientId": "own-new-app-123456789"})
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, secrets, USER, "stories", job)
    assert (stopped.value.rule, stopped.value.kind) == (3, "keys_changed")
    sup.social(store, secrets_client, "facebook", choice=None)  # connected once, choice gone: not set up
    job = {**job, "platform": "facebook", "socialAccountId": "stories.facebook", "externalAccountId": "p9"}
    with pytest.raises(DestinationProblem) as stopped:
        validate_destination(store, secrets, USER, "stories", job)
    assert stopped.value.kind == "keys_changed"
    assert not [c for c in secrets_client.calls if c[1].startswith("cf-prod/platforms/facebook")]


def test_a_refresh_uses_the_own_apps_keys(
    store: db.Store, oauth_env: OAuthEnv, secrets: WorkspaceSecrets, secrets_client: FakeSecretsManager, http: FakeHttp
) -> None:
    sup.workspace(store)
    expiring = {**sup.TOKENS["youtube"], "expiresAt": "2026-11-15T11:00:00.000Z"}
    sup.social(store, secrets_client, "youtube", choice="own", token=expiring)
    sup.own_keys(secrets_client, "youtube", keys={**GOOD["youtube"], "clientSecret": "GOCSPX-" + "O" * 28})
    http.answers.append((200, {"access_token": "ya29.NEW", "expires_in": 3599}))
    creds = WorkspaceTokenProvider(store, oauth_env, secrets, USER, "stories").credentials("youtube")
    assert creds.access_token == "ya29.NEW"
    sent = http.calls[0].body.decode()
    assert "GOCSPX-" + "O" * 28 in sent  # the own app's secret, never Clip Factory's
    assert ("get", "cf-prod/platforms/youtube/app") not in secrets_client.calls


# --- the flow: limits follow the app ----------------------------------------------------------------------------


def _own_x(store: db.Store, secrets_client: FakeSecretsManager, limit: float | None) -> None:
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, "x", choice="own")
    sup.pubjob(store, "x", appChoice="own")
    store.update(
        ws.registry_pk(USER),
        ws.workspace_sk("stories"),
        {"configuration": {**sup.workspace(store)["configuration"], "xMonthlyLimitUsd": limit}},
    )


def test_an_own_x_app_counts_on_its_own_limit_and_stops_at_it(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    _own_x(store, secrets_client, 5)
    store.put({"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 9.99, "version": 1})
    shared = store.get("RATE#x", "BUDGET")
    store.put({"pk": "RATE#WS#stories#x", "sk": "BUDGET", "monthKey": "2026-11", "monthUsd": 4.99, "version": 3})
    http = FakeHttp()
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert (job["publishingStatus"], job["error"]) == (
        "needs_attention",
        "Funded Clips stopped X: this month's Funded Clips X limit is used up. Try again next month.",
    )
    assert http.calls == []
    assert store.get("RATE#x", "BUDGET") == shared  # Clip Factory's shared counter: not read for this, not written


def test_an_own_x_app_posts_while_the_shared_limit_is_used_up(
    store: db.Store, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    _own_x(store, secrets_client, None)
    store.put({"pk": "RATE#x", "sk": "BUDGET", "type": "rate", "monthKey": "2026-11", "monthUsd": 9.99, "version": 1})
    http = FakeHttp((402, {"title": "CreditsDepleted"}))  # it reached X: the cap did not stop it
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    own = store.get("RATE#WS#stories#x", "BUDGET")
    assert own is not None
    assert own["monthUsd"] == 0.015
    shared = store.get("RATE#x", "BUDGET")
    assert shared is not None
    assert shared["monthUsd"] == 9.99


def test_numbers_with_an_own_youtube_app_use_its_own_daily_units(
    store: db.Store, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.ready(store, secrets_client)
    sup.social(store, secrets_client, "youtube", choice="own")
    sup.pubjob(store, "youtube", appChoice="own")
    http = FakeHttp(*YOUTUBE_OK, *(YOUTUBE_NUMBERS * 4))
    out = run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert out["outcome"] == "done"
    own = store.get("RATE#WS#stories#youtube", "BUDGET")
    assert own is not None
    assert own["unitsUsed"] == 4
    assert store.get("RATE#youtube", "BUDGET") is None


# --- AI labels (§45.14) --------------------------------------------------------------------------------------------


def _realistic(store: db.Store) -> None:
    store.put(
        {
            "pk": sup.PK,
            "sk": "PJOB#01JZ00000000000000000PJOB",
            "type": "ws_pjob",
            "userId": USER,
            "workspaceId": "stories",
            "jobId": "01JZ00000000000000000PJOB",
            "contentId": sup.STORY_ID,
            "status": "ready",
            "meta": {"providers": {"video": "nova-reel", "audio": "builtin-synth"}},
        }
    )


def test_the_wrappers_only_add_the_label() -> None:
    assert issubclass(publish.LabelledYouTubePublisher, YouTubePublisher)
    assert issubclass(publish.LabelledTikTokPublisher, TikTokPublisher)
    assert publish.publisher("youtube", ai_label=False).__class__ is YouTubePublisher
    assert isinstance(publish.publisher("youtube", ai_label=True), publish.LabelledYouTubePublisher)
    for platform in ("instagram", "facebook", "x"):
        with pytest.raises(publish.AiLabelMissing):
            publish.publisher(platform, ai_label=True)


def test_a_cartoon_is_never_marked_ai(store: db.Store) -> None:
    sup.workspace(store)
    cartoon = {"pk": sup.PK, "sk": "PJOB#A", "userId": USER, "workspaceId": "stories", "contentId": sup.STORY_ID}
    store.put({**cartoon, "meta": {"providers": {"video": "builtin-2d"}}})
    assert publish.realistic_video(store, USER, "stories", sup.STORY_ID) is False
    _realistic(store)
    assert publish.realistic_video(store, USER, "stories", sup.STORY_ID) is True
    assert publish.realistic_video(store, USER, "stories", "01JZ0000000000000000000ST2") is False


@pytest.mark.parametrize("platform", ["instagram", "facebook", "x"])
def test_realistic_ai_footage_is_refused_where_no_label_can_be_set(
    call: Call, app: App, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, platform: str
) -> None:
    sup.ready(store, secrets_client, platform)
    starter = sup.FakeStarter()
    sup.install(app, secrets_client, starter)
    _realistic(store)
    before = json.dumps(table.all(), sort_keys=True, default=str)
    status, body = call(
        "POST", PUBLISH, {"targets": [{"platform": platform, "socialAccountId": f"stories.{platform}"}]}
    )
    assert status == 409
    assert "cannot mark them as AI" in body["error"]["message"]
    assert json.dumps(table.all(), sort_keys=True, default=str) == before
    assert starter.started == []


def test_realistic_ai_footage_goes_to_youtube_labelled(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.ready(store, secrets_client, "youtube")
    _realistic(store)
    sup.pubjob(store, "youtube", aiLabel=True)
    http = FakeHttp(*YOUTUBE_OK, *(YOUTUBE_NUMBERS * 4))
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    meta = json.loads(http.calls[0].body)
    assert meta["status"]["containsSyntheticMedia"] is True
    assert meta["status"]["selfDeclaredMadeForKids"] is False


def test_realistic_ai_footage_goes_to_tiktok_labelled_even_without_the_snapshot(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.ready(store, secrets_client, "tiktok")
    _realistic(store)  # made after the tap: the flow looks again
    sup.pubjob(store, "tiktok", postOptions=TIKTOK_OPTIONS)
    http = FakeHttp(
        (200, "publish/tiktok_creator"),
        (200, "publish/tiktok_init"),
        (201, b""),
        (200, "publish/tiktok_status_complete"),
    )
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    assert json.loads(http.calls[1].body)["post_info"]["is_aigc"] is True


def test_the_flow_stops_a_job_it_cannot_label(
    store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, clock: Clock
) -> None:
    sup.ready(store, secrets_client, "facebook")
    _realistic(store)
    sup.pubjob(store, "facebook")
    http = FakeHttp()
    run_story_flow(FakeDurableContext(), sup.flow_event(), sup.flow_deps(store, secrets_client, http, clock))
    job = table.raw(sup.PK, JOB_SK)
    assert job is not None
    assert job["publishingStatus"] == "needs_attention"
    assert "cannot mark them as AI on Facebook" in job["error"]
    assert http.calls == []


# --- verify before publish ----------------------------------------------------------------------------------------


@pytest.fixture
def starter(app: App, store: db.Store, secrets_client: FakeSecretsManager) -> sup.FakeStarter:
    sup.ready(store, secrets_client, "youtube", "x")
    found = sup.FakeStarter()
    sup.install(app, secrets_client, found)
    return found


def test_the_answer_names_where_each_post_goes(call: Call, starter: sup.FakeStarter) -> None:
    targets = [
        {"platform": "youtube", "socialAccountId": "stories.youtube", "confirmAccount": "UC-STORIES"},
        {"platform": "x", "socialAccountId": "stories.x"},
    ]
    status, body = call("POST", PUBLISH, {"targets": targets})
    assert status == 202, body
    found = [(j["platform"], j["accountName"], j["handle"], j["externalAccountId"]) for j in body["publishingJobs"]]
    assert found == [
        ("youtube", "Lamo Stories youtube", "@lamostories", "UC-STORIES"),
        ("x", "Lamo Stories x", "@lamostories", "77"),
    ]


def test_a_target_whose_account_changed_since_the_owner_looked_writes_nothing(
    call: Call, store: db.Store, table: FakeTable, secrets_client: FakeSecretsManager, starter: sup.FakeStarter
) -> None:
    store.update(sup.PK, "SOCIAL#youtube", {"externalAccountId": "UC-NEW", "accountName": "New Channel"})
    token = json.loads(secrets_client.values["cf-prod/workspaces/stories/youtube/token"])
    secrets_client.values["cf-prod/workspaces/stories/youtube/token"] = json.dumps({**token, "channelId": "UC-NEW"})
    target = {"platform": "youtube", "socialAccountId": "stories.youtube", "confirmAccount": "UC-STORIES"}
    status, body = call("POST", PUBLISH, {"targets": [target]})
    assert status == 409
    assert body["error"]["account"]["externalAccountId"] == "UC-NEW"
    assert "New Channel" in body["error"]["message"]
    assert not [i for i in table.all() if str(i["sk"]).startswith("PUBJOB#")]
    assert starter.started == []
    assert call("POST", PUBLISH, {"targets": [{**target, "confirmAccount": 7}]})[0] == 400


# --- TikTok's own app: Lamo Stories cannot compare its open_id with Lamo Clips' (§45.13.4) -----------------------

OTHER_APP_ID = "open-same-person-other-app"  # TikTok gives each developer app its own open_id for the same person
TIKTOK_TARGET = {"platform": "tiktok", "socialAccountId": "stories.tiktok", "options": TIKTOK_OPTIONS}


@pytest.fixture
def unsure(app: App, store: db.Store, secrets_client: FakeSecretsManager) -> sup.FakeStarter:
    """Lamo Clips posts to a TikTok; Lamo Stories' TikTok is connected through Lamo Stories' own TikTok app. Clip
    Factory's TikTok has no username stored (only its display name), so the usernames cannot be compared either
    (§45.37 G8 b): only then does Lamo Stories have to ask."""
    sup.ready(store, secrets_client)
    sup.clips_account(store, secrets_client, "tiktok", handle="Owner Plays")
    sup.social(store, secrets_client, "tiktok", choice="own", identity=OTHER_APP_ID)
    found = sup.FakeStarter()
    sup.install(app, secrets_client, found)
    return found


def test_an_own_tiktok_app_posts_only_after_the_owner_says_it_is_lamo_stories(
    call: Call, store: db.Store, table: FakeTable, secrets: WorkspaceSecrets, unsure: sup.FakeStarter
) -> None:
    job = {**TIKTOK_TARGET, "contentId": sup.STORY_ID, "externalAccountId": OTHER_APP_ID}
    with pytest.raises(DestinationProblem) as stopped:  # the flow never sends one unconfirmed
        validate_destination(store, secrets, USER, "stories", job)
    assert (stopped.value.rule, stopped.value.kind) == (5, "clips_unknown")
    for confirm in (None, "open-1"):
        target = {**TIKTOK_TARGET, **({"confirmAccount": confirm} if confirm else {})}
        status, body = call("POST", PUBLISH, {"targets": [target]})
        assert status == 409, body
        assert body["error"]["account"] == {
            "externalAccountId": OTHER_APP_ID,
            "accountName": "Lamo Stories tiktok",
            "handle": "@lamostories",
        }
        assert (
            "cannot tell if this TikTok account (Lamo Stories tiktok) is Clip Factory's TikTok"
            in body["error"]["message"]
        )
    assert not [i for i in table.all() if str(i["sk"]).startswith("PUBJOB#")]
    assert unsure.started == []
    status, body = call("POST", PUBLISH, {"targets": [{**TIKTOK_TARGET, "confirmAccount": OTHER_APP_ID}]})
    assert status == 202, body
    assert body["publishingJobs"][0]["externalAccountId"] == OTHER_APP_ID
    assert len(unsure.started) == 1
    assert (table.raw(sup.PK, "SOCIAL#tiktok") or {})["notClipsConfirmed"] == OTHER_APP_ID
    validate_destination(store, secrets, USER, "stories", job)  # the flow's own check now passes
    assert sup.lamo_clips_items(table)[0]["accountId"] == "open-1"  # Lamo Clips' item is only read


def test_the_tiktok_question_names_this_account_and_the_yes_button(
    call: Call, store: db.Store, unsure: sup.FakeStarter
) -> None:
    """Round 5 E13: an account that is itself named "Lamo Stories" reads plainly ("this TikTok account (Lamo
    Stories)"), the other app is "Clip Factory", and the sentence says the publish sheet's own button: Yes."""
    store.update(sup.PK, "SOCIAL#tiktok", {"accountName": "Lamo Stories"})
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 409, body
    assert body["error"]["message"] == (
        "Funded Clips cannot tell if this TikTok account (Lamo Stories) is Clip Factory's TikTok. Tap Yes if it is "
        "your Funded Clips TikTok."
    )
    assert body["error"]["account"]["accountName"] == "Lamo Stories"
    assert unsure.started == []


def test_the_tiktok_question_never_puts_a_raw_open_id_in_its_sentence(
    call: Call, store: db.Store, unsure: sup.FakeStarter
) -> None:
    """Round 5 E14: an account with no name and no handle is "this TikTok account"; its open_id stays in
    ``error.account`` for the sheet's Technical details, never in the first line."""
    store.update(sup.PK, "SOCIAL#tiktok", {"accountName": "", "handle": ""})
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 409, body
    assert body["error"]["message"] == (
        "Funded Clips cannot tell if this TikTok account is Clip Factory's TikTok. Tap Yes if it is your Funded Clips "
        "TikTok."
    )
    assert OTHER_APP_ID not in body["error"]["message"]
    assert body["error"]["account"]["externalAccountId"] == OTHER_APP_ID
    assert unsure.started == []


def test_a_new_connect_asks_again(store: db.Store, secrets: WorkspaceSecrets, unsure: sup.FakeStarter) -> None:
    from clipfactory_api.workspaces import social
    from conftest import NOW

    store.update(sup.PK, "SOCIAL#tiktok", {"notClipsConfirmed": OTHER_APP_ID})
    social.Scope(store, secrets, USER, "stories").put(
        "tiktok", "connected", NOW, {"externalAccountId": OTHER_APP_ID, "appClientId": GOOD["tiktok"]["clientId"]}
    )
    assert "notClipsConfirmed" not in (store.get(sup.PK, "SOCIAL#tiktok") or {})


def test_a_tiktok_job_from_before_lamo_clips_had_tiktok_asks_on_try_again(
    call: Call, store: db.Store, table: FakeTable, unsure: sup.FakeStarter
) -> None:
    job = sup.pubjob(
        store, "tiktok", publishingStatus="needs_attention", externalAccountId=OTHER_APP_ID, postOptions=TIKTOK_OPTIONS
    )
    path = f"/v1/workspaces/stories/publishing/{job['publishingJobId']}/retry"
    status, body = call("POST", path, {})
    assert status == 409, body
    assert body["error"]["account"]["externalAccountId"] == OTHER_APP_ID
    assert unsure.started == []
    status, body = call("POST", path, {"confirmAccount": OTHER_APP_ID})
    assert status == 202, body
    assert (table.raw(sup.PK, "SOCIAL#tiktok") or {})["notClipsConfirmed"] == OTHER_APP_ID
    assert unsure.started[-1]["publishingJobIds"] == [job["publishingJobId"]]


def test_the_shared_tiktok_app_compares_open_ids_and_asks_nothing(
    call: Call, store: db.Store, secrets_client: FakeSecretsManager, unsure: sup.FakeStarter
) -> None:
    sup.social(store, secrets_client, "tiktok", choice="clips")  # Clip Factory's app: the same open_id per person
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 202, body
    sup.social(store, secrets_client, "tiktok", choice="clips", identity="open-1")  # Lamo Clips' own TikTok
    store.delete(sup.PK, "PUBJOB#" + body["publishingJobs"][0]["publishingJobId"])
    status, body = call("POST", PUBLISH, {"targets": [TIKTOK_TARGET]})
    assert status == 409
    assert "Clip Factory's own account" in body["error"]["message"]
