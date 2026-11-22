// Auto-posting's words (docs/CONTRACTS.md §46.2, §46.12): the result line under the controls and its warnings, the
// local "Sun 15:00" times, where the clips go, the Recent lines, the Review card's line, Home's hint and the post-row
// words in Library and on the clip page. Pure: no screen, no api.
import type { AutoPostSettings, AutoRun, Clip, PerfStatus, Platform, Post } from "../api/types.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER, plural } from "./format.ts";
import { failedForPublicAccount } from "./tiktokYourself.ts";

/** What an owner who never saved it reads (§46.3): nothing changes for anyone until he turns it on. */
export const AUTO_POST_DEFAULTS: AutoPostSettings = { on: false, everyHours: 5, perRun: 1, practice: false };
export const EVERY_HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i + 1);
export const PER_RUN: readonly number[] = [1, 2, 3, 4, 5];

const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** The stored settings, or the defaults where a value no longer validates (as the server reads them, §46.3). */
export function autoPostOf(stored: Partial<AutoPostSettings> | undefined | null): AutoPostSettings {
  const s = stored ?? {};
  return {
    on: typeof s.on === "boolean" ? s.on : AUTO_POST_DEFAULTS.on,
    everyHours: whole(s.everyHours, 1, 24) ? s.everyHours : AUTO_POST_DEFAULTS.everyHours,
    perRun: whole(s.perRun, 1, 5) ? s.perRun : AUTO_POST_DEFAULTS.perRun,
    practice: typeof s.practice === "boolean" ? s.practice : AUTO_POST_DEFAULTS.practice,
    ...(typeof s.onAt === "string" ? { onAt: s.onAt } : {}),
  };
}

// ---------- The result line (§46.2 item 2) ----------

/** perRun × 24 / everyHours, not rounded (the API's `perDay`). */
export function perDay(perRun: number, everyHours: number): number {
  return (perRun * 24) / everyHours;
}

/** "1 hour", "5 hours". */
export const hoursWords = (h: number): string => plural(h, "hour");

/**
 * "{n} clip(s) every {h} hour(s) = {about }{d} clip(s) a day per platform.": a whole number of clips a day is said as
 * it is, anything else as "about" and the number rounded half up (4.8 → about 5, 6.86 → about 7). Worked out in whole
 * numbers, so no rounding error can turn a whole day into "about".
 */
export function resultLine(perRun: number, everyHours: number): string {
  const total = perRun * 24;
  const exact = total % everyHours === 0;
  const d = exact ? total / everyHours : Math.floor((2 * total + everyHours) / (2 * everyHours));
  return `${plural(perRun, "clip")} every ${hoursWords(everyHours)} = ${exact ? "" : "about "}${plural(d, "clip")} a day per platform.`;
}

export const MORE_THAN_FIVE = "That's more than 5 clips a day on each platform.";
/** YouTube's videos.insert has its own bucket of 100 a day (checked 2026-11-22). */
export const YOUTUBE_LIMIT = "YouTube takes at most 100 uploads a day, so some would wait until the next day.";

/** The warning under the result line: more than 5 a day, and YouTube's 100 a day on top past 100. */
export function dayWarnings(perRun: number, everyHours: number): string[] {
  const d = perDay(perRun, everyHours);
  if (d <= 5) return [];
  return d > 100 ? [MORE_THAN_FIVE, YOUTUBE_LIMIT] : [MORE_THAN_FIVE];
}

// ---------- Times ----------

const HOUR_MS = 3_600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const two = (n: number) => String(n).padStart(2, "0");

