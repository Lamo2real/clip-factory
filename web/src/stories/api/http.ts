// The HTTP client for Lamo Stories (docs/CONTRACTS.md §45.5).
// SCAFFOLD (Phase 1): builder F implements every StoriesApi method against `${apiUrl}/v1/workspaces/...` with the app's
// own authorised fetch (web/src/api/http.ts: Bearer token, one forced refresh on 401, ApiError envelopes).
import type { StoriesApi } from "./types.ts";

export function httpStoriesApi(): StoriesApi {
  return new Proxy({} as StoriesApi, {
    get: () => () => Promise.reject(new Error("Lamo Stories is not built yet.")),
  });
}
