// Lamo Stories mock: the chat part (docs/CONTRACTS.md §45.16.8, §45.27). Conversations and their messages live in
// the shared store; a pretend creative director "streams" its answer a few words at a time (the real one runs in Lamo
// Stories' own agent and writes into the message as it streams) and ends with one button the owner may tap. The
// model and effort of every message follow the same rules as the API (§45.25: request > conversation > task >
// agent > workspace default, model and effort merged separately, an effort the model does not offer refused, never
// swapped), checked against stories/config/resolve-cases.json in test/storiesChatMock.test.ts. Builder H owns it.
//
// Test knobs (store.knobs, also window.__cfStoriesMock.store.knobs): chatChunkMs (time per streamed piece, default
// 350), chatThinkMs (before the first words, default 700), chatFail (the next answer fails with this sentence),
// chatDenied (model keys whose calls are refused: the answer fails with the model's sentence, never another model),
// longChat (a number: a third chat with that many messages, to page back with "Show earlier messages").
//
// GET …/chat/{convId} answers the newest SHOWN (500) messages, oldest first, as the API does (§45.34): `after` only the
// newer ones (the poll), `before` the SHOWN older ones.
import modelsFile from "../../../../../stories/config/models.json";
import { ApiError } from "../../../api/errors.ts";
import type {
  AgentId,
  CharacterInput,
  ChatAction,
  Conversation,
  Effective,
  Effort,
  IdeaInput,
  Message,
  ModelOverride,
  ProjectRef,
  StoriesApi,
  TaskKind,
  Upload,
} from "../types.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["listConversations", "createConversation", "getConversation", "patchConversation", "deleteConversation", "sendMessage", "chatAttachment", "stopMessage"] as const;

// ---------- Models and the resolver (the API's rules, §45.25) ----------

interface FileModel {
  key: string;
  label: string;
  efforts: string[];
  vision: boolean;
  modelId?: string;
  /** the inference profile the agent calls */
  profile?: string;
}

export const MODELS = (modelsFile.models as FileModel[]).map((m) => ({ key: m.key, label: m.label, efforts: m.efforts as Effort[], vision: m.vision }));

/** Where Lamo Stories' own agent runs (Stockholm): a bundled model is called there, through its inference profile. */
export const AGENT_REGION = "eu-north-1";

/**
 * What a call really sends to Amazon Bedrock for a bundled model (§45.35 D5): its inference profile (else its model
 * id) and the Region, as the agent records them in meta.models, TASK# and MSG#; null for a key the list does not know.
 */
export function modelCall(key: string): { modelId: string; region: string } | null {
  const m = (modelsFile.models as FileModel[]).find((x) => x.key === key);
  if (!m) return null;
  return { modelId: m.profile || m.modelId || m.key, region: AGENT_REGION };
}
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_WORD: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

export interface Level {
  model?: string | null;
  effort?: string | null;
}

export type Resolved = Effective | { error: "model" | "effort"; sentence: string };

/**
 * The effective model and effort of one call. `project` is a conversation's (chat turns) or a video's or
 * reference's own setting; both are level 2.
 */
export function resolve(levels: {
  request?: Level | null;
  conversation?: Level | null;
  project?: Level | null;
  task?: Level | null;
  agent?: Level | null;
  ai?: { defaultModel?: string; defaultEffort?: string } | null;
}): Resolved {
  const order: [Effective["from"], Level | null | undefined][] = [
    ["request", levels.request],
    ["conversation", levels.conversation],
    ["project", levels.project],
    ["task", levels.task],
    ["agent", levels.agent],
    ["default", { model: levels.ai?.defaultModel ?? modelsFile.defaultModel, effort: levels.ai?.defaultEffort ?? modelsFile.defaultEffort }],
  ];
  let model: string | null = null;
  let from: Effective["from"] = "default";
  let effort: string | null = null;
  for (const [name, l] of order) {
    if (model === null && l?.model) {
      model = l.model;
      from = name;
    }
    if (effort === null && l?.effort) effort = l.effort;
  }
  const info = MODELS.find((m) => m.key === model);
  if (!info) return { error: "model", sentence: "We don't know that model. Pick one from the list." };
  if (effort !== null && !(EFFORTS as string[]).includes(effort)) return { error: "effort", sentence: "Pick Low, Medium, High, Extra high or Maximum." };
  if (!info.efforts.length) return { model: info.key, effort: null, effortApplied: false, from };
  if (effort !== null && !info.efforts.includes(effort as Effort)) return { error: "effort", sentence: `${info.label} does not offer ${EFFORT_WORD[effort as Effort]}. Pick another level.` };
  return { model: info.key, effort: (effort as Effort | null) ?? null, effortApplied: true, from };
}

