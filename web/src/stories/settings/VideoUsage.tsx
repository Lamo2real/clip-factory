// Settings › Video › Use and costs, last 30 days (docs/CONTRACTS.md §45.34 "Provider usage and cost", §45.29 Video
// "usage (render minutes per day, provider cost where known)", request 2 §6E "Usage and costs"): the render minutes of
// each day (a bar a day, with the list under it), and each maker's use in its own units (pictures, seconds) with its
// cost: worked out from the owner's price, "Free: it runs on Lamo Stories' own computer" for the built-in animator,
// or "No price yet: add one", which opens that maker's price form. Makers are named, never shown by their ids.
import { useState } from "react";
import type { ProviderStatus, ProviderUsage, UsageSummary } from "../api/types.ts";
import { Btn, dayLabel, Empty, money, SetCard } from "./bits.tsx";
import { PRICED_MAKERS } from "./ProviderPrices.tsx";
import { lastDays } from "./UsageCard.tsx";

/** The makers' names for their usage lines (built-in render seconds are counted as builtin-rig, §45.34). */
export const USAGE_NAME: Record<string, string> = {
  "builtin-rig": "Built-in animator",
  "builtin-2d": "Built-in animator",
  "builtin-synth": "Built-in sounds and music",
  "nova-canvas": "Amazon Nova Canvas",
  "nova-reel": "Amazon Nova Reel 1.1",
  stability: "Stability AI pictures",
  "luma-ray": "Luma AI Ray2",
  "own-images": "Your own picture model",
  "own-video": "Your own video model",
  "own-sound": "Your own sound model",
  elevenlabs: "ElevenLabs sound effects and music",
  polly: "A spoken voice (Amazon Polly)",
};

export const FREE_LINE = "Free: it runs on Funded Clips' own computer";

/** One mark colour per maker, in the order they are listed (marks only, never words). */
const SWATCH = ["st-stg-sw--sky", "st-stg-sw--sun", "st-stg-sw--mint", "st-stg-sw--coral", "st-stg-sw--lilac"];

export function makerName(id: string, providers: ProviderStatus[] | null): string {
  return USAGE_NAME[id] ?? providers?.find((p) => p.id === id)?.label ?? "Another maker";
}

/** "12 pictures", "45 seconds of video", "8 minutes of rendering". */
export function unitsText(u: Pick<ProviderUsage, "provider" | "units" | "unit">): string {
  const n = Math.round(u.units * 10) / 10;
  if (u.unit === "image") return `${n.toLocaleString("en-GB")} ${n === 1 ? "picture" : "pictures"}`;
  if (u.unit === "character") return `${Math.round(u.units).toLocaleString("en-GB")} ${Math.round(u.units) === 1 ? "character" : "characters"} spoken`;
  const what = u.provider === "nova-reel" || u.provider === "luma-ray" || u.provider === "own-video" ? "of video" : u.provider === "elevenlabs" || u.provider === "own-sound" || u.provider === "polly" ? "of sound" : "of rendering";
  if (n >= 120) {
    const min = Math.round(n / 60);
    return `${min.toLocaleString("en-GB")} minutes ${what}`;
  }
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "second" : "seconds"} ${what}`;
}

function minutesText(m: number): string {
  const n = Math.round(m * 10) / 10;
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "minute" : "minutes"}`;
}

function CostText({ u, onAddPrice }: { u: ProviderUsage; onAddPrice: (id: string) => void }) {
  if (u.cost !== null && u.cost === 0 && !u.currency) return <span className="st-stg-usage__free">{FREE_LINE}</span>;
  if (u.cost !== null && u.currency) return <>{money(u.cost, u.currency)}</>;
  const priced = PRICED_MAKERS.some((m) => m.id === u.provider);
  return (
    <span className="st-stg-usage__noprice">
      No price yet{priced ? ":" : "."}
      {priced ? (
        <Btn quiet small onClick={() => onAddPrice(u.provider)} label={`Add a price for ${USAGE_NAME[u.provider] ?? u.provider}`}>
          add one
        </Btn>
      ) : null}
    </span>
  );
}

