// Audit F025: the Ask launcher keeps off words too (docs/CONTRACTS.md §19.8), not only off controls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlBoxes, DODGE_GAP, pickLift, reachZone, shownBox, textBoxes } from "../src/features/help/dodge.ts";

const base = { top: 700, bottom: 756, left: 300, right: 356 };

describe("pickLift", () => {
  it("lifts clear of a line of words when a free spot is within reach", () => {
    const line = { top: 720, bottom: 740, left: 16, right: 350 };
    expect(pickLift(base, [], [line], 300)).toEqual({ lift: 756 - 720 + DODGE_GAP, onWords: false });
  });

  it("clears controls and words together", () => {
    const button = { top: 690, bottom: 740, left: 280, right: 360 };
    const line = { top: 640, bottom: 660, left: 16, right: 350 };
    // Over the button lands it on the line, so it goes over both.
    expect(pickLift(base, [button], [line], 300)).toEqual({ lift: 756 - 640 + DODGE_GAP, onWords: false });
  });

  it("never hides because of words: with no spot clear of them it keeps the control-only spot", () => {
    const wall = { top: 300, bottom: 780, left: 16, right: 360 };
    expect(pickLift(base, [], [wall], 200)).toEqual({ lift: 0, onWords: true });
    const button = { top: 730, bottom: 780, left: 280, right: 360 };
    expect(pickLift(base, [button], [wall], 200)).toEqual({ lift: 756 - 730 + DODGE_GAP, onWords: true });
  });

  it("still steps aside when controls leave no room", () => {
    const tall = { top: 300, bottom: 790, left: 0, right: 400 };
    expect(pickLift(base, [tall], [], 200)).toEqual({ lift: null, onWords: false });
  });

  it("looks only in the launcher's own column, up to its highest lift", () => {
    expect(reachZone(base, 200)).toEqual({ top: 700 - 200 - DODGE_GAP, bottom: 756 + DODGE_GAP, left: 300, right: 356 });
  });
});

describe("textBoxes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("returns the lines of words in the zone and skips the launcher's own chrome, blank, hidden and screen-reader-only text", () => {
    document.body.innerHTML = `<p id="lede">Paste a link</p><p id="far">Far away</p><div class="help-panel"><p>Panel</p></div><p> </p><label><span class="sr-only">Only for screen readers</span></label><p hidden>Hidden</p>`;
    const rect = (top: number) => ({ top, bottom: top + 20, left: 16, right: 340, width: 324, height: 20, x: 16, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return rect(this.id === "far" ? 10 : 720);
    });
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    const original = proto.getClientRects;
    proto.getClientRects = function (this: Range) {
      const p = this.startContainer.parentElement;
      return [rect(p?.id === "far" ? 10 : 720)];
    };
    try {
      const out = textBoxes({ top: 400, bottom: 770, left: 300, right: 356 });
      expect(out).toEqual([{ top: 720, bottom: 740, left: 16, right: 340 }]);
    } finally {
      if (original) proto.getClientRects = original;
      else delete proto.getClientRects;
    }
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
