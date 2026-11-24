// "Write it myself": the owner's own script of what happens (docs/CONTRACTS.md §45.46.9).
// The pure helpers (splitting a pasted script, who and where from the words, the questions, reading time and length),
// Production › New's third choice (its scenes, the questions, the checks and their focus, the preview, the request it
// sends with the words exactly as typed), the step track's own words, Review's Change my script, and the mock: one
// scene for each script scene in order, the owner's caption cues word for word, the PATCH paths and the fact check
// that reports and never rewrites. Rendered with the mock's ideas, characters and stories parts; nothing leaves the
// machine.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { navigate } from "../src/lib/router.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import { STEP_ORDER, type OwnScript, type ProductionJob, type StoriesApi, type StoriesConfig, type Story, type StoryInput, type Workspace } from "../src/stories/api/types.ts";
import { validateScript } from "../src/stories/engine/engine.ts";
import type { StoriesPage } from "../src/stories/routes.ts";
import { aboutDriving, castInNoScene, defaultLength, DRIVING_WORDS, emptyDraft, fitTarget, namesIn, need, newScene, openAsks, placeIn, sameWords, sceneOfProblem, scenePlace, sceneWho, scriptProblem, splitScript, toOwnScript, unknownNames, type ScriptDraft } from "../src/stories/studio/ownScript.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { ProductionScreen } = await import("../src/stories/screens/Production.tsx");
const { ReviewScreen } = await import("../src/stories/screens/Review.tsx");
const { StepTrack, nowLine, stepsOf } = await import("../src/stories/studio/StepTrack.tsx");
const { leaveHolders, LEAVE_TITLE } = await import("../src/stories/studio/leaveGuard.tsx");

const S = stories.SEED_IDS.stories;
const C = stories.SEED_IDS.characters;
const I = stories.SEED_IDS.ideas;
const ROSSO = "01JSTCH0000000000000000005";

const WS: Workspace = {
  workspaceId: "stories",
  workspaceName: "Clips Funded",
  workspaceType: "stories",
  builtin: false,
  configuration: {
    defaultDurationSec: 50,
    captionsOn: false,
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
let root: Root | undefined;
let host: HTMLElement | undefined;

function makeApi(): StoriesApi {
  store = createStore();
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  characters.afterSeed(store);
  const now = "2026-11-24T12:00:00.000Z";
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    library: async () => ({ items: [], nextCursor: null }),
    guidance: async () => ({ topics: [], checkedAt: now }),
    listPublishing: async () => [],
    listReferences: async () => [],
  };
  return new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z"));
  forgetLoaded();
  api = makeApi();
  setStoriesApi(api);
  history.replaceState(null, "", "/stories");
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
  vi.useRealTimers();
});

async function wait(ms = 1500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Runs a mock call to the end (its fake latency included). */
async function call<T>(p: Promise<T>): Promise<T> {
  const out = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(1200);
  const r = await out;
  if (!r.ok) throw r.e;
  return r.v;
}

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await call(p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to be refused");
}

async function show(node: ReactNode) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ToastProvider>{node}</ToastProvider>));
  await wait();
}

const page = (p: StoriesPage) => ({ ws: "stories", page: p });
const text = () => document.body.textContent ?? "";

function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a, label"));
  const words = (el: HTMLElement) => [el.textContent?.trim() ?? "", el.getAttribute("aria-label") ?? ""];
  const hit = all.find((el) => words(el).some((w) => (typeof name === "string" ? w === name : name.test(w))));
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}
const has = (name: string | RegExp, within: ParentNode = document) => {
  try {
    control(name, within);
    return true;
  } catch {
    return false;
  }
};

async function click(el: HTMLElement, ms = 50) {
  await act(async () => el.click());
  await wait(ms);
}

function type(el: Element | null | undefined, value: string) {
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
  await click(opt.querySelector("input") as HTMLElement);
}

const scenes = (within: ParentNode = document) => Array.from(within.querySelectorAll<HTMLElement>(".st-sc-scene"));
const what = (i: number, within: ParentNode = document) => scenes(within)[i]!.querySelector("textarea")!;
const caption = (i: number, within: ParentNode = document) => scenes(within)[i]!.querySelector<HTMLInputElement>("input.st-s-input")!;
const pinned = () => document.querySelector(".st-s-actionbar--pin .st-s-notice")?.textContent ?? "";
const dialog = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((d) => d.querySelector(".st-s-sheet__title")?.textContent === title) ?? null;
const captionsSwitch = () => Array.from(document.querySelectorAll<HTMLElement>('[role="switch"]')).find((s) => document.getElementById(s.getAttribute("aria-labelledby") ?? "")?.textContent === "Captions")!;

/** Production › New with Write it myself picked. */
async function writeItMyself(p: Partial<Extract<StoriesPage, { name: "production_new" }>> = {}) {
  await show(<ProductionScreen {...page({ name: "production_new", ideaId: null, ...p })} />);
  await pick("Where the idea comes from", "Write it myself");
}

/** An owner's script made through the mock, its job walked to the end. */
async function made(body: Partial<StoryInput> & { ownScript: OwnScript }): Promise<{ story: Story; job: ProductionJob | null }> {
  const { story } = await call(api.createStory("stories", { characterIds: [C.dash], durationSec: 30, captionsOn: true, brief: { title: "Dash learns to juggle", category: "comedy" }, ...body }));
  await vi.advanceTimersByTimeAsync(14_000);
  const r = await call(api.getStory("stories", story.storyId));
  return { story: r.story, job: r.job };
}

const JUGGLE: OwnScript = {
  scenes: [
    { what: "Dash wakes up late in the kitchen.", caption: "Oh no!!" },
    { what: "Dash drops every ball in the park.", who: [C.dash], place: "park" },
    { what: "Dash juggles three balls at last.", caption: "We did it! 🎉" },
  ],
};

const FOG: OwnScript = {
  scenes: [
    { what: "Nana Rose drives into thick fog.", caption: "So foggy!" },
    { what: "Nana Rose puts on full beam in the fog.", caption: "Full beam on!" },
  ],
};

// ---------- The pure helpers ----------

describe("Paste a script: splitScript", () => {
  it("splits at Scene headings, with a Caption: line and a quoted line as the caption", () => {
    expect(splitScript("Scene 1: Dash wakes up late.\nCaption: Oh no!\nSCENE 2 - He runs\nto the bus.\n“Wait for me!”\nShot 3. The bus leaves.")).toEqual([
      { what: "Dash wakes up late.", caption: "Oh no!" },
      { what: "He runs to the bus.", caption: "Wait for me!" },
      { what: "The bus leaves.", caption: null },
    ]);
  });

  it("splits at blank lines, else one scene a line (a caption line belongs to the scene before it)", () => {
    expect(splitScript("Dash wakes up.\nWords: Morning!\n\nDash eats toast.")).toEqual([
      { what: "Dash wakes up.", caption: "Morning!" },
      { what: "Dash eats toast.", caption: null },
    ]);
    expect(splitScript("Dash wakes up.\nOn screen: Hi\nDash eats toast.\n'Yum'")).toEqual([
      { what: "Dash wakes up.", caption: "Hi" },
      { what: "Dash eats toast.", caption: "Yum" },
    ]);
  });

  it("keeps every word: nothing is cut, and a 13th scene is kept", () => {
    const long = "word ".repeat(50).trim();
    const lines = Array.from({ length: 13 }, (_, i) => `Scene ${i + 1}: ${i === 0 ? long : `Step ${i + 1}`}`).join("\n");
    const out = splitScript(lines);
    expect(out).toHaveLength(13);
    expect(out[0]!.what).toBe(long);
    expect(out[12]!.what).toBe("Step 13");
  });
});

