// My settings (docs/CONTRACTS.md §36): the owner's own post choices per platform, stored in Settings as postPreset,
// and the per-clip choices each Review row sends with Upload. My settings never mark a clip as made for kids.
import type { ClipPostOptions, Platform, PostPreset, XReplies, YouTubeClipOptions, YoutubePrivacy } from "../api/types.ts";

export const DEFAULT_PRESET: PostPreset = {
  youtube: { category: "24", notifySubscribers: true, embeddable: true },
  tiktok: { privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true },
  instagram: { shareToFeed: true },
  facebook: {},
  x: { replies: "everyone" },
};

/** YouTube's "who can see it", short enough for one bar on a phone. */
export const YT_WHO: Record<YoutubePrivacy, string> = { public: "Everyone", unlisted: "Link only", private: "Only me" };

export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: "24", label: "Entertainment" },
  { id: "20", label: "Gaming" },
  { id: "23", label: "Comedy" },
  { id: "22", label: "People & Blogs" },
  { id: "17", label: "Sports" },
];
export const X_REPLIES_LABEL: Record<XReplies, string> = {
  everyone: "Everyone",
  following: "People you follow",
  mentionedUsers: "Only people you mention",
  verified: "Verified accounts",
};

/** The stored preset over the defaults (an old server, or a platform never saved, reads the defaults). */
export function presetOf(stored: Partial<PostPreset> | undefined): PostPreset {
  return {
    youtube: { ...DEFAULT_PRESET.youtube, ...stored?.youtube },
    tiktok: { ...DEFAULT_PRESET.tiktok, ...stored?.tiktok },
    instagram: { ...DEFAULT_PRESET.instagram, ...stored?.instagram },
    facebook: {},
    x: { ...DEFAULT_PRESET.x, ...stored?.x },
  };
}

/** What one card holds for YouTube, Instagram and X (TikTok's live in its own choices). */
export interface CardOptions {
  youtube: YouTubeClipOptions;
  instagram: PostPreset["instagram"];
  x: PostPreset["x"];
}

/** The card's choices from My settings: YouTube's privacy is the saved youtubePrivacy, made for kids is always No. */
export function cardOptionsFrom(preset: PostPreset, youtubePrivacy: YoutubePrivacy): CardOptions {
  return {
    youtube: { privacy: youtubePrivacy, category: preset.youtube.category, madeForKids: false, notifySubscribers: preset.youtube.notifySubscribers, embeddable: preset.youtube.embeddable },
    instagram: { ...preset.instagram },
    x: { ...preset.x },
  };
}

/** Only the chosen places' choices go to the server with Upload. */
export function optionsFor(chosen: readonly Platform[], o: CardOptions): ClipPostOptions {
  const out: ClipPostOptions = {};
  if (chosen.includes("youtube")) out.youtube = { ...o.youtube };
  if (chosen.includes("instagram")) out.instagram = { ...o.instagram };
  if (chosen.includes("x")) out.x = { ...o.x };
  return out;
}

const KIDS_KEYS = ["madeForKids", "selfDeclaredMadeForKids", "forKids"];
export const NEVER_KIDS = "My settings never mark a clip as made for kids.";
type Rules = Record<string, readonly string[] | "bool">;
const PRESET_RULES: Record<string, Rules> = {
  youtube: { category: YOUTUBE_CATEGORIES.map((c) => c.id), notifySubscribers: "bool", embeddable: "bool" },
  tiktok: { privacy: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], comments: "bool", duet: "bool", stitch: "bool" },
  instagram: { shareToFeed: "bool" },
  facebook: {},
  x: { replies: Object.keys(X_REPLIES_LABEL) },
};
const CLIP_RULES: Record<string, Rules> = {
  youtube: { privacy: ["public", "unlisted", "private"], category: PRESET_RULES.youtube!.category!, madeForKids: "bool", notifySubscribers: "bool", embeddable: "bool" },
  instagram: PRESET_RULES.instagram!,
  x: PRESET_RULES.x!,
};

function problem(rules: Record<string, Rules>, raw: unknown, kidsRefused: boolean): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "My settings must be a JSON object.";
  for (const [platform, part] of Object.entries(raw)) {
    const r = rules[platform];
    if (!r) return `Unknown field: ${platform}.`;
    if (typeof part !== "object" || part === null || Array.isArray(part)) return `${platform} must be a JSON object.`;
    for (const [key, value] of Object.entries(part)) {
      if (kidsRefused && KIDS_KEYS.includes(key)) return NEVER_KIDS;
      const rule = r[key];
      if (!rule) return `Unknown field: ${key}.`;
      if (rule === "bool" ? typeof value !== "boolean" : !rule.includes(value as string)) return `Pick one of the choices for ${key}.`;
    }
  }
  return null;
}

/** The API's post_preset.check, for the mock: the problem as a sentence, or null. */
export function presetProblem(raw: unknown): string | null {
  return problem(PRESET_RULES, raw, true);
}

/** The API's post_preset.clip_options, for the mock: the problem as a sentence, or null. */
export function clipOptionsProblem(raw: unknown): string | null {
  return problem(CLIP_RULES, raw, false);
}

// ---- Campaign clips (docs/CONTRACTS.md §38.5) ----

/** The words under the locked YouTube choices of a campaign clip. */
export const CAMPAIGN_LOCKED = "Campaign clips are public, never made for kids, and marked as paid.";
/** Meta's Reels have no paid-partnership switch for this kind of app (§38.14). */
export const META_PAID_LINE = (name: "Instagram" | "Facebook") => `${name} doesn't let apps turn on Paid partnership. #Ad and the words on the video tell viewers.`;

/**
 * "Use my settings" on a campaign clip: YouTube Everyone and never made for kids (shown locked, with Paid promotion
 * on); Instagram as My settings; X as My settings (Paid partnership is on for every campaign post).
 */
export function campaignCardOptions(preset: PostPreset): CardOptions {
  return {
    youtube: { privacy: "public", category: preset.youtube.category, madeForKids: false, notifySubscribers: preset.youtube.notifySubscribers, embeddable: preset.youtube.embeddable },
    instagram: { ...preset.instagram },
    x: { ...preset.x },
  };
}
