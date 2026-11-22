// The campaign finder on the web (docs/CONTRACTS.md §41): the shared GET /v1/contentrewards/finder store and its
// 404 / 503 rule, the debounced What you want saves, the `places: null` rule, the live refetch, what the page keeps
// for the visit (the "You're in!" rows and the frozen "New" set), and `finderHref` (§41.6 change 2).
//
// The web never decides a match: every match, line and count is the server's (§41.3). Money is only formatted, never
// worked out (§25): no rate × views, no sums.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { CampaignSummary, CrFinderSummary, Finder, FinderLanguage, FinderMatch, FinderWant, Platform, SetupOverview } from "../api/types.ts";
import { CR_DISCOVER } from "../setup/contentrewards.ts";
import { FIND_PATH, dayDate, findAnother, useCr } from "./contentRewards.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER, plural } from "./format.ts";
import { onLiveSignal } from "./live.ts";

export { FIND_PATH };

/** What the Find page says while the API is before §41 (404) or the finder is switched off (503). */
export const FINDER_SOON = "Find campaigns is coming soon to Clip Factory.";
/** A place's setup page, with the way back to the Find page (§41.6 change 7: only a place's own page reads `back`). */
export const setupPlaceHref = (p: Platform) => `/settings/posting/setup/${p}?back=${FIND_PATH}`;

/** The defaults literal of §41.3 (the same in the api's finder/config.py and finderapi.py). */
export const WANT_DEFAULTS: FinderWant = {
  on: true,
  minPer1kCents: 100,
  places: null,
  categories: [],
  minLeftPct: 25,
  access: "open",
  otherPay: false,
  languages: [],
  tellMe: true,
};

export const PAY_CHOICES: { value: FinderWant["minPer1kCents"]; label: string }[] = [
  { value: 50, label: "$0.50" },
  { value: 100, label: "$1" },
  { value: 200, label: "$2" },
  { value: 300, label: "$3" },
];
/** An open campaign: anyone can join it with one tap on Content Rewards (no application). */
export const ANYONE_CAN_JOIN = "Anyone can join";
export const LEFT_CHOICES: { value: FinderWant["minLeftPct"]; label: string }[] = [
  { value: 0, label: "Any" },
  { value: 25, label: "Some left" },
  { value: 50, label: "Half or more" },
  { value: 75, label: "Most left" },
];
export const ACCESS_CHOICES: { value: FinderWant["access"]; label: string }[] = [
  { value: "open", label: ANYONE_CAN_JOIN },
  { value: "any", label: "Also ones I apply to" },
];
export const LANGUAGE_CHOICES: { value: FinderLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "pt", label: "Portuguese" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
];

/** "I joined: add it" leads for 2 hours after Open on Content Rewards (§41.1). */
export const OPENED_FRESH_MS = 2 * 60 * 60_000;
/** The page shows 10 matches, then Show more up to 20. */
export const FIRST_SHOWN = 10;

// ---------- The 404 / 503 rule ----------

export type FinderAvailability = "missing" | "soon" | "error";

/** 404: an API from before §41. 503 (any code: Content Rewards or the finder switched off): coming soon. */
export function finderAvailability(e: unknown): FinderAvailability {
  if (e instanceof ApiError && e.status === 404) return "missing";
  if (e instanceof ApiError && e.status === 503) return "soon";
  return "error";
}

// ---------- The store: GET /v1/contentrewards/finder, again on live `finder` news (1 s debounce) and a resync ----------

export type FinderSnap =
  | { state: "loading"; data: null }
  | { state: "missing"; data: null }
  | { state: "soon"; data: null }
  | { state: "error"; data: Finder | null; error: string }
  | { state: "ok"; data: Finder };

let snap: FinderSnap = { state: "loading", data: null };
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let unlisten: (() => void) | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: FinderSnap) {
  snap = next;
  for (const fn of listeners) fn();
}

