// Lamo Stories API shapes (docs/CONTRACTS.md §45.6), the web's copy. The Python side uses the same keys.
// Changed only through docs/CONTRACTS.md §45.6 (builders ask the lead).
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
/** Platforms where Lamo Stories may use Clip Factory's developer app on purpose; Meta always has its own (§45.30). */
export const SHARED_APP_PLATFORMS: Platform[] = ["youtube", "tiktok", "x"];

/** The workspace type registry (CONTRACTS §45.2), mirrored from api/.../workspaces/types.py. */
export type WorkspaceType = "clips" | "stories";
export const CLIPS_WORKSPACE_ID = "clips";
export const FIRST_STORIES_WORKSPACE_ID = "stories";

/**
 * A PATCH of the workspace's configuration: each part may be partial; the API merges it onto the stored one. The makers
 * (`providers`) send only what changed: the API checks only the picks the body names (§45.37 G1), so an older stored
 * pick never blocks another change.
 */
export type StoriesConfigPatch = Omit<Partial<StoriesConfig>, "providers"> & { providers?: Partial<StoriesConfig["providers"]> };

export interface StoriesConfig {
  /** 15..90, default 45; 30..60 suggested */
  defaultDurationSec: number;
  captionsOn: boolean;
  musicOn: boolean;
  /**
   * The makers (provider ids, §45.37) and, for each kind, the model it uses (G1): a maker model key of that kind from
   * GET …/makers/models, null or missing for the maker's first. The built-in makers stay the defaults; an ended maker
   * (Nova Canvas, Nova Reel) stays readable as an older pick but is never picked again.
   */
  providers: {
    images: ImageMaker;
    video: VideoMaker;
    audio: SoundMaker;
    imageModel?: string | null;
    videoModel?: string | null;
    audioModel?: string | null;
  };
  /** CRF: standard 23, high 20, best 17; the resolution matches the aspect (§45.34); 30 fps is the only rate */
  video: { resolution: VideoResolution; aspect: VideoAspect; quality: "standard" | "high" | "best"; fps: 30 };
  production: {
    burnCaptions: boolean;
    scenesAtOnce: 1 | 2 | 3;
    keepVersions: "all" | number;
    /** §45.34; missing on a workspace saved before them, which means "all" */
    keepReferences?: KeepReferences;
    /** §45.34; missing means "all" */
    keepChatPictures?: KeepChatPictures;
    /** §45.34: made besides the MP4 after assembly; missing means none */
    extraFormats?: ExtraFormat[];
  };
  /** Film & Animation, Autos & Vehicles, Comedy, Entertainment, Education (default "27") */
  youtubeCategory: "1" | "2" | "23" | "24" | "27";
  youtubePrivacy: "public" | "unlisted" | "private";
  /** only with Lamo Stories' own X app */
  xMonthlyLimitUsd: number | null;
}

/** A video's shape and its sizes (§45.34): 9:16 stays the default, the one Shorts, Reels and TikTok want. */
export type VideoAspect = "9:16" | "1:1" | "16:9";
export type VideoResolution = "1080x1920" | "720x1280" | "1080x1080" | "720x720" | "1920x1080" | "1280x720";
export const RESOLUTIONS: Record<VideoAspect, VideoResolution[]> = {
  "9:16": ["1080x1920", "720x1280"],
  "1:1": ["1080x1080", "720x720"],
  "16:9": ["1920x1080", "1280x720"],
};
/**
 * The makers (§45.37, the lead's one set of ids). Pictures: the built-in drawings (default), Amazon Nova Canvas
 * (ended by Amazon on 30 Sep 2026), Stability AI on Amazon Bedrock (us-west-2) and the owner's own picture models.
 * Video: the built-in animator (default), Amazon Nova Reel (ended), Luma AI Ray2 on Amazon Bedrock (us-west-2,
 * cut-aways) and the owner's own video models. Sound: the built-in sounds (default), Amazon Polly neural voices (a
 * spoken voice: opt-in only, never the default, the only path that speaks words), ElevenLabs sound effects and an
 * instrumental music bed (the owner's key; never its text-to-speech) and the owner's own sound models.
 */
export type ImageMaker = "builtin-rig" | "nova-canvas" | "stability" | "own-images";
export type VideoMaker = "builtin-2d" | "nova-reel" | "luma-ray" | "own-video";
export type SoundMaker = "builtin-synth" | "polly" | "elevenlabs" | "own-sound";
/** The order the pickers list them in: the built-in first, an ended maker last (shown as ended, never picked again). */
export const IMAGE_MAKERS: ImageMaker[] = ["builtin-rig", "stability", "own-images", "nova-canvas"];
export const VIDEO_MAKERS: VideoMaker[] = ["builtin-2d", "luma-ray", "own-video", "nova-reel"];
export const SOUND_MAKERS: SoundMaker[] = ["builtin-synth", "elevenlabs", "own-sound", "polly"];
/** The day Amazon ended Nova Canvas and Nova Reel (stories/config/models.json `ended`). */
export const AMAZON_ENDED_ON = "2026-09-30";
/** The makers Amazon ended (30 Sep 2026) and the one tap that replaces each (§45.37). */
export const ENDED_MAKERS: Partial<Record<string, string>> = { "nova-canvas": "stability", "nova-reel": "luma-ray" };
/** Where the owner's own added models of each kind go (§45.37 G2). */
export const OWN_MAKER: Record<MakerKind, "own-images" | "own-video" | "own-sound"> = { image: "own-images", video: "own-video", audio: "own-sound" };

/** How long reference videos and chat pictures are kept (§45.34); study_only keeps a reference's study, not its file. */
export type KeepReferences = "all" | "study_only" | "days_30" | "days_90";
export type KeepChatPictures = "all" | "days_30" | "days_90";
/** Files made besides the MP4 (H.264, AAC), which posting needs: WebM (VP9, Opus) and MOV (ProRes 422 Proxy, PCM). */
export type ExtraFormat = "webm" | "mov";

/** Reasoning effort (CONTRACTS §45.25); each model offers only some levels. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

export type TaskKind =
  | "chat"
  | "brainstorm"
  | "expand_idea"
  | "variations"
  | "storyboard"
  | "scene_rewrite"
  | "character_design"
  | "reference_analysis"
  | "fact_check"
  | "final_review"
  | "captions"
  /** short chat edits: renaming, fixing a word, shortening a caption (§45.37 G5, suggested Low) */
  | "text_edit"
  /** the storyboard's scene planning (§45.37 G5, suggested High) */
  | "animation_plan";

