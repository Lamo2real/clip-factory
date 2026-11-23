// Your Mac posts it on TikTok (docs/CONTRACTS.md §47). With Settings › Posting › Your Mac posts TikTok on, Upload and
// auto-posting hand the clip's TikTok post to the owner's Mac (`Post.status: "mac"`), which posts it in TikTok
// Studio for Everyone. Until TikTok approves the app the Mac is the only way to TikTok (ADR-85): every TikTok row says
// what the Mac is doing, with at most one button (tiktokRow). Pure helpers here: the row, who may be sent, the
// Settings lines.
import type { Clip, MacHelper, PlatformPerformance, Post, PostMac, Settings } from "../api/types.ts";
import { plural } from "./format.ts";
import { timeWords } from "./autopost.ts";
import { settingsPath } from "./settingsTree.ts";
import { canPostYourself } from "./tiktokYourself.ts";

/** Review, above Upload, instead of TIKTOK_PUBLIC_HINT while the Mac posts TikTok and TikTok has not approved the app. */
export const MAC_HINT = "TikTok: your Mac posts it for everyone.";
/** Auto-posting › Where they go, while it is on. */
export const MAC_WHERE_LINE = "TikTok: your Mac posts it.";

export const MAC_OFF_LINE = "Off. Your Mac doesn't post your TikTok clips.";
export const MAC_ON_LINE = "On. Upload and auto-posting hand TikTok to your Mac.";
export const MAC_NEVER_SEEN = "Your Mac hasn't checked in yet. Set it up on your Mac.";
export const MAC_PAUSED = "Paused on your Mac.";
export const MAC_SEND_CONFIRM = "They go one at a time, oldest first.";
export const MAC_STOP_LINE = "To stop it, turn the switch off. Your Mac stops at once.";
/**
 * What the server keeps as the reason once the Mac pressed Post but could not confirm it (§47.3), word for word. The
 * rows never show it: they pick their own words by `pressedAt` (MAC_ROW_PRESSED).
 */
export const MAC_PRESSED_REASON = "Your Mac pressed Post but couldn't confirm it. Check your TikTok: if it's there, tap I posted it.";
export const MAC_POSTED = "Posted by your Mac · Everyone";
/** A post the Mac set to anything but Everyone (never one of its own choices, §47.1; the server says so). */
export const MAC_POSTED_PRIVATE = "Posted by your Mac · Only you";
/** Posted on TikTok by the owner himself, from before the Mac (§42). */
export const YOU_POSTED = "Posted by you · Everyone";

// The server's refusals (§47.2, §47.3), word for word.
export const MAC_WORKING = "Your Mac is posting it right now. Wait a minute.";
export const MAC_NOT_POSTING = "Your Mac isn't posting this clip.";
export const MAC_MAY_HAVE_POSTED = "Your Mac may have posted it already. Check your TikTok first.";
export const MAC_UNDO_REFUSED = "Your Mac posted this one. To take it down, delete it in TikTok.";
export const MAC_UNKNOWN_SETTING = "tiktokMac has a setting Clip Factory does not know.";

/** The Mac was not seen for this long: its rows say since when, with Turn on. */
export const MAC_STALE_MS = 30 * 60_000;
/** POST /v1/tiktok/mac/send takes at most this many clips at once. */
export const MAC_SEND_MAX = 25;

// The TikTok row's words (§47.4).
export const MAC_ROW_WAITING = "Waiting for your Mac";
/** An Upload tap's clip: the helper checks in every minute (launchd StartInterval 60) and takes it then. */
export const MAC_ROW_CHECK_IN = "next check-in in about a minute";
export const MAC_ROW_AUTO_OFF = "Waiting for your Mac · auto-posting is off";
export const MAC_ROW_POSTING = "Posting…";
export const MAC_ROW_NOT_YET = "Not on TikTok yet";
/** The same, for a clip Clip Factory uploaded "Only me" (from before the account was public). */
export const MAC_ROW_ONLY_YOU = "Only you can see it on TikTok";
export const MAC_ROW_OFF = "Your Mac posts TikTok is off";
export const MAC_ROW_NOT_SET_UP = "Your Mac isn't set up yet";
/** It needs him (a login, a code, a puzzle): the Mac shows him what, in a pop-up. */
export const MAC_ROW_NEEDS_YOU = "Your Mac needs you";
export const MAC_ROW_LOOK = "look at your Mac";
/** Paused on the Mac itself (only the Mac starts it again). */
export const MAC_ROW_PAUSED = "Your Mac is paused · start it again on your Mac";
/** Stopped after the Mac pressed Post: it may be on TikTok, so he looks there first (It's on TikTok, or Try again). */
export const MAC_ROW_PRESSED = "your Mac couldn't tell if it posted · look on your TikTok first";
export const MAC_ROW_CAMPAIGN = "Campaign clip: post it in the TikTok app";
export const MAC_ROW_PRIVATE_TEST = "Private test · stays off TikTok";
export const MAC_ROW_ADD_LINK = " · add the link";

