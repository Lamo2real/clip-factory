"""``bankread.collect.run``: one owner's bank read (docs/CONTRACTS.md §40.5.6-§40.5.8, §40.5.11).

**When**: ``cf-prod-money``'s 06:00 UTC run calls it at the end of ``run_user(…, bank=True)`` (after the payout reads,
so the day's new ``PAYOUT#`` rows are there to match), and the money handler's ``bank`` action (his own bank Check
now) calls it with ``mine=True`` and his PSU details. Money's own Check now never reads the bank. Nothing runs while
``BANK_READING`` is off, and an owner with no ``BANKLINK#`` gets no call at all.

**One read at a time**: the run claims ``BANKCONN.readLease {until: now + 300 s}`` (absent or expired) and releases it
at the end; another read, or Forget my bank, holding it means this run skips the bank (``bank.read_busy``). Before each
batch of ``DEPOSIT#`` writes it reads ``BANKCONN.forgottenAt`` again and stops writing at once when that is later than
the run's start.

**Per connected link** (no ``limitUntil`` ahead): the session secret and the app secret, both read fresh; the secret's
``connectedAt`` must equal the link's (read once more, else skip: ``bank.stale_secret``); ``GET /sessions/{id}``; then
each account's booked transactions, page by page with the same parameters, filtered in memory
(``bankread.filter``), matched (``bankread.match``) and written; then the link's read state. Every link write is
conditional on ``status = "connected"`` and the ``connectedAt`` the read started with, so a Stop or a reconnect during
a read wins. Nothing is ever deleted.

**Least data**: only §40.5.7's attributes are stored; the rest of every row is gone once the page is done. Logs carry
counts and Enable Banking's error code only, never an amount, a name, a text, an IBAN, a uid, a session id, a hash, the
IP address or the user agent.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from .. import db
from ..clock import iso, parse
from ..getpaid.sent import parse_amount
from ..log import log
from . import (
    ACCOUNT_SKIPPED,
    BANKCONN_SK,
    BANKLINK_PREFIX,
    BANKPAYERS_SK,
    CONTENT_REWARDS,
    DEPOSIT_PREFIX,
    DOWN,
    EXPIRY_NOTICE_DAYS,
    KEY_WRONG,
    LEASE_SECONDS,
    LIMIT_HIT,
    MIN_SECONDS_LEFT,
    NEEDS_YOU_TTL_DAYS,
    NOTICE_REACHED_MAX,
    PAYPAL,
    PLACES,
    REASON_CONSENT_OVER,
    REASON_ENDED_EARLY,
    REASON_PSU_ACTION,
    REFERER_PATH,
    SOURCE,
    STATUS_CONNECTED,
    STATUS_ENDED,
    STATUS_STOPPED_AT_BANK,
    WAIT,
    YOUTUBE,
    BankReadDeps,
    app_secret,
    deposit_sk,
    from_money,
    token_secret,
)
from . import client as eb
from .filter import Candidate, Filter, any_day
from .match import Context, Decision, Payout, Rematch, Stored, match, trace_code

FIRST_DAYS = 400  # his first read, strategy=longest
DEFAULT_DAYS = 89  # every read without him, and any read once the first hour is over
OVERLAP_DAYS = 10  # bookings with an earlier date; depositId makes them count once
HISTORY_HOUR = timedelta(hours=1)
MAX_PAGES = 100  # per account per run; more waits for the next run (``resume``)
WRITE_BATCH = 25
LONGEST = "longest"
DEFAULT = "default"


class Forgotten(Exception):
    """Forget my bank happened during this read: nothing more is written."""


@dataclass
class Notice:
    """What a run found to tell (``BANKCONN.lastNotice``, sent by ``cf-prod-notify`` under ``notify.getPaid``)."""

    reached: list[dict[str, Any]] = field(default_factory=list)
    asks: int = 0
    expiring: list[dict[str, Any]] = field(default_factory=list)
    ended: list[dict[str, Any]] = field(default_factory=list)

    def any(self) -> bool:
        return bool(self.reached or self.asks or self.expiring or self.ended)

    def item(self, key: str) -> dict[str, Any]:
        return {
            "key": key,
            "reached": self.reached[:NOTICE_REACHED_MAX],
            "reachedMore": max(0, len(self.reached) - NOTICE_REACHED_MAX),
            "asks": self.asks,
            "expiring": self.expiring,
            "ended": self.ended,
        }


@dataclass
class Plan:
    strategy: str
    date_from: str
    date_to: str | None
    headers: dict[str, str] | None
    cost: int
    start: int = 0
    continuation: str | None = None
    floor: str | None = None  # a first read restarted from today - 89 days: "Counted from" is no earlier than this


@dataclass
class LinkRead:
    client: eb.Client
    hash_key: bytes
    link_id: str
    headers: dict[str, str] | None
    reads: dict[str, Any]
    candidates: list[Candidate] = field(default_factory=list)
    finished: bool = False
    resume: dict[str, Any] | None = None
    outcome: str | None = None
    error: eb.BankError | None = None
    account_skipped: bool = False
    oldest: str | None = None
    floor: str | None = None
    pages: int = 0
    seen: int = 0
    called: bool = False
    psu_retried: bool = False


@dataclass
class Account:
    """One account's read, in memory only (its uid is never stored or logged)."""

    index: int
    uid: str
    strategy: str
    date_from: str
    date_to: str | None
    key: str | None
    filter: Filter
    from_resume: bool = False
    retried: bool = False
    pages: int = 0
    found: list[Candidate] = field(default_factory=list)


