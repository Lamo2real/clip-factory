// Lamo Stories mock: the ai part (docs/CONTRACTS.md §45.16.8, §45.25, §45.26, §45.29, §45.31, §45.34). Builders F2
// and W3c. The AI configuration (AICONFIG, with what the owner picked on purpose for setup steps 1 to 3), the model
// list from Lamo Stories' own stories/config/models.json (never Clip Factory's config/models.json) plus the models the
// owner added (MODELDEF#, Bedrock models, at most 20, never shadowing a bundled key), each model's last call result
// (MODELSTATUS#, one model denied), Check models as a task that walks queued → running → done, the owner's prices
// (per million tokens for models; per picture or second for the picture and video makers), 30 days of usage per
// model, provider and day (render minutes too), the five agents from stories/config/agents.json, provider keys (as
// the API: none takes one today; the key never comes back, only its last four), the storage summary with its place,
// and Clean up now. The resolver follows §45.25 and passes stories/config/resolve-cases.json.
//
// §45.37 (G1 to G5): the picture, video and sound makers' models (stories/config/models.json's lists, an older
// file's imageModel and videoModel read as one-item lists, plus MAKERDEF# models the owner adds: at most 20 per kind,
// never shadowing a bundled key, 409 on remove while Settings › Video picks one), Check models' free access check for
// them (Works, No access, Not found, in the provider's words), who runs an added model (host: bedrock, anthropic or
// openai_compatible with its https base URL), the two keyed hosts in Provider keys (the key never comes back, only
// its hint), and the tasks text_edit (Low) and animation_plan (High).
import agentsFile from "../../../../../stories/config/agents.json";
import modelsFile from "../../../../../stories/config/models.json";
import { ApiError } from "../../../api/errors.ts";
import type {
  Agent,
  AgentId,
  AiPicked,
  AiTask,
  Effective,
  Effort,
  MakerKind,
  MakerModelDef,
  MakerModelInfo,
  MakerPrice,
  ModelDef,
  ModelHost,
  ModelInfo,
  Price,
  ProviderStatus,
  ProviderUsage,
  StorageSummary,
  StoriesAiConfig,
  StoriesApi,
  StoriesConfig,
  TaskInfo,
  TaskKind,
  UsageSummary,
} from "../types.ts";
import {
  callingFor,
  CUSTOM_MODEL_KEY,
  EFFORT_LABEL,
  HOST_LABEL,
  hostIdOf,
  KEYED_HOSTS,
  MAKER_KINDS,
  MAX_CUSTOM_MAKER_MODELS,
  MAX_CUSTOM_MODELS,
  MODEL_HOSTS,
  modelRegionProblem,
  OWN_MAKER,
  type ModelCalling,
} from "../types.ts";
import { bundledMakerModels, type FileMakerModel } from "../../settings/makerFile.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = [
  "getAi",
  "putAi",
  "putAiModel",
  "deleteAiModel",
  "checkModels",
  "setModelPrice",
  "putMakerModel",
  "deleteMakerModel",
  "usage",
  "getAgent",
  "patchAgent",
  "setProviderKey",
  "deleteProviderKey",
  "storage",
  "storageCleanup",
] as const;

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const DAY_MS = 86_400_000;

interface ModelEntry {
  key: string;
  label: string;
  provider: string;
  modelId: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  pricing: Price | null;
  /** who runs it (§45.35 D8): the file's `host`, else Amazon Bedrock */
  host?: string;
  /** one the owner added (MODELDEF#), with its own Region, output limit and way of being called (§45.35 D1) */
  custom?: { region: string; maxOutputTokens: number; hostId: ModelHost; baseUrl: string | null } & ModelCalling;
}

/** Who runs Lamo Stories' models (§45.35 D8): the bundled ones are called on Amazon Bedrock. */
export const MODEL_HOST = "Amazon Bedrock";

/**
 * ModelInfo.host and MakerModelInfo.host for a host id (§45.37 G4, the API's hosts.host_label): Amazon Bedrock, the
 * Anthropic API, ElevenLabs, or an OpenAI-compatible API's own address name (api.example.com).
 */
export function hostWord(host: ModelHost | undefined | null, baseUrl?: string | null): string {
  if (host === "openai_compatible" && baseUrl) {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      /* the label below */
    }
  }
  return HOST_LABEL[host ?? "bedrock"] ?? MODEL_HOST;
}

/**
 * The models Lamo Stories may use: stories/config/models.json, plus one mock-only entry that shows the two rarer
 * cases on screen: a model with no effort setting and no known price (the architecture takes any Bedrock model as
 * one entry, §45.25).
 */
export const MOCK_MODELS: ModelEntry[] = [
  ...(modelsFile.models as unknown as ModelEntry[]).map((m) => ({
    key: m.key,
    label: m.label,
    provider: m.provider,
    modelId: m.modelId,
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    vision: m.vision,
    pricing: m.pricing ? { ...m.pricing } : null,
    ...(m.host ? { host: m.host } : {}),
  })),
  { key: "nova-pro", label: "Amazon Nova Pro", provider: "Amazon", modelId: "amazon.nova-pro-v1:0", efforts: [], defaultEffort: null, vision: true, pricing: null },
];

export const FILE_DEFAULT_MODEL: string = modelsFile.defaultModel;
export const FILE_DEFAULT_EFFORT: Effort = modelsFile.defaultEffort as Effort;

interface AgentFileEntry {
  agentId: AgentId;
  name: string;
  tasks: TaskKind[];
  skills: string[];
  instructions: string;
}
const AGENTS_FILE = agentsFile.agents as unknown as AgentFileEntry[];

/** Each task, in the order the Settings table shows them, with its plain name and the suggested effort (§45.25). */
export const TASKS: { kind: TaskKind; label: string; suggestedEffort: Effort }[] = [
  { kind: "chat", label: "Chat", suggestedEffort: "medium" },
  { kind: "text_edit", label: "Small word changes", suggestedEffort: "low" },
  { kind: "brainstorm", label: "Ask for ideas", suggestedEffort: "medium" },
  { kind: "expand_idea", label: "Make it a full idea", suggestedEffort: "high" },
  { kind: "variations", label: "More like this", suggestedEffort: "medium" },
  { kind: "reference_analysis", label: "Study a reference video", suggestedEffort: "high" },
  { kind: "storyboard", label: "Write the story", suggestedEffort: "high" },
  { kind: "animation_plan", label: "Plan the animation", suggestedEffort: "high" },
  { kind: "scene_rewrite", label: "Remake a scene", suggestedEffort: "high" },
  { kind: "captions", label: "Write the post captions", suggestedEffort: "low" },
  { kind: "character_design", label: "Design a character", suggestedEffort: "medium" },
  { kind: "fact_check", label: "Check the facts", suggestedEffort: "high" },
  { kind: "final_review", label: "Last look at the video", suggestedEffort: "high" },
];

/** The agent of a task stories/config/agents.json does not list yet (§45.37 G5): chat edits and scene planning. */
const NEW_TASK_AGENT: Partial<Record<TaskKind, AgentId>> = { text_edit: "creative_director", animation_plan: "storyboard" };

export function agentForTask(kind: TaskKind): AgentId {
  return AGENTS_FILE.find((a) => a.tasks.includes(kind))?.agentId ?? NEW_TASK_AGENT[kind] ?? "creative_director";
}

// ---------- The resolver (§45.25): request > conversation or project > task > agent > workspace default ----------

export interface ResolveInput {
  task: TaskKind;
  ai: Partial<Pick<StoriesAiConfig, "defaultModel" | "defaultEffort" | "tasks">>;
  agent?: { model?: string | null; effort?: string | null } | null;
  conversation?: { model?: string | null; effort?: string | null } | null;
  project?: { model?: string | null; effort?: string | null } | null;
  request?: { model?: string | null; effort?: string | null } | null;
}

export type Resolved = Effective | { error: "model" | "effort"; message: string };

/** Model and effort are merged separately; `from` is the level the model came from. Unknown ones are refused. */
export function resolveEffective(input: ResolveInput, models: readonly ModelEntry[] = MOCK_MODELS): Resolved {
  const task = input.ai.tasks?.[input.task];
  const levels: [Effective["from"], { model?: string | null; effort?: string | null } | null | undefined][] = [
    ["request", input.request],
    [input.conversation ? "conversation" : "project", input.conversation ?? input.project],
    ["task", task],
    ["agent", input.agent],
    ["default", { model: input.ai.defaultModel ?? FILE_DEFAULT_MODEL, effort: input.ai.defaultEffort ?? FILE_DEFAULT_EFFORT }],
  ];
  let model: string | null = null;
  let from: Effective["from"] = "default";
  let effort: string | null = null;
  for (const [level, set] of levels) {
    if (!set) continue;
    if (model === null && set.model) {
      model = set.model;
      from = level;
    }
    if (effort === null && set.effort) effort = set.effort;
  }
  const entry = models.find((m) => m.key === model);
  if (!entry) return { error: "model", message: "That model is not one Clip Factory Stories can use. Pick another model in Clip Factory Stories › Settings › AI." };
  if (effort !== null && !(EFFORTS as readonly string[]).includes(effort)) return { error: "effort", message: "That effort level does not exist. Pick Low, Medium, High, Extra high or Maximum." };
  if (!entry.efforts.length) return { model: entry.key, effort: null, effortApplied: false, from };
  const e = (effort ?? entry.defaultEffort ?? "high") as Effort;
  if (!entry.efforts.includes(e)) return { error: "effort", message: `${entry.label} does not offer ${EFFORT_LABEL[e]}. Pick another level.` };
  return { model: entry.key, effort: e, effortApplied: true, from };
}

// ---------- The part's own state, beside the shared store ----------

interface Usage {
  day: string;
  model: string;
  input: number;
  output: number;
}

interface MakerUse {
  day: string;
  provider: string;
  units: number;
  unit: "image" | "second" | "character";
}