export interface Price {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number | null;
  cacheWritePer1M: number | null;
  longContext: { aboveInputTokens: number; inputPer1M: number; outputPer1M: number } | null;
  currency: string;
  source: "anthropic_list" | "aws_price_list" | "owner";
  note: string;
  /** a picture or video maker's price for one unit (§45.34), with inputPer1M and outputPer1M 0; null for models */
  perUnit?: number | null;
  unit?: "image" | "second" | "character" | null;
}

/** What a PUT …/ai says the owner picked on purpose (§45.34), stamped on AICONFIG.pickedAt for setup steps 1 to 3. */
export type AiPicked = "environment" | "model" | "effort";

/** A reasoning model the owner added himself (§45.34; on a keyed host since §45.37 G4), saved by PUT …/ai/models/{key}. */
export interface ModelDef {
  label: string;
  /** who makes it, e.g. "Anthropic", "Amazon", "Meta", "Mistral" */
  provider: string;
  /** a Bedrock model id, inference profile id or ARN; on a keyed host the name its API uses (claude-opus-5-5) */
  modelId: string;
  /** its AWS Region: Amazon Bedrock only (left out on a keyed host, §45.37 G4) */
  region?: string;
  /** the efforts it accepts; may be empty (then it runs at its own level) */
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  maxOutputTokens: number;
  price: Price | null;
  // ---- How Lamo Stories calls it (§45.35 D1, builder W4b); each may be left out: its maker's defaults (ModelCalling) ----
  /** where its effort goes: "output_config" (Anthropic's Claude models), or "none" (no effort sent; efforts empty) */
  effortField?: EffortField;
  /** it takes tool use (the chat's actions and tidy answers); off: tidy answers are asked for as text */
  tools?: boolean;
  /** it takes Amazon Bedrock's prompt cache (cachePoint) */
  cache?: boolean;
  // ---- Who runs it (§45.37 G4); left out: Amazon Bedrock, as before ----
  /** "bedrock" (Amazon Bedrock, Lamo Stories' own AWS access), "anthropic" (the Anthropic API) or "openai_compatible" (any public https address that speaks the OpenAI chat-completions API); the last two use the owner's key from Provider keys */
  host?: Exclude<ModelHost, "elevenlabs">;
  /** the API's https base URL (the part before /chat/completions); only for openai_compatible, left out otherwise */
  baseUrl?: string;
}
/**
 * Who runs a model the owner adds (§45.37 G4). The two keyed hosts read the owner's key from Provider keys
 * (PUT …/providers/{host}/key; the key never comes back, only its hint). A model on a keyed host has no Region.
 */
export type ModelHost = "bedrock" | "anthropic" | "openai_compatible" | "elevenlabs" | "polly";
/** The hosts a reasoning model can run on (Settings › AI › Add a model); ElevenLabs makes sound only. */
export const MODEL_HOSTS: ModelHost[] = ["bedrock", "anthropic", "openai_compatible"];
/** The hosts that need the owner's key: their provider ids in GET …/providers and the key routes are the same words. */
export const KEYED_HOSTS: ModelHost[] = ["anthropic", "openai_compatible", "elevenlabs"];
/**
 * Each host's name, as the API's hosts.LABEL says it. "polly" (Amazon Polly) is for display only: it runs only the
 * bundled spoken-voice maker (opt-in), takes no key and is never offered for a model the owner adds.
 */
export const HOST_LABEL: Record<ModelHost, string> = { bedrock: "Amazon Bedrock", anthropic: "Anthropic API", openai_compatible: "OpenAI-compatible API", elevenlabs: "ElevenLabs", polly: "Amazon Polly" };
/**
 * The hosts a maker model the owner adds can run on (§45.37, the API's makers.clean): video only on Amazon Bedrock
 * (Luma AI's models); sound only on ElevenLabs (Amazon Bedrock has no sound or music model: the API answers 400
 * NO_BEDROCK_SOUND).
 */
export const MAKER_HOSTS: Record<MakerKind, MakerHost[]> = { image: ["bedrock", "openai_compatible"], video: ["bedrock"], audio: ["elevenlabs"] };
export type MakerHost = "bedrock" | "openai_compatible" | "elevenlabs";
/**
 * The host id of a ModelInfo (its `hostId`, else its `host` words) or a MakerModelInfo.host: "Amazon Bedrock" (or
 * "bedrock") is Bedrock; a keyed host is its id or its label. Anything else is read as Bedrock (the only host before
 * §45.37).
 */
export function hostIdOf(host: string | null | undefined): ModelHost {
  const h = (host ?? "").trim().toLowerCase();
  if (h === "anthropic" || h === "anthropic api" || h === "the anthropic api") return "anthropic";
  if (h === "openai_compatible" || h === "openai-compatible" || h === "openai-compatible api") return "openai_compatible";
  if (h === "elevenlabs") return "elevenlabs";
  if (h === "polly" || h === "amazon polly") return "polly";
  return "bedrock";
}

// ---------- The makers' models (§45.37 G1, G2) ----------

/** What a maker model makes. */
export type MakerKind = "image" | "video" | "audio";
export const MAKER_KINDS: MakerKind[] = ["image", "video", "audio"];
/** Which StoriesConfig.providers fields hold each kind's maker and its model, and the maker's ProviderStatus.kind. */
export const MAKER_FIELD_OF: Record<MakerKind, { maker: "images" | "video" | "audio"; model: "imageModel" | "videoModel" | "audioModel"; provider: "images" | "animation" | "audio" }> = {
  image: { maker: "images", model: "imageModel", provider: "images" },
  video: { maker: "video", model: "videoModel", provider: "animation" },
  audio: { maker: "audio", model: "audioModel", provider: "audio" },
};
/** A maker model's price for one unit (one picture, one second of video or sound, …), or null when not known. */
export interface MakerPrice {
  perUnit: number;
  unit: string;
  currency: string;
}
/**
 * A model a picture, video or sound maker can use (§45.37 G1): from stories/config/models.json's imageModels,
 * videoModels and audioModels (an older file's imageModel and videoModel read as one-item lists) or added by the
 * owner (MAKERDEF#, custom: true). Its status is an access check that costs nothing (Check models with `makers`):
 * Works, No access or Not found, with the provider's own sentence; nothing is shown as working because it is listed.
 */
