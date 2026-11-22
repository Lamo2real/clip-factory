// Lamo Stories › Settings, round 4 (docs/CONTRACTS.md §45.35; request 2 §3 "support adding new models and providers
// without rebuilding the application", §4 "Do not assume every model supports every effort level", §3.7 "Understand
// which provider supplies the model", §3.8 "See model availability and configuration status", §6E "Video-generation
// providers", §6F "Reference-video storage"), against the in-memory API:
// - D1: a model the owner adds says how Lamo Stories calls it (effort levels yes/no, tools yes/no, prompt cache yes/no),
//   starting from its maker's defaults; the body carries them, and the mock refuses levels on a model that has none;
// - D6: changing its model ID or Region makes it "Not checked yet" again, also after the page is opened again;
// - D8: "{maker} on {host}" wherever a model is named;
// - D2: Settings › Video's Nova Reel row has Try it (one 6-second test shot, which Amazon bills), follows the job and
//   says how it went: what is missing, Amazon Bedrock's sentence, or that it works;
// - D9: the storage card says a study stays only if the video was studied.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import { REEL_DENIED, REEL_NOT_READY } from "../src/stories/api/mock/workspace.ts";
import { callingFor, type ModelInfo, type ProductionJob, type StoriesApi } from "../src/stories/api/types.ts";
import { madeBy } from "../src/stories/settings/bits.tsx";
import { callingOf, callingWords, defOf, movedUnchecked, withMaker } from "../src/stories/settings/OwnModels.tsx";
import { shownTry, TRY_LINE, tryProblem, tryRunning } from "../src/stories/settings/ReelTry.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;
let api: StoriesApi;
let calls: { name: string; args: unknown[] }[];

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20, reelTryMs: 0, ...knobs } };
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

