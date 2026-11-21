// Shapes from docs/CONTRACTS.md §5. Keep in step with the contract, never the other way round.
import type { BackgroundMode, GlassStrength } from "../lib/background.ts";

export type JobStatus = "queued" | "running" | "ready" | "failed" | "canceled";
export type StepKey =
  | "resolve"
  | "download"
  | "transcribe"
  | "analyze"
  | "watch"
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
  /** "mac": the owner's Mac or Windows app got this video because YouTube blocked the cloud (CONTRACTS §35). */
  fetchedBy?: "mac";
  /** Where a Mac-fetched video came from ("youtube"); `url` keeps the link. */
  linkPlatform?: SourcePlatform;
  /** The channel's own names and ids, for the campaign fit's channel check (§39.3, written by the agent). No screen
   * shows it. */
  channelKeys?: string[];
}

/** Mac fetches it (CONTRACTS §35): where a YouTube job stands with the owner's Mac. */
export type MacFetchState = "cloud" | "waiting" | "getting" | "sending" | "done" | "failed";

export interface JobMacFetch {
  state: MacFetchState;
  /** Started from the desktop app: the Mac gets the video from the start. */
  up?: boolean;
  since?: string;
  /** The "Open Clip Factory on your Mac" notification went out (no Mac claimed it within 2 minutes). */
  nudgedAt?: string;
  pct?: number;
  at?: string;
}

/** POST /v1/jobs/{id}/mac-progress (§35.3). */
export interface MacProgress {
  deviceId: string;
  phase: "getting" | "sending" | "failed";
  pct?: number;
  error?: string;
  needGb?: number;
}

export interface MacUploadParts {
  partSize: number;
  parts: { n: number; url: string }[];
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
  /** A short plain sentence while the job runs, e.g. "Picking up where it stopped…" after a stop (CONTRACTS §30). */
  note?: string;
  /** A short tag of the run that owns the job; a live line of another run is ignored (CONTRACTS §31). */
  run?: string;
  /** The live status line while the job is queued or running, from GET /v1/jobs and /v1/jobs/{id} (CONTRACTS §31). */
  live?: JobLive;
  /** The AI model that made the clips, a key of config/models.json (ADR-42). Absent on jobs from before it. */
  model?: string;
  /** The model the owner picked when it could not be used and the default model made the clips instead. */
  modelWanted?: string;
  /** YouTube link jobs only (CONTRACTS §35). */
  macFetch?: JobMacFetch;
  /** Stopped because the owner's video file replaced it (Use a video file, CONTRACTS §35.8): the new job's id. */
  replacedBy?: string;
  /** The Content Rewards campaign these clips are for (CONTRACTS §38.5). */
  campaignId?: string;
  /** One sentence from the agent about the campaign ("This video may not be from FaZe's channels."). */
  campaignNote?: string;
  /** A campaign copy of a clip (§39.3): the clip, and its job, it was made from. */
  remakeOf?: { clipId: string; jobId: string };
  /** The language the video speaks, BCP 47 from Transcribe ("en-US", §39.3). */
  sourceLanguage?: string;
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
  /** Why it was picked, in a few plain words ("Loud laugh + Fast action"). Absent when nothing stood out (§5). */
  pickedFor?: string;
  /** Sum of the posted posts' views; absent when nothing was measured yet. */
  totalViews?: number;
  /** The places the owner picked on Upload, in STATS_ORDER (§33). Absent on clips uploaded before §33. */
  uploadTo?: Platform[];
  /** The Content Rewards campaign this clip is for (copied by the agent, §38.8). */
  campaignId?: string;
  /** Campaign copies made of this clip (§39.3): campaignId → the copy's job. */
  remakes?: Record<string, { jobId: string; at: string }>;
  /** A campaign copy (§39.3): the clip, and its job, it was made from. */
  remakeOf?: { clipId: string; jobId: string };
  /** Uploaded, but its posting has not started yet: the start after an Upload, Try again, Post now or connect did not go
   * through (§14.5). Confirm starts it. Absent otherwise. */
  startPending?: boolean;
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
  /** Retired by docs/CONTRACTS.md §25: stored and validated, never read or shown. Absent on old servers. */
  earningsRates?: Partial<Record<Platform, number>>;
  /** Retired by §25, like `earningsRates`. */
  earningsPaid?: Partial<Record<Platform, boolean>>;
  /**
   * Platforms the owner skipped (and confirmed) on the floating setup to-do list (docs/CONTRACTS.md §17.13). Only
   * hides their row; posting still follows `platforms` and the connected accounts. Absent on old servers: none.
   */
  setupSkipped?: Platform[];
  /** What sits behind the glass (§22). Absent until the owner saves one: then this device decides (§22.1). */
  backgroundMode?: BackgroundMode;
  /** 1 to 3 `#rrggbb` colours for the colours backdrop. Absent on old servers: the Clip Factory colours. */
  backgroundColours?: string[];
  /** See-through glass: "clear" (default) or "frosted". */
  glassStrength?: GlassStrength;
  /**
   * The AI model that makes the clips (docs/DECISIONS.md ADR-42): a key of `clipModels` in config/models.json.
   * Absent on old servers: the default (`agentModel`).
   */
  clipModel?: string;
  /** Follow creators (docs/CONTRACTS.md §24.1): "Stop all automatic clips". Absent on old servers: false. */
  followPaused?: boolean;
  /** At most this many automatic videos a day; 0 means no limit (the default). The UI never shows 0. */
  followDailyMax?: number;
  /** The shortest finished stream or video (minutes, 10 to 240) that counts. Absent on old servers: 30. */
  followMinMinutes?: number;
  /** Which notifications the owner's devices get (docs/CONTRACTS.md §32.3). Absent on old servers: the defaults. */
  notify?: NotifyChoices;
  /** My settings (§36): the owner's own post choices per platform. Absent on old servers: the defaults. */
  postPreset?: PostPreset;
}

/** §32.3: "Clips ready", "It stopped" and "Picked up" are on by default; "Every step" is off (each one shows on the phone). */
export interface NotifyChoices {
  ready: boolean;
  stopped: boolean;
  /** A stopped run picked up again. Absent on servers before it: on. */
  resumed: boolean;
  steps: boolean;
  /** Content Rewards news (§38.11): only there once the API knows it. */
  contentRewards?: boolean;
  /** "Money on hold or sent to your bank" (§40.7): only there once the API knows it (on by default). */
  getPaid?: boolean;
}

/** A device that gets notifications (GET /v1/push/devices). Its address and keys never leave the server. */
export interface PushDevice {
  deviceId: string;
  kind: "webpush";
  deviceLabel: string;
  createdAt: string;
  updatedAt: string;
}

/** PUT /v1/push/devices/{deviceId}: `PushSubscription.toJSON()` and a plain device name. */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel: string;
}

export type YoutubePrivacy = "public" | "unlisted" | "private";

/**
 * My settings (§36), one part per platform. YouTube's "who can see it" is `Settings.youtubePrivacy`, not here. There is
 * no made-for-kids field: My settings never mark a clip as made for kids. TikTok's Commercial content is per clip only.
 */