/** "goes after the next auto-posting run (20:30)": a backlog clip's wait, with the run's time (§47.4). */
export function afterRunWords(at: string): string {
  return `goes after the next auto-posting run (${at})`;
}

// The row's buttons (§47.4), each the app's own Button or LinkButton.
/** open_mac: to Settings › Posting › Your Mac posts TikTok, where the Mac's status line says the rest. */
export const MAC_OPEN_BUTTON = "Open Your Mac posts TikTok";
/** on_tiktok: the Mac pressed Post; it opens the row's Add link (its link, or an empty box to find it). */
export const MAC_ON_TIKTOK_BUTTON = "It's on TikTok";

/** Is Your Mac posts TikTok on? Absent (old servers) is off. */
export function macOn(settings: Pick<Settings, "tiktokMac"> | null | undefined): boolean {
  return settings?.tiktokMac?.on === true;
}

/** A Mac post that waits or stopped before the Mac pressed Post: the only kind the API takes back (§47.2). */
export function macInsteadOk(mac: Pick<PostMac, "state" | "pressedAt">): boolean {
  return (mac.state === "waiting" || mac.state === "stopped") && !mac.pressedAt;
}

/**
 * Can the Mac take this clip (§47.2)? A kept clip that is not on TikTok for everyone (no TikTok post, one waiting for
 * setup, failed, or uploaded privately), and not a campaign clip (Branded content, its own first 30 minutes) or a
 * Private test run's clip.
 */
export function canSendToMac(clip: Clip, posts: Post[]): boolean {
  return canPostYourself(clip, posts) && !clip.campaignId && clip.auto?.test !== "private";
}

// ---------- The TikTok row (§47.4) ----------

/** What a TikTok row reads: the clip's TikTok post, if any, and what the clip is. */
export interface TikTokFacts {
  post: Pick<Post, "status" | "by" | "via" | "url" | "privacy" | "mac" | "postedAt"> | null;
  /** Kept and not on TikTok for everyone (canPostYourself): the Mac can take it, unless campaign or Private test. */
  offer: boolean;
  campaign: boolean;
  privateTest: boolean;
}

/** The facts from a clip and its posts (Library, Review). */
export function tiktokFacts(clip: Clip, posts: readonly Post[]): TikTokFacts {
  return {
    post: posts.find((p) => p.platform === "tiktok") ?? null,
    offer: canPostYourself(clip, [...posts]),
    campaign: !!clip.campaignId,
    privateTest: clip.auto?.test === "private",
  };
}

/** The clip page's five stacks read back as posts (§16.2), for the same rules: a stack with nothing posted has none. */
export function postsFromStacks(clip: Pick<Clip, "clipId">, stacks: readonly PlatformPerformance[]): Post[] {
  return stacks.flatMap((s): Post[] => {
    if (s.status === "not_posted") return [];
    const status: Post["status"] =
      s.status === "waiting_for_connection" ? "pending_integration" : s.status === "posting" ? "queued" : s.status === "posted_private" ? "posted" : s.status;
    return [
      {
        postId: s.postId ?? `${clip.clipId}-${s.platform}`,
        clipId: clip.clipId,
        platform: s.platform,
        status,
        ...(s.status === "posted" ? { privacy: "public" as const } : s.status === "posted_private" ? { privacy: "private" as const } : {}),
        ...(s.url ? { url: s.url } : {}),
        ...(s.postedAt ? { postedAt: s.postedAt } : {}),
        ...(s.error ? { error: s.error } : {}),
        ...(s.by ? { by: s.by } : {}),
        ...(s.via ? { via: s.via } : {}),
        ...(s.mac ? { mac: s.mac } : {}),
      },
    ];
  });
}

/** The facts from the clip page (its clip and its five stacks). */
export function tiktokFactsFromStacks(clip: Clip, stacks: readonly PlatformPerformance[]): TikTokFacts {
  return tiktokFacts(clip, postsFromStacks(clip, stacks));
}

