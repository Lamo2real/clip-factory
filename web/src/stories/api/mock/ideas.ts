// Lamo Stories mock: the ideas part and the AI tasks (docs/CONTRACTS.md §45.7, §45.25, §45.16.8). Builder G.
// Manual ideas, and "Ask for ideas", "Make it a full idea" and "More like this" as AI tasks of the creative director:
// each answers 202 with a task at once, then GET …/tasks/{id} walks it queued → running → done (about 2.5 s; knob
// taskSeconds) with the drafts or the concept, or failed with its plain sentence (knob taskFail: the next task fails;
// knob deniedModels: model keys Bedrock "refuses", which fail the task with the no-substitution sentence). The model
// and effort of every task follow the same levels as the API (a per-request override, the task's, the agent's, the
// workspace default; Lamo Stories' own stories/config/models.json), merged separately. Topic matching runs here once,
// like the API: a driving-safety idea gets the checked guidance topic its words match (stories/config/guidance.json,
// §45.11.5), else needsGuidance and it cannot be made into a video.
import guidanceFile from "../../../../../stories/config/guidance.json";
import modelsFile from "../../../../../stories/config/models.json";
import type { AgentId, AiTask, Effort, Idea, IdeaCategory, IdeaInput, ModelOverride, StoriesApi, TaskKind, VideoConcept } from "../types.ts";
import { allModels } from "./ai.ts";
import { AGENT_REGION, modelCall } from "./chat.ts";
import { seriesExists } from "./series.ts";
import { delay, type MockStore } from "./store.ts";
import { clone, fail, guardWs, iso, mockId, SEED_IDS } from "./stories.ts";

export { modelCall };

export const KEYS = ["listIdeas", "createIdea", "patchIdea", "deleteIdea", "generateIdeas", "expandIdea", "ideaVariations", "getTask"] as const;

interface GuidanceStep {
  id: string;
  text: string;
  sources: string[];
  shown: boolean;
  why?: string;
}
interface GuidanceTopicFile {
  id: string;
  title: string;
  keywords: string[];
  steps: GuidanceStep[];
  donts: GuidanceStep[];
  caveats: string[];
  citations: string[];
}
interface GuidanceSource {
  publisher: string;
  title: string;
  url: string;
  section?: string;
}

const TOPICS = guidanceFile.topics as unknown as GuidanceTopicFile[];
const SOURCES = guidanceFile.sources as unknown as Record<string, GuidanceSource>;

/** A short, kid-proof name for each checked situation (the video titles and the drafts use it). */
const SAFETY_TITLE: Record<string, string> = {
  "skid-recovery": "When the car starts to slide",
  "ice-snow-driving": "Driving on ice and snow",
  "tyre-blowout": "When a tyre bursts",
  aquaplaning: "When the car floats on water",
  "brake-failure": "When the brakes stop working",
  "stuck-accelerator": "When the pedal gets stuck",
  "off-road-recovery": "When the wheels leave the road",
  "fog-driving": "Driving in fog",
  "animal-on-road": "An animal on the road",
  "motorway-breakdown": "Breaking down on the motorway",
  "abs-emergency-stop": "Stopping fast with ABS",
  crosswinds: "Strong wind on the road",
};

export function guidanceTopicIds(): string[] {
  return TOPICS.map((t) => t.id);
}

export function topicTitle(topicId: string | null): string | null {
  return TOPICS.find((t) => t.id === topicId)?.title ?? null;
}

export function shortTopicTitle(topicId: string): string {
  return SAFETY_TITLE[topicId] ?? topicTitle(topicId) ?? topicId;
}

/** The steps a video may show for a topic (a road authority states them and nothing cited contradicts them). */
export function shownSteps(topicId: string): { id: string; text: string }[] {
  const topic = TOPICS.find((t) => t.id === topicId);
  return topic ? topic.steps.filter((s) => s.shown).map((s) => ({ id: s.id, text: s.text })) : [];
}

