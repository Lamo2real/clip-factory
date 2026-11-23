// Lamo Stories › Settings (docs/CONTRACTS.md §45.25–§45.27, §45.29, §45.31), rendered against the in-memory API: the
// AI section (default model with provider and status, Check models, efforts only where the model offers them, the
// agent and task table with "Workspace default", suggested efforts, prices, usage, provider keys shown only as
// "saved · ends 4f2a"), Agents (on/off with the driving-safety rule, instructions with Reset, skills in order), Skills
// (built-ins read-only, write, versions, upload with progress), Memory (add, edit, delete), Video and Storage. Every
// pick-one bar sits on <Glide>; nothing that cannot be used is `disabled` (it is aria-disabled, so it plays the deny
// sound from the global click handler).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockStore } from "../src/stories/api/mock/store.ts";
import type { ProviderStatus, StoriesApi, StoriesConfig, Workspace } from "../src/stories/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The mock's fake latency is for people; tests run without it.
vi.mock("../src/stories/api/mock/store.ts", async (load) => ({ ...(await load<typeof import("../src/stories/api/mock/store.ts")>()), delay: () => Promise.resolve() }));

const { createStore } = await import("../src/stories/api/mock/store.ts");
const aiPart = await import("../src/stories/api/mock/ai.ts");
const skillsPart = await import("../src/stories/api/mock/skills.ts");
const memoryPart = await import("../src/stories/api/mock/memory.ts");
const { setStoriesApi } = await import("../src/stories/api/client.ts");
const { forgetLoaded } = await import("../src/lib/hooks.ts");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");
const { DEFAULTS } = await import("../src/stories/settings/data.ts");
const { ApiError } = await import("../src/api/errors.ts");

let root: Root;
let host: HTMLElement;
let store: MockStore;
let workspace: Workspace;
let providers: ProviderStatus[];
/** A test where no maker takes a key (the ElevenLabs row is left out). */
let noKeyedMakers = false;
let calls: { name: string; args: unknown[] }[];
/** Holds the next answers of a route until the test lets them go (a slow connection). */
const gates = new Map<string, Promise<void>>();
/** Routes that fail for a test (a network outage, an expired task). */
const failures = new Map<string, Error>();
function hold(name: string): () => void {
  let open = () => undefined as void;
  const gate = new Promise<void>((r) => (open = r));
  gates.set(name, gate);
  return () => {
    if (gates.get(name) === gate) gates.delete(name);
    open();
  };
}

/** The API's Luma AI Ray2 sentence, word for word (§45.37). */
const LUMA_NOT_READY =
  "Luma AI Ray2 is not ready yet: it needs a storage bucket in the United States (Oregon), which is switched off, and Luma AI Ray2 turned on for your account. Pick Built-in animation in Settings › Video, or finish its setup.";

/**
 * The makers as the API sends them (§45.11.6, §45.37): Stability AI off until picked, Luma AI Ray2 needs its Oregon
 * bucket, Amazon's Nova Canvas and Nova Reel ended (each naming its replacement), Amazon Polly off unless picked.
 */
function makers(): ProviderStatus[] {
  const c = workspace.configuration as StoriesConfig;
  return [
    { kind: "writer", id: "bedrock-claude", label: "Claude in Amazon Bedrock", state: "on", line: "Writes the stories." },
    { kind: "animation", id: "builtin-2d", label: "Built-in animation", state: "on", line: "Animates every scene." },
    { kind: "animation", id: "luma-ray", label: "Luma AI Ray2 (AI video)", state: c.providers.video === "luma-ray" ? "needs_setup" : "off", line: LUMA_NOT_READY },
    { kind: "animation", id: "nova-reel", label: "Amazon Nova Reel", state: "ended", line: "Ended by Amazon on 30 Sep 2026.", endedAt: "2026-09-30", replacement: "luma-ray" },
    { kind: "images", id: "builtin-rig", label: "Built-in characters", state: "on", line: "Draws every character." },
    c.providers.images === "stability"
      ? { kind: "images", id: "stability", label: "Stability AI pictures", state: "needs_setup", line: "Make one portrait to check it works." }
      : { kind: "images", id: "stability", label: "Stability AI pictures", state: "off", line: "Off." },
    { kind: "images", id: "nova-canvas", label: "Amazon Nova Canvas", state: "ended", line: "Ended by Amazon on 30 Sep 2026.", endedAt: "2026-09-30", replacement: "stability" },
    { kind: "audio", id: "builtin-synth", label: "Built-in sounds", state: "on", line: "Makes every sound." },
    ...(noKeyedMakers
      ? []
      : [{ kind: "audio", id: "elevenlabs", label: "ElevenLabs", state: c.providers.audio === "elevenlabs" ? "needs_setup" : "off", line: "Paste your ElevenLabs key to use it.", key: { saved: false, hint: null, savedAt: null } } satisfies ProviderStatus]),
    { kind: "audio", id: "polly", label: "A spoken voice (Amazon Polly)", state: c.providers.audio === "polly" ? "needs_setup" : "off", line: "Adds words spoken aloud." },
  ];
}

function fakeApi(): StoriesApi {
  store = createStore();
  store.workspaces = [{ workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: structuredClone(DEFAULTS), version: 3 }];
  for (const part of [aiPart, skillsPart, memoryPart]) part.seed(store);
  store.knobs.checkModelsMs = 20;
  workspace = store.workspaces[0]!;
  providers = [];
  const parts = { ...aiPart.api(store), ...skillsPart.api(store), ...memoryPart.api(store) };
  const own: Partial<StoriesApi> = {
    getWorkspace: async () => structuredClone(workspace),
    patchWorkspace: async (_ws, patch) => {
      if (patch.version !== workspace.version) throw Object.assign(new Error("stale"), { code: "conflict" });
      // As the API: each part merged onto the stored one; a new maker without its model in the body starts from its first.
      const before = workspace.configuration as StoriesConfig;
      const body = patch.configuration ?? {};
      const providers = { ...before.providers, ...(body.providers ?? {}) };
      for (const [maker, model] of [["images", "imageModel"], ["video", "videoModel"], ["audio", "audioModel"]] as const)
        if (body.providers?.[maker] !== undefined && body.providers[maker] !== before.providers[maker] && !(model in body.providers)) providers[model] = null;
      workspace = { ...workspace, configuration: { ...before, ...body, providers } as StoriesConfig, version: workspace.version + 1 };
      return structuredClone(workspace);
    },
    providers: async () => structuredClone([...makers(), ...providers]),
    getTask: async (_ws, id) => structuredClone(store.tasks.find((t) => t.taskId === id)!),
  };
  const all = { ...parts, ...own } as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return new Proxy(all, {
    get(target, key: string) {
      const fn = target[key];
      if (!fn) return () => Promise.reject(new Error(`not in this test: ${key}`));
      return async (...args: unknown[]) => {
        calls.push({ name: key, args });
        const gate = gates.get(key);
        if (gate) await gate;
        const fail = failures.get(key);
        if (fail) throw fail;
        return fn(...args);
      };
    },
  }) as unknown as StoriesApi;
}

beforeEach(() => {
  calls = [];
  noKeyedMakers = false;
  gates.clear();
  failures.clear();
  forgetLoaded();
  setStoriesApi(fakeApi());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

async function open(section: "ai" | "agents" | "skills" | "memory" | "video" | "storage" | "look") {
  act(() =>
    root.render(
      <ToastProvider>
        <SettingsScreen ws="stories" page={{ name: "settings", section }} />
      </ToastProvider>,
    ),
  );
  await settle();
}

const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = host) => from.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = host) => Array.from(from.querySelectorAll<T>(sel));
function byText<T extends HTMLElement = HTMLElement>(sel: string, text: string | RegExp, from: ParentNode = host): T {
  const el = $$<T>(sel, from).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
  if (!el) throw new Error(`no ${sel} with ${String(text)}; have: ${$$(sel, from).map((e) => e.textContent?.trim()).join(" | ")}`);
  return el;
}
function group(label: string): HTMLElement {
  const g = $(`[aria-label="${label}"]`);
  if (!g) throw new Error(`no group ${label}`);
  return g;
}
function card(title: string): HTMLElement {
  return byText("h3", title).closest("section")!;
}
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const called = (name: string) => calls.filter((c) => c.name === name);

