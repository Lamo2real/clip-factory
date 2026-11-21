// The in-memory Lamo Stories API for mock mode and Playwright (docs/CONTRACTS.md §45.16.8): one shared store, one
// part per area. Builder F owns this file.
import type { StoriesApi } from "../types.ts";
import * as characters from "./characters.ts";
import * as dashboard from "./dashboard.ts";
import * as ideas from "./ideas.ts";
import * as library from "./library.ts";
import * as publishing from "./publishing.ts";
import * as social from "./social.ts";
import * as stories from "./stories.ts";
import { createStore } from "./store.ts";
import * as workspace from "./workspace.ts";

const PARTS = [workspace, dashboard, library, social, publishing, ideas, characters, stories];

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
  };
}
