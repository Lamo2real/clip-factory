// Clips Funded, kid-proof bug hunt (G6): Ideas, Setup, the dashboard's Needs you, reference videos and Settings ›
// Video and Look. Each test failed before its fix: a double tap saved an idea twice, typing in New idea was thrown
// away by a panel switch or a page change, a blocked driving idea had a dead orange button, offered driving drafts
// saved as "Needs checked advice", an empty step said "3 to 8 steps", the setup pulled the child back to another
// step and showed two orange buttons, a still-stuck retry celebrated, a provider key went with one tap, a PDF was
// "too big", Settings' prices failed with no Try again, and a video that would not play left dead controls.
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { navigate } from "../src/lib/router.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import * as ideasPart from "../src/stories/api/mock/ideas.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { createStore, setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { AiTask, Idea, IdeaInput, StoriesApi, VideoConcept } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { IdeasScreen, ideaProblem, offeredOf, BLOCKED_NEXT } = await import("../src/stories/screens/Ideas.tsx");
const { SetupScreen } = await import("../src/stories/screens/Setup.tsx");
const { stillStuck } = await import("../src/stories/screens/Dashboard.tsx");
const { waitingSteps } = await import("../src/stories/chat/references/RefPage.tsx");
const { RefPlayer, PLAY_FAILED, PLAY_FAILED_AGAIN } = await import("../src/stories/chat/references/Player.tsx");
const { pickedProblem, shrinkProblem, PICTURE_WORDS } = await import("../src/stories/settings/LookSection.tsx");
const { MakerPrices } = await import("../src/stories/settings/ProviderPrices.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;
let calls: { name: string; args: unknown[] }[];

/** The whole practice API (no latency), every call written down. */
function useMock(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 30, ...knobs } };
  const real = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  const api = new Proxy(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
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

async function render(node: ReactNode) {
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await settle(10);
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => Array.from(from.querySelectorAll<T>(sel));
function button(name: string | RegExp, from: ParentNode = document): HTMLButtonElement {
  const b = $$<HTMLButtonElement>("button", from).find((x) => {
    const words = [x.textContent?.trim() ?? "", x.getAttribute("aria-label") ?? ""];
    return words.some((w) => (typeof name === "string" ? w === name : name.test(w)));
  });
  if (!b) throw new Error(`no button ${String(name)}; have: ${$$("button", from).map((x) => x.textContent?.trim()).join(" | ")}`);
  return b;
}
const tap = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
async function click(el: Element) {
  await act(async () => tap(el));
  await settle(8);
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
  const l = $$<HTMLLabelElement>("label[for]").find((x) => (typeof label === "string" ? x.textContent?.trim() === label : label.test(x.textContent ?? "")));
  const el = l?.htmlFor ? document.getElementById(l.htmlFor) : null;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`no field ${String(label)}`);
  return el;
}
async function pick(group: string, option: string) {
  const g = $$('[role="radiogroup"]').find((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === group);
  const opt = g && $$("label", g).find((l) => l.querySelector(".st-s-pick__label")?.textContent?.trim() === option);
  if (!opt) throw new Error(`no option ${option} in ${group}`);
  await click(opt.querySelector("input")!);
}
const card = (title: string) => $$(".st-s-idea").find((c) => c.querySelector(".st-s-idea__title")?.textContent === title)!;
const ideasTitled = (title: string) => store.ideas.filter((i) => i.title === title).length;
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');

beforeEach(async () => {
  calls = [];
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  forgetLoaded();
  setMockLatency(0);
  history.replaceState(null, "", "/stories/ideas");
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setStoriesApi(null);
  vi.useRealTimers();
});

// ---------- Ideas ----------

describe("Ideas: New idea", () => {
  async function fill(title: string) {
    type(field("Title"), title);
    type(field("What happens, in one line"), "Pip stacks the plates higher and higher.");
    await pick("What kind of video?", "Funny");
  }

  it("a double tap, or Enter twice, on Save idea saves one idea", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    await click(button("New idea"));
    await fill("Double tap test");
    const save = button("Save idea");
    await act(async () => {
      tap(save);
      tap(save);
    });
    await settle(10);
    expect(ideasTitled("Double tap test")).toBe(1);

    await click(button("New idea"));
    await fill("Enter twice test");
    const form = document.querySelector<HTMLFormElement>('form[aria-label="New idea"]')!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle(10);
    expect(ideasTitled("Enter twice test")).toBe(1);
  });

  it("Save changes twice in a row sends one change", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    await click(button("Edit The sandwich tower"));
    type(field("Title"), "The sandwich skyscraper");
    const save = button("Save changes");
    await act(async () => {
      tap(save);
      tap(save);
    });
    await settle(10);
    expect(calls.filter((c) => c.name === "patchIdea")).toHaveLength(1);
  });

  it("switching to Ask for ideas and back keeps the typing; closing with typing asks first", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    await click(button("New idea"));
    type(field("Title"), "Keep me");
    type(field("What happens, in one line"), "Typed and not saved.");
    await click(button("Ask for ideas"));
    type(field(/What about/), "a snowy day");
    await click(button("New idea"));
    expect(field("Title").value).toBe("Keep me");
    expect(field("What happens, in one line").value).toBe("Typed and not saved.");
    // Ask for ideas keeps its topic too.
    await click(button("Ask for ideas"));
    expect(field(/What about/).value).toBe("a snowy day");
    await click(button("New idea"));

    // Tapping New idea again (it closes the form) asks; No, keep it keeps the words.
    await click(button("New idea"));
    expect(sheet()?.textContent).toContain("Throw away this idea?");
    await click(button("No, keep it", sheet()!));
    expect(field("Title").value).toBe("Keep me");
    // Cancel asks too; Yes throws it away.
    await click(button("Cancel", document.querySelector('form[aria-label="New idea"]')!));
    await click(button("Yes, throw it away", sheet()!));
    expect(document.querySelector('form[aria-label="New idea"]')).toBeNull();
    await click(button("New idea"));
    expect(field("Title").value).toBe("");
  });

  it("leaving the page with typing in New idea or in an Edit asks Leave without saving?", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    await click(button("New idea"));
    type(field("Title"), "Half an idea");
    await act(async () => navigate("/stories/characters"));
    await settle();
    expect(location.pathname).toBe("/stories/ideas");
    expect(sheet()?.textContent).toContain("Leave without saving?");
    await click(button("Stay here", sheet()!));
    expect(field("Title").value).toBe("Half an idea");
    // Nothing typed: no question.
    type(field("Title"), "");
    await act(async () => navigate("/stories/characters"));
    await settle();
    expect(location.pathname).toBe("/stories/characters");
    expect(sheet()).toBeNull();

    history.replaceState(null, "", "/stories/ideas");
    await click(button("Edit The sandwich tower"));
    type(field("Title"), "The sandwich tower, taller");
    await act(async () => navigate("/stories"));
    await settle();
    expect(location.pathname).toBe("/stories/ideas");
    await click(button("Leave without saving", sheet()!));
    expect(location.pathname).toBe("/stories");
  });

  it("the dashboard's New idea (?new=1) opens the form at once, and the address loses the ?new=1", async () => {
    useMock();
    history.replaceState(null, "", "/stories/ideas?new=1");
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    expect(document.querySelector('form[aria-label="New idea"]')).not.toBeNull();
    expect(location.pathname + location.search).toBe("/stories/ideas");
  });
});