/** Reads GET /v1/contentrewards/finder (one call at a time; one asked for meanwhile runs once after it). */
export function reloadFinder(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      set({ state: "ok", data: await api().crFinder() });
    } catch (e) {
      const kind = finderAvailability(e);
      if (kind === "missing") set({ state: "missing", data: null });
      else if (kind === "soon") set({ state: "soon", data: null });
      else set({ state: "error", data: snap.data, error: friendlyMessage(e) });
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void reloadFinder();
      }
    }
  })();
  return inFlight;
}

/** The live news that the finder changed (§41.5 Live): `{type: "contentrewards", id: "finder"}`. */
export const FINDER_LIVE_ID = "finder";
export const LIVE_DEBOUNCE_MS = 1000;

function ensureStarted() {
  if (started) return;
  started = true;
  void reloadFinder();
  unlisten = onLiveSignal((s) => {
    if (s.kind !== "resync" && !(s.event.type === "contentrewards" && s.event.id === FINDER_LIVE_ID)) return;
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = null;
      void reloadFinder();
    }, LIVE_DEBOUNCE_MS);
  });
}

/** Puts a newer Finder (a PATCH's answer) in the store at once. */
export function putFinder(f: Finder): void {
  set({ state: "ok", data: f });
}

/** Forgets everything (sign-out, tests). */
export function resetFinder(): void {
  unlisten?.();
  unlisten = null;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = null;
  started = false;
  inFlight = null;
  again = false;
  snap = { state: "loading", data: null };
  for (const fn of listeners) fn();
}

/** The finder every part of the Find page shares (the page reads GET /v1/contentrewards/finder again on each visit). */
export function useFinder(): FinderSnap & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      ensureStarted();
      return () => listeners.delete(fn);
    },
    () => snap,
    () => snap,
  );
  const reload = useCallback(() => reloadFinder(), []);
  return { ...state, reload };
}

/** The store as it is now, without reading the API (Home and the Campaigns page make no extra call). */
function useFinderPeek(): FinderSnap {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snap,
    () => snap,
  );
}

/**
 * The overview's `finder` (§41.5) when the finder is on: present whenever it is switched on, absent while off or on
 * an older API. Also null once the Find page learned GET /finder answers 404 or 503 (then every entry hides).
 */
export function useFinderSummary(): CrFinderSummary | null {
  const cr = useCr();
  const peek = useFinderPeek();
  if (peek.state === "missing" || peek.state === "soon") return null;
  const data = cr.state === "ok" ? cr.data : cr.state === "error" ? cr.data : null;
  return data?.finder ?? null;
}

// ---------- §41.6 change 2: "Find another campaign" opens the Find page ----------

/**
 * Where a "Find another campaign" goes: Content Rewards' Discover becomes the Find page (same tab) while the
 * overview has `finder`; every other href stays as it is.
 */
