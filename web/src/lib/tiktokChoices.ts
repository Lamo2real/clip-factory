// The Post to TikTok sheet's choices (docs/CONTRACTS.md §17.8). Nothing starts picked: TikTok wants the creator to
// choose who can see the post every time, and Comments, Duet and Stitch start off.
import type { TikTokCreator, TikTokPostOptions, TikTokPreset } from "../api/types.ts";

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

export const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/** The order the choices show: Everyone first, Only me last. Anything TikTok adds later goes at the end. */
const PRIVACY_ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

/** The privacy choices to offer: TikTok's list (never more), Everyone first, without "Only me" for branded content. */
export function privacyChoices(options: string[], branded: boolean): string[] {
  const rank = (o: string) => (PRIVACY_ORDER.includes(o) ? PRIVACY_ORDER.indexOf(o) : PRIVACY_ORDER.length);
  return options.filter((o) => !(branded && o === "SELF_ONLY")).sort((a, b) => rank(a) - rank(b));
}

/** TikTok only lets this creator post as "Only me": the app is not approved (audited) by TikTok yet. */
export function onlyPrivateAllowed(options: string[]): boolean {
  return options.length === 1 && options[0] === "SELF_ONLY";
}

/** Upload can be pressed: a privacy is picked, and Commercial content (when on) says whose. */
export function sheetReady(o: { privacy: string; commercial: boolean; yourBrand: boolean; branded: boolean }): boolean {
  if (!o.privacy) return false;
  if (o.commercial && !o.yourBrand && !o.branded) return false;
  if (o.branded && o.privacy === "SELF_ONLY") return false;
  return true;
}

/** `sheetReady` for a set of choices: Your brand and Branded content only count while Commercial content is on. */
export function choicesReady(c: TikTokChoices): boolean {
  return sheetReady({ privacy: c.privacy, commercial: c.commercial, yourBrand: c.commercial && c.yourBrand, branded: c.commercial && c.branded });
}

/**
 * Whether the clip is longer than TikTok lets this creator post. A limit of 0 (or none) means TikTok did not say,
 * so it does not block: the publisher checks the length again before it uploads (§17.8).
 */
export function tooLongForTikTok(durationSec: number, maxDurationSec: number | null | undefined): boolean {
  return !!maxDurationSec && maxDurationSec > 0 && durationSec > maxDurationSec;
}

// ---- My settings (docs/CONTRACTS.md §34) ----

/**
 * The choices "Use my settings" puts on TikTok, from the owner's saved TikTok settings and what TikTok offers this
 * creator right now. Who can see it: the saved choice when TikTok offers it, else Everyone, else TikTok's first choice
 * (Only me before TikTok approves the app). Comments, Duet and Stitch: as saved, and off when TikTok turned them off.
 * Commercial content: always off (the owner ticks Your brand or Branded content himself, per clip).
 */
export function myTikTokChoices(saved: TikTokPreset, creator: TikTokCreator): TikTokChoices {
  const offered = privacyChoices(creator.privacyOptions, false);
  const privacy = offered.includes(saved.privacy) ? saved.privacy : offered.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : (offered[0] ?? "");
  return {
    ...NO_TIKTOK_CHOICES,
    privacy,
    comments: saved.comments && !creator.commentDisabled,
    duet: saved.duet && !creator.duetDisabled,
    stitch: saved.stitch && !creator.stitchDisabled,
  };
}
