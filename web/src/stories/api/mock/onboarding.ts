// Lamo Stories mock: the onboarding part (docs/CONTRACTS.md §45.29, §45.33, §45.34, §45.16.8). Eleven steps, every
// one skippable; the done-states come from real state where they can (§45.34: step 1 once Check models ran or the
// owner said the models look right, 2 once he picked the default model, 3 the default effort, each stamped by PUT
// …/ai `picked`; 4 a video provider picked; 6 to 10 that platform connected, never an account that is Lamo Clips'
// own); only 5 (agents and skills) and 11 (done) are ticked by hand. A brand-new studio (knob `fresh`) starts at 0 of
// 11, so the setup opens by itself the first time.
//
// It also holds the shell's stand-ins for the AI settings the onboarding needs (index.ts uses builder F2's own
// methods as soon as they are built): the AI configuration, the model list, Check models and its task.
import agentsFile from "../../../../../stories/config/agents.json";
import modelsFile from "../../../../../stories/config/models.json";
import { ApiError } from "../../../api/errors.ts";
import type { Agent, AgentId, AiTask, Effort, ModelInfo, Onboarding, OnboardStep, SocialAccount, StoriesAiConfig, StoriesApi, TaskInfo, TaskKind } from "../types.ts";
import { aiPicks, stampPicked } from "./ai.ts";
import { ago, delay, HOUR, mockId, type MockStore } from "./store.ts";
import { DEFAULT_CONFIG, storiesWorkspace } from "./workspace.ts";

export const KEYS = ["getOnboarding", "patchOnboarding"] as const;

/** The eleven steps in order, with the words the ring's list shows (§45.29). */
export const ONBOARD_STEPS: { step: OnboardStep; label: string }[] = [
  { step: "ai", label: "Set up the AI" },
  { step: "model", label: "Pick your default model" },
  { step: "effort", label: "Pick your default effort" },
  { step: "video", label: "Pick how videos are made" },
  { step: "agents", label: "Meet your agents and skills" },
  { step: "instagram", label: "Connect Instagram" },
  { step: "tiktok", label: "Connect TikTok" },
  { step: "youtube", label: "Connect YouTube" },
  { step: "facebook", label: "Connect Facebook" },
  { step: "x", label: "Connect X" },
  { step: "done", label: "Done" },
];

/** Ticked by hand; every other step ticks itself from what is really set up (§45.33). */
const BY_HAND: OnboardStep[] = ["agents", "done"];
const SOCIAL_STEPS: OnboardStep[] = ["instagram", "tiktok", "youtube", "facebook", "x"];
const SOCIAL_LABEL: Partial<Record<OnboardStep, string>> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", facebook: "Facebook", x: "X" };

/** What the API answers (409) to a hand tick on a step that ticks itself. */
const TICKS_ITSELF: Partial<Record<OnboardStep, string>> = {
  ai: "This step ticks itself when you check the models or say they look right.",
  model: "This step ticks itself when you pick your default model.",
  effort: "This step ticks itself when you pick your default effort.",
  video: "This step ticks itself when you pick how videos are made.",
  ...Object.fromEntries(SOCIAL_STEPS.map((p) => [p, `This step ticks itself when ${SOCIAL_LABEL[p]} is connected.`])),
};

export function seed(store: MockStore): void {
  if (store.knobs.fresh) {
    store.onboarding = { stepsDone: [], skipped: [], finishedAt: null, providersPickedAt: null };
    return;
  }
  // A studio that is a little way in: the agents met, YouTube connected (social seed), the rest still to do.
  store.onboarding = { stepsDone: ["agents"], skipped: [], finishedAt: null, providersPickedAt: null };
}

/** A platform step is done only once Lamo Stories' own account there is connected (§45.34): Lamo Clips' own on hold is not. */
const COUNTS_CONNECTED: SocialAccount["connectionStatus"][] = ["connected"];