export function finderHref(href: string, finderOn: boolean): { href: string; external: boolean } {
  if (finderOn && href === CR_DISCOVER) {
    const to = findAnother(true);
    return { href: to.href, external: to.external };
  }
  return { href, external: /^https?:\/\//.test(href) };
}

// ---------- What you want ----------

/** The places a chip can be on for: set up (`ready` in GET /v1/setup), TikTok only once its audit passed. */
export function readyPlaces(setup: SetupOverview | null | undefined, tiktokWaits: boolean): Platform[] {
  const ready = new Set((setup?.platforms ?? []).filter((p) => p.ready).map((p) => p.platform));
  return PLATFORM_ORDER.filter((p) => ready.has(p) && !(p === "tiktok" && tiktokWaits));
}

/** The chips that are on: `null` means every ready place. */
export function pickedPlaces(want: Pick<FinderWant, "places">, ready: readonly Platform[]): Platform[] {
  const list = want.places ?? ready;
  return PLATFORM_ORDER.filter((p) => list.includes(p) && ready.includes(p));
}

/** What S sends: `null` whenever the picked chips equal every ready place (a place set up later joins by itself). */
export function wantPlaces(picked: readonly Platform[], ready: readonly Platform[]): Platform[] | null {
  const a = PLATFORM_ORDER.filter((p) => picked.includes(p));
  const b = PLATFORM_ORDER.filter((p) => ready.includes(p));
  return a.length === b.length && a.every((p, i) => p === b[i]) ? null : a;
}

/** Turns one chip on or off: null when it would leave no place at all (one must stay on). */
export function togglePlace(picked: readonly Platform[], p: Platform, ready: readonly Platform[]): Platform[] | null {
  const next = picked.includes(p) ? picked.filter((x) => x !== p) : [...picked, p];
  const out = PLATFORM_ORDER.filter((x) => next.includes(x) && ready.includes(x));
  return out.length ? out : null;
}

/** Toggles one id of a many-choice row ("Anything" / "Any" is the empty list). */
export function toggleIn<T extends string>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

const LEFT_SUMMARY: Record<FinderWant["minLeftPct"], string> = {
  0: "Any money left",
  25: "Some money left",
  50: "Half or more of the money left",
  75: "Most of the money left",
};

/** The folded card's one line: "At least $1 per 1,000 views · YouTube, Instagram · Some money left · Anyone can join". */
export function wantSummary(want: FinderWant, places: readonly Platform[], categories: readonly { id: string; name: string }[] = []): string {
  const pay = PAY_CHOICES.find((c) => c.value === want.minPer1kCents)?.label ?? "$1";
  const parts = [`At least ${pay} per 1,000 views`];
  const names = PLATFORM_ORDER.filter((p) => places.includes(p)).map((p) => PLATFORM_LABEL[p]);
  if (names.length) parts.push(names.join(", "));
  parts.push(LEFT_SUMMARY[want.minLeftPct] ?? LEFT_SUMMARY[25]);
  parts.push(want.access === "any" ? "Also ones I apply to" : ANYONE_CAN_JOIN);
  const topics = want.categories.map((id) => categories.find((c) => c.id === id)?.name ?? id).filter(Boolean);
  if (topics.length) parts.push(topics.join(", "));
  const langs = LANGUAGE_CHOICES.filter((l) => want.languages.includes(l.value)).map((l) => l.label);
  if (langs.length) parts.push(langs.join(", "));
  if (want.otherPay) parts.push("Other kinds of pay too");
  return parts.join(" · ");
}

export type WantSend = (want: Partial<FinderWant>) => Promise<unknown>;

/**
 * Every change saves at once, 500 ms after the last one (§41.1): changes in that time go out as one PATCH. `flush`
 * sends what waits now (the page closing).
 */
export function createWantSaver(send: WantSend, delayMs = 500) {
  let pending: Partial<FinderWant> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): Promise<unknown> | null => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!Object.keys(pending).length) return null;
    const body = pending;
    pending = {};
    return send(body);
  };
  return {
    change(patch: Partial<FinderWant>) {
      pending = { ...pending, ...patch };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    waiting: () => ({ ...pending }),
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = {};
    },
  };
}

/**
 * The page's What you want saves: the changes show at once (over the store's copy), go out debounced, and `sent`
 * says the owner changed what he wants on this visit (so `looking` reads "Updating your matches…").
 */
