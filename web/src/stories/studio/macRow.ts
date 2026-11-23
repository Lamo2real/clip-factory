// My Mac posts TikTok in Clips Funded (docs/CONTRACTS.md §47.10): what a TikTok post row says while the owner's Mac
// posts it, with its chip and its buttons, only from what the server and the Mac know. The timing rules are Clip
// Factory's own (web/src/lib/tiktokMac.ts, the API's tiktok_self), imported and never copied. Pure helpers here.
import { clockWords, MAC_FIND_WINDOW_MS, MAC_STALE_MS, macStuck, macWindowOver, shortReason } from "../../lib/tiktokMac.ts";
import type { PublishingJob, PubJobMac, WsMacHelper, WsMacJob, WsMacStatus } from "../api/types.ts";
import * as W from "./macWords.ts";

/**
 * The first helper version that posts Clips Funded's TikTok (the API's workspaces/mac.py MAC_WS_FROM; a test pins
 * them). An older helper never takes a Clips Funded post, so its posts say "Your Mac isn't set up yet".
 */
export const MAC_WS_FROM = "1.2.0";

/** The options Post it sends for TikTok while the Mac posts it: everyone, Comments, Duet and Stitch on, never branded. */
export const MAC_TIKTOK_OPTIONS = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  disableComment: false,
  disableDuet: false,
  disableStitch: false,
  brandContent: false,
  brandOrganic: false,
} as const;

const parts = (v: string | undefined): number[] | null => {
  const p = (v ?? "").trim().split(".");
  return p.length > 0 && p.every((x) => /^\d+$/.test(x)) ? p.map(Number) : null;
};