export interface TikTokRowContext {
  /** TikTok approved the app (tiktokAudited): the clips that aren't on TikTok keep the old API rows. */
  audited: boolean;
  /** Your Mac posts TikTok is on. Unknown (not read yet): no Turn on. */
  macOn?: boolean;
  /** The Mac's last check-in: null when it never checked in, undefined while not known. */
  helper?: MacHelper | null;
  /** Auto-posting is on. Unknown: a backlog clip says no run time. */
  autoPostOn?: boolean;
  /** Auto-posting's next run (GET /v1/autopost nextRunAt): a backlog clip goes after it. */
  nextRunAt?: string | null;
  /**
   * Its last scheduled live run. Not read any more: the helper paces the backlog itself (one per run, or the
   * backfill's pace, plan.js), so the row never guesses a time from it. Kept so callers that pass it still compile.
   */
  lastRunAt?: string | null;
  now?: number;
}

export type TikTokRowKind = "posted" | "posted_you" | "working" | "waiting" | "stopped" | "not_ready" | "offer" | "campaign" | "private_test";
/**
 * The row's button. `try_again`: retry `now`. `post_with_mac`: send `now` (also a waiting post while auto-posting is
 * off, which then goes as an Upload tap's). `turn_on` and `open_mac`: links to `href` (MAC_OPEN_BUTTON's words).
 * `add_link`: the inline Add link. `on_tiktok`: the Mac pressed Post but couldn't tell if it posted:
 * MAC_ON_TIKTOK_BUTTON opens the inline Add link (its link, or an empty box to find it from `since`), and Try again
 * (`notOnTikTok`) is the second, quieter choice beside it.
 */
export type TikTokRowButton = "try_again" | "post_with_mac" | "turn_on" | "open_mac" | "add_link" | "on_tiktok";

export interface TikTokRow {
  kind: TikTokRowKind;
  words: string;
  /** The row's button, or none (`on_tiktok` comes with Try again beside it). */
  button: TikTokRowButton | null;
  /** Turn on and open_mac: where it goes. */
  href?: string;
  /** The post on TikTok (Open). */
  url?: string;
  /** Add link and It's on TikTok: the finder looks for the post on his TikTok from here. */
  since?: string;
  /** The Mac is posting it right now. */
  spinner?: true;
}

const MINUTE = 60_000;
const two = (n: number) => String(n).padStart(2, "0");

/** "14:05" today, else "Mon 14:05" (with its date from 6 days away), in the owner's own time. */
export function clockWords(at: string | number, now: number = Date.now()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  if (d.toDateString() === new Date(now).toDateString()) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  return timeWords(d, now);
}

// The helper's older reasons end with "post it yourself (for now)", which he never does (ADR-85): the rows drop it.
const YOURSELF = /\s*[,;:]?\s*(?:(?:or|and|then)\s+)?post it yourself(?:\s+for now)?/gi;

/**
 * A reason's first sentence, without its full stop and without "post it yourself": "TikTok wants you to log in
 * again." → "TikTok wants you to log in again".
 */
export function shortReason(reason: string | undefined): string {
  const text = (reason ?? "").trim().replace(/\s+/g, " ");
  const first = text.split(/(?<=[.!?])\s/)[0] ?? "";
  return first.replace(YOURSELF, "").replace(/[.\s]+$/, "").trim();
}

/**
 * What a waiting Mac post's row says (§47.4), only from what the server or the Mac knows. An Upload tap's clip goes
 * at the Mac's next check-in (every minute), once it is ready: "Waiting for your Mac · next check-in in about a
 * minute". A backlog clip ("Send these to my Mac") goes after an auto-posting run, at the helper's own pace: "Waiting
 * for your Mac · goes after the next auto-posting run (20:30)". An auto-posting run's clip goes at once unless the
 * Mac holds it, which the web can't see. Not known: "Waiting for your Mac" alone.
 */
export function macWaitWords(mac: Pick<PostMac, "source">, ctx: TikTokRowContext): string {
  const now = ctx.now ?? Date.now();
  if (mac.source === "upload") {
    const h = ctx.helper;
    const seen = h ? Date.parse(h.seenAt) : NaN;
    const fresh = !!h && h.state === "ok" && Number.isFinite(seen) && now - seen < MAC_STALE_MS;
    return fresh ? `${MAC_ROW_WAITING} · ${MAC_ROW_CHECK_IN}` : MAC_ROW_WAITING;
  }
  if (mac.source === "sent" && ctx.autoPostOn === true && ctx.nextRunAt) {
    const at = clockWords(ctx.nextRunAt, now);
    if (at) return `${MAC_ROW_WAITING} · ${afterRunWords(at)}`;
  }
  return MAC_ROW_WAITING;
}

