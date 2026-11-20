import type { MomentType, Platform } from "../api/types.ts";

export const PLATFORM_LABEL: Record<Platform | "kick" | "twitch" | "upload", string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  x: "X",
  twitch: "Twitch",
  kick: "Kick",
  upload: "Upload",
};

/**
 * The one platform order every screen uses: YouTube, TikTok, Instagram, Facebook, X (docs/CONTRACTS.md §16.8).
 * Library cards, the clip page, This week, the Review place rows and Settings › Where clips go all follow it.
 */
export const PLATFORM_ORDER: readonly Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

/** A copy of `items` sorted into PLATFORM_ORDER (items for the same platform keep their order). */
export function byPlatformOrder<T extends { platform: Platform }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
}

export const MOMENT_LABEL: Record<MomentType, string> = {
  rage: "Rage",
  chaos: "Chaos",
  interaction: "Interaction",
  no_way: "No way",
  first_reaction: "First reaction",
  hot_take: "Hot take",
};

/** 3725 → "1:02:05"; 65 → "1:05". */
export function timecode(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 22200 → "6 h 10 min"; rounds to whole minutes first, so 7190 s is "2 h", never "1 h 60 min". */
export function duration(totalSec: number): string {
  const total = Math.round(totalSec / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}

/**
 * The one "when" style of the app (lists, Library, the clip page): "just now", "3 min ago", "2 h ago", "yesterday",
 * "4 days ago"; ahead of now "in 5 min", "in 2 h", "tomorrow", "in 2 days". The unit is picked from whole minutes
 * (past rounds down, future rounds up), so it never says "60 min ago" or "24 h ago".
 */
export function relative(isoTime: string, now = Date.now()): string {
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return "";
  const diff = t - now;
  const future = diff > 0;
  const min = future ? Math.ceil(diff / 60_000) : Math.floor(-diff / 60_000);
  if (min < 1 || (future && diff < 30_000)) return "just now";
  const say = (n: number, unit: string) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (min < 60) return say(min, "min");
  const h = Math.floor(min / 60);
  if (h < 24) return say(h, "h");
  const d = Math.floor(h / 24);
  if (d === 1) return future ? "tomorrow" : "yesterday";
  return say(d, "days");
}

const compact = typeof Intl !== "undefined" ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }) : null;
export function count(n: number): string {
  return compact ? compact.format(n) : String(n);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "16 Nov" this year, "16 Nov 2025" another year (for "Updated 16 Nov"). */
export function shortDate(isoTime: string, now = new Date()): string {
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }).format(d);
}
