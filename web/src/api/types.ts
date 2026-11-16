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

/** One skill (docs/CONTRACTS.md §5, §18). Every skill is always used: there is no on/off switch. */
export interface Skill {
  skillId: string;
  /** The frontmatter slug. */
  name: string;
  /** The name people see (§18.2). */
  title: string;
  description: string;
  builtin: boolean;
  source: "builtin" | "written" | "upload";
  format: "md" | "zip";
  /** Bytes of the stored file. */
  size: number;
  createdAt: string;
  updatedAt: string;
  /** ≥ 1; sent back on every save so a change made somewhere else is noticed (§18.4). */
  version: number;
}

/** The three questions of "Write a skill" (§18.2). */
export interface SkillForm {
  title: string;
  description: string;
  instructions: string;
}

/** GET /v1/skills/{skillId} (§18.3). */
export interface SkillDetail {
  skill: Skill;
  /** The SKILL.md text. */
  content: string;
  /** null for built-ins, or when it cannot be changed here (`formBlocked` says why). */
  form: SkillForm | null;
  formBlocked?: "builtin" | "too_long";
  /** Zip only: the other files inside, sorted; [] for .md. */
  files: string[];
}

/** PUT /v1/skills/{skillId}: the form, or a whole new file, with the version last read. */
export type SkillUpdate = { version: number } & (SkillForm | { key: string });

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
  /** Who can see new YouTube clips (docs/CONTRACTS.md §17.6). Absent on old servers: "public". */
  youtubePrivacy?: YoutubePrivacy;
}

export type YoutubePrivacy = "public" | "unlisted" | "private";

// ---------- Posting setup (docs/CONTRACTS.md §17.4) ----------
export type AccountStatus = "not_connected" | "connected" | "needs_reconnect" | "choose_account";

export interface AccountChoice {
  id: string;
  name: string;
  avatarUrl?: string;
}

export interface Account {
  platform: Platform;
  status: AccountStatus;
  /** "@name" or the channel title. */
  handle?: string;
  name?: string;
  avatarUrl?: string;
  connectedAt?: string;
  /** Permissions the owner did not tick. */
  missing?: string[];
  reason?: "token_dead" | "missing_permissions" | "keys_changed" | "expires_soon";
  /** TikTok: connect again before this. */
  reconnectBy?: string;
  /** Meta with several Pages or Instagram accounts: pick one. */
  choices?: AccountChoice[];
}

export type GateKey = "published_app" | "app_review" | "posting_audit" | "app_live" | "credits";
export type GateState = "ok" | "limited" | "waiting" | "action" | "unknown";
export interface Gate {
  key: GateKey;
  state: GateState;
  at?: string;
}
/** The TikTok review state the owner picks (PATCH /v1/setup/tiktok). */
export type ReviewState = "draft" | "in_review" | "live" | "not_approved";

export type KeyName = "clientId" | "clientSecret" | "configId";
export type CheckCode =
  | "ok"
  | "keys_wrong"
  | "redirect_wrong"
  | "not_connected"
  | "token_dead"
  | "missing_permissions"
  | "credits_empty"
  | "platform_down";

export interface KeyCheck {
  at: string;
  ok: boolean;
  code: CheckCode;
  message: string;
  account?: "ok" | "dead" | "none";
}

export interface PlatformSetup {
  platform: Platform;
  stepsDone: string[];
  /** Connected and no gate needs the owner. */
  ready: boolean;
  keys: { saved: boolean; hints?: Partial<Record<KeyName, string>>; savedAt?: string; check?: KeyCheck };
  account: Account;
  gates: Gate[];
  /** TikTok verification files online. */
  files?: string[];
  updatedAt?: string;
}

export interface SetupValues {
  appName: string;
  websiteUrl: string;
  websitePrefix: string;
  privacyUrl: string;
  termsUrl: string;
  dataDeletionUrl: string;
  appDomain: string;
  hooksDomain: string;
  redirectUris: Record<Platform, string>;
  scopes: Record<Platform, string[]>;
  ownerEmail: string;
}

