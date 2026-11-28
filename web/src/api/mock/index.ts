// The whole HTTP API in memory, with fake latency, so the UI runs with no backend (npm run dev:mock, Playwright).
import { ApiError, networkError } from "../errors.ts";
import type { Api, Campaign, Captions, Clip, ClipPostOptions, Job, JobAttachment, JobDeleteClips, JobDeleted, NewJob, Platform, Post, Settings, SimilarClip, TikTokPostOptions } from "../types.ts";
import { canAttach, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, REFUSE } from "../../lib/attachments.ts";
import { clipOptionsProblem, presetOf, presetProblem } from "../../lib/preset.ts";
import { TIKTOK_PICK_AGAIN } from "../../lib/upload.ts";
import { videoFileName } from "../../lib/tiktokYourself.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { MOMENTS, PLATFORMS, STEP_KEYS, coverArt, seed, stepsAt, thumbArt, ulid, type Store } from "./fixtures.ts";
import { installMockLiveControls, mockLive } from "./live.ts";
import { lineFor, sampleLine, SCRIPT } from "./jobLive.ts";
import { setupApi } from "./setup.ts";
import { statsApi, type StatsFaults } from "./stats.ts";
import { savedSkillCopy, skillsApi, type MockSkillControls } from "./skills.ts";
import { lessonsApi, type LessonsFault } from "./lessons.ts";
import { followsApi } from "./follows.ts";
import { followersApi } from "./followers.ts";
import { dashData, mockMoneyGrant, moneyApi } from "./money.ts";
import { pushApi } from "./push.ts";
import { crMockApi } from "./contentrewards.ts";
import { crOverlayApi } from "./crOverlay.ts";
import { refVideosApi } from "./refVideos.ts";
import { catalogOf, finderMockApi, type FinderMock } from "./finder.ts";
import { clipFit, fitOne, remakeRefusal, sourceKept, uploadRefusal, type FitInputs } from "./fit.ts";
import { everywhere, MONETARY_SCOPE } from "./moneyEverywhere.ts";
import { getPaidMockApi } from "./getpaid.ts";
import { bankMockApi } from "./bank.ts";
import { adFirst, hasItem, liveFit } from "../../lib/crFit.ts";
import { isSoundId } from "../../lib/soundCatalog.ts";
import { isBackgroundMode, isGlassStrength, isHexColour, MAX_COLOURS } from "../../lib/background.ts";
import { currentClipModel, isClipModel } from "../../lib/models.ts";
import { TAKE_STYLE_MAX, tidyTakeStyle } from "../../lib/take.ts";
import { autoPostMock, NOTE_NO_PLACES, CR_BY_HAND, CR_CANT_TAKE, type AutoPostControls } from "./autopost.ts";
import { AUTO_ALREADY_SENT } from "../../lib/autopost.ts";
import { macOptions, tiktokMacMock, type TikTokMacControls } from "./tiktokMac.ts";
import { MAC_FIND_NONE, MAC_UNDO_REFUSED, MAC_UNKNOWN_SETTING, macOn } from "../../lib/tiktokMac.ts";
import { CAMPAIGN_MAC_OFF, CAMPAIGN_MAC_POSTS } from "../../lib/contentRewards.ts";
import { canPostYourself, tiktokAudited } from "../../lib/tiktokYourself.ts";

const STEP_MS = 3500;
/** api settings.MAX_USD_PER_1000: the retired `earningsRates` (§21) are still validated, never read (§25.6). */
const RETIRED_MAX_RATE = 100;
const clone = <T>(v: T): T => structuredClone(v);

/** Browser automation (Playwright) freezes job progress so screens and screenshots stay stable. */
const frozen = () => typeof navigator !== "undefined" && navigator.webdriver === true;

function delay(min = 160, max = 420): Promise<void> {
  const slow =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { __cfMockFaults?: MockFaults }).__cfMockFaults
          ?.latencyMs;
  const ms =
    slow !== undefined
      ? slow
      : frozen()
        ? 30
        : min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

const notFound = (what: string) => new ApiError(404, "not_found", `That ${what} no longer exists.`);
const conflict = (msg: string) => new ApiError(409, "conflict", msg);
const bad = (msg: string) => new ApiError(400, "bad_request", msg);

/** Like the API (§52 F3), with its sentences: at most 6, each one of the owner's uploads, an allowed kind, up to 20 MB, no key twice. */
function checkAttachments(list: NewJob["attachments"]): JobAttachment[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw bad("attachments must be a list.");
  if (list.length > MAX_ATTACHMENTS) throw bad(REFUSE.full);
  const seen = new Set<string>();
  return list.map((a) => {
    const keys = Object.keys(a ?? {});
    if (!a || !keys.every((k) => ["key", "name", "type", "size"].includes(k)) || typeof a.name !== "string" || !a.name || a.name.length > 255 || typeof a.size !== "number")
      throw bad("A file for the notes could not be added. Remove it and add it again.");
    if (typeof a.key !== "string" || !a.key.startsWith("uploads/mock-owner/") || a.key.includes("..")) throw bad("That file does not belong to you.");
    if (seen.has(a.key)) throw bad("That file was added twice.");
    // The API also takes "text/rtf" (the web sends it as application/rtf).
    if (!canAttach(a.type) && a.type !== "text/rtf") throw bad(REFUSE.kind);
    if (a.size > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "too_large", REFUSE.big);
    if (a.size < 1) throw bad("A file for the notes could not be added. Remove it and add it again.");
    seen.add(a.key);
    return { key: a.key, name: a.name, type: a.type, size: a.size };
  });
}
const ALREADY_DECIDED = "This clip has already been confirmed or declined.";

/**
 * Knobs for tests (Playwright reaches them as window.__cfMockFaults). `keepStopsAfterSave` makes the next N Keeps
 * save the clip and then fail like a dropped connection, before posting starts. `resumeAfterMs` is how old a
 * stuck Keep must be before Keep again finishes it (the API waits 60 seconds).
 */
export interface MockFaults extends StatsFaults {
  keepStopsAfterSave: number;
  resumeAfterMs: number;
  /** "Like clips that did well" finds nothing (the strip must hide). */
  similarEmpty?: boolean;
  /** Jobs list pages hold at most this many jobs, whatever limit is asked for (so "Show older jobs" shows). */
  jobsPageSize?: number;
  /** The next N "Show older jobs" pages (listJobs with a cursor) fail like a server error. */
  olderJobsFails?: number;
  /** Posting does not start after a Try again, Post now or connect: the clip stays `startPending` (§14.5). */
  startFails?: boolean;
  /** The next N job deletes (deleteJob, deleteJobs) fail like a server error (§34). */
  deleteJobFails?: number;
  /** The next N Make clips (createJob) fail like a server error. */
  createJobFails?: number;
  /**
   * The next Uploads (confirmClip) fail in this order before the server takes anything: "network" like a connection
   * lost on the way, "refused" like a 400 the server sends back.
   */
  confirmFails?: ("network" | "refused")[];
  /** The next N setup checks (getSetup) fail like a server error (Review must not guess where a clip goes). */
  setupFails?: number;
  /** Every answer takes this long (ms), like a slow connection to the cloud (a page change must not blink meanwhile). */
  latencyMs?: number;
  /** Settings › What it learned shows the never-checked ("empty") or not-enough-clips ("needs-more") state. */
  lessons?: LessonsFault;
}

const serverDown = () => new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");

/** How often each API method was called (window.__cfMockCalls), so tests can tell a poll from a live update. */
export type MockCalls = Record<string, number>;

/** The setup to-do list's confirmed skips live on the "server", so in mock mode they survive a reload (§17.13). */
const SKIPPED_KEY = "cf-mock-setup-skipped";
function loadSkipped(): Settings["setupSkipped"] | null {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(SKIPPED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? PLATFORMS.filter((p) => list.includes(p)) : null;
  } catch {
    return null;
  }
}
function saveSkipped(list: Settings["setupSkipped"]) {
  try {
    sessionStorage.setItem(SKIPPED_KEY, JSON.stringify(list ?? []));
  } catch {
    /* private mode: kept for this page only */
  }
}

const EMPTY_KEY = "cf-mock-empty";
function emptyAccount(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(EMPTY_KEY) === "1";
  } catch {
    return false;
  }
}

// The look settings (§22) survive a reload of the mock, like the real server, so persistence can be tested.
const LOOK_KEY = "cf-mock-look";
const LOOK_FIELDS = ["backgroundMode", "backgroundColours", "glassStrength"] as const;
function saveMockLook(s: Settings) {
  try {
    sessionStorage.setItem(LOOK_KEY, JSON.stringify(Object.fromEntries(LOOK_FIELDS.map((k) => [k, s[k]]))));
  } catch {
    /* no storage: the look resets on reload */
  }
}
function loadMockLook(): Partial<Settings> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LOOK_KEY) ?? "{}") as Partial<Settings>;
    const out: Partial<Settings> = {};
    if (isBackgroundMode(raw.backgroundMode)) out.backgroundMode = raw.backgroundMode;
    if (isGlassStrength(raw.glassStrength)) out.glassStrength = raw.glassStrength;
    if (Array.isArray(raw.backgroundColours) && raw.backgroundColours.every(isHexColour)) out.backgroundColours = raw.backgroundColours;
    return out;
  } catch {
    return {};
  }
}

/** A job waiting for the owner's Mac (§35): blocked by YouTube, or made in the desktop app. */
function macWaiting(j: Job): boolean {
  const state = j.macFetch?.state;
  return (j.status === "queued" || j.status === "running") && (state === "waiting" || state === "getting" || state === "sending");
}

