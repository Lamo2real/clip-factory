// Usage and cost for the last 30 days (docs/CONTRACTS.md §45.25 "Usage and cost", §45.29 AI): tokens and cost per
// model, and per day (a bar for each day, one colour per model, with every number in the list under it). A model with
// no known price shows tokens only, "No price set."; a price the owner typed is marked as his.
import { useState } from "react";
import type { ModelInfo, UsageSummary } from "../api/types.ts";
import { Btn, Chip, dayLabel, Empty, money, SetCard, tokens } from "./bits.tsx";

const DAY_MS = 86_400_000;
/** One colour per model, in the order the totals list them (marks only, never words). */
const SWATCH = ["st-stg-sw--sun", "st-stg-sw--sky", "st-stg-sw--mint", "st-stg-sw--coral", "st-stg-sw--cream", "st-stg-sw--lilac"];

function costText(cost: number | null, currency: string | null): string {
  return cost === null || !currency ? "No price set." : money(cost, currency);
}

/** The last `n` days, oldest first, as YYYY-MM-DD (UTC, like the usage items). */
export function lastDays(n: number, now = Date.now()): string[] {
  return Array.from({ length: n }, (_, i) => new Date(now - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

export function UsageCard({ usage, models, error }: { usage: UsageSummary | null; models: ModelInfo[]; error: string | null }) {
  const [list, setList] = useState(false);
  const label = (key: string) => models.find((m) => m.key === key)?.label ?? key;
  const priced = (key: string) => models.find((m) => m.key === key)?.price ?? null;
  const totals = [...(usage?.totals ?? [])].sort((a, b) => b.input + b.output - (a.input + a.output));
  const order = totals.map((t) => t.model);
  const swatch = (key: string) => SWATCH[Math.max(0, order.indexOf(key)) % SWATCH.length]!;
  const days = lastDays(30);
  const byDay = new Map((usage?.days ?? []).map((d) => [d.day, d.byModel]));
  const peak = Math.max(1, ...days.map((d) => (byDay.get(d) ?? []).reduce((a, m) => a + m.input + m.output, 0)));
  const sums = new Map<string, number>();
  for (const t of totals) if (t.cost !== null && t.currency) sums.set(t.currency, (sums.get(t.currency) ?? 0) + t.cost);
  const unpriced = totals.filter((t) => t.cost === null).length;
  const busiest = days.reduce<{ day: string; n: number } | null>((best, d) => {
    const n = (byDay.get(d) ?? []).reduce((a, m) => a + m.input + m.output, 0);
    return n > (best?.n ?? 0) ? { day: d, n } : best;
  }, null);

  return (
    <SetCard
      title="Usage and cost, last 30 days"
      icon="coin"
      lede="Tokens are bits of words. Costs use each model's price."
      tone="mint"
    >
      {error && !usage ? <p className="st-stg-small">{error}</p> : null}
      {usage && !totals.length ? <Empty title="No AI work yet" mood="sleepy">Tokens and costs show here after the first idea, chat or video.</Empty> : null}
      {totals.length ? (
        <>
          <p className="st-stg-total">
            {sums.size ? [...sums].map(([cur, n]) => money(n, cur)).join(" + ") : "No price set"}
            <span className="st-stg-total__note">{unpriced ? ` · ${unpriced === 1 ? "1 model has" : `${unpriced} models have`} no price, so it is not counted` : " in all"}</span>
          </p>
          <ul className="st-stg-usage" aria-label="Each model">
            {totals.map((t) => {
              const p = priced(t.model);
              return (
                <li key={t.model} className="st-stg-usage__row">
                  <span className={`st-stg-sw ${swatch(t.model)}`} aria-hidden="true" />
                  <span className="st-stg-usage__name">{label(t.model)}</span>
                  <span className="st-stg-usage__tokens">
                    {tokens(t.input)} in · {tokens(t.output)} out
                  </span>
                  <span className="st-stg-usage__cost">
                    {costText(t.cost, t.currency)}
                    {p?.source === "owner" ? <Chip tone="sky">Your price</Chip> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <div
            className="st-stg-chart"
            role="img"
            aria-label={`Tokens used each day for the last 30 days.${busiest ? ` The busiest day was ${dayLabel(busiest.day)}, with ${tokens(busiest.n)} tokens.` : ""}`}
          >
            {days.map((d) => {
              const rows = byDay.get(d) ?? [];
              const total = rows.reduce((a, m) => a + m.input + m.output, 0);
              return (
                <span key={d} className="st-stg-chart__day" title={`${dayLabel(d)}: ${tokens(total)} tokens`}>
                  <span className="st-stg-chart__stack" style={{ height: `${Math.max(total ? 4 : 0, (total / peak) * 100)}%` }}>
                    {rows
                      .slice()
                      .sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model))
                      .map((m) => (
                        <span key={m.model} className={`st-stg-chart__part ${swatch(m.model)}`} style={{ flexGrow: m.input + m.output }} />
                      ))}
                  </span>
                </span>
              );
            })}
          </div>
          <p className="st-stg-chart__axis" aria-hidden="true">
            <span>{dayLabel(days[0]!)}</span>
            <span>Today</span>
          </p>
          <Btn quiet onClick={() => setList((v) => !v)}>
            {list ? "Hide each day" : "Show each day"}
          </Btn>
          {list ? (
            <ul className="st-stg-days" aria-label="Each day">
              {[...(usage?.days ?? [])].map((d) => (
                <li key={d.day} className="st-stg-days__day">
                  <span className="st-stg-days__date">{dayLabel(d.day)}</span>
                  <ul className="st-stg-days__models">
                    {d.byModel.map((m) => (
                      <li key={m.model}>
                        {label(m.model)}: {tokens(m.input)} in · {tokens(m.output)} out · {costText(m.cost, m.currency)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </SetCard>
  );
}
