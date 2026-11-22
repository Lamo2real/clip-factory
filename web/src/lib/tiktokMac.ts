// Your Mac posts it on TikTok (docs/CONTRACTS.md §47). With Settings › Posting › Your Mac posts TikTok on, Upload and
// auto-posting hand the clip's TikTok post to the owner's Mac (`Post.status: "mac"`), which posts it in TikTok
// Studio for Everyone. Pure helpers here: the words a TikTok row says, who may be sent, and the Settings lines.
import type { Clip, MacHelper, MacStep, Post, PostMac, Settings } from "../api/types.ts";
import { plural } from "./format.ts";
import { timeWords } from "./autopost.ts";
import { canPostYourself } from "./tiktokYourself.ts";

/** Review, above Upload, instead of TIKTOK_PUBLIC_HINT while the Mac posts TikTok and TikTok has not approved the app. */
export const MAC_HINT = "TikTok: your Mac posts it for everyone.";
/** Auto-posting › Where they go, while it is on (instead of "TikTok: you post it yourself …"). */
export const MAC_WHERE_LINE = "TikTok: your Mac posts it.";

export const MAC_OFF_LINE = "Off. TikTok works as before: Post it yourself.";
export const MAC_ON_LINE = "On. Upload and auto-posting hand TikTok to your Mac.";
export const MAC_NEVER_SEEN = "Your Mac hasn't checked in yet. Set it up on your Mac.";
export const MAC_PAUSED = "Paused on your Mac.";
export const MAC_SEND_CONFIRM = "They go one at a time, oldest first.";
export const MAC_STOP_LINE = "To stop it, turn the switch off. Your Mac stops at once.";
/** What the server keeps as the reason once the Mac pressed Post but could not confirm it (§47.3). */
export const MAC_PRESSED_REASON = "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it.";
export const MAC_POSTED = "Posted by your Mac · Everyone";
/** A post the Mac set to anything but Everyone (never one of its own choices, §47.1; the server says so). */
export const MAC_POSTED_PRIVATE = "Posted by your Mac · Only you";

// The server's refusals (§47.2, §47.3), word for word.
export const MAC_WORKING = "Your Mac is posting it right now. Wait a minute.";
export const MAC_NOT_POSTING = "Your Mac isn't posting this clip.";
export const MAC_MAY_HAVE_POSTED = "Your Mac may have posted it already. Check your TikTok first.";
export const MAC_UNDO_REFUSED = "Your Mac posted this one. To take it down, delete it in TikTok.";
export const MAC_UNKNOWN_SETTING = "tiktokMac has a setting Clip Factory does not know.";

/** The Mac was not seen for this long: the waiting row says when it was. */
export const MAC_STALE_MS = 10 * 60_000;
/** POST /v1/tiktok/mac/send takes at most this many clips at once. */
export const MAC_SEND_MAX = 25;

/** The step words, as the TikTok row says them while the Mac works. */
export const MAC_STEP_WORDS: Record<MacStep, string> = {
  video: "Getting the video",
  opening: "Opening TikTok",
  uploading: "Uploading",
  settings: "Setting Everyone and the switches",
  pressing: "Posting",
  finding: "Finding the link",
};

/** Is Your Mac posts TikTok on? Absent (old servers) is off. */
export function macOn(settings: Pick<Settings, "tiktokMac"> | null | undefined): boolean {
  return settings?.tiktokMac?.on === true;
}

/** The clip's TikTok post when it is a Mac post (`status: "mac"` with its `mac`), else null. */
export function macPost(posts: readonly Post[]): (Post & { mac: PostMac }) | null {
  const p = posts.find((x) => x.platform === "tiktok");
  return p && p.status === "mac" && p.mac ? (p as Post & { mac: PostMac }) : null;
}

/** Posted by the owner's Mac (§47.1). */
export function postedByMac(p: Pick<Post, "status" | "via">): boolean {
  return p.status === "posted" && p.via === "mac";
}

export interface MacRowContext {
  /** The Mac's last check-in: null when it never checked in, undefined while not known (no extra words then). */
  helper?: MacHelper | null;
  /** Auto-posting is on (an auto-posting run's Mac post waits while it is off, §47.2). */
  autoPostOn?: boolean;
  /** Your Mac posts TikTok is on: while it is off nothing goes to the Mac (§47.4). Unknown: no extra words. */
  macOn?: boolean;
  now?: number;
}

/**
 * The TikTok row's words for a Mac post (§47.4). Waiting: "Waiting for your Mac", plus why it may wait longer (one
 * reason: the switch is off, else auto-posting is off, else the Mac never checked in, else when it was last seen if
 * that is 10 minutes ago or more). Working: "Your Mac is posting it · {step}". Stopped: "Your Mac stopped: {reason}".
 */
