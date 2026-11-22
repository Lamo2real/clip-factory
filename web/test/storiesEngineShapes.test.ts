// The Lamo Stories engine's six video sizes (docs/CONTRACTS.md §45.34, request 2 §6E "Default resolution. Default
// aspect ratio."): 9:16, 1:1 and 16:9, each at 1080 or 720 on its short side. validateScript takes only those six,
// every set, character, prop, bubble, caption and the driving-safety end card is laid out for each shape (positions
// 0..1 of the frame, text inside each shape's safe area), the draw lists are in output pixels of the script's size,
// and a 720 video is the 1080 one scaled down. The sample's 1080 × 1920 frames are exactly what they were before, and
// 9:16 text keeps to the platforms' own safe area (the one the agent's caption writer uses).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/stories/engine/commands.ts";
import {
  CATALOG,
  DEFAULT_FORMAT,
  drawFrame,
  ENGINE_VERSION,
  FORMATS,
  formatOf,
  frameCount,
  normalizeScript,
  sceneFrames,
  sceneList,
  SIZES_FROM_ENGINE,
  sizeFor,
  textTrack,
  validateScript,
} from "../src/stories/engine/engine.ts";
import { LINE_HEIGHT, TEXT_BOXES, textWidth } from "../src/stories/engine/text.ts";
import type { CastMember, CharacterLook, Prim, Scene, SetId, StoryScript, TextEvent, VideoAspect, VideoFormat } from "../src/stories/engine/types.ts";
import { previewHeight } from "../src/stories/preview/StoryPreview.tsx";

const ROOT = join(import.meta.dirname, "../..");
const ENGINE = join(ROOT, "web/src/stories/engine");
const raw = (name: string): StoryScript => JSON.parse(readFileSync(join(ENGINE, "fixtures", name), "utf8")) as StoryScript;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function errorsOf(s: unknown): string[] {
  const r = validateScript(s);
  return r.ok ? [] : r.errors;
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

/** The same script in another size (a script for this engine). */
const sized = (s: StoryScript, f: Pick<VideoFormat, "width" | "height">): StoryScript => ({ ...clone(s), engine: ENGINE_VERSION, width: f.width, height: f.height });

const BIG = FORMATS.filter((f) => Math.min(f.width, f.height) === 1080);
const ASPECTS: VideoAspect[] = ["9:16", "1:1", "16:9"];

// ---- the bounds of prims (output px) -------------------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function primBox(p: Prim, w: number, h: number): Box | null {
  switch (p.k) {
    case "fill":
    case "grad":
      return { x0: 0, y0: 0, x1: w, y1: h };
    case "rect":
      return { x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h };
    case "circle":
      return { x0: p.x - p.r, y0: p.y - p.r, x1: p.x + p.r, y1: p.y + p.r };
    case "ellipse": {
      const r = Math.max(p.rx, p.ry);
      return { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r };
    }
    case "poly":
    case "line": {
      const pad = p.k === "line" ? p.w / 2 : 0;
      const xs = p.pts.filter((_, i) => i % 2 === 0);
      const ys = p.pts.filter((_, i) => i % 2 === 1);
      return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
    }
    default:
      return null;
  }
}

function union(boxes: (Box | null)[]): Box | null {
  let out: Box | null = null;
  for (const b of boxes) if (b) out = out ? { x0: Math.min(out.x0, b.x0), y0: Math.min(out.y0, b.y0), x1: Math.max(out.x1, b.x1), y1: Math.max(out.y1, b.y1) } : { ...b };
  return out;
}

const inside = (b: Box, o: Box, tol = 0) => b.x0 >= o.x0 - tol && b.y0 >= o.y0 - tol && b.x1 <= o.x1 + tol && b.y1 <= o.y1 + tol;
const show = (b: Box | null) => (b ? `${Math.round(b.x0)},${Math.round(b.y0)} to ${Math.round(b.x1)},${Math.round(b.y1)}` : "nothing");

// ---- characters drawn in colours nothing else uses, so their prims can be picked out ---------------------------

