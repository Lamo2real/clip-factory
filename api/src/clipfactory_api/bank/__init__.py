"""Your bank: what really reached it, read through Enable Banking (docs/CONTRACTS.md §40.5, ADR-82; builder BA).

Everything sits behind the api switch ``BANK_READING`` (``App.bank_reading``, default off). The API side lives here:

* ``keys``: "Make my bank key" (an RSA-4096 pair and a 10-year self-signed certificate, straight into Secrets
  Manager), "Save" (the app ID, or the .pem file of Enable Banking's default path) and ``BANKOWNER``.
* ``eb``: Enable Banking's setup calls (the JWT, ``GET /application``, ``GET /aspsps``, ``POST /auth``,
  ``POST /sessions``, ``DELETE /sessions``), each inside a deadline, with typed errors that never hold an answer body.
* ``grants``: the bank list, Connect, the BankID callback (run by ``cf-prod-hooks``), closing old sessions, Stop and
  Forget.
* ``view``: ``BankView`` (pure, golden cases) and ``load`` (stored items only).
* ``answers``: his taps on the question cards and on "Not from YouTube?".

Reading the bank (``bankread/``, ``cf-prod-money``) is builder BR's: the two sides meet only through the items, the
secrets and the golden files. Items (under ``pk USER#{userId}``, new sort keys only): ``BANKCONN``,
``BANKLINK#{linkId}``, ``DEPOSIT#{yyyy-mm-dd}#{depositId}`` and ``BANKPAYERS``; one registry item, ``BANKOWNER``.
Secrets (runtime-made, tags ``app=cf-prod``, ``platform=bank``): ``cf-prod/platforms/bank/app`` and
``cf-prod/platforms/bank/token_{linkId}``. Clip Factory never asks for, sees or stores a bank login, an account
number, an IBAN or a name.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..getpaid import BANK_TEXT, CR

__all__ = ["BANK_TEXT"]

# --- items --------------------------------------------------------------------------------------------------------

OWNER_PK = "BANKOWNER"
OWNER_SK = "BANKOWNER"
CONN_SK = "BANKCONN"
LINK_PREFIX = "BANKLINK#"
DEPOSIT_PREFIX = "DEPOSIT#"
PAYERS_SK = "BANKPAYERS"
SOURCE = "enable_banking"  # a deposit's ``source`` (a bank file, option B, could fill the same rows later)


def link_sk(link_id: str) -> str:
    return f"{LINK_PREFIX}{link_id}"


def deposit_sk(day: str, deposit_id: str) -> str:
    return f"{DEPOSIT_PREFIX}{day}#{deposit_id}"


# --- secrets ------------------------------------------------------------------------------------------------------

PLATFORM = "bank"  # the callback's platform (``/oauth/bank/callback``) and the secrets' ``platform`` tag
APP_SECRET = "bank/app"  # noqa: S105 (a secret's name, not a secret)


def app_secret(prefix: str) -> str:
    return f"{prefix}{APP_SECRET}"


def token_secret(prefix: str, link_id: str) -> str:
    """An underscore, never a dash: the ``*/token-*`` write grant of money, clip-flow and stats never matches it."""
    return f"{prefix}bank/token_{link_id}"


# --- Enable Banking -----------------------------------------------------------------------------------------------

EB_HOST = "https://api.enablebanking.com"  # the deprecated api.tilisy.com is never used
EB_ISSUER = "enablebanking.com"
EB_AUDIENCE = "api.enablebanking.com"
ASK_TO = "support.api@enablebanking.com"
ASK_SUBJECT = "Personal use: my own creator income on my own account"
ASK_BODY = (
    "Hello,\n\n"
    "I'm a private person in Sweden. I made a restricted Production application in your Control Panel, linked only "
    "to my own personal accounts.\n\n"
    "I post short videos. YouTube, TikTok, Meta, X and Whop sometimes pay small amounts into my personal bank account "
    "or PayPal. I want my own app to read my booked incoming payments once a day, keep only the ones from those "
    "platforms, and show me the totals. Nobody else uses it, and I don't share, sell or offer it to anyone.\n\n"
    "Does this count as personal use of private individuals under your Terms? Is one automatic read a day, plus a "
    "read when I tap a button, fine?\n\n"
    "Thank you!"
)
APP_NAME = "Clip Factory"
APP_DESCRIPTION = "Shows me which of my app payouts reached my own bank account."

# --- limits -------------------------------------------------------------------------------------------------------

MAX_BANKS = 4
MAX_STEPS_DONE = 10
MAX_CLOSE_LATER = 3
MAX_ASKS = 20
MAX_ROWS = 36
MAX_RULES = 50
MAX_NOT_INCOME = 100
MAX_BANK_NAME = 60
ROUTE_SECONDS = 25.0  # API Gateway waits 29 s; cf-prod-hooks stops at 28 s
CLOSE_SECONDS = 5.0  # GET /v1/getpaid/bank spends at most this on closing old sessions
ASK_DAYS = 180  # a needs_you row's ttl, from the later of its booking and fetch days
NOT_INCOME_DAYS = 400
CHECK_EVERY_MINUTES = 15
CHECKS_PER_DAY = 12
LAST_CONNECT_HOURS = 24
FAILING_HOURS = 26
RECONNECT_FAILING_DAYS = 3
ENDING_SOON_DAYS = 14

APP_ID = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
LINK_ID = re.compile(r"^[0-9a-f]{12}$")
DEPOSIT_ID = re.compile(r"^[0-9a-f]{32}$")

# --- places -------------------------------------------------------------------------------------------------------

META = "meta"  # Instagram and Facebook together: Meta pays both in one payment
PLACES: tuple[str, ...] = ("youtube", "tiktok", "instagram", "facebook", META, "x", CR)
GETPAID_PLACES: tuple[str, ...] = ("youtube", "tiktok", "instagram", "facebook", "x", CR)
NAMES = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    META: "Instagram and Facebook (Meta pays them together)",
    "x": "X",
    CR: "Content Rewards (Whop)",
}
SHORT = {
    "youtube": "YouTube",
    "tiktok": "TikTok",
    "instagram": "Instagram",
    "facebook": "Facebook",
    META: "Instagram and Facebook",
    "x": "X",
    CR: "Content Rewards",
}
# Clip Factory's own word for the platform named in the bank's text (§40.5.7), shown as "Your bank's text looks like
# Google." Never the bank's own text.
HINT_WORDS = {
    "youtube": "Google",
    "meta": "Meta",
    "instagram": "Instagram",
    "facebook": "Facebook",
    "tiktok": "TikTok",
    "x": "X",
    "stripe": "Stripe",
    "whop": "Whop",
    "paypal": "PayPal",
    "payoneer": "Payoneer",
}

# --- the check and the callback's results -------------------------------------------------------------------------

CHECK_CODES = ("ok", "not_active", "redirect_missing", "sandbox", "key_wrong", "not_found", "down")
CHECK_TEXT = {
    "ok": "Enable Banking knows Clip Factory, and your app is active.",
    "not_active": "Saved. Next: link your bank accounts (step 6).",
    "redirect_missing": (
        "Paste the return address in **Allowed redirect URLs (one per line)**. On your app tap ⋮, then **Edit**, "
        "then **Save**."
    ),
    "sandbox": (
        "That's a Sandbox app. Do steps 3 and 4 again, and tap **Production** first. Then paste the new app ID here."
    ),
    "key_wrong": (
        "Enable Banking doesn't know this key. Do steps 3 and 4 again to make a new app. Then paste its app ID here."
    ),
    "not_found": "Enable Banking doesn't know that app ID. Copy it again.",
    "down": "Enable Banking didn't answer. Try again in a few minutes.",
}
RESULTS = (
    "bank_connected",
    "bank_denied",
    "bank_no_accounts",
    "bank_business_only",
    "bank_expired",
    "bank_key_wrong",
    "bank_error",
)
RESULT_TEXT = {
    "bank_connected": "Clip Factory can see money coming into {bank} now. It looks once a day.",
    "bank_denied": "You stopped at the bank. Tap {button} to try again.",
    "bank_no_accounts": (
        "Enable Banking didn't share an account. Link it on Enable Banking first (step 6). Then tap {button} again."
    ),
    "bank_business_only": (
        "That bank only shared a business account. Clip Factory reads private accounts only. Pick your private "
        "account at your bank, then tap {button} again."
    ),
    "bank_expired": "That took too long. Tap {button} again.",
    "bank_key_wrong": "Enable Banking didn't know your bank key. Tap Check again in step 5.",
    "bank_error": "Something went wrong. Tap {button} again in a few minutes.",
}


def result_text(result: str, bank: str | None, reconnect: bool) -> str:
    """A result's sentence (§40.5.5). Without a bank (an unreadable state): "your bank" and "Connect your bank"."""
    name = bank or "your bank"
    button = f"Reconnect {bank}" if reconnect and bank else "Connect your bank"
    return RESULT_TEXT.get(result, RESULT_TEXT["bank_error"]).format(bank=name, button=button)


