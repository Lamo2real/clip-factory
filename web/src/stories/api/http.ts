// The HTTP client for Lamo Stories (docs/CONTRACTS.md §45.5): every StoriesApi method against
// `${apiUrl}/v1/workspaces/...`, with the same sign-in as Lamo Clips (one Cognito session, one API): the owner's
// access token on every call, one forced refresh after a 401, the contract's error envelope as an ApiError with a
// plain sentence, and a sign-in that is really gone announced once. Lamo Clips' own client (web/src/api/http.ts)
// is not changed; this file only uses its exported pieces.
import { ApiError, errorFromResponse, networkError } from "../../api/errors.ts";
import { announceSignedOut, auth, type AuthClient } from "../../lib/auth.ts";
import { config } from "../../lib/config.ts";
import type {
  Agent,
  AiTask,
  Character,
  ClipsDestination,
  Conversation,
  ErrorAccount,
  GuidanceTopic,
  Idea,
  KeyCheck,
  LibraryItem,
  MemoryItem,
  Message,
  ModelInfo,
  Onboarding,
  ProductionJob,
  ProviderStatus,
  PublishingJob,
  ReferenceAnalysis,
  ReferenceVideo,
  Skill,
  SocialAccount,
  StoriesAiConfig,
  StoriesApi,
  StoriesDashboard,
  StorageSummary,
  Story,
  StoryScript,
  TaskInfo,
  TikTokCreator,
  Upload,
  UsageSummary,
  Workspace,
} from "./types.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Lamo Stories' ApiError: the shared one (web/src/api/errors.ts, unchanged) plus the account a publishing 409 names
 * (`error.account`, CONTRACTS §45.34), so the publish sheet and Posts' Try again can ask "Post to {name}?".
 */
export class StoriesApiError extends ApiError {
  readonly account: ErrorAccount;

  constructor(base: ApiError, account: ErrorAccount) {
    super(base.status, base.code, base.message, base.field, base.retryAfter);
    this.name = "ApiError";
    this.account = account;
  }
}

const shortText = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);

/** The account an error envelope names (`error.account`), checked; null when there is none or it is not one. */
export function errorAccount(body: unknown): ErrorAccount | null {
  const raw = (body as { error?: { account?: unknown } } | null)?.error?.account;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const externalAccountId = shortText(a.externalAccountId, 200);
  if (!externalAccountId) return null;
  return { externalAccountId, accountName: shortText(a.accountName, 200), handle: shortText(a.handle, 200) };
}

export interface StoriesHttpDeps {
  /** The API's base, without /v1 (config().apiUrl by default, read at the first call). */
  baseUrl?: string;
  auth?: Pick<AuthClient, "accessToken">;
  fetcher?: typeof fetch;
}

