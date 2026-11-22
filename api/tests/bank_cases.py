"""The shared cases and fakes of Your bank's API side (docs/CONTRACTS.md §40.5, tests §40.5.13 "api (BA)").

Golden files (``uv run python tests/bank_cases.py`` from ``api/`` writes them again after a deliberate change; the
expected answers come from the code and every case is read by hand in review):

* ``fixtures/bank_view_cases.json``: one owner's stored items and the ``BankView`` the server makes of them: every
  status, pill and line, the worst-link order, the rings, ``next`` for every step and for a reconnect, the autos,
  ``fold``, the totals per place per currency (never across), ``meta``, the questions, ``pairs``, ``places`` in all
  three states and ``lastConnect``.
* ``fixtures/bank_steps.json``: the step ids, roles and autos (the web's ``BANK_GUIDE`` is checked against it).
* ``fixtures/bank_items.json``: the items and secrets of §40.5.11 (key, who writes them, every attribute, one
  example); BR's reader is checked against it when it is there.

The fakes are offline only: ``FakeBank`` stands in for Enable Banking (no network, no bank), ``Mono`` for the
monotonic clock the deadlines read. Every name, IBAN and address below is made up.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from clipfactory_api.bank import EB_HOST, STEPS, view
from clipfactory_api.clock import iso, parse
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError

FIXTURES = Path(__file__).parent / "fixtures"
VIEW_FILE = FIXTURES / "bank_view_cases.json"
STEPS_FILE = FIXTURES / "bank_steps.json"
ITEMS_FILE = FIXTURES / "bank_items.json"

APP_URL = "https://d111111abcdef8.cloudfront.net"
HOOKS_URL = "https://abc123.execute-api.eu-north-1.amazonaws.com/v1"
REDIRECT = f"{HOOKS_URL}/oauth/bank/callback"
VALUES = view.values(APP_URL, REDIRECT)
APP_ID = "0f6e1d2c-3b4a-4c5d-8e9f-a0b1c2d3e4f5"
NOW = "2026-11-22T12:00:00.000Z"
T0 = "2026-11-01T09:00:00.000Z"
LINK_A = "a1b2c3d4e5f6"
LINK_B = "0a1b2c3d4e5f"
# Made-up personal data Enable Banking's answers can hold. None of it may ever reach an item, a secret, a log line,
# a response or a redirect.
LEAKS = (
    "Anna Andersson",
    "SE4550000000058398257466",
    "5000-0000058398257466",
    "Storgatan 1",
    "Privatkonto",
    "Andersson Konsult AB",
    "SE7280000810340009783242",
)

# --- Enable Banking, offline --------------------------------------------------------------------------------------


class Mono:
    """A monotonic clock the fake bank moves forward (a slow answer takes time)."""

    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class FakeBank:
    """Enable Banking: ``on(method, path_prefix, *answers)``; each answer is ``(status, body)``,
    ``(status, body, seconds)`` (it takes that long: past the call's timeout it is a network timeout) or an exception.
    The last answer of a route repeats. Every request is recorded with its timeout."""

    def __init__(self, mono: Mono) -> None:
        self.mono = mono
        self.routes: dict[tuple[str, str], list[Any]] = {}
        self.calls: list[dict[str, Any]] = []

    def on(self, method: str, prefix: str, *answers: Any) -> FakeBank:
        self.routes[(method, prefix)] = list(answers)
        return self

    def paths(self, method: str | None = None) -> list[str]:
        return [c["path"] for c in self.calls if method is None or c["method"] == method]

    def __call__(self, request: HttpRequest, timeout: float) -> HttpResponse:
        assert request.url.startswith(EB_HOST + "/"), request.url
        path = request.url[len(EB_HOST) :]
        body = json.loads(request.body) if request.body else None
        self.calls.append(
            {"method": request.method, "path": path, "headers": dict(request.headers), "body": body, "timeout": timeout}
        )
        found = sorted(
            (k for k in self.routes if k[0] == request.method and path.startswith(k[1])), key=lambda k: -len(k[1])
        )
        assert found, f"unexpected call: {request.method} {path}"
        answers = self.routes[found[0]]
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, BaseException):
            raise answer
        status, payload, *rest = answer
        seconds = float(rest[0]) if rest else 0.0
        if seconds > timeout:
            self.mono.t += timeout
            raise NetworkError("timeout")
        self.mono.t += seconds
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return HttpResponse(status, {}, raw)


APPLICATION = {
    "name": "Clip Factory",
    "kid": APP_ID,
    "environment": "PRODUCTION",
    "active": True,
    "redirect_urls": [REDIRECT],
    "countries": ["SE"],
}
ASPSPS = {
    "aspsps": [
        {
            "name": "Swedbank",
            "country": "SE",
            "psu_types": ["personal", "business"],
            "maximum_consent_validity": 180 * 86400,
            "beta": False,
            "required_psu_headers": ["Psu-Ip-Address", "Psu-User-Agent"],
        },
        {"name": "PayPal", "country": "SE", "psu_types": ["personal"], "maximum_consent_validity": 90 * 86400},
        {"name": "Företagsbanken", "country": "SE", "psu_types": ["business"], "maximum_consent_validity": 15552000},
        {
            "name": "Avanza Bank",
            "country": "SE",
            "psu_types": ["personal"],
            "maximum_consent_validity": 7776000,
            "beta": True,
        },
    ]
}
AUTH = {"url": "https://tilisy.enablebanking.com/welcome?sessionid=fake-1", "authorization_id": "auth-fake-1"}
SESSION = {
    "session_id": "sess-new-1",
    "accounts": [
        {
            "uid": "uid-priv-1",
            "identification_hash": "idhash-priv-1",
            "usage": "PRIV",
            "name": "Anna Andersson",
            "account_id": {"iban": "SE4550000000058398257466"},
            "all_account_ids": [{"identification": "5000-0000058398257466", "scheme_name": "BBAN"}],
            "postal_address": {"street_name": "Storgatan 1"},
            "product": "Privatkonto",
            "currency": "SEK",
        },
        {
            "uid": "uid-orga-1",
            "identification_hash": "idhash-orga-1",
            "usage": "ORGA",
            "name": "Andersson Konsult AB",
            "account_id": {"iban": "SE7280000810340009783242"},
        },
    ],
    "aspsp": {"name": "Swedbank", "country": "SE"},
    "psu_type": "personal",
    "access": {"valid_until": "2027-05-21T11:50:00+00:00"},
}
LEAKY_ERROR = {
    "code": 422,
    "error": "WRONG_REQUEST_PARAMETERS",
    "message": "Account SE4550000000058398257466 of Anna Andersson, Storgatan 1",
    "detail": {"iban": "SE4550000000058398257466", "name": "Anna Andersson"},
}


def eb_error(code: str, status: int = 400) -> tuple[int, dict[str, Any]]:
    return status, {"code": status, "error": code, "message": f"{code} for Anna Andersson SE4550000000058398257466"}


# --- the test key (RSA-4096 is made once in test_bank_keys; everything else uses this 2048-bit one) ---------------

_KEY: list[Any] = []


def quick_key() -> Any:
    if not _KEY:
        from cryptography.hazmat.primitives.asymmetric import rsa

        _KEY.append(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    return _KEY[0]


def use_quick_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """``keys._generate`` gives the cached test key (an RSA-4096 pair takes a moment)."""
    from clipfactory_api.bank import keys

    monkeypatch.setattr(keys, "_generate", quick_key)


def forget_caches() -> None:
    from clipfactory_api.bank import eb, grants

    eb.forget_cache()
    grants.forget_lists()


def setup_bank(app: Any) -> FakeBank:
    """Your bank switched on, with the fake Enable Banking and its clock."""
    fake = FakeBank(Mono())
    app.bank_reading = True
    app.bank_http = fake
    app.bank_monotonic = fake.mono
    return fake


def hooks_deps(app: Any, fake: FakeBank) -> Any:
    """``cf-prod-hooks`` with the same store, secrets and fake Enable Banking as the API."""
    from clipfactory_api import hooks
    from fakes import FakeSSM

    return hooks.HooksDeps(
        store=app.store,
        app_url=APP_URL,
        verify_token=hooks.ssm_token_reader(FakeSSM(), "/cf-prod/hooks/verify-token"),
        clock=app.clock,
        oauth=app.oauth,
        bank_http=fake,
        bank_monotonic=fake.mono,
    )


def come_back(deps: Any, query: dict[str, str]) -> str:
    """BankID's return through ``cf-prod-hooks``: always a 302 to ``/bank-done`` with a listed result."""
    from clipfactory_api import hooks
    from clipfactory_api.bank import RESULTS

    event = {
        "httpMethod": "GET",
        "resource": "/oauth/{platform}/callback",
        "path": "/oauth/bank/callback",
        "pathParameters": {"platform": "bank"},
        "queryStringParameters": query,
        "headers": {},
        "requestContext": {"requestId": "rest-bank", "stage": "v1"},
    }
    out = hooks.handle(event, deps)
    assert out["statusCode"] == 302, out
    assert out["headers"]["cache-control"] == "no-store"
    assert out["headers"]["referrer-policy"] == "no-referrer"
    location = out["headers"]["location"]
    prefix = f"{APP_URL}/bank-done?result="
    assert location.startswith(prefix), location
    result = location[len(prefix) :]
    assert result in RESULTS
    return result


# --- stored items, as §40.5.11 shapes them ------------------------------------------------------------------------


def conn(
    status: str | None = "saved",
    check: str | None = "ok",
    ticks: tuple[str, ...] = (),
    source: str = "clipfactory",
    **extra: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {"type": "bankconn", "updatedAt": T0, **extra}
    if ticks:
        out["stepsDone"] = sorted(ticks)
    if status is None:
        return out
    app: dict[str, Any] = {"status": status, "source": source, "keyMadeAt": T0}
    if status == "saved":
        app.update(savedAt=T0, appIdHint="0f6e1d2c…")
    if check:
        app["check"] = {"code": check, "at": T0}
        app["active"] = check == "ok"
        app["environment"] = "SANDBOX" if check == "sandbox" else "PRODUCTION"
    out["app"] = app
    return out


def days(base: str, n: float) -> str:
    moment = parse(base)
    assert moment is not None
    return iso(moment + timedelta(days=n))


def link(
    link_id: str = LINK_A,
    bank: str = "Swedbank",
    status: str = "connected",
    *,
    connected: str = T0,
    total: int = 180,
    first_read: bool = True,
    **extra: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "banklink",
        "linkId": link_id,
        "bank": bank,
        "country": "SE",
        "status": status,
        "consentUntil": days(connected, total),
        "connectedAt": connected,
        "firstConnectedAt": connected,
        "accountCount": 2,
        "psuHeaders": ["psu-ip-address", "psu-user-agent"],
        "firstReadDone": first_read,
        "updatedAt": connected,
    }
    if first_read:
        out.update(lastReadAt="2026-11-22T06:00:00.000Z", readThrough="2026-11-22", historyFrom="2026-08-03")
    out.update(extra)
    return out


def dep(
    state: str, day: str, minor: int, currency: str = "SEK", deposit_id: str | None = None, **extra: Any
) -> dict[str, Any]:
    deposit_id = deposit_id or (day.replace("-", "") + f"{minor:024d}")[-32:]
    out: dict[str, Any] = {
        "type": "deposit",
        "sk": f"DEPOSIT#{day}#{deposit_id}",
        "depositId": deposit_id,
        "state": state,
        "date": day,
        "amountMinor": minor,
        "exponent": 3 if currency in {"KWD", "BHD"} else 0 if currency == "JPY" else 2,
        "currency": currency,
        "linkId": LINK_A,
        "source": "enable_banking",
        "fetchedAt": "2026-11-22T06:00:00.000Z",
        **extra,
    }
    if state == "needs_you":
        out.setdefault("kind", "place")
        out.setdefault("ttl", int(parse("2027-05-21T00:00:00Z").timestamp()))  # type: ignore[union-attr]
    return out


DONE_TICKS = ("bank-account", "bank-app", "bank-details")


def run(case: dict[str, Any]) -> dict[str, Any]:
    now = parse(case["now"])
    assert now is not None
    return view.view(case["items"], now, cr_on=case["crOn"], values=VALUES)


def _case(name: str, items: dict[str, Any], *, now: str = NOW, cr_on: bool = False) -> dict[str, Any]:
    out = {"name": name, "now": now, "crOn": cr_on, "items": items}
    out["expect"] = run(out)
    return out


KEY_PARTS = {"publicKeyPem": "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n", "source": "clipfactory"}


def build_view() -> dict[str, list[dict[str, Any]]]:
    setup = [
        _case("not started: nothing at all", {"conn": {}, "links": [], "deposits": []}),
        _case("not started: the optional email alone never counts", {"conn": conn(None, ticks=("bank-ask",))}),
        _case(
            "step 1 next after the key: Open Enable Banking",
            {"conn": conn("key_made", None), "key": KEY_PARTS},
        ),
        _case(
            "step 4 next: no Open, so no vermilion",
            {"conn": conn("key_made", None, ticks=("bank-account", "bank-app")), "key": KEY_PARTS},
        ),
        _case(
            "step 5 next while no app ID is saved: Save",
            {"conn": conn("key_made", None, ticks=DONE_TICKS), "key": KEY_PARTS},
        ),
        _case(
            "step 5 after a save: Check again, and the check's sentence is the line",
            {"conn": conn("saved", "key_wrong", ticks=DONE_TICKS), "key": KEY_PARTS},
        ),
        _case(
            "not_active: steps 1, 3 and 4 tick themselves, step 6 next",
            {"conn": conn("saved", "not_active"), "key": KEY_PARTS},
        ),
        _case("ok: step 7 next, Connect your bank", {"conn": conn("saved", "ok", ticks=("bank-ask",))}),
        _case(
            "a .pem was saved: the reminder stays until I deleted it",
            {"conn": conn("saved", "not_active", source="file"), "key": {**KEY_PARTS, "source": "file"}},
        ),
        _case(
            "a .pem was saved and deleted",
            {"conn": conn("saved", "not_active", ticks=("pem-deleted",), source="file")},
        ),
        _case(
            "key_wrong after connecting unfolds the steps again",
            {"conn": conn("saved", "key_wrong"), "links": [link()]},
        ),
    ]
    one = "2026-11-22T11:50:00.000Z"
    links = [
        _case(
            "checking: the first read is running",
            {"conn": conn(), "links": [link(connected=one, first_read=False)]},
        ),
        _case(
            "checking after 26 hours with no first read (no reader yet)",
            {"conn": conn(), "links": [link(connected="2026-11-21T09:00:00.000Z", first_read=False)]},
        ),
        _case(
            "can see: one bank, 143 days left", {"conn": conn(), "links": [link(connected="2026-10-16T12:00:00.000Z")]}
        ),
        _case(
            "can see: two banks, the first link ends in 98 days",
            {
                "conn": conn(),
                "links": [
                    link(connected="2026-10-16T12:00:00.000Z", firstConnectedAt="2026-05-01T09:00:00.000Z"),
                    link(LINK_B, "PayPal", connected="2026-09-01T12:00:00.000Z"),
                ],
            },
        ),
        _case(
            "a 90-day bank: the ring is out of 90",
            {"conn": conn(), "links": [link(LINK_B, "PayPal", connected="2026-11-10T12:00:00.000Z", total=90)]},
        ),
        _case("ending soon at 14 days", {"conn": conn(), "links": [link(connected="2026-06-09T12:00:00.000Z")]}),
        _case("15 days left is still can see", {"conn": conn(), "links": [link(connected="2026-06-10T12:00:00.000Z")]}),
        _case(
            "ends in 1 day",
            {"conn": conn(), "links": [link(connected="2026-05-26T13:00:00.000Z")]},
        ),
        _case(
            "failing for 25 hours still says can see",
            {"conn": conn(), "links": [link(failingSince="2026-11-21T11:00:00.000Z")]},
        ),
        _case(
            "can't read at 26 hours, no reconnect yet",
            {
                "conn": conn(),
                "links": [
                    link(
                        failingSince="2026-11-21T09:00:00.000Z",
                        lastError="Swedbank didn't answer. Clip Factory tries again tomorrow.",
                    )
                ],
            },
        ),
        _case(
            "can't read for 3 days: reconnect",
            {"conn": conn(), "links": [link(failingSince="2026-11-19T06:00:00.000Z")]},
        ),
        _case("look in your bank's app", {"conn": conn(), "links": [link(reason="psu_action")]}),
        _case(
            "ended: the link was over",
            {
                "conn": conn(),
                "links": [
                    link(
                        connected="2026-05-01T09:00:00.000Z",
                        status="ended",
                        reason="consent_over",
                        endedAt="2026-10-28T06:00:00.000Z",
                    )
                ],
            },
        ),
        _case(
            "ended early",
            {"conn": conn(), "links": [link(status="ended", reason="ended_early", endedAt="2026-11-20T06:00:00.000Z")]},
        ),
        _case(
            "past its end and nobody read it yet: ended",
            {"conn": conn(), "links": [link(connected="2026-05-01T09:00:00.000Z")]},
        ),
        _case("stopped outside Clip Factory", {"conn": conn(), "links": [link(status="stopped_at_bank")]}),
        _case(
            "every link stopped",
            {"conn": conn(), "links": [link(status="stopped", stoppedAt="2026-12-03T10:00:00.000Z")]},
            now="2026-12-05T12:00:00.000Z",
        ),
        _case(
            "worst link wins: ended beats can see; the stopped one stays a quiet row",
            {
                "conn": conn(),
                "links": [
                    link(connected="2026-10-15T12:00:00.000Z"),
                    link(LINK_B, "PayPal", status="ended", reason="ended_early", endedAt="2026-11-20T06:00:00.000Z"),
                    link("0c0c0c0c0c0c", "SEB", status="stopped", stoppedAt="2026-11-20T06:00:00.000Z"),
                ],
            },
        ),
        _case(
            "worst link wins: stopped outside beats look in your bank; reconnect picks stopped outside before ending",
            {
                "conn": conn(),
                "links": [
                    link(connected="2026-06-09T12:00:00.000Z", reason="psu_action"),
                    link(LINK_B, "PayPal", status="stopped_at_bank"),
                ],
            },
        ),
        _case(
            "a link Forget kept bare is never shown",
            {
                "conn": conn(),
                "links": [
                    {
                        "type": "banklink",
                        "linkId": LINK_B,
                        "bank": "PayPal",
                        "status": "stopped",
                        "stoppedAt": T0,
                        "closePending": True,
                    }
                ],
            },
        ),
    ]
    money = _money_cases()
    return {"setup": setup, "links": links, "money": money}


def _money_cases() -> list[dict[str, Any]]:
    yt = dep(
        "matched",
        "2026-10-28",
        123456,
        place="youtube",
        how="payout",
        payoutRef="PAYOUT#youtube#2026-10-21#p1",
        payoutDate="2026-10-21",
    )
    meta = dep(
        "matched", "2026-11-12", 91240, place="meta", how="payer", payerKey="k" * 32, hintFrom="payer", shared=False
    )
    x_usd = dep("matched", "2026-11-05", 4000, "USD", place="x", how="you", hintFrom="text", shared=True)
    cr = dep(
        "matched",
        "2026-11-14",
        41230,
        place="contentrewards",
        how="payout",
        payoutRef="PAYOUT#contentrewards#2026-11-10#po_1",
        payoutDate="2026-11-10",
    )
    ask_google = dep("needs_you", "2026-11-18", 8500, suggested="youtube", hint="youtube", hintFrom="payer")
    ask_stripe = dep("needs_you", "2026-11-19", 32170, suggested="x", hint="stripe", hintFrom="payer", shared=True)
    ask_paypal = dep("needs_you", "2026-11-20", 15000, hint="paypal", hintFrom="payer", shared=True)
    ask_move = dep("needs_you", "2026-11-21", 50000, kind="own_move", hint="paypal", hintFrom="payer", linkId=LINK_A)
    ask_meta = dep("needs_you", "2026-11-17", 12000, suggested="meta", hint="meta", hintFrom="payer")
    ask_unsure = dep("needs_you", "2026-11-16", 7000, suggested="tiktok", hint="tiktok", hintFrom="text", notSure=True)
    ask_old = dep(
        "needs_you",
        "2026-05-01",
        9900,
        suggested="youtube",
        hint="youtube",
        ttl=int(parse("2026-10-28T00:00:00Z").timestamp()),
    )  # type: ignore[union-attr]
    ask_back = dep("needs_you", "2026-10-02", 30000)
    ask_whop = dep("needs_you", "2026-11-15", 21000, suggested="contentrewards", hint="whop", hintFrom="payer")
    not_income = {
        "type": "deposit",
        "sk": "DEPOSIT#2026-11-11#" + "e" * 32,
        "depositId": "e" * 32,
        "state": "not_income",
        "date": "2026-11-11",
        "linkId": LINK_A,
        "why": "you",
        "ttl": 1,
    }
    links2 = [
        link(connected="2026-10-15T12:00:00.000Z"),
        link(LINK_B, "PayPal", connected="2026-11-10T12:00:00.000Z", total=90, historyFrom="2026-08-20"),
    ]
    many = [
        dep("needs_you", f"2026-11-{d:02d}", 1000 + d, suggested="youtube", hint="youtube", hintFrom="text")
        for d in range(1, 24)
    ]
    return [
        _case("no link: every place says it can't see the bank yet", {"conn": conn()}),
        _case(
            "checking: nothing matched yet, no number",
            {"conn": conn(), "links": [link(connected="2026-11-22T11:50:00.000Z", first_read=False)]},
        ),
        _case("none yet: read, nothing from an app", {"conn": conn(), "links": [link()]}),
        _case(
            "totals per place per currency, never across; meta on its own and in Instagram's and Facebook's lines",
            {
                "conn": conn(),
                "links": links2,
                "deposits": [yt, meta, x_usd, not_income, ask_google, ask_unsure],
            },
        ),
        _case(
            "Content Rewards on: its place, its note and the pair with Whop's payout",
            {"conn": conn(), "links": [link()], "deposits": [yt, cr, ask_whop]},
            cr_on=True,
        ),
        _case(
            "Content Rewards off: a Whop question has no suggestion",
            {"conn": conn(), "links": [link()], "deposits": [ask_whop]},
        ),
        _case(
            "questions: suggested, Stripe, PayPal, own move, meta, not sure last, past its ttl hidden, back after Not from",
            {
                "conn": conn(),
                "links": [link(), link(LINK_B, "PayPal")],
                "deposits": [ask_google, ask_stripe, ask_paypal, ask_move, ask_meta, ask_unsure, ask_old, ask_back],
            },
        ),
        _case("more than 20 questions", {"conn": conn(), "links": [link()], "deposits": many}),
        _case(
            "lastConnect within a day, a reconnect",
            {
                "conn": conn(
                    lastConnect={
                        "result": "bank_denied",
                        "linkId": LINK_A,
                        "bank": "Swedbank",
                        "reconnect": True,
                        "at": "2026-11-22T11:00:00.000Z",
                    }
                ),
                "links": [link()],
            },
        ),
        _case(
            "lastConnect more than a day old is gone",
            {
                "conn": conn(
                    lastConnect={
                        "result": "bank_connected",
                        "linkId": LINK_A,
                        "bank": "Swedbank",
                        "reconnect": False,
                        "at": "2026-11-21T11:00:00.000Z",
                    }
                ),
                "links": [link()],
            },
        ),
        _case(
            "Check now: 15 minutes, then 12 a day",
            {
                "conn": conn(lastManualAt="2026-11-22T11:55:00.000Z", manual={"day": "2026-11-22", "n": 12}),
                "links": [link()],
                "country": "SE",
            },
        ),
    ]


def build_steps() -> list[dict[str, Any]]:
    return [{"id": s.id, "role": s.role, "auto": s.auto} for s in STEPS]


def build_items() -> list[dict[str, Any]]:
    return [
        {
            "sk": "BANKOWNER",
            "pk": "BANKOWNER",
            "skPattern": "^BANKOWNER$",
            "writtenBy": ["cf-prod-api"],
            "attributes": ["type", "userId", "claimedAt"],
            "example": {"type": "bankowner", "userId": "u1", "claimedAt": T0},
        },
        {
            "sk": "BANKCONN",
            "skPattern": "^BANKCONN$",
            "writtenBy": ["cf-prod-api", "cf-prod-hooks", "cf-prod-money"],
            "attributes": [
                "type",
                "stepsDone",
                "app",
                "lastManualAt",
                "manual",
                "forgottenAt",
                "updatedAt",
                "lastConnect",
                "readLease",
                "lastNotice",
                "lastRunAt",
            ],
            "app": [
                "status",
                "source",
                "keyMadeAt",
                "savedAt",
                "appIdHint",
                "active",
                "environment",
                "check",
                "downAt",
            ],
            "readLease": {"until": "an ISO time (UTC, ms, Z); claimed when absent or past, released by its holder"},
            "byWriter": {
                "cf-prod-hooks": ["type", "lastConnect"],
                "cf-prod-money": ["readLease", "lastNotice", "lastRunAt", "app.check"],
            },
            "example": conn(
                ticks=DONE_TICKS,
                lastManualAt="2026-11-22T11:00:00.000Z",
                manual={"day": "2026-11-22", "n": 1},
                lastConnect={
                    "result": "bank_connected",
                    "linkId": LINK_A,
                    "bank": "Swedbank",
                    "reconnect": False,
                    "at": T0,
                },
            ),
        },
        {
            "sk": "BANKLINK#{linkId}",
            "skPattern": "^BANKLINK#[0-9a-f]{12}$",
            "writtenBy": ["cf-prod-hooks", "cf-prod-api", "cf-prod-money"],
            "attributes": [
                "type",
                "linkId",
                "bank",
                "country",
                "status",
                "reason",
                "consentUntil",
                "connectedAt",
                "firstConnectedAt",
                "accountCount",
                "psuHeaders",
                "historyWanted",
                "firstReadDone",
                "firstReadStartedAt",
                "historyFrom",
                "readThrough",
                "lastReadAt",
                "lastError",
                "failingSince",
                "limitUntil",
                "reads",
                "resume",
                "warnedFor",
                "endedAt",
                "stoppedAt",
                "closePending",
                "updatedAt",
            ],
            "statuses": ["connected", "ended", "stopped_at_bank", "stopped"],
            "reasons": ["consent_over", "ended_early", "psu_action"],
            "bare": ["type", "linkId", "bank", "status", "stoppedAt", "closePending"],
            "example": link(historyWanted=True),
        },
        {
            "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
            "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
            "state": "matched",
            "writtenBy": ["cf-prod-money", "cf-prod-api"],
            "attributes": [
                "type",
                "depositId",
                "state",
                "date",
                "amountMinor",
                "exponent",
                "currency",
                "place",
                "how",
                "payoutRef",
                "payoutDate",
                "payerKey",
                "hintFrom",
                "shared",
                "notPayout",
                "linkId",
                "source",
                "fetchedAt",
                "confirmedAt",
                "quiet",
            ],
            "places": list(view.PLACES),
            "hows": ["payout", "payer", "you"],
            "example": dep(
                "matched",
                "2026-10-28",
                123456,
                deposit_id="0123456789abcdef0123456789abcdef",
                place="youtube",
                how="payout",
                payoutRef="PAYOUT#youtube#2026-10-21#p1",
                payoutDate="2026-10-21",
            ),
        },
        {
            "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
            "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
            "state": "needs_you",
            "writtenBy": ["cf-prod-money", "cf-prod-api"],
            "attributes": [
                "type",
                "depositId",
                "state",
                "date",
                "amountMinor",
                "exponent",
                "currency",
                "payerKey",
                "notPayout",
                "linkId",
                "source",
                "fetchedAt",
                "quiet",
                "suggested",
                "kind",
                "hint",
                "hintFrom",
                "shared",
                "notSure",
                "ttl",
            ],
            "kinds": ["place", "own_move"],
            "hints": [
                "whop",
                "tiktok",
                "instagram",
                "facebook",
                "meta",
                "youtube",
                "x",
                "stripe",
                "payoneer",
                "paypal",
            ],
            "example": dep(
                "needs_you",
                "2026-11-18",
                8500,
                deposit_id="fedcba9876543210fedcba9876543210",
                suggested="youtube",
                hint="youtube",
                hintFrom="payer",
                payerKey="0123456789abcdef0123456789abcdef",
                shared=False,
            ),
        },
        {
            "sk": "DEPOSIT#{yyyy-mm-dd}#{depositId}",
            "skPattern": "^DEPOSIT#\\d{4}-\\d{2}-\\d{2}#[0-9a-f]{32}$",
            "state": "not_income",
            "writtenBy": ["cf-prod-api"],
            "attributes": ["type", "depositId", "state", "date", "linkId", "why", "ttl"],
            "whys": ["you", "own_move"],
            "example": {
                "type": "deposit",
                "depositId": "00112233445566778899aabbccddeeff",
                "state": "not_income",
                "date": "2026-11-11",
                "linkId": LINK_A,
                "why": "you",
                "ttl": 1828915200,
            },
        },
        {
            "sk": "BANKPAYERS",
            "skPattern": "^BANKPAYERS$",
            "writtenBy": ["cf-prod-api"],
            "attributes": ["type", "rules", "notIncome", "updatedAt"],
            "example": {
                "type": "bankpayers",
                "rules": {"0123456789abcdef0123456789abcdef": {"place": "meta", "learnedAt": T0}},
                "notIncome": ["fedcba9876543210fedcba9876543210"],
                "updatedAt": T0,
            },
        },
        {
            "secret": "cf-prod/platforms/bank/app",
            "writtenBy": ["cf-prod-api"],
            "readBy": ["cf-prod-api", "cf-prod-hooks", "cf-prod-money"],
            "attributes": [
                "privateKeyPem",
                "publicKeyPem",
                "certificatePem",
                "hashKey",
                "appId",
                "source",
                "keyMadeAt",
            ],
            "example": {
                "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n",
                "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
                "certificatePem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n",
                "hashKey": "base64 of 32 random bytes",
                "appId": APP_ID,
                "source": "clipfactory",
                "keyMadeAt": T0,
            },
        },
        {
            "secret": "cf-prod/platforms/bank/token_{linkId}",
            "writtenBy": ["cf-prod-hooks", "cf-prod-api"],
            "readBy": ["cf-prod-money", "cf-prod-api"],
            "attributes": ["sessionId", "accounts", "validUntil", "bank", "country", "connectedAt", "closeLater"],
            "accounts": ["uid", "idHash"],
            "example": {
                "sessionId": "sess-1",
                "accounts": [{"uid": "uid-1", "idHash": "idhash-1"}],
                "validUntil": "2027-04-30T08:50:00.000Z",
                "bank": "Swedbank",
                "country": "SE",
                "connectedAt": T0,
                "closeLater": [],
            },
        },
    ]


# --- writing ------------------------------------------------------------------------------------------------------


def _line(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def dump_cases(cases: list[dict[str, Any]]) -> str:
    """One line per part of a case, so a change reads as a small diff."""
    out = []
    for c in cases:
        parts = [f"  {_line(k)}: {_line(v)}" for k, v in c.items()]
        out.append(" {\n" + ",\n".join(parts) + "\n }")
    return "[\n" + ",\n".join(out) + "\n]"


def dump_groups(groups: dict[str, list[dict[str, Any]]]) -> str:
    body = ",\n".join(f"{_line(k)}: {dump_cases(v)}" for k, v in groups.items())
    return "{\n" + body + "\n}\n"


def write() -> None:
    VIEW_FILE.write_text(dump_groups(build_view()))
    STEPS_FILE.write_text(json.dumps(build_steps(), ensure_ascii=False, indent=1) + "\n")
    ITEMS_FILE.write_text(dump_cases(build_items()) + "\n")
    print(f"wrote {VIEW_FILE.name}, {STEPS_FILE.name}, {ITEMS_FILE.name}")


if __name__ == "__main__":
    write()
