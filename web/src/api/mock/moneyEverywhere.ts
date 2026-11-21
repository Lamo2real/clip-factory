// All your money in one place, in the pretend app (docs/CONTRACTS.md §39.2). Mock builds only.
//
// `everywhere` is a line-for-line copy of api/src/clipfactory_api/money/everywhere.py `everywhere`, over the same
// inputs as its golden cases (api/tests/fixtures/money_everywhere_cases.json, checked in web/test/allMoney.test.tsx
// when the file is there), so the mock and the server say the same. Like moneySummary.ts, this mock file is allowed to
// add up reported money (web/test/noGuesses.test.ts): the real app only formats what the server sent.
//
// Get paid (§40.4): `sentLine` and `sentTotals` are line-for-line copies of api/src/clipfactory_api/getpaid/sent.py
// `sent_line` and `sent_totals` (with `parseAmount`, its `parse_amount`), checked through the same golden cases.
import type { MoneyEverywhere, MoneyPlace, MoneyPlaceId, MoneySentBlock, MoneyWhere, Platform, SentLine } from "../types.ts";
import { addDays, ORDER, summarize, todayUtc, type MoneyRow, type MoneyStatus } from "./moneySummary.ts";

const CR = "contentrewards";
const CR_NAME = "Content Rewards";
const PERIOD_DAYS = 30;
const MICROS_PER_CENT = 10_000;
const CR_TAG = "Content Rewards' numbers";
const CR_ROW_TAG = "reached your balance in these 30 days · Content Rewards' numbers";
const NO_MONEY_SHARED = new Set<string>(["instagram", "tiktok", "x"]);
const MONEY_PLATFORMS = new Set<string>(["youtube", "facebook"]);
const SAYS: Record<string, string> = { youtube: "YouTube says", facebook: "Meta says", [CR]: "Content Rewards says" };
const LAG_NOTES: Record<string, string> = { youtube: "YouTube is 2–3 days behind", facebook: "Facebook can take 2 days" };
const STATE_WORDS: Record<string, string> = {
  not_available: "not available",
  coming_soon: "coming soon",
  not_set_up: "not set up",
  needs_ok: "needs your OK",
  waiting: "waiting",
  error: "couldn't check",
  sign_in: "sign in again",
};
const NOT_IN_PROGRAM = new Set(["not_yet", "goal_reached"]);
const MONEY_SETTINGS = "/settings/posting/money";
export const MONETARY_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
const LABEL: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };

/** config/monetization.json `paidWhere` (§25.2), as the server reads it. */
export const PAID_WHERE: Record<Platform, MoneyWhere> = {
  youtube: { label: "AdSense for YouTube › Payments", url: "https://adsense.google.com/" },
  facebook: { label: "Meta Business Suite › Payouts", url: "https://business.facebook.com/latest/monetization" },
  instagram: { label: "Professional dashboard › Payouts" },
  tiktok: { label: "Profile › Balance" },
  x: { label: "X › Creator Studio (paid through Stripe)", url: "https://x.com/i/jf/creators/studio" },
};

/** The golden cases' inputs (everywhere.py's arguments, with plain JSON for the items). */
export interface EverywhereInput {
  today: string;
  facebookVerified: boolean;
  accounts: Partial<Record<Platform, { platform: Platform; status: string; scopes?: string[] } | null>>;
  states: Partial<Record<Platform, { state?: string; lastCheckedAt?: string; lastError?: string | null }>>;
  rows: MoneyRow[];
  crOn: boolean;
  crconn: { status?: string; signInBy?: string } | null;
  crmoney: {
    firstReadDone?: boolean;
    paidByDayDone?: boolean | null;
    paidTotalCents?: number;
    stillEarningCents?: number;
    readyToMoveCents?: number;
    onItsWayCents?: number;
    asOf?: string;
    lastPaidAt?: string;
    paidByDay?: Record<string, number>;
    error?: string;
  } | null;
  /** §40.4: the stored PAYOUT# rows per place (YouTube: Google's own text; Content Rewards: Whop's amounts). */
  payouts?: Partial<Record<MoneyPlaceId, PayoutItem[]>> | null;
  /** §40.4: PAYCONN#adsense and PAYCONN#whop. */
  payconns?: Partial<Record<"adsense" | "whop", PayConnItem>> | null;
  /** §40.4: PAYSTATE#youtube and PAYSTATE#contentrewards. */
  paystates?: Partial<Record<MoneyPlaceId, { firstReadDone?: boolean; lastCheckedAt?: string; lastError?: string | null }>> | null;
  /** WHOP_CONNECT. */
  whopOn?: boolean;
}

