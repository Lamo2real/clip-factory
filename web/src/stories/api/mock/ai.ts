// Lamo Stories mock: the ai part (docs/CONTRACTS.md §45.16.8, §45.25, §45.26, §45.29, §45.31). Builder F2.
// The AI configuration (AICONFIG), the model list from Lamo Stories' own stories/config/models.json (never Clip
// Factory's config/models.json), each model's last call result (MODELSTATUS#, one model denied), Check models as a
// task that walks queued → running → done, the owner's prices, 30 days of usage per model and day, the five agents
// from stories/config/agents.json, provider keys (as the API: none takes one today; the key never comes back, only
// "Key saved · ends 4f2a." in the provider's line) and the storage summary.
// The resolver follows §45.25 and passes stories/config/resolve-cases.json (web/test/storiesSettingsMock.test.ts).
import agentsFile from "../../../../../stories/config/agents.json";
import modelsFile from "../../../../../stories/config/models.json";
import { ApiError } from "../../../api/errors.ts";
import type {
  Agent,
  AgentId,
  AiTask,
  Effective,
  Effort,
  ModelInfo,
  Price,
  ProviderStatus,
  StorageSummary,
  StoriesAiConfig,
  StoriesApi,
  TaskInfo,
  TaskKind,
  UsageSummary,
} from "../types.ts";
import { EFFORT_LABEL } from "../types.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["getAi", "putAi", "checkModels", "setModelPrice", "usage", "getAgent", "patchAgent", "setProviderKey", "deleteProviderKey", "storage"] as const;

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

interface AiState {
  status: Record<string, { status: ModelInfo["status"]; line: string; checkedAt: string | null }>;
  usage: Usage[];
  renderMinutes: number;
  keys: Record<string, { savedAt: string; hint: string }>;
}

const STATE = new WeakMap<MockStore, AiState>();

function state(store: MockStore): AiState {
  let s = STATE.get(store);
  if (!s) {
    s = { status: {}, usage: [], renderMinutes: 0, keys: {} };
    STATE.set(store, s);
  }
  return s;
}

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
  s.renderMinutes = 47;
  s.keys = {};
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
  };
}

function priceOf(store: MockStore, key: string): Price | null {
  const owner = config(store).prices[key];
  if (owner) return owner;
  return MOCK_MODELS.find((m) => m.key === key)?.pricing ?? null;
}

function costOf(store: MockStore, key: string, input: number, output: number): { cost: number | null; currency: string | null } {
  const p = priceOf(store, key);
  if (!p) return { cost: null, currency: null };
  return { cost: Math.round(((input / 1e6) * p.inputPer1M + (output / 1e6) * p.outputPer1M) * 10_000) / 10_000, currency: p.currency };
}

