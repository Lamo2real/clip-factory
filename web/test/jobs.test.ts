import { describe, expect, it } from "vitest";
import type { Job } from "../src/api/types.ts";
import { MAX_PAGE, mergeJobs, pollLimit } from "../src/screens/jobs/mergeJobs.ts";

const job = (jobId: string, status: Job["status"] = "running"): Job =>
  ({ jobId, status, progress: 0, clipCount: 0, steps: [], createdAt: "", updatedAt: "" }) as unknown as Job;

describe("jobs live poll", () => {
  it("never asks the API for more than 50 jobs", () => {
    expect(pollLimit(0)).toBe(20);
    expect(pollLimit(37)).toBe(37);
    expect(pollLimit(60)).toBe(MAX_PAGE);
    expect(pollLimit(500)).toBe(50);
  });

  it("updates shown jobs in place, puts new ones on top and keeps older pages", () => {
    const current = [job("c"), job("b"), job("a", "ready")];
    const fresh = [job("d"), job("c", "ready"), job("b")];
    const merged = mergeJobs(current, fresh);
    expect(merged.map((j) => j.jobId)).toEqual(["d", "c", "b", "a"]);
    expect(merged[1]?.status).toBe("ready");
  });

  it("keeps the same list when nothing changed", () => {
    const current = [job("b"), job("a")];
    expect(mergeJobs(current, [job("b"), job("a")]).map((j) => j.jobId)).toEqual(["b", "a"]);
  });
});
