// Lamo Stories is switched on for everyone (docs/CONTRACTS.md §45.1, §45.36): the switch PR turned STORIES_ON to true
// after every piece had merged and the final check passed (every acceptance criterion met or waiting only on the
// owner's own accounts; Clip Factory pixel-identical outside the switcher's own box).
//
// Tests (and a preview on one device) can still choose: localStorage "cf.storiesPreview" = "0" shows Clip Factory
// exactly as it was before Lamo Stories (no switcher, /stories is "not found"); "1" shows Lamo Stories.
export const STORIES_ON: boolean = true;

const PREVIEW_KEY = "cf.storiesPreview";

export function storiesEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem(PREVIEW_KEY);
      if (v === "0") return false;
      if (v === "1") return true;
    }
  } catch {
    // no storage (private mode): the build's own setting
  }
  return STORIES_ON;
}
