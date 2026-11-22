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
// - E17: the Needs you bar on the page it points to never sends the owner there again: Social accounts' sentence says
//   "below", and Show me brings the card to fix into view;
// - E18: Social accounts' cards flow by their own height; a reconnect clears the old warning (the mock, as the API).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import {
  setMockLatency,
  type MockStore,
} from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
import {
  forgetDashboards,
  forgetOnboarding,
  NeedsYouBar,
  plainFirst,
  socialHere,
} from "../src/stories/ui.tsx";
import {
  followReading,
  noteReading,
  READ_REST_MS,
  readingPlace,
  resetWorkspaceMemory,
  TOP_REST_MS,
} from "../src/stories/workspace.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const {
  ConnectionsScreen,
  columnsFor,
  OWN_APP_TECH,
  shortestColumns,
  thisPlace,
} = await import("../src/stories/screens/Connections.tsx");
const { DashboardScreen } =
  await import("../src/stories/screens/Dashboard.tsx");

/** A source file of the web app, as written. */
/** A stylesheet's text with its `@import "./x.css"` lines inlined in order (stories.css and studio.css are indexes). */
const withImports = (file: string): string =>
  readFileSync(file, "utf8").replace(
    /@import "\.\/([^"]+)";[^\n]*\n?/g,
    (_m, f: string) => withImports(join(dirname(file), f)) + "\n",
  );
const source = (path: string) =>
  withImports(join(import.meta.dirname, "..", "src", path));

describe("where the owner was reading on a phone (§45.36 E1)", () => {
  beforeEach(() => resetWorkspaceMemory());

  it("a switch he scrolled up to reach keeps where he was reading, however long the way up took", () => {
    noteReading("/library", 1500, READ_REST_MS, 60);
    // He scrolls up to the top bar in short flicks (no rest), and taps the switch at once.
    for (const y of [1300, 1000, 700, 400, 100, 0])
      noteReading("/library", y, 0, 60);
    expect(readingPlace("/library", 0)).toBe(1500);
    // A status-bar tap to the top and two seconds to find the switch: still where he was reading.
    noteReading("/library", 0, READ_REST_MS, 60);
    expect(readingPlace("/library", 0)).toBe(1500);
    // Just below the top bar's switch, the same.
    noteReading("/library", 40, READ_REST_MS, 60);
    expect(readingPlace("/library", 40)).toBe(1500);
  });

  it("a rest below the top bar is the new reading place; a long rest at the top keeps the top", () => {
    noteReading("/library", 1500, READ_REST_MS, 60);
    // He stopped to read further up on the way: that is the place now.
    noteReading("/library", 700, READ_REST_MS, 60);
    expect(readingPlace("/library", 0)).toBe(700);
    // A short stop on the way does not count.
    noteReading("/library", 300, READ_REST_MS - 1, 60);
    expect(readingPlace("/library", 0)).toBe(700);
    // Reading at the top for a while: the top is where he left it.
    noteReading("/library", 0, TOP_REST_MS, 60);
    expect(readingPlace("/library", 0)).toBe(0);
    // Further down than the reading place: where the page is now.
    noteReading("/library", 300, READ_REST_MS, 60);
    expect(readingPlace("/library", 900)).toBe(900);
    // Another page: its own place, from the first sight of it.
    expect(readingPlace("/jobs", 0)).toBe(0);
    noteReading("/jobs", 0, 0, 60);
    expect(readingPlace("/jobs", 0)).toBe(0);
  });

  it("follows the window's scroll: a rest counts from the last move, not from leaving the reading place", () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(window, "scrollY", {
        configurable: true,
        value: 0,
        writable: true,
      });
      const scrollTo = (y: number) => {
        (window as { scrollY: number }).scrollY = y;
        window.dispatchEvent(new Event("scroll"));
      };
      const stop = followReading(
        () => "/review",
        () => 60,
      );
      scrollTo(1500);
      vi.advanceTimersByTime(READ_REST_MS + 10);
      expect(readingPlace("/review", 0)).toBe(1500);
      // A six-second way up in flicks half a second apart, then the switch at once.
      for (let y = 1400; y >= 0; y -= 125) {
        scrollTo(y);
        vi.advanceTimersByTime(500);
      }
      scrollTo(0);
      expect(readingPlace("/review", 0)).toBe(1500);
      // Two seconds at the top looking for the switch: still the reading place.
      vi.advanceTimersByTime(2000);
      expect(readingPlace("/review", 0)).toBe(1500);
      // Ten seconds at the top: he reads there now.
      vi.advanceTimersByTime(TOP_REST_MS);
      expect(readingPlace("/review", 0)).toBe(0);
      stop();
      // Back on the same page (Clip Factory on screen again before its place is put back): the reading place stays.
      noteReading("/review", 1500, READ_REST_MS, 60);
      const again = followReading(
        () => "/review",
        () => 60,
      );
      expect(readingPlace("/review", 0)).toBe(1500);
      again();
    } finally {
      vi.useRealTimers();
      (window as { scrollY: number }).scrollY = 0;
    }
  });

  it("the phone top bar's switch saves the reading place, and Clip Factory restores it once back on screen (§45.37)", () => {
    // The switch is the shell's now (app/WorkspaceDock.tsx), one for both apps; Clip Factory's shell puts the kept
    // place back whenever its pane is on screen again, phone or computer.
    const dock = source("app/WorkspaceDock.tsx");
    expect(dock).toContain(
      "y: clips && phone ? readingPlace(from, window.scrollY) : window.scrollY",
    );
    expect(dock).toContain("followReading(here, topZone)");
    const app = source("app/App.tsx");
    expect(app).toMatch(
      /if \(!active \|\| !hosted\) return;[\s\S]*?const y = takeClipsScroll\(at\);\s*return y === null \? undefined : restoreScroll\(y\);/,
    );
  });
});

