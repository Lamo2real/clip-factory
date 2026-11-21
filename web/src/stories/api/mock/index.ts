// The in-memory Lamo Stories API for mock mode and Playwright (docs/CONTRACTS.md §45.16.8): one shared store, one
// part per area. Builder F owns this file; F2 owns ai, skills, memory; G ideas, characters, stories; H chat, references.
import type { StoriesApi } from "../types.ts";
import * as ai from "./ai.ts";
import * as characters from "./characters.ts";
import * as chat from "./chat.ts";
import * as dashboard from "./dashboard.ts";
import * as ideas from "./ideas.ts";
import * as library from "./library.ts";
import * as memory from "./memory.ts";
import * as onboarding from "./onboarding.ts";
import * as publishing from "./publishing.ts";
import * as references from "./references.ts";
import * as skills from "./skills.ts";
import * as social from "./social.ts";
import * as stories from "./stories.ts";
import { createStore } from "./store.ts";
import * as workspace from "./workspace.ts";

const PARTS = [workspace, dashboard, library, social, publishing, onboarding, ai, skills, memory, ideas, characters, stories, chat, references];

export function mockStoriesApi(): StoriesApi {
  const store = createStore();
  for (const part of PARTS) part.seed(store);
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfStoriesMock?: Record<string, unknown> };
    w.__cfStoriesMock = Object.assign(w.__cfStoriesMock ?? {}, { store });
  }
  return {
    ...workspace.api(store),
    ...dashboard.api(store),
    ...library.api(store),
    ...social.api(store),
    ...publishing.api(store),
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...onboarding.api(store),
    ...ai.api(store),
    ...skills.api(store),
    ...memory.api(store),
    ...chat.api(store),
    ...references.api(store),
  };
}
