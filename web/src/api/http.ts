import { announceSignedOut, type AuthClient } from "../lib/auth.ts";
import { ApiError, errorFromResponse, networkError } from "./errors.ts";
import type { Account, Api, Clip, Job, Post, Settings, Skill } from "./types.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Deps {
  baseUrl: string;
  auth: Pick<AuthClient, "accessToken">;
  fetcher?: typeof fetch;
}

/** The contract's HTTP API (docs/CONTRACTS.md §5) with the owner's access token on every call. */
export function httpApi({ baseUrl, auth, fetcher = (...a) => fetch(...a) }: Deps): Api {
  async function send(method: Method, path: string, token: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const json = body === undefined ? undefined : JSON.stringify(body);
    try {
      return await fetcher(`${baseUrl}/v1${path}`, {
        method,
        headers,
        body: json,
        cache: "no-store",
        // Small changes (a caption edit saved as the app closes) must still reach the server after the page goes.
        ...(method === "PATCH" && (json?.length ?? 0) < 60_000 ? { keepalive: true } : {}),
      });
    } catch {
      throw networkError();
    }
  }

  async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res = await send(method, path, await auth.accessToken(), body);
    // One forced refresh covers a token that expired between Amplify's check and the request.
    if (res.status === 401) {
      const fresh = await auth.accessToken(true);
      if (fresh) res = await send(method, path, fresh, body);
    }
    if (res.status === 204) return undefined as T;
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = errorFromResponse(res.status, parsed);
      if (err.status === 401) announceSignedOut();
      throw err;
    }
    if (parsed === null) throw new ApiError(res.status, "internal", "The server sent an empty answer. Try again.");
    return parsed as T;
  }

  const q = (params: Record<string, string | number | null | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  };
  const id = encodeURIComponent;

  return {
    health: () => call("GET", "/health"),
    me: () => call("GET", "/me"),
    createUpload: (body) => call("POST", "/uploads", body),
    createJob: async (body) => (await call<{ job: Job }>("POST", "/jobs", body)).job,
    listJobs: (query = {}) => call("GET", `/jobs${q({ limit: query.limit, cursor: query.cursor })}`),
    getJob: (jobId) => call("GET", `/jobs/${id(jobId)}`),
    cancelJob: async (jobId) => (await call<{ job: Job }>("POST", `/jobs/${id(jobId)}/cancel`)).job,
    retryJob: async (jobId) => (await call<{ job: Job }>("POST", `/jobs/${id(jobId)}/retry`)).job,
    listClips: async (query = {}) =>
      (await call<{ clips: Clip[] }>("GET", `/clips${q({ status: query.status, jobId: query.jobId })}`)).clips,
    getClip: async (clipId) => (await call<{ clip: Clip }>("GET", `/clips/${id(clipId)}`)).clip,
    updateClip: async (clipId, captions) =>
      (await call<{ clip: Clip }>("PATCH", `/clips/${id(clipId)}`, { captions })).clip,
    confirmClip: (clipId, captions) =>
      call("POST", `/clips/${id(clipId)}/confirm`, captions ? { captions } : {}),
    declineClip: async (clipId) => (await call<{ clip: Clip }>("POST", `/clips/${id(clipId)}/decline`)).clip,
    listSkills: async () => (await call<{ skills: Skill[] }>("GET", "/skills")).skills,
    createSkillUpload: (filename) => call("POST", "/skills/uploads", { filename }),
    createSkill: async (body) => (await call<{ skill: Skill }>("POST", "/skills", body)).skill,
    setSkillEnabled: async (skillId, enabled) =>
      (await call<{ skill: Skill }>("PATCH", `/skills/${id(skillId)}`, { enabled })).skill,
    deleteSkill: (skillId) => call("DELETE", `/skills/${id(skillId)}`),
    skillContent: async (skillId) =>
      (await call<{ content: string }>("GET", `/skills/${id(skillId)}/content`)).content,
    getSettings: async () => (await call<{ settings: Settings }>("GET", "/settings")).settings,
    putSettings: async (patch) => (await call<{ settings: Settings }>("PUT", "/settings", patch)).settings,
    createCookiesUpload: (filename) => call("POST", "/settings/cookies", { filename }),
    deleteCookies: () => call("DELETE", "/settings/cookies"),
    listAccounts: async () => (await call<{ accounts: Account[] }>("GET", "/accounts")).accounts,
    connectAccount: (platform) => call("POST", `/accounts/${id(platform)}/connect`),
    listPosts: async (clipId) => (await call<{ posts: Post[] }>("GET", `/posts${q({ clipId })}`)).posts,
    insights: () => call("GET", "/insights"),
  };
}