export interface YouTubePreset {
  /** A YouTube category id: "20" Gaming (the default), "24", "23", "22", "17". */
  category: string;
  notifySubscribers: boolean;
  embeddable: boolean;
}
export interface TikTokPreset {
  privacy: string;
  comments: boolean;
  duet: boolean;
  stitch: boolean;
}
export interface InstagramPreset {
  shareToFeed: boolean;
}
export type XReplies = "everyone" | "following" | "mentionedUsers" | "verified";
export interface XPreset {
  replies: XReplies;
}
export interface PostPreset {
  youtube: YouTubePreset;
  tiktok: TikTokPreset;
  instagram: InstagramPreset;
  /** Reels on a Facebook Page are public: nothing to choose. */
  facebook: Record<string, never>;
  x: XPreset;
}
/** One clip's choices sent with Upload (§36.3). TikTok's go in `tiktok` (§17.8). */
export interface YouTubeClipOptions {
  privacy: YoutubePrivacy;
  category: string;
  /** YouTube asks every creator; starts off (No). */
  madeForKids: boolean;
  notifySubscribers: boolean;
  embeddable: boolean;
}
export interface ClipPostOptions {
  youtube?: YouTubeClipOptions;
  instagram?: InstagramPreset;
  x?: XPreset;
}

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

/** What the Post to TikTok sheet adds to Upload (§17.8). */
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
  /** The Content Rewards campaign this post is for (set at creation, never changed, §38.8). */
  campaignId?: string;
  /** YouTube or X did not take the paid-partnership switch (§38.14). */
  paidLabel?: "not_set";
  /** "you": the owner posted it on TikTok himself (Post on TikTok yourself, §42). */
  by?: "you";
}

/** GET /v1/clips/{clipId}/file: a 1-hour link that saves the clip's video (§42). */
export interface ClipFile {
  url: string;
  filename: string;
}

