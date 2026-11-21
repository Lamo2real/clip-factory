"""Constants of the Content Rewards client (docs/CONTRACTS.md §38.9, §38.12)."""

from __future__ import annotations

import os
from datetime import timedelta

MCP_URL = "https://mcp.contentrewards.com/mcp"
ISSUER = "https://id.contentrewards.com"
REGISTER_URL = f"{ISSUER}/oauth2/register"
AUTHORIZE_URL = f"{ISSUER}/oauth2/authorize"
TOKEN_URL = f"{ISSUER}/oauth2/token"
REVOKE_URL = f"{ISSUER}/oauth2/revoke"
API_VERSION = "2026-10-01"
PROTOCOL = "2025-11-25"
SCOPES: tuple[str, ...] = ("org:read", "campaigns:read", "submissions:read", "earnings:read", "my_submissions:write")
WRITE_SCOPE = "my_submissions:write"
READ_SCOPES: tuple[str, ...] = tuple(s for s in SCOPES if s != WRITE_SCOPE)
CLIENT_NAME = "Clip Factory"
PORTS: tuple[int, ...] = (47811, 47812, 47813, 47814, 47815)
SECRET_KEY = "contentrewards"  # noqa: S105 (the platform part of the secret names, not a secret)
STATE_PLATFORM = "contentrewards"
USER_AGENT = "ClipFactory/1"
AGENT_NAME = "clip-factory"
AGENT_VERSION = "1"
SITE = "https://contentrewards.com"
DISCOVER_URL = f"{SITE}/c/discover"
SETTINGS_URL = f"{SITE}/c/settings"
SUBMISSIONS_URL = f"{SITE}/c/submissions"
PUBLIC_JSON = f"{SITE}/api/campaign/campaigns/{{uuid}}"
SETUP_HREF = "/settings/posting/setup/contentrewards"

# Gates (the local app's ruleCheck.js numbers).
MIN_RATE_CENTS = 100
MAX_SPENT_FRACTION = 0.5
BUDGET_GONE_FRACTION = 0.95

# Sign-in (§38.9).
CONNECT_STATE = timedelta(minutes=5)
SIGN_IN_DAYS = timedelta(days=90)
WARN_BEFORE = timedelta(days=7)
REFRESH_MARGIN = timedelta(seconds=90)
LEASE = timedelta(seconds=30)
LEASE_TRIES = 5
MIN_LAMBDA_SECONDS_TO_REFRESH = 20.0
KEEP_ALIVE = timedelta(hours=24)
PILOT_EVERY = timedelta(days=3)
PILOT_MAX = 5

# MCP timeouts (seconds).
READ_TIMEOUT = 10.0
SUBMIT_TIMEOUT_FLOW = 30.0
SUBMIT_TIMEOUT_API = 25.0
CALLS_PER_SECOND = 2
PAGE_LIMIT = 25
CAMPAIGN_PAGES = 20
SUBMISSION_PAGES = 4
SUBMISSION_GETS = 6
PAID_PAGES_PER_TICK = 8
PENDING_PAGES = 10
CALLS_PER_OWNER_TICK = 25
LIST_CACHE = timedelta(minutes=2)

# Submitting (§38.12).
SEND_DEADLINE = timedelta(minutes=25)
SEND_BY = timedelta(minutes=30)
RETRIES = 26
STUCK_SENDING = timedelta(minutes=3)

# Checking cadence (§38.4, §38.12).
TICK = timedelta(minutes=15)
FAST_FOR = timedelta(days=7)
SLOW_EVERY = timedelta(hours=6)
STOP_AFTER = timedelta(days=30)
HELD_FOR = timedelta(hours=24)
READ_STALE = timedelta(minutes=3)
CHECK_NOW_EVERY = timedelta(seconds=30)
SUB_CHECK_EVERY = timedelta(minutes=1)
CONNECTION_CHECK_EVERY = timedelta(minutes=1)
MONEY_REFRESH_EVERY = timedelta(minutes=10)
PUBLIC_STALE = timedelta(minutes=10)
PUBLIC_PER_MINUTE = 6
SAY_NOT_JOINED_AFTER = timedelta(minutes=2)
SCAN_KEEP = timedelta(days=7)

# Limits.
MAX_PASTED_RULES = 8000
MAX_BRIEF = 20_000
MAX_PUBLIC = 16_000
LOGO_MAX_BYTES = 10 * 1024 * 1024
BRAND_MAX_BYTES = 1024 * 1024
LOGO_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
MAX_STEPS_DONE = 40


def enabled(env: os._Environ[str] | dict[str, str] | None = None) -> bool:
    """``CONTENT_REWARDS=on`` (an unset value is off, §38.8)."""
    source = os.environ if env is None else env
    return str(source.get("CONTENT_REWARDS", "")).strip().lower() == "on"
