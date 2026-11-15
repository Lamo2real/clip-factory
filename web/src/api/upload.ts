import { uploadError } from "./errors.ts";
import type { PresignedPut } from "./types.ts";

/**
 * PUTs a file straight to S3 with the presigned URL. XHR, not fetch, because only XHR reports upload progress.
 * The mock API hands out mock:// URLs; those simulate a quick upload so the progress bar can be seen.
 */
export function putFile(
  target: PresignedPut,
  file: Blob,
  onProgress: (fraction: number) => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (target.uploadUrl.startsWith("mock:")) return simulate(file.size, onProgress, signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.uploadUrl);
    for (const [k, v] of Object.entries(target.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else reject(uploadError(xhr.status));
    };
    xhr.onerror = () => reject(uploadError());
    xhr.onabort = () => reject(new DOMException("Upload canceled", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

function simulate(size: number, onProgress: (f: number) => void, signal?: AbortSignal): Promise<void> {
  const steps = 20;
  const each = Math.min(120, Math.max(40, size / 4_000_000));
  return new Promise((resolve, reject) => {
    let i = 0;
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        reject(new DOMException("Upload canceled", "AbortError"));
        return;
      }
      i += 1;
      onProgress(i / steps);
      if (i >= steps) {
        clearInterval(timer);
        resolve();
      }
    }, each);
  });
}
