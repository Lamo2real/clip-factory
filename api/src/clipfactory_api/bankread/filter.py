"""One bank transaction in memory → a candidate or nothing (docs/CONTRACTS.md §40.5.7; pure).

Only ``credit_debit_indicator``, ``status``, ``transaction_amount {amount, currency}``, ``booking_date`` (else
``value_date``, else ``transaction_date``), ``entry_reference``, ``debtor.name`` and ``remittance_information[]`` are
looked at; no other field is read. A transaction goes on only when it is a booked credit (``CRDT`` + ``BOOK``, checked
again here), its amount is a positive decimal that fits its currency's minor unit (read with ``Decimal``, never a
float), its currency is 3 capital letters and not a fund or metal code, and its booking date is a real day no later
than tomorrow.

Then, still in memory: ``text`` (the payer's name and the message, normalised), ``remit`` (the message alone), the
``hint`` (Clip Factory's own word for the platform named, from a fixed list), ``hintFrom`` (whether that word was in
the payer's name), ``shared`` (Stripe, PayPal or Payoneer: money that can come from more than one place), ``payerKey``
(a keyed hash of the payer's name, letters only) and ``depositId`` (a keyed hash of the entry reference or the row,
never of the account). Everything else is gone once the page is done.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

# Whole strings only (``fullmatch``: no trailing newline) and ASCII digits only (``\d`` takes any script's digits).
AMOUNT = re.compile(r"[0-9]{1,15}(?:\.[0-9]{1,6})?")
CURRENCY = re.compile(r"[A-Z]{3}")
DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# Fund and metal codes: never money he can spend.
NOT_MONEY = frozenset({"XAU", "XAG", "XPT", "XPD", "XDR", "XTS", "XXX", "XBA", "XBB", "XBC", "XBD", "XSU", "XUA"})
EXPONENT_0 = frozenset(
    {"BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"}
)
EXPONENT_3 = frozenset({"BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"})

# The hints, in this order (specific first): Clip Factory's own word → the whole words that name it.
HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("whop", ("WHOP", "CONTENT REWARDS")),
    ("tiktok", ("TIKTOK", "BYTEDANCE")),
    ("instagram", ("INSTAGRAM",)),
    ("facebook", ("FACEBOOK",)),
    ("meta", ("META",)),
    ("youtube", ("GOOGLE", "ADSENSE", "YOUTUBE")),
    ("x", ("X CORP", "TWITTER", "X COM")),
    ("stripe", ("STRIPE",)),
    ("payoneer", ("PAYONEER",)),
    ("paypal", ("PAYPAL",)),
)
SHARED_WORDS = ("STRIPE", "PAYPAL", "PAYONEER")


def exponent(currency: str) -> int:
    if currency in EXPONENT_0:
        return 0
    if currency in EXPONENT_3:
        return 3
    return 2


def norm(value: Any) -> str:
    """NFKD, accents dropped, capitals, every character that isn't A-Z or 0-9 a space, spaces collapsed."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if not unicodedata.combining(c)).upper()
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return " ".join(text.split())


def letters(value: str) -> str:
    """The letters of a normalised text (digits and spaces dropped)."""
    return re.sub(r"[^A-Z]", "", value)


def has_word(text: str, word: str) -> bool:
    """``word`` (one or more whole words) inside ``text``, both normalised."""
    return f" {word} " in f" {text} "


def keyed(hash_key: bytes, value: str) -> str:
    """The first 32 hex of HMAC-SHA256(hashKey, value)."""
    return hmac.new(hash_key, value.encode(), hashlib.sha256).hexdigest()[:32]


def to_minor(amount: str, exp: int) -> int | None:
    """The amount in minor units, only when it fits the currency's minor unit (``"1234.567"`` SEK doesn't)."""
    try:
        value = Decimal(amount)
    except InvalidOperation:
        return None
    if not value.is_finite():
        return None
    scaled = value.scaleb(exp)
    if scaled != scaled.to_integral_value():
        return None
    return int(scaled)


def micros(amount_minor: int, exp: int) -> int:
    """``amountMinor * 10^(6 - exponent)``: a change of unit, never a conversion."""
    return int(amount_minor) * int(10 ** (6 - int(exp)))


def booking_day(row: Mapping[str, Any], today: date) -> str | None:
    """``booking_date``, else ``value_date``, else ``transaction_date``: a real day no later than tomorrow."""
    for name in ("booking_date", "value_date", "transaction_date"):
        raw = row.get(name)
        if raw is None or raw == "":
            continue
        if not isinstance(raw, str) or not DAY.fullmatch(raw):
            return None
        try:
            day = date.fromisoformat(raw)
        except ValueError:
            return None
        return raw if day <= today + timedelta(days=1) else None
    return None


