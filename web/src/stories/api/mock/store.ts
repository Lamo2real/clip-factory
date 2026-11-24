// The in-memory store every mock part shares (docs/CONTRACTS.md §45.16.8). Each part seeds its own collections in
// its own file (seed(store)), may finish its seed once every part has seeded (afterSeed(store), for things that
// hang off another part's items), and implements its own StoriesApi methods (api(store)); index.ts joins them.
// Builder F owns this file, index.ts and the workspace, dashboard, library, social, publishing and onboarding parts;
// F2 the ai, skills and memory parts; G the ideas, characters and stories parts; H chat, references. The parts meet
// only through the shapes below.
import { CLIPS_WORKSPACE_ID, FIRST_STORIES_WORKSPACE_ID } from "../types.ts";
import type {
  Agent,
  AiTask,
  Character,
  ClipsDestination,
  Conversation,
  Idea,
  LibraryItem,
  MemoryItem,
  Message,
  OnboardStep,
  ProductionJob,
  PublishingJob,
  ReferenceVideo,
  Series,
  Skill,
  SocialAccount,
  Story,
  StoriesAiConfig,
  StoriesApi,
  StoriesDashboard,
  VideoDraft,
  Workspace,
} from "../types.ts";
import type { CharacterLook, StoryScript } from "../../engine/types.ts";

/**
 * A SERIES# item as the mock keeps it (§45.44): the owner's fields, the story so far and the episode summaries. Its
 * episodes, counts and cover are worked out on every read (series.ts), like the API.
 */
export interface StoredSeries {
  seriesId: string;
  workspaceId: string;
  name: string;
  line: string | null;
  castIds: string[];
  cover: Series["cover"];
  storySoFar: string;
  storySoFarBy: "ai" | "owner" | null;
  storySoFarAt: string | null;
  summaries: { storyId: string; summary: string; by: "ai" | "owner"; at: string }[];
  recap: Series["recap"];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MockStore {
  workspaces: Workspace[];
  ideas: Idea[];
  characters: Character[];
  stories: Story[];
  scripts: Record<string, StoryScript>;
  jobs: ProductionJob[];
  assets: LibraryItem[];
  social: SocialAccount[];
  publishing: PublishingJob[];
  tasks: AiTask[];
  ai: StoriesAiConfig | null;
  agents: Agent[];
  skills: Skill[];
  memory: MemoryItem[];
  conversations: Conversation[];
  messages: Message[];
  references: ReferenceVideo[];
  /** Series (§45.44), the series part's */
  series: StoredSeries[];
  /** Saved "Make a new video" forms (VDRAFT#, §45.47), the drafts part's */
  drafts: VideoDraft[];
  /** Lamo Clips' own destination per platform (names only), as GET …/social returns it. */
  clips: ClipsDestination[];
  /** ACT# items any part may add (approve, reject, changes, made, posted, failed); the dashboard shows the last 10. */
  activity: StoriesDashboard["activity"];
  /**
   * The onboarding item (ONBOARD, §45.29): the steps ticked by hand or skipped and when it was finished;
   * `providersPickedAt` is the workspace's own stamp of the last PATCH that carried `configuration.providers` (even
   * unchanged: keeping the built-in animator is a pick too), which ticks step 4 with the API's rule.
   */
  onboarding: { stepsDone: OnboardStep[]; skipped: OnboardStep[]; finishedAt: string | null; providersPickedAt: string | null };
  /** test knobs, merged onto window.__cfStoriesMock by index.ts */
  knobs: Record<string, unknown>;
}

export function createStore(): MockStore {
  return {
    workspaces: [],
    ideas: [],
    characters: [],
    stories: [],
    scripts: {},
    jobs: [],
    assets: [],
    social: [],
    publishing: [],
    tasks: [],
    ai: null,
    agents: [],
    skills: [],
    memory: [],
    conversations: [],
    messages: [],
    references: [],
    series: [],
    drafts: [],
    clips: [],
    activity: [],
    onboarding: { stepsDone: [], skipped: [], finishedAt: null, providersPickedAt: null },
    knobs: {},
  };
}

let latency: number | null = null;

/** Tests can make every fake wait shorter (or none); null puts the normal waits back. */
export function setMockLatency(ms: number | null): void {
  latency = ms;
}

/** Fake latency, like the Lamo Clips mock. */
export function delay(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, latency ?? ms));
}

/** Marks a not-built method, so index.ts can tell it from a real one. */
export const NOT_BUILT = Symbol.for("cf.stories.notBuilt");