export interface MakerModelInfo {
  key: string;
  label: string;
  /** who makes it ("Amazon", "Stability AI", "Luma AI", …) */
  provider: string;
  /** who runs it, in words ("Amazon Bedrock", "OpenAI-compatible API" or that API's own address name) */
  host: string;
  /** the host's id (§45.37 G4); missing from an older answer: read `host` */
  hostId?: ModelHost;
  modelId: string;
  /** its AWS Region on Amazon Bedrock (null, or "" from an older answer, on a keyed host) */
  region: string | null;
  /** "Runs in the US (Oregon)" (the API's words for the Region), null on a keyed host */
  regionLine?: string | null;
  kind: MakerKind;
  price: MakerPrice | null;
  /** one plain line about it ("" when there is none) */
  note: string;
  status: ModelInfo["status"];
  statusLine: string;
  checkedAt: string | null;
  /** added by the owner (MAKERDEF#) */
  custom: boolean;
  /** only for a model on an openai_compatible host */
  baseUrl?: string | null;
  /** the maker (StoriesConfig.providers id) it belongs to; an added model's is own-images, own-video or own-sound */
  maker?: string;
  /** Amazon ended it (ISO day, "2026-09-30", models.json `ended`): shown "Ended by Amazon on 30 Sep 2026", never picked again */
  ended?: string | null;
  /** "Ended by Amazon on 30 Sep 2026" for an ended model, else null */
  endedLine?: string | null;
}
/**
 * A maker model the owner adds or changes (PUT …/makers/models/{key}); the key is `custom-…`, at most 20 per kind,
 * one name across these and Settings › AI's added models. Where each kind runs: MAKER_HOSTS (pictures on Amazon
 * Bedrock or an OpenAI-compatible API, video on Amazon Bedrock, sound on ElevenLabs or Amazon Bedrock); the Anthropic
 * API makes only text. A sound model makes sound effects and music only, never a voice.
 */
export interface MakerModelDef {
  label: string;
  provider: string;
  kind: MakerKind;
  host: MakerHost;
  modelId: string;
  /** Amazon Bedrock only (left out on a keyed host) */
  region?: string;
  /** openai_compatible only (left out otherwise) */
  baseUrl?: string;
  price: MakerPrice | null;
  note: string;
}
export const MAX_CUSTOM_MAKER_MODELS = 20;
/**
 * Where an added model's effort goes (§45.35 D1, §45.37 G4): Anthropic's output_config (on Amazon Bedrock and on the
 * Anthropic API), the OpenAI chat-completions reasoning_effort (an OpenAI-compatible API: Low to Extra high), or
 * nowhere.
 */
export type EffortField = "output_config" | "reasoning_effort" | "none";
/** The levels reasoning_effort takes (the API's REASONING_EFFORTS): no Maximum. */
export const REASONING_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];
/** How an added model is called (§45.35 D1). */
export interface ModelCalling {
  effortField: EffortField;
  tools: boolean;
  cache: boolean;
}
/**
 * The defaults per maker (§45.35 D1): an Anthropic model takes all three, an Amazon model the cache only, any other
 * none; and per host (§45.37 G4, the API's model_defs defaults): on the Anthropic API all three, on an
 * OpenAI-compatible API none (its effort, when the owner turns it on, goes in reasoning_effort; it has no cache).
 */
export function callingFor(provider: string, host: ModelHost = "bedrock"): ModelCalling {
  if (host === "anthropic") return { effortField: "output_config", tools: true, cache: true };
  if (host === "openai_compatible") return { effortField: "none", tools: false, cache: false };
  const maker = provider.trim().replace(/\s+/g, " ").toLowerCase();
  return { effortField: maker === "anthropic" ? "output_config" : "none", tools: maker === "anthropic", cache: maker === "anthropic" || maker === "amazon" };
}
/** A custom model's key: `custom-` and up to 40 small letters, digits and dashes; never a bundled key; at most 20. */
export const CUSTOM_MODEL_KEY = /^custom-[a-z0-9-]{1,40}$/;
export const MAX_CUSTOM_MODELS = 20;

/** One set of words for a model's state, on every screen (§45.36 E17, builder W5b). */
export const MODEL_STATUS_WORDS: Record<ModelInfo["status"], string> = {
  ok: "Works",
  not_checked: "Not checked yet",
  denied: "No access",
  not_found: "Not found",
  error: "Problem",
};

// ---- An added model's Region and its ID (§45.36 E4, builder W5b) ----

// The same rule and sentences as the API's (workspaces/model_defs.py region_problem): the form checks before it sends,
// the mock refuses as the API does.

/** The Region an ARN names (`arn:aws:bedrock:eu-west-1:…`), else null. */
export function regionOfArn(modelId: string): string | null {
  const m = /^arn:aws(?:-[a-z]+)*:bedrock:([a-z0-9-]+):/.exec(modelId.trim());
  return m ? m[1]! : null;
}

/**
 * The area each cross-Region inference profile's first part runs in. `global.` runs from any Region; a first part or
 * a Region outside these areas is not checked, so a Region AWS adds to an area later is never refused by mistake.
 */
const PROFILE_AREAS: Record<string, string> = { us: "us", "us-gov": "us-gov", eu: "eu", apac: "ap", jp: "ap", au: "ap" };
const REGION_AREAS: [string, string][] = [
  ["us-gov-", "us-gov"],
  ["us-", "us"],
  ["eu-", "eu"],
  ["ap-", "ap"],
];
/** Each area in words, one of its Regions, and the first part of its own profile ids. */
const AREA_WORDS: Record<string, [string, string, string]> = {
  us: ["a US Region", "us-east-1", "us"],
  "us-gov": ["an AWS GovCloud Region", "us-gov-west-1", "us-gov"],
  eu: ["a Europe Region", "eu-north-1", "eu"],
  ap: ["an Asia Pacific Region", "ap-southeast-2", "apac"],
};

/** The first part of a cross-Region inference profile id ("eu" for eu.amazon.nova-premier-v1:0, also inside an ARN), else null. */
function profileArea(modelId: string): string | null {
  const id = modelId.trim();
  let profile = id;
  if (regionOfArn(id) !== null) {
    const inside = /:inference-profile\/([^/]+)$/.exec(id);
    if (!inside) return null;
    profile = inside[1]!;
  }
  const parts = profile.split(".");
  // A profile id is {area}.{maker}.{model}; a model id is {maker}.{model}.
  return parts.length < 3 ? null : parts[0]!;
}

const regionArea = (region: string): string | null => REGION_AREAS.find(([start]) => region.startsWith(start))?.[1] ?? null;

/**
 * Why an added model's Region does not fit its ID, naming both, else null (§45.36 E4): an ARN's own Region must be the
 * Region picked, and a us., eu., apac. (jp., au., us-gov.) inference profile must run in that part of the world.
 */
