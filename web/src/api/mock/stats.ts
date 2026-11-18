// Mock mode's §16 routes: clip performance, the stats refresh (numbers arrive later as live `post` events, like the
// real cf-prod-stats Lambda) and This week with its "Best of week" learning. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type {
  Clip,
  ClipPerformance,
  Learning,
  LiveEvent,
  Platform,
  PlatformPerformance,
  Post,
  RefreshResult,
  WeekClip,
  WeekView,
} from "../types.ts";
import { MANUAL_COOLDOWN_MIN, STATS_ORDER, perfStatus, pickBest } from "../../lib/metrics.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { isWeek, weekBoundsOk } from "../../lib/week.ts";
import { metricsFor, grow, type WeekItem } from "./statsData.ts";
import { ulid, type Store } from "./fixtures.ts";

const clone = <T>(v: T): T => structuredClone(v);

/** Whether the pretend money scenario (mock/money.ts, sessionStorage) is one where YouTube reports money. */
function moneyScenarioEarns(): boolean {
  try {
    const raw = JSON.parse(sessionStorage.getItem("cf-mock-money") ?? "null") as { scenario?: string } | null;
    return raw?.scenario === "earning" || raw?.scenario === "facebook_verified";
  } catch {
    return false;
  }
}
const MIN = 60_000;
const IN_LIBRARY = new Set<Clip["status"]>(["confirmed", "publishing", "posted", "failed"]);

export interface StatsFaults {
  /** Platforms whose rate budget is used up (refresh answers `blocked`). */
  statsBlocked?: Platform[];
  /** The next "Best of week" learning fails. */
  learnFails?: boolean;
}

/** Test knobs, reachable as window.__cfMockStats. */
export interface MockStatsControls {
  /** Like the 15-minute poller: fresh numbers for every measured post of a clip (or every clip), pushed live. */
  poll(clipId?: string): number;
  /** PUT /weeks/…/best calls so far (to prove the star toggles are saved in one request). */
  weekSaves(): number;
}

interface Deps {
  store: Store;
  publish: (ev: LiveEvent) => void;
  faults: StatsFaults;
  automated: () => boolean;
}

const notFound = () => new ApiError(404, "not_found", "This clip has no numbers yet. Keep it first.");
const badWeek = () => new ApiError(400, "bad_request", "That week does not look right. Go back to This week.");

