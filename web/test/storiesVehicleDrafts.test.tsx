// Clips Funded vehicle drafts: "Design with AI" for a new vehicle runs as a draft kept on the server, so the owner can
// go elsewhere in the app and find it under Vehicles, designing, ready or stopped. The pieces: the eased bar (monotonic,
// never 100% before ready), the polling pace, the route, the mock job (queued, running, done; a failing run; one design
// per draft at a time; 3 designing at once; 4 options), and the cards on the Vehicles list (rendered with fake timers).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import * as vd from "../src/stories/api/mock/vehicleDrafts.ts";
import type { ModelInfo, StoriesApi, StoriesConfig, VehicleDraft, Workspace } from "../src/stories/api/types.ts";
import { navigate } from "../src/lib/router.ts";
import { matchStories, storiesHref } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { CarsScreen } = await import("../src/stories/screens/Cars.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");
const { easedProgress, pollEvery, POLL_FAST_MS, POLL_SLOW_MS, secondsSince, turnedReady } = await import("../src/stories/studio/VehicleDrafts.tsx");

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Clips Funded",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 50,
    captionsOn: true,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1920", aspect: "9:16", quality: "high", fps: 30 },
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "27",
    youtubePrivacy: "public",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};
const MODELS: ModelInfo[] = LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "Ready." }));

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  forgetLoaded();
  store = createStore();
  store.knobs = { vehicleSeconds: 30 };
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  characters.afterSeed(store);
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...vd.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(MODELS), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
  };
  api = new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
  setStoriesApi(api);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function show(node: ReactNode) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await wait(300);
}