function taskInfos(store: MockStore): TaskInfo[] {
  const ai = config(store);
  return TASKS.map((t) => {
    const agentId = agentForTask(t.kind);
    const agent = store.agents.find((a) => a.agentId === agentId) ?? null;
    const r = resolveEffective({ task: t.kind, ai, agent });
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

function modelEntry(key: string | null | undefined, field: string): ModelEntry {
  const m = MOCK_MODELS.find((x) => x.key === key);
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

/** The owner's price as the API keeps it: the two prices and the currency checked, marked as his. */
function cleanPrice(value: unknown, field: string): Price {
  if (!value || typeof value !== "object") throw bad("Type a price from 0 to 100,000.", field);
  const v = value as Partial<Price>;
  for (const [f, n] of [["inputPer1M", v.inputPer1M], ["outputPer1M", v.outputPer1M]] as const)
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw bad("Type a price from 0 to 100,000.", f);
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) throw bad("Pick a currency.", "currency");
  return {
    inputPer1M: v.inputPer1M!,
    outputPer1M: v.outputPer1M!,
    cacheReadPer1M: typeof v.cacheReadPer1M === "number" ? v.cacheReadPer1M : null,
    cacheWritePer1M: typeof v.cacheWritePer1M === "number" ? v.cacheWritePer1M : null,
    longContext: v.longContext ?? null,
    currency: v.currency,
    source: "owner",
    note: typeof v.note === "string" && v.note.trim() ? v.note.slice(0, 200) : OWNER_NOTE,
  };
}

const STORAGE_KIND: Record<string, keyof StorageSummary["bytes"]> = {
  final_video: "videos",
  cover: "videos",
  scene_clip: "scenes",
  scene_still: "scenes",
  storyboard: "scenes",
  audio: "audio",
};

// ---------- The routes ----------

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const findAgent = (agentId: string): Agent => {
    const a = store.agents.find((x) => x.agentId === agentId);
    if (!a) throw new ApiError(404, "not_found", "We could not find that agent.");
    return a;
  };
  // The key routes answer as the API does: 400 for a provider that needs no key, 404 for one that takes none.
  const keyedProvider = (providerId: string): KeyedProvider => {
    if (!/^[a-z0-9-]{2,40}$/.test(providerId)) throw new ApiError(404, "not_found", "We could not find that provider.");
    if (NO_KEY[providerId]) throw bad(`${NO_KEY[providerId]} uses Lamo Stories' own AWS access, so it needs no key.`);
    const p = keyed(store)[providerId];
    if (!p) throw new ApiError(404, "not_found", `Lamo Stories has no provider called '${providerId}' that uses a key yet.`);
    return p;
  };
  // A keyed provider's ProviderStatus: only "saved · ends 4f2a" of the key, and on only after a real call.
  const keyStatus = (p: KeyedProvider): ProviderStatus => {
    const saved = state(store).keys[p.id];
    if (!saved) return { kind: p.kind, id: p.id, label: p.label, state: "needs_setup", line: `Paste your ${p.label} key to use it.` };
    return { kind: p.kind, id: p.id, label: p.label, state: "needs_setup", line: `${saved.hint ? `Key saved · ends ${saved.hint}.` : "Key saved."} It is checked on its first real call.` };
  };

  return {
    async getAi(ws) {
      await delay();
      guardStories(store, ws);
      return { ai: clone(config(store)), models: MOCK_MODELS.map((m) => modelInfo(store, m)), agents: clone(store.agents), tasks: taskInfos(store) };
    },

    async putAi(ws, next) {
      await delay();
      guardStories(store, ws);
      const now = config(store);
      if (next.version !== now.version) throw conflict();
      const def = modelEntry(next.defaultModel, "defaultModel");
      if (!EFFORTS.includes(next.defaultEffort)) throw bad("That effort level does not exist. Pick Low, Medium, High, Extra high or Maximum.", "defaultEffort");
      checkEffort(def, next.defaultEffort, "defaultEffort");
      const tasks: StoriesAiConfig["tasks"] = {};
      for (const [kind, set] of Object.entries(next.tasks ?? {})) {
        if (!TASK_KINDS.includes(kind)) throw bad("That is not a Lamo Stories task.", "tasks");
        if (!set || (!set.model && !set.effort)) continue;
        const agent = store.agents.find((a) => a.agentId === agentForTask(kind as TaskKind));
        const model = modelEntry(set.model ?? agent?.model ?? next.defaultModel, "tasks");
        checkEffort(model, set.effort, "tasks");
        tasks[kind as TaskKind] = { ...(set.model ? { model: set.model } : {}), ...(set.effort ? { effort: set.effort } : {}) };
      }
      // The owner's prices, by model key or provider id; left as they are when the body has none.
      let prices = clone(now.prices);
      if (next.prices !== undefined) {
        if (!next.prices || typeof next.prices !== "object") throw bad("Type a price from 0 to 100,000.", "prices");
        prices = {};
        for (const [key, value] of Object.entries(next.prices)) {
          if (!MOCK_MODELS.some((m) => m.key === key) && !PRICE_PROVIDERS.includes(key)) throw bad(`There is no model or provider called '${key}' to set a price for.`, "prices");
          prices[key] = cleanPrice(value, `prices.${key}`);
        }
      }
      store.ai = { defaultModel: next.defaultModel, defaultEffort: next.defaultEffort, tasks, prices, version: now.version + 1 };
      return clone(store.ai);
    },

    async checkModels(ws, models) {
      await delay();
      guardStories(store, ws);
      const keys = models?.length ? models : MOCK_MODELS.map((m) => m.key);
      for (const k of keys) modelEntry(k, "models");
      const at = iso(Date.now());
      const task: AiTask = { taskId: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`, kind: "check_models", status: "queued", model: null, effort: null, effortApplied: null, result: null, createdAt: at, updatedAt: at };
      store.tasks.push(task);
      const ms = typeof store.knobs.checkModelsMs === "number" ? store.knobs.checkModelsMs : 1800;
      // Each model gets one tiny real call in the real app; here every one answers except the one this account
      // cannot use (it stays denied with Amazon Bedrock's reason).
      setTimeout(() => Object.assign(task, { status: "running", updatedAt: iso(Date.now()) }), ms / 3);
      setTimeout(() => {
        const when = iso(Date.now());
        const s = state(store);
        const results = keys.map((k) => {
          // Knob `modelDenied` (the shell's name) picks the model Bedrock refuses; `allowFable51` lets every one answer.
          const deniedKey = typeof store.knobs.modelDenied === "string" ? store.knobs.modelDenied : "fable-5-1";
          const denied = k === deniedKey && store.knobs.allowFable51 !== true;
          s.status[k] = denied ? { status: "denied", line: deniedLine(k), checkedAt: when } : { status: "ok", line: "It answered on the last call.", checkedAt: when };
          return { key: k, status: s.status[k]!.status, line: s.status[k]!.line };
        });
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
      const rows = state(store).usage.filter((u) => u.day >= since);
      const dayList = Array.from(new Set(rows.map((u) => u.day))).sort().reverse();
      const out: UsageSummary = {
        days: dayList.map((day) => ({
          day,
          byModel: rows.filter((u) => u.day === day).map((u) => ({ model: u.model, input: u.input, output: u.output, ...costOf(store, u.model, u.input, u.output) })),
        })),
        totals: Array.from(new Set(rows.map((u) => u.model))).map((model) => {
          const mine = rows.filter((u) => u.model === model);
          const input = mine.reduce((a, u) => a + u.input, 0);
          const output = mine.reduce((a, u) => a + u.output, 0);
          return { model, input, output, ...costOf(store, model, input, output) };
        }),
        renderMinutes: state(store).renderMinutes,
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
      const model = modelEntry((patch.model !== undefined ? patch.model : a.model) ?? config(store).defaultModel, "model");
      if (patch.effort !== undefined || patch.model !== undefined) checkEffort(model, patch.effort !== undefined ? patch.effort : a.effort, "effort");
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
      // The mock holds one Lamo Stories workspace's files (the API sums this workspace's ASSET# and REFVID# sizes).
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
      return { bytes, files };
    },
  };
}