export function modelRegionProblem(modelId: string, region: string): string | null {
  const id = modelId.trim();
  const r = region.trim();
  const inArn = regionOfArn(id);
  if (inArn !== null && inArn !== r) return `This ARN is in ${inArn}, but the Region says ${r}. Type ${inArn} as the Region.`;
  const first = profileArea(id);
  const wanted = first === null ? undefined : PROFILE_AREAS[first];
  const here = regionArea(r);
  if (wanted === undefined || here === null || wanted === here) return null;
  const [words, example] = AREA_WORDS[wanted]!;
  const own = AREA_WORDS[here]![2];
  if (inArn !== null) return `This ARN's inference profile starts with ${first}., so it runs in ${words} (like ${example}), not in ${r}. Paste the ARN of the ${own}. profile instead.`;
  return `This inference profile id starts with ${first}., so it runs in ${words} (like ${example}), not in ${r}. Type ${words} as the Region, or paste the ${own}. profile id instead.`;
}

export interface StoriesAiConfig {
  defaultModel: string;
  defaultEffort: Effort;
  tasks: Partial<Record<TaskKind, { model?: string; effort?: Effort }>>;
  /** the owner's prices, by model key or provider id */
  prices: Record<string, Price>;
  version: number;
}

/** What a call will use, computed by the API with the same rules as the agent (CONTRACTS §45.25). */
export interface Effective {
  model: string;
  effort: Effort | null;
  effortApplied: boolean;
  from: "request" | "conversation" | "project" | "task" | "agent" | "default";
}

/** A video's or a reference's own setting (§45.25 level 2), kept with it. */
export interface AiSetting {
  model: string | null;
  effort: Effort | null;
}

/** Just for this request; never saved. */
export interface ModelOverride {
  model?: string;
  effort?: Effort;
}

export interface ModelInfo {
  key: string;
  label: string;
  provider: string;
  modelId: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  status: "ok" | "not_checked" | "denied" | "not_found" | "error";
  statusLine: string;
  checkedAt: string | null;
  price: Price | null;
  /** added by the owner in Settings › AI (§45.34); missing from an API older than that means false */
  custom?: boolean;
  /** a custom model's own Region and output limit, so Edit starts from them (contractIssues) */
  region?: string;
  maxOutputTokens?: number;
  // ---- §45.35 D8 and D1 (builder W4b) ----
  /** who runs it, in words ("Amazon Bedrock", "Anthropic API", or an OpenAI-compatible API's address name, §45.37 G4); `provider` is who makes it ("Anthropic", "Amazon", …). Screens say "{provider} on {host}" */
  host?: string;
  /** the host's id (§45.37 G4); missing from an older API: Amazon Bedrock */
  hostId?: ModelHost;
  /** an added model's API address, only on an openai_compatible host (§45.37 G4) */
  baseUrl?: string | null;
  /** an added model's own way of being called (D1), so Edit starts from it; missing: its maker's defaults */
  effortField?: EffortField;
  tools?: boolean;
  cache?: boolean;
}

export type AgentId = "creative_director" | "video_analysis" | "storyboard" | "character" | "quality_assurance";

export interface TaskInfo {
  kind: TaskKind;
  label: string;
  agentId: AgentId;
  suggestedEffort: Effort;
  effective: Effective;
}

export interface Agent {
  agentId: AgentId;
  name: string;
  tasks: TaskKind[];
  instructions: string;
  defaultInstructions: string;
  active: boolean;
  model: string | null;
  effort: Effort | null;
  skillIds: string[];
  version: number;
  updatedAt: string;
}

