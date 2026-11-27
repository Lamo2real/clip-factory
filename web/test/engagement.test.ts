import { describe, expect, it } from "vitest";
import type { ClipPerformance, Platform, PlatformPerformance, PostMetrics } from "../src/api/types.ts";
import {
  biggestDrop,
  combine,
  engagedPlatforms,
  engagement,
  formatRate,
  markersFor,
  mss,
  partsFor,
  resample,
  statusWord,
  watchView,
  type Point,
} from "../src/lib/engagement.ts";

const at = "2026-11-27T10:00:00Z";
const m = (o: Partial<PostMetrics>): PostMetrics => ({ views: null, likes: null, comments: null, shares: null, checkedAt: at, ...o });
const stack = (platform: Platform, metrics: PostMetrics | null, status: PlatformPerformance["status"] = "posted"): PlatformPerformance => ({
  platform,
  status,
  account: "connected",
  metrics,
  refreshing: false,
  final: false,
});
const perfOf = (posts: PlatformPerformance[], durationSec = 30) =>
  ({ posts, clip: { durationSec } }) as unknown as Pick<ClipPerformance, "posts" | "clip">;

describe("engagement rate", () => {
  it("counts each app's own interactions", () => {
    expect(partsFor("youtube", m({ views: 100, likes: 5, comments: 1, shares: 1 }))).toMatchObject({ likes: 5, comments: 1, shares: 1, saves: 0 });
    expect(partsFor("instagram", m({ views: 100, likes: 5, comments: 1, shares: 1, extra: { saved: 3 } })).saves).toBe(3);
    const fb = partsFor("facebook", m({ views: 100, likes: 4, extra: { commentsAndShares: 2 } }));
    expect(fb).toMatchObject({ likes: 4, comments: 0, shares: 0, commentsAndShares: 2 });
    const x = partsFor("x", m({ views: 100, likes: 2, comments: 1, shares: 9, extra: { reposts: 3, quotes: 1, bookmarks: 2 } }));
    expect(x).toMatchObject({ likes: 2, comments: 1, shares: 4, saves: 2 });
    // No reposts: X's shares stand in.
    expect(partsFor("x", m({ views: 100, shares: 5 })).shares).toBe(5);
  });

  it("gives a rate per app and a view-weighted All", () => {
    const perf = perfOf([
      stack("youtube", m({ views: 1000, likes: 40, comments: 5, shares: 5 })), // 5%
      stack("tiktok", m({ views: 100, likes: 15, comments: 3, shares: 2 })), // 20%
    ]);
    expect(engagement(perf, "youtube").rate).toBeCloseTo(5);
    expect(engagement(perf, "tiktok").rate).toBeCloseTo(20);
    // (50 + 20) / 1100, not the plain average of 5% and 20%.
    expect(engagement(perf).rate).toBeCloseTo((70 / 1100) * 100);
    expect(formatRate(engagement(perf).rate)).toBe("6.4%");
  });

  it("treats missing numbers as 0 and leaves out apps with no views", () => {
    const perf = perfOf([
      stack("youtube", m({ views: 200, likes: 10 })),
      stack("instagram", m({ views: null, likes: 50 })),
      stack("x", m({ views: 0, likes: 50 })),
    ]);
    const e = engagement(perf);
    expect(e.rate).toBeCloseTo(5);
    expect(e.platforms).toEqual(["youtube"]);
  });

  it("says – with no views anywhere", () => {
    const e = engagement(perfOf([stack("tiktok", m({ views: null }))]));
    expect(e.rate).toBeNull();
    expect(formatRate(e.rate)).toBe("–");
  });

  it("only counts posted apps with numbers", () => {
    const perf = perfOf([stack("youtube", m({ views: 10 })), stack("tiktok", null), stack("x", m({ views: 5 }), "failed")]);
    expect(engagedPlatforms(perf)).toEqual(["youtube"]);
  });

  it("has one status word", () => {
    expect(statusWord(0.4)).toBe("Low");
    expect(statusWord(1)).toBe("OK");
    expect(statusWord(2.99)).toBe("OK");
    expect(statusWord(3)).toBe("Good");
    expect(statusWord(6)).toBe("Great");
    expect(statusWord(10)).toBe("Amazing");
  });
});

