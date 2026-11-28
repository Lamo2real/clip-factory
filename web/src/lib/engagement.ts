// Engagement on the clip page: the engagement rate the way pros count it (interactions ÷ views × 100, weighted by
// views across apps) and the "How long people watch" curve (each app's own retention curve, resampled and averaged
// by views). Pure: the screen is ClipEngagement.tsx. Nothing here is ever guessed: an app that sends no curve adds
// no curve, only the real numbers it does send (as markers).
import type { AnyExtra, ClipPerformance, Platform, PlatformPerformance, PostMetrics } from "../api/types.ts";
import { PLATFORM_LABEL } from "./format.ts";
import { STATS_ORDER } from "./metrics.ts";

export type EngFilter = "all" | Platform;

/** The parts of one app's (or all apps') interactions. `commentsAndShares` is Facebook's one combined count. */
export interface EngParts {
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  commentsAndShares: number;
  views: number;
}

const ZERO: EngParts = { likes: 0, comments: 0, shares: 0, saves: 0, commentsAndShares: 0, views: 0 };
const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const extraOf = (m: PostMetrics) => (m.extra ?? {}) as Partial<AnyExtra>;

/** One app's interactions, from the numbers that app really gives (missing ones count as 0). */
export function partsFor(platform: Platform, m: PostMetrics): EngParts {
  const x = extraOf(m);
  const views = n(m.views);
  switch (platform) {
    case "instagram":
      return { ...ZERO, views, likes: n(m.likes), comments: n(m.comments), shares: n(m.shares), saves: n(x.saved) };
    case "facebook":
      // Facebook's likes are its reactions; its comments and shares come as one number.
      return { ...ZERO, views, likes: n(m.likes), commentsAndShares: n(x.commentsAndShares) };
    case "x":
      return {
        ...ZERO,
        views,
        likes: n(m.likes),
        comments: n(m.comments),
        shares: n(x.reposts ?? m.shares) + n(x.quotes),
        saves: n(x.bookmarks),
      };
    default:
      return { ...ZERO, views, likes: n(m.likes), comments: n(m.comments), shares: n(m.shares) };
  }
}

export const interactionsOf = (p: EngParts) => p.likes + p.comments + p.shares + p.saves + p.commentsAndShares;

/** The apps the clip is really out on with numbers, in STATS_ORDER. */
export function engagedPlatforms(perf: Pick<ClipPerformance, "posts">): Platform[] {
  return STATS_ORDER.filter((pl) => {
    const s = perf.posts.find((p) => p.platform === pl);
    return !!s && s.status === "posted" && !!s.metrics;
  });
}

function stackOf(perf: Pick<ClipPerformance, "posts">, platform: Platform): PlatformPerformance | undefined {
  return perf.posts.find((p) => p.platform === platform);
}

/** The rate (null: no views anywhere) and its summed parts, over the chosen apps. Apps with no views are left out. */
export function engagement(perf: Pick<ClipPerformance, "posts">, filter: EngFilter = "all"): { rate: number | null; parts: EngParts; platforms: Platform[] } {
  const chosen = filter === "all" ? engagedPlatforms(perf) : engagedPlatforms(perf).filter((p) => p === filter);
  const parts = { ...ZERO };
  const used: Platform[] = [];
  for (const pl of chosen) {
    const m = stackOf(perf, pl)?.metrics;
    if (!m || !m.views) continue;
    const one = partsFor(pl, m);
    for (const k of Object.keys(parts) as (keyof EngParts)[]) parts[k] += one[k];
    used.push(pl);
  }
  return { rate: parts.views > 0 ? (interactionsOf(parts) / parts.views) * 100 : null, parts, platforms: used };
}

/** "4.7%", or "–" with no views. */
export function formatRate(rate: number | null): string {
  return rate === null ? "–" : `${rate.toFixed(1)}%`;
}

export type EngWord = "Low" | "OK" | "Good" | "Great" | "Amazing";
/** One status word for the rate. */
export function statusWord(rate: number): EngWord {
  if (rate < 1) return "Low";
  if (rate < 3) return "OK";
  if (rate < 6) return "Good";
  if (rate < 10) return "Great";
  return "Amazing";
}

