// Clip Factory's routes the helper uses (docs/CONTRACTS.md §42, §47). Every call carries the owner's access token.

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const withAttempt = (attempt) => (Number.isInteger(attempt) && attempt >= 1 ? { attempt } : {});

export function client(apiUrl, token, fetchImpl = fetch) {
  async function call(method, path, body) {
    const res = await fetchImpl(`${apiUrl}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw new ApiError(res.status, err.message || `Clip Factory answered ${res.status}.`, err.code);
    }
    return data;
  }
  const clip = (id) => `/clips/${encodeURIComponent(id)}`;
  return {
    queue: () => call("GET", "/tiktok/mac"),
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
    settings: (patch) => call("PUT", "/settings", patch),
    send: (clipIds) => call("POST", "/tiktok/mac/send", { clipIds }),
  };
}
