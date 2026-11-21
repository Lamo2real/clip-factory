// The in-memory store every mock part shares (docs/CONTRACTS.md §45.16.8). Each part seeds its own collections in
// its own file (seed(store)) and implements its own StoriesApi methods (api(store)); index.ts joins them.
// SCAFFOLD (Phase 1): builder F owns this file, index.ts and the workspace, dashboard, library, social and publishing
// parts; builder G owns the ideas, characters and stories parts.
import type {
  Character,
  Idea,
  LibraryItem,
  ProductionJob,
  PublishingJob,
  SocialAccount,
  Story,
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
  /** test knobs, merged onto window.__cfStoriesMock by index.ts */
  knobs: Record<string, unknown>;
}

export function createStore(): MockStore {
  return { workspaces: [], ideas: [], characters: [], stories: [], scripts: {}, jobs: [], assets: [], social: [], publishing: [], knobs: {} };
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
