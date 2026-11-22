// Your bank's routes (docs/CONTRACTS.md §40.5.10) in memory, for the pretend app only (npm run dev:mock, Playwright).
// The view follows §40.5.9's rules (statuses, pills, lines, next, steps and autos, the totals per place per currency)
// from the pretend owner's taps; the pretend Enable Banking answers at once: any app ID saves with `not_active`, "I
// linked them" gives `ok`, the bank list has 12 Swedish names, and a connect goes to a pretend bank page and back
// through /bank-done. The first read then gives one link (Swedbank, 143 of 180 days) and four rows. `?mockBank=…`
// (ending, ended, stopped_at_bank, cant_read, days90, none_yet, off, and connected or setup) picks a start, kept in
// sessionStorage so the trip through the pretend bank page keeps it. The amounts are fixtures for the pretend app
// only: the real app shows only what the bank booked. Only bundled into mock builds.
import type {
  Amount,
  BankAnswer,
  BankAppBody,
  BankAppCheck,
  BankAppCode,
  BankAsk,
  BankChoice,
  BankLink,
  BankOff,
  BankPlace,
  BankPlaceLine,
  BankReached,
  BankResult,
  BankRow,
  BankStatus,
  BankStepId,
  BankTickId,
  BankView,
  GetPaidPlace,
  Tone,
} from "../types.ts";
import { ApiError } from "../errors.ts";
import { BANK_PATH, CHECK_TEXT, bankRefusal, countryName, numberedBankSteps, resultSentence } from "../../getpaid/bank.ts";

export type BankApi = Pick<
  import("../types.ts").Api,
  "getBank" | "bankMakeKey" | "bankSaveApp" | "bankCheckApp" | "bankStep" | "bankBanks" | "bankConnect" | "bankCheckNow" | "bankAnswer" | "bankStopLink" | "bankForget"
>;

const KEY = "cf-mock-bank";
const DAY = 86_400_000;
const HOUR = 3_600_000;
export const MOCK_BANK_PATH = "/mock-bank";
const HOOKS = "https://hooks.clipfactory.example";
const APP = "https://app.clipfactory.example";

/** The pretend bank list: Swedish banks, in no special order (the picker sorts them). */
export const MOCK_BANKS: BankChoice[] = [
  { name: "Nordea", maxDays: 180, beta: false },
  { name: "SEB", maxDays: 180, beta: false },
  { name: "Swedbank", maxDays: 180, beta: false },
  { name: "Handelsbanken", maxDays: 180, beta: false },
  { name: "Danske Bank", maxDays: 180, beta: false },
  { name: "Länsförsäkringar Bank", maxDays: 180, beta: false },
  { name: "ICA Banken", maxDays: 90, beta: false },
  { name: "SBAB Bank", maxDays: 180, beta: false },
  { name: "Skandiabanken", maxDays: 180, beta: false },
  { name: "Revolut", maxDays: 90, beta: true },
  { name: "Ålandsbanken", maxDays: 180, beta: false },
  { name: "Marginalen Bank", maxDays: 90, beta: false },
];

interface MockLink {
  linkId: string;
  bank: string;
  status: "connected" | "ended" | "stopped_at_bank" | "stopped";
  reason?: "consent_over" | "ended_early" | "psu_action";
  connectedAt: string;
  consentUntil: string;
  firstReadDone: boolean;
  accounts: number;
  lastReadAt?: string;
  historyFrom?: string;
  failingSince?: string;
  lastError?: string;
  stoppedAt?: string;
  endedAt?: string;
}
interface MockDeposit {
  depositId: string;
  date: string;
  amountMicros: number;
  currency: string;
  linkId: string;
  state: "matched" | "needs_you" | "not_income";
  place?: BankPlace;
  how?: "payout" | "payer" | "you";
  payoutDate?: string;
  suggested?: BankPlace | null;
  kind?: "place" | "own_move";
  /** Clip Factory's own word for what the bank's text names (never the text itself). */
  hint?: "google" | "stripe" | "meta" | "paypal" | "payoneer" | "whop";
  notSure?: boolean;
  /** The suggestion before a `not_this` cleared it, so a pretend answer of `yes` still knows nothing. */
  was?: { place: BankPlace; how: "payout" | "payer" | "you"; payoutDate?: string };
}
export interface BankMockState {
  scenario: string;
  stepsDone: string[];
  key: { source: "clipfactory" | "file"; appId: string | null; pemReminder: boolean } | null;
  check: { code: BankAppCode; at: string } | null;
  links: MockLink[];
  deposits: MockDeposit[];
  lastConnect?: { result: BankResult; linkId?: string; bank: string; reconnect: boolean; at: string };
  /** A connect sent and not answered yet (the pretend bank page reads it). */
  pending?: { state: string; bank: string; linkId: string; reconnect: boolean; maxDays: number };
  lastManualAt?: string;
  learned: { payer: string; place: BankPlace }[];
  /** No longer in the bank list for a reconnect (a test knob). */
  countryNotLinked?: boolean;
  noCountry?: boolean;
}

export type BankScenario = "fresh" | "setup" | "connected" | "ending" | "ended" | "stopped_at_bank" | "cant_read" | "days90" | "none_yet" | "off" | "look_in_bank";
export const BANK_SCENARIOS: readonly BankScenario[] = ["fresh", "setup", "connected", "ending", "ended", "stopped_at_bank", "cant_read", "days90", "none_yet", "off", "look_in_bank"];

