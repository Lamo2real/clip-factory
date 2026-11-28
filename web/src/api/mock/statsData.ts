// Believable numbers for mock mode: each platform's own fields (docs/CONTRACTS.md §16.3), a growth curve for the
// sparklines, and the WEEK item shape. Deterministic from a seed, so screenshots stay the same.
import type { LearnState, Platform, PostMetrics, SeriesPoint } from "../types.ts";

export interface WeekItem {
  week: string;
  from: string;
  to: string;
  clipIds: string[];
  savedAt?: string;
  learnState: LearnState;
  learningId?: string;
  revision: number;
}

/** A repeatable 0..1 from a seed. */
export function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const r = Math.round;
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A believable "how long people watch" curve: a hook drop in the first 3 seconds, a slow decline, and on YouTube a
 * small rewatch bump near the end. `buckets` points from 0 to 100 % of the length (Facebook sends 40).
 */
export function retentionCurve(platform: "youtube" | "facebook", durationSec: number, seed: number, buckets: number): [number, number][] {
  const hook = Math.min(40, (3 / Math.max(durationSec, 4)) * 100);
  const n = noise(seed + 7);
  const kept = (platform === "youtube" ? 72 : 60) + n * 8;
  const end = (platform === "youtube" ? 40 : 30) + n * 6;
  const out: [number, number][] = [];
  for (let i = 0; i < buckets; i++) {
    const x = (i * 100) / (buckets - 1);
    let y: number;
    if (x <= hook) y = 100 - (100 - kept) * Math.sin(((x / hook) * Math.PI) / 2);
    else y = kept - (kept - end) * Math.pow((x - hook) / (100 - hook), 0.8);
    if (platform === "youtube" && x > 88) y += 7 * Math.sin(((x - 88) / 12) * Math.PI);
    y += (noise(seed * 31 + i) - 0.5) * 1.6;
    out.push([r1(x), r1(Math.max(0, y))]);
  }
  return out;
}

/**
 * One post's metrics. `insights: false` stands for "the slow numbers are not in yet": Instagram then has no views,
 * YouTube no Analytics fields. Fields a platform never sends are absent, never 0.
 */
export function metricsFor(
  platform: Platform,
  views: number,
  durationSec: number,
  seed: number,
  { insights = true, checkedAt, insightsAt }: { insights?: boolean; checkedAt: string; insightsAt?: string },
): PostMetrics {
  const n = noise(seed);
  const likeRate = 0.045 + n * 0.05;
  const base = { checkedAt, metricsUpdatedAt: checkedAt };
  const slow = insights && insightsAt ? { insightsUpdatedAt: insightsAt } : {};
  const watched = 0.42 + n * 0.3;
  switch (platform) {
    case "youtube":
      return {
        ...base,
        ...slow,
        views,
        likes: r(views * likeRate),
        comments: r(views * 0.004),
        shares: insights ? r(views * 0.007) : null,
        extra: insights
          ? {
              engagedViews: r(views * 0.81),
              watchMinutes: r((views * durationSec * watched) / 60),
              avgViewSeconds: r(durationSec * watched),
              avgViewPercent: r(watched * 1000) / 10,
              subscribersGained: r(views * 0.0021),
            }
          : {},
        ...(insights ? { retention: { points: retentionCurve("youtube", durationSec, seed, 51), readAt: insightsAt ?? checkedAt, source: "youtube" as const } } : {}),
      };
    case "tiktok":
      return { ...base, views, likes: r(views * (likeRate + 0.03)), comments: r(views * 0.006), shares: r(views * 0.011), extra: {} };
    case "instagram":
      return {
        ...base,
        ...slow,
        views: insights ? views : null,
        likes: r(views * likeRate),
        comments: r(views * 0.005),
        shares: insights ? r(views * 0.009) : null,
        extra: insights
          ? {
              reach: r(views * 0.72),
              saved: r(views * 0.012),
              reposts: r(views * 0.002),
              totalInteractions: r(views * (likeRate + 0.03)),
              avgWatchSeconds: r(durationSec * watched * 10) / 10,
              totalWatchSeconds: r(views * durationSec * watched),
              skipRatePercent: r((0.18 + n * 0.2) * 1000) / 10,
            }
          : {},
      };
    case "facebook": {
      const like = r(views * likeRate * 0.7);
      const love = r(views * 0.006);
      const haha = r(views * 0.004);
      const wow = r(views * 0.0015);
      return {
        ...base,
        insightsUpdatedAt: insightsAt ?? checkedAt,
        views,
        likes: like + love + haha + wow,
        comments: null,
        shares: null,
        extra: {
          initialPlays: r(views * 0.83),
          replays: r(views * 0.17),
          reactions: { like, love, haha, wow },
          commentsAndShares: r(views * 0.009),
          avgWatchSeconds: r(durationSec * (watched - 0.1) * 10) / 10,
          totalWatchSeconds: r(views * durationSec * (watched - 0.1)),
          followsGained: r(views * 0.0012),
          ...(seed % 2 === 0 ? { reachUnique: r(views * 0.66) } : {}),
        },
        retention: { points: retentionCurve("facebook", durationSec, seed, 40), readAt: insightsAt ?? checkedAt, source: "facebook" },
      };
    }
    case "x":
      return {
        ...base,
        views,
        likes: r(views * likeRate * 0.8),
        comments: r(views * 0.007),
        shares: r(views * 0.012),
        extra: {
          impressions: r(views * 2.7),
          reposts: r(views * 0.012),
          quotes: r(views * 0.002),
          bookmarks: r(views * 0.006),
          linkClicks: r(views * 0.004),
          profileClicks: r(views * 0.009),
          engagements: r(views * 0.11),
          playback0: views,
          playback25: r(views * 0.71),
          playback50: r(views * 0.48),
          playback75: r(views * 0.31),
          playback100: r(views * 0.19),
        },
      };
  }
}

/** Views over time from posting until `untilMs`, ending exactly on `views`: fast at first, then flattening. */
export function growth(fromMs: number, untilMs: number, views: number): SeriesPoint[] {
  const span = Math.max(untilMs - fromMs, 60_000);
  // Hourly points, but at least a dozen so even a post from this morning draws a real curve.
  const count = Math.max(12, Math.min(24, Math.round(span / 3_600_000) + 1));
  const k = 3.2;
  const points: SeriesPoint[] = [];
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const at = fromMs + span * f;
    const v = i === count - 1 ? views : Math.round((views * (1 - Math.exp(-k * f))) / (1 - Math.exp(-k)));
    points.push({ at: new Date(at).toISOString(), views: v });
  }
  return points;
}

/** The next numbers after a refresh: a little growth on every count that exists. */
export function grow(m: PostMetrics, step: number, at: string): PostMetrics {
  const up = (v: number | null, rate: number) => (v === null ? null : v + Math.max(1, Math.round(v * rate)) + (step % 3));
  const extra = { ...(m.extra ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === "number" && !/Percent|avg/i.test(k)) extra[k] = v + Math.max(1, Math.round(v * 0.03));
  }
  return {
    ...m,
    views: up(m.views, 0.04),
    likes: up(m.likes, 0.03),
    comments: up(m.comments, 0.02),
    shares: up(m.shares, 0.02),
    checkedAt: at,
    metricsUpdatedAt: at,
    extra: extra as PostMetrics["extra"],
  };
}
