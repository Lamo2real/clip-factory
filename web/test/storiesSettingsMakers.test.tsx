// Lamo Stories › Settings, the makers' models and the keyed hosts (docs/CONTRACTS.md §45.37 G1 to G4, G7; request 2
// §5 "Image-generation models. Video-generation models. Audio-generation models … allow me to select these providers
// and models independently", §3 "support adding new models and providers without rebuilding the application"),
// against the in-memory API:
// - G1: each maker's models come from stories/config/models.json's lists (an older file's imageModel and videoModel
//   read as one-item lists), with the lead's keys and AWS's own model ids; each maker's model is picked and checked on
//   save (a key of that maker, null for its first that has not ended; an ended one is refused, never called);
// - G2: the owner adds picture, video and sound models (MAKERDEF#): the rules per kind and host, at most 20 per kind,
//   never a bundled key, Remove refused while Settings › Video picks it (409, the API's sentence shown), and Check
//   models' free access check (Works, No access, Not found in the provider's own words);
// - G4: Settings › AI › Add a model has a Host picker (Amazon Bedrock, Anthropic, an OpenAI-compatible service) and a
//   base URL; a model on a keyed host has no Region and uses the owner's key from Provider keys.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import type { MakerModelDef, ModelDef, StoriesApi, StoriesConfig } from "../src/stories/api/types.ts";
import { endedWords, fileMakerModels, hasMakerLists, regionWords } from "../src/stories/settings/makerFile.ts";
import { baseUrlProblem, makerDefOf } from "../src/stories/settings/MakerModels.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");

let host: HTMLElement;
let root: Root;
let api: StoriesApi;
let calls: { name: string; args: unknown[] }[];

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20, tryMs: 0, ...knobs } };
  const real = mockStoriesApi();
  api = new Proxy(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
    get(target, key: string) {
      const fn = target[key]!;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return fn(...args);
      };
    },
  }) as unknown as StoriesApi;
  setStoriesApi(api);
}

