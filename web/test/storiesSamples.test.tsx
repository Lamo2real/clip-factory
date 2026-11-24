// The character editor's sound samples (docs/CONTRACTS.md §45.41): every voice, noise and effect has its file, a play
// button plays it without picking the chip, one sample plays at a time, Clips Funded's Sounds switch and Quiet switch
// the buttons off, letting go of the pitch slider plays the voice at the snapped pitch, a car hears its car sounds
// first, and the play buttons never make the click sound. Rendered in jsdom (no Web Audio: the player only logs),
// with a stand-in AudioContext where the real path (fetch, decode, play, a failed load) is checked.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import type { CharacterKind, CharacterVoice } from "../src/stories/engine/types.ts";
import { followStoriesClicks, setStoriesDevicePref } from "../src/stories/prefs.ts";
import { HearButton } from "../src/stories/studio/kit.tsx";
import { CAR_SFX, everySampleUrl, hearState, playSample, resetSamplesForTests, sampleUrl, snapPitch, stopSample } from "../src/stories/studio/samples.ts";
import { SAMPLE_PITCHES, SAMPLE_ROOT } from "../src/stories/studio/samplesRoot.ts";
import { SoundsPart } from "../src/stories/studio/SoundsPart.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PUBLIC = join(import.meta.dirname, "..", "public");
const VOICE: CharacterVoice = { style: "babble", pitch: 1, noises: ["gasp", "yay", "hmm"], sfx: ["whoosh", "honk"] };

let root: Root | null = null;
let host: HTMLElement;
let stopClicks: (() => void) | null = null;

/** The part with its own state, as the editor holds it. */
function Harness({ kind = "person", start = VOICE }: { kind?: CharacterKind; start?: CharacterVoice }) {
  const [voice, setVoice] = useState(start);
  return <SoundsPart kind={kind} name="Pip" voice={voice} onChange={setVoice} />;
}

