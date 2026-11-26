// Files and pictures added to Home's notes box (docs/CONTRACTS.md §52). Pure helpers: the limits, which kinds may be
// added and which the agent can read, the refusal sentences, the chips' add/remove/undo steps, the notes box's drop
// highlight, a paste's files, and what Make clips sends.
import type { JobAttachment } from "../api/types.ts";
import { filesFrom } from "../features/help/pictures.ts";
import type { DragKind } from "./drops.ts";
import { isVideoFile } from "./drops.ts";

/** At most this many files per job (the server checks it too). */
export const MAX_ATTACHMENTS = 6;
/** Each file can be up to 20 MB (the server checks it too). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Every kind that may be added. */
export const ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
] as const;

/** The kinds Clip Factory reads; the others are kept with the job but not read. */
export const READABLE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
];

const BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
};

/** Other names systems give the same kinds. */
const ALIAS: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "text/x-markdown": "text/markdown",
  "text/rtf": "application/rtf",
  "text/json": "application/json",
};

/** The file picker's list. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_TYPES, ...Object.keys(BY_EXT).map((e) => `.${e}`)].join(",");

export const ATTACH_HINT = "Logo, rules, screenshots. Up to 6 files, 20 MB each.";
export const CANT_READ = "Saved, but Clip Factory can't read this kind of file.";
export const REFUSE = {
  video: "Videos go in Pick a video.",
  kind: "That kind of file can't be added.",
  big: "That file is bigger than 20 MB.",
  full: "Up to 6 files per job.",
  empty: "That file is empty.",
} as const;

/** The kind to upload as: the file's own (in its usual spelling), else one from its name, else its own as given. */
export function attachmentType(file: { type: string; name: string }): string {
  const own = (file.type || "").toLowerCase().split(";")[0]!.trim();
  const named = ALIAS[own] ?? own;
  if ((ATTACHMENT_TYPES as readonly string[]).includes(named)) return named;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || named;
}

export function canAttach(type: string): boolean {
  return (ATTACHMENT_TYPES as readonly string[]).includes(type);
}

export function canRead(type: string): boolean {
  return READABLE_TYPES.includes(type);
}

export function isImageType(type: string): boolean {
  return type.startsWith("image/") && canAttach(type);
}

/** Why this file can't be added (one short sentence), or null when it can. `have`: chips already there. */
export function refusal(file: { type: string; name: string; size: number }, have: number): string | null {
  if (isVideoFile(file)) return REFUSE.video;
  if (!canAttach(attachmentType(file))) return REFUSE.kind;
  if (file.size > MAX_ATTACHMENT_BYTES) return REFUSE.big;
  if (file.size <= 0) return REFUSE.empty;
  if (have >= MAX_ATTACHMENTS) return REFUSE.full;
  return null;
}

// ---------- The chips ----------

export type ChipState = "uploading" | "done" | "failed";

export interface Chip {
  id: string;
  name: string;
  type: string;
  size: number;
  state: ChipState;
  /** 0..1 while it uploads. */
  progress: number;
  /** The kept file (absent for a chip brought back from the draft: it is already up). */
  file?: File;
  /** Where it went up (once done). */
  key?: string;
  /** Its own short error (when failed). */
  error?: string;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `a${Date.now().toString(36)}${seq}`;
}

/**
 * Adds what can be added, in order, up to the limit. Returns the new chips (each starts uploading) and the first
 * refusal sentence, if anything was left out.
 */
export function addFiles(chips: readonly Chip[], files: readonly File[], makeId: () => string = nextId): { chips: Chip[]; added: Chip[]; refused: string | null } {
  const out = [...chips];
  const added: Chip[] = [];
  let refused: string | null = null;
  for (const f of files) {
    const why = refusal(f, out.length);
    if (why) {
      refused ??= why;
      continue;
    }
    const c: Chip = { id: makeId(), name: f.name || "Pasted file", type: attachmentType(f), size: f.size, state: "uploading", progress: 0, file: f };
    out.push(c);
    added.push(c);
  }
  return { chips: out, added, refused };
}

export function setProgress(chips: readonly Chip[], id: string, progress: number): Chip[] {
  return chips.map((c) => (c.id === id && c.state === "uploading" ? { ...c, progress: Math.max(c.progress, Math.min(1, progress)) } : c));
}

export function setDone(chips: readonly Chip[], id: string, key: string): Chip[] {
  return chips.map((c) => (c.id === id ? { ...c, state: "done" as const, progress: 1, key, error: undefined } : c));
}

export function setFailed(chips: readonly Chip[], id: string, error: string): Chip[] {
  return chips.map((c) => (c.id === id ? { ...c, state: "failed" as const, error } : c));
}

/** Try again: the chip uploads from the start. */
export function setRetry(chips: readonly Chip[], id: string): Chip[] {
  return chips.map((c) => (c.id === id && c.file ? { ...c, state: "uploading" as const, progress: 0, error: undefined } : c));
}

