// The money dashboard's chart (docs/CONTRACTS.md §27.4): reported money per day (or per week for a year), drawn by
// hand in SVG. No gridlines, axis lines or borders: one soft baseline band, the highest value on top and the first
// and last dates underneath. A tap, a pointer or the arrow keys show one bar's day, amount and tag in a small glass
// tip, mirrored in a polite live line; "Show as a list" lists every value.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { MoneyChartPoint, MoneyCurrencySummary, MoneySummary, Platform } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { useMedia } from "../../lib/hooks.ts";
import { formatMoney } from "../../lib/money.ts";
import { barHeights, barLayout, nearestBar, plainDay, plainShort, stackShares } from "../../lib/moneyDash.ts";

const TOP_PAD = 6;
const FILL: Partial<Record<Platform, string>> = { youtube: "var(--dash-yt)", facebook: "var(--dash-fb)" };

function pointLabel(p: MoneyChartPoint, bucket: "day" | "week"): string {
  if (bucket === "day") return plainDay(p.end);
  return p.start === p.end ? plainDay(p.end) : `${plainShort(p.start)} – ${plainShort(p.end)}`;
}

export function MoneyChart({ summary, entry }: { summary: MoneySummary; entry: MoneyCurrencySummary }) {
  const { chart, currency, tag } = entry;
  const wide = useMedia("(min-width: 1280px)");
  const mid = useMedia("(min-width: 768px)");
  const height = wide ? 280 : mid ? 240 : 180;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [at, setAt] = useState<number | null>(null);
  const [list, setList] = useState(false);
  const listId = useId();
  const points = chart.points;
  const stacked = entry.platforms.filter((p) => points.some((pt) => (pt.byPlatform[p] ?? 0) > 0));
  const split = stacked.length >= 2;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new picture starts with no bar picked.
  useEffect(() => setAt(null), [chart.period, currency, summary.through]);

  const plotH = height - TOP_PAD;
  const bars = barLayout(points.length, width, 2);
  const totals = barHeights(
    points.map((p) => p.amountMicros),
    plotH,
  );
  const top = points.reduce<MoneyChartPoint | null>((best, p) => (!best || p.amountMicros > best.amountMicros ? p : best), null);
  const unit = chart.bucket === "week" ? "week" : "day";
  const label = top
    ? `Money per ${unit}, ${chart.period === 365 ? "the last year" : `${chart.period} days`} up to ${plainDay(chart.to)}. Highest: ${formatMoney(top.amountMicros, currency)} on ${pointLabel(top, chart.bucket)}. ${tag}.`
    : `No money days to show yet. ${tag}.`;
  const picked = at !== null ? points[at] : null;
  const tip = picked ? `${pointLabel(picked, chart.bucket)} · ${formatMoney(picked.amountMicros, currency)} · ${tag}` : "";
  const tipX = picked && bars[at!] ? bars[at!]!.x + bars[at!]!.w / 2 : 0;

  function pick(clientX: number) {
    const el = box.current;
    if (!el || !points.length) return;
    const r = el.getBoundingClientRect();
    setAt(nearestBar(clientX - r.left, points.length, r.width));
  }

  return (
    <div className="dash-chart">
      {top ? (
        <p className="dash-chart__max">
          <span className="sr-only">Highest: </span>
          {formatMoney(top.amountMicros, currency)}
        </p>
      ) : null}
      <div
        ref={box}
        className="dash-chart__plot"
        style={{ height }}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${label} Use the left and right arrow keys to read each ${unit}.`}
        aria-describedby={list ? listId : undefined}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setAt(null);
        }}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          if (!points.length) return;
          const last = points.length - 1;
          const now = at ?? last;
          const next = e.key === "ArrowLeft" ? Math.max(0, now - (at === null ? 0 : 1)) : e.key === "ArrowRight" ? Math.min(last, now + (at === null ? 0 : 1)) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
          if (next === null) return;
          e.preventDefault();
          setAt(next);
        }}
      >
        <svg width="100%" height={height} viewBox={`0 0 ${Math.max(1, width)} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <rect className="dash-chart__base" x={0} y={height - 3} width={Math.max(1, width)} height={3} rx={1.5} />
          {width > 0
            ? points.map((p, i) => {
                const b = bars[i]!;
                const h = totals[i]!;
                const r = Math.min(3, b.w / 2);
                const delay = Math.min(240, i * 8);
                if (!split) {
                  return (
                    <rect
                      key={p.start}
                      className={`dash-bar${at === i ? " is-on" : ""}${p.partial ? " is-partial" : ""}`}
                      x={b.x}
                      y={height - h}
                      width={b.w}
                      height={h}
                      rx={r}
                      style={{ fill: FILL[entry.platforms[0]!] ?? "var(--dash-yt)", animationDelay: `${delay}ms` }}
                    />
                  );
                }
                // Stacked by app: each app's share of this bar's height, bottom up, in STATS order.
                const shares = stackShares(
                  stacked.map((s) => p.byPlatform[s] ?? 0),
                  h,
                );
                let y = height;
                return (
                  <g key={p.start} className={`dash-bar-stack${at === i ? " is-on" : ""}`} style={{ animationDelay: `${delay}ms` }}>
                    {stacked.map((s, k) => {
                      const sh = shares[k]!;
                      y -= sh;
                      return sh > 0 ? <rect key={s} className="dash-bar" x={b.x} y={y} width={b.w} height={sh} rx={k === stacked.length - 1 ? r : 0} style={{ fill: FILL[s] }} /> : null;
                    })}
                  </g>
                );
              })
            : null}
        </svg>
        {picked ? (
          <span className="dash-tip" data-align={tipX < width * 0.3 ? "start" : tipX > width * 0.7 ? "end" : "mid"} style={{ left: tipX }} aria-hidden="true">
            {tip}
          </span>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {tip}
      </p>
      <div className="dash-chart__under">
        <span>{points[0] ? plainShort(points[0].start) : ""}</span>
        {split ? (
          <span className="dash-legend" role="group" aria-label="Colours">
            {stacked.map((s) => (
              <span key={s} className="dash-legend__item">
                <span className="dash-legend__swatch" style={{ background: FILL[s] }} aria-hidden="true" />
                <PlatformMark platform={s} size={16} title={PLATFORM_LABEL[s]} />
              </span>
            ))}
          </span>
        ) : null}
        <span>{points.at(-1) ? plainShort(points.at(-1)!.end) : ""}</span>
      </div>
      <button type="button" className="text-link dash-chart__list-toggle" aria-expanded={list} aria-controls={listId} onClick={() => setList((l) => !l)}>
        {list ? "Hide the list" : "Show as a list"}
      </button>
      <ul className="dash-chart__list" id={listId} hidden={!list} aria-label={`Money per ${unit}`}>
        {[...points].reverse().map((p) => (
          <li key={p.start}>
            <span>{pointLabel(p, chart.bucket)}</span>
            <strong>{formatMoney(p.amountMicros, currency)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
