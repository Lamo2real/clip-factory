// Real earnings (docs/CONTRACTS.md §25): showing what a platform reported, and how close the owner is to each paid
// programme. Nothing here calculates money: amounts arrive as whole millionths in the platform's own currency and are
// only formatted, never converted or added across currencies.
import type { MoneyCard, MoneyGoal, MoneyResult, MoneyState, Platform } from "../api/types.ts";
import type { Tone } from "../components/ui.tsx";

export const MONEY_PATH = "/settings/posting/money";

/** "$12.40", "SEK 85.00", "<$0.01" for a tiny positive amount; the platform's currency as reported. */
export function formatMoney(micros: number, currency: string): string {
  const amount = micros / 1_000_000;
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
  if (amount > 0 && amount < 0.01) return `<${format.format(0.01)}`;
  return format.format(amount);
}

/** "812" / "1.2M": goal numbers stay readable on a phone. */
export function goalNumber(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 100_000) return `${trim(n / 1_000)}K`;
  return n.toLocaleString("en-US");
}

const trim = (n: number) => (Math.floor(n * 10) / 10).toString();

/** How far along a bar is, 0..1 (a reached goal is full). */
export function fraction(goal: MoneyGoal): number {
  if (goal.kind === "number" || goal.goal === null || goal.current === null) return 0;
  if (goal.kind === "tick") return goal.current >= 1 ? 1 : 0;
  return Math.max(0, Math.min(1, goal.current / goal.goal));
}

/** "812 / 1,000 subscribers", "Premium: yes", "40.2K impressions in 90 days". */
export function goalText(goal: MoneyGoal): string {
  if (goal.kind === "tick") return goal.current === null ? goal.label : `${goal.label}: ${goal.current >= 1 ? "yes" : "not yet"}`;
  if (goal.current === null) return goal.label;
  if (goal.kind === "number" || goal.goal === null) return `${goalNumber(goal.current)} ${goal.label}`;
  return `${goalNumber(goal.current)} / ${goalNumber(goal.goal)} ${goal.label}`;
}

/** The bars a card shows up front: at most 3 (§25.7); the rest wait under More. */
export const SHOWN_GOALS = 3;

/** One colour meaning per state; vermilion is only ever for actions, so no pill uses it. */
export const STATE_TONE: Record<MoneyState, Tone> = {
  earning: "success",
  in_program: "success",
  goal_reached: "bone",
  not_yet: "neutral",
  counting: "neutral",
  unknown: "neutral",
  needs_permission: "warn",
  not_available: "neutral",
  not_connected: "neutral",
  error: "warn",
};

/** The bar closest to its goal across every card (Home's "here's how close you are"). Ticks and plain numbers skip. */
export function nearestGoal(cards: readonly MoneyCard[]): { platform: Platform; goal: MoneyGoal } | null {
  let best: { platform: Platform; goal: MoneyGoal; f: number } | null = null;
  for (const c of cards) {
    if (c.state === "not_connected") continue;
    for (const g of c.goals) {
      if (g.kind !== "bar" || g.reached || g.current === null) continue;
      const f = fraction(g);
      if (!best || f > best.f) best = { platform: c.platform, goal: g, f };
    }
  }
  return best ? { platform: best.platform, goal: best.goal } : null;
}

/** "2 h ago" for the grey checked line. */
export function checkedAgo(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "checked just now";
  if (min < 60) return `checked ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `checked ${h} h ago`;
  return `checked ${Math.round(h / 24)} days ago`;
}

/** What the owner sees after coming back from "Allow money reading" (§25.4). */
export function resultCopy(result: MoneyResult, name: string): { ok: boolean; text: string } {
  switch (result) {
    case "money_allowed":
      return { ok: true, text: `Done! Clip Factory can read ${name === "TikTok" ? "your TikTok followers" : `money from ${name}`} now. Checking…` };
    case "money_denied":
      return { ok: false, text: `Nothing changed. ${name} was not allowed. Press the button again when you're ready.` };
    case "money_missing":
      return {
        ok: false,
        text:
          name === "TikTok"
            ? "TikTok hasn't approved this yet. Try again after it's approved. Posting still works."
            : `${name} did not give the money permission. Add it in Google Cloud first, then try again. Posting still works.`,
      };
    case "money_wrong_account":
      return { ok: false, text: `That was a different ${name} account. Pick the one you post to, then try again.` };
    case "money_not_connected":
      return { ok: false, text: `Connect ${name} first in Settings › Posting › Set up posting.` };
    default:
      return { ok: false, text: "That did not work. Nothing changed. Try again in a minute." };
  }
}

export const MONEY_RESULTS: readonly MoneyResult[] = [
  "money_allowed",
  "money_denied",
  "money_missing",
  "money_not_connected",
  "money_wrong_account",
  "money_expired",
  "money_error",
];

/** Where each platform pays the owner out: set up inside that platform, never in Clip Factory (§25.7 help). */
export const PAYOUTS: { platform: Platform; where: string; how: string }[] = [
  { platform: "youtube", where: "AdSense for YouTube", how: "Add your bank account in AdSense for YouTube › Payments." },
  { platform: "facebook", where: "Meta Business Suite › Payouts", how: "Add your bank account or PayPal in Meta's payout settings." },
  { platform: "instagram", where: "Professional dashboard › Payouts", how: "Add your bank account or PayPal in Instagram's payout settings (Meta)." },
  { platform: "tiktok", where: "Profile › Balance", how: "Add your bank account or PayPal in your TikTok balance." },
  { platform: "x", where: "X › Monetization", how: "Connect Stripe in X › Monetization. X pays through Stripe." },
];
