"""Your bank's reading side, shared by its tests (docs/CONTRACTS.md §40.5.6-§40.5.8, §40.5.13).

* ``FakeEnableBanking``: an ``HttpClient`` that answers like ``https://api.enablebanking.com`` (sessions, paged
  booked transactions, typed errors) and records every request. Nothing reaches a network or a bank.
* ``txn``: one transaction as Enable Banking sends it, with the fields Clip Factory must never keep (IBANs, names,
  addresses, other people's payments) filled in, so the leak tests can look for them everywhere.
* The golden matching cases, ``fixtures/bank_match_cases.json``: each case's bank rows go through the filter
  (``bankread.filter``) with a fixed ``hashKey`` and then through ``bankread.match`` with its stored context; the
  expected decisions are written by the code and read by hand in review (the key ones also have their own
  hand-written asserts in ``test_bankread_match.py``).

Run ``uv run python tests/bankread_cases.py`` (from ``api/``) to write the file again after a deliberate change.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from datetime import date
from functools import cache
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

from clipfactory_api.bankread import filter as bank_filter
from clipfactory_api.bankread import match as bank_match
from clipfactory_api.platforms.base import HttpRequest, HttpResponse, NetworkError

FIXTURES = Path(__file__).parent / "fixtures"
MATCH_FILE = FIXTURES / "bank_match_cases.json"

HASH_KEY = bytes(range(32))
HASH_KEY_B64 = base64.b64encode(HASH_KEY).decode()
APP_ID = "6c1f0a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
TODAY = date(2026, 11, 23)

# What a bank sends that Clip Factory must never keep: none of these may appear in an item, a secret write or a log.
SECRET_WORDS = (
    "SE4550000000058398257466",
    "Anna Andersson",
    "Storgatan 1",
    "SWEDSESS",
    "Lön november",
    "Hyra december",
    "Erik Eriksson",
    "uid-acc-1",
    "uid-acc-2",
    "idhash-1",
    "sess-123",
    "8123-4",
)


@cache
def private_key_pem() -> str:
    """A throwaway RSA key for the tests (2048 bits: quick to make; the API makes 4096)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


def app_secret_value() -> dict[str, Any]:
    return {
        "privateKeyPem": private_key_pem(),
        "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
        "certificatePem": "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
        "hashKey": HASH_KEY_B64,
        "appId": APP_ID,
        "source": "clipfactory",
        "keyMadeAt": "2026-11-22T10:00:00.000Z",
    }


def txn(
    amount: Any,
    day: str,
    *,
    currency: str = "SEK",
    payer: str | None = None,
    text: list[str] | str | None = None,
    ref: str | None = None,
    cdi: str = "CRDT",
    status: str = "BOOK",
    label: str | None = None,
    account: str | None = None,
) -> dict[str, Any]:
    """One booked transaction in Enable Banking's shape, with every field Clip Factory must not read filled in."""
    row: dict[str, Any] = {
        "entry_reference": ref,
        "transaction_amount": {"currency": currency, "amount": amount},
        "creditor": {"name": "Anna Andersson", "postal_address": {"street_name": "Storgatan 1"}},
        "creditor_account": {"iban": "SE4550000000058398257466"},
        "creditor_agent": {"bic_fi": "SWEDSESS"},
        "debtor": {"name": payer} if payer is not None else None,
        "debtor_account": {"iban": "SE4550000000058398257466", "other": {"identification": "8123-4"}},
        "credit_debit_indicator": cdi,
        "status": status,
        "booking_date": day,
        "value_date": day,
        "transaction_date": day,
        "balance_after_transaction": {"currency": currency, "amount": "98765.43"},
        "reference_number": "8123-4",
        "remittance_information": text if isinstance(text, list) else [text] if text else [],
        "note": "Anna Andersson",
    }
    if label is not None:
        row["_label"] = label  # the tests' own name for a row; the filter never reads it
    if account is not None:
        row["_account"] = account  # the golden cases' account (each account has its own filter)
    return row


