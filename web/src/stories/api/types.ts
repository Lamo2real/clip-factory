// Lamo Stories API shapes (docs/CONTRACTS.md §45.6), the web's copy. The Python side uses the same keys.
import type {
  CaptionCue,
  CharacterLook,
  CharacterVoice,
  Expression,
  MovementStyle,
  MusicMood,
  SfxCue,
  StoryScript,
} from "../engine/types.ts";

export type { CaptionCue, CharacterLook, CharacterVoice, Expression, MovementStyle, MusicMood, SfxCue, StoryScript };

export type Platform = "youtube" | "instagram" | "facebook" | "tiktok" | "x";
export const STORIES_PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

/** The workspace type registry (CONTRACTS §45.2), mirrored from api/.../workspaces/types.py. */
export type WorkspaceType = "clips" | "stories";
export const CLIPS_WORKSPACE_ID = "clips";
export const FIRST_STORIES_WORKSPACE_ID = "stories";

export interface StoriesConfig {
  /** 15..90, default 45 */
  defaultDurationSec: number;
  captionsOn: boolean;
  musicOn: boolean;
  /** a key of clipModels in config/models.json */
  storyModel: string;
  imageProvider: "builtin" | "nova-canvas";
  postPreset: boolean;
}

export interface Workspace {
  workspaceId: string;
  workspaceName: string;
  workspaceType: WorkspaceType;
  builtin: boolean;
  configuration: StoriesConfig | Record<string, never>;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export type IdeaCategory = "driving_safety" | "everyday_skills" | "comedy" | "explainer";

export interface VideoConcept {
  premise: string;
  /** 3..8 short lines */
  beats: string[];
  lesson: string | null;
  ending: string;
  tone: "funny" | "calm" | "tense_then_relief" | "wholesome";
  durationSec: number;
  /** ≤ 6 */
  onScreenText: string[];
}

export interface IdeaInput {
  title: string;
  logline: string;
  category: IdeaCategory;
  characterIds?: string[];
  concept?: VideoConcept;
  source?: "manual" | "ai" | "variation";
  parentIdeaId?: string;
}

export interface Idea extends IdeaInput {
  ideaId: string;
  workspaceId: string;
  status: "saved" | "used";
  safetyTopicId: string | null;
  needsGuidance: boolean;
  storyIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CharacterInput {
  name: string;
  description: string;
  personality: string;
  traits: string[];
  movementStyle: MovementStyle;
  expressions: Expression[];
  look: CharacterLook;
  voice: CharacterVoice;
}

export interface Character extends CharacterInput {
  characterId: string;
  workspaceId: string;
  references: { assetId: string; url: string; contentType: string; createdAt: string }[];
  portrait: { assetId: string; url: string } | null;
  storyCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type StoryStatus =
  | "draft"
  | "producing"
  | "needs_check"
  | "review"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export interface StoryInput {
  ideaId?: string;
  concept?: VideoConcept;
  title?: string;
  /** 1..3 */
  characterIds: string[];
  durationSec?: number;
  captionsOn?: boolean;
  musicMood?: MusicMood;
}

export interface Captions {
  youtubeTitle: string;
  youtubeDescription: string;
  instagram: string;
  facebook: string;
  tiktok: string;
  x: string;
}

export interface StorySafety {
  topicId: string;
  status: "ok" | "problems";
  problems: string[];
  citations: { publisher: string; title: string; url: string; section?: string }[];
}

export type StepKey = "storyboard" | "safety" | "scenes" | "animation" | "sound" | "captions" | "assemble" | "preview";

export const STEP_ORDER: StepKey[] = ["storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview"];
export const STEP_LABEL: Record<StepKey, string> = {
  storyboard: "Write the story",
  safety: "Check the facts",
  scenes: "Draw the scenes",
  animation: "Animate",
  sound: "Add sounds and music",
  captions: "Add captions",
  assemble: "Put it together",
  preview: "Ready to watch",
};

export interface Story {
  storyId: string;
  workspaceId: string;
  contentType: "animation";
  title: string;
  status: StoryStatus;
  ideaId: string | null;
  characterIds: string[];
  durationSec: number;
  actualDurationSec: number | null;
  captionsOn: boolean;
  musicMood: MusicMood;
  postCaptions: Captions;
  scenes: { sceneId: string; title: string; durationSec: number; stillUrl?: string }[];
  scriptVersion: number;
  videoUrl?: string;
  coverUrl?: string;
  storageLocation: string;
  stale: StepKey[];
  safety: StorySafety | null;
  reviewNote: string | null;
  currentJobId: string | null;
  posted: { platform: Platform; url: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  publishedAt?: string;
}

export interface StoryStep {
  key: StepKey;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  i?: number;
  n?: number;
}

export interface ProductionJob {
  jobId: string;
  workspaceId: string;
  contentId: string;
  jobType: "produce" | "changes" | "portrait";
  status: "queued" | "running" | "ready" | "needs_check" | "failed" | "canceled";
  steps: StoryStep[];
  progress: number;
  configuration: { from: StepKey; sceneIds: string[] | null; note: string | null; characterId?: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SceneEdit {
  sceneId: string;
  caption?: string | null;
  durationSec?: number;
  sfx?: SfxCue[];
}

export interface StoryPatch {
  version: number;
  title?: string;
  postCaptions?: Partial<Captions>;
  captions?: CaptionCue[];
  sfx?: SfxCue[];
  musicMood?: MusicMood;
  captionsOn?: boolean;
  scenes?: SceneEdit[];
}

export type AssetKind =
  | "final_video"
  | "cover"
  | "storyboard"
  | "scene_clip"
  | "scene_still"
  | "character_ref"
  | "portrait"
  | "generated_image"
  | "audio"
  | "captions";

export interface LibraryItem {
  assetId: string;
  kind: AssetKind;
  storyId: string | null;
  characterId: string | null;
  title: string;
  url: string;
  contentType: string;
  bytes: number;
  version: number | null;
  createdAt: string;
  meta: Record<string, string | number>;
}

export interface ProviderStatus {
  kind: "writer" | "images" | "animation" | "audio";
  id: string;
  label: string;
  state: "on" | "off" | "needs_setup" | "unavailable";
  line: string;
  checkedAt?: string;
  lastError?: string;
}

export interface GuidanceTopic {
  id: string;
  title: string;
  steps: { id: string; text: string; shown: boolean }[];
  donts: string[];
  caveats: string[];
  citations: { publisher: string; title: string; url: string; section?: string }[];
}

export interface SocialAccount {
  socialAccountId: string;
  workspaceId: string;
  platform: Platform;
  connectionStatus: "not_connected" | "connected" | "choose_account" | "needs_reconnect" | "same_as_clips";
  externalAccountId: string | null;
  accountName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  sharedWithClips: boolean;
  connectedAt: string | null;
  missing: string[];
  reason: string | null;
  choices: { id: string; name: string; avatarUrl?: string; usedByClips: boolean }[] | null;
  limits: string[];
}

export interface ClipsDestination {
  platform: Platform;
  connected: boolean;
  name: string | null;
}

export interface PublishOptions {
  tiktok?: {
    privacyLevel: string;
    disableComment: boolean;
    disableDuet: boolean;
    disableStitch: boolean;
    brandContent: boolean;
    brandOrganic: boolean;
  };
  youtubePrivacy?: "public" | "unlisted" | "private";
}

export interface PublishTarget {
  platform: Platform;
  socialAccountId: string;
  options?: PublishOptions;
}

export interface PublishingJob {
  publishingJobId: string;
  workspaceId: string;
  contentId: string;
  socialAccountId: string;
  platform: Platform;
  publishingStatus: "queued" | "publishing" | "posted" | "failed" | "needs_attention";
  accountName: string | null;
  url?: string;
  postedAt?: string;
  error?: string;
  metrics?: { views: number | null; likes: number | null; comments: number | null; shares: number | null; checkedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface StoriesDashboard {
  counts: { made: number; review: number; published: number; producing: number; needsCheck: number };
  producing: { storyId: string; title: string; step: StepKey; progress: number }[];
  accounts: { platform: Platform; connected: boolean; accountName: string | null }[];
  performance: { views: number; likes: number; comments: number; shares: number; posts: number; checkedAt: string | null };
  activity: {
    at: string;
    kind: "made" | "approved" | "rejected" | "changes" | "posted" | "failed";
    storyId: string;
    title: string;
    platform?: Platform;
  }[];
}

export interface Upload {
  assetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

/** Every Lamo Stories call (CONTRACTS §45.5). `ws` is the workspace id. */
export interface StoriesApi {
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(ws: string): Promise<Workspace>;
  patchWorkspace(ws: string, patch: { workspaceName?: string; configuration?: Partial<StoriesConfig>; version: number }): Promise<Workspace>;
  dashboard(ws: string): Promise<StoriesDashboard>;

  listIdeas(ws: string, status?: "saved" | "used" | "all"): Promise<Idea[]>;
  createIdea(ws: string, idea: IdeaInput): Promise<Idea>;
  patchIdea(ws: string, ideaId: string, patch: Partial<IdeaInput>): Promise<Idea>;
  deleteIdea(ws: string, ideaId: string): Promise<void>;
  generateIdeas(ws: string, body: { topic?: string; category?: IdeaCategory; count?: number }): Promise<IdeaInput[]>;
  expandIdea(ws: string, ideaId: string, body?: { durationSec?: number }): Promise<Idea>;
  ideaVariations(ws: string, ideaId: string, body?: { count?: number }): Promise<IdeaInput[]>;

  listCharacters(ws: string): Promise<Character[]>;
  createCharacter(ws: string, c: CharacterInput): Promise<Character>;
  getCharacter(ws: string, characterId: string): Promise<Character>;
  putCharacter(ws: string, characterId: string, c: CharacterInput & { version: number }): Promise<Character>;
  deleteCharacter(ws: string, characterId: string): Promise<void>;
  referenceUpload(ws: string, characterId: string, file: { filename: string; contentType: string; size: number }): Promise<Upload>;
  referenceComplete(ws: string, characterId: string, assetId: string): Promise<Character>;
  deleteReference(ws: string, characterId: string, assetId: string): Promise<Character>;
  makePortrait(ws: string, characterId: string): Promise<ProductionJob>;

  listStories(ws: string, q?: { status?: StoryStatus | "all"; limit?: number; cursor?: string }): Promise<{ stories: Story[]; nextCursor: string | null }>;
  createStory(ws: string, body: StoryInput): Promise<{ story: Story; job: ProductionJob }>;
  getStory(ws: string, storyId: string): Promise<{ story: Story; job: ProductionJob | null; script: StoryScript | null }>;
  patchStory(ws: string, storyId: string, patch: StoryPatch): Promise<{ story: Story; script: StoryScript | null }>;
  deleteStory(ws: string, storyId: string): Promise<void>;
  produce(ws: string, storyId: string, body?: { from?: StepKey; sceneIds?: string[]; note?: string }): Promise<{ story: Story; job: ProductionJob }>;
  cancelStory(ws: string, storyId: string): Promise<{ story: Story; job: ProductionJob | null }>;
  approve(ws: string, storyId: string, version: number): Promise<Story>;
  reject(ws: string, storyId: string, reason?: string): Promise<Story>;
  requestChanges(ws: string, storyId: string, body: { note: string; sceneIds?: string[] }): Promise<{ story: Story; job: ProductionJob }>;
  download(ws: string, storyId: string): Promise<{ url: string; filename: string }>;

  library(ws: string, q?: { kind?: AssetKind | "all"; storyId?: string; characterId?: string; limit?: number; cursor?: string }): Promise<{ items: LibraryItem[]; nextCursor: string | null }>;
  providers(ws: string): Promise<ProviderStatus[]>;
  guidance(ws: string): Promise<{ topics: GuidanceTopic[]; checkedAt: string }>;

  social(ws: string): Promise<{ accounts: SocialAccount[]; clips: ClipsDestination[] }>;
  connectSocial(ws: string, platform: Platform): Promise<{ authorizeUrl: string; expiresAt: string }>;
  chooseSocial(ws: string, platform: Platform, choiceId: string): Promise<SocialAccount>;
  shareWithClips(ws: string, platform: Platform): Promise<SocialAccount>;
  checkSocial(ws: string, platform: Platform): Promise<SocialAccount>;
  disconnectSocial(ws: string, platform: Platform): Promise<void>;

  publish(ws: string, storyId: string, targets: PublishTarget[]): Promise<PublishingJob[]>;
  listPublishing(ws: string, storyId?: string): Promise<PublishingJob[]>;
  retryPublishing(ws: string, publishingJobId: string, options?: PublishOptions): Promise<PublishingJob>;
}
