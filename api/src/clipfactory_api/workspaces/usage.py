"""Model usage and cost for Settings › AI (docs/CONTRACTS.md §45.3 ``USAGE#``, §45.5, §45.6 ``UsageSummary``, §45.25,
§45.33).

Every model call writes ``USAGE#{day}#{id}`` (written only by Lamo Stories' agent: ``kind: "model"`` with the model
key and its tokens, or ``kind: "provider"`` with images, video or render seconds). This sums them by day and model for
up to 30 days. A cost is shown **only** when a price is known: the owner's price for that model (Settings › AI)
beats the list price of ``stories/config/models.json``; a model with neither shows tokens only (``cost: null``). Each
call is priced on its own (a long-context price applies to the calls above its threshold) and the sums are rounded
to 4 decimals at the end (small calls cost fractions of a cent).

Provider usage (§45.33: Nova Canvas pictures, Nova Reel seconds, built-in render seconds) is "priced only when a
price is known": an item that carries its own ``cost`` and ``currency`` (the agent's, when it knows the provider's
price) adds a row keyed by the provider id, with no tokens; one without a cost adds no row (no "0 tokens" lines).
Render seconds are summed into ``renderMinutes`` either way.
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
    """``UsageSummary``: the last ``days`` days (oldest first, every day listed), per model, and the totals."""
    ai = cfg.current(store, user_id, workspace_id)
    out_days = []
    totals: dict[str, dict[str, Any]] = {}
    render_sec = 0.0
    for day in day_list(now.date(), days):
        items = cfg.query_owned(store, user_id, workspace_id, f"{ws.USAGE_SK}{day}#")
        by_model: dict[str, dict[str, Any]] = {}
        for item in items:
            if item.get("kind") == "provider":
                seconds = _num(item.get("renderSec"))
                if seconds is not None and seconds > 0:
                    render_sec += seconds
                _add_provider(by_model, item)
                continue
            key = str(item.get("model") or "")
            if not key:
                continue
            row = by_model.setdefault(key, _row(key, ai))
            _add(row, item, ai)
        out_days.append({"day": day, "byModel": [_rounded(r) for r in by_model.values()]})
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
    }


def _num(value: Any) -> float | None:
    """A stored number (DynamoDB gives back ints and floats), else None."""
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _add_provider(by_model: dict[str, dict[str, Any]], item: Mapping[str, Any]) -> None:
    """A provider's own recorded cost (none is known today: the agent writes ``cost: null``)."""
    provider = str(item.get("providerId") or "")
    cost, currency = _num(item.get("cost")), item.get("currency")
    if not provider or cost is None or cost < 0 or not isinstance(currency, str) or not currency:
        return
    row = by_model.setdefault(provider, {"model": provider, "input": 0, "output": 0, "cost": 0.0, "currency": currency})
    if row["currency"] == currency and row["cost"] is not None:
        row["cost"] += cost


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
