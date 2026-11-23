// Lamo Stories, the makers' review fixes (docs/CONTRACTS.md §45.37 G1, G2, G4, G5, G7, G8), against the in-memory API
// and the API's own shapes:
// - the maker models come on the maker rows of GET …/providers (no route of their own); a keyed host's key state comes
//   from its provider row (`key`), never from the model;
// - an added picture, video or sound model keeps what it makes (Edit shows it, never a pick), and a new model's key
//   avoids both kinds of added model (one name across Settings › AI and Settings › Video);
// - the "Made with" words name the animation_plan and text_edit calls;
// - an older pick of Amazon Nova Canvas reads ended on the character's AI picture, with one tap to Stability AI's;
// - the mock's base URL guard refuses what the API's hosts.private_host refuses;
// - the publish sheet never asks the owner to "decide" about Clip Factory's own account.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { cleanBaseUrl, privateHost } from "../src/stories/api/mock/ai.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import * as stories from "../src/stories/api/mock/stories.ts";
import { keySavedFor, makerModelsIn, type MakerModelInfo, type ProviderStatus, type SocialAccount, type StoriesApi, type StoriesConfig } from "../src/stories/api/types.ts";
import { keyFor } from "../src/stories/settings/OwnModels.tsx";
import { shownMakerModels } from "../src/stories/settings/VideoSection.tsx";
import { modelUseWords } from "../src/stories/studio/ai.tsx";
import { accountState } from "../src/stories/studio/PublishSheet.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");
const { CharactersScreen } = await import("../src/stories/screens/Characters.tsx");

