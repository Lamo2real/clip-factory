// The Post to TikTok sheet's choices (docs/CONTRACTS.md §17.8). Nothing starts picked: TikTok wants the creator to
// choose who can see the post every time, and Comments, Duet and Stitch start off.
import type { TikTokCreator, TikTokPostOptions } from "../api/types.ts";

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
