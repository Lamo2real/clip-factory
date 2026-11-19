import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumedJob } from "../src/api/mock/fixtures.ts";
import { JobNote } from "../src/screens/jobs/JobNote.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("JobNote", () => {
  it("says the job is picking up where it stopped while it is queued or running", () => {
    const job = resumedJob();
    act(() => root.render(<JobNote job={job} />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Picking up where it stopped…");
    act(() => root.render(<JobNote job={{ ...job, status: "running" }} />));
    expect(host.textContent).toBe("Picking up where it stopped…");
  });

  it("shows nothing once the job has ended or without a note", () => {
    const job = resumedJob();
    for (const status of ["ready", "failed", "canceled"] as const) {
      act(() => root.render(<JobNote job={{ ...job, status }} />));
      expect(host.textContent).toBe("");
    }
    act(() => root.render(<JobNote job={{ ...job, note: undefined }} />));
    expect(host.textContent).toBe("");
  });

  it("keeps the steps already done and the progress in the fixture", () => {
    const job = resumedJob();
    expect(job.progress).toBeGreaterThan(0.7);
    expect(job.steps.find((s) => s.key === "select")?.status).toBe("done");
  });
});
