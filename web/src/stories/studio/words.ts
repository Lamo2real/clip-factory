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
  "Clip Stories only makes driving-safety videos from checked advice, and this one isn't in the list yet.";

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
 * tell this TikTok from Clip Factory's own), which Lamo Stories' client keeps on its ApiError; null for any other error.
 */
export function accountOf(e: unknown): ErrorAccount | null {
  if (!(e instanceof ApiError) || e.code !== "conflict") return null;
  const a = (e as ApiError & { account?: Partial<ErrorAccount> }).account;
  if (!a || typeof a.externalAccountId !== "string" || !a.externalAccountId) return null;
  return { externalAccountId: a.externalAccountId, accountName: typeof a.accountName === "string" ? a.accountName : null, handle: typeof a.handle === "string" ? a.handle : null };
}

/**
 * "this TikTok account (Lamo Stories)": an account named by its place first, so a sentence still reads right when the
 * account itself is called "Lamo Stories" (§45.36 E13); "this TikTok account" when it has no name.
 */
export function thisAccount(platform: Platform, name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n ? `this ${PLATFORM_LABEL[platform]} account (${n})` : `this ${PLATFORM_LABEL[platform]} account`;
}

/**
 * True when a stopped post (or a sentence) is an account problem the owner fixes in Social accounts (§45.36 E9): the
 * sentence names that page, the API's own test (dashboard._post_href: needs connecting again, not connected, the app
 * keys changed, Clip Factory's own account).
 */
export function accountProblem(job: Pick<PublishingJob, "publishingStatus" | "error"> | string | null | undefined): boolean {
  if (!job) return false;
  if (typeof job === "string") return /Social accounts/i.test(job);
  const stuck = job.publishingStatus === "failed" || job.publishingStatus === "needs_attention";
  return stuck && /Social accounts/i.test(job.error ?? "");
}

/**
 * "Lamo Stories (@lamo.stories)": an account's name and handle, as the owner reads them; null for an account with
 * neither, so a raw platform id is never a first line (§45.36 E14: it stays behind "Technical details").
 */
export function accountShown(a: Pick<ErrorAccount, "accountName" | "handle">): string | null {
  const name = a.accountName || a.handle;
  if (!name) return null;
  const handle = a.handle && a.handle !== name ? ` (${a.handle.startsWith("@") ? a.handle : `@${a.handle}`})` : "";
  return `${name}${handle}`;
}

/** "Lamo Stories (@lamo.stories)", else the account's id (for a place that must say which one it is). */
export function accountWords(a: Pick<ErrorAccount, "accountName" | "handle" | "externalAccountId">): string {
  return accountShown(a) ?? a.externalAccountId;
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
  // §45.37's makers
  stability: "Stability AI pictures",
  "luma-ray": "Luma AI Ray2",
  "own-images": "Your own picture model",
  "own-video": "Your own video model",
  "own-sound": "Your own sound model",
  elevenlabs: "ElevenLabs sound effects and music",
  polly: "A spoken voice (Amazon Polly)",
};

/** The writer id of a model the owner added that is not Anthropic's (§45.36 E7): "bedrock-model:{key}". */
export const BEDROCK_MODEL = "bedrock-model:";

/** The parts of a model a helper's name is made of (its label, who makes it and who runs it, §45.35 D8). */
export type HelperModel = { label: string; provider?: string | null; host?: string | null };

/** Finds a model by its key (the screen's own list), for a helper named after the model that did the work. */
export type ModelLookup = (key: string) => HelperModel | null | undefined;

/** "Meta Llama 4 Maverick on Amazon Bedrock": a model as a helper, by its maker and label (never "Meta Meta …"). */
export function modelHelperWords(m: HelperModel): string {
  const maker = (m.provider ?? "").trim();
  const host = (m.host ?? "").trim() || "Amazon Bedrock";
  const label = m.label.trim();
  const named = !maker || maker === host || label.toLowerCase().startsWith(maker.toLowerCase()) ? label : `${maker} ${label}`;
  return `${named} on ${host}`;
}

/**
 * A helper's name; an id this list does not know yet is never shown as it is. "bedrock-model:{key}" (an added model
 * that is not Anthropic's did the work, §45.36 E7) is named from that model, or "A model on Amazon Bedrock" when the
 * screen does not know it (any more).
 */
export function providerName(id: string | null | undefined, model?: ModelLookup): string {
  if (id && id.startsWith(BEDROCK_MODEL)) {
    const m = model?.(id.slice(BEDROCK_MODEL.length));
    return m ? modelHelperWords(m) : "A model on Amazon Bedrock";
  }
  return (id && PROVIDER_WORDS[id]) || "Another helper";
}

/**
 * One helper of a run by its kind (§45.36 E7): the writer is named from the model that really wrote the storyboard
 * when that is not Anthropic's (a run recorded before the agent said so still says "bedrock-claude"), so the page never
 * says "Claude" next to a Writer line that names another maker's model.
 */
export function helperName(kind: string, id: string | null | undefined, writerModel?: string | null, model?: ModelLookup): string {
  if (kind === "writer" && id === "bedrock-claude" && writerModel) {
    const m = model?.(writerModel);
    const maker = (m?.provider ?? "").trim().toLowerCase();
    if (m && maker && maker !== "anthropic" && maker !== "amazon bedrock") return modelHelperWords(m);
  }
  return providerName(id, model);
}

/** What each kind of helper does, for its row ("Writing: Claude on Amazon Bedrock"). */
export const HELPER_KIND: Record<string, string> = { writer: "Writing", images: "Pictures", animation: "Animation", video: "Animation", audio: "Sound" };

/** The helpers of a run in one line: "Claude on Amazon Bedrock, Built-in drawing, …" (each named once). */
export function helpersLine(providers: Record<string, string> | null | undefined, writerModel?: string | null, model?: ModelLookup): string {
  const names = Object.entries(providers ?? {}).map(([kind, id]) => helperName(kind, id, writerModel, model));
  return [...new Set(names)].join(", ");
}

/** Where a video's files are kept, in words (the exact folder is behind "Technical details"). */
export const STORAGE_WORDS = "Clip Stories' own folder in Clip Factory's media storage";

/** A checked advice topic's own title ("Skid recovery on ice"); its id is never shown. */
export function topicTitle(topics: readonly { id: string; title: string }[] | null | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  return topics?.find((t) => t.id === id)?.title ?? "Checked road advice";
}
