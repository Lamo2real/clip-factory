// The two apps stay apart; the shell is the only thing they share (docs/CONTRACTS.md §45.38; request 2: "The only
// shared element should be the application shell", "These two applications must not depend on each other's internal
// functionality"). A3: no Clip Factory file imports Lamo Stories' code (only the shell's own files, which host both,
// may). A1: a Clip Factory page change that comes after a wait never moves the owner out of Lamo Stories. A2: each
// app's toasts are its own. And the shell's one workspace switch: where it sits, worked out once for both apps.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipsGoLater, clipsHidden, takeParkedClipsGo } from "../src/app/shell.ts";
import { barHeight, dockLayout, SIDEBAR, type DockInput } from "../src/app/WorkspaceDock.tsx";
import { ToastProvider, ToastScope, useToast, useToastWhen, type Toaster } from "../src/components/Toasts.tsx";
import { balancedColumns, emptyUnder, pickColumns, shortestColumns } from "../src/stories/screens/Connections.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SRC = join(import.meta.dirname, "..", "src");
const STORIES = join(SRC, "stories");
const APP = join(SRC, "app");

/**
 * The shell files outside web/src/app that host both apps and so may read Lamo Stories' route table: the one router
 * every page of both apps goes through (it hands /stories addresses to Lamo Stories' routes).
 */
const SHELL_FILES = ["lib/router.ts"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });
}