const MARKS = ["#0d0e0f", "#e1c2a3", "#a1b2c3", "#3c2b1a", "#2f1e0d", "#5a4b3c"];
const markedLook = (i: number): CharacterLook => ({
  body: (["bean", "round", "tall", "square"] as const)[i % 4]!,
  skin: MARKS[1]!,
  height: 1.15,
  width: 1.15,
  hair: { style: (["spiky", "bun", "curly", "cap"] as const)[i % 4]!, color: MARKS[4]! },
  eyes: { shape: "round", color: "#1c1842" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: MARKS[2]!, bottom: MARKS[3]!, accent: MARKS[5]!, pattern: "plain" },
  accessory: "none",
  outline: MARKS[0]!,
});
const member = (i: number, extra: Partial<CastMember> = {}): CastMember => ({ characterId: `ch${i}`, name: `Kid ${i}`, look: markedLook(i), movementStyle: "calm", voice: { style: "babble", pitch: 1, noises: ["gasp", "yay"], sfx: [] }, ...extra });
const isMarked = (p: Prim) => "color" in p && MARKS.includes(p.color);

const scene = (sceneId: string, p: Partial<Scene>): Scene => ({ sceneId, title: sceneId, durationSec: 3, set: "studio", view: "side", camera: "wide", actors: [], props: [], beats: [], sfx: [], caption: null, note: null, ...p });

function story(scenes: Scene[], f: Pick<VideoFormat, "width" | "height">, extra: Partial<StoryScript> = {}): StoryScript {
  return { engine: ENGINE_VERSION, fps: 30, width: f.width, height: f.height, durationSec: scenes.reduce((a, sc) => a + sc.durationSec, 0), title: "Shapes", seed: 21, cast: { c0: member(0), c1: member(1) }, scenes, music: null, captionsOn: true, captions: [], safety: null, ...extra };
}

/** Where one marked character is drawn at frame f (output px). */
function markedBox(s: StoryScript, f: number): Box | null {
  return union(drawFrame(s, f).filter(isMarked).map((p) => primBox(p, s.width, s.height)));
}

// ---- the six sizes --------------------------------------------------------------------------------------------

describe("the six sizes", () => {
  it("are 9:16, 1:1 and 16:9 at 1080 and 720 on the short side, 9:16 1080 × 1920 first (the default)", () => {
    expect(FORMATS.map((f) => `${f.aspect} ${f.resolution}`)).toEqual(["9:16 1080x1920", "9:16 720x1280", "1:1 1080x1080", "1:1 720x720", "16:9 1920x1080", "16:9 1280x720"]);
    expect(DEFAULT_FORMAT).toBe(FORMATS[0]);
    for (const f of FORMATS) {
      const [a, b] = f.aspect.split(":").map(Number) as [number, number];
      expect(f.width * b, f.resolution).toBe(f.height * a);
      expect(f.resolution).toBe(`${f.width}x${f.height}`);
      expect(f.label.length, f.resolution).toBeGreaterThan(10);
      // the safe area is inside the frame, and a centred band in 1:1 and 16:9
      const s = f.safe;
      expect(0 < s.left && s.left < s.right && s.right < f.width && 0 < s.top && s.top < s.bottom && s.bottom < f.height, f.resolution).toBe(true);
      if (f.aspect !== "9:16") {
        expect(Math.abs(s.left - (f.width - s.right)), f.resolution).toBeLessThanOrEqual(1);
        expect(Math.abs(s.top - (f.height - s.bottom)), f.resolution).toBeLessThanOrEqual(1);
      }
    }
  });

  it("sizeFor gives each shape's size at each resolution, the bigger one by default, and null for a mismatch", () => {
    expect(sizeFor("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(sizeFor("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(sizeFor("16:9")).toEqual({ width: 1920, height: 1080 });
    for (const f of FORMATS) expect(sizeFor(f.aspect, f.resolution)).toEqual({ width: f.width, height: f.height });
    expect(sizeFor("16:9", "1080x1920")).toBeNull();
    expect(sizeFor("1:1", "1280x720")).toBeNull();
    expect(formatOf(1280, 720)?.aspect).toBe("16:9");
    expect(formatOf(1000, 1000)).toBeNull();
  });

  it("validateScript takes every one of the six for a script of this engine, and nothing else", () => {
    for (const name of ["sample-script.json", "ice-skid.json"]) {
      for (const f of FORMATS) expect(errorsOf(sized(raw(name), f)), `${name} ${f.resolution}`).toEqual([]);
      for (const [width, height] of [[1000, 1000], [1080, 1350], [1920, 1920], [720, 1920], ["1080", "1920"]]) {
        const errors = errorsOf({ ...sized(raw(name), DEFAULT_FORMAT), width, height });
        expect(errors.join("\n")).toMatch(/^width × height is .+; use one of 1080 × 1920 or 720 × 1280 \(9:16\), 1080 × 1080 or 720 × 720 \(1:1\), 1920 × 1080 or 1280 × 720 \(16:9\)\.$/m);
      }
    }
  });

  it("a script written before this engine stays tall: it is valid at 1080 × 1920 and says why another size is refused", () => {
    const old = raw("sample-script.json");
    expect(old.engine).toBeLessThan(SIZES_FROM_ENGINE);
    expect(errorsOf(old)).toEqual([]);
    const errors = errorsOf({ ...old, width: 1280, height: 720 });
    expect(errors.join("\n")).toMatch(/a script for engine 1 must be 1080 × 1920 \(vertical 9:16\)\. Scripts for engine 5 and later may also be/);
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(SIZES_FROM_ENGINE);
  });

  it("cli.ts catalog lists them as formats, and cli.ts validate takes a wide script", () => {
    let out = "";
    const files: Record<string, string> = { "wide.json": JSON.stringify(sized(raw("ice-skid.json"), FORMATS[4]!)) };
    const io = { read: (p: string) => files[p] ?? "", write: (t: string) => (out += t), error: () => undefined };
    expect(runCli(["catalog"], io)).toBe(0);
    const cat = JSON.parse(out) as { formats: VideoFormat[] };
    expect(cat.formats).toEqual(FORMATS);
    out = "";
    expect(runCli(["validate", "wide.json"], io)).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true });
  });
});

