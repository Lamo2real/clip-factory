// CR active (docs/CONTRACTS.md §53): the limits, the words, the refusals and the list steps the Review card's switch,
// the editor and the logo library share. Pure, so the tests read them directly.
import type { Clip, Logo, OverlayBody } from "../api/types.ts";
import { filesFrom } from "../features/help/pictures.ts";
import { bytes } from "./format.ts";

// ---------- Words (C7) ----------
export const W = {
  inactive: "CR inactive",
  active: "CR active",
  edit: "Edit for campaign",
  logo: "Logo",
  text: "Text",
  whole: "Whole clip",
  part: "Only part of the clip",
  make: "Make it",
  making: "Making it…",
  reset: "Reset",
  removed: "Edit removed",
  addLogo: "Add a logo",
  dropPastePick: "Drop, paste or pick",
  forCampaign: "For campaign",
  noCampaign: "None",
} as const;

// ---------- Limits (C2, C4) ----------
export const LOGO_MAX_BYTES = 10 * 1024 * 1024;
export const LOGO_MAX_COUNT = 60;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";
export const LOGO_SIZE_MIN = 0.08;
export const LOGO_SIZE_MAX = 0.5;
export const LOGO_SIZE_DEFAULT = 0.22;
export const TEXT_MAX = 80;
/** How long Undo stays after a logo is deleted. */
export const LOGO_UNDO_MS = 6000;
/** Review asks the clip again this often while its edit is being made. */
export const OVERLAY_POLL_MS = 2000;

export const LOGO_REFUSE = {
  kind: "Use a PNG, JPG or WebP picture under 10 MB.",
  big: "That picture is bigger than 10 MB.",
  empty: "That file is empty.",
  full: "Up to 60 logos. Delete one first.",
} as const;
export const WORKING_LINE = "The edit is still being made.";
export const FAILED_LINE = "The edit did not work. Try again.";

const BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const ALIAS: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

/** The kind a picture goes up as: its own, else the one its name says. */
export function logoType(file: { type: string; name: string }): string {
  const own = (file.type || "").toLowerCase().split(";")[0]!.trim();
  const named = ALIAS[own] ?? own;
  if ((LOGO_TYPES as readonly string[]).includes(named)) return named;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && BY_EXT[ext]) || named;
}

/** Why this file cannot be a logo (one short sentence), or null. `have`: logos already in the library. */
export function logoRefusal(file: { type: string; name: string; size: number }, have = 0): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(logoType(file))) return LOGO_REFUSE.kind;
  if (file.size > LOGO_MAX_BYTES) return LOGO_REFUSE.big;
  if (file.size <= 0) return LOGO_REFUSE.empty;
  if (have >= LOGO_MAX_COUNT) return LOGO_REFUSE.full;
  return null;
}

/** The pictures a paste carries (none for a text paste, which types as usual). */
export function pastedPictures(data: Pick<DataTransfer, "items" | "files" | "getData"> | null | undefined): File[] {
  if (!data) return [];
  const read = (type: string) => {
    try {
      return data.getData(type) ?? "";
    } catch {
      return "";
    }
  };
  const files = filesFrom(data).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!files.length) return [];
  if (read("text/plain").trim() && read("text/html").trim()) return [];
  return files;
}

/** A pasted screenshot has no name: give it one. */
export function logoName(file: { name: string }): string {
  return file.name && file.name !== "image.png" ? file.name : "Pasted logo";
}

export const sizeText = (n: number) => bytes(n);

// ---------- The clip's CR and edit ----------
export const isCrActive = (c: Pick<Clip, "cr">) => c.cr?.active === true;
export const isWorking = (c: Pick<Clip, "overlay">) => c.overlay?.status === "working";

/** The list with this clip's CR switch and edit (and the links of the file now shown) replaced by the fresh clip's. */
export function withOverlay<T extends Clip>(clips: T[], fresh: Clip): T[] {
  return clips.map((c) => {
    if (c.clipId !== fresh.clipId) return c;
    const { cr: _cr, overlay: _overlay, ...rest } = c;
    return {
      ...rest,
      ...(fresh.cr ? { cr: fresh.cr } : {}),
      ...(fresh.overlay ? { overlay: fresh.overlay } : {}),
      videoUrl: fresh.videoUrl ?? c.videoUrl,
      coverUrl: fresh.coverUrl ?? c.coverUrl,
    } as T;
  });
}

/** True when the edit has something to draw and its numbers are in range (what Make it checks before it sends). */
export function bodyProblem(body: OverlayBody, durationSec: number): string | null {
  if (!body.logo && !body.text) return "Add a logo or some words first.";
  if (body.text && (!body.text.text.trim() || Array.from(body.text.text).length > TEXT_MAX)) return `Words: 1 to ${TEXT_MAX} letters.`;
  const t = body.timing;
  if (t && !(t.startSec >= 0 && t.endSec > t.startSec && t.endSec <= durationSec + 0.05)) return "Pick a start before the end, inside the clip.";
  return null;
}

/** Hashtags to put in the text line: the campaign's required ones that are not there yet, at most `max` letters in all. */
export function withHashtags(text: string, tags: readonly string[], max = TEXT_MAX): string {
  let out = text.trim();
  for (const raw of tags) {
    const tag = raw.startsWith("#") ? raw : `#${raw}`;
    if (out.toLowerCase().split(/\s+/).includes(tag.toLowerCase())) continue;
    const next = out ? `${out} ${tag}` : tag;
    if (Array.from(next).length > max) break;
    out = next;
  }
  return out;
}

/** The library after a delete (the tile leaves at once) and after Undo (it comes back where it stood). */
export function takeLogo(list: readonly Logo[], logoId: string): { list: Logo[]; removed: { logo: Logo; at: number } | null } {
  const at = list.findIndex((l) => l.logoId === logoId);
  if (at < 0) return { list: [...list], removed: null };
  return { list: list.filter((l) => l.logoId !== logoId), removed: { logo: list[at]!, at } };
}
export function putLogoBack(list: readonly Logo[], removed: { logo: Logo; at: number }): Logo[] {
  if (list.some((l) => l.logoId === removed.logo.logoId)) return [...list];
  const out = [...list];
  out.splice(Math.min(removed.at, out.length), 0, removed.logo);
  return out;
}
