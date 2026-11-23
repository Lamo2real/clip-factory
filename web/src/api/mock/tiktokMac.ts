// Mock mode's "Your Mac posts it on TikTok" (docs/CONTRACTS.md §47): the same rules as the API's tiktok_mac.py and
// routes/tiktok_mac.py. The owner's routes (status, send, retry, Take it back) answer the app (send and retry with
// `now` make the post an Upload tap's, source "upload", which the Mac posts at once, also one that already waits);
// the Mac helper's own routes (ping, claim, step, done, stopped) are test knobs (window.__cfMock.mac), so e2e can move
// a Mac post along waiting → working → posted by your Mac, or stopped. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { Clip, MacHelper, MacJob, MacSendResult, MacSource, MacStep, Post, PostMac, Settings, TikTokMacStatus, TikTokPostOptions } from "../types.ts";
import { presetOf } from "../../lib/preset.ts";
import { canSendToMac, MAC_MAY_HAVE_POSTED, MAC_NOT_POSTING, MAC_PRESSED_REASON, MAC_SEND_MAX, MAC_WORKING, macOn } from "../../lib/tiktokMac.ts";
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

/** The Mac helper's knobs (window.__cfMock.mac). */
export interface TikTokMacControls {
  ping(state?: MacHelper["state"], reason?: string, device?: string): { on: boolean };
  /** §47.8: the Mac says whether it keeps a TikTok login; `done`: it did the owner's pending Change or Forget. */
  login(login: "saved" | "none", done?: boolean): void;
  /** The helper was last seen at `at` (ISO), or never (null). */
  seen(at: string | null): void;
  claim(clipId: string, device?: string): MacJob;
  step(clipId: string, step: MacStep, device?: string): MacJob;
  done(clipId: string, link?: string, device?: string): { clip: Clip; posts: Post[] };
  stopped(clipId: string, reason: string, needsYou?: boolean, device?: string): MacJob;
  queue(): MacJob[];
  /** The clip's TikTok post, as the server holds it. */
  post(clipId: string): Post | null;
}

