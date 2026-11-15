import { describe, expect, it } from "vitest";
import type { Clip, Job, Learning, LiveEvent, Post } from "../src/api/types.ts";
import { applyClipEvent, applyJobEvent, applyLearningEvent, applyPostEvent, byRank, withMedia } from "../src/lib/liveCache.ts";

const job = (id: string, createdAt: string, over: Partial<Job> = {}): Job => ({
  jobId: id,
  status: "running",
  source: { type: "link", platform: "youtube" },
  clipTarget: { min: 5, max: 10 },
  steps: [],
  progress: 0.2,
  clipCount: 0,
  createdAt,
  updatedAt: createdAt,
  ...over,
});

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  clipId: id,
  jobId: "J1",
  rank: 1,
  status: "review",
  momentType: "chaos",
  hook: "hook",
  summary: "summary",
  durationSec: 20,
  sourceStart: 0,
  sourceEnd: 20,
  layout: "facecam_top",
  captions: { youtubeTitle: "t", youtubeDescription: "", instagram: "", facebook: "", tiktok: "", x: "" },
  checklist: { items: [], fixes: [] },
  score: 8,
  createdAt: "2026-11-15T10:00:00Z",
  ...over,
});

describe("applyJobEvent", () => {
  const list = [job("J2", "2026-11-15T11:00:00Z"), job("J1", "2026-11-15T10:00:00Z")];

  it("updates a job where it is", () => {
    const out = applyJobEvent(list, { type: "job", op: "upsert", id: "J1", item: job("J1", "2026-11-15T10:00:00Z", { progress: 0.7 }) });
    expect(out.map((j) => [j.jobId, j.progress])).toEqual([
      ["J2", 0.2],
      ["J1", 0.7],
    ]);
  });

  it("puts a new job on top and keeps a short list short", () => {
    const ev: LiveEvent = { type: "job", op: "upsert", id: "J3", item: job("J3", "2026-11-15T12:00:00Z") };
    expect(applyJobEvent(list, ev).map((j) => j.jobId)).toEqual(["J3", "J2", "J1"]);
    expect(applyJobEvent(list, ev, 2).map((j) => j.jobId)).toEqual(["J3", "J2"]);
  });

  it("removes a deleted job and ignores other types", () => {
    expect(applyJobEvent(list, { type: "job", op: "delete", id: "J2" }).map((j) => j.jobId)).toEqual(["J1"]);
    expect(applyJobEvent(list, { type: "clip", op: "delete", id: "J2" })).toBe(list);
    expect(applyJobEvent(list, { type: "job", op: "upsert", id: "J2", partial: true })).toBe(list);
  });
});

describe("applyClipEvent", () => {
  const inReview = (c: Clip) => c.status === "review";
  const cached = [clip("C1", { videoUrl: "https://v/1", coverUrl: "https://c/1", rank: 1 }), clip("C2", { rank: 2, coverUrl: "https://c/2" })];

  it("keeps the cached video and cover links on an update", () => {
    const out = applyClipEvent(cached, { type: "clip", op: "upsert", id: "C1", item: clip("C1", { hook: "new hook" }) }, inReview);
    expect(out.clips[0]).toMatchObject({ clipId: "C1", hook: "new hook", videoUrl: "https://v/1", coverUrl: "https://c/1" });
    expect(out.needMedia).toEqual([]);
  });

  it("adds a new matching clip and asks for its media links", () => {
    const out = applyClipEvent(cached, { type: "clip", op: "upsert", id: "C3", item: clip("C3", { rank: 3 }) }, inReview, byRank);
    expect(out.clips.map((c) => c.clipId)).toEqual(["C1", "C2", "C3"]);
    expect(out.needMedia).toEqual(["C3"]);
    const fresh = clip("C3", { videoUrl: "https://v/3", coverUrl: "https://c/3" });
    expect(withMedia(out.clips, fresh)[2]).toMatchObject({ videoUrl: "https://v/3", coverUrl: "https://c/3" });
  });

  it("drops a clip that no longer matches (kept or thrown away elsewhere)", () => {
    const out = applyClipEvent(cached, { type: "clip", op: "upsert", id: "C2", item: clip("C2", { status: "confirmed" }) }, inReview);
    expect(out.clips.map((c) => c.clipId)).toEqual(["C1"]);
  });

  it("ignores a non-matching clip it never showed, and removes deleted ones", () => {
    expect(applyClipEvent(cached, { type: "clip", op: "upsert", id: "C9", item: clip("C9", { status: "declined" }) }, inReview).clips).toBe(cached);
    expect(applyClipEvent(cached, { type: "clip", op: "delete", id: "C1" }, inReview).clips.map((c) => c.clipId)).toEqual(["C2"]);
  });
});

describe("applyPostEvent and applyLearningEvent", () => {
  const post = (id: string, over: Partial<Post> = {}): Post => ({ postId: id, clipId: "C1", platform: "youtube", status: "queued", ...over });

  it("updates, adds and removes posts", () => {
    const posts = [post("P1"), post("P2")];
    const metrics = { views: 10, likes: 1, comments: 0, shares: 0, checkedAt: "2026-11-15T10:00:00Z" };
    const updated = applyPostEvent(posts, { type: "post", op: "upsert", id: "P1", item: post("P1", { status: "posted", metrics }) });
    expect(updated[0]).toMatchObject({ status: "posted", metrics });
    expect(applyPostEvent(posts, { type: "post", op: "upsert", id: "P3", item: post("P3") })).toHaveLength(3);
    expect(applyPostEvent(posts, { type: "post", op: "delete", id: "P2" }).map((p) => p.postId)).toEqual(["P1"]);
  });

  it("keeps learnings newest first", () => {
    const l = (id: string, createdAt: string): Learning => ({ learningId: id, text: id, createdAt, postIds: [] });
    const list = [l("L2", "2026-11-14T00:00:00Z"), l("L1", "2026-11-13T00:00:00Z")];
    const out = applyLearningEvent(list, { type: "learning", op: "upsert", id: "L3", item: l("L3", "2026-11-15T00:00:00Z") });
    expect(out.map((x) => x.learningId)).toEqual(["L3", "L2", "L1"]);
    expect(applyLearningEvent(out, { type: "learning", op: "delete", id: "L2" }).map((x) => x.learningId)).toEqual(["L3", "L1"]);
  });
});
