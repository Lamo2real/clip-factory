// Get paid's guides (docs/CONTRACTS.md §40.1): one per platform in STATS_ORDER, then Content Rewards, whose page shows
// §38.7's money steps (CR_GUIDE's parts `move` and `bank`, words and ticks unchanged) instead of a guide of its own.
// Plain data and small pure helpers: the screens draw them, the tests check them.
import type { GetPaidPlace, Platform } from "../api/types.ts";
import { facebook } from "./facebook.ts";
import { instagram } from "./instagram.ts";
import { tiktok } from "./tiktok.ts";
import type { GetPaidFact, GetPaidGuide, GetPaidStep } from "./types.ts";
import { x } from "./x.ts";
import { youtube } from "./youtube.ts";

export type { GetPaidAuto, GetPaidFact, GetPaidGuide, GetPaidRole, GetPaidStep } from "./types.ts";
export { ADSENSE_SCOPE } from "./youtube.ts";

export const GETPAID_PATH = "/settings/posting/getpaid";
export const getPaidPath = (place: GetPaidPlace) => `${GETPAID_PATH}/${place}`;

/** The five platforms in STATS_ORDER, then Content Rewards (only while Content Rewards is on). */
export const GETPAID_ORDER: readonly GetPaidPlace[] = ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"];

export const GETPAID_GUIDES: Record<Platform, GetPaidGuide> = { youtube, tiktok, instagram, facebook, x };

export const isGetPaidPlace = (v: unknown): v is GetPaidPlace => typeof v === "string" && (GETPAID_ORDER as readonly string[]).includes(v);

/** Content Rewards' page (§40.1): no guide of its own, only its facts, time and cost. */
export const CR_GETPAID = {
  name: "Content Rewards",
  checkedOn: "2026-11-21",
  minutes: 15,
  cost: "Free",
  facts: [
    { text: "Content Rewards sends your money to Whop. Whop sends it to your bank.", source: "https://docs.whop.com/manage-your-business/manage-payouts/set-up-payouts" },
    { text: "Moving to Whop is free from $1.", source: "https://contentrewards.com/c/earnings" },
    { text: "Whop checks your ID and a selfie once.", source: "https://docs.whop.com/manage-your-business/manage-payouts/set-up-payouts" },
    { text: "Whop to your bank takes up to 5 workdays.", source: "https://docs.whop.com/manage-your-business/manage-payouts/payout-methods" },
  ] satisfies GetPaidFact[],
} as const;

/** "YouTube", "Content Rewards". */
export function placeName(place: GetPaidPlace): string {
  return place === "contentrewards" ? CR_GETPAID.name : GETPAID_GUIDES[place].name;
}

/** "Read YouTube's rules", "Read Content Rewards' rules" (Instagram's pages are Meta's help, still Instagram's rules). */
export function rulesLabel(place: GetPaidPlace, source: string): string {
  const owner = place === "contentrewards" ? (/whop\.com/.test(source) ? "Whop" : "Content Rewards") : placeName(place);
  return `Read ${owner}${owner.endsWith("s") ? "'" : "'s"} rules`;
}

/** The numbered steps: `earn` then `payout`, in the guide's order (the ring counts exactly these). */
export function numberedSteps(guide: GetPaidGuide): GetPaidStep[] {
  return guide.steps.filter((s) => s.role === "earn" || s.role === "payout");
}

/** A step's number ("Step 3"), or null for the optional reading step and the each-time steps. */
export function stepNumber(guide: GetPaidGuide, id: string): number | null {
  const i = numberedSteps(guide).findIndex((s) => s.id === id);
  return i < 0 ? null : i + 1;
}

/** The steps in the order the page draws them: the numbered ones (the reading step right after step 1), then each-time. */
export function drawnSteps(guide: GetPaidGuide): GetPaidStep[] {
  const numbered = numberedSteps(guide);
  const reading = guide.steps.filter((s) => s.role === "reading");
  const each = guide.steps.filter((s) => s.role === "each_time");
  return [...numbered.slice(0, 1), ...reading, ...numbered.slice(1), ...each];
}

/** The facts for his country (`GET /v1/money`'s `country`); with none picked, only the facts that hold everywhere. */
export function factsFor(facts: readonly GetPaidFact[], country: string | null): GetPaidFact[] {
  return facts.filter((f) => !f.countries || (country !== null && f.countries.includes(country)));
}

/** The facts grouped by their official page, in order: one "Read YouTube's rules" per different page. */
export function factGroups(facts: readonly GetPaidFact[]): { source: string; texts: string[] }[] {
  const out: { source: string; texts: string[] }[] = [];
  for (const f of facts) {
    const g = out.find((x) => x.source === f.source);
    if (g) g.texts.push(f.text);
    else out.push({ source: f.source, texts: [f.text] });
  }
  return out;
}

/** "About 30 minutes over a few weeks · Free" (§40.1 header). */
export function getPaidTime(place: GetPaidPlace): string {
  const g = place === "contentrewards" ? null : GETPAID_GUIDES[place];
  const minutes = g?.minutes ?? CR_GETPAID.minutes;
  const cost = g?.cost ?? CR_GETPAID.cost;
  return `About ${minutes} minutes${g?.timeNote ? ` ${g.timeNote}` : ""} · ${cost}`;
}

/** "21 Nov 2026" */
export const GETPAID_CHECKED = "21 Nov 2026";

/** Every Get paid step id of the five guides (meta-payout once), for the tests and the mock. */
export function allGetPaidSteps(): { place: Platform; step: GetPaidStep }[] {
  return (Object.keys(GETPAID_GUIDES) as Platform[]).flatMap((place) => GETPAID_GUIDES[place].steps.map((step) => ({ place, step })));
}

/** "the TikTok app": where a `phone` step is done. */
export function phoneApp(place: Platform): string {
  return `the ${GETPAID_GUIDES[place].name} app`;
}