export function useWantSaver(onError: (message: string) => void) {
  const [shown, setShown] = useState<Partial<FinderWant>>({});
  const [sent, setSent] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const saver = useRef<ReturnType<typeof createWantSaver> | null>(null);
  if (!saver.current)
    saver.current = createWantSaver(async (want) => {
      try {
        const next = await api().crPatchFinder({ want });
        putFinder(next);
        // The look this answer starts is for his own change: the page says "Updating your matches…".
        if (next.state === "looking") setSent(true);
      } catch (e) {
        errorRef.current(friendlyMessage(e));
        void reloadFinder();
      } finally {
        const still = saver.current?.waiting() ?? {};
        setShown((s) => {
          const next = { ...s };
          for (const k of Object.keys(want) as (keyof FinderWant)[]) if (!(k in still)) delete next[k];
          return next;
        });
      }
    });
  // Leaving the page within the 500 ms still saves the last change (PATCH keeps going as the page goes).
  useEffect(() => () => void saver.current?.flush(), []);
  const change = useCallback((patch: Partial<FinderWant>) => {
    setShown((s) => ({ ...s, ...patch }));
    saver.current!.change(patch);
  }, []);
  return { shown, change, sent, setSent };
}

// ---------- The visit: the frozen "New" set and the "You're in!" rows ----------

/** The page keeps every uuid that was new on this visit (a uuid new in a later refetch joins it; none leaves). */
export function freezeNew(prev: ReadonlySet<string>, matches: readonly Pick<FinderMatch, "campaignId" | "isNew">[]): Set<string> {
  const out = new Set(prev);
  for (const m of matches) if (m.isNew) out.add(m.campaignId);
  return out.size === prev.size ? (prev as Set<string>) : out;
}

/** The visit's "You're in!" rows: newest first, each campaign once (a later answer updates its row). */
export function mergeAdded(prev: readonly CampaignSummary[], added: readonly CampaignSummary[]): CampaignSummary[] {
  if (!added.length) return prev as CampaignSummary[];
  const ids = new Set(added.map((c) => c.campaignId));
  return [...added, ...prev.filter((c) => !ids.has(c.campaignId))];
}

/** Opened in the last 2 hours: the steps and "I joined: add it" lead. */
export function openedRecently(openedAt: string | undefined, now = Date.now()): boolean {
  const at = openedAt ? Date.parse(openedAt) : NaN;
  return Number.isFinite(at) && now - at < OPENED_FRESH_MS && now - at >= -60_000;
}

/** "2:10 pm". */
export function clockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d).replace(/\s+/g, " ").toLowerCase();
}

/** "Fri 21 Nov, 2:10 pm". */
export function dayAndTime(iso: string | undefined): string {
  const day = dayDate(iso);
  const time = clockTime(iso);
  return day && time ? `${day}, ${time}` : day || time;
}

// ---------- The words the web makes (the server makes every match's words) ----------

/** The entry card's line on the Campaigns page (§41.1). */
export function entryLine(f: CrFinderSummary): string {
  if (!f.on) return "You stopped finding campaigns.";
  if (!f.started) return "Tell me what you want. I'll find campaigns that pay for it.";
  if (f.newCount > 0) return `${plural(f.newCount, "new campaign")} ${f.newCount === 1 ? "matches" : "match"} what you want.`;
  if (f.matches > 0) return `${plural(f.matches, "campaign")} ${f.matches === 1 ? "matches" : "match"} what you want.`;
  return "None match right now. I look 4 times a day.";
}

/** Home's first chip with new matches: "3 new campaigns match". */
export function newChipText(n: number): string {
  return `${plural(n, "new campaign")} ${n === 1 ? "matches" : "match"}`;
}

/** The match steps (§41.1), bold = Content Rewards' own label. */
export const STEPS_OPEN_SIGNED_IN = ["Tap **Join Campaign**.", "Does the big button now say **Submit clip**? Then tap I joined: add it."] as const;
export const STEPS_OPEN_BY_HAND = [
  "Tap **Join Campaign**.",
  "Does the big button now say **Submit clip**? Then you're in.",
  "Copy everything under **Brief** and **Content requirements**.",
  "Come back. Paste it below, then tap I joined: add it.",
] as const;
export const STEPS_APPLY = ["Tap **Apply**.", "Tick your accounts. Answer the questions.", "Tap **Submit application**.", "Come back here and tap I applied: add it."] as const;

