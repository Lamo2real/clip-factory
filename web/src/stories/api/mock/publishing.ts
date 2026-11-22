// Lamo Stories mock: the publishing part (docs/CONTRACTS.md §45.14, §45.16.8). The seed has a publishing job in every
// status (queued, publishing, posted with numbers, failed, needs_attention) on the stories that are approved or
// published. Publish and Try again check the destination like validate_destination: only this workspace's connected
// account, never a default; anything else stops the job with needs_attention and a plain sentence.
import { ApiError } from "../../../api/errors.ts";
import { STORIES_PLATFORMS, type Platform, type PublishingJob, type PublishTarget, type StoriesApi, type Story } from "../types.ts";
import { PLATFORM_NAME } from "./social.ts";
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
  if (published) {
    const postedAt = published.publishedAt ?? ago(58 * HOUR);
    const url = POST_URL.youtube(published.storyId);
    store.publishing.push(
      job(published, "youtube", "posted", 58, {
        accountName: name("youtube"),
        url,
        postedAt,
        metrics: { views: 1520, likes: 214, comments: 18, shares: 9, checkedAt: ago(10 * HOUR) },
      }),
      job(published, "tiktok", "needs_attention", 57, {
        accountName: name("tiktok"),
        error: "Lamo Stories' TikTok (Lamo Stories) needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.",
      }),
      job(published, "facebook", "failed", 57, { accountName: "Lamo Stories", error: "Facebook did not answer. Tap Try again in a few minutes." }),
    );
    if (!published.posted.some((p) => p.platform === "youtube")) published.posted.push({ platform: "youtube", url });
  }
  if (approved) {
    store.publishing.push(
      job(approved, "youtube", "publishing", 0.1, { accountName: name("youtube") }),
      job(approved, "instagram", "queued", 0.05, { accountName: null }),
      job(approved, "x", "needs_attention", 0.1, {
        accountName: name("x"),
        error: "This X account is the one Lamo Clips posts to. Pick another in Lamo Stories › Social accounts, then tap Try again.",
      }),
    );
  }
}

/** The check at the tap (§45.14): the account must be this workspace's own, connected, and not Lamo Clips' own. */
function stopReason(store: MockStore, ws: string, platform: Platform): string | null {
  const a = store.social.find((s) => s.workspaceId === ws && s.platform === platform);
  const name = PLATFORM_NAME[platform];
  if (!a || a.connectionStatus === "not_connected") return `Lamo Stories' ${name} is not connected. Connect it in Lamo Stories › Social accounts, then tap Try again.`;
  if (a.connectionStatus === "needs_reconnect")
    return `Lamo Stories' ${name}${a.accountName ? ` (${a.accountName})` : ""} needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.`;
  if (a.connectionStatus === "choose_account") return `Pick which ${name} account Lamo Stories posts to in Lamo Stories › Social accounts, then tap Try again.`;
  if (a.connectionStatus === "same_as_clips") return `This ${name} account is the one Lamo Clips posts to. Pick another in Lamo Stories › Social accounts, then tap Try again.`;
  return null;
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
  step(
    (j) => {
      const stop = stopReason(store, j.workspaceId, j.platform);
      if (stop) {
        j.publishingStatus = "needs_attention";
        j.error = stop;
      } else j.publishingStatus = "publishing";
    },
    fast,
    () =>
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
      }, fast),
  );
}

const copy = <T>(v: T): T => structuredClone(v);

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
        seen.add(t.platform);
      }
      const made = targets.map((t) => {
        const a = store.social.find((s) => s.workspaceId === ws && s.platform === t.platform);
        const stop = stopReason(store, ws, t.platform);
        const j = job(story, t.platform, stop ? "needs_attention" : "queued", 0, { accountName: a?.accountName ?? null, ...(stop ? { error: stop } : {}) });
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
    async retryPublishing(ws, publishingJobId) {
      await delay(220);
      storiesWorkspace(store, ws);
      const j = store.publishing.find((p) => p.publishingJobId === publishingJobId && p.workspaceId === ws);
      if (!j) throw new ApiError(404, "not_found", "We could not find that post.");
      if (j.publishingStatus !== "failed" && j.publishingStatus !== "needs_attention") throw new ApiError(409, "conflict", "That post is not stuck. Wait for it to finish.");
      const stop = stopReason(store, ws, j.platform);
      j.updatedAt = new Date().toISOString();
      if (stop) {
        j.publishingStatus = "needs_attention";
        j.error = stop;
      } else {
        j.publishingStatus = "queued";
        delete j.error;
        j.accountName = store.social.find((s) => s.workspaceId === ws && s.platform === j.platform)?.accountName ?? j.accountName;
        run(store, j.publishingJobId);
      }
      return copy(j);
    },
  };
}

