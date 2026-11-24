// The floating setup to-do list's rules (docs/CONTRACTS.md §17.13): rows, when the list shows, skips, and the width
// from which it may take a column of its own.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountStatus, Platform, PlatformSetup } from "../src/api/types.ts";
import {
  activeSkips,
  doneLine,
  isFinished,
  listCount,
  listRows,
  skippedNote,
  skipQuestion,
  staleSkips,
  TODO_RAIL_MIN,
  TODO_RAIL_QUERY,
  todoCount,
  todoHiddenOn,
  todoNoRailOn,
  todoRows,
  todoVisible,
  withoutSkip,
  withoutSkipped,
  withSkip,
} from "../src/lib/setupTodo.ts";
import { SETUP_ORDER } from "../src/setup/index.ts";

const STYLES = join(import.meta.dirname, "..", "src", "styles");
const css = (name: string) => readFileSync(join(STYLES, name), "utf8");

const ALL = [...SETUP_ORDER];

type How = "blank" | "started" | "ready" | "gated" | AccountStatus;

function setup(platform: Platform, how: How = "blank"): PlatformSetup {
  const status: AccountStatus = how === "ready" || how === "gated" ? "connected" : how === "blank" || how === "started" ? "not_connected" : how;
  return {
    platform,
    stepsDone: how === "started" ? ["x-step"] : [],
    ready: how === "ready",
    keys: { saved: how === "started" },
    account: { platform, status },
    // Connected, but a gate needs the owner (X with no credits, YouTube before its app is published).
    gates: how === "gated" ? [{ key: "credits", state: "action" }] : [],
  };
}
const every = (how: How, over: Partial<Record<Platform, How>> = {}) => ALL.map((p) => setup(p, over[p] ?? how));
const state = (rows: ReturnType<typeof todoRows>, p: Platform) => rows.find((r) => r.platform === p)!;