describe("the page", () => {
  it("has a bar of every section on <Glide>, Social accounts going to the Connections page", async () => {
    await open("ai");
    const links = $$<HTMLAnchorElement>(".st-stg-tab");
    expect(links.map((a) => a.textContent)).toEqual(["AI", "Agents", "Skills", "Memory", "Social accounts", "Video", "Storage", "Look"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/stories/settings/ai", "/stories/settings/agents", "/stories/settings/skills", "/stories/settings/memory", "/stories/connections", "/stories/settings/video", "/stories/settings/storage", "/stories/settings/look"]);
    expect($(".st-stg-tabs > .glide")).not.toBeNull();
    expect($(".st-stg-tab.is-on")?.getAttribute("aria-current")).toBe("page");
    expect($("h1")?.textContent).toBe("Settings");
  });

  it("puts the page head and the section pills on one hero, and each section's note and Saved mark in its head's one plate", async () => {
    await open("storage");
    const hero = $(".st-stg-top.st-glass--hero")!;
    expect(hero.querySelector("h1")?.textContent).toBe("Settings");
    expect(hero.querySelectorAll(".st-stg-tab.st-pill")).toHaveLength(8);
    expect(hero.querySelector("a.st-pill.st-stg-head__setup-go")?.getAttribute("href")).toBe("/stories/setup");
    const head = $(".st-stg-section__head.st-plate")!;
    expect(head.querySelector("h2")?.textContent).toBe("Storage and production");
    expect(head.querySelector(".st-stg-bar")?.textContent).toContain("Your files stay apart from Clip Factory's.");
    expect(head.querySelector(".st-stg-saved")).not.toBeNull();
    // One plate above the first card: the bar has none of its own there.
    expect($$(".st-stg-section .st-plate")).toEqual([head]);
    await open("skills");
    expect($(".st-stg-section__head .st-stg-bar")).toBeNull();
  });

  it("gives Look its own page: the three backgrounds under their own pill and head, no longer at the end of Storage", async () => {
    await open("storage");
    expect($("#look")).toBeNull();
    expect(host.textContent).not.toContain("See-through");
    await open("look");
    expect($(".st-stg-tab.is-on")?.textContent).toBe("Look");
    expect($(".st-stg-tab.is-on")?.getAttribute("href")).toBe("/stories/settings/look");
    const head = $(".st-stg-section__head.st-plate")!;
    expect(head.querySelector("h2")?.textContent).toBe("Look");
    expect(head.querySelector(".st-stg-section__lede")?.textContent).toBe("What is behind the glass: See-through, a picture of yours, or colours.");
    // The redesign's section bar: the note in the head's one plate, none of its own.
    expect(head.querySelector(".st-stg-bar")?.textContent).toBe("Kept on this device. Clip Factory's own background stays as it is.");
    expect($$(".st-stg-section .st-plate")).toEqual([head]);
    const look = $("#look")!;
    expect(look.querySelector("h3")?.textContent).toBe("Background");
    const modes = $$<HTMLButtonElement>('[aria-label="Background"] [role=radio]', look);
    expect(modes.map((o) => o.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["See-through", "Picture", "Colours"]);
  });

  for (const section of ["ai", "agents", "skills", "memory", "video", "storage", "look"] as const)
    it(`${section}: every pick-one bar is on <Glide>, and nothing is disabled (the deny sound needs the click)`, async () => {
      await open(section);
      for (const bar of $$("[role=radiogroup]")) expect(bar.querySelector(":scope > .glide"), bar.getAttribute("aria-label") ?? "").not.toBeNull();
      expect($$("[disabled]")).toEqual([]);
      expect(host.textContent).not.toMatch(/undefined|NaN|\[object/);
    });
});

describe("AI", () => {
  it("shows the active model and effort, every model with its provider and the result of its last call", async () => {
    await open("ai");
    expect($(".st-stg-active")?.textContent).toContain("Model: Claude Opus 5.5");
    expect($(".st-stg-active")?.textContent).toContain("Effort: High");
    const models = $$("[role=radio]", group("Default model"));
    expect(models.map((m) => m.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Claude Fable 5.2", "Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Amazon Nova Pro"]);
    for (const m of models) expect(m.textContent).toContain("Amazon Bedrock");
    // §45.35 D8: the maker on its host.
    expect(byText("[role=radio]", /Opus 5\.5/).textContent).toContain("Anthropic on Amazon Bedrock");
    expect(byText("[role=radio]", /Fable 5\.1/).textContent).toContain("No access");
    expect(byText("[role=radio]", /Sonnet 5\.5/).textContent).toContain("Not checked yet");
    expect(byText("[role=radio]", /Opus 5\.5/).getAttribute("aria-checked")).toBe("true");
  });

  it("switching the default model saves it and the active line follows; a denied one says why", async () => {
    await open("ai");
    await click(byText("[role=radio]", /Fable 5\.1/));
    await settle();
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultModel: "fable-5-1", defaultEffort: "high", version: 0 });
    expect($(".st-stg-active")?.textContent).toContain("Claude Fable 5.1");
    expect(card("Default model").querySelector("[role=alert]")?.textContent).toMatch(/Claude Fable 5\.1 said no last time: .*no access/);
    expect(card("Default model").textContent).toContain("never switches to another model by itself");
  });

  it("shows only the efforts the model offers, and says so when a model has no effort setting", async () => {
    await open("ai");
    expect($$("[role=radio]", group("Default effort")).map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Maximum"]);
    await click(byText("[role=radio]", /Nova Pro/));
    await settle();
    expect(card("Default effort").textContent).toContain("This model has no effort setting; it runs at its own level.");
    expect($(".st-stg-active")?.textContent).toContain("Effort: its own level");
    expect($('[aria-label="Default effort"]')).toBeNull();
  });

  it("saves a new default effort", async () => {
    await open("ai");
    await click(byText("[role=radio]", "Maximum"));
    await settle();
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultModel: "opus-5-5", defaultEffort: "max" });
  });

  it("Check models makes a check task, follows it, and shows every model's new result", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open("ai");
    await click(byText("button", "Check models"));
    expect(called("checkModels")).toHaveLength(1);
    expect(byText("button", "Checking…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(10);
    expect(called("getTask").length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/Checked 6 models: 5 work, 1 said no\./);
    expect(byText("[role=radio]", /Sonnet 5\.5/).textContent).toContain("Works");
    expect(byText("[role=radio]", /Fable 5\.1/).textContent).toContain("No access");
  });

  it("Check models stops with a sentence when its task is gone, instead of checking for ever", async () => {
    await open("ai");
    failures.set("getTask", new ApiError(404, "not_found", "We could not find that task."));
    await click(byText("button", "Check models"));
    expect(byText("button", "Checking…").getAttribute("aria-disabled")).toBe("true");
    await act(async () => await new Promise((r) => setTimeout(r, 1200)));
    await settle(6);
    expect(document.body.textContent).toContain("The check stopped before it finished. Try again.");
    expect(byText("button", "Check models").getAttribute("aria-disabled")).toBeNull();
    expect($('[role="progressbar"]')).toBeNull();
  });

  it("Check models gives up after a few failed asks in a row and says the server's sentence", async () => {
    await open("ai");
    failures.set("getTask", new ApiError(503, "platform_down", "Clips Funded's helper is not answering. Try again in a minute."));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const button = byText("button", "Check models");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
    for (let i = 0; i < 2; i++) await act(async () => await vi.advanceTimersByTimeAsync(1050));
    expect(called("getTask")).toHaveLength(2);
    expect(byText("button", "Checking…")).toBeTruthy();
    await act(async () => await vi.advanceTimersByTimeAsync(1050));
    await act(async () => await vi.advanceTimersByTimeAsync(10));
    vi.useRealTimers();
    await settle(4);
    expect(called("getTask")).toHaveLength(3);
    expect(document.body.textContent).toContain("Clips Funded's helper is not answering. Try again in a minute.");
    expect(byText("button", "Check models")).toBeTruthy();
  });

  it("sets each agent's and each task's model and effort, with Workspace default, the suggestion and what it uses now", async () => {
    await open("ai");
    const rows = $$(".st-stg-assign__row");
    // 5 agents and 13 tasks: §45.37 G5 adds the small word changes (Low) and the animation planning (High).
    expect(rows).toHaveLength(5 + 13);
    const words = rows.find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Small word changes")!;
    expect(words.textContent).toContain("Suggested: Low");
    expect(words.textContent).toContain("Creative director agent");
    const plan = rows.find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Plan the animation")!;
    expect(plan.textContent).toContain("Suggested: High");
    expect(plan.textContent).toContain("Storyboard agent");
    const director = rows.find((r) => r.textContent?.includes("Creative director"))!;
    const pick = director.querySelector<HTMLSelectElement>("select")!;
    expect(pick.options[0]?.textContent).toBe("Workspace default");
    expect(Array.from(pick.options).map((o) => o.textContent)).toContain("Claude Fable 5.1 · no access");
    setValue(pick, "sonnet-5-5");
    await settle();
    expect(called("patchAgent").at(-1)?.args).toEqual(["stories", "creative_director", { model: "sonnet-5-5", version: 1 }]);

    const story = $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the story")!;
    expect(story.textContent).toContain("Suggested: High");
    expect(story.querySelector(".st-stg-assign__uses")?.textContent).toContain("Claude Fable 5.1 · High");
    expect(story.querySelector(".st-stg-assign__uses")?.textContent).toContain("No access");
    setValue(story.querySelectorAll<HTMLSelectElement>("select")[0]!, "fable-5-2");
    await settle();
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ tasks: { storyboard: { model: "fable-5-2" } } });
    const after = $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the story")!;
    expect(after.querySelector(".st-stg-assign__uses")?.textContent).toContain("Claude Fable 5.2 · High");
    expect(after.textContent).toContain("set for this task");

    const captions = $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the post captions")!;
    expect(captions.textContent).toContain("Suggested: Low");
    await click(byText("button", "Use it", captions));
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ tasks: { captions: { effort: "low" } } });
  });

  it("shows tokens and cost for 30 days, No price set where there is none, and takes the owner's price", async () => {
    await open("ai");
    const usage = card("Usage and cost, last 30 days");
    expect(usage.querySelectorAll(".st-stg-chart__day")).toHaveLength(30);
    expect(byText(".st-stg-usage__row", /Amazon Nova Pro/, usage).textContent).toContain("No price set.");
    expect(byText(".st-stg-usage__row", /Claude Opus 5\.5/, usage).textContent).toMatch(/US\$\d|\$\d/);
    const prices = card("Prices");
    const nova = byText(".st-stg-price", /Amazon Nova Pro/, prices);
    expect(nova.textContent).toContain("No price set.");
    await click(byText("button", "Type a price", nova));
    const inputs = nova.querySelectorAll<HTMLInputElement>("input");
    setValue(inputs[0]!, "0.8");
    setValue(inputs[1]!, "3.2");
    await act(async () => nova.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(called("setModelPrice").at(-1)?.args).toEqual(["stories", "nova-pro", { inputPer1M: 0.8, outputPer1M: 3.2, currency: "USD" }]);
    expect(byText(".st-stg-price", /Amazon Nova Pro/, card("Prices")).textContent).toContain("Your price");
    expect(byText(".st-stg-usage__row", /Amazon Nova Pro/, card("Usage and cost, last 30 days")).textContent).not.toContain("No price set.");
  });

  it("lists the providers with their state, and shows a provider key only as saved · ends 4f2a", async () => {
    // A provider that takes a key (none does today): the API lists it, and its key routes take it.
    providers.push({ kind: "animation", id: "acme-motion", label: "Acme Motion", state: "needs_setup", line: "Paste your Acme Motion key to use it." });
    store.knobs.keyedProviders = [{ kind: "animation", id: "acme-motion", label: "Acme Motion" }];
    await open("ai");
    const card_ = card("Providers");
    expect(byText(".st-stg-provider", /Luma AI Ray2/, card_).textContent).toContain("Off");
    // Amazon ended Nova Reel (§45.37): its row says so, never "Off" or working.
    expect(byText(".st-stg-provider", /Amazon Nova Reel/, card_).textContent).toContain("Ended by Amazon");
    expect($$(".st-stg-keyrow", card_).map((r) => r.querySelector(".st-stg-keyrow__name")?.textContent)).toEqual(["ElevenLabs", "Acme Motion"]);
    const row = byText(".st-stg-keyrow", /Acme Motion/, card_);
    expect(row.textContent).toContain("Paste your Acme Motion key to use it.");
    expect(row.textContent).toContain("Not ready yet");
    await click(byText("button", "Paste a key", row));
    setValue(row.querySelector("input")!, "sk-acme-0123456789abcdef4f2a");
    expect(row.querySelector("input")!.type).toBe("password");
    await act(async () => row.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(called("setProviderKey").at(-1)?.args).toEqual(["stories", "acme-motion", "sk-acme-0123456789abcdef4f2a"]);
    const after = byText(".st-stg-keyrow", /Acme Motion/, card("Providers"));
    expect(after.textContent).toContain("Key saved · ends 4f2a.");
    expect(host.innerHTML).not.toContain("0123456789abcdef");
    expect(after.querySelector("input")).toBeNull();
    await click(byText("button", "Remove the saved key", after));
    expect(called("deleteProviderKey").at(-1)?.args).toEqual(["stories", "acme-motion"]);
    expect(byText(".st-stg-keyrow", /Acme Motion/, card("Providers")).textContent).toContain("Paste your Acme Motion key to use it.");
  });

  it("takes the Anthropic API's and an OpenAI-compatible API's keys, showing only the hint, never the key (§45.37 G4)", async () => {
    providers.push(aiPart.keyedHostStatus(store, "anthropic"), aiPart.keyedHostStatus(store, "openai_compatible"));
    await open("ai");
    const names = () => $$(".st-stg-keyrow", card("Providers")).map((r) => r.querySelector(".st-stg-keyrow__name")?.textContent);
    expect(names()).toEqual(["ElevenLabs", "Anthropic API", "OpenAI-compatible API"]);
    // An OpenAI-compatible key is for one address (the API's provider_keys, §45.37 G4): with no model on it yet, its
    // address goes with the key, and the row names it.
    for (const [label, id, key, address, saved] of [
      ["Anthropic API", "anthropic", "sk-ant-api03-0123456789abcdefWXYZ", null, "Key saved · ends WXYZ."],
      ["OpenAI-compatible API", "openai_compatible", "sk-proj-0123456789abcdef9k2q", "https://api.example.com/v1", "Key saved for api.example.com · ends 9k2q."],
    ] as const) {
      const row = byText(".st-stg-keyrow", new RegExp(label), card("Providers"));
      expect(row.textContent).toContain(`Paste your ${label} key to use it.`);
      await click(byText("button", "Paste a key", row));
      setValue(row.querySelector("input")!, key);
      expect(row.querySelector("input")!.type).toBe("password");
      expect(!!row.querySelector("input[type=url]")).toBe(!!address);
      if (address) setValue(row.querySelector<HTMLInputElement>("input[type=url]")!, address);
      await act(async () => row.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await settle(8);
      expect(called("setProviderKey").at(-1)?.args).toEqual(address ? ["stories", id, key, address] : ["stories", id, key]);
      const after = byText(".st-stg-keyrow", new RegExp(label), card("Providers"));
      expect(after.textContent).toContain(saved);
      expect(after.querySelector("input")).toBeNull();
      expect(host.innerHTML).not.toContain(key);
      expect(host.innerHTML).not.toContain("0123456789abcdef");
    }
  });

  it("says plainly when no provider needs a key", async () => {
    noKeyedMakers = true;
    await open("ai");
    expect(card("Providers").textContent).toContain("None of these providers needs a key");
  });
});

describe("Agents", () => {
  it("switches the quality agent off with the driving-safety rule shown", async () => {
    await open("agents");
    await click(byText("[role=radio]", /Quality check/));
    const sw = $<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Driving-safety videos are always checked.");
    await click(sw);
    expect(called("patchAgent").at(-1)?.args).toEqual(["stories", "quality_assurance", { active: false, version: 1 }]);
    expect($('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Quality check is off. Driving-safety videos are always checked.");
  });

  it("edits the instructions, saves them, and Reset puts the original back after Are you sure", async () => {
    await open("agents");
    const box = $<HTMLTextAreaElement>("textarea")!;
    expect(box.value).toContain("You are the creative director of Clips Funded");
    expect(byText("button", "Save the words").getAttribute("aria-disabled")).toBe("true");
    setValue(box, "Make every idea about Pip.");
    await click(byText("button", "Save the words"));
    expect(called("patchAgent").at(-1)?.args[2]).toMatchObject({ instructions: "Make every idea about Pip." });
    expect(host.textContent).toContain("Your words");
    await click(byText("button", "Reset"));
    expect($('[role="group"][aria-label="Are you sure?"]')).not.toBeNull();
    await click(byText("button", "Yes, reset"));
    expect(called("patchAgent").at(-1)?.args).toEqual(["stories", "creative_director", { reset: true }]);
    expect($<HTMLTextAreaElement>("textarea")!.value).toContain("You are the creative director of Clips Funded");
    expect(host.textContent).toContain("The original");
  });

  it("orders, adds and takes off its skills", async () => {
    await open("agents");
    const titles = () => $$(".st-stg-skilllist__title").map((t) => t.textContent);
    expect(titles()).toEqual(["Telling a story without words", "Hooks for short vertical videos", "Teaching driving safety honestly", "Slapstick timing"]);
    await click($('[aria-label="Move Slapstick timing up"]')!);
    expect(titles()).toEqual(["Telling a story without words", "Hooks for short vertical videos", "Slapstick timing", "Teaching driving safety honestly"]);
    expect(called("patchAgent").at(-1)?.args[2]).toMatchObject({ skillIds: ["nonverbal-storytelling", "vertical-short-hooks", "01JSLAPSTICKTIMING000000AA", "driving-safety-teaching"] });
    await click($('[aria-label="Take Hooks for short vertical videos off Creative director"]')!);
    expect(titles()).not.toContain("Hooks for short vertical videos");
    setValue($<HTMLSelectElement>(".st-stg-addskill select")!, "vertical-short-hooks");
    await click(byText("button", "Add it"));
    expect(titles().at(-1)).toBe("Hooks for short vertical videos");
  });

  it("gives an agent its own model and effort, or Workspace default", async () => {
    await open("agents");
    const [model, effort] = $$<HTMLSelectElement>(".st-stg-me select");
    expect(model!.options[0]?.textContent).toBe("Workspace default (Claude Opus 5.5)");
    setValue(model!, "fable-5-2");
    await settle();
    setValue(effort!, "low");
    await settle();
    expect(called("patchAgent").map((c) => c.args[2])).toEqual([expect.objectContaining({ model: "fable-5-2" }), expect.objectContaining({ effort: "low" })]);
    expect($(".st-stg-me .st-stg-active")?.textContent).toContain("Claude Fable 5.2 · Low");
  });
});

describe("Skills", () => {
  it("lists built-ins first, read-only, and shows which agents use each", async () => {
    await open("skills");
    const cards = $$(".st-stg-skill");
    expect(cards.slice(0, 3).every((c) => c.textContent?.includes("Comes with Clips Funded"))).toBe(true);
    expect(cards[0]!.textContent).toMatch(/Used by: Creative director, Video analysis, Storyboard, Character/);
    await click(byText("button", "Open", cards[0]!));
    await settle();
    expect($(".st-stg-pre")?.textContent).toMatch(/^---\nname: nonverbal-storytelling/);
    expect(host.textContent).toContain("so its words can't change");
    expect($$("button", cards[0]!).some((b) => b.textContent?.includes("Change it"))).toBe(false);
    expect($$("button", cards[0]!).some((b) => b.textContent?.includes("Delete"))).toBe(false);
  });

  it("switches a skill off and on", async () => {
    await open("skills");
    const sw = $<HTMLButtonElement>('[aria-label="Use Telling a story without words"]')!;
    await click(sw);
    expect(called("putSkill").at(-1)?.args).toEqual(["stories", "nonverbal-storytelling", { version: 1, enabled: false }]);
    expect($('[aria-label="Use Telling a story without words"]')?.getAttribute("aria-checked")).toBe("false");
  });

  it("writes a skill here, and every change is a version that can be brought back", async () => {
    await open("skills");
    await click(byText("button", /Write one here/));
    const form = $<HTMLFormElement>('form[aria-label="Write a skill"]')!;
    setValue(form.querySelector("#sk-title")!, "Bounce");
    setValue(form.querySelector("#sk-when")!, "When someone falls");
    setValue(form.querySelector("#sk-what")!, "Bounce once.");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(called("createSkill").at(-1)?.args[1]).toEqual({ title: "Bounce", description: "When someone falls", instructions: "Bounce once." });
    const mine = byText(".st-stg-skill", /Bounce/);
    expect(mine.textContent).toContain("Written by you");
    await click(byText("button", /Change it/, mine));
    setValue(mine.querySelector("textarea")!, "Bounce twice.");
    await act(async () => mine.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    const again = byText(".st-stg-skill", /Bounce/);
    expect($$(".st-stg-versions__row", again)).toHaveLength(2);
    await click(byText("button", "Bring it back", again));
    await settle(6);
    expect(called("restoreSkill")).toHaveLength(1);
    expect($$(".st-stg-versions__row", byText(".st-stg-skill", /Bounce/))).toHaveLength(3);
    expect($(".st-stg-pre", byText(".st-stg-skill", /Bounce/))?.textContent).toContain("Bounce once.");
  });

  it("uploads a SKILL.md with its progress, and refuses what is not a skill", async () => {
    await open("skills");
    const input = $<HTMLInputElement>('.st-stg-card input[type="file"]')!;
    const pickFile = async (file: File) => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    };
    await pickFile(new File(["hello"], "notes.txt"));
    await settle();
    expect(called("skillUpload")).toHaveLength(0);
    expect(document.body.textContent).toContain("That is not a skill.");
    await pickFile(new File(["---\nname: x\n---\nDo it."], "funny-falls.md"));
    await settle(2);
    expect($('[role="progressbar"][aria-label="Upload progress"]')).not.toBeNull();
    // While it uploads, the picker is aria-disabled (the deny sound), never `disabled`, and opens nothing.
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(input.closest("label")?.getAttribute("aria-disabled")).toBe("true");
    const tap = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => void input.dispatchEvent(tap));
    expect(tap.defaultPrevented).toBe(true);
    expect($$("[disabled]")).toEqual([]);
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(8);
    expect(called("createSkill").at(-1)?.args[1]).toMatchObject({ key: expect.stringMatching(/skills\/.+\/SKILL\.md$/) });
    expect(byText(".st-stg-skill", /Funny falls/).textContent).toContain("Uploaded file");
  });
});

describe("Memory", () => {
  it("adds, edits and deletes (with Undo) what Lamo Stories remembers", async () => {
    await open("memory");
    expect($$(".st-stg-mem")).toHaveLength(4);
    expect($$(".st-stg-mem")[0]!.textContent).toContain("From the chat");
    const box = $<HTMLTextAreaElement>("#mem-new")!;
    setValue(box, "Pip always waves at the end");
    expect(host.textContent).toContain("27 of 300 letters");
    await act(async () => box.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(6);
    expect(called("addMemory").at(-1)?.args).toEqual(["stories", "Pip always waves at the end"]);
    expect($$(".st-stg-mem")[0]!.textContent).toContain("You added it");
    await click(byText("button", /Change/, $$(".st-stg-mem")[0]!));
    setValue($<HTMLTextAreaElement>(".st-stg-mem textarea")!, "Pip waves twice at the end");
    await act(async () => $(".st-stg-mem form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(6);
    expect(called("patchMemory").at(-1)?.args.slice(2)).toEqual(["Pip waves twice at the end"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => byText("button", /Delete/, $$(".st-stg-mem")[0]!).dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect($$(".st-stg-mem")).toHaveLength(4);
    expect(called("deleteMemory")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(8100));
    vi.useRealTimers();
    await settle(6);
    expect(called("deleteMemory")).toHaveLength(1);
  });
});

describe("Video", () => {
  it("picks the makers apart from the AI models, each with its real state and what it still needs", async () => {
    await open("video");
    const labels = (g: string) => $$("[role=radio]", group(g)).map((r) => r.querySelector(".st-stg-pick__label")?.textContent);
    expect(labels("Video maker")).toEqual(["Built-in animator", "Luma AI Ray2", "Your own video model", "Amazon Nova Reel"]);
    // Amazon ended Nova Reel (§45.37): it reads ended and cannot be picked again.
    const reel = byText("[role=radio]", /Nova Reel/, group("Video maker"));
    expect(reel.getAttribute("aria-disabled")).toBe("true");
    expect(reel.textContent).toContain("Ended by Amazon on 30 Sep 2026.");
    // The owner's own video maker waits for one of his models.
    expect(byText("[role=radio]", /Your own video model/, group("Video maker")).textContent).toContain("Add your own video model below first.");
    const luma = byText("[role=radio]", /Luma AI Ray2/, group("Video maker"));
    expect(luma.getAttribute("aria-disabled")).toBeNull();
    expect(luma.textContent).toContain("Runs in the US (Oregon)");
    await click(luma);
    await settle();
    // Only this card's two fields (§45.37 G1): the API checks only what the body names.
    expect(called("patchWorkspace").at(-1)?.args[1]).toEqual({ configuration: { providers: { video: "luma-ray", videoModel: null } }, version: 3 });
    expect(byText("[role=radio]", /Luma AI Ray2/, group("Video maker")).textContent).toContain("Not ready yet");
    // Its one model, with who makes it, where it runs and that no price is known; and the API's not-ready sentence once,
    // said from this page (§45.36 E17): "Pick Built-in animation above", never "in Settings › Video".
    const details = $<HTMLElement>('[data-maker-model="luma-ray2"]', card("Video maker"))!;
    expect(details.textContent).toContain("Luma AI Ray2");
    expect(details.textContent).toContain("Luma AI on Amazon Bedrock · ");
    // Where it runs, said once (its note says it).
    expect(details.textContent?.split("Runs in the US (Oregon)")).toHaveLength(2);
    expect(details.textContent).toContain("No price known.");
    expect($$("[role=status]", card("Video maker")).map((n) => n.textContent)).toContain(LUMA_NOT_READY.replace(" in Settings › Video", " above"));
    expect(card("Video maker").textContent).not.toContain("in Settings › Video");
    await click(byText("[role=radio]", /Built-in animator/));
    await settle();
    expect($$(".st-stg-note[role=status]", card("Video maker")).filter((n) => n.textContent?.includes("not ready"))).toHaveLength(0);

    expect(labels("Picture maker")).toEqual(["Built-in drawings", "Also AI portraits (Stability AI)", "Also AI portraits (your own picture model)", "Amazon Nova Canvas"]);
    expect(byText("[role=radio]", /Nova Canvas/, group("Picture maker")).getAttribute("aria-disabled")).toBe("true");
    await click(byText("[role=radio]", /Stability AI/, group("Picture maker")));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toEqual({ configuration: { providers: { images: "stability", imageModel: null } }, version: 5 });
    // Stability AI has three models: the first is used until the owner picks another, each with its price line and status.
    const models = $$("[role=radio]", group("Picture maker's model"));
    expect(models.map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Stable Image Core", "Stable Image Ultra", "Stable Diffusion 3.5 Large"]);
    expect(models[0]!.getAttribute("aria-checked")).toBe("true");
    expect(models[1]!.textContent).toContain("Stability AI on Amazon Bedrock · Runs in the US (Oregon) · No price known");
    expect(models[1]!.textContent).toContain("Not checked yet");
    await click(models[1]!);
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toEqual({ configuration: { providers: { imageModel: "stable-image-ultra" } }, version: 6 });
    expect((workspace.configuration as StoriesConfig).providers).toMatchObject({ images: "stability", imageModel: "stable-image-ultra", video: "builtin-2d", audio: "builtin-synth" });
    expect($('[data-maker-model="stable-image-ultra"]', card("Picture maker"))?.textContent).toContain("Stable Image Ultra");
    expect(card("Picture maker").textContent).toContain("Make one portrait to check it works.");
  });

  it("the Sound maker saves (§45.37 G3): no voice unless the owner picks Amazon Polly, ElevenLabs makes effects and music", async () => {
    await open("video");
    const sound = () => card("Sound maker");
    expect(sound().textContent).toContain("No voice-over unless you pick a spoken voice.");
    const options = $$("[role=radio]", group("Sound maker"));
    expect(options.map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual([
      "Built-in sounds and music",
      "ElevenLabs sound effects and music",
      "Your own sound model",
      "A spoken voice (Amazon Polly)",
    ]);
    // The built-in sounds are the default; the voice is last and never picked by itself.
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");
    expect(options[3]!.textContent).toContain("Adds words spoken aloud. Your videos are made without a voice unless you pick this.");
    await click(byText("[role=radio]", /ElevenLabs/, group("Sound maker")));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { audio: "elevenlabs", audioModel: null } } });
    // Both of its models are used: the effects and the music bed, never its voices.
    const list = $<HTMLElement>('[aria-label="ElevenLabs models"]', sound())!;
    expect($$("[data-maker-model]", list).map((m) => m.getAttribute("data-maker-model"))).toEqual(["elevenlabs-effects", "elevenlabs-music"]);
    expect(sound().textContent).not.toContain("Your videos now have a spoken voice.");
    await click(byText("[role=radio]", /Amazon Polly/, group("Sound maker")));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { audio: "polly", audioModel: null } } });
    expect(sound().textContent).toContain("Your videos now have a spoken voice. To make them without one, pick Built-in sounds and music.");
    expect(sound().textContent).toContain("Runs in Europe (Ireland)");
    await click(byText("[role=radio]", /Built-in sounds and music/, group("Sound maker")));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { audio: "builtin-synth" } } });
    expect(sound().textContent).not.toContain("spoken voice. To make");
    // A sound maker's change never re-sends the picture or video picks (an older stored pick never blocks it).
    for (const c of called("patchWorkspace")) expect(Object.keys((c.args[1] as { configuration: { providers: object } }).configuration.providers).sort()).toEqual(["audio", "audioModel"]);
  });

  it("an older pick of an ended maker says so, with a one-tap replacement; nothing swaps by itself (§45.37)", async () => {
    workspace.configuration = { ...(workspace.configuration as StoriesConfig), providers: { images: "nova-canvas", video: "nova-reel", audio: "builtin-synth" } };
    await open("video");
    const video = card("Video maker");
    expect(video.textContent).toContain("Ended by Amazon on 30 Sep 2026.");
    expect(video.textContent).toContain("New videos stop until you pick another video maker");
    expect(called("patchWorkspace")).toHaveLength(0);
    // Try it is Luma AI Ray2's now, never Nova Reel's.
    expect($('[data-provider="nova-reel"]')).toBeNull();
    expect($('[data-provider="luma-ray"]')).not.toBeNull();
    await click(byText("button", "Use Luma AI Ray2", video));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { video: "luma-ray", videoModel: null } } });
    const pictures = card("Picture maker");
    expect(pictures.textContent).toContain("AI portraits stop until you pick another picture maker");
    await click(byText("button", "Use Built-in drawings", pictures));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { images: "builtin-rig", imageModel: null } } });
  });

  it("takes the owner's price for the AI makers, kept in the AI settings as a price for one unit (§45.34)", async () => {
    await open("video");
    const makerPrices = () => $<HTMLElement>('[aria-label="Each maker\'s price"]')!;
    const reel = byText(".st-stg-price", /Amazon Nova Reel/, makerPrices());
    expect(reel.textContent).toContain("No price set.");
    expect(byText(".st-stg-price", /Amazon Nova Canvas/, makerPrices()).textContent).toContain("No price set.");
    await click(byText("button", "Type a price", reel));
    setValue(reel.querySelector("input")!, "a lot");
    await act(async () => reel.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(4);
    expect(called("putAi")).toHaveLength(0);
    expect(document.body.textContent).toContain("Type the price for a second of video as a number, like 0.08.");
    setValue(reel.querySelector("input")!, "0.08");
    await act(async () => reel.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ prices: { "nova-reel": { perUnit: 0.08, unit: "second", inputPer1M: 0, outputPer1M: 0, currency: "USD", source: "owner" } }, version: 0 });
    expect(store.ai?.prices["nova-reel"]).toMatchObject({ perUnit: 0.08, unit: "second" });
    const after = byText(".st-stg-price", /Amazon Nova Reel/, makerPrices());
    expect(after.textContent).toContain("Your price");
    expect(after.textContent).toMatch(/\$0\.08 for a second of video/);
    await click(byText("button", "Remove my price", after));
    await settle(6);
    expect(store.ai?.prices).toEqual({});
    expect(byText(".st-stg-price", /Amazon Nova Reel/, makerPrices()).textContent).toContain("No price set.");
  });

  it("picks the shape and its size: 9:16, 1:1 and 16:9 with their own sizes; 30 fps; saves quality and length (§45.34)", async () => {
    await open("video");
    const shapes = $$("[role=radio]", group("Shape of the video"));
    expect(shapes.map((s) => [s.querySelector(".st-stg-pick__label")?.textContent, s.getAttribute("aria-disabled")])).toEqual([
      ["9:16 tall", null],
      ["1:1 square", null],
      ["16:9 wide", null],
    ]);
    expect(shapes[0]!.textContent).toContain("For Shorts, Reels and TikTok");
    expect(card("Shape and size").textContent).toContain("Change it per video in Production › New.");
    const sizes = () => $$("[role=radio]", group("Size of the video")).map((r) => r.querySelector(".st-stg-pick__label")?.textContent);
    expect(sizes()).toEqual(["1080 × 1920", "720 × 1280"]);
    expect(host.textContent).toContain("30 frames a second (30 fps)");
    expect(host.textContent).not.toContain("the built-in animator's only size");

    await click(byText("[role=radio]", /1:1 square/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { aspect: "1:1", resolution: "1080x1080", quality: "high", fps: 30 } }, version: 3 });
    expect(sizes()).toEqual(["1080 × 1080", "720 × 720"]);
    expect(card("Shape and size").querySelector("[role=status]")?.textContent).toBe("Shorts, Reels and TikTok want 9:16. A square video shows smaller there, with bars around it.");
    await click(byText("[role=radio]", /720 × 720/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { aspect: "1:1", resolution: "720x720" } } });
    // A new shape keeps the sharpness picked: the smaller size stays small.
    await click(byText("[role=radio]", /16:9 wide/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { aspect: "16:9", resolution: "1280x720" } } });
    expect(sizes()).toEqual(["1920 × 1080", "1280 × 720"]);
    await click(byText("[role=radio]", /9:16 tall/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { aspect: "9:16", resolution: "720x1280" } } });
    expect(card("Shape and size").querySelector("[role=status]")).toBeNull();

    await click(byText("[role=radio]", /^Best/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { quality: "best", resolution: "720x1280", aspect: "9:16", fps: 30 } } });
    await click($('[aria-label="5 seconds longer"]')!);
    expect($(".st-stg-length__value strong")?.textContent).toBe("50");
    expect(called("patchWorkspace").at(-1)?.args[1]).not.toMatchObject({ configuration: { defaultDurationSec: 50 } });
    await act(async () => await new Promise((r) => setTimeout(r, 520)));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { defaultDurationSec: 50 } });
    expect(host.textContent).toContain("Best length");
  });

  it("shows render minutes per day and each maker's units and cost, by name; No price yet opens that maker's price (§45.34)", async () => {
    await open("video");
    const use = card("Use and costs, last 30 days");
    expect(use.querySelectorAll(".st-stg-chart__day")).toHaveLength(30);
    expect(use.querySelector(".st-stg-chart")?.getAttribute("aria-label")).toMatch(/^Minutes of video made each day for the last 30 days\. The busiest day was .+, with [\d.]+ minutes?\.$/);
    expect(use.querySelector(".st-stg-active")?.textContent).toMatch(/Rendering, last 30 days[\d.]+ minutes/);
    const builtin = byText(".st-stg-usage__row", /Built-in animator/, use);
    expect(builtin.textContent).toMatch(/minutes of rendering|seconds of rendering/);
    expect(builtin.textContent).toContain("Free: it runs on Clips Funded's own computer");
    const canvas = byText(".st-stg-usage__row", /Amazon Nova Canvas/, use);
    expect(canvas.textContent).toMatch(/\d+ pictures?/);
    expect(canvas.textContent).toContain("No price yet:");
    // Makers are named, never shown by their ids.
    expect(use.textContent).not.toMatch(/builtin-rig|nova-canvas/);
    await click(byText("button", "add one", canvas));
    const form = byText(".st-stg-price", /Amazon Nova Canvas/, $<HTMLElement>('[aria-label="Each maker\'s price"]')!);
    setValue(form.querySelector("input")!, "0.04");
    await act(async () => form.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(10);
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ prices: { "nova-canvas": { perUnit: 0.04, unit: "image" } } });
    expect(called("usage").length).toBeGreaterThan(1);
    const priced = byText(".st-stg-usage__row", /Amazon Nova Canvas/, card("Use and costs, last 30 days"));
    expect(priced.textContent).not.toContain("No price yet");
    expect(priced.textContent).toMatch(/\$0\.\d+/);
    await click(byText("button", "Show each day", card("Use and costs, last 30 days")));
    expect($$(".st-stg-days__day", card("Use and costs, last 30 days")).length).toBeGreaterThan(5);
  });

  it("shows Remove the saved key only while a key is saved (ProviderStatus.key, §45.34)", async () => {
    providers.push({ kind: "animation", id: "acme-motion", label: "Acme Motion", state: "needs_setup", line: "Paste your Acme Motion key to use it.", key: { saved: false, hint: null, savedAt: null } });
    store.knobs.keyedProviders = [{ kind: "animation", id: "acme-motion", label: "Acme Motion" }];
    await open("video");
    const row = () => byText(".st-stg-keyrow", /Acme Motion/);
    expect(row().textContent).not.toContain("Remove the saved key");
    await click(byText("button", "Paste a key", row()));
    setValue(row().querySelector("input")!, "sk-acme-0123456789abcdef4f2a");
    await act(async () => row().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(row().textContent).toContain("Key saved · ends 4f2a.");
    expect(byText("button", "Remove the saved key", row())).toBeTruthy();
    expect(byText("button", "Paste a new key", row())).toBeTruthy();
    await click(byText("button", "Remove the saved key", row()));
    expect(row().textContent).not.toContain("Remove the saved key");
    expect(row().textContent).toContain("Paste your Acme Motion key to use it.");
  });

  it("never promises backgrounds or that the built-in animation takes over for Nova Reel", async () => {
    const { MAKERS } = await import("../src/stories/settings/VideoSection.tsx");
    expect(MAKERS["nova-reel"]!.line).toContain("cut-aways (scenes with no character)");
    expect(MAKERS["nova-reel"]!.line).not.toContain("backgrounds");
    await open("video");
    expect(host.textContent).not.toContain("backgrounds");
    expect(host.textContent).not.toMatch(/built-in animation makes/i);
  });
});

