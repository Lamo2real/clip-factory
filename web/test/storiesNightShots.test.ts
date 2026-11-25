// The night drive's places, shots and finish (docs/CONTRACTS.md §45.45 §4.2, §4.5, §7, §8): the highway at night and
// the night road's new recipe, every other place through its light, the lamps' warm pulse, the vignette, and the
// shots inside a scene (the driver's eyes, the face up close, the side window, the mirror, the speed dial, the pedals,
// behind the car and down the road). Every shot fills the frame in every shape, stays light enough to draw, is the
// same every time, keeps the face and the bubbles where they belong, and never touches the sound. A script without
// `art` and without cuts draws exactly as before.
import { describe, expect, it } from "vitest";
import { grade, LIGHTS, ND, softRings } from "../src/stories/engine/art.ts";
import { shotCamera } from "../src/stories/engine/camera.ts";
import { CAR_VIEW_SHAPES } from "../src/stories/engine/car.ts";
import { PRESET } from "../src/stories/engine/carDetail.ts";
import { audioTrack, CATALOG, drawFrame, ENGINE_VERSION, FORMATS, normalizeScript, textTrack, validateScript } from "../src/stories/engine/engine.ts";
import { F, inFrame } from "../src/stories/engine/frame.ts";
import { ellipsePts, keyhole, lampWarm, lightFor } from "../src/stories/engine/light.ts";
import { ditherSeed } from "../src/stories/engine/pen.ts";
import { prepare } from "../src/stories/engine/scene.ts";
import { NIGHT_SKY, SET_SHAPES_ND, setInfo } from "../src/stories/engine/sets.ts";
import { nextCutAfter, SHOT_SHAPES, shotAt } from "../src/stories/engine/shots.ts";
import type { CameraId, CarDetail, CarMember, CastMember, CharacterLook, Prim, Scene, SetId, ShotCue, ShotId, StoryScript, VideoFormat } from "../src/stories/engine/types.ts";

// ---- our own test characters (marked colours nothing else uses, so their prims can be picked out) ---------------

const HAIR = "#3c2a1b";
const SKIN = "#e1c2a4";
const look = (extra: Partial<CharacterLook> = {}): CharacterLook => ({
  body: "tall",
  skin: SKIN,
  height: 1,
  width: 1,
  hair: { style: "curly", color: HAIR },
  eyes: { shape: "round", color: "#1c1842" },
  brows: "thick",
  nose: "button",
  mouth: "wide",
  outfit: { top: "#b5402f", bottom: "#2e3d5c", accent: "#6f4e37", pattern: "plain" },
  accessory: "none",
  outline: "#1c1842",
  ...extra,
});
const member = (id: string, l: CharacterLook = look()): CastMember => ({ characterId: id, name: id, look: l, movementStyle: "calm", voice: { style: "babble", pitch: 1, noises: ["gasp", "hmm"], sfx: [] } });
const ownCar: CarMember = {
  characterId: "car-k1",
  name: "Rusty",
  car: { body: "estate", length: 1, height: 1, paint: "#a39a6b", accent: "#e6e2d8", pattern: "plain", windows: "tinted", wheels: { style: "alloy", rim: "#c9ced8", size: 1 }, lights: { front: "square", rear: "bar" }, extra: "none", face: { eyes: "none", color: "#1c1842", mouth: "none" }, outline: "#1c1842" },
  movementStyle: "calm",
  voice: { style: "none", pitch: 1, noises: [], sfx: [] },
  expressions: ["neutral"],
};

const ROADS = CATALOG.sets.map((e) => e.id).filter((id) => setInfo(id).road);
const SHOTS = CATALOG.shots.map((e) => e.id).filter((id): id is Exclude<ShotId, "scene"> => id !== "scene");

/** A drive: c1 drives the cast's car with two plain cars and a truck about, and the scene cuts to `cuts`. */
function drive(set: SetId, cuts: ShotCue[], extra: Partial<Scene> = {}): Scene {
  return {
    sceneId: "s1",
    title: "Drive",
    durationSec: 6,
    set,
    view: "side",
    camera: "wide",
    actors: [{ castId: "c1", x: 0.4, y: 0.78, facing: "right", inCar: "car1" }],
    props: [
      { propId: "car1", kind: "car", x: 0.4, y: 0.78, scale: 1, rot: 0, castId: "k1" },
      { propId: "car2", kind: "car", x: 0.7, y: 0.66, scale: 0.9, rot: 0 },
      { propId: "car3", kind: "car", x: 0.18, y: 0.79, scale: 0.9, rot: 0 },
      { propId: "truck1", kind: "truck", x: 0.9, y: 0.79, scale: 0.9, rot: 0 },
    ],
    beats: [
      { at: 0.2, dur: 1, who: "c1", do: "drive", face: "worried" },
      { at: 1.4, dur: 1, who: "car1", do: "speed_up" },
      { at: 2.6, dur: 1, who: "c1", do: "brake", face: "angry" },
      { at: 3.8, dur: 1, who: "car3", do: "blink" },
      { at: 4.6, dur: 0.8, who: "c1", do: "look_right", face: "surprised" },
    ],
    sfx: [],
    caption: null,
    note: null,
    cuts,
    ...extra,
  };
}

function story(scenes: Scene[], f: Pick<VideoFormat, "width" | "height"> = FORMATS[0]!, extra: Partial<StoryScript> = {}): StoryScript {
  return { engine: ENGINE_VERSION, fps: 30, width: f.width, height: f.height, durationSec: scenes.reduce((a, s) => a + s.durationSec, 0), title: "Night", seed: 9, cast: { c1: member("c1") }, cars: { k1: ownCar }, scenes, music: null, captionsOn: true, captions: [], safety: null, art: "night_drive", ...extra };
}

