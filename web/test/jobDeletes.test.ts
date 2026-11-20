import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { httpApi } from "../src/api/http.ts";
import type { Api, JobDeleted } from "../src/api/types.ts";
import type { Toaster, UndoOptions } from "../src/components/Toasts.tsx";

// Deleting jobs (docs/CONTRACTS.md §34): the words of the question, the 8-second Undo store, and the two API calls.

const fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));

const { deleteWords } = await import("../src/screens/jobs/DeleteJobsSheet.tsx");
const { BATCH, deleteWithUndo, deletedText, isDeleted, onJobsBack, resetDeletedJobs } = await import(
  "../src/lib/jobDeletes.ts"
);

function toaster() {
  const undos: { text: string; options: UndoOptions }[] = [];
  const errors: string[] = [];
  const t: Toaster = {
    success: () => undefined,
    info: () => undefined,
    error: (text) => void errors.push(text),
    undo: (text, options) => void undos.push({ text, options }),
  };
  return { t, undos, errors };
}

const done = (jobId: string, clipsDeleted = 0): JobDeleted => ({ jobId, deleted: true, clipsDeleted, clipsKept: 0 });
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => {
  resetDeletedJobs();
  for (const k of Object.keys(fake)) delete (fake as Record<string, unknown>)[k];
});

describe("the question's words", () => {
  it("one finished job: what goes, what stays, and Undo", () => {
    const w = deleteWords(1, 0, 0, false);
    expect(w.title).toBe("Delete this job?");
    expect(w.facts.map((f) => f.text)).toEqual(["Its working files go away.", "Clips you kept or posted stay. Your posts stay up too."]);
    expect(w.toggle).toBeNull();
    expect(w.undo).toBe("You can undo for 8 seconds.");
    expect(w.action).toBe("Delete job");
  });

  it("a working job stops first", () => {
    expect(deleteWords(1, 1, 0, false).facts[0]?.text).toBe("It is still working, so it stops first.");
  });

  it("several jobs, some working, with clips in Review (off unless turned on)", () => {
    const w = deleteWords(3, 2, 5, false);
    expect(w.title).toBe("Delete 3 jobs?");
    expect(w.facts[0]?.text).toBe("2 are still working, so they stop first.");
    expect(w.facts[1]?.text).toBe("Their working files go away.");
    expect(w.toggle).toBe("Also delete their 5 clips in Review");
    expect(w.toggleNote).toBe("They stay in Review.");
    expect(deleteWords(3, 2, 5, true).toggleNote).toBe("They go with the job.");
    expect(w.action).toBe("Delete 3 jobs");
    expect(deleteWords(2, 1, 1, false).facts[0]?.text).toBe("1 is still working, so it stops first.");
    expect(deleteWords(1, 0, 1, false).toggle).toBe("Also delete its 1 clip in Review");
  });

  it("the toast", () => {
    expect(deletedText(1)).toBe("Job deleted.");
    expect(deletedText(4)).toBe("4 jobs deleted.");
  });
});

describe("delete with Undo", () => {
  it("hides the job at once, sends nothing on Undo, and brings it back", () => {
    const { t, undos } = toaster();
    fake.deleteJob = vi.fn();
    const back = vi.fn();
    const off = onJobsBack(back);
    deleteWithUndo([{ jobId: "J1", working: true, reviewClips: 2 }], "keep", t);
    expect(isDeleted("J1")).toBe(true);
    expect(undos[0]?.text).toBe("Job deleted.");
    undos[0]!.options.onUndo();
    expect(isDeleted("J1")).toBe(false);
    expect(back).toHaveBeenCalledWith(["J1"]);
    expect(fake.deleteJob).not.toHaveBeenCalled();
    off();
  });

  it("sends one job with DELETE and several in batches of 25, keeping the choice about clips", async () => {
    const { t, undos } = toaster();
    fake.deleteJob = vi.fn(async (id: string) => done(id));
    fake.deleteJobs = vi.fn(async (ids: string[]) => ids.map((id) => done(id)));
    deleteWithUndo([{ jobId: "ONE", working: false, reviewClips: 0 }], "delete", t);
    undos[0]!.options.onCommit();
    await flush();
    expect(fake.deleteJob).toHaveBeenCalledWith("ONE", "delete");

    const many = Array.from({ length: BATCH + 3 }, (_, i) => ({ jobId: `M${i}`, working: false, reviewClips: 0 }));
    const onDeleted = vi.fn();
    deleteWithUndo(many, "keep", t, { onDeleted });
    expect(undos[1]?.text).toBe("28 jobs deleted.");
    undos[1]!.options.onCommit();
    await flush();
    const calls = (fake.deleteJobs as ReturnType<typeof vi.fn>).mock.calls as [string[], string][];
    expect(calls.map((c) => c[0].length)).toEqual([25, 3]);
    expect(calls.every((c) => c[1] === "keep")).toBe(true);
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(many.every((j) => isDeleted(j.jobId))).toBe(true); // they stay hidden after the delete went through
  });

  it("a failed delete brings the job back with an error that says so", async () => {
    const { t, undos, errors } = toaster();
    fake.deleteJob = vi.fn(async () => {
      throw new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
    });
    const onFail = vi.fn();
    deleteWithUndo([{ jobId: "J2", working: false, reviewClips: 0 }], "keep", t, { onFail });
    undos[0]!.options.onCommit();
    await flush();
    expect(isDeleted("J2")).toBe(false);
    expect(onFail).toHaveBeenCalled();
    expect(errors[0]).toBe("Something went wrong on our side. Try again in a moment. The job is back in your list.");
  });

  it("a job already being deleted is not asked about twice", () => {
    const { t, undos } = toaster();
    deleteWithUndo([{ jobId: "J3", working: false, reviewClips: 0 }], "keep", t);
    deleteWithUndo([{ jobId: "J3", working: false, reviewClips: 0 }], "keep", t);
    expect(undos).toHaveLength(1);
  });
});

describe("the API calls", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const auth = { accessToken: vi.fn(async () => "tok") };

  it("DELETE /v1/jobs/{id} with the clips choice, kept alive past a closing page", async () => {
    const fetcher = vi.fn(async () => json(200, done("J1")));
    const api = httpApi({ baseUrl: "https://api.test", auth, fetcher });
    expect(await api.deleteJob("J1", "delete")).toEqual(done("J1"));
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/jobs/J1?clips=delete");
    expect(init.method).toBe("DELETE");
    expect(init.keepalive).toBe(true);
  });

  it("POST /v1/jobs/delete for several", async () => {
    const fetcher = vi.fn(async () => json(200, { results: [done("A"), done("B", 2)] }));
    const api = httpApi({ baseUrl: "https://api.test", auth, fetcher });
    const out = await api.deleteJobs(["A", "B"]);
    expect(out.map((r) => r.jobId)).toEqual(["A", "B"]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/jobs/delete");
    expect(JSON.parse(init.body as string)).toEqual({ jobIds: ["A", "B"], clips: "keep" });
    expect(init.keepalive).toBe(true);
  });
});

