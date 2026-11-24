import { afterEach, describe, expect, it } from "vitest";
import { leaveGuarded, navigate, setLeaveGuard } from "../src/lib/router.ts";

// "Leave without saving?" (docs/CONTRACTS.md §18.7) holding a browser Back: after Leave the owner is where Back was
// taking them, and the next Back goes on from there (no duplicate history entry to stall on).

/** Waits for the popstate a history step fires (jsdom fires it on a later task). */
const popped = () => new Promise<void>((done) => window.addEventListener("popstate", () => setTimeout(done, 0), { once: true }));
const path = () => location.pathname;

// jsdom has no scrolling; navigate() scrolls to the top of each new page.
window.scrollTo = () => undefined;

let unguard: (() => void) | null = null;
afterEach(() => {
  unguard?.();
  unguard = null;
});

describe("leave guard and browser Back", () => {
  it("Leave after a held Back finishes that Back, and the next Back goes one more step", async () => {
    navigate("/settings");
    navigate("/settings/clip-making/skills");
    navigate("/settings/clip-making/skills/new");
    expect(path()).toBe("/settings/clip-making/skills/new");

    let leave: (() => void) | null = null;
    const asked: string[] = [];
    unguard = setLeaveGuard((to, proceed) => {
      asked.push(to);
      leave = proceed;
      return true;
    });

    let step = popped();
    history.back();
    await step;
    // Held: the page with the typing is back in the address bar while the owner decides.
    expect(path()).toBe("/settings/clip-making/skills/new");
    expect(asked).toEqual(["/settings/clip-making/skills"]);

    step = popped();
    leave!();
    await step;
    expect(path()).toBe("/settings/clip-making/skills");
    // The guard was not asked a second time on the way.
    expect(asked).toHaveLength(1);

    unguard();
    unguard = null;
    step = popped();
    history.back();
    await step;
    expect(path()).toBe("/settings");
  });
});

describe("leave guard after Leave", () => {
  it("a second Back right after Leave is not held again, even before the page has unmounted its guard", async () => {
    navigate("/settings");
    navigate("/settings/clip-making/skills");
    navigate("/settings/clip-making/skills/new");
    const asked: string[] = [];
    let leave: (() => void) | null = null;
    // Never removed by the test: the page with the typing has not unmounted yet.
    unguard = setLeaveGuard((to, proceed) => {
      asked.push(to);
      leave = proceed;
      return true;
    });
    let step = popped();
    history.back();
    await step;
    step = popped();
    leave!();
    await step;
    expect(path()).toBe("/settings/clip-making/skills");
    step = popped();
    history.back();
    await step;
    expect(path()).toBe("/settings");
    expect(asked).toEqual(["/settings/clip-making/skills"]);
  });
});

describe("leaveGuarded", () => {
  it("says which page changes a guard holds, so the switch to the other app still slides (§45.38 S3)", () => {
    expect(leaveGuarded()).toBe(false);
    expect(leaveGuarded("/stories")).toBe(false);
    // A guard that holds every change (the skill editor).
    unguard = setLeaveGuard(() => true);
    expect(leaveGuarded()).toBe(true);
    expect(leaveGuarded("/stories/ideas")).toBe(true);
    unguard();
    // A guard that lets the other app through (Home's running upload): asked without showing its question.
    let asked = 0;
    unguard = setLeaveGuard(
      (to) => {
        asked++;
        return !to.startsWith("/stories");
      },
      (to) => !to.startsWith("/stories"),
    );
    expect(leaveGuarded()).toBe(true);
    expect(leaveGuarded("/stories/ideas")).toBe(false);
    expect(leaveGuarded("/jobs")).toBe(true);
    expect(asked).toBe(0);
    unguard();
    unguard = null;
    expect(leaveGuarded("/jobs")).toBe(false);
  });
});