function show(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function button(name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).filter((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
  expect(found, `one button "${name}"`).toHaveLength(1);
  return found[0]! as HTMLButtonElement;
}

function chip(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).filter((b) => b.textContent?.replace(/^[✓+]/, "").trim() === label);
  expect(found, `one chip "${label}"`).toHaveLength(1);
  return found[0]!;
}

function tap(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const sampleLog = () => window.__cfSampleLog ?? [];

/** Lets the fetch and the decode answer. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}
const plays = () => sampleLog().filter((e) => e.action === "play").map((e) => e.url);

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/stories/characters/new");
  window.__cfSampleLog = [];
  window.__cfSoundLog = [];
  resetSamplesForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  stopClicks?.();
  stopClicks = null;
  resetSamplesForTests();
  setStoriesDevicePref("sound.enabled", null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the files", () => {
  it("snap the pitch to the slider's stops", () => {
    expect(snapPitch(1.13)).toBe(1.15);
    expect(snapPitch(0.4)).toBe(0.5);
    expect(snapPitch(2.6)).toBe(2);
    expect(snapPitch(Number.NaN)).toBe(1);
    expect(SAMPLE_PITCHES).toHaveLength(31);
    for (const [i, p] of SAMPLE_PITCHES.entries()) {
      expect(p).toBeCloseTo(0.5 + 0.05 * i, 10);
      expect(snapPitch(p)).toBe(p);
    }
  });

  it("are named by kind, voice, pitch stop and id under the recipe folder", () => {
    expect(SAMPLE_ROOT).toMatch(/^\/sounds\/stories\/[0-9a-f]{10}$/);
    expect(sampleUrl({ kind: "sfx", id: "honk" })).toBe(`${SAMPLE_ROOT}/sfx/honk.mp3`);
    expect(sampleUrl({ kind: "noise", id: "gasp", voice: "babble", pitch: 1 })).toBe(`${SAMPLE_ROOT}/babble/p100/gasp.mp3`);
    expect(sampleUrl({ kind: "noise", id: "hmm", voice: "hum", pitch: 0.52 })).toBe(`${SAMPLE_ROOT}/hum/p050/hmm.mp3`);
    expect(sampleUrl({ kind: "noise", id: "yay", voice: "hum", pitch: 2 })).toBe(`${SAMPLE_ROOT}/hum/p200/yay.mp3`);
  });

  it("are on disk for every catalog noise in both voices at every pitch stop, and for every effect", () => {
    const urls = everySampleUrl(
      CATALOG.noises.map((n) => n.id),
      CATALOG.sfx.map((s) => s.id),
    );
    expect(urls).toHaveLength(CATALOG.sfx.length + 2 * 31 * CATALOG.noises.length);
    const missing = urls.filter((u) => !existsSync(join(PUBLIC, u)));
    expect(missing).toEqual([]);
  });

  it("list the car sounds from the catalog", () => {
    expect(CAR_SFX).toEqual(["engine", "honk", "brake_squeal", "skid", "screech", "tyre_burst", "beep", "click"]);
    for (const id of CAR_SFX) expect(CATALOG.sfx.some((s) => s.id === id)).toBe(true);
  });
});

describe("the play buttons", () => {
  it("play the chip's sound without picking it", () => {
    show(<Harness />);
    const gasp = chip("Gasp");
    const whoa = chip("Whoa");
    expect(gasp.getAttribute("aria-pressed")).toBe("true");
    expect(whoa.getAttribute("aria-pressed")).toBe("false");
    tap(button("Play Gasp"));
    tap(button("Play Whoa"));
    expect(chip("Gasp").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Whoa").getAttribute("aria-pressed")).toBe("false");
    expect(plays()).toEqual([sampleUrl({ kind: "noise", id: "gasp", voice: "babble", pitch: 1 }), sampleUrl({ kind: "noise", id: "whoa", voice: "babble", pitch: 1 })]);
    // A tap on the chip itself still only picks it.
    tap(chip("Whoa"));
    expect(chip("Whoa").getAttribute("aria-pressed")).toBe("true");
    expect(plays()).toHaveLength(2);
  });

  it("stop on a second tap, and starting another stops the first", () => {
    show(<Harness />);
    tap(button("Play Gasp"));
    expect(button("Stop Gasp").classList.contains("is-playing")).toBe(true);
    tap(button("Stop Gasp"));
    expect(button("Play Gasp")).toBeTruthy();
    const gasp = sampleUrl({ kind: "noise", id: "gasp", voice: "babble", pitch: 1 });
    expect(sampleLog().map((e) => [e.action, e.url])).toEqual([
      ["play", gasp],
      ["stop", gasp],
    ]);
    tap(button("Play Gasp"));
    tap(button("Play Honk"));
    expect(button("Play Gasp")).toBeTruthy();
    expect(button("Stop Honk")).toBeTruthy();
    expect(sampleLog().slice(2).map((e) => e.action)).toEqual(["play", "stop", "play"]);
    expect(host.querySelectorAll(".st-s-hear.is-playing")).toHaveLength(1);
  });

  it("play the noises in the voice picked, at its pitch", () => {
    show(<Harness start={{ ...VOICE, style: "hum", pitch: 1.5 }} />);
    tap(button("Play Hmm"));
    expect(plays()).toEqual([`${SAMPLE_ROOT}/hum/p150/hmm.mp3`]);
  });

  it("are switched off while Clips Funded's Sounds are off, with the hint and its Turn on", () => {
    setStoriesDevicePref("sound.enabled", false);
    expect(hearState()).toBe("off");
    show(<Harness />);
    const play = button("Play Gasp");
    expect(play.getAttribute("aria-disabled")).toBe("true");
    expect(play.title).toBe("Turn Sounds on first");
    expect(play.hasAttribute("data-sound")).toBe(false); // the deny path of the click rules
    expect(host.textContent).toContain("Sounds are off. Turn them on to hear these.");
    expect(play.getAttribute("aria-describedby")).toBeTruthy(); // the reason is read out, not only a tooltip
    expect(document.getElementById(play.getAttribute("aria-describedby")!)?.textContent).toBe("Turn Sounds on first");
    tap(play);
    expect(plays()).toEqual([]);
    expect(playSample({ kind: "sfx", id: "honk" })).toBe(false);
    expect(sampleLog().map((e) => e.action)).toEqual(["off"]);
    // "Turn on" switches Sounds on right here: no other page, so a character not saved yet stays as it is
    const on = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Turn on")!;
    const at = location.pathname;
    tap(on);
    expect(location.pathname).toBe(at);
    expect(hearState()).toBe("ok");
    expect(host.textContent).not.toContain("Sounds are off");
    expect(button("Play Gasp").hasAttribute("aria-disabled")).toBe(false);
  });

  it("carry data-sound=off with Sounds on, so the click sound does not play over the sample", () => {
    show(<Harness />);
    const play = button("Play Gasp");
    expect(play.getAttribute("data-sound")).toBe("off");
    expect(play.hasAttribute("aria-disabled")).toBe(false);
    expect(host.textContent).not.toContain("Sounds are off");
  });

  it("make no click sound (the tap tests count __cfSoundLog exactly)", () => {
    stopClicks = followStoriesClicks();
    show(<Harness />);
    tap(button("Play Gasp"));
    tap(button("Stop Gasp"));
    tap(button("Play Babble voice"));
    expect(window.__cfSoundLog ?? []).toEqual([]);
    // The chip itself still clicks.
    tap(chip("Whoa"));
    expect((window.__cfSoundLog ?? []).map((e) => e.kind)).toEqual(["tap"]);
  });

  it("under Quiet: the noises' play buttons say to pick a voice first, and the chips can still be picked", () => {
    show(<Harness start={{ ...VOICE, style: "none" }} />);
    const play = button("Play Gasp");
    expect(play.getAttribute("aria-disabled")).toBe("true");
    expect(play.title).toBe("Pick Babble or Hum first");
    // a phone shows no tooltip: the reason is a line anyone can see, and read out on the button
    expect(host.textContent).toContain("Quiet makes no noises. Pick Babble or Hum to hear them.");
    expect(document.getElementById(play.getAttribute("aria-describedby")!)?.textContent).toBe("Pick Babble or Hum first");
    tap(play);
    expect(plays()).toEqual([]);
    tap(chip("Whoa"));
    expect(chip("Whoa").getAttribute("aria-pressed")).toBe("true");
    // The effects and the two voices can still be heard.
    expect(button("Play Honk").hasAttribute("aria-disabled")).toBe(false);
    tap(button("Play Hum voice"));
    expect(plays()).toEqual([`${SAMPLE_ROOT}/hum/p100/babble.mp3`]);
  });

  it("the Hear row plays each voice at the current pitch", () => {
    show(<Harness start={{ ...VOICE, pitch: 0.75 }} />);
    expect(button("Play Babble voice").textContent).toBe("Babble");
    tap(button("Play Babble voice"));
    tap(button("Play Hum voice"));
    expect(plays()).toEqual([`${SAMPLE_ROOT}/babble/p075/babble.mp3`, `${SAMPLE_ROOT}/hum/p075/babble.mp3`]);
  });

  it("stop when the part goes away", () => {
    show(<Harness />);
    tap(button("Play Gasp"));
    act(() => root!.unmount());
    root = null;
    expect(sampleLog().map((e) => e.action)).toEqual(["play", "stop"]);
  });

  it("as a bare HearButton: aria-label, the stop square while playing, and Enter or Space by being a button", () => {
    const onHear = vi.fn();
    show(<HearButton label="Gasp" playing={false} state="ok" onHear={onHear} />);
    const b = button("Play Gasp");
    expect(b.tagName).toBe("BUTTON");
    expect(b.type).toBe("button");
    expect(b.querySelector("path")).toBeTruthy();
    tap(b);
    expect(onHear).toHaveBeenCalledTimes(1);
    act(() => root!.render(<HearButton label="Gasp" playing state="ok" onHear={onHear} />));
    expect(button("Stop Gasp").querySelector("rect")).toBeTruthy();
    act(() => root!.render(<HearButton label="Gasp" playing={false} state="behind" onHear={onHear} />));
    tap(button("Play Gasp"));
    expect(onHear).toHaveBeenCalledTimes(1);
  });
});

describe("the voice pitch slider", () => {
  const setValue = (el: HTMLInputElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("plays the voice at the snapped pitch once when it is let go, and nothing during the drag", () => {
    show(<Harness />);
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    act(() => {
      slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setValue(slider, "1.05");
      setValue(slider, "1.1");
      setValue(slider, "1.15");
    });
    expect(plays()).toEqual([]);
    act(() => {
      slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(plays()).toEqual([`${SAMPLE_ROOT}/babble/p115/babble.mp3`]);
    expect(slider.value).toBe("1.15");
  });

  it("plays nothing when a swipe that starts on it scrolls the page instead (the value never moves)", () => {
    show(<Harness />);
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    act(() => {
      slider.dispatchEvent(new Event("touchstart", { bubbles: true }));
      slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
      slider.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(sampleLog()).toEqual([]);
    // a press the browser cancels for a scroll commits nothing, even if the value moved a step first
    act(() => {
      slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      setValue(slider, "1.05");
      slider.dispatchEvent(new Event("pointercancel", { bubbles: true }));
      slider.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    expect(sampleLog()).toEqual([]);
  });

  it("after keys, plays once 300 ms pass with no key", () => {
    vi.useFakeTimers();
    show(<Harness start={{ ...VOICE, style: "hum" }} />);
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    for (const v of ["1.05", "1.1"])
      act(() => {
        slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        setValue(slider, v);
        slider.dispatchEvent(new Event("change", { bubbles: true }));
        vi.advanceTimersByTime(200);
      });
    expect(plays()).toEqual([]);
    act(() => vi.advanceTimersByTime(150));
    expect(plays()).toEqual([`${SAMPLE_ROOT}/hum/p110/babble.mp3`]);
  });

  it("plays nothing under Quiet", () => {
    show(<Harness start={{ ...VOICE, style: "none" }} />);
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    act(() => {
      setValue(slider, "1.3");
      slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(sampleLog()).toEqual([]);
  });
});

describe("a car", () => {
  it("has no voice, no pitch and no noises, and lists its car sounds first", () => {
    show(<Harness kind="car" start={{ style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] }} />);
    expect(host.textContent).toContain("Pip has no voice. Pick its car sounds.");
    expect(host.querySelector("[role=radiogroup]")).toBeNull();
    expect(host.querySelector("input[type=range]")).toBeNull();
    expect(host.textContent).not.toContain("Noises");
    expect(host.textContent).toContain("Car sounds (2 of 8)");
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")).map((b) => b.textContent?.replace(/^[✓+]/, "").trim());
    expect(chips).toEqual(CAR_SFX.map((id) => CATALOG.sfx.find((s) => s.id === id)!.label));
    tap(button("Play Engine"));
    expect(plays()).toEqual([`${SAMPLE_ROOT}/sfx/engine.mp3`]);
  });

  it("opens the other effects under More sounds, sharing the count of 8", () => {
    show(<Harness kind="car" start={{ style: "none", pitch: 1, noises: [], sfx: ["engine", "honk"] }} />);
    const more = button("More sounds");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    tap(more);
    expect(button("Fewer sounds").getAttribute("aria-expanded")).toBe("true");
    tap(chip("Boing"));
    expect(host.textContent).toContain("Car sounds (3 of 8)");
    expect(button("Play Boing")).toBeTruthy();
  });
});

describe("the player with Web Audio", () => {
  class FakeSource {
    buffer: unknown = null;
    onended: (() => void) | null = null;
    started = 0;
    stopped = 0;
    connect() {}
    start() {
      this.started++;
    }
    stop() {
      this.stopped++;
    }
  }
  const sources: FakeSource[] = [];
  let resumed = 0;
  class FakeContext {
    state = "suspended";
    destination = {};
    resume() {
      resumed++;
      return Promise.resolve();
    }
    decodeAudioData(b: ArrayBuffer) {
      return Promise.resolve({ length: b.byteLength });
    }
    createBufferSource() {
      const s = new FakeSource();
      sources.push(s);
      return s;
    }
  }

  beforeEach(() => {
    sources.length = 0;
    resumed = 0;
    vi.stubGlobal("AudioContext", FakeContext);
  });

  it("resumes its context inside the tap, fetches the file once and plays it", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array(800), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    show(<Harness />);
    tap(button("Play Gasp"));
    expect(resumed).toBe(1);
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(sampleUrl({ kind: "noise", id: "gasp", voice: "babble", pitch: 1 }));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.started).toBe(1);
    // It ends by itself: the button shows Play again.
    act(() => sources[0]!.onended?.());
    expect(button("Play Gasp")).toBeTruthy();
    tap(button("Play Gasp"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
    tap(button("Stop Gasp"));
    expect(sources[1]!.stopped).toBe(1);
  });

  it("says when a sound did not load, and a tap tries again", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    show(<Harness />);
    tap(button("Play Honk"));
    await settle();
    expect(host.textContent).toContain("That sound didn't load. Tap again.");
    expect(sampleLog().map((e) => e.action)).toEqual(["play", "error"]);
    expect(button("Play Honk")).toBeTruthy();
    tap(button("Play Honk"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops when the page is hidden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(800))));
    show(<Harness />);
    tap(button("Play Gasp"));
    await settle();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    delete (document as { visibilityState?: unknown }).visibilityState;
    expect(sources[0]!.stopped).toBe(1);
    expect(button("Play Gasp")).toBeTruthy();
    stopSample();
  });
});
