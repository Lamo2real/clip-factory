"""His answers on the question cards (docs/CONTRACTS.md §40.5.8, tests §40.5.13 "api (BA)": answers).

Owner rules: he never types an amount (every answer is a tap, and no answer changes ``amountMinor``, ``currency`` or
``date``); only a platform word in the payer's *name* is ever learned, so a stranger who wrote "YOUTUBE" in a message
is never learned as YouTube; "Not money from an app" keeps only the row's id, day, link, why and ttl.
"""

from __future__ import annotations

from typing import Any

import pytest

from bank_cases import LINK_A, dep, link, setup_bank
from clipfactory_api import db
from clipfactory_api.app import App
from clipfactory_api.bank import answers
from conftest import USER, Call

PK = db.user_pk(USER)
PAYER = "0123456789abcdef0123456789abcdef"
OTHER_PAYER = "fedcba9876543210fedcba9876543210"


@pytest.fixture(autouse=True)
def _bank(app: App) -> None:
    setup_bank(app)
    app.store.put({"pk": PK, "sk": f"BANKLINK#{LINK_A}", **link()})


def seed(app: App, *rows: dict[str, Any]) -> None:
    for row in rows:
        app.store.put({"pk": PK, **row})


def row(app: App, deposit_id: str) -> dict[str, Any]:
    found = next(i for i in app.store.query_all(PK, "DEPOSIT#") if i["depositId"] == deposit_id)
    return {k: v for k, v in found.items() if k not in {"pk", "sk"}}


def payers(app: App) -> dict[str, Any]:
    return app.store.get(PK, "BANKPAYERS") or {}


def answer(call: Call, deposit_id: str, body: dict[str, Any]) -> tuple[int, Any]:
    return call("PATCH", f"/v1/getpaid/bank/deposits/{deposit_id}", body)


def money(found: dict[str, Any]) -> tuple[Any, Any, Any]:
    return found.get("amountMinor"), found.get("currency"), found.get("date")


def test_yes_learns_a_payer_named_in_the_payers_name_and_matches_its_other_rows(call: Call, app: App) -> None:
    first = dep(
        "needs_you",
        "2026-11-18",
        8500,
        deposit_id="1" * 32,
        suggested="youtube",
        hint="youtube",
        hintFrom="payer",
        payerKey=PAYER,
        shared=False,
    )
    same = dep(
        "needs_you",
        "2026-11-19",
        9100,
        deposit_id="2" * 32,
        suggested="youtube",
        hint="youtube",
        hintFrom="payer",
        payerKey=PAYER,
    )
    text_only = dep(
        "needs_you",
        "2026-11-20",
        7700,
        deposit_id="3" * 32,
        suggested="youtube",
        hint="youtube",
        hintFrom="text",
        payerKey=PAYER,
    )
    seed(app, first, same, text_only)
    status, body = answer(call, "1" * 32, {"answer": "yes"})
    assert status == 200
    found = row(app, "1" * 32)
    assert found["state"] == "matched"
    assert found["place"] == "youtube"
    assert found["how"] == "you"
    assert found["confirmedAt"] == "2026-11-15T12:00:00.000Z"
    for gone in ("suggested", "kind", "hint", "notSure", "ttl"):
        assert gone not in found, gone
    assert (found["payerKey"], found["hintFrom"]) == (PAYER, "payer")  # kept, so he can undo it
    assert money(found) == money(first)
    assert payers(app)["rules"] == {PAYER: {"place": "youtube", "learnedAt": "2026-11-15T12:00:00.000Z"}}
    learned = row(app, "2" * 32)
    assert (learned["state"], learned["how"], learned["place"]) == ("matched", "payer", "youtube")
    assert row(app, "3" * 32)["state"] == "needs_you"  # a word only in the message is asked about every time
    assert [r["depositId"] for r in body["rows"]] == ["2" * 32, "1" * 32]
    assert [a["depositId"] for a in body["asks"]] == ["3" * 32]