/** True when `v` is a version at or after `from` ("1.2.0" ≥ "1.2.0"); false for none or not a version. */
export function versionAtLeast(v: string | undefined, from: string = MAC_WS_FROM): boolean {
  const said = parts(v);
  const min = parts(from);
  if (!said || !min) return false;
  for (let i = 0; i < Math.max(said.length, min.length); i++) {
    const d = (said[i] ?? 0) - (min[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** A helper that can post Clips Funded's TikTok checked in (1.2.0 or later). */
export function macHelperNew(helper: WsMacHelper | null | undefined): helper is WsMacHelper {
  return !!helper && versionAtLeast(helper.version);
}

/** The Mac is set up for this workspace: a new helper whose own TikTok login reads the target account. */
export function macSetUp(helper: WsMacHelper | null | undefined): boolean {
  return macHelperNew(helper) && helper.setUp === true;
}

/** The Mac has not checked in for 30 minutes. */
export function macNotSeen(helper: Pick<WsMacHelper, "seenAt"> | null | undefined, now: number = Date.now()): boolean {
  const seen = Date.parse(helper?.seenAt ?? "");
  return Number.isFinite(seen) && now - seen >= MAC_STALE_MS;
}

/** The helper's words when TikTok logged a Clips Funded lane out (its WS_REASONS.login; a test pins them). */
export const MAC_LOGGED_OUT = "TikTok logged your Mac out. Tap Log in on my Mac.";

/** A needs-you reason the owner fixes with Log in on my Mac (logged out, or logged in to another account): the
 * helper's own check (tiktok.js loginReason). */
export function loginReason(reason: string | undefined): boolean {
  return reason === MAC_LOGGED_OUT || (reason ?? "").startsWith("Your Mac is logged in to TikTok as ");
}

/** Stuck: no beat for 5 minutes, or a claim 50 minutes old (every helper that posts Clips Funded beats). */
export function macJobStuck(mac: Pick<PubJobMac, "state" | "claimedAt" | "beatAt">, now: number = Date.now()): boolean {
  return macStuck(mac, now, true);
}

/**
 * How many posts the Mac takes before this one: every working post that is not stuck, and every waiting one earlier
 * in the queue (oldest first, one at a time). Null when the queue is not known or this post is not waiting in it.
 */
export function macPlace(queue: readonly Pick<WsMacJob, "publishingJobId" | "state" | "claimedAt" | "beatAt">[] | null | undefined, publishingJobId: string, now: number = Date.now()): number | null {
  if (!queue) return null;
  const mine = queue.findIndex((j) => j.publishingJobId === publishingJobId && j.state === "waiting");
  if (mine < 0) return null;
  let before = 0;
  queue.forEach((j, i) => {
    if (i === mine) return;
    if (j.state === "working") {
      if (!macJobStuck(j, now)) before += 1;
    } else if (j.state === "waiting" && i < mine) before += 1;
  });
  return before;
}

/** A TikTok post the API (not the Mac, not the owner) posted Only me (TikTok's Sandbox): only the owner sees it. */
export function onlyYouPost(job: Pick<PublishingJob, "platform" | "publishingStatus" | "via" | "by" | "onlyMe">): boolean {
  return job.platform === "tiktok" && job.publishingStatus === "posted" && job.onlyMe === true && !job.via && !job.by;
}

/** A Mac post's chip. */
export function macChip(job: Pick<PublishingJob, "publishingStatus" | "mac">, now: number = Date.now()): string {
  if (job.publishingStatus === "posted") return W.MAC_CHIP_POSTED;
  const mac = job.mac;
  if (!mac || mac.state === "waiting") return W.MAC_CHIP_WAITING;
  if (mac.state === "working" && !macJobStuck(mac, now)) return W.MAC_CHIP_POSTING;
  return mac.pressedAt ? W.MAC_CHIP_NOT_SURE : W.MAC_CHIP_FAILED;
}

export type MacTone = "sun" | "coral" | "mint" | "sky" | "plain";

/**
 * A row's buttons: open (its link), turn_on and set_up (to the TikTok card), open_stopped (the post the Mac stopped
 * on), try_again, on_tiktok (its link box, and It's on TikTok, no link), again_ask (a quiet Try again that asks first:
 * "Post it again? Only if it's not on your TikTok."), post_with_mac (Post it with only TikTok ticked), social (Open
 * Social accounts, beside Try again when the reason is an account problem: §45.36 E9).
 */
export type MacButton = "open" | "turn_on" | "set_up" | "open_stopped" | "try_again" | "on_tiktok" | "again_ask" | "post_with_mac" | "social";

export interface MacRow {
  chip: string;
  tone: MacTone;
  line: string;
  buttons: MacButton[];
  /** the turning circle beside "Posting…" */
  spinner?: boolean;
  /** open_stopped's story */
  stoppedStoryId?: string;
  /** the row's own class: is-posted, is-failed, is-mac */
  look: "posted" | "failed" | "mac";
}

export interface MacRowContext {
  /** My Mac posts TikTok is on */
  on: boolean;
  /** GET …/tiktok/mac, or null until it is read */
  status: WsMacStatus | null;
  now?: number;
}

/**
 * The row of a TikTok post the Mac posts or posted (§47.10.6), or null for any other post (its usual row). With no
 * context (a screen that does not know the switch) a Mac post reads as on, its Mac not known yet, and an API post
 * keeps its usual row.
 */
export function macRow(job: PublishingJob, ctx: MacRowContext | null): MacRow | null {
  const now = ctx?.now ?? Date.now();
  if (job.publishingStatus === "posted") {
    if (job.via === "mac") return { chip: W.MAC_CHIP_POSTED, tone: "mint", line: W.MAC_ROW_POSTED, buttons: job.url ? ["open"] : [], look: "posted" };
    if (job.by === "you") return { chip: W.MAC_CHIP_POSTED, tone: "mint", line: W.MAC_ROW_YOU + (job.url ? "" : W.MAC_ROW_NO_LINK), buttons: job.url ? ["open"] : [], look: "posted" };
    if (ctx?.on && onlyYouPost(job)) return { chip: W.MAC_CHIP_POSTED, tone: "mint", line: W.MAC_ROW_ONLY_YOU, buttons: ["post_with_mac"], look: "posted" };
    return null;
  }
  if (job.publishingStatus !== "mac") return null;
  const mac: PubJobMac = job.mac ?? { state: "waiting", since: job.updatedAt };
  const on = ctx ? ctx.on : true;
  const status = ctx?.status ?? null;
  const helper = status?.helper ?? null;
  const chip = macChip({ publishingStatus: job.publishingStatus, mac }, now);

  if (mac.state === "waiting") {
    const waiting = (line: string, buttons: MacButton[] = [], extra: Partial<MacRow> = {}): MacRow => ({ chip, tone: "sky", line, buttons, look: "mac", ...extra });
    if (!on) return waiting(W.MAC_ROW_OFF, ["turn_on"]);
    // Not read yet: nothing is said that may be wrong.
    if (!status) return waiting(W.MAC_CHIP_WAITING);
    if (!macSetUp(helper)) return waiting(W.MAC_ROW_NOT_SET_UP, ["set_up"]);
    if (macNotSeen(helper, now)) return waiting(W.rowNotSeenWords(clockWords(helper!.seenAt, now)));
    if (helper!.state === "needs_you" && helper!.needsYouJobId !== job.publishingJobId)
      return waiting(W.MAC_ROW_NEEDS_YOU, helper!.needsYouStoryId ? ["open_stopped"] : [], helper!.needsYouStoryId ? { stoppedStoryId: helper!.needsYouStoryId } : {});
    if (helper!.state === "paused") return waiting(W.MAC_ROW_PAUSED);
    return waiting(W.rowWaitWords(macPlace(status.queue, job.publishingJobId, now)));
  }

  const stuck = mac.state === "working" && macJobStuck(mac, now);
  if (mac.state === "working" && !stuck) return { chip, tone: "sky", line: W.MAC_ROW_POSTING, buttons: [], spinner: true, look: "mac" };
  if (mac.pressedAt) {
    // It may be on TikTok: he looks there first. Try again comes once the 30-minute find window is over, and asks.
    const over = macWindowOver(mac, now);
    const from = over ? "" : W.againFromWords(clockWords(Date.parse(mac.pressedAt) + MAC_FIND_WINDOW_MS, now));
    return { chip, tone: "sun", line: W.MAC_ROW_PRESSED + from, buttons: over ? ["on_tiktok", "again_ask"] : ["on_tiktok"], look: "mac" };
  }
  if (stuck) return { chip, tone: "coral", line: W.MAC_ROW_STOPPED_EARLY, buttons: ["try_again"], look: "failed" };
  // An account problem is fixed in Social accounts first (§45.36 E9).
  const social = /Social accounts/i.test(mac.reason ?? "");
  return { chip, tone: "coral", line: W.rowFailedWords(shortReason(mac.reason)), buttons: social ? ["social", "try_again"] : ["try_again"], look: "failed" };
}

/** A waiting or working Mac post: Review reads the posts again every 10 seconds while there is one. */
export function macInFlight(job: Pick<PublishingJob, "publishingStatus" | "mac">): boolean {
  return job.publishingStatus === "mac" && (job.mac?.state ?? "waiting") !== "stopped";
}

/** Link checks before sending: a TikTok video link ("https://www.tiktok.com/@name/video/123…"). */
export const TIKTOK_LINK = /^https:\/\/(www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,30})\/video\/(\d{8,25})/;
