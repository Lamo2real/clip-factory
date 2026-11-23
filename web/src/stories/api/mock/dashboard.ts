// Lamo Stories mock: the dashboard part (docs/CONTRACTS.md §45.16.3, §45.16.8). Worked out from the store on every
// call, the way the API reads its items: so whatever another part changes (a story made, approved or posted, an
// account connected) shows on the dashboard and in the Needs you bar at the next poll. A post that stopped on an
// account problem (its sentence names Lamo Stories › Social accounts) has Fix it go to Social accounts, as the API's
// _post_href does (§45.35 D11, §45.36 E9); an account is named by its place first ("this TikTok account (Lamo
// Stories)"), so the line reads right when the account is itself called Lamo Stories (§45.36 E13).
import { ApiError } from "../../../api/errors.ts";
import { STORIES_PLATFORMS, STEP_ORDER, type Platform, type StepKey, type StoriesApi, type StoriesDashboard } from "../types.ts";
import { PLATFORM_NAME } from "./social.ts";
import { DAY, delay, type MockStore } from "./store.ts";
import { storiesWorkspace } from "./workspace.ts";

export const KEYS = ["dashboard"] as const;

export function seed(_store: MockStore): void {}

type Activity = StoriesDashboard["activity"][number];

/** The page an account problem's sentence names (the API's sentences.CONNECTIONS). */
const CONNECTIONS = "Clip Factory Stories › Social accounts";

/** Fix it for a stopped post: Social accounts when it stopped on an account problem, else the video's Review page. */
export function postHref(error: string | null | undefined, storyId: string): string {
  if ((error ?? "").includes(CONNECTIONS)) return "/stories/connections";
  return storyId ? `/stories/review/${encodeURIComponent(storyId)}` : "/stories";
}