interface AiState {
  status: Record<string, { status: ModelInfo["status"]; line: string; checkedAt: string | null }>;
  usage: Usage[];
  /** the picture and video makers' use (USAGE# kind provider): built-in render seconds are builtin-rig */
  makers: MakerUse[];
  /** the saved keys (PROVCRED#): an OpenAI-compatible key is for one address (`forOrigin`, §45.37 G4) */
  keys: Record<string, { savedAt: string; hint: string; forOrigin?: string }>;
  /** the models the owner added (MODELDEF#{key}), in the order they were added */
  custom: Record<string, ModelDef & { createdAt: string; updatedAt: string }>;
  /** the maker models the owner added (MAKERDEF#{key}, §45.37 G2), in the order they were added */
  makerCustom: Record<string, MakerModelDef & { createdAt: string; updatedAt: string }>;
  /** each maker model's last access check (§45.37 G2), apart from the reasoning models' MODELSTATUS# */
  makerStatus: Record<string, { status: ModelInfo["status"]; line: string; checkedAt: string | null }>;
  /** AICONFIG.pickedAt: when the owner picked each on purpose (setup steps 1 to 3) */
  picked: Partial<Record<AiPicked, string>>;
  /** when Check models last finished (it ticks setup step 1 too) */
  checkedAt: string | null;
  /** files Clean up now can clear (the mock's stand-in for what the retention choices would remove) */
  clearable: { files: number; bytes: number };
}

const STATE = new WeakMap<MockStore, AiState>();

function state(store: MockStore): AiState {
  let s = STATE.get(store);
  if (!s) {
    s = { status: {}, usage: [], makers: [], keys: {}, custom: {}, makerCustom: {}, makerStatus: {}, picked: {}, checkedAt: null, clearable: { files: 0, bytes: 0 } };
    STATE.set(store, s);
  }
  return s;
}

/** What the owner picked on purpose (AICONFIG.pickedAt) and whether Check models has run, for the onboarding part. */
export function aiPicks(store: MockStore): { picked: Partial<Record<AiPicked, string>>; checkedAt: string | null } {
  const s = state(store);
  return { picked: { ...s.picked }, checkedAt: s.checkedAt };
}

/** Stamps what a PUT …/ai says was picked (also used by the onboarding part's stand-in PUT). */
export function stampPicked(store: MockStore, picked: unknown): void {
  if (picked === undefined) return;
  if (!Array.isArray(picked) || picked.some((p) => !PICKS.includes(p as AiPicked))) throw bad("picked lists environment, model or effort.", "picked");
  const at = new Date().toISOString();
  for (const p of picked as AiPicked[]) state(store).picked[p] = at;
}

const PICKS: readonly AiPicked[] = ["environment", "model", "effort"];

const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);

