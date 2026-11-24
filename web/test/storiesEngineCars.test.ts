// A car character of the cast (CONTRACTS §45.42): its look's check, its rig in both views, the car moves and the
// editor's preview. The busiest frame it draws is CAR_CAST_SHAPES, which a scene's shape budget counts.
import { describe, expect, it } from "vitest";
import { CAR_CAST_SHAPES, carHasFace, carSide, checkCarLook, DEFAULT_CAR, type CarDraw } from "../src/stories/engine/car.ts";
import { CATALOG } from "../src/stories/engine/catalog.ts";
import { ENGINE_VERSION, previewCar, type CarMove } from "../src/stories/engine/engine.ts";
import { blink } from "../src/stories/engine/face.ts";
import { hash } from "../src/stories/engine/math.ts";
import { Pen } from "../src/stories/engine/pen.ts";
import { drawProp, propState, type DriverInput, type PropState } from "../src/stories/engine/props.ts";
import type { Beat, CarLook, Expression, MovementStyle, Prim, PropAction, SceneProp } from "../src/stories/engine/types.ts";

const CL = CATALOG.carLooks;
const ids = <T extends string>(list: { id: T }[]): T[] => list.map((e) => e.id);
const NO_DRIVER: DriverInput = { braking: 0, steer: 0, rolled: 0 };
const MOVES: CarMove[] = ["idle", "drive", "speed_up", "brake", "turn", "bounce", "honk", "blink", "stall"];
const ALLOWED = new Set(["rect", "circle", "ellipse", "poly", "line", "grad"]);
const MOVERS = new Set<PropAction>(["move", "skid", "spin", "stop", "bump", "speed_up", "stall"]);

/** Looks that use every catalog choice at least once (each list cycled), all with eyes on unless asked. */
function looks(eyes: boolean): CarLook[] {
  const lists = [ids(CL.body), ids(CL.pattern), ids(CL.windows), ids(CL.wheels), ids(CL.frontLights), ids(CL.rearLights), ids(CL.extra), ids(CL.eyes), ids(CL.mouth)];
  const n = Math.max(...lists.map((l) => l.length));
  const out: CarLook[] = [];
  for (let i = 0; i < n; i += 1) {
    const pick = <T>(l: T[]) => l[i % l.length]!;
    const eye = pick(ids(CL.eyes));
    out.push({
      body: pick(ids(CL.body)),
      length: [0.85, 1, 1.15][i % 3]!,
      height: [1.15, 0.85, 1][i % 3]!,
      paint: ["#d8352a", "#2f6fd1", "#f2c230", "#1f1f24"][i % 4]!,
      accent: ["#f4f1ea", "#1c1842", "#47d6a0"][i % 3]!,
      pattern: pick(ids(CL.pattern)),
      windows: pick(ids(CL.windows)),
      wheels: { style: pick(ids(CL.wheels)), rim: "#c9ccd2", size: [0.85, 1, 1.2][i % 3]! },
      lights: { front: pick(ids(CL.frontLights)), rear: pick(ids(CL.rearLights)) },
      extra: pick(ids(CL.extra)),
      face: { eyes: eyes ? (eye === "none" ? "windscreen" : eye) : "none", color: "#1c1842", mouth: pick(ids(CL.mouth)) },
      outline: "#1c1842",
    });
  }
  return out;
}

function problems(prims: Prim[], box: { x0: number; y0: number; x1: number; y1: number } | null): string[] {
  const out: string[] = [];
  for (const [i, p] of prims.entries()) {
    if (!ALLOWED.has(p.k)) out.push(`${i}: ${p.k} is not a car shape`);
    const nums = Object.values(p).flatMap((v) => (typeof v === "number" ? [v] : Array.isArray(v) ? v.flat().filter((x): x is number => typeof x === "number") : []));
    if (nums.some((v) => !Number.isFinite(v))) out.push(`${i}: ${p.k} has a NaN`);
    if (!box) continue;
    let xs: number[] = [];
    let ys: number[] = [];
    if (p.k === "circle") [xs, ys] = [[p.x - p.r, p.x + p.r], [p.y - p.r, p.y + p.r]];
    else if (p.k === "ellipse") [xs, ys] = [[p.x - Math.max(p.rx, p.ry), p.x + Math.max(p.rx, p.ry)], [p.y - Math.max(p.rx, p.ry), p.y + Math.max(p.rx, p.ry)]];
    else if (p.k === "rect") [xs, ys] = [[p.x, p.x + p.w], [p.y, p.y + p.h]];
    else if (p.k === "poly" || p.k === "line") {
      const w = p.k === "line" ? p.w / 2 : 0;
      xs = p.pts.filter((_, j) => j % 2 === 0).flatMap((v) => [v - w, v + w]);
      ys = p.pts.filter((_, j) => j % 2 === 1).flatMap((v) => [v - w, v + w]);
    }
    if (xs.length && (Math.min(...xs) < box.x0 || Math.max(...xs) > box.x1 || Math.min(...ys) < box.y0 || Math.max(...ys) > box.y1)) out.push(`${i}: ${p.k} reaches outside the box`);
  }
  return out;
}