describe("the switchers stay in reach (§45.36 E16)", () => {
  it("the rail keeps its brand and switcher in view: only the list of pages scrolls", () => {
    const css = source("stories/styles/stories.css");
    const rail =
      /@media \(min-width: 768px\) \{[\s\S]*?\.st-rail \{([\s\S]*?)\n {2}\}/.exec(
        css,
      )![1]!;
    expect(rail).toContain("overflow: hidden;");
    expect(rail).not.toContain("overflow-y: auto");
    expect(css).toMatch(
      /\.st-rail \.st-rail__list \{[^}]*min-height: 0;[^}]*overflow-y: auto;/,
    );
    expect(css).toMatch(/\.st-rail \.st-rail__foot \{\s*flex: none;/);
  });

  it("the phone top bar drops the brand's name only while the switcher asks for it", () => {
    const glide = source("styles/glide.css");
    expect(glide).toMatch(
      /\.topbar:has\(> \.ws-switch-host--topbar\[data-ws-squeeze\]\) \.brand__name \{\s*display: none;/,
    );
    // Nothing else of the top bar is styled from here, and with Lamo Stories off the switcher (and its mark) is never there.
    expect(glide.match(/\.topbar:has\(/g)).toHaveLength(2);
    const dock = source("app/WorkspaceDock.tsx");
    expect(dock).toContain('data-ws-squeeze={squeeze ? "" : undefined}');
    // Only next to Lamo Stories: the shell draws it (BothApps), and Clip Factory's top bar only while it is hosted.
    const app = source("app/App.tsx");
    expect(app).toContain("{storiesEnabled() ? <BothApps /> : <Shell />}");
    expect(app).toContain("{hosted ? <TopBarSwitch /> : <LiveDot />}");
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
    expect(plain).toEqual([
      "Until TikTok says yes, the account must be private.",
    ]);
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
          <ConnectionsScreen
            ws="stories"
            page={{
              name: "connections",
              platform: null,
              result: null,
              ws: null,
            }}
          />
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 4; i++)
      await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  beforeEach(async () => {
    await loadConfig(
      async () =>
        new Response(
          JSON.stringify({
            region: "eu-north-1",
            userPoolId: "eu-north-1_x",
            userPoolClientId: "c",
            apiUrl: "https://api.test/",
          }),
        ),
    );
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    api = mockStoriesApi();
    store = (window as unknown as { __cfStoriesMock: { store: MockStore } })
      .__cfStoriesMock.store;
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

  const card = (platform: string) =>
    host.querySelector<HTMLElement>(`.st-conn[data-platform="${platform}"]`)!;
  const button = (el: HTMLElement, name: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      typeof name === "string"
        ? b.textContent?.trim() === name
        : name.test(b.textContent ?? ""),
    );
  const click = async (b: HTMLElement | undefined) => {
    expect(b).toBeTruthy();
    await act(async () => b!.click());
    for (let i = 0; i < 3; i++)
      await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  /** What a card shows before any fold is opened. */
  const shown = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    for (const d of Array.from(copy.querySelectorAll("details")))
      for (const c of Array.from(d.children))
        if (c.tagName !== "SUMMARY") c.remove();
    return copy.textContent ?? "";
  };

  it("calls the other app Clip Factory everywhere on the page, never Lamo Clips", async () => {
    await render();
    expect(host.textContent).toContain("Clip Factory");
    expect(host.textContent).not.toContain("Lamo Clips");
    // Every card's limits too, with either developer app.
    for (const p of [
      "youtube",
      "tiktok",
      "instagram",
      "facebook",
      "x",
    ] as const)
      for (const l of store.social.find((a) => a.platform === p)!.limits)
        expect(l).not.toContain("Lamo Clips");
  });

  it("an account called Lamo Stories reads right: this Facebook Page (Lamo Stories)", async () => {
    expect(
      thisPlace({
        platform: "facebook",
        accountName: "Lamo Stories",
        handle: null,
      }),
    ).toBe("this Facebook Page (Lamo Stories)");
    expect(
      thisPlace({
        platform: "tiktok",
        accountName: null,
        handle: "@lamo.stories",
      }),
    ).toBe("this TikTok account (@lamo.stories)");
    expect(
      thisPlace({ platform: "youtube", accountName: null, handle: null }),
    ).toBe("this YouTube channel");
    await render();
    const yt = card("youtube");
    await click(button(yt, "Disconnect"));
    expect(yt.querySelector(".st-sure__ask")?.textContent).toBe(
      "Are you sure? Lamo Stories stops posting to this YouTube channel (Lamo Stories). Clip Factory is not touched.",
    );
    expect(yt.querySelector(".st-sure__ask")?.textContent).not.toMatch(
      /posting to Lamo Stories/,
    );
    const x = card("x");
    await click(button(x, "Use it for both"));
    expect(x.querySelector(".st-sure__ask")?.textContent).toBe(
      "Are you sure? Clip Factory and Lamo Stories will both post to this X account (Clip Factory).",
    );
  });

  it("account and app ids sit behind Technical details; the card's first lines are plain words", async () => {
    await render();
    for (const p of ["youtube", "tiktok", "x"]) {
      const id = store.social.find((a) => a.platform === p)!.externalAccountId!;
      const c = card(p);
      expect(c.textContent).toContain(id);
      expect(shown(c)).not.toContain(id);
      const fold = c.querySelector<HTMLDetailsElement>(
        ".st-who details.st-tech-fold",
      )!;
      expect(fold.open).toBe(false);
      expect(fold.querySelector(".st-who__id code")?.textContent).toBe(id);
    }
    // The own Meta app: its App ID and Configuration ID in the fold, the redirect words too.
    const insta = card("instagram");
    expect(insta.querySelector(".st-app")!.textContent).toContain(
      "123456…3456",
    );
    expect(shown(insta)).not.toContain("123456…3456");
    expect(shown(insta)).not.toMatch(
      /Valid OAuth|Login configuration|App Review|Development mode|Sandbox|redirect URI/i,
    );
    expect(insta.textContent).toContain("Valid OAuth Redirect URIs");
    expect(shown(insta)).toContain(
      "Copy these two addresses into your Meta app's settings",
    );
    // TikTok's Sandbox line goes behind the fold; its plain lines stay.
    const tiktok = card("tiktok");
    expect(shown(tiktok)).not.toContain("Sandbox");
    expect(tiktok.querySelector(".st-limits details")?.textContent).toContain(
      "Sandbox",
    );
    expect(shown(tiktok)).toContain(
      "Until TikTok says yes, the account must be private",
    );
  });

  it("a separate app's steps say what to do in plain words, with the developer site's words one tap away", async () => {
    store.knobs.fresh = true;
    store.social = store.social.map((a) => ({
      ...a,
      app: { choice: null, saved: false },
    }));
    await render();
    const yt = card("youtube");
    await click(
      Array.from(yt.querySelectorAll<HTMLButtonElement>("[role=radio]")).find(
        (r) => /A separate app/.test(r.textContent ?? ""),
      ),
    );
    const go = yt.querySelector<HTMLElement>(".st-app__go")!;
    expect(go.querySelector(".st-app__notes")?.textContent).toContain(
      "Copy the address below into your app's settings (not Clip Factory's).",
    );
    expect(go.querySelector(".st-app__notes")?.textContent).not.toMatch(
      /redirect URI|OAuth/i,
    );
    expect(go.querySelector(".st-copy__label")?.textContent).toBe(
      "The address to copy",
    );
    expect(go.querySelector(".st-copy__btn")?.getAttribute("aria-label")).toBe(
      "Copy the redirect URI",
    );
    expect(go.querySelector("details.st-tech-fold")?.textContent).toContain(
      OWN_APP_TECH.youtube[0],
    );
    const fb = card("facebook");
    expect(fb.querySelector(".st-app__notes")?.textContent).not.toMatch(
      /Valid OAuth|Login configuration|App Review|Development mode/,
    );
    expect(
      fb.querySelector(".st-app__go details.st-tech-fold")?.textContent,
    ).toContain("Login configuration");
    expect(
      fb.querySelector(".st-app__go details.st-tech-fold")?.textContent,
    ).toContain("App Review");
  });

  it("a reconnect clears the old keys-changed warning (the mock as the API), and a connected card never shows it", async () => {
    await render();
    expect(card("tiktok").textContent).toContain(
      "The TikTok app keys changed. Connect again.",
    );
    await api.connectSocial("stories", "tiktok");
    const after = store.social.find((a) => a.platform === "tiktok")!;
    expect(after).toMatchObject({
      connectionStatus: "connected",
      warning: null,
      reason: null,
    });
    // An older answer that still carries it: the connected card does not say it.
    store.social = store.social.map((a) =>
      a.platform === "tiktok"
        ? { ...a, warning: "The TikTok app keys changed. Connect again." }
        : a,
    );
    act(() => root.unmount());
    root = createRoot(host);
    forgetLoaded();
    await render();
    expect(card("tiktok").querySelector(".st-chip")?.textContent).toBe(
      "Connected",
    );
    expect(card("tiktok").textContent).not.toContain("app keys changed");
  });

  it("the cards flow by their own height: each goes into the shortest column, and keeps it", () => {
    // As many 340 px columns as fit, with 16 px between them.
    expect([320, 695, 696, 1051, 1052, 1440].map(columnsFor)).toEqual([
      1, 1, 2, 2, 3, 4,
    ]);
    // The mock's five cards at 1440 (YouTube, TikTok, Instagram, Facebook, X): tall Instagram is never left beside
    // two short columns' empty halves, as CSS columns left it (721 px short).
    const heights = [1025, 1110, 1622, 1215, 1113];
    const at = shortestColumns(heights, 3);
    expect(at).toEqual([0, 1, 2, 0, 1]);
    const bottoms = [0, 1, 2].map((k) =>
      heights.filter((_, i) => at[i] === k).reduce((a, h) => a + h + 16, 0),
    );
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(700);
    expect(shortestColumns([500, 500], 1)).toEqual([0, 0]);
    // The grid places each card in its own column; a card that grows only pushes the cards under it (stories.css).
    const css = source("stories/styles/stories.css");
    expect(css).toMatch(
      /\.st-conns\[data-cols\] \{[^}]*grid-auto-flow: row dense;/,
    );
    expect(css).toMatch(
      /\.st-conns\[data-cols\] > \.st-conn \{[^}]*grid-column: var\(--st-col, auto\);[^}]*grid-row-end: span var\(--st-span, 1\);/,
    );
    expect(css).not.toMatch(/\.st-conns[^{]*\{[^}]*columns: 340px/);
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
    for (let i = 0; i < 6; i++)
      await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  it("after Finish with steps skipped, a small card lists what is left and opens the setup", async () => {
    for (const step of ["tiktok", "facebook", "x"] as const)
      await api.patchOnboarding("stories", { step, skipped: true });
    await api.patchOnboarding("stories", { finish: true });
    const o = await api.getOnboarding("stories");
    const left = o.steps.filter((s) => s.state !== "done" && s.step !== "done");
    expect(left.length).toBeGreaterThanOrEqual(3);
    await dashboard();
    const card = host.querySelector<HTMLElement>(".st-setupcard--left")!;
    expect(card).not.toBeNull();
    expect(card.querySelector("h2")?.textContent).toBe(
      `Finish setting up: ${left.length} left`,
    );
    expect(
      Array.from(card.querySelectorAll(".st-setupcard__list li")).map(
        (l) => l.textContent,
      ),
    ).toEqual(left.map((s) => s.label));
    expect(
      Array.from(card.querySelectorAll(".st-setupcard__list li")).map(
        (l) => l.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Connect TikTok",
        "Connect Facebook",
        "Connect X",
      ]),
    );
    expect(card.querySelector("a")?.getAttribute("href")).toBe(
      "/stories/setup",
    );
    // The big setup card is gone once finished.
    expect(host.textContent).not.toContain("Set up Lamo Stories:");
  });

  it("before Finish the usual setup card shows; finished with nothing left there is no card at all", async () => {
    await dashboard();
    expect(
      host.querySelector(".st-setupcard:not(.st-setupcard--left)"),
    ).not.toBeNull();
    expect(host.querySelector(".st-setupcard--left")).toBeNull();
    // Finished with every step done: nothing to finish.
    const real = api.getOnboarding.bind(api);
    vi.spyOn(api, "getOnboarding").mockImplementation(async (ws) => {
      const o = await real(ws);
      return {
        ...o,
        steps: o.steps.map((s) => ({ ...s, state: "done" as const })),
        done: 11,
        finishedAt: new Date().toISOString(),
      };
    });
    await dashboard();
    expect(host.querySelector(".st-setupcard")).toBeNull();
  });
});

describe("the Needs you bar on the page it points to (§45.36 E17)", () => {
  let host: HTMLElement;
  let root: Root;

  const STUCK =
    "Lamo Stories' TikTok (Lamo Stories) needs connecting again. Open Lamo Stories › Social accounts, then tap Try again.";
  async function render(
    here: string,
    item: { sentence: string; href: string; platform: "tiktok" | null },
  ) {
    const api = mockStoriesApi();
    const real = await api.dashboard("stories");
    setStoriesApi({
      ...api,
      dashboard: async () => ({
        ...real,
        needsYou: [
          { publishingJobId: null, storyId: null, title: "TikTok", ...item },
        ],
      }),
    });
    await act(async () =>
      root.render(
        <ToastProvider>
          <NeedsYouBar ws="stories" here={here} />
          {here === "/stories/connections" ? (
            <ConnectionsScreen
              ws="stories"
              page={{
                name: "connections",
                platform: null,
                result: null,
                ws: null,
              }}
            />
          ) : null}
        </ToastProvider>,
      ),
    );
    for (let i = 0; i < 6; i++)
      await act(async () => await new Promise((r) => setTimeout(r, 0)));
  }

  beforeEach(async () => {
    await loadConfig(
      async () =>
        new Response(
          JSON.stringify({
            region: "eu-north-1",
            userPoolId: "eu-north-1_x",
            userPoolClientId: "c",
            apiUrl: "https://api.test/",
          }),
        ),
    );
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    setMockLatency(0);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
    forgetDashboards();
  });

  it("says the Social accounts trip in words for this page", () => {
    expect(socialHere(STUCK)).toBe(
      "Lamo Stories' TikTok (Lamo Stories) needs connecting again. Fix it below, then tap Try again.",
    );
    expect(
      socialHere(
        "Lamo Stories' TikTok needs connecting again. Open Social accounts and tap Connect.",
      ),
    ).toBe("Lamo Stories' TikTok needs connecting again. Tap Connect below.");
    expect(
      socialHere(
        "Lamo Stories' X is not connected. Open Lamo Stories › Social accounts, connect it, then tap Try again.",
      ),
    ).toBe(
      "Lamo Stories' X is not connected. Connect it below, then tap Try again.",
    );
    expect(
      socialHere(
        "The TikTok app keys changed. Connect TikTok again in Lamo Stories › Social accounts, then tap Try again.",
      ),
    ).toBe(
      "The TikTok app keys changed. Connect TikTok again below, then tap Try again.",
    );
    expect(
      socialHere("“Bike lights” needs a check before you can approve it."),
    ).toBe("“Bike lights” needs a check before you can approve it.");
  });

  it("on another page: the server's sentence and Fix it, which opens Social accounts", async () => {
    await render("/stories/ideas", {
      sentence: STUCK,
      href: "/stories/connections",
      platform: "tiktok",
    });
    const bar = host.querySelector<HTMLElement>(".st-needs")!;
    expect(bar.textContent).toContain(
      "Open Lamo Stories › Social accounts, then tap Try again.",
    );
    expect(
      bar
        .querySelector<HTMLAnchorElement>("a.st-needs__go")
        ?.getAttribute("href"),
    ).toBe("/stories/connections");
  });

  it("on Social accounts: never sends him there again, and Show me brings the card into view", async () => {
    await render("/stories/connections", {
      sentence: STUCK,
      href: "/stories/connections",
      platform: "tiktok",
    });
    const bar = host.querySelector<HTMLElement>(".st-needs")!;
    expect(bar.textContent).toContain(
      "needs connecting again. Fix it below, then tap Try again.",
    );
    expect(bar.textContent).not.toContain("Social accounts");
    expect(bar.querySelector("a")).toBeNull();
    const tiktok = host.querySelector<HTMLElement>(
      '.st-conn[data-platform="tiktok"]',
    )!;
    const seen = vi.fn();
    tiktok.scrollIntoView = seen;
    const show = Array.from(
      bar.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "Show me")!;
    await act(async () => show.click());
    expect(seen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(tiktok);
  });

  it("on the page of a story that needs a check: no Fix it to the same page", async () => {
    await render("/stories/review/st-1", {
      sentence: "“Bike lights” needs a check before you can approve it.",
      href: "/stories/review/st-1",
      platform: null,
    });
    const bar = host.querySelector<HTMLElement>(".st-needs")!;
    expect(bar.textContent).toContain(
      "needs a check before you can approve it.",
    );
    expect(bar.querySelector("a, .st-needs__go")).toBeNull();
    expect(
      bar.querySelector('[aria-label="Hide this for now"]'),
    ).not.toBeNull();
  });

  it("StoriesApp tells the bar which page is on screen", () => {
    expect(source("stories/StoriesApp.tsx")).toContain(
      "<NeedsYouBar ws={ws} here={storiesHref(page)} />",
    );
  });
});
