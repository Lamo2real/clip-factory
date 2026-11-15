// Folding live events (docs/CONTRACTS.md §14.2) into what the screens hold. Pure functions, so every screen applies
// them the same way and the tests can check each case.
import type { Clip, Job, Learning, LiveEvent, Post } from "../api/types.ts";

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
