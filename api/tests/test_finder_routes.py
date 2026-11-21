"""/v1/contentrewards/finder: the routes, the want checks and defaults, the view, Look again now, a match's answers and
"Ask Content Rewards" (docs/CONTRACTS.md §41.5). Offline: fakes only, literal item shapes from §41.5."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import finderapi, public
from conftest import USER, Call, Clock
from cr_support import UUID, UUID2, FakeCR, FakeInvoker, make_deps, seed_campaign, seed_connection, seed_setup
from fakes import FakeSecretsManager

BASE = "/v1/contentrewards/finder"
UUID3 = "3d9ef19f-6a2b-4c8e-9d1f-2b3c4d5e6f70"
# §41.3, word for word: the defaults chosen for him.
DEFAULTS_LITERAL = (
    '{"on": true, "minPer1kCents": 100, "places": null, "categories": [], "minLeftPct": 25, "access": "open", '
    '"otherPay": false, "languages": [], "tellMe": true}'
)
ROUTES = [
    ("GET", BASE),
    ("PATCH", BASE),
    ("POST", f"{BASE}/check"),
    ("PATCH", f"{BASE}/matches/{UUID}"),
    ("POST", f"{BASE}/matches/{UUID}/add"),
    ("POST", f"{BASE}/joined"),
    ("POST", f"{BASE}/ask"),
]


class FinderInvoker(FakeInvoker):
    def __init__(self) -> None:
        super().__init__()
        self.tries = 0  # every find invoke, the failed ones too

    def find(self, user_id: str | None, why: str) -> None:
        self.tries += 1
        self._record("find", user_id, why)


@pytest.fixture
def cr(app: App, secrets_client: FakeSecretsManager, clock: Clock, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("CR_FINDER", "on")
    public.reset_limit()
    deps = make_deps(app.store, secrets_client, FakeCR(), clock, media=app.media, invoker=FinderInvoker())
    app.contentrewards = deps
    return deps


def finds(cr: Any) -> list[tuple[Any, ...]]:
    return [args for name, args in cr.invoker.calls if name == "find"]


def crfind(cr: Any) -> dict[str, Any]:
    return cr.store.get(db.user_pk(USER), "CRFIND") or {}


def match(uuid: str = UUID, name: str = "Fundingpips", **fields: Any) -> dict[str, Any]:
    """A stored ``FinderMatch`` as the look writes it (without ``isNew`` and ``opened``)."""
    return {
        "campaignId": uuid,
        "url": f"https://contentrewards.com/c/campaigns/{uuid}",
        "name": name,
        "brand": name,
        "access": "open",
        "kind": "cpm",
        "pay": [
            {
                "platform": "youtube",
                "line": "$6.00 per 1,000 views",
                "per1kCents": 600,
                "topPer1kCents": 600,
                "perPostCents": None,
                "maxPayoutCents": None,
                "geo": False,
            }
        ],
        "maxPerClipCents": None,
        "budget": {
            "totalCents": 283000,
            "leftCents": 116800,
            "usedPct": 58.7,
            "line": "$1,168 left of $2,830",
            "asOf": "2026-11-15T10:00:00.000Z",
            "tag": "Content Rewards' numbers",
        },
        "categories": [],
        "why": "Pays $6.00 per 1,000 views on YouTube and Instagram. 41% of the money left. Open to join.",
        "notes": ["It has 4 rules you see once you join."],
        "headsUp": [],
        "cantTell": [],
        "hiddenRules": 4,
        "launchedAt": None,
        "rank": 1,
        **fields,
    }


def seed_finder(cr: Any, **fields: Any) -> dict[str, Any]:
    now = cr.clock.now
    item = {
        "pk": db.user_pk(USER),
        "sk": "CRFIND",
        "type": "crfind",
        "userId": USER,
        "want": json.loads(DEFAULTS_LITERAL),
        "matchedWant": finderapi.matched_want(finderapi.DEFAULT_WANT, []),  # no place set up in these tests
        "createdAt": iso(now - timedelta(days=1)),
        "updatedAt": iso(now - timedelta(days=1)),
        **fields,
    }
    cr.store.put(item)
    return item


# --- switched off and the defaults ------------------------------------------------------------------------------------


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_is_503_until_the_finder_is_switched_on(
    call: Call, cr: Any, monkeypatch: pytest.MonkeyPatch, method: str, path: str
) -> None:
    monkeypatch.setenv("CR_FINDER", "off")
    status, body = call(method, path, {})
    assert (status, body["error"]) == (503, {"code": "unavailable", "message": "Coming soon."})
    monkeypatch.delenv("CR_FINDER")
    assert call(method, path, {})[0] == 503  # an unset value is off


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_route_follows_the_content_rewards_switch(call: Call, method: str, path: str) -> None:
    status, body = call(method, path, {})  # Content Rewards itself switched off: §38.8's 503
    assert (status, body["error"]["code"]) == (503, "unavailable")
    assert body["error"]["message"] == "Content Rewards is not switched on for this app yet."


def test_the_defaults_are_the_contracts_literal() -> None:
    assert json.loads(DEFAULTS_LITERAL) == finderapi.DEFAULT_WANT
    assert finderapi.full_want(None) == finderapi.DEFAULT_WANT
    assert finderapi.full_want({"minPer1kCents": 7, "access": "any"}) == {**finderapi.DEFAULT_WANT, "access": "any"}


def test_matched_want_is_the_shared_literal_hash() -> None:
    """§41.5: SHA-256 of the canonical JSON, first 16 hex characters (the reader tests the same case)."""
    assert finderapi.matched_want(finderapi.DEFAULT_WANT, ["youtube", "instagram"]) == "9043b6e229b09300"
    assert finderapi.matched_want({}, ["youtube", "instagram"]) == "9043b6e229b09300"  # defaults filled in
    assert finderapi.matched_want(finderapi.DEFAULT_WANT, ["youtube"]) != "9043b6e229b09300"


# --- never started, the first PATCH --------------------------------------------------------------------------------------


def test_never_started_is_new_with_the_defaults_and_reads_items_only(call: Call, cr: Any) -> None:
    seed_setup(cr.store, USER, "youtube")
    seed_setup(cr.store, USER, "x")
    status, body = call("GET", BASE)
    assert status == 200
    assert body == {
        "state": "new",
        "want": finderapi.DEFAULT_WANT,
        "resolvedPlaces": ["youtube", "x"],
        "tiktokWaits": True,
        "matches": [],
        "newCount": 0,
        "hiddenCount": 0,
        "skipped": [],
        "looked": {"campaigns": 0, "pending": 0},
        "categories": [],
        "signedIn": False,
    }
    assert cr.net.requests == []
    assert finds(cr) == []
    assert crfind(cr) == {}


def test_the_first_want_creates_crfind_with_every_default_and_starts_a_look(call: Call, cr: Any) -> None:
    status, body = call("PATCH", BASE, {"want": {"minPer1kCents": 200, "places": ["instagram", "youtube"]}})
    assert status == 200
    item = crfind(cr)
    assert item["type"] == "crfind"
    assert item["userId"] == USER
    assert item["want"] == {**finderapi.DEFAULT_WANT, "minPer1kCents": 200, "places": ["youtube", "instagram"]}
    assert item["createdAt"] == item["lookingSince"] == iso(cr.clock.now)
    assert cr.store.get(db.CROWNERS_PK, db.user_pk(USER)) is not None  # the poller's list (§38.11)
    assert finds(cr) == [(USER, "start")]
    assert body["finder"]["state"] == "looking"
    assert body["finder"]["want"]["minPer1kCents"] == 200


def test_null_places_stay_the_places_you_set_up(call: Call, cr: Any) -> None:
    call("PATCH", BASE, {"want": {}})
    item = crfind(cr)
    assert "places" not in item["want"]  # DynamoDB keeps no null in a map: "the places you set up"
    assert finderapi.full_want(item["want"]) == finderapi.DEFAULT_WANT


def test_a_later_change_of_want_starts_a_match_only_look(call: Call, cr: Any) -> None:
    seed_finder(cr)
    call("PATCH", BASE, {"want": {"access": "any"}})
    assert crfind(cr)["want"]["access"] == "any"
    assert finds(cr) == [(USER, "want")]
    call("PATCH", BASE, {"want": {"access": "any"}})  # nothing changed: no look
    assert finds(cr) == [(USER, "want")]
    status, body = call("PATCH", BASE, {"want": {"on": False}})  # Stop finding campaigns: no look
    assert (status, body["finder"]["state"], body["finder"]["matches"]) == (200, "off", [])
    assert finds(cr) == [(USER, "want")]
    call("PATCH", BASE, {"want": {"on": True}})  # Find campaigns again
    assert finds(cr) == [(USER, "want"), (USER, "want")]


def test_the_first_want_after_ask_still_starts(call: Call, cr: Any) -> None:
    cr.store.put(
        {"pk": db.user_pk(USER), "sk": "CRFIND", "type": "crfind", "userId": USER, "askedAt": iso(cr.clock.now)}
    )
    assert call("GET", BASE)[1]["state"] == "new"
    call("PATCH", BASE, {"want": {"tellMe": False}})
    assert finds(cr) == [(USER, "start")]
    assert crfind(cr)["askedAt"] == iso(cr.clock.now)


@pytest.mark.parametrize(
    ("want", "field"),
    [
        ([], "want"),
        ({"loud": True}, "loud"),
        ({"on": "yes"}, "on"),
        ({"otherPay": 1}, "otherPay"),
        ({"tellMe": None}, "tellMe"),
        ({"minPer1kCents": 150}, "minPer1kCents"),
        ({"minPer1kCents": True}, "minPer1kCents"),
        ({"minPer1kCents": "100"}, "minPer1kCents"),
        ({"places": ["youtube", "youtube"]}, "places"),
        ({"places": ["myspace"]}, "places"),
        ({"places": "youtube"}, "places"),
        ({"minLeftPct": 10}, "minLeftPct"),
        ({"access": "application"}, "access"),
        ({"categories": ["Gaming"]}, "categories"),
        ({"categories": ["gaming", "gaming"]}, "categories"),
        ({"categories": [f"c{n}" for n in range(13)]}, "categories"),
        ({"categories": ["x" * 41]}, "categories"),
        ({"languages": ["ja"]}, "languages"),
        ({"languages": ["en", "en"]}, "languages"),
    ],
)
def test_want_checks(call: Call, cr: Any, want: Any, field: str) -> None:
    status, body = call("PATCH", BASE, {"want": want})
    assert status == 400
    assert body["error"]["message"] == "Pick one of the choices shown."
    assert body["error"].get("field") == field
    assert crfind(cr) == {}
    assert finds(cr) == []


def test_every_choice_shown_is_accepted(call: Call, cr: Any) -> None:
    want = {
        "on": True,
        "minPer1kCents": 300,
        "places": [],
        "categories": ["gaming", "pc-gaming"],
        "minLeftPct": 0,
        "access": "any",
        "otherPay": True,
        "languages": ["en", "es", "pt", "fr", "de", "it"],
        "tellMe": False,
    }
    assert call("PATCH", BASE, {"want": want})[0] == 200
    assert crfind(cr)["want"] == want


def test_patch_bodies(call: Call, cr: Any) -> None:
    assert call("PATCH", BASE, {})[0] == 400
    assert call("PATCH", BASE, {"other": 1})[0] == 400
    assert call("PATCH", BASE, {"seenAll": False})[1]["error"]["field"] == "seenAll"
    assert call("PATCH", BASE, {"seenAll": True})[0] == 200  # before the first want: nothing to change
    assert crfind(cr) == {}


def test_seen_all_and_is_new(call: Call, cr: Any, clock: Clock) -> None:
    now = clock.now
    seed_finder(
        cr,
        matches=[match(UUID), match(UUID2, "COD DMZ")],
        matchedAt=iso(now - timedelta(hours=1)),
        shown={UUID: iso(now - timedelta(days=2)), UUID2: iso(now - timedelta(hours=1))},
    )
    body = call("GET", BASE)[1]
    assert [m["isNew"] for m in body["matches"]] == [True, True]  # no seenAt yet: every match is new
    assert body["newCount"] == 2
    cr.store.update(db.user_pk(USER), "CRFIND", {"seenAt": iso(now - timedelta(days=1))})
    body = call("GET", BASE)[1]
    assert [m["isNew"] for m in body["matches"]] == [False, True]
    assert body["newCount"] == 1
    status, body = call("PATCH", BASE, {"seenAll": True})
    assert status == 200
    assert crfind(cr)["seenAt"] == iso(now)
    assert body["finder"]["newCount"] == 0
    clock.now += timedelta(minutes=1)
    call("PATCH", BASE, {"seenAll": True})  # nothing new: no write, so no live event to answer again
    assert crfind(cr)["seenAt"] == iso(now)
    assert finds(cr) == []


def test_unhide_all_removes_hidden_and_starts_a_look(call: Call, cr: Any) -> None:
    seed_finder(cr, hidden={UUID, UUID2})
    assert call("GET", BASE)[1]["hiddenCount"] == 2
    status, body = call("PATCH", BASE, {"unhideAll": True})
    assert status == 200
    assert "hidden" not in crfind(cr)  # REMOVEd: DynamoDB has no empty set
    assert body["finder"]["hiddenCount"] == 0
    assert finds(cr) == [(USER, "want")]
    call("PATCH", BASE, {"unhideAll": True})  # nothing hidden: nothing to look for
    assert finds(cr) == [(USER, "want")]


# --- GET and the stale hash -----------------------------------------------------------------------------------------------


def test_get_with_a_stale_matched_want_starts_one_match_only_look_per_10_minutes(
    call: Call, cr: Any, clock: Clock
) -> None:
    seed_setup(cr.store, USER, "youtube")
    good = finderapi.matched_want(finderapi.DEFAULT_WANT, ["youtube"])
    seed_finder(cr, matchedWant=good, matchedAt=iso(clock.now - timedelta(hours=1)))
    assert call("GET", BASE)[1]["state"] == "ok"
    assert finds(cr) == []  # the hash matches: nothing to do
    seed_setup(cr.store, USER, "x")  # a place just set up
    body = call("GET", BASE)[1]
    assert body["state"] == "looking"
    assert body["resolvedPlaces"] == ["youtube", "x"]
    assert finds(cr) == [(USER, "want")]
    clock.now += timedelta(minutes=9)
    call("GET", BASE)
    assert finds(cr) == [(USER, "want")]  # at most once per 10 minutes
    clock.now += timedelta(minutes=2)
    call("GET", BASE)
    assert finds(cr) == [(USER, "want"), (USER, "want")]


def test_a_failed_invoke_on_get_waits_the_10_minutes(call: Call, cr: Any, clock: Clock) -> None:
    # Taking lookingSince back is a CRFIND MODIFY: its live event makes the page GET again, which would try at once.
    seed_finder(cr, matchedWant=None)
    cr.invoker.fail = True
    body = call("GET", BASE)[1]
    assert body["state"] == "ok"
    assert cr.invoker.tries == 1
    kept = crfind(cr)
    assert kept["lookingSince"] == iso(clock.now)
    clock.now += timedelta(minutes=1)
    call("GET", BASE)  # the live refetch
    assert cr.invoker.tries == 1  # no invoke
    assert crfind(cr) == kept  # and no write
    clock.now += timedelta(minutes=10)
    call("GET", BASE)
    assert cr.invoker.tries == 2  # one try per 10 minutes


def test_a_failed_invoke_after_his_tap_takes_looking_back(call: Call, cr: Any) -> None:
    seed_finder(cr)
    cr.invoker.fail = True
    status, body = call("PATCH", BASE, {"want": {"access": "any"}})
    assert status == 200
    assert cr.invoker.tries == 1
    assert "lookingSince" not in crfind(cr)
    assert body["finder"]["state"] == "ok"


# --- the view -------------------------------------------------------------------------------------------------------------


def test_state_precedence(cr: Any, clock: Clock) -> None:
    now = clock.now
    state = finderapi.state_of
    item = {"want": dict(finderapi.DEFAULT_WANT)}
    assert state(None, {}, now) == "new"
    assert state({"askedAt": iso(now)}, {}, now) == "new"
    assert state(item, {}, now) == "ok"
    looking = {**item, "lookingSince": iso(now - timedelta(minutes=10))}
    assert state(looking, {"sourceState": "blocked"}, now) == "looking"
    assert state({**looking, "lookingSince": iso(now - timedelta(minutes=11))}, {}, now) == "ok"  # ≤ 10 minutes
    assert state({**looking, "matchedAt": iso(now - timedelta(minutes=1))}, {}, now) == "ok"  # the look finished
    assert state({**looking, "matchedAt": iso(now - timedelta(minutes=20))}, {}, now) == "looking"
    for source in ("down", "blocked", "not_allowed", "unreadable"):
        assert state(item, {"sourceState": source}, now) == source
        assert state({**item, "sourceState": source}, {}, now) == source
    assert state(item, {"sourceState": "ok"}, now) == "ok"
    assert state(item, {"sourceState": "weird"}, now) == "ok"
    off = {"want": {**finderapi.DEFAULT_WANT, "on": False}, "lookingSince": iso(now)}
    assert state(off, {"sourceState": "down"}, now) == "off"


def test_the_view_drops_hidden_added_and_own_and_says_opened(call: Call, cr: Any, clock: Clock) -> None:
    now = clock.now
    seed_campaign(cr.store, USER, now, uuid=UUID3)  # already his
    other = "e815a623-1111-4222-8333-444455556666"
    seed_finder(
        cr,
        matches=[
            match(UUID, url="https://evil.example/x"),
            match(UUID2, "COD DMZ"),
            match(UUID3, "Pickleball"),
            match(other, "Hablando"),
        ],
        hidden={UUID2},
        added={other: iso(now)},
        opened={UUID: iso(now - timedelta(minutes=5))},
        matchedAt=iso(now - timedelta(hours=2)),
        skipped=[{"code": "apply", "count": 2, "text": "2 want you to apply first."}],
        looked={"campaigns": 154, "pending": 0},
        categories=[{"id": "gaming", "name": "Gaming", "count": 9}],
        sourceState="down",
    )
    cr.store.put(
        {"pk": "CRPUBLIC", "sk": "STATE", "type": "crpublicstate", "lastLookAt": iso(now - timedelta(minutes=30))}
    )
    body = call("GET", BASE)[1]
    assert [m["campaignId"] for m in body["matches"]] == [UUID]
    shown = body["matches"][0]
    assert shown["url"] == f"https://contentrewards.com/c/campaigns/{UUID}"  # only a link Clip Factory made
    assert shown["opened"] == iso(now - timedelta(minutes=5))
    assert shown["budget"]["tag"] == "Content Rewards' numbers"
    assert body["state"] == "down"  # the stored matches still show
    assert body["hiddenCount"] == 1
    assert body["skipped"] == [{"code": "apply", "count": 2, "text": "2 want you to apply first."}]
    assert body["looked"] == {"campaigns": 154, "pending": 0}
    assert body["categories"] == [{"id": "gaming", "name": "Gaming", "count": 9}]
    assert body["lastLookAt"] == iso(now - timedelta(minutes=30))
    assert body["asOf"] == iso(now - timedelta(hours=2))


def test_a_match_carries_only_finder_match_keys_and_short_brand_text(call: Call, cr: Any) -> None:
    long = "B" * 400
    stored = match(UUID, long, link="https://evil.example", isNew=False, opened="x")
    stored["brand"] = long
    stored["why"] = "W" * 400
    stored["pay"][0]["link"] = "https://evil.example/pay"
    stored["budget"]["link"] = "https://evil.example/budget"
    stored["categories"] = [{"id": "gaming", "name": "G" * 400, "link": "https://evil.example/c"}]
    stored["notes"] = ["one", "two", "three", "four", 5]
    seed_finder(
        cr,
        matches=[stored],
        categories=[{"id": "gaming", "name": "G" * 400, "count": 9, "link": "https://evil.example/c"}],
        skipped=[{"code": "apply", "count": 2, "text": "2 want you to apply first.", "link": "https://evil.example"}],
    )
    body = call("GET", BASE)[1]
    [shown] = body["matches"]
    kept = {k for k, v in stored.items() if k in finderapi.MATCH_KEYS and v is not None}  # DynamoDB keeps no null
    assert set(shown) == {*kept, "isNew"}  # no "link"; isNew from CRFIND, never the stored one
    assert shown["isNew"] is True
    assert (len(shown["name"]), len(shown["brand"]), len(shown["why"])) == (300, 300, 300)
    assert "link" not in shown["pay"][0]
    assert shown["pay"][0]["line"] == "$6.00 per 1,000 views"
    assert set(shown["budget"]) == set(finderapi.BUDGET_KEYS)
    assert shown["categories"] == [{"id": "gaming", "name": "G" * 300}]
    assert shown["notes"] == ["one", "two", "three"]  # ≤ 3, text only
    assert body["categories"] == [{"id": "gaming", "name": "G" * 300, "count": 9}]
    assert body["skipped"] == [{"code": "apply", "count": 2, "text": "2 want you to apply first."}]
    assert "evil" not in json.dumps(body)


def test_resolved_places_with_tiktok_before_and_after_its_audit(call: Call, cr: Any) -> None:
    seed_setup(cr.store, USER, "youtube")
    seed_setup(cr.store, USER, "tiktok", audit="unknown")
    body = call("GET", BASE)[1]
    assert (body["resolvedPlaces"], body["tiktokWaits"]) == (["youtube"], True)
    seed_setup(cr.store, USER, "tiktok", audit="ok")
    body = call("GET", BASE)[1]
    assert (body["resolvedPlaces"], body["tiktokWaits"]) == (["youtube", "tiktok"], False)
    seed_finder(cr, want={**finderapi.DEFAULT_WANT, "places": ["youtube", "instagram"]})
    body = call("GET", BASE)[1]
    assert (body["resolvedPlaces"], body["tiktokWaits"]) == (["youtube"], False)  # only ready places count
    seed_setup(cr.store, USER, "tiktok", audit="unknown")  # TikTok connected, its audit not passed yet
    body = call("GET", BASE)[1]
    # §41.1: the TikTok chip stays off while the audit waits, whatever he picked (here a list without TikTok).
    assert (body["resolvedPlaces"], body["tiktokWaits"]) == (["youtube"], True)
    seed_finder(cr, want={**finderapi.DEFAULT_WANT, "places": ["youtube", "tiktok"]})
    assert call("GET", BASE)[1]["tiktokWaits"] is True


@pytest.mark.parametrize(
    ("fields", "signed_in"),
    [
        ({"status": "connected"}, True),
        ({"status": "read_only", "canSubmit": False}, True),
        ({"status": "connected", "blocked": True}, False),
        ({"status": "needs_reconnect"}, False),
    ],
)
def test_signed_in(call: Call, cr: Any, fields: dict[str, Any], signed_in: bool) -> None:
    seed_connection(cr, USER, cr.clock.now, **fields)
    assert call("GET", BASE)[1]["signedIn"] is signed_in


# --- Look again now ---------------------------------------------------------------------------------------------------------


def test_look_again_now_at_most_every_30_minutes_and_4_a_day(call: Call, cr: Any, clock: Clock) -> None:
    from datetime import UTC, datetime

    clock.now = datetime(2026, 11, 21, 8, 0, tzinfo=UTC)
    assert call("POST", f"{BASE}/check")[1]["error"]["message"] == "Tap Find campaigns for me first."
    seed_finder(cr)
    status, body = call("POST", f"{BASE}/check")
    assert (status, body) == (202, {"started": True, "nextAllowedAt": "2026-11-21T08:30:00.000Z"})
    assert crfind(cr)["checkNow"] == {"at": "2026-11-21T08:00:00.000Z", "day": "2026-11-21", "n": 1}
    clock.now += timedelta(minutes=29)
    status, body = call("POST", f"{BASE}/check")
    assert (status, body) == (200, {"started": False, "nextAllowedAt": "2026-11-21T08:30:00.000Z"})
    assert call("GET", BASE)[1]["nextAllowedAt"] == "2026-11-21T08:30:00.000Z"
    for n in (2, 3, 4):
        clock.now += timedelta(minutes=31)
        assert call("POST", f"{BASE}/check")[0] == 202
        assert crfind(cr)["checkNow"]["n"] == n
    assert call("POST", f"{BASE}/check")[1]["nextAllowedAt"] == "2026-11-22T00:00:00.000Z"
    clock.now += timedelta(hours=3)
    status, body = call("POST", f"{BASE}/check")
    assert (status, body["nextAllowedAt"]) == (200, "2026-11-22T00:00:00.000Z")  # 4 a UTC day
    clock.now = datetime(2026, 11, 22, 0, 1, tzinfo=UTC)
    assert call("POST", f"{BASE}/check")[0] == 202
    assert crfind(cr)["checkNow"] == {"at": "2026-11-22T00:01:00.000Z", "day": "2026-11-22", "n": 1}
    assert finds(cr) == [(USER, "check_now")] * 5


def test_look_again_now_while_stopped_or_the_invoke_fails(call: Call, cr: Any) -> None:
    seed_finder(cr, want={**finderapi.DEFAULT_WANT, "on": False})
    assert call("POST", f"{BASE}/check")[1]["error"]["message"] == "Tap Find campaigns again first."
    seed_finder(cr)
    cr.invoker.fail = True
    status, body = call("POST", f"{BASE}/check")
    assert (status, body["error"]["code"]) == (503, "platform_down")
    assert "checkNow" not in crfind(cr)  # the slot isn't used up


# --- a match's answers --------------------------------------------------------------------------------------------------------


def test_opened_not_for_me_undo_and_the_404(call: Call, cr: Any, clock: Clock) -> None:
    now = clock.now
    seed_finder(cr, matches=[match(UUID), match(UUID2, "COD DMZ")])
    path = f"{BASE}/matches/{UUID}"
    status, body = call("PATCH", path, {"said": "opened"})
    assert status == 200
    assert crfind(cr)["opened"] == {UUID: iso(now)}
    assert body["finder"]["matches"][0]["opened"] == iso(now)
    clock.now += timedelta(seconds=5)
    call("PATCH", f"{BASE}/matches/{UUID2.upper()}", {"said": "opened"})
    assert crfind(cr)["opened"] == {UUID: iso(now), UUID2: iso(clock.now)}  # one map key at a time
    status, body = call("PATCH", path, {"said": "not_for_me"})
    assert status == 200
    assert crfind(cr)["hidden"] == [UUID]
    assert [m["campaignId"] for m in body["finder"]["matches"]] == [UUID2]  # dropped from the answer
    assert body["finder"]["hiddenCount"] == 1
    status, body = call("PATCH", path, {"said": None})  # the toast's Undo
    assert status == 200
    assert "hidden" not in crfind(cr)
    assert [m["campaignId"] for m in body["finder"]["matches"]] == [UUID, UUID2]
    status, body = call("PATCH", f"{BASE}/matches/{UUID3}", {"said": "opened"})
    assert (status, body["error"]["message"]) == (
        404,
        "That campaign isn't in your matches any more. Tap Look again now.",
    )
    assert call("PATCH", f"{BASE}/matches/not-a-uuid", {"said": "opened"})[0] == 404
    assert call("PATCH", path, {"said": "joined"})[0] == 400
    assert call("PATCH", path, {})[0] == 400
    assert finds(cr) == []


def test_a_hidden_campaign_can_be_brought_back_after_the_look_drops_it(call: Call, cr: Any) -> None:
    seed_finder(cr, matches=[], hidden={UUID})
    assert call("PATCH", f"{BASE}/matches/{UUID}", {"said": None})[0] == 200
    assert "hidden" not in crfind(cr)


def test_opened_keeps_at_most_50(cr: Any, clock: Clock) -> None:
    now = clock.now
    many = {f"00000000-0000-4000-8000-{n:012d}": iso(now - timedelta(minutes=n)) for n in range(1, 51)}
    seed_finder(cr, matches=[match(UUID)], opened=many)
    finderapi.said(cr, USER, UUID, "opened", now)
    opened = crfind(cr)["opened"]
    assert len(opened) == 50
    assert opened[UUID] == iso(now)
    assert "00000000-0000-4000-8000-000000000050" not in opened  # the oldest dropped


# --- Ask Content Rewards ---------------------------------------------------------------------------------------------------------


def test_ask_needs_the_sign_in(call: Call, cr: Any) -> None:
    status, body = call("POST", f"{BASE}/ask")
    assert (status, body["error"]) == (409, {"code": "conflict", "message": "Connect Content Rewards first."})
    seed_connection(cr, USER, cr.clock.now, blocked=True)
    assert call("POST", f"{BASE}/ask")[0] == 409


def test_ask_sends_the_one_fixed_request_once_per_30_days(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    cr.net.answer("send_feedback", {"object": "feedback", "id": "fb_1"})
    asked = iso(clock.now)  # the request's time (the MCP pacing may move the fake clock on)
    status, body = call("POST", f"{BASE}/ask")
    assert (status, body) == (200, {"askedAt": asked})
    sent = cr.net.calls("send_feedback")
    assert len(sent) == 1
    args = sent[0][0]
    assert args == {
        "message": finderapi.ASK_MESSAGE,
        "kind": "idea",
        "about_tool": "list_my_campaigns",
        "agent_name": "clip-factory",
        "agent_version": "1",
    }
    text = json.dumps(args)
    for private in (USER, "owner@example.com", "cre_0123456789abcdefghjkmnpqrs", "at_0", "rt_0", "http", "@"):
        assert private not in text  # no personal data, URL or token
    assert finderapi.ASK_MESSAGE.startswith("Feature request from Clip Factory: creators ask for MCP tools")
    item = crfind(cr)
    assert item["askedAt"] == asked
    assert item["type"] == "crfind"
    assert "want" not in item  # asking never starts the finder
    assert call("GET", BASE)[1]["askedAt"] == asked
    clock.now += timedelta(days=29)
    assert call("POST", f"{BASE}/ask")[1] == {"askedAt": asked}  # inside the 30 days: nothing sent
    assert len(cr.net.calls("send_feedback")) == 1
    clock.now += timedelta(days=2)
    again = iso(clock.now)
    assert call("POST", f"{BASE}/ask")[1] == {"askedAt": again}
    assert len(cr.net.calls("send_feedback")) == 2


def test_ask_when_content_rewards_does_not_answer(call: Call, cr: Any) -> None:
    from cr_support import tool_error

    seed_connection(cr, USER, cr.clock.now)
    cr.net.answer("send_feedback", tool_error("internal_error", status=500))
    status, body = call("POST", f"{BASE}/ask")
    assert (status, body["error"]["code"]) == (503, "platform_down")
    assert "askedAt" not in crfind(cr)