/** Takes a chip away at once; `removed` (and where it stood) brings it back on Undo. */
export function removeChip(chips: readonly Chip[], id: string): { chips: Chip[]; removed: { chip: Chip; at: number } | null } {
  const at = chips.findIndex((c) => c.id === id);
  if (at < 0) return { chips: [...chips], removed: null };
  return { chips: chips.filter((c) => c.id !== id), removed: { chip: chips[at]!, at } };
}

/**
 * Undo: the chip comes back where it stood. One that had not finished going up starts again (its upload was stopped
 * on remove). Never past the limit (another file may have taken its place in the meantime).
 */
export function restoreChip(chips: readonly Chip[], removed: { chip: Chip; at: number }): { chips: Chip[]; restarted: boolean } {
  if (chips.some((c) => c.id === removed.chip.id) || chips.length >= MAX_ATTACHMENTS) return { chips: [...chips], restarted: false };
  const restarted = removed.chip.state === "uploading";
  const chip: Chip = restarted ? { ...removed.chip, progress: 0 } : removed.chip;
  const out = [...chips];
  out.splice(Math.min(removed.at, out.length), 0, chip);
  return { chips: out, restarted };
}

/** What Make clips sends: only the files that are all up. */
export function attachmentsPayload(chips: readonly Chip[]): JobAttachment[] {
  return chips.filter((c) => c.state === "done" && c.key).map((c) => ({ key: c.key!, name: c.name.slice(0, 255), type: c.type, size: c.size }));
}

export const uploadingChips = (chips: readonly Chip[]) => chips.filter((c) => c.state === "uploading");
export const failedChips = (chips: readonly Chip[]) => chips.filter((c) => c.state === "failed");

/** Make clips' one line when a file did not go up (pressed again, it goes on without it). */
export function failedLine(n: number): string {
  return n === 1 ? "1 file didn't upload. Tap Make clips again to go without it." : `${n} files didn't upload. Tap Make clips again to go without them.`;
}

/** The chips the draft keeps: only the ones that are all up, without their file or picture. */
export function keptChips(chips: readonly Chip[]): JobAttachment[] {
  return attachmentsPayload(chips);
}

/** Chips brought back from the draft (already up). */
export function chipsFromDraft(kept: readonly JobAttachment[] | undefined, makeId: () => string = nextId): Chip[] {
  return (kept ?? []).slice(0, MAX_ATTACHMENTS).map((a) => ({ id: makeId(), name: a.name, type: a.type, size: a.size, key: a.key, state: "done", progress: 1 }));
}

/** A failed upload's own words: the server's two refusals, else one plain line. */
export function uploadErrorText(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 413) return REFUSE.big;
  if (status === 400) return REFUSE.kind;
  return "Didn't upload.";
}

// ---------- Dropping and pasting ----------

/**
 * The notes box lights up for a drag of files (no link, no video) while the pointer is over it. A thumbnail dragged
 * off a video page also brings its link ("either"): that one stays a link drop, as before. A held video still goes to
 * Pick a video, so the card's own video highlight shows instead (`hasVideo`: what the drag's items say, see dragHasVideo).
 */
export function notesOver(kind: DragKind, inNotes: boolean, hasVideo = false): boolean {
  return inNotes && kind === "file" && !hasVideo;
}

/** True when a drag that is still moving already says it holds a video (Chrome, Edge and Firefox give the items' types). */
export function dragHasVideo(data: Pick<DataTransfer, "items"> | null | undefined): boolean {
  try {
    return Array.from(data?.items ?? []).some((i) => i.kind === "file" && i.type.toLowerCase().startsWith("video/"));
  } catch {
    return false;
  }
}

/** The videos among a drop's files (the first is picked; the rest are the ones "One video per job" is about). */
export function videoFiles(files: readonly File[]): File[] {
  return files.filter((f) => isVideoFile(f));
}

/**
 * The files a paste carries. None for a text paste, which then types as usual: plain text, and also text copied from a
 * writing app (it comes with its own formatting and often a picture of itself, which is not what was meant).
 */
export function pastedFiles(data: Pick<DataTransfer, "items" | "files" | "getData"> | null | undefined): File[] {
  if (!data) return [];
  const read = (type: string) => {
    try {
      return data.getData(type) ?? "";
    } catch {
      return "";
    }
  };
  const files = filesFrom(data);
  if (!files.length) return [];
  if (read("text/plain").trim() && read("text/html").trim()) return [];
  return files;
}

/** The files of a drop that are not videos (those go to Pick a video). */
export function nonVideoFiles(files: readonly File[]): File[] {
  return files.filter((f) => !isVideoFile(f));
}

/** True when at least one of these files could be added (else a non-video drop says "That is not a video"). */
export function anyAttachable(files: readonly File[]): boolean {
  return files.some((f) => !isVideoFile(f) && canAttach(attachmentType(f)));
}