# --- the owner's refusals (the exact sentences of §40.5) ----------------------------------------------------------

COMING_SOON = "Coming soon."
NOT_OWNER = "Your bank is only for the owner of this Clip Factory."
STOP_FIRST = "Stop reading every bank first."
KEY_FIRST = "Tap Make my bank key first."
APP_ID_BAD = "Your app ID has 36 letters and numbers with dashes."
APP_ID_TOO = "Paste the app ID too."
PEM_BAD = "That isn't Enable Banking's key file. It ends in .pem and starts with BEGIN PRIVATE KEY."
STEPS_FIRST = "Do the steps above first."
TOO_MANY_BANKS = "You can add up to 4 banks."
PICK_BANK = "Pick a bank from the list."
BANK_GONE = "{bank} isn't in Enable Banking's list now. Tap Connect your bank and pick it again."
NO_COUNTRY = "Pick your country in Money settings first."
COUNTRY_NOT_LINKED = "Enable Banking's app has no account from {country} yet. Link one in step 6 first."
CONNECT_FIRST = "Connect your bank first."
RATE_LIMITED = "Clip Factory checked a moment ago."
READING_NOW = "Clip Factory is reading your bank. Try again in a minute."
TICKS_ITSELF = "Clip Factory ticks that one itself."
STEP_UNKNOWN = "That step is not known."
ANSWER_UNKNOWN = "That answer isn't known."
PICK_PLACE = "Pick a place from the list."
ANSWERED = "That one is answered already."
LINK_UNKNOWN = "We could not find that bank link."
PAYMENT_UNKNOWN = "We could not find that payment."
CHECK_OFF = "Checking your bank is not switched on for this app yet."
CHECK_NOT_STARTED = "Could not start the check. Try again in a minute."

