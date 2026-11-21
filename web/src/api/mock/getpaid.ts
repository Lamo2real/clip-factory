// The Get paid routes of docs/CONTRACTS.md §40.7 in memory, for the pretend app only (npm run dev:mock, Playwright).
// The statuses follow §40.2's table in its order (on hold › not allowed yet › can get paid ✓ › not set up from a
// signal › checking › not set up yet › you said it's done › can't check › not started), from the pretend owner's
// ticks and the pretend signals below. Tests and screenshots pick a start with window.__cfMock.getpaid.scenario(name)
// (kept in sessionStorage, so a reload or the trip through Allow payment reading keeps it). The amounts are fixtures
// for the pretend app only: the real app shows only what Google or Whop reported. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { Account, CrConnection, GetPaid, GetPaidCard, GetPaidNext, GetPaidPlace, GetPaidStatus, KnownBy, MoneyPlaceId, PayConn, PayoutRow, Platform, SentLine } from "../types.ts";
import { GETPAID_GUIDES, numberedSteps, stepNumber } from "../../getpaid/index.ts";
import type { GetPaidStep } from "../../getpaid/types.ts";
import { usd } from "../../lib/contentRewards.ts";
import { crPart } from "../../setup/contentrewards.ts";

/** §38.7's once-steps for his Finance answer (the ring counts these; the each-time steps never). */
function crOnceSteps(finance: boolean | undefined) {
  if (finance === undefined) return [];
  const want = finance ? "yes" : "no";
  return [...crPart("move").steps, ...crPart("bank").steps].filter((x) => x.repeat === "once" && (x.finance === want || x.finance === "both"));
}

export type GetPaidApi = Pick<
  import("../types.ts").Api,
  "getPaid" | "getPaidPlace" | "setGetPaidStep" | "stopPaymentReading" | "saveWhopKey" | "connectWhop" | "stopWhop"
>;

const KEY = "cf-mock-getpaid";
const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];
const NAMES: Record<GetPaidPlace, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X", contentrewards: "Content Rewards" };
const HOOKS = "https://hooks.clipfactory.example";
const STRIPE = "https://connect.stripe.com/express_login";
const HOUR = 3_600_000;

/** YouTube's §25 state (MONEYSTATE#youtube) as the pretend app holds it. */
export type YoutubeProgram = "none" | "not_yet" | "goal_reached" | "in_program" | "earning";

/** One pretend AdSense payment Google sent (PAYOUT#youtube#…): Google's own words and what Clip Factory read of them. */
interface MockPayment {
  date: string;
  text: string;
  amountMicros: number | null;
  currency: string | null;
  gone?: boolean;
}
interface MockWhopPayout {
  date: string;
  state: PayoutRow["state"];
  amountMicros: number;
  currency: string;
  arriveBy?: string;
}

export interface GetPaidSaved {
  ticks: string[];
  youtube: YoutubeProgram;
  adsense: {
    status: PayConn["status"];
    connectedAt?: string;
    firstReadDone?: boolean;
    lastCheckedAt?: string;
    lastError?: string;
    reason?: PayConn["reason"];
    state?: "READY" | "NEEDS_ATTENTION" | "CLOSED";
    hold?: boolean;
    unpaidText?: string;
  };
  payments: MockPayment[];
  whopOn: boolean;
  whop: {
    status: PayConn["status"];
    keyHint?: string;
    accountName?: string;
    connectedAt?: string;
    firstReadDone?: boolean;
    lastCheckedAt?: string;
    kyc?: "not_started" | "pending" | "approved" | "rejected";
    methods?: "none" | "ready" | "broken";
    businesses?: boolean;
    reason?: PayConn["reason"];
  };
  whopPayouts: MockWhopPayout[];
  followers: { tiktok: number | null; instagram: number | null; facebook: number | null; xVerified: number | null; xPremium: boolean | null };
  /** The next Allow payment reading or Connect Whop comes back with this result (tests). */
  nextResult?: string;
}

export const GETPAID_SCENARIOS = ["fresh", "owner", "hold", "checking", "not_yet", "all_done", "unread"] as const;
export type GetPaidScenario = (typeof GETPAID_SCENARIOS)[number];

function blank(): GetPaidSaved {
  return {
    ticks: [],
    youtube: "none",
    adsense: { status: "not_connected" },
    payments: [],
    whopOn: false,
    whop: { status: "not_connected" },
    whopPayouts: [],
    followers: { tiktok: 2310, instagram: 312, facebook: 1040, xVerified: 120, xPremium: null },
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const PAID = [
  { date: "2026-10-23", text: "kr 1 234,56 SEK", amountMicros: 1_234_560_000, currency: "SEK" },
  { date: "2026-09-22", text: "kr 1 233,44 SEK", amountMicros: 1_233_440_000, currency: "SEK" },
];

/** The pretend owner at each start. */
export function scenarioState(name: GetPaidScenario): GetPaidSaved {
  const s = blank();
  switch (name) {
    case "owner":
      // In the Partner Program, payment reading on, Google paid twice; Instagram's Gifts on; Content Rewards linked.
      s.youtube = "in_program";
      s.adsense = { status: "connected", connectedAt: ago(40 * 24 * HOUR), firstReadDone: true, lastCheckedAt: ago(2 * HOUR), state: "READY", unpaidText: "SEK 512.30" };
      s.payments = PAID.map((p) => ({ ...p }));
      s.ticks = ["ig-gifts"];
      return s;
    case "hold":
      s.youtube = "in_program";
      s.adsense = { status: "connected", connectedAt: ago(40 * 24 * HOUR), firstReadDone: true, lastCheckedAt: ago(2 * HOUR), state: "READY", hold: true, unpaidText: "SEK 512.30" };
      s.payments = PAID.map((p) => ({ ...p }));
      return s;
    case "checking":
      s.youtube = "in_program";
      s.adsense = { status: "connected", connectedAt: ago(HOUR), firstReadDone: false };
      s.ticks = ["yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin"];
      return s;
    case "not_yet":
      s.youtube = "not_yet";
      return s;
    case "all_done":
      s.youtube = "in_program";
      s.ticks = ["yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin", "tt-gifts", "tt-payout", "ig-gifts", "meta-payout", "fb-join", "x-premium", "x-apply", "x-stripe"];
      return s;
    case "unread":
      // Google wrote its amounts in a way Clip Factory can't tell the money type of: shown, never added up.
      s.youtube = "in_program";
      s.adsense = { status: "connected", connectedAt: ago(40 * 24 * HOUR), firstReadDone: true, lastCheckedAt: ago(2 * HOUR), state: "READY" };
      s.payments = [
        { date: "2026-10-23", text: "1 234,56 kr", amountMicros: null, currency: null },
        { date: "2026-09-22", text: "1 233,44 kr", amountMicros: null, currency: null },
        { date: "2026-08-21", text: "1 101,20 kr", amountMicros: null, currency: null },
      ];
      return s;
    default:
      return s;
  }
}

function load(): GetPaidSaved {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<GetPaidSaved> | null;
    if (raw && Array.isArray(raw.ticks)) return { ...blank(), ...raw, followers: { ...blank().followers, ...(raw.followers ?? {}) } } as GetPaidSaved;
  } catch {
    /* no storage: a fresh start */
  }
  return blank();
}
function save(s: GetPaidSaved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: this page only */
  }
}

