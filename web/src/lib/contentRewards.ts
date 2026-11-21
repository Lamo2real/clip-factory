// Content Rewards campaigns on the web (docs/CONTRACTS.md §38): the words for every membership, stop, clip state,
// reason and result code; how a campaign's one next step is drawn (exactly one vermilion button, or none); the
// shared GET /v1/contentrewards store; and the 404 / 503 rule that lets this part ship before the API's.
//
// Money is only ever formatted here, never worked out (§25, §38.7): no rate × views, no sums of amounts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type {
  Campaign,
  CampaignStop,
  CampaignSummary,
  CrCheck,
  CrConnectResult,
  CrConnection,
  CrOverview,
  CrReasonCode,
  CrSubState,
  CrSubmission,
  Membership,
  NextStep,
  Platform,
  SaidAnswer,
  StopCode,
} from "../api/types.ts";
import { CR_DISCOVER, CR_SETTINGS, CR_SUBMISSIONS } from "../setup/contentrewards.ts";
import { withBack } from "./backLink.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER, count } from "./format.ts";
import { onLiveSignal } from "./live.ts";

export const CR_SETUP_PATH = "/settings/posting/setup/contentrewards";
export const CAMPAIGNS_PATH = "/campaigns";
export const campaignPath = (campaignId: string) => `/campaigns/${encodeURIComponent(campaignId)}`;
export const makeClipsPath = (campaignId: string) => `/?campaign=${encodeURIComponent(campaignId)}`;
export const CR_MONEY_PATH = "/money#content-rewards";
/** The setup page with the way back to this campaign's card (§39.1 `?back=`, as the API's gates.next_step makes it). */
export const crSetupFor = (campaignId: string) => withBack(CR_SETUP_PATH, campaignPath(campaignId));

/** What Home and the Campaigns page say when the API is switched off (503 `unavailable`, §38.8). */
export const COMING_SOON = "Content Rewards is coming soon to Clip Factory.";
/** What Home says for a pasted CR link when the API is from before §38 (404). */
export const NOT_YET = "Clip Factory can't use Content Rewards links yet.";
export const TIKTOK_NOT_YET =
  "TikTok: not yet. TikTok keeps Clip Factory's posts private until it checks the app, and private posts can't earn.";

// ---------- Money: formatted only ----------

