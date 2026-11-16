import { describe, expect, it } from "vitest";
import { byPlatformOrder, bytes, duration, PLATFORM_ORDER, plural, relative, timecode } from "../src/lib/format.ts";
import { ago, STATS_ORDER } from "../src/lib/metrics.ts";
import { match } from "../src/lib/router.ts";

describe("format", () => {
  it("formats timecodes", () => {
    expect(timecode(65)).toBe("1:05");
    expect(timecode(3725)).toBe("1:02:05");
    expect(timecode(-3)).toBe("0:00");
  });
  it("formats durations, sizes and counts", () => {
    expect(duration(6 * 3600 + 600)).toBe("6 h 10 min");
    expect(duration(30)).toBe("1 min");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(plural(1, "clip")).toBe("1 clip");
    expect(plural(3, "clip")).toBe("3 clips");
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(relative("2026-11-15T11:55:00Z", now)).toBe("5 min ago");
    expect(relative("2026-11-14T12:00:00Z", now)).toBe("yesterday");
    expect(relative("2026-11-15T12:00:20Z", now)).toBe("just now");
  });
  it("never says 60 min or 24 h: the unit comes from whole minutes (F084)", () => {
    expect(duration(7190)).toBe("2 h");
    expect(duration(3599)).toBe("1 h");
    expect(duration(3570)).toBe("1 h");
    expect(duration(3540)).toBe("59 min");
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(relative(new Date(now - 59.6 * 60_000).toISOString(), now)).toBe("59 min ago");
    expect(relative(new Date(now - 60 * 60_000).toISOString(), now)).toBe("1 h ago");
    expect(relative(new Date(now - 23.6 * 3_600_000).toISOString(), now)).toBe("23 h ago");
    expect(relative(new Date(now - 24 * 3_600_000).toISOString(), now)).toBe("yesterday");
    expect(relative(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3 days ago");
    expect(relative(new Date(now + 2 * 86_400_000 - 5_000).toISOString(), now)).toBe("in 2 days");
    expect(relative(new Date(now + 4.2 * 60_000).toISOString(), now)).toBe("in 5 min");
    expect(relative("not a time", now)).toBe("");
  });
  it("Library, Jobs and the clip page say \"ago\" the same way", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    for (const back of [20_000, 3 * 60_000, 2 * 3_600_000, 30 * 3_600_000, 5 * 86_400_000]) {
      const iso = new Date(now - back).toISOString();
      expect(ago(iso, now)).toBe(relative(iso, now));
    }
    expect(ago(new Date(now + 90_000).toISOString(), now)).toBe("just now");
  });
});

describe("platform order (F018)", () => {
  it("is YouTube, TikTok, Instagram, Facebook, X everywhere", () => {
    expect(PLATFORM_ORDER).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(STATS_ORDER).toBe(PLATFORM_ORDER);
  });
  it("sorts posts from the API into that order", () => {
    const posts = (["x", "facebook", "instagram", "tiktok", "youtube"] as const).map((platform, i) => ({ platform, i }));
    expect(byPlatformOrder(posts).map((p) => p.platform)).toEqual(PLATFORM_ORDER);
    expect(posts[0]!.platform).toBe("x");
  });
});

describe("router", () => {
  it("matches every screen", () => {
    expect(match("/")).toEqual({ name: "home" });
    expect(match("/jobs/")).toEqual({ name: "jobs" });
    expect(match("/jobs/01JABCDEFGHJKMNPQRSTVWXYZ0")).toEqual({ name: "job", jobId: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(match("/review", "?job=J1")).toEqual({ name: "review", jobId: "J1" });
    expect(match("/library")).toEqual({ name: "library", view: "all", week: null });
    expect(match("/library", "?view=week")).toEqual({ name: "library", view: "week", week: null });
    expect(match("/library", "?view=week&week=2026-W45")).toEqual({ name: "library", view: "week", week: "2026-W45" });
    expect(match("/clips/01JABCDEFGHJKMNPQRSTVWXYZ0")).toEqual({ name: "clip", clipId: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(match("/clips/a/b")).toEqual({ name: "not_found" });
    expect(match("/settings")).toEqual({ name: "settings", tree: null, branch: null });
    expect(match("/jobs/a/b")).toEqual({ name: "not_found" });
  });
});
