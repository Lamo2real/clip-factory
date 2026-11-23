import { afterEach, describe, expect, it, vi } from "vitest";
import { httpApi } from "../src/api/http.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import { statsApi } from "../src/api/mock/stats.ts";
import type { ClipPerformance, LiveEvent, Post, WeekView } from "../src/api/types.ts";
import { parseLiveMessage } from "../src/lib/live.ts";
import { applyPerfEvent, applyWeekEvent } from "../src/lib/liveCache.ts";
import { STATS_ORDER } from "../src/lib/metrics.ts";
import { isoWeek, shiftWeek, weekRange } from "../src/lib/week.ts";
import { FAN_MIN, ROWS_MIN, layoutFor, refreshMessage, refreshState, winner } from "../src/screens/clip/ClipPerformance.tsx";
import { bestApp, weekApps } from "../src/screens/library/WeekView.tsx";

const T = "2026-11-16T10:00:00.000Z";

function perf(): ClipPerformance {
  return {
    clip: { clipId: "C1", hook: "Hook", coverUrl: "cover", videoUrl: "video" } as ClipPerformance["clip"],
    posts: STATS_ORDER.map((platform) => ({
      platform,
      status: platform === "x" ? "not_posted" : "posted",
      account: "connected",
      postId: `P-${platform}`,
      metrics: platform === "x" ? null : { views: 100, likes: 10, comments: 1, shares: null, checkedAt: T, metricsUpdatedAt: T, extra: {} },
      updatedAt: platform === "x" ? undefined : T,
      refreshing: false,
      final: false,
    })),
    series: { youtube: [{ at: "2026-11-16T09:00:00.000Z", views: 50 }, { at: T, views: 100 }] },
    totals: { views: 400, likes: 40, comments: 4, shares: 0, platformsPosted: 4, updatedAt: T },
    bestPlatform: "youtube",
    bestThisWeek: false,
    week: null,
    weekAnchorAt: T,
  };
}

const postEvent = (item: Partial<Post> & Pick<Post, "platform">): LiveEvent => ({
  type: "post",
  op: "upsert",
  id: `P-${item.platform}`,
  item: { postId: `P-${item.platform}`, clipId: "C1", status: "posted", ...item } as Post,
});

describe("live updates on the performance page", () => {
  it("a post upsert replaces that stack, adds a sparkline point and moves the crown", () => {
    const later = "2026-11-16T10:15:00.000Z";
    const next = applyPerfEvent(
      perf(),
      postEvent({ platform: "tiktok", metrics: { views: 900, likes: 30, comments: 2, shares: 5, checkedAt: later, metricsUpdatedAt: later, extra: {} }, nextRefreshAt: "2026-11-16T10:20:00.000Z" }),
    );
    const tt = next.posts.find((p) => p.platform === "tiktok")!;
    expect(tt).toMatchObject({ status: "posted", refreshing: false, updatedAt: later, nextAllowedAt: "2026-11-16T10:20:00.000Z" });
    expect(tt.metrics?.views).toBe(900);
    expect(next.series.tiktok).toEqual([{ at: later, views: 900 }]);
    expect(next.totals.views).toBe(1200);
    expect(next.totals.shares).toBe(5);
    expect(next.totals.updatedAt).toBe(later);
    expect(next.bestPlatform).toBe("tiktok");
  });

  it("a refresh starting shows the spinner; other clips' posts change nothing", () => {
    const p = perf();
    expect(applyPerfEvent(p, postEvent({ platform: "youtube", refreshing: true, metrics: p.posts[0]!.metrics! })).posts[0]!.refreshing).toBe(true);
    const other: LiveEvent = { type: "post", op: "upsert", id: "Z", item: { postId: "Z", clipId: "OTHER", platform: "youtube", status: "failed" } };
    expect(applyPerfEvent(p, other)).toBe(p);
  });

  it("maps post states (private, failed) and keeps the media links on clip upserts", () => {
    const p = applyPerfEvent(perf(), postEvent({ platform: "tiktok", privacy: "private" }));
    expect(p.posts[1]!.status).toBe("posted_private");
    const f = applyPerfEvent(p, postEvent({ platform: "instagram", status: "failed", error: "Too long." }));
    expect(f.posts[2]).toMatchObject({ status: "failed", error: "Too long." });
    const starred = applyPerfEvent(f, { type: "clip", op: "upsert", id: "C1", item: { ...f.clip, videoUrl: undefined, best: true, bestWeek: "2026-W47" } });
    expect(starred).toMatchObject({ bestThisWeek: true, week: "2026-W47" });
    expect(starred.clip.videoUrl).toBe("video");
  });

  it("parses week events from the socket", () => {
    const ev = parseLiveMessage(JSON.stringify({ type: "week", op: "upsert", id: "2026-W47", item: { week: "2026-W47" } }));
    expect(ev?.type).toBe("week");
  });
});