/** A stored PAYOUT# row (§40.7), as the golden cases give it. */
export interface PayoutItem {
  sk?: string;
  date?: string;
  amountText?: string;
  state?: string;
  status?: string;
  goneAt?: string;
  amountMicros?: number;
  currency?: string;
  estimatedArrival?: string;
}
/** A stored PAYCONN# item (§40.7). */
export interface PayConnItem {
  status?: string;
  connectedAt?: string;
  stoppedAt?: string;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 16 Nov" for a plain yyyy-mm-dd day. */
function dayWords(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}
const join = (items: string[]) => (items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const setup = (platform: string) => `/settings/posting/setup/${platform}?back=/money`;
const moneyShown = (p: string, verified: boolean) => (p === "facebook" ? verified : p === "youtube");
const tagOf = (p: Platform) => (p === "facebook" || p === "instagram" ? "Meta's estimate" : `${LABEL[p]}'s estimate`);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** The where line: " › " said as ", then "; a place with a `url` names its own product first, with an Open button. */
export function whereLine(name: string, paid: MoneyWhere): NonNullable<MoneyPlace["where"]> {
  const parts = String(paid.label ?? "")
    .split("›")
    .map((p) => p.trim())
    .filter(Boolean);
  const said = parts.join(", then ");
  if (paid.url && parts.length) return { text: `Look in ${said}.`, button: { label: `Open ${parts[0]}`, url: paid.url } };
  return { text: `Look in ${name}: ${said}.` };
}

function place(id: MoneyPlace["place"], name: string, state: MoneyPlace["state"], headline: string, extra: Partial<MoneyPlace> = {}): MoneyPlace {
  const out: MoneyPlace = { place: id, name, state, headline, amounts: [] };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

function amountsOf(rows: MoneyRow[]): MoneyPlace["amounts"] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency.toUpperCase(), (by.get(r.currency.toUpperCase()) ?? 0) + r.amountMicros);
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([currency, amountMicros]) => ({ currency, amountMicros }));
}

function platformPlace(
  p: Platform,
  verified: boolean,
  account: EverywhereInput["accounts"][Platform],
  state: NonNullable<EverywhereInput["states"][Platform]>,
  rows: MoneyRow[],
  behind: string[],
  start: string,
  end: string,
): MoneyPlace {
  const name = LABEL[p];
  if (NO_MONEY_SHARED.has(p))
    return place(p, name, "not_available", `Not available from ${name}`, { why: `${name} doesn't tell apps what you earn.`, where: whereLine(name, PAID_WHERE[p]) });
  if (!moneyShown(p, verified))
    return place(p, name, "coming_soon", "Coming soon", { why: `Clip Factory can't show ${name} money yet.`, where: whereLine(name, PAID_WHERE[p]) });
  if (!account) return place(p, name, "not_set_up", "Not set up yet", { why: `Connect ${name} to see its money.`, button: { label: `Set up ${name}`, href: setup(p), external: false } });
  const checked = typeof state.lastCheckedAt === "string" ? state.lastCheckedAt : undefined;
  if (p === "youtube" && !(account.scopes ?? []).includes(MONETARY_SCOPE))
    return place(p, name, "needs_ok", "YouTube needs your OK", {
      why: "Tap Allow money reading so YouTube shares your money with Clip Factory.",
      button: { label: "Allow money reading", href: `${MONEY_SETTINGS}#money-youtube`, external: false },
    });
  if (behind.includes(p) && rows.length) {
    const newest = rows.map((r) => r.date).sort().at(-1)!;
    return place(p, name, "waiting", "Waiting for the first numbers", { why: `${name} hasn't sent money since ${dayWords(newest)}.`, checkedAt: checked });
  }
  const shown = rows.filter((r) => start <= r.date && r.date <= end);
  if (shown.length) {
    const note = state.lastError ? `Couldn't check today. Showing money up to ${dayWords(shown.map((r) => r.date).sort().at(-1)!)}.` : undefined;
    const out = place(p, name, "number", SAYS[p]!, { tag: tagOf(p), note, checkedAt: checked });
    out.amounts = amountsOf(shown);
    return out;
  }
  if (state.lastError) return place(p, name, "error", "Couldn't check today", { why: "Clip Factory tries again tomorrow.", checkedAt: checked });
  if (p === "youtube" && state.state && NOT_IN_PROGRAM.has(state.state))
    return place(p, name, "waiting", "Waiting for the first numbers", {
      why: "YouTube says you're not in its Partner Program yet.",
      button: { label: "How close am I?", href: MONEY_SETTINGS, external: false },
      checkedAt: checked,
    });
  const why = p === "youtube" ? "YouTube shows money 2–3 days after it's made." : `${name} can take 2 days.`;
  return place(p, name, "waiting", "Waiting for the first numbers", { why, checkedAt: checked });
}

