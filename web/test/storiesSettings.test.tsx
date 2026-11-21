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

let root: Root;
let host: HTMLElement;
let store: MockStore;
let workspace: Workspace;
let providers: (ProviderStatus & { key?: { saved: boolean; hint: string | null; savedAt: string | null } })[];
let calls: { name: string; args: unknown[] }[];

function fakeApi(): StoriesApi {
  store = createStore();
  store.workspaces = [{ workspaceId: "stories", workspaceName: "Lamo Stories", workspaceType: "stories", builtin: false, configuration: structuredClone(DEFAULTS), version: 3 }];
  for (const part of [aiPart, skillsPart, memoryPart]) part.seed(store);
  store.knobs.checkModelsMs = 20;
  workspace = store.workspaces[0]!;
  providers = [
    { kind: "writer", id: "bedrock-claude", label: "Claude in Amazon Bedrock", state: "on", line: "Writes the stories." },
    { kind: "animation", id: "builtin-2d", label: "Built-in animation", state: "on", line: "Animates every scene." },
    { kind: "animation", id: "nova-reel", label: "Amazon Nova Reel", state: "unavailable", line: "It needs a storage place in the USA first." },
    { kind: "images", id: "builtin-rig", label: "Built-in characters", state: "on", line: "Draws every character." },
    { kind: "images", id: "nova-canvas", label: "Amazon Nova Canvas", state: "off", line: "Off." },
    { kind: "audio", id: "builtin-synth", label: "Built-in sounds", state: "on", line: "Makes every sound." },
  ];
  const parts = { ...aiPart.api(store), ...skillsPart.api(store), ...memoryPart.api(store) };
  const own: Partial<StoriesApi> = {
    getWorkspace: async () => structuredClone(workspace),
    patchWorkspace: async (_ws, patch) => {
      if (patch.version !== workspace.version) throw Object.assign(new Error("stale"), { code: "conflict" });
      workspace = { ...workspace, configuration: { ...(workspace.configuration as StoriesConfig), ...patch.configuration }, version: workspace.version + 1 };
      return structuredClone(workspace);
    },
    providers: async () => structuredClone(providers),
    getTask: async (_ws, id) => structuredClone(store.tasks.find((t) => t.taskId === id)!),
  };
  const all = { ...parts, ...own } as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  return new Proxy(all, {
    get(target, key: string) {
      const fn = target[key];
      if (!fn) return () => Promise.reject(new Error(`not in this test: ${key}`));
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return fn(...args);
      };
    },
  }) as unknown as StoriesApi;
}