function valid(s: unknown): StoryScript {
  const r = validateScript(s);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return normalizeScript(r.script);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function primBox(p: Prim): Box | null {
  switch (p.k) {
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

/** Where prims of these colours are drawn (output px). */
const colourBox = (prims: Prim[], colours: string[]): Box | null => union(prims.filter((p) => "color" in p && colours.includes(p.color)).map(primBox));

/** The face: the box of the biggest skin-coloured shape (the head; the ears and hands are smaller). */
function faceBox(prims: Prim[]): Box {
  let best: Box | null = null;
  let area = 0;
  for (const p of prims) {
    if (!("color" in p) || p.color !== SKIN) continue;
    const b = primBox(p);
    if (b && (b.x1 - b.x0) * (b.y1 - b.y0) > area) {
      area = (b.x1 - b.x0) * (b.y1 - b.y0);
      best = b;
    }
  }
  if (!best) throw new Error("no face drawn");
  return best;
}

/** The winding number of a closed polygon round a point. */
function winding(pts: number[], x: number, y: number): number {
  let w = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i += 1) {
    const ax = pts[i * 2]!;
    const ay = pts[i * 2 + 1]!;
    const bx = pts[((i + 1) % n) * 2]!;
    const by = pts[((i + 1) % n) * 2 + 1]!;
    if (ay <= y && by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) w += 1;
    else if (ay > y && by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) w -= 1;
  }
  return w;
}

/** How much of its colour a glow prim lays on the point (x, y), before its alpha: the fade at the point's distance
 * from the centre in radii, linear between stops, the end stops' values past them and nothing past the edge (the
 * semantics of engine/README.md that draw.ts and raster.py share). */
function glowAt(p: Extract<Prim, { k: "glow" }>, x: number, y: number): number {
  const r = (p.rot * Math.PI) / 180;
  const dx = x - p.x;
  const dy = y - p.y;
  const u = (dx * Math.cos(r) + dy * Math.sin(r)) / p.rx;
  const v = (dy * Math.cos(r) - dx * Math.sin(r)) / p.ry;
  const d = Math.hypot(u, v);
  if (d >= 1) return 0;
  const f = p.fade;
  if (d <= f[0]![0]) return f[0]![1];
  for (let i = 1; i < f.length; i += 1) {
    const [o1, a1] = f[i]!;
    const [o0, a0] = f[i - 1]!;
    if (d <= o1) return o1 > o0 ? a0 + ((a1 - a0) * (d - o0)) / (o1 - o0) : a1;
  }
  return f.at(-1)![1];
}

function finite(prims: Prim[], w: number, h: number): string[] {
  const bad: string[] = [];
  prims.forEach((p, i) => {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "number" && !Number.isFinite(v)) bad.push(`${i} ${p.k}.${k}`);
      if (Array.isArray(v) && k === "pts" && (v as number[]).some((n) => !Number.isFinite(n) || Math.abs(n) > 20 * Math.max(w, h))) bad.push(`${i} ${p.k}.pts`);
    }
  });
  return bad;
}

// ---- which shot shows when --------------------------------------------------------------------------------------

describe("cuts between shots inside a scene", () => {
  const sc = { durationSec: 6, cuts: [{ at: 3, shot: "face" as const }, { at: 1, shot: "driver_view" as const }] };

  it("show the whole scene before the first cut, then each cut's shot until the next cut or the scene's end", () => {
    expect(shotAt(sc, 0.5)).toEqual({ cue: { at: 0, shot: "scene" }, from: 0, until: 1 });
    expect(shotAt(sc, 1)).toEqual({ cue: { at: 1, shot: "driver_view" }, from: 1, until: 3 });
    expect(shotAt(sc, 2.99).cue.shot).toBe("driver_view");
    expect(shotAt(sc, 5.9)).toEqual({ cue: { at: 3, shot: "face" }, from: 3, until: 6 });
    expect(shotAt({ durationSec: 4 }, 2)).toEqual({ cue: { at: 0, shot: "scene" }, from: 0, until: 4 });
    expect(nextCutAfter(sc, 0)).toBe(1);
    expect(nextCutAfter(sc, 1)).toBe(3);
    expect(nextCutAfter(sc, 3)).toBe(Infinity);
  });

  it("the action and the sound go on across cuts: the audio track and the captions are the same with and without them", () => {
    const cuts: ShotCue[] = [
      { at: 1, shot: "driver_view" },
      { at: 2.2, shot: "face" },
      { at: 3.4, shot: "speed_dial" },
      { at: 4.6, shot: "road_wide" },
    ];
    const s = valid(story([drive("highway_night", cuts)], FORMATS[0]!, { captions: [{ id: "c", at: 0.5, dur: 4, text: "Keep a safe gap" }] }));
    const none = clone(s);
    delete none.scenes[0]!.cuts;
    expect(audioTrack(s)).toEqual(audioTrack(none));
    expect(textTrack(s).filter((e) => e.kind !== "bubble")).toEqual(textTrack(none).filter((e) => e.kind !== "bubble"));
  });

  it("a shot that cannot show draws the whole scene (once the cut's settle is over)", () => {
    const s = story([{ ...drive("kitchen", [{ at: 1, shot: "driver_view" }]) }]);
    const none = clone(s);
    delete none.scenes[0]!.cuts;
    for (const f of [45, 90, 150]) expect(drawFrame(s, f)).toEqual(drawFrame(none, f));
  });
});

// ---- the places -------------------------------------------------------------------------------------------------

