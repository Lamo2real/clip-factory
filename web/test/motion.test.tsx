import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, ErrorPanel, LinkButton, Segmented, Stepper } from "../src/components/ui.tsx";
import {
  ACT_FADE_MS,
  ACT_FAIL_MS,
  ACT_ICON,
  ACT_KINDS,
  ACT_MS,
  ACT_REWIND_MS,
  ACT_TOKENS,
  nextAct,
  useAction,
  type ActionHandle,
  type ActionKind,
  type ActState,
} from "../src/lib/motion.ts";
import { setPrefs } from "../src/lib/prefs.ts";
import { SoundEngine } from "../src/lib/sound.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let osReduce = false;

beforeEach(() => {
  vi.useFakeTimers();
  osReduce = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce") ? osReduce : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof matchMedia;
  window.__cfSoundLog = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setPrefs({ reduceMotion: false });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const wrap = () => host.querySelector<HTMLElement>(".act")!;
const btn = () => host.querySelector<HTMLButtonElement>("button")!;

describe("nextAct", () => {
  const idle: ActState = { shot: 0, phase: "idle" };

  it("goes idle → play → idle on end", () => {
    const s = nextAct(idle, "play", false);
    expect(s).toEqual({ shot: 1, phase: "play" });
    expect(nextAct(s, "end", false)).toEqual({ shot: 1, phase: "idle" });
  });

  it("a second play mid-play bumps the shot and stays playing", () => {
    expect(nextAct({ shot: 1, phase: "play" }, "play", false)).toEqual({ shot: 2, phase: "play" });
  });

  it("fails from any phase (fail-fade when reduced)", () => {
    for (const phase of ["idle", "play", "fade", "fail", "fail-fade", "rewind"] as const) {
      expect(nextAct({ shot: 3, phase }, "fail", false).phase).toBe("fail");
      expect(nextAct({ shot: 3, phase }, "fail", true).phase).toBe("fail-fade");
    }
  });

  it("rewinds (a fade when reduced), and reduced turns play into fade", () => {
    expect(nextAct(idle, "rewind", false).phase).toBe("rewind");
    expect(nextAct(idle, "rewind", true).phase).toBe("fade");
    expect(nextAct(idle, "play", true).phase).toBe("fade");
  });
});

describe("tokens", () => {
  it("ACT_TOKENS match styles/motion.css and every duration sits in 180..760 ms", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/styles/motion.css"), "utf8");
    const rootBlock = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
    const found = Object.fromEntries([...rootBlock.matchAll(/(--act-[a-z]+):\s*(\d+)ms/g)].map((m) => [m[1], Number(m[2])]));
    expect(found).toEqual(ACT_TOKENS);
    for (const k of ACT_KINDS) {
      expect(ACT_MS[k]).toBeGreaterThanOrEqual(180);
      expect(ACT_MS[k]).toBeLessThanOrEqual(760);
    }
  });

  it("every kind has its own rules in motion.css", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/styles/motion.css"), "utf8");
    for (const k of ACT_KINDS) expect(css, k).toContain(`.act--${k}`);
  });
});

let handle: ActionHandle;
function Probe({ kind }: { kind: ActionKind }) {
  handle = useAction(kind);
  return <span className={`act is-${handle.phase}`} data-shot={handle.shot} />;
}