export interface SetupOverview {
  /** Always five, in SETUP_ORDER. */
  platforms: PlatformSetup[];
  ready: number;
  values: SetupValues;
}

export interface SetupKeys {
  clientId: string;
  clientSecret: string;
  configId?: string;
}

/** The OAuth result codes the hooks API sends back in `?result=` (§17.5). */
export type ConnectResult =
  | "connected"
  | "choose"
  | "denied"
  | "expired"
  | "keys_wrong"
  | "redirect_wrong"
  | "missing_permissions"
  | "no_channel"
  | "no_accounts"
  | "wrong_account_type"
  | "no_pages"
  | "platform_down"
  | "error";

export type TikTokPrivacy = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";

export interface TikTokCreator {
  nickname: string;
  username: string;
  avatarUrl?: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
}

/** What the Post to TikTok sheet adds to Keep (§17.8). */
export interface TikTokPostOptions {
  privacyLevel: string;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
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
export type LiveItemType = "job" | "clip" | "post" | "learning" | "week" | "setup";
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
  /** `tiktok` carries the Post to TikTok sheet's choices (§17.8). */
  confirmClip(clipId: string, captions?: Partial<Captions>, tiktok?: TikTokPostOptions): Promise<{ clip: Clip; posts: Post[] }>;
  declineClip(clipId: string): Promise<Clip>;
  /** GET /v1/skills: built-ins first, then the owner's, by name (§18.3). */
  listSkills(): Promise<Skill[]>;
  /** GET /v1/skills/{skillId}. */
  getSkill(skillId: string): Promise<SkillDetail>;
  /** POST /v1/skills with the three answers (§18.2). */
  writeSkill(form: SkillForm): Promise<Skill>;
  /** PUT /v1/skills/{skillId} (§18.4); 409 when `version` is stale. */
  updateSkill(skillId: string, body: SkillUpdate): Promise<Skill>;
  /** POST /v1/skills/uploads; with `skillId` the file replaces that skill's file (§18.4). */
  createSkillUpload(filename: string, skillId?: string): Promise<PresignedPut & { skillId: string }>;
  /** POST /v1/skills after the upload. */
  createSkill(body: { skillId: string; key: string }): Promise<Skill>;
  deleteSkill(skillId: string): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  createCookiesUpload(filename: string): Promise<PresignedPut>;
  deleteCookies(): Promise<void>;
  listAccounts(): Promise<Account[]>;
  /** POST /v1/accounts/{platform}/connect: where to send the owner to approve (same tab). */
  connectAccount(platform: Platform): Promise<{ authorizeUrl: string; expiresAt: string }>;
  /** POST /v1/accounts/{platform}/choose (Meta with several Pages or Instagram accounts). */
  chooseAccount(platform: Platform, accountId: string): Promise<PlatformSetup>;
  /** DELETE /v1/accounts/{platform}: the keys stay. */
  disconnectAccount(platform: Platform): Promise<void>;
  /** GET /v1/accounts/tiktok/creator-info, fetched each time the Post to TikTok sheet opens. */
  tiktokCreatorInfo(): Promise<TikTokCreator>;
  // Posting setup (§17.4)
  getSetup(): Promise<SetupOverview>;
  getPlatformSetup(platform: Platform): Promise<PlatformSetup>;
  setSetupStep(platform: Platform, step: string, done: boolean): Promise<PlatformSetup>;
  setReviewState(state: ReviewState): Promise<PlatformSetup>;
  saveSetupKeys(platform: Platform, keys: SetupKeys): Promise<PlatformSetup>;
  deleteSetupKeys(platform: Platform): Promise<void>;
  checkSetup(platform: Platform): Promise<{ check: KeyCheck; setup: PlatformSetup }>;
  uploadVerificationFile(filename: string, content: string): Promise<PlatformSetup>;
  deleteVerificationFile(filename: string): Promise<void>;
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
