import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { Api, Captions, Clip, Post, TikTokPostOptions } from "../api/types.ts";
import { plural } from "./format.ts";

/** Shown when Keep is pressed again while the first Keep may still be finishing (the API answers 409). */
export const STILL_WORKING = "Still working on it. Try again in a minute.";

/** The API's TikTok post error when the privacy picked earlier is no longer offered (§17.6). */
export const TIKTOK_PICK_AGAIN = "Pick who can see it on TikTok again, then press Try again.";

/** A failed clip whose TikTok post needs new sheet choices: Try again opens the TikTok sheet first. */
export function needsTikTokChoices(posts: Post[]): boolean {
  return posts.some((p) => p.platform === "tiktok" && p.status === "failed" && p.error === TIKTOK_PICK_AGAIN);
}

export type KeepOutcome =
  | { kind: "kept"; clip: Clip; posts: Post[] }
  /** The clip is kept but posting has not started yet, and the server is not ready to start it again. */
  | { kind: "busy" }
  /** The clip can no longer be kept (thrown away, or gone). `message` is a sentence for the owner. */
  | { kind: "gone"; message: string };

/**
 * A clip that was kept but never started posting: confirmed with no posts. Tapping Keep again
 * (POST /confirm on a confirmed clip) finishes that work once the first attempt is a minute old.
 */
export function needsKeepAgain(clip: Clip, posts: Post[]): boolean {
  return clip.status === "confirmed" && !posts.some((p) => p.clipId === clip.clipId);
}

/**
 * Calls Confirm, and on a 409 works out what it meant: kept elsewhere (posts exist), thrown away, or still
 * finishing an earlier Keep. Any other failure is thrown as usual.
 */
export async function keepClip(
  a: Api,
  clipId: string,
  captions?: Partial<Captions>,
  tiktok?: TikTokPostOptions,
): Promise<KeepOutcome> {
  try {
    const { clip, posts } = await a.confirmClip(clipId, captions, tiktok);
    return { kind: "kept", clip, posts };
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
    if (posts.length) return { kind: "kept", clip, posts };
    return { kind: "busy" };
  }
}

/** The toast after a successful Keep. */
export function keptMessage(posts: Post[]): string {
  const waiting = posts.filter((p) => p.status === "pending_integration").length;
  return waiting === posts.length
    ? "Kept! It posts as soon as your accounts are connected."
    : `Kept! Posting to ${plural(posts.length - waiting, "platform")}.`;
}
