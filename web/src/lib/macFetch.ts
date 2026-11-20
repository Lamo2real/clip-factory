// Mac fetches it (docs/CONTRACTS.md §35). When YouTube blocks the cloud, the Clip Factory app on the owner's Mac (or
// Windows PC) gets the video on its own home connection and sends it to the job. The desktop window exposes four
// commands as window.__CF_MAC_FETCH__ (desktop/src-tauri/src/init.js); this file drives them:
//
//   1. a job waits for a Mac (job.macFetch.state "waiting", or "getting"/"sending" from this computer) → start;
//   2. while it downloads, the app's progress goes to the API about every 5 s (the job's live line moves);
//   3. downloaded → the API gives one signed address per 64 MB part → the app sends the parts itself;
//   4. sent → the API finishes the upload and the job goes on as an upload; the app removes its copy.
//
// Nothing here ever sees the video's bytes, a cookie or yt-dlp's text: the app reports only codes and numbers.
import type { Api, Job } from "../api/types.ts";
import { ApiError } from "../api/errors.ts";

export type MacPhase = "tools" | "getting" | "ready" | "sending" | "sent" | "failed";

export interface MacStatus {
  phase: MacPhase;
  pct: number;
  size?: number;
  height?: number;
  title?: string;
  creator?: string;
  durationSec?: number;
  /** A code: blocked, gone, live, full, tools, failed, send, canceled. */
  error?: string;
  needGb?: number;
  etags?: { n: number; etag: string }[];
}

export interface MacBridge {
  version: number;
  start(jobId: string, url: string): Promise<MacStatus>;
  status(jobId: string): Promise<MacStatus | null>;
  upload(jobId: string, partSize: number, parts: { n: number; url: string }[]): Promise<MacStatus>;
  cancel(jobId: string): Promise<boolean>;
}

/** The desktop app's commands, or null in a browser (or an app from before §35). */
export function macBridge(win: unknown = typeof window === "undefined" ? undefined : window): MacBridge | null {
  const b = (win as { __CF_MAC_FETCH__?: Partial<MacBridge> } | undefined)?.__CF_MAC_FETCH__;
  if (!b || b.version !== 1) return null;
  const fns = [b.start, b.status, b.upload, b.cancel];
  return fns.every((f) => typeof f === "function") ? (b as MacBridge) : null;
}

/** Whether this window can fetch videos itself (the desktop app with §35). */
export function canMacFetch(win?: unknown): boolean {
  return macBridge(win) !== null;
}

const WORKING = new Set(["waiting", "getting", "sending"]);

/** A job this computer should work on now: still running, waiting for a Mac, with the link it came from. */
export function wantsMac(job: Job): boolean {
  const state = job.macFetch?.state;
  return (
    (job.status === "queued" || job.status === "running") &&
    state !== undefined &&
    WORKING.has(state) &&
    job.source.type === "link" &&
    typeof job.source.url === "string"
  );
}

/** Made once per app and kept, so the API can tell this computer from another one (§35.3). */
export function macDeviceId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  const key = "cf.macDevice";
  try {
    const kept = storage?.getItem(key);
    if (kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept)) return kept;
  } catch {
    /* private window or blocked storage: a fresh id for this session */
  }
  const id = `mac-${randomId()}`;
  try {
    storage?.setItem(key, id);
  } catch {
    /* kept for this session only */
  }
  return id;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How often the app is asked where it is, and how often that goes to the API. */
export const POLL_MS = 1000;
export const REPORT_MS = 5000;

export interface MacFetcherDeps {
  api: Pick<Api, "macProgress" | "macSourceUpload" | "macSourceComplete">;
  bridge: MacBridge;
  deviceId: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Drives the app for every job that waits for a Mac; one run per job at a time. */
export class MacFetcher {
  private readonly running = new Map<string, { stop: boolean }>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: MacFetcherDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Looks at a job (from a list, a fetch or a live event): starts on it, or stops when it no longer waits. */
  consider(job: Job): void {
    const run = this.running.get(job.jobId);
    if (wantsMac(job)) {
      if (!run) void this.run(job);
      return;
    }
    if (run) {
      run.stop = true;
      void this.deps.bridge.cancel(job.jobId).catch(() => undefined);
    }
  }

