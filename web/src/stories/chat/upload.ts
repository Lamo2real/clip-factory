// Files from this device straight to storage (docs/CONTRACTS.md §45.5, §45.27, §45.28): chat pictures with one
// presigned PUT (≤ 5 MB), reference videos with a presigned multipart upload (≤ 2 GB, parts of about 100 MB, each
// part's ETag sent back to finish it). XMLHttpRequest, because only it reports upload progress. The mock hands out
// mock:// addresses; those pretend to upload quickly so the progress can be seen.
import { putFile } from "../../api/upload.ts";
import type { Upload } from "../api/types.ts";

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const PICTURE_MAX = 5 * 1024 * 1024;
export const PICTURES_PER_MESSAGE = 4;

export const VIDEO_MAX = 2 * 1024 * 1024 * 1024;
export const VIDEO_MAX_SEC = 600;

/** Why this file cannot go into a chat message, or null. */
export function pictureProblem(f: { type: string; size: number }): string | null {
  if (!PICTURE_TYPES.includes(f.type)) return "Pick a PNG, JPG or WebP picture.";
  if (f.size > PICTURE_MAX) return "That picture is too big. Pick one under 5 MB.";
  return null;
}

/** The video's type as the server wants it ("video/mp4" or "video/quicktime"), from its type or its name. */
export function videoType(f: { type: string; name: string }): "video/mp4" | "video/quicktime" | null {
  if (f.type === "video/mp4" || f.type === "video/quicktime") return f.type;
  if (/\.mp4$/i.test(f.name) || /\.m4v$/i.test(f.name)) return "video/mp4";
  if (/\.mov$/i.test(f.name)) return "video/quicktime";
  return null;
}

/** Why this file cannot be a reference video, or null (its length is checked separately, when it can be read). */
export function videoProblem(f: { type: string; name: string; size: number }): string | null {
  if (!videoType(f)) return "Pick an MP4 or MOV video.";
  if (f.size <= 0) return "That video is empty. Pick another one.";
  if (f.size > VIDEO_MAX) return "That video is too big. Pick one under 2 GB.";
  return null;
}

/** A title from the file's name ("my_fav-clip.mp4" → "my fav clip"). */
export function titleFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "Reference video").slice(0, 80);
}

/** The video's length in seconds, read by the browser, or null when it cannot tell (the agent checks it anyway). */
export function videoSeconds(file: Blob, timeoutMs = 4000): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (sec: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(sec);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
    v.onerror = () => finish(null);
    v.src = url;
  });
}

/** One picture for the chat. */
export function putPicture(target: Upload, file: Blob, onProgress: (f: number) => void, signal?: AbortSignal): Promise<void> {
  return putFile({ key: target.assetId, uploadUrl: target.uploadUrl, headers: target.headers }, file, onProgress, signal);
}

export class UploadStopped extends Error {
  constructor() {
    super("The upload was stopped.");
    this.name = "UploadStopped";
  }
}

export class UploadFailed extends Error {
  constructor(message = "The upload stopped before it finished. Check your connection and try again.") {
    super(message);
    this.name = "UploadFailed";
  }
}

export type PartPut = (url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<string>;

/** PUTs one part and answers its ETag (the media bucket exposes it to the app, CORS `ExposeHeaders: ETag`). */
export const xhrPart: PartPut = (url, body, onProgress, signal) => {
  if (url.startsWith("mock:")) return simulatePart(url, body.size, onProgress, signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(body.size, e.loaded));
    };
    xhr.onload = () => {
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) {
        onProgress(body.size);
        resolve(etag);
      } else reject(new UploadFailed());
    };
    xhr.onerror = () => reject(new UploadFailed());
    xhr.onabort = () => reject(new UploadStopped());
    if (signal.aborted) return reject(new UploadStopped());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
};

function simulatePart(url: string, size: number, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  const steps = 12;
  return new Promise((resolve, reject) => {
    let i = 0;
    const timer = setInterval(() => {
      if (signal.aborted) {
        clearInterval(timer);
        reject(new UploadStopped());
        return;
      }
      i += 1;
      onProgress((size * i) / steps);
      if (i >= steps) {
        clearInterval(timer);
        resolve(`"mock-${url.split("/").pop() ?? "part"}"`);
      }
    }, 60);
  });
}

export interface MultipartTarget {
  parts: { partNumber: number; url: string }[];
  /** Bytes per part, when the server says (else the file is cut into as many equal parts as there are addresses). */
  partSize?: number;
}

/** Bytes [start, end) of part `partNumber` (1-based). */
export function partRange(size: number, count: number, partNumber: number, partSize?: number): [number, number] {
  const each = partSize && partSize > 0 ? partSize : Math.ceil(size / Math.max(1, count));
  const start = (partNumber - 1) * each;
  const end = partNumber === count ? size : Math.min(size, start + each);
  return [start, end];
}

export interface MultipartProgress {
  /** 0..1 over the whole file */
  fraction: number;
  partsDone: number;
  parts: number;
}

/**
 * Sends every part (three at a time, each tried twice), reporting progress over the whole file, and answers the
 * parts in order with their ETags for …/complete. Stops at once when `signal` aborts.
 */
export async function putParts(
  target: MultipartTarget,
  file: Blob,
  onProgress: (p: MultipartProgress) => void,
  signal: AbortSignal,
  put: PartPut = xhrPart,
): Promise<{ partNumber: number; etag: string }[]> {
  const parts = [...target.parts].sort((a, b) => a.partNumber - b.partNumber);
  const n = parts.length;
  if (!n) throw new UploadFailed();
  const loaded = new Map<number, number>();
  let done = 0;
  const report = () => {
    let sum = 0;
    for (const v of loaded.values()) sum += v;
    onProgress({ fraction: file.size ? Math.min(1, sum / file.size) : 1, partsDone: done, parts: n });
  };
  const out: { partNumber: number; etag: string }[] = [];
  // One failed part stops the others too (and so does the owner's Stop).
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal.aborted) throw new UploadStopped();
  signal.addEventListener("abort", stop, { once: true });
  let next = 0;
  const worker = async () => {
    while (next < n) {
      if (inner.signal.aborted) throw new UploadStopped();
      const part = parts[next++]!;
      const [start, end] = partRange(file.size, n, part.partNumber, target.partSize);
      const body = file.slice(start, end);
      let etag: string | null = null;
      for (let attempt = 0; attempt < 2 && etag === null; attempt++) {
        try {
          etag = await put(
            part.url,
            body,
            (b) => {
              loaded.set(part.partNumber, b);
              report();
            },
            inner.signal,
          );
        } catch (e) {
          if (e instanceof UploadStopped || inner.signal.aborted) throw new UploadStopped();
          loaded.set(part.partNumber, 0);
          if (attempt === 1) throw e instanceof UploadFailed ? e : new UploadFailed();
        }
      }
      done += 1;
      loaded.set(part.partNumber, end - start);
      report();
      out.push({ partNumber: part.partNumber, etag: etag! });
    }
  };
  report();
  try {
    await Promise.all(Array.from({ length: Math.min(3, n) }, worker));
  } catch (e) {
    inner.abort();
    throw signal.aborted ? new UploadStopped() : e;
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return out.sort((a, b) => a.partNumber - b.partNumber);
}
