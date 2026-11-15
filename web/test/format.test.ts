import { describe, expect, it } from "vitest";
import { bytes, duration, plural, relative, timecode } from "../src/lib/format.ts";
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
    expect(relative("2026-11-15T11:55:00Z", now)).toBe("5 minutes ago");
    expect(relative("2026-11-14T12:00:00Z", now)).toBe("yesterday");
    expect(relative("2026-11-15T12:00:20Z", now)).toBe("just now");
  });
});

describe("router", () => {
  it("matches every screen", () => {
    expect(match("/")).toEqual({ name: "home" });
    expect(match("/jobs/")).toEqual({ name: "jobs" });
    expect(match("/jobs/01JABCDEFGHJKMNPQRSTVWXYZ0")).toEqual({ name: "job", jobId: "01JABCDEFGHJKMNPQRSTVWXYZ0" });
    expect(match("/review", "?job=J1")).toEqual({ name: "review", jobId: "J1" });
    expect(match("/library")).toEqual({ name: "library" });
    expect(match("/settings")).toEqual({ name: "settings", tree: null, branch: null });
    expect(match("/jobs/a/b")).toEqual({ name: "not_found" });
  });
});