/** A part that is not built yet: every method rejects with a plain sentence. */
export function notBuilt<K extends keyof StoriesApi>(keys: readonly K[]): Pick<StoriesApi, K> {
  const out: Record<string, () => Promise<never>> = {};
  for (const k of keys) {
    const fn = () => Promise.reject(new Error("Clips Funded is not built yet."));
    (fn as unknown as Record<symbol, boolean>)[NOT_BUILT] = true;
    out[k as string] = fn;
  }
  return out as unknown as Pick<StoriesApi, K>;
}

export function isNotBuilt(fn: unknown): boolean {
  return typeof fn === "function" && (fn as unknown as Record<symbol, boolean>)[NOT_BUILT] === true;
}

/** "now minus `ms`" as the contract's ISO form. */
export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

let counter = 0;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped id (26 Crockford characters), unique for this page. */
export function mockId(): string {
  counter += 1;
  let t = Date.now() * 1000 + counter;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  let r = counter * 2654435761;
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[r % 32]!;
    r = Math.floor(r / 32) + (i + 7) * 131;
  }
  return out;
}

/** The workspace ids the mock knows (Lamo Clips is built in and never stored as an item). */
export function isStoriesWs(store: MockStore, ws: string): boolean {
  return store.workspaces.some((w) => w.workspaceId === ws && w.workspaceType === "stories");
}

export { CLIPS_WORKSPACE_ID, FIRST_STORIES_WORKSPACE_ID };

// ---------- The shell's stand-in seed ----------
// The studio part (builder G: ideas, characters, stories) seeds the real cast and stories. Until a seed has put any
// story in the store, the shell adds this small set so the dashboard, the Library and the posts have something to
// show; it never runs once the studio part seeds stories.

const LOOK_PIP: CharacterLook = {
  body: "bean",
  skin: "#F6C9A0",
  height: 1,
  width: 1,
  hair: { style: "curly", color: "#3B2A20" },
  eyes: { shape: "round", color: "#2B2340" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: "#FFC94A", bottom: "#62C6FF", accent: "#FF6F61", pattern: "stripes" },
  accessory: "scarf",
  outline: "#1C1842",
};

const LOOK_BOLT: CharacterLook = {
  body: "square",
  skin: "#8C5A3C",
  height: 1.1,
  width: 1.05,
  hair: { style: "cap", color: "#47D6A0" },
  eyes: { shape: "oval", color: "#1C1842" },
  brows: "thin",
  nose: "dot",
  mouth: "small",
  outfit: { top: "#47D6A0", bottom: "#322A73", accent: "#FFC94A", pattern: "plain" },
  accessory: "helmet",
  outline: "#1C1842",
};

const STEP_KEYS = ["storyboard", "safety", "scenes", "animation", "sound", "captions", "assemble", "preview"] as const;
const STEP_LABELS: Record<(typeof STEP_KEYS)[number], string> = {
  storyboard: "Write the story",
  safety: "Check the facts",
  scenes: "Draw the scenes",
  animation: "Animate",
  sound: "Add sounds and music",
  captions: "Add captions",
  assemble: "Put it together",
  preview: "Ready to watch",
};

