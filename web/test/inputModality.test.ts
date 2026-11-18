// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installInputModality } from "../src/lib/inputModality.ts";

describe("input modality", () => {
  it("is keyboard after Tab and pointer after a tap, so a tapped field shows no ring", () => {
    const root = document.createElement("html");
    const target = new EventTarget();
    installInputModality(root, target);
    expect(root.dataset.input).toBeUndefined();
    target.dispatchEvent(Object.assign(new Event("keydown"), { key: "a" }));
    expect(root.dataset.input).toBeUndefined();
    target.dispatchEvent(Object.assign(new Event("keydown"), { key: "Tab" }));
    expect(root.dataset.input).toBe("keyboard");
    target.dispatchEvent(new Event("pointerdown"));
    expect(root.dataset.input).toBe("pointer");
  });
});