export function mockApi(store: Store = seed(), faults: MockFaults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000 }): Api {
  const calls: MockCalls = {};
  const skipped = loadSkipped();
  if (skipped) store.settings.setupSkipped = skipped;
  if (typeof window !== "undefined") {
    (window as unknown as { __cfMockFaults?: MockFaults }).__cfMockFaults = faults;
    (window as unknown as { __cfMockCalls?: MockCalls }).__cfMockCalls = calls;
    store.settings = { ...store.settings, ...loadMockLook() };
  }

  // Live events carry the same public shapes as the HTTP API, minus the presigned media links (§14.2).
  const publishJob = (j: Job) => mockLive.publish({ type: "job", op: "upsert", id: j.jobId, item: clone(j) });
  const publishClip = (c: Clip) => {
    const { videoUrl: _v, coverUrl: _c, ...rest } = clone(c);
    mockLive.publish({ type: "clip", op: "upsert", id: c.clipId, item: rest });
  };
  /** A fetched job carries its live line while it runs, like GET /v1/jobs and /v1/jobs/{id} (§31). */
  const withLive = (j: Job): Job => {
    const live = sampleLine(j);
    return live ? { ...clone(j), live } : clone(j);
  };
  const publishLine = (j: Job, frame: (typeof SCRIPT)[number]) => {
    const item = lineFor(j, frame);
    mockLive.publish({ type: "jobLive", op: "upsert", id: j.jobId, item });
  };
  let scriptAt = 0;
  const publishPost = (p: Post) => mockLive.publish({ type: "post", op: "upsert", id: p.postId, item: clone(p) });
  // Another device saves Clip Factory's Look (§22): the server's settings change, and this device hears it on the
  // session's next refresh, which a job's live event brings (a test knob: e2e/stories-see-through-own.spec.ts).
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    const otherDevice = {
      saveLook(patch: Partial<Pick<Settings, "backgroundMode" | "backgroundColours" | "glassStrength">>) {
        store.settings = { ...store.settings, ...patch };
        saveMockLook(store.settings);
        const job = store.jobs[0];
        if (job) publishJob(job);
      },
    };
    w.__cfMock = { ...(w.__cfMock ?? {}), otherDevice };
  }
  // When each kept clip's posting was last started (stands in for the API's publishState: "pending" timing).
  const claimedAt = new Map<string, number>();
  // The TikTok sheet's choices stored on each TikTok post (the API's postOptions.tiktok, never returned).
  const postOptions = new Map<string, TikTokPostOptions>();
  // The last Upload's body as the API would read it (tests: `tiktok`, `platforms` and `tiktokMac`).
  let lastConfirm: { clipId: string; tiktok?: TikTokPostOptions; platforms?: Platform[]; tiktokMac?: true } | null = null;
  // Find it for me (D3): the clips Clip Factory looked for once already (the next look finds it).
  const lookedFor = new Set<string>();
  // Posted on TikTok by the owner (§42): what the TikTok post was before (null: made by It's on TikTok), for Undo.
  const byYou = new Map<string, Post | null>();
  // Each place's own choices sent with Upload (§36.3), by post (the API's postOptions, never returned).
  const clipOptions = new Map<string, object>();

  /**
   * Try again on a failed clip (§14.5): failed posts go back to queued and the clip to confirmed. New TikTok sheet
   * choices replace the failed TikTok post's postOptions, like the API's _try_again. Named places still waiting go
   * too once they are set up (Post now, §33.6); one not set up is the API's plain 400.
   */
  function tryAgain(c: Clip, tiktok?: TikTokPostOptions, platforms?: Platform[]) {
    const named = store.posts.filter((p) => p.clipId === c.clipId && (!platforms || platforms.includes(p.platform)));
    const failed = named.filter((p) => p.status === "failed");
    const waiting = platforms ? named.filter((p) => p.status === "pending_integration") : [];
    const connected = setup.connected();
    const missing = PLATFORM_ORDER.find((p) => waiting.some((w) => w.platform === p) && !connected.includes(p));
    if (missing) throw bad(`${PLATFORM_LABEL[missing]} is not set up yet. Turn it off, then tap Upload.`);
    if (!tiktok && waiting.some((p) => p.platform === "tiktok" && !postOptions.get(p.postId)?.privacyLevel)) throw bad("Pick who can see it on TikTok.");
    // A campaign clip's TikTok goes only through his Mac until TikTok approved the app (§47.2 item 6, Try again's words).
    if (c.campaignId && [...failed, ...waiting].some((p) => p.platform === "tiktok") && !tiktokAudited(setup.overview().platforms))
      throw bad(macOn(store.settings) ? CAMPAIGN_MAC_POSTS : `${CAMPAIGN_MAC_OFF} Tap Try again on another place.`);
    // Naming nothing to send changes nothing (§33), except a start that did not go through earlier: it starts now.
    if (!failed.length && !waiting.length) {
      if (c.startPending) started(c);
      return { clip: clone(c), posts: clone(store.posts.filter((p) => p.clipId === c.clipId)) };
    }
    for (const p of [...failed, ...waiting]) {
      p.status = "queued";
      delete p.error;
      if (tiktok && p.platform === "tiktok") postOptions.set(p.postId, clone(tiktok));
      publishPost(p);
    }
    // A failed clip goes back to confirmed; an uploaded one (one place did not work) stays posted (§33).
    if (c.status === "failed") c.status = "confirmed";
    started(c);
    return { clip: clone(c), posts: clone(store.posts.filter((p) => p.clipId === c.clipId)) };
  }

  /** The clip's posting starts, like the API's flow start; with faults.startFails it does not (startPending, §14.5). */
  function started(c: Clip) {
    if (faults.startFails) c.startPending = true;
    else delete c.startPending;
    publishClip(c);
  }

  /**
   * A place was just connected: every uploaded clip's post waiting for it goes out, like the API's release (§17.6).
   * Clips still in review or still publishing are left alone; TikTok waits for the owner's choice (Post now).
   */
  function releaseWaiting(platform: Platform) {
    for (const c of store.clips) {
      if (c.status !== "posted" && c.status !== "confirmed" && c.status !== "failed") continue;
      const waiting = store.posts.filter(
        (p) => p.clipId === c.clipId && p.platform === platform && p.status === "pending_integration" && (platform !== "tiktok" || !!postOptions.get(p.postId)?.privacyLevel),
      );
      if (!waiting.length) continue;
      for (const p of waiting) {
        p.status = "queued";
        delete p.error;
        publishPost(p);
      }
      if (c.status === "failed") c.status = "confirmed";
      started(c);
    }
  }

  /** Test knob (window.__cfMock.posting): a kept clip whose TikTok post failed because its privacy choice is gone. */
  const posting = {
    failTikTok(): { clipId: string; postId: string; hook: string } {
      const c = store.clips.find((x) => x.status === "confirmed" || x.status === "posted" || x.status === "publishing");
      if (!c) throw new Error("no kept clip");
      let p = store.posts.find((x) => x.clipId === c.clipId && x.platform === "tiktok");
      if (!p) {
        p = { postId: ulid(), clipId: c.clipId, platform: "tiktok", status: "failed" };
        store.posts.push(p);
      }
      for (const x of store.posts) if (x.clipId === c.clipId && x.status !== "posted") x.status = "failed";
      Object.assign(p, { status: "failed", error: TIKTOK_PICK_AGAIN });
      delete p.url;
      delete p.postedAt;
      delete p.metrics;
      c.status = "failed";
      for (const x of store.posts) if (x.clipId === c.clipId) publishPost(x);
      publishClip(c);
      return { clipId: c.clipId, postId: p.postId, hook: c.hook };
    },
    /**
     * §33: the clip's posts go up, except `platform`, which did not work (with a plain reason). The clip is posted, so
     * that place gets its own Try again.
     */
    settleWithOneFailed(clipId: string, platform: Platform, reason = "X said no this time. Press Try again."): void {
      const c = clip(clipId);
      for (const x of store.posts.filter((p) => p.clipId === clipId)) {
        if (x.platform === platform) Object.assign(x, { status: "failed", error: reason });
        else if (x.status === "queued") Object.assign(x, { status: "posted", postedAt: new Date().toISOString(), url: `https://example.com/${x.platform}/${x.postId}` });
        publishPost(x);
      }
      c.status = "posted";
      publishClip(c);
    },
    /**
     * §46.2 item 6: one place did not work while the clip still posts its other places (publishing, §17.6), so no
     * Try again yet: the retry would do nothing until they are done.
     */
    failWhilePosting(clipId: string, platform: Platform, reason = "X said no this time. Press Try again."): void {
      const c = clip(clipId);
      const p = store.posts.find((x) => x.clipId === clipId && x.platform === platform);
      if (!p) throw new Error(`no ${platform} post`);
      Object.assign(p, { status: "failed", error: reason });
      publishPost(p);
      c.status = "publishing";
      publishClip(c);
    },
    /**
     * A kept clip that isn't on TikTok yet becomes a campaign clip (§38), for the TikTok row (§47.4): it skips TikTok
     * for now (D1), so the Mac never takes it. Answers its id.
     */
    campaignClip(campaignId = "200ea21b-be80-4db8-b552-8e32b148604e"): string {
      const c = store.clips.find(
        (x) => !x.campaignId && !x.startPending && x.auto?.test !== "private" && canPostYourself(x, store.posts.filter((p) => p.clipId === x.clipId)),
      );
      if (!c) throw new Error("no kept clip that isn't on TikTok yet");
      c.campaignId = campaignId;
      // A campaign clip has no Your take.
      delete c.take;
      delete c.takeSpoken;
      publishClip(c);
      return c.clipId;
    },
    /** The clip as the server holds it (its saved captions, its status). */
    clip(clipId: string): Clip {
      return clone(clip(clipId));
    },
    /** The clip's posts, as the server holds them. */
    posts(clipId: string): Post[] {
      return clone(store.posts.filter((p) => p.clipId === clipId));
    },
    options(postId: string): TikTokPostOptions | null {
      return clone(postOptions.get(postId) ?? null);
    },
    /** The last Upload's body (POST /v1/clips/{id}/confirm): its `tiktok`, `platforms` and `tiktokMac`. */
    lastConfirm() {
      return clone(lastConfirm);
    },
    /** §36.3: the YouTube, Instagram or X choices stored on a post. */
    clipOptions(postId: string): object | null {
      return clone(clipOptions.get(postId) ?? null);
    },
  };
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    w.__cfMock = { ...(w.__cfMock ?? {}), posting };
  }

  // When each running job's current step began, to move it along over time.
  const clock = new Map<string, { at: number; done: number }>();
  for (const j of store.jobs) {
    if (j.status === "running") clock.set(j.jobId, { at: Date.now(), done: j.steps.findIndex((s) => s.status === "running") });
  }

  function finish(job: Job) {
    const count = job.clipTarget.min + Math.floor(Math.random() * (job.clipTarget.max - job.clipTarget.min + 1));
    // A campaign job's clips, as the agent writes them (§38.13): #Ad first and every required tag, the marks on the video.
    const campaign = job.campaignId ? cr.served().find((x) => x.campaignId === job.campaignId) : undefined;
    const campaignTags = campaign ? [...(campaign.rules?.requiredHashtags ?? []), ...(campaign.rules?.requiredTags ?? [])].join(" ") : "";
    const ad = campaign ? `${campaign.rules?.disclosure.caption ?? "#Ad"} ` : "";
    const tags = [job.notes?.match(/#\w+/g)?.join(" ") ?? (campaign ? "" : "#clips"), campaignTags].filter(Boolean).join(" ");
    for (let i = 0; i < count; i++) {
      const m = MOMENTS[(i + job.jobId.charCodeAt(25)) % MOMENTS.length]!;
      const layout = i % 3 === 0 ? "blur_fill" : "facecam_top";
      store.clips.push({
        clipId: ulid(),
        jobId: job.jobId,
        rank: i + 1,
        status: "review",
        momentType: m.type,
        hook: m.hook,
        // Your take: never on a campaign clip, and only while it is on; spoken only with Say it out loud.
        ...(m.take && !campaign && !job.campaignId && store.settings.takeOn !== false
          ? { take: m.take, ...(store.settings.takeVoice !== false ? { takeSpoken: true } : {}) }
          : {}),
        summary: m.summary,
        durationSec: 20 + i * 3,
        sourceStart: 300 + i * 600,
        sourceEnd: 320 + i * 603,
        sourceUrlAt: job.source.url,
        layout,
        coverUrl: coverArt(i + 2, m.hook, layout),
        captions: {
          youtubeTitle: campaign ? m.hook : `${m.hook} ${tags}`,
          youtubeDescription: campaign ? `${ad}${m.summary} ${tags}` : m.summary,
          instagram: `${ad}${m.hook}\n${tags}`,
          facebook: campaign ? `${ad}${m.hook} ${tags}` : m.hook,
          tiktok: `${ad}${m.hook} ${tags}`,
          x: `${ad}${m.hook} ${tags}`,
        },
        checklist: {
          items: [
            { key: "hook_3s", label: "Hook lands in the first 3 seconds", pass: true },
            ...(campaign
              ? [
                  { key: "disclosure", label: "“Paid partnership” shows for the first 3 seconds", pass: true },
                  ...(campaign.logo.needed ? [{ key: "logo", label: "The campaign's logo is on the whole clip", pass: true }] : []),
                  { key: "campaign_rules", label: "Follows the campaign's rules", pass: true },
                ]
              : []),
          ],
          fixes: [],
        },
        score: m.score,
        pickedFor: m.why,
        createdAt: new Date().toISOString(),
        ...(job.campaignId ? { campaignId: job.campaignId } : {}),
      });
    }
    job.status = "ready";
    job.clipCount = count;
    job.progress = 1;
    job.steps = stepsAt(STEP_KEYS.length, "ready");
    job.updatedAt = new Date().toISOString();
    for (const c of store.clips) if (c.jobId === job.jobId) publishClip(c);
  }

  function tick() {
    if (frozen()) return;
    const now = Date.now();
    for (const job of store.jobs) {
      // Waiting for the owner's Mac (§35): nothing moves until the Mac reports (macProgress) or sends the video.
      if (macWaiting(job)) continue;
      if (job.status === "queued" && now - Date.parse(job.createdAt) > 4000) {
        job.status = "running";
        clock.set(job.jobId, { at: now, done: 0 });
      }
      const c = clock.get(job.jobId);
      if (job.status !== "running" || !c) continue;
      const before = job.progress;
      const done = Math.min(STEP_KEYS.length, c.done + Math.floor((now - c.at) / STEP_MS));
      if (done >= STEP_KEYS.length) {
        finish(job);
        clock.delete(job.jobId);
      } else {
        const within = ((now - c.at) % STEP_MS) / STEP_MS;
        job.steps = stepsAt(done, "running", STEP_KEYS[done] === "render" ? "Cutting the clips" : undefined);
        job.progress = Math.min(0.99, (done + within) / STEP_KEYS.length);
      }
      job.updatedAt = new Date().toISOString();
      const live = sampleLine(job);
      if (live) mockLive.publish({ type: "jobLive", op: "upsert", id: job.jobId, item: live });
      // Like the agent's heartbeats: a message only when the job really moved.
      if (Math.round(job.progress * 100) !== Math.round(before * 100) || job.status !== "running") publishJob(job);
    }
  }

  /** One step forward for the newest running job, pushed live (tests use it; automation freezes the clock). */
  function advance() {
    const j = [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((x) => x.status === "running");
    if (!j) return;
    const done = j.steps.findIndex((s) => s.status === "running") + 1;
    clock.delete(j.jobId);
    if (done >= STEP_KEYS.length) finish(j);
    else {
      j.steps = stepsAt(done, "running");
      j.progress = done / STEP_KEYS.length;
      j.updatedAt = new Date().toISOString();
    }
    publishJob(j);
  }
  /** The next scripted live line for the newest running job, pushed live (tests and screenshots, §31). */
  function line(at?: number) {
    const j = [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((x) => x.status === "running");
    if (!j) return;
    const k = at ?? scriptAt;
    scriptAt = k + 1;
    publishLine(j, SCRIPT[k % SCRIPT.length]!);
  }
  mockLive.tick = tick;
  installMockLiveControls(advance, line);

  // An empty account (window.__cfMock.jobs.clear()) lasts until the tab closes, so a reload shows the empty states.
  if (emptyAccount()) {
    store.jobs.length = 0;
    store.clips.length = 0;
  }
  /** Test knob (window.__cfMock.jobs): a finished job as it was saved before the "watch" step existed (nine steps). */
  const jobKnobs = {
    /** One check of a clip passes or fails (tests: "Paid partnership" not on the video makes a campaign clip need a copy). */
    checklist(clipId: string, key: string, pass: boolean): void {
      const c = store.clips.find((x) => x.clipId === clipId);
      if (!c) return;
      const items = c.checklist.items.filter((i) => i.key !== key);
      c.checklist = { ...c.checklist, items: [...items, { key, label: key, pass }] };
      publishClip(c);
    },
    /** The newest queued or working job finishes now: its clips wait in Review (tests: "the job runs"). */
    finish(jobId?: string): string | null {
      const j = jobId ? store.jobs.find((x) => x.jobId === jobId) : [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((x) => x.status === "queued" || x.status === "running");
      if (!j || j.remakeOf) return null;
      clock.delete(j.jobId);
      finish(j);
      publishJob(j);
      return j.jobId;
    },
    /** No jobs and no clips, as for a new owner, so the empty Home and Jobs can be checked (reload to see them). */
    clear() {
      store.jobs.length = 0;
      store.clips.length = 0;
      try {
        sessionStorage.setItem(EMPTY_KEY, "1");
      } catch {
        /* no storage: empty for this page only */
      }
    },
    oldSteps(): { jobId: string; title: string } | null {
      const j = store.jobs.find((x) => x.status === "ready");
      if (!j) return null;
      j.steps = j.steps.filter((s) => s.key !== "watch");
      publishJob(j);
      return { jobId: j.jobId, title: j.source.title ?? "" };
    },
    /** A working job whose record says 100% while steps are left (as a run before the 2026-11-20 fix wrote it). */
    fullBar(): { jobId: string; title: string } | null {
      const j = store.jobs.find((x) => x.status === "running");
      if (!j) return null;
      j.progress = 1;
      publishJob(j);
      return { jobId: j.jobId, title: j.source.title ?? "" };
    },
  };
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    w.__cfMock = { ...(w.__cfMock ?? {}), jobs: jobKnobs };
  }

  const stats = statsApi({ store, publish: (ev) => mockLive.publish(ev), faults, automated: frozen });
  const setup = setupApi({
    onAccounts: (accounts) => {
      store.accounts = accounts;
    },
    publish: (platform) => mockLive.publish({ type: "setup", op: "upsert", id: platform, partial: true }),
    onConnected: releaseWaiting,
  });
  // Content Rewards (§38.18): its own state; it reads the setups for each campaign's places.
  const crPublish = (id: string) => mockLive.publish({ type: "contentrewards", op: "upsert", id, partial: true });
  // The campaign finder (§41.5) reads Content Rewards' campaigns and connection, and the overview carries its summary.
  let finder: FinderMock | null = null;
  const cr = crMockApi({
    store,
    setup: () => setup.overview(),
    publish: crPublish,
    finder: () => finder?.overview(),
    catalog: (uuid, rules) => catalogOf(uuid, rules),
    macOn: () => macOn(store.settings),
  });
  finder = finderMockApi({
    setup: () => setup.overview(),
    publish: crPublish,
    guard: () => cr.guard(),
    signedIn: () => cr.signedIn(),
    setSignedIn: (on) => cr.setSignedIn(on),
    ownIds: () => cr.ownIds(),
    add: (uuid, cat, how) => cr.finderAdd(uuid, cat, how),
    rules: (partial) => cr.rules(partial),
    macOn: () => macOn(store.settings),
  });
  const finderApi = finder.api;

  const job = (jobId: string) => {
    const j = store.jobs.find((x) => x.jobId === jobId);
    if (!j) throw notFound("job");
    return j;
  };

  // §39.3: does this clip fit, and the campaign copy. The copy waits behind a switch, like the API's (off by default).
  const REMAKE_KEY = "cf-mock-cr-remake";
  const remakeFlag = () => {
    try {
      return sessionStorage.getItem(REMAKE_KEY);
    } catch {
      return null;
    }
  };
  const remakeOn = () => remakeFlag() === "on" || remakeFlag() === "fail";
  const fitInputs = (c: Clip) => (campaign: Campaign): FitInputs => {
    const original = c.remakeOf ? store.clips.find((x) => x.clipId === c.remakeOf!.clipId) : null;
    const relatives = [original, ...store.clips.filter((x) => (original && x.remakeOf?.clipId === original.clipId) || x.remakeOf?.clipId === c.clipId)].filter(
      (x): x is Clip => !!x && x.clipId !== c.clipId && x.status !== "declined",
    );
    const served = cr.served();
    return {
      clip: c,
      job: store.jobs.find((j) => j.jobId === c.jobId) ?? null,
      campaign,
      conn: cr.connection(),
      posts: store.posts.filter((p) => p.clipId === c.clipId),
      others: [
        ...relatives.filter((x) => x.campaignId).map((x) => ({ campaignId: x.campaignId!, name: served.find((s) => s.campaignId === x.campaignId)?.name ?? "" })),
        ...Object.keys(c.remakes ?? {})
          .filter((id) => id !== campaign.campaignId)
          .map((id) => ({ campaignId: id, name: served.find((s) => s.campaignId === id)?.name ?? "" })),
      ],
      remakeOn: remakeOn(),
      now: Date.now(),
      macOn: macOn(store.settings),
    };
  };
  const fitOf = (c: Clip) => clipFit(c, fitInputs(c), cr.served());
  /** A campaign copy finishes like a one-clip job: the same moment, the campaign's marks, #Ad and the tags. */
  function finishCopy(j: Job, from: Clip, campaign: Campaign) {
    const tags = [campaign.rules?.disclosure.caption ?? "#Ad", ...(campaign.rules?.requiredHashtags ?? []), ...(campaign.rules?.requiredTags ?? [])];
    const withTags = (t: string) => `${tags[0]} ${t.replace(/^#ad\b\s*/i, "")} ${tags.slice(1).join(" ")}`.trim();
    const copy: Clip = {
      ...clone(from),
      clipId: ulid(),
      jobId: j.jobId,
      rank: 1,
      status: "review",
      createdAt: new Date().toISOString(),
      campaignId: campaign.campaignId,
      remakeOf: { clipId: from.clipId, jobId: from.jobId },
      // A campaign copy has no Your take: its layout is the campaign's.
      take: undefined,
      takeSpoken: undefined,
      remakes: undefined,
      uploadTo: undefined,
      decidedAt: undefined,
      best: undefined,
      bestWeek: undefined,
      totalViews: undefined,
      captions: {
        youtubeTitle: from.captions.youtubeTitle,
        youtubeDescription: withTags(from.captions.youtubeDescription),
        instagram: withTags(from.captions.instagram),
        facebook: withTags(from.captions.facebook),
        tiktok: withTags(from.captions.tiktok),
        x: withTags(from.captions.x),
      },
      checklist: {
        items: [
          ...from.checklist.items.filter((x) => !["logo", "disclosure", "campaign_rules"].includes(x.key)),
          { key: "disclosure", label: "“Paid partnership” shows for the first 3 seconds", pass: true },
          ...(campaign.logo.needed ? [{ key: "logo", label: "The campaign's logo is on the whole clip", pass: true }] : []),
          { key: "campaign_rules", label: "Follows the campaign's rules", pass: true },
        ],
        fixes: [],
      },
    };
    store.clips.push(copy);
    j.status = "ready";
    j.clipCount = 1;
    j.progress = 1;
    j.steps = stepsAt(STEP_KEYS.length, "ready");
    j.updatedAt = new Date().toISOString();
    publishJob(j);
    publishClip(copy);
  }
  /** A copy whose job failed: the original keeps its `remakes` entry (as the API does), and a new copy can be asked. */
  function failCopy(j: Job) {
    j.status = "failed";
    j.error = "Clip Factory couldn't make the copy. Try again.";
    j.steps = stepsAt(Math.max(0, STEP_KEYS.length - 2), "failed", "Cutting the clips");
    j.updatedAt = new Date().toISOString();
    publishJob(j);
  }
  const clip = (clipId: string) => {
    const c = store.clips.find((x) => x.clipId === clipId);
    if (!c) throw notFound("clip");
    return c;
  };
  // CR active (§53): the logo library, the switch and Make it. The campaign is read through Content Rewards' own mock.
  const crOverlay = crOverlayApi({
    delay: (a, b) => delay(a, b),
    clip,
    publishClip: (c) => publishClip(c),
    campaign: (id) => cr.api.crCampaign(id).then((c) => c, () => null),
  });
  // Reference videos, "Edit like these" (§57).
  const refVideos = refVideosApi({ delay: (a, b) => delay(a, b) });
  /** Deletes one job like the API (§34): thrown-away clips always, Review clips only with "delete", never others. */
  const removeJob = (jobId: string, clips: JobDeleteClips): JobDeleted => {
    const j = store.jobs.find((x) => x.jobId === jobId);
    if (!j) return { jobId, deleted: false, clipsDeleted: 0, clipsKept: 0 };
    const mine = store.clips.filter((c) => c.jobId === jobId);
    const gone = mine.filter((c) => c.status === "declined" || (clips === "delete" && c.status === "review"));
    store.clips = store.clips.filter((c) => !gone.includes(c));
    store.jobs = store.jobs.filter((x) => x !== j);
    clock.delete(jobId);
    for (const c of gone) mockLive.publish({ type: "clip", op: "delete", id: c.clipId });
    mockLive.publish({ type: "job", op: "delete", id: jobId });
    return { jobId, deleted: true, clipsDeleted: gone.length, clipsKept: mine.length - gone.length };
  };
  // §44: the owner's copy of a built-in, only when a test asked for it (kept over reloads).
  const copy = savedSkillCopy();
  if (copy && !store.skills.some((x) => x.skillId === copy.skillId)) store.skills.push(copy);
  const skills = skillsApi(store, delay);
  const lessons = lessonsApi(() => store.clips, () => faults.lessons, () => delay());
  const follows = followsApi((ev) => mockLive.publish(ev), () => delay());
  const money = moneyApi(() => delay(), { clips: () => store.clips, posts: () => store.posts });
  // Get paid (§40): statuses from the pretend owner's ticks and signals; Content Rewards' part reads its connection.
  const getpaid = getPaidMockApi(() => delay(), {
    accounts: () => setup.accounts(),
    country: () => {
      try {
        return (JSON.parse(sessionStorage.getItem("cf-mock-money") ?? "null") as { country?: string | null } | null)?.country ?? null;
      } catch {
        return null;
      }
    },
    // At once (a test or screenshot goes to the page right after picking its start).
    setCountry: (c) => {
      try {
        const raw = (JSON.parse(sessionStorage.getItem("cf-mock-money") ?? "null") as Record<string, unknown> | null) ?? { scenario: "start", seen: [] };
        sessionStorage.setItem("cf-mock-money", JSON.stringify({ ...raw, country: c }));
      } catch {
        /* no storage: no country */
      }
    },
    connect: (platforms) => {
      for (const p of platforms) if (!setup.connected().includes(p)) setup.controls.finish(p);
    },
    cr: () => {
      const items = cr.moneyItems();
      const m = items.crmoney as { paidTotalCents?: number; stillEarningCents?: number; readyToMoveCents?: number; onItsWayCents?: number } | null;
      const above = !!m && [m.paidTotalCents, m.stillEarningCents, m.readyToMoveCents, m.onItsWayCents].some((v) => (v ?? 0) > 0);
      return { on: items.on, conn: items.on ? items.crconn : null, moneyAboveZero: above, readyCents: m?.readyToMoveCents ?? null };
    },
    publish: () => mockLive.publish({ type: "getpaid", op: "upsert", id: "getpaid", partial: true }),
  });
  // Your bank (§40.5): the pretend Enable Banking and bank; the country is Money's, as on the server.
  const bank = bankMockApi(() => delay(), {
    country: () => {
      try {
        return (JSON.parse(sessionStorage.getItem("cf-mock-money") ?? "null") as { country?: string | null } | null)?.country ?? null;
      } catch {
        return null;
      }
    },
    crOn: () => cr.moneyItems().on,
    publish: () => mockLive.publish({ type: "bank", op: "upsert", id: "bank", partial: true }),
  });
  const followers = followersApi(() => delay());
  if (typeof window !== "undefined") {
    // Merge, never replace: posting (above) and setup (mock/setup.ts) keep their knobs on the same object.
    const w = window as unknown as { __cfMock?: Record<string, unknown> & Partial<MockSkillControls> };
    w.__cfMock = Object.assign(w.__cfMock ?? {}, skills.controls, { crOverlay: crOverlay.controls, refVideos: refVideos.controls, follows: follows.controls, money: money.controls, getpaid: getpaid.controls, bank: bank.controls, followers: followers.controls });
  }

  /**
   * Upload's own code (§14.5, §33): the api's confirmClip, and auto-posting's send (§46.7 step 4) with `auto`, which
   * marks the clip and its new posts; a Private test run's posts are only his (§46.8).
   */
  async function confirmNow(
    clipId: string,
    captions?: Partial<Captions>,
    tiktok?: TikTokPostOptions,
    platforms?: Platform[],
    options?: ClipPostOptions,
    auto?: NonNullable<Clip["auto"]>,
    tiktokMac = false,
  ): Promise<{ clip: Clip; posts: Post[] }> {
    if (options !== undefined) {
      const wrong = clipOptionsProblem(options);
      if (wrong) throw bad(wrong);
    }
    const c = clip(clipId);
    const connected = setup.connected();
    // The places picked on Upload (§33): known, each once, not empty, and each set up.
    let chosen: Platform[] | undefined;
    if (platforms !== undefined) {
      if (!Array.isArray(platforms) || !platforms.length) throw bad("Pick at least one place to upload to.");
      if (!platforms.every((p) => PLATFORMS.includes(p))) throw bad("One of the places to upload to is not one Clip Factory knows.");
      const twice = platforms.find((p, i) => platforms.indexOf(p) !== i);
      if (twice) throw bad(`${PLATFORM_LABEL[twice]} is in the list twice. Pick each place once.`);
      chosen = PLATFORM_ORDER.filter((p) => platforms.includes(p));
    }
    if (c.status === "review" && chosen) {
      const missing = chosen.find((p) => !connected.includes(p));
      if (missing) throw bad(`${PLATFORM_LABEL[missing]} is not set up yet. Turn it off, then tap Upload.`);
      // routes/clips._place_refusal: before TikTok approved the app a campaign clip's TikTok goes only through his Mac.
      if (c.campaignId && chosen.includes("tiktok") && !tiktokAudited(setup.overview().platforms) && !macOn(store.settings))
        throw bad(`${CAMPAIGN_MAC_OFF} Or turn TikTok off, then tap Upload.`);
    }
    // A campaign clip (§38.14): only the campaign's places, public, never made for kids, TikTok Branded content.
    if (c.status === "review") await cr.confirmCheck(c, chosen, options, tiktok);
    // §39.3: a campaign clip goes up the campaign way only when it can earn (the merged captions, the picked places).
    if (c.status === "review" && c.campaignId) {
      const own = fitOf({ ...c, captions: { ...c.captions, ...(captions ?? {}) } }).fits[0];
      const now = own ? liveFit(own, { captions: { ...c.captions, ...(captions ?? {}) }, chosen: chosen ?? null, tiktok: chosen?.includes("tiktok") ? (tiktok ?? null) : null }) : null;
      const refusal = now ? uploadRefusal(now) : null;
      if (refusal) throw conflict(refusal);
    }
    // TikTok's rules: the owner picks who can see it before anything is posted there (§17.8).
    const tiktokGoing = chosen ? chosen.includes("tiktok") : store.settings.platforms.includes("tiktok") && connected.includes("tiktok");
    if (c.status === "review" && tiktokGoing && !tiktok?.privacyLevel) throw bad("Pick who can see it on TikTok.");
    // Your Mac posts TikTok (§47.2): Upload's TikTok goes to the Mac while TikTok has not approved the app, and a live
    // auto-posting run gives a clip a Mac post too (never a Private test run). A campaign clip too, always Everyone with
    // Branded content (TikTok's Paid partnership label); once TikTok approved the app it goes through TikTok's API.
    const macUpload = !auto && !!chosen?.includes("tiktok") && macOn(store.settings) && !tiktokAudited(setup.overview().platforms);
    const macAuto = !!auto && !auto.test && macOn(store.settings);
    // The Mac post's options: with `tiktokMac` the card's own TikTok row (as validated), else My settings.
    const macChoices = (source: "upload" | "auto") => macOptions(store.settings, c, source === "upload" && tiktokMac ? tiktok : null);
    const startPosting = () => {
      const have = new Set(store.posts.filter((p) => p.clipId === clipId).map((p) => p.platform));
      const targets = c.uploadTo ?? store.settings.platforms;
      const created: Post[] = targets
        .filter((platform) => !have.has(platform))
        .map((platform) =>
          platform === "tiktok" && macUpload
            ? { postId: ulid(), clipId, platform, ...mac.macFields("upload", macChoices("upload")) }
            : { postId: ulid(), clipId, platform, status: connected.includes(platform) ? "queued" : "pending_integration" },
        );
      // Auto-posting's posts (§46.9); a Private test run's go up for him only, at once here (no flow in the mock).
      if (auto) for (const p of created) privateTest(Object.assign(p, { auto: true as const }), auto.test);
      if (macAuto && !have.has("tiktok") && !targets.includes("tiktok")) {
        const made: Post = { postId: ulid(), clipId, platform: "tiktok", ...mac.macFields("auto", macChoices("auto")), auto: true };
        postOptions.set(made.postId, macChoices("auto"));
        created.splice(PLATFORM_ORDER.filter((p) => p === "youtube" && created.some((x) => x.platform === p)).length, 0, made);
      }
      store.posts.push(...created);
      for (const p of created) if (p.platform === "tiktok" && p.status === "queued" && tiktok) postOptions.set(p.postId, clone(tiktok));
      // Upload's Mac post: the card's own row with `tiktokMac`, else My settings (an older web); a campaign clip's always
      // ends Everyone with Branded content (§47.2).
      for (const p of created) if (p.platform === "tiktok" && p.status === "mac" && !p.auto) postOptions.set(p.postId, macChoices("upload"));
      for (const p of created) {
        const own = options?.[p.platform as keyof ClipPostOptions];
        if (own) clipOptions.set(p.postId, clone(own));
      }
      cr.onPosts(c, created);
      if (auto?.test && created.every((p) => p.status === "posted")) c.status = "posted";
      publishClip(c);
      for (const p of created) publishPost(p);
      return { clip: clone(c), posts: clone(store.posts.filter((p) => p.clipId === clipId)) };
    };
    // Keep again on a kept clip whose posting never started: finished once the last try is old enough.
    if (c.status === "confirmed" && !store.posts.some((p) => p.clipId === clipId)) {
      const last = claimedAt.get(clipId) ?? Date.parse(c.decidedAt ?? "");
      if (Number.isNaN(last) || Date.now() - last < faults.resumeAfterMs) throw conflict(ALREADY_DECIDED);
      claimedAt.set(clipId, Date.now());
      return startPosting();
    }
    if (c.status === "failed" || ((c.status === "posted" || c.status === "confirmed") && chosen)) return tryAgain(c, tiktok, chosen);
    // A start that did not go through earlier (§14.5): Try again starts it.
    if (c.startPending && c.status !== "review") {
      started(c);
      return { clip: clone(c), posts: clone(store.posts.filter((p) => p.clipId === clipId)) };
    }
    if (c.status !== "review") throw conflict(ALREADY_DECIDED);
    if (captions) c.captions = { ...c.captions, ...captions };
    if (chosen) c.uploadTo = chosen;
    // TikTok's label ticked on the card (TikTok chosen or not): the clip keeps it for a later Mac post (Clip.tiktokLabel).
    if (tiktok && (tiktok.brandContent || tiktok.brandOrganic)) c.tiktokLabel = { brandContent: tiktok.brandContent === true, brandOrganic: tiktok.brandOrganic === true };
    if (auto) c.auto = clone(auto);
    c.status = "confirmed";
    c.decidedAt = new Date().toISOString();
    claimedAt.set(clipId, Date.now());
    if (faults.keepStopsAfterSave > 0) {
      faults.keepStopsAfterSave--;
      throw networkError();
    }
    return startPosting();
  }

  /** A Private test run's post (§46.8): YouTube Only me with its link, Facebook a draft, Instagram checked only. */
  function privateTest(p: Post, test: "private" | undefined) {
    if (!test || p.status !== "queued") return;
    Object.assign(p, { test, status: "posted", privacy: "private", postedAt: new Date().toISOString() });
    if (p.platform === "youtube") p.url = `https://example.com/youtube/${p.postId}`;
  }

  // Auto-posting (§46.3–§46.9): Upload's own code sends, the places are the setups that are ready, minus TikTok.
  const autopost = autoPostMock({
    clips: () => store.clips,
    jobs: () => store.jobs,
    posts: () => store.posts,
    settings: () => store.settings,
    ready: () => setup.overview().platforms.filter((p) => p.ready).map((p) => p.platform),
    campaign(c, places) {
      // §46.5 rule 4: only while Content Rewards takes clips from Clip Factory by itself, the campaign way (§38.14).
      try {
        cr.guard();
      } catch {
        return { wait: CR_CANT_TAKE, places: [] };
      }
      if (cr.connection().status !== "connected") return { wait: CR_CANT_TAKE, places: [] };
      const campaign = cr.served().find((x) => x.campaignId === c.campaignId);
      if (!campaign) return { wait: "Add the campaign again on the Campaigns page.", places: [] };
      if (campaign.membership === "manual") return { wait: CR_BY_HAND, places: [] };
      if (campaign.membership !== "in") return { wait: campaign.nextStep.text, places: [] };
      const stop = campaign.stops.find((x) => x.hard);
      if (stop) return { wait: stop.text, places: [] };
      const going = places.filter((p) => campaign.uploadPlaces.includes(p));
      if (!going.length) return { wait: NOTE_NO_PLACES, places: [] };
      const own = fitOf(c).fits[0];
      const now = own ? liveFit(own, { captions: c.captions, chosen: going, tiktok: null }) : null;
      const refusal = now ? uploadRefusal(now) : null;
      return refusal ? { wait: refusal, places: [] } : { wait: null, places: going };
    },
    async send(c, places, options, auto) {
      await confirmNow(c.clipId, undefined, undefined, places, options, auto);
    },
  });
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> & { autopost?: AutoPostControls } };
    w.__cfMock = { ...(w.__cfMock ?? {}), autopost: autopost.controls };
  }

  // Your Mac posts TikTok (§47): its queue, Send these, Try again and Take it back; the helper's routes are test knobs.
  const mac = tiktokMacMock({
    clips: () => store.clips,
    posts: () => store.posts,
    settings: () => store.settings,
    options: postOptions,
    publishPost,
    removePost: (p) => mockLive.publish({ type: "post", op: "delete", id: p.postId }),
    publishClip,
    now: () => Date.now(),
    // A campaign clip goes to the Mac only while its campaign takes clips (the API's _require_campaign_open).
    campaignRefusal(c) {
      const full = cr.served().find((x) => x.campaignId === c.campaignId);
      if (!full) return "Add the campaign again on the Campaigns page.";
      return full.stops.find((x) => x.hard && (x.code === "held" || x.code === "paused" || x.code === "ended"))?.text ?? null;
    },
  });
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> & { mac?: TikTokMacControls } };
    w.__cfMock = { ...(w.__cfMock ?? {}), mac: mac.controls };
  }

  const api: Api = {
    ...cr.api,
    ...finderApi,
    async crFit(clipId) {
      await delay(80, 160);
      cr.guard();
      return clone(fitOf(clip(clipId)));
    },
    async crFits(clipIds) {
      await delay(80, 160);
      cr.guard();
      if (!clipIds.length || clipIds.length > 20) throw bad("Ask for 1 to 20 clips.");
      return clipIds.map((id) => store.clips.find((c) => c.clipId === id)).filter((c): c is Clip => !!c).map((c) => clone(fitOf(c)));
    },
    async crFitCaptions({ clipId, campaignId, captions }) {
      await delay(80, 160);
      cr.guard();
      const c = clip(clipId);
      if (c.campaignId !== campaignId || c.status !== "review") throw bad("This clip isn't a campaign clip waiting in Review.");
      const campaign = cr.served().find((x) => x.campaignId === campaignId);
      const rules = campaign?.rules;
      const disclosure = rules?.disclosure.caption ?? "#Ad";
      const wanted = [...(rules?.requiredHashtags ?? []), ...(rules?.requiredTags ?? [])];
      // B's campaign_caption, in short: the disclosure first, then every required item the caption lacks.
      const fix = (text: string) => {
        let out = text.trim();
        if (!adFirst(out, disclosure)) out = `${disclosure} ${out}`.trim();
        for (const w of wanted) if (!hasItem(out, w)) out = `${out} ${w}`;
        return out;
      };
      const out: Captions = { ...c.captions, ...captions };
      for (const k of ["youtubeDescription", "instagram", "facebook", "tiktok", "x"] as const) out[k] = fix(out[k]);
      return out;
    },
    async crRemake(campaignId, body) {
      await delay();
      cr.guard();
      if (!remakeOn()) throw new ApiError(503, "unavailable", "Coming soon.");
      const c = clip(body.clipId);
      const campaign = cr.served().find((x) => x.campaignId === campaignId);
      if (!campaign) throw notFound("campaign");
      // G's reserve: a copy already named answers that job, unless it failed, was canceled or deleted, or its clip
      // was thrown away (then a new copy can be made).
      const had = c.remakes?.[campaignId];
      const hadJob = had ? store.jobs.find((j) => j.jobId === had.jobId && j.status !== "failed" && j.status !== "canceled") : undefined;
      const thrown = hadJob ? store.clips.some((x) => x.jobId === hadJob.jobId && x.status === "declined") : false;
      if (hadJob && !thrown) return clone(hadJob);
      const from = store.jobs.find((j) => j.jobId === c.jobId) ?? null;
      const found = fitOne(fitInputs(c)(campaign));
      const refusal = remakeRefusal(found, sourceKept(from, Date.now()));
      if (refusal) throw conflict(refusal);
      const soft = campaign.stops.find((s) => !s.hard && s.code !== "not_connected" && !s.anyway && !(body.campaignAnyway ?? []).includes(s.code));
      if (soft) throw conflict(soft.text);
      const now = new Date().toISOString();
      const j: Job = {
        jobId: ulid(),
        status: "running",
        source: clone(from?.source ?? { type: "link", platform: "youtube" }),
        clipTarget: { min: 1, max: 1 },
        steps: stepsAt(Math.max(0, STEP_KEYS.length - 2), "running", "Cutting the clips"),
        progress: 0.8,
        clipCount: 0,
        ...(from?.notes ? { notes: from.notes } : {}),
        campaignId,
        remakeOf: { clipId: c.clipId, jobId: c.jobId },
        ...(from?.sourceLanguage ? { sourceLanguage: from.sourceLanguage } : {}),
        model: currentClipModel(store.settings.clipModel),
        createdAt: now,
        updatedAt: now,
      };
      store.jobs.unshift(j);
      c.remakes = { ...(c.remakes ?? {}), [campaignId]: { jobId: j.jobId, at: now } };
      publishJob(j);
      publishClip(c);
      // "It shows here in about 3 minutes": a moment in the pretend app (or, with the "fail" knob, its job fails).
      setTimeout(() => (remakeFlag() === "fail" ? failCopy(j) : finishCopy(j, c, campaign)), 2500);
      return clone(j);
    },
    async getMoneyEverywhere() {
      await delay();
      // An API from before §39 (tests): GET /v1/money/everywhere is not there.
      let before39 = false;
      try {
        before39 = sessionStorage.getItem("cf-mock-money-everywhere") === "404";
      } catch {
        /* no storage: the route is there */
      }
      if (before39) throw notFound("page");
      const scenario = money.controls.scenario();
      const data = dashData(scenario);
      const items = cr.moneyItems();
      const accounts: Parameters<typeof everywhere>[0]["accounts"] = {};
      const states: Parameters<typeof everywhere>[0]["states"] = {};
      for (const p of PLATFORM_ORDER) {
        const st = data.status[p];
        if (st?.connected) accounts[p] = { platform: p, status: "connected", scopes: p === "youtube" && st.moneyScope ? [MONETARY_SCOPE] : [] };
        if (st) states[p] = { state: ["not_yet", "goal_reached", "in_program"].includes(scenario) ? scenario : "earning", ...(st.lastError ? { lastError: st.lastError } : {}), ...(st.checkedAt ? { lastCheckedAt: st.checkedAt } : {}) };
      }
      return everywhere({
        today: new Date().toISOString(),
        facebookVerified: data.facebookVerified,
        accounts,
        states,
        rows: data.rows,
        crOn: items.on,
        crconn: items.crconn,
        crmoney: items.crmoney as Parameters<typeof everywhere>[0]["crmoney"],
        // §40.4's sent lines from the pretend Get paid payouts.
        ...getpaid.sentInputs(),
      });
    },
    ...getpaid.api,
    ...bank.api,
    async health() {
      await delay();
      return { ok: true, version: "mock" };
    },
    async me() {
      await delay();
      tick();
      return {
        user: { id: "mock-owner", email: "owner@example.com" },
        settings: clone(store.settings),
        counts: {
          review: store.clips.filter((c) => c.status === "review").length,
          running: store.jobs.filter((j) => j.status === "running" || j.status === "queued").length,
          posted: store.clips.filter((c) => c.status === "posted").length,
        },
      };
    },
    async createUpload({ filename, contentType, size, purpose }) {
      await delay();
      if (purpose === "attachment") {
        // A file for the notes (§52): the allowed kinds, up to 20 MB, under the same uploads/ prefix.
        if (!canAttach(contentType) && contentType !== "text/rtf") throw bad(REFUSE.kind);
        if (size > MAX_ATTACHMENT_BYTES) throw new ApiError(413, "too_large", REFUSE.big);
      } else {
        if (!contentType.startsWith("video/")) throw bad("Pick a video file, like an MP4 or MOV.");
        if (size > 5 * 1024 ** 3) throw new ApiError(413, "too_large", "Videos can be up to 5 GB.");
      }
      const uploadId = ulid();
      return {
        uploadId,
        key: `uploads/mock-owner/${uploadId}/${filename}`,
        uploadUrl: "mock://upload",
        headers: { "Content-Type": contentType },
      };
    },
    async createJob(body) {
      await delay();
      if ((faults.createJobFails ?? 0) > 0) {
        faults.createJobFails!--;
        throw serverDown();
      }
      // A campaign job (§38.5): the campaign is checked again; a hard stop or a soft one not accepted is refused.
      if (body.campaignId) await cr.jobCheck(body.campaignId, body.campaignAnyway ?? []);
      const attachments = checkAttachments(body.attachments);
      const now = new Date().toISOString();
      const isLink = body.source.type === "link";
      const url = isLink ? (body.source as { url: string }).url : undefined;
      const platform = !isLink ? "upload" : /twitch\.tv/.test(url!) ? "twitch" : /kick\.com/.test(url!) ? "kick" : "youtube";
      const filename = body.source.type === "upload" ? body.source.filename : undefined;
      // A campaign job's video, as yt-dlp would read it: from the campaign's own channel (the fit's source check).
      const channel = body.campaignId && isLink ? cr.served().find((x) => x.campaignId === body.campaignId)?.rules?.allowedSources.channels[0]?.name : undefined;
      const j: Job = {
        jobId: ulid(),
        status: "queued",
        source: {
          type: body.source.type,
          platform,
          url,
          key: body.source.type === "upload" ? body.source.key : undefined,
          filename,
          title: filename ?? "Reading the link…",
          ...(channel ? { channel } : {}),
          thumbnailUrl: thumbArt(store.jobs.length, platform === "upload" ? "Upload" : platform),
        },
        clipTarget: body.clipTarget,
        steps: stepsAt(0, "queued"),
        // Like the API (§35): every YouTube link job may wait for the Mac; from the desktop app it does from the start.
        ...(isLink && platform === "youtube"
          ? { macFetch: body.macFetch ? { state: "waiting" as const, up: true, since: now } : { state: "cloud" as const } }
          : {}),
        progress: 0,
        clipCount: 0,
        notes: body.notes,
        ...(body.campaignId ? { campaignId: body.campaignId } : {}),
        // Kept only when there are some (§52).
        ...(attachments.length ? { attachments } : {}),
        // Like the agent (ADR-42): the job is made with the model picked in Settings at the time.
        model: currentClipModel(store.settings.clipModel),
        createdAt: now,
        updatedAt: now,
      };
      store.jobs.unshift(j);
      publishJob(j);
      // Like the API (§35.8): the file replaces the link job it came from, and that job's wait for the Mac ends.
      const old = body.replaces && body.source.type === "upload" ? store.jobs.find((o) => o.jobId === body.replaces) : undefined;
      const oldState = old?.macFetch?.state;
      if (old && (old.status === "queued" || old.status === "running") && oldState && oldState !== "cloud" && oldState !== "failed") {
        old.status = "canceled";
        old.replacedBy = j.jobId;
        old.steps = old.steps.map((s) => (s.status === "running" ? { ...s, status: "pending", message: undefined } : s));
        clock.delete(old.jobId);
        old.updatedAt = now;
        publishJob(old);
      }
      return clone(j);
    },
    async listJobs({ limit = 20, cursor } = {}) {
      await delay();
      if (cursor && (faults.olderJobsFails ?? 0) > 0) {
        faults.olderJobsFails!--;
        throw serverDown();
      }
      if (faults.jobsPageSize) limit = Math.min(limit, faults.jobsPageSize);
      tick();
      const sorted = [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const start = cursor ? Number(cursor) : 0;
      const page = sorted.slice(start, start + limit);
      const next = start + limit < sorted.length ? String(start + limit) : null;
      return { jobs: page.map(withLive), nextCursor: next };
    },
    async getJob(jobId) {
      await delay();
      tick();
      const j = job(jobId);
      const clips = store.clips.filter((c) => c.jobId === jobId).sort((a, b) => a.rank - b.rank);
      return { job: withLive(j), clips: clone(clips) };
    },
    async cancelJob(jobId) {
      await delay();
      const j = job(jobId);
      if (j.status !== "queued" && j.status !== "running") throw conflict("Only a job that is still working can be canceled.");
      j.status = "canceled";
      j.steps = j.steps.map((s) => (s.status === "running" ? { ...s, status: "pending", message: undefined } : s));
      clock.delete(jobId);
      j.updatedAt = new Date().toISOString();
      publishJob(j);
      return clone(j);
    },
    async macProgress(jobId, body) {
      await delay();
      const j = job(jobId);
      if (!macWaiting(j)) throw conflict("This job is not waiting for your Mac.");
      const now = new Date().toISOString();
      if (body.phase === "failed") {
        j.status = "failed";
        j.error = body.error === "full" ? `Your Mac is full. Free up ${body.needGb ?? 1} GB.` : "Your Mac could not get the video. Tap Try again, or tap Use a video file.";
        j.macFetch = { ...j.macFetch!, state: "failed", at: now };
      } else {
        j.status = "running";
        j.macFetch = { ...j.macFetch!, state: body.phase, pct: body.pct ?? 0, at: now };
        const text = body.phase === "getting" ? "Your Mac is getting the video" : "Your Mac is sending the video";
        mockLive.publish({
          type: "jobLive",
          op: "upsert",
          id: j.jobId,
          item: { jobId: j.jobId, step: "resolve", text, detail: `${body.pct ?? 0}%`, pct: body.pct ?? 0, at: now, lastChange: now, run: j.run },
        });
      }
      j.updatedAt = now;
      publishJob(j);
      return clone(j);
    },
    async macSourceUpload(jobId, body) {
      await delay();
      const j = job(jobId);
      if (!macWaiting(j)) throw conflict("This job is not waiting for your Mac.");
      const partSize = 64 * 1024 * 1024;
      const count = Math.max(1, Math.ceil(body.size / partSize));
      j.macFetch = { ...j.macFetch!, state: "sending", pct: 0 };
      return { partSize, parts: Array.from({ length: count }, (_, i) => ({ n: i + 1, url: `mock://part/${i + 1}` })) };
    },
    async macSourceComplete(jobId, body) {
      await delay();
      const j = job(jobId);
      if (!macWaiting(j)) throw conflict("This job stopped waiting for your Mac.");
      const now = new Date().toISOString();
      j.source = {
        ...j.source,
        type: "upload",
        platform: "upload",
        fetchedBy: "mac",
        linkPlatform: "youtube",
        title: body.title ?? j.source.title,
        channel: body.creator ?? j.source.channel,
      };
      j.macFetch = { ...j.macFetch!, state: "done", at: now };
      j.status = "queued";
      j.note = "Your Mac sent the video.";
      j.createdAt = now;
      j.updatedAt = now;
      publishJob(j);
      return clone(j);
    },
    async retryJob(jobId) {
      await delay();
      const j = job(jobId);
      if (j.status !== "failed" && j.status !== "canceled") throw conflict("Only a failed or canceled job can be retried.");
      j.status = "queued";
      j.error = undefined;
      j.replacedBy = undefined;
      j.steps = stepsAt(0, "queued");
      j.progress = 0;
      j.model = currentClipModel(store.settings.clipModel);
      j.modelWanted = undefined;
      j.createdAt = new Date().toISOString();
      j.updatedAt = j.createdAt;
      publishJob(j);
      return clone(j);
    },
    async deleteJob(jobId, clips = "keep") {
      await delay();
      if ((faults.deleteJobFails ?? 0) > 0) {
        faults.deleteJobFails!--;
        throw serverDown();
      }
      return removeJob(jobId, clips);
    },
    async deleteJobs(jobIds, clips = "keep") {
      await delay();
      if ((faults.deleteJobFails ?? 0) > 0) {
        faults.deleteJobFails!--;
        throw serverDown();
      }
      if (!jobIds.length || jobIds.length > 25) throw bad("jobIds must list 1 to 25 jobs.");
      return [...new Set(jobIds)].map((id) => removeJob(id, clips));
    },
    async listClips({ status = "review", jobId } = {}) {
      await delay();
      tick();
      return clone(
        store.clips
          .map((c) => stats.withTotal(c))
          .filter((c) => status === "all" || c.status === status)
          .filter((c) => !jobId || c.jobId === jobId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.rank - b.rank),
      );
    },
    async getClip(clipId) {
      await delay();
      return clone(stats.withTotal(clip(clipId)));
    },
    async updateClip(clipId, captions) {
      await delay(120, 260);
      const c = clip(clipId);
      if (c.status !== "review") throw conflict("Captions can only be changed while the clip waits for review.");
      c.captions = { ...c.captions, ...captions };
      publishClip(c);
      return clone(c);
    },
    async confirmClip(clipId, captions, tiktok, platforms, options, tiktokMac) {
      await delay();
      const fail = faults.confirmFails?.shift();
      if (fail === "network") throw networkError();
      if (fail === "refused") throw bad("Pick who can see it on TikTok.");
      if (tiktokMac !== undefined && typeof tiktokMac !== "boolean") throw bad("tiktokMac must be true or false.");
      // §53 C5: a clip whose edit is still being made cannot be uploaded.
      if (clip(clipId).overlay?.status === "working") throw conflict("The edit is still being made.");
      lastConfirm = { clipId, ...(tiktok ? { tiktok: clone(tiktok) } : {}), ...(platforms ? { platforms: [...platforms] } : {}), ...(tiktokMac ? { tiktokMac: true } : {}) };
      return confirmNow(clipId, captions, tiktok, platforms, options, undefined, tiktokMac === true);
    },
    // Post it on TikTok yourself (§42): the same rules as the API's tiktok_self.py.
    async clipFile(clipId) {
      await delay();
      const c = clip(clipId);
      if (c.status === "declined") throw notFound("clip's video");
      // Mock clips carry no real video: a tiny stand-in file keeps Save the video and the share menu working.
      return { url: c.videoUrl ?? "data:video/mp4;base64,AAAAGGZ0eXBpc29tAAACAGlzb21tcDQx", filename: videoFileName(c.hook) };
    },
    async markTikTokPosted(clipId, link, _since, noLink) {
      await delay();
      const c = clip(clipId);
      if (noLink !== undefined && typeof noLink !== "boolean") throw bad("noLink must be true or false.");
      if (link?.trim() && noLink) throw bad("Send a link or noLink, not both.");
      if (!["confirmed", "publishing", "posted", "failed"].includes(c.status)) throw conflict("Upload this clip first. Then your Mac can post it on TikTok.");
      const mine = store.posts.filter((p) => p.clipId === clipId);
      if (!mine.length) throw conflict("This clip is still starting to upload. Try again in a minute.");
      let video: { id: string; handle: string } | null = null;
      if (link?.trim()) {
        const full = /tiktok\.com\/@([A-Za-z0-9_.]{1,64})\/(?:video|photo)\/(\d{8,25})/i.exec(link);
        if (full) video = { id: full[2]!, handle: full[1]! };
        else if (/(vm|vt)\.tiktok\.com\/\w+|tiktok\.com\/t\/\w+/i.test(link)) video = { id: "7710644811602169121", handle: "lamo.clips" };
        else if (/tiktok\.com/i.test(link)) throw bad("That link does not open a TikTok video. In TikTok, open your post, tap Share, then Copy link.");
        else throw bad("That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.");
      }
      let p = mine.find((x) => x.platform === "tiktok");
      // Find it for me (neither a link nor noLink, D3): already his with its link, nothing changes. Else the Mac's own
      // check first, then the finder: here the first look on a clip finds nothing (409, nothing saved), the next finds it.
      const finding = !video && !noLink;
      if (finding && p?.by === "you" && p.url) return { clip: clone(c), posts: clone(mine) };
      if (p?.status === "queued") throw conflict("This clip is still uploading to TikTok. Wait until it is done, then try again.");
      // A Mac post (§47.3): his own post while it waits or stopped, never while the Mac is posting it.
      mac.beforeMarked(p, noLink === true);
      if (finding) {
        if (!lookedFor.has(clipId)) {
          lookedFor.add(clipId);
          throw conflict(MAC_FIND_NONE);
        }
        video = { id: "7710644811602169121", handle: "lamo.clips" };
      }
      if (p && p.by !== "you" && p.status === "posted" && p.privacy === "public") throw conflict("This clip is already on TikTok for everyone.");
      if (!p) {
        p = { postId: ulid(), clipId, platform: "tiktok", status: "posted" };
        store.posts.push(p);
        byYou.set(p.postId, null);
      } else if (p.by !== "you") byYou.set(p.postId, clone(p));
      if (p.by !== "you") {
        p.postedAt = new Date().toISOString();
        p.perfCheckAt = new Date(Date.now() + 48 * 3600_000).toISOString();
        delete p.error;
        delete p.url;
        delete p.metrics;
      }
      Object.assign(p, { status: "posted", by: "you", privacy: "public" });
      mac.marked(p);
      if (video) p.url = `https://www.tiktok.com/@${video.handle}/video/${video.id}`;
      if (c.status === "failed" || (c.status === "confirmed" && !mine.some((x) => x.status === "queued"))) c.status = "posted";
      publishClip(c);
      publishPost(p);
      return { clip: clone(c), posts: clone(store.posts.filter((x) => x.clipId === clipId)) };
    },
    async undoTikTokPosted(clipId) {
      await delay();
      const c = clip(clipId);
      const p = store.posts.find((x) => x.clipId === clipId && x.platform === "tiktok");
      if (!p || p.by !== "you") throw conflict("This clip was not marked as posted by you, so there is nothing to undo.");
      if (p.via === "mac") throw conflict(MAC_UNDO_REFUSED);
      const before = byYou.get(p.postId);
      byYou.delete(p.postId);
      if (before) {
        for (const key of Object.keys(p) as (keyof Post)[]) delete p[key];
        Object.assign(p, before);
      } else store.posts.splice(store.posts.indexOf(p), 1);
      const left = store.posts.filter((x) => x.clipId === clipId);
      if (c.status === "posted" && !left.some((x) => x.status === "posted")) c.status = left.some((x) => x.status === "failed") ? "failed" : "confirmed";
      publishClip(c);
      if (before) publishPost(p);
      return { clip: clone(c), posts: clone(left) };
    },
    // Throw away's tap (§46.13): auto-posting leaves the clip alone for a day (its Undo, and a decline that comes late);
    // Undo lets it go again.
    async holdClip(clipId) {
      await delay();
      const c = clip(clipId);
      if (c.auto) throw conflict(AUTO_ALREADY_SENT);
      if (c.status !== "review") throw conflict(ALREADY_DECIDED);
      autopost.hold(clipId);
      // The server writes the clip item (its holdUntil), so live news says it changed (§46.9).
      publishClip(c);
      return clone(c);
    },
    async unholdClip(clipId) {
      await delay();
      autopost.unhold(clipId);
      const c = store.clips.find((x) => x.clipId === clipId);
      if (c) publishClip(c);
    },
    async declineClip(clipId) {
      await delay();
      const c = clip(clipId);
      if (c.status !== "review") throw conflict(ALREADY_DECIDED);
      c.status = "declined";
      c.decidedAt = new Date().toISOString();
      c.coverUrl = undefined;
      c.videoUrl = undefined;
      publishClip(c);
      return clone(c);
    },
    ...skills.api,
    ...lessons,
    ...follows.api,
    ...crOverlay.api,
    ...refVideos.api,
    ...money.api,
    ...followers.api,
    ...pushApi(),
    async getSettings() {
      await delay();
      return clone(store.settings);
    },
    async putSettings(patch) {
      await delay(100, 240);
      const { autoPost: autoPatch, tiktokMac: macPatch, ...rest } = patch;
      const next: Settings = { ...store.settings, ...rest, hasYoutubeCookies: store.settings.hasYoutubeCookies };
      if (next.clipMin < 1 || next.clipMin > 10) throw bad("The smallest number of clips must be between 1 and 10.");
      if (next.clipMax < next.clipMin || next.clipMax > 10) throw bad("The largest number of clips must be between the smallest and 10.");
      if (next.maxSourceHours < 1 || next.maxSourceHours > 12) throw bad("Source length must be between 1 and 12 hours.");
      if (!next.platforms.every((p) => PLATFORMS.includes(p))) throw bad("Unknown platform.");
      if (!isSoundId(next.clickSound)) throw bad("Pick a click sound from 1 to 30.");
      if (!isSoundId(next.errorSound)) throw bad("Pick an error sound from 1 to 30.");
      if (next.youtubePrivacy !== undefined && !["public", "unlisted", "private"].includes(next.youtubePrivacy))
        throw bad("Pick who can see your YouTube clips.");
      // Retired by §25 (no screen reads them), still checked like the API so stored values stay valid.
      for (const [field, map] of [["earningsRates", next.earningsRates], ["earningsPaid", next.earningsPaid]] as const) {
        if (map === undefined) continue;
        if (typeof map !== "object" || map === null || Array.isArray(map)) throw bad("Money settings must list each app by name.");
        for (const [p, v] of Object.entries(map)) {
          if (!PLATFORMS.includes(p as Platform)) throw bad(`Unknown platform: ${p}.`);
          if (field === "earningsPaid" && typeof v !== "boolean") throw bad(`Say yes or no for ${p}: true or false.`);
          if (field === "earningsRates") {
            if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`Type the ${p} amount as a number, like 0.05.`);
            if (v < 0) throw bad(`The ${p} amount cannot be less than 0.`);
            if (v > RETIRED_MAX_RATE) throw bad(`The ${p} amount can be at most ${RETIRED_MAX_RATE} dollars for 1,000 views.`);
            if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw bad(`Use at most 2 numbers after the dot for ${p}, like 0.05.`);
          }
        }
        // Like the API: the usual platform order, nothing else.
        (next as unknown as Record<string, unknown>)[field] = Object.fromEntries(PLATFORMS.filter((p) => p in map).map((p) => [p, (map as Record<string, unknown>)[p]]));
      }
      if (next.setupSkipped !== undefined) {
        // Same rule as the API (§17.13): known platforms only, kept in canonical order without repeats.
        if (!Array.isArray(next.setupSkipped) || !next.setupSkipped.every((p) => PLATFORMS.includes(p))) throw bad("Unknown platform.");
        next.setupSkipped = PLATFORMS.filter((p) => next.setupSkipped!.includes(p));
        saveSkipped(next.setupSkipped);
      }
      if (next.backgroundMode !== undefined && !isBackgroundMode(next.backgroundMode)) throw bad("Pick See-through, Picture or Colours.");
      if (next.glassStrength !== undefined && !isGlassStrength(next.glassStrength)) throw bad("Pick Clear or Frosted.");
      if (next.clipModel !== undefined && !isClipModel(next.clipModel)) throw bad("Pick one of the AI models in the list.");
      // Your take: like the API, two switches and one short line (spaces tidied, at most 120 characters).
      if (next.takeOn !== undefined && typeof next.takeOn !== "boolean") throw bad("takeOn must be true or false.");
      if (next.takeVoice !== undefined && typeof next.takeVoice !== "boolean") throw bad("takeVoice must be true or false.");
      if (next.takeStyle !== undefined) {
        if (typeof next.takeStyle !== "string") throw bad("How you talk must be words.");
        next.takeStyle = tidyTakeStyle(next.takeStyle);
        if (next.takeStyle.length > TAKE_STYLE_MAX) throw bad(`How you talk can be at most ${TAKE_STYLE_MAX} letters.`);
      }
      // §24: the same ranges as the API (0 is "no limit").
      const whole = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
      if (next.followDailyMax !== undefined && !whole(next.followDailyMax, 0, 20)) throw bad("How many a day must be a number from 1 to 20.");
      if (next.notify !== undefined) {
        // §32.3: the same rule as the API: known keys only, each on or off; a missing one keeps its default.
        const n = next.notify as unknown as Record<string, unknown>;
        const keys = ["ready", "stopped", "resumed", "steps", "earn"];
        if (typeof n !== "object" || n === null || Object.keys(n).some((k) => !keys.includes(k)) || Object.values(n).some((v) => typeof v !== "boolean"))
          throw bad("Notifications must say on or off for: clips ready, stopped, picked up, every step.");
        next.notify = { ready: true, stopped: true, resumed: true, steps: false, ...(n as Partial<Settings["notify"] & object>) };
      }
      if (next.followMinMinutes !== undefined && !whole(next.followMinMinutes, 10, 240)) throw bad("The shortest video must be a number from 10 to 240 minutes.");
      if (next.followPaused !== undefined && typeof next.followPaused !== "boolean") throw bad("followPaused must be true or false.");
      if (patch.postPreset !== undefined) {
        // §36: the same check as the API (never made for kids), each platform merged over the defaults.
        const wrong = presetProblem(patch.postPreset);
        if (wrong) throw bad(wrong);
        next.postPreset = presetOf(patch.postPreset);
      }
      // §46.3: each of on, everyHours, perRun and practice merged over the stored value; on writes onAt.
      if (autoPatch !== undefined) next.autoPost = autopost.merge(store.settings.autoPost, autoPatch);
      // §47.1: { on } merged over the stored value; anything else is refused.
      if (macPatch !== undefined) {
        const m = macPatch as unknown;
        if (typeof m !== "object" || m === null || Array.isArray(m) || Object.keys(m).some((k) => k !== "on")) throw bad(MAC_UNKNOWN_SETTING);
        const on = (m as { on?: unknown }).on;
        if (on !== undefined && typeof on !== "boolean") throw bad("on must be true or false.");
        next.tiktokMac = { on: on ?? macOn(store.settings) };
      }
      if (next.backgroundColours !== undefined) {
        const c = next.backgroundColours;
        if (!Array.isArray(c) || c.length < 1 || c.length > MAX_COLOURS || !c.every(isHexColour)) throw bad("Pick 1 to 3 colours.");
        next.backgroundColours = c.map((x) => x.toLowerCase());
      }
      store.settings = next;
      saveMockLook(next);
      return clone(next);
    },
    async createCookiesUpload(_filename) {
      await delay();
      // The mock marks cookies present once the upload URL is issued; the real API checks the object.
      store.settings.hasYoutubeCookies = true;
      return { key: "private/mock-owner/youtube-cookies.txt", uploadUrl: "mock://upload", headers: { "Content-Type": "text/plain" } };
    },
    async deleteCookies() {
      await delay();
      store.settings.hasYoutubeCookies = false;
    },
    async listAccounts() {
      await delay();
      return setup.accounts();
    },
    async connectAccount(platform, grant) {
      await delay();
      // §25.4 "Allow money reading": the pretend platform approves at once and comes back to the Money page.
      if (grant === "money") return mockMoneyGrant(platform);
      // §40.6 "Allow payment reading": its own connection; the pretend Google comes straight back to Get paid.
      if (grant === "payments") {
        if (platform !== "youtube") throw bad('grant can be "money" or "payments".');
        if (!setup.get("youtube").keys.saved) throw conflict("Paste your YouTube keys first. Tap Set up YouTube.");
        return getpaid.connectPayments();
      }
      return setup.connect(platform);
    },
    async chooseAccount(platform, accountId) {
      await delay();
      return setup.choose(platform, accountId);
    },
    async disconnectAccount(platform) {
      await delay();
      setup.disconnect(platform);
    },
    async tiktokCreatorInfo() {
      await delay();
      return setup.creator();
    },
    async getSetup() {
      await delay();
      if ((faults.setupFails ?? 0) > 0) {
        faults.setupFails!--;
        throw serverDown();
      }
      return setup.overview();
    },
    async getPlatformSetup(platform) {
      await delay();
      return setup.get(platform);
    },
    async setSetupStep(platform, step, done) {
      await delay(80, 180);
      return setup.setStep(platform, step, done);
    },
    async setReviewState(review) {
      await delay(80, 180);
      return setup.setReview(review);
    },
    async saveSetupKeys(platform, keys) {
      await delay();
      return setup.saveKeys(platform, keys);
    },
    async deleteSetupKeys(platform) {
      await delay();
      setup.deleteKeys(platform);
    },
    async checkSetup(platform) {
      await delay(300, 600);
      return setup.check(platform);
    },
    async uploadVerificationFile(filename, content) {
      await delay();
      return setup.uploadFile(filename, content);
    },
    async deleteVerificationFile(filename) {
      await delay();
      setup.deleteFile(filename);
    },
    async listPosts(clipId) {
      await delay();
      return clone(store.posts.filter((p) => !clipId || p.clipId === clipId));
    },
    async insights() {
      await delay();
      return { learnings: clone(store.learnings), posts: clone(store.posts.filter((p) => p.metrics)) };
    },
    async similarClips(clipId) {
      await delay();
      const self = clip(clipId);
      if (faults.similarEmpty) return [];
      return similar(store, self);
    },
    async clipPerformance(clipId) {
      await delay();
      return stats.performance(clipId);
    },
    async refreshStats(clipId, platforms) {
      await delay(120, 260);
      return stats.refresh(clipId, platforms);
    },
    async getWeek(week, from, to) {
      await delay();
      return stats.getWeek(week, from, to);
    },
    async saveWeekBest(week, body) {
      await delay(120, 260);
      return stats.saveBest(week, body);
    },
    async autoPostStatus() {
      await delay();
      return autopost.status();
    },
    async autoPostRun(kind) {
      await delay();
      return autopost.runNow(kind);
    },
    // Your Mac posts TikTok (§47): the owner's routes; the Mac helper's are window.__cfMock.mac.
    async tiktokMacStatus() {
      await delay();
      return mac.status();
    },
    async tiktokMacLogin(action) {
      await delay();
      return mac.loginRequest(action);
    },
    async tiktokMacRequest(action) {
      await delay();
      return mac.request(action);
    },
    async sendToMac(clipIds, now) {
      await delay();
      return mac.send(clipIds, now);
    },
    async retryMac(clipId, notOnTikTok, now) {
      await delay();
      return mac.retry(clipId, notOnTikTok === true, now);
    },
    async takeBackFromMac(clipId) {
      await delay();
      return mac.takeBack(clipId);
    },
  };

  // Counts every call, so tests can prove an update came over the live connection and not from a poll.
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls[prop] = (calls[prop] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Stand-in for the S3 Vectors search (§14.6): the owner's measured clips (posted, with numbers), most alike first.
 * Same moment type counts most, then a similar score. Never the clip itself; at most five.
 */
export function similar(store: Store, self: Clip): SimilarClip[] {
  const measured = new Map<string, Post[]>();
  for (const p of store.posts) {
    if (!p.metrics) continue;
    measured.set(p.clipId, [...(measured.get(p.clipId) ?? []), p]);
  }
  return store.clips
    .filter((c) => c.clipId !== self.clipId && c.status === "posted" && measured.has(c.clipId))
    .map((c): SimilarClip => {
      const posts = measured.get(c.clipId)!;
      const sum = (k: "views" | "likes" | "comments" | "shares") => posts.reduce((n, p) => n + (p.metrics?.[k] ?? 0), 0);
      const base = c.momentType === self.momentType ? 0.91 : 0.66;
      const similarity = Math.round(Math.max(0.3, base - Math.abs(c.score - self.score) * 0.04) * 100) / 100;
      return {
        clipId: c.clipId,
        hook: c.hook,
        title: c.captions.youtubeTitle,
        momentType: c.momentType,
        similarity,
        coverUrl: c.coverUrl,
        performance: {
          views: sum("views"),
          likes: sum("likes"),
          comments: sum("comments"),
          shares: sum("shares"),
          posts: posts.length,
          checkedAt: posts.map((p) => p.metrics!.checkedAt).sort().at(-1)!,
        },
      };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);
}

