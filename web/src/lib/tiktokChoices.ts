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

/** TikTok's rule: branded content (a paid partnership) can only be seen by Everyone or Friends. */
export const BRANDED_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"];

/** TikTok's own words on a greyed choice while Branded content is ticked. */
export const BRANDED_PRIVATE_LINE = "Branded content visibility cannot be set to private.";

/** TikTok's own words when Commercial content is on and nothing is ticked. */
export const PICK_WHOSE = "You need to indicate if your content promotes yourself, a third party, or both.";

/** TikTok's list (never more), Everyone first. */
export function orderedPrivacy(options: string[]): string[] {
  const rank = (o: string) => (PRIVACY_ORDER.includes(o) ? PRIVACY_ORDER.indexOf(o) : PRIVACY_ORDER.length);
  return [...options].sort((a, b) => rank(a) - rank(b));
}

/** The privacy choices that can be picked: TikTok's list, Everyone first; only Everyone or Friends for branded content. */
export function privacyChoices(options: string[], branded: boolean): string[] {
  return orderedPrivacy(options).filter((o) => !branded || BRANDED_PRIVACY.includes(o));
}

/** The label TikTok puts on the post, or null when Commercial content says nothing yet. Branded content wins. */
export function tiktokLabel(c: { commercial: boolean; yourBrand: boolean; branded: boolean }): string | null {
  if (!c.commercial) return null;
  return c.branded ? "Paid partnership" : c.yourBrand ? "Promotional content" : null;
}

/** Why Branded content cannot be ticked with the privacy picked now (TikTok's rule), or null when it can. */
export function brandedBlocked(privacy: string): string | null {
  if (!privacy || BRANDED_PRIVACY.includes(privacy)) return null;
  return `Branded content can't be ${PRIVACY_LABEL[privacy] ?? privacy}. Pick Everyone or Friends first.`;
}

/** TikTok only lets this creator post as "Only me": the app is not approved (audited) by TikTok yet. */
export function onlyPrivateAllowed(options: string[]): boolean {
  return options.length === 1 && options[0] === "SELF_ONLY";
}

/** Upload can be pressed: a privacy is picked, and Commercial content (when on) says whose. */
export function sheetReady(o: { privacy: string; commercial: boolean; yourBrand: boolean; branded: boolean }): boolean {
  if (!o.privacy) return false;
  if (o.commercial && !o.yourBrand && !o.branded) return false;
  if (o.branded && !BRANDED_PRIVACY.includes(o.privacy)) return false;
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

// ---- My settings (docs/CONTRACTS.md §36) ----

/**
 * The choices "Use my settings" puts on TikTok, from the owner's saved TikTok settings and what TikTok offers this
 * creator right now. Who can see it: the saved choice when TikTok offers it, else Everyone, else TikTok's first choice
 * (Only me before TikTok approves the app). Comments, Duet and Stitch: as saved, and off when TikTok turned them off.
 * Commercial content: always off (the owner ticks Your brand or Branded content himself, per clip).
 */
export function myTikTokChoices(saved: TikTokPreset, creator: TikTokCreator, now: TikTokChoices = NO_TIKTOK_CHOICES): TikTokChoices {
  // Commercial content is about this one clip: putting his settings back keeps what he ticked (a paid partnership is never dropped).
  const paid = now.commercial && now.branded;
  const offered = privacyChoices(creator.privacyOptions, paid);
  const privacy = offered.includes(saved.privacy) ? saved.privacy : offered.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : (offered[0] ?? "");
  return {
    commercial: now.commercial,
    yourBrand: now.yourBrand,
    branded: now.branded,
    privacy,
    comments: saved.comments && !creator.commentDisabled,
    duet: saved.duet && !creator.duetDisabled,
    stitch: saved.stitch && !creator.stitchDisabled,
  };
}

// ---- Campaign clips (docs/CONTRACTS.md §38.5) ----

/** Under the TikTok row when a campaign clip is set to anything but Everyone. */
export const CAMPAIGN_PUBLIC = "Campaign clips must be public. Pick Everyone.";
export const CAMPAIGN_BRANDED = "Turn on Branded content on TikTok for campaign clips.";

/**
 * "Use my settings" on a campaign clip (TikTok only after its audit): Everyone, and Commercial content on with
 * Branded content ticked. TikTok's own tap rule still holds: this is the owner's tap (§17.8). The dropdown still lists
 * TikTok's own choices with no default before that tap.
 */
export function campaignTikTokChoices(saved: TikTokPreset, creator: TikTokCreator): TikTokChoices {
  const offered = privacyChoices(creator.privacyOptions, true);
  return {
    privacy: offered.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : "",
    comments: saved.comments && !creator.commentDisabled,
    duet: saved.duet && !creator.duetDisabled,
    stitch: saved.stitch && !creator.stitchDisabled,
    commercial: true,
    yourBrand: false,
    branded: true,
  };
}

/** Why a campaign clip can't go to TikTok with these choices, or null. */
export function campaignTikTokProblem(c: TikTokChoices): string | null {
  if (c.privacy && c.privacy !== "PUBLIC_TO_EVERYONE") return CAMPAIGN_PUBLIC;
  if (c.privacy && !(c.commercial && c.branded)) return CAMPAIGN_BRANDED;
  return null;
}