/** The dashboard of workspace `ws`, as GET …/dashboard answers it. */
export function dashboardOf(store: MockStore, ws: string): StoriesDashboard {
  const stories = store.stories.filter((s) => s.workspaceId === ws);
  const jobs = store.publishing.filter((p) => p.workspaceId === ws);
  const accounts = STORIES_PLATFORMS.map(
    (p) => store.social.find((a) => a.workspaceId === ws && a.platform === p) ?? { platform: p, connectionStatus: "not_connected" as const, accountName: null, warning: null, reason: null },
  );
  const title = (id: string) => stories.find((s) => s.storyId === id)?.title ?? "A story";

  const needsYou: StoriesDashboard["needsYou"] = [];
  // A stuck post counts until a later post of the same story on the same app went through.
  for (const j of jobs) {
    if (j.publishingStatus !== "needs_attention" && j.publishingStatus !== "failed") continue;
    const later = jobs.some((o) => o.contentId === j.contentId && o.platform === j.platform && o.publishingStatus === "posted" && o.createdAt > j.createdAt);
    if (later) continue;
    needsYou.push({
      publishingJobId: j.publishingJobId,
      storyId: j.contentId,
      title: title(j.contentId),
      platform: j.platform,
      sentence: j.error ?? `Posting “${title(j.contentId)}” to ${PLATFORM_NAME[j.platform]} stopped. Tap Try again.`,
      href: postHref(j.error, j.contentId),
    });
  }
  // One line per account, as the API words it (its reason is a code, never shown as it is): connect again, else
  // the account's own warning.
  for (const a of accounts) {
    const name = PLATFORM_NAME[a.platform as Platform];
    const sentence =
      a.connectionStatus === "needs_reconnect"
        ? `This ${name} account${a.accountName ? ` (${a.accountName})` : ""} needs connecting again. Open Social accounts and tap Connect.`
        : a.warning?.trim() || null;
    if (sentence) needsYou.push({ publishingJobId: null, storyId: null, title: name, platform: a.platform as Platform, sentence, href: "/stories/connections" });
  }
  for (const s of stories)
    if (s.status === "needs_check")
      needsYou.push({
        publishingJobId: null,
        storyId: s.storyId,
        title: s.title,
        platform: null,
        sentence: `“${s.title}” needs a check before you can approve it.`,
        href: `/stories/review/${encodeURIComponent(s.storyId)}`,
      });

  const producing = stories
    .filter((s) => s.status === "producing")
    .map((s) => {
      const job = store.jobs.find((j) => j.jobId === s.currentJobId) ?? store.jobs.find((j) => j.contentId === s.storyId && (j.status === "running" || j.status === "queued"));
      const running = job?.steps.find((st) => st.status === "running") ?? job?.steps.find((st) => st.status === "pending");
      const step = (running && running.key !== "portrait" ? running.key : "storyboard") as StepKey;
      return { storyId: s.storyId, title: s.title, step: STEP_ORDER.includes(step) ? step : "storyboard", progress: job?.progress ?? 0 };
    });

  const posted = jobs.filter((j) => j.publishingStatus === "posted");
  const numbers = posted.filter((j) => j.metrics);
  const sum = (k: "views" | "likes" | "comments" | "shares") => numbers.reduce((n, j) => n + (j.metrics?.[k] ?? 0), 0);
  const checkedAt = numbers.map((j) => j.metrics!.checkedAt).sort().at(-1) ?? null;
  const lastPost = posted.map((j) => j.postedAt ?? j.updatedAt).sort().at(-1);

  const activity: Activity[] = [...store.activity.filter((a) => stories.some((s) => s.storyId === a.storyId))];
  const has = (kind: Activity["kind"], storyId: string, platform?: Platform) => activity.some((a) => a.kind === kind && a.storyId === storyId && a.platform === platform);
  for (const s of stories) {
    if ((s.actualDurationSec !== null || s.videoUrl) && !has("made", s.storyId)) activity.push({ at: s.createdAt, kind: "made", storyId: s.storyId, title: s.title });
    if (s.approvedAt && !has("approved", s.storyId)) activity.push({ at: s.approvedAt, kind: "approved", storyId: s.storyId, title: s.title });
    if (s.status === "rejected" && !has("rejected", s.storyId)) activity.push({ at: s.updatedAt, kind: "rejected", storyId: s.storyId, title: s.title });
    if (s.status === "failed" && !has("failed", s.storyId)) activity.push({ at: s.updatedAt, kind: "failed", storyId: s.storyId, title: s.title });
  }
  for (const j of jobs) {
    if (j.publishingStatus === "posted" && !has("posted", j.contentId, j.platform))
      activity.push({ at: j.postedAt ?? j.updatedAt, kind: "posted", storyId: j.contentId, title: title(j.contentId), platform: j.platform });
    if (j.publishingStatus === "failed" && !has("failed", j.contentId, j.platform))
      activity.push({ at: j.updatedAt, kind: "failed", storyId: j.contentId, title: title(j.contentId), platform: j.platform });
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    counts: {
      made: stories.filter((s) => s.actualDurationSec !== null || !!s.videoUrl).length,
      review: stories.filter((s) => s.status === "review").length,
      published: stories.filter((s) => s.status === "published").length,
      producing: producing.length,
      needsCheck: stories.filter((s) => s.status === "needs_check").length,
      needsYou: needsYou.length,
    },
    needsYou,
    producing,
    accounts: accounts.map((a) => ({ platform: a.platform as Platform, status: a.connectionStatus, accountName: a.accountName })),
    performance: {
      views: sum("views"),
      likes: sum("likes"),
      comments: sum("comments"),
      shares: sum("shares"),
      posts: posted.length,
      checkedAt,
      lastAt: lastPost ? new Date(Date.parse(lastPost) + 7 * DAY).toISOString() : null,
    },
    activity: activity.slice(0, 10),
  };
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async dashboard(ws) {
      await delay(180);
      storiesWorkspace(store, ws);
      if (store.knobs.dashboardDown) throw new ApiError(503, "internal", "Something went wrong on our side. Try again in a moment.");
      return structuredClone(dashboardOf(store, ws));
    },
  };
}
