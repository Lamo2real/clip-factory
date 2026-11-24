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

function caller(apiUrl, token, fetchImpl, app) {
  return async function call(method, path, body) {
    // The saved TikTok password never leaves the Mac: a request that would carry it is never sent.
    if (holdsSecret(path) || (body && holdsSecret(JSON.stringify(body)))) {
      throw new ApiError(0, "The helper refused to send something secret.", "secret");
    }
    const res = await fetchImpl(`${apiUrl}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
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
    claim: (clipId, device) => call("POST", `${clip(clipId)}/tiktok/mac/claim`, { device }),
    // ``attempt`` (the claim's number, MacJob.attempt) makes an older try of this Mac unable to write (§47.3).
    step: (clipId, device, step, attempt) =>
      call("POST", `${clip(clipId)}/tiktok/mac/step`, { device, step, ...withAttempt(attempt) }),
    done: (clipId, device, link, attempt) =>
      call("POST", `${clip(clipId)}/tiktok/mac/done`, { device, ...(link ? { link } : {}), ...withAttempt(attempt) }),
    stopped: (clipId, device, reason, needsYou = false, attempt) =>
      call("POST", `${clip(clipId)}/tiktok/mac/stopped`, {
        device,
        reason,
        ...(needsYou ? { needsYou: true } : {}),
        ...withAttempt(attempt),
      }),
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
    stopped: (id, device, reason, needsYou = false, attempt) =>
      call("POST", `${job(id)}/stopped`, {
        device,
        reason,
        ...(needsYou ? { needsYou: true } : {}),
        ...withAttempt(attempt),
      }),
    /** The finished video's link (``{url, filename}``); the helper saves it under the job's own fileName. */
    file: (wsJob) => call("GET", `${ws}/stories/${encodeURIComponent(wsJob.storyId)}/download`),
    story: (storyId) => call("GET", `${ws}/stories/${encodeURIComponent(storyId)}`),
    publishing: () => call("GET", `${ws}/publishing`),
  };
}
