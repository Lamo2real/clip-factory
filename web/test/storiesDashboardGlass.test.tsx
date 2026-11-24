// The Dashboard on the liquid-glass contract (web/src/stories/styles/GLASS-CONTRACT.md): the counts are big light
// numerals with a small unit (StatNumeral), one solid cream card sits among the glass tiles (the next video, with an
// orange toggle that saves its music in the workspace's settings), the setup's progress is an arc with a knob
// (ArcDial, a progress bar with words), and pills pick what "What happened lately" shows. The tiles keep the
// contract's order (§45.16.3), and nothing on the page is ever `disabled` (kid-proof: aria-disabled instead).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import type { StoriesApi, StoriesDashboard } from "../src/stories/api/types.ts";
import { forgetDashboards, forgetOnboarding, refreshDashboard, refreshOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/lib/router.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/router.ts")>();
  return { ...real, navigate: () => undefined };
});

const { DashboardScreen, activityPills, splitCount, videosUnit } = await import("../src/stories/screens/Dashboard.tsx");

const line = (kind: StoriesDashboard["activity"][number]["kind"], i: number): StoriesDashboard["activity"][number] => ({ at: new Date(Date.now() - i * 60_000).toISOString(), kind, storyId: `S${i}`, title: `Story ${i}` });

describe("the numerals and the pills", () => {
  it("splitCount: a big numeral and its small unit (plain counts have none)", () => {
    expect(splitCount(5)).toEqual({ num: "5" });
    expect(splitCount(214)).toEqual({ num: "214" });
    expect(splitCount(1500)).toEqual({ num: "1.5", unit: "K" });
    expect(splitCount(2_000_000)).toEqual({ num: "2", unit: "M" });
  });

  it("videosUnit: the small unit of a count of videos (one video, K videos)", () => {
    expect(videosUnit(1)).toBe("video");
    expect(videosUnit(0)).toBe("videos");
    expect(videosUnit(5)).toBe("videos");
    expect(videosUnit(1500)).toBe("K videos");
  });

  it("activityPills: All, then only the kinds in the list, in one fixed order; no pills for one kind", () => {
    expect(activityPills([])).toEqual([]);
    expect(activityPills([line("made", 1), line("made", 2)])).toEqual([]);
    expect(activityPills([line("posted", 1), line("made", 2), line("failed", 3), line("made", 4)]).map((p) => p.label)).toEqual(["All", "Made", "Posted", "Stopped"]);
  });
});

