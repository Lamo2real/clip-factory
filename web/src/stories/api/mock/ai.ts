// Lamo Stories mock: the ai part (docs/CONTRACTS.md §45.16.8, §45.25, §45.26, §45.29, §45.31, §45.34). Builders F2
// and W3c. The AI configuration (AICONFIG, with what the owner picked on purpose for setup steps 1 to 3), the model
// list from Lamo Stories' own stories/config/models.json (never Clip Factory's config/models.json) plus the models the
// owner added (MODELDEF#, Bedrock models, at most 20, never shadowing a bundled key), each model's last call result
// (MODELSTATUS#, one model denied), Check models as a task that walks queued → running → done, the owner's prices
// (per million tokens for models; per picture or second for the picture and video makers), 30 days of usage per
// model, provider and day (render minutes too), the five agents from stories/config/agents.json, provider keys (as
// the API: none takes one today; the key never comes back, only its last four), the storage summary with its place,
// and Clean up now. The resolver follows §45.25 and passes stories/config/resolve-cases.json.
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
  ModelDef,
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
import { CUSTOM_MODEL_KEY, EFFORT_LABEL, MAX_CUSTOM_MODELS } from "../types.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = [
  "getAi",
  "putAi",
  "putAiModel",
  "deleteAiModel",
  "checkModels",
  "setModelPrice",
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
  /** one the owner added (MODELDEF#), with its own Region and output limit */
  custom?: { region: string; maxOutputTokens: number };
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
  })),
  { key: "nova-pro", label: "Amazon Nova Pro", provider: "Amazon Bedrock", modelId: "amazon.nova-pro-v1:0", efforts: [], defaultEffort: null, vision: true, pricing: null },
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
  { kind: "brainstorm", label: "Ask for ideas", suggestedEffort: "medium" },
  { kind: "expand_idea", label: "Make it a full idea", suggestedEffort: "high" },
  { kind: "variations", label: "More like this", suggestedEffort: "medium" },
  { kind: "reference_analysis", label: "Study a reference video", suggestedEffort: "high" },
  { kind: "storyboard", label: "Write the story", suggestedEffort: "high" },
  { kind: "scene_rewrite", label: "Remake a scene", suggestedEffort: "high" },
  { kind: "captions", label: "Write the post captions", suggestedEffort: "low" },
  { kind: "character_design", label: "Design a character", suggestedEffort: "medium" },
  { kind: "fact_check", label: "Check the facts", suggestedEffort: "high" },
  { kind: "final_review", label: "Last look at the video", suggestedEffort: "high" },
];

export function agentForTask(kind: TaskKind): AgentId {
  return AGENTS_FILE.find((a) => a.tasks.includes(kind))?.agentId ?? "creative_director";
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
  if (!entry) return { error: "model", message: "That model is not one Lamo Stories can use. Pick another model in Lamo Stories › Settings › AI." };
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
  unit: "image" | "second";
}

interface AiState {
  status: Record<string, { status: ModelInfo["status"]; line: string; checkedAt: string | null }>;
  usage: Usage[];
  /** the picture and video makers' use (USAGE# kind provider): built-in render seconds are builtin-rig */
  makers: MakerUse[];
  keys: Record<string, { savedAt: string; hint: string }>;
  /** the models the owner added (MODELDEF#{key}), in the order they were added */
  custom: Record<string, ModelDef & { createdAt: string; updatedAt: string }>;
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
    s = { status: {}, usage: [], makers: [], keys: {}, custom: {}, picked: {}, checkedAt: null, clearable: { files: 0, bytes: 0 } };
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
    tasks: [...a.tasks],
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
  if (ws === "clips") throw new ApiError(409, "conflict", "That is a Lamo Stories page. Switch to Lamo Stories first.");
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
      custom: { region: d.region, maxOutputTokens: d.maxOutputTokens },
    }),
  );
  return [...MOCK_MODELS, ...own];
}

function modelInfo(store: MockStore, m: ModelEntry): ModelInfo {
  const st = state(store).status[m.key] ?? { status: "not_checked" as const, line: "Not checked yet. Tap Check models.", checkedAt: null };
  const owner = config(store).prices[m.key];
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
    ...(m.custom ? { region: m.custom.region, maxOutputTokens: m.custom.maxOutputTokens } : {}),
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
  if (!m) throw bad("That model is not one Lamo Stories can use. Pick one from the list.", field);
  return m;
}