const castCar = (extra: Partial<SceneProp> = {}): SceneProp => ({ propId: "rosso", kind: "car", x: 0.5, y: 0.72, scale: 1, rot: 0, castId: "c2", ...extra });
/** The 1080 × 1920 frame and its 60 px margin. */
const FRAME = { x0: -60, y0: -60, x1: 1140, y1: 1980 };
const draw = (car: CarLook): CarDraw => ({ car, style: "calm", seed: 7 });

/** One car's prims at time t of a single prop action (or none), in a view. */
function carPrims(car: CarLook, view: "side" | "top", act: PropAction | null, t: number, opts: { style?: MovementStyle; night?: boolean; state?: string; face?: Expression; to?: boolean } = {}): Prim[] {
  // the size a car of the cast is usually staged at, so every choice and move stays in the frame
  const prop = castCar({ scale: 0.8, ...(opts.state ? { state: opts.state } : {}) });
  const beats: Beat[] = act ? [{ at: 0.2, dur: 1.6, who: "rosso", do: act, dir: "right", ...(opts.to ? { to: { x: 0.62, y: 0.7 } } : {}), ...(opts.face ? { face: opts.face } : {}) }] : [];
  const d: CarDraw = { car, style: opts.style ?? "bouncy", seed: 11 };
  const st = propState(prop, beats, view, t, { braking: 0, steer: 0, rolled: t * 300 }, d);
  if (!act) st.face = opts.face ?? null;
  const pen = new Pen();
  drawProp(pen, st, view, t, 3, {}, opts.night ?? false, d);
  return pen.out;
}

describe("a car's look", () => {
  it("DEFAULT_CAR is the contract's red hatchback, a real-looking car with no face, and passes the check", () => {
    expect(DEFAULT_CAR).toEqual({
      body: "hatchback",
      length: 1,
      height: 1,
      paint: "#d8352a",
      accent: "#f4f1ea",
      pattern: "plain",
      windows: "clear",
      wheels: { style: "alloy", rim: "#c9ccd2", size: 1 },
      lights: { front: "round", rear: "bar" },
      extra: "none",
      face: { eyes: "none", color: "#1c1842", mouth: "none" },
      outline: "#1c1842",
    });
    expect(carHasFace(DEFAULT_CAR)).toBe(false);
    const errors: string[] = [];
    checkCarLook(DEFAULT_CAR, "cars.c2", (m) => errors.push(m));
    for (const look of [...looks(true), ...looks(false)]) checkCarLook(look, "cars.c2", (m) => errors.push(m));
    expect(errors).toEqual([]);
  });

  it("says what is wrong, one sentence each, with where it is", () => {
    const bad = (change: Record<string, unknown>): string[] => {
      const errors: string[] = [];
      checkCarLook({ ...DEFAULT_CAR, ...change }, "cars.c2", (m) => errors.push(m));
      return errors;
    };
    expect(bad({ body: "limo" })).toEqual(["cars.c2: car.body is \"limo\"; use one of hatchback, sedan, estate, suv, pickup, van, sports, compact."]);
    expect(bad({ paint: "red" })).toEqual(['cars.c2: car.paint must be a colour like "#d8352a".']);
    expect(bad({ length: 1.3 })).toEqual(["cars.c2: car.length is 1.3; use a number from 0.85 to 1.15."]);
    expect(bad({ wheels: { style: "alloy", rim: "#c9ccd2", size: 1.3 } })[0]).toMatch(/^cars\.c2: car\.wheels needs a style \(steel, hubcap, alloy, sport, offroad\)/);
    expect(bad({ lights: { front: "round", rear: "oval" } })[0]).toMatch(/car\.lights needs front/);
    expect(bad({ face: { eyes: "mouth", color: "#1c1842", mouth: "none" } })[0]).toMatch(/car\.face needs eyes \(none, windscreen, headlights\)/);
    const missing: string[] = [];
    checkCarLook(undefined, "cars.c2", (m) => missing.push(m));
    expect(missing).toEqual(["cars.c2: car is missing. Copy the car's saved look into cars."]);
  });

  it("every body has a cabin, windows and two seats inside the windows", () => {
    for (const body of ids(CL.body)) {
      const g = carSide({ ...DEFAULT_CAR, body });
      expect(g.seats, body).toHaveLength(2);
      for (const s of g.seats) {
        expect(s.topY, body).toBeLessThan(s.beltY - 40);
        expect(Math.abs(s.x), body).toBeLessThan(g.hl);
      }
      expect(g.front.every(Number.isFinite), body).toBe(true);
      expect(g.tall, body).toBeGreaterThan(200);
    }
  });
});

