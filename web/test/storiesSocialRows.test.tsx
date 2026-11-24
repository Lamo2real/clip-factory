// Clips Funded › Social accounts, organized like Clip Factory's Set up posting (the owner, 24 Nov: "can you make the
// social account page to look organized like this"), and a skipped platform shown only here (the owner, 24 Nov: "if i
// skip on a platform setup then i dont want to see it anywhere except in settings or social accounts tab"):
// - each platform's row says one status word and one short line (rowOf), the first rule that matches winning;
// - the progress card counts only the places not skipped ("1 of 4 ready"), with "All skipped" when none is left;
// - the list shows the five rows in order, each opening its own page (/stories/connections/<p>);
// - Skip asks first, right in the row (Keep it is the first answer and has focus, Escape means Keep it, and only Skip
//   saves, with the setup's own PATCH {step, skipped: true}); Un-skip is one tap (skipped: false);
// - a skipped platform's own page says so, with Un-skip.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { loadConfig } from "../src/lib/config.ts";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { Platform, SocialAccount, StoriesApi } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moves: string[] = [];
vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: (to: string) => void moves.push(to) };
});

const { appReady, ConnectionsScreen } = await import("../src/stories/screens/Connections.tsx");
const { rowOf, ROW_ORDER, SETUP_TIME, socialProgress } = await import("../src/stories/screens/SocialRows.tsx");
const { ConnectionScreen } = await import("../src/stories/screens/SocialPlatform.tsx");

/** An account as the API sends it, with what a case changes. */
function account(over: Partial<SocialAccount> = {}): SocialAccount {
  const platform = over.platform ?? "youtube";
  return {
    socialAccountId: `stories.${platform}`,
    workspaceId: "stories",
    platform,
    app: { choice: "clips", saved: true },
    lastCheckedAt: null,
    connectionStatus: "not_connected",
    externalAccountId: null,
    accountName: null,
    handle: null,
    avatarUrl: null,
    connectedAt: null,
    missing: [],
    reason: null,
    reconnectBy: null,
    choices: null,
    limits: [],
    warning: null,
    skipped: false,
    ...over,
  };
}
const five = (over: Partial<Record<Platform, Partial<SocialAccount>>> = {}): SocialAccount[] => ROW_ORDER.map((p) => account({ platform: p, ...over[p] }));