def salary(day: str) -> dict[str, Any]:
    return txn("32100.00", day, payer="Erik Eriksson AB", text="Lön november", label="salary")


def debit(day: str) -> dict[str, Any]:
    return txn("12000.00", day, payer="Anna Andersson", text="Hyra december", cdi="DBIT", label="rent")


# --- the fake Enable Banking ------------------------------------------------------------------------------------


class FakeEnableBanking:
    """``https://api.enablebanking.com`` for the reading side: ``GET /sessions/{id}`` and ``GET
    /accounts/{uid}/transactions`` with continuation keys. ``fail[target]`` holds answers to give first, in order:
    ``(status, error_code)``, ``(status, error_code, headers)`` or an exception; ``target`` is ``"session"`` or a uid.
    ``status[session]`` is the session's status; ``pages[uid]`` the account's pages (each a list of transactions)."""

    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}
        self.pages: dict[str, list[list[dict[str, Any]]]] = {}
        self.fail: dict[str, list[Any]] = {}
        self.calls: list[HttpRequest] = []
        self.hook: Any = None  # called with the uid before each transactions answer (a Stop or Forget mid-read)

    def session(self, session_id: str, accounts: list[str], status: str = "AUTHORIZED") -> None:
        self.sessions[session_id] = {
            "status": status,
            "accounts": accounts,
            "accounts_data": [{"uid": u, "identification_hash": f"idhash-{n}"} for n, u in enumerate(accounts, 1)],
            "aspsp": {"name": "Swedbank", "country": "SE"},
            "psu_type": "personal",
            "access": {"valid_until": "2027-05-20T10:00:00.000000+00:00"},
        }

    @property
    def transaction_calls(self) -> list[dict[str, str]]:
        out = []
        for call in self.calls:
            parts = urlsplit(call.url)
            if parts.path.endswith("/transactions"):
                out.append({"uid": unquote(parts.path.split("/")[2]), **dict(parse_qsl(parts.query))})
        return out

    def _error(self, answer: Any) -> HttpResponse:
        if isinstance(answer, BaseException):
            raise answer
        status, code, *rest = answer
        body = {"code": status, "message": "Anna Andersson SE4550000000058398257466", "error": code, "detail": {}}
        return HttpResponse(
            status, {k.lower(): v for k, v in (rest[0] if rest else {}).items()}, json.dumps(body).encode()
        )

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.calls.append(request)
        assert request.url.startswith("https://api.enablebanking.com/"), request.url
        assert request.method == "GET"
        assert request.headers.get("Authorization", "").startswith("Bearer ")
        assert request.headers.get("Accept") == "application/json"
        parts = urlsplit(request.url)
        segments = [unquote(s) for s in parts.path.split("/") if s]
        if segments[0] == "sessions":
            if self.fail.get("session"):
                return self._error(self.fail["session"].pop(0))
            found = self.sessions.get(segments[1])
            if found is None:
                return self._error((404, "SESSION_DOES_NOT_EXIST"))
            return HttpResponse(200, {}, json.dumps(found).encode())
        assert segments[0] == "accounts", request.url
        assert segments[2] == "transactions", request.url
        uid = segments[1]
        if self.hook is not None:
            self.hook(uid)
        if self.fail.get(uid):
            return self._error(self.fail[uid].pop(0))
        query = dict(parse_qsl(parts.query))
        assert query.get("transaction_status") == "BOOK"
        pages = self.pages.get(uid, [[]])
        index = int(query["continuation_key"][1:]) if query.get("continuation_key") else 0
        if index >= len(pages):
            return self._error((422, "WRONG_CONTINUATION_KEY"))
        key = f"k{index + 1}" if index + 1 < len(pages) else None
        body = {"transactions": pages[index], "continuation_key": key}
        return HttpResponse(200, {}, json.dumps(body).encode())


