// What the Ask launcher counts as a control under its spot (docs/CONTRACTS.md §19.8).
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlBoxes, DODGE_HOLD_MS, DODGE_RETURN_MS, DODGE_SETTLE_MS, hardToTap, shownBox, useDodge } from "../src/features/help/dodge.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Reads `data-box="left,top,right,bottom"` as an element's box, for getBoundingClientRect and the offset* getters. */
function boxOf(el: Element): [number, number, number, number] {
  return (el.getAttribute("data-box") ?? "0,0,0,0").split(",").map(Number) as [number, number, number, number];
}

// The launcher keeps one spot and stays calm while the page scrolls (§19.8): it never moves, never changes mid-scroll
// or under a finger, fades out sooner than it comes back, and holds each state a while.
describe("useDodge: one spot, a calm fade only once the page is still", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function mount(pinned = false) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const [left, top, right, bottom] = boxOf(this);
      return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return boxOf(this)[1];
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return boxOf(this)[0];
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      const b = boxOf(this);
      return b[2] - b[0];
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      const b = boxOf(this);
      return b[3] - b[1];
    });
    const seen: boolean[] = [];
    function Launcher() {
      const ref = useRef<HTMLButtonElement>(null);
      const { hidden } = useDodge(ref, pinned);
      seen.push(hidden);
      return <button ref={ref} className="help-launcher" data-box="300,700,356,756" data-hidden={hidden || undefined} />;
    }
    // A small button right under the spot: hard to tap with the launcher on it.
    document.body.innerHTML = `<button id="control" data-box="300,710,356,746">Save</button><div id="host"></div>`;
    const root = createRoot(document.getElementById("host")!);
    act(() => root.render(<Launcher />));
    const hidden = () => document.querySelector(".help-launcher")!.hasAttribute("data-hidden");
    const control = document.getElementById("control")!;
    const away = () => control.setAttribute("data-box", "0,100,60,140");
    const under = () => control.setAttribute("data-box", "300,710,356,746");
    const scroll = () => act(() => void window.dispatchEvent(new Event("scroll")));
    const touch = (type: string, touches = 0) => act(() => void window.dispatchEvent(Object.assign(new Event(type), { touches: { length: touches } })));
    const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
    const changes = () => seen.filter((h, i) => i > 0 && h !== seen[i - 1]).length;
    return { hidden, away, under, scroll, touch, wait, changes, unmount: () => act(() => root.unmount()) };
  }

  it("fades out at once on a page that opens with a control under its spot", () => {
    const t = mount();
    t.wait(20);
    expect(t.hidden()).toBe(true);
    t.unmount();
  });

  it("stays shown over a big row link it rests on the edge of", () => {
    const t = mount();
    document.getElementById("control")!.remove();
    document.body.insertAdjacentHTML("afterbegin", `<a href="/x" data-box="16,680,374,780">A big card</a>`);
    t.wait(20);
    expect(t.hidden()).toBe(false);
    t.unmount();
  });

  it("changes nothing while the page scrolls, however long, and comes back only after a longer stillness", () => {
    const t = mount();
    t.wait(20);
    expect(t.hidden()).toBe(true);
    const before = t.changes();
    // The page scrolls the control away: a long fling, then momentum, a scroll event every 16 ms.
    t.away();
    for (let i = 0; i < 90; i++) {
      t.scroll();
      t.wait(16);
    }
    expect(t.hidden()).toBe(true);
    expect(t.changes()).toBe(before);
    // Still for the settle time: not yet. Back in only after the return time.
    t.wait(DODGE_SETTLE_MS + 40);
    expect(t.hidden()).toBe(true);
    t.wait(DODGE_RETURN_MS - DODGE_SETTLE_MS);
    expect(t.hidden()).toBe(false);
    t.unmount();
  });

  it("does not blink during short scrolls at reading pace: at most one change per settle, each held a while", () => {
    const t = mount();
    t.wait(20);
    t.away();
    t.scroll();
    t.wait(DODGE_HOLD_MS + DODGE_RETURN_MS);
    expect(t.hidden()).toBe(false);
    // Scroll 140 px every 300 ms, the control passing under the spot now and then.
    const flips: number[] = [];
    let was = t.hidden();
    for (let i = 0; i < 40; i++) {
      if (i % 3 === 0) t.under();
      else t.away();
      t.scroll();
      for (let f = 0; f < 300; f += 20) {
        t.wait(20);
        if (t.hidden() !== was) {
          was = t.hidden();
          flips.push(i * 300 + f);
        }
      }
    }
    for (let i = 1; i < flips.length; i++) expect(flips[i]! - flips[i - 1]!).toBeGreaterThanOrEqual(DODGE_HOLD_MS);
    t.unmount();
  });

  it("waits for the finger to lift: a drag that pauses mid-gesture changes nothing", () => {
    const t = mount();
    t.wait(20);
    t.away();
    t.scroll();
    t.wait(DODGE_HOLD_MS + DODGE_RETURN_MS);
    expect(t.hidden()).toBe(false);
    t.touch("touchstart", 1);
    t.under();
    t.scroll();
    t.wait(DODGE_HOLD_MS * 2);
    expect(t.hidden()).toBe(false);
    t.touch("touchend", 0);
    t.wait(DODGE_SETTLE_MS - 40);
    expect(t.hidden()).toBe(false);
    t.wait(80);
    expect(t.hidden()).toBe(true);
    t.unmount();
  });

  it("never fades while it has keyboard focus or its panel is open", () => {
    const t = mount(true);
    t.wait(20);
    t.scroll();
    t.wait(DODGE_HOLD_MS);
    expect(t.hidden()).toBe(false);
    t.unmount();
  });
});

