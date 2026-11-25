// Clips Funded mock: the vehicle drafts part. A vehicle draft (VDESIGN#) is one "Design with AI" run for a new vehicle,
// kept on the server so the owner can leave the screen and come back: it owns the design task (the character_design
// task of the characters part) and mirrors its state. The practice run really waits: 20 to 40 seconds (knob
// `vehicleSeconds` sets it), through queued and running to done; knob `vehicleFail` (true, or the sentence) makes the
// next run fail. Rules, as the API's: one design per draft at a time (a second press is a 409 and never a second task),
// at most 3 designing at once, at most 20 drafts, at most 4 options, a designing draft is settled whenever it is read
// (a task that has gone missing, or has run for over 15 minutes, is failed with a plain sentence). Nothing is saved as
// a vehicle until the owner taps Save (createCharacter, then the page deletes the draft).
import { isCar, type CarInput, type CharacterInput, type DesignBody, type StoriesApi, type VehicleDraft, type VehicleType } from "../types.ts";
import { designTask, picture } from "./characters.ts";
import { settleTasks } from "./ideas.ts";
import { delay, type MockStore, type StoredVehicleDraft } from "./store.ts";
import { clone, fail, guardWs, iso, mockId } from "./stories.ts";

export const KEYS = ["listVehicleDrafts", "getVehicleDraft", "createVehicleDraft", "redesignVehicleDraft", "deleteVehicleDraft"] as const;

export const MAX_VEHICLE_DRAFTS = 20;
export const MAX_DESIGNING = 3;
export const MAX_OPTIONS = 4;
/** A run that is still queued or running after this long is given up on. */
export const GIVE_UP_MS = 15 * 60_000;

export const STILL = "It is still designing. Wait for it.";
export const TOO_MANY_RUNNING = "3 vehicles are being designed. Wait for one to finish.";
export const FULL = "You have 20 vehicle drafts. Delete one first.";
export const GONE = "That draft is gone.";
export const PLENTY = "That's plenty. Pick one.";
const STOPPED = "The helper stopped. Tap Try again.";
const NAME_MAX = 60;

const CREATE_KEYS = new Set(["design", "name"]);
const REDESIGN_KEYS = new Set(["more", "override"]);

/** How long a practice run takes: the knob, else 20 to 40 seconds (a little different each time). */
export function runSeconds(store: MockStore): number {
  const knob = Number(store.knobs.vehicleSeconds);
  if (Number.isFinite(knob) && knob > 0) return knob;
  return 20 + ((store.vehicleDrafts.length * 7 + store.tasks.length * 3) % 21);
}

/** The knob's failure for the next run (used once), or undefined. */
function nextFailure(store: MockStore): string | undefined {
  const k = store.knobs.vehicleFail;
  if (!k) return undefined;
  store.knobs.vehicleFail = null;
  return typeof k === "string" ? k : STOPPED;
}

function find(store: MockStore, ws: string, draftId: string): StoredVehicleDraft {
  const d = store.vehicleDrafts.find((x) => x.draftId === draftId && x.workspaceId === ws);
  if (!d) fail(404, "not_found", GONE);
  return d;
}

/** The cars a finished design task made (result.characters, else result.character). */
function carsOf(result: Record<string, unknown> | null): CarInput[] {
  const list = Array.isArray(result?.characters) && result.characters.length ? (result.characters as unknown[]) : [result?.character];
  return list.filter((c): c is CharacterInput => !!c && typeof c === "object").filter(isCar);
}

/** Settles one designing draft from its task (idempotent: only a draft still waiting on that task changes). */
export function settleDraft(store: MockStore, d: StoredVehicleDraft, now = Date.now()): void {
  if (d.status !== "designing" || d.starting) return;
  settleTasks(store, now);
  const taskId = d.taskId;
  const task = store.tasks.find((t) => t.taskId === taskId);
  const end = (patch: Partial<StoredVehicleDraft>) => {
    if (d.status !== "designing" || d.taskId !== taskId) return;
    Object.assign(d, patch, { finishedAt: iso(now), updatedAt: iso(now), version: d.version + 1 });
  };
  if (!task) return end({ status: "failed", message: "The helper stopped. Tap Try again." });
  if (task.status === "done") {
    const cars = carsOf(task.result).map((c) => (d.name ? { ...c, name: d.name } : c));
    if (!cars.length) return end({ status: "failed", message: "None came back. Tap Try again." });
    return end({ status: "ready", options: d.more ? [...d.options, ...cars].slice(0, MAX_OPTIONS) : cars.slice(0, MAX_OPTIONS), model: task.model, effort: task.effort });
  }
  if (task.status === "failed") return end({ status: "failed", message: task.error || STOPPED, model: task.model, effort: task.effort });
  if (now - Date.parse(d.startedAt) > GIVE_UP_MS) end({ status: "failed", message: "That took too long. Tap Try again." });
}

function settleAll(store: MockStore, ws: string): void {
  for (const d of store.vehicleDrafts) if (d.workspaceId === ws) settleDraft(store, d);
}

