// The routes the helper uses (docs/CONTRACTS.md §42, §47, §47.10). Every call carries the owner's access token.
// client() is Clip Factory's (the clips lane, unchanged on the wire); wsClient() is one Clips Funded workspace's
// (a ws lane): it only ever builds /v1/workspaces/{ws}/… paths, never a /clips/ one.
import { holdsSecret } from "./notify.js";
import { VERSION } from "./paths.js";

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const withAttempt = (attempt) => (Number.isInteger(attempt) && attempt >= 1 ? { attempt } : {});
const withCode = (code) => (code ? { code } : {});

/**
 * ``token``: a string (one token, never renewed), or auth.js tokenSource() for anything that can outlast a token (a
 * tick: its login wait is 20 minutes, an access token lasts 15). A source's token is renewed before it runs out, and
 * once more on a 401: API Gateway's JWT authorizer refuses an expired token before Clip Factory sees the request, so
 * sending it again with a fresh token can't do anything twice.
 */
function caller(apiUrl, token, fetchImpl, app) {
  const source = typeof token === "string" ? null : token;
  return async function call(method, path, body) {
    // The saved TikTok password never leaves the Mac: a request that would carry it is never sent.
    if (holdsSecret(path) || (body && holdsSecret(JSON.stringify(body)))) {
      throw new ApiError(0, "The helper refused to send something secret.", "secret");
    }
    const send = (bearer) =>
      fetchImpl(`${apiUrl}/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    const bearer = source ? await source.get() : token;
    let res = await send(bearer);
    if (res.status === 401 && source) {
      // Let go of the refused answer first, so its connection isn't held until garbage collection.
      await res.body?.cancel().catch(() => {});
      res = await send(await source.renew(bearer));
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw new ApiError(res.status, err.message || `${app} answered ${res.status}.`, err.code);
    }
    return data;
  };
}

export function client(apiUrl, token, fetchImpl = fetch) {
  const call = caller(apiUrl, token, fetchImpl, "Clip Factory");
  const clip = (id) => `/clips/${encodeURIComponent(id)}`;
  return {
    queue: () => call("GET", "/tiktok/mac"),
    autopost: () => call("GET", "/autopost"),
    ping: (body) => call("POST", "/tiktok/mac/ping", body),
    // 1.3.0: the claim says this helper's version (MAC_BRAND_FROM: a post with TikTok's label is only for a helper
    // that sets it). A Clip Factory from before that refuses the key (400): then once more without it.
    claim: async (clipId, device) => {
      try {
        return await call("POST", `${clip(clipId)}/tiktok/mac/claim`, { device, version: VERSION });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 400)) throw e;
        return call("POST", `${clip(clipId)}/tiktok/mac/claim`, { device });
      }
    },
    // ``attempt`` (the claim's number, MacJob.attempt) makes an older try of this Mac unable to write (§47.3).
    step: (clipId, device, step, attempt) =>
      call("POST", `${clip(clipId)}/tiktok/mac/step`, { device, step, ...withAttempt(attempt) }),
    done: (clipId, device, link, attempt) =>
      call("POST", `${clip(clipId)}/tiktok/mac/done`, { device, ...(link ? { link } : {}), ...withAttempt(attempt) }),
    // ``code`` (§47.11): "login" only for a stop that is a TikTok login problem and nothing else; sent only when given.
    stopped: (clipId, device, reason, needsYou = false, attempt, code) =>
      call("POST", `${clip(clipId)}/tiktok/mac/stopped`, {
        device,
        reason,
        ...(needsYou ? { needsYou: true } : {}),
        ...withAttempt(attempt),
        ...withCode(code),
      }),
    // §47.11: this Mac's Chrome is logged in to Clip Factory's TikTok again, so its login hold on that clip ends.
    loggedIn: (clipId, device) => call("POST", `${clip(clipId)}/tiktok/mac/logged-in`, { device }),
    file: (clipId) => call("GET", `${clip(clipId)}/file`),
    clip: (clipId) => call("GET", clip(clipId)),
    posts: (clipId) => call("GET", `/posts?clipId=${encodeURIComponent(clipId)}`),
    settings: (patch) => call("PUT", "/settings", patch),
    send: (clipIds) => call("POST", "/tiktok/mac/send", { clipIds }),
    // 1.2.0, reads only: which TikTok Clip Factory posts to (the clips lane's target, D3), and the workspaces (the
    // ws lanes).
    accounts: () => call("GET", "/accounts"),
    workspaces: () => call("GET", "/workspaces"),
  };
}

/**
 * One Clips Funded workspace's Mac routes (§47.10.4), with the same method shape as client(). Its job ids are the
 * PublishingJob's ``publishingJobId`` (the lane puts it in ``clipId`` so the plan, beats and ledger run unchanged).
 */
export function wsClient(apiUrl, token, workspaceId, fetchImpl = fetch) {
  const call = caller(apiUrl, token, fetchImpl, "Clips Funded");
  const ws = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const job = (id) => `${ws}/publishing/${encodeURIComponent(id)}/mac`;
  return {
    // The queue is empty for a helper below MAC_WS_FROM, so the version always goes with it.
    queue: () => call("GET", `${ws}/tiktok/mac?version=${encodeURIComponent(VERSION)}`),
    ping: (body) => call("POST", `${ws}/tiktok/mac/ping`, body),
    login: () => call("POST", `${ws}/tiktok/mac/login`, { action: "sign_in" }),
    claim: (id, device) => call("POST", `${job(id)}/claim`, { device, version: VERSION }),
    step: (id, device, step, attempt) => call("POST", `${job(id)}/step`, { device, step, ...withAttempt(attempt) }),
    done: (id, device, link, attempt) => call("POST", `${job(id)}/done`, { device, link, ...withAttempt(attempt) }),
    stopped: (id, device, reason, needsYou = false, attempt, code) =>
      call("POST", `${job(id)}/stopped`, {
        device,
        reason,
        ...(needsYou ? { needsYou: true } : {}),
        ...withAttempt(attempt),
        ...withCode(code),
      }),
    loggedIn: (id, device) => call("POST", `${job(id)}/logged-in`, { device }),
    /** The finished video's link (``{url, filename}``); the helper saves it under the job's own fileName. */
    file: (wsJob) => call("GET", `${ws}/stories/${encodeURIComponent(wsJob.storyId)}/download`),
    story: (storyId) => call("GET", `${ws}/stories/${encodeURIComponent(storyId)}`),
    publishing: () => call("GET", `${ws}/publishing`),
  };
}
