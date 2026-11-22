// Lamo Stories kept behind Clip Factory stays quiet, and its motion is its own (docs/CONTRACTS.md §45.34; request 2
// §2 "When I return to Clip Factory, I should see the existing application exactly as I left it", §9 its own
// preferences). While a Clip Factory page is on screen, nothing of Lamo Stories sounds or bursts over it (a cheer
// that waits for a tap is dropped when that tap comes in Clip Factory). On its own pages, every Lamo Stories
// celebration and sliding highlight follows Lamo Stories' own calm-motion switch, so Clip Factory's calm setting
// never stills them once Lamo Stories has its own; Clip Factory's own highlights keep following Clip Factory's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Glide, GlideCalm } from "../src/components/Glide.tsx";
import { setPrefs } from "../src/lib/prefs.ts";
import type { SoundLogEntry } from "../src/lib/sound.ts";
import { cheer as chatCheer } from "../src/stories/chat/kit.tsx";
import { storiesReduceMotion, storiesSound } from "../src/stories/prefs.ts";
import { cheer as settingsCheer } from "../src/stories/settings/bits.tsx";
import { celebrate as studioCelebrate } from "../src/stories/studio/kit.tsx";
import { celebrate, starBurst } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory, setStoriesPref } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const log = (): SoundLogEntry[] => window.__cfSoundLog ?? [];
let clock = 1e7;
const bursts = () => document.querySelectorAll("canvas").length;

/** A 2D context that takes every drawing call (jsdom draws nothing). */
const fakeContext = () => new Proxy({} as Record<string | symbol, unknown>, { get: (t, k) => (k in t ? t[k] : () => undefined), set: (t, k, v) => ((t[k] = v), true) });

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceMemory();
  localStorage.setItem("cf.storiesPreview", "1");
  // Clip Factory's own device choice: calm motion. Lamo Stories' own: motion on.
  setPrefs({ soundEnabled: true, clickSound: 4, errorSound: 6, reduceMotion: true });
  setStoriesPref("motion.reduce", false);
  window.__cfSoundLog = [];
  // The sound engines hear one success per 300 ms: each call here is a moment later than the last.
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => fakeContext() as never);
  history.replaceState(null, "", "/stories/production/S1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  setPrefs({ reduceMotion: false });
  history.replaceState(null, "", "/");
  document.body.innerHTML = "";
});

describe("on a Lamo Stories page, its celebrations follow its own calm-motion switch", () => {
  it("confetti and stars draw although Clip Factory's motion is calm", () => {
    expect(storiesReduceMotion()).toBe(false);
    starBurst(undefined, 120);
    celebrate();
    studioCelebrate(null, 90);
    chatCheer();
    settingsCheer(null);
    expect(bursts()).toBe(5);
    expect(document.querySelectorAll("canvas.confetti").length).toBeGreaterThanOrEqual(4);
  });

  it("its own calm switch stills them (the cheer still plays)", () => {
    setStoriesPref("motion.reduce", true);
    starBurst();
    celebrate();
    studioCelebrate(null);
    expect(bursts()).toBe(0);
    expect(log().filter((e) => e.kind === "success")).toHaveLength(2);
  });
});

describe("while Clip Factory is on screen (Lamo Stories kept behind it)", () => {
  it("no confetti and no cheer", () => {
    history.replaceState(null, "", "/library");
    starBurst(undefined, 140);
    celebrate();
    studioCelebrate(null, 120);
    chatCheer();
    settingsCheer(null);
    storiesSound("success");
    storiesSound("deny");
    expect(bursts()).toBe(0);
    expect(log()).toEqual([]);
  });

  it("a cheer waiting for the owner's tap is dropped when that tap comes in Clip Factory", () => {
    storiesSound("success", { onNextTap: true });
    history.replaceState(null, "", "/jobs");
    document.body.click();
    expect(log()).toEqual([]);
    history.replaceState(null, "", "/stories/review/S1");
    document.body.click();
    expect(log(), "it was used up by the tap in Clip Factory").toEqual([]);
  });

  it("asked for while Clip Factory is on screen, a cheer never waits for a tap at all", () => {
    history.replaceState(null, "", "/jobs");
    storiesSound("success", { onNextTap: true });
    history.replaceState(null, "", "/stories/review/S1");
    document.body.click();
    expect(log()).toEqual([]);
  });

  it("Lamo Stories switched off: nothing is behind anything, sounds play as before", () => {
    localStorage.removeItem("cf.storiesPreview");
    history.replaceState(null, "", "/library");
    storiesSound("success");
    expect(log()).toEqual([expect.objectContaining({ kind: "success" })]);
  });
});

describe("sliding highlights", () => {
  let host: HTMLElement;
  let root: Root;
  let slides: string[];
  beforeEach(() => {
    slides = [];
    // jsdom lays nothing out: each item says where it is, and animate() records the slide.
    const box = (el: HTMLElement, key: "x" | "w", d: number) => Number(el.dataset[key] ?? d);
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
      return this.parentElement;
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return box(this, "x", 0);
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return box(this, "w", 60);
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => 32);
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: HTMLElement) {
      slides.push(this.closest("[data-bar]")!.getAttribute("data-bar")!);
      return { cancel() {}, pending: false, playState: "running", onfinish: null } as unknown as Animation;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  function Bar({ name, on }: { name: string; on: number }) {
    return (
      <div data-bar={name}>
        <Glide active=".is-on" />
        {[0, 1, 2].map((i) => (
          <button key={i} type="button" data-x={String(i * 80)} className={i === on ? "is-on" : ""}>
            {name} {i}
          </button>
        ))}
      </div>
    );
  }
  const Both = ({ on }: { on: number }) => (
    <>
      <Bar name="clips" on={on} />
      <GlideCalm.Provider value={storiesReduceMotion}>
        <Bar name="stories" on={on} />
      </GlideCalm.Provider>
    </>
  );
  const pick = async (on: number) => {
    await act(async () => root.render(<Both on={on} />));
    await act(async () => await Promise.resolve());
  };

  it("Lamo Stories' slide by its own switch; Clip Factory's stays calm by Clip Factory's own", async () => {
    await pick(0);
    await pick(2);
    expect(slides).toEqual(["stories"]);
  });

  it("Lamo Stories' own calm switch stills its slide too", async () => {
    setStoriesPref("motion.reduce", true);
    await pick(0);
    await pick(1);
    expect(slides).toEqual([]);
  });

  it("with Clip Factory's motion on, Clip Factory's highlight slides exactly as before", async () => {
    setPrefs({ reduceMotion: false });
    setStoriesPref("motion.reduce", true);
    await pick(0);
    await pick(1);
    expect(slides).toEqual(["clips"]);
  });
});
