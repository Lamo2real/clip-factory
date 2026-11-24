// Lamo Stories mock: the library part (docs/CONTRACTS.md §45.12, §45.16.8). The Library lists the workspace's
// ASSET# items, newest first, filtered by kind, story or character, with each item's story or character title.
// Once every part has seeded, the stories that have a video and the characters get their files (whoever seeded
// them), as the agent's jobs and the owner's uploads would have made them. In mock mode every file is a small
// picture or a placeholder written in the page itself (no network). `?seriesId=` keeps the files of one series'
// stories ("none": of the stories in no series, §45.44); a file with no story shows only under All.
import { ApiError } from "../../../api/errors.ts";
import { isCar, type AssetKind, type Character, type LibraryItem, type StoriesApi, type Story } from "../types.ts";
import { ago, delay, HOUR, mockId, type MockStore } from "./store.ts";
import { storiesWorkspace } from "./workspace.ts";

export const KEYS = ["library"] as const;

export function seed(_store: MockStore): void {}

const SKY = ["#62C6FF", "#FF6F61", "#47D6A0", "#FFC94A", "#B79CFF", "#FF9DCB"];

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const textUrl = (text: string, type = "text/plain") => `data:${type};charset=utf-8,${encodeURIComponent(text)}`;

/** A pretend still: a sky, a road, a sun and a bean-shaped character, coloured by `n`. */
export function stillSvg(n: number, wide = false): string {
  const sky = SKY[n % SKY.length]!;
  const [w, h] = wide ? [320, 180] : [180, 320];
  const body = SKY[(n + 2) % SKY.length]!;
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#1C1842"/><rect width="${w}" height="${h * 0.62}" fill="${sky}" opacity="0.55"/>` +
      `<circle cx="${w * 0.78}" cy="${h * 0.18}" r="${h * 0.07}" fill="#FFC94A"/><rect y="${h * 0.62}" width="${w}" height="${h * 0.38}" fill="#322A73"/>` +
      `<rect x="${w * 0.1}" y="${h * 0.79}" width="${w * 0.16}" height="${h * 0.02}" rx="2" fill="#FFF6E5"/><rect x="${w * 0.42}" y="${h * 0.79}" width="${w * 0.16}" height="${h * 0.02}" rx="2" fill="#FFF6E5"/>` +
      `<rect x="${w * 0.74}" y="${h * 0.79}" width="${w * 0.16}" height="${h * 0.02}" rx="2" fill="#FFF6E5"/>` +
      `<ellipse cx="${w * 0.4}" cy="${h * 0.56}" rx="${Math.min(w, h) * 0.13}" ry="${Math.min(w, h) * 0.18}" fill="${body}"/>` +
      `<circle cx="${w * 0.37}" cy="${h * 0.53}" r="${Math.min(w, h) * 0.02}" fill="#1C1842"/><circle cx="${w * 0.43}" cy="${h * 0.53}" r="${Math.min(w, h) * 0.02}" fill="#1C1842"/>` +
      `<path d="M${w * 0.36} ${h * 0.58} q${w * 0.04} ${h * 0.03} ${w * 0.08} 0" stroke="#1C1842" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
  );
}

/** A car's picture (§45.42): a cartoon hatchback in its own paint, on the same backdrop. */
function carSvg(paint: string, sketch: boolean): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${sketch ? "#FFF6E5" : "#26205A"}"/>` +
    `<path d="M28 132 q4 -26 30 -30 l22 -26 h52 l26 26 q30 4 32 30 v12 h-162z" fill="${paint}" stroke="#1C1842" stroke-width="5" stroke-linejoin="round"/>` +
    `<path d="M86 82 h40 l18 20 h-58z" fill="#BFE3F2" stroke="#1C1842" stroke-width="4" stroke-linejoin="round"/>` +
    `<circle cx="62" cy="146" r="17" fill="#1C1842"/><circle cx="62" cy="146" r="7" fill="#C9CCD2"/>` +
    `<circle cx="146" cy="146" r="17" fill="#1C1842"/><circle cx="146" cy="146" r="7" fill="#C9CCD2"/>` +
    `<circle cx="178" cy="122" r="6" fill="#FFF6E5" stroke="#1C1842" stroke-width="3"/></svg>`;
  return svgUrl(svg);
}