/** Step 4: providersPickedAt, or a picture or video maker other than the built-in default (the API's rule). */
function videoPicked(store: MockStore, ws: string): boolean {
  if (store.onboarding.providersPickedAt) return true;
  const chosen = storiesWorkspace(store, ws).configuration.providers;
  return (["video", "images"] as const).some((k) => chosen[k] !== DEFAULT_CONFIG.providers[k]);
}

/** Steps 1 to 3 (§45.34): AICONFIG.pickedAt, and for step 1 also a Check models that ran. */
function aiDone(store: MockStore, step: "ai" | "model" | "effort"): boolean {
  const { picked, checkedAt } = aiPicks(store);
  if (step === "ai") return !!picked.environment || !!checkedAt || store.tasks.some((t) => t.kind === "check_models" && t.status === "done");
  return !!picked[step];
}

function realDone(store: MockStore, ws: string, step: OnboardStep): boolean {
  if (step === "ai" || step === "model" || step === "effort") return aiDone(store, step);
  if (step === "video") return videoPicked(store, ws);
  if (SOCIAL_STEPS.includes(step)) return store.social.some((a) => a.workspaceId === ws && a.platform === step && COUNTS_CONNECTED.includes(a.connectionStatus));
  if (step === "done") return store.onboarding.stepsDone.includes("done") || store.onboarding.finishedAt !== null;
  return store.onboarding.stepsDone.includes(step);
}

export function onboardingOf(store: MockStore, ws: string): Onboarding {
  const steps = ONBOARD_STEPS.map(({ step, label }) => {
    const done = realDone(store, ws, step);
    return { step, label, state: done ? ("done" as const) : store.onboarding.skipped.includes(step) ? ("skipped" as const) : ("todo" as const) };
  });
  return { steps, done: steps.filter((s) => s.state === "done").length, total: 11, finishedAt: store.onboarding.finishedAt };
}

const isStep = (s: unknown): s is OnboardStep => ONBOARD_STEPS.some((o) => o.step === s);

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async getOnboarding(ws) {
      await delay(140);
      storiesWorkspace(store, ws);
      return onboardingOf(store, ws);
    },
    async patchOnboarding(ws, body) {
      await delay(180);
      storiesWorkspace(store, ws);
      const o = store.onboarding;
      // The API's answers word for word (§45.6): {finish: true}, or {step, done?, skipped?}.
      if ("finish" in body) {
        if (body.finish !== true) throw new ApiError(400, "bad_request", "finish must be true.", "finish");
        o.stepsDone = [...new Set([...o.stepsDone, "done" as const])];
        o.finishedAt ??= new Date().toISOString();
        return onboardingOf(store, ws);
      }
      if (!isStep(body.step)) throw new ApiError(400, "bad_request", "That is not a setup step.", "step");
      if (body.done === undefined && body.skipped === undefined) throw new ApiError(400, "bad_request", "Say whether the step is done or skipped.");
      if (body.done !== undefined) {
        if (!BY_HAND.includes(body.step)) throw new ApiError(409, "conflict", TICKS_ITSELF[body.step] ?? "This step ticks itself.");
        o.stepsDone = body.done ? [...new Set([...o.stepsDone, body.step])] : o.stepsDone.filter((s) => s !== body.step);
        // Ticking Done finishes the setup (and unticking it opens it again), as {finish: true} does.
        if (body.step === "done") o.finishedAt = body.done ? (o.finishedAt ?? new Date().toISOString()) : null;
      }
      if (body.skipped !== undefined) o.skipped = body.skipped ? [...new Set([...o.skipped, body.step])] : o.skipped.filter((s) => s !== body.step);
      return onboardingOf(store, ws);
    },
  };
}

// ---------- Stand-ins for the AI settings (builder F2's ai.ts replaces each one once it is built) ----------

interface FileModel {
  key: string;
  label: string;
  provider: string;
  modelId: string;
  efforts: Effort[];
  defaultEffort: Effort | null;
  vision: boolean;
  pricing: ModelInfo["price"];
}