/** A steady pseudo-random number (the same every page load), for the usage history. */
function wave(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Amazon Bedrock's refusal, in the words the agent writes to MODELSTATUS#. */
function deniedLine(key: string): string {
  const label = MOCK_MODELS.find((m) => m.key === key)?.label ?? key;
  return `Amazon Bedrock said this account has no access to ${label}. Turn it on in the Bedrock console (Model access), then tap Check models.`;
}
const DENIED_LINE = deniedLine("fable-5-1");

export function seed(store: MockStore): void {
  const s = state(store);
  const now = Date.now();
  // The last call of each model (written by the agent after every real call in the real app).
  s.status = {
    "fable-5-2": { status: "ok", line: "It answered on the last call.", checkedAt: iso(now - 3 * 3_600_000) },
    "fable-5-1": { status: "denied", line: DENIED_LINE, checkedAt: iso(now - 26 * 3_600_000) },
    "opus-5-5": { status: "ok", line: "It answered on the last call.", checkedAt: iso(now - 40 * 60_000) },
    "sonnet-5-5": { status: "not_checked", line: "Not checked yet. Tap Check models.", checkedAt: null },
    "haiku-5-5": { status: "ok", line: "It answered on the last call.", checkedAt: iso(now - 5 * DAY_MS) },
    "nova-pro": { status: "not_checked", line: "Not checked yet. Tap Check models.", checkedAt: null },
  };
  // 30 days of model calls: Opus for chat and ideas, Fable 5.2 for the storyboards, Haiku for captions, Nova Pro
  // for a few tries (no price known, so tokens only).
  s.usage = [];
  for (let i = 0; i < 30; i++) {
    const day = dayOf(now - i * DAY_MS);
    if (wave(i, 1) > 0.15) s.usage.push({ day, model: "opus-5-5", input: Math.round(40_000 + wave(i, 2) * 220_000), output: Math.round(6_000 + wave(i, 3) * 30_000) });
    if (wave(i, 4) > 0.45) s.usage.push({ day, model: "fable-5-2", input: Math.round(20_000 + wave(i, 5) * 120_000), output: Math.round(4_000 + wave(i, 6) * 20_000) });
    if (wave(i, 7) > 0.35) s.usage.push({ day, model: "haiku-5-5", input: Math.round(5_000 + wave(i, 8) * 40_000), output: Math.round(800 + wave(i, 9) * 4_000) });
    if (i % 9 === 2) s.usage.push({ day, model: "nova-pro", input: Math.round(8_000 + wave(i, 10) * 30_000), output: Math.round(1_000 + wave(i, 11) * 6_000) });
  }
  // The makers' use: the built-in animator's render seconds every day a video was made (free: it runs on Lamo
  // Stories' own computer), and a few Nova Canvas portraits (no price known yet, so the card asks for one).
  s.makers = [];
  for (let i = 0; i < 30; i++) {
    const day = dayOf(now - i * DAY_MS);
    if (wave(i, 12) > 0.3) s.makers.push({ day, provider: "builtin-rig", units: Math.round(40 + wave(i, 13) * 260), unit: "second" });
    if (i % 6 === 1) s.makers.push({ day, provider: "nova-canvas", units: 1 + Math.round(wave(i, 14) * 3), unit: "image" });
  }
  s.keys = {};
  s.custom = {};
  s.makerCustom = {};
  s.makerStatus = {};
  s.picked = {};
  s.checkedAt = null;
  s.clearable = { files: 14, bytes: 186_000_000 };
  // The five agents, created on first use from stories/config/agents.json. The owner has already given some of them
  // their own model (his own examples: the video analysis and character agents on Fable 5.2, the storyboard agent on
  // Fable 5.1, which this account cannot use yet, so Settings shows why).
  const own: Partial<Record<AgentId, { model?: string; effort?: Effort }>> = {
    video_analysis: { model: "fable-5-2", effort: "high" },
    storyboard: { model: "fable-5-1" },
    character: { model: "fable-5-2" },
    quality_assurance: { model: "opus-5-5", effort: "high" },
  };
  store.agents = AGENTS_FILE.map((a) => ({
    agentId: a.agentId,
    name: a.name,
    // §45.37 G5's two tasks join their agents' lists even while the file in this branch does not name them yet.
    tasks: [...a.tasks, ...(Object.keys(NEW_TASK_AGENT) as TaskKind[]).filter((k) => NEW_TASK_AGENT[k] === a.agentId && !AGENTS_FILE.some((f) => f.tasks.includes(k)))],
    instructions: a.instructions,
    defaultInstructions: a.instructions,
    active: true,
    model: own[a.agentId]?.model ?? null,
    effort: own[a.agentId]?.effort ?? null,
    skillIds: [...a.skills],
    version: 1,
    updatedAt: iso(now - 2 * DAY_MS),
  }));
}

// ---------- Helpers ----------

function bad(message: string, field?: string): ApiError {
  return new ApiError(400, "bad_request", message, field);
}

function conflict(message = "That changed while you were looking. Reload the page, then try again."): ApiError {
  return new ApiError(409, "conflict", message);
}

/** The API's workspace rules: Lamo Clips' id is not a Lamo Stories page; an unknown id is not found. */
export function guardStories(store: MockStore, ws: string): void {
  if (ws === "clips") throw new ApiError(409, "conflict", "That is a Clip Factory Stories page. Switch to Clip Factory Stories first.");
  const known = store.workspaces.length ? store.workspaces.some((w) => w.workspaceId === ws && w.workspaceType === "stories") : ws === "stories";
  if (!known) throw new ApiError(404, "not_found", "We could not find that workspace.");
}

function config(store: MockStore): StoriesAiConfig {
  return store.ai ?? { defaultModel: FILE_DEFAULT_MODEL, defaultEffort: FILE_DEFAULT_EFFORT, tasks: {}, prices: {}, version: 0 };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The bundled models and, after them, the ones the owner added (the API merges MODELDEF# over the file the same way). */
export function allModels(store: MockStore): ModelEntry[] {
  const own = Object.entries(state(store).custom).map(
    ([key, d]): ModelEntry => ({
      key,
      label: d.label,
      provider: d.provider,
      modelId: d.modelId,
      efforts: [...d.efforts],
      defaultEffort: d.defaultEffort,
      vision: d.vision,
      pricing: d.price ? { ...d.price } : null,
      host: hostWord(d.host, d.baseUrl),
      custom: {
        region: d.region ?? "",
        maxOutputTokens: d.maxOutputTokens,
        hostId: d.host ?? "bedrock",
        baseUrl: d.baseUrl ?? null,
        effortField: d.effortField ?? "none",
        tools: d.tools ?? false,
        cache: d.cache ?? false,
      },
    }),
  );
  return [...MOCK_MODELS, ...own];
}

function modelInfo(store: MockStore, m: ModelEntry): ModelInfo {
  const st = state(store).status[m.key] ?? { status: "not_checked" as const, line: "Not checked yet. Tap Check models.", checkedAt: null };
  const owner = config(store).prices[m.key];
  const hostId: ModelHost = m.custom?.hostId ?? "bedrock";
  // As the API's ModelInfo: no key state here (the screens read it from GET …/providers' `key`, §45.37 G4).
  return {
    key: m.key,
    label: m.label,
    provider: m.provider,
    modelId: m.modelId,
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    vision: m.vision,
    status: st.status,
    statusLine: st.line,
    checkedAt: st.checkedAt,
    price: owner ? { ...owner } : m.pricing ? { ...m.pricing } : null,
    custom: !!m.custom,
    host: m.host ?? MODEL_HOST,
    hostId,
    ...(m.custom
      ? {
          region: m.custom.region,
          maxOutputTokens: m.custom.maxOutputTokens,
          effortField: m.custom.effortField,
          tools: m.custom.tools,
          cache: m.custom.cache,
          ...(hostId === "openai_compatible" ? { baseUrl: m.custom.baseUrl ?? "" } : {}),
        }
      : {}),
  };
}

function priceOf(store: MockStore, key: string): Price | null {
  const owner = config(store).prices[key];
  if (owner) return owner;
  return allModels(store).find((m) => m.key === key)?.pricing ?? null;
}

function costOf(store: MockStore, key: string, input: number, output: number): { cost: number | null; currency: string | null } {
  const p = priceOf(store, key);
  if (!p) return { cost: null, currency: null };
  return { cost: Math.round(((input / 1e6) * p.inputPer1M + (output / 1e6) * p.outputPer1M) * 10_000) / 10_000, currency: p.currency };
}

/** A maker's cost (§45.34): the built-in animator is free (0, no currency); the others need the owner's unit price. */
function makerCost(store: MockStore, provider: string, units: number): { cost: number | null; currency: string | null } {
  if (FREE_MAKERS.includes(provider)) return { cost: 0, currency: null };
  const p = config(store).prices[provider];
  if (!p || typeof p.perUnit !== "number") return { cost: null, currency: null };
  return { cost: Math.round(units * p.perUnit * 10_000) / 10_000, currency: p.currency };
}

/** The built-in makers run on Lamo Stories' own computer: priced 0 with no currency (§45.34). */
const FREE_MAKERS = ["builtin-rig", "builtin-2d", "builtin-synth"];

function taskInfos(store: MockStore): TaskInfo[] {
  const ai = config(store);
  const models = allModels(store);
  return TASKS.map((t) => {
    const agentId = agentForTask(t.kind);
    const agent = store.agents.find((a) => a.agentId === agentId) ?? null;
    const r = resolveEffective({ task: t.kind, ai, agent }, models);
    const effective: Effective =
      "error" in r ? { model: ai.tasks[t.kind]?.model ?? agent?.model ?? ai.defaultModel, effort: null, effortApplied: false, from: ai.tasks[t.kind] ? "task" : agent?.model ? "agent" : "default" } : r;
    return { kind: t.kind, label: t.label, agentId, suggestedEffort: t.suggestedEffort, effective };
  });
}

function checkEffort(model: ModelEntry, effort: Effort | null | undefined, field: string): void {
  if (effort === null || effort === undefined) return;
  if (!EFFORTS.includes(effort)) throw bad("That effort level does not exist. Pick Low, Medium, High, Extra high or Maximum.", field);
  if (model.efforts.length && !model.efforts.includes(effort)) throw bad(`${model.label} does not offer ${EFFORT_LABEL[effort]}. Pick another level.`, field);
}

/** An effort saved together with a model that has no effort setting, in the same setting, is refused (§45.34). */
function checkPair(model: ModelEntry, effort: Effort | null | undefined, field: string): void {
  if (effort && !model.efforts.length) throw bad(noEffortSetting(model.label), field);
  checkEffort(model, effort, field);
}

export const noEffortSetting = (label: string) => `${label} has no effort setting; it runs at its own level.`;

function modelEntryIn(models: readonly ModelEntry[], key: string | null | undefined, field: string): ModelEntry {
  const m = models.find((x) => x.key === key);
  if (!m) throw bad("That model is not one Clip Factory Stories can use. Pick one from the list.", field);
  return m;
}

const TASK_KINDS = TASKS.map((t) => t.kind) as string[];

/** The providers that use Lamo Stories' own AWS access, so a key is never asked for (as the API's NO_KEY). */
const NO_KEY: Record<string, string> = {
  "bedrock-claude": "Claude on Amazon Bedrock",
  "nova-canvas": "Amazon Nova Canvas",
  "nova-reel": "Amazon Nova Reel",
  stability: "Stability AI on Amazon Bedrock",
  "luma-ray": "Luma AI Ray2",
  polly: "Amazon Polly",
  "builtin-rig": "The built-in characters",
  "builtin-2d": "The built-in animation",
  "builtin-synth": "The built-in sounds and music",
};

interface KeyedProvider {
  kind: ProviderStatus["kind"];
  id: string;
  label: string;
}

/**
 * The three keyed hosts (§45.37 G4, the API's KEYED): a model on the Anthropic API or an OpenAI-compatible API, and
 * ElevenLabs' sound effects and music, use the owner's key, saved in cf-prod/workspaces/{ws}/providers/{id} and never
 * returned, only its hint. ElevenLabs is also the sound maker of that name, so its row is the Sound maker's.
 */
export const KEYED_HOST_PROVIDERS: KeyedProvider[] = [
  { kind: "writer", id: "anthropic", label: "Anthropic API" },
  { kind: "writer", id: "openai_compatible", label: "OpenAI-compatible API" },
  { kind: "audio", id: "elevenlabs", label: "ElevenLabs" },
];

/**
 * The providers that take an API key: the keyed hosts, plus any a test or a dev session lists in
 * `store.knobs.keyedProviders` (which must also be in the providers list).
 */
function keyed(store: MockStore): Record<string, KeyedProvider> {
  const list = Array.isArray(store.knobs.keyedProviders) ? (store.knobs.keyedProviders as KeyedProvider[]) : [];
  return Object.fromEntries([...KEYED_HOST_PROVIDERS, ...list].map((p) => [p.id, p]));
}

/** A keyed provider's ProviderStatus: only "saved · ends 4f2a" of the key (and whether one is saved, §45.34). */
function keyStatusOf(store: MockStore, p: KeyedProvider): ProviderStatus {
  const saved = state(store).keys[p.id];
  if (!saved) return { kind: p.kind, id: p.id, label: p.label, state: "needs_setup", line: `Paste your ${p.label} key to use it.`, key: { saved: false, hint: null, savedAt: null } };
  // An OpenAI-compatible key names the one address it is for (the API's provider_keys.statuses).
  const what = saved.forOrigin ? `Key saved for ${originHost(saved.forOrigin)}` : "Key saved";
  return {
    kind: p.kind,
    id: p.id,
    label: p.label,
    state: "needs_setup",
    line: `${saved.hint ? `${what} · ends ${saved.hint}.` : `${what}.`} It is checked on its first real call.`,
    key: { saved: true, hint: saved.hint || null, savedAt: saved.savedAt },
  };
}

/** A keyed host's row for GET …/providers (the workspace part lists them; ElevenLabs as the sound maker). */
export function keyedHostStatus(store: MockStore, id: ModelHost): ProviderStatus {
  return keyStatusOf(store, KEYED_HOST_PROVIDERS.find((p) => p.id === id)!);
}

/** `https://{host}[:port]` of a base URL (the API's hosts.origin): who gets an OpenAI-compatible key. */
export function originOf(baseUrl: string | null | undefined): string {
  if (!baseUrl) return "";
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return "";
  }
}
function originHost(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/** The API's sentences for the one OpenAI-compatible service a workspace may use (hosts.ONE_SERVICE, KEY_FOR_OTHER, provider_keys.NEED_MODEL_FIRST). */
export const ONE_SERVICE = (host: string) =>
  `Clip Factory Stories keeps one key for one OpenAI-compatible service. Your other OpenAI-compatible models use ${host}: use that address too, or remove those models first.`;
export const KEY_FOR_OTHER = (saved: string, host: string) =>
  `Your OpenAI-compatible key is for ${saved}. To use ${host}, remove that key in Clip Factory Stories › Settings › AI › Provider keys first, then paste the key for ${host}.`;
export const NEED_MODEL_FIRST =
  "Add the model on your OpenAI-compatible API first (Clip Factory Stories › Settings › AI › Add a model), then paste its key, so Clip Factory Stories knows the one address it is for.";

/** The origins every OpenAI-compatible model of the workspace uses (reasoning and picture models), but `skip`. */
function openAiOrigins(store: MockStore, skip?: string): string[] {
  const s = state(store);
  const used = [
    ...Object.entries(s.custom).filter(([k, d]) => k !== skip && d.host === "openai_compatible").map(([, d]) => originOf(d.baseUrl)),
    ...Object.entries(s.makerCustom).filter(([k, d]) => k !== skip && d.host === "openai_compatible").map(([, d]) => originOf(d.baseUrl)),
  ];
  return [...new Set(used.filter(Boolean))].sort();
}

/** One OpenAI-compatible service per workspace, the one its saved key is for (the API's provider_keys.check_openai_origin, 409). */
function checkOpenAiOrigin(store: MockStore, key: string, baseUrl: string | null): void {
  const origin = originOf(baseUrl);
  const others = openAiOrigins(store, key);
  if (others.length && !others.includes(origin)) throw new ApiError(409, "conflict", ONE_SERVICE(originHost(others[0]!)));
  const saved = state(store).keys.openai_compatible?.forOrigin;
  if (saved && saved !== origin) throw new ApiError(409, "conflict", KEY_FOR_OTHER(originHost(saved), originHost(origin)));
}

/** Whether the owner saved a key for a keyed host (a model on it cannot answer without one). */
export function hostHasKey(store: MockStore, host: string): boolean {
  return !!state(store).keys[host];
}

/** The provider ids whose use can carry the owner's price beside the models (as the API's PRICE_PROVIDERS). */
export const PRICE_PROVIDERS = ["stability", "luma-ray", "own-images", "own-video", "elevenlabs", "polly", "own-sound", "nova-canvas", "nova-reel"];

const OWNER_NOTE = "The price you typed.";
/** The highest price for a million (tokens, pictures or seconds) the API takes. */
const MAX_PRICE = 100_000;

/** Each maker's unit (§45.34, §45.37): pictures by the picture, video and sound by the second, Amazon Polly by the character spoken. */
export const PROVIDER_UNIT: Record<string, "image" | "second" | "character"> = {
  stability: "image",
  "luma-ray": "second",
  "own-images": "image",
  "own-video": "second",
  elevenlabs: "second",
  polly: "character",
  "own-sound": "second",
  "nova-canvas": "image",
  "nova-reel": "second",
};
const UNIT_WORD: Record<"image" | "second" | "character", string> = { image: "picture", second: "second", character: "character" };
/** The highest price for one picture or one second the mock takes. */
const MAX_UNIT_PRICE = 100;

/**
 * The owner's price as the API keeps it, marked as his: a model's per million tokens (no unit), or a maker's for one
 * unit (`perUnit` with its `unit`, the token prices 0).
 */
function cleanPrice(value: unknown, field: string, provider?: string): Price {
  if (!value || typeof value !== "object") throw bad("Type a price from 0 to 100,000.", field);
  const v = value as Partial<Price>;
  for (const [f, n] of [["inputPer1M", v.inputPer1M], ["outputPer1M", v.outputPer1M]] as const)
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw bad("Type a price from 0 to 100,000.", f);
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) throw bad("Pick a currency.", "currency");
  const unit = provider ? PROVIDER_UNIT[provider] : undefined;
  if (unit) {
    if (typeof v.perUnit !== "number" || !Number.isFinite(v.perUnit) || v.perUnit < 0 || v.perUnit > MAX_UNIT_PRICE) throw bad(`Type a price from 0 to ${MAX_UNIT_PRICE} for one ${UNIT_WORD[unit]}.`, "perUnit");
    if (v.unit !== unit) throw bad(`${provider} is priced by the ${UNIT_WORD[unit]}.`, "unit");
    if (v.inputPer1M !== 0 || v.outputPer1M !== 0) throw bad("A maker's price is for one unit: leave the token prices at 0.", "inputPer1M");
  } else if ((v.perUnit !== undefined && v.perUnit !== null) || (v.unit !== undefined && v.unit !== null)) throw bad("A model's price is per million tokens, not per unit.", "perUnit");
  return {
    inputPer1M: v.inputPer1M!,
    outputPer1M: v.outputPer1M!,
    cacheReadPer1M: typeof v.cacheReadPer1M === "number" ? v.cacheReadPer1M : null,
    cacheWritePer1M: typeof v.cacheWritePer1M === "number" ? v.cacheWritePer1M : null,
    longContext: v.longContext ?? null,
    currency: v.currency,
    source: "owner",
    note: typeof v.note === "string" && v.note.trim() ? v.note.slice(0, 200) : OWNER_NOTE,
    perUnit: unit ? v.perUnit! : null,
    unit: unit ?? null,
  };
}

// ---------- The models the owner adds (MODELDEF#, §45.34) ----------

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d{1,2}$/;
/** A Bedrock model id (maker.name-version[:n]), an inference profile id (eu., us., apac., global. first) or an ARN. */
const MODEL_ID = /^(arn:aws:bedrock:[a-z0-9-]+:\d{12}:(foundation-model|inference-profile|application-inference-profile)\/[A-Za-z0-9.:/_-]+|[a-z0-9-]+(\.[a-z0-9-]+)+(-v\d+(:\d+)?|:\d+)?[A-Za-z0-9.:_-]*)$/;
export const MAX_OUTPUT_TOKENS = 500_000;

/** A ModelDef checked as the API does (unknown keys and bad values are a 400 with the field). */
function cleanDef(store: MockStore, key: string, value: unknown): ModelDef {
  if (!CUSTOM_MODEL_KEY.test(key)) throw bad("A model you add gets a name like custom-my-model.", "key");
  if (MOCK_MODELS.some((m) => m.key === key)) throw bad("That name is taken by a model Clip Factory Stories comes with.", "key");
  if (!value || typeof value !== "object") throw bad("Fill in the model's details.");
  const v = value as Partial<ModelDef> & Record<string, unknown>;
  const allowed = ["label", "provider", "modelId", "region", "efforts", "defaultEffort", "vision", "maxOutputTokens", "price", "effortField", "tools", "cache", "host", "baseUrl"];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw bad(`Unknown field '${k}'.`, k);
  // Who runs it (§45.37 G4): Amazon Bedrock when left out, as before; ElevenLabs makes sound only.
  const { host, baseUrl } = cleanHost(v.host, v.baseUrl, MODEL_HOSTS, "ElevenLabs makes sound only. Add it in Settings › Video › Add a sound model.");
  const label = typeof v.label === "string" ? v.label.trim() : "";
  if (!label || label.length > 60) throw bad("Give it a name of 1 to 60 letters.", "label");
  if (allModels(store).some((m) => m.key !== key && m.label.toLowerCase() === label.toLowerCase())) throw bad(`There is already a model called ${label}. Pick another name.`, "label");
  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  if (!provider || provider.length > 40) throw bad("Say who makes it, for example Anthropic or Amazon.", "provider");
  const modelId = cleanModelId(v.modelId, host);
  const region = cleanRegion(v.region, host);
  // On Amazon Bedrock its Region must be the one its ARN names, or in the part of the world its profile runs in
  // (§45.36 E4); a model on a keyed host has no Region.
  const misfit = region === undefined ? null : modelRegionProblem(modelId, region);
  if (misfit) throw bad(misfit, "region");
  if (!Array.isArray(v.efforts) || v.efforts.some((e) => !EFFORTS.includes(e as Effort)) || new Set(v.efforts).size !== v.efforts.length) throw bad("Pick each effort level once.", "efforts");
  const efforts = EFFORTS.filter((e) => (v.efforts as Effort[]).includes(e));
  const defaultEffort = v.defaultEffort ?? null;
  if (defaultEffort !== null && !efforts.includes(defaultEffort)) throw bad(efforts.length ? "Its own level must be one of the levels it accepts." : "A model with no effort setting has no level of its own.", "defaultEffort");
  if (efforts.length && defaultEffort === null) throw bad("Pick its own level, the one it uses when nothing else is set.", "defaultEffort");
  if (typeof v.vision !== "boolean") throw bad("Say whether it can look at pictures.", "vision");
  const max = v.maxOutputTokens;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_OUTPUT_TOKENS) throw bad(`Type how many tokens it may write, from 1 to ${MAX_OUTPUT_TOKENS.toLocaleString("en-GB")}.`, "maxOutputTokens");
  const price = v.price === null || v.price === undefined ? null : cleanPrice(v.price, "price");
  // How it is called (§45.35 D1, §45.37 G4): each may be left out, then the defaults of its maker and host; an older
  // body that lists levels without saying where they go means output_config (how they were always sent). An
  // OpenAI-compatible API takes its effort in reasoning_effort (Low to Extra high) and has no cache setting.
  const openai = host === "openai_compatible";
  const fields: readonly string[] = openai ? ["reasoning_effort", "none"] : ["output_config", "none"];
  if (v.effortField !== undefined && v.effortField !== null && !fields.includes(v.effortField))
    throw bad(
      openai
        ? "Say how the model takes an effort: reasoning_effort (the OpenAI chat-completions field) or none (it runs at its own level)."
        : "Say how the model takes an effort: output_config (like Anthropic's Claude models) or none (it runs at its own level).",
      "effortField",
    );
  for (const [name, what] of [["tools", "takes tool use"], ["cache", "takes Bedrock's prompt cache"]] as const)
    if (v[name] !== undefined && v[name] !== null && typeof v[name] !== "boolean") throw bad(`Say whether the model ${what} (true or false), or leave it out.`, name);
  const usual = hostCalling(provider, host);
  const effortField = (v.effortField ?? (efforts.length ? (openai ? "reasoning_effort" : "output_config") : usual.effortField)) as ModelCalling["effortField"];
  if (effortField === "none" && efforts.length) throw bad("This model has no effort setting (effortField none), so leave its efforts empty. Only a model that takes output_config can list efforts.", "efforts");
  if (effortField === "reasoning_effort" && efforts.includes("max")) throw bad("reasoning_effort goes up to Extra high. Leave Maximum out for this model.", "efforts");
  if (openai && v.cache === true) throw bad("An OpenAI-compatible API has no cache setting. Leave cache off.", "cache");
  const calling: ModelCalling = { effortField, tools: typeof v.tools === "boolean" ? v.tools : usual.tools, cache: typeof v.cache === "boolean" ? v.cache : usual.cache };
  return {
    label,
    provider,
    modelId,
    ...(region ? { region } : {}),
    efforts,
    defaultEffort,
    vision: v.vision,
    maxOutputTokens: max,
    price,
    ...calling,
    host: host as Exclude<ModelHost, "elevenlabs">,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** The usual way of calling a model on each host (the API's model_defs defaults): the Anthropic API takes all three; an OpenAI-compatible API none. */
export function hostCalling(provider: string, host: ModelHost): ModelCalling {
  if (host === "anthropic") return { effortField: "output_config", tools: true, cache: true };
  if (host === "openai_compatible") return { effortField: "none", tools: false, cache: false };
  return callingFor(provider);
}

/** A model name on a keyed host (the API's hosts.KEYED_MODEL_ID): claude-opus-5-5, meta-llama/Llama-4-Maverick, llama3:70b. */
const KEYED_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * The host and its base URL (§45.37 G4, the API's hosts.clean_host): left out is Amazon Bedrock; `allowed` says which
 * hosts this kind of model may use; a baseUrl only for openai_compatible.
 */
function cleanHost(host: unknown, baseUrl: unknown, allowed: readonly ModelHost[], refused: string): { host: ModelHost; baseUrl: string | null } {
  const h = host === undefined || host === null ? "bedrock" : host;
  if (typeof h !== "string" || !(KNOWN_HOSTS as string[]).includes(h)) throw bad("Pick where the model runs: Amazon Bedrock, the Anthropic API or an OpenAI-compatible API.", "host");
  if (!(allowed as string[]).includes(h)) throw bad(refused, "host");
  if (h !== "openai_compatible") {
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== "") throw bad("Only a model on an OpenAI-compatible API has an address (baseUrl). Leave it out.", "baseUrl");
    return { host: h as ModelHost, baseUrl: null };
  }
  return { host: "openai_compatible", baseUrl: cleanBaseUrl(baseUrl) };
}
const KNOWN_HOSTS: ModelHost[] = ["bedrock", "anthropic", "openai_compatible", "elevenlabs"];

/** Names that never reach the public internet (the API's hosts.LOCAL_NAMES and LOCAL_SUFFIXES). */
const LOCAL_NAMES = ["localhost", "instance-data", "metadata", "metadata.google.internal"];
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private", ".test", ".invalid", ".example", ".onion", ".arpa"];
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The IPv4 ranges that are not global, multicast or reserved (what the API's ipaddress checks refuse). */
const NOT_GLOBAL_V4: [number, number][] = [
  [0x00000000, 8], // 0/8 "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 shared (CGNAT)
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local (the metadata address)
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // 192.0.2/24 documentation
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xc6336400, 24], // 198.51.100/24 documentation
  [0xcb007100, 24], // 203.0.113/24 documentation
  [0xe0000000, 4], // 224/4 multicast
  [0xf0000000, 4], // 240/4 reserved, and 255.255.255.255
];

/** True for anything that is not a public internet name or address (the API's hosts.private_host). */
export function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!name) return true;
  // Any IPv6 literal: the mock does not tell its global ones apart, so none is called (the API allows global ones).
  if (name.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const n = v4.slice(1).reduce((a, x) => a * 256 + Number(x), 0);
    return NOT_GLOBAL_V4.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));
  }
  if (LOCAL_NAMES.includes(name) || LOCAL_SUFFIXES.some((x) => name.endsWith(x))) return true;
  const labels = name.split(".");
  // A single-label name resolves inside a network, never on the internet; an all-numbers name is an odd IPv4 spelling.
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return true;
  return labels.every((l) => /^(0x[0-9a-f]*|[0-9]+)$/.test(l)) || /^\d+$/.test(labels.at(-1)!);
}

