// The in-memory store every mock part shares (docs/CONTRACTS.md §45.16.8). Each part seeds its own collections in
// its own file (seed(store)) and implements its own StoriesApi methods (api(store)); index.ts joins them.
// SCAFFOLD (Phase 1): builder F owns this file, index.ts and the workspace, dashboard, library, social, publishing and
// onboarding parts; F2 the ai, skills and memory parts; G the ideas, characters and stories parts; H chat, references.
import type {
  Agent,
  AiTask,
  Character,
  Conversation,
  Idea,
  LibraryItem,
  MemoryItem,
  Message,
  ProductionJob,
  PublishingJob,
  ReferenceVideo,
  Skill,
  SocialAccount,
  Story,
  StoriesAiConfig,
  StoriesApi,
  Workspace,
} from "../types.ts";
import type { StoryScript } from "../../engine/types.ts";

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
    knobs: {},
  };
}

/** Fake latency, like the Lamo Clips mock. */
export function delay(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A part that is not built yet: every method rejects with a plain sentence. */
export function notBuilt<K extends keyof StoriesApi>(keys: readonly K[]): Pick<StoriesApi, K> {
  const out: Record<string, () => Promise<never>> = {};
  for (const k of keys) out[k as string] = () => Promise.reject(new Error("Lamo Stories is not built yet."));
  return out as unknown as Pick<StoriesApi, K>;
}
