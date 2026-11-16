// How much money a clip probably made (docs/CONTRACTS.md §21). Every app pays a different, small amount for every
// 1,000 views; the usual amounts and where they come from live in config/earnings.json (the one source of truth).
// The owner can type their real amount from the app's own dashboard and say whether an app pays them at all, in
// Settings › Posting › Money. Everything here is pure, so the tests can check every rule.
import config from "../../../config/earnings.json";
import type { AnyExtra, Platform, Settings } from "../api/types.ts";

export interface EarningsSource {
  url: string;
  title: string;
  date: string;
}

export interface PlatformRates {
  label: string;
  paysPerView: boolean;
  lowUsdPer1000: number;
  typicalUsdPer1000: number;
  highUsdPer1000: number;
  unit: string;
  minClipSeconds: number;
  /** Plain reason shown when a clip is shorter than `minClipSeconds` ("TikTok only pays for videos 1 minute or longer."). */
  tooShortNote: string;
  eligibility: string;
  kidNote: string;
  /** Who gets paid, in plain words (Settings › Money, "Where the numbers come from"). */
  kidRules: string;
  /** What counts as a paid view, in plain words. */
  kidCounts: string;
  notes: string;
  confidence: "low" | "medium" | "high";
  sources: EarningsSource[];
}

export interface EarningsConfig {
  asOf: string;
  currency: string;
  maxUsdPer1000: number;
  order: Platform[];
  platforms: Record<Platform, PlatformRates>;
}

export const EARNINGS: EarningsConfig = config as EarningsConfig;

/** The highest amount for 1,000 views the owner may type (the API checks the same number). */
export const MAX_RATE = EARNINGS.maxUsdPer1000;

/** Where the owner changes the amounts. */
export const MONEY_HREF = "/settings/posting/money";

type MoneySettings = Pick<Settings, "earningsRates" | "earningsPaid"> | null | undefined;

export interface RateInUse {
  /** US dollars for every 1,000 views. */
  rate: number;
  /** True when the owner typed their own amount. */
  yours: boolean;
  /** "Do I get paid here?" */
  paid: boolean;
}

const validRate = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_RATE;

/** The amount and the on/off switch used for one platform: the owner's own when set, else the usual ones. */
export function rateFor(platform: Platform, settings?: MoneySettings): RateInUse {
  const usual = EARNINGS.platforms[platform];
  const own = settings?.earningsRates?.[platform];
  const paid = settings?.earningsPaid?.[platform];
  return {
    rate: validRate(own) ? own : usual.typicalUsdPer1000,
    yours: validRate(own),
    paid: typeof paid === "boolean" ? paid : usual.paysPerView,
  };
}

export type EarnWhy = "paid" | "off" | "too_short" | "no_views";

export interface PlatformEarning {
  platform: Platform;
  /** Estimated US dollars; null while there are no views to count (shown as "no money yet"). */
  usd: number | null;
  views: number | null;
  rate: number;
  yours: boolean;
  why: EarnWhy;
  /** One plain sentence for "off" and "too_short"; empty otherwise. */
  reason: string;
  /** For a switched-off app with views: what it would be if the app paid the owner (null otherwise). */
  usdIfOn: number | null;
}

/**
 * The view count each app's rate is based on (§21.3): YouTube pays for engaged views (no replays), Facebook for
 * plays that are not replays, and X's rate is per impression. Falls back to `views` when the app has not sent the
 * better number yet (replays then count, so the guess can be a little high).
 */
export function paidViews(platform: Platform, metrics: { views: number | null; extra?: AnyExtra | object } | null | undefined): number | null {
  if (!metrics) return null;
  const extra = (metrics.extra ?? {}) as AnyExtra;
  const better = platform === "youtube" ? extra.engagedViews : platform === "facebook" ? extra.initialPlays : platform === "x" ? extra.impressions : undefined;
  if (typeof better === "number" && Number.isFinite(better) && better >= 0) return better;
  return typeof metrics.views === "number" ? metrics.views : null;
}

