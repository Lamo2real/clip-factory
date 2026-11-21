"""The finder's one-tap add and adopting what he joined on Content Rewards (docs/CONTRACTS.md §41.5 Add and Adopt,
§41.6 changes 10 and 11). Offline: fakes only, literal item shapes from §41.5."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.clock import iso
from clipfactory_api.contentrewards import finderapi, gates, ids, public
from conftest import USER, Call, Clock
from cr_support import (
    JSON_URL_FOR,
    ORG,
    UUID,
    UUID2,
    FakeCR,
    FakeInvoker,
    listed_campaign,
    make_deps,
    page,
    public_campaign,
    seed_campaign,
    seed_connection,
    seed_setup,
)
from fakes import FakeSecretsManager

BASE = "/v1/contentrewards/finder"


class FinderInvoker(FakeInvoker):
    def find(self, user_id: str | None, why: str) -> None:
        self._record("find", user_id, why)


@pytest.fixture
def cr(app: App, secrets_client: FakeSecretsManager, clock: Clock, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("CR_FINDER", "on")
    public.reset_limit()
    deps = make_deps(app.store, secrets_client, FakeCR(), clock, media=app.media, invoker=FinderInvoker())
    app.contentrewards = deps
    seed_setup(app.store, USER, "youtube")
    seed_setup(app.store, USER, "instagram")
    return deps


def other_uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def seed_finder(cr: Any, *, matches: list[str] = (), **fields: Any) -> None:  # type: ignore[assignment]
    cr.store.put(
        {
            "pk": db.user_pk(USER),
            "sk": "CRFIND",
            "type": "crfind",
            "userId": USER,
            "want": dict(finderapi.DEFAULT_WANT),
            "matches": [
                {"campaignId": u, "url": f"https://contentrewards.com/c/campaigns/{u}", "name": "M", "rank": n}
                for n, u in enumerate(matches)
            ],
            "createdAt": iso(cr.clock.now - timedelta(days=1)),
            **fields,
        }
    )


def seed_copy(cr: Any, uuid: str = UUID, *, age: timedelta = timedelta(hours=3), **kw: Any) -> str:
    """``CRPUBLIC/PUB#{uuid}``: the §38.10 stripped copy the look kept."""
    read_at = iso(cr.clock.now - age)
    cr.store.put(
        {
            "pk": "CRPUBLIC",
            "sk": f"PUB#{uuid}",
            "type": "crpubliccopy",
            "uuid": uuid,
            "public": public.strip(public_campaign(uuid, **kw)),
            "readAt": read_at,
            "ttl": int((cr.clock.now + timedelta(days=60)).timestamp()),
        }
    )
    return read_at


def crfind(cr: Any) -> dict[str, Any]:
    return cr.store.get(db.user_pk(USER), "CRFIND") or {}


def item_of(cr: Any, uuid: str = UUID) -> dict[str, Any] | None:
    return cr.store.get(db.user_pk(USER), db.campaign_sk(uuid))


def listed(uuid: str = UUID, **kw: Any) -> dict[str, Any]:
    return listed_campaign(ids.typeid("cmp", uuid), **kw)


# --- add: open and application, signed in and not ------------------------------------------------------------------


def test_add_an_open_campaign_while_clip_factory_cant_look(call: Call, cr: Any, clock: Clock) -> None:
    seed_finder(cr, matches=[UUID])
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=False)
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert status == 201
    campaign = body["campaign"]
    assert (campaign["membership"], campaign["said"]) == ("manual", "joined_by_hand")  # §38.4 manual
    item = item_of(cr) or {}
    assert item["addedBy"] == "finder"
    assert crfind(cr)["added"] == {UUID: iso(clock.now)}
    assert cr.net.calls("list_my_campaigns") == []  # not signed in: no MCP call
    assert ("brand_picture", (USER, UUID)) in cr.invoker.calls  # as add_campaign does
    assert cr.store.get(db.CROWNERS_PK, db.user_pk(USER)) is not None
    found = call("GET", BASE)[1]
    assert found["matches"] == []  # an added match leaves the answer


