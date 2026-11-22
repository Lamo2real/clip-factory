// Lamo Stories › Settings, round 5 (docs/CONTRACTS.md §45.36, the final check before the switch), against the
// in-memory API:
// - E4: an added model's Region must fit its ID: an ARN's own Region, or the part of the world a us./eu./apac.
//   profile runs in; a mismatch is refused with a sentence naming both (the form, before anything is sent, and the
//   mock as the API does); a pasted ARN fills the Region in;
// - E14: the model ID's developer words (inference profile, ARN) and an added model's exact ID sit behind
//   "Technical details", under a plain first line;
// - E15: Settings always has "Open setup again", with what is left;
// - E17: Add a model starts with Anthropic's usual levels ticked (all five, its own level High); the row's marks have
//   the usual gap and sit at the right edge; one set of status words ("Problem" for an error) everywhere; a sentence
//   shown on the page it names never sends the owner there ("Pick Built-in animation above").
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import { MODEL_STATUS_WORDS, modelRegionProblem, regionOfArn, type StoriesApi } from "../src/stories/api/types.ts";
import { MODEL_STATUS, onThisPage } from "../src/stories/settings/bits.tsx";
import { defOf, usualLevels, withMaker } from "../src/stories/settings/OwnModels.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";
import { forgetOnboarding } from "../src/stories/ui.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");

let host: HTMLElement;
let root: Root;
let api: StoriesApi;
let calls: { name: string; args: unknown[] }[];

function start(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20, ...knobs } };
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
/** A source file of the web app, as written. */
const source = (path: string) => readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");
const card = (title: string) => byText<HTMLElement>(".st-stg-card", new RegExp(`^${title}`));
const submit = async (form: HTMLElement) => {
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle(8);
};
const regionSelect = (form: HTMLElement) => {
  const l = $$<HTMLLabelElement>("label", form).find((x) => x.textContent === "AWS Region");
  return (l ? form.querySelector<HTMLSelectElement>(`#${CSS.escape(l.htmlFor)}`) : null) ?? $$<HTMLSelectElement>("select", form).find((s) => s.getAttribute("aria-label") === "AWS Region")!;
};

