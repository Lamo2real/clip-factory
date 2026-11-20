import { describe, expect, it } from "vitest";
import type { PostMetrics } from "../src/api/types.ts";
import {
  STATS_ORDER,
  ago,
  calmCopy,
  compact,
  labelsFor,
  metricGroups,
  perfStatus,
  pickBest,
  reactionParts,
  until,
  watchTotal,
} from "../src/lib/metrics.ts";

const at = "2026-11-16T10:00:00Z";
const m = (over: Partial<PostMetrics> = {}): PostMetrics => ({
  views: 1000,
  likes: 50,
  comments: 4,
  shares: 3,
  checkedAt: at,
  metricsUpdatedAt: at,
  extra: {},
  ...over,
});

describe("compact numbers", () => {
  it("shortens big numbers and dashes missing ones", () => {
    expect(compact(950)).toBe("950");
    expect(compact(1234)).toBe("1.2K");
    expect(compact(48_210)).toBe("48.2K");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(0)).toBe("0");
    expect(compact(null)).toBe("–");
    expect(compact(undefined)).toBe("–");
  });

  it("reads watch time and waits", () => {
    expect(watchTotal(65)).toBe("1:05");
    expect(watchTotal(36 * 3600)).toBe("36 h");
    const now = Date.parse(at);
    expect(ago("2026-11-16T09:57:00Z", now)).toBe("3 min ago");
    expect(ago("2026-11-16T09:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-16T07:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-15T09:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-11-14T09:00:00Z", now)).toBe("2 days ago");
    expect(until("2026-11-16T10:04:00Z", now)).toBe("4 min");
    expect(until("2026-11-16T10:00:20Z", now)).toBe("1 min");
    expect(until("2026-11-16T11:05:00Z", now)).toBe("1 h 5 min");
    expect(until("2026-11-16T09:00:00Z", now)).toBe("");
  });
});

describe("metric rows per platform", () => {
  it("shows only what each platform gives", () => {
    expect(labelsFor("tiktok")).toEqual(["Views", "Likes", "Comments", "Shares"]);
    expect(labelsFor("tiktok")).not.toContain("Saves");
    for (const p of ["instagram", "facebook"] as const) expect(labelsFor(p)).not.toContain("Impressions");
    expect(labelsFor("youtube")).toContain("New subscribers");
    expect(labelsFor("facebook")[0]).toBe("Plays");
    expect(labelsFor("x")[0]).toBe("Video views");
    expect(labelsFor("x")).toContain("Watched to 100%");
  });

  it("leaves absent fields out instead of showing 0", () => {
    const g = metricGroups("youtube", m({ shares: null }));
    expect(g.top).toMatchObject({ label: "Views", value: "1K", raw: 1000 });
    expect(g.fast.map((r) => r.label)).toEqual(["Likes", "Comments"]);
    expect(g.slow).toEqual({ note: "Updates daily", rows: [] }); // no Analytics numbers yet: just the note

    const yt = metricGroups("youtube", m({ shares: 9, extra: { avgViewSeconds: 65, avgViewPercent: 48.6, watchMinutes: 1200 } }));
    expect(yt.slow?.note).toBe("Updates daily");
    expect(yt.slow?.rows.map((r) => [r.label, r.value])).toEqual([
      ["Watch time", "1.2K min"],
      ["Average view", "1:05"],
      ["Average % watched", "49%"],
      ["Shares", "9"],
    ]);
  });

  it("tells Instagram's slow views apart from its fast likes", () => {
    const g = metricGroups("instagram", m({ views: null, shares: null }));
    expect(g.top.value).toBe("–");
    expect(g.top.spoken).toBe("Views: not in yet");
    expect(g.fast.map((r) => r.label)).toEqual(["Likes", "Comments"]);
    const full = metricGroups("instagram", m({ extra: { reach: 700, saved: 12, skipRatePercent: 21.4 } }));
    expect(full.slow?.note).toBe("Can take 2 days");
    expect(full.slow?.rows.map((r) => r.label)).toEqual(["Reach", "Shares", "Saves", "Skip rate"]);
  });

  it("gives Facebook plays and a reactions breakdown", () => {
    const g = metricGroups("facebook", m({ comments: null, shares: null, likes: 60, extra: { replays: 10, reactions: { like: 40, love: 20, wow: 0 } } }));
    expect(g.top.label).toBe("Plays");
    expect(g.fast).toEqual([]);
    expect(g.slow?.rows.map((r) => r.label)).toEqual(["Replays", "Reactions"]);
    expect(reactionParts({ like: 40, love: 20, wow: 0 })).toEqual([
      { name: "Like", count: "40" },
      { name: "Love", count: "20" },
    ]);
  });

  it("gives X its own numbers, replies from comments", () => {
    const g = metricGroups("x", m({ extra: { impressions: 9000, playback25: 300 } }));
    expect(g.fast.map((r) => r.label)).toEqual(["Impressions", "Likes", "Reposts", "Replies", "Watched to 25%"]);
    expect(g.slow).toBeNull();
  });
});

describe("status and calm copy", () => {
  it("maps posts to stack statuses (first match wins)", () => {
    expect(perfStatus(undefined)).toBe("not_posted");
    expect(perfStatus({ status: "pending_integration" })).toBe("waiting_for_connection");
    expect(perfStatus({ status: "queued" })).toBe("posting");
    expect(perfStatus({ status: "failed" })).toBe("failed");
    expect(perfStatus({ status: "posted", privacy: "private" })).toBe("posted_private");
    expect(perfStatus({ status: "posted", privacy: "public" })).toBe("posted");
  });

  it("says one calm line per state, with the right link", () => {
    const base = { platform: "instagram" as const, metrics: null };
    expect(calmCopy({ ...base, status: "waiting_for_connection" })).toEqual({
      text: "Connect Instagram in Settings › Posting › Set up posting.",
      link: { href: "/settings/posting/setup/instagram", label: "Set up Instagram" },
    });
    expect(calmCopy({ ...base, status: "not_posted" })).toEqual({
      text: "Not posted here. Turn on Instagram in Settings › Posting › Where clips go.",
      link: { href: "/settings/posting/where", label: "Open Where clips go" },
    });
    expect(calmCopy({ ...base, status: "posting" })).toEqual({ text: "Posting now…", spinner: true });
    expect(calmCopy({ ...base, platform: "tiktok", status: "posted_private" })?.text).toBe(
      "Uploaded privately. TikTok shows numbers after the app is approved.",
    );
    expect(calmCopy({ ...base, status: "posted" })?.text).toBe("Numbers are on the way. Check back in a few minutes.");
    expect(calmCopy({ ...base, status: "posted", metrics: m() })).toBeNull();
    expect(calmCopy({ ...base, status: "failed", error: "The video was too long." })).toEqual({
      text: "Posting failed: The video was too long. Go to Library and press Try again.",
      link: { href: "/library", label: "Go to Library" },
    });
  });

  it("crowns the most views, ties going to the earlier platform", () => {
    const posts = STATS_ORDER.map((platform) => ({ platform, metrics: null as PostMetrics | null }));
    expect(pickBest(posts)).toBeNull();
    posts[2]!.metrics = m({ views: 500 });
    posts[4]!.metrics = m({ views: 500 });
    expect(pickBest(posts)).toBe("instagram");
    posts[3]!.metrics = m({ views: 0 });
    expect(pickBest(posts)).toBe("instagram");
    posts[1]!.metrics = m({ views: 501 });
    expect(pickBest(posts)).toBe("tiktok");
  });
});