def test_add_an_open_campaign_signed_in_not_listed_yet(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, matches=[UUID])
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=False)
    cr.net.answer("list_my_campaigns", page([]))
    now = clock.now
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert status == 201
    campaign = body["campaign"]
    assert campaign["membership"] == "not_joined"
    assert "said" not in campaign
    assert campaign["canSayInBy"] == campaign["addedAt"] == iso(now)  # the quiet ask shows at once
    step = campaign["nextStep"]
    assert step["text"] == "Checking that you joined… This can take a few minutes."  # §41.6 change 11
    assert "button" not in step  # no vermilion
    assert step["glass"] == [
        {"label": "Open campaign", "href": f"https://contentrewards.com/c/campaigns/{UUID}", "external": True}
    ]
    assert step["asks"] == [{"label": "I joined, but it still says not joined", "said": "joined_by_hand"}]
    clock.now = now + timedelta(minutes=15)  # then §38.4's not_joined row as it is
    later = call("GET", f"/v1/contentrewards/campaigns/{UUID}")[1]["campaign"]["nextStep"]
    assert later["button"]["label"] == "Open campaign"
    assert later["text"].startswith("Not joined yet: tap **Join Campaign** on Content Rewards.")


def test_add_an_open_campaign_already_listed_is_in(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, matches=[UUID])
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=False)
    cr.net.answer("list_my_campaigns", page([listed(access="open")]))
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert (status, body["campaign"]["membership"]) == (201, "in")
    assert "said" not in body["campaign"]


def test_add_an_application_signed_in_waits_for_the_brand(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, matches=[UUID])
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=True)
    cr.net.answer("list_my_campaigns", page([]))
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert status == 201
    campaign = body["campaign"]
    assert (campaign["membership"], campaign["said"]) == ("waiting", "applied")  # apply_first → waiting
    assert campaign["nextStep"]["kind"] == "wait"


def test_add_an_application_while_clip_factory_cant_look(call: Call, cr: Any, clock: Clock) -> None:
    seed_finder(cr, matches=[UUID])
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=True)
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert status == 201
    campaign = body["campaign"]
    assert (campaign["membership"], campaign["said"]) == ("unknown", "applied")  # the answer is kept
    step = campaign["nextStep"]
    assert (step["kind"], step["chip"]) == ("wait", "Waiting for the brand")  # §41.6 change 10
    assert step["text"] == gates.FINDER_WAIT
    assert "button" not in step
    assert [a["label"] for a in step["asks"]] == ["It says Submit clip", "It says Not eligible"]
    overview = call("GET", "/v1/contentrewards")[1]
    assert overview["campaigns"][0]["chip"] == "Waiting for the brand"


def test_add_from_a_fresh_copy_when_the_public_read_fails(call: Call, cr: Any, clock: Clock) -> None:
    seed_finder(cr, matches=[UUID])
    read_at = seed_copy(cr, application=False, age=timedelta(hours=23))
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")  # no public JSON and no page: platform_down
    assert status == 201
    campaign = body["campaign"]
    assert campaign["budget"]["asOf"] == read_at  # Content Rewards' numbers say when they were read
    assert campaign["name"] == "$8,500 FaZe Tournament Clipping Campaign"
    assert (campaign["membership"], campaign["said"]) == ("manual", "joined_by_hand")
    item = item_of(cr) or {}
    assert (item["publicAt"], item["addedBy"]) == (read_at, "finder")
    assert crfind(cr)["added"] == {UUID: iso(clock.now)}


def test_a_stale_copy_never_stands_in(call: Call, cr: Any) -> None:
    seed_finder(cr, matches=[UUID])
    seed_copy(cr, application=False, age=timedelta(hours=25))
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert (status, body["error"]["code"]) == (503, "platform_down")
    assert item_of(cr) is None
    assert "added" not in crfind(cr)


