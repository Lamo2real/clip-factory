// Saved video drafts (docs/CONTRACTS.md §45.47): the mock's VDRAFT# routes (the loose check, the 50 and 32 KB caps, a
// stale version), Save draft on Make a new video (the toast, then "Saved" / "Saving…" and the save 2 s after a change),
// "Your drafts (N)" with Delete and Undo, opening one with ?draft= (gone picks left out, and said), Make the video
// deleting it, the leave guard's Save draft, and the Production list's Drafts group. Rendered with the mock's parts
// (fake timers).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { navigate } from "../src/lib/router.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as drafts from "../src/stories/api/mock/drafts.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as series from "../src/stories/api/mock/series.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { StoriesApi, StoriesConfig, VideoDraft, Workspace } from "../src/stories/api/types.ts";
import { matchStories, storiesHref, type StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no canvas: the engine previews draw nothing, quietly.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { resetSeriesLists } = await import("../src/stories/studio/SeriesSwitch.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");
const { LEAVE_TITLE } = await import("../src/stories/studio/leaveGuard.tsx");

const C = stories.SEED_IDS.characters;
const CAR = characters.SEED_CAR_ID;
const GONE_ID = "01JSTCH0000000000000000GONE";

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Clips Funded",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 45,
    captionsOn: true,
    musicOn: true,
    providers: { images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" },
    video: { resolution: "1080x1920", aspect: "9:16", quality: "high", fps: 30 },
    production: { burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" },
    youtubeCategory: "1",
    youtubePrivacy: "unlisted",
    xMonthlyLimitUsd: null,
  } satisfies StoriesConfig,
  version: 1,
};

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  series.seed(store);
  characters.seedCar(store);
  series.afterSeed(store);
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...series.api(store),
    ...drafts.api(store),
    getWorkspace: async () => store.workspaces[0]!,
    guidance: async () => ({ topics: [], checkedAt: "2026-11-24T12:00:00.000Z" }),
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "Ready." })), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
    listReferences: async () => [],
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
  forgetLoaded();
  resetSeriesLists();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories/production/new");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

async function wait(ms = 1500) {
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
  await wait();
}

const page = (p: StoriesPage) => ({ ws: "stories", page: p });
const text = () => document.body.textContent ?? "";

function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label, summary"));
  const words = (el: HTMLElement) => [el.textContent?.trim() ?? "", el.getAttribute("aria-label") ?? ""];
  const hit = all.find((el) => words(el).some((w) => (typeof name === "string" ? w === name : name.test(w))));
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}

async function click(el: HTMLElement, ms = 300) {
  await act(async () => el.click());
  await wait(ms);
}

