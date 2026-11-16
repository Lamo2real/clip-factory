// Audit F025: the Ask launcher keeps off words too (docs/CONTRACTS.md §19.8), not only off controls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DODGE_GAP, pickLift, reachZone, textBoxes } from "../src/features/help/dodge.ts";

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