describe("who and where from the words, and reading time", () => {
  const cast = [
    { characterId: C.dash, name: "Dash" },
    { characterId: C.nana, name: "Nana Rose" },
    { characterId: ROSSO, name: "Rosso" },
  ];

  it("names the cast as whole words, ignoring case, people and cars, in text order", () => {
    expect(namesIn("rosso honks at DASH, then Nana waves.", cast).map((c) => c.name)).toEqual(["Rosso", "Dash", "Nana Rose"]);
    expect(namesIn("Dashboard lights blink.", cast)).toEqual([]);
  });

  it("asks about a capital word that is no common word, place or name, once, and never again once answered", () => {
    expect(unknownNames("Then Max and Dash go to the Kitchen. Suddenly Max trips. Oh no!", cast)).toEqual(["Max"]);
    expect(unknownNames("The car stops. Max's hat flies.", cast, ["max"])).toEqual([]);
    expect(unknownNames("Dash's toast burns.", cast)).toEqual([]);
  });

  it("reads the place from the words", () => {
    expect(placeIn("Dash cooks in the kitchen")).toBe("kitchen");
    expect(placeIn("They drive on the motorway at night")).toBe("highway_night");
    expect(placeIn("A night on the road")).toBe("road_night");
    expect(placeIn("Rosso waits in the car park")).toBe("parking_lot");
    expect(placeIn("Icy morning")).toBe("icy_road");
    expect(placeIn("Nap on the sofa")).toBe("living_room");
    expect(placeIn("Dash walks into town")).toBe("city_street");
    expect(placeIn("A day at the beach")).toBeNull();
  });

  it("needs and lengths are the API's and the agent's sums", () => {
    expect(need({ caption: null })).toBe(3);
    expect(need({ caption: "Oh no!" })).toBe(3);
    expect(need({ caption: "x".repeat(60) })).toBe(6);
    expect(defaultLength([{}, {}])).toBe(15);
    expect(defaultLength(Array.from({ length: 4 }, () => ({ caption: "x".repeat(60) })))).toBe(25);
    expect(defaultLength(Array.from({ length: 12 }, () => ({ caption: "x".repeat(60) })))).toBe(75);
    expect(fitTarget(90, [{}, {}])).toBe(30);
    expect(fitTarget(15, Array.from({ length: 12 }, () => ({ caption: "x".repeat(60) })))).toBe(72);
  });

  it("the code check compares the owner's words exactly: case, punctuation and emoji count", () => {
    expect(sameWords("Ta-da! 🎉", "  Ta-da!   🎉 ")).toBe(true);
    expect(sameWords("Cafe\u0301", "Café")).toBe(true);
    expect(sameWords("Ta-da! 🎉", "Ta-da! ")).toBe(false);
    expect(sameWords("Ta-da! 🎉", "ta-da! 🎉")).toBe(false);
    expect(sameWords("Ta-da! 🎉", "Ta-da 🎉")).toBe(false);
  });

  it("the script sent keeps the words exactly as typed (only the ends trimmed) and reads who, where and who was left out", () => {
    const d = emptyDraft();
    d.scenes[0] = { ...d.scenes[0]!, what: "  Dash wakes up in the kitchen. ", caption: "Oh no!!  " };
    d.scenes[1] = { ...d.scenes[1]!, what: "Max and Rosso race.", caption: "  ¡Vamos, Max! 🚗💨" };
    d.answers = { max: "out" };
    expect(openAsks(d, [C.dash, ROSSO], cast)).toEqual([]);
    expect(toOwnScript(d, [C.dash, ROSSO], cast)).toEqual({
      scenes: [
        { what: "Dash wakes up in the kitchen.", caption: "Oh no!!", who: [C.dash], place: "kitchen" },
        { what: "Max and Rosso race.", caption: "¡Vamos, Max! 🚗💨", who: [ROSSO], leaveOut: ["Max"] },
      ],
    });
    expect(sceneOfProblem("Your scene 2 (“Full beam”): use dipped lights.")).toBe(2);
    expect(sceneOfProblem("“Full beam” does not match.")).toBeNull();
  });

  it("checks in §45.46.3's order", () => {
    const d = emptyDraft();
    expect(scriptProblem(d, [], cast)?.text).toBe("Write at least 2 scenes.");
    d.scenes = [{ ...d.scenes[0]!, what: "Dash naps." }, { ...d.scenes[1]!, what: "" }, { ...d.scenes[0]!, key: "x3", what: "Dash wakes." }];
    expect(scriptProblem(d, [C.dash], cast)).toEqual({ text: "Scene 2 is empty. Write what happens, or take it out.", fix: { scene: 1, field: "what" } });
    d.scenes[1] = { ...d.scenes[1]!, what: "y".repeat(161) };
    expect(scriptProblem(d, [C.dash], cast)?.text).toBe("Scene 2 is too long. Use 160 letters or fewer.");
    d.scenes[1] = { ...d.scenes[1]!, what: "Max sneezes.", caption: "z".repeat(61) };
    expect(scriptProblem(d, [C.dash], cast)?.text).toBe("Scene 2's caption is too long. Use 60 letters or fewer.");
    d.scenes[1] = { ...d.scenes[1]!, caption: "" };
    expect(scriptProblem(d, [C.dash], cast)).toEqual({ text: "Tell us who Max is, in scene 2.", fix: { scene: 1, field: "ask" } });
    d.answers = { max: C.dash };
    expect(scriptProblem(d, [C.dash], cast)).toBeNull();
  });
});

// ---------- Production › New ----------