/** The levels below a conversation or a project for one task: the task's own (Settings › AI), its agent's, the default. */
export function lowerLevels(store: MockStore, task: TaskKind, agentId: AgentId): { task: Level | null; agent: Level | null; ai: { defaultModel?: string; defaultEffort?: string } | null; agentOff: string | null } {
  const ai = store.ai;
  const agent = store.agents.find((a) => a.agentId === agentId) ?? null;
  return {
    task: ai?.tasks?.[task] ?? null,
    agent: agent ? { model: agent.model, effort: agent.effort } : null,
    ai: ai ? { defaultModel: ai.defaultModel, defaultEffort: ai.defaultEffort } : null,
    agentOff: agent && !agent.active ? `${agent.name} is switched off. Switch it on in Lamo Stories › Settings › Agents.` : null,
  };
}

export function modelWord(key: string | null): string {
  return MODELS.find((m) => m.key === key)?.label ?? key ?? "That model";
}

// ---------- Small helpers ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRand = 0;
/** A ULID-shaped id that always sorts after the previous one. */
export function newId(now = Date.now()): string {
  let t = Math.max(now, lastTime);
  if (t === lastTime) lastRand += 1;
  else lastRand = Math.floor(Math.random() * 2 ** 30);
  lastTime = t;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  let r = lastRand;
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[r % 32]! + rand;
    r = Math.floor(r / 32);
  }
  return time + rand;
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** The workspace must be a Lamo Stories one (the API's 404 / 409). Before the workspace part seeds, only "stories". */
export function checkWs(store: MockStore, ws: string): void {
  const found = store.workspaces.find((w) => w.workspaceId === ws);
  if (store.workspaces.length ? !found : ws !== "stories") throw new ApiError(404, "not_found", "We could not find that workspace.");
  if (found && found.workspaceType !== "stories") throw new ApiError(409, "conflict", "That is a Lamo Stories page. Switch to Lamo Stories first.");
}

const bad = (message: string, field?: string) => new ApiError(400, "bad_request", message, field);

// ---------- What the store keeps beside the shared lists ----------

interface Streaming {
  start: number;
  chunks: string[];
  actions: ChatAction[];
  fail: string | null;
  memory: string | null;
}

interface ChatState {
  /** convId → workspace */
  owner: Map<string, string>;
  /** msgId → the answer being "written" */
  streams: Map<string, Streaming>;
  /** assetId → the picture's conversation and type (uploaded, not yet sent) */
  pictures: Map<string, { convId: string; contentType: string }>;
}

const states = new WeakMap<MockStore, ChatState>();
function state(store: MockStore): ChatState {
  let s = states.get(store);
  if (!s) {
    s = { owner: new Map(), streams: new Map(), pictures: new Map() };
    states.set(store, s);
  }
  return s;
}

// ---------- Seed ----------

export const SEED_IDS = {
  conversations: { winter: "01JSTCV0000000000000000001", hooks: "01JSTCV0000000000000000002", long: "01JSTCV0000000000000000003" },
  messages: { ask: "01JSTMS0000000000000000001", answer: "01JSTMS0000000000000000002", ask2: "01JSTMS0000000000000000003", answer2: "01JSTMS0000000000000000004" },
};

const HOUR = 3600_000;

/** How many messages one GET answers (the API's SHOWN). */
export const SHOWN = 500;

export function seed(store: MockStore): void {
  const s = state(store);
  const now = Date.now();
  const c1: Conversation = {
    convId: SEED_IDS.conversations.winter,
    title: "Winter ideas for Pip",
    model: null,
    effort: null,
    effective: { model: "opus-5-5", effort: "high", effortApplied: true, from: "default" },
    projectRef: null,
    lastMessageAt: iso(now - 2 * HOUR),
    createdAt: iso(now - 3 * HOUR),
    updatedAt: iso(now - 2 * HOUR),
  };
  const c2: Conversation = {
    convId: SEED_IDS.conversations.hooks,
    title: "What makes a good hook",
    model: "sonnet-5-5",
    effort: "medium",
    effective: { model: "sonnet-5-5", effort: "medium", effortApplied: true, from: "conversation" },
    projectRef: null,
    lastMessageAt: iso(now - 30 * HOUR),
    createdAt: iso(now - 31 * HOUR),
    updatedAt: iso(now - 30 * HOUR),
  };
  store.conversations.push(c1, c2);
  s.owner.set(c1.convId, "stories");
  s.owner.set(c2.convId, "stories");
  const msg = (id: string, convId: string, role: Message["role"], text: string, at: number, extra: Partial<Message> = {}): Message => {
    const m: Message = {
      msgId: id,
      convId,
      role,
      text,
      attachments: [],
      status: "done",
      model: role === "assistant" ? "opus-5-5" : null,
      effort: role === "assistant" ? "high" : null,
      effortApplied: role === "assistant" ? true : null,
      usage: role === "assistant" ? { input: 1840, output: 212 } : null,
      actions: [],
      createdAt: iso(at),
      ...extra,
    };
    // An answer says exactly what it was asked with and what was called (§45.35 D4, D5).
    return role === "assistant" && m.model ? { ...m, requested: null, ...(modelCall(m.model) ?? {}) } : m;
  };
  store.messages.push(
    msg(SEED_IDS.messages.ask, c1.convId, "user", "Give me a winter idea for Pip. Something funny on ice, no words.", now - 2 * HOUR - 60_000),
    msg(
      SEED_IDS.messages.answer,
      c1.convId,
      "assistant",
      "Here is one:\n\n**Pip and the slippery doorstep**\n- Pip steps out with a hot drink, sees the ice and freezes.\n- Tiny careful steps, arms out like a penguin.\n- A cat glides past on the ice like a pro; Pip copies it and spins.\n- Ends sitting safely on a mat, drink still full, a proud grin.",
      now - 2 * HOUR,
      { actions: [{ kind: "save_idea", label: "Save this idea", payload: { idea: { title: "Pip and the slippery doorstep", logline: "Pip copies a cat to cross an icy doorstep and somehow keeps the drink full.", category: "comedy" } } }] },
    ),
    msg(SEED_IDS.messages.ask2, c2.convId, "user", "What makes a good hook in the first two seconds?", now - 30 * HOUR - 60_000),
    msg(SEED_IDS.messages.answer2, c2.convId, "assistant", "Show the problem before anything else: a face that changes, a thing about to fall, a sound that surprises. Then hold it for half a second so the eye can catch up.", now - 30 * HOUR, {
      model: "sonnet-5-5",
      effort: "medium",
    }),
  );
  store.knobs.chatChunkMs = store.knobs.chatChunkMs ?? 350;
  store.knobs.chatThinkMs = store.knobs.chatThinkMs ?? 700;
  const long = Number(store.knobs.longChat);
  if (Number.isInteger(long) && long > 0) seedLongChat(store, Math.min(long, 2000), now);
}

/** A chat longer than one GET answers (knob longChat), so "Show earlier messages" has something to show. */
function seedLongChat(store: MockStore, n: number, now: number): void {
  const at0 = now - 50 * HOUR;
  const conv: Conversation = {
    convId: SEED_IDS.conversations.long,
    title: "A very long chat",
    model: null,
    effort: null,
    effective: { model: "opus-5-5", effort: "high", effortApplied: true, from: "default" },
    projectRef: null,
    lastMessageAt: iso(at0 + n * 60_000),
    createdAt: iso(at0),
    updatedAt: iso(at0 + n * 60_000),
  };
  store.conversations.push(conv);
  state(store).owner.set(conv.convId, "stories");
  for (let i = 0; i < n; i += 1) {
    const at = at0 + i * 60_000;
    const user = i % 2 === 0;
    store.messages.push({
      msgId: newId(at),
      convId: conv.convId,
      role: user ? "user" : "assistant",
      text: user ? `Question number ${i + 1}` : `Answer number ${i + 1}`,
      attachments: [],
      status: "done",
      model: user ? null : "opus-5-5",
      effort: user ? null : "high",
      effortApplied: user ? null : true,
      usage: user ? null : { input: 120, output: 40 },
      actions: [],
      createdAt: iso(at),
    });
  }
}

// ---------- The pretend creative director ----------

const PIP_LOOK: CharacterInput["look"] = {
  body: "round",
  skin: "#F6C7A1",
  height: 0.95,
  width: 1.05,
  hair: { style: "spiky", color: "#3B2A20" },
  eyes: { shape: "round", color: "#2B2B2B" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: "#47D6A0", bottom: "#2E3A6B", accent: "#FFC94A", pattern: "stripes" },
  accessory: "scarf",
  outline: "#1C1842",
};

/** What the pretend director answers: words, and at most one button. Deterministic, so tests can expect it. */
export function answerFor(store: MockStore, text: string, project: ProjectRef | null): { text: string; actions: ChatAction[]; memory: string | null } {
  const t = text.toLowerCase();
  const remember = /\bremember\b(?: that)?\s*(.*)$/i.exec(text);
  if (remember && remember[1]?.trim()) {
    const fact = remember[1].trim().replace(/[.!]+$/, "").slice(0, 300);
    return { text: `Got it. I'll remember: "${fact}". You can see and change what I remember in Settings › Memory.`, actions: [{ kind: "open", label: "See what I remember", payload: { href: "/stories/settings/memory" } }], memory: fact };
  }
  if (/character|someone new|hero/.test(t)) {
    const character: CharacterInput = {
      name: "Skid",
      description: "A small round courier with a big scarf who is always in a hurry.",
      personality: "Eager, a bit clumsy, never gives up, laughs at his own mistakes.",
      traits: ["eager", "clumsy", "kind"],
      movementStyle: "zippy",
      expressions: ["neutral", "happy", "surprised", "worried", "determined", "relieved"],
      look: PIP_LOOK,
      voice: { style: "babble", pitch: 1.3, noises: ["whoa", "oops", "yay"], sfx: ["whoosh", "boing"] },
    };
    return {
      text: "Meet **Skid**: a round little courier with a huge striped scarf. He zips everywhere, skids at every corner and always makes it just in time. His faces do the talking: wide eyes when he slips, a proud grin when he lands it.",
      actions: [{ kind: "save_character", label: "Save this character", payload: { character } }],
      memory: null,
    };
  }
  const ref = project?.kind === "reference" ? store.references.find((r) => r.refId === project.id) : /reference|analy/.test(t) ? store.references.find((r) => r.status === "ready") : undefined;
  if (ref && ref.status === "ready")
    return {
      text: `I haven't looked at "${ref.title}" yet. Tap the button and the video analysis agent studies its shots, timing and jokes. Then I can tell you what to borrow.`,
      actions: [{ kind: "analyze_reference", label: "Analyze this reference video", payload: { refId: ref.refId } }],
      memory: null,
    };
  const story = project?.kind === "story" ? store.stories.find((x) => x.storyId === project.id) : undefined;
  if (story && /change|slower|faster|funnier|shorter|longer/.test(t))
    return {
      text: "Good idea. I'd slow the middle down and give the landing one more beat. Tap the button and the writer makes these changes; you check them in Review.",
      // The agent's propose_story_change for the whole story: a note and no scenes.
      actions: [{ kind: "remake_scene", label: "Make these changes", payload: { storyId: story.storyId, sceneIds: [], note: text.slice(0, 500) } }],
      memory: null,
    };
  if (/video|make it|let's make|film/.test(t)) {
    const cast = store.characters.slice(0, 1).map((c) => c.characterId);
    return {
      text: "Here is a short plan:\n1. Pip spots the icy path and stops.\n2. Tiny penguin steps, arms out.\n3. A slide, a spin, a soft landing on the mat.\n4. A proud grin to the camera.\n\nTap the button and Production opens with it filled in. Nothing is made until you tap Make the video there.",
      // The agent's own shape (offer_make_video): { story: StoryInput }.
      actions: [
        {
          kind: "make_video",
          label: "Make the video",
          payload: { story: { characterIds: cast, brief: { title: "Pip and the icy path", logline: "Pip crosses an icy path with penguin steps and lands safely on the mat.", category: "comedy" }, durationSec: 40 } },
        },
      ],
      memory: null,
    };
  }
  const idea: IdeaInput = { title: "The snowman who wanted a hat", logline: "A snowman keeps losing his hat to the wind and finally trades it for a bird's nest.", category: "comedy" };
  return {
    text: "Three quick ones:\n- **The snowman who wanted a hat**: the wind keeps stealing it; a bird's nest wins in the end.\n- **Slow and steady**: two friends cross a frozen pond, the careful one gets there first.\n- **Hot cocoa rescue**: a tiny spill turns into a sliding chase across the kitchen.\n\nWant me to save the first one?",
    actions: [{ kind: "save_idea", label: "Save this idea", payload: { idea } }],
    memory: null,
  };
}

/** Cuts an answer into the pieces the pretend stream adds, a few words at a time. */
export function pieces(text: string): string[] {
  const words = text.split(/(?<=\s)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 4) out.push(words.slice(i, i + 4).join(""));
  return out;
}

/** Moves every answer on to where its time says it is (each read calls this). */
export function advance(store: MockStore, now = Date.now()): void {
  const s = state(store);
  const chunkMs = Number(store.knobs.chatChunkMs ?? 350);
  const thinkMs = Number(store.knobs.chatThinkMs ?? 700);
  for (const [msgId, st] of s.streams) {
    const m = store.messages.find((x) => x.msgId === msgId);
    if (!m || (m.status !== "pending" && m.status !== "streaming")) {
      s.streams.delete(msgId);
      continue;
    }
    const elapsed = now - st.start;
    if (elapsed < thinkMs) continue;
    if (st.fail) {
      m.status = "failed";
      m.error = st.fail;
      m.usage = null;
      s.streams.delete(msgId);
      continue;
    }
    const n = Math.min(st.chunks.length, 1 + Math.floor((elapsed - thinkMs) / chunkMs));
    m.text = st.chunks.slice(0, n).join("");
    m.status = n >= st.chunks.length ? "done" : "streaming";
    if (m.status === "done") {
      m.text = m.text.trimEnd();
      m.actions = st.actions;
      m.usage = { input: 1200 + m.text.length, output: Math.ceil(m.text.length / 4) };
      if (st.memory) {
        const at = iso(now);
        store.memory.unshift({ memId: newId(now), text: st.memory, source: "chat", createdAt: at, updatedAt: at });
      }
      s.streams.delete(msgId);
    }
    const conv = store.conversations.find((c) => c.convId === m.convId);
    if (conv) conv.updatedAt = iso(now);
  }
}

// ---------- The API ----------

function effectiveOf(store: MockStore, conv: Conversation): Effective {
  const low = lowerLevels(store, "chat", "creative_director");
  const r = resolve({ conversation: { model: conv.model, effort: conv.effort }, task: low.task, agent: low.agent, ai: low.ai });
  // A conversation whose saved choice no longer fits shows the default's model; the next send says why.
  return "error" in r ? { model: low.ai?.defaultModel ?? modelsFile.defaultModel, effort: (low.ai?.defaultEffort ?? modelsFile.defaultEffort) as Effort, effortApplied: true, from: "default" } : r;
}

function shape(store: MockStore, conv: Conversation): Conversation {
  return structuredClone({ ...conv, effective: effectiveOf(store, conv) });
}

function find(store: MockStore, ws: string, convId: string): Conversation {
  checkWs(store, ws);
  const conv = store.conversations.find((c) => c.convId === convId);
  if (!conv || (state(store).owner.get(convId) ?? "stories") !== ws) throw new ApiError(404, "not_found", "We could not find that chat.");
  return conv;
}

function checkProjectRef(ref: unknown): ProjectRef | null {
  if (ref === null || ref === undefined) return null;
  const r = ref as ProjectRef;
  if (!r || !["idea", "story", "character", "reference"].includes(r.kind) || typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id)) throw bad("Pick an idea, a video, a character or a reference video.", "projectRef");
  return { kind: r.kind, id: r.id };
}