function type(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("not a text box");
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => x.textContent?.trim() === label);
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${label}`);
  return el;
}

async function pick(group: string, option: string) {
  const g = Array.from(document.querySelectorAll('[role="radiogroup"]')).find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === group);
  if (!g) throw new Error(`no pick bar ${group}`);
  const opt = Array.from(g.querySelectorAll("label")).find((l) => l.querySelector(".st-s-pick__label")?.textContent?.trim() === option);
  if (!opt) throw new Error(`no option ${option}`);
  await click(opt.querySelector("input") as HTMLElement, 50);
}

const tile = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".st-s-casttile")).find((t) => t.querySelector(".st-s-casttile__name")?.textContent === name)!;
const picked = () => Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"] .st-s-casttile__name')).map((t) => t.textContent);
const dialog = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) => d.querySelector(".st-s-sheet__title")?.textContent === title) ?? null;
const stateWord = () => document.querySelector(".st-vd-state")?.textContent ?? null;

async function call<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  const r = await settled;
  if (!r.ok) throw r.e;
  return r.v;
}

function seedDraft(over: Partial<VideoDraft> = {}): VideoDraft {
  const d: VideoDraft = {
    draftId: `01JSTVD00000000000000000${String(store.drafts.length + 1).padStart(2, "0")}`,
    workspaceId: "stories",
    name: "Dash at the beach",
    form: { source: "own", title: "Dash at the beach", logline: "Dash builds a sandcastle.", category: "comedy", characterIds: [C.dash], durationSec: 30 },
    version: 1,
    createdAt: "2026-11-24T10:00:00.000Z",
    updatedAt: "2026-11-24T11:00:00.000Z",
    ...over,
  };
  store.drafts.push(d);
  return d;
}

async function ownIdea(title = "The first drive") {
  await pick("Where the idea comes from", "Type an idea");
  type(field("Title"), title);
  type(field("What happens, in one line"), "Pip drives Rosso round the block.");
  await pick("What kind of video?", "Funny");
}

// ---------- The mock's routes ----------

describe("the video drafts routes (mock)", () => {
  it("make, read, save with its version, list newest first and delete; an unfinished form is fine", async () => {
    const a = await call(api.createVideoDraft("stories", { form: { source: "own" } }));
    expect(a).toMatchObject({ workspaceId: "stories", name: "Untitled video", version: 1, form: { source: "own" } });
    vi.setSystemTime(new Date("2026-11-24T12:05:00.000Z"));
    const b = await call(api.createVideoDraft("stories", { form: { ideaId: stories.SEED_IDS.ideas.sandwich } }));
    expect(b.name).toBe("The sandwich tower");
    expect((await call(api.listVideoDrafts("stories"))).items.map((d) => d.draftId)).toEqual([b.draftId, a.draftId]);
    const saved = await call(api.saveVideoDraft("stories", a.draftId, { form: { title: "  Park   day " }, version: 1 }));
    expect(saved).toMatchObject({ name: "Park day", version: 2 });
    await expect(call(api.saveVideoDraft("stories", a.draftId, { form: { title: "x" }, version: 1 }))).rejects.toMatchObject({ status: 409 });
    expect(await call(api.getVideoDraft("stories", a.draftId))).toMatchObject({ version: 2 });
    await call(api.deleteVideoDraft("stories", a.draftId));
    await expect(call(api.getVideoDraft("stories", a.draftId))).rejects.toMatchObject({ status: 404 });
  });

  it("checks loosely: an unknown key or a wrong type is a 400, over 32 KB a 413, the 51st a 409", async () => {
    await expect(call(api.createVideoDraft("stories", { form: { colour: "red" } as never }))).rejects.toMatchObject({ status: 400 });
    await expect(call(api.createVideoDraft("stories", { form: { durationSec: 5 } }))).rejects.toMatchObject({ status: 400 });
    await expect(call(api.createVideoDraft("stories", { form: { characterIds: ["a", "b", "c", "d", "e"] } }))).rejects.toMatchObject({ status: 400 });
    const long = { script: { scenes: Array.from({ length: 40 }, () => ({ what: "x".repeat(900) })) } };
    await expect(call(api.createVideoDraft("stories", { form: long }))).rejects.toMatchObject({ status: 413, code: "too_large" });
    for (let i = 0; i < 50; i += 1) seedDraft();
    await expect(call(api.createVideoDraft("stories", { form: {} }))).rejects.toMatchObject({ status: 409, message: "You have 50 drafts. Delete one first." });
    await expect(call(api.listVideoDrafts("clips"))).rejects.toMatchObject({ status: 409 });
  });

  it("making the video with its draftId deletes the draft; a draft that is gone already is fine", async () => {
    const d = seedDraft();
    const body = { characterIds: [C.pip], brief: { title: "x", logline: "y", category: "comedy" as const } };
    await call(api.createStory("stories", { ...body, draftId: d.draftId }));
    expect(store.drafts).toEqual([]);
    const made = await call(api.createStory("stories", { ...body, draftId: d.draftId }));
    expect(made.story.storyId).toBeTruthy();
  });

  it("?draft= is read and written by the router", () => {
    expect(matchStories("/stories/production/new", "?draft=01JSTVD0000000000000000001")).toMatchObject({ name: "production_new", draftId: "01JSTVD0000000000000000001" });
    expect(matchStories("/stories/production/new", "?draft=..%2F")).not.toHaveProperty("draftId");
    expect(storiesHref({ name: "production_new", ideaId: null, draftId: "d1" })).toBe("/stories/production/new?draft=d1");
  });
});

// ---------- Make a new video ----------

describe("Make a new video › Save draft", () => {
  it("Save draft keeps the form, says Draft saved, then saves itself 2 s after a change (Saving…, Saved)", async () => {
    const create = vi.spyOn(api, "createVideoDraft");
    const save = vi.spyOn(api, "saveVideoDraft");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea();
    await click(tile("Pip"));
    await click(tile("Rosso"));
    await click(control("Save draft"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1].form).toEqual({ source: "own", title: "The first drive", logline: "Pip drives Rosso round the block.", category: "comedy", characterIds: [C.pip, CAR] });
    expect(text()).toContain("Draft saved");
    expect(stateWord()).toBe("Saved");
    expect(store.drafts).toHaveLength(1);
    // a change: Saving… at once, and the save only 2 s after the last change
    type(field("Title"), "The second drive");
    await wait(50);
    expect(stateWord()).toBe("Saving…");
    await wait(1000);
    expect(save).not.toHaveBeenCalled();
    await wait(1500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![2]).toMatchObject({ version: 1, form: { title: "The second drive" } });
    expect(stateWord()).toBe("Saved");
    expect(store.drafts[0]).toMatchObject({ name: "The second drive", version: 2 });
  });

  it("Make the video sends the draft's id, and the draft is gone", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea();
    await click(tile("Pip"));
    await click(control("Save draft"));
    const id = store.drafts[0]!.draftId;
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1]).toMatchObject({ characterIds: [C.pip], draftId: id });
    expect(store.drafts).toEqual([]);
  });

  it("with no draft, Make the video sends no draftId (the body stays as it was)", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea();
    await click(tile("Pip"));
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1]).not.toHaveProperty("draftId");
    expect(create.mock.calls[0]![1]).not.toHaveProperty("roles");
  });

  it("leaving asks, and its Save draft saves and goes on", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea("Leave me");
    act(() => navigate("/stories/production"));
    await wait(50);
    const sheet = dialog(LEAVE_TITLE)!;
    expect(sheet).not.toBeNull();
    expect(Array.from(sheet.querySelectorAll("footer button")).map((b) => b.textContent)).toEqual(["Leave", "Keep editing", "Save draft"]);
    expect(sheet.querySelector(".st-btn--main")?.textContent).toBe("Save draft");
    await click(control("Save draft", sheet), 500);
    expect(store.drafts.map((d) => d.name)).toEqual(["Leave me"]);
    expect(location.pathname).toBe("/stories/production");
  });
});

describe("Make a new video › Your drafts and opening one", () => {
  it("Your drafts (N) lists them; Delete hides one with Undo, and deletes it when the toast is gone", async () => {
    seedDraft();
    seedDraft({ name: "Pip in the rain", updatedAt: "2026-11-24T11:30:00.000Z" });
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    const fold = document.querySelector(".st-vd-drafts")!;
    expect(fold.querySelector("summary")?.textContent).toBe("Your drafts (2)");
    expect(Array.from(fold.querySelectorAll(".st-s-run__title")).map((a) => a.textContent)).toEqual(["Pip in the rain", "Dash at the beach"]);
    expect(control("Open Dash at the beach").getAttribute("href")).toBe(`/stories/production/new?draft=${store.drafts[0]!.draftId}`);
    await click(control("Delete Dash at the beach"), 50);
    expect(document.querySelector(".st-vd-drafts summary")?.textContent).toBe("Your drafts (1)");
    await click(control("Undo"), 50);
    expect(document.querySelector(".st-vd-drafts summary")?.textContent).toBe("Your drafts (2)");
    await click(control("Delete Dash at the beach"), 50);
    await wait(9000);
    expect(store.drafts.map((d) => d.name)).toEqual(["Pip in the rain"]);
  });

  it("?draft= opens it: the picks come back, gone ones are left out and said, and it is not listed in the fold", async () => {
    const d = seedDraft({
      form: {
        source: "own",
        title: "Dash at the beach",
        logline: "Dash builds a sandcastle.",
        category: "comedy",
        characterIds: [C.dash, GONE_ID, CAR],
        roles: { mainId: C.dash },
        durationSec: 30,
        captionsOn: false,
      },
    });
    seedDraft({ name: "Another one" });
    const save = vi.spyOn(api, "saveVideoDraft");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null, draftId: d.draftId })} />);
    expect(field("Title").value).toBe("Dash at the beach");
    expect(field("What happens, in one line").value).toBe("Dash builds a sandcastle.");
    expect(picked()).toEqual(["Dash", "Rosso"]);
    expect(document.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("30");
    expect(text()).toContain("Some picks are gone. Pick again.");
    expect(document.querySelector(".st-vd-drafts summary")?.textContent).toBe("Your drafts (1)");
    expect(stateWord()).toBe("Saved");
    // opened: it saves itself after a change, with the version it read
    await click(tile("Pip"));
    await wait(2500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toBe(d.draftId);
    expect(save.mock.calls[0]![2]).toMatchObject({ version: 1, form: { characterIds: [C.dash, CAR, C.pip] } });
  });

  it("a draft opened with a villain keeps the roles, and Make the video sends them", async () => {
    const d = seedDraft({ form: { source: "own", title: "Chase", logline: "Bolt chases Pip.", category: "comedy", characterIds: [C.bolt, C.pip], roles: { mainId: C.pip, villainId: C.bolt } } });
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null, draftId: d.draftId })} />);
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1]).toMatchObject({ characterIds: [C.pip, C.bolt], roles: { mainId: C.pip, villainId: C.bolt }, draftId: d.draftId });
  });

  it("a draft that is gone says so and starts a new form", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null, draftId: "01JSTVD00000000000000GONE1" })} />);
    expect(text()).toContain("That draft is gone. Start a new one.");
    expect(control("Save draft")).toBeTruthy();
  });
});

describe("the Production list", () => {
  it("shows a Drafts group above Being made, each with Open", async () => {
    seedDraft();
    await show(<ProductionScreen {...page({ name: "production" })} />);
    const heads = Array.from(document.querySelectorAll("h2.st-s-section")).map((h) => h.textContent);
    expect(heads[0]).toBe("Drafts");
    expect(heads.indexOf("Drafts")).toBeLessThan(heads.indexOf("Being made"));
    expect(control("Open Dash at the beach").getAttribute("href")).toBe(`/stories/production/new?draft=${store.drafts[0]!.draftId}`);
  });
});