/** An https base URL with no name or password, no query and no fragment, on a public address; at most 300 characters. */
export function cleanBaseUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw bad("Paste the address of the OpenAI-compatible API, like https://api.example.com/v1 (the part before /chat/completions).", "baseUrl");
  const notAddress = () => bad("That is not a web address. Paste one like https://api.example.com/v1.", "baseUrl");
  if (raw.length > 300 || [...raw].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) >= 127 || c === "\\")) throw notAddress();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw notAddress();
  }
  if (u.protocol !== "https:") throw bad("The address must start with https:// so the key travels safely.", "baseUrl");
  if (u.username || u.password || /^https:\/\/[^/]*@/i.test(raw)) throw bad("Leave the name and password out of the address. Save the key in Provider keys instead.", "baseUrl");
  if (u.search || u.hash || raw.includes("?") || raw.includes("#")) throw bad("Leave out anything after ? or # in the address.", "baseUrl");
  const name = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (privateHost(name))
    throw bad("That address is not on the public internet (a private, local or internal address). Clip Factory Stories can only call a public https address.", "baseUrl");
  // The path as typed (the browser's URL would fold "/v1/../x" into "/x"): never "." or ".." parts, never a % escape.
  const typedPath = raw.replace(/^https:\/\/[^/]*/i, "").replace(/\/+$/, "");
  if (typedPath.split("/").some((part) => part === "." || part === "..") || typedPath.includes("%")) throw notAddress();
  return `https://${name}${u.port && u.port !== "443" ? `:${u.port}` : ""}${u.pathname.replace(/\/+$/, "")}`;
}

