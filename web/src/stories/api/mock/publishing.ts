// Lamo Stories mock: the publishing part (docs/CONTRACTS.md §45.14, §45.16.8). The seed has a publishing job in every
// status (queued, publishing, posted with numbers, failed, needs_attention) on the stories that are approved or
// published. Publish and Try again check the destination like validate_destination: only this workspace's connected
// account, never a default; anything else stops the job with needs_attention and a plain sentence. Each job carries
// the exact account (accountName, handle, externalAccountId). As in the API (§45.34), a TikTok Lamo Stories cannot tell
// from Clip Factory's own (reason clips_unknown, or the knob tiktokUnsure) answers 409 naming the account until the owner
// sends confirmAccount for it (asked once per identity), and Try again on a post whose account changed answers 409
// naming the new account until confirmAccount matches it. The 409 carries `account` on its ApiError, like the client.
// The sentences call the other app "Clip Factory" and name an account by its place first ("this TikTok account (Lamo
// Stories)"), so they read right when the account is itself called Lamo Stories; a question says "Tap Yes", as its
// button does (§45.36 E13). On Clip Factory's shared developer app, Clip Factory's posts always go first (§45.37 G6):
// with no room left (knob `clipsFirst`) a post waits in its queue with `waitingUntil` (the window's reset) and the API's
// line `waiting` (publish.public_job), and goes out by itself after it. Clip Factory's own account is refused before every post, also when Clip Factory connected it later.
import { ApiError } from "../../../api/errors.ts";
import { STORIES_PLATFORMS, type ErrorAccount, type Platform, type PublishingJob, type PublishTarget, type SocialAccount, type StoriesApi, type Story } from "../types.ts";
import { PLATFORM_NAME, sameAsClips } from "./social.ts";
import { ago, delay, HOUR, mockId, type MockStore } from "./store.ts";
import { storiesWorkspace } from "./workspace.ts";

export const KEYS = ["publish", "listPublishing", "retryPublishing"] as const;

export function seed(_store: MockStore): void {}

