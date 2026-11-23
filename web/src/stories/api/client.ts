// The one way Lamo Stories screens reach the server (docs/CONTRACTS.md §45.5): storiesApi() returns the in-memory
// mock under VITE_MOCK=1 (npm run dev:mock, Playwright) and the HTTP client otherwise, like web/src/api/index.ts.
// Screens never call fetch themselves. Tests may install their own fake with setStoriesApi().
import type { StoriesApi } from "./types.ts";

let current: StoriesApi | null = null;
let loading: Promise<StoriesApi> | null = null;

export function setStoriesApi(api: StoriesApi | null): void {
  current = api;
  loading = null;
}

export async function loadStoriesApi(): Promise<StoriesApi> {
  if (current) return current;
  if (!loading) {
    loading = (async () => {
      if (import.meta.env.VITE_MOCK === "1") {
        const { mockStoriesApi } = await import("./mock/index.ts");
        current = mockStoriesApi();
      } else {
        const { httpStoriesApi } = await import("./http.ts");
        current = httpStoriesApi();
      }
      return current;
    })();
  }
  return loading;
}

/** The client once loaded (StoriesApp loads it before the first screen renders). */
export function storiesApi(): StoriesApi {
  if (!current) throw new Error("Funded Clips API is not loaded yet");
  return current;
}