describe("a platform's row: one status word and one short line (rowOf)", () => {
  it("Skipped wins over every other state, and says it posts nowhere", () => {
    for (const status of ["not_connected", "needs_reconnect", "choose_account", "same_as_clips"] as const) {
      expect(rowOf(account({ connectionStatus: status, skipped: true })), status).toEqual({ platform: "youtube", state: "skipped", chip: "Skipped", tone: null, line: "You won't post here." });
    }
  });

  it("Ready (mint) says the account: its name and handle, the name alone, or Connected; and when it ends soon", () => {
    expect(rowOf(account({ connectionStatus: "connected", accountName: "Clips Funded", handle: "@fundedclips" }))).toEqual({ platform: "youtube", state: "ready", chip: "Ready", tone: "mint", line: "Clips Funded · @fundedclips" });
    // The handle only when it says more; the name alone with no handle.
    expect(rowOf(account({ connectionStatus: "connected", accountName: "Clips Funded", handle: "Clips Funded" })).line).toBe("Clips Funded");
    expect(rowOf(account({ connectionStatus: "connected", accountName: "Clips Funded", handle: null })).line).toBe("Clips Funded");
    expect(rowOf(account({ connectionStatus: "connected", accountName: null, handle: "@funded.clips" })).line).toBe("@funded.clips");
    expect(rowOf(account({ connectionStatus: "connected" })).line).toBe("Connected");
    expect(rowOf(account({ connectionStatus: "connected", accountName: "Clips Funded", reason: "expires_soon" }))).toMatchObject({ state: "ready", chip: "Ready", tone: "mint", line: "Connect again soon." });
  });

  it("Needs you: connect again (coral), Clip Factory's account (coral), pick where to post (sun)", () => {
    expect(rowOf(account({ connectionStatus: "needs_reconnect", reason: "keys_changed" }))).toMatchObject({ state: "needs_you", chip: "Needs you", tone: "coral", line: "Connect again." });
    expect(rowOf(account({ connectionStatus: "same_as_clips" }))).toMatchObject({ state: "needs_you", chip: "Needs you", tone: "coral", line: "That's Clip Factory's account." });
    expect(rowOf(account({ connectionStatus: "choose_account" }))).toMatchObject({ state: "needs_you", chip: "Needs you", tone: "sun", line: "Pick where to post." });
  });

  it("In progress (sky) once the developer app is ready; Not started (sky) with how long it takes before that", () => {
    expect(rowOf(account({ app: { choice: "clips", saved: true } }))).toMatchObject({ state: "in_progress", chip: "In progress", tone: "sky", line: "Next: connect it." });
    expect(rowOf(account({ app: { choice: "own", saved: true } }))).toMatchObject({ state: "in_progress", line: "Next: connect it." });
    expect(rowOf(account({ app: { choice: "clips", saved: true }, reason: "expired" }))).toMatchObject({ state: "in_progress", line: "Connect again." });
    // Its own app without its keys yet, or no app picked: not started, with the minutes and the cost.
    expect(rowOf(account({ app: { choice: "own", saved: false } }))).toMatchObject({ state: "not_started", chip: "Not started", tone: "sky", line: "About 20 minutes · Free" });
    for (const p of ROW_ORDER) expect(rowOf(account({ platform: p, app: { choice: null, saved: false } })).line, p).toBe(SETUP_TIME[p]);
    expect(SETUP_TIME).toEqual({
      youtube: "About 20 minutes · Free",
      tiktok: "About 40 minutes · Free",
      instagram: "About 25 minutes · Free",
      facebook: "About 25 minutes · Free",
      x: "About 15 minutes · Costs a little",
    });
    // The same test the platform's card uses for its Set up the app.
    expect(appReady({ app: { choice: "clips", saved: true } })).toBe(true);
    expect(appReady({ app: { choice: "own", saved: true } })).toBe(true);
    expect(appReady({ app: { choice: "own", saved: false } })).toBe(false);
    expect(appReady({ app: { choice: null, saved: false } })).toBe(false);
  });
});

describe("the progress card counts only the places not skipped (socialProgress)", () => {
  it("N of M ready, M leaving the skipped out; every place ready; the first that needs you; tap one", () => {
    const ready = { connectionStatus: "connected" as const, accountName: "Clips Funded" };
    // The owner's case: four connected, X skipped.
    expect(socialProgress(five({ youtube: ready, tiktok: ready, instagram: ready, facebook: ready, x: { skipped: true } }))).toEqual({ ready: 4, total: 4, title: "4 of 4 ready", line: "Every place is ready." });
    expect(socialProgress(five({ youtube: ready, tiktok: ready, instagram: ready, facebook: ready }))).toEqual({ ready: 4, total: 5, title: "4 of 5 ready", line: "Tap one to set it up." });
    // The first row that needs the owner, in the rows' order.
    expect(socialProgress(five({ youtube: ready, instagram: { connectionStatus: "choose_account" }, x: { connectionStatus: "same_as_clips" } }))).toEqual({ ready: 1, total: 5, title: "1 of 5 ready", line: "Instagram needs you." });
    // A skipped one that needs the owner is not named, nor counted.
    expect(socialProgress(five({ youtube: ready, tiktok: { connectionStatus: "needs_reconnect", skipped: true } }))).toEqual({ ready: 1, total: 4, title: "1 of 4 ready", line: "Tap one to set it up." });
  });

  it("with all five skipped there is no count: All skipped, and the way back", () => {
    const all = five(Object.fromEntries(ROW_ORDER.map((p) => [p, { skipped: true }])));
    expect(socialProgress(all)).toEqual({ ready: 0, total: 0, title: "All skipped", line: "Tap one to bring it back." });
  });
});

