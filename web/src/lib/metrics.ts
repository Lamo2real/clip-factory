// What each platform's numbers mean and how they read on screen (docs/CONTRACTS.md §16.3, §16.8).
import type { AnyExtra, PerfStatus, Platform, PlatformPerformance, PostMetrics } from "../api/types.ts";
import type { IconName } from "../components/Icon.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER, relative, timecode } from "./format.ts";
import { postError, TIKTOK_PRIVATE_ONLY } from "./tiktokYourself.ts";

/** Platform order on the performance page and in This week: the app-wide PLATFORM_ORDER. */
export const STATS_ORDER: readonly Platform[] = PLATFORM_ORDER;

/** Mirrors config/platforms.json `x.budget.monthlyUsd`: X charges for every number check. */
export const X_MONTHLY_USD = 10;

/** Mirrors `manualCooldownMinutes` (the mock uses it; the real server sends nextAllowedAt). */
export const MANUAL_COOLDOWN_MIN: Record<Platform, number> = { youtube: 5, tiktok: 5, instagram: 30, facebook: 30, x: 5 };

const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** 950 → "950", 1234 → "1.2K", 3_400_000 → "3.4M"; null or missing → "–". */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return compactFmt.format(n);
}

/** The full number for screen readers and tooltips: 12,345. */
export function full(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "no number yet";
  return new Intl.NumberFormat("en").format(n);
}

/** Seconds as a clock: 65 → "1:05", 3725 → "1:02:05". */
export function clock(sec: number): string {
  return timecode(sec);
}

/** Long watch totals: under an hour "42:10", else "12 h", "1.2K h". */
export function watchTotal(sec: number): string {
  if (sec < 3600) return timecode(sec);
  return `${compact(Math.round(sec / 3600))} h`;
}

/** 42.37 → "42%". */
export function percent(n: number): string {
  return `${Math.round(n)}%`;
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago": the app's one style (format.ts relative()). */
export function ago(isoTime: string | undefined, now = Date.now()): string {
  if (!isoTime) return "";
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) return "";
  // A time a little ahead of this clock (another machine's) still reads "just now", never "in 1 min".
  return relative(new Date(Math.min(t, now)).toISOString(), now);
}

