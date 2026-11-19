// Files in Ask (docs/CONTRACTS.md §27.7): what can be added, how each looks in the tray, and which files a follow-up
// question carries along. Pictures are made ready by pictures.ts (a small clean JPEG); every other file goes as it is.
// Files live in memory only (Blobs and object URLs), are uploaded when Send is pressed, and the server deletes them
// when the answer ends.
import type { IconName } from "../../components/Icon.tsx";

export type AskKind = "image" | "pdf" | "text" | "office";

export const FILES_MAX = 10;
export const BYTES_PER_FILE = 25_000_000;
export const BYTES_PER_QUESTION = 50_000_000;
export const IMAGES_MAX = 8;
export const QUESTION_CHARS = 4000;
/** The character counter shows from here. */
export const COUNTER_FROM = 3800;
/** Sent files kept in memory for follow-ups (Claude-like); older ones are let go. */
export const KEEP_FILES = 30;
export const KEEP_BYTES = 100_000_000;
/** A follow-up re-sends the files of the last this-many questions that had files. */
export const CARRY_TURNS = 2;

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "avif"]);
const TEXT_EXT = new Set(
  "txt md markdown csv tsv json yaml yml xml html htm log ini toml tf tfvars hcl py ts tsx js jsx mjs cjs css sql sh srt vtt env pem cfg conf rs go java kt swift rb php c h cpp cs".split(" "),
);
const OFFICE_EXT = new Set(["docx", "xlsx", "pptx", "odt", "ods"]);
const TABLE_EXT = new Set(["csv", "tsv", "xlsx", "ods"]);
const CODE_EXT = new Set("json yaml yml xml html htm tf tfvars hcl py ts tsx js jsx mjs cjs css sql sh rs go java kt swift rb php c h cpp cs ini toml env".split(" "));

/** The owner-facing words (short, plain, no blame). The same notes as the API (ask/files.py). */
export const FILE_TEXT = {
  zip: "I can't read .ZIP files. Unzip it and add the files inside.",
  doc: "I can't read old .DOC files. Save it as .DOCX or PDF.",
  xls: "I can't read old .XLS files. Save it as .XLSX or CSV.",
  ppt: "I can't read old .PPT files. Save it as .PPTX or PDF.",
  video: "I can't watch videos here. To make clips, use **Make clips** on Home.",
  other: "I can't read that kind of file yet. Try a PDF, a picture or a text file.",
  too_big: "That file is too big. The most is 25 MB.",
  too_many: "You can send 10 files at a time. Take one away first.",
  too_many_pictures: "You can send 8 pictures at a time. Take one away first.",
  long_paste: "That was long, so I added it as a file.",
  empty: "That file is empty.",
} as const;

export const WHY_TEXT: Record<string, string> = {
  unsupported: "I couldn't read this one: I can't read that kind of file.",
  too_long: "I couldn't read this one: it is too long.",
  damaged: "I couldn't read this one: it looks damaged.",
  off: "I couldn't read this one: files are off right now.",
};

export function extension(name: string): string {
  const base = name.split("/").pop() ?? name;
  if (base.startsWith(".") && base.split(".").length === 2) return base.slice(1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The format label shown on a tile: the extension in capitals (≤ 5), else the type's subtype, else FILE. */
export function formatLabel(name: string, type: string): string {
  const ext = extension(name);
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) return ext.toUpperCase();
  const sub = type.split(";")[0]?.split("/")[1]?.replace(/^x-/, "").replace(/[^a-z0-9]/gi, "") ?? "";
  if (sub && sub.length <= 5) return sub.toUpperCase();
  return "FILE";
}

/** The kind a file is read as, or the note that says why it can't be added. */
export function classify(file: { name: string; type: string }): { kind: AskKind } | { refused: string } {
  const ext = extension(file.name);
  const type = file.type.toLowerCase();
  if (ext === "zip" || ext === "rar" || ext === "7z" || ext === "gz" || ext === "tar" || type.includes("zip")) return { refused: FILE_TEXT.zip };
  if (ext === "doc") return { refused: FILE_TEXT.doc };
  if (ext === "xls") return { refused: FILE_TEXT.xls };
  if (ext === "ppt") return { refused: FILE_TEXT.ppt };
  if (IMAGE_EXT.has(ext) || (!ext && type.startsWith("image/")) || (type.startsWith("image/") && !TEXT_EXT.has(ext))) return { kind: "image" };
  if (ext === "pdf" || type === "application/pdf") return { kind: "pdf" };
  if (OFFICE_EXT.has(ext)) return { kind: "office" };
  if (TEXT_EXT.has(ext) || type.startsWith("text/") || type === "application/json" || type === "application/xml") return { kind: "text" };
  if (type.startsWith("video/") || ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)) return { refused: FILE_TEXT.video };
  return { refused: FILE_TEXT.other };
}

/** The icon for a file tile. */
export function fileIcon(kind: AskKind, format: string): IconName {
  const ext = format.toLowerCase();
  if (kind === "pdf") return "filePdf";
  if (TABLE_EXT.has(ext)) return "fileTable";
  if (CODE_EXT.has(ext)) return "fileCode";
  if (kind === "text" || kind === "office") return "fileText";
  return "file";
}

/** "2.4 MB", "320 KB", "18 bytes". */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

/** Long pasted text becomes a file, so the question stays short. */
export function pastedTextFile(text: string): File {
  return new File([text], "Pasted text.txt", { type: "text/plain" });
}

/** What a screen reader hears when files are added: the format for one, the count for several ("3 files added"). */
export const addedText = (format: string, n: number, added = 1) =>
  `${added > 1 ? `${added} files` : format === "IMAGE" ? "Picture" : `${format} file`} added. ${n} of ${FILES_MAX}.`;

/** One file in a question (sent or waiting), in memory only. */
export interface AskFile {
  id: number;
  kind: AskKind;
  name: string;
  format: string;
  size: number;
  blob: Blob;
  /** Pictures: an object URL of the (marked) JPEG, and its size. */
  url?: string;
  width?: number;
  height?: number;
  /** The picture was marked in the editor (the original stays in memory only until the question is sent). */
  marked?: boolean;
}

/** The files a follow-up carries: those of the last CARRY_TURNS questions that had files, newest first, within the
 * per-question limits (files, bytes, pictures) left after the new ones. */
export function carriedFiles(
  turns: readonly { files?: readonly AskFile[] }[],
  taken: readonly AskFile[],
  limits = { files: FILES_MAX, bytes: BYTES_PER_QUESTION, images: IMAGES_MAX },
): AskFile[] {
  let files = taken.length;
  let bytes = taken.reduce((n, f) => n + f.size, 0);
  let images = taken.filter((f) => f.kind === "image").length;
  const out: AskFile[] = [];
  let turnsWithFiles = 0;
  for (let i = turns.length - 1; i >= 0 && turnsWithFiles < CARRY_TURNS; i--) {
    const list = turns[i]!.files ?? [];
    if (!list.length) continue;
    turnsWithFiles++;
    for (const f of list) {
      if (out.some((o) => o.id === f.id) || taken.some((t) => t.id === f.id)) continue;
      if (files + 1 > limits.files || bytes + f.size > limits.bytes || (f.kind === "image" && images + 1 > limits.images)) continue;
      out.push(f);
      files++;
      bytes += f.size;
      if (f.kind === "image") images++;
    }
  }
  return out;
}