/** A call on the practice API waits on its own pretend delay: this lets the (fake) clock run until it answers. */
async function go<T>(p: Promise<T>): Promise<T> {
  let state: { ok: T } | { err: unknown } | null = null;
  p.then(
    (ok) => (state = { ok }),
    (err) => (state = { err }),
  );
  for (let i = 0; i < 200 && !state; i += 1) await wait(20);
  if (!state) throw new Error("the call never answered");
  if ("err" in (state as object)) throw (state as { err: unknown }).err;
  return (state as { ok: T }).ok;
}
/** The API as the tests call it: each call answers by itself. */
const t = new Proxy({} as StoriesApi, { get: (_, k: string) => (...a: unknown[]) => go((api as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[k]!(...a)) });

const text = () => document.body.textContent ?? "";
const design = (d: object = {}) => ({ design: { kind: "car" as const, description: "a red one", count: 3, ...d } });

describe("the eased bar", () => {
  it("only goes forward, starts and ends slowly, and is never full before the draft is ready", () => {
    let last = -1;
    for (let t = 0; t <= 4000; t += 1) {
      const p = easedProgress(t);
      expect(p).toBeGreaterThanOrEqual(last);
      expect(p).toBeLessThan(1);
      last = p;
    }
    expect(easedProgress(0)).toBe(0);
    // slow at the start, quick in the middle, slow again near the expected end
    const start = easedProgress(4) - easedProgress(0);
    const middle = easedProgress(24) - easedProgress(20);
    const end = easedProgress(44) - easedProgress(40);
    expect(start).toBeLessThan(middle / 3);
    expect(end).toBeLessThan(middle / 3);
    expect(easedProgress(Number.NaN)).toBe(0);
    expect(easedProgress(-5)).toBe(0);
  });

  it("counts the seconds from the server's start time, so a reload keeps them", () => {
    const at = "2026-11-25T12:00:00.000Z";
    expect(secondsSince(at, Date.parse(at) + 12_900)).toBe(12);
    expect(secondsSince(at, Date.parse(at) - 5000)).toBe(0);
    expect(secondsSince(null)).toBe(0);
  });
});

describe("how often the list is read", () => {
  it("every 2 s while any draft designs, else every 20 s", () => {
    expect(pollEvery([])).toBe(POLL_SLOW_MS);
    expect(pollEvery([{ status: "ready" }, { status: "failed" }])).toBe(POLL_SLOW_MS);
    expect(pollEvery([{ status: "ready" }, { status: "designing" }])).toBe(POLL_FAST_MS);
    expect(POLL_FAST_MS).toBe(2000);
    expect(POLL_SLOW_MS).toBe(20_000);
  });

  it("a draft that turns ready on this screen is found once", () => {
    const d = (draftId: string, status: VehicleDraft["status"]) => ({ draftId, status }) as VehicleDraft;
    const before = new Map<string, VehicleDraft["status"]>([["a", "designing"], ["b", "ready"], ["c", "designing"]]);
    expect(turnedReady(before, [d("a", "ready"), d("b", "ready"), d("c", "failed"), d("z", "ready")])).toEqual(["a"]);
  });
});

describe("the vehicle draft address", () => {
  it("opens /stories/vehicles/draft/{id} (and the older /cars/ one) and writes it back", () => {
    expect(matchStories("/stories/vehicles/draft/abc123", "")).toEqual({ name: "car_draft", draftId: "abc123" });
    expect(matchStories("/stories/cars/draft/abc123", "")).toEqual({ name: "car_draft", draftId: "abc123" });
    expect(storiesHref({ name: "car_draft", draftId: "abc123" })).toBe("/stories/vehicles/draft/abc123");
    expect(matchStories("/stories/vehicles/draft/a/b", "")).toEqual({ name: "not_found" });
    expect(matchStories("/stories/vehicles/draft/a b", "")).toEqual({ name: "not_found" });
    expect(matchStories("/stories/vehicles/abc123", "")).toEqual({ name: "car", characterId: "abc123" });
  });
});

describe("the practice run", () => {
  it("really waits (queued, running, then done with the cars), and a read settles it", async () => {
    const made = await t.createVehicleDraft("stories", design());
    expect(made).toMatchObject({ status: "designing", options: [], words: "a red one", finishedAt: null, message: null });
    expect(made.taskId).toBeTruthy();
    await wait(10_000);
    expect((await t.getVehicleDraft("stories", made.draftId)).status).toBe("designing");
    await wait(25_000);
    const done = await t.getVehicleDraft("stories", made.draftId);
    expect(done.status).toBe("ready");
    expect(done.options).toHaveLength(3);
    expect(done.finishedAt).toBeTruthy();
    expect((await t.listVehicleDrafts("stories")).items.map((d) => d.draftId)).toEqual([made.draftId]);
  });

  it("a failing run says why, and Try again runs the stored design once more", async () => {
    store.knobs.vehicleFail = "The helper cannot reach the model.";
    const made = await t.createVehicleDraft("stories", design());
    await wait(35_000);
    const failed = await t.getVehicleDraft("stories", made.draftId);
    expect(failed).toMatchObject({ status: "failed", message: "The helper cannot reach the model.", options: [] });
    const again = await t.redesignVehicleDraft("stories", made.draftId, {});
    expect(again.status).toBe("designing");
    expect(again.taskId).not.toBe(made.taskId);
    await wait(35_000);
    expect((await t.getVehicleDraft("stories", made.draftId)).status).toBe("ready");
  });

  it("one design per draft: a second press is a 409 and never a second task", async () => {
    const made = await t.createVehicleDraft("stories", design());
    const tasks = store.tasks.length;
    await expect(t.redesignVehicleDraft("stories", made.draftId, {})).rejects.toMatchObject({ status: 409, message: vd.STILL });
    await wait(35_000);
    await t.getVehicleDraft("stories", made.draftId);
    // the same moment twice, after it is ready: one wins, the other is a 409
    const both = Promise.allSettled([api.redesignVehicleDraft("stories", made.draftId, {}), api.redesignVehicleDraft("stories", made.draftId, {})]);
    await wait(1000);
    expect((await both).filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(store.tasks.length).toBe(tasks + 1);
  });

  it("3 designing at once, up to 4 options, and a stopped task is a stopped draft", async () => {
    const a = await t.createVehicleDraft("stories", design());
    await t.createVehicleDraft("stories", design());
    await t.createVehicleDraft("stories", design());
    await expect(t.createVehicleDraft("stories", design())).rejects.toMatchObject({ status: 409, message: vd.TOO_MANY_RUNNING });
    await wait(35_000);
    expect((await t.getVehicleDraft("stories", a.draftId)).options).toHaveLength(3);
    await t.redesignVehicleDraft("stories", a.draftId, { more: true });
    await wait(35_000);
    const four = await t.getVehicleDraft("stories", a.draftId);
    expect(four.options).toHaveLength(4);
    await expect(t.redesignVehicleDraft("stories", a.draftId, { more: true })).rejects.toMatchObject({ status: 409 });
    // the task is lost: it settles to a plain sentence
    await t.redesignVehicleDraft("stories", a.draftId, {});
    store.tasks = store.tasks.filter((t) => t.taskId !== store.vehicleDrafts.find((d) => d.draftId === a.draftId)!.taskId);
    const lost = await t.getVehicleDraft("stories", a.draftId);
    expect(lost.status).toBe("failed");
    expect(lost.message).toMatch(/helper stopped/i);
    expect(lost.options).toHaveLength(4);
  });

  it("only a new vehicle: no characterId, no person, and the keys are checked; Delete always works", async () => {
    await expect(t.createVehicleDraft("stories", { design: { kind: "car", description: "x", characterId: "abc" } as never })).rejects.toMatchObject({ status: 400 });
    await expect(t.createVehicleDraft("stories", { design: { kind: "person", description: "x" } })).rejects.toMatchObject({ status: 400 });
    await expect(t.createVehicleDraft("stories", { ...design(), extra: 1 } as never)).rejects.toMatchObject({ status: 400 });
    await expect(t.createVehicleDraft("stories", { design: { kind: "car" } })).rejects.toMatchObject({ status: 400 });
    const made = await t.createVehicleDraft("stories", design());
    await t.deleteVehicleDraft("stories", made.draftId);
    await t.deleteVehicleDraft("stories", made.draftId);
    expect((await t.listVehicleDrafts("stories")).items).toEqual([]);
  });
});

describe("the drafts on the Vehicles list", () => {
  it("a draft is not an empty list; it shows designing with a bar, the seconds and the model, then Ready", async () => {
    store.characters = store.characters.filter((c) => c.kind !== "car");
    const up = await t.designUpload("stories", { filename: "front.png", contentType: "image/png", size: 3000 });
    const made = await t.createVehicleDraft("stories", design({ referenceAssetIds: [up.assetId] }));
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    expect(text()).not.toContain("No vehicles yet");
    const card = () => document.querySelector<HTMLElement>(".st-vdc")!;
    expect(card().dataset.status).toBe("designing");
    expect(card().textContent).toContain("New vehicle");
    expect(card().textContent).toContain("Car");
    expect(card().textContent).toContain("Designing");
    expect(card().querySelector("img")).not.toBeNull();
    const bar = () => Number(card().querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"));
    const first = bar();
    expect(first).toBeLessThan(100);
    await wait(10_000);
    expect(bar()).toBeGreaterThan(first);
    expect(bar()).toBeLessThan(100);
    expect(card().textContent).toMatch(/1\d s/);
    expect(card().querySelector("a")!.getAttribute("href")).toBe(`/stories/vehicles/draft/${made.draftId}`);
    await wait(25_000);
    expect(card().dataset.status).toBe("ready");
    expect(card().textContent).toContain("Ready");
    expect(card().querySelector('[role="progressbar"]')).toBeNull();
  });

  it("reads the list every 2 s while one designs and slows to every 20 s after", async () => {
    const list = vi.spyOn(api, "listVehicleDrafts");
    await t.createVehicleDraft("stories", design());
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    list.mockClear();
    await wait(10_000);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(list.mock.calls.length).toBeLessThanOrEqual(6);
    await wait(25_000);
    list.mockClear();
    await wait(60_000);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(list.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("a stopped draft says one short line with Try again and Delete, and Try again designs it once more", async () => {
    store.knobs.vehicleFail = true;
    await t.createVehicleDraft("stories", design());
    await wait(35_000);
    const again = vi.spyOn(api, "redesignVehicleDraft");
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    const card = document.querySelector<HTMLElement>(".st-vdc")!;
    expect(card.dataset.status).toBe("failed");
    expect(card.textContent).toContain("Stopped");
    expect(card.querySelector(".st-vdc__line--bad")!.textContent).toBe("The helper stopped. Tap Try again.");
    const buttons = Array.from(card.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Try again", "Delete"]);
    await act(async () => card.querySelector<HTMLElement>("button")!.click());
    await wait(500);
    expect(again).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLElement>(".st-vdc")!.dataset.status).toBe("designing");
  });

  it("a first read that fails shows no stall and keeps retrying every 20 s", async () => {
    await t.createVehicleDraft("stories", design());
    vi.spyOn(api, "listVehicleDrafts").mockRejectedValueOnce(new Error("boom"));
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    expect(document.querySelector(".st-vdc")).toBeNull();
    expect(text()).not.toContain("Getting your vehicles");
    await wait(21_000);
    expect(document.querySelector(".st-vdc")).not.toBeNull();
  });

  it("says out loud (a polite status) when a draft turns ready", async () => {
    await t.createVehicleDraft("stories", design());
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    const status = () => document.querySelector('[role="status"][aria-live="polite"].st-s-sr')!.textContent;
    expect(status()).toBe("");
    await wait(35_000);
    expect(status()).toBe("New vehicle is ready.");
  });

  it("Try again after a failed Make more runs as more, so the options stay", async () => {
    const made = await t.createVehicleDraft("stories", design());
    await wait(35_000);
    store.knobs.vehicleFail = true;
    await t.redesignVehicleDraft("stories", made.draftId, { more: true });
    await wait(35_000);
    const again = vi.spyOn(api, "redesignVehicleDraft");
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    const card = document.querySelector<HTMLElement>(".st-vdc")!;
    expect(card.dataset.status).toBe("failed");
    await act(async () => card.querySelector<HTMLElement>("button")!.click());
    await wait(500);
    expect(again).toHaveBeenCalledWith("stories", made.draftId, { more: true });
  });

  it("Delete on a ready draft with vehicles asks first; on a stopped one it goes at once", async () => {
    const ready = await t.createVehicleDraft("stories", design({ description: "ready one" }));
    await wait(35_000);
    store.knobs.vehicleFail = true;
    await t.createVehicleDraft("stories", design({ description: "stopped one" }));
    await wait(35_000);
    await show(<CarsScreen ws="stories" page={{ name: "cars" }} />);
    expect(document.querySelectorAll(".st-vdc")).toHaveLength(2);
    const del = (status: string) => Array.from(document.querySelectorAll<HTMLElement>(`.st-vdc[data-status="${status}"] button`)).find((b) => b.textContent === "Delete")!;
    await act(async () => del("failed").click());
    await wait(500);
    expect(document.querySelectorAll(".st-vdc")).toHaveLength(1);
    await act(async () => del("ready").click());
    await wait(300);
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.textContent).toContain("cartoon vehicles");
    expect(store.vehicleDrafts.map((d) => d.draftId)).toEqual([ready.draftId]);
    await act(async () => Array.from(sheet.querySelectorAll("button")).find((b) => b.textContent === "Delete")!.click());
    await wait(500);
    expect(store.vehicleDrafts).toHaveLength(0);
    expect(document.querySelectorAll(".st-vdc")).toHaveLength(0);
  });
});

describe("one draft's page", () => {
  const open = (draftId: string) => show(<CarsScreen ws="stories" page={{ name: "car_draft", draftId }} />);

  it("while it designs: the photos and words read only, the one task line with seconds, a calm note, and no second design", async () => {
    const up = await t.designUpload("stories", { filename: "front.png", contentType: "image/png", size: 3000 });
    const made = await t.createVehicleDraft("stories", design({ referenceAssetIds: [up.assetId] }));
    await wait(7000);
    const redesign = vi.spyOn(api, "redesignVehicleDraft");
    await open(made.draftId);
    expect(document.querySelector("h1")!.textContent).toBe("New vehicle");
    expect(text()).toContain("a red one");
    expect(document.querySelector(".st-vdp__photos img")).not.toBeNull();
    expect(document.querySelector(".st-s-photos")).toBeNull();
    expect(text()).toMatch(/Designing your character with Claude Opus 5\.5 · High effort… \d+ s/);
    expect(text()).toContain("You can leave. It keeps going in Vehicles.");
    expect(document.querySelector('a[href="/stories/vehicles"]')).not.toBeNull();
    // the seconds come from the server's start, so they are not 0 on a fresh page
    expect(Number(/… (\d+) s/.exec(text())![1])).toBeGreaterThanOrEqual(7);
    const main = Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => b.textContent === "Designing…")!;
    expect(main.getAttribute("aria-disabled")).toBe("true");
    await act(async () => main.click());
    await wait(300);
    expect(redesign).not.toHaveBeenCalled();
    // then ready: the cartoon vehicles to pick from and the editor
    await wait(30_000);
    expect(document.querySelectorAll(".st-s-caropts .st-s-pick__opt")).toHaveLength(3);
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Design it again")).toBe(true);
    expect(text()).toContain("Make more");
    expect(text()).toContain("Name and personality");
    expect(text()).not.toContain("Change photos");
  });

  it("when it stopped: the plain sentence, Try again and Delete (Delete goes back to Vehicles)", async () => {
    store.knobs.vehicleFail = "The helper stopped. Tap Try again.";
    const made = await t.createVehicleDraft("stories", design());
    await wait(35_000);
    await open(made.draftId);
    expect(document.querySelector(".st-s-notice--bad")!.textContent).toContain("The helper stopped. Tap Try again.");
    const labels = Array.from(document.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toContain("Try again");
    expect(labels).toContain("Delete");
    await act(async () => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Delete")!.click());
    await wait(1000);
    expect(store.vehicleDrafts).toHaveLength(0);
  });

  it("a ready draft has nothing unsaved: leaving does not ask", async () => {
    const made = await t.createVehicleDraft("stories", design());
    await wait(35_000);
    await open(made.draftId);
    expect(text()).toContain("Name and personality");
    await act(async () => navigate("/stories/ideas"));
    await wait(300);
    expect(document.querySelector('[role="dialog"]')?.textContent ?? "").not.toContain("Leave without saving");
  });

  it("Try again after a failed Make more runs as more", async () => {
    const made = await t.createVehicleDraft("stories", design());
    await wait(35_000);
    store.knobs.vehicleFail = true;
    await t.redesignVehicleDraft("stories", made.draftId, { more: true });
    await wait(35_000);
    const again = vi.spyOn(api, "redesignVehicleDraft");
    await open(made.draftId);
    await act(async () => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Try again")!.click());
    await wait(500);
    expect(again).toHaveBeenCalledWith("stories", made.draftId, { more: true });
  });

  it("a draft that is gone says so", async () => {
    await open("nothing");
    expect(text()).toContain("That draft is gone.");
  });
});