export interface Skill {
  skillId: string;
  title: string;
  description: string;
  builtin: boolean;
  source: "builtin" | "written" | "upload";
  format: "md" | "zip";
  enabled: boolean;
  agentIds: AgentId[];
  revisions: { revisionId: string; savedAt: string; size: number }[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiTask {
  taskId: string;
  kind: TaskKind | "check_models";
  status: "queued" | "running" | "done" | "failed";
  model: string | null;
  effort: Effort | null;
  effortApplied: boolean | null;
  result: Record<string, unknown> | null;
  error?: string;
  /** the Bedrock model id or inference profile really called, and its Region (§45.35 D5); missing from an older API */
  modelId?: string | null;
  region?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectRef = { kind: "idea" | "story" | "character" | "reference"; id: string };

export interface Conversation {
  convId: string;
  title: string;
  model: string | null;
  effort: Effort | null;
  /** what the next message will use (computed by the API) */
  effective: Effective;
  projectRef: ProjectRef | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatAction {
  kind: "make_video" | "remake_scene" | "analyze_reference" | "save_character" | "save_idea" | "open";
  label: string;
  payload: Record<string, unknown>;
}

export interface Message {
  msgId: string;
  convId: string;
  role: "user" | "assistant";
  text: string;
  attachments: { assetId: string; url: string; contentType: string }[];
  status: "pending" | "streaming" | "done" | "failed" | "stopped";
  model: string | null;
  effort: Effort | null;
  effortApplied: boolean | null;
  usage: { input: number; output: number } | null;
  actions: ChatAction[];
  error?: string;
  /** an answer's one-time "Just for this message" choice (§45.35 D4); null or missing when there was none */
  requested?: ModelOverride | null;
  /** the Bedrock model id or inference profile really called, and its Region (§45.35 D5) */
  modelId?: string | null;
  region?: string | null;
  createdAt: string;
}

export interface MemoryItem {
  memId: string;
  text: string;
  source: "chat" | "owner";
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceVideo {
  refId: string;
  title: string;
  status: "uploading" | "ready" | "analyzing" | "analyzed" | "failed";
  durationSec: number | null;
  bytes: number;
  url?: string;
  currentJobId: string | null;
  ai: AiSetting;
  analyzedWith: { model: string; effort: Effort | null } | null;
  /** the keep setting cleared the video file (§45.35 D9: REFVID# fileRemovedAt); missing from an older API */
  fileRemoved?: boolean;
  /** with fileRemoved: its study is kept (it was studied before the file went) */
  studyKept?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceAnalysis {
  summary: string;
  hook: { atSec: number; what: string };
  pacing: { cutsPer10s: number; notes: string };
  shots: { start: number; end: number; what: string; acting: string; sound: string }[];
  gags: string[];
  sound: string;
  captions: string;
  borrow: string[];
  avoid: string[];
}

export type OnboardStep = "ai" | "model" | "effort" | "video" | "agents" | "instagram" | "tiktok" | "youtube" | "facebook" | "x" | "done";

export interface Onboarding {
  /** `line`: why a step is still to do when the account is Lamo Clips' own (the same-as-Clips line, §45.34, §45.35 D11) */
  steps: { step: OnboardStep; label: string; state: "done" | "skipped" | "todo"; line?: string }[];
  done: number;
  total: 11;
  finishedAt: string | null;
}

export interface UsageSummary {
  days: {
    day: string;
    byModel: { model: string; input: number; output: number; cost: number | null; currency: string | null }[];
    /** §45.34 */
    renderMinutes?: number;
    byProvider?: ProviderUsage[];
  }[];
  totals: { model: string; input: number; output: number; cost: number | null; currency: string | null }[];
  renderMinutes: number;
  /** §45.34 */
  totalsByProvider?: ProviderUsage[];
}

/** A picture or video maker's use (§45.34): built-in render seconds are `builtin-rig`, free (cost 0, currency null). */
export interface ProviderUsage {
  provider: string;
  units: number;
  /** pictures, seconds (of video, sound or rendering) or characters spoken (Amazon Polly, §45.37) */
  unit: "image" | "second" | "character";
  cost: number | null;
  currency: string | null;
}

export interface StorageSummary {
  bytes: { videos: number; scenes: number; audio: number; references: number; skills: number; other: number };
  files: number;
  /** §45.34: "Lamo Stories' own folder in Clip Factory's media storage" */
  location?: { region: string; folder: string };
}

export interface KeyCheck {
  at: string;
  ok: boolean;
  code: string;
  message: string;
  /** §45.34: whether Lamo Stories' own sign-in to the account still works with these keys */
  account?: "ok" | "dead" | "none";
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
  | "approved"
  | "rejected"
  | "published"
  | "failed";

export interface StoryInput {
  ideaId?: string;
  /** "type a concept": a short form the writer expands */
  brief?: { title: string; logline: string; category: IdeaCategory };
  title?: string;
  /** 1..3 */
  characterIds: string[];
  durationSec?: number;
  captionsOn?: boolean;
  musicMood?: MusicMood;
  /** ≤ 3 reference videos whose analyses the storyboard agent reads */
  referenceIds?: string[];
  /** this video's own model and effort, kept with it */
  ai?: AiSetting;
  /** this video's own shape (CONTRACTS §45.34): the workspace's video default when left out */
  format?: StoryFormat;
  /** the first job's model and effort only, never kept (§45.5 POST /stories; the stand-in for a usual model the studio knows cannot be used, §45.36 E12) */
  override?: ModelOverride;
}

/** A video's shape and size (CONTRACTS §45.34 "Video size and shape"); the size matches the aspect. */
export interface StoryFormat {
  aspect: "9:16" | "1:1" | "16:9";
  width: number;
  height: number;
}

/** The extra copies a video can have besides its MP4 (CONTRACTS §45.34 "Output formats"). */
export type DownloadFormat = "mp4" | "webm" | "mov";

/** A finished "Write them again" task's result (CONTRACTS §45.34): a draft, never saved by itself. */
export interface CaptionsResult {
  storyId: string;
  scriptVersion: number;
  postCaptions: Captions;
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
  /** null: no driving advice, only the "nothing dangerous" check */
  topicId: string | null;
  /** skipped: the quality agent is off (never for driving safety) */
  status: "pending" | "ok" | "problems" | "skipped";
  problems: string[];
  checkedScriptVersion: number | null;
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
  category: IdeaCategory;
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
  safetyTopicId: string | null;
  safety: StorySafety | null;
  ai: AiSetting;
  /** what the next run of this video uses for the task `storyboard` (CONTRACTS §45.34, §45.25's precedence) */
  effective?: Effective;
  /** this video's shape (CONTRACTS §45.34); 9:16 at 1080 × 1920 when the API leaves it out */
  format?: StoryFormat;
  referenceIds: string[];
  reviewNote: string | null;
  currentJobId: string | null;
  posted: { platform: Platform; url: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  publishedAt?: string;
}

/** A reference analysis job's own steps (CONTRACTS §45.34): Look at it, Listen, Write it up. */
export type RefStepKey = "look" | "listen" | "write";
export const REF_STEP_ORDER: RefStepKey[] = ["look", "listen", "write"];
export const REF_STEP_LABEL: Record<RefStepKey, string> = { look: "Look at it", listen: "Listen", write: "Write it up" };

export interface StoryStep {
  /** a portrait job has one step of its own: { key: "portrait", label: "Draw the picture" }; a reference analysis has look, listen, write; Nova Reel's try has { key: "check", label: "Try it" } (§45.35 D2) */
  key: StepKey | "portrait" | RefStepKey | "check";
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
  /** provider: a maker's "Try it" (§45.35 D2), whose contentId is the provider's id */
  contentType: "animation" | "character" | "reference" | "provider";
  /** storyId, characterId (portrait) or refId (reference analysis) */
  contentId: string;
  /** provider_check: Nova Reel's "Try it" (one 6-second test shot, §45.35 D2) */
  jobType: "produce" | "changes" | "portrait" | "reference_analysis" | "provider_check";
  status: "queued" | "running" | "ready" | "needs_check" | "failed" | "canceled";
  steps: StoryStep[];
  progress: number;
  configuration: { run: (StepKey | "portrait" | RefStepKey | "check")[]; from: StepKey | null; sceneIds: string[] | null; note: string | null };
  meta: {
    writerModel: string | null;
    engineVersion: number | null;
    seed: number | null;
    scriptVersion: number | null;
    targetSec: number | null;
    actualSec: number | null;
    safetyTopicId: string | null;
    providers: Record<string, string>;
    /** `failed`: the step stopped on this model; model and effort are what was asked (§45.34), no answer came */
    models: ModelUse[];
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One step's model record in a job (§45.25 "Recorded", §45.34, §45.35 D5): `modelId` is the Bedrock model id or
 * inference profile really called and `region` its Region, so an old job still says exactly what ran after the
 * model's settings changed; `task` is the task it ran for. Missing from an older API.
 */
export interface ModelUse {
  step: string;
  agentId: string;
  model: string;
  effort: Effort | null;
  effortApplied: boolean;
  failed?: boolean;
  task?: string;
  modelId?: string;
  region?: string;
}

export interface SceneEdit {
  sceneId: string;
  caption?: string | null;
  /** 2..15 */
  durationSec?: number;
  /** replaces that scene's whole effects list: add, move, remove */
  sfx?: SfxCue[];
}

export interface StoryPatch {
  version: number;
  title?: string;
  postCaptions?: Partial<Captions>;
  captions?: CaptionCue[];
  musicMood?: MusicMood;
  captionsOn?: boolean;
  scenes?: SceneEdit[];
  ai?: AiSetting;
  referenceIds?: string[];
}

export type AssetKind =
  | "final_video"
  | "cover"
  | "storyboard"
  | "scene_clip"
  | "scene_still"
  | "character_ref"
  | "portrait"
  | "audio"
  | "captions"
  /** a picture for "Design with AI"; the Library hides it */
  | "design_ref"
  /** a video's extra copy (WebM or MOV, `meta.format`), made beside its MP4 (CONTRACTS §45.34 "Output formats") */
  | "video";

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
  /** ended: the maker's maker stopped it (Amazon ended Nova Canvas and Nova Reel on 30 Sep 2026, §45.37); `line` names the replacement */
  state: "on" | "off" | "needs_setup" | "unavailable" | "ended";
  line: string;
  checkedAt?: string;
  lastError?: string;
  /** present only for a provider that takes a key (§45.34); the key itself never comes back */
  key?: { saved: boolean; hint: string | null; savedAt: string | null } | null;
  /** a maker that can be tried (Luma Ray2 since §45.37; Nova Reel before, §45.35 D2): its newest "Try it" job (jobType provider_check), null before the first */
  check?: ProductionJob | null;
  /** an ended maker's replacement (a provider id, §45.37: nova-canvas → stability, nova-reel → luma-ray), for the one tap "Use {replacement}" */
  replacement?: string | null;
  /** an ended maker: the day its maker ended it (ISO day, "2026-09-30") */
  endedAt?: string | null;
  /**
   * §45.37 G1, G2: a picture, video or sound maker's row (not a built-in one) lists its models, bundled and added
   * (MAKERDEF#, on own-images, own-video and own-sound), each with its access check. GET …/providers is where the
   * maker models come from: there is no route of their own.
   */
  models?: MakerModelInfo[];
  /** a maker row: whether the workspace picks this maker */
  picked?: boolean;
  /** a maker row: the key of the model it uses (the pick, else its first that has not ended); null for a built-in or ended one */
  model?: string | null;
}

/** Every maker model the maker rows of GET …/providers list (§45.37 G1, G2), each once, in the API's order. */
export function makerModelsIn(providers: readonly ProviderStatus[] | null | undefined): MakerModelInfo[] {
  const seen = new Set<string>();
  const out: MakerModelInfo[] = [];
  for (const p of providers ?? [])
    for (const m of p.models ?? []) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      out.push(m);
    }
  return out;
}

/**
 * Whether the owner saved the key a keyed host needs (§45.37 G4), from GET …/providers: the host's own row (anthropic,
 * openai_compatible) or the ElevenLabs maker row, each with `key`. Undefined for Amazon Bedrock (no key) or while the
 * providers are not known. The key itself never comes back.
 */
export function keySavedFor(providers: readonly ProviderStatus[] | null | undefined, host: string | null | undefined): boolean | undefined {
  const id = hostIdOf(host);
  if (!providers || !KEYED_HOSTS.includes(id)) return undefined;
  const row = providers.find((p) => p.id === id && p.key);
  return row ? !!row.key?.saved : undefined;
}

export interface GuidanceTopic {
  id: string;
  title: string;
  steps: { id: string; text: string; shown: boolean; why?: string }[];
  donts: { id: string; text: string; shown: boolean; why?: string }[];
  caveats: string[];
  citations: { publisher: string; title: string; url: string; section?: string }[];
}

export interface SocialAccount {
  socialAccountId: string;
  workspaceId: string;
  platform: Platform;
  /** which developer app this platform uses (CONTRACTS §45.30): never chosen silently */
  app: { choice: "own" | "clips" | null; saved: boolean; hints?: Record<string, string>; check?: KeyCheck };
  lastCheckedAt: string | null;
  connectionStatus: "not_connected" | "connected" | "choose_account" | "needs_reconnect" | "same_as_clips";
  externalAccountId: string | null;
  accountName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  /**
   * Gone (§45.37 G8): Clip Stories never posts to Clip Factory's own account, so nothing is shared; an older API
   * may still send false. Never read by the screens.
   */
  sharedWithClips?: boolean;
  connectedAt: string | null;
  missing: string[];
  /** a code (§45.34), said in words by the page */
  reason: SocialReason | null;
  reconnectBy: string | null;
  choices: { id: string; name: string; avatarUrl?: string; usedByClips: boolean }[] | null;
  /** plain sentences: this platform's rules for a second account */
  limits: string[];
  /** e.g. "Lamo Clips may have lost Facebook. …" */
  warning: string | null;
}

/** Why an account needs the owner (§45.34): a code, never a sentence. */
export type SocialReason =
  | "keys_changed"
  | "token_dead"
  | "expired"
  | "expires_soon"
  | "missing_permissions"
  | "clips_unknown"
  /**
   * §45.37 G8: with connectionStatus same_as_clips, Clip Factory connected this very account after Clip Stories
   * did (any stable identity matches: the channel, Page or user id, or the username or handle), so it is blocked from
   * posting. Without it, same_as_clips is the account the owner just signed in with.
   */
  | "clips_now";

export interface ClipsDestination {
  platform: Platform;
  connected: boolean;
  name: string | null;
}

export interface TikTokCreator {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
}

/** Flat, the keys the platform publishers read (CONTRACTS §17.6, §17.8); the server allow-lists them per platform. */
export type PublishOptions =
  | { privacy?: "public" | "unlisted" | "private"; category?: string; notifySubscribers?: boolean } // youtube
  | {
      privacyLevel: string;
      disableComment: boolean;
      disableDuet: boolean;
      disableStitch: boolean;
      brandContent: boolean;
      brandOrganic: boolean;
    } // tiktok
  | { shareToFeed?: boolean } // instagram
  | Record<string, never>; // facebook, x

export interface PublishTarget {
  platform: Platform;
  socialAccountId: string;
  options?: PublishOptions;
  /** the externalAccountId the owner saw and said yes to (CONTRACTS §45.34), sent again after a 409 that named it */
  confirmAccount?: string;
}

/** The account a publishing 409 names (`error.account`, CONTRACTS §45.34): where the post would go now. */
export interface ErrorAccount {
  externalAccountId: string;
  accountName: string | null;
  handle: string | null;
}

export interface PublishingJob {
  publishingJobId: string;
  workspaceId: string;
  contentId: string;
  socialAccountId: string;
  platform: Platform;
  publishingStatus: "queued" | "publishing" | "posted" | "failed" | "needs_attention";
  accountName: string | null;
  /** the exact account the post goes to (CONTRACTS §45.34) */
  handle?: string | null;
  externalAccountId?: string | null;
  url?: string;
  postedAt?: string;
  error?: string;
  /**
   * §45.37 G6: on Clip Factory's shared app, Clip Factory's posts go first; with no room left the post waits (status
   * queued or publishing) until the window resets (`waitingUntil`, ISO) and then goes out by itself. `waiting` is the
   * API's own line ("Waiting: Clip Factory's posts go first. Posts at 23 Nov 08:00 UTC."). Both null while not waiting.
   */
  waitingUntil?: string | null;
  waiting?: string | null;
  metrics?: { views: number | null; likes: number | null; comments: number | null; shares: number | null; checkedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface StoriesDashboard {
  counts: { made: number; review: number; published: number; producing: number; needsCheck: number; needsYou: number };
  needsYou: {
    publishingJobId: string | null;
    storyId: string | null;
    title: string;
    platform: Platform | null;
    sentence: string;
    href: string;
  }[];
  producing: { storyId: string; title: string; step: StepKey; progress: number }[];
  accounts: { platform: Platform; status: SocialAccount["connectionStatus"]; accountName: string | null }[];
  performance: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    posts: number;
    checkedAt: string | null;
    lastAt: string | null;
  };
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
  patchWorkspace(ws: string, patch: { workspaceName?: string; configuration?: StoriesConfigPatch; version: number }): Promise<Workspace>;
  dashboard(ws: string): Promise<StoriesDashboard>;

  listIdeas(ws: string, status?: "saved" | "used" | "all"): Promise<Idea[]>;
  createIdea(ws: string, idea: IdeaInput): Promise<Idea>;
  patchIdea(ws: string, ideaId: string, patch: Partial<IdeaInput>): Promise<Idea>;
  deleteIdea(ws: string, ideaId: string): Promise<void>;
  /** AI work runs in Lamo Stories' own agent as a task: poll getTask until done (result.drafts / result.idea) */
  generateIdeas(ws: string, body: { topic?: string; category?: IdeaCategory; count?: number; override?: ModelOverride }): Promise<AiTask>;
  expandIdea(ws: string, ideaId: string, body?: { durationSec?: number; override?: ModelOverride }): Promise<AiTask>;
  ideaVariations(ws: string, ideaId: string, body?: { count?: number; override?: ModelOverride }): Promise<AiTask>;
  getTask(ws: string, taskId: string): Promise<AiTask>;

  listCharacters(ws: string): Promise<Character[]>;
  createCharacter(ws: string, c: CharacterInput): Promise<Character>;
  getCharacter(ws: string, characterId: string): Promise<Character>;
  putCharacter(ws: string, characterId: string, c: CharacterInput & { version: number }): Promise<Character>;
  deleteCharacter(ws: string, characterId: string): Promise<void>;
  referenceUpload(ws: string, characterId: string, file: { filename: string; contentType: string; size: number }): Promise<Upload>;
  referenceComplete(ws: string, characterId: string, assetId: string): Promise<Character>;
  deleteReference(ws: string, characterId: string, assetId: string): Promise<Character>;
  makePortrait(ws: string, characterId: string): Promise<ProductionJob>;
  /** a picture for "Design with AI" (an ASSET# of kind design_ref) */
  designUpload(ws: string, file: { filename: string; contentType: string; size: number }): Promise<Upload>;
  /** the character agent's suggested CharacterInput in result.character (a draft); with characterId it redesigns that character (CONTRACTS §45.34) */
  designCharacter(ws: string, body: { description?: string; referenceAssetId?: string; characterId?: string; override?: ModelOverride }): Promise<AiTask>;

  listStories(ws: string, q?: { status?: StoryStatus | "all"; limit?: number; cursor?: string }): Promise<{ stories: Story[]; nextCursor: string | null }>;
  createStory(ws: string, body: StoryInput): Promise<{ story: Story; job: ProductionJob }>;
  getStory(ws: string, storyId: string): Promise<{ story: Story; job: ProductionJob | null; script: StoryScript | null }>;
  storyJobs(ws: string, storyId: string): Promise<ProductionJob[]>;
  patchStory(ws: string, storyId: string, patch: StoryPatch): Promise<{ story: Story; script: StoryScript | null }>;
  deleteStory(ws: string, storyId: string): Promise<void>;
  /** no `from`: runs exactly the story's stale steps ("Try again", "Check again", "Remake"); override: this job only */
  produce(ws: string, storyId: string, body?: { from?: StepKey; sceneIds?: string[]; override?: ModelOverride }): Promise<{ story: Story; job: ProductionJob }>;
  cancelStory(ws: string, storyId: string): Promise<{ story: Story; job: ProductionJob | null }>;
  approve(ws: string, storyId: string, version: number): Promise<Story>;
  reject(ws: string, storyId: string, reason?: string): Promise<Story>;
  /** a note, scene ids or both; scene ids without a note is "Remake this scene" (a new take). override: this job only */
  requestChanges(ws: string, storyId: string, body: { note?: string; sceneIds?: string[]; override?: ModelOverride }): Promise<{ story: Story; job: ProductionJob }>;
  /** "Write them again" (CONTRACTS §45.34): a captions task whose result is a CaptionsResult draft; 409 while there is no storyboard */
  writeCaptions(ws: string, storyId: string, body?: { override?: ModelOverride }): Promise<AiTask>;
  /** the MP4, or one of the extra copies the video has (CONTRACTS §45.34 "Output formats") */
  download(ws: string, storyId: string, body?: { format?: DownloadFormat }): Promise<{ url: string; filename: string }>;

  library(ws: string, q?: { kind?: AssetKind | "all"; storyId?: string; characterId?: string; limit?: number; cursor?: string }): Promise<{ items: LibraryItem[]; nextCursor: string | null }>;
  providers(ws: string): Promise<ProviderStatus[]>;
  /** "Try it" on Nova Reel (§45.35 D2): one 6-second test shot; the job ends with the provider's new state (GET …/providers) */
  tryNovaReel(ws: string): Promise<ProductionJob>;
  /** "Try it" on a maker that can be tried (§45.37: Luma AI Ray2, one 5-second test shot, which Amazon bills): POST …/providers/{id}/check */
  tryMaker(ws: string, providerId: "luma-ray" | "own-video"): Promise<ProductionJob>;
  guidance(ws: string): Promise<{ topics: GuidanceTopic[]; checkedAt: string }>;

  social(ws: string): Promise<{ accounts: SocialAccount[]; clips: ClipsDestination[] }>;
  connectSocial(ws: string, platform: Platform): Promise<{ authorizeUrl: string; expiresAt: string }>;
  chooseSocial(ws: string, platform: Platform, choiceId: string): Promise<SocialAccount>;
  checkSocial(ws: string, platform: Platform): Promise<SocialAccount>;
  tiktokCreatorInfo(ws: string): Promise<TikTokCreator>;
  disconnectSocial(ws: string, platform: Platform): Promise<void>;

  /** Facebook and Instagram always use Lamo Stories' own Meta app (CONTRACTS §45.30): "clips" is only for the others */
  setSocialApp(ws: string, platform: "instagram" | "facebook", body: { choice: "own"; clientId: string; clientSecret: string; configId: string }): Promise<SocialAccount>;
  setSocialApp(ws: string, platform: "youtube" | "tiktok" | "x", body: { choice: "clips" } | { choice: "own"; clientId: string; clientSecret: string }): Promise<SocialAccount>;
  checkSocialApp(ws: string, platform: Platform): Promise<KeyCheck>;
  deleteSocialApp(ws: string, platform: Platform): Promise<void>;

  getAi(ws: string): Promise<{ ai: StoriesAiConfig; models: ModelInfo[]; agents: Agent[]; tasks: TaskInfo[] }>;
  /** picked: what the owner chose on purpose (setup steps 1 to 3, §45.34) */
  putAi(ws: string, ai: StoriesAiConfig & { picked?: AiPicked[] }): Promise<StoriesAiConfig>;
  /** add or change a model the owner added (§45.34) */
  putAiModel(ws: string, key: string, def: ModelDef): Promise<ModelInfo>;
  /** 409 with the setting's name while a saved setting uses it */
  deleteAiModel(ws: string, key: string): Promise<void>;
  /**
   * `makers` (§45.37 G2): picture, video and sound models to check in the same task, each an access check that costs
   * nothing; with only `makers`, only those are checked
   */
  checkModels(ws: string, models?: string[], makers?: string[]): Promise<AiTask>;
  /**
   * the picture, video and sound makers' models, bundled and added, each with its status (§45.37 G1, G2): the models
   * of the maker rows of GET …/providers, each once (there is no route of their own)
   */
  makerModels(ws: string): Promise<MakerModelInfo[]>;
  /** add or change a maker model the owner added (MAKERDEF#{key}) */
  putMakerModel(ws: string, key: string, def: MakerModelDef): Promise<MakerModelInfo>;
  /** 409 with the setting's name while Settings › Video picks it */
  deleteMakerModel(ws: string, key: string): Promise<void>;
  setModelPrice(ws: string, modelKey: string, price: { inputPer1M: number; outputPer1M: number; currency: string } | null): Promise<ModelInfo>;
  usage(ws: string, days?: number): Promise<UsageSummary>;
  getAgent(ws: string, agentId: AgentId): Promise<Agent>;
  patchAgent(ws: string, agentId: AgentId, patch: { version: number; instructions?: string; active?: boolean; model?: string | null; effort?: Effort | null; skillIds?: string[] } | { reset: true }): Promise<Agent>;

  listSkills(ws: string): Promise<Skill[]>;
  skillUpload(ws: string, body: { filename: string; skillId?: string }): Promise<{ skillId: string; key: string; uploadUrl: string; headers: Record<string, string> }>;
  createSkill(ws: string, body: { skillId: string; key: string } | { title: string; description: string; instructions: string }): Promise<Skill>;
  getSkill(ws: string, skillId: string): Promise<Skill & { content: string }>;
  putSkill(ws: string, skillId: string, body: { version: number; title?: string; description?: string; instructions?: string; key?: string; enabled?: boolean }): Promise<Skill>;
  deleteSkill(ws: string, skillId: string): Promise<void>;
  restoreSkill(ws: string, skillId: string, revisionId: string): Promise<Skill>;

  listConversations(ws: string): Promise<Conversation[]>;
  createConversation(ws: string, body: { title?: string; projectRef?: ProjectRef; model?: string | null; effort?: Effort | null }): Promise<Conversation>;
  /** the newest 500 messages; `after` only the newer ones (the poll), `before` the 500 older ones ("Show earlier messages") */
  getConversation(ws: string, convId: string, q?: { after?: string; before?: string }): Promise<{ conversation: Conversation; messages: Message[] }>;
  patchConversation(ws: string, convId: string, patch: { title?: string; model?: string | null; effort?: Effort | null; projectRef?: ProjectRef | null }): Promise<Conversation>;
  deleteConversation(ws: string, convId: string): Promise<void>;
  sendMessage(ws: string, convId: string, body: { text: string; attachments?: { assetId: string }[]; override?: ModelOverride }): Promise<{ user: Message; assistant: Message }>;
  chatAttachment(ws: string, convId: string, file: { filename: string; contentType: string; size: number }): Promise<Upload>;
  stopMessage(ws: string, convId: string, msgId: string): Promise<Message>;

  listMemory(ws: string): Promise<MemoryItem[]>;
  addMemory(ws: string, text: string): Promise<MemoryItem>;
  patchMemory(ws: string, memId: string, text: string): Promise<MemoryItem>;
  deleteMemory(ws: string, memId: string): Promise<void>;

  listReferences(ws: string): Promise<ReferenceVideo[]>;
  createReference(ws: string, body: { filename: string; contentType: string; size: number; title: string }): Promise<{ reference: ReferenceVideo; upload: { uploadId: string; parts: { partNumber: number; url: string }[] } }>;
  completeReference(ws: string, refId: string, parts: { partNumber: number; etag: string }[]): Promise<ReferenceVideo>;
  analyzeReference(ws: string, refId: string, override?: ModelOverride): Promise<{ reference: ReferenceVideo; job: ProductionJob }>;
  /** `job`: the analysis job of currentJobId, else the latest one (CONTRACTS §45.34) */
  getReference(ws: string, refId: string): Promise<{ reference: ReferenceVideo; analysis: ReferenceAnalysis | null; job: ProductionJob | null }>;
  /** the title, and the video's own model and effort (`ai`, §45.25 level 2: "Keep with this video") */
  patchReference(ws: string, refId: string, patch: { title?: string; ai?: AiSetting }): Promise<ReferenceVideo>;
  /** a reference video (renamed from deleteReference(ws, refId), CONTRACTS §45.34; deleteReference is a character's picture) */
  deleteReferenceVideo(ws: string, refId: string): Promise<void>;

  getOnboarding(ws: string): Promise<Onboarding>;
  patchOnboarding(ws: string, body: { step: OnboardStep; done?: boolean; skipped?: boolean } | { finish: true }): Promise<Onboarding>;
  /** an OpenAI-compatible key is for one address: its models' (or `baseUrl`, before any is added); §45.37 G4 */
  setProviderKey(ws: string, providerId: string, key: string, baseUrl?: string): Promise<ProviderStatus>;
  deleteProviderKey(ws: string, providerId: string): Promise<void>;
  storage(ws: string): Promise<StorageSummary>;
  /** applies keepReferences, keepChatPictures and keepVersions now (§45.34) */
  storageCleanup(ws: string): Promise<{ removed: { files: number; bytes: number } }>;

  publish(ws: string, storyId: string, targets: PublishTarget[]): Promise<PublishingJob[]>;
  listPublishing(ws: string, storyId?: string): Promise<PublishingJob[]>;
  retryPublishing(ws: string, publishingJobId: string, body?: { options?: PublishOptions; confirmAccount?: string }): Promise<PublishingJob>;
}
