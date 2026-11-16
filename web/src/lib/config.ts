export interface RuntimeConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
  /** WebSocket API for live updates (docs/CONTRACTS.md §4, §14.2). Absent in old configs: polling only. */
  wsUrl?: string;
  /**
   * The hooks API's OAuth base, `https://…/v1/oauth` (docs/CONTRACTS.md §17.9). Optional: the setup pages use it
   * only until GET /v1/setup answers with the exact return addresses.
   */
  oauthCallbackBase?: string;
  version: string;
}

/**
 * The whole UI runs on the in-memory API (npm run dev:mock, Playwright). Replaced at build time. `import.meta.env`
 * is undefined when plain Node loads this file (scripts/help-corpus.mjs reads the router), hence the `?.`.
 */
export const isMock = (import.meta.env as ImportMetaEnv | undefined)?.VITE_MOCK === "1";

const MOCK_CONFIG: RuntimeConfig = {
  region: "eu-north-1",
  userPoolId: "eu-north-1_mock",
  userPoolClientId: "mock",
  apiUrl: "mock://api",
  // Mock mode runs a fake socket on the in-memory store, so live updates can be seen and tested offline.
  wsUrl: "mock://live",
  version: "mock",
};

let current: RuntimeConfig | null = null;

function valid(c: Partial<RuntimeConfig> | null): c is RuntimeConfig {
  return !!c && !!c.region && !!c.userPoolId && !!c.userPoolClientId && !!c.apiUrl;
}

/** CloudFront serves /config.json (written at deploy time, never cached). */
export async function loadConfig(fetcher: typeof fetch = fetch): Promise<RuntimeConfig> {
  if (isMock) return (current = MOCK_CONFIG);
  const res = await fetcher("/config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json ${res.status}`);
  const body = (await res.json()) as Partial<RuntimeConfig>;
  if (!valid(body)) throw new Error("config.json is missing fields");
  const wsUrl = typeof body.wsUrl === "string" && /^wss:\/\/[^\s?#]+$/.test(body.wsUrl) ? body.wsUrl.replace(/\/+$/, "") : undefined;
  const oauthCallbackBase =
    typeof body.oauthCallbackBase === "string" && /^https:\/\/[^\s?#]+\/oauth\/?$/.test(body.oauthCallbackBase)
      ? body.oauthCallbackBase.replace(/\/+$/, "")
      : undefined;
  current = { ...body, apiUrl: body.apiUrl.replace(/\/+$/, ""), wsUrl, oauthCallbackBase, version: body.version ?? "" };
  return current;
}

export function config(): RuntimeConfig {
  if (!current) throw new Error("config not loaded");
  return current;
}
