// Get paid on the web (docs/CONTRACTS.md §40): the shared GET /v1/getpaid store and its live refetch, one place's
// payouts, a tick, the words every Get paid screen shares (statuses, result sentences, the Money card's buttons) and
// the 404 rule that lets this part ship before the API's. Money is only ever formatted on these screens (§25, §40.4).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { GetPaid, GetPaidCard, GetPaidPlace, GetPaidStatus, PayoutRow } from "../api/types.ts";
import type { IconName } from "../components/Icon.tsx";
import { useCr } from "./contentRewards.ts";
import { currentOs } from "./device.ts";
import { onLiveSignal } from "./live.ts";

/** How long live news waits before GET /v1/getpaid is read again (several items change together). */
export const LIVE_DEBOUNCE_MS = 1000;
/** The live item types a status depends on: Get paid's own, ACCOUNT# (setup) and CRCONN / CRMONEY (contentrewards). */
export const LIVE_TYPES = ["getpaid", "setup", "contentrewards"] as const;

/** The only bank words anywhere until the owner chooses a bank source (§40.5 D). */
export const BANK_TEXT = "Clip Factory can't see your bank. Look in your bank's app to see what arrived.";

// ---------- The shared store ----------

export type GetPaidLoad =
  | { state: "loading"; data: null }
  /** 404: an API from before §40. Get paid then says it is coming. */
  | { state: "missing"; data: null }
  | { state: "error"; data: GetPaid | null; error: string }
  | { state: "ok"; data: GetPaid };

let snapshot: GetPaidLoad = { state: "loading", data: null };
/** Bumped on every answer from the server (not on an optimistic patch), so a place page reads its payouts again. */
let version = 0;
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unlisten: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: GetPaidLoad) {
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Reads GET /v1/getpaid (one call at a time; a call asked for meanwhile runs once after it). */
export function reloadGetPaid(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const data = await api().getPaid();
      version++;
      set({ state: "ok", data });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) set({ state: "missing", data: null });
      else set({ state: "error", data: snapshot.data, error: friendlyMessage(e) });
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void reloadGetPaid();
      }
    }
  })();
  return inFlight;
}

/** Live news, a Content Rewards step's answer: GET /v1/getpaid again in a second (once, however many arrive). */
export function scheduleGetPaid(ms = LIVE_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void reloadGetPaid();
  }, ms);
}

/** The live events that change a status (§40.7 Live). */
export function isGetPaidNews(type: string): boolean {
  return (LIVE_TYPES as readonly string[]).includes(type);
}

function ensureStarted() {
  if (started) return;
  started = true;
  void reloadGetPaid();
  unlisten = onLiveSignal((s) => {
    if (s.kind === "resync" || isGetPaidNews(s.event.type)) scheduleGetPaid();
  });
}

/** Puts a newer copy in the store straight away (an optimistic tick, or a PATCH's answer). */
export function patchGetPaid(fn: (d: GetPaid) => GetPaid): void {
  if (snapshot.data) set({ ...snapshot, data: fn(snapshot.data) } as GetPaidLoad);
}

/** Puts the server's answer in the store (a PATCH or a key save answers with the whole GetPaid). */
export function putGetPaid(data: GetPaid): void {
  version++;
  set({ state: "ok", data });
}

/** Forgets everything (sign-out, tests). */
export function resetGetPaid(): void {
  unlisten?.();
  unlisten = null;
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  inFlight = null;
  again = false;
  version = 0;
  snapshot = { state: "loading", data: null };
  for (const fn of listeners) fn();
}

/** The server's answer count, for screens that read more when it changes. */
export const getPaidVersion = () => version;

/**
 * GET /v1/getpaid, shared by every Get paid screen, read again on live `getpaid`, `setup` and `contentrewards` news
 * and after any Content Rewards step's answer (it answers with the Content Rewards connection, not GetPaid).
 */
export function useGetPaid(): GetPaidLoad & { reload: () => Promise<void>; version: number } {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      ensureStarted();
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
  // A Content Rewards step ticked anywhere (the place page, Money's own part) changes CRCONN: read Get paid again.
  const cr = useCr();
  const conn = cr.data?.connection;
  const crKey = conn ? `${[...conn.stepsDone].sort().join(",")}|${String(conn.finance)}` : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (crKey === null) return;
    if (seen.current !== null && seen.current !== crKey) scheduleGetPaid();
    seen.current = crKey;
  }, [crKey]);
  const reload = useCallback(() => reloadGetPaid(), []);
  return { ...state, reload, version };
}

/** One place's card and payouts (GET /v1/getpaid/{place}), read again whenever the shared store hears the server. */
export type PlaceLoad =
  | { state: "loading"; card: null; payouts: [] }
  | { state: "missing"; card: null; payouts: [] }
  | { state: "error"; card: GetPaidCard | null; payouts: PayoutRow[]; error: string }
  | { state: "ok"; card: GetPaidCard; payouts: PayoutRow[] };

export function usePlace(place: GetPaidPlace, version: number): PlaceLoad & { reload: () => void } {
  const [load, setLoad] = useState<PlaceLoad>({ state: "loading", card: null, payouts: [] });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    api()
      .getPaidPlace(place)
      .then((r) => mine === seq.current && setLoad({ state: "ok", card: r.card, payouts: r.payouts }))
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        if (e instanceof ApiError && e.status === 404) setLoad({ state: "missing", card: null, payouts: [] });
        else setLoad((l) => ({ state: "error", card: l.card, payouts: l.payouts, error: friendlyMessage(e) }));
      });
  }, [place]);
  useEffect(() => {
    reload();
  }, [reload, version]);
  return { ...load, reload };
}

// ---------- Ticks ----------