describe("Production › New: Write it myself", () => {
  it("is the third choice; Use an idea stays the default and Type an idea keeps its words", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    const opts = Array.from(document.querySelectorAll(".st-s-pick__opt .st-s-pick__label")).slice(0, 3).map((e) => e.textContent);
    expect(opts).toEqual(["Use an idea", "Type an idea", "Write it myself"]);
    expect(document.querySelector<HTMLInputElement>(".st-s-pick__opt.is-on input")?.value).toBe("idea");
    expect(text()).not.toContain("You write what happens.");
    await click(control("Make the video"));
    expect(pinned()).toContain("Pick an idea, or tap Type an idea.");
    await pick("Where the idea comes from", "Write it myself");
    expect(text()).toContain("You write what happens. Clips Funded draws it.");
    expect(scenes()).toHaveLength(2);
    expect(text()).toContain("2 to 12 scenes.");
    expect(caption(0).placeholder).toBe("Words on screen, or skip"); // fits a phone's field, never cut
    expect(document.querySelector(".st-s-aiwho")?.previousElementSibling?.textContent).toBe("The AI that sets up your scenes and checks them.");
  });

  it("Make the video sends the owner's scenes in order, the words exactly as typed, who from the names and the place", async () => {
    const create = vi.spyOn(api, "createStory");
    await writeItMyself();
    type(field("Title"), "Dash learns to juggle");
    await pick("What kind of video?", "Funny");
    expect(captionsSwitch().getAttribute("aria-checked")).toBe("false");
    type(what(0), "Dash wakes up late in the kitchen.");
    type(caption(0), "Oh no!!  ");
    await wait(50);
    // The first caption turns the captions on by itself (the workspace has them off).
    expect(captionsSwitch().getAttribute("aria-checked")).toBe("true");
    type(what(1), "Max drops the balls.");
    await click(control("+ Add a scene"));
    expect(document.activeElement).toBe(what(2));
    type(what(2), "Dash and Bolt juggle in the park.");
    type(caption(2), "We did it! 🎉");
    await wait(50);
    // Dash and Bolt came into the cast from the words; Max is asked about, once.
    expect(Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", "")).sort()).toEqual(["Bolt", "Dash"]);
    const ask = document.querySelector<HTMLElement>(".st-sc-ask")!;
    expect(ask.textContent).toContain("Who is Max?");
    expect(text()).not.toContain("Some emoji may not show."); // the video's image ships an emoji font
    await click(control("Make the video"));
    expect(create).not.toHaveBeenCalled();
    expect(pinned()).toContain("Tell us who Max is, in scene 2.");
    expect(ask.contains(document.activeElement)).toBe(true);
    await click(control("It's Dash", ask)); // "Max is Dash", never "Max is with Dash"
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    // The preview: one tile a scene and the total.
    const tiles = Array.from(document.querySelectorAll(".st-sc-tile"));
    expect(tiles).toHaveLength(3);
    expect(tiles[0]!.textContent).toBe("1KitchenDash“Oh no!!”about 5 s");
    // Max is Dash: the same people as scene 1, so it goes on in the kitchen (round 1: was "AI picks")
    expect(tiles[1]!.textContent).toBe("2KitchenDashabout 5 s");
    expect(tiles[2]!.textContent).toBe("3ParkDash, Bolt“We did it! 🎉”about 5 s");
    expect(document.querySelector(".st-sc-total")?.textContent).toBe("3 scenes · about 15 seconds · 2 captions");
    // the length part reads one number: the length its scenes need, picked by itself (no range, no "works best")
    expect(text()).not.toContain("Your 3 scenes");
    expect(text()).not.toContain("30 to 60 seconds works best.");
    await click(control("Make the video"), 1500);
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![1];
    expect(body).toMatchObject({
      characterIds: [C.dash, C.bolt],
      durationSec: 15,
      captionsOn: true,
      brief: { title: "Dash learns to juggle", logline: "Dash wakes up late in the kitchen.", category: "comedy" },
    });
    expect(body.ideaId).toBeUndefined();
    expect(body.ownScript).toEqual({
      scenes: [
        { what: "Dash wakes up late in the kitchen.", caption: "Oh no!!", who: [C.dash], place: "kitchen" },
        { what: "Max drops the balls.", who: [C.dash], place: "kitchen", known: ["Max"] }, // answered: never asked about again; the kitchen goes on
        { what: "Dash and Bolt juggle in the park.", caption: "We did it! 🎉", who: [C.dash, C.bolt], place: "park" },
      ],
    });
  });

  it("each problem says its sentence by the pinned button and focuses its field", async () => {
    await writeItMyself();
    const make = () => click(control("Make the video"));
    await make();
    expect(pinned()).toBe("Give the video a title.");
    expect(document.activeElement).toBe(field("Title"));
    type(field("Title"), "Dash's day");
    await make();
    expect(pinned()).toBe("Pick what kind of video it is.");
    expect(document.activeElement).toBe(document.querySelector("#st-sc-kind input[type=radio]"));
    await pick("What kind of video?", "Everyday skills");
    type(what(0), "Dash brushes his teeth.");
    await make();
    expect(pinned()).toBe("Write at least 2 scenes.");
    expect(document.activeElement).toBe(what(1));
    await click(control("+ Add a scene"));
    type(what(2), "Dash smiles at the mirror.");
    await make();
    expect(pinned()).toBe("Scene 2 is empty. Write what happens, or take it out.");
    expect(document.activeElement).toBe(what(1));
    type(what(1), "Dash ".repeat(33));
    await wait(50);
    expect(scenes()[1]!.textContent).toContain("Too long: 164 of 160 letters.");
    await make();
    expect(pinned()).toBe("Scene 2 is too long. Use 160 letters or fewer.");
    type(what(1), "Dash rinses.");
    type(caption(0), "c".repeat(61));
    await make();
    expect(pinned()).toBe("Scene 1's caption is too long. Use 60 letters or fewer.");
    expect(document.activeElement).toBe(caption(0));
    // Nothing is ever cut by itself.
    expect(caption(0).value).toBe("c".repeat(61));
    type(caption(0), "Sparkle!");
    await make();
    // Then as today: the cast (Dash came in from the words).
    expect(pinned()).toBe("");
  });

  it("scenes move with ↑ and ↓, an empty one goes at once, one with words comes back with Undo", async () => {
    await writeItMyself();
    type(what(0), "Dash sits down.");
    type(what(1), "Dash runs off.");
    await click(control("+ Add a scene"));
    type(what(2), "Dash naps.");
    await click(control("Move scene 3 up"));
    expect(scenes().map((s) => s.querySelector("textarea")!.value)).toEqual(["Dash sits down.", "Dash naps.", "Dash runs off."]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move scene 2 up");
    expect(control("Move scene 1 up").getAttribute("aria-disabled")).toBe("true");
    await click(control("Take out scene 1"));
    expect(scenes()).toHaveLength(2);
    expect(document.querySelector(".toast__text")?.textContent).toBe("Scene 1 taken out.");
    await click(control("Undo"));
    expect(scenes().map((s) => s.querySelector("textarea")!.value)).toEqual(["Dash sits down.", "Dash naps.", "Dash runs off."]);
    // An empty scene goes at once, with no Undo.
    await click(control("+ Add a scene"));
    await click(control("Take out scene 4"));
    expect(scenes()).toHaveLength(3);
    expect(document.querySelectorAll(".toast__text")).toHaveLength(0);
  });

  it("Paste a script fills the list (asking first over written scenes) and keeps a 13th scene with its limit", async () => {
    await writeItMyself();
    await click(control("Paste a script"));
    type(field("Your script"), "Scene 1: Dash wakes up.\nCaption: Morning!\nScene 2: Dash eats toast.");
    await click(control("Make scenes"));
    expect(scenes().map((s) => [s.querySelector("textarea")!.value, s.querySelector<HTMLInputElement>("input.st-s-input")!.value])).toEqual([
      ["Dash wakes up.", "Morning!"],
      ["Dash eats toast.", ""],
    ]);
    await click(control("Paste a script"));
    type(field("Your script"), Array.from({ length: 13 }, (_, i) => `Dash step ${i + 1}.`).join("\n"));
    await click(control("Make scenes"));
    const sheet = dialog("Replace your scenes?")!;
    expect(sheet).not.toBeNull();
    await click(control("Keep mine", sheet));
    expect(scenes()).toHaveLength(2);
    await click(control("Make scenes"));
    await click(control("Replace", dialog("Replace your scenes?")!));
    expect(scenes()).toHaveLength(13);
    expect(text()).toContain("Up to 12 scenes. Join some, or take some out.");
    expect(has("+ Add a scene")).toBe(false);
  });

  it("starts from the idea's steps: its beats and words, its title and kind; Make the video sends the idea", async () => {
    const idea = store.ideas.find((i) => i.ideaId === I.sandwich)!;
    idea.concept = { premise: "A tall sandwich.", beats: ["Pip stacks the bread.", "Dash sneaks a bite.", "The tower falls."], lesson: null, ending: "They share.", tone: "funny", durationSec: 30, onScreenText: ["So tall!", "", "Oops!"] };
    const create = vi.spyOn(api, "createStory");
    await writeItMyself({ ideaId: I.sandwich });
    expect(text()).toContain("Started from your idea. Change anything.");
    expect(field("Title").value).toBe("The sandwich tower");
    expect(scenes().map((s) => [s.querySelector("textarea")!.value, s.querySelector<HTMLInputElement>("input.st-s-input")!.value])).toEqual([
      ["Pip stacks the bread.", "So tall!"],
      ["Dash sneaks a bite.", ""],
      ["The tower falls.", "Oops!"],
    ]);
    await click(control("Make the video"), 1500);
    const body = create.mock.calls[0]![1];
    expect(body.ideaId).toBe(I.sandwich);
    expect(body.brief).toBeUndefined();
    expect(body.title).toBeUndefined();
    expect(body.ownScript?.scenes.map((s) => s.what)).toEqual(["Pip stacks the bread.", "Dash sneaks a bite.", "The tower falls."]);
  });

  it("a written scene asks before the page changes", async () => {
    await writeItMyself();
    expect(leaveHolders()).toBe(0);
    type(what(0), "Dash wakes up.");
    await wait(50);
    expect(leaveHolders()).toBe(1);
    act(() => navigate("/stories/references"));
    await wait(50);
    expect(location.pathname).toBe("/stories");
    expect(dialog(LEAVE_TITLE)).not.toBeNull();
  });
});

// ---------- The step track and the video's page ----------

describe("the step track on an owner's script", () => {
  it("says Your script and Setting up your scenes…; an old job keeps its words", async () => {
    const { story } = await call(api.createStory("stories", { characterIds: [C.dash], durationSec: 30, brief: { title: "Dash learns to juggle", category: "comedy" }, ownScript: JUGGLE }));
    // the job as it is now, read straight from the store (a call's own latency would walk it on)
    const r = { story: store.stories.find((s) => s.storyId === story.storyId)!, job: store.jobs.find((j) => j.contentId === story.storyId)! };
    expect(r.job.steps[0]!.status).toBe("running");
    const steps = stepsOf(r.job, r.story);
    expect(steps.map((s) => s.label)).toEqual(["Your script", "Check the facts", "Draw the scenes", "Animate", "Add sounds and music", "Add your words", "Put it together", "Ready to watch"]);
    expect(nowLine(r.job, steps, r.story.status, true)).toBe("Setting up your scenes…");
    // An old video's job reads word for word as before.
    const old = await call(api.getStory("stories", S.producing));
    const oldSteps = stepsOf(old.job, old.story);
    expect(oldSteps[0]!.label).toBe("Write the story");
    expect(nowLine({ ...old.job!, status: "running", steps: oldSteps.map((s, i) => ({ ...s, status: i === 0 ? "running" : "pending" })) }, oldSteps.map((s, i) => ({ ...s, status: i === 0 ? "running" : "pending" })), "producing")).toBe("Writing the story…");
    await show(<StepTrack job={r.job} story={r.story} />);
    expect(document.querySelector(".st-s-track__step")?.textContent).toContain("Your script");
  });

  it("the video's page says Your script once (the first step, no chip over it), Story: By you, and the scenes' own wait line", async () => {
    const { story } = await call(api.createStory("stories", { characterIds: [C.dash], durationSec: 30, brief: { title: "Dash learns to juggle", category: "comedy" }, ownScript: JUGGLE }));
    await show(<ProductionScreen {...page({ name: "production_story", storyId: story.storyId })} />);
    expect(document.querySelector('[aria-label="The steps"] .st-sc-chip')).toBeNull();
    expect(document.querySelector('[aria-label="The steps"] .st-s-track__step')?.textContent).toContain("Your script");
    expect(text()).toContain("Setting up your scenes… they show up here soon.");
    await wait(14_000);
    document.querySelector<HTMLDetailsElement>(".st-s-details")!.open = true;
    const facts = Array.from(document.querySelectorAll(".st-s-facts dt")).map((d) => d.textContent);
    expect(facts).toContain("Story");
    expect(facts).toContain("Scenes set up by");
    expect(facts).not.toContain("Writer");
    expect(text()).toContain("By you");
  });
});

// ---------- Review ----------

describe("Review on an owner's script", () => {
  it("Change my script replaces Ask for changes (no note box), the scenes show as written, Remake this scene stays", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    expect(story.status).toBe("review");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: story.storyId })} />);
    expect(has("Ask for changes")).toBe(false);
    expect(has("Change my script")).toBe(true);
    expect(has("Remake this scene")).toBe(true);
    expect(document.querySelector(".st-s-head .st-sc-chip")?.textContent).toBe("Your script");
    const panel = document.querySelector(".st-sc-panel")!;
    expect(Array.from(panel.querySelectorAll(".st-sc-written__words")).map((e) => e.textContent)).toEqual(["“Oh no!!”", "“We did it! 🎉”"]);
    await click(control("Remake the whole video"));
    expect(dialog("Remake the whole video?")?.textContent).toContain("Clips Funded sets up your scenes again. Your words stay.");
    await click(control("Keep this one", dialog("Remake the whole video?")!));
    await click(control("Change my script"), 1500);
    const sheet = dialog("Change my script")!;
    expect(sheet.querySelector("textarea[id*='note']")).toBeNull();
    expect(scenes(sheet).map((s) => s.querySelector("textarea")!.value)).toEqual(JUGGLE.scenes.map((s) => s.what));
    // Only the words change: Make it again saves them and runs the caption steps.
    const patch = vi.spyOn(api, "patchStory");
    const produce = vi.spyOn(api, "produce");
    type(caption(1, sheet), "Butterfingers!");
    await click(control("Make it again", sheet), 1500);
    expect(patch.mock.calls[0]![2].ownScript?.scenes[1]).toEqual({ what: "Dash drops every ball in the park.", caption: "Butterfingers!", who: [C.dash], place: "park" });
    expect(produce).toHaveBeenCalledWith("stories", story.storyId, {});
    expect(text()).toContain("Making it again!");
    const job = store.jobs.find((j) => j.jobId === store.stories.find((s) => s.storyId === story.storyId)!.currentJobId)!;
    expect(job.configuration.run).toEqual(["safety", "captions", "assemble", "preview"]);
  });

  it("a fact about the owner's words is reported as written; Fix the words opens Change my script at that scene", async () => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    const { story } = await made({ characterIds: [C.nana], brief: { title: "Foggy drive", category: "driving_safety" }, ownScript: FOG });
    expect(story.status).toBe("needs_check");
    await show(<ReviewScreen {...page({ name: "review_story", storyId: story.storyId })} />);
    expect(text()).toContain("Fix the facts first.");
    expect(text()).toContain("Your scene 2 (“Nana Rose puts on full beam in the fog.”)");
    expect(control("Approve").getAttribute("aria-disabled")).toBe("true");
    await click(control("Fix the words"), 1500);
    // the scene's words get the focus on the frame after the list is drawn
    await wait(50);
    const sheet = dialog("Change my script")!;
    expect(sheet).not.toBeNull();
    expect(document.activeElement).toBe(what(1, sheet));
    expect(what(1, sheet).value).toBe("Nana Rose puts on full beam in the fog.");
    vi.unstubAllGlobals();
  });
});