let host: HTMLElement;
let root: Root;
let api: StoriesApi;
let store: MockStore;
let calls: { name: string; args: unknown[] }[];

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20, tryMs: 0, ...knobs } };
  const real = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
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
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
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
  await settle();
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
  await settle(6);
}
function fill(form: HTMLElement, label: string, value: string) {
  const l = $$("label", form).find((x) => x.textContent === label);
  const el = l ? form.querySelector<HTMLInputElement>(`#${CSS.escape((l as HTMLLabelElement).htmlFor)}`) : null;
  if (!el) throw new Error(`no field ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = async (form: HTMLElement) => {
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle(8);
};
const card = (title: string) => byText<HTMLElement>(".st-stg-card", new RegExp(`^${title}`));

beforeEach(async () => {
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
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
});

const model = (key: string, extra: Partial<MakerModelInfo> = {}): MakerModelInfo => ({
  key,
  label: key,
  provider: "Acme",
  host: "Amazon Bedrock",
  modelId: key,
  region: "us-west-2",
  kind: "image",
  price: null,
  note: "",
  status: "not_checked",
  statusLine: "Not checked yet.",
  checkedAt: null,
  custom: false,
  ...extra,
});

describe("the maker models and the keys come from GET …/providers (§45.37 G1, G2, G4)", () => {
  it("reads each maker row's models once, and a keyed host's key from its own row", () => {
    const rows: ProviderStatus[] = [
      { kind: "images", id: "builtin-rig", label: "Built-in", state: "on", line: "" },
      { kind: "images", id: "stability", label: "Stability AI pictures", state: "off", line: "", models: [model("stable-image-core")] },
      { kind: "images", id: "own-images", label: "Your own", state: "off", line: "", models: [model("custom-paint", { custom: true }), model("stable-image-core")] },
      { kind: "audio", id: "elevenlabs", label: "ElevenLabs", state: "off", line: "", key: { saved: true, hint: "4f2a", savedAt: null }, models: [] },
      { kind: "writer", id: "anthropic", label: "Anthropic API", state: "needs_setup", line: "", key: { saved: false, hint: null, savedAt: null } },
    ];
    expect(makerModelsIn(rows).map((m) => m.key)).toEqual(["stable-image-core", "custom-paint"]);
    expect(shownMakerModels(rows).map((m) => m.key)).toEqual(["stable-image-core", "custom-paint"]);
    // No maker row with models (an older API, or still loading): the bundled set, each "Not checked yet", and an ended
    // one final with its end day (the API's makers.model_info).
    expect(shownMakerModels(null).length).toBeGreaterThan(5);
    expect(shownMakerModels(null).filter((m) => !m.ended).every((m) => m.status === "not_checked")).toBe(true);
    expect(shownMakerModels(null).filter((m) => m.ended).map((m) => [m.key, m.status, m.statusLine])).toEqual([
      ["nova-canvas", "not_found", "Ended by Amazon on 30 Sep 2026."],
      ["nova-reel", "not_found", "Ended by Amazon on 30 Sep 2026."],
    ]);
    expect(keySavedFor(rows, "elevenlabs")).toBe(true);
    expect(keySavedFor(rows, "ElevenLabs")).toBe(true);
    expect(keySavedFor(rows, "anthropic")).toBe(false);
    expect(keySavedFor(rows, "openai_compatible")).toBeUndefined();
    expect(keySavedFor(rows, "bedrock")).toBeUndefined();
    expect(keySavedFor(null, "anthropic")).toBeUndefined();
  });

  it("Settings › Video lists the owner's added models from the maker rows, picks his own maker, and never asks for a route of their own", async () => {
    start();
    await api.putMakerModel("stories", "custom-paint", { label: "Paint", provider: "Acme", kind: "image", host: "openai_compatible", modelId: "paint-2", baseUrl: "https://api.example.com/v1", price: null, note: "" });
    calls = [];
    await open("video");
    expect(calls.some((c) => c.name === "makerModels")).toBe(false);
    const box = card("Add a picture, video or sound model");
    const row = byText(".st-stg-own", /Paint/, box);
    // Its key is not saved yet: the provider row says so (never the model).
    expect(row.textContent).toContain("Paste your OpenAI-compatible API key under Prices and keys below, then tap Check models above.");
    const own = byText("[role=radio]", /your own picture model/, card("Picture maker"));
    expect(own.getAttribute("aria-disabled")).toBeNull();
    await click(own);
    expect(calls.filter((c) => c.name === "patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { images: "own-images", imageModel: null } } });
    expect($('[data-maker-model="custom-paint"]', card("Picture maker"))?.textContent).toContain("Paint");
  });

  it("Edit keeps what an added model makes: no pick, just the kind in words", async () => {
    start();
    await api.putMakerModel("stories", "custom-rain", { label: "Rain", provider: "ElevenLabs", kind: "audio", host: "elevenlabs", modelId: "eleven_text_to_sound_v2", price: null, note: "" });
    await open("video");
    const box = card("Add a picture, video or sound model");
    await click(byText("button", /^Edit/, byText(".st-stg-own", /Rain/, box)));
    const form = $<HTMLElement>('form[aria-label="Change Rain"]')!;
    expect($('[role=radiogroup][aria-label="What it makes"]', form)).toBeNull();
    expect($("[data-kind-fixed]", form)?.textContent).toContain("Sound");
    expect($("[data-kind-fixed]", form)?.textContent).toContain("add it again as a new model");
    fill(form, "Name", "Rain and thunder");
    await submit(form);
    expect((calls.filter((c) => c.name === "putMakerModel").at(-1)?.args[2] as { kind: string }).kind).toBe("audio");
    expect(byText(".st-stg-own", /Rain and thunder/, box)).toBeTruthy();
  });

  it("a new model's key avoids both kinds of added model (one name across Settings › AI and Settings › Video)", async () => {
    expect(keyFor("Flux", ["custom-flux"])).toBe("custom-flux-2");
    start();
    await api.putAiModel("stories", "custom-flux", { label: "Flux", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 4000, price: null });
    await open("video");
    const box = card("Add a picture, video or sound model");
    await click(byText("button", /Add a model/, box));
    const form = $<HTMLElement>('form[aria-label="Add a picture, video or sound model"]')!;
    fill(form, "Name", "Flux");
    fill(form, "Bedrock model ID", "stability.stable-image-core-v1:1");
    await submit(form);
    expect(calls.filter((c) => c.name === "putMakerModel").at(-1)?.args[1]).toBe("custom-flux-2");
    // And the other way round: an AI model named like a picture model gets a free key too.
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const ai = $<HTMLElement>('form[aria-label="Add a model"]')!;
    fill(ai, "Name", "Flux 2");
    await click(byText("[role=radio]", "Amazon", ai));
    fill(ai, "Model ID", "eu.amazon.nova-lite-v1:0");
    await submit(ai);
    expect(calls.filter((c) => c.name === "putAiModel").at(-1)?.args[1]).toBe("custom-flux-2-2");
  });
});

describe("the Made with words (§45.37 G5)", () => {
  it("name the re-staging pass and a short chat edit, apart from the story", () => {
    expect(modelUseWords({ step: "storyboard", task: "storyboard" })).toBe("Write the story");
    expect(modelUseWords({ step: "storyboard", task: "animation_plan" })).toBe("Plan the animation");
    expect(modelUseWords({ step: "chat", task: "text_edit" })).toBe("Small word changes");
  });
});

describe("the character's AI picture with an older pick of Amazon Nova Canvas (§45.37 G7)", () => {
  it("says Amazon ended it, never that AI pictures are off, and one tap switches to Stability AI's pictures", async () => {
    start();
    const w = store.workspaces.find((x) => x.workspaceId === "stories")!;
    (w.configuration as StoriesConfig).providers.images = "nova-canvas";
    await act(async () =>
      root.render(
        <ToastProvider>
          <CharactersScreen ws="stories" page={{ name: "character", characterId: stories.SEED_IDS.characters.bolt }} />
        </ToastProvider>,
      ),
    );
    await settle(10);
    const portrait = $<HTMLElement>(".st-s-portrait")!;
    expect(portrait.textContent).toContain("Amazon Nova Canvas: Ended by Amazon on 30 Sep 2026.");
    expect(portrait.textContent).not.toContain("AI pictures are off");
    expect(calls.some((c) => c.name === "patchWorkspace")).toBe(false);
    await click(byText("button", "Use Stability AI pictures", portrait));
    await settle(6);
    expect(calls.filter((c) => c.name === "patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { images: "stability", imageModel: null } } });
    expect(Object.keys((calls.filter((c) => c.name === "patchWorkspace").at(-1)?.args[1] as { configuration: { providers: object } }).configuration.providers).sort()).toEqual(["imageModel", "images"]);
    expect($<HTMLElement>(".st-s-portrait")!.textContent).toContain("Make an AI picture");
    expect(((await api.getWorkspace("stories")).configuration as StoriesConfig).providers.images).toBe("stability");
  });
});

describe("the mock's base URL guard is the API's (hosts.private_host)", () => {
  it("refuses trailing dots, shared and reserved ranges, broadcast, odd IPv4 spellings and dot or % paths", () => {
    for (const url of [
      "https://localhost./v1",
      "https://metadata.google.internal./v1",
      "https://instance-data./",
      "https://100.64.0.1/v1",
      "https://198.18.0.1/",
      "https://255.255.255.255/",
      "https://224.0.0.1/",
      "https://2130706433/v1",
      "https://0x7f.1/v1",
      "https://[::1]/v1",
      "https://api.example.com/v1/../admin",
      "https://api.example.com/v1/./x",
      "https://api.example.com/v1%2F..",
      "https://intranet/v1",
      "https://router.home.arpa/v1",
    ])
      expect(() => cleanBaseUrl(url), url).toThrow();
    expect(cleanBaseUrl("https://api.openai-like.com/v1/")).toBe("https://api.openai-like.com/v1");
    expect(cleanBaseUrl("https://API.Example.org:8443/v1")).toBe("https://api.example.org:8443/v1");
    expect(privateHost("8.8.8.8")).toBe(false);
    expect(privateHost("100.63.255.255")).toBe(false);
    expect(privateHost("100.64.0.0")).toBe(true);
  });
});

describe("the publish sheet's line for Clip Factory's own account (§45.37 G8)", () => {
  it("asks for a different account, never to decide", () => {
    const a = { connectionStatus: "same_as_clips" } as SocialAccount;
    expect(accountState(a)).toBe("This is Clip Factory's own account. Connect a different account made for Clip Stories in Social accounts.");
    expect(accountState(a)).not.toMatch(/decide|both/i);
  });
});