def any_day(row: Any) -> str | None:
    """The booking date of any row (debits too), for ``historyFrom`` only: the oldest day the bank returned."""
    if not isinstance(row, Mapping):
        return None
    for name in ("booking_date", "value_date", "transaction_date"):
        raw = row.get(name)
        if isinstance(raw, str) and DAY.fullmatch(raw):
            try:
                date.fromisoformat(raw)
            except ValueError:
                return None
            return raw
    return None


@dataclass(frozen=True)
class Candidate:
    """A booked credit that may be app money. In memory only; ``remit`` is never stored."""

    deposit_id: str
    date: str
    amount_minor: int
    exponent: int
    currency: str
    hint: str | None
    hint_from: str | None
    shared: bool
    payer_key: str | None
    remit: str
    link_id: str

    @property
    def micros(self) -> int:
        return micros(self.amount_minor, self.exponent)


def find_hint(text: str, payer: str) -> tuple[str | None, str | None]:
    """``(hint, hintFrom)``: the first hint in the list's order whose word is in ``text``; ``"payer"`` when that hint's
    word is in the payer's name, else ``"text"``."""
    for hint, words in HINTS:
        if any(has_word(text, w) for w in words):
            return hint, "payer" if any(has_word(payer, w) for w in words) else "text"
    return None, None


def _remittance(row: Mapping[str, Any]) -> str:
    raw = row.get("remittance_information")
    lines: Iterable[Any] = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
    return norm(" ".join(str(line) for line in lines if isinstance(line, str)))


def _payer(row: Mapping[str, Any]) -> str:
    debtor = row.get("debtor")
    name = debtor.get("name") if isinstance(debtor, Mapping) else None
    return norm(name) if isinstance(name, str) else ""


class Filter:
    """One account's read: keeps the count ``n`` among identical rows without an entry reference (same day, amount,
    currency and letters), in the bank's order, across that account's pages.

    The count lives in memory only (storing it would keep a trace of rows that aren't app money). So when a read stops
    for time between two pages and goes on in a later run (``resume``), the count starts again at 1 there: a second
    identical row without a reference on that very booking day, on the far side of the stop, gets the first one's
    ``depositId`` and counts as kept already. That takes two credits alike to the öre, same payer and same message, on
    one day, split exactly by a stop; accepted, and the 10-day overlap reads that day whole again when it is recent."""

    def __init__(self, hash_key: bytes, link_id: str, today: date) -> None:
        self._key = hash_key
        self._link = link_id
        self._today = today
        self._seen: dict[tuple[str, int, str, str], int] = {}

    def add(self, row: Any) -> Candidate | None:
        if not isinstance(row, Mapping):
            return None
        if row.get("credit_debit_indicator") != "CRDT" or row.get("status") != "BOOK":
            return None
        money = row.get("transaction_amount")
        if not isinstance(money, Mapping):
            return None
        amount, currency = money.get("amount"), money.get("currency")
        if not isinstance(amount, str) or not AMOUNT.fullmatch(amount):
            return None  # a float, a negative "credit", a number with too many decimals
        if not isinstance(currency, str) or not CURRENCY.fullmatch(currency) or currency in NOT_MONEY:
            return None
        exp = exponent(currency)
        minor = to_minor(amount, exp)
        if minor is None or minor <= 0:
            return None
        day = booking_day(row, self._today)
        if day is None:
            return None
        payer = _payer(row)
        remit = _remittance(row)
        text = " ".join(p for p in (payer, remit) if p)
        hint, hint_from = find_hint(text, payer)
        shared = any(has_word(text, w) for w in SHARED_WORDS)
        payer_letters = letters(payer)
        payer_key = keyed(self._key, "payer|" + payer_letters) if len(payer_letters) >= 3 else None
        ref = row.get("entry_reference")
        if isinstance(ref, str) and ref.strip():
            source = f"dep|{ref}|{day}|{minor}|{currency}"
        else:
            same = (day, minor, currency, letters(text))
            self._seen[same] = n = self._seen.get(same, 0) + 1
            source = f"dep|{day}|{minor}|{currency}|{same[3]}|{n}"
        return Candidate(
            deposit_id=keyed(self._key, source),
            date=day,
            amount_minor=minor,
            exponent=exp,
            currency=currency,
            hint=hint,
            hint_from=hint_from,
            shared=shared,
            payer_key=payer_key,
            remit=remit,
            link_id=self._link,
        )