const TASK_KINDS = TASKS.map((t) => t.kind) as string[];

/** The providers that use Lamo Stories' own AWS access, so a key is never asked for (as the API's NO_KEY). */
const NO_KEY: Record<string, string> = {
  "bedrock-claude": "Claude on Amazon Bedrock",
  "nova-canvas": "Amazon Nova Canvas",
  "nova-reel": "Amazon Nova Reel",
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
 * The providers that take an API key. None does today (the API's KEYED is empty, so its key routes answer 404); a
 * test or a dev session can list one in `store.knobs.keyedProviders`, which must also be in the providers list.
 */
function keyed(store: MockStore): Record<string, KeyedProvider> {
  const list = Array.isArray(store.knobs.keyedProviders) ? (store.knobs.keyedProviders as KeyedProvider[]) : [];
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

/** The provider ids whose use can carry the owner's price beside the models (as the API's PRICE_PROVIDERS). */
export const PRICE_PROVIDERS = ["nova-canvas", "nova-reel"];

const OWNER_NOTE = "The price you typed.";
/** The highest price for a million (tokens, pictures or seconds) the API takes. */
const MAX_PRICE = 100_000;

/** Each maker's unit (§45.34): Nova Canvas by the picture, Nova Reel by the second of video. */
export const PROVIDER_UNIT: Record<string, "image" | "second"> = { "nova-canvas": "image", "nova-reel": "second" };
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
    if (typeof v.perUnit !== "number" || !Number.isFinite(v.perUnit) || v.perUnit < 0 || v.perUnit > MAX_UNIT_PRICE) throw bad(`Type a price from 0 to ${MAX_UNIT_PRICE} for one ${unit === "image" ? "picture" : "second"}.`, "perUnit");
    if (v.unit !== unit) throw bad(`${provider} is priced by the ${unit === "image" ? "picture" : "second"}.`, "unit");
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

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
/** A Bedrock model id (maker.name-version[:n]), an inference profile id (eu., us., apac., global. first) or an ARN. */
const MODEL_ID = /^(arn:aws:bedrock:[a-z0-9-]+:\d{12}:(foundation-model|inference-profile|application-inference-profile)\/[A-Za-z0-9.:/_-]+|[a-z0-9-]+(\.[a-z0-9-]+)+(-v\d+(:\d+)?|:\d+)?[A-Za-z0-9.:_-]*)$/;
export const MAX_OUTPUT_TOKENS = 200_000;

/** A ModelDef checked as the API does (unknown keys and bad values are a 400 with the field). */
function cleanDef(store: MockStore, key: string, value: unknown): ModelDef {
  if (!CUSTOM_MODEL_KEY.test(key)) throw bad("A model you add gets a name like custom-my-model.", "key");
  if (MOCK_MODELS.some((m) => m.key === key)) throw bad("That name is taken by a model Lamo Stories comes with.", "key");
  if (!value || typeof value !== "object") throw bad("Fill in the model's details.");
  const v = value as Partial<ModelDef> & Record<string, unknown>;
  const allowed = ["label", "provider", "modelId", "region", "efforts", "defaultEffort", "vision", "maxOutputTokens", "price"];
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw bad(`Unknown field '${k}'.`, k);
  const label = typeof v.label === "string" ? v.label.trim() : "";
  if (!label || label.length > 60) throw bad("Give it a name of 1 to 60 letters.", "label");
  if (allModels(store).some((m) => m.key !== key && m.label.toLowerCase() === label.toLowerCase())) throw bad(`There is already a model called ${label}. Pick another name.`, "label");
  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  if (!provider || provider.length > 40) throw bad("Say who makes it, for example Anthropic or Amazon.", "provider");
  const modelId = typeof v.modelId === "string" ? v.modelId.trim() : "";
  if (!modelId || modelId.length > 200 || !MODEL_ID.test(modelId)) throw bad("Paste the model ID or inference profile from Amazon Bedrock, like eu.amazon.nova-premier-v1:0.", "modelId");
  const region = typeof v.region === "string" ? v.region.trim() : "";
  if (!REGION.test(region)) throw bad("Pick the AWS Region the model runs in.", "region");
  if (!Array.isArray(v.efforts) || v.efforts.some((e) => !EFFORTS.includes(e as Effort)) || new Set(v.efforts).size !== v.efforts.length) throw bad("Pick each effort level once.", "efforts");
  const efforts = EFFORTS.filter((e) => (v.efforts as Effort[]).includes(e));
  const defaultEffort = v.defaultEffort ?? null;
  if (defaultEffort !== null && !efforts.includes(defaultEffort)) throw bad(efforts.length ? "Its own level must be one of the levels it accepts." : "A model with no effort setting has no level of its own.", "defaultEffort");
  if (efforts.length && defaultEffort === null) throw bad("Pick its own level, the one it uses when nothing else is set.", "defaultEffort");
  if (typeof v.vision !== "boolean") throw bad("Say whether it can look at pictures.", "vision");
  const max = v.maxOutputTokens;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_OUTPUT_TOKENS) throw bad(`Type how many tokens it may write, from 1 to ${MAX_OUTPUT_TOKENS.toLocaleString("en-GB")}.`, "maxOutputTokens");
  const price = v.price === null || v.price === undefined ? null : cleanPrice(v.price, "price");
  return { label, provider, modelId, region, efforts, defaultEffort, vision: v.vision, maxOutputTokens: max, price };
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
    if (!/^[a-z0-9-]{2,40}$/.test(providerId)) throw new ApiError(404, "not_found", "We could not find that provider.");
    if (NO_KEY[providerId]) throw bad(`${NO_KEY[providerId]} uses Lamo Stories' own AWS access, so it needs no key.`);
    const p = keyed(store)[providerId];
    if (!p) throw new ApiError(404, "not_found", `Lamo Stories has no provider called '${providerId}' that uses a key yet.`);
    return p;
  };
  // A keyed provider's ProviderStatus: only "saved · ends 4f2a" of the key (and `key` saying whether one is saved,
  // §45.34), and on only after a real call.
  const keyStatus = (p: KeyedProvider): ProviderStatus => {
    const saved = state(store).keys[p.id];
    if (!saved) return { kind: p.kind, id: p.id, label: p.label, state: "needs_setup", line: `Paste your ${p.label} key to use it.`, key: { saved: false, hint: null, savedAt: null } };
    return {
      kind: p.kind,
      id: p.id,
      label: p.label,
      state: "needs_setup",
      line: `${saved.hint ? `Key saved · ends ${saved.hint}.` : "Key saved."} It is checked on its first real call.`,
      key: { saved: true, hint: saved.hint || null, savedAt: saved.savedAt },
    };
  };

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
        if (!TASK_KINDS.includes(kind)) throw bad("That is not a Lamo Stories task.", "tasks");
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
      const before = s.custom[key];
      if (!before && Object.keys(s.custom).length >= MAX_CUSTOM_MODELS) throw bad(`You can add up to ${MAX_CUSTOM_MODELS} models. Remove one first.`, "key");
      const at = iso(Date.now());
      s.custom[key] = { ...clean, createdAt: before?.createdAt ?? at, updatedAt: at };
      // A changed id, Region or levels has to be checked again: nothing is shown as working because it is listed.
      if (!before || before.modelId !== clean.modelId || before.region !== clean.region) s.status[key] = { status: "not_checked", line: "Not checked yet. Tap Check models.", checkedAt: null };
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

    async checkModels(ws, models) {
      await delay();
      guardStories(store, ws);
      const list = allModels(store);
      const keys = models?.length ? models : list.map((m) => m.key);
      for (const k of keys) modelEntry(k, "models");
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
        s.checkedAt = when;
        Object.assign(task, { status: "done", result: { models: results }, updatedAt: when });
      }, ms);
      return clone(task);
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

    async setProviderKey(ws, providerId, key) {
      await delay();
      guardStories(store, ws);
      const p = keyedProvider(providerId);
      const k = key.trim();
      if (!k) throw bad("Paste the key.", "key");
      if (new Blob([k]).size > 4096) throw bad("That key is too long (at most 4 KB).", "key");
      state(store).keys[p.id] = { savedAt: iso(Date.now()), hint: k.length >= 12 ? k.slice(-4) : "" };
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
