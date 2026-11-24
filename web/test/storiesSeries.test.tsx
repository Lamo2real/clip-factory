// Clips Funded › Series (docs/CONTRACTS.md §45.43): a folder per series with its story so far, the "All ▾" switch,
// Move with its confirm, and Ideas inside a series. Rendered with the mock's ideas, characters, stories and series
// parts (setStoriesApi); nothing leaves the machine.
import { act, type ReactNode } from "react";
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
import type { StoriesApi, Workspace } from "../src/stories/api/types.ts";
import type { StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { SeriesScreen, seriesProblem, episodesWord } = await import("../src/stories/screens/Series.tsx");
const { IdeasScreen } = await import("../src/stories/screens/Ideas.tsx");
const { SeriesSwitch, MoveToSeries, resetSeriesLists, seriesQuery, filterOf, inFilter } = await import("../src/stories/studio/SeriesSwitch.tsx");

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;
const SR = series.SEED_SERIES_ID;

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Clips Funded",
  workspaceType: "stories",
  builtin: false,
  configuration: { defaultDurationSec: 45 } as Workspace["configuration"],
  version: 1,
};

let store: MockStore;
let api: StoriesApi;
let root: Root;
let host: HTMLElement;

function makeApi(withSeries = true): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  if (withSeries) series.seed(store);
  characters.afterSeed?.(store);
  if (withSeries) series.afterSeed(store);
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    ...series.api(store),
    getWorkspace: async () => store.workspaces[0]!,
    guidance: async () => ({ topics: [], checkedAt: "2026-11-21T12:00:00.000Z" }),
    getAi: async () => Promise.reject(new Error("not used")),
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
  forgetLoaded();
  resetSeriesLists();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories/series");
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

