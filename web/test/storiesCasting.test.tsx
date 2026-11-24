// A person and a car in one video (docs/CONTRACTS.md §45.43) and a video filed in a series (§45.44): the cast picker
// (People, then the "Your cars" row; a car swaps for the car picked; up to 3), castProblem's sentences (the API's), castOrder
// (the people as tapped, then the car), and what Production › Make a new video sends: the people first, `seriesId` only
// when a series is picked, the series' cast to start with; the Production list asked for one series only when the
// address says so. Rendered with the mock's parts (fake timers).
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import * as series from "../src/stories/api/mock/series.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { Character, StoriesApi, StoriesConfig, Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no canvas: the engine previews draw nothing, quietly.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { CastPicker, castOrder, castProblem } = await import("../src/stories/studio/CastPicker.tsx");
const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { resetSeriesLists } = await import("../src/stories/studio/SeriesSwitch.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");

const C = stories.SEED_IDS.characters;
const CAR = characters.SEED_CAR_ID;
const BLUE = "01JSTCH00000000000000CAR98";

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
    getWorkspace: async () => store.workspaces[0]!,
    guidance: async () => ({ topics: [], checkedAt: "2026-11-23T12:00:00.000Z" }),
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: LISTED_INFO.models.map((m) => ({ ...m, status: "ok", statusLine: "Ready." })), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
    listReferences: async () => [],
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
  forgetLoaded();
  resetSeriesLists();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
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

function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label"));
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
const text = () => document.body.textContent ?? "";

/** A second car, Blue. */
function addBlue() {
  const rosso = store.characters.find((c) => c.characterId === CAR)!;
  store.characters.push({ ...structuredClone(rosso), characterId: BLUE, name: "Blue" });
}

// ---------- The picker ----------

describe("CastPicker", () => {
  const chars = () => store.characters.filter((c) => c.workspaceId === "stories");
  let seen: string[][] = [];
  function Picker({ start = [] as string[], list = chars() }) {
    const [ids, setIds] = useState(start);
    return (
      <CastPicker
        characters={list}
        value={ids}
        onChange={(next) => {
          seen.push(next);
          setIds(next);
        }}
      />
    );
  }

  beforeEach(() => {
    seen = [];
  });

  it("with no car it is the plain row of people it always was", async () => {
    await show(<Picker list={chars().filter((c) => c.kind !== "car")} />);
    expect(document.querySelectorAll(".st-cast__row")).toHaveLength(0);
    expect(document.querySelectorAll("ul.st-s-castpick")).toHaveLength(1);
    expect(tile("Rosso")).toBeUndefined();
  });

  it("with cars only, the People row offers to make someone to drive", async () => {
    await show(<Picker list={chars().filter((c) => c.kind === "car")} />);
    expect(Array.from(document.querySelectorAll(".st-cast__row")).map((h) => h.textContent)).toEqual(["People", "Your cars"]);
    expect(control("Make someone to drive it").getAttribute("href")).toBe("/stories/characters/new");
  });

  it("People first, then the Your cars row; a picked car swaps for another one", async () => {
    addBlue();
    await show(<Picker />);
    expect(Array.from(document.querySelectorAll(".st-cast__row")).map((h) => h.textContent)).toEqual(["People", "Your cars"]);
    const rows = document.querySelectorAll("ul.st-s-castpick");
    expect(Array.from(rows[1]!.querySelectorAll(".st-s-casttile__name")).map((n) => n.textContent)).toEqual(["Rosso", "Blue"]);
    expect(rows[0]!.textContent).not.toContain("Rosso");
    await click(tile("Rosso"));
    await click(tile("Pip"));
    expect(picked()).toEqual(["Pip", "Rosso"]);
    // another car swaps, never adds
    await click(tile("Blue"));
    expect(picked()).toEqual(["Pip", "Blue"]);
    expect(seen.at(-1)).toEqual([C.pip, BLUE]);
    // tapping a picked one takes it out
    await click(tile("Blue"));
    expect(picked()).toEqual(["Pip"]);
  });

  it("a full cast says so on the people and on a car while no car is picked; a car still swaps", async () => {
    addBlue();
    await show(<Picker start={[C.pip, C.bolt, CAR]} />);
    expect(tile("Nana Rose").getAttribute("aria-disabled")).toBe("true");
    expect(tile("Nana Rose").getAttribute("title")).toBe("Pick up to 3 characters.");
    await click(tile("Nana Rose"));
    expect(seen).toEqual([]);
    expect(tile("Blue").getAttribute("aria-disabled")).toBeNull();
    await click(tile("Blue"));
    expect(seen.at(-1)).toEqual([C.pip, C.bolt, BLUE]);
    await act(async () => root.unmount());
    host.remove();
    seen = [];
    await show(<Picker start={[C.pip, C.bolt, C.nana]} />);
    expect(tile("Rosso").getAttribute("aria-disabled")).toBe("true");
    await click(tile("Rosso"));
    expect(seen).toEqual([]);
  });

  it("castProblem speaks the API's sentences, and castOrder puts the people first in the order tapped", () => {
    expect(castProblem([])).toBeNull();
    expect(castProblem([{}, { kind: "person" }])).toBeNull();
    expect(castProblem([{ kind: "car" }])).toBe("Add someone to drive it.");
    expect(castProblem([{}, { kind: "car" }])).toBeNull();
    expect(castProblem([{}, { kind: "car" }, { kind: "car" }])).toBe("Pick one car.");
    const list = chars();
    expect(castOrder([CAR, C.bolt, C.pip], list)).toEqual([C.bolt, C.pip, CAR]);
    expect(castOrder([C.pip, C.dash], list)).toEqual([C.pip, C.dash]);
    // an id not in the list stays with the people
    expect(castOrder([CAR, "01JSTCH0000000000000000099"], list)).toEqual(["01JSTCH0000000000000000099", CAR]);
  });
});