describe("the car rig", () => {
  const ACTIONS: (PropAction | null)[] = [null, ...ids(CATALOG.propActions)];

  it(`every choice and every prop action draws with no NaN, in the allowed shapes, within CAR_CAST_SHAPES (${CAR_CAST_SHAPES}) prims`, () => {
    let busiest = 0;
    for (const car of looks(true)) {
      for (const view of ["side", "top"] as const) {
        for (const act of ACTIONS) {
          for (const night of [false, true]) {
            for (const t of [0.25, 0.45, 0.8, 1.2, 1.7]) {
              const prims = carPrims(car, view, act, t, { night, face: "surprised", to: act !== null && MOVERS.has(act) });
              // inside the frame and its margin (a night beam reaches past it, as the plain car's does)
              expect(problems(prims, night ? null : FRAME), `${car.body} ${view} ${act} at ${t}`).toEqual([]);
              busiest = Math.max(busiest, prims.length);
            }
          }
        }
      }
    }
    expect(busiest).toBeLessThanOrEqual(CAR_CAST_SHAPES);
    // the constant is the measured busiest frame, not a guess far above it
    expect(busiest).toBeGreaterThanOrEqual(CAR_CAST_SHAPES - 6);
    expect(CAR_CAST_SHAPES).toBeLessThanOrEqual(64);
  });

  it("draws only rects, circles, ellipses, polygons, lines and gradients, and each plate is one plain light rect", () => {
    const car: CarLook = { ...DEFAULT_CAR, accent: "#47d6a0", face: { eyes: "windscreen", color: "#1c1842", mouth: "grille" } };
    for (const view of ["side", "top"] as const) {
      const prims = carPrims(car, view, null, 0.5, { face: "happy" });
      expect(prims.every((p) => ALLOWED.has(p.k)), view).toBe(true);
      const plates = prims.filter((p) => "color" in p && p.color === "#f4f1ea");
      expect(plates.map((p) => p.k), view).toEqual(["rect", "rect"]);
    }
  });

  it("draws its own paint, and the people inside behind the glass", () => {
    const car: CarLook = { ...DEFAULT_CAR, paint: "#2f6fd1" };
    for (const view of ["side", "top"] as const) {
      const st = propState(castCar(), [], view, 0.5, NO_DRIVER, draw(car));
      const pen = new Pen();
      const seats: unknown[] = [];
      drawProp(pen, st, view, 0.5, 1, { side: (_, s) => seats.push(...s), top: (_, s) => seats.push(...s) }, false, draw(car));
      expect(pen.out.some((p) => "color" in p && p.color === "#2f6fd1"), view).toBe(true);
      expect(seats, view).toHaveLength(2);
    }
  });

  it("with no face it draws no eyes, so every expression looks the same; with eyes each face changes the prims", () => {
    const plain = (face: Expression) => previewCar(DEFAULT_CAR, "calm", face, "idle", 0.5, 300);
    expect(plain("happy")).toEqual(plain("neutral"));
    expect(plain("neutral").some((p) => "color" in p && p.color === "#ffffff" && (p.k === "ellipse" || p.k === "circle"))).toBe(false);
    for (const eyes of ["windscreen", "headlights"] as const) {
      const car: CarLook = { ...DEFAULT_CAR, face: { eyes, color: "#1c1842", mouth: "grille" } };
      const seed = hash(car.paint, car.body, car.wheels.style, car.face.eyes);
      let t = 0.05;
      while (blink(seed, t) > 0) t += 0.05;
      const neutral = previewCar(car, "calm", "neutral", "idle", t, 300);
      expect(neutral.length, eyes).toBeGreaterThan(plain("neutral").length);
      for (const face of ids(CATALOG.expressions).filter((f) => f !== "neutral")) {
        expect(previewCar(car, "calm", face, "idle", t, 300), `${eyes} ${face}`).not.toEqual(neutral);
      }
    }
  });

  it("a grille mouth bends with the face: a smile and a frown differ from the plain grille", () => {
    const car: CarLook = { ...DEFAULT_CAR, face: { eyes: "headlights", color: "#1c1842", mouth: "grille" } };
    const noMouth: CarLook = { ...car, face: { ...car.face, mouth: "none" } };
    const t = 0.05;
    expect(previewCar(car, "calm", "happy", "idle", t, 300)).not.toEqual(previewCar(noMouth, "calm", "happy", "idle", t, 300));
    expect(previewCar(car, "calm", "happy", "idle", t, 300)).not.toEqual(previewCar(car, "calm", "sad", "idle", t, 300));
  });
});