describe("Storage and production", () => {
  it("shows the space used by kind, MP4 H.264/AAC, and saves burned-in captions, scenes at once and old versions", async () => {
    store.assets = [
      { assetId: "1", kind: "final_video", storyId: "s", characterId: null, title: "A", url: "", contentType: "video/mp4", bytes: 40_000_000, version: 1, createdAt: "", meta: {} },
      { assetId: "2", kind: "scene_clip", storyId: "s", characterId: null, title: "A", url: "", contentType: "video/mp4", bytes: 9_000_000, version: 1, createdAt: "", meta: {} },
    ];
    await open("storage");
    await settle(4);
    expect(byText(".st-stg-usage__row", /Finished videos/).textContent).toContain("40.0 MB");
    expect(byText(".st-stg-usage__row", /Scenes and storyboards/).textContent).toContain("9.0 MB");
    expect(host.textContent).toContain("MP4: H.264 picture and AAC sound");
    await click(byText("[role=switch]", /On|Off/, card("The finished file")));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { burnCaptions: false, scenesAtOnce: 2, keepVersions: "all" } } });
    await click(byText("[role=radio]", /Three at a time/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { scenesAtOnce: 3 } } });
    await click(byText("[role=radio]", /Keep only the last few/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { keepVersions: 3 } } });
    await click($('[aria-label="Keep one more"]')!);
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { keepVersions: 4 } } });
    expect(host.textContent).toContain("The last 4 versions");
    await click(byText("[role=radio]", /^Only me/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { youtubePrivacy: "private" } });
  });
});