/** Time left until `isoTime`, rounded up: "1 min", "12 min", "1 h 5 min". Empty when it has passed. */
export function until(isoTime: string | undefined, now = Date.now()): string {
  if (!isoTime) return "";
  const ms = Date.parse(isoTime) - now;
  if (!(ms > 0)) return "";
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

// ---------- Rows per platform ----------

export interface MetricRow {
  key: string;
  label: string;
  icon: IconName;
  value: string;
  /** For screen readers: "12,345 likes". */
  spoken: string;
}

export interface MetricGroups {
  /** The big number at the top of the stack and what it is called there. */
  top: { label: string; value: string; spoken: string; raw: number | null };
  /** Fresh counts (every 15–30 minutes). */
  fast: MetricRow[];
  /** Slower insights, with the note that says how slow ("Updates daily", "Can take 2 days"). */
  slow: { note: string; rows: MetricRow[] } | null;
}

type Kind = "count" | "clock" | "watch" | "minutes" | "percent";

interface Def {
  key: string;
  label: string;
  icon: IconName;
  kind?: Kind;
  get: (m: PostMetrics, x: AnyExtra) => number | null | undefined;
}

const fmt = (kind: Kind, n: number) =>
  kind === "clock" ? clock(n) : kind === "watch" ? watchTotal(n) : kind === "minutes" ? `${compact(n)} min` : kind === "percent" ? percent(n) : compact(n);

const C = {
  views: { key: "views", label: "Views", icon: "eye", get: (m) => m.views },
  likes: { key: "likes", label: "Likes", icon: "heart", get: (m) => m.likes },
  comments: { key: "comments", label: "Comments", icon: "comment", get: (m) => m.comments },
  shares: { key: "shares", label: "Shares", icon: "share", get: (m) => m.shares },
} satisfies Record<string, Def>;

interface Layout {
  top: { label: string; get: Def["get"] };
  fast: Def[];
  slow?: { note: string; rows: Def[] };
}

/** What each stack shows: only the numbers that platform really gives (§16.8). */
const LAYOUTS: Record<Platform, Layout> = {
  youtube: {
    top: { label: "Views", get: C.views.get },
    fast: [C.likes, C.comments],
    slow: {
      note: "Updates daily",
      rows: [
        { key: "engagedViews", label: "Engaged views", icon: "eye", get: (_m, x) => x.engagedViews },
        { key: "watchMinutes", label: "Watch time", icon: "clock", kind: "minutes", get: (_m, x) => x.watchMinutes },
        { key: "avgViewSeconds", label: "Average view", icon: "clock", kind: "clock", get: (_m, x) => x.avgViewSeconds },
        { key: "avgViewPercent", label: "Average % watched", icon: "chart", kind: "percent", get: (_m, x) => x.avgViewPercent },
        C.shares,
        { key: "subscribersGained", label: "New subscribers", icon: "users", get: (_m, x) => x.subscribersGained },
      ],
    },
  },
  tiktok: {
    top: { label: "Views", get: C.views.get },
    fast: [C.likes, C.comments, C.shares],
  },
  instagram: {
    top: { label: "Views", get: C.views.get },
    fast: [C.likes, C.comments],
    slow: {
      note: "Can take 2 days",
      rows: [
        { key: "reach", label: "Reach", icon: "users", get: (_m, x) => x.reach },
        C.shares,
        { key: "saved", label: "Saves", icon: "bookmark", get: (_m, x) => x.saved },
        { key: "reposts", label: "Reposts", icon: "retry", get: (_m, x) => x.reposts },
        { key: "avgWatchSeconds", label: "Average watch", icon: "clock", kind: "clock", get: (_m, x) => x.avgWatchSeconds },
        { key: "totalWatchSeconds", label: "Total watch", icon: "clock", kind: "watch", get: (_m, x) => x.totalWatchSeconds },
        { key: "skipRatePercent", label: "Skip rate", icon: "chart", kind: "percent", get: (_m, x) => x.skipRatePercent },
      ],
    },
  },
  facebook: {
    top: { label: "Plays", get: C.views.get },
    fast: [],
    slow: {
      note: "Can take 2 days",
      rows: [
        { key: "initialPlays", label: "First plays", icon: "play", get: (_m, x) => x.initialPlays },
        { key: "replays", label: "Replays", icon: "retry", get: (_m, x) => x.replays },
        { key: "reactions", label: "Reactions", icon: "heart", get: (m) => m.likes },
        { key: "commentsAndShares", label: "Comments + shares", icon: "comment", get: (_m, x) => x.commentsAndShares },
        { key: "avgWatchSeconds", label: "Average watch", icon: "clock", kind: "clock", get: (_m, x) => x.avgWatchSeconds },
        { key: "totalWatchSeconds", label: "Total watch", icon: "clock", kind: "watch", get: (_m, x) => x.totalWatchSeconds },
        { key: "followsGained", label: "New followers", icon: "users", get: (_m, x) => x.followsGained },
        { key: "reachUnique", label: "Reach", icon: "users", get: (_m, x) => x.reachUnique },
      ],
    },
  },
  x: {
    top: { label: "Video views", get: C.views.get },
    fast: [
      { key: "impressions", label: "Impressions", icon: "eye", get: (_m, x) => x.impressions },
      C.likes,
      { key: "reposts", label: "Reposts", icon: "retry", get: (m, x) => x.reposts ?? m.shares },
      { key: "quotes", label: "Quotes", icon: "comment", get: (_m, x) => x.quotes },
      { key: "replies", label: "Replies", icon: "comment", get: (m) => m.comments },
      { key: "bookmarks", label: "Bookmarks", icon: "bookmark", get: (_m, x) => x.bookmarks },
      { key: "linkClicks", label: "Link clicks", icon: "link", get: (_m, x) => x.linkClicks },
      { key: "profileClicks", label: "Profile clicks", icon: "users", get: (_m, x) => x.profileClicks },
      { key: "playback25", label: "Watched to 25%", icon: "play", get: (_m, x) => x.playback25 },
      { key: "playback50", label: "Watched to 50%", icon: "play", get: (_m, x) => x.playback50 },
      { key: "playback75", label: "Watched to 75%", icon: "play", get: (_m, x) => x.playback75 },
      { key: "playback100", label: "Watched to 100%", icon: "play", get: (_m, x) => x.playback100 },
    ],
  },
};

/** Every metric label a platform can ever show (tests and the a11y review use it). */
export function labelsFor(platform: Platform): string[] {
  const l = LAYOUTS[platform];
  return [l.top.label, ...l.fast.map((d) => d.label), ...(l.slow?.rows.map((d) => d.label) ?? [])];
}

const spokenLabel = (label: string) => label.toLowerCase();

function row(d: Def, m: PostMetrics, x: AnyExtra): MetricRow | null {
  const n = d.get(m, x);
  // Absent or null: the platform did not send it, so the row is not shown at all (never a made-up 0).
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const value = fmt(d.kind ?? "count", n);
  return { key: d.key, label: d.label, icon: d.icon, value, spoken: `${d.kind && d.kind !== "count" ? value : full(n)} ${spokenLabel(d.label)}` };
}

/** The rows a stack shows for a platform's metrics (only fields that are present). */
export function metricGroups(platform: Platform, metrics: PostMetrics): MetricGroups {
  const l = LAYOUTS[platform];
  const x = (metrics.extra ?? {}) as AnyExtra;
  const raw = l.top.get(metrics, x) ?? null;
  const spoken = raw === null ? `${l.top.label}: not in yet` : `${full(raw)} ${spokenLabel(l.top.label)}`;
  const top = { label: l.top.label, value: compact(raw), spoken, raw };
  const fast = l.fast.map((d) => row(d, metrics, x)).filter((r): r is MetricRow => r !== null);
  const slowRows = l.slow ? l.slow.rows.map((d) => row(d, metrics, x)).filter((r): r is MetricRow => r !== null) : [];
  // The slow note shows even before the slow numbers arrive: it says why they are not there yet.
  return { top, fast, slow: l.slow ? { note: l.slow.note, rows: slowRows } : null };
}

/** Facebook reactions as "👍 120 · ❤️ 40"-style parts, biggest first (names, not emoji, for screen readers). */
export function reactionParts(reactions: Record<string, number> | undefined): { name: string; count: string }[] {
  if (!reactions) return [];
  return Object.entries(reactions)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => ({ name: REACTION_NAME[name.toLowerCase()] ?? name, count: compact(n) }));
}

