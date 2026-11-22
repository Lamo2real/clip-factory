"""His answers on the question cards and on "Not from YouTube?" (docs/CONTRACTS.md §40.5.8; builder BA).

``PATCH /v1/getpaid/bank/deposits/{depositId}`` with ``{"answer", "place"?}``. **He never types an amount**: every
answer is a tap, and no answer changes ``amountMinor``, ``currency`` or ``date``. Only a platform word in the bank's
*payer name* is ever learned (``hintFrom "payer"`` with a ``payerKey``, and never a ``shared`` row): anyone can
write "YOUTUBE" in a transfer's message, so a word found only there is asked about every time.

Each write is conditional on the row's state, so a match the reader made meanwhile (BR's rule 9, itself conditional
on ``state = "needs_you"``) and his answer never both win.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso
from ..errors import ApiError, bad_request
from ..getpaid import CR
from ..log import log
from . import (
    ANSWER_UNKNOWN,
    ANSWERED,
    ASK_DAYS,
    DEPOSIT_ID,
    DEPOSIT_PREFIX,
    MAX_NOT_INCOME,
    MAX_RULES,
    NOT_INCOME_DAYS,
    PAYERS_SK,
    PAYMENT_UNKNOWN,
    PICK_PLACE,
    PLACES,
)

Item = dict[str, Any]
ANSWERS = ("yes", "place", "own_move", "not_sure", "not_income", "not_this")
# What a "not money from an app" row keeps (§40.5.7): its id, day, link, why and ttl, and nothing of the money.
NOT_INCOME_KEEPS = frozenset({"pk", "sk", "type", "state", "depositId", "date", "linkId", "why", "ttl"})
ASK_ONLY = ("suggested", "kind", "hint", "notSure", "ttl")


def _day(value: Any) -> date | None:
    if isinstance(value, str) and len(value) >= 10:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _ttl(day: date) -> int:
    return int(datetime.combine(day, datetime.min.time(), UTC).timestamp())


def find(store: db.Store, user_id: str, deposit_id: str) -> Item:
    if not DEPOSIT_ID.match(deposit_id):
        raise ApiError(404, "not_found", PAYMENT_UNKNOWN)
    for item in store.query_all(db.user_pk(user_id), DEPOSIT_PREFIX):
        if item.get("depositId") == deposit_id:
            return item
    raise ApiError(404, "not_found", PAYMENT_UNKNOWN)


def _update(
    store: db.Store,
    user_id: str,
    row: Mapping[str, Any],
    *,
    expect: str,
    sets: Mapping[str, Any],
    remove: list[str],
) -> None:
    """One UpdateItem on the row, conditional on its state (409 when it changed meanwhile)."""
    names: dict[str, str] = {"#state": "state"}
    values: Item = {":expect": expect}
    parts = []
    for i, (field, value) in enumerate(sets.items()):
        names[f"#s{i}"], values[f":s{i}"] = field, value
        parts.append(f"#s{i} = :s{i}")
    expression = "SET " + ", ".join(parts) if parts else ""
    gone = [f for f in dict.fromkeys(remove) if f not in sets and f in row]
    if gone:
        for i, field in enumerate(gone):
            names[f"#r{i}"] = field
        expression += (" " if expression else "") + "REMOVE " + ", ".join(f"#r{i}" for i in range(len(gone)))
    try:
        store.update_expr(
            db.user_pk(user_id),
            str(row["sk"]),
            expression,
            condition="attribute_exists(pk) AND #state = :expect",
            names=names,
            values=values,
        )
    except db.ConditionFailed as e:
        raise ApiError(409, "conflict", ANSWERED) from e


def _payers(store: db.Store, user_id: str) -> Item:
    return store.get(db.user_pk(user_id), PAYERS_SK) or {}


def _learns(row: Mapping[str, Any]) -> bool:
    return bool(row.get("payerKey")) and row.get("shared") is not True and row.get("hintFrom") == "payer"


def _learn(store: db.Store, user_id: str, payer_key: str, place: str, now: datetime) -> None:
    """``BANKPAYERS.rules[payerKey] = {place, learnedAt}`` (at most 50: the oldest goes)."""
    current = _payers(store, user_id)
    rules = {k: dict(v) for k, v in (current.get("rules") or {}).items() if isinstance(v, Mapping)}
    rules[payer_key] = {"place": place, "learnedAt": iso(now)}
    while len(rules) > MAX_RULES:
        oldest = min((k for k in rules if k != payer_key), key=lambda k: str(rules[k].get("learnedAt") or ""))
        rules.pop(oldest)
    store.update_expr(
        db.user_pk(user_id),
        PAYERS_SK,
        "SET #t = :t, #r = :r, #u = :u",
        names={"#t": "type", "#r": "rules", "#u": "updatedAt"},
        values={":t": "bankpayers", ":r": rules, ":u": iso(now)},
    )


def _unlearn(store: db.Store, user_id: str, payer_key: str, now: datetime) -> None:
    current = _payers(store, user_id)
    rules = current.get("rules")
    if not isinstance(rules, Mapping) or payer_key not in rules:
        return
    kept = {k: dict(v) for k, v in rules.items() if k != payer_key and isinstance(v, Mapping)}
    store.update_expr(
        db.user_pk(user_id),
        PAYERS_SK,
        "SET #r = :r, #u = :u",
        names={"#u": "updatedAt", "#r": "rules"},
        values={":u": iso(now), ":r": kept},
    )


def _not_income(store: db.Store, user_id: str, payer_key: str, now: datetime) -> None:
    current = _payers(store, user_id)
    known = {str(k) for k in current.get("notIncome") or []}
    if payer_key in known or len(known) >= MAX_NOT_INCOME:
        return
    store.update_expr(
        db.user_pk(user_id),
        PAYERS_SK,
        "SET #t = :t, #u = :u ADD #n :n",
        names={"#t": "type", "#u": "updatedAt", "#n": "notIncome"},
        values={":t": "bankpayers", ":u": iso(now), ":n": {payer_key}},
    )


def _match(store: db.Store, user_id: str, row: Mapping[str, Any], *, place: str, how: str, now: datetime) -> None:
    sets: Item = {"state": "matched", "place": place, "how": how, "confirmedAt": iso(now)}
    _update(store, user_id, row, expect="needs_you", sets=sets, remove=list(ASK_ONLY))


def _place_answer(place: Any, cr_on: bool) -> str:
    if not isinstance(place, str) or place not in PLACES or (place == CR and not cr_on):
        raise bad_request(PICK_PLACE, "place")
    return place


def answer(
    store: db.Store, user_id: str, deposit_id: str, body: Mapping[str, Any], now: datetime, *, cr_on: bool
) -> str:
    """Applies one answer (§40.5.8's table). Returns the answer for the log."""
    kind = body.get("answer")
    if kind not in ANSWERS:
        raise bad_request(ANSWER_UNKNOWN, "answer")
    row = find(store, user_id, deposit_id)
    state = row.get("state")
    if kind == "not_this":
        if state != "matched":
            raise ApiError(409, "conflict", ANSWERED)
        _not_this(store, user_id, row, now)
        return str(kind)
    if state != "needs_you":
        raise ApiError(409, "conflict", ANSWERED)
    if kind in {"yes", "place"}:
        place = _place_answer(row.get("suggested") if kind == "yes" else body.get("place"), cr_on)
        _match(store, user_id, row, place=place, how="you", now=now)
        if _learns(row):
            payer_key = str(row["payerKey"])
            _learn(store, user_id, payer_key, place, now)
            for other in store.query_all(db.user_pk(user_id), DEPOSIT_PREFIX):
                if (
                    other.get("sk") != row.get("sk")
                    and other.get("state") == "needs_you"
                    and other.get("payerKey") == payer_key
                    and other.get("hintFrom") == "payer"
                    and other.get("shared") is not True
                ):
                    try:
                        _match(store, user_id, other, place=place, how="payer", now=now)
                    except ApiError:
                        continue  # answered meanwhile
        return str(kind)
    if kind == "own_move":
        if row.get("kind") != "own_move":
            raise ApiError(409, "conflict", ANSWERED)
        _drop(store, user_id, row, "own_move")
        return str(kind)
    if kind == "not_sure":
        _update(store, user_id, row, expect="needs_you", sets={"notSure": True}, remove=[])
        return str(kind)
    _drop(store, user_id, row, "you")
    if row.get("payerKey") and row.get("shared") is not True:
        _not_income(store, user_id, str(row["payerKey"]), now)
    return str(kind)


def _drop(store: db.Store, user_id: str, row: Mapping[str, Any], why: str) -> None:
    """``not_income``: only ``depositId``, ``date``, ``linkId``, ``why`` and ``ttl`` (booking day + 400 days)."""
    day = _day(row.get("date"))
    sets: Item = {"state": "not_income", "why": why}
    if day is not None:
        sets["ttl"] = _ttl(day + timedelta(days=NOT_INCOME_DAYS))
    _update(store, user_id, row, expect="needs_you", sets=sets, remove=[k for k in row if k not in NOT_INCOME_KEEPS])


def _not_this(store: db.Store, user_id: str, row: Mapping[str, Any], now: datetime) -> None:
    """Back to ``needs_you`` (no suggestion). A payout match frees its payout into ``notPayout``; a payer or "you"
    match forgets that payer (the rows it matched before stay)."""
    days = [d for d in (_day(row.get("date")), _day(row.get("fetchedAt")), now.date()) if d is not None]
    sets: Item = {
        "state": "needs_you",
        "kind": "place",
        "notSure": False,
        "ttl": _ttl(max(days) + timedelta(days=ASK_DAYS)),
    }
    remove = ["place", "how", "confirmedAt", "suggested", "payoutRef", "payoutDate"]
    if row.get("how") == "payout" and isinstance(row.get("payoutRef"), str):
        earlier = row.get("notPayout")
        refused = [str(r) for r in earlier if isinstance(r, str)] if isinstance(earlier, list | set | tuple) else []
        sets["notPayout"] = sorted({*refused, str(row["payoutRef"])})
    _update(store, user_id, row, expect="matched", sets=sets, remove=remove)
    if row.get("how") in {"payer", "you"} and row.get("payerKey"):
        _unlearn(store, user_id, str(row["payerKey"]), now)
    log("info", "bank.not_this", how=str(row.get("how") or ""))