const macSettings = () => settingsPath("posting", "tiktok-mac");
const turnOn = (words: string): TikTokRow => ({ kind: "not_ready", words, button: "turn_on", href: macSettings() });
const openMac = (words: string): TikTokRow => ({ kind: "not_ready", words, button: "open_mac", href: macSettings() });

/** "Your Mac needs you: TikTok wants a code · look at your Mac". */
function needsYouWords(h: Pick<MacHelper, "reason">): string {
  const why = shortReason(h.reason);
  return `${MAC_ROW_NEEDS_YOU}${why ? `: ${why}` : ""} · ${MAC_ROW_LOOK}`;
}

/**
 * The Mac can't post right now: its switch is off, it never checked in, or it was not seen for 30 minutes (Turn on).
 * It needs him or is paused (Open Your Mac posts TikTok, with what to do): said on working, waiting and not-yet rows,
 * not on a stopped row, which keeps its Try again (that is what turns "needs you" back to ok, §47.3). Null while it is
 * ready, or while that is not known.
 */
function notReady(ctx: TikTokRowContext, stopped: boolean): TikTokRow | null {
  if (ctx.macOn === false) return turnOn(MAC_ROW_OFF);
  if (ctx.helper === null) return turnOn(MAC_ROW_NOT_SET_UP);
  const h = ctx.helper;
  if (!h) return null;
  const now = ctx.now ?? Date.now();
  const seen = Date.parse(h.seenAt);
  if (Number.isFinite(seen) && now - seen >= MAC_STALE_MS) return turnOn(`Your Mac hasn't checked in since ${clockWords(seen, now)}`);
  if (stopped) return null;
  if (h.state === "needs_you") return openMac(needsYouWords(h));
  if (h.state === "paused") return openMac(MAC_ROW_PAUSED);
  return null;
}

/** Where the finder looks for a pressed post: from a minute before the Mac claimed it (the API's FIND_EARLY). */
function findSince(mac: Pick<PostMac, "claimedAt" | "pressedAt">): string | undefined {
  const at = Date.parse(mac.claimedAt ?? mac.pressedAt ?? "");
  return Number.isFinite(at) ? new Date(at - MINUTE).toISOString() : undefined;
}

function postedRow(kind: "posted" | "posted_you", words: string, p: NonNullable<TikTokFacts["post"]>): TikTokRow {
  if (p.url) return { kind, words, button: null, url: p.url };
  return { kind, words: `${words}${MAC_ROW_ADD_LINK}`, button: "add_link", ...(p.postedAt ? { since: p.postedAt } : {}) };
}