describe("the Dashboard's glass", () => {
  let host: HTMLElement;
  let root: Root;
  let api: StoriesApi;
  const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const $$ = <T extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<T>(sel));
  const settle = async () => {
    for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };

  beforeEach(async () => {
    localStorage.clear();
    resetWorkspaceMemory();
    forgetDashboards();
    forgetOnboarding();
    forgetLoaded();
    setMockLatency(0);
    api = mockStoriesApi();
    setStoriesApi(api);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <ToastProvider>
          <DashboardScreen ws="stories" page={{ name: "dashboard" }} />
        </ToastProvider>,
      ),
    );
    await settle();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setStoriesApi(null);
  });

  it("keeps the tiles in the contract's order, each a glass card; the counts are big numerals", () => {
    const tiles = $$(".st-tiles > .st-tile");
    expect(tiles.map((e) => (e.querySelector(".st-tile__title, .st-stat__label")?.textContent ?? "").replace(/\d+$/, "").trim())).toEqual([
      "Needs you",
      "Animations made",
      "Waiting for review",
      "Published",
      "Being made now",
      "Connected accounts",
      "How the videos do",
      "What happened lately",
    ]);
    for (const t of tiles) expect(t.classList.contains("st-glass"), t.className).toBe(true);
    const stats = $$(".st-dash-stat");
    expect(stats).toHaveLength(3);
    for (const s of stats) {
      expect(s.querySelector(".st-stat__num")?.textContent).toMatch(/^\d/);
      // The big numeral's small unit, and a round glass mark (never a status colour) for what it counts.
      expect(s.querySelector(".st-stat__unit")?.textContent).toMatch(/^(\S+ )?videos?$/);
      expect(s.querySelector(".st-dash-stat__icon")?.classList.contains("st-round-btn")).toBe(true);
    }
    expect($$(".st-perf__item .st-stat__label").map((e) => e.textContent)).toEqual(["Views", "Likes", "Comments", "Shares"]);
    expect($(".st-tile .st-tile__big")?.textContent).toMatch(/^\d+ of 5$/);
  });

  it("has one cream card, the next video, whose orange toggle saves its music in the workspace", async () => {
    const creams = $$(".st-cream");
    expect(creams).toHaveLength(1);
    const card = creams[0]!;
    expect(card.classList.contains("st-tile")).toBe(false);
    expect(card.querySelector("h2")?.textContent).toBe("Next video");
    const before = (await api.getWorkspace("stories")).configuration.defaultDurationSec;
    expect(card.querySelector(".st-dash-next__num")?.textContent).toBe(String(before));
    const music = card.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(music.getAttribute("aria-label")).toBe("Music");
    const was = music.getAttribute("aria-checked") === "true";
    await act(async () => music.click());
    await settle();
    expect(music.getAttribute("aria-checked")).toBe(String(!was));
    expect((await api.getWorkspace("stories")).configuration.musicOn).toBe(!was);
    // The word beside it is its label: a tap on "Music" flips it back.
    await act(async () => card.querySelector<HTMLLabelElement>("label")!.click());
    await settle();
    expect((await api.getWorkspace("stories")).configuration.musicOn).toBe(was);
  });

  it("has its head on a backing plate and one orange main action: the setup's way on while it is open", async () => {
    const o = await api.getOnboarding("stories");
    expect(o.finishedAt).toBeFalsy();
    // One plate: the shell's page head itself, never a second plate around it or inside it.
    expect($(".st-dash > header.st-head.st-plate")).not.toBeNull();
    expect($$(".st-dash .st-plate .st-head, .st-dash .st-head .st-plate")).toEqual([]);
    const mains = $$(".st-dash .st-btn--main");
    expect(mains.map((m) => m.textContent?.trim())).toEqual(["Carry on"]);
    expect($(".st-setupcard .st-btn--main")).not.toBeNull();
    // Every Needs you row opens with a glass button.
    expect($$(".st-needs-list__item a.st-btn").length).toBeGreaterThan(0);
    expect($$(".st-needs-list .st-btn--main")).toEqual([]);
  });

  it("shows the setup's progress on the arc: a progress bar with its words", async () => {
    const o = await api.getOnboarding("stories");
    const dial = $('.st-setupcard [role="progressbar"]')!;
    expect(dial.classList.contains("st-dial")).toBe(true);
    expect(dial.getAttribute("aria-valuetext")).toBe(`${o.done} of ${o.total} done`);
    expect(dial.getAttribute("aria-valuenow")).toBe(String(o.done));
    expect($(".st-setupcard h2")?.textContent).toContain(`${o.done} of ${o.total} done`);
  });

  it("picks what happened lately with pills: one tap shows only that kind, All shows everything again", async () => {
    const all = $$(".st-activity__row").length;
    const pills = $$<HTMLButtonElement>('.st-dash-pills [role="radio"]');
    expect(pills[0]?.textContent).toBe("All");
    expect(pills[0]?.getAttribute("aria-checked")).toBe("true");
    const made = pills.find((p) => p.textContent === "Made")!;
    await act(async () => made.click());
    expect(made.getAttribute("aria-checked")).toBe("true");
    const shown = $$(".st-activity__row");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(all);
    for (const r of shown) expect(r.classList.contains("st-activity__row--made")).toBe(true);
    await act(async () => pills[0]!.click());
    expect($$(".st-activity__row")).toHaveLength(all);
  });

  /** The Connected accounts tile, after the dashboard and the setup were read again. */
  const accountsTile = async () => {
    await act(async () => {
      await refreshDashboard("stories");
      await refreshOnboarding("stories");
    });
    await settle();
    return $$(".st-tile").find((t) => t.querySelector("h2")?.textContent?.includes("Connected accounts"))!;
  };

  it("counts only the platforms not skipped: X skipped is gone from the tile, its line and the setup's list (the owner, 24 Nov)", async () => {
    const before = await accountsTile();
    expect(before.querySelector(".st-tile__big")?.textContent).toMatch(/^\d+ of 5$/);
    expect($$(".st-accounts__row")).toHaveLength(5);
    await api.patchOnboarding("stories", { step: "x", skipped: true });
    const tile = await accountsTile();
    const connected = (await api.social("stories")).accounts.filter((a) => a.connectionStatus === "connected" && !a.skipped).length;
    expect(tile.querySelector(".st-tile__big")?.textContent).toBe(`${connected} of 4`);
    expect($$(".st-accounts__row")).toHaveLength(4);
    expect($$(".st-accounts__row .sr-only").map((n) => n.textContent)).toEqual(["YouTube: ", "TikTok: ", "Instagram: ", "Facebook: "]);
    // Nothing on the dashboard asks for X any more: not Needs you, not the setup card's "Still to do".
    expect($$(".st-needs-list__item").some((i) => i.querySelector(".st-needs-list__mark")?.getAttribute("title") === "X")).toBe(false);
    expect($(".st-setupcard")?.textContent).not.toContain("Connect X");
    const o = await api.getOnboarding("stories");
    const left = o.steps.filter((s) => s.state !== "done" && s.step !== "done" && s.step !== "x");
    expect(o.steps.find((s) => s.step === "x")?.state).toBe("skipped");
    expect(left.length).toBeGreaterThan(3);
    expect($(".st-setupcard__left")?.textContent).toBe(`Still to do: ${left.slice(0, 3).map((s) => s.label).join(", ")} and ${left.length - 3} more. You can make videos already.`);
    expect(o.total).toBe(10);
    expect($(".st-setupcard h2")?.textContent).toContain(`${o.done} of 10 done`);
  });

  it("says Nothing to connect, with no number, when every platform is skipped", async () => {
    await api.disconnectSocial("stories", "youtube");
    for (const step of ["youtube", "tiktok", "instagram", "facebook", "x"] as const) await api.patchOnboarding("stories", { step, skipped: true });
    const tile = await accountsTile();
    expect(tile.querySelector(".st-tile__big")).toBeNull();
    expect(tile.querySelector(".st-tile__note")?.textContent).toBe("Nothing to connect.");
    expect(tile.querySelectorAll(".st-accounts__row")).toHaveLength(0);
    expect(tile.querySelector("a")?.getAttribute("href")).toBe("/stories/connections");
    expect(tile.querySelector("a")?.textContent).toBe("Open Social accounts");
    expect(tile.textContent).not.toMatch(/of 0|of 5/);
  });

  it("is kid-proof: nothing on it is ever disabled, and the videos being made are media rows that open the studio", () => {
    expect($$(".st-dash button:disabled, .st-dash [disabled]")).toEqual([]);
    const row = $<HTMLAnchorElement>("a.st-making__row");
    expect(row?.getAttribute("href")).toMatch(/^\/stories\/production\//);
    expect(row?.querySelector(".st-media [role='progressbar']")?.getAttribute("aria-label")).toMatch(/: /);
  });
});