describe("how long people watch", () => {
  it("resamples only inside a curve's own range", () => {
    const g = resample([
      [10, 100],
      [20, 50],
    ]);
    expect(g.length).toBe(101);
    expect(g[9]).toBeNull();
    expect(g[15]).toBeCloseTo(75);
    expect(g[21]).toBeNull();
  });

  it("averages curves by views (no views: weight 1)", () => {
    const flat = (y: number): Point[] => [
      [0, y],
      [100, y],
    ];
    const c = combine([
      { points: flat(100), views: 300 },
      { points: flat(20), views: 100 },
    ]);
    expect(c).toHaveLength(101);
    expect(c[50]![1]).toBeCloseTo(80);
    const w1 = combine([
      { points: flat(100), views: null },
      { points: flat(0), views: 1 },
    ]);
    expect(w1[0]![1]).toBeCloseTo(50);
    // Where only one curve reaches, only that one counts.
    const part = combine([
      { points: flat(60), views: 10 },
      { points: [[0, 100], [50, 100]], views: 1000 },
    ]);
    expect(part[80]![1]).toBeCloseTo(60);
  });

  it("finds the steepest fall over 5 units", () => {
    const d = biggestDrop([
      [0, 100],
      [20, 90],
      [30, 40],
      [100, 30],
    ]);
    expect(d).not.toBeNull();
    expect(d!.x).toBeGreaterThanOrEqual(20);
    expect(d!.x).toBeLessThanOrEqual(30);
    expect(d!.fall).toBeCloseTo(25);
    expect(biggestDrop([[0, 50], [100, 50]])).toBeNull();
  });

  it("puts the drop in seconds and keeps a YouTube curve above 100", () => {
    const w = watchView(
      perfOf([
        stack("youtube", m({ views: 100, retention: { points: [[0, 100], [10, 60], [90, 40], [100, 112]] } })),
      ]),
    );
    expect(w.drop!.sec).toBeCloseTo((w.drop!.x / 100) * 30);
    expect(w.yMax).toBe(120);
    expect(w.summary).toBe("Most viewers stay to 0:15; biggest drop at 0:01");
    expect(mss(75)).toBe("1:15");
  });

  it("shows Instagram's skip dot and avg line", () => {
    const mk = markersFor("instagram", m({ views: 10, extra: { avgWatchSeconds: 12, skipRatePercent: 30 } }), 30, false);
    expect(mk).toContainEqual(expect.objectContaining({ kind: "line", x: 40, label: "Avg watch 0:12" }));
    expect(mk).toContainEqual(expect.objectContaining({ kind: "dot", x: 10, y: 70 }));
  });

  it("shows X's quartiles", () => {
    const mk = markersFor("x", m({ views: 10, extra: { playback0: 200, playback25: 150, playback50: 100, playback75: 50, playback100: 20 } }), 30, false);
    expect(mk.map((d) => (d.kind === "dot" ? [d.x, d.y] : null))).toEqual([
      [25, 75],
      [50, 50],
      [75, 25],
      [100, 10],
    ]);
    expect(markersFor("x", m({ extra: { playback0: 0, playback25: 5 } }), 30, false)).toEqual([]);
  });

  it("gives TikTok no markers and never invents a curve", () => {
    expect(markersFor("tiktok", m({ views: 100, likes: 5 }), 30, false)).toEqual([]);
    const w = watchView(perfOf([stack("tiktok", m({ views: 100 }))]));
    expect(w.curve).toEqual([]);
    expect(w.note).toBe("TikTok doesn't share how long people watch.");
  });

  it("uses YouTube's avg only without a curve, and names the sources in All", () => {
    expect(markersFor("youtube", m({ extra: { avgViewPercent: 50 } }), 30, true)).toEqual([]);
    expect(markersFor("youtube", m({ extra: { avgViewPercent: 50 } }), 30, false)[0]).toMatchObject({ kind: "line", x: 50 });
    const w = watchView(
      perfOf([
        stack("youtube", m({ views: 100, retention: { points: [[0, 100], [100, 40]] } })),
        stack("facebook", m({ views: 50, retention: { points: [[0, 100], [100, 20]] } })),
        stack("instagram", m({ views: 10 })),
        stack("tiktok", m({ views: 10 })),
      ]),
    );
    expect(w.note).toBe("From YouTube and Facebook. TikTok and Instagram don't share a curve.");
    expect(w.curve.at(-1)![1]).toBeCloseTo((40 * 100 + 20 * 50) / 150);
  });

  it("is calmly empty when nothing has come in", () => {
    const w = watchView(perfOf([stack("youtube", m({ views: 10 }))]));
    expect(w.empty).toBe(true);
    expect(w.note).toBeNull();
  });
});
