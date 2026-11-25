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
import type { CarDetail, CarLook } from "../src/stories/engine/types.ts";
import { matchStories, storiesHref, type StoriesPage } from "../src/stories/routes.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");
const { CarsScreen } = await import("../src/stories/screens/Cars.tsx");
const { LISTED_INFO } = await import("../src/stories/studio/ai.tsx");
const { designOf, designsOf } = await import("../src/stories/studio/Design.tsx");
const { characterProblem, newCar, showFace, seenLine, setDetail, setDetails, toonStep, classicTap, photoShape, CAR_BODY, CAR_WHEELS, CAR_FRONT_LIGHTS, CAR_PATTERN, CAR_EXTRA, PLAIN_CALIPER } = await import("../src/stories/studio/looks.ts");
const { changedParts } = await import("../src/stories/studio/Design.tsx");
const { mergeRedesign } = await import("../src/stories/screens/Characters.tsx");
const { resolveDetail, checkCarDetail } = await import("../src/stories/engine/carDetail.ts");

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
    await pick("Shape", "Van");
    await pick("What are you making?", "A person");
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.textContent).toContain("Start again as a person?");
    expect(sheet.textContent).toContain("Your changes go.");
    await click(control("Keep it", sheet), 50);
    expect(chosen("What are you making?")).toBe("A vehicle");
    expect(chosen("Shape")).toBe("Van");
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
    expect(chosen("Shape")).toBe("Hatchback");
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
    expect(chosen("Shape")).toBe("Pickup");
    await pick("Shape", "Van");
    await pick("What is it?", "Car");
    expect(chosen("Shape")).toBe("Van");
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
    expect(text()).toContain("Add a photo of your vehicle, or say what it is like.");
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
    await pick("Shape", "Van");
    await pick("Wheels", "Off-road");
    await pick("On top", "Roof rack");
    await click(control("Next: Face"), 50);
    expect(text()).toContain("Real vehicles have no face. Add one for fun.");
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
    expect(text()).toContain("Give your vehicle a name.");
    type(field("Name"), "Vanessa");
    await click(control("Save vehicle"));
    const sent = create.mock.calls[0]![1] as CarInput;
    expect(sent).toMatchObject({ kind: "car", name: "Vanessa", car: { body: "van", extra: "roof_rack", wheels: { style: "offroad" }, face: { eyes: "windscreen" } } });
    expect(sent.expressions).toEqual(["neutral", "happy", "surprised"]);
    // A car's page is under Cars.
    expect(location.pathname).toMatch(/^\/stories\/vehicles\/[0-9A-Z]{26}$/);
  });

  it("a saved vehicle's page keeps pictures in Outside and Inside strips, and an inside one added there keeps its side", async () => {
    const upload = vi.spyOn(api, "referenceUpload");
    await show(<CarsScreen {...page({ name: "car", characterId: characters.SEED_CAR_ID })} />);
    const refs = document.querySelector<HTMLElement>("section.st-s-refs--vehicle")!;
    expect(refs).not.toBeNull();
    const strips = Array.from(refs.querySelectorAll<HTMLElement>(".st-s-refs__strip"));
    expect(strips.map((x) => x.querySelector(".st-s-refs__side")?.textContent)).toEqual(["Outside", "Inside"]);
    expect(strips.every((x) => x.classList.contains("st-drop-host"))).toBe(true);
    expect(refs.textContent).toContain("Seats and dashboard. Up to 4.");
    const input = strips[1]!.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [png("dash.png")], configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await wait(4000);
    expect(upload.mock.calls[0]![2]).toEqual({ filename: "dash.png", contentType: "image/png", size: 3000, side: "inside" });
    const saved = store.characters.find((c) => c.characterId === characters.SEED_CAR_ID)!;
    expect(saved.references.filter((r) => r.side === "inside")).toHaveLength(1);
    const inside = Array.from(document.querySelectorAll<HTMLElement>(".st-s-refs__strip"))[1]!;
    expect(inside.querySelectorAll(".st-s-refs__item")).toHaveLength(1);
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
    expect(chosen("Shape")).toBe("Hatchback");
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
    expect(characterProblem({ ...car, name: " " })).toBe("Give your vehicle a name.");
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
    expect((await refused(api.designCharacter("stories", { kind: "car" }))).message).toBe("Add a photo of your vehicle, or say what it is like.");
    expect((await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }))).message).toBe("Pick up to 8 photos.");
    expect((await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b"], referenceSides: ["outside"] }))).message).toBe("referenceSides must be outside or inside, one for each photo.");
    expect(
      (await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b", "c", "d", "e"], referenceSides: ["inside", "inside", "inside", "inside", "inside"] }))).message,
    ).toBe("Pick up to 4 inside photos.");
    expect(
      (await refused(api.designCharacter("stories", { kind: "car", referenceAssetIds: ["a", "b", "c", "d", "e", "f", "g"], referenceSides: ["outside", "outside", "outside", "outside", "outside", "outside", "outside"] }))).message,
    ).toBe("Pick up to 6 photos.");
    expect((await refused(api.designCharacter("stories", { kind: "car", vehicle: "rocket" } as never))).message).toBe("Pick a car, truck, bus, motorbike, plane or boat.");
    expect((await refused(api.designCharacter("stories", { kind: "person", description: "x", referenceAssetIds: ["a"], referenceSides: ["inside"] }))).message).toBe("Inside photos are for a vehicle only.");
    expect((await refused(api.createCharacter("stories", { ...car, kind: "boat" } as never))).message).toBe("Pick a person or a vehicle.");
    expect((await refused(api.designCharacter("stories", { kind: "person", characterId: characters.SEED_CAR_ID, description: "x" }))).message).toBe("Keep the same kind: this character is a car.");
    expect((await refused(api.designCharacter("stories", { description: "x", count: 5 }))).message).toBe("count must be 1 to 4.");
    const made = await settle(api.createCharacter("stories", car));
    expect(made).toMatchObject({ kind: "car", name: "Zippy", voice: { style: "none", pitch: 1 } });
    expect(made.look).toBeUndefined();
  });
});