describe("AI: models the owner adds (§45.34)", () => {
  const fill = (form: HTMLElement, label: string, value: string) => {
    const lab = Array.from(form.querySelectorAll("label")).find((l) => l.textContent === label);
    if (!lab) throw new Error(`no field ${label}`);
    setValue(form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${CSS.escape(lab.htmlFor)}`)!, value);
  };
  const submit = async (form: HTMLElement) => {
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
  };

  it("adds a Bedrock model with its maker, id, Region, efforts, own level, pictures, output limit and price; then suggests Check models", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open("ai");
    const add = card("Add a model");
    expect(add.textContent).toContain("No models added yet.");
    await click(byText("button", "Add a model", add));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    // Nothing is sent until the form says what it is.
    await submit(form);
    expect(called("putAiModel")).toHaveLength(0);
    expect(form.querySelector("[role=alert]")?.textContent).toBe("Give the model a name, like Nova Premier.");
    fill(form, "Name", "Nova Premier");
    await click(byText("[role=radio]", "Amazon", form));
    fill(form, "Model ID", "eu.amazon.nova premier");
    await submit(form);
    expect(called("putAiModel")).toHaveLength(0);
    expect(form.querySelector("[role=alert]")?.textContent).toContain("does not look like a Bedrock model ID");
    fill(form, "Model ID", "eu.amazon.nova-premier-v1:0");
    fill(form, "AWS Region", "eu-west-1");
    // How it is called (§45.35 D1): an Amazon model starts with no effort levels, no tools and the prompt cache on;
    // the levels show once the owner says it has them.
    const sw = (name: RegExp) => byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", name, form));
    expect([sw(/It has effort levels/), sw(/It can use tools/), sw(/It can reuse its instructions/)].map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(Array.from(form.querySelectorAll("button")).some((b) => b.textContent === "Low")).toBe(false);
    await click(sw(/It has effort levels/));
    // Efforts: toggles, more than one; its own level is one of them.
    await click(byText("button", "Low", form));
    await click(byText("button", /High$/, form));
    expect($$("[aria-pressed=true]", form).map((b) => b.textContent)).toEqual(["Low", "High"]);
    expect($$("[role=radio]", group("Its own level")).map((r) => r.textContent)).toEqual(["Low", "High"]);
    await click(byText("[role=radio]", "High", group("Its own level")));
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /It can look at pictures/, form)));
    fill(form, "Most tokens it may write in one answer", "8000");
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /I know its price/, form)));
    fill(form, "Reading, per million tokens", "2.5");
    fill(form, "Writing, per million tokens", "12.5");
    await submit(form);
    expect(called("putAiModel").at(-1)?.args).toEqual([
      "stories",
      "custom-nova-premier",
      {
        label: "Nova Premier",
        provider: "Amazon",
        modelId: "eu.amazon.nova-premier-v1:0",
        region: "eu-west-1",
        efforts: ["low", "high"],
        defaultEffort: "high",
        vision: true,
        maxOutputTokens: 8000,
        price: { inputPer1M: 2.5, outputPer1M: 12.5, cacheReadPer1M: null, cacheWritePer1M: null, longContext: null, currency: "USD", source: "owner", note: "Your own price." },
        effortField: "output_config",
        tools: false,
        cache: true,
      },
    ]);
    // Listed with its mark, everywhere a model is picked.
    const row = byText(".st-stg-own", /Nova Premier/, card("Add a model"));
    expect(row.textContent).toContain("Added by you");
    expect(row.textContent).toContain("Not checked yet");
    expect(row.textContent).toContain("Made by Amazon · on Amazon Bedrock in eu-west-1");
    expect(byText("[role=radio]", /Nova Premier/, group("Default model")).textContent).toContain("Added by you");
    const director = $$(".st-stg-assign__row").find((r) => r.textContent?.includes("Creative director"))!;
    expect(Array.from(director.querySelector("select")!.options).map((o) => o.value)).toContain("custom-nova-premier");
    // Check models is suggested, for this model only.
    const suggest = card("Add a model").querySelector(".st-stg-suggest")!;
    expect(suggest.textContent).toContain("Nova Premier is listed, but it has not answered yet.");
    await click(byText("button", "Check models", suggest as HTMLElement));
    expect(called("checkModels").at(-1)?.args).toEqual(["stories", ["custom-nova-premier"]]);
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(10);
    expect(byText(".st-stg-own", /Nova Premier/, card("Add a model")).textContent).toContain("Works");
    expect(card("Add a model").querySelector(".st-stg-suggest")).toBeNull();
  });

  it("a model Amazon Bedrock refuses keeps Bedrock's sentence; nothing is swapped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await aiPart.api(store).putAiModel("stories", "custom-llama", { label: "Llama 4", provider: "Meta", modelId: "eu.meta.llama4-typo-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 4096, price: null });
    store.knobs.bedrockUnknown = "custom-llama";
    await open("ai");
    await click(byText("button", "Check models", card("Default model")));
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(10);
    const row = byText(".st-stg-own", /Llama 4/, card("Add a model"));
    expect(row.textContent).toContain("Not found");
    expect(row.textContent).toContain("Amazon Bedrock said: The provided model identifier is invalid");
    expect(row.textContent).toContain("No effort setting: it runs at its own level.");
  });

  it("changes one with Edit, and Remove shows the API's sentence while a setting still uses it", async () => {
    await aiPart.api(store).putAiModel("stories", "custom-mistral", { label: "Mistral Large", provider: "Mistral", modelId: "mistral.mistral-large-2407-v1:0", region: "eu-west-3", efforts: ["low", "medium"], defaultEffort: "medium", vision: false, maxOutputTokens: 8192, price: null });
    await open("ai");
    await click(byText("button", "Edit", byText(".st-stg-own", /Mistral Large/)));
    const form = $<HTMLElement>('form[aria-label="Change Mistral Large"]')!;
    expect(form.querySelector<HTMLInputElement>("input")!.value).toBe("Mistral Large");
    expect(byText("[role=radio]", "Mistral", form).getAttribute("aria-checked")).toBe("true");
    expect(Array.from(form.querySelectorAll("select")).map((x) => x.value)).toContain("eu-west-3");
    fill(form, "Name", "Mistral Large 2");
    await submit(form);
    expect(called("putAiModel").at(-1)?.args.slice(0, 2)).toEqual(["stories", "custom-mistral"]);
    expect(called("putAiModel").at(-1)?.args[2]).toMatchObject({ label: "Mistral Large 2", maxOutputTokens: 8192, region: "eu-west-3", efforts: ["low", "medium"], defaultEffort: "medium" });
    expect(byText(".st-stg-own", /Mistral Large 2/).textContent).toContain("Added by you");

    // A task uses it: removing it is refused with the API's own sentence, shown on the row.
    const story = $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the story")!;
    setValue(story.querySelectorAll<HTMLSelectElement>("select")[0]!, "custom-mistral");
    await settle();
    await click(byText("button", "Remove", byText(".st-stg-own", /Mistral Large 2/)));
    await click(byText("button", "Yes, remove it"));
    expect(called("deleteAiModel").at(-1)?.args).toEqual(["stories", "custom-mistral"]);
    expect(byText(".st-stg-own", /Mistral Large 2/).querySelector("[role=alert]")?.textContent).toBe("Mistral Large 2 is still used by the task Write the story below. Pick another model there first.");
    // Once nothing uses it, it goes.
    setValue($$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the story")!.querySelectorAll<HTMLSelectElement>("select")[0]!, "");
    await settle();
    await click(byText("button", "Remove", byText(".st-stg-own", /Mistral Large 2/)));
    await click(byText("button", "Yes, remove it"));
    expect($$(".st-stg-own").some((r) => r.textContent?.includes("Mistral Large 2"))).toBe(false);
    expect(document.body.textContent).toContain("Mistral Large 2 is removed from Clips Funded.");
  });

  it("an Edit that moves a model asks for a new check even after Works; Another Region takes any code; up to 500,000 tokens; every select marks it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = aiPart.api(store);
    await api.putAiModel("stories", "custom-mistral", { label: "Mistral Large", provider: "Mistral", modelId: "mistral.mistral-large-2407-v1:0", region: "eu-west-3", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 8192, price: null });
    await api.checkModels("stories", ["custom-mistral"]);
    await act(async () => await new Promise((r) => setTimeout(r, 80)));
    await open("ai");
    expect(byText(".st-stg-own", /Mistral Large/).textContent).toContain("Works");
    // Every agent and task select marks the models the owner added.
    const options = () => Array.from($$(".st-stg-assign__row").find((r) => r.textContent?.includes("Creative director"))!.querySelector("select")!.options);
    expect(options().find((o) => o.value === "custom-mistral")?.textContent).toBe("Mistral Large · added by you");
    expect(options().find((o) => o.value === "opus-5-5")?.textContent).not.toContain("added by you");
    // A new name only: its check still counts, nothing to suggest.
    await click(byText("button", "Edit", byText(".st-stg-own", /Mistral Large/)));
    let form = $<HTMLElement>('form[aria-label="Change Mistral Large"]')!;
    fill(form, "Name", "Mistral Large 2");
    await submit(form);
    expect(card("Add a model").querySelector(".st-stg-suggest")).toBeNull();
    // Another Region: any Region code, checked as the API checks it.
    await click(byText("button", "Edit", byText(".st-stg-own", /Mistral Large 2/)));
    form = $<HTMLElement>('form[aria-label="Change Mistral Large 2"]')!;
    fill(form, "AWS Region", "another");
    fill(form, "Its Region code", "London");
    await submit(form);
    expect(form.querySelector("[role=alert]")?.textContent).toBe("Type the AWS Region code where the model runs, like eu-west-2 or ap-south-1.");
    fill(form, "Its Region code", "ap-southeast-5");
    fill(form, "Most tokens it may write in one answer", "300000");
    await submit(form);
    expect(called("putAiModel").at(-1)?.args[2]).toMatchObject({ region: "ap-southeast-5", maxOutputTokens: 300000 });
    // Its last check (Works) was of the old Region and is kept by the API: the card says so and suggests Check models.
    const row = byText(".st-stg-own", /Mistral Large 2/);
    expect(row.textContent).toContain("Check it again");
    expect(row.textContent).toContain("Changed since its last check.");
    expect(row.textContent).not.toContain("Works");
    const suggest = card("Add a model").querySelector<HTMLElement>(".st-stg-suggest")!;
    expect(suggest.textContent).toContain("Mistral Large 2 is changed, so its last check no longer counts.");
    await click(byText("button", "Check models", suggest));
    expect(called("checkModels").at(-1)?.args).toEqual(["stories", ["custom-mistral"]]);
    await act(async () => await new Promise((r) => setTimeout(r, 1300)));
    await settle(10);
    expect(card("Add a model").querySelector(".st-stg-suggest")).toBeNull();
    expect(byText(".st-stg-own", /Mistral Large 2/).textContent).toContain("Works");
    expect(byText(".st-stg-own", /Mistral Large 2/).textContent).toContain("in ap-southeast-5");
    // A Region not in the list opens as Another Region with its code, never as a listed one.
    await click(byText("button", "Edit", byText(".st-stg-own", /Mistral Large 2/)));
    form = $<HTMLElement>('form[aria-label="Change Mistral Large 2"]')!;
    expect(Array.from(form.querySelectorAll("select")).map((x) => x.value)).toContain("another");
    const code = Array.from(form.querySelectorAll("label")).find((l) => l.textContent === "Its Region code")!;
    expect(form.querySelector<HTMLInputElement>(`#${CSS.escape(code.htmlFor)}`)!.value).toBe("ap-southeast-5");
  });

  it("the default model and effort cards say what was picked (picked), and a held model is saved with the level picked for it", async () => {
    await aiPart.api(store).putAiModel("stories", "custom-quick", { label: "Quick One", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: ["low", "medium"], defaultEffort: "medium", vision: false, maxOutputTokens: 4096, price: null });
    await open("ai");
    await click(byText("[role=radio]", /Claude Sonnet 5\.5/));
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultModel: "sonnet-5-5", picked: ["model"] });
    await click(byText("[role=radio]", "Low", group("Default effort")));
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultEffort: "low", picked: ["effort"] });
    // Quick One offers Low and Medium; today's Low is fine, so it is saved as the model alone.
    await click(byText("[role=radio]", /Quick One/));
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultModel: "custom-quick", defaultEffort: "low", picked: ["model"] });
    // Back to Opus at Maximum, then Quick One: Maximum is not offered, so nothing is saved until a level is picked.
    await click(byText("[role=radio]", /Claude Opus 5\.5/));
    await click(byText("[role=radio]", "Maximum", group("Default effort")));
    const before = called("putAi").length;
    await click(byText("[role=radio]", /Quick One/));
    expect(called("putAi")).toHaveLength(before);
    expect(card("Default effort").querySelector("[role=alert]")?.textContent).toContain("Quick One does not offer Maximum. Pick another level.");
    await click(byText("[role=radio]", /^Medium/, group("Default effort")));
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ defaultModel: "custom-quick", defaultEffort: "medium", picked: ["model", "effort"] });
    // A task's own change says nothing was picked for the setup.
    const captions = $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the post captions")!;
    await click(byText("button", "Use it", captions));
    expect(called("putAi").at(-1)?.args[1]).not.toHaveProperty("picked");
  });

  it("sends only the configuration's own keys, whatever else the API answered", async () => {
    await open("ai");
    // An answer with a field the PUT does not take (for example a stamp the API may add later).
    store.ai = { ...(store.ai ?? { defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 0 }), pickedAt: { model: "x" } } as never;
    forgetLoaded();
    act(() => root.unmount());
    root = createRoot(host);
    await open("ai");
    await click(byText("[role=radio]", "Low", group("Default effort")));
    expect(Object.keys(called("putAi").at(-1)?.args[1] as object).sort()).toEqual(["defaultEffort", "defaultModel", "picked", "prices", "tasks", "version"]);
  });

  it("a model with no effort setting takes no effort in the same setting: the row's own effort is cleared, and it says why", async () => {
    await open("ai");
    const story = () => $$(".st-stg-assign__row").find((r) => r.querySelector(".st-stg-assign__title")?.textContent === "Write the story")!;
    setValue(story().querySelectorAll<HTMLSelectElement>("select")[1]!, "low");
    await settle();
    expect(called("putAi").at(-1)?.args[1]).toMatchObject({ tasks: { storyboard: { effort: "low" } } });
    setValue(story().querySelectorAll<HTMLSelectElement>("select")[0]!, "nova-pro");
    await settle();
    expect((called("putAi").at(-1)?.args[1] as { tasks: Record<string, unknown> }).tasks.storyboard).toEqual({ model: "nova-pro" });
    expect(document.body.textContent).toContain("Amazon Nova Pro has no effort setting; it runs at its own level. Write the story's own effort is cleared.");
    expect(document.body.textContent).not.toContain("Pick another level.");
  });
});