describe("This week live", () => {
  const view = (): WeekView => ({ week: "2026-W47", from: "f", to: "t", clipIds: [], learnState: "none", clips: [] });

  it("follows learnState and the week's learning", () => {
    const learning = applyWeekEvent(view(), { type: "week", op: "upsert", id: "2026-W47", item: { ...view(), clipIds: ["A"], learnState: "learning" } });
    expect(learning).toMatchObject({ learnState: "learning", clipIds: ["A"] });
    const l = { learningId: "L1", kind: "week" as const, week: "2026-W47", text: "Start on the action.", createdAt: T, postIds: [] };
    const withText = applyWeekEvent(learning, { type: "learning", op: "upsert", id: "L1", item: l });
    expect(withText.learning?.text).toBe("Start on the action.");
    const done = applyWeekEvent(withText, { type: "week", op: "upsert", id: "2026-W47", item: { ...view(), clipIds: ["A"], learnState: "done", learningId: "L1" } });
    expect(done.learning?.learningId).toBe("L1");
    // Another week's news, or a post learning, changes nothing.
    expect(applyWeekEvent(done, { type: "learning", op: "upsert", id: "L2", item: { ...l, learningId: "L2", week: "2026-W46" } })).toBe(done);
    expect(applyWeekEvent(done, { type: "learning", op: "upsert", id: "L3", item: { ...l, learningId: "L3", kind: "post" } })).toBe(done);
  });

  it("keeps the owner's unsaved stars when the server's picks arrive", () => {
    const v = { ...view(), clipIds: ["A", "B"] };
    const next = applyWeekEvent(v, { type: "week", op: "upsert", id: "2026-W47", item: { ...view(), clipIds: ["A"], learnState: "learning" } }, true);
    expect(next.clipIds).toEqual(["A", "B"]);
  });
});

describe("the Refresh numbers button", () => {
  const now = Date.parse(T);

  it("is ready, spinning, or says when the next check is", () => {
    const p = perf();
    expect(refreshState(p, now, false)).toMatchObject({ checkable: 4, refreshing: false, allWaiting: false });
    expect(refreshState(p, now, true).refreshing).toBe(true);
    const waiting = { ...p, posts: p.posts.map((s) => (s.status === "posted" ? { ...s, nextAllowedAt: "2026-11-16T10:04:00.000Z" } : s)) };
    waiting.posts[2] = { ...waiting.posts[2]!, nextAllowedAt: "2026-11-16T10:30:00.000Z" };
    expect(refreshState(waiting, now, false)).toMatchObject({ allWaiting: true, nextAt: "2026-11-16T10:04:00.000Z" });
    const nothing = { ...p, posts: p.posts.map((s) => ({ ...s, status: "not_posted" as const })) };
    expect(refreshState(nothing, now, false)).toMatchObject({ checkable: 0, allWaiting: false });
  });

  it("sums up what a refresh did in one short line", () => {
    expect(
      refreshMessage([
        { platform: "youtube", status: "started" },
        { platform: "instagram", status: "started", note: "Instagram numbers can take up to 2 days to settle." },
        { platform: "x", status: "not_posted" },
      ]),
    ).toEqual({ tone: "success", text: "Checking YouTube and Instagram now." });
    // All five: "all 5 apps", and no "settle" notes (each slow stack shows a "Can take 2 days" chip instead).
    const settle = (name: string) => `${name} numbers can take up to 2 days to settle.`;
    const all = refreshMessage([
      { platform: "youtube", status: "started" },
      { platform: "tiktok", status: "started" },
      { platform: "instagram", status: "started", note: settle("Instagram") },
      { platform: "facebook", status: "started", note: settle("Facebook") },
      { platform: "x", status: "started" },
    ]);
    expect(all).toEqual({ tone: "success", text: "Checking all 5 apps now." });
    expect(refreshMessage([{ platform: "tiktok", status: "started" }]).text).toBe("Checking TikTok now.");
    expect(refreshMessage([{ platform: "youtube", status: "too_soon", nextAllowedAt: "2026-11-16T10:04:00.000Z" }], now).text).toBe(
      "Next check in 4 min. Each app only lets Clip Factory look so often.",
    );
    expect(refreshMessage([{ platform: "tiktok", status: "private", note: "TikTok shows numbers after the app is approved." }]).text).toBe(
      "TikTok shows numbers after the app is approved.",
    );
  });
});

