// The number on the app icon (docs/CONTRACTS.md §32.6): working jobs only, 0 clears it, never throws.
import { describe, expect, it, vi } from "vitest";
import { badgeSupported, setBadge, workingIds } from "../src/lib/badge.ts";

describe("app icon badge", () => {
  it("counts queued and running jobs only", () => {
    const ids = workingIds([
      { jobId: "a", status: "running" },
      { jobId: "b", status: "queued" },
      { jobId: "c", status: "ready" },
      { jobId: "d", status: "failed" },
    ]);
    expect([...ids]).toEqual(["a", "b"]);
  });

  it("sets the number, clears at 0, and is quiet where there are no badges", async () => {
    const nav = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    await setBadge(3, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    await setBadge(0, nav);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(badgeSupported({})).toBe(false);
    await expect(setBadge(2, {})).resolves.toBeUndefined();
    await expect(setBadge(2, { setAppBadge: () => Promise.reject(new Error("no")) })).resolves.toBeUndefined();
  });
});
