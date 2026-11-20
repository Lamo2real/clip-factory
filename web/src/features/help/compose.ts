// The answer without a model (docs/CONTRACTS.md §19.4): the best doc's own words, steps and buttons. Mirrors
// api/src/clipfactory_api/help/compose.py, so a local answer and a server "kb" answer read the same.
import { boostPage, type Ranked } from "./retrieve.ts";
import type { HelpAction, HelpAnswer, HelpContext } from "./types.ts";

export const REFUSED_TEXT = "I can't help with that. I only know how to use Clip Factory.";
export const UNKNOWN_TEXT = "I don't know that one yet. Try other words, or pick a question below.";
export const OFF_TEXT = "Ask Clip Factory is turned off right now.";
export const BUSY_TEXT = "Let's take a short break. Ask again in a minute.";
export const LIVE_FAILED_TEXT = "I couldn't get that number right now.";
export const GREETING = "Hi! What do you want to do?";

export const GO_HOME: HelpAction = { id: "go-home", label: "Go Home", to: "/" };

export const MAX_ACTIONS = 2;
export const MAX_STEPS = 6;
export const MAX_TEXT = 600;

/** Em and en dashes become a comma and a space (the owner's copy never uses them). */
export function noDashes(text: string): string {
  return text.replace(/\s*[–—]\s*/g, ", ");
}

const PLACEHOLDER = /\{(value|hook|posted|progress|clips|platform)\}/;

/** True when a text still has a live placeholder to fill. */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** Fills {value}, {hook}… from a live read. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}

/** The text without the sentences that wait for a number (used when the number could not be read). */
export function withoutLive(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !hasPlaceholder(s))
    .join(" ")
    .trim();
}

/** Composes the answer from ranked docs: the top doc when known, else the fixed unknown or refused answer. */
export function compose(ranked: Ranked): HelpAnswer {
  if (ranked.refused) return { known: false, refused: true, text: REFUSED_TEXT, steps: [], actions: [], sources: [] };
  const top = ranked.candidates[0]?.doc;
  if (!ranked.known || !top) return { known: false, text: UNKNOWN_TEXT, steps: [], actions: [{ ...GO_HOME }], sources: [] };
  // A live answer leads with its number sentence; the browser fills {value} with the owner's own token (§19.7).
  const text = top.live ? `${top.live.text} ${top.answer}` : top.answer;
  return {
    known: true,
    text: noDashes(text).slice(0, MAX_TEXT),
    steps: top.steps.slice(0, MAX_STEPS).map(noDashes),
    actions: top.actions.slice(0, MAX_ACTIONS),
    sources: [top.id],
    ...(top.live ? { live: top.live } : {}),
  };
}

// ---------- Suggestions ----------

export const SUGGESTIONS = {
  twitch: "How do I make clips from a Twitch link?",
  keep: "What does Upload do?",
  bestViews: "How many views did my best clip get this week?",
  clickSound: "Where do I change my click sound?",
  tiktokPrivate: "Why is my clip private on TikTok?",
} as const;

/** Three questions for the empty state, chosen by the page (§19.8). */
export function suggestionsFor(context: Pick<HelpContext, "page"> | null): string[] {
  const page = boostPage(context?.page); // a skill page gets the Settings chips
  const second = page === "settings" ? SUGGESTIONS.clickSound : page === "clip" ? SUGGESTIONS.tiktokPrivate : SUGGESTIONS.keep;
  return [SUGGESTIONS.twitch, second, SUGGESTIONS.bestViews];
}

/** Splits text on **bold** markers: odd parts are bold (button names). */
export function boldParts(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/\*\*/)
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((p) => p.text.length > 0);
}