describe("the setup to-do list (§17.13)", () => {
  it("has a row per platform in the setup order, with the §17 states", () => {
    const rows = todoRows(every("blank", { youtube: "ready", tiktok: "started", x: "needs_reconnect" }), ["facebook"]);
    expect(rows.map((r) => r.platform)).toEqual(ALL);
    expect(Object.fromEntries(rows.map((r) => [r.platform, r.state]))).toEqual({
      youtube: "ready",
      tiktok: "in_progress",
      instagram: "not_started",
      facebook: "skipped",
      x: "needs_you",
    });
    expect(state(rows, "tiktok").line).toMatch(/^In progress: \d+ of \d+$/);
    expect(state(rows, "x").line).toBe("Needs you: connect again");
    expect(state(rows, "youtube").connected).toBe(true);
    expect(state(rows, "x").connected).toBe(false);
  });

  it("says what a platform that needs the owner needs", () => {
    const rows = todoRows(every("blank", { youtube: "needs_reconnect", instagram: "choose_account", x: "gated" }));
    expect(state(rows, "youtube").line).toBe("Needs you: connect again");
    expect(state(rows, "instagram").line).toBe("Needs you: pick an account");
    expect(state(rows, "x").line).toBe("Needs you: one more step");
    expect(state(rows, "x").connected).toBe(true);
  });

  it("shows while anything is left, and not before the data is in", () => {
    expect(todoVisible(null)).toBe(false);
    expect(todoVisible(todoRows(every("blank")))).toBe(true);
    expect(todoCount(todoRows(every("blank")))).toEqual({ finished: 0, total: 5 });
  });

  it("goes away when every platform is ready", () => {
    expect(todoVisible(todoRows(every("ready")))).toBe(false);
  });

  it("goes away when every platform is skipped (and confirmed)", () => {
    expect(todoVisible(todoRows(every("blank"), ALL))).toBe(false);
  });

  it("goes away with a mix of ready and skipped", () => {
    const rows = todoRows(every("blank", { youtube: "ready", tiktok: "ready" }), ["instagram", "facebook", "x"]);
    expect(rows.every(isFinished)).toBe(true);
    expect(todoVisible(rows)).toBe(false);
    expect(todoCount(rows)).toEqual({ finished: 5, total: 5 });
  });

  it("a confirmed skip finishes a row whatever it is waiting for, so skipping every one always ends the list", () => {
    // Connected behind a gate, a dead token, an account to pick, half done, not started: each can be skipped.
    const setups = every("blank", { youtube: "started", tiktok: "needs_reconnect", instagram: "choose_account", x: "gated" });
    expect(todoVisible(todoRows(setups))).toBe(true);
    const rows = todoRows(setups, ALL);
    expect(rows.map((r) => r.state)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(todoVisible(rows)).toBe(false);
    // Skipping only the one that needs the owner finishes that row.
    expect(state(todoRows(every("ready", { x: "gated" }), ["x"]), "x").state).toBe("skipped");
    expect(todoVisible(todoRows(every("ready", { x: "gated" }), ["x"]))).toBe(false);
  });

  it("an unconfirmed skip changes nothing: only the saved list counts", () => {
    // Tapping Skip only asks; nothing is added until the owner confirms, so the rows read the same.
    const before = todoRows(every("ready", { tiktok: "blank" }), []);
    expect(todoVisible(before)).toBe(true);
    const asked: Platform[] = [];
    expect(todoVisible(todoRows(every("ready", { tiktok: "blank" }), asked))).toBe(true);
    expect(todoVisible(todoRows(every("ready", { tiktok: "blank" }), withSkip(asked, "tiktok")))).toBe(false);
  });

  it("ready wins over a skip, and that skip is stale: dropped, so the platform comes back if it stops being ready", () => {
    // Skipped, then set up anyway: the row is Ready and the skip is stale.
    const set = todoRows(every("ready"), ["instagram"]);
    expect(state(set, "instagram").state).toBe("ready");
    expect(staleSkips(set, ["instagram"])).toEqual(["instagram"]);
    const kept = withoutSkip(["instagram"], "instagram");
    expect(todoVisible(todoRows(every("ready"), kept))).toBe(false);
    // Later it loses its connection: with the stale skip gone, the list comes back with that row.
    const lost = todoRows(every("ready", { instagram: "needs_reconnect" }), kept);
    expect(todoVisible(lost)).toBe(true);
    expect(state(lost, "instagram").state).toBe("needs_you");
  });

  it("a ready platform that was never skipped comes back when it stops being ready", () => {
    expect(todoVisible(todoRows(every("ready")))).toBe(false);
    for (const how of ["needs_reconnect", "choose_account", "gated"] as const) {
      const rows = todoRows(every("ready", { facebook: how }));
      expect(todoVisible(rows), how).toBe(true);
      expect(state(rows, "facebook").state, how).toBe("needs_you");
    }
  });

  it("skip and un-skip keep the canonical order without repeats", () => {
    expect(withSkip(["x"], "youtube")).toEqual(["youtube", "x"]);
    expect(withSkip(["x"], "x")).toEqual(["x"]);
    expect(withoutSkip(["youtube", "x"], "x")).toEqual(["youtube"]);
    expect(withoutSkip([], "x")).toEqual([]);
  });

  it("only ready platforms make a skip stale", () => {
    const rows = todoRows(every("blank", { tiktok: "ready", x: "gated" }), ["tiktok", "x"]);
    expect(state(rows, "tiktok").state).toBe("ready");
    expect(state(rows, "x").state).toBe("skipped");
    expect(staleSkips(rows, ["tiktok", "x"])).toEqual(["tiktok"]);
  });

  it("asks in kid-proof words, and never promises a connected platform gets nothing", () => {
    expect(skipQuestion("tiktok")).toEqual({
      title: "Skip TikTok?",
      text: "You won't post there until you set it up. You can do it later in Settings.",
    });
    expect(skipQuestion("x", true)).toEqual({
      title: "Skip X?",
      text: "X is connected but needs one more step. Skip only takes it off this list. You can finish it later in Settings.",
    });
    expect(skippedNote("tiktok")).toBe("You won't post to TikTok until you set it up.");
    expect(skippedNote("x", true)).toBe("X is connected but needs one more step.");
  });

  it('"All set!" says how it ended: all ready, all skipped, or a mix', () => {
    expect(doneLine(todoRows(every("ready")))).toBe("Every place is ready.");
    expect(doneLine(todoRows(every("blank"), ALL))).toBe("All skipped. Set them up any time in Settings.");
    expect(doneLine(todoRows(every("ready", { x: "blank" }), ["x"]))).toBe("Done for now. Skipped ones wait in Settings.");
  });

  it("stays off the setup pages, which already show the full list", () => {
    expect(todoHiddenOn("/settings/posting/setup")).toBe(true);
    expect(todoHiddenOn("/settings/posting/setup/tiktok")).toBe(true);
    expect(todoHiddenOn("/settings/posting/where")).toBe(false);
    expect(todoHiddenOn("/")).toBe(false);
    expect(todoHiddenOn("/settings/posting/setupx")).toBe(false);
  });

  it("is the pill, never the open column, on a clip's page (it needs the whole width)", () => {
    expect(todoNoRailOn("/clips/01ABC")).toBe(true);
    expect(todoNoRailOn("/library")).toBe(false);
    expect(todoNoRailOn("/")).toBe(false);
  });
});

describe("a skipped platform leaves every reminder and count (rule S, 24 Nov)", () => {
  it("listRows: the floating list shows only the rows that are not skipped, in the setup order", () => {
    const rows = todoRows(every("blank", { youtube: "ready", instagram: "started", x: "needs_reconnect" }), ["tiktok", "facebook"]);
    expect(listRows(rows).map((r) => r.platform)).toEqual(["youtube", "instagram", "x"]);
    expect(listRows(rows).map((r) => r.state)).toEqual(["ready", "in_progress", "needs_you"]);
    expect(listRows(rows).some((r) => r.state === "skipped")).toBe(false);
    // Nothing skipped: every row, as todoRows gives them.
    expect(listRows(todoRows(every("blank")))).toEqual(todoRows(every("blank")));
  });

  it("listCount: skipped ones are not counted, ready over the rest", () => {
    expect(listCount(todoRows(every("blank")))).toEqual({ ready: 0, total: 5 });
    // The owner's case: X skipped, four ready → "4 of 4".
    expect(listCount(todoRows(every("ready", { x: "blank" }), ["x"]))).toEqual({ ready: 4, total: 4 });
    expect(listCount(todoRows(every("blank", { youtube: "ready" }), ["tiktok"]))).toEqual({ ready: 1, total: 4 });
    // todoCount still says how many rows are finished (ready or skipped), for "All set!".
    expect(todoCount(todoRows(every("blank", { youtube: "ready" }), ["tiktok"]))).toEqual({ finished: 2, total: 5 });
  });

  it("listCount: all five skipped is no count at all", () => {
    const rows = todoRows(every("blank"), ALL);
    expect(listCount(rows)).toEqual({ ready: 0, total: 0 });
    expect(listRows(rows)).toEqual([]);
    expect(todoVisible(rows)).toBe(false);
  });

  it("ready wins over a stale skip: it is counted and listed as ready", () => {
    const rows = todoRows(every("ready", { tiktok: "blank" }), ["instagram"]);
    expect(state(rows, "instagram").state).toBe("ready");
    expect(listRows(rows).map((r) => r.platform)).toEqual(ALL);
    expect(listCount(rows)).toEqual({ ready: 4, total: 5 });
    expect(activeSkips(every("ready", { tiktok: "blank" }), ["instagram"])).toEqual([]);
  });

  it("the list shows while a row that is not skipped is not ready, and only then", () => {
    expect(todoVisible(todoRows(every("ready", { tiktok: "blank", x: "blank" }), ["x"]))).toBe(true);
    expect(todoVisible(todoRows(every("ready", { tiktok: "blank", x: "blank" }), ["tiktok", "x"]))).toBe(false);
  });

  it("withoutSkipped filters a list of places and keeps its order; activeSkips counts only places that are not ready", () => {
    expect(withoutSkipped(["youtube", "tiktok", "x"], ["tiktok"])).toEqual(["youtube", "x"]);
    expect(withoutSkipped(["x", "youtube"], ["facebook"])).toEqual(["x", "youtube"]);
    expect(withoutSkipped(["youtube", "x"])).toEqual(["youtube", "x"]);
    expect(withoutSkipped(["tiktok"], ["tiktok"])).toEqual([]);
    expect(activeSkips(every("blank", { x: "ready" }), ["tiktok", "x"])).toEqual(["tiktok"]);
    // Before the setups are in, every skip counts (nothing is known to be ready).
    expect(activeSkips(null, ["facebook", "x"])).toEqual(["facebook", "x"]);
  });
});

describe("the list's styles follow the house rules (§17.13)", () => {
  const own = css("setup-todo.css");

  it("never sets a cursor: the arrow stays, hover shows what can be pressed (§20.14)", () => {
    expect(own.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/cursor/);
    for (const hovered of [".setup-todo__pill:hover", ".todo-row:hover", ".setup-todo__fold:hover"]) expect(own).toContain(hovered);
  });

  it("paints no panel of its own: every surface is the shared glass", () => {
    const rules = own.replace(/\/\*[\s\S]*?\*\//g, "");
    // No backdrop-filter here (glass.css owns the blur), and the surfaces set no background.
    expect(rules).not.toMatch(/backdrop-filter/);
    for (const surface of [".setup-todo-bar", ".setup-todo--rail", ".setup-todo-panel", ".setup-todo__pill", ".setup-todo--done"])
      for (const m of rules.matchAll(new RegExp(`(?:^|[\\n,])\\s*${surface.replace(/[.-]/g, "\\$&")}(?:,[^{]*)?\\s*\\{([^}]*)\\}`, "g")))
        expect(m[1], `${surface} sets a background`).not.toMatch(/background(?:-color|-image)?\s*:/);
  });
});

describe("the open column never squeezes a page (§17.13)", () => {
  const px = (text: string, token: string) => Number(new RegExp(`${token}:\\s*(\\d+)px`).exec(text)![1]);
  const sidebar = px(css("tokens.css"), "--sidebar-w");
  const column = px(css("setup-todo.css"), "--todo-w");
  const [, low, vw, high] = /--gutter:\s*clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)/.exec(css("tokens.css"))!.map(Number) as [number, number, number, number];
  const gutter = (width: number) => Math.min(high, Math.max(low, (width * vw) / 100));
  /** The room `.shell` leaves the page at a window width: the menu on the left, the gutter or the list's column on the right. */
  const room = (width: number, withColumn: boolean) => width - (sidebar + 14 + gutter(width)) - (withColumn ? 24 + column + 24 : gutter(width));

  it("reads the shell's paddings the way the CSS writes them", () => {
    expect(css("layout.css")).toContain("padding-left: calc(var(--sidebar-w) + 14px + var(--gutter));");
    expect(css("setup-todo.css")).toContain("padding-right: calc(max(24px, env(safe-area-inset-right)) + var(--todo-w) + 24px);");
    expect(TODO_RAIL_QUERY).toBe(`(min-width: ${TODO_RAIL_MIN}px)`);
  });

  it("opens only where the page keeps at least the room every wide layout was made for", () => {
    // Every width from which a page lays itself out wider (two columns, a side panel): with the column open, the
    // page must still have what it has at that width with nothing beside it.
    const starts = new Set<number>();
    for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css") && f !== "setup-todo.css"))
      for (const m of css(file).matchAll(/@media \(min-width:\s*(\d+)px\)/g)) starts.add(Number(m[1]));
    const widest = Math.max(...starts);
    expect(widest).toBeGreaterThanOrEqual(1024);
    expect(TODO_RAIL_MIN).toBeGreaterThan(widest);
    for (const start of starts) if (start >= 768) expect(room(TODO_RAIL_MIN, true), `layouts that start at ${start} px`).toBeGreaterThanOrEqual(room(start, false));
    // One step narrower and Home's two columns would be squeezed: that is why it is not 1280.
    expect(room(1280, true)).toBeLessThan(room(widest, false));
  });
});
