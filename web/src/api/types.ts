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

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  checkedAt: string;
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
  error?: string;
}

export interface Learning {
  learningId: string;
  text: string;
  createdAt: string;
  postIds: string[];
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
export type LiveItemType = "job" | "clip" | "post" | "learning";
export type LiveEvent =
  | { type: "job"; op: "upsert"; id: string; item: Job; partial?: undefined }
  | { type: "clip"; op: "upsert"; id: string; item: Clip; partial?: undefined }
  | { type: "post"; op: "upsert"; id: string; item: Post; partial?: undefined }
  | { type: "learning"; op: "upsert"; id: string; item: Learning; partial?: undefined }
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
}