const FILE_MODELS = (modelsFile as unknown as { models: FileModel[] }).models;
const FILE_DEFAULTS = modelsFile as unknown as { defaultModel: string; defaultEffort: Effort };

/** The suggested effort per task (§45.25), shown, never forced. */
const TASKS: { kind: TaskKind; label: string; agentId: AgentId; suggestedEffort: Effort }[] = [
  { kind: "chat", label: "Chat", agentId: "creative_director", suggestedEffort: "medium" },
  { kind: "brainstorm", label: "Ideas", agentId: "creative_director", suggestedEffort: "medium" },
  { kind: "expand_idea", label: "Make it a full idea", agentId: "creative_director", suggestedEffort: "medium" },
  { kind: "variations", label: "More like this", agentId: "creative_director", suggestedEffort: "medium" },
  { kind: "storyboard", label: "Write the story", agentId: "storyboard", suggestedEffort: "high" },
  { kind: "scene_rewrite", label: "Remake a scene", agentId: "storyboard", suggestedEffort: "high" },
  { kind: "captions", label: "Post captions", agentId: "storyboard", suggestedEffort: "low" },
  { kind: "character_design", label: "Design a character", agentId: "character", suggestedEffort: "medium" },
  { kind: "reference_analysis", label: "Study a reference video", agentId: "video_analysis", suggestedEffort: "high" },
  { kind: "fact_check", label: "Check the facts", agentId: "quality_assurance", suggestedEffort: "high" },
  { kind: "final_review", label: "Last look", agentId: "quality_assurance", suggestedEffort: "high" },
];

function aiConfig(store: MockStore): StoriesAiConfig {
  return store.ai ?? { defaultModel: FILE_DEFAULTS.defaultModel, defaultEffort: FILE_DEFAULTS.defaultEffort, tasks: {}, prices: {}, version: 0 };
}

function modelStatus(store: MockStore): Record<string, Pick<ModelInfo, "status" | "statusLine" | "checkedAt">> {
  return (store.knobs.modelStatus as Record<string, Pick<ModelInfo, "status" | "statusLine" | "checkedAt">> | undefined) ?? {};
}

function modelsOf(store: MockStore): ModelInfo[] {
  const seen = modelStatus(store);
  return FILE_MODELS.map((m) => ({
    key: m.key,
    label: m.label,
    provider: m.provider,
    modelId: m.modelId,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    vision: m.vision,
    status: seen[m.key]?.status ?? "not_checked",
    statusLine: seen[m.key]?.statusLine ?? "Not checked yet. Tap Check models.",
    checkedAt: seen[m.key]?.checkedAt ?? null,
    price: aiConfig(store).prices[m.key] ?? m.pricing,
  }));
}

function agentsOf(store: MockStore): Agent[] {
  if (store.agents.length) return store.agents;
  const file = (agentsFile as unknown as { agents: { agentId: AgentId; name: string; tasks: TaskKind[]; skills: string[]; instructions: string }[] }).agents;
  return file.map((a) => ({
    agentId: a.agentId,
    name: a.name,
    tasks: a.tasks,
    instructions: a.instructions,
    defaultInstructions: a.instructions,
    active: true,
    model: null,
    effort: null,
    skillIds: a.skills,
    version: 1,
    updatedAt: ago(9 * 24 * HOUR),
  }));
}

function tasksOf(store: MockStore): TaskInfo[] {
  const ai = aiConfig(store);
  const agents = agentsOf(store);
  return TASKS.map((t) => {
    const agent = agents.find((a) => a.agentId === t.agentId);
    const own = ai.tasks[t.kind] ?? {};
    const model = own.model ?? agent?.model ?? ai.defaultModel;
    const effort = own.effort ?? agent?.effort ?? ai.defaultEffort;
    const from = own.model || own.effort ? "task" : agent?.model || agent?.effort ? "agent" : "default";
    const offers = FILE_MODELS.find((m) => m.key === model)?.efforts ?? [];
    return { ...t, effective: { model, effort: offers.length ? effort : null, effortApplied: offers.length > 0, from } };
  });
}

