// Clips Funded mock: My Mac posts TikTok (docs/CONTRACTS.md §47.10). With the workspace's switch on
// (configuration.tiktokMac.on), Post it's TikTok target becomes a Mac job (publishingStatus "mac", its state in `mac`)
// after the same account checks as today; a TikTok post the API made Only me is handed over in place, so the story
// keeps one TikTok row. Nothing posts it by itself: a test plays the owner's Mac through
// window.__cfStoriesMock.mac (ping, claim, beat, step, done, stopped, age), with the API's rules (CONTRACTS §47.10.4):
// the first press is kept, after a press a stop says PRESSED, done's link must be on the job's own account, Try again
// waits for the find window, It's on TikTok only once the Mac isn't working on it. A stopped Mac post joins Needs you.
// Knobs (window.__cfStoriesMock.knobs, before the app loads): macOn (the switch on), macHelper (true, or a helper's
// fields: a Mac that checked in), macConnected (Clips Funded's TikTok connected).
import { ApiError } from "../../../api/errors.ts";
import type { ErrorAccount, MacStep, PublishingJob, PubJobMac, PublishTarget, SocialAccount, StoriesApi, StoriesDashboard, WsMacHelper, WsMacJob, WsMacStatus } from "../types.ts";
import * as dashboardPart from "./dashboard.ts";
import * as publishingPart from "./publishing.ts";
import { sameAsClips } from "./social.ts";
import { delay, mockId, type MockStore } from "./store.ts";
import { storiesWorkspace } from "./workspace.ts";

export const KEYS = ["macStatus", "macLogin", "macResume", "macRetry", "macPosted", "publish", "retryPublishing", "dashboard"] as const;

/** The API's MAC_WS_FROM (workspaces/mac.py): an older helper never takes a Clips Funded post. */
export const MAC_WS_FROM = "1.2.0";
const BEAT_STALE = 5 * 60_000;
const CLAIM_MAX = 50 * 60_000;
const FIND_WINDOW = 30 * 60_000;

// The API's words (§47.10.3, §47.10.4), word for word.
export const NO_HANDLE = "Connect TikTok again in Social accounts, so your Mac knows the account.";
export const CLASH = "This story is already being posted to TikTok.";
export const MAC_ONE = "Your Mac posts this one. Tap Try again on its row.";
export const NOT_MAC = "Your Mac isn't posting this one.";
export const WORKING = "Your Mac is posting it right now. Wait a minute.";
export const MAY_HAVE_POSTED = "Your Mac may have posted it already. Check your TikTok first.";
export const STILL_LOOKING = "Your Mac pressed Post less than 30 minutes ago. Look on your TikTok first, then try again later.";
export const WRONG_ACCOUNT = "That post is on another TikTok account.";
export const BAD_LINK = "Paste the video's full TikTok link: tiktok.com/@name/video/…";
export const NOT_PRESSED = "Your Mac stopped before it pressed Post, so it isn't on TikTok. Tap Try again.";
export const PRESSED = "Your Mac pressed Post but couldn't confirm it. Look on your TikTok: if it's there, tap It's on TikTok.";
export const UPDATE_FIRST = "Update the helper on your Mac first.";
export const NOT_PAUSED = "Your Mac isn't paused.";

const HANDLE = /^@[A-Za-z0-9._]{2,30}$/;
const LINK = /^https:\/\/(www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,30})\/video\/(\d{8,25})/;

/** What the mock keeps beside each Mac job and helper (the API's own fields the web never reads). */
interface MacSide {
  attempt: number;
  device?: string;
  beforeMac?: PublishingJob;
}
interface MacMock {
  helpers: Map<string, WsMacHelper>;
  side: Map<string, MacSide>;
}
const mocks = new WeakMap<MockStore, MacMock>();
function mockOf(store: MockStore): MacMock {
  let m = mocks.get(store);
  if (!m) {
    m = { helpers: new Map(), side: new Map() };
    mocks.set(store, m);
  }
  return m;
}

const copy = <T>(v: T): T => structuredClone(v);
const nowIso = () => new Date().toISOString();
/** A 409 as the client hands it on (a code it does not know, such as wrong_account, reads as conflict). */
const conflict = (message: string) => new ApiError(409, "conflict", message);