function job(story: Story, platform: Platform, status: PublishingJob["publishingStatus"], hoursAgo: number, extra: Partial<PublishingJob> = {}): PublishingJob {
  const at = ago(hoursAgo * HOUR);
  return {
    publishingJobId: mockId(),
    workspaceId: story.workspaceId,
    contentId: story.storyId,
    socialAccountId: `${story.workspaceId}.${platform}`,
    platform,
    publishingStatus: status,
    accountName: null,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

const POST_URL: Record<Platform, (id: string) => string> = {
  youtube: (id) => `https://www.youtube.com/shorts/${id.slice(0, 11)}`,
  tiktok: (id) => `https://www.tiktok.com/@lamo.stories/video/${id.length}${Date.now()}`,
  instagram: (id) => `https://www.instagram.com/reel/${id.slice(0, 11)}/`,
  facebook: (id) => `https://www.facebook.com/reel/${id.length}${Date.now()}`,
  x: (id) => `https://x.com/lamostories/status/${id.length}${Date.now()}`,
};

/** Once every part has seeded: posts for the published story and the approved one (whoever seeded them). */
export function afterSeed(store: MockStore): void {
  if (store.publishing.length) return;
  const published = store.stories.find((s) => s.status === "published");
  const approved = store.stories.find((s) => s.status === "approved");
  const name = (p: Platform) => store.social.find((a) => a.platform === p && a.workspaceId === (published ?? approved)?.workspaceId)?.accountName ?? null;
  const at = (p: Platform) => where(store.social.find((a) => a.platform === p && a.workspaceId === (published ?? approved)?.workspaceId));
  if (published) {
    const postedAt = published.publishedAt ?? ago(58 * HOUR);
    const url = POST_URL.youtube(published.storyId);
    store.publishing.push(
      job(published, "youtube", "posted", 58, {
        ...at("youtube"),
        accountName: name("youtube"),
        url,
        postedAt,
        metrics: { views: 1520, likes: 214, comments: 18, shares: 9, checkedAt: ago(10 * HOUR) },
      }),
      job(published, "tiktok", "needs_attention", 57, {
        ...at("tiktok"),
        accountName: name("tiktok"),
        error: "This TikTok account (Lamo Stories) needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.",
      }),
      job(published, "facebook", "failed", 57, { accountName: "Lamo Stories", error: "Facebook did not answer. Tap Try again in a few minutes." }),
    );
    if (!published.posted.some((p) => p.platform === "youtube")) published.posted.push({ platform: "youtube", url });
  }
  if (approved) {
    store.publishing.push(
      job(approved, "youtube", "publishing", 0.1, { ...at("youtube"), accountName: name("youtube") }),
      job(approved, "instagram", "queued", 0.05, { accountName: null }),
      job(approved, "x", "needs_attention", 0.1, {
        ...at("x"),
        accountName: name("x"),
        error: "This X account is the one Clip Factory posts to. Pick another in Lamo Stories › Social accounts, then tap Try again.",
      }),
    );
  }
}

/** "This TikTok account (Lamo Stories)": an account by its place first (§45.36 E13). */
function thisAccount(platform: Platform, name: string | null | undefined): string {
  return `this ${PLATFORM_NAME[platform]} account${name ? ` (${name})` : ""}`;
}

const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The check at the tap (§45.14): the account must be this workspace's own, connected, and not Clip Factory's own. */
function stopReason(store: MockStore, ws: string, platform: Platform): string | null {
  const a = store.social.find((s) => s.workspaceId === ws && s.platform === platform);
  const name = PLATFORM_NAME[platform];
  if (!a || a.connectionStatus === "not_connected") return `Lamo Stories' ${name} is not connected. Connect it in Lamo Stories › Social accounts, then tap Try again.`;
  if (a.connectionStatus === "needs_reconnect") return `${upper(thisAccount(platform, a.accountName))} needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.`;
  if (a.connectionStatus === "choose_account") return `Pick which ${name} account Lamo Stories posts to in Lamo Stories › Social accounts, then tap Try again.`;
  // Before every upload too (§45.37 G8): Clip Factory's own account, also when Clip Factory connected it later.
  if (sameAsClips(a, store)) return `${upper(thisAccount(platform, a.accountName))} is the one Clip Factory posts to. Pick another in Lamo Stories › Social accounts, then tap Try again.`;
  return null;
}

/**
 * When Clip Factory's shared developer app has room again for this platform (§45.37 G6): YouTube's Google project
 * resets each day at midnight Pacific time, TikTok's per-app limits each day, X's credits each month. The mock's
 * nearest such time (a test can pin it with `store.knobs.clipsFirstUntil`).
 */
export function nextReset(platform: Platform, now = new Date()): string {
  const d = new Date(now);
  if (platform === "x") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  // Midnight Pacific is 08:00 UTC (07:00 in summer: the mock keeps 08:00); TikTok's day is UTC.
  const hour = platform === "youtube" ? 8 : 0;
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour));
  if (at.getTime() <= now.getTime()) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

/**
 * Whether a post on Clip Factory's shared app waits (§45.37 G6): Clip Factory's posts always go first, so when what
 * is left for Clip Factory Stories is used up (knob `clipsFirst`: true or a list of platforms) the post waits in its
 * queue until the window resets, then goes out by itself. Never on Clip Factory Stories' own app.
 */
function waitFor(store: MockStore, j: PublishingJob): string | null {
  const a = store.social.find((s) => s.workspaceId === j.workspaceId && s.platform === j.platform);
  if (!a || a.app.choice !== "clips") return null;
  const full = store.knobs.clipsFirst;
  if (!(full === true || (Array.isArray(full) && full.includes(j.platform)))) return null;
  // Its window reset: there is room again.
  if (j.waitingUntil && Date.parse(j.waitingUntil) <= Date.now()) return null;
  return j.waitingUntil ?? (typeof store.knobs.clipsFirstUntil === "string" ? store.knobs.clipsFirstUntil : nextReset(j.platform));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The API's waiting line (shared_room.waiting_line): "Waiting: Clip Factory's posts go first. Posts at 23 Nov 08:00 UTC." */
export function waitingWords(until: string): string {
  const d = new Date(until);
  const two = (n: number) => String(n).padStart(2, "0");
  const at = Number.isNaN(d.getTime()) ? until : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  return `Waiting: Clip Factory's posts go first. Posts at ${at}.`;
}

/** A started job walks queued → publishing → posted (or stops), a few seconds a step, like the story flow. */
function run(store: MockStore, id: string): void {
  const step = (fn: (j: PublishingJob) => void, ms: number, then?: () => void) =>
    setTimeout(() => {
      const j = store.publishing.find((p) => p.publishingJobId === id);
      if (!j) return;
      fn(j);
      j.updatedAt = new Date().toISOString();
      then?.();
    }, ms);
  const fast = (store.knobs.publishMs as number | undefined) ?? 2500;
  let waits: string | null = null;
  step(
    (j) => {
      const stop = stopReason(store, j.workspaceId, j.platform);
      waits = stop ? null : waitFor(store, j);
      if (stop) {
        j.publishingStatus = "needs_attention";
        j.error = stop;
        j.waitingUntil = null;
        j.waiting = null;
      } else if (waits) {
        // Waiting in its queue, saying until when; never failed, never taking Clip Factory's share.
        j.publishingStatus = "queued";
        j.waitingUntil = waits;
        j.waiting = waitingWords(waits);
      } else {
        j.publishingStatus = "publishing";
        j.waitingUntil = null;
        j.waiting = null;
      }
    },
    fast,
    () => {
      // After the reset it goes out by itself: the same walk again, from the account check.
      if (waits) {
        setTimeout(() => run(store, id), Math.min(Math.max(0, Date.parse(waits) - Date.now()), 2_147_000_000));
        return;
      }
      step((j) => {
        if (j.publishingStatus !== "publishing") return;
        j.publishingStatus = "posted";
        j.postedAt = new Date().toISOString();
        j.url = POST_URL[j.platform](j.publishingJobId);
        delete j.error;
        const story = store.stories.find((s) => s.storyId === j.contentId);
        if (story && (story.status === "approved" || story.status === "published")) {
          story.status = "published";
          story.publishedAt = story.publishedAt ?? j.postedAt;
          story.posted = [...story.posted.filter((p) => p.platform !== j.platform), { platform: j.platform, url: j.url }];
          story.updatedAt = j.postedAt;
        }
        store.activity.unshift({ at: j.postedAt, kind: "posted", storyId: j.contentId, title: story?.title ?? "A story", platform: j.platform });
      }, fast);
    },
  );
}

const copy = <T>(v: T): T => structuredClone(v);

/** The TikTok identities the owner said are Lamo Stories' own (SOCIAL#tiktok.notClipsConfirmed). */
const confirmed = new WeakMap<MockStore, Set<string>>();
function confirmedOf(store: MockStore): Set<string> {
  let c = confirmed.get(store);
  if (!c) {
    c = new Set();
    confirmed.set(store, c);
  }
  return c;
}

/** A 409 that names the account, as Lamo Stories' client hands it to the screens (`error.account`). */
function accountConflict(message: string, a: SocialAccount): ApiError {
  const account: ErrorAccount = { externalAccountId: a.externalAccountId ?? "", accountName: a.accountName, handle: a.handle };
  return Object.assign(new ApiError(409, "conflict", message), { account });
}

/** Rule 5's TikTok case: Lamo Stories cannot tell this account from Clip Factory's own until the owner says it once. */
function unsure(store: MockStore, a: SocialAccount | undefined, confirm: string | undefined): ApiError | null {
  if (!a || a.platform !== "tiktok" || a.connectionStatus !== "connected" || !a.externalAccountId) return null;
  if (a.reason !== "clips_unknown" && store.knobs.tiktokUnsure !== true) return null;
  if (confirmedOf(store).has(a.externalAccountId)) return null;
  if (confirm === a.externalAccountId) {
    confirmedOf(store).add(a.externalAccountId);
    return null;
  }
  // A raw open_id never goes in the sentence (§45.36 E14): "this TikTok account" when it has no name or handle.
  const name = a.accountName ?? a.handle ?? null;
  return accountConflict(`Lamo Stories cannot tell if ${thisAccount("tiktok", name)} is the one Clip Factory posts to. Tap Yes if it is your Lamo Stories TikTok.`, a);
}

function changed(a: SocialAccount): ApiError {
  // Its name or handle, never a raw channel id (§45.36 E14), as the API's _changed_account.
  const name = a.accountName ?? a.handle ?? null;
  return accountConflict(`Lamo Stories' ${PLATFORM_NAME[a.platform]} is a different account now: ${thisAccount(a.platform, name)}. Tap Yes if that is right.`, a);
}

/** The exact account a job goes to (§45.34). */
function where(a: SocialAccount | undefined): Pick<PublishingJob, "accountName" | "handle" | "externalAccountId"> {
  return { accountName: a?.accountName ?? null, handle: a?.handle ?? null, externalAccountId: a?.externalAccountId ?? null };
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async publish(ws, storyId, targets: PublishTarget[]) {
      await delay(260);
      storiesWorkspace(store, ws);
      const story = store.stories.find((s) => s.storyId === storyId && s.workspaceId === ws);
      if (!story) throw new ApiError(404, "not_found", "We could not find that story.");
      if (story.status !== "approved" && story.status !== "published") throw new ApiError(409, "conflict", "Approve the video first, then post it.");
      if (!targets.length || targets.length > 5) throw new ApiError(400, "bad_request", "Pick where to post it.");
      const seen = new Set<Platform>();
      for (const t of targets) {
        if (!STORIES_PLATFORMS.includes(t.platform) || seen.has(t.platform)) throw new ApiError(400, "bad_request", "Pick each app once.");
        if (t.socialAccountId !== `${ws}.${t.platform}`) throw new ApiError(409, "conflict", "That account is not one of Lamo Stories' own. Pick it again.");
        if (t.confirmAccount !== undefined && (typeof t.confirmAccount !== "string" || !t.confirmAccount || t.confirmAccount.length > 200))
          throw new ApiError(400, "bad_request", "confirmAccount must be the account the app showed.");
        seen.add(t.platform);
      }
      // The account checks at the tap (§45.34): nothing is written while one of them asks the owner first.
      for (const t of targets) {
        const a = store.social.find((s) => s.workspaceId === ws && s.platform === t.platform);
        if (!a || a.connectionStatus !== "connected") continue;
        const ask = unsure(store, a, t.confirmAccount);
        if (ask) throw ask;
        if (t.confirmAccount !== undefined && t.confirmAccount !== a.externalAccountId) throw changed(a);
      }
      const made = targets.map((t) => {
        const a = store.social.find((s) => s.workspaceId === ws && s.platform === t.platform);
        const stop = stopReason(store, ws, t.platform);
        const j = job(story, t.platform, stop ? "needs_attention" : "queued", 0, { ...where(a), ...(stop ? { error: stop } : {}) });
        store.publishing.unshift(j);
        if (!stop) run(store, j.publishingJobId);
        return j;
      });
      return copy(made);
    },
    async listPublishing(ws, storyId) {
      await delay(140);
      storiesWorkspace(store, ws);
      return copy(
        store.publishing
          .filter((p) => p.workspaceId === ws && (!storyId || p.contentId === storyId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    },
    async retryPublishing(ws, publishingJobId, body = {}) {
      await delay(220);
      storiesWorkspace(store, ws);
      const j = store.publishing.find((p) => p.publishingJobId === publishingJobId && p.workspaceId === ws);
      if (!j) throw new ApiError(404, "not_found", "We could not find that post.");
      if (j.publishingStatus !== "failed" && j.publishingStatus !== "needs_attention") throw new ApiError(409, "conflict", "That post is not stuck. Wait for it to finish.");
      const confirm = body.confirmAccount;
      if (confirm !== undefined && (typeof confirm !== "string" || !confirm || confirm.length > 200)) throw new ApiError(400, "bad_request", "confirmAccount must be the account the app showed.");
      const stop = stopReason(store, ws, j.platform);
      const a = store.social.find((s) => s.workspaceId === ws && s.platform === j.platform);
      if (!stop && a) {
        const ask = unsure(store, a, confirm);
        if (ask) throw ask;
        // The account changed since the post was asked for: only the owner's yes for the new one sends it there.
        if (j.externalAccountId && a.externalAccountId !== j.externalAccountId && confirm !== a.externalAccountId) throw changed(a);
      }
      j.updatedAt = new Date().toISOString();
      if (stop) {
        j.publishingStatus = "needs_attention";
        j.error = stop;
      } else {
        j.publishingStatus = "queued";
        delete j.error;
        Object.assign(j, where(a));
        run(store, j.publishingJobId);
      }
      return copy(j);
    },
  };
}

