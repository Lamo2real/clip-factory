"""Your bank, the reading side: what ``cf-prod-money`` reads from Enable Banking (docs/CONTRACTS.md §40.5.6-§40.5.8,
§40.5.11; ADR-82).

The owner chose option A on 22 Nov 2026: his own Enable Banking app in restricted mode, linking only his own personal
accounts with BankID. The API side (``bank/``, builder BA) makes the key, the links and the answers; this package only
reads booked credits, keeps the ones that are app money, and says what changed:

* ``client``: the JWT of §40.5.4, the calls (``GET /sessions/{id}``, ``GET /accounts/{uid}/transactions``), the PSU
  headers (all or none), the rolling 24 hours of unattended reads, and Enable Banking's error codes, typed.
* ``filter``: one transaction in memory → a candidate or nothing (``CRDT`` + ``BOOK`` only, the amount in minor units,
  the hint, ``payerKey`` and ``depositId`` as keyed hashes). No other field of the bank's answer is ever read.
* ``match``: the pure matching rules of §40.5.8, in their order.
* ``collect``: one owner's read (the daily run and his own bank Check now), under ``BANKCONN.readLease``.

Least data (§40.5.7): a ``DEPOSIT#`` keeps only the attributes below; no name, account number, IBAN, text, balance,
debit or other payment is ever stored, cached or logged. Logs carry counts and Enable Banking's error code only.

Item keys and shapes are written from §40.5.11 (the API builder's ``bank_items.json`` is compared with them when it
is there). Every write here is an UpdateItem or a conditional PutItem; nothing here deletes an item (the money role has
no DeleteItem) or writes a secret.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .. import db
from ..clock import Clock, utcnow
from ..oauth.secrets import Secrets
from ..platforms.base import HttpClient

# --- item keys (§40.5.11) ------------------------------------------------------------------------------------------

BANKOWNER = "BANKOWNER"  # pk and sk: the one owner who may use Your bank (written by the API only)
BANKCONN_SK = "BANKCONN"
BANKLINK_PREFIX = "BANKLINK#"
DEPOSIT_PREFIX = "DEPOSIT#"
BANKPAYERS_SK = "BANKPAYERS"
NOTIFIED_PREFIX = "NOTIFIED#getpaid#bank:"


def banklink_sk(link_id: str) -> str:
    return f"{BANKLINK_PREFIX}{link_id}"


def deposit_sk(day: str, deposit_id: str) -> str:
    return f"{DEPOSIT_PREFIX}{day}#{deposit_id}"


def app_secret(prefix: str) -> str:
    """``cf-prod/platforms/bank/app``: the private key, the app ID and ``hashKey`` (made by the API)."""
    return f"{prefix}bank/app"


def token_secret(prefix: str, link_id: str) -> str:
    """``cf-prod/platforms/bank/token_{linkId}``: one bank link's session. An underscore, never a dash, so the
    ``*/token-*`` write grant of money, clip-flow and stats never matches it (§40.5.11)."""
    return f"{prefix}bank/token_{link_id}"


# --- item attributes (every attribute there is, §40.5.7 and §40.5.11) ---------------------------------------------

KEYS = frozenset({"pk", "sk"})
BANKCONN_ATTRS = frozenset(
    {
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
    }
)
# What the reader writes on BANKCONN: its lease, the run's notice and time (§40.5.11), and ``app.check`` when Enable
# Banking no longer knows the key (§40.5.6, the ``UNAUTHORIZED_ACCESS`` row).
BANKCONN_READER_WRITES = frozenset({"readLease", "lastNotice", "lastRunAt", "app"})
BANKLINK_ATTRS = frozenset(
    {
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
    }
)
# The read state and the ends (the only BANKLINK# attributes the reader ever sets or removes).
BANKLINK_READER_WRITES = frozenset(
    {
        "status",
        "reason",
        "historyWanted",
        "firstReadDone",
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
        "updatedAt",
    }
)
DEPOSIT_MATCHED_ATTRS = frozenset(
    {
        "type",
        "state",
        "depositId",
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
    }
)
DEPOSIT_NEEDS_YOU_ATTRS = (DEPOSIT_MATCHED_ATTRS - {"place", "how", "payoutRef", "payoutDate"}) | {
    "suggested",
    "kind",
    "hint",
    "hintFrom",
    "shared",
    "notSure",
    "ttl",
}
DEPOSIT_NOT_INCOME_ATTRS = frozenset({"type", "state", "depositId", "date", "linkId", "why", "ttl"})
BANKPAYERS_ATTRS = frozenset({"type", "rules", "notIncome", "updatedAt"})
DEPOSIT_STATES = ("matched", "needs_you", "not_income")

# --- places, hints and words ----------------------------------------------------------------------------------

YOUTUBE = "youtube"
CONTENT_REWARDS = "contentrewards"
META = "meta"
PLACES = ("youtube", "tiktok", "instagram", "facebook", "meta", "x", "contentrewards")
PLACE_NAMES = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "meta": "Meta (Instagram and Facebook)",
    "x": "X",
    "contentrewards": "Content Rewards (Whop)",
}
SOURCE = "enable_banking"
PAYPAL = "PayPal"  # Enable Banking's name for PayPal's "bank" (a link whose ``bank`` is this is a PayPal link)

STATUS_CONNECTED = "connected"
STATUS_ENDED = "ended"
STATUS_STOPPED_AT_BANK = "stopped_at_bank"
REASON_CONSENT_OVER = "consent_over"
REASON_ENDED_EARLY = "ended_early"
REASON_PSU_ACTION = "psu_action"

# ``lastError`` on a link (§40.5.6), with the bank's own name for {bank}.
LIMIT_HIT = "Clip Factory looked at {bank} 3 times in a day. It looks again later."
WAIT = "{bank} asked Clip Factory to wait. It looks again later."
DOWN = "{bank} didn't answer. Clip Factory tries again tomorrow."
ACCOUNT_SKIPPED = "{bank} didn't share one of your accounts today."
KEY_WRONG = "Enable Banking didn't know your bank key. Tap Check again in step 5."

# §40.5.6: the read stops after a whole page when less than this is left; the money run skips the bank below it too.
MIN_SECONDS_LEFT = 20.0
LEASE_SECONDS = 300
EXPIRY_NOTICE_DAYS = 7
NOTICE_REACHED_MAX = 3
NEEDS_YOU_TTL_DAYS = 180
REFERER_PATH = "/settings/posting/getpaid/bank"


# --- what a read needs ---------------------------------------------------------------------------------------------


@dataclass
class BankReadDeps:
    """The table, the platform secrets (``cf-prod/platforms/*``, always read fresh), HTTP, the clock, the seconds left
    of the money run's time budget, the app's address (for the ``psu-referer`` header) and whether Content Rewards is
    on (a ``whop`` hint suggests Content Rewards only then)."""

    store: db.Store
    secrets: Secrets
    http: HttpClient
    clock: Clock = utcnow
    remaining: Callable[[], float] = field(default=lambda: 900.0)
    app_url: str = ""
    content_rewards: bool = False
    on: bool = True  # BANK_READING: off, nothing is read (stored items stay)


def from_money(deps: Any, remaining: Callable[[], float] | None = None) -> BankReadDeps | None:
    """The bank deps of a ``MoneyDeps``: the same table, HTTP client and clock, and the platform secrets of its token
    provider (``SecretsTokenProvider.env.secrets``). None without secrets (nothing can be read)."""
    secrets = getattr(getattr(deps.tokens, "env", None), "secrets", None)
    if secrets is None:
        return None
    out = BankReadDeps(
        store=deps.store,
        secrets=secrets,
        http=deps.http,
        clock=deps.clock,
        app_url=str(getattr(deps, "app_url", "") or ""),
        content_rewards=bool(getattr(deps, "content_rewards", False)),
        on=bool(getattr(deps, "bank_reading", False)),
    )
    if remaining is not None:
        out.remaining = remaining
    return out


def env_flag(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() == "on"