function newer(v: string | undefined, from = MAC_WS_FROM): boolean {
  const a = (v ?? "").split(".").map(Number);
  const b = from.split(".").map(Number);
  if (a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

function tiktokOf(store: MockStore, ws: string): SocialAccount | undefined {
  return store.social.find((a) => a.workspaceId === ws && a.platform === "tiktok");
}

function macOn(store: MockStore, ws: string): boolean {
  return storiesWorkspace(store, ws).configuration.tiktokMac?.on === true;
}

export function seed(_store: MockStore): void {}

/** Once every part has seeded: the knobs' switch, Mac and TikTok account. */
export function afterSeed(store: MockStore): void {
  const ws = "stories";
  const w = store.workspaces.find((x) => x.workspaceId === ws);
  if (store.knobs.macOn === true && w && w.workspaceType === "stories") (w.configuration as { tiktokMac?: { on: boolean } }).tiktokMac = { on: true };
  const a = tiktokOf(store, ws);
  if (store.knobs.macConnected === true && a) Object.assign(a, { connectionStatus: "connected", reason: null, warning: null });
  const h = store.knobs.macHelper;
  if (h) mockOf(store).helpers.set(ws, { seenAt: nowIso(), state: "ok", version: MAC_WS_FROM, setUp: true, handle: a?.handle ?? undefined, ...(typeof h === "object" ? (h as Partial<WsMacHelper>) : {}) });
}

function macJobs(store: MockStore, ws: string): PublishingJob[] {
  return store.publishing.filter((j) => j.workspaceId === ws && j.publishingStatus === "mac");
}

const beatOf = (m: PubJobMac) => Date.parse(m.beatAt ?? m.claimedAt ?? "");
function stuck(m: PubJobMac, now = Date.now()): boolean {
  if (m.state !== "working") return false;
  const beat = beatOf(m);
  const claimed = Date.parse(m.claimedAt ?? "");
  return (Number.isFinite(beat) && now - beat >= BEAT_STALE) || (Number.isFinite(claimed) && now - claimed >= CLAIM_MAX);
}

/** The Mac's queue: waiting or working, oldest first, at most 50 (empty while off). */
function queueOf(store: MockStore, ws: string): WsMacJob[] {
  if (!macOn(store, ws)) return [];
  return macJobs(store, ws)
    .filter((j) => j.mac && (j.mac.state === "waiting" || j.mac.state === "working"))
    .sort((a, b) => a.mac!.since.localeCompare(b.mac!.since))
    .slice(0, 50)
    .map((j) => {
      const story = store.stories.find((s) => s.storyId === j.contentId);
      const m = j.mac!;
      const slug = (story?.title ?? "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
      return {
        workspaceId: ws,
        publishingJobId: j.publishingJobId,
        storyId: j.contentId,
        hook: story?.title ?? "",
        caption: (story as { postCaptions?: { tiktok?: string } } | undefined)?.postCaptions?.tiktok ?? story?.title ?? "",
        fileName: `clips-funded-${slug}.mp4`,
        account: { handle: j.handle ?? "", openId: j.externalAccountId ?? "" },
        aiLabel: true,
        privacy: "PUBLIC_TO_EVERYONE",
        comment: true,
        duet: true,
        stitch: true,
        source: "upload",
        since: m.since,
        state: m.state,
        ...(m.step ? { step: m.step } : {}),
        ...(m.claimedAt ? { claimedAt: m.claimedAt } : {}),
        ...(m.pressedAt ? { pressedAt: m.pressedAt } : {}),
        ...(m.beatAt ? { beatAt: m.beatAt } : {}),
        attempt: mockOf(store).side.get(j.publishingJobId)?.attempt ?? 0,
        ...(m.pressedBefore ? { pressedBefore: m.pressedBefore } : {}),
        ...(m.againAt ? { againAt: m.againAt } : {}),
      } satisfies WsMacJob;
    });
}

/** Turns a stored job into the Mac's, waiting (§2.1 item 1). */
function makeMac(store: MockStore, j: PublishingJob, a: SocialAccount | undefined, before?: PublishingJob): void {
  const at = nowIso();
  Object.assign(j, {
    publishingStatus: "mac",
    mac: { state: "waiting", since: at },
    accountName: a?.accountName ?? j.accountName,
    handle: a?.handle ?? j.handle ?? null,
    externalAccountId: a?.externalAccountId ?? j.externalAccountId ?? null,
    updatedAt: at,
  } satisfies Partial<PublishingJob>);
  delete j.error;
  delete j.url;
  delete j.postedAt;
  delete j.metrics;
  delete j.via;
  delete j.by;
  delete j.onlyMe;
  j.waitingUntil = null;
  j.waiting = null;
  mockOf(store).side.set(j.publishingJobId, { attempt: 0, ...(before ? { beforeMac: before } : {}) });
}

function accountConflict(message: string, a: SocialAccount): ApiError {
  const account: ErrorAccount = { externalAccountId: a.externalAccountId ?? "", accountName: a.accountName, handle: a.handle };
  return Object.assign(conflict(message), { account });
}

/** The job's story is posted on TikTok now (the API's story_posted): its posted list and the ACT# item. */
function storyPosted(store: MockStore, j: PublishingJob): void {
  const story = store.stories.find((s) => s.storyId === j.contentId);
  if (story && (story.status === "approved" || story.status === "published")) {
    story.status = "published";
    story.publishedAt = story.publishedAt ?? j.postedAt;
    story.posted = [...story.posted.filter((p) => p.platform !== "tiktok"), ...(j.url ? [{ platform: "tiktok" as const, url: j.url }] : [])];
    story.updatedAt = j.postedAt ?? nowIso();
  }
  store.activity.unshift({ at: j.postedAt ?? nowIso(), kind: "posted", storyId: j.contentId, title: story?.title ?? "A story", platform: "tiktok" });
}

function posted(store: MockStore, j: PublishingJob, link: string | null, who: "mac" | "you"): void {
  const at = nowIso();
  const m = LINK.exec(link ?? "");
  j.publishingStatus = "posted";
  j.postedAt = at;
  j.updatedAt = at;
  if (m) j.url = `https://www.tiktok.com/@${m[2]}/video/${m[3]}`;
  else delete j.url;
  delete j.mac;
  delete j.onlyMe;
  delete j.error;
  if (who === "mac") j.via = "mac";
  else j.by = "you";
  storyPosted(store, j);
}

/** A link on the job's own account; the API's 400 when it isn't a TikTok video link, its 409 when it is another
 * account's (nothing written either way). */
function checkLink(j: PublishingJob, link: string): void {
  const m = LINK.exec(link);
  const own = (j.handle ?? "").replace(/^@/, "").toLowerCase();
  if (!m) throw new ApiError(400, "bad_request", BAD_LINK);
  if (m[2]!.toLowerCase() !== own) throw conflict(WRONG_ACCOUNT);
}

function clearNeedsYou(store: MockStore, ws: string, jobId: string): void {
  const h = mockOf(store).helpers.get(ws);
  if (h?.needsYouJobId === jobId) {
    delete h.needsYouJobId;
    delete h.needsYouStoryId;
    if (h.state === "needs_you") {
      h.state = "ok";
      delete h.reason;
    }
  }
}

function findMac(store: MockStore, ws: string, id: string): PublishingJob {
  const j = store.publishing.find((p) => p.publishingJobId === id && p.workspaceId === ws);
  if (!j) throw new ApiError(404, "not_found", "We could not find that post.");
  return j;
}

/** The owner's Mac, played by a test (window.__cfStoriesMock.mac): the helper's own routes, on the store. */
export function macKnobs(store: MockStore, ws = "stories") {
  const pick = (id?: string, states: PubJobMac["state"][] = ["waiting", "working", "stopped"]): PublishingJob => {
    const list = macJobs(store, ws).filter((j) => j.mac && states.includes(j.mac.state));
    const j = id ? list.find((x) => x.publishingJobId === id) : [...list].sort((a, b) => a.mac!.since.localeCompare(b.mac!.since))[0];
    if (!j) throw new Error("No Mac post to work on.");
    return j;
  };
  const touch = (j: PublishingJob) => {
    j.updatedAt = nowIso();
  };
  return {
    /** A check-in; a ping that isn't needs_you clears the stopped post, one whose loginDone (resumeDone) matches
     * clears the login (the Start my Mac again). */
    ping(patch: Partial<WsMacHelper> & { loginDone?: string; resumeDone?: string } = {}): WsMacHelper {
      const before = mockOf(store).helpers.get(ws);
      const { loginDone, resumeDone, ...rest } = patch;
      const h: WsMacHelper = { ...(before ?? { state: "ok", setUp: true, version: MAC_WS_FROM, handle: tiktokOf(store, ws)?.handle ?? undefined }), ...rest, seenAt: rest.seenAt ?? nowIso() };
      if (h.state !== "needs_you") {
        delete h.needsYouJobId;
        delete h.needsYouStoryId;
        if (!rest.reason) delete h.reason;
      }
      if (loginDone && h.loginRequest?.at === loginDone) delete h.loginRequest;
      if (resumeDone && h.resumeRequest?.at === resumeDone) delete h.resumeRequest;
      mockOf(store).helpers.set(ws, h);
      return copy(h);
    },
    /** Takes the oldest waiting post (or `id`): working, step video. */
    claim(id?: string): PublishingJob {
      const j = pick(id, ["waiting", "working"]);
      const m = j.mac!;
      if (!macOn(store, ws)) throw conflict("My Mac posts TikTok is off in Clips Funded.");
      if (m.state === "working" && !stuck(m)) throw conflict(WORKING);
      if (m.pressedAt) throw conflict(MAY_HAVE_POSTED);
      const at = nowIso();
      Object.assign(m, { state: "working", claimedAt: at, beatAt: at, step: "video" });
      const side = mockOf(store).side.get(j.publishingJobId) ?? { attempt: 0 };
      side.attempt += 1;
      side.device = "Mock Mac";
      mockOf(store).side.set(j.publishingJobId, side);
      touch(j);
      return copy(j);
    },
    beat(id?: string): PublishingJob {
      const j = pick(id, ["working"]);
      j.mac!.beatAt = nowIso();
      touch(j);
      return copy(j);
    },
    /** A step (the same step again is the beat); the first `pressing` keeps its time. */
    step(step: MacStep, id?: string): PublishingJob {
      const j = pick(id, ["working"]);
      const m = j.mac!;
      if (!macOn(store, ws) && !m.pressedAt) throw conflict("My Mac posts TikTok is off in Clips Funded.");
      m.step = step;
      m.beatAt = nowIso();
      if (step === "pressing" && !m.pressedAt) m.pressedAt = m.beatAt;
      touch(j);
      return copy(j);
    },
    /** Posted: a link on the job's own account (another account answers 409, nothing written). */
    done(id?: string, link?: string): PublishingJob {
      const j = pick(id, ["working"]);
      const handle = (j.handle ?? "@funded.clips").replace(/^@/, "");
      const url = link ?? `https://www.tiktok.com/@${handle}/video/${String(Date.now()).padEnd(19, "7")}`;
      checkLink(j, url);
      posted(store, j, url, "mac");
      clearNeedsYou(store, ws, j.publishingJobId);
      return copy(j);
    },
    /** Stopped: after a press the reason is PRESSED; `needsYou` also sets the workspace's Mac to needs_you. */
    stopped(reason: string, needsYou = false, id?: string): PublishingJob {
      const j = pick(id, ["working", "waiting"]);
      const m = j.mac!;
      const at = nowIso();
      Object.assign(m, { state: "stopped", stoppedAt: at, reason: m.pressedAt ? PRESSED : reason });
      if (needsYou) {
        const h = mockOf(store).helpers.get(ws) ?? { seenAt: at, state: "ok", setUp: true, version: MAC_WS_FROM };
        mockOf(store).helpers.set(ws, { ...h, state: "needs_you", reason, needsYouJobId: j.publishingJobId, needsYouStoryId: j.contentId });
      }
      touch(j);
      return copy(j);
    },
    /** Moves the post's times `ms` into the past (a stuck claim, a find window that is over). */
    age(ms: number, id?: string): PublishingJob {
      const j = pick(id);
      const m = j.mac!;
      const back = (iso: string | undefined) => (iso ? new Date(Date.parse(iso) - ms).toISOString() : iso);
      for (const k of ["since", "claimedAt", "beatAt", "pressedAt", "stoppedAt"] as const) if (m[k]) (m as unknown as Record<string, string | undefined>)[k] = back(m[k]);
      return copy(j);
    },
    /** The workspace's Mac as it last checked in, or null. */
    helper(): WsMacHelper | null {
      return copy(mockOf(store).helpers.get(ws) ?? null);
    },
  };
}

export type MacKnobs = ReturnType<typeof macKnobs>;

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const base = publishingPart.api(store);
  const dash = dashboardPart.api(store);
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfStoriesMock?: Record<string, unknown> };
    if (w.__cfStoriesMock) w.__cfStoriesMock.mac = macKnobs(store);
  }
  return {
    async publish(ws, storyId, targets: PublishTarget[]) {
      const tt = targets.find((t) => t.platform === "tiktok");
      if (!tt || !macOn(store, ws)) return base.publish(ws, storyId, targets);
      const a = tiktokOf(store, ws);
      if (a?.connectionStatus === "connected" && !HANDLE.test(a.handle ?? "")) {
        await delay(200);
        throw conflict(NO_HANDLE);
      }
      const mine = store.publishing.filter((j) => j.workspaceId === ws && j.contentId === storyId && j.platform === "tiktok");
      if (mine.some((j) => j.publishingStatus === "mac" || j.publishingStatus === "queued" || j.publishingStatus === "publishing")) {
        await delay(200);
        throw conflict(CLASH);
      }
      // Every check as today (the account at the tap, the owner's yes): the publishing part sends it, then its TikTok
      // job is the Mac's. An API post made Only me is handed over in place: the story keeps one TikTok row.
      const made = await base.publish(ws, storyId, targets);
      const onlyMe = mine.find((j) => j.publishingStatus === "posted" && j.onlyMe === true && !j.via && !j.by);
      return made.map((sent) => {
        if (sent.platform !== "tiktok" || sent.publishingStatus !== "queued") return sent;
        const stored = store.publishing.findIndex((j) => j.publishingJobId === sent.publishingJobId);
        const fresh = store.publishing[stored]!;
        // The publishing part's walk never finds it again (it looks by its id).
        store.publishing.splice(stored, 1);
        if (onlyMe) {
          const before = copy(onlyMe);
          makeMac(store, onlyMe, a, before);
          return copy(onlyMe);
        }
        const j: PublishingJob = { ...copy(fresh), publishingJobId: mockId() };
        makeMac(store, j, a);
        store.publishing.unshift(j);
        return copy(j);
      });
    },
    async retryPublishing(ws, publishingJobId, body) {
      const j = store.publishing.find((p) => p.publishingJobId === publishingJobId && p.workspaceId === ws);
      if (j?.publishingStatus === "mac") {
        await delay(200);
        throw conflict(MAC_ONE);
      }
      if (!j || j.platform !== "tiktok" || !macOn(store, ws) || (j.publishingStatus !== "failed" && j.publishingStatus !== "needs_attention"))
        return base.retryPublishing(ws, publishingJobId, body);
      await delay(220);
      // The API's retry while the Mac posts TikTok: the same post becomes the Mac's, in place (no flow starts).
      const a = tiktokOf(store, ws);
      if (!a || a.connectionStatus !== "connected" || sameAsClips(a, store)) return base.retryPublishing(ws, publishingJobId, body);
      if (j.externalAccountId && a.externalAccountId !== j.externalAccountId && body?.confirmAccount !== a.externalAccountId)
        throw accountConflict(`Clips Funded's TikTok is a different account now: this TikTok account${a.accountName ? ` (${a.accountName})` : ""}. Tap Yes if that is right.`, a);
      if (!HANDLE.test(a.handle ?? "")) throw conflict(NO_HANDLE);
      makeMac(store, j, a);
      return copy(j);
    },
    async macStatus(ws): Promise<WsMacStatus> {
      await delay(140);
      const on = macOn(store, ws);
      const a = tiktokOf(store, ws);
      return {
        on,
        helper: copy(mockOf(store).helpers.get(ws) ?? null),
        account: a ? { handle: a.handle, accountName: a.accountName, status: a.connectionStatus } : null,
        queue: queueOf(store, ws),
      };
    },
    async macLogin(ws) {
      await delay(200);
      storiesWorkspace(store, ws);
      const h = mockOf(store).helpers.get(ws);
      if (!h || !newer(h.version)) throw conflict(UPDATE_FIRST);
      h.loginRequest = { at: nowIso() };
      return { helper: copy(h) };
    },
    async macResume(ws) {
      await delay(200);
      storiesWorkspace(store, ws);
      const h = mockOf(store).helpers.get(ws);
      if (!h || !newer(h.version)) throw conflict(UPDATE_FIRST);
      if (h.state !== "paused") throw conflict(NOT_PAUSED);
      h.resumeRequest = { at: nowIso() };
      return { helper: copy(h) };
    },
    async macRetry(ws, publishingJobId, body = {}) {
      await delay(220);
      storiesWorkspace(store, ws);
      const j = findMac(store, ws, publishingJobId);
      const m = j.mac;
      if (j.publishingStatus !== "mac" || !m) throw conflict(NOT_MAC);
      if (m.state === "working" && !stuck(m)) throw conflict(WORKING);
      if (m.state === "waiting") return copy(j); // it already waits
      if (m.pressedAt && !body.notOnTikTok) throw conflict(MAY_HAVE_POSTED);
      if (m.pressedAt && Date.now() - Date.parse(m.pressedAt) < FIND_WINDOW) throw conflict(STILL_LOOKING);
      const a = tiktokOf(store, ws);
      if (a && a.externalAccountId && j.externalAccountId && a.externalAccountId !== j.externalAccountId) {
        if (body.confirmAccount !== a.externalAccountId)
          throw accountConflict(`Clips Funded's TikTok is a different account now: this TikTok account${a.accountName ? ` (${a.accountName})` : ""}. Tap Yes if that is right.`, a);
        Object.assign(j, { externalAccountId: a.externalAccountId, handle: a.handle, accountName: a.accountName });
      }
      const at = nowIso();
      j.mac = { state: "waiting", since: m.since, againAt: at, ...(m.pressedAt ? { pressedBefore: m.pressedAt } : m.pressedBefore ? { pressedBefore: m.pressedBefore } : {}) };
      j.updatedAt = at;
      clearNeedsYou(store, ws, j.publishingJobId);
      return copy(j);
    },
    async macPosted(ws, publishingJobId, body) {
      await delay(220);
      storiesWorkspace(store, ws);
      const j = findMac(store, ws, publishingJobId);
      const link = "link" in body ? body.link.trim() : null;
      if (link === null && (!("noLink" in body) || body.noLink !== true)) throw new ApiError(400, "bad_request", "Paste the TikTok link, or say there is none.");
      if (link !== null) checkLink(j, link);
      // Marked already (his other tap, or the Mac's done): a link only changes its link.
      if (j.publishingStatus === "posted" && (j.by === "you" || j.via === "mac")) {
        const m = LINK.exec(link ?? "");
        if (m) j.url = `https://www.tiktok.com/@${m[2]}/video/${m[3]}`;
        return copy(j);
      }
      const m = j.mac;
      if (j.publishingStatus !== "mac" || !m) throw conflict(NOT_MAC);
      if (m.state === "working" && !stuck(m)) throw conflict(WORKING);
      // Without a link, never a post the Mac works on and never pressed Post for: it isn't on TikTok.
      if (m.state === "working" && link === null && !m.pressedAt) throw conflict(Date.now() - beatOf(m) < BEAT_STALE ? WORKING : NOT_PRESSED);
      posted(store, j, link, "you");
      clearNeedsYou(store, ws, j.publishingJobId);
      return copy(j);
    },
    async dashboard(ws): Promise<StoriesDashboard> {
      const d = await dash.dashboard(ws);
      const title = (id: string) => store.stories.find((s) => s.storyId === id)?.title ?? "A story";
      const stopped = macJobs(store, ws)
        .filter((j) => j.mac?.state === "stopped")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((j) => ({
          publishingJobId: j.publishingJobId,
          storyId: j.contentId,
          title: title(j.contentId),
          platform: "tiktok" as const,
          sentence: j.mac!.reason ?? "Your Mac stopped. Tap Try again.",
          href: `/stories/review/${encodeURIComponent(j.contentId)}`,
          publishingStatus: "mac" as const,
          mac: copy(j.mac!),
        }));
      return { ...d, needsYou: [...stopped, ...d.needsYou], counts: { ...d.counts, needsYou: d.counts.needsYou + stopped.length } };
    },
  };
}
