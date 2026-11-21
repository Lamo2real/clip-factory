// Lamo Stories pages (docs/CONTRACTS.md §45.16.2). Every path under /stories is Lamo Stories; the main router
// (web/src/lib/router.ts) hands those paths to matchStories() and everything else stays Lamo Clips.
export type StoriesPage =
  | { name: "dashboard" }
  | { name: "ideas" }
  | { name: "characters" }
  | { name: "character_new" }
  | { name: "character"; characterId: string }
  | { name: "production" }
  | { name: "production_new"; ideaId: string | null }
  | { name: "production_story"; storyId: string }
  | { name: "review" }
  | { name: "review_story"; storyId: string }
  | { name: "library"; kind: string | null; storyId: string | null }
  | { name: "connections"; platform: string | null; result: string | null; ws: string | null }
  | { name: "settings" }
  | { name: "not_found" };

export const STORIES_ROOT = "/stories";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

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
    if (b === "new") return { name: "production_new", ideaId: q.get("idea") };
    if (ID.test(b)) return { name: "production_story", storyId: b };
  }
  if (a === "review") {
    if (b === undefined) return { name: "review" };
    if (ID.test(b)) return { name: "review_story", storyId: b };
  }
  if (a === "library" && b === undefined) return { name: "library", kind: q.get("kind"), storyId: q.get("story") };
  if (a === "connections" && b === undefined)
    return { name: "connections", platform: q.get("platform"), result: q.get("result"), ws: q.get("ws") };
  if (a === "settings" && b === undefined) return { name: "settings" };
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
    case "production_new":
      return `${STORIES_ROOT}/production/new${page.ideaId ? `?idea=${encodeURIComponent(page.ideaId)}` : ""}`;
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
    case "not_found":
      return STORIES_ROOT;
    default:
      return `${STORIES_ROOT}/${page.name}`;
  }
}
