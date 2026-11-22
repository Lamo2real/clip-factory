// The shell between the two apps, Social accounts and the dashboard, round 5 (docs/CONTRACTS.md §45.36, the final
// check before the switch):
// - E1: on a phone Clip Factory's switch is in the top bar, which scrolls away with the page: a switch the owner
//   scrolled up to reach keeps the place he was reading, and the restore runs from the top bar's switcher too;
// - E13: one name for the other app ("Clip Factory", never "Lamo Clips"), and sentences that read right when an
//   account is itself called "Lamo Stories" ("this Facebook Page (Lamo Stories)");
// - E14: developer-app words and account ids behind "Technical details", under a plain first line;
// - E15: after Finish with steps skipped, the dashboard keeps "Finish setting up: {n} left" with them;
// - E16: Lamo Stories' rail keeps its brand and its switcher in view (only the pages scroll), and Clip Factory's phone
//   top bar drops the brand's name before its switch gets under 44 px (only while the switcher asks for it);
// - E18: Social accounts' cards flow by their own height; a reconnect clears the old warning (the mock, as the API).
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { forgetDashboards, forgetOnboarding, plainFirst } from "../src/stories/ui.tsx";
import { followReading, noteReading, READ_REST_MS, REACH_UP_MS, readingPlace, resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { ConnectionsScreen, OWN_APP_TECH, thisPlace } = await import("../src/stories/screens/Connections.tsx");
const { DashboardScreen } = await import("../src/stories/screens/Dashboard.tsx");

/** A source file of the web app, as written. */
const source = (path: string) => readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");

describe("where the owner was reading on a phone (§45.36 E1)", () => {
  beforeEach(() => resetWorkspaceMemory());

  it("a switch he scrolled up to reach keeps where he was reading", () => {
    noteReading("/library", 874, 1000, true);
    // He scrolls up to the top bar, and taps the switch at once.
    noteReading("/library", 300, 5000, false);
    noteReading("/library", 0, 5200, false);
    expect(readingPlace("/library", 0, 5400)).toBe(874);
    // The browser's scroll event may come after the tap: the page moved, so it left the reading place just now.
    resetWorkspaceMemory();
    noteReading("/library", 874, 1000, true);
    expect(readingPlace("/library", 0, 9000)).toBe(874);
  });

  it("keeps the top when he stayed there, scrolled down since, or the page is another one", () => {
    noteReading("/library", 874, 1000, true);
    noteReading("/library", 0, 2000, false);
    // Resting at the top: that is where he left it.
    noteReading("/library", 0, 2000 + READ_REST_MS, true);
    expect(readingPlace("/library", 0, 4000)).toBe(0);
    // Long after leaving the reading place, the switch keeps where the page is.
    noteReading("/library", 874, 5000, true);
    noteReading("/library", 0, 6000, false);
    expect(readingPlace("/library", 0, 6000 + REACH_UP_MS + 1)).toBe(0);
    // Further down than the reading place: where the page is now.
    noteReading("/library", 300, 20_000, true);
    expect(readingPlace("/library", 900, 20_100)).toBe(900);
    // Another page: its own place.
    expect(readingPlace("/jobs", 0, 20_100)).toBe(0);
  });

  it("follows the window's scroll and rests after a moment", () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(window, "scrollY", { configurable: true, value: 0, writable: true });
      const stop = followReading(() => "/review");
      (window as { scrollY: number }).scrollY = 640;
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(READ_REST_MS + 10);
      (window as { scrollY: number }).scrollY = 0;
      window.dispatchEvent(new Event("scroll"));
      expect(readingPlace("/review", 0, Date.now())).toBe(640);
      stop();
    } finally {
      vi.useRealTimers();
      (window as { scrollY: number }).scrollY = 0;
    }
  });

  it("the phone top bar's switcher restores the kept place too, and saves the reading place (Nav.tsx)", () => {
    const nav = source("components/Nav.tsx");
    expect(nav).toContain('if ((place !== "sidebar" && place !== "topbar") || !active) return;');
    expect(nav).toContain('place === "topbar" ? readingPlace(from, window.scrollY, Date.now()) : window.scrollY');
  });
});