describe("the places in night drive", () => {
  const still = (set: SetId, view: "side" | "top", art?: StoryScript["art"]): StoryScript => {
    const s = story([{ ...drive(set, []), view, actors: [{ castId: "c1", x: 0.3, y: 0.78, facing: "right" }], props: [], beats: [] }], FORMATS[0]!, art ? { art } : {});
    if (!art) delete s.art;
    delete s.scenes[0]!.cuts;
    return s;
  };

  it("every place without art draws exactly as with art classic, in both views", () => {
    for (const e of CATALOG.sets) {
      for (const view of ["side", "top"] as const) {
        for (const f of [0, 40]) expect(drawFrame(still(e.id, view), f), `${e.id} ${view}`).toEqual(drawFrame(still(e.id, view, "classic"), f));
      }
    }
  });

  it("the highway at night is an outdoor night road with the engine's hum, drawn with the night sky in both styles", () => {
    expect(setInfo("highway_night")).toEqual({ outdoor: true, night: true, weather: null, road: true, loop: { sfx: "engine", volume: 0.16 } });
    for (const art of ["night_drive", "classic"] as const) {
      const first = drawFrame(still("highway_night", "side", art), 0)[0]!;
      expect(first.k === "grad" && first.stops, art).toEqual(NIGHT_SKY);
    }
  });

  it("the night road gets the night recipe in night drive and stays as it was in Bright", () => {
    const nd = drawFrame(still("road_night", "side", "night_drive"), 0)[0]!;
    const bright = drawFrame(still("road_night", "side", "classic"), 0)[0]!;
    expect(nd.k === "grad" && nd.stops).toEqual(NIGHT_SKY);
    expect(bright.k === "grad" && bright.stops).toEqual([
      [0, "#0d0b2a"],
      [1, "#2a2466"],
    ]);
  });

  it("every other place keeps its own colours, through the light it stands in", () => {
    const sky = drawFrame(still("road_day", "side", "night_drive"), 0)[0]!;
    expect(sky.k === "grad" && sky.stops).toEqual([
      [0, grade("#4fb3ff", LIGHTS.day)],
      [1, grade("#c9ecff", LIGHTS.day)],
    ]);
    const wall = drawFrame(still("kitchen", "side", "night_drive"), 0)[0]!;
    expect(wall).toEqual({ k: "fill", color: grade("#fff1d6", LIGHTS.indoor) });
    // the studio's light changes nothing: its backdrop is Bright's, only dithered with the story's seed (§45.45.23)
    const studio = still("studio", "side", "night_drive");
    const stage = drawFrame(studio, 0)[0]!;
    expect(stage.k === "grad" && stage.dither).toBe(ditherSeed(studio.seed));
    const { dither: _seed, ...colours } = stage as Extract<Prim, { k: "grad" }>;
    expect(colours).toEqual(drawFrame(still("studio", "side", "classic"), 0)[0]);
    expect("dither" in drawFrame(still("studio", "side", "classic"), 0)[0]!).toBe(false);
  });

  it("each place draws within its measured shapes (SET_SHAPES_ND), the vignette too, in every view, camera and size", () => {
    for (const f of FORMATS) {
      for (const e of CATALOG.sets) {
        for (const view of ["side", "top"] as const) {
          for (const camera of ["wide", "close", "pan_left", "shake"] as CameraId[]) {
            const s = story([{ ...drive(e.id, []), view, camera, actors: [], props: [], beats: [] }], f);
            delete s.scenes[0]!.cuts;
            for (const fr of [0, 40, 80]) expect(drawFrame(s, fr).length, `${f.resolution} ${e.id} ${view} ${camera}`).toBeLessThanOrEqual(SET_SHAPES_ND[e.id]);
          }
        }
      }
    }
  });
});

// ---- light and the finish ---------------------------------------------------------------------------------------

