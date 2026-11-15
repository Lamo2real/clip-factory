import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areaForPath,
  areasForPaths,
  cleanArea,
  easeInOutCubic,
  finishedAt,
  isNewer,
  parseVersionInfo,
  PROGRESS,
  progressAt,
  sameVersion,
} from "../src/lib/update.ts";

describe("version compare", () => {
  it("treats short shas of different lengths as the same build", () => {
    expect(sameVersion("a1b2c3d", "a1b2c3d4e5f6")).toBe(true);
    expect(sameVersion("A1B2C3D", "a1b2c3d")).toBe(true);
    expect(sameVersion("a1b2c3d", "a1b2c3e")).toBe(false);
  });
  it("compares non-sha versions exactly", () => {
    expect(sameVersion("v1.2", "v1.2")).toBe(true);
    expect(sameVersion("v1", "v1.2")).toBe(false);
  });
  it("asks to update only for a different, real version", () => {
    expect(isNewer("a1b2c3d", "f00ba47")).toBe(true);
    expect(isNewer("a1b2c3d", "a1b2c3d")).toBe(false);
    expect(isNewer("a1b2c3d", "")).toBe(false);
    expect(isNewer("a1b2c3d", null)).toBe(false);
    expect(isNewer("dev", "f00ba47")).toBe(false);
  });
});

describe("area parsing", () => {
  it("keeps short labels and drops sentences", () => {
    expect(cleanArea("Settings")).toBe("Settings");
    expect(cleanArea("  profile   picture ")).toBe("Profile picture");
    expect(cleanArea("Look and feel")).toBe("Look and feel");
    expect(cleanArea("We changed a lot of things here")).toBeNull();
    expect(cleanArea("<script>")).toBeNull();
    expect(cleanArea(42)).toBeNull();
    expect(cleanArea("")).toBeNull();
  });
  it("parses version.json, at most three unique areas", () => {
    expect(
      parseVersionInfo({ version: "abc1234", builtAt: "2026-11-15T10:00:00Z", areas: ["Settings", "settings", "Profile picture", "Home", "Review"] }),
    ).toEqual({ version: "abc1234", builtAt: "2026-11-15T10:00:00Z", areas: ["Settings", "Profile picture", "Home"] });
  });
  it("falls back to Improvements", () => {
    expect(parseVersionInfo({ version: "abc1234" })?.areas).toEqual(["Improvements"]);
    expect(parseVersionInfo({ version: "abc1234", areas: ["a very long sentence about it"] })?.areas).toEqual(["Improvements"]);
  });
  it("rejects files without a version", () => {
    expect(parseVersionInfo(null)).toBeNull();
    expect(parseVersionInfo({ areas: ["Home"] })).toBeNull();
    expect(parseVersionInfo({ version: " " })).toBeNull();
  });
});

describe("web/areas.json", () => {
  const map = JSON.parse(readFileSync(join(import.meta.dirname, "..", "areas.json"), "utf8")) as Record<string, string>;

  it("has only short, clean labels", () => {
    for (const [key, label] of Object.entries(map)) {
      if (key.startsWith("$")) continue;
      expect(cleanArea(label), `${key} -> ${label}`).toBe(label);
    }
  });
  it("maps changed files with the longest prefix winning", () => {
    expect(areaForPath("web/src/screens/settings/Settings.tsx", map)).toBe("Settings");
    expect(areaForPath("web/src/screens/settings/SkillsSection.tsx", map)).toBe("Skills");
    expect(areaForPath("web/src/screens/home/Home.tsx", map)).toBe("Home");
    expect(areaForPath("web/src/screens/home/NewJobForm.tsx", map)).toBe("Make clips");
    expect(areaForPath("web/src/screens/review/Review.tsx", map)).toBe("Review");
    expect(areaForPath("web/src/screens/SignIn.tsx", map)).toBe("Sign in");
    expect(areaForPath("agent/src/clipfactory_agent/render.py", map)).toBe("Clip making");
    expect(areaForPath("infra/modules/frontend/main.tf", map)).toBe("Speed");
    expect(areaForPath("api/src/clipfactory_api/platforms/base.py", map)).toBe("Accounts");
    expect(areaForPath("docs/CONTRACTS.md", map)).toBeNull();
  });
  it("does not match a prefix in the middle of a name", () => {
    expect(areaForPath("agentic/thing.py", map)).toBeNull();
    expect(areaForPath("./agent/x.py", map)).toBe("Clip making");
  });
  it("turns a change list into at most three areas", () => {
    expect(
      areasForPaths(
        ["web/src/screens/settings/Settings.tsx", "web/src/screens/settings/Settings.tsx", "agent/src/x.py", "infra/a.tf", "web/src/screens/home/Home.tsx"],
        map,
      ),
    ).toEqual(["Settings", "Clip making", "Speed"]);
    expect(areasForPaths(["docs/README.md"], map)).toEqual(["Improvements"]);
  });
});

describe("the Reload progress curve", () => {
  it("eases in and out", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    // Slow start and slow end, quick middle.
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(0.9)).toBeGreaterThan(0.9);
    expect(easeInOutCubic(0.55) - easeInOutCubic(0.45)).toBeGreaterThan(0.1 * 1.4);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });

  it("reaches ~75% in 0.8 s, then creeps but never passes 92% while waiting", () => {
    expect(progressAt(0, null)).toBe(0);
    expect(progressAt(PROGRESS.rushMs, null)).toBeCloseTo(0.75, 5);
    expect(progressAt(400, null)).toBeCloseTo(0.375, 2);
    expect(progressAt(3000, null)).toBeGreaterThan(0.75);
    expect(progressAt(9000, null)).toBeLessThan(0.92);
  });

  it("never goes backwards and ends at 100%", () => {
    for (const readyAt of [null, 200, 1500, 4000]) {
      let last = 0;
      for (let t = 0; t <= 11_000; t += 25) {
        const v = progressAt(t, readyAt);
        expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        expect(v).toBeLessThanOrEqual(1);
        last = v;
      }
      expect(progressAt(finishedAt(readyAt), readyAt)).toBe(1);
    }
  });

  it("finishes soon after the new version is ready, and by the 10 s cap otherwise", () => {
    expect(finishedAt(300)).toBe(PROGRESS.rushMs + PROGRESS.finishMs);
    expect(finishedAt(2000)).toBe(2000 + PROGRESS.finishMs);
    expect(finishedAt(null)).toBe(PROGRESS.capMs + PROGRESS.finishMs);
    expect(finishedAt(60_000)).toBe(PROGRESS.capMs + PROGRESS.finishMs);
  });
});

describe("update offer", () => {
  it("keeps the same object when the same build is found again, so a running Reload does not restart", async () => {
    const { offerUpdate, updateState, dismissUpdate } = await import("../src/lib/update.ts");
    const first = { version: "f00ba47", builtAt: "2026-11-01T00:00:00Z", areas: ["Settings"] };
    offerUpdate(first);
    expect(updateState().available).toBe(first);
    const before = updateState();
    offerUpdate({ ...first, version: "f00ba47aa11" });
    expect(updateState()).toBe(before);
    expect(updateState().available).toBe(first);

    // "Later" still lasts only until the next check.
    dismissUpdate();
    offerUpdate({ ...first });
    expect(updateState().dismissed).toBe(false);
    expect(updateState().available).toBe(first);

    const next = { ...first, version: "c0ffee1" };
    offerUpdate(next);
    expect(updateState().available).toBe(next);
  });
});