describe("the page layout and the winner", () => {
  it("picks fan, rows or trunk from the stage's own width", () => {
    expect(layoutFor(1102)).toBe("fan");
    expect(layoutFor(FAN_MIN)).toBe("fan");
    expect(layoutFor(FAN_MIN - 1)).toBe("rows");
    expect(layoutFor(692)).toBe("rows"); // 1024 px laptop with the sidebar open
    expect(layoutFor(ROWS_MIN)).toBe("rows");
    expect(layoutFor(ROWS_MIN - 1)).toBe("trunk");
    expect(layoutFor(450)).toBe("trunk"); // 768 px tablet with the sidebar open
    // Every layout leaves a stack at least about 190 px wide (fan: 5 columns, 14 px gaps; rows: 2 of 6 tracks, 24 px gaps).
    expect((FAN_MIN - 4 * 14) / 5).toBeGreaterThanOrEqual(190);
    expect(((ROWS_MIN - 5 * 24) / 6) * 2 + 24).toBeGreaterThanOrEqual(190);
  });

  it("names the best platform with its views, or nothing when there are no numbers", () => {
    expect(winner(perf())).toEqual({ platform: "youtube", views: 100 });
    expect(winner({ ...perf(), bestPlatform: null })).toBeNull();
    const p = perf();
    expect(winner({ ...p, bestPlatform: "x" })).toBeNull();
  });
});

describe("This week rows", () => {
  it("lists only the apps the clip is on, in order, and finds the best one", () => {
    const apps = weekApps({ views: { x: 3400, youtube: 48200, tiktok: 126400, instagram: null } });
    expect(apps).toEqual([
      { platform: "youtube", views: 48200 },
      { platform: "tiktok", views: 126400 },
      { platform: "instagram", views: null },
      { platform: "x", views: 3400 },
    ]);
    expect(bestApp(apps)).toBe("tiktok");
    expect(bestApp(weekApps({ views: {} }))).toBeNull();
    expect(bestApp([{ platform: "youtube", views: 0 }, { platform: "x", views: null }])).toBeNull();
  });
});

describe("§16 routes over HTTP", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("calls the four routes with the right methods, paths and bodies", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/performance")) return ok({ clip: {}, posts: [] });
      if (url.includes("/stats/refresh")) return ok({ platforms: [{ platform: "youtube", status: "started" }] });
      return ok({ week: { week: "2026-W47", clips: [] } });
    });
    const api = httpApi({ baseUrl: "https://api.test", auth: { accessToken: async () => "t" }, fetcher: fetcher as unknown as typeof fetch });
    await api.clipPerformance("C1");
    expect(await api.refreshStats("C1", ["youtube"])).toEqual([{ platform: "youtube", status: "started" }]);
    await api.getWeek("2026-W47", "2026-11-15T23:00:00.000Z", "2026-11-22T23:00:00.000Z");
    await api.saveWeekBest("2026-W47", { from: "a", to: "b", clipIds: ["C1"] });
    const calls = fetcher.mock.calls.map(([url, init]) => [url, init?.method, init?.body]);
    expect(calls).toEqual([
      ["https://api.test/v1/clips/C1/performance", "GET", undefined],
      ["https://api.test/v1/clips/C1/stats/refresh", "POST", JSON.stringify({ platforms: ["youtube"] })],
      ["https://api.test/v1/weeks/2026-W47?from=2026-11-15T23%3A00%3A00.000Z&to=2026-11-22T23%3A00%3A00.000Z", "GET", undefined],
      ["https://api.test/v1/weeks/2026-W47/best", "PUT", JSON.stringify({ from: "a", to: "b", clipIds: ["C1"] })],
    ]);
  });
});