function shown(d: StoredVehicleDraft): VehicleDraft {
  const { design, more: _more, starting: _starting, ...rest } = d;
  void _more;
  void _starting;
  return clone({ ...rest, words: design.description?.trim() || null });
}

function photosOf(design: DesignBody): VehicleDraft["photos"] {
  const ids = [...new Set([...(design.referenceAssetId ? [design.referenceAssetId] : []), ...(design.referenceAssetIds ?? [])])];
  const sides = design.referenceSides ?? [];
  return ids.map((assetId, i) => ({ assetId, url: picture("#26205a", "#ffc94a", "#ffd7b0"), side: sides[i] === "inside" ? ("inside" as const) : ("outside" as const) }));
}

function checkDesign(raw: unknown): DesignBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(400, "bad_request", "We could not read that vehicle.");
  const d = raw as DesignBody & Record<string, unknown>;
  if (d.characterId !== undefined) fail(400, "bad_request", "A vehicle draft is for a new vehicle.");
  if (d.kind !== undefined && d.kind !== "car") fail(400, "bad_request", "A vehicle draft is for a vehicle.");
  return { ...d, kind: "car" };
}

export function seed(_store: MockStore): void {}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async listVehicleDrafts(ws) {
      guardWs(store, ws);
      await delay(100);
      settleAll(store, ws);
      const items = store.vehicleDrafts.filter((d) => d.workspaceId === ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.draftId.localeCompare(a.draftId));
      return { items: items.map(shown) };
    },
    async getVehicleDraft(ws, draftId) {
      guardWs(store, ws);
      await delay(80);
      const d = find(store, ws, draftId);
      settleDraft(store, d);
      return shown(d);
    },
    async createVehicleDraft(ws, body) {
      guardWs(store, ws);
      for (const k of Object.keys(body ?? {})) if (!CREATE_KEYS.has(k)) fail(400, "bad_request", "Something in that request was not right.");
      const name = typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
      if (name.length > NAME_MAX) fail(400, "bad_request", "Keep the name to 60 letters.");
      const design = checkDesign(body?.design);
      settleAll(store, ws);
      const mine = store.vehicleDrafts.filter((d) => d.workspaceId === ws);
      if (mine.length >= MAX_VEHICLE_DRAFTS) fail(409, "conflict", FULL);
      if (mine.filter((d) => d.status === "designing").length >= MAX_DESIGNING) fail(409, "conflict", TOO_MANY_RUNNING);
      const task = await designTask(store, ws, design, { seconds: runSeconds(store), fail: nextFailure(store) });
      const now = iso();
      const draft: StoredVehicleDraft = {
        draftId: mockId(),
        workspaceId: ws,
        name,
        vehicle: (design.vehicle ?? "car") as VehicleType,
        design,
        photos: photosOf(design),
        status: "designing",
        taskId: task.taskId,
        more: false,
        model: task.model,
        effort: task.effort,
        message: null,
        options: [],
        startedAt: now,
        finishedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      store.vehicleDrafts.push(draft);
      return shown(draft);
    },
    async redesignVehicleDraft(ws, draftId, body) {
      guardWs(store, ws);
      for (const k of Object.keys(body ?? {})) if (!REDESIGN_KEYS.has(k)) fail(400, "bad_request", "Something in that request was not right.");
      const d = find(store, ws, draftId);
      settleDraft(store, d);
      // Claimed at once, before anything waits: a second press in the same moment finds it designing (a 409).
      if (d.status === "designing") fail(409, "conflict", STILL);
      settleAll(store, ws);
      if (store.vehicleDrafts.filter((x) => x.workspaceId === ws && x.status === "designing").length >= MAX_DESIGNING) fail(409, "conflict", TOO_MANY_RUNNING);
      const more = !!body?.more;
      const count = more ? Math.min(3, MAX_OPTIONS - d.options.length) : 3;
      if (count <= 0) fail(409, "conflict", PLENTY);
      const before = { status: d.status, taskId: d.taskId, version: d.version };
      d.status = "designing";
      d.starting = true;
      d.version += 1;
      try {
        const run: DesignBody = { ...d.design, count, ...(more ? { avoid: d.options.slice(-8).map((o) => (o as CarInput).car) } : {}), ...(body?.override ? { override: body.override } : {}) };
        const task = await designTask(store, ws, run, { seconds: runSeconds(store), fail: nextFailure(store) });
        const now = iso();
        Object.assign(d, { starting: false, taskId: task.taskId, more, message: null, model: task.model, effort: task.effort, startedAt: now, finishedAt: null, updatedAt: now });
      } catch (e) {
        Object.assign(d, before, { starting: false });
        throw e;
      }
      return shown(d);
    },
    async deleteVehicleDraft(ws, draftId) {
      guardWs(store, ws);
      await delay(80);
      store.vehicleDrafts = store.vehicleDrafts.filter((d) => !(d.draftId === draftId && d.workspaceId === ws));
    },
  };
}
