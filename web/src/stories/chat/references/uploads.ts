// Reference videos on their way up (docs/CONTRACTS.md §45.28): the checks first (MP4 or MOV, ≤ 2 GB, ≤ 10 minutes
// when the browser can tell), then POST …/references (the multipart addresses), the parts with their progress, and
// …/complete with every part's ETag. Kept outside the page, so an upload keeps going (and its progress shows again)
// when the owner looks at another page meanwhile. Stop deletes the half-made reference.
import { useSyncExternalStore } from "react";
import { storiesApi } from "../../api/client.ts";
import type { ReferenceVideo } from "../../api/types.ts";
import { sentence } from "../kit.tsx";
import { putParts, titleFromName, UploadStopped, VIDEO_MAX_SEC, videoProblem, videoSeconds, videoType, type MultipartTarget } from "../upload.ts";

export interface UploadJob {
  key: string;
  ws: string;
  title: string;
  bytes: number;
  fraction: number;
  partsDone: number;
  parts: number;
  status: "checking" | "uploading" | "finishing" | "done" | "failed" | "stopped";
  problem: string | null;
  /** false when the file itself is the problem (wrong type, too big, too long): picking another one is the fix */
  retry: boolean;
  refId: string | null;
  reference: ReferenceVideo | null;
}

interface Running extends UploadJob {
  file: File;
  controller: AbortController;
}

let jobs: Running[] = [];
let snapshot: UploadJob[] = [];
const listeners = new Set<() => void>();
/** The file itself for videos sent from this device this visit, so the page can play it before the server's link. */
const localVideos = new Map<string, string>();

function publish(): void {
  snapshot = jobs.map(({ file: _f, controller: _c, ...rest }) => ({ ...rest }));
  for (const fn of listeners) fn();
}

function update(key: string, patch: Partial<Running>): void {
  jobs = jobs.map((j) => (j.key === key ? { ...j, ...patch } : j));
  publish();
}

export function localVideo(refId: string): string | null {
  return localVideos.get(refId) ?? null;
}

let seq = 0;

/** Checks and sends one video; answers its upload key at once (follow it with useUploads). */
export function startUpload(ws: string, file: File, onDone?: (ref: ReferenceVideo) => void): string {
  seq += 1;
  const key = `up-${seq}`;
  const job: Running = { key, ws, title: titleFromName(file.name), bytes: file.size, fraction: 0, partsDone: 0, parts: 0, status: "checking", problem: null, retry: true, refId: null, reference: null, file, controller: new AbortController() };
  jobs = [...jobs.filter((j) => j.status !== "done" && j.status !== "stopped"), job];
  publish();
  void run(job, onDone);
  return key;
}

async function run(job: Running, onDone?: (ref: ReferenceVideo) => void): Promise<void> {
  const { key, ws, file, controller } = job;
  const bad = videoProblem(file);
  if (bad) return update(key, { status: "failed", problem: bad, retry: false });
  const sec = await videoSeconds(file);
  if (sec !== null && sec > VIDEO_MAX_SEC + 0.5) return update(key, { status: "failed", problem: "That video is longer than 10 minutes. Pick a shorter one.", retry: false });
  if (controller.signal.aborted) return update(key, { status: "stopped" });
  let refId: string | null = null;
  try {
    const made = await storiesApi().createReference(ws, { filename: file.name, contentType: videoType(file)!, size: file.size, title: job.title });
    refId = made.reference.refId;
    if (typeof URL.createObjectURL === "function") localVideos.set(refId, URL.createObjectURL(file));
    update(key, { status: "uploading", refId, reference: made.reference, parts: made.upload.parts.length });
    const parts = await putParts(made.upload as MultipartTarget, file, (p) => update(key, { fraction: p.fraction, partsDone: p.partsDone, parts: p.parts }), controller.signal);
    update(key, { status: "finishing", fraction: 1 });
    const reference = await storiesApi().completeReference(ws, refId, parts);
    update(key, { status: "done", reference });
    onDone?.(reference);
    setTimeout(() => dismissUpload(key), 4000);
  } catch (e) {
    const stopped = e instanceof UploadStopped || controller.signal.aborted;
    if (refId) {
      // Half an upload is no use to anyone: take the reference away again (best effort).
      try {
        void storiesApi()
          .deleteReference(ws, refId)
          .catch(() => undefined);
      } catch {
        // The app is going away: nothing left to tidy here.
      }
      const url = localVideos.get(refId);
      if (url) URL.revokeObjectURL(url);
      localVideos.delete(refId);
    }
    update(key, stopped ? { status: "stopped", refId: null } : { status: "failed", refId: null, problem: sentence(e, "The upload stopped before it finished. Check your connection and try again.") });
  }
}

export function stopUpload(key: string): void {
  const j = jobs.find((x) => x.key === key);
  if (!j) return;
  j.controller.abort();
  if (j.status === "checking") update(key, { status: "stopped" });
}

/** Sends the same file again after a failure. */
export function retryUpload(key: string, onDone?: (ref: ReferenceVideo) => void): string | null {
  const j = jobs.find((x) => x.key === key);
  if (!j) return null;
  jobs = jobs.filter((x) => x.key !== key);
  return startUpload(j.ws, j.file, onDone);
}

export function dismissUpload(key: string): void {
  jobs = jobs.filter((x) => x.key !== key);
  publish();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUploads(ws: string): UploadJob[] {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  return all.filter((j) => j.ws === ws);
}

/** Test hook. */
export function forgetUploads(): void {
  for (const j of jobs) j.controller.abort();
  jobs = [];
  publish();
}