// ---- draw lists in output pixels ------------------------------------------------------------------------------

/** Two prims are the same, the second `k` times the size of the first (within rounding). */
function sameScaled(a: Prim, b: Prim, k: number): string | null {
  if (a.k !== b.k) return `kind ${a.k} vs ${b.k}`;
  if ("color" in a && "color" in b && a.color !== b.color) return `colour ${a.color} vs ${b.color}`;
  const near = (x: number, y: number, what: string) => (Math.abs(x * k - y) > 0.16 ? `${what} ${x}×${k.toFixed(3)} vs ${y}` : null);
  const aa = "a" in a ? (a.a ?? 1) : 1;
  const ba = "a" in b ? (b.a ?? 1) : 1;
  if (Math.abs(aa - ba) > 0.002) return `alpha ${aa} vs ${ba}`;
  const keys: Record<string, string[]> = { grad: ["x0", "y0", "x1", "y1"], rect: ["x", "y", "w", "h", "r"], circle: ["x", "y", "r"], ellipse: ["x", "y", "rx", "ry"], line: ["w"] };
  for (const key of keys[a.k] ?? []) {
    const bad = near((a as unknown as Record<string, number>)[key]!, (b as unknown as Record<string, number>)[key]!, key);
    if (bad) return bad;
  }
  if (a.k === "ellipse" && b.k === "ellipse" && Math.abs(a.rx - a.ry) > 1) {
    // the turn of a nearly round ellipse does not show; any other turns the same way at every size
    const d = Math.abs(a.rot - b.rot) % 180;
    if (Math.min(d, 180 - d) > 0.25) return `rot ${a.rot} vs ${b.rot}`;
  }
  if ((a.k === "poly" || a.k === "line") && (b.k === "poly" || b.k === "line")) {
    if (a.pts.length !== b.pts.length) return `${a.pts.length} vs ${b.pts.length} points`;
    for (let i = 0; i < a.pts.length; i += 1) {
      const bad = near(a.pts[i]!, b.pts[i]!, `point ${i}`);
      if (bad) return bad;
    }
  }
  return null;
}

