// Folding live events (docs/CONTRACTS.md §14.2) into what the screens hold. Pure functions, so every screen applies
// them the same way and the tests can check each case.
import type { Clip, ClipPerformance, Job, JobLive, Learning, LiveEvent, PlatformPerformance, Post, WeekView } from "../api/types.ts";
import { perfStatus, pickBest } from "./metrics.ts";

/** Jobs on screen, newest first. New jobs go on top; `limit` keeps a short list short (Home shows 6). */
export function applyJobEvent(jobs: Job[], ev: LiveEvent, limit?: number): Job[] {
  if (ev.type !== "job") return jobs;
  if (ev.op === "delete") return jobs.filter((j) => j.jobId !== ev.id);
  if (!ev.item) return jobs;
  const item = ev.item;
  const at = jobs.findIndex((j) => j.jobId === item.jobId);
  if (at >= 0) return jobs.map((j, i) => (i === at ? item : j));
  const next = [item, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return limit ? next.slice(0, limit) : next;
}

export interface ClipApplied {
  clips: Clip[];
  /** Clips that arrived without video or cover links: fetch them once to get presigned links. */
  needMedia: string[];
}

/**
 * Clips on screen that match `keep` (for example "waiting for review from this job"). An updated clip keeps its
 * cached video and cover links (live events never carry them); a clip that no longer matches leaves the list.
 */
export function applyClipEvent(
  clips: Clip[],
  ev: LiveEvent,
  keep: (c: Clip) => boolean,
  order: (a: Clip, b: Clip) => number = byNewest,
): ClipApplied {
  if (ev.type !== "clip") return { clips, needMedia: [] };
  if (ev.op === "delete") return { clips: clips.filter((c) => c.clipId !== ev.id), needMedia: [] };
  if (!ev.item) return { clips, needMedia: [] };
  const item = ev.item;
  const old = clips.find((c) => c.clipId === item.clipId);
  if (!keep(item)) return { clips: old ? clips.filter((c) => c !== old) : clips, needMedia: [] };
  const merged: Clip = { ...item, videoUrl: old?.videoUrl ?? item.videoUrl, coverUrl: old?.coverUrl ?? item.coverUrl };
  const needMedia = merged.videoUrl || merged.coverUrl ? [] : [item.clipId];
  if (old) return { clips: clips.map((c) => (c === old ? merged : c)), needMedia };
  return { clips: [...clips, merged].sort(order), needMedia };
}

/** Swaps in a clip fetched for its media links, if it is still on screen. */
export function withMedia(clips: Clip[], fresh: Clip): Clip[] {
  return clips.map((c) => (c.clipId === fresh.clipId ? { ...c, videoUrl: fresh.videoUrl, coverUrl: fresh.coverUrl } : c));
}

export const byNewest = (a: Clip, b: Clip) => b.createdAt.localeCompare(a.createdAt) || a.rank - b.rank;
export const byRank = (a: Clip, b: Clip) => a.rank - b.rank;

export function applyPostEvent(posts: Post[], ev: LiveEvent): Post[] {
  if (ev.type !== "post") return posts;
  if (ev.op === "delete") return posts.filter((p) => p.postId !== ev.id);
  if (!ev.item) return posts;
  const item = ev.item;
  return posts.some((p) => p.postId === item.postId) ? posts.map((p) => (p.postId === item.postId ? item : p)) : [...posts, item];
}

/** Learnings, newest first. */
export function applyLearningEvent(learnings: Learning[], ev: LiveEvent): Learning[] {
  if (ev.type !== "learning") return learnings;
  if (ev.op === "delete") return learnings.filter((l) => l.learningId !== ev.id);
  if (!ev.item) return learnings;
  const item = ev.item;
  const rest = learnings.filter((l) => l.learningId !== item.learningId);
  return [item, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------- Clip performance and This week (docs/CONTRACTS.md §16.8) ----------

/** One stack's data from a Post (the account state and the series come from elsewhere). */
export function perfFromPost(post: Post, prev: PlatformPerformance): PlatformPerformance {
  const m = post.metrics ?? null;
  return {
    ...prev,
    status: perfStatus(post),
    postId: post.postId,
    url: post.url,
    postedAt: post.postedAt,
    metrics: m,
    updatedAt: m ? (m.metricsUpdatedAt ?? m.checkedAt) : undefined,
    insightsUpdatedAt: m?.insightsUpdatedAt,
    nextAllowedAt: post.nextRefreshAt,
    refreshing: post.refreshing === true,
    final: m?.final === true,
    error: post.error,
  };
}

/** Totals and the crown, worked out the way the server does (null counts as 0). */
export function withTotals(perf: ClipPerformance): ClipPerformance {
  const sum = (k: "views" | "likes" | "comments" | "shares") => perf.posts.reduce((n, p) => n + (p.metrics?.[k] ?? 0), 0);
  const updated = perf.posts.map((p) => p.updatedAt).filter((t): t is string => !!t).sort().at(-1);
  return {
    ...perf,
    totals: {
      views: sum("views"),
      likes: sum("likes"),
      comments: sum("comments"),
      shares: sum("shares"),
      platformsPosted: perf.posts.filter((p) => p.status === "posted" || p.status === "posted_private").length,
      ...(updated ? { updatedAt: updated } : {}),
    },
    bestPlatform: pickBest(perf.posts),
  };
}

/**
 * Folds a live event into the performance page: a `post` upsert for this clip replaces that stack (and adds a
 * sparkline point when the views moved); a `clip` upsert updates the star. Anything else changes nothing.
 */
export function applyPerfEvent(perf: ClipPerformance, ev: LiveEvent): ClipPerformance {
  if (ev.type === "clip" && ev.op === "upsert" && ev.item && ev.item.clipId === perf.clip.clipId) {
    const clip = { ...ev.item, videoUrl: perf.clip.videoUrl, coverUrl: perf.clip.coverUrl };
    const best = clip.best === true;
    return { ...perf, clip, bestThisWeek: best, week: best ? (clip.bestWeek ?? perf.week) : null };
  }
  if (ev.type !== "post" || ev.op !== "upsert" || !ev.item || ev.item.clipId !== perf.clip.clipId) return perf;
  const post = ev.item;
  const at = perf.posts.findIndex((p) => p.platform === post.platform);
  if (at < 0) return perf;
  const prev = perf.posts[at]!;
  const next = perfFromPost(post, prev);
  const posts = perf.posts.map((p, i) => (i === at ? next : p));
  let series = perf.series;
  const views = next.metrics?.views;
  const when = next.updatedAt;
  if (typeof views === "number" && when) {
    const old = perf.series[post.platform] ?? [];
    const last = old.at(-1);
    if (!last || (last.views !== views && when > last.at)) series = { ...perf.series, [post.platform]: [...old, { at: when, views }] };
  }
  return withTotals({ ...perf, posts, series });
}

/** Folds `week` and week `learning` events into This week. `localPicks` = the owner has unsaved changes. */
export function applyWeekEvent(view: WeekView, ev: LiveEvent, localPicks = false): WeekView {
  if (ev.type === "week" && ev.op === "upsert" && ev.item && ev.item.week === view.week) {
    const s = ev.item;
    const clipIds = localPicks ? view.clipIds : s.clipIds;
    const picked = new Set(clipIds);
    return {
      ...view,
      ...s,
      clipIds,
      clips: view.clips.map((c) => ({ ...c, best: picked.has(c.clip.clipId) })),
      // While learning (or after the picks were cleared) the old learning no longer stands.
      learning: s.learnState === "done" ? view.learning : undefined,
    };
  }
  if (ev.type === "learning" && ev.op === "upsert" && ev.item && ev.item.kind === "week" && ev.item.week === view.week) {
    return { ...view, learning: ev.item, learningId: ev.item.learningId };
  }
  if (ev.type === "learning" && ev.op === "delete" && view.learning?.learningId === ev.id) return { ...view, learning: undefined };
  return view;
}

// ---------- The live status line (docs/CONTRACTS.md §31) ----------

/** A line belongs to the job's current run (or one of the two does not say which run it is). */
export function sameRun(job: Pick<Job, "run">, line: Pick<JobLive, "run">): boolean {
  return !job.run || !line.run || job.run === line.run;
}

/** Folds a `jobLive` event into the lines held by job id: the newest line of each job wins. */
export function applyJobLiveEvent(lines: ReadonlyMap<string, JobLive>, ev: LiveEvent): Map<string, JobLive> {
  const next = new Map(lines);
  if (ev.type !== "jobLive") return next;
  if (ev.op === "delete") {
    next.delete(ev.id);
    return next;
  }
  if (!ev.item) return next;
  const old = next.get(ev.item.jobId);
  if (!old || old.run !== ev.item.run || ev.item.at >= old.at) next.set(ev.item.jobId, ev.item);
  return next;
}

/**
 * The line to show for `job`: the newer of the pushed one and the one the last fetch carried, and only while the job
 * is queued or running and the line belongs to its current run. Null otherwise.
 */
export function pickJobLive(job: Pick<Job, "status" | "run" | "live">, pushed: JobLive | undefined): JobLive | null {
  if (job.status !== "running" && job.status !== "queued") return null;
  const candidates = [pushed, job.live].filter((l): l is JobLive => !!l && sameRun(job, l));
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.at > a.at ? b : a));
}
