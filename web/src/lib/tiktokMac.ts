// Your Mac posts it on TikTok (docs/CONTRACTS.md §47). With Settings › Posting › Your Mac posts TikTok on, Upload and
// auto-posting hand the clip's TikTok post to the owner's Mac (`Post.status: "mac"`), which posts it in TikTok
// Studio for Everyone. Until TikTok approves the app the Mac is the only way to TikTok (ADR-85): every TikTok row says
// what the Mac is doing, with at most one button (tiktokRow). Pure helpers here: the row, who may be sent, the
// Settings lines.
import type { Clip, MacHelper, MacJob, PlatformPerformance, Post, PostMac, Settings } from "../api/types.ts";
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
/** Paused with no reason of its own (a helper from before it said why). */
export const MAC_PAUSED = "Paused on your Mac";
export const MAC_SEND_CONFIRM = "They go one at a time, oldest first.";
export const MAC_STOP_LINE = "To stop it, turn the switch off. Your Mac stops at once.";
/**
 * What the server keeps as the reason once the Mac pressed Post but could not confirm it (§47.3, tiktok_mac.PRESSED),
 * word for word. The rows never show it: they pick their own words by `pressedAt` (MAC_ROW_PRESSED).
 */
export const MAC_PRESSED_REASON = "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok.";
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
/** Try again inside the find window after Post was pressed (tiktok_mac.MAC_STILL_LOOKING). */
export const MAC_STILL_LOOKING = "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later.";
/** Find it for me found nothing (routes/clips.FIND_NONE): nothing is saved. */
export const MAC_FIND_NONE = "Not found yet. Try again in a minute, or paste the link.";
/** The owner's request to the Mac (POST /v1/tiktok/mac/request), its refusals. */
export const MAC_REQUEST_PICK = "Pick resume or let_go.";
export const MAC_NOT_PAUSED = "Your Mac isn't paused.";
export const MAC_NOT_HOLDING = "Your Mac isn't holding any clips.";

/** The Mac was not seen for this long: its rows say since when, with Open Your Mac posts TikTok. */
export const MAC_STALE_MS = 30 * 60_000;
/**
 * The stuck rule (§47.3, the API's tiktok_self.MAC_BEAT_STALE, MAC_CLAIM_MAX): a Mac post still `working` whose own
 * beat (`beatAt`, else `claimedAt`) is this old, or whose claim is MAC_CLAIM_MAX old (12 min upload wait + the post
 * wait + the 30-minute find window), whichever comes first. Only then may the owner say it's on TikTok or try again.
 */
export const MAC_BEAT_STALE_MS = 5 * 60_000;
export const MAC_CLAIM_MAX_MS = 50 * 60_000;
/** After Post was pressed the Mac looks for the post this long (tiktok_self.MAC_FIND_WINDOW): Try again waits for it. */
export const MAC_FIND_WINDOW_MS = 30 * 60_000;
/** A stuck post whose Mac has not checked in this long says since when (D5). */
export const MAC_OFFLINE_MS = 10 * 60_000;
/** POST /v1/tiktok/mac/send takes at most this many clips at once. */
export const MAC_SEND_MAX = 25;

// The TikTok row's words (§47.4).
export const MAC_ROW_WAITING = "Waiting for your Mac";
/** First in the Mac's queue: the Mac takes it at its next tick. */
export const MAC_ROW_NEXT = "next";
/** A backlog clip during a backfill: the Mac's own pace, no time. */
export const MAC_ROW_IN_LINE = "in line";
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
/**
 * Paused on the Mac: what goes on next. The trial pause (plan.js: "Paused after the 3 trial posts. Clip Factory checks
 * their views first.") ends once their views are checked; any other pause (cli.js off, or a batch that stopped) holds
 * the clips until the Mac is started again: Start my Mac again (POST /v1/tiktok/mac/request resume) does that.
 */