const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(Date.now() - ms);
const ahead = (ms: number) => iso(Date.now() + ms);

/** The pretend first read: a YouTube payout match, two questions (Google, Stripe) and a Meta payer match (§40.5.11). */
function firstRows(linkId: string): MockDeposit[] {
  return [
    { depositId: "d0youtube00000000000000000000001", date: "2026-10-28", amountMicros: 1_234_560_000, currency: "SEK", linkId, state: "matched", place: "youtube", how: "payout", payoutDate: "2026-10-21" },
    { depositId: "d0google000000000000000000000002", date: "2026-11-04", amountMicros: 85_000_000, currency: "SEK", linkId, state: "needs_you", suggested: "youtube", kind: "place", hint: "google" },
    { depositId: "d0stripe000000000000000000000003", date: "2026-11-12", amountMicros: 321_700_000, currency: "SEK", linkId, state: "needs_you", suggested: "x", kind: "place", hint: "stripe" },
    { depositId: "d0meta00000000000000000000000004", date: "2026-10-23", amountMicros: 912_400_000, currency: "SEK", linkId, state: "matched", place: "meta", how: "payer" },
  ];
}

function swedbank(over: Partial<MockLink> = {}): MockLink {
  return {
    linkId: "a1b2c3d4e5f6",
    bank: "Swedbank",
    status: "connected",
    connectedAt: ago(37 * DAY),
    consentUntil: ahead(143 * DAY - HOUR),
    firstReadDone: true,
    accounts: 2,
    lastReadAt: ago(3 * HOUR),
    historyFrom: "2026-08-03",
    ...over,
  };
}

function blank(scenario = "fresh"): BankMockState {
  return { scenario, stepsDone: [], key: null, check: null, links: [], deposits: [], learned: [] };
}

/** Every step done, the app known and active, no bank yet. */
function setUp(s: BankMockState): BankMockState {
  s.stepsDone = ["bank-account", "bank-app", "bank-details"];
  s.key = { source: "clipfactory", appId: "0f8c2a4e-9b1d-4c6e-8a3f-5d7b9e1c2a40", pemReminder: false };
  s.check = { code: "ok", at: ago(2 * DAY) };
  return s;
}

export function bankScenario(name: BankScenario): BankMockState {
  const s = blank(name);
  if (name === "fresh" || name === "off") return s;
  setUp(s);
  if (name === "setup") return s;
  const link = swedbank();
  if (name === "ending") Object.assign(link, { connectedAt: ago(171 * DAY), consentUntil: ahead(9 * DAY - HOUR) });
  if (name === "ended") Object.assign(link, { status: "ended", reason: "consent_over", connectedAt: ago(182 * DAY), consentUntil: ago(2 * DAY), endedAt: ago(DAY) });
  if (name === "stopped_at_bank") Object.assign(link, { status: "stopped_at_bank", endedAt: ago(DAY) });
  if (name === "cant_read") Object.assign(link, { failingSince: ago(4 * DAY), lastError: "Swedbank didn't answer. Clip Factory tries again tomorrow.", lastReadAt: ago(4 * DAY) });
  if (name === "look_in_bank") Object.assign(link, { reason: "psu_action" });
  if (name === "days90") Object.assign(link, { connectedAt: ago(37 * DAY), consentUntil: ahead(53 * DAY - HOUR) });
  s.links = [link];
  s.deposits = name === "none_yet" ? [] : firstRows(link.linkId);
  return s;
}

function load(): BankMockState {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as BankMockState;
  } catch {
    /* a broken copy: start again */
  }
  return blank();
}
function save(s: BankMockState) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: kept for this page only */
  }
}

// ---------- Words (the server's, §40.5.9) ----------

const NAMES: Record<BankPlace, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  meta: "Instagram and Facebook (Meta pays them together)",
  x: "X",
  contentrewards: "Content Rewards (Whop)",
};
const SHORT: Record<BankPlace, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", meta: "Instagram and Facebook", x: "X", contentrewards: "Content Rewards" };
const ORDER: BankPlace[] = ["youtube", "tiktok", "instagram", "facebook", "meta", "x", "contentrewards"];
const GETPAID: GetPaidPlace[] = ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"];
const TITLES: Record<BankStepId, string> = Object.fromEntries(numberedBankSteps().map((s) => [s.id, s.title])) as Record<BankStepId, string>;