async function open(section: "ai" | "video") {
  forgetLoaded();
  await act(async () =>
    root.render(
      <ToastProvider>
        <SettingsScreen key={`${section}${Math.random()}`} ws="stories" page={{ name: "settings", section }} />
      </ToastProvider>,
    ),
  );
  await settle(8);
}
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => Array.from(from.querySelectorAll<T>(sel));
function byText<T extends HTMLElement = HTMLElement>(sel: string, text: string | RegExp, from: ParentNode = document): T {
  const el = $$<T>(sel, from).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
  if (!el) throw new Error(`no ${sel} with ${String(text)}; have: ${$$(sel, from).map((e) => e.textContent?.trim()).join(" | ")}`);
  return el;
}
async function click(el: Element) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
function fill(form: HTMLElement, label: string, value: string) {
  const l = $$("label", form).find((x) => x.textContent === label);
  const el = (l ? form.querySelector(`#${CSS.escape((l as HTMLLabelElement).htmlFor)}`) : null) ?? $$<HTMLSelectElement>("select", form).find((s) => s.getAttribute("aria-label") === label);
  if (!el) throw new Error(`no field ${label}`);
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const card = (title: string) => byText<HTMLElement>(".st-stg-card", new RegExp(`^${title}`));
const submit = async (form: HTMLElement) => {
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle(8);
};
const lastBody = (name: string) => calls.filter((c) => c.name === name).at(-1)?.args[2];
async function patch(configuration: Partial<StoriesConfig>) {
  const w = await api.getWorkspace("stories");
  return api.patchWorkspace("stories", { configuration, version: w.version });
}
const pick = (images: string, extra: Partial<StoriesConfig["providers"]> = {}) => ({ providers: { images, video: "builtin-2d", audio: "builtin-synth", ...extra } }) as Partial<StoriesConfig>;

beforeEach(() => {
  calls = [];
  localStorage.clear();
  resetWorkspaceMemory();
  setMockLatency(0);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
  vi.useRealTimers();
});

describe("the makers' models in stories/config/models.json (§45.37 G1)", () => {
  it("an older file's imageModel and videoModel read as one-item lists, both ended by Amazon", () => {
    const old = {
      imageModel: { label: "Amazon Nova Canvas", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-canvas-v1:0", region: "eu-west-1", pricing: null },
      videoModel: { label: "Amazon Nova Reel 1.1", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-reel-v1:1", region: "us-east-1", pricing: null },
    };
    expect(hasMakerLists(old)).toBe(false);
    expect(fileMakerModels(undefined, old)).toEqual([
      { key: "nova-canvas", label: "Amazon Nova Canvas", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-canvas-v1:0", region: "eu-west-1", kind: "image", price: null, note: "", maker: "nova-canvas", ended: "2026-09-30" },
      { key: "nova-reel", label: "Amazon Nova Reel 1.1", provider: "Amazon", host: "Amazon Bedrock", modelId: "amazon.nova-reel-v1:1", region: "us-east-1", kind: "video", price: null, note: "", maker: "nova-reel", ended: "2026-09-30" },
    ]);
    expect(fileMakerModels("audio", old)).toEqual([]);
  });

  it("the lists win over the old mirrors, kind by kind, with each entry's maker, price and end day", () => {
    const file = {
      imageModel: { label: "Old", modelId: "x" },
      imageModels: [{ key: "stable-image-core", label: "Stable Image Core", provider: "Stability AI", host: "Amazon Bedrock", modelId: "stability.stable-image-core-v1:1", region: "us-west-2", price: { perUnit: 0.04, unit: "image", currency: "USD" }, note: "", maker: "stability" }],
      audioModels: [{ key: "polly-neural", label: "Amazon Polly neural voices", provider: "Amazon", host: "Amazon Polly", modelId: "neural", region: "eu-west-1", price: null, note: "", maker: "polly" }],
    };
    expect(hasMakerLists(file)).toBe(true);
    expect(fileMakerModels(undefined, file).map((m) => [m.key, m.kind, m.maker, m.price?.perUnit ?? null])).toEqual([
      ["stable-image-core", "image", "stability", 0.04],
      ["polly-neural", "audio", "polly", null],
    ]);
  });

  it("says the end day and where a model runs in plain words", () => {
    expect(endedWords("2026-09-30")).toBe("Ended by Amazon on 30 Sep 2026");
    expect(endedWords(null)).toBeNull();
    expect(regionWords("us-west-2")).toBe("Runs in the US (Oregon)");
    expect(regionWords("eu-west-1")).toBe("Runs in Europe (Ireland)");
    expect(regionWords("")).toBeNull();
  });

  it("the API lists the lead's bundled keys with AWS's own model ids, prices unknown, the built-ins staying the default", async () => {
    start();
    const models = await api.makerModels("stories");
    // In the file's order (the maker rows list them maker by maker, so they are put back in the file's order here).
    const order = ["nova-canvas", "stable-image-core", "stable-image-ultra", "sd3-5-large", "nova-reel", "luma-ray2", "polly-neural", "elevenlabs-effects", "elevenlabs-music"];
    const bundled = models.filter((m) => !m.custom).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    expect(bundled.map((m) => m.key).sort()).toEqual([...order].sort());
    // Who runs each, as the API names it: a keyed host by its label.
    expect(bundled.filter((m) => m.maker === "elevenlabs").map((m) => [m.host, m.hostId])).toEqual([["ElevenLabs", "elevenlabs"], ["ElevenLabs", "elevenlabs"]]);
    expect(bundled.map((m) => [m.key, m.kind, m.maker, m.modelId, m.region, m.ended ?? null])).toEqual([
      ["nova-canvas", "image", "nova-canvas", "amazon.nova-canvas-v1:0", "eu-west-1", "2026-09-30"],
      ["stable-image-core", "image", "stability", "stability.stable-image-core-v1:1", "us-west-2", null],
      ["stable-image-ultra", "image", "stability", "stability.stable-image-ultra-v1:1", "us-west-2", null],
      ["sd3-5-large", "image", "stability", "stability.sd3-5-large-v1:0", "us-west-2", null],
      ["nova-reel", "video", "nova-reel", "amazon.nova-reel-v1:1", "us-east-1", "2026-09-30"],
      ["luma-ray2", "video", "luma-ray", "luma.ray-v2:0", "us-west-2", null],
      ["polly-neural", "audio", "polly", "neural", "eu-west-1", null],
      ["elevenlabs-effects", "audio", "elevenlabs", "eleven_text_to_sound_v2", null, null],
      ["elevenlabs-music", "audio", "elevenlabs", "music_v1", null, null],
    ]);
    expect(bundled.every((m) => m.price === null)).toBe(true);
    // Nothing is shown as working because it is listed.
    expect(bundled.filter((m) => !m.ended).every((m) => m.status === "not_checked")).toBe(true);
    // An ended model is never checked (the API's makers.model_info): final, "Not found" with its end day in words, never
    // "tap Check models".
    expect(models.find((m) => m.key === "nova-canvas")).toMatchObject({ status: "not_found", statusLine: "Ended by Amazon on 30 Sep 2026.", endedLine: "Ended by Amazon on 30 Sep 2026", checkedAt: null });
    expect(models.filter((m) => m.ended).every((m) => !/Check models/.test(m.statusLine))).toBe(true);
    expect(models.find((m) => m.key === "luma-ray2")?.regionLine).toBe("Runs in the US (Oregon)");
    const w = await api.getWorkspace("stories");
    expect((w.configuration as StoriesConfig).providers).toMatchObject({ images: "builtin-rig", video: "builtin-2d", audio: "builtin-synth" });
  });

  it("each maker's model is one of that maker's, null for its first; an ended one, or another maker's, is refused", async () => {
    start();
    expect(((await patch(pick("stability", { imageModel: "sd3-5-large" }))).configuration as StoriesConfig).providers).toMatchObject({ images: "stability", imageModel: "sd3-5-large" });
    expect(((await patch(pick("stability", { imageModel: null }))).configuration as StoriesConfig).providers.imageModel).toBeNull();
    await expect(patch(pick("stability", { imageModel: "luma-ray2" }))).rejects.toMatchObject({ status: 400, field: "providers" });
    await expect(patch(pick("builtin-rig", { imageModel: "stable-image-core" }))).rejects.toMatchObject({ status: 400, field: "providers" });
    await expect(patch(pick("stability", { audio: "elevenlabs", audioModel: "polly-neural" }))).rejects.toMatchObject({ status: 400, field: "providers" });
    await expect(patch(pick("own-images"))).rejects.toMatchObject({ status: 400, message: "Add your own picture model in Settings › Video first." });
    // The spoken voice is only there when the owner picks it.
    expect(((await patch(pick("builtin-rig", { audio: "polly" }))).configuration as StoriesConfig).providers.audio).toBe("polly");
  });
});

describe("the owner's own picture, video and sound models (§45.37 G2)", () => {
  const rain: MakerModelDef = { label: "Rain sounds", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", price: null, note: "" };

  it("takes each kind only where it runs, a public https address, a Region only on Amazon Bedrock, and Amazon's or Stability AI's picture ids", async () => {
    start();
    const put = (key: string, def: Partial<MakerModelDef> & Record<string, unknown>) => api.putMakerModel("stories", key, { ...rain, ...def } as MakerModelDef);
    await expect(put("rain", {})).rejects.toMatchObject({ status: 400, field: "key" });
    await expect(put("custom-RAIN", {})).rejects.toMatchObject({ status: 400, field: "key" });
    // Never shadowing a bundled key, nor a model added in Settings › AI.
    await expect(put("luma-ray2", {})).rejects.toMatchObject({ status: 400, field: "key" });
    await expect(put("custom-x", { kind: "video", host: "elevenlabs" })).rejects.toMatchObject({ status: 400, message: "Video models run on Amazon Bedrock only.", field: "host" });
    await expect(put("custom-x", { kind: "audio", host: "openai_compatible", baseUrl: "https://api.example.com/v1" })).rejects.toMatchObject({ status: 400, field: "host" });
    await expect(put("custom-x", { kind: "image", host: "anthropic" as never })).rejects.toMatchObject({ status: 400, field: "host" });
    await expect(put("custom-x", { kind: "image", host: "bedrock", modelId: "meta.llama-image-v1:0", region: "us-west-2" })).rejects.toMatchObject({ status: 400, field: "modelId" });
    await expect(put("custom-x", { region: "us-west-2" })).rejects.toMatchObject({ status: 400, message: "Only a model on Amazon Bedrock has a Region. Leave the Region out.", field: "region" });
    await expect(put("custom-x", { kind: "video", host: "bedrock", modelId: "luma.ray-v2:0" })).rejects.toMatchObject({ status: 400, field: "region" });
    for (const baseUrl of ["http://api.example.com/v1", "https://169.254.169.254/latest", "https://localhost/v1", "https://10.0.0.8/v1", "https://user:pw@api.example.com/v1", "https://api.example.com/v1?key=1", "https://printer.local/v1"])
      await expect(put("custom-x", { kind: "image", host: "openai_compatible", modelId: "my-picture-model", baseUrl }), baseUrl).rejects.toMatchObject({ status: 400, field: "baseUrl" });
    await expect(put("custom-x", { baseUrl: "https://api.example.com/v1" })).rejects.toMatchObject({ status: 400, field: "baseUrl" });
    const picture = await put("custom-paint", { label: "Paint", provider: "Acme", kind: "image", host: "openai_compatible", modelId: "paint-2", baseUrl: "https://api.example.com/v1/" });
    // The API's MakerModelInfo: no key state on the model (GET …/providers' `key` says it, §45.37 G4).
    expect(picture).toMatchObject({ key: "custom-paint", kind: "image", hostId: "openai_compatible", host: "api.example.com", baseUrl: "https://api.example.com/v1", region: null, custom: true, maker: "own-images", status: "not_checked" });
    expect(picture).not.toHaveProperty("keySaved");
    const video = await put("custom-ray", { label: "My Ray", provider: "Luma AI", kind: "video", host: "bedrock", modelId: "luma.ray-v2:0", region: "us-west-2" });
    expect(video).toMatchObject({ hostId: "bedrock", host: "Amazon Bedrock", region: "us-west-2", maker: "own-video" });
    const sound = await put("custom-rain", {});
    expect(sound).toMatchObject({ hostId: "elevenlabs", maker: "own-sound", statusLine: "Not checked yet. Tap Check models to see if it works." });
    // Where the screens read the models and the key from: the maker rows of GET …/providers.
    const rows = await api.providers("stories");
    expect(rows.find((r) => r.id === "own-sound")?.models?.map((m) => m.key)).toEqual(["custom-rain"]);
    expect(rows.find((r) => r.id === "own-images")?.models?.map((m) => m.key)).toEqual(["custom-paint"]);
    expect(rows.find((r) => r.id === "builtin-synth")).not.toHaveProperty("models");
    expect(rows.find((r) => r.id === "elevenlabs")?.key?.saved).toBe(false);
    expect(rows.find((r) => r.id === "openai_compatible")?.key?.saved).toBe(false);
  });

  it("at most 20 of each kind; Remove is refused while Settings › Video picks it, and a bundled one is never removed", async () => {
    start();
    for (let i = 0; i < 20; i++) await api.putMakerModel("stories", `custom-s${i}`, { ...rain, label: `Sound ${i}` });
    await expect(api.putMakerModel("stories", "custom-s20", { ...rain, label: "Sound 20" })).rejects.toMatchObject({ status: 409, message: "You can add at most 20 sound models. Remove one first." });
    // Another kind still has room.
    await api.putMakerModel("stories", "custom-v0", { label: "V0", provider: "Luma AI", kind: "video", host: "bedrock", modelId: "luma.ray-v2:0", region: "us-west-2", price: null, note: "" });
    await patch(pick("builtin-rig", { audio: "own-sound", audioModel: "custom-s3" }));
    await expect(api.deleteMakerModel("stories", "custom-s3")).rejects.toMatchObject({ status: 409, message: "Sound 3 is picked as the sound model in Settings › Video. Pick another model there first, then remove it." });
    // An added model keeps what it makes, picked or not (the API's KIND_FIXED).
    const fixed = "A model you added keeps what it makes. Remove it and add it again as another kind.";
    await expect(api.putMakerModel("stories", "custom-s3", { ...rain, label: "Sound 3", kind: "image", host: "openai_compatible", baseUrl: "https://api.example.com/v1" })).rejects.toMatchObject({ status: 400, message: fixed, field: "kind" });
    await expect(api.putMakerModel("stories", "custom-s5", { ...rain, label: "Sound 5", kind: "image", host: "openai_compatible", baseUrl: "https://api.example.com/v1" })).rejects.toMatchObject({ status: 400, message: fixed, field: "kind" });
    await expect(api.deleteMakerModel("stories", "stable-image-core")).rejects.toMatchObject({ status: 409 });
    await expect(api.deleteMakerModel("stories", "custom-s4")).resolves.toBeUndefined();
    // Two models may share a name, as in the API (the key tells them apart).
    await expect(api.putMakerModel("stories", "custom-s4b", { ...rain, label: "Sound 5" })).resolves.toMatchObject({ key: "custom-s4b", label: "Sound 5" });
    await expect(api.deleteMakerModel("stories", "custom-s4b")).resolves.toBeUndefined();
    await patch(pick("builtin-rig", { audio: "builtin-synth" }));
    await expect(api.deleteMakerModel("stories", "custom-s3")).resolves.toBeUndefined();
    expect((await api.makerModels("stories")).filter((m) => m.custom && m.kind === "audio")).toHaveLength(18);
  });

  it("Check models checks them for free: Works, No access or Not found, in the provider's own words", async () => {
    start({ makerDenied: "stable-image-ultra", bedrockUnknown: "custom-ray" });
    await api.putMakerModel("stories", "custom-ray", { label: "My Ray", provider: "Luma AI", kind: "video", host: "bedrock", modelId: "luma.ray-v9:0", region: "us-west-2", price: null, note: "" });
    await api.putMakerModel("stories", "custom-rain", rain);
    const task = await api.checkModels("stories", undefined, ["stable-image-core", "stable-image-ultra", "polly-neural", "custom-ray", "custom-rain"]);
    expect(task.kind).toBe("check_models");
    await new Promise((r) => setTimeout(r, 60));
    const done = await api.getTask("stories", task.taskId);
    expect(done.status).toBe("done");
    expect(done.result?.models).toEqual([]);
    const by = Object.fromEntries((await api.makerModels("stories")).map((m) => [m.key, [m.status, m.statusLine]]));
    expect(by["stable-image-core"]).toEqual(["ok", "Amazon Bedrock says this account may use it."]);
    expect(by["stable-image-ultra"]![0]).toBe("denied");
    expect(by["stable-image-ultra"]![1]).toContain("Amazon Bedrock said this account has no access to Stable Image Ultra.");
    expect(by["polly-neural"]![0]).toBe("ok");
    expect(by["custom-ray"]).toEqual(["not_found", "Amazon Bedrock said: The provided model identifier is invalid (luma.ray-v9:0 in us-west-2). Check the model ID and its Region, then tap Check models."]);
    expect(by["custom-rain"]).toEqual(["denied", "There is no key for ElevenLabs yet. Paste it under Provider keys, then tap Check models."]);
    // A maker check is not a check of the AI models (setup step 1 does not tick from it).
    expect(calls.filter((c) => c.name === "checkModels").at(-1)?.args).toEqual(["stories", undefined, ["stable-image-core", "stable-image-ultra", "polly-neural", "custom-ray", "custom-rain"]]);
    await expect(api.checkModels("stories", undefined, ["nope"])).rejects.toMatchObject({ status: 400, field: "makers" });
  });

  it("the form's rules in plain words before anything is sent", () => {
    const d = { kind: "image" as const, host: "openai_compatible" as const, label: "Paint", provider: "Acme", modelId: "paint-2", region: "us-west-2", otherRegion: "", baseUrl: "http://api.example.com", priced: false, price: "", currency: "USD", note: "" };
    expect(makerDefOf(d)).toEqual({ problem: "The address must start with https:// so the key travels safely." });
    expect(makerDefOf({ ...d, baseUrl: "https://api.example.com/v1/" })).toEqual({ label: "Paint", provider: "Acme", kind: "image", host: "openai_compatible", modelId: "paint-2", baseUrl: "https://api.example.com/v1", price: null, note: "" });
    expect(makerDefOf({ ...d, kind: "video" })).toMatchObject({ problem: expect.stringMatching(/cannot make video/) });
    expect(makerDefOf({ ...d, host: "bedrock", modelId: "stability.sd3-5-large-v1:0", priced: true, price: "0,08" })).toEqual({ label: "Paint", provider: "Acme", kind: "image", host: "bedrock", modelId: "stability.sd3-5-large-v1:0", region: "us-west-2", price: { perUnit: 0.08, unit: "image", currency: "USD" }, note: "" });
    expect(baseUrlProblem("https://intranet/v1")).toMatch(/not on the public internet/);
    expect(baseUrlProblem("https://api.example.com/v1")).toBeNull();
  });

  it("Settings › Video: add a sound model, pick it as the Sound maker, Remove says why it stays, Check models says its state", async () => {
    start();
    await open("video");
    const box = () => card("Add a picture, video or sound model");
    expect(box().textContent).toContain("No models added yet.");
    await click(byText("button", /Add a model/, box()));
    const form = $<HTMLElement>('form[aria-label="Add a picture, video or sound model"]')!;
    await click(byText("[role=radio]", /^Sound/, form));
    expect(form.textContent).toContain("Sound models make sound effects and music only. Lamo Stories never asks them for a voice.");
    // Sound runs on ElevenLabs only (the owner's key): Amazon Bedrock has no sound or music model (the API's NO_BEDROCK_SOUND).
    expect($$("[role=radio]", $<HTMLElement>('[aria-label="Where it runs"]', form)!).map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["ElevenLabs"]);
    expect($$("select", form).some((s) => s.getAttribute("aria-label") === "AWS Region")).toBe(false);
    fill(form, "Name", "Rain sounds");
    fill(form, "Model name", "eleven_text_to_sound_v2");
    await submit(form);
    expect(lastBody("putMakerModel")).toEqual({ label: "Rain sounds", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", price: null, note: "" });
    const row = byText(".st-stg-own", /Rain sounds/, box());
    expect(row.textContent).toContain("Added by you");
    expect(row.textContent).toContain("Sound");
    expect(row.textContent).toContain("Paste your ElevenLabs key under Prices and keys below, then tap Check models above.");
    expect(box().textContent).toContain("Rain sounds is listed, but it has not been checked yet.");
    // Now the owner's own sound maker can be picked, and it uses that model.
    const own = byText("[role=radio]", /Your own sound model/, card("Sound maker"));
    expect(own.getAttribute("aria-disabled")).toBeNull();
    await click(own);
    await settle(6);
    expect(calls.filter((c) => c.name === "patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { audio: "own-sound", audioModel: null } } });
    expect($('[data-maker-model="custom-rain-sounds"]', card("Sound maker"))?.textContent).toContain("Rain sounds");
    // Remove while it is picked: the API's 409 sentence, on the row.
    await click(byText("button", /^Remove/, byText(".st-stg-own", /Rain sounds/, box())));
    await click(byText("button", "Yes, remove it", byText(".st-stg-own", /Rain sounds/, box())));
    await settle(6);
    expect(byText(".st-stg-own", /Rain sounds/, box()).textContent).toContain("Rain sounds is picked as the sound model in Settings › Video. Pick another model there first, then remove it.");
    // Check models: an access check that costs nothing, in the provider's own words.
    await click(byText("button", /Check models/, box()));
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(8);
    expect(calls.some((c) => c.name === "checkModels" && Array.isArray(c.args[2]) && (c.args[2] as string[]).includes("custom-rain-sounds") && !(c.args[2] as string[]).includes("nova-reel"))).toBe(true);
    expect(byText(".st-stg-own", /Rain sounds/, box()).textContent).toContain("No access");
    expect(byText(".st-stg-own", /Rain sounds/, box()).textContent).toContain("There is no key for ElevenLabs yet.");
  });
});

describe("where an added AI model runs (§45.37 G4)", () => {
  it("Anthropic: no Region, the model's API name, effort in output_config; the row says it needs the Anthropic key", async () => {
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    const hosts = $<HTMLElement>('[aria-label="Where it runs"]', form)!;
    expect($$("[role=radio]", hosts).map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Amazon Bedrock", "Anthropic", "An OpenAI-compatible service"]);
    await click(byText("[role=radio]", /^Anthropic/, hosts));
    expect($$("select", form).some((s) => s.getAttribute("aria-label") === "AWS Region")).toBe(false);
    expect(form.textContent).toContain("It uses your Anthropic API key, saved under Provider keys below. The key is never shown again.");
    fill(form, "Name", "Opus direct");
    fill(form, "Model name", "claude-opus-5-5");
    await click(byText("button", "High", form));
    await submit(form);
    const body = lastBody("putAiModel") as Record<string, unknown>;
    expect(body).toMatchObject({ label: "Opus direct", provider: "Anthropic", modelId: "claude-opus-5-5", host: "anthropic", efforts: ["high"], defaultEffort: "high", effortField: "output_config", tools: true, cache: true });
    expect(body).not.toHaveProperty("region");
    expect(body).not.toHaveProperty("baseUrl");
    const row = byText(".st-stg-own", /Opus direct/);
    expect(row.textContent).toContain("Made by Anthropic · on Anthropic API");
    expect(row.textContent).toContain("Paste your Anthropic API key in Provider keys below, then tap Check models.");
  });

  it("an OpenAI-compatible service: its https address, reasoning_effort up to Extra high, no prompt cache", async () => {
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    await click(byText("[role=radio]", /^An OpenAI-compatible service/, $<HTMLElement>('[aria-label="Where it runs"]', form)!));
    expect($$("button", form).some((b) => b.textContent === "Maximum")).toBe(false);
    expect($$(".st-stg-switchrow", form).some((r) => /It can reuse its instructions/.test(r.textContent ?? ""))).toBe(false);
    fill(form, "Name", "Llama far away");
    await click(byText("[role=radio]", "Meta", form));
    fill(form, "Model name", "meta-llama/Llama-4-Maverick");
    fill(form, "The service's address", "http://api.example.com/v1");
    await submit(form);
    expect(calls.some((c) => c.name === "putAiModel")).toBe(false);
    expect(form.textContent).toContain("The address must start with https:// so the key travels safely.");
    fill(form, "The service's address", "https://api.example.com/v1/");
    await submit(form);
    const body = lastBody("putAiModel") as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "Meta", modelId: "meta-llama/Llama-4-Maverick", host: "openai_compatible", baseUrl: "https://api.example.com/v1", cache: false, effortField: "none", efforts: [] });
    expect(body).not.toHaveProperty("region");
    expect(byText(".st-stg-own", /Llama far away/).textContent).toContain("Made by Meta · on api.example.com");
    // The API refuses what reaches past the public internet.
    const def = body as unknown as ModelDef;
    await expect(api.putAiModel("stories", "custom-inside", { ...def, label: "Inside", baseUrl: "https://169.254.169.254/v1" })).rejects.toMatchObject({ status: 400, field: "baseUrl" });
    await expect(api.putAiModel("stories", "custom-inside", { ...def, label: "Inside", efforts: ["max"], defaultEffort: "max", effortField: "reasoning_effort" })).rejects.toMatchObject({ status: 400, field: "efforts" });
  });

  it("a Bedrock model is saved exactly as before hosts: no host and no address in its body", async () => {
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    fill(form, "Name", "Nova Lite");
    await click(byText("[role=radio]", "Amazon", form));
    fill(form, "Bedrock model ID or inference profile", "eu.amazon.nova-lite-v1:0");
    await submit(form);
    const body = lastBody("putAiModel") as Record<string, unknown>;
    expect(body).toMatchObject({ label: "Nova Lite", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1" });
    expect(body).not.toHaveProperty("host");
    expect(body).not.toHaveProperty("baseUrl");
  });
});
