// Lamo Stories mock: the video drafts part (docs/CONTRACTS.md §45.47, §45.16.8). A draft is a saved "Make a new video"
// form, its own VDRAFT# item (never a story). Like the API it is checked loosely, because a draft may be unfinished:
// only the keys, the types and the limits. At most 50 per workspace and 32 KB each; a save sends the version it read,
// and a stale one is a 409. Making the video with its draftId deletes it (stories.ts). Knob `seedDraft`: one draft
// ("Dash at the beach") is there from the start, for the browser tests.
import type { StoriesApi, VideoDraft, VideoDraftForm } from "../types.ts";
import { delay, type MockStore } from "./store.ts";
import { clone, fail, guardWs, iso, mockId, SEED_IDS } from "./stories.ts";

export const KEYS = ["listVideoDrafts", "getVideoDraft", "createVideoDraft", "saveVideoDraft", "deleteVideoDraft"] as const;

export const SEED_DRAFT_ID = "01JSTVD0000000000000000001";

export const MAX_DRAFTS = 50;
export const MAX_DRAFT_BYTES = 32_000;
const NAME_MAX = 60;

export const FULL = "You have 50 drafts. Delete one first.";
export const GONE = "That draft is gone.";
export const CHANGED = "Someone changed this draft meanwhile. Open it again.";
export const TOO_BIG = "This draft is too big. Make it shorter.";
const UNREADABLE = "We could not read that draft.";

const FORM_KEYS = new Set<keyof VideoDraftForm>([
  "source",
  "ideaId",
  "title",
  "logline",
  "category",
  "script",
  "characterIds",
  "roles",
  "seriesId",
  "durationSec",
  "format",
  "art",
  "captionsOn",
  "musicMood",
  "referenceIds",
  "ai",
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length <= max);
const ids = (v: unknown, max: number) => v === undefined || (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 64));

/** The loose check (types and limits only): an unfinished form is fine, an unknown key or a wrong type is a 400. */
export function draftForm(raw: unknown): VideoDraftForm {
  if (!isObj(raw)) fail(400, "bad_request", UNREADABLE);
  for (const k of Object.keys(raw)) if (!FORM_KEYS.has(k as keyof VideoDraftForm)) fail(400, "bad_request", UNREADABLE);
  const f = raw as VideoDraftForm & Record<string, unknown>;
  const ok =
    (f.source === undefined || ["idea", "own", "script"].includes(f.source)) &&
    str(f.ideaId, 64) &&
    str(f.title, 80) &&
    str(f.logline, 280) &&
    str(f.category, 40) &&
    str(f.art, 40) &&
    str(f.musicMood, 40) &&
    ids(f.characterIds, 4) &&
    ids(f.referenceIds, 3) &&
    (f.seriesId === undefined || f.seriesId === null || (typeof f.seriesId === "string" && f.seriesId.length <= 64)) &&
    (f.durationSec === undefined || (typeof f.durationSec === "number" && f.durationSec >= 15 && f.durationSec <= 90)) &&
    (f.captionsOn === undefined || typeof f.captionsOn === "boolean") &&
    (f.format === undefined || isObj(f.format)) &&
    (f.ai === undefined || isObj(f.ai)) &&
    (f.roles === undefined || (isObj(f.roles) && typeof f.roles.mainId === "string" && str(f.roles.villainId, 64))) &&
    (f.script === undefined ||
      (isObj(f.script) &&
        Array.isArray(f.script.scenes) &&
        f.script.scenes.length <= 40 &&
        f.script.scenes.every((x) => isObj(x) && typeof x.what === "string" && str(x.caption, 400) && ids(x.who, 4)) &&
        (f.script.answers === undefined || isObj(f.script.answers))));
  if (!ok) fail(400, "bad_request", UNREADABLE);
  if (JSON.stringify(f).length > MAX_DRAFT_BYTES) fail(413, "too_large", TOO_BIG);
  return clone(f);
}

/** The name a draft shows: its title, else its idea's, else "Untitled video" (at most 60 letters). */
export function draftName(store: MockStore, ws: string, form: VideoDraftForm): string {
  const idea = form.ideaId ? store.ideas.find((i) => i.ideaId === form.ideaId && i.workspaceId === ws) : undefined;
  const name = (form.title ?? "").replace(/\s+/g, " ").trim() || idea?.title || "Untitled video";
  return name.slice(0, NAME_MAX);
}

function find(store: MockStore, ws: string, draftId: string): VideoDraft {
  const d = store.drafts.find((x) => x.draftId === draftId && x.workspaceId === ws);
  if (!d) fail(404, "not_found", GONE);
  return d;
}

/** Making the video deletes its draft in the same write (§45.47); a draft that is gone already is fine. */
export function dropDraft(store: MockStore, ws: string, draftId: string | undefined): void {
  if (!draftId) return;
  store.drafts = store.drafts.filter((d) => !(d.draftId === draftId && d.workspaceId === ws));
}

export function seed(store: MockStore): void {
  if (!store.knobs.seedDraft) return;
  const at = iso(Date.now() - 3_600_000);
  const ws = store.workspaces.find((w) => w.workspaceType === "stories")?.workspaceId ?? "stories";
  store.drafts.push({
    draftId: SEED_DRAFT_ID,
    workspaceId: ws,
    name: "Dash at the beach",
    form: { source: "own", title: "Dash at the beach", logline: "Dash builds a sandcastle and the sea wants it.", category: "comedy", characterIds: [SEED_IDS.characters.dash], roles: { mainId: SEED_IDS.characters.dash }, durationSec: 30 },
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async listVideoDrafts(ws) {
      guardWs(store, ws);
      await delay(100);
      const items = store.drafts.filter((d) => d.workspaceId === ws).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.draftId.localeCompare(a.draftId));
      return { items: items.map((d) => clone(d)) };
    },
    async getVideoDraft(ws, draftId) {
      guardWs(store, ws);
      await delay(100);
      return clone(find(store, ws, draftId));
    },
    async createVideoDraft(ws, body) {
      guardWs(store, ws);
      const form = draftForm(body?.form);
      if (store.drafts.filter((d) => d.workspaceId === ws).length >= MAX_DRAFTS) fail(409, "conflict", FULL);
      await delay(150);
      const now = iso();
      const draft: VideoDraft = { draftId: mockId(), workspaceId: ws, name: draftName(store, ws, form), form, version: 1, createdAt: now, updatedAt: now };
      store.drafts.push(draft);
      return clone(draft);
    },
    async saveVideoDraft(ws, draftId, body) {
      guardWs(store, ws);
      const draft = find(store, ws, draftId);
      const form = draftForm(body?.form);
      if (body.version !== draft.version) fail(409, "conflict", CHANGED);
      await delay(120);
      draft.form = form;
      draft.name = draftName(store, ws, form);
      draft.version += 1;
      draft.updatedAt = iso();
      return clone(draft);
    },
    async deleteVideoDraft(ws, draftId) {
      guardWs(store, ws);
      await delay(80);
      store.drafts = store.drafts.filter((d) => !(d.draftId === draftId && d.workspaceId === ws));
    },
  };
}
