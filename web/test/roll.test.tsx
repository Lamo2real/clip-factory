// Rolling numbers (components/Roll.tsx): the first number is only shown, a bigger one rolls up, a smaller one rolls
// down, reduced motion swaps with no roll, and screen readers get the final number alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reduced = false;
vi.mock("../src/lib/prefs.ts", async (orig) => ({ ...(await orig<object>()), prefersReducedMotion: () => reduced }));

const { Roll, rollCells, ROLL_MS } = await import("../src/components/Roll.tsx");

let host: HTMLDivElement;
let root: Root;
const show = (n: number | null, text: string) => act(() => root.render(<Roll n={n} text={text} />));
const roll = () => host.querySelector(".roll")!;
/** What each rolling window holds, top to bottom. */
const strips = () => [...host.querySelectorAll(".roll__strip")].map((s) => s.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("Roll", () => {
  it("shows the first number with no roll", () => {
    show(26_800, "26.8K");
    expect(roll().classList.contains("is-rolling")).toBe(false);
    expect(host.textContent).toBe("26.8K");
    expect(host.querySelector(".roll__strip")).toBeNull();
  });

  it("rolls up when the number grows, then rests on the plain text", () => {
    show(26_800, "26.8K");
    show(27_100, "27.1K");
    expect(roll().getAttribute("data-roll")).toBe("up");
    // 6 to 7 and 8 past 9 to 1; the old digit is on top and the strip ends on the new one.
    expect(strips()).toEqual(["67", "8901"]);
    act(() => vi.advanceTimersByTime(ROLL_MS + 100));
    expect(roll().classList.contains("is-rolling")).toBe(false);
    expect(host.textContent).toBe("27.1K");
  });

  it("rolls down when the number shrinks", () => {
    show(70, "70");
    show(68, "68");
    expect(roll().getAttribute("data-roll")).toBe("down");
    // The new digit is on top and the old one at the bottom: the strip slides down.
    expect(strips()).toEqual(["67", "890"]);
  });

  it("reads only the final number to screen readers while rolling", () => {
    show(6, "6");
    show(7, "7");
    expect(host.querySelector(".sr-only")!.textContent).toBe("7");
    expect(host.querySelector(".roll__row")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("swaps with no roll under reduced motion", () => {
    reduced = true;
    show(70, "70");
    show(71, "71");
    expect(roll().classList.contains("is-rolling")).toBe(false);
    expect(host.textContent).toBe("71");
  });

  it("does not roll from or to no number", () => {
    show(null, "–");
    show(120, "120");
    expect(roll().classList.contains("is-rolling")).toBe(false);
    expect(host.textContent).toBe("120");
  });

  it("starts a fresh roll when the number changes again mid-roll", () => {
    show(1, "1");
    show(2, "2");
    act(() => vi.advanceTimersByTime(ROLL_MS / 2));
    show(1, "1");
    expect(roll().getAttribute("data-roll")).toBe("down");
    act(() => vi.advanceTimersByTime(ROLL_MS - 100));
    expect(roll().classList.contains("is-rolling")).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(host.textContent).toBe("1");
  });
});

describe("rollCells", () => {
  it("lines the two numbers up from the right and keeps letters and dots still", () => {
    expect(rollCells("9.9K", "10K", "up")).toEqual([
      { kind: "still", char: "1" },
      { kind: "roll", digits: ["9", "0"] },
      { kind: "still", char: "K" },
    ]);
    expect(rollCells("$12.40", "$12.45", "up").filter((c) => c.kind === "roll")).toEqual([{ kind: "roll", digits: ["0", "1", "2", "3", "4", "5"] }]);
  });
});

describe("roll.css", () => {
  const css = readFileSync(join(__dirname, "../src/styles/roll.css"), "utf8");
  it("lasts as long as the component waits, eases slow in and slow out, and keeps digits one width", () => {
    expect(css).toContain(`--roll-dur: ${ROLL_MS}ms`);
    expect(css).toMatch(/animation:\s*var\(--roll-dur\)\s+var\(--ease-in-out\)/);
    expect(css).toContain("tabular-nums");
    expect(css).not.toMatch(/cursor\s*:/);
  });
});