async function click(el: HTMLElement, ms = 1500) {
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

function field(label: string | RegExp): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(document.querySelectorAll<HTMLLabelElement>("label[for]")).find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${String(label)}`);
  return el;
}

const text = () => document.body.textContent ?? "";
const sheet = () => document.querySelector<HTMLElement>(".st-series-sheet");

describe("the series words and filters", () => {
  it("checks a new series as the API does, and counts episodes in words", () => {
    const pip = store.characters.find((c) => c.characterId === C.pip)!;
    const car = store.characters.find((c) => c.characterId === characters.SEED_CAR_ID)!;
    expect(seriesProblem("  ", "", [])).toBe("Give your series a name.");
    expect(seriesProblem("x".repeat(41), "", [])).toBe("Keep the name to 40 letters.");
    expect(seriesProblem("Ok", "x".repeat(121), [])).toBe("Keep the line to 120 letters.");
    expect(seriesProblem("Ok", "", [car])).toBe("Add someone to drive it.");
    expect(seriesProblem("Ok", "", [pip, car])).toBeNull();
    expect([0, 1, 2].map(episodesWord)).toEqual(["No episodes yet", "1 episode", "2 episodes"]);
  });

  it("maps a filter to the query and back, and No series also catches a series that is gone", () => {
    expect([seriesQuery("all"), seriesQuery("none"), seriesQuery(SR)]).toEqual([undefined, "none", SR]);
    expect(filterOf({})).toBe("all");
    expect(filterOf({ seriesId: SR })).toBe(SR);
    const list = [{ seriesId: SR }] as never;
    expect(inFilter({ seriesId: "GONE" }, "none", list)).toBe(true);
    expect(inFilter({}, "none", list)).toBe(true);
    expect(inFilter({ seriesId: SR }, "none", list)).toBe(false);
    expect(inFilter({ seriesId: SR }, SR, list)).toBe(true);
    expect(inFilter({}, "all", list)).toBe(true);
  });
});

describe("Series", () => {
  it("lists the folders, and New series makes one with its cast, the people first, then opens it", async () => {
    const create = vi.spyOn(api, "createSeries");
    await show(<SeriesScreen {...page({ name: "series" })} />);
    expect(Array.from(document.querySelectorAll(".st-series-card__name")).map((e) => e.textContent)).toEqual(["My first car"]);
    expect(text()).toContain("1 episode");
    await click(control("New series"));
    await click(control("Make it"), 50);
    expect(sheet()!.textContent).toContain("Give your series a name.");
    type(field("Name"), "Rainy days");
    await click(control(/^Rosso/, sheet()!), 50);
    await click(control("Make it"), 50);
    expect(sheet()!.textContent).toContain("Add someone to drive it.");
    await click(control(/^Pip/, sheet()!), 50);
    type(field("About it (you can skip this)"), "Pip drives in the rain");
    await click(control("Make it"));
    expect(create).toHaveBeenCalledWith("stories", { name: "Rainy days", line: "Pip drives in the rain", castIds: [C.pip, characters.SEED_CAR_ID] });
    const made = store.series.find((s) => s.name === "Rainy days")!;
    expect(location.pathname).toBe(`/stories/series/${made.seriesId}`);
  });

  it("shows the empty home with one clear action", async () => {
    api = makeApi(false);
    setStoriesApi(api);
    await show(<SeriesScreen {...page({ name: "series" })} />);
    expect(text()).toContain("Keep a story's videos together.");
    expect(document.querySelectorAll(".st-series-empty .st-btn--main")).toHaveLength(1);
  });

  it("a folder shows its story so far, episodes, coming up and cast; Make the next episode presets the cast and the series", async () => {
    store.stories.find((s) => s.storyId === S.review)!.seriesId = SR;
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    expect(document.querySelector(".st-series-head__name")?.textContent).toBe("My first car");
    expect(document.querySelector(".st-series-sofar")?.textContent).toContain("Who: Pip and Rosso");
    expect(text()).toContain("Written by Clips Funded");
    expect(document.querySelector(".st-series-ep__n")?.textContent).toBe("Ep 1");
    expect(text()).toContain("Pip bought Rosso");
    expect(document.querySelector(".st-series-coming")?.textContent).toContain("When the car starts to slide");
    expect(Array.from(document.querySelectorAll(".st-series-cast li span")).map((e) => e.textContent)).toEqual(["Pip", "Rosso"]);
    await click(control("Make the next episode"), 50);
    expect(location.pathname + location.search).toBe(`/stories/production/new?cast=${C.pip}&cast=${characters.SEED_CAR_ID}&series=${SR}`);
  });

  it("with an idea saved in the series, Make the next episode opens it ready to make, with the cast and the series", async () => {
    store.ideas.find((i) => i.ideaId === I.gps)!.seriesId = SR;
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control("Make the next episode"), 50);
    expect(location.pathname + location.search).toBe(`/stories/production/new?idea=${I.gps}&cast=${C.pip}&cast=${characters.SEED_CAR_ID}&series=${SR}`);
  });

  it("Change cast saves the series' new cast (the main character first, then the car)", async () => {
    const patch = vi.spyOn(api, "patchSeries");
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control(/^More for/), 50);
    await click(control("Change cast"), 300);
    const dash = Array.from(document.querySelectorAll<HTMLButtonElement>(".st-s-casttile")).find((b) => b.textContent?.includes("Dash"))!;
    await click(dash, 50);
    await click(control("Save"), 300);
    expect(patch).toHaveBeenCalledWith("stories", SR, expect.objectContaining({ castIds: [C.pip, C.dash, characters.SEED_CAR_ID] }));
    expect(Array.from(document.querySelectorAll(".st-series-cast li span")).map((e) => e.textContent)).toEqual(["Pip", "Dash", "Rosso"]);
  });

  it("Ask for ideas opens Ideas inside the series with Ask for ideas open", async () => {
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control("Ask for ideas"), 50);
    expect(location.pathname + location.search).toBe(`/stories/ideas?series=${SR}&ask=1`);
  });

  it("Story so far: Edit sends the version it read, then says Edited by you", async () => {
    const patch = vi.spyOn(api, "patchSeries");
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control("Edit"), 50);
    type(field("Story so far"), "Who: Pip and Rosso.\nWhere things stand: Pip washed Rosso.");
    await click(control("Save"));
    expect(patch).toHaveBeenCalledWith("stories", SR, { version: 2, storySoFar: "Who: Pip and Rosso.\nWhere things stand: Pip washed Rosso." });
    expect(document.querySelector(".st-series-sofar")?.textContent).toContain("Pip washed Rosso.");
    expect(text()).toContain("Edited by you");
    // Someone else changed it meanwhile: the plain sentence, nothing lost.
    store.series[0]!.version = 9;
    await click(control("Edit"), 50);
    type(field("Story so far"), "Who: Pip.");
    await click(control("Save"));
    expect(text()).toContain("Someone changed this meanwhile. Look again, then save.");
  });

  it("the recap: Writing it… while it runs, the sentence and Write it again when it failed, then the summary", async () => {
    const s = store.series[0]!;
    s.summaries = [];
    s.recap = { taskId: "T1", storyId: S.published, status: "running" };
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    expect(text()).toContain("Writing it…");
    expect(control("Edit").getAttribute("aria-disabled")).toBe("true");
    s.recap = { taskId: "T1", storyId: S.published, status: "failed", error: series.RECAP_FAILED };
    await wait(2500);
    expect(text()).toContain(series.RECAP_FAILED);
    const recap = vi.spyOn(api, "recapEpisode");
    await click(control("Write it again"));
    expect(recap).toHaveBeenCalledWith("stories", SR, S.published);
    expect(text()).not.toContain(series.RECAP_FAILED);
    expect(document.querySelector(".st-series-ep__summary")?.textContent).toContain("Episode 1");
  });

  it("an episode with no summary offers Write it", async () => {
    store.series[0]!.summaries = [];
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    expect(text()).toContain("No summary yet");
    const recap = vi.spyOn(api, "recapEpisode");
    await click(control(/^Write it for Ep 1/));
    expect(recap).toHaveBeenCalledWith("stories", SR, S.published);
  });

  it("Delete asks first, keeps the videos under No series and goes back home", async () => {
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control("More for My first car"), 50);
    await click(control("Delete", sheet()!), 50);
    expect(sheet()!.textContent).toContain("Delete My first car? Its videos stay, under No series.");
    await click(control("Keep it"), 50);
    expect(store.series).toHaveLength(1);
    await click(control("More for My first car"), 50);
    await click(control("Delete", sheet()!), 50);
    await click(control("Delete", sheet()!));
    expect(store.series).toHaveLength(0);
    expect(store.stories.find((s) => s.storyId === S.published)?.seriesId).toBeUndefined();
    expect(location.pathname).toBe("/stories/series");
    expect(text()).toContain("Deleted. Its videos are under No series.");
  });

  it("Rename saves the new name with the version", async () => {
    const patch = vi.spyOn(api, "patchSeries");
    await show(<SeriesScreen {...page({ name: "series_one", seriesId: SR })} />);
    await click(control("More for My first car"), 50);
    await click(control("Rename"), 50);
    type(field("Name"), "Pip's first car");
    await click(control("Save", sheet()!));
    expect(patch).toHaveBeenCalledWith("stories", SR, { version: 2, name: "Pip's first car" });
    expect(document.querySelector(".st-series-head__name")?.textContent).toBe("Pip's first car");
  });
});

describe("the switch and Move", () => {
  it("SeriesSwitch is not shown while the workspace has no series", async () => {
    api = makeApi(false);
    setStoriesApi(api);
    await show(<SeriesSwitch ws="stories" value="all" onChange={() => undefined} />);
    expect(document.querySelector(".st-series-switch")).toBeNull();
  });

  it("SeriesSwitch: All, each series and No series, one tap", async () => {
    const onChange = vi.fn();
    await show(<SeriesSwitch ws="stories" value="all" onChange={onChange} />);
    const btn = control(/^Show series: All/);
    expect(btn.textContent).toContain("All");
    await click(btn, 50);
    expect(Array.from(sheet()!.querySelectorAll(".st-series-choice__name")).map((e) => e.textContent)).toEqual(["All", "My first car", "No series"]);
    await click(control(/^My first car/, sheet()!), 50);
    expect(onChange).toHaveBeenCalledWith(SR);
    expect(sheet()).toBeNull();
  });

  it("Move asks first, then moves a video and says where", async () => {
    const move = vi.spyOn(api, "moveStoryToSeries");
    const moved = vi.fn();
    await show(<MoveToSeries ws="stories" kind="story" id={S.review} title="When the car starts to slide" current={null} onMoved={moved} />);
    await click(control(/^Move “When the car starts to slide”/), 50);
    await click(control(/^My first car/, sheet()!), 50);
    expect(sheet()!.textContent).toContain("Move “When the car starts to slide” to My first car?");
    expect(move).not.toHaveBeenCalled();
    await click(control("Move", sheet()!));
    expect(move).toHaveBeenCalledWith("stories", S.review, SR);
    expect(moved).toHaveBeenCalledWith(SR);
    expect(text()).toContain("Moved to My first car.");
    expect(store.stories.find((s) => s.storyId === S.review)?.seriesId).toBe(SR);
  });

  it("Move out of a series asks the plain question", async () => {
    const patch = vi.spyOn(api, "patchIdea");
    store.ideas.find((i) => i.ideaId === I.gps)!.seriesId = SR;
    await show(<MoveToSeries ws="stories" kind="idea" id={I.gps} title="Nana Rose and the sleepy GPS" current={SR} onMoved={() => undefined} />);
    await click(control(/^Move “Nana Rose/), 50);
    await click(control(/^No series/, sheet()!), 50);
    expect(sheet()!.textContent).toContain("Move it out of the series?");
    await click(control("Move", sheet()!));
    expect(patch).toHaveBeenCalledWith("stories", I.gps, { seriesId: null });
    expect(text()).toContain("Moved out of the series.");
  });
});

describe("Ideas in a series", () => {
  it("the switch filters the board in the browser, and No series catches the rest", async () => {
    store.ideas.find((i) => i.ideaId === I.gps)!.seriesId = SR;
    store.ideas.find((i) => i.ideaId === I.rainbow)!.seriesId = "01JSTSR00000000000000000ZZ"; // a series that is gone
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: SR })} />);
    expect(Array.from(document.querySelectorAll(".st-s-idea__title")).map((e) => e.textContent)).toEqual(["Nana Rose and the sleepy GPS"]);
    expect(control(/^Show series:/).textContent).toContain("My first car");
    await act(async () => root.unmount());
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: "none" })} />);
    const titles = Array.from(document.querySelectorAll(".st-s-idea__title")).map((e) => e.textContent);
    expect(titles).toContain("How a rainbow is made");
    expect(titles).not.toContain("Nana Rose and the sleepy GPS");
  });

  it("New idea inside a series is filed there with the series' cast, and says For {name}", async () => {
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: SR })} />);
    await click(control("New idea"), 50);
    expect(text()).toContain("For My first car");
    type(field("Title"), "The car wash");
    type(field("What happens, in one line"), "Pip washes Rosso and gets soaked.");
    const funny = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest("label")?.textContent?.includes("Funny"))!;
    await click(funny, 50);
    await click(control("Save idea"));
    expect(create).toHaveBeenCalledWith("stories", {
      title: "The car wash",
      logline: "Pip washes Rosso and gets soaked.",
      category: "comedy",
      source: "manual",
      seriesId: SR,
      characterIds: [C.pip, characters.SEED_CAR_ID],
    });
  });

  it("New idea inside a series is filed there even when the series list could not be read", async () => {
    vi.spyOn(api, "listSeries").mockRejectedValue(new Error("offline"));
    const create = vi.spyOn(api, "createIdea");
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: SR })} />);
    await click(control("New idea"), 50);
    type(field("Title"), "The car wash");
    type(field("What happens, in one line"), "Pip washes Rosso and gets soaked.");
    const funny = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest("label")?.textContent?.includes("Funny"))!;
    await click(funny, 50);
    await click(control("Save idea"));
    expect(create).toHaveBeenCalledWith("stories", expect.objectContaining({ title: "The car wash", seriesId: SR }));
  });

  it("?ask=1 opens Ask for ideas at once, and it asks for the series", async () => {
    const generate = vi.spyOn(api, "generateIdeas");
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: SR, ask: true })} />);
    expect(document.querySelector('form[aria-label="Ask for ideas"]')).not.toBeNull();
    await click(control("Get ideas"), 3000);
    expect(generate).toHaveBeenCalledWith("stories", { count: 4, seriesId: SR });
  });

  it("Make the video carries the idea's series", async () => {
    store.ideas.find((i) => i.ideaId === I.gps)!.seriesId = SR;
    await show(<IdeasScreen {...page({ name: "ideas", seriesId: SR })} />);
    await click(control("Make the video"), 50);
    expect(location.pathname + location.search).toBe(`/stories/production/new?idea=${I.gps}&series=${SR}`);
  });
});