function cleanModelId(value: unknown, host: ModelHost): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (host === "bedrock") {
    if (!id || id.length > 200 || !MODEL_ID.test(id)) throw bad("Paste the model ID or inference profile from Amazon Bedrock, like eu.amazon.nova-premier-v1:0.", "modelId");
  } else if (!KEYED_MODEL_ID.test(id) || id.includes("..")) throw bad("Type the model's name exactly as its API spells it, like claude-opus-5-5 or meta-llama/Llama-4-Maverick.", "modelId");
  return id;
}

/** The AWS Region on Amazon Bedrock; a model on a keyed host has none (the API refuses one). */
function cleanRegion(value: unknown, host: ModelHost): string | undefined {
  const region = typeof value === "string" ? value.trim() : value;
  if (host !== "bedrock") {
    if (region !== undefined && region !== null && region !== "") throw bad("Only a model on Amazon Bedrock has a Region. Leave the Region out.", "region");
    return undefined;
  }
  if (typeof region !== "string" || !REGION.test(region)) throw bad("Pick the AWS Region the model runs in.", "region");
  return region;
}

/** The first saved setting that uses a model, in words, or null (DELETE answers 409 naming it). */
function usedBy(store: MockStore, key: string): string | null {
  const ai = config(store);
  if (ai.defaultModel === key) return "the default model in Settings › AI";
  for (const t of TASKS) if (ai.tasks[t.kind]?.model === key) return `the task ${t.label} in Settings › AI`;
  for (const a of store.agents) if (a.model === key) return `the ${a.name} agent`;
  const conv = store.conversations.find((c) => c.model === key);
  if (conv) return `the chat ${conv.title}`;
  const story = store.stories.find((x) => x.ai?.model === key);
  if (story) return `the video ${story.title}`;
  const ref = store.references.find((r) => r.ai?.model === key);
  if (ref) return `the reference video ${ref.title}`;
  return null;
}

const STORAGE_KIND: Record<string, keyof StorageSummary["bytes"]> = {
  final_video: "videos",
  cover: "videos",
  scene_clip: "scenes",
  scene_still: "scenes",
  storyboard: "scenes",
  captions: "scenes",
  audio: "audio",
};

// ---------- The makers' models (§45.37 G1, G2) ----------

interface MakerEntry extends FileMakerModel {
  custom: boolean;
  hostId: ModelHost;
  baseUrl: string | null;
}

/** Each kind's words: which card picks it, and its config keys (StoriesConfig.providers). */
export const MAKER_KIND: Record<MakerKind, { card: string; noun: string; config: "imageModel" | "videoModel" | "audioModel"; makerKey: "images" | "video" | "audio" }> = {
  image: { card: "Picture maker", noun: "picture", config: "imageModel", makerKey: "images" },
  video: { card: "Video maker", noun: "video", config: "videoModel", makerKey: "video" },
  audio: { card: "Sound maker", noun: "sound", config: "audioModel", makerKey: "audio" },
};

/** The bundled maker models and, after them, the owner's (maker own-images, own-video or own-sound). */
export function allMakerModels(store: MockStore): MakerEntry[] {
  const own = Object.entries(state(store).makerCustom).map(
    ([key, d]): MakerEntry => ({
      key,
      label: d.label,
      provider: d.provider,
      host: hostWord(d.host, d.baseUrl),
      hostId: d.host,
      modelId: d.modelId,
      region: d.region ?? "",
      kind: d.kind,
      price: d.price ? { ...d.price } : null,
      note: d.note,
      maker: OWN_MAKER[d.kind],
      custom: true,
      baseUrl: d.baseUrl ?? null,
    }),
  );
  // As the API's makers._entry: a keyed host's file entry is named by its label ("elevenlabs" → ElevenLabs).
  const bundled = bundledMakerModels().map((m): MakerEntry => {
    const hostId = hostIdOf(m.host);
    return { ...m, host: hostId !== "bedrock" ? HOST_LABEL[hostId] : m.host, custom: false, hostId, baseUrl: null };
  });
  return [...bundled, ...own];
}

/** The API's not-checked words for a maker model (makers.STATUS_LINE). */
export const MAKER_NOT_CHECKED = "Not checked yet. Tap Check models to see if it works.";

/**
 * A maker model as the API's makers.model_info sends it (§45.37 G1, G2): who makes it, who runs it, its Region (null
 * on a keyed host) in words, its price, its end day and its last access check. No key state: the screens read that
 * from GET …/providers' `key` (G4). An ended model is never checked: "Not found", "Ended by Amazon on 30 Sep 2026."
 */
export function makerInfo(store: MockStore, m: MakerEntry): MakerModelInfo {
  const st = state(store).makerStatus[m.key] ?? { status: "not_checked" as const, line: MAKER_NOT_CHECKED, checkedAt: null };
  const region = m.region || null;
  return {
    key: m.key,
    label: m.label,
    provider: m.provider,
    host: m.host,
    hostId: m.hostId,
    modelId: m.modelId,
    region,
    regionLine: region ? (REGION_WORDS[region] ?? `Runs in ${region}`) : null,
    kind: m.kind,
    price: m.price ? { ...m.price } : null,
    note: m.note,
    // An ended model is final (the API's makers.model_info): "Not found" with its end day, never "tap Check models".
    status: m.ended ? "not_found" : st.status,
    statusLine: m.ended ? "Ended by Amazon on 30 Sep 2026." : st.line,
    checkedAt: m.ended ? null : st.checkedAt,
    custom: m.custom,
    ...(m.maker ? { maker: m.maker } : {}),
    ended: m.ended ?? null,
    endedLine: m.ended ? "Ended by Amazon on 30 Sep 2026" : null,
    ...(m.hostId === "openai_compatible" ? { baseUrl: m.baseUrl } : {}),
  };
}

/** The API's words for the Regions its makers run in (makers.REGION_WORDS). */
const REGION_WORDS: Record<string, string> = {
  "us-west-2": "Runs in the US (Oregon)",
  "us-east-1": "Runs in the US (N. Virginia)",
  "eu-west-1": "Runs in Europe (Ireland)",
  "eu-north-1": "Runs in Europe (Stockholm)",
};

/** The models a maker row of GET …/providers lists (the API's makers.models_of), each with its access check. */
export function makerRowModels(store: MockStore, maker: string): MakerModelInfo[] {
  return allMakerModels(store)
    .filter((m) => (m.maker ?? (m.custom ? OWN_MAKER[m.kind] : m.key)) === maker)
    .map((m) => makerInfo(store, m));
}

/** "Amazon Nova Canvas was ended by Amazon on 30 Sep 2026. Pick another picture maker in Lamo Stories › Settings › Video." */
export function endedSentence(m: { label: string; kind: MakerKind }): string {
  return `${m.label} was ended by Amazon on 30 Sep 2026. Pick another ${MAKER_KIND[m.kind].noun} maker in Clip Factory Stories › Settings › Video.`;
}