  /** Jobs this computer is working on now (tests, and the waiting card). */
  active(): string[] {
    return [...this.running.keys()];
  }

  stopAll(): void {
    for (const [jobId, run] of this.running) {
      run.stop = true;
      void this.deps.bridge.cancel(jobId).catch(() => undefined);
    }
  }

  private async run(job: Job): Promise<void> {
    const run = { stop: false };
    this.running.set(job.jobId, run);
    try {
      await this.fetchAndSend(job, run);
    } catch {
      // A failed call is tried again on the next look at the job (a live event, or the 30-second list).
    } finally {
      this.running.delete(job.jobId);
    }
  }

  private async fetchAndSend(job: Job, run: { stop: boolean }): Promise<void> {
    const { api, bridge, deviceId } = this.deps;
    const jobId = job.jobId;
    let status = await bridge.status(jobId);
    if (!status || (status.phase === "failed" && status.size === undefined)) {
      status = await bridge.start(jobId, job.source.url!);
    }
    let reported = -Infinity;
    let uploading = false;
    for (;;) {
      if (run.stop) return;
      if (status.phase === "failed") {
        if (status.error === "canceled") return;
        await this.report(jobId, { deviceId, phase: "failed", error: status.error ?? "failed", needGb: status.needGb });
        await bridge.cancel(jobId);
        return;
      }
      if (status.phase === "ready" && !uploading) {
        const parts = await api.macSourceUpload(jobId, { deviceId, size: status.size ?? 0 });
        status = await bridge.upload(jobId, parts.partSize, parts.parts);
        uploading = true;
        continue;
      }
      if (status.phase === "sent") {
        await api.macSourceComplete(jobId, {
          deviceId,
          parts: status.etags ?? [],
          title: status.title,
          creator: status.creator,
          durationSec: status.durationSec,
        });
        await bridge.cancel(jobId);
        return;
      }
      if (this.now() - reported >= REPORT_MS) {
        reported = this.now();
        const phase = status.phase === "sending" ? "sending" : "getting";
        const keepGoing = await this.report(jobId, { deviceId, phase, pct: Math.max(0, Math.min(100, status.pct)) });
        if (!keepGoing) {
          run.stop = true;
          await bridge.cancel(jobId);
          return;
        }
      }
      await this.sleep(POLL_MS);
      const next = await bridge.status(jobId);
      if (!next) return; // canceled from elsewhere
      status = next;
    }
  }

  /** Sends progress; false when the job no longer waits for this computer (stopped, or another Mac has it). */
  private async report(jobId: string, body: Parameters<Api["macProgress"]>[1]): Promise<boolean> {
    try {
      await this.deps.api.macProgress(jobId, body);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return false;
      return true; // a busy server or a 429: the next report says the same
    }
  }
}

/** The owner's words for a job that waits for a Mac (§35.5); null when it does not wait. */
export function macWaitWords(job: Job, here: boolean): { title: string; hint?: string } | null {
  const m = job.macFetch;
  if (!m || !wantsMac(job)) return null;
  if (m.state === "getting") return { title: `Your Mac is getting the video: ${m.pct ?? 0}%` };
  if (m.state === "sending") return { title: `Your Mac is sending the video: ${m.pct ?? 0}%` };
  if (here) return { title: "Waiting for your Mac to get the video" };
  return { title: "Waiting for your Mac to get the video", hint: "Open Clip Factory on your Mac to continue." };
}

/** How often the whole job list is read again while the desktop app is open (live events cover the rest). */
export const RELIST_MS = 30_000;