describe("draw lists are in output pixels of the script's size", () => {
  for (const f of FORMATS) {
    it(`${f.resolution}: the first prim covers the frame, and every prim is a finite number near the frame`, () => {
      const s = valid(sized(raw("ice-skid.json"), f));
      const margin = 61 * (Math.min(f.width, f.height) / 1080);
      for (const sc of sceneList(s)) {
        for (const at of [sc.from, sc.mid, sc.to - 1]) {
          const prims = drawFrame(s, at);
          expect(["fill", "grad"]).toContain(prims[0]!.k);
          for (const p of prims) {
            const b = primBox(p, f.width, f.height)!;
            // the pen keeps a line that comes within its own width of the margin
            const m = margin + (p.k === "line" ? p.w : 0);
            const frame = { x0: -m, y0: -m, x1: f.width + m, y1: f.height + m };
            expect([b.x0, b.y0, b.x1, b.y1].every(Number.isFinite), `${sc.sceneId} ${at}`).toBe(true);
            // a prim wholly outside the frame and its margin would draw nothing: the pen leaves those out
            expect(b.x1 >= frame.x0 && b.x0 <= frame.x1 && b.y1 >= frame.y0 && b.y0 <= frame.y1, `${sc.sceneId} ${at} ${p.k} ${show(b)}`).toBe(true);
          }
        }
      }
    });
  }

  for (const aspect of ASPECTS) {
    it(`a 720 ${aspect} video is the 1080 one scaled down to two thirds: every prim, line width and radius`, () => {
      const [big, small] = FORMATS.filter((f) => f.aspect === aspect) as [VideoFormat, VideoFormat];
      for (const name of ["ice-skid.json", "sample-script.json"]) {
        const a = valid(sized(raw(name), big));
        const b = valid(sized(raw(name), small));
        expect(frameCount(b)).toBe(frameCount(a));
        for (let fr = 0; fr < frameCount(a); fr += 37) {
          const pa = drawFrame(a, fr);
          const pb = drawFrame(b, fr);
          expect(pb.length, `${name} frame ${fr}`).toBe(pa.length);
          const bad = pa.map((p, i) => sameScaled(p, pb[i]!, 2 / 3)).find((x) => x);
          expect(bad ?? null, `${name} frame ${fr}`).toBeNull();
        }
        const ta = textTrack(a);
        const tb = textTrack(b);
        expect(tb.map((e) => [e.kind, e.text, e.start, e.end])).toEqual(ta.map((e) => [e.kind, e.text, e.start, e.end]));
        tb.forEach((e, i) => {
          for (const k of ["x", "y", "size"] as const) expect(Math.abs(e[k] - ta[i]![k] * (2 / 3)), `${e.kind} ${k}`).toBeLessThan(0.06);
        });
      }
    });
  }

  it("a character is the same size against the short side in every shape (1080 tall in 1:1 and 16:9, wide in 9:16)", () => {
    const heights = BIG.map((f) => {
      const s = valid(story([scene("s1", { set: "park", actors: [{ castId: "c0", x: 0.5, y: 0.74, facing: "right" }] })], f));
      const b = markedBox(s, 45)!;
      return b.y1 - b.y0;
    });
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    // and two thirds of that at 720
    const s = valid(story([scene("s1", { set: "park", actors: [{ castId: "c0", x: 0.5, y: 0.74, facing: "right" }] })], FORMATS[5]!));
    const b = markedBox(s, 45)!;
    expect(Math.abs(b.y1 - b.y0 - heights[0]! * (2 / 3))).toBeLessThan(1);
  });

  it("positions stay 0..1 of the frame: a character stands where its x and y say, in every shape", () => {
    for (const f of FORMATS) {
      for (const [x, y] of [[0.3, 0.7], [0.5, 0.8], [0.7, 0.66]] as [number, number][]) {
        const s = valid(story([scene("s1", { set: "road_day", actors: [{ castId: "c0", x, y, facing: "right" }] })], f));
        const b = markedBox(s, 45)!;
        const k = Math.min(f.width, f.height) / 1080;
        // feet on the ground at y (the shoes and their outline reach a little below it), centred on x
        expect(Math.abs(b.y1 - y * f.height), `${f.resolution} ${x},${y}: ${show(b)}`).toBeLessThan(45 * k);
        expect(Math.abs((b.x0 + b.x1) / 2 - x * f.width), `${f.resolution} ${x},${y}: ${show(b)}`).toBeLessThan(40 * k);
      }
    }
  });

  it("the 1080 × 1920 frames are exactly what this engine drew before (and the other shapes are pinned too)", () => {
    // test/fixtures/stories-engine-shapes.json: the sample's first scene, mid-frame, in each shape. A change to what a
    // frame draws must bump ENGINE_VERSION (engine/README.md) and write this file again (STORIES_GOLDENS=write).
    const goldenPath = join(import.meta.dirname, "fixtures", "stories-engine-shapes.json");
    const now = Object.fromEntries(BIG.map((f) => [f.resolution, drawFrame(valid(sized(raw("sample-script.json"), f)), 45)]));
    const tall = drawFrame(valid(raw("sample-script.json")), 45);
    expect(now["1080x1920"]).toEqual(tall);
    if (process.env.STORIES_GOLDENS === "write") writeFileSync(goldenPath, JSON.stringify({ engine: ENGINE_VERSION, frame: 45, prims: now }) + "\n");
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as { engine: number; frame: number; prims: Record<string, Prim[]> };
    expect(golden.engine, "the drawing changed with ENGINE_VERSION: write the goldens again").toBe(ENGINE_VERSION);
    for (const f of BIG) {
      const want = golden.prims[f.resolution]!;
      const got = now[f.resolution]!;
      expect(got.length, f.resolution).toBe(want.length);
      const bad = want.map((p, i) => sameScaled(p, got[i]!, 1)).find((x) => x);
      expect(bad ?? null, `${f.resolution}: the drawing changed; bump ENGINE_VERSION and write the goldens again`).toBeNull();
    }
  });
});

