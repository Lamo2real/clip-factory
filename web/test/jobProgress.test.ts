import { describe, expect, it } from "vitest";
import { jobPercent, jobProgress, WORKING_CAP } from "../src/lib/jobProgress.ts";

// Owner report 2026-11-20: the job page said 100% with a full bar while "Check each clip" was still running. Only a
// ready job is ever full.
describe("jobProgress", () => {
  it("never shows 100% for a job that is not ready", () => {
    for (const status of ["queued", "running", "failed", "canceled"] as const) {
      expect(jobProgress({ status, progress: 1 })).toBe(WORKING_CAP);
      expect(jobPercent({ status, progress: 1 })).toBe(99);
      expect(jobPercent({ status, progress: 0.998 })).toBe(99);
    }
  });

  it("shows 100% for a ready job", () => {
    expect(jobPercent({ status: "ready", progress: 1 })).toBe(100);
    expect(jobPercent({ status: "ready", progress: 0.4 })).toBe(100);
  });

  it("keeps a real value and handles junk", () => {
    expect(jobPercent({ status: "running", progress: 0.86 })).toBe(86);
    expect(jobProgress({ status: "running", progress: -1 })).toBe(0);
    expect(jobProgress({ status: "running", progress: Number.NaN })).toBe(0);
  });
});
