// A tiny views-over-time line for one platform stack (docs/CONTRACTS.md §16.8). Hidden with fewer than two points.
import type { SeriesPoint } from "../api/types.ts";
import { compact } from "../lib/metrics.ts";

export const SPARK_W = 120;
export const SPARK_H = 32;

/** Polyline points for the series, scaled by time (x) and views (y) into a w × h box with 2 px padding. */
export function sparkPoints(series: SeriesPoint[], w = SPARK_W, h = SPARK_H): string {
  if (series.length < 2) return "";
  const t = series.map((p) => Date.parse(p.at));
  const t0 = Math.min(...t);
  const t1 = Math.max(...t);
  const v = series.map((p) => p.views);
  const v0 = Math.min(...v);
  const v1 = Math.max(...v);
  const pad = 2;
  const x = (ms: number, i: number) => (t1 > t0 ? (ms - t0) / (t1 - t0) : i / (series.length - 1)) * (w - pad * 2) + pad;
  const y = (n: number) => (v1 > v0 ? h - pad - ((n - v0) / (v1 - v0)) * (h - pad * 2) : h / 2);
  return series.map((p, i) => `${Math.round(x(t[i]!, i) * 10) / 10},${Math.round(y(p.views) * 10) / 10}`).join(" ");
}

export function Sparkline({ series, best = false }: { series: SeriesPoint[] | undefined; best?: boolean }) {
  if (!series || series.length < 2) return null;
  const first = series[0]!.views;
  const last = series.at(-1)!.views;
  const pts = sparkPoints(series);
  return (
    <svg
      className={`spark${best ? " is-best" : ""}`}
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Views went from ${compact(first)} to ${compact(last)}`}
    >
      <polyline className="spark__line" points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