describe("the car moves", () => {
  const st = (beats: Omit<Beat, "who">[], t: number, view: "side" | "top" = "side", style: MovementStyle = "calm"): PropState =>
    propState(castCar(), beats.map((b) => ({ ...b, who: "rosso" })), view, t, NO_DRIVER, { car: DEFAULT_CAR, style, seed: 3 });

  it("speed_up moves to its `to` slowly, then fast (ease-in), with exhaust puffs at the start", () => {
    const beat = { at: 0, dur: 2, do: "speed_up" as const, to: { x: 0.9, y: 0.72 } };
    const at = (t: number) => (st([beat], t).x - 0.5) / 0.4;
    expect(at(0.5)).toBeLessThan(0.1);
    expect(at(1)).toBeCloseTo(0.25, 2);
    expect(st([beat], 1.5).speed).toBeGreaterThan(st([beat], 0.5).speed * 2);
    expect(st([beat], 0.3).puffAge).toBeCloseTo(0.3, 5);
    expect(st([], 0.3).puffAge).toBe(-1);
  });

  it("bounce hops up and settles back with the wheels down", () => {
    const beat = { at: 0, dur: 1, do: "bounce" as const };
    expect(st([beat], 0.27).bounce).toBeGreaterThan(0.95);
    expect(st([beat], 0.8).bounce).toBeLessThan(0);
    expect(st([beat], 1.2).bounce).toBe(0);
    expect(st([beat], 0.27).y).toBe(0.72);
  });

  it("honk sounds for its beat and draws three yellow waves", () => {
    const beat = { at: 0.2, dur: 0.8, do: "honk" as const };
    expect(st([beat], 0.5).honkAge).toBeCloseTo(0.3, 5);
    expect(st([beat], 1.3).honkAge).toBe(-1);
    const waves = (t: number) => carPrims(DEFAULT_CAR, "side", "honk", t).filter((p) => p.k === "line" && p.color === "#ffc94a").length;
    expect(waves(0.5)).toBe(3);
    expect(waves(2.5)).toBe(0);
  });

  it("blink flashes the headlights twice over the beat: on, off, on, then off", () => {
    const beat = { at: 0, dur: 1, do: "blink" as const };
    expect(st([beat], 0.15).blink).toBeGreaterThan(0.9);
    expect(st([beat], 0.4).blink).toBe(0);
    expect(st([beat], 0.65).blink).toBeGreaterThan(0.9);
    expect(st([beat], 1.2).blink).toBe(0);
  });

  it("stall shudders, puffs once and brings the speed to 0; with `to` it stops like stop, only jerkier", () => {
    const move = { at: 0, dur: 3, do: "move" as const, to: { x: 0.95, y: 0.72 } };
    const stall = { at: 1, dur: 0.8, do: "stall" as const };
    expect(st([move, stall], 0.9).speed).toBeGreaterThan(0.05);
    expect(st([move, stall], 1.5).speed).toBe(0);
    expect(st([move, stall], 1.1).rot).not.toBe(0);
    expect(st([move, stall], 1.1).stallAge).toBeCloseTo(0.1, 5);
    const stop = { at: 0, dur: 1, do: "stall" as const, to: { x: 0.8, y: 0.72 } };
    expect(st([stop], 0.5).braking).toBeGreaterThan(0.5);
    expect(st([stop], 1.2).speed).toBe(0);
    expect(st([stop], 1.2).x).toBeCloseTo(0.8, 5);
  });

  it("the newest beat with a face is the car's face", () => {
    const s = st([{ at: 0, dur: 0.5, do: "honk", face: "happy" }, { at: 1, dur: 0.5, do: "bounce", face: "surprised" }, { at: 2, dur: 0.5, do: "blink" }], 2.2);
    expect(s.face).toBe("surprised");
    expect(st([], 1).face).toBeNull();
  });

  it("a heavy car dips its nose half as much again on a stop", () => {
    const stop = { at: 0, dur: 1, do: "stop" as const };
    expect(st([stop], 0.8, "side", "heavy").rot).toBeCloseTo(st([stop], 0.8, "side", "calm").rot * 1.5, 5);
  });

  it("previewCar draws every move inside its box, the same every time", () => {
    const size = 240;
    const box = { x0: -0.12 * size, y0: -0.12 * size, x1: 1.12 * size, y1: 1.12 * size };
    for (const car of [...looks(true), ...looks(false), DEFAULT_CAR]) {
      for (const move of MOVES) {
        for (const t of [0, 0.4, 0.9, 1.3, 1.9, 2.3]) {
          const prims = previewCar(car, "zippy", "happy", move, t, size);
          expect(prims.length, move).toBeGreaterThan(20);
          expect(problems(prims, box), `${car.body} ${move} at ${t}`).toEqual([]);
        }
      }
    }
    expect(previewCar(DEFAULT_CAR, "bouncy", "neutral", "honk", 0.6, 300)).toEqual(previewCar(JSON.parse(JSON.stringify(DEFAULT_CAR)) as CarLook, "bouncy", "neutral", "honk", 0.6, 300));
    expect(previewCar(DEFAULT_CAR, "calm", "neutral", "drive", 1, 300)).not.toEqual(previewCar(DEFAULT_CAR, "calm", "neutral", "idle", 1, 300));
    expect(previewCar(DEFAULT_CAR, "calm", "neutral", "turn", 0.6, 300)).not.toEqual(previewCar(DEFAULT_CAR, "calm", "neutral", "turn", 1.8, 300));
  });
});

