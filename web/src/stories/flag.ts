// Lamo Stories stays hidden until every piece has merged and the final check passed (docs/CONTRACTS.md §45.1).
// The last Lamo Stories pull request turns STORIES_ON to true. Until then the switcher is not shown and the
// /stories pages say "not found" like any unknown page, so Lamo Clips looks exactly as it does today.
//
// Tests and a preview on this device can turn it on with localStorage "cf.storiesPreview" = "1".
export const STORIES_ON: boolean = false;

const PREVIEW_KEY = "cf.storiesPreview";

export function storiesEnabled(): boolean {
  if (STORIES_ON) return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}
