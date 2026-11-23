// Lamo Stories pages (docs/CONTRACTS.md §45.16.2). Every path under /stories is Lamo Stories; the main router
// (web/src/lib/router.ts) hands those paths to matchStories() and everything else stays Lamo Clips.
export type StoriesPage =
  | { name: "dashboard" }
  | { name: "ideas" }
  | { name: "characters" }
  | { name: "character_new" }
  | { name: "character"; characterId: string }
  | { name: "production" }
  /**
   * Make a new video, filled in from the address (CONTRACTS §45.34): `?idea=`, `?ref=` (repeatable, up to 3 reference
   * videos), `?cast=` (repeatable, up to 3 characters) and `?sec=` (15 to 90). The router always fills every key.
   */
  | { name: "production_new"; ideaId: string | null; refIds?: string[]; castIds?: string[]; durationSec?: number | null }
  | { name: "production_story"; storyId: string }
  | { name: "review" }
  | { name: "review_story"; storyId: string }
  | { name: "library"; kind: string | null; storyId: string | null }
  | { name: "connections"; platform: string | null; result: string | null; ws: string | null }
  | { name: "settings"; section: SettingsSection }
  | { name: "chat" }
  | { name: "chat_conv"; convId: string }
  | { name: "references" }
  | { name: "reference"; refId: string }
  | { name: "setup" }
  | { name: "not_found" };

export const SETTINGS_SECTIONS = ["ai", "agents", "skills", "memory", "video", "storage", "look"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const STORIES_ROOT = "/stories";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Up to 3 different ids from repeated keys (`?ref=a&ref=b`); anything that is not an id is left out. */
function idList(values: string[]): string[] {
  return [...new Set(values.filter((v) => ID.test(v)))].slice(0, 3);
}

/** A video length from `?sec=`: whole seconds from 15 to 90, else none. */
function lengthOf(value: string | null): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 15 && n <= 90 ? n : null;
}

export function isStoriesPath(pathname: string): boolean {
  return pathname === STORIES_ROOT || pathname.startsWith(STORIES_ROOT + "/");
}

export function matchStories(pathname: string, search: string): StoriesPage {
  const q = new URLSearchParams(search);
  const parts = pathname.replace(/\/+$/, "").split("/").slice(2); // drop "" and "stories"
  const [a, b, ...rest] = parts;
  if (rest.length) return { name: "not_found" };
  if (a === undefined) return { name: "dashboard" };
  if (a === "ideas" && b === undefined) return { name: "ideas" };
  if (a === "characters") {
    if (b === undefined) return { name: "characters" };
    if (b === "new") return { name: "character_new" };
    if (ID.test(b)) return { name: "character", characterId: b };
  }
  if (a === "production") {
    if (b === undefined) return { name: "production" };
    if (b === "new") return { name: "production_new", ideaId: q.get("idea"), refIds: idList(q.getAll("ref")), castIds: idList(q.getAll("cast")), durationSec: lengthOf(q.get("sec")) };
    if (ID.test(b)) return { name: "production_story", storyId: b };
  }
  if (a === "review") {
    if (b === undefined) return { name: "review" };
    if (ID.test(b)) return { name: "review_story", storyId: b };
  }
  if (a === "library" && b === undefined) return { name: "library", kind: q.get("kind"), storyId: q.get("story") };
  if (a === "connections" && b === undefined)
    return { name: "connections", platform: q.get("platform"), result: q.get("result"), ws: q.get("ws") };
  if (a === "settings") {
    if (b === undefined) return { name: "settings", section: "ai" };
    if ((SETTINGS_SECTIONS as readonly string[]).includes(b)) return { name: "settings", section: b as SettingsSection };
  }
  if (a === "chat") {
    if (b === undefined) return { name: "chat" };
    if (ID.test(b)) return { name: "chat_conv", convId: b };
  }
  if (a === "references") {
    if (b === undefined) return { name: "references" };
    if (ID.test(b)) return { name: "reference", refId: b };
  }
  if (a === "setup" && b === undefined) return { name: "setup" };
  return { name: "not_found" };
}

export function storiesHref(page: StoriesPage): string {
  switch (page.name) {
    case "dashboard":
      return STORIES_ROOT;
    case "character":
      return `${STORIES_ROOT}/characters/${encodeURIComponent(page.characterId)}`;
    case "character_new":
      return `${STORIES_ROOT}/characters/new`;
    case "production_new": {
      const q = new URLSearchParams();
      if (page.ideaId) q.set("idea", page.ideaId);
      for (const r of (page.refIds ?? []).slice(0, 3)) q.append("ref", r);
      for (const c of (page.castIds ?? []).slice(0, 3)) q.append("cast", c);
      if (page.durationSec) q.set("sec", String(page.durationSec));
      const qs = q.toString();
      return `${STORIES_ROOT}/production/new${qs ? `?${qs}` : ""}`;
    }
    case "production_story":
      return `${STORIES_ROOT}/production/${encodeURIComponent(page.storyId)}`;
    case "review_story":
      return `${STORIES_ROOT}/review/${encodeURIComponent(page.storyId)}`;
    case "library": {
      const q = new URLSearchParams();
      if (page.kind) q.set("kind", page.kind);
      if (page.storyId) q.set("story", page.storyId);
      const qs = q.toString();
      return `${STORIES_ROOT}/library${qs ? `?${qs}` : ""}`;
    }
    case "connections":
      return `${STORIES_ROOT}/connections`;
    case "settings":
      return `${STORIES_ROOT}/settings/${page.section}`;
    case "chat_conv":
      return `${STORIES_ROOT}/chat/${encodeURIComponent(page.convId)}`;
    case "reference":
      return `${STORIES_ROOT}/references/${encodeURIComponent(page.refId)}`;
    case "not_found":
      return STORIES_ROOT;
    default:
      return `${STORIES_ROOT}/${page.name}`;
  }
}
