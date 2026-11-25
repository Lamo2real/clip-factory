"""What a job's AI really cost (docs/CONTRACTS.md §50): the tokens every model answered with, the minutes Transcribe
heard, and the dollars they come to, kept on the Job item as ``aiCost``.

Every place that calls a model records what the answer itself reported (Bedrock Converse ``usage``, the Agent SDK
result's usage, Titan's input token count, Transcribe's audio seconds) into the job's ``Meter``. Recording adds no
model call. Dollars come from the price table in ``config/models.json`` (``pricing``), the only place prices live;
a line whose price the provider's page could not confirm has no number there and shows up as an estimate (``null``
dollars, ``estimated`` true), never an invented one.

A job's run finds its meter through a context variable (``bind``), so the shared model clients, which serve every job
in the container, need no job id. A retried or resumed run starts from what the earlier runs wrote (``base``), so the
total is the whole job's."""

from __future__ import annotations

import contextvars
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

EMBEDDING = "embedding"  # the row key of the embedding model (Titan), which has no entry in ``models``
PRICE_FIELDS = ("inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok")
SHAPE_VERSION = 1


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


class Prices:
    """The ``pricing`` block of config/models.json, with the model labels and ids next to it."""

    def __init__(self, data: Mapping[str, Any] | None = None) -> None:
        data = data or {}
        pricing = data.get("pricing")
        self.pricing: Mapping[str, Any] = pricing if isinstance(pricing, Mapping) else {}
        models = data.get("models")
        self.models: Mapping[str, Any] = models if isinstance(models, Mapping) else {}
        embed = data.get("embeddingModel")
        self.embedding: Mapping[str, Any] = embed if isinstance(embed, Mapping) else {}
        checked = self.pricing.get("checkedOn")
        self.checked_on: str | None = checked if isinstance(checked, str) else None

    @classmethod
    def load(cls, config_dir: Path) -> Prices:
        try:
            data = json.loads((config_dir / "models.json").read_text("utf-8"))
        except (OSError, ValueError):
            return cls()
        return cls(data if isinstance(data, dict) else None)

    def resolve(self, model_id: str) -> tuple[str, str]:
        """(key, label) of a model id as it was called (``global.anthropic.claude-fable-5-1``, ``eu.amazon.nova-…``)
        or as the config names it. An id the config does not know is its own key and label."""
        if model_id in self.models:
            return model_id, str(self.models[model_id].get("label") or model_id)
        for key, entry in self.models.items():
            bare = entry.get("modelId") if isinstance(entry, Mapping) else None
            if isinstance(bare, str) and bare and (model_id == bare or model_id.endswith("." + bare)):
                return str(key), str(entry.get("label") or key)
        bare_embed = self.embedding.get("modelId")
        if model_id == EMBEDDING or (isinstance(bare_embed, str) and model_id.endswith(bare_embed)):
            return EMBEDDING, str(self.embedding.get("label") or "Embeddings")
        return model_id, model_id

    def tokens_price(self, key: str) -> Mapping[str, Any] | None:
        models = self.pricing.get("models")
        entry = models.get(key) if isinstance(models, Mapping) else None
        if key == EMBEDDING:
            entry = self.pricing.get("embedding")
        return entry if isinstance(entry, Mapping) and entry.get("confirmed") is True else None

    def transcribe_per_minute(self) -> float | None:
        entry = self.pricing.get("transcribe")
        if isinstance(entry, Mapping) and entry.get("confirmed") is True:
            return _num(entry.get("perMinute"))
        return None


@dataclass
class Row:
    key: str
    label: str
    calls: int = 0
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0

    def add(self, other: Row) -> None:
        self.calls += other.calls
        self.input += other.input
        self.output += other.output
        self.cache_read += other.cache_read
        self.cache_write += other.cache_write

    @property
    def tokens(self) -> int:
        return self.input + self.output + self.cache_read + self.cache_write


def row_dollars(row: Row, price: Mapping[str, Any] | None) -> tuple[float | None, bool]:
    """(dollars, estimated) of a row. No confirmed price: no dollars at all. A price without a cache line while
    cache tokens were used: the lines that are known, as an estimate."""
    if price is None:
        return None, True
    per = {f: _num(price.get(f)) for f in PRICE_FIELDS}
    total = 0.0
    estimated = price.get("approximate") is True  # the price depends on the request (a long prompt costs more)
    for tokens, field in (
        (row.input, "inputPerMTok"),
        (row.output, "outputPerMTok"),
        (row.cache_read, "cacheReadPerMTok"),
        (row.cache_write, "cacheWritePerMTok"),
    ):
        if not tokens:
            continue
        p = per[field]
        if p is None:
            estimated = True
            continue
        total += tokens * p / 1_000_000
    return round(total, 6), estimated


