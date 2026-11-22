"""Matching a read's candidates to the apps (docs/CONTRACTS.md §40.5.8; pure, golden cases in
``tests/fixtures/bank_match_cases.json``).

The rules run in this order, and the first one that applies wins. The payout rules come before "He said it isn't app
money", so a payer he once called "not app money" (a Google refund, say) still counts when Google's own payout record
matches it:

1. **Kept already**: a ``DEPOSIT#`` with this ``depositId`` exists → nothing (a ``needs_you`` row is looked at again
   in rule 9).
2. **A payout record** (``how "payout"``): the same currency and exactly the same amount as a ``PAYOUT#`` row that
   isn't paired yet (and isn't in the row's ``notPayout``), booked from the payout's date to 10 workdays after it. With
   several candidates for one payout: the one whose hint fits the payout's place, then the earliest, then the smaller
   ``depositId``. A payout pairs with one deposit only.
3. **Whop's trace code** (``how "payout"``): only for a ``whop`` hint or none; a Content Rewards ``traceCode`` of at
   least 10 letters and digits, as whole words in the bank's message, within 15 workdays, at any amount.
4. **Google's tiny test payment**: a ``youtube`` hint at or under its currency's test ceiling → dropped.
5. **He said it isn't app money**: ``payerKey`` in ``notIncome`` and not ``shared`` → dropped.
6. **A payer he confirmed** (``how "payer"``): not ``shared``, ``hintFrom "payer"``, ``payerKey`` in the rules.
7. **Money moved from his own PayPal**: a ``paypal`` hint while a PayPal link is connected, in another link → asked
   as ``own_move``.
8. **Ask him**: any hint → ``needs_you``, ``kind "place"``, ``suggested`` from the hint.
9. **Again each run**: every stored ``needs_you`` row is matched again with rules 2 and 6.
10. **Everything else** (no hint) → dropped in memory.

Nothing here converts, adds or estimates money: an amount is compared only with the same currency's, in micros (a
change of unit), and the test ceilings are Clip Factory's own number for each currency.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta

from . import CONTENT_REWARDS, YOUTUBE
from .filter import Candidate, has_word, micros, norm

PAYOUT_WORKDAYS = 10
TRACE_WORKDAYS = 15
TRACE_MIN = 10
# Google's test deposits are 0.15-1.10 EUR in the local money; a real YouTube payment is at least kr 700 (kr 70 when
# an account closes). Clip Factory's own ceiling per currency, in micros; other currencies have none.
TEST_CEILINGS = {
    "SEK": 20_000_000,
    "NOK": 20_000_000,
    "DKK": 15_000_000,
    "EUR": 2_000_000,
    "USD": 2_000_000,
    "GBP": 2_000_000,
    "CHF": 2_000_000,
}
# The place each hint suggests (§40.5.8 rule 8). ``whop`` only while Content Rewards is on.
SUGGEST = {
    "youtube": "youtube",
    "instagram": "instagram",
    "facebook": "facebook",
    "meta": "meta",
    "tiktok": "tiktok",
    "x": "x",
    "stripe": "x",
    "whop": CONTENT_REWARDS,
    "paypal": None,
    "payoneer": None,
}
FITS = {YOUTUBE: "youtube", CONTENT_REWARDS: "whop"}


def add_workdays(start: str, n: int) -> str:
    """The day ``n`` workdays (Monday to Friday) after ``start``."""
    day = date.fromisoformat(start)
    left = n
    while left > 0:
        day += timedelta(days=1)
        if day.weekday() < 5:
            left -= 1
    return day.isoformat()


def within(booked: str, start: str, workdays: int) -> bool:
    return start <= booked <= add_workdays(start, workdays)


@dataclass(frozen=True)
class Payout:
    """A ``PAYOUT#`` row with ``state "sent"``: its sort key, place, date and amount (``None`` when it couldn't be read:
    then it never matches by amount), and Whop's ``traceCode`` (normalised) for Content Rewards."""

    ref: str
    place: str
    date: str
    micros: int | None
    currency: str | None
    trace: str | None = None


@dataclass(frozen=True)
class Stored:
    """A stored ``needs_you`` row (rule 9): what rules 2 and 6 need, never the bank's text (it is gone)."""

    deposit_id: str
    sk: str
    date: str
    amount_minor: int
    exponent: int
    currency: str
    hint: str | None
    hint_from: str | None
    shared: bool
    payer_key: str | None
    not_payout: frozenset[str] = frozenset()
    quiet: bool = False

    @property
    def micros(self) -> int:
        return micros(self.amount_minor, self.exponent)


@dataclass
class Context:
    payouts: list[Payout] = field(default_factory=list)
    paired: set[str] = field(default_factory=set)  # payoutRefs already paired with a deposit
    kept: set[str] = field(default_factory=set)  # every stored depositId, any state
    rules: dict[str, str] = field(default_factory=dict)  # BANKPAYERS.rules: payerKey → place
    not_income: set[str] = field(default_factory=set)  # BANKPAYERS.notIncome
    paypal_links: set[str] = field(default_factory=set)  # linkIds of connected PayPal links
    content_rewards: bool = False
    stored: list[Stored] = field(default_factory=list)  # needs_you rows


@dataclass(frozen=True)
class Decision:
    """What one new candidate became. ``state``: ``matched``, ``needs_you``, ``dropped`` or ``kept`` (rule 1)."""

    deposit_id: str
    state: str
    rule: str
    place: str | None = None
    how: str | None = None
    payout_ref: str | None = None
    payout_date: str | None = None
    suggested: str | None = None
    kind: str | None = None


