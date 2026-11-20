import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { Api, Captions, Clip, Platform, Post, TikTokPostOptions } from "../api/types.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER, plural } from "./format.ts";

/** Shown when Upload is pressed again while the first Upload may still be finishing (the API answers 409). */
export const STILL_WORKING = "Still working on it. Try again in a minute.";

/** The API's TikTok post error when the privacy picked earlier is no longer offered (§17.6). */
export const TIKTOK_PICK_AGAIN = "Pick who can see it on TikTok again, then press Try again.";

/** A failed clip whose TikTok post needs new sheet choices: Try again opens the TikTok sheet first. */
export function needsTikTokChoices(posts: Post[]): boolean {
  return posts.some((p) => p.platform === "tiktok" && p.status === "failed" && p.error === TIKTOK_PICK_AGAIN);
}

export type UploadOutcome =
  | { kind: "uploading"; clip: Clip; posts: Post[] }
  /** Upload was tapped but posting has not started yet, and the server is not ready to start it again. */
  | { kind: "busy" }
  /** The clip can no longer be uploaded (thrown away, or gone). `message` is a sentence for the owner. */
  | { kind: "gone"; message: string };

/**
 * A clip that was uploaded but never started posting: confirmed with no posts. Tapping Upload again
 * (POST /confirm on a confirmed clip) finishes that work once the first attempt is a minute old.
 */
export function needsUploadAgain(clip: Clip, posts: Post[]): boolean {
  return clip.status === "confirmed" && !posts.some((p) => p.clipId === clip.clipId);
}

/**
 * Calls Confirm with the places picked (§33), and on a 409 works out what it meant: uploaded elsewhere (posts exist),
 * thrown away, or still finishing an earlier Upload. Any other failure is thrown as usual.
 */
export async function uploadClip(
  a: Api,
  clipId: string,
  captions?: Partial<Captions>,
  tiktok?: TikTokPostOptions,
  platforms?: Platform[],
): Promise<UploadOutcome> {
  try {
    const { clip, posts } = await a.confirmClip(clipId, captions, tiktok, platforms);
    return { kind: "uploading", clip, posts };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    let clip: Clip;
    let posts: Post[];
    try {
      [clip, posts] = await Promise.all([a.getClip(clipId), a.listPosts(clipId)]);
    } catch {
      return { kind: "busy" };
    }
    if (clip.status === "declined" || clip.status === "review") return { kind: "gone", message: friendlyMessage(e) };
    if (posts.length) return { kind: "uploading", clip, posts };
    return { kind: "busy" };
  }
}

/** The toast after a successful Upload. */
export function uploadedMessage(posts: Post[]): string {
  const waiting = posts.filter((p) => p.status === "pending_integration").length;
  if (waiting === posts.length) return "Saved! It uploads as soon as your accounts are set up.";
  const going = posts.length - waiting;
  return going === 1 ? `Uploading to ${PLATFORM_LABEL[posts.find((p) => p.status !== "pending_integration")!.platform]}!` : `Uploading to ${plural(going, "place")}!`;
}

/** The Upload button's words: "Upload to YouTube" for one place, "Upload to 4" for more, "Upload" for none. */
export function uploadLabel(chosen: readonly Platform[]): string {
  if (chosen.length === 1) return `Upload to ${PLATFORM_LABEL[chosen[0]!]}`;
  return chosen.length ? `Upload to ${chosen.length}` : "Upload";
}

/** "YouTube, TikTok, Instagram and Facebook". */
export function placeList(chosen: readonly Platform[]): string {
  const names = PLATFORM_ORDER.filter((p) => chosen.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** localStorage key: the places picked on this device's last Upload (§33). */
export const UPLOAD_TO_KEY = "cf-upload-to";

/**
 * Which places start switched on (§33): this device's last choice, minus places no longer set up; with none saved,
 * Where clips go minus places not set up; when that leaves nothing, every place that is set up.
 */
export function defaultUploadTo(ready: readonly Platform[], saved: readonly Platform[] | null, settings: readonly Platform[] | undefined): Platform[] {
  const pick = (list: readonly Platform[]) => PLATFORM_ORDER.filter((p) => ready.includes(p) && list.includes(p));
  if (saved) {
    const kept = pick(saved);
    if (kept.length) return kept;
  }
  const fromSettings = settings ? pick(settings) : [];
  return fromSettings.length ? fromSettings : PLATFORM_ORDER.filter((p) => ready.includes(p));
}

export function readUploadTo(): Platform[] | null {
  try {
    const raw = localStorage.getItem(UPLOAD_TO_KEY);
    const list: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? PLATFORM_ORDER.filter((p) => list.includes(p)) : null;
  } catch {
    return null;
  }
}

export function saveUploadTo(chosen: readonly Platform[]): void {
  try {
    localStorage.setItem(UPLOAD_TO_KEY, JSON.stringify(chosen));
  } catch {
    // Private window or blocked storage: the choice is simply not remembered.
  }
}