describe("the light and the finish", () => {
  it("each part stands in its place's light (§4.2)", () => {
    expect(lightFor("highway_night", "out", 0.5)).toMatchObject({ ambient: LIGHTS.night.ambient, warm: 0.5, rimA: 0.525, night: true });
    expect(lightFor("road_night", "cabin", 0)).toMatchObject({ ambient: LIGHTS.cabin.ambient, dark: 0.16, night: true });
    expect(lightFor("road_day", "out", 0)).toEqual(LIGHTS.day);
    expect(lightFor("park", "out", 0)).toEqual(LIGHTS.day);
    expect(lightFor("road_day", "cabin", 0)).toEqual({ ...LIGHTS.day, dark: 0.1 });
    for (const set of ["kitchen", "living_room", "office"] as const) expect(lightFor(set, "out", 0)).toEqual(LIGHTS.indoor);
    expect(lightFor("studio", "out", 0)).toEqual(LIGHTS.studio);
  });

  it("the street lamps pulse with the road: a lamp every 40 m (2160 px), steady when nothing drives, none by day", () => {
    expect(lampWarm("highway_night", 0, true)).toBe(1);
    expect(lampWarm("highway_night", 2160, true)).toBeCloseTo(1, 9);
    expect(lampWarm("highway_night", 1080, true)).toBe(0);
    expect(lampWarm("highway_night", -2160, true)).toBeCloseTo(1, 9);
    expect(lampWarm("road_night", 270, true)).toBeCloseTo(Math.cos(Math.PI / 4) ** 4, 9);
    expect(lampWarm("road_night", 540, true)).toBeCloseTo(0, 9);
    expect(lampWarm("road_night", 777, false)).toBe(0.35);
    expect(lampWarm("road_day", 0, true)).toBe(0);
  });

  it("a keyhole polygon leaves its hole empty (non-zero winding), however its hole is wound", () => {
    const hole = ellipsePts(540, 960, 540 * 1.06, 960 * 1.0);
    for (const h of [hole, [...hole].map((_, i, a) => a[a.length - 2 - (i - (i % 2)) + (i % 2)]!)]) {
      const ring = keyhole(-4, -4, 1084, 1924, h);
      expect(winding(ring, 540, 960)).toBe(0);
      expect(Math.abs(winding(ring, 10, 10))).toBe(1);
    }
  });

  it("the vignette darkens the corners and leaves the middle of the frame alone, in night drive only", () => {
    const s = valid(story([drive("highway_night", [])]));
    const isVignette = (p: Prim) => p.k === "glow" && p.color === ND.vignette;
    const nd = drawFrame(s, 30);
    // a soft dark glow in each corner, a true gradient (the glow prim), so no ring or step shows on the flat night sky:
    // every corner is darkened about the same, top and bottom, the middle and the middle of each edge not at all
    const glows = nd.filter(isVignette) as Extract<Prim, { k: "glow" }>[];
    expect(glows.length).toBe(4);
    const dark = (x: number, y: number, ps = glows): number => 1 - ps.reduce((k, p) => k * (1 - (p.a ?? 1) * glowAt(p, x, y)), 1);
    for (const [x, y] of [
      [3, 3],
      [1077, 3],
      [3, 1917],
      [1077, 1917],
    ])
      expect(dark(x!, y!), `${x},${y}`).toBeGreaterThan(0.17);
    expect(Math.abs(dark(3, 3) - dark(3, 1917))).toBeLessThan(0.01);
    expect(Math.abs(dark(3, 3) - dark(1077, 3))).toBeLessThan(0.01);
    // from each corner towards the middle it never steps: from one pixel to the next it darkens less than a level
    // (1 / 255 of the way to black), and it fades all the way out
    for (const [x0, y0] of [
      [0.5, 0.5],
      [1079.5, 0.5],
      [0.5, 1919.5],
      [1079.5, 1919.5],
    ] as const) {
      let before = dark(x0, y0);
      for (let i = 1; i <= 600; i += 1) {
        const now = dark(x0 + ((540 - x0) * i) / 600, y0 + ((960 - y0) * i) / 600);
        expect(Math.abs(now - before), `${x0},${y0} step ${i}`).toBeLessThan(1 / 255);
        before = now;
      }
      expect(before).toBe(0);
    }
    for (const [x, y] of [
      [540, 960],
      [540, 3],
      [3, 960],
      [1077, 960],
      [540, 1917],
    ])
      expect(dark(x!, y!), `${x},${y}`).toBe(0);
    const classic = drawFrame({ ...clone(s), art: "classic" }, 30);
    expect(classic.filter(isVignette).length).toBe(0);
    expect(classic.some((p) => "color" in p && p.color === ND.vignette)).toBe(false);
    // by day it is half as dark
    const day = drawFrame(valid(story([drive("road_day", [])])), 30).filter(isVignette) as Extract<Prim, { k: "glow" }>[];
    expect(day.length).toBe(glows.length);
    expect(dark(3, 3, day)).toBeCloseTo(dark(3, 3) / 2, 2);
    day.forEach((p, i) => p.fade.forEach(([o, a], j) => expect([o, a]).toEqual([glows[i]!.fade[j]![0], expect.closeTo(glows[i]!.fade[j]![1] / 2, 2)])));
  });

  it("street lamps are warm emitters in night drive: soft glow rings in small steps, a slim dark head over the lens, poles behind the rails", () => {
    // the glow's rings: inside one another, building up to the peak, the faint outside in the smallest steps
    for (let n = 3; n <= 20; n += 1) {
      const rings = softRings(n);
      expect(rings.length).toBe(n);
      let level = 0;
      let step = 0;
      rings.forEach(([t, a], i) => {
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        if (i > 0) expect(t).toBeLessThan(rings[i - 1]![0]);
        const next = 1 - (1 - level) * (1 - a);
        expect(next - level).toBeGreaterThanOrEqual(step - 1e-9);
        step = next - level;
        level = next;
      });
      expect(level).toBeCloseTo(0.85, 6);
      expect(rings[0]![1]).toBeLessThanOrEqual(0.85 / (n * n) + 1e-9);
    }
    for (const shot of ["road_behind", "driver_view"] as const) {
      const prims = drawFrame(valid(story([drive("highway_night", [{ at: 0.1, shot }])])), 40);
      const first = (c: string) => prims.findIndex((p) => "color" in p && p.color === c);
      const last = (c: string) => prims.findLastIndex((p) => "color" in p && p.color === c);
      // the lens, a warm white bar, under a dark grey head; no flat gold disc of Bright's
      expect(first(ND.lampLens), shot).toBeGreaterThan(-1);
      expect(first(ND.lampHousing), shot).toBeGreaterThan(-1);
      expect(first(ND.lampHead), shot).toBe(-1);
      // every pole is drawn before the rails (so a rail stands in front of its foot), every lens after them; the rail
      // is night drive's slim blue-grey bars, never Bright's flat pale one
      expect(first(ND.railBar), shot).toBeGreaterThan(-1);
      expect(last(ND.lampPole), shot).toBeLessThan(first(ND.railBar));
      expect(first(ND.lampLens), shot).toBeGreaterThan(last(ND.railBar));
      expect(first(ND.rail), shot).toBe(-1);
      // a near lamp's light is soft glows (a true gradient, so no ring edge shows however big it is): amber, gold and
      // warm white round its lens, never a stack of see-through ovals, each fading out to nothing at its edge
      const glows = prims.filter((p): p is Extract<Prim, { k: "glow" }> => p.k === "glow");
      for (const c of [ND.lampGlowOut, ND.lampGlowIn, ND.lampLens]) expect(glows.some((p) => p.color === c), `${shot} ${c}`).toBe(true);
      expect(prims.some((p) => (p.k === "ellipse" || p.k === "circle") && (p.color === ND.lampGlowIn || p.color === ND.lampGlowOut)), shot).toBe(false);
      for (const g of glows) {
        expect(g.fade.length, shot).toBeGreaterThanOrEqual(12);
        expect(g.fade.at(-1)![1], shot).toBe(0);
      }
    }
    // through the car's windows too: lamps glow through the rear window (Face up close) and the side window, each with
    // its thin dark head over its lens
    for (const shot of ["face", "side_window"] as const) {
      for (const fr of [40, 75]) {
        const prims = drawFrame(valid(story([drive("highway_night", [{ at: 0.1, shot }])])), fr);
        expect(prims.some((p) => "color" in p && p.color === ND.lampHousing), `${shot} ${fr}`).toBe(true);
        expect(prims.some((p) => p.k === "glow" && p.color === ND.lampGlowIn), `${shot} ${fr}`).toBe(true);
      }
    }
    // Bright keeps its own lamps
    const bright = drawFrame(valid(story([drive("highway_night", [{ at: 0.1, shot: "road_behind" }])], FORMATS[0], { art: "classic" })), 40);
    expect(bright.some((p) => "color" in p && p.color === ND.lampHead)).toBe(true);
    expect(bright.some((p) => "color" in p && p.color === ND.lampLens)).toBe(false);
  });

  it("night drive's guard rail is two slim bars, no lamp's pole ends in the air, and the needle's light and the mirror's sky are smooth", () => {
    const shotPrims = (shot: ShotId, f: VideoFormat, fr: number, art: "night_drive" | "classic" = "night_drive") => drawFrame(valid(story([drive("highway_night", [{ at: 0.1, shot }])], f, { art })), fr);
    const of = (prims: Prim[], c: string) => prims.filter((p) => "color" in p && p.color === c);
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    // a colour on the way from the lamps' pole colour to the horizon's haze
    const [pole, haze] = [rgb(ND.lampPole), rgb(ND.skyHorizon)];
    const hazy = (c: string) => c !== ND.lampPole && rgb(c).every((v, i) => v >= Math.min(pole[i]!, haze[i]!) - 1 && v <= Math.max(pole[i]!, haze[i]!) + 1);
    for (const f of FORMATS) {
      let glassPoles = 0;
      for (const fr of FRAMES) {
        // the side window: the rail's bars and its thin highlight, never Bright's flat pale slab, and every lamp's pole
        // (the row along the far side and the near one passing) runs down behind the rail
        const side = shotPrims("side_window", f, fr);
        const where = `${f.resolution} frame ${fr}`;
        const rail = colourBox(side, [ND.railBar]);
        expect(rail, where).not.toBeNull();
        expect(of(side, ND.railGlint).length, where).toBeGreaterThan(0);
        expect([...of(side, ND.rail), ...of(side, ND.railLit)], where).toEqual([]);
        for (const p of side) if (p.k === "poly" && p.color === ND.lampPole) expect(primBox(p)!.y1, where).toBeGreaterThan(rail!.y0);
        // behind the car: the far poles fade into the haze in steps, the furthest all but gone
        const behind = shotPrims("road_behind", f, fr);
        const faded = behind.filter((p) => p.k === "poly" && hazy(p.color)).map((p) => (p as { a?: number }).a ?? 1);
        expect(faded.length, where).toBeGreaterThanOrEqual(3);
        faded.forEach((a, i) => i > 0 && expect(a, where).toBeLessThan(faded[i - 1]!));
        expect(faded.at(-1)!, where).toBeLessThan(0.3);
        // the rev needle's light: soft glows only (no stacked discs or bands), fading out to nothing
        const dial = shotPrims("speed_dial", f, fr);
        const needle = [...of(dial, ND.needleGlow1), ...of(dial, ND.needleGlow2)];
        expect(needle.length, where).toBeGreaterThanOrEqual(2);
        for (const p of needle) {
          expect(p.k, where).toBe("glow");
          if (p.k === "glow") expect(p.fade.at(-1)![1], where).toBe(0);
        }
        // the mirror: no flat band of the horizon's colour in the glass (only its last thin step), its sky fades in
        // small steps of colour
        const mirror = shotPrims("mirror", f, fr);
        expect(of(mirror, ND.skyHorizon).filter((p) => (primBox(p)?.y1 ?? 0) - (primBox(p)?.y0 ?? 0) > 3), where).toEqual([]);
        const glassSky = mirror
          .filter((p): p is Extract<Prim, { k: "rect" }> => p.k === "rect")
          .map((p) => p.color)
          .filter((c) => c !== ND.skyHigh && rgb(c).every((v, i) => v >= rgb(ND.skyHigh)[i]! && v <= haze[i]!));
        expect(glassSky.length, where).toBeGreaterThanOrEqual(12);
        glassSky.forEach((c, i) => {
          const prev = rgb(glassSky[i - 1] ?? ND.skyHigh);
          expect(Math.max(...rgb(c).map((v, j) => Math.abs(v - prev[j]!))), where).toBeLessThanOrEqual(4);
        });
        glassPoles += of(mirror, ND.lampPole).length;
      }
      // the lamps in the mirror's glass stand on poles
      expect(glassPoles, f.resolution).toBeGreaterThan(0);
    }
    // Bright keeps its rail, its needle and its mirror
    const bright = shotPrims("side_window", FORMATS[0]!, 40, "classic");
    expect(of(bright, ND.rail).length).toBeGreaterThan(0);
    expect(of(bright, ND.railBar)).toEqual([]);
    expect(of(shotPrims("speed_dial", FORMATS[0]!, 40, "classic"), ND.needleGlow1).every((p) => p.k !== "glow")).toBe(true);
  });

  it("a shot's camera never shows past the shot's 80 px margin, whatever it zooms into", () => {
    for (const f of FORMATS) {
      inFrame(f, () => {
        for (const id of CATALOG.cameras.map((c) => c.id)) {
          for (const focus of [
            [0, 0],
            [F.w, F.h],
            [F.w * 0.5, F.h * 0.4],
          ] as [number, number][]) {
            for (const t of [0, 0.2, 1, 2.9]) {
              const c = shotCamera(id, t, 0, 3, focus, 7, [1], true);
              expect(c.zoom).toBeGreaterThanOrEqual(1);
              const halfW = F.w / (2 * c.zoom) + Math.abs(c.shakeX) + 2;
              const halfH = F.h / (2 * c.zoom) + Math.abs(c.shakeY) + 2;
              expect(c.cx - halfW, `${f.resolution} ${id}`).toBeGreaterThanOrEqual(-80);
              expect(c.cx + halfW).toBeLessThanOrEqual(F.w + 80);
              expect(c.cy - halfH).toBeGreaterThanOrEqual(-80);
              expect(c.cy + halfH).toBeLessThanOrEqual(F.h + 80);
            }
          }
        }
      });
    }
  });
});