@dataclass(frozen=True)
class Rematch:
    """A stored ``needs_you`` row that matches now (rule 9)."""

    deposit_id: str
    sk: str
    place: str
    how: str
    payout_ref: str | None = None
    payout_date: str | None = None


def trace_code(raw: object) -> str | None:
    """Whop's trace code, normalised (a dash becomes a space), when it has at least 10 letters and digits."""
    code = norm(raw)
    return code if sum(c.isalnum() for c in code) >= TRACE_MIN else None


def is_test_deposit(c: Candidate) -> bool:
    ceiling = TEST_CEILINGS.get(c.currency)
    return c.hint == "youtube" and ceiling is not None and c.micros <= ceiling


def _rank(item: Candidate | Stored, payout: Payout) -> tuple[int, str, str]:
    fits = item.hint is not None and item.hint == FITS.get(payout.place)
    return (0 if fits else 1, item.date, item.deposit_id)


def _payout_pairs(pool: Iterable[Candidate | Stored], ctx: Context, paired: set[str]) -> dict[str, Payout]:
    """Rule 2 for every unpaired payout, oldest first: depositId → the payout it pairs with."""
    items = list(pool)
    out: dict[str, Payout] = {}
    for payout in sorted(ctx.payouts, key=lambda p: (p.date, p.ref)):
        if payout.ref in paired or payout.micros is None or not payout.currency:
            continue
        fits = [
            item
            for item in items
            if item.deposit_id not in out
            and item.currency == payout.currency
            and item.micros == payout.micros
            and within(item.date, payout.date, PAYOUT_WORKDAYS)
            and payout.ref not in (item.not_payout if isinstance(item, Stored) else frozenset())
        ]
        if fits:
            best = min(fits, key=lambda item: _rank(item, payout))
            out[best.deposit_id] = payout
            paired.add(payout.ref)
    return out


def _trace(c: Candidate, ctx: Context, paired: set[str]) -> Payout | None:
    if c.hint not in (None, "whop"):
        return None
    for payout in sorted(ctx.payouts, key=lambda p: (p.date, p.ref)):
        if payout.place != CONTENT_REWARDS or not payout.trace or payout.ref in paired:
            continue
        if within(c.date, payout.date, TRACE_WORKDAYS) and has_word(c.remit, payout.trace):
            return payout
    return None


def _suggest(hint: str, ctx: Context) -> str | None:
    place = SUGGEST.get(hint)
    if place == CONTENT_REWARDS and not ctx.content_rewards:
        return None
    return place


def match(candidates: Iterable[Candidate], ctx: Context) -> tuple[list[Decision], list[Rematch]]:
    """The decisions for one read's candidates (oldest first) and the stored ``needs_you`` rows that match now."""
    ordered: list[Candidate] = []
    seen: set[str] = set()
    for _, candidate in sorted(enumerate(candidates), key=lambda pair: (pair[1].date, pair[0])):
        if candidate.deposit_id not in seen:  # two accounts with the same row on the same day: that money counts once
            seen.add(candidate.deposit_id)
            ordered.append(candidate)
    fresh = [c for c in ordered if c.deposit_id not in ctx.kept]
    stored = list(ctx.stored)
    paired = set(ctx.paired)
    pairs = _payout_pairs([*fresh, *stored], ctx, paired)

    decisions: list[Decision] = []
    for c in ordered:
        if c.deposit_id in ctx.kept:
            decisions.append(Decision(c.deposit_id, "kept", "kept"))
            continue
        payout = pairs.get(c.deposit_id)
        if payout is not None:
            decisions.append(
                Decision(c.deposit_id, "matched", "payout", payout.place, "payout", payout.ref, payout.date)
            )
            continue
        payout = _trace(c, ctx, paired)
        if payout is not None:
            paired.add(payout.ref)
            decisions.append(
                Decision(c.deposit_id, "matched", "trace", CONTENT_REWARDS, "payout", payout.ref, payout.date)
            )
            continue
        if is_test_deposit(c):
            decisions.append(Decision(c.deposit_id, "dropped", "test_deposit"))
            continue
        if c.payer_key is not None and c.payer_key in ctx.not_income and not c.shared:
            decisions.append(Decision(c.deposit_id, "dropped", "not_income"))
            continue
        if not c.shared and c.hint_from == "payer" and c.payer_key is not None and c.payer_key in ctx.rules:
            decisions.append(Decision(c.deposit_id, "matched", "payer", ctx.rules[c.payer_key], "payer"))
            continue
        if c.hint == "paypal" and ctx.paypal_links and c.link_id not in ctx.paypal_links:
            decisions.append(Decision(c.deposit_id, "needs_you", "own_move", kind="own_move"))
            continue
        if c.hint is not None:
            decisions.append(Decision(c.deposit_id, "needs_you", "ask", suggested=_suggest(c.hint, ctx), kind="place"))
            continue
        decisions.append(Decision(c.deposit_id, "dropped", "no_hint"))

    rematches: list[Rematch] = []
    for s in stored:
        payout = pairs.get(s.deposit_id)
        if payout is not None:
            rematches.append(Rematch(s.deposit_id, s.sk, payout.place, "payout", payout.ref, payout.date))
        elif not s.shared and s.hint_from == "payer" and s.payer_key is not None and s.payer_key in ctx.rules:
            rematches.append(Rematch(s.deposit_id, s.sk, ctx.rules[s.payer_key], "payer"))
    return decisions, rematches
