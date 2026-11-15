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

/** 22200 → "6 h 10 min". */
export function duration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;

/** "5 minutes ago", "yesterday", "in 2 days". */
export function relative(isoTime: string, now = Date.now()): string {
  const diff = Date.parse(isoTime) - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf ? rtf.format(Math.round(diff / ms), unit) : `${Math.round(abs / ms)} ${unit}s`;
  }
  return "just now";
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