// ---- the shots --------------------------------------------------------------------------------------------------

/** The frames of a 6 s scene that fall in a cut from 0.1 s: early (the settle), middle, late. */
const FRAMES = [5, 40, 75, 110, 160];

describe("every shot", () => {
  it("fills the frame and stays under 400 shapes in every road place, size and style, the same every time", () => {
    for (const f of FORMATS) {
      for (const art of ["night_drive", "classic"] as const) {
        for (const set of ROADS) {
          for (const shot of SHOTS) {
            const s = valid(story([drive(set, [{ at: 0.1, shot }])], f, { art }));
            for (const fr of FRAMES) {
              const prims = drawFrame(s, fr);
              const where = `${f.resolution} ${art} ${set} ${shot} frame ${fr}`;
              expect(prims.length, where).toBeLessThanOrEqual(400);
              expect(["fill", "grad"], where).toContain(prims[0]!.k);
              expect(finite(prims, f.width, f.height), where).toEqual([]);
              if (fr === 40) expect(drawFrame(s, fr), where).toEqual(prims);
            }
          }
        }
      }
    }
  }, 20_000); // every road place, now with the sky and the sea (§45.47): slower on CI runners, same checks

  it("takes every camera of the scene (zoomed, swayed, pushed in or shaken) and still fills the frame", () => {
    for (const f of [FORMATS[0]!, FORMATS[4]!, FORMATS[2]!]) {
      for (const camera of CATALOG.cameras.map((c) => c.id)) {
        for (const shot of SHOTS) {
          const s = valid(story([{ ...drive("highway_night", [{ at: 0.1, shot }]), camera }], f));
          for (const fr of [5, 60, 150]) {
            const prims = drawFrame(s, fr);
            const where = `${f.resolution} ${camera} ${shot} frame ${fr}`;
            expect(prims.length, where).toBeLessThanOrEqual(400);
            expect(["fill", "grad"], where).toContain(prims[0]!.k);
            expect(finite(prims, f.width, f.height), where).toEqual([]);
          }
        }
      }
    }
  });

  it("draws within its measured shapes (SHOT_SHAPES) plus a car view for each other car it may show", () => {
    for (const f of FORMATS) {
      for (const set of ["highway_night", "road_night", "rainy_road", "city_street"] as SetId[]) {
        for (const shot of SHOTS) {
          const s = valid(story([drive(set, [{ at: 0.1, shot }])], f));
          const others = 3;
          for (const fr of FRAMES) expect(drawFrame(s, fr).length, `${f.resolution} ${set} ${shot}`).toBeLessThanOrEqual(SHOT_SHAPES[shot] + others * CAR_VIEW_SHAPES);
          const alone = valid(story([{ ...drive(set, [{ at: 0.1, shot }]), props: drive(set, []).props.slice(0, 1), beats: drive(set, []).beats.filter((b) => b.who !== "car3") }], f));
          for (const fr of FRAMES) expect(drawFrame(alone, fr).length, `${f.resolution} ${set} ${shot} alone`).toBeLessThanOrEqual(SHOT_SHAPES[shot]);
        }
      }
    }
  });

  it("shows the driver's face fully in the frame in Face up close and Side window, in every shape", () => {
    for (const f of FORMATS) {
      for (const shot of ["face", "side_window"] as const) {
        const s = valid(story([drive("highway_night", [{ at: 0.1, shot }])], f, { art: "classic" }));
        for (const fr of FRAMES) {
          const hair = colourBox(drawFrame(s, fr), [HAIR]);
          const where = `${f.resolution} ${shot} frame ${fr}`;
          expect(hair, where).not.toBeNull();
          expect(hair!.x0, where).toBeGreaterThanOrEqual(0);
          expect(hair!.y0, where).toBeGreaterThanOrEqual(0);
          expect(hair!.x1, where).toBeLessThanOrEqual(f.width);
          expect(hair!.y1, where).toBeLessThanOrEqual(f.height);
        }
      }
    }
  });

  it("shows a person standing outside up close against their place, without a car's inside", () => {
    const sc: Scene = { ...drive("park", [{ at: 0.1, shot: "face" }]), actors: [{ castId: "c1", x: 0.5, y: 0.78, facing: "right" }], props: [], beats: [{ at: 0.5, dur: 1, who: "c1", do: "wave", face: "happy" }] };
    const prims = drawFrame(valid(story([sc], FORMATS[0]!, { art: "classic" })), 40);
    expect(colourBox(prims, [HAIR])).not.toBeNull();
    expect(prims.some((p) => "color" in p && (p.color === ND.cabinRoof || p.color === ND.seat))).toBe(false);
  });
});