beforeEach(() => {
  calls = [];
  localStorage.clear();
  resetWorkspaceMemory();
  forgetOnboarding();
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

describe("an added model's Region fits its ID (§45.36 E4)", () => {
  it("an ARN names its own Region; a us./eu./apac. profile runs in that part of the world; global and plain ids fit any", () => {
    expect(regionOfArn("arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-x-v1:0")).toBe("eu-west-1");
    expect(regionOfArn("arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:provisioned-model/abc")).toBe("us-gov-west-1");
    expect(regionOfArn("eu.amazon.nova-premier-v1:0")).toBeNull();
    expect(modelRegionProblem("arn:aws:bedrock:eu-west-1:123456789012:provisioned-model/abc", "eu-north-1")).toBe(
      "This model's ARN is in eu-west-1, but its Region says eu-north-1. Pick eu-west-1 as its Region.",
    );
    expect(modelRegionProblem("arn:aws:bedrock:eu-west-1:123456789012:provisioned-model/abc", "eu-west-1")).toBeNull();
    expect(modelRegionProblem("eu.amazon.nova-premier-v1:0", "us-east-1")).toBe(
      "This model ID starts with eu., so it runs in Europe, but its Region says us-east-1. Pick a Region in Europe, like eu-north-1.",
    );
    expect(modelRegionProblem("us.meta.llama4-maverick-17b-instruct-v1:0", "eu-north-1")).toContain("runs in the USA, but its Region says eu-north-1");
    expect(modelRegionProblem("apac.amazon.nova-pro-v1:0", "ap-southeast-2")).toBeNull();
    expect(modelRegionProblem("apac.amazon.nova-pro-v1:0", "eu-west-1")).toContain("Asia Pacific");
    expect(modelRegionProblem("global.anthropic.claude-x-v1:0", "us-west-2")).toBeNull();
    expect(modelRegionProblem("mistral.mistral-large-2407-v1:0", "eu-west-3")).toBeNull();
    // A profile inside an ARN must fit too.
    expect(modelRegionProblem("arn:aws:bedrock:us-east-1:123456789012:inference-profile/eu.amazon.nova-pro-v1:0", "us-east-1")).toContain("runs in Europe");
  });

  it("the mock refuses a Region that does not fit, naming both, as the API does", async () => {
    start();
    const def = { label: "Nova Premier", provider: "Amazon", modelId: "eu.amazon.nova-premier-v1:0", region: "us-east-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 8000, price: null };
    await expect(api.putAiModel("stories", "custom-nova", def)).rejects.toMatchObject({ status: 400, field: "region", message: expect.stringContaining("its Region says us-east-1") });
    await expect(api.putAiModel("stories", "custom-nova", { ...def, region: "eu-west-1" })).resolves.toMatchObject({ region: "eu-west-1" });
  });

  it("the form fills the Region from a pasted ARN, and refuses a profile in another part of the world before sending", async () => {
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    fill(form, "Name", "My Claude");
    fill(form, "Model ID", "arn:aws:bedrock:eu-west-3:123456789012:inference-profile/eu.anthropic.claude-x-v1:0");
    await settle();
    expect(regionSelect(form).value).toBe("eu-west-3");
    // A Region not in the list goes to Another Region with its code.
    fill(form, "Model ID", "arn:aws:bedrock:eu-north-2:123456789012:provisioned-model/abc");
    await settle();
    expect(regionSelect(form).value).toBe("another");
    expect($<HTMLInputElement>("input[placeholder='eu-west-2']", form)?.value).toBe("eu-north-2");
    // An eu. profile with a US Region: the sentence names both, and nothing is sent.
    fill(form, "Model ID", "eu.anthropic.claude-x-v1:0");
    fill(form, "AWS Region", "us-east-1");
    await submit(form);
    expect(calls.filter((c) => c.name === "putAiModel")).toHaveLength(0);
    expect(form.querySelector("[role=alert]")?.textContent).toBe("This model ID starts with eu., so it runs in Europe, but its Region says us-east-1. Pick a Region in Europe, like eu-north-1.");
    fill(form, "AWS Region", "eu-west-1");
    await submit(form);
    expect(calls.filter((c) => c.name === "putAiModel").at(-1)?.args[2]).toMatchObject({ modelId: "eu.anthropic.claude-x-v1:0", region: "eu-west-1" });
  });
});

describe("Add a model in plain words (§45.36 E14, E17)", () => {
  it("starts with Anthropic's usual levels ticked (all five, its own level High); a maker with none starts with none", async () => {
    expect(usualLevels("Anthropic")).toEqual({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" });
    expect(usualLevels("Amazon")).toEqual({ efforts: [], defaultEffort: null });
    start();
    await open("ai");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    expect($$("[aria-pressed=true]", form).map((b) => b.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Maximum"]);
    expect(byText("[role=radio]", "High", byText(".st-stg-field", /^Its own level/, form)).getAttribute("aria-checked")).toBe("true");
    expect(form.textContent).toContain("These start right for Anthropic's models.");
    // The first Add the model works with nothing more than a name and an ID.
    fill(form, "Name", "Claude Next");
    fill(form, "Model ID", "eu.anthropic.claude-next-v1:0");
    await submit(form);
    expect(calls.filter((c) => c.name === "putAiModel").at(-1)?.args[2]).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", effortField: "output_config" });
  });

  it("a maker change follows the usual levels until the owner sets them", () => {
    const d = { label: "X", maker: "Meta", otherMaker: "", modelId: "eu.x.y-v1:0", region: "eu-north-1", otherRegion: "", efforts: [], defaultEffort: null, vision: false, maxTokens: "4096", priced: false, input: "", output: "", currency: "USD", effortField: "none" as const, tools: false, cache: false, ownCalling: false };
    expect(withMaker(d, { maker: "Anthropic" })).toMatchObject({ effortField: "output_config", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" });
    expect(withMaker({ ...d, effortField: "output_config", efforts: ["low"], defaultEffort: "low" }, { maker: "Anthropic" })).toMatchObject({ efforts: ["low"], defaultEffort: "low" });
    expect(defOf({ ...d, modelId: "eu.x.y-v1:0", region: "us-east-1" })).toEqual({ problem: expect.stringContaining("its Region says us-east-1") });
  });

  it("the ID's developer words and an added model's exact ID sit behind Technical details, under a plain first line", async () => {
    start();
    await api.putAiModel("stories", "custom-mistral", { label: "Mistral Large", provider: "Mistral", modelId: "mistral.mistral-large-2407-v1:0", region: "eu-west-3", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 8192, price: null });
    await open("ai");
    const row = byText(".st-stg-own", /Mistral Large/);
    const fold = row.querySelector<HTMLDetailsElement>("details.st-tech-fold")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")?.textContent).toBe("Technical details");
    expect(fold.textContent).toContain("mistral.mistral-large-2407-v1:0");
    // Outside the fold the row says who makes it and where it runs, in words.
    const outside = Array.from(row.children).filter((c) => c !== fold).map((c) => c.textContent).join(" ");
    expect(outside).toContain("Made by Mistral · on Amazon Bedrock in eu-west-3");
    expect(outside).not.toContain("mistral.mistral-large-2407-v1:0");
    await click(byText("button", "Add a model", card("Add a model")));
    const form = $<HTMLElement>('form[aria-label="Add a model"]')!;
    const label = $$("label", form).find((l) => l.textContent === "Model ID")!;
    const field = label.closest(".st-stg-field")!;
    expect(field.textContent).not.toMatch(/inference profile|ARN/);
    const tech = form.querySelector<HTMLDetailsElement>("details.st-tech-fold")!;
    expect(tech.open).toBe(false);
    expect(tech.textContent).toContain("inference profile");
    expect(tech.textContent).toContain("ARN");
  });

  it("an added model's marks sit together with the usual gap, at the row's right edge, in its row and in the Default model list", async () => {
    start();
    await api.putAiModel("stories", "custom-mistral", { label: "Mistral Large", provider: "Mistral", modelId: "mistral.mistral-large-2407-v1:0", region: "eu-west-3", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 8192, price: null });
    await open("ai");
    const own = byText(".st-stg-own", /Mistral Large/).querySelector(".st-stg-own__head .st-stg-chips")!;
    expect(Array.from(own.children).map((c) => c.textContent)).toEqual(["Added by you", "Not checked yet"]);
    const pick = byText("[role=radio]", /Mistral Large/, card("Default model")).querySelector(".st-stg-pick__chip .st-stg-chips")!;
    expect(Array.from(pick.children).map((c) => c.textContent)).toEqual(["Added by you", "Not checked yet"]);
    const css = source("stories/styles/settings.css");
    expect(css).toMatch(/\.st-stg-chips \{[^}]*gap: 6px;[^}]*margin-left: auto;/);
    expect(css).toMatch(/\.st-stg-pick--stack \.st-stg-pick__chip \{\s*margin-left: auto;/);
  });
});

describe("Video and Storage in plain words (§45.36 E14)", () => {
  /** What a card shows before any fold is opened. */
  const shown = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const d of Array.from(copy.querySelectorAll("details"))) for (const c of Array.from(d.children)) if (c.tagName !== "SUMMARY") c.remove();
    return copy.textContent ?? "";
  };

  it("the storage folder, the file's codecs and the quality numbers are one tap away", async () => {
    start();
    await open("storage");
    const used = card("Space used");
    expect(shown(used)).toContain("Lamo Stories' own folder in Clip Factory's media storage in Europe (Stockholm).");
    expect(shown(used)).not.toContain("ws/{you}/stories/");
    expect(used.querySelector("details.st-tech-fold")?.textContent).toContain("ws/{you}/stories/");
    const file = card("The finished file");
    expect(shown(file)).toContain("An MP4, which every platform and phone plays");
    expect(shown(file)).not.toMatch(/H\.264|VP9|ProRes|PCM|Opus/);
    expect(file.textContent).toContain("MP4: H.264 picture and AAC sound");
    expect(file.textContent).toContain("WebM: VP9 picture");
    await open("video");
    const quality = card("Quality");
    expect(shown(quality)).not.toContain("CRF");
    expect(quality.querySelector("details.st-tech-fold")?.textContent).toContain("Good 23, Better 20, Best 17");
  });

  it("a maker's Bedrock model ID is one tap away: its first line is the model's plain name", async () => {
    start();
    await open("video");
    await click(byText("[role=radio]", /Nova Canvas/));
    await settle();
    const pictures = card("Picture maker");
    expect(pictures.querySelector(".st-stg-active strong")?.textContent).toBe("Amazon Nova Canvas");
    expect(shown(pictures)).not.toContain("amazon.nova-canvas-v1:0");
    expect(pictures.querySelector("details.st-tech-fold:not([open])")?.textContent).toContain("On Amazon Bedrock: Amazon Nova Canvas (amazon.nova-canvas-v1:0) in eu-west-1.");
    await click(byText("[role=radio]", /Nova Reel/));
    await settle();
    const video = card("Video maker");
    expect(video.querySelector(".st-stg-active strong")?.textContent).toBe("Amazon Nova Reel 1.1");
    expect(shown(video)).not.toContain("amazon.nova-reel-v1:1");
    expect(video.querySelector("details.st-tech-fold")?.textContent).toContain("(amazon.nova-reel-v1:1) in us-east-1.");
  });
});

describe("no effort words for a model without levels (§45.36 E17)", () => {
  it("Default effort only explains effort for a model that has levels", async () => {
    start();
    await open("ai");
    expect(card("Default effort").textContent).toContain("Higher is slower and costs more");
    await click(byText("[role=radio]", /Nova Pro/));
    await settle();
    const effort = card("Default effort");
    expect(effort.textContent).toContain("This model has no effort setting; it runs at its own level.");
    expect(effort.textContent).toContain("This model picks how hard it thinks by itself.");
    expect(effort.textContent).not.toMatch(/Higher is slower|costs more/);
  });
});

describe("one set of status words (§45.36 E17)", () => {
  it("Works, Not checked yet, No access, Not found, Problem: Settings and Setup read the same set", async () => {
    expect(MODEL_STATUS_WORDS).toEqual({ ok: "Works", not_checked: "Not checked yet", denied: "No access", not_found: "Not found", error: "Problem" });
    expect(Object.fromEntries(Object.entries(MODEL_STATUS).map(([k, v]) => [k, v.label]))).toEqual(MODEL_STATUS_WORDS);
    const setup = source("stories/screens/Setup.tsx");
    expect(setup).not.toContain("Had a problem");
    expect(setup).toContain("= MODEL_STATUS;");
  });
});

describe("never sent to the page he is on (§45.36 E17)", () => {
  it("drops the trip to the page on screen, keeps every other page's name", () => {
    const reel = "Amazon Nova Reel is not ready yet: its storage place in the USA (N. Virginia) is not switched on. Pick Built-in animation in Settings › Video, or finish its setup.";
    expect(onThisPage(reel, "Video")).toBe("Amazon Nova Reel is not ready yet: its storage place in the USA (N. Virginia) is not switched on. Pick Built-in animation above, or finish its setup.");
    expect(onThisPage(reel, "AI")).toBe(reel);
    expect(onThisPage(reel, null)).toBe(reel);
    expect(onThisPage("Claude X does not accept tool use here. Turn off Tools in Settings › AI › its row.", "AI")).toBe("Claude X does not accept tool use here. Turn off Tools in its row above.");
    expect(onThisPage("type Bedrock's price in Lamo Stories › Settings › AI to replace it.", "AI", "here")).toBe("type Bedrock's price here to replace it.");
    expect(onThisPage("Turn them on in Lamo Stories › Settings › Video › Picture maker.", "Video")).toBe("Turn them on in Picture maker above.");
    expect(onThisPage("Switch it on in Lamo Stories › Settings › Agents.", "AI")).toBe("Switch it on in Lamo Stories › Settings › Agents.");
  });

  it("Settings › AI's list prices say type it here, never Lamo Stories › Settings › AI", async () => {
    start();
    await open("ai");
    const prices = card("Prices");
    expect(prices.textContent).toContain("type Bedrock's price here to replace it.");
    expect(prices.textContent).not.toContain("Settings › AI");
  });

  it("Settings › Video says Pick Built-in animation above, in the row and in the Try it card, never in Settings › Video", async () => {
    start({ reelTryMs: 0 });
    await open("video");
    await click(byText("button", "Try it", $<HTMLElement>('[data-provider="nova-reel"]')!));
    await settle(8);
    expect(document.body.textContent).toContain("Pick Built-in animation above, or finish its setup.");
    expect(document.body.textContent).not.toContain("in Settings › Video");
  });
});

describe("the setup, always one tap away (§45.36 E15)", () => {
  it("Settings has Open setup again, with how many steps are left", async () => {
    start();
    await open("ai");
    const link = byText<HTMLAnchorElement>("a", /Open setup again/);
    expect(link.getAttribute("href")).toBe("/stories/setup");
    expect(document.querySelector(".st-stg-head__setup-left")?.textContent).toMatch(/^\d+ steps? left$/);
    // Finished with steps skipped: the link stays, and still says what is left.
    await api.patchOnboarding("stories", { step: "tiktok", skipped: true });
    await api.patchOnboarding("stories", { finish: true });
    forgetOnboarding();
    await open("video");
    expect(byText<HTMLAnchorElement>("a", /Open setup again/).getAttribute("href")).toBe("/stories/setup");
    expect(document.querySelector(".st-stg-head__setup-left")?.textContent).toMatch(/^\d+ steps? left$/);
  });
});
