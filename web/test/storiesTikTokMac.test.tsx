// Clips Funded › My Mac posts TikTok (docs/CONTRACTS.md §47.10, §47.10.6): the switch and the Mac's status
// in Social accounts › TikTok (every card state, and Log in on my Mac), Review › Post it's Mac mode (one read-only line,
// no Who can see it and no Commercial content, Upload never held for TikTok's choices, the full public options sent,
// the not-set-up line), every post row of §47.10.6, Review reading the posts every 10 seconds while the Mac has one, the
// Dashboard's Try again on a Mac post, and the mock's rules. MAC_WS_FROM is pinned to the API's own file. Rendered with
// the mock (no wait, fake timers); nothing leaves the machine.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { clockWords, MAC_BEATS_FROM } from "../src/lib/tiktokMac.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import * as macMock from "../src/stories/api/mock/mac.ts";
import { setMockLatency, type MockStore } from "../src/stories/api/mock/store.ts";
import type { PublishingJob, PubJobMac, StoriesApi, WsMacHelper, WsMacStatus } from "../src/stories/api/types.ts";
import { loginReason, MAC_LOGGED_OUT, MAC_NOBODY, MAC_TIKTOK_OPTIONS, MAC_WS_FROM, macChip, macPlace, macRow, versionAtLeast, type MacRowContext } from "../src/stories/studio/macRow.ts";
import * as W from "../src/stories/studio/macWords.ts";
import { forgetDashboards, forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => null) as never;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { ReviewScreen } = await import("../src/stories/screens/Review.tsx");
const { DashboardScreen } = await import("../src/stories/screens/Dashboard.tsx");
const { PublishSheet } = await import("../src/stories/studio/PublishSheet.tsx");
const { PostRow } = await import("../src/stories/studio/PostsPanel.tsx");
const { cardState, TikTokMac } = await import("../src/stories/studio/TikTokMac.tsx");

const ROOT = join(import.meta.dirname, "..", "..");
const NOW = Date.parse("2026-11-23T21:00:00.000Z");
const MIN = 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const S = { approved: "01JSTST0000000000000000003", published: "01JSTST0000000000000000004" };

type MockWindow = Window & { __cfStoriesMock?: { knobs?: Record<string, unknown>; store?: MockStore; mac?: macMock.MacKnobs } };

let api: StoriesApi;
let store: MockStore;
let mac: macMock.MacKnobs;
let host: HTMLElement | undefined;
let root: Root | undefined;

function start(knobs: Record<string, unknown> = {}) {
  const w = window as MockWindow;
  w.__cfStoriesMock = { knobs };
  api = mockStoriesApi();
  setStoriesApi(api);
  store = w.__cfStoriesMock.store!;
  mac = w.__cfStoriesMock.mac!;
}
/** The Mac posts TikTok, the account is connected and a set-up Mac checked in. */
const READY = { macOn: true, macConnected: true, macHelper: true };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetWorkspaceMemory();
  forgetDashboards();
  forgetOnboarding();
  forgetLoaded();
  setMockLatency(0);
  history.replaceState(null, "", "/stories");
});

afterEach(async () => {
  const r = root;
  root = undefined;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = undefined;
  setStoriesApi(null);
  setMockLatency(null);
  vi.useRealTimers();
});

