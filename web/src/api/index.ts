import { auth } from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { httpApi } from "./http.ts";
import type { Api } from "./types.ts";

let instance: Api | null = null;

/** Builds the API once config is loaded. Mock code is only bundled into mock builds. */
export async function initApi(): Promise<Api> {
  if (instance) return instance;
  // Tested on import.meta.env directly so production builds drop the mock chunk entirely.
  if (import.meta.env.VITE_MOCK === "1") {
    const { mockApi } = await import("./mock/index.ts");
    instance = mockApi();
  } else {
    instance = httpApi({ baseUrl: config().apiUrl, auth: auth() });
  }
  return instance;
}

export function api(): Api {
  if (!instance) throw new Error("api not initialised");
  return instance;
}

export * from "./types.ts";
export { ApiError, friendlyMessage } from "./errors.ts";
