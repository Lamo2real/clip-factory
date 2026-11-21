"""Real earnings: paid-programme progress and platform-reported money (docs/CONTRACTS.md §25, ADR-47).

The rule: Clip Factory shows only money a platform's API reported about the owner's account. It never calculates,
guesses, converts or accepts typed-in money. Every money figure is labelled as that platform's estimate (every API
number is one: YouTube's ``estimatedRevenue``, Meta's earnings metrics). Paid-out money lives on the platform's own
payout page, which the app links to, except what AdSense ``payments`` and Whop ``payouts`` report as sent toward the
bank: "Sent to your bank by Google/Whop" (§40.4, ``getpaid.sent``).

* ``rules``: ``config/monetization.json`` (goals with official sources, countries, labels).
* ``sources``: the platform reads (YouTube Data and Analytics, Meta Graph, TikTok, X), through the shared token
  provider (its lease protects rotating refresh tokens) and the shared rate budgets.
* ``collect``: one owner's daily run: account snapshots, the money state, revenue rows and celebrations.
* ``view``: the public shapes of ``GET /v1/money`` and the per-clip and per-week money.
* ``handler``: Lambda ``cf-prod-money`` (a daily EventBridge run and the "Check now" refresh).

Items (all under ``pk USER#{userId}``, new sort keys only, nothing existing changes):

* ``ACCTSTAT#{platform}#{yyyy-mm-dd}``: one account snapshot a day (``ttl`` after 800 days).
* ``MONEYSTATE#{platform}``: state, write-once ``detectedAt``/``earningSince``, numbers, celebrations.
* ``REVENUE#{platform}#{yyyy-mm-dd}``: one day of platform-reported money (``amountMicros``, ``currency``, ``unit``,
  ``source``, ``estimate: true``, ``fetchedAt``, ``revisedAt`` when a later read changed it). Permanent.
* ``MONEYPREFS``: the owner's country (a preference, not data) and the "Check now" claim.

And one registry item per owner, ``pk MONEYOWNERS`` / ``sk USER#{userId}``, so the daily run finds owners with a
Query (never a Scan).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .. import db
from ..clock import iso
from ..stats import STATS_ORDER

MONEY_ORDER: tuple[str, ...] = STATS_ORDER
LABELS = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram", "facebook": "Facebook", "x": "X"}
OWNERS_PK = "MONEYOWNERS"
PREFS_SK = "MONEYPREFS"
ACCTSTAT_TTL_DAYS = 800
MICROS = 1_000_000

# The states a platform card can be in (§25.1). They never move down by themselves: see ``collect.RANK``.
STATES = (
    "earning",
    "in_program",
    "goal_reached",
    "not_yet",
    "counting",
    "unknown",
    "needs_permission",
    "not_available",
    "not_connected",
    "error",
)


def label(platform: str) -> str:
    return LABELS.get(platform, platform)


def state_sk(platform: str) -> str:
    return f"MONEYSTATE#{platform}"


def acctstat_sk(platform: str, day: str) -> str:
    return f"ACCTSTAT#{platform}#{day}"


def acctstat_prefix(platform: str) -> str:
    return f"ACCTSTAT#{platform}#"


def revenue_sk(platform: str, day: str) -> str:
    return f"REVENUE#{platform}#{day}"


def revenue_prefix(platform: str) -> str:
    return f"REVENUE#{platform}#"


def owner_sk(user_id: str) -> str:
    return f"USER#{user_id}"


def register_owner(store: db.Store, user_id: str, now: datetime) -> None:
    """Puts the owner on the daily run's list (one Query of ``MONEYOWNERS`` finds them; never a Scan)."""
    try:
        store.put(
            {"pk": OWNERS_PK, "sk": owner_sk(user_id), "type": "moneyowner", "userId": user_id, "since": iso(now)},
            if_absent=True,
        )
    except db.ConditionFailed:
        return


def owners(store: db.Store) -> list[str]:
    return [str(i["userId"]) for i in store.query_all(OWNERS_PK, "USER#") if isinstance(i.get("userId"), str)]


def get_prefs(store: db.Store, user_id: str) -> dict[str, Any]:
    return store.get(db.user_pk(user_id), PREFS_SK) or {}


def forget_platform(store: db.Store, user_id: str, platform: str) -> int:
    """§25.6 ``forget`` (explicit YouTube Disconnect only): the account snapshots, reported money and money state read
    from that platform. Run by ``cf-prod-stats``, which also clears each Post's ``revenue``."""
    pk = db.user_pk(user_id)
    gone = 0
    for prefix in (acctstat_prefix(platform), revenue_prefix(platform)):
        for item in store.query_all(pk, prefix):
            store.delete(pk, str(item["sk"]))
            gone += 1
    if store.get(pk, state_sk(platform)) is not None:
        store.delete(pk, state_sk(platform))
        gone += 1
    return gone