/** POST and DELETE /v1/clips/{clipId}/tiktok/posted (§42). `note`: the link was kept, but views are not read. */
export interface TikTokMarked {
  clip: Clip;
  posts: Post[];
  note?: string;
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

/** A lesson the daily run learned from clips that did much better than normal 7 days after posting (§16.12). */
export type LessonStatus = "trial" | "active" | "off" | "expired";

export interface LessonEvidence {
  /** "creator": this creator's own clips were the yardstick; "all": every creator's clips on that platform. */
  baseline: "creator" | "all";
  /** Posted clips measured 7 days after posting. */
  measured: number;
  /** Of those, the ones that did much better than normal. */
  winners: number;
  medianViews: number | null;
  winnerViews: { clipId: string; postId: string; views: number }[];
  trait: {
    winnersWith: number;
    winnersKnown: number;
    othersWith: number;
    othersKnown: number;
    winnerPercent: number;
    otherPercent: number;
    sources: number;
  };
  computedAt: string;
}

export interface Lesson {
  lessonId: string;
  kind: "creator";
  /** "*" = all creators. */
  creatorKey: string;
  creatorName?: string;
  scope: "creator" | "all";
  platform: Platform;
  trait: string;
  traitLabel?: string;
  text: string;
  status: LessonStatus;
  evidence?: LessonEvidence;
  clipIds: string[];
  /** The winner clips it cites that still exist, with their hooks, for the links. */
  clips: { clipId: string; hook: string }[];
  createdAt: string;
  confirmedAt?: string;
  expiresAt?: string;
  updatedAt?: string;
}

/** Per creator ("*" = all creators) and platform: clips measured, winners, and how many more are needed. */
export interface LessonCreator {
  creatorKey: string;
  creatorName: string;
  platforms: Partial<Record<Platform, { measured: number; needed: number; winners: number }>>;
}

export interface LessonsView {
  lessons: Lesson[];
  creators: LessonCreator[];
  /** When the daily check last ran (absent before the first run). */
  checkedAt?: string;
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
  /** §25.3: what this platform reported this clip made (YouTube's estimate today). Absent when nothing was reported. */
  revenue?: ReportedMoney;
  /** "you": posted on TikTok by the owner himself (§42). */
  by?: "you";
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
  /** Retired with §21: still sent by the API, never read. */
  paidViews?: Partial<Record<Platform, number | null>>;
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
  /** §25.5: each platform's reported money for the week, in its own currency. Absent when nothing was reported. */
  revenueByPlatform?: Partial<Record<Platform, ReportedMoney>>;
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

// ---------- Follow creators (docs/CONTRACTS.md §24) ----------

export type FollowPlatform = "youtube" | "twitch" | "kick";
/** Where the owner pastes keys for following: Twitch, Kick, and the optional YouTube read key. */
export type FollowKeyPlatform = "twitch" | "kick" | "youtube-read";

export interface FollowLive {
  isLive: boolean;
  title?: string;
  /** Rounded to 2 figures. */
  viewers?: number;
  startedAt?: string;
  checkedAt?: string;
}

/** What Clip Factory last noticed: a stream that ended or a new video. */
export interface FollowLast {
  state: "noticed";
  text: string;
  at: string;
  videoKey?: string;
}

export interface Follow {
  /** "twitch:somestreamer" (the live event id too). */
  followId: string;
  platform: FollowPlatform;
  /** YouTube channel id (UC…), Twitch login or Kick slug. */
  platformId: string;
  handle: string;
  name: string;
  /** Only from the platforms' picture hosts; "" shows initials. */
  avatarUrl: string;
  url: string;
  /** "Make clips by itself" for this creator (used once that part ships). */
  autoClips: boolean;
  permissionAt: string;
  followedAt: string;
  /** Absent: not known yet (Twitch or Kick before the keys, YouTube without the read key). */
  live?: FollowLive;
  last?: FollowLast;
  /** false: found by name only; the name and picture fill in once the keys are pasted. */
  resolved: boolean;
}

export interface FollowCreator {
  platform: FollowPlatform;
  platformId: string;
  handle: string;
  name: string;
  avatarUrl: string;
  url: string;
  live?: FollowLive;
  resolved: boolean;
  /** Twitch or Kick without keys: following works, the live badge waits for a grown-up's keys. */
  needsKeys: boolean;
}

export type FollowLookup = { needsPlatform: true; name: string } | { needsPlatform: false; creator: FollowCreator };

export interface FollowKeyCheck {
  ok: boolean;
  code: "ok" | "no_keys" | "keys_rejected" | "platform_down";
  message: string;
  at: string;
}

export interface FollowKeySlot {
  platform: FollowKeyPlatform;
  saved: boolean;
  /** Someone the owner follows is on this platform. */
  needed: boolean;
  /** The YouTube read key: nice to have, never needed. */
  optional: boolean;
  savedAt?: string;
  hints?: Record<string, string>;
  check?: FollowKeyCheck;
}

export interface FollowsView {
  follows: Follow[];
  keys: FollowKeySlot[];
  /** Kick's app needs this webhook address (Copy chip in the Kick steps). */
  kickWebhookUrl: string;
}

export type FollowKeys = { clientId: string; clientSecret: string } | { apiKey: string };

/**
 * The live status line of a working job (docs/CONTRACTS.md §31): what it is doing right now, in one line. Every word
 * comes from the agent's fixed templates; never a command line, path, link or key.
 */
export interface JobLive {
  jobId: string;
  /** The run that wrote it (matches Job.run while it is current). */
  run?: string;
  /** The step key (resolve … finalize). */
  step: string;
  /** The big plain sentence, e.g. "Cutting clip 3 of 10". */
  text: string;
  /** The small grey detail, e.g. "0:41 of 0:58" or "412 MB of 1.2 GB · 34%". */
  detail?: string;
  /** The tiny "what is running" line, e.g. "ffmpeg · 1080×1920 · 30 fps" or "Claude Opus 5.5 · thinking". */
  tech?: string;
  /** When a model call started: the web counts the seconds itself. */
  since?: string;
  /** Clip (or part) i of n. */
  i?: number;
  n?: number;
  pct?: number;
  /** When the agent wrote it. */
  at: string;
  /** When the words last really changed (`at` also moves with the 30-second refresh). */
  lastChange?: string;
}

/** What the live connection pushes (docs/CONTRACTS.md §14.2). One message per changed item. */
export type LiveItemType = "job" | "clip" | "post" | "learning" | "week" | "setup" | "follow" | "jobLive" | "contentrewards" | "getpaid";
export type LiveEvent =
  | { type: "job"; op: "upsert"; id: string; item: Job; partial?: undefined }
  | { type: "clip"; op: "upsert"; id: string; item: Clip; partial?: undefined }
  | { type: "post"; op: "upsert"; id: string; item: Post; partial?: undefined }
  | { type: "learning"; op: "upsert"; id: string; item: Learning; partial?: undefined }
  | { type: "week"; op: "upsert"; id: string; item: WeekSummary; partial?: undefined }
  | { type: "follow"; op: "upsert"; id: string; item: Follow; partial?: undefined }
  | { type: "jobLive"; op: "upsert"; id: string; item: JobLive; partial?: undefined }
  | { type: LiveItemType; op: "delete"; id: string; item?: undefined; partial?: undefined }
  | { type: LiveItemType; op: "upsert"; id: string; partial: true; item?: undefined }
  /** §40.7: a Get paid item changed (GETPAID, PAYCONN#, PAYSTATE#, PAYOUT#): refetch GET /v1/getpaid. */
  | { type: "getpaid"; op: "upsert"; id: "getpaid"; partial: true; item?: undefined };

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
  /** Made in the desktop app: a YouTube link is fetched by this computer from the start (CONTRACTS §35.1). */
  macFetch?: boolean;
  /** Use a video file on a link job (CONTRACTS §35.8): that job stops waiting for the Mac; this file replaces it. */
  replaces?: string;
  /** Clips for this Content Rewards campaign (§38.5): only a campaign the API listed. */
  campaignId?: string;
  /** The soft stops the owner accepted with "Make clips anyway". */
  campaignAnyway?: StopCode[];
}

// ---------- Real earnings (docs/CONTRACTS.md §25) ----------

/** A platform card's state (§25.1). In the programme and Earning never go down by themselves. */
export type MoneyState =
  | "earning"
  | "in_program"
  | "goal_reached"
  | "not_yet"
  | "counting"
  | "unknown"
  | "needs_permission"
  | "not_available"
  | "not_connected"
  | "error";

export interface MoneyWhere {
  label: string;
  url?: string;
}

/** One goal from config/monetization.json measured against the account's real numbers; never money. */
export interface MoneyGoal {
  key: string;
  label: string;
  kind: "bar" | "tick" | "number";
  current: number | null;
  goal: number | null;
  reached: boolean;
  approx: boolean;
  windowDays?: number;
  note?: string;
  help?: string;
  /** The key of the goal this one is an "or" with (watch hours or Shorts views). */
  or?: string;
  /** Why there is no number (the platform did not share it, a permission is missing). */
  missing?: string;
  countingDaysLeft?: number;
  sourceUrl: string;
}

export interface MoneyDay {
  date: string;
  amountMicros: number;
}

/** Money a platform reported, in its own currency (never converted), always tagged as that platform's estimate. */
export interface MoneyRevenue {
  platform: Platform;
  currency: string;
  unit: string;
  source: string;
  /** "YouTube's estimate". */
  tag: string;
  note: string;
  month: string;
  thisMonthMicros: number;
  last30: MoneyDay[];
  months: { month: string; amountMicros: number }[];
  revised?: boolean;
}

export interface MoneyPermission {
  what: "money" | "followers";
  /** "Allow money reading" or "Allow follower reading". */
  button: string;
  steps: string[];
  copy?: { label: string; value: string }[];
  open?: { label: string; url: string };
}

export interface MoneyCard {
  platform: Platform;
  state: MoneyState;
  /** Fixed short text for the state pill. */
  pill: string;
  /** One plain sentence. */
  line: string;
  programme: string;
  statusWhere: MoneyWhere;
  paidWhere: MoneyWhere;
  goals: MoneyGoal[];
  more: MoneyGoal[];
  extras: string[];
  checkedAt?: string;
  detectedAt?: string;
  earningSince?: string;
  lastError?: string;
  lagNote?: string;
  revenue?: MoneyRevenue;
  approxMonth?: { month: string; amountMicros: number; currency: string; source: string; tag: string; note: string };
  split?: { month: string; shortsMicros?: number; longMicros?: number; liveMicros?: number };
  notShared?: string;
  comingSoon?: string;
  needsPermission?: MoneyPermission;
}

export interface MoneyCelebration {
  key: string;
  platform: Platform;
  kind: "goal" | "in_program" | "first_money";
  text: string;
}

export interface MoneyView {
  platforms: MoneyCard[];
  country: string | null;
  countries: { code: string; name: string }[];
  /** Earning platforms only, one line per currency. */
  thisMonth: { currency: string; amountMicros: number; platforms: Platform[] }[];
  celebrations: MoneyCelebration[];
  nextCheckAllowedAt?: string;
  asOf: string;
}

/** A Post's money as its platform reported it (only YouTube today), for the clip page. */
export interface ReportedMoney {
  platform: Platform;
  amountMicros: number;
  currency: string;
  source: string;
  through?: string | null;
  tag: string;
}

// ---------- Money dashboard (docs/CONTRACTS.md §27) ----------

export type MoneyChart = 7 | 30 | 90 | 365;
export type MoneyClipPeriod = 7 | 30 | 90 | "all";
export type MoneyClipSort = "money" | "views";

/** Why an app is left out of the totals (§27.3). Never a number. */
export interface MoneyExcluded {
  platform: Platform;
  /** `behind`: its newest day is over 6 days old while another app is up to date. `error`: its check failed and
   * nothing is stored yet. */
  reason: "not_shared" | "coming_soon" | "not_connected" | "needs_permission" | "no_money_yet" | "behind" | "error";
  text: string;
  where?: MoneyWhere;
}

/** The comparison chip's data, worked out on the server: the web only words it. */
export interface MoneyChange {
  previousPeriodMicros: number | null;
  changePct: number | null;
  direction: "up" | "down" | "same" | "new" | "none";
}

export interface MoneyChartPoint {
  start: string;
  end: string;
  amountMicros: number;
  byPlatform: Partial<Record<Platform, number>>;
  partial?: true;
}

/** One currency's cards (never converted or added to another currency). */
export interface MoneyCurrencySummary {
  currency: string;
  /** "YouTube's estimate", "Meta's estimate" or "Apps' estimates". */
  tag: string;
  platforms: Platform[];
  /** The days of the last 30 that stored history covers (30 once it reaches that far): Daily and the pace use it. */
  coveredDays: number;
  monthly: { amountMicros: number; from: string; to: string } & MoneyChange;
  weekly: { amountMicros: number; from: string; to: string } & MoneyChange;
  daily: { averageMicros: number; from: string; to: string; latest: { date: string; amountMicros: number } | null } & MoneyChange;
  /** `paceMicros` is Monthly × 12 (over the covered days while under 30), always shown as "at this pace";
   * `last365Micros` a real sum once covered. */
  yearly: { paceMicros: number; last365Micros: number | null };
  chart: { period: MoneyChart; bucket: "day" | "week"; from: string; to: string; points: MoneyChartPoint[] };
}

/** GET /v1/money/summary (§27.5). */
export interface MoneySummary {
  platforms: Platform[];
  included: Platform[];
  excluded: MoneyExcluded[];
  /** yyyy-mm-dd: the earliest newest reported day across the counted apps; every period ends here. */
  through: string | null;
  throughBy: Partial<Record<Platform, string>>;
  historyFrom: Partial<Record<Platform, string>>;
  lagNote?: string;
  /** Biggest monthly first; empty when nothing can be counted. */
  currencies: MoneyCurrencySummary[];
  revised: { days: number; platforms: Platform[] };
  errors: { platform: Platform; text: string; checkedAt?: string }[];
  /** Apps whose newest day is over 6 days old (left out while another app is current; all of them when `stale`). */
  behind: Platform[];
  stale: boolean;
  asOf: string;
}

export interface MoneyClipLine {
  platform: Platform;
  postId: string;
  url?: string;
  postedAt: string;
  /** Lifetime views, "so far". */
  views: number | null;
  money: { amountMicros: number; currency: string; from: string | null; to: string; tag: string; source: string } | null;
  /** Only YouTube, only from the same report as the money, only from 1,000 views. */
  per1000Views: { amountMicros: number; currency: string; views: number; tag: string } | null;
  moneyState: "reported" | "not_shared" | "coming_soon" | "not_reported_yet" | "needs_permission" | "not_connected";
}

export interface MoneyClip {
  clipId: string;
  title: string;
  coverUrl?: string;
  firstPostedAt: string;
  views: number | null;
  totals: { currency: string; amountMicros: number }[];
  platforms: MoneyClipLine[];
}

/** GET /v1/money/clips (§27.5). */
export interface MoneyClips {
  period: MoneyClipPeriod;
  from: string | null;
  to: string | null;
  sort: MoneyClipSort;
  sortedBy: MoneyClipSort;
  note?: string;
  clips: MoneyClip[];
  nextCursor?: string;
}

export interface MoneyClipsQuery {
  platforms: Platform[];
  period: MoneyClipPeriod;
  sort: MoneyClipSort;
  cursor?: string;
  limit?: number;
}

/** The result codes the money grant sends back to /settings/posting/money?result=…&platform=… (§25.4). */
export type MoneyResult =
  | "money_allowed"
  | "money_denied"
  | "money_missing"
  | "money_not_connected"
  | "money_wrong_account"
  | "money_error";

/** §34: what happens to a deleted job's clips still waiting in Review ("keep" unless the owner ticked the box). */
export type JobDeleteClips = "keep" | "delete";
/** §34: one deleted job. Kept, posting and posted clips are never deleted and count in `clipsKept`. */
export interface JobDeleted {
  jobId: string;
  deleted: boolean;
  clipsDeleted: number;
  clipsKept: number;
}

// ---------- Content Rewards campaigns (docs/CONTRACTS.md §38.8; shared contract, never changed alone) ----------

export type StopCode =
  | "not_connected"
  | "not_checked"
  | "not_joined"
  | "apply_first"
  | "waiting"
  | "left"
  | "not_accepted"
  | "rules_reading"
  | "rules_failed"
  | "paused"
  | "ended"
  | "deadline"
  | "budget_gone"
  | "budget_half"
  | "low_rate"
  | "logo_missing"
  | "tiktok_only"
  | "no_place"
  | "held"
  | "cap_reached"
  | "drafts_first"
  | "sound_needed"
  | "overlay_needed"
  | "face_needed"
  | "spoken_needed"
  | "audience";
export type Membership = "unknown" | "not_joined" | "apply_first" | "waiting" | "in" | "left" | "not_accepted" | "manual";
export type CrConnectResult = "connected" | "read_only" | "denied" | "expired" | "not_allowed" | "no_port" | "cr_down" | "busy" | "error";
export interface CrCheck {
  at: string;
  ok: boolean;
  code: "ok" | "read_only" | "not_connected" | "token_dead" | "missing_permissions" | "blocked" | "cr_down";
  message: string;
}
export interface CrConnection {
  status: "not_connected" | "connected" | "read_only" | "needs_reconnect";
  connectedAt?: string;
  /** connectedAt + 90 days. */
  signInBy?: string;
  /** signInBy − 7 days. */
  warnFrom?: string;
  /** my_submissions:write granted and create_my_submission offered. */
  canSubmit: boolean;
  missing?: string[];
  reason?: "token_dead" | "signed_out_90_days" | "missing_permissions" | "expires_soon";
  blocked?: boolean;
  /** Learned from CR's answers; absent = unknown. */
  crLinked: Partial<Record<Platform, boolean>>;
  /** CR_GUIDE ids the owner ticked ("I did this"). */
  stepsDone: string[];
  /** "Do you see Finance?" (§38.7); absent = not asked. */
  finance?: boolean;
  pilotSentAt?: string;
  lastResult?: CrConnectResult;
  check?: CrCheck;
  pilotEmail: { to: string; subject: string; body: string; mailto: string };
}
export interface CrPay {
  platform: Platform;
  per1kCents: number | null;
  perPostCents: number | null;
  minPayoutCents: number | null;
  maxPayoutCents: number | null;
  minViews: number | null;
  countryRates?: { name: string; per1kCents: number; countries: string[] }[];
  otherCountriesPer1kCents?: number | null;
  unknownCountryPer1kCents?: number | null;
}
export interface CampaignStop {
  code: StopCode;
  hard: boolean;
  text: string;
  fixHref?: string;
  anyway?: boolean;
}
export type NextStepKind =
  | "connect"
  | "check_yourself"
  | "join"
  | "applied"
  | "wait"
  | "rules_paste"
  | "logo"
  | "anyway"
  | "pick_video"
  | "make_clips"
  | "pick_another"
  | "stop"
  | "none";
export type SaidAnswer = "applied" | "not_eligible" | "joined_by_hand";
export interface NextStep {
  kind: NextStepKind;
  chip: string;
  text: string;
  sub?: string;
  /** The vermilion one. */
  button?: { label: string; href?: string; external: boolean; action?: "logo_picker" | "anyway" | "read_rules" | "said_applied" };
  /** Quiet green asks. */
  asks?: { label: string; said: SaidAnswer; text?: string }[];
  glass?: { label: string; href: string; external: boolean }[];
}
export type SourceKind = "video_file" | "google_drive" | "dropbox" | "youtube" | "twitch" | "kick" | "other";
export interface CampaignRules {
  lengthMinSec: number | null;
  lengthMaxSec: number | null;
  requiredHashtags: string[];
  requiredTags: string[];
  requiredCaptionText: string | null;
  disclosure: { caption: "#Ad" | "#ad" | "#Sponsored" | "#sponsored" | "#PaidPartnership"; onScreen: string; spoken: boolean };
  logo: { required: boolean; rules: string | null };
  overlayRequired: boolean;
  coverImageRequired: boolean;
  layoutNotes: string | null;
  language: string | null;
  bannedContent: string[];
  sourceVideos: { url: string; kind: SourceKind; note: string | null }[];
  allowedSources: {
    campaignProvidedOnly: boolean;
    youtube: boolean;
    twitch: boolean;
    kick: boolean;
    channels: { name: string; url: string | null }[];
    notes: string | null;
  };
  clipUntil: string | null;
  keepPublicDays: number | null;
  minViewsForPayout: number | null;
  postSubmissionRules: { text: string; afterHours: number | null; atViews: number | null; where: string | null }[];
  audience: string | null;
  draftsFirst: boolean;
  soundRequired: boolean;
  faceOnCamera: boolean;
  otherRules: string[];
  uncertain: string[];
}
export interface Campaign {
  /** CR's uuid, lowercase. */
  campaignId: string;
  /** https://contentrewards.com/c/campaigns/{uuid} */
  url: string;
  name: string;
  brand: string;
  /** Presigned GET, 1 h. */
  brandPictureUrl?: string;
  access: "open" | "application";
  type: "cpm" | "per_post" | "pool" | "retainer" | "other";
  state: "active" | "paused" | "ended" | "scheduled" | "unknown";
  membership: Membership;
  inSince?: string;
  waitingSince?: string;
  said?: SaidAnswer;
  /** When "I joined, but it still says not joined" shows. */
  canSayInBy?: string;
  pay: CrPay[];
  budget: { totalCents: number | null; spentCents: number | null; leftCents: number | null; usedPct: number | null; asOf?: string };
  platformsPaid: Platform[];
  uploadPlaces: Platform[];
  placesNote?: string;
  rulesState: "reading" | "ready" | "failed" | "waiting_for_join";
  rules: CampaignRules | null;
  plainRules: string[];
  thingsYouDo: string[];
  uncertain: string[];
  rulesAt?: string;
  logo: { needed: boolean; state: "none" | "fetching" | "ready" | "failed"; url?: string; error?: string };
  sourceVideos: { url: string; kind: SourceKind; note: string | null; canMakeClips: boolean }[];
  /** https, §38.10. */
  channels: { name: string; href: string }[];
  stops: CampaignStop[];
  anyway: StopCode[];
  nextStep: NextStep;
  clipCounts: { approved: number; waiting: number; notApproved: number };
  /** This campaign's CR submissions still pending. */
  waitingClips: number | null;
  celebrate?: "in";
  checkedAt: string;
  nextCheckAt?: string;
  addedAt: string;
  /**
   * The campaign's source rule as one line under Home's link box (§39.1): "FaZe Clips pays only for clips of FaZe's
   * YouTube and Twitch." null when it has none; absent on an API from before §39 (then no line shows).
   */
  sourceRuleText?: string | null;
  /** "FaZe Clips wants clips in English." null when it has none; absent before §39. */
  languageRuleText?: string | null;
}
export type CampaignSummary = Pick<
  Campaign,
  "campaignId" | "name" | "brand" | "brandPictureUrl" | "state" | "membership" | "uploadPlaces" | "waitingClips" | "clipCounts" | "celebrate" | "checkedAt"
> & {
  chip: string;
  nextStepText: string;
  hardStops: number;
  /** The `kind` of the campaign's next step (§39.1); absent on an API from before §39. */
  nextStepKind?: NextStepKind;
};
export interface GroupChoice {
  campaignId: string;
  url: string;
  name: string;
  brand: string | null;
  access: "open" | "application" | null;
  /** Only when the one group read had it. */
  pay: CrPay[] | null;
}
export type CrReasonCode =
  | "private"
  | "not_listed"
  | "not_linked"
  | "not_on_application"
  | "relink"
  | "wrong_place"
  | "too_short"
  | "held"
  | "account_refused"
  | "sound_needed"
  | "drafts_first"
  | "campaign_closed"
  | "campaign_refused"
  | "refused"
  | "banned"
  | "cap"
  | "not_sent_by_app"
  | "not_visible_yet"
  | "no_connection"
  | "read_only"
  | "manual"
  | "ambiguous"
  | "window_over";
export type CrSubState = "waiting_for_post" | "sending" | "sent" | "approved" | "rejected" | "send_by_hand" | "sent_by_hand" | "missed" | "not_sent";
export interface CrSubmission {
  postId: string;
  clipId: string;
  clipTitle: string;
  campaignId: string;
  campaignName: string;
  platform: Platform;
  url?: string;
  postedAt?: string;
  state: CrSubState;
  /** The §38.6 sentence. */
  line: string;
  minutesLeft?: number;
  sendBy?: string;
  reason?: { code: CrReasonCode; text: string; brandSaid?: string };
  flagged?: boolean;
  removed?: boolean;
  postGone?: boolean;
  paidLabel?: "not_set";
  views: number | null;
  viewsAt?: string;
  /** CR's payouts for this submission, net of fees. */
  earned: { paidCents: number; pendingCents: number } | null;
  appeal?: { href: string; words: string; askedAt?: string };
  proof?: { text: string; steps: string[]; dueAt: string; due: boolean; open?: { label: string; href: string }; doneAt?: string };
  openCampaignHref: string;
  sentAt?: string;
  reviewedAt?: string;
  updatedAt: string;
}
export interface CrMoney {
  state: "ok" | "checking" | "none_yet" | "not_connected" | "needs_reconnect" | "error";
  tag: "Content Rewards' numbers";
  asOf?: string;
  error?: string;
  stillEarningCents: number | null;
  onItsWayCents: number | null;
  readyToMoveCents: number | null;
  /** null until the list was read to its end. */
  paidSoFarCents: number | null;
  lastPaidAt?: string;
  lastPaidCents?: number;
  /** Campaign clips CR still has pending at $0. */
  waitingForBrand: number;
  campaigns: { campaignId?: string; name: string; paidCents: number; pendingCents: number }[];
  celebrations: { key: string; kind: "first_money" | "money_arrived" | "can_move"; text: string }[];
  /**
   * When Clip Factory last saw a move to Whop finish (On its way went back to 0 after being above 0), ISO. Additive:
   * absent on an API from before it, null before any move. The bank step leads on every device from it (§38.7).
   */
  movedAt?: string | null;
}
/** GET /v1/contentrewards: reads items only, never calls CR. */
export interface CrOverview {
  connection: CrConnection;
  campaigns: CampaignSummary[];
  money: CrMoney;
  /** send_by_hand with time left. */
  waitingSends: CrSubmission[];
}
export type CrConnectionPatch =
  /** "cant_connect": he says Content Rewards refused at sign-in (it never sends the browser back). The API sets
   * lastResult not_allowed and ticks ready-account; an older API answers 400. */
  | { said: "pilot_sent" | "cant_connect" | null }
  | { step: string; done: boolean }
  | { relinked: Platform }
  | { finance: boolean | null };
export type CrFinishBody = { state: string; code: string; iss?: string } | { state: string; error: string; errorDescription?: string };
export type CrAddResult = { campaign: Campaign; group?: undefined } | { group: { name: string; choices: GroupChoice[] }; campaign?: undefined };
export type CrSubmissionSaid = "sent_by_hand" | "appealed" | "proof_sent" | null;

// ---------- Content Rewards: does this clip fit the campaign? (docs/CONTRACTS.md §39.3; shared contract) ----------

export type FitVerdict = "fits" | "fixable" | "wait" | "doesnt_fit" | "cant_tell";
export type FitState = "ok" | "fix" | "remake" | "todo" | "no" | "check" | "note";
export type FitRule =
  | "campaign"
  | "soft"
  | "deadline"
  | "length"
  | "places"
  | "place_link"
  | "tags"
  | "ad"
  | "paid_switch"
  | "logo"
  | "on_screen"
  | "source"
  | "language"
  | "banned"
  | "spoken"
  | "uncertain"
  | "brief_only"
  | "posted"
  | "one_campaign"
  | "send";
export interface FitFix {
  kind: "captions" | "tiktok_branded" | "remake" | "new_clips" | "open";
  label: string;
  href?: string;
  external?: boolean;
}
export interface FitItem {
  rule: FitRule;
  state: FitState;
  text: string;
  fix: FitFix | null;
  platform?: Platform;
}
export interface CampaignFit {
  campaignId: string;
  campaignName: string;
  verdict: FitVerdict;
  headline: string;
  canUpload: boolean;
  canRemake: boolean;
  /** Problems first, then ok. */
  items: FitItem[];
  /** Unaccepted soft stops, sent with the copy. */
  softCodes: string[];
  /** For the card's live check. */
  required: { disclosure: string; tokens: string[]; phrase: string | null };
  uploadPlaces: Platform[];
  checkedAt: string;
}
export interface ClipFit {
  clipId: string;
  /** campaign: exactly one fit. */
  mode: "campaign" | "normal";
  fits: CampaignFit[];
  suggestion: { campaignId: string; name: string } | null;
  remakes: Record<string, { jobId: string; at: string }>;
}
export interface CrRemakeBody {
  clipId: string;
  macFetch?: boolean;
  campaignAnyway?: string[];
}

// ---------- All your money in one place (docs/CONTRACTS.md §39.2; shared contract) ----------

export type MoneyPlaceId = Platform | "contentrewards";
export interface MoneyPlace {
  place: MoneyPlaceId;
  name: string;
  state: "number" | "not_available" | "coming_soon" | "not_set_up" | "needs_ok" | "waiting" | "error" | "sign_in";
  /** "YouTube says", "Not available from TikTok", … */
  headline: string;
  /** [] in every state but `number`. */
  amounts: { currency: string; amountMicros: number }[];
  tag?: string;
  why?: string;
  note?: string;
  where?: { text: string; button?: { label: string; url: string } };
  button?: { label: string; href: string; external: boolean };
  checkedAt?: string;
  cr?: {
    stillEarningCents: number | null;
    onItsWayCents: number | null;
    readyToMoveCents: number | null;
    paidSoFarCents: number | null;
    lastPaidAt?: string;
    asOf?: string;
    movedOut: "not_available";
  };
  /** §40.4 (additive): what Google or Whop say they sent toward his bank, or where to look. */
  sent?: SentLine;
}
export interface MoneyEverywhere {
  from: string;
  to: string;
  /** "30 days up to Sat 16 Nov" */
  periodText: string;
  lagNote?: string;
  /** STATS_ORDER, then contentrewards when switched on. */
  places: MoneyPlace[];
  /** Biggest first. */
  totals: { currency: string; amountMicros: number; places: MoneyPlaceId[]; tag: string }[];
  notCounted: { place: MoneyPlaceId; state: MoneyPlace["state"] }[];
  notCountedText?: string;
  /** §40.4 (additive): "Sent to your bank, so far": one line per money type, never added to the 30-day total. */
  sent?: MoneySentBlock;
  asOf: string;
}

// ---------- Get paid (docs/CONTRACTS.md §40.7; shared contract, made by the API) ----------

export type GetPaidPlace = Platform | "contentrewards";
export type GetPaidStatus = "on_hold" | "not_allowed" | "can_get_paid" | "not_set_up" | "you_said_done" | "checking" | "not_connected" | "not_started";
export type KnownBy = "youtube" | "whop" | "contentrewards" | "instagram" | "facebook" | "tiktok" | "x" | "rules" | "you" | "clipfactory";

/** One place's "Sent to your bank" line (§40.4). Amounts only in `number`, never converted, never $0. */
export interface SentLine {
  state: "number" | "none_yet" | "not_available" | "needs_reading" | "checking" | "error";
  /** "Sent to your bank by Google" | "Not available from TikTok" | … */
  headline: string;
  amounts: { currency: string; amountMicros: number }[];
  /** "YouTube says" | "Whop says" */
  tag?: string;
  why?: string;
  /** "1 payment isn't added up: Clip Factory couldn't tell its money type." */
  notAdded?: string;
  arrive?: string;
  note?: string;
  last?: { date: string; amountMicros: number | null; currency: string | null; text?: string };
  where?: { text: string; button?: { label: string; url: string } };
  button?: { label: string; href: string; external: boolean };
}

/** All your money's "Sent to your bank, so far" block (§40.4). */
export interface MoneySentBlock {
  totals: { currency: string; amountMicros: number; places: MoneyPlaceId[]; names: string }[];
  /** "Google and Whop say they sent it." */
  tag: string;
  notAdded?: string;
  notCountedText?: string;
  /** "Clip Factory can't see your bank. Look in your bank's app to see what arrived." */
  bankText: string;
  /** Only with no sent rows at all: "Nothing sent to your bank yet." */
  empty?: string;
}

export interface GetPaidNext {
  /** The step whose main action is the page's vermilion; null: a hold's fix, a reconnect or the Finance question. */
  stepId: string | null;
  label: string;
  href: string;
  external: boolean;
  /** "Next: step 3, Add your bank." (none for a null step id, except the Finance question) */
  text?: string;
  /** HOLD_FIX's line ("Look for the red message on **Payments**. Do what it says.") */
  hint?: string;
  /** false for a step that costs money (X Premium): never the vermilion. */
  vermilion: boolean;
}

export interface GetPaidCard {
  place: GetPaidPlace;
  name: string;
  status: GetPaidStatus;
  /** "Can get paid ✓ (YouTube says)" */
  pill: string;
  tone: "success" | "neutral" | "warn" | "error";
  knownBy: KnownBy;
  /** "YouTube says" | "You said it's done" | "Your steps" | "Instagram's rules" */
  known: string;
  line: string;
  missing: string[];
  holds: string[];
  /** X only. */
  warning?: string;
  /** "Clip Factory can see payments: on" | "… off" (YouTube; Content Rewards while WHOP_CONNECT is on) */
  readingChip?: string;
  next: GetPaidNext | null;
  steps: { id: string; done: boolean; by: "you" | "auto" | null; auto?: string }[];
  /** The numbered earn and payout steps only (never yt-reading or an each-time step). */
  ring: { done: number; total: number };
  /** "What Clip Factory can see", at most 6 lines. */
  seen: string[];
  sent: SentLine;
  /** YouTube only: Google's own words for what waits to be paid (never in a total). */
  unpaid?: { text: string; note: string };
  checkedAt?: string;
  lastError?: string;
}

export interface PayoutRow {
  date: string;
  by: "Google" | "Whop";
  state: "sent" | "on_its_way" | "didnt_go_through" | "came_back" | "gone";
  amountMicros: number | null;
  currency: string | null;
  /** Google's own words when Clip Factory couldn't read the money type. */
  text?: string;
  /** Whop's estimated_arrival. */
  arriveBy?: string;
}

export interface PayConn {
  source: "adsense" | "whop";
  status: "not_connected" | "keys_saved" | "connected" | "needs_reconnect";
  /** "Main AdSense (…1234)" | "@name" */
  accountName?: string;
  connectedAt?: string;
  reason?: "token_dead" | "keys_changed";
  keyHint?: string;
  /** Whop only: the Copy chip for Whop's Redirect URIs. */
  redirectUri?: string;
  lastResult?: string;
}

export interface GetPaid {
  /** YouTube, TikTok, Instagram, Facebook, X, then Content Rewards while it is on. */
  places: GetPaidCard[];
  summary: string;
  country: string | null;
  /** whop: null while WHOP_CONNECT is off. */
  connections: { adsense: PayConn; whop: PayConn | null };
  /** GETPAID ticks (Content Rewards' stay on CRCONN). */
  stepsDone: string[];
  nextCheckAllowedAt?: string;
  asOf: string;
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
  /** Mac fetches it (§35.3): progress, the signed part addresses for the video, and finishing the upload. */
  macProgress(jobId: string, body: MacProgress): Promise<Job>;
  macSourceUpload(jobId: string, body: { deviceId: string; size: number }): Promise<MacUploadParts>;
  macSourceComplete(
    jobId: string,
    body: { deviceId: string; parts: { n: number; etag: string }[]; title?: string; creator?: string; durationSec?: number },
  ): Promise<Job>;
  /** DELETE /v1/jobs/{jobId} (§34): a working job is stopped first; idempotent (`deleted: false` when not there). */
  deleteJob(jobId: string, clips?: JobDeleteClips): Promise<JobDeleted>;
  /** POST /v1/jobs/delete (§34): up to 25 jobs at once, one result each, in order. */
  deleteJobs(jobIds: string[], clips?: JobDeleteClips): Promise<JobDeleted[]>;
  listClips(query?: { status?: ClipFilter; jobId?: string }): Promise<Clip[]>;
  getClip(clipId: string): Promise<Clip>;
  updateClip(clipId: string, captions: Partial<Captions>): Promise<Clip>;
  /** `tiktok` carries the Post to TikTok sheet's choices (§17.8). */
  /**
   * Upload a clip (§14.5, §33). `platforms`: exactly where it goes (each must be set up); left out, Settings › Where
   * clips go decides (older clients). On an uploaded clip, `platforms` names the failed places to try again.
   */
  confirmClip(
    clipId: string,
    captions?: Partial<Captions>,
    tiktok?: TikTokPostOptions,
    platforms?: Platform[],
    options?: ClipPostOptions,
  ): Promise<{ clip: Clip; posts: Post[] }>;
  declineClip(clipId: string): Promise<Clip>;
  /** GET /v1/clips/{clipId}/file: a link that saves the clip's video (Save the video, §42). */
  clipFile(clipId: string): Promise<ClipFile>;
  /** POST /v1/clips/{clipId}/tiktok/posted: the owner posted it on TikTok himself; `link` gives its views (§42). */
  markTikTokPosted(clipId: string, link?: string, since?: string): Promise<TikTokMarked>;
  /** DELETE /v1/clips/{clipId}/tiktok/posted: Undo of "I posted it" (§42). */
  undoTikTokPosted(clipId: string): Promise<TikTokMarked>;
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
  // Notifications (§32.3)
  /** GET /v1/push/key: the public key for `pushManager.subscribe`. 503 until the deploy made one. */
  pushKey(): Promise<string>;
  /** GET /v1/push/devices. */
  listPushDevices(): Promise<PushDevice[]>;
  /** PUT /v1/push/devices/{deviceId}: idempotent. */
  savePushDevice(deviceId: string, body: PushSubscriptionBody): Promise<PushDevice>;
  /** DELETE /v1/push/devices/{deviceId}. */
  deletePushDevice(deviceId: string): Promise<void>;
  /** POST /v1/push/test: "Notifications are on 🎉" to this device (or every device). 429 within 10 s. */
  sendTestPush(deviceId?: string): Promise<{ sent: number; devices: number }>;
  createCookiesUpload(filename: string): Promise<PresignedPut>;
  deleteCookies(): Promise<void>;
  listAccounts(): Promise<Account[]>;
  /**
   * POST /v1/accounts/{platform}/connect: where to send the owner to approve (same tab). `grant: "money"` is "Allow
   * money reading" (§25.4): YouTube and TikTok only, merged into the existing connection. `grant: "payments"` is
   * "Allow payment reading" (§40.6): YouTube only, its own connection (PAYCONN#adsense).
   */
  connectAccount(platform: Platform, grant?: "money" | "payments"): Promise<{ authorizeUrl: string; expiresAt: string }>;
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
  /** GET /v1/lessons: Settings › Clip making › What it learned (§16.12). */
  listLessons(): Promise<LessonsView>;
  /** PATCH /v1/lessons/{lessonId} `{ status: "off" | "on" }`. */
  setLessonStatus(lessonId: string, to: "off" | "on"): Promise<Lesson>;
  /** DELETE /v1/lessons/{lessonId}. */
  deleteLesson(lessonId: string): Promise<void>;
  similarClips(clipId: string): Promise<SimilarClip[]>;
  /** GET /v1/clips/{clipId}/performance (§16.2). */
  clipPerformance(clipId: string): Promise<ClipPerformance>;
  /** POST /v1/clips/{clipId}/stats/refresh: one result per platform asked (default all five). */
  refreshStats(clipId: string, platforms?: Platform[]): Promise<RefreshResult[]>;
  /** GET /v1/weeks/{week}?from=&to= */
  getWeek(week: string, from: string, to: string): Promise<WeekView>;
  /** PUT /v1/weeks/{week}/best: 202 when the picks changed (learning starts), 200 when they did not. */
  saveWeekBest(week: string, body: { from: string; to: string; clipIds: string[] }): Promise<WeekView>;
  // Real earnings (§25.5)
  /** GET /v1/money. */
  getMoney(): Promise<MoneyView>;
  /** POST /v1/money/refresh: Check now, at most once an hour. */
  refreshMoney(): Promise<{ started: boolean; nextAllowedAt?: string | null }>;
  /** POST /v1/money/seen: a celebration was shown (it never plays again). */
  seenMoney(key: string): Promise<MoneyView>;
  /** PUT /v1/money/country. */
  setMoneyCountry(country: string): Promise<MoneyView>;
  /** GET /v1/money/summary?platforms=&chart= (§27.5): an empty list means every app. */
  getMoneySummary(platforms: Platform[], chart: MoneyChart): Promise<MoneySummary>;
  /** GET /v1/money/clips?platforms=&period=&sort=&cursor=&limit= (§27.5). */
  getMoneyClips(query: MoneyClipsQuery): Promise<MoneyClips>;
  // Follow creators (§24.1)
  /** GET /v1/follows: the follows, the key slots and the Kick webhook address. */
  listFollows(): Promise<FollowsView>;
  /** POST /v1/follows/lookup: a link or a name (with the platform once the owner picked one). */
  lookupFollow(text: string, platform?: FollowPlatform): Promise<FollowLookup>;
  /** POST /v1/follows, only after "Yes, they said I can". */
  follow(platform: FollowPlatform, platformId: string): Promise<Follow>;
  /** PATCH /v1/follows/{platform}/{platformId} `{ autoClips }`. */
  setFollowAuto(platform: FollowPlatform, platformId: string, on: boolean): Promise<Follow>;
  /** DELETE /v1/follows/{platform}/{platformId}: only this follow; noticed streams and jobs stay. */
  unfollow(platform: FollowPlatform, platformId: string): Promise<void>;
  /** PUT /v1/follows/keys/{platform}: masked hints come back, never a key. */
  saveFollowKeys(platform: FollowKeyPlatform, keys: FollowKeys): Promise<FollowsView>;
  /** DELETE /v1/follows/keys/{platform}. */
  deleteFollowKeys(platform: FollowKeyPlatform): Promise<void>;
  /** POST /v1/follows/keys/{platform}/check. */
  checkFollowKeys(platform: FollowKeyPlatform): Promise<{ check: FollowKeyCheck } & FollowsView>;
  // Content Rewards campaigns (§38.8). An api from before §38 answers 404; switched off, 503 `unavailable`.
  /** GET /v1/contentrewards. */
  crOverview(): Promise<CrOverview>;
  /** POST /v1/contentrewards/connect `{ port }` (47811–47815). */
  crConnect(port: number): Promise<{ authorizeUrl: string; expiresAt: string }>;
  /** POST /v1/contentrewards/connect/finish. */
  crConnectFinish(body: CrFinishBody): Promise<{ result: CrConnectResult; connection: CrConnection }>;
  /** POST /v1/contentrewards/check (at most once a minute; else the stored check). */
  crCheck(): Promise<{ check: CrCheck; connection: CrConnection }>;
  /** PATCH /v1/contentrewards/connection. */
  crPatchConnection(body: CrConnectionPatch): Promise<CrConnection>;
  /** DELETE /v1/contentrewards/connection: campaigns, clips and money stay. */
  crDisconnect(): Promise<void>;
  /** GET /v1/contentrewards/campaigns (newest added first). */
  crCampaigns(): Promise<CampaignSummary[]>;
  /** POST /v1/contentrewards/campaigns `{ url }`: the campaign (new or already added), or a group to pick from. */
  crAddCampaign(url: string): Promise<CrAddResult>;
  /** GET /v1/contentrewards/campaigns/{campaignId}. */
  crCampaign(campaignId: string): Promise<Campaign>;
  /** POST …/campaigns/{campaignId}/read: Check now, with the owner's pasted rules when given. */
  crReadCampaign(campaignId: string, pastedRules?: string): Promise<Campaign>;
  /** PATCH …/campaigns/{campaignId} `{ said?, anyway? }`. */
  crPatchCampaign(campaignId: string, body: { said?: SaidAnswer | null; anyway?: StopCode[] }): Promise<Campaign>;
  /** POST …/campaigns/{campaignId}/logo: a presigned PUT for the logo file. */
  crLogoUpload(campaignId: string, body: { filename: string; contentType: "image/png" | "image/jpeg" | "image/webp"; size: number }): Promise<PresignedPut>;
  /** POST …/campaigns/{campaignId}/logo/done `{ key }`. */
  crLogoDone(campaignId: string, key: string): Promise<Campaign>;
  /** POST …/campaigns/{campaignId}/logo/link `{ url }` (a Google Drive or Dropbox link). */
  crLogoLink(campaignId: string, url: string): Promise<Campaign>;
  /** DELETE …/campaigns/{campaignId}/logo. */
  crDeleteLogo(campaignId: string): Promise<Campaign>;
  /** DELETE …/campaigns/{campaignId}: only Clip Factory's copy. */
  crRemoveCampaign(campaignId: string): Promise<void>;
  /** GET /v1/contentrewards/submissions?clipId=&campaignId= */
  crSubmissions(query: { clipId?: string; campaignId?: string }): Promise<CrSubmission[]>;
  /** POST /v1/contentrewards/submissions/check `{ clipId }`. */
  crCheckSubmissions(clipId: string): Promise<CrSubmission[]>;
  /** POST …/submissions/{postId}/send: Try sending again. */
  crSendSubmission(postId: string): Promise<CrSubmission>;
  /** PATCH …/submissions/{postId} `{ said }`. */
  crPatchSubmission(postId: string, said: CrSubmissionSaid): Promise<CrSubmission>;
  /** GET /v1/contentrewards/money. */
  crMoney(): Promise<CrMoney>;
  /** POST /v1/contentrewards/money/refresh (one read every 10 minutes). */
  crRefreshMoney(): Promise<{ started: boolean; nextAllowedAt: string }>;
  /** POST /v1/contentrewards/seen `{ key }`: a celebration or "You're in!" was shown. */
  crSeen(key: string): Promise<void>;
  // §39 (an API before it answers 404; Content Rewards switched off, 503 `unavailable`).
  /** GET /v1/contentrewards/fit?clipId= */
  crFit(clipId: string): Promise<ClipFit>;
  /** GET /v1/contentrewards/fit?clipIds= (at most 20). */
  crFits(clipIds: string[]): Promise<ClipFit[]>;
  /** POST /v1/contentrewards/fit/captions: the card's captions with #Ad first and every required item back. */
  crFitCaptions(body: { clipId: string; campaignId: string; captions: Captions }): Promise<Captions>;
  /** POST /v1/contentrewards/campaigns/{campaignId}/remake: a campaign copy of the clip (202 new, 200 already made). */
  crRemake(campaignId: string, body: CrRemakeBody): Promise<Job>;
  /** GET /v1/money/everywhere: All your money (§39.2). */
  getMoneyEverywhere(): Promise<MoneyEverywhere>;
  // Get paid (§40.7). An API from before §40 answers 404.
  /** GET /v1/getpaid. */
  getPaid(): Promise<GetPaid>;
  /** GET /v1/getpaid/{place}: the card and the payouts (newest first, at most 36). */
  getPaidPlace(place: GetPaidPlace): Promise<{ card: GetPaidCard; payouts: PayoutRow[] }>;
  /** PATCH /v1/getpaid/steps `{ step, done }` (Content Rewards' steps stay on PATCH /v1/contentrewards/connection). */
  setGetPaidStep(step: string, done: boolean): Promise<GetPaid>;
  /** DELETE /v1/getpaid/connections/adsense: "Stop payment reading" (no call to Google's revoke). */
  stopPaymentReading(): Promise<void>;
  /** PUT /v1/getpaid/whop/key `{ clientId }` (503 while WHOP_CONNECT is off). */
  saveWhopKey(clientId: string): Promise<GetPaid>;
  /** POST /v1/getpaid/whop/connect (409 without a key; 503 while off). */
  connectWhop(): Promise<{ authorizeUrl: string; expiresAt: string }>;
  /** DELETE /v1/getpaid/connections/whop: "Stop reading Whop" (503 while off). */
  stopWhop(): Promise<void>;
}