export const MAC_PAUSED_TRIAL_NEXT = "your Mac goes on once their views are checked";
export const MAC_PAUSED_NEXT = "your clips wait until it's started again";
/** The Mac pressed Post but couldn't tell if it posted, or its claim is stuck: the chip's words. */
export const MAC_NOT_SURE = "Not sure it posted";
/** It may be on TikTok, so he looks there first (It's on TikTok, or Try again). */
export const MAC_ROW_PRESSED = `${MAC_NOT_SURE} · look on your TikTok`;
export const MAC_ROW_PRIVATE_TEST = "Private test · stays off TikTok";
export const MAC_ROW_ADD_LINK = " · add the link";
/**
 * A campaign clip (D1): the Mac can't set TikTok's Branded content disclosure yet, so it never posts one (the server
 * refuses it on every Mac path: tiktok_mac.CAMPAIGN_SKIPS, word for word).
 */
export const MAC_ROW_CAMPAIGN = "Campaign clips skip TikTok for now: your Mac can't mark them as Branded content yet.";
/** The clip page's stack line while its chip says "Not sure it posted" (it never says that twice). */
export const MAC_CLIP_PAGE_LOOK = "Look on your TikTok";
/** "starting again within a minute": a paused row after Start my Mac again, until the Mac checks in. */
export const MAC_PAUSED_STARTING = "starting again within a minute";

/** "in line (2 before it)": a clip's place in the Mac's queue. */
export function inLineWords(before: number): string {
  return `in line (${before} before it)`;
}

/** "goes at about 20:30": the first backlog clip's time (the helper's own backlogAt, plan.js). */
export function backlogTimeWords(at: string): string {
  return `goes at about ${at}`;
}

/** "Held on your Mac: made before 03:55": an auto-posting clip the Mac holds (its holdAutoBefore). */
export function heldWords(at: string): string {
  return `Held on your Mac: made before ${at}`;
}

// The row's buttons (§47.4), each the app's own Button or LinkButton.
/** open_mac: to Settings › Posting › Your Mac posts TikTok, where the Mac's status line says the rest. */
export const MAC_OPEN_BUTTON = "Open Your Mac posts TikTok";
/** on_tiktok: the Mac pressed Post; it opens the row's Add link (its link, or Find it for me). */
export const MAC_ON_TIKTOK_BUTTON = "It's on TikTok";
/** Try again beside It's on TikTok asks first: posting it again is only for a post that isn't there. */
export const MAC_AGAIN_CONFIRM = "Post it again? Only if it's not on your TikTok.";
/** Add link's finder: Clip Factory looks for the post on his TikTok (no link needed). */
export const MAC_FIND_BUTTON = "Find it for me";
/** Save the link with an empty box: nothing is sent. */
export const MAC_LINK_EMPTY = "Paste the link first, or tap Find it for me.";
/** On TikTok without its link (D3): only after its own question. */
export const MAC_NO_LINK_BUTTON = "It's on TikTok, no link";
export const MAC_NO_LINK_CONFIRM = "Save it as on TikTok without its link? Its views show once you add the link.";
export const MAC_NO_LINK_YES = "Yes, it's on TikTok";
export const MAC_NO_LINK_SAVED = "Saved. Add its link later to see its views.";
/** resume: Start my Mac again (POST /v1/tiktok/mac/request resume); the Mac reads it at its next tick. */
export const MAC_RESUME_BUTTON = "Start my Mac again";
export const MAC_RESUMED_TOAST = "Your Mac starts again within a minute.";
export const MAC_RESUME_PENDING = "Your Mac starts again the next time it checks in, within a minute.";
/** open_stopped: the clip the Mac stopped on while it needs him (its Try again and It's on TikTok are there). */
export const MAC_OPEN_STOPPED_BUTTON = "Open the stopped clip";
/** Let them go: the Mac drops its hold on older auto-posting clips (POST /v1/tiktok/mac/request let_go). */
export const MAC_LET_GO_BUTTON = "Let them go";
export const MAC_LET_GO_TOAST = "Your Mac lets them go within a minute.";
export const MAC_LET_GO_PENDING = "Your Mac lets them go the next time it checks in, within a minute.";