// ---- every set, every shape -----------------------------------------------------------------------------------

const SETS = CATALOG.sets.map((e) => e.id) as SetId[];

describe("characters are fully in the frame in every set and every shape", () => {
  for (const f of FORMATS) {
    it(`${f.resolution}: side and top views, wide shots of two characters and medium shots of one`, () => {
      const frame = { x0: 0, y0: 0, x1: f.width, y1: f.height };
      const xs = f.aspect === "16:9" ? [0.2, 0.8] : [0.28, 0.72];
      for (const set of SETS) {
        const scenes: Scene[] = [];
        for (const y of [0.64, 0.74, 0.84]) {
          scenes.push(scene(`w${scenes.length}`, { set, actors: xs.map((x, i) => ({ castId: `c${i}`, x, y, facing: i ? "left" : "right" })) }));
          scenes.push(scene(`m${scenes.length}`, { set, camera: "medium", actors: [{ castId: "c0", x: 0.5, y, facing: "right" }] }));
        }
        for (const y of [0.3, 0.6, 0.85]) scenes.push(scene(`t${scenes.length}`, { set, view: "top", actors: [{ castId: "c0", x: 0.4, y, facing: "right" }] }));
        const s = valid(story(scenes, f));
        for (const sc of s.scenes) {
          // apart from the first scene, each one starts in its own frames; each character alone, the other kept out
          const [from, to] = sceneFrames(s, sc.sceneId);
          for (const fr of [from + 15, Math.floor((from + to) / 2), to - 2]) {
            const b = markedBox(s, fr);
            expect(b, `${set} ${sc.sceneId}`).not.toBeNull();
            expect(inside(b!, frame, 0.5), `${f.resolution} ${set} ${sc.sceneId} (${sc.camera}, ${sc.view}) frame ${fr}: ${show(b)}`).toBe(true);
          }
        }
      }
    });
  }

  it("a driver and a passenger are in the frame with their car in every shape", () => {
    for (const f of FORMATS) {
      const frame = { x0: 0, y0: 0, x1: f.width, y1: f.height };
      const scenes = (["side", "top"] as const).map((view) =>
        scene(view, {
          set: "highway",
          view,
          actors: [
            { castId: "c0", x: 0.5, y: 0.72, facing: "right", inCar: "car" },
            { castId: "c1", x: 0.5, y: 0.72, facing: "right", inCar: "car" },
          ],
          props: [{ propId: "car", kind: "car", x: 0.5, y: view === "top" ? 0.55 : 0.74, scale: 1, rot: 0 }],
        }),
      );
      const s = valid(story(scenes, f));
      for (const sc of s.scenes) {
        const [from, to] = sceneFrames(s, sc.sceneId);
        const b = markedBox(s, Math.floor((from + to) / 2));
        expect(b && inside(b, frame), `${f.resolution} ${sc.sceneId}: ${show(b)}`).toBe(true);
      }
    }
  });
});

// ---- text in each shape ---------------------------------------------------------------------------------------

