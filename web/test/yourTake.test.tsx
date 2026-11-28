// Your take (owner request, 2026-11-27): Review shows the clip's take as one quiet read-only line under the hook, and
// Settings › Clip making › Clips has its switch, Say it out loud and How you talk (both gone while it is off).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { Me, Settings } from "../src/api/types.ts";
import { TAKE_STYLE_MAX, tidyTakeStyle } from "../src/lib/take.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveSettings = vi.fn(async (patch: Partial<Settings>) => {
  Object.assign(me.settings, patch);
  return patch;
});
const me = { user: { id: "u" }, settings: {} } as unknown as Me;
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me, saveSettings }) }));

const { ClipsBranch } = await import("../src/screens/settings/branches.tsx");
const { YourTake } = await import("../src/screens/review/Review.tsx");

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  saveSettings.mockClear();
  me.settings = { clipMin: 5, clipMax: 10, maxSourceHours: 6 } as Settings;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const show = () => act(() => root.render(<ClipsBranch />));
const apple = (id: string) => host.querySelector<HTMLElement>(`[data-help="${id}"]`);
const toggle = (id: string) => apple(id)!.querySelector<HTMLButtonElement>('button[role="switch"]')!;
const field = () => apple("take-style")!.querySelector<HTMLInputElement>("input")!;
/** Types into a React-controlled input the way a browser does. */
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    el.focus();
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Review: the Your take line", () => {
  it("shows a small label and the words, as user text, with its help anchor", () => {
    act(() => root.render(<YourTake text="Give this kid the keys every single time." />));
    const line = host.querySelector(".review-card__take")!;
    expect(line.getAttribute("data-help")).toBe("your-take-line");
    expect(line.querySelector(".review-card__take-label")!.textContent).toBe("Your take");
    expect(line.querySelector(".user-text")!.textContent).toBe("Give this kid the keys every single time.");
    // Read-only in this version: nothing to type in or tap.
    expect(line.querySelector("input, textarea, button, [contenteditable]")).toBeNull();
  });

  it("shows nothing at all for a clip without one", () => {
    act(() => root.render(<YourTake text={undefined} />));
    expect(host.innerHTML).toBe("");
    act(() => root.render(<YourTake text="" />));
    expect(host.innerHTML).toBe("");
  });

  it("the line has no cursor rule (the mouse cursor never changes)", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "screens.css"), "utf8");
    const at = css.indexOf(".review-card__take {");
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf(".review-card__why {"))).not.toMatch(/cursor/);
  });
});