/** "28 Oct" (UTC days, as the server writes them). */
const day = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "Fri 20 May" */
const weekday = (d: string) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
const longDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function joinOr(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
function joinAnd(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const daysLeftOf = (l: MockLink, now: number) => Math.max(0, Math.ceil((Date.parse(l.consentUntil) - now) / DAY));
const totalDaysOf = (l: MockLink) => Math.round((Date.parse(l.consentUntil) - Date.parse(l.connectedAt)) / DAY);

function linkStatus(l: MockLink, now: number): BankLink["status"] {
  if (l.status !== "connected") return l.status;
  if (l.reason === "psu_action") return "look_in_bank";
  if (l.failingSince && now - Date.parse(l.failingSince) > 26 * HOUR) return "cant_read";
  if (daysLeftOf(l, now) <= 14) return "ending_soon";
  if (!l.firstReadDone) return "checking";
  return "can_see";
}

const PILL: Record<BankStatus, [string, Tone]> = {
  not_started: ["Not started", "neutral"],
  setting_up: ["Not set up yet", "warn"],
  checking: ["Checking…", "neutral"],
  can_see: ["Clip Factory can see it (Your bank says)", "success"],
  ending_soon: ["Link ends in {n} days", "warn"],
  cant_read: ["Can't read {bank}", "warn"],
  look_in_bank: ["Look in your {bank} app", "warn"],
  ended: ["Link ended", "error"],
  stopped_at_bank: ["Stopped outside Clip Factory", "error"],
  stopped: ["Stopped", "neutral"],
};

function linkWords(l: MockLink, status: BankLink["status"], now: number, banks: string): { pill: string; tone: Tone; line: string } {
  const [pill, tone] = PILL[status];
  const n = daysLeftOf(l, now);
  const filled = pill.replace("{n}", String(n)).replace("{bank}", l.bank);
  const line = (() => {
    switch (status) {
      case "checking":
        return now - Date.parse(l.connectedAt) > 26 * HOUR ? `Clip Factory couldn't read ${l.bank} yet. It tries again tomorrow.` : `Clip Factory is reading ${l.bank} for the first time. This can take a few minutes.`;
      case "can_see":
        return `Clip Factory looks at ${banks} once a day. The ${banks.includes(" and ") ? "first link" : "link"} ends in ${n} days.`;
      case "ending_soon":
        return `Your ${l.bank} link ends on ${weekday(l.consentUntil)}. Tap Reconnect ${l.bank} and use BankID.`;
      case "cant_read":
        return `Clip Factory couldn't read ${l.bank} since ${day(l.failingSince!)}. Tap Check now. If it stays, tap Reconnect ${l.bank}.`;
      case "look_in_bank":
        return `${l.bank} wants you to do something in its app or website first. Then tap Check now.`;
      case "ended":
        return l.reason === "consent_over"
          ? `Your ${l.bank} link ended on ${day(l.consentUntil)}. Clip Factory can't see new money until you reconnect.`
          : `${l.bank} ended the link early. Banks sometimes do. Tap Reconnect ${l.bank} and use BankID.`;
      case "stopped_at_bank":
        return `The ${l.bank} link was stopped at Enable Banking or at your bank. Tap Reconnect ${l.bank} to start it again.`;
      case "stopped":
        return `You stopped reading ${l.bank} on ${day(l.stoppedAt ?? new Date(now).toISOString())}. The money it found stays here.`;
    }
  })();
  return { pill: filled, tone, line };
}

/** The worst link wins: ended › stopped outside › look in your bank › can't read › ends soon › checking › can see. */
const WORST: BankLink["status"][] = ["ended", "stopped_at_bank", "look_in_bank", "cant_read", "ending_soon", "checking", "can_see"];

function sumByCurrency(rows: readonly { amountMicros: number; currency: string }[]): Amount[] {
  const out: Amount[] = [];
  for (const r of rows) {
    const a = out.find((x) => x.currency === r.currency);
    if (a) a.amountMicros += r.amountMicros;
    else out.push({ currency: r.currency, amountMicros: r.amountMicros });
  }
  return out;
}

const TITLE_OF: Partial<Record<BankPlace | "stripe", [string, string, string]>> = {
  youtube: ["Is this money from YouTube?", "Your bank's text looks like Google.", "Yes, it's YouTube"],
  meta: ["Is this money from Instagram and Facebook?", "Your bank's text looks like Meta.", "Yes, Instagram and Facebook"],
  stripe: ["Is this money from X?", "Your bank's text says Stripe. X pays through Stripe, but others can too.", "Yes, it's X"],
};

function askOf(d: MockDeposit, bank: string): BankAsk {
  const base = { depositId: d.depositId, date: d.date, amountMicros: d.amountMicros, currency: d.currency, bank, kind: d.kind ?? "place", suggested: d.suggested ?? null, notSure: !!d.notSure };
  if (d.kind === "own_move") return { ...base, title: "Did you move this from your PayPal?", line: "Clip Factory reads your PayPal too, so this money may already be counted there.", yesLabel: "Yes, I moved it" };
  if (!d.suggested) return { ...base, title: "Where is this money from?", line: d.hint === "payoneer" ? "Your bank's text mentions Payoneer." : d.hint === "paypal" ? "Your bank's text mentions PayPal." : "Your bank's text names no app." };
  const words = d.hint === "stripe" ? TITLE_OF.stripe! : (TITLE_OF[d.suggested] ?? [`Is this money from ${SHORT[d.suggested]}?`, `Your bank's text looks like ${SHORT[d.suggested]}.`, `Yes, it's ${SHORT[d.suggested]}`]);
  return { ...base, title: words[0], line: words[1], yesLabel: words[2] };
}

function howText(d: MockDeposit): string {
  if (d.how === "payout") return d.place === "contentrewards" ? `matches Whop's payout of ${day(d.payoutDate!)}` : `matches Google's payment of ${day(d.payoutDate!)}`;
  if (d.how === "payer") return `from a payer you said is ${SHORT[d.place!]}`;
  return `you said it's from ${SHORT[d.place!]}`;
}

// ---------- The view (§40.5.9) ----------

export function bankViewOf(s: BankMockState, opts: { now?: number; country: string | null; crOn: boolean }): BankView {
  const now = opts.now ?? Date.now();
  const at = iso(now);
  const checkOk = s.check?.code === "ok";
  const known = s.check?.code === "ok" || s.check?.code === "not_active";
  const anyLink = s.links.length > 0;
  const tapped = (id: string) => s.stepsDone.includes(id);
  const firstBank = s.links[s.links.length - 1]?.bank ?? "your bank";
  const step = (id: BankStepId): BankView["steps"][number] => {
    const knows = "Enable Banking knows your app";
    switch (id) {
      case "bank-ask":
        return { id, done: tapped(id), by: tapped(id) ? "you" : null };
      case "bank-account":
      case "bank-app":
      case "bank-details":
        return tapped(id) ? { id, done: true, by: "you" } : known || anyLink ? { id, done: true, by: "auto", auto: knows } : { id, done: false, by: null };
      case "bank-key":
        return s.key ? { id, done: true, by: "auto", auto: "Clip Factory made your bank key" } : { id, done: false, by: null };
      case "bank-appid":
        return known ? { id, done: true, by: "auto", auto: knows } : { id, done: false, by: null };
      case "bank-link":
        return checkOk || anyLink ? { id, done: true, by: "auto", auto: anyLink ? `Clip Factory can see ${firstBank}` : "Enable Banking says your app is active" } : { id, done: false, by: null };
      case "bank-connect":
        return anyLink ? { id, done: true, by: "auto", auto: `Clip Factory can see ${firstBank}` } : { id, done: false, by: null };
    }
  };
  const ids: BankStepId[] = ["bank-ask", ...numberedBankSteps().map((x) => x.id)];
  const steps = ids.map(step);
  const numbered = steps.filter((x) => x.id !== "bank-ask");
  const done = numbered.filter((x) => x.done).length;
  const allDone = done === 7;
  const nowLinks = s.links.map((l) => ({ l, status: linkStatus(l, now) }));
  const notStopped = nowLinks.filter((x) => x.status !== "stopped");
  const banksText = joinAnd(notStopped.map((x) => x.l.bank));
  const links: BankLink[] = [...nowLinks]
    .sort((a, b) => Date.parse(b.l.connectedAt) - Date.parse(a.l.connectedAt))
    .map(({ l, status }) => {
      const words = linkWords(l, status, now, banksText || l.bank);
      const daysLeft = daysLeftOf(l, now);
      const reconnect = status === "ended" || status === "stopped_at_bank" || status === "ending_soon" || (!!l.failingSince && now - Date.parse(l.failingSince) > 3 * DAY);
      return {
        linkId: l.linkId,
        bank: l.bank,
        status,
        ...words,
        ...(l.lastError ? { lastError: l.lastError } : {}),
        accounts: l.accounts,
        daysLeft,
        totalDays: totalDaysOf(l),
        consentUntil: l.consentUntil,
        ...(l.lastReadAt ? { checkedAt: l.lastReadAt } : {}),
        ...(l.historyFrom ? { historyFrom: l.historyFrom } : {}),
        ...(l.failingSince ? { failingSince: l.failingSince } : {}),
        reconnect: status !== "stopped" && reconnect,
        canStop: status !== "stopped",
      };
    });

  // next: the first numbered step not done; with every step done, the first link that needs a reconnect.
  const LABEL: Record<BankStepId, string | null> = {
    "bank-ask": null,
    "bank-account": "Open Enable Banking",
    "bank-key": "Make my bank key",
    "bank-app": "Open your Enable Banking apps",
    "bank-details": null,
    "bank-appid": s.key?.appId ? "Check again" : "Save",
    "bank-link": "Open your Enable Banking apps",
    "bank-connect": "Connect your bank",
  };
  const firstOpen = numbered.find((x) => !x.done);
  let next: BankView["next"] = null;
  if (firstOpen) {
    const n = numbered.indexOf(firstOpen) + 1;
    next = { stepId: firstOpen.id, label: LABEL[firstOpen.id] ?? "", text: `Next: step ${n}, ${TITLES[firstOpen.id]}.`, vermilion: firstOpen.id !== "bank-details" };
  } else {
    const order: BankLink["status"][] = ["ended", "stopped_at_bank", "cant_read", "ending_soon"];
    const re = links.filter((l) => l.reconnect).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0];
    if (re) next = { stepId: null, label: `Reconnect ${re.bank}`, linkId: re.linkId, vermilion: true };
  }

  // The status: setup first; after it, the worst link wins; every link stopped: stopped.
  let status: BankStatus;
  let pill: string;
  let tone: Tone;
  let line: string;
  if (!allDone) {
    const nothing = !s.key && !steps.some((x) => x.done);
    status = nothing ? "not_started" : "setting_up";
    [pill, tone] = PILL[status];
    line = nothing
      ? "See which app money reached your bank. Set it up once with BankID."
      : s.check && !known && s.check.code !== "down"
        ? CHECK_TEXT[s.check.code]
        : (next?.text ?? "");
  } else if (!notStopped.length) {
    status = "stopped";
    const l = nowLinks[0]!.l;
    ({ pill, tone, line } = linkWords(l, "stopped", now, l.bank));
  } else {
    const worst = [...notStopped].sort((a, b) => WORST.indexOf(a.status) - WORST.indexOf(b.status))[0]!;
    status = worst.status;
    ({ pill, tone, line } = linkWords(worst.l, worst.status, now, banksText));
    if (status === "can_see" && notStopped.length > 1) {
      const first = Math.min(...notStopped.map((x) => daysLeftOf(x.l, now)));
      line = `Clip Factory looks at ${banksText} once a day. The first link ends in ${first} days.`;
    }
  }

  // The rows, the questions and Reached your bank.
  const bankOf = (linkId: string) => s.links.find((l) => l.linkId === linkId)?.bank ?? "your bank";
  const matched = s.deposits.filter((d) => d.state === "matched" && (opts.crOn || d.place !== "contentrewards")).sort((a, b) => b.date.localeCompare(a.date));
  const waiting = s.deposits.filter((d) => d.state === "needs_you").sort((a, b) => Number(!!a.notSure) - Number(!!b.notSure) || b.date.localeCompare(a.date));
  const asks = waiting.slice(0, 20).map((d) => askOf(d, bankOf(d.linkId)));
  const rows: BankRow[] = matched.slice(0, 36).map((d) => ({ depositId: d.depositId, date: d.date, amountMicros: d.amountMicros, currency: d.currency, bank: bankOf(d.linkId), place: d.place!, name: NAMES[d.place!], how: d.how!, howText: howText(d) }));
  const places = ORDER.filter((p) => p !== "contentrewards" || opts.crOn);
  const reachedPlaces = places
    .map((place) => {
      const mine = matched.filter((d) => d.place === place);
      if (!mine.length) return null;
      const note = place === "contentrewards" ? "Whop sends all your Whop money, Content Rewards too." : place === "meta" ? "Meta pays Instagram and Facebook in one payment, so Clip Factory can't split it." : undefined;
      return { place, name: NAMES[place], amounts: sumByCurrency(mine), ...(note ? { note } : {}) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const totals = sumByCurrency(matched);
  const hasMeta = matched.some((d) => d.place === "meta");
  const notYetNames = places
    .filter((p) => p !== "meta")
    .filter((p) => !matched.some((d) => d.place === p) && !(hasMeta && (p === "instagram" || p === "facebook")))
    .map((p) => SHORT[p]);
  const historyFroms = s.links.map((l) => l.historyFrom).filter((x): x is string => !!x).sort();
  const firstRead = s.links.some((l) => l.firstReadDone);
  const needN = waiting.filter((d) => !d.notSure).length;
  const reached: BankReached = {
    state: !anyLink ? "no_link" : !firstRead ? "checking" : matched.length ? "number" : "none_yet",
    places: reachedPlaces,
    totals,
    tag: "Your bank says. Clip Factory matched each one to an app.",
    ...(totals.length > 1 ? { twoMonies: "Different money, like dollars and kronor, is never added together." } : {}),
    ...(anyLink && firstRead && notYetNames.length ? { notYet: `No money from ${joinOr(notYetNames)} reached your bank yet.` } : {}),
    ...(historyFroms.length ? { since: `Counted from ${longDay(historyFroms[0]!)}, as far back as your bank shows.` } : {}),
    ...(matched.length ? {} : { empty: "Nothing from an app reached your bank yet." }),
    ...(needN ? { needYou: `${needN} bank ${needN === 1 ? "payment needs" : "payments need"} you.` } : {}),
  };
  const lastRead = s.links.map((l) => l.lastReadAt).filter((x): x is string => !!x).sort().pop();
  const placeLines: BankView["places"] = {};
  for (const p of GETPAID.filter((x) => x !== "contentrewards" || opts.crOn)) {
    const mine = matched.filter((d) => d.place === p);
    const meta = p === "instagram" || p === "facebook" ? matched.filter((d) => d.place === "meta") : [];
    let lineOf: BankPlaceLine;
    if (!anyLink) lineOf = { headline: "Clip Factory can't see your bank yet.", amounts: [], button: { label: "Set up Your bank", href: BANK_PATH } };
    else if (mine.length || meta.length)
      lineOf = {
        headline: mine.length ? "Reached your bank" : `Nothing from ${SHORT[p]} reached your bank yet.`,
        amounts: sumByCurrency(mine),
        ...(meta.length ? { metaAmounts: sumByCurrency(meta) } : {}),
        note: `Your bank says. Last on ${day([...mine, ...meta].map((d) => d.date).sort().pop()!)}.`,
      };
    else lineOf = { headline: `Nothing from ${SHORT[p]} reached your bank yet.`, amounts: [], note: lastRead ? `Your bank says. Clip Factory looked on ${day(lastRead)}.` : "Your bank says." };
    placeLines[p] = lineOf;
  }
  const pairs = matched
    .filter((d) => d.how === "payout" && d.place && d.place !== "meta")
    .map((d) => ({ place: d.place as GetPaidPlace, payoutDate: d.payoutDate!, amountMicros: d.amountMicros, currency: d.currency, reachedOn: d.date }));

  const lc = s.lastConnect && now - Date.parse(s.lastConnect.at) < DAY ? s.lastConnect : undefined;
  const view: BankView = {
    on: true,
    status,
    pill,
    tone,
    line,
    next,
    steps,
    ring: { done, total: 7 },
    ...(allDone ? { fold: checkOk ? "Set up ✓ (Enable Banking knows your app)" : "Set up ✓" } : {}),
    key: {
      made: !!s.key,
      ...(s.key
        ? {
            source: s.key.source,
            publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMOCKpretendBankKeyForTestingOnly0123456789abcdefABCDEF\n-----END PUBLIC KEY-----",
            certificatePem: "-----BEGIN CERTIFICATE-----\nMOCKpretendOtherBankKeyForTestingOnly0123456789abcdef\n-----END CERTIFICATE-----",
            ...(s.key.appId ? { appIdHint: `${s.key.appId.slice(0, 8)}…` } : {}),
            ...(s.check ? { check: { code: s.check.code, text: CHECK_TEXT[s.check.code], at: s.check.at } } : {}),
            ...(s.key.pemReminder ? { pemReminder: true } : {}),
          }
        : {}),
    },
    ...(lc ? { lastConnect: { result: lc.result, text: resultSentence(lc.result, lc.bank, lc.reconnect), at: lc.at } } : {}),
    values: {
      redirectUri: `${HOOKS}/oauth/bank/callback`,
      appName: "Clip Factory",
      description: "Shows me which of my app payouts reached my own bank account.",
      privacyUrl: `${APP}/legal/privacy.html`,
      termsUrl: `${APP}/legal/terms.html`,
      ask: {
        to: "support.api@enablebanking.com",
        subject: "Personal use: my own creator income on my own account",
        body: [
          "Hello,",
          `I'm a private person in ${countryName(opts.country ?? "SE")}. I made a restricted Production application in your Control Panel, linked only to my own personal accounts.`,
          "I post short videos. YouTube, TikTok, Meta, X and Whop sometimes pay small amounts into my personal bank account or PayPal. I want my own app to read my booked incoming payments once a day, keep only the ones from those platforms, and show me the totals. Nobody else uses it, and I don't share, sell or offer it to anyone.",
          "Does this count as personal use of private individuals under your Terms? Is one automatic read a day, plus a read when I tap a button, fine?",
          "Thank you!",
        ].join("\n\n"),
      },
    },
    links,
    asks,
    ...(waiting.length > 20 ? { asksMore: waiting.length - 20 } : {}),
    reached,
    rows,
    pairs,
    places: placeLines,
    ...(anyLink ? { moneyLine: "What reached your bank is below." } : {}),
    canAddBank: notStopped.length < 4,
    ...(lastRead ? { checkedAt: lastRead } : {}),
    ...(s.lastManualAt ? { nextCheckAllowedAt: iso(Date.parse(s.lastManualAt) + 15 * 60_000) } : {}),
    country: opts.country,
    asOf: at,
  };
  return view;
}

// ---------- The routes ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEM_FILE = /^([0-9a-fA-F-]{36})(?: \(\d+\))?\.pem$/;
const STOP_FIRST = "Stop reading every bank first.";
const bad = (m: string) => new ApiError(400, "bad_request", m);
const conflict = (m: string) => new ApiError(409, "conflict", m);
const notFound = () => new ApiError(404, "not_found", "That payment no longer exists.");
const off = () => new ApiError(503, "unavailable", "Coming soon.");
const rid = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export interface BankMockDeps {
  country: () => string | null;
  crOn: () => boolean;
  publish: () => void;
}

export function bankMockApi(wait: () => Promise<void>, deps: BankMockDeps) {
  /** `?mockBank=…` picks a start once per value (a reload keeps what he did since). */
  function fromQuery() {
    if (typeof location === "undefined") return;
    const want = new URLSearchParams(location.search).get("mockBank");
    if (!want || !(BANK_SCENARIOS as readonly string[]).includes(want)) return;
    const s = load();
    if (s.scenario === want) return;
    save(bankScenario(want as BankScenario));
  }
  const state = () => {
    fromQuery();
    return load();
  };
  const viewOf = (s: BankMockState) => bankViewOf(s, { country: s.noCountry ? null : (deps.country() ?? "SE"), crOn: deps.crOn() });
  function change(fn: (s: BankMockState) => void): BankView {
    const s = state();
    if (s.scenario === "off") throw off();
    fn(s);
    save(s);
    return viewOf(s);
  }
  const hasSession = (s: BankMockState) => s.links.some((l) => l.status !== "stopped");
  let firstReadMs = 1200;

  /** The pretend first read: the four rows, Swedbank's 143 of 180 days, and a live `bank` event. */
  function readSoon(linkId: string) {
    setTimeout(() => {
      const s = load();
      const l = s.links.find((x) => x.linkId === linkId);
      if (!l || l.firstReadDone || l.status !== "connected") return;
      Object.assign(l, { firstReadDone: true, connectedAt: ago(37 * DAY), consentUntil: ahead(143 * DAY - HOUR), lastReadAt: iso(Date.now()), historyFrom: "2026-08-03" });
      if (!s.deposits.some((d) => d.linkId === linkId)) s.deposits.push(...firstRows(linkId));
      save(s);
      deps.publish();
    }, firstReadMs);
  }

  const api: BankApi = {
    async getBank(): Promise<BankView | BankOff> {
      await wait();
      const s = state();
      if (s.scenario === "off") return { on: false };
      return viewOf(s);
    },
    async bankMakeKey(again) {
      await wait();
      return change((s) => {
        if (s.key && !again) return;
        if (again && hasSession(s)) throw conflict(STOP_FIRST);
        s.key = { source: "clipfactory", appId: null, pemReminder: false };
        s.check = null;
      });
    },
    async bankSaveApp(body: BankAppBody) {
      await wait();
      let check: BankAppCheck | null = null;
      const view = change((s) => {
        if (!s.key) throw conflict("Tap Make my bank key first.");
        let appId: string | undefined;
        if ("pem" in body) {
          if (hasSession(s)) throw conflict(STOP_FIRST);
          if (body.pem.length > 8192 || !/-----BEGIN PRIVATE KEY-----/.test(body.pem)) throw bad("That isn't Enable Banking's key file. It ends in .pem and starts with BEGIN PRIVATE KEY.");
          appId = PEM_FILE.exec(body.fileName ?? "")?.[1] ?? body.appId;
          if (!appId) throw bad("Paste the app ID too.");
          if (!UUID.test(appId)) throw bad("Your app ID has 36 letters and numbers with dashes.");
          s.key = { source: "file", appId: appId.toLowerCase(), pemReminder: true };
        } else {
          appId = body.appId;
          if (!UUID.test(appId)) throw bad("Your app ID has 36 letters and numbers with dashes.");
          if (hasSession(s) && s.key.appId && s.key.appId !== appId.toLowerCase()) throw conflict(STOP_FIRST);
          s.key.appId = appId.toLowerCase();
        }
        // The pretend Enable Banking knows any app ID; it is active only once he linked his accounts.
        const code: BankAppCode = s.check?.code === "ok" ? "ok" : "not_active";
        s.check = { code, at: new Date().toISOString() };
        check = { code, text: CHECK_TEXT[code], at: s.check.at };
      });
      return { view, check: check! };
    },
    async bankCheckApp() {
      await wait();
      let check: BankAppCheck | null = null;
      const view = change((s) => {
        if (!s.key?.appId) throw conflict("Do the steps above first.");
        s.check = { code: "ok", at: new Date().toISOString() };
        check = { code: "ok", text: CHECK_TEXT.ok, at: s.check.at };
      });
      return { view, check: check! };
    },
    async bankStep(step: BankTickId, done: boolean) {
      await wait();
      return change((s) => {
        if (!["bank-ask", "bank-account", "bank-app", "bank-details", "pem-deleted"].includes(step)) throw bad("Clip Factory ticks that one itself.");
        if (step === "pem-deleted") {
          if (s.key) s.key.pemReminder = !done;
          return;
        }
        s.stepsDone = done ? [...new Set([...s.stepsDone, step])] : s.stepsDone.filter((x) => x !== step);
      });
    },
    async bankBanks() {
      await wait();
      const s = state();
      if (s.scenario === "off") throw off();
      const country = s.noCountry ? null : (deps.country() ?? "SE");
      if (!country) throw bankRefusal(409, "no_country", "Pick your country in Money settings first.");
      if (s.countryNotLinked) throw bankRefusal(409, "country_not_linked", `Enable Banking's app has no account from ${countryName(country)} yet. Link one in step 6 first.`);
      return { country, banks: MOCK_BANKS.map((b) => ({ ...b })) };
    },
    async bankConnect(body) {
      await wait();
      let url = "";
      change((s) => {
        if (!s.key?.appId) throw conflict("Do the steps above first.");
        if (s.check?.code !== "ok") throw conflict(CHECK_TEXT[s.check?.code ?? "not_active"]);
        const st = rid(16);
        if ("linkId" in body) {
          const l = s.links.find((x) => x.linkId === body.linkId);
          if (!l) throw new ApiError(404, "not_found", "That bank link no longer exists.");
          s.pending = { state: st, bank: l.bank, linkId: l.linkId, reconnect: true, maxDays: 180 };
        } else {
          const b = MOCK_BANKS.find((x) => x.name === body.bank);
          if (!b) throw bad("Pick a bank from the list.");
          const live = s.links.filter((l) => l.status !== "stopped");
          const again = s.links.find((l) => l.bank === b.name);
          if (!again && live.length >= 4) throw conflict("You can add up to 4 banks.");
          s.pending = { state: st, bank: b.name, linkId: again?.linkId ?? rid(12), reconnect: !!again, maxDays: b.maxDays };
        }
        url = `${MOCK_BANK_PATH}?state=${st}`;
      });
      return { authorizeUrl: url, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    },
    async bankCheckNow(first) {
      await wait();
      const s = state();
      if (s.scenario === "off") throw off();
      const live = s.links.filter((l) => l.status === "connected");
      if (!live.length) throw conflict("Connect your bank first.");
      const waiting = live.find((l) => !l.firstReadDone);
      if (first && waiting) {
        readSoon(waiting.linkId);
        return viewOf(s);
      }
      if (s.lastManualAt && Date.now() - Date.parse(s.lastManualAt) < 15 * 60_000)
        throw bankRefusal(429, "rate_limited", "Clip Factory checked a moment ago.", new Date(Date.parse(s.lastManualAt) + 15 * 60_000).toISOString());
      s.lastManualAt = new Date().toISOString();
      for (const l of live) Object.assign(l, { lastReadAt: s.lastManualAt, failingSince: undefined, lastError: undefined });
      save(s);
      setTimeout(() => deps.publish(), 300);
      return viewOf(s);
    },
    async bankAnswer(depositId, answer: BankAnswer) {
      await wait();
      return change((s) => {
        const d = s.deposits.find((x) => x.depositId === depositId);
        if (!d || d.state === "not_income") throw notFound();
        const needs = d.state === "needs_you";
        const place = answer.answer === "yes" ? d.suggested : answer.answer === "place" ? answer.place : null;
        switch (answer.answer) {
          case "yes":
          case "place":
            if (!needs || (answer.answer === "yes" && !d.suggested)) throw conflict("That one is answered already.");
            if (!place || !(["youtube", "tiktok", "instagram", "facebook", "meta", "x", "contentrewards"] as BankPlace[]).includes(place)) throw bad("Pick a place from the list.");
            if (place === "contentrewards" && !deps.crOn()) throw bad("Pick a place from the list.");
            Object.assign(d, { state: "matched", place, how: "you", notSure: false });
            return;
          case "own_move":
            if (!needs || d.kind !== "own_move") throw conflict("That one is answered already.");
            d.state = "not_income";
            return;
          case "not_sure":
            if (!needs) throw conflict("That one is answered already.");
            d.notSure = true;
            return;
          case "not_income":
            if (!needs) throw conflict("That one is answered already.");
            d.state = "not_income";
            return;
          case "not_this":
            if (d.state !== "matched") throw conflict("That one is answered already.");
            Object.assign(d, { state: "needs_you", was: { place: d.place!, how: d.how! }, place: undefined, how: undefined, payoutDate: undefined, suggested: null, kind: "place", notSure: false });
            return;
          default:
            throw bad("That answer isn't known.");
        }
      });
    },
    async bankStopLink(linkId) {
      await wait();
      change((s) => {
        const l = s.links.find((x) => x.linkId === linkId);
        if (!l) throw new ApiError(404, "not_found", "That bank link no longer exists.");
        Object.assign(l, { status: "stopped", stoppedAt: new Date().toISOString() });
      });
    },
    async bankForget() {
      await wait();
      change((s) => {
        s.deposits = [];
        s.links = [];
        s.learned = [];
        s.lastConnect = undefined;
      });
    },
  };

  /** The pretend bank page's Allow or Cancel: the link is written like the callback writes it, then /bank-done. */
  function authorize(st: string | null, allow: boolean): string {
    const s = load();
    const p = s.pending;
    if (!p || p.state !== st) return "/bank-done?result=bank_expired";
    s.pending = undefined;
    const at = new Date().toISOString();
    if (!allow) {
      s.lastConnect = { result: "bank_denied", linkId: p.linkId, bank: p.bank, reconnect: p.reconnect, at };
      save(s);
      return "/bank-done?result=bank_denied";
    }
    const l = s.links.find((x) => x.linkId === p.linkId);
    const fresh: MockLink = { linkId: p.linkId, bank: p.bank, status: "connected", connectedAt: at, consentUntil: iso(Date.now() + Math.min(p.maxDays, 180) * DAY - 10 * 60_000), firstReadDone: false, accounts: 2 };
    if (l) Object.assign(l, { ...fresh, firstReadDone: l.firstReadDone, historyFrom: l.historyFrom, lastReadAt: l.lastReadAt, reason: undefined, failingSince: undefined, lastError: undefined, endedAt: undefined, stoppedAt: undefined });
    else s.links.push(fresh);
    s.lastConnect = { result: "bank_connected", linkId: p.linkId, bank: p.bank, reconnect: p.reconnect, at };
    save(s);
    deps.publish();
    return "/bank-done?result=bank_connected";
  }

  const controls = {
    scenario: (name: BankScenario) => save(bankScenario(name)),
    state: () => load(),
    set: (patch: Partial<BankMockState>) => save({ ...load(), ...patch }),
    reset: () => save(blank()),
    /** The bank's list says "Pick your country first" (no_country) or that no account of his country is linked. */
    noCountry: (on: boolean) => save({ ...load(), noCountry: on }),
    countryNotLinked: (on: boolean) => save({ ...load(), countryNotLinked: on }),
    /** How long the pretend first read takes. */
    firstReadMs: (ms: number) => {
      firstReadMs = ms;
    },
    /** A pretend read that found a new question (live news reaches the page by itself). */
    newAsk: (hint: "paypal" | "google" = "paypal") => {
      const s = load();
      const linkId = s.links[0]?.linkId ?? "a1b2c3d4e5f6";
      s.deposits.push({ depositId: `d0${hint}${rid(24)}`, date: "2026-11-20", amountMicros: 150_000_000, currency: "SEK", linkId, state: "needs_you", suggested: hint === "google" ? "youtube" : null, kind: "place", hint });
      save(s);
      deps.publish();
    },
  };

  const made = { api, authorize, controls, view: () => viewOf(load()) };
  latest = made;
  return made;
}

let latest: ReturnType<typeof bankMockApi> | null = null;

/** The pretend bank page's answer (screens/getpaid/bank/BankDone.tsx, mock builds only): where to go next. */
export function mockBankAuthorize(state: string | null, allow: boolean): string {
  return latest ? latest.authorize(state, allow) : "/bank-done?result=bank_error";
}

/** The bank the pretend page is for ("Swedbank"), or null when no connect is waiting. */
export function mockBankPending(): string | null {
  return load().pending?.bank ?? null;
}