# --- steps --------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Step:
    """One step of the bank guide (the same ids, roles and autos as ``web/src/getpaid/bank.ts``, §40.5.2)."""

    id: str
    number: int | None  # None: the optional "Ask Enable Banking first", never in the ring
    role: str  # "optional" | "reading" (each numbered step lets Clip Factory see the bank)
    title: str
    label: str  # ``next.label`` when this step is next
    manual: bool  # True: his green answer ticks it (PATCH /v1/getpaid/bank/steps)
    auto: str | None  # what ticks it by itself (BankView.steps[].by "auto")
    action: str | None = None  # Clip Factory's own button
    vermilion: bool = True


STEPS: tuple[Step, ...] = (
    Step("bank-ask", None, "optional", "Ask Enable Banking first", "Open email", True, None),
    Step("bank-account", 1, "reading", "Make an Enable Banking account", "Open Enable Banking", True, "app_known"),
    Step("bank-key", 2, "reading", "Make your bank key", "Make my bank key", False, "key_made", "make_bank_key"),
    Step(
        "bank-app",
        3,
        "reading",
        "Add Clip Factory on Enable Banking",
        "Open your Enable Banking apps",
        True,
        "app_known",
    ),
    Step(
        "bank-details",
        4,
        "reading",
        "Fill in the app's details",
        "Fill in the app's details",
        True,
        "app_known",
        vermilion=False,  # no Open: the page is already open, so this step has no vermilion
    ),
    Step("bank-appid", 5, "reading", "Give Clip Factory the app ID", "Save", False, "app_known", "save_app_id"),
    Step(
        "bank-link",
        6,
        "reading",
        "Link your bank accounts",
        "Open your Enable Banking apps",
        False,
        "app_active",
        "check_app",
    ),
    Step(
        "bank-connect", 7, "reading", "Connect your bank", "Connect your bank", False, "bank_connected", "connect_bank"
    ),
)
NUMBERED: tuple[Step, ...] = tuple(s for s in STEPS if s.number is not None)
STEP_IDS = frozenset(s.id for s in STEPS)
# His green answers (and "I deleted it" under the .pem box); the others tick themselves.
TICKABLE = frozenset({"bank-ask", "bank-account", "bank-app", "bank-details", "pem-deleted"})
PEM_DELETED = "pem-deleted"


def step(step_id: str) -> Step | None:
    return next((s for s in STEPS if s.id == step_id), None)
