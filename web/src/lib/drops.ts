// Dragging a video or a link onto the new-job card on Home (docs/CONTRACTS.md §12.5).
// Pure helpers: what a drag carries (while it is over the card, only the types can be read) and what a drop holds.
import { filesFrom } from "../features/help/pictures.ts";
import { extractLink } from "./links.ts";

/** What a drag shows while it moves over the card: files, a link (from a browser), or nothing the card takes. */
export type DragKind = "file" | "link" | null;

export function dragKind(data: Pick<DataTransfer, "types"> | null | undefined): DragKind {
  const types = Array.from(data?.types ?? []);
  if (types.includes("Files")) return "file";
  if (types.includes("text/uri-list")) return "link";
  return null;
}

/** True when a drag could hold a link (a uri-list, or plain text that turns out to be one on drop). */
export function dragMayHoldText(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  const types = Array.from(data?.types ?? []);
  return types.includes("text/uri-list") || types.includes("text/plain");
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

/** A video by its type, or (when the system gives no type) by its name. */
export function isVideoFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith("video/") || (!file.type && VIDEO_EXT.test(file.name));
}

export type Dropped =
  | { kind: "video"; file: File; others: number }
  | { kind: "other"; file: File }
  | { kind: "link"; url: string }
  | { kind: "none" };

/** A link with no https:// in front, from the platforms Clip Factory takes. */
const BARE_LINK = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be|twitch\.tv|clips\.twitch\.tv|kick\.com)\/\S*$/i;

/** The first http(s) link in a uri-list (lines starting with # are comments) or in plain text. */
export function linkFrom(data: Pick<DataTransfer, "getData"> | null | undefined): string | null {
  if (!data) return null;
  const read = (type: string) => {
    try {
      return data.getData(type) ?? "";
    } catch {
      return "";
    }
  };
  const list = read("text/uri-list")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  for (const text of [list ?? "", read("text/plain")]) {
    if (!text.trim()) continue;
    const url = extractLink(text);
    if (/^https?:\/\/\S+$/i.test(url) || BARE_LINK.test(url)) return url;
  }
  return null;
}

/** What a drop on the card holds: the first video (and how many other files came with it), another file, a link. */
export function classifyDrop(data: Pick<DataTransfer, "items" | "files" | "getData" | "types"> | null | undefined): Dropped {
  const files = filesFrom(data);
  if (files.length) {
    const video = files.find(isVideoFile);
    if (video) return { kind: "video", file: video, others: files.length - 1 };
    return { kind: "other", file: files[0]! };
  }
  const url = linkFrom(data);
  return url ? { kind: "link", url } : { kind: "none" };
}

/** The upload's content type: the file's own, else one from its name (some systems give dropped files none). */
export function videoType(file: { type: string; name: string }): string {
  if (file.type) return file.type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return ext === "mov" ? "video/quicktime" : ext === "webm" ? "video/webm" : "video/mp4";
}