// ---------- Production ----------

describe("Production › Make a new video with a car and a series", () => {
  async function ownIdea() {
    await pick("Where the idea comes from", "Type an idea");
    type(field("Title"), "The first drive");
    type(field("What happens, in one line"), "Pip drives Rosso round the block.");
    await pick("What kind of video?", "Funny");
  }

  it("the people go first, and no seriesId is sent with no series picked", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea();
    await click(tile("Rosso"));
    await click(tile("Bolt"));
    await click(control("Make the video"), 1500);
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![1];
    expect(body.characterIds).toEqual([C.bolt, CAR]);
    expect(body).not.toHaveProperty("seriesId");
    const made = store.stories.find((s) => s.title === "The first drive")!;
    expect(made).not.toHaveProperty("seriesId");
  });

  it("a car alone is stopped with the API's sentence, and two cars cannot be picked", async () => {
    addBlue();
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await ownIdea();
    await click(tile("Rosso"));
    await click(tile("Blue"));
    expect(picked()).toEqual(["Blue"]);
    await click(control("Make the video"));
    expect(create).not.toHaveBeenCalled();
    expect(text()).toContain("Add someone to drive it.");
  });

  it("?series= files it there and starts with the series' cast", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null, seriesId: series.SEED_SERIES_ID })} />);
    expect(picked()).toEqual(["Pip", "Rosso"]);
    expect(document.querySelector(".st-series-field")?.textContent).toContain("My first car");
    await ownIdea();
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1]).toMatchObject({ characterIds: [C.pip, CAR], seriesId: series.SEED_SERIES_ID });
    expect(store.stories.find((s) => s.title === "The first drive")!.seriesId).toBe(series.SEED_SERIES_ID);
  });

  it("picking the series in the field brings its cast while the cast is untouched; a picked cast stays", async () => {
    const create = vi.spyOn(api, "createStory");
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await click(control(/^Series: /));
    await click(control(/^My first car/, document.querySelector('[role="dialog"]')!));
    expect(picked()).toEqual(["Pip", "Rosso"]);
    // the owner changes the cast: picking the series again keeps it
    await click(tile("Rosso"));
    await click(tile("Bolt"));
    await click(control(/^Series: /));
    await click(control(/^No series/, document.querySelector('[role="dialog"]')!));
    await click(control(/^Series: /));
    await click(control(/^My first car/, document.querySelector('[role="dialog"]')!));
    // (the tiles show in the gallery's order; the cast keeps the order tapped)
    expect(picked()).toEqual(["Bolt", "Pip"]);
    await ownIdea();
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1]).toMatchObject({ characterIds: [C.pip, C.bolt], seriesId: series.SEED_SERIES_ID });
  });
});

describe("Production list and the series switch", () => {
  it("asks for one series only when the address says so", async () => {
    const list = vi.spyOn(api, "listStories");
    await show(<ProductionScreen {...page({ name: "production" })} />);
    expect(list.mock.calls[0]![1]).toEqual({ status: "all", limit: 50 });
    const all = document.querySelectorAll(".st-s-run").length;
    await act(async () => root.unmount());
    host.remove();
    list.mockClear();
    await show(<ProductionScreen {...page({ name: "production", seriesId: series.SEED_SERIES_ID })} />);
    expect(list.mock.calls[0]![1]).toEqual({ status: "all", limit: 50, seriesId: series.SEED_SERIES_ID });
    const rows = document.querySelectorAll(".st-s-run");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(all);
    // inside a series, a new video is filed there
    expect(control("Make a new video").getAttribute("href")).toBe(`/stories/production/new?series=${series.SEED_SERIES_ID}`);
    // each row can move to another series
    expect(rows[0]!.querySelector(".st-series-move")).not.toBeNull();
  });
});

describe("the mock's cast check", () => {
  it("a story's cast keeps the people first in its script, the car in cars", async () => {
    const { story } = await (async () => {
      const p = api.createStory("stories", { characterIds: [C.pip, CAR], durationSec: 30, brief: { title: "Rosso's day", logline: "Pip and Rosso go out.", category: "comedy" } });
      await vi.advanceTimersByTimeAsync(1200);
      return p;
    })();
    stories.advanceJobs(store, Date.now() + 10 * 60_000);
    const s = store.scripts[story.storyId]!;
    const pip: Character = store.characters.find((c) => c.characterId === C.pip)!;
    expect(s.cast.c1!.name).toBe(pip.name);
    expect(s.cars!.c2!.characterId).toBe(CAR);
  });
});