let host: HTMLElement;
let root: Root;
let store: MockStore;
let calls: { key: string; args: unknown[] }[];

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
async function render(node: ReactNode, change?: (store: MockStore) => void) {
  const real = mockStoriesApi();
  store = (window as unknown as { __cfStoriesMock: { store: MockStore } }).__cfStoriesMock.store;
  change?.(store);
  calls = [];
  setStoriesApi(
    new Proxy(real as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>, {
      get(target, key: string) {
        return (...args: unknown[]) => {
          calls.push({ key, args });
          return target[key]!(...args);
        };
      },
    }) as unknown as StoriesApi,
  );
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await settle();
}
const list = () => render(<ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />);
const rows = () => Array.from(host.querySelectorAll<HTMLElement>(".st-social-rows > li"));
const row = (p: Platform) => host.querySelector<HTMLElement>(`.st-social-row-wrap[data-platform="${p}"]`)!;
const byLabel = (el: ParentNode, label: string) => el.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (el: ParentNode, text: string) => Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text);
const click = async (b: HTMLElement | null | undefined) => {
  expect(b).toBeTruthy();
  await act(async () => b!.click());
  await settle(5);
};
const patches = () => calls.filter((c) => c.key === "patchOnboarding").map((c) => c.args);
const toasts = () => Array.from(document.querySelectorAll(".toast__text")).map((t) => t.textContent?.trim());

beforeEach(async () => {
  moves.length = 0;
  await loadConfig(async () => new Response(JSON.stringify({ region: "eu-north-1", userPoolId: "eu-north-1_x", userPoolClientId: "c", apiUrl: "https://api.test/" })));
  localStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  forgetLoaded();
  setMockLatency(0);
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: {} };
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
});

