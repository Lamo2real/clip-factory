// Mock mode's "Your Mac posts it on TikTok" (docs/CONTRACTS.md §47): the same rules as the API's tiktok_mac.py and
// routes/tiktok_mac.py, with the same constants (lib/tiktokMac.ts). The owner's routes (status, send, retry, Take it
// back, request) answer the app (send and retry with `now` make the post an Upload tap's, source "upload", which the
// Mac posts at once, also one that already waits); the Mac helper's own routes (ping, claim, step, beat, done, stopped)
// are test knobs (window.__cfMock.mac), so e2e can move a Mac post along waiting → working → posted by your Mac, or
// stopped, or stuck. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { Clip, MacHelper, MacJob, MacRequestAction, MacSendResult, MacSource, MacStep, Post, PostMac, Settings, TikTokMacStatus, TikTokPostOptions } from "../types.ts";
import { presetOf } from "../../lib/preset.ts";
import {
  canSendToMac,
  MAC_BEAT_STALE_MS,
  MAC_MAY_HAVE_POSTED,
  MAC_NEVER_SEEN,
  MAC_NOT_HOLDING,
  MAC_NOT_PAUSED,
  MAC_NOT_PRESSED,
  MAC_NOT_POSTING,
  MAC_PRESSED_REASON,
  MAC_REQUEST_PICK,
  MAC_ROW_CAMPAIGN,
  MAC_SEND_MAX,
  MAC_STILL_LOOKING,
  MAC_WORKING,
  macOn,
  macHelperBeats,
  macStuck,
  macWindowOver,
} from "../../lib/tiktokMac.ts";
import { tiktokState, videoFileName } from "../../lib/tiktokYourself.ts";
import { ulid } from "./fixtures.ts";

const AUTO_OFF = "Auto-posting is off, so this one waits.";
const NO_HELPER = "Set up your Mac first. Then it can keep your TikTok login.";
const conflict = (msg: string) => new ApiError(409, "conflict", msg);
const bad = (msg: string) => new ApiError(400, "bad_request", msg);
const notFound = () => new ApiError(404, "not_found", "We could not find that clip.");
const iso = (t: number) => new Date(t).toISOString();
/** The API's validate.boolean on the optional `now` key (absent counts as false). */
function nowKey(now: unknown): boolean {
  if (typeof now !== "boolean") throw bad("now must be true or false.");
  return now;
}

/** A crashed helper's claim (working, never pressed Post) may be taken again after this long without a step. */
export const MAC_STALE_CLAIM_MS = 15 * 60_000;
export const MAC_QUEUE_MAX = 50;
const ANOTHER_TRY = "Another try already has this clip.";
/** tiktok_mac.NOT_LOGIN_HOLD (§47.11). */
const MAC_NOT_LOGIN_HOLD = "Your Mac isn't waiting for a TikTok login on this one.";
const MAC_OFF = "Your Mac posting is off. Turn it on in Settings › Posting › Your Mac posts TikTok.";
const STEPS: readonly MacStep[] = ["video", "opening", "uploading", "settings", "pressing", "finding"];

export interface TikTokMacDeps {
  clips(): Clip[];
  /** The store's own list: posts are added, changed and removed in place. */
  posts(): Post[];
  settings(): Settings;
  /** The TikTok sheet's choices kept on a post (the API's postOptions, never returned). */
  options: Map<string, TikTokPostOptions>;
  publishPost(p: Post): void;
  /** A post left: its live delete news. */
  removePost(p: Post): void;
  publishClip(c: Clip): void;
  now(): number;
}

/** What a ping may add (§47.3 ping, D4/D5): each absent key is removed from the helper item. */
export interface MacPingExtra {
  backlogAt?: string;
  backfill?: boolean;
  holdBefore?: string;
  resumeDone?: string;
  letGoDone?: string;
}

