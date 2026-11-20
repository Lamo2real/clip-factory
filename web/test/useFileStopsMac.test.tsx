// Use a video file on a link job (§35.8): the desktop app stops its copy only when the server really stopped that job.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Job } from "../src/api/types.ts";

const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));

const { stopMacCopy, fileStart } = await import("../src/screens/home/NewJobForm.tsx");
const { seed } = await import("../src/api/mock/fixtures.ts");

const cancel = vi.fn(async () => undefined);
const job = (over: Partial<Job>): Job => ({ ...seed().jobs[0]!, ...over });

function bridge(on: boolean): void {
  (window as { __CF_MAC_FETCH__?: unknown }).__CF_MAC_FETCH__ = on
    ? { version: 1, start: vi.fn(), status: vi.fn(), upload: vi.fn(), cancel }
    : undefined;
}

beforeEach(() => {
  cancel.mockClear();
  bridge(true);
});
afterEach(() => bridge(false));

describe("stopMacCopy", () => {
  it("stops the Mac's download when this file replaced the job", async () => {
    fake.getJob = vi.fn(async () => ({ job: job({ status: "canceled", replacedBy: "NEW" }), clips: [] }));
    expect(await stopMacCopy("OLD", "NEW")).toBe(true);
    expect(cancel).toHaveBeenCalledWith("OLD");
  });

  it("keeps the download when the job is still waiting (the server's replace gave up)", async () => {
    fake.getJob = vi.fn(async () => ({ job: job({ status: "running" }), clips: [] }));
    expect(await stopMacCopy("OLD", "NEW")).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the download when another file replaced it, or the job cannot be read", async () => {
    fake.getJob = vi.fn(async () => ({ job: job({ status: "canceled", replacedBy: "OTHER" }), clips: [] }));
    expect(await stopMacCopy("OLD", "NEW")).toBe(false);
    fake.getJob = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await stopMacCopy("OLD", "NEW")).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does nothing outside the desktop app", async () => {
    bridge(false);
    fake.getJob = vi.fn(async () => ({ job: job({ status: "canceled", replacedBy: "NEW" }), clips: [] }));
    expect(await stopMacCopy("OLD", "NEW")).toBe(false);
    expect(fake.getJob).not.toHaveBeenCalled();
  });

  it("reads the job to replace only from a safe from= id", () => {
    expect(fileStart("?file=1&from=01JABC").from).toBe("01JABC");
    expect(fileStart("?file=1&from=../x").from).toBeNull();
  });
});
