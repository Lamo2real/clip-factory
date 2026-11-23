// Lamo Stories › Social accounts, round 4 (docs/CONTRACTS.md §45.35 D11, D17, D21; request 2 §7 "Show connection
// and authorization status", "Lamo Clips' account found later"; the owner's rules: brief update labels, the hidden
// app never moves him): Check now is not on a card whose Page or account is still to be picked (the API answers 409
// there); picking from the list says it once (the "Is this your Lamo Stories …?" question follows, and its Yes
// cheers); a Connect whose sign-in page answers while Clip Factory is on screen waits for Lamo Stories to be back; and
// an account Lamo Clips connected later reads as Clip Factory's own on the page and in the setup.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { sameAsClipsLine } from "../src/stories/api/mock/onboarding.ts";
import { sameAsClips } from "../src/stories/api/mock/social.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moves: string[] = [];
vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: (to: string) => void moves.push(to) };
});

const { ConnectionsScreen } = await import("../src/stories/screens/Connections.tsx");
const { takeParkedStoriesGo } = await import("../src/stories/pane.tsx");

let host: HTMLElement;
let root: Root;
let store: MockStore;
let api: StoriesApi;

async function render(knobs: Record<string, unknown> = {}) {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs };
  api = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  setStoriesApi(api);
  await act(async () =>
    root.render(
      <ToastProvider>
        <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
      </ToastProvider>,
    ),
  );
  await settle();
}
async function settle(times = 5) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const card = (platform: string) => host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
const button = (el: ParentNode, name: string | RegExp) =>
  Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
const click = async (b: HTMLElement | undefined) => {
  expect(b).toBeTruthy();
  await act(async () => b!.click());
  await settle(4);
};
const toasts = () => Array.from(document.querySelectorAll(".toast__text")).map((t) => t.textContent?.trim());

beforeEach(async () => {
  moves.length = 0;
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  setMockLatency(0);
  history.replaceState(null, "", "/stories/connections");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
  localStorage.clear();
  history.replaceState(null, "", "/");
});

describe("Check now (§45.35 D21)", () => {
  it("is not on a card whose Page or account is still to be picked, and is on the others that are connected", async () => {
    await render();
    expect(store.social.find((a) => a.platform === "instagram")?.connectionStatus).toBe("choose_account");
    expect(button(card("instagram"), /Check now/)).toBeUndefined();
    // The list and the other ways out are still there.
    expect(card("instagram").querySelector(".st-choose__list")).not.toBeNull();
    expect(button(card("instagram"), "Disconnect")).toBeTruthy();
    expect(button(card("instagram"), /Pick another/)).toBeTruthy();
    for (const p of ["youtube", "tiktok", "x"]) expect(button(card(p), /Check now/), p).toBeTruthy();
    expect(button(card("facebook"), /Check now/)).toBeUndefined();
  });
});

describe("one toast per pick (§45.35 D21)", () => {
  it("picking Lamo Stories' own account asks the question with no toast of its own; Yes says it once", async () => {
    await render();
    await click(button(card("instagram"), /lamo\.stories/));
    expect(toasts()).toEqual([]);
    const ask = card("instagram").querySelector<HTMLElement>(".st-intended")!;
    expect(ask.textContent).toContain("Is this your Clip Factory Stories account?");
    await click(button(ask, "Yes, that's it"));
    expect(toasts()).toEqual(["Great! Clip Factory Stories posts to this Instagram account (lamo.stories)."]);
  });

  it("tapping Clip Factory's own place says why once, sends nothing and asks nothing (§45.37 G8)", async () => {
    await render();
    await click(button(card("instagram"), /clipfactory\.gg/));
    expect(toasts()).toEqual(["This is Clip Factory's own account. Clip Factory Stories needs its own separate account: sign in with a different one."]);
    expect(card("instagram").querySelector(".st-intended")).toBeNull();
    expect((await api.social("stories")).accounts.find((a) => a.platform === "instagram")?.connectionStatus).toBe("choose_account");
  });
});

describe("Connect while Clip Factory is on screen (§45.35 D17)", () => {
  it("a sign-in page that answers then waits for Lamo Stories to be back; it never moves the owner out of Clip Factory", async () => {
    localStorage.setItem("cf.storiesPreview", "1");
    await render({ connectResult: "connected" });
    // The owner taps Connect on Facebook, then switches to Clip Factory before the server answers.
    const connect = button(card("facebook"), "Connect Facebook");
    expect(connect).toBeTruthy();
    const answer = api.connectSocial;
    let release: () => void = () => undefined;
    (api as unknown as Record<string, unknown>).connectSocial = (...args: Parameters<StoriesApi["connectSocial"]>) =>
      new Promise((done) => {
        release = () => done(answer(...args));
      });
    await click(connect);
    history.replaceState(null, "", "/library");
    await act(async () => release());
    await settle(6);
    expect(moves).toEqual([]);
    expect(location.pathname).toBe("/library");
    // It happens once Lamo Stories is on screen again (StoriesApp takes it then).
    expect(takeParkedStoriesGo()).toBe("/stories/connections?platform=facebook&result=connected&ws=stories");
  });
});

describe("Lamo Clips' account found later (§45.35 D11)", () => {
  it("a stored connected account that is Lamo Clips' own reads as Clip Factory's on the page, and its setup step says why", async () => {
    await render();
    // Lamo Clips connected the same X account after Lamo Stories did: the item still says connected.
    const x = store.social.find((a) => a.platform === "x")!;
    Object.assign(x, { connectionStatus: "connected", sharedWithClips: false });
    expect(sameAsClips(x)).toBe(true);
    const o = await api.getOnboarding("stories");
    expect(o.steps.find((s) => s.step === "x")).toEqual({ step: "x", label: "Connect X", state: "todo", line: sameAsClipsLine("x") });
    // §45.37 G8: never "use it for both"; a separate account.
    expect(sameAsClipsLine("x")).toBe("This is Clip Factory's own account. Clip Factory Stories needs its own separate account: sign in with a different one.");
    const fresh = await api.social("stories");
    expect(fresh.accounts.find((a) => a.platform === "x")).toMatchObject({ connectionStatus: "same_as_clips", reason: "clips_now", warning: "This is Clip Factory's account now. Connect a different account made for Clip Factory Stories." });
    // A separate account made for Clip Factory Stories: connected, and the step ticks.
    await api.connectSocial("stories", "x");
    const after = await api.getOnboarding("stories");
    expect(after.steps.find((s) => s.step === "x")).toEqual({ step: "x", label: "Connect X", state: "done" });
  });
});