export function macRowWords(mac: PostMac, ctx: MacRowContext = {}): string {
  const now = ctx.now ?? Date.now();
  if (mac.state === "working") return `Your Mac is posting it · ${MAC_STEP_WORDS[mac.step ?? "video"]}`;
  if (mac.state === "stopped") return mac.reason ? `Your Mac stopped: ${mac.reason}` : "Your Mac stopped.";
  let more = "";
  if (ctx.macOn === false) more = " · it's switched off";
  else if (mac.source === "auto" && ctx.autoPostOn === false) more = " · auto-posting is off";
  else if (ctx.helper === null) more = " · set up your Mac first";
  else if (ctx.helper && now - Date.parse(ctx.helper.seenAt) >= MAC_STALE_MS) more = ` · your Mac was last seen ${timeWords(ctx.helper.seenAt, now)}`;
  return `Waiting for your Mac${more}`;
}

/** The clip page's chip for a Mac post (its stack says the rest). */
export function macChip(mac: Pick<PostMac, "state">): string {
  return mac.state === "working" ? "Your Mac is posting it" : mac.state === "stopped" ? "Your Mac stopped" : "Waiting for your Mac";
}

/** Stopped: Try again. After the Mac pressed Post, it says that it is not on TikTok (and sends `notOnTikTok`). */
export function macTryAgainLabel(mac: Pick<PostMac, "pressedAt">): string {
  return mac.pressedAt ? "It's not on TikTok, try again" : "Try again";
}

/**
 * Post it yourself instead: on a Mac post that waits or stopped; hidden while the Mac works on it, and once it pressed
 * Post (it may be on TikTok: then he says so with I posted it, or that it is not with "It's not on TikTok, try again").
 */
export function canPostYourselfInstead(posts: readonly Post[]): boolean {
  const p = macPost(posts);
  return !!p && macInsteadOk(p.mac);
}

/** The same rule for one Mac post (the clip page reads `PlatformPerformance.mac`). */
export function macInsteadOk(mac: Pick<PostMac, "state" | "pressedAt">): boolean {
  return (mac.state === "waiting" || mac.state === "stopped") && !mac.pressedAt;
}

/** Stopped after the Mac pressed Post: offer I posted it (the §42 link box) beside "It's not on TikTok, try again". */
export function macMayBeOnTikTok(mac: Pick<PostMac, "state" | "pressedAt">): boolean {
  return mac.state === "stopped" && !!mac.pressedAt;
}

/**
 * Can Send these to my Mac take this clip (§47.2)? When plain Post it yourself shows, and it is not a campaign clip
 * (Branded content, its own first 30 minutes) or a Private test run's clip.
 */
export function canSendToMac(clip: Clip, posts: Post[]): boolean {
  return canPostYourself(clip, posts) && !clip.campaignId && clip.auto?.test !== "private";
}

/** The clips to send, in lots the server takes (at most 25 each). */
export function sendLots(clipIds: readonly string[]): string[][] {
  const ids = [...new Set(clipIds)];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += MAC_SEND_MAX) out.push(ids.slice(i, i + MAC_SEND_MAX));
  return out;
}

/** Settings' status line: when the Mac checked in, that it never did, that it needs him, or that it is paused. */
export function helperLine(helper: MacHelper | null, now: number = Date.now()): string {
  if (!helper) return MAC_NEVER_SEEN;
  if (helper.state === "needs_you") return `Your Mac needs you: ${helper.reason ?? "open it and look."}`;
  if (helper.state === "paused") return MAC_PAUSED;
  return `Your Mac checked in ${timeWords(helper.seenAt, now)}.`;
}

// §47.8: the TikTok login on the owner's Mac (kept in its Keychain; never in Clip Factory).
export const MAC_LOGIN_SAVED = "Your TikTok login is kept in your Mac's Keychain, so your Mac logs back in to TikTok by itself.";
export const MAC_LOGIN_NONE = "No TikTok login is kept on your Mac. If TikTok logs your Mac out, you log in again on the Mac.";
export const MAC_LOGIN_FORGET_CONFIRM = "Forget it? Then your Mac can't log back in to TikTok by itself.";

/** The login line, or null for a Mac helper from before it said (§47.8). */
export function loginLine(helper: MacHelper | null): string | null {
  if (!helper?.login) return null;
  return helper.login === "saved" ? MAC_LOGIN_SAVED : MAC_LOGIN_NONE;
}

/** What happens next after Change or Forget. */
export function loginRequestLine(helper: MacHelper | null): string | null {
  const req = helper?.loginRequest;
  if (!req) return null;
  return req.action === "change"
    ? "Your Mac asks for the new login the next time it checks in, within a minute."
    : "Your Mac forgets the login the next time it checks in, within a minute.";
}

/** "{n} waiting for your Mac". */
export function waitingLine(n: number): string {
  return `${n} waiting for your Mac`;
}

/** What Send these to my Mac takes: "3 clips show Post it yourself." */
export function sendableLine(n: number): string {
  return `${plural(n, "clip")} ${n === 1 ? "shows" : "show"} Post it yourself.`;
}

/** The toast after Send these to my Mac. */
export function sentLine(sent: number): string {
  return `Sent ${plural(sent, "clip")} to your Mac.`;
}
