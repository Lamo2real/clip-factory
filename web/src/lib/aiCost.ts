// What a job's AI cost (docs/CONTRACTS.md §50): only formatting. Tokens are shown exactly, money to the cent.
import type { AiCost, Job } from "../api/types.ts";
import { formatMoney } from "./money.ts";

/** The cost to show for a job, or null: old jobs and jobs that never called a model show nothing, never zeros. */
export function aiCostOf(job: Pick<Job, "aiCost">): AiCost | null {
  const c = job.aiCost;
  if (!c || !Array.isArray(c.models) || typeof c.totalDollars !== "number") return null;
  if (!c.totalTokens && !c.transcribe) return null;
  return c;
}

/** "$1.42", or "<$0.01" for a tiny amount. */
export function dollars(d: number): string {
  return formatMoney(Math.round(d * 1_000_000), "USD");
}

/** "about $1.42" when the cost is an estimate. */
export function dollarsText(d: number, estimated: boolean): string {
  return estimated ? `about ${dollars(d)}` : dollars(d);
}

/** Exact tokens with thousands separators: "1,204,311". */
export function tokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "12.5 min" of audio Transcribe heard. */
export function minutes(m: number): string {
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** The small line in the Jobs list. */
export function listCost(c: AiCost): string {
  return dollarsText(c.totalDollars, c.estimated);
}