/** The app's short name (YouTube, not YouTube Shorts): the same word on every money screen. */
export const APP_NAME: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };
const SHORT = APP_NAME;

/**
 * The plain catch for an app that is on (YouTube, Facebook and X start on, §21.1): the money only counts if the owner
 * is in that app's paid program, followed by who gets paid (`kidRules`).
 */
export function paidProgramNote(platform: Platform): string {
  return `This only counts if you are in ${SHORT[platform]}'s paid program. ${EARNINGS.platforms[platform].kidRules}`;
}

/**
 * One platform's estimate: views / 1,000 × the rate in use. Zero, with a plain reason, when the app is switched off
 * (TikTok and Instagram start off; YouTube, Facebook and X start on) or when the clip is shorter than the app pays for. Missing views
 * give null (not $0), even for a switched-off app, so a clip with no numbers never adds up to "$0.00".
 */
export function earningFor(
  platform: Platform,
  views: number | null | undefined,
  durationSec: number | null | undefined,
  settings?: MoneySettings,
): PlatformEarning {
  const { rate, yours, paid } = rateFor(platform, settings);
  const usual = EARNINGS.platforms[platform];
  const count = typeof views === "number" && Number.isFinite(views) && views >= 0 ? views : null;
  const base = { platform, views: count, rate, yours, usdIfOn: null };
  const zero = count === null ? null : 0;
  const tooShort = usual.minClipSeconds > 0 && typeof durationSec === "number" && durationSec < usual.minClipSeconds;
  if (!paid) {
    const chosen = typeof settings?.earningsPaid?.[platform] === "boolean";
    return {
      ...base,
      usd: zero,
      usdIfOn: count === null || tooShort ? null : (count / 1000) * rate,
      why: "off",
      reason: chosen ? `${SHORT[platform]} does not pay you for views right now.` : `Turn this on in Settings › Money if ${SHORT[platform]} pays you.`,
    };
  }
  if (tooShort) return { ...base, usd: zero, why: "too_short", reason: usual.tooShortNote };
  if (count === null) return { ...base, usd: null, why: "no_views", reason: "" };
  return { ...base, usd: (count / 1000) * rate, why: "paid", reason: "" };
}

export interface ClipEarnings {
  /** Sum of every platform with an amount; null when none has one yet. */
  usd: number | null;
  platforms: PlatformEarning[];
  /** Why the total is exactly $0 (every counted app is off or too short); empty otherwise. */
  reason: string;
}

/** Every platform that has views (or a post) for this clip, in the usual order, plus the clip's total. */
export function clipEarnings(
  views: Partial<Record<Platform, number | null | undefined>>,
  durationSec: number | null | undefined,
  settings?: MoneySettings,
): ClipEarnings {
  const platforms = EARNINGS.order.filter((p) => p in views).map((p) => earningFor(p, views[p], durationSec, settings));
  const usd = sumUsd(platforms.map((p) => p.usd));
  return { usd, platforms, reason: usd === 0 ? zeroReason(platforms) : "" };
}

/**
 * The plain reason a total is exactly $0, from the apps that were counted (they have views): all switched off,
 * all too short, or a mix. Empty when an app that pays simply had 0 views.
 */
export function zeroReason(platforms: PlatformEarning[]): string {
  const counted = platforms.filter((p) => p.usd === 0);
  if (!counted.length || counted.some((p) => p.why === "paid")) return "";
  if (counted.every((p) => p.why === "off")) return "These apps are switched off in Settings › Money.";
  if (counted.every((p) => p.why === "too_short")) return "This clip is too short for these apps to pay.";
  return "These apps don't pay for this clip.";
}

/**
 * A Library card's paid views per app from its posts (see `paidViews`): posted, public posts only (a private TikTok
 * has no numbers), null while the first numbers are on the way. Matches This week's `paidViews` (§21.3).
 */