// ---------- Realistic vehicles (CONTRACTS §45.48): the editor's Drawing tiles, Roof, Cartoon, Brakes, More details ----------

describe("Realistic vehicles in the editor (§45.48)", () => {
  const OPEN_TWO_SEATER = characters.OPEN_TWO_SEATER;
  const label = (list: { value: string; label: string }[], id: string) => list.find((o) => o.value === id)!.label;
  /** The seeded vehicle, made the owner's measured one (a saved vehicle with `detail`), or a plain one. */
  function rosso(car?: CarLook): string {
    const c = store.characters.find((x) => x.characterId === characters.SEED_CAR_ID)!;
    if (car) c.car = structuredClone(car);
    return c.characterId;
  }
  /** Opens the vehicle's page and returns what "Save changes" sends. */
  async function open(characterId = characters.SEED_CAR_ID) {
    const put = vi.spyOn(api, "putCharacter");
    await show(<CharactersScreen {...page({ name: "character", characterId })} />);
    const saved = async () => {
      await click(control("Save changes"), 1500);
      return put.mock.calls.at(-1)![2] as CarInput;
    };
    return { put, saved };
  }
  const groups = () => Array.from(document.querySelectorAll<HTMLElement>('[role="radiogroup"]')).map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim());
  const fold = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.st-s-tech")).find((d) => d.querySelector("summary")?.textContent === "More details");

  it("an old vehicle shows only the Drawing tiles and today's controls, and opening then saving adds no key", async () => {
    rosso();
    const { saved } = await open();
    expect(chosen("Drawing")).toBe("Simple");
    expect(Array.from(group("Drawing").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent)).toEqual(["Simple", "Realistic"]);
    for (const g of ["Roof", "Cartoon", "Brakes", "Brake colour"]) expect(groups()).not.toContain(g);
    expect(fold()).toBeUndefined();
    expect(document.querySelector(".st-s-editor__seen")).toBeNull();
    for (const g of ["Shape", "Pattern", "Windows", "Wheels", "Rims", "Front lights", "Back lights", "On top", "Outline"]) expect(groups()).toContain(g);
    const sent = await saved();
    expect("detail" in sent.car).toBe(false);
  });

  it("Realistic writes {v:1} and shows Roof, Cartoon, Brakes and one closed More details; Roof writes one key", async () => {
    rosso();
    const { saved } = await open();
    await pick("Drawing", "Realistic");
    expect(chosen("Drawing")).toBe("Realistic");
    expect(chosen("Roof")).toBe("Closed");
    expect(Array.from(group("Roof").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent)).toEqual(["Closed", "Open top", "Targa", "Soft top"]);
    expect(Array.from(group("Cartoon").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent)).toEqual(["A little", "Medium", "A lot"]);
    expect(chosen("Cartoon")).toBe("Medium");
    expect(chosen("Brakes")).toBe("Plain");
    expect(groups()).not.toContain("Brake colour");
    expect(fold()).toBeDefined();
    expect(fold()!.open).toBe(false);
    expect(document.querySelectorAll("details.st-s-tech summary")).toHaveLength(1);
    // nothing written by showing it: the switch alone
    expect((await saved()).car.detail).toEqual({ v: 1 });
    await pick("Roof", "Open top");
    expect(chosen("Roof")).toBe("Open top");
    expect((await saved()).car.detail).toEqual({ v: 1, roof: { type: "open" } });
    await pick("Cartoon", "A lot");
    expect((await saved()).car.detail).toEqual({ v: 1, roof: { type: "open" }, toon: 70 });
  });

  it("the Roof pick is for the bodies that can open up: not a van or a bus, and a boat only has Open top", async () => {
    rosso({ ...newCar().car, body: "van", detail: { v: 1 } });
    await open();
    expect(groups()).not.toContain("Roof");
    expect(groups()).toContain("Cartoon");
    await act(async () => root.unmount());
    host.remove();
    rosso({ ...newCar().car, body: "bus", detail: { v: 1 } });
    await open();
    expect(groups()).not.toContain("Roof");
    await act(async () => root.unmount());
    host.remove();
    rosso({ ...newCar().car, body: "boat", detail: { v: 1 } });
    await open();
    expect(Array.from(group("Roof").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent)).toEqual(["Closed", "Open top"]);
    expect(groups()).not.toContain("Cartoon");
    expect(groups()).not.toContain("Brakes");
  });

  it("a classic tap clears the detail key that would hide it, and only that one", async () => {
    rosso(OPEN_TWO_SEATER);
    const { saved } = await open();
    const was = structuredClone(OPEN_TWO_SEATER.detail!);
    await pick("Wheels", label(CAR_WHEELS, "steel"));
    let d = (await saved()).car.detail!;
    expect(d.wheels).toEqual({ tyre: 22, lip: 10 });
    await pick("Front lights", label(CAR_FRONT_LIGHTS, "round"));
    d = (await saved()).car.detail!;
    expect(d.lights).toEqual({ front: { drl: "line" }, rear: { shape: "round" } });
    await pick("Pattern", label(CAR_PATTERN, "plain"));
    d = (await saved()).car.detail!;
    expect(d.stripe).toEqual({ color: "#111111", width: 60 });
    await pick("On top", label(CAR_EXTRA, "spoiler"));
    d = (await saved()).car.detail!;
    expect(d.rear).toEqual({ diffuser: "fins", exhaust: "high" });
    // nothing else moved
    expect(d.profile).toEqual(was.profile);
    expect(d.roof).toEqual(was.roof);
    expect(d.brakes).toEqual(was.brakes);
    // Length, Height and Wheel size multiply and clear nothing
    const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(range).not.toBeNull();
    expect((await saved()).car.detail).toEqual(d);
  });

  it("Shape keeps the photo's outline in detail, says so under the pick, and tapping the photo shape brings it back", async () => {
    rosso(OPEN_TWO_SEATER);
    const { saved } = await open();
    expect(text()).not.toContain("Photo shape:");
    await pick("Shape", label(CAR_BODY, "van"));
    expect(text()).toContain(`Photo shape: ${label(CAR_BODY, "sports")}. Tap it to get it back.`);
    const d = (await saved()).car;
    expect(d.body).toBe("van");
    expect(d.detail).toEqual(OPEN_TWO_SEATER.detail);
    await pick("Shape", label(CAR_BODY, "sports"));
    expect(text()).not.toContain("Photo shape:");
    expect((await saved()).car.body).toBe("sports");
    expect(photoShape({ ...OPEN_TWO_SEATER, body: "suv" })).toBe(label(CAR_BODY, "sports"));
    expect(photoShape(OPEN_TWO_SEATER)).toBeNull();
    expect(photoShape(newCar().car)).toBeNull();
  });

  it("Simple takes the detail off and Realistic gives it back, while the editor is open", async () => {
    rosso(OPEN_TWO_SEATER);
    const { saved } = await open();
    await pick("Drawing", "Simple");
    expect(groups()).not.toContain("Roof");
    expect(document.querySelector(".st-s-editor__seen")).toBeNull();
    const plain = (await saved()).car;
    expect("detail" in plain).toBe(false);
    await pick("Drawing", "Realistic");
    expect(chosen("Roof")).toBe("Open top");
    expect((await saved()).car.detail).toEqual(OPEN_TWO_SEATER.detail);
  });

  it("Brakes: Plain or Coloured, with a Brake colour that starts on the vehicle's own", async () => {
    rosso(OPEN_TWO_SEATER);
    const { saved } = await open();
    expect(chosen("Brakes")).toBe("Coloured");
    expect(group("Brake colour").querySelector<HTMLInputElement>("input:checked")?.value).toBe("#ffd21f");
    expect(Array.from(group("Brake colour").querySelectorAll(".st-s-sr")).map((x) => x.textContent).filter(Boolean)).toEqual(["Red", "Yellow", "Blue", "Silver", "Black"]);
    await click(group("Brake colour").querySelector<HTMLInputElement>('input[value="#2f6fb5"]')!, 50);
    expect((await saved()).car.detail!.brakes).toEqual({ disc: "ceramic", caliper: "#2f6fb5" });
    await pick("Brakes", "Plain");
    expect(groups()).not.toContain("Brake colour");
    expect((await saved()).car.detail!.brakes).toEqual({ disc: "ceramic", caliper: PLAIN_CALIPER });
    await pick("Brakes", "Coloured");
    expect(group("Brake colour").querySelector<HTMLInputElement>("input:checked")?.value).toBe("#c8102e");
    expect((await saved()).car.detail!.brakes).toEqual({ disc: "ceramic", caliper: "#c8102e" });
  });

  it("a plain hatchback starts on Plain brakes; Plain on it writes nothing it does not need", async () => {
    rosso({ ...newCar().car, detail: { v: 1 } });
    const { saved } = await open();
    expect(chosen("Brakes")).toBe("Plain");
    await pick("Brakes", "Coloured");
    expect((await saved()).car.detail!.brakes).toEqual({ caliper: "#c8102e" });
    await pick("Brakes", "Plain");
    expect((await saved()).car.detail).toEqual({ v: 1 });
  });

  it("More details has the nine picks with the words of the rules table, and each writes its own key", async () => {
    rosso(OPEN_TWO_SEATER);
    const { saved } = await open();
    const inside = Array.from(fold()!.querySelectorAll<HTMLElement>('[role="radiogroup"]')).map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim());
    expect(inside).toEqual(["Wheel design", "Front lamp", "Rear lamp", "Nose", "Sides", "Tail", "Stripes", "Finish"]);
    expect(fold()!.textContent).toContain("Extras");
    expect(chosen("Finish")).toBe("Satin");
    await pick("Finish", "Matte");
    await pick("Wheel design", "Mesh");
    await pick("Tail", "Four");
    await pick("Stripes", "Twin");
    await pick("Sides", "Gills");
    await pick("Nose", "Mesh");
    await pick("Front lamp", "Stacked");
    await pick("Rear lamp", "Wide");
    const d = (await saved()).car.detail!;
    expect(d.finish).toBe("matte");
    expect(d.wheels).toMatchObject({ shape: "mesh", spokes: 5 });
    expect(d.rear).toMatchObject({ exhaust: "quad" });
    expect(d.stripe).toMatchObject({ layout: "twin" });
    expect(d.side).toMatchObject({ intake: "gill" });
    expect(d.front).toMatchObject({ grille: "mesh" });
    expect(d.lights).toMatchObject({ front: { shape: "stacked" }, rear: { shape: "rect" } });
    const problems: string[] = [];
    checkCarDetail(d, "car", (m) => problems.push(m));
    expect(problems).toEqual([]);
  });

  it("Extras are chips, up to 6; a seventh waits until one is turned off", async () => {
    const six = ["bull_bar", "spare_wheel", "roof_rails", "antenna", "snorkel", "light_bar"] as const;
    rosso({ ...newCar().car, body: "suv", detail: { v: 1, extras: [...six] } });
    const { saved } = await open();
    const chips = () => Array.from(fold()!.querySelectorAll<HTMLButtonElement>(".st-s-chips button"));
    expect(chips().filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(6);
    const seventh = chips().find((b) => b.textContent === "Mudflaps")!;
    expect(seventh.getAttribute("aria-disabled")).toBe("true");
    await click(seventh, 50);
    expect(seventh.getAttribute("aria-pressed")).toBe("false");
    await click(chips().find((b) => b.textContent === "Antenna")!, 50);
    await click(chips().find((b) => b.textContent === "Mudflaps")!, 50);
    expect((await saved()).car.detail!.extras).toEqual(["bull_bar", "spare_wheel", "roof_rails", "snorkel", "light_bar", "mudflaps"]);
  });

  it("says what it saw in one soft line under the name: labels only, four items at most", async () => {
    rosso(OPEN_TWO_SEATER);
    await open();
    expect(document.querySelector(".st-s-editor__seen")?.textContent).toBe("Open top · Centre stripe · Yellow brakes · 5 double spokes");
    expect(seenLine(OPEN_TWO_SEATER)).toBe("Open top · Centre stripe · Yellow brakes · 5 double spokes");
    expect(seenLine(newCar().car)).toBe("");
    expect(seenLine({ ...newCar().car, detail: { v: 1 } })).toBe("5 spokes");
    const busy: CarDetail = { v: 1, roof: { type: "targa" }, stripe: { layout: "side" }, brakes: { caliper: "#c8102e" }, wheels: { shape: "turbine", spokes: 9 }, lights: { front: { shape: "swept" } }, finish: "matte", rear: { spoiler: "wing" } };
    expect(seenLine({ ...newCar().car, detail: busy }).split(" · ")).toEqual(["Targa", "Side stripe", "Red brakes", "9 fan blades"]);
    // labels and colour names only: plain words, and a number only for the spokes
    expect(seenLine(OPEN_TWO_SEATER).split(" · ").every((item) => /^(\d+ )?[A-Za-z ]+$/.test(item))).toBe(true);
  });

  it("Try a move has Front and Rear after the moves, and each shows on the stage", async () => {
    rosso();
    await open();
    await click(control("Next: Face"), 50);
    await click(control("Next: Moves"), 50);
    const labels = Array.from(group("Try a move").querySelectorAll(".st-s-pick__label")).map((l) => l.textContent);
    expect(labels.slice(-3)).toEqual(["Stall", "Front", "Rear"]);
    expect(labels).not.toContain("Back");
    await pick("Try a move", "Front");
    expect(document.querySelector(".st-s-editor__now")?.textContent).toContain("Front");
    expect(document.querySelector("canvas.st-car-preview[role='img']")?.getAttribute("aria-label")).toBe("Rosso, Front");
    await pick("Try a move", "Rear");
    expect(document.querySelector("canvas.st-car-preview[role='img']")?.getAttribute("aria-label")).toBe("Rosso, Rear");
    await pick("Try a move", "Drive");
    expect(document.querySelector("canvas.st-car-preview[role='img']")?.getAttribute("aria-label")).toBe("Rosso, Drive");
  });

  it("a redesign says Looks details and Looks inside, and Use this takes the new detail whole", () => {
    const now = { ...newCar(), name: "Rosso" };
    const next: CarInput = { ...now, car: { ...now.car, detail: OPEN_TWO_SEATER.detail, interior: { seat: "#3a3f4b", dash: "#23262e" } } };
    const { changed } = changedParts(now, next);
    expect(changed.find((c) => c.part === "looks")?.detail).toBe("details, inside");
    expect(changedParts(now, now).changed).toEqual([]);
    expect(changedParts(next, { ...next, car: { ...next.car, detail: { ...OPEN_TWO_SEATER.detail!, finish: "matte" as const } } }).changed[0]!.detail).toBe("details");
    // the owner's own unsaved paint stays; the detail goes in whole
    const mine: CarInput = { ...now, car: { ...now.car, paint: "#2f6fb5" } };
    const merged = mergeRedesign(mine, now, next) as CarInput;
    expect(merged.car.paint).toBe("#2f6fb5");
    expect(merged.car.detail).toEqual(OPEN_TWO_SEATER.detail);
    // a redesign that drops the detail takes the key away (not leaves it empty)
    const back = mergeRedesign(merged, next, now) as CarInput;
    expect("detail" in back.car).toBe(false);
    // a redesign that changes nothing in detail leaves the owner's detail alone
    const kept: CarInput = { ...next, car: { ...next.car, detail: { ...OPEN_TWO_SEATER.detail!, finish: "gloss" as const } } };
    expect((mergeRedesign(kept, next, { ...next, car: { ...next.car, paint: "#d8352a" } }) as CarInput).car.detail!.finish).toBe("gloss");
  });

  it("the practice design: photos alone give the measured vehicle first, words and Make more do not", async () => {
    const [first, second] = characters.designCars("", 3, 0, 3, [], []);
    expect(first!.car).toEqual(OPEN_TWO_SEATER);
    expect(second!.car.detail).toBeUndefined();
    expect(characters.designCars("my red hatchback", 1, 0, 3, [], [])[0]!.car.detail).toBeUndefined();
    expect(characters.designCars("", 3, 0, 3, [first!.car], [])[0]!.car.detail).toBeUndefined();
    expect(characters.designCars("", 0, 0, 3, [], [])[0]!.car.detail).toBeUndefined();
    expect(characters.designCars("", 3, 0, 3, [], [], null, "bus")[0]!.car.detail).toBeUndefined();
    const mine = { ...newCar(), name: "Rosso" };
    expect(characters.designCars("", 3, 0, 3, [], [], mine).every((c) => c.car.detail === undefined)).toBe(true);
    expect(first!.description).toBe("A grey sports car.");
    // Rosso, the seeded vehicle, stays without one
    expect(store.characters.find((c) => c.characterId === characters.SEED_CAR_ID)!.car!.detail).toBeUndefined();
    // a designed vehicle with detail is one the mock accepts, and its sentence reads fine in the editor
    const problems: string[] = [];
    checkCarDetail(first!.car.detail, "car", (m) => problems.push(m));
    expect(problems).toEqual([]);
    expect(resolveDetail(first!.car).open).toBe(true);
  });

  it("the pure helpers: setDetail prunes empty groups, toonStep is the nearest step, classicTap leaves a plain vehicle alone", () => {
    const d: CarDetail = { v: 1, wheels: { shape: "y", spokes: 7 }, stripe: { layout: "centre" } };
    expect(setDetail(d, "wheels.shape", undefined)).toEqual({ v: 1, wheels: { spokes: 7 }, stripe: { layout: "centre" } });
    expect(setDetails(d, [["wheels.shape", undefined], ["wheels.spokes", undefined]])).toEqual({ v: 1, stripe: { layout: "centre" } });
    expect(setDetail({ v: 1 }, "lights.front.shape", "swept")).toEqual({ v: 1, lights: { front: { shape: "swept" } } });
    expect(setDetail({ v: 1 }, "lights.front.shape", undefined)).toEqual({ v: 1 });
    expect(setDetail(d, "toon", 70)).toEqual({ ...d, toon: 70 });
    expect(d).toEqual({ v: 1, wheels: { shape: "y", spokes: 7 }, stripe: { layout: "centre" } });
    expect([0, 10, 14, 16, 30, 49, 51, 70, 100].map(toonStep)).toEqual(["little", "little", "little", "medium", "medium", "medium", "lot", "lot", "lot"]);
    const plain = newCar().car;
    expect(classicTap(plain, { extra: "spoiler" }, ["rear.spoiler"])).toEqual({ extra: "spoiler" });
    expect("detail" in classicTap(plain, { extra: "spoiler" }, ["rear.spoiler"])).toBe(false);
    // the dull grey the Plain brakes write is the engine's own default
    expect(resolveDetail({ ...plain, detail: { v: 1 } }).brakes.caliper).toBe(PLAIN_CALIPER);
  });

  it("the mock refuses what the API refuses about detail: an unknown key, a float, a half profile, a seventh extra", async () => {
    const settle = async <T,>(p: Promise<T>): Promise<T> => {
      const out = p.then((v) => ({ v }), (e: unknown) => ({ e }));
      await vi.advanceTimersByTimeAsync(1000);
      const r = await out;
      if ("e" in r) throw r.e;
      return r.v;
    };
    let n = 0;
    const message = async (car: unknown) => {
      try {
        await settle(api.createCharacter("stories", { ...newCar(), name: `Zippy ${(n += 1)}`, car } as CharacterInput));
      } catch (e) {
        return (e as { status: number; message: string }).message;
      }
      return "accepted";
    };
    const base = newCar().car;
    expect(await message({ ...base, detail: OPEN_TWO_SEATER.detail })).toBe("accepted");
    expect(await message({ ...base, detail: { v: 1 } })).toBe("accepted");
    expect(await message({ ...base, wings: 2 })).toBe("Unknown field: car.wings.");
    expect(await message({ ...base, detail: { v: 1, horn: "loud" } })).toBe("Unknown field: car.detail.horn.");
    expect(await message({ ...base, detail: { v: 1, toon: 1.5 } })).toMatch(/^car\.detail\.toon is 1\.5; use a whole number from 0 to 100\.$/);
    expect(await message({ ...base, detail: { v: 2 } })).toBe("accepted");
    expect(await message({ ...base, detail: { v: 1, profile: { body: "sports", lh: 379 } } })).toMatch(/needs all of its numbers/);
    expect(await message({ ...base, detail: { v: 1, extras: ["antenna", "antenna"] } })).toMatch(/^car\.detail\.extras is /);
    expect(await message({ ...base, detail: { v: 1, finish: "shiny" } })).toMatch(/^car\.detail\.finish is "shiny"; use one of /);
    expect(await message({ ...base, detail: { v: 1, stripe: { color: "#FFAA00" } } })).toMatch(/^car\.detail\.stripe\.color is /);
  });

  it("a new vehicle starts Simple, and Design it's detailed first option opens Realistic with its seen line", async () => {
    await show(<CharactersScreen {...page({ name: "character_new", kind: "car" })} />);
    expect(chosen("Drawing")).toBe("Simple");
    await addFiles([png("front.png"), png("side.png")]);
    await wait(4000);
    await click(control("Design it"), 250);
    await untilTask();
    // the editor opens on the name to check; Looks has the new drawing
    await pick("Make your vehicle", "Looks");
    expect(chosen("Drawing")).toBe("Realistic");
    expect(chosen("Roof")).toBe("Open top");
    expect(document.querySelector(".st-s-editor__seen")?.textContent).toBe("Open top · Centre stripe · Yellow brakes · 5 double spokes");
    // the second option is a plain one: tapping it takes the detail away
    await click(cards()[1]!.querySelector("input") as HTMLElement, 50);
    await pick("Make your vehicle", "Looks");
    expect(chosen("Drawing")).toBe("Simple");
  });
});
