import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError } from "../src/api/errors.ts";
import type { Job, MacProgress } from "../src/api/types.ts";
import {
  canMacFetch,
  macBridge,
  macDeviceId,
  MacFetcher,
  macWaitWords,
  RETRY_WAITS,
  wantsMac,
  type MacBridge,
  type MacStatus,
} from "../src/lib/macFetch.ts";
import { MacWait } from "../src/screens/jobs/MacWait.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";

function job(over: Partial<Job> = {}): Job {
  return {
    jobId: JOB_ID,
    status: "running",
    source: { type: "link", platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    clipTarget: { min: 5, max: 10 },
    steps: [],
    progress: 0.1,
    clipCount: 0,
    macFetch: { state: "waiting", since: "2026-11-20T10:00:00Z" },
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    ...over,
  };
}

/** A pretend desktop app that walks through the given statuses, one per look. */
function fakeBridge(script: MacStatus[]): MacBridge & { calls: string[] } {
  const calls: string[] = [];
  let i = -1;
  const next = () => script[Math.min(++i, script.length - 1)]!;
  return {
    version: 1,
    calls,
    async start(jobId, url) {
      calls.push(`start ${jobId} ${url}`);
      return next();
    },
    async status() {
      calls.push("status");
      return i < 0 ? null : next();
    },
    async upload(jobId, partSize, parts) {
      calls.push(`upload ${partSize} ${parts.length}`);
      return next();
    },
    async cancel(jobId) {
      calls.push(`cancel ${jobId}`);
      return true;
    },
  };
}

function fakeApi(fail?: (body: MacProgress) => Error | null) {
  const seen: { progress: MacProgress[]; uploads: number[]; complete: unknown[] } = { progress: [], uploads: [], complete: [] };
  return {
    seen,
    api: {
      async macProgress(_jobId: string, body: MacProgress) {
        const err = fail?.(body);
        if (err) throw err;
        seen.progress.push(body);
        return job();
      },
      async macSourceUpload(_jobId: string, body: { deviceId: string; size: number }) {
        seen.uploads.push(body.size);
        return { partSize: 64 * 1024 * 1024, parts: [{ n: 1, url: "https://bucket.s3.eu-north-1.amazonaws.com/uploads/x?partNumber=1" }] };
      },
      async macSourceComplete(_jobId: string, body: unknown) {
        seen.complete.push(body);
        return job({ status: "queued" });
      },
    },
  };
}

async function settle(fetcher: MacFetcher) {
  for (let i = 0; i < 200 && fetcher.active().length; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("the desktop bridge", () => {
  it("is found only in a desktop app with Mac fetches it", () => {
    expect(macBridge({})).toBeNull();
    expect(canMacFetch({})).toBe(false);
    const b = fakeBridge([]);
    expect(macBridge({ __CF_MAC_FETCH__: b })).toBe(b);
    expect(macBridge({ __CF_MAC_FETCH__: { ...b, version: 2 } })).toBeNull();
    expect(macBridge({ __CF_MAC_FETCH__: { version: 1, start: () => null } })).toBeNull();
  });

  it("works only on running YouTube link jobs that wait for a Mac", () => {
    expect(wantsMac(job())).toBe(true);
    expect(wantsMac(job({ macFetch: { state: "getting", pct: 5 } }))).toBe(true);
    expect(wantsMac(job({ macFetch: { state: "cloud" } }))).toBe(false);
    expect(wantsMac(job({ macFetch: { state: "done" } }))).toBe(false);
    expect(wantsMac(job({ status: "failed" }))).toBe(false);
    expect(wantsMac(job({ macFetch: undefined }))).toBe(false);
    expect(wantsMac(job({ source: { type: "upload", platform: "upload", key: "k" } }))).toBe(false);
  });

  it("keeps one device id per app", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const id = macDeviceId(storage);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(macDeviceId(storage)).toBe(id);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(macDeviceId(broken)).toMatch(/^mac-/);
  });
});

describe("MacFetcher", () => {
  it("gets the video, reports about every 5 seconds, sends it and finishes the upload", async () => {
    const bridge = fakeBridge([
      { phase: "tools", pct: 0 },
      { phase: "getting", pct: 10 },
      { phase: "getting", pct: 60 },
      { phase: "ready", pct: 100, size: 1234, title: "Me at the zoo", creator: "jawed", durationSec: 19 },
      { phase: "sending", pct: 50 },
      { phase: "sent", pct: 100, size: 1234, title: "Me at the zoo", creator: "jawed", durationSec: 19, etags: [{ n: 1, etag: '"e1"' }] },
    ]);
    const { api, seen } = fakeApi();
    let t = 0;
    const fetcher = new MacFetcher({
      api,
      bridge,
      deviceId: "mac-device-0001",
      sleep: async () => void (t += 1000),
      now: () => t,
    });
    fetcher.consider(job());
    fetcher.consider(job()); // one run per job
    await settle(fetcher);
    expect(bridge.calls.filter((c) => c.startsWith("start"))).toEqual([
      `start ${JOB_ID} https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
    ]);
    expect(seen.uploads).toEqual([1234]);
    expect(seen.complete).toEqual([
      { deviceId: "mac-device-0001", parts: [{ n: 1, etag: '"e1"' }], title: "Me at the zoo", creator: "jawed", durationSec: 19 },
    ]);
    expect(bridge.calls.at(-1)).toBe(`cancel ${JOB_ID}`);
    expect(seen.progress.length).toBeGreaterThan(0);
    expect(seen.progress.length).toBeLessThan(4); // not every second
    expect(seen.progress.every((p) => p.deviceId === "mac-device-0001")).toBe(true);
  });

  it("says why when the Mac cannot get the video, and cleans up", async () => {
    const bridge = fakeBridge([{ phase: "tools", pct: 0 }, { phase: "failed", pct: 0, error: "full", needGb: 6 }]);
    const { api, seen } = fakeApi();
    const fetcher = new MacFetcher({ api, bridge, deviceId: "mac-device-0001", sleep: async () => {} });
    fetcher.consider(job());
    await settle(fetcher);
    expect(seen.progress.at(-1)).toEqual({ deviceId: "mac-device-0001", phase: "failed", error: "full", needGb: 6 });
    expect(bridge.calls.at(-1)).toBe(`cancel ${JOB_ID}`);
  });

  it("stops when another computer has the job or it no longer waits", async () => {
    const bridge = fakeBridge([{ phase: "getting", pct: 1 }]);
    const { api } = fakeApi(() => new ApiError(409, "conflict", "Another computer is already getting this video."));
    const fetcher = new MacFetcher({ api, bridge, deviceId: "mac-device-0001", sleep: async () => {} });
    fetcher.consider(job());
    await settle(fetcher);
    expect(bridge.calls.at(-1)).toBe(`cancel ${JOB_ID}`);
    expect(fetcher.active()).toEqual([]);
  });

  it("sends again, with fresh addresses, when the connection drops while sending", async () => {
    const bridge = fakeBridge([
      { phase: "getting", pct: 5 },
      { phase: "ready", pct: 100, size: 1234 },
      { phase: "failed", pct: 40, size: 1234, error: "send" },
      { phase: "sent", pct: 100, size: 1234, etags: [{ n: 1, etag: '"e1"' }] },
    ]);
    const { api, seen } = fakeApi();
    const fetcher = new MacFetcher({ api, bridge, deviceId: "mac-device-0001", sleep: async () => {} });
    fetcher.consider(job());
    await settle(fetcher);
    expect(seen.uploads).toEqual([1234, 1234]); // asked for new addresses; the same upload, so sent parts stay sent
    expect(bridge.calls.filter((c) => c.startsWith("upload"))).toHaveLength(2);
    expect(seen.complete).toHaveLength(1);
    expect(seen.progress.some((p) => p.phase === "failed")).toBe(false); // the job was never failed
  });

  it("starts the download again (it carries on from what it has) after a hiccup", async () => {
    const bridge = fakeBridge([
      { phase: "getting", pct: 5 },
      { phase: "failed", pct: 5, error: "failed" },
      { phase: "getting", pct: 20 },
      { phase: "ready", pct: 100, size: 99 },
      { phase: "sent", pct: 100, size: 99, etags: [{ n: 1, etag: '"e"' }] },
    ]);
    const { api, seen } = fakeApi();
    const fetcher = new MacFetcher({ api, bridge, deviceId: "mac-device-0001", sleep: async () => {} });
    fetcher.consider(job());
    await settle(fetcher);
    expect(bridge.calls.filter((c) => c.startsWith("start"))).toHaveLength(2);
    expect(seen.complete).toHaveLength(1);
    expect(seen.progress.some((p) => p.phase === "failed")).toBe(false);
  });

  it("fails the job only after the tries run out, and never retries what no retry can fix", async () => {
    const stuck = fakeBridge([{ phase: "getting", pct: 5 }, { phase: "failed", pct: 5, error: "failed" }]);
    const one = fakeApi();
    const waits: number[] = [];
    const fetcher = new MacFetcher({
      api: one.api,
      bridge: stuck,
      deviceId: "mac-device-0001",
      sleep: async (ms) => void waits.push(ms),
    });
    fetcher.consider(job());
    await settle(fetcher);
    expect(stuck.calls.filter((c) => c.startsWith("start"))).toHaveLength(1 + RETRY_WAITS.length);
    expect(waits.filter((w) => w > 1000)).toEqual(RETRY_WAITS);
    expect(one.seen.progress.at(-1)).toMatchObject({ phase: "failed", error: "failed" });
    expect(stuck.calls.at(-1)).toBe(`cancel ${JOB_ID}`);

    const blocked = fakeBridge([{ phase: "getting", pct: 0 }, { phase: "failed", pct: 0, error: "blocked" }]);
    const two = fakeApi();
    const f2 = new MacFetcher({ api: two.api, bridge: blocked, deviceId: "mac-device-0001", sleep: async () => {} });
    f2.consider(job());
    await settle(f2);
    expect(blocked.calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
    expect(two.seen.progress.at(-1)).toMatchObject({ phase: "failed", error: "blocked" });
  });

  it("stops and deletes its copy when the job was deleted (404)", async () => {
    const bridge = fakeBridge([{ phase: "getting", pct: 1 }]);
    const { api } = fakeApi(() => new ApiError(404, "not_found", "No such job."));
    const fetcher = new MacFetcher({ api, bridge, deviceId: "mac-device-0001", sleep: async () => {} });
    fetcher.consider(job());
    await settle(fetcher);
    expect(bridge.calls.at(-1)).toBe(`cancel ${JOB_ID}`);
    expect(bridge.calls.filter((c) => c === "status")).toHaveLength(1); // no more polling after it
  });

  it("cancels the app's fetch when the owner stops the job", async () => {
    const bridge = fakeBridge([{ phase: "getting", pct: 1 }]);
    const { api } = fakeApi();
    let release = () => {};
    const fetcher = new MacFetcher({
      api,
      bridge,
      deviceId: "mac-device-0001",
      sleep: () => new Promise<void>((r) => (release = r)),
    });
    fetcher.consider(job());
    await new Promise((r) => setTimeout(r, 0));
    fetcher.consider(job({ status: "canceled" }));
    release();
    await settle(fetcher);
    expect(bridge.calls).toContain(`cancel ${JOB_ID}`);
  });
});

describe("the waiting card", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("says what the Mac is doing in plain words", () => {
    expect(macWaitWords(job(), true)).toEqual({ title: "Waiting for your Mac to get the video" });
    expect(macWaitWords(job({ macFetch: { state: "getting", pct: 42 } }), false)?.title).toBe(
      "Your Mac is getting the video: 42%",
    );
    expect(macWaitWords(job({ macFetch: { state: "sending", pct: 63 } }), false)?.title).toBe(
      "Your Mac is sending the video: 63%",
    );
    expect(macWaitWords(job({ status: "ready" }), false)).toBeNull();
  });

  it("asks to open the app on the Mac only after the 2-minute nudge, and never inside the app", () => {
    act(() => root.render(<MacWait job={job()} here={false} />));
    expect(host.textContent).toBe("Waiting for your Mac to get the video");
    const nudged = job({ macFetch: { state: "waiting", nudgedAt: "2026-11-20T10:02:00Z" } });
    act(() => root.render(<MacWait job={nudged} here={false} />));
    expect(host.textContent).toContain("Open Clip Factory on your Mac to continue.");
    act(() => root.render(<MacWait job={nudged} here={true} />));
    expect(host.textContent).not.toContain("Open Clip Factory");
    act(() => root.render(<MacWait job={job({ status: "failed" })} here={false} />));
    expect(host.textContent).toBe("");
  });

  it("has no edges and no cursor rule", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles/components.css"), "utf8");
    const block = css.slice(css.indexOf(".mac-wait__words"), css.indexOf(".mac-wait__hint {") + 200);
    expect(block).not.toMatch(/cursor:|border:|outline:/);
  });
});