def test_add_refuses_what_is_not_his_match_and_twice_is_200(call: Call, cr: Any) -> None:
    seed_finder(cr, matches=[UUID])
    status, body = call("POST", f"{BASE}/matches/{UUID2}/add")
    assert (status, body["error"]["message"]) == (
        404,
        "That campaign isn't in your matches any more. Tap Look again now.",
    )
    assert call("POST", f"{BASE}/matches/nope/add")[0] == 404
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=False)
    assert call("POST", f"{BASE}/matches/{UUID}/add")[0] == 201
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert (status, body["campaign"]["campaignId"]) == (200, UUID)
    assert body["campaign"]["said"] == "joined_by_hand"  # the first answer stays


def test_an_opened_or_hidden_campaign_can_be_added(call: Call, cr: Any, clock: Clock) -> None:
    seed_finder(cr, opened={UUID: iso(clock.now)}, hidden={UUID2})
    cr.net.public[JSON_URL_FOR(UUID)] = public_campaign(UUID, application=False)
    cr.net.public[JSON_URL_FOR(UUID2)] = public_campaign(UUID2, application=False)
    assert call("POST", f"{BASE}/matches/{UUID}/add")[0] == 201
    assert call("POST", f"{BASE}/matches/{UUID2}/add")[0] == 201


def test_a_campaign_gone_from_content_rewards(call: Call, cr: Any) -> None:
    from cr_support import response

    seed_finder(cr, matches=[UUID])
    seed_copy(cr)
    cr.net.public[JSON_URL_FOR(UUID)] = response(404, {"error": {"code": "NOT_FOUND"}})
    status, body = call("POST", f"{BASE}/matches/{UUID}/add")
    assert (status, body["error"]["message"]) == (404, "That campaign is gone from Content Rewards. Pick another one.")


# --- joined: adopting -------------------------------------------------------------------------------------------------


def test_joined_needs_the_sign_in(call: Call, cr: Any, clock: Clock) -> None:
    seed_finder(cr, matches=[UUID], opened={UUID: iso(clock.now - timedelta(minutes=3))})
    seed_copy(cr)
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}
    assert cr.net.requests == []
    seed_connection(cr, USER, clock.now, blocked=True)
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}
    assert cr.net.calls() == []


def test_joined_adds_what_he_opened_and_joined_as_a_modify_to_in(call: Call, cr: Any, clock: Clock, table: Any) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, matches=[UUID], opened={UUID: iso(clock.now - timedelta(minutes=3))})
    read_at = seed_copy(cr, application=False)
    cr.net.answer("list_my_campaigns", page([listed(access="open")]))
    now = clock.now
    status, body = call("POST", f"{BASE}/joined")
    assert status == 200
    [summary] = body["added"]
    assert (summary["campaignId"], summary["membership"], summary["celebrate"]) == (UUID, "in", "in")
    assert len(cr.net.calls("list_my_campaigns")) == 1
    writes = [(op, kw) for op, kw in table.calls if op in ("put_item", "update_item")]
    sk = db.campaign_sk(UUID)
    put = [kw["Item"] for op, kw in writes if op == "put_item" and kw["Item"]["sk"] == sk]
    assert len(put) == 1
    assert put[0]["membership"] == "unknown"
    assert put[0]["addedBy"] == "finder"
    updates = [kw for op, kw in writes if op == "update_item" and kw["Key"]["sk"] == sk]
    assert any("membership" in u["ExpressionAttributeNames"].values() for u in updates)  # … then a MODIFY to in
    item = item_of(cr) or {}
    assert (item["membership"], item["celebrate"], item["publicAt"]) == ("in", "in", read_at)
    assert crfind(cr)["added"] == {UUID: iso(now)}
    from clipfactory_api.push import notify

    class Deps:
        clock = staticmethod(lambda: now)

    found = notify.cr_event(Deps(), USER, sk, db.from_dynamo(put[0]), item)  # type: ignore[arg-type]
    assert found is not None
    assert found[0] == f"in:{UUID}"
    assert found[1].body == "You're in! Tap to make clips."
    assert call("GET", BASE)[1]["matches"] == []