/** A Mac post's row: Didn't work (pressed, or not), the Mac can't post, Posting…, or waiting. */
function macRow(mac: PostMac, ctx: TikTokRowContext): TikTokRow {
  if (mac.state === "stopped" && mac.pressedAt) {
    // It may be on TikTok: It's on TikTok first (never posts again), Try again second. Words chosen by pressedAt,
    // never by matching the stored reason. Saying it's on TikTok needs no Mac, so this shows even while it can't post.
    const since = findSince(mac);
    return { kind: "stopped", words: `Didn't work: ${MAC_ROW_PRESSED}`, button: "on_tiktok", ...(since ? { since } : {}) };
  }
  if (mac.state === "stopped") {
    const ready = notReady(ctx, true);
    if (ready) return ready;
    const why = shortReason(mac.reason);
    // It needs him: Try again only helps once he did it on the Mac.
    const first = ctx.helper?.state === "needs_you" ? ` · ${MAC_ROW_LOOK} first` : "";
    return { kind: "stopped", words: `${why ? `Didn't work: ${why}` : "Didn't work"}${first}`, button: "try_again" };
  }
  // Before Posting…: a post left working by a switch turned off, or a Mac asleep or crashed, says so (never a
  // spinner for good).
  const ready = notReady(ctx, false);
  if (ready) return ready;
  if (mac.state === "working") return { kind: "working", words: MAC_ROW_POSTING, button: null, spinner: true };
  // Auto-posting off: a backlog or auto-posting clip would wait for good, so he can send this one now.
  if ((mac.source === "sent" || mac.source === "auto") && ctx.autoPostOn === false) return { kind: "waiting", words: MAC_ROW_AUTO_OFF, button: "post_with_mac" };
  return { kind: "waiting", words: macWaitWords(mac, ctx), button: null };
}

/**
 * The TikTok row (§47.4): only what the Mac is doing, with at most one button (It's on TikTok comes with Try again).
 * In this order: posted by the Mac (Open, or Add link); posted by him (§42); a Mac post (macRow: pressed, the Mac
 * can't post, Didn't work, Posting…, waiting); not on TikTok yet (Post with my Mac); a campaign clip (Add link) or a
 * Private test. Null: the row keeps its old words and buttons, for a clip not on TikTok once TikTok approved the app,
 * and for Clip Factory's own posts.
 */
export function tiktokRow(facts: TikTokFacts, ctx: TikTokRowContext): TikTokRow | null {
  const p = facts.post;
  if (p && p.status === "posted" && p.via === "mac") return postedRow("posted", p.privacy === "private" ? MAC_POSTED_PRIVATE : MAC_POSTED, p);
  if (p && p.by === "you") return postedRow("posted_you", YOU_POSTED, p);
  if (p && p.status === "mac" && p.mac) return macRow(p.mac, ctx);
  // The rest is TikTok's API or the Mac: once TikTok approved the app, those rows stay as they were.
  if (ctx.audited || !facts.offer) return null;
  if (facts.privateTest) return { kind: "private_test", words: MAC_ROW_PRIVATE_TEST, button: null };
  // The Mac never takes a campaign clip (Branded content): he posts it in TikTok and adds its link (§47.2).
  if (facts.campaign) return { kind: "campaign", words: MAC_ROW_CAMPAIGN, button: "add_link" };
  const words = p && p.status === "posted" && p.privacy === "private" ? MAC_ROW_ONLY_YOU : MAC_ROW_NOT_YET;
  return notReady(ctx, false) ?? { kind: "offer", words, button: "post_with_mac" };
}

/** Does this row read the Mac's check-in (GET /v1/tiktok/mac)? Its Mac post, or a clip the Mac could take. */
export function rowNeedsMac(facts: TikTokFacts): boolean {
  return facts.post?.status === "mac" || (facts.offer && !facts.campaign && !facts.privateTest);
}

/** Does this row read auto-posting's runs (GET /v1/autopost)? A backlog clip waiting while auto-posting is on. */
export function rowNeedsRuns(facts: TikTokFacts, autoPostOn: boolean | undefined): boolean {
  const mac = facts.post?.status === "mac" ? facts.post.mac : undefined;
  return autoPostOn === true && mac?.state === "waiting" && mac.source === "sent";
}

/** Auto-posting's newest scheduled live run, as the helper reads it (run.js); the row itself no longer reads it. */
export function lastLiveRunAt(runs: readonly { at: string; kind: string; mode: string }[] | undefined): string | null {
  return runs?.find((r) => r.kind === "scheduled" && r.mode === "live")?.at ?? null;
}

/** The clip page's chip for a Mac post (its stack says the rest). */
export function macChip(mac: Pick<PostMac, "state">): string {
  return mac.state === "working" ? MAC_ROW_POSTING : mac.state === "stopped" ? "Didn't work" : MAC_ROW_WAITING;
}

// ---------- Settings › Posting › Your Mac posts TikTok ----------

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

/**
 * When the Mac posts (the owner, 22 Nov: TikTok follows auto-posting, and his Upload goes at once): "Posts with
 * auto-posting · next Sun 22:00 · 14 waiting", or "Posts when you tap Upload · 14 waiting" while auto-posting is off.
 */
export function whenLine(autoOn: boolean, nextRunAt: string | null | undefined, waiting: number, now: number = Date.now()): string {
  const lead = autoOn ? `Posts with auto-posting${nextRunAt ? ` · next ${timeWords(nextRunAt, now)}` : ""}` : "Posts when you tap Upload";
  return `${lead} · ${waiting} waiting`;
}

/** "{n} waiting for your Mac". */
export function waitingLine(n: number): string {
  return `${n} waiting for your Mac`;
}

/** What Send these to my Mac takes: "3 clips aren't on TikTok yet." */
export function sendableLine(n: number): string {
  return `${plural(n, "clip")} ${n === 1 ? "isn't" : "aren't"} on TikTok yet.`;
}

/** The toast after Send these to my Mac. */
export function sentLine(sent: number): string {
  return `Sent ${plural(sent, "clip")} to your Mac.`;
}