describe("the Social accounts page: a header, the progress card and five rows", () => {
  it("shows the header card, the count and the five rows in order, each with its state and its own page", async () => {
    await list();
    const head = host.querySelector<HTMLElement>("header.st-social-head")!;
    expect(head.classList.contains("st-glass")).toBe(true);
    expect(head.querySelector("h1")?.textContent).toBe("Social accounts");
    expect(head.textContent).toContain("Clips Funded's own accounts. Clip Factory's stay as they are.");
    // The seed: YouTube connected, TikTok to connect again, Instagram to pick, Facebook's app ready, X Clip Factory's own.
    expect(rows().map((r) => r.dataset.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(rows().map((r) => r.dataset.state)).toEqual(["ready", "needs_you", "needs_you", "in_progress", "needs_you"]);
    expect(rows().map((r) => r.querySelector("a.st-social-row")?.getAttribute("href"))).toEqual(ROW_ORDER.map((p) => `/stories/connections/${p}`));
    expect(rows().map((r) => r.querySelector(".st-chip")?.textContent)).toEqual(["Ready", "Needs you", "Needs you", "In progress", "Needs you"]);
    expect(rows().map((r) => r.querySelector(".st-social-row__line")?.textContent)).toEqual(["Clips Funded · @fundedclips", "Connect again.", "Pick where to post.", "Next: connect it.", "That's Clip Factory's account."]);
    // A check on the one that is ready, an empty circle on the others; the way in on every row.
    expect(rows().map((r) => (r.querySelector(".st-social-row__done") ? "done" : r.querySelector(".st-social-row__todo") ? "todo" : "none"))).toEqual(["done", "todo", "todo", "todo", "todo"]);
    for (const r of rows()) expect(r.querySelector(".st-social-row__go"), r.dataset.platform).not.toBeNull();
    // Skip on every row not ready; none on the ready one.
    expect(rows().map((r) => r.querySelector("[data-skip]")?.getAttribute("data-skip") ?? null)).toEqual([null, "tiktok", "instagram", "facebook", "x"]);
    const progress = host.querySelector<HTMLElement>(".st-social-progress")!;
    expect(progress.querySelector("h2")?.textContent).toBe("1 of 5 ready");
    expect(progress.querySelector("[role=progressbar]")?.getAttribute("aria-valuetext")).toBe("1 of 5 ready");
    expect(progress.textContent).toContain("TikTok needs you.");
    // The rows are the way on: no orange main button on the list, no card of a platform here.
    expect(host.querySelectorAll(".st-btn--main")).toHaveLength(0);
    expect(host.querySelector(".st-conn")).toBeNull();
    expect(host.querySelector(".st-social-rows")?.getAttribute("aria-label")).toBe("Your five places");
  });

  it("Skip asks first: Keep it is first, has focus and saves nothing; Escape is Keep it; Skip saves and the row says Skipped", async () => {
    await list();
    await click(byLabel(row("facebook"), "Skip Facebook"));
    const ask = () => row("facebook").querySelector<HTMLElement>('.st-sure[role="group"][aria-label="Skip Facebook?"]');
    expect(ask()).not.toBeNull();
    expect(ask()!.textContent).toContain("Skip Facebook? You won't post there until you set it up. You can come back here any time.");
    const answers = Array.from(ask()!.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(answers).toEqual(["Keep it", "Skip Facebook"]);
    expect(byText(ask()!, "Keep it")!.classList.contains("st-btn--main")).toBe(true);
    expect(byText(ask()!, "Skip Facebook")!.classList.contains("st-btn--main")).toBe(false);
    expect(document.activeElement).toBe(byText(ask()!, "Keep it"));
    // Keep it: nothing saved, and focus is back on the row's Skip.
    await click(byText(ask()!, "Keep it"));
    expect(ask()).toBeNull();
    expect(patches()).toEqual([]);
    expect(document.activeElement).toBe(byLabel(row("facebook"), "Skip Facebook"));
    // Escape means Keep it.
    await click(byLabel(row("facebook"), "Skip Facebook"));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle(2);
    expect(ask()).toBeNull();
    expect(patches()).toEqual([]);
    expect(row("facebook").dataset.state).toBe("in_progress");
    // Skip: the setup's own PATCH, and the row is Skipped with its way back.
    await click(byLabel(row("facebook"), "Skip Facebook"));
    await click(byText(ask()!, "Skip Facebook"));
    expect(patches()).toEqual([["stories", { step: "facebook", skipped: true }]]);
    expect(row("facebook").dataset.state).toBe("skipped");
    expect(row("facebook").querySelector(".st-chip")?.textContent).toBe("Skipped");
    expect(row("facebook").querySelector(".st-social-row__line")?.textContent).toBe("You won't post here.");
    // Said once: the row's line says it, and under the hairline there is only the way back.
    expect(row("facebook").textContent?.match(/post/g)).toHaveLength(1);
    const back = row("facebook").querySelector<HTMLElement>('[data-skipped="facebook"]')!;
    expect(back.textContent?.trim()).toBe("Un-skip");
    expect(byLabel(back, "Un-skip Facebook")?.textContent?.trim()).toBe("Un-skip");
    // Focus stays on the row: on its way back.
    expect(document.activeElement).toBe(byLabel(back, "Un-skip Facebook"));
    expect(row("facebook").querySelector("[data-skip]")).toBeNull();
    // Not counted any more.
    expect(host.querySelector(".st-social-progress h2")?.textContent).toBe("1 of 4 ready");
    expect(toasts()).toContain("Skipped. You can un-skip it here.");
    // Nothing is ever disabled, and no confetti for a skip.
    expect(host.querySelectorAll("button[disabled]")).toHaveLength(0);
    const source = readFileSync(join(import.meta.dirname, "..", "src", "stories", "screens", "SocialRows.tsx"), "utf8");
    expect(source).not.toMatch(/celebrate|starBurst/);
  });

  it("Un-skip is one tap: the setup's PATCH with skipped false, and the row is back and counted", async () => {
    await render(<ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />, (s) => {
      s.onboarding.skipped = [...s.onboarding.skipped, "x"];
    });
    expect(row("x").dataset.state).toBe("skipped");
    expect(host.querySelector(".st-social-progress h2")?.textContent).toBe("1 of 4 ready");
    await click(byLabel(row("x"), "Un-skip X"));
    expect(patches()).toEqual([["stories", { step: "x", skipped: false }]]);
    expect(row("x").dataset.state).toBe("needs_you");
    expect(row("x").querySelector('[data-skip="x"]')).not.toBeNull();
    expect(host.querySelector(".st-social-progress h2")?.textContent).toBe("1 of 5 ready");
    expect(toasts()).toContain("X is back.");
  });

  it("all five skipped: All skipped, no ring, and the way back on every row", async () => {
    await render(<ConnectionsScreen ws="stories" page={{ name: "connections", platform: null, result: null, ws: null }} />, (s) => {
      for (const a of s.social) Object.assign(a, { connectionStatus: "not_connected", reason: null, warning: null, choices: null });
      s.onboarding.skipped = [...ROW_ORDER];
    });
    const progress = host.querySelector<HTMLElement>(".st-social-progress")!;
    expect(progress.querySelector("h2")?.textContent).toBe("All skipped");
    expect(progress.querySelector("[role=progressbar]")).toBeNull();
    expect(progress.textContent).toContain("Tap one to bring it back.");
    expect(rows().map((r) => r.dataset.state)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"]);
    for (const p of ROW_ORDER) expect(row(p).querySelector(`[data-skipped="${p}"] button`)?.textContent?.trim(), p).toBe("Un-skip");
  });

  it("a Social accounts page that still names a platform goes to that platform's own page, with its result", async () => {
    await render(<ConnectionsScreen ws="stories" page={{ name: "connections", platform: "tiktok", result: "connected", ws: "stories" }} />);
    expect(moves).toEqual(["/stories/connections/tiktok?result=connected&ws=stories"]);
  });
});

describe("a platform's own page", () => {
  it("has the breadcrumb, its card with the name as the page's heading, and no skipped note while it is not skipped", async () => {
    await render(<ConnectionScreen ws="stories" page={{ name: "connection", platform: "youtube", result: null, ws: null }} />);
    const crumbs = host.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]')!;
    expect(crumbs.textContent).toBe("Social accounts › YouTube");
    expect(crumbs.querySelector("a")?.getAttribute("href")).toBe("/stories/connections");
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("YouTube");
    const page = host.querySelector<HTMLElement>("section.st-social-one")!;
    expect(page.dataset.platform).toBe("youtube");
    expect(host.querySelectorAll(".st-conn")).toHaveLength(1);
    expect(host.querySelector('.st-conn[data-platform="youtube"] h1.st-conn__name')?.textContent).toBe("YouTube");
    expect(host.querySelector(".st-social-one__skipped")).toBeNull();
  });

  it("a skipped platform's page says so, with Un-skip; the card is all there below it", async () => {
    await render(<ConnectionScreen ws="stories" page={{ name: "connection", platform: "facebook", result: null, ws: null }} />, (s) => {
      s.onboarding.skipped = [...s.onboarding.skipped, "facebook"];
    });
    const note = host.querySelector<HTMLElement>(".st-social-one__skipped")!;
    // Not a live region: its Un-skip button never sits inside one.
    expect(note.getAttribute("role")).toBeNull();
    expect(note.querySelector('[role="status"], [aria-live]')).toBeNull();
    expect(note.textContent).toContain("You skipped Facebook. You won't post there until you set it up.");
    // Its card is all there: Connect, and the More fold.
    const card = host.querySelector<HTMLElement>('.st-conn[data-platform="facebook"]')!;
    expect(byText(card, "Connect Facebook")).toBeTruthy();
    expect(card.querySelector("details.st-conn__more")).not.toBeNull();
    const unskip = byLabel(note, "Un-skip Facebook")!;
    unskip.focus();
    await click(unskip);
    expect(patches()).toEqual([["stories", { step: "facebook", skipped: false }]]);
    expect(host.querySelector(".st-social-one__skipped")).toBeNull();
    expect(toasts()).toContain("Facebook is back.");
    // The button went with its note: the keyboard's place is the card's name, not the page behind it.
    expect(document.activeElement).toBe(host.querySelector('.st-conn[data-platform="facebook"] h1.st-conn__name'));
  });
});