/** "If you see" (one fold, the same for both kinds): §38.4 join-join's list word for word, and three more. */
export const IF_YOU_SEE: { see: string; do: string }[] = [
  { see: "**Hold to confirm**", do: "Press and hold it." },
  { see: "“Select at least one account”", do: "Tick at least one account." },
  { see: "“Must be at least … characters”", do: "Write a little more." },
  { see: "“Enter a full link, e.g. https://…”", do: "Tap a Copy chip above and paste it." },
  { see: "a box about Discord", do: "Tap **Done**. You don't need Discord." },
  { see: "“This brand has gone quiet”", do: "Pick another campaign." },
  { see: "“Campaign is not accepting applications”", do: "Pick another campaign." },
  { see: "a sign-in page", do: "Sign in with your email code, then tap the big button again." },
  { see: "**Submit clip**", do: "You're in already. Tap I joined: add it." },
  { see: "**Pending review**", do: "You applied already. Tap I applied: add it." },
];

/** The sentence of each state that has one (§41.1's table). `updating`: his own change is being matched. */
export function stateLine(f: Pick<Finder, "state" | "matches" | "looked" | "want" | "resolvedPlaces">, updating = false): string | null {
  switch (f.state) {
    case "looking":
      return updating ? "Updating your matches…" : "Looking at Content Rewards' campaigns… This takes a minute or two.";
    case "down":
      return "Content Rewards didn't answer. I'll try again in a few hours.";
    case "blocked":
      return "Content Rewards isn't letting Clip Factory look right now. Tap Look on Content Rewards yourself.";
    case "not_allowed":
      return "Content Rewards asked apps not to read its campaign pages. Tap Look on Content Rewards yourself.";
    case "unreadable":
      return "I can't read Content Rewards' campaign pages right now. Tap Look on Content Rewards yourself.";
    case "off":
      return "You stopped finding campaigns.";
    case "ok":
      if (f.matches.length) return null;
      if (f.looked.pending > 0) return `No match yet. I've looked at ${plural(f.looked.campaigns, "campaign")} so far. I'll look at more later today.`;
      return "No campaign matches right now. I look again 4 times a day.";
    default:
      return null;
  }
}

/** The no-place line (state `new` or `ok` with `resolvedPlaces` empty). */
export const NO_PLACE_LINE = "Set up a place to post first. Then I can find campaigns that pay for it.";

/** The first place to set up for the no-place state: YouTube first, never TikTok. */
export function placeToSetUp(setup: SetupOverview | null | undefined): Platform {
  const ready = new Set((setup?.platforms ?? []).filter((p) => p.ready).map((p) => p.platform));
  return PLATFORM_ORDER.find((p) => p !== "tiktok" && !ready.has(p)) ?? "youtube";
}

/** "I looked at 154 campaigns. 6 match." */
export function lookedLine(f: Pick<Finder, "looked" | "matches">): string {
  const n = f.matches.length;
  return `I looked at ${plural(f.looked.campaigns, "campaign")}. ${n} ${n === 1 ? "matches" : "match"}.`;
}

/** The finder's ask message is the server's (§41.5); the page shows it word for word under Show more. */
export const ASK_MESSAGE =
  "Feature request from Clip Factory: creators ask for MCP tools to search Discover campaigns (filters for pay per 1,000 views, platforms, category, budget left, open or application, language) and to join an open campaign, or start an application, with the creator's consent. Today Clip Factory reads only public campaign pages a few times a day, and the creator taps Join Campaign on Content Rewards.";

/** The matches as the page draws them: hidden and added ones never (the server drops them too). */
export function shownMatches(f: Finder | null, hidden: ReadonlySet<string>, added: readonly CampaignSummary[]): FinderMatch[] {
  if (!f || f.state === "off") return [];
  const gone = new Set([...hidden, ...added.map((a) => a.campaignId)]);
  return f.matches.filter((m) => !gone.has(m.campaignId));
}