// ---------- The mock ----------

describe("the mock: an owner's script", () => {
  it("is stored with its ids, staged one scene for each in order, its words on screen exactly as written", async () => {
    const { story, job } = await made({ ownScript: JUGGLE });
    expect(story.ownScript?.scenes.map((s) => s.sceneId)).toEqual(["s1", "s2", "s3"]);
    expect(story.ownScript?.scenes[0]).toEqual({ sceneId: "s1", what: "Dash wakes up late in the kitchen.", caption: "Oh no!!", who: [], place: null, leaveOut: [] });
    expect(job?.steps.map((s) => s.label)).toEqual(["Your script", "Check the facts", "Draw the scenes", "Animate", "Add sounds and music", "Add your words", "Put it together", "Ready to watch"]);
    expect(job?.meta.models.find((m) => m.step === "storyboard")?.task).toBe("animation_plan");
    const script = store.scripts[story.storyId]!;
    expect(validateScript(script).ok).toBe(true);
    expect(script.scenes.map((s) => s.sceneId)).toEqual(["s1", "s2", "s3"]);
    expect(script.scenes.map((s) => s.set)).toEqual(["kitchen", "park", "park"]);
    expect(script.scenes.every((s) => s.caption === null)).toBe(true);
    expect(script.captions.map((c) => [c.id, c.text])).toEqual([
      ["w_s1", "Oh no!!"],
      ["w_s3", "We did it! 🎉"],
    ]);
    let start = 0;
    for (const sc of script.scenes) {
      const cue = script.captions.find((c) => c.id === `w_${sc.sceneId}`);
      if (cue) {
        expect(cue.at).toBeGreaterThanOrEqual(start);
        expect(cue.at + cue.dur).toBeLessThanOrEqual(start + sc.durationSec + 0.05);
      }
      start += sc.durationSec;
    }
    expect(script.scenes[1]!.actors.map((a) => a.castId)).toEqual(["c1"]);
    // An old video has no ownScript.
    expect((await call(api.getStory("stories", S.review))).story.ownScript).toBeUndefined();
  });

  it("defaults the captions on and the length from the scenes, and keeps a car in Who", async () => {
    const { story } = await call(
      api.createStory("stories", {
        characterIds: [C.pip, ROSSO],
        brief: { title: "Rosso's first drive", category: "comedy" },
        ownScript: { scenes: [{ what: "Pip gets into Rosso.", who: [C.pip, ROSSO], place: "road_day" }, { what: "Rosso honks.", caption: "Beep beep!", who: [C.pip, ROSSO], place: "road_day" }] },
      }),
    );
    expect(story.captionsOn).toBe(true);
    expect(story.durationSec).toBe(15);
    await vi.advanceTimersByTimeAsync(14_000);
    const script = store.scripts[story.storyId]!;
    expect(script.scenes[0]!.props.find((p) => p.kind === "car")?.castId).toBe("c2");
    expect(script.scenes[0]!.actors[0]).toMatchObject({ castId: "c1", inCar: "car1" });
  });

  it("refuses a bad script with its kid sentence, never cutting a word", async () => {
    const base = { characterIds: [C.dash], brief: { title: "Dash", category: "comedy" as const } };
    const bad = async (ownScript: unknown) => (await refused(api.createStory("stories", { ...base, ownScript: ownScript as OwnScript }))).message;
    expect(await bad({ scenes: [{ what: "One." }] })).toBe("Write at least 2 scenes.");
    expect(await bad({ scenes: Array.from({ length: 13 }, () => ({ what: "Dash." })) })).toBe("Up to 12 scenes.");
    expect(await bad({ scenes: [{ what: "Dash." }, { what: "  " }] })).toBe("Scene 2 is empty. Write what happens.");
    expect(await bad({ scenes: [{ what: "a".repeat(161) }, { what: "Dash." }] })).toBe("Scene 1 is too long. Use 160 letters or fewer.");
    expect(await bad({ scenes: [{ what: "Dash.", caption: "b".repeat(61) }, { what: "Dash." }] })).toBe("Scene 1's caption is too long. Use 60 letters or fewer.");
    expect(await bad({ scenes: [{ what: "Dash.", who: [C.bolt] }, { what: "Dash." }] })).toBe("Scene 1 has someone who isn't in the cast.");
    expect(await bad({ scenes: [{ what: "Dash.", place: "beach" }, { what: "Dash." }] })).toBe("Scene 1's place isn't one we can draw. Pick one from the list.");
    expect(await bad({ scenes: [{ what: "Dash.\u0007" }, { what: "Dash." }] })).toBe("Use plain letters in scene 1.");
    const sixty = `${"é".repeat(57)} 🎉!`;
    const { story } = await call(api.createStory("stories", { ...base, ownScript: { scenes: [{ what: "Dash\nwaves.", caption: sixty }, { what: "Dash." }] } }));
    expect(story.ownScript?.scenes[0]).toMatchObject({ what: "Dash\nwaves.", caption: sixty });
  });

  it("a 60-letter caption with emoji is made: the engine counts letters as the API does (an emoji is one)", async () => {
    const sixty = `${"a".repeat(56)} 🎉🚗!`;
    expect([...sixty].length).toBe(60);
    expect(sixty.length).toBeGreaterThan(60);
    const label = `${"Dash 🎉 ".repeat(5)}waves.`;
    const { story, job } = await made({ ownScript: { scenes: [{ what: label, caption: sixty }, { what: "Dash juggles.", caption: "🎉".repeat(60) }] } });
    expect(job?.status).not.toBe("failed");
    const script = store.scripts[story.storyId]!;
    expect(validateScript(script).ok).toBe(true);
    expect(script.captions.map((c) => c.text)).toEqual([sixty, "🎉".repeat(60)]);
    // 61 letters is still too long for the engine, however they are counted.
    expect(validateScript({ ...script, captions: [{ ...script.captions[0]!, text: `${sixty}a` }] }).ok).toBe(false);
  });

  it("Change my script: only the words mark only the caption steps; anything else stages it all again", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    const words = { scenes: JUGGLE.scenes.map((s, i) => (i === 0 ? { ...s, caption: "Oh dear!" } : i === 1 ? { ...s, caption: "Oops" } : s)) };
    const r = await call(api.patchStory("stories", story.storyId, { version: story.version, ownScript: words }));
    expect(r.story.stale).toEqual(["safety", "captions", "assemble", "preview"]);
    expect(r.script?.captions.map((c) => [c.id, c.text])).toEqual([
      ["w_s1", "Oh dear!"],
      ["w_s2", "Oops"],
      ["w_s3", "We did it! 🎉"],
    ]);
    expect(r.story.scriptVersion).toBe(story.scriptVersion + 1);
    const moved = { scenes: [JUGGLE.scenes[1]!, JUGGLE.scenes[0]!, JUGGLE.scenes[2]!] };
    const r2 = await call(api.patchStory("stories", story.storyId, { version: r.story.version, ownScript: moved }));
    expect(r2.story.stale).toEqual([...STEP_ORDER]);
    expect(r2.story.ownScript?.scenes.map((s) => s.what)).toEqual([JUGGLE.scenes[1]!.what, JUGGLE.scenes[0]!.what, JUGGLE.scenes[2]!.what]);
    // An old video has no script of the owner's.
    const old = (await call(api.getStory("stories", S.review))).story;
    expect((await refused(api.patchStory("stories", S.review, { version: old.version, ownScript: JUGGLE }))).message).toBe("This video has no script of yours.");
  });

  it("a caption edit in the captions editor is mirrored into the owner's script", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    const script = store.scripts[story.storyId]!;
    const cues = script.captions.filter((c) => c.id !== "w_s3").map((c) => (c.id === "w_s1" ? { ...c, text: "Oh no no no!" } : c));
    const r = await call(api.patchStory("stories", story.storyId, { version: story.version, captions: cues }));
    expect(r.story.ownScript?.scenes.map((s) => s.caption)).toEqual(["Oh no no no!", null, null]);
  });

  it("a note is refused (the owner changes their own script); Remake this scene works", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    expect((await refused(api.requestChanges("stories", story.storyId, { note: "Make it funnier" }))).message).toBe("This video follows your script. Tap Change my script.");
    const r = await call(api.requestChanges("stories", story.storyId, { sceneIds: ["s2"] }));
    expect(r.job.jobType).toBe("changes");
    await vi.advanceTimersByTimeAsync(14_000);
    const script = store.scripts[story.storyId]!;
    expect(script.captions.map((c) => [c.id, c.text])).toEqual([
      ["w_s1", "Oh no!!"],
      ["w_s3", "We did it! 🎉"],
    ]);
  });

  it("a driving-safety script with full beam in fog is reported, never rewritten, and can't be approved", async () => {
    const { story } = await made({ characterIds: [C.nana], brief: { title: "Foggy drive", category: "driving_safety" }, ownScript: FOG });
    expect(story.status).toBe("needs_check");
    expect(story.safetyTopicId).toBe("fog-driving");
    expect(story.safety?.problems).toEqual([
      "Your scene 2 (“Nana Rose puts on full beam in the fog.”): the checked advice says to use dipped headlights in fog. (The Highway Code)",
      "Your scene 2's caption (“Full beam on!”): the checked advice says to use dipped headlights in fog. (The Highway Code)",
    ]);
    expect(story.ownScript?.scenes.map((s) => [s.what, s.caption])).toEqual(FOG.scenes.map((s) => [s.what, s.caption]));
    expect(store.scripts[story.storyId]!.captions.find((c) => c.id === "w_s2")?.text).toBe("Full beam on!");
    expect((await refused(api.approve("stories", story.storyId, story.version))).message).toMatch(/^Fix the facts first: Your scene 2/);
    // A driving-safety script no checked advice covers is refused, with the list.
    expect((await refused(api.createStory("stories", { characterIds: [C.nana], brief: { title: "Parking", category: "driving_safety" }, ownScript: { scenes: [{ what: "Nana Rose parks." }, { what: "Nana Rose waves." }] } }))).message).toContain("checked advice");
  });
});