class Meter:
    """One job's tally. ``base`` is the ``aiCost`` the job already carried (earlier runs of the same job)."""

    def __init__(self, prices: Prices, base: Mapping[str, Any] | None = None) -> None:
        self.prices = prices
        self.rows: dict[str, Row] = {}
        self.transcribe_seconds = 0.0
        self.used = False  # something was recorded by this run
        if isinstance(base, Mapping):
            self._load(base)

    def _load(self, base: Mapping[str, Any]) -> None:
        for r in base.get("models") or []:
            if not isinstance(r, Mapping) or not r.get("key"):
                continue
            row = self.rows.setdefault(str(r["key"]), Row(str(r["key"]), str(r.get("label") or r["key"])))
            row.add(
                Row(
                    row.key,
                    row.label,
                    _int(r.get("calls")),
                    _int(r.get("inputTokens")),
                    _int(r.get("outputTokens")),
                    _int(r.get("cacheReadTokens")),
                    _int(r.get("cacheWriteTokens")),
                )
            )
        t = base.get("transcribe")
        if isinstance(t, Mapping):
            self.transcribe_seconds += _num(t.get("seconds")) or 0.0

    def record(
        self,
        model_id: str,
        *,
        input: int = 0,
        output: int = 0,
        cache_read: int = 0,
        cache_write: int = 0,
        calls: int = 1,
    ) -> None:
        key, label = self.prices.resolve(model_id)
        row = self.rows.setdefault(key, Row(key, label))
        row.add(Row(key, label, max(0, calls), _int(input), _int(output), _int(cache_read), _int(cache_write)))
        self.used = True

    def record_transcribe(self, seconds: float) -> None:
        if seconds > 0:
            self.transcribe_seconds += seconds
            self.used = True

    def summary(self) -> dict[str, Any] | None:
        """The ``aiCost`` object, or None while there is nothing to show (never zeros)."""
        if not self.rows and self.transcribe_seconds <= 0:
            return None
        models: list[dict[str, Any]] = []
        total = 0.0
        estimated = False
        for row in self.rows.values():
            dollars, est = row_dollars(row, self.prices.tokens_price(row.key))
            entry: dict[str, Any] = {
                "key": row.key,
                "label": row.label,
                "calls": row.calls,
                "inputTokens": row.input,
                "outputTokens": row.output,
                "cacheReadTokens": row.cache_read,
                "cacheWriteTokens": row.cache_write,
                "tokens": row.tokens,
                "estimated": est,
            }
            if dollars is not None:
                entry["dollars"] = dollars
                total += dollars
            estimated = estimated or est
            models.append(entry)
        out: dict[str, Any] = {
            "v": SHAPE_VERSION,
            "models": models,
            "totalTokens": sum(r.tokens for r in self.rows.values()),
            "totalCalls": sum(r.calls for r in self.rows.values()),
        }
        if self.transcribe_seconds > 0:
            per_minute = self.prices.transcribe_per_minute()
            minutes = round(self.transcribe_seconds / 60, 2)
            t: dict[str, Any] = {
                "seconds": round(self.transcribe_seconds, 1),
                "minutes": minutes,
                "estimated": per_minute is None,
            }
            if per_minute is not None:
                t["dollars"] = round(self.transcribe_seconds / 60 * per_minute, 6)
                total += t["dollars"]
            else:
                estimated = True
            out["transcribe"] = t
        out["totalDollars"] = round(total, 6)
        out["estimated"] = estimated
        if self.prices.checked_on:
            out["pricesChecked"] = self.prices.checked_on
        return out


_current: contextvars.ContextVar[Meter | None] = contextvars.ContextVar("cf_usage_meter", default=None)


def bind(meter: Meter | None) -> contextvars.Token[Meter | None]:
    return _current.set(meter)


def current() -> Meter | None:
    return _current.get()


def record(model_id: str, **kwargs: int) -> None:
    """Adds one answer to the running job's meter; nothing when no job is running (a probe, a test)."""
    meter = _current.get()
    if meter is not None:
        meter.record(model_id, **kwargs)


def record_transcribe(seconds: float) -> None:
    meter = _current.get()
    if meter is not None:
        meter.record_transcribe(seconds)


def record_sdk_result(result: Any, model_id: str) -> None:
    """The Agent SDK run's usage (a ``ResultMessage``): per model when the CLI reports it, else the run's own totals,
    under the model the run was started with. Prices come from our table, not the SDK's own ``total_cost_usd``."""
    meter = _current.get()
    if meter is None:
        return
    by_model = getattr(result, "model_usage", None)
    if isinstance(by_model, Mapping) and by_model:
        for name, mu in by_model.items():
            if not isinstance(mu, Mapping):
                continue
            key, _ = meter.prices.resolve(str(name))
            target = str(name) if key in meter.prices.models else model_id
            meter.record(
                target,
                input=mu.get("inputTokens") or 0,
                output=mu.get("outputTokens") or 0,
                cache_read=mu.get("cacheReadInputTokens") or 0,
                cache_write=mu.get("cacheCreationInputTokens") or 0,
                calls=1,
            )
        return
    u = getattr(result, "usage", None)
    if isinstance(u, Mapping) and u:
        meter.record(
            model_id,
            input=u.get("input_tokens") or 0,
            output=u.get("output_tokens") or 0,
            cache_read=u.get("cache_read_input_tokens") or 0,
            cache_write=u.get("cache_creation_input_tokens") or 0,
            calls=max(1, int(getattr(result, "num_turns", 1) or 1)),
        )