beforeEach(() => {
  calls = [];
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

async function open(section: "ai" | "agents" | "skills" | "memory" | "video" | "storage") {
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
    expect(links.map((a) => a.textContent)).toEqual(["AI", "Agents", "Skills", "Memory", "Social accounts", "Video", "Storage"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/stories/settings/ai", "/stories/settings/agents", "/stories/settings/skills", "/stories/settings/memory", "/stories/connections", "/stories/settings/video", "/stories/settings/storage"]);
    expect($(".st-stg-tabs > .glide")).not.toBeNull();
    expect($(".st-stg-tab.is-on")?.getAttribute("aria-current")).toBe("page");
    expect($("h1")?.textContent).toBe("Settings");
  });

  for (const section of ["ai", "agents", "skills", "memory", "video", "storage"] as const)
    it(`${section}: every pick-one bar is on <Glide>, and nothing is disabled (the deny sound needs the click)`, async () => {
      await open(section);
      for (const bar of $$("[role=radiogroup]")) expect(bar.querySelector(":scope > .glide"), bar.getAttribute("aria-label") ?? "").not.toBeNull();
      expect($$("button[disabled], select[disabled]")).toEqual([]);
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

  it("sets each agent's and each task's model and effort, with Workspace default, the suggestion and what it uses now", async () => {
    await open("ai");
    const rows = $$(".st-stg-assign__row");
    expect(rows).toHaveLength(5 + 11);
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
    providers.push({ kind: "animation", id: "acme-motion", label: "Acme Motion", state: "needs_setup", line: "Needs its key.", key: { saved: false, hint: null, savedAt: null } });
    await open("ai");
    const card_ = card("Providers");
    expect(card_.textContent).toContain("Amazon Nova Reel");
    expect(card_.textContent).toContain("Not available yet");
    const row = byText(".st-stg-keyrow", /Acme Motion/, card_);
    setValue(row.querySelector("input")!, "sk-acme-0123456789abcdef4f2a");
    expect(row.querySelector("input")!.type).toBe("password");
    await act(async () => row.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle(8);
    expect(called("setProviderKey").at(-1)?.args).toEqual(["stories", "acme-motion", "sk-acme-0123456789abcdef4f2a"]);
    const after = byText(".st-stg-keyrow", /Acme Motion/, card("Providers"));
    expect(after.textContent).toContain("saved · ends 4f2a");
    expect(host.innerHTML).not.toContain("0123456789abcdef");
  });

  it("says plainly when no provider needs a key", async () => {
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
    expect(box.value).toContain("You are the creative director of Lamo Stories");
    expect(byText("button", "Save the words").getAttribute("aria-disabled")).toBe("true");
    setValue(box, "Make every idea about Pip.");
    await click(byText("button", "Save the words"));
    expect(called("patchAgent").at(-1)?.args[2]).toMatchObject({ instructions: "Make every idea about Pip." });
    expect(host.textContent).toContain("Your words");
    await click(byText("button", "Reset"));
    expect($('[role="group"][aria-label="Are you sure?"]')).not.toBeNull();
    await click(byText("button", "Yes, reset"));
    expect(called("patchAgent").at(-1)?.args).toEqual(["stories", "creative_director", { reset: true }]);
    expect($<HTMLTextAreaElement>("textarea")!.value).toContain("You are the creative director of Lamo Stories");
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
    expect(cards.slice(0, 3).every((c) => c.textContent?.includes("Comes with Lamo Stories"))).toBe(true);
    expect(cards[0]!.textContent).toMatch(/Used by: Creative director, Video analysis, Storyboard, Character/);
    await click(byText("button", "Open", cards[0]!));
    await settle();
    expect($(".st-stg-pre")?.textContent).toMatch(/^---\nname: nonverbal-storytelling/);
    expect(host.textContent).toContain("can't be changed");
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
  it("picks the makers apart from the AI models, each with its state; one not available yet cannot be picked", async () => {
    await open("video");
    expect($$("[role=radio]", group("Video maker")).map((r) => r.querySelector(".st-stg-pick__label")?.textContent)).toEqual(["Built-in animator", "Amazon Nova Reel 1.1"]);
    const reel = byText("[role=radio]", /Nova Reel/);
    expect(reel.getAttribute("aria-disabled")).toBe("true");
    expect(reel.textContent).toContain("It needs a storage place in the USA first.");
    await click(reel);
    expect(called("patchWorkspace")).toHaveLength(0);
    await click(byText("[role=radio]", /Nova Canvas/));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { providers: { images: "nova-canvas", video: "builtin-2d", audio: "builtin-synth" } }, version: 3 });
    expect(host.textContent).toContain("Amazon Nova Canvas (amazon.nova-canvas-v1:0)");
  });

  it("shows 1080 × 1920, 9:16 with the other shapes not yet offered, 30 fps, and saves quality and length", async () => {
    await open("video");
    expect(host.textContent).toContain("1080 × 1920, the built-in animator's only size");
    expect(host.textContent).toContain("30 fps, the built-in animator's only rate");
    const shapes = $$("[role=radio]", group("Shape of the video"));
    expect(shapes.map((s) => [s.querySelector(".st-stg-pick__label")?.textContent, s.getAttribute("aria-disabled")])).toEqual([
      ["9:16 tall", null],
      ["1:1 square", "true"],
      ["16:9 wide", "true"],
    ]);
    expect(shapes[1]!.textContent).toContain("Not with the built-in animator yet");
    await click(byText("[role=radio]", /^Best/));
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { video: { quality: "best", resolution: "1080x1920", aspect: "9:16", fps: 30 } } });
    await click($('[aria-label="5 seconds longer"]')!);
    expect($(".st-stg-length__value strong")?.textContent).toBe("50");
    expect(called("patchWorkspace").at(-1)?.args[1]).not.toMatchObject({ configuration: { defaultDurationSec: 50 } });
    await act(async () => await new Promise((r) => setTimeout(r, 520)));
    await settle();
    expect(called("patchWorkspace").at(-1)?.args[1]).toMatchObject({ configuration: { defaultDurationSec: 50 } });
    expect(host.textContent).toContain("Best length");
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