/** The steps a `meta-payout` tick stands for: one tick for Instagram and Facebook. */
export function withTick(stepsDone: readonly string[], step: string, done: boolean): string[] {
  const rest = stepsDone.filter((s) => s !== step);
  return done ? [...rest, step] : rest;
}

/** Marks a Get paid step (PATCH /v1/getpaid/steps): at once on screen, then the server's answer. False when refused. */
export async function tickGetPaid(step: string, done: boolean, onError: (message: string) => void): Promise<boolean> {
  patchGetPaid((d) => ({
    ...d,
    stepsDone: withTick(d.stepsDone, step, done),
    places: d.places.map((p) => ({ ...p, steps: p.steps.map((s) => (s.id === step && s.by !== "auto" ? { ...s, done, by: done ? "you" : null } : s)) })),
  }));
  try {
    putGetPaid(await api().setGetPaidStep(step, done));
    return true;
  } catch (e) {
    onError(friendlyMessage(e));
    void reloadGetPaid();
    return false;
  }
}

// ---------- Words ----------

/** Each status's icon: never colour alone (§40.2). "Can get paid (you said it's done)" has an outline icon, no ✓. */
export const STATUS_ICON: Record<GetPaidStatus, IconName> = {
  on_hold: "lock",
  not_allowed: "clock",
  can_get_paid: "checkCircle",
  not_set_up: "alert",
  checking: "retry",
  you_said_done: "user",
  not_connected: "info",
  not_started: "info",
};

/** The pill words the server sends, as the contract fixes them (tests; the server's `pill` is what is shown). */
export const PILL_WORDS: Record<GetPaidStatus, RegExp> = {
  on_hold: /^Payment on hold \((YouTube|Whop) says\)$/,
  not_allowed: /^Not allowed yet \((YouTube says|Instagram's rules|X's rules)\)$/,
  can_get_paid: /^Can get paid ✓ \((YouTube|Whop) says\)$/,
  not_set_up: /^(Not set up \((YouTube|Whop) says\)|Not set up yet)$/,
  checking: /^Checking…( \(Whop says\))?$/,
  you_said_done: /^Can get paid \((you said it's done|Google sent money on .+)\)$/,
  not_connected: /^Clip Factory can't check$/,
  not_started: /^Not started$/,
};

/** Words never on a Get paid screen (§40.1): Clip Factory can't tell, so it never says them. */
export const NEVER_WORDS = /\b(Live|Active|Verified ✓|Not connected|disconnected|KYC|EFT|OAuth|token|scope|API|Client ID|tax treaty)\b/;

/** The Money card's one glass button per row (§40.1 item 3). */
export function rowButton(status: GetPaidStatus): "See steps" | "See why" | "See more" {
  if (status === "not_allowed" || status === "checking") return "See why";
  if (status === "can_get_paid" || status === "you_said_done") return "See more";
  return "See steps";
}

/** After Allow payment reading: `?result=` and its sentence (§40.6, exact). */
export const PAYMENTS_RESULTS = {
  payments_allowed: "Clip Factory can see your YouTube payments now. It checks once a day.",
  payments_denied: "You didn't allow it. Tap Allow payment reading to try again.",
  payments_missing: "Tick **View your AdSense data** on Google's page. Then tap Allow payment reading again.",
  payments_no_account:
    "That Google account has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account that has it. Still no luck? Skip this step. Your ticks still work.",
  payments_api_off: "Tap Turn on AdSense reading, then **Enable**. Then tap Allow payment reading again.",
  payments_error: "Something went wrong. Tap Allow payment reading again.",
} as const;
export type PaymentsResult = keyof typeof PAYMENTS_RESULTS;

/** After Connect Whop (§40.6, exact; never "Connected"). `{name}` is the Whop @name. */
export const WHOP_RESULTS = {
  whop_connected: "Clip Factory can see your Whop payouts now ({name}).",
  whop_denied: "You didn't allow it. Tap Connect Whop to try again.",
  whop_missing: "Tick all four boxes in your Whop app. Then tap Connect Whop.",
  whop_expired: "That took too long. Tap Connect Whop again.",
  whop_error: "Whop didn't answer. Tap Connect Whop again in a few minutes.",
} as const;
export type WhopResult = keyof typeof WHOP_RESULTS;

export function whopSentence(result: WhopResult, name: string | undefined): string {
  return WHOP_RESULTS[result].replace("({name})", name ? `(${name})` : "").replace(" .", ".");
}

/** Reads `?result=` once and takes it out of the address (a reload does not say it again). Anything unknown is null. */
export function takeGetPaidResult(): PaymentsResult | WhopResult | null {
  if (typeof location === "undefined") return null;
  const q = new URLSearchParams(location.search);
  if (!q.has("result")) return null;
  const code = q.get("result") ?? "";
  q.delete("result");
  const rest = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  return code in PAYMENTS_RESULTS || code in WHOP_RESULTS ? (code as PaymentsResult | WhopResult) : null;
}

/** "Stopping payment reading… Undo" waits this long before it really stops (§40.6). */
export const STOP_UNDO_MS = 8000;

/** A phone, where a `phone` step's Open opens the app (on a computer it says to use the phone, and has no Open). */
export function onPhone(): boolean {
  const os = currentOs();
  return os === "ios" || os === "android";
}

/** "Do this in the TikTok app on your phone." */
export const phoneLine = (app: string) => `Do this in ${app} on your phone.`;

/** The Whop key's shape (§40.6): what "Save key" accepts before it asks the server. */
export const WHOP_KEY = /^app_[A-Za-z0-9]{4,64}$/;
export const WHOP_KEY_BAD = "Your Whop key starts with app_.";