/** My settings' TikTok choices (Everyone, Comment, Duet and Stitch on), in the TikTok sheet's shape. */
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
  // Internal per-post fields: who claimed it and its heartbeat, and what a converted post was before.
  const claims = new Map<string, { device: string; beatAt: number }>();
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
    };
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
    };
  }

  const controls: TikTokMacControls = {
    ping(state = "ok", reason, device = "mock-mac") {
      helper = { seenAt: iso(deps.now()), state, ...(reason ? { reason: reason.trim().slice(0, 200) } : {}), version: "1.0.0", device };
      return { on: macOn(deps.settings()) };
    },
    login(next, done) {
      login = next;
      if (done) loginRequest = undefined;
    },
    seen(at) {
      helper = at === null ? null : { seenAt: at, state: helper?.state ?? "ok", ...(helper?.reason ? { reason: helper.reason } : {}), device: helper?.device ?? "mock-mac" };
    },
    claim(clipId, device = "mock-mac") {
      if (!macOn(deps.settings())) throw conflict(MAC_OFF);
      const p = macOf(clipId);
      if (p.mac.source === "auto" && deps.settings().autoPost?.on !== true) throw conflict(AUTO_OFF);
      const now = deps.now();
      const claim = claims.get(p.postId);
      const stale = p.mac.state === "working" && !p.mac.pressedAt && (!claim || now - claim.beatAt > MAC_STALE_CLAIM_MS);
      if (p.mac.state !== "waiting" && !stale) throw conflict(ANOTHER_TRY);
      p.mac = { ...p.mac, state: "working", step: "video", claimedAt: iso(now) };
      delete p.mac.stoppedAt;
      delete p.mac.reason;
      claims.set(p.postId, { device, beatAt: now });
      attempts.set(p.postId, (attempts.get(p.postId) ?? 0) + 1);
      deps.publishPost(p);
      return job(p);
    },
    step(clipId, step, device = "mock-mac") {
      if (!STEPS.includes(step)) throw bad("step must be video, opening, uploading, settings, pressing or finding.");
      const p = macOf(clipId);
      const claim = fromDevice(p, device, ["working"]);
      if (!macOn(deps.settings()) && !p.mac.pressedAt) throw conflict(MAC_OFF);
      if (p.mac.source === "auto" && !p.mac.pressedAt && deps.settings().autoPost?.on !== true) {
        // Auto-posting went off before Post: back to waiting until it is on again.
        p.mac = { state: "waiting", source: p.mac.source, since: p.mac.since };
        claims.delete(p.postId);
        deps.publishPost(p);
        throw conflict(AUTO_OFF);
      }
      const now = deps.now();
      claim.beatAt = now;
      p.mac = { ...p.mac, step, ...(step === "pressing" && !p.mac.pressedAt ? { pressedAt: iso(now) } : {}) };
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
      claims.delete(mac.postId);
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
    stopped(clipId, reason, needsYou = false, device = "mock-mac") {
      const p = macOf(clipId);
      fromDevice(p, device, ["working", "stopped"]);
      const said = reason.trim().slice(0, 200);
      p.mac = { ...p.mac, state: "stopped", stoppedAt: iso(deps.now()), reason: p.mac.pressedAt ? MAC_PRESSED_REASON : said };
      if (needsYou) helper = { seenAt: iso(deps.now()), state: "needs_you", reason: said, device };
      deps.publishPost(p);
      return job(p);
    },
    queue,
    post(clipId) {
      return structuredClone(tiktokOf(clipId));
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
     * POST /v1/clips/{clipId}/tiktok/mac/retry: a stopped Mac post waits again, keeping its place (since). With `now`
     * it becomes an Upload tap's (source "upload"), also an auto-posting run's while auto-posting is off: he tapped it.
     * A waiting post becomes one with `now` too; without it, it is answered as it is.
     */
    retry(clipId: string, notOnTikTok: boolean, now: unknown = false): { clip: Clip; posts: Post[] } {
      const tapped = nowKey(now);
      const c = clip(clipId);
      const p = macOf(clipId);
      if (p.mac.state === "working") throw conflict(MAC_WORKING);
      if (p.mac.state === "waiting" && tapped) goNow(p);
      if (p.mac.state === "stopped") {
        if (p.mac.pressedAt && !notOnTikTok) throw conflict(MAC_MAY_HAVE_POSTED);
        const { step: _s, claimedAt: _c, stoppedAt: _t, reason: _r, pressedAt, ...rest } = p.mac;
        p.mac = { ...rest, state: "waiting", ...(tapped ? { source: "upload" as const } : {}), ...(pressedAt && !notOnTikTok ? { pressedAt } : {}) };
        if (helper?.state === "needs_you") helper = { seenAt: helper.seenAt, state: "ok", device: helper.device, ...(helper.version ? { version: helper.version } : {}) };
        deps.publishPost(p);
      }
      return answer(c);
    },
    /** DELETE /v1/clips/{clipId}/tiktok/mac: Take it back, while it waits or stopped. */
    takeBack(clipId: string): { clip: Clip; posts: Post[] } {
      const c = clip(clipId);
      const p = macOf(clipId);
      if (p.mac.state === "working") throw conflict(MAC_WORKING);
      // The Mac pressed Post: it may be on TikTok, so it is never taken back (I posted it, or not on TikTok, try again).
      if (p.mac.pressedAt) throw conflict(MAC_MAY_HAVE_POSTED);
      claims.delete(p.postId);
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
    /** I posted it (§42) on a Mac post: refused while the Mac works on it; afterwards the Mac no longer has it. */
    beforeMarked(p: Post | undefined) {
      if (p?.status === "mac" && p.mac?.state === "working") throw conflict(MAC_WORKING);
    },
    marked(p: Post) {
      claims.delete(p.postId);
      delete p.mac;
    },
    /** A new post Upload or an auto-posting run makes for the Mac (§47.2). */
    macFields,
  };

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
    if (c.campaignId) return "Campaign clips go on TikTok by hand. Post it in the TikTok app, then add the link.";
    if (c.auto?.test === "private") return "This was a Private test, so it stays off TikTok.";
    const state = tiktokState(posts);
    if (state === "mac") return source === "upload" && tiktokOf(c.clipId)?.mac?.state === "waiting" ? null : "Your Mac already has this clip.";
    if (state === "uploading") return "This clip is still uploading to TikTok. Wait until it is done, then try again.";
    if (state === "public") return "This clip is already on TikTok for everyone.";
    if (state === "yours") return "You already posted this one on TikTok.";
    return canSendToMac(c, posts) ? null : "This clip can't go to your Mac.";
  }
}