/** 420 → "$4.20", 789000 → "$7,890.00". Pure formatting of CR's cents (no arithmetic on the amount). */
export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const digits = String(Math.abs(Math.round(cents))).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}$${whole}.${digits.slice(-2)}`;
}

/** "$7,890" for budgets (no ".00" when the cents are zero). */
export function usdShort(cents: number | null | undefined): string {
  const s = usd(cents);
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}

/** The Copy chip's "Amount" (18.25), as Content Rewards' Amount box wants it. */
export function amountText(cents: number | null | undefined): string {
  return usd(cents).replace(/^\$/, "").replace(/,/g, "");
}

/** A dollar or more ready to move (CR's own threshold, §38.7). */
export const MOVE_MIN_CENTS = 100;

// ---------- The 404 / 503 rule (§38.8) ----------

export type CrAvailability = "missing" | "soon" | "error";

/** 404: an API from before §38 (hide every Content Rewards part). 503 `unavailable` only: switched off ("Coming soon"). */
export function crAvailability(e: unknown): CrAvailability {
  if (e instanceof ApiError && e.status === 404) return "missing";
  if (e instanceof ApiError && e.status === 503 && e.code === "unavailable") return "soon";
  return "error";
}

// ---------- The shared store: GET /v1/contentrewards once per visit, again on every live contentrewards event ----------

export type CrState =
  | { state: "loading"; data: null }
  | { state: "missing"; data: null }
  | { state: "soon"; data: null }
  | { state: "error"; data: CrOverview | null; error: string }
  | { state: "ok"; data: CrOverview };

let snapshot: CrState = { state: "loading", data: null };
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
const listeners = new Set<() => void>();
let unlisten: (() => void) | null = null;

function set(next: CrState) {
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Reads GET /v1/contentrewards (one call at a time; a call asked for meanwhile runs once after it). */
export function reloadCr(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      const data = await api().crOverview();
      set({ state: "ok", data });
    } catch (e) {
      const kind = crAvailability(e);
      if (kind === "missing") set({ state: "missing", data: null });
      else if (kind === "soon") set({ state: "soon", data: null });
      else set({ state: "error", data: snapshot.data, error: friendlyMessage(e) });
    } finally {
      inFlight = null;
      if (again) {
        again = false;
        void reloadCr();
      }
    }
  })();
  return inFlight;
}

function ensureStarted() {
  if (started) return;
  started = true;
  void reloadCr();
  unlisten = onLiveSignal((s) => {
    if (s.kind === "resync" || s.event.type === "contentrewards") void reloadCr();
  });
}

/** Puts a newer copy in the store straight away (after a PATCH answered), without a round trip. */
export function patchCr(fn: (d: CrOverview) => CrOverview): void {
  if (snapshot.data) set({ ...snapshot, data: fn(snapshot.data) } as CrState);
}

/** Forgets everything (sign-out, tests). */
export function resetCr(): void {
  unlisten?.();
  unlisten = null;
  started = false;
  inFlight = null;
  again = false;
  snapshot = { state: "loading", data: null };
  for (const fn of listeners) fn();
}

/** The Content Rewards overview every screen shares. */
export function useCr(): CrState & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      ensureStarted();
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
  const reload = useCallback(() => reloadCr(), []);
  return { ...state, reload };
}

/** Rechecks when the owner comes back to the window (a join on Content Rewards shows when he switches back, §38.4). */
export function useCrOnReturn(onReturn: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const fn = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    document.addEventListener("visibilitychange", fn);
    window.addEventListener("focus", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
      window.removeEventListener("focus", fn);
    };
  }, [onReturn, active]);
}

/** Phones and touch tablets (the same media as the CSS): the screen's one vermilion is pinned at the bottom right. */
export const PIN_MEDIA = "(max-width: 767px), (pointer: coarse)";
export function usePinMain(): boolean {
  const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PIN_MEDIA) : null);
  const [on, setOn] = useState(() => !!query()?.matches);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const fn = () => setOn(mq.matches);
    fn();
    mq.addEventListener?.("change", fn);
    return () => mq.removeEventListener?.("change", fn);
  }, []);
  return on;
}

/** Now, every 30 s while `on` (minutes left count down on screen between two reads of the API). */
export function useNow(on: boolean, everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return now;
}

/** A campaign the API listed for this owner (only those may go with a new job, §38.19). */
export function listedCampaign(state: CrState, campaignId: string | null | undefined): CampaignSummary | null {
  if (!campaignId || state.state !== "ok") return null;
  return state.data.campaigns.find((c) => c.campaignId === campaignId) ?? null;
}

/** The campaigns a new job can be for: the owner is `in` or `manual`. */
export function clippable(state: CrState): CampaignSummary[] {
  return state.state === "ok" ? state.data.campaigns.filter((c) => c.membership === "in" || c.membership === "manual") : [];
}

/**
 * A campaign ready for clips right now (§39.1): its next step is Make clips. An API from before §39 sends no
 * `nextStepKind`: then in or manual with no hard stop (§39.4).
 */
export function readyForClips(c: Pick<CampaignSummary, "membership" | "hardStops" | "nextStepKind">): boolean {
  if (c.nextStepKind !== undefined) return c.nextStepKind === "make_clips";
  return (c.membership === "in" || c.membership === "manual") && c.hardStops === 0;
}

// ---------- Connect: results, checks and the setup card ----------

export const CONNECT_RESULT_TEXT: Record<CrConnectResult, string> = {
  connected: "Content Rewards is connected!",
  read_only: "Connected, but Content Rewards hasn't let Clip Factory send clips yet.",
  denied: "You didn't allow it. Tap Connect Content Rewards to try again.",
  expired: "That took too long. Tap Connect Content Rewards again.",
  not_allowed: "Content Rewards says your account can't connect apps yet. Send the email below.",
  no_port: "Clip Factory couldn't start the sign-in. Quit Clip Factory, open it again, then tap Connect Content Rewards.",
  cr_down: "Content Rewards didn't answer. Try again in a few minutes.",
  busy: "Clip Factory is busy with Content Rewards. Try again in a few seconds.",
  error: "Something went wrong. Tap Connect Content Rewards again.",
};

export const CONNECT_RESULTS = Object.keys(CONNECT_RESULT_TEXT) as CrConnectResult[];

export const CHECK_TEXT: Record<CrCheck["code"], string> = {
  ok: "Content Rewards answers. You're signed in.",
  read_only: "You're signed in. Content Rewards hasn't let Clip Factory send clips yet.",
  not_connected: "Content Rewards isn't connected. Tap Connect Content Rewards.",
  token_dead: "Content Rewards signed you out. Tap Connect again.",
  missing_permissions: "A permission was not allowed. Tap Connect again and allow every box.",
  blocked: "Content Rewards stopped Clip Factory for now. You send clips yourself until it's fixed.",
  cr_down: "Content Rewards didn't answer. Try again in a few minutes.",
};

/** Signed in at all (sending or read only). */
export const signedIn = (c: CrConnection | null | undefined) => c?.status === "connected" || c?.status === "read_only";

/** Signed in and allowed to send clips. */
export const canSend = (c: CrConnection | null | undefined) => c?.status === "connected" && c.canSubmit && !c.blocked;

/** CR said the account can't connect apps (or blocked this sign-in): the card asks him to check things himself. */
export function refused(c: CrConnection | null | undefined): boolean {
  if (!c) return false;
  if (c.blocked) return true;
  return !signedIn(c) && (c.lastResult === "not_allowed" || !!c.pilotSentAt);
}

/** Which of the three setup steps are done (each also ticks itself from what Clip Factory sees). */
export function crStepsDone(c: CrConnection | null | undefined): { "ready-account": boolean; "ready-socials": boolean; connect: boolean } {
  const on = signedIn(c);
  const linked = !!c && Object.values(c.crLinked).some((v) => v === true);
  const refusedLink = !!c && Object.values(c.crLinked).some((v) => v === false);
  return {
    // Signed out by Content Rewards: he has an account, only step 3 opens again.
    "ready-account": on || c?.status === "needs_reconnect" || !!c?.stepsDone.includes("ready-account"),
    "ready-socials": linked || (!!c?.stepsDone.includes("ready-socials") && !refusedLink),
    connect: on,
  };
}

/** The ring: steps done of 3. */
export function crSetupCount(c: CrConnection | null | undefined): number {
  return Object.values(crStepsDone(c)).filter(Boolean).length;
}

/** The setup card's one state line (§38.3). `onMac`: this window can run Connect. */
export function crCardLine(c: CrConnection | null | undefined, onMac: boolean): string {
  if (!c) return "Not started";
  if (c.status === "needs_reconnect") return "Needs you: sign in again";
  if (c.status === "connected" && c.canSubmit && !c.blocked) return "Ready: sends your clips for you";
  if (signedIn(c)) return c.pilotSentAt && !c.canSubmit ? "Waiting for Content Rewards to say yes" : "Ready: you send clips yourself";
  if (c.pilotSentAt) return "Waiting for Content Rewards to say yes";
  const done = crStepsDone(c);
  const n = Object.values(done).filter(Boolean).length;
  if (n === 0) return "Not started";
  if (done["ready-account"] && done["ready-socials"] && !onMac) return "Do this on your Mac";
  return `Step ${n + 1} of 3`;
}

/** "Fri 19 Feb". */
export function dayDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
}

/** "21 Nov". */
export function shortDay(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d);
}

/** From 7 days before signInBy: the calm "sign in again" card shows. */
export function signInSoon(c: CrConnection | null | undefined, now = Date.now()): boolean {
  if (!c || !signedIn(c)) return false;
  if (c.reason === "expires_soon") return true;
  const from = c.warnFrom ? Date.parse(c.warnFrom) : NaN;
  return Number.isFinite(from) && now >= from;
}

// ---------- Memberships, stops and the next step (§38.4) ----------

export const MEMBERSHIP_CHIP: Record<Membership, string> = {
  unknown: "Connect first",
  not_joined: "Not joined yet",
  apply_first: "Applied?",
  waiting: "Waiting for the brand",
  in: "You're in",
  left: "Not in your list",
  not_accepted: "Not accepted",
  manual: "You're in",
};

export const REFUSED_CHIP = "Check it yourself";

/** The membership words of the next step (the table of §38.4). */
export const MEMBERSHIP_TEXT = {
  unknown: "Connect Content Rewards so I can see if you're in.",
  unknownPhone: "Connect Content Rewards on your Mac, so I can see if you're in.",
  refused:
    "Content Rewards hasn't let Clip Factory look yet. Open the campaign. Does it say **Submit clip**? Then you're in. Copy everything under **Brief** and **Content requirements**. Paste it here.",
  refusedSub: "It says **Pending review**? Wait for the brand, then look again.",
  not_joined: "Not joined yet: tap **Join Campaign** on Content Rewards. I'll see it by myself.",
  apply_first: "Did you tap **Submit application** on Content Rewards? Then tap Yes, I applied.",
  applySub: "Not yet? Tap Open campaign. Tap **Apply**, answer the questions, then tap **Submit application**.",
  waiting: "Nothing to do. I'll tell you when you're in.",
  waitingSub: "Content Rewards shows **Pending review** while the brand decides.",
  in: "You're in! Make clips for this campaign.",
  paused: "The brand paused this campaign. I'll tell you when it opens again.",
  left: "Content Rewards doesn't show this campaign for you any more. Open it to check: you may have left, or the brand removed you.",
  not_accepted: "The brand said no to this one. That's OK! Pick another campaign.",
  manual: "You're in. After each post, I'll remind you to send it to Content Rewards yourself.",
  rulesPaste: "Open the campaign. Copy everything under **Brief** and **Content requirements**. Paste it below, then tap Read these rules.",
  canSendNow: "Clip Factory can send these clips by itself now.",
  stillWaiting: "Still waiting? Tap Check now.",
  cantConnect: "Open the campaign. Does it say **Submit clip**? Then you're in.",
} as const;

/** The quick check "how do I see it myself?" (help guide cr-am-i-in). */
export const AM_I_IN =
  "Open the campaign on Content Rewards. **Submit clip** means you're in. **Pending review** means you wait. **Not eligible** means the brand said no. **Limit reached**, **Post limit reached** or **Clip limit reached** also means you're in: the brand must check your clips first. Your list is under **Campaigns**.";

/** Hard stops that send him to another campaign get a glass "Find another campaign". */
export const PICK_ANOTHER: readonly StopCode[] = ["ended", "deadline", "budget_gone", "tiktok_only", "drafts_first", "sound_needed", "overlay_needed", "cap_reached", "not_accepted"];
const MEMBERSHIP_STOPS: readonly StopCode[] = ["not_checked", "not_joined", "apply_first", "waiting", "left", "not_accepted"];
/** Soft stops ("Make clips anyway"); `not_connected` is a note only and is never accepted. */
export const SOFT_STOPS: readonly StopCode[] = ["not_connected", "budget_half", "low_rate", "face_needed", "spoken_needed", "audience"];

/** "YouTube and Instagram", in the app's platform order. */
export function placeList(list: readonly Platform[]): string {
  const names = PLATFORM_ORDER.filter((p) => list.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

export interface StopContext {
  /** "23 Nov" for `deadline`. */
  clipUntil?: string | null;
  leftCents?: number | null;
  /** The best paid CPM rate, for `low_rate`. */
  bestPer1kCents?: number | null;
  platformsPaid?: readonly Platform[];
  /** The brief's own viewer-country words ("40% of viewers from the US"). */
  audience?: string | null;
}

/** Every stop's sentence (§38.4). */
export function stopText(code: StopCode, ctx: StopContext = {}): string {
  switch (code) {
    case "not_connected":
      return "Clip Factory isn't connected to Content Rewards, so you send each clip yourself. Tap Connect Content Rewards to make it automatic.";
    case "not_checked":
      return MEMBERSHIP_TEXT.unknown;
    case "not_joined":
      return MEMBERSHIP_TEXT.not_joined;
    case "apply_first":
      return MEMBERSHIP_TEXT.apply_first;
    case "waiting":
      return MEMBERSHIP_TEXT.waiting;
    case "left":
      return MEMBERSHIP_TEXT.left;
    case "not_accepted":
      return MEMBERSHIP_TEXT.not_accepted;
    case "rules_reading":
      return "Reading the rules… (about 30 seconds)";
    case "rules_failed":
      return "I couldn't read the rules. Tap Check now, or paste them below.";
    case "paused":
      return MEMBERSHIP_TEXT.paused;
    case "ended":
      return "This campaign has ended. Pick another one.";
    case "deadline":
      return `This campaign stopped taking clips on ${ctx.clipUntil ? shortDay(ctx.clipUntil) : "its last day"}. Pick another one.`;
    case "budget_gone":
      return "The money is almost gone, so new clips won't get paid. Pick another one.";
    case "budget_half":
      return `Half the money is used.${ctx.leftCents != null ? ` ${usdShort(ctx.leftCents)} is left.` : ""} Post soon, before it runs out.`;
    case "low_rate":
      return `It pays only ${ctx.bestPer1kCents != null ? usd(ctx.bestPer1kCents) : "a little"} per 1,000 views. Most campaigns pay $1 or more. You can still make clips, or pick another one.`;
    case "logo_missing":
      return "This campaign needs its logo on every clip. Add it below.";
    case "tiktok_only":
      return "This campaign only pays for TikTok. TikTok keeps Clip Factory's posts private until it checks the app, and private posts can't earn. Pick a campaign that pays for YouTube, Instagram, X or Facebook.";
    case "no_place": {
      const paid: Platform[] = (ctx.platformsPaid ?? []).filter((p) => p !== "tiktok");
      const first = PLATFORM_ORDER.find((p) => paid.includes(p));
      return `Set up ${first ? PLATFORM_LABEL[first] : "a place"} first. This campaign pays for ${placeList(ctx.platformsPaid ?? []) || "other places"}.`;
    }
    case "held":
      return "Content Rewards wants the brand to check your other clips first. I'll tell you when you can post again.";
    case "cap_reached":
      return "You reached the most you can earn on this campaign. Pick another one.";
    case "drafts_first":
      return "This campaign wants to see each clip before you post it. Clip Factory can't do that yet. Pick another campaign.";
    case "sound_needed":
      return "This campaign needs one of its own sounds. Clip Factory can't add it yet. Pick another campaign.";
    case "overlay_needed":
      return "This campaign wants its own picture on top of the video. Clip Factory can't add it yet. Pick another campaign.";
    case "face_needed":
      return "This brand wants your face on camera. Clips of other videos may be turned down.";
    case "spoken_needed":
      return "This brand wants you to say “paid partnership” out loud. Clip Factory can't, so clips may be turned down.";
    case "audience":
      return `This brand wants ${ctx.audience ?? "viewers from some countries"}. In YouTube Studio tap **Analytics**, then **Audience**, then look at **Top geographies**.`;
  }
}

/** The disabled Make clips button's short words for each hard stop (§38.5). */
export const STOP_SHORT: Partial<Record<StopCode, string>> = {
  rules_reading: "Reading the rules…",
  rules_failed: "Rules missing",
  logo_missing: "Add the logo first",
  paused: "Campaign paused",
  ended: "Campaign ended",
  deadline: "Campaign closed",
  budget_gone: "Money is gone",
  tiktok_only: "TikTok only",
  no_place: "Set up a place first",
  held: "On hold",
  cap_reached: "You earned the most",
  drafts_first: "Can't make these",
  sound_needed: "Can't make these",
  overlay_needed: "Can't do this one",
};

/**
 * A hard stop as Home says it: the short words on the disabled Make clips button, the sentence under it, and
 * whether its fix is on the campaign card (then a glass "Open the campaign" sits under it: the card's own sentences
 * say "below", which on Home points at nothing).
 */
export function homeStop(stop: Pick<CampaignStop, "code" | "text">): { short: string; text: string; openCard: boolean } {
  const short = STOP_SHORT[stop.code] ?? "Can't make clips yet";
  switch (stop.code) {
    case "rules_reading":
      return { short, text: "Reading the rules… (about 30 seconds)", openCard: false };
    case "logo_missing":
      return { short, text: "This campaign needs its logo on every clip. Tap Open the campaign and add it there.", openCard: true };
    case "rules_failed":
      return { short, text: "I couldn't read the rules. Tap Open the campaign, then Check now, or paste them there.", openCard: true };
    default:
      return { short, text: stop.text, openCard: false };
  }
}

export const STOP_CODES: readonly StopCode[] = [
  "not_connected",
  "not_checked",
  "not_joined",
  "apply_first",
  "waiting",
  "left",
  "not_accepted",
  "rules_reading",
  "rules_failed",
  "paused",
  "ended",
  "deadline",
  "budget_gone",
  "budget_half",
  "low_rate",
  "logo_missing",
  "tiktok_only",
  "no_place",
  "held",
  "cap_reached",
  "drafts_first",
  "sound_needed",
  "overlay_needed",
  "face_needed",
  "spoken_needed",
  "audience",
];

/** What the pure next-step rule needs (the API's gates.py does the same on the server; the mock uses this one). */
export interface GateInput {
  campaignId: string;
  url: string;
  membership: Membership;
  state: Campaign["state"];
  access: Campaign["access"];
  said?: SaidAnswer;
  rulesState: Campaign["rulesState"];
  /** The brief gave at least one rule. */
  hasRules: boolean;
  logoNeeded: boolean;
  logoReady: boolean;
  anyway: readonly StopCode[];
  /** Hard and soft stops other than membership and rules (made by the caller from the campaign). */
  stops: readonly CampaignStop[];
  /** Only the campaign's own videos count, and it lists some. */
  ownVideosOnly: boolean;
  connection: Pick<CrConnection, "status" | "lastResult" | "pilotSentAt" | "blocked"> | null;
  /** "I joined, but it still says not joined" may show now. */
  canSayIn?: boolean;
}

const openCampaign = (url: string) => ({ label: "Open campaign", href: url, external: true });
const findAnother = { label: "Find another campaign", href: CR_DISCOVER, external: true };

/** The membership's own stop code (null for `in` and `manual`). */
export function membershipStop(m: Membership): StopCode | null {
  switch (m) {
    case "unknown":
      return "not_checked";
    case "in":
    case "manual":
      return null;
    default:
      return m;
  }
}

/**
 * The one next step of a campaign card (§38.4), in priority order: a hard stop that ends it · the membership ·
 * the rules · the logo · soft stops not accepted · a video to pick · Make clips. `button` is the screen's only
 * vermilion one (none while he only waits).
 */
export function nextStepFor(g: GateInput): NextStep {
  const refusedNow = refused(g.connection as CrConnection | null) || !!g.connection?.blocked;
  const connected = signedIn(g.connection as CrConnection | null);
  const chip = (m: Membership) => (m === "unknown" && refusedNow ? REFUSED_CHIP : MEMBERSHIP_CHIP[m]);
  const ending = g.stops.find((s) => s.hard && !MEMBERSHIP_STOPS.includes(s.code) && s.code !== "rules_reading" && s.code !== "rules_failed" && s.code !== "logo_missing");
  if (ending) {
    if (ending.code === "paused")
      return { kind: "stop", chip: "Paused", text: ending.text, glass: [findAnother] };
    const other = PICK_ANOTHER.includes(ending.code);
    return {
      kind: other ? "pick_another" : "stop",
      chip: ending.code === "ended" || ending.code === "deadline" ? "Ended" : chip(g.membership),
      text: ending.text,
      ...(ending.fixHref && !other ? { button: { label: ending.code === "no_place" ? "Set it up" : "Fix it", href: ending.fixHref, external: false } } : {}),
      ...(other ? { glass: [findAnother] } : {}),
    };
  }
  const quiet = (labels: SaidAnswer[]) =>
    labels.map((said) =>
      said === "applied"
        ? { label: "Yes, I applied", said }
        : said === "not_eligible"
          ? { label: "It says Not eligible", said, text: "If Content Rewards shows **Not eligible**, tap It says Not eligible." }
          : { label: "It says Submit clip", said },
    );
  switch (g.membership) {
    case "unknown":
      if (refusedNow)
        return {
          kind: "check_yourself",
          chip: REFUSED_CHIP,
          text: MEMBERSHIP_TEXT.refused,
          sub: MEMBERSHIP_TEXT.refusedSub,
          button: { label: "Open campaign", href: g.url, external: true },
          asks: quiet(["joined_by_hand"]),
        };
      return {
        kind: "connect",
        chip: chip("unknown"),
        text: MEMBERSHIP_TEXT.unknown,
        button: { label: "Connect Content Rewards", href: crSetupFor(g.campaignId), external: false },
        glass: [openCampaign(g.url)],
        asks: quiet(["joined_by_hand"]),
      };
    case "not_joined":
      return {
        kind: "join",
        chip: chip("not_joined"),
        text: MEMBERSHIP_TEXT.not_joined,
        button: { label: "Open campaign", href: g.url, external: true },
        ...(g.canSayIn ? { asks: [{ label: "I joined, but it still says not joined", said: "joined_by_hand" as const }] } : {}),
      };
    case "apply_first":
      return {
        kind: "applied",
        chip: chip("apply_first"),
        text: MEMBERSHIP_TEXT.apply_first,
        sub: MEMBERSHIP_TEXT.applySub,
        button: { label: "Yes, I applied", external: false, action: "said_applied" },
        glass: [openCampaign(g.url)],
        asks: quiet(["not_eligible", "joined_by_hand"]),
      };
    case "waiting":
      return {
        kind: "wait",
        chip: chip("waiting"),
        text: MEMBERSHIP_TEXT.waiting,
        sub: MEMBERSHIP_TEXT.waitingSub,
        glass: [openCampaign(g.url)],
        asks: quiet(["not_eligible", "joined_by_hand"]),
      };
    case "left":
      return {
        kind: "join",
        chip: chip("left"),
        text: MEMBERSHIP_TEXT.left,
        button: { label: "Open campaign", href: g.url, external: true },
        asks: quiet(["joined_by_hand"]),
      };
    case "not_accepted":
      return { kind: "pick_another", chip: chip("not_accepted"), text: MEMBERSHIP_TEXT.not_accepted, button: { ...findAnother } };
    default:
      break;
  }
  // In (listed) or manual: rules, logo, soft stops, a video, then Make clips.
  const inChip = chip(g.membership);
  if (g.rulesState === "reading") return { kind: "stop", chip: inChip, text: stopText("rules_reading") };
  if (g.membership === "manual" && (g.rulesState === "waiting_for_join" || (g.rulesState === "ready" && !g.hasRules)))
    return { kind: "rules_paste", chip: inChip, text: MEMBERSHIP_TEXT.rulesPaste, button: { label: "Open campaign", href: g.url, external: true } };
  if (g.rulesState === "failed")
    return { kind: "rules_paste", chip: inChip, text: stopText("rules_failed"), button: { label: "Open campaign", href: g.url, external: true } };
  if (g.logoNeeded && !g.logoReady)
    return { kind: "logo", chip: inChip, text: stopText("logo_missing"), button: { label: "Add the logo", external: false, action: "logo_picker" } };
  const soft = g.stops.filter((s) => !s.hard && s.code !== "not_connected" && !g.anyway.includes(s.code));
  if (soft.length)
    return { kind: "anyway", chip: inChip, text: soft.map((s) => s.text).join(" "), button: { label: "Make clips anyway", external: false, action: "anyway" } };
  const lead = g.membership === "manual" ? MEMBERSHIP_TEXT.manual : MEMBERSHIP_TEXT.in;
  if (g.ownVideosOnly) return { kind: "pick_video", chip: inChip, text: `${lead} Pick a video below.` };
  return {
    kind: "make_clips",
    chip: inChip,
    text: lead,
    ...(connected || g.membership !== "manual" ? {} : { sub: stopText("not_connected") }),
    button: { label: "Make clips for this campaign", href: makeClipsPath(g.campaignId), external: false },
  };
}

/**
 * The phone's words for a next step: Connect itself only works on the Mac, so a phone's vermilion is "Set up Content
 * Rewards", the same setup page with the way back (§39.1 change 8): steps 1 and 2 work there, step 3 says "Do this
 * step on your Mac.".
 */
export function forDevice(step: NextStep, phone: boolean): NextStep {
  if (!phone || step.kind !== "connect") return step;
  const href = step.button?.href && step.button.href.startsWith(CR_SETUP_PATH) ? step.button.href : CR_SETUP_PATH;
  return { ...step, text: MEMBERSHIP_TEXT.unknownPhone, button: { label: "Set up Content Rewards", href, external: false } };
}

/**
 * Which control of the next step is the screen's one vermilion button (§38.1), given what is in the rules box.
 * Returns its label, or null when he only waits. Never two.
 */
export function vermilionOf(step: NextStep, boxText = ""): string | null {
  const typed = boxText.trim().length > 0;
  if ((step.kind === "check_yourself" || step.kind === "rules_paste") && typed) return step.kind === "check_yourself" ? "I'm in. Read these rules" : "Read these rules";
  return step.button?.label ?? null;
}

// ---------- Pay, budget and the places it pays for ----------

/** One row per platform the campaign pays on (CR's published rates, never a guess of what a clip earns). */
export function payLine(p: Campaign["pay"][number], type: Campaign["type"]): string {
  if (type === "pool") return "Shares the prize money";
  if (type === "retainer") return "A monthly fee for picked creators";
  if (p.perPostCents != null && p.per1kCents == null)
    return `${usd(p.perPostCents)} for each approved post${p.minViews ? ` · needs ${p.minViews.toLocaleString("en-US")} views` : ""}`;
  const parts: string[] = [];
  if (p.per1kCents != null) parts.push(`${usd(p.per1kCents)} per 1,000 views`);
  if (p.maxPayoutCents != null) parts.push(`up to ${usd(p.maxPayoutCents)} a clip`);
  if (p.minPayoutCents != null) parts.push(`a clip starts paying once it has earned ${usd(p.minPayoutCents)}`);
  return parts.join(" · ") || "Pay not shown yet";
}

/** "US & UK: $2.00 per 1,000 views", "Other countries: $0.20", "Unknown country: $0.10". */
export function countryLines(p: Campaign["pay"][number]): string[] {
  const out = (p.countryRates ?? []).map((r) => `${r.name}: ${usd(r.per1kCents)} per 1,000 views`);
  if (p.otherCountriesPer1kCents != null) out.push(`Other countries: ${usd(p.otherCountriesPer1kCents)}`);
  if (p.unknownCountryPer1kCents != null) out.push(`Unknown country: ${usd(p.unknownCountryPer1kCents)}`);
  return out;
}

/** "Plenty left" (< 50% used) / "Half used" / "Almost gone" (≥ 95%). */
export function budgetChip(usedPct: number | null): string | null {
  if (usedPct === null) return null;
  if (usedPct >= 95) return "Almost gone";
  if (usedPct < 50) return "Plenty left";
  return "Half used";
}

/** The lines under Upload to for a campaign clip (§38.5). */
export function placesLines(c: Pick<Campaign, "platformsPaid" | "uploadPlaces">): string[] {
  const out = ["Only places this campaign pays for."];
  if (c.platformsPaid.includes("tiktok") && !c.uploadPlaces.includes("tiktok"))
    out.push("TikTok is left out for now. Until TikTok checks Clip Factory, TikTok posts are private, and private posts can't earn.");
  return out;
}

/** The places CR refused as not added there, among those the campaign pays for (they come back after "I added it"). */
export function unlinkedPlaces(c: Pick<Campaign, "platformsPaid">, conn: CrConnection | null | undefined): Platform[] {
  if (!conn) return [];
  return PLATFORM_ORDER.filter((p) => c.platformsPaid.includes(p) && conn.crLinked[p] === false);
}

/** The line above Upload for a campaign clip. */
export function afterUploadLine(conn: CrConnection | null | undefined, membership: Membership | undefined): string {
  return canSend(conn) && membership === "in"
    ? "After it posts, Clip Factory sends it to Content Rewards by itself."
    : "After it posts, send its link to Content Rewards within 30 minutes. I'll remind you.";
}

// ---------- Each clip on Content Rewards (§38.6) ----------

export function reasonText(code: CrReasonCode, platform?: Platform, brandSaid?: string, n?: number): string {
  const place = platform ? PLATFORM_LABEL[platform] : "this";
  const quoted = brandSaid ? ` “${brandSaid.slice(0, 200)}”` : "";
  switch (code) {
    case "not_linked":
      return `Content Rewards doesn't know this ${place} account. Open Content Rewards settings, tap **Accounts**, and add it. Then tap I added it.`;
    case "not_on_application":
      return `Your ${place} account isn't on your application for this campaign. Open the campaign, tap **Add accounts**, and add it. The next clip will go.`;
    case "relink":
      return `This campaign needs ${place} added again in Content Rewards, with every box allowed. Open Content Rewards settings, then tap I added it.`;
    case "wrong_place":
      return `This campaign doesn't pay for ${place}. Pick another campaign.`;
    case "too_short":
      return `This clip is shorter than the campaign's ${n ? `${n} seconds` : "shortest length"}. The next clips will be longer.`;
    case "held":
      return stopText("held");
    case "account_refused":
      return "Content Rewards won't take clips from this account on this campaign. Pick another campaign.";
    case "sound_needed":
      return stopText("sound_needed");
    case "drafts_first":
      return stopText("drafts_first");
    case "campaign_closed":
      return "The campaign isn't taking clips right now. I'll tell you when it opens again.";
    case "campaign_refused":
      return `Content Rewards won't take this clip on this campaign.${quoted}`;
    case "refused":
      return `Content Rewards didn't take this clip.${quoted}`;
    case "banned":
      return "Content Rewards says your account can't earn on this campaign. Pick another campaign.";
    case "cap":
      return "You reached the most you can earn on this campaign.";
    case "not_sent_by_app":
      return "Clip Factory couldn't send this one.";
    case "not_visible_yet":
      return "Content Rewards can't see this post yet.";
    case "no_connection":
      return "Clip Factory isn't connected to Content Rewards.";
    case "read_only":
      return "Content Rewards hasn't let Clip Factory send clips yet.";
    case "manual":
      return "Content Rewards doesn't list this campaign for you yet.";
    case "ambiguous":
      return "Clip Factory can't tell which Content Rewards campaign this is.";
    case "window_over":
      return "Clip Factory ran out of time to send it.";
    case "private":
      return "The post is private, and private posts can't earn.";
    case "not_listed":
      return "Content Rewards doesn't list this campaign for you.";
  }
}

