// Clip Factory's routes the helper uses (docs/CONTRACTS.md §42, §47). Every call carries the owner's access token.

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
    step: (clipId, device, step) => call("POST", `${clip(clipId)}/tiktok/mac/step`, { device, step }),
    done: (clipId, device, link) => call("POST", `${clip(clipId)}/tiktok/mac/done`, { device, ...(link ? { link } : {}) }),
    stopped: (clipId, device, reason, needsYou = false) =>
      call("POST", `${clip(clipId)}/tiktok/mac/stopped`, { device, reason, ...(needsYou ? { needsYou: true } : {}) }),
    file: (clipId) => call("GET", `${clip(clipId)}/file`),
  };
}