describe("a plain car draws as before", () => {
  it("without a CarDraw, and for the old prop actions, a car or truck draws the same prims (the new states stay at rest)", () => {
    for (const kind of ["car", "truck"] as const) {
      for (const view of ["side", "top"] as const) {
        for (const act of ["move", "skid", "spin", "stop", "bump", "tyre_burst", "wobble", "flash"] as PropAction[]) {
          const prop: SceneProp = { propId: "p", kind, x: 0.5, y: 0.7, scale: 1, rot: 10, color: "#3388ff" };
          const beats: Beat[] = [{ at: 0.2, dur: 1, who: "p", do: act, to: { x: 0.6, y: 0.6 }, dir: "left" }];
          const a = propState(prop, beats, view, 0.7, NO_DRIVER);
          expect([a.face, a.honkAge, a.blink, a.bounce, a.stallAge, a.puffAge]).toEqual([null, -1, 0, 0, -1, -1]);
          const b = propState(prop, beats, view, 0.7, NO_DRIVER, null);
          expect(b).toEqual(a);
          const pa = new Pen();
          drawProp(pa, a, view, 0.7, 4, {}, true);
          const pb = new Pen();
          drawProp(pb, b, view, 0.7, 4, {}, true, null);
          expect(pb.out).toEqual(pa.out);
          // a castId without its car (no CarDraw) is still the plain car
          const pc = new Pen();
          drawProp(pc, { ...a, prop: { ...prop, castId: "c2" } }, view, 0.7, 4, {}, true);
          expect(pc.out).toEqual(pa.out);
        }
      }
    }
  });

  it("the new moves show on a plain car too", () => {
    const prop: SceneProp = { propId: "p", kind: "car", x: 0.5, y: 0.7, scale: 1, rot: 0 };
    const quiet = new Pen();
    drawProp(quiet, propState(prop, [], "side", 0.5, NO_DRIVER), "side", 0.5, 1, {}, false);
    const honk = new Pen();
    drawProp(honk, propState(prop, [{ at: 0.2, dur: 1, who: "p", do: "honk" }], "side", 0.5, NO_DRIVER), "side", 0.5, 1, {}, false);
    expect(honk.out.length).toBe(quiet.out.length + 3);
  });

  it("the engine is version 6", () => {
    expect(ENGINE_VERSION).toBe(6);
  });
});
