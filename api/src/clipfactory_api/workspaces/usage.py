"""Model usage and cost for Settings › AI (docs/CONTRACTS.md §45.3 ``USAGE#``, §45.5, §45.6 ``UsageSummary``, §45.25,
§45.33).

Every model call writes ``USAGE#{day}#{id}`` (written only by Lamo Stories' agent: ``kind: "model"`` with the model
key and its tokens, or ``kind: "provider"`` with images, video or render seconds). This sums them by day and model for
up to 30 days. A cost is shown **only** when a price is known: the owner's price for that model (Settings › AI)
beats the list price of ``stories/config/models.json``; a model with neither shows tokens only (``cost: null``). Each
call is priced on its own (a long-context price applies to the calls above its threshold) and the sums are rounded
to 4 decimals at the end (small calls cost fractions of a cent).

Provider usage (§45.33, §45.34: Nova Canvas pictures, Nova Reel seconds, built-in render seconds) never goes into a
model row: it is summed into ``byProvider`` per day and ``totalsByProvider``, each ``{provider, units, unit, cost,
currency}``. The agent writes ``kind: "provider"`` with ``provider``, ``units`` and ``unit``; an older item's
``providerId`` with ``images``, ``videoSec`` or ``renderSec`` is read the same way. The built-in makers run on Lamo
Stories' own computer: their seconds count as ``builtin-rig``, priced 0 with ``currency: null``, and are the day's
``renderMinutes``. Nova Canvas and Nova Reel are priced by the owner's per-picture or per-second price (PUT ``…/ai``
``prices``), else by the cost the agent recorded on the item, else not at all (``cost: null``).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime, timedelta
from typing import Any, Final

from .. import db
from . import ai_config as cfg
from . import ai_resolve as res
from . import types as ws

MAX_DAYS: Final = 30


def _int(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) and value > 0 else 0


def price_for(model_key: str, ai: Mapping[str, Any]) -> dict[str, Any] | None:
    owner = (ai.get("prices") or {}).get(model_key)
    if isinstance(owner, Mapping):
        return cfg.public_price(owner)
    listed = (res.model(model_key) or {}).get("pricing")
    return cfg.public_price(listed) if isinstance(listed, Mapping) else None


def call_cost(item: Mapping[str, Any], price: Mapping[str, Any]) -> float:
    """One call's cost estimate. Cache reads and writes are priced at their own price when one is known, else at the
    input price (an upper bound, never a guess below what Bedrock can bill)."""
    tokens_in = _int(item.get("input"))
    tokens_out = _int(item.get("output"))
    cache_read = _int(item.get("cacheRead"))
    cache_write = _int(item.get("cacheWrite"))
    per_in, per_out = float(price["inputPer1M"]), float(price["outputPer1M"])
    long_context = price.get("longContext")
    if isinstance(long_context, Mapping) and tokens_in + cache_read + cache_write > int(
        long_context.get("aboveInputTokens") or 0
    ):
        per_in, per_out = float(long_context["inputPer1M"]), float(long_context["outputPer1M"])
    read_price = price.get("cacheReadPer1M")
    write_price = price.get("cacheWritePer1M")
    total = tokens_in * per_in + tokens_out * per_out
    total += cache_read * (float(read_price) if read_price is not None else per_in)
    total += cache_write * (float(write_price) if write_price is not None else per_in)
    return total / 1_000_000


def day_list(today: date, days: int) -> list[str]:
    return [(today - timedelta(days=n)).isoformat() for n in range(days - 1, -1, -1)]


def summary(store: db.Store, user_id: str, workspace_id: str, days: int, now: datetime) -> dict[str, Any]:
    """``UsageSummary``: the last ``days`` days (oldest first, every day listed), per model and per provider, and
    the totals."""
    ai = cfg.current(store, user_id, workspace_id)
    out_days = []
    totals: dict[str, dict[str, Any]] = {}
    provider_totals: dict[tuple[str, str], dict[str, Any]] = {}
    render_sec = 0.0
    for day in day_list(now.date(), days):
        items = cfg.query_owned(store, user_id, workspace_id, f"{ws.USAGE_SK}{day}#")
        by_model: dict[str, dict[str, Any]] = {}
        by_provider: dict[tuple[str, str], dict[str, Any]] = {}
        day_render = 0.0
        for item in items:
            if item.get("kind") == "provider":
                for provider, units, unit in provider_units(item):
                    if provider in BUILTIN and unit == "second":
                        day_render += units
                    _add_provider(by_provider, (provider, unit), units, item=item, ai=ai)
                continue
            key = str(item.get("model") or "")
            if not key:
                continue
            row = by_model.setdefault(key, _row(key, ai))
            _add(row, item, ai)
        render_sec += day_render
        out_days.append(
            {
                "day": day,
                "byModel": [_rounded(r) for r in by_model.values()],
                "renderMinutes": round(day_render / 60, 1),
                "byProvider": [_rounded_provider(r) for r in by_provider.values()],
            }
        )
        for pkey, prow in by_provider.items():
            ptotal = provider_totals.setdefault(pkey, {**prow, "units": 0.0, "cost": 0.0})
            ptotal["units"] += prow["units"]
            if ptotal["cost"] is None or prow["cost"] is None or ptotal["currency"] != prow["currency"]:
                ptotal["cost"], ptotal["currency"] = None, None  # one day without a known price: no total
            else:
                ptotal["cost"] += prow["cost"]
        for key, row in by_model.items():
            total = totals.setdefault(
                key,
                {
                    "model": key,
                    "input": 0,
                    "output": 0,
                    "cost": None if row["cost"] is None else 0.0,
                    "currency": row["currency"],
                },
            )
            total["input"] += row["input"]
            total["output"] += row["output"]
            if total["cost"] is not None and row["cost"] is not None and total["currency"] == row["currency"]:
                total["cost"] += row["cost"]
    return {
        "days": out_days,
        "totals": [_rounded(r) for r in totals.values()],
        "renderMinutes": round(render_sec / 60, 1),
        "totalsByProvider": [_rounded_provider(r) for r in provider_totals.values()],
    }


def _num(value: Any) -> float | None:
    """A stored number (DynamoDB gives back ints and floats), else None."""
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


# The built-in makers (§45.34): free, on Lamo Stories' own computer; their render seconds count as ``builtin-rig``.
BUILTIN: Final = ("builtin-rig", "builtin-2d", "builtin-synth")
BUILTIN_RENDER: Final = "builtin-rig"
UNITS: Final = ("image", "second")
OLD_UNITS: Final = (("images", "image"), ("videoSec", "second"), ("renderSec", "second"))


def provider_units(item: Mapping[str, Any]) -> list[tuple[str, float, str]]:
    """``(provider, units, unit)`` of one provider ``USAGE#`` item: the agent's ``provider``/``units``/``unit``, or an
    older item's ``providerId`` with ``images``, ``videoSec`` or ``renderSec``. Built-in seconds are ``builtin-rig``."""
    provider = str(item.get("provider") or item.get("providerId") or "")
    if not provider:
        return []
    found: list[tuple[str, float, str]] = []
    units, unit = _num(item.get("units")), item.get("unit")
    if units is not None and units > 0 and unit in UNITS:
        found.append((provider, units, str(unit)))
    else:
        for name, old_unit in OLD_UNITS:
            value = _num(item.get(name))
            if value is not None and value > 0:
                found.append((BUILTIN_RENDER if name == "renderSec" else provider, value, old_unit))
    return [(BUILTIN_RENDER if p in BUILTIN and u == "second" else p, n, u) for p, n, u in found]


