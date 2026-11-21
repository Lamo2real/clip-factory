"""Every number of the campaign finder (docs/CONTRACTS.md §41.2, §41.3, §41.4).

The finder reads only Content Rewards' public pages that robots.txt allows (``/robots.txt``, ``/sitemap.xml``,
``/c/campaigns/{uuid}``), only from ``cf-prod-campaigns``, anonymously: the §38.9 user agent, no cookie, no account.
"""

from __future__ import annotations

import os
from datetime import timedelta
from typing import Any

from .. import config as cr_config

HOST = "contentrewards.com"
SITE = f"https://{HOST}"
ROBOTS_URL = f"{SITE}/robots.txt"
SITEMAP_URL = f"{SITE}/sitemap.xml"
PAGE_PATH = "/c/campaigns/"
DISCOVER_URL = f"{SITE}/c/discover"
USER_AGENT = cr_config.USER_AGENT  # "ClipFactory/1": the robots.txt group is "clipfactory"
ROBOTS_AGENT = "clipfactory"

# What is read (§41.2 "Exactly what is read").
ROBOTS_MAX_BYTES = 64 * 1024
ROBOTS_TIMEOUT = 8.0
ROBOTS_KEEP_BYTES = 8 * 1024
ROBOTS_EVERY = timedelta(hours=24)
ROBOTS_USABLE = timedelta(days=7)
SITEMAP_MAX_BYTES = 4 * 1024 * 1024
SITEMAP_TIMEOUT = 10.0
SITEMAP_CHILDREN = 5
MAX_ENTRIES = 5000
PAGE_MAX_BYTES = 2 * 1024 * 1024
PAGE_TIMEOUT = 8.0
PAGES_PER_LOOK = 40
REQUEST_GAP = 1.0  # seconds between the starts of two requests

# When and how often (§41.2 "When, how often, and limits").
RUN_EVERY = timedelta(hours=6)
LEASE = timedelta(seconds=150)
READ_DEADLINE = 100.0  # seconds after the start of a look (the Lambda has 120 s)
READS_PER_DAY = 6
READ_GAP = timedelta(minutes=30)
NEXT_TRY_MIN = timedelta(minutes=15)  # a scheduled look that can't read: the next one no sooner than the next tick

# The plan (§41.2 "The plan").
MATCH_STALE = timedelta(hours=12)
MATCH_STALE_MAX = 10
RECHECK_LIVE = timedelta(days=2)
RECHECK_OFF = timedelta(days=14)
GROUP_KEEP = timedelta(days=14)
FAILS_OFF = 3
CACHE_TTL = timedelta(days=60)

# Backoff (§41.2 "Backoff").
BACKOFF_MIN = timedelta(hours=1)
BACKOFF_MAX = timedelta(hours=24)
BLOCKED_BACKOFF = timedelta(hours=24)
BLOCKED_AFTER = 3
PAGE_FAILS_STOP = 3
PAGE_FAILS_BACKOFF = timedelta(hours=1)
UNREADABLE_STOP = 5
UNREADABLE_BACKOFF = timedelta(hours=6)
DOWN_AFTER = timedelta(hours=24)

# Sizes (§41.5 data).
CARD_MAX_BYTES = 6 * 1024
STATE_MAX_BYTES = 350 * 1024
SHOWN_MAX = 300
MAX_MATCHES = 20
MAX_LINES = 3
MAX_CATEGORIES = 6
MAX_CONTENT_TYPES = 8
MAX_GROUP = 20
MAX_CHIP_CATEGORIES = 12
NOTICE_EVERY = timedelta(hours=24)

# The owner's defaults: the same literal as Q's ``finderapi.py`` (§41.3), tested against the contract's line.
DEFAULTS: dict[str, Any] = {
    "on": True,
    "minPer1kCents": 100,
    "places": None,
    "categories": [],
    "minLeftPct": 25,
    "access": "open",
    "otherPay": False,
    "languages": [],
    "tellMe": True,
}
WANT_KEYS = tuple(DEFAULTS)
WHYS = ("schedule", "start", "check_now", "want")

# The page-language guess (§41.3 "Languages"): ten common words each, whole words, case-insensitive.
LANGUAGE_MIN_WORDS = 25
LANGUAGE_MIN_HITS = 6
LANGUAGE_LEAD = 1.5
STOP_WORDS: dict[str, tuple[str, ...]] = {
    "en": ("the", "a", "and", "to", "of", "in", "on", "for", "with", "your"),
    "es": ("el", "los", "las", "del", "y", "por", "para", "es", "tu", "que"),
    "pt": ("do", "da", "dos", "em", "não", "você", "com", "os", "são", "seu"),
    "fr": ("le", "les", "des", "et", "est", "pour", "vous", "avec", "une", "dans"),
    "de": ("der", "die", "und", "das", "ist", "nicht", "mit", "für", "sie", "ein"),
    "it": ("il", "di", "che", "gli", "per", "non", "sono", "della", "questo", "nel"),
}
LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "pt": "Portuguese",
    "fr": "French",
    "de": "German",
    "it": "Italian",
}


def enabled(env: os._Environ[str] | dict[str, str] | None = None) -> bool:
    """``CR_FINDER=on`` (an unset value is off, §41.6)."""
    source = os.environ if env is None else env
    return str(source.get("CR_FINDER", "")).strip().lower() == "on"