/** The Mac helper's knobs (window.__cfMock.mac). */
export interface TikTokMacControls {
  ping(state?: MacHelper["state"], reason?: string, device?: string, extra?: MacPingExtra): { on: boolean };
  /** §47.8: the Mac says whether it keeps a TikTok login; `done`: it did the owner's pending Change or Forget. */
  login(login: "saved" | "none", done?: boolean): void;
  /** The helper was last seen at `at` (ISO), or never (null). */
  seen(at: string | null): void;
  /** `agoMs`: the claim (and its beat) was made that long ago (a helper that crashed or lost track of it: stuck). */
  claim(clipId: string, device?: string, agoMs?: number): MacJob;
  /** `agoMs`: the step (its beat, and Post's press for `pressing`) was that long ago. A step sent again is a beat. */
  step(clipId: string, step: MacStep, device?: string, agoMs?: number): MacJob;
  /** The job's last beat was `agoMs` ago (5 minutes or more: stuck). */
  beat(clipId: string, agoMs?: number): MacJob;
  done(clipId: string, link?: string, device?: string): { clip: Clip; posts: Post[] };
  /** `needsYou`: the Mac needs him (a login, a code), and says which clip it stopped on; `code` "login" (§47.11): only
   * a TikTok login problem, so the hold may end by itself. */
  stopped(clipId: string, reason: string, needsYou?: boolean, device?: string, code?: "login"): MacJob;
  /**
   * §47.11 (POST …/tiktok/mac/logged-in): the Mac is logged in to the right TikTok again. Only this device's login hold
   * on this clip, else 409. A stopped post that never pressed Post waits again (`resumed`, keeping its place and
   * source); a pressed one is left as it is (`pressed`); anything else only ends the hold (`cleared`).
   */
  loggedIn(clipId: string, device?: string): { helper: MacHelper | null; outcome: "resumed" | "pressed" | "cleared" };
  queue(): MacJob[];
  /** The clip's TikTok post, as the server holds it. */
  post(clipId: string): Post | null;
  /** Tests only: a waiting Mac post becomes `source`'s (an auto-posting run's, say), made `sinceAgoMs` ago. */
  source(clipId: string, source: MacSource, sinceAgoMs?: number): Post;
}

/** My settings' TikTok choices (Everyone, Comment, Duet and Stitch on), in the TikTok sheet's shape (preset_options). */
export function presetChoices(settings: Settings): TikTokPostOptions {
  const t = presetOf(settings.postPreset).tiktok;
  return {
    privacyLevel: t.privacy,
    disableComment: !t.comments,
    disableDuet: !t.duet,
    disableStitch: !t.stitch,
    brandContent: false,
    brandOrganic: false,
  };
}

