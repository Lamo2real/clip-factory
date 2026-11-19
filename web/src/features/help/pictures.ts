// Pictures in Ask (docs/CONTRACTS.md §26, ADR-48): the browser turns whatever the owner adds (a screenshot, a photo,
// a pasted image) into one small JPEG. Every picture is re-encoded through a canvas, which drops EXIF and GPS, is at
// most 1568 px on its long edge and at most 600 KB. Pictures live in memory only (object URLs, revoked when they
// leave the chat) and are sent once, inside the question.
import { PICTURES_MAX } from "./types.ts";

export { PICTURES_MAX };
export const PICTURE_EDGE = 1568;
export const PICTURE_BYTES_MAX = 600_000;
/** Bigger files are refused before decoding (a phone photo is 2 to 12 MB). */
export const SOURCE_BYTES_MAX = 30 * 1024 * 1024;
/** Pictures kept in the chat's memory; older ones are let go and shown as a picture icon. */
export const KEEP_MAX = 12;
export const QUALITIES = [0.82, 0.72, 0.6] as const;
export const SHRINK = 0.8;
export const SHRINKS_MAX = 3;
/** How long a picture note stays above the field. */
export const NOTE_MS = 5000;

export type PicError = "not_picture" | "cant_open" | "too_big" | "too_many" | "off";

/** The owner-facing words for each case (short, plain, no blame). */
export const PICTURE_TEXT = {
  too_many: "You can add 4 pictures. Take one away first.",
  too_big: "That picture is too big. Try a screenshot.",
  cant_open: "I can't open that picture. Try a screenshot or a photo.",
  not_picture: "That's not a picture. Try a screenshot.",
  off: "Pictures are off right now. Ask me in words.",
  unread: "I couldn't look at your picture this time. Tell me in words, or try again.",
  limit: "You sent lots of pictures today. Ask me in words, or try again tomorrow.",
} as const;

export const ADDED_TEXT = (n: number) => `Picture added. ${n} of ${PICTURES_MAX}.`;
export const READYING_TEXT = "Getting your picture ready…";

export interface Pic {
  id: number;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

// ---------- Which files are pictures ----------

export function isPictureFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);
}

interface FileList_ {
  readonly length: number;
  [i: number]: File | undefined;
}

/** Every file in a drop or a paste, pictures or not (`items` with kind "file", or `files`). */
export function filesFrom(data: Pick<DataTransfer, "items" | "files"> | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const items = data.items as DataTransferItemList | undefined;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it?.kind !== "file") continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
    if (out.length) return out;
  }
  const files = data.files as FileList_ | undefined;
  for (let i = 0; files && i < files.length; i++) {
    const f = files[i];
    if (f) out.push(f);
  }
  return out;
}

/** True when a drag carries files (the drop layer shows only then). */
export function dragHasFiles(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!data && Array.from(data.types ?? []).includes("Files");
}

// ---------- Size and quality ----------

/** Encodes a w×h picture as JPEG at a quality; the browser version draws on a canvas. */
export type Encoder = (width: number, height: number, quality: number) => Promise<Blob | null>;

/** The quality ladder (0.82, 0.72, 0.6), then 0.8 smaller, at most 3 times; null when it never fits. */
export async function fitJpeg(
  width: number,
  height: number,
  encode: Encoder,
  maxBytes = PICTURE_BYTES_MAX,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  let scale = Math.min(1, PICTURE_EDGE / Math.max(width, height, 1));
  for (let shrink = 0; shrink <= SHRINKS_MAX; shrink++) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    for (const q of QUALITIES) {
      const blob = await encode(w, h, q);
      if (blob && blob.size <= maxBytes) return { blob, width: w, height: h };
    }
    scale *= SHRINK;
  }
  return null;
}

// ---------- Decoding and drawing (browser only) ----------

type Source = { image: CanvasImageSource; width: number; height: number; close(): void };

async function decode(file: File): Promise<Source | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Safari and the Mac app decode HEIC through <img>, not createImageBitmap.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return null;
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasEncoder(source: Source): Encoder {
  const canvas = document.createElement("canvas");
  return (w, h, q) => {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    // White under a transparent PNG, so it stays readable as a JPEG.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source.image, 0, 0, w, h);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
  };
}

let picSeq = 0;

/** One added file → a small clean JPEG, or why not. Never throws. */
export async function preparePicture(file: File): Promise<Pic | { error: PicError }> {
  if (!isPictureFile(file)) return { error: "not_picture" };
  if (file.size > SOURCE_BYTES_MAX) return { error: "too_big" };
  const source = await decode(file);
  if (!source) return { error: "cant_open" };
  try {
    const fitted = await fitJpeg(source.width, source.height, canvasEncoder(source));
    if (!fitted) return { error: "too_big" };
    // The canvas already left the photo's own EXIF and GPS behind, but engines add their own segments (an ICC
    // profile in Chromium, a small Exif block in WebKit): those go too, so every engine sends the same clean JPEG.
    const clean = stripJpeg(new Uint8Array(await fitted.blob.arrayBuffer()));
    const blob = clean ? new Blob([clean as BlobPart], { type: "image/jpeg" }) : fitted.blob;
    return { id: ++picSeq, blob, url: URL.createObjectURL(blob), width: fitted.width, height: fitted.height };
  } catch {
    return { error: "cant_open" };
  } finally {
    source.close();
  }
}

/** The picture as base64 without the data: prefix (what the API takes). */
export function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------- Reading a JPEG's header (tests, the mock) ----------

export interface JpegInfo {
  width: number;
  height: number;
  /** An APP1..APP15 segment (EXIF, GPS, XMP) is present. */
  hasExif: boolean;
}

/** Walks the JPEG markers up to the first scan: the frame size and whether metadata is there. Null when it is not
 * a baseline or progressive JPEG (the same rule as api help/pictures.py). */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  if (bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) return null;
  let i = 2;
  let width = 0;
  let height = 0;
  let hasExif = false;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) return null;
    while (i < n && bytes[i] === 0xff) i++;
    const marker = bytes[i++]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    const len = (bytes[i]! << 8) | bytes[i + 1]!;
    if (len < 2 || i + len > n) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      height = (bytes[i + 3]! << 8) | bytes[i + 4]!;
      width = (bytes[i + 5]! << 8) | bytes[i + 6]!;
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null;
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) hasExif = hasExif || marker !== 0xfe;
    if (marker === 0xda) break;
    i += len;
  }
  return width && height ? { width, height, hasExif } : null;
}

/** The JPEG without its APP1..APP15 and COM segments (APP0 stays), as the API does; null when it is not one. The
 * markers are walked up to the first scan; everything from the scan on is copied as it is. */
export function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const keep: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) return null;
    const start = i;
    while (i < n && bytes[i] === 0xff) i++;
    const marker = bytes[i++]!;
    if (marker === 0xda) {
      keep.push(bytes.subarray(start));
      const out = new Uint8Array(keep.reduce((t, k) => t + k.length, 0));
      let at = 0;
      for (const k of keep) {
        out.set(k, at);
        at += k.length;
      }
      return out;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(bytes.subarray(start, i));
      continue;
    }
    const len = (bytes[i]! << 8) | bytes[i + 1]!;
    if (len < 2 || i + len > n) return null;
    i += len;
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) keep.push(bytes.subarray(start, i));
  }
  return null;
}

export function base64Bytes(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  try {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