// ---------- The reviewers' fixes (24 Nov) ----------

describe("the reviewers' fixes", () => {
  const cast = [
    { characterId: C.dash, name: "Dash" },
    { characterId: ROSSO, name: "Rosso" },
  ];

  it("everyday words with a capital are never asked about; a name at a sentence start still is", () => {
    expect(unknownNames("Dash wakes up. Breakfast is ready. Outside, Dash plays on Saturday in May.", cast)).toEqual([]);
    expect(unknownNames("Max drops every ball.", cast)).toEqual(["Max"]);
    expect(unknownNames("Mum makes pancakes.", cast)).toEqual(["Mum"]); // a person: the cast may have no Mum to draw
  });

  it("Not a name answers the question without leaving anything out, and is sent as known", async () => {
    await writeItMyself();
    type(field("Title"), "Dash's breakfast");
    await pick("What kind of video?", "Funny");
    type(what(0), "Dash eats Cornflakes in the kitchen.");
    type(what(1), "Dash runs to the park.");
    await wait(50);
    const ask = document.querySelector<HTMLElement>(".st-sc-ask")!;
    expect(ask.textContent).toContain("Who is Cornflakes?");
    expect(Array.from(ask.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["It's Dash", "Make Cornflakes", "Not a name", "Leave Cornflakes out"]);
    await click(control("Not a name", ask));
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    const create = vi.spyOn(api, "createStory");
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1].ownScript?.scenes[0]).toEqual({ what: "Dash eats Cornflakes in the kitchen.", who: [C.dash], place: "kitchen", known: ["Cornflakes"] });
    // the answer is never a character: the cast stays Dash, the call is made and the page goes to the new video
    expect(create.mock.calls[0]![1].characterIds).toEqual([C.dash]);
    await expect(create.mock.results[0]!.value).resolves.toMatchObject({ story: { characterIds: [C.dash] } });
    await wait(3000);
    expect(location.pathname).toMatch(/^\/stories\/production\/[^/]+$/);
    expect(location.pathname).not.toBe("/stories/production/new");
  });

  it("Type an idea says the AI writes the story; only Write it myself says you write it", async () => {
    await show(<ProductionScreen {...page({ name: "production_new", ideaId: null })} />);
    await pick("Where the idea comes from", "Type an idea");
    expect(text()).toContain("You type the idea. Clips Funded writes the story.");
    expect(text()).not.toContain("You write what happens.");
  });

  it("a caption mark the video would change is refused with its sentence, by the web and the mock", async () => {
    const d = emptyDraft();
    d.scenes = [
      { ...d.scenes[0]!, what: "Dash naps.", caption: "Zzz {snore}" },
      { ...d.scenes[1]!, what: "Dash wakes." },
    ];
    expect(scriptProblem(d, [C.dash], cast)).toEqual({ text: "Scene 1's caption can't use { } or \\. Take them out.", fix: { scene: 0, field: "caption" } });
    const base = { characterIds: [C.dash], brief: { title: "Dash", category: "comedy" as const } };
    const refusedWith = await refused(api.createStory("stories", { ...base, ownScript: { scenes: [{ what: "Dash.", caption: "a\\b" }, { what: "Dash." }] } }));
    expect(refusedWith.message).toBe("Scene 1's caption can't use { } or \\. Take them out.");
  });

  it("Review on an owner's script shows its words once: no Words on each scene under the captions", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: story.storyId })} />);
    const editor = document.querySelector('[aria-labelledby="st-captions-title"]')!;
    expect(editor.textContent).toContain("Show captions");
    expect(Array.from(editor.querySelectorAll(".st-s-cue__head strong")).map((e) => e.textContent)).toEqual(["Caption 1", "Caption 2"]);
    expect(text()).not.toContain("Words on each scene");
    expect(text()).not.toContain("No words on this scene");
  });

  it("Change my script: a start that fails after the save is retried with the saved version, never a 409", async () => {
    const { story } = await made({ ownScript: JUGGLE });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: story.storyId })} />);
    await click(control("Change my script"), 1500);
    const sheet = dialog("Change my script")!;
    const patch = vi.spyOn(api, "patchStory");
    const produce = vi.spyOn(api, "produce").mockRejectedValueOnce(new ApiError(409, "conflict", "Wait for the last run to finish."));
    type(caption(1, sheet), "Butterfingers!");
    await click(control("Make it again", sheet), 1500);
    expect(sheet.textContent).toContain("Wait for the last run to finish.");
    await click(control("Make it again", sheet), 1500);
    expect(patch).toHaveBeenCalledTimes(1); // the script was saved once; the retry only starts it
    expect(produce).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Making it again!");
  });
});