// What is cut off by a scroller is not on screen, so the launcher has nothing to keep clear of there (§19.8). The
// setup list's column (§17.13) is why this matters: a strip of the page that runs on under the column, and rows
// scrolled out of the column on a short window, must not push the launcher onto the list or make it step aside.
describe("shownBox and controlBoxes: only what shows counts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  /** Gives every element with a data-box="left,top,right,bottom" that box. */
  function boxes() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const [left, top, right, bottom] = (this.getAttribute("data-box") ?? "0,0,0,0").split(",").map(Number) as [number, number, number, number];
      return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} } as DOMRect;
    });
  }
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  };
  const cut = "overflow-x: auto; overflow-y: auto";

  it("keeps the part inside a scroller, and nothing of what is scrolled out of it", () => {
    document.body.innerHTML = `
      <div style="${cut}" data-box="0,100,300,200">
        <button id="in" data-box="20,120,120,164">In</button>
        <button id="half" data-box="250,120,350,164">Half</button>
        <button id="out" data-box="320,120,420,164">Out</button>
        <button id="below" data-box="20,230,120,274">Below</button>
      </div>`;
    boxes();
    const el = (id: string) => document.getElementById(id)!;
    expect(shownBox(el("in"), box(el("in")))).toEqual({ top: 120, bottom: 164, left: 20, right: 120 });
    expect(shownBox(el("half"), box(el("half")))).toEqual({ top: 120, bottom: 164, left: 250, right: 300 });
    expect(shownBox(el("out"), box(el("out")))).toBeNull();
    expect(shownBox(el("below"), box(el("below")))).toBeNull();
  });

  it("lets the element itself cut its own words (a clamped line), but not its own box", () => {
    document.body.innerHTML = `<p id="clamp" style="overflow-x: hidden; overflow-y: hidden" data-box="0,100,200,140">Three lines of words</p>`;
    boxes();
    const p = document.getElementById("clamp")!;
    const thirdLine = { top: 140, bottom: 160, left: 0, right: 200 };
    expect(shownBox(p, thirdLine, true)).toBeNull();
    expect(shownBox(p, { top: 100, bottom: 120, left: 0, right: 200 }, true)).toEqual({ top: 100, bottom: 120, left: 0, right: 200 });
    expect(shownBox(p, box(p))).toEqual({ top: 100, bottom: 140, left: 0, right: 200 });
  });

  it("does not cut a fixed box by what holds it, nor an absolutely placed one by boxes it is not placed against", () => {
    document.body.innerHTML = `
      <div style="${cut}" data-box="0,0,100,100">
        <div style="position: fixed" data-box="500,500,700,700"><button id="fixed" data-box="520,520,620,564">Fixed</button></div>
      </div>
      <div style="position: relative" data-box="0,0,400,400">
        <div style="${cut}" data-box="0,0,100,100">
          <button id="placed" style="position: absolute" data-box="200,200,300,244">Placed</button>
        </div>
      </div>
      <div style="${cut}; position: relative" data-box="0,0,100,100">
        <button id="held" style="position: absolute" data-box="200,200,300,244">Held</button>
      </div>`;
    boxes();
    const el = (id: string) => document.getElementById(id)!;
    expect(shownBox(el("fixed"), box(el("fixed")))).toEqual({ top: 520, bottom: 564, left: 520, right: 620 });
    expect(shownBox(el("placed"), box(el("placed")))).toEqual({ top: 200, bottom: 244, left: 200, right: 300 });
    // Placed against the scroller itself: it is cut by it.
    expect(shownBox(el("held"), box(el("held")))).toBeNull();
  });

  it("controlBoxes: rows scrolled out of the setup list's column are no obstacle, its showing buttons are", () => {
    // The open column (fixed, clips) with its own scroller; the last row is scrolled out below the column.
    document.body.innerHTML = `
      <aside class="setup-todo setup-todo--rail" style="position: fixed; overflow-x: hidden; overflow-y: hidden" data-box="1112,18,1416,514">
        <div class="setup-todo__scroll" style="${cut}" data-box="1128,76,1400,498">
          <button id="shown" data-box="1268,430,1388,474">Skip Facebook</button>
          <button id="cut" data-box="1268,470,1388,514">Half cut</button>
          <button id="hidden" data-box="1268,531,1388,575">Skip X</button>
        </div>
      </aside>
      <div class="setup-todo-scrim" data-box="0,0,1440,600"><button id="chrome" data-box="1300,530,1400,574">In the open panel</button></div>
      <button id="far" data-box="300,530,400,574">Elsewhere on the page</button>`;
    boxes();
    const launcher = { left: 1318, right: 1416 };
    expect(controlBoxes(document, 600, launcher)).toEqual([
      { top: 430, bottom: 474, left: 1268, right: 1388 },
      { top: 470, bottom: 498, left: 1268, right: 1388 },
    ]);
    // Without a column every control on screen is returned (the open panel's scrim stays chrome).
    expect(controlBoxes(document, 600)).toHaveLength(3);
  });
});

