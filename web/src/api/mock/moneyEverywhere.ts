// All your money in one place, in the pretend app (docs/CONTRACTS.md §39.2). Mock builds only.
//
// `everywhere` is a line-for-line copy of api/src/clipfactory_api/money/everywhere.py `everywhere`, over the same
// inputs as its golden cases (api/tests/fixtures/money_everywhere_cases.json, checked in web/test/allMoney.test.tsx
// when the file is there), so the mock and the server say the same. Like moneySummary.ts, this mock file is allowed to
// add up reported money (web/test/noGuesses.test.ts): the real app only formats what the server sent.
import type { MoneyEverywhere, MoneyPlace, MoneyWhere, Platform } from "../types.ts";
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
  x: { label: "X › Monetization (paid through Stripe)", url: "https://x.com/settings/monetization" },
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
  return out;
}

/** The pretend owner's day for the seeded Content Rewards payouts (n days ago, UTC). */
export const crDay = (daysAgo: number, now = Date.now()) => addDays(todayUtc(now), -daysAgo);