/** The text block with its panel (preview/draw.ts: 0.5 × size to the sides, 0.28 × size above and below). */
function block(e: TextEvent): Box {
  const lines = e.text.split("\n");
  const w = Math.max(...lines.map((l) => textWidth(l, e.size)));
  const h = lines.length * e.size * LINE_HEIGHT;
  const panel = e.kind === "bubble" ? 0 : 1;
  return { x0: e.x - w / 2 - e.size * 0.5 * panel, x1: e.x + w / 2 + e.size * 0.5 * panel, y0: e.y - h / 2 - e.size * 0.28 * panel, y1: e.y + h / 2 + e.size * 0.28 * panel };
}

interface Guidance {
  sources: Record<string, { publisher: string; title: string; url: string }>;
  topics: { id: string; citations: string[] }[];
}
const guidance = JSON.parse(readFileSync(join(ROOT, "stories/config/guidance.json"), "utf8")) as Guidance;

/** A busy safety story: the longest captions and teaching text, bubbles of every kind, the end card. */
function wordy(f: VideoFormat, citations: string[] = ["highway-code", "rospa"].filter((c) => c in guidance.sources)): StoryScript {
  const base = raw("ice-skid.json");
  const long = ["Rear slides right? Steer right, gently, then look where to go", "WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMM WWWW MMMMMMM", "Slow down early on icy roads and leave a big gap ahead of you"];
  const bubbles = CATALOG.bubbles.map((e) => e.id);
  const scenes = base.scenes.map((sc, i) => ({
    ...sc,
    caption: long[i % long.length]!.slice(0, 60),
    beats: [...sc.beats, ...sc.actors.filter((a) => !a.inCar).map((a, j) => ({ at: 0.3 + j * 0.2, dur: 1.4, who: a.castId, do: "nod" as const, bubble: bubbles[(i + j) % bubbles.length]! }))],
  }));
  const s = sized({ ...base, scenes }, f);
  s.captions = s.captions.map((c, i) => ({ ...c, text: long[i % long.length]!.slice(0, 60) }));
  s.safety = { topicId: "skid-recovery", citations: citations.map((id) => guidance.sources[id]).filter((c): c is Guidance["sources"][string] => !!c) };
  return valid(s);
}

/** The safe area of TikTok, Reels and Shorts on a 1080 × 1920 video: what their buttons and text leave free, the
 * numbers the agent's caption writer keeps to (stories/agent ass.py: left 80, right 1080 - 170, top 260, bottom
 * 1920 - 480). Pinned here so 9:16 text is checked against the platforms, not against the engine's own box. */
const PLATFORM_SAFE = { left: 80, top: 260, right: 910, bottom: 1440 };