/** Every module a file imports (static, re-exported, dynamic, and CSS @import), as written. */
function imports(text: string): string[] {
  const out: string[] = [];
  for (const re of [/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /@import\s+(?:url\()?["']([^"']+)["']/g])
    for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

describe("A3: no Clip Factory file imports Lamo Stories' code", () => {
  it("outside web/src/stories and web/src/app, nothing imports web/src/stories (but the shared router)", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      if (f.startsWith(STORIES + "/") || f.startsWith(APP + "/")) continue;
      const rel = relative(SRC, f);
      if (SHELL_FILES.includes(rel)) continue;
      for (const spec of imports(readFileSync(f, "utf8"))) {
        if (!spec.startsWith(".")) continue;
        const to = resolve(dirname(f), spec);
        if (to === STORIES || to.startsWith(STORIES + "/")) bad.push(`${rel} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the scan sees every way of importing (so a new kind of import cannot slip by)", () => {
    expect(imports(`import { a } from "../stories/a.ts";\nexport { b } from '../stories/b.ts';\nimport "../stories/c.css";\nconst d = import("../stories/d.ts");\n@import url("../stories/e.css");`)).toEqual([
      "../stories/a.ts",
      "../stories/b.ts",
      "../stories/c.css",
      "../stories/d.ts",
      "../stories/e.css",
    ]);
  });

  it("the shared router is the only exception, and it reads only Lamo Stories' flag and route table", () => {
    const router = readFileSync(join(SRC, "lib/router.ts"), "utf8");
    expect(imports(router).filter((s) => s.includes("stories/"))).toEqual(["../stories/flag.ts", "../stories/routes.ts"]);
  });
});

describe("A1: a Clip Factory page change after a wait (clipsGoLater)", () => {
  beforeEach(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/");
    takeParkedClipsGo();
  });
  afterEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("waits while Lamo Stories is on screen (the address and the history stay Lamo Stories'), once", () => {
    history.replaceState(null, "", "/stories/ideas");
    const before = history.length;
    clipsGoLater("/campaigns/c1");
    expect(location.pathname).toBe("/stories/ideas");
    expect(history.length).toBe(before);
    clipsGoLater("/settings/clip-making/skills/S1", { replace: true, force: true });
    // The latest wins, and it is read once.
    expect(takeParkedClipsGo()).toEqual({ to: "/settings/clip-making/skills/S1", replace: true, force: true });
    expect(takeParkedClipsGo()).toBeNull();
  });

  it("goes at once while Clip Factory is on screen, exactly as navigate does", () => {
    history.replaceState(null, "", "/");
    clipsGoLater("/campaigns/c1");
    expect(location.pathname).toBe("/campaigns/c1");
    expect(takeParkedClipsGo()).toBeNull();
  });

  it("with Lamo Stories switched off it is navigate itself, wherever the address is", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    history.replaceState(null, "", "/stories");
    expect(clipsHidden()).toBe(false);
    clipsGoLater("/jobs");
    expect(location.pathname).toBe("/jobs");
  });

  it("is used where a Clip Factory screen moves after a request (and nowhere imports Lamo Stories for it)", () => {
    const read = (p: string) => readFileSync(join(SRC, p), "utf8");
    expect(read("screens/home/NewJobForm.tsx")).toContain('if (out.kind === "added") clipsGoLater(campaignPath(out.campaignId));');
    expect(read("screens/campaigns/CampaignPaste.tsx").match(/clipsGoLater\(campaignPath\(out\.campaignId\)\)/g)).toHaveLength(2);
    const find = read("screens/campaigns/FindPage.tsx");
    expect(find).toContain("clipsGoLater(makeClipsPath(campaignId));");
    expect(find).toContain("clipsGoLater(campaignPath(m.campaignId));");
    expect(read("screens/settings/SkillPages.tsx").match(/clipsGoLater\(skillPath\([^)]*\), \{ replace: true, force: true \}\)/g)).toHaveLength(3);
    // Clip Factory's shell runs what waited the moment its pane is on screen again.
    expect(read("app/App.tsx")).toMatch(/const go = takeParkedClipsGo\(\);\s*if \(go\) \{\s*takeClipsScroll\(at\);\s*navigate\(go\.to, \{ replace: go\.replace, force: go\.force \}\);/);
  });
});

describe("A2: each app's toasts are its own (ToastScope)", () => {
  let host: HTMLElement;
  let root: Root;
  let toaster: Toaster | null = null;
  function Grab() {
    toaster = useToast();
    return null;
  }
  const texts = () => Array.from(host.querySelectorAll(".toast__text")).map((t) => t.textContent);
  const draw = (active: boolean, onScreen: () => boolean, onError: () => void, shellError = vi.fn()) =>
    act(() =>
      root.render(
        <ToastProvider onError={shellError}>
          <ToastScope active={active} onScreen={onScreen} onError={onError}>
            <Grab />
          </ToastScope>
        </ToastProvider>,
      ),
    );

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("a toast raised while its app is hidden waits for it, then shows; its own error sound, never the shell's", async () => {
    let on = false;
    const mine = vi.fn();
    const shell = vi.fn();
    await draw(false, () => on, mine, shell);
    act(() => toaster!.error("Could not add that campaign."));
    act(() => toaster!.success("Added."));
    expect(texts()).toEqual([]);
    expect(mine).not.toHaveBeenCalled();
    on = true;
    await draw(true, () => on, mine, shell);
    expect(texts()).toEqual(["Added.", "Could not add that campaign."]);
    expect(mine).toHaveBeenCalledTimes(1);
    expect(shell).not.toHaveBeenCalled();
  });

  it("one that waited longer than its own time on screen is dropped", async () => {
    vi.useFakeTimers();
    let on = false;
    await draw(false, () => on, vi.fn());
    act(() => toaster!.info("Saved."));
    vi.advanceTimersByTime(5000);
    on = true;
    await draw(true, () => on, vi.fn());
    expect(texts()).toEqual([]);
  });

  it("a toast of its own still up when its app goes behind the other one leaves with it, and is back for the rest of its time", async () => {
    let on = true;
    await draw(true, () => on, vi.fn());
    act(() => toaster!.success("Started! Your clips show up in Review when they are ready."));
    expect(texts()).toEqual(["Started! Your clips show up in Review when they are ready."]);
    on = false;
    await draw(false, () => on, vi.fn());
    expect(texts()).toEqual([]);
    on = true;
    await draw(true, () => on, vi.fn());
    expect(texts()).toEqual(["Started! Your clips show up in Review when they are ready."]);
    // And again: the one that came back leaves with its app too.
    on = false;
    await draw(false, () => on, vi.fn());
    expect(texts()).toEqual([]);
    on = true;
    await draw(true, () => on, vi.fn());
    expect(texts()).toEqual(["Started! Your clips show up in Review when they are ready."]);
  });

  it("one the owner closed, or one whose time ran out while its app was behind, does not come back; nor does its sound play twice", async () => {
    vi.useFakeTimers();
    let on = true;
    const mine = vi.fn();
    await draw(true, () => on, mine);
    act(() => toaster!.error("That did not save."));
    act(() => toaster!.info("Saved."));
    expect(mine).toHaveBeenCalledTimes(1);
    act(() => (host.querySelector(".toast--info .toast__close") as HTMLButtonElement).click());
    expect(texts()).toEqual(["That did not save."]);
    on = false;
    await draw(false, () => on, mine);
    on = true;
    await draw(true, () => on, mine);
    // The error is back (its time was not up), quietly; the closed one is not.
    expect(texts()).toEqual(["That did not save."]);
    expect(mine).toHaveBeenCalledTimes(1);
    on = false;
    await draw(false, () => on, mine);
    act(() => vi.advanceTimersByTime(8000));
    on = true;
    await draw(true, () => on, mine);
    expect(texts()).toEqual([]);
  });

  it("an app's code outside its pane (Clip Factory's session) waits too, and shows once that app's pane is on screen", async () => {
    let clips = false;
    let session: Toaster | null = null;
    function Session() {
      session = useToastWhen(() => clips);
      return null;
    }
    const shell = vi.fn();
    const paint = () =>
      act(() =>
        root.render(
          <ToastProvider onError={shell}>
            <Session />
            <ToastScope active={clips} onScreen={() => clips} onError={vi.fn()}>
              <Grab />
            </ToastScope>
          </ToastProvider>,
        ),
      );
    await paint();
    act(() => session!.error("You seem to be offline."));
    expect(texts()).toEqual([]);
    expect(shell).not.toHaveBeenCalled();
    clips = true;
    await paint();
    expect(texts()).toEqual(["You seem to be offline."]);
    expect(shell).toHaveBeenCalledTimes(1);
    // On screen, it is the plain toaster.
    act(() => session!.info("Saved."));
    expect(texts()).toContain("Saved.");
  });

  it("shows at once while its app is on screen; Undo always goes through (it holds the owner's own decision)", async () => {
    await draw(true, () => true, vi.fn());
    act(() => toaster!.info("Saved."));
    expect(texts()).toEqual(["Saved."]);
    await draw(false, () => false, vi.fn());
    act(() => toaster!.undo("Thrown away.", { onUndo: vi.fn(), onCommit: vi.fn() }));
    expect(texts()).toContain("Thrown away.");
  });

  it("puts the scope's class on every toast its app raises (one that waited, one that came back, an undo), never on the shell's", async () => {
    vi.useFakeTimers();
    let on = false;
    let shell: Toaster | null = null;
    function Shell() {
      shell = useToast();
      return null;
    }
    const paint = () =>
      act(() =>
        root.render(
          <ToastProvider>
            <Shell />
            <ToastScope active={on} onScreen={() => on} onError={vi.fn()} className="st-toast">
              <Grab />
            </ToastScope>
          </ToastProvider>,
        ),
      );
    const classOf = (text: string) => Array.from(host.querySelectorAll(".toast")).find((t) => t.querySelector(".toast__text")?.textContent === text)?.className.split(" ");
    await paint();
    act(() => toaster!.success("Saved."));
    on = true;
    await paint();
    act(() => toaster!.error("That did not save."));
    act(() => toaster!.undo("Deleted.", { onUndo: vi.fn(), onCommit: vi.fn() }));
    act(() => shell!.info("You seem to be offline."));
    // (errors are read out in their own live region, after the rest)
    expect(texts()).toEqual(["Saved.", "Deleted.", "You seem to be offline.", "That did not save."]);
    for (const t of ["Saved.", "That did not save.", "Deleted."]) expect(classOf(t), t).toEqual(expect.arrayContaining(["toast", "glass", "st-toast"]));
    expect(classOf("You seem to be offline.")).not.toContain("st-toast");
    // Behind the other app and back: what comes back is still its app's.
    on = false;
    await paint();
    on = true;
    await paint();
    expect(classOf("Saved."), "back").toContain("st-toast");
    expect(classOf("That did not save."), "back").toContain("st-toast");
  });
});

describe("the shell's one workspace switch: where it sits (dockLayout, §45.38)", () => {
  // Clip Factory's sidebar at 1440×900 as the browser lays it out (measured): its box is 872 px tall from the 14 px
  // top line; the Live chip is 62.31 × 28.72 in a 36.72 px row; Get the app and the jobs line under it.
  const at1440: DockInput = { frameH: 872, left: 14, vw: 1440, folded: false, liveH: 36.72, liveDotW: 62.31, liveDotH: 28.72, getApp: true, jobs: true, count: 2, stacked: false };

  it("open, with room: the bar right above the Live chip, exactly where the sidebar's foot had it", () => {
    const l = dockLayout(at1440);
    expect(l.mode).toBe("bar");
    // In the window: the bar at 27, 678.28 (226 × 52), the Live chip's row at 27, 734.28; as Clip Factory drew them.
    expect({ x: l.sw!.left + 14, y: +(l.sw!.top + 14).toFixed(2), w: l.sw!.width, h: l.sw!.height }).toEqual({ x: 27, y: 678.28, w: 226, h: 52 });
    expect({ x: l.live.left + 14, y: +(l.live.top + 14).toFixed(2), w: l.live.width }).toEqual({ x: 27, y: 734.28, w: 226 });
    // Lamo Stories' rail stops 4 px above the bar.
    expect(900 - l.room).toBeLessThanOrEqual(678.28 - 4 + 1);
  });

  it("folded: a round toggle above the compact Live chip, centred in the folded sidebar", () => {
    const l = dockLayout({ ...at1440, folded: true, liveH: 36, liveDotW: 28, liveDotH: 28 });
    expect(l.mode).toBe("round");
    expect({ x: l.sw!.left + 14, y: l.sw!.top + 14, w: l.sw!.width }).toEqual({ x: 32, y: 687, w: 44 });
  });

  it("a shorter window: a round toggle beside the Live chip; shorter still, a slim toggle in the gap or beside the fold button", () => {
    expect(dockLayout({ ...at1440, frameH: 600 - 28 }).mode).toBe("corner");
    expect(dockLayout({ ...at1440, frameH: 600 - 28, folded: true, liveH: 36, liveDotW: 28, liveDotH: 28 }).mode).toBe("slim");
    const top = dockLayout({ ...at1440, vw: 1000, frameH: 560 - 28, folded: true, liveH: 36, liveDotW: 28, liveDotH: 28 });
    expect(top.mode).toBe("top");
    // Right of the fold button with 4 px of air, and short of the page (at 80 + 14 + 32 px) with 4 px of air.
    expect(top.sw!.left + 14).toBe(14 + SIDEBAR.rim + SIDEBAR.padX + SIDEBAR.foldLeft + SIDEBAR.fold + 4);
    expect(top.sw!.left + 14 + top.sw!.width).toBeLessThanOrEqual(80 + 14 + 32 - 4);
    // A window too short for the menu and the foot: the foot runs on right under the menu (as the sidebar draws it),
    // and the toggle sits beside the Live chip there.
    const under = dockLayout({ ...at1440, vw: 1280, frameH: 520 - 28 });
    expect(under.mode).toBe("corner");
    expect(under.live.top).toBe(SIDEBAR.rim + SIDEBAR.padY + SIDEBAR.head + SIDEBAR.gap + SIDEBAR.menu + SIDEBAR.gap);
    // With no Live chip (not connected) and no room at all: a slim toggle in the strip before the page, at the foot.
    const edge = dockLayout({ ...at1440, vw: 1280, frameH: 520 - 28, liveH: 0 });
    expect(edge.mode).toBe("edge");
    expect(edge.sw!.left + 14).toBe(14 + 252 + 4);
    expect(edge.sw!.width).toBeGreaterThanOrEqual(28);
  });

  it("never covers the menu: whatever it is, it starts 4 px below the sixth item (or sits beside the fold button)", () => {
    const listBottom = SIDEBAR.rim + SIDEBAR.padY + SIDEBAR.head + SIDEBAR.gap + SIDEBAR.menu;
    for (const h of [560, 600, 650, 700, 760, 900, 1024])
      for (const folded of [false, true])
        for (const getApp of [false, true])
          for (const jobs of [false, true])
            for (const liveH of [0, 36.72]) {
              const l = dockLayout({ ...at1440, frameH: h - 28, folded, getApp, jobs, liveH, liveDotW: folded ? 28 : 62.31 });
              if (!l.sw || l.mode === "top" || l.mode === "edge") continue;
              expect(l.sw.top, `${h} ${folded} ${getApp} ${jobs} ${liveH}: ${l.mode}`).toBeGreaterThanOrEqual(listBottom + 4 - 0.5);
            }
  });

  it("the bar is 52 px with two side by side, taller when the choices stand one above the other", () => {
    expect(barHeight(2, false)).toBe(52);
    expect(barHeight(2, true)).toBe(8 + 44 + 2 + 44);
    expect(barHeight(4, false)).toBe(8 + 4 * 44 + 3 * 2);
  });
});

describe("Social accounts' cards in balanced columns (§45.36 E18)", () => {
  it("deals the cards so the columns end as close together as they can, each card kept in page order", () => {
    // The mock's five cards at 1440 in two columns (as measured): a 3 + 2 deal with Instagram beside its neighbours.
    const two = [849, 898, 1222, 967, 944];
    const at = balancedColumns(two, 2);
    expect(emptyUnder(two, at, 2)).toBeLessThan(emptyUnder(two, shortestColumns(two, 2), 2));
    expect(emptyUnder(two, at, 2)).toBeLessThan(600);
    // Never worse than the shortest-column deal, and every column holds a card.
    for (const h of [two, [1024, 1109, 1622, 1215, 1112], [500, 500, 500, 500, 500], [2000, 100, 100, 100, 100]])
      for (const k of [2, 3]) {
        const best = balancedColumns(h, k);
        expect(emptyUnder(h, best, k)).toBeLessThanOrEqual(emptyUnder(h, shortestColumns(h, k), k));
        expect(new Set(best).size).toBe(k);
      }
  });

  it("picks the number of columns that leaves the least empty area, measured at each width (more columns on a tie)", () => {
    const at: Record<number, number[]> = { 2: [849, 898, 1222, 967, 944], 3: [1024, 1109, 1622, 1215, 1112] };
    expect(pickColumns((k) => at[k]!, 3).columns).toBe(2);
    expect(pickColumns(() => [500, 500, 500, 500, 500, 500], 3).columns).toBe(3);
    // Robust to a card growing by a line: still under the old 700 px.
    const grown = pickColumns((k) => at[k]!.map((h, i) => (i === 1 ? h + 24 : h)), 3);
    expect(emptyUnder(at[grown.columns]!.map((h, i) => (i === 1 ? h + 24 : h)), grown.at, grown.columns)).toBeLessThan(700);
  });
});
