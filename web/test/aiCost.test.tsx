// What a job's AI cost (docs/CONTRACTS.md §51): old jobs show nothing, a finished job shows the total, the tokens
// and a fold with a row per model, a failed job says "so far", an estimate says "about".
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiCost, Job } from "../src/api/types.ts";
import { aiCostOf, dollars, dollarsText, listCost, minutes, tokens } from "../src/lib/aiCost.ts";
import { AiCostBlock } from "../src/screens/jobs/AiCost.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cost: AiCost = {
  v: 1,
  models: [
    { key: "fable-5-1", label: "Claude Fable 5.1", calls: 38, inputTokens: 1_284_311, outputTokens: 96_204, cacheReadTokens: 10, cacheWriteTokens: 5, tokens: 1_380_530, dollars: 11.42, estimated: false },
    { key: "nova-2-lite", label: "Amazon Nova 2 Lite", calls: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 6, estimated: true },
  ],
  transcribe: { seconds: 300, minutes: 5, dollars: 0.12, estimated: false },
  totalTokens: 1_380_536,
  totalCalls: 39,
  totalDollars: 11.54,
  estimated: false,
  pricesChecked: "2026-11-25",
};
const job = (over: Partial<Job>): Job => ({ jobId: "j", status: "ready", ...over }) as Job;

let host: HTMLDivElement;
let root: Root;
const render = (j: Job) => act(() => root.render(<AiCostBlock job={j} />));
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the cost numbers", () => {
  it("writes money to the cent and tokens exactly", () => {
    expect(dollars(11.4249)).toBe("$11.42");
    expect(dollars(0.0004)).toBe("<$0.01");
    expect(dollarsText(1.5, true)).toBe("about $1.50");
    expect(tokens(1_284_311)).toBe("1,284,311");
    expect(minutes(5)).toBe("5.0 min");
    expect(minutes(280)).toBe("280 min");
    expect(listCost(cost)).toBe("$11.54");
  });
  it("shows nothing for jobs from before it, never zeros", () => {
    expect(aiCostOf(job({}))).toBeNull();
    expect(aiCostOf(job({ aiCost: { ...cost, models: [], totalTokens: 0, transcribe: undefined } }))).toBeNull();
    render(job({}));
    expect(host.textContent).toBe("");
  });
});

describe("What this cost", () => {
  it("shows the total, the tokens and one row per model in the fold", () => {
    render(job({ aiCost: cost }));
    expect(host.querySelector(".ai-cost__total")!.textContent).toContain("$11.54");
    expect(host.querySelector(".ai-cost__tokens")!.textContent).toContain("1,380,536 tokens");
    expect(host.textContent).toContain("See the details");
    const rows = [...host.querySelectorAll(".ai-cost__row")].map((r) => r.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Claude Fable 5.1");
    expect(rows[0]).toContain("38 calls");
    expect(rows[0]).toContain("1,284,311 in");
    expect(rows[1]).toContain("price not known");
    expect(rows[2]).toContain("Amazon Transcribe");
    expect(host.textContent).toContain("Prices checked 25 Nov");
    expect(host.textContent).not.toContain("so far");
  });
  it("says so far for a failed job and about for an estimate", () => {
    render(job({ status: "failed", aiCost: { ...cost, estimated: true } }));
    expect(host.textContent).toContain("so far");
    expect(host.querySelector(".ai-cost__about")).not.toBeNull();
    expect(host.textContent).toContain("about, not exact");
  });
});