describe("Settings › Clip making › Clips: Your take", () => {
  it("is on, said out loud, with an empty style line when the server sends nothing (an old server)", () => {
    show();
    expect(toggle("your-take").getAttribute("aria-checked")).toBe("true");
    expect(toggle("take-voice").getAttribute("aria-checked")).toBe("true");
    expect(field().value).toBe("");
    expect(apple("take-style")!.querySelector(".counter")!.textContent).toBe(`0 / ${TAKE_STYLE_MAX}`);
    expect(field().maxLength).toBe(TAKE_STYLE_MAX);
    expect(field().className).toContain("user-text");
  });

  it("the switch saves takeOn, and off hides Say it out loud and How you talk", () => {
    show();
    act(() => toggle("your-take").click());
    expect(saveSettings).toHaveBeenCalledWith({ takeOn: false });
    show();
    expect(toggle("your-take").getAttribute("aria-checked")).toBe("false");
    expect(apple("take-voice")).toBeNull();
    expect(apple("take-style")).toBeNull();
    act(() => toggle("your-take").click());
    expect(saveSettings).toHaveBeenLastCalledWith({ takeOn: true });
  });

  it("Say it out loud saves takeVoice", () => {
    show();
    act(() => toggle("take-voice").click());
    expect(saveSettings).toHaveBeenCalledWith({ takeVoice: false });
  });

  it("How you talk saves a moment after typing stops, tidied, and only once", () => {
    show();
    type(field(), "  funny,   honest ");
    expect(apple("take-style")!.querySelector(".counter")!.textContent).toBe(`18 / ${TAKE_STYLE_MAX}`);
    expect(saveSettings).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(900));
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ takeStyle: "funny, honest" });
    act(() => field().blur());
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("How you talk saves when you leave the field, before the timer", () => {
    show();
    type(field(), "a bit cheeky");
    act(() => field().blur());
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith({ takeStyle: "a bit cheeky" });
    act(() => void vi.advanceTimersByTime(2000));
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("How you talk keeps the typed words when the save fails, and leaving the field again tries once more", async () => {
    show();
    const words = "funny, honest, a bit cheeky";
    type(field(), words);
    // The real saveSettings: shows the new words at once, and on an error puts the old ones back and answers null.
    let fail!: () => void;
    saveSettings.mockImplementationOnce(((patch: Partial<Settings>) => {
      me.settings = { ...me.settings, ...patch };
      return new Promise((done) => {
        fail = () => {
          me.settings = { ...me.settings, takeStyle: "" };
          done(null);
        };
      });
    }) as never);
    act(() => field().blur());
    show();
    expect(field().value).toBe(words);
    await act(async () => fail());
    show();
    expect(me.settings.takeStyle).toBe("");
    expect(field().value).toBe(words);
    expect(apple("take-style")!.querySelector(".counter")!.textContent).toBe(`${words.length} / ${TAKE_STYLE_MAX}`);
    // nothing is sent again by itself
    act(() => void vi.advanceTimersByTime(5000));
    expect(saveSettings).toHaveBeenCalledTimes(1);
    // leaving the field again sends the same words again, and this time they stick
    act(() => field().focus());
    await act(async () => field().blur());
    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(saveSettings).toHaveBeenLastCalledWith({ takeStyle: words });
    show();
    expect(me.settings.takeStyle).toBe(words);
    expect(field().value).toBe(words);
  });

  it("How you talk still takes words saved somewhere else while nobody types here", () => {
    show();
    me.settings = { ...me.settings, takeStyle: "calm and dry" };
    show();
    expect(field().value).toBe("calm and dry");
  });

  it("never holds more than 120 letters", () => {
    show();
    type(field(), "x".repeat(200));
    expect(field().value).toHaveLength(TAKE_STYLE_MAX);
    expect(apple("take-style")!.querySelector(".counter")!.textContent).toBe(`${TAKE_STYLE_MAX} / ${TAKE_STYLE_MAX}`);
  });
});

describe("the pretend API", () => {
  it("some clips have a take, some do not, and each is one short sentence", () => {
    const clips = seed().clips;
    const withTake = clips.filter((c) => c.take);
    expect(withTake.length).toBeGreaterThan(0);
    expect(withTake.length).toBeLessThan(clips.length);
    for (const c of withTake) {
      const words = c.take!.split(/\s+/).length;
      expect(words, c.take).toBeGreaterThanOrEqual(5);
      expect(words, c.take).toBeLessThanOrEqual(14);
      expect(c.take!.length, c.take).toBeLessThanOrEqual(90);
      expect(c.take, c.take).not.toMatch(/[#@]/);
    }
    for (const c of clips) if (c.campaignId || c.remakeOf) expect(c.take, c.clipId).toBeUndefined();
  });

  it("settings start on, said out loud, with no style; the style line is tidied and capped like the API", async () => {
    // The pretend API answers after a short real wait.
    vi.useRealTimers();
    const api = mockApi();
    expect(await api.getSettings()).toMatchObject({ takeOn: true, takeVoice: true, takeStyle: "" });
    expect((await api.putSettings({ takeStyle: "  funny,\n  honest  " })).takeStyle).toBe("funny, honest");
    expect((await api.putSettings({ takeOn: false, takeVoice: false })).takeOn).toBe(false);
    await expect(api.putSettings({ takeStyle: "x".repeat(TAKE_STYLE_MAX + 1) })).rejects.toThrow();
    await expect(api.putSettings({ takeOn: "yes" as unknown as boolean })).rejects.toThrow();
    expect((await api.getSettings()).takeStyle).toBe("funny, honest");
    expect(tidyTakeStyle(" a \t b ")).toBe("a b");
  });
});
