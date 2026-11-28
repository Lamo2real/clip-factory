// Reference videos, "Edit like these" (docs/CONTRACTS.md §57): the pure rules of Settings › Clip making › Skills' top
// card. Which files can go up (MP4, MOV, WebM or M4V, 1 byte to 500 MB, at most 10), the one-word status of each, and
// the delete with Undo. The card is screens/settings/ReferenceVideos.tsx.
import type { RefVideo, RefVideoStatus } from "../api/types.ts";

export const REF_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
] as const;
export type RefVideoType = (typeof REF_TYPES)[number];
/** The picker's accept list (the types, and the endings for systems that give no type). */
export const REF_ACCEPT =
  "video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v";
export const REF_MAX_BYTES = 500 * 1024 ** 2;
export const REF_MAX_COUNT = 10;
/** How long a deleted video's Undo stays. */
export const REF_UNDO_MS = 6000;
/** The list is read again this often while a video is being checked. */
export const REF_POLL_MS = 5000;

export const REF_REFUSE = {
  kind: "That is not a video. Use MP4, MOV or WebM.",
  big: "That video is too big. Use one under 500 MB.",
  empty: "That file is empty.",
  full: "You have 10 videos. Delete one first.",
} as const;

/** What the drop box says while files are dragged over it. */
export const REF_DROP_WORDS = {
  file: "Drop your videos here",
  busy: "Wait a moment.",
} as const;

const BY_ENDING: Record<string, RefVideoType> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

/** The file's video type (from its type, else its ending), or null when it is not one we take. */
export function refType(
  file: Pick<File, "name" | "type">,
): RefVideoType | null {
  const t = (file.type || "").toLowerCase();
  if ((REF_TYPES as readonly string[]).includes(t)) return t as RefVideoType;
  if (t && t !== "application/octet-stream") return null;
  const ending = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  return BY_ENDING[ending] ?? null;
}

/** One file on its own: null to take it, else the short line that says why not. */
export function refFileCheck(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  if (!refType(file)) return REF_REFUSE.kind;
  if (file.size <= 0) return REF_REFUSE.empty;
  if (file.size > REF_MAX_BYTES) return REF_REFUSE.big;
  return null;
}

/** A file with `have` videos already there (listed and going up): null to take it, else why not. */
export function refRefusal(
  file: Pick<File, "name" | "type" | "size">,
  have: number,
): string | null {
  return refFileCheck(file) ?? (have >= REF_MAX_COUNT ? REF_REFUSE.full : null);
}

/** The name shown while it goes up: the file's name without its ending, at most 60 letters. */
export function refName(file: Pick<File, "name">): string {
  const bare = file.name.replace(/\.[a-z0-9]{1,5}$/i, "").trim() || "Video";
  const letters = Array.from(bare);
  return letters.length > 60 ? `${letters.slice(0, 59).join("")}…` : bare;
}

/** The one word of a video's status. "uploading" is a row of this window that is still going up. */
export const REF_STATUS_WORD: Record<RefVideoStatus, string> = {
  uploading: "Uploading",
  analyzing: "Checking",
  ready: "Ready",
  failed: "Failed",
};

export function refStatusWord(status: RefVideoStatus): string {
  return REF_STATUS_WORD[status] ?? "Checking";
}

/** The pill tone of a status. */
export function refStatusTone(
  status: RefVideoStatus,
): "success" | "warn" | "neutral" {
  return status === "ready"
    ? "success"
    : status === "failed"
      ? "warn"
      : "neutral";
}

/** True while a video is being checked: the list is read again every REF_POLL_MS. */
export function anyChecking(
  list: readonly RefVideo[] | null | undefined,
): boolean {
  return !!list?.some((v) => v.status === "analyzing");
}

/** Newest first, as the API lists them. */
export function sortRefVideos(list: readonly RefVideo[]): RefVideo[] {
  return [...list].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.refId.localeCompare(a.refId),
  );
}

/** Takes one video out (for Undo): the list without it, and where it was. */
export function takeRef(
  list: readonly RefVideo[],
  refId: string,
): { list: RefVideo[]; removed: { video: RefVideo; at: number } | null } {
  const at = list.findIndex((v) => v.refId === refId);
  if (at < 0) return { list: [...list], removed: null };
  return {
    list: list.filter((v) => v.refId !== refId),
    removed: { video: list[at]!, at },
  };
}

/** Puts a deleted video back where it was (Undo, or the delete failed). */
export function putRefBack(
  list: readonly RefVideo[],
  removed: { video: RefVideo; at: number },
): RefVideo[] {
  if (list.some((v) => v.refId === removed.video.refId)) return [...list];
  const out = [...list];
  out.splice(Math.min(removed.at, out.length), 0, removed.video);
  return out;
}

/**
 * A fresh read merged with what this window knows: a video deleted here (its Undo still open) stays out, and a video
 * that went up here while the list was read stays in.
 */
export function mergeRefs(
  read: readonly RefVideo[],
  mine: readonly RefVideo[],
  hidden: ReadonlySet<string>,
): RefVideo[] {
  const fresh = read.filter((v) => !hidden.has(v.refId));
  const extra = mine.filter(
    (m) => !hidden.has(m.refId) && !read.some((v) => v.refId === m.refId),
  );
  return sortRefVideos([...fresh, ...extra]);
}