/** "Sun 15:00": the owner's local weekday and 24-hour time. Never "Today" or "Tomorrow" (§46.2). */
export function timeWords(at: string | number | Date): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${DAYS[d.getDay()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The first whole hour strictly after `t` (ms), as the API's nextFullHour (§46.4). */
export function nextFullHour(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
}

/** The whole hour at or before `t` (ms): the tick's slot. */
export function floorHour(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

// ---------- The switch's line (§46.2 item 1) ----------

export const OFF_LINE = "Off. Nothing posts by itself.";

/** The line under "Post my clips by themselves". `next`: the next run (while on); unknown yet, the next full hour. */
export function switchLine(a: Pick<AutoPostSettings, "on" | "practice">, next: string | null | undefined, now = Date.now()): string {
  if (!a.on) return OFF_LINE;
  const at = timeWords(next ?? nextFullHour(now));
  return a.practice ? `On, practising. Next practice: ${at}. Nothing gets sent.` : `On. Next: ${at}.`;
}

// ---------- Where they go (§46.2 item 3) ----------

export const NOTHING_SET_UP = "Nothing is set up to post to. Set up a place first.";
export const TIKTOK_YOURSELF_LINE = "TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself.";

/** "YouTube, Instagram and Facebook" in the one platform order. */
export function placeNames(places: readonly Platform[]): string {
  const names = PLATFORM_ORDER.filter((p) => places.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** "Goes to YouTube, Instagram and Facebook.", or that nothing is set up (then runs post nothing). */
export function placesLine(places: readonly Platform[]): string {
  return places.length ? `Goes to ${placeNames(places)}.` : NOTHING_SET_UP;
}

/** One line per place a run leaves out. */
export function leftOutLine(platform: Platform, reason: "tiktok_yourself" | "not_set_up"): string {
  return reason === "tiktok_yourself" ? TIKTOK_YOURSELF_LINE : `${PLATFORM_LABEL[platform]}: not set up yet.`;
}

// ---------- Next up, Recent (§46.2 items 4 and 8) ----------

export const NEXT_EMPTY = "Nothing in Review. New clips join the line when they are made.";

const quoted = (hook: string) => `“${hook}”`;

/** A Private test post's place words in Recent: "YouTube (only you)". */
export const PRIVATE_TEST_PLACE: Partial<Record<Platform, string>> = {
  youtube: "only you",
  facebook: "draft",
  instagram: "checked, not published",
};

/** A Private test's places in the order §46.2 says them (YouTube, Facebook, Instagram), any other after. */
const PRIVATE_TEST_ORDER: readonly Platform[] = [
  "youtube",
  "facebook",
  "instagram",
  ...PLATFORM_ORDER.filter((p) => p !== "youtube" && p !== "facebook" && p !== "instagram"),
];

export interface RunLine {
  /** Unique inside the run. */
  key: string;
  text: string;
  /** The posted places with a live link (each gets Open). */
  opens: { platform: Platform; url: string }[];
}

/** ✓ posted, ✗ didn't work, … still on its way. */
const mark = (status: Post["status"]) => (status === "posted" ? "✓" : status === "failed" ? "✗" : "…");

/**
 * A run's lines in Recent, one per clip (a run that sent nothing has one line with its note):
 * "Sun 10:00 · “hook”: YouTube ✓ Instagram ✓ Facebook ✗"; "Sun 05:00 · Nothing in Review, so nothing posted.";
 * "Sun 05:00 · Practice: would post “hook” to YouTube, Instagram and Facebook."; "Private test · “hook”: YouTube (only
 * you) · Facebook (draft) · Instagram (checked, not published)".
 */
export function runLines(run: AutoRun): RunLine[] {
  const lead = run.mode === "private" ? "Private test" : timeWords(run.at);
  if (!run.clips.length) return [{ key: run.runId, text: `${lead} · ${run.note ?? "Nothing posted."}`, opens: [] }];
  return run.clips.map((c, i) => {
    const key = `${run.runId}:${c.clipId}:${i}`;
    if (c.outcome === "skipped") return { key, text: `${lead} · ${quoted(c.hook)}: ${c.reason ?? "Not sent."}`, opens: [] };
    if (run.mode === "practice" || c.outcome === "would_send") {
      const where = c.places.length ? ` to ${placeNames(c.places)}` : "";
      return { key, text: `${lead} · Practice: would post ${quoted(c.hook)}${where}.`, opens: [] };
    }
    const posts = (run.mode === "private" ? PRIVATE_TEST_ORDER : PLATFORM_ORDER).flatMap((p) => c.posts.filter((x) => x.platform === p));
    const opens = posts.filter((p) => p.status === "posted" && p.url).map((p) => ({ platform: p.platform, url: p.url! }));
    if (run.mode === "private") {
      const parts = posts.map((p) =>
        p.status === "posted" ? `${PLATFORM_LABEL[p.platform]} (${PRIVATE_TEST_PLACE[p.platform] ?? "only you"})` : `${PLATFORM_LABEL[p.platform]} ${mark(p.status)}`,
      );
      return { key, text: `${lead} · ${quoted(c.hook)}: ${parts.join(" · ")}`, opens };
    }
    const parts = posts.map((p) => `${PLATFORM_LABEL[p.platform]} ${mark(p.status)}`);
    return { key, text: `${lead} · ${quoted(c.hook)}${parts.length ? `: ${parts.join(" ")}` : ""}`, opens };
  });
}

// ---------- Review, Home (§46.2) ----------

/** The Review card's one quiet line while auto-posting is on: in Next up, waiting, or nothing. */
export function reviewLine(
  a: Pick<AutoPostSettings, "on" | "practice">,
  next: { runAt?: string } | undefined,
  waiting: { reason: string } | undefined,
): string | null {
  if (!a.on) return null;
  if (next) {
    const at = next.runAt ? timeWords(next.runAt) : "";
    return a.practice ? `Practice picks it ${at}. Nothing gets sent.` : `Goes up by itself ${at}. Throw it away to stop it.`;
  }
  if (waiting) return `Auto-posting skips this one: ${waiting.reason} Upload it yourself.`;
  return null;
}

export const HOME_HINT = "Nothing gets posted until you tap Upload.";

/** Home's hint under Make clips: unchanged while off or practising. */
export function homeHint(stored: Partial<AutoPostSettings> | undefined): string {
  const a = autoPostOf(stored);
  if (!a.on || a.practice) return HOME_HINT;
  return `Auto-posting is on: your clips go up by themselves every ${hoursWords(a.everyHours)}, oldest first.`;
}

// ---------- Library and the clip page (§46.2) ----------

/** What a Private test post says instead of "Uploaded". */
export const PRIVATE_TEST_LABEL: Partial<Record<Platform, string>> = {
  youtube: "Private test · only you",
  facebook: "Private test · draft on your Page",
  instagram: "Private test · checked, not published",
};

/**
 * A post row's state words: an auto-posted post adds "· by auto-posting" after its state; a Private test post that went
 * up says where it waits ("Private test · only you") instead of "Uploaded". A Private test post that did not go up (yet)
 * is an auto-posted post like any other ("Didn't work · by auto-posting"). Everything else keeps `label`.
 */
export function autoPostLabel(p: Pick<Post, "platform" | "status" | "auto" | "test" | "by">, label: string): string {
  if (p.by === "you") return label;
  if (p.test === "private" && p.status === "posted") return PRIVATE_TEST_LABEL[p.platform] ?? label;
  return p.auto || p.test === "private" ? `${label} · by auto-posting` : label;
}

/**
 * Didn't work's Try again for one place (§46.2 item 6) follows the Library's own rule (§33): only once the clip's other
 * places are done. While the clip is still posting them, a retry does nothing (the server answers with the clip as it
 * is). A clip whose every place failed may try one place again too (the server's Try again takes it with `platforms`).
 */
export function canTryPlaceAgain(clip: Pick<Clip, "status">, post: Pick<Post, "platform" | "status" | "error">): boolean {
  return post.status === "failed" && (clip.status === "posted" || clip.status === "failed") && !failedForPublicAccount(post);
}

/** The clip page's chip, from the clip's `auto` (its stacks carry no post fields). */
export function autoPerfLabel(
  status: PerfStatus,
  platform: Platform,
  auto: { test?: "private" } | undefined,
  by: "you" | undefined,
  label: string,
): string {
  if (!auto || by === "you" || status === "not_posted" || status === "waiting_for_connection") return label;
  const posted = status === "posted" || status === "posted_private";
  return autoPostLabel({ platform, status: posted ? "posted" : status === "failed" ? "failed" : "queued", auto: true, test: auto.test }, label);
}

/** A Private test post has no numbers: the clip page shows no numbers or calm line for it. */
export function isPrivateTest(status: PerfStatus, auto: { test?: "private" } | undefined, by: "you" | undefined): boolean {
  return auto?.test === "private" && by !== "you" && (status === "posted" || status === "posted_private");
}