def network_down() -> NetworkError:
    return NetworkError("URLError")


# --- one owner's bank, stored the way the API and the callback store it (§40.5.11) ---------------------------------

USER = "11111111-2222-3333-4444-555555555555"
PK = f"USER#{USER}"
PREFIX = "cf-prod/platforms/"
APP_URL = "https://app.example.test"


class Ticker:
    """``remaining``: seconds left of the time budget (tests lower it to stop a read mid-way)."""

    def __init__(self, left: float = 200.0) -> None:
        self.left = left
        self.after_pages: int | None = None  # drop below 20 s once this many transaction pages were read
        self.fake: FakeEnableBanking | None = None

    def __call__(self) -> float:
        if (
            self.after_pages is not None
            and self.fake is not None
            and len(self.fake.transaction_calls) >= self.after_pages
        ):
            return 5.0
        return self.left


def seed_conn(store: Any, **extra: Any) -> None:
    store.put(
        {
            "pk": PK,
            "sk": "BANKCONN",
            "type": "bankconn",
            "stepsDone": ["bank-account", "bank-app", "bank-details"],
            "app": {
                "status": "saved",
                "source": "clipfactory",
                "check": {"code": "ok", "at": "2026-11-22T10:00:00.000Z"},
            },
            **extra,
        }
    )