describe("Ideas: Ask for ideas", () => {
  it("the line that appears when the ask starts is under the buttons, so a second tap stays on Get ideas", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    await click(button("Ask for ideas"));
    const form = document.querySelector<HTMLFormElement>('form[aria-label="Ask for ideas"]')!;
    await act(async () => {
      tap(button("Get ideas", form));
      tap(button(/^(Get ideas|Thinking…)$/, form));
    });
    await settle(4);
    const busy = form.querySelector(".st-s-busy");
    const bar = form.querySelector(".st-s-actionbar")!;
    expect(busy).not.toBeNull();
    // The busy line follows the action bar (it never pushes the buttons down).
    expect(bar.compareDocumentPosition(busy!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(calls.filter((c) => c.name === "generateIdeas")).toHaveLength(1);
    expect(sheet()).toBeNull();
  });
});

describe("Ideas: a driving idea that needs checked advice", () => {
  it("has no orange Make the video, says what to do on a tap, has Edit it, and More like this is off", async () => {
    useMock();
    await render(<IdeasScreen ws="stories" page={{ name: "ideas" }} />);
    const tractor = card("Overtaking a tractor");
    expect(tractor.textContent).toContain("Needs checked advice");
    const make = button("Make the video", tractor);
    expect(make.classList.contains("st-btn--main")).toBe(false);
    expect(make.getAttribute("aria-disabled")).toBe("true");
    await click(make);
    expect(location.pathname).toBe("/stories/ideas");
    expect(card("Overtaking a tractor").textContent).toContain(BLOCKED_NEXT);
    // More like this would only offer more blocked drafts.
    const more = button("More like this", card("Overtaking a tractor"));
    expect(more.getAttribute("aria-disabled")).toBe("true");
    await click(more);
    expect(calls.some((c) => c.name === "ideaVariations")).toBe(false);
    // The way forward: Edit it opens the edit form.
    await click(button("Edit it", card("Overtaking a tractor")));
    expect(document.querySelector('form[aria-label="Edit Overtaking a tractor"]')).not.toBeNull();
    // A card that can become a video keeps its orange button.
    expect(button("Make the video", card("A deer on the road")).classList.contains("st-btn--main")).toBe(true);
  });

  it("a draft the task says needs checked advice is tagged before Save", () => {
    const task = { result: { drafts: [
      { title: "A", logline: "a", category: "driving_safety", needsGuidance: true },
      { title: "B", logline: "b", category: "driving_safety" },
      { title: "C", logline: "c", category: "comedy", needsGuidance: true },
    ] } } as unknown as AiTask;
    expect(offeredOf(task).map((o) => o.needsAdvice)).toEqual([true, false, false]);
    expect(offeredOf(task)[0]!.input).toEqual({ title: "A", logline: "a", category: "driving_safety", source: "ai" });
  });
});

describe("the practice API's driving drafts", () => {
  let mem: MockStore;
  let api: ReturnType<typeof ideasPart.api>;
  beforeEach(() => {
    vi.useFakeTimers();
    mem = createStore();
    mem.workspaces.push({ workspaceId: "stories", workspaceName: "Clips Funded", workspaceType: "stories", builtin: false, configuration: {}, version: 1 } as never);
    ideasPart.seed(mem);
    api = ideasPart.api(mem);
  });
  async function run<T>(p: Promise<T>): Promise<T> {
    const out = p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    await vi.advanceTimersByTimeAsync(1200);
    const r = await out;
    if (!r.ok) throw r.e;
    return r.v;
  }
  async function done(first: Promise<AiTask>): Promise<AiTask> {
    let task = await run(first);
    for (let i = 0; i < 30 && (task.status === "queued" || task.status === "running"); i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      task = await run(api.getTask("stories", task.taskId));
    }
    return task;
  }

  it("every offered driving draft matches checked advice once saved (no Needs checked advice)", async () => {
    for (const topic of ["", "a tyre", "rain", "snow", "the brakes"]) {
      const task = await done(api.generateIdeas("stories", { topic, category: "driving_safety", count: 6 }));
      const drafts = (task.result as { drafts: IdeaInput[] }).drafts;
      expect(drafts.length, topic).toBe(6);
      for (const d of drafts) {
        const saved: Idea = await run(api.createIdea("stories", d));
        expect(saved.needsGuidance, `${topic}: ${d.title}`).toBe(false);
        expect(saved.safetyTopicId, d.title).not.toBeNull();
      }
    }
  });

  it("More like this on a blocked idea says each draft needs checked advice", async () => {
    const task = await done(api.ideaVariations("stories", mem.ideas.find((i) => i.title === "Overtaking a tractor")!.ideaId, { count: 2 }));
    const drafts = (task.result as { drafts: (IdeaInput & { needsGuidance?: boolean })[] }).drafts;
    expect(drafts.every((d) => d.needsGuidance === true)).toBe(true);
  });
});

describe("Edit a full idea: an empty step", () => {
  const base: VideoConcept = { premise: "Pip slides.", beats: ["One", "Two", "Three", "Four"], lesson: null, ending: "Safe.", tone: "calm", durationSec: 45, onScreenText: [] };
  const idea = { title: "When the car starts to slide", logline: "Pip slides.", category: "driving_safety" as const };
  it("names the empty step, and says Remove only when it can be removed", () => {
    expect(ideaProblem(idea, { ...base, beats: ["", "Two", "Three"] })).toBe("Step 1 is empty: write what happens.");
    expect(ideaProblem(idea, { ...base, beats: ["One", "", "Three", "Four"] })).toBe("Step 2 is empty: write what happens, or remove it.");
    expect(ideaProblem(idea, { ...base, beats: ["One", "Two"] })).toBe("A full idea needs 3 to 8 steps.");
    expect(ideaProblem(idea, base)).toBeNull();
  });
});

// ---------- Setup ----------

describe("Setup", () => {
  const stepTitle = () => document.querySelector("#st-setup-step")?.textContent;
  const panel = () => document.querySelector<HTMLElement>(".st-setup__panel")!;
  const stepButton = (name: string) => $$<HTMLButtonElement>(".st-steps__item").find((b) => b.textContent?.includes(name))!;

  it("a step tapped while a save runs stays open (the save never pulls the child to the next step)", async () => {
    useMock({ fresh: true });
    await render(<SetupScreen ws="stories" page={{ name: "setup" } as never} />);
    expect(stepTitle()).toBe("Set up the AI");
    await act(async () => {
      tap(button(/These look right/));
      tap(stepButton("Connect X"));
    });
    await settle(12);
    expect(calls.filter((c) => c.name === "putAi")).toHaveLength(1);
    expect(stepTitle()).toBe("Connect X");
  });

  it("a done step has one orange button (Next); a connect step to do has only Skip for now to move on", async () => {
    useMock({ fresh: true });
    await render(<SetupScreen ws="stories" page={{ name: "setup" } as never} />);
    await click(button(/These look right/));
    await settle(8);
    expect(stepTitle()).toBe("Pick your default model");
    await click(button("Back", panel()));
    expect(stepTitle()).toBe("Set up the AI");
    const mains = $$(".st-btn--main", panel());
    expect(mains.map((b) => b.textContent?.trim())).toEqual(["Next"]);
    expect(button(/These look right/, panel()).classList.contains("st-btn--main")).toBe(false);

    await click(stepButton("Connect Instagram"));
    expect(stepTitle()).toBe("Connect Instagram");
    const foot = document.querySelector(".st-setup__foot")!;
    expect($$("button", foot).map((b) => b.textContent?.trim())).toEqual(["Back", "Skip for now"]);
  });
});

// ---------- Dashboard, references, Settings ----------

describe("the dashboard's Try again", () => {
  it("says the post's own reason when it came back still stuck, and nothing when it is on its way", () => {
    expect(stillStuck({ publishingStatus: "needs_attention", error: "This TikTok account needs connecting again. Open Clips Funded › Social accounts, then tap Try again." })).toContain("Social accounts");
    expect(stillStuck({ publishingStatus: "failed" })).toContain("Tap Open");
    expect(stillStuck({ publishingStatus: "queued" })).toBeNull();
  });
});

describe("a reference video", () => {
  it("only the first step runs until the job's own answer", () => {
    expect(waitingSteps(true).map((s) => s.status)).toEqual(["running", "pending", "pending"]);
    expect(waitingSteps(false).every((s) => s.status === "pending")).toBe(true);
  });

  it("a video that will not play says so in place of the controls, with Try again", async () => {
    const onRetry = vi.fn();
    const ref = createRef<HTMLVideoElement>();
    await render(<RefPlayer videoRef={ref} src="https://example.invalid/v.mp4" title="Penguin" onRetry={onRetry} />);
    expect(button("Play")).toBeTruthy();
    await act(async () => ref.current!.dispatchEvent(new Event("error")));
    expect(host.textContent).toContain(PLAY_FAILED);
    expect($$("button").some((b) => b.getAttribute("aria-label") === "Play" || b.textContent === "Play")).toBe(false);
    await click(button("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button("Play")).toBeTruthy();
    await act(async () => ref.current!.dispatchEvent(new Event("error")));
    expect(host.textContent).toContain(PLAY_FAILED_AGAIN);
  });
});

describe("Settings › Look › Picture", () => {
  it("says what is wrong with the file: not a photo, would not open, or too big", () => {
    expect(pickedProblem({ type: "application/pdf", size: 14 })).toBe(PICTURE_WORDS.notPicture);
    expect(pickedProblem({ type: "", size: 14 })).toBe(PICTURE_WORDS.notPicture);
    expect(pickedProblem({ type: "image/png", size: 30_000_000 })).toBe(PICTURE_WORDS.tooBig);
    expect(pickedProblem({ type: "image/png", size: 16 })).toBeNull();
    expect(shrinkProblem(new Error("unreadable"))).toBe("That picture would not open. Pick another one.");
    expect(shrinkProblem(new Error("not a picture"))).toBe("Pick a photo (JPG or PNG).");
  });
});

describe("Settings › Video › Prices", () => {
  it("a failed load shows the Failed card with Try again", async () => {
    const reload = vi.fn(async () => undefined);
    const ai = { data: null, error: "We could not reach Clips Funded. Check your connection, then tap Try again.", reload } as never;
    await render(<MakerPrices ai={ai} open={null} setOpen={() => undefined} />);
    expect(host.querySelector(".st-stg-failed")?.textContent).toContain("We could not reach Clips Funded.");
    await click(button(/Try again/));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