@pytest.mark.parametrize(
    "extra",
    [
        {"hintFrom": "text", "payerKey": PAYER},
        {"hintFrom": "payer", "payerKey": PAYER, "shared": True},
        {"hintFrom": "payer"},
    ],
    ids=["only in the message", "shared (Stripe, PayPal, Payoneer)", "no payer name"],
)
def test_yes_learns_nothing_otherwise(call: Call, app: App, extra: dict[str, Any]) -> None:
    seed(app, dep("needs_you", "2026-11-18", 8500, deposit_id="1" * 32, suggested="youtube", hint="youtube", **extra))
    assert answer(call, "1" * 32, {"answer": "yes"})[0] == 200
    assert row(app, "1" * 32)["state"] == "matched"
    assert payers(app) == {}


def test_yes_needs_a_suggestion(call: Call, app: App) -> None:
    seed(app, dep("needs_you", "2026-11-20", 15000, deposit_id="1" * 32, hint="paypal", shared=True))
    status, body = answer(call, "1" * 32, {"answer": "yes"})
    assert (status, body["error"]["message"]) == (400, "Pick a place from the list.")


def test_a_place_from_the_sheet(call: Call, app: App) -> None:
    seed(
        app,
        dep(
            "needs_you",
            "2026-11-20",
            15000,
            deposit_id="1" * 32,
            hint="paypal",
            hintFrom="payer",
            payerKey=PAYER,
            shared=True,
        ),
        dep(
            "needs_you",
            "2026-11-12",
            91240,
            deposit_id="2" * 32,
            suggested="meta",
            hint="meta",
            hintFrom="payer",
            payerKey=OTHER_PAYER,
        ),
    )
    for bad in ("contentrewards", "amazon", None, 3):
        status, body = answer(call, "1" * 32, {"answer": "place", "place": bad})
        assert (status, body["error"]["message"]) == (400, "Pick a place from the list."), bad
    assert answer(call, "1" * 32, {"answer": "place", "place": "tiktok"})[0] == 200
    assert (row(app, "1" * 32)["place"], row(app, "1" * 32)["how"]) == ("tiktok", "you")
    assert payers(app) == {}  # PayPal carries money from more than one place
    assert answer(call, "2" * 32, {"answer": "place", "place": "meta"})[0] == 200
    assert row(app, "2" * 32)["place"] == "meta"
    assert payers(app)["rules"][OTHER_PAYER]["place"] == "meta"


def test_content_rewards_only_while_it_is_on(call: Call, app: App) -> None:
    from cr_support import FakeCR, make_deps
    from fakes import FakeSecretsManager

    seed(app, dep("needs_you", "2026-11-15", 21000, deposit_id="1" * 32, suggested="contentrewards", hint="whop"))
    status, _ = answer(call, "1" * 32, {"answer": "yes"})
    assert status == 400
    app.contentrewards = make_deps(app.store, FakeSecretsManager(), FakeCR(), app.clock)
    assert answer(call, "1" * 32, {"answer": "yes"})[0] == 200
    assert row(app, "1" * 32)["place"] == "contentrewards"


def test_own_move(call: Call, app: App) -> None:
    move = dep(
        "needs_you",
        "2026-11-21",
        50000,
        deposit_id="1" * 32,
        kind="own_move",
        hint="paypal",
        hintFrom="payer",
        payerKey=PAYER,
    )
    other = dep("needs_you", "2026-11-20", 15000, deposit_id="2" * 32, hint="paypal")
    seed(app, move, other)
    status, body = answer(call, "2" * 32, {"answer": "own_move"})
    assert (status, body["error"]["message"]) == (409, "That one is answered already.")
    assert answer(call, "1" * 32, {"answer": "own_move"})[0] == 200
    found = row(app, "1" * 32)
    assert found == {
        "type": "deposit",
        "depositId": "1" * 32,
        "state": "not_income",
        "date": "2026-11-21",
        "linkId": LINK_A,
        "why": "own_move",
        "ttl": 1829779200,  # the booking day + 400 days
    }
    assert payers(app) == {}


