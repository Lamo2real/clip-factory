// Lamo Stories › Set up Lamo Stories, steps 1 to 3 and the connect steps (docs/CONTRACTS.md §45.29, §45.34): step 1
// shows the models and their state with Check models and "These look right" (PUT …/ai picked ["environment"]); step
// 2 saves picked ["model"] and never an effort the owner did not pick (a model without today's level waits for step
// 3, then both are saved together); step 3 saves picked ["effort"]; the ring follows the server's ticks. A connect
// step for an account that is Lamo Clips' own says the step stays to do; Nova Reel's note never promises that the
// built-in animation takes over.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { SetupScreen } = await import("../src/stories/screens/Setup.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;
let calls: { name: string; args: unknown[] }[];

async function start(knobs: Record<string, unknown>, before?: (api: StoriesApi) => Promise<void>) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 30, ...knobs } };
  const real = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  if (before) await before(real);
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
  await act(async () =>
    root.render(
      <ToastProvider>
        <SetupScreen ws="stories" page={{ name: "setup" } as never} />
      </ToastProvider>,
    ),
  );
  await settle(8);
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = host) => Array.from(from.querySelectorAll<T>(sel));
function button(name: string | RegExp, from: ParentNode = host): HTMLButtonElement {
  const b = $$<HTMLButtonElement>("button", from).find((x) => (typeof name === "string" ? x.textContent?.trim() === name : name.test(x.textContent ?? "")));
  if (!b) throw new Error(`no button ${String(name)}; have: ${$$("button", from).map((x) => x.textContent?.trim()).join(" | ")}`);
  return b;
}
async function click(el: Element) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle(6);
}
const ring = () => $(".st-setup__head .st-ring")?.getAttribute("aria-label");
const stepTitle = () => $("#st-setup-step")?.textContent;
const putAis = () => calls.filter((c) => c.name === "putAi").map((c) => c.args[1] as Record<string, unknown>);
const stepState = (step: string) => store && $$(".st-steps__item").find((b) => b.textContent?.includes(step))?.className;