/** "23 Oct" */
const short = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "A, B and C" */
const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

export interface GetPaidMockDeps {
  accounts: () => Account[];
  country: () => string | null;
  setCountry: (c: string) => void;
  connect: (platforms: Platform[]) => void;
  cr: () => { on: boolean; conn: CrConnection | null; moneyAboveZero: boolean; readyCents: number | null };
  publish: () => void;
}

/** What the pretend app knows for one view (the server's view.load). */
interface Inputs {
  s: GetPaidSaved;
  connected: (p: Platform) => boolean;
  country: string | null;
  cr: ReturnType<GetPaidMockDeps["cr"]>;
  now: number;
}

const fresh = (conn: { status: string; firstReadDone?: boolean; lastCheckedAt?: string }, now: number) =>
  conn.status === "connected" && !!conn.firstReadDone && !!conn.lastCheckedAt && now - Date.parse(conn.lastCheckedAt) <= 48 * HOUR;
const isChecking = (conn: { status: string; firstReadDone?: boolean; connectedAt?: string; lastError?: string }, now: number) =>
  conn.status === "connected" && !conn.firstReadDone && !!conn.connectedAt && now - Date.parse(conn.connectedAt) < 26 * HOUR && !conn.lastError;

function sentPayments(s: GetPaidSaved): MockPayment[] {
  return s.payments.filter((p) => !p.gone);
}

/** The steps of one place with their done state (ticks or autos), in the guide's order. */
function stepsOf(place: Platform, i: Inputs): GetPaidCard["steps"] {
  const s = i.s;
  const sent = sentPayments(s)[0];
  return GETPAID_GUIDES[place].steps.map((st) => {
    let auto: string | undefined;
    if (st.auto === "in_program" && (s.youtube === "in_program" || s.youtube === "earning")) auto = "YouTube says you're in";
    if (st.auto === "payment_reading" && s.adsense.status === "connected") auto = "Clip Factory can see payments";
    if (st.auto === "sent" && sent) auto = `Google sent you money on ${short(sent.date)}, so this is done`;
    if (st.auto === "premium" && s.followers.xPremium === true) auto = "X says you have Premium";
    if (auto) return { id: st.id, done: true, by: "auto" as const, auto };
    const ticked = s.ticks.includes(st.id);
    return { id: st.id, done: ticked, by: ticked ? ("you" as const) : null };
  });
}

function stepNext(guide: (typeof GETPAID_GUIDES)[Platform], step: GetPaidStep): GetPaidNext {
  const n = stepNumber(guide, step.id);
  return {
    stepId: step.id,
    label: step.action === "allow_payment_reading" ? "Allow payment reading" : (step.open?.label ?? step.title),
    href: `#step-${step.id}`,
    external: false,
    text: `Next: step ${n}, ${step.title}.`,
    vermilion: !step.paid,
  };
}

