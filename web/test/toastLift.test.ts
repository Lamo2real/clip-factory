// A toast never covers the screen's pinned main button (phones, docs/CONTRACTS.md §38.1): "You're in!" over the
// pinned Make clips for this campaign. The toasts rise just above a pinned button they would touch, and stay in their
// own place otherwise (every other screen, and wide screens, keep the toasts exactly where they were).
import { describe, expect, it } from "vitest";
import { PINNED_MAIN, toastLift } from "../src/components/Toasts.tsx";

const VH = 812;
const box = (top: number, bottom: number, left = 16, right = 359) => ({ top, bottom, left, right });
// The toasts' own place on a phone: 24 px above the tab bar (components.css).
const TOASTS = box(668, 724, 20, 355);

describe("toastLift", () => {
  it("a pinned button under the toasts: they rise to just above it", () => {
    const pin = box(670, 724, 150, 359);
    const lift = toastLift(TOASTS, [pin], VH)!;
    expect(lift).toBe(VH - pin.top + 10);
    // Lifted, the toasts' bottom edge is above the button's top.
    expect(VH - lift).toBeLessThan(pin.top);
  });

  it("two pinned buttons (an Open and its answer, stacked): above the higher one", () => {
    expect(toastLift(TOASTS, [box(618, 666, 80, 343), box(676, 724, 120, 343)], VH)).toBe(VH - 618 + 10);
  });

  it("no pinned button, or one clear of the toasts: they keep their own place", () => {
    expect(toastLift(TOASTS, [], VH)).toBeNull();
    expect(toastLift(TOASTS, [box(300, 354)], VH)).toBeNull();
    expect(toastLift(TOASTS, [box(670, 724, 0, 10)], VH)).toBeNull();
    // An empty box (a pin slot with nothing in it) or no toasts at all.
    expect(toastLift(TOASTS, [box(700, 700)], VH)).toBeNull();
    expect(toastLift(box(700, 700), [box(670, 724)], VH)).toBeNull();
  });

  it("no room above the button (it sits high up): the toasts keep their own place", () => {
    expect(toastLift(box(10, 300), [box(200, 250)], VH)).toBeNull();
  });

  it("the pinned buttons it looks for are the phones' pinned main buttons", () => {
    expect(PINNED_MAIN).toBe(".cr-pin");
  });
});
