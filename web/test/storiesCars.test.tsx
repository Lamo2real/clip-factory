// Clips Funded vehicle characters on the web (docs/CONTRACTS.md §45.42, §45.47): New character asks "What are you
// making?" (two tiles, ?kind=car picks the vehicle), then "What is it?" (Car, Truck, Bus, Motorbike, Plane, Boat), the
// vehicle's photos in two strips (Outside up to 6, Inside up to 4, 8 in all; drag and drop, paste, Remove, one design
// upload and one PUT each, each photo keeping its side), Design it sends the photos as one 3-vehicle design with their
// sides and the kind, and "Pick one" shows them (tapping another puts it in the editor, Make more sends the looks to
// stay away from), the car's own Looks, Face (none to start) and Moves, its Sounds part, and Save vehicle. Vehicles have
// their own place (Vehicles, /stories/vehicles; /stories/cars still opens it): the vehicles only, a big "Make a
// vehicle" that opens the flow there, and each vehicle's page under it; Characters lists the whole cast, each vehicle
// with its Vehicle tag. Rendered with the mock's own parts (fake timers).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/api/upload.ts", async (load) => {
  const real = await load<typeof import("../src/api/upload.ts")>();
  return {
    ...real,
    putFile: (...args: Parameters<typeof real.putFile>) => {
      puts.count += 1;
      return real.putFile(...args);
    },
  };
});

import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as characters from "../src/stories/api/mock/characters.ts";
import * as ideas from "../src/stories/api/mock/ideas.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import type { AiTask, CarInput, CharacterInput, ModelInfo, StoriesApi, StoriesConfig, Workspace } from "../src/stories/api/types.ts";
import { matchStories, storiesHref, type StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { CarsScreen } = await import("../src/stories/screens/Cars.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");
const { designOf, designsOf } = await import("../src/stories/studio/Design.tsx");
const { characterProblem, newCar, showFace } = await import("../src/stories/studio/looks.ts");

const C = stories.SEED_IDS.characters;

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

function start() {
  store = createStore();
  store.knobs = {};
  store.workspaces.push(structuredClone(WS));
  ideas.seed(store);
  characters.seed(store);
  stories.seed(store);
  characters.afterSeed(store);
  const impl: Partial<StoriesApi> = {
    ...ideas.api(store),
    ...characters.api(store),
    ...stories.api(store),
    listWorkspaces: async () => store.workspaces,
    getWorkspace: async () => store.workspaces[0]!,
    getAi: async () => ({ ai: { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 1 }, models: structuredClone(MODELS), agents: [], tasks: structuredClone(LISTED_INFO.tasks) }),
  };
  api = new Proxy(impl, { get: (t, k: string) => (t as Record<string, unknown>)[k] ?? (() => Promise.reject(new Error(`not used: ${k}`))) }) as StoriesApi;
  setStoriesApi(api);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
  forgetLoaded();
  puts.count = 0;
  start();
  history.replaceState(null, "", "/stories/characters/new");
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

async function untilTask(seconds = 5) {
  for (let i = 0; i < seconds * 4; i += 1) await wait(250);
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

function group(name: string): HTMLElement {
  const g = Array.from(document.querySelectorAll<HTMLElement>('[role="radiogroup"]')).find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === name);
  if (!g) throw new Error(`no pick bar ${name}`);
  return g;
}

const chosen = (name: string) => group(name).querySelector<HTMLInputElement>("input:checked")?.closest("label")?.querySelector(".st-s-pick__label")?.textContent?.trim();

async function pick(name: string, option: string) {
  const opt = Array.from(group(name).querySelectorAll("label")).find((l) => l.querySelector(".st-s-pick__label")?.textContent?.trim() === option);
  if (!opt) throw new Error(`no option ${option}`);
  await click(opt.querySelector("input") as HTMLElement, 50);
}

const png = (name: string, size = 3000) => new File([new Uint8Array(size)], name, { type: "image/png" });

async function addFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('.st-s-photos input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

const thumbs = () => document.querySelectorAll(".st-s-photos__item");
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".st-s-caropts .st-s-pick__opt"));

describe("New character: a person or a car", () => {
  it("starts on two big tiles with the person picked; a tap on A car shrinks them and opens the car's photos", async () => {
    await show(<CharactersScreen {...page({ name: "character_new" })} />);
    expect(document.querySelector(".st-s-kind--tiles")).not.toBeNull();
    expect(chosen("What are you making?")).toBe("A person");
    expect(document.querySelector(".st-s-photos")).toBeNull();
    await pick("What are you making?", "A vehicle");
    expect(document.querySelector(".st-s-kind--tiles")).toBeNull();
    expect(chosen("What are you making?")).toBe("A vehicle");
    expect(text()).toContain("Front, side, back. Up to 6.");
    expect(field(/^What is it like\?/)).toBeTruthy();
    // A change, then the other kind: it asks before anything goes.
    await pick("Car shape", "Van");
    await pick("What are you making?", "A person");
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.textContent).toContain("Start again as a person?");
    expect(sheet.textContent).toContain("Your changes go.");
    await click(control("Keep it", sheet), 50);
    expect(chosen("What are you making?")).toBe("A vehicle");
    expect(chosen("Car shape")).toBe("Van");
    await pick("What are you making?", "A person");
    await click(control("Start again"), 50);
    expect(chosen("What are you making?")).toBe("A person");
    expect(chosen("Shape")).toBe("Bean");
  });

  it("?kind=car picks the car at the start", async () => {
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    expect(document.querySelector(".st-s-kind--tiles")).toBeNull();
    expect(chosen("What are you making?")).toBe("A vehicle");
    expect(control("Next: Face")).toBeTruthy();
    expect(chosen("Car shape")).toBe("Hatchback");
  });
});