function sentLine(place: GetPaidPlace, i: Inputs): SentLine {
  const s = i.s;
  if (place === "youtube") {
    if (s.adsense.status !== "connected")
      return {
        state: "needs_reading",
        headline: "Clip Factory can't see YouTube payments yet.",
        amounts: [],
        button: { label: "Allow payment reading", href: "/settings/posting/getpaid/youtube#yt-reading", external: false },
      };
    if (isChecking(s.adsense, i.now)) return { state: "checking", headline: "Checking YouTube payments…", amounts: [] };
    const rows = sentPayments(s);
    if (!rows.length) return { state: "none_yet", headline: "Nothing sent to your bank yet.", amounts: [], tag: "YouTube says" };
    const read = rows.filter((r) => r.amountMicros !== null && r.currency);
    const unread = rows.length - read.length;
    const totals = new Map<string, number>();
    for (const r of read) totals.set(r.currency!, (totals.get(r.currency!) ?? 0) + r.amountMicros!);
    const last = rows[0]!;
    return {
      state: "number",
      headline: "Sent to your bank by Google",
      amounts: [...totals].map(([currency, amountMicros]) => ({ currency, amountMicros })),
      tag: "YouTube says",
      arrive: "Your bank gets it up to 7 workdays after Google sends it.",
      ...(unread
        ? {
            notAdded: read.length
              ? `${unread === 1 ? "1 payment isn't" : `${unread} payments aren't`} added up: Clip Factory couldn't tell ${unread === 1 ? "its" : "their"} money type.`
              : `Google sent ${unread} payments. Clip Factory couldn't tell their money type, so they aren't added up.`,
            button: read.length ? undefined : { label: "See them", href: "/settings/posting/getpaid/youtube", external: false },
          }
        : {}),
      last: { date: last.date, amountMicros: last.amountMicros, currency: last.currency, ...(last.amountMicros === null ? { text: last.text } : {}) },
    };
  }
  if (place === "contentrewards") {
    const conn = s.whop;
    const rows = s.whopPayouts;
    if (!s.whopOn || conn.status !== "connected")
      return {
        state: "not_available",
        headline: "Sent to your bank: not available from Content Rewards. Look on Whop: **Balances**.",
        amounts: [],
        ...(s.whopOn ? { button: { label: "Connect Whop", href: "/settings/posting/getpaid/contentrewards#whop", external: false } } : {}),
      };
    const sent = rows.filter((r) => r.state === "sent");
    if (!sent.length) return { state: "none_yet", headline: "Nothing sent to your bank yet.", amounts: [], tag: "Whop says", note: "Whop counts all your Whop money, not only Content Rewards." };
    const totals = new Map<string, number>();
    for (const r of sent) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMicros);
    const last = sent[0]!;
    return {
      state: "number",
      headline: "Sent to your bank by Whop",
      amounts: [...totals].map(([currency, amountMicros]) => ({ currency, amountMicros })),
      tag: "Whop says",
      note: "Whop counts all your Whop money, not only Content Rewards.",
      arrive: last.arriveBy ? `Whop says it should arrive by ${short(last.arriveBy)}.` : "Whop says it should arrive within 5 workdays.",
      last: { date: last.date, amountMicros: last.amountMicros, currency: last.currency },
    };
  }
  const where: Record<Exclude<GetPaidPlace, "youtube" | "contentrewards">, SentLine> = {
    tiktok: { state: "not_available", headline: "Not available from TikTok", amounts: [], where: { text: "Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal." } },
    instagram: {
      state: "not_available",
      headline: "Not available from Instagram",
      amounts: [],
      where: { text: "Look in Instagram: Professional dashboard, then Payouts. Meta also emails you each month." },
    },
    facebook: {
      state: "not_available",
      headline: "Not available from Meta",
      amounts: [],
      where: { text: "Look in Meta Business Suite: All tools, then Payouts. Meta also emails you each month." },
    },
    x: { state: "not_available", headline: "Not available from X", amounts: [], where: { text: "Look in Stripe: Payouts.", button: { label: "Open Stripe", url: STRIPE } } },
  };
  return where[place];
}

/** "Not available from TikTok. Look in TikTok: …" as All your money's one small line says it. */
export function sentLineFor(place: GetPaidPlace, s: GetPaidSaved, deps: Pick<GetPaidMockDeps, "accounts" | "country" | "cr">): SentLine {
  return sentLine(place, inputs(s, deps));
}

function inputs(s: GetPaidSaved, deps: Pick<GetPaidMockDeps, "accounts" | "country" | "cr">): Inputs {
  const accounts = deps.accounts();
  return {
    s,
    connected: (p) => accounts.some((a) => a.platform === p && (a.status === "connected" || a.status === "needs_reconnect")),
    country: deps.country(),
    cr: deps.cr(),
    now: Date.now(),
  };
}

interface Shape {
  status: GetPaidStatus;
  pill: string;
  tone: GetPaidCard["tone"];
  knownBy: KnownBy;
  known: string;
  line: string;
  next: GetPaidNext | null;
  holds?: string[];
  missing?: string[];
}

/** One platform's card (§40.2), first row that applies wins. */
function platformCard(place: Platform, i: Inputs): GetPaidCard {
  const s = i.s;
  const guide = GETPAID_GUIDES[place];
  const name = NAMES[place];
  const steps = stepsOf(place, i);
  const done = (id: string) => steps.find((x) => x.id === id)?.done ?? false;
  const numbered = numberedSteps(guide);
  const earn = numbered.filter((x) => x.role === "earn");
  const payout = numbered.filter((x) => x.role === "payout");
  const firstNotDone = numbered.find((x) => !done(x.id));
  const ring = { done: numbered.filter((x) => done(x.id)).length, total: numbered.length };
  const ticked = steps.some((x) => x.by === "you");
  const yt = place === "youtube";
  const ytFresh = yt && fresh(s.adsense, i.now);
  const sent = yt ? sentPayments(s)[0] : undefined;
  const sentDate = sent ? short(sent.date) : "";
  const canEarnSignal = yt && (s.youtube === "in_program" || s.youtube === "earning");
  const canEarn = canEarnSignal || earn.every((x) => done(x.id));
  const allDone = numbered.every((x) => done(x.id));
  const nextStep = firstNotDone ? stepNext(guide, firstNotDone) : null;
  const firstPayoutNotDone = payout.find((x) => !done(x.id));

  let shape: Shape;
  // 1. On hold (a fresh signal only).
  if (ytFresh && s.adsense.hold)
    shape = {
      status: "on_hold",
      pill: "Payment on hold (YouTube says)",
      tone: "error",
      knownBy: "youtube",
      known: "YouTube says",
      line: "Google is holding your money. Tap Open AdSense for YouTube to see why.",
      holds: ["Your payments are on hold. Check the Payments page for details."],
      next: firstPayoutNotDone
        ? stepNext(guide, firstPayoutNotDone)
        : { stepId: null, label: "Open AdSense for YouTube", href: "https://adsense.google.com/", external: true, hint: "Look for the red message on **Payments**. Do what it says.", vermilion: true },
    };
  // 2. Not allowed yet: YouTube's own answer, or a published rule with no tick on the step it gates.
  else if (yt && (s.youtube === "not_yet" || s.youtube === "goal_reached"))
    shape =
      s.youtube === "goal_reached"
        ? { status: "not_allowed", pill: "Not allowed yet (YouTube says)", tone: "neutral", knownBy: "youtube", known: "YouTube says", line: "You reached YouTube's goals. Apply in YouTube Studio. YouTube checks it.", next: stepNext(guide, guide.steps[0]!) }
        : { status: "not_allowed", pill: "Not allowed yet (YouTube says)", tone: "neutral", knownBy: "youtube", known: "YouTube says", line: "YouTube needs 1,000 subscribers. YouTube says you have 812. Clip Factory tells you when you get there.", next: null };
  else if (place === "instagram" && i.connected("instagram") && (s.followers.instagram ?? 500) < 500 && !done("ig-gifts"))
    shape = {
      status: "not_allowed",
      pill: "Not allowed yet (Instagram's rules)",
      tone: "neutral",
      knownBy: "rules",
      known: "Instagram's rules",
      line: `Gifts needs 500 followers. Instagram says you have ${s.followers.instagram}. Clip Factory tells you when you get there.`,
      next: null,
    };
  else if (place === "x" && i.connected("x") && (s.followers.xVerified ?? 500) < 500 && !done("x-apply"))
    shape = {
      status: "not_allowed",
      pill: "Not allowed yet (X's rules)",
      tone: "neutral",
      knownBy: "rules",
      known: "X's rules",
      line: `Original Content Rewards needs 500 verified followers. X says you have ${s.followers.xVerified}. Clip Factory tells you when you get there.`,
      next: null,
    };
  // 3. Can get paid ✓: fresh, every account READY, no hold, and a sent payment.
  else if (ytFresh && s.adsense.state === "READY" && !s.adsense.hold && sent)
    shape = { status: "can_get_paid", pill: "Can get paid ✓ (YouTube says)", tone: "success", knownBy: "youtube", known: "YouTube says", line: `YouTube says there's no hold. Google sent you money on ${sentDate}.`, next: null };
  // 4. Not set up, from a signal.
  else if (ytFresh && s.adsense.state === "NEEDS_ATTENTION")
    shape = {
      status: "not_set_up",
      pill: "Not set up (YouTube says)",
      tone: "error",
      knownBy: "youtube",
      known: "YouTube says",
      line: "YouTube says your AdSense for YouTube needs you. Open it and do what it asks.",
      next: firstPayoutNotDone
        ? stepNext(guide, firstPayoutNotDone)
        : { stepId: null, label: "Open AdSense for YouTube", href: "https://adsense.google.com/", external: true, hint: "Look for the red message on **Payments**. Do what it says.", vermilion: true },
    };
  else if (ytFresh && s.adsense.state === "CLOSED")
    shape = {
      status: "not_set_up",
      pill: "Not set up (YouTube says)",
      tone: "error",
      knownBy: "youtube",
      known: "YouTube says",
      line: "YouTube says your AdSense for YouTube is closed. Make a new one from YouTube Studio.",
      next: { stepId: null, label: "Open YouTube Studio", href: "https://studio.youtube.com/", external: true, hint: "Make a new AdSense for YouTube from **Earn**.", vermilion: true },
    };
  // 5. Checking: payment reading just connected, its first read not finished.
  else if (yt && isChecking(s.adsense, i.now))
    shape = { status: "checking", pill: "Checking…", tone: "neutral", knownBy: "clipfactory", known: "Clip Factory", line: "Checking YouTube payments… This can take until tomorrow.", next: nextStep };
  // 6. Not set up yet (his ticks): he can earn, and a payout step isn't done.
  else if (canEarn && firstPayoutNotDone) {
    const n = stepNext(guide, firstPayoutNotDone);
    shape = {
      status: "not_set_up",
      pill: "Not set up yet",
      tone: "warn",
      knownBy: "you",
      known: "Your steps",
      line: `You can earn here. Do the payout steps so money can reach you. ${n.text}${firstPayoutNotDone.when ? ` ${firstPayoutNotDone.when}` : ""}`,
      next: nextStep,
    };
  }
  // 7. Can get paid (you said it's done).
  else if (allDone) {
    const sentTicked = yt && !!sent && !ytFresh;
    shape = {
      status: "you_said_done",
      pill: sentTicked ? `Can get paid (Google sent money on ${sentDate})` : "Can get paid (you said it's done)",
      tone: "success",
      knownBy: sentTicked ? "youtube" : "you",
      known: sentTicked ? "YouTube says" : "You said it's done",
      line: sentTicked
        ? `Google sent you money on ${sentDate}. ${s.adsense.lastCheckedAt ? `Clip Factory last checked YouTube payments on ${short(s.adsense.lastCheckedAt)}.` : "Clip Factory can't see YouTube payments now."}`
        : ytFresh && !s.adsense.hold
          ? "You said every step is done. YouTube says there's no hold. Clip Factory knows for sure after Google's first payment."
          : `You said every step is done. ${name === "Instagram" || name === "Facebook" ? "Meta" : name} doesn't tell Clip Factory, so it can't check.`,
      next: s.adsense.status === "needs_reconnect" && yt ? { stepId: null, label: "Allow payment reading", href: "#yt-reading", external: false, vermilion: true } : null,
    };
  }
  // 8. Clip Factory can't check: not connected, nothing ticked, no payment reading.
  else if (!i.connected(place) && !ticked && !(yt && s.adsense.status !== "not_connected"))
    shape = { status: "not_connected", pill: "Clip Factory can't check", tone: "neutral", knownBy: "clipfactory", known: "Clip Factory", line: `Clip Factory can't check anything for ${name}. You can still do the steps.`, next: nextStep };
  // 9. Not started.
  else {
    const onlyPayout = payout.some((x) => done(x.id)) && !earn.some((x) => done(x.id));
    const who = place === "instagram" || place === "facebook" ? "Meta" : name;
    const tiktokClosed = place === "tiktok" && i.country !== null && !["US", "GB", "DE", "FR", "BR"].includes(i.country) && !done("tt-gifts");
    shape = {
      status: "not_started",
      pill: "Not started",
      tone: "neutral",
      knownBy: tiktokClosed ? "rules" : "you",
      known: tiktokClosed ? "TikTok's rules for Sweden" : "Your steps",
      line: tiktokClosed
        ? `Creator Rewards isn't open in Sweden. Gifts might be. ${nextStep?.text ?? ""}`.trim()
        : onlyPayout && nextStep
          ? `You said ${who} knows where to pay you. ${nextStep.text}`
          : `Do the steps so ${name} can pay you. Already did them? Tap I did this on each step.`,
      next: nextStep,
    };
  }
  return {
    place,
    name,
    ...shape,
    holds: shape.holds ?? [],
    missing: shape.missing ?? [],
    ...(place === "x" ? { warning: "X doesn't pay for posts an app made or posted, or clips copied from other sites. Your Clip Factory clips probably won't earn on X." } : {}),
    ...(yt ? { readingChip: `Clip Factory can see payments: ${s.adsense.status === "connected" ? "on" : "off"}` } : {}),
    steps,
    ring,
    seen: seenLines(place, i),
    sent: sentLine(place, i),
    ...(yt && ytFresh && s.adsense.unpaidText ? { unpaid: { text: s.adsense.unpaidText, note: "Google pays between the 21st and 26th when you have kr 700 or more." } } : {}),
    ...(yt && s.adsense.lastCheckedAt ? { checkedAt: s.adsense.lastCheckedAt } : {}),
  };
}

function seenLines(place: GetPaidPlace, i: Inputs): string[] {
  const s = i.s;
  const f = s.followers;
  if (place === "youtube") {
    const out: string[] = [];
    if (s.youtube === "in_program" || s.youtube === "earning") out.push("YouTube says you're in the Partner Program.");
    else if (s.youtube !== "none") out.push("YouTube says you're not in the Partner Program yet.");
    if (s.adsense.status !== "connected") out.push("Clip Factory can't see YouTube payments yet. Tap Allow payment reading.");
    else if (fresh(s.adsense, i.now)) {
      out.push(s.adsense.state === "NEEDS_ATTENTION" ? "YouTube says your AdSense for YouTube needs you. Open AdSense for YouTube." : s.adsense.state === "CLOSED" ? "YouTube says your AdSense for YouTube is closed." : "YouTube says your AdSense for YouTube is ready.");
      if (!s.adsense.hold) out.push("YouTube says there's no hold on your money.");
      if (s.adsense.unpaidText) out.push(`Waiting to be paid: ${s.adsense.unpaidText} (YouTube says). Google pays when it's kr 700 or more.`);
      const last = sentPayments(s)[0];
      if (last) out.push(`Last money sent: ${last.text} on ${short(last.date)} (YouTube says).`);
    } else if (isChecking(s.adsense, i.now)) {
      /* the status says Checking… */
    } else if (!s.adsense.firstReadDone) out.push("Clip Factory couldn't check YouTube payments yet. It tries again tomorrow.");
    else if (s.adsense.lastCheckedAt) out.push(`Clip Factory last checked YouTube payments on ${short(s.adsense.lastCheckedAt)}.`);
    out.push("YouTube doesn't tell apps about your bank, tax or ID. Tap I did this when they're done.");
    return out.slice(0, 6);
  }
  if (place === "tiktok") return [...(i.connected("tiktok") && f.tiktok !== null ? [`TikTok says you have ${f.tiktok.toLocaleString("en-US")} followers.`] : []), "TikTok doesn't tell apps about Gifts or payouts."];
  if (place === "instagram") return [...(i.connected("instagram") && f.instagram !== null ? [`Instagram says you have ${f.instagram.toLocaleString("en-US")} followers.`] : []), "Meta doesn't tell apps how it pays you."];
  if (place === "facebook") return [...(i.connected("facebook") && f.facebook !== null ? [`Facebook says your Page has ${f.facebook.toLocaleString("en-US")} followers.`] : []), "Meta doesn't tell apps if you joined or how it pays you."];
  if (place === "x")
    return [
      ...(i.connected("x") && f.xPremium === true ? ["X says you have Premium."] : []),
      ...(i.connected("x") && f.xVerified !== null ? [`X says you have ${f.xVerified.toLocaleString("en-US")} verified followers.`] : []),
      "X doesn't tell apps if you're in Original Content Rewards or set up Stripe.",
    ];
  // Content Rewards
  const out: string[] = [];
  if (i.cr.readyCents !== null && i.cr.readyCents > 0) out.push(`Content Rewards says ${usd(i.cr.readyCents)} is ready to move to Whop.`);
  const w = s.whop;
  if (s.whopOn && w.status === "connected" && fresh(w, i.now)) {
    out.push(w.kyc === "approved" ? "Whop says your ID check is done." : w.kyc === "pending" ? "Whop says your ID check is waiting." : w.kyc === "rejected" ? "Whop says your ID check didn't pass." : "Whop says your ID check isn't started.");
    if (w.methods === "ready") out.push("Whop says a bank is saved.");
    if (w.methods === "broken") out.push("Whop says your bank details don't work.");
    if (w.businesses) out.push("You have a business on Whop. Clip Factory reads only your own Whop money, not the business's.");
  } else if (s.whopOn && w.status === "connected" && w.lastCheckedAt) out.push(`Clip Factory last checked Whop on ${short(w.lastCheckedAt)}.`);
  else out.push("Clip Factory can't see Whop. Connect Whop to see your payouts here.");
  return out.slice(0, 6);
}

/** Content Rewards' card (§40.2): its steps are §38.7's money steps, ticked on CRCONN. */
function crCard(i: Inputs): GetPaidCard {
  const s = i.s;
  const conn = i.cr.conn;
  const finance = conn?.finance;
  const once = crOnceSteps(finance);
  const ticks = conn?.stepsDone ?? [];
  const steps = once.map((x) => ({ id: x.id, done: ticks.includes(x.id), by: ticks.includes(x.id) ? ("you" as const) : null }));
  const done = (id: string) => steps.find((x) => x.id === id)?.done ?? false;
  const firstNotDone = once.find((x) => !done(x.id));
  const linked = done("move-whop") || done("fin-setup");
  const bankStep = finance ? "fin-setup" : "bank-setup";
  const stepN = (id: string) => once.findIndex((x) => x.id === id) + 1;
  const titled = (id: string) => once.find((x) => x.id === id)?.title ?? "";
  const asNext = (id: string): GetPaidNext => ({
    stepId: id,
    label: once.find((x) => x.id === id)?.open?.label ?? titled(id),
    href: `#step-${id}`,
    external: false,
    text: `Next: step ${stepN(id)}, ${titled(id)}.`,
    vermilion: true,
  });
  const nextStep: GetPaidNext | null =
    finance === undefined
      ? { stepId: null, label: "Answer: do you see Finance?", href: "#cr-finance", external: false, vermilion: true }
      : firstNotDone
        ? asNext(firstNotDone.id)
        : null;
  const w = s.whop;
  const whopFresh = s.whopOn && fresh(w, i.now);
  const connected = !!conn && conn.status !== "not_connected";
  const ring = { done: steps.filter((x) => x.done).length, total: Math.max(steps.length, finance === undefined ? 1 : steps.length) };
  let shape: Shape;
  if (whopFresh && w.kyc === "rejected")
    shape = {
      status: "on_hold",
      pill: "Payment on hold (Whop says)",
      tone: "error",
      knownBy: "whop",
      known: "Whop says",
      line: "Whop says your ID check didn't pass.",
      next: { stepId: null, label: "Open Whop", href: "https://whop.com/", external: true, hint: "Tap **Balances**. Do the ID check again.", vermilion: true },
    };
  else if (whopFresh && w.methods === "broken")
    shape = {
      status: "on_hold",
      pill: "Payment on hold (Whop says)",
      tone: "error",
      knownBy: "whop",
      known: "Whop says",
      line: "Whop says your bank details don't work.",
      next: { stepId: null, label: "Open Whop", href: "https://whop.com/", external: true, hint: "Check your bank on **Payout methods**.", vermilion: true },
    };
  else if (whopFresh && w.kyc === "approved" && w.methods === "ready" && linked)
    shape = { status: "can_get_paid", pill: "Can get paid ✓ (Whop says)", tone: "success", knownBy: "whop", known: "Whop says", line: "Whop says your ID check is done and a bank is saved.", next: null };
  else if (whopFresh && (w.methods === "none" || w.kyc === "not_started"))
    shape = {
      status: "not_set_up",
      pill: "Not set up (Whop says)",
      tone: "error",
      knownBy: "whop",
      known: "Whop says",
      line: w.methods === "none" ? `Whop says it has nowhere to send your money. Next: step ${stepN(bankStep) || 1}, ${titled(bankStep) || "Add your bank on Whop"}.` : `Whop says your ID check isn't started. Next: step ${stepN(bankStep) || 1}, ${titled(bankStep) || "Add your bank on Whop"}.`,
      next: once.some((x) => x.id === bankStep) ? asNext(bankStep) : nextStep,
    };
  else if ((s.whopOn && isChecking(w, i.now)) || (whopFresh && w.kyc === "pending"))
    shape = {
      status: "checking",
      pill: whopFresh ? "Checking… (Whop says)" : "Checking…",
      tone: "neutral",
      knownBy: whopFresh ? "whop" : "clipfactory",
      known: whopFresh ? "Whop says" : "Clip Factory",
      line: whopFresh ? "Whop is checking your ID. Nothing to do. It can take a day or two." : "Checking your Whop payouts… This can take until tomorrow.",
      next: nextStep,
    };
  else if (i.cr.moneyAboveZero && (finance === undefined || firstNotDone))
    shape = {
      status: "not_set_up",
      pill: "Not set up yet",
      tone: "warn",
      knownBy: "you",
      known: "Your steps",
      line: `You can earn here. Do the payout steps so money can reach you.${nextStep?.text ? ` ${nextStep.text}` : ""}`,
      next: nextStep,
    };
  else if (finance !== undefined && !firstNotDone)
    shape = { status: "you_said_done", pill: "Can get paid (you said it's done)", tone: "success", knownBy: "you", known: "You said it's done", line: "You said every step is done. Content Rewards doesn't tell Clip Factory, so it can't check.", next: null };
  else if (!connected && !ticks.length)
    shape = { status: "not_connected", pill: "Clip Factory can't check", tone: "neutral", knownBy: "clipfactory", known: "Clip Factory", line: "Clip Factory can't check anything for Content Rewards. You can still do the steps.", next: nextStep };
  else
    shape = { status: "not_started", pill: "Not started", tone: "neutral", knownBy: "you", known: "Your steps", line: "Do the steps so Content Rewards can pay you. Already did them? Tap I did this on each step.", next: nextStep };
  if (!shape.next && s.whopOn && w.status === "needs_reconnect") shape.next = { stepId: null, label: "Connect Whop", href: "#whop", external: false, vermilion: true };
  return {
    place: "contentrewards",
    name: NAMES.contentrewards,
    ...shape,
    holds: shape.holds ?? [],
    missing: shape.missing ?? [],
    ...(s.whopOn ? { readingChip: `Clip Factory can see Whop payouts: ${w.status === "connected" ? "on" : "off"}` } : {}),
    steps,
    ring,
    seen: seenLines("contentrewards", i),
    sent: sentLine("contentrewards", i),
  };
}

function summaryOf(places: GetPaidCard[]): string {
  const out: string[] = [];
  for (const p of places.filter((x) => x.status === "can_get_paid")) out.push(p.place === "contentrewards" ? "Whop says Content Rewards can pay you." : `${p.name} says it can pay you.`);
  const said = places.filter((x) => x.status === "you_said_done");
  if (said.length) {
    const google = said.find((x) => x.place === "youtube" && x.pill.startsWith("Can get paid (Google"));
    const rest = said.filter((x) => x !== google).map((x) => x.name);
    if (google) out.push("Google paid you before.");
    if (rest.length) out.push(`You said ${names(rest)} ${rest.length === 1 ? "is" : "are"} done.`);
  }
  const need = places.filter((x) => x.status === "not_set_up" || x.status === "on_hold").map((x) => x.name);
  if (need.length) out.push(`${names(need)} ${need.length === 1 ? "needs" : "need"} you.`);
  if (!out.length) {
    const start = places.find((x) => x.status === "not_started" || x.status === "not_connected");
    out.push(start ? `Nothing is set up yet. Start with ${start.name}.` : "Nothing to do here yet. Clip Factory tells you when a place opens.");
  }
  return out.join(" ");
}

function conns(s: GetPaidSaved): GetPaid["connections"] {
  const adsense: PayConn = {
    source: "adsense",
    status: s.adsense.status,
    ...(s.adsense.status === "connected" ? { accountName: "Main AdSense (…4821)", connectedAt: s.adsense.connectedAt } : {}),
    ...(s.adsense.reason ? { reason: s.adsense.reason } : {}),
  };
  const whop: PayConn | null = s.whopOn
    ? {
        source: "whop",
        status: s.whop.status,
        redirectUri: `${HOOKS}/oauth/whop/callback`,
        ...(s.whop.keyHint ? { keyHint: s.whop.keyHint } : {}),
        ...(s.whop.accountName ? { accountName: s.whop.accountName } : {}),
        ...(s.whop.connectedAt ? { connectedAt: s.whop.connectedAt } : {}),
        ...(s.whop.reason ? { reason: s.whop.reason } : {}),
      }
    : null;
  return { adsense, whop };
}

export interface GetPaidControls {
  scenario(name: GetPaidScenario): void;
  /** MONEYSTATE#youtube as YouTube would say it. */
  youtube(program: YoutubeProgram): void;
  /** Payment reading's first read finished (with Google's state and a payment, as given). */
  readDone(opts?: { state?: "READY" | "NEEDS_ATTENTION" | "CLOSED"; hold?: boolean; paid?: boolean }): void;
  /** Turn WHOP_CONNECT on or off. */
  whop(on: boolean): void;
  /** Whop's first read finished (ID check, saved methods, payouts). */
  whopRead(opts: { kyc?: GetPaidSaved["whop"]["kyc"]; methods?: GetPaidSaved["whop"]["methods"]; paid?: boolean; businesses?: boolean }): void;
  followers(f: Partial<GetPaidSaved["followers"]>): void;
  /** The next Allow payment reading or Connect Whop comes back with this result. */
  nextResult(code: string): void;
  state(): GetPaidSaved;
  reset(): void;
}

export function getPaidMockApi(wait: () => Promise<void>, deps: GetPaidMockDeps): { api: GetPaidApi; controls: GetPaidControls; sentLines: () => Record<MoneyPlaceId, SentLine>; connectPayments: () => { authorizeUrl: string; expiresAt: string } } {
  const view = (): GetPaid => {
    const s = load();
    const i = inputs(s, deps);
    const places: GetPaidCard[] = ORDER.map((p) => platformCard(p, i));
    if (i.cr.on) places.push(crCard(i));
    return { places, summary: summaryOf(places), country: i.country, connections: conns(s), stepsDone: [...s.ticks], asOf: new Date().toISOString() };
  };
  const changed = (s: GetPaidSaved) => {
    save(s);
    deps.publish();
  };
  const KNOWN = new Set(ORDER.flatMap((p) => GETPAID_GUIDES[p].steps.map((x) => x.id)));
  const CR_IDS = new Set(["move-whop", "fin-setup", "move-withdraw", "bank-setup", "bank-cashout", "fin-bank"]);
  const whopOff = () => new ApiError(503, "unavailable", "Coming soon.");
  const expires = () => new Date(Date.now() + 600_000).toISOString();

  const api: GetPaidApi = {
    async getPaid() {
      await wait();
      return view();
    },
    async getPaidPlace(place) {
      await wait();
      const v = view();
      const card = v.places.find((p) => p.place === place);
      if (!card) throw new ApiError(404, "not_found", "That place isn't in Get paid.");
      const s = load();
      const payouts: PayoutRow[] =
        place === "youtube"
          ? s.payments.map((p) => ({ date: p.date, by: "Google" as const, state: p.gone ? ("gone" as const) : ("sent" as const), amountMicros: p.amountMicros, currency: p.currency, ...(p.amountMicros === null ? { text: p.text } : {}) }))
          : place === "contentrewards" && s.whopOn && s.whop.status === "connected"
            ? s.whopPayouts.map((p) => ({ date: p.date, by: "Whop" as const, state: p.state, amountMicros: p.amountMicros, currency: p.currency, ...(p.arriveBy ? { arriveBy: p.arriveBy } : {}) }))
            : [];
      return { card, payouts };
    },
    async setGetPaidStep(step, done) {
      await wait();
      if (CR_IDS.has(step)) throw new ApiError(400, "bad_request", "Tick Content Rewards steps on its own card.");
      if (!KNOWN.has(step)) throw new ApiError(400, "bad_request", "That step isn't in Get paid.");
      if (step === "yt-reading") throw new ApiError(400, "bad_request", "Tap Allow payment reading instead.");
      const s = load();
      s.ticks = done ? [...new Set([...s.ticks, step])] : s.ticks.filter((x) => x !== step);
      if (s.ticks.length > 80) throw new ApiError(400, "bad_request", "That's too many ticks.");
      changed(s);
      return view();
    },
    async stopPaymentReading() {
      await wait();
      const s = load();
      // The secret goes; PAYSTATE# and every PAYOUT# stay (records of real money), so the sent rows still tick.
      s.adsense = { ...s.adsense, status: "not_connected", firstReadDone: s.adsense.firstReadDone, connectedAt: undefined };
      changed(s);
    },
    async saveWhopKey(clientId) {
      await wait();
      const s = load();
      if (!s.whopOn) throw whopOff();
      if (!/^app_[A-Za-z0-9]{4,64}$/.test(clientId)) throw new ApiError(400, "bad_request", "Your Whop key starts with app_.", "clientId");
      const hint = `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
      const changedKey = s.whop.keyHint && s.whop.keyHint !== hint;
      s.whop = { ...s.whop, status: s.whop.status === "connected" && !changedKey ? "connected" : "keys_saved", keyHint: hint, ...(changedKey && s.whop.status === "connected" ? { reason: "keys_changed" as const } : {}) };
      changed(s);
      return view();
    },
    async connectWhop() {
      await wait();
      const s = load();
      if (!s.whopOn) throw whopOff();
      if (!s.whop.keyHint) throw new ApiError(409, "conflict", "Save your Whop key first.");
      const result = s.nextResult?.startsWith("whop_") ? s.nextResult : "whop_connected";
      delete s.nextResult;
      if (result === "whop_connected") s.whop = { ...s.whop, status: "connected", accountName: "@faze", connectedAt: new Date().toISOString(), firstReadDone: false, reason: undefined };
      changed(s);
      return { authorizeUrl: `/settings/posting/getpaid/contentrewards?result=${result}#whop`, expiresAt: expires() };
    },
    async stopWhop() {
      await wait();
      const s = load();
      if (!s.whopOn) throw whopOff();
      s.whop = { status: s.whop.keyHint ? "keys_saved" : "not_connected", keyHint: s.whop.keyHint };
      changed(s);
    },
  };

  /** POST /v1/accounts/youtube/connect {grant: "payments"}: the pretend Google comes straight back (§40.6). */
  function connectPayments() {
    const s = load();
    const result = s.nextResult?.startsWith("payments_") ? s.nextResult : "payments_allowed";
    delete s.nextResult;
    if (result === "payments_allowed") s.adsense = { status: "connected", connectedAt: new Date().toISOString(), firstReadDone: false };
    changed(s);
    return { authorizeUrl: `/settings/posting/getpaid/youtube?result=${result}`, expiresAt: expires() };
  }

  const controls: GetPaidControls = {
    scenario(name) {
      const s = scenarioState(name);
      if (name === "owner" || name === "hold" || name === "unread") {
        deps.connect(["youtube", "instagram", "facebook", "x", "tiktok"]);
        deps.setCountry("SE");
      }
      changed(s);
    },
    youtube(program) {
      const s = load();
      s.youtube = program;
      changed(s);
    },
    readDone(opts = {}) {
      const s = load();
      s.adsense = { ...s.adsense, status: "connected", connectedAt: s.adsense.connectedAt ?? ago(2 * HOUR), firstReadDone: true, lastCheckedAt: new Date().toISOString(), state: opts.state ?? "READY", hold: !!opts.hold };
      if (opts.paid) s.payments = PAID.map((p) => ({ ...p }));
      changed(s);
    },
    whop(on) {
      const s = load();
      s.whopOn = on;
      changed(s);
    },
    whopRead(opts) {
      const s = load();
      s.whop = { ...s.whop, status: "connected", firstReadDone: true, lastCheckedAt: new Date().toISOString(), kyc: opts.kyc ?? "approved", methods: opts.methods ?? "ready", businesses: !!opts.businesses };
      if (opts.paid) s.whopPayouts = [{ date: "2026-11-12", state: "sent", amountMicros: 210_000_000, currency: "USD", arriveBy: "2026-11-19" }, { date: "2026-11-18", state: "on_its_way", amountMicros: 40_000_000, currency: "USD" }];
      changed(s);
    },
    followers(f) {
      const s = load();
      s.followers = { ...s.followers, ...f };
      changed(s);
    },
    nextResult(code) {
      const s = load();
      s.nextResult = code;
      save(s);
    },
    state: () => load(),
    reset() {
      changed(blank());
    },
  };

  /** Each place's sent line and the block, for All your money while the server's copy (K's) is not in the mock yet. */
  function sentLines(): Record<MoneyPlaceId, SentLine> {
    const s = load();
    const i = inputs(s, deps);
    return Object.fromEntries([...ORDER, "contentrewards" as const].map((p) => [p, sentLine(p, i)])) as Record<MoneyPlaceId, SentLine>;
  }

  return { api, controls, sentLines, connectPayments };
}

/** The "Sent to your bank, so far" block from the places' sent lines (the mock's copy of the server's sums). */
export function sentBlock(lines: Partial<Record<MoneyPlaceId, SentLine>>, order: readonly MoneyPlaceId[]): NonNullable<import("../types.ts").MoneyEverywhere["sent"]> {
  const totals: { currency: string; amountMicros: number; places: MoneyPlaceId[]; names: string }[] = [];
  const notCounted: string[] = [];
  let unread: string | undefined;
  let any = false;
  for (const p of order) {
    const line = lines[p];
    if (!line) continue;
    if (line.state !== "number") {
      if (line.state === "not_available" && p !== "contentrewards") notCounted.push(NAMES[p]);
      continue;
    }
    any = true;
    if (line.notAdded && !line.amounts.length) unread = line.notAdded;
    else if (line.notAdded) unread = line.notAdded;
    for (const a of line.amounts) {
      const name = p === "contentrewards" ? "Whop (all your Whop money, Content Rewards too)" : NAMES[p];
      const t = totals.find((x) => x.currency === a.currency);
      if (t) {
        t.amountMicros += a.amountMicros;
        t.places.push(p);
        t.names = `${t.names} + ${name}`;
      } else totals.push({ currency: a.currency, amountMicros: a.amountMicros, places: [p], names: name });
    }
  }
  return {
    totals,
    tag: "Google and Whop say they sent it.",
    ...(unread ? { notAdded: unread } : {}),
    ...(notCounted.length ? { notCountedText: `Not in this: ${names(notCounted)} (not available).` } : {}),
    bankText: "Clip Factory can't see your bank. Look in your bank's app to see what arrived.",
    ...(any ? {} : { empty: "Nothing sent to your bank yet." }),
  };
}