function checkSetting(store: MockStore, conv: Pick<Conversation, "model" | "effort">): void {
  if (conv.model !== null && !MODELS.some((m) => m.key === conv.model)) throw bad("We don't know that model. Pick one from the list.", "model");
  if (conv.effort !== null && !(EFFORTS as string[]).includes(conv.effort)) throw bad("Pick Low, Medium, High, Extra high or Maximum.", "effort");
  const low = lowerLevels(store, "chat", "creative_director");
  const r = resolve({ conversation: conv, task: low.task, agent: low.agent, ai: low.ai });
  if ("error" in r) throw bad(r.sentence, r.error);
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const s = state(store);
  return {
    async listConversations(ws) {
      await delay(120);
      checkWs(store, ws);
      advance(store);
      const at = (c: Conversation) => c.lastMessageAt ?? c.createdAt;
      return store.conversations
        .filter((c) => (s.owner.get(c.convId) ?? "stories") === ws)
        .sort((a, b) => at(b).localeCompare(at(a)))
        .map((c) => shape(store, c));
    },

    async createConversation(ws, body) {
      await delay(150);
      checkWs(store, ws);
      const title = body.title === undefined ? "New chat" : String(body.title).trim();
      if (!title || title.length > 80) throw bad("Give the chat a name of up to 80 letters.", "title");
      const setting = { model: body.model ?? null, effort: body.effort ?? null };
      checkSetting(store, setting);
      const now = iso();
      const conv: Conversation = { convId: newId(), title, ...setting, effective: { model: "", effort: null, effortApplied: false, from: "default" }, projectRef: checkProjectRef(body.projectRef), lastMessageAt: null, createdAt: now, updatedAt: now };
      store.conversations.push(conv);
      s.owner.set(conv.convId, ws);
      return shape(store, conv);
    },

    async getConversation(ws, convId, page) {
      await delay(90);
      const conv = find(store, ws, convId);
      advance(store);
      const after = page?.after;
      const before = page?.before;
      const all = store.messages.filter((m) => m.convId === convId);
      let list: Message[];
      if (after) {
        const i = all.findIndex((m) => m.msgId === after);
        list = (i >= 0 ? all.slice(i + 1) : all.filter((m) => m.msgId > after)).slice(0, SHOWN);
      } else {
        let end = all.length;
        if (before) {
          end = all.findIndex((m) => m.msgId === before);
          if (end < 0) throw new ApiError(404, "not_found", "We could not find that message.");
        }
        list = all.slice(Math.max(0, end - SHOWN), end);
      }
      return { conversation: shape(store, conv), messages: list.map((m) => structuredClone(m)) };
    },

    async patchConversation(ws, convId, patch) {
      await delay(120);
      const conv = find(store, ws, convId);
      const allowed = ["title", "model", "effort", "projectRef"];
      for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw bad("Something in that request was not right.", k);
      const next = { ...conv };
      if (patch.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t || t.length > 80) throw bad("Give the chat a name of up to 80 letters.", "title");
        next.title = t;
      }
      if (patch.model !== undefined) next.model = patch.model;
      if (patch.effort !== undefined) next.effort = patch.effort;
      if (patch.projectRef !== undefined) next.projectRef = checkProjectRef(patch.projectRef);
      checkSetting(store, next);
      Object.assign(conv, next, { updatedAt: iso() });
      return shape(store, conv);
    },

    async deleteConversation(ws, convId) {
      await delay(120);
      find(store, ws, convId);
      store.conversations = store.conversations.filter((c) => c.convId !== convId);
      for (const m of store.messages) if (m.convId === convId) s.streams.delete(m.msgId);
      store.messages = store.messages.filter((m) => m.convId !== convId);
      for (const [id, p] of s.pictures) if (p.convId === convId) s.pictures.delete(id);
      s.owner.delete(convId);
    },

    async sendMessage(ws, convId, body) {
      await delay(160);
      const conv = find(store, ws, convId);
      for (const k of Object.keys(body)) if (!["text", "attachments", "override"].includes(k)) throw bad("Something in that request was not right.", k);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw bad("Type a message first.", "text");
      if (text.length > 8000) throw bad("That message is too long. Keep it under 8000 letters.", "text");
      const atts = body.attachments ?? [];
      if (atts.length > 4) throw bad("You can add up to 4 pictures to one message.", "attachments");
      if (store.messages.some((m) => m.convId === convId && m.role === "assistant" && (m.status === "pending" || m.status === "streaming")))
        throw new ApiError(409, "conflict", "Wait for the answer first, or tap Stop.");
      const pictures = atts.map((a) => {
        const p = s.pictures.get(a.assetId);
        if (!p || p.convId !== convId) throw bad("That picture did not finish uploading. Add it again.", "attachments");
        return { assetId: a.assetId, url: `mock://chat/${convId}/${a.assetId}`, contentType: p.contentType };
      });
      const override: ModelOverride | null = body.override ?? null;
      if (override) for (const k of Object.keys(override)) if (!["model", "effort"].includes(k)) throw bad("Something in that request was not right.", "override");
      const low = lowerLevels(store, "chat", "creative_director");
      const eff = resolve({ request: override, conversation: { model: conv.model, effort: conv.effort }, task: low.task, agent: low.agent, ai: low.ai });
      if ("error" in eff) throw bad(eff.sentence, eff.error === "model" ? "override" : "effort");
      const model = MODELS.find((m) => m.key === eff.model)!;
      if (pictures.length && !model.vision) throw bad(`${model.label} can't look at pictures. Pick another model, or take the pictures out.`, "attachments");
      const now = Date.now();
      const user: Message = { msgId: newId(now), convId, role: "user", text, attachments: pictures, status: "done", model: null, effort: null, effortApplied: null, usage: null, actions: [], createdAt: iso(now) };
      // The answer carries its one-time choice (`requested`, §45.35 D4) and exactly what is called (§45.35 D5).
      const requested: ModelOverride | null = override && (override.model || override.effort) ? { ...(override.model ? { model: override.model } : {}), ...(override.effort ? { effort: override.effort } : {}) } : null;
      const assistant: Message = { msgId: newId(now), convId, role: "assistant", text: "", attachments: [], status: "pending", model: eff.model, effort: eff.effort, effortApplied: eff.effortApplied, usage: null, actions: [], requested, ...(modelCall(eff.model) ?? {}), createdAt: iso(now) };
      for (const p of pictures) s.pictures.delete(p.assetId);
      store.messages.push(user, assistant);
      const denied = Array.isArray(store.knobs.chatDenied) ? (store.knobs.chatDenied as string[]) : [];
      const failOnce = typeof store.knobs.chatFail === "string" ? store.knobs.chatFail : null;
      if (failOnce) store.knobs.chatFail = null;
      const fail =
        failOnce ??
        low.agentOff ??
        (denied.includes(eff.model) ? `${model.label} isn't available right now: this account cannot use it yet. Pick another model in Lamo Stories › Settings › AI, or try again.` : null);
      const answer = answerFor(store, text, conv.projectRef);
      s.streams.set(assistant.msgId, { start: now, chunks: pieces(answer.text), actions: answer.actions, fail, memory: answer.memory });
      if (conv.title === "New chat") conv.title = text.length <= 40 ? text : `${text.slice(0, 40).replace(/\s+\S*$/, "")}…`;
      conv.lastMessageAt = iso(now);
      conv.updatedAt = iso(now);
      return { user: structuredClone(user), assistant: structuredClone(assistant) };
    },

    async chatAttachment(ws, convId, file): Promise<Upload> {
      await delay(100);
      find(store, ws, convId);
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.contentType)) throw bad("Pick a PNG, JPG or WebP picture.", "contentType");
      if (!(file.size > 0)) throw bad("That picture is empty. Pick another one.", "size");
      if (file.size > 5 * 1024 * 1024) throw new ApiError(413, "too_large", "That picture is too big. Pick one under 5 MB.", "size");
      const assetId = newId();
      s.pictures.set(assetId, { convId, contentType: file.contentType });
      return { assetId, uploadUrl: `mock://chat/${convId}/${assetId}`, headers: { "content-type": file.contentType } };
    },

    async stopMessage(ws, convId, msgId) {
      await delay(100);
      find(store, ws, convId);
      advance(store);
      const m = store.messages.find((x) => x.msgId === msgId && x.convId === convId && x.role === "assistant");
      if (!m) throw new ApiError(404, "not_found", "We could not find that message.");
      if (m.status === "pending" || m.status === "streaming") {
        m.status = "stopped";
        m.text = m.text.trimEnd();
        s.streams.delete(msgId);
      }
      return structuredClone(m);
    },
  };
}