function demoJob(ws: string, storyId: string, at: string, running: number | null): ProductionJob {
  const steps = STEP_KEYS.map((key, i) => ({
    key,
    label: STEP_LABELS[key],
    status: (running === null || i < running ? "done" : i === running ? "running" : "pending") as "done" | "running" | "pending",
    ...(running === null || i <= running ? { startedAt: at } : {}),
    ...(running === null || i < running ? { finishedAt: at } : {}),
    ...(i === running ? { i: 3, n: 6, message: "Animating scene 3 of 6" } : {}),
  }));
  const progress = running === null ? 1 : (running + 0.5) / STEP_KEYS.length;
  return {
    jobId: mockId(),
    workspaceId: ws,
    contentType: "animation",
    contentId: storyId,
    jobType: "produce",
    status: running === null ? "ready" : "running",
    steps,
    progress,
    configuration: { run: [...STEP_KEYS], from: null, sceneIds: null, note: null },
    meta: {
      writerModel: "opus-5-5",
      engineVersion: 1,
      seed: 4242,
      scriptVersion: 1,
      targetSec: 45,
      actualSec: running === null ? 44.6 : null,
      safetyTopicId: null,
      providers: { writer: "bedrock-claude", images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
      models: [
        { step: "storyboard", agentId: "storyboard", model: "opus-5-5", effort: "high", effortApplied: true },
        { step: "safety", agentId: "quality_assurance", model: "opus-5-5", effort: "high", effortApplied: true },
        ...(running === null ? [{ step: "preview", agentId: "quality_assurance", model: "opus-5-5", effort: "high" as const, effortApplied: true }] : []),
      ],
    },
    createdAt: at,
    updatedAt: at,
  };
}

export function seedShellDemo(store: MockStore): void {
  if (store.stories.length > 0) return;
  const ws = FIRST_STORIES_WORKSPACE_ID;
  const character = (name: string, look: CharacterLook, style: Character["movementStyle"], personality: string, days: number): Character => ({
    characterId: mockId(),
    workspaceId: ws,
    name,
    description: `${name} is one of the Clips Funded regulars.`,
    personality,
    traits: ["curious", "kind"],
    movementStyle: style,
    expressions: ["neutral", "happy", "surprised", "worried", "relieved"],
    look,
    voice: { style: "babble", pitch: style === "heavy" ? 0.8 : 1.3, noises: ["gasp", "yay", "phew"], sfx: ["boing", "ding"] },
    references: [],
    portrait: null,
    storyCount: 0,
    version: 1,
    createdAt: ago(days * DAY),
    updatedAt: ago(days * DAY),
  });
  if (store.characters.length === 0)
    store.characters.push(
      character("Pip", LOOK_PIP, "bouncy", "Jumps first, thinks second, always says sorry.", 9),
      character("Bolt", LOOK_BOLT, "heavy", "A careful driver who loves rules and snacks.", 8),
    );
  const cast = store.characters.slice(0, 2).map((c) => c.characterId);
  const story = (title: string, status: Story["status"], hoursAgo: number, extra: Partial<Story> = {}): Story => {
    const storyId = mockId();
    const at = ago(hoursAgo * HOUR);
    const made = !["draft", "producing"].includes(status);
    return {
      storyId,
      workspaceId: ws,
      contentType: "animation",
      title,
      status,
      category: "driving_safety",
      ideaId: null,
      characterIds: cast,
      durationSec: 45,
      actualDurationSec: made ? 44.6 : null,
      captionsOn: true,
      musicMood: "playful",
      postCaptions: { youtubeTitle: title, youtubeDescription: `${title}. Made with Clips Funded.`, instagram: title, facebook: title, tiktok: title, x: title },
      scenes: [
        { sceneId: "s1", title: "The road ahead", durationSec: 7 },
        { sceneId: "s2", title: "Uh oh", durationSec: 8 },
        { sceneId: "s3", title: "Easy does it", durationSec: 9 },
        { sceneId: "s4", title: "Phew", durationSec: 8 },
        { sceneId: "s5", title: "Thumbs up", durationSec: 6 },
        { sceneId: "s6", title: "The end card", durationSec: 6.6 },
      ],
      scriptVersion: 1,
      storageLocation: `s3://cf-prod-media/ws/mock-user/${ws}/stories/${storyId}/`,
      stale: [],
      safetyTopicId: null,
      safety: made ? { topicId: null, status: "ok", problems: [], checkedScriptVersion: 1, citations: [] } : null,
      reviewNote: null,
      currentJobId: null,
      ai: { model: null, effort: null },
      referenceIds: [],
      posted: [],
      version: 3,
      createdAt: at,
      updatedAt: at,
      ...extra,
    };
  };
  const list = [
    story("Ice? Easy does it", "published", 70, { approvedAt: ago(60 * HOUR), publishedAt: ago(58 * HOUR) }),
    story("The great tyre pop", "approved", 30, { approvedAt: ago(26 * HOUR), category: "comedy" }),
    story("Pip learns to park", "review", 9, { category: "everyday_skills" }),
    story("Fog lights on!", "needs_check", 5, {
      safety: { topicId: null, status: "problems", problems: ["Scene 3 shows the car speeding up in fog. Show it slowing down instead."], checkedScriptVersion: 1, citations: [] },
    }),
    story("Bolt and the runaway cone", "producing", 0.2, { category: "comedy" }),
    story("Snow day surprise", "failed", 20, { category: "comedy", stale: ["animation", "sound", "captions", "assemble", "preview"] }),
  ];
  for (const s of list) {
    const running = s.status === "producing" ? 3 : null;
    const job = demoJob(ws, s.storyId, s.createdAt, running);
    if (s.status === "failed") {
      job.status = "failed";
      job.steps = job.steps.map((st, i) => (i === 3 ? { ...st, status: "failed", message: "Making the video stopped. Tap Try again." } : i > 3 ? { ...st, status: "pending" } : st));
      job.error = "Making the video stopped. Tap Try again.";
      job.progress = 3 / 8;
    }
    if (s.status === "producing") s.currentJobId = job.jobId;
    store.jobs.push(job);
  }
  store.stories.push(...list);
  for (const c of store.characters) c.storyCount = list.filter((s) => s.characterIds.includes(c.characterId)).length;
}