function faceSvg(c: Character, sketch: boolean): string {
  if (isCar(c)) return carSvg(c.car.paint, sketch);
  const top = c.look.outfit.top;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${sketch ? "#FFF6E5" : "#26205A"}"/>` +
    `<ellipse cx="100" cy="170" rx="62" ry="40" fill="${top}"/><ellipse cx="100" cy="92" rx="52" ry="60" fill="${c.look.skin}"/>` +
    `<circle cx="80" cy="88" r="7" fill="#1C1842"/><circle cx="120" cy="88" r="7" fill="#1C1842"/>` +
    `<path d="M78 116 q22 18 44 0" stroke="#1C1842" stroke-width="6" fill="none" stroke-linecap="round"/>` +
    `<path d="M50 62 q50 -50 100 0" stroke="${c.look.hair.color}" stroke-width="16" fill="none" stroke-linecap="round"/></svg>`;
  return svgUrl(svg);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "story";

function asset(kind: AssetKind, owner: { storyId?: string; characterId?: string; title: string }, url: string, contentType: string, bytes: number, at: string, version: number | null, meta: LibraryItem["meta"] = {}): LibraryItem {
  return {
    assetId: mockId(),
    kind,
    storyId: owner.storyId ?? null,
    characterId: owner.characterId ?? null,
    title: owner.title,
    url,
    contentType,
    bytes,
    version,
    createdAt: at,
    meta: { current: 1, ...meta },
  };
}

/** The files one finished story has: its video and cover, the storyboard, each scene, the sound and the captions. */
export function storyAssets(s: Story, n: number): LibraryItem[] {
  const at = s.updatedAt;
  const v = s.scriptVersion || 1;
  const owner = { storyId: s.storyId, title: s.title };
  const name = slug(s.title);
  const out: LibraryItem[] = [
    asset("final_video", owner, textUrl(`Pretend video of “${s.title}” (mock mode: the live preview plays instead).`), "video/mp4", 18_400_000, at, v, { filename: `${name}.mp4` }),
    asset("cover", owner, stillSvg(n), "image/jpeg", 182_000, at, v),
    asset("storyboard", owner, textUrl(JSON.stringify({ title: s.title, scenes: s.scenes }, null, 2), "application/json"), "application/json", 24_800, at, v),
    asset("audio", owner, textUrl("Pretend sound mix (mock mode)."), "audio/mp4", 1_120_000, at, v),
  ];
  if (s.captionsOn) out.push(asset("captions", owner, textUrl("[Script Info]\nTitle: pretend captions"), "text/x-ssa", 3_600, at, v));
  s.scenes.forEach((sc, i) => {
    out.push(asset("scene_still", owner, stillSvg(n + i + 1), "image/jpeg", 96_000, at, v, { sceneId: sc.sceneId }));
    out.push(asset("scene_clip", owner, textUrl(`Pretend clip of scene “${sc.title}”.`), "video/mp4", 2_600_000, at, v, { sceneId: sc.sceneId }));
  });
  return out;
}

/** Once every part has seeded: files for every story with a video and every character, unless a part made them. */
export function afterSeed(store: MockStore): void {
  store.stories.forEach((s, n) => {
    const made = s.actualDurationSec !== null || !!s.videoUrl;
    if (!made || store.assets.some((a) => a.storyId === s.storyId)) return;
    store.assets.push(...storyAssets(s, n));
  });
  store.characters.forEach((c, n) => {
    if (store.assets.some((a) => a.characterId === c.characterId)) return;
    const owner = { characterId: c.characterId, title: c.name };
    store.assets.push(asset("character_ref", owner, faceSvg(c, true), "image/png", 412_000, ago((40 + n) * HOUR), null));
    if (c.portrait) store.assets.push(asset("portrait", owner, c.portrait.url, "image/png", 860_000, ago((30 + n) * HOUR), null));
  });
}

/** The title the route fills in: the story's or character's current one. */
function withTitle(store: MockStore, item: LibraryItem): LibraryItem {
  const story = item.storyId ? store.stories.find((s) => s.storyId === item.storyId) : null;
  const character = item.characterId ? store.characters.find((c) => c.characterId === item.characterId) : null;
  return { ...item, title: story?.title ?? character?.name ?? item.title };
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async library(ws, q = {}) {
      await delay(160);
      storiesWorkspace(store, ws);
      const limit = Math.min(100, Math.max(1, q.limit ?? 50));
      const start = q.cursor ? Number(q.cursor) : 0;
      if (!Number.isInteger(start) || start < 0) throw new ApiError(400, "bad_request", "That list link is old. Open the Library again.");
      const mine = new Set([...store.stories.filter((s) => s.workspaceId === ws).map((s) => s.storyId), ...store.characters.filter((c) => c.workspaceId === ws).map((c) => c.characterId)]);
      const known = new Set(store.series.filter((x) => x.workspaceId === ws).map((x) => x.seriesId));
      const inSeries = (storyId: string | null) => {
        if (!q.seriesId) return true;
        const st = storyId ? store.stories.find((s) => s.storyId === storyId) : undefined;
        if (!st) return false; // a file with no story shows only under All
        return q.seriesId === "none" ? !st.seriesId || !known.has(st.seriesId) : st.seriesId === q.seriesId;
      };
      const all = store.assets
        .filter((a) => (a.storyId ? mine.has(a.storyId) : a.characterId ? mine.has(a.characterId) : false))
        .filter((a) => !q.kind || q.kind === "all" || a.kind === q.kind)
        .filter((a) => !q.storyId || a.storyId === q.storyId)
        .filter((a) => !q.characterId || a.characterId === q.characterId)
        .filter((a) => inSeries(a.storyId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const page = all.slice(start, start + limit).map((a) => withTitle(store, a));
      return { items: structuredClone(page), nextCursor: start + limit < all.length ? String(start + limit) : null };
    },
  };
}

/**
 * Stand-ins the shell uses while the studio part has not built its own (index.ts uses a part's method whenever it
 * is built): the stories list, the cast and a story's production jobs, so the Library's Projects tab works.
 */
export function shellFallbacks(store: MockStore): Partial<StoriesApi> {
  return {
    async listStories(ws, q = {}) {
      await delay(160);
      storiesWorkspace(store, ws);
      const known = new Set(store.series.filter((x) => x.workspaceId === ws).map((x) => x.seriesId));
      const inSeries = (s: Story) => !q.seriesId || (q.seriesId === "none" ? !s.seriesId || !known.has(s.seriesId) : s.seriesId === q.seriesId);
      const list = store.stories
        .filter((s) => s.workspaceId === ws && (!q.status || q.status === "all" || s.status === q.status) && inSeries(s))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { stories: structuredClone(list.slice(0, q.limit ?? 50)), nextCursor: null };
    },
    async listCharacters(ws) {
      await delay(140);
      storiesWorkspace(store, ws);
      return structuredClone(store.characters.filter((c) => c.workspaceId === ws).sort((a, b) => a.name.localeCompare(b.name)));
    },
    async storyJobs(ws, storyId) {
      await delay(140);
      storiesWorkspace(store, ws);
      if (!store.stories.some((s) => s.storyId === storyId && s.workspaceId === ws)) throw new ApiError(404, "not_found", "We could not find that story.");
      return structuredClone(store.jobs.filter((j) => j.contentId === storyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },
  };
}