const REACTION_NAME: Record<string, string> = {
  like: "Like",
  love: "Love",
  wow: "Wow",
  haha: "Haha",
  sorry: "Sad",
  sad: "Sad",
  anger: "Angry",
  angry: "Angry",
  care: "Care",
};

// ---------- Status copy (§16.8 calm states) ----------

export const STATUS_LABEL: Record<PerfStatus, string> = {
  posted: "Uploaded",
  posted_private: "Uploaded privately",
  waiting_for_connection: "Waiting for setup",
  posting: "Uploading…",
  failed: "Didn't work",
  not_posted: "Not posted",
};

export interface CalmCopy {
  text: string;
  link?: { href: string; label: string };
  spinner?: boolean;
}

/** The one plain line (and link) a stack shows instead of numbers. Null when it has numbers to show. */
export function calmCopy(p: Pick<PlatformPerformance, "platform" | "status" | "metrics" | "error"> & Partial<Pick<PlatformPerformance, "by" | "url">>): CalmCopy | null {
  const name = PLATFORM_LABEL[p.platform];
  switch (p.status) {
    case "waiting_for_connection":
      return {
        text: `Connect ${name} in Settings › Posting › Set up posting.`,
        link: { href: `/settings/posting/setup/${p.platform}`, label: `Set up ${name}` },
      };
    case "not_posted":
      return {
        text: `Not posted here. Turn on ${name} in Settings › Posting › Where clips go.`,
        link: { href: "/settings/posting/where", label: "Open Where clips go" },
      };
    case "posting":
      return { text: "Posting now…", spinner: true };
    case "posted_private":
      return { text: "Uploaded privately. TikTok shows numbers after the app is approved." };
    case "failed": {
      // TikTok refused it because the account is public (§42): post it yourself, not Try again.
      if (p.platform === "tiktok" && p.error && postError(p.error) === TIKTOK_PRIVATE_ONLY)
        return { text: "TikTok only takes Clip Factory's uploads on a private account until it approves the app. Go to Library and tap Post it yourself.", link: { href: "/library", label: "Go to Library" } };
      const why = (p.error ?? "something went wrong").replace(/[.!\s]+$/, "");
      return { text: `${why}. Go to Library and tap Try again.`, link: { href: "/library", label: "Go to Library" } };
    }
    case "posted":
      // Posted on TikTok by the owner himself (§42): only its link lets Clip Factory find its numbers.
      if (p.by === "you" && !p.url) return { text: "Posted by you. Add its TikTok link in Library to count views.", link: { href: "/library", label: "Go to Library" } };
      return p.metrics ? null : { text: "Numbers are on the way. Check back in a few minutes." };
  }
}

/** The Post → stack status rule of §16.2 (first match wins). */
export function perfStatus(post: { status: string; privacy?: string } | undefined): PerfStatus {
  if (!post) return "not_posted";
  switch (post.status) {
    case "pending_integration":
      return "waiting_for_connection";
    case "queued":
      return "posting";
    case "failed":
      return "failed";
    case "posted":
      return post.privacy === "private" ? "posted_private" : "posted";
    default:
      return "not_posted";
  }
}

/**
 * The one status word for a post, the same on Library cards and on the clip page: a queued post reads "Posting",
 * a post waiting for its account "Waiting for connection" (§16.2 mapping, STATUS_LABEL).
 */
export function postStatusLabel(post: { status: string; privacy?: string }): string {
  return STATUS_LABEL[perfStatus(post)];
}

/**
 * What a Library post row adds after its status word about numbers: when they come, or, for a private post, that
 * none come. TikTok gives no numbers for private ("Only me") posts, so the api never reads them (platforms/tiktok.py).
 */
export function postNumbersNote(
  post: { status: string; privacy?: string; metrics?: unknown; perfCheckAt?: string },
  when: (iso: string) => string,
): string {
  if (post.status !== "posted" || post.metrics) return "";
  if (post.privacy === "private") return " · private posts get no numbers";
  return post.perfCheckAt ? ` · numbers ${when(post.perfCheckAt)}` : "";
}

/** Highest views above 0; a tie goes to the platform earlier in STATS_ORDER. */
export function pickBest(posts: Pick<PlatformPerformance, "platform" | "metrics">[]): Platform | null {
  let best: Platform | null = null;
  let most = 0;
  for (const platform of STATS_ORDER) {
    const v = posts.find((p) => p.platform === platform)?.metrics?.views;
    if (typeof v === "number" && v > most) {
      most = v;
      best = platform;
    }
  }
  return best;
}
