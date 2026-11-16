// Home, Jobs and the app shell: fixes from the UI audit (F009, F010, F011, F023, F078, F079, F087, F088).
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Job } from "../src/api/types.ts";
import type { Toaster, UndoOptions } from "../src/components/Toasts.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The screens call api(); each test puts in the methods it needs.
const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));

const { isStopping, resetPendingStops, stopWithUndo } = await import("../src/screens/jobs/pendingStops.ts");
const { clipTileHref, emptyClipsText } = await import("../src/screens/jobs/JobDetail.tsx");
const { loadHome } = await import("../src/screens/home/Home.tsx");
const { decodeHash } = await import("../src/lib/router.ts");
const { JOB_STATUS } = await import("../src/components/JobBits.tsx");
const { ErrorBoundary } = await import("../src/app/ErrorBoundary.tsx");
const { mockApi } = await import("../src/api/mock/index.ts");
const { seed } = await import("../src/api/mock/fixtures.ts");

function toaster() {
  const undos: UndoOptions[] = [];
  const said: string[] = [];
  const t: Toaster = {
    success: (s) => void said.push(`success:${s}`),
    error: (s) => void said.push(`error:${s}`),
    info: (s) => void said.push(`info:${s}`),
    undo: (_s, o) => void undos.push(o),
  };
  return { t, undos, said };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Stop job waits for Undo outside the page (F009)", () => {
  beforeEach(() => {
    resetPendingStops();
    for (const k of Object.keys(fake)) delete (fake as Record<string, unknown>)[k];
  });

  it("stays pending after the page is gone, and a second Stop does not start another", async () => {
    const { t, undos } = toaster();
    stopWithUndo("J1", t);
    expect(isStopping("J1")).toBe(true);
    // Coming back to the page and tapping Stop again (the button is hidden, but even if it ran) adds nothing.
    stopWithUndo("J1", t);
    expect(undos).toHaveLength(1);
  });

  it("Undo clears it and sends nothing", () => {
    const cancel = vi.fn();
    fake.cancelJob = cancel;
    const { t, undos } = toaster();
    const onUndo = vi.fn();
    stopWithUndo("J1", t, { onUndo });
    undos[0]!.onUndo();
    expect(isStopping("J1")).toBe(false);
    expect(onUndo).toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("sends the cancel when the time is up, says Job stopped, then clears", async () => {
    fake.cancelJob = vi.fn(async () => ({ jobId: "J1", status: "canceled" }) as Job);
    const { t, undos, said } = toaster();
    const onStopped = vi.fn();
    stopWithUndo("J1", t, { onStopped });
    undos[0]!.onCommit();
    expect(isStopping("J1")).toBe(true);
    await flush();
    expect(said).toEqual(["info:Job stopped."]);
    expect(onStopped).toHaveBeenCalled();
    expect(isStopping("J1")).toBe(false);
  });

  it("a job that finished inside the Undo window is left alone quietly (no error toast, no shake)", async () => {
    fake.cancelJob = vi.fn(async () => {
      throw new ApiError(409, "conflict", "Only a job that is still working can be canceled.");
    });
    const { t, undos, said } = toaster();
    const onFail = vi.fn();
    stopWithUndo("J1", t, { onFail });
    undos[0]!.onCommit();
    await flush();
    expect(said).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
    expect(isStopping("J1")).toBe(false);
  });

  it("any other failure shows the friendly error and shakes", async () => {
    fake.cancelJob = vi.fn(async () => {
      throw new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment.");
    });
    const { t, undos, said } = toaster();
    const onFail = vi.fn();
    stopWithUndo("J1", t, { onFail });
    undos[0]!.onCommit();
    await flush();
    expect(said).toEqual(["error:Something went wrong on our side. Try again in a moment."]);
    expect(onFail).toHaveBeenCalled();
  });
});

describe("Home still shows its lists when the numbers fail (F010)", () => {
  it("a failed insights call blanks only the views", async () => {
    fake.listJobs = vi.fn(async () => ({ jobs: [], nextCursor: null }));
    fake.listClips = vi.fn(async () => []);
    fake.insights = vi.fn(async () => {
      throw new Error("boom");
    });
    const data = await loadHome();
    expect(data).toEqual({ jobs: [], review: [], views: null, postsChecked: 0 });
  });

  it("a failed jobs call still fails the load (Home then shows Try again)", async () => {
    fake.listJobs = vi.fn(async () => {
      throw new Error("down");
    });
    fake.listClips = vi.fn(async () => []);
    fake.insights = vi.fn(async () => ({ posts: [] }) as unknown as Awaited<ReturnType<Api["insights"]>>);
    await expect(loadHome()).rejects.toThrow("down");
  });
});

describe("job page clip tiles and empty text (F023, F088)", () => {
  it("review opens Review, kept clips open their own page, a thrown-away clip is not a link", () => {
    expect(clipTileHref({ clipId: "C", status: "review" })).toBe("/review#clip-C");
    for (const status of ["confirmed", "publishing", "posted", "failed"] as const)
      expect(clipTileHref({ clipId: "C", status })).toBe("/clips/C");
    expect(clipTileHref({ clipId: "C", status: "declined" })).toBeNull();
  });

  it("a failed job's empty Clips line points at the fix above, not away from it", () => {
    expect(emptyClipsText("failed")).toContain("Try again");
    expect(emptyClipsText("failed")).not.toContain("Home");
    expect(emptyClipsText("canceled")).toContain("Try again");
    expect(emptyClipsText("ready")).toContain("try a different link");
    expect(emptyClipsText("running")).toContain("as soon as they are made");
  });
});

describe("kid-proof words (F087)", () => {
  it("the job status pill never says Failed", () => {
    expect(JOB_STATUS.failed.label).toBe("Didn't work");
    for (const s of Object.values(JOB_STATUS)) expect(s.label).not.toMatch(/fail/i);
  });
});

describe("a malformed #hash never crashes the app (F011)", () => {
  it("decodes good anchors and keeps bad ones as typed", () => {
    expect(decodeHash("clip-%41")).toBe("clip-A");
    expect(decodeHash("100%")).toBe("100%");
    expect(decodeHash("%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("a screen that throws shows a friendly card with Try again instead of a blank page", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = document.createElement("div");
    const root = createRoot(host);
    function Boom(): never {
      throw new Error("render broke");
    }
    act(() =>
      root.render(
        <ErrorBoundary scope="page" resetKey="a">
          <Boom />
        </ErrorBoundary>,
      ),
    );
    expect(host.querySelector("h1")?.textContent).toBe("Something went wrong on this page");
    expect(host.textContent).toContain("Try again");
    expect(host.textContent).toContain("Go home");
    act(() =>
      root.render(
        <ErrorBoundary scope="page" resetKey="b">
          <p>fine</p>
        </ErrorBoundary>,
      ),
    );
    expect(host.textContent).toBe("fine");
    act(() => root.unmount());
    err.mockRestore();
  });
});

describe("mock knobs for Show older jobs and a failing Make clips (F078, F079)", () => {
  afterEach(() => vi.useRealTimers());

  it("jobsPageSize pages the jobs list; olderJobsFails fails only the next older page", async () => {
    const faults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000, jobsPageSize: 3, olderJobsFails: 1 };
    const m = mockApi(seed(), faults);
    const first = await m.listJobs({ limit: 20 });
    expect(first.jobs).toHaveLength(3);
    expect(first.nextCursor).toBe("3");
    await expect(m.listJobs({ limit: 20, cursor: first.nextCursor! })).rejects.toBeInstanceOf(ApiError);
    const second = await m.listJobs({ limit: 20, cursor: first.nextCursor! });
    expect(second.jobs).toHaveLength(3);
    const last = await m.listJobs({ limit: 20, cursor: second.nextCursor! });
    expect(last.nextCursor).toBeNull();
  });

  it("createJobFails makes the next Make clips fail once", async () => {
    const faults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000, createJobFails: 1 };
    const m = mockApi(seed(), faults);
    const body = { source: { type: "link" as const, url: "https://youtu.be/dQw4w9WgXcQ" }, clipTarget: { min: 5, max: 10 } };
    await expect(m.createJob(body)).rejects.toMatchObject({ status: 503 });
    await expect(m.createJob(body)).resolves.toMatchObject({ status: "queued" });
  });
});