async function open(section: "ai" | "video" | "storage") {
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
const switchOf = (form: HTMLElement, name: RegExp) => byText("[role=switch]", /On|Off/, byText(".st-stg-switchrow", name, form));
const checked = (el: Element) => el.getAttribute("aria-checked");

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

describe("how an added model is called (§45.35 D1)", () => {
  it("starts from its maker: Anthropic all three, Amazon the prompt cache only, anyone else none", () => {
    expect(callingFor("Anthropic")).toEqual({ effortField: "output_config", tools: true, cache: true });
    expect(callingFor(" amazon ")).toEqual({ effortField: "none", tools: false, cache: true });
    expect(callingFor("Meta")).toEqual({ effortField: "none", tools: false, cache: false });
    expect(callingFor("Cohere")).toEqual({ effortField: "none", tools: false, cache: false });
  });

  it("the form's switches follow the maker until the owner sets one; the body says how it is called", async () => {
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    // A new model starts as an Anthropic one: effort levels (none ticked yet), tools and the prompt cache.
    expect([switchOf(form, /It has effort levels/), switchOf(form, /It can use tools/), switchOf(form, /It can reuse its instructions/)].map(checked)).toEqual(["true", "true", "true"]);
    expect(form.textContent).toContain("These start right for Anthropic's models.");
    await click(byText("[role=radio]", "Meta", form));
    expect([switchOf(form, /It has effort levels/), switchOf(form, /It can use tools/), switchOf(form, /It can reuse its instructions/)].map(checked)).toEqual(["false", "false", "false"]);
    // No effort levels: the levels are not even shown, and the words say none is ever sent.
    expect($$("button", form).some((b) => b.textContent === "Low")).toBe(false);
    expect(byText(".st-stg-switchrow", /It has effort levels/, form).textContent).toContain("It runs at its own level. Lamo Stories never sends it one.");
    expect(byText(".st-stg-switchrow", /It can use tools/, form).textContent).toContain("It only talks: in the chat it cannot start things");
    // The owner's own choice stays when the maker changes again.
    await click(switchOf(form, /It can reuse its instructions/));
    await click(byText("[role=radio]", "Anthropic", form));
    expect([switchOf(form, /It has effort levels/), switchOf(form, /It can use tools/), switchOf(form, /It can reuse its instructions/)].map(checked)).toEqual(["false", "false", "true"]);
    fill(form, "Name", "Llama 4");
    await click(byText("[role=radio]", "Meta", form));
    fill(form, "Bedrock model ID or inference profile", "eu.meta.llama4-maverick-17b-instruct-v1:0");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(calls.filter((c) => c.name === "putAiModel").at(-1)?.args[2]).toMatchObject({
      label: "Llama 4",
      provider: "Meta",
      efforts: [],
      defaultEffort: null,
      effortField: "none",
      tools: false,
      cache: true,
    });
    // Listed with who makes it, on who runs it, and how it is called.
    const row = byText(".st-stg-own", /Llama 4/);
    expect(row.textContent).toContain("Made by Meta · on Amazon Bedrock in eu-north-1");
    expect(row.textContent).toContain("No effort levels · no tools · prompt cache on.");
  });

  it("effort levels on with none ticked is something to fix first; off sends no levels at all", () => {
    const d = { label: "X", maker: "Anthropic", otherMaker: "", modelId: "eu.anthropic.claude-x-v1:0", region: "eu-north-1", otherRegion: "", efforts: [], defaultEffort: null, vision: false, maxTokens: "4096", priced: false, input: "", output: "", currency: "USD", effortField: "output_config" as const, tools: true, cache: true, ownCalling: false };
    expect(defOf(d)).toEqual({ problem: "Tick the effort levels it accepts, or switch off It has effort levels." });
    expect(defOf({ ...d, effortField: "none", efforts: ["high"], defaultEffort: "high" })).toMatchObject({ efforts: [], defaultEffort: null, effortField: "none" });
    // A maker change follows the maker's defaults (and drops levels a maker without them never takes).
    expect(withMaker({ ...d, efforts: ["low"], defaultEffort: "low" }, { maker: "Amazon" })).toMatchObject({ effortField: "none", tools: false, cache: true, efforts: [], defaultEffort: null });
    expect(withMaker({ ...d, ownCalling: true }, { maker: "Amazon" })).toMatchObject({ effortField: "output_config", tools: true, cache: true });
    expect(callingWords({ effortField: "output_config", tools: true, cache: false })).toBe("Takes effort levels · uses tools · no prompt cache");
  });

  it("Edit starts from how the model says it is called (or, for one saved before, its levels and its maker)", () => {
    const m = { provider: "Mistral", efforts: ["low"], effortField: undefined, tools: undefined, cache: undefined } as unknown as ModelInfo;
    expect(callingOf(m)).toEqual({ effortField: "output_config", tools: false, cache: false });
    expect(callingOf({ ...m, efforts: [] })).toEqual({ effortField: "none", tools: false, cache: false });
    expect(callingOf({ ...m, effortField: "none", efforts: [], tools: true, cache: true })).toEqual({ effortField: "none", tools: true, cache: true });
  });

  it("an Anthropic model saved with no levels reads 'No effort levels' on both lines, and Edit saves a new name as it is", async () => {
    expect(callingOf({ provider: "Anthropic", efforts: [], effortField: "output_config", tools: true, cache: true })).toEqual({ effortField: "none", tools: true, cache: true });
    start();
    // As a round-3 model reads back from the API: output_config (its maker's), with no levels ticked.
    const def = { label: "Claude X", provider: "Anthropic", modelId: "eu.anthropic.claude-x-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 4096, price: null };
    expect(await api.putAiModel("stories", "custom-x", { ...def, effortField: "output_config" })).toMatchObject({ effortField: "output_config", efforts: [] });
    await open("ai");
    const row = byText(".st-stg-own", /Claude X/);
    expect(row.textContent).toContain("No effort setting: it runs at its own level.");
    expect(row.textContent).toContain("No effort levels · uses tools · prompt cache on.");
    expect(row.textContent).not.toContain("Takes effort levels");
    await click(byText("button", /^Edit/, row));
    const form = $<HTMLElement>('form[aria-label="Change Claude X"]')!;
    expect(checked(switchOf(form, /It has effort levels/))).toBe("false");
    fill(form, "Name", "Claude X2");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(form.textContent).not.toContain("Tick the effort levels it accepts");
    expect(calls.filter((c) => c.name === "putAiModel").at(-1)?.args[2]).toMatchObject({ label: "Claude X2", efforts: [], defaultEffort: null, effortField: "none", tools: true, cache: true });
  });

  it("the mock refuses levels on a model that takes none, as the API does", async () => {
    start();
    const base = { label: "Nova Lite", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", vision: false, maxOutputTokens: 4096, price: null };
    await expect(api.putAiModel("stories", "custom-lite", { ...base, efforts: ["low"], defaultEffort: "low", effortField: "none" })).rejects.toMatchObject({ status: 400, field: "efforts" });
    await expect(api.putAiModel("stories", "custom-lite", { ...base, efforts: [], defaultEffort: null, effortField: "sideways" as never })).rejects.toMatchObject({ status: 400, field: "effortField" });
    const saved = await api.putAiModel("stories", "custom-lite", { ...base, efforts: [], defaultEffort: null });
    expect(saved).toMatchObject({ host: "Amazon Bedrock", effortField: "none", tools: false, cache: true, custom: true });
  });
});

describe("a changed model ID or Region is Not checked yet (§45.35 D6)", () => {
  it("the mock clears its check (a new name alone keeps it), and the page says Not checked yet, also when opened again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    start();
    const def = { label: "Mistral Large", provider: "Mistral", modelId: "mistral.mistral-large-2407-v1:0", region: "eu-west-3", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 8192, price: null };
    await api.putAiModel("stories", "custom-mistral", def);
    await api.checkModels("stories", ["custom-mistral"]);
    await act(async () => await new Promise((r) => setTimeout(r, 60)));
    const works = (await api.getAi("stories")).models.find((m) => m.key === "custom-mistral")!;
    expect(works.status).toBe("ok");
    expect((await api.putAiModel("stories", "custom-mistral", { ...def, label: "Mistral Large 2" })).status).toBe("ok");
    const moved = await api.putAiModel("stories", "custom-mistral", { ...def, label: "Mistral Large 2", region: "eu-west-1" });
    expect(moved).toMatchObject({ status: "not_checked", checkedAt: null });
    await open("ai");
    const row = byText(".st-stg-own", /Mistral Large 2/);
    expect(row.textContent).toContain("Not checked yet");
    expect(row.textContent).not.toContain("Works");
    expect(byText("[role=radio]", /Mistral Large 2/).textContent).toContain("Not checked yet");
  });

  it("asks for a new check until one is stamped (and an older API that kept the old one is just as stale)", () => {
    const saved = { key: "k", moved: true, edited: true, checkedAt: "2026-11-22T08:00:00.000Z" };
    expect(movedUnchecked(saved, { status: "not_checked", checkedAt: null })).toBe(true);
    expect(movedUnchecked(saved, { status: "ok", checkedAt: "2026-11-22T08:00:00.000Z" })).toBe(true);
    expect(movedUnchecked(saved, { status: "ok", checkedAt: "2026-11-22T09:00:00.000Z" })).toBe(false);
    expect(movedUnchecked({ ...saved, moved: false }, { status: "not_checked", checkedAt: null })).toBe(false);
    expect(movedUnchecked({ ...saved, edited: false }, { status: "not_checked", checkedAt: null })).toBe(false);
  });
});

describe("who makes a model, on who runs it (§45.35 D8)", () => {
  it("says '{maker} on {host}', and one name while an older list names the host as the maker", () => {
    expect(madeBy({ provider: "Anthropic", host: "Amazon Bedrock" })).toBe("Anthropic on Amazon Bedrock");
    expect(madeBy({ provider: "Amazon Bedrock", host: "Amazon Bedrock" })).toBe("Amazon Bedrock");
    expect(madeBy({ provider: "Mistral" })).toBe("Mistral");
  });

  it("the default model list names the maker on the host for the models the owner added", async () => {
    start();
    await api.putAiModel("stories", "custom-quick", { label: "Quick One", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 4096, price: null });
    await open("ai");
    expect(byText("[role=radio]", /Quick One/).textContent).toContain("Amazon on Amazon Bedrock · Not checked yet.");
    // Every bundled model still names Amazon Bedrock (its maker comes from the model list).
    for (const r of $$("[role=radio]", byText(".st-stg-card", /^Default model/))) expect(r.textContent).toContain("Amazon Bedrock");
    // The mock's own Amazon model is made by Amazon, on Amazon Bedrock, as the live list says it.
    expect(byText("[role=radio]", /Amazon Nova Pro/).textContent).toContain("Amazon on Amazon Bedrock");
  });

  it("the mock names its models and its writer as the live app does (Amazon by Amazon; Claude on Amazon Bedrock)", async () => {
    start();
    const nova = (await api.getAi("stories")).models.find((m) => m.key === "nova-pro")!;
    expect(nova).toMatchObject({ provider: "Amazon", host: "Amazon Bedrock" });
    expect(madeBy(nova)).toBe("Amazon on Amazon Bedrock");
    const writer = (await api.providers("stories")).find((p) => p.kind === "writer")!;
    expect(writer.label).toBe("Claude on Amazon Bedrock");
  });
});

describe("Try it on Amazon Nova Reel (§45.35 D2)", () => {
  it("the row says what it does; without the US storage it says what is missing, and nothing switches", async () => {
    start();
    await open("video");
    const row = $<HTMLElement>('[data-provider="nova-reel"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(TRY_LINE);
    expect(row.textContent).toContain("Amazon bills that one shot");
    await click(byText("button", "Try it", row));
    await settle(8);
    expect(calls.filter((c) => c.name === "tryNovaReel")).toHaveLength(1);
    expect(row.textContent).toContain("It did not work");
    expect(row.textContent).toContain(REEL_NOT_READY);
    expect(document.body.textContent).toContain(REEL_NOT_READY);
    // The video maker is still the built-in animator.
    expect((await api.getWorkspace("stories")).configuration).toMatchObject({ providers: { video: "builtin-2d" } });
    expect(byText("button", "Try it again", row)).toBeTruthy();
  });

  it("with the US storage on it works: the row and a toast say so, and picking Nova Reel shows it Working", async () => {
    start({ reelBucket: true });
    await open("video");
    const row = $<HTMLElement>('[data-provider="nova-reel"]')!;
    await click(byText("button", "Try it", row));
    await settle(8);
    expect(row.textContent).toContain("It worked");
    expect(row.textContent).toContain("Nova Reel made a test shot");
    expect(document.body.textContent).toContain("It works! Nova Reel made its test shot.");
    await click(byText("[role=radio]", /Amazon Nova Reel/, byText(".st-stg-card", /^Video maker/)));
    await settle(8);
    expect((await api.providers("stories")).find((p) => p.id === "nova-reel")).toMatchObject({ state: "on" });
    expect(byText("[role=radio]", /Amazon Nova Reel/, byText(".st-stg-card", /^Video maker/)).textContent).toContain("Working");
  });

  it("Amazon Bedrock saying no is shown in its own words; a try already running is refused", async () => {
    start({ reelBucket: true, reelDenied: true, reelTryMs: 60_000 });
    const job = await api.tryNovaReel("stories");
    expect(job).toMatchObject({ jobType: "provider_check", contentType: "provider", contentId: "nova-reel", steps: [{ key: "check", label: "Try it" }] });
    await expect(api.tryNovaReel("stories")).rejects.toMatchObject({ status: 409, message: "Amazon Nova Reel is being tried. Wait until it is done." });
    store.knobs.reelTryMs = 0;
    const reel = (await api.providers("stories")).find((p) => p.id === "nova-reel")!;
    expect(reel.check).toMatchObject({ jobId: job.jobId, status: "failed" });
    expect(tryProblem(reel.check ?? null, reel)).toBe(REEL_DENIED);
  });

  it("shows the try just started until the list knows it, then the list's newest", () => {
    const job = (id: string, at: string, status: ProductionJob["status"]) => ({ jobId: id, createdAt: at, status, steps: [{ key: "check", label: "Try it", status: "pending" }] }) as unknown as ProductionJob;
    const old = job("A", "2026-11-22T08:00:00.000Z", "failed");
    const mine = job("B", "2026-11-22T09:00:00.000Z", "queued");
    expect(shownTry(mine, old)).toBe(mine);
    expect(shownTry(mine, null)).toBe(mine);
    const seen = { ...mine, status: "running" } as ProductionJob;
    expect(shownTry(mine, seen)).toBe(seen);
    expect(shownTry(null, old)).toBe(old);
    expect(tryRunning(seen)).toBe(true);
    expect(tryRunning(old)).toBe(false);
    expect(tryProblem(old, { lastError: "Bedrock said no." })).toBe("Bedrock said no.");
    expect(tryProblem({ ...old, status: "ready" } as ProductionJob, undefined)).toBeNull();
  });
});

describe("keeping reference videos (§45.35 D9)", () => {
  it("by age a study stays only if the video was studied", async () => {
    start();
    await open("storage");
    const refs = $$("[role=radiogroup]").find((g) => g.getAttribute("aria-label") === "Keep reference videos")!;
    for (const days of [/30 days/, /90 days/]) expect(byText("[role=radio]", days, refs).textContent).toContain("Then the video goes; its study stays if it was studied");
  });
});