def test_not_sure_is_never_counted(call: Call, app: App) -> None:
    seed(app, dep("needs_you", "2026-11-16", 7000, deposit_id="1" * 32, suggested="tiktok", hint="tiktok"))
    status, body = answer(call, "1" * 32, {"answer": "not_sure"})
    assert status == 200
    assert row(app, "1" * 32)["notSure"] is True
    assert row(app, "1" * 32)["state"] == "needs_you"
    assert body["asks"][0]["notSure"] is True
    assert body["reached"]["totals"] == []
    assert "needYou" not in body["reached"]


def test_not_money_from_an_app(call: Call, app: App) -> None:
    seed(
        app,
        dep(
            "needs_you",
            "2026-11-18",
            8500,
            deposit_id="1" * 32,
            suggested="youtube",
            hint="youtube",
            hintFrom="payer",
            payerKey=PAYER,
            quiet=True,
        ),
        dep(
            "needs_you",
            "2026-11-19",
            9100,
            deposit_id="2" * 32,
            suggested="youtube",
            hint="youtube",
            hintFrom="payer",
            payerKey=PAYER,
        ),
        dep(
            "needs_you",
            "2026-11-19",
            32170,
            deposit_id="3" * 32,
            suggested="x",
            hint="stripe",
            payerKey=OTHER_PAYER,
            shared=True,
        ),
    )
    assert answer(call, "1" * 32, {"answer": "not_income"})[0] == 200
    found = row(app, "1" * 32)
    assert set(found) == {"type", "depositId", "state", "date", "linkId", "why", "ttl"}  # the amount is gone too
    assert (found["state"], found["why"]) == ("not_income", "you")
    assert payers(app)["notIncome"] == [PAYER]
    assert row(app, "2" * 32)["state"] == "needs_you"  # he answers each one
    assert answer(call, "3" * 32, {"answer": "not_income"})[0] == 200
    assert payers(app)["notIncome"] == [PAYER]  # a shared payer is never written off


def test_not_from_youtube_frees_the_payout(call: Call, app: App) -> None:
    matched = dep(
        "matched",
        "2026-10-28",
        123456,
        deposit_id="1" * 32,
        place="youtube",
        how="payout",
        payoutRef="PAYOUT#youtube#2026-10-21#p1",
        payoutDate="2026-10-21",
        notPayout=["PAYOUT#youtube#2026-09-21#p0"],
        confirmedAt="2026-10-29T06:00:00.000Z",
    )
    seed(app, matched)
    status, body = answer(call, "1" * 32, {"answer": "not_this"})
    assert status == 200
    found = row(app, "1" * 32)
    assert found["state"] == "needs_you"
    assert found["kind"] == "place"
    assert found["notSure"] is False
    for gone in ("place", "how", "payoutRef", "payoutDate", "confirmedAt", "suggested"):
        assert gone not in found, gone
    assert found["notPayout"] == ["PAYOUT#youtube#2026-09-21#p0", "PAYOUT#youtube#2026-10-21#p1"]
    assert found["ttl"] == 1810857600  # 180 days from today, the latest of booking, fetch and now
    assert money(found) == money(matched)
    assert body["rows"] == []
    assert body["pairs"] == []
    assert body["asks"][0]["title"] == "Where is this money from?"