def _provider_price(provider: str, unit: str, ai: Mapping[str, Any]) -> float | None:
    """The owner's per-picture or per-second price of a provider (§45.34), else None."""
    price = (ai.get("prices") or {}).get(provider)
    if not isinstance(price, Mapping) or price.get("unit") != unit:
        return None
    return _num(price.get("perUnit"))


def _add_provider(
    by_provider: dict[tuple[str, str], dict[str, Any]],
    which: tuple[str, str],
    units: float,
    *,
    item: Mapping[str, Any],
    ai: Mapping[str, Any],
) -> None:
    """One provider usage into its row: free for a built-in maker, else the owner's price, else the cost the agent
    recorded on the item (only when the item is about this one provider), else no cost."""
    provider, unit = which
    row = by_provider.get((provider, unit))
    if row is None:
        row = {"provider": provider, "units": 0.0, "unit": unit, "cost": None, "currency": None}
        if provider in BUILTIN:
            row["cost"] = 0.0
        elif _provider_price(provider, unit, ai) is not None:
            owner = (ai.get("prices") or {}).get(provider) or {}
            row.update(cost=0.0, currency=str(owner.get("currency") or "USD"))
        by_provider[(provider, unit)] = row
    row["units"] += units
    if provider in BUILTIN:
        return
    per_unit = _provider_price(provider, unit, ai)
    if per_unit is not None:
        if row["cost"] is not None:
            row["cost"] += units * per_unit
        return
    cost, currency = _num(item.get("cost")), item.get("currency")
    if cost is None or cost < 0 or not isinstance(currency, str) or not currency:
        if row["cost"] is not None and row["currency"] is not None:
            row["cost"], row["currency"] = None, None  # one unpriced use: the sum is not known
        return
    if row["cost"] is None and row["units"] == units:
        row.update(cost=0.0, currency=currency)
    if row["cost"] is not None and row["currency"] == currency:
        row["cost"] += cost


def _rounded_provider(row: Mapping[str, Any]) -> dict[str, Any]:
    units = float(row["units"])
    return {
        "provider": str(row["provider"]),
        "units": int(units) if units.is_integer() else round(units, 1),
        "unit": str(row["unit"]),
        "cost": round(float(row["cost"]), 4) if row["cost"] is not None else None,
        "currency": row["currency"],
    }


def _row(model_key: str, ai: Mapping[str, Any]) -> dict[str, Any]:
    price = price_for(model_key, ai)
    return {
        "model": model_key,
        "input": 0,
        "output": 0,
        "cost": 0.0 if price else None,
        "currency": str(price["currency"]) if price else None,
    }


def _add(row: dict[str, Any], item: Mapping[str, Any], ai: Mapping[str, Any]) -> None:
    row["input"] += _int(item.get("input")) + _int(item.get("cacheRead")) + _int(item.get("cacheWrite"))
    row["output"] += _int(item.get("output"))
    price = price_for(str(row["model"]), ai)
    if price is not None and row["cost"] is not None:
        row["cost"] += call_cost(item, price)


def _rounded(row: Mapping[str, Any]) -> dict[str, Any]:
    return {**row, "cost": round(float(row["cost"]), 4) if row["cost"] is not None else None}
