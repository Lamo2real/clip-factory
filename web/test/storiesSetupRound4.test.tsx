// Lamo Stories › Set up Lamo Stories, round 4 (docs/CONTRACTS.md §45.35 D8, D11, D21; request 2 §8 "Step 4:
// Configure the video-generation provider", "guide me through connecting the accounts"): step 4 says the built-in
// animator makes tall, square and wide videos; every model names its maker on its host; and a platform whose
// account is Lamo Clips' own (stored so, or found later) stays to do with the server's same-as-Clips line, said under
// What is left and on its step.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { sameAsClipsLine } from "../src/stories/api/mock/onboarding.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { ModelInfo } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { BUILTIN_LINE, modelLine, SetupScreen } = await import("../src/stories/screens/Setup.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;

async function start(knobs: Record<string, unknown> = {}, before?: (store: MockStore) => void) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs };
  setStoriesApi(mockStoriesApi());
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  before?.(store);
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
const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = host) => Array.from(from.querySelectorAll<T>(sel));
const button = (name: string) => $$<HTMLButtonElement>("button").find((b) => b.textContent?.trim() === name)!;
async function click(el: Element) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle(6);
}

beforeEach(async () => {
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
});

describe("step 4 (§45.35 D21)", () => {
  it("says the built-in animator draws tall, square or wide videos at 30 frames a second, never only 9:16", async () => {
    expect(BUILTIN_LINE).toBe("On. Cartoons drawn right here, tall, square or wide, 30 frames a second.");
    await start({ fresh: true });
    await click(button("Pick how videos are made"));
    const builtin = $$("[role=radio]").find((r) => r.textContent?.includes("Built-in animation"))!;
    expect(builtin.textContent).toContain(BUILTIN_LINE);
    expect(builtin.textContent).not.toContain("9:16");
    // Luma AI Ray2 (Nova Reel's place since Amazon ended it, §45.37 G7) not ready yet: the note says how to make it ready (Try it, §45.35 D2).
    await click($$("[role=radio]").find((r) => r.textContent?.includes("Luma AI Ray2"))!);
    expect(host.textContent).toContain("To make it ready, tap Try it in Settings › Video: it makes one 5-second test shot.");
  });
});

describe("the models (§45.35 D8)", () => {
  it("each names its maker on who runs it, and an added one is marked", () => {
    const m = { provider: "Anthropic", host: "Amazon Bedrock", custom: false, status: "ok", statusLine: "It answered." } as ModelInfo;
    expect(modelLine(m)).toBe("Anthropic on Amazon Bedrock · Works: it answered.");
    expect(modelLine({ ...m, provider: "Mistral", custom: true, status: "not_checked" })).toBe("Mistral on Amazon Bedrock · Added by you · Not checked yet.");
    // An older model list that names the host as the maker: one name.
    expect(modelLine({ ...m, provider: "Amazon Bedrock" })).toBe("Amazon Bedrock · Works: it answered.");
  });
});

describe("Lamo Clips' own account (§45.35 D11)", () => {
  it("a stored connected account that turned out to be Lamo Clips' own stays to do, and What is left says why", async () => {
    await start({}, (s) => {
      // Lamo Clips connected the same X account later: the item still says connected.
      Object.assign(s.social.find((a) => a.platform === "x")!, { connectionStatus: "connected", sharedWithClips: false });
    });
    const x = $$(".st-steps__item").find((b) => b.textContent?.includes("Connect X"))!;
    expect(x.className).not.toContain("is-done");
    const why = host.querySelector(".st-left__why")!;
    expect(why).not.toBeNull();
    expect(why.textContent).toContain(sameAsClipsLine("x"));
    // Its step says it too, once: the card reads the account as the page shows it (Clip Factory's own) and says why in
    // the API's words; the step around it does not say it again.
    await click(button("Connect X"));
    const step = host.querySelector(".st-setup__body")!;
    const card = step.querySelector(".st-conn")!;
    expect(card.textContent).toMatch(/This is Clip Factory's (own account|account now)\./);
    expect(step.textContent!.split("This is Clip Factory's").length - 1).toBe(1);
    expect(store.social.find((a) => a.platform === "x")?.connectionStatus).toBe("same_as_clips");
  });

  it("an account that is Lamo Stories' own says nothing of the kind", async () => {
    await start({}, (s) => {
      // Its own id and its own handle (§45.37 G8: a matching handle alone would make it Clip Factory's).
      Object.assign(s.social.find((a) => a.platform === "x")!, { connectionStatus: "connected", sharedWithClips: false, externalAccountId: "1600000000000000002", accountName: "Clip Stories", handle: "@clipstories" });
    });
    expect(host.querySelector(".st-left__why")).toBeNull();
    expect($$(".st-steps__item").find((b) => b.textContent?.includes("Connect X"))!.className).toContain("is-done");
  });
});