export const REASON_CODES: readonly CrReasonCode[] = [
  "private",
  "not_listed",
  "not_linked",
  "not_on_application",
  "relink",
  "wrong_place",
  "too_short",
  "held",
  "account_refused",
  "sound_needed",
  "drafts_first",
  "campaign_closed",
  "campaign_refused",
  "refused",
  "banned",
  "cap",
  "not_sent_by_app",
  "not_visible_yet",
  "no_connection",
  "read_only",
  "manual",
  "ambiguous",
  "window_over",
];

/** Reasons about the whole campaign: the line offers "Find another campaign". */
export const CAMPAIGN_REASONS: readonly CrReasonCode[] = ["wrong_place", "account_refused", "banned", "drafts_first", "sound_needed", "campaign_refused", "cap"];

/** "12.3K views on YouTube" (CR's last read of the post's lifetime views; never called paid views). */
export function viewsLine(views: number | null, platform: Platform): string | null {
  return views === null ? null : `${count(views)} views on ${PLATFORM_LABEL[platform]}`;
}

/** "Next time: …" from a keyword in the brand's words (code-made, §38.6). */
export function rejectHint(brandSaid: string | undefined): string | null {
  const t = (brandSaid ?? "").toLowerCase();
  if (!t) return null;
  if (t.includes("logo")) return "Next time: keep the logo on screen the whole clip.";
  if (/hashtag|\btags?\b/.test(t)) return "Next time: check every tag is in the caption.";
  if (/length|short/.test(t)) return "Next time: make the clip the length the brief asks for.";
  if (/disclosure|#ad\b/.test(t)) return "Next time: put #Ad at the start of the caption.";
  if (/music|sound/.test(t)) return "Next time: use only the sound the brief allows.";
  return null;
}

/** The sentence for each clip state (§38.6). The API sends the same in `line`; this is the web's copy. */
export function subLineFor(s: Pick<CrSubmission, "state" | "flagged" | "views" | "platform" | "earned" | "reason" | "appeal" | "minutesLeft" | "removed" | "postGone" | "reviewedAt">, now = Date.now()): string {
  if (s.postGone) return `The post is gone from ${PLATFORM_LABEL[s.platform]}, so it stops earning.`;
  if (s.removed) return "Content Rewards took this clip off the campaign. It earns nothing more.";
  const left = s.minutesLeft ?? 0;
  switch (s.state as CrSubState) {
    case "waiting_for_post":
      return "Goes to Content Rewards after it posts.";
    case "sending":
      return "Sending to Content Rewards…";
    case "sent":
      if (s.flagged) return "On hold: Content Rewards is checking the views.";
      return s.appeal?.askedAt ? "Back in review after you asked again." : "Sent ✓ · Waiting for the brand to check it";
    case "approved": {
      const views = viewsLine(s.views, s.platform);
      // Paid and still earning are shown side by side, never added up here (§25: the web only formats money).
      const paid = s.earned && s.earned.paidCents > 0 ? ` Earned on Content Rewards: ${usd(s.earned.paidCents)} so far.` : "";
      const pending = s.earned && s.earned.pendingCents > 0 ? ` ${usd(s.earned.pendingCents)} more is still earning.` : "";
      const earned = paid + pending;
      return `Approved ✓${views ? ` · ${views}` : ""}${earned}`;
    }
    case "rejected": {
      if (s.appeal?.askedAt) {
        const asked = Date.parse(s.appeal.askedAt);
        return Number.isFinite(asked) && now - asked > 10 * 86_400_000
          ? "The brand kept its answer. This one can't be asked again."
          : "Asked again ✓ · The answer takes 2 to 7 days.";
      }
      const said = s.reason?.brandSaid;
      return `Not approved: ${said ? `“${said.slice(0, 300)}”` : "The brand gave no reason."}`;
    }
    case "send_by_hand":
      if (s.reason?.code === "not_sent_by_app") return `Clip Factory couldn't send this one. Send it yourself now (${left} min left).`;
      if (s.reason?.code === "not_visible_yet") return `Content Rewards can't see this post yet. Send it yourself now (${left} min left).`;
      return `Send this to Content Rewards now (${left} min left)`;
    case "sent_by_hand":
      return "You sent it ✓ · Looking for it on Content Rewards…";
    case "missed":
      return "Too late to send this one. Content Rewards only takes clips in their first 30 minutes. Next time, send it as soon as I remind you.";
    case "not_sent":
      return `Content Rewards didn't take it: ${s.reason ? reasonText(s.reason.code, s.platform, s.reason.brandSaid) : "it gave no reason."}`;
  }
}

export const SUB_STATES: readonly CrSubState[] = ["waiting_for_post", "sending", "sent", "approved", "rejected", "send_by_hand", "sent_by_hand", "missed", "not_sent"];

/** The four steps of sending by hand (§38.6). */
export const SEND_STEPS = [
  "1 Tap Copy and open.",
  "2 Tap **Submit clip**.",
  "3 Tap **Clip link** and paste.",
  "4 Tick the box that starts “I've read”. Tap **Submit clip**.",
];
/** The hints under "How do I send it?", naming the post's own place (CR says "You don't have a linked {platform} account"). */
export function sendHints(platforms: readonly Platform[] = ["youtube"]): { see: string; do: string }[] {
  const names = PLATFORM_ORDER.filter((p) => platforms.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return [
    { see: "**Hold to confirm**", do: "Press and hold it." },
    { see: "a sign-in page", do: "Content Rewards asks you to sign in? Type the email code, then tap **Submit clip**." },
    { see: "“Posts have to be submitted within 30 minutes”", do: "Too late for this one. Next time, send it as soon as I remind you." },
    ...(names.length ? names : ["YouTube"]).map((name) => ({
      see: `“You don't have a linked ${name} account”`,
      do: "Tap Open Content Rewards settings below. Tap **Accounts**, and add it. The next clip will go.",
    })),
    { see: "“This post's account isn't on your application”", do: "Tap Open campaign below. Tap **Add accounts** and add it." },
    { see: "“already submitted”", do: "Nothing to do. It's in." },
  ];
}
export const SEND_HINTS: { see: string; do: string }[] = sendHints();

/** Posts of one clip waiting for the same campaign show as one line (§38.6); its copy is the links, one per line. */
export interface SendGroup {
  key: string;
  clipId: string;
  clipTitle: string;
  campaignId: string;
  campaignName: string;
  postIds: string[];
  platforms: Platform[];
  line: string;
  minutesLeft: number;
  copy: string;
  openHref: string;
}

/**
 * Minutes left to send by hand: worked out from `sendBy` against the clock (so the line counts down between two reads
 * of the API, and is gone once the time is up), else the API's own `minutesLeft`.
 */
export function minutesLeftOf(s: Pick<CrSubmission, "sendBy" | "minutesLeft">, now = Date.now()): number {
  const by = s.sendBy ? Date.parse(s.sendBy) : NaN;
  if (Number.isFinite(by)) return Math.max(0, Math.ceil((by - now) / 60_000));
  return s.minutesLeft ?? 0;
}

export function sendGroups(subs: readonly CrSubmission[], now = Date.now()): SendGroup[] {
  const by = new Map<string, CrSubmission[]>();
  for (const s of subs) {
    if (s.state !== "send_by_hand" || !s.url || minutesLeftOf(s, now) <= 0) continue;
    const key = `${s.clipId}:${s.campaignId}`;
    by.set(key, [...(by.get(key) ?? []), s]);
  }
  return [...by.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
    const minutesLeft = Math.min(...sorted.map((s) => minutesLeftOf(s, now)));
    const first = sorted[0]!;
    const line = sorted.length > 1 ? `Send these ${sorted.length} to Content Rewards now (${minutesLeft} min left)` : subLineFor({ ...first, minutesLeft });
    return {
      key,
      clipId: first.clipId,
      clipTitle: first.clipTitle,
      campaignId: first.campaignId,
      campaignName: first.campaignName,
      postIds: sorted.map((s) => s.postId),
      platforms: sorted.map((s) => s.platform),
      line,
      minutesLeft,
      copy: sorted.map((s) => s.url!).join("\n"),
      openHref: first.openCampaignHref,
    };
  });
}

/** Ask again (an appeal, §38.6): its steps, and what each answer Content Rewards may show means. */
export function appealSteps(title: string, postedAt: string | undefined): string[] {
  return [
    "1 Tap **Rejected**.",
    `2 Find the clip “${title}”${postedAt ? ` from ${shortDay(postedAt)}` : ""}. Tap it.`,
    "3 Under “Think this rejection is wrong?”, tap **Start appeal**.",
    "4 Paste in **Appeal explanation**. Tap **Start appeal**.",
  ];
}
export const APPEAL_HINTS: { see: string; do: string }[] = [
  { see: "“You can appeal one clip per day”", do: "Try again tomorrow." },
  { see: "“The time to appeal this decision has passed”", do: "This one can't be asked again." },
  { see: "“This clip failed the campaign's requirements check, so it can't be appealed”", do: "This one can't be asked again. Check the rules for the next clip." },
  { see: "“This agency isn't taking appeals yet”", do: "This brand doesn't take appeals." },
  { see: "“This clip already has an open appeal”", do: "Nothing to do. Wait for the answer." },
];
export const APPEAL_HREF = CR_SUBMISSIONS;

/** How to record the screen (proof of views, §38.6). */
export const RECORD_SCREEN = [
  "iPhone: Swipe down from the top right corner. Tap the round record button. Tap it again to stop.",
  "Mac: Press Shift, Command and 5. Click **Record Entire Screen**.",
];

/** Where each platform's own views are, for the proof step. */
export const PROOF_OPEN: Record<Platform, { label: string; href: string }> = {
  youtube: { label: "Open YouTube Studio", href: "https://studio.youtube.com/" },
  instagram: { label: "Open Instagram", href: "https://www.instagram.com/" },
  x: { label: "Open X", href: "https://x.com/i/account_analytics" },
  facebook: { label: "Open Facebook", href: "https://www.facebook.com/" },
  tiktok: { label: "Open TikTok", href: "https://www.tiktok.com/" },
};

export { CR_SETTINGS };

/** Only an https page is ever opened; anything else (a `javascript:` or `data:` address) falls back to `fallback`. */
export function safeHref(href: string | null | undefined, fallback: string = CR_SUBMISSIONS): string {
  return typeof href === "string" && /^https:\/\/[^\s]+$/.test(href) ? href : fallback;
}

/** The Content Rewards campaign page for a campaign id (built here, never taken from a reply). */
export function crCampaignUrl(campaignId: string | null | undefined): string {
  return campaignId && /^[0-9a-f-]{36}$/i.test(campaignId) ? `https://contentrewards.com/c/campaigns/${campaignId.toLowerCase()}` : CR_SUBMISSIONS;
}

/** Copies and opens in the same tap: the copy starts first and is never awaited before the open (§38.6). */
export function copyAndOpen(text: string, href: string, copy: (t: string) => Promise<boolean>, fallback: string = CR_SUBMISSIONS): Promise<boolean> {
  const copied = copy(text);
  window.open(safeHref(href, fallback), "_blank", "noopener,noreferrer");
  return copied;
}

/** The pilot email's `mailto:` only when it goes to Content Rewards' support (else the one this app writes). */
export function safeMailto(mailto: string | null | undefined, fallback: string): string {
  return typeof mailto === "string" && /^mailto:support@contentrewards\.com\?/.test(mailto) ? mailto : fallback;
}

/**
 * A clip line for <Rich>: **bold** stays for the other site's button names the code wrote, but never inside the
 * brand's own quoted words (“…”), which stay plain.
 */
export function richLine(line: string): string {
  // A zero-width space between the two stars: they still show, but never turn into bold.
  return line.replace(/“[^”]*”/g, (q) => q.replace(/\*\*/g, "*\u200b*"));
}

// ---------- One clip's or one campaign's posts on Content Rewards ----------

/**
 * GET /v1/contentrewards/submissions for a clip or a campaign (the only two query shapes, §38.8), read again (once
 * per burst) on live contentrewards and post news. An API from before §38, or one switched off, gives an empty list
 * (no line shows). `campaignIds`: Library's view, every listed campaign's posts, merged.
 */
export function useSubmissions(query: { clipId?: string; campaignId?: string; campaignIds?: readonly string[] }, enabled = true) {
  const many = query.campaignIds ? [...new Set(query.campaignIds)].sort() : null;
  const key = `${query.clipId ?? ""}|${query.campaignId ?? ""}|${many?.join(",") ?? ""}`;
  const on = enabled && (!!query.clipId || !!query.campaignId || !!many?.length);
  const [subs, setSubs] = useState<CrSubmission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const q = useRef(query);
  q.current = query;
  const reload = useCallback(async () => {
    if (!on) return;
    const mine = ++seq.current;
    const now = q.current;
    try {
      const list = now.campaignIds
        ? (await Promise.all([...new Set(now.campaignIds)].map((campaignId) => api().crSubmissions({ campaignId }).catch(() => [] as CrSubmission[])))).flat()
        : await api().crSubmissions(now.clipId ? { clipId: now.clipId } : { campaignId: now.campaignId });
      if (mine === seq.current) setSubs(list);
    } catch {
      if (mine === seq.current) setSubs([]);
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);
  useEffect(() => {
    if (!on) {
      setSubs([]);
      return;
    }
    void reload();
  }, [reload, on]);
  useEffect(() => {
    if (!on) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onLiveSignal((s) => {
      if (s.kind !== "resync" && s.event.type !== "contentrewards" && s.event.type !== "post") return;
      if (t) clearTimeout(t);
      t = setTimeout(() => void reload(), 600);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [on, reload]);
  const put = useCallback((next: CrSubmission | null) => {
    if (!next) return void reload();
    setSubs((list) => list.map((s) => (s.postId === next.postId ? next : s)));
  }, [reload]);
  return { subs, loaded, reload, put, setSubs };
}
