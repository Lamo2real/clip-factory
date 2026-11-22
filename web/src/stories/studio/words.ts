// The plain words the Lamo Stories studio screens show (docs/CONTRACTS.md §45.16.5, §45.16.6). Kid-proof: short
// sentences, everyday words, one name for each thing.
import { ApiError } from "../../api/errors.ts";
import type { ErrorAccount, IdeaCategory, Platform, PublishingJob, StepKey, StoryStatus, VideoConcept } from "../api/types.ts";

export const CATEGORY_LABEL: Record<IdeaCategory, string> = {
  driving_safety: "Driving safety",
  everyday_skills: "Everyday skills",
  comedy: "Funny",
  explainer: "How it works",
};

/** One line under each category's big button. */
export const CATEGORY_LINE: Record<IdeaCategory, string> = {
  driving_safety: "What to do when the road gets tricky",
  everyday_skills: "Handy things for every day",
  comedy: "Silly moments with your characters",
  explainer: "Show how something works",
};

export const CATEGORIES: IdeaCategory[] = ["driving_safety", "everyday_skills", "comedy", "explainer"];

export const STATUS_LABEL: Record<StoryStatus, string> = {
  draft: "Getting ready",
  producing: "Being made",
  needs_check: "Check the facts",
  review: "Ready to watch",
  approved: "Approved",
  rejected: "Not used",
  published: "Posted",
  failed: "Stopped",
};

/** The colour of each status chip. */
export const STATUS_TONE: Record<StoryStatus, "sun" | "coral" | "mint" | "sky" | "plain"> = {
  draft: "plain",
  producing: "sky",
  needs_check: "coral",
  review: "sun",
  approved: "mint",
  rejected: "plain",
  published: "mint",
  failed: "coral",
};

export const TONE_LABEL: Record<VideoConcept["tone"], string> = {
  funny: "Funny",
  calm: "Calm",
  tense_then_relief: "Scary, then phew",
  wholesome: "Warm and kind",
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  x: "X",
};

export const PUBLISH_LABEL: Record<PublishingJob["publishingStatus"], string> = {
  queued: "Waiting",
  publishing: "Sending",
  posted: "Posted",
  failed: "Did not post",
  needs_attention: "Needs you",
};

export const PUBLISH_TONE: Record<PublishingJob["publishingStatus"], "sun" | "coral" | "mint" | "sky" | "plain"> = {
  queued: "plain",
  publishing: "sky",
  posted: "mint",
  failed: "coral",
  needs_attention: "coral",
};

/** A running production step, as a "now doing" line. */
export const STEP_WORD: Record<StepKey, string> = {
  storyboard: "Writing the story",
  safety: "Checking the facts",
  scenes: "Drawing the scenes",
  animation: "Animating",
  sound: "Adding sounds and music",
  captions: "Adding captions",
  assemble: "Putting it together",
  preview: "Getting it ready to watch",
};

/** The sentence a safety idea or story shows when no checked advice covers it (CONTRACTS §45.11.5). */
export const NO_GUIDANCE =
  "Lamo Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet.";

/** A failed call as one sentence the owner can read. */
export function say(e: unknown, fallback = "Something went wrong. Try again in a moment."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/** True when the server said the thing changed meanwhile (409). */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.code === "conflict";
}

/**
 * The account a publishing 409 names (`error.account`, CONTRACTS §45.34: the account changed, or Lamo Stories cannot
 * tell this TikTok from Lamo Clips' own), which Lamo Stories' client keeps on its ApiError; null for any other error.
 */
export function accountOf(e: unknown): ErrorAccount | null {
  if (!(e instanceof ApiError) || e.code !== "conflict") return null;
  const a = (e as ApiError & { account?: Partial<ErrorAccount> }).account;
  if (!a || typeof a.externalAccountId !== "string" || !a.externalAccountId) return null;
  return { externalAccountId: a.externalAccountId, accountName: typeof a.accountName === "string" ? a.accountName : null, handle: typeof a.handle === "string" ? a.handle : null };
}

/** "Lamo Stories (@lamo.stories)": an account's name and handle, as the owner reads them. */
export function accountWords(a: Pick<ErrorAccount, "accountName" | "handle" | "externalAccountId">): string {
  const name = a.accountName || a.handle || a.externalAccountId;
  const handle = a.handle && a.handle !== name ? ` (${a.handle.startsWith("@") ? a.handle : `@${a.handle}`})` : "";
  return `${name}${handle}`;
}

/** "45 seconds", "1 minute 5 seconds". */
export function seconds(n: number): string {
  const s = Math.round(n);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} minute${m === 1 ? "" : "s"}${r ? ` ${r} second${r === 1 ? "" : "s"}` : ""}`;
}

/** "0:07" for a time inside a video. */
export function clock(n: number): string {
  const s = Math.max(0, Math.round(n * 10) / 10);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const tenth = Math.round((r - whole) * 10);
  return `${m}:${String(whole).padStart(2, "0")}${tenth ? `.${tenth}` : ""}`;
}

/** "3 videos", "1 video", "no videos yet". */
export function count(n: number, one: string, many = `${one}s`): string {
  if (n === 0) return `no ${many} yet`;
  return `${n} ${n === 1 ? one : many}`;
}

/** Big numbers the short way: 1,234 → "1.2K". */
export function shortNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** "today", "yesterday", "3 days ago" (no clock times: plain words). */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.round((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// ---------- Helpers and the storage place in words (§45.35 D21: never a raw id or an s3:// path) ----------

/** Each helper a video is made with, by its provider id, in the words Settings › Video uses. */
export const PROVIDER_WORDS: Record<string, string> = {
  "bedrock-claude": "Claude on Amazon Bedrock",
  "builtin-rig": "Built-in drawing",
  "builtin-2d": "Built-in animator",
  "builtin-synth": "Built-in sounds",
  "nova-canvas": "Amazon Nova Canvas",
  "nova-reel": "Amazon Nova Reel",
};

/** A helper's name; an id this list does not know yet is never shown as it is. */
export function providerName(id: string | null | undefined): string {
  return (id && PROVIDER_WORDS[id]) || "Another helper";
}

/** What each kind of helper does, for its row ("Writing: Claude on Amazon Bedrock"). */
export const HELPER_KIND: Record<string, string> = { writer: "Writing", images: "Pictures", animation: "Animation", video: "Animation", audio: "Sound" };

/** The helpers of a run in one line: "Claude on Amazon Bedrock, Built-in drawing, …" (each named once). */
export function helpersLine(providers: Record<string, string> | null | undefined): string {
  const names = Object.values(providers ?? {}).map(providerName);
  return [...new Set(names)].join(", ");
}

/** Where a video's files are kept, in words (the exact folder is behind "Technical details"). */
export const STORAGE_WORDS = "Lamo Stories' own folder in Clip Factory's media storage";

/** A checked advice topic's own title ("Skid recovery on ice"); its id is never shown. */
export function topicTitle(topics: readonly { id: string; title: string }[] | null | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  return topics?.find((t) => t.id === id)?.title ?? "Checked road advice";
}