describe("text stays inside each shape", () => {
  it("the 9:16 safe area is the platforms' own (the one the agent's caption writer uses), scaled for 720 × 1280", () => {
    for (const f of FORMATS.filter((x) => x.aspect === "9:16")) {
      const k = f.width / 1080;
      expect(f.safe, f.resolution).toEqual({ left: Math.round(PLATFORM_SAFE.left * k), top: Math.round(PLATFORM_SAFE.top * k), right: Math.round(PLATFORM_SAFE.right * k), bottom: Math.round(PLATFORM_SAFE.bottom * k) });
    }
  });

  it("1080 × 1920: the agent's caption writer leaves every caption, teaching text and end card where the preview shows it", () => {
    // ass.py keeps a block's centre at x 280..710 and y top + h..bottom - h, h = size × 0.62 × lines; text the engine
    // already placed inside the platforms' area is never moved, so the video shows what the preview shows.
    for (const citations of [undefined, ...guidance.topics.map((t) => t.citations)]) {
      for (const e of textTrack(wordy(DEFAULT_FORMAT, citations)).filter((x) => x.kind !== "bubble")) {
        const h = e.size * 0.62 * e.text.split("\n").length;
        expect(e.x, `${e.kind} "${e.text}"`).toBeGreaterThanOrEqual(PLATFORM_SAFE.left + 200);
        expect(e.x, `${e.kind} "${e.text}"`).toBeLessThanOrEqual(PLATFORM_SAFE.right - 200);
        expect(e.y, `${e.kind} "${e.text}" (${e.size}px)`).toBeGreaterThanOrEqual(PLATFORM_SAFE.top + h);
        expect(e.y, `${e.kind} "${e.text}" (${e.size}px)`).toBeLessThanOrEqual(PLATFORM_SAFE.bottom - h);
      }
    }
  });

  for (const f of FORMATS) {
    it(`${f.resolution}: captions, teaching text and the end card inside the safe area, bubbles inside the frame`, () => {
      const s = wordy(f);
      const safe = { x0: f.safe.left, y0: f.safe.top, x1: f.safe.right, y1: f.safe.bottom };
      const frame = { x0: 0, y0: 0, x1: f.width, y1: f.height };
      const track = textTrack(s);
      expect(new Set(track.map((e) => e.kind))).toEqual(new Set(["caption", "bubble", "endcard"]));
      for (const e of track) {
        const b = block(e);
        if (e.kind === "bubble") expect(inside(b, frame), `${e.text} ${show(b)}`).toBe(true);
        else expect(inside(b, safe, 0.5), `${e.kind} "${e.text}" at ${e.x},${e.y} (${e.size}px): ${show(b)} in ${show(safe)}`).toBe(true);
      }
    });
  }

  for (const aspect of ASPECTS) {
    it(`the ${aspect} end card is inside the safe area for every topic of the checked guidance, every word kept`, () => {
      for (const f of FORMATS.filter((x) => x.aspect === aspect)) {
        const safe = { x0: f.safe.left, y0: f.safe.top, x1: f.safe.right, y1: f.safe.bottom };
        for (const topic of guidance.topics) {
          const card = textTrack(wordy(f, topic.citations)).find((e) => e.kind === "endcard")!;
          expect(card.text.split("\n").pop(), topic.id).toBe("Check your local road rules.");
          expect(inside(block(card), safe, 0.5), `${f.resolution} ${topic.id}: ${show(block(card))}`).toBe(true);
          expect(card.text.split("\n").length).toBeLessThanOrEqual(TEXT_BOXES[aspect].endcard.maxLines);
        }
      }
    });
  }

  for (const f of FORMATS.filter((x) => x.aspect !== "9:16")) {
    it(`${f.resolution}: in the end card's seconds the last shot keeps every head below the card`, () => {
      for (const camera of ["wide", "medium", "close", "push_in"] as const) {
        const base = raw("ice-skid.json");
        const last = base.scenes.length - 1;
        const scenes = base.scenes.map((sc, i) => (i === last ? { ...sc, camera, actors: sc.actors.map((a) => ({ ...a })) } : sc));
        const s = valid(sized({ ...base, scenes, cast: Object.fromEntries(Object.entries(base.cast).map(([id, m], i) => [id, { ...m, look: markedLook(i) }])) }, f));
        const card = textTrack(s).find((e) => e.kind === "endcard")!;
        const cardBottom = block(card).y1;
        for (let t = card.start + 0.05; t < card.end; t += 0.25) {
          // the top of the head is the top of the hair (a pointing hand may reach up behind the card's panel)
          const hair = union(drawFrame(s, Math.floor(t * 30)).filter((p) => "color" in p && p.color === MARKS[4]).map((p) => primBox(p, s.width, s.height)));
          expect(hair, camera).not.toBeNull();
          expect(hair!.y0, `${camera} at ${t.toFixed(2)} s: hair ${show(hair)} under a card reaching ${Math.round(cardBottom)}`).toBeGreaterThanOrEqual(cardBottom - 1);
        }
      }
    });
  }

  it("every bubble in a safety story's last seconds shows below the end card, in every shape", () => {
    for (const f of FORMATS) {
      const s = wordy(f);
      const track = textTrack(s);
      const card = track.find((e) => e.kind === "endcard")!;
      for (const b of track.filter((e) => e.kind === "bubble" && e.end > card.start)) expect(b.y, `${f.resolution} ${b.text}`).toBeGreaterThan(block(card).y1);
    }
  });
});

// ---- the preview ----------------------------------------------------------------------------------------------

describe("the live preview takes the script's shape", () => {
  it("is as tall as its width says for each shape", () => {
    expect(previewHeight(sizeFor("9:16")!, 270)).toBe(480);
    expect(previewHeight(sizeFor("1:1", "720x720")!, 270)).toBe(270);
    expect(previewHeight(sizeFor("16:9", "1280x720")!, 480)).toBe(270);
  });
});