/** The makers Amazon ended, by maker id, with their names (the API refuses a new pick of them with endedSentence). */
export const ENDED_MAKER_LABEL: Record<string, { label: string; kind: MakerKind }> = {
  "nova-canvas": { label: "Amazon Nova Canvas", kind: "image" },
  "nova-reel": { label: "Amazon Nova Reel", kind: "video" },
};

/**
 * A maker's model pick (PATCH workspace's rule, §45.37 G1): a key of that kind that belongs to the picked maker; null
 * or missing means the maker's first model that has not ended. An ended model is refused, never called.
 */
export function checkMakerPick(store: MockStore, kind: MakerKind, maker: string, key: unknown): void {
  if (key === undefined || key === null) return;
  const words = MAKER_KIND[kind].card.toLowerCase();
  const m = typeof key === "string" ? allMakerModels(store).find((x) => x.key === key && x.kind === kind) : undefined;
  if (!m || (m.maker ?? maker) !== maker) throw new ApiError(400, "bad_request", `Pick one of the ${words}'s models.`, "providers");
  if (m.ended) throw new ApiError(400, "bad_request", endedSentence(m), "providers");
}

/**
 * The model a workspace's maker of one kind uses (§45.37 G1): the one picked, else the maker's first model that has
 * not ended (an own maker's first added model of that kind).
 */
export function usedMakerModel(store: MockStore, p: Partial<StoriesConfig["providers"]>, kind: MakerKind): string | null {
  const maker = p[MAKER_KIND[kind].makerKey];
  if (!maker) return null;
  const mine = allMakerModels(store).filter((m) => m.kind === kind && (m.maker ?? (m.custom ? OWN_MAKER[kind] : m.key)) === maker);
  const picked = p[MAKER_KIND[kind].config];
  return (mine.find((m) => m.key === picked) ?? mine.find((m) => !m.ended))?.key ?? null;
}

/** The kind whose pick uses a maker model, or null (DELETE answers 409 naming it): picked, or its picked maker's model. */
function makerUsedBy(store: MockStore, key: string): MakerKind | null {
  for (const w of store.workspaces) {
    const p = (w.configuration as Partial<StoriesConfig>).providers;
    if (!p) continue;
    for (const kind of MAKER_KINDS) if (p[MAKER_KIND[kind].config] === key || usedMakerModel(store, p, kind) === key) return kind;
  }
  return null;
}

const MAX_MAKER_PRICE = 100;
/** A Bedrock picture model the owner adds must be one the agent knows how to call (the API's makers.BEDROCK_PICTURE). */
const BEDROCK_PICTURE_ID = /^(stability\.|amazon\.titan-image)/;
/** Video on Amazon Bedrock: Luma AI's models only (the API's makers.BEDROCK_VIDEO). */
const BEDROCK_VIDEO_ID = /^luma\./;
/** Amazon's ended families: never added (the API's makers.ENDED_FAMILIES). */
const ENDED_ID = /^amazon\.nova-(canvas|reel)/;
/** ElevenLabs makes sound effects and music only, never a voice (the API's makers.ELEVENLABS_SOUND). */
const ELEVENLABS_SOUND_ID = /^(eleven_text_to_sound|music_)/;
/** The hosts the API's makers.KIND_HOSTS knows per kind (Bedrock sound is then refused with its own sentence). */
const MOCK_KIND_HOSTS: Record<MakerKind, ModelHost[]> = { image: ["bedrock", "openai_compatible"], video: ["bedrock"], audio: ["elevenlabs", "bedrock"] };
/** The model id inside an ARN or a cross-Region profile id (the API's makers._bare_model_id). */
function bareModelId(id: string): string {
  const tail = id.split("/").pop() ?? id;
  const parts = tail.split(".");
  return parts.length > 2 && ["us", "eu", "apac", "global", "jp", "au", "ca", "us-gov"].includes(parts[0]!) ? parts.slice(1).join(".") : tail;
}
export const BAD_PICTURE_MODEL = "Clip Factory Stories can make pictures on Amazon Bedrock with Stability AI's or Amazon Titan Image's models. Paste a model id like stability.stable-image-core-v1:1.";
export const BAD_VIDEO_MODEL = "Clip Factory Stories can make video on Amazon Bedrock with Luma AI's models only. Paste a model id like luma.ray-v2:0.";
export const ENDED_MODEL = "Amazon ended that model on 30 Sep 2026, so it can't be added. Pick another model, like stability.stable-image-core-v1:1 for pictures or luma.ray-v2:0 for video.";
export const NO_BEDROCK_SOUND = "Amazon Bedrock has no sound-effect or music model yet, so Clip Factory Stories can't add one there. Add an ElevenLabs model instead, like eleven_text_to_sound_v2.";
export const ELEVENLABS_ONLY_SOUND = "ElevenLabs is used for sound effects and music only, never a voice. Paste a model like eleven_text_to_sound_v2 or music_v1.";

/** A MakerModelDef checked as the API does (unknown keys and bad values are a 400 with the field). */
function cleanMakerDef(store: MockStore, key: string, value: unknown): MakerModelDef {
  if (!CUSTOM_MODEL_KEY.test(key)) throw bad("A model you add gets a name like custom-my-model.", "key");
  if (bundledMakerModels().some((m) => m.key === key)) throw bad("That name is taken by a model Clip Factory Stories comes with.", "key");
  // One name across both kinds of added model, so a status is about exactly one model.
  if (allModels(store).some((m) => m.key === key)) throw bad("You already added an AI model with that name in Settings › AI. Pick another name.", "key");
  if (!value || typeof value !== "object") throw bad("Fill in the model's details.");
  const v = value as Partial<MakerModelDef> & Record<string, unknown>;
  const allowed = ["label", "provider", "host", "baseUrl", "modelId", "region", "kind", "price", "note"];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw bad(`Unknown field '${k}'.`, k);
  if (typeof v.kind !== "string" || !(MAKER_KINDS as string[]).includes(v.kind)) throw bad("Say what it makes: pictures, video or sound.", "kind");
  const kind = v.kind as MakerKind;
  const label = typeof v.label === "string" ? v.label.trim() : "";
  if (!label || label.length > 60) throw bad("Give it a name of 1 to 60 letters.", "label");
  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  if (!provider || provider.length > 40) throw bad("Say who makes it, for example Stability AI or ElevenLabs.", "provider");
  const refused = kind === "video" ? "Video models run on Amazon Bedrock only." : kind === "image" ? "Picture models run on Amazon Bedrock or an OpenAI-compatible API." : "Sound models run on ElevenLabs.";
  const { host, baseUrl } = cleanHost(v.host, v.baseUrl, MOCK_KIND_HOSTS[kind], refused);
  const modelId = cleanModelId(v.modelId, host);
  if (host === "bedrock") {
    const bare = bareModelId(modelId);
    if (ENDED_ID.test(bare)) throw bad(ENDED_MODEL, "modelId");
    if (kind === "image" && !BEDROCK_PICTURE_ID.test(bare)) throw bad(BAD_PICTURE_MODEL, "modelId");
    if (kind === "video" && !BEDROCK_VIDEO_ID.test(bare)) throw bad(BAD_VIDEO_MODEL, "modelId");
    if (kind === "audio") throw bad(NO_BEDROCK_SOUND, "host");
  }
  if (host === "elevenlabs" && !ELEVENLABS_SOUND_ID.test(modelId)) throw bad(ELEVENLABS_ONLY_SOUND, "modelId");
  const region = cleanRegion(v.region, host);
  // The same Region rule as an AI model's (§45.36 E4; the API's makers.clean checks it too).
  const misfit = region === undefined ? null : modelRegionProblem(modelId, region);
  if (misfit) throw bad(misfit, "region");
  let price: MakerPrice | null = null;
  if (v.price !== null && v.price !== undefined) {
    const p = v.price as Partial<MakerPrice>;
    if (typeof p.perUnit !== "number" || !Number.isFinite(p.perUnit) || p.perUnit < 0 || p.perUnit > MAX_MAKER_PRICE) throw bad(`Type a price from 0 to ${MAX_MAKER_PRICE} for one unit.`, "price");
    if (typeof p.unit !== "string" || !/^[a-z]{1,20}$/.test(p.unit)) throw bad("Say what the price is for, like image or second.", "price");
    if (typeof p.currency !== "string" || !/^[A-Z]{3}$/.test(p.currency)) throw bad("Pick a currency.", "price");
    price = { perUnit: p.perUnit, unit: p.unit, currency: p.currency };
  }
  const note = typeof v.note === "string" ? v.note.trim() : "";
  if (note.length > 200) throw bad("Keep the note to 200 letters or fewer.", "note");
  return { label, provider, kind, host: host as MakerModelDef["host"], modelId, ...(region ? { region } : {}), ...(baseUrl ? { baseUrl } : {}), price, note };
}

/** The words for a keyed host in a sentence. */
const HOST_WORDS: Record<string, string> = { anthropic: "the Anthropic API", openai_compatible: "your OpenAI-compatible API", elevenlabs: "ElevenLabs" };

/**
 * A maker model's access check (§45.37 G2: GetFoundationModelAvailability on Amazon Bedrock, a GET of ElevenLabs' or
 * the API's model list, Polly's DescribeVoices): nothing is made and nothing is billed; it says whether this account
 * may use it, in the provider's own words. An ended model is not asked at all.
 */
function makerCheck(store: MockStore, m: MakerEntry, when: string): AiState["makerStatus"][string] {
  const id = m.hostId;
  if (m.ended) return { status: "not_found", line: endedSentence(m), checkedAt: when };
  if (id !== "bedrock" && KEYED_HOSTS.includes(id) && !hostHasKey(store, id)) return { status: "denied", line: `There is no key for ${HOST_WORDS[id]} yet. Paste it under Provider keys, then tap Check models.`, checkedAt: when };
  if (store.knobs.makerDenied === m.key)
    return { status: "denied", line: `Amazon Bedrock said this account has no access to ${m.label}. Turn it on in the Bedrock console (Model access) in ${m.region}, then tap Check models.`, checkedAt: when };
  if (store.knobs.bedrockUnknown === m.key)
    return id === "bedrock"
      ? { status: "not_found", line: `Amazon Bedrock said: The provided model identifier is invalid (${m.modelId} in ${m.region}). Check the model ID and its Region, then tap Check models.`, checkedAt: when }
      : { status: "not_found", line: `${HOST_WORDS[id]![0]!.toUpperCase()}${HOST_WORDS[id]!.slice(1)} has no model called ${m.modelId}. Check its name, then tap Check models.`, checkedAt: when };
  // Amazon Polly answers DescribeVoices with its neural voices (Lamo Stories' own AWS access, no key).
  if (m.maker === "polly") return { status: "ok", line: `Amazon Polly has its neural voices for this account in ${m.region}.`, checkedAt: when };
  return { status: "ok", line: id === "bedrock" ? "Amazon Bedrock says this account may use it." : `${m.modelId} is in the list ${HOST_WORDS[id] ?? m.host} gives this key.`, checkedAt: when };
}

