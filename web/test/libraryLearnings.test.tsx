// Library › What's working: the newest learning in three lines, See more shows every learning in full, See less puts it
// back, and a short single learning has nothing to expand.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Learning } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Learnings } = await import("../src/screens/library/Library.tsx");

const learning = (id: string, text: string): Learning => ({ learningId: id, text, createdAt: "2026-11-24T10:00:00Z", postIds: ["p1", "p2"] });
const LONG = "Both picks are gameplay-driven payoffs with a facecam reaction, built on a clear set-up and blow-up shape, with hooks that promise a reversal without naming it.";

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = (items: Learning[]) => act(() => root.render(<Learnings learnings={items} />));
const toggle = () => host.querySelector<HTMLButtonElement>("button.learnings__toggle");

describe("What's working", () => {
  it("shows the newest learning in brief, and See more / See less show and hide the rest", () => {
    show([learning("a", LONG), learning("b", "Second note about hooks.")]);
    expect(host.querySelectorAll(".learnings__list li")).toHaveLength(1);
    expect(host.querySelector(".learnings__brief")).not.toBeNull();
    expect(toggle()?.textContent).toBe("See more");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle()!.click());
    expect(host.querySelectorAll(".learnings__list li")).toHaveLength(2);
    expect(host.querySelector(".learnings__brief")).toBeNull();
    expect(host.textContent).toContain("Second note about hooks.");
    expect(toggle()?.textContent).toBe("See less");
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    act(() => toggle()!.click());
    expect(host.querySelectorAll(".learnings__list li")).toHaveLength(1);
  });

  it("offers See more for one long learning, but not for one short learning or none", () => {
    show([learning("a", LONG)]);
    expect(toggle()).not.toBeNull();
    show([learning("a", "Short and sweet.")]);
    expect(toggle()).toBeNull();
    show([]);
    expect(toggle()).toBeNull();
    expect(host.textContent).toContain("Star your best clips");
  });
});