describe("useAction", () => {
  it("returns to idle after ACT_MS[kind]", () => {
    act(() => root.render(<Probe kind="keep" />));
    act(() => handle.play());
    expect(wrap().className).toBe("act is-play");
    act(() => vi.advanceTimersByTime(ACT_MS.keep - 1));
    expect(wrap().className).toBe("act is-play");
    act(() => vi.advanceTimersByTime(1));
    expect(wrap().className).toBe("act is-idle");
  });

  it("reads reduced motion at each play (setting and OS)", () => {
    act(() => root.render(<Probe kind="add" />));
    act(() => handle.play());
    expect(handle.phase).toBe("play");
    setPrefs({ reduceMotion: true });
    act(() => handle.play());
    expect(handle.phase).toBe("fade");
    act(() => vi.advanceTimersByTime(ACT_FADE_MS));
    expect(handle.phase).toBe("idle");
    setPrefs({ reduceMotion: false });
    osReduce = true;
    act(() => handle.play());
    expect(handle.phase).toBe("fade");
  });

  it("fail shakes for ACT_FAIL_MS with one deny sound; { sound: false } is silent", () => {
    act(() => root.render(<Probe kind="save" />));
    act(() => handle.play());
    act(() => handle.fail());
    expect(handle.phase).toBe("fail");
    expect(window.__cfSoundLog!.map((e) => e.kind)).toEqual(["deny"]);
    act(() => vi.advanceTimersByTime(ACT_FAIL_MS));
    expect(handle.phase).toBe("idle");
    vi.advanceTimersByTime(1000);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 10_000);
    act(() => handle.fail({ sound: false }));
    expect(window.__cfSoundLog!.map((e) => e.kind)).toEqual(["deny"]);
  });

  it("rewinds for ACT_REWIND_MS", () => {
    act(() => root.render(<Probe kind="stop" />));
    act(() => handle.rewind());
    expect(handle.phase).toBe("rewind");
    act(() => vi.advanceTimersByTime(ACT_REWIND_MS));
    expect(handle.phase).toBe("idle");
  });

  it("clears its timer on unmount", () => {
    act(() => root.render(<Probe kind="refresh" />));
    act(() => handle.play());
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(<span />));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only one timer runs however often it is played", () => {
    act(() => root.render(<Probe kind="copy" />));
    for (let i = 0; i < 5; i++) act(() => handle.play());
    expect(vi.getTimerCount()).toBe(1);
    expect(handle.shot).toBe(5);
  });
});