export function postViews(
  posts: { platform: Platform; status: string; privacy?: string; metrics?: { views: number | null; extra?: AnyExtra | object } | null }[],
): Partial<Record<Platform, number | null>> {
  const out: Partial<Record<Platform, number | null>> = {};
  for (const p of posts) {
    if (p.status !== "posted" || p.privacy === "private") continue;
    out[p.platform] = paidViews(p.platform, p.metrics);
  }
  return out;
}

/** Adds amounts; null when every one is null (nothing to count yet). */
export function sumUsd(amounts: (number | null | undefined)[]): number | null {
  let total: number | null = null;
  for (const a of amounts) if (typeof a === "number" && Number.isFinite(a)) total = (total ?? 0) + a;
  return total;
}

// ---------- Words ----------

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * $1,234.56 with thousands separators and cents. Above 0 but under a cent reads "less than 1¢" (never "$0.00",
 * which would look like nothing). Null reads "–".
 */
export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "–";
  if (usd > 0 && usd < 0.01) return "less than 1¢";
  return money.format(Math.max(0, usd));
}

/** The amount for 1,000 views: "$0.05". */
export function formatRate(rate: number): string {
  return money.format(rate);
}

/** "$0.02 to $0.10" (words, not a dash: the help corpus never uses dashes). */
export function rateRange(platform: Platform): string {
  const p = EARNINGS.platforms[platform];
  return `${formatRate(p.lowUsdPer1000)} to ${formatRate(p.highUsdPer1000)}`;
}

/**
 * "about " before a real guess, nothing before an exact $0 or "less than 1¢" (never "about less than 1¢"), and the
 * amount: the two parts of every money sentence, so screens can make the amount bold.
 */
export function moneyWords(usd: number): { about: string; amount: string } {
  const amount = formatUsd(usd);
  return { about: usd >= 0.01 ? "about " : "", amount };
}

/** A whole money sentence: "Earned about $1.23", "Earned less than 1¢", "Earned $0.00". */
export function moneyPhrase(lead: string, usd: number): string {
  const { about, amount } = moneyWords(usd);
  return `${lead} ${about}${amount}`;
}

/** The line under a clip's total on Library and This week: "Earned about $1.23" / "No money yet". */
export function earnedLine(usd: number | null): string {
  if (usd === null) return "No money yet";
  return moneyPhrase("Earned", usd);
}

/** "Checked 16 Nov 2026" / "Aug 2026" / "2026" from a source date in config ("accessed 2026-11-16", "2026-08"). */
export function sourceDate(raw: string): string {
  const accessed = /^accessed\s+/i.test(raw);
  const iso = raw.replace(/^accessed\s+/i, "").trim();
  const utc = { timeZone: "UTC" } as const;
  let out = iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) out = new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", ...utc });
  else if (/^\d{4}-\d{2}$/.test(iso)) out = new Date(`${iso}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", ...utc });
  if (out === "Invalid Date") out = iso;
  return accessed ? `Checked ${out}` : out;
}

export type RateInput = { ok: true; value: number } | { ok: false; message: string };

/**
 * What the owner typed as their own amount for 1,000 views. Takes "0.05", "$0.05", "0,05" (a comma as the dot, as in
 * Sweden) and " 1 ". At most 2 numbers after the dot, 0 to MAX_RATE.
 */
export function parseRate(text: string): RateInput {
  const t = text.trim().replace(/^\$\s*/, "").replace(",", ".");
  if (!t) return { ok: false, message: "Type an amount, like 0.05." };
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return { ok: false, message: "Type only a number, like 0.05." };
  const [, decimals = ""] = t.split(".");
  if (decimals.length > 2) return { ok: false, message: "Use at most 2 numbers after the dot, like 0.05." };
  const value = Math.round(Number(t) * 100) / 100;
  if (value > MAX_RATE) return { ok: false, message: `That is too much. The most is ${MAX_RATE} dollars.` };
  return { ok: true, value };
}