/** Time goes by in small steps, each in its own act, so every answer's render and its effects land on the way. */
async function wait(ms = 50) {
  const parts = ms <= 50 ? 3 : 12;
  for (let i = 0; i < parts; i++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms / parts);
    });
}
/** A mock call, with its (no) wait let go. */
async function call<T>(p: Promise<T>): Promise<T> {
  await wait(20);
  return p;
}
async function fails(p: Promise<unknown>): Promise<string> {
  const caught = p.then(
    () => "no error",
    (e: Error) => e.message,
  );
  await wait(20);
  return caught;
}
async function show(node: ReactNode, ms = 200) {
  host = document.createElement("div");
  host.className = "stories-app";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ToastProvider>{node}</ToastProvider>));
  await wait(ms);
}
function control(name: string | RegExp, within: ParentNode = document): HTMLElement {
  const all = Array.from(within.querySelectorAll<HTMLElement>("button, a"));
  const hit = all.find((el) => {
    const t = (el.textContent ?? "").trim();
    return typeof name === "string" ? t === name : name.test(t);
  });
  if (!hit) throw new Error(`no control "${String(name)}" in: ${all.map((e) => e.textContent?.trim()).join(" | ")}`);
  return hit;
}
const has = (name: string | RegExp, within: ParentNode = document) => {
  try {
    control(name, within);
    return true;
  } catch {
    return false;
  }
};
async function click(el: HTMLElement, ms = 100) {
  await act(async () => el.click());
  await wait(ms);
}
function type(el: Element | null, value: string) {
  if (!(el instanceof HTMLInputElement)) throw new Error("not a text box");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const text = (el: ParentNode = document.body) => (el as Element).textContent ?? "";
const tiktokRow = () => Array.from(document.querySelectorAll<HTMLElement>(".st-s-post")).find((r) => r.querySelector("strong")?.textContent === "TikTok")!;

// ---------- Pins ----------

describe("the version gate and the Mac's fixed settings", () => {
  it("MAC_WS_FROM is the API's own (workspaces/mac.py), 1.2.0, after the beats' version", () => {
    const py = readFileSync(join(ROOT, "api", "src", "clipfactory_api", "workspaces", "mac.py"), "utf8");
    const pinned = /^MAC_WS_FROM = "(\d+\.\d+\.\d+)"$/m.exec(py)?.[1];
    expect(pinned).toBe("1.2.0");
    expect(MAC_WS_FROM).toBe(pinned);
    expect(macMock.MAC_WS_FROM).toBe(pinned);
    expect(versionAtLeast(MAC_WS_FROM, MAC_BEATS_FROM)).toBe(true);
    expect(versionAtLeast("1.1.0")).toBe(false);
    expect(versionAtLeast("1.2.0")).toBe(true);
    expect(versionAtLeast("1.10.0")).toBe(true);
    expect(versionAtLeast(undefined)).toBe(false);
    expect(versionAtLeast("soon")).toBe(false);
  });

  it("Post it sends TikTok's options in full and public: everyone, Comments, Duet and Stitch on, never branded", () => {
    expect(MAC_TIKTOK_OPTIONS).toEqual({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false });
  });

  it("a login reason is the helper's own: its logged-out words, or logged in to another account", () => {
    const js = readFileSync(join(ROOT, "mac", "tiktok-helper", "src", "tiktok.js"), "utf8");
    const ws = /export const WS_REASONS = Object\.freeze\(\{[\s\S]*?\n\s+login: "([^"]+)"/.exec(js)?.[1];
    expect(ws).toBe(MAC_LOGGED_OUT);
    expect(loginReason(MAC_LOGGED_OUT)).toBe(true);
    const nobody = /export const WS_REASONS = Object\.freeze\(\{[\s\S]*?\n\s+nobody: "([^"]+)"/.exec(js)?.[1];
    expect(nobody).toBe(MAC_NOBODY);
    expect(loginReason(MAC_NOBODY)).toBe(true);
    expect(loginReason("Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted.")).toBe(true);
    expect(loginReason("Your Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Try again.")).toBe(false);
    expect(loginReason(undefined)).toBe(false);
  });

  it("the defaults file has the switch, off", () => {
    const defaults = JSON.parse(readFileSync(join(ROOT, "stories", "config", "workspace-defaults.json"), "utf8")) as { tiktokMac?: unknown };
    expect(defaults.tiktokMac).toEqual({ on: false });
  });

  it("never says the old name backwards, and Clips Funded's Mac words never name Clip Factory", () => {
    const files = ["web/src/stories/studio/macWords.ts", "web/src/stories/studio/macRow.ts", "web/src/stories/studio/TikTokMac.tsx", "web/src/stories/api/mock/mac.ts", "web/test/storiesTikTokMac.test.tsx", "web/e2e/stories-tiktok-mac.spec.ts"];
    for (const f of files) expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(new RegExp(["Funded", "Clips"].join(" "), "i"));
    const words = (Object.values(W) as unknown[]).filter((v): v is string => typeof v === "string");
    expect(words.length).toBeGreaterThan(30);
    for (const w of words) expect(w, w).not.toMatch(/Clip Factory|Keychain|password|helper's/i);
  });
});

// ---------- The post rows (§47.10.6) ----------

function job(status: PublishingJob["publishingStatus"], extra: Partial<PublishingJob> = {}): PublishingJob {
  return {
    publishingJobId: "J1",
    workspaceId: "stories",
    contentId: S.approved,
    socialAccountId: "stories.tiktok",
    platform: "tiktok",
    publishingStatus: status,
    accountName: "Clips Funded",
    handle: "@clips.funded",
    externalAccountId: "-000open-id",
    createdAt: at(60 * MIN),
    updatedAt: at(MIN),
    ...extra,
  };
}
const macJob = (m: Partial<PubJobMac>, extra: Partial<PublishingJob> = {}) => job("mac", { mac: { state: "waiting", since: at(5 * MIN), ...m }, ...extra });
const helper = (h: Partial<WsMacHelper> = {}): WsMacHelper => ({ seenAt: at(MIN), state: "ok", version: "1.2.0", setUp: true, handle: "@clips.funded", ...h });
const status = (h: WsMacHelper | null, queue: WsMacStatus["queue"] = []): WsMacStatus => ({ on: true, helper: h, account: { handle: "@clips.funded", accountName: "Clips Funded", status: "connected" }, queue });
const ctx = (h: WsMacHelper | null = helper(), queue: WsMacStatus["queue"] = [], on = true): MacRowContext => ({ on, status: status(h, queue), now: NOW });
const q = (id: string, state: "waiting" | "working", m: Partial<WsMacStatus["queue"][number]> = {}): WsMacStatus["queue"][number] => ({
  workspaceId: "stories",
  publishingJobId: id,
  storyId: "S",
  hook: "A story",
  caption: "A story",
  fileName: "clips-funded-a-story.mp4",
  account: { handle: "@clips.funded", openId: "-000open-id" },
  aiLabel: true,
  privacy: "PUBLIC_TO_EVERYONE",
  comment: true,
  duet: true,
  stitch: true,
  source: "upload",
  since: at(20 * MIN),
  state,
  attempt: 0,
  ...m,
});

describe("each post row says what the Mac is doing (§47.10.6)", () => {
  it("1, 2: posted by the Mac, or saved as on TikTok by the owner", () => {
    expect(macRow(job("posted", { via: "mac", url: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" }), ctx())).toMatchObject({ chip: "Posted", line: "Posted by your Mac · Everyone", buttons: ["open"] });
    expect(macRow(job("posted", { by: "you" }), ctx())).toMatchObject({ chip: "Posted", line: "On your TikTok · no link", buttons: [] });
    expect(macRow(job("posted", { by: "you", url: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" }), ctx())).toMatchObject({ line: "On your TikTok", buttons: ["open"] });
  });

  it("3 to 8: a waiting post, from the switch to its place in the queue", () => {
    const w = macJob({});
    expect(macRow(w, ctx(helper(), [], false))).toMatchObject({ chip: "Waiting for your Mac", line: "My Mac posts TikTok is off", buttons: ["turn_on"] });
    expect(macRow(w, ctx(null))).toMatchObject({ line: "Your Mac isn't set up yet", buttons: ["set_up"] });
    expect(macRow(w, ctx(helper({ version: "1.1.0" })))).toMatchObject({ line: "Your Mac isn't set up yet", buttons: ["set_up"] });
    expect(macRow(w, ctx(helper({ setUp: false })))).toMatchObject({ line: "Your Mac isn't set up yet", buttons: ["set_up"] });
    const seen = at(31 * MIN);
    expect(macRow(w, ctx(helper({ seenAt: seen })))).toMatchObject({ line: `Your Mac hasn't checked in since ${clockWords(seen, NOW)}`, buttons: [] });
    expect(macRow(w, ctx(helper({ state: "needs_you", reason: "TikTok logged your Mac out.", needsYouJobId: "J0", needsYouStoryId: "S0" })))).toMatchObject({
      line: "Your Mac needs you · look at your Mac",
      buttons: ["open_stopped"],
      stoppedStoryId: "S0",
    });
    // Paused: Start my Mac again is right on the row; once asked, it says so until the Mac does it.
    expect(macRow(w, ctx(helper({ state: "paused", reason: "Paused." })))).toMatchObject({ line: "Paused on your Mac", buttons: ["resume"] });
    expect(macRow(w, ctx(helper({ state: "paused", resumeRequest: { at: at(0) } })))).toMatchObject({ line: "Paused on your Mac · starting again within a minute", buttons: [] });
    expect(macRow(w, ctx(helper(), [q("J1", "waiting")]))).toMatchObject({ line: "Waiting for your Mac · next" });
    const queue = [q("J0", "working", { claimedAt: at(MIN), beatAt: at(MIN) }), q("J2", "waiting", { since: at(30 * MIN) }), q("J1", "waiting"), q("J3", "waiting")];
    expect(macRow(w, ctx(helper(), queue))).toMatchObject({ line: "Waiting for your Mac · in line (2 before it)" });
    // A stuck one doesn't count; one not in the queue says no place.
    expect(macPlace([q("J0", "working", { claimedAt: at(20 * MIN), beatAt: at(6 * MIN) }), q("J1", "waiting")], "J1", NOW)).toBe(0);
    expect(macRow(w, ctx(helper(), []))).toMatchObject({ line: "Waiting for your Mac" });
    // Not read yet: nothing that may be wrong.
    expect(macRow(w, { on: true, status: null, now: NOW })).toMatchObject({ line: "Waiting for your Mac", buttons: [] });
  });

  it("9, 10: working, then stuck before Post", () => {
    expect(macRow(macJob({ state: "working", claimedAt: at(2 * MIN), beatAt: at(MIN), step: "uploading" }), ctx())).toMatchObject({ chip: "Posting…", line: "Posting…", spinner: true, buttons: [] });
    expect(macRow(macJob({ state: "working", claimedAt: at(8 * MIN), beatAt: at(6 * MIN) }), ctx())).toMatchObject({ chip: "Didn't work", line: "Your Mac stopped before it pressed Post", buttons: ["try_again"] });
  });

  it("11: pressed but not sure: It's on TikTok, and a Try again that asks once the find window is over", () => {
    const pressed = at(10 * MIN);
    const r = macRow(macJob({ state: "stopped", claimedAt: at(12 * MIN), pressedAt: pressed, reason: macMock.PRESSED }), ctx());
    expect(r).toMatchObject({ chip: "Not sure it posted", buttons: ["on_tiktok"] });
    expect(r?.line).toBe(`Not sure it posted · look on your TikTok · Try again from ${clockWords(Date.parse(pressed) + 30 * MIN, NOW)}`);
    expect(macRow(macJob({ state: "stopped", pressedAt: at(31 * MIN) }), ctx())).toMatchObject({ line: "Not sure it posted · look on your TikTok", buttons: ["on_tiktok", "again_ask"] });
    expect(macRow(macJob({ state: "working", claimedAt: at(40 * MIN), beatAt: at(6 * MIN), pressedAt: at(35 * MIN) }), ctx())).toMatchObject({ chip: "Not sure it posted", buttons: ["on_tiktok", "again_ask"] });
  });

  it("12: stopped: Didn't work and the reason's first sentence (an account problem also has Open Social accounts)", () => {
    // A login reason: Set it up (the TikTok card's Log in on my Mac) beside Try again.
    expect(macRow(macJob({ state: "stopped", reason: "TikTok logged your Mac out. Tap Log in on my Mac." }), ctx())).toMatchObject({ chip: "Didn't work", line: "Didn't work: TikTok logged your Mac out", buttons: ["set_up", "try_again"] });
    expect(macRow(macJob({ state: "stopped", reason: MAC_NOBODY }), ctx())).toMatchObject({ buttons: ["set_up", "try_again"] });
    expect(macRow(macJob({ state: "stopped", reason: "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted." }), ctx())).toMatchObject({ buttons: ["set_up", "try_again"] });
    expect(macRow(macJob({ state: "stopped", reason: "Your Mac couldn't turn on TikTok's AI label, so it didn't post. Tap Try again." }), ctx())).toMatchObject({ buttons: ["try_again"] });
    expect(macRow(macJob({ state: "stopped", reason: "Connect TikTok again in Social accounts. Then tap Try again." }), ctx())).toMatchObject({ buttons: ["social", "try_again"] });
  });

  it("13: an API post (Only me) offers Post with my Mac only while the switch is on", () => {
    const api = job("posted", { url: "https://www.tiktok.com/@clips.funded/video/7400000000000000001", onlyMe: true });
    expect(macRow(api, ctx())).toMatchObject({ line: "Only you can see it on TikTok", buttons: ["post_with_mac"] });
    // A public API post is on TikTok for everyone already: its usual row, never Post with my Mac.
    expect(macRow(job("posted", { url: "https://www.tiktok.com/@clips.funded/video/7400000000000000003" }), ctx())).toBeNull();
    expect(macRow(api, ctx(helper(), [], false))).toBeNull();
    expect(macRow(api, null)).toBeNull();
    expect(macRow({ ...api, platform: "youtube" }, ctx())).toBeNull();
    expect(macRow(job("queued", { platform: "youtube" }), ctx())).toBeNull();
  });

  it("the chip", () => {
    expect(macChip(job("posted"), NOW)).toBe("Posted");
    expect(macChip(macJob({}), NOW)).toBe("Waiting for your Mac");
    expect(macChip(macJob({ state: "working", claimedAt: at(MIN) }), NOW)).toBe("Posting…");
    expect(macChip(macJob({ state: "stopped", reason: "x" }), NOW)).toBe("Didn't work");
    expect(macChip(macJob({ state: "stopped", pressedAt: at(MIN) }), NOW)).toBe("Not sure it posted");
  });
});

describe("a Mac post row's buttons", () => {
  const props = (over: Partial<import("../src/stories/studio/PostsPanel.tsx").PostMacProps> = {}) => ({
    on: true,
    status: status(helper()),
    onRetry: vi.fn(),
    onPosted: vi.fn(async () => null as string | null),
    onPostWithMac: vi.fn(),
    ...over,
  });
  const row = async (j: PublishingJob, p: ReturnType<typeof props>) => {
    await show(
      <ul>
        <PostRow job={j} onRetry={() => undefined} mac={p} />
      </ul>,
      20,
    );
    return document.querySelector<HTMLElement>(".st-s-post")!;
  };

  it("Turn on and Set it up go to the TikTok card", async () => {
    const r = await row(macJob({}), props({ on: false }));
    expect(control("Turn on", r).getAttribute("href")).toBe("/stories/connections/tiktok#tiktok-mac");
  });

  it("Try again on a stopped post", async () => {
    const p = props();
    const j = macJob({ state: "stopped", reason: "TikTok's upload page looks different." });
    const r = await row(j, p);
    expect(text(r)).toContain("Didn't work: TikTok's upload page looks different");
    await click(control("Try again", r));
    expect(p.onRetry).toHaveBeenCalledWith(j, undefined);
  });

  it("a pressed post: Try again asks first, and sends notOnTikTok", async () => {
    const p = props();
    const j = macJob({ state: "stopped", pressedAt: at(40 * MIN) });
    const r = await row(j, p);
    expect(Array.from(r.querySelectorAll(".st-s-post__actions button")).map((b) => b.textContent)).toEqual(["It's on TikTok", "Try again"]);
    await click(control("Try again", r));
    expect(p.onRetry).not.toHaveBeenCalled();
    expect(text(r)).toContain("Post it again? Only if it's not on your TikTok.");
    await click(control("Yes, post it again", r));
    expect(p.onRetry).toHaveBeenCalledWith(j, true);
  });

  it("It's on TikTok: its link, checked, or none after its own question", async () => {
    const p = props();
    const j = macJob({ state: "stopped", pressedAt: at(5 * MIN) });
    const r = await row(j, p);
    await click(control("It's on TikTok", r));
    await click(control("Save", r));
    expect(text(r)).toContain("Paste the link first.");
    type(r.querySelector("input"), "https://example.com/x");
    await click(control("Save", r));
    expect(p.onPosted).not.toHaveBeenCalled();
    type(r.querySelector("input"), "https://www.tiktok.com/@clips.funded/video/7400000000000000001");
    await click(control("Save", r));
    expect(p.onPosted).toHaveBeenCalledWith(j, { link: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" });
    await click(control("It's on TikTok", r));
    await click(control("It's on TikTok, no link", r));
    expect(text(r)).toContain("Save it as on TikTok without its link?");
    await click(control("Yes, it's on TikTok", r));
    expect(p.onPosted).toHaveBeenLastCalledWith(j, { noLink: true });
  });

  it("the server's no is shown on the row", async () => {
    const p = props({ onPosted: vi.fn(async () => "That post is on another TikTok account.") });
    const r = await row(macJob({ state: "stopped", pressedAt: at(5 * MIN) }), p);
    await click(control("It's on TikTok", r));
    type(r.querySelector("input"), "https://www.tiktok.com/@lamo.clips/video/7400000000000000001");
    await click(control("Save", r));
    expect(text(r)).toContain("That post is on another TikTok account.");
  });

  it("posted by the Mac: Open, and no 'No numbers yet' line; an API post: Post with my Mac", async () => {
    const r = await row(job("posted", { via: "mac", url: "https://www.tiktok.com/@clips.funded/video/7400000000000000001" }), props());
    expect(control(/^Open/, r).getAttribute("href")).toContain("tiktok.com/@clips.funded/video/");
    expect(text(r)).not.toContain("No numbers yet");
    await act(async () => root!.unmount());
    root = undefined;
    host?.remove();
    const p = props();
    const api = job("posted", { url: "https://www.tiktok.com/@clips.funded/video/7400000000000000002", onlyMe: true });
    const r2 = await row(api, p);
    expect(text(r2)).toContain("Only you can see it on TikTok");
    await click(control("Post with my Mac", r2));
    expect(p.onPostWithMac).toHaveBeenCalledWith(api);
  });

  it("without the page's Mac context (an older screen) a Mac post still reads as waiting", async () => {
    await show(
      <ul>
        <PostRow job={macJob({})} onRetry={() => undefined} />
      </ul>,
      20,
    );
    expect(text()).toContain("Waiting for your Mac");
  });
});

// ---------- The TikTok card (§47.10.6) ----------

describe("the TikTok card's states (§47.10.6)", () => {
  const h = "@clips.funded";
  it("from not set up to logged in", () => {
    expect(cardState(null, h, NOW)).toMatchObject({ line: "Your Mac isn't set up yet.", steps: ["1. Ask for the helper update on your Mac.", "2. Tap Log in on my Mac.", "3. In the TikTok app, switch to @clips.funded, then scan the code."] });
    expect(cardState(helper({ version: "1.1.0" }), h, NOW)).toMatchObject({ line: "Your Mac isn't set up yet." });
    expect(cardState(helper({ version: "1.1.0" }), h, NOW).button).toBeUndefined();
    expect(cardState(helper({ setUp: false, handle: undefined }), h, NOW)).toMatchObject({
      line: "Your Mac isn't logged in to @clips.funded yet.",
      steps: ["2. Tap Log in on my Mac.", "3. In the TikTok app, switch to @clips.funded, then scan the code."],
      button: "login",
    });
    expect(cardState(helper({ setUp: false, loginRequest: { at: at(0) } }), h, NOW)).toMatchObject({ line: "Look at your Mac. A TikTok window opens within a minute." });
    expect(cardState(helper({ setUp: false, loginRequest: { at: at(0) } }), h, NOW).button).toBeUndefined();
    expect(cardState(helper(), h, NOW)).toMatchObject({ line: `Your Mac checked in ${clockWords(at(MIN), NOW)} · logged in as @clips.funded.`, button: "login_quiet" });
  });

  it("needs you, paused, and not seen for 30 minutes", () => {
    expect(cardState(helper({ state: "needs_you", reason: "TikTok logged your Mac out. Tap Log in on my Mac." }), h, NOW)).toMatchObject({ line: "Your Mac needs you: TikTok logged your Mac out. Tap Log in on my Mac.", button: "login" });
    expect(cardState(helper({ state: "needs_you", reason: "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted." }), h, NOW)).toMatchObject({ button: "login" });
    expect(cardState(helper({ state: "needs_you", reason: "TikTok says it's posting too much right now. The rest wait.", needsYouStoryId: "S0" }), h, NOW)).toMatchObject({ button: "open_stopped" });
    expect(cardState(helper({ state: "paused" }), h, NOW)).toMatchObject({ line: "Paused on your Mac · your posts wait until it's started again.", button: "resume" });
    expect(cardState(helper({ state: "paused", resumeRequest: { at: at(0) } }), h, NOW)).toMatchObject({ line: "Your Mac starts again within a minute." });
    expect(cardState(helper({ state: "paused", resumeRequest: { at: at(0) } }), h, NOW).button).toBeUndefined();
    expect(cardState(helper({ seenAt: at(31 * MIN) }), h, NOW)).toMatchObject({ line: `Your Mac hasn't checked in since ${clockWords(at(31 * MIN), NOW)}.` });
  });
});

describe("§47.11: the card while the Mac is held only for a TikTok login", () => {
  const h = "@clips.funded";
  const out = "TikTok logged your Mac out. Tap Log in on my Mac.";
  it("one quiet carry-on line under the needs-you line, only for a login code, never naming Clip Factory", () => {
    expect(W.loginBackWords(h)).toBe("Your Mac carries on by itself once it's logged in to @clips.funded.");
    const held = cardState(helper({ state: "needs_you", reason: out, needsYouJobId: "J", needsYouStoryId: "S0", needsYouCode: "login" }), h, NOW);
    expect(held).toMatchObject({ line: `Your Mac needs you: ${out}`, note: "Your Mac carries on by itself once it's logged in to @clips.funded.", button: "login" });
    expect(`${held.line} ${held.note}`).not.toMatch(/clip factory/i);
    const wrong = "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted.";
    expect(cardState(helper({ state: "needs_you", reason: wrong, needsYouCode: "login" }), h, NOW)).toMatchObject({ note: W.loginBackWords(h), button: "login" });
    for (const other of [
      helper({ state: "needs_you", reason: out }),
      helper({ state: "needs_you", reason: "TikTok says it's posting too much right now. The rest wait.", needsYouStoryId: "S0" }),
      helper({ state: "paused" }),
      helper(),
    ]) {
      expect(cardState(other, h, NOW).note).toBeUndefined();
    }
  });

  it("the mock: a login stop holds with its code; logged-in resumes the stopped post once, pressed posts only end the hold", async () => {
    start(READY);
    const tiktok = { platform: "tiktok" as const, socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } };
    const [j] = await call(api.publish("stories", S.approved, [tiktok]));
    const id = j!.publishingJobId;
    mac.claim();
    mac.stopped(out, true, id, "login");
    expect(mac.helper()).toMatchObject({ state: "needs_you", needsYouJobId: id, needsYouCode: "login" });
    expect(mac.loggedIn(id)).toMatchObject({ outcome: "resumed", helper: { state: "ok" } });
    expect(store.publishing.find((x) => x.publishingJobId === id)?.mac).toMatchObject({ state: "waiting" });
    expect(mac.helper()?.needsYouCode).toBeUndefined();
    expect(() => mac.loggedIn(id)).toThrow(macMock.NOT_LOGIN_HOLD);
    mac.claim();
    mac.stopped("TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again.", true, id);
    expect(() => mac.loggedIn(id)).toThrow(macMock.NOT_LOGIN_HOLD); // a puzzle never ends by itself
    await call(api.macRetry("stories", id)); // the owner's Try again ends that one
    expect(mac.helper()?.state).toBe("ok");
    mac.claim();
    mac.step("pressing");
    mac.stopped(out, true, id, "login");
    const pressed = structuredClone(store.publishing.find((x) => x.publishingJobId === id));
    expect(mac.loggedIn(id).outcome).toBe("pressed");
    expect(store.publishing.find((x) => x.publishingJobId === id)).toEqual(pressed);
    expect(mac.helper()?.state).toBe("ok");
  });

  it("shows the line on the card", async () => {
    start({ ...READY, macHelper: { state: "needs_you", reason: out, needsYouJobId: "J", needsYouStoryId: S.approved, needsYouCode: "login" } });
    const account = store.social.find((a) => a.platform === "tiktok")!;
    await show(<TikTokMac ws="stories" account={account} />);
    const c = document.querySelector<HTMLElement>("#tiktok-mac")!;
    expect(c.querySelector('[data-mac="login-back"]')?.textContent).toMatch(/^Your Mac carries on by itself once it's logged in to @/);
    expect(has("Log in on my Mac", c)).toBe(true);
  });
});

describe("the TikTok card in Social accounts", () => {
  const card = async () => {
    const account = store.social.find((a) => a.platform === "tiktok")!;
    await show(<TikTokMac ws="stories" account={account} />);
    return document.querySelector<HTMLElement>("#tiktok-mac")!;
  };

  it("off, then on: the switch is saved in the workspace and the card says what to do next", async () => {
    start({ macConnected: true });
    const c = await card();
    expect(text(c)).toContain("My Mac posts TikTok");
    expect(text(c)).toContain("Off. Your Mac doesn't post TikTok.");
    const sw = c.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(has("Log in on my Mac", c)).toBe(false);
    await click(sw, 300);
    expect(store.workspaces.find((w) => w.workspaceId === "stories")!.configuration).toMatchObject({ tiktokMac: { on: true } });
    expect(text(c)).toContain("On. Post it hands TikTok to your Mac. It posts for everyone, with the AI label.");
    expect(text(c)).toContain("Your Mac isn't set up yet.");
    expect(text(c)).toContain("1. Ask for the helper update on your Mac.");
    expect(text(c)).toContain("To stop it, turn the switch off. Your Mac stops at once.");
  });

  it("waits for a connected TikTok while off; once on it always shows, so it can be turned off", async () => {
    start({});
    const account = store.social.find((a) => a.platform === "tiktok")!;
    expect(account.connectionStatus).not.toBe("connected");
    await card();
    expect(document.querySelector("#tiktok-mac")).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    host?.remove();
    start({ macOn: true });
    const c = await card();
    expect(text(c)).toContain("On. Post it hands TikTok to your Mac.");
    expect(c.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("Log in on my Mac asks the Mac, and the card follows it until it is logged in", async () => {
    start({ ...READY, macHelper: { setUp: false, handle: undefined } });
    const c = await card();
    expect(text(c)).toContain("Your Mac isn't logged in to @funded.clips yet.");
    const macLogin = vi.spyOn(api, "macLogin");
    await click(control("Log in on my Mac", c));
    expect(macLogin).toHaveBeenCalledWith("stories");
    expect(text(c)).toContain("Look at your Mac. A TikTok window opens within a minute.");
    const asked = mac.helper()!.loginRequest!.at;
    mac.ping({ setUp: true, handle: "@funded.clips", loginDone: asked });
    await wait(10_500);
    expect(text(c)).toContain("logged in as @funded.clips.");
    expect(has("Log in on my Mac", c)).toBe(true);
  });

  it("paused: Start my Mac again asks the Mac, and the card follows it until it goes on", async () => {
    start({ ...READY, macHelper: { state: "paused", reason: "Paused on your Mac." } });
    const c = await card();
    expect(text(c)).toContain("Paused on your Mac · your posts wait until it's started again.");
    const macResume = vi.spyOn(api, "macResume");
    await click(control("Start my Mac again", c));
    expect(macResume).toHaveBeenCalledWith("stories");
    expect(text(c)).toContain("Your Mac starts again within a minute.");
    const asked = mac.helper()!.resumeRequest!.at;
    mac.ping({ state: "ok", resumeDone: asked });
    await wait(10_500);
    expect(text(c)).toContain("logged in as @funded.clips.");
    expect(mac.helper()!.resumeRequest).toBeUndefined();
    // Not paused (any more): the server says so.
    expect(await fails(api.macResume("stories"))).toBe("Your Mac isn't paused.");
  });

  it("needs you: Log in on my Mac for a login reason, else Open the stopped post", async () => {
    start({ ...READY, macHelper: { state: "needs_you", reason: "TikTok logged your Mac out. Tap Log in on my Mac." } });
    let c = await card();
    expect(text(c)).toContain("Your Mac needs you: TikTok logged your Mac out.");
    expect(has("Log in on my Mac", c)).toBe(true);
    await act(async () => root!.unmount());
    root = undefined;
    host?.remove();
    forgetLoaded();
    start({ ...READY, macHelper: { state: "needs_you", reason: "TikTok says it's posting too much right now. The rest wait.", needsYouJobId: "J9", needsYouStoryId: S.published } });
    c = await card();
    expect(control("Open the stopped post", c).getAttribute("href")).toBe(`/stories/review/${S.published}`);
  });

  it("an old helper can't be asked to log in: Update the helper first", async () => {
    start({ ...READY, macHelper: { version: "1.1.0" } });
    expect(await fails(api.macLogin("stories"))).toBe("Update the helper on your Mac first.");
  });
});

// ---------- Review › Post it in Mac mode (§47.10.6) ----------

/** The sheet as Review holds it: the jobs it sent join the page's list. */
function SheetPage({ config }: { config: { tiktokMac?: { on: boolean } } }) {
  const story = store.stories.find((s) => s.storyId === S.approved)!;
  const [jobs, setJobs] = useState(() => store.publishing.filter((j) => j.contentId === S.approved));
  return <PublishSheet ws="stories" story={story} config={config} jobs={jobs} onSent={(made) => setJobs((j) => [...made, ...j])} onRetry={() => undefined} onClose={() => undefined} />;
}

describe("Post it while the Mac posts TikTok", () => {
  const sheet = async (config: { tiktokMac?: { on: boolean } }) => {
    await show(<SheetPage config={config} />);
    await click(Array.from(document.querySelectorAll<HTMLElement>("button.st-s-place")).find((b) => b.textContent?.includes("TikTok"))!);
  };

  it("one read-only line, no Who can see it or Commercial content, Upload not held, the full public options sent", async () => {
    start(READY);
    // TikTok's choices never come: Upload doesn't wait for them.
    vi.spyOn(api, "tiktokCreatorInfo").mockImplementation(() => new Promise(() => undefined));
    const publish = vi.spyOn(api, "publish");
    await sheet({ tiktokMac: { on: true } });
    const tt = document.querySelector<HTMLElement>(".st-s-tiktok")!;
    expect(text(tt)).toContain("Your Mac posts it for everyone, with the AI label.");
    expect(text(tt)).toContain("Comments, Duet and Stitch on.");
    expect(text(tt)).not.toContain("Who can see it");
    expect(text(tt)).not.toContain("Commercial content");
    expect(text(tt)).not.toContain("Your Mac isn't set up yet");
    const upload = control(/^Upload/);
    expect(upload.getAttribute("aria-disabled")).toBeNull();
    await click(upload, 300);
    expect(publish).toHaveBeenCalledWith("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } }]);
    await wait(300);
    expect(text()).toContain("Waiting for your Mac");
  });

  it("not set up: one more line, with Set it up", async () => {
    start({ macOn: true, macConnected: true });
    await sheet({ tiktokMac: { on: true } });
    const tt = document.querySelector<HTMLElement>(".st-s-tiktok")!;
    expect(text(tt)).toContain("Your Mac isn't set up yet. It posts once it is.");
    expect(control("Set it up", tt).getAttribute("href")).toBe("/stories/connections/tiktok#tiktok-mac");
  });

  it("with the switch off, TikTok's part is as before", async () => {
    start({ macConnected: true });
    await sheet({});
    expect(text(document.querySelector(".st-s-tiktok")!)).toContain("Who can see it");
  });
});

// ---------- Review and the Dashboard ----------

describe("Review follows the Mac", () => {
  const post = async () => {
    const [j] = await call(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } }]));
    return j!;
  };

  it("reads the posts every 10 seconds while the Mac has one, and the Mac every minute", async () => {
    start(READY);
    // Only the Mac's post is on its way (the seed's other posts of this video are not).
    store.publishing = store.publishing.filter((x) => x.contentId !== S.approved);
    const j = await post();
    expect(j).toMatchObject({ publishingStatus: "mac", mac: { state: "waiting" }, handle: "@funded.clips" });
    const list = vi.spyOn(api, "listPublishing");
    const macStatus = vi.spyOn(api, "macStatus");
    await show(<ReviewScreen ws="stories" page={{ name: "review_story", storyId: S.approved }} />, 500);
    expect(text(tiktokRow())).toContain("Waiting for your Mac · next");
    const lists = list.mock.calls.length;
    const reads = macStatus.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    mac.claim();
    await wait(10_100);
    expect(list.mock.calls.length).toBeGreaterThan(lists);
    expect(text(tiktokRow())).toContain("Posting…");
    await wait(60_000);
    expect(macStatus.mock.calls.length).toBeGreaterThan(reads);
    mac.step("pressing");
    mac.done();
    await wait(10_100);
    expect(text(tiktokRow())).toContain("Posted by your Mac · Everyone");
    // Posted: nothing to follow any more.
    const settled = list.mock.calls.length;
    await wait(30_000);
    expect(list.mock.calls.length).toBe(settled);
  });

  it("Try again on a stopped Mac post waits for the Mac again", async () => {
    start(READY);
    const j = await post();
    mac.claim();
    mac.stopped("TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again.");
    const retry = vi.spyOn(api, "macRetry");
    const old = vi.spyOn(api, "retryPublishing");
    await show(<ReviewScreen ws="stories" page={{ name: "review_story", storyId: S.approved }} />, 500);
    await click(control("Try again", tiktokRow()), 300);
    expect(retry).toHaveBeenCalledWith("stories", j.publishingJobId, {});
    expect(old).not.toHaveBeenCalled();
    expect(text(tiktokRow())).toContain("Waiting for your Mac");
  });
});

describe("the Dashboard's Needs you", () => {
  const stopped = async (pressed: boolean) => {
    start(READY);
    await call(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } }]));
    mac.claim();
    if (pressed) mac.step("pressing");
    mac.stopped("TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again.");
    await show(<DashboardScreen ws="stories" page={{ name: "dashboard" }} />, 500);
    return Array.from(document.querySelectorAll<HTMLElement>(".st-needs-list__item")).find((li) => li.textContent?.includes("TikTok") && li.textContent.includes("Your Mac"))!;
  };

  it("Try again on a stopped Mac post asks the Mac again, never the API's retry", async () => {
    const item = await stopped(false);
    const retry = vi.spyOn(api, "macRetry");
    const old = vi.spyOn(api, "retryPublishing");
    await click(control(/Try again/, item), 300);
    expect(retry).toHaveBeenCalledWith("stories", expect.any(String));
    expect(old).not.toHaveBeenCalled();
  });

  it("a post the Mac pressed has only Open (its Review page)", async () => {
    const item = await stopped(true);
    expect(has(/Try again/, item)).toBe(false);
    expect(control("Open", item).getAttribute("href")).toBe(`/stories/review/${S.approved}`);
  });

  it("a TikTok he skipped (and is not connected) has no Needs you line, its Mac's stopped post too (rule S, §48.3)", async () => {
    start(READY);
    await call(api.publish("stories", S.approved, [{ platform: "tiktok", socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } }]));
    mac.claim();
    mac.stopped("TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again.");
    const mine = (d: Awaited<ReturnType<StoriesApi["dashboard"]>>) => d.needsYou.filter((n) => n.publishingStatus === "mac");
    expect(mine(await call(api.dashboard("stories")))).toHaveLength(1);
    store.social = store.social.map((a) => (a.platform === "tiktok" ? { ...a, connectionStatus: "not_connected" as const } : a));
    store.onboarding.skipped = [...store.onboarding.skipped, "tiktok"];
    const d = await call(api.dashboard("stories"));
    expect(d.accounts.map((a) => a.platform)).not.toContain("tiktok");
    expect(mine(d)).toHaveLength(0);
    expect(d.needsYou.filter((n) => n.platform === "tiktok")).toHaveLength(0);
  });
});

// ---------- The mock follows the API (§2) ----------

describe("the mock's Mac rules", () => {
  const tiktok = { platform: "tiktok" as const, socialAccountId: "stories.tiktok", options: { ...MAC_TIKTOK_OPTIONS } };

  it("Post it writes a Mac job; mixed targets send the others as before; a second tap clashes", async () => {
    start(READY);
    const made = await call(api.publish("stories", S.approved, [tiktok, { platform: "youtube", socialAccountId: "stories.youtube" }]));
    expect(made.find((j) => j.platform === "tiktok")).toMatchObject({ publishingStatus: "mac", mac: { state: "waiting" } });
    expect(made.find((j) => j.platform === "youtube")?.publishingStatus).toBe("queued");
    expect(await fails(api.publish("stories", S.approved, [tiktok]))).toBe(macMock.CLASH);
    const id = made.find((j) => j.platform === "tiktok")!.publishingJobId;
    expect(await fails(api.retryPublishing("stories", id))).toBe(macMock.MAC_ONE);
    // The publishing part's own walk never touches it.
    await wait(10_000);
    expect(store.publishing.find((j) => j.publishingJobId === id)?.publishingStatus).toBe("mac");
    const s = await call(api.macStatus("stories"));
    expect(s.queue.map((x) => x.publishingJobId)).toEqual([id]);
    expect(s.queue[0]).toMatchObject({ aiLabel: true, privacy: "PUBLIC_TO_EVERYONE", source: "upload", account: { handle: "@funded.clips" } });
  });

  it("an API post made Only me is handed over in place: one TikTok row", async () => {
    start(READY);
    const story = store.stories.find((s) => s.storyId === S.approved)!;
    store.publishing.push({ ...job("posted", { url: "https://www.tiktok.com/@funded.clips/video/7400000000000000009", onlyMe: true }), publishingJobId: "ONLYME", contentId: story.storyId, handle: "@funded.clips" });
    const [j] = await call(api.publish("stories", S.approved, [tiktok]));
    expect(j).toMatchObject({ publishingJobId: "ONLYME", publishingStatus: "mac" });
    expect(store.publishing.filter((x) => x.contentId === S.approved && x.platform === "tiktok")).toHaveLength(1);
  });

  it("done needs a link on the job's own account; It's on TikTok and Try again follow the API's rules", async () => {
    start(READY);
    const [j] = await call(api.publish("stories", S.approved, [tiktok]));
    const id = j!.publishingJobId;
    mac.claim();
    expect(() => mac.done(id, "https://www.tiktok.com/@lamo.clips/video/7400000000000000001")).toThrow(macMock.WRONG_ACCOUNT);
    expect(store.publishing.find((x) => x.publishingJobId === id)?.mac?.state).toBe("working");
    expect(await fails(api.macRetry("stories", id))).toBe(macMock.WORKING);
    expect(await fails(api.macPosted("stories", id, { noLink: true }))).toBe(macMock.WORKING);
    mac.step("pressing");
    mac.stopped("Something else.");
    expect(store.publishing.find((x) => x.publishingJobId === id)?.mac?.reason).toBe(macMock.PRESSED);
    expect(await fails(api.macRetry("stories", id))).toBe(macMock.MAY_HAVE_POSTED);
    expect(await fails(api.macRetry("stories", id, { notOnTikTok: true }))).toBe(macMock.STILL_LOOKING);
    mac.age(31 * MIN, id);
    const again = await call(api.macRetry("stories", id, { notOnTikTok: true }));
    expect(again.mac).toMatchObject({ state: "waiting" });
    expect(again.mac?.pressedBefore).toBeTruthy();
    const posted = await call(api.macPosted("stories", id, { link: "https://www.tiktok.com/@funded.clips/video/7400000000000000003" }));
    expect(posted).toMatchObject({ publishingStatus: "posted", by: "you", url: "https://www.tiktok.com/@funded.clips/video/7400000000000000003" });
    expect(posted.mac).toBeUndefined();
  });

  it("stopped with needs-you marks this workspace's Mac, and Try again clears it", async () => {
    start(READY);
    const [j] = await call(api.publish("stories", S.approved, [tiktok]));
    mac.claim();
    mac.stopped("TikTok logged your Mac out. Tap Log in on my Mac.", true);
    expect(mac.helper()).toMatchObject({ state: "needs_you", needsYouJobId: j!.publishingJobId, needsYouStoryId: S.approved });
    await call(api.macRetry("stories", j!.publishingJobId));
    expect(mac.helper()?.needsYouJobId).toBeUndefined();
  });

  it("the queue is empty while the switch is off", async () => {
    start(READY);
    await call(api.publish("stories", S.approved, [tiktok]));
    const w = store.workspaces.find((x) => x.workspaceId === "stories")!;
    (w.configuration as { tiktokMac?: { on: boolean } }).tiktokMac = { on: false };
    expect((await call(api.macStatus("stories"))).queue).toEqual([]);
  });

  it("no @handle on the account: Post it says to connect TikTok again, and writes nothing", async () => {
    start(READY);
    store.social.find((a) => a.platform === "tiktok")!.handle = null;
    const before = store.publishing.length;
    expect(await fails(api.publish("stories", S.approved, [tiktok]))).toBe(macMock.NO_HANDLE);
    expect(store.publishing.length).toBe(before);
  });
});