// ---- bubbles and the end card in shots ----------------------------------------------------------------------------

describe("bubbles and the end card in shots", () => {
  const withBubbles = (shot: ShotId, f: Pick<VideoFormat, "width" | "height">): StoryScript => {
    const sc = drive("highway_night", [{ at: 0.1, shot }, { at: 3, shot: "driver_view" }]);
    sc.beats.push({ at: 0.6, dur: 1.4, who: "c1", do: "idle", bubble: "question" }, { at: 2.4, dur: 2, who: "c1", do: "idle", bubble: "exclaim" }, { at: 2.8, dur: 1, who: "c1", do: "idle", bubble: "heart" });
    return valid(story([sc], f, { art: "classic" }));
  };

  it("never show across a cut, and leave out one that would be shorter than 0.4 s", () => {
    for (const f of FORMATS) {
      const s = withBubbles("face", f);
      const bubbles = prepare(s).bubbles;
      for (const b of bubbles) expect(b.at < 3 && b.at + b.span > 3 + 1e-9, `${f.resolution} ${b.kind}`).toBe(false);
      // the heart at 2.8 s would show 0.2 s before the cut at 3 s
      expect(bubbles.map((b) => b.kind)).toEqual(["question", "exclaim"]);
      expect(bubbles[1]!.span).toBeCloseTo(0.6, 9);
    }
  });

  it("sit beside or above the big face in Face up close and Side window, never over it", () => {
    for (const f of FORMATS) {
      for (const shot of ["face", "side_window"] as const) {
        const s = withBubbles(shot, f);
        const k = Math.min(f.width, f.height) / 1080;
        const bubbles = prepare(s).bubbles;
        expect(bubbles.length, `${f.resolution} ${shot}`).toBe(2);
        for (const b of bubbles) {
          // the face (the biggest skin-coloured shape) as an ellipse: the balloon never covers it
          const face = faceBox(drawFrame(s, Math.round((b.at + b.span / 2) * 30)));
          const cx = (face.x0 + face.x1) / 2;
          const cy = (face.y0 + face.y1) / 2;
          const ax = (face.x1 - face.x0) / 2;
          const ay = (face.y1 - face.y0) / 2;
          const dx = b.x * k - cx;
          const dy = b.y * k - cy;
          const along = Math.hypot(dx, dy);
          const edge = 1 / Math.sqrt((dx / along / ax) ** 2 + (dy / along / ay) ** 2);
          expect(along - edge, `${f.resolution} ${shot} ${b.kind}`).toBeGreaterThan(104 * 0.9 * k);
        }
      }
    }
  });

  it("sit at the top middle in the shots without a face", () => {
    for (const f of FORMATS) {
      const sc = drive("highway_night", [{ at: 0.1, shot: "speed_dial" }]);
      sc.beats.push({ at: 1, dur: 1.4, who: "c1", do: "idle", bubble: "question" });
      const s = valid(story([sc], f));
      const [b] = prepare(s).bubbles;
      expect(b).toBeDefined();
      inFrame(s, () => {
        expect(b!.x).toBe(F.w / 2);
        expect(b!.y).toBeCloseTo(F.safe.top + 104 * 1.4, 6);
        expect(b!.hy).toBeCloseTo(F.h * 0.9, 6);
      });
    }
  });

  it("in a square or wide frame the face shot keeps the head below the end card in its seconds", () => {
    for (const f of FORMATS.filter((x) => x.aspect !== "9:16")) {
      const sc = { ...drive("highway_night", [{ at: 0.1, shot: "face" }]), durationSec: 5 };
      sc.beats = sc.beats.filter((b) => b.at < 4.4);
      const s = valid(story([sc], f, { art: "classic", safety: { topicId: "following_distance", citations: [{ publisher: "Highway Code", title: "Rule 126", url: "https://www.gov.uk/guidance/the-highway-code" }] } }));
      const card = prepare(s).cardBottom;
      expect(card, f.resolution).not.toBeNull();
      const k = Math.min(f.width, f.height) / 1080;
      for (const fr of [5 * 30 - 30, 5 * 30 - 2]) {
        const hair = colourBox(drawFrame(s, fr), [HAIR])!;
        expect(hair.y0, `${f.resolution} frame ${fr}`).toBeGreaterThanOrEqual(card! * k - 2);
        expect(hair.y1).toBeLessThanOrEqual(f.height);
      }
    }
  });
});

