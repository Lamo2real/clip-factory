// Posted on TikTok by the owner himself (docs/CONTRACTS.md §42). TikTok's API keeps Clip Factory's own uploads "Only
// me" until TikTok approves the app; since ADR-85 the owner's Mac posts them for everyone (lib/tiktokMac.ts), and the
// manual sheet is gone. What stays: the rules for which clips are not on TikTok yet, and the Add link of a post he (or
// his Mac) made without its link. Pure helpers here (tested without a browser).
import type { Clip, PlatformSetup, Post } from "../api/types.ts";

/**
 * Where a clip's TikTok stands. `offer`: not on TikTok for everyone (the Mac can take it). `uploading`: Clip Factory
 * is uploading it right now. `public`: already on TikTok for everyone through Clip Factory. `yours`: he posted it (or
 * his Mac did, §47). `mac`: his Mac posts it (§47).
 */
export type TikTokState = "offer" | "uploading" | "public" | "yours" | "mac";

export function tiktokState(posts: Post[]): TikTokState {
  const post = posts.find((p) => p.platform === "tiktok");
  if (!post) return "offer";
  if (post.by === "you") return "yours";
  if (post.status === "mac") return "mac";
  if (post.status === "queued") return "uploading";
  if (post.status === "posted" && post.privacy === "public") return "public";
  return "offer";
}

/** A kept clip (uploaded, not still in Review or thrown away) whose TikTok is not on TikTok for everyone yet. */
export function canPostYourself(clip: Clip, posts: Post[]): boolean {
  const kept = clip.status === "confirmed" || clip.status === "publishing" || clip.status === "posted" || clip.status === "failed";
  if (!kept) return false;
  // Posts are made the moment Upload goes through; until then there is nothing to mark yet.
  if (clip.status === "confirmed" && !posts.length) return false;
  return tiktokState(posts) === "offer";
}

/**
 * Has TikTok approved Clip Factory's own public uploads? Both the app review (the owner's pick in setup step 22) and the
 * posting audit must say ok: the audit gate alone is read from the creator's privacy options, which a public account
 * may list before any audit. Unknown counts as no.
 */
export function tiktokAudited(setups: readonly PlatformSetup[] | undefined): boolean {
  const tiktok = setups?.find((s) => s.platform === "tiktok");
  const ok = (key: string) => tiktok?.gates.some((g) => g.key === key && g.state === "ok") ?? false;
  return ok("app_review") && ok("posting_audit");
}

/**
 * The sentence posts refused for the public account kept from before 23 Nov (§42; a legacy, never shown): matched word
 * for word, never change it. What the owner reads is postError's.
 */
export const TIKTOK_PRIVATE_ONLY = "TikTok only takes Clip Factory's uploads on a private account until it approves the app. Tap Post it yourself to post it for everyone.";
const TIKTOK_PRIVATE_BEFORE = "Make your TikTok account private (Setup step 3), then press Try again.";
/**
 * What a post refused for the public account says (postError), and since 23 Nov the sentence the server stores on
 * one (platforms/errors.TIKTOK_PRIVATE_ONLY), word for word.
 */
export const TIKTOK_PUBLIC_REFUSED = "TikTok only takes Clip Factory's own uploads on a private account for now, so your Mac posts it for everyone.";
/** Every sentence a post refused for the public account may hold: the two from before, and today's. */
const PUBLIC_REFUSED: readonly string[] = [TIKTOK_PRIVATE_ONLY, TIKTOK_PRIVATE_BEFORE, TIKTOK_PUBLIC_REFUSED];

/** A TikTok post that failed only because the account is public: his Mac posts it, Try again would fail again. */
export function failedForPublicAccount(post: Pick<Post, "platform" | "status" | "error">): boolean {
  return post.platform === "tiktok" && post.status === "failed" && PUBLIC_REFUSED.includes(post.error ?? "");
}

/** The words to show for a post's error: every public-account sentence reads as today's. */
export function postError(error: string): string {
  return PUBLIC_REFUSED.includes(error) ? TIKTOK_PUBLIC_REFUSED : error;
}

/** Review, TikTok ticked before TikTok approved the app while Your Mac posts TikTok is off: one line that points to it. */
export const TIKTOK_PUBLIC_HINT = "TikTok: turn on Your Mac posts TikTok so it posts for everyone.";

/** A file name for the video (the Mac helper's upload, §47.3). */
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