// ---------- The routes ----------

const DEFAULT_REGION_FOLDER = { region: "eu-north-1", folder: "ws/{you}/stories/" };

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const findAgent = (agentId: string): Agent => {
    const a = store.agents.find((x) => x.agentId === agentId);
    if (!a) throw new ApiError(404, "not_found", "We could not find that agent.");
    return a;
  };
  const modelEntry = (key: string | null | undefined, field: string) => modelEntryIn(allModels(store), key, field);
  // The key routes answer as the API does: 400 for a provider that needs no key, 404 for one that takes none.
  const keyedProvider = (providerId: string): KeyedProvider => {
    // The keyed host openai_compatible has an underscore (§45.37 G4), so ids take one too.
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(providerId)) throw new ApiError(404, "not_found", "We could not find that provider.");
    if (NO_KEY[providerId]) throw bad(`${NO_KEY[providerId]} uses Clip Factory Stories' own AWS access, so it needs no key.`);
    const p = keyed(store)[providerId];
    if (!p) throw new ApiError(404, "not_found", `Clip Factory Stories has no provider called '${providerId}' that uses a key yet.`);
    return p;
  };
  // A keyed provider's ProviderStatus, on only after a real call.
  const keyStatus = (p: KeyedProvider): ProviderStatus => keyStatusOf(store, p);

  return {
    async getAi(ws) {
      await delay();
      guardStories(store, ws);
      return { ai: clone(config(store)), models: allModels(store).map((m) => modelInfo(store, m)), agents: clone(store.agents), tasks: taskInfos(store) };
    },

    async putAi(ws, next) {
      await delay();
      guardStories(store, ws);
      const allowed = ["defaultModel", "defaultEffort", "tasks", "prices", "version", "picked"];
      for (const k of Object.keys(next)) if (!allowed.includes(k)) throw bad(`Unknown field '${k}'.`, k);
      const now = config(store);
      if (next.version !== now.version) throw conflict();
      const models = allModels(store);
      const def = modelEntryIn(models, next.defaultModel, "defaultModel");
      if (!EFFORTS.includes(next.defaultEffort)) throw bad("That effort level does not exist. Pick Low, Medium, High, Extra high or Maximum.", "defaultEffort");
      checkEffort(def, next.defaultEffort, "defaultEffort");
      const tasks: StoriesAiConfig["tasks"] = {};
      for (const [kind, set] of Object.entries(next.tasks ?? {})) {
        if (!TASK_KINDS.includes(kind)) throw bad("That is not a Clip Factory Stories task.", "tasks");
        if (!set || (!set.model && !set.effort)) continue;
        const agent = store.agents.find((a) => a.agentId === agentForTask(kind as TaskKind));
        const model = modelEntryIn(models, set.model ?? agent?.model ?? next.defaultModel, "tasks");
        // A model and an effort set together on a model with no effort setting is refused; an inherited one is not sent.
        if (set.model) checkPair(model, set.effort, "tasks");
        else checkEffort(model, set.effort, "tasks");
        tasks[kind as TaskKind] = { ...(set.model ? { model: set.model } : {}), ...(set.effort ? { effort: set.effort } : {}) };
      }
      // The owner's prices, by model key or provider id; left as they are when the body has none.
      let prices = clone(now.prices);
      if (next.prices !== undefined) {
        if (!next.prices || typeof next.prices !== "object") throw bad("Type a price from 0 to 100,000.", "prices");
        prices = {};
        for (const [key, value] of Object.entries(next.prices)) {
          const maker = PRICE_PROVIDERS.includes(key);
          if (!models.some((m) => m.key === key) && !maker) throw bad(`There is no model or provider called '${key}' to set a price for.`, "prices");
          prices[key] = cleanPrice(value, `prices.${key}`, maker ? key : undefined);
        }
      }
      stampPicked(store, next.picked);
      store.ai = { defaultModel: next.defaultModel, defaultEffort: next.defaultEffort, tasks, prices, version: now.version + 1 };
      return clone(store.ai);
    },

    async putAiModel(ws, key, def) {
      await delay();
      guardStories(store, ws);
      const s = state(store);
      const clean = cleanDef(store, key, def);
      if (clean.host === "openai_compatible") checkOpenAiOrigin(store, key, clean.baseUrl ?? null);
      const before = s.custom[key];
      if (!before && Object.keys(s.custom).length >= MAX_CUSTOM_MODELS) throw bad(`You can add up to ${MAX_CUSTOM_MODELS} models. Remove one first.`, "key");
      const at = iso(Date.now());
      s.custom[key] = { ...clean, createdAt: before?.createdAt ?? at, updatedAt: at };
      // A new model is not checked yet: nothing is shown as working because it is listed. A changed model ID or Region
      // is another model, so its last check is cleared too (model_defs.put, §45.35 D6); a new name alone keeps it.
      const moved = !!before && (before.modelId !== clean.modelId || (before.region ?? "") !== (clean.region ?? "") || (before.host ?? "bedrock") !== (clean.host ?? "bedrock") || (before.baseUrl ?? null) !== (clean.baseUrl ?? null));
      if (!before || moved) s.status[key] = { status: "not_checked", line: "Not checked yet. Tap Check models.", checkedAt: null };
      return modelInfo(store, allModels(store).find((m) => m.key === key)!);
    },

    async deleteAiModel(ws, key) {
      await delay();
      guardStories(store, ws);
      const s = state(store);
      if (MOCK_MODELS.some((m) => m.key === key)) throw bad("Only models you added can be removed.", "key");
      const def = s.custom[key];
      if (!def) throw new ApiError(404, "not_found", "We could not find that model.");
      const where = usedBy(store, key);
      if (where) throw new ApiError(409, "conflict", `${def.label} is still used by ${where}. Pick another model there first.`);
      delete s.custom[key];
      delete s.status[key];
      if (store.ai?.prices[key]) {
        const { [key]: _gone, ...rest } = store.ai.prices;
        store.ai = { ...store.ai, prices: rest };
      }
    },

    async checkModels(ws, models, makers) {
      await delay();
      guardStories(store, ws);
      const list = allModels(store);
      const makerList = allMakerModels(store);
      // { models?, makers? } (§45.37 G2, the API's clean_check): neither named is every AI model; only makers named
      // is only those (an access check that costs nothing).
      if (makers !== undefined && (!Array.isArray(makers) || !makers.length)) throw bad("makers must be a list of the models to check.", "makers");
      for (const k of makers ?? []) if (!makerList.some((m) => m.key === k)) throw bad(`Clip Factory Stories has no picture, video or sound model called '${k}'. Pick one in Clip Factory Stories › Settings › Video.`, "makers");
      const reasoning = models?.length ? models : makers?.length ? [] : list.map((m) => m.key);
      for (const k of reasoning) modelEntry(k, "models");
      const keys = [...new Set(reasoning)];
      const makerKeys = [...new Set(makers ?? [])];
      const at = iso(Date.now());
      const task: AiTask = { taskId: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`, kind: "check_models", status: "queued", model: null, effort: null, effortApplied: null, result: null, createdAt: at, updatedAt: at };
      store.tasks.push(task);
      const ms = typeof store.knobs.checkModelsMs === "number" ? store.knobs.checkModelsMs : 1800;
      // Each model gets one tiny real call in the real app; here every one answers except the one this account
      // cannot use (it stays denied with Amazon Bedrock's reason), and an added model Bedrock does not know (knob
      // `bedrockUnknown`: its key) keeps Bedrock's own sentence. Nothing is swapped.
      setTimeout(() => Object.assign(task, { status: "running", updatedAt: iso(Date.now()) }), ms / 3);
      setTimeout(() => {
        const when = iso(Date.now());
        const s = state(store);
        const makerResults = makerKeys.map((k) => {
          s.makerStatus[k] = makerCheck(store, makerList.find((m) => m.key === k)!, when);
          return { key: k, status: s.makerStatus[k]!.status, line: s.makerStatus[k]!.line };
        });
        const results = keys.map((k) => {
          // Knob `modelDenied` (the shell's name) picks the model Bedrock refuses; `allowFable51` lets every one answer.
          const deniedKey = typeof store.knobs.modelDenied === "string" ? store.knobs.modelDenied : "fable-5-1";
          const denied = k === deniedKey && store.knobs.allowFable51 !== true;
          const unknown = store.knobs.bedrockUnknown === k;
          const entry = list.find((m) => m.key === k);
          s.status[k] = denied
            ? { status: "denied", line: deniedLine(k), checkedAt: when }
            : unknown
              ? { status: "not_found", line: `Amazon Bedrock said: The provided model identifier is invalid (${entry?.modelId ?? k} in ${entry?.custom?.region ?? "eu-north-1"}). Check the model ID and its Region, then tap Check models.`, checkedAt: when }
              : { status: "ok", line: "It answered on the last call.", checkedAt: when };
          return { key: k, status: s.status[k]!.status, line: s.status[k]!.line };
        });
        // Setup step 1 ticks from a check of the AI models, not from a maker-only check.
        if (keys.length) s.checkedAt = when;
        Object.assign(task, { status: "done", result: { models: results, ...(makerKeys.length ? { makers: makerResults } : {}) }, updatedAt: when });
      }, ms);
      return clone(task);
    },

    async putMakerModel(ws, key, def) {
      await delay();
      guardStories(store, ws);
      const s = state(store);
      const clean = cleanMakerDef(store, key, def);
      if (clean.host === "openai_compatible") checkOpenAiOrigin(store, key, clean.baseUrl ?? null);
      const before = s.makerCustom[key];
      // An added model keeps what it makes, picked or not (the API's makers.clean, KIND_FIXED).
      if (before && before.kind !== clean.kind) throw bad("A model you added keeps what it makes. Remove it and add it again as another kind.", "kind");
      if (!before && Object.values(s.makerCustom).filter((d) => d.kind === clean.kind).length >= MAX_CUSTOM_MAKER_MODELS)
        throw new ApiError(409, "conflict", `You can add at most ${MAX_CUSTOM_MAKER_MODELS} ${MAKER_KIND[clean.kind].noun} models. Remove one first.`);
      const at = iso(Date.now());
      s.makerCustom[key] = { ...clean, createdAt: before?.createdAt ?? at, updatedAt: at };
      // New, or now another model (its ID, Region or host changed): not checked yet.
      const moved = !!before && (before.modelId !== clean.modelId || (before.region ?? "") !== (clean.region ?? "") || before.host !== clean.host || (before.baseUrl ?? null) !== (clean.baseUrl ?? null));
      if (!before || moved) s.makerStatus[key] = { status: "not_checked", line: MAKER_NOT_CHECKED, checkedAt: null };
      return makerInfo(store, allMakerModels(store).find((m) => m.key === key)!);
    },

    async deleteMakerModel(ws, key) {
      await delay();
      guardStories(store, ws);
      const s = state(store);
      if (bundledMakerModels().some((m) => m.key === key)) throw new ApiError(409, "conflict", "That model comes with Clip Factory Stories, so it can't be removed.");
      const def = s.makerCustom[key];
      if (!def) throw new ApiError(404, "not_found", "We could not find that model.");
      // The API's sentence (makers.delete): picked, or the model its picked maker uses.
      const kind = makerUsedBy(store, key);
      if (kind) throw new ApiError(409, "conflict", `${def.label} is picked as the ${MAKER_KIND[kind].noun} model in Settings › Video. Pick another model there first, then remove it.`);
      delete s.makerCustom[key];
      delete s.makerStatus[key];
    },

    async setModelPrice(ws, modelKey, price) {
      await delay();
      guardStories(store, ws);
      const m = modelEntry(modelKey, "modelKey");
      const ai = config(store);
      const prices = { ...ai.prices };
      if (price) {
        for (const [f, v] of [["inputPer1M", price.inputPer1M], ["outputPer1M", price.outputPer1M]] as const)
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE) throw bad("Type a price from 0 to 100,000.", f);
        prices[m.key] = cleanPrice({ inputPer1M: price.inputPer1M, outputPer1M: price.outputPer1M, currency: price.currency }, "price");
      } else delete prices[m.key];
      store.ai = { ...ai, prices, version: ai.version + 1 };
      return modelInfo(store, m);
    },

    async usage(ws, days = 30) {
      await delay();
      guardStories(store, ws);
      const n = Math.max(1, Math.min(30, Math.round(days)));
      const since = dayOf(Date.now() - (n - 1) * DAY_MS);
      const s = state(store);
      const rows = s.usage.filter((u) => u.day >= since);
      const makers = s.makers.filter((u) => u.day >= since);
      const dayList = Array.from(new Set([...rows.map((u) => u.day), ...makers.map((u) => u.day)]))
        .sort()
        .reverse();
      // Render minutes: the built-in animator's seconds (§45.34: built-in render seconds are builtin-rig).
      const minutes = (list: MakerUse[]) => Math.round((list.filter((u) => u.provider === "builtin-rig").reduce((a, u) => a + u.units, 0) / 60) * 10) / 10;
      const byProvider = (list: MakerUse[]): ProviderUsage[] =>
        Array.from(new Set(list.map((u) => u.provider))).map((provider) => {
          const mine = list.filter((u) => u.provider === provider);
          const units = mine.reduce((a, u) => a + u.units, 0);
          return { provider, units, unit: mine[0]!.unit, ...makerCost(store, provider, units) };
        });
      const out: UsageSummary = {
        days: dayList.map((day) => ({
          day,
          byModel: rows.filter((u) => u.day === day).map((u) => ({ model: u.model, input: u.input, output: u.output, ...costOf(store, u.model, u.input, u.output) })),
          renderMinutes: minutes(makers.filter((u) => u.day === day)),
          byProvider: byProvider(makers.filter((u) => u.day === day)),
        })),
        totals: Array.from(new Set(rows.map((u) => u.model))).map((model) => {
          const mine = rows.filter((u) => u.model === model);
          const input = mine.reduce((a, u) => a + u.input, 0);
          const output = mine.reduce((a, u) => a + u.output, 0);
          return { model, input, output, ...costOf(store, model, input, output) };
        }),
        renderMinutes: minutes(makers),
        totalsByProvider: byProvider(makers),
      };
      return out;
    },

    async getAgent(ws, agentId) {
      await delay();
      guardStories(store, ws);
      return clone(findAgent(agentId));
    },

    async patchAgent(ws, agentId, patch) {
      await delay();
      guardStories(store, ws);
      const a = findAgent(agentId);
      const now = iso(Date.now());
      if ("reset" in patch) {
        Object.assign(a, { instructions: a.defaultInstructions, version: a.version + 1, updatedAt: now });
        return clone(a);
      }
      if (patch.version !== a.version) throw conflict();
      if (patch.instructions !== undefined) {
        const text = patch.instructions.trim();
        if (!text) throw bad("Type what this agent should do, or tap Reset.", "instructions");
        if (text.length > 8000) throw bad("Keep the instructions under 8,000 letters.", "instructions");
      }
      if (patch.model !== undefined && patch.model !== null) modelEntry(patch.model, "model");
      const ownModel = patch.model !== undefined ? patch.model : a.model;
      const model = modelEntry(ownModel ?? config(store).defaultModel, "model");
      const effort = patch.effort !== undefined ? patch.effort : a.effort;
      // The agent's own model and effort are one setting: an effort on its own no-effort model is refused (§45.34).
      if (patch.effort !== undefined || patch.model !== undefined) (ownModel ? checkPair : checkEffort)(model, effort, "effort");
      if (patch.skillIds !== undefined) {
        if (new Set(patch.skillIds).size !== patch.skillIds.length) throw bad("Each skill can be added once.", "skillIds");
        for (const id of patch.skillIds) if (!store.skills.some((s) => s.skillId === id)) throw bad("We could not find that skill.", "skillIds");
      }
      if (patch.instructions !== undefined) a.instructions = patch.instructions.trim();
      if (patch.active !== undefined) a.active = patch.active;
      if (patch.model !== undefined) a.model = patch.model;
      if (patch.effort !== undefined) a.effort = patch.effort;
      if (patch.skillIds !== undefined) a.skillIds = [...patch.skillIds];
      a.version += 1;
      a.updatedAt = now;
      return clone(a);
    },

    async setProviderKey(ws, providerId, key, baseUrl) {
      await delay();
      guardStories(store, ws);
      const p = keyedProvider(providerId);
      const k = key.trim();
      if (!k) throw bad("Paste the key.", "key");
      if (new Blob([k]).size > 4096) throw bad("That key is too long (at most 4 KB).", "key");
      // An OpenAI-compatible key is for one address: its models' (or the baseUrl sent), never another (§45.37 G4).
      let forOrigin: string | undefined;
      if (p.id === "openai_compatible") {
        const used = openAiOrigins(store);
        if (baseUrl) {
          const origin = originOf(cleanBaseUrl(baseUrl));
          if (used.length && !used.includes(origin)) throw new ApiError(409, "conflict", ONE_SERVICE(originHost(used[0]!)));
          forOrigin = origin;
        } else if (used.length) forOrigin = used[0];
        else throw new ApiError(409, "conflict", NEED_MODEL_FIRST);
      } else if (baseUrl) throw bad("Only an OpenAI-compatible key is for an address (baseUrl). Leave it out.", "baseUrl");
      state(store).keys[p.id] = { savedAt: iso(Date.now()), hint: k.length >= 12 ? k.slice(-4) : "", ...(forOrigin ? { forOrigin } : {}) };
      return keyStatus(p);
    },

    async deleteProviderKey(ws, providerId) {
      await delay();
      guardStories(store, ws);
      const p = keyedProvider(providerId);
      delete state(store).keys[p.id];
    },

    async storage(ws) {
      await delay();
      guardStories(store, ws);
      const bytes: StorageSummary["bytes"] = { videos: 0, scenes: 0, audio: 0, references: 0, skills: 0, other: 0 };
      let files = 0;
      // The mock holds one Lamo Stories workspace's files (the API sums this workspace's ASSET# and REFVID# sizes);
      // storyboards and captions count under scenes (§45.34).
      for (const a of store.assets) {
        bytes[STORAGE_KIND[a.kind] ?? "other"] += a.bytes;
        files += 1;
      }
      for (const r of store.references) {
        bytes.references += r.bytes;
        files += 1;
      }
      for (const s of store.skills)
        for (const r of s.revisions) {
          bytes.skills += r.size;
          files += 1;
        }
      return { bytes, files, location: { ...DEFAULT_REGION_FOLDER, folder: `ws/{you}/${ws}/` } };
    },

    async storageCleanup(ws) {
      await delay();
      guardStories(store, ws);
      // The API applies keepReferences, keepChatPictures and keepVersions now. With everything kept there is
      // nothing to clear; otherwise the mock clears what its seed holds back once.
      const w = store.workspaces.find((x) => x.workspaceId === ws);
      const p = (w?.configuration as Partial<StoriesConfig> | undefined)?.production;
      const keepsAll = !p || ((p.keepReferences ?? "all") === "all" && (p.keepChatPictures ?? "all") === "all" && (p.keepVersions ?? "all") === "all");
      const s = state(store);
      if (keepsAll) return { removed: { files: 0, bytes: 0 } };
      const removed = { ...s.clearable };
      s.clearable = { files: 0, bytes: 0 };
      return { removed };
    },
  };
}
