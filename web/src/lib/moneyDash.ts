// The money dashboard's small rules (docs/CONTRACTS.md §27.2, §27.4): the apps filter, the saved choices, plain
// dates, the comparison chip's words and the chart's shape. No money arithmetic here: the server sends every amount,
// the web only formats them (web/test/noGuesses.test.ts).
import type { MoneyChange, MoneyChart, MoneyClipSort, Platform } from "../api/types.ts";

export const DASH_PATH = "/money";
export const APPS: readonly Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];
export const PERIODS: readonly MoneyChart[] = [7, 30, 90, 365];
export const PERIOD_LABEL: Record<MoneyChart, string> = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "Year" };
export const SORT_LABEL: Record<MoneyClipSort, string> = { money: "Most money", views: "Most views" };
const STORE_KEY = "cf-money-dash";

/** What the owner picked: an empty `apps` list is All (the default). */
export interface DashChoice {
  apps: Platform[];
  period: MoneyChart;
  sort: MoneyClipSort;
}

export const DEFAULT_CHOICE: DashChoice = { apps: [], period: 30, sort: "money" };

const inOrder = (list: Iterable<Platform>) => {
  const set = new Set(list);
  return APPS.filter((p) => set.has(p));
};

/**
 * The apps chips (§27.4): tapping an app while All is on picks only that app; turning the last one off goes back to
 * All; picking all five is All; All clears the rest.
 */
export function toggleApp(apps: readonly Platform[], tapped: Platform | "all"): Platform[] {
  if (tapped === "all") return [];
  if (!apps.length) return [tapped];
  const next = apps.includes(tapped) ? apps.filter((p) => p !== tapped) : [...apps, tapped];
  const sorted = inOrder(next);
  return sorted.length === APPS.length ? [] : sorted;
}

export const isAll = (apps: readonly Platform[]) => apps.length === 0;

function parseApps(raw: unknown): Platform[] | null {
  const list = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : null;
  if (!list) return null;
  if (list.some((p) => typeof p !== "string" || (p !== "all" && !APPS.includes(p as Platform)))) return null;
  const apps = inOrder(list.filter((p): p is Platform => p !== "all"));
  return apps.length === APPS.length ? [] : apps;
}

function parsePeriod(raw: unknown): MoneyChart | null {
  const n = typeof raw === "string" ? (raw === "year" ? 365 : Number(raw)) : raw;
  return PERIODS.includes(n as MoneyChart) ? (n as MoneyChart) : null;
}

const parseSort = (raw: unknown): MoneyClipSort | null => (raw === "money" || raw === "views" ? raw : null);

/** The saved choice on this device; anything broken or missing falls back to the defaults. Never throws. */
export function readStored(storage: Pick<Storage, "getItem"> | null = safeStorage()): DashChoice {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(STORE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_CHOICE };
    const r = raw as Record<string, unknown>;
    return {
      apps: parseApps(r.apps) ?? DEFAULT_CHOICE.apps,
      period: parsePeriod(r.period) ?? DEFAULT_CHOICE.period,
      sort: parseSort(r.sort) ?? DEFAULT_CHOICE.sort,
    };
  } catch {
    return { ...DEFAULT_CHOICE };
  }
}

