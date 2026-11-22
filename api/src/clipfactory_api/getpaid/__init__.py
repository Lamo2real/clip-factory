"""Get paid: payout steps per place, an honest status, and money sent toward the bank (docs/CONTRACTS.md §40, ADR-64).

* ``status``: the step lists the server knows (``STEPS``), ``card(place, inputs, now)`` (pure: one ``GetPaidCard``)
  and the summary sentence.
* ``sent``: ``parse_amount`` (Google's formatted amounts), ``sent_line`` (one place's "Sent to your bank" line),
  ``sent_totals`` (the "Sent to your bank, so far" block) and the place page's payout rows. Pure.
* ``view``: ``load`` (``GET /v1/getpaid``) and ``place`` (``GET /v1/getpaid/{place}``) from stored items only.
* ``grants``: "Allow payment reading" (the AdSense grant) and "Connect Whop" (Whop's sign-in), run by the callback.

The rule of §25 holds: only money Google or Whop reported, never calculated, guessed, converted or typed in. Clip
Factory never asks for or stores bank, card or tax numbers. Items (all under ``pk USER#{userId}``, new sort keys
only): ``GETPAID`` (his ticks), ``PAYCONN#adsense`` / ``PAYCONN#whop`` (the two reading connections),
``PAYSTATE#youtube`` / ``PAYSTATE#contentrewards`` and ``PAYOUT#{place}#…`` (written by ``cf-prod-money``).
"""

from __future__ import annotations

from ..stats import STATS_ORDER

CR = "contentrewards"
PLACES: tuple[str, ...] = (*STATS_ORDER, CR)
NAMES = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "x": "X",
    CR: "Content Rewards",
}
GETPAID_SK = "GETPAID"
ADSENSE = "adsense"
WHOP = "whop"
SOURCES = (ADSENSE, WHOP)
# The reading connection each place can have (YouTube: AdSense for YouTube; Content Rewards: Whop).
SOURCE_OF = {"youtube": ADSENSE, CR: WHOP}
MAX_TICKS = 80
MAX_PAYOUT_ROWS = 36
# Every call to Whop's API carries this header (its payout statuses ``in_review`` and ``denied`` need 2026-08-21+).
WHOP_API_VERSION = "2026-11-20"
ADSENSE_SCOPE = "https://www.googleapis.com/auth/adsense.readonly"
WHOP_SCOPES: tuple[str, ...] = (
    "user:balance:read",
    "payout:withdrawal:read",
    "payout:destination:read",
    "identity:read",
)
BANK_TEXT = "Clip Factory can't see your bank. Look in your bank's app to see what arrived."


def name(place: str) -> str:
    return NAMES.get(place, place)


def payconn_sk(source: str) -> str:
    return f"PAYCONN#{source}"


def paystate_sk(place: str) -> str:
    return f"PAYSTATE#{place}"


def payout_prefix(place: str) -> str:
    return f"PAYOUT#{place}#"


PAYCONN_PREFIX = "PAYCONN#"
PAYSTATE_PREFIX = "PAYSTATE#"
PAYOUT_PREFIX = "PAYOUT#"
