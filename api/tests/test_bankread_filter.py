"""Your bank: one transaction in memory → a candidate or nothing (docs/CONTRACTS.md §40.5.7, §40.5.13 "filter").

Only booked credits with a real amount, money code and day go on; the payer's name and the message are read only to
make the hint, ``hintFrom``, ``shared`` and the keyed ``payerKey``; ``depositId`` is a keyed hash that never holds the
account, so a reconnect and the 10-day overlap of two reads give the same ids.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest

from bankread_cases import HASH_KEY, TODAY, txn
from clipfactory_api.bankread import filter as f


def one(row: dict[str, Any], link: str = "link1", today: date = TODAY) -> f.Candidate | None:
    return f.Filter(HASH_KEY, link, today).add(row)


def test_only_booked_credits_go_on_and_both_are_checked_again() -> None:
    assert one(txn("100.00", "2026-11-01", payer="GOOGLE")) is not None
    assert one(txn("100.00", "2026-11-01", payer="GOOGLE", cdi="DBIT")) is None
    assert one(txn("100.00", "2026-11-01", payer="GOOGLE", status="PDNG")) is None
    assert one(txn("100.00", "2026-11-01", payer="GOOGLE", status="INFO")) is None
    assert one({"credit_debit_indicator": "CRDT", "status": "BOOK"}) is None
    assert one("not a row") is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "amount",
    ["-700.00", "0", "0.00", "1e3", " 12.00", "12,00", "1234567890123456", "12.1234567", 12.5, 12, None, "NaN"],
)
def test_bad_amounts_are_refused(amount: Any) -> None:
    assert one(txn(amount, "2026-11-01", payer="GOOGLE")) is None


@pytest.mark.parametrize("currency", ["sek", "SEKK", "SE", "XXX", "XAU", "XDR", "XBA", "XUA", "", None, 752])
def test_bad_money_codes_are_refused(currency: Any) -> None:
    row = txn("100.00", "2026-11-01", payer="GOOGLE")
    row["transaction_amount"]["currency"] = currency
    assert one(row) is None


@pytest.mark.parametrize(
    ("amount", "currency", "minor", "exp"),
    [
        ("1234.56", "SEK", 123456, 2),
        ("1234.5", "SEK", 123450, 2),
        ("1234.560", "SEK", 123456, 2),
        ("1234", "SEK", 123400, 2),
        ("1235", "JPY", 1235, 0),
        ("1.234", "KWD", 1234, 3),
    ],
)
def test_amounts_become_minor_units_with_decimal(amount: str, currency: str, minor: int, exp: int) -> None:
    found = one(txn(amount, "2026-11-01", currency=currency, payer="GOOGLE"))
    assert found is not None
    assert (found.amount_minor, found.exponent, found.currency) == (minor, exp, currency)
    assert found.micros == minor * 10 ** (6 - exp)  # a unit change, never a conversion


@pytest.mark.parametrize(("amount", "currency"), [("1234.567", "SEK"), ("1235.5", "JPY"), ("1.2345", "KWD")])
def test_too_many_decimals_for_the_money_are_dropped(amount: str, currency: str) -> None:
    assert one(txn(amount, "2026-11-01", currency=currency, payer="GOOGLE")) is None


def test_the_booking_day_is_real_and_no_later_than_tomorrow() -> None:
    assert one(txn("1.00", "2026-11-24", payer="TIKTOK")) is not None  # tomorrow
    assert one(txn("1.00", "2026-11-25", payer="TIKTOK")) is None
    assert one(txn("1.00", "2026-02-30", payer="TIKTOK")) is None
    row = txn("1.00", "2026-11-01", payer="TIKTOK")
    row["booking_date"] = None
    row["value_date"] = "2026-10-31"
    found = one(row)
    assert found is not None
    assert found.date == "2026-10-31"
    row["value_date"] = None
    found = one(row)
    assert found is not None
    assert found.date == "2026-11-01"
    row["transaction_date"] = None
    assert one(row) is None


def test_norm_drops_accents_and_everything_but_letters_and_digits() -> None:
    assert f.norm("Åkesson Café — x.com/Inc") == "AKESSON CAFE X COM INC"
    assert f.norm("  Google   Ireland\tLtd. ") == "GOOGLE IRELAND LTD"
    assert f.norm(None) == ""
    assert f.letters("GOOGLE 1234 IE") == "GOOGLEIE"


@pytest.mark.parametrize(
    ("payer", "text", "hint", "hint_from"),
    [
        ("GOOGLE IRELAND LTD", None, "youtube", "payer"),
        ("Bankgirot", "ADSENSE PAYMENT", "youtube", "text"),
        ("YOUTUBE", None, "youtube", "payer"),
        ("ByteDance Pte", None, "tiktok", "payer"),
        ("TikTok Pte Ltd", None, "tiktok", "payer"),
        ("Instagram LLC", None, "instagram", "payer"),
        ("Facebook Ireland", None, "facebook", "payer"),
        ("META PLATFORMS IRELAND", None, "meta", "payer"),
        ("X Corp", None, "x", "payer"),
        ("Twitter Intl", None, "x", "payer"),
        ("Bankgirot", "x.com payout", "x", "text"),
        ("STRIPE PAYMENTS", None, "stripe", "payer"),
        ("Payoneer Europe", None, "payoneer", "payer"),
        ("PAYPAL EUROPE", None, "paypal", "payer"),
        ("Whop Inc", None, "whop", "payer"),
        ("Bankgirot", "content rewards", "whop", "text"),
        # specific first: Whop's money through Stripe is Whop, Meta's Instagram money is Instagram
        ("STRIPE PAYMENTS", "WHOP PAYOUT", "whop", "text"),
        ("META PLATFORMS", "INSTAGRAM BONUS", "instagram", "text"),
        ("GOOGLE", "TIKTOK", "tiktok", "text"),
        # whole words only
        ("METALLICA FAN CLUB", None, None, None),
        ("XCORPORATE", None, None, None),
        ("Erik Eriksson", "Swish", None, None),
    ],
)
def test_the_hints_in_their_order(payer: str, text: str | None, hint: str | None, hint_from: str | None) -> None:
    found = one(txn("100.00", "2026-11-01", payer=payer, text=text))
    assert found is not None
    assert (found.hint, found.hint_from) == (hint, hint_from)


def test_shared_means_money_that_can_come_from_more_than_one_place() -> None:
    for payer in ("STRIPE PAYMENTS", "PAYPAL EUROPE", "Payoneer"):
        found = one(txn("100.00", "2026-11-01", payer=payer))
        assert found is not None, payer
        assert found.shared, payer
    whop_by_stripe = one(txn("100.00", "2026-11-01", payer="STRIPE", text="WHOP"))
    assert whop_by_stripe is not None
    assert whop_by_stripe.shared
    assert whop_by_stripe.hint == "whop"
    google = one(txn("100.00", "2026-11-01", payer="GOOGLE"))
    assert google is not None
    assert not google.shared


def test_remit_is_the_message_alone() -> None:
    found = one(txn("100.00", "2026-11-01", payer="Bankgirot", text=["Insättning", "TRC 4F7Q-92KX"]))
    assert found is not None
    assert found.remit == "INSATTNING TRC 4F7Q 92KX"


def test_payer_key_is_keyed_letters_only_and_none_without_a_name() -> None:
    a = one(txn("100.00", "2026-11-01", payer="GOOGLE 1234 IE"))
    b = one(txn("200.00", "2026-11-02", payer="Google 5678 Ie."))
    assert a is not None
    assert b is not None
    assert a.payer_key == b.payer_key == f.keyed(HASH_KEY, "payer|GOOGLEIE")
    assert a.payer_key is not None
    assert len(a.payer_key) == 32
    assert "GOOGLE" not in a.payer_key
    other_key = f.Filter(bytes(32), "link1", TODAY).add(txn("100.00", "2026-11-01", payer="GOOGLE 1234 IE"))
    assert other_key is not None
    assert other_key.payer_key != a.payer_key
    for payer in (None, "", "AB", "12 34"):
        found = one(txn("100.00", "2026-11-01", payer=payer, text="YOUTUBE"))
        assert found is not None, payer
        assert found.payer_key is None, payer


def test_deposit_id_with_an_entry_reference() -> None:
    row = txn("1234.56", "2026-11-01", payer="GOOGLE", ref="REF-1")
    found = one(row)
    assert found is not None
    assert found.deposit_id == f.keyed(HASH_KEY, "dep|REF-1|2026-11-01|123456|SEK")
    again = one(txn("1234.56", "2026-11-01", payer="Google Ireland", text="other text", ref="REF-1"))
    assert again is not None
    assert again.deposit_id == found.deposit_id
    other_day = one(txn("1234.56", "2026-11-02", payer="GOOGLE", ref="REF-1"))
    other_amount = one(txn("1234.57", "2026-11-01", payer="GOOGLE", ref="REF-1"))
    assert other_day is not None
    assert other_amount is not None
    assert len({found.deposit_id, other_day.deposit_id, other_amount.deposit_id}) == 3  # a reused reference


def test_deposit_id_without_a_reference_counts_identical_rows() -> None:
    filt = f.Filter(HASH_KEY, "link1", TODAY)
    rows = [txn("50.00", "2026-11-01", payer="TIKTOK", text="bonus") for _ in range(3)]
    ids = [c.deposit_id for c in (filt.add(r) for r in rows) if c is not None]
    assert len(set(ids)) == 3
    assert ids[0] == f.keyed(HASH_KEY, "dep|2026-11-01|5000|SEK|TIKTOKBONUS|1")
    assert ids[2] == f.keyed(HASH_KEY, "dep|2026-11-01|5000|SEK|TIKTOKBONUS|3")


def test_the_overlap_window_repeat_gets_the_same_id() -> None:
    """A row seen by a read of 1-20 Oct and again by a read of 11-30 Oct: a booking day is always read whole, so its
    ``n`` among identical rows is the same both times."""
    october = [txn("50.00", f"2026-10-{d:02d}", payer="TIKTOK", text="bonus") for d in range(1, 31)]
    october += [txn("50.00", "2026-10-15", payer="TIKTOK", text="bonus"), txn("80.00", "2026-10-15", payer="X CORP")]
    october.sort(key=lambda r: r["booking_date"])

    def read(first: str, last: str) -> dict[tuple[str, int], list[str]]:
        filt = f.Filter(HASH_KEY, "link1", TODAY)
        out: dict[tuple[str, int], list[str]] = {}
        for row in october:
            if first <= row["booking_date"] <= last:
                c = filt.add(row)
                assert c is not None
                out.setdefault((c.date, c.amount_minor), []).append(c.deposit_id)
        return out

    early, late = read("2026-10-01", "2026-10-20"), read("2026-10-11", "2026-10-30")
    shared = set(early) & set(late)
    assert ("2026-10-15", 5000) in shared
    assert len(early[("2026-10-15", 5000)]) == 2
    for key in shared:
        assert early[key] == late[key], key


def test_the_same_ids_after_a_reconnect_with_new_uids() -> None:
    """Neither input holds the account: another uid or ``identification_hash`` (a reconnect) gives the same ids."""
    rows = [txn("50.00", "2026-11-01", payer="TIKTOK"), txn("60.00", "2026-11-01", payer="GOOGLE", ref="R9")]
    before = [c.deposit_id for c in (f.Filter(HASH_KEY, "a1b2c3d4e5f6", TODAY).add(r) for r in rows) if c]
    after = [c.deposit_id for c in (f.Filter(HASH_KEY, "a1b2c3d4e5f6", TODAY).add(r) for r in rows) if c]
    assert before == after
    assert len(before) == 2


def test_no_other_field_is_ever_read() -> None:
    """Changing every field outside the list of §40.5.7 changes nothing about the candidate."""
    base = txn("100.00", "2026-11-01", payer="GOOGLE", text="ADSENSE", ref="R1")
    other = dict(base)
    for name in ("creditor", "creditor_account", "debtor_account", "creditor_agent", "balance_after_transaction"):
        other[name] = {"name": "Someone Else", "iban": "DE89370400440532013000"}
    other["reference_number"] = "999"
    other["note"] = "other"
    assert one(base) == one(other)
