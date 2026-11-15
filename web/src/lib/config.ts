export interface RuntimeConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
  version: string;
}

/** The whole UI runs on the in-memory API (npm run dev:mock, Playwright). Replaced at build time. */
export const isMock = import.meta.env.VITE_MOCK === "1";

const MOCK_CONFIG: RuntimeConfig = {
  region: "eu-north-1",
  userPoolId: "eu-north-1_mock",
  userPoolClientId: "mock",
  apiUrl: "mock://api",
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
  current = { ...body, apiUrl: body.apiUrl.replace(/\/+$/, ""), version: body.version ?? "" };
  return current;
}

export function config(): RuntimeConfig {
  if (!current) throw new Error("config not loaded");
  return current;
}