/** "Your Mac holds auto-posting clips made before Mon 03:55." (Settings, while the Mac holds them). */
export function holdLine(at: string): string {
  return `Your Mac holds auto-posting clips made before ${at}.`;
}

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
 * setup, failed, or uploaded privately), not a campaign clip (the Mac can't mark it as Branded content yet, D1) and not
 * a Private test run's clip.
 */
export function canSendToMac(clip: Clip, posts: Post[]): boolean {
  return canPostYourself(clip, posts) && !clip.campaignId && clip.auto?.test !== "private";
}

// ---------- The TikTok row (§47.4) ----------

/** What a TikTok row reads: the clip's TikTok post, if any, and what the clip is. */
export interface TikTokFacts {
  /** The clip, for its place in the Mac's queue (a backlog clip's wait). */
  clipId?: string;
  post: Pick<Post, "status" | "by" | "via" | "url" | "privacy" | "mac" | "postedAt"> | null;
  /** Kept and not on TikTok for everyone (canPostYourself): the Mac can take it, unless campaign or Private test. */
  offer: boolean;
  /** A campaign clip (`campaignId`): it skips TikTok for now (D1). */
  campaign: boolean;
  privateTest: boolean;
}

/** The facts from a clip and its posts (Library, Review). */
export function tiktokFacts(clip: Clip, posts: readonly Post[]): TikTokFacts {
  return {
    clipId: clip.clipId,
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
  /** The Mac's queue (GET /v1/tiktok/mac), in the server's order: a waiting clip's place in it. Unknown: no place. */
  queue?: readonly MacQueueJob[] | null;
  /** Auto-posting is on (a backlog or auto-posting clip waits for it). Unknown: no auto-posting-off row. */
  autoPostOn?: boolean;
  now?: number;
}

/** What macPlace reads of a job in the Mac's queue. */
export type MacQueueJob = Pick<MacJob, "clipId" | "source" | "state"> & Partial<Pick<MacJob, "since" | "claimedAt" | "beatAt">>;

export type TikTokRowKind = "posted" | "posted_you" | "working" | "waiting" | "stopped" | "not_ready" | "offer" | "campaign" | "private_test";
/**
 * The row's button. `try_again`: retry `now`. `post_with_mac`: send `now` (also a waiting post while auto-posting is
 * off, or one the Mac holds, which then goes as an Upload tap's). `turn_on` and `open_mac`: links to `href`
 * (MAC_OPEN_BUTTON's words). `open_stopped`: a link to the clip the Mac stopped on (`href`). `resume`: Start my Mac
 * again. `add_link`: the inline Add link. `on_tiktok`: not sure it posted (the Mac pressed Post but couldn't tell, or
 * its post is stuck): MAC_ON_TIKTOK_BUTTON opens the inline Add link (its link, or Find it for me from `since`, and
 * with `noLink` MAC_NO_LINK_BUTTON), and with `again` Try again (`notOnTikTok`, after MAC_AGAIN_CONFIRM) is the second,
 * quieter choice beside it.
 */
export type TikTokRowButton = "try_again" | "post_with_mac" | "turn_on" | "open_mac" | "open_stopped" | "resume" | "add_link" | "on_tiktok";

export interface TikTokRow {
  kind: TikTokRowKind;
  words: string;
  /** The row's button, or none (`on_tiktok` comes with Try again beside it). */
  button: TikTokRowButton | null;
  /** Turn on, open_mac and open_stopped: where it goes. */
  href?: string;
  /** The post on TikTok (Open). */
  url?: string;
  /** Add link and It's on TikTok: the finder looks for the post on his TikTok from here. */
  since?: string;
  /** The Mac is posting it right now. */
  spinner?: true;
  /** on_tiktok: Try again shows beside It's on TikTok (never while the Mac may still be posting or looking, D2). */
  again?: boolean;
  /** on_tiktok: "It's on TikTok, no link" is offered (never while the Mac works on it before Post, D3). */
  noLink?: boolean;
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

const at = (iso: string | undefined): number => Date.parse(iso ?? "");

/**
 * The stuck rule (§47.3, the API's tiktok_self.mac_stuck, the same): a Mac post still `working` whose own beat
 * (`beatAt`, else `claimedAt`) is MAC_BEAT_STALE_MS old or more, or whose claim is MAC_CLAIM_MAX_MS old or more,
 * whichever comes first. Also read on a queue job (MacJob has the same three fields).
 */
export function macStuck(mac: Pick<PostMac, "state" | "claimedAt" | "beatAt">, now: number = Date.now()): boolean {
  if (mac.state !== "working") return false;
  const beat = at(mac.beatAt ?? mac.claimedAt);
  const claimed = at(mac.claimedAt);
  return (Number.isFinite(beat) && now - beat >= MAC_BEAT_STALE_MS) || (Number.isFinite(claimed) && now - claimed >= MAC_CLAIM_MAX_MS);
}

/** The find window after Post was pressed is over (tiktok_self.window_over): no `pressedAt`, or it is 30 minutes old. */
export function macWindowOver(mac: Pick<PostMac, "pressedAt">, now: number = Date.now()): boolean {
  if (!mac.pressedAt) return true;
  const pressed = at(mac.pressedAt);
  return Number.isFinite(pressed) && now - pressed >= MAC_FIND_WINDOW_MS;
}

/** The Mac beat this post less than MAC_BEAT_STALE_MS ago (tiktok_self.beat_fresh): `beatAt`, else `claimedAt`. */
function beatFresh(mac: Pick<PostMac, "claimedAt" | "beatAt">, now: number): boolean {
  const beat = at(mac.beatAt ?? mac.claimedAt);
  return Number.isFinite(beat) && now - beat < MAC_BEAT_STALE_MS;
}

/** plan.js picks one job per tick: Upload taps first, then auto-posting's, then the backlog. */
const RANK: Record<MacJob["source"], number> = { upload: 0, auto: 1, sent: 2 };

/** An auto-posting job the Mac holds (its holdAutoBefore, reported in its ping): made before that time. */
function heldBy(job: Pick<MacJob, "source"> & { since?: string }, helper: MacHelper | null | undefined): boolean {
  const hold = at(helper?.holdBefore);
  return job.source === "auto" && Number.isFinite(hold) && at(job.since) < hold;
}

/**
 * A waiting clip's place in the Mac's queue (D4): how many jobs the Mac takes before it, counted the way plan.js picks
 * (one per tick, Upload first, then auto, then backlog): every `working` job that is not stuck, and every other waiting
 * job the Mac does not hold whose rank is lower, or the same and earlier in the server's order. Null when the queue is
 * not known or this clip is not a waiting job in it.
 */
export function macPlace(queue: readonly MacQueueJob[] | null | undefined, clipId: string, helper: MacHelper | null | undefined, now: number = Date.now()): number | null {
  if (!queue) return null;
  const mine = queue.findIndex((j) => j.clipId === clipId && j.state === "waiting");
  if (mine < 0) return null;
  const rank = RANK[queue[mine]!.source];
  let before = 0;
  queue.forEach((j, i) => {
    if (i === mine) return;
    if (j.state === "working") {
      if (!macStuck(j, now)) before += 1;
      return;
    }
    if (j.state !== "waiting" || heldBy(j, helper)) return;
    const r = RANK[j.source];
    if (r < rank || (r === rank && i < mine)) before += 1;
  });
  return before;
}

/**
 * What a waiting Mac post's row says (§47.4, D4), only from what the server and the Mac know. Its place in the Mac's
 * queue (macPlace): first, "Waiting for your Mac · next"; later, "Waiting for your Mac · in line (2 before it)". The
 * first backlog clip goes at the helper's own backlogAt (plan.js: 30 minutes after the last run when that run's slot
 * is unused, else after the next run): "Waiting for your Mac · goes at about 20:30", or "next" once that time passed;
 * during a backfill "Waiting for your Mac · in line" (the Mac's own pace). Not known: "Waiting for your Mac" alone,
 * never a time that may be wrong.
 */
export function macWaitWords(mac: Pick<PostMac, "source">, ctx: TikTokRowContext, clipId?: string): string {
  const now = ctx.now ?? Date.now();
  const n = clipId ? macPlace(ctx.queue, clipId, ctx.helper, now) : null;
  const say = (words: string) => `${MAC_ROW_WAITING} · ${words}`;
  if (n === null) return MAC_ROW_WAITING;
  if (n > 0) return say(inLineWords(n));
  if (mac.source !== "sent") return say(MAC_ROW_NEXT);
  if (ctx.helper?.backfill) return say(MAC_ROW_IN_LINE);
  const backlog = at(ctx.helper?.backlogAt);
  if (!Number.isFinite(backlog)) return MAC_ROW_WAITING;
  return say(backlog <= now ? MAC_ROW_NEXT : backlogTimeWords(clockWords(backlog, now)));
}

/**
 * Paused on the Mac (§47.3 ping `paused`): the reason's first sentence and what goes on next. "Paused after the 3
 * trial posts · your Mac goes on once their views are checked"; "Paused on your Mac · your clips wait until it's
 * started again".
 */
export function pausedWords(h: Pick<MacHelper, "reason">): string {
  const { why, next } = pausedParts(h);
  return `${why} · ${next}`;
}

function pausedParts(h: Pick<MacHelper, "reason">): { why: string; next: string } {
  const why = shortReason(h.reason) || MAC_PAUSED;
  return { why, next: /\btrial\b/i.test(why) ? MAC_PAUSED_TRIAL_NEXT : MAC_PAUSED_NEXT };
}

const macSettings = () => settingsPath("posting", "tiktok-mac");
const turnOn = (words: string): TikTokRow => ({ kind: "not_ready", words, button: "turn_on", href: macSettings() });
const openMac = (words: string): TikTokRow => ({ kind: "not_ready", words, button: "open_mac", href: macSettings() });

/** "Your Mac needs you: TikTok wants a code · look at your Mac". */
function needsYouWords(h: Pick<MacHelper, "reason">): string {
  const why = shortReason(h.reason);
  return `${MAC_ROW_NEEDS_YOU}${why ? `: ${why}` : ""} · ${MAC_ROW_LOOK}`;
}

/** "Your Mac hasn't checked in since 14:05". */
const sinceWords = (seen: number, now: number) => `Your Mac hasn't checked in since ${clockWords(seen, now)}`;

/**
 * The Mac can't post right now (§47.4, 6.3): its switch is off or it never checked in (Turn on), or it was not seen
 * for 30 minutes (Open Your Mac posts TikTok: the switch is already on). On waiting and not-yet rows (not on a stopped
 * row, which keeps its Try again: that is what turns "needs you" back to ok) also: it needs him (Open the stopped
 * clip, where its Try again and It's on TikTok are), or it is paused (Start my Mac again, or "starting again within a
 * minute" once asked). Null while it is ready, or while that is not known.
 */
function notReady(ctx: TikTokRowContext, stopped: boolean, clipId?: string): TikTokRow | null {
  if (ctx.macOn === false) return turnOn(MAC_ROW_OFF);
  if (ctx.helper === null) return turnOn(MAC_ROW_NOT_SET_UP);
  const h = ctx.helper;
  if (!h) return null;
  const now = ctx.now ?? Date.now();
  const seen = at(h.seenAt);
  if (Number.isFinite(seen) && now - seen >= MAC_STALE_MS) return openMac(sinceWords(seen, now));
  if (stopped) return null;
  if (h.state === "needs_you") {
    const stoppedOn = h.needsYouClipId;
    if (!stoppedOn || stoppedOn === clipId) return openMac(needsYouWords(h));
    return { kind: "not_ready", words: needsYouWords(h), button: "open_stopped", href: `/clips/${stoppedOn}` };
  }
  if (h.state === "paused") {
    if (h.resumeRequest) return { kind: "not_ready", words: `${pausedParts(h).why} · ${MAC_PAUSED_STARTING}`, button: null };
    return { kind: "not_ready", words: pausedWords(h), button: "resume" };
  }
  return null;
}

/** Where the finder looks for a pressed post: from a minute before the Mac claimed it (the API's FIND_EARLY). */
function findSince(mac: Pick<PostMac, "claimedAt" | "pressedAt">): string | undefined {
  const t = at(mac.claimedAt ?? mac.pressedAt);
  return Number.isFinite(t) ? new Date(t - MINUTE).toISOString() : undefined;
}

function postedRow(kind: "posted" | "posted_you", words: string, p: NonNullable<TikTokFacts["post"]>): TikTokRow {
  if (p.url) return { kind, words, button: null, url: p.url };
  return { kind, words: `${words}${MAC_ROW_ADD_LINK}`, button: "add_link", ...(p.postedAt ? { since: p.postedAt } : {}) };
}

/**
 * Not sure it posted (D2): It's on TikTok first (it never posts again); Try again beside it only once the 30-minute
 * find window after Post is over (`again`); "It's on TikTok, no link" unless the Mac still works on it before Post.
 */
function notSure(mac: PostMac, words: string, now: number, noLink: boolean): TikTokRow {
  const since = findSince(mac);
  return { kind: "stopped", words, button: "on_tiktok", ...(since ? { since } : {}), again: macWindowOver(mac, now), noLink };
}

/** A Mac post's row (6.2): not sure it posted, Didn't work, the Mac can't post, Posting…, held, or waiting. */
function macRow(mac: PostMac, ctx: TikTokRowContext, clipId?: string): TikTokRow {
  const now = ctx.now ?? Date.now();
  // It may be on TikTok. Words chosen by pressedAt, never by matching the stored reason. Saying it's on TikTok needs
  // no Mac, so this shows even while it can't post.
  if (mac.state === "stopped" && mac.pressedAt) return notSure(mac, MAC_ROW_PRESSED, now, true);
  if (mac.state === "stopped") {
    const ready = notReady(ctx, true, clipId);
    if (ready) return ready;
    const why = shortReason(mac.reason);
    // It needs him: Try again only helps once he did it on the Mac.
    const first = ctx.helper?.state === "needs_you" ? ` · ${MAC_ROW_LOOK} first` : "";
    return { kind: "stopped", words: `${why ? `Didn't work: ${why}` : "Didn't work"}${first}`, button: "try_again" };
  }
  if (mac.state === "working") {
    // Stuck (its own beat 5 minutes old, or its claim 50): the Mac stopped working on it. Since when, if the Mac
    // itself has not checked in for 10 minutes (or never), else "Not sure it posted".
    if (macStuck(mac, now)) {
      const seen = at(ctx.helper?.seenAt);
      let words = MAC_ROW_PRESSED;
      if (ctx.helper === null) words = MAC_ROW_NOT_SET_UP;
      else if (Number.isFinite(seen) && now - seen >= MAC_OFFLINE_MS) words = sinceWords(seen, now);
      return notSure(mac, words, now, !(!mac.pressedAt && beatFresh(mac, now)));
    }
    // The Mac is on it (D2): never Not sure it posted or Try again here. The switch turned off before Post says so.
    if (ctx.macOn === false) return turnOn(MAC_ROW_OFF);
    return { kind: "working", words: MAC_ROW_POSTING, button: null, spinner: true };
  }
  const ready = notReady(ctx, false, clipId);
  if (ready) return ready;
  // Auto-posting off: a backlog or auto-posting clip would wait for good, so he can send this one now.
  if ((mac.source === "sent" || mac.source === "auto") && ctx.autoPostOn === false) return { kind: "waiting", words: MAC_ROW_AUTO_OFF, button: "post_with_mac" };
  // Held on the Mac (its holdAutoBefore): it would wait for good too.
  if (heldBy(mac, ctx.helper)) return { kind: "waiting", words: heldWords(clockWords(ctx.helper!.holdBefore!, now)), button: "post_with_mac" };
  return { kind: "waiting", words: macWaitWords(mac, ctx, clipId), button: null };
}

/**
 * The TikTok row (§47.4): only what the Mac is doing, with at most one button (It's on TikTok may come with Try
 * again). In this order: posted by the Mac (Open, or Add link); posted by him (§42); a Mac post (macRow); a Private
 * test; a campaign clip (it skips TikTok for now, D1); not on TikTok yet (Post with my Mac). Null: the row keeps its
 * old words and buttons, for a clip not on TikTok once TikTok approved the app, and for Clip Factory's own posts.
 */
export function tiktokRow(facts: TikTokFacts, ctx: TikTokRowContext): TikTokRow | null {
  const p = facts.post;
  if (p && p.status === "posted" && p.via === "mac") return postedRow("posted", p.privacy === "private" ? MAC_POSTED_PRIVATE : MAC_POSTED, p);
  if (p && p.by === "you") return postedRow("posted_you", YOU_POSTED, p);
  if (p && p.status === "mac" && p.mac) return macRow(p.mac, ctx, facts.clipId);
  // The rest is TikTok's API or the Mac: once TikTok approved the app, those rows stay as they were.
  if (ctx.audited || !facts.offer) return null;
  if (facts.privateTest) return { kind: "private_test", words: MAC_ROW_PRIVATE_TEST, button: null };
  if (facts.campaign) return { kind: "campaign", words: MAC_ROW_CAMPAIGN, button: null };
  const words = p && p.status === "posted" && p.privacy === "private" ? MAC_ROW_ONLY_YOU : MAC_ROW_NOT_YET;
  return notReady(ctx, false, facts.clipId) ?? { kind: "offer", words, button: "post_with_mac" };
}

/** Does this row read the Mac's check-in (GET /v1/tiktok/mac)? Its Mac post, or a clip the Mac could take. */
export function rowNeedsMac(facts: TikTokFacts): boolean {
  return facts.post?.status === "mac" || (facts.offer && !facts.campaign && !facts.privateTest);
}

/**
 * The clip page's chip for a Mac post (its stack says the rest): "Not sure it posted" once the Mac pressed Post but
 * couldn't tell, or when its row says so (a stuck claim, `row`).
 */
export function macChip(mac: Pick<PostMac, "state" | "pressedAt">, row?: Pick<TikTokRow, "button"> | null): string {
  if (row?.button === "on_tiktok" || (mac.state === "stopped" && mac.pressedAt)) return MAC_NOT_SURE;
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

/**
 * Settings' status line: when the Mac checked in, that it never did, that it needs him, or that it is paused (the
 * reason's first sentence and what goes on next: "Paused after the 3 trial posts. Your Mac goes on once their views
 * are checked.").
 */
export function helperLine(helper: MacHelper | null, now: number = Date.now()): string {
  if (!helper) return MAC_NEVER_SEEN;
  if (helper.state === "needs_you") return `Your Mac needs you: ${helper.reason ?? "open it and look."}`;
  if (helper.state === "paused") {
    const { why, next } = pausedParts(helper);
    return `${why}. ${next.charAt(0).toUpperCase()}${next.slice(1)}.`;
  }
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