describe("Storage and production (§45.34)", () => {
  it("says where the files are, keeps reference videos and chat pictures as picked, and Clean up now says what it cleared", async () => {
    await open("storage");
    await settle(4);
    // The place in words; the exact folder one tap away (§45.36 E14).
    expect(card("Space used").textContent).toContain("Clips Funded's own folder in Clip Factory's media storage in Europe (Stockholm).");
    expect(card("Space used").querySelector("details.st-tech-fold")?.textContent).toContain("ws/{you}/stories/");
    const refs = group("Keep reference videos");
    expect($$("[role=radio]", refs).map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Keep them all", "Keep only the study", "30 days", "90 days"]);
    // By age only the video goes: its study stays, as the API and the agent keep it (retention.py, fileRemovedAt).
    for (const days of [/30 days/, /90 days/]) {
      expect(byText("[role=radio]", days, refs).textContent).toContain("Then the video goes; its study stays");
      expect(byText("[role=radio]", days, refs).textContent).not.toContain("its study go");
    }
    expect(byText("[role=radio]", /Keep them all/, refs).getAttribute("aria-checked")).toBe("true");
    await click(byText("[role=radio]", /Keep only the study/, refs));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { keepReferences: "study_only", burnCaptions: true, scenesAtOnce: 2, keepVersions: "all" } } });
    expect(card("Keeping other files").textContent).toContain("Clips Funded still learns from each study after its video is gone.");
    await click(byText("[role=radio]", /30 days/, group("Keep chat pictures")));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { keepReferences: "study_only", keepChatPictures: "days_30" } } });

    // Clean up now: an "Are you sure?" first, then what was cleared, with a cheer.
    store.workspaces[0] = workspace;
    await click(byText("button", "Clean up now"));
    expect(called("storageCleanup")).toHaveLength(0);
    expect(card("Keeping other files").querySelector('[aria-label="Are you sure?"]')?.textContent).toContain("Clip Factory's files are never touched.");
    const storageCalls = called("storage").length;
    await click(byText("button", "Yes, clear them"));
    expect(called("storageCleanup")).toHaveLength(1);
    expect(card("Keeping other files").querySelector("[role=status]")?.textContent).toBe("Cleared 14 files (186 MB). The rest is kept.");
    expect(called("storage").length).toBeGreaterThan(storageCalls);
    // Again: nothing left to clear.
    await click(byText("button", "Clean up now"));
    await click(byText("button", "Yes, clear them"));
    expect(card("Keeping other files").querySelector("[role=status]")?.textContent).toBe("Nothing to clear: every file is still one you keep.");
  });

  it("makes WebM and MOV besides the MP4 when asked, and says what burned-in captions leave out", async () => {
    await open("storage");
    const file = card("The finished file");
    expect(file.textContent).toContain("MP4: H.264 picture and AAC sound");
    expect(file.textContent).toContain("1080 × 1920 (9:16) at 30 fps");
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /Also make a WebM file/, file)));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { extraFormats: ["webm"] } } });
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /Also make a MOV file/, file)));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { extraFormats: ["webm", "mov"] } } });
    expect(file.textContent).toContain("A big file for editing apps like Final Cut or Premiere");
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /Also make a WebM file/, file)));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { production: { extraFormats: ["mov"] } } });
    await click(byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", /Put the captions into the picture/, file)));
    expect(byText(".st-stg-switchrow", /Put the captions into the picture/, file).textContent).toContain(
      "Only the captions are left out. Speech bubbles and the safety end card always stay in.",
    );
  });

  it("keeps this device's sounds and motion for Lamo Stories in cf.stories.prefs, apart from Clip Factory's", async () => {
    localStorage.removeItem("cf.stories.prefs");
    const { resetWorkspaceMemory } = await import("../src/stories/workspace.ts");
    resetWorkspaceMemory();
    const clipsBefore = localStorage.getItem("cf.prefs");
    await open("storage");
    const sm = card("Sounds and motion");
    // Its own choices from the start (§45.38 A2): nothing on the card follows Clip Factory's settings.
    expect(sm.textContent).not.toContain("Follows Clip Factory");
    const sw = (label: RegExp) => byText(".st-stg-switchrow", label, sm).querySelector<HTMLElement>("[role=switch]")!;
    const picker = () => byText(".st-stg-selectbox", /^Click sound/, sm).querySelector<HTMLSelectElement>("select")!;
    const errors = () => byText(".st-stg-selectbox", /^Error sound/, sm).querySelector<HTMLSelectElement>("select")!;
    const kept = () => (JSON.parse(localStorage.getItem("cf.stories.prefs") ?? "{}") as { more?: Record<string, unknown> }).more ?? {};
    // Unset, the card shows what Lamo Stories really uses: its own usual choices (sounds on, Water drop, Nope nope nope).
    expect(sw(/^Sounds/).getAttribute("aria-checked")).toBe("true");
    expect(picker().value).toBe("6");
    expect(errors().value).toBe("5");
    expect(picker().options).toHaveLength(30);
    expect(errors().options).toHaveLength(30);
    expect(picker().options[2]?.textContent).toBe("Bubble: rises a little");
    // The click sound is kept as its number (the shape Lamo Stories' sounds read), and it plays once picked.
    const log = () => (window as unknown as { __cfSoundLog?: { kind: string; sound: number }[] }).__cfSoundLog ?? [];
    setValue(picker(), "3");
    await settle();
    expect(kept()["sound.click"]).toBe(3);
    expect(log().at(-1)).toMatchObject({ kind: "tap", sound: 3 });
    await click(byText("button", "Hear it", sm));
    expect(log().at(-1)).toMatchObject({ kind: "tap", sound: 3 });
    // Its own error sound too, kept as its number, and heard once picked.
    setValue(errors(), "8");
    await settle();
    expect(kept()["sound.deny"]).toBe(8);
    expect(log().at(-1)).toMatchObject({ kind: "deny", sound: 8 });
    await click(sw(/^Less motion/));
    expect(kept()).toMatchObject({ "sound.click": 3, "sound.deny": 8, "motion.reduce": true });
    // Sounds off turns every click sound off; the pickers and Hear it wait until it is on again.
    await click(sw(/^Sounds/));
    expect(kept()["sound.enabled"]).toBe(false);
    expect(picker().getAttribute("aria-disabled")).toBe("true");
    expect(errors().getAttribute("aria-disabled")).toBe("true");
    expect(byText("button", "Hear it", sm).getAttribute("aria-disabled")).toBe("true");
    setValue(picker(), "9");
    expect(kept()["sound.click"]).toBe(3);
    expect(localStorage.getItem("cf.prefs")).toBe(clipsBefore);
    await click(byText("button", "Use the usual settings again", sm));
    expect(kept()).not.toHaveProperty("sound.enabled");
    expect(kept()).not.toHaveProperty("sound.click");
    expect(kept()).not.toHaveProperty("sound.deny");
    expect(kept()).not.toHaveProperty("motion.reduce");
    expect(picker().value).toBe("6");
    expect(localStorage.getItem("cf.prefs")).toBe(clipsBefore);
  });
});