function crStatus(conn: EverywhereInput["crconn"], now: number): string {
  const status = conn?.status ?? "not_connected";
  if (status === "connected" || status === "read_only") {
    const by = conn?.signInBy ? Date.parse(conn.signInBy) : NaN;
    if (Number.isFinite(by) && now >= by) return "needs_reconnect";
  }
  return status;
}

function crPlace(conn: EverywhereInput["crconn"], money: NonNullable<EverywhereInput["crmoney"]>, start: string, end: string, now: number): MoneyPlace {
  const status = crStatus(conn, now);
  if (status === "not_connected")
    return place(CR, CR_NAME, "not_set_up", "Not set up yet", {
      why: "Connect Content Rewards to see its money.",
      button: { label: "Set up Content Rewards", href: setup(CR), external: false },
    });
  const read = !!money.firstReadDone;
  const cr: NonNullable<MoneyPlace["cr"]> = {
    stillEarningCents: cents(money.stillEarningCents),
    onItsWayCents: cents(money.onItsWayCents),
    readyToMoveCents: cents(money.readyToMoveCents),
    paidSoFarCents: read ? cents(money.paidTotalCents) : null,
    movedOut: "not_available",
  };
  if (money.lastPaidAt) cr.lastPaidAt = money.lastPaidAt;
  if (money.asOf) cr.asOf = money.asOf;
  const ordered: NonNullable<MoneyPlace["cr"]> = {
    stillEarningCents: cr.stillEarningCents,
    onItsWayCents: cr.onItsWayCents,
    readyToMoveCents: cr.readyToMoveCents,
    paidSoFarCents: cr.paidSoFarCents,
    ...(cr.lastPaidAt ? { lastPaidAt: cr.lastPaidAt } : {}),
    ...(cr.asOf ? { asOf: cr.asOf } : {}),
    movedOut: "not_available",
  };
  const asOf = cr.asOf;
  if (status === "needs_reconnect")
    return place(CR, CR_NAME, "sign_in", "Sign in again", {
      why: "Sign in to Content Rewards again to see your money.",
      button: { label: "Sign in again", href: setup(CR), external: false },
      cr: ordered,
    });
  if (money.error && !asOf) return place(CR, CR_NAME, "error", "Couldn't check today", { why: "Content Rewards didn't answer. Try again in a few minutes.", cr: ordered });
  const checking = "Checking Content Rewards…";
  if (!read) return place(CR, CR_NAME, "waiting", "Waiting for the first numbers", { why: checking, cr: ordered, checkedAt: asOf });
  if (!(ordered.paidSoFarCents || ordered.stillEarningCents || ordered.readyToMoveCents || ordered.onItsWayCents))
    return place(CR, CR_NAME, "waiting", "Waiting for the first numbers", { why: "No campaign money yet. It shows here when the brand approves your clips.", cr: ordered, checkedAt: asOf });
  if (!money.paidByDayDone) return place(CR, CR_NAME, "waiting", "Waiting for the first numbers", { why: checking, cr: ordered, checkedAt: asOf });
  let sum = 0;
  for (const [day, value] of Object.entries(money.paidByDay ?? {})) {
    const c = cents(value);
    if (c !== null && start <= day && day <= end) sum += c;
  }
  const note = money.error && asOf ? `Couldn't check today. Showing money up to ${dayWords(asOf.slice(0, 10))}.` : undefined;
  const out = place(CR, CR_NAME, "number", SAYS[CR]!, { tag: CR_ROW_TAG, note, cr: ordered, checkedAt: asOf });
  out.amounts = [{ currency: "USD", amountMicros: sum * MICROS_PER_CENT }];
  return out;
}

