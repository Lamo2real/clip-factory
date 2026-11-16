// Shapes from docs/CONTRACTS.md §5. Keep in step with the contract, never the other way round.

export type JobStatus = "queued" | "running" | "ready" | "failed" | "canceled";
export type StepKey =
  | "resolve"
  | "download"
  | "transcribe"
  | "analyze"
  | "select"
  | "render"
  | "checklist"
  | "captions"
  | "finalize";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type SourcePlatform = "youtube" | "twitch" | "kick" | "upload";
export type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
export type ClipStatus = "review" | "confirmed" | "declined" | "publishing" | "posted" | "failed";
export type MomentType = "rage" | "chaos" | "interaction" | "no_way" | "first_reaction" | "hot_take";
export type ClipFilter = "review" | "confirmed" | "posted" | "declined" | "all";

export interface Step {
  key: StepKey;
  label: string;
  status: StepStatus;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Source {
  type: "link" | "upload";
  platform: SourcePlatform;
  url?: string;
  key?: string;
  filename?: string;
  title?: string;
  channel?: string;
  durationSec?: number;
  thumbnailUrl?: string;
}

export interface ClipTarget {
  min: number;
  max: number;
}

export interface Job {
  jobId: string;
  status: JobStatus;
  source: Source;
  clipTarget: ClipTarget;
  steps: Step[];
  progress: number;
  clipCount: number;
  notes?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Captions {
  youtubeTitle: string;
  youtubeDescription: string;
  instagram: string;
  facebook: string;
  tiktok: string;
  x: string;
}

export interface ChecklistItem {
  key: string;
  label: string;
  pass: boolean;
  note?: string;
}

export interface Clip {
  clipId: string;
  jobId: string;
  rank: number;
  status: ClipStatus;
  momentType: MomentType;
  hook: string;
  summary: string;
  durationSec: number;
  sourceStart: number;
  sourceEnd: number;
  sourceUrlAt?: string;
  layout: "facecam_top" | "blur_fill";
  videoUrl?: string;
  coverUrl?: string;
  captions: Captions;
  checklist: { items: ChecklistItem[]; fixes: string[] };
  score: number;
  createdAt: string;
  decidedAt?: string;
  /** Starred "Best this week" (docs/CONTRACTS.md §16). */
  best?: boolean;
  /** The ISO week it was starred in, "yyyy-Www". */
  bestWeek?: string;
  /** Sum of the posted posts' views; absent when nothing was measured yet. */
  totalViews?: number;
}

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  format: "md" | "zip";
  size: number;
  createdAt: string;
}

export interface Settings {
  clipMin: number;
  clipMax: number;
  maxSourceHours: number;
  soundEnabled: boolean;
  /** Click sound 1..30, default 6 "Water drop" (docs/CONTRACTS.md §15.3). */
  clickSound: number;
  /** Error sound 1..30, default 5 "Nope nope nope". */
  errorSound: number;
  reduceMotion: boolean;
  hasYoutubeCookies: boolean;
  platforms: Platform[];
}

export interface Account {
  platform: Platform;
  status: "not_connected" | "connected" | "needs_reconnect";
  handle?: string;
}

// ---------- Stats (docs/CONTRACTS.md §16.3) ----------
// Every extra field is optional: a number the platform did not send is absent, never 0. Times are in seconds.
export interface YouTubeExtra {
  engagedViews?: number;
  watchMinutes?: number;
  avgViewSeconds?: number;
  avgViewPercent?: number;
  subscribersGained?: number;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- TikTok only sends the common four.
export interface TikTokExtra {}
export interface InstagramExtra {
  reach?: number;
  saved?: number;
  reposts?: number;
  totalInteractions?: number;
  avgWatchSeconds?: number;
  totalWatchSeconds?: number;
  skipRatePercent?: number;
}
export interface FacebookExtra {
  initialPlays?: number;
  replays?: number;
  reactions?: Record<string, number>;
  commentsAndShares?: number;
  avgWatchSeconds?: number;
  totalWatchSeconds?: number;
  followsGained?: number;
  reachUnique?: number;
}
export interface XExtra {
  impressions?: number;
  reposts?: number;
  quotes?: number;
  bookmarks?: number;
  linkClicks?: number;
  profileClicks?: number;
  engagements?: number;
  playback0?: number;
  playback25?: number;
  playback50?: number;
  playback75?: number;
  playback100?: number;
}
export type AnyExtra = YouTubeExtra & TikTokExtra & InstagramExtra & FacebookExtra & XExtra;

export interface PostMetrics {
  /** null = "this platform does not say" (yet). */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  checkedAt: string;
  /** When the fast counts were read. */
  metricsUpdatedAt?: string;
  /** When the slow insights were read. */
  insightsUpdatedAt?: string;
  final?: true;
  extra?: YouTubeExtra | TikTokExtra | InstagramExtra | FacebookExtra | XExtra;
}

export interface Post {
  postId: string;
  clipId: string;
  platform: Platform;
  status: "pending_integration" | "queued" | "posted" | "failed";
  url?: string;
  postedAt?: string;
  perfCheckAt?: string;
  metrics?: PostMetrics;
  /** TikTok posts from an app that is not approved yet are private (§16.3). */
  privacy?: "public" | "private";
  /** A stats refresh is running. */
  refreshing?: boolean;
  /** Earliest manual refresh. */
  nextRefreshAt?: string;
  error?: string;
}

export interface Learning {
  learningId: string;
  text: string;
  createdAt: string;
  postIds: string[];
  /** Absent = "post". */
  kind?: "post" | "week";
  week?: string;
  title?: string;
  clipIds?: string[];
}

export type PerfStatus = "posted" | "posted_private" | "waiting_for_connection" | "posting" | "failed" | "not_posted";

export interface PlatformPerformance {
  platform: Platform;
  status: PerfStatus;
  account: "connected" | "not_connected" | "needs_reconnect";
  postId?: string;
  url?: string;
  postedAt?: string;
  metrics: PostMetrics | null;
  updatedAt?: string;
  insightsUpdatedAt?: string;
  nextAllowedAt?: string;
  refreshing: boolean;
  final: boolean;
  error?: string;
}

export interface SeriesPoint {
  at: string;
  views: number;
}

export interface ClipPerformance {
  clip: Clip;
  /** Always five, in STATS_ORDER. */
  posts: PlatformPerformance[];
  series: Partial<Record<Platform, SeriesPoint[]>>;
  totals: { views: number; likes: number; comments: number; shares: number; platformsPosted: number; updatedAt?: string };
  bestPlatform: Platform | null;
  bestThisWeek: boolean;
  week: string | null;
  weekAnchorAt: string;
}

export interface RefreshResult {
  platform: Platform;
  status: "started" | "too_soon" | "blocked" | "not_posted" | "not_connected" | "private";
  nextAllowedAt?: string;
  note?: string;
}

export interface WeekClip {
  clip: Clip;
  anchorAt: string;
  posted: boolean;
  totals: { views: number; likes: number; comments: number; shares: number };
  views: Partial<Record<Platform, number | null>>;
  best: boolean;
}

export type LearnState = "none" | "learning" | "done" | "skipped" | "failed";

export interface WeekSummary {
  week: string;
  from: string;
  to: string;
  clipIds: string[];
  savedAt?: string;
  learnState: LearnState;
  learningId?: string;
}

export interface WeekView extends WeekSummary {
  clips: WeekClip[];
  learning?: Learning;
}

export interface Performance {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  posts: number;
  checkedAt: string;
}

/** One of the owner's measured clips that is most like a given clip (docs/CONTRACTS.md §14.6). */
export interface SimilarClip {
  clipId: string;
  hook: string;
  title: string;
  momentType: MomentType;
  /** 0..1 (1 - cosine distance, 2 decimals). */
  similarity: number;
  performance?: Performance;
  coverUrl?: string;
}

/** What the live connection pushes (docs/CONTRACTS.md §14.2). One message per changed item. */
export type LiveItemType = "job" | "clip" | "post" | "learning" | "week";
export type LiveEvent =
  | { type: "job"; op: "upsert"; id: string; item: Job; partial?: undefined }
  | { type: "clip"; op: "upsert"; id: string; item: Clip; partial?: undefined }
  | { type: "post"; op: "upsert"; id: string; item: Post; partial?: undefined }
  | { type: "learning"; op: "upsert"; id: string; item: Learning; partial?: undefined }
  | { type: "week"; op: "upsert"; id: string; item: WeekSummary; partial?: undefined }
  | { type: LiveItemType; op: "delete"; id: string; item?: undefined; partial?: undefined }
  | { type: LiveItemType; op: "upsert"; id: string; partial: true; item?: undefined };

export interface Me {
  user: { id: string; email: string };
  settings: Settings;
  counts: { review: number; running: number; posted: number };
}

export interface PresignedPut {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export type NewJobSource = { type: "link"; url: string } | { type: "upload"; key: string; filename: string };

export interface NewJob {
  source: NewJobSource;
  clipTarget: ClipTarget;
  notes?: string;
}

/** Everything the screens need from the backend. The HTTP client and the mock both implement it. */
export interface Api {
  health(): Promise<{ ok: boolean; version: string }>;
  me(): Promise<Me>;
  createUpload(body: { filename: string; contentType: string; size: number }): Promise<PresignedPut & { uploadId: string }>;
  createJob(body: NewJob): Promise<Job>;
  listJobs(query?: { limit?: number; cursor?: string | null }): Promise<{ jobs: Job[]; nextCursor: string | null }>;
  getJob(jobId: string): Promise<{ job: Job; clips: Clip[] }>;
  cancelJob(jobId: string): Promise<Job>;
  retryJob(jobId: string): Promise<Job>;
  listClips(query?: { status?: ClipFilter; jobId?: string }): Promise<Clip[]>;
  getClip(clipId: string): Promise<Clip>;
  updateClip(clipId: string, captions: Partial<Captions>): Promise<Clip>;
  confirmClip(clipId: string, captions?: Partial<Captions>): Promise<{ clip: Clip; posts: Post[] }>;
  declineClip(clipId: string): Promise<Clip>;
  listSkills(): Promise<Skill[]>;
  createSkillUpload(filename: string): Promise<PresignedPut & { skillId: string }>;
  createSkill(body: { skillId: string; key: string }): Promise<Skill>;
  setSkillEnabled(skillId: string, enabled: boolean): Promise<Skill>;
  deleteSkill(skillId: string): Promise<void>;
  skillContent(skillId: string): Promise<string>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  createCookiesUpload(filename: string): Promise<PresignedPut>;
  deleteCookies(): Promise<void>;
  listAccounts(): Promise<Account[]>;
  connectAccount(platform: Platform): Promise<void>;
  listPosts(clipId?: string): Promise<Post[]>;
  insights(): Promise<{ learnings: Learning[]; posts: Post[] }>;
  similarClips(clipId: string): Promise<SimilarClip[]>;
  /** GET /v1/clips/{clipId}/performance (§16.2). */
  clipPerformance(clipId: string): Promise<ClipPerformance>;
  /** POST /v1/clips/{clipId}/stats/refresh: one result per platform asked (default all five). */
  refreshStats(clipId: string, platforms?: Platform[]): Promise<RefreshResult[]>;
  /** GET /v1/weeks/{week}?from=&to= */
  getWeek(week: string, from: string, to: string): Promise<WeekView>;
  /** PUT /v1/weeks/{week}/best: 202 when the picks changed (learning starts), 200 when they did not. */
  saveWeekBest(week: string, body: { from: string; to: string; clipIds: string[] }): Promise<WeekView>;
}
