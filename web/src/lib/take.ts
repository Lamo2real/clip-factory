// Your take (owner request, 2026-11-27): every clip gets one short comment that is the channel's own. The owner's
// few words on how they talk ("How you talk") are one short line; these are its rules, the same as the API's.

/** The most letters "How you talk" can hold. */
export const TAKE_STYLE_MAX = 120;

/** "How you talk" as it is stored: line breaks and runs of spaces become one space, none at the ends. */
export function tidyTakeStyle(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