export function statsApi({ store, publish, faults, automated }: Deps) {
  let step = 0;
  let saves = 0;

  const publicClip = (c: Clip): Clip => {
    const { videoUrl: _v, coverUrl: _c, ...rest } = clone(withTotal(c));
    return rest;
  };
  const publishPost = (p: Post) => publish({ type: "post", op: "upsert", id: p.postId, item: clone(p) });
  const publishClip = (c: Clip) => publish({ type: "clip", op: "upsert", id: c.clipId, item: publicClip(c) });

  const postsOf = (clipId: string) => store.posts.filter((p) => p.clipId === clipId);

  function withTotal(c: Clip): Clip {
    const measured = postsOf(c.clipId).filter((p) => p.status === "posted" && p.metrics);
    if (!measured.length) return c;
    return { ...c, totalViews: measured.reduce((n, p) => n + (p.metrics?.views ?? 0), 0) };
  }

  function anchorOf(c: Clip): string {
    const posted = postsOf(c.clipId)
      .map((p) => p.postedAt)
      .filter((t): t is string => !!t)
      .sort();
    return posted[0] ?? c.decidedAt ?? c.createdAt;
  }

  /** Every platform is "connected" once something was posted there; otherwise the stored account decides. */
  function accountOf(platform: Platform): PlatformPerformance["account"] {
    if (store.posts.some((p) => p.platform === platform && p.status === "posted")) return "connected";
    const status = store.accounts.find((a) => a.platform === platform)?.status;
    return status === "connected" || status === "needs_reconnect" ? status : "not_connected";
  }

  /** §25.3 in the pretend app: YouTube's estimate per clip, only when the money scenario is one that earns. */
  function reportedMoney(platform: Platform, post: Post | undefined): PlatformPerformance["revenue"] | undefined {
    if (platform !== "youtube" || post?.status !== "posted" || !moneyScenarioEarns()) return undefined;
    const seedOf = [...post.postId].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 1_000_003, 7);
    return {
      platform,
      amountMicros: 40_000 + (seedOf % 900) * 1_000,
      currency: "USD",
      source: "youtube.estimatedRevenue",
      through: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      tag: "YouTube's estimate",
    };
  }

  function stack(platform: Platform, post: Post | undefined, now: number): PlatformPerformance {
    const m = post?.metrics ?? null;
    const revenue = reportedMoney(platform, post);
    return {
      platform,
      status: perfStatus(post),
      account: accountOf(platform),
      ...(post ? { postId: post.postId } : {}),
      ...(post?.url ? { url: post.url } : {}),
      ...(post?.postedAt ? { postedAt: post.postedAt } : {}),
      metrics: m ? clone(m) : null,
      ...(m ? { updatedAt: m.metricsUpdatedAt ?? m.checkedAt } : {}),
      ...(m?.insightsUpdatedAt ? { insightsUpdatedAt: m.insightsUpdatedAt } : {}),
      ...(post?.nextRefreshAt && Date.parse(post.nextRefreshAt) > now ? { nextAllowedAt: post.nextRefreshAt } : {}),
      refreshing: post?.refreshing === true,
      final: m?.final === true,
      ...(post?.error ? { error: post.error } : {}),
      ...(revenue ? { revenue } : {}),
    };
  }

  function performance(clipId: string): ClipPerformance {
    const now = Date.now();
    const c = store.clips.find((x) => x.clipId === clipId);
    if (!c || !IN_LIBRARY.has(c.status)) throw notFound();
    const posts = postsOf(clipId);
    const stacks = STATS_ORDER.map((platform) => stack(platform, posts.find((p) => p.platform === platform), now));
    const series: ClipPerformance["series"] = {};
    for (const s of stacks) {
      const points = s.postId ? store.snapshots[s.postId] : undefined;
      if (points?.length) series[s.platform] = clone(points.slice(-60));
    }
    const sum = (k: "views" | "likes" | "comments" | "shares") => stacks.reduce((n, s) => n + (s.metrics?.[k] ?? 0), 0);
    const updatedAt = stacks.map((s) => s.updatedAt).filter((t): t is string => !!t).sort().at(-1);
    return {
      clip: clone(withTotal(c)),
      posts: stacks,
      series,
      totals: {
        views: sum("views"),
        likes: sum("likes"),
        comments: sum("comments"),
        shares: sum("shares"),
        platformsPosted: stacks.filter((s) => s.status === "posted" || s.status === "posted_private").length,
        ...(updatedAt ? { updatedAt } : {}),
      },
      bestPlatform: pickBest(stacks),
      bestThisWeek: c.best === true,
      week: c.best ? (c.bestWeek ?? null) : null,
      weekAnchorAt: anchorOf(c),
    };
  }

  /** New numbers for one post (the stats Lambda's "write a result" step), pushed live. */
  function measure(p: Post, clip: Clip | undefined) {
    const at = new Date().toISOString();
    step++;
    p.metrics = p.metrics
      ? grow(p.metrics, step, at)
      : metricsFor(p.platform, 180 + step * 37, clip?.durationSec ?? 30, step, { insights: false, checkedAt: at });
    p.refreshing = false;
    const views = p.metrics.views;
    if (typeof views === "number") (store.snapshots[p.postId] ??= []).push({ at, views });
    publishPost(p);
  }

  function refresh(clipId: string, platforms?: Platform[]): RefreshResult[] {
    const c = store.clips.find((x) => x.clipId === clipId);
    if (!c || !IN_LIBRARY.has(c.status)) throw notFound();
    if (platforms && !platforms.every((p) => STATS_ORDER.includes(p))) throw new ApiError(400, "bad_request", "Unknown platform.");
    const want = STATS_ORDER.filter((p) => !platforms || platforms.includes(p));
    const now = Date.now();
    const started: Post[] = [];
    const out = want.map((platform): RefreshResult => {
      const p = postsOf(clipId).find((x) => x.platform === platform);
      const name = PLATFORM_LABEL[platform];
      if (!p || p.status !== "posted") return { platform, status: "not_posted" };
      if (p.privacy === "private") return { platform, status: "private", note: "TikTok shows numbers after the app is approved." };
      if (accountOf(platform) !== "connected")
        return { platform, status: "not_connected", note: `Connect ${name} in Settings › Posting › Accounts.` };
      if (faults.statsBlocked?.includes(platform))
        return { platform, status: "blocked", nextAllowedAt: new Date(now + 15 * MIN).toISOString() };
      if ((p.nextRefreshAt && Date.parse(p.nextRefreshAt) > now) || p.refreshing)
        return { platform, status: "too_soon", ...(p.nextRefreshAt ? { nextAllowedAt: p.nextRefreshAt } : {}) };
      const next = new Date(now + MANUAL_COOLDOWN_MIN[platform] * MIN).toISOString();
      p.nextRefreshAt = next;
      p.refreshing = true;
      started.push(p);
      const slow = platform === "instagram" || platform === "facebook";
      return { platform, status: "started", nextAllowedAt: next, ...(slow ? { note: `${name} numbers can take up to 2 days to settle.` } : {}) };
    });
    for (const p of started) publishPost(p);
    // The numbers come back a little later, one platform after another, over the live connection.
    started.forEach((p, i) => setTimeout(() => measure(p, c), (automated() ? 350 : 1100) + i * (automated() ? 120 : 450)));
    return out;
  }

  function poll(clipId?: string): number {
    const due = store.posts.filter((p) => p.status === "posted" && p.privacy !== "private" && p.metrics && (!clipId || p.clipId === clipId));
    for (const p of due) measure(p, store.clips.find((c) => c.clipId === p.clipId));
    return due.length;
  }

  // ---------- Weeks ----------

  function weekClips(from: string, to: string): WeekClip[] {
    const f = Date.parse(from);
    const t = Date.parse(to);
    return store.clips
      .filter((c) => IN_LIBRARY.has(c.status))
      .map((c): WeekClip | null => {
        const anchorAt = anchorOf(c);
        const a = Date.parse(anchorAt);
        if (!(a >= f && a < t)) return null;
        const posts = postsOf(c.clipId);
        const posted = posts.filter((p) => p.status === "posted");
        const sum = (k: "views" | "likes" | "comments" | "shares") => posted.reduce((n, p) => n + (p.metrics?.[k] ?? 0), 0);
        const views: WeekClip["views"] = {};
        // Private posts never get numbers (§16.2): they are left out of the per-app views.
        for (const p of posted) {
          if (p.privacy === "private") continue;
          views[p.platform] = p.metrics?.views ?? null;
        }
        const { videoUrl: _v, ...clip } = clone(withTotal(c));
        return {
          clip,
          anchorAt,
          posted: posted.length > 0,
          totals: { views: sum("views"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares") },
          views,
          best: c.best === true,
        };
      })
      .filter((x): x is WeekClip => x !== null)
      .sort((a, b) => b.totals.views - a.totals.views || b.anchorAt.localeCompare(a.anchorAt));
  }

  const summary = (w: WeekItem) => {
    const { revision: _r, ...rest } = w;
    return clone(rest);
  };

  function view(week: string, from: string, to: string): WeekView {
    const item = store.weeks[week];
    const clips = weekClips(item?.from ?? from, item?.to ?? to);
    const learning = item?.learningId ? store.learnings.find((l) => l.learningId === item.learningId) : undefined;
    const money = moneyScenarioEarns()
      ? { revenueByPlatform: { youtube: { platform: "youtube" as const, amountMicros: 3_100_000, currency: "USD", source: "youtube.estimatedRevenue", tag: "YouTube's estimate" } } }
      : {};
    return {
      ...(item ? summary(item) : { week, from, to, clipIds: [], learnState: "none" as const }),
      clips,
      ...money,
      ...(learning && item?.learnState === "done" ? { learning: clone(learning) } : {}),
    };
  }

  function getWeek(week: string, from: string, to: string): WeekView {
    if (!isWeek(week) || !weekBoundsOk(week, from, to)) throw badWeek();
    return view(week, from, to);
  }

  function learn(week: string, revision: number) {
    const item = store.weeks[week];
    if (!item || item.revision !== revision) return; // superseded by a newer save
    if (faults.learnFails) {
      faults.learnFails = false;
      item.learnState = "failed";
      publish({ type: "week", op: "upsert", id: week, item: summary(item) });
      return;
    }
    const picks = store.clips.filter((c) => item.clipIds.includes(c.clipId));
    const short = picks.every((c) => c.durationSec <= 35);
    const hook = picks[0]?.hook ?? "";
    const lead = short ? "Your picks are short and get" : "Your picks get";
    const text = `${lead} to the action in the first second${hook ? `, like "${hook}"` : ""}. Start on the moment itself and keep the payoff for the last few seconds.`;
    const learning: Learning = {
      learningId: item.learningId ?? ulid(),
      kind: "week",
      week,
      title: `Best of week ${week}`,
      text,
      clipIds: [...item.clipIds],
      postIds: store.posts.filter((p) => item.clipIds.includes(p.clipId) && p.status === "posted").map((p) => p.postId),
      createdAt: new Date().toISOString(),
    };
    store.learnings = [learning, ...store.learnings.filter((l) => l.learningId !== learning.learningId)];
    item.learnState = "done";
    item.learningId = learning.learningId;
    publish({ type: "learning", op: "upsert", id: learning.learningId, item: clone(learning) });
    publish({ type: "week", op: "upsert", id: week, item: summary(item) });
  }

  function saveBest(week: string, body: { from: string; to: string; clipIds: string[] }): WeekView {
    saves++;
    if (!isWeek(week) || !weekBoundsOk(week, body.from, body.to)) throw badWeek();
    const ids = body.clipIds;
    const inWeek = new Set(weekClips(body.from, body.to).map((c) => c.clip.clipId));
    if (new Set(ids).size !== ids.length || ids.length > 10 || !ids.every((id) => inWeek.has(id)))
      throw new ApiError(400, "bad_request", "Pick clips from this week only.");
    const old = store.weeks[week];
    const before = old?.clipIds ?? [];
    if (before.length === ids.length && before.every((id) => ids.includes(id))) return view(week, body.from, body.to);

    const item: WeekItem = {
      week,
      from: old?.from ?? body.from,
      to: old?.to ?? body.to,
      clipIds: [...ids],
      savedAt: new Date().toISOString(),
      learnState: ids.length ? "learning" : "skipped",
      ...(old?.learningId ? { learningId: old.learningId } : {}),
      revision: (old?.revision ?? 0) + 1,
    };
    for (const c of store.clips) {
      if (ids.includes(c.clipId) && !c.best) {
        c.best = true;
        c.bestWeek = week;
        publishClip(c);
      } else if (before.includes(c.clipId) && !ids.includes(c.clipId)) {
        c.best = false;
        delete c.bestWeek;
        publishClip(c);
      }
    }
    if (!ids.length && item.learningId) {
      const gone = item.learningId;
      store.learnings = store.learnings.filter((l) => l.learningId !== gone);
      delete item.learningId;
      publish({ type: "learning", op: "delete", id: gone });
    }
    store.weeks[week] = item;
    publish({ type: "week", op: "upsert", id: week, item: summary(item) });
    if (ids.length) setTimeout(() => learn(week, item.revision), automated() ? 700 : 2600);
    return view(week, body.from, body.to);
  }

  if (typeof window !== "undefined") {
    const controls: MockStatsControls = { poll, weekSaves: () => saves };
    (window as unknown as { __cfMockStats?: MockStatsControls }).__cfMockStats = controls;
  }

  return { performance, refresh, getWeek, saveBest, withTotal };
}