/** Seconds as m:ss: 3.4 → "0:03", 75 → "1:15". */
export function mss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- How long people watch ----------

export type Point = [number, number];

/** A curve on x = 0..100 step 1 by straight lines between its points; null outside the curve's own x range. */
export function resample(points: readonly Point[]): (number | null)[] {
  const pts = [...points].filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
  const out: (number | null)[] = [];
  for (let x = 0; x <= 100; x++) {
    if (!pts.length || x < pts[0]![0] || x > pts.at(-1)![0]) {
      out.push(null);
      continue;
    }
    let i = 0;
    while (i < pts.length - 1 && pts[i + 1]![0] < x) i++;
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[Math.min(i + 1, pts.length - 1)]!;
    out.push(x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
  }
  return out;
}

/** Several curves as one, each weighted by its views (no views: weight 1). Points where no curve reaches are left out. */
export function combine(curves: readonly { points: readonly Point[]; views: number | null }[]): Point[] {
  const grids = curves.map((c) => ({ g: resample(c.points), w: c.views && c.views > 0 ? c.views : 1 }));
  const out: Point[] = [];
  for (let x = 0; x <= 100; x++) {
    let sum = 0;
    let wsum = 0;
    for (const { g, w } of grids) {
      const y = g[x];
      if (y === null || y === undefined) continue;
      sum += y * w;
      wsum += w;
    }
    if (wsum > 0) out.push([x, sum / wsum]);
  }
  return out;
}

/** The steepest fall over a 5-unit window: the dot sits in the window's middle. Null when the curve never falls. */
export function biggestDrop(points: readonly Point[], window = 5): { x: number; y: number; fall: number } | null {
  const g = resample(points);
  let best: { x: number; y: number; fall: number } | null = null;
  for (let s = 0; s + window <= 100; s++) {
    const a = g[s];
    const b = g[s + window];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const fall = a - b;
    if (fall > 0 && (!best || fall > best.fall)) best = { x: s + window / 2, y: (a + b) / 2, fall };
  }
  return best;
}

/** Where the curve first goes under half the viewers (x), or null when most stay to the end. */
export function halfGone(points: readonly Point[]): number | null {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  return sorted.find(([, y]) => y < 50)?.[0] ?? null;
}

export type Marker =
  | { kind: "line"; platform: Platform; x: number; label: string; spoken: string }
  | { kind: "dot"; platform: Platform; x: number; y: number; label: string; spoken: string };

const clampX = (x: number) => Math.max(0, Math.min(100, x));

/** What an app does say about watching, when it sends no curve (never invented). TikTok: none. */
export function markersFor(platform: Platform, m: PostMetrics, durationSec: number, hasCurve: boolean): Marker[] {
  const x = extraOf(m);
  const name = PLATFORM_LABEL[platform];
  const dur = durationSec > 0 ? durationSec : 0;
  const avgLine = (sec: number): Marker => ({
    kind: "line",
    platform,
    x: clampX((sec / dur) * 100),
    label: `Avg watch ${mss(sec)}`,
    spoken: `${name}: people watch ${mss(sec)} on average`,
  });
  const out: Marker[] = [];
  switch (platform) {
    case "instagram":
      if (dur && typeof x.avgWatchSeconds === "number") out.push(avgLine(x.avgWatchSeconds));
      if (dur && typeof x.skipRatePercent === "number") {
        const stay = Math.max(0, 100 - x.skipRatePercent);
        out.push({
          kind: "dot",
          platform,
          x: clampX((3 / dur) * 100),
          y: stay,
          label: `${Math.round(stay)}% past 0:03`,
          spoken: `${name}: ${Math.round(stay)}% watch past 3 seconds`,
        });
      }
      break;
    case "youtube":
      if (!hasCurve && typeof x.avgViewPercent === "number")
        out.push({
          kind: "line",
          platform,
          x: clampX(x.avgViewPercent),
          label: `Avg watch ${mss((x.avgViewPercent / 100) * dur)}`,
          spoken: `${name}: people watch ${Math.round(x.avgViewPercent)}% on average`,
        });
      break;
    case "facebook":
      if (!hasCurve && dur && typeof x.avgWatchSeconds === "number") out.push(avgLine(x.avgWatchSeconds));
      break;
    case "x": {
      const p0 = x.playback0;
      if (typeof p0 === "number" && p0 > 0) {
        for (const [q, v] of [
          [25, x.playback25],
          [50, x.playback50],
          [75, x.playback75],
          [100, x.playback100],
        ] as const) {
          if (typeof v !== "number") continue;
          const y = (v / p0) * 100;
          out.push({ kind: "dot", platform, x: q, y, label: `${Math.round(y)}% at ${q}%`, spoken: `${name}: ${Math.round(y)}% still watching at ${q}%` });
        }
      }
      break;
    }
    default:
      break;
  }
  return out;
}

const join = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
/** Apps that never send a curve. */
const NO_CURVE_EVER: Platform[] = ["instagram", "tiktok", "x"];

export interface WatchView {
  /** The curve drawn (empty: none). */
  curve: Point[];
  drop: { x: number; y: number; fall: number; sec: number } | null;
  markers: Marker[];
  /** Top of the y axis: 100, or more when a YouTube curve goes above it (rewatches). */
  yMax: number;
  /** One short line under the graph (sources, or why there is no graph). */
  note: string | null;
  /** Nothing to draw at all. */
  empty: boolean;
  /** For the image's label: "Most viewers stay to 0:05; biggest drop at 0:03". */
  summary: string;
}

/** Everything the watch graph shows for the chosen apps. */
export function watchView(perf: Pick<ClipPerformance, "posts" | "clip">, filter: EngFilter = "all"): WatchView {
  const dur = perf.clip.durationSec || 0;
  const chosen = engagedPlatforms(perf).filter((p) => filter === "all" || p === filter);
  const curves: { platform: Platform; points: Point[]; views: number | null }[] = [];
  const markers: Marker[] = [];
  for (const pl of chosen) {
    const m = stackOf(perf, pl)!.metrics!;
    const pts = (m.retention?.points ?? []).filter((p): p is Point => Array.isArray(p) && p.length >= 2);
    const has = pts.length >= 2;
    if (has) curves.push({ platform: pl, points: pts, views: m.views });
    markers.push(...markersFor(pl, m, dur, has));
  }
  const curve = combine(curves);
  const d = curve.length ? biggestDrop(curve) : null;
  const drop = d ? { ...d, sec: (d.x / 100) * dur } : null;
  const top = Math.max(100, ...curve.map((p) => p[1]), ...markers.map((mk) => (mk.kind === "dot" ? mk.y : 0)));
  const yMax = Math.ceil(top / 10) * 10;

  const withCurve = curves.map((c) => PLATFORM_LABEL[c.platform]);
  const never = chosen.filter((p) => NO_CURVE_EVER.includes(p));
  const later = chosen.filter((p) => !NO_CURVE_EVER.includes(p) && !curves.some((c) => c.platform === p));
  const empty = !curve.length && !markers.length;
  let note: string | null;
  if (filter === "tiktok" || (chosen.length === 1 && chosen[0] === "tiktok")) note = "TikTok doesn't share how long people watch.";
  else if (filter !== "all") note = curves.length ? null : never.length ? `${PLATFORM_LABEL[filter]} doesn't share a curve.` : "The curve comes in a day or two.";
  else {
    const parts: string[] = [];
    if (withCurve.length) parts.push(`From ${join(withCurve)}.`);
    if (never.length) parts.push(`${join(never.map((p) => PLATFORM_LABEL[p]))} ${never.length > 1 ? "don't" : "doesn't"} share a curve.`);
    if (later.length && withCurve.length) parts.push(`${join(later.map((p) => PLATFORM_LABEL[p]))} comes later.`);
    note = parts.join(" ") || null;
  }
  if (empty && note !== "TikTok doesn't share how long people watch.") note = null;

  let summary = "";
  if (curve.length) {
    const half = halfGone(curve);
    summary = half === null ? "Most viewers stay to the end" : `Most viewers stay to ${mss((half / 100) * dur)}`;
    if (drop) summary += `; biggest drop at ${mss(drop.sec)}`;
  } else if (markers.length) summary = markers.map((mk) => mk.spoken).join("; ");
  return { curve, drop, markers, yMax, note, empty, summary };
}
