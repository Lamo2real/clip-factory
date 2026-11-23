// The in-memory Lamo Stories API for mock mode and Playwright (docs/CONTRACTS.md §45.16.8): one shared store, one
// part per area. Every part seeds, then the shell's stand-in seed fills in when no part seeded any story, then each
// part that hangs things off another part's items finishes its seed (afterSeed). Builder F owns this file; F2 owns
// ai, skills, memory; G ideas, characters, stories; H chat, references.
import type { StoriesApi, StoriesConfig } from "../types.ts";
import * as ai from "./ai.ts";
import * as characters from "./characters.ts";
import * as chat from "./chat.ts";
import * as dashboard from "./dashboard.ts";
import * as ideas from "./ideas.ts";
import * as library from "./library.ts";
import * as mac from "./mac.ts";
import * as memory from "./memory.ts";
import * as onboarding from "./onboarding.ts";
import * as publishing from "./publishing.ts";
import * as references from "./references.ts";
import * as skills from "./skills.ts";
import * as social from "./social.ts";
import * as stories from "./stories.ts";
import { createStore, isNotBuilt, seedShellDemo, type MockStore } from "./store.ts";
import * as workspace from "./workspace.ts";

interface Part {
  seed(store: MockStore): void;
  afterSeed?(store: MockStore): void;
  api(store: MockStore): Partial<StoriesApi>;
}

// mac after publishing and dashboard: it hands TikTok to the owner's Mac while My Mac posts TikTok is on (§47.10).
const PARTS: Part[] = [workspace, dashboard, library, social, publishing, onboarding, ai, skills, memory, ideas, characters, stories, chat, references, mac];

/**
 * Knobs a test sets before the app loads (page.addInitScript: window.__cfStoriesMock = { knobs: { fresh: true } }).
 * Only before a store exists: a later mock never takes over the knobs of the one before it.
 */
function earlyKnobs(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  const early = (window as unknown as { __cfStoriesMock?: { knobs?: unknown; store?: unknown } }).__cfStoriesMock;
  if (!early || early.store || !early.knobs || typeof early.knobs !== "object") return {};
  return { ...(early.knobs as Record<string, unknown>) };
}

export function mockStoriesApi(): StoriesApi {
  const store = createStore();
  store.knobs = earlyKnobs();
  for (const part of PARTS) part.seed(store);
  seedShellDemo(store);
  for (const part of PARTS) part.afterSeed?.(store);
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfStoriesMock?: Record<string, unknown> };
    w.__cfStoriesMock = Object.assign(w.__cfStoriesMock ?? {}, { store, knobs: store.knobs });
  }
  const joined: Record<string, unknown> = {};
  for (const part of PARTS)
    for (const [key, fn] of Object.entries(part.api(store))) {
      // A built method always wins over a part's not-built stub, whichever comes first.
      if (joined[key] && !isNotBuilt(joined[key]) && isNotBuilt(fn)) continue;
      joined[key] = fn;
    }
  const fallbacks = { ...library.shellFallbacks(store), ...onboarding.shellFallbacks(store) };
  for (const [key, fn] of Object.entries(fallbacks)) if (!joined[key] || isNotBuilt(joined[key])) joined[key] = fn;
  // "Clear now" (POST …/storage/cleanup) also clears reference videos as keepReferences says, as the API does
  // (§45.34, §45.35 D9): their page then says the video was removed, and whether its study stays.
  const cleanup = joined.storageCleanup as StoriesApi["storageCleanup"] | undefined;
  if (cleanup && !isNotBuilt(cleanup))
    joined.storageCleanup = async (ws: string) => {
      const r = await cleanup(ws);
      const conf = store.workspaces.find((w) => w.workspaceId === ws)?.configuration as Partial<StoriesConfig> | undefined;
      const refs = references.clearByKeepSetting(store, ws, conf?.production?.keepReferences);
      // The storage part's first answer is its seed's pretend total of everything clearable, reference videos
      // included; after that only what is really cleared here counts.
      return { removed: r.removed.files ? r.removed : refs };
    };
  // A character's reference picture is deleteReference (the characters part); a reference video is
  // deleteReferenceVideo (the references part), the rename of CONTRACTS §45.34.
  return joined as unknown as StoriesApi;
}
