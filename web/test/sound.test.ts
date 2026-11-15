import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyClick, installClickSounds, SoundEngine } from "../src/lib/sound.ts";

function html(markup: string) {
  document.body.innerHTML = markup;
}

describe("classifyClick", () => {
  it("taps for enabled controls, including clicks on their icons", () => {
    html(`<button id="b"><svg><path id="p"/></svg>Go</button><a id="a" href="/x">x</a><div role="tab" id="t">t</div>`);
    expect(classifyClick(document.getElementById("b"))).toBe("tap");
    expect(classifyClick(document.getElementById("p"))).toBe("tap");
    expect(classifyClick(document.getElementById("a"))).toBe("tap");
    expect(classifyClick(document.getElementById("t"))).toBe("tap");
  });

  it("denies for disabled and aria-disabled controls", () => {
    html(`<button id="d" disabled>x</button><button id="ad" aria-disabled="true"><span id="in">x</span></button>
          <fieldset disabled><button id="f">x</button></fieldset>`);
    expect(classifyClick(document.getElementById("d"))).toBe("deny");
    expect(classifyClick(document.getElementById("in"))).toBe("deny");
    expect(classifyClick(document.getElementById("f"))).toBe("deny");
  });

  it("stays silent for text, text fields and opted-out elements", () => {
    html(`<p id="p">hello</p><input id="i" type="text"/><textarea id="ta"></textarea><button id="o" data-sound="off">x</button>`);
    expect(classifyClick(document.getElementById("p"))).toBeNull();
    expect(classifyClick(document.getElementById("i"))).toBeNull();
    expect(classifyClick(document.getElementById("ta"))).toBeNull();
    expect(classifyClick(document.getElementById("o"))).toBeNull();
    expect(classifyClick(null)).toBeNull();
  });
});

describe("installClickSounds", () => {
  let enabled = true;
  let remove: () => void = () => undefined;
  beforeEach(() => {
    window.__cfSoundLog = [];
    enabled = true;
    remove = installClickSounds(new SoundEngine(() => enabled));
  });
  afterEach(() => remove());

  const kinds = () => (window.__cfSoundLog ?? []).map((e) => e.kind);

  it("plays only on click, never on touch or pointer movement or scroll", async () => {
    html(`<button id="b">Go</button>`);
    const b = document.getElementById("b")!;
    for (const type of ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "scroll", "wheel"]) {
      b.dispatchEvent(new Event(type, { bubbles: true }));
    }
    window.dispatchEvent(new Event("scroll"));
    expect(kinds()).toEqual([]);
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(kinds()).toEqual(["tap"]);
  });

  it("hears clicks even when a handler stops propagation", () => {
    html(`<button id="b">Go</button>`);
    const b = document.getElementById("b")!;
    b.addEventListener("click", (e) => e.stopPropagation());
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(kinds()).toEqual(["tap"]);
  });

  it("plays one sound when a label click also clicks its input", async () => {
    html(`<label id="l"><input type="checkbox" id="c"/> On</label>`);
    document.getElementById("l")!.click();
    expect(kinds()).toEqual(["tap"]);
  });

  it("logs muted sounds when the setting is off", async () => {
    enabled = false;
    html(`<button id="b" aria-disabled="true">Go</button>`);
    document.getElementById("b")!.click();
    expect(window.__cfSoundLog).toMatchObject([{ kind: "deny", muted: true }]);
  });
});

describe("SoundEngine audio context", () => {
  afterEach(() => {
    delete (window as { AudioContext?: unknown }).AudioContext;
  });

  it("resumes an iOS 'interrupted' context, not only a suspended one", () => {
    const resume = vi.fn(async () => undefined);
    class FakeContext {
      state = "interrupted";
      currentTime = 0;
      destination = {};
      resume = resume;
      createOscillator() {
        return { type: "", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect() {} }), start() {}, stop() {} };
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect: () => ({ connect() {} }) };
      }
    }
    (window as { AudioContext?: unknown }).AudioContext = FakeContext;
    const engine = new SoundEngine(() => true);
    try {
      engine.play("tap");
    } catch {
      // The fake graph may not cover every node method; only the resume matters here.
    }
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("caps the test sound log", () => {
    window.__cfSoundLog = [];
    const engine = new SoundEngine(() => false);
    for (let i = 0; i < 300; i++) engine.play(i % 2 ? "tap" : "deny");
    expect(window.__cfSoundLog!.length).toBeLessThanOrEqual(200);
  });
});