describe("quick changes are never lost", () => {
  it("AI: a change made while the last save is reloading is sent too, and the screen keeps it", async () => {
    await open("ai");
    const release = hold("getAi");
    await click(byText("[role=radio]", "Low"));
    expect(called("putAi").map((c) => (c.args[1] as { defaultEffort: string }).defaultEffort)).toEqual(["low"]);
    await click(byText("[role=radio]", /^Medium/, group("Default effort")));
    expect(byText("[role=radio]", /^Medium/, group("Default effort")).getAttribute("aria-checked")).toBe("true");
    await act(async () => release());
    await settle(10);
    expect(called("putAi").map((c) => (c.args[1] as { defaultEffort: string }).defaultEffort)).toEqual(["low", "medium"]);
    expect(store.ai?.defaultEffort).toBe("medium");
    expect(byText("[role=radio]", /^Medium/, group("Default effort")).getAttribute("aria-checked")).toBe("true");
    expect($(".st-stg-active")?.textContent).toContain("Effort: Medium");
    expect(document.body.textContent).not.toContain("changed while you were looking");
  });

  it("Storage: a tap made while the next save is on its way starts from what is on screen", async () => {
    await open("storage");
    await click(byText("[role=radio]", /Keep only the last few/));
    expect(host.textContent).toContain("The last 3 versions");
    const first = hold("patchWorkspace");
    await click($('[aria-label="Keep one more"]')!);
    await click($('[aria-label="Keep one more"]')!);
    expect(host.textContent).toContain("The last 5 versions");
    // The first answer (4) comes back while the next save (5) is still on its way: the screen stays at 5.
    const second = hold("patchWorkspace");
    await act(async () => first());
    await settle(6);
    expect(host.textContent).toContain("The last 5 versions");
    await click($('[aria-label="Keep one more"]')!);
    expect(host.textContent).toContain("The last 6 versions");
    await act(async () => second());
    await settle(10);
    expect(host.textContent).toContain("The last 6 versions");
    expect((workspace.configuration as StoriesConfig).production.keepVersions).toBe(6);
    expect(called("patchWorkspace").map((c) => (c.args[1] as { configuration: StoriesConfig }).configuration.production.keepVersions)).toEqual([3, 4, 5, 6]);
  });

  it("Agents: three quick moves of a skill are all kept, each on the version the last answer gave", async () => {
    await open("agents");
    const titles = () => $$(".st-stg-skilllist__title").map((t) => t.textContent);
    const down = () => $('[aria-label="Move Telling a story without words down"]')!;
    const first = hold("patchAgent");
    await click(down());
    await click(down());
    expect(titles()).toEqual(["Hooks for short vertical videos", "Teaching driving safety honestly", "Telling a story without words", "Slapstick timing"]);
    // The first answer comes back while the second move is on its way: the screen keeps both moves.
    const second = hold("patchAgent");
    await act(async () => first());
    await settle(6);
    expect(titles()).toEqual(["Hooks for short vertical videos", "Teaching driving safety honestly", "Telling a story without words", "Slapstick timing"]);
    await click(down());
    expect(titles()).toEqual(["Hooks for short vertical videos", "Teaching driving safety honestly", "Slapstick timing", "Telling a story without words"]);
    await act(async () => second());
    await settle(12);
    expect(called("patchAgent").map((c) => c.args[2])).toEqual([
      { skillIds: ["vertical-short-hooks", "nonverbal-storytelling", "driving-safety-teaching", "01JSLAPSTICKTIMING000000AA"], version: 1 },
      { skillIds: ["vertical-short-hooks", "driving-safety-teaching", "nonverbal-storytelling", "01JSLAPSTICKTIMING000000AA"], version: 2 },
      { skillIds: ["vertical-short-hooks", "driving-safety-teaching", "01JSLAPSTICKTIMING000000AA", "nonverbal-storytelling"], version: 3 },
    ]);
    expect(titles()).toEqual(["Hooks for short vertical videos", "Teaching driving safety honestly", "Slapstick timing", "Telling a story without words"]);
    expect(store.agents.find((x) => x.agentId === "creative_director")?.skillIds.at(-1)).toBe("nonverbal-storytelling");
    expect(document.body.textContent).not.toContain("changed while you were looking");
  });

  it("Skills: a double tap on a skill's switch sends each change on the newest version", async () => {
    await open("skills");
    const sw = () => $<HTMLButtonElement>('[aria-label="Use Telling a story without words"]')!;
    const release = hold("putSkill");
    await click(sw());
    await click(sw());
    expect(sw().getAttribute("aria-checked")).toBe("true");
    await act(async () => release());
    await settle(10);
    expect(called("putSkill").map((c) => c.args[2])).toEqual([
      { version: 1, enabled: false },
      { version: 2, enabled: true },
    ]);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).not.toContain("changed while you were looking");
  });
});
