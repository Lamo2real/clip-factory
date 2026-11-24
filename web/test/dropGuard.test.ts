// The window's drop guard (docs/CONTRACTS.md §12.5, §45.40): mounted for the whole app from the start (main.tsx), so a
// stray file never replaces the app and a stray link never navigates, also when the app opens straight into Clips
// Funded. A zone's own drop (prevented first) is left alone, and text dragged into a text box still lands there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDropGuard, isEditableTarget } from "../src/lib/dropGuard.ts";

type Fired = Event & { dataTransfer: { dropEffect: string } };

function drag(type: string, types: string[]): Fired {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Fired;
  Object.assign(e, { dataTransfer: { types, files: [], items: [], getData: () => "", dropEffect: "copy" } });
  return e;
}

let off: () => void;
let page: HTMLElement;

beforeEach(() => {
  off = installDropGuard();
  page = document.createElement("div");
  page.innerHTML = '<p class="words">hi</p><textarea></textarea><input class="url" type="url"><input class="pick" type="file"><div class="rich" contenteditable="true">x</div>';
  document.body.append(page);
});
afterEach(() => {
  off();
  page.remove();
});

const at = (sel: string) => page.querySelector(sel)!;

describe("the drop guard", () => {
  it("refuses a stray file and a stray link: prevented, and the drag shows no drop", () => {
    for (const types of [["Files"], ["text/uri-list", "text/plain"], ["Files", "text/uri-list"]]) {
      const over = drag("dragover", types);
      at(".words").dispatchEvent(over);
      expect(over.defaultPrevented, types.join()).toBe(true);
      expect(over.dataTransfer.dropEffect, types.join()).toBe("none");
      const drop = drag("drop", types);
      at(".words").dispatchEvent(drop);
      expect(drop.defaultPrevented, types.join()).toBe(true);
    }
  });

  it("leaves an event a zone already took untouched", () => {
    const zone = (e: Event) => {
      e.preventDefault();
      (e as Fired).dataTransfer.dropEffect = "copy";
    };
    at(".words").addEventListener("dragover", zone);
    const over = drag("dragover", ["Files"]);
    at(".words").dispatchEvent(over);
    at(".words").removeEventListener("dragover", zone);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("copy");
  });

  it("lets text and links land in a text box, but never a file", () => {
    for (const sel of ["textarea", ".url", ".rich"]) {
      const over = drag("dragover", ["text/uri-list", "text/plain"]);
      at(sel).dispatchEvent(over);
      expect(over.defaultPrevented, sel).toBe(false);
      expect(over.dataTransfer.dropEffect, sel).toBe("copy");
      const drop = drag("drop", ["text/plain"]);
      at(sel).dispatchEvent(drop);
      expect(drop.defaultPrevented, sel).toBe(false);
    }
    const file = drag("drop", ["Files"]);
    at("textarea").dispatchEvent(file);
    expect(file.defaultPrevented).toBe(true);
  });

  it("leaves plain text dragged over the page alone (nothing to open)", () => {
    const over = drag("dragover", ["text/plain"]);
    at(".words").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });

  it("is installed once, and comes off", () => {
    expect(installDropGuard()).toBe(off);
    off();
    const drop = drag("drop", ["Files"]);
    at(".words").dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    off = installDropGuard();
  });

  it("knows a text box from a file picker or a button", () => {
    expect(isEditableTarget(at("textarea"))).toBe(true);
    expect(isEditableTarget(at(".url"))).toBe(true);
    expect(isEditableTarget(at(".rich").firstChild)).toBe(true);
    expect(isEditableTarget(at(".pick"))).toBe(false);
    expect(isEditableTarget(at(".words"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