export function VideoUsage({ usage, error, providers, onAddPrice }: { usage: UsageSummary | null; error: string | null; providers: ProviderStatus[] | null; onAddPrice: (id: string) => void }) {
  const [list, setList] = useState(false);
  const days = lastDays(30);
  const byDay = new Map((usage?.days ?? []).map((d) => [d.day, d]));
  const perDay = days.map((d) => byDay.get(d)?.renderMinutes ?? 0);
  const peak = Math.max(0.0001, ...perDay);
  const totals = usage?.totalsByProvider ?? [];
  const hasDays = (usage?.days ?? []).some((d) => d.renderMinutes !== undefined || d.byProvider !== undefined);
  const busiest = perDay.reduce<{ i: number; n: number } | null>((best, n, i) => (n > (best?.n ?? 0) ? { i, n } : best), null);
  const sums = new Map<string, number>();
  for (const t of totals) if (t.cost !== null && t.currency) sums.set(t.currency, (sums.get(t.currency) ?? 0) + t.cost);

  return (
    <SetCard title="Use and costs, last 30 days" icon="coin" tone="mint" lede="How many minutes of video were made each day, and what the picture and video makers cost.">
      {error && !usage ? <p className="st-stg-small">{error}</p> : null}
      {usage ? (
        <>
          <p className="st-stg-active">
            <span className="st-stg-active__word">Rendering, last 30 days</span>
            <strong>{minutesText(usage.renderMinutes)}</strong>
          </p>
          {hasDays ? (
            <>
              <div
                className="st-stg-chart st-stg-chart--render"
                role="img"
                aria-label={`Minutes of video made each day for the last 30 days.${busiest ? ` The busiest day was ${dayLabel(days[busiest.i]!)}, with ${minutesText(busiest.n)}.` : ""}`}
              >
                {days.map((d, i) => (
                  <span key={d} className="st-stg-chart__day" title={`${dayLabel(d)}: ${minutesText(perDay[i]!)}`}>
                    <span className="st-stg-chart__stack" style={{ height: `${Math.max(perDay[i]! ? 4 : 0, (perDay[i]! / peak) * 100)}%` }}>
                      <span className="st-stg-chart__part st-stg-sw--sky" style={{ flexGrow: 1 }} />
                    </span>
                  </span>
                ))}
              </div>
              <p className="st-stg-chart__axis" aria-hidden="true">
                <span>{dayLabel(days[0]!)}</span>
                <span>Today</span>
              </p>
            </>
          ) : null}
          <h4 className="st-stg-subhead">Each maker</h4>
          {totals.length ? (
            <>
              <ul className="st-stg-usage" aria-label="Each maker's use">
                {totals.map((t, i) => (
                  <li key={t.provider} className="st-stg-usage__row" data-provider={t.provider}>
                    <span className={`st-stg-sw ${SWATCH[i % SWATCH.length]}`} aria-hidden="true" />
                    <span className="st-stg-usage__name">{makerName(t.provider, providers)}</span>
                    <span className="st-stg-usage__tokens">{unitsText(t)}</span>
                    <span className="st-stg-usage__cost">
                      <CostText u={t} onAddPrice={onAddPrice} />
                    </span>
                  </li>
                ))}
              </ul>
              {sums.size ? (
                <p className="st-stg-small">
                  In all: {[...sums].map(([cur, n]) => money(n, cur)).join(" + ")}
                  {totals.some((t) => t.cost === null) ? ", not counting makers with no price yet." : "."}
                </p>
              ) : null}
            </>
          ) : (
            <Empty title="No videos made yet" mood="sleepy">
              Each maker's use and cost shows here after the first video.
            </Empty>
          )}
          {hasDays ? (
            <>
              <Btn quiet onClick={() => setList((v) => !v)}>
                {list ? "Hide each day" : "Show each day"}
              </Btn>
              {list ? (
                <ul className="st-stg-days" aria-label="Each day's rendering">
                  {(usage.days ?? [])
                    .filter((d) => d.renderMinutes || d.byProvider?.length)
                    .map((d) => (
                      <li key={d.day} className="st-stg-days__day">
                        <span className="st-stg-days__date">
                          {dayLabel(d.day)}: {minutesText(d.renderMinutes ?? 0)}
                        </span>
                        <ul className="st-stg-days__models">
                          {(d.byProvider ?? []).map((u) => (
                            <li key={u.provider}>
                              {makerName(u.provider, providers)}: {unitsText(u)} ·{" "}
                              {u.cost === 0 && !u.currency ? "free" : u.cost !== null && u.currency ? money(u.cost, u.currency) : "no price yet"}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                </ul>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </SetCard>
  );
}