export function writeStored(choice: DashChoice, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(choice));
  } catch {
    /* private mode or blocked storage: the choice lasts for this page only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** `?apps=youtube,facebook&period=30&sort=views` over the saved choice: the address wins. */
export function readChoice(search: string, stored: DashChoice): DashChoice {
  const q = new URLSearchParams(search);
  return {
    apps: q.has("apps") ? (parseApps(q.get("apps")) ?? stored.apps) : stored.apps,
    period: q.has("period") ? (parsePeriod(q.get("period")) ?? stored.period) : stored.period,
    sort: q.has("sort") ? (parseSort(q.get("sort")) ?? stored.sort) : stored.sort,
  };
}

/** The address for a choice (defaults left out, other query words kept). */
export function choiceSearch(choice: DashChoice, search = ""): string {
  const q = new URLSearchParams(search);
  for (const k of ["apps", "period", "sort"]) q.delete(k);
  if (choice.apps.length) q.set("apps", choice.apps.join(","));
  if (choice.period !== DEFAULT_CHOICE.period) q.set("period", String(choice.period));
  if (choice.sort !== DEFAULT_CHOICE.sort) q.set("sort", choice.sort);
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

/** The clip list's period for a chart period (the list has no "year": a year shows the clips' lifetime money). */
export const clipPeriod = (period: MoneyChart): 7 | 30 | 90 | "all" => (period === 365 ? "all" : period);

// ---------- plain dates ----------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(day: string): { y: number; m: number; d: number; dow: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Date.UTC on the numbers alone: the platform's calendar day is never moved by the device's time zone.
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return { y, m: mo, d, dow };
}

/** "Sat 16 Nov" (the platform's own day, never shifted by a time zone). */
export function plainDay(day: string): string {
  const p = parts(day);
  return p ? `${DAYS[p.dow]} ${p.d} ${MONTHS[p.m - 1]}` : day;
}

/** "16 Nov", or "16 Nov 2025" when the year differs from `thisYear`. */
export function plainShort(day: string, thisYear?: number): string {
  const p = parts(day);
  if (!p) return day;
  return thisYear !== undefined && p.y !== thisYear ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : `${p.d} ${MONTHS[p.m - 1]}`;
}

// ---------- the comparison chip ----------

export interface Chip {
  text: string;
  tone: "success" | "neutral";
  icon: "arrowUp" | "arrowDown" | null;
}

/** "Up 12%", "Down 8%", "Same", "New", or nothing. Never vermilion, never colour alone: the words say it. */
export function chipFor(change: MoneyChange): Chip | null {
  switch (change.direction) {
    case "up":
      return { text: (change.changePct ?? 0) > 999 ? "Up 999%+" : `Up ${change.changePct}%`, tone: "success", icon: "arrowUp" };
    case "down":
      return { text: `Down ${Math.abs(change.changePct ?? 0)}%`, tone: "neutral", icon: "arrowDown" };
    case "same":
      return { text: "Same", tone: "neutral", icon: null };
    case "new":
      return { text: "New", tone: "success", icon: null };
    default:
      return null;
  }
}

/** The sentence a screen reader hears for the chip ("Up 12% on the 30 days before"). */
export function chipSentence(change: MoneyChange, days: number): string | null {
  const chip = chipFor(change);
  if (!chip) return null;
  if (change.direction === "new") return `New: nothing in the ${days} days before`;
  return `${chip.text} on the ${days} days before`;
}

// ---------- the chart ----------

/** Bar heights in px for values against the tallest (0 stays 0, a tiny value still shows 2 px). */
export function barHeights(values: readonly number[], height: number): number[] {
  const top = Math.max(0, ...values);
  if (top <= 0) return values.map(() => 0);
  return values.map((v) => (v <= 0 ? 0 : Math.max(2, Math.round((v / top) * height))));
}

/** A stacked bar's pieces: each part's share of `height` (pixels for drawing only, never shown as money). */
export function stackShares(parts: readonly number[], height: number): number[] {
  const whole = parts.reduce((a, v) => a + Math.max(0, v), 0);
  return parts.map((v) => (whole > 0 && v > 0 ? (v / whole) * height : 0));
}

/** Where each bar sits: `count` bars across `width` with `gap` between them (bars never narrower than 1 px). */
export function barLayout(count: number, width: number, gap: number): { x: number; w: number }[] {
  if (count <= 0 || width <= 0) return [];
  const g = count > 1 ? Math.min(gap, (width / count) * 0.4) : 0;
  const w = Math.max(1, (width - g * (count - 1)) / count);
  return Array.from({ length: count }, (_, i) => ({ x: i * (w + g), w }));
}

/** The bar nearest a pointer at `x` (clamped to the ends). */
export function nearestBar(x: number, count: number, width: number): number {
  if (count <= 0) return -1;
  const i = Math.floor((x / Math.max(1, width)) * count);
  return Math.max(0, Math.min(count - 1, i));
}

/** The KPI number's step for a card of this inline size: narrow cards drop one step so the amount fits. */
export function numberStep(inlineSize: number): "h2" | "h3" {
  return inlineSize < 150 ? "h3" : "h2";
}