def _day_minus(day: date, days: int) -> str:
    return (day - timedelta(days=days)).isoformat()


def _as_day(value: Any) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _ttl(booked: str, now: datetime) -> int:
    """The later of the booking date and the fetch day, + 180 days (a first read going back 400 days would otherwise
    write rows already past their ``ttl``)."""
    later = max(date.fromisoformat(booked), now.date())
    end = later + timedelta(days=NEEDS_YOU_TTL_DAYS)
    return int(datetime(end.year, end.month, end.day, tzinfo=UTC).timestamp())


def _strs(value: Any) -> frozenset[str]:
    if isinstance(value, str):
        return frozenset({value})
    try:
        return frozenset(v for v in value or () if isinstance(v, str))
    except TypeError:
        return frozenset()


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class Reader:
    def __init__(
        self, deps: BankReadDeps, user_id: str, now: datetime, *, psu: Mapping[str, Any] | None, mine: bool
    ) -> None:
        self.deps = deps
        self.store = deps.store
        self.pk = db.user_pk(user_id)
        self.now = now
        self.today = now.date()
        self.psu = psu if mine and isinstance(psu, Mapping) else None
        self.mine = mine
        self.notice = Notice()
        self.forgotten = False
        self.writes = 0
        self.key_wrong_written = False
        self.counts = {"links": 0, "matched": 0, "asked": 0, "dropped": 0}
        self.referer = f"{deps.app_url.rstrip('/')}{REFERER_PATH}" if deps.app_url.startswith("https://") else ""

    # --- the lease and forgottenAt ----------------------------------------------------------------------------

    def claim(self) -> dict[str, Any] | None:
        """``BANKCONN.readLease {until: now + 300 s}``, only while it is absent or expired; None when another read (or
        Forget my bank) holds it. The lease is compared as a whole value, so the claim is one conditional write."""
        conn = self.store.get(self.pk, BANKCONN_SK)
        if conn is None:
            return None
        old = conn.get("readLease")
        held = parse(old.get("until")) if isinstance(old, Mapping) else None
        if held is not None and held > self.now:
            return None
        lease = {"until": iso(self.now + timedelta(seconds=LEASE_SECONDS))}
        condition = "attribute_exists(pk) AND attribute_not_exists(#l)"
        values: dict[str, Any] = {":lease": lease}
        if isinstance(old, Mapping):
            condition = "attribute_exists(pk) AND #l = :old"
            values[":old"] = dict(old)
        try:
            self.store.update_expr(
                self.pk, BANKCONN_SK, "SET #l = :lease", condition=condition, names={"#l": "readLease"}, values=values
            )
        except db.ConditionFailed:
            return None
        return lease

    def check_forgotten(self) -> None:
        conn = self.store.get(self.pk, BANKCONN_SK) or {}
        forgotten = parse(conn.get("forgottenAt"))
        if forgotten is not None and forgotten > self.now:
            self.forgotten = True
            log("warning", "bank.forgotten_during_read")
            raise Forgotten()

    def finish(self, lease: Mapping[str, Any]) -> None:
        """Releases the lease (only its own) and writes ``lastRunAt`` and, when the run found something, ``lastNotice``."""
        names = {"#l": "readLease"}
        values: dict[str, Any] = {":mine": dict(lease)}
        if self.forgotten:
            with contextlib.suppress(db.ConditionFailed):
                self.store.update_expr(
                    self.pk, BANKCONN_SK, "REMOVE #l", condition="#l = :mine", names=names, values=values
                )
            return
        sets: dict[str, tuple[str, Any]] = {"#r": ("lastRunAt", iso(self.now))}
        if self.notice.any():
            sets["#n"] = ("lastNotice", self.notice.item(iso(self.now)))
        names.update({k: v[0] for k, v in sets.items()})
        values.update({f":{k[1:]}": v[1] for k, v in sets.items()})
        update = "SET " + ", ".join(f"{k} = :{k[1:]}" for k in sets)
        try:
            self.store.update_expr(
                self.pk, BANKCONN_SK, update + " REMOVE #l", condition="#l = :mine", names=names, values=values
            )
            return
        except db.ConditionFailed:
            pass
        # Another read or Forget took the lease meanwhile (ours ran out): never write over a Forget.
        try:
            self.check_forgotten()
        except Forgotten:
            return
        values.pop(":mine")
        names.pop("#l")
        try:
            self.store.update_expr(
                self.pk, BANKCONN_SK, update, condition="attribute_exists(pk)", names=names, values=values
            )
        except db.ConditionFailed:
            return

    # --- what matching needs ------------------------------------------------------------------------------------

    def _payouts(self) -> list[Payout]:
        out: list[Payout] = []
        for place in (YOUTUBE, CONTENT_REWARDS):
            for row in self.store.query_all(self.pk, f"PAYOUT#{place}#"):
                if row.get("state") != "sent" or not isinstance(row.get("date"), str):
                    continue
                if place == YOUTUBE:
                    amount, currency = parse_amount(row.get("amountText"))
                    trace = None
                else:
                    amount, currency = _int(row.get("amountMicros")), row.get("currency")
                    trace = trace_code(row.get("traceCode")) if row.get("traceCode") else None
                if amount is not None and amount <= 0:
                    amount = None
                out.append(
                    Payout(
                        ref=str(row["sk"]),
                        place=place,
                        date=str(row["date"])[:10],
                        micros=amount,
                        currency=currency if isinstance(currency, str) else None,
                        trace=trace,
                    )
                )
        return out

    def context(self, links: list[dict[str, Any]]) -> tuple[Context, dict[str, dict[str, Any]]]:
        deposits = self.store.query_all(self.pk, DEPOSIT_PREFIX)
        kept = {str(d["depositId"]) for d in deposits if isinstance(d.get("depositId"), str)}
        paired = {
            str(d["payoutRef"])
            for d in deposits
            if d.get("state") == "matched" and d.get("how") == "payout" and isinstance(d.get("payoutRef"), str)
        }
        epoch = self.now.timestamp()
        waiting: dict[str, dict[str, Any]] = {}
        stored: list[Stored] = []
        for d in deposits:
            if d.get("state") != "needs_you" or not isinstance(d.get("depositId"), str):
                continue
            ttl = _int(d.get("ttl"))
            minor, exp = _int(d.get("amountMinor")), _int(d.get("exponent"))
            if (ttl is not None and ttl < epoch) or minor is None or exp is None:
                continue
            waiting[str(d["depositId"])] = d
            stored.append(
                Stored(
                    deposit_id=str(d["depositId"]),
                    sk=str(d["sk"]),
                    date=str(d.get("date") or "")[:10],
                    amount_minor=minor,
                    exponent=exp,
                    currency=str(d.get("currency") or ""),
                    hint=d.get("hint") if isinstance(d.get("hint"), str) else None,
                    hint_from=d.get("hintFrom") if isinstance(d.get("hintFrom"), str) else None,
                    shared=bool(d.get("shared")),
                    payer_key=d.get("payerKey") if isinstance(d.get("payerKey"), str) else None,
                    not_payout=_strs(d.get("notPayout")),
                    quiet=bool(d.get("quiet")),
                )
            )
        payers = self.store.get(self.pk, BANKPAYERS_SK) or {}
        raw = payers.get("rules")
        raw_rules: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
        rules = {
            str(k): str(v["place"]) for k, v in raw_rules.items() if isinstance(v, Mapping) and v.get("place") in PLACES
        }
        paypal = {
            str(link.get("linkId"))
            for link in links
            if link.get("status") == STATUS_CONNECTED and str(link.get("bank") or "").strip().lower() == PAYPAL.lower()
        }
        ctx = Context(
            payouts=self._payouts(),
            paired=paired,
            kept=kept,
            rules=rules,
            not_income=set(_strs(payers.get("notIncome"))),
            paypal_links=paypal,
            content_rewards=self.deps.content_rewards,
            stored=stored,
        )
        return ctx, waiting

    # --- writing deposits ---------------------------------------------------------------------------------------

    def _batch(self) -> None:
        if self.writes % WRITE_BATCH == 0:
            self.check_forgotten()
        self.writes += 1

    def _deposit(self, c: Candidate, d: Decision, quiet: bool) -> dict[str, Any]:
        item: dict[str, Any] = {
            "pk": self.pk,
            "sk": deposit_sk(c.date, c.deposit_id),
            "type": "deposit",
            "state": d.state,
            "depositId": c.deposit_id,
            "date": c.date,
            "amountMinor": c.amount_minor,
            "exponent": c.exponent,
            "currency": c.currency,
            "linkId": c.link_id,
            "source": SOURCE,
            "fetchedAt": iso(self.now),
        }
        if quiet:
            item["quiet"] = True
        if d.state == "matched":
            item["place"] = d.place
            item["how"] = d.how
            if d.how == "payout":
                item["payoutRef"] = d.payout_ref
                item["payoutDate"] = d.payout_date
            else:
                item["payerKey"] = c.payer_key
                item["hintFrom"] = c.hint_from
                item["shared"] = c.shared
            return item
        item["kind"] = d.kind
        if d.suggested:
            item["suggested"] = d.suggested
        if c.hint:
            item["hint"] = c.hint
        if c.hint_from:
            item["hintFrom"] = c.hint_from
        item["shared"] = c.shared
        if c.payer_key:
            item["payerKey"] = c.payer_key
        item["ttl"] = _ttl(c.date, self.now)
        return item

    def _reached(self, deposit_id: str, place: str, minor: int, exp: int, currency: str) -> None:
        self.notice.reached.append(
            {"depositId": deposit_id, "place": place, "amountMinor": minor, "exponent": exp, "currency": currency}
        )

    def write(self, candidates: list[Candidate], links: list[dict[str, Any]], quiet: bool) -> dict[str, int]:
        """Matches one read's candidates (and every stored ``needs_you`` row again) and writes the outcome."""
        counts = {"matched": 0, "asked": 0, "dropped": 0, "kept": 0}
        self.writes = 0  # each batch starts by reading forgottenAt again
        ctx, waiting = self.context(links)
        decisions, rematches = match(candidates, ctx)
        by_id = {c.deposit_id: c for c in candidates}
        for d in decisions:
            if d.state in ("dropped", "kept"):
                counts[d.state] += 1
                continue
            c = by_id[d.deposit_id]
            self._batch()
            try:
                self.store.put_when(self._deposit(c, d, quiet), "attribute_not_exists(pk)")
            except db.ConditionFailed:
                counts["kept"] += 1  # written meanwhile: his answer (or another read) wins
                continue
            if d.state == "matched":
                counts["matched"] += 1
                if not quiet and d.place:
                    self._reached(c.deposit_id, d.place, c.amount_minor, c.exponent, c.currency)
            else:
                counts["asked"] += 1
                if not quiet:
                    self.notice.asks += 1
        for r in rematches:
            stored = waiting.get(r.deposit_id) or {}
            self._batch()
            if self._rematch(r):
                counts["matched"] += 1
                if not stored.get("quiet"):
                    minor, exp = _int(stored.get("amountMinor")), _int(stored.get("exponent"))
                    if minor is not None and exp is not None:
                        self._reached(r.deposit_id, r.place, minor, exp, str(stored.get("currency") or ""))
        return counts

    def _rematch(self, r: Rematch) -> bool:
        """A stored ``needs_you`` row matches now (rule 9), on the condition ``state = "needs_you"`` so an answer he
        gave meanwhile wins. The row keeps only the matched row's attributes."""
        sets: dict[str, Any] = {"state": "matched", "place": r.place, "how": r.how}
        remove = ["suggested", "kind", "hint", "notSure", "ttl"]
        if r.how == "payout":
            sets.update({"payoutRef": r.payout_ref, "payoutDate": r.payout_date})
            remove += ["payerKey", "hintFrom", "shared"]
        names = {f"#s{i}": k for i, k in enumerate(sets)} | {f"#r{i}": k for i, k in enumerate(remove)}
        names["#state"] = "state"
        values = {f":s{i}": v for i, v in enumerate(sets.values())} | {":needs": "needs_you"}
        update = "SET " + ", ".join(f"#s{i} = :s{i}" for i in range(len(sets)))
        update += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(remove)))
        try:
            self.store.update_expr(
                self.pk,
                r.sk,
                update,
                condition="attribute_exists(pk) AND #state = :needs",
                names=names,
                values=values,
            )
        except db.ConditionFailed:
            return False
        return True

    # --- the link's read state ----------------------------------------------------------------------------------

    def update_link(
        self,
        link: Mapping[str, Any],
        sets: Mapping[str, Any],
        remove: list[str] | tuple[str, ...] = (),
        *,
        failing: bool = False,
    ) -> bool:
        """One UpdateItem on the link, conditional on ``status = "connected"`` and the ``connectedAt`` the read began
        with (a Stop or a reconnect meanwhile wins)."""
        fields = {**sets, "updatedAt": iso(self.now)}
        gone = [r for r in dict.fromkeys(remove) if r not in fields and not (failing and r == "failingSince")]
        names = {f"#s{i}": k for i, k in enumerate(fields)} | {f"#r{i}": k for i, k in enumerate(gone)}
        values = {f":s{i}": v for i, v in enumerate(fields.values())}
        parts = [f"#s{i} = :s{i}" for i in range(len(fields))]
        if failing:
            names["#fs"] = "failingSince"
            values[":fs"] = iso(self.now)
            parts.append("#fs = if_not_exists(#fs, :fs)")
        names.update({"#cst": "status", "#cca": "connectedAt"})
        values.update({":cst": STATUS_CONNECTED, ":cca": link.get("connectedAt")})
        update = "SET " + ", ".join(parts)
        if gone:
            update += " REMOVE " + ", ".join(f"#r{i}" for i in range(len(gone)))
        try:
            self.store.update_expr(
                self.pk,
                str(link["sk"]),
                update,
                condition="attribute_exists(pk) AND #cst = :cst AND #cca = :cca",
                names=names,
                values=values,
            )
        except db.ConditionFailed:
            log("info", "bank.link_changed", link=str(link.get("linkId") or ""))
            return False
        return True

    def key_wrong(self) -> None:
        """``BANKCONN.app.check`` becomes ``key_wrong`` (§40.5.6): Enable Banking no longer knows the bank key."""
        if self.key_wrong_written:
            return
        self.key_wrong_written = True
        try:
            self.store.update_expr(
                self.pk,
                BANKCONN_SK,
                "SET #a.#c = :c",
                condition="attribute_exists(#a)",
                names={"#a": "app", "#c": "check"},
                values={":c": {"code": "key_wrong", "at": iso(self.now)}},
            )
        except db.ConditionFailed:
            return

    # --- one link ------------------------------------------------------------------------------------------------

    def session_secret(self, link: Mapping[str, Any]) -> dict[str, Any] | None:
        """The link's session, read fresh; only the secret whose ``connectedAt`` equals the link's counts (read once
        more, else this link is skipped and nothing changes)."""
        name = token_secret(self.deps.secrets.prefix, str(link.get("linkId") or ""))
        for _ in range(2):
            secret = self.deps.secrets.read(name, fresh=True)
            if (
                secret
                and isinstance(secret.get("sessionId"), str)
                and secret.get("connectedAt") == link.get("connectedAt")
            ):
                return secret
        log("warning", "bank.stale_secret", link=str(link.get("linkId") or ""))
        return None

    def plan(self, link: Mapping[str, Any]) -> Plan | None:
        """Which strategy and days this read uses, and whether it is attended. None: the rolling 24 hours are used up."""
        first = not link.get("firstReadDone")
        connected = parse(link.get("connectedAt"))
        in_hour = connected is not None and timedelta(0) <= self.now - connected <= HISTORY_HOUR
        through = _as_day(link.get("readThrough"))
        today = self.today
        headers = eb.psu_headers(link.get("psuHeaders") or [], self.psu, self.referer)
        resume = link.get("resume") if isinstance(link.get("resume"), Mapping) else None
        floor = None
        plan_from: str
        plan_to: str | None
        start, continuation = 0, None
        if resume and resume.get("strategy") in (LONGEST, DEFAULT) and isinstance(resume.get("dateFrom"), str):
            strategy = str(resume["strategy"])
            plan_from = str(resume["dateFrom"])
            plan_to = resume.get("dateTo") if isinstance(resume.get("dateTo"), str) else None
            start = max(0, _int(resume.get("account")) or 0)
            key = resume.get("continuationKey")
            continuation = key if isinstance(key, str) and key else None
            if strategy == LONGEST and not self.mine:
                # Never longest without him: that account starts again with default from today - 89 days.
                strategy, plan_from, plan_to, continuation = (
                    DEFAULT,
                    _day_minus(today, DEFAULT_DAYS),
                    today.isoformat(),
                    None,
                )
                floor = plan_from
        elif first and self.mine:
            strategy, plan_from, plan_to = LONGEST, _day_minus(today, FIRST_DAYS), None
        elif self.mine and link.get("historyWanted") and in_hour and through is not None:
            strategy, plan_from, plan_to = LONGEST, _day_minus(through, OVERLAP_DAYS), None
        elif first:
            strategy, plan_from, plan_to = DEFAULT, _day_minus(today, DEFAULT_DAYS), today.isoformat()
        else:
            oldest = _day_minus(today, DEFAULT_DAYS)
            plan_from = max(_day_minus(through, OVERLAP_DAYS), oldest) if through is not None else oldest
            strategy, plan_to = DEFAULT, today.isoformat()
        cost = 2 if strategy == LONGEST and headers is None else 1
        if headers is None and not eb.may_read_unattended(link.get("reads"), self.now, cost):
            return None
        return Plan(strategy, plan_from, plan_to, headers, cost, start, continuation, floor)

    def read_accounts(self, uids: list[str], plan: Plan, read: LinkRead) -> None:
        """Each account's booked transactions, page by page; ``read.finished`` once every account is done."""
        for index in range(plan.start, len(uids)):
            if index > plan.start and self.deps.remaining() < MIN_SECONDS_LEFT:
                read.resume = {"account": index, "strategy": plan.strategy, "dateFrom": plan.date_from}
                if plan.date_to:
                    read.resume["dateTo"] = plan.date_to
                return
            account = Account(
                index=index,
                uid=uids[index],
                strategy=plan.strategy,
                date_from=plan.date_from,
                date_to=plan.date_to,
                key=plan.continuation if index == plan.start else None,
                filter=Filter(read.hash_key, read.link_id, self.today),
            )
            account.from_resume = account.key is not None
            if not self.read_account(account, read):
                return
        read.finished = True

    def _restart(self, account: Account, read: LinkRead) -> None:
        """That account starts again with ``strategy=default`` from today - 89 days."""
        account.strategy, account.date_from = DEFAULT, _day_minus(self.today, DEFAULT_DAYS)
        account.date_to = self.today.isoformat()
        account.key, account.from_resume, account.found = None, False, []
        account.filter = Filter(read.hash_key, read.link_id, self.today)

    def _retry(self, kind: str, account: Account, read: LinkRead) -> bool:
        """The errors that get one more try (§40.5.6): True when the account is read again."""
        if kind == eb.PERIOD and not account.retried:
            account.retried = True
            self._restart(account, read)
            return True
        if kind == eb.CONTINUATION and account.from_resume and not account.retried:
            account.retried = True
            self._restart(account, read)
            read.floor = account.date_from
            return True
        if kind == eb.PSU_HEADER and read.headers is not None and not read.psu_retried:
            read.psu_retried = True
            read.headers = None
            cost = 2 if account.strategy == LONGEST else 1
            if eb.may_read_unattended(read.reads, self.now, cost):
                read.reads = eb.record_read(read.reads, self.now, attended=False, cost=cost)
                account.key, account.from_resume, account.found = None, False, []
                account.filter = Filter(read.hash_key, read.link_id, self.today)
                return True
        return False

    def read_account(self, account: Account, read: LinkRead) -> bool:
        """One account, every page with the same parameters until ``continuation_key`` is null. False: the link's read
        stops here (an error, or out of time with ``resume`` kept)."""
        while True:
            params = {"transaction_status": "BOOK", "date_from": account.date_from, "strategy": account.strategy}
            if account.date_to:
                params["date_to"] = account.date_to
            if account.key:
                params["continuation_key"] = account.key
            read.called = True
            try:
                rows, next_key = read.client.transactions(account.uid, params, read.headers)
            except eb.BankError as e:
                kind = eb.outcome(e)
                log("warning", "bank.error", link=read.link_id, code=e.code or "HTTP", status=e.status, kind=kind)
                if kind == eb.ACCOUNT:
                    read.account_skipped = True
                    break
                if self._retry(kind, account, read):
                    continue
                read.candidates.extend(account.found)
                read.outcome, read.error = (eb.DOWN if kind == eb.PSU_HEADER else kind), e
                return False
            read.pages += 1
            read.seen += len(rows)
            account.pages += 1
            for row in rows:
                day = any_day(row)
                if day is not None and (read.oldest is None or day < read.oldest):
                    read.oldest = day
                candidate = account.filter.add(row)
                if candidate is not None:
                    account.found.append(candidate)
            if not next_key:
                break  # an empty page with a key still goes on
            account.key = next_key
            if self.deps.remaining() < MIN_SECONDS_LEFT or account.pages >= MAX_PAGES:
                read.candidates.extend(account.found)
                read.resume = {
                    "account": account.index,
                    "strategy": account.strategy,
                    "dateFrom": account.date_from,
                    "continuationKey": next_key,
                }
                if account.date_to:
                    read.resume["dateTo"] = account.date_to
                return False
        read.candidates.extend(account.found)
        return True

    def end(self, link: Mapping[str, Any], kind: str) -> None:
        """The session ended (§40.5.6): ``ended`` (``consent_over`` within a day of ``consentUntil``, else
        ``ended_early``) or ``stopped_at_bank``. An end never deletes a deposit."""
        sets: dict[str, Any] = {"endedAt": iso(self.now)}
        remove = ["resume"]
        if kind == eb.END_REVOKED:
            sets["status"] = STATUS_STOPPED_AT_BANK
            remove.append("reason")
        else:
            until = parse(link.get("consentUntil"))
            over = kind == eb.END_EXPIRED and until is not None and self.now >= until - timedelta(days=1)
            sets["status"] = STATUS_ENDED
            sets["reason"] = REASON_CONSENT_OVER if over else REASON_ENDED_EARLY
        if self.update_link(link, sets, remove):
            self.notice.ended.append(
                {
                    "linkId": str(link.get("linkId") or ""),
                    "bank": str(link.get("bank") or ""),
                    "endedAt": sets["endedAt"],
                }
            )

    def read_link(self, link: dict[str, Any], links: list[dict[str, Any]], token: str, hash_key: bytes) -> bool:
        """One link's read; True when it reached the bank (so rule 9 already ran)."""
        link_id = str(link.get("linkId") or "")
        bank = str(link.get("bank") or "your bank")
        limit = parse(link.get("limitUntil"))
        if limit is not None and limit > self.now:
            log("info", "bank.limited", link=link_id)
            return False
        secret = self.session_secret(link)
        if secret is None:
            return False
        plan = self.plan(link)
        if plan is None:
            log("info", "bank.read_limit", link=link_id)
            self.update_link(link, {"lastError": LIMIT_HIT.format(bank=bank)})
            return False
        first = not link.get("firstReadDone")
        raw_reads = link.get("reads")
        reads: dict[str, Any] = dict(raw_reads) if isinstance(raw_reads, Mapping) else {}
        client = eb.Client(self.deps.http, token)
        read = LinkRead(client, hash_key, link_id, headers=plan.headers, reads=reads, floor=plan.floor)
        session: dict[str, Any] = {}
        ending = None
        try:
            session = client.session(str(secret["sessionId"]))
            ending = eb.session_outcome(session)
        except eb.BankError as e:
            read.outcome, read.error = eb.outcome(e), e
            log("warning", "bank.error", link=link_id, code=e.code or "HTTP", status=e.status, kind=read.outcome)
        if ending is not None:
            read.outcome = ending
        elif read.outcome is None:
            allowed = set(eb.session_accounts(session))
            uids = [
                str(a["uid"])
                for a in secret.get("accounts") or []
                if isinstance(a, Mapping) and isinstance(a.get("uid"), str) and a["uid"] in allowed
            ]
            if uids:
                read.reads = eb.record_read(read.reads, self.now, attended=plan.headers is not None, cost=plan.cost)
                self.read_accounts(uids, plan, read)
            else:  # the session shares none of the link's accounts: nothing is read, and nothing moves on
                read.outcome = eb.ACCOUNT
        self.counts["links"] += 1
        written = {"matched": 0, "asked": 0, "dropped": 0, "kept": 0}
        if read.candidates or read.called:
            written = self.write(read.candidates, links, quiet=first)
        for name in ("matched", "asked", "dropped"):
            self.counts[name] += written[name]
        log(
            "info",
            "bank.read",
            link=link_id,
            pages=read.pages,
            seen=read.seen,
            kept=len(read.candidates),
            asked=written["asked"],
            matched=written["matched"],
            dropped=written["dropped"],
            finished=read.finished,
        )
        self.after(link, read, plan, first, bank)
        return read.called

    def after(self, link: Mapping[str, Any], read: LinkRead, plan: Plan, first: bool, bank: str) -> None:
        """The link's read state from this read (§40.5.6 "then update the BANKLINK#" and "Ends and errors")."""
        if read.outcome in eb.ENDS:
            self.end(link, read.outcome)
        elif read.outcome is None:
            self._after_read(link, read, plan, first, bank)
        else:
            self._after_error(link, read, bank)

    def _history_from(self, link: Mapping[str, Any], read: LinkRead, plan: Plan) -> str | None:
        """The first read's ``historyFrom``: the oldest booking date the bank returned on the link (over any row), or
        ``date_from`` when nothing came back; never earlier than a restart from today - 89 days."""
        oldest = read.oldest
        stored = link.get("historyFrom") if isinstance(link.get("historyFrom"), str) else None
        if stored and (oldest is None or stored < oldest):
            oldest = stored
        if oldest is None and read.finished:
            oldest = plan.date_from
        if oldest is not None and read.floor is not None and oldest < read.floor:
            oldest = read.floor
        return oldest

    def _after_read(self, link: Mapping[str, Any], read: LinkRead, plan: Plan, first: bool, bank: str) -> None:
        sets: dict[str, Any] = {"lastReadAt": iso(self.now)}
        remove: list[str] = []
        if read.called:
            sets["reads"] = read.reads
        history = bool(link.get("historyWanted"))
        connected = parse(link.get("connectedAt"))
        hour_over = connected is None or self.now - connected > HISTORY_HOUR
        if first and (since := self._history_from(link, read, plan)) is not None:
            sets["historyFrom"] = since
        if read.finished:
            sets["readThrough"] = self.today.isoformat()
            sets["firstReadDone"] = True
            remove += ["reason", "resume", "failingSince", "limitUntil"]
            if read.account_skipped:
                sets["lastError"] = ACCOUNT_SKIPPED.format(bank=bank)
            else:
                remove.append("lastError")
            if history and (plan.strategy == LONGEST or hour_over):
                remove.append("historyWanted")
        else:
            sets["resume"] = read.resume or {}
            if history and hour_over:
                remove.append("historyWanted")
        self.update_link(link, sets, remove)

    def _after_error(self, link: Mapping[str, Any], read: LinkRead, bank: str) -> None:
        kind = read.outcome or eb.DOWN
        sets: dict[str, Any] = {"reads": read.reads} if read.called else {}
        failing = True
        if kind == eb.PSU_ACTION:
            sets["reason"] = REASON_PSU_ACTION
            failing = False
        elif kind == eb.ASPSP_LIMIT and read.error is not None:
            sets["limitUntil"] = eb.limit_until(kind, read.error, self.now)
            sets["lastError"] = WAIT.format(bank=bank)
            failing = False
        elif kind == eb.EB_LIMIT and read.error is not None:
            sets["limitUntil"] = eb.limit_until(kind, read.error, self.now)
            sets["lastError"] = DOWN.format(bank=bank)
        elif kind == eb.KEY:
            self.key_wrong()
            sets["lastError"] = KEY_WRONG
        elif kind == eb.ACCOUNT:
            sets["lastError"] = ACCOUNT_SKIPPED.format(bank=bank)
        else:
            sets["lastError"] = DOWN.format(bank=bank)
        self.update_link(link, sets, failing=failing)

    # --- the run -------------------------------------------------------------------------------------------------

    def expiry(self, links: list[dict[str, Any]]) -> None:
        """Every connected link with 7 days or less to ``consentUntil`` and ``warnedFor`` ≠ ``consentUntil`` goes into
        the notice and gets ``warnedFor = consentUntil``."""
        for link in links:
            until = parse(link.get("consentUntil"))
            if (
                link.get("status") != STATUS_CONNECTED
                or until is None
                or link.get("warnedFor") == link.get("consentUntil")
            ):
                continue
            left = (until - self.now).total_seconds()
            if not 0 < left <= EXPIRY_NOTICE_DAYS * 86400:
                continue
            if self.update_link(link, {"warnedFor": link["consentUntil"]}):
                self.notice.expiring.append(
                    {
                        "linkId": str(link.get("linkId") or ""),
                        "bank": str(link.get("bank") or ""),
                        "days": max(1, math.ceil(left / 86400)),
                        "consentUntil": str(link["consentUntil"]),
                    }
                )

    def run(self, links: list[dict[str, Any]]) -> str:
        connected = [li for li in links if li.get("status") == STATUS_CONNECTED]
        app = (self.deps.secrets.read(app_secret(self.deps.secrets.prefix), fresh=True) or {}) if connected else {}
        app_id, pem = app.get("appId"), app.get("privateKeyPem")
        try:
            hash_key = base64.b64decode(str(app.get("hashKey") or ""), validate=True)
        except (binascii.Error, ValueError):
            hash_key = b""
        token = ""
        if isinstance(app_id, str) and app_id and isinstance(pem, str) and pem and len(hash_key) >= 16:
            try:
                token = eb.jwt(app_id, pem, self.now)
            except (ValueError, TypeError) as e:
                log("error", "bank.bad_key", error=type(e).__name__)
        elif connected:
            log("warning", "bank.no_app")
        read_any = False
        ended: set[str] = set()
        if token:
            for link in sorted(connected, key=lambda li: str(li.get("linkId") or "")):
                if self.deps.remaining() < MIN_SECONDS_LEFT:
                    log("warning", "bank.time_budget", link=str(link.get("linkId") or ""))
                    break
                before = len(self.notice.ended)
                read_any = self.read_link(link, links, token, hash_key) or read_any
                if len(self.notice.ended) > before:
                    ended.add(str(link.get("linkId") or ""))
        if not read_any:
            self.write([], links, quiet=False)  # rule 9: stored questions match a payout that appeared since
        self.expiry([li for li in links if str(li.get("linkId") or "") not in ended])
        return "read" if read_any else "nothing_read"


def run(
    deps: Any,
    user_id: str,
    now: datetime,
    *,
    psu: Mapping[str, Any] | None = None,
    mine: bool = False,
    remaining: Any = None,
) -> dict[str, Any]:
    """One owner's bank read. Returns a summary of counts (``result``: what happened)."""
    bank = deps if isinstance(deps, BankReadDeps) else from_money(deps, remaining)
    if bank is None:
        return {"result": "no_secrets"}
    if not bank.on:
        return {"result": "off"}
    pk = db.user_pk(user_id)
    links = [dict(i) for i in bank.store.query_all(pk, BANKLINK_PREFIX) if isinstance(i.get("linkId"), str)]
    if not links:
        return {"result": "no_link"}
    if bank.remaining() < MIN_SECONDS_LEFT:
        log("warning", "bank.time_budget")
        return {"result": "out_of_time"}
    reader = Reader(bank, user_id, now, psu=psu, mine=mine)
    lease = reader.claim()
    if lease is None:
        log("info", "bank.read_busy")
        return {"result": "busy"}
    try:
        result = reader.run(links)
    except Forgotten:
        result = "forgotten"
    finally:
        reader.finish(lease)
    log("info", "bank.run", result=result, **reader.counts)
    return {"result": result, **reader.counts}