describe("the switchers stay in reach (§45.36 E16)", () => {
  it("the rail keeps its brand and switcher in view: only the list of pages scrolls", () => {
    const css = source("stories/styles/stories.css");
    const rail = /@media \(min-width: 768px\) \{[\s\S]*?\.st-rail \{([\s\S]*?)\n {2}\}/.exec(css)![1]!;
    expect(rail).toContain("overflow: hidden;");
    expect(rail).not.toContain("overflow-y: auto");
    expect(css).toMatch(/\.st-rail \.st-rail__list \{[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.st-rail \.st-rail__foot \{\s*flex: none;/);
  });

  it("the phone top bar drops the brand's name only while the switcher asks for it", () => {
    const glide = source("styles/glide.css");
    expect(glide).toMatch(/\.topbar:has\(> \.ws-switch-host--topbar\[data-ws-squeeze\]\) \.brand__name \{\s*display: none;/);
    // Nothing else of the top bar is styled from here, and with Lamo Stories off the switcher (and its mark) is never there.
    expect(glide.match(/\.topbar:has\(/g)).toHaveLength(2);
    const nav = source("components/Nav.tsx");
    expect(nav).toContain('data-ws-squeeze={squeeze ? "" : undefined}');
    expect(nav).toContain("if (!storiesEnabled()) return null;");
  });
});

describe("plain first lines (§45.36 E14)", () => {
  it("lines with developer words go behind the fold; the rest stay", () => {
    const { plain, tech } = plainFirst([
      "Until TikTok says yes, the account must be private.",
      "While TikTok is still checking the app, only test accounts added in TikTok's Sandbox can connect.",
      "While the Meta app is in Development mode, only you can connect. Going Live needs Meta's App Review.",
      "Add the redirect URI below.",
    ]);
    expect(plain).toEqual(["Until TikTok says yes, the account must be private."]);
    expect(tech).toHaveLength(3);
    expect(plainFirst(["You will learn a lot."]).tech).toEqual([]);
  });
});

describe("Social accounts (§45.36 E13, E14, E18)", () => {
  let host: HTMLElement;
  let root: Root;
  let store: MockStore;
  let api: StoriesApi;

  async function render() {
    await act(async () =>
      root.render(
        <ToastProvider>
          <ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 4; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  beforeEach(async () => {
    await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    api = mockStoriesApi();
    store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
    setStoriesApi(api);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    localStorage.clear();
  });

  const card = (platform: string) => host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
  const button = (el: HTMLElement, name: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
  const click = async (b: HTMLElement | undefined) => {
    expect(b).toBeTruthy();
    await act(async () => b!.click());
    for (let i = 0; i < 3; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  /** What a card shows before any fold is opened. */
  const shown = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const d of Array.from(copy.querySelectorAll("details"))) for (const c of Array.from(d.children)) if (c.tagName !== "SUMMARY") c.remove();
    return copy.textContent ?? "";
  };

  it("calls the other app Clip Factory everywhere on the page, never Lamo Clips", async () => {
    await render();
    expect(host.textContent).toContain("Clip Factory");
    expect(host.textContent).not.toContain("Lamo Clips");
    // Every card's limits too, with either developer app.
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"] as const) for (const l of store.social.find((a) => a.platform === p)!.limits) expect(l).not.toContain("Lamo Clips");
  });

  it("an account called Lamo Stories reads right: this Facebook Page (Lamo Stories)", async () => {
    expect(thisPlace({ platform: "facebook", accountName: "Lamo Stories", handle: null })).toBe("this Facebook Page (Lamo Stories)");
    expect(thisPlace({ platform: "tiktok", accountName: null, handle: "@lamo.stories" })).toBe("this TikTok account (@lamo.stories)");
    expect(thisPlace({ platform: "youtube", accountName: null, handle: null })).toBe("this YouTube channel");
    await render();
    const yt = card("youtube");
    await click(button(yt, "Disconnect"));
    expect(yt.querySelector(".st-sure__ask")?.textContent).toBe("Are you sure? Lamo Stories stops posting to this YouTube channel (Lamo Stories). Clip Factory is not touched.");
    expect(yt.querySelector(".st-sure__ask")?.textContent).not.toMatch(/posting to Lamo Stories/);
    const x = card("x");
    await click(button(x, "Use it for both"));
    expect(x.querySelector(".st-sure__ask")?.textContent).toBe("Are you sure? Clip Factory and Lamo Stories will both post to this X account (Clip Factory).");
  });

  it("account and app ids sit behind Technical details; the card's first lines are plain words", async () => {
    await render();
    for (const p of ["youtube", "tiktok", "x"]) {
      const id = store.social.find((a) => a.platform === p)!.externalAccountId!;
      const c = card(p);
      expect(c.textContent).toContain(id);
      expect(shown(c)).not.toContain(id);
      const fold = c.querySelector<HTMLDetailsElement>(".st-who details.st-tech-fold")!;
      expect(fold.open).toBe(false);
      expect(fold.querySelector(".st-who__id code")?.textContent).toBe(id);
    }
    // The own Meta app: its App ID and Configuration ID in the fold, the redirect words too.
    const insta = card("instagram");
    expect(insta.querySelector(".st-app")!.textContent).toContain("123456…3456");
    expect(shown(insta)).not.toContain("123456…3456");
    expect(shown(insta)).not.toMatch(/Valid OAuth|Login configuration|App Review|Development mode|Sandbox|redirect URI/i);
    expect(insta.textContent).toContain("Valid OAuth Redirect URIs");
    expect(shown(insta)).toContain("Copy these two addresses into your Meta app's settings");
    // TikTok's Sandbox line goes behind the fold; its plain lines stay.
    const tiktok = card("tiktok");
    expect(shown(tiktok)).not.toContain("Sandbox");
    expect(tiktok.querySelector(".st-limits details")?.textContent).toContain("Sandbox");
    expect(shown(tiktok)).toContain("Until TikTok says yes, the account must be private");
  });

  it("a separate app's steps say what to do in plain words, with the developer site's words one tap away", async () => {
    store.knobs.fresh = true;
    store.social = store.social.map((a) => ({ ...a, app: { choice: null, saved: false } }));
    await render();
    const yt = card("youtube");
    await click(Array.from(yt.querySelectorAll<HTMLButtonElement>("[role=radio]")).find((r) => /A separate app/.test(r.textContent ?? "")));
    const go = yt.querySelector<HTMLElement>(".st-app__go")!;
    expect(go.querySelector(".st-app__notes")?.textContent).toContain("Copy the address below into your app's settings (not Clip Factory's).");
    expect(go.querySelector(".st-app__notes")?.textContent).not.toMatch(/redirect URI|OAuth/i);
    expect(go.querySelector(".st-copy__label")?.textContent).toBe("The address to copy");
    expect(go.querySelector(".st-copy__btn")?.getAttribute("aria-label")).toBe("Copy the redirect URI");
    expect(go.querySelector("details.st-tech-fold")?.textContent).toContain(OWN_APP_TECH.youtube[0]);
    const fb = card("facebook");
    expect(fb.querySelector(".st-app__notes")?.textContent).not.toMatch(/Valid OAuth|Login configuration|App Review|Development mode/);
    expect(fb.querySelector(".st-app__go details.st-tech-fold")?.textContent).toContain("Login configuration");
    expect(fb.querySelector(".st-app__go details.st-tech-fold")?.textContent).toContain("App Review");
  });

  it("a reconnect clears the old keys-changed warning (the mock as the API), and a connected card never shows it", async () => {
    await render();
    expect(card("tiktok").textContent).toContain("The TikTok app keys changed. Connect again.");
    await api.connectSocial("stories", "tiktok");
    const after = store.social.find((a) => a.platform === "tiktok")!;
    expect(after).toMatchObject({ connectionStatus: "connected", warning: null, reason: null });
    // An older answer that still carries it: the connected card does not say it.
    store.social = store.social.map((a) => (a.platform === "tiktok" ? { ...a, warning: "The TikTok app keys changed. Connect again." } : a));
    act(() => root.unmount());
    root = createRoot(host);
    forgetLoaded();
    await render();
    expect(card("tiktok").querySelector(".st-chip")?.textContent).toBe("Connected");
    expect(card("tiktok").textContent).not.toContain("app keys changed");
  });

  it("the cards flow by their own height at every width, never in rows that leave holes", () => {
    const css = source("stories/styles/stories.css");
    expect(css).toMatch(/\.st-conns:not\(\.st-conns--one\) \{\s*display: block;\s*columns: 340px;/);
    expect(css).toMatch(/\.st-conns:not\(\.st-conns--one\) > \.st-conn \{[^}]*break-inside: avoid;/);
  });
});

describe("Finish setting up (§45.36 E15)", () => {
  let host: HTMLElement;
  let root: Root;
  let api: StoriesApi;

  beforeEach(() => {
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    api = mockStoriesApi();
    setStoriesApi(api);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
  });

  async function dashboard() {
    forgetOnboarding();
    forgetDashboards();
    await act(async () =>
      root.render(
        <ToastProvider>
          <DashboardScreen ws="stories" page={{ name: "dashboard" }} />
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  it("after Finish with steps skipped, a small card lists what is left and opens the setup", async () => {
    for (const step of ["tiktok", "facebook", "x"] as const) await api.patchOnboarding("stories", { step, skipped: true });
    await api.patchOnboarding("stories", { finish: true });
    const o = await api.getOnboarding("stories");
    const left = o.steps.filter((s) => s.state !== "done" && s.step !== "done");
    expect(left.length).toBeGreaterThanOrEqual(3);
    await dashboard();
    const card = host.querySelector<HTMLElement>(".st-setupcard--left")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("h2")?.textContent).toBe(`Finish setting up: ${left.length} left`);
    expect(Array.from(card.querySelectorAll(".st-setupcard__list li")).map((l) => l.textContent)).toEqual(left.map((s) => s.label));
    expect(Array.from(card.querySelectorAll(".st-setupcard__list li")).map((l) => l.textContent)).toEqual(expect.arrayContaining(["Connect TikTok", "Connect Facebook", "Connect X"]));
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/stories/setup");
    // The big setup card is gone once finished.
    expect(host.textContent).not.toContain("Set up Lamo Stories:");
  });

  it("before Finish the usual setup card shows; finished with nothing left there is no card at all", async () => {
    await dashboard();
    expect(host.querySelector(".st-setupcard:not(.st-setupcard--left)")).not.toBeNull();
    expect(host.querySelector(".st-setupcard--left")).toBeNull();
    // Finished with every step done: nothing to finish.
    const real = api.getOnboarding.bind(api);
    vi.spyOn(api, "getOnboarding").mockImplementation(async (ws) => {
      const o = await real(ws);
      return { ...o, steps: o.steps.map((s) => ({ ...s, state: "done" as const })), done: 11, finishedAt: new Date().toISOString() };
    });
    await dashboard();
    expect(host.querySelector(".st-setupcard")).toBeNull();
  });
});