// ---- a detailed own car in the inside views (CONTRACTS §45.48 section 2.9) -------------------------------------------

const withDetail = (detail?: CarDetail): CarMember => ({ ...ownCar, car: { ...ownCar.car, body: "sports", ...(detail ? { detail } : {}) } });
const detailStory = (shot: Exclude<ShotId, "scene">, detail?: CarDetail, f: Pick<VideoFormat, "width" | "height"> = FORMATS[0]!, art: "night_drive" | "classic" = "classic"): StoryScript =>
  valid(story([drive("highway_night", [{ at: 0.1, shot }])], f, { art, cars: { k1: withDetail(detail) } }));
const countColour = (prims: Prim[], c: string): number => prims.filter((p) => "color" in p && p.color === c).length;

describe("the inside views of a detailed own car", () => {
  const OPEN: CarDetail = { v: 1, roof: { type: "open", hoops: "twin" }, cabin: { rows: 1 } };

  it("an open car has no roof band in Driver's eyes (a slim header instead), a closed one and a classic one keep it", () => {
    for (const art of ["night_drive", "classic"] as const) {
      for (const f of FORMATS) {
        const where = `${art} ${f.resolution}`;
        const open = drawFrame(detailStory("driver_view", OPEN, f, art), 75);
        expect(countColour(open, ND.cabinRoof), where).toBe(0);
        expect(countColour(drawFrame(detailStory("driver_view", { v: 1 }, f, art), 75), ND.cabinRoof), where).toBeGreaterThan(0);
        expect(countColour(drawFrame(detailStory("driver_view", undefined, f, art), 75), ND.cabinRoof), where).toBeGreaterThan(0);
        // the mirror still hangs from the header
        expect(countColour(open, ND.mirrorHousing), where).toBeGreaterThan(0);
      }
    }
  });

  it("one row of seats draws no rear seats in Face up close, two rows draw them", () => {
    const two = countColour(drawFrame(detailStory("face", { v: 1, cabin: { rows: 2 } }), 75), ND.seat);
    const one = countColour(drawFrame(detailStory("face", { v: 1, cabin: { rows: 1 } }), 75), ND.seat);
    expect(two - one).toBe(4);
    expect(one).toBeGreaterThan(0); // the driver's own seat stays
  });

  it("an open car in Face up close has sky all round: no roof frame, its roll hoops behind", () => {
    const closed = drawFrame(detailStory("face", { v: 1 }), 75);
    const open = drawFrame(detailStory("face", OPEN), 75);
    expect(countColour(closed, ND.cabinRoof)).toBeGreaterThan(0);
    expect(countColour(open, ND.cabinRoof)).toBe(0);
    const bar = drawFrame(detailStory("face", { ...OPEN, roof: { type: "open", hoops: "bar" } }), 75);
    const none = drawFrame(detailStory("face", { ...OPEN, roof: { type: "open", hoops: "none" } }), 75);
    expect(open.length - none.length).toBe(2);
    expect(bar.length - none.length).toBe(1);
  });

  it("an open car has no upper frame in the Side window and no rear window frame in the Mirror", () => {
    const sideClosed = drawFrame(detailStory("side_window", { v: 1 }), 75);
    const sideOpen = drawFrame(detailStory("side_window", OPEN), 75);
    expect(sideOpen.length).toBeLessThan(sideClosed.length);
    const mirClosed = drawFrame(detailStory("mirror", { v: 1, cabin: { rows: 2 } }), 75);
    const mirOpen = drawFrame(detailStory("mirror", { v: 1, roof: { type: "open" }, cabin: { rows: 2 } }), 75);
    expect(mirClosed.length - mirOpen.length).toBe(8); // four panes of frame and its four edges
    const mirOne = drawFrame(detailStory("mirror", { v: 1, cabin: { rows: 1 } }), 75);
    expect(countColour(mirClosed, ND.seat) - countColour(mirOne, ND.seat)).toBe(2);
  });

  it("the bonnet follows the nose in Driver's eyes: a stripe rides on it, a flat wheel adds a bar, a dial takes its colour", () => {
    const base = drawFrame(detailStory("driver_view", { v: 1 }), 75);
    const centre = drawFrame(detailStory("driver_view", { v: 1, stripe: { layout: "centre", color: "#ffee00" } }), 75);
    expect(centre.length - base.length).toBe(1);
    expect(countColour(centre, "#ffee00")).toBe(1);
    const twin = drawFrame(detailStory("driver_view", { v: 1, stripe: { layout: "twin", color: "#ffee00" } }), 75);
    expect(twin.length - base.length).toBe(2);
    const flat = drawFrame(detailStory("driver_view", { v: 1, cabin: { wheel: "flat" } }), 75);
    expect(flat.length - base.length).toBe(2);
    // a low wedge nose is a thin sliver, a tall one a deep sliver; wings standing over the bonnet add humps, no prims
    const nose = (noseH: number, cowlH: number) => drawFrame(detailStory("driver_view", { v: 1, profile: { ...PRESET.sports, noseH, cowlH } }), 75);
    const lowNose = nose(30, 40);
    const highNose = nose(70, 80);
    const wings = nose(30, 70);
    expect(lowNose.length).toBe(highNose.length);
    expect(wings.length).toBe(lowNose.length);
    expect(lowNose).not.toEqual(highNose);
    expect(wings).not.toEqual(lowNose);
    const dial = drawFrame(detailStory("speed_dial", { v: 1, cabin: { dial: "#f2c500" } }), 75);
    expect(countColour(dial, "#f2c500")).toBeGreaterThan(0);
    expect(countColour(drawFrame(detailStory("speed_dial", { v: 1 }), 75), "#f2c500")).toBe(0);
  });

  it("every shot of a detailed own car stays under its shape budgets, in every size and both styles, the same every time", () => {
    for (const f of FORMATS) {
      for (const art of ["night_drive", "classic"] as const) {
        for (const shot of SHOTS) {
          const s = detailStory(shot, { v: 1, roof: { type: "open", hoops: "twin" }, stripe: { layout: "twin", color: "#222222" }, cabin: { rows: 1, wheel: "flat", dial: "#f2c500" } }, f, art);
          const where = `${f.resolution} ${art} ${shot}`;
          for (const fr of FRAMES) {
            const prims = drawFrame(s, fr);
            expect(prims.length, where).toBeLessThanOrEqual(400);
            expect(prims.length, where).toBeLessThanOrEqual(SHOT_SHAPES[shot] + 3 * CAR_VIEW_SHAPES + 6);
            expect(finite(prims, f.width, f.height), where).toEqual([]);
          }
          expect(drawFrame(s, 40), where).toEqual(drawFrame(s, 40));
        }
      }
    }
  });

  it("the cabin's colours do not change with a detail (the detail's seat colour only counts without inside photos)", () => {
    const a = drawFrame(detailStory("face", { v: 1, cabin: { rows: 2 } }), 75);
    const b = drawFrame(detailStory("face", undefined), 75);
    expect(a.length).toBe(b.length);
  });
});