describe("mock stats", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const store = seed();
    const events: LiveEvent[] = [];
    const s = statsApi({ store, publish: (e) => events.push(e), faults: {}, automated: () => true });
    return { store, s, events };
  }

  it("always answers five stacks in order, covering every state", () => {
    const { store, s } = setup();
    const states = new Set<string>();
    for (const c of store.clips.filter((x) => x.status === "posted" || x.status === "confirmed")) {
      const p = s.performance(c.clipId);
      expect(p.posts.map((x) => x.platform)).toEqual([...STATS_ORDER]);
      for (const x of p.posts) states.add(x.metrics ? `${x.status}+numbers` : x.status);
    }
    for (const want of ["posted+numbers", "posted", "posted_private", "waiting_for_connection", "posting", "failed", "not_posted"])
      expect(states).toContain(want);
    const review = store.clips.find((c) => c.status === "review")!;
    expect(() => s.performance(review.clipId)).toThrow(/Upload it first/);
  });

  it("refreshes, then says too soon until the cooldown passes; numbers arrive as post events", () => {
    vi.useFakeTimers();
    const { store, s, events } = setup();
    const clip = store.clips.find((c) => c.status === "posted" && s.performance(c.clipId).bestPlatform === "tiktok")!;
    const first = s.refresh(clip.clipId);
    expect(first.map((r) => r.status)).toEqual(["started", "started", "started", "started", "started"]);
    expect(first.find((r) => r.platform === "instagram")?.note).toBe("Instagram numbers can take up to 2 days to settle.");
    const before = s.performance(clip.clipId).totals.views;
    vi.advanceTimersByTime(2000);
    expect(events.filter((e) => e.type === "post").length).toBeGreaterThanOrEqual(10);
    expect(s.performance(clip.clipId).totals.views).toBeGreaterThan(before);
    expect(s.refresh(clip.clipId).every((r) => r.status === "too_soon" && r.nextAllowedAt)).toBe(true);
  });

  it("saves the week's picks once, learns, and rejects clips from another week", () => {
    // A fixed mid-week moment (Wednesday 18 November 2026, local noon): on the real clock this failed just after
    // Monday 00:00, when the week had only just begun.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12, 0, 0));
    const { s, events } = setup();
    const week = isoWeek(new Date());
    expect(week).toBe("2026-W47");
    const r = weekRange(week);
    const v = s.getWeek(week, r.from, r.to);
    expect(v.clips.length).toBeGreaterThan(0);
    expect(v.clips.map((c) => c.totals.views)).toEqual([...v.clips.map((c) => c.totals.views)].sort((a, b) => b - a));
    const pick = v.clips[0]!.clip.clipId;
    const saved = s.saveBest(week, { ...r, clipIds: [pick] });
    expect(saved.learnState).toBe("learning");
    expect(saved.clips[0]!.best).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(events.some((e) => e.type === "learning" && e.item?.kind === "week")).toBe(true);
    expect(s.getWeek(week, r.from, r.to)).toMatchObject({ learnState: "done", clipIds: [pick] });
    // The same picks again: nothing new starts.
    const n = events.length;
    s.saveBest(week, { ...r, clipIds: [pick] });
    expect(events.length).toBe(n);
    const last = s.getWeek(shiftWeek(week, -1), weekRange(shiftWeek(week, -1)).from, weekRange(shiftWeek(week, -1)).to);
    expect(() => s.saveBest(week, { ...r, clipIds: [last.clips[0]!.clip.clipId] })).toThrow("Pick clips from this week only.");
    expect(() => s.getWeek(week, r.from, new Date(Date.parse(r.to) + 5 * 3_600_000).toISOString())).toThrow(/does not look right/);
  });

  it("dates this week's posted clips inside this week, even in its first minute or its last", () => {
    vi.useFakeTimers();
    // Local Monday 00:00:30 (the seed once put these clips before Monday 00:00 there) and Sunday 23:59:30.
    for (const at of [new Date(2026, 10, 23, 0, 0, 30), new Date(2026, 10, 29, 23, 59, 30)]) {
      vi.setSystemTime(at);
      const { s } = setup();
      const week = isoWeek(at);
      const r = weekRange(week);
      expect(s.getWeek(week, r.from, r.to).clips.filter((c) => c.posted).map((c) => c.clip.hook)).toHaveLength(3);
    }
  });
});
