// My Mac posts TikTok, Clips Funded's words (docs/CONTRACTS.md §47.10): kid-proof, few words. Clips Funded keeps its
// own copy, so a change to Clip Factory's Mac words (web/src/lib/tiktokMac.ts) never changes these by itself.

/** The switch's name, in Clips Funded › Social accounts › TikTok. */
export const MAC_TITLE = "My Mac posts TikTok";
export const MAC_CARD_OFF = "Off. Your Mac doesn't post TikTok.";
export const MAC_CARD_ON = "On. Post it hands TikTok to your Mac. It posts for everyone, with the AI label.";
export const MAC_STOP_LINE = "To stop it, turn the switch off. Your Mac stops at once.";
export const MAC_NOT_SET_UP = "Your Mac isn't set up yet.";
export const MAC_ASKED = "Look at your Mac. A TikTok window opens within a minute.";
export const MAC_CARD_PAUSED = "Paused on your Mac · your posts wait until it's started again.";
export const MAC_CARD_STARTING = "Your Mac starts again within a minute.";

/** "Your Mac isn't logged in to @clips.funded yet." */
export function notLoggedInWords(handle: string): string {
  return `Your Mac isn't logged in to ${handle} yet.`;
}

/** "Your Mac checked in Sun 14:03 · logged in as @clips.funded." */
export function checkedInWords(time: string, handle: string): string {
  return `Your Mac checked in ${time} · logged in as ${handle}.`;
}

/** "Your Mac needs you: TikTok logged your Mac out. Tap Log in on my Mac." */
export function needsYouWords(reason: string | undefined): string {
  return `Your Mac needs you: ${reason?.trim() || "look at your Mac."}`;
}

/** §47.11, under the needs-you line while the Mac stopped only for a TikTok login: "Once you log in to
 * @clips.funded again, your Mac carries on by itself." */
export function loginBackWords(handle: string): string {
  return `Once you log in to ${handle} again, your Mac carries on by itself.`;
}

/** "Your Mac hasn't checked in since Sun 14:03." */
export function notSeenWords(time: string): string {
  return `Your Mac hasn't checked in since ${time}.`;
}

/** The set-up steps, numbered; `from` 2 leaves out the update once the new helper checked in. */
export function macSteps(handle: string, from: 1 | 2 = 1): string[] {
  const all = ["1. Ask for the helper update on your Mac.", "2. Tap Log in on my Mac.", `3. In the TikTok app, switch to ${handle}, then scan the code.`];
  return all.slice(from - 1);
}

// The buttons.
export const MAC_LOGIN_BUTTON = "Log in on my Mac";
export const MAC_OPEN_STOPPED = "Open the stopped post";
export const MAC_RESUME = "Start my Mac again";
export const MAC_SET_IT_UP = "Set it up";
export const MAC_TURN_ON = "Turn on";
export const MAC_TRY_AGAIN = "Try again";
export const MAC_ON_TIKTOK = "It's on TikTok";
export const MAC_NO_LINK = "It's on TikTok, no link";
export const MAC_POST_WITH_MAC = "Post with my Mac";
export const MAC_AGAIN_ASK = "Post it again? Only if it's not on your TikTok.";
export const MAC_AGAIN_YES = "Yes, post it again";
export const MAC_NO_LINK_ASK = "Save it as on TikTok without its link?";
export const MAC_NO_LINK_YES = "Yes, it's on TikTok";
export const MAC_LINK_LABEL = "Its link on TikTok";
export const MAC_LINK_EMPTY = "Paste the link first.";
export const MAC_SAVE_LINK = "Save";

// Review › Post it, while the Mac posts TikTok.
export const MAC_SHEET_LINE = "Your Mac posts it for everyone, with the AI label.";
export const MAC_SHEET_SMALL = "Comments, Duet and Stitch on.";
export const MAC_SHEET_NOT_SET_UP = "Your Mac isn't set up yet. It posts once it is.";

// The post rows.
export const MAC_CHIP_WAITING = "Waiting for your Mac";
export const MAC_CHIP_POSTING = "Posting…";
export const MAC_CHIP_FAILED = "Didn't work";
export const MAC_CHIP_NOT_SURE = "Not sure it posted";
export const MAC_CHIP_POSTED = "Posted";
export const MAC_ROW_POSTED = "Posted by your Mac · Everyone";
export const MAC_ROW_YOU = "On your TikTok";
export const MAC_ROW_NO_LINK = " · no link";
export const MAC_ROW_OFF = "My Mac posts TikTok is off";
export const MAC_ROW_NOT_SET_UP = "Your Mac isn't set up yet";
export const MAC_ROW_NEEDS_YOU = "Your Mac needs you · look at your Mac";
export const MAC_ROW_PAUSED = "Paused on your Mac";
export const MAC_ROW_STARTING = "Paused on your Mac · starting again within a minute";
export const MAC_ROW_POSTING = "Posting…";
export const MAC_ROW_STOPPED_EARLY = "Your Mac stopped before it pressed Post";
export const MAC_ROW_PRESSED = "Not sure it posted · look on your TikTok";
export const MAC_ROW_ONLY_YOU = "Only you can see it on TikTok";

/** "Your Mac hasn't checked in since Sun 14:03" (a row: no full stop). */
export function rowNotSeenWords(time: string): string {
  return `Your Mac hasn't checked in since ${time}`;
}

/** "Waiting for your Mac · next", "Waiting for your Mac · in line (2 before it)", or alone when not known. */
export function rowWaitWords(before: number | null): string {
  if (before === null) return MAC_CHIP_WAITING;
  return before === 0 ? `${MAC_CHIP_WAITING} · next` : `${MAC_CHIP_WAITING} · in line (${before} before it)`;
}

/** " · Try again from 14:35": inside the find window after Post was pressed. */
export function againFromWords(time: string): string {
  return ` · Try again from ${time}`;
}

/** "Didn't work: TikTok logged your Mac out" (the reason's first sentence). */
export function rowFailedWords(short: string): string {
  return short ? `${MAC_CHIP_FAILED}: ${short}` : MAC_CHIP_FAILED;
}