/** The AI configuration's own checks (§45.25): known models, efforts each model offers, known tasks. */
function checkAi(next: StoriesAiConfig): void {
  const model = (key: string) => FILE_MODELS.find((m) => m.key === key);
  const effortOk = (key: string, e: Effort | undefined) => !e || (model(key)?.efforts ?? []).includes(e);
  const EFFORT_WORD: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
  if (!model(next.defaultModel)) throw new ApiError(400, "bad_request", "Pick one of the models in the list.", "defaultModel");
  if (!effortOk(next.defaultModel, next.defaultEffort))
    throw new ApiError(400, "bad_request", `${model(next.defaultModel)!.label} does not offer ${EFFORT_WORD[next.defaultEffort]}. Pick another level.`, "defaultEffort");
  for (const [kind, t] of Object.entries(next.tasks)) {
    if (!TASKS.some((x) => x.kind === kind)) throw new ApiError(400, "bad_request", "We do not know that task.", "tasks");
    const key = t?.model ?? next.defaultModel;
    if (t?.model && !model(t.model)) throw new ApiError(400, "bad_request", "Pick one of the models in the list.", "tasks");
    if (!effortOk(key, t?.effort)) throw new ApiError(400, "bad_request", `${model(key)!.label} does not offer ${EFFORT_WORD[t!.effort!]}. Pick another level.`, "tasks");
  }
}

/**
 * The shell's stand-ins (used only while builder F2's methods are not built): what the onboarding's AI steps call.
 * They read and write the same store items F2's part does (`store.ai`, `store.tasks`).
 */
export function shellFallbacks(store: MockStore): Partial<StoriesApi> {
  return {
    async getAi(ws) {
      await delay(160);
      storiesWorkspace(store, ws);
      return structuredClone({ ai: aiConfig(store), models: modelsOf(store), agents: agentsOf(store), tasks: tasksOf(store) });
    },
    async putAi(ws, body) {
      await delay(220);
      storiesWorkspace(store, ws);
      const now = aiConfig(store);
      const { picked, ...ai } = body;
      if (ai.version !== now.version) throw new ApiError(409, "conflict", "These settings changed somewhere else. We loaded the new ones: check them and save again.");
      checkAi(ai);
      stampPicked(store, picked);
      store.ai = { ...structuredClone(ai), version: now.version + 1 };
      return structuredClone(store.ai);
    },
    async checkModels(ws, models) {
      await delay(200);
      storiesWorkspace(store, ws);
      const at = new Date().toISOString();
      const task: AiTask = { taskId: mockId(), kind: "check_models", status: "running", model: null, effort: null, effortApplied: null, result: null, createdAt: at, updatedAt: at };
      store.tasks.push(task);
      const keys = models?.length ? models : FILE_MODELS.map((m) => m.key);
      // One tiny real call per model, then each model's status (a test knob can make one refuse).
      setTimeout(() => {
        const refused = store.knobs.modelDenied as string | undefined;
        const seen = { ...modelStatus(store) };
        for (const k of keys)
          seen[k] =
            k === refused
              ? { status: "denied", statusLine: "Bedrock says this account may not use this model yet.", checkedAt: new Date().toISOString() }
              : { status: "ok", statusLine: "It answered.", checkedAt: new Date().toISOString() };
        store.knobs.modelStatus = seen;
        task.status = "done";
        task.result = { models: keys.map((k) => ({ key: k, ...seen[k] })) };
        task.updatedAt = new Date().toISOString();
      }, 900);
      return structuredClone(task);
    },
    async getTask(ws, taskId) {
      await delay(120);
      storiesWorkspace(store, ws);
      const task = store.tasks.find((t) => t.taskId === taskId);
      if (!task) throw new ApiError(404, "not_found", "We could not find that task.");
      return structuredClone(task);
    },
  };
}
