// The ten job steps and the "Why:" line (docs/DECISIONS.md ADR-40, CONTRACTS §5, §8).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STEP_KEYS, STEP_LABELS, seed, stepsAt } from "../src/api/mock/fixtures.ts";
import type { Step } from "../src/api/types.ts";
import { StepTimeline } from "../src/components/JobBits.tsx";
import { WhyPicked } from "../src/screens/review/Review.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const LABELS = [
  ["resolve", "Find the video"],
  ["download", "Get the video"],
  ["transcribe", "Write down the words"],
  ["analyze", "Listen for big moments"],
  ["watch", "Watch the video"],
  ["select", "Pick the best moments"],
  ["render", "Cut the clips"],
  ["checklist", "Check each clip"],
  ["captions", "Write the captions"],
  ["finalize", "Finish up"],
] as const;

describe("the ten steps", () => {
  it("the mock has the same keys and labels, in the same order, as the API and the agent", () => {
    expect(STEP_KEYS.map((k) => [k, STEP_LABELS[k]])).toEqual(LABELS);
    const api = readFileSync(join(import.meta.dirname, "..", "..", "api", "src", "clipfactory_api", "jobs.py"), "utf8");
    const block = api.slice(api.indexOf("STEPS: tuple"), api.indexOf("ACTIVE ="));
    expect([...block.matchAll(/\("(\w+)", "([^"]+)"\)/g)].map((m) => [m[1], m[2]])).toEqual(LABELS);
  });

  it("labels are short, plain words", () => {
    for (const [, label] of LABELS) {
      expect(label.split(" ").length, label).toBeLessThanOrEqual(4);
      expect(label, label).not.toMatch(/transcri|analy|audio|render|checklist|download/i);
    }
  });

  it("stepsAt puts the running step where it belongs", () => {
    const steps = stepsAt(4, "running", "Looking");
    expect(steps).toHaveLength(10);
    expect(steps[4]).toMatchObject({ key: "watch", label: "Watch the video", status: "running", message: "Looking" });
    expect(steps.slice(0, 4).every((s) => s.status === "done")).toBe(true);
    expect(stepsAt(10, "ready").every((s) => s.status === "done")).toBe(true);
  });

  it("seeded steps sit at their key, not at a position (a message names its own step)", () => {
    const jobs = seed().jobs;
    const running = jobs.find((j) => j.status === "running")!;
    const now = running.steps.find((s) => s.status === "running")!;
    expect(now.message).toBe("Cutting clip 3 of 7");
    expect(now.key).toBe("render");
    const failed = jobs.find((j) => j.status === "failed")!;
    expect(failed.steps.find((s) => s.status === "failed")?.key).toBe("download");
  });

  it("every seeded job has ten steps", () => {
    for (const j of seed().jobs) expect(j.steps.map((s) => s.key), j.jobId).toEqual(STEP_KEYS);
  });

  it("the timeline shows ten steps, and a skipped watch step with its message", () => {
    const steps = stepsAt(10, "ready");
    steps[4] = { ...steps[4]!, status: "skipped", message: "Could not watch the video this time. Picking from the words and the sound." };
    act(() => root.render(<StepTimeline steps={steps} />));
    const rows = [...host.querySelectorAll(".timeline__step")];
    expect(rows).toHaveLength(10);
    expect(rows[4]!.className).toContain("is-skipped");
    expect(rows[4]!.textContent).toContain("Watch the video, skipped");
    expect(rows[4]!.querySelector(".timeline__msg")!.textContent).toBe("Could not watch the video this time. Picking from the words and the sound.");
  });

  it("a job saved with the old nine steps still renders", () => {
    const old: Step[] = stepsAt(10, "ready").filter((s) => s.key !== "watch");
    act(() => root.render(<StepTimeline steps={old} />));
    const rows = [...host.querySelectorAll(".timeline__step")];
    expect(rows).toHaveLength(9);
    expect(host.textContent).not.toContain("Watch the video");
    expect(rows.every((r) => r.className.includes("is-done"))).toBe(true);
  });
});

describe("why a clip was picked", () => {
  it("shows the words after Why:", () => {
    act(() => root.render(<WhyPicked text="Loud laugh + Fast action" />));
    const line = host.querySelector(".review-card__why")!;
    expect(line.textContent).toBe("Why: Loud laugh + Fast action");
  });

  it("says when the chat went wild", () => {
    act(() => root.render(<WhyPicked text="Chat went wild + Loud laugh" />));
    expect(host.querySelector(".review-card__why")!.textContent).toBe("Why: Chat went wild + Loud laugh");
    expect(seed().clips.some((c) => c.pickedFor === "Chat went wild + Loud laugh")).toBe(true);
  });

  it("shows nothing at all without them", () => {
    act(() => root.render(<WhyPicked text={undefined} />));
    expect(host.innerHTML).toBe("");
    act(() => root.render(<WhyPicked text="" />));
    expect(host.innerHTML).toBe("");
  });

  it("some mock clips have a reason and some do not, and none is longer than 40 characters", () => {
    const clips = seed().clips;
    const withWhy = clips.filter((c) => c.pickedFor);
    expect(withWhy.length).toBeGreaterThan(0);
    expect(withWhy.length).toBeLessThan(clips.length);
    for (const c of withWhy) expect(c.pickedFor!.length, c.pickedFor).toBeLessThanOrEqual(40);
  });

  it("the line has no cursor rule (the mouse cursor never changes)", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "screens.css"), "utf8");
    const at = css.indexOf(".review-card__why {");
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf(".review-card__source {"))).not.toMatch(/cursor/);
  });
});