function totalsOf(places: MoneyPlace[]): MoneyEverywhere["totals"] {
  const by = new Map<string, MoneyEverywhere["totals"][number]>();
  for (const p of places) {
    if (p.state !== "number") continue;
    for (const a of p.amounts) {
      const line = by.get(a.currency) ?? { currency: a.currency, amountMicros: 0, places: [], tag: "" };
      by.set(a.currency, line);
      line.amountMicros += a.amountMicros;
      if (!line.places.includes(p.place)) line.places.push(p.place);
    }
  }
  const short = new Map(places.map((p) => [p.place, p.place === CR ? CR_TAG : (p.tag ?? "")]));
  const out = [...by.values()].map((l) => ({ ...l, tag: l.places.map((p) => short.get(p) ?? "").join(" + ") }));
  return out.sort((a, b) => b.amountMicros - a.amountMicros || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

function notCountedText(places: MoneyPlace[]): string | undefined {
  const groups = new Map<string, string[]>();
  for (const p of places) if (p.state !== "number") groups.set(p.state, [...(groups.get(p.state) ?? []), p.name]);
  if (!groups.size) return undefined;
  return `Not in the total: ${[...groups.entries()].map(([state, names]) => `${join(names)} (${STATE_WORDS[state] ?? state})`).join(" · ")}.`;
}

// ---------- Get paid: money sent toward his bank (getpaid/sent.py, line for line) ----------

const SENT_MICROS = 1_000_000;
const MAX_AMOUNT_CHARS = 64;
const CHECKING_HOURS = 26;
const CODE = /(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/g;
const SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP", "₹": "INR" };
const NUMBER = /[0-9](?:[0-9 \u00a0\u202f'\u2019.,]*[0-9])?/g;
const GROUPING = " \u00a0\u202f'\u2019";
const MINUS = "-\u2212";
const GOOGLE_ARRIVE = "Your bank gets it up to 7 workdays after Google sends it.";
const WHOP_ARRIVE_SOON = "Whop says it should arrive within 5 workdays.";
const WHOP_NOTE = "Whop counts all your Whop money, not only Content Rewards.";
const YT_PAGE = "/settings/posting/getpaid/youtube";
const YT_READING = "/settings/posting/getpaid/youtube#yt-reading";
const WHOP_CARD = "/settings/posting/getpaid/contentrewards#whop";
const STRIPE = "https://connect.stripe.com/express_login";
const WHOP_STATES: Record<string, string> = {
  completed: "sent",
  requested: "on_its_way",
  in_review: "on_its_way",
  processing: "on_its_way",
  failed: "didnt_go_through",
  canceled: "didnt_go_through",
  denied: "didnt_go_through",
  reversed: "came_back",
};
const NOT_AVAILABLE: Record<string, { headline: string; where: NonNullable<SentLine["where"]> }> = {
  tiktok: { headline: "Not available from TikTok", where: { text: "Look in TikTok: Profile, then Balance, then Transactions, then Withdrawal." } },
  instagram: { headline: "Not available from Instagram", where: { text: "Look in Instagram: Professional dashboard, then Payouts. Meta also emails you each month." } },
  facebook: { headline: "Not available from Meta", where: { text: "Look in Meta Business Suite: All tools, then Payouts. Meta also emails you each month." } },
  x: { headline: "Not available from X", where: { text: "Look in Stripe: Payouts.", button: { label: "Open Stripe", url: STRIPE } } },
};
const TOTAL_NAMES: Record<string, string> = { youtube: "YouTube", [CR]: "Whop (all your Whop money, Content Rewards too)" };
const BY: Record<string, string> = { youtube: "Google", [CR]: "Whop" };
const PLACE_NAMES: Record<string, string> = { ...LABEL, [CR]: CR_NAME };
const SENT_STATE_WORDS: Record<string, string> = {
  not_available: "not available",
  needs_reading: "Clip Factory can't see it",
  checking: "checking",
  error: "couldn't check",
  none_yet: "nothing sent yet",
};
const BANK_TEXT = "Clip Factory can't see your bank. Look in your bank's app to see what arrived.";

function sentCurrency(text: string): string | null {
  const codes = new Set([...text.matchAll(CODE)].map((m) => m[1]!));
  const symbols = new Set([...text].filter((c) => c in SYMBOLS).map((c) => SYMBOLS[c]!));
  if (codes.size === 1) {
    const code = [...codes][0]!;
    return !symbols.size || (symbols.size === 1 && symbols.has(code)) ? code : null;
  }
  if (!codes.size && symbols.size === 1) return [...symbols][0]!;
  return null;
}

function splitNumber(raw: string): [string, string] | null {
  const s = [...raw].filter((c) => !GROUPING.includes(c)).join("");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    const [mark, grouping] = dot > comma ? [".", ","] : [",", "."];
    const at = s.lastIndexOf(mark);
    const whole = s.slice(0, at);
    if (whole.includes(mark)) return null;
    return [whole.split(grouping).join(""), s.slice(at + 1)];
  }
  for (const mark of [".", ","]) {
    if (s.includes(mark)) {
      const at = s.lastIndexOf(mark);
      const tail = s.slice(at + 1);
      if (tail.length === 1 || tail.length === 2) {
        if (s.split(mark).length - 1 > 1) return null;
        return [s.slice(0, at), tail];
      }
      return [s.split(mark).join(""), ""];
    }
  }
  return [s, ""];
}

/** getpaid/sent.py `parse_amount`: [micros, currency], each null when it can't be read for sure. */
export function parseAmount(text: unknown): [number | null, string | null] {
  if (typeof text !== "string") return [null, null];
  const value = text.trim();
  if (!value || value.length > MAX_AMOUNT_CHARS) return [null, null];
  const currency = sentCurrency(value);
  const found = [...value.matchAll(NUMBER)];
  if (found.length !== 1) return [null, currency];
  const parts = splitNumber(found[0]![0]);
  if (!parts) return [null, currency];
  const [whole, fraction] = parts;
  if (!/^[0-9]+$/.test(whole) || (fraction && !/^[0-9]+$/.test(fraction)) || fraction.length > 6) return [null, currency];
  let micros = Number(whole) * SENT_MICROS + Number(fraction.padEnd(6, "0"));
  if ([...value.slice(0, found[0]!.index)].some((c) => MINUS.includes(c))) micros = -micros;
  return [micros, currency];
}

const SENT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function sentDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const day = value.includes("T") ? new Date(value) : /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
  return day && Number.isFinite(day.getTime()) ? day : null;
}
/** "23 Oct" */
const shortDay = (value: unknown) => {
  const d = sentDate(value);
  return d ? `${d.getUTCDate()} ${SENT_MONTH[d.getUTCMonth()]}` : "";
};
/** "Thu 27 Nov" */
const weekDay = (value: unknown) => {
  const d = sentDate(value);
  return d ? `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${SENT_MONTH[d.getUTCMonth()]}` : "";
};
const sentJoin = (names: string[]) => (!names.length ? "" : join(names));

const youtubeState = (row: PayoutItem) => (row.goneAt || row.state === "gone" ? "gone" : "sent");
function whopState(row: PayoutItem): string {
  if (typeof row.status === "string" && row.status in WHOP_STATES) return WHOP_STATES[row.status]!;
  return typeof row.state === "string" && Object.values(WHOP_STATES).includes(row.state) ? row.state : "on_its_way";
}
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const newestFirst = (rows: PayoutItem[]) => [...rows].sort((a, b) => textOrder(b.date ?? "", a.date ?? "") || textOrder(b.sk ?? "", a.sk ?? ""));
function rowMoney(row: PayoutItem, p: string): [number | null, string | null] {
  if (p === "youtube") return parseAmount(row.amountText);
  const micros = typeof row.amountMicros === "number" && Number.isInteger(row.amountMicros) ? row.amountMicros : null;
  return [micros, typeof row.currency === "string" && row.currency ? row.currency.toUpperCase() : null];
}
function sums(pairs: [number, string][]): SentLine["amounts"] {
  const by = new Map<string, number>();
  for (const [micros, currency] of pairs) by.set(currency, (by.get(currency) ?? 0) + micros);
  return [...by.keys()].sort().map((currency) => ({ currency, amountMicros: by.get(currency)! }));
}

function sentLineOf(state: SentLine["state"], headline: string, extra: Partial<SentLine> = {}): SentLine {
  const out: SentLine = { state, headline, amounts: [] };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

function firstReadLate(conn: PayConnItem, state: { lastError?: string | null }, now: number | null): boolean {
  if (state.lastError) return true;
  const started = conn.connectedAt ? Date.parse(conn.connectedAt) : NaN;
  return !Number.isFinite(started) || now === null || now - started >= CHECKING_HOURS * 3600_000;
}

function unreadText(by: string, count: number, more: boolean, what = "payment"): string {
  const things = count === 1 ? what : `${what}s`;
  const extra = more ? " more" : "";
  if (count === 1) return `${by} sent 1${extra} ${things}. Clip Factory couldn't tell its money type, so it isn't added up.`;
  return `${by} sent ${count}${extra} ${things}. Clip Factory couldn't tell their money type, so they aren't added up.`;
}
const rowNotAdded = (count: number, what = "payment") =>
  count === 1 ? `1 ${what} isn't added up: Clip Factory couldn't tell its money type.` : `${count} ${what}s aren't added up: Clip Factory couldn't tell their money type.`;

function numberLine(p: string, sent: PayoutItem[]): SentLine {
  const read: [number, string][] = [];
  let unread = 0;
  for (const r of sent) {
    const [micros, currency] = rowMoney(r, p);
    if (micros === null || currency === null) unread += 1;
    else read.push([micros, currency]);
  }
  const by = BY[p]!;
  const newest = newestFirst(sent)[0]!;
  const [micros, currency] = rowMoney(newest, p);
  const last: NonNullable<SentLine["last"]> = { date: String(newest.date ?? ""), amountMicros: currency ? micros : null, currency: micros !== null ? currency : null };
  if (p === "youtube" && last.amountMicros === null && typeof newest.amountText === "string") last.text = newest.amountText;
  const out = sentLineOf("number", `Sent to your bank by ${by}`, { tag: `${p === "youtube" ? "YouTube" : "Whop"} says` });
  out.amounts = sums(read);
  const what = p === "youtube" ? "payment" : "payout";
  if (unread && read.length) out.notAdded = rowNotAdded(unread, what);
  else if (unread) {
    out.notAdded = unreadText(by, unread, false, what);
    if (p === "youtube") out.button = { label: "See them", href: YT_PAGE, external: false };
  }
  if (p === "youtube") out.arrive = GOOGLE_ARRIVE;
  else {
    const arrival = weekDay(newest.estimatedArrival);
    out.arrive = arrival ? `Whop says it should arrive by ${arrival}.` : WHOP_ARRIVE_SOON;
    out.note = WHOP_NOTE;
  }
  out.last = last;
  return out;
}

function youtubeSent(rows: PayoutItem[], conn: PayConnItem, state: { firstReadDone?: boolean; lastError?: string | null }, now: number | null): SentLine {
  const status = conn.status;
  const sent = rows.filter((r) => youtubeState(r) === "sent");
  if (sent.length) {
    const out = numberLine("youtube", sent);
    if (status === "needs_reconnect") out.note = "Clip Factory can't see YouTube payments anymore. Tap Allow payment reading again.";
    else if (status !== "connected" && shortDay(conn.stoppedAt)) out.note = `Clip Factory stopped reading on ${shortDay(conn.stoppedAt)}.`;
    return out;
  }
  if (status === "connected") {
    if (state.firstReadDone) return sentLineOf("none_yet", "Nothing sent to your bank yet", { tag: "YouTube says" });
    if (!firstReadLate(conn, state, now)) return sentLineOf("checking", "Checking YouTube payments…", { why: "This can take until tomorrow." });
    return sentLineOf("error", "Clip Factory couldn't check YouTube payments yet", { why: "It tries again tomorrow." });
  }
  const button = { label: "Allow payment reading", href: YT_READING, external: false };
  if (status === "needs_reconnect") return sentLineOf("needs_reading", "Clip Factory can't see YouTube payments anymore", { why: "Tap Allow payment reading again.", button });
  return sentLineOf("needs_reading", "Clip Factory can't see YouTube payments yet", { button });
}

function whopSent(rows: PayoutItem[], conn: PayConnItem, state: { firstReadDone?: boolean; lastError?: string | null }, now: number | null, whopOn: boolean): SentLine {
  const status = whopOn ? conn.status : undefined;
  const sent = rows.filter((r) => whopState(r) === "sent");
  if (sent.length) return numberLine(CR, sent);
  const button = whopOn ? { label: "Connect Whop", href: WHOP_CARD, external: false } : undefined;
  if (status === "connected") {
    if (state.firstReadDone) return sentLineOf("none_yet", "Nothing sent to your bank yet", { tag: "Whop says", note: WHOP_NOTE });
    if (!firstReadLate(conn, state, now)) return sentLineOf("checking", "Checking your Whop payouts…", { why: "This can take until tomorrow.", note: WHOP_NOTE });
    return sentLineOf("error", "Clip Factory couldn't check your Whop payouts yet", { why: "It tries again tomorrow.", note: WHOP_NOTE });
  }
  if (status === "needs_reconnect") return sentLineOf("needs_reading", "Clip Factory can't see your Whop payouts anymore", { why: "Sign in to Whop again to see your payouts.", button });
  return sentLineOf("not_available", "Sent to your bank: not available from Content Rewards", { where: { text: "Look on Whop: **Balances**." }, button });
}

/** getpaid/sent.py `sent_line`: one place's "Sent to your bank" line. */
export function sentLine(
  p: MoneyPlaceId,
  rows: PayoutItem[] | null | undefined,
  conn: PayConnItem | null | undefined,
  state: { firstReadDone?: boolean; lastError?: string | null } | null | undefined,
  whopOn = false,
  now: number | null = null,
): SentLine {
  if (p === "youtube") return youtubeSent([...(rows ?? [])], conn ?? {}, state ?? {}, now);
  if (p === CR) return whopSent([...(rows ?? [])], conn ?? {}, state ?? {}, now, whopOn);
  const found = NOT_AVAILABLE[p]!;
  return sentLineOf("not_available", found.headline, { where: { ...found.where } });
}

const UNREAD_COUNT = /(\d+)(?: more)? (?:payment|payout)s?\b/;
const unreadCount = (line: SentLine) => Number(UNREAD_COUNT.exec(line.notAdded ?? "")?.[1] ?? 0);

/** getpaid/sent.py `sent_totals`: the "Sent to your bank, so far" block, one line per money type, in the places' order. */
export function sentTotals(lines: [MoneyPlaceId, SentLine][]): MoneySentBlock {
  const by = new Map<string, MoneySentBlock["totals"][number]>();
  const first = new Map<string, number>();
  const who: string[] = [];
  const notAdded: string[] = [];
  const groups = new Map<string, string[]>();
  lines.forEach(([p, line], index) => {
    if (line.state !== "number") {
      groups.set(line.state, [...(groups.get(line.state) ?? []), PLACE_NAMES[p] ?? p]);
      return;
    }
    if (BY[p] && !who.includes(BY[p]!)) who.push(BY[p]!);
    for (const a of line.amounts) {
      const total = by.get(a.currency) ?? { currency: a.currency, amountMicros: 0, places: [], names: "" };
      by.set(a.currency, total);
      if (!first.has(a.currency)) first.set(a.currency, index);
      total.amountMicros += a.amountMicros;
      if (!total.places.includes(p)) total.places.push(p);
    }
    const count = unreadCount(line);
    if (count) notAdded.push(unreadText(BY[p] ?? PLACE_NAMES[p] ?? p, count, line.amounts.length > 0, p === "youtube" ? "payment" : "payout"));
  });
  const totals = [...by.values()].sort((a, b) => first.get(a.currency)! - first.get(b.currency)! || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  for (const t of totals) t.names = sentJoin(t.places.map((p) => TOTAL_NAMES[p] ?? PLACE_NAMES[p] ?? p));
  const out: MoneySentBlock = { totals, tag: who.length === 1 ? `${who[0]} says it sent it.` : "Google and Whop say they sent it.", bankText: BANK_TEXT };
  if (notAdded.length) out.notAdded = notAdded.join(" ");
  if (groups.size) out.notCountedText = `Not in this: ${[...groups.entries()].map(([state, names]) => `${sentJoin(names)} (${SENT_STATE_WORDS[state] ?? state})`).join(" · ")}.`;
  if (!lines.some(([, line]) => line.state === "number")) out.empty = "Nothing sent to your bank yet.";
  return out;
}

const SOURCE_OF: Partial<Record<MoneyPlaceId, "adsense" | "whop">> = { youtube: "adsense", [CR]: "whop" };

/** MoneyEverywhere, exactly as the server works it out (stored items only). */
export function everywhere(input: EverywhereInput): MoneyEverywhere {
  const now = Date.parse(input.today);
  const today = input.today.slice(0, 10);
  const verified = input.facebookVerified;
  const stored = new Map<Platform, MoneyRow[]>();
  for (const r of input.rows) {
    const p = r.platform;
    if (!input.accounts[p] || !MONEY_PLATFORMS.has(p) || !moneyShown(p, verified)) continue;
    if (Number.isInteger(r.amountMicros) && typeof r.date === "string" && r.currency) stored.set(p, [...(stored.get(p) ?? []), { ...r }]);
  }
  const status: Partial<Record<Platform, MoneyStatus>> = {};
  for (const p of ORDER) {
    if (!MONEY_PLATFORMS.has(p) || !moneyShown(p, verified)) continue;
    const account = input.accounts[p];
    status[p] = {
      connected: !!account,
      moneyScope: !!account && (p !== "youtube" || (account.scopes ?? []).includes(MONETARY_SCOPE)),
      lastError: input.states[p]?.lastError ?? null,
      checkedAt: input.states[p]?.lastCheckedAt ?? null,
    };
  }
  const monthly = summarize({ today, platforms: [...ORDER], chart: 30, rows: [...stored.values()].flat(), status, facebookVerified: verified, where: PAID_WHERE });
  const end = monthly.through ?? today;
  const start = addDays(end, -(PERIOD_DAYS - 1));
  const behind = monthly.excluded.filter((e) => e.reason === "behind").map((e) => e.platform as string);
  const places: MoneyPlace[] = ORDER.map((p) => platformPlace(p, verified, input.accounts[p], input.states[p] ?? {}, stored.get(p) ?? [], behind, start, end));
  if (input.crOn) places.push(crPlace(input.crconn, input.crmoney ?? {}, start, end, now));
  const lines: [MoneyPlaceId, SentLine][] = places.map((row) => {
    const source = SOURCE_OF[row.place];
    const line = sentLine(row.place, input.payouts?.[row.place] ?? [], (source && input.payconns?.[source]) || {}, input.paystates?.[row.place] ?? {}, !!input.whopOn, now);
    row.sent = line;
    return [row.place, line];
  });
  const out: MoneyEverywhere = {
    from: start,
    to: end,
    periodText: monthly.through ? `30 days up to ${dayWords(end)}` : "the last 30 days",
    places,
    totals: [],
    notCounted: [],
    asOf: input.today,
  };
  const lag = (["youtube", "facebook"] as const).find((p) => places.some((x) => x.place === p && x.state === "number"));
  if (lag) out.lagNote = LAG_NOTES[lag];
  out.totals = totalsOf(places);
  out.notCounted = places.filter((p) => p.state !== "number").map((p) => ({ place: p.place, state: p.state }));
  const text = notCountedText(places);
  if (text) out.notCountedText = text;
  out.sent = sentTotals(lines);
  return out;
}

/** The pretend owner's day for the seeded Content Rewards payouts (n days ago, UTC). */
export const crDay = (daysAgo: number, now = Date.now()) => addDays(todayUtc(now), -daysAgo);
