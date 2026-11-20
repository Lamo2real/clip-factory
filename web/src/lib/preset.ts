// My settings (docs/CONTRACTS.md §33.4): the owner's preferred post choices per platform, and the per-clip choices
// Review sends with Upload. Never "made for kids": there is no such field, and the server refuses one.
import type { Platform, PostPreset, TikTokPostOptions, TikTokPreset, ClipPostOptions, TikTokCreator } from "../api/types.ts";

export const DEFAULT_PRESET: PostPreset = {
  youtube: { privacy: "public", category: "20", embeddable: true, notifySubscribers: true, syntheticMedia: false },
  tiktok: { privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true, commercial: false, aigc: false },
  instagram: { shareToFeed: true },
  facebook: {},
  x: { replies: "everyone" },
};

export const YOUTUBE_PRIVACY_LABEL = { public: "Public", unlisted: "Unlisted", private: "Private" } as const;
export const YOUTUBE_CATEGORIES: { id: string; label: string }[] = [
  { id: "20", label: "Gaming" },
  { id: "24", label: "Entertainment" },
  { id: "23", label: "Comedy" },
  { id: "22", label: "People & Blogs" },
  { id: "17", label: "Sports" },
];
export const X_REPLIES_LABEL = { everyone: "Everyone", following: "People you follow", mentionedUsers: "Only people you mention", verified: "Verified accounts" } as const;
export const TIKTOK_PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  FOLLOWER_OF_CREATOR: "Followers",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  SELF_ONLY: "Only me",
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

/** The per-clip choices for YouTube, Instagram and X that go with Upload, from a preset. */
export function clipOptionsFrom(preset: PostPreset): ClipPostOptions {
  return { youtube: { ...preset.youtube }, instagram: { ...preset.instagram }, x: { ...preset.x } };
}

/** Only the chosen places' choices go to the server. */
export function optionsFor(chosen: readonly Platform[], options: ClipPostOptions): ClipPostOptions {
  const out: ClipPostOptions = {};
  if (chosen.includes("youtube") && options.youtube) out.youtube = options.youtube;
  if (chosen.includes("instagram") && options.instagram) out.instagram = options.instagram;
  if (chosen.includes("x") && options.x) out.x = options.x;
  return out;
}

/** The TikTok sheet's starting choices from the owner's preset, limited to what TikTok allows this creator today. */
export interface TikTokChoices {
  privacy: string;
  comments: boolean;
  duet: boolean;
  stitch: boolean;
  commercial: boolean;
  yourBrand: boolean;
  branded: boolean;
}

export const NO_TIKTOK_CHOICES: TikTokChoices = { privacy: "", comments: false, duet: false, stitch: false, commercial: false, yourBrand: false, branded: false };

/**
 * The owner tapped Use my settings: his TikTok preset, but never a privacy TikTok does not offer him now (an app TikTok
 * has not approved yet only offers Only me; then that is picked, because he asked for his settings in one tap).
 */
export function tiktokFromPreset(preset: TikTokPreset, creator: Pick<TikTokCreator, "privacyOptions"> | null): TikTokChoices {
  const allowed = creator?.privacyOptions ?? [];
  const privacy = !creator || allowed.includes(preset.privacy) ? preset.privacy : allowed.length === 1 ? allowed[0]! : "";
  return { privacy, comments: preset.comments, duet: preset.duet, stitch: preset.stitch, commercial: preset.commercial, yourBrand: false, branded: false };
}

export function tiktokOptions(c: TikTokChoices, creator: TikTokCreator): TikTokPostOptions {
  return {
    privacyLevel: c.privacy,
    disableComment: !c.comments || creator.commentDisabled,
    disableDuet: !c.duet || creator.duetDisabled,
    disableStitch: !c.stitch || creator.stitchDisabled,
    brandContent: c.commercial && c.branded,
    brandOrganic: c.commercial && c.yourBrand,
  };
}

const KIDS_KEYS = ["madeForKids", "selfDeclaredMadeForKids", "forKids"];
export const NEVER_KIDS = "Clip Factory never marks a clip as made for kids.";
const ALLOWED: Record<string, Record<string, readonly string[] | "bool">> = {
  youtube: { privacy: ["public", "unlisted", "private"], category: YOUTUBE_CATEGORIES.map((c) => c.id), embeddable: "bool", notifySubscribers: "bool", syntheticMedia: "bool" },
  tiktok: { privacy: Object.keys(TIKTOK_PRIVACY_LABEL), comments: "bool", duet: "bool", stitch: "bool", commercial: "bool", aigc: "bool" },
  instagram: { shareToFeed: "bool" },
  facebook: {},
  x: { replies: Object.keys(X_REPLIES_LABEL) },
};

/**
 * The API's check of one platform's choices (post_preset.check_platform), for the mock: returns the problem as a
 * sentence, or null when the choices are fine.
 */
export function presetProblem(platform: string, raw: unknown): string | null {
  const rules = ALLOWED[platform];
  if (!rules) return `Unknown field: ${platform}.`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return `${platform} must be a JSON object.`;
  for (const [key, value] of Object.entries(raw)) {
    if (KIDS_KEYS.includes(key)) return NEVER_KIDS;
    const rule = rules[key];
    if (!rule) return `Unknown field: ${key}.`;
    if (rule === "bool" ? typeof value !== "boolean" : !rule.includes(value as string)) return `Pick one of the choices for ${key}.`;
  }
  return null;
}