def test_joined_never_adds_an_ambiguous_one(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now, typeidVerified=False)
    seed_finder(cr, opened={UUID: iso(clock.now - timedelta(minutes=3))})
    seed_copy(cr, application=False)
    twins = [listed_campaign(ids.typeid("cmp", other_uuid(n)), access="open", org=ORG, platforms=None) for n in (1, 2)]
    cr.net.answer("list_my_campaigns", page(twins))
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}
    assert item_of(cr) is None


def test_joined_never_brings_back_a_removed_campaign(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(
        cr, opened={UUID: iso(clock.now - timedelta(hours=1))}, added={UUID: iso(clock.now - timedelta(hours=1))}
    )
    seed_copy(cr, application=False)
    cr.net.answer("list_my_campaigns", page([listed(access="open")]))
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}  # added, then removed, still listed
    assert item_of(cr) is None
    assert cr.net.calls("list_my_campaigns") == []


def test_joined_never_adds_a_match_he_did_not_open_or_opened_long_ago(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, matches=[UUID, UUID2], opened={UUID2: iso(clock.now - timedelta(hours=48, minutes=1))})
    seed_copy(cr, UUID, application=False)
    seed_copy(cr, UUID2, application=False)
    cr.net.answer("list_my_campaigns", page([listed(UUID, access="open"), listed(UUID2, access="open")]))
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}
    assert item_of(cr, UUID) is None
    assert item_of(cr, UUID2) is None
    assert finderapi.candidates(cr, USER, clock.now) == []


def test_joined_needs_the_looks_copy_and_skips_his_own(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_campaign(cr.store, USER, clock.now, uuid=UUID2)
    seed_finder(cr, opened={UUID: iso(clock.now), UUID2: iso(clock.now)})
    seed_copy(cr, UUID2)
    assert finderapi.candidates(cr, USER, clock.now) == []  # UUID has no copy, UUID2 is his already
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}


def test_joined_at_most_every_30_seconds(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, opened={UUID: iso(clock.now)})
    seed_copy(cr, application=False)
    cr.net.answer("list_my_campaigns", page([]))
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}
    assert crfind(cr)["joinedAt"]
    clock.now += timedelta(seconds=10)
    cr.net.answer("list_my_campaigns", page([listed(access="open")]))
    assert call("POST", f"{BASE}/joined")[1] == {"added": []}  # inside the 30 seconds
    assert len(cr.net.calls("list_my_campaigns")) == 1
    clock.now += timedelta(minutes=3)  # past the 2-minute list cache too
    assert [s["campaignId"] for s in call("POST", f"{BASE}/joined")[1]["added"]] == [UUID]


def test_joined_adds_at_most_5(call: Call, cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    uuids = [other_uuid(n) for n in range(1, 7)]
    seed_finder(cr, opened={u: iso(clock.now - timedelta(minutes=n)) for n, u in enumerate(uuids)})
    for u in uuids:
        seed_copy(cr, u, application=False)
    cr.net.answer("list_my_campaigns", page([listed(u, access="open") for u in uuids]))
    added = call("POST", f"{BASE}/joined")[1]["added"]
    assert [s["campaignId"] for s in added] == uuids[:5]  # newest open first
    assert item_of(cr, uuids[5]) is None


def test_adopting_a_campaign_he_opened_from_the_finder_starts_its_rules_read(cr: Any, clock: Clock) -> None:
    seed_connection(cr, USER, clock.now)
    seed_finder(cr, opened={UUID: iso(clock.now)})
    seed_copy(cr, application=False)
    cr.net.answer("list_my_campaigns", page([listed(access="open")]))
    rows, _ = cr.mcp(USER).list_all("list_my_campaigns", {}, 1)
    cr._lists[USER] = (cr.monotonic(), rows, True)  # the list just read (cached for this container)
    [summary] = finderapi.adopt(cr, USER, rows, clock.now)
    assert summary["membership"] == "in"
    assert (item_of(cr) or {})["rulesState"] == "reading"  # §38.12 step 3: the rules read starts there
    assert ("read_campaign", (USER, UUID)) in cr.invoker.calls