export function tiktokMacMock(deps: TikTokMacDeps) {
  // The helper item (MACHELPER): never seen until it pings.
  let helper: (MacHelper & { device: string }) | null = null;
  // §47.8: what the Mac said about its TikTok login, and the owner's Change or Forget until the Mac did it.
  let login: MacHelper["login"];
  let loginRequest: MacHelper["loginRequest"];
  // The rest of the helper item (D4/D5): the clip it stopped on, its ping's extras, the owner's two requests.
  let needsYouClipId: string | undefined;
  let needsYouCode: "login" | undefined;
  // §47.11: the Mac that stopped (needsYouDevice: no ping overwrites it, as another Mac's ping does `device`).
  let needsYouDevice: string | undefined;
  let extras: Pick<MacHelper, "backlogAt" | "holdBefore" | "backfill"> = {};
  let resumeRequestAt: string | undefined;
  let letGoRequestAt: string | undefined;
  // Internal per-post fields: who claimed it, and what a converted post was before.
  const claims = new Map<string, { device: string }>();
  // MacJob only (never Post.mac, D2): when Post was pressed before a re-wait, and the owner's last Try again.
  const pressedBefore = new Map<string, string>();
  const againAt = new Map<string, string>();
  // How many claims each Mac post had (the API's macAttempt, MacJob.attempt).
  const attempts = new Map<string, number>();
  const before = new Map<string, Post>();
  const beforeOptions = new Map<string, TikTokPostOptions | undefined>();
  const madeForMac = new Set<string>();

  const clip = (clipId: string): Clip => {
    const c = deps.clips().find((x) => x.clipId === clipId);
    if (!c) throw notFound();
    return c;
  };
  const postsOf = (clipId: string) => deps.posts().filter((p) => p.clipId === clipId);
  const tiktokOf = (clipId: string) => postsOf(clipId).find((p) => p.platform === "tiktok") ?? null;
  const answer = (c: Clip) => ({ clip: structuredClone(c), posts: structuredClone(postsOf(c.clipId)) });

  /** The clip's status after its TikTok post changed: what the clip flow's settle would say (§14.5), as tiktok_self. */
  function settle(c: Clip, nowPosted: boolean) {
    if (c.status !== "confirmed" && c.status !== "posted" && c.status !== "failed") return;
    const others = postsOf(c.clipId).filter((p) => p.platform !== "tiktok");
    if (others.some((p) => p.status === "queued")) return;
    const next = nowPosted || others.some((p) => p.status === "posted") ? "posted" : others.some((p) => p.status === "failed") ? "failed" : "confirmed";
    if (next !== c.status) {
      c.status = next;
      deps.publishClip(c);
    }
  }

  /** A new Mac post's fields (waiting since now). */
  function macFields(source: MacSource): { status: "mac"; mac: PostMac } {
    return { status: "mac", mac: { state: "waiting", since: iso(deps.now()), source } };
  }

  function job(p: Post): MacJob {
    const c = clip(p.clipId);
    const o = deps.options.get(p.postId) ?? presetChoices(deps.settings());
    const mac = p.mac!;
    return {
      clipId: c.clipId,
      postId: p.postId,
      hook: c.hook,
      caption: c.captions.tiktok.normalize("NFC"),
      fileName: videoFileName(c.hook),
      privacy: o.privacyLevel,
      comment: !o.disableComment,
      duet: !o.disableDuet,
      stitch: !o.disableStitch,
      source: mac.source,
      since: mac.since,
      state: mac.state,
      ...(mac.step ? { step: mac.step } : {}),
      ...(mac.claimedAt ? { claimedAt: mac.claimedAt } : {}),
      ...(mac.pressedAt ? { pressedAt: mac.pressedAt } : {}),
      attempt: attempts.get(p.postId) ?? 0,
      ...(mac.beatAt ? { beatAt: mac.beatAt } : {}),
      ...(pressedBefore.has(p.postId) ? { pressedBefore: pressedBefore.get(p.postId)! } : {}),
      ...(againAt.has(p.postId) ? { againAt: againAt.get(p.postId)! } : {}),
    };
  }

  /** The Mac fields done, Take it back and It's on TikTok drop (tiktok_self.MAC_FIELDS's internal ones). */
  function forget(postId: string) {
    claims.delete(postId);
    pressedBefore.delete(postId);
    againAt.delete(postId);
  }

  function queue(): MacJob[] {
    if (!macOn(deps.settings())) return [];
    const autoOn = deps.settings().autoPost?.on === true;
    const decided = (p: Post) => deps.clips().find((c) => c.clipId === p.clipId)?.decidedAt ?? "";
    return deps
      .posts()
      // While auto-posting is off nothing auto-posted goes on: not a waiting one, not one claimed but never pressed.
      .filter((p) => p.status === "mac" && p.mac && (p.mac.state === "working" || p.mac.state === "waiting") && (autoOn || p.mac.source !== "auto" || !!p.mac.pressedAt))
      .filter((p) => deps.clips().some((c) => c.clipId === p.clipId))
      .sort(
        (a, b) =>
          Number(a.mac!.source !== "upload") - Number(b.mac!.source !== "upload") ||
          a.mac!.since.localeCompare(b.mac!.since) ||
          decided(a).localeCompare(decided(b)) ||
          a.clipId.localeCompare(b.clipId),
      )
      .slice(0, MAC_QUEUE_MAX)
      .map(job);
  }

  /** The clip's Mac post, or the API's refusal. */
  function macOf(clipId: string): Post & { mac: PostMac } {
    const p = tiktokOf(clipId);
    if (!p || p.status !== "mac" || !p.mac) throw conflict(MAC_NOT_POSTING);
    return p as Post & { mac: PostMac };
  }

  function fromDevice(p: Post & { mac: PostMac }, device: string, states: PostMac["state"][]) {
    const claim = claims.get(p.postId);
    if (!states.includes(p.mac.state) || claim?.device !== device) throw conflict(ANOTHER_TRY);
    return claim;
  }

  function publicHelper(): MacHelper | null {
    if (!helper) return null;
    return {
      seenAt: helper.seenAt,
      state: helper.state,
      ...(helper.reason ? { reason: helper.reason } : {}),
      ...(helper.version ? { version: helper.version } : {}),
      ...(login ? { login } : {}),
      ...(loginRequest ? { loginRequest } : {}),
      ...(needsYouClipId && helper.state === "needs_you" ? { needsYouClipId } : {}),
      ...(needsYouCode && helper.state === "needs_you" ? { needsYouCode } : {}),
      ...extras,
      ...(resumeRequestAt ? { resumeRequest: { at: resumeRequestAt } } : {}),
      ...(letGoRequestAt ? { letGoRequest: { at: letGoRequestAt } } : {}),
    };
  }

  /** The Mac post's beat is now (each step, and the helper's beat while it works on it). */
  function beatOf(p: Post & { mac: PostMac }, t: number) {
    p.mac = { ...p.mac, beatAt: iso(t) };
  }

  const controls: TikTokMacControls = {
    ping(state = "ok", reason, device = "mock-mac", extra = {}) {
      helper = { seenAt: iso(deps.now()), state, ...(reason ? { reason: reason.trim().slice(0, 200) } : {}), version: "1.1.0", device };
      // Absent keys go; only a needs-you ping keeps the clip it stopped on; a done request goes only while it is the same.
      if (state !== "needs_you") {
        needsYouClipId = undefined;
        needsYouCode = undefined;
        needsYouDevice = undefined;
      }
      extras = {
        ...(extra.backlogAt ? { backlogAt: extra.backlogAt } : {}),
        ...(extra.holdBefore ? { holdBefore: extra.holdBefore } : {}),
        ...(extra.backfill ? { backfill: true as const } : {}),
      };
      if (extra.resumeDone && extra.resumeDone === resumeRequestAt) resumeRequestAt = undefined;
      if (extra.letGoDone && extra.letGoDone === letGoRequestAt) letGoRequestAt = undefined;
      return { on: macOn(deps.settings()) };
    },
    login(next, done) {
      login = next;
      if (done) loginRequest = undefined;
    },
    seen(at) {
      helper = at === null ? null : { seenAt: at, state: helper?.state ?? "ok", ...(helper?.reason ? { reason: helper.reason } : {}), device: helper?.device ?? "mock-mac" };
    },
    claim(clipId, device = "mock-mac", agoMs = 0) {
      if (!macOn(deps.settings())) throw conflict(MAC_OFF);
      const p = macOf(clipId);
      if (p.mac.source === "auto" && deps.settings().autoPost?.on !== true) throw conflict(AUTO_OFF);
      const now = deps.now();
      // Never a post whose Post was pressed (D2): a waiting one with pressedAt, or a crashed claim after Post.
      const beat = Date.parse(p.mac.beatAt ?? p.mac.claimedAt ?? "");
      const free = p.mac.state === "waiting" && !p.mac.pressedAt;
      const stale = p.mac.state === "working" && !p.mac.pressedAt && (!Number.isFinite(beat) || now - beat > MAC_STALE_CLAIM_MS);
      if (!free && !stale) throw conflict(ANOTHER_TRY);
      const at = now - agoMs;
      p.mac = { ...p.mac, state: "working", step: "video", claimedAt: iso(at), beatAt: iso(at) };
      delete p.mac.stoppedAt;
      delete p.mac.reason;
      claims.set(p.postId, { device });
      attempts.set(p.postId, (attempts.get(p.postId) ?? 0) + 1);
      deps.publishPost(p);
      return job(p);
    },
    step(clipId, step, device = "mock-mac", agoMs = 0) {
      if (!STEPS.includes(step)) throw bad("step must be video, opening, uploading, settings, pressing or finding.");
      const p = macOf(clipId);
      fromDevice(p, device, ["working"]);
      if (!macOn(deps.settings()) && !p.mac.pressedAt) throw conflict(MAC_OFF);
      if (p.mac.source === "auto" && !p.mac.pressedAt && deps.settings().autoPost?.on !== true) {
        // Auto-posting went off before Post: back to waiting until it is on again.
        p.mac = { state: "waiting", source: p.mac.source, since: p.mac.since };
        claims.delete(p.postId);
        deps.publishPost(p);
        throw conflict(AUTO_OFF);
      }
      const t = deps.now() - agoMs;
      // The same step again is the job's beat (its step stays).
      beatOf(p, t);
      p.mac = { ...p.mac, step, ...(step === "pressing" && !p.mac.pressedAt ? { pressedAt: iso(t) } : {}) };
      deps.publishPost(p);
      return job(p);
    },
    beat(clipId, agoMs = 0) {
      const p = macOf(clipId);
      if (p.mac.state !== "working") throw conflict(ANOTHER_TRY);
      beatOf(p, deps.now() - agoMs);
      deps.publishPost(p);
      return job(p);
    },
    done(clipId, link, device = "mock-mac") {
      const c = clip(clipId);
      const p = tiktokOf(clipId);
      // A repeat call is answered as the first (adding the link when it brings one).
      if (p && p.status === "posted" && p.via === "mac") {
        if (link) p.url = link;
        deps.publishPost(p);
        return answer(c);
      }
      const mac = macOf(clipId);
      fromDevice(mac, device, ["working", "stopped"]);
      // What the Mac set: Everyone (every Mac post's choice), else only him (§47.3).
      const everyone = (deps.options.get(mac.postId)?.privacyLevel ?? "PUBLIC_TO_EVERYONE") === "PUBLIC_TO_EVERYONE";
      forget(mac.postId);
      before.delete(mac.postId);
      beforeOptions.delete(mac.postId);
      madeForMac.delete(mac.postId);
      const now = deps.now();
      delete (mac as Post).mac;
      delete mac.error;
      Object.assign(mac, {
        status: "posted",
        by: "you",
        via: "mac",
        privacy: everyone ? "public" : "private",
        postedAt: iso(now),
        perfCheckAt: iso(now + 48 * 3_600_000),
        url: link ?? `https://www.tiktok.com/@lamo.clips/video/77106448116021${String(now).slice(-5)}`,
      });
      deps.publishPost(mac);
      settle(c, true);
      return answer(c);
    },
    stopped(clipId, reason, needsYou = false, device = "mock-mac", code) {
      if (code !== undefined && code !== "login") throw bad("code must be login.");
      const p = macOf(clipId);
      fromDevice(p, device, ["working", "stopped"]);
      const said = reason.trim().slice(0, 200);
      p.mac = { ...p.mac, state: "stopped", stoppedAt: iso(deps.now()), reason: p.mac.pressedAt ? MAC_PRESSED_REASON : said };
      if (needsYou) {
        helper = { seenAt: iso(deps.now()), state: "needs_you", reason: said, ...(helper?.version ? { version: helper.version } : {}), device };
        needsYouClipId = clipId;
        needsYouCode = code; // a stop without one removes it
        needsYouDevice = device;
      }
      deps.publishPost(p);
      return job(p);
    },
    loggedIn(clipId, device = "mock-mac") {
      if (!(helper?.state === "needs_you" && needsYouCode === "login" && needsYouClipId === clipId && needsYouDevice === device)) throw conflict(MAC_NOT_LOGIN_HOLD);
      const p = tiktokOf(clipId);
      let outcome: "resumed" | "pressed" | "cleared" = "cleared";
      if (p && p.status === "mac" && p.mac) {
        const claim = claims.get(p.postId);
        if (claim && claim.device !== device) throw conflict(MAC_NOT_LOGIN_HOLD);
        if (p.mac.pressedAt) outcome = "pressed";
        else if (p.mac.state === "stopped" && claim?.device === device) {
          // As Try again, but never an Upload tap's (its source stays) and never a new againAt.
          const { step: _s, claimedAt: _c, stoppedAt: _t, reason: _r, ...rest } = p.mac;
          p.mac = { ...rest, state: "waiting" };
          outcome = "resumed";
          deps.publishPost(p);
        }
      }
      clearNeedsYou();
      return { helper: structuredClone(publicHelper()), outcome };
    },
    queue,
    post(clipId) {
      return structuredClone(tiktokOf(clipId));
    },
    source(clipId, source, sinceAgoMs) {
      const p = macOf(clipId);
      p.mac = { ...p.mac, source, ...(sinceAgoMs !== undefined ? { since: iso(deps.now() - sinceAgoMs) } : {}) };
      deps.publishPost(p);
      return structuredClone(p);
    },
  };

  return {
    controls,
    /** GET /v1/tiktok/mac. */
    status(): TikTokMacStatus {
      return structuredClone({ on: macOn(deps.settings()), helper: publicHelper(), queue: queue() });
    },
    /** POST /v1/tiktok/mac/login (§47.8): the Mac does it the next time it checks in. */
    loginRequest(action: unknown): MacHelper | null {
      if (action !== "change" && action !== "forget") throw bad("Pick change or forget.");
      if (!helper) throw conflict(NO_HELPER);
      loginRequest = { action, at: iso(deps.now()) };
      return structuredClone(publicHelper());
    },
    /**
     * POST /v1/tiktok/mac/request (D5): Start my Mac again while it is paused, Let them go while it holds older
     * auto-posting clips. The Mac reads it at its next tick, does it and says so in its ping (resumeDone, letGoDone).
     */
    request(action: unknown): MacHelper | null {
      if (action !== "resume" && action !== "let_go") throw bad(MAC_REQUEST_PICK);
      if (!helper) throw conflict(MAC_NEVER_SEEN);
      const asked = action as MacRequestAction;
      if (asked === "resume" && helper.state !== "paused") throw conflict(MAC_NOT_PAUSED);
      if (asked === "let_go" && !extras.holdBefore) throw conflict(MAC_NOT_HOLDING);
      if (asked === "resume") resumeRequestAt = iso(deps.now());
      else letGoRequestAt = iso(deps.now());
      return structuredClone(publicHelper());
    },
    /**
     * POST /v1/tiktok/mac/send: each clip once, in order; one TikTok post per clip, always. Without `now` a clip is
     * the backlog (source "sent"); with `now` (a row's Post with my Mac) it is an Upload tap's ("upload"), and so is a
     * Mac post that already waits: it becomes "upload" in place and counts as sent.
     */
    send(clipIds: unknown, now: unknown = false): MacSendResult[] {
      if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > MAC_SEND_MAX || !clipIds.every((x) => typeof x === "string"))
        throw bad(`clipIds must list 1 to ${MAC_SEND_MAX} clips.`);
      const source: MacSource = nowKey(now) ? "upload" : "sent";
      const out: MacSendResult[] = [];
      for (const clipId of [...new Set(clipIds as string[])]) {
        const c = deps.clips().find((x) => x.clipId === clipId);
        const reason = !c ? "We could not find that clip." : refusal(c, source);
        if (!c || reason) {
          out.push({ clipId, sent: false, reason: reason ?? "We could not find that clip." });
          continue;
        }
        const p = tiktokOf(clipId);
        if (p?.status === "mac" && p.mac) {
          // Only a waiting Mac post with now gets here (refusal lets no other through): it goes next.
          goNow(p as Post & { mac: PostMac });
          out.push({ clipId, sent: true });
          continue;
        }
        const choices = presetChoices(deps.settings());
        if (!p) {
          const made: Post = { postId: ulid(), clipId, platform: "tiktok", ...macFields(source) };
          deps.posts().push(made);
          madeForMac.add(made.postId);
          deps.options.set(made.postId, choices);
          deps.publishPost(made);
        } else {
          // A Clip Factory TikTok post (failed, waiting for setup, or uploaded privately) is handed over in place.
          before.set(p.postId, structuredClone(p));
          beforeOptions.set(p.postId, deps.options.get(p.postId));
          for (const k of ["url", "postedAt", "perfCheckAt", "privacy", "error", "metrics", "nextRefreshAt"] as const) delete p[k];
          Object.assign(p, macFields(source));
          deps.options.set(p.postId, choices);
          deps.publishPost(p);
        }
        settle(c, false);
        out.push({ clipId, sent: true });
      }
      return out;
    },
    /**
     * POST /v1/clips/{clipId}/tiktok/mac/retry (§47.3, D2): refused while the Mac works on it and it is not stuck. A
     * waiting post becomes an Upload tap's with `now` (else it is answered as it is). A stopped or stuck one waits again,
     * keeping its place (since); after Post was pressed only with `notOnTikTok`, and only once the 30-minute find window
     * is over: its pressedAt moves to pressedBefore (so the Mac's never-twice guard sees it) and againAt says when.
     */
    retry(clipId: string, notOnTikTok: boolean, now: unknown = false): { clip: Clip; posts: Post[] } {
      const tapped = nowKey(now);
      const c = clip(clipId);
      const p = macOf(clipId);
      const t = deps.now();
      const stuck = macStuck(p.mac, t, macHelperBeats(helper));
      if (p.mac.state === "working" && !stuck) throw conflict(MAC_WORKING);
      if (p.mac.state === "waiting" && tapped) goNow(p);
      if (p.mac.state === "stopped" || stuck) {
        if (p.mac.pressedAt && !notOnTikTok) throw conflict(MAC_MAY_HAVE_POSTED);
        if (!macWindowOver(p.mac, t)) throw conflict(MAC_STILL_LOOKING);
        const { step: _s, claimedAt: _c, stoppedAt: _t, reason: _r, pressedAt, beatAt, ...rest } = p.mac;
        p.mac = { ...rest, state: "waiting", ...(tapped ? { source: "upload" as const } : {}), ...(!stuck && beatAt ? { beatAt } : {}) };
        if (pressedAt) pressedBefore.set(p.postId, pressedAt);
        againAt.set(p.postId, iso(t));
        if (stuck) claims.delete(p.postId);
        clearNeedsYou();
        deps.publishPost(p);
      }
      return answer(c);
    },
    /** DELETE /v1/clips/{clipId}/tiktok/mac: Take it back, while it waits or stopped. */
    takeBack(clipId: string): { clip: Clip; posts: Post[] } {
      const c = clip(clipId);
      const p = macOf(clipId);
      if (p.mac.state === "working") throw conflict(MAC_WORKING);
      // The Mac pressed Post: it may be on TikTok, so it is never taken back (It's on TikTok, or not there, Try again).
      if (p.mac.pressedAt) throw conflict(MAC_MAY_HAVE_POSTED);
      forget(p.postId);
      const was = before.get(p.postId);
      if (was) {
        const opts = beforeOptions.get(p.postId);
        before.delete(p.postId);
        beforeOptions.delete(p.postId);
        for (const k of Object.keys(p) as (keyof Post)[]) delete p[k];
        Object.assign(p, was);
        if (opts) deps.options.set(p.postId, opts);
        else deps.options.delete(p.postId);
        deps.publishPost(p);
      } else {
        // Made for the Mac (by Upload, an auto-posting run or Send these): it goes.
        madeForMac.delete(p.postId);
        deps.options.delete(p.postId);
        const list = deps.posts();
        list.splice(list.indexOf(p), 1);
        deps.removePost(p);
      }
      settle(c, false);
      return answer(c);
    },
    /**
     * It's on TikTok (§42, the row's button) on a Mac post (tiktok_self.mark_posted): refused while the Mac works on
     * it and it is not stuck; with `noLink` also on a job the Mac never pressed Post for (D3): MAC_WORKING with a fresh
     * beat (even past the 50-minute cap), else MAC_NOT_PRESSED (it can't be on TikTok: Try again). Afterwards the Mac no longer has it. Marking a stopped or stuck one answers the Mac's stop, so
     * a helper that needed him goes back to ok (as Try again does).
     */
    beforeMarked(p: Post | undefined, noLink = false) {
      if (p?.status !== "mac" || p.mac?.state !== "working") return;
      const t = deps.now();
      if (!macStuck(p.mac, t, macHelperBeats(helper))) throw conflict(MAC_WORKING);
      const beat = Date.parse(p.mac.beatAt ?? p.mac.claimedAt ?? "");
      // Never pressed Post: it isn't on TikTok (still beating: the Mac may still post it).
      if (noLink && !p.mac.pressedAt) throw conflict(Number.isFinite(beat) && t - beat < MAC_BEAT_STALE_MS ? MAC_WORKING : MAC_NOT_PRESSED);
    },
    marked(p: Post) {
      if (p.mac?.state === "stopped" || p.mac?.state === "working") clearNeedsYou();
      forget(p.postId);
      delete p.mac;
    },
    /** A new post Upload or an auto-posting run makes for the Mac (§47.2). */
    macFields,
  };

  /** The helper item goes back to ok (without its reason) when it needed him: he answered its stopped post. */
  function clearNeedsYou() {
    if (helper?.state === "needs_you") helper = { seenAt: helper.seenAt, state: "ok", device: helper.device, ...(helper.version ? { version: helper.version } : {}) };
    needsYouClipId = undefined;
    needsYouCode = undefined;
    needsYouDevice = undefined;
  }

  /**
   * A waiting Mac post becomes an Upload tap's (the API's _go_now): the owner tapped its row's button (`now`), so the
   * Mac posts it at once and first. It keeps its place (since); nothing changes when it already is one.
   */
  function goNow(p: Post & { mac: PostMac }) {
    if (p.mac.source === "upload") return;
    p.mac = { ...p.mac, source: "upload" };
    deps.publishPost(p);
  }

  /** Why a clip can't go to the Mac (§47.2), or null when it can (with `now`, also a waiting Mac post). */
  function refusal(c: Clip, source: MacSource): string | null {
    const posts = postsOf(c.clipId);
    if (c.status === "review" || c.status === "declined") return "Upload this clip first.";
    if (!posts.length) return "This clip is still starting to upload. Try again in a minute.";
    // A campaign clip skips TikTok (D1, tiktok_mac.SEND_CAMPAIGN): the Mac can't mark it as Branded content yet.
    if (c.campaignId) return MAC_ROW_CAMPAIGN;
    if (c.auto?.test === "private") return "This was a Private test, so it stays off TikTok.";
    const state = tiktokState(posts);
    if (state === "mac") return source === "upload" && tiktokOf(c.clipId)?.mac?.state === "waiting" ? null : "Your Mac already has this clip.";
    if (state === "uploading") return "This clip is still uploading to TikTok. Wait until it is done, then try again.";
    if (state === "public") return "This clip is already on TikTok for everyone.";
    if (state === "yours") return "You already posted this one on TikTok.";
    return canSendToMac(c, posts) ? null : "This clip can't go to your Mac.";
  }
}
