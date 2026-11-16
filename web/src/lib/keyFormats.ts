// What each platform's keys look like (docs/CONTRACTS.md §17.4). The same patterns live in the API
// (api/src/clipfactory_api/oauth/formats.py); the API is the real gate, this file only helps while typing.
// TikTok and X patterns are lenient on purpose: Check it is the real test.
import type { KeyName, Platform, SetupKeys } from "../api/types.ts";

interface Format {
  re: RegExp;
  /** What the value looks like, for the friendly error under the box. */
  looks: string;
}

export const KEY_FORMATS: Record<Platform, Partial<Record<KeyName, Format>>> = {
  youtube: {
    clientId: {
      re: /^[0-9]{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$/,
      looks: "The Client ID ends with .apps.googleusercontent.com.",
    },
    clientSecret: { re: /^GOCSPX-[A-Za-z0-9_-]{20,40}$/, looks: "The Client secret starts with GOCSPX-." },
  },
  tiktok: {
    clientId: { re: /^[A-Za-z0-9]{10,64}$/, looks: "The Client key is letters and numbers, with no spaces." },
    clientSecret: { re: /^[A-Za-z0-9_-]{20,128}$/, looks: "The Client secret is a long line of letters and numbers." },
  },
  instagram: {
    clientId: { re: /^[0-9]{10,20}$/, looks: "The App ID is only numbers." },
    clientSecret: { re: /^[a-f0-9]{32}$/, looks: "The App secret is 32 letters and numbers." },
    configId: { re: /^[0-9]{10,20}$/, looks: "The Configuration ID is only numbers." },
  },
  facebook: {
    clientId: { re: /^[0-9]{10,20}$/, looks: "The App ID is only numbers." },
    clientSecret: { re: /^[a-f0-9]{32}$/, looks: "The App secret is 32 letters and numbers." },
    configId: { re: /^[0-9]{10,20}$/, looks: "The Configuration ID is only numbers." },
  },
  x: {
    clientId: { re: /^[A-Za-z0-9_-]{20,64}$/, looks: "The Client ID is a long line of letters and numbers." },
    clientSecret: { re: /^[A-Za-z0-9_-]{40,80}$/, looks: "The Client Secret is a long line of letters and numbers." },
  },
};

/** The boxes each platform needs, in order. */
export function keyNames(platform: Platform): KeyName[] {
  return (Object.keys(KEY_FORMATS[platform]) as KeyName[]).filter((k) => KEY_FORMATS[platform][k]);
}

/** The name the platform itself uses for each value, exactly as on its website. */
export const KEY_LABEL: Record<Platform, Partial<Record<KeyName, string>>> = {
  youtube: { clientId: "Client ID", clientSecret: "Client secret" },
  tiktok: { clientId: "Client key", clientSecret: "Client secret" },
  instagram: { clientId: "App ID", clientSecret: "App secret", configId: "Configuration ID" },
  facebook: { clientId: "App ID", clientSecret: "App secret", configId: "Configuration ID" },
  x: { clientId: "Client ID", clientSecret: "Client Secret" },
};

/** Trims, and removes quotes and invisible characters that copying from a web page can bring along. */
export function cleanKey(raw: string): string {
  return raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim().replace(/^["'\u201C\u201D\u2018\u2019`]+|["'\u201C\u201D\u2018\u2019`]+$/g, "").trim();
}

/** A Login URL (or any link) that carries `config_id=…` gives its Configuration ID. */
export function extractConfigId(raw: string): string {
  const v = cleanKey(raw);
  const m = /[?&#]config_id=([0-9]{10,20})(?:[&#]|$)/.exec(v);
  return m ? m[1]! : v;
}

/** Cleans a pasted value for one box (a Login URL in the Configuration ID box becomes the ID). */
export function normaliseKey(name: KeyName, raw: string): string {
  return name === "configId" ? extractConfigId(raw) : cleanKey(raw);
}

/** null when the value looks right (or the box is empty), else the sentence to show under the box. */
export function keyProblem(platform: Platform, name: KeyName, raw: string): string | null {
  const value = normaliseKey(name, raw);
  if (!value) return null;
  const f = KEY_FORMATS[platform][name];
  if (!f) return null;
  if (/\s/.test(value)) return `There is a space inside. Copy the ${KEY_LABEL[platform][name]} again with its Copy button.`;
  return f.re.test(value) ? null : `That does not look right. ${f.looks}`;
}

export function keyLooksRight(platform: Platform, name: KeyName, raw: string): boolean {
  const value = normaliseKey(name, raw);
  return !!value && keyProblem(platform, name, value) === null;
}

/** Every box filled and looking right: Save keys can be pressed. */
export function keysReady(platform: Platform, values: Partial<Record<KeyName, string>>): boolean {
  return keyNames(platform).every((k) => keyLooksRight(platform, k, values[k] ?? ""));
}

/** The body for PUT /v1/setup/{platform}/keys. */
export function keysBody(platform: Platform, values: Partial<Record<KeyName, string>>): SetupKeys {
  const out: SetupKeys = {
    clientId: normaliseKey("clientId", values.clientId ?? ""),
    clientSecret: normaliseKey("clientSecret", values.clientSecret ?? ""),
  };
  if (keyNames(platform).includes("configId")) out.configId = normaliseKey("configId", values.configId ?? "");
  return out;
}

/** The masked hint the API sends back (§17.4): clientId first 6 + "…" + last 4; secrets "••••" + last 4; configId last 4. */
export function maskKey(name: KeyName, value: string): string {
  if (name === "clientId") return value.length <= 10 ? `${value.slice(0, 2)}…${value.slice(-2)}` : `${value.slice(0, 6)}…${value.slice(-4)}`;
  if (name === "configId") return `…${value.slice(-4)}`;
  return `••••${value.slice(-4)}`;
}

/**
 * Google's downloaded client file (`client_secret_….json`), pasted or dropped: both values at once. Null when the
 * text is not that file.
 */
export function parseGoogleClientJson(text: string): { clientId: string; clientSecret: string } | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    const inner = (parsed.web ?? parsed.installed ?? parsed) as Record<string, unknown>;
    const clientId = inner.client_id;
    const clientSecret = inner.client_secret;
    if (typeof clientId === "string" && typeof clientSecret === "string") return { clientId: cleanKey(clientId), clientSecret: cleanKey(clientSecret) };
  } catch {
    return null;
  }
  return null;
}