def test_not_from_a_learned_payer_forgets_it_but_keeps_its_old_rows(call: Call, app: App) -> None:
    app.store.put(
        {
            "pk": PK,
            "sk": "BANKPAYERS",
            "type": "bankpayers",
            "rules": {
                PAYER: {"place": "meta", "learnedAt": "2026-10-01T00:00:00.000Z"},
                OTHER_PAYER: {"place": "x", "learnedAt": "2026-10-01T00:00:00.000Z"},
            },
        }
    )
    seed(
        app,
        dep(
            "matched",
            "2026-11-12",
            91240,
            deposit_id="1" * 32,
            place="meta",
            how="payer",
            payerKey=PAYER,
            hintFrom="payer",
        ),
        dep(
            "matched",
            "2026-10-12",
            81240,
            deposit_id="2" * 32,
            place="meta",
            how="payer",
            payerKey=PAYER,
            hintFrom="payer",
        ),
    )
    assert answer(call, "1" * 32, {"answer": "not_this"})[0] == 200
    assert payers(app)["rules"] == {OTHER_PAYER: {"place": "x", "learnedAt": "2026-10-01T00:00:00.000Z"}}
    assert row(app, "1" * 32)["state"] == "needs_you"
    assert row(app, "2" * 32)["state"] == "matched"


def test_refusals(call: Call, app: App) -> None:
    seed(
        app,
        dep("needs_you", "2026-11-18", 8500, deposit_id="1" * 32, suggested="youtube", hint="youtube"),
        dep("matched", "2026-10-28", 123456, deposit_id="2" * 32, place="youtube", how="you"),
    )
    status, body = answer(call, "1" * 32, {"answer": "maybe"})
    assert (status, body["error"]["message"]) == (400, "That answer isn't known.")
    status, body = answer(call, "9" * 32, {"answer": "yes"})
    assert status == 404
    status, body = answer(call, "not-an-id", {"answer": "yes"})
    assert status == 404
    for kind in ("yes", "place", "own_move", "not_sure", "not_income"):
        status, body = answer(call, "2" * 32, {"answer": kind, "place": "x"} if kind == "place" else {"answer": kind})
        assert (status, body["error"]["message"]) == (409, "That one is answered already."), kind
    status, body = answer(call, "1" * 32, {"answer": "not_this"})
    assert (status, body["error"]["message"]) == (409, "That one is answered already.")
    status, body = answer(call, "1" * 32, {"answer": "yes", "amount": 100})
    assert status == 400  # he never types an amount


def test_an_answer_and_a_match_made_meanwhile_never_both_win(
    call: Call, app: App, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed(app, dep("needs_you", "2026-11-18", 8500, deposit_id="1" * 32, suggested="youtube", hint="youtube"))
    stale = dict(app.store.query_all(PK, "DEPOSIT#")[0])
    app.store.update_expr(PK, stale["sk"], "SET #s = :m", names={"#s": "state"}, values={":m": "matched"})
    monkeypatch.setattr(answers, "find", lambda *_a: stale)  # the reader matched it after he loaded the page
    status, body = answer(call, "1" * 32, {"answer": "place", "place": "tiktok"})
    assert (status, body["error"]["message"]) == (409, "That one is answered already.")
    assert "place" not in row(app, "1" * 32)


def test_no_answer_ever_changes_an_amount(call: Call, app: App) -> None:
    rows = [
        dep(
            "needs_you",
            "2026-11-18",
            8500,
            deposit_id="1" * 32,
            suggested="youtube",
            hint="youtube",
            hintFrom="payer",
            payerKey=PAYER,
        ),
        dep("needs_you", "2026-11-19", 4000, "USD", deposit_id="2" * 32, suggested="x", hint="stripe", shared=True),
        dep("needs_you", "2026-11-17", 1234, "KWD", deposit_id="3" * 32, suggested="meta", hint="meta"),
    ]
    seed(app, *rows)
    for found, kind in zip(rows, ("yes", "not_sure", "place"), strict=True):
        payload = {"answer": kind, "place": "facebook"} if kind == "place" else {"answer": kind}
        assert answer(call, found["depositId"], payload)[0] == 200
        assert money(row(app, found["depositId"])) == money(found)
        assert row(app, found["depositId"])["exponent"] == found["exponent"]
    assert answer(call, "1" * 32, {"answer": "not_this"})[0] == 200
    assert money(row(app, "1" * 32)) == money(rows[0])