def seed_link(
    store: Any,
    sm: Any,
    fake: FakeEnableBanking,
    link_id: str = "a1b2c3d4e5f6",
    *,
    bank: str = "Swedbank",
    connected_at: str = "2026-11-22T10:00:00.000Z",
    consent_until: str = "2027-05-20T10:00:00.000000+00:00",
    accounts: tuple[str, ...] = ("uid-acc-1",),
    session_id: str = "sess-123",
    psu_headers: tuple[str, ...] = (),
    secret_connected_at: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """A connected ``BANKLINK#`` with its session secret and Enable Banking's session, as the callback leaves them."""
    item = {
        "pk": PK,
        "sk": f"BANKLINK#{link_id}",
        "type": "banklink",
        "linkId": link_id,
        "bank": bank,
        "country": "SE",
        "status": "connected",
        "consentUntil": consent_until,
        "connectedAt": connected_at,
        "firstConnectedAt": connected_at,
        "accountCount": len(accounts),
        "psuHeaders": list(psu_headers),
        "historyWanted": True,
        "firstReadDone": False,
        "updatedAt": connected_at,
        **extra,
    }
    store.put(item)
    sm.values[f"{PREFIX}bank/token_{link_id}"] = json.dumps(
        {
            "sessionId": session_id,
            "accounts": [{"uid": u, "idHash": f"idhash-{n}"} for n, u in enumerate(accounts, 1)],
            "validUntil": consent_until,
            "bank": bank,
            "country": "SE",
            "connectedAt": secret_connected_at or connected_at,
            "closeLater": [],
        }
    )
    fake.session(session_id, list(accounts))
    return item


def seed_app(sm: Any) -> None:
    sm.values[f"{PREFIX}bank/app"] = json.dumps(app_secret_value())


# --- the golden matching cases ----------------------------------------------------------------------------------

YT = "PAYOUT#youtube#2026-10-21#3456"
YT2 = "PAYOUT#youtube#2026-11-02#3456"
CR = "PAYOUT#contentrewards#2026-10-20#po_1"
CR2 = "PAYOUT#contentrewards#2026-11-05#po_2"


def youtube_payout(ref: str, day: str, text: str) -> dict[str, Any]:
    return {"sk": ref, "place": "youtube", "date": day, "amountText": text, "state": "sent"}


def whop_payout(ref: str, day: str, micros: int, currency: str, trace: str | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {
        "sk": ref,
        "place": "contentrewards",
        "date": day,
        "amountMicros": micros,
        "currency": currency,
        "state": "sent",
    }
    if trace is not None:
        row["traceCode"] = trace
    return row


def payer_key(name: str) -> str:
    return bank_filter.keyed(HASH_KEY, "payer|" + bank_filter.letters(bank_filter.norm(name)))


CASES: list[dict[str, Any]] = [
    {
        "name": "youtube_payout_within_10_workdays",
        "about": "Google's SEK payout of 21 Oct and the same amount booked 4 Nov (10 workdays later): matched.",
        "transactions": [txn("1234.56", "2026-11-04", payer="GOOGLE IRELAND LTD", text="ADSENSE", label="google")],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
    },
    {
        "name": "youtube_payout_on_workday_11_is_asked",
        "about": "The same amount on 5 Nov, 11 workdays later: no payout match, so it is asked about as YouTube.",
        "transactions": [txn("1234.56", "2026-11-05", payer="GOOGLE IRELAND LTD", text="ADSENSE", label="google")],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
    },
    {
        "name": "google_test_deposit_dropped",
        "about": "Google's tiny test payment (SEK 4.12): dropped, never stored, never asked.",
        "transactions": [txn("4.12", "2026-11-03", payer="GOOGLE", text="ADSENSE VERIFY", label="test")],
    },
    {
        "name": "google_85_without_a_record_is_asked",
        "about": "Google SEK 85.00 with no payout record: over the test ceiling, so asked about as YouTube.",
        "transactions": [txn("85.00", "2026-11-03", payer="Google Payment Ireland", label="google85")],
    },
    {
        "name": "whop_converted_by_the_bank_is_asked",
        "about": "Whop sent USD 40.00; the bank booked SEK 412.30 with WHOP: never converted, so asked (Content Rewards).",
        "transactions": [txn("412.30", "2026-10-22", payer="WHOP INC", label="whop")],
        "payouts": [whop_payout(CR, "2026-10-20", 40_000_000, "USD")],
        "contentRewards": True,
    },
    {
        "name": "whop_converted_with_content_rewards_off_suggests_nothing",
        "about": "The same with Content Rewards off: asked, with no suggestion.",
        "transactions": [txn("412.30", "2026-10-22", payer="WHOP INC", label="whop")],
        "payouts": [whop_payout(CR, "2026-10-20", 40_000_000, "USD")],
        "contentRewards": False,
    },
    {
        "name": "whop_trace_code_matched_at_any_amount",
        "about": "Whop's trace code (10+ letters and digits) as whole words in the message: matched at any amount.",
        "transactions": [
            txn("411.95", "2026-10-27", payer="Bankgirot", text=["Insattning", "TRC 4F7Q-92KX-11ZP"], label="trace")
        ],
        "payouts": [whop_payout(CR, "2026-10-20", 40_000_000, "USD", trace="4F7Q-92KX-11ZP")],
        "contentRewards": True,
    },
    {
        "name": "short_code_inside_a_longer_number_not_matched",
        "about": "A 6-character code is too short, and a code inside a longer payment number is not a whole word.",
        "transactions": [
            txn("411.95", "2026-10-27", payer="Bankgirot", text="BETALNING 9AB12CD99", label="short"),
            txn("200.00", "2026-10-28", payer="Bankgirot", text="REF 12345678901234", label="inside"),
        ],
        "payouts": [
            whop_payout(CR, "2026-10-20", 40_000_000, "USD", trace="AB12CD"),
            whop_payout(CR2, "2026-10-21", 20_000_000, "USD", trace="1234567890"),
        ],
        "contentRewards": True,
    },
    {
        "name": "learned_meta_payer_matched",
        "about": "A payer he confirmed as Meta (payerKey in BANKPAYERS.rules): matched, how payer.",
        "transactions": [txn("912.40", "2026-11-10", payer="META PLATFORMS IRELAND", label="meta")],
        "rules": {"META PLATFORMS IRELAND": "meta"},
    },
    {
        "name": "stripe_asked_every_time_suggesting_x",
        "about": "STRIPE is shared: asked every time (even with a rule for that payer), suggesting X.",
        "transactions": [txn("321.70", "2026-11-11", payer="STRIPE PAYMENTS", label="stripe")],
        "rules": {"STRIPE PAYMENTS": "x"},
    },
    {
        "name": "youtube_only_in_a_strangers_message",
        "about": "YOUTUBE only in a stranger's message: hintFrom text, asked every time, never matched by a rule.",
        "transactions": [txn("500.00", "2026-11-12", payer="Erik Eriksson", text="youtube money", label="stranger")],
        "rules": {"Erik Eriksson": "youtube"},
    },
    {
        "name": "paypal_with_a_paypal_link_is_an_own_move",
        "about": "PAYPAL in the bank while a PayPal link is connected: did he move it from his own PayPal?",
        "transactions": [txn("1000.00", "2026-11-13", payer="PAYPAL EUROPE", label="paypal")],
        "paypalLinks": ["paypal1"],
    },
    {
        "name": "paypal_without_a_paypal_link_is_asked",
        "about": "PAYPAL with no PayPal link: asked where it is from, no suggestion.",
        "transactions": [txn("1000.00", "2026-11-13", payer="PAYPAL EUROPE", label="paypal")],
    },
    {
        "name": "debit_pending_negative_and_salary_dropped",
        "about": "A debit, a pending credit, a negative credit, a day after tomorrow and his salary: all dropped.",
        "transactions": [
            debit("2026-11-01"),
            txn("700.00", "2026-11-02", payer="GOOGLE", status="PDNG", label="pending"),
            txn("-700.00", "2026-11-02", payer="GOOGLE", label="negative"),
            txn("700.00", "2026-11-25", payer="GOOGLE", label="after_tomorrow"),
            salary("2026-11-20"),
        ],
    },
    {
        "name": "one_payout_two_candidates_the_hint_wins",
        "about": "A stranger's earlier transfer of the same amount loses to the deposit whose hint fits the payout.",
        "transactions": [
            txn("1234.56", "2026-10-22", payer="Erik Eriksson", label="stranger"),
            txn("1234.56", "2026-10-24", payer="GOOGLE IRELAND LTD", label="google"),
        ],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
    },
    {
        "name": "one_payout_two_candidates_then_the_first_by_date",
        "about": "With no hint on either, the earlier booking wins; the other is dropped (no hint).",
        "transactions": [
            txn("1234.56", "2026-10-24", payer="Bankgirot", label="later"),
            txn("1234.56", "2026-10-22", payer="Bankgirot", label="earlier"),
        ],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
    },
    {
        "name": "not_payout_respected",
        "about": "A stored question he said isn't from that payout (notPayout) is not paired with it again.",
        "stored": [{"label": "undone", "notPayout": [YT], **{"hint": "youtube", "hintFrom": "payer"}}],
        "storedRows": [txn("1234.56", "2026-10-24", payer="GOOGLE IRELAND LTD", label="undone")],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
    },
    {
        "name": "not_income_payer_dropped",
        "about": "A payer he called not app money: dropped.",
        "transactions": [txn("150.00", "2026-11-14", payer="GOOGLE CLOUD EMEA", label="refund")],
        "notIncome": ["GOOGLE CLOUD EMEA"],
    },
    {
        "name": "not_income_google_payer_with_a_matching_payout_matched",
        "about": "The payout rules come first: a notIncome Google payer with a matching AdSense payout is matched.",
        "transactions": [txn("1234.56", "2026-10-23", payer="GOOGLE IRELAND LTD", label="google")],
        "payouts": [youtube_payout(YT, "2026-10-21", "SEK 1,234.56")],
        "notIncome": ["GOOGLE IRELAND LTD"],
    },
    {
        "name": "fund_code_and_too_many_decimals_dropped",
        "about": "XXX (PayPal's account currency) and SEK 1234.567 never go on.",
        "transactions": [
            txn("50.00", "2026-11-15", currency="XXX", payer="GOOGLE", label="xxx"),
            txn("1234.567", "2026-11-15", payer="GOOGLE", label="decimals"),
        ],
    },
    {
        "name": "stored_question_matched_once_its_payout_appears",
        "about": "A stored needs_you row from an earlier read matches when Google's payout record appears (rule 9).",
        "stored": [{"label": "earlier", "hint": "youtube", "hintFrom": "payer"}],
        "storedRows": [txn("1234.56", "2026-11-03", payer="GOOGLE IRELAND LTD", label="earlier")],
        "payouts": [youtube_payout(YT2, "2026-11-02", "SEK 1,234.56")],
    },
    {
        "name": "stored_question_matched_by_a_payer_he_confirmed",
        "about": "A stored needs_you row whose payer he confirmed meanwhile matches (rule 9, rule 6).",
        "stored": [{"label": "meta", "hint": "meta", "hintFrom": "payer"}],
        "storedRows": [txn("912.40", "2026-11-03", payer="META PLATFORMS IRELAND", label="meta")],
        "rules": {"META PLATFORMS IRELAND": "meta"},
    },
    {
        "name": "kept_already_is_nothing",
        "about": "A row already stored (the 10-day overlap of two reads) is nothing new.",
        "transactions": [txn("1234.56", "2026-11-04", payer="GOOGLE IRELAND LTD", label="google")],
        "keptLabels": ["google"],
    },
    {
        "name": "the_same_row_in_two_accounts_counts_once",
        "about": "Two accounts with the identical row on the same day make one id: that money counts once.",
        "transactions": [
            txn("500.00", "2026-11-12", payer="TIKTOK PTE LTD", label="a1", account="acc1"),
            txn("500.00", "2026-11-12", payer="TIKTOK PTE LTD", label="a2", account="acc2"),
        ],
    },
]


def _candidate(row: Mapping[str, Any], link_id: str = "link1") -> tuple[str, bank_filter.Candidate | None]:
    found = bank_filter.Filter(HASH_KEY, link_id, TODAY).add(row)
    return str(row.get("_label") or ""), found


def run_case(case: Mapping[str, Any]) -> dict[str, Any]:
    """The decisions for a case, by the rows' labels (``depositId``s are keyed hashes: the labels read better)."""
    labels: dict[str, str] = {}
    candidates: list[bank_filter.Candidate] = []
    filters: dict[str, bank_filter.Filter] = {}
    filtered_out: list[str] = []
    for row in case.get("transactions", []):
        label = str(row.get("_label") or "")
        account = str(row.get("_account") or "acc1")
        found = filters.setdefault(account, bank_filter.Filter(HASH_KEY, "link1", TODAY)).add(row)
        if found is None:
            filtered_out.append(label)
            continue
        labels.setdefault(found.deposit_id, label)
        candidates.append(found)
    stored: list[bank_match.Stored] = []
    meta = {str(s["label"]): s for s in case.get("stored", [])}
    for row in case.get("storedRows", []):
        label, found = _candidate(row)
        assert found is not None, label
        extra = meta[label]
        labels[found.deposit_id] = label
        stored.append(
            bank_match.Stored(
                deposit_id=found.deposit_id,
                sk=f"DEPOSIT#{found.date}#{found.deposit_id}",
                date=found.date,
                amount_minor=found.amount_minor,
                exponent=found.exponent,
                currency=found.currency,
                hint=extra.get("hint"),
                hint_from=extra.get("hintFrom"),
                shared=bool(extra.get("shared")),
                payer_key=found.payer_key,
                not_payout=frozenset(extra.get("notPayout") or []),
            )
        )
    payouts = []
    for p in case.get("payouts", []):
        if p["place"] == "youtube":
            from clipfactory_api.getpaid.sent import parse_amount

            amount, currency = parse_amount(p["amountText"])
            trace = None
        else:
            amount, currency, trace = p["amountMicros"], p["currency"], bank_match.trace_code(p.get("traceCode"))
        payouts.append(bank_match.Payout(p["sk"], p["place"], p["date"], amount, currency, trace))
    kept = {c.deposit_id for c in candidates if labels[c.deposit_id] in set(case.get("keptLabels", []))}
    kept |= {s.deposit_id for s in stored}
    ctx = bank_match.Context(
        payouts=payouts,
        kept=kept,
        rules={payer_key(name): place for name, place in (case.get("rules") or {}).items()},
        not_income={payer_key(name) for name in case.get("notIncome", [])},
        paypal_links=set(case.get("paypalLinks", [])),
        content_rewards=bool(case.get("contentRewards", True)),
        stored=stored,
    )
    decisions, rematches = bank_match.match(candidates, ctx)
    return {
        "filteredOut": filtered_out,
        "decisions": [
            {
                "label": labels[d.deposit_id],
                "state": d.state,
                "rule": d.rule,
                **{
                    k: v
                    for k, v in (
                        ("place", d.place),
                        ("how", d.how),
                        ("payoutRef", d.payout_ref),
                        ("payoutDate", d.payout_date),
                        ("suggested", d.suggested),
                        ("kind", d.kind),
                    )
                    if v is not None
                },
            }
            for d in decisions
        ],
        "rematches": [
            {
                "label": labels[r.deposit_id],
                "place": r.place,
                "how": r.how,
                **({"payoutRef": r.payout_ref, "payoutDate": r.payout_date} if r.payout_ref else {}),
            }
            for r in rematches
        ],
    }


def build_cases() -> list[dict[str, Any]]:
    return [{**case, "expected": run_case(case)} for case in CASES]


def dump(cases: list[dict[str, Any]]) -> str:
    return json.dumps(cases, indent=1, ensure_ascii=False, sort_keys=False)


if __name__ == "__main__":
    MATCH_FILE.write_text(dump(build_cases()) + "\n")
    print(f"wrote {MATCH_FILE.name}")


class World:
    """One owner's bank in a fake table, fake Secrets Manager and fake Enable Banking, with the reader's deps."""

    def __init__(self, now: Any) -> None:
        from clipfactory_api import db
        from clipfactory_api.bankread import BankReadDeps
        from clipfactory_api.oauth.secrets import Secrets
        from fakes import FakeSecretsManager, FakeTable

        self.now = now
        self.table = FakeTable()
        self.store = db.Store(self.table)
        self.sm = FakeSecretsManager()
        self.secrets = Secrets(self.sm, PREFIX)
        self.eb = FakeEnableBanking()
        self.ticker = Ticker()
        self.ticker.fake = self.eb
        self.deps = BankReadDeps(
            store=self.store,
            secrets=self.secrets,
            http=self.eb,
            clock=lambda: self.now,
            remaining=self.ticker,
            app_url=APP_URL,
            content_rewards=True,
        )

    def ready(self, **link: Any) -> dict[str, Any]:
        """The app, the setup item and one connected link."""
        seed_app(self.sm)
        seed_conn(self.store)
        return seed_link(self.store, self.sm, self.eb, **link)

    def run(self, **kwargs: Any) -> dict[str, Any]:
        from clipfactory_api.bankread import collect

        return collect.run(self.deps, USER, self.now, **kwargs)

    def link(self, link_id: str = "a1b2c3d4e5f6") -> dict[str, Any]:
        return self.store.get(PK, f"BANKLINK#{link_id}") or {}

    def conn(self) -> dict[str, Any]:
        return self.store.get(PK, "BANKCONN") or {}

    def deposits(self) -> list[dict[str, Any]]:
        return self.store.query_all(PK, "DEPOSIT#")

    def put_payout(self, row: dict[str, Any]) -> None:
        self.store.put({"pk": PK, "type": "payout", "by": "money", **row})