export function httpStoriesApi(deps: StoriesHttpDeps = {}): StoriesApi {
  const fetcher = deps.fetcher ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const tokens = () => deps.auth ?? auth();
  const base = () => (deps.baseUrl ?? config().apiUrl).replace(/\/+$/, "");

  async function send(method: Method, path: string, token: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const json = body === undefined ? undefined : JSON.stringify(body);
    try {
      return await fetcher(`${base()}/v1${path}`, {
        method,
        headers,
        body: json,
        cache: "no-store",
        // A small edit saved as the app closes still reaches the server.
        ...(method === "PATCH" && (json?.length ?? 0) < 60_000 ? { keepalive: true } : {}),
      });
    } catch {
      throw networkError();
    }
  }

  async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res = await send(method, path, await tokens().accessToken(), body);
    // One forced refresh covers a token that expired between Amplify's check and the request.
    if (res.status === 401) {
      const fresh = await tokens().accessToken(true);
      if (fresh) res = await send(method, path, fresh, body);
    }
    if (res.status === 204) return undefined as T;
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const base = errorFromResponse(res.status, parsed);
      if (base.status === 401) announceSignedOut();
      const account = errorAccount(parsed);
      throw account ? new StoriesApiError(base, account) : base;
    }
    if (parsed === null || typeof parsed !== "object") throw new ApiError(res.status, "internal", "The server sent an empty answer. Try again.");
    return parsed as T;
  }

  const q = (params: Record<string, string | number | null | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  };
  const id = encodeURIComponent;
  const w = (ws: string, rest = "") => `/workspaces/${id(ws)}${rest}`;

  return {
    listWorkspaces: async () => (await call<{ workspaces: Workspace[] }>("GET", "/workspaces")).workspaces,
    getWorkspace: async (ws) => (await call<{ workspace: Workspace }>("GET", w(ws))).workspace,
    patchWorkspace: async (ws, patch) => (await call<{ workspace: Workspace }>("PATCH", w(ws), patch)).workspace,
    dashboard: async (ws) => (await call<{ dashboard: StoriesDashboard }>("GET", w(ws, "/dashboard"))).dashboard,

    listIdeas: async (ws, status) => (await call<{ ideas: Idea[] }>("GET", w(ws, `/ideas${q({ status })}`))).ideas,
    createIdea: async (ws, idea) => (await call<{ idea: Idea }>("POST", w(ws, "/ideas"), idea)).idea,
    patchIdea: async (ws, ideaId, patch) => (await call<{ idea: Idea }>("PATCH", w(ws, `/ideas/${id(ideaId)}`), patch)).idea,
    deleteIdea: (ws, ideaId) => call<void>("DELETE", w(ws, `/ideas/${id(ideaId)}`)),
    generateIdeas: async (ws, body) => (await call<{ task: AiTask }>("POST", w(ws, "/ideas/generate"), body)).task,
    expandIdea: async (ws, ideaId, body) => (await call<{ task: AiTask }>("POST", w(ws, `/ideas/${id(ideaId)}/expand`), body ?? {})).task,
    ideaVariations: async (ws, ideaId, body) => (await call<{ task: AiTask }>("POST", w(ws, `/ideas/${id(ideaId)}/variations`), body ?? {})).task,
    getTask: async (ws, taskId) => (await call<{ task: AiTask }>("GET", w(ws, `/tasks/${id(taskId)}`))).task,

    listCharacters: async (ws) => (await call<{ characters: Character[] }>("GET", w(ws, "/characters"))).characters,
    createCharacter: async (ws, c) => (await call<{ character: Character }>("POST", w(ws, "/characters"), c)).character,
    getCharacter: async (ws, characterId) => (await call<{ character: Character }>("GET", w(ws, `/characters/${id(characterId)}`))).character,
    putCharacter: async (ws, characterId, c) => (await call<{ character: Character }>("PUT", w(ws, `/characters/${id(characterId)}`), c)).character,
    deleteCharacter: (ws, characterId) => call<void>("DELETE", w(ws, `/characters/${id(characterId)}`)),
    referenceUpload: (ws, characterId, file) => call<Upload>("POST", w(ws, `/characters/${id(characterId)}/references`), file),
    referenceComplete: async (ws, characterId, assetId) =>
      (await call<{ character: Character }>("POST", w(ws, `/characters/${id(characterId)}/references/${id(assetId)}/complete`))).character,
    // A character's reference picture; a reference video is deleteReferenceVideo (the rename of CONTRACTS §45.34).
    deleteReference: async (ws, characterId, assetId) =>
      (await call<{ character: Character }>("DELETE", w(ws, `/characters/${id(characterId)}/references/${id(assetId)}`))).character,
    makePortrait: async (ws, characterId) => (await call<{ job: ProductionJob }>("POST", w(ws, `/characters/${id(characterId)}/portrait`))).job,
    designUpload: (ws, file) => call<Upload>("POST", w(ws, "/characters/design/uploads"), file),
    designCharacter: async (ws, body) => (await call<{ task: AiTask }>("POST", w(ws, "/characters/design"), body)).task,

    listStories: async (ws, query = {}) => {
      const r = await call<{ stories: Story[]; nextCursor?: string | null }>("GET", w(ws, `/stories${q({ status: query.status, limit: query.limit, cursor: query.cursor })}`));
      return { stories: r.stories, nextCursor: r.nextCursor ?? null };
    },
    createStory: (ws, body) => call<{ story: Story; job: ProductionJob }>("POST", w(ws, "/stories"), body),
    getStory: async (ws, storyId) => {
      const r = await call<{ story: Story; job?: ProductionJob | null; script?: StoryScript | null }>("GET", w(ws, `/stories/${id(storyId)}`));
      return { story: r.story, job: r.job ?? null, script: r.script ?? null };
    },
    storyJobs: async (ws, storyId) => (await call<{ jobs: ProductionJob[] }>("GET", w(ws, `/stories/${id(storyId)}/jobs`))).jobs,
    patchStory: async (ws, storyId, patch) => {
      const r = await call<{ story: Story; script?: StoryScript | null }>("PATCH", w(ws, `/stories/${id(storyId)}`), patch);
      return { story: r.story, script: r.script ?? null };
    },
    deleteStory: (ws, storyId) => call<void>("DELETE", w(ws, `/stories/${id(storyId)}`)),
    produce: (ws, storyId, body) => call<{ story: Story; job: ProductionJob }>("POST", w(ws, `/stories/${id(storyId)}/produce`), body ?? {}),
    cancelStory: async (ws, storyId) => {
      const r = await call<{ story: Story; job?: ProductionJob | null }>("POST", w(ws, `/stories/${id(storyId)}/cancel`));
      return { story: r.story, job: r.job ?? null };
    },
    approve: async (ws, storyId, version) => (await call<{ story: Story }>("POST", w(ws, `/stories/${id(storyId)}/approve`), { version })).story,
    reject: async (ws, storyId, reason) =>
      (await call<{ story: Story }>("POST", w(ws, `/stories/${id(storyId)}/reject`), reason ? { reason } : {})).story,
    requestChanges: (ws, storyId, body) => call<{ story: Story; job: ProductionJob }>("POST", w(ws, `/stories/${id(storyId)}/changes`), body),
    writeCaptions: async (ws, storyId, body) => (await call<{ task: AiTask }>("POST", w(ws, `/stories/${id(storyId)}/captions`), body ?? {})).task,
    // The MP4 keeps its GET route; an extra copy (WebM, MOV) is asked for by name (CONTRACTS §45.34).
    download: (ws, storyId, body) =>
      body?.format && body.format !== "mp4"
        ? call<{ url: string; filename: string }>("POST", w(ws, `/stories/${id(storyId)}/download`), { format: body.format })
        : call<{ url: string; filename: string }>("GET", w(ws, `/stories/${id(storyId)}/download`)),

    library: async (ws, query = {}) => {
      const r = await call<{ items: LibraryItem[]; nextCursor?: string | null }>(
        "GET",
        w(ws, `/library${q({ kind: query.kind, storyId: query.storyId, characterId: query.characterId, limit: query.limit, cursor: query.cursor })}`),
      );
      return { items: r.items, nextCursor: r.nextCursor ?? null };
    },
    providers: async (ws) => (await call<{ providers: ProviderStatus[] }>("GET", w(ws, "/providers"))).providers,
    guidance: (ws) => call<{ topics: GuidanceTopic[]; checkedAt: string }>("GET", w(ws, "/guidance")),

    social: (ws) => call<{ accounts: SocialAccount[]; clips: ClipsDestination[] }>("GET", w(ws, "/social")),
    connectSocial: (ws, platform) => call<{ authorizeUrl: string; expiresAt: string }>("POST", w(ws, `/social/${id(platform)}/connect`)),
    chooseSocial: async (ws, platform, choiceId) => (await call<{ account: SocialAccount }>("POST", w(ws, `/social/${id(platform)}/choose`), { choiceId })).account,
    shareWithClips: async (ws, platform) => (await call<{ account: SocialAccount }>("POST", w(ws, `/social/${id(platform)}/share`), { confirm: true })).account,
    checkSocial: async (ws, platform) => (await call<{ account: SocialAccount }>("POST", w(ws, `/social/${id(platform)}/check`))).account,
    tiktokCreatorInfo: async (ws) => (await call<{ creator: TikTokCreator }>("GET", w(ws, "/social/tiktok/creator-info"))).creator,
    disconnectSocial: (ws, platform) => call<void>("DELETE", w(ws, `/social/${id(platform)}`)),
    // The keys go to the server once and never come back (only masked hints, §45.30).
    setSocialApp: async (ws: string, platform: string, body: unknown) => (await call<{ account: SocialAccount }>("PUT", w(ws, `/social/${id(platform)}/app`), body)).account,
    checkSocialApp: async (ws, platform) => (await call<{ check: KeyCheck }>("POST", w(ws, `/social/${id(platform)}/app/check`))).check,
    deleteSocialApp: (ws, platform) => call<void>("DELETE", w(ws, `/social/${id(platform)}/app`)),

    getAi: (ws) => call<{ ai: StoriesAiConfig; models: ModelInfo[]; agents: Agent[]; tasks: TaskInfo[] }>("GET", w(ws, "/ai")),
    putAi: async (ws, ai) => (await call<{ ai: StoriesAiConfig }>("PUT", w(ws, "/ai"), ai)).ai,
    putAiModel: async (ws, key, def) => (await call<{ model: ModelInfo }>("PUT", w(ws, `/ai/models/${id(key)}`), def)).model,
    deleteAiModel: (ws, key) => call<void>("DELETE", w(ws, `/ai/models/${id(key)}`)),
    checkModels: async (ws, models) => (await call<{ task: AiTask }>("POST", w(ws, "/ai/check-models"), models ? { models } : {})).task,
    setModelPrice: async (ws, modelKey, price) => (await call<{ model: ModelInfo }>("PUT", w(ws, `/ai/prices/${id(modelKey)}`), price ?? {})).model,
    usage: async (ws, days) => (await call<{ usage: UsageSummary }>("GET", w(ws, `/usage${q({ days })}`))).usage,
    getAgent: async (ws, agentId) => (await call<{ agent: Agent }>("GET", w(ws, `/agents/${id(agentId)}`))).agent,
    patchAgent: async (ws, agentId, patch) => (await call<{ agent: Agent }>("PATCH", w(ws, `/agents/${id(agentId)}`), patch)).agent,

    listSkills: async (ws) => (await call<{ skills: Skill[] }>("GET", w(ws, "/skills"))).skills,
    skillUpload: (ws, body) => call<{ skillId: string; key: string; uploadUrl: string; headers: Record<string, string> }>("POST", w(ws, "/skills/uploads"), body),
    createSkill: async (ws, body) => (await call<{ skill: Skill }>("POST", w(ws, "/skills"), body)).skill,
    getSkill: async (ws, skillId) => {
      // The skill's text comes with it (on the skill, or beside it).
      const r = await call<{ skill: Skill & { content?: string }; content?: string }>("GET", w(ws, `/skills/${id(skillId)}`));
      return { ...r.skill, content: r.skill.content ?? r.content ?? "" };
    },
    putSkill: async (ws, skillId, body) => (await call<{ skill: Skill }>("PUT", w(ws, `/skills/${id(skillId)}`), body)).skill,
    deleteSkill: (ws, skillId) => call<void>("DELETE", w(ws, `/skills/${id(skillId)}`)),
    restoreSkill: async (ws, skillId, revisionId) => (await call<{ skill: Skill }>("POST", w(ws, `/skills/${id(skillId)}/restore`), { revisionId })).skill,

    listConversations: async (ws) => (await call<{ conversations: Conversation[] }>("GET", w(ws, "/chat"))).conversations,
    createConversation: async (ws, body) => (await call<{ conversation: Conversation }>("POST", w(ws, "/chat"), body)).conversation,
    getConversation: (ws, convId, page) =>
      call<{ conversation: Conversation; messages: Message[] }>("GET", w(ws, `/chat/${id(convId)}${q({ after: page?.after, before: page?.before })}`)),
    patchConversation: async (ws, convId, patch) => (await call<{ conversation: Conversation }>("PATCH", w(ws, `/chat/${id(convId)}`), patch)).conversation,
    deleteConversation: (ws, convId) => call<void>("DELETE", w(ws, `/chat/${id(convId)}`)),
    sendMessage: (ws, convId, body) => call<{ user: Message; assistant: Message }>("POST", w(ws, `/chat/${id(convId)}/messages`), body),
    chatAttachment: (ws, convId, file) => call<Upload>("POST", w(ws, `/chat/${id(convId)}/attachments`), file),
    stopMessage: async (ws, convId, msgId) => (await call<{ message: Message }>("POST", w(ws, `/chat/${id(convId)}/messages/${id(msgId)}/stop`))).message,

    listMemory: async (ws) => (await call<{ memory: MemoryItem[] }>("GET", w(ws, "/memory"))).memory,
    addMemory: async (ws, text) => (await call<{ item: MemoryItem }>("POST", w(ws, "/memory"), { text })).item,
    patchMemory: async (ws, memId, text) => (await call<{ item: MemoryItem }>("PATCH", w(ws, `/memory/${id(memId)}`), { text })).item,
    deleteMemory: (ws, memId) => call<void>("DELETE", w(ws, `/memory/${id(memId)}`)),

    listReferences: async (ws) => (await call<{ references: ReferenceVideo[] }>("GET", w(ws, "/references"))).references,
    createReference: (ws, body) =>
      call<{ reference: ReferenceVideo; upload: { uploadId: string; parts: { partNumber: number; url: string }[] } }>("POST", w(ws, "/references"), body),
    completeReference: async (ws, refId, parts) => (await call<{ reference: ReferenceVideo }>("POST", w(ws, `/references/${id(refId)}/complete`), { parts })).reference,
    analyzeReference: (ws, refId, override) =>
      call<{ reference: ReferenceVideo; job: ProductionJob }>("POST", w(ws, `/references/${id(refId)}/analyze`), override ? { override } : {}),
    getReference: async (ws, refId) => {
      const r = await call<{ reference: ReferenceVideo; analysis?: ReferenceAnalysis | null; job?: ProductionJob | null }>("GET", w(ws, `/references/${id(refId)}`));
      return { reference: r.reference, analysis: r.analysis ?? null, job: r.job ?? null };
    },
    patchReference: async (ws, refId, patch) => (await call<{ reference: ReferenceVideo }>("PATCH", w(ws, `/references/${id(refId)}`), patch)).reference,
    deleteReferenceVideo: (ws, refId) => call<void>("DELETE", w(ws, `/references/${id(refId)}`)),

    getOnboarding: async (ws) => (await call<{ onboarding: Onboarding }>("GET", w(ws, "/onboarding"))).onboarding,
    patchOnboarding: async (ws, body) => (await call<{ onboarding: Onboarding }>("PATCH", w(ws, "/onboarding"), body)).onboarding,
    // A provider's key is sent once and never returned (§45.31).
    setProviderKey: async (ws, providerId, key) => (await call<{ provider: ProviderStatus }>("PUT", w(ws, `/providers/${id(providerId)}/key`), { key })).provider,
    deleteProviderKey: (ws, providerId) => call<void>("DELETE", w(ws, `/providers/${id(providerId)}/key`)),
    storage: async (ws) => (await call<{ storage: StorageSummary }>("GET", w(ws, "/storage"))).storage,
    storageCleanup: (ws) => call<{ removed: { files: number; bytes: number } }>("POST", w(ws, "/storage/cleanup")),

    publish: async (ws, storyId, targets) =>
      (await call<{ publishingJobs: PublishingJob[] }>("POST", w(ws, `/stories/${id(storyId)}/publish`), { targets })).publishingJobs,
    listPublishing: async (ws, storyId) => (await call<{ publishingJobs: PublishingJob[] }>("GET", w(ws, `/publishing${q({ storyId })}`))).publishingJobs,
    retryPublishing: async (ws, publishingJobId, body) =>
      (await call<{ publishingJob: PublishingJob }>("POST", w(ws, `/publishing/${id(publishingJobId)}/retry`), body ?? {})).publishingJob,
  };
}
