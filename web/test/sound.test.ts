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

  it("stays silent for an aria-disabled button that opts out (the newest week's Later week nudge, §20.11)", () => {
    html(`<button id="later" aria-disabled="true" data-sound="off"><svg><path id="g"/></svg></button>`);
    expect(classifyClick(document.getElementById("later"))).toBeNull();
    expect(classifyClick(document.getElementById("g"))).toBeNull();
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

  it("builds the context on the press before a click, silently, so the click itself stays cheap", () => {
    let built = 0;
    const resume = vi.fn(async () => undefined);
    class FakeContext {
      state = "suspended";
      constructor() {
        built++;
      }
      resume = resume;
    }
    (window as { AudioContext?: unknown }).AudioContext = FakeContext;
    window.__cfSoundLog = [];
    let on = false;
    const remove = installClickSounds(new SoundEngine(() => on));
    try {
      html(`<button id="b">Go</button><p id="p">text</p>`);
      const b = document.getElementById("b")!;
      b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(built).toBe(0); // muted: nothing built
      on = true;
      document.getElementById("p")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      b.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(built).toBe(0); // not a press on a control, or not a key that clicks
      b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(built).toBe(1);
      expect(window.__cfSoundLog).toEqual([]); // a press makes no sound
    } finally {
      remove();
    }
  });

  it("caps the test sound log", () => {
    window.__cfSoundLog = [];
    const engine = new SoundEngine(() => false);
    for (let i = 0; i < 300; i++) engine.play(i % 2 ? "tap" : "deny");
    expect(window.__cfSoundLog!.length).toBeLessThanOrEqual(200);
  });
});

describe("SoundEngine plays the chosen recipes", () => {
  // A fake Web Audio graph that records what was scheduled.
  let made: { contexts: number; oscillators: { type: string; from: number }[]; noises: number; buffers: number };
  beforeEach(() => {
    made = { contexts: 0, oscillators: [], noises: 0, buffers: 0 };
    window.__cfSoundLog = [];
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = () => ({ connect: (n: unknown) => n });
    class FakeContext {
      state = "running";
      currentTime = 1;
      sampleRate = 8000;
      destination = {};
      constructor() {
        made.contexts++;
      }
      resume = async () => undefined;
      createGain() {
        return { ...node(), gain: param() };
      }
      createBiquadFilter() {
        return { ...node(), type: "", frequency: param() };
      }
      createOscillator() {
        const freq = { ...param(), from: 0, setValueAtTime(v: number) { freq.from = v; } };
        const osc = { ...node(), type: "", frequency: freq, start() { made.oscillators.push({ type: osc.type, from: freq.from }); }, stop() {} };
        return osc;
      }
      createBufferSource() {
        return { ...node(), buffer: null, start() { made.noises++; }, stop() {} };
      }
      createBuffer(_c: number, length: number) {
        made.buffers++;
        return { getChannelData: () => new Float32Array(length) };
      }
    }
    (window as { AudioContext?: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as { AudioContext?: unknown }).AudioContext;
  });

  it("plays the owner's click and error sounds (defaults 6 and 5) and logs which", () => {
    const engine = new SoundEngine(() => true);
    engine.play("tap");
    // Water drop: two sine voices, 1500 Hz then 2200 Hz.
    expect(made.oscillators).toEqual([
      { type: "sine", from: 1500 },
      { type: "sine", from: 2200 },
    ]);
    made.oscillators = [];
    engine.play("deny");
    // Nope nope nope: three square blips at 150 Hz.
    expect(made.oscillators).toEqual(Array.from({ length: 3 }, () => ({ type: "square", from: 150 })));
    expect(window.__cfSoundLog).toMatchObject([
      { kind: "tap", sound: 6, muted: false },
      { kind: "deny", sound: 5, muted: false },
    ]);
  });

  it("follows the chosen sounds as they change", () => {
    const choice = { tap: 2, deny: 4 };
    const engine = new SoundEngine(() => true, () => choice);
    engine.play("tap");
    expect(made.oscillators).toEqual([{ type: "sine", from: 900 }]); // Soft pop
    choice.tap = 9;
    made.oscillators = [];
    // Well after the first tap (relative to now: the worker may have been running for a while).
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_000);
    engine.play("tap");
    expect(made.oscillators).toEqual([{ type: "sawtooth", from: 660 }]); // Pluck
    expect(window.__cfSoundLog!.map((e) => e.sound)).toEqual([2, 9]);
    vi.restoreAllMocks();
  });

  it("previews any recipe by number, and logs it even when muted (but plays nothing)", () => {
    let on = true;
    const engine = new SoundEngine(() => on);
    engine.play("deny", null, 17); // Tsk tsk: two noise clicks
    expect(made.noises).toBe(2);
    expect(made.oscillators).toEqual([]);
    on = false;
    vi.spyOn(performance, "now").mockReturnValue(20_000);
    engine.play("tap", null, 30);
    vi.restoreAllMocks();
    expect(made.oscillators).toEqual([]);
    expect(window.__cfSoundLog).toMatchObject([
      { kind: "deny", sound: 17, muted: false },
      { kind: "tap", sound: 30, muted: true },
    ]);
  });

  it("shares one audio context and one noise buffer", () => {
    const engine = new SoundEngine(() => true);
    let t = 30_000;
    vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
    engine.play("tap", null, 4); // Wood block: has a noise voice
    engine.play("tap", null, 8); // Key clack: noise too
    engine.play("deny", null, 11); // Clunk: noise too
    vi.restoreAllMocks();
    expect(made.contexts).toBe(1);
    expect(made.buffers).toBe(1);
    expect(made.noises).toBe(3);
  });

  it("an unknown choice falls back to the default", () => {
    const engine = new SoundEngine(() => true, () => ({ tap: 99, deny: 0 }));
    engine.play("tap");
    expect(window.__cfSoundLog![0]!.sound).toBe(6);
  });
});