describe("controls the launcher may not touch at all (§36.6)", () => {
  // The owner's screenshot: the round Ask button over the right end of "Upload to 4".
  const upload = { top: 600, bottom: 654, left: 700, right: 960 };
  const launcher = { top: 604, bottom: 650, left: 900, right: 990 };
  it("a plain control with plenty left beside the launcher stays easy to tap", () => {
    expect(hardToTap(launcher, upload)).toBe(false);
  });
  it("a data-help-clear control (Upload, Use my settings) is hard to tap as soon as the launcher touches it", () => {
    expect(hardToTap(launcher, { ...upload, clear: true })).toBe(true);
    expect(hardToTap({ ...launcher, left: 970, right: 1050 }, { ...upload, clear: true })).toBe(false);
  });
  it("controlBoxes marks what sits inside data-help-clear", () => {
    document.body.innerHTML = '<div data-help-clear=""><button>Upload to 4</button></div><button>Other</button>';
    for (const b of Array.from(document.querySelectorAll("button"))) b.getBoundingClientRect = () => ({ top: 10, bottom: 50, left: 10, right: 200, width: 190, height: 40, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    const boxes = controlBoxes(document, 800);
    expect(boxes.map((b) => !!b.clear)).toEqual([true, false]);
    document.body.innerHTML = "";
  });
});