describe("Button with act", () => {
  it("calls onClick once, before the motion plays, and marks the button", () => {
    const order: string[] = [];
    const onClick = vi.fn(() => {
      order.push(`click:${wrap().className}`);
    });
    act(() => root.render(<Button act="keep" onClick={onClick}>Keep</Button>));
    expect(btn().dataset.act).toBe("keep");
    expect(wrap().className).toBe("act act--keep is-idle");
    act(() => btn().click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["click:act act--keep is-idle"]);
    expect(wrap().className).toBe("act act--keep is-play");
  });

  it("plays a handle from useAction after the handler (spy on play)", () => {
    const order: string[] = [];
    function Demo() {
      const h = useAction("send");
      const spied = { ...h, play: () => (order.push("play"), h.play()) };
      return (
        <Button act={spied} onClick={() => order.push("click")}>
          Make clips
        </Button>
      );
    }
    act(() => root.render(<Demo />));
    act(() => btn().click());
    expect(order).toEqual(["click", "play"]);
    expect(wrap().className).toBe("act act--send is-play");
    expect(host.querySelector(".act__trail")).not.toBeNull();
    // The default send glyph is the paper plane.
    expect(host.querySelector(".act svg.paper-plane")).not.toBeNull();
  });

  it("does not play when aria-disabled or loading", () => {
    const onClick = vi.fn();
    act(() => root.render(<Button act="add" disabled onClick={onClick}>Add</Button>));
    act(() => btn().click());
    expect(onClick).not.toHaveBeenCalled();
    expect(wrap().className).toContain("is-idle");
    act(() => root.render(<Button act="add" loading onClick={onClick}>Add</Button>));
    act(() => btn().click());
    expect(onClick).not.toHaveBeenCalled();
    expect(host.querySelector(".spinner")).not.toBeNull();
  });

  it("a rejecting handler ends in is-fail, and so does one resolving to false", async () => {
    // Well clear of any deny an earlier test played on the shared engine.
    vi.spyOn(performance, "now").mockReturnValue(1e9);
    act(() => root.render(<Button act="save" onClick={() => Promise.reject(new Error("no"))}>Save</Button>));
    await act(async () => btn().click());
    expect(wrap().className).toBe("act act--save is-fail");
    expect(window.__cfSoundLog!.filter((e) => e.kind === "deny")).toHaveLength(1);
    expect(window.__cfSoundLog!.some((e) => e.kind === "success")).toBe(false);
    act(() => root.render(<Button act="tick" onClick={async () => false}>Done</Button>));
    await act(async () => btn().click());
    expect(wrap().className).toBe("act act--tick is-fail");
  });

  it("a handler resolving to anything else keeps playing", async () => {
    act(() => root.render(<Button act="upload" onClick={async () => undefined}>Upload</Button>));
    await act(async () => btn().click());
    expect(wrap().className).toBe("act act--upload is-play");
  });

  it("renders the kind's default glyph when there is no icon, and its own icon when there is; aria-hidden", () => {
    act(() => root.render(<Button act="delete">Delete</Button>));
    expect(ACT_ICON.delete).toBe("trash");
    expect(wrap().getAttribute("aria-hidden")).toBe("true");
    expect(wrap().querySelector("svg")).not.toBeNull();
    expect(btn().textContent).toBe("Delete");
    const trash = wrap().innerHTML;
    act(() => root.render(<Button act="delete" icon="x">Delete</Button>));
    expect(wrap().innerHTML).not.toBe(trash);
  });

  it("keeps the spinner back until the motion is over", () => {
    function Demo({ loading }: { loading: boolean }) {
      return (
        <Button act="refresh" loading={loading}>
          Refresh
        </Button>
      );
    }
    act(() => root.render(<Demo loading={false} />));
    act(() => btn().click());
    act(() => root.render(<Demo loading />));
    expect(host.querySelector(".spinner")).toBeNull();
    expect(wrap().className).toContain("is-play");
    act(() => vi.advanceTimersByTime(ACT_MS.refresh));
    expect(host.querySelector(".spinner")).not.toBeNull();
  });

  it("restarts with a fresh glyph on a second tap", () => {
    act(() => root.render(<Button act="add">Add</Button>));
    act(() => btn().click());
    const first = host.querySelector(".act__item");
    act(() => btn().click());
    expect(host.querySelector(".act__item")).not.toBe(first);
    expect(host.querySelectorAll(".act__item")).toHaveLength(1);
  });

  it("plays the reduced fade with the setting on", () => {
    setPrefs({ reduceMotion: true });
    act(() => root.render(<Button act="throw">Throw away</Button>));
    act(() => btn().click());
    expect(wrap().className).toBe("act act--throw is-fade");
  });

  it("a handler that fails its own handle in the click is not played over (a refused Keep only shakes)", () => {
    function Demo() {
      const h = useAction("keep");
      return (
        <Button act={h} onClick={() => h.fail({ sound: false })}>
          Keep
        </Button>
      );
    }
    act(() => root.render(<Demo />));
    act(() => btn().click());
    expect(wrap().className).toBe("act act--keep is-fail");
  });

  it("playOnClick={false} shows the glyph but leaves the play to the screen; a rejection still fails", async () => {
    let h!: ActionHandle;
    let fails = false;
    function Demo() {
      h = useAction("upload");
      return (
        <Button act={h} playOnClick={false} onClick={() => (fails ? Promise.reject(new Error("no")) : undefined)}>
          Upload
        </Button>
      );
    }
    act(() => root.render(<Demo />));
    act(() => btn().click());
    expect(btn().dataset.act).toBe("upload");
    expect(wrap().className).toBe("act act--upload is-idle");
    act(() => h.play());
    expect(wrap().className).toBe("act act--upload is-play");
    fails = true;
    await act(async () => btn().click());
    expect(wrap().className).toBe("act act--upload is-fail");
  });

  it("without act, nothing changes", () => {
    act(() => root.render(<Button icon="plus">Add</Button>));
    expect(host.querySelector(".act")).toBeNull();
    expect(btn().dataset.act).toBeUndefined();
  });

  it("LinkButton plays after its own click", () => {
    const onClick = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    act(() => root.render(<LinkButton href="https://example.invalid/x" act="download" onClick={onClick}>Download</LinkButton>));
    act(() => host.querySelector("a")!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(wrap().className).toBe("act act--download is-play");
  });
});

describe("CORE mappings in ui.tsx", () => {
  it("Stepper: More plays add and bumps the number up; Fewer plays remove", () => {
    function Demo() {
      const [n, setN] = useStateN();
      return <Stepper value={n} min={1} max={3} onChange={setN} label="Clips" />;
    }
    act(() => root.render(<Demo />));
    const [fewer, more] = Array.from(host.querySelectorAll<HTMLButtonElement>(".stepper__btn"));
    expect(more!.dataset.act).toBe("add");
    act(() => more!.click());
    expect(host.querySelector(".stepper__value")!.textContent).toBe("3");
    expect(more!.querySelector(".act")!.className).toBe("act act--add is-play");
    expect(host.querySelector(".stepper__num")!.className).toBe("stepper__num is-up");
    // At the top: switched off, no motion.
    act(() => vi.advanceTimersByTime(ACT_MS.add));
    act(() => more!.click());
    expect(more!.querySelector(".act")!.className).toContain("is-idle");
    act(() => fewer!.click());
    expect(fewer!.querySelector(".act")!.className).toBe("act act--remove is-play");
    expect(host.querySelector(".stepper__num")!.className).toBe("stepper__num is-down");
  });

  it("Segmented bumps the chosen label, which stays readable", () => {
    function Demo() {
      const [v, setV] = useStateV();
      return <Segmented value={v} onChange={setV} label="Pick" options={[{ value: "a", label: "First" }, { value: "b", label: "Second" }]} />;
    }
    act(() => root.render(<Demo />));
    const radios = host.querySelectorAll<HTMLInputElement>("input");
    act(() => radios[1]!.click());
    const on = host.querySelector(".segmented__opt.is-on .act")!;
    expect(on.className).toBe("act act--toggle act--text is-play");
    expect(on.getAttribute("aria-hidden")).toBeNull();
    expect(on.textContent).toBe("Second");
  });

  it("ErrorPanel's Try again is a retry", () => {
    act(() => root.render(<ErrorPanel message="Oops" onRetry={() => undefined} />));
    expect(btn().dataset.act).toBe("retry");
  });
});

describe("SoundEngine de-duplication (§20.8)", () => {
  it("hears a deny once within 300 ms, but taps and previews as before", () => {
    const engine = new SoundEngine(() => false);
    let t = 50_000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    engine.play("deny");
    t += 200;
    engine.play("deny");
    t += 200;
    engine.play("deny");
    t += 100;
    engine.play("tap");
    t += 100;
    engine.play("tap");
    t += 100;
    engine.play("deny", null, 3);
    t += 100;
    engine.play("deny", null, 4);
    expect(window.__cfSoundLog!.map((e) => e.kind)).toEqual(["deny", "deny", "tap", "tap", "deny", "deny"]);
  });
});

// Small state helpers for the demos above.
function useStateN() {
  return useState(2);
}
function useStateV() {
  return useState<"a" | "b">("a");
}

describe("toggle on a Button", () => {
  it("bumps the label, which stays readable", () => {
    act(() => root.render(<Button act="toggle" icon="phone">iPhone</Button>));
    act(() => btn().click());
    const label = host.querySelector(".btn__label")!;
    expect(label.className).toBe("btn__label act act--toggle act--text is-play");
    expect(label.getAttribute("aria-hidden")).toBeNull();
    expect(host.querySelectorAll(".act")).toHaveLength(1);
  });
});