export function citationsFor(topicId: string | null): { publisher: string; title: string; url: string; section?: string }[] {
  const topic = TOPICS.find((t) => t.id === topicId);
  if (!topic) return [];
  const seen = new Set<string>();
  const out: { publisher: string; title: string; url: string; section?: string }[] = [];
  for (const id of topic.citations) {
    const s = SOURCES[id];
    if (!s || seen.has(s.url + (s.section ?? ""))) continue;
    seen.add(s.url + (s.section ?? ""));
    out.push(s.section ? { publisher: s.publisher, title: s.title, url: s.url, section: s.section } : { publisher: s.publisher, title: s.title, url: s.url });
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The checked topic these words are about (whole-word keyword matches; the longest total wins), or null. */
export function topicFor(text: string): string | null {
  let best: { id: string; score: number } | null = null;
  for (const topic of TOPICS) {
    let score = 0;
    for (const k of topic.keywords) if (new RegExp(`\\b${escape(k)}\\b`, "i").test(text)) score += k.length;
    if (score > 0 && score > (best?.score ?? 0)) best = { id: topic.id, score };
  }
  return best?.id ?? null;
}

// ---------- Models, effort and AI tasks (shared with the characters and stories parts) ----------

interface ListedModel {
  key: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  /** who makes it (Anthropic, Amazon, Meta …) */
  provider?: string;
}

const MODELS = (modelsFile as unknown as { models: ListedModel[] }).models;

/**
 * The models a call may use: Lamo Stories' file, and with the store also the practice app's own list as GET …/ai shows
 * it (its bundled Amazon Nova Pro and the models the owner added), so picking any listed model works as in the app.
 */
function knownModels(store?: MockStore): ListedModel[] {
  if (!store) return MODELS;
  const more = allModels(store).filter((m) => !MODELS.some((f) => f.key === m.key));
  return [...MODELS, ...more.map((m) => ({ key: m.key, label: m.label, efforts: [...m.efforts], defaultEffort: m.defaultEffort, provider: m.provider }))];
}

/**
 * What a call to a model records (§45.35 D5): the file's inference profile in Stockholm, else the model's own id in
 * its own Region (one the owner added); null for a model nobody knows.
 */
export function callOf(store: MockStore, key: string): { modelId: string; region: string } | null {
  const file = modelCall(key);
  if (file) return file;
  const m = allModels(store).find((x) => x.key === key);
  return m ? { modelId: m.modelId, region: m.custom?.region ?? AGENT_REGION } : null;
}

/**
 * Who wrote a storyboard, as meta.providers.writer records it (§45.36 E7): "bedrock-claude" only for an Anthropic
 * model, else "bedrock-model:{key}".
 */
export function writerOf(store: MockStore, key: string): string {
  const m = knownModels(store).find((x) => x.key === key);
  const maker = m?.provider ?? (MODELS.some((f) => f.key === key) ? "Anthropic" : "");
  return maker === "Anthropic" ? "bedrock-claude" : `bedrock-model:${key}`;
}

const DEFAULT_MODEL = (modelsFile as unknown as { defaultModel: string }).defaultModel;
const DEFAULT_EFFORT = (modelsFile as unknown as { defaultEffort: Effort }).defaultEffort;
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_WORD: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

/** The agent each task belongs to (CONTRACTS §45.26). */
export const TASK_AGENT: Record<TaskKind, AgentId> = {
  chat: "creative_director",
  brainstorm: "creative_director",
  expand_idea: "creative_director",
  variations: "creative_director",
  storyboard: "storyboard",
  scene_rewrite: "storyboard",
  captions: "storyboard",
  character_design: "character",
  reference_analysis: "video_analysis",
  fact_check: "quality_assurance",
  final_review: "quality_assurance",
  // §45.37 G5: short chat edits go with the chat; scene planning with the storyboard.
  text_edit: "creative_director",
  animation_plan: "storyboard",
};

export function modelLabel(key: string): string {
  return MODELS.find((m) => m.key === key)?.label ?? key;
}

/** A per-request pick the API refuses (unknown model, an effort the model does not offer) answers 400 with its sentence. */
export function checkOverride(o: ModelOverride | { model?: string | null; effort?: Effort | null } | undefined | null, store?: MockStore): void {
  if (!o) return;
  const models = knownModels(store);
  if (o.model && !models.some((m) => m.key === o.model)) fail(400, "bad_request", "We don't know that model. Pick one from the list.");
  if (o.effort && !EFFORTS.includes(o.effort)) fail(400, "bad_request", "Pick Low, Medium, High, Extra high or Maximum.");
  const m = o.model ? models.find((x) => x.key === o.model) : undefined;
  if (m && o.effort && m.efforts.length && !m.efforts.includes(o.effort)) fail(400, "bad_request", `${m.label} does not offer ${EFFORT_WORD[o.effort]}. Pick another level.`);
}

type Level = { model?: string | null; effort?: Effort | null } | null | undefined;

/**
 * The model and effort a call uses (CONTRACTS §45.25): the request's pick, then the video's own setting, the task's,
 * the agent's and the workspace default, model and effort merged separately. An effort the model does not offer
 * stops the call with its sentence; a model with no effort setting runs at its own level (effortApplied false).
 */
export function effectiveFor(
  store: MockStore,
  kind: TaskKind,
  o: { request?: Level; project?: Level } = {},
): { model: string; effort: Effort | null; effortApplied: boolean; agentId: AgentId; problem: string | null; off: string | null; denied: boolean } {
  const agentId = TASK_AGENT[kind];
  const agent = store.agents.find((a) => a.agentId === agentId);
  const off = agent && !agent.active ? `${agent.name} is switched off. Switch it on in Clips Funded › Settings › Agents.` : null;
  const ai = store.ai;
  const levels: Level[] = [o.request, o.project, ai?.tasks?.[kind], agent ? { model: agent.model, effort: agent.effort } : null, { model: ai?.defaultModel ?? DEFAULT_MODEL, effort: ai?.defaultEffort ?? DEFAULT_EFFORT }];
  const model = levels.find((l) => l?.model)?.model ?? DEFAULT_MODEL;
  const effort = levels.find((l) => l?.effort)?.effort ?? DEFAULT_EFFORT;
  const m = knownModels(store).find((x) => x.key === model);
  const applied = !!m && m.efforts.length > 0;
  let problem: string | null = null;
  if (!m) problem = `We don't know the model "${model}". Pick another model in Clips Funded › Settings › AI.`;
  else if (applied && !m.efforts.includes(effort)) problem = `${m.label} does not offer ${EFFORT_WORD[effort]}. Pick another level.`;
  const denied = Array.isArray(store.knobs.deniedModels) ? (store.knobs.deniedModels as string[]) : [];
  // Bedrock refusing the call itself (`denied`): the call was made, so the job records what it asked (§45.34).
  const refused = !problem && denied.includes(model);
  if (refused) problem = `${m?.label ?? modelLabel(model)} isn't available right now: Bedrock says this account can't use it yet. Pick another model in Clips Funded › Settings › AI, or try again.`;
  return { model, effort: applied ? effort : null, effortApplied: applied, agentId, problem, off, denied: refused };
}

interface TaskPlan {
  ws: string;
  runningAt: number;
  doneAt: number;
  /** null: it finishes; a sentence: it fails with it */
  fails: string | null;
  finish: () => Record<string, unknown>;
}

const plans = new WeakMap<MockStore, Map<string, TaskPlan>>();

function plansOf(store: MockStore): Map<string, TaskPlan> {
  let p = plans.get(store);
  if (!p) {
    p = new Map();
    plans.set(store, p);
  }
  return p;
}

/** The plain sentence a task fails with when its helper could not finish (§45.7). */
const TASK_FAILED: Partial<Record<TaskKind, string>> = {
  brainstorm: "The idea helper could not finish. Tap Try again.",
  expand_idea: "The idea helper could not finish. Tap Try again.",
  variations: "The idea helper could not finish. Tap Try again.",
  character_design: "The character helper could not finish. Tap Try again.",
};

/**
 * Starts one AI task in the practice app: the TASK# item at once (queued), running a moment later, then done with
 * `finish()`'s result (worked out at the end, as the agent writes it) or failed with its sentence. Other parts may
 * start their own tasks with it, and GET …/tasks/{id} (getTask) reads every task in the store.
 */
export function startMockTask(store: MockStore, ws: string, kind: TaskKind | "check_models", override: ModelOverride | undefined, finish: () => Record<string, unknown>, project?: Level): AiTask {
  checkOverride(override, store);
  const eff = effectiveFor(store, kind === "check_models" ? "chat" : kind, { request: override, project });
  const now = Date.now();
  const secs = Number(store.knobs.taskSeconds);
  const total = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2500;
  const knob = store.knobs.taskFail;
  let fails: string | null = eff.off ?? eff.problem;
  if (!fails && knob) {
    fails = typeof knob === "string" ? knob : (TASK_FAILED[kind as TaskKind] ?? "The helper stopped. Tap Try again.");
    store.knobs.taskFail = null;
  }
  // TASK# keeps exactly what was called (§45.35 D5); Check models has no single model.
  const call = kind === "check_models" ? null : callOf(store, eff.model);
  const task: AiTask = { taskId: mockId(), kind, status: "queued", model: eff.model, effort: eff.effort, effortApplied: eff.effortApplied, result: null, ...(call ?? {}), createdAt: iso(now), updatedAt: iso(now) };
  store.tasks.push(task);
  plansOf(store).set(task.taskId, { ws, runningAt: now + Math.min(400, total / 4), doneAt: now + total, fails, finish });
  // The agent finishes its work whether or not anyone is watching (an expanded idea gets its concept).
  setTimeout(() => settleTasks(store), total + 20);
  return clone(task);
}

/** Moves every planned task on to where its time says it is. */
export function settleTasks(store: MockStore, now = Date.now()): void {
  for (const [id, plan] of plansOf(store)) {
    const task = store.tasks.find((t) => t.taskId === id);
    if (!task || task.status === "done" || task.status === "failed") continue;
    if (now >= plan.doneAt) {
      if (plan.fails) {
        task.status = "failed";
        task.error = plan.fails;
      } else {
        try {
          task.result = plan.finish();
          task.status = "done";
        } catch (e) {
          task.status = "failed";
          task.error = e instanceof Error && e.message ? e.message : "The helper stopped. Tap Try again.";
        }
      }
      task.updatedAt = iso(now);
    } else if (now >= plan.runningAt && task.status === "queued") {
      task.status = "running";
      task.updatedAt = iso(now);
    }
  }
}

const CATEGORIES: IdeaCategory[] = ["driving_safety", "everyday_skills", "comedy", "explainer"];

function checkInput(i: Partial<IdeaInput>, whole: boolean): void {
  if (whole || i.title !== undefined) {
    const t = (i.title ?? "").trim();
    if (!t) fail(400, "bad_request", "Give the idea a title.");
    if (t.length > 80) fail(400, "bad_request", "Keep the title to 80 letters.");
  }
  if (whole || i.logline !== undefined) {
    const l = (i.logline ?? "").trim();
    if (!l) fail(400, "bad_request", "Write one line about what happens.");
    if (l.length > 280) fail(400, "bad_request", "Keep the line to 280 letters.");
  }
  if ((whole || i.category !== undefined) && !CATEGORIES.includes(i.category as IdeaCategory)) fail(400, "bad_request", "Pick a kind of video.");
  if (i.characterIds && i.characterIds.length > 3) fail(400, "bad_request", "Pick up to 3 characters.");
  if (i.concept !== undefined) checkConcept(i.concept);
}

/** A VideoConcept, checked like the API's ideas.concept (§45.6): the owner can edit every part (§45.34). */
function checkConcept(c: VideoConcept): void {
  if (!c || typeof c !== "object") fail(400, "bad_request", "concept must be a full idea.");
  for (const k of Object.keys(c)) if (!["premise", "beats", "lesson", "ending", "tone", "durationSec", "onScreenText"].includes(k)) fail(400, "bad_request", "Something in that request was not right.");
  if (!["funny", "calm", "tense_then_relief", "wholesome"].includes(c.tone)) fail(400, "bad_request", "concept.tone must be funny, calm, tense_then_relief or wholesome.");
  if (typeof c.premise !== "string" || !c.premise.trim() || c.premise.length > 600) fail(400, "bad_request", "concept.premise needs 1 to 600 characters.");
  const beats = Array.isArray(c.beats) ? c.beats.filter((b) => typeof b === "string" && b.trim()) : [];
  if (beats.length < 3 || beats.length > 8) fail(400, "bad_request", "concept.beats needs 3 to 8 lines.");
  if (beats.some((b) => b.length > 160)) fail(400, "bad_request", "Each line of concept.beats can be at most 160 characters.");
  if (c.lesson !== null && c.lesson !== undefined && (typeof c.lesson !== "string" || c.lesson.length > 280)) fail(400, "bad_request", "concept.lesson can be at most 280 characters.");
  if (typeof c.ending !== "string" || !c.ending.trim() || c.ending.length > 280) fail(400, "bad_request", "concept.ending needs 1 to 280 characters.");
  if (!Number.isInteger(c.durationSec) || c.durationSec < 15 || c.durationSec > 90) fail(400, "bad_request", "concept.durationSec must be 15 to 90.");
  const words = Array.isArray(c.onScreenText) ? c.onScreenText.filter((t) => typeof t === "string" && t.trim()) : [];
  if (words.length > 6) fail(400, "bad_request", "concept.onScreenText needs 0 to 6 lines.");
  if (words.some((t) => t.length > 60)) fail(400, "bad_request", "Each line of concept.onScreenText can be at most 60 characters.");
}

/** The API's topic match (§45.7): only driving-safety ideas get a topic; with none they need checked advice. */
function matchSafety(idea: Pick<Idea, "title" | "logline" | "category">): { safetyTopicId: string | null; needsGuidance: boolean } {
  if (idea.category !== "driving_safety") return { safetyTopicId: null, needsGuidance: false };
  const id = topicFor(`${idea.title} ${idea.logline}`);
  return { safetyTopicId: id, needsGuidance: !id };
}

/** The idea's lead: its first person (a car never stars alone, §45.43), else the workspace's first person. */
function leadName(store: MockStore, ws: string, idea?: Pick<IdeaInput, "characterIds">): string {
  const chars = store.characters.filter((c) => c.workspaceId === ws && c.kind !== "car");
  const picked = idea?.characterIds?.map((id) => chars.find((c) => c.characterId === id)).find(Boolean);
  return picked?.name ?? chars[0]?.name ?? "Pip";
}

/** A series' drafts (§45.44): filed in it, with its cast when a draft has none (the API's _task_result). */
function inSeries(store: MockStore, ws: string, seriesId: string | undefined, drafts: IdeaInput[]): IdeaInput[] {
  const series = seriesId ? store.series.find((x) => x.seriesId === seriesId && x.workspaceId === ws) : undefined;
  if (!series) return drafts;
  const cast = series.castIds.filter((id) => store.characters.some((c) => c.characterId === id));
  return drafts.map((d) => ({ ...d, seriesId: series.seriesId, ...(!d.characterIds?.length && cast.length ? { characterIds: [...cast] } : {}) }));
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The "idea helper" in the practice app: plain drafts from a topic and a kind, no network. */
function draftsFor(store: MockStore, ws: string, topic: string, category: IdeaCategory | undefined, count: number, castIds?: string[]): IdeaInput[] {
  const lead = leadName(store, ws, castIds ? { characterIds: castIds } : undefined);
  const t = topic.trim();
  const kinds = category ? [category] : CATEGORIES;
  const out: IdeaInput[] = [];
  const safetyTopics = (() => {
    const matched = t ? topicFor(t) : null;
    const rest = TOPICS.map((x) => x.id).filter((id) => id !== matched);
    return matched ? [matched, ...rest] : rest;
  })();
  let s = 0;
  for (let i = 0; out.length < count; i += 1) {
    const kind = kinds[i % kinds.length]!;
    const n = Math.floor(i / kinds.length);
    if (kind === "driving_safety") {
      const id = safetyTopics[s % safetyTopics.length]!;
      s += 1;
      const first = shownSteps(id)[0]?.text ?? "Stay calm.";
      out.push({ title: shortTopicTitle(id), logline: `${lead} learns what to do. ${first}`.slice(0, 280), category: kind, source: "ai" });
      continue;
    }
    const subject = t || ["a picnic", "a rainy day", "a new bike", "a lost sock", "a birthday cake", "a big move"][(i + n) % 6]!;
    const bank: Record<Exclude<IdeaCategory, "driving_safety">, { title: string; logline: string }[]> = {
      comedy: [
        { title: `${lead} and ${subject}`, logline: `${lead} has a big plan for ${subject}. It goes wrong in the funniest way, then right.` },
        { title: `The ${subject} mix-up`, logline: `${lead} mixes everything up with ${subject} and has to fix it before anyone sees.` },
        { title: `${cap(subject)} goes wobbly`, logline: `Nothing about ${subject} goes to plan, and ${lead} keeps smiling anyway.` },
      ],
      everyday_skills: [
        { title: `${cap(subject)} made easy`, logline: `${lead} shows the easy way to handle ${subject}, one small step at a time.` },
        { title: `${lead} gets ready for ${subject}`, logline: `${lead} makes a little list for ${subject} and ticks every box.` },
        { title: `Three tricks for ${subject}`, logline: `${lead} tries three handy tricks for ${subject} and picks the best one.` },
      ],
      explainer: [
        { title: `How ${subject} works`, logline: `${lead} opens up ${subject} to show what happens inside, step by step.` },
        { title: `Why ${subject}?`, logline: `${lead} wonders about ${subject} and finds the simple answer.` },
        { title: `${cap(subject)}, step by step`, logline: `${lead} builds ${subject} one piece at a time so anyone can follow.` },
      ],
    };
    const pick = bank[kind][n % 3]!;
    out.push({ title: pick.title.slice(0, 80), logline: pick.logline.slice(0, 280), category: kind, source: "ai" });
  }
  return out;
}

/** "Make it a full idea": the concept, keeping the title (§45.7). */
function conceptFor(store: MockStore, idea: Idea, durationSec: number): VideoConcept {
  const lead = leadName(store, idea.workspaceId, idea);
  if (idea.category === "driving_safety" && idea.safetyTopicId) {
    const steps = shownSteps(idea.safetyTopicId);
    const short = steps.filter((st) => st.text.length <= 60);
    return {
      premise: `${lead} is out driving when something tricky happens: ${shortTopicTitle(idea.safetyTopicId).toLowerCase()}.`,
      beats: [`${lead} drives along, humming a happy tune.`, "Uh oh! The trouble starts.", ...steps.slice(0, 4).map((st) => st.text), `${lead} is safe and gives a big thumbs up.`].slice(0, 8),
      lesson: steps[0]?.text ?? null,
      ending: "Phew! Safe and sound. Check your local road rules.",
      tone: "tense_then_relief",
      durationSec,
      onScreenText: short.slice(0, 5).map((st) => st.text),
    };
  }
  const tone: VideoConcept["tone"] = idea.category === "comedy" ? "funny" : idea.category === "explainer" ? "calm" : "wholesome";
  return {
    premise: idea.logline,
    beats: [`${lead} has a plan.`, `${lead} gets started, full of beans.`, "Something unexpected happens!", `${lead} thinks hard and tries again.`, "It works, and everyone cheers."],
    lesson: idea.category === "comedy" ? null : "Take it one small step at a time.",
    ending: `${lead} takes a little bow.`,
    tone,
    durationSec,
    onScreenText: idea.category === "comedy" ? [] : ["One small step at a time", "You've got this!"],
  };
}

function out(idea: Idea): Idea {
  return clone(idea);
}

function find(store: MockStore, ws: string, ideaId: string): Idea {
  const idea = store.ideas.find((i) => i.ideaId === ideaId && i.workspaceId === ws);
  if (!idea) fail(404, "not_found", "We could not find that idea. It may have been deleted.");
  return idea;
}

function make(store: MockStore, ws: string, input: IdeaInput, at: number): Idea {
  const base = { title: input.title.trim(), logline: input.logline.trim(), category: input.category };
  const { seriesId, ...fields } = input;
  const idea: Idea = {
    ...fields,
    ...(seriesId ? { seriesId } : {}),
    ...base,
    ideaId: mockId(),
    workspaceId: ws,
    status: "saved",
    ...matchSafety(base),
    storyIds: [],
    source: input.source ?? "manual",
    createdAt: iso(at),
    updatedAt: iso(at),
  };
  return idea;
}

export function seed(store: MockStore): void {
  const ws = "stories";
  const now = Date.now();
  const day = 86_400_000;
  const add = (id: string, input: IdeaInput, ageDays: number, extra: Partial<Idea> = {}) => {
    const idea = make(store, ws, input, now - ageDays * day);
    idea.ideaId = id;
    Object.assign(idea, extra);
    store.ideas.push(idea);
    return idea;
  };
  const skid = add(SEED_IDS.ideas.skid, { title: "When the car starts to slide", logline: "Pip hits black ice and the car starts sliding. Pip stays calm and steers out of it.", category: "driving_safety", characterIds: [SEED_IDS.characters.pip], source: "ai" }, 9, { status: "used", storyIds: [SEED_IDS.stories.review] });
  skid.concept = conceptFor(store, skid, 45);
  add(SEED_IDS.ideas.fog, { title: "Foggy morning drive", logline: "Nana Rose drives through thick fog and shows how to see and be seen.", category: "driving_safety", characterIds: [SEED_IDS.characters.nana], source: "manual" }, 8, { status: "used", storyIds: [SEED_IDS.stories.needsCheck] });
  add(SEED_IDS.ideas.shoes, { title: "Bolt ties his shoes", logline: "Bolt keeps tripping on his laces until he learns the bunny-ears trick.", category: "everyday_skills", characterIds: [SEED_IDS.characters.bolt], source: "manual" }, 7, { status: "used", storyIds: [SEED_IDS.stories.approved] });
  add(SEED_IDS.ideas.sandwich, { title: "The sandwich tower", logline: "Pip builds the tallest sandwich ever. Dash wants a bite. The tower wobbles.", category: "comedy", characterIds: [SEED_IDS.characters.pip, SEED_IDS.characters.dash], source: "ai" }, 6, { status: "used", storyIds: [SEED_IDS.stories.published, SEED_IDS.stories.rejected] });
  add(SEED_IDS.ideas.tractor, { title: "Overtaking a tractor", logline: "Dash is stuck behind a slow tractor on a narrow lane and wants to get past.", category: "driving_safety", characterIds: [SEED_IDS.characters.dash], source: "manual" }, 3);
  add(SEED_IDS.ideas.gps, { title: "Nana Rose and the sleepy GPS", logline: "Nana Rose's GPS keeps falling asleep, so she finds her way with a paper map and a song.", category: "comedy", characterIds: [SEED_IDS.characters.nana], source: "ai" }, 2);
  add(SEED_IDS.ideas.rainbow, { title: "How a rainbow is made", logline: "Bolt chases a rainbow and finds out it's sunlight bending through raindrops.", category: "explainer", source: "manual" }, 1);
  add(SEED_IDS.ideas.deer, { title: "A deer on the road", logline: "A deer jumps out in front of Pip's car on a country road at dusk.", category: "driving_safety", characterIds: [SEED_IDS.characters.pip], source: "ai" }, 0.5);
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async listIdeas(ws, status = "all") {
      guardWs(store, ws);
      await delay(120);
      return store.ideas
        .filter((i) => i.workspaceId === ws && (status === "all" || i.status === status))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(out);
    },
    async createIdea(ws, input) {
      guardWs(store, ws);
      checkInput(input, true);
      await delay(160);
      // a series that is gone is dropped: the idea is kept, under No series (§45.44)
      const filed = input.seriesId && !seriesExists(store, ws, input.seriesId) ? { ...input, seriesId: undefined } : input;
      const idea = make(store, ws, filed, Date.now());
      store.ideas.push(idea);
      return out(idea);
    },
    async patchIdea(ws, ideaId, patch) {
      guardWs(store, ws);
      checkInput(patch, false);
      await delay(140);
      const idea = find(store, ws, ideaId);
      const { seriesId, ...rest } = clone(patch);
      Object.assign(idea, rest);
      // null: No series; a series that is gone leaves the idea where it is (§45.44)
      if (seriesId === null) delete idea.seriesId;
      else if (seriesId && seriesExists(store, ws, seriesId)) idea.seriesId = seriesId;
      Object.assign(idea, matchSafety(idea), { updatedAt: iso() });
      return out(idea);
    },
    async deleteIdea(ws, ideaId) {
      guardWs(store, ws);
      await delay(120);
      find(store, ws, ideaId);
      store.ideas = store.ideas.filter((i) => i.ideaId !== ideaId);
    },
    async generateIdeas(ws, body) {
      guardWs(store, ws);
      const count = body.count ?? 4;
      if (!Number.isInteger(count) || count < 1 || count > 6) fail(400, "bad_request", "Ask for 1 to 6 ideas.");
      if ((body.topic ?? "").length > 200) fail(400, "bad_request", "Keep the topic to 200 letters.");
      if (body.category && !CATEGORIES.includes(body.category)) fail(400, "bad_request", "Pick a kind of video.");
      if (body.seriesId && !seriesExists(store, ws, body.seriesId)) fail(404, "not_found", "That series is gone.");
      checkOverride(body.override, store);
      await delay(160);
      const topic = body.topic ?? "";
      const category = body.category;
      const cast = store.series.find((x) => x.seriesId === body.seriesId)?.castIds;
      // Nothing is saved: the owner taps Save on each draft.
      return startMockTask(store, ws, "brainstorm", body.override, () => ({
        drafts: inSeries(store, ws, body.seriesId, draftsFor(store, ws, topic, category, count, cast)),
      }));
    },
    async expandIdea(ws, ideaId, body) {
      guardWs(store, ws);
      const idea = find(store, ws, ideaId);
      const durationSec = body?.durationSec ?? 45;
      if (durationSec < 15 || durationSec > 90) fail(400, "bad_request", "Pick a length from 15 to 90 seconds.");
      if (idea.needsGuidance)
        fail(409, "conflict", "Clips Funded only makes driving-safety videos from checked advice, and this one isn't in the list yet.");
      checkOverride(body?.override, store);
      await delay(160);
      // The finished task writes `concept` on the idea (keeping its title) and returns the idea.
      return startMockTask(store, ws, "expand_idea", body?.override, () => {
        const now = store.ideas.find((i) => i.ideaId === ideaId && i.workspaceId === ws);
        if (!now) throw new Error("That idea was deleted while the helper worked on it.");
        now.concept = conceptFor(store, now, durationSec);
        now.updatedAt = iso();
        return { idea: out(now) };
      });
    },
    async ideaVariations(ws, ideaId, body) {
      guardWs(store, ws);
      const idea = find(store, ws, ideaId);
      const count = body?.count ?? 3;
      if (!Number.isInteger(count) || count < 1 || count > 4) fail(400, "bad_request", "Ask for 1 to 4 more ideas.");
      checkOverride(body?.override, store);
      await delay(160);
      // Never "faster" or "riskier" for driving: nothing dangerous for fun (§45.7).
      const twists =
        idea.category === "driving_safety"
          ? ([
              ["at night", "It happens after dark, with only the headlights on."],
              ["with a passenger", "A friend is in the car and gets a fright too."],
              ["the calm way", "This time we see each step slowly, one at a time."],
              ["the next day", "The next day it happens again, and now they know what to do."],
            ] as const)
          : ([
              ["at night", "It all happens after dark, with only the street lights on."],
              ["with a friend", "This time a friend comes along and makes it twice as tricky."],
              ["in a hurry", "Everything has to happen fast, and that makes it funnier."],
              ["the next day", "The next day it happens again, but now they know the trick."],
            ] as const);
      const base = clone(idea);
      return startMockTask(store, ws, "variations", body?.override, () => ({
        drafts: twists.slice(0, count).map(([t, line]) => ({
          title: `${base.title}: ${t}`.slice(0, 80),
          logline: `${line} ${base.logline}`.slice(0, 280),
          category: base.category,
          ...(base.characterIds ? { characterIds: [...base.characterIds] } : {}),
          source: "variation" as const,
          parentIdeaId: base.ideaId,
        })),
      }));
    },
    async getTask(ws, taskId) {
      guardWs(store, ws);
      settleTasks(store);
      await delay(80);
      settleTasks(store);
      const plan = plansOf(store).get(taskId);
      const task = store.tasks.find((t) => t.taskId === taskId);
      if (!task || (plan && plan.ws !== ws)) fail(404, "not_found", "We could not find that task. It may have finished long ago.");
      return clone(task);
    },
  };
}