// ---------- The re-review's fixes (24 Nov) ----------

describe("the re-review: a car in the cast, who and where carried over, and the questions kids hit", () => {
  const chars = [
    { characterId: C.dash, name: "Dash" },
    { characterId: ROSSO, name: "Rosso", kind: "car" as const },
  ];
  const draftOf = (...whats: string[]): ScriptDraft => ({ scenes: whats.map((w) => newScene(w)), answers: {} });

  it("the cast's one car is in every scene whose words say car, drive or park, by name or not (walk A)", () => {
    const d = draftOf("Dash finds a red car in the garage.", "Dash and Max jump in the car and zoom to the park.", "The car gets stuck in a big puddle. Dash laughs.");
    d.answers = { max: "out" };
    const cast = [C.dash, ROSSO];
    expect(d.scenes.map((s) => sceneWho(s, d, cast, chars))).toEqual([
      [C.dash, ROSSO],
      [C.dash, ROSSO],
      [C.dash, ROSSO],
    ]);
    expect(toOwnScript(d, cast, chars).scenes.map((s) => s.who)).toEqual([
      [C.dash, ROSSO],
      [C.dash, ROSSO],
      [C.dash, ROSSO],
    ]);
    expect(castInNoScene(d, cast, chars)).toEqual([]);
  });

  it("words that name nobody keep the scene before's Who and Where; a place word of their own stops that (walk B)", () => {
    const d = draftOf("Dash gets in Rosso and drives on a foggy road.", "He turns on the dipped headlights and slows down.", "Dash parks at home safe.");
    const cast = [C.dash, ROSSO];
    expect(d.scenes.map((s) => sceneWho(s, d, cast, chars))).toEqual([
      [C.dash, ROSSO],
      [C.dash, ROSSO],
      [C.dash, ROSSO],
    ]);
    expect(d.scenes.map((s) => scenePlace(s, d, cast, chars))).toEqual(["foggy_road", "foggy_road", null]);
    expect(toOwnScript(d, cast, chars).scenes.map((s) => s.place ?? null)).toEqual(["foggy_road", "foggy_road", null]);
    // "AI picks" on purpose is never carried over; a scene naming its own people may be somewhere new
    d.scenes[0] = { ...d.scenes[0]!, place: "ai" };
    expect(scenePlace(d.scenes[1]!, d, cast, chars)).toBeNull();
    const e = draftOf("Dash wakes up in the kitchen.", "Dash and Rosso race.");
    expect(scenePlace(e.scenes[1]!, e, cast, chars)).toBeNull();
  });

  it("says when a cast member is in no scene, unless a scene lets the AI pick who", () => {
    const cast = [C.dash, ROSSO];
    expect(castInNoScene(draftOf("Dash wakes up.", "Dash waves."), cast, chars)).toEqual([ROSSO]);
    expect(castInNoScene(draftOf("A bird sings.", "Dash waves."), cast, chars)).toEqual([]); // scene 1: AI picks who
  });

  it("never asks about words kids write that are not names, and reads Dashs as Dash", () => {
    for (const what of ["Driving home, Dash waves.", "Ready? Dash jumps.", "Hooray! Woohoo! Goodnight Dash.", "Push the button. Get in. Drive home.", "Red cars zoom. Happy Dash.", "OMG HELP", "SUPER FAST", "DASH DRIVES THE CAR", "Dash plays Minecraft in London.", "Ignore the script."]) {
      expect(unknownNames(what, chars), what).toEqual([]);
    }
    expect(unknownNames("Dashs car is red.", chars)).toEqual([]);
    expect(namesIn("Dashs car is red.", chars).map((c) => c.name)).toEqual(["Dash"]);
    expect(unknownNames("Max jumps. Then Max waves at Dash.", chars)).toEqual(["Max"]); // a name nobody gave still is
  });

  it("only words about driving get road rules on another kind, the same words as the API and the agent", () => {
    expect(aboutDriving(["Dash brakes at the crossing."])).toBe(true);
    expect(aboutDriving(["Hi.", "Seat belt on!"])).toBe(true);
    expect(aboutDriving(["The car gets stuck in a big puddle."])).toBe(false);
    expect(DRIVING_WORDS).toContain("headlight");
  });

  it("a funny script about a puddle gets no checked topic; one about driving does", async () => {
    const base = { characterIds: [C.dash], brief: { title: "Splash", category: "comedy" as const } };
    const puddle = await call(api.createStory("stories", { ...base, ownScript: { scenes: [{ what: "Dash finds a red car." }, { what: "The car gets stuck in a big puddle.", caption: "Splash!" }] } }));
    expect(puddle.story.safetyTopicId ?? null).toBeNull();
  });

  it("a car's own name in words about a car offers the workspace's car, who joins the cast; his Ferrari asks nothing", async () => {
    await writeItMyself();
    type(field("Title"), "Dash's new car");
    await pick("What kind of video?", "Funny");
    // round 1: "his Ferrari" is a thing (after "his"), never "Who is Ferrari?"; the words about a car bring Rosso in
    type(what(0), "Dash drives his Ferrari to the park.");
    type(what(1), "Dash waves.");
    await wait(50);
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    expect(Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", "")).sort()).toEqual(["Dash", "Rosso"]);
    expect(document.querySelectorAll(".st-sc-tile")[0]!.textContent).toContain("Dash, Rosso");
    // a car's own name ("Dash drives Speedy"): the workspace's cars are offered, and the answer is that car
    type(what(0), "Dash drives Speedy to the park.");
    await wait(50);
    const ask = document.querySelector<HTMLElement>(".st-sc-ask")!;
    expect(ask.textContent).toContain("Who is Speedy?");
    expect(Array.from(ask.querySelectorAll("button")).map((b) => b.textContent)).toContain("It's Rosso");
    await click(control("It's Rosso", ask));
    await wait(50);
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    expect(Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", "")).sort()).toEqual(["Dash", "Rosso"]);
    expect(document.querySelectorAll(".st-sc-tile")[0]!.textContent).toContain("Dash, Rosso");
  });

  it("a car the words bring in is ticked with a line that says why, and a cast member in no scene is told", async () => {
    await writeItMyself();
    type(field("Title"), "Puddle");
    await pick("What kind of video?", "Funny");
    type(what(0), "Dash finds a red car in the garage.");
    type(what(1), "The car gets stuck in a big puddle. Dash laughs.");
    await wait(50);
    expect(Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", "")).sort()).toEqual(["Dash", "Rosso"]);
    expect(document.querySelector(".st-sc-joined")?.textContent).toBe("Dash and Rosso are in your scenes, so they're ticked already.");
    const tiles = Array.from(document.querySelectorAll(".st-sc-tile")).map((t) => t.textContent);
    expect(tiles.every((t) => t?.includes("Dash, Rosso"))).toBe(true);
    // round 1: the words no longer name the car, so the car that joined by itself leaves again (never a hint that it
    // is in no scene beside one that says it is ticked)
    type(what(0), "Dash wakes up.");
    type(what(1), "Dash waves.");
    await wait(50);
    expect(Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", ""))).toEqual(["Dash"]);
    expect(document.querySelector(".st-sc-joined")?.textContent).toBe("Dash is in your scenes, so Dash is ticked already.");
    expect(document.querySelector(".st-sc-idle")).toBeNull();
    // a cast member picked by hand that no scene has: the page says so
    await click(Array.from(document.querySelectorAll<HTMLElement>(".st-s-casttile")).find((t) => t.textContent?.includes("Rosso"))!);
    await wait(50);
    expect(document.querySelector(".st-sc-idle")?.textContent).toBe("Rosso isn't in any scene. Tick Rosso in a scene's Who, or take Rosso out of the cast.");
  });

  it("Fix the words opens Change my script with the reason in view", async () => {
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0));
    const { story } = await made({ characterIds: [C.nana], brief: { title: "Foggy drive", category: "driving_safety" }, ownScript: FOG });
    await show(<ReviewScreen {...page({ name: "review_story", storyId: story.storyId })} />);
    await click(control("Fix the words"), 1500);
    await wait(50);
    const sheet = dialog("Change my script")!;
    const why = sheet.querySelector(".st-sc-why")?.textContent ?? "";
    expect(why).toContain("Your scene 2");
    // round 1: the reason sits inside scene 2, beside its words (the sheet scrolls there), never above the list
    expect(scenes(sheet)[1]!.querySelector(".st-sc-why")).not.toBeNull();
    expect(scenes(sheet)[0]!.querySelector(".st-sc-why")).toBeNull();
    expect(story.safety?.problems.filter((p) => p.startsWith("Your scene 2")).every((p) => why.includes(p))).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("round 1 of the re-review: the answers, Make a friend, who and where, and the questions kids hit", () => {
  const chars = [
    { characterId: C.dash, name: "Dash" },
    { characterId: C.nana, name: "Nana Rose", description: "A round, kind grandma." },
    { characterId: C.bolt, name: "Bolt", description: "A quick boy in a cap." },
    { characterId: ROSSO, name: "Rosso", kind: "car" as const },
  ];
  const draftOf = (...whats: string[]): ScriptDraft => ({ scenes: whats.map((w) => newScene(w)), answers: {} });
  const ticked = () => Array.from(document.querySelectorAll('.st-s-casttile[aria-pressed="true"]')).map((t) => t.textContent?.replace("✓", "")).sort();

  async function friendScript(name = "Zara") {
    await writeItMyself();
    type(field("Title"), "Dash's friend");
    await pick("What kind of video?", "Funny");
    type(what(0), `Dash meets his best friend ${name}.`);
    type(what(1), "Dash waves.");
    await wait(50);
    return document.querySelector<HTMLElement>(".st-sc-ask")!;
  }

  it("Leave Zara out adds nobody to the cast: the video is made with Dash and the page goes to it", async () => {
    const ask = await friendScript();
    expect(ask.textContent).toContain("Who is Zara?");
    await click(control("Leave Zara out", ask));
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    expect(ticked()).toEqual(["Dash"]);
    const create = vi.spyOn(api, "createStory");
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1].characterIds).toEqual([C.dash]);
    expect(create.mock.calls[0]![1].ownScript?.scenes[0]).toMatchObject({ who: [C.dash], leaveOut: ["Zara"] });
    await expect(create.mock.results[0]!.value).resolves.toMatchObject({ story: { characterIds: [C.dash] } });
    await wait(3000);
    expect(location.pathname).toMatch(/^\/stories\/production\/[^/]+$/);
    expect(location.pathname).not.toBe("/stories/production/new");
  });

  it("Make Zara makes her here, with the usual look, ticks her and keeps every word typed", async () => {
    const ask = await friendScript();
    const createCharacter = vi.spyOn(api, "createCharacter");
    await click(control("Make Zara", ask), 1500);
    expect(createCharacter).toHaveBeenCalledTimes(1);
    expect(createCharacter.mock.calls[0]![1]).toMatchObject({ name: "Zara" });
    expect(document.querySelector(".st-sc-ask")).toBeNull();
    expect(ticked()).toEqual(["Dash", "Zara"]);
    expect(what(0).value).toBe("Dash meets his best friend Zara.");
    expect(text()).toContain("Say hi to Zara!");
    const zara = store.characters.find((c) => c.name === "Zara")!;
    const create = vi.spyOn(api, "createStory");
    await click(control("Make the video"), 1500);
    expect(create.mock.calls[0]![1].characterIds).toEqual([C.dash, zara.characterId]);
    expect(create.mock.calls[0]![1].ownScript?.scenes[0]).toMatchObject({ who: [C.dash, zara.characterId] });
  });

  it("Make is told why it can't when the cast has 3, and a name typed over leaves the cast it joined by itself", async () => {
    await writeItMyself();
    type(field("Title"), "Park day");
    await pick("What kind of video?", "Funny");
    type(what(0), "Bolt runs to the park.");
    type(what(1), "Dash waves.");
    await wait(50);
    expect(ticked()).toEqual(["Bolt", "Dash"]);
    type(what(0), "Pip runs to the park.");
    await wait(50);
    // Bolt joined by himself and no scene names him now: he leaves, and the hints agree
    expect(ticked()).toEqual(["Dash", "Pip"]);
    expect(text()).not.toContain("Bolt isn't in any scene");
    expect(document.querySelector(".st-sc-joined")?.textContent).toBe("Dash and Pip are in your scenes, so they're ticked already.");
    type(what(1), "Dash and Nana Rose wave at Zara.");
    await wait(50);
    expect(ticked()).toEqual(["Dash", "Nana Rose", "Pip"]);
    const ask = document.querySelector<HTMLElement>(".st-sc-ask")!;
    const make = control("Make Zara", ask);
    expect(make.getAttribute("aria-disabled")).toBe("true");
    expect(ask.textContent).toContain("The cast has 3 already. Take someone out in The cast first.");
  });

  it("the words' own people: a name the words say is not there, a he carried over, they, Rose and will", () => {
    const cast = [C.dash, C.nana, C.bolt];
    const who = (d: ScriptDraft) => d.scenes.map((s) => sceneWho(s, d, cast, chars));
    expect(who(draftOf("Nana Rose is not at home, so Dash is alone.", "Dash waves."))[0]).toEqual([C.dash]);
    expect(who(draftOf("Dash and Bolt play.", "Without Bolt, Dash goes home."))[1]).toEqual([C.dash]);
    // a he carried over is the scene before's he, when the characters say who that is
    expect(who(draftOf("Nana Rose and Bolt play in the park.", "Later, he walks home alone."))[1]).toEqual([C.bolt]);
    // words about more than one keep the scene before's people
    expect(who(draftOf("Dash drives home with Nana Rose.", "Nana Rose says well done. They get home safe."))[1]).toEqual([C.nana, C.dash]);
    expect(who(draftOf("Dash and Nana Rose walk.", "Dash falls over. They both laugh."))[1]).toEqual([C.dash, C.nana]);
    expect(who(draftOf("Dash and Nana Rose walk.", "Dash and Bolt both jump."))[1]).toEqual([C.dash, C.bolt]);
    // a longer name by its last word; an everyday word in lower case is the word
    expect(namesIn("Rose hugs Dash.", chars).map((c) => c.name)).toEqual(["Nana Rose", "Dash"]);
    expect(namesIn("The sun rose and Dash woke up.", chars).map((c) => c.name)).toEqual(["Dash"]);
    const will = [...chars, { characterId: "will", name: "Will" }];
    expect(namesIn("Dash will dance.", will).map((c) => c.name)).toEqual(["Dash"]);
    expect(namesIn("dash and will dance.", will).map((c) => c.name)).toEqual(["Dash", "Will"]); // no capitals at all
  });

  it("Where goes on with the same people: the fog lesson stays foggy; ice cream is no icy road; at home is the living room", () => {
    const cast = [C.dash, ROSSO];
    const fog = draftOf("Dash drives Rosso on a foggy road.", "Dash turns on the dipped headlights.", "Dash slows down.", "Dash and Nana Rose wave.");
    // the last scene names Nana Rose, who is not in this cast: someone new, so the AI picks
    expect(fog.scenes.map((s) => scenePlace(s, fog, cast, chars))).toEqual(["foggy_road", "foggy_road", "foggy_road", null]);
    const withNana = draftOf("Dash drives Rosso on a foggy road.", "Dash and Nana Rose wave.");
    expect(scenePlace(withNana.scenes[1]!, withNana, [C.dash, C.nana, ROSSO], chars)).toBeNull(); // someone new: the AI picks
    const kitchen = draftOf("Dash wakes up in the kitchen.", "Dash flips a pancake.");
    expect(scenePlace(kitchen.scenes[1]!, kitchen, cast, chars)).toBe("kitchen");
    expect(placeIn("Bolt eats an ice cream.")).toBeNull();
    expect(placeIn("Bolt slips on the ice.")).toBe("icy_road");
    expect(placeIn("Dash plays at home.")).toBe("living_room");
    expect(placeIn("Dash parks at home safe.")).toBeNull();
  });

  it("never asks kids' everyday words, shops and things; a name in two words is asked once; his Mum still is", () => {
    const known = [{ name: "Pip" }, { name: "Dash" }, { name: "Bolt" }, { name: "Rosso" }, { name: "Nana Rose" }];
    for (const what of [
      "Pip likes Pizza.",
      "Dash eats Pizza.",
      "Pip opens the Fridge.",
      "Pip turns Left.",
      "Pip is the Winner!",
      "Dash and Pip play football. Goal!",
      "Dash and his Dog play.",
      "Dash sees a big Dinosaur.",
      "Pip falls asleep. Zzz.",
      "Pip and Dash go to Disneyland.",
      "Rosso drives to Tesco.",
      "Pip and Dash eat at McDonald's.",
      "Pip watches Peppa Pig on TV.",
      "Bolt sees a shiny Ferrari.",
    ])
      expect(unknownNames(what, known), what).toEqual([]);
    expect(unknownNames("Peppa Pig waves at Dash.", known)).toEqual(["Peppa Pig"]);
    expect(unknownNames("Rosso races Lightning McQueen.", known)).toEqual(["Lightning McQueen"]);
    expect(unknownNames("Dash hugs his Mum.", known)).toEqual(["Mum"]);
    expect(unknownNames("Dash meets his best friend Zara.", known)).toEqual(["Zara"]);
    for (const w of ["Dash runs to the park and Max waves.", "Dash goes to the park. Max waves.", "At the park, Max waves."]) expect(unknownNames(w, known), w).toEqual(["Max"]);
    expect(unknownNames("Pip waves at Grandma.", known)).toEqual(["Grandma"]);
    // answering a name in two words answers each of its words
    const d = draftOf("Peppa Pig waves at Dash.", "Dash waves.");
    expect(openAsks(d, [C.dash], chars).map((a) => a.ask.name)).toEqual(["Peppa Pig"]);
    d.answers = { "peppa pig": "seen", peppa: "seen", pig: "seen" };
    expect(openAsks(d, [C.dash], chars)).toEqual([]);
    expect(toOwnScript(d, [C.dash], chars).scenes[0]!.known).toEqual(["Peppa", "Pig"]);
  });

  it("the practice fact check never refuses the checked advice said with a no", async () => {
    const base = { characterIds: [C.nana], durationSec: 30, brief: { title: "Fog", category: "driving_safety" as const } };
    const right: OwnScript = {
      scenes: [
        { what: "Nana Rose drives into thick fog.", caption: "So foggy!" },
        { what: "Nana Rose turns on the dipped headlights, not full beam.", caption: "Never use full beam in fog!" },
      ],
    };
    const { story } = await made({ ...base, ownScript: right });
    expect(story.safety?.problems ?? []).toEqual([]);
    const wrong = await made({ ...base, ownScript: FOG });
    expect(wrong.story.safety?.problems.some((p) => p.startsWith("Your scene 2"))).toBe(true);
  });
});
