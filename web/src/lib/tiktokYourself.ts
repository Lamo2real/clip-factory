// Post it on TikTok yourself (docs/CONTRACTS.md §40). TikTok's API keeps Clip Factory's own uploads "Only me" until
// TikTok approves the app, so the owner hands the clip to TikTok and taps Post there himself, picking Everyone.
// Pure helpers here (tested without a browser); the sheet is screens/library/PostYourself.tsx.
import type { Clip, PlatformPerformance, Post } from "../api/types.ts";
import type { DeviceOs } from "./device.ts";

/** TikTok's own page for posting from a computer (TikTok Studio's uploader). */
export const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";

/** How this device hands the video over. */
export type HandOff =
  /** A phone that can share a video file: the share menu, with TikTok in it (and Save Video). */
  | "share"
  /** A computer, or a phone that cannot share files: save the file, then open TikTok. */
  | "save";

export function handOffFor(os: DeviceOs, canShareFiles: boolean): HandOff {
  return (os === "ios" || os === "android") && canShareFiles ? "share" : "save";
}

/** Can this browser put a video file in the share menu? (Not in the Mac app's window, nor in most desktop browsers.) */
export function canShareVideo(): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.canShare !== "function" || typeof File === "undefined") return false;
    return navigator.canShare({
      files: [new File([new Uint8Array(1)], "clip.mp4", { type: "video/mp4" })],
    });
  } catch {
    return false;
  }
}

/**
 * Where a clip's TikTok stands for this button. `offer`: show Post on TikTok yourself. `uploading`: Clip Factory is
 * uploading it right now. `public`: already on TikTok for everyone through Clip Factory. `yours`: he posted it.
 */
export type TikTokState = "offer" | "uploading" | "public" | "yours";

export function tiktokState(posts: Post[]): TikTokState {
  const post = posts.find((p) => p.platform === "tiktok");
  if (!post) return "offer";
  if (post.by === "you") return "yours";
  if (post.status === "queued") return "uploading";
  if (post.status === "posted" && post.privacy === "public") return "public";
  return "offer";
}

/** The Library and the clip page offer it on clips that were uploaded (not ones still in Review or thrown away). */
export function canPostYourself(clip: Clip, posts: Post[]): boolean {
  const kept = clip.status === "confirmed" || clip.status === "publishing" || clip.status === "posted" || clip.status === "failed";
  if (!kept) return false;
  // Posts are made the moment Upload goes through; until then there is nothing to mark yet.
  if (clip.status === "confirmed" && !posts.length) return false;
  return tiktokState(posts) === "offer";
}

/** The same question on the clip page, which has one row per platform instead of posts (§16.2). */
export function canPostYourselfHere(clip: Clip, tiktok: Pick<PlatformPerformance, "status" | "by"> | undefined): boolean {
  const kept = clip.status === "confirmed" || clip.status === "publishing" || clip.status === "posted" || clip.status === "failed";
  if (!kept || !tiktok || tiktok.by === "you") return false;
  return tiktok.status !== "posting" && tiktok.status !== "posted";
}

/** Is this a campaign clip (a paid partnership on TikTok)? */
export function isPaid(clip: Clip): boolean {
  return !!clip.campaignId;
}

/**
 * The steps the sheet shows, in TikTok's own words, for this device. TikTok is rarely in the share menu of a web app
 * (§40.5), so the phone saves the video and posts it with TikTok's own +. TikTok starts a new post with the last post's
 * privacy, which after Clip Factory's Only me uploads is Only you: the step says to check Everyone every time.
 */
export function steps(mode: HandOff, paid: boolean): string[] {
  const out =
    mode === "share"
      ? [
          "Tap **Save to my phone**, then pick **Save Video**. (TikTok in the list? You can pick it instead.)",
          "Open TikTok. Tap **+**, then **Upload**, pick the clip and tap **Next**.",
          "Tap the caption box, hold it and tap **Paste**. The caption is copied.",
          "Check it says **Everyone** under who can watch. Turn on **Comments**, **Duet** and **Stitch**.",
        ]
      : [
          "Click **Save the video**. It goes to your Downloads.",
          "Click **Open TikTok**, sign in, and drop the video in.",
          "Click the caption box and press **⌘V** (Ctrl+V on Windows). The caption is copied.",
          "Pick **Everyone** under who can watch this video. Turn on **Comment**, **Duet** and **Stitch**.",
        ];
  if (paid)
    out.push(
      mode === "share"
        ? "This clip is for a paid campaign: turn on **Disclose post content**, then **Branded content**."
        : "This clip is for a paid campaign: click **Show more**, turn on **Disclose post content**, then **Branded content**.",
    );
  out.push(mode === "share" ? "Tap **Post**. Then come back here and tap **I posted it**." : "Click **Post**. Then come back here and click **I posted it**.");
  return out;
}

/** A file name for the video in the share menu and in Photos. */
export function videoFileName(hook: string): string {
  const base = hook
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `clip-factory-${base || "clip"}.mp4`;
}

/** Does the pasted text hold a TikTok link at all? (The API reads it properly; this only keeps the button honest.) */
export function looksLikeTikTokLink(text: string): boolean {
  return /(^|[^A-Za-z0-9.-])(https?:\/\/)?([a-z0-9-]+\.)*tiktok\.com\/\S+/i.test(text);
}
