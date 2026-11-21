// The in-memory Lamo Stories API for mock mode and Playwright (docs/CONTRACTS.md §45.16.8).
// SCAFFOLD (Phase 1): builder F implements every StoriesApi method with fixtures and fake latency.
import type { StoriesApi } from "./types.ts";

export function mockStoriesApi(): StoriesApi {
  return new Proxy({} as StoriesApi, {
    get: () => () => Promise.reject(new Error("Lamo Stories is not built yet.")),
  });
}
