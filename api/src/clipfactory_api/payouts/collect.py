"""``payouts.collect.run``: the Get paid part of one owner's money run (docs/CONTRACTS.md §40.7 "Checking").

``cf-prod-money``'s daily run (06:00 UTC) and "Check now" call it once, after the five platforms, inside its own try
(``money.collect.run_user``). No new schedule, Lambda or role. AdSense first, then Whop, each on its own: one failing
(or crashing) never stops the other, and neither can stop the money run. Skipped when less than 20 s of the money
run's time budget is left. Before the API builder's part has merged there is no ``PAYCONN#`` item, and this reads
nothing.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from ..log import log
from . import ADSENSE, MIN_SECONDS_LEFT, WHOP, PayoutDeps, adsense, whop

Source = Callable[[PayoutDeps, str, datetime], str]
SOURCES: tuple[tuple[str, Source], ...] = ((ADSENSE, adsense.run), (WHOP, whop.run))


def from_money(deps: Any, remaining: Callable[[], float] | None = None) -> PayoutDeps | None:
    """The payout deps of a ``MoneyDeps``: the same table, HTTP client and clock, and the platform secrets of its token
    provider (``SecretsTokenProvider.env.secrets``). None without secrets (nothing can be read)."""
    secrets = getattr(getattr(deps.tokens, "env", None), "secrets", None)
    if secrets is None:
        return None
    out = PayoutDeps(store=deps.store, secrets=secrets, http=deps.http, clock=deps.clock)
    if remaining is not None:
        out.remaining = remaining
    return out


def run(deps: Any, user_id: str, now: datetime, *, remaining: Callable[[], float] | None = None) -> dict[str, str]:
    """Reads each connected payout source once; returns ``{source: outcome}`` (``skipped`` when out of time)."""
    payout_deps = deps if isinstance(deps, PayoutDeps) else from_money(deps, remaining)
    if payout_deps is None:
        return {}
    out: dict[str, str] = {}
    for name, source in SOURCES:
        if payout_deps.remaining() < MIN_SECONDS_LEFT:
            log("warning", "payouts.time_budget", source=name)
            out[name] = "skipped"
            continue
        try:
            out[name] = source(payout_deps, user_id, now)
        except Exception as e:  # one source never stops the other
            log("error", "payouts.source_failed", source=name, error=type(e).__name__)
            out[name] = "error"
    log("info", "payouts.run", **out)
    return out