describe("the car's photos", () => {
  it("takes 6 and refuses a 7th, removes one, and sends each with one design upload and one PUT", async () => {
    const upload = vi.spyOn(api, "designUpload");
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await addFiles(Array.from({ length: 7 }, (_, i) => png(`car-${i + 1}.png`)));
    expect(thumbs()).toHaveLength(6);
    expect(text()).toContain("Up to 6 photos. Remove one first.");
    await wait(5000);
    expect(upload).toHaveBeenCalledTimes(6);
    expect(puts.count).toBe(6);
    expect(upload).toHaveBeenCalledWith("stories", { filename: "car-1.png", contentType: "image/png", size: 3000 });
    expect(document.querySelectorAll(".st-s-photos__item.is-ready")).toHaveLength(6);
    // Full: the file input is never disabled, so a key or a tap on it still says why instead of opening the picker.
    const input = document.querySelector<HTMLInputElement>('.st-s-photos input[type="file"]')!;
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-disabled")).toBe("true");
    const pick = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(pick));
    expect(pick.defaultPrevented).toBe(true);
    expect(text()).toContain("Up to 6 photos. Remove one first.");
    await click(control("Remove photo 1"), 50);
    expect(thumbs()).toHaveLength(5);
    expect(control("Add photos").getAttribute("aria-disabled")).toBeNull();
  });

  it("a drop adds its pictures and refuses a file that is not one", async () => {
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    const zone = document.querySelector<HTMLElement>(".st-s-photos__zone")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    const files = [png("front.png"), new File(["hi"], "notes.txt", { type: "text/plain" }), new File([new Uint8Array(2000)], "side.webp", { type: "image/webp" })];
    Object.defineProperty(drop, "dataTransfer", { value: { files, items: [], types: ["Files"] } });
    await act(async () => zone.dispatchEvent(drop));
    expect(thumbs()).toHaveLength(2);
    expect(text()).toContain("Pick a PNG, JPEG or WebP picture.");
    await wait(4000);
    expect(puts.count).toBe(2);
  });

  it("a photo still sending when the panel closes keeps sending, and shows ready when it opens again", async () => {
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await addFiles([png("front.png")]);
    expect(document.querySelectorAll(".st-s-photos__item.is-sending")).toHaveLength(1);
    await click(control("Close"), 50);
    expect(document.querySelector(".st-s-photos")).toBeNull();
    await click(control("Design with AI"), 50);
    await wait(3000);
    expect(document.querySelectorAll(".st-s-photos__item.is-ready")).toHaveLength(1);
    expect(text()).not.toContain("Tap to try again");
    expect(puts.count).toBe(1); // sent once, never again
  });

  it("a photo that did not send says Tap to try again, and a tap sends it again", async () => {
    const real = api.designUpload.bind(api);
    let first = true;
    vi.spyOn(api, "designUpload").mockImplementation(async (ws, f) => {
      if (first) {
        first = false;
        throw new Error("offline");
      }
      return real(ws, f);
    });
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await addFiles([png("front.png")]);
    await wait(2000);
    expect(text()).toContain("That photo didn't send. Tap it to try again.");
    await click(control(/^Photo 1 didn't send/), 4000);
    expect(document.querySelectorAll(".st-s-photos__item.is-ready")).toHaveLength(1);
  });
});

describe("Vehicles: What is it?, outside and inside photos, and paste (§45.47)", () => {
  const strip = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(".st-s-photos")).find((p) => p.querySelector(".st-s-field__label")?.textContent?.trim() === label)!;
  const stripThumbs = (label: string) => strip(label).querySelectorAll(".st-s-photos__item");

  async function addTo(label: string, files: File[]) {
    const input = strip(label).querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  }

  async function paste(target: EventTarget, files: File[]) {
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: { items: [], files } });
    await act(async () => target.dispatchEvent(e));
    return e;
  }

  it("asks What is it? with six kinds, Car picked; the pick goes to the design as vehicle, and a car leaves it out", async () => {
    const design = vi.spyOn(api, "designCharacter");
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    expect(Array.from(group("What is it?").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent)).toEqual(["Car", "Truck", "Bus", "Motorbike", "Plane", "Boat"]);
    expect(group("What is it?").querySelectorAll("svg")).toHaveLength(6);
    expect(chosen("What is it?")).toBe("Car");
    expect(text()).toContain("Drop, paste or pick photos.");
    type(field(/^What is it like\?/), "a red one");
    await click(control("Design it"), 250);
    expect(design.mock.calls[0]![1]).toEqual({ kind: "car", count: 3, description: "a red one" });
    await untilTask();
    await pick("What is it?", "Plane");
    expect(chosen("What is it?")).toBe("Plane");
    await click(control("Design it again"), 250);
    expect(design.mock.calls[1]![1]).toEqual({ kind: "car", count: 3, description: "a red one", vehicle: "plane" });
    await untilTask();
    expect(cards()).toHaveLength(3);
  });

  it("an untouched editor starts as the picked kind's first body; a changed one stays as the owner left it", async () => {
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    const create = vi.spyOn(api, "createCharacter");
    await pick("What is it?", "Truck");
    expect(chosen("Car shape")).toBe("Pickup");
    await pick("Car shape", "Van");
    await pick("What is it?", "Car");
    expect(chosen("Car shape")).toBe("Van");
    await click(control("Next: Face"), 50);
    await click(control("Next: Moves"), 50);
    await click(control("Next: Sounds"), 50);
    await click(control("Next: Name and personality"), 50);
    type(field("Name"), "Trucky");
    await click(control("Save vehicle"));
    expect(create.mock.calls[0]![1]).toMatchObject({ kind: "car", car: { body: "van" } });
  });

  it("has an Outside strip (up to 6) and an Inside strip (up to 4), 8 in all, and sends each photo's side", async () => {
    const design = vi.spyOn(api, "designCharacter");
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    expect(text()).toContain("Seats and dashboard. Up to 4.");
    await addTo("Inside", Array.from({ length: 5 }, (_, i) => png(`seat-${i + 1}.png`)));
    expect(stripThumbs("Inside")).toHaveLength(4);
    expect(text()).toContain("Up to 4 inside photos. Remove one first.");
    await addTo("Outside", Array.from({ length: 6 }, (_, i) => png(`out-${i + 1}.png`)));
    // 4 inside leave room for 4 outside: 8 in all.
    expect(stripThumbs("Outside")).toHaveLength(4);
    expect(text()).toContain("Up to 8 photos. Remove one first.");
    await wait(8000);
    expect(document.querySelectorAll(".st-s-photos__item.is-ready")).toHaveLength(8);
    await click(control("Remove inside photo 1"), 50);
    await click(control("Remove inside photo 1"), 50);
    expect(stripThumbs("Inside")).toHaveLength(2);
    await click(control("Design it"), 250);
    const body = design.mock.calls[0]![1];
    expect(body.referenceAssetIds).toHaveLength(6);
    // Outside first, then inside, in the same order as the ids.
    expect(body.referenceSides).toEqual(["outside", "outside", "outside", "outside", "inside", "inside"]);
    await untilTask();
    expect(cards()).toHaveLength(3);
  });

  it("a paste adds photos: on the page to the strip last used (Outside to start), and on a strip to that strip", async () => {
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    const first = await paste(document.body, [png("screenshot.png")]);
    expect(first.defaultPrevented).toBe(true);
    expect(stripThumbs("Outside")).toHaveLength(1);
    // A paste with no picture (words) is left alone.
    const words = await paste(document.body, []);
    expect(words.defaultPrevented).toBe(false);
    await act(async () => strip("Inside").dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await paste(document.body, [png("dash.png")]);
    expect(stripThumbs("Inside")).toHaveLength(1);
    expect(stripThumbs("Outside")).toHaveLength(1);
    // A paste that is not a picture says so, like a drop.
    await paste(document.body, [new File(["hi"], "notes.txt", { type: "text/plain" })]);
    expect(stripThumbs("Inside")).toHaveLength(1);
    await wait(4000);
    expect(puts.count).toBe(2);
  });

  it("a saved vehicle keeps each photo's side, and its page starts each strip with its own photos", async () => {
    const upload = vi.spyOn(api, "referenceUpload");
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    await addTo("Outside", [png("front.png")]);
    await addTo("Inside", [png("seats.png")]);
    await wait(4000);
    await click(control("Design it"), 250);
    await untilTask();
    await click(control("Save vehicle"), 3000);
    await wait(4000);
    expect(upload.mock.calls.map((c) => c[2])).toEqual([
      { filename: "front.png", contentType: "image/png", size: 3000 },
      { filename: "seats.png", contentType: "image/png", size: 3000, side: "inside" },
    ]);
    const id = location.pathname.split("/").pop()!;
    const saved = store.characters.find((c) => c.characterId === id)!;
    expect(saved.references.map((r) => r.side ?? "outside")).toEqual(["outside", "inside"]);
    expect(saved.kind === "car" && saved.car.interior).toMatchObject({ seat: expect.stringMatching(/^#/), dash: expect.stringMatching(/^#/) });
    await act(async () => root.render(<ToastProvider><CarsScreen {...page({ name: "car", characterId: id })} /></ToastProvider>));
    await wait();
    await click(control("Design with AI"), 50);
    expect(stripThumbs("Outside")).toHaveLength(1);
    expect(stripThumbs("Inside")).toHaveLength(1);
  });
});

describe("Design it: 3 cars to pick from", () => {
  it("sends the photos as one 3-car design, shows the cars, puts the picked one in the editor, and Make more sends avoid", async () => {
    const design = vi.spyOn(api, "designCharacter");
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await click(control("Design it"), 50);
    expect(text()).toContain("Add a photo of your car, or say what it is like.");
    expect(design).not.toHaveBeenCalled();
    await addFiles([png("front.png"), png("side.png"), png("back.png")]);
    await wait(5000);
    const ids = Array.from(document.querySelectorAll(".st-s-photos__item")).map((_, i) => i);
    expect(ids).toHaveLength(3);
    await click(control("Design it"), 250);
    expect(design).toHaveBeenCalledTimes(1);
    const body = design.mock.calls[0]![1];
    expect(Object.keys(body).sort()).toEqual(["count", "kind", "referenceAssetIds"]);
    expect(body).toEqual({ kind: "car", referenceAssetIds: expect.arrayContaining([expect.any(String)]), count: 3 });
    expect(body.referenceAssetIds).toHaveLength(3);
    expect(control("Designing 3…")).toBeTruthy();
    await untilTask();
    expect(cards()).toHaveLength(3);
    expect(text()).toContain("Pick one");
    expect(cards()[0]!.textContent).toContain("Picked");
    const names = cards().map((c) => c.querySelector(".st-s-pick__label")?.textContent);
    // The first is in the editor at once, open on its name to check.
    expect(field("Name").value).toBe(names[0]);
    await click(cards()[1]!.querySelector("input") as HTMLElement, 50);
    expect(field("Name").value).toBe(names[1]);
    expect(cards()[1]!.textContent).toContain("Picked");
    await click(control("Make more"), 250);
    const more = design.mock.calls[1]![1];
    expect(more).toMatchObject({ kind: "car", referenceAssetIds: body.referenceAssetIds, count: 3 });
    expect(more.avoid).toHaveLength(3);
    expect(more.avoid![0]).toMatchObject({ body: expect.any(String), paint: expect.stringMatching(/^#/) });
    await untilTask();
    expect(cards()).toHaveLength(6);
    // The picked one stays in the editor.
    expect(field("Name").value).toBe(names[1]);
  });

  it("the owner's words go too, and Save car makes a car that keeps its photos", async () => {
    const design = vi.spyOn(api, "designCharacter");
    const create = vi.spyOn(api, "createCharacter");
    const keep = vi.spyOn(api, "referenceComplete");
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await addFiles([png("front.png")]);
    await wait(3000);
    type(field(/^What is it like\?/), "my red hatchback, a bit old");
    await click(control("Design it"), 250);
    expect(design.mock.calls[0]![1]).toEqual({ kind: "car", referenceAssetIds: [expect.any(String)], count: 3, description: "my red hatchback, a bit old" });
    await untilTask();
    await click(control("Save vehicle"), 3000);
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0]![1] as CarInput;
    expect(sent.kind).toBe("car");
    expect(sent.car.paint).toBe("#d8352a");
    expect(sent.expressions).toEqual(["neutral"]);
    expect(sent.voice).toMatchObject({ style: "none", noises: [] });
    await wait(4000);
    expect(keep).toHaveBeenCalledTimes(1);
    const saved = store.characters.find((c) => c.name === sent.name)!;
    expect(saved.kind).toBe("car");
    expect(saved.references).toHaveLength(1);
  });
});

describe("the car editor", () => {
  it("Looks change the car, Face starts with no face and eyes on gives 3 faces, Try a move honks, and Sounds has no voice", async () => {
    const create = vi.spyOn(api, "createCharacter");
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    await pick("Car shape", "Van");
    await pick("Wheels", "Off-road");
    await pick("On top", "Roof rack");
    await click(control("Next: Face"), 50);
    expect(text()).toContain("Real cars have no face. Add one for fun.");
    expect(chosen("Face")).toBe("No face");
    expect(document.querySelectorAll(".st-s-face")).toHaveLength(0);
    await pick("Face", "Eyes on the windscreen");
    expect(document.querySelectorAll(".st-s-face")).toHaveLength(14);
    expect(text()).toContain("3 faces picked.");
    await click(control("Next: Moves"), 50);
    expect(group("How Your vehicle drives").textContent).toContain("Quick off the mark");
    const log = (window.__cfSampleLog ??= []);
    const before = log.length;
    await pick("Try a move", "Honk");
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Honk");
    expect(log.slice(before).some((e) => e.url.endsWith("/sfx/honk.mp3") && (e.action === "play" || e.action === "off"))).toBe(true);
    await click(control("Next: Sounds"), 50);
    expect(text()).toContain("has no voice");
    expect(document.querySelector('input[type="range"]')).toBeNull();
    await click(control("Next: Name and personality"), 50);
    expect(field("Name").getAttribute("placeholder")).toBe("For example: Rosso");
    await click(control("Save vehicle"), 50);
    expect(text()).toContain("Give your car a name.");
    type(field("Name"), "Vanessa");
    await click(control("Save vehicle"));
    const sent = create.mock.calls[0]![1] as CarInput;
    expect(sent).toMatchObject({ kind: "car", name: "Vanessa", car: { body: "van", extra: "roof_rack", wheels: { style: "offroad" }, face: { eyes: "windscreen" } } });
    expect(sent.expressions).toEqual(["neutral", "happy", "surprised"]);
    // A car's page is under Cars.
    expect(location.pathname).toMatch(/^\/stories\/vehicles\/[0-9A-Z]{26}$/);
  });

  it("a car's page redesigns it from its own pictures, and an older link under Characters moves to Cars", async () => {
    await show(<CharactersScreen {...page({ name: "character", characterId: characters.SEED_CAR_ID })} />);
    expect(location.pathname).toBe(`/stories/vehicles/${characters.SEED_CAR_ID}`);
    const back = control(/Vehicles$/);
    expect(back.getAttribute("href")).toBe("/stories/vehicles");
    const design = vi.spyOn(api, "designCharacter");
    await click(control("Design with AI"), 50);
    type(field(/^What is it like\?/), "make it blue");
    await click(control("Design it"), 250);
    expect(design.mock.calls[0]![1]).toEqual({ kind: "car", count: 3, description: "make it blue", characterId: characters.SEED_CAR_ID });
    await untilTask();
    expect(cards()).toHaveLength(3);
    expect(cards().every((c) => c.textContent?.includes("Rosso"))).toBe(true);
    const box = document.querySelector<HTMLElement>(".st-s-redesign")!;
    expect(box.textContent).toContain("What changes:");
    expect(box.textContent).toMatch(/Looks.*paint/);
  });
});

describe("Vehicles: the vehicles' own place, and the vehicles in Characters", () => {
  const castCards = () => Array.from(document.querySelectorAll<HTMLAnchorElement>("a.st-s-cast__card"));
  const castNames = () => castCards().map((c) => c.querySelector(".st-s-cast__name")?.textContent);

  it("has its addresses: /stories/vehicles, /stories/vehicles/new and /stories/vehicles/{id}, and /stories/cars… still opens them", () => {
    expect(matchStories("/stories/vehicles", "")).toEqual({ name: "cars" });
    expect(matchStories("/stories/vehicles/new", "")).toEqual({ name: "car_new" });
    expect(matchStories(`/stories/vehicles/${characters.SEED_CAR_ID}`, "")).toEqual({ name: "car", characterId: characters.SEED_CAR_ID });
    expect(matchStories("/stories/cars/new/more", "").name).toBe("not_found");
    expect(matchStories("/stories/vehicles/new/more", "").name).toBe("not_found");
    // Old links: the same pages, and every link the app makes is the Vehicles address.
    expect(matchStories("/stories/cars", "")).toEqual({ name: "cars" });
    expect(matchStories("/stories/cars/new", "")).toEqual({ name: "car_new" });
    expect(matchStories(`/stories/cars/${characters.SEED_CAR_ID}`, "")).toEqual({ name: "car", characterId: characters.SEED_CAR_ID });
    expect(storiesHref(matchStories("/stories/cars", ""))).toBe("/stories/vehicles");
    for (const path of ["/stories/vehicles", "/stories/vehicles/new", `/stories/vehicles/${characters.SEED_CAR_ID}`]) expect(storiesHref(matchStories(path, ""))).toBe(path);
  });

  it("Characters lists the people and the vehicles, each with its Vehicle tag and its own page, and one Make a vehicle", async () => {
    await show(<CharactersScreen {...page({ name: "characters" })} />);
    expect(document.querySelector("h1")?.textContent).toBe("Characters");
    expect(castNames()).toEqual(["Bolt", "Dash", "Nana Rose", "Pip", "Rosso"]);
    const card = castCards().find((c) => c.textContent?.includes("Rosso"))!;
    expect(card.getAttribute("href")).toBe(`/stories/vehicles/${characters.SEED_CAR_ID}`);
    expect(card.querySelector(".st-s-tag")?.textContent).toBe("Vehicle");
    expect(card.querySelector("canvas[role=img]")).not.toBeNull();
    expect(castCards().find((c) => c.textContent?.includes("Pip"))!.getAttribute("href")).toBe(`/stories/characters/${C.pip}`);
    const make = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.textContent?.trim() === "Make a vehicle");
    expect(make).toHaveLength(1);
    expect(make[0]!.getAttribute("href")).toBe("/stories/vehicles/new");
    expect(text()).not.toContain("in Cars");
  });

  it("Vehicles lists the vehicles only, each opening its own page, with one big Make a vehicle", async () => {
    await show(<CarsScreen {...page({ name: "cars" })} />);
    expect(document.querySelector("h1")?.textContent).toBe("Vehicles");
    expect(castNames()).toEqual(["Rosso"]);
    const card = castCards()[0]!;
    expect(card.getAttribute("href")).toBe(`/stories/vehicles/${characters.SEED_CAR_ID}`);
    expect(card.querySelector(".st-s-tag")?.textContent).toBe("Vehicle");
    expect(card.querySelector("canvas[role=img]")).not.toBeNull();
    const make = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.textContent?.trim() === "Make a vehicle");
    expect(make).toHaveLength(1);
    expect(make[0]!.getAttribute("href")).toBe("/stories/vehicles/new");
  });

  it("with no vehicles Vehicles shows an empty garage with Make a vehicle", async () => {
    store.characters = store.characters.filter((c) => c.characterId !== characters.SEED_CAR_ID);
    await show(<CarsScreen {...page({ name: "cars" })} />);
    expect(text()).toContain("No vehicles yet");
    expect(text()).toContain("Add photos. Tap Make a vehicle.");
    expect(castCards()).toHaveLength(0);
    const make = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.textContent?.trim() === "Make a vehicle");
    expect(make.map((a) => a.getAttribute("href"))).toEqual(["/stories/vehicles/new"]);
  });

  it("Make a vehicle is the flow under Vehicles: no person tiles, New vehicle, back to Vehicles, and Save vehicle opens it there", async () => {
    const create = vi.spyOn(api, "createCharacter");
    await show(<CarsScreen {...page({ name: "car_new" })} />);
    expect(document.querySelector(".st-s-kind")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("New vehicle");
    expect(control(/Vehicles$/).getAttribute("href")).toBe("/stories/vehicles");
    expect(text()).toContain("Front, side, back. Up to 6.");
    expect(chosen("Car shape")).toBe("Hatchback");
    await addFiles([png("front.png")]);
    await wait(3000);
    await click(control("Design it"), 250);
    await untilTask();
    expect(cards()).toHaveLength(3);
    await click(control("Save vehicle"), 3000);
    expect(create.mock.calls[0]![1]).toMatchObject({ kind: "car" });
    await wait(4000);
    expect(location.pathname).toMatch(/^\/stories\/vehicles\/[0-9A-Z]{26}$/);
    const id = location.pathname.split("/").pop()!;
    expect(store.characters.find((c) => c.characterId === id)).toMatchObject({ kind: "car", references: [expect.anything()] });
    // Its page under Cars, back to Cars, and Delete goes back there too.
    await act(async () => root.render(<ToastProvider><CarsScreen {...page({ name: "car", characterId: id })} /></ToastProvider>));
    await wait();
    expect(location.pathname).toBe(`/stories/vehicles/${id}`);
    expect(control(/Vehicles$/).getAttribute("href")).toBe("/stories/vehicles");
    await click(control("Delete"), 50);
    await click(control("Delete", document.querySelector<HTMLElement>('[role="dialog"]')!), 2000);
    expect(location.pathname).toBe("/stories/vehicles");
  });
});

describe("the car's words and checks", () => {
  it("designsOf reads every option, designOf the first; a car fills out with no voice", () => {
    const car = newCar();
    const task = { result: { character: { ...car, name: "A" }, characters: [{ ...car, name: "A" }, { kind: "car", name: "B", car: { paint: "#2f6fb5" }, voice: { style: "babble", noises: ["gasp"], sfx: ["honk"] } }] } } as unknown as AiTask;
    const all = designsOf(task);
    expect(all.map((c) => c.name)).toEqual(["A", "B"]);
    const b = all[1] as CarInput;
    expect(b.car).toMatchObject({ paint: "#2f6fb5", body: "hatchback", wheels: { style: "alloy" } });
    expect(b.voice).toEqual({ style: "none", pitch: 1, noises: [], sfx: ["honk"] });
    expect(b.expressions).toEqual(["neutral"]);
    expect(designOf(task)?.name).toBe("A");
    // An older answer with only `character` is one option.
    expect(designsOf({ result: { character: { ...car, name: "Solo" } } } as unknown as AiTask).map((c) => c.name)).toEqual(["Solo"]);
  });

  it("characterProblem knows a car's rules, and showFace keeps a car with no face neutral", () => {
    const car = { ...newCar(), name: "Rosso" };
    expect(characterProblem(car)).toBeNull();
    expect(characterProblem({ ...car, name: " " })).toBe("Give your car a name.");
    expect(characterProblem({ ...car, expressions: ["neutral", "happy", "sad"] })).toBe("A car with no face keeps only the neutral face.");
    const eyes: CarInput = { ...car, car: { ...car.car, face: { ...car.car.face, eyes: "headlights" } }, expressions: ["neutral", "happy"] };
    expect(characterProblem(eyes)).toBe("Pick at least 3 faces.");
    expect(characterProblem({ ...eyes, expressions: ["neutral", "happy", "proud"] })).toBeNull();
    expect(characterProblem({ ...car, voice: { ...car.voice, style: "babble" } })).toBe("A car has no voice. Pick its sounds instead.");
    expect(showFace({ ...car, expressions: ["neutral", "happy"] })).toBe("neutral");
    expect(showFace({ ...eyes, expressions: ["neutral", "happy", "proud"] })).toBe("happy");
    const person: CharacterInput = store.characters.find((c) => c.characterId === C.pip)!;
    expect(characterProblem(person)).toBeNull();
  });

  it("the mock refuses what the API refuses", async () => {
    // The mock waits a little like a network: the fake clock moves it on.
    const settle = async <T,>(p: Promise<T>): Promise<T> => {
      const out = p.then((v) => ({ v }), (e: unknown) => ({ e }));
      await vi.advanceTimersByTimeAsync(1000);
      const r = await out;
      if ("e" in r) throw r.e;
      return r.v;
    };
    const refused = async (p: Promise<unknown>) => {
      try {
        await settle(p);
      } catch (e) {
        return e as { status: number; message: string };
      }
      throw new Error("not refused");
    };
    const car = { ...newCar(), name: "Zippy" };
    expect((await refused(api.createCharacter("stories", { ...car, voice: { ...car.voice, style: "hum" } }))).message).toBe("A car has no voice. Pick its sounds instead.");
    expect((await refused(api.createCharacter("stories", { ...car, expressions: ["neutral", "happy", "sad"] }))).message).toBe("A car with no face keeps only the neutral face.");
    expect((await refused(api.designCharacter("stories", { kind: "car" }))).message).toBe("Add a photo of your car, or say what it is like.");
    expect((await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }))).message).toBe("Pick up to 8 photos.");
    expect((await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b"], referenceSides: ["outside"] }))).message).toBe("Say outside or inside for each photo.");
    expect(
      (await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b", "c", "d", "e"], referenceSides: ["inside", "inside", "inside", "inside", "inside"] }))).message,
    ).toBe("Pick up to 6 outside and 4 inside photos.");
    expect((await refused(api.createCharacter("stories", { ...car, kind: "boat" } as never))).message).toBe("Pick a person or a vehicle.");
    expect((await refused(api.designCharacter("stories", { kind: "person", characterId: characters.SEED_CAR_ID, description: "x" }))).message).toBe("Keep the same kind: this character is a car.");
    expect((await refused(api.designCharacter("stories", { description: "x", count: 5 }))).message).toBe("count must be 1 to 4.");
    const made = await settle(api.createCharacter("stories", car));
    expect(made).toMatchObject({ kind: "car", name: "Zippy", voice: { style: "none", pitch: 1 } });
    expect(made.look).toBeUndefined();
  });
});