beforeEach(async () => {
  calls = [];
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  forgetLoaded();
  setMockLatency(0);
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

describe("step 1: set up the AI", () => {
  it("shows every model with its state, and These look right ticks it (picked environment)", async () => {
    await start({ fresh: true });
    expect(ring()).toBe("0 of 11 done");
    expect(stepTitle()).toBe("Set up the AI");
    const models = $$(".st-setup__model");
    expect(models.map((m) => m.querySelector(".st-setup__model-name")?.textContent)).toEqual(["Claude Fable 5.2", "Claude Fable 5.1", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Amazon Nova Pro"]);
    expect(models.find((m) => m.textContent?.includes("Fable 5.1"))?.textContent).toContain("No access");
    expect(models.find((m) => m.textContent?.includes("Sonnet 5.5"))?.textContent).toContain("Not checked yet");
    expect(button("Check models")).toBeTruthy();
    await click(button("These look right"));
    expect(putAis()).toHaveLength(1);
    expect(putAis()[0]).toEqual({ defaultModel: "opus-5-5", defaultEffort: "high", tasks: {}, prices: {}, version: 0, picked: ["environment"] });
    await settle(6);
    expect(ring()).toBe("1 of 11 done");
    expect(stepTitle()).toBe("Pick your default model");
    // Only step 1: the model and the effort were not picked.
    expect(stepState("Pick your default model")).toContain("is-todo");
    expect(stepState("Pick your default effort")).toContain("is-todo");
  });

  it("Check models alone ticks it too", async () => {
    await start({ fresh: true });
    await click(button("Check models"));
    await act(async () => await new Promise((r) => setTimeout(r, 1200)));
    await settle(10);
    expect(document.body.textContent).toContain("5 of 6 models answered.");
    expect($$(".st-setup__model").find((m) => m.textContent?.includes("Sonnet 5.5"))?.textContent).toContain("Works");
    expect(putAis()).toHaveLength(0);
    expect(ring()).toBe("1 of 11 done");
  });

  it("after Check models, step 2 starts from the fresh states, and a model you added is marked", async () => {
    await start({ fresh: true }, async (api) => {
      await api.putAiModel("stories", "custom-quick", { label: "Quick One", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: [], defaultEffort: null, vision: false, maxOutputTokens: 4096, price: null });
    });
    const line = (name: string) => $$("[role=radio]").find((r) => r.textContent?.includes(name))?.textContent ?? "";
    await click(button("Check models"));
    await act(async () => await new Promise((r) => setTimeout(r, 1200)));
    await settle(10);
    expect($$(".st-setup__model").find((m) => m.textContent?.includes("Sonnet 5.5"))?.textContent).toContain("Works");
    await click(button("Next"));
    expect(stepTitle()).toBe("Pick your default model");
    // Not the states from before the check: Sonnet answered, and nothing was loaded again by hand.
    expect(line("Claude Sonnet 5.5")).toContain("Works: it answered.");
    expect(line("Claude Sonnet 5.5")).not.toContain("Not checked yet");
    // Who makes it, on who runs it (§45.35 D8).
    expect(line("Quick One")).toContain("Amazon on Amazon Bedrock · Added by you · ");
    expect(line("Claude Opus 5.5")).not.toContain("Added by you");
  });
});

describe("steps 2 and 3: the default model and effort", () => {
  it("saves the model alone with picked model; then the effort with picked effort", async () => {
    await start({ fresh: true });
    await click(button("Pick your default model"));
    await click($$("[role=radio]").find((r) => r.textContent?.includes("Claude Fable 5.2"))!);
    await click(button("Use Claude Fable 5.2"));
    await settle(6);
    expect(putAis().at(-1)).toEqual({ defaultModel: "fable-5-2", defaultEffort: "high", tasks: {}, prices: {}, version: 0, picked: ["model"] });
    expect(ring()).toBe("1 of 11 done");
    expect(stepState("Pick your default model")).toContain("is-done");
    expect(stepState("Pick your default effort")).toContain("is-todo");
    expect(stepTitle()).toBe("Pick your default effort");
    await click($$("[role=radio]").find((r) => r.textContent?.startsWith("Maximum"))!);
    await click(button("Use Maximum"));
    await settle(6);
    expect(putAis().at(-1)).toEqual({ defaultModel: "fable-5-2", defaultEffort: "max", tasks: {}, prices: {}, version: 1, picked: ["effort"] });
    expect(ring()).toBe("2 of 11 done");
    expect(stepTitle()).toBe("Pick how videos are made");
  });

  it("never saves an effort the owner did not pick: a model without today's level waits for step 3", async () => {
    await start({ fresh: true }, async (api) => {
      await api.putAiModel("stories", "custom-quick", { label: "Quick One", provider: "Amazon", modelId: "eu.amazon.nova-lite-v1:0", region: "eu-north-1", efforts: ["low", "medium"], defaultEffort: "medium", vision: false, maxOutputTokens: 4096, price: null });
    });
    await click(button("Pick your default model"));
    await click($$("[role=radio]").find((r) => r.textContent?.includes("Quick One"))!);
    expect(document.body.textContent).toContain("Quick One does not offer High. Next you pick its level, then both are saved together.");
    await click(button("Use Quick One: pick its level next"));
    // Nothing saved yet; the effort step asks for its level, with nothing picked for the owner.
    expect(putAis()).toHaveLength(0);
    expect(stepTitle()).toBe("Pick your default effort");
    expect(document.body.textContent).toContain("Quick One does not offer High. Pick its level: then Quick One and that level are saved together.");
    expect($$("[role=radio]").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Low", "false"],
      ["MediumThe model's own", "false"],
    ]);
    await click(button("Pick a level first"));
    expect(putAis()).toHaveLength(0);
    await click($$("[role=radio]").find((r) => r.textContent === "Low")!);
    await click(button("Use Low"));
    await settle(6);
    expect(putAis()).toEqual([{ defaultModel: "custom-quick", defaultEffort: "low", tasks: {}, prices: {}, version: 0, picked: ["model", "effort"] }]);
    expect(stepState("Pick your default model")).toContain("is-done");
    expect(stepState("Pick your default effort")).toContain("is-done");
    expect(store.ai).toMatchObject({ defaultModel: "custom-quick", defaultEffort: "low" });
  });
});

describe("step 4 and the connect steps", () => {
  it("Luma AI Ray2's note (Nova Reel's before Amazon ended it) says videos stop until it is ready, never that the built-in animation takes over", async () => {
    await start({ fresh: true });
    await click(button("Pick how videos are made"));
    // §45.37 G7: Amazon ended Nova Reel, so step 4 never offers it; Luma AI Ray2 makes the AI cut-aways.
    expect($$("[role=radio]").some((r) => r.textContent?.includes("Amazon Nova Reel"))).toBe(false);
    await click($$("[role=radio]").find((r) => r.textContent?.includes("Luma AI Ray2"))!);
    // Every create, remake and change stops while it is not ready (§45.34 "A provider that is not ready"), whatever the scenes.
    expect(document.body.textContent).toContain("Until it is, new videos, remakes and changes stop and say what is missing: nothing switches to the built-in animation by itself.");
    expect(document.body.textContent).toContain("Pick Built-in animation above to keep making videos.");
    expect(document.body.textContent).not.toMatch(/a scene without characters stops/);
    expect(document.body.textContent).not.toMatch(/keep using the built-in animation/);
  });

  it("an account that is Lamo Clips' own keeps its step to do, and says so", async () => {
    await start({});
    await click(button("Connect X"));
    expect(stepTitle()).toBe("Connect X");
    expect(document.body.textContent).toContain("This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.");
    expect(stepState("Connect X")).not.toContain("is-done");
  });

  it("the connect step of Clip Factory's own account never offers sharing it, and says each account line once (§45.37 G8 (c), (d))", async () => {
    await start({});
    await click(button("Connect X"));
    // A different account made for Clips Funded; nothing to share it with. The card says both lines, and the step
    // around it does not say them again.
    const NEW = "Use a new account made for Clips Funded, not Clip Factory's.";
    const SAME = "This is Clip Factory's own account. Clips Funded needs its own separate account: sign in with a different one.";
    const step = $(".st-setup__body")!;
    const times = (text: string, line: string) => text.split(line).length - 1;
    expect(times(step.textContent!, NEW)).toBe(1);
    expect(times(document.body.textContent!, NEW)).toBe(1);
    expect(step.querySelector(".st-conn .st-conn__new")?.textContent).toBe(NEW);
    expect(times(step.textContent!, SAME)).toBe(1);
    expect(step.querySelector(".st-conn")?.textContent).toContain(SAME);
    expect(document.body.textContent).not.toMatch(/for both|both apps/i);
    for (const b of $$("button, [role=radio]")) expect(b.textContent ?? "").not.toMatch(/for both|share it/i);
  });

  it("step 4 of a workspace whose older pick is Amazon Nova Reel says it ended, with a one-tap replacement, and never saves it (§45.37 G7)", async () => {
    await start({ fresh: true }, async () => {
      const w = store.workspaces.find((x) => x.workspaceId === "stories")!;
      (w.configuration as { providers: Record<string, unknown> }).providers.video = "nova-reel";
    });
    await click(button(/^\d*Pick how videos are made/));
    expect(document.body.textContent).toContain("Amazon Nova Reel: Ended by Amazon on 30 Sep 2026.");
    expect(document.body.textContent).not.toContain("To make it ready");
    // "Use this" on the ended pick sends nothing.
    await click(button("Use this"));
    expect(calls.some((c) => c.name === "patchWorkspace")).toBe(false);
    // One tap picks Luma AI Ray2; then Use this saves only the video maker and its model.
    await click(button("Use Luma AI Ray2"));
    expect($$("[role=radio]").find((r) => r.textContent?.includes("Luma AI Ray2"))?.getAttribute("aria-checked")).toBe("true");
    await click(button("Use this"));
    const body = calls.filter((c) => c.name === "patchWorkspace").at(-1)?.args[1] as { configuration: { providers: Record<string, unknown> } };
    expect(body.configuration.providers).toEqual({ video: "luma-ray", videoModel: null });
  });
});
